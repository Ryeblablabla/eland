import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-domain-history-v25-'));
const historyBundlePath = path.join(temporaryDirectory, 'history.mjs');
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const settlementBundlePath = path.join(temporaryDirectory, 'settlement.mjs');
const monthBoundaryBundlePath = path.join(temporaryDirectory, 'month-boundary.mjs');

function event(id, atMonth = 0) {
  return {
    id,
    kind: 'environment',
    atMonth,
    orderInMonth: 0,
    planningTick: 0,
    orderInTick: 0,
    cellId: 0,
    change: 'condition',
    result: id,
    diff: {},
  };
}

function fixture(events, historyCursor) {
  return {
    world: {
      past: events,
      ...(historyCursor ? { historyCursor } : {}),
    },
  };
}

try {
  const esbuild = path.resolve('node_modules/.bin/esbuild');
  for (const [entry, outfile] of [
    ['src/game/eland/domain/history.ts', historyBundlePath],
    ['src/game/eland/simulation.ts', simulationBundlePath],
    ['src/game/eland/application/civilization-settlement.ts', settlementBundlePath],
    ['src/game/eland/application/simulation/month-boundary.ts', monthBoundaryBundlePath],
  ]) {
    execFileSync(esbuild, [
      entry,
      '--bundle',
      '--platform=node',
      '--format=esm',
      `--outfile=${outfile}`,
    ], {
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' },
      stdio: 'pipe',
    });
  }

  const history = await import(`${pathToFileURL(historyBundlePath).href}?v=${Date.now()}`);
  const simulation = await import(`${pathToFileURL(simulationBundlePath).href}?v=${Date.now()}`);
  const settlement = await import(`${pathToFileURL(settlementBundlePath).href}?v=${Date.now()}`);
  const monthBoundary = await import(`${pathToFileURL(monthBoundaryBundlePath).href}?v=${Date.now()}`);

  const first = event('legacy-0');
  const second = event('legacy-1');
  const legacy = fixture([first, second]);
  assert.throws(
    () => history.historyEventCount(legacy),
    /必须先经可信恢复边界迁移/u,
    '普通只读不得把cursor-less planning数组擅自确认为完整历史',
  );
  assert.throws(
    () => history.appendCommittedEvents(legacy, [event('must-not-derive')]),
    /必须先经可信恢复边界迁移/u,
    '普通append不得隐式派生cursor',
  );
  const derived = history.initializeHistoryCursorFromFullHistory(legacy);
  assert.deepEqual(derived, {
    version: 1,
    eventCount: 2,
    hotStartIndex: 0,
    tailEventId: second.id,
  }, '旧schema17完整历史必须一次派生绝对cursor');
  assert.strictEqual(
    history.initializeHistoryCursorFromFullHistory(legacy),
    derived,
    '可信旧状态迁移必须幂等',
  );

  const appended = event('legacy-2', 1);
  const pastIdentity = legacy.world.past;
  const cursorIdentity = legacy.world.historyCursor;
  history.appendCommittedEvents(legacy, [appended]);
  assert.strictEqual(legacy.world.past, pastIdentity, '权威追加不得替换历史数组');
  assert.strictEqual(legacy.world.past.at(-1), appended, '权威追加必须保留事件对象身份');
  assert.strictEqual(legacy.world.historyCursor, cursorIdentity, '追加应原位推进cursor');
  assert.deepEqual(legacy.world.historyCursor, {
    version: 1,
    eventCount: 3,
    hotStartIndex: 0,
    tailEventId: appended.id,
  });
  const beforeEmpty = structuredClone(legacy.world);
  assert.strictEqual(history.appendCommittedEvents(legacy, []), cursorIdentity);
  assert.deepEqual(legacy.world, beforeEmpty, '空追加必须完全无变化');

  const overlayEvent = event('planning-overlay', 2);
  legacy.world.past = [...legacy.world.past, overlayEvent];
  const overlayView = history.committedHistoryView(legacy);
  assert.equal(overlayView.eventCount, 3);
  assert.equal(overlayView.hotEventCount, 3);
  assert.strictEqual(overlayView.events.at(-1), overlayEvent, 'view可零复制共享临时数组');
  assert.strictEqual(overlayView.atAbsoluteIndex(2), appended);
  assert.equal(overlayView.atAbsoluteIndex(3), undefined, 'planning overlay不得出现在committed绝对视图');
  const overlaySnapshot = structuredClone(legacy.world);
  await assert.rejects(
    async () => history.appendCommittedEvents(legacy, [event('must-not-commit')]),
    /planning overlay/u,
  );
  assert.deepEqual(legacy.world, overlaySnapshot, 'overlay拒绝必须在array/cursor变更前发生');

  const stale = fixture([first], {
    version: 1,
    eventCount: 2,
    hotStartIndex: 0,
    tailEventId: second.id,
  });
  const staleSnapshot = structuredClone(stale.world);
  await assert.rejects(
    async () => history.appendCommittedEvents(stale, [event('must-not-repair')]),
    /缺少已提交事件/u,
  );
  assert.deepEqual(stale.world, staleSnapshot, 'stale/truncated历史不得被append隐式修复');

  const coldPrefix = fixture([event('hot-3'), event('hot-4')], {
    version: 1,
    eventCount: 5,
    hotStartIndex: 3,
    tailEventId: 'hot-4',
  });
  const coldView = history.committedHistoryView(coldPrefix);
  assert.equal(coldView.atAbsoluteIndex(2), undefined);
  assert.equal(coldView.atAbsoluteIndex(3)?.id, 'hot-3');
  assert.equal(coldView.atAbsoluteIndex(4)?.id, 'hot-4');
  history.appendCommittedEvents(coldPrefix, [event('hot-5')]);
  assert.deepEqual(coldPrefix.world.historyCursor, {
    version: 1,
    eventCount: 6,
    hotStartIndex: 3,
    tailEventId: 'hot-5',
  }, '未来热窗追加必须保留绝对起点并推进绝对计数');

  const initial = simulation.createInitialState(9137, {
    endpoint: { kind: 'months', value: 12 },
  });
  assert.equal(initial.world.historyCursor.eventCount, initial.world.past.length);
  assert.equal(initial.world.historyCursor.hotStartIndex, 0);
  assert.equal(initial.world.historyCursor.tailEventId, initial.world.past.at(-1).id);
  const controller = simulation.createSimulation({ state: initial });
  const overlayProbe = controller.ownedState();
  overlayProbe.world.past.push(event('controller-overlay'));
  const controllerBeforeReject = structuredClone({
    drops: overlayProbe.world.drops,
    past: overlayProbe.world.past,
    cursor: overlayProbe.world.historyCursor,
    clock: overlayProbe.clock,
    civilization: overlayProbe.civilization,
    lastStep: overlayProbe.lastStep,
  });
  assert.throws(
    () => controller.injectEvent({
      kind: 'resource',
      severity: 1,
      resource: 'wood',
      delta: 1,
      cellId: 0,
    }),
    /planning overlay/u,
    '注入入口必须在addDrop前拒绝overlay',
  );
  assert.deepEqual({
    drops: overlayProbe.world.drops,
    past: overlayProbe.world.past,
    cursor: overlayProbe.world.historyCursor,
    clock: overlayProbe.clock,
    civilization: overlayProbe.civilization,
    lastStep: overlayProbe.lastStep,
  }, controllerBeforeReject, '注入失败不得留下物资或其他权威副作用');
  overlayProbe.world.past.pop();

  for (const [label, invoke] of [
    ['civilization settlement', (state) => settlement.concludeOwnedCivilization(state)],
    ['month boundary', (state) => monthBoundary.finishMonth(
      state,
      [],
      state.clock.elapsedMonths + 1,
      'annual',
      { project() {} },
    )],
  ]) {
    const state = structuredClone(controller.ownedState());
    state.world.past.push(event(`${label}-overlay`));
    const beforeReject = structuredClone(state);
    assert.throws(() => invoke(state), /planning overlay/u, `${label}必须preflight拒绝overlay`);
    assert.deepEqual(state, beforeReject, `${label}失败不得先改clock/status/outcome/lastStep`);
  }

  const beforeInject = controller.ownedState().world.historyCursor.eventCount;
  const injectedState = controller.injectEvent({
    kind: 'resource',
    severity: 1,
    resource: 'wood',
    delta: 1,
    cellId: 0,
    description: 'history cursor injection fixture',
  });
  const injected = injectedState.world.past.at(-1);
  assert.equal(injected.id, `e-0-injected-${beforeInject}`, '注入ID必须使用绝对已提交事件数');
  assert.equal(injectedState.world.historyCursor.eventCount, beforeInject + 1);
  assert.equal(injectedState.world.historyCursor.tailEventId, injected.id);
  assert.strictEqual(injectedState.lastStep[0], injected);
  const beforeMonth = controller.ownedState().world.historyCursor.eventCount;
  const advancedState = controller.stepOwned(1);
  assert.equal(advancedState.clock.elapsedMonths, 1);
  assert.ok(advancedState.lastStep.length > 0, '完整月必须提交权威事件');
  assert.equal(
    advancedState.world.historyCursor.eventCount,
    beforeMonth + advancedState.lastStep.length,
    '月边界必须通过唯一append helper推进绝对cursor',
  );
  assert.equal(advancedState.world.historyCursor.eventCount, advancedState.world.past.length);
  assert.equal(advancedState.world.historyCursor.tailEventId, advancedState.world.past.at(-1).id);
  assert.equal(
    simulation.buildEvolutionReport(advancedState).review.eventCount,
    advancedState.world.past.length,
    'full-history阶段报告绝对计数必须与旧past.length逐值一致',
  );

  const memoryUsage = process.memoryUsage();
  assert.ok(memoryUsage.rss < 256 * 1024 * 1024, 'v25 focused fixture不得越过256MiB RSS');
  console.log(JSON.stringify({
    result: 'passed',
    legacyCursor: 'derived once and append exact',
    overlay: 'zero-copy view; excluded from absolute count; append rejected atomically',
    stale: 'rejected before mutation',
    futureHotWindow: 'absolute ordinals preserved',
    injectedEventId: injected.id,
    committedMonthEvents: advancedState.lastStep.length,
    reportEventCount: simulation.buildEvolutionReport(advancedState).review.eventCount,
    rssBytes: memoryUsage.rss,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
