import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';

const ROOT_CODEC = 'eland-run-state-root-v1';
const SHELL_CODEC = 'eland-run-state-shell-v1';
const SHELL_MANIFEST_CODEC = 'eland-run-state-shell-manifest-v1';
const SHELL_PART_CODEC = 'eland-run-state-shell-part-v1';
const HISTORY_NODE_CODEC = 'eland-run-history-node-v1';
const EVENT_CODEC = 'eland-run-state-events-v1';
const LEGACY_CODEC = 'v8-br-v1';
const STATE_CODECS = [
  ROOT_CODEC,
  SHELL_CODEC,
  SHELL_MANIFEST_CODEC,
  SHELL_PART_CODEC,
  HISTORY_NODE_CODEC,
  EVENT_CODEC,
];

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-segmented-run-state-'));
const storeBundlePath = path.join(temporaryDirectory, 'sqlite-run-store.mjs');
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const dataDirectory = path.join(temporaryDirectory, 'data');

function buffer(value) {
  return Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function chunk(database, hash) {
  return database.prepare('SELECT hash, codec, raw_size, data FROM chunks WHERE hash = ?').get(hash);
}

function currentRoot(database, runId) {
  const row = database.prepare(`
    SELECT chunks.hash, chunks.codec, chunks.raw_size, chunks.data
    FROM runs JOIN chunks ON chunks.hash = runs.state_hash
    WHERE runs.id = ?
  `).get(runId);
  assert.ok(row, `运行 ${runId} 应存在`);
  assert.equal(row.codec, ROOT_CODEC);
  assert.equal(Number(row.raw_size), row.data.byteLength);
  return { hash: String(row.hash), metadata: deserialize(buffer(row.data)) };
}

function historyNode(database, hash) {
  const row = chunk(database, hash);
  assert.ok(row, `history node ${hash} 应存在`);
  assert.equal(row.codec, HISTORY_NODE_CODEC);
  assert.equal(Number(row.raw_size), row.data.byteLength);
  return deserialize(buffer(row.data));
}

function syntheticEvent(source, id, atMonth, result) {
  return {
    ...structuredClone(source),
    id,
    atMonth,
    orderInMonth: 0,
    planningTick: 0,
    orderInTick: 0,
    result,
  };
}

function appendEvent(state, id, atMonth) {
  const source = state.world.past.at(-1) ?? state.lastStep.at(-1);
  assert.ok(source, '测试状态必须至少包含一个事件模板');
  const event = syntheticEvent(source, id, atMonth, id);
  state.clock.elapsedMonths = Math.max(state.clock.elapsedMonths, atMonth);
  state.world.past.push(event);
  state.lastStep = [event];
  return event;
}

function insertLegacyRun(database, id, state) {
  const raw = serialize(state);
  const data = brotliCompressSync(raw);
  const hash = createHash('sha256').update(raw).digest('hex');
  const now = '2026-08-20T00:00:00.000Z';
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare('INSERT INTO chunks(hash, codec, raw_size, data) VALUES (?, ?, ?, ?)')
      .run(hash, LEGACY_CODEC, raw.byteLength, data);
    database.prepare(`
      INSERT INTO runs(
        id, state_hash, schema_version, label, created_at, updated_at, revision,
        elapsed_months, civilization_no, status, living_agents, agent_count,
        event_count, milestone_count
      ) VALUES (?, ?, 1, NULL, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      hash,
      now,
      now,
      state.clock.elapsedMonths,
      state.civilization.number,
      state.civilization.status,
      state.people.filter((person) => person.diedAtMonth === undefined && person.body.health > 0).length,
      state.people.length,
      state.world.past.length,
      state.derived.milestones.length,
    );
    database.prepare(`
      INSERT INTO run_checkpoints(run_id, revision, month, state_hash, created_at)
      VALUES (?, 1, ?, ?, ?)
    `).run(id, state.clock.elapsedMonths, hash, now);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function unreachableSegmentedChunks(database) {
  const reachable = new Set();
  const visitedNodes = new Set();
  const directRoots = database.prepare(`
    SELECT state_hash AS hash FROM runs
    UNION
    SELECT state_hash AS hash FROM run_checkpoints
    UNION
    SELECT chunk_hash AS hash FROM artifacts
  `).all().map((row) => String(row.hash));
  for (const rootHash of directRoots) {
    const rootRow = chunk(database, rootHash);
    if (!rootRow || !STATE_CODECS.includes(String(rootRow.codec))) continue;
    reachable.add(rootHash);
    if (rootRow.codec !== ROOT_CODEC) continue;
    const root = deserialize(buffer(rootRow.data));
    reachable.add(root.shellHash);
    const shellRow = chunk(database, root.shellHash);
    if (shellRow?.codec === SHELL_MANIFEST_CODEC) {
      const manifest = deserialize(buffer(shellRow.data));
      for (const field of [...manifest.fields, ...manifest.worldFields]) {
        if (field.kind === 'value') reachable.add(field.hash);
        else for (const segment of field.segments) reachable.add(segment.hash);
      }
    }
    let nodeHash = root.historyHeadHash;
    while (nodeHash && !visitedNodes.has(nodeHash)) {
      visitedNodes.add(nodeHash);
      reachable.add(nodeHash);
      const node = historyNode(database, nodeHash);
      for (const segment of node.segments) reachable.add(segment.hash);
      nodeHash = node.parentHash;
    }
  }
  const placeholders = STATE_CODECS.map(() => '?').join(', ');
  return database.prepare(`SELECT hash FROM chunks WHERE codec IN (${placeholders})`).all(...STATE_CODECS)
    .map((row) => String(row.hash))
    .filter((hash) => !reachable.has(hash));
}

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/sqlite-run-store.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${storeBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/simulation.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${simulationBundlePath}`,
  ], { stdio: 'pipe' });

  const {
    RUN_CHECKPOINT_PRUNE_THRESHOLD,
    RUN_CHECKPOINT_RETENTION,
    RunWriteConflictError,
    SqliteRunStore,
  } = await import(`${pathToFileURL(storeBundlePath).href}?t=${Date.now()}`);
  const { createInitialState, createSimulation } = await import(
    `${pathToFileURL(simulationBundlePath).href}?t=${Date.now()}`
  );
  const initialState = createInitialState(8128, { endpoint: { kind: 'months', value: 3_000 } });
  const eventTemplate = initialState.world.past[0];
  for (let index = 1; index < 2_050; index += 1) {
    initialState.world.past.push(syntheticEvent(eventTemplate, `e-bulk-${index}`, 0, `bulk ${index}`));
  }
  initialState.lastStep = [initialState.world.past.at(-1)];

  const store = new SqliteRunStore(dataDirectory);
  const database = store.database;
  const created = await store.create({ id: 'segmented', state: initialState });
  const loadedCreated = await store.load('segmented');
  assert.deepEqual(loadedCreated.state, created.state, '跨 2048 分段的新格式加载必须深等价');
  assert.strictEqual(
    loadedCreated.state.lastStep[0],
    loadedCreated.state.world.past.at(-1),
    'lastStep 必须按 eventId 重连到 world.past 的同一事实对象',
  );

  const first = currentRoot(database, 'segmented');
  const firstNode = historyNode(database, first.metadata.historyHeadHash);
  assert.equal(firstNode.segments.length, 2, '2050 条历史应跨两个最大 2048 的 segment');
  assert.deepEqual(firstNode.segments.map((segment) => segment.eventCount), [2_048, 2]);
  assert.equal(firstNode.parentHash, null);
  const firstSegmentHash = firstNode.segments[0].hash;
  const firstSegmentBytes = Buffer.from(chunk(database, firstSegmentHash).data);
  const shellRow = chunk(database, first.metadata.shellHash);
  assert.equal(shellRow.codec, SHELL_MANIFEST_CODEC);
  const shellManifest = deserialize(buffer(shellRow.data));
  assert.equal(shellManifest.schemaVersion, 1);
  assert.equal(shellManifest.fields.some((field) => field.name === 'world'), false);
  assert.equal(shellManifest.worldFields.some((field) => field.name === 'past'), false);
  const peopleReference = shellManifest.fields.find((field) => field.name === 'people');
  assert.equal(peopleReference.kind, 'array');
  assert.equal(peopleReference.length, initialState.people.length);
  for (const reference of peopleReference.segments) {
    assert.equal(chunk(database, reference.hash).codec, SHELL_PART_CODEC);
  }

  const extendedInput = structuredClone(created.state);
  appendEvent(extendedInput, 'e-appended-2050', 1);
  const extended = await store.save('segmented', extendedInput, undefined, { historyMode: 'append' });
  const second = currentRoot(database, 'segmented');
  const secondNode = historyNode(database, second.metadata.historyHeadHash);
  assert.equal(second.metadata.lineageId, first.metadata.lineageId, 'append 必须保持 lineage 身份');
  assert.equal(secondNode.parentHash, first.metadata.historyHeadHash);
  assert.deepEqual(secondNode.segments.map((segment) => segment.eventCount), [1]);
  assert.deepEqual(Buffer.from(chunk(database, firstSegmentHash).data), firstSegmentBytes);
  assert.deepEqual((await store.load('segmented')).state, extended.state);

  const rewrittenInput = structuredClone(extended.state);
  rewrittenInput.world.past[second.metadata.eventCount - 1] = {
    ...rewrittenInput.world.past[second.metadata.eventCount - 1],
    result: 'rewritten boundary',
  };
  rewrittenInput.lastStep = [rewrittenInput.world.past[second.metadata.eventCount - 1]];
  await assert.rejects(
    store.save('segmented', rewrittenInput),
    /既有边界已改写.*replace/u,
    '默认 append 必须拒绝边界改写',
  );
  const rewritten = await store.save(
    'segmented',
    rewrittenInput,
    undefined,
    { historyMode: 'replace' },
  );
  const replacedRoot = currentRoot(database, 'segmented');
  const replacedNode = historyNode(database, replacedRoot.metadata.historyHeadHash);
  assert.notEqual(replacedRoot.metadata.lineageId, second.metadata.lineageId);
  assert.equal(replacedNode.parentHash, null, 'replace 的历史节点不得链接旧 lineage');
  assert.deepEqual((await store.load('segmented')).state, rewritten.state);

  const truncatedInput = structuredClone(rewritten.state);
  truncatedInput.world.past = truncatedInput.world.past.slice(0, 2_000);
  truncatedInput.lastStep = [truncatedInput.world.past.at(-1)];
  await assert.rejects(store.save('segmented', truncatedInput), /缩短.*replace/u);
  const truncated = await store.save(
    'segmented',
    truncatedInput,
    undefined,
    { historyMode: 'replace' },
  );
  const truncatedRoot = currentRoot(database, 'segmented');
  assert.notEqual(truncatedRoot.metadata.lineageId, replacedRoot.metadata.lineageId);
  assert.deepEqual((await store.load('segmented')).state, truncated.state);

  const concurrentBase = structuredClone(truncated.state);
  const concurrentRow = database.prepare('SELECT revision, state_hash FROM runs WHERE id = ?')
    .get('segmented');
  const concurrentA = structuredClone(concurrentBase);
  const concurrentB = structuredClone(concurrentBase);
  appendEvent(concurrentA, 'e-concurrent-a', 2);
  appendEvent(concurrentB, 'e-concurrent-b', 2);
  const expected = {
    historyMode: 'append',
    expectedRevision: Number(concurrentRow.revision),
    expectedStateHash: String(concurrentRow.state_hash),
  };
  const concurrentResults = await Promise.allSettled([
    store.save('segmented', concurrentA, undefined, expected),
    store.save('segmented', concurrentB, undefined, expected),
  ]);
  assert.equal(concurrentResults.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = concurrentResults.find((result) => result.status === 'rejected');
  assert.ok(rejected?.reason instanceof RunWriteConflictError, '过期并发写必须明确报告 CAS conflict');
  let currentState = concurrentResults.find((result) => result.status === 'fulfilled').value.state;
  assert.deepEqual(unreachableSegmentedChunks(database), [], 'CAS 回滚不得泄漏孤儿块');

  const legacyState = createInitialState(8129, { endpoint: { kind: 'months', value: 12 } });
  insertLegacyRun(database, 'legacy-v8', legacyState);
  const legacyHash = String(database.prepare('SELECT state_hash FROM runs WHERE id = ?')
    .get('legacy-v8').state_hash);
  const insertLegacyCheckpoint = database.prepare(`
    INSERT INTO run_checkpoints(run_id, revision, month, state_hash, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (let revision = 2; revision <= RUN_CHECKPOINT_RETENTION + 4; revision += 1) {
    insertLegacyCheckpoint.run(
      'legacy-v8',
      revision,
      legacyState.clock.elapsedMonths,
      legacyHash,
      '2026-08-20T00:00:00.000Z',
    );
  }
  database.prepare('UPDATE runs SET revision = ? WHERE id = ?')
    .run(RUN_CHECKPOINT_RETENTION + 4, 'legacy-v8');
  const legacyLoaded = await store.load('legacy-v8');
  assert.deepEqual(legacyLoaded.state, createSimulation({ state: legacyState }).getState());
  const legacyAdvanced = structuredClone(legacyLoaded.state);
  appendEvent(legacyAdvanced, 'e-legacy-upgrade', 1);
  const upgraded = await store.save('legacy-v8', legacyAdvanced);
  assert.equal(currentRoot(database, 'legacy-v8').metadata.eventCount, legacyAdvanced.world.past.length);
  assert.deepEqual((await store.load('legacy-v8')).state, upgraded.state, 'legacy 首次保存应升级为新根');
  assert.equal(
    Number(database.prepare(`
      SELECT COUNT(*) AS count
      FROM run_checkpoints AS checkpoint
      JOIN chunks ON chunks.hash = checkpoint.state_hash
      WHERE checkpoint.run_id = ? AND chunks.codec = ?
    `).get('legacy-v8', LEGACY_CODEC).count),
    RUN_CHECKPOINT_RETENTION + 4,
    '新格式裁剪不得删除既有 legacy checkpoint 证据',
  );

  const oldRootExpectedToBePruned = first.hash;
  for (let index = 0; index < RUN_CHECKPOINT_PRUNE_THRESHOLD; index += 1) {
    const next = structuredClone(currentState);
    appendEvent(next, `e-retention-${index}`, 10 + index);
    currentState = (await store.save(
      'segmented',
      next,
      undefined,
      { historyMode: 'append' },
    )).state;
  }
  const checkpointStats = database.prepare(`
    SELECT COUNT(*) AS count, MIN(revision) AS min_revision, MAX(revision) AS max_revision
    FROM run_checkpoints WHERE run_id = ?
  `).get('segmented');
  assert.ok(
    Number(checkpointStats.count) >= RUN_CHECKPOINT_RETENTION
      && Number(checkpointStats.count) <= RUN_CHECKPOINT_PRUNE_THRESHOLD,
    'checkpoint 数量应保持在批量裁剪的 128-256 有界窗口内',
  );
  assert.equal(
    Number(checkpointStats.max_revision) - Number(checkpointStats.min_revision),
    Number(checkpointStats.count) - 1,
    'checkpoint 应保留连续的最新 revision 窗口',
  );
  assert.equal(
    Number(database.prepare('SELECT COUNT(*) AS count FROM chunks WHERE hash = ?')
      .get(oldRootExpectedToBePruned).count),
    0,
    '裁剪后不可达的旧状态根必须回收',
  );
  assert.deepEqual(unreachableSegmentedChunks(database), [], '裁剪后所有新 codec 块都必须可达');
  assert.deepEqual((await store.load('segmented')).state, currentState);

  const finalRoot = currentRoot(database, 'segmented');
  const finalNode = historyNode(database, finalRoot.metadata.historyHeadHash);
  const corruptSegmentHash = finalNode.segments[0].hash;
  const corruptSegment = chunk(database, corruptSegmentHash);
  database.prepare('UPDATE chunks SET raw_size = ? WHERE hash = ?')
    .run(Number(corruptSegment.raw_size) + 1, corruptSegmentHash);
  await assert.rejects(store.load('segmented'), /事件分段 .*长度与记录不一致/u);
  database.prepare('UPDATE chunks SET raw_size = ? WHERE hash = ?')
    .run(Number(corruptSegment.raw_size), corruptSegmentHash);

  database.prepare('DELETE FROM chunks WHERE hash = ?').run(finalRoot.metadata.shellHash);
  await assert.rejects(
    store.load('segmented'),
    new RegExp(`运行数据块 ${finalRoot.metadata.shellHash} 不存在`, 'u'),
    '缺失引用块必须明确失败',
  );

  store.close();
  console.log('segmented sqlite run-state tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
