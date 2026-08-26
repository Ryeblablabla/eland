import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-model-decision-retry-'));
const bundlePath = path.join(temporaryDirectory, 'model-decision-gateway.mjs');
const configPath = path.join(temporaryDirectory, 'model-endpoints.json');
const previousConfigPath = process.env.THREEBODY_MODEL_CONFIG;
const receivedBodies = [];
let responseIndex = 0;
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const body = responseIndex++ === 0
      ? {
          model: 'retry-test-model',
          choices: [{
            finish_reason: 'stop',
            message: { content: '', reasoning_content: '先分析候选，但没有输出最终 JSON。' },
          }],
          usage: { prompt_tokens: 4, completion_tokens: 8 },
        }
      : {
          model: 'retry-test-model',
          choices: [{
            finish_reason: 'stop',
            message: { content: '{"kind":"idle","reason":"没有需要调整的意图"}' },
          }],
          usage: { prompt_tokens: 5, completion_tokens: 6 },
        };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
});

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/model-decision-gateway.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
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
    person: { id: 'person-1' },
    followUpOptions: [],
    visibleDrops: [],
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
  assert.match(receivedBodies[1].messages.at(-1).content, /只返回了内部推理/);

  console.log('model decision reasoning-only retry test passed');
} finally {
  if (previousConfigPath === undefined) delete process.env.THREEBODY_MODEL_CONFIG;
  else process.env.THREEBODY_MODEL_CONFIG = previousConfigPath;
  await new Promise((resolve) => server.close(resolve));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
