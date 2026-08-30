import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-company-affiliation-test-'));
const bundlePath = path.join(temporaryDirectory, 'company-affiliation.mjs');

try {
  const entry = `
    export { buildDecisionContexts, createInitialState, executeActiveIntent, restoreSimulationState, RulePlanner, startIntent } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { buildSocialOptions } from ${JSON.stringify(path.resolve('src/game/eland/application/social-options.ts'))};
    export { deriveNeedAgenda } from ${JSON.stringify(path.resolve('src/game/eland/application/cognition/need-agenda.ts'))};
    export { compileAgreementContinuations } from ${JSON.stringify(path.resolve('src/game/eland/application/agreement-continuation.ts'))};
    export { advanceAgreementLifecycle } from ${JSON.stringify(path.resolve('src/game/eland/domain/agreement.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export { appendCommittedEvents } from ${JSON.stringify(path.resolve('src/game/eland/domain/history.ts'))};
    export { cellX, cellY, cellsInRadius, findStandingPath, standingPositions } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=company-affiliation-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    advanceAgreementLifecycle,
    appendCommittedEvents,
    buildSocialOptions,
    buildDecisionContexts,
    cellX,
    cellY,
    cellsInRadius,
    compileAgreementContinuations,
    createInitialState,
    deriveNeedAgenda,
    executeActiveIntent,
    executePrimitiveAction,
    findStandingPath,
    restoreSimulationState,
    RulePlanner,
    startIntent,
    standingPositions,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const atMonth = 24;

  function addPairExperience(state, first, second, id, month = atMonth - 1) {
    const event = {
      id, kind: 'environment', atMonth: month, orderInMonth: 0,
      cellId: first.position.cellId, change: 'relationship',
      result: '双方完成了一次可回放的共同活动',
      diff: {
        process: 'shared-action-ticks', participantIds: [first.id, second.id],
        excludedPairKeys: [], sourceEventIds: [], trustDelta: 1, bondDelta: 1,
      },
    };
    appendCommittedEvents(state, [event]);
    for (const [owner, other] of [[first, second], [second, first]]) {
      const directed = owner.relations.find((candidate) => candidate.personId === other.id);
      directed.sourceEventIds = [...new Set([...directed.sourceEventIds, id])];
    }
    return event;
  }

  function preparePair(seed, { substantive = true } = {}) {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 48 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = atMonth;
    const [requester, helper] = state.people;
    assert.ok(requester && helper, 'fixture requires two living people');
    helper.position = structuredClone(requester.position);
    requester.bornAtMonth = atMonth - 25 * 12;
    helper.bornAtMonth = atMonth - 25 * 12;
    const relation = requester.relations.find((candidate) => candidate.personId === helper.id);
    const reciprocal = helper.relations.find((candidate) => candidate.personId === requester.id);
    assert.ok(relation && reciprocal, 'fixture requires reciprocal relationship caches');
    Object.assign(relation, { trust: 1, bond: 1, fear: 0, sourceEventIds: ['e-0-environment-founding-0'] });
    Object.assign(reciprocal, { trust: 1, bond: 1, fear: 0, sourceEventIds: ['e-0-environment-founding-0'] });
    const relationshipEvent = substantive
      ? addPairExperience(state, requester, helper, `test-pair-experience-${seed}`)
      : undefined;
    return { state, requester, helper, relation, reciprocal, relationshipEvent };
  }

  function commitAction(state, person, action, orderInMonth, intentId) {
    const fact = executePrimitiveAction(state, person, action, atMonth, orderInMonth, {
      ...(intentId ? { intentId } : {}),
      cause: 'intent',
      actionTick: orderInMonth + 1,
    });
    state.world.past.push(fact);
    return fact;
  }

  function requestCompany(state, requester, helper) {
    const option = buildSocialOptions(state, requester, [helper], atMonth)
      .find((candidate) => candidate.id.startsWith('request-company:'));
    assert.ok(option, 'a co-located relationship with replayable evidence should expose a company request');
    assert.equal(option.nextAction.kind, 'communicate');
    assert.equal(option.nextAction.content.kind, 'request');
    assert.equal(option.nextAction.content.proposal?.kind, 'assist');
    assert.equal(option.nextAction.content.proposal?.need, 'company');
    assert.deepEqual(option.sourceFactIds, [`test-pair-experience-${state.seed}`]);
    const fact = commitAction(state, requester, option.nextAction, 0);
    assert.equal(fact.status, 'completed');
    const agreement = state.agreements.find((candidate) => candidate.proposalEventId === fact.id);
    assert.equal(agreement?.status, 'proposed');
    return agreement;
  }

  function acceptCompany(state, requester, helper, agreement) {
    const responses = buildSocialOptions(state, helper, [requester], atMonth);
    const accept = responses.find((candidate) => candidate.id === `accept-assist:${agreement.id}`);
    const reject = responses.find((candidate) => candidate.id === `reject-assist:${agreement.id}`);
    assert.ok(accept && reject, 'the perceived company request must remain explicitly acceptable or rejectable');
    assert.deepEqual(accept.sourceFactIds, [agreement.proposalEventId]);
    const fact = commitAction(state, helper, accept.nextAction, 1);
    assert.equal(fact.status, 'completed');
    assert.equal(agreement.status, 'active');
    return fact;
  }

  // Belonging is derived from a visible relationship opportunity even before
  // any social option exists.
  const agendaFixture = preparePair(26082131);
  const agendaContext = {
    state: agendaFixture.state,
    person: agendaFixture.requester,
    visibleCells: [agendaFixture.requester.position.cellId],
    visiblePeople: [agendaFixture.helper],
    visibleDrops: [], visibleAnimals: [], options: [], followUpOptions: [],
  };
  const belonging = deriveNeedAgenda(agendaContext, atMonth)
    .find((need) => need.kind === 'belonging');
  assert.ok(belonging, 'belonging must not be reverse-gated by a pre-existing social option');
  assert.ok(belonging.sourceFactIds.includes('e-0-environment-founding-0'));

  const foundingOnlyFixture = preparePair(26082138, { substantive: false });
  assert.equal(buildSocialOptions(
    foundingOnlyFixture.state,
    foundingOnlyFixture.requester,
    [foundingOnlyFixture.helper],
    atMonth,
  ).some((option) => option.id.startsWith('request-company:')), false,
  '共同抵达只表示相识，不能单独安装正式陪伴请求');

  // Zero-to-one does not wait for an accidental five-tick joint activity. A
  // locally present stranger can be asked once, while a dangling id is never
  // advertised as evidence and the higher relationship gates stay closed.
  const zeroSourceState = structuredClone(agendaFixture.state);
  const zeroRequester = zeroSourceState.people.find((person) => person.id === agendaFixture.requester.id);
  const zeroHelper = zeroSourceState.people.find((person) => person.id === agendaFixture.helper.id);
  zeroSourceState.people = [zeroRequester, zeroHelper];
  zeroRequester.sex = 'female';
  zeroHelper.sex = 'male';
  const zeroRelation = zeroRequester.relations.find((relation) => relation.personId === zeroHelper.id);
  const zeroReciprocal = zeroHelper.relations.find((relation) => relation.personId === zeroRequester.id);
  Object.assign(zeroRelation, { trust: 0, bond: 0, fear: 0, sourceEventIds: ['event-that-does-not-exist'] });
  Object.assign(zeroReciprocal, { trust: 0, bond: 0, fear: 0, sourceEventIds: [] });
  const zeroContext = {
    ...agendaContext,
    state: zeroSourceState,
    person: zeroRequester,
    visiblePeople: [zeroHelper],
  };
  const zeroBelonging = deriveNeedAgenda(zeroContext, atMonth).find((need) => need.kind === 'belonging');
  assert.ok(zeroBelonging, 'current local perception should create a zero-to-one affiliation opportunity');
  assert.deepEqual(zeroBelonging.sourceFactIds, [], 'current perception must not turn a dangling id into historical evidence');
  const zeroCompany = buildSocialOptions(zeroSourceState, zeroRequester, [zeroHelper], atMonth)
    .find((option) => option.id.startsWith('request-company:'));
  assert.equal(zeroCompany, undefined,
    'mere co-location without replayable relationship evidence must not install a formal company request');
  const zeroDecision = buildDecisionContexts(zeroSourceState, atMonth)
    .find((context) => context.person.id === zeroRequester.id);
  assert.equal(zeroDecision?.options.some((option) => option.id.startsWith('request-company:')), false);
  assert.equal(zeroDecision?.options.some((option) => option.id.startsWith('offer-companion:')), false,
    'zero-to-one company must not bypass the companion threshold');
  assert.equal(zeroDecision?.options.some((option) => option.id.startsWith('offer-reproduce:')), false,
    'zero-to-one company must not bypass the reproductive relationship threshold');

  // Bounded local attention remains fair over time. State insertion order is
  // founders-first, so a fixed slice would permanently hide later peers.
  const attentionFixture = preparePair(26082136);
  const attentionRequester = attentionFixture.requester;
  const attentionOthers = attentionFixture.state.people.filter((candidate) => candidate.id !== attentionRequester.id);
  for (const other of attentionOthers) {
    other.position = structuredClone(attentionRequester.position);
    const outward = attentionRequester.relations.find((relation) => relation.personId === other.id);
    const inward = other.relations.find((relation) => relation.personId === attentionRequester.id);
    assert.ok(outward && inward, 'fixture requires reciprocal relation caches for every visible person');
    const evidenceId = `test-attention-experience-${other.id}`;
    Object.assign(outward, { trust: 1, bond: 1, fear: 0, sourceEventIds: ['e-0-environment-founding-0'] });
    Object.assign(inward, { trust: 1, bond: 1, fear: 0, sourceEventIds: ['e-0-environment-founding-0'] });
    addPairExperience(attentionFixture.state, attentionRequester, other, evidenceId);
  }
  const attendedIds = new Set();
  for (let month = atMonth; month < atMonth + attentionOthers.length; month += 1) {
    const companyTargets = buildSocialOptions(attentionFixture.state, attentionRequester, attentionOthers, month)
      .filter((option) => option.id.startsWith('request-company:'))
      .flatMap((option) => option.target?.kind === 'person' ? [option.target.personId] : []);
    assert.ok(companyTargets.length <= 3, 'one month must preserve the bounded local social-attention limit');
    companyTargets.forEach((personId) => attendedIds.add(personId));
  }
  assert.deepEqual([...attendedIds].sort(), attentionOthers.map((person) => person.id).sort(),
    'rotating attention must eventually expose every continuously visible local person instead of only the first three births');

  const initialJointEvidence = {
    id: 'e-24-environment-relationship-zero-pair',
    kind: 'environment', atMonth, orderInMonth: 0,
    cellId: zeroRequester.position.cellId, change: 'relationship',
    result: '双方完成了一次真实共同活动',
    diff: {
      process: 'shared-action-ticks',
      participantIds: [zeroRequester.id, zeroHelper.id],
      sourceEventIds: [], trustDelta: 1, bondDelta: 1,
    },
  };
  zeroSourceState.world.past.push(initialJointEvidence);
  Object.assign(zeroRelation, { trust: 1, bond: 1, sourceEventIds: [initialJointEvidence.id] });
  Object.assign(zeroReciprocal, { trust: 1, bond: 1, sourceEventIds: [initialJointEvidence.id] });
  const sourcedZeroCompany = buildSocialOptions(zeroSourceState, zeroRequester, [zeroHelper], atMonth)
    .find((option) => option.id.startsWith('request-company:'));
  assert.ok(sourcedZeroCompany, 'a replayable shared relationship event may expose a company request');
  const firstZeroRequest = commitAction(zeroSourceState, zeroRequester, sourcedZeroCompany.nextAction, 0);
  const zeroAgreement = zeroSourceState.agreements.find((agreement) => agreement.proposalEventId === firstZeroRequest.id);
  const zeroReject = buildSocialOptions(zeroSourceState, zeroHelper, [zeroRequester], atMonth)
    .find((option) => option.id === `reject-assist:${zeroAgreement.id}`);
  assert.ok(zeroReject, 'the first zero-relation request remains rejectable');
  commitAction(zeroSourceState, zeroHelper, zeroReject.nextAction, 1);
  assert.equal(zeroAgreement.status, 'rejected');
  zeroSourceState.clock.elapsedMonths = atMonth + 5;
  assert.equal(buildSocialOptions(zeroSourceState, zeroRequester, [zeroHelper], atMonth + 5)
    .some((option) => option.id.startsWith('request-company:')), false,
  'a rejected request must not be repeated inside the bounded reoffer interval');
  zeroSourceState.clock.elapsedMonths = atMonth + 7;
  assert.equal(buildSocialOptions(zeroSourceState, zeroRequester, [zeroHelper], atMonth + 7)
    .some((option) => option.id.startsWith('request-company:')), false,
  'cooldown alone must not turn the same rejected basis into a new request');
  const newJointEvidence = {
    id: 'e-31-environment-relationship-zero-pair',
    kind: 'environment', atMonth: atMonth + 7, orderInMonth: 0,
    cellId: zeroRequester.position.cellId, change: 'relationship',
    result: '双方后来完成了新的真实共同活动',
    diff: {
      process: 'shared-action-ticks',
      participantIds: [zeroRequester.id, zeroHelper.id],
      sourceEventIds: [], trustDelta: 1, bondDelta: 1,
    },
  };
  zeroSourceState.world.past.push(newJointEvidence);
  Object.assign(zeroRelation, { trust: 1, bond: 1, sourceEventIds: [newJointEvidence.id] });
  Object.assign(zeroReciprocal, { trust: 1, bond: 1, sourceEventIds: [newJointEvidence.id] });
  assert.ok(buildSocialOptions(zeroSourceState, zeroRequester, [zeroHelper], atMonth + 7)
    .some((option) => option.id.startsWith('request-company:')),
  'a later replayable joint experience may reopen the request after cooldown');

  // A request cannot be answered by globally tracking its sender. Once the
  // requester is not locally perceived, neither accept nor reject chases them.
  const responseFixture = preparePair(26082132);
  const proposed = requestCompany(responseFixture.state, responseFixture.requester, responseFixture.helper);
  const hiddenResponses = buildSocialOptions(responseFixture.state, responseFixture.helper, [], atMonth)
    .filter((option) => option.id.endsWith(`assist:${proposed.id}`));
  assert.equal(hiddenResponses.length, 0, 'company responses must wait for local perception instead of following a global person position');

  // Accepting company installs a real, agreement-bound attend action. The
  // ActionFact—not co-location by itself—fulfils the agreement and closes the
  // intent without a synthetic blocked result.
  acceptCompany(responseFixture.state, responseFixture.requester, responseFixture.helper, proposed);
  const continuation = compileAgreementContinuations(responseFixture.state, proposed.id, atMonth)[0];
  assert.ok(continuation, 'an accepted co-located company request needs a continuation');
  assert.deepEqual(continuation.goal, { kind: 'agreement-fulfilled', agreementId: proposed.id });
  assert.deepEqual(continuation.nextAction, {
    kind: 'attend', target: { kind: 'person', personId: responseFixture.requester.id },
  });
  const intent = {
    id: 'intent-company-affiliation-test',
    ownerId: responseFixture.helper.id,
    summary: continuation.summary,
    domain: 'social',
    goal: structuredClone(continuation.goal),
    nextAction: structuredClone(continuation.nextAction),
    target: structuredClone(continuation.target),
    status: 'active',
    createdAtMonth: atMonth,
    lastProgressAtMonth: atMonth,
    progress: 0.2,
    sourceDecisionEventId: 'decision-company-affiliation-test',
    agreementId: proposed.id,
    sourceFactIds: [...continuation.sourceFactIds],
    actionEventIds: [],
    replanCount: 0,
  };
  responseFixture.state.intents.push(intent);
  responseFixture.helper.activeIntentId = intent.id;
  const fulfillment = executeActiveIntent(
    responseFixture.state,
    responseFixture.helper,
    atMonth,
    2,
    3,
  );
  assert.equal(fulfillment?.kind, 'action');
  assert.equal(fulfillment?.status, 'completed');
  assert.equal(fulfillment?.action.kind, 'attend');
  assert.equal(fulfillment?.intentId, intent.id);
  assert.equal(proposed.status, 'fulfilled');
  assert.ok(proposed.fulfillmentEventIds.includes(fulfillment.id));
  assert.equal(intent.status, 'completed');
  assert.equal(responseFixture.helper.activeIntentId, undefined);

  // Separation never compiles a live-person pursuit for a company promise.
  const separatedFixture = preparePair(26082133);
  const separatedAgreement = requestCompany(separatedFixture.state, separatedFixture.requester, separatedFixture.helper);
  acceptCompany(separatedFixture.state, separatedFixture.requester, separatedFixture.helper, separatedAgreement);
  const remotePosition = separatedFixture.state.people[2]?.position;
  assert.ok(remotePosition, 'fixture requires a distinct standing position');
  separatedFixture.helper.position = structuredClone(remotePosition);
  assert.equal(compileAgreementContinuations(separatedFixture.state, separatedAgreement.id, atMonth).length, 0,
    'company continuation must not compile movement toward a live person after separation');
  assert.equal(buildSocialOptions(separatedFixture.state, separatedFixture.helper, [], atMonth)
    .some((option) => option.id === `fulfill-assist:${separatedAgreement.id}`), false);

  // A persistent companion remains an explicit, local, non-forced relation:
  // either participant can end it face-to-face, while its existence closes
  // the unmet-affiliation pressure.
  const companionFixture = preparePair(26082135);
  Object.assign(companionFixture.relation, { trust: 30, bond: 30, fear: 0 });
  Object.assign(companionFixture.reciprocal, { trust: 30, bond: 30, fear: 0 });
  const companionAgreement = {
    id: 'test-active-companion',
    proposal: {
      kind: 'companion', proposerId: companionFixture.requester.id, partnerId: companionFixture.helper.id,
      expiresAtMonth: atMonth + 4,
      sharedLivingAnchor: {
        version: 'shared-living-anchor-v1',
        cellId: companionFixture.requester.position.cellId,
        z: companionFixture.requester.position.z,
        radius: 2,
      },
    },
    proposerId: companionFixture.requester.id,
    responderId: companionFixture.helper.id,
    partyIds: [companionFixture.requester.id, companionFixture.helper.id],
    requiredResponderIds: [companionFixture.helper.id],
    acceptedByPersonIds: [companionFixture.requester.id, companionFixture.helper.id],
    rejectedByPersonIds: [], status: 'active', proposedAtMonth: atMonth - 14,
    acceptByMonth: atMonth - 10, acceptedAtMonth: atMonth - 13, dueAtMonth: atMonth + 10,
    proposalEventId: 'e-0-environment-founding-0', fulfillmentEventIds: [],
    fulfilledByPersonIds: [], coLocatedMonths: 12, companionEstablishedAtMonth: atMonth - 1,
    lastCompanionCoLocatedAtMonth: atMonth - 1,
    lastCompanionRelationshipAtCoLocatedMonth: 12,
    sourceEventIds: ['e-0-environment-founding-0'],
  };
  companionFixture.state.agreements.push(companionAgreement);
  const companionContext = {
    state: companionFixture.state, person: companionFixture.requester,
    visibleCells: [companionFixture.requester.position.cellId],
    visiblePeople: [companionFixture.helper], visibleDrops: [], visibleAnimals: [],
    options: [], followUpOptions: [],
  };
  assert.equal(deriveNeedAgenda(companionContext, atMonth).some((need) => need.kind === 'belonging'), false,
    'the already paired companion alone should close this pair-specific affiliation gap');
  const companionWithdrawal = buildSocialOptions(companionFixture.state, companionFixture.requester, [companionFixture.helper], atMonth)
    .find((option) => option.id.startsWith('withdraw-companion:'));
  assert.ok(companionWithdrawal, 'an active companion must expose a face-to-face revoke affordance');
  const quietCompanionChoice = new RulePlanner().decideAt({ ...companionContext, options: [companionWithdrawal] }, {
    atMonth, planningTick: 1,
  });
  assert.equal(quietCompanionChoice.kind, 'idle',
    'the standing right to leave must not manufacture its own pressure and automatically dissolve every companion relation');

  // An established companion who has remained outside the fixed living area
  // until the domain maintenance deadline gets a sourced commitment need. The
  // resulting option targets the agreement's voxel anchor, not the partner,
  // and a conscientious person can actually choose it through RulePlanner.
  const returnState = structuredClone(companionFixture.state);
  const returnPerson = returnState.people.find((person) => person.id === companionFixture.requester.id);
  const returnPartner = returnState.people.find((person) => person.id === companionFixture.helper.id);
  const returnAgreement = returnState.agreements.find((agreement) => agreement.id === companionAgreement.id);
  assert.ok(returnPerson && returnPartner && returnAgreement, 'return fixture requires both parties and their agreement');
  const returnAnchor = returnAgreement.proposal.sharedLivingAnchor;
  assert.ok(returnAnchor, 'established companion fixture requires a fixed living anchor');
  const livingCells = new Set(cellsInRadius(returnAnchor.cellId, returnAnchor.radius));
  const awayPosition = cellsInRadius(returnAnchor.cellId, returnAnchor.radius + 4)
    .filter((cellId) => !livingCells.has(cellId))
    .flatMap((cellId) => standingPositions(returnState.world.grid, cellId))
    .find((position) => Math.abs(position.z - returnAnchor.z) <= 1
      && findStandingPath(returnState.world.grid, returnPerson.position, position).length > 0);
  assert.ok(awayPosition, 'fixture requires a reachable position outside the shared living area');
  returnPerson.position = { ...returnPerson.position, ...awayPosition };
  returnAgreement.lastCompanionCoLocatedAtMonth = atMonth - 3;
  Object.assign(returnPerson.body, { health: 100, hydration: 100, nutrition: 100 });
  returnPerson.personality.baseline.conscientiousness = 90;
  const returnOptions = buildSocialOptions(returnState, returnPerson, [], atMonth);
  const returnOption = returnOptions.find((option) => option.id === `return-shared-living:${returnAgreement.id}:${returnPerson.id}`);
  assert.ok(returnOption, 'a domain-due established commitment must expose a return option without seeing the partner');
  assert.equal(returnOption.target?.kind, 'voxel', 'return must target the fixed living area rather than a person');
  assert.equal(returnOption.goal.kind, 'at-cell');
  assert.equal(returnOption.nextAction.kind, 'move');
  assert.equal(returnOption.nextAction.toCellId, returnOption.goal.cellId);
  assert.equal(cellX(returnOption.nextAction.toCellId), returnOption.target.position.x);
  assert.equal(cellY(returnOption.nextAction.toCellId), returnOption.target.position.y);
  const returnContext = {
    state: returnState, person: returnPerson,
    visibleCells: [returnPerson.position.cellId], visiblePeople: [],
    visibleDrops: [], visibleAnimals: [], options: [returnOption], followUpOptions: [],
  };
  const returnCommitment = deriveNeedAgenda(returnContext, atMonth)
    .find((need) => need.kind === 'commitment');
  assert.ok(returnCommitment, 'domain-due shared living maintenance must become a commitment need');
  assert.ok(returnCommitment.sourceFactIds.includes('e-0-environment-founding-0'),
    'the maintenance need must retain the companion agreement source');
  const returnChoice = new RulePlanner().decideAt(returnContext, { atMonth, planningTick: 2 });
  assert.equal(returnChoice.kind, 'start');
  assert.equal(returnChoice.optionId, returnOption.id,
    'a conscientious person should choose the sourced fixed-anchor return when maintenance is due');
  const returnIntent = startIntent(
    returnState,
    returnPerson,
    returnContext,
    returnChoice.optionId,
    undefined,
    'decision-return-shared-living',
    atMonth,
  );
  assert.equal(returnIntent?.agreementId, returnAgreement.id,
    'a fulfillment intent must bind its authoritative agreement when it is created');
  const restoredReturnState = restoreSimulationState(returnState);
  assert.equal(
    restoredReturnState.intents.find((intent) => intent.id === returnIntent?.id)?.agreementId,
    returnAgreement.id,
    'checkpoint adoption must not change the agreement identity of a current fulfillment intent',
  );
  const multiResponseState = structuredClone(returnState);
  const multiResponder = multiResponseState.people.find((person) => person.id === returnPartner.id);
  assert.ok(multiResponder, 'multi-response fixture requires the later responder');
  delete multiResponder.activeIntentId;
  const multiProposalEventId = 'test-multi-response-proposal';
  const multiAgreementId = 'test-multi-response-agreement';
  multiResponseState.agreements.push({
    id: multiAgreementId,
    proposal: {
      kind: 'membership', proposerId: returnPerson.id, partnerId: multiResponder.id,
      collectiveId: 'collective:test-multi-response', candidateId: multiResponder.id,
      requiredApproverIds: [returnPerson.id, multiResponder.id], expiresAtMonth: atMonth + 3,
    },
    proposerId: returnPerson.id,
    responderId: multiResponder.id,
    partyIds: [returnPerson.id, multiResponder.id],
    requiredResponderIds: [returnPerson.id, multiResponder.id],
    acceptedByPersonIds: [returnPerson.id], rejectedByPersonIds: [], status: 'proposed',
    proposedAtMonth: atMonth - 1, acceptByMonth: atMonth + 3, dueAtMonth: atMonth + 4,
    proposalEventId: multiProposalEventId,
    responseEventId: 'test-earlier-responder-acceptance',
    fulfillmentEventIds: [], fulfilledByPersonIds: [], sourceEventIds: [
      multiProposalEventId,
      'test-earlier-responder-acceptance',
    ],
  });
  const laterRequiredOption = {
    id: `accept-membership:${multiAgreementId}`,
    summary: '回应多人加入提议', reason: '本人仍是尚未回应的必要参与者',
    goal: { kind: 'representation-made', representationId: `accept:${multiAgreementId}:${multiResponder.id}` },
    nextAction: {
      kind: 'communicate',
      content: { id: `accept:${multiAgreementId}:${multiResponder.id}`, kind: 'accept', referenceId: multiAgreementId },
      audience: [returnPerson.id], channel: 'voice',
    },
    target: { kind: 'person', personId: returnPerson.id },
    estimatedDuration: 'one-month', estimatedMonths: 1,
    risks: [], domain: 'social', sourceFactIds: [multiProposalEventId],
  };
  const laterRequiredContext = {
    state: multiResponseState, person: multiResponder,
    visibleCells: [multiResponder.position.cellId], visiblePeople: [returnPerson],
    visibleDrops: [], visibleAnimals: [], options: [laterRequiredOption], followUpOptions: [],
  };
  const laterRequiredIntent = startIntent(
    multiResponseState,
    multiResponder,
    laterRequiredContext,
    laterRequiredOption.id,
    undefined,
    'decision-later-required-response',
    atMonth,
  );
  assert.equal(laterRequiredIntent?.agreementId, multiAgreementId,
    'a later required responder must bind the proposed agreement even after another response exists');
  delete multiResponder.activeIntentId;
  const unrelatedOption = {
    ...laterRequiredOption,
    id: 'collect:unrelated-option-with-proposal-evidence',
    summary: '执行与协议无关的普通行动',
    nextAction: { kind: 'move', toCellId: multiResponder.position.cellId, toZ: multiResponder.position.z },
    sourceFactIds: [returnAgreement.proposalEventId, returnAgreement.responseEventId],
  };
  const unrelatedIntent = startIntent(
    multiResponseState,
    multiResponder,
    { ...laterRequiredContext, options: [unrelatedOption] },
    unrelatedOption.id,
    undefined,
    'decision-unrelated-proposal-evidence',
    atMonth,
  );
  assert.equal(unrelatedIntent?.agreementId, undefined,
    'an ordinary option must not bind an agreement merely because it cites the proposal fact');
  assert.ok(unrelatedIntent, 'ordinary intent fixture must be created');
  multiResponseState.world.past.push({
    id: unrelatedIntent.sourceDecisionEventId,
    kind: 'decision',
    atMonth: unrelatedIntent.createdAtMonth,
    orderInMonth: multiResponseState.world.past.filter((event) => event.atMonth === atMonth).length + 1,
    planningTick: 2,
    orderInTick: 0,
    cellId: multiResponder.position.cellId,
    who: multiResponder.id,
    decision: { kind: 'start', optionId: unrelatedOption.id, reason: '测试普通社会意图的恢复来源' },
    intentId: unrelatedIntent.id,
    usedModel: false,
    domain: unrelatedIntent.domain,
    result: '测试普通社会意图的恢复来源',
  });
  delete multiResponseState.world.historyCursor;
  assert.equal(
    restoreSimulationState(multiResponseState).intents
      .find((intent) => intent.id === unrelatedIntent.id)?.agreementId,
    undefined,
    'checkpoint adoption must not rewrite an active ordinary intent as agreement fulfillment',
  );
  unrelatedIntent.status = 'completed';
  delete multiResponder.activeIntentId;
  const restoredCompletedOrdinaryState = restoreSimulationState(multiResponseState);
  assert.equal(
    restoredCompletedOrdinaryState.intents.find((intent) => intent.id === unrelatedIntent.id)?.agreementId,
    undefined,
    'checkpoint adoption must not rewrite completed ordinary history as agreement fulfillment',
  );
  const legacyActiveReturnState = structuredClone(returnState);
  const legacyActiveReturnIntent = legacyActiveReturnState.intents.find((intent) => intent.id === returnIntent?.id);
  const legacyActiveReturnAgreement = legacyActiveReturnState.agreements
    .find((agreement) => agreement.id === returnAgreement.id);
  assert.ok(legacyActiveReturnIntent, 'legacy migration fixture requires the active return intent');
  assert.ok(legacyActiveReturnAgreement, 'legacy migration fixture requires the active agreement');
  legacyActiveReturnAgreement.responseEventId = 'test-active-companion-response';
  delete legacyActiveReturnIntent.agreementId;
  legacyActiveReturnIntent.sourceFactIds = [...new Set([
    ...legacyActiveReturnIntent.sourceFactIds,
    returnAgreement.proposalEventId,
    legacyActiveReturnAgreement.responseEventId,
  ])];
  const legacyReturnOwner = legacyActiveReturnState.people
    .find((person) => person.id === legacyActiveReturnIntent.ownerId);
  assert.ok(legacyReturnOwner, 'legacy migration fixture requires the intent owner');
  legacyActiveReturnState.world.past.push({
    id: legacyActiveReturnIntent.sourceDecisionEventId,
    kind: 'decision',
    atMonth: legacyActiveReturnIntent.createdAtMonth,
    orderInMonth: legacyActiveReturnState.world.past
      .filter((event) => event.atMonth === legacyActiveReturnIntent.createdAtMonth).length + 1,
    planningTick: 2,
    orderInTick: 0,
    cellId: legacyReturnOwner.position.cellId,
    who: legacyReturnOwner.id,
    decision: { kind: 'start', optionId: returnOption.id, reason: '测试旧版履约意图恢复' },
    intentId: legacyActiveReturnIntent.id,
    usedModel: false,
    domain: legacyActiveReturnIntent.domain,
    result: '测试旧版履约意图恢复',
  });
  delete legacyActiveReturnState.world.historyCursor;
  assert.equal(
    restoreSimulationState(legacyActiveReturnState).intents
      .find((intent) => intent.id === legacyActiveReturnIntent.id)?.agreementId,
    returnAgreement.id,
    'checkpoint adoption must still migrate a live legacy fulfillment intent',
  );

  // An accepted but not-yet-established companionship must enter the same
  // commitment agenda once the remaining calendar window is exactly the
  // number of shared-living months still required. Otherwise the return
  // affordance exists but routine work can repeatedly starve the promise.
  const pendingReturnState = structuredClone(companionFixture.state);
  const pendingReturnPerson = pendingReturnState.people.find((person) => person.id === companionFixture.requester.id);
  const pendingReturnAgreement = pendingReturnState.agreements.find((agreement) => agreement.id === companionAgreement.id);
  assert.ok(pendingReturnPerson && pendingReturnAgreement, 'pending return fixture requires the proposer and agreement');
  delete pendingReturnAgreement.companionEstablishedAtMonth;
  delete pendingReturnAgreement.lastCompanionCoLocatedAtMonth;
  delete pendingReturnAgreement.lastCompanionRelationshipAtCoLocatedMonth;
  pendingReturnAgreement.coLocatedMonths = 8;
  pendingReturnAgreement.dueAtMonth = atMonth + 3;
  pendingReturnPerson.position = { ...pendingReturnPerson.position, ...awayPosition };
  pendingReturnPerson.personality.baseline.conscientiousness = 90;
  Object.assign(pendingReturnPerson.body, { health: 100, hydration: 100, nutrition: 100 });
  const pendingReturnOption = buildSocialOptions(pendingReturnState, pendingReturnPerson, [], atMonth)
    .find((option) => option.id === `return-shared-living:${pendingReturnAgreement.id}:${pendingReturnPerson.id}`);
  assert.ok(pendingReturnOption, 'the last feasible establishment window must expose a fixed-anchor return option');
  const pendingReturnContext = {
    state: pendingReturnState, person: pendingReturnPerson,
    visibleCells: [pendingReturnPerson.position.cellId], visiblePeople: [],
    visibleDrops: [], visibleAnimals: [], options: [pendingReturnOption], followUpOptions: [],
  };
  const pendingCommitment = deriveNeedAgenda(pendingReturnContext, atMonth)
    .find((need) => need.kind === 'commitment');
  assert.ok(pendingCommitment, 'the last feasible establishment window must create a commitment need before breach');
  assert.ok(pendingCommitment.sourceFactIds.includes('e-0-environment-founding-0'),
    'the pre-establishment commitment need must retain the accepted agreement source');
  const pendingReturnChoice = new RulePlanner().decideAt(pendingReturnContext, { atMonth, planningTick: 3 });
  assert.equal(pendingReturnChoice.kind, 'start');
  assert.equal(pendingReturnChoice.optionId, pendingReturnOption.id,
    'a conscientious person should be able to act on the due pre-establishment commitment');
  const routineIntent = {
    id: 'intent-pending-companion-routine-work',
    ownerId: pendingReturnPerson.id,
    summary: '继续日常生产', domain: 'strategic',
    goal: { kind: 'inventory-at-least', materialId: 13, quantity: 99 },
    nextAction: { kind: 'move', toCellId: pendingReturnPerson.position.cellId, toZ: pendingReturnPerson.position.z },
    status: 'active', createdAtMonth: atMonth - 2, lastProgressAtMonth: atMonth,
    progress: 0.6, sourceDecisionEventId: 'decision-routine-work',
    sourceFactIds: ['e-0-environment-founding-0'], actionEventIds: [], replanCount: 0,
  };
  pendingReturnState.intents.push(routineIntent);
  pendingReturnPerson.activeIntentId = routineIntent.id;
  const interruptedReturnChoice = new RulePlanner().decideAt({
    ...pendingReturnContext,
    activeIntent: routineIntent,
  }, { atMonth, planningTick: 4 });
  assert.equal(interruptedReturnChoice.kind, 'revise');
  assert.equal(interruptedReturnChoice.optionId, pendingReturnOption.id);
  assert.match(interruptedReturnChoice.reason, /先履行已经生效的承诺或职责/u,
    'a due accepted companionship must preempt routine work through the existing fulfillment protocol');

  Object.assign(companionFixture.relation, { trust: 20, bond: 20, fear: 70 });
  const adverseCompanionChoice = new RulePlanner().decideAt({ ...companionContext, options: [companionWithdrawal] }, {
    atMonth, planningTick: 2,
  });
  assert.equal(adverseCompanionChoice.kind, 'start');
  assert.equal(adverseCompanionChoice.optionId, companionWithdrawal.id,
    'replayable fear that clearly exceeds trust and bond should make the visible revoke affordance actionable');
  const thirdPerson = companionFixture.state.people.find((candidate) => !companionAgreement.partyIds.includes(candidate.id));
  assert.ok(thirdPerson, 'fixture requires a third locally perceptible person');
  const distantPosition = cellsInRadius(companionFixture.requester.position.cellId, 20)
    .flatMap((cellId) => standingPositions(companionFixture.state.world.grid, cellId))
    .find((position) => findStandingPath(
      companionFixture.state.world.grid,
      companionFixture.requester.position,
      position,
    ).length > 12);
  assert.ok(distantPosition, 'fixture requires a position outside conversational range');
  thirdPerson.position = structuredClone(companionFixture.requester.position);
  const requesterThirdRelation = companionFixture.requester.relations.find((relation) => relation.personId === thirdPerson.id);
  const thirdRequesterRelation = thirdPerson.relations.find((relation) => relation.personId === companionFixture.requester.id);
  assert.ok(requesterThirdRelation && thirdRequesterRelation, 'fixture requires reciprocal third-person relation caches');
  Object.assign(requesterThirdRelation, {
    trust: 1, bond: 1, fear: 0, sourceEventIds: ['e-0-environment-founding-0'],
  });
  Object.assign(thirdRequesterRelation, {
    trust: 1, bond: 1, fear: 0, sourceEventIds: ['e-0-environment-founding-0'],
  });
  addPairExperience(
    companionFixture.state,
    companionFixture.requester,
    thirdPerson,
    'test-third-person-company-experience',
  );
  const widerCompanionContext = {
    ...companionContext,
    visiblePeople: [companionFixture.helper, thirdPerson],
  };
  assert.ok(deriveNeedAgenda(widerCompanionContext, atMonth).some((need) => need.kind === 'belonging'),
    'one active companionship must not globally erase affiliation needs toward every other visible person');
  assert.ok(buildSocialOptions(
    companionFixture.state,
    companionFixture.requester,
    [companionFixture.helper, thirdPerson],
    atMonth,
  ).some((option) => option.id.startsWith('request-company:')
    && option.target?.kind === 'person'
    && option.target.personId === thirdPerson.id),
  'companionship is pairwise and non-exclusive unless a later institution creates exclusivity');
  const distantCompanionState = structuredClone(companionFixture.state);
  const distantCompanionRequester = distantCompanionState.people.find((person) => person.id === companionFixture.requester.id);
  const distantCompanionHelper = distantCompanionState.people.find((person) => person.id === companionFixture.helper.id);
  distantCompanionHelper.position = distantPosition;
  assert.equal(buildSocialOptions(distantCompanionState, distantCompanionRequester, [], atMonth)
    .some((option) => option.id.startsWith('withdraw-companion:')), false,
  'ending companionship must not track a distant partner in real time');

  // A collective with one living member is dormant rather than dissolved.
  // Unanimous admission of a new member must revive it; otherwise the accepted
  // agreement can only wait one month, breach, and be proposed again forever.
  const dormantFixture = preparePair(26082137);
  const dormantFounder = dormantFixture.requester;
  const dormantCandidate = dormantFixture.helper;
  const departedMember = dormantFixture.state.people.find((person) => person.id !== dormantFounder.id
    && person.id !== dormantCandidate.id);
  assert.ok(departedMember, 'dormant collective fixture requires a historical second member');
  dormantCandidate.position = structuredClone(dormantFounder.position);
  dormantCandidate.bornAtMonth = atMonth - 25 * 12;
  Object.assign(dormantFixture.relation, { trust: 12, bond: 8, fear: 0 });
  const cooperationAgreementId = 'test-dormant-collective-cooperation';
  dormantFixture.state.agreements.push({
    id: cooperationAgreementId,
    proposal: {
      kind: 'assist', requesterId: dormantCandidate.id, helperId: dormantFounder.id,
      need: 'company', expiresAtMonth: atMonth - 2,
    },
    proposerId: dormantCandidate.id,
    responderId: dormantFounder.id,
    partyIds: [dormantCandidate.id, dormantFounder.id],
    requiredResponderIds: [dormantFounder.id],
    acceptedByPersonIds: [dormantCandidate.id, dormantFounder.id],
    rejectedByPersonIds: [], status: 'fulfilled', proposedAtMonth: atMonth - 6,
    acceptByMonth: atMonth - 2, acceptedAtMonth: atMonth - 5, dueAtMonth: atMonth - 1,
    resolvedAtMonth: atMonth - 4,
    proposalEventId: 'e-0-environment-founding-0',
    fulfillmentEventIds: ['e-0-environment-founding-0'],
    fulfilledByPersonIds: [dormantCandidate.id, dormantFounder.id],
    coLocatedMonths: 0,
    sourceEventIds: ['e-0-environment-founding-0'],
  });
  dormantFounder.cognition.socialLearning = {
    version: 'social-learning-v1',
    startedAtMonth: atMonth - 6,
    beliefs: [],
    coordinationPractices: [{
      version: 'coordination-practice-basis-v1',
      basisKey: `test-dormant-practice:${dormantFounder.id}:${dormantCandidate.id}`,
      observerId: dormantFounder.id,
      targetPersonId: dormantCandidate.id,
      participantIds: [dormantFounder.id, dormantCandidate.id],
      context: 'assist-company',
      formedAtMonth: atMonth - 6,
      lastUpdatedAtMonth: atMonth - 4,
      support: 'supported',
      successes: [{
        atMonth: atMonth - 4,
        receiptIds: ['test-dormant-practice-receipt'],
        sourceEventIds: ['e-0-environment-founding-0'],
      }],
      recentCounterEvidence: [],
      sourceFactIds: ['e-0-environment-founding-0'],
    }],
  };
  const dormantCollectiveId = 'collective:test-dormant-revival';
  dormantFixture.state.collectives.push({
    id: dormantCollectiveId,
    purposeSummary: '延续已有合作与共同生活',
    status: 'dormant',
    foundedAtMonth: atMonth - 12,
    formationAgreementId: 'test-dormant-formation',
    memberships: [
      {
        id: `membership:${dormantCollectiveId}:${dormantFounder.id}:12`,
        collectiveId: dormantCollectiveId,
        personId: dormantFounder.id,
        status: 'active', joinedAtMonth: atMonth - 12,
        sourceEventIds: ['e-0-environment-founding-0'],
      },
      {
        id: `membership:${dormantCollectiveId}:${departedMember.id}:12`,
        collectiveId: dormantCollectiveId,
        personId: departedMember.id,
        status: 'ended', joinedAtMonth: atMonth - 12, endedAtMonth: atMonth - 1,
        sourceEventIds: ['e-0-environment-founding-0'],
      },
    ],
    decisionRules: [], mandates: [], sourceEventIds: ['e-0-environment-founding-0'],
  });
  const dormantOffer = buildSocialOptions(dormantFixture.state, dormantFounder, [dormantCandidate], atMonth)
    .find((option) => option.id.startsWith('offer-membership:')
      && option.nextAction.kind === 'communicate'
      && option.nextAction.content.proposal?.kind === 'membership'
      && option.nextAction.content.proposal.collectiveId === dormantCollectiveId
      && option.nextAction.content.proposal.candidateId === dormantCandidate.id);
  assert.ok(dormantOffer, 'the sole living member must be able to invite a proven collaborator into a dormant collective');
  const dormantOfferFact = commitAction(dormantFixture.state, dormantFounder, dormantOffer.nextAction, 10);
  const dormantAdmission = dormantFixture.state.agreements.find((agreement) => agreement.proposalEventId === dormantOfferFact.id);
  assert.equal(dormantAdmission?.status, 'proposed');
  assert.deepEqual(dormantAdmission?.requiredResponderIds, [dormantCandidate.id],
    'reviving a one-member collective requires the candidate response but no dead member response');
  const dormantAcceptance = buildSocialOptions(dormantFixture.state, dormantCandidate, [dormantFounder], atMonth)
    .find((option) => option.id === `accept-membership:${dormantAdmission.id}`);
  assert.ok(dormantAcceptance, 'the invited collaborator must receive an explicit admission response');
  commitAction(dormantFixture.state, dormantCandidate, dormantAcceptance.nextAction, 11);
  assert.equal(dormantAdmission.status, 'fulfilled',
    'unanimous admission must fulfill instead of leaving a dormant collective agreement to breach');
  assert.equal(dormantFixture.state.collectives.find((collective) => collective.id === dormantCollectiveId)?.status, 'active',
    'adding the second living member must reactivate the dormant collective');
  assert.equal(dormantFixture.state.collectives.find((collective) => collective.id === dormantCollectiveId)
    ?.memberships.find((membership) => membership.personId === dormantCandidate.id)?.status, 'active');
  const laterAgreementFacts = advanceAgreementLifecycle(dormantFixture.state, atMonth + 2);
  assert.equal(laterAgreementFacts.some((fact) => fact.agreementId === dormantAdmission.id && fact.change === 'breached'), false,
    'the revived admission must not produce a delayed breach fact');

  // Adverse sourced relationship evidence exposes an explicit local revoke.
  const revokeFixture = preparePair(26082134);
  const revokedAgreement = requestCompany(revokeFixture.state, revokeFixture.requester, revokeFixture.helper);
  acceptCompany(revokeFixture.state, revokeFixture.requester, revokeFixture.helper, revokedAgreement);
  Object.assign(revokeFixture.reciprocal, { trust: 0, bond: 0, fear: 30 });
  const revoke = buildSocialOptions(revokeFixture.state, revokeFixture.helper, [revokeFixture.requester], atMonth)
    .find((option) => option.id.startsWith('withdraw-company-assist:'));
  assert.ok(revoke, 'an active company agreement must be locally revocable after sourced adverse evidence');
  const revokeFact = commitAction(revokeFixture.state, revokeFixture.helper, revoke.nextAction, 2);
  assert.equal(revokeFact.status, 'completed');
  assert.equal(revokedAgreement.status, 'cancelled');

  console.log('company affiliation chain tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
