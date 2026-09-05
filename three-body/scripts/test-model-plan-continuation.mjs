import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = mkdtempSync(path.join(tmpdir(), 'eland-plan-continuation-'));
const originalFetch = globalThis.fetch;
const originalConfig = process.env.THREEBODY_MODEL_CONFIG;
try {
  const bundle = path.join(temporary, 'continuation.mjs');
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=continuation-test.ts', `--outfile=${bundle}`, '--log-level=error',
  ], {
    input: `export { createServerLlmDecider } from './server/backend-decider';
      export { createInitialState, buildDecisionContexts } from './src/game/eland/simulation';
      export { createWork } from './src/game/eland/domain/works';
      export { Material } from './src/game/eland/domain/material';
      export { cellX, cellY } from './src/game/eland/world/grid';`,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const config = path.join(temporary, 'model.json');
  writeFileSync(config, JSON.stringify({
    schemaVersion: 1,
    endpoints: { continuation: {
      protocol: 'openai-chat', url: 'https://continuation.invalid/v1/chat/completions',
      model: 'fixture', auth: 'none', structuredOutput: 'prompt',
    } },
    routes: { decision: 'continuation' },
  }));
  process.env.THREEBODY_MODEL_CONFIG = config;
  const api = await import(pathToFileURL(bundle).href);
  const state = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  const context = api.buildDecisionContexts(state, 1)[0];
  const work = api.createWork({
    position: { x: api.cellX(context.person.position.cellId), y: api.cellY(context.person.position.cellId), z: context.person.position.z },
    arrangement: 'support', components: [{ materialId: api.Material.Wood, quantity: 1 }],
    summary: '已经立起的构件', builderId: context.person.id, atMonth: 1, sourceEventId: 'actual-work-created',
  });
  state.world.works = [work];
  context.person.knowledge.push({
    id: 'technique:experienced:test', kind: 'technique', summary: '曾经试着把木材支起来', confidence: 46,
    learnedAtMonth: 1, sourceEventIds: ['actual-work-created'],
    procedural: {
      version: 'procedural-knowledge-v1', instruction: '把木材支起来',
      inputs: [{ roleId: 'input1', materialId: api.Material.Wood, quantity: 1 }], contexts: [],
      operations: ['consume', 'assemble'], outputs: [{ roleId: 'output1', kind: 'work', arrangement: 'support', components: work.components }],
      experiences: [{ actorId: context.person.id, eventId: 'actual-work-created', atMonth: 1,
        inputBindings: [], contextBindings: [], outputBindings: [{ roleId: 'output1', workId: work.id }] }],
      transmissionEventIds: [],
    },
  });
  const frozen = {
    version: 'mental-act-v2', kind: 'pursue', delivery: 'normal',
    utterance: '我想把手里的材料做成自己用得上的东西。',
    goal: '制作自己用得上的物件', orientation: 'construction', horizon: 'ongoing',
    strategy: '先取材料，再动手做', assumptions: ['材料也许能够成形'],
    sourceEventIds: ['original-experience'],
  };
  const plan = {
    version: 'mental-plan-translation-v1', disposition: 'act',
    steps: ['取到准备使用的材料', '把材料做成设想的物件'],
  };
  const speechOption = context.options.find((option) => option.nextAction.kind === 'talk'
    || option.completionAction?.kind === 'talk');
  assert(speechOption, 'fixture needs one actual language action');
  state.intents.push({
    id: 'suspended-language-tail', ownerId: context.person.id,
    summary: '靠近后提出新的约定', domain: 'social', status: 'suspended',
    nextAction: { kind: 'move', target: { kind: 'voxel', position: { x: 0, y: 0, z: 0 } } },
    completionAction: speechOption.nextAction.kind === 'talk' ? speechOption.nextAction : speechOption.completionAction,
    sourceDecisionEventId: 'original-decision', planSourceDecisionEventId: 'original-decision',
    progress: 0, createdAtMonth: 1, lastProgressAtMonth: 1, plan,
  });
  const continuation = {
    ...context,
    continuingPlan: {
      sourceIntentId: 'completed-step', sourceDecisionEventId: 'original-decision',
      mentalAct: frozen, plan, outcomeReceipts: [],
    },
  };
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    assert(body.messages.every((message) => !message.content.includes('# ELAND Mind Contract')),
      'continuing an existing plan must never issue another Mind request');
    const contextMessage = body.messages.find((message) => message.role === 'user'
      && message.content.includes('agent-plan-context-v1'));
    const request = JSON.parse(contextMessage.content);
    assert.deepEqual(request.current.planContinuation.authoredPlan, plan.steps);
    assert.equal(request.intention.utterance, frozen.utterance);
    assert(request.availableSteps.every((step) => !step.communicationKind),
      'an already spoken intention must not acquire a new language or consent action');
    assert(request.current.suspendedWork.every((work) => work.summary !== '靠近后提出新的约定'),
      'resuming a physical step must not smuggle in its later language or consent action');
    const first = request.availableSteps.find((step) => !step.requiresContinuation);
    assert(first, 'fixture needs one executable physical step');
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        disposition: 'act', steps: ['继续做尚未完成的具体一步'], firstStepHandle: first.handle,
      }) } }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const decider = api.createServerLlmDecider('continuation');
  const [decision] = await decider.continuePlans([continuation]);
  assert(decision, 'the independently compiled next step must survive normalization');
  assert.equal(calls, 1, 'a known physical next step needs one Plan call and no Mind or World call');
  assert.equal(decision.mentalAct.goal, frozen.goal);
  assert.equal(decision.mentalAct.utterance, frozen.utterance);
  assert.deepEqual(decision.mentalAct.assumptions, frozen.assumptions);
  assert.deepEqual(decision.mentalAct.plan.steps, ['继续做尚未完成的具体一步']);
  assert.equal(decision.characterAgendaUpdate, undefined, 'continuation must not create another concern');
  assert.equal(decision.mentalAct.relationshipAppraisal, undefined);
  assert.equal(decider.takeMetadata().providerRequests, 1);
  assert.deepEqual(decider.takeUsage(), { inputTokens: 11, outputTokens: 7 });
  let selectedWorkHandle;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    assert(body.messages.every((message) => !message.content.includes('# ELAND Mind Contract')));
    const contextMessage = body.messages.find((message) => message.role === 'user' && message.content.includes('context-v1'));
    const request = JSON.parse(contextMessage.content);
    const existing = request.visible.nearbyObjects.find((item) => item.kind === '造物');
    assert(existing, 'the existing work must remain an addressable object');
    assert.equal(existing.physicalProfile.stability, work.profile.stability,
      'material durability must not be substituted for the work\'s actual stability');
    selectedWorkHandle = existing.ref;
    let value;
    if (request.schemaVersion === 'agent-plan-context-v1') {
      assert.equal(request.knownMethods[0].confidence, 46,
        'a learned method may be tried without a confidence permission threshold');
      value = {
        disposition: 'act', steps: ['调整已存在构件'],
        completion: {
          step: { description: '既有构件稳定性得到改善', conditions: [{ kind: 'work-state', targetHandle: existing.ref, minProfile: { stability: 40 } }] },
          goal: { description: '保留一个已经形成的实体', conditions: [{ kind: 'work-state', targetHandle: 'produced-work' }] },
        },
        worldAction: { description: '调整已存在构件的排布', targetHandles: [existing.ref], methodHandle: request.knownMethods[0].handle },
      };
    } else {
      assert(request.executionEvidence.planContinuation, 'world compilation must receive the actual ongoing plan evidence');
      assert(request.referencedMethod, 'an experienced method is a reference for a fresh world adjudication');
      value = { effects: [{ kind: 'modify-structure', targetHandle: existing.ref, arrangement: 'pile' }], status: 'completed', result: '调整了既有构件的排布' };
    }
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const [adjustment] = await decider.continuePlans([continuation]);
  assert.equal(calls, 3, 'an open continuation adds one Plan and one independent World call');
  assert(selectedWorkHandle.startsWith('w'));
  assert.deepEqual(adjustment.executionProbe.adjudication.effects[0].target, { kind: 'work', workId: work.id });
  assert.deepEqual(adjustment.mentalAct.plan.completion.step.conditions[0].target, { kind: 'work', workId: work.id });
  assert.equal(adjustment.mentalAct.plan.completion.goal.conditions[0].target.kind, 'produced-work');
  assert.equal(decider.takeMetadata().providerRequests, 2);
  assert.deepEqual(decider.takeUsage(), { inputTokens: 22, outputTokens: 14 });
  console.log('model plan continuation test passed');
} finally {
  globalThis.fetch = originalFetch;
  if (originalConfig === undefined) delete process.env.THREEBODY_MODEL_CONFIG;
  else process.env.THREEBODY_MODEL_CONFIG = originalConfig;
  rmSync(temporary, { recursive: true, force: true });
}
