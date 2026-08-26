import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-worker-recovery-test-'));
const clientBundlePath = path.join(temporaryDirectory, 'eland-worker-client.mjs');
const previousOldSpace = process.env.ELAND_WORKER_OLD_SPACE_MB;
const previousYoungSpace = process.env.ELAND_WORKER_YOUNG_SPACE_MB;
const previousStack = process.env.ELAND_WORKER_STACK_MB;
let client;

class FakeWorker extends EventEmitter {
  terminated = false;

  postMessage(request) {
    if (request.control === 'persist') {
      queueMicrotask(() => this.emit('message', { id: request.id, persistedSessions: 0 }));
      return;
    }
    const body = new TextEncoder().encode(JSON.stringify({ worker: request.body.workerNumber }));
    queueMicrotask(() => this.emit('message', { id: request.id, status: 200, body: body.buffer }));
  }

  async terminate() {
    this.terminated = true;
    return 0;
  }
}

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/eland-worker-client.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${clientBundlePath}`,
  ], { stdio: 'pipe' });

  const { ElandWorkerClient, workerResourceLimits } = await import(
    `${pathToFileURL(clientBundlePath).href}?test=${Date.now()}`
  );

  process.env.ELAND_WORKER_OLD_SPACE_MB = 'invalid';
  process.env.ELAND_WORKER_YOUNG_SPACE_MB = 'invalid';
  process.env.ELAND_WORKER_STACK_MB = 'invalid';
  assert.deepEqual(workerResourceLimits(), {
    maxOldGenerationSizeMb: 1_536,
    maxYoungGenerationSizeMb: 64,
    stackSizeMb: 8,
  });
  process.env.ELAND_WORKER_OLD_SPACE_MB = '16';
  process.env.ELAND_WORKER_YOUNG_SPACE_MB = '4';
  process.env.ELAND_WORKER_STACK_MB = '4';
  assert.deepEqual(workerResourceLimits(), {
    maxOldGenerationSizeMb: 16,
    maxYoungGenerationSizeMb: 4,
    stackSizeMb: 4,
  });
  process.env.ELAND_WORKER_OLD_SPACE_MB = '99999';
  process.env.ELAND_WORKER_YOUNG_SPACE_MB = '99999';
  process.env.ELAND_WORKER_STACK_MB = '99999';
  assert.deepEqual(workerResourceLimits(), {
    maxOldGenerationSizeMb: 2_048,
    maxYoungGenerationSizeMb: 128,
    stackSizeMb: 16,
  });

  const workers = [];
  const options = [];
  client = new ElandWorkerClient((_url, workerOptions) => {
    const worker = new FakeWorker();
    workers.push(worker);
    options.push(workerOptions);
    return worker;
  });
  assert.equal(workers.length, 0, '构造 client 不应立即创建 Worker');

  const firstRequest = client.handle('GET', new URL('http://127.0.0.1/api/eland/state'), { workerNumber: 1 });
  const concurrentRequest = client.handle('GET', new URL('http://127.0.0.1/api/eland/report'), { workerNumber: 1 });
  assert.equal(workers.length, 1, '并发首请求只能创建一个 Worker');
  assert.deepEqual(options[0].resourceLimits, {
    maxOldGenerationSizeMb: 2_048,
    maxYoungGenerationSizeMb: 128,
    stackSizeMb: 16,
  });
  assert.equal((await firstRequest).status, 200);
  assert.equal((await concurrentRequest).status, 200);

  const failedRequest = client.handle('GET', new URL('http://127.0.0.1/api/eland/state'), {});
  workers[0].emit('error', new Error('fake worker failed'));
  await assert.rejects(failedRequest, /fake worker failed/);
  assert.equal(workers.length, 1, '异常后无请求时不应后台重启 Worker');
  assert.equal(workers[0].terminated, true, '异常 Worker 应释放资源');

  const recovered = await client.handle(
    'GET',
    new URL('http://127.0.0.1/api/eland/state'),
    { workerNumber: 2 },
  );
  assert.equal(workers.length, 2, '异常后的下一次请求应按需重建 Worker');
  assert.equal(recovered.status, 200);

  const exitedRequest = client.handle('GET', new URL('http://127.0.0.1/api/eland/state'), {});
  workers[1].emit('exit', 1);
  await assert.rejects(exitedRequest, /Worker 异常退出（1）/);
  assert.equal(workers.length, 2, '退出后无请求时不应后台重启 Worker');

  const recoveredAfterExit = await client.handle(
    'GET',
    new URL('http://127.0.0.1/api/eland/state'),
    { workerNumber: 3 },
  );
  assert.equal(workers.length, 3, '退出后的下一次请求应按需重建 Worker');
  assert.equal(recoveredAfterExit.status, 200);
  await client.close();
  client = null;
  assert.equal(workers[2].terminated, true);

  const unusedClient = new ElandWorkerClient(() => {
    throw new Error('close 不应创建 Worker');
  });
  await unusedClient.close();

  console.log('ELAND worker recovery test passed (lazy start, bounded memory, on-demand recovery, clean close)');
} finally {
  if (client) await client.close();
  if (previousOldSpace === undefined) delete process.env.ELAND_WORKER_OLD_SPACE_MB;
  else process.env.ELAND_WORKER_OLD_SPACE_MB = previousOldSpace;
  if (previousYoungSpace === undefined) delete process.env.ELAND_WORKER_YOUNG_SPACE_MB;
  else process.env.ELAND_WORKER_YOUNG_SPACE_MB = previousYoungSpace;
  if (previousStack === undefined) delete process.env.ELAND_WORKER_STACK_MB;
  else process.env.ELAND_WORKER_STACK_MB = previousStack;
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
