import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-civilization-sequence-test-'));
const bundlePath = path.join(temporaryDirectory, 'eland-session.mjs');
const originalWorkingDirectory = process.cwd();

try {
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    path.join(projectRoot, 'server/elandSession.ts'),
    '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  process.chdir(temporaryDirectory);
  process.env.THREEBODY_DATA_DIR = path.join(temporaryDirectory, 'global-database');
  const { ElandSessionManager } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const databaseDir = path.join(temporaryDirectory, 'manager-database');
  const skySample = {
    fromTime: 0,
    toTime: 0,
    fluxMean: 1,
    fluxMin: 1,
    fluxMax: 1,
    nearestStarDistance: 1,
    fate: 'stable',
  };

  const manager = new ElandSessionManager({ databaseDir });
  const firstFrame = manager.begin('test-run', 'creation-a', 101, skySample);
  const retriedFrame = manager.begin('test-run', 'creation-a', 101, skySample);
  assert.equal(firstFrame.civilizationId, 1);
  assert.equal(retriedFrame.civilizationId, 1, '同一创建标识重试不得重复领取文明号');
  const secondFrame = manager.begin('test-run', 'creation-b', 102, skySample);
  assert.equal(secondFrame.civilizationId, 2, '新的创建标识才应领取下一个文明号');
  assert.equal(manager.persist('test-run'), true);
  manager.close();

  const restoredManager = new ElandSessionManager({ databaseDir });
  const restoredRetry = restoredManager.begin('test-run', 'creation-b', 102, skySample);
  assert.equal(restoredRetry.civilizationId, 2, '重启恢复后，同一创建标识仍须幂等');
  assert.equal(
    restoredManager.begin('test-run', 'creation-c', 103, skySample).civilizationId,
    3,
    '恢复旧会话不得额外分配，新文明应从 SQLite 高水位继续',
  );
  restoredManager.close();

  process.stdout.write('SQLite civilization sequence tests passed\n');
} finally {
  process.chdir(originalWorkingDirectory);
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
