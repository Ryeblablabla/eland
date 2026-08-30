import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-character-agenda-application-'));
const bundlePath = path.join(temporaryDirectory, 'character-agenda-application.mjs');
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/application/character-agenda.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/simulation.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${simulationBundlePath}`,
  ], { stdio: 'pipe' });
  const agenda = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const simulation = await import(`${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`);

  const founding = {
    id: 'e-0-environment-founding-0', kind: 'environment', change: 'founding',
    atMonth: 0, orderInMonth: 0, cellId: 0, result: '共同抵达', diff: {},
  };
  const person = {
    id: 'person-a', name: '甲', bornAtMonth: 0,
    position: { cellId: 0, z: 1 },
    inventory: [
      { id: 'stack-a', materialId: 1, quantity: 2, sourceEventIds: [founding.id] },
      { id: 'stack-b', materialId: 2, quantity: 2, sourceEventIds: [founding.id] },
    ],
    traits: [{ id: 'test', sourceEventIds: [founding.id] }],
    memories: [], knowledge: [], knownPlaces: [], relations: [], conditions: [],
  };
  const grid = {
    version: 2, width: 84, depth: 52, levels: 12,
    generator: { version: 'material-world-v4-regional-geology', seed: 1 },
    palette: [], voxels: new Uint16Array(84 * 52 * 12),
  };
  const state = {
    clock: { elapsedMonths: 3 },
    world: { grid, drops: [], animals: [], remains: [], past: [founding] },
    people: [person], intents: [], containers: [], projects: [],
  };
  const context = {
    state,
    person,
    visibleCells: [0], visiblePeople: [], visibleDrops: [], visibleAnimals: [], visibleRemains: [],
    options: [], followUpOptions: [],
  };
  const proposal = {
    aim: '弄清手边两种物体能否形成更稳固的遮挡',
    theme: 'inquiry',
    importance: 76,
    horizonMonths: 18,
    approach: {
      summary: '先把手边两种物体做一次小规模结合',
      disposition: 'executable-now',
      probe: { kind: 'combine', ownStackIds: ['stack-a', 'stack-b'] },
    },
  };

  const compiled = agenda.compileCharacterAgendaProposal(context, proposal);
  assert.equal(compiled.compilerDisposition, 'accepted-experiment');
  assert.equal(compiled.proposal.approach.disposition, 'bounded-experiment',
    'the application, not the model, classifies a physical proposal');

  const selectedOption = {
    id: 'option-observe', summary: '观察门边变化', reason: '眼前可执行',
    sourceFactIds: [founding.id],
    goal: { kind: 'knowledge', factId: 'door-change' },
    nextAction: { kind: 'act', operation: 'observe', targets: [] },
    estimatedDuration: 'one-month',
  };
  const selectedActionApproach = agenda.compileCharacterAgendaProposal(context, {
    ...proposal,
    approach: { summary: '先执行眼前已经合法的观察', disposition: 'executable-now' },
  }, selectedOption);
  assert.equal(selectedActionApproach.compilerDisposition, 'deferred-missing-affordance',
    'a one-off legal action must not masquerade as a durable agenda episode');
  const durableSelectedOption = { ...selectedOption, estimatedDuration: 'long' };
  const selectedDurableActionApproach = agenda.compileCharacterAgendaProposal(context, {
    ...proposal,
    approach: { summary: '把眼前的长期工作作为当前办法', disposition: 'executable-now' },
  }, durableSelectedOption);
  assert.equal(selectedDurableActionApproach.compilerDisposition, 'accepted-existing-action',
    'a model may bind a durable concern to an already legal sustained action');
  const invalidProbeApproach = agenda.compileCharacterAgendaProposal(context, {
    ...proposal,
    approach: { summary: '尝试已经失效的引用', disposition: 'missing-affordance' },
  }, selectedOption);
  assert.equal(invalidProbeApproach.compilerDisposition, 'deferred-missing-affordance',
    'a removed invalid probe must not be confused with an intentionally omitted probe');
  assert.equal(agenda.optionDeservesDurableAgenda({
    ...selectedOption,
    estimatedDuration: 'several-months',
    semantics: {
      version: 'action-option-semantics-v1', obligation: 'optional', planningChannel: 'ordinary',
      purpose: 'resource', minimumLifeStage: 'adult', needKinds: ['reserve'],
    },
  }), false, 'a generic multi-step errand must not become an identity-level concern merely because travel takes time');

  const accepted = agenda.acceptCharacterAgendaProposal(person, context, proposal, undefined, 4, 'model-proposal');
  assert.equal(accepted.evidence.outcome, 'created');
  assert.equal(accepted.item.aim, proposal.aim);
  const uncompiledAim = agenda.acceptCharacterAgendaUpdate(person, context, {
    kind: 'create',
    proposal: {
      aim: '等到以后有线索时再尝试理解远处反复出现的声响',
      theme: 'inquiry',
      importance: 61,
      horizonMonths: 24,
      approach: { summary: '眼下没有能实际执行的办法', disposition: 'executable-now' },
    },
  }, undefined, 4);
  assert.equal(uncompiledAim.evidence.compilerDisposition, 'deferred-missing-affordance');
  assert.equal(uncompiledAim.item.status, 'incubating');
  assert.equal(uncompiledAim.item.intentIds.length, 0,
    'a free subjective aim without an affordance must not borrow an unrelated Intent');
  const pausedAim = agenda.acceptCharacterAgendaUpdate(person, context, {
    kind: 'pause', basisKey: uncompiledAim.item.basisKey, reason: '暂时没有新的线索',
  }, undefined, 5);
  assert.equal(pausedAim.evidence.outcome, 'paused');
  assert.equal(pausedAim.item.status, 'suspended');
  const unrelatedExistingAgenda = agenda.compileCharacterAgendaProposal(context, {
    ...proposal,
    basisKey: accepted.item.basisKey,
    approach: { summary: '把无关的眼前动作说成既有目标的新方法', disposition: 'executable-now' },
  }, selectedOption);
  assert.equal(unrelatedExistingAgenda.compilerDisposition, 'deferred-missing-affordance',
    'an existing agenda handle must not borrow an unrelated selected action');
  const activeAgendaStillCannotClaimUnlinkedOption = agenda.compileCharacterAgendaProposal({
    ...context,
    activeIntent: { id: 'active-old', characterAgendaItemId: accepted.item.id },
  }, {
    ...proposal,
    basisKey: accepted.item.basisKey,
    approach: { summary: '不能因为旧意图还在就借用无关新动作', disposition: 'executable-now' },
  }, selectedOption);
  assert.equal(activeAgendaStillCannotClaimUnlinkedOption.compilerDisposition, 'deferred-missing-affordance',
    'an active agenda needs an explicitly linked option before a new action becomes its means');
  const actionAlreadyOwnedByAnotherAgenda = agenda.compileCharacterAgendaProposal(context, {
    ...proposal,
    basisKey: 'genuinely-different-new-aim',
    aim: '另一个完全不同的长期关切',
    approach: { summary: '不能借用别的长期关切编译出的动作', disposition: 'executable-now' },
  }, { ...selectedOption, characterAgendaItemId: accepted.item.id });
  assert.equal(actionAlreadyOwnedByAnotherAgenda.compilerDisposition, 'deferred-missing-affordance',
    'a new aim must not attach itself to an option already owned by another agenda');
  const options = agenda.buildCharacterAgendaOptions(context, 4);
  assert.equal(options.length, 1, 'a grounded idea outside the original option list becomes a bounded local option');
  assert.equal(options[0].nextAction.operation, 'combine');
  assert.equal(options[0].characterAgendaItemId, accepted.item.id);

  const intent = {
    id: 'intent-agenda-1', ownerId: person.id, summary: options[0].summary, domain: 'strategic',
    goal: options[0].goal, nextAction: options[0].nextAction, status: 'blocked',
    createdAtMonth: 4, lastProgressAtMonth: 4, progress: 0,
    sourceDecisionEventId: 'decision-1', sourceFactIds: options[0].sourceFactIds,
    actionEventIds: ['action-1'], replanCount: 1,
  };
  assert.equal(agenda.bindAcceptedAgendaToIntent(person, accepted.item, accepted.approach, intent), true);
  state.intents.push(intent);
  const noResponse = {
    id: 'action-1', kind: 'action', atMonth: 4, orderInMonth: 1, cellId: 0,
    planningTick: 2, orderInTick: 0, actionTick: 2, who: person.id, intentId: intent.id,
    cause: 'intent', action: structuredClone(options[0].nextAction), fromCellId: 0, toCellId: 0,
    fromZ: 1, toZ: 1, pathSegment: [], status: 'blocked',
    result: '这些随身物质当前没有可发生的结合规则',
    diff: Object.freeze({ inputMaterialIds: [1, 2] }),
  };
  const noResponseEvents = [noResponse];
  agenda.reconcileCharacterAgendasForMonth(state, noResponseEvents, 4);
  const retained = person.characterAgenda.items.find((item) => item.id === accepted.item.id);
  const evaluated = retained.approaches.find((approach) => approach.id === accepted.approach.id);
  assert.equal(retained.aim, proposal.aim, 'a no-response refutes only the means, not the durable aim');
  assert.equal(evaluated.latestOutcome, 'refuted');
  assert.equal(noResponseEvents[0].diff.characterAgendaOutcome, 'refuted');
  assert.equal(noResponse.diff.characterAgendaOutcome, undefined,
    'a frozen domain receipt is never mutated after execution');
  assert.equal(agenda.buildCharacterAgendaOptions(context, 5).length, 0,
    'the same failed basis cannot be retried merely because a month passed');

  const noActionAccepted = agenda.acceptCharacterAgendaProposal(person, context, {
    aim: '把眼前合法的一步放进更长的个人安排',
    theme: 'inquiry',
    importance: 64,
    horizonMonths: 12,
    approach: { summary: '先做眼前已经合法的一步', disposition: 'executable-now' },
  }, durableSelectedOption, 5, 'model-proposal');
  const noActionIntent = {
    id: 'intent-agenda-no-action', ownerId: person.id, summary: selectedOption.summary, domain: 'strategic',
    goal: { kind: 'knowledge', factId: 'already-known' }, nextAction: selectedOption.nextAction,
    status: 'completed', createdAtMonth: 5, lastProgressAtMonth: 5, progress: 1,
    sourceDecisionEventId: 'decision-no-action', sourceFactIds: [founding.id], actionEventIds: [], replanCount: 0,
    goalOutcome: {
      version: 'intent-goal-outcome-v1', kind: 'achieved', basisKey: 'already-known',
      resolvedAtMonth: 5, sourceEventIds: [founding.id],
    },
  };
  assert.equal(agenda.bindAcceptedAgendaToIntent(
    person, noActionAccepted.item, noActionAccepted.approach, noActionIntent,
  ), true);
  state.intents.push(noActionIntent);
  agenda.reconcileCharacterAgendasForMonth(state, [], 5);
  const noActionItem = person.characterAgenda.items.find((item) => item.id === noActionAccepted.item.id);
  assert.equal(noActionItem.activeIntentId, undefined,
    'an Intent that terminates without ActionFact must not stay active in the agenda');
  assert.equal(noActionItem.approaches[0].latestOutcome, 'supported');
  assert.equal(noActionItem.status, 'fulfilled',
    'a model-proposed agenda bound to a durable legal option must close when that objective goal is achieved');

  const noActionProbeAccepted = agenda.acceptCharacterAgendaProposal(person, context, {
    ...proposal,
    aim: '实际观察以后再判断眼前材料的变化',
    approach: { ...proposal.approach, summary: '实际做一次材料结合再判断' },
  }, undefined, 5, 'model-proposal');
  const noActionProbeIntent = {
    id: 'intent-agenda-probe-no-action', ownerId: person.id,
    summary: noActionProbeAccepted.approach.summary, domain: 'strategic',
    goal: { kind: 'knowledge', factId: 'already-known-probe' },
    nextAction: { kind: 'act', operation: 'combine', targets: [] },
    status: 'completed', createdAtMonth: 5, lastProgressAtMonth: 5, progress: 1,
    sourceDecisionEventId: 'decision-probe-no-action', sourceFactIds: [founding.id],
    actionEventIds: [], replanCount: 0,
    goalOutcome: {
      version: 'intent-goal-outcome-v1', kind: 'achieved', basisKey: 'already-known-probe',
      resolvedAtMonth: 5, sourceEventIds: ['decision-probe-no-action'],
    },
  };
  assert.equal(agenda.bindAcceptedAgendaToIntent(
    person, noActionProbeAccepted.item, noActionProbeAccepted.approach, noActionProbeIntent,
  ), true);
  state.intents.push(noActionProbeIntent);
  agenda.reconcileCharacterAgendasForMonth(state, [], 5);
  const noActionProbeItem = person.characterAgenda.items.find((item) => item.id === noActionProbeAccepted.item.id);
  assert.equal(noActionProbeItem.approaches[0].latestOutcome, 'parked',
    'a decision-only completion must not masquerade as evidence supporting a physical probe');
  assert.notEqual(noActionProbeItem.status, 'fulfilled',
    'a physical probe cannot fulfill its aim without a matching ActionFact');

  const observationAccepted = agenda.acceptCharacterAgendaProposal(person, context, {
    aim: '弄清眼前地表现在是什么状态，再决定下一步怎么验证',
    theme: 'inquiry', importance: 68, horizonMonths: 12,
    approach: {
      summary: '先存点东西，然后也许能知道别的材料为什么失败',
      disposition: 'executable-now',
      probe: { kind: 'observe', target: { kind: 'voxel', position: { x: 0, y: 0, z: 0 } } },
    },
  }, undefined, 6, 'model-proposal');
  assert.match(observationAccepted.approach.summary, /^观察.+记录眼前实际状态$/u,
    'the retained approach text must describe the grounded probe instead of an unrelated model story');
  const observationOption = agenda.buildCharacterAgendaOptions(context, 6)
    .find((option) => option.characterAgendaItemId === observationAccepted.item.id);
  assert.ok(observationOption);
  const observationIntent = {
    id: 'intent-agenda-observation', ownerId: person.id, summary: observationOption.summary, domain: 'strategic',
    goal: observationOption.goal, nextAction: observationOption.nextAction, status: 'completed',
    createdAtMonth: 6, lastProgressAtMonth: 6, progress: 1,
    sourceDecisionEventId: 'decision-observation', sourceFactIds: observationOption.sourceFactIds,
    actionEventIds: ['action-observation'], replanCount: 0,
    characterAgendaItemId: observationAccepted.item.id,
    characterAgendaApproachId: observationAccepted.approach.id,
    goalOutcome: {
      version: 'intent-goal-outcome-v1', kind: 'achieved', basisKey: 'observation-test',
      resolvedAtMonth: 6, sourceEventIds: ['action-observation'],
    },
  };
  assert.equal(agenda.bindAcceptedAgendaToIntent(
    person, observationAccepted.item, observationAccepted.approach, observationIntent,
  ), true);
  state.intents.push(observationIntent);
  const observationEvents = [{
    id: 'action-observation', kind: 'action', atMonth: 6, orderInMonth: 1,
    planningTick: 1, orderInTick: 0, actionTick: 1, cellId: 0, who: person.id,
    intentId: observationIntent.id, cause: 'intent', action: observationOption.nextAction,
    fromCellId: 0, toCellId: 0, fromZ: 1, toZ: 1, pathSegment: [], status: 'completed',
    result: '观察并辨认了眼前地表', diff: {},
  }];
  agenda.reconcileCharacterAgendasForMonth(state, observationEvents, 6);
  const observationItem = person.characterAgenda.items.find((item) => item.id === observationAccepted.item.id);
  assert.equal(observationItem.approaches[0].latestOutcome, 'parked',
    'a completed observation is grounded evidence but not automatic support for a causal claim');
  assert.deepEqual(observationItem.approaches[0].evaluations[0].evidenceFactIds, ['action-observation']);

  const expiring = agenda.acceptCharacterAgendaProposal(person, context, {
    aim: '等现实出现新的抓手再考虑的想法',
    theme: 'inquiry',
    importance: 52,
    horizonMonths: 1,
    approach: { summary: '当前没有可验证办法', disposition: 'missing-affordance' },
  }, undefined, 5, 'model-proposal');
  agenda.reconcileCharacterAgendasForMonth(state, [], 12);
  const expiredItem = person.characterAgenda.items.find((item) => item.id === expiring.item.id);
  assert.equal(expiredItem.status, 'suspended',
    'an expired concern without an executable episode must park instead of occupying permanent active pressure');

  const staleTarget = agenda.compileCharacterAgendaProposal(context, {
    ...proposal,
    basisKey: 'another-aim',
    approach: {
      ...proposal.approach,
      summary: '试着使用一个并不存在的物体',
      probe: { kind: 'combine', ownStackIds: ['stack-a', 'invented-stack'] },
    },
  });
  assert.equal(staleTarget.compilerDisposition, 'deferred-missing-affordance');
  assert.equal(staleTarget.proposal.approach.probe, undefined,
    'an invented or stale ref is retained only as a blocked subjective approach');

  const forged = agenda.compileCharacterAgendaProposal(context, {
    ...proposal,
    materialId: 999,
    approach: { ...proposal.approach, recipeId: 'hidden-recipe' },
  });
  assert.equal(forged.compilerDisposition, 'rejected-authority-claim');
  assert.equal(forged.proposal.approach.probe, undefined,
    'hidden recipes and asserted materials never become executable facts');

  let proposedOnce = false;
  const localPlanner = new simulation.RulePlanner();
  const integrated = simulation.stepSimulation(
    simulation.createInitialState(20260830, { endpoint: { kind: 'months', value: 1 }, chaosIntensity: 0 }),
    {
      decide(decisionContext) {
        const local = localPlanner.decide(decisionContext);
        if (proposedOnce || (local.kind !== 'start' && local.kind !== 'revise')) return local;
        proposedOnce = true;
        return {
          ...local,
          characterAgendaUpdate: {
            kind: 'create',
            proposal: {
            aim: '比较手边实体，寻找一种以后还能继续改进的办法',
            theme: 'inquiry',
            importance: 70,
            horizonMonths: 24,
            approach: {
              summary: '先保留这个方向，等眼前出现可检验的抓手',
              disposition: 'missing-affordance',
            },
            },
          },
        };
      },
    },
  );
  const agendaDecision = integrated.world.past.find((event) => event.kind === 'decision'
    && event.characterAgendaEvidence?.length);
  assert.ok(agendaDecision, 'the ordinary monthly decision path must commit accepted agenda evidence');
  const integratedOwner = integrated.people.find((candidate) => candidate.id === agendaDecision.who);
  assert.ok(integratedOwner.characterAgenda.items.length > 0,
    'the accepted subjective aim must survive the month boundary in authoritative person state');

  const localOnly = simulation.stepSimulation(
    simulation.createInitialState(20260829, { endpoint: { kind: 'months', value: 1 }, chaosIntensity: 0 }),
    localPlanner,
  );
  assert.equal(localOnly.people.some((candidate) => candidate.characterAgenda.items.some((item) => (
    item.origin === 'local-deliberation'
  ))), false, 'local rules may execute projects and intents but must not manufacture subjective long-term aims');

  let proposedMissingAffordance = false;
  const missingAffordanceRun = simulation.stepSimulation(
    simulation.createInitialState(20260831, { endpoint: { kind: 'months', value: 1 }, chaosIntensity: 0 }),
    {
      decide(decisionContext) {
        const local = localPlanner.decide(decisionContext);
        if (proposedMissingAffordance || (local.kind !== 'start' && local.kind !== 'revise')) return local;
        proposedMissingAffordance = true;
        return {
          ...local,
          characterAgendaProposal: {
            aim: '保留一个尚缺少现实抓手的长期想法',
            theme: 'inquiry',
            importance: 66,
            horizonMonths: 12,
            approach: {
              summary: '曾想使用一个已经失效的眼前引用',
              disposition: 'missing-affordance',
            },
          },
        };
      },
    },
  );
  const deferredDecision = missingAffordanceRun.world.past.find((event) => event.kind === 'decision'
    && event.characterAgendaEvidence?.some((evidence) => evidence.compilerDisposition === 'deferred-missing-affordance'));
  assert.ok(deferredDecision, 'a stale probe may preserve the subjective aim as deferred evidence');
  const deferredOwner = missingAffordanceRun.people.find((candidate) => candidate.id === deferredDecision.who);
  const deferredItem = deferredOwner.characterAgenda.items.find((item) => item.aim === '保留一个尚缺少现实抓手的长期想法');
  assert.equal(deferredItem.status, 'incubating');
  assert.equal(deferredItem.intentIds.length, 0,
    'a removed invalid probe must never borrow an unrelated selected Intent');
  assert.equal(deferredItem.approaches[0].evaluations.length, 0,
    'an unrelated completed action must not wash a stale probe into supported evidence');

  let reflected = false;
  const subjectiveOnlyRun = await simulation.stepSimulationAsync(
    simulation.createInitialState(20260901, { endpoint: { kind: 'months', value: 1 }, chaosIntensity: 0 }),
    {
      async decideAll(contexts) {
        return contexts.map(() => {
          if (reflected) return null;
          reflected = true;
          return {
            kind: 'idle',
            reason: '先记住这个方向，眼下不伪造行动',
            characterAgendaUpdate: {
              kind: 'create',
              proposal: {
                aim: '以后找到依据时再弄清夜里反复传来的声响',
                theme: 'inquiry',
                importance: 67,
                horizonMonths: 18,
                approach: { summary: '目前没有可执行的办法', disposition: 'executable-now' },
              },
            },
          };
        });
      },
    },
  );
  const reflectionFact = subjectiveOnlyRun.world.past.find((event) => event.kind === 'decision'
    && event.decision.kind === 'idle'
    && event.characterAgendaEvidence?.some((evidence) => evidence.operation === 'create'));
  assert.ok(reflectionFact,
    'an option-free model reflection must commit its accepted subjective update as a DecisionFact');
  const reflectionOwner = subjectiveOnlyRun.people.find((candidate) => candidate.id === reflectionFact.who);
  const reflectionAgenda = reflectionOwner.characterAgenda.items
    .find((item) => item.aim === '以后找到依据时再弄清夜里反复传来的声响');
  assert.equal(reflectionAgenda.status, 'incubating');
  assert.equal(reflectionAgenda.intentIds.length, 0,
    'the reflection fact must not invent an executable world episode');

  console.log('character agenda application tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
