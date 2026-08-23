import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-embodiment-session-'));
const bundlePath = path.join(temporaryDirectory, 'eland-session.mjs');

function skyAt(month) {
  return {
    fromTime: Math.max(0, month - 1),
    toTime: month,
    fluxMean: 1,
    fluxMin: 1,
    fluxMax: 1,
    nearestStarDistance: 1,
    fate: 'stable',
  };
}

try {
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    path.join(projectRoot, 'server/elandSession.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ]);
  process.env.THREEBODY_DATA_DIR = path.join(temporaryDirectory, 'database');
  process.env.THREEBODY_ENV_FILE = path.join(temporaryDirectory, 'missing.env');
  delete process.env.KIMI_API_KEY;
  delete process.env.MOONSHOT_API_KEY;

  const { ElandSession, elandSessions } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const runId = 'limited-embodiment-session';
  const session = new ElandSession(runId, skyAt(0));
  const initial = session.begin(1, 20260824, skyAt(0));
  const actor = initial.society.agents.find((candidate) => candidate.state === 'active');
  assert.ok(actor, '开局必须有可进入的在世人物');

  const beginInput = {
    runId,
    embodimentId: 'embodiment-test-1',
    agentId: actor.id,
    expectedAuthorityRevision: initial.authorityRevision,
    expectedCivilizationId: initial.civilizationId,
    expectedBranchId: initial.branchId,
    expectedElapsedMonths: initial.elapsedMonths,
    skySample: skyAt(1),
  };
  const begun = session.beginEmbodiment(beginInput);
  assert.equal(begun.completedTick, 0);
  assert.equal(begun.nextTick, 1);
  assert.equal(session.latest().elapsedMonths, 0, '暂存月份不得提前改写 committed frame');
  assert.equal(session.beginEmbodiment(beginInput).id, begun.id, '相同 begin 必须幂等');

  const beforeTickSnapshot = session.recoverySnapshot();
  assert.ok(beforeTickSnapshot?.activeEmbodiment, '开始后必须可恢复暂存月份');
  const restored = ElandSession.restore(beforeTickSnapshot, runId);
  assert.equal(restored.embodimentView()?.nextTick, 1);

  const command = {
    runId,
    embodimentId: begun.id,
    commandId: 'command-test-1',
    expectedRevision: 0,
    expectedTick: 1,
    command: { kind: 'wait' },
  };
  const firstTick = await restored.stepEmbodiment(command);
  assert.ok('embodiment' in firstTick);
  assert.equal(firstTick.receipt.completedTick, 1);
  assert.equal(firstTick.embodiment.nextTick, 2);
  const duplicateTick = await restored.stepEmbodiment(command);
  assert.deepEqual(duplicateTick.receipt, firstTick.receipt, '重试 commandId 不得再推进刻度');

  const tickSnapshot = restored.recoverySnapshot();
  assert.equal(tickSnapshot?.activeEmbodiment?.completedTick, 1);
  const restoredAgain = ElandSession.restore(tickSnapshot, runId);
  assert.equal(restoredAgain.embodimentView()?.nextTick, 2, '第 1 刻必须能确定性重放');

  const release = {
    runId,
    embodimentId: begun.id,
    releaseId: 'release-test-1',
    expectedRevision: 1,
  };
  const released = await restoredAgain.releaseEmbodiment(release);
  assert.equal(released.committedFrame.elapsedMonths, 1, '交还必须恰好提交一个完整月份');
  assert.equal(restoredAgain.embodimentView(), null);
  assert.equal(released.committedFrame.society.agents.find((candidate) => candidate.id === actor.id)?.tickPath.length, 16);
  const duplicateRelease = await restoredAgain.releaseEmbodiment(release);
  assert.equal(duplicateRelease.committedFrame.elapsedMonths, 1, '重试 releaseId 不得重复提交月份');

  const completedSnapshot = restoredAgain.recoverySnapshot();
  const finalRestore = ElandSession.restore(completedSnapshot, runId);
  const releaseAfterRestart = await finalRestore.releaseEmbodiment(release);
  assert.equal(releaseAfterRestart.committedFrame.elapsedMonths, 1, '重启后 release 收据仍必须幂等');

  elandSessions.close();
  console.log('limited embodiment session regression passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
