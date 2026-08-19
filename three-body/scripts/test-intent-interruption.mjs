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
    export { createInitialState, resolveInterruptedIntentReturn, RulePlanner, startInterruptIntent } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts', '--sourcefile=intent-interruption-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: testEntry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    createInitialState,
    executePrimitiveAction,
    resolveInterruptedIntentReturn,
    RulePlanner,
    startInterruptIntent,
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

  process.stdout.write('intent interruption tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
