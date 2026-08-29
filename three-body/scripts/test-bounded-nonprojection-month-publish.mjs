import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deserialize } from 'node:v8';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-bounded-month-publish-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');
const dataDirectory = path.join(temporaryDirectory, 'data');
const coldControlDataDirectory = path.join(temporaryDirectory, 'cold-control-data');
const childEnvironment = { ...process.env, NODE_OPTIONS: '--max-old-space-size=256' };
const MAX_FIXTURE_RSS_BYTES = 288 * 1_024 * 1_024;
let store;
let coldControlStore;

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, canonicalJsonValue(value[key])]));
}

function appendFixtureMonth(state, atMonth, runId) {
  const cursor = state.world.historyCursor;
  assert.ok(cursor, 'fixture state 必须有 history cursor');
  const firstAbsoluteIndex = cursor.eventCount;
  // Keep a genuine cold prefix while ensuring the current lastStep remains in
  // the hot window both before and after the one real simulated month.
  const events = Array.from({ length: 320 }, (_, orderInMonth) => ({
    id: `${runId}-fixture-${firstAbsoluteIndex + orderInMonth}`,
    kind: 'environment',
    atMonth,
    orderInMonth,
    planningTick: 0,
    orderInTick: orderInMonth,
    cellId: 0,
    change: 'material',
    result: 'bounded non-projection month publication fixture fact',
    diff: { fixtureKind: 'bounded-nonprojection-month-publish', orderInMonth },
  }));
  state.clock.elapsedMonths = atMonth;
  state.world.past.push(...events);
  cursor.eventCount += events.length;
  cursor.tailEventId = events.at(-1).id;
  state.lastStep = events.slice(-8);
}

