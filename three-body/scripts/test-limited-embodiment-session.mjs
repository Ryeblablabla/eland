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

  const {
    ElandSession,
    elandSessions,
    stagedExecutionHashForRecoveryVersion,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
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
  const legacyBeforeTickSnapshot = structuredClone(beforeTickSnapshot);
  delete legacyBeforeTickSnapshot.latestState.world.historyCursor;
  const restored = ElandSession.restore(legacyBeforeTickSnapshot, runId);
  assert.equal(restored.embodimentView()?.nextTick, 1);
  assert.ok(
    restored.latestState.world.historyCursor,
    '旧暂存快照恢复后应在可信state adoption边界补全history cursor',
  );
  const committedPastBeforeTick = restored.latestState.world.past;
  const stagedPastBeforeTick = restored.embodimentCoordinator.execution.prepared.state.world.past;
  assert.notEqual(stagedPastBeforeTick, committedPastBeforeTick, '进入化身时仍必须隔离 committed history');
  const committedPastJsonBeforeTick = JSON.stringify(committedPastBeforeTick);

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
  assert.equal(
    restored.embodimentCoordinator.execution.prepared.state.world.past,
    stagedPastBeforeTick,
    '普通规划刻度应共享不可变的已提交历史，避免逐刻深拷贝',
  );
  assert.equal(JSON.stringify(restored.latestState.world.past), committedPastJsonBeforeTick, '暂存刻度不得改写 committed history');
  const duplicateTick = await restored.stepEmbodiment(command);
  assert.deepEqual(duplicateTick.receipt, firstTick.receipt, '重试 commandId 不得再推进刻度');

  const tickSnapshot = restored.recoverySnapshot();
  assert.equal(tickSnapshot?.activeEmbodiment?.completedTick, 1);
  assert.equal(tickSnapshot?.activeEmbodiment?.stagedStateHashVersion, 3);
  const restoredAgain = ElandSession.restore(tickSnapshot, runId);
  assert.equal(restoredAgain.embodimentView()?.nextTick, 2, '第 1 刻必须能确定性重放');

  const tickExecution = restored.embodimentCoordinator.execution;
  const oldV2Hash = stagedExecutionHashForRecoveryVersion(tickExecution, 2);
  const cadenceVariant = {
    ...tickExecution,
    ordinaryDeliberationCounts: new Map([
      ...tickExecution.ordinaryDeliberationCounts,
      ['v2-compatibility-fixture', 99],
    ]),
    ordinaryReplanPermits: new Set([
      ...tickExecution.ordinaryReplanPermits,
      'v2-compatibility-fixture',
    ]),
  };
  assert.equal(
    stagedExecutionHashForRecoveryVersion(cadenceVariant, 2),
    oldV2Hash,
    '旧 v2 hash 必须继续忽略当时尚不存在的月度复议节拍字段',
  );
  assert.notEqual(
    stagedExecutionHashForRecoveryVersion(cadenceVariant, 3),
    stagedExecutionHashForRecoveryVersion(tickExecution, 3),
    'v3 hash 必须保护新增的月度复议节拍状态',
  );
  const oldV2TickSnapshot = structuredClone(tickSnapshot);
  oldV2TickSnapshot.activeEmbodiment.stagedStateHashVersion = 2;
  oldV2TickSnapshot.activeEmbodiment.stagedStateHash = oldV2Hash;
  const restoredFromV2 = ElandSession.restore(oldV2TickSnapshot, runId);
  assert.equal(restoredFromV2.embodimentView()?.nextTick, 2, '旧 v2 在途月份不得因 hash 升级被丢弃');
  const migratedV2Snapshot = restoredFromV2.recoverySnapshot();
  assert.equal(
    migratedV2Snapshot?.activeEmbodiment?.stagedStateHashVersion,
    3,
    '严格验签后的旧 v2 快照必须原地迁移为 v3',
  );
  assert.equal(
    migratedV2Snapshot?.activeEmbodiment?.stagedStateHash,
    stagedExecutionHashForRecoveryVersion(restoredFromV2.embodimentCoordinator.execution, 3),
    '迁移后的快照必须持久化 cadence-aware v3 hash',
  );
  const migratedSecondTick = await restoredFromV2.stepEmbodiment({
    runId,
    embodimentId: begun.id,
    commandId: 'command-v2-migrated-tick-2',
    expectedRevision: 1,
    expectedTick: 2,
    command: { kind: 'wait' },
  });
  assert.ok('embodiment' in migratedSecondTick);
  assert.equal(migratedSecondTick.receipt.completedTick, 2, '迁移后的旧 v2 在途月份必须可继续执行');

  const mismatchedTickSnapshot = structuredClone(tickSnapshot);
  mismatchedTickSnapshot.activeEmbodiment.stagedStateHash = '0'.repeat(64);
  assert.throws(
    () => ElandSession.restore(mismatchedTickSnapshot, runId),
    /有限化身暂存月份重放 hash 不一致/,
    '无法由当前或旧版规范 hash 严格验证的暂存月份必须失败关闭',
  );

  const release = {
    runId,
    embodimentId: begun.id,
    releaseId: 'release-test-1',
    expectedRevision: 1,
  };
  const releaseCoordinator = restoredAgain.embodimentCoordinator;
  const stagedPastBeforeRelease = releaseCoordinator.execution.prepared.state.world.past;
  const stagedPastJsonBeforeRelease = JSON.stringify(stagedPastBeforeRelease);
  const commitMonth = releaseCoordinator.host.commitMonth;
  releaseCoordinator.host.commitMonth = async () => {
    throw new Error('forced embodiment commit failure');
  };
  await assert.rejects(
    restoredAgain.releaseEmbodiment(release),
    /forced embodiment commit failure/,
    '月份提交失败必须向调用方暴露',
  );
  assert.equal(restoredAgain.embodimentCoordinator, releaseCoordinator, '提交失败后应保留原化身协调器以便重试');
  assert.equal(releaseCoordinator.execution.prepared.state.world.past, stagedPastBeforeRelease, '失败提交不得替换原暂存历史');
  assert.equal(JSON.stringify(stagedPastBeforeRelease), stagedPastJsonBeforeRelease, '失败提交不得向原暂存历史追加事件');
  releaseCoordinator.host.commitMonth = commitMonth;
  const released = await restoredAgain.releaseEmbodiment(release);
  assert.equal(released.committedFrame.elapsedMonths, 1, '交还必须恰好提交一个完整月份');
  assert.equal(restoredAgain.embodimentView(), null);
  assert.notEqual(restoredAgain.latestState.world.past, stagedPastBeforeRelease, '月份收束前必须分离已提交历史数组');
  assert.deepEqual(
    restoredAgain.latestState.world.past.slice(0, stagedPastBeforeRelease.length),
    stagedPastBeforeRelease,
    '新月历史必须保留原已提交事实前缀',
  );
  assert.equal(released.committedFrame.society.agents.find((candidate) => candidate.id === actor.id)?.tickPath.length, 16);
  const duplicateRelease = await restoredAgain.releaseEmbodiment(release);
  assert.equal(duplicateRelease.committedFrame.elapsedMonths, 1, '重试 releaseId 不得重复提交月份');

  const completedSnapshot = restoredAgain.recoverySnapshot();
  const finalRestore = ElandSession.restore(completedSnapshot, runId);
  const releaseAfterRestart = await finalRestore.releaseEmbodiment(release);
  assert.equal(releaseAfterRestart.committedFrame.elapsedMonths, 1, '重启后 release 收据仍必须幂等');

  const monthOne = finalRestore.latest();
  const tickFifteenBegin = finalRestore.beginEmbodiment({
    runId,
    embodimentId: 'embodiment-test-tick-15',
    agentId: actor.id,
    expectedAuthorityRevision: monthOne.authorityRevision,
    expectedCivilizationId: monthOne.civilizationId,
    expectedBranchId: monthOne.branchId,
    expectedElapsedMonths: monthOne.elapsedMonths,
    skySample: skyAt(2),
  });
  let finalCommand;
  for (let tick = 1; tick <= 14; tick += 1) {
    const result = await finalRestore.stepEmbodiment({
      runId,
      embodimentId: tickFifteenBegin.id,
      commandId: `command-tick-15-${tick}`,
      expectedRevision: tick - 1,
      expectedTick: tick,
      command: { kind: 'wait' },
    });
    assert.ok('embodiment' in result, `第 ${tick} 刻不得提前提交月份`);
  }
  const tickFifteenPast = finalRestore.embodimentCoordinator.execution.prepared.state.world.past;
  finalCommand = {
    runId,
    embodimentId: tickFifteenBegin.id,
    commandId: 'command-tick-15-15',
    expectedRevision: 14,
    expectedTick: 15,
    command: { kind: 'wait' },
  };
  const tickFifteen = await finalRestore.stepEmbodiment(finalCommand);
  assert.ok('committedFrame' in tickFifteen, '第 15 刻必须直接提交完整月份');
  assert.notEqual(finalRestore.latestState.world.past, tickFifteenPast, '第 15 刻收束前必须分离已提交历史数组');
  assert.deepEqual(
    finalRestore.latestState.world.past.slice(0, tickFifteenPast.length),
    tickFifteenPast,
    '第 15 刻提交必须保留原历史前缀',
  );
  const tickFifteenSnapshot = finalRestore.recoverySnapshot();
  const tickFifteenRestore = ElandSession.restore(tickFifteenSnapshot, runId);
  const duplicateFinalTick = await tickFifteenRestore.stepEmbodiment(finalCommand);
  assert.equal(duplicateFinalTick.committedFrame.elapsedMonths, 2, '第 15 刻的完成收据重启后仍必须幂等');

  elandSessions.close();
  console.log('limited embodiment session regression passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
