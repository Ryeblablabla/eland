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
  observer.position = { ...observer.position, cellId: 1, previousCellId: 1, z: 1, previousZ: 1 };
  partner.position = { ...partner.position, cellId: 1, previousCellId: 1, z: 1, previousZ: 1 };
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
    'low body reserves must block execution even though accept/reject remain subjective choices');

  agreement.status = 'active';
  agreement.acceptedByPersonIds.push(observer.id);
  agreement.acceptedAtMonth = atMonth;
  agreement.dueAtMonth = atMonth + 3;
  const activeOptions = buildReproductionOptions(state, observer, [partner], atMonth);
  assert.ok(activeOptions.some((option) => option.id === `withdraw-reproduce:${offerId}`),
    'either participant must retain a sourced withdrawal path');
  assert.equal(activeOptions.some((option) => option.id.startsWith(`reproduce:${offerId}:`)), false,
    'an active mutual agreement still must not bypass the body execution boundary');

  process.stdout.write('natural relationship and reproduction tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
