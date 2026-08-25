import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-session-replay-test-'));
const bundlePath = path.join(temporaryDirectory, 'eland-session.mjs');
const originalWorkingDirectory = process.cwd();
const isolatedEnvironmentNames = [
  'THREEBODY_MODEL_CONFIG',
  'THREEBODY_ENV_FILE',
  'KIMI_API_KEY',
  'MOONSHOT_API_KEY',
  'THREEBODY_DATA_DIR',
];
const originalEnvironment = new Map(isolatedEnvironmentNames.map((name) => [name, process.env[name]]));

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

function assertReplayFrame(actual, expected, context) {
  assert.ok(actual, `${context} 应存在`);
  assert.equal(actual.elapsedMonths, expected.elapsedMonths, `${context} 的月份必须一致`);
  assert.ok(isDeepStrictEqual(actual.society, expected.society), `${context} 的社会投影必须可精确回放`);
  assert.ok(isDeepStrictEqual(actual.entries, expected.entries), `${context} 的纪事条目必须可精确回放`);
}

try {
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    path.join(projectRoot, 'server/elandSession.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  // Do not inherit a developer machine's model routes or legacy API keys. This
  // regression covers the fully local, deterministic authority path.
  delete process.env.THREEBODY_MODEL_CONFIG;
  process.env.THREEBODY_ENV_FILE = path.join(temporaryDirectory, 'missing.env');
  delete process.env.KIMI_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  process.env.THREEBODY_DATA_DIR = path.join(temporaryDirectory, 'global-database');
  process.chdir(temporaryDirectory);

  const { ElandSession, ElandSessionManager } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const managerOptions = {
    databaseDir: path.join(temporaryDirectory, 'session-database'),
    recoveryTtlMs: 60_000,
    ttlMs: 60_000,
  };
  const manager = new ElandSessionManager(managerOptions);
  const runId = 'session-replay-run';
  const initial = manager.begin(runId, 'session-replay-creation', 20260820, skyAt(0));
  const frames = new Map([[initial.elapsedMonths, structuredClone(initial)]]);
  const session = manager.get(runId, 'step');
  assert.ok(session, '创建后的实时会话必须可读取');

  for (let month = 1; month <= 25; month += 1) {
    const frame = await session.step({ skySample: skyAt(month) });
    assert.ok(frame, `第 ${month} 月必须返回完整帧`);
    assert.equal(frame.elapsedMonths, month, `本地规则必须完整提交第 ${month} 月`);
    frames.set(month, structuredClone(frame));
  }
  const chronicleBeforeRecovery = structuredClone(session.chronicle());

  const liveSnapshot = session.recoverySnapshot();
  assert.ok(liveSnapshot, '已推进的实时会话必须可生成恢复快照');
  const liveTimeline = liveSnapshot.branches.get(liveSnapshot.activeBranchId);
  assert.ok(liveTimeline, '恢复快照必须包含活动分支');
  assert.equal(liveTimeline.snapshots.get(12)?.kind, 'checkpoint', '第 12 月必须形成完整检查点');
  assert.equal(liveTimeline.snapshots.get(24)?.kind, 'checkpoint', '第 24 月必须形成完整检查点');
  assert.equal(liveTimeline.snapshots.get(11)?.kind, 'delta', '检查点前一月应走增量回放路径');
  assert.equal(liveTimeline.snapshots.get(25)?.kind, 'delta', '检查点后一月应走增量回放路径');

  // Recreate the persisted shape without SQLite so resolver calls are exactly
  // observable. Recovery itself must not touch any historical BLOB, and a
  // normal annual replay window must read one checkpoint plus at most 11 deltas.
  const chunkReferenceKey = '__elandSessionChunkV2';
  const lazyChunks = new Map();
  let chunkSequence = 0;
  const lazyBranches = new Map([...liveSnapshot.branches.entries()].map(([branchId, timeline]) => [
    branchId,
    {
      ...timeline,
      snapshots: new Map([...timeline.snapshots.entries()].map(([month, snapshot]) => {
        const hash = createHash('sha256')
          .update(`${branchId}:${month}:${chunkSequence++}`)
          .digest('hex');
        lazyChunks.set(hash, snapshot.data);
        return [month, { ...snapshot, data: { [chunkReferenceKey]: hash } }];
      })),
    },
  ]));
  let resolvedChunkCount = 0;
  const lazySession = ElandSession.restore(
    { ...liveSnapshot, branches: lazyBranches },
    liveSnapshot.runId,
    (reference) => {
      resolvedChunkCount += 1;
      const data = lazyChunks.get(reference[chunkReferenceKey]);
      assert.ok(Buffer.isBuffer(data), 'resolver 必须只返回已持久化的压缩时间线块');
      return data;
    },
  );
  assert.equal(resolvedChunkCount, 0, '普通恢复不得读取历史 checkpoint/delta BLOB');
  assert.deepEqual(lazySession.chronicle(), chronicleBeforeRecovery, '纪事增量投影必须能只从已存帧重建');
  const lazyRecovery = lazySession.recoverySnapshot();
  const lazyTimeline = lazyRecovery?.branches.get(lazyRecovery.activeBranchId);
  assert.equal(lazyTimeline?.snapshots.get(25)?.kind, 'delta', '恢复不得把有效 head delta 改写为完整 checkpoint');
  assert.equal(
    typeof lazyTimeline?.snapshots.get(25)?.data?.[chunkReferenceKey],
    'string',
    '恢复后时间线应继续持有轻量 hash ref',
  );
  assertReplayFrame(lazySession.frameAt(23), frames.get(23), '懒加载回放第 23 月');
  assert.equal(resolvedChunkCount, 12, '第 23 月只应读取第 12 月 checkpoint 与后续 11 个 delta');
  const replayAgentId = frames.get(23)?.society.agents[0]?.id;
  assert.ok(replayAgentId, '懒加载人物历史测试需要一个可观察人物');
  assert.ok(lazySession.agentHistory(replayAgentId, 23), '人物历史应复用同月重建状态');
  assert.equal(resolvedChunkCount, 12, '同月 frameAt/agentHistory 应复用唯一重建缓存');
  const lazyFork = lazySession.seek(13);
  assert.ok(lazyFork, '懒时间线应能从第 13 月创建分支');
  assert.equal(resolvedChunkCount, 14, 'seek 应只重建一次：第 12 月 checkpoint 加第 13 月 delta');

  for (const [month, expected] of frames) {
    assertReplayFrame(session.frameAt(month), expected, `内存回放第 ${month} 月`);
  }

  assert.equal(manager.persist(runId), true, '实时会话必须成功持久化到隔离恢复目录');
  const persistedInPlace = session.recoverySnapshot();
  const persistedTimeline = persistedInPlace?.branches.get(persistedInPlace.activeBranchId);
  assert.equal(
    typeof persistedTimeline?.snapshots.get(25)?.data?.[chunkReferenceKey],
    'string',
    '首次持久化后活动会话应以 hash ref 替换历史 Buffer',
  );
  assertReplayFrame(session.frameAt(23), frames.get(23), '新建会话持久化后仍应能懒加载历史帧');
  manager.close();
  const restoredManager = new ElandSessionManager(managerOptions);
  assert.equal(restoredManager.size(), 0, '启动时不应把所有休眠会话预先水合进 Worker');
  const restoredSession = restoredManager.get(runId);
  assert.ok(restoredSession, '新 manager 必须从持久化快照恢复实时会话');
  assert.equal(restoredSession.latest()?.elapsedMonths, 25, '恢复后的会话头必须位于第 25 月');
  assert.deepEqual(restoredSession.chronicle(), chronicleBeforeRecovery, 'SQLite 恢复后纪事归并结果必须保持一致');

  for (const [month, expected] of frames) {
    assertReplayFrame(restoredSession.frameAt(month), expected, `持久化恢复后回放第 ${month} 月`);
  }

  const forkMonth = 13;
  const sourceFrame = frames.get(forkMonth);
  assert.ok(sourceFrame, '分叉来源帧必须存在');
  const sourceBranchId = sourceFrame.branchId;
  const forkFrame = restoredSession.seek(forkMonth);
  assertReplayFrame(forkFrame, sourceFrame, `seek 到第 ${forkMonth} 月`);
  assert.notEqual(forkFrame.branchId, sourceBranchId, 'seek 必须创建新分支而不是改写原分支');
  assertReplayFrame(restoredSession.frameAt(forkMonth - 1), frames.get(forkMonth - 1), '新分支应继承分叉前一月');
  assertReplayFrame(restoredSession.frameAt(forkMonth), sourceFrame, '新分支应保留分叉月投影');
  assert.equal(restoredSession.frameAt(forkMonth + 1), null, '新分支不能泄漏原分支未来帧');
  assert.ok(
    restoredSession.chronicle().every((entry) => entry.month <= forkMonth),
    '新分支的纪事投影不能继承分叉月之后的条目',
  );

  const forkedNextFrame = await restoredSession.step({ skySample: skyAt(forkMonth + 1) });
  assert.ok(forkedNextFrame, '分叉后的本地会话必须可以继续推进');
  assert.equal(forkedNextFrame.elapsedMonths, forkMonth + 1);
  assert.equal(forkedNextFrame.branchId, forkFrame.branchId, '分叉后的新月份必须提交到活动分支');
  assert.equal(
    forkedNextFrame.society.world.generator.seed,
    sourceFrame.society.world.generator.seed,
    '分叉不得改变权威世界种子',
  );
  const fork = restoredSession.branchList().find((branch) => branch.id === forkFrame.branchId);
  assert.deepEqual(fork, {
    id: forkFrame.branchId,
    parentBranchId: sourceBranchId,
    forkAtMonth: forkMonth,
    headAtMonth: forkMonth + 1,
    active: true,
  }, '分支元数据必须记录父分支、分叉月和新分支头');

  assert.equal(restoredManager.persist(runId), true, '分叉后的会话应可再次持久化');
  restoredManager.close();
  const dormantManager = new ElandSessionManager(managerOptions);
  assert.equal(dormantManager.size(), 0, '只扫描到恢复元数据不应算作已水合会话');
  assert.equal(dormantManager.end(runId), true, '未水合的休眠会话仍应可被正常结束');
  assert.equal(dormantManager.get(runId), null, '结束休眠会话应同时移除恢复文件');
  dormantManager.close();

  process.stdout.write('session replay tests passed (25 local months, lazy recovery, persistence, seek/fork)\n');
} finally {
  process.chdir(originalWorkingDirectory);
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
