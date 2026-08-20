import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-evolution-server-test-'));
const dataDirectory = path.join(temporaryDirectory, 'data');
const mainBundle = path.join(temporaryDirectory, 'main.mjs');
const storeBundle = path.join(temporaryDirectory, 'sqlite-run-store.mjs');
let child;

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close((error) => error ? reject(error) : resolvePromise(address.port));
    });
  });
}

async function waitForHealth(baseUrl) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw lastError ?? new Error('server did not start');
}

async function startServer(port) {
  child = spawn(process.execPath, [mainBundle], {
    env: {
      ...process.env,
      THREEBODY_HOST: '127.0.0.1',
      THREEBODY_PORT: String(port),
      THREEBODY_DATA_DIR: dataDirectory,
      THREEBODY_MODEL_CONFIG: path.join(temporaryDirectory, 'model-config.json'),
      THREEBODY_ENV_FILE: path.join(temporaryDirectory, 'no-env-file'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.once('exit', (code) => {
    if (code && code !== 0) process.stderr.write(stderr);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  return baseUrl;
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const stopped = new Promise((resolvePromise) => child.once('exit', resolvePromise));
  child.kill('SIGTERM');
  await stopped;
  child = undefined;
}

async function request(baseUrl, route, init) {
  const response = await fetch(`${baseUrl}${route}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function createRun(baseUrl, { id, label, seed, months }) {
  const result = await request(baseUrl, '/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id,
      label,
      seed,
      config: {
        civilizationNo: 1,
        chaosIntensity: 0,
        climateBias: 'balanced',
        endpoint: { kind: 'months', value: months },
      },
    }),
  });
  assert.equal(result.status, 201);
}

function expected(label, seed, months) {
  return {
    label,
    seed,
    civilizationNo: 1,
    chaosIntensity: 0,
    climateBias: 'balanced',
    endpoint: { kind: 'months', value: months },
    fromMonth: 0,
  };
}

async function waitCompleted(baseUrl, id) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await request(baseUrl, `/api/runs/${id}/evolution`);
    assert.equal(result.status, 200);
    if (result.body.status === 'completed') return result.body;
    if (result.body.status === 'failed') throw new Error(result.body.failure ?? 'evolution failed');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`${id} did not complete`);
}

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/main.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--packages=external',
    `--outfile=${mainBundle}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/sqlite-run-store.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${storeBundle}`,
  ], { stdio: 'pipe' });

  const port = await freePort();
  let baseUrl = await startServer(port);

  await createRun(baseUrl, { id: 'legacy', label: 'legacy run', seed: 17, months: 1 });
  assert.equal((await request(baseUrl, '/api/runs/legacy/evolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ months: 1 }),
  })).status, 202, 'legacy relative-month payload remains accepted');
  await waitCompleted(baseUrl, 'legacy');
  const terminalState = (await request(baseUrl, '/api/runs/legacy/state')).body;

  await createRun(baseUrl, { id: 'stale', label: 'stale run', seed: 185, months: 2 });
  await createRun(baseUrl, { id: 'failed', label: 'failed run', seed: 20260815, months: 2 });
  const imported = await request(baseUrl, '/api/runs/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'terminal-running', label: 'terminal running', state: terminalState }),
  });
  assert.equal(imported.status, 201);
  await stopServer();

  const { SqliteRunStore } = await import(`${pathToFileURL(storeBundle).href}?test=${Date.now()}`);
  const store = new SqliteRunStore(dataDirectory);
  const runningPath = (runId, requestedEndMonth, reachedMonth) => ({
    schemaVersion: 2,
    runId,
    provider: 'local',
    model: 'rule-planner-v1',
    status: 'running',
    startedAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    fromMonth: 0,
    requestedEndMonth,
    reachedMonth,
    checkpoints: [],
    turningPoints: [],
  });
  await store.saveEvolutionPath('stale', runningPath('stale', 2, 0));
  await store.saveEvolutionPath('failed', {
    ...runningPath('failed', 2, 0),
    status: 'failed',
    failure: 'fixture failure',
  });
  await store.saveEvolutionPath('terminal-running', runningPath('terminal-running', 1, 1));
  store.close();

  baseUrl = await startServer(port);
  const ensure = (id, requestedEndMonth, identity) => request(baseUrl, `/api/runs/${id}/evolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestedEndMonth, expected: identity }),
  });

  const duplicateClaims = await Promise.all([
    ensure('stale', 2, expected('stale run', 185, 2)),
    ensure('stale', 2, expected('stale run', 185, 2)),
  ]);
  assert.deepEqual(duplicateClaims.map((result) => result.status), [202, 202], 'same ensure-through claim is idempotent');
  const completed = await waitCompleted(baseUrl, 'stale');
  assert.equal(completed.reachedMonth, 2, 'stale running path resumes only through the absolute target');
  assert.equal((await request(baseUrl, '/api/runs/stale/report')).status, 200);

  const beforeNoopPath = (await request(baseUrl, '/api/runs/stale/evolution')).body;
  const beforeNoopReport = (await request(baseUrl, '/api/runs/stale/report')).body;
  const completedNoop = await ensure('stale', 2, expected('stale run', 185, 2));
  assert.equal(completedNoop.status, 202, JSON.stringify(completedNoop.body));
  assert.deepEqual((await request(baseUrl, '/api/runs/stale/evolution')).body, beforeNoopPath, 'completed ensure is a path no-op');
  assert.deepEqual((await request(baseUrl, '/api/runs/stale/report')).body, beforeNoopReport, 'completed ensure is a report no-op');

  const identityConflict = await ensure('stale', 2, expected('wrong label', 185, 2));
  assert.equal(identityConflict.status, 409);
  assert.match(identityConflict.body.error, /label/);

  const terminalClaim = await ensure('terminal-running', 1, expected('terminal running', 17, 1));
  assert.equal(terminalClaim.status, 202);
  assert.equal(terminalClaim.body.status, 'completed', 'terminal stale-running path is reconciled immediately');
  assert.equal((await request(baseUrl, '/api/runs/terminal-running/report')).status, 200, 'terminal reconciliation fills the missing report');

  const failedClaim = await ensure('failed', 2, expected('failed run', 20260815, 2));
  assert.equal(failedClaim.status, 202);
  assert.equal(failedClaim.body.status, 'failed', 'ensure must surface a persisted failure instead of erasing it with an implicit retry');
  assert.equal(failedClaim.body.failure, 'fixture failure');
  assert.equal((await request(baseUrl, '/api/runs/failed/state')).body.clock.elapsedMonths, 0);

  process.stdout.write('evolution resumable server protocol tests passed\n');
} finally {
  await stopServer();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
