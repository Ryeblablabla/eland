import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const [runId, startMonthText, monthCountText, databasePath = 'data/eland.sqlite3'] = process.argv.slice(2);
const startMonth = Number(startMonthText);
const monthCount = Number(monthCountText);
if (!runId || !Number.isInteger(startMonth) || !Number.isInteger(monthCount) || monthCount <= 0) {
  throw new Error('用法: node scripts/benchmark-checkpoint-equivalence.mjs <run-id> <start-month> <months> [database-path]');
}

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-checkpoint-benchmark-'));
const codecBundlePath = path.join(temporaryDirectory, 'run-state-codec.mjs');
const executorBundlePath = path.join(temporaryDirectory, 'tick-executor.mjs');
const database = new DatabaseSync(path.resolve(databasePath), { readOnly: true });

function checkpointHash(month) {
  const row = database.prepare(`
    SELECT state_hash
    FROM run_checkpoints
    WHERE run_id = ? AND month = ?
    ORDER BY revision DESC
    LIMIT 1
  `).get(runId, month);
  if (!row) throw new Error(`运行 ${runId} 缺少第 ${month} 月检查点`);
  return String(row.state_hash);
}

function chunk(hash) {
  const row = database.prepare(`
    SELECT hash, codec, raw_size, data
    FROM chunks
    WHERE hash = ?
  `).get(hash);
  if (!row) throw new Error(`缺少状态块 ${hash}`);
  return {
    hash: String(row.hash),
    codec: String(row.codec),
    rawSize: Number(row.raw_size),
    data: row.data,
  };
}

try {
  const esbuild = path.resolve('node_modules/.bin/esbuild');
  execFileSync(esbuild, [
    'server/run-state-codec.ts',
    '--bundle', '--platform=node', '--format=esm', `--outfile=${codecBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(esbuild, [
    'src/game/eland/application/simulation/tick-executor.ts',
    '--bundle', '--platform=node', '--format=esm', `--outfile=${executorBundlePath}`,
  ], { stdio: 'pipe' });

  const [{ decodeSegmentedRunState }, { stepOwnedSimulation }] = await Promise.all([
    import(`${pathToFileURL(codecBundlePath).href}?benchmark=${Date.now()}`),
    import(`${pathToFileURL(executorBundlePath).href}?benchmark=${Date.now()}`),
  ]);
  const expectedMonth = startMonth + monthCount;
  const [start, expected] = await Promise.all([
    decodeSegmentedRunState(chunk(checkpointHash(startMonth)), chunk),
    decodeSegmentedRunState(chunk(checkpointHash(expectedMonth)), chunk),
  ]);

  let candidate = start.state;
  const monthTimingsMs = [];
  const startedAt = performance.now();
  for (let offset = 0; offset < monthCount; offset += 1) {
    const monthStartedAt = performance.now();
    candidate = stepOwnedSimulation(candidate);
    monthTimingsMs.push(Math.round(performance.now() - monthStartedAt));
  }
  const elapsedMs = Math.round(performance.now() - startedAt);

  assert.deepEqual(candidate, expected.state, `候选实现与既有第 ${expectedMonth} 月权威检查点不一致`);
  process.stdout.write(`${JSON.stringify({
    runId,
    startMonth,
    expectedMonth,
    elapsedMs,
    monthTimingsMs,
    eventCount: candidate.world.past.length,
    intents: candidate.intents.length,
    agreements: candidate.agreements.length,
    projects: candidate.projects.length,
    deeplyEquivalent: true,
  }, null, 2)}\n`);
} finally {
  database.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
