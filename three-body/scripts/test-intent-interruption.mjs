import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-intent-interruption-test-'));
const bundlePath = path.join(temporaryDirectory, 'simulation.mjs');

try {
  const testEntry = `
    export { buildDecisionContextForPerson, createInitialState, installAgreementContinuation, resolveInterruptedIntentReturn, RulePlanner, startInterruptIntent, stepSimulation } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { compileAgreementContinuations } from ${JSON.stringify(path.resolve('src/game/eland/application/agreement-continuation.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts', '--sourcefile=intent-interruption-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: testEntry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    compileAgreementContinuations,
    buildDecisionContextForPerson,
    createInitialState,
    executePrimitiveAction,
    installAgreementContinuation,
    resolveInterruptedIntentReturn,
    RulePlanner,
    startInterruptIntent,
    stepSimulation,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(713, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  state.clock.elapsedMonths = 12;
  const person = state.people[0];
  const project = {
    id: 'project-interruption-fixture', kind: 'production', need: 'food-preparation', desiredFunction: 'prepared-food',
    summary: '持续加工食物', ownerId: person.id, beneficiaryIds: [person.id], triggerFactIds: ['need-fact'],
    pressure: 60, createdAtMonth: 5, reviewAtMonth: 20, status: 'active', lastProgressAtMonth: 12,
    missingMaterialIds: [], reservations: [], contributorIds: [person.id], actionEventIds: ['project-action-before-interrupt'],
    failureEventIds: [], completionEventIds: [], logisticsEpisodes: [],
  };
  state.projects = [project];
  const parent = {
    id: 'parent-project-intent', ownerId: person.id, summary: project.summary, domain: 'strategic',
    goal: { kind: 'project-completed', projectId: project.id },
    nextAction: { kind: 'attend', target: { kind: 'person', personId: person.id } },
    status: 'active', createdAtMonth: 5, lastProgressAtMonth: 12, progress: 0.63,
    sourceDecisionEventId: 'parent-decision', projectId: project.id, sourceFactIds: ['need-fact'],
    actionEventIds: ['project-action-before-interrupt'], replanCount: 0,
  };
  state.intents = [parent];
  person.activeIntentId = parent.id;

  const responseId = 'accept-companion:fixture';
  const option = {
    id: responseId, summary: '接受眼前的结伴提议', reason: '存在一项必须由本人回应的提议',
    goal: { kind: 'representation-made', representationId: responseId },
    nextAction: {
      kind: 'communicate', content: { id: responseId, kind: 'accept', referenceId: 'companion-offer-fixture' },
      audience: [state.people[1].id], channel: 'voice',
    },
    target: { kind: 'person', personId: state.people[1].id }, estimatedDuration: 'one-month', estimatedMonths: 1,
    sourceFactIds: ['proposal-fact'], domain: 'social',
  };
  const context = {
    state, person, visibleCells: [person.position.cellId], visiblePeople: [state.people[1]],
    visibleDrops: [], visibleAnimals: [], options: [option], followUpOptions: [], activeIntent: parent,
  };

  const forcedDecision = new RulePlanner().decideAt(context, { atMonth: 13, planningTick: 1 });
  assert.equal(forcedDecision.kind, 'revise');
  assert.equal(forcedDecision.mode, 'interrupt');
  assert.equal(forcedDecision.interruptionKind, 'required-response');

  const progressBefore = parent.progress;
  const actionsBefore = [...parent.actionEventIds];
  const child = startInterruptIntent(state, person, context, option.id, 'interrupt-decision', 13, 'required-response');
  assert.ok(child, 'an explicit interrupt should create a child intent');
  assert.equal(parent.status, 'suspended');
  assert.equal(parent.suspendedByIntentId, child.id);
  assert.equal(child.returnToIntentId, parent.id);
  assert.equal(child.interruptionKind, 'required-response');
  assert.equal(child.projectId, undefined, 'the child action must not be attributed to the parent project');
  assert.equal(person.activeIntentId, child.id);
  assert.equal(parent.progress, progressBefore);
  assert.deepEqual(parent.actionEventIds, actionsBefore);

  child.status = 'completed';
  child.progress = 1;
  delete person.activeIntentId;
  resolveInterruptedIntentReturn(state, person, 14);
  assert.equal(child.returnOutcome, 'resumed');
  assert.equal(child.returnResolvedAtMonth, 14);
  assert.equal(parent.status, 'active');
  assert.equal(person.activeIntentId, parent.id, 'the exact parent intent id must resume');
  assert.equal(parent.progress, progressBefore, 'interruptions must not reset project progress');
  assert.deepEqual(parent.actionEventIds, actionsBefore, 'interruptions must not discard project action history');
  const postReturnOption = {
    id: 'project:project-interruption-fixture:continue', summary: '继续原项目', reason: '项目仍在推进',
    goal: { kind: 'project-completed', projectId: project.id },
    nextAction: { kind: 'attend', target: { kind: 'person', personId: person.id } },
    target: { kind: 'person', personId: person.id }, estimatedDuration: 'several-months', estimatedMonths: 3,
    sourceFactIds: ['need-fact'], domain: 'strategic', projectId: project.id, projectPressure: project.pressure,
  };
  const postReturnDecision = new RulePlanner().decideAt({
    ...context, options: [postReturnOption], followUpOptions: [], activeIntent: parent,
  }, { atMonth: 14, planningTick: 2 });
  assert.equal(postReturnDecision.kind, 'idle', 'suspension time must not make a just-restored parent look stalled');

  const agreementState = createInitialState(717, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  agreementState.clock.elapsedMonths = 12;
  const offerer = agreementState.people[0];
  const responder = agreementState.people[1];
  responder.position = structuredClone(offerer.position);
  offerer.body.health = offerer.body.nutrition = offerer.body.hydration = 100;
  responder.body.health = responder.body.nutrition = responder.body.hydration = 100;
  offerer.inventory = [{ id: 'agreement-parent-wood', materialId: 13, quantity: 2, sourceEventIds: ['wood-source'] }];
  responder.inventory = [{ id: 'agreement-responder-food', materialId: 21, quantity: 2, sourceEventIds: ['food-source'] }];
  const agreementProject = {
    id: 'project-agreement-parent', kind: 'production', need: 'food-preparation', desiredFunction: 'prepared-food',
    summary: '继续处理既有生产项目', ownerId: offerer.id, beneficiaryIds: [offerer.id], triggerFactIds: ['agreement-project-need'],
    pressure: 61, createdAtMonth: 4, reviewAtMonth: 24, status: 'active', lastProgressAtMonth: 11,
    missingMaterialIds: [], reservations: [], contributorIds: [offerer.id], actionEventIds: ['agreement-project-action-before'],
    failureEventIds: [], completionEventIds: [], logisticsEpisodes: [],
  };
  const agreementParent = {
    id: 'agreement-project-parent-intent', ownerId: offerer.id, summary: agreementProject.summary, domain: 'strategic',
    goal: { kind: 'project-completed', projectId: agreementProject.id },
    nextAction: { kind: 'attend', target: { kind: 'person', personId: offerer.id } },
    status: 'active', createdAtMonth: 4, lastProgressAtMonth: 11, progress: 0.58,
    sourceDecisionEventId: 'agreement-project-decision', projectId: agreementProject.id,
    sourceFactIds: ['agreement-project-need'], actionEventIds: ['agreement-project-action-before'], replanCount: 0,
  };
  const exchangeId = 'agreement-interruption-exchange';
  const acceptanceIntent = {
    id: 'exchange-acceptance-intent', ownerId: responder.id, summary: '接受眼前的交换提议', domain: 'social',
    goal: { kind: 'representation-made', representationId: 'exchange-acceptance' },
    nextAction: {
      kind: 'communicate', content: { id: 'exchange-acceptance', kind: 'accept', referenceId: exchangeId },
      audience: [offerer.id], channel: 'voice',
    },
    status: 'active', createdAtMonth: 12, lastProgressAtMonth: 12, progress: 0,
    sourceDecisionEventId: 'exchange-acceptance-decision', sourceFactIds: ['exchange-offer'], actionEventIds: [], replanCount: 0,
  };
  agreementState.projects = [agreementProject];
  agreementState.intents = [agreementParent, acceptanceIntent];
  offerer.activeIntentId = agreementParent.id;
  responder.activeIntentId = acceptanceIntent.id;

  const exchangeOffer = executePrimitiveAction(agreementState, offerer, {
    kind: 'communicate',
    content: {
      id: exchangeId, kind: 'offer', summary: '用木材交换食物',
      proposal: {
        kind: 'exchange', offererId: offerer.id, partnerId: responder.id,
        offererMaterialId: 13, offererQuantity: 1, partnerMaterialId: 21, partnerQuantity: 1, expiresAtMonth: 18,
      },
    },
    audience: [responder.id], channel: 'voice',
  }, 12, 0, { cause: 'intent', actionTick: 0 });
  const exchangeAcceptance = executePrimitiveAction(agreementState, responder, acceptanceIntent.nextAction, 12, 1, {
    intentId: acceptanceIntent.id, cause: 'intent', actionTick: 1,
  });
  assert.equal(exchangeOffer.status, 'completed');
  assert.equal(exchangeAcceptance.status, 'completed');
  assert.equal(agreementState.agreements.find((agreement) => agreement.id === exchangeId)?.status, 'active');

  const agreementContinuations = compileAgreementContinuations(agreementState, exchangeId);
  const installedContinuations = agreementContinuations.map((continuation) => (
    installAgreementContinuation(agreementState, acceptanceIntent, continuation, 12)
  )).filter(Boolean);
  const offererContinuation = installedContinuations.find((intent) => intent.ownerId === offerer.id);
  const responderContinuation = installedContinuations.find((intent) => intent.ownerId === responder.id);
  assert.ok(offererContinuation && responderContinuation, 'accepted exchange must compile a concrete continuation for both parties');
  assert.equal(agreementParent.status, 'suspended');
  assert.equal(agreementParent.suspendedByIntentId, offererContinuation.id,
    'the other party project must point to the fulfillment child that suspended it');
  assert.equal(offererContinuation.returnToIntentId, agreementParent.id,
    'the other party fulfillment child must return to the exact project intent it interrupted');
  assert.equal(offererContinuation.interruptionKind, 'fulfillment');
  assert.equal(offererContinuation.projectId, undefined, 'agreement delivery must not be attributed to the suspended project');
  assert.equal(offerer.activeIntentId, offererContinuation.id);
  const agreementParentProgress = agreementParent.progress;
  const agreementParentActions = [...agreementParent.actionEventIds];
  const agreementProjectActions = [...agreementProject.actionEventIds];

  const offererDelivery = executePrimitiveAction(agreementState, offerer, offererContinuation.nextAction, 12, 2, {
    intentId: offererContinuation.id, cause: 'intent', actionTick: 2,
  });
  const responderDelivery = executePrimitiveAction(agreementState, responder, responderContinuation.nextAction, 12, 3, {
    intentId: responderContinuation.id, cause: 'intent', actionTick: 3,
  });
  assert.equal(offererDelivery.status, 'completed');
  assert.equal(responderDelivery.status, 'completed');
  assert.equal(agreementState.agreements.find((agreement) => agreement.id === exchangeId)?.status, 'fulfilled',
    'both concrete transfers must fulfill the accepted exchange');
  offererContinuation.actionEventIds.push(offererDelivery.id);
  offererContinuation.status = 'completed';
  offererContinuation.progress = 1;
  delete offerer.activeIntentId;
  resolveInterruptedIntentReturn(agreementState, offerer, 13);
  assert.equal(offererContinuation.returnOutcome, 'resumed');
  assert.equal(agreementParent.status, 'active');
  assert.equal(offerer.activeIntentId, agreementParent.id, 'fulfillment must restore the same project parent id');
  assert.equal(agreementParent.progress, agreementParentProgress, 'fulfillment must not reset parent project progress');
  assert.deepEqual(agreementParent.actionEventIds, agreementParentActions, 'fulfillment must preserve the parent action history');
  assert.deepEqual(agreementProject.actionEventIds, agreementProjectActions, 'fulfillment must not pollute the project action history');
  assert.equal(agreementState.intents.some((intent) => intent.status === 'suspended' && intent.projectId && !intent.suspendedByIntentId), false,
    'agreement fulfillment must not leave an orphan suspended project intent');

  const failedContinuation = installAgreementContinuation(agreementState, acceptanceIntent, {
    agreementId: 'missing-agreement', personId: offerer.id, summary: '尝试履行已经失效的交换',
    goal: { kind: 'inventory-at-least', materialId: 13, quantity: 99, personId: responder.id },
    nextAction: {
      kind: 'transfer', materialId: 13, quantity: 1,
      from: { kind: 'person', personId: offerer.id }, to: { kind: 'person', personId: responder.id },
      stackId: 'missing-agreement-stack', authorizationRef: 'missing-agreement',
    },
    target: { kind: 'person', personId: responder.id }, sourceFactIds: ['expired-exchange'],
  }, 14);
  assert.ok(failedContinuation);
  const failedDelivery = executePrimitiveAction(agreementState, offerer, failedContinuation.nextAction, 14, 0, {
    intentId: failedContinuation.id, cause: 'intent', actionTick: 0,
  });
  assert.ok(failedDelivery.status === 'blocked' || failedDelivery.status === 'failed');
  failedContinuation.status = failedDelivery.status;
  failedContinuation.blockedReason = failedDelivery.result;
  delete offerer.activeIntentId;
  resolveInterruptedIntentReturn(agreementState, offerer, 14);
  assert.equal(failedContinuation.returnOutcome, 'resumed', 'a failed fulfillment must still resolve its return edge');
  assert.equal(offerer.activeIntentId, agreementParent.id, 'a failed fulfillment must restore the same project parent');
  assert.equal(agreementParent.progress, agreementParentProgress);
  assert.deepEqual(agreementParent.actionEventIds, agreementParentActions);
  assert.equal(agreementState.intents.some((intent) => intent.status === 'suspended' && intent.projectId && !intent.suspendedByIntentId), false);

  parent.status = 'suspended';
  parent.suspendedByIntentId = 'terminal-child';
  parent.suspendedAtMonth = 15;
  delete person.activeIntentId;
  project.status = 'completed';
  project.completedAtMonth = 16;
  state.intents.push({
    ...structuredClone(child), id: 'terminal-child', status: 'completed', createdAtMonth: 15,
    returnToIntentId: parent.id, returnOutcome: undefined, returnResolvedAtMonth: undefined,
  });
  resolveInterruptedIntentReturn(state, person, 16);
  const terminalChild = state.intents.find((intent) => intent.id === 'terminal-child');
  assert.equal(terminalChild.returnOutcome, 'parent-completed');
  assert.equal(parent.status, 'completed');
  assert.equal(person.activeIntentId, undefined);

  const consentState = createInitialState(719, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  consentState.clock.elapsedMonths = 12;
  const female = consentState.people.find((candidate) => candidate.sex === 'female');
  const male = consentState.people.find((candidate) => candidate.sex === 'male');
  assert.ok(female && male, 'the fixture needs two people of opposite biological sex');
  female.position = structuredClone(male.position);
  female.bornAtMonth = 12 - 25 * 12;
  male.bornAtMonth = 12 - 25 * 12;
  female.body.health = female.body.nutrition = female.body.hydration = 100;
  male.body.health = male.body.nutrition = male.body.hydration = 100;
  female.conditions = female.conditions.filter((condition) => condition.kind !== 'pregnancy');
  Object.assign(female.relations.find((relation) => relation.personId === male.id), { trust: 60, bond: 60 });
  Object.assign(male.relations.find((relation) => relation.personId === female.id), { trust: 60, bond: 60 });

  const offerId = 'same-month-reproduction-offer';
  const offer = executePrimitiveAction(consentState, male, {
    kind: 'communicate',
    content: {
      id: offerId,
      kind: 'offer',
      summary: '是否愿意共同生育后代',
      proposal: { kind: 'reproduce', proposerId: male.id, partnerId: female.id, expiresAtMonth: 16 },
    },
    audience: [female.id],
    channel: 'voice',
  }, 12, 0, { cause: 'intent', actionTick: 0 });
  const acceptance = executePrimitiveAction(consentState, female, {
    kind: 'communicate',
    content: { id: 'same-month-reproduction-acceptance', kind: 'accept', referenceId: offerId },
    audience: [male.id],
    channel: 'voice',
  }, 12, 1, { cause: 'intent', actionTick: 1 });
  assert.equal(consentState.agreements.find((agreement) => agreement.id === offerId)?.status, 'active');
  assert.equal(consentState.world.past.some((event) => event.id === offer.id || event.id === acceptance.id), false,
    'the same-month communication facts should still be pending archival in this regression fixture');

  const jointAttemptState = structuredClone(consentState);

  const reproduction = executePrimitiveAction(consentState, female, {
    kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: male.id }], authorizationRef: offerId,
  }, 12, 2, { cause: 'intent', actionTick: 2 });
  assert.equal(reproduction.status, 'completed', 'an active same-month agreement must authorize reproduction immediately');
  assert.notEqual(reproduction.diff.consent, false);
  if (reproduction.diff.conceived === true) {
    const pregnancy = female.conditions.find((condition) => condition.kind === 'pregnancy');
    assert.ok(pregnancy?.sourceEventIds.includes(offer.id));
    assert.ok(pregnancy?.sourceEventIds.includes(acceptance.id));
    assert.ok(pregnancy?.sourceEventIds.includes(reproduction.id));
  }

  const jointFemale = jointAttemptState.people.find((candidate) => candidate.id === female.id);
  const jointMale = jointAttemptState.people.find((candidate) => candidate.id === male.id);
  assert.ok(jointFemale && jointMale);
  const reproductionIntent = (owner, partner, suffix) => ({
    id: `joint-reproduction-${suffix}`,
    ownerId: owner.id,
    summary: `履行与${partner.name}共同接受的生殖尝试`,
    domain: 'social',
    goal: { kind: 'condition', personId: jointFemale.id, condition: 'pregnancy', present: true },
    nextAction: {
      kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: partner.id }], authorizationRef: offerId,
    },
    target: { kind: 'person', personId: partner.id },
    status: 'active',
    createdAtMonth: 12,
    lastProgressAtMonth: 12,
    progress: 0.2,
    sourceDecisionEventId: `joint-reproduction-decision-${suffix}`,
    agreementId: offerId,
    sourceFactIds: [...jointAttemptState.agreements[0].sourceEventIds],
    actionEventIds: [],
    replanCount: 0,
  });
  const femaleIntent = reproductionIntent(jointFemale, jointMale, 'female');
  const maleIntent = reproductionIntent(jointMale, jointFemale, 'male');
  jointAttemptState.intents = [femaleIntent, maleIntent];
  jointFemale.activeIntentId = femaleIntent.id;
  jointMale.activeIntentId = maleIntent.id;
  const afterJointAttempt = stepSimulation(jointAttemptState);
  const jointAttemptFacts = afterJointAttempt.world.past.filter((event) => event.kind === 'action'
    && event.atMonth === 13
    && event.action.kind === 'act'
    && event.action.operation === 'reproduce'
    && event.action.authorizationRef === offerId
    && [jointFemale.id, jointMale.id].includes(event.who));
  assert.equal(jointAttemptFacts.length, 1,
    'two mirrored intents in the same consent window must create only one reproduction ActionFact per month');
  assert.equal(afterJointAttempt.intents.filter((intent) => intent.id === femaleIntent.id || intent.id === maleIntent.id)
    .every((intent) => intent.status === 'completed' || intent.status === 'abandoned'), true,
  'the mirror intent should end with the joint process (or fulfilled agreement) instead of emitting a blocked action');
  const afterJointFemale = afterJointAttempt.people.find((candidate) => candidate.id === jointFemale.id);
  if (afterJointFemale && !afterJointFemale.conditions.some((condition) => condition.kind === 'pregnancy')) {
    const nextMonthHasAttempt = afterJointAttempt.people.some((candidate) => (
      candidate.id === jointFemale.id || candidate.id === jointMale.id
    ) && buildDecisionContextForPerson(afterJointAttempt, candidate, 14).options.some((candidate) => (
      candidate.nextAction.kind === 'act' && candidate.nextAction.operation === 'reproduce'
    )));
    assert.equal(nextMonthHasAttempt, true, 'an unconceived active consent window may expose one fresh attempt next month');
  }

  process.stdout.write('intent interruption tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
