import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-domain-history-trim-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'domain-history-trim.mjs');

function event(id, atMonth) {
  return {
    id,
    kind: 'environment',
    atMonth,
    orderInMonth: 0,
    planningTick: 1,
    orderInTick: 0,
    cellId: 0,
    change: 'condition',
    result: id,
    diff: { marker: id },
  };
}

function stateWithHistory(events, hotStartIndex = 0) {
  return {
    world: {
      past: events.slice(hotStartIndex),
      historyCursor: {
        version: 1,
        eventCount: events.length,
        hotStartIndex,
        tailEventId: events.at(-1)?.id ?? null,
      },
    },
  };
}

function sealFor(state) {
  return {
    eventCount: state.world.historyCursor.eventCount,
    tailEventId: state.world.historyCursor.tailEventId,
  };
}

try {
  writeFileSync(entryPath, [
    `export { appendCommittedEvents, committedHistoryView, trimCommittedHistoryAfterPersistedCursor } from ${JSON.stringify(path.resolve('src/game/eland/domain/history.ts'))};`,
    `export { clearPlanningEventOverlay, primeEventIndex, registerPlanningEventOverlay, registerRetainedColdWorldEventFacts, retainedColdWorldEventsForLease, worldEventById } from ${JSON.stringify(path.resolve('src/game/eland/domain/event-index.ts'))};`,
  ].join('\n'));
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], {
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' },
    stdio: 'pipe',
  });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  const events = Array.from({ length: 8 }, (_, index) => event(`event-${index}`, index));
  const full = stateWithHistory(events);
  const fullPastIdentity = full.world.past;
  const fullCursorIdentity = full.world.historyCursor;
  const persisted = sealFor(full);
  api.primeEventIndex(full);
  assert.equal(api.worldEventById(full, 'event-0')?.id, 'event-0', 'fixture 必须先建立完整 hot index');
  const trimmedCursor = api.trimCommittedHistoryAfterPersistedCursor(full, persisted, 3);
  assert.strictEqual(trimmedCursor, fullCursorIdentity, 'trim 必须原地推进既有 cursor');
  assert.strictEqual(full.world.past, fullPastIdentity, 'trim 必须保持 world.past 数组 identity');
  assert.deepEqual(full.world.past.map((item) => item.id), ['event-5', 'event-6', 'event-7']);
  assert.deepEqual(full.world.historyCursor, {
    version: 1,
    eventCount: 8,
    hotStartIndex: 5,
    tailEventId: 'event-7',
  });
  assert.equal(api.worldEventById(full, 'event-0'), undefined, '未 pin 的 removed hot fact 不得被旧 cache 继续解析');
  assert.equal(api.worldEventById(full, 'event-7')?.id, 'event-7', '保留的 hot tail 必须继续解析');

  const afterFirstTrim = [...full.world.past];
  api.trimCommittedHistoryAfterPersistedCursor(full, persisted, 3);
  assert.strictEqual(full.world.past, fullPastIdentity, '重复 trim 仍须保持数组 identity');
  assert.deepEqual(full.world.past, afterFirstTrim, '重复相同 trim 必须幂等');
  assert.equal(full.world.historyCursor.hotStartIndex, 5);

  const suffix = [event('suffix-8', 8), event('suffix-9', 9)];
  api.appendCommittedEvents(full, suffix);
  assert.strictEqual(full.world.past, fullPastIdentity, 'append 必须继续使用裁剪后的稳定数组');
  assert.deepEqual(full.world.past.map((item) => item.id), [
    'event-5', 'event-6', 'event-7', 'suffix-8', 'suffix-9',
  ]);
  assert.deepEqual(full.world.historyCursor, {
    version: 1,
    eventCount: 10,
    hotStartIndex: 5,
    tailEventId: 'suffix-9',
  });
  const appendedView = api.committedHistoryView(full);
  assert.equal(appendedView.atAbsoluteIndex(4), undefined);
  assert.equal(appendedView.atAbsoluteIndex(5)?.id, 'event-5');
  assert.equal(appendedView.atAbsoluteIndex(8)?.id, 'suffix-8');
  assert.equal(appendedView.atAbsoluteIndex(9)?.id, 'suffix-9');

  const zeroHot = stateWithHistory(events);
  const zeroIdentity = zeroHot.world.past;
  api.trimCommittedHistoryAfterPersistedCursor(zeroHot, sealFor(zeroHot), 0);
  assert.strictEqual(zeroHot.world.past, zeroIdentity);
  assert.deepEqual(zeroHot.world.past, []);
  assert.deepEqual(zeroHot.world.historyCursor, {
    version: 1,
    eventCount: 8,
    hotStartIndex: 8,
    tailEventId: 'event-7',
  });
  api.trimCommittedHistoryAfterPersistedCursor(zeroHot, sealFor(zeroHot), 0);
  assert.deepEqual(zeroHot.world.past, [], 'limit=0 的重复 trim 必须幂等');
  const zeroSuffix = event('zero-hot-suffix', 8);
  api.appendCommittedEvents(zeroHot, [zeroSuffix]);
  assert.deepEqual(zeroHot.world.past, [zeroSuffix], 'limit=0 后 append 必须从空热窗继续');
  assert.deepEqual(zeroHot.world.historyCursor, {
    version: 1,
    eventCount: 9,
    hotStartIndex: 8,
    tailEventId: 'zero-hot-suffix',
  });
  assert.equal(api.committedHistoryView(zeroHot).atAbsoluteIndex(8)?.id, 'zero-hot-suffix');

  const staleCount = stateWithHistory(events);
  const staleCountIdentity = staleCount.world.past;
  const staleCountCursor = structuredClone(staleCount.world.historyCursor);
  assert.throws(
    () => api.trimCommittedHistoryAfterPersistedCursor(staleCount, {
      eventCount: events.length - 1,
      tailEventId: events.at(-1).id,
    }, 2),
    /seal 与当前 committed cursor 不一致/u,
  );
  assert.strictEqual(staleCount.world.past, staleCountIdentity);
  assert.deepEqual(staleCount.world.historyCursor, staleCountCursor);

  const staleTail = stateWithHistory(events);
  const staleTailBefore = [...staleTail.world.past];
  assert.throws(
    () => api.trimCommittedHistoryAfterPersistedCursor(staleTail, {
      eventCount: events.length,
      tailEventId: 'stale-tail',
    }, 2),
    /seal 与当前 committed cursor 不一致/u,
  );
  assert.deepEqual(staleTail.world.past, staleTailBefore);
  assert.throws(
    () => api.trimCommittedHistoryAfterPersistedCursor(staleTail, sealFor(staleTail), -1),
    /非负安全整数/u,
  );
  assert.throws(
    () => api.trimCommittedHistoryAfterPersistedCursor(staleTail, sealFor(staleTail), 1.5),
    /非负安全整数/u,
  );

  const planning = stateWithHistory(events);
  const planningIdentity = planning.world.past;
  const overlay = event('planning-overlay', 8);
  const combinedPlanningPast = [...planningIdentity, overlay];
  planning.world.past = combinedPlanningPast;
  api.registerPlanningEventOverlay(planning, [overlay], planningIdentity);
  assert.throws(
    () => api.trimCommittedHistoryAfterPersistedCursor(planning, sealFor(planning), 2),
    /planning overlay/u,
  );
  assert.strictEqual(planning.world.past, combinedPlanningPast, '拒绝 combined temporary suffix 时不得替换数组');
  assert.deepEqual(planning.world.past, [...events, overlay]);
  api.clearPlanningEventOverlay(planning);
  planning.world.past = planningIdentity;

  const bounded = stateWithHistory(events, 3);
  const boundedIdentity = bounded.world.past;
  const retainedLease = 'fixture:retained-cold';
  api.registerRetainedColdWorldEventFacts(bounded, [{
    absoluteIndex: 1,
    eventId: events[1].id,
    event: events[1],
    leaseKeys: [retainedLease],
  }]);
  api.primeEventIndex(bounded);
  api.trimCommittedHistoryAfterPersistedCursor(bounded, sealFor(bounded), 2);
  assert.strictEqual(bounded.world.past, boundedIdentity, '既有 bounded 热窗也必须原地 splice');
  assert.deepEqual(bounded.world.past.map((item) => item.id), ['event-6', 'event-7']);
  assert.deepEqual(bounded.world.historyCursor, {
    version: 1,
    eventCount: 8,
    hotStartIndex: 6,
    tailEventId: 'event-7',
  });
  assert.deepEqual(
    api.retainedColdWorldEventsForLease(bounded, retainedLease).map((item) => item.id),
    ['event-1'],
    '原地 trim 后同数组 WeakMap lease 必须继续解析',
  );
  assert.equal(api.worldEventById(bounded, 'event-1')?.id, 'event-1');
  assert.equal(api.worldEventById(bounded, 'event-3'), undefined, '新转冷且未 pin 的 removed fact 不得解析');
  assert.equal(api.worldEventById(bounded, 'event-7')?.id, 'event-7');

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1024 * 1024, 'domain history trim fixture RSS 不得超过 256 MiB');
  console.log(JSON.stringify({
    result: 'passed',
    retainedHotEventCount: bounded.world.past.length,
    retainedColdEventIds: api.retainedColdWorldEventsForLease(bounded, retainedLease).map((item) => item.id),
    rssBytes,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
