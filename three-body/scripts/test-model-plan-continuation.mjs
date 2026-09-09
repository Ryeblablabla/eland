import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = mkdtempSync(path.join(tmpdir(), 'eland-semantic-plan-'));
const originalFetch = globalThis.fetch;
const originalConfig = process.env.THREEBODY_MODEL_CONFIG;
const originalEnvFile = process.env.THREEBODY_ENV_FILE;
const originalDecisionTimeout = process.env.MODEL_DECISION_TIMEOUT_MS;
const originalSignalTimeout = AbortSignal.timeout;
const requestTimeouts = [];
try {
  const emptyEnv = path.join(temporary, 'empty.env');
  writeFileSync(emptyEnv, ''); process.env.THREEBODY_ENV_FILE = emptyEnv;
  delete process.env.MODEL_DECISION_TIMEOUT_MS;
  AbortSignal.timeout = (milliseconds) => {
    requestTimeouts.push(milliseconds); return originalSignalTimeout.call(AbortSignal, milliseconds);
  };
  const bundle = path.join(temporary, 'test.mjs');
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=semantic-plan-test.ts', `--outfile=${bundle}`, '--log-level=error',
  ], { input: `export { createServerLlmDecider } from './server/backend-decider';
    export { expandModelSchemaGuide } from './server/model-schema-guide';
    export { compileNativeOperation } from './src/game/eland/application/native-operation';
    export { executePrimitiveAction } from './src/game/eland/domain/action-executor';
    export { createInitialState, buildDecisionContexts, stepSimulationAsync } from './src/game/eland/simulation';
    export { buildDecisionRequestContext } from './src/game/eland/application/model-decision/decision-context';
    export { buildDecisionModelRequestProtocol } from './server/model-decision-gateway';
    export { applyDecision, commitDecision, executeActiveIntent } from './src/game/eland/application/simulation/intent-execution';`,
    stdio: ['pipe', 'pipe', 'pipe'] });
  const config = path.join(temporary, 'model.json');
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, endpoints: {
    cloud: { protocol: 'openai-chat', url: 'https://cloud.invalid/v1/chat/completions', model: 'fixture', auth: 'none', structuredOutput: 'prompt', timeoutMs: 65_000 },
    ollama: { protocol: 'ollama-chat', url: 'http://ollama.invalid/api/chat', model: 'fixture', auth: 'none', structuredOutput: 'native-json', timeoutMs: 120_000 },
  }, routes: { decision: 'ollama' } }));
  process.env.THREEBODY_MODEL_CONFIG = config;
  const api = await import(pathToFileURL(bundle).href);
  const state = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  const contexts = api.buildDecisionContexts(state, 1).slice(0, 2);
  const mind = { utterance: '我先看看自己的身体状态。', goal: '了解自己的状态',
    nextAttempt: '先查看自己的身体状态，再按结果决定之后的事。',
    delivery: 'normal', orientation: 'inquiry', horizon: 'momentary', speechIntent: { kind: 'expression' } };
  const plan = { disposition: 'act', steps: ['查看本人的身体状态'],
    completion: { step: { description: '完成这次查看', conditions: [] }, goal: { description: '了解自己的状态', conditions: [] } },
    currentStep: { kind: 'physical', description: '查看本人的身体状态', targetHandles: ['self'] } };
  let stages = []; let active = 0; let peak = 0; let retain = false;
  let retainedDeclaration;
  let correctEffectsOnce = false; let invalidCompilationSent = false; let alwaysInvalidCompilation = false;
  globalThis.fetch = async (url, init) => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    const body = JSON.parse(init.body);
    const contextMessage = body.messages.find((message) => message.role === 'user' && message.content.trimStart().startsWith('{'));
    const request = JSON.parse(contextMessage.content);
    const stage = request.schemaVersion === 'world-plan-context-v1' ? 'world-plan' : 'mind';
    stages.push(stage);
    if (new URL(url).hostname === 'ollama.invalid') {
      assert(body.format && typeof body.format === 'object');
      const guideIndex = body.messages.findIndex((message) => message.content.startsWith('输出格式说明。'));
      assert(guideIndex >= 0 && guideIndex < body.messages.indexOf(contextMessage),
        'the reading guide precedes the actual scene; machine format remains a full schema');
    }
    if (stage === 'world-plan') {
      assert.equal(request.intention.nextAttempt, mind.nextAttempt);
      assert.equal(request.intention.goal, mind.goal);
      assert.equal(request.declaration.utterance, mind.utterance);
      assert.deepEqual(request.declaration.speechIntent, mind.speechIntent);
      assert(request.actor && request.situation, 'WorldPlan needs the actual actor and physical time scale');
      assert.equal(request.availableSteps, undefined);
      assert.equal(request.worldAction, undefined, 'there is no separately rewritten Plan step in the input');
      assert(Array.isArray(request.nativeOperations) && Array.isArray(request.materialCatalog));
      assert(request.nativeOperations.every((operation) => !('optionId' in operation)));
    }
    let value = stage === 'mind' ? retain ? retainedDeclaration ? { declaration: retainedDeclaration } : {}
      : { intentionChange: { goal: mind.goal, nextAttempt: mind.nextAttempt, attemptMode: 'observe', attemptTargetHandles: ['self'], orientation: mind.orientation, horizon: mind.horizon },
        declaration: { utterance: mind.utterance, delivery: mind.delivery, speechIntent: mind.speechIntent } }
      : { plan, resolution: { nativeOperation: { kind: 'observe', targetHandle: 'self' } } };
    if (stage === 'world-plan' && correctEffectsOnce) {
      if (!invalidCompilationSent) { value = { plan }; invalidCompilationSent = true; }
      else {
        assert(body.messages.some((message) => message.role === 'user' && message.content.includes('上一个 WorldPlan 输出无法绑定')));
        value = { plan: { ...plan, completion: { ...plan.completion, goal: {
          description: '站在本人位置就算完成理解', conditions: [{ kind: 'near-target', targetHandle: 'self', maxDistance: 0 }],
        } } }, resolution: {
          effects: [{ kind: 'knowledge', summary: '本人查看了当前身体状态' }], status: 'completed', result: '本人查看了当前身体状态',
          completionReview: { step: { sufficiency: 'unverified', reason: '步骤没有明确判据' },
            goal: { sufficiency: 'insufficient', reason: '位置关系不能证明理解了身体状态' } },
        } };
      }
    }
    if (stage === 'world-plan' && alwaysInvalidCompilation) value = { invalidEnvelope: true };
    active--;
    return new Response(JSON.stringify(new URL(url).hostname === 'ollama.invalid'
      ? { message: { content: JSON.stringify(value) }, prompt_eval_count: 11, eval_count: 7 }
      : { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  };
  for (const endpoint of ['ollama', 'cloud']) {
    stages = []; peak = 0; requestTimeouts.length = 0;
    if (endpoint === 'cloud') process.env.MODEL_DECISION_TIMEOUT_MS = '85000';
    const decider = api.createServerLlmDecider(endpoint);
    const decisions = await decider.decideAll(contexts);
    assert(decisions.every((decision) => decision?.nativeOperation?.kind === 'observe'), JSON.stringify(decider.takeDiagnostics()));
    assert(decisions.every((decision) => decision.mentalAct.nextAttempt === mind.nextAttempt));
    decisions.forEach((decision, index) => {
      assert.deepEqual(decision.mentalAct.attempt, { mode: 'observe', targets: [{ kind: 'person', personId: contexts[index].person.id }] });
      assert.equal(decision.nativeOperation.perceptionOnly, true, 'the kernel receives a server-owned perception-only restriction');
    });
    assert.equal(stages.filter((stage) => stage === 'mind').length, 2);
    assert.equal(stages.filter((stage) => stage === 'world-plan').length, 2);
    assert.equal(peak, endpoint === 'ollama' ? 1 : 2);
    assert.deepEqual(requestTimeouts, Array(4).fill(endpoint === 'ollama' ? 120_000 : 85_000));
    assert.equal(decider.takeMetadata().providerRequests, 4);
    assert.deepEqual(decider.takeUsage(), { inputTokens: 44, outputTokens: 28 });
    if (endpoint === 'ollama') {
      const context = contexts[0];
      const decisionFact = api.applyDecision(state, context.person, context, decisions[0], true, 1, 0, 1);
      state.world.past.push(decisionFact);
      const executed = api.executeActiveIntent(state, context.person, 1, 1, 1, [decisionFact]);
      assert.equal(executed?.action.kind, 'attend', JSON.stringify(executed));
      assert.equal(executed.status, 'completed');
      state.world.past.push(executed);
      const afterAction = api.buildDecisionRequestContext(api.buildDecisionContexts(state, 1)[0]);
      assert.equal(afterAction.recentCompletedWork[0].recentOutcomes.at(-1).actualResult, executed.result,
        'the next Mind must receive the actual action result, not only a completed label beside the larger plan');
    }
  }
  delete process.env.MODEL_DECISION_TIMEOUT_MS;
  const continuingContext = { ...contexts[1], continuingPlan: {
    sourceIntentId: 'previous-intent', sourceDecisionEventId: 'previous-mind',
    mentalAct: { ...mind, version: 'mental-act-v2', kind: 'investigate', strategy: '观察', assumptions: [], sourceEventIds: [], plan },
    plan, outcomeReceipts: [],
  } };
  stages = [];
  const continuation = api.createServerLlmDecider('ollama');
  const continued = await continuation.continuePlans([continuingContext]);
  assert.deepEqual(stages, ['world-plan'], 'continuation uses one WorldPlan and no replacement Mind');
  assert.equal(continued[0]?.nativeOperation.kind, 'observe', JSON.stringify(continuation.takeDiagnostics()));
  assert.equal(continued[0].mentalAct.utterance, mind.utterance, 'the source utterance remains frozen for provenance');
  assert.equal(continued[0].mentalAct.nextAttempt, mind.nextAttempt, 'continuation retains the initial attempt as authored history');
  assert.equal(continuation.takeMetadata().providerRequests, 1);

  correctEffectsOnce = true; stages = [];
  const correcting = api.createServerLlmDecider('ollama');
  const [correctedEffects] = await correcting.continuePlans([continuingContext]);
  assert.deepEqual(stages, ['world-plan', 'world-plan'], 'one concrete format correction stays within the same frozen WorldPlan stage');
  assert.equal(correcting.takeMetadata().providerRequests, 2);
  assert.equal(correctedEffects.executionProbe.kind, 'world-interaction');
  assert.equal(correctedEffects.mentalAct.goal, mind.goal);
  assert.equal(correctedEffects.mentalAct.plan.completion.goal.description, mind.goal);
  assert.equal(correctedEffects.mentalAct.plan.completion.goal.meaningReview.sufficiency, 'insufficient');
  correctEffectsOnce = false;
  alwaysInvalidCompilation = true; stages = [];
  const failedCompiler = api.createServerLlmDecider('ollama');
  const [heldMind] = await failedCompiler.decideAll([contexts[0]]);
  assert.deepEqual(stages, ['mind', 'world-plan', 'world-plan']);
  assert.equal(failedCompiler.takeMetadata().providerRequests, 3);
  assert(heldMind.compilationFailure && failedCompiler.takeDiagnostics().length);
  assert.equal(heldMind.mentalAct.goal, mind.goal);
  assert.equal(heldMind.mentalAct.attempt.mode, 'observe');
  assert.equal(heldMind.mentalAct.plan.disposition, 'uncompiled');
  assert.equal(heldMind.nativeOperation, undefined, 'an unavailable compiler cannot erase Mind or invent a physical operation');
  alwaysInvalidCompilation = false;

  retain = true; stages = [];
  const retaining = api.createServerLlmDecider('ollama');
  const kept = await retaining.decideAll([contexts[1]]);
  assert.deepEqual(stages, ['mind']);
  assert.equal(kept[0]?.attention, 'keep-current');
  assert.equal(kept[0].mentalAct, undefined);
  retainedDeclaration = { utterance: '我听见了，仍继续刚才的事。', delivery: 'normal', speechIntent: { kind: 'expression' } };
  stages = [];
  const spokenKeep = await retaining.decideAll([contexts[1]]);
  assert.deepEqual(stages, ['mind'], 'speaking while keeping the arrangement needs no Plan or World round');
  assert.equal(spokenKeep[0].attention, 'keep-current');
  assert.equal(spokenKeep[0].declaration.utterance, retainedDeclaration.utterance);
  assert.deepEqual(spokenKeep[0].declaration.sourceEventIds, []);
  assert.equal(spokenKeep[0].mentalAct, undefined);
  assert.equal(spokenKeep[0].characterAgendaUpdate, undefined);
  assert.equal(spokenKeep[0].declaration.goal, undefined);
  assert.equal(spokenKeep[0].declaration.nextAttempt, undefined);
  const stableState = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  const stableContext = api.buildDecisionContexts(stableState, 1)[0];
  assert(stableContext.visibleDrops.length >= 2, 'the continuation fixture needs distinct visible objects');
  const chosenDrop = stableContext.visibleDrops.at(-1);
  const stableProtocol = api.buildDecisionModelRequestProtocol(api.buildDecisionRequestContext(stableContext));
  const originalObjectHandle = stableProtocol.handles.visible.find((item) => item.kind === 'drop' && item.dropId === chosenDrop.id).handle;
  const originalSteps = [`查看 ${originalObjectHandle}，再按同一件物品的真实结果继续`];
  const stablePlan = { version: 'mental-plan-translation-v1', disposition: 'act', steps: originalSteps,
    completion: { step: { description: '观察这份材料', conditions: [] }, goal: { description: '继续了解同一物品', conditions: [] } } };
  const stableMind = { ...mind, goal: '继续了解同一物品', nextAttempt: originalSteps[0], version: 'mental-act-v2', kind: 'pursue',
    attempt: { mode: 'observe', targets: [{ kind: 'drop', dropId: chosenDrop.id }] },
    strategy: originalSteps[0], assumptions: [], sourceEventIds: [], plan: stablePlan };
  const stableEvents = [];
  const origin = api.commitDecision(stableState, stableContext.person, stableContext, { kind: 'idle',
    reason: originalSteps[0], mentalAct: stableMind, nativeOperation: { kind: 'observe', target: { kind: 'drop', dropId: chosenDrop.id } },
  }, true, 1, stableEvents, 1);
  const originIntent = stableState.intents.find((intent) => intent.id === origin.intentId);
  const preparation = api.compileNativeOperation(stableContext, { kind: 'move', target: { kind: 'drop', dropId: chosenDrop.id } }, 'observation-approach');
  assert(preparation.ok);
  const approach = api.executePrimitiveAction(stableState, stableContext.person, preparation.option.nextAction, 1, stableEvents.length,
    { cause: 'intent', intentId: origin.intentId, actionTick: 1 });
  stableEvents.push(approach);
  const beforeObservation = api.buildDecisionRequestContext({ ...stableContext, currentMonthEvents: stableEvents,
    continuingPlan: { sourceIntentId: origin.intentId, sourceDecisionEventId: origin.id, mentalAct: origin.decision.mentalAct,
      plan: originIntent.plan, outcomeReceipts: [] } });
  assert.equal(beforeObservation.continuingPlan.initialAttemptPerformed, false,
    'even real approach movement cannot complete the initial perception attempt');
  const initialObservation = api.executeActiveIntent(stableState, stableContext.person, 1, stableEvents.length, 1, stableEvents);
  assert.equal(initialObservation?.action.kind, 'attend');
  assert.equal(initialObservation.status, 'completed');
  stableEvents.push(initialObservation); stableState.world.past.push(...stableEvents);
  const previousIntent = stableState.intents.find((intent) => intent.id === origin.intentId);
  const freshVisible = api.buildDecisionContexts(stableState, 1).find((context) => context.person.id === stableContext.person.id);
  const realContinuation = { ...freshVisible, visibleDrops: [...freshVisible.visibleDrops].reverse(), currentMonthEvents: stableEvents,
    continuingPlan: { sourceIntentId: previousIntent.id, sourceDecisionEventId: origin.id,
      mentalAct: origin.decision.mentalAct, plan: previousIntent.plan, outcomeReceipts: previousIntent.outcomeReceipts } };
  const nextProtocol = api.buildDecisionModelRequestProtocol(api.buildDecisionRequestContext(realContinuation));
  assert.equal(nextProtocol.requestContext.current.planContinuation.initialAttemptPerformed, true,
    'the original actual attend releases the initial observation mode for later goal steps');
  assert.equal(nextProtocol.handles.visible.find((item) => item.handle === originalObjectHandle)?.dropId, chosenDrop.id);
  const stableStages = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(url).hostname, 'ollama.invalid');
    const body = JSON.parse(init.body);
    const input = JSON.parse(body.messages.find((message) => message.role === 'user' && message.content.trimStart().startsWith('{')).content);
    const stage = input.schemaVersion === 'mind-intention-context-v5' ? 'mind' : 'world-plan';
    stableStages.push(stage);
    const selected = input.visible.nearbyObjects.find((item) => item.ref === originalObjectHandle);
    assert.equal(selected.position.cellId, chosenDrop.cellId, 'the unchanged old text still denotes the original world object');
    if (stage === 'world-plan') assert(JSON.stringify(input).includes(originalSteps[0]), 'actual continuation keeps its original authored text');
    const value = stage === 'mind' ? { declaration: {
      utterance: '我听到了，仍接着刚才那件事做。', delivery: 'normal', speechIntent: { kind: 'expression' },
    } } : { plan: { steps: originalSteps, disposition: 'act', completion: stablePlan.completion,
      currentStep: { kind: 'physical', description: originalSteps[0], targetHandles: [originalObjectHandle] } },
      resolution: { nativeOperation: { kind: 'observe', targetHandle: originalObjectHandle } } };
    return new Response(JSON.stringify({ message: { content: JSON.stringify(value) }, prompt_eval_count: 11, eval_count: 7 }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const stableDecider = api.createServerLlmDecider('ollama');
  const [spokenDelta] = await stableDecider.decideAll([freshVisible]);
  assert.deepEqual(stableStages, ['mind'], 'a declaration-only delta needs one Mind and no Plan or World');
  assert.equal(spokenDelta.mentalAct, undefined);
  const intentCountBeforeDeclaration = stableState.intents.length;
  const spokenDeltaFact = api.commitDecision(stableState, stableContext.person, freshVisible,
    spokenDelta, true, 1, stableEvents, 2);
  assert.equal(spokenDeltaFact.decision.attention, 'keep-current');
  assert.equal(stableState.intents.length, intentCountBeforeDeclaration);
  assert.equal(previousIntent.planSourceDecisionEventId, origin.id, 'speaking preserves the pending plan origin');
  const [continuedObjectDecision] = await stableDecider.continuePlans([realContinuation]);
  assert.deepEqual(stableStages, ['mind', 'world-plan']);
  assert.equal(continuedObjectDecision.mentalAct.goal, stableMind.goal, 'the next translation continues the original goal after a spoken delta');
  assert.equal(continuedObjectDecision?.nativeOperation?.target.dropId, chosenDrop.id, JSON.stringify(stableDecider.takeDiagnostics()));
  const continuedObjectFact = api.commitDecision(stableState, stableContext.person, realContinuation,
    continuedObjectDecision, true, 1, stableEvents, 2);
  assert.equal(continuedObjectFact.planContinuation.sourceDecisionEventId, origin.id);
  assert.equal(continuedObjectFact.executionCompilation.operation.target.dropId, chosenDrop.id,
    'a real frozen-Mind continuation commits the same target after the visible order changes');
  for (const repairsOperation of [true, false]) {
    const pendingState = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
    pendingState.people = [pendingState.people[0]];
    const actorId = pendingState.people[0].id;
    const failedOperation = { kind: 'observe', target: { kind: 'person', personId: actorId }, references: { recordId: 'absent-record' } };
    const frozen = { ...mind, version: 'mental-act-v2', kind: 'pursue', strategy: '查看身体',
      assumptions: [], sourceEventIds: [], plan: { ...plan, version: 'mental-plan-translation-v1' } };
    let mindCalls = 0; let failureContinuations = 0;
    const repairedState = await api.stepSimulationAsync(pendingState, {
      ownsVoluntarySocialChoices: true,
      async decideAll(contexts) {
        return contexts.map(() => { mindCalls++; return { kind: 'idle', reason: '本人选择查看',
          mentalAct: frozen, nativeOperation: failedOperation }; });
      },
      async continuePlans(contexts) {
        return contexts.map((context) => {
          assert.equal(context.continuingPlan.mentalAct.utterance, mind.utterance);
          if (!context.continuingPlan.compilationFailureEventId) return { kind: 'idle', reason: '暂时到此',
            mentalAct: { ...frozen, plan: { ...frozen.plan, disposition: 'stay' } } };
          failureContinuations++;
          assert.equal(context.continuingPlan.sourceIntentId, undefined,
            'a failed translation cannot manufacture a placeholder physical Intent');
          return { kind: 'idle', reason: '按具体反馈重新编译已有意图', mentalAct: frozen,
            nativeOperation: repairsOperation ? { kind: 'observe', target: { kind: 'person', personId: actorId } } : failedOperation };
        });
      },
    });
    assert.equal(failureContinuations, 1, 'the same unchanged compilation problem is not a new trigger on every tick');
    assert.equal(mindCalls, 1, 'translation repair needs no replacement Mind or repeated utterance');
    const facts = repairedState.world.past;
    assert.equal(facts.filter((event) => event.kind === 'decision' && event.languageBroadcast).length, 1);
    assert.equal(facts.some((event) => event.kind === 'action' && event.action.kind === 'attend'), repairsOperation,
      'corrected parameters execute in the same month; unresolved compilation never becomes a fake ActionFact');
  }
  console.log('Mind → WorldPlan → native ActionFact, frozen continuation and provider scheduling passed.');
} finally {
  globalThis.fetch = originalFetch; AbortSignal.timeout = originalSignalTimeout;
  if (originalConfig === undefined) delete process.env.THREEBODY_MODEL_CONFIG; else process.env.THREEBODY_MODEL_CONFIG = originalConfig;
  if (originalEnvFile === undefined) delete process.env.THREEBODY_ENV_FILE; else process.env.THREEBODY_ENV_FILE = originalEnvFile;
  if (originalDecisionTimeout === undefined) delete process.env.MODEL_DECISION_TIMEOUT_MS; else process.env.MODEL_DECISION_TIMEOUT_MS = originalDecisionTimeout;
  rmSync(temporary, { recursive: true, force: true });
}
