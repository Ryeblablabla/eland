import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-unified-decision-language-'));
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const intentBundlePath = path.join(temporaryDirectory, 'intent-execution.mjs');
const speechBundlePath = path.join(temporaryDirectory, 'live-speech.mjs');
const speechServiceBundlePath = path.join(temporaryDirectory, 'live-speech-service.mjs');
const compilationBundlePath = path.join(temporaryDirectory, 'compilation-continuation.mjs');
const directAttemptBundlePath = path.join(temporaryDirectory, 'direct-attempt.mjs');

const originalFetch = globalThis.fetch;
let expressionRequests = 0;
globalThis.fetch = async () => { expressionRequests++; throw new Error('This projection regression must never call a provider'); };

const mentalAct = (kind, utterance, delivery = 'normal') => ({
  version: 'mental-act-v2',
  kind,
  utterance,
  delivery,
  goal: '验证统一语言',
  strategy: '执行当前一步',
  assumptions: [],
  sourceEventIds: [],
});

try {
  for (const [entryPoint, outputPath] of [
    ['src/game/eland/simulation.ts', simulationBundlePath],
    ['src/game/eland/application/simulation/intent-execution.ts', intentBundlePath],
    ['src/game/eland/projection/live-speech.ts', speechBundlePath],
    ['server/live-speech-service.ts', speechServiceBundlePath],
    ['src/game/eland/application/simulation/compilation-continuation.ts', compilationBundlePath],
  ]) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entryPoint, '--bundle', '--platform=node', '--format=esm', `--outfile=${outputPath}`,
    ], { stdio: 'pipe' });
  }
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts', '--sourcefile=direct-attempt-test.ts',
    `--outfile=${directAttemptBundlePath}`, '--log-level=error',
  ], { input: `export { normalizeMindDeltaModelOutput, buildDecisionModelRequestProtocol } from './server/model-decision-gateway';
    export { buildDecisionRequestContext } from './src/game/eland/application/model-decision/decision-context';
    export { perceivedLanguageText } from './src/game/eland/domain/language-perception';
    export { authoredAttemptReturnsToMind } from './src/game/eland/domain/intent';
    export { appendCommittedEvents } from './src/game/eland/domain/history';
    export { Material } from './src/game/eland/domain/material';
    export { cellId, setVoxel } from './src/game/eland/world/grid';`, stdio: ['pipe', 'pipe', 'pipe'] });

  const simulation = await import(`${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`);
  const intentExecution = await import(`${pathToFileURL(intentBundlePath).href}?test=${Date.now()}`);
  const speechProjection = await import(`${pathToFileURL(speechBundlePath).href}?test=${Date.now()}`);
  const speechService = await import(`${pathToFileURL(speechServiceBundlePath).href}?test=${Date.now()}`);
  const compilationContinuation = await import(`${pathToFileURL(compilationBundlePath).href}?test=${Date.now()}`);
  const direct = await import(`${pathToFileURL(directAttemptBundlePath).href}?test=${Date.now()}`);

  const talkState = simulation.createInitialState(9017, {
    endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0,
  });
  const talkContext = simulation.buildDecisionContexts(talkState, 1)[0];
  assert(talkContext, 'fixture must expose a living speaker');
  const utterance = '这一次决定就是我发出的唯一一句话。';
  const talkEvents = [];
  const decisionFact = intentExecution.commitDecision(
    talkState,
    talkContext.person,
    talkContext,
    {
      kind: 'idle', nativeOperation: { kind: 'speech' }, reason: '验证',
      mentalAct: mentalAct('talk', utterance, 'call'),
    },
    true,
    1,
    talkEvents,
    1,
  );
  const actionFact = talkEvents[1];
  talkState.world.past.push(...talkEvents);
  assert.equal(actionFact?.kind, 'action');
  assert.equal(actionFact?.action.kind, 'talk');
  assert.equal(decisionFact.languageBroadcast?.text, utterance);
  assert.equal(actionFact.diff.languageSourceEventId, decisionFact.id,
    'social talk must reuse the DecisionFact language wave');
  assert.deepEqual(actionFact.diff.languageBroadcast, decisionFact.languageBroadcast);
  const talkLines = speechProjection.projectLiveSpeechDrafts(talkState, [decisionFact, actionFact]);
  assert.equal(talkLines.length, 1, 'a model talk decision must not render thought plus speech');
  assert.equal(talkLines[0].sourceEventId, actionFact.id);
  assert.equal(talkLines[0].modelText, utterance);
  assert.equal('mode' in talkLines[0], false);
  assert.equal(speechService.retainDecisionSpeechLines(talkLines)[0]?.text, utterance,
    'the expression layer must not paraphrase a language wave after propagation');
  const realizedTalk = await speechService.realizeLiveSpeechLines(
    talkState, [decisionFact, actionFact], talkLines,
  );
  assert.equal(realizedTalk.providerRequests, 0);
  assert.equal(realizedTalk.lines[0]?.text, utterance);

  const physicalState = simulation.createInitialState(9018, {
    endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0,
  });
  const physicalContext = simulation.buildDecisionContexts(physicalState, 1)
    .find((candidate) => candidate.options.some((option) => option.nextAction.kind !== 'talk'));
  assert(physicalContext, 'fixture must expose a physical option');
  const physicalOption = physicalContext.options.find((option) => option.nextAction.kind !== 'talk');
  assert(physicalOption);
  const physicalUtterance = `${'我要先把眼前这件事想清楚，'.repeat(10)}然后再动手。`;
  assert(physicalUtterance.length > 120 && physicalUtterance.length <= 180,
    'fixture must cross the former speech truncation boundary');
  const physicalEvents = [];
  const physicalDecision = intentExecution.commitDecision(
    physicalState,
    physicalContext.person,
    physicalContext,
    {
      kind: 'start', optionId: physicalOption.id, reason: '验证',
      mentalAct: mentalAct('pursue', physicalUtterance),
    },
    true,
    1,
    physicalEvents,
    1,
  );
  physicalState.world.past.push(...physicalEvents);
  const physicalSpeech = physicalEvents[1];
  assert.equal(physicalSpeech.intentId, undefined, 'the new-goal declaration is independent of its body intent');
  assert.equal(physicalState.memoryStore.items.some((item) => (
    item.ownerId === physicalContext.person.id
      && item.topicKeys.includes('language:decision')
      && item.sourceEventIds.includes(physicalDecision.id)
  )), false, 'a speaker must not remember their own non-talk MentalAct again as dialogue');
  const decisionOnly = speechProjection.projectLiveSpeechDrafts(physicalState, [physicalDecision]);
  assert.equal(decisionOnly[0]?.modelText, physicalUtterance);
  const physicalLines = speechProjection.projectLiveSpeechDrafts(physicalState, physicalEvents);
  assert.equal(physicalLines.length, 1, 'every model decision emits one spoken language line');
  assert.equal(physicalLines[0].sourceEventId, physicalSpeech.id);
  assert.equal(physicalLines[0].communicationKind, 'claim');
  assert.equal(physicalLines[0].modelText, physicalUtterance);
  assert.equal(speechService.retainDecisionSpeechLines(physicalLines)[0]?.text, physicalUtterance);
  const realizedPhysical = await speechService.realizeLiveSpeechLines(
    physicalState, physicalEvents, physicalLines,
  );
  assert.equal(realizedPhysical.providerRequests, 0);
  assert.equal(realizedPhysical.lines[0]?.text, physicalUtterance);

  const retainedWords = '我听见了，仍继续刚才的事。';
  const keepStart = physicalEvents.length;
  const retained = intentExecution.commitDecision(physicalState, physicalContext.person, physicalContext, {
    kind: 'idle', attention: 'keep-current', reason: '保留安排并发言', declaration: {
      utterance: retainedWords, delivery: 'normal', speechIntent: { kind: 'expression' }, sourceEventIds: [physicalDecision.id],
    },
  }, true, 1, physicalEvents, 2);
  const retainedAction = physicalEvents[keepStart + 1];
  physicalState.world.past.push(...physicalEvents.slice(keepStart));
  assert.equal(retained.decision.mentalAct, undefined);
  assert.equal(retainedAction.intentId, undefined);
  const retainedDrafts = speechProjection.projectLiveSpeechDrafts(physicalState, physicalEvents.slice(keepStart));
  assert.equal(retainedDrafts.length, 1, 'spoken keep shows its original wave once through the Action entry');
  assert.equal(retainedDrafts[0].modelText, retainedWords);
  assert.equal(retainedDrafts[0].sourceEventId, retainedAction.id);
  assert(retainedDrafts[0].sourceFactIds.includes(physicalDecision.id));
  assert.equal(speechProjection.projectLiveSpeechDrafts(physicalState, [retained])[0]?.modelText, retainedWords,
    'a Decision-only projection also understands the independent declaration');
  assert.equal(speechProjection.projectLiveSpeechDrafts(physicalState, [retainedAction])[0]?.modelText, retainedWords,
    'an Action-only projection resolves its already committed source declaration');
  const repeatedProjection = speechProjection.projectLiveSpeechDrafts(physicalState,
    [retained, retainedAction, { ...retainedAction, id: `${retainedAction.id}:copy` }]);
  assert.equal(repeatedProjection.length, 1, 'a repeated action reference cannot show the same source wave twice');
  const displayedKeep = await speechService.realizeLiveSpeechLines(physicalState, physicalEvents, retainedDrafts);
  assert.equal(displayedKeep.providerRequests, 0);
  assert.equal(displayedKeep.lines[0]?.text, retainedWords);
  assert.equal(displayedKeep.lines[0]?.source, 'decision-model');

  // WorldPlan may fail after Mind has already made a valid personal choice.
  // Preserve that choice and its one real declaration until the same Plan can
  // compile; never turn a translation error into a fictional body attempt.
  const pendingState = simulation.createInitialState(9019, {
    endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0,
  });
  const speaker = pendingState.people[0];
  speaker.knowledge = [];
  const pendingContext = simulation.buildDecisionContexts(pendingState, 1)
    .find((candidate) => candidate.person.id === speaker.id);
  const ration = speaker.inventory.find((stack) => stack.quantity > 0);
  const target = { kind: 'inventory-stack', personId: speaker.id, stackId: ration.id };
  const chosenWords = '我先看看自己手里的这份口粮，再决定怎么安排。';
  const chosenGoal = '确认本人持有的这份口粮';
  const chosenAttempt = '观察本人手里的这份口粮';
  const originalMind = {
    ...mentalAct('pursue', chosenWords), goal: chosenGoal, nextAttempt: chosenAttempt,
    attempt: { mode: 'observe', targets: [target] },
    orientation: 'inquiry', horizon: 'ongoing', strategy: chosenAttempt,
    plan: { version: 'mental-plan-translation-v1', disposition: 'uncompiled', steps: [chosenAttempt] },
  };
  const failure = { code: 'unknown-reference', fields: ['resolution.nativeOperation.targetHandle'],
    message: 'WorldPlan选择了本次步骤未点名的位置，身体操作尚未编译' };
  const pendingEvents = [];
  const pendingDecision = intentExecution.commitDecision(pendingState, speaker, pendingContext, {
    kind: 'idle', reason: failure.message, mentalAct: structuredClone(originalMind), compilationFailure: failure,
  }, true, 1, pendingEvents, 1);
  pendingState.world.past.push(...pendingEvents);
  assert.deepEqual(pendingDecision.decision.mentalAct, originalMind, 'translation failure preserves the original goal, nextAttempt and bound attempt');
  assert.equal(pendingDecision.executionCompilation.status, 'unresolved');
  assert.equal(pendingDecision.executionCompilation.operation, undefined, 'a missing translation has no invented native request');
  assert.deepEqual(pendingDecision.executionCompilation.problem, failure);
  assert.equal(pendingDecision.intentId, undefined);
  assert.equal(speaker.activeIntentId, undefined);
  assert.equal(pendingState.intents.length, 0, 'an uncompiled outline cannot create a placeholder body intent');
  assert.equal(pendingEvents.filter((event) => event.kind === 'action').length, 1);
  assert.equal(pendingEvents[1].action.kind, 'talk');
  assert.equal(pendingEvents[1].status, 'completed');
  assert.equal(pendingEvents[1].diff.languageSourceEventId, pendingDecision.id);
  const pendingSpeech = speechProjection.projectLiveSpeechDrafts(pendingState, pendingEvents);
  assert.equal(pendingSpeech.length, 1);
  assert.equal(pendingSpeech[0].modelText, chosenWords);

  const [continuation] = compilationContinuation.compilationContinuationContexts({
    state: pendingState, atMonth: 1, events: pendingEvents,
  }, 2, new Set(), new Set(), new Set());
  assert(continuation, 'the real unresolved outline can continue in the same month');
  assert.equal(continuation.continuingPlan.sourceDecisionEventId, pendingDecision.id);
  assert.equal(continuation.continuingPlan.compilationFailureEventId, pendingDecision.id);
  assert.equal(continuation.continuingPlan.sourceIntentId, undefined);
  assert.deepEqual(continuation.continuingPlan.mentalAct, originalMind);
  const continuationStart = pendingEvents.length;
  const compiledDecision = intentExecution.commitDecision(pendingState, speaker, continuation, {
    kind: 'idle', reason: chosenAttempt, nativeOperation: { kind: 'observe', target },
    mentalAct: { ...structuredClone(originalMind), plan: {
      version: 'mental-plan-translation-v1', disposition: 'act', steps: [chosenAttempt],
      currentStep: { kind: 'physical', description: chosenAttempt, targets: [target] },
    } },
  }, true, 1, pendingEvents, 2);
  pendingState.world.past.push(...pendingEvents.slice(continuationStart));
  assert.equal(compiledDecision.planContinuation.sourceDecisionEventId, pendingDecision.id);
  assert.equal(compiledDecision.languageBroadcast, undefined, 'continuation cannot broadcast the frozen Mind again');
  assert.equal(pendingEvents.length, continuationStart + 1, 'successful compilation adds only its DecisionFact before physical execution');
  const bodyIntent = pendingState.intents.find((intent) => intent.id === compiledDecision.intentId);
  assert(bodyIntent);
  assert.equal(bodyIntent.planSourceDecisionEventId, pendingDecision.id);
  const bodyAction = intentExecution.executeActiveIntent(pendingState, speaker, 1, pendingEvents.length, 2, pendingEvents);
  assert.equal(bodyAction?.kind, 'action');
  assert.equal(bodyAction.action.kind, 'attend');
  assert.equal(bodyAction.status, 'completed', bodyAction.result);
  assert.equal(bodyAction.intentId, bodyIntent.id);
  pendingEvents.push(bodyAction);
  pendingState.world.past.push(bodyAction);
  assert.equal(pendingEvents.filter((event) => event.kind === 'action' && event.action.kind === 'talk').length, 1);
  assert.equal(pendingEvents.filter((event) => event.kind === 'action' && event.action.kind !== 'talk').length, 1);
  assert(!pendingEvents.some((event) => event.kind === 'action' && ['blocked', 'failed'].includes(event.status)),
    'translation failure remains a Decision diagnostic, not a fake failed physical experience');
  const allPendingSpeech = speechProjection.projectLiveSpeechDrafts(pendingState, pendingEvents);
  assert.equal(allPendingSpeech.length, 1);
  assert.equal(allPendingSpeech[0].modelText, chosenWords);

  // The actor can choose the real atom directly, finish its physical prefix,
  // and choose another atom under the same goal without another WorldPlan.
  const directState = simulation.createInitialState(9020, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const chooser = directState.people[0];
  const directListener = directState.people[1];
  directState.people = [chooser, directListener];
  directState.world.animals = [];
  for (let x = 10; x <= 17; x += 1) for (let y = 10; y <= 15; y += 1) {
    for (let z = 0; z < directState.world.grid.levels; z += 1) direct.setVoxel(directState.world.grid, x, y, z,
      z === 0 ? direct.Material.Stone : direct.Material.Air);
  }
  chooser.position = { ...chooser.position, cellId: direct.cellId(12, 12), z: 1 };
  directListener.position = { ...directListener.position, cellId: direct.cellId(14, 11), z: 1 };
  directListener.body = { health: 100, hydration: 100, nutrition: 100 };
  directListener.conditions = [];
  chooser.body = { health: 100, hydration: 100, nutrition: 100 };
  chooser.conditions = [];
  chooser.knowledge = [];
  const selectedDropId = 'direct-selected-wood';
  directState.world.drops = [{ id: selectedDropId, materialId: direct.Material.Wood, quantity: 3,
    cellId: direct.cellId(15, 12), z: 1, createdAtMonth: 0, sourceEventIds: [] }];
  const directGoal = '取得并查看两份木料';
  const firstWords = '我要把眼前两份木料拿过来，再看看。';
  const nextWords = '接下来看看刚拿到的木料。';
  let stage = 0, worldPlanCalls = 0;
  let originId, retainedDirectChoice;
  const mindCalls = [];
  const declaration = (utterance) => ({ utterance, delivery: 'normal', speechIntent: { kind: 'expression' } });
  const afterDirect = await simulation.stepSimulationAsync(directState, {
    ownsVoluntarySocialChoices: true,
    async decideAll(contexts) {
      return contexts.map((context) => {
        const request = direct.buildDecisionRequestContext(context);
        const protocol = direct.buildDecisionModelRequestProtocol(request);
        const normalize = (input) => {
          const decision = direct.normalizeMindDeltaModelOutput(request, input, protocol);
          assert(decision, 'the authored direct attempt must normalize without provider execution');
          return decision;
        };
        if (context.person.id !== chooser.id) return normalize({});
        mindCalls.push({ tick: context.planningTick, reason: context.reconsideration?.reason });
        if (stage === 0) {
          stage = 1;
          const sourceHandle = protocol.handles.visible.find((ref) => ref.kind === 'drop' && ref.dropId === selectedDropId).handle;
          return normalize({ intentionChange: { goal: directGoal, orientation: 'acquisition', horizon: 'ongoing' },
            declaration: declaration(firstWords), attempt: { kind: 'native', nativeOperation: {
              kind: 'transfer', sourceHandle, destinationHandle: 'self', materialKey: 'wood', quantity: 2,
            } } });
        }
        const actualTaking = context.currentMonthEvents?.find((event) => event.kind === 'action' && event.who === chooser.id
          && event.action.kind === 'transfer' && event.action.dropId === selectedDropId && event.diff.quantity === 2);
        if (stage === 1 && actualTaking) {
          stage = 2;
          const origin = context.currentMonthEvents.find((event) => event.kind === 'decision' && event.decision.mentalAct?.goal === directGoal);
          originId = origin.id;
          assert.equal(request.currentIntention.sourceDecisionEventId, originId);
          const wood = request.person.inventory.find((stack) => stack.materialId === direct.Material.Wood && stack.quantity === 2);
          const targetHandle = protocol.handles.held.find((ref) => ref.stackId === wood.stackId).handle;
          const decision = normalize({ declaration: declaration(nextWords),
            attempt: { kind: 'native', nativeOperation: { kind: 'observe', targetHandle } } });
          assert.equal(decision.mentalAct, undefined, 'choosing the next atom does not manufacture another Mind goal');
          assert.equal(decision.authoredAttempt.intentionSourceDecisionEventId, originId);
          retainedDirectChoice = structuredClone(decision);
          return decision;
        }
        if (stage === 2 && context.currentMonthEvents?.some((event) => event.kind === 'action' && event.who === chooser.id
          && event.action.kind === 'attend' && event.status === 'completed')) {
          stage = 3;
          assert.equal(request.currentIntention.sourceDecisionEventId, originId);
          return normalize({ attempt: { kind: 'wait' } });
        }
        return normalize({});
      });
    },
    async continuePlans(contexts) {
      worldPlanCalls += contexts.length;
      return contexts.map(() => null);
    },
  });
  assert.equal(worldPlanCalls, 0, 'terminal directly authored atoms return to Mind, not WorldPlan continuation');
  assert.equal(stage, 3, 'Mind is called again after the real transfer and again after the next real observation');
  assert(mindCalls.some((call) => call.reason === 'experienced-outcome'));
  const authoredDecisions = afterDirect.world.past.filter((event) => event.kind === 'decision' && event.who === chooser.id && event.usedModel);
  const firstDirect = authoredDecisions.find((event) => event.decision.mentalAct?.goal === directGoal);
  assert.equal(authoredDecisions.filter((event) => event.decision.mentalAct?.goal === directGoal).length, 1);
  assert.equal(firstDirect.id, originId);
  const nextDirect = authoredDecisions.find((event) => event.decision.declaration?.utterance === nextWords);
  assert.equal(nextDirect.decision.mentalAct, undefined);
  assert.equal(nextDirect.decision.authoredAttempt.intentionSourceDecisionEventId, originId);
  assert.deepEqual(nextDirect.decision.authoredAttempt, retainedDirectChoice.authoredAttempt);
  assert(nextDirect.languageBroadcast.decodedByPersonIds.includes(directListener.id), 'the new declaration is actually heard');
  const receivedWords = direct.perceivedLanguageText({ broadcast: nextDirect.languageBroadcast,
    observerId: directListener.id, speakerId: chooser.id, seed: afterDirect.seed });
  assert(receivedWords);
  const heardNextWords = afterDirect.memoryStore.items.filter((memory) => memory.ownerId === directListener.id
    && memory.lane === 'dialogue' && memory.dialogueSpeakerId === chooser.id
    && memory.sourceEventIds.includes(nextDirect.id) && memory.exactUtterance === receivedWords);
  assert.equal(heardNextWords.length, 1, 'the common declaration enters the listener\'s exact received memory once, with its Decision source and actual propagation loss');
  const acquisitionActions = afterDirect.world.past.filter((event) => event.kind === 'action' && event.intentId === firstDirect.intentId);
  assert.equal(acquisitionActions[0].action.kind, 'move', 'a distant pickup begins with actual approach');
  assert.equal(acquisitionActions[0].diff.quantity, undefined, 'the approach receipt cannot claim material acquired');
  const actualTransfers = acquisitionActions.filter((event) => event.action.kind === 'transfer');
  assert.equal(actualTransfers.length, 1);
  assert.equal(actualTransfers[0].status, 'completed');
  assert.equal(actualTransfers[0].diff.quantity, 2);
  assert.equal(afterDirect.world.drops.find((drop) => drop.id === selectedDropId).quantity, 1);
  assert.equal(afterDirect.people[0].inventory.filter((stack) => stack.materialId === direct.Material.Wood)
    .reduce((quantity, stack) => quantity + stack.quantity, 0), 2);
  assert(afterDirect.world.past.some((event) => event.kind === 'action' && event.intentId === nextDirect.intentId && event.action.kind === 'attend'));
  const directTalks = afterDirect.world.past.filter((event) => event.kind === 'action' && event.who === chooser.id && event.action.kind === 'talk');
  assert.equal(directTalks.length, 2);
  assert.deepEqual(speechProjection.projectLiveSpeechDrafts(afterDirect, afterDirect.world.past).map((line) => line.modelText),
    [firstWords, nextWords], 'each new declaration is shown once and the old statement is never replayed');

  // A fresh creative translator supplies only the current operation or a
  // technical problem. Keeping a long-lived goal does not create a Plan loop.
  const creativeState = structuredClone(directState);
  const creativeGoal = '取得木料并查看取材后的变化';
  let creativeStage = 0, creativeMindCalls = 0, creativePlanCalls = 0, creativeOrigin;
  const creativeFailureText = '当前试法还缺少可执行的物理参数';
  const afterCreative = await simulation.stepSimulationAsync(creativeState, {
    ownsVoluntarySocialChoices: true,
    async decideAll(contexts) {
      return contexts.map((context) => {
        if (context.person.id !== chooser.id) return { kind: 'idle', attention: 'keep-current', reason: '保留安排' };
        creativeMindCalls++;
        const request = direct.buildDecisionRequestContext(context);
        if (creativeStage === 0) {
          creativeStage = 1;
          return { kind: 'idle', reason: '尝试取两份木料', authoredAttempt: { kind: 'creative' },
            mentalAct: { ...mentalAct('pursue', '我先取些木料，再看变化。'), goal: creativeGoal, horizon: 'ongoing', orientation: 'inquiry' },
            nativeOperation: { kind: 'transfer', source: { kind: 'drop', dropId: selectedDropId },
              destination: { kind: 'person', personId: chooser.id }, materialId: direct.Material.Wood, quantity: 2 } };
        }
        creativeOrigin = request.currentIntention.sourceDecisionEventId;
        assert.equal(request.currentIntention.mentalAct.goal, creativeGoal);
        const authoredAttempt = { kind: 'creative', intentionSourceDecisionEventId: creativeOrigin };
        if (creativeStage === 1) {
          const taking = context.currentMonthEvents.find((event) => event.kind === 'action' && event.who === chooser.id
            && event.action.kind === 'transfer' && event.diff.quantity === 2);
          assert(taking, 'creative pickup preparation moves cannot end the attempt or request another Mind');
          assert(request.recentCompletedWork.some((work) => !work.plan
            && work.recentOutcomes.some((receipt) => receipt.sourceEventId === taking.id && receipt.actualResult)));
          creativeStage = 2;
          return { kind: 'idle', reason: '当前试法尚未落实', authoredAttempt,
            declaration: { ...declaration('我再看一眼剩下的木料。'), sourceEventIds: [] },
            compilationFailure: { code: 'missing-evidence', message: creativeFailureText, fields: ['world-attempt'] } };
        }
        if (creativeStage === 2) {
          assert.equal(context.reconsideration.reason, 'compilation-feedback');
          const failure = context.currentMonthEvents.find((event) => event.kind === 'decision'
            && event.executionCompilation?.problem?.message === creativeFailureText);
          assert(failure && !failure.intentId && !failure.decision.mentalAct && !failure.decision.authoredAttempt.plan);
          assert(context.reconsideration.sourceEventIds.includes(failure.id));
          creativeStage = 3;
          return { kind: 'idle', reason: '观察剩余木料', authoredAttempt,
            nativeOperation: { kind: 'observe', target: { kind: 'drop', dropId: selectedDropId } } };
        }
        assert.equal(creativeStage, 3, 'each terminal or technical problem is offered to Mind once');
        const observation = context.currentMonthEvents.find((event) => event.kind === 'action' && event.who === chooser.id
          && event.action.kind === 'attend' && event.status === 'completed');
        assert(observation);
        assert(request.recentCompletedWork.some((work) => !work.plan
          && work.recentOutcomes.some((receipt) => receipt.sourceEventId === observation.id && receipt.actualResult)));
        creativeStage = 4;
        return { kind: 'idle', reason: '保留目标，暂时等待', authoredAttempt: { kind: 'wait', intentionSourceDecisionEventId: creativeOrigin } };
      });
    },
    async continuePlans(contexts) { creativePlanCalls += contexts.length; return contexts.map(() => null); },
  });
  assert.equal(creativeStage, 4);
  assert.equal(creativeMindCalls, 4);
  assert.equal(creativePlanCalls, 0, 'planless creative outcomes and failures return to Mind instead of automatic WorldPlan');
  const creativeDecisions = afterCreative.world.past.filter((event) => event.kind === 'decision' && event.who === chooser.id && event.usedModel);
  assert.equal(creativeDecisions.filter((event) => event.decision.mentalAct).length, 1);
  assert(creativeDecisions.every((event) => !event.decision.mentalAct?.plan && !event.decision.authoredAttempt?.plan));
  assert(afterCreative.intents.filter((intent) => intent.ownerId === chooser.id && intent.planSourceDecisionEventId === creativeOrigin)
    .every((intent) => !intent.plan));
  assert(!JSON.stringify(afterCreative.people.find((person) => person.id === chooser.id).knowledge).includes(creativeFailureText));
  assert(!JSON.stringify(afterCreative.people.find((person) => person.id === chooser.id).memories).includes(creativeFailureText));
  assert.equal(afterCreative.world.past.filter((event) => event.kind === 'action' && event.who === chooser.id
    && event.action.kind === 'talk' && event.action.speakerMeaning.summary === '我再看一眼剩下的木料。').length, 1);

  // Injury and receipt of food are neutral facts offered to the affected
  // person's own Mind. Their model-authored interpretation changes no scores.
  const encounterState = structuredClone(directState);
  const [giver, receiver] = encounterState.people;
  receiver.position = { ...receiver.position, cellId: giver.position.cellId, z: giver.position.z };
  const encounterRelations = structuredClone(encounterState.people.map((person) => person.relations));
  let givenStage = 0;
  const reviewedEncounters = new Map();
  const afterEncounter = await simulation.stepSimulationAsync(encounterState, {
    ownsVoluntarySocialChoices: true,
    async decideAll(contexts) {
      return contexts.map((context) => {
        if (context.person.id === giver.id) {
          if (givenStage === 0) {
            givenStage = 1;
            return { kind: 'idle', reason: '这一次施力', authoredAttempt: { kind: 'native' },
              nativeOperation: { kind: 'act', operation: 'exert', targets: [{ kind: 'person', personId: receiver.id }] } };
          }
          const injury = context.currentMonthEvents?.find((event) => event.kind === 'action' && event.diff.victimId === receiver.id);
          if (givenStage === 1 && injury) {
            givenStage = 2;
            const food = context.person.inventory.find((stack) => stack.materialId === direct.Material.Food && stack.quantity > 0);
            return { kind: 'idle', reason: '转交一份食物', authoredAttempt: { kind: 'native' },
              nativeOperation: { kind: 'transfer', source: { kind: 'inventory-stack', personId: giver.id, stackId: food.id },
                destination: { kind: 'person', personId: receiver.id }, materialId: direct.Material.Food, quantity: 1 } };
          }
          return { kind: 'idle', attention: 'keep-current', reason: '保持当前安排' };
        }
        const encounter = context.currentMonthEvents?.find((event) => event.kind === 'action' && event.who === giver.id
          && context.reconsideration?.sourceEventIds.includes(event.id)
          && (event.diff.victimId === receiver.id || event.action.kind === 'transfer' && event.diff.quantity === 1));
        if (!encounter) return { kind: 'idle', attention: 'keep-current', reason: '保持当前安排' };
        assert.equal(context.reconsideration.reason, 'experienced-outcome');
        assert.equal(reviewedEncounters.has(encounter.id), false, 'each perceived physical encounter earns one independent review');
        reviewedEncounters.set(encounter.id, encounter.action.kind);
        assert.deepEqual(context.state.people.map((person) => person.relations), encounterRelations,
          'neither attack, transfer nor an earlier narrative appraisal adds automatic relationship scores');
        assert(context.person.memories.some((memory) => memory.sourceEventIds.includes(encounter.id)
          && memory.personIds.includes(giver.id)));
        const hurt = encounter.diff.victimId === receiver.id;
        return { kind: 'idle', attention: 'keep-current', reason: '本人解释刚才的遭遇', declaration: {
          utterance: hurt ? '你刚才伤到了我。' : '食物收到了，但我还在想你刚才的举动。',
          delivery: 'normal', speechIntent: { kind: 'expression' }, sourceEventIds: [encounter.id],
          relationshipAppraisal: { version: 'mental-relationship-appraisal-v1', otherPersonId: giver.id,
            sourceEventIds: [encounter.id], meanings: hurt ? ['hurt'] : ['uncertainty'],
            interpretation: hurt ? '我确实受伤了，还不清楚对方为什么这样做。' : '收到食物不等于我已经认可此前的伤害。' },
        } };
      });
    },
    async continuePlans(contexts) { return contexts.map(() => null); },
  });
  assert.equal(reviewedEncounters.size, 2, 'both the victim and the later recipient receive their own review');
  const affected = afterEncounter.people.find((person) => person.id === receiver.id);
  assert.equal(affected.relationshipEpisodes.length, 2);
  assert.deepEqual(affected.relationshipEpisodes.map((episode) => episode.appraisal.meanings), [['hurt'], ['uncertainty']]);
  assert(affected.relationshipEpisodes.every((episode) => episode.observerId === receiver.id
    && episode.otherPersonId === giver.id && reviewedEncounters.has(episode.sourceFactIds[0])));
  assert.equal(afterEncounter.people.find((person) => person.id === giver.id).relationshipEpisodes?.length ?? 0, 0,
    'the receiver\'s appraisal never creates a reciprocal feeling in the giver');

  // One reusable episode can change operation author. A WorldPlan repair
  // must not inherit the prior directly chosen atom's return-to-Mind marker.
  const reuseState = simulation.createInitialState(9022, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const reuseActor = reuseState.people[0];
  reuseActor.knowledge = [];
  const reuseEvents = [];
  const reuseContext = () => ({ ...simulation.buildDecisionContexts(reuseState, 1).find((context) => context.person.id === reuseActor.id),
    options: [], followUpOptions: [], currentMonthEvents: reuseEvents });
  const reuseTarget = { kind: 'inventory-stack', personId: reuseActor.id, stackId: reuseActor.inventory[0].id };
  const reuseOperation = { kind: 'observe', target: reuseTarget };
  const reuseMind = { ...mentalAct('pursue', '我先了解这份材料。'), goal: '了解这份材料',
    plan: { version: 'mental-plan-translation-v1', disposition: 'act', steps: ['观察本人持物'] } };
  const creativeStart = intentExecution.commitDecision(reuseState, reuseActor, reuseContext(), {
    kind: 'idle', reason: '观察本人持物', mentalAct: reuseMind, authoredAttempt: { kind: 'creative' }, nativeOperation: reuseOperation,
  }, true, 1, reuseEvents, 1);
  const directReuse = intentExecution.commitDecision(reuseState, reuseActor, reuseContext(), {
    kind: 'idle', reason: '亲自观察同一份物品', nativeOperation: reuseOperation,
    authoredAttempt: { kind: 'native', intentionSourceDecisionEventId: creativeStart.id },
  }, true, 1, reuseEvents, 2);
  assert.equal(directReuse.intentId, creativeStart.intentId);
  const reusedIntent = reuseState.intents.find((intent) => intent.id === directReuse.intentId);
  assert.equal(reusedIntent.operationAuthorship, 'mind');
  const historicalDirectDecision = structuredClone(directReuse);
  const newCreativeMind = { ...mentalAct('pursue', '我想确认这份材料的用途。'), goal: '确认这份材料的用途',
    plan: { version: 'mental-plan-translation-v1', disposition: 'uncompiled', steps: ['检查同一份材料'] } };
  const newCreativeFailure = intentExecution.commitDecision(reuseState, reuseActor, reuseContext(), {
    kind: 'idle', reason: '当前步骤仍需翻译', mentalAct: newCreativeMind, authoredAttempt: { kind: 'creative' },
    compilationFailure: { code: 'missing-evidence', message: '当前步骤仍需翻译', fields: ['world-plan'] },
  }, true, 1, reuseEvents, 3);
  const repairedPlan = { ...newCreativeMind.plan, disposition: 'act' };
  const worldReuse = intentExecution.commitDecision(reuseState, reuseActor, { ...reuseContext(), continuingPlan: {
    sourceIntentId: reusedIntent.id, compilationFailureEventId: newCreativeFailure.id,
    sourceDecisionEventId: newCreativeFailure.id, mentalAct: newCreativeMind,
    plan: newCreativeMind.plan, outcomeReceipts: [],
  } }, { kind: 'idle', reason: '检查同一份材料', nativeOperation: reuseOperation,
    mentalAct: { ...newCreativeMind, plan: repairedPlan } }, true, 1, reuseEvents, 4);
  assert.equal(worldReuse.intentId, reusedIntent.id, 'WorldPlan must actually reuse the previously Mind-authored episode');
  assert.equal(reusedIntent.operationAuthorship, undefined, 'WorldPlan takeover clears the prior atom author');
  assert.equal(reusedIntent.sourceDecisionEventId, worldReuse.id, 'the current operation belongs to this actual WorldPlan compilation');
  assert.equal(reusedIntent.planSourceDecisionEventId, newCreativeFailure.id);
  assert.equal(worldReuse.planContinuation.sourceDecisionEventId, newCreativeFailure.id);
  assert.deepEqual(reusedIntent.plan, repairedPlan);
  const reusedAction = intentExecution.executeActiveIntent(reuseState, reuseActor, 1, reuseEvents.length, 5, reuseEvents);
  assert.equal(reusedAction.action.kind, 'attend');
  assert.equal(reusedAction.status, 'completed');
  assert.equal(reusedIntent.status, 'completed');
  const currentOperationOrigin = reuseEvents.find((event) => event.id === reusedIntent.sourceDecisionEventId);
  assert.equal(currentOperationOrigin.id, worldReuse.id);
  assert.equal(direct.authoredAttemptReturnsToMind(currentOperationOrigin.decision), false,
    'the terminal routing fallback reads the current WorldPlan decision, not the old native decision');
  assert.equal(reusedIntent.operationAuthorship === 'mind'
    || direct.authoredAttemptReturnsToMind(currentOperationOrigin.decision), false,
  'neither directAttemptReviewInputs authorship branch may route this terminal episode to Mind');
  assert.deepEqual(directReuse, historicalDirectDecision, 'changing the current author never rewrites earlier decision evidence');
  const nextNative = intentExecution.commitDecision(reuseState, reuseActor, reuseContext(), {
    kind: 'idle', reason: '继续检查同一份材料', nativeOperation: reuseOperation,
    authoredAttempt: { kind: 'native', intentionSourceDecisionEventId: newCreativeFailure.id },
  }, true, 1, reuseEvents, 6);
  const planlessCreative = intentExecution.commitDecision(reuseState, reuseActor, reuseContext(), {
    kind: 'idle', reason: '本次创造尝试只观察同一份材料', nativeOperation: reuseOperation,
    authoredAttempt: { kind: 'creative', intentionSourceDecisionEventId: newCreativeFailure.id },
  }, true, 1, reuseEvents, 7);
  assert.equal(planlessCreative.intentId, nextNative.intentId);
  const currentCreativeIntent = reuseState.intents.find((intent) => intent.id === planlessCreative.intentId);
  assert.equal(currentCreativeIntent.sourceDecisionEventId, planlessCreative.id);
  assert.equal(currentCreativeIntent.planSourceDecisionEventId, newCreativeFailure.id);
  assert.equal(currentCreativeIntent.operationAuthorship, undefined);
  assert.equal(currentCreativeIntent.plan, undefined);
  assert(direct.authoredAttemptReturnsToMind(planlessCreative.decision));

  // This reference is genuinely visible and its wire form is legal, but the
  // explicit water voxel is not a standing pose. Preserve the choice without
  // inventing either a successful walk or a failed physical collision.
  const noRouteState = simulation.createInitialState(9021, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const noRouteActor = noRouteState.people[0];
  for (let x = 10; x <= 16; x += 1) for (let y = 10; y <= 15; y += 1) {
    for (let z = 0; z < noRouteState.world.grid.levels; z += 1) direct.setVoxel(noRouteState.world.grid, x, y, z,
      z === 0 ? direct.Material.Stone : direct.Material.Air);
  }
  noRouteActor.position = { ...noRouteActor.position, cellId: direct.cellId(12, 12), z: 1 };
  direct.setVoxel(noRouteState.world.grid, 13, 12, 1, direct.Material.Water);
  const noRouteContext = simulation.buildDecisionContexts(noRouteState, 1).find((context) => context.person.id === noRouteActor.id);
  const noRouteRequest = direct.buildDecisionRequestContext(noRouteContext);
  const noRouteProtocol = direct.buildDecisionModelRequestProtocol(noRouteRequest);
  const onlyGoal = '弄清这片浅水的情况';
  const goalWithoutAttempt = direct.normalizeMindDeltaModelOutput(noRouteRequest, {
    intentionChange: { goal: onlyGoal, orientation: 'inquiry', horizon: 'ongoing' },
    declaration: declaration('我想弄清这片浅水的情况。'),
  }, noRouteProtocol);
  assert.equal(goalWithoutAttempt?.mentalAct?.goal, onlyGoal);
  assert.equal(goalWithoutAttempt.nativeOperation, undefined);
  assert.equal(goalWithoutAttempt.executionProbe, undefined);
  assert.equal(goalWithoutAttempt.authoredAttempt, undefined);
  assert.equal(goalWithoutAttempt.mentalAct.plan, undefined, 'a new goal without an attempt creates no default native, creative, wait or WorldPlan step');
  const water = noRouteProtocol.handles.voxels.find((ref) => ref.position.x === 13 && ref.position.y === 12 && ref.position.z === 1);
  assert(water, 'the fixture must expose the actual nearby water voxel');
  const noRouteGoal = '确认眼前浅水能否直接行走';
  const noRouteWords = '我试着走到眼前这片浅水的位置。';
  const noRouteChoice = direct.normalizeMindDeltaModelOutput(noRouteRequest, {
    intentionChange: { goal: noRouteGoal, orientation: 'exploration', horizon: 'ongoing' },
    declaration: declaration(noRouteWords), attempt: { kind: 'native', nativeOperation: {
      kind: 'walk-to', targetHandle: water.handle, withinDistance: 0,
    } },
  }, noRouteProtocol);
  assert(noRouteChoice?.nativeOperation);
  const selectedOperation = structuredClone(noRouteChoice.nativeOperation);
  const noRouteEvents = [];
  const noRouteDecision = intentExecution.commitDecision(noRouteState, noRouteActor, noRouteContext, noRouteChoice,
    true, 1, noRouteEvents, 1);
  assert.equal(noRouteDecision.executionCompilation.status, 'unresolved');
  assert.deepEqual(noRouteDecision.executionCompilation.operation, selectedOperation);
  assert.equal(noRouteDecision.decision.mentalAct.goal, noRouteGoal);
  assert.equal(noRouteDecision.decision.authoredAttempt.kind, 'native');
  assert.equal(noRouteState.intents.length, 0);
  assert.equal(noRouteEvents.filter((event) => event.kind === 'action').length, 1);
  assert.equal(noRouteEvents[1].action.kind, 'talk');
  assert.equal(noRouteEvents[1].status, 'completed');
  assert.equal(noRouteDecision.languageBroadcast.text, noRouteWords);
  assert.equal(noRouteActor.position.cellId, direct.cellId(12, 12));
  const privateState = simulation.createInitialState(17, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const privateContext = simulation.buildDecisionContexts(privateState, 1)[0];
  const privateRequest = direct.buildDecisionRequestContext(privateContext);
  const privateProtocol = direct.buildDecisionModelRequestProtocol(privateRequest, { characterAgendaProposal: true });
  const privateGoal = '私下比较眼前材料可以排成哪些形状';
  const privateChoice = direct.normalizeMindDeltaModelOutput(privateRequest, {
    intentionChange: { goal: privateGoal, orientation: 'inquiry', horizon: 'ongoing' },
    attempt: { kind: 'continue' },
  }, privateProtocol);
  assert.equal(privateChoice.mentalAct.utterance, '');
  assert.equal(privateChoice.declaration, undefined);
  assert.equal(privateChoice.nativeOperation, undefined);
  const privateEvents = [];
  const privateFact = intentExecution.commitDecision(privateState, privateContext.person, privateContext, privateChoice,
    true, 1, privateEvents, 1);
  direct.appendCommittedEvents(privateState, privateEvents);
  assert.equal(privateEvents.length, 1, 'a silent goal produces only the real Decision, no talk Action');
  assert.equal(privateFact.decision.mentalAct.goal, privateGoal);
  assert.equal(privateFact.languageBroadcast, undefined);
  assert(privateContext.person.characterAgenda.items.some((item) => item.aim === privateGoal), 'an ongoing private purpose is retained');
  assert.equal(privateState.memoryStore.items.some((memory) => ['dialogue', 'exactDialogue'].includes(memory.lane)
    && memory.sourceEventIds.includes(privateFact.id)), false, 'a private goal cannot become heard-word memory');
  assert.deepEqual(speechProjection.projectLiveSpeechDrafts(privateState, privateEvents), []);
  const afterPrivateContext = simulation.buildDecisionContexts(privateState, 1).find((context) => context.person.id === privateContext.person.id);
  const afterPrivateRequest = direct.buildDecisionRequestContext(afterPrivateContext);
  const afterPrivateProtocol = direct.buildDecisionModelRequestProtocol(afterPrivateRequest);
  assert.equal(afterPrivateRequest.currentIntention.mentalAct.goal, privateGoal);
  const privateAttempt = direct.normalizeMindDeltaModelOutput(afterPrivateRequest, {
    intentionChange: { goal: '再私下检查自己目前的状态', orientation: 'inquiry', horizon: 'momentary' },
    attempt: { kind: 'native', nativeOperation: { kind: 'observe', targetHandle: 'self' } },
  }, afterPrivateProtocol);
  assert.equal(privateAttempt.mentalAct.utterance, '');
  assert.equal(privateAttempt.nativeOperation.kind, 'observe');
  const selectedEvents = [];
  const selectedFact = intentExecution.commitDecision(privateState, privateContext.person, afterPrivateContext, privateAttempt,
    true, 1, selectedEvents, 2);
  direct.appendCommittedEvents(privateState, selectedEvents);
  const selectedIntent = privateState.intents.find((intent) => intent.id === selectedFact.intentId);
  assert(selectedIntent?.status === 'active');
  const activePrivateContext = simulation.buildDecisionContexts(privateState, 1).find((context) => context.person.id === privateContext.person.id);
  const activePrivateRequest = direct.buildDecisionRequestContext(activePrivateContext);
  const activePrivateProtocol = direct.buildDecisionModelRequestProtocol(activePrivateRequest);
  const beforeContinue = structuredClone(selectedIntent);
  const continueChoice = direct.normalizeMindDeltaModelOutput(activePrivateRequest, { attempt: { kind: 'continue' } }, activePrivateProtocol);
  assert.equal(continueChoice.attention, 'keep-current');
  assert.equal(continueChoice.authoredAttempt, undefined);
  const continueEvents = [];
  intentExecution.commitDecision(privateState, privateContext.person, activePrivateContext, continueChoice,
    true, 1, continueEvents, 3);
  direct.appendCommittedEvents(privateState, continueEvents);
  assert.deepEqual(selectedIntent, beforeContinue, 'continue preserves the same body operation and its original source');
  assert.equal(privateContext.person.activeIntentId, selectedIntent.id);
  assert.equal(continueEvents.length, 1);
  assert.equal(continueEvents[0].languageBroadcast, undefined);
  const waitChoice = direct.normalizeMindDeltaModelOutput(activePrivateRequest, { attempt: { kind: 'wait' } }, activePrivateProtocol);
  assert.equal(waitChoice.kind, 'suspend');
  const waitEvents = [];
  intentExecution.commitDecision(privateState, privateContext.person, activePrivateContext, waitChoice,
    true, 1, waitEvents, 4);
  direct.appendCommittedEvents(privateState, waitEvents);
  assert.equal(selectedIntent.status, 'suspended', 'wait explicitly stops the currently selected body operation');
  assert.equal(privateContext.person.activeIntentId, undefined);
  assert.equal(waitEvents.length, 1);
  assert.equal(waitEvents[0].languageBroadcast, undefined);
  const spokenLater = '我现在想把这件事说出来。';
  const speechChoice = direct.normalizeMindDeltaModelOutput(afterPrivateRequest,
    { declaration: declaration(spokenLater), attempt: { kind: 'continue' } }, afterPrivateProtocol);
  const laterEvents = [];
  const laterFact = intentExecution.commitDecision(privateState, privateContext.person, afterPrivateContext, speechChoice,
    true, 1, laterEvents, 5);
  assert.equal(laterFact.languageBroadcast.text, spokenLater, 'speech remains an independent deliberate choice after a private goal');
  assert.equal(laterFact.decision.mentalAct, undefined);
  assert.equal(laterEvents.filter((event) => event.kind === 'action' && event.action.kind === 'talk').length, 1);
  assert.equal(expressionRequests, 0, 'authored native declarations never enter the speech-generation fallback');
  console.log('unified decision language tests passed');
} finally {
  globalThis.fetch = originalFetch;
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
