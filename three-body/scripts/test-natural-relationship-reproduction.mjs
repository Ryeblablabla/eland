import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-natural-relationship-'));

try {
  const entries = {
    simulation: 'src/game/eland/simulation.ts',
    reproduction: 'src/game/eland/application/reproduction-options.ts',
    evidence: 'src/game/eland/domain/relationship-evidence.ts',
    episode: 'src/game/eland/domain/relationship-episode.ts',
    adapter: 'src/game/eland/adapter.ts',
    executor: 'src/game/eland/domain/action-executor.ts',
    physiology: 'src/game/eland/domain/reproduction.ts',
    review: 'src/game/eland/application/simulation/model-review.ts',
    grid: 'src/game/eland/world/grid.ts',
    socialSpace: 'src/game/eland/domain/social-space.ts',
  };
  for (const [name, entry] of Object.entries(entries)) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entry,
      '--bundle',
      '--platform=node',
      '--format=esm',
      `--outfile=${path.join(temporaryDirectory, `${name}.mjs`)}`,
    ], { stdio: 'pipe' });
  }

  const cacheBust = Date.now();
  const { createInitialState } = await import(
    `${pathToFileURL(path.join(temporaryDirectory, 'simulation.mjs')).href}?test=${cacheBust}`
  );
  const { buildReproductionOptions } = await import(
    `${pathToFileURL(path.join(temporaryDirectory, 'reproduction.mjs')).href}?test=${cacheBust}`
  );
  const {
    buildRelationshipCausalBasis,
    canOfferRelationshipProposal,
    hasCultivatedCompanionRelationship,
    hasSourcedReproductiveRelationship,
  } = await import(
    `${pathToFileURL(path.join(temporaryDirectory, 'evidence.mjs')).href}?test=${cacheBust}`
  );
  const { recordRelationshipEpisode } = await import(
    `${pathToFileURL(path.join(temporaryDirectory, 'episode.mjs')).href}?test=${cacheBust}`
  );
  const { toSocietyState } = await import(
    `${pathToFileURL(path.join(temporaryDirectory, 'adapter.mjs')).href}?test=${cacheBust}`
  );

  const { executePrimitiveAction } = await import(
    `${pathToFileURL(path.join(temporaryDirectory, 'executor.mjs')).href}?test=${cacheBust}`
  );
  const { conceptionChance } = await import(
    `${pathToFileURL(path.join(temporaryDirectory, 'physiology.mjs')).href}?test=${cacheBust}`
  );

  const { validateModelDecision } = await import(
    `${pathToFileURL(path.join(temporaryDirectory, 'review.mjs')).href}?test=${cacheBust}`
  );

  const atMonth = 30 * 12;
  const state = createInitialState(20260904, {
    endpoint: { kind: 'months', value: atMonth + 12 },
    chaosIntensity: 0,
  });
  state.clock.elapsedMonths = atMonth;
  const observer = state.people[0];
  const partner = state.people[1];
  assert.ok(observer && partner, 'fixture requires two founders');
  observer.sex = 'female';
  partner.sex = 'male';
  observer.bornAtMonth = atMonth - 25 * 12;
  partner.bornAtMonth = atMonth - 26 * 12;
  partner.position = structuredClone(observer.position);
  observer.body = { health: 30, hydration: 30, nutrition: 30 };
  partner.body = { health: 30, hydration: 30, nutrition: 30 };
  const observerRelation = observer.relations.find((relation) => relation.personId === partner.id);
  assert.ok(observerRelation, 'founders should have a directed relation cache');
  observerRelation.trust = -80;
  observerRelation.bond = -80;
  observerRelation.fear = 95;

  const initialBasis = buildRelationshipCausalBasis(
    state,
    observer,
    partner,
    'reproduce',
    atMonth,
  );
  assert.equal(canOfferRelationshipProposal(state, observer, partner, initialBasis), true,
    'trust/bond/fear values must not determine whether a person may raise a proposal');
  const proposalOptions = buildReproductionOptions(state, observer, [partner], atMonth);
  assert.ok(proposalOptions.some((option) => option.id.startsWith('offer-reproduce:')),
    'temporary low body reserves must not prevent a model-owned reproduction discussion');

  observer.traits = [{
    id: 'succubus', origin: 'spontaneous', inheritedFromPersonIds: [],
    sourceEventIds: ['fixture-succubus-source'],
  }];
  assert.equal(buildReproductionOptions(state, observer, [partner], atMonth)
    .some((option) => option.id.startsWith('reproduce:succubus:')), false,
  'no trait may expose a unilateral reproduction action');

  const sharedFact = {
    id: `e-${atMonth}-relationship-fixture`,
    kind: 'environment',
    atMonth,
    orderInMonth: state.world.past.length,
    cellId: observer.position.cellId,
    change: 'relationship',
    result: '两人在同一场劳动中经历了彼此帮助',
    diff: {
      process: 'fixture-shared-work',
      participantIds: [observer.id, partner.id],
      sourceEventIds: [],
    },
  };
  state.world.past.push(sharedFact);
  const partnerEpisodeCount = partner.relationshipEpisodes?.length ?? 0;
  recordRelationshipEpisode(observer, {
    id: `relationship-episode:${observer.id}:${partner.id}:${atMonth}`,
    otherPersonId: partner.id,
    experiencedAtMonth: atMonth,
    sourceFactIds: [sharedFact.id],
    appraisal: {
      meanings: ['gratitude', 'uncertainty'],
      interpretation: '他在我体力不支时留下来帮我，但我还不知道这是否会持续。',
      unresolvedExpectation: '下一次困难时，他会不会仍然留下？',
      desiredResponse: '找机会继续合作并观察彼此如何履行承诺。',
    },
  });
  assert.equal(partner.relationshipEpisodes?.length ?? 0, partnerEpisodeCount,
    'one observer appraisal must not install a reciprocal feeling on the other person');
  assert.equal(observerRelation.trust, -80,
    'a subjective episode must not directly rewrite the relation score cache');
  const projectedRelation = toSocietyState(state).agents
    .find((agent) => agent.id === observer.id)?.relations
    ?.find((relation) => relation.personId === partner.id);
  assert.deepEqual(projectedRelation?.subjective?.meanings, ['gratitude', 'uncertainty']);
  assert.match(projectedRelation?.subjective?.interpretation ?? '', /不知道这是否会持续/u,
    'players should be able to see the observer\'s sourced asymmetric interpretation');
  assert.throws(() => recordRelationshipEpisode(observer, {
    id: 'unsourced-episode',
    otherPersonId: partner.id,
    experiencedAtMonth: atMonth,
    sourceFactIds: [],
    appraisal: { meanings: ['affection'], interpretation: '没有事件来源的宣称' },
  }), /requires one observer/,
  'an appraisal without a source fact must be rejected');

  const companionBasis = buildRelationshipCausalBasis(
    state,
    observer,
    partner,
    'companion',
    atMonth,
  );
  const reproductionBasis = buildRelationshipCausalBasis(
    state,
    observer,
    partner,
    'reproduce',
    atMonth,
  );
  assert.ok(companionBasis.relationshipKeys.includes(sharedFact.id),
    'a directed episode should surface its verified shared fact in decision provenance');
  assert.equal(hasCultivatedCompanionRelationship(
    state, observer, partner, companionBasis,
  ), true, 'one sourced encounter is meaningful without a score or month-count threshold');
  assert.equal(hasSourcedReproductiveRelationship(
    state, observer, partner, reproductionBasis,
  ), true, 'relationship context should remain sourced without becoming reproductive permission');

  const offerId = `offer-reproduce-fixture:${partner.id}:${observer.id}`;
  const offerFact = {
    id: `e-${atMonth}-offer-fixture`,
    kind: 'action',
    atMonth,
    orderInMonth: state.world.past.length,
    planningTick: 1,
    orderInTick: 0,
    actionTick: 1,
    who: partner.id,
    cause: 'intent',
    action: {
      kind: 'talk',
      speakerMeaning: {
        id: offerId,
        kind: 'offer',
        summary: '是否愿意共同生育后代',
        proposal: {
          kind: 'reproduce', proposerId: partner.id, partnerId: observer.id,
          expiresAtMonth: atMonth + 4,
          basis: buildRelationshipCausalBasis(state, partner, observer, 'reproduce', atMonth),
        },
      },
    },
    fromCellId: 1,
    toCellId: 1,
    fromZ: 1,
    toZ: 1,
    pathSegment: [1],
    status: 'completed',
    result: '提出共同生殖提议',
    diff: {},
  };
  state.world.past.push(offerFact);
  const agreement = {
    id: offerId,
    proposal: offerFact.action.speakerMeaning.proposal,
    proposerId: partner.id,
    responderId: observer.id,
    partyIds: [partner.id, observer.id],
    requiredResponderIds: [observer.id],
    acceptedByPersonIds: [partner.id],
    rejectedByPersonIds: [],
    status: 'proposed',
    proposedAtMonth: atMonth,
    acceptByMonth: atMonth + 4,
    proposalEventId: offerFact.id,
    fulfillmentEventIds: [],
    fulfilledByPersonIds: [],
    coLocatedMonths: 0,
    sourceEventIds: [offerFact.id],
  };
  state.agreements.push(agreement);
  const responseOptions = buildReproductionOptions(state, observer, [partner], atMonth);
  assert.ok(responseOptions.some((option) => option.id === `accept-reproduce:${offerId}`));
  assert.ok(responseOptions.some((option) => option.id === `reject-reproduce:${offerId}`));
  assert.equal(responseOptions.some((option) => option.id.startsWith(`reproduce:${offerId}:`)), false,
    'an unanswered proposal must not become permission to execute');

  agreement.status = 'active';
  agreement.acceptedByPersonIds.push(observer.id);
  agreement.acceptedAtMonth = atMonth;
  agreement.dueAtMonth = atMonth + 3;
  const activeOptions = buildReproductionOptions(state, observer, [partner], atMonth);
  assert.ok(activeOptions.some((option) => option.id === `withdraw-reproduce:${offerId}`),
    'either participant must retain a sourced withdrawal path');
  assert.ok(activeOptions.some((option) => option.id.startsWith(`reproduce:${offerId}:`)),
    'low reserves inform the persons and conception probability, rather than forbidding their choice');
  const withdrawal = validateModelDecision(
    { state, person: observer, options: activeOptions, followUpOptions: [] },
    { kind: 'start', optionId: `withdraw-reproduce:${offerId}`, reason: '本人决定撤回这一次尝试' },
  );
  assert.equal(withdrawal?.kind, 'start',
    'an available fulfillment action must not prevent the model from withdrawing consent');

  const independentAction = {
    id: 'independent-move', summary: '离开眼前的谈话', reason: '本人选择先做其他事情',
    goal: { kind: 'near-person', personId: partner.id },
    nextAction: { kind: 'move', toCellId: partner.position.cellId, toZ: partner.position.z },
    estimatedDuration: 'one-month', sourceFactIds: [],
  };
  const newAttempt = { kind: 'observe', target: { kind: 'person', personId: partner.id } };
  for (const pendingOptions of [responseOptions, activeOptions]) {
    const context = { state, person: observer, options: [...pendingOptions, independentAction], followUpOptions: [] };
    assert.equal(validateModelDecision(context, { kind: 'idle', reason: '本人暂不回应' })?.kind, 'idle',
      'an unanswered request or accepted obligation cannot force the next subjective decision');
    assert.deepEqual(validateModelDecision(context, {
      kind: 'idle', reason: '本人想到另一个实际尝试', executionProbe: newAttempt,
    })?.executionProbe, newAttempt, 'creative attempts must reach their own physical compiler despite pending obligations');
    assert.equal(validateModelDecision(context, {
      kind: 'start', optionId: independentAction.id, reason: independentAction.reason,
    })?.optionId, independentAction.id, 'the person may choose a different available action and face later social consequences');
    const activeIntent = { id: 'own-current-work', ownerId: observer.id, status: 'active' };
    for (const kind of ['suspend', 'abandon']) {
      assert.equal(validateModelDecision({ ...context, activeIntent }, {
        kind, intentId: activeIntent.id, reason: '本人不再继续这项安排',
      })?.kind, kind, 'pending social work must not prevent pausing or abandoning personal work');
    }
  }

  const lowReserveChance = conceptionChance(observer, partner, atMonth);
  assert.ok(lowReserveChance > 0 && lowReserveChance < 0.28);

  const executeAttempt = (world) => executePrimitiveAction(
    world, world.people.find((person) => person.id === observer.id),
    { kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: partner.id }], authorizationRef: offerId },
    atMonth, 100, { cause: 'intent', actionTick: 1 },
  );
  const sparseWorld = structuredClone(state);
  const populatedWorld = structuredClone(state);
  populatedWorld.people.push(...Array.from({ length: 70 }, (_, index) => ({
    ...structuredClone(partner), id: `distant-person-${index}`,
    position: { ...partner.position, cellId: 20 + index },
  })));
  const sparseAttempt = executeAttempt(sparseWorld);
  const populatedAttempt = executeAttempt(populatedWorld);
  assert.equal(sparseAttempt.status, 'completed');
  assert.equal(populatedAttempt.status, 'completed');
  assert.equal(populatedAttempt.diff.chance, sparseAttempt.diff.chance,
    'unrelated people elsewhere in the world must not suppress this pair\'s conception');
  assert.equal(populatedAttempt.diff.conceived, sparseAttempt.diff.conceived);

  const refusedWorld = structuredClone(state);
  refusedWorld.agreements.find((candidate) => candidate.id === offerId).acceptedByPersonIds = [partner.id];
  assert.equal(executeAttempt(refusedWorld).status, 'blocked',
    'population freedom must not invent a second person\'s agreement');

  agreement.status = 'rejected';
  agreement.resolvedAtMonth = atMonth;
  agreement.rejectedByPersonIds = [observer.id];
  assert.equal(canOfferRelationshipProposal(state, partner, observer,
    buildRelationshipCausalBasis(state, partner, observer, 'reproduce', atMonth)), true,
  'a prior response is remembered evidence, not a hidden multi-month lock on asking');

  observer.conditions.push({ id: 'existing-pregnancy', kind: 'pregnancy', stage: 1, sinceMonth: atMonth,
    dueAtMonth: atMonth + 9, sourceEventIds: ['existing-pregnancy-fact'], otherPersonId: partner.id });
  agreement.status = 'active';
  assert.equal(buildReproductionOptions(state, observer, [partner], atMonth)
    .some((option) => option.id.startsWith(`reproduce:${offerId}:`)), false,
  'an existing pregnancy remains a real physical boundary');

  const { cellId, setVoxel } = await import(
    `${pathToFileURL(path.join(temporaryDirectory, 'grid.mjs')).href}?test=${cacheBust}`
  );
  const { positionsCanTouch } = await import(
    `${pathToFileURL(path.join(temporaryDirectory, 'socialSpace.mjs')).href}?test=${cacheBust}`
  );
  const contactState = createInitialState(31, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  contactState.clock.elapsedMonths = 1;
  const [first, second] = contactState.people;
  first.sex = 'female'; second.sex = 'male';
  contactState.people = [first, second];
  first.body = { health: 90, hydration: 90, nutrition: 90 };
  second.body = { health: 90, hydration: 90, nutrition: 90 };
  first.conditions = []; second.conditions = [];
  for (let x = 9; x <= 12; x += 1) for (let y = 9; y <= 11; y += 1) {
    setVoxel(contactState.world.grid, x, y, 2, 1);
    for (let z = 3; z < contactState.world.grid.levels; z += 1) setVoxel(contactState.world.grid, x, y, z, 0);
  }
  first.position = { ...first.position, cellId: cellId(10, 10), z: 3 };
  second.position = { ...second.position, cellId: cellId(11, 10), z: 3 };
  let contactOrder = 0;
  const performContact = (person, action) => {
    const fact = executePrimitiveAction(contactState, person, action, 1, ++contactOrder,
      { cause: 'intent', actionTick: contactOrder });
    contactState.world.past.push(fact);
    assert.equal(fact.status, 'completed', fact.result);
    return fact;
  };
  const proposal = buildReproductionOptions(contactState, first, [second], 1)
    .find((option) => option.id.startsWith('offer-reproduce:'));
  assert.equal(proposal.nextAction.kind, 'talk', 'a reproductive proposal must use language without walking into the listener');
  performContact(first, proposal.nextAction);
  const responses = buildReproductionOptions(contactState, second, [first], 1);
  const acceptance = responses.find((option) => option.id.startsWith('accept-reproduce:'));
  const rejection = responses.find((option) => option.id.startsWith('reject-reproduce:'));
  assert.equal(acceptance?.nextAction.kind, 'talk');
  assert.equal(rejection?.nextAction.kind, 'talk', 'both independent responses use the same language range');
  performContact(second, { ...acceptance.nextAction, delivery: 'call', speakerMeaning: {
    ...acceptance.nextAction.speakerMeaning, summary: '我愿意和你一起尝试生育。',
  } });
  const agreed = contactState.agreements.find((candidate) => candidate.proposal.kind === 'reproduce');
  assert.deepEqual(new Set(agreed.acceptedByPersonIds), new Set([first.id, second.id]));
  const contactOptions = buildReproductionOptions(contactState, first, [second], 1);
  assert.equal(contactOptions.find((option) => option.id.startsWith('withdraw-reproduce:'))?.nextAction.kind, 'talk');
  const attempt = contactOptions.find((option) => option.id.startsWith('reproduce:'));
  assert.equal(attempt?.nextAction.kind, 'act', 'adjacent unobstructed bodies do not need to occupy one exact voxel');
  const attemptResult = performContact(first, attempt.nextAction);
  assert.equal(attemptResult.diff.mutualConsent, true);
  assert.ok(attemptResult.diff.chance > 0, 'this is an actual probabilistic attempt, without forcing conception');
  setVoxel(contactState.world.grid, 11, 10, 3, 1);
  assert.equal(positionsCanTouch(contactState.world.grid, first.position, second.position), false,
    'a solid obstruction at the shared contact height blocks bodily contact');
  setVoxel(contactState.world.grid, 11, 10, 3, 0);
  second.position = { ...first.position, z: first.position.z + 3 };
  assert.equal(positionsCanTouch(contactState.world.grid, first.position, second.position), false,
    'people on separate floors cannot reproduce through vertical separation');

  process.stdout.write('natural relationship and reproduction tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
