import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deserialize } from 'node:v8';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-bounded-month-stage-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');
const dataDirectory = path.join(temporaryDirectory, 'data');
const childEnvironment = { ...process.env, NODE_OPTIONS: '--max-old-space-size=128' };
let store;

function appendFixtureMonth(state, atMonth, runId) {
  const cursor = state.world.historyCursor;
  assert.ok(cursor, 'fixture state 必须有 history cursor');
  const events = Array.from({ length: 8 }, (_, orderInMonth) => ({
    id: `${runId}-fixture-${orderInMonth}`,
    kind: 'environment',
    atMonth,
    orderInMonth,
    planningTick: 0,
    orderInTick: orderInMonth,
    cellId: 0,
    change: 'material',
    result: 'bounded non-projection month staging fixture fact',
    diff: { fixtureKind: 'bounded-nonprojection-month-stage', orderInMonth },
  }));
  state.clock.elapsedMonths = atMonth;
  state.world.past.push(...events);
  cursor.eventCount += events.length;
  cursor.tailEventId = events.at(-1).id;
  state.lastStep = events;
}

try {
  writeFileSync(entryPath, [
    `export { SqliteRunStore } from ${JSON.stringify(path.join(workspace, 'server/sqlite-run-store.ts'))};`,
    `export { encodeRunContinuationBundle } from ${JSON.stringify(path.join(workspace, 'server/run-continuation-bundle.ts'))};`,
    `export { beginHistoryRetentionProjection, foldHistoryRetentionSegment, finishHistoryRetentionProjection } from ${JSON.stringify(path.join(workspace, 'server/history-retention-projection.ts'))};`,
    `export { encodeHistoryRetentionSidecar } from ${JSON.stringify(path.join(workspace, 'server/history-retention-codec.ts'))};`,
    `export { decodeBoundedRunStateWithPhysicalProjection } from ${JSON.stringify(path.join(workspace, 'server/physical-structure-ledger-projection.ts'))};`,
    `export { encodePhysicalStructureLedgerSidecar } from ${JSON.stringify(path.join(workspace, 'server/physical-structure-ledger-codec.ts'))};`,
    `export { projectObserverDerivedHistoryFromFullHistory } from ${JSON.stringify(path.join(workspace, 'server/observer-derived-history-projection.ts'))};`,
    `export { encodeObserverDerivedHistorySidecar } from ${JSON.stringify(path.join(workspace, 'server/observer-derived-history-codec.ts'))};`,
    `export { projectObserverCivilizationHistoryFromFullHistory } from ${JSON.stringify(path.join(workspace, 'server/observer-civilization-history-projection.ts'))};`,
    `export { encodeObserverCivilizationHistorySidecar } from ${JSON.stringify(path.join(workspace, 'server/civilization-history-codec.ts'))};`,
    `export { encodeCheckpointAccumulator, projectCheckpointAccumulatorFromVerifiedRunRoot } from ${JSON.stringify(path.join(workspace, 'server/checkpoint-accumulator.ts'))};`,
    `export { createInitialState } from ${JSON.stringify(path.join(workspace, 'src/game/eland/simulation.ts'))};`,
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
  const database = store.database;

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

  async function bootstrapContinuation(runId, atMonth, seed) {
    const initial = api.createInitialState(seed, {
      endpoint: { kind: 'months', value: 120 },
    });
    appendFixtureMonth(initial, atMonth, runId);
    const created = await store.create({ id: runId, state: initial });
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
      { hotEventLimit: 8 },
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
    const hotEventLimit = 8;
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
      chunks: Number(database.prepare('SELECT COUNT(*) AS count FROM chunks').get().count),
    });
  }

  await bootstrapContinuation('month-12-positive', 12, 61_201);
  await bootstrapContinuation('month-11-boundary', 11, 61_202);
  const before = sqliteAuthoritySnapshot();

  const receipt = await store.stageBoundedNonProjectionMonth('month-12-positive');
  assert.deepEqual(Reflect.ownKeys(receipt), ['kind', 'persisted', 'continuationReady']);
  assert.equal(receipt.kind, 'bounded-nonprojection-month-staging-receipt-v1');
  assert.equal(receipt.persisted, false);
  assert.equal(receipt.continuationReady, false);
  assert.equal(store.ownsBoundedNonProjectionMonthStagingReceipt(receipt), true);
  assert.equal(store.ownsBoundedEvolutionSuccessorStagingReceipt(receipt), false,
    'controller receipt 不能冒充普通 caller-state staging receipt');
  assert.deepEqual(sqliteAuthoritySnapshot(), before,
    '成功的内存 staging 不得写入任何 SQLite authority 或 chunk');

  await assert.rejects(
    () => store.stageBoundedNonProjectionMonth('month-11-boundary'),
    /第 12 月年度观察边界/u,
  );
  assert.deepEqual(sqliteAuthoritySnapshot(), before,
    '年度观察边界拒绝不得 staging 或写入 SQLite');

  const rssBytes = process.memoryUsage().rss;
  console.log(JSON.stringify({
    ok: true,
    positive: '12->13 staged in memory',
    rejected: '11->12 annual observer boundary',
    sqliteAuthorityUnchanged: true,
    rssBytes,
  }));
} finally {
  store?.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
