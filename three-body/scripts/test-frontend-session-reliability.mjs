import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-frontend-session-test-'));
const isolatedEnvironmentNames = [
  'THREEBODY_MODEL_CONFIG',
  'THREEBODY_ENV_FILE',
  'KIMI_API_KEY',
  'MOONSHOT_API_KEY',
  'THREEBODY_DATA_DIR',
];
const originalEnvironment = new Map(isolatedEnvironmentNames.map((name) => [name, process.env[name]]));
let globalSessionManager;

function bundle(source, name) {
  const bundlePath = path.join(temporaryDirectory, `${name}.mjs`);
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    source,
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  return bundlePath;
}

try {
  const skyBundle = bundle('src/game/eland/transactional-sky-sampler.ts', 'sky-sampler');
  const { TransactionalSkySampler } = await import(
    `${pathToFileURL(skyBundle).href}?test=${Date.now()}`
  );
  const sampler = new TransactionalSkySampler();
  sampler.observe({ time: 1, flux: 2, nearestStarDistance: 4, fate: 'chaotic-heat' });
  sampler.observe({ time: 2, flux: 0.5, nearestStarDistance: 3, fate: 'chaotic-cold' });

  const failed = sampler.prepare('stable');
  assert.deepEqual(failed.sample, {
    fromTime: 0,
    toTime: 2,
    fluxMean: 1.25,
    fluxMin: 0.5,
    fluxMax: 2,
    nearestStarDistance: 3,
    fate: 'chaotic-cold',
  });
  sampler.observe({ time: 3, flux: 3, nearestStarDistance: 2, fate: 'chaotic-heat' });
  assert.equal(sampler.rollback(failed), true);

  const retried = sampler.prepare('stable');
  assert.equal(retried.sample.fromTime, 0, '失败请求不得前移已确认游标');
  assert.equal(retried.sample.toTime, 3);
  assert.equal(retried.sample.fluxMean, (2 + 0.5 + 3) / 3);
  assert.equal(retried.sample.fluxMin, 0.5, '失败区间的极小值必须参与重试');
  assert.equal(retried.sample.fluxMax, 3, '请求期间的新极大值必须参与重试');
  assert.equal(sampler.commit(retried), true);

  sampler.observe({ time: 4, flux: 1.5, nearestStarDistance: 5, fate: 'stable' });
  const next = sampler.prepare('stable');
  assert.equal(next.sample.fromTime, 3, '只有成功确认后才能前移采样游标');
  assert.equal(next.sample.toTime, 4);
  assert.equal(next.sample.fluxMean, 1.5, '成功区间不得污染后续采样');

  const clientBundle = bundle('src/game/elandClient.ts', 'eland-client');
  const {
    ElandBackendUnavailableError,
    ElandRequestTimeoutError,
    elandClient,
  } = await import(
    `${pathToFileURL(clientBundle).href}?test=${Date.now()}`
  );
  const runId = 'frontend-recovery-test';
  const skySample = {
    fromTime: 0,
    toTime: 1,
    fluxMean: 1,
    fluxMin: 1,
    fluxMax: 1,
    nearestStarDistance: 1,
    fate: 'stable',
  };
  const world = {
    width: 1,
    height: 1,
    levels: 1,
    generator: { version: 'test', seed: 1 },
    palette: [],
    surface: [0],
    elevation: [0],
    columns: [[]],
    biomes: ['plain'],
    activity: { traffic: [0], transfer: [0], action: [0], attention: [0] },
  };
  const previous = {
    runId,
    authorityRevision: 'authority-frontend-recovery',
    branchId: 'main',
    civilizationId: 1,
    elapsedMonths: 1,
    universeTime: 1,
    skySample,
    society: { world, agents: [] },
    entries: [],
    speaker: null,
    civilizationEnd: null,
  };
  const authorityFrame = (
    authorityRunId,
    civilizationId,
    branchId,
    elapsedMonths,
    authorityRevision = `authority-${branchId}`,
  ) => ({
    ...structuredClone(previous),
    runId: authorityRunId,
    authorityRevision,
    civilizationId,
    branchId,
    elapsedMonths,
    universeTime: skySample.toTime,
    skySample,
  });
  const refreshedFrame = structuredClone(previous);
  refreshedFrame.elapsedMonths = 2;
  refreshedFrame.universeTime = 2;
  const authoritativeHistory = [
    { id: 'history-1', month: 1, text: '第一条', tone: 'plain' },
    { id: 'history-2', month: 2, text: '补回的第二条', tone: 'good' },
  ];
  const routes = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    routes.push(String(url));
    if (String(url).endsWith('/begin')) {
      return { ok: true, status: 200, json: async () => previous };
    }
    if (String(url).endsWith('/step')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          kind: 'patch',
          baseElapsedMonths: 99,
          frame: { runId, branchId: 'main', elapsedMonths: 2 },
          society: {},
        }),
      };
    }
    if (String(url).includes('/state?')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          playing: true,
          model: 'local',
          frame: refreshedFrame,
          history: authoritativeHistory,
          historyTotalCount: 12,
          civilizationIndexHistory: [],
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    await elandClient.begin(runId, 'creation', skySample, undefined, 1);
    const recovered = await elandClient.stepWithRecovery(runId, skySample);
    assert.deepEqual(recovered.frame, refreshedFrame);
    assert.deepEqual(
      recovered.authoritativeHistory,
      authoritativeHistory,
      '补丁基线失配后的全量回源必须把权威历史交给调用方',
    );
    assert.equal(recovered.authoritativeHistoryTotalCount, 12,
      '补丁基线失配后的全量回源必须保留服务端历史总数');
    assert.equal(routes.some((route) => route.includes('/state?')), true);

    let successfulSignal;
    globalThis.fetch = async (_url, init) => {
      successfulSignal = init.signal;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          playing: true,
          model: 'local',
          frame: refreshedFrame,
          history: authoritativeHistory,
          historyTotalCount: 12,
          civilizationIndexHistory: [],
        }),
      };
    };
    await elandClient.state(runId, { timeoutMs: 15 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(successfulSignal.aborted, false, '成功请求应清理计时器，不能在返回后被误取消');

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        playing: true,
        model: 'local',
        frame: refreshedFrame,
        history: authoritativeHistory,
        civilizationIndexHistory: [],
      }),
    });
    const legacyStateResponse = await elandClient.state(runId);
    assert.equal(legacyStateResponse.historyTotalCount, authoritativeHistory.length,
      '滚动更新期间旧后端缺少 historyTotalCount 时必须回退到已返回历史长度');

    const timeoutRunId = 'frontend-timeout-test';
    const timeoutInitialFrame = authorityFrame(timeoutRunId, 2, 'timeout-main', 0);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => timeoutInitialFrame });
    await elandClient.begin(timeoutRunId, 'timeout-creation', skySample, undefined, 2);
    const timeoutSampler = new TransactionalSkySampler();
    timeoutSampler.observe({ time: 1, flux: 1, nearestStarDistance: 1, fate: 'stable' });
    const timedAttempt = timeoutSampler.prepare('stable');
    let timedSignal;
    let timedFetchCount = 0;
    let timedRequestBody;
    globalThis.fetch = (_url, init) => {
      timedFetchCount += 1;
      timedSignal = init.signal;
      timedRequestBody = JSON.parse(init.body);
      return new Promise((_resolve, reject) => {
        const rejectAbort = () => reject(timedSignal.reason ?? new DOMException('aborted', 'AbortError'));
        if (timedSignal.aborted) rejectAbort();
        else timedSignal.addEventListener('abort', rejectAbort, { once: true });
      });
    };
    await assert.rejects(
      elandClient.stepWithRecovery(timeoutRunId, timedAttempt.sample, undefined, { timeoutMs: 15 }),
      (error) => error instanceof ElandRequestTimeoutError
        && error.route === 'step'
        && error.timeoutMs === 15,
      '悬挂的 step 必须由统一超时主动取消并保留可识别错误',
    );
    assert.equal(timedSignal.aborted, true);
    assert.equal(timedFetchCount, 1, '非幂等 step 超时后不得在客户端内重试');
    assert.equal(timedRequestBody.expectedElapsedMonths, 0);
    assert.match(timedRequestBody.stepId, /:step:/);
    timeoutSampler.rollback(timedAttempt);
    const retriedAfterTimeout = timeoutSampler.prepare('stable');
    assert.equal(retriedAfterTimeout.sample.fromTime, 0, 'step 超时后天空采样游标不得前移');
    assert.equal(retriedAfterTimeout.sample.toTime, 1);

    const newerSkySample = { ...retriedAfterTimeout.sample, toTime: 2, fluxMean: 2 };
    let retryRequestBody;
    const committedAfterUnknownTimeout = {
      ...structuredClone(previous),
      runId: timeoutRunId,
      authorityRevision: timeoutInitialFrame.authorityRevision,
      branchId: timeoutInitialFrame.branchId,
      civilizationId: timeoutInitialFrame.civilizationId,
      elapsedMonths: 1,
      universeTime: timedRequestBody.skySample.toTime,
      skySample: timedRequestBody.skySample,
    };
    globalThis.fetch = async (_url, init) => {
      retryRequestBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ kind: 'full', frame: committedAfterUnknownTimeout }),
      };
    };
    const recoveredTimedStep = await elandClient.stepWithRecovery(
      timeoutRunId,
      newerSkySample,
      undefined,
      { timeoutMs: 50 },
    );
    assert.equal(retryRequestBody.stepId, timedRequestBody.stepId, '未知结果重试必须复用同一 stepId');
    assert.equal(retryRequestBody.expectedElapsedMonths, 0, '未知结果重试必须保留原权威基线月');
    assert.deepEqual(retryRequestBody.skySample, timedRequestBody.skySample, '未知结果重试不得偷偷换成新的天象区间');
    assert.equal(recoveredTimedStep.skySampleAcknowledged, true, '精确落在 expected+1 且天象相同才算确认');

    const cancelRunId = 'frontend-cancel-step-test';
    const cancelInitialFrame = authorityFrame(cancelRunId, 3, 'cancel-main', 0);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => cancelInitialFrame });
    await elandClient.begin(cancelRunId, 'cancel-creation', skySample, undefined, 3);
    const caller = new AbortController();
    let cancelledRequestBody;
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      cancelledRequestBody = JSON.parse(init.body);
      const rejectAbort = () => reject(init.signal.reason ?? new DOMException('aborted', 'AbortError'));
      if (init.signal.aborted) rejectAbort();
      else init.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const cancelled = elandClient.stepWithRecovery(
      cancelRunId,
      skySample,
      undefined,
      { timeoutMs: 1_000, signal: caller.signal },
    );
    caller.abort();
    await assert.rejects(
      cancelled,
      (error) => error instanceof ElandBackendUnavailableError
        && !(error instanceof ElandRequestTimeoutError)
        && error.message.includes('已取消'),
      '调用方取消应与内部超时合并，但仍保持可区分的错误语义',
    );
    let cancelledRetryBody;
    const committedAfterCancellation = {
      ...structuredClone(previous),
      runId: cancelRunId,
      authorityRevision: cancelInitialFrame.authorityRevision,
      branchId: cancelInitialFrame.branchId,
      civilizationId: cancelInitialFrame.civilizationId,
      elapsedMonths: 1,
      universeTime: cancelledRequestBody.skySample.toTime,
      skySample: cancelledRequestBody.skySample,
    };
    globalThis.fetch = async (_url, init) => {
      cancelledRetryBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ kind: 'full', frame: committedAfterCancellation }),
      };
    };
    await elandClient.stepWithRecovery(cancelRunId, newerSkySample);
    assert.equal(cancelledRetryBody.stepId, cancelledRequestBody.stepId, '调用方取消后仍须复用未知结果的 stepId');

    const verifyAuthoritySwitch = async ({
      runId: authorityRunId,
      initialFrame,
      switchedFrame,
      switchCall,
    }) => {
      globalThis.fetch = async (url) => {
        assert.equal(String(url).endsWith('/begin'), true);
        return { ok: true, status: 200, json: async () => initialFrame };
      };
      await elandClient.begin(authorityRunId, 'initial-authority', skySample, undefined, 1);

      let resolveDelayedStep;
      globalThis.fetch = (url) => {
        assert.equal(String(url).endsWith('/step'), true);
        return new Promise((resolve) => { resolveDelayedStep = resolve; });
      };
      const delayedStep = elandClient.stepWithRecovery(authorityRunId, skySample);
      await Promise.resolve();

      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => switchCall.response });
      await switchCall.execute();
      const oldAdvancedFrame = {
        ...initialFrame,
        elapsedMonths: initialFrame.elapsedMonths + 1,
      };
      resolveDelayedStep({
        ok: true,
        status: 200,
        json: async () => ({ kind: 'full', frame: oldAdvancedFrame }),
      });
      const delayedResult = await delayedStep;
      assert.equal(delayedResult.frame?.civilizationId, switchedFrame.civilizationId);
      assert.equal(delayedResult.frame?.branchId, switchedFrame.branchId, '延迟旧 full 响应不得覆盖切换后的 authority cache');
      assert.equal(delayedResult.frame?.elapsedMonths, switchedFrame.elapsedMonths);
      assert.equal(delayedResult.skySampleAcknowledged, false);

      let nextStepBody;
      const switchedAdvancedFrame = {
        ...switchedFrame,
        elapsedMonths: switchedFrame.elapsedMonths + 1,
      };
      globalThis.fetch = async (url, init) => {
        assert.equal(String(url).endsWith('/step'), true);
        nextStepBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ kind: 'full', frame: switchedAdvancedFrame }),
        };
      };
      await elandClient.stepWithRecovery(authorityRunId, skySample);
      assert.equal(nextStepBody.expectedAuthorityRevision, switchedFrame.authorityRevision);
      assert.equal(nextStepBody.expectedCivilizationId, switchedFrame.civilizationId);
      assert.equal(nextStepBody.expectedBranchId, switchedFrame.branchId);
      assert.equal(nextStepBody.expectedElapsedMonths, switchedFrame.elapsedMonths);
    };

    const beginSwitchRunId = 'frontend-authority-begin-test';
    const beginInitial = authorityFrame(beginSwitchRunId, 11, 'begin-old', 0);
    const beginSwitched = authorityFrame(beginSwitchRunId, 12, 'begin-new', 0);
    await verifyAuthoritySwitch({
      runId: beginSwitchRunId,
      initialFrame: beginInitial,
      switchedFrame: beginSwitched,
      switchCall: {
        response: beginSwitched,
        execute: () => elandClient.begin(beginSwitchRunId, 'replacement-authority', skySample, undefined, 2),
      },
    });

    const loadSwitchRunId = 'frontend-authority-load-test';
    const loadInitial = authorityFrame(loadSwitchRunId, 21, 'load-same', 4, 'authority-load-live');
    const loadSwitched = authorityFrame(loadSwitchRunId, 21, 'load-same', 4, 'authority-load-restored');
    await verifyAuthoritySwitch({
      runId: loadSwitchRunId,
      initialFrame: loadInitial,
      switchedFrame: loadSwitched,
      switchCall: {
        response: {
          save: { id: 'save-authority' },
          frame: loadSwitched,
          history: [],
          historyTotalCount: 0,
          civilizationIndexHistory: [],
        },
        execute: () => elandClient.loadSave(loadSwitchRunId, 'save-authority'),
      },
    });

    const seekSwitchRunId = 'frontend-authority-seek-test';
    const seekInitial = authorityFrame(seekSwitchRunId, 31, 'seek-old', 3);
    const seekSwitched = authorityFrame(seekSwitchRunId, 31, 'seek-fork', 3);
    await verifyAuthoritySwitch({
      runId: seekSwitchRunId,
      initialFrame: seekInitial,
      switchedFrame: seekSwitched,
      switchCall: {
        response: seekSwitched,
        execute: () => elandClient.seek(seekSwitchRunId, 3),
      },
    });

    const serverBundle = bundle('server/elandSession.ts', 'eland-session');
    delete process.env.THREEBODY_MODEL_CONFIG;
    process.env.THREEBODY_ENV_FILE = path.join(temporaryDirectory, 'missing.env');
    delete process.env.KIMI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    process.env.THREEBODY_DATA_DIR = path.join(temporaryDirectory, 'global-database');
    const {
      ElandSession,
      ElandStepConflictError,
      elandSessions,
    } = await import(`${pathToFileURL(serverBundle).href}?test=${Date.now()}`);
    globalSessionManager = elandSessions;
    const frozenSky = {
      fromTime: 0,
      toTime: 0,
      fluxMean: 1,
      fluxMin: 1,
      fluxMax: 1,
      nearestStarDistance: 1,
      fate: 'stable',
    };
    const session = new ElandSession('step-idempotency-test', frozenSky);
    const foundingFrame = session.begin(1, 20260820, frozenSky);
    await assert.rejects(
      session.step({
        stepId: 'partial-authority-step',
        expectedElapsedMonths: foundingFrame.elapsedMonths,
        skySample: frozenSky,
      }),
      (error) => error instanceof ElandStepConflictError,
      '带 stepId 的请求不能只给月份，必须携带完整权威身份',
    );
    const firstOptions = {
      stepId: 'same-authority-step',
      expectedAuthorityRevision: foundingFrame.authorityRevision,
      expectedCivilizationId: foundingFrame.civilizationId,
      expectedBranchId: foundingFrame.branchId,
      expectedElapsedMonths: 0,
      skySample: frozenSky,
    };
    const firstAuthorityStep = session.step(firstOptions);
    const concurrentDuplicate = session.step(firstOptions);
    const concurrentAlias = session.step({
      ...firstOptions,
      stepId: 'same-baseline-other-caller',
    });
    const concurrentFrames = await Promise.all([firstAuthorityStep, concurrentDuplicate, concurrentAlias]);
    assert.deepEqual(concurrentFrames.map((frame) => frame?.elapsedMonths), [1, 1, 1]);
    assert.equal(session.latest()?.elapsedMonths, 1, '同一基线月的并发请求只能推进一个权威月份');

    const completedRetry = await session.step(firstOptions);
    assert.equal(completedRetry?.elapsedMonths, 1, '已完成 stepId 的重试只能确认，不得二次推进');
    const staleNewIdentity = await session.step({
      ...firstOptions,
      stepId: 'stale-baseline-new-identity',
    });
    assert.equal(staleNewIdentity?.elapsedMonths, 1, '即使换 stepId，陈旧 expected 月也不得二次推进');
    await assert.rejects(
      session.step({
        ...firstOptions,
        skySample: { ...frozenSky, fluxMean: 2 },
      }),
      (error) => error instanceof ElandStepConflictError,
      '同一 stepId 不得绑定到不同请求内容',
    );
    const sourceBranchId = session.latest()?.branchId;
    const sourceAuthorityRevision = session.latest()?.authorityRevision;
    const forkFrame = session.seek(0);
    assert.ok(forkFrame);
    assert.notEqual(forkFrame.branchId, sourceBranchId);
    const oldBranchRequest = await session.step({
      stepId: 'old-branch-same-month',
      expectedAuthorityRevision: sourceAuthorityRevision,
      expectedCivilizationId: forkFrame.civilizationId,
      expectedBranchId: sourceBranchId,
      expectedElapsedMonths: forkFrame.elapsedMonths,
      skySample: frozenSky,
    });
    assert.equal(oldBranchRequest?.branchId, forkFrame.branchId);
    assert.equal(oldBranchRequest?.elapsedMonths, 0, '旧分支请求不得在同月新分支上推进');
    const forkedAuthorityStep = await session.step({
      stepId: 'forked-authority-step',
      expectedAuthorityRevision: forkFrame.authorityRevision,
      expectedCivilizationId: forkFrame.civilizationId,
      expectedBranchId: forkFrame.branchId,
      expectedElapsedMonths: forkFrame.elapsedMonths,
      skySample: frozenSky,
    });
    assert.equal(forkedAuthorityStep?.branchId, forkFrame.branchId);
    assert.equal(forkedAuthorityStep?.elapsedMonths, 1);
    const nextAuthorityStep = await session.step({
      stepId: 'next-authority-step',
      expectedAuthorityRevision: forkedAuthorityStep.authorityRevision,
      expectedCivilizationId: forkedAuthorityStep.civilizationId,
      expectedBranchId: forkedAuthorityStep.branchId,
      expectedElapsedMonths: 1,
      skySample: frozenSky,
    });
    assert.equal(nextAuthorityStep?.elapsedMonths, 2, '只有基于最新权威月的新请求才能继续推进');

    const loadSource = new ElandSession('same-triple-load-test', frozenSky);
    const loadSourceFrame = loadSource.begin(41, 20260820, frozenSky);
    const loadSnapshot = loadSource.recoverySnapshot();
    assert.ok(loadSnapshot);
    const loadedReplacement = ElandSession.restore(loadSnapshot);
    const loadedHead = loadedReplacement.latest();
    assert.ok(loadedHead);
    assert.equal(loadedHead.civilizationId, loadSourceFrame.civilizationId);
    assert.equal(loadedHead.branchId, loadSourceFrame.branchId);
    assert.equal(loadedHead.elapsedMonths, loadSourceFrame.elapsedMonths);
    assert.notEqual(loadedHead.authorityRevision, loadSourceFrame.authorityRevision, '载入同一快照也必须生成新的不透明权威修订');
    const delayedPreLoadStep = await loadedReplacement.step({
      stepId: 'delayed-pre-load-step',
      expectedAuthorityRevision: loadSourceFrame.authorityRevision,
      expectedCivilizationId: loadSourceFrame.civilizationId,
      expectedBranchId: loadSourceFrame.branchId,
      expectedElapsedMonths: loadSourceFrame.elapsedMonths,
      skySample: frozenSky,
    });
    assert.equal(delayedPreLoadStep?.elapsedMonths, 0, '同三元组旧 revision 不得推进载入后的新 session');
    assert.equal(delayedPreLoadStep?.authorityRevision, loadedHead.authorityRevision);
    const postLoadStep = await loadedReplacement.step({
      stepId: 'post-load-step',
      expectedAuthorityRevision: loadedHead.authorityRevision,
      expectedCivilizationId: loadedHead.civilizationId,
      expectedBranchId: loadedHead.branchId,
      expectedElapsedMonths: loadedHead.elapsedMonths,
      skySample: frozenSky,
    });
    assert.equal(postLoadStep?.elapsedMonths, 1, '只有载入后 revision 的完整身份才能推进');
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log('frontend session reliability tests passed (history resync, timeout recovery, idempotent authority step)');
} finally {
  globalSessionManager?.close();
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
