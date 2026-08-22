import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-model-client-thinking-'));
const bundlePath = path.join(temporaryDirectory, 'model-client.mjs');
const receivedBodies = [];
const originalFetch = globalThis.fetch;
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      model: 'test-model',
      choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }));
  });
});

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/model-client.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  const { requestModelText } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const localUrl = `http://127.0.0.1:${address.port}/chat/completions`;
  globalThis.fetch = (input, init) => {
    const requestedUrl = new URL(input instanceof Request ? input.url : input);
    if (requestedUrl.hostname !== 'api.deepseek.com') return originalFetch(input, init);
    requestedUrl.protocol = 'http:';
    requestedUrl.hostname = '127.0.0.1';
    requestedUrl.port = String(address.port);
    return originalFetch(requestedUrl, init);
  };
  const baseEndpoint = {
    id: 'thinking-test',
    protocol: 'openai-chat',
    url: 'https://api.deepseek.com/chat/completions',
    model: 'test-model',
    auth: 'none',
    apiKey: '',
    headers: {},
    timeoutMs: 5_000,
    structuredOutput: 'prompt',
    source: 'config-file',
  };
  const modelRequest = {
    messages: [{ role: 'user', content: 'return JSON' }],
    maxOutputTokens: 32,
  };

  for (const thinking of [undefined, false, true, 'high']) {
    const endpoint = thinking === undefined ? baseEndpoint : { ...baseEndpoint, thinking };
    const result = await requestModelText(endpoint, modelRequest);
    assert.equal(result.text, '{"ok":true}');
  }
  await requestModelText({ ...baseEndpoint, url: localUrl, thinking: false }, modelRequest);

  assert.equal(Object.hasOwn(receivedBodies[0], 'thinking'), false,
    '未配置 thinking 的端点不得新增供应商字段');
  assert.equal(Object.hasOwn(receivedBodies[0], 'reasoning_effort'), false);
  assert.deepEqual(receivedBodies[1].thinking, { type: 'disabled' });
  assert.equal(Object.hasOwn(receivedBodies[1], 'reasoning_effort'), false);
  assert.deepEqual(receivedBodies[2].thinking, { type: 'enabled' });
  assert.equal(Object.hasOwn(receivedBodies[2], 'reasoning_effort'), false);
  assert.deepEqual(receivedBodies[3].thinking, { type: 'enabled' });
  assert.equal(receivedBodies[3].reasoning_effort, 'high');
  assert.equal(Object.hasOwn(receivedBodies[4], 'thinking'), false,
    '非 DeepSeek 端点即使显式配置 thinking 也不得发送扩展字段');
  assert.equal(Object.hasOwn(receivedBodies[4], 'reasoning_effort'), false);

  console.log('model client thinking request tests passed');
} finally {
  globalThis.fetch = originalFetch;
  await new Promise((resolve) => server.close(resolve));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
