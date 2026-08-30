import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-model-decision-retry-'));
const bundlePath = path.join(temporaryDirectory, 'model-decision-gateway.mjs');
const backendBundlePath = path.join(temporaryDirectory, 'backend-decider.mjs');
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const configPath = path.join(temporaryDirectory, 'model-endpoints.json');
const previousConfigPath = process.env.THREEBODY_MODEL_CONFIG;
const previousContextMode = process.env.MODEL_DECISION_CONTEXT_MODE;
const receivedBodies = [];
let responseIndex = 0;
let failAtResponseIndex = -1;
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const currentResponse = responseIndex++;
    if (currentResponse === failAtResponseIndex) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'synthetic second-chunk failure' }));
      return;
    }
    const received = receivedBodies.at(-1);
    let monthlyBatch = null;
    try {
      const payload = JSON.parse(received?.messages?.[1]?.content ?? '{}');
      if (payload.schemaVersion === 'monthly-agent-decisions-v1') monthlyBatch = payload;
    } catch {
      monthlyBatch = null;
    }
    const body = currentResponse === 0
      ? {
          model: 'retry-test-model',
          choices: [{
            finish_reason: 'stop',
            message: { content: '', reasoning_content: '先分析候选，但没有输出最终 JSON。' },
          }],
          usage: { prompt_tokens: 4, completion_tokens: 8 },
        }
      : currentResponse === 1 ? {
          model: 'retry-test-model',
          choices: [{
            finish_reason: 'stop',
            message: { content: '{"kind":"idle","reason":"没有需要调整的意图"}' },
          }],
          usage: { prompt_tokens: 5, completion_tokens: 6 },
        }
      : monthlyBatch ? {
          model: 'retry-test-model',
          choices: [{
            finish_reason: 'stop',
            message: { content: JSON.stringify({
              decisions: monthlyBatch.agents.map((agent) => ({
                agentHandle: agent.agentHandle,
                decision: { kind: 'start', optionId: 'o1', reason: '批量选择紧凑句柄' },
              })),
            }) },
          }],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        }
      : {
          model: 'retry-test-model',
          choices: [{
            finish_reason: 'stop',
            message: { content: '{"kind":"start","optionId":"o1","reason":"选择紧凑句柄"}' },
          }],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
});

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/model-decision-gateway.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/backend-decider.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${backendBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/simulation.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${simulationBundlePath}`,
  ], { stdio: 'pipe' });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    endpoints: {
      retry: {
        protocol: 'openai-chat',
        url: `http://127.0.0.1:${address.port}/chat/completions`,
        model: 'retry-test-model',
        auth: 'none',
        structuredOutput: 'prompt',
      },
    },
    routes: { decision: 'retry' },
  }));
  process.env.THREEBODY_MODEL_CONFIG = configPath;

  const { handleDecide } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const contextShell = {
    person: {
      id: 'person-1', name: '甲', ageMonths: 240, sex: 'female',
      body: { health: 90, hydration: 80, nutrition: 80 }, conditions: [],
      capacities: { locomotion: 50, manipulation: 50, perception: 50, communication: 50, cognition: 50 },
      personality: { honestyHumility: 50, emotionality: 50, extraversion: 50, agreeableness: 50, conscientiousness: 50, openness: 50 },
      motiveSensitivity: { control: 50, status: 50 },
      soul: {
        signature: 'soul-test', innerVoice: '我是甲。', styleMatrix: {},
        sceneFacets: [{
          id: 'uncertainty-and-change', cue: '未知', attention: '看证据', innerTension: '保持怀疑',
          socialStrategy: '说清边界', speechTendency: '简短说明',
        }],
      },
      currentChoice: '', currentAction: '', position: { cellId: 1, z: 1 },
      inventory: [], knowledge: [], memories: [],
      cognition: { architecture: 'causal-bdi-v1', needs: [], outcomeBeliefs: [], optionAppraisals: [] },
      kinship: { parents: [], children: [], siblings: [] },
    },
    clock: { elapsedMonths: 1 },
    climate: { kind: 'temperate', severity: 1, sinceMonth: 0 },
    epoch: 'stable', weather: { kind: 'clear', intensity: 1, sinceMonth: 0 },
    activePressures: [], suspendedIntents: [], agreements: [], collectives: [], permissions: [],
    followUpOptions: [],
    visiblePeople: [], visibleDrops: [], visibleAnimals: [], visibleContainers: [],
  };
  const partialSemantics = await handleDecide({
    contexts: [{
      ...contextShell,
      options: [{ id: 'opaque-partial', semantics: { version: 'action-option-semantics-v1' } }],
    }],
  });
  assert.equal(partialSemantics.status, 400,
    'gateway must reject a version-only semantics forgery before calling the model');
  const inconsistentSemantics = await handleDecide({
    contexts: [{
      ...contextShell,
      options: [{
        id: 'opaque-inconsistent',
        semantics: {
          version: 'action-option-semantics-v1',
          obligation: 'required-response',
          planningChannel: 'ordinary',
          purpose: 'social-coordination',
          minimumLifeStage: 'adolescent',
          needKinds: [],
        },
      }],
    }],
  });
  assert.equal(inconsistentSemantics.status, 400,
    'gateway must fail closed on structurally present but inconsistent semantics');
  assert.equal(receivedBodies.length, 0, 'invalid contexts must not reach the model endpoint');
  const result = await handleDecide({
    contexts: [{
      ...contextShell,
      options: [],
    }],
  });

  assert.equal(result.status, 200);
  assert.equal(receivedBodies.length, 2, 'reasoning-only stop 响应应且只应重试一次');
  assert.deepEqual(result.body.decisions, [{ kind: 'idle', reason: '没有需要调整的意图' }]);
  const systemPrompt = receivedBodies[0].messages[0].content;
  assert.match(systemPrompt, /on-achievement.*真实达成就结算/u,
    '模型 prompt 必须解释一次性目标达成即结算');
  assert.match(systemPrompt, /reviewAtMonth.*不是.*维持/u,
    '模型 prompt 不得把一次性目标的复核月解释成维持锁');
  assert.match(systemPrompt, /maintain-state.*maintainUntilMonth/u,
    '模型 prompt 必须只把显式维护目标绑定到 maintainUntilMonth');
  assert.match(systemPrompt, /recentDialogue.*主观回应.*不是已核验事实.*不能绕过/u,
    '模型 prompt 必须把已保存原话限制为主观连续性，而非新的事实权威');
  assert.match(receivedBodies[1].messages.at(-1).content, /只返回了内部推理/);

  process.env.MODEL_DECISION_CONTEXT_MODE = 'compact';
  const compactResult = await handleDecide({
    contexts: [{
      ...contextShell,
      recentDialogue: [{
        month: 1, speaker: '乙', listeners: ['甲'], text: '我还没想好。',
        move: 'deflect', disposition: 'continue', sourceEventId: 'voice:1',
      }],
      options: [{
        id: 'opaque-real-option-id', summary: '观察眼前变化', reason: '存在合法观察机会',
        requiresFollowUp: false,
        semantics: {
          version: 'action-option-semantics-v1', obligation: 'optional', planningChannel: 'ordinary',
          purpose: 'other', minimumLifeStage: 'adult', needKinds: [],
        },
      }],
    }],
  });
  assert.equal(compactResult.status, 200);
  assert.deepEqual(compactResult.body.decisions, [{
    kind: 'start', optionId: 'opaque-real-option-id', reason: '选择紧凑句柄',
  }], 'compact transport handles must expand back to authoritative option ids before validation');
  const compactRequest = JSON.parse(receivedBodies[2].messages[1].content);
  assert.equal(compactRequest.schemaVersion, 'decision-context-compact-v1');
  assert.deepEqual(compactRequest.recentDialogue, [{
    month: 1, speaker: '乙', listeners: ['甲'], text: '我还没想好。',
    move: 'deflect', disposition: 'continue', sourceEventId: 'voice:1',
  }], 'compact gateway request must preserve dialogue wording and world person names');
  assert.match(receivedBodies[2].messages[1].content, /(?:"甲"|"乙")/u,
    'provider request should expose world person names for natural reference');

  const { createServerLlmDecider } = await import(
    `${pathToFileURL(backendBundlePath).href}?test=${Date.now()}`
  );
  const { buildDecisionContexts, createInitialState } = await import(
    `${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`
  );
  const state = createInitialState(20260830, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const sourceContext = buildDecisionContexts(state, state.clock.elapsedMonths + 1)
    .find((context) => context.options.some((option) => !option.requiresFollowUp));
  assert.ok(sourceContext, 'chunking fixture needs one real decision context with a direct option');
  const sourceOption = sourceContext.options.find((option) => !option.requiresFollowUp);
  assert.ok(sourceOption);
  const batchContexts = Array.from({ length: 13 }, (_, index) => ({
    ...sourceContext,
    options: [{ ...sourceOption, id: `batch-option-${index + 1}` }],
    followUpOptions: [],
  }));
  const receivedBeforeBatch = receivedBodies.length;
  const decider = createServerLlmDecider('retry');
  const batchDecisions = await decider.decideAll(batchContexts);
  assert.equal(receivedBodies.length - receivedBeforeBatch, 2,
    'thirteen contexts must use one provider request per bounded monthly chunk, not one request per person');
  assert.deepEqual(batchDecisions.map((decision) => decision?.optionId),
    batchContexts.map((_, index) => `batch-option-${index + 1}`),
    'chunk results must expand compact handles and preserve the original remote-context order');
  assert.deepEqual(decider.takeUsage(), { inputTokens: 6, outputTokens: 8 },
    'backend must aggregate billed usage from every gateway chunk');

  const failedBatchStart = responseIndex;
  failAtResponseIndex = failedBatchStart + 1;
  const failingDecider = createServerLlmDecider('retry');
  await assert.rejects(
    failingDecider.decideAll(batchContexts),
    /synthetic second-chunk failure|HTTP 500/u,
    'a failed later chunk must fail closed instead of returning a shifted partial batch',
  );
  assert.equal(responseIndex - failedBatchStart, 2,
    'the failure fixture must reach the second bounded monthly batch request');

  console.log('model decision reasoning-only retry test passed');
} finally {
  if (previousConfigPath === undefined) delete process.env.THREEBODY_MODEL_CONFIG;
  else process.env.THREEBODY_MODEL_CONFIG = previousConfigPath;
  if (previousContextMode === undefined) delete process.env.MODEL_DECISION_CONTEXT_MODE;
  else process.env.MODEL_DECISION_CONTEXT_MODE = previousContextMode;
  await new Promise((resolve) => server.close(resolve));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
