import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deserialize } from 'node:v8';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-bounded-store-v28-'));
const storeBundlePath = path.join(temporaryDirectory, 'sqlite-run-store.mjs');
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const dataDirectory = path.join(temporaryDirectory, 'data');
const childEnvironment = { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' };

function appendSyntheticEvents(state, count, prefix) {
  const cursor = state.world.historyCursor;
  assert.ok(cursor, 'fixture state 必须携带 history cursor');
  const firstAbsoluteIndex = cursor.eventCount;
  const events = Array.from({ length: count }, (_, offset) => ({
    id: `${prefix}-${firstAbsoluteIndex + offset}`,
    atMonth: state.clock.elapsedMonths + 1,
    orderInMonth: offset,
    cellId: offset,
    kind: 'environment',
    change: 'material',
    result: 'bounded store fixture fact',
    diff: {
      fixtureKind: 'bounded-store',
      absoluteMarker: firstAbsoluteIndex + offset,
    },
  }));
  state.world.past.push(...events);
  cursor.eventCount += events.length;
  cursor.tailEventId = events.at(-1)?.id ?? cursor.tailEventId;
  return events;
}

function persistedShape(store, id) {
  const row = store.database.prepare(`
    SELECT state_hash, revision, event_count FROM runs WHERE id = ?
  `).get(id);
  return {
    stateHash: String(row.state_hash),
    revision: Number(row.revision),
    eventCount: Number(row.event_count),
    checkpoints: Number(store.database.prepare(`
      SELECT COUNT(*) AS count FROM run_checkpoints WHERE run_id = ?
    `).get(id).count),
  };
}

try {
  for (const [entry, outfile] of [
    ['server/sqlite-run-store.ts', storeBundlePath],
    ['src/game/eland/simulation.ts', simulationBundlePath],
  ]) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entry,
      '--bundle',
      '--platform=node',
      '--format=esm',
      `--outfile=${outfile}`,
    ], { env: childEnvironment, stdio: 'pipe' });
  }

  const {
    SqliteRunStore,
    RunWriteConflictError,
  } = await import(`${pathToFileURL(storeBundlePath).href}?v=${Date.now()}`);
  const { createInitialState } = await import(
    `${pathToFileURL(simulationBundlePath).href}?v=${Date.now()}`
  );

  const initial = createInitialState(2801, { endpoint: { kind: 'months', value: 12_000 } });
  appendSyntheticEvents(initial, 8, 'seed');
  const store = new SqliteRunStore(dataDirectory);
  const created = await store.create({ id: 'bounded-store', label: 'before', state: initial });
  const originalEventCount = created.meta.eventCount;
  assert.equal(originalEventCount, created.state.world.past.length);

  const loaded = await store.loadForEvolution('bounded-store', {
    hotEventLimit: 3,
    pinnedEventIndexes: [1],
  });
  assert.equal(loaded.state.world.past.length, 3, 'bounded load 只保留连续热尾窗');
  assert.equal(
    loaded.state.world.historyCursor.hotStartIndex,
    originalEventCount - 3,
    'bounded load 必须保留绝对 hotStartIndex',
  );
  assert.equal(loaded.pinnedEvents.length, 1, 'cold pin 不得混入 world.past');
  assert.equal(loaded.pinnedEvents[0].absoluteIndex, 1);
  assert.equal(loaded.basis.history.eventCount, originalEventCount);
  assert.equal(loaded.basis.runId, 'bounded-store');
  assert.equal(Object.isFrozen(loaded.basis), true, 'basis 必须不可变');
  assert.equal(Object.isFrozen(loaded.basis.history), true, 'history basis 必须不可变');

  const rowMismatch = store.database.prepare(`
    UPDATE runs SET event_count = event_count + 1 WHERE id = ?
  `).run('bounded-store');
  assert.equal(Number(rowMismatch.changes), 1);
  await assert.rejects(
    store.loadForEvolution('bounded-store', { hotEventLimit: 3 }),
    /runs\.event_count .* 与状态根 eventCount .* 不一致/u,
    'runs 行与 root 的绝对 eventCount 不一致时必须拒绝',
  );
  store.database.prepare(`UPDATE runs SET event_count = ? WHERE id = ?`)
    .run(originalEventCount, 'bounded-store');

  const nextState = structuredClone(loaded.state);
  const appended = appendSyntheticEvents(nextState, 2, 'suffix');
  nextState.clock.elapsedMonths += 1;
  const saved = await store.saveFromHistorySuffix(
    'bounded-store',
    nextState,
    loaded.basis,
    'after',
  );
  assert.strictEqual(saved.state, nextState, 'suffix save 不得替换或迁移调用方状态');
  assert.equal(saved.meta.revision, loaded.meta.revision + 1);
  assert.equal(saved.meta.eventCount, originalEventCount + appended.length);
  assert.equal(saved.meta.eventCount > saved.state.world.past.length, true,
    'summary eventCount 必须是绝对账本数，不能退化为热窗长度');
  assert.equal(saved.basis.history.eventCount, saved.meta.eventCount);
  assert.equal(saved.basis.stateHash, persistedShape(store, 'bounded-store').stateHash);

  const savedRootRow = store.database.prepare(`
    SELECT chunks.data
    FROM runs JOIN chunks ON chunks.hash = runs.state_hash
    WHERE runs.id = ?
  `).get('bounded-store');
  const savedRoot = deserialize(savedRootRow.data);
  assert.equal(savedRoot.eventCount, originalEventCount + appended.length);
  const headNodeRow = store.database.prepare(`SELECT data FROM chunks WHERE hash = ?`)
    .get(savedRoot.historyHeadHash);
  const headNode = deserialize(headNodeRow.data);
  assert.equal(headNode.startEventIndex, originalEventCount,
    'suffix node 必须从 basis 的绝对 eventCount 开始');
  assert.equal(headNode.eventCount, appended.length);

  const full = await store.load('bounded-store');
  assert.equal(full.state.world.past.length, originalEventCount + appended.length,
    '公共 full load 必须仍恢复完整账本');
  assert.deepEqual(
    full.state.world.past.slice(-appended.length).map((event) => event.id),
    appended.map((event) => event.id),
  );
  assert.deepEqual(full.state.world.historyCursor, {
    version: 1,
    eventCount: originalEventCount + appended.length,
    hotStartIndex: 0,
    tailEventId: appended.at(-1).id,
  }, 'full load 必须重建完整窗口 cursor');
  assert.equal((await store.list())[0].eventCount, originalEventCount + appended.length,
    'list summary 必须保留绝对事件数');

  const staleInput = structuredClone(nextState);
  appendSyntheticEvents(staleInput, 1, 'stale');
  const beforeStale = persistedShape(store, 'bounded-store');
  const staleInputBefore = structuredClone(staleInput);
  await assert.rejects(
    store.saveFromHistorySuffix('bounded-store', staleInput, loaded.basis),
    (error) => error instanceof RunWriteConflictError,
    '陈旧 revision/stateHash basis 必须在编码前拒绝',
  );
  assert.deepEqual(staleInput, staleInputBefore, 'CAS 冲突不得修改调用方状态');
  assert.deepEqual(persistedShape(store, 'bounded-store'), beforeStale,
    'CAS 冲突不得写 run 或 checkpoint');

  const current = await store.loadForEvolution('bounded-store', { hotEventLimit: 3 });
  const rewrittenBoundaryState = structuredClone(current.state);
  const boundaryOffset = current.basis.history.eventCount
    - rewrittenBoundaryState.world.historyCursor.hotStartIndex;
  const rewrittenBoundary = rewrittenBoundaryState.world.past[boundaryOffset - 1];
  assert.ok(rewrittenBoundary, 'fixture 必须驻留 basis 尾边界事实');
  const unchangedBoundaryId = rewrittenBoundary.id;
  rewrittenBoundary.result = `${rewrittenBoundary.result} rewritten`;
  assert.equal(rewrittenBoundary.id, unchangedBoundaryId, 'fixture 只改内容，不改事件 ID');
  const beforeBoundaryRewrite = persistedShape(store, 'bounded-store');
  await assert.rejects(
    store.saveFromHistorySuffix('bounded-store', rewrittenBoundaryState, current.basis),
    /既有边界已改写/u,
    'basis 尾事实同 ID 改写内容时必须拒绝',
  );
  assert.deepEqual(persistedShape(store, 'bounded-store'), beforeBoundaryRewrite,
    '边界内容校验失败不得写 run 或 checkpoint');

  const croppedState = structuredClone(current.state);
  const pending = appendSyntheticEvents(croppedState, 2, 'cropped');
  croppedState.world.past.splice(0, croppedState.world.past.length - 1);
  croppedState.world.historyCursor.hotStartIndex = current.basis.history.eventCount + 1;
  croppedState.world.historyCursor.tailEventId = pending.at(-1).id;
  const beforeCropped = persistedShape(store, 'bounded-store');
  await assert.rejects(
    store.saveFromHistorySuffix('bounded-store', croppedState, current.basis),
    /未持久化历史已被裁出热窗口/u,
    '热窗裁掉未持久化 suffix 时必须拒绝',
  );
  assert.deepEqual(persistedShape(store, 'bounded-store'), beforeCropped,
    'suffix 连续性失败不得写 run 或 checkpoint');

  const wrongHistoryBasis = {
    ...current.basis,
    history: { ...current.basis.history, eventCount: current.basis.history.eventCount - 1 },
  };
  await assert.rejects(
    store.saveFromHistorySuffix('bounded-store', current.state, wrongHistoryBasis),
    (error) => error instanceof RunWriteConflictError,
    'basis 的 history cursor 必须与当前 root 完全一致',
  );

  store.close();
  console.log(JSON.stringify({
    ok: true,
    originalEventCount,
    finalEventCount: saved.meta.eventCount,
    boundedHotStart: loaded.state.world.historyCursor.hotStartIndex,
    suffixEventCount: appended.length,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
