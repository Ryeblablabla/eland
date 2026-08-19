import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-worker-recovery-test-'));
const clientBundlePath = path.join(temporaryDirectory, 'eland-worker-client.mjs');
const workerPath = path.join(temporaryDirectory, 'eland-worker.mjs');
const markerPath = path.join(temporaryDirectory, 'first-worker-crashed');
const previousOldSpace = process.env.ELAND_WORKER_OLD_SPACE_MB;
const previousYoungSpace = process.env.ELAND_WORKER_YOUNG_SPACE_MB;
let client;

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/eland-worker-client.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${clientBundlePath}`,
  ], { stdio: 'pipe' });

  writeFileSync(workerPath, `
    import { existsSync, writeFileSync } from 'node:fs';
    import { parentPort } from 'node:worker_threads';
    const marker = ${JSON.stringify(markerPath)};
    if (!existsSync(marker)) {
      writeFileSync(marker, 'crash once');
      const retained = [];
      while (true) retained.push(new Array(250_000).fill(Math.random()));
    }
    parentPort.on('message', (request) => {
      if (request.control === 'persist') {
        parentPort.postMessage({ id: request.id, persistedSessions: 0 });
        return;
      }
      const body = new TextEncoder().encode(JSON.stringify({ recovered: true }));
      parentPort.postMessage({ id: request.id, status: 200, body: body.buffer }, [body.buffer]);
    });
  `, 'utf8');

  process.env.ELAND_WORKER_OLD_SPACE_MB = '16';
  process.env.ELAND_WORKER_YOUNG_SPACE_MB = '4';
  const { ElandWorkerClient } = await import(`${pathToFileURL(clientBundlePath).href}?test=${Date.now()}`);
  client = new ElandWorkerClient();

  await assert.rejects(
    client.handle('GET', new URL('http://127.0.0.1/api/eland/state'), {}),
    /memory limit|heap out of memory|Worker 异常退出/iu,
    '首个 Worker 触发堆上限时请求应明确失败',
  );

  let recoveryTimeout;
  const recovered = await Promise.race([
    client.handle('GET', new URL('http://127.0.0.1/api/eland/state'), {}),
    new Promise((_, reject) => {
      recoveryTimeout = setTimeout(() => reject(new Error('重建 Worker 超时')), 5_000);
    }),
  ]).finally(() => clearTimeout(recoveryTimeout));
  assert.equal(recovered.status, 200);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(recovered.body)), { recovered: true });
  await client.close();
  client = null;

  console.log('ELAND worker recovery test passed (OOM rejection, automatic restart, clean close)');
} finally {
  if (client) await client.close();
  if (previousOldSpace === undefined) delete process.env.ELAND_WORKER_OLD_SPACE_MB;
  else process.env.ELAND_WORKER_OLD_SPACE_MB = previousOldSpace;
  if (previousYoungSpace === undefined) delete process.env.ELAND_WORKER_YOUNG_SPACE_MB;
  else process.env.ELAND_WORKER_YOUNG_SPACE_MB = previousYoungSpace;
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