try {
  writeFileSync(entryPath, [
    `export { SqliteRunStore } from ${JSON.stringify(path.join(workspace, 'server/sqlite-run-store.ts'))};`,
    `export { encodeRunContinuationBundle, decodeRunContinuationBundle, hashRunContinuationStoredContent } from ${JSON.stringify(path.join(workspace, 'server/run-continuation-bundle.ts'))};`,
    `export { beginHistoryRetentionProjection, foldHistoryRetentionSegment, finishHistoryRetentionProjection } from ${JSON.stringify(path.join(workspace, 'server/history-retention-projection.ts'))};`,
    `export { HISTORY_RETENTION_SIDECAR_CODEC, HISTORY_RETENTION_SIDECAR_LEGACY_CODEC, encodeHistoryRetentionSidecar, hashHistoryRetentionStoredContent } from ${JSON.stringify(path.join(workspace, 'server/history-retention-codec.ts'))};`,
    `export { decodeBoundedRunStateWithPhysicalProjection } from ${JSON.stringify(path.join(workspace, 'server/physical-structure-ledger-projection.ts'))};`,
    `export { encodePhysicalStructureLedgerSidecar } from ${JSON.stringify(path.join(workspace, 'server/physical-structure-ledger-codec.ts'))};`,
    `export { projectObserverDerivedHistoryFromFullHistory } from ${JSON.stringify(path.join(workspace, 'server/observer-derived-history-projection.ts'))};`,
    `export { encodeObserverDerivedHistorySidecar } from ${JSON.stringify(path.join(workspace, 'server/observer-derived-history-codec.ts'))};`,
    `export { projectObserverCivilizationHistoryFromFullHistory } from ${JSON.stringify(path.join(workspace, 'server/observer-civilization-history-projection.ts'))};`,
    `export { encodeObserverCivilizationHistorySidecar } from ${JSON.stringify(path.join(workspace, 'server/civilization-history-codec.ts'))};`,
    `export { encodeCheckpointAccumulator, projectCheckpointAccumulatorFromVerifiedRunRoot } from ${JSON.stringify(path.join(workspace, 'server/checkpoint-accumulator.ts'))};`,
    `export { createInitialState } from ${JSON.stringify(path.join(workspace, 'src/game/eland/simulation.ts'))};`,
    `export { decodeSegmentedRunStateGameplayBounded, parseRunStateRoot, streamVerifiedRunHistorySegments } from ${JSON.stringify(path.join(workspace, 'server/run-state-codec.ts'))};`,
  ].join('\n'));
  execFileSync(path.join(workspace, 'node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { cwd: workspace, env: childEnvironment, stdio: 'pipe' });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
  store = new api.SqliteRunStore(dataDirectory);
  let database = store.database;

  function readStoredChunk(hash) {
    const row = database.prepare(`
      SELECT hash, codec, raw_size, data FROM chunks WHERE hash = ?
    `).get(hash);
    if (!row) throw new Error(`fixture missing chunk ${hash}`);
    return {
      hash: String(row.hash),
      codec: String(row.codec),
      rawSize: Number(row.raw_size),
      data: Buffer.from(row.data),
    };
  }

  function insertChunk(chunk) {
    database.prepare(`
      INSERT OR IGNORE INTO chunks(hash, codec, raw_size, data) VALUES (?, ?, ?, ?)
    `).run(chunk.hash, chunk.codec, chunk.rawSize, chunk.data);
  }

  async function observerRestoreSnapshot(runId) {
    const opened = await store.openBoundedEvolutionContinuation(runId);
    return {
      stateHash: opened.basis.stateHash,
      meta: { ...opened.meta },
      clock: { ...opened.state.clock },
      civilization: {
        number: opened.state.civilization.number,
        status: opened.state.civilization.status,
        stage: opened.state.civilization.stage,
        outcome: structuredClone(opened.state.civilization.outcome),
      },
      historyCursor: { ...opened.state.world.historyCursor },
      lastStepIds: opened.state.lastStep.map((event) => event.id),
    };
  }

  async function bootstrapContinuation(runId, atMonth, seed, revision = 1) {
    const initial = api.createInitialState(seed, {
      endpoint: { kind: 'months', value: 120 },
    });
    appendFixtureMonth(initial, atMonth, runId);
    const created = await store.create({ id: runId, state: initial });
    if (revision !== 1) {
      database.prepare(`UPDATE runs SET revision = ? WHERE id = ?`).run(revision, runId);
      database.prepare(`
        UPDATE run_checkpoints SET revision = ? WHERE run_id = ? AND revision = 1
      `).run(revision, runId);
    }
    const run = database.prepare(`
      SELECT id, state_hash, revision, event_count, updated_at
      FROM runs WHERE id = ?
    `).get(runId);
    assert.ok(run);
    const rootChunk = readStoredChunk(String(run.state_hash));
    const root = deserialize(rootChunk.data);
    const tailEventId = created.state.world.past.at(-1)?.id ?? null;
    const authority = {
      runId,
      revision: Number(run.revision),
      stateHash: String(run.state_hash),
      rootSchemaVersion: root.schemaVersion,
      shellHash: root.shellHash,
      historyLineageId: root.lineageId,
      historyHeadHash: root.historyHeadHash,
      eventCount: root.eventCount,
      tailEventId,
      tailEventContentHash: root.tailEventContentHash,
    };
    const target = {
      stateHash: authority.stateHash,
      eventCount: authority.eventCount,
      tailEventId,
    };

    const retentionFold = api.beginHistoryRetentionProjection(
      created.state,
      { stateHash: authority.stateHash },
    );
    if (created.state.world.past.length > 0) {
      api.foldHistoryRetentionSegment(retentionFold, created.state.world.past, 0);
    }
    const retention = api.finishHistoryRetentionProjection(retentionFold);
    const encodedRetention = api.encodeHistoryRetentionSidecar(retention);

    const physicalDecoded = await api.decodeBoundedRunStateWithPhysicalProjection(
      rootChunk,
      readStoredChunk,
      { hotEventLimit: 256 },
    );
    const encodedPhysical = api.encodePhysicalStructureLedgerSidecar(
      physicalDecoded.physicalProjection,
    );

    const emptyDerivedDemand = {
      settledCultivationProjects: [],
      residentialStructures: [],
      retainedEventIds: [],
      futureEventIds: [],
    };
    const derived = api.projectObserverDerivedHistoryFromFullHistory(
      created.state.world.past,
      target,
      emptyDerivedDemand,
    );
    const encodedDerived = api.encodeObserverDerivedHistorySidecar({
      sourceDemand: emptyDerivedDemand,
      projection: derived,
    });
    const civilization = api.projectObserverCivilizationHistoryFromFullHistory(
      created.state.world.past,
      target,
    );
    const encodedCivilization = api.encodeObserverCivilizationHistorySidecar(civilization);
    const checkpoint = await api.projectCheckpointAccumulatorFromVerifiedRunRoot(
      created.state,
      rootChunk,
      readStoredChunk,
      { ...authority, month: atMonth },
    );
    const encodedCheckpoint = api.encodeCheckpointAccumulator(checkpoint);

    const encodedSidecars = {
      retention: encodedRetention,
      physical: encodedPhysical,
      derivedObserver: encodedDerived,
      civilizationObserver: encodedCivilization,
      checkpoint: encodedCheckpoint,
    };
    for (const encoded of Object.values(encodedSidecars)) insertChunk(encoded.chunk);
    const hotEventLimit = 256;
    const hotStartIndex = Math.max(0, authority.eventCount - hotEventLimit);
    const coldPins = retention.pins
      .filter((pin) => pin.absoluteIndex < hotStartIndex)
      .map((pin) => ({
        absoluteIndex: pin.absoluteIndex,
        eventId: pin.eventId,
        leaseKeys: [...pin.leaseKeys],
      }));
    const encodedBundle = api.encodeRunContinuationBundle({
      schemaVersion: 1,
      historyMode: 'bounded-hot-tail-plus-cold-pins-v1',
      authority,
      hotEventLimit,
      hotStartIndex,
      coldPins,
      sidecars: Object.fromEntries(Object.entries(encodedSidecars)
        .map(([name, encoded]) => [name, encoded.reference])),
    });
    insertChunk(encodedBundle.chunk);
    database.prepare(`
      INSERT INTO run_continuations(
        run_id, revision, state_hash, root_schema_version, shell_hash,
        history_lineage_id, history_head_hash, event_count, tail_event_id,
        tail_event_content_hash, hot_event_limit, bundle_schema_version,
        bundle_hash, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      runId,
      authority.revision,
      authority.stateHash,
      authority.rootSchemaVersion,
      authority.shellHash,
      authority.historyLineageId,
      authority.historyHeadHash,
      authority.eventCount,
      authority.tailEventId,
      authority.tailEventContentHash,
      hotEventLimit,
      encodedBundle.chunk.hash,
      String(run.updated_at),
    );
    return { authority, encodedSidecars, encodedBundle, retention };
  }

  function insertCheckpointPrunePressure(runId, stateHash, createdAt) {
    const insert = database.prepare(`
      INSERT INTO run_checkpoints(run_id, revision, month, state_hash, created_at)
      VALUES (?, ?, 12, ?, ?)
    `);
    database.exec('BEGIN IMMEDIATE');
    try {
      for (let revision = 1; revision <= 256; revision += 1) {
        insert.run(runId, revision, stateHash, createdAt);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  function insertStaleContinuationGarbage(primary, observerBundle) {
    const staleChunk = (codec, name) => {
      const data = Buffer.from(`unreachable continuation fixture ${name}`, 'utf8');
      const chunk = {
        hash: api.hashRunContinuationStoredContent(codec, data),
        codec,
        rawSize: data.byteLength,
        data,
      };
      insertChunk(chunk);
      return {
        chunk,
        reference: { kind: 'content-hash', codec, hash: chunk.hash },
      };
    };
    const legacyData = Buffer.from(
      JSON.stringify(canonicalJsonValue(primary.retention)),
      'utf8',
    );
    const legacyRetention = {
      chunk: {
        hash: api.hashHistoryRetentionStoredContent(
          api.HISTORY_RETENTION_SIDECAR_LEGACY_CODEC,
          legacyData,
        ),
        codec: api.HISTORY_RETENTION_SIDECAR_LEGACY_CODEC,
        rawSize: legacyData.byteLength,
        data: legacyData,
      },
    };
    legacyRetention.reference = {
      kind: 'content-hash',
      codec: legacyRetention.chunk.codec,
      hash: legacyRetention.chunk.hash,
    };
    insertChunk(legacyRetention.chunk);
    const currentRetention = staleChunk(
      api.HISTORY_RETENTION_SIDECAR_CODEC,
      'current retention',
    );
    const physical = staleChunk(primary.encodedSidecars.physical.reference.codec, 'physical');
    const derived = staleChunk(
      primary.encodedSidecars.derivedObserver.reference.codec,
      'derived observer',
    );
    const civilization = staleChunk(
      primary.encodedSidecars.civilizationObserver.reference.codec,
      'civilization observer',
    );
    const checkpoint = staleChunk(
      primary.encodedSidecars.checkpoint.reference.codec,
      'checkpoint',
    );
    const staleSidecars = {
      retention: legacyRetention.reference,
      physical: physical.reference,
      derivedObserver: derived.reference,
      civilizationObserver: civilization.reference,
      checkpoint: checkpoint.reference,
    };
    const stalePrimaryBundle = api.encodeRunContinuationBundle({
      ...structuredClone(primary.encodedBundle.bundle),
      sidecars: staleSidecars,
    });
    const sharedReference = observerBundle.sidecars.derivedObserver;
    const staleObserverBundle = api.encodeRunContinuationBundle({
      ...structuredClone(observerBundle),
      sidecars: {
        ...staleSidecars,
        retention: currentRetention.reference,
        derivedObserver: sharedReference,
      },
    });
    insertChunk(stalePrimaryBundle.chunk);
    insertChunk(staleObserverBundle.chunk);
    const unknown = staleChunk('eland-unknown-continuation-fixture-v1', 'unknown codec');
    return {
      collectibleHashes: [
        legacyRetention.chunk.hash,
        currentRetention.chunk.hash,
        physical.chunk.hash,
        derived.chunk.hash,
        civilization.chunk.hash,
        checkpoint.chunk.hash,
        stalePrimaryBundle.chunk.hash,
        staleObserverBundle.chunk.hash,
      ],
      sharedHash: sharedReference.hash,
      unknownHash: unknown.chunk.hash,
    };
  }

  function sqliteAuthoritySnapshot() {
    return structuredClone({
      runs: database.prepare(`
        SELECT id, state_hash, revision, elapsed_months, event_count, updated_at
        FROM runs ORDER BY id
      `).all(),
      checkpoints: database.prepare(`
        SELECT run_id, revision, month, state_hash, created_at
        FROM run_checkpoints ORDER BY run_id, revision
      `).all(),
      continuations: database.prepare(`
        SELECT run_id, revision, state_hash, event_count, bundle_hash, updated_at
        FROM run_continuations ORDER BY run_id
      `).all(),
      chunks: database.prepare(`
        SELECT hash, codec, raw_size FROM chunks ORDER BY hash
      `).all(),
    });
  }

  const primaryBootstrap = await bootstrapContinuation(
    'month-12-publish',
    12,
    62_101,
    300,
  );
  await bootstrapContinuation('month-11-boundary', 11, 62_102);
  const observerPublished = await store.publishBoundedObserverBoundaryMonth(
    await store.stageBoundedObserverBoundaryMonth('month-11-boundary'),
  );
  assert.equal(observerPublished.month, 12);
  const observerContinuationBeforeGc = database.prepare(`
    SELECT state_hash, bundle_hash FROM run_continuations WHERE run_id = ?
  `).get('month-11-boundary');
  const observerBundleBeforeGc = api.decodeRunContinuationBundle(
    readStoredChunk(String(observerContinuationBeforeGc.bundle_hash)),
  );
  assert.ok(
    observerBundleBeforeGc.observerMaterializationSource,
    '年度 publication 必须留下 private observer source root',
  );
  const primaryRunBeforeGc = database.prepare(`
    SELECT state_hash, updated_at FROM runs WHERE id = ?
  `).get('month-12-publish');
  insertCheckpointPrunePressure(
    'month-12-publish',
    String(primaryRunBeforeGc.state_hash),
    String(primaryRunBeforeGc.updated_at),
  );
  const staleGarbage = insertStaleContinuationGarbage(
    primaryBootstrap,
    observerBundleBeforeGc,
  );
  store.close();
  mkdirSync(coldControlDataDirectory, { recursive: true });
  copyFileSync(
    path.join(dataDirectory, 'eland.sqlite3'),
    path.join(coldControlDataDirectory, 'eland.sqlite3'),
  );
  store = new api.SqliteRunStore(dataDirectory);
  database = store.database;
  const sourceContinuation = database.prepare(`
    SELECT state_hash, bundle_hash FROM run_continuations WHERE run_id = ?
  `).get('month-12-publish');
  const sourceBundle = api.decodeRunContinuationBundle(
    readStoredChunk(String(sourceContinuation.bundle_hash)),
  );
  const observerRestoreBeforeGc = await observerRestoreSnapshot('month-11-boundary');
  const observerRootBeforeGc = api.parseRunStateRoot(
    readStoredChunk(observerRestoreBeforeGc.stateHash),
  );

  const decodeCountsBeforeStage = store.boundedGameplayDecodePhaseCountsForTests();
  const stageStartedAt = performance.now();
  const stagingReceipt = await store.stageBoundedNonProjectionMonth('month-12-publish');
  const stageDurationMs = performance.now() - stageStartedAt;
  const decodeCountsAfterStage = store.boundedGameplayDecodePhaseCountsForTests();
  assert.equal(
    decodeCountsAfterStage.continuationOpen,
    decodeCountsBeforeStage.continuationOpen + 1,
    '普通月 stage 只应打开一次 source continuation gameplay shell',
  );
  assert.equal(decodeCountsAfterStage.nonProjectionPublish, 0);
  const forgedReceipt = Object.freeze({
    kind: 'bounded-nonprojection-month-staging-receipt-v1',
    persisted: false,
    continuationReady: false,
  });
  await assert.rejects(
    () => store.publishBoundedNonProjectionMonth(forgedReceipt),
    /不是当前 store 铸造/u,
  );

  const beforeInjectedFailure = sqliteAuthoritySnapshot();
  store.failNextBoundedPublicationAfterChunkWritesForTests();
  const failedPublishStartedAt = performance.now();
  await assert.rejects(
    () => store.publishBoundedNonProjectionMonth(stagingReceipt),
    /fixture injected bounded publication failure/u,
  );
  const failedPublishDurationMs = performance.now() - failedPublishStartedAt;
  assert.deepEqual(
    store.boundedGameplayDecodePhaseCountsForTests(),
    decodeCountsAfterStage,
    '事务失败前的 publication 不得二次 gameplay decode staged root',
  );
  assert.deepEqual(sqliteAuthoritySnapshot(), beforeInjectedFailure,
    'chunk 写入后的注入失败必须回滚 runs/checkpoints/continuations/chunks');
  for (const hash of staleGarbage.collectibleHashes) {
    assert.equal(Number(database.prepare(`
      SELECT COUNT(*) AS count FROM chunks WHERE hash = ?
    `).get(hash).count), 1, '失败回滚不得提前收集 stale continuation chunk');
  }
  assert.equal(store.ownsBoundedNonProjectionMonthStagingReceipt(stagingReceipt), true,
    '回滚不得消费 source controller receipt');

  const retryPublishStartedAt = performance.now();
  const published = await store.publishBoundedNonProjectionMonth(stagingReceipt);
  const retryPublishDurationMs = performance.now() - retryPublishStartedAt;
  assert.deepEqual(
    store.boundedGameplayDecodePhaseCountsForTests(),
    decodeCountsAfterStage,
    '回滚后的 retry 必须复用同一 Store-owned next state',
  );
  assert.deepEqual(Reflect.ownKeys(published), [
    'persisted',
    'continuationReady',
    'revision',
    'month',
    'stateHash',
  ]);
  assert.equal(published.persisted, true);
  assert.equal(published.continuationReady, false);
  assert.equal(published.revision, 301);
  assert.equal(published.month, 13);
  assert.equal(store.ownsBoundedNonProjectionMonthPublishedReceipt(published), true);
  assert.equal(store.ownsBoundedNonProjectionMonthStagingReceipt(stagingReceipt), false);
  await assert.rejects(
    () => store.publishBoundedNonProjectionMonth(stagingReceipt),
    /不是当前 store 铸造/u,
  );
  for (const hash of staleGarbage.collectibleHashes) {
    assert.equal(Number(database.prepare(`
      SELECT COUNT(*) AS count FROM chunks WHERE hash = ?
    `).get(hash).count), 0, `unreachable collectible chunk ${hash} 必须被 GC`);
  }
  assert.equal(Number(database.prepare(`
    SELECT COUNT(*) AS count FROM chunks WHERE hash = ?
  `).get(staleGarbage.sharedHash).count), 1,
  '另一个 current run 共享的 sidecar 不得被 stale bundle 连带删除');
  assert.equal(Number(database.prepare(`
    SELECT COUNT(*) AS count FROM chunks WHERE hash = ?
  `).get(staleGarbage.unknownHash).count), 1,
  '未知 codec 即使不可达也不属于本次 collector');
  assert.equal(Number(database.prepare(`
    SELECT COUNT(*) AS count FROM chunks WHERE hash = ?
  `).get(String(sourceContinuation.bundle_hash)).count), 1,
  '事务内仍活跃的 source token bundle 必须保守保留');

  const observerRestoreAfterGc = await observerRestoreSnapshot('month-11-boundary');
  const observerContinuationAfterGc = database.prepare(`
    SELECT state_hash, bundle_hash FROM run_continuations WHERE run_id = ?
  `).get('month-11-boundary');
  const observerRootAfterGc = api.parseRunStateRoot(
    readStoredChunk(observerRestoreAfterGc.stateHash),
  );
  assert.equal(
    observerRestoreAfterGc.stateHash,
    observerRestoreBeforeGc.stateHash,
    '未参与 publication 的 run 在 GC 前后必须恢复到相同 authority root',
  );
  assert.equal(
    observerRootAfterGc.historyHeadHash,
    observerRootBeforeGc.historyHeadHash,
    '未参与 publication 的完整 ledger head hash 在 GC 前后不得变化',
  );
  assert.deepEqual(
    observerRestoreAfterGc,
    observerRestoreBeforeGc,
    '未参与 publication 的 bounded restore 在 GC 前后必须语义一致',
  );
  assert.deepEqual(
    observerContinuationAfterGc,
    observerContinuationBeforeGc,
    '另一个 run 的 current continuation authority 不得被 GC 改写',
  );
  assert.equal(Number(database.prepare(`
    SELECT COUNT(*) AS count FROM chunks WHERE hash = ?
  `).get(observerBundleBeforeGc.observerMaterializationSource.stateHash).count), 1,
  'current bundle 的 private observer source root 必须保留');
  for (const reference of Object.values(observerBundleBeforeGc.sidecars)) {
    assert.equal(Number(database.prepare(`
      SELECT COUNT(*) AS count FROM chunks WHERE hash = ?
    `).get(reference.hash).count), 1, '另一个 run 的 current sidecar 必须保留');
  }
  const decodeCountsAfterGcVerification = store.boundedGameplayDecodePhaseCountsForTests();

  const persistedRun = database.prepare(`
    SELECT state_hash, revision, elapsed_months FROM runs WHERE id = ?
  `).get('month-12-publish');
  const persistedContinuation = database.prepare(`
    SELECT revision, state_hash, bundle_hash FROM run_continuations WHERE run_id = ?
  `).get('month-12-publish');
  assert.equal(Number(persistedRun.revision), 301);
  assert.equal(Number(persistedRun.elapsed_months), 13);
  assert.equal(String(persistedRun.state_hash), published.stateHash);
  assert.equal(String(persistedContinuation.state_hash), published.stateHash);
  assert.notEqual(String(persistedContinuation.state_hash), String(sourceContinuation.state_hash));
  const nextBundle = api.decodeRunContinuationBundle(
    readStoredChunk(String(persistedContinuation.bundle_hash)),
  );
  for (const name of [
    'retention',
    'physical',
    'derivedObserver',
    'civilizationObserver',
    'checkpoint',
  ]) {
    assert.notEqual(nextBundle.sidecars[name].hash, sourceBundle.sidecars[name].hash,
      `${name} successor 必须归属新 root`);
    assert.equal(readStoredChunk(nextBundle.sidecars[name].hash).codec,
      nextBundle.sidecars[name].codec);
  }
  assert.equal(Number(database.prepare(`
    SELECT COUNT(*) AS count FROM run_checkpoints WHERE run_id = ?
  `).get('month-12-publish').count), 128);

  let warmFinalPublished = published;
  for (const expectedMonth of [14, 15]) {
    const warmStage = await store.stageBoundedNonProjectionMonth('month-12-publish');
    assert.deepEqual(
      store.boundedGameplayDecodePhaseCountsForTests(),
      decodeCountsAfterGcVerification,
      `warm stage 到第 ${expectedMonth} 月不得重新 open/decode continuation`,
    );
    warmFinalPublished = await store.publishBoundedNonProjectionMonth(warmStage);
    assert.equal(warmFinalPublished.month, expectedMonth);
    assert.deepEqual(
      store.boundedGameplayDecodePhaseCountsForTests(),
      decodeCountsAfterGcVerification,
      `warm publish 到第 ${expectedMonth} 月不得 gameplay decode`,
    );
  }
  const warmFinalRun = database.prepare(`
    SELECT state_hash, revision, elapsed_months FROM runs WHERE id = ?
  `).get('month-12-publish');
  const warmFinalContinuation = database.prepare(`
    SELECT bundle_hash FROM run_continuations WHERE run_id = ?
  `).get('month-12-publish');
  assert.equal(Number(warmFinalRun.revision), 303);
  assert.equal(Number(warmFinalRun.elapsed_months), 15);
  assert.deepEqual(
    store.boundedGameplayDecodePhaseCountsForTests(),
    decodeCountsAfterGcVerification,
  );

  store.close();
  coldControlStore = new api.SqliteRunStore(coldControlDataDirectory);
  let coldFinalPublished;
  let coldOpenCount = 0;
  for (const expectedMonth of [13, 14, 15]) {
    const coldStage = await coldControlStore.stageBoundedNonProjectionMonth('month-12-publish');
    coldOpenCount += coldControlStore.boundedGameplayDecodePhaseCountsForTests().continuationOpen;
    coldFinalPublished = await coldControlStore.publishBoundedNonProjectionMonth(coldStage);
    assert.equal(coldFinalPublished.month, expectedMonth);
    coldControlStore.close();
    coldControlStore = expectedMonth === 15
      ? undefined
      : new api.SqliteRunStore(coldControlDataDirectory);
  }
  const coldVerificationStore = new api.SqliteRunStore(coldControlDataDirectory);
  const coldDatabase = coldVerificationStore.database;
  const coldFinalRun = coldDatabase.prepare(`
    SELECT state_hash, revision, elapsed_months FROM runs WHERE id = ?
  `).get('month-12-publish');
  const coldFinalContinuation = coldDatabase.prepare(`
    SELECT bundle_hash FROM run_continuations WHERE run_id = ?
  `).get('month-12-publish');
  const warmVerificationStore = new api.SqliteRunStore(dataDirectory);
  const readChunkFrom = (sourceDatabase, hash) => {
    const row = sourceDatabase.prepare(`
      SELECT hash, codec, raw_size, data FROM chunks WHERE hash = ?
    `).get(hash);
    assert.ok(row, `fixture missing chunk ${hash}`);
    return { hash: String(row.hash), codec: String(row.codec), rawSize: Number(row.raw_size), data: Buffer.from(row.data) };
  };
  const warmFinalRootChunk = readChunkFrom(
    warmVerificationStore.database,
    String(warmFinalRun.state_hash),
  );
  const coldFinalRootChunk = readChunkFrom(coldDatabase, String(coldFinalRun.state_hash));
  const warmFinalRootMetadata = api.parseRunStateRoot(warmFinalRootChunk);
  const coldFinalRootMetadata = api.parseRunStateRoot(coldFinalRootChunk);
  const finalObserverAuthority = { revision: 303, month: 15, lastMaterializedMilestoneCount: 0 };
  const warmFinalState = (await api.decodeSegmentedRunStateGameplayBounded(
    warmFinalRootChunk,
    (hash) => readChunkFrom(warmVerificationStore.database, hash),
    { hotEventLimit: 256, observerAuthority: { stateHash: String(warmFinalRun.state_hash), ...finalObserverAuthority } },
  )).state;
  const coldFinalState = (await api.decodeSegmentedRunStateGameplayBounded(
    coldFinalRootChunk,
    (hash) => readChunkFrom(coldDatabase, hash),
    { hotEventLimit: 256, observerAuthority: { stateHash: String(coldFinalRun.state_hash), ...finalObserverAuthority } },
  )).state;
  const warmFullHistory = [];
  const coldFullHistory = [];
  await api.streamVerifiedRunHistorySegments(
    warmFinalRootMetadata,
    (hash) => readChunkFrom(warmVerificationStore.database, hash),
    (events) => warmFullHistory.push(...events),
  );
  await api.streamVerifiedRunHistorySegments(
    coldFinalRootMetadata,
    (hash) => readChunkFrom(coldDatabase, hash),
    (events) => coldFullHistory.push(...events),
  );
  assert.equal(Number(coldFinalRun.revision), Number(warmFinalRun.revision));
  assert.equal(Number(coldFinalRun.elapsed_months), Number(warmFinalRun.elapsed_months));
  assert.ok(coldFinalContinuation, 'cold control 必须发布 continuation bundle');
  assert.equal(coldFinalRootMetadata.lineageId, warmFinalRootMetadata.lineageId);
  assert.equal(coldFinalRootMetadata.eventCount, warmFinalRootMetadata.eventCount);
  assert.equal(
    coldFinalRootMetadata.tailEventContentHash,
    warmFinalRootMetadata.tailEventContentHash,
  );
  assert.deepEqual(
    warmFinalState,
    coldFinalState,
    '连续 warm 路径必须与逐月关闭重开的 cold 路径产生相同权威语义状态',
  );
  assert.deepEqual(
    warmFullHistory,
    coldFullHistory,
    '连续 warm 路径必须与逐月关闭重开的 cold 路径产生相同完整事件历史',
  );
  // V8 wire preserves Smi versus HeapNumber representation for equal JS
  // numbers, so semantically equal roots may have different content hashes
  // across an encode/decode boundary. Each branch still verifies its own exact
  // root/bundle CAS; cross-branch determinism is defined by state and history.
  warmVerificationStore.close();
  coldVerificationStore.close();

  store = new api.SqliteRunStore(dataDirectory);
  database = store.database;
  const reopened = await store.openBoundedEvolutionContinuation('month-12-publish');
  assert.equal(reopened.meta.revision, 303);
  assert.equal(reopened.meta.elapsedMonths, 15);
  assert.equal(reopened.state.clock.elapsedMonths, 15);
  assert.equal(reopened.basis.stateHash, warmFinalPublished.stateHash);
  assert.equal(reopened.continuationReady, false);

  assert.equal(observerRestoreAfterGc.meta.revision, 2);
  assert.equal(observerRestoreAfterGc.meta.elapsedMonths, 12);

  const beforeStaleInvalidation = sqliteAuthoritySnapshot();
  const staleReceipt = await store.stageBoundedNonProjectionMonth('month-12-publish');
  assert.equal(store.ownsBoundedNonProjectionMonthStagingReceipt(staleReceipt), true);
  await store.openBoundedEvolutionContinuation('month-12-publish');
  assert.equal(store.ownsBoundedNonProjectionMonthStagingReceipt(staleReceipt), false,
    '同一 run 的新 continuation generation 必须清除旧 Store-owned next state');
  await assert.rejects(
    () => store.publishBoundedNonProjectionMonth(staleReceipt),
    /不是当前 store 铸造/u,
  );
  assert.deepEqual(sqliteAuthoritySnapshot(), beforeStaleInvalidation,
    'stale owned state 清理不得写 SQLite authority');

  const maxRssBytes = process.resourceUsage().maxRSS * 1_024;
  assert.ok(maxRssBytes <= MAX_FIXTURE_RSS_BYTES,
    `fixture max RSS ${maxRssBytes} 超过 288MiB`);
  console.log(JSON.stringify({
    ok: true,
    published: '12->13 atomic root plus five sidecars',
    rollback: 'post-chunk injected failure left all authority and chunks unchanged, then retried',
    rejected: 'forged receipt and stale owned state',
    reopenedRevision: reopened.meta.revision,
    reopenedMonth: reopened.meta.elapsedMonths,
    authorityHash: published.stateHash,
    bundleHash: String(persistedContinuation.bundle_hash),
    sidecarHashes: Object.fromEntries(Object.entries(nextBundle.sidecars)
      .map(([name, reference]) => [name, reference.hash])),
    gameplayDecodePhases: decodeCountsAfterGcVerification,
    stageDurationMs: Number(stageDurationMs.toFixed(2)),
    failedPublishDurationMs: Number(failedPublishDurationMs.toFixed(2)),
    retryPublishDurationMs: Number(retryPublishDurationMs.toFixed(2)),
    maxRssBytes,
  }));
} finally {
  store?.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
