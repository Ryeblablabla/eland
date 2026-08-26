import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deserialize } from 'node:v8';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-bounded-checkpoint-prune-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');
const dataDirectory = path.join(temporaryDirectory, 'data');
const childEnvironment = { ...process.env, NODE_OPTIONS: '--max-old-space-size=256' };
let store;

try {
  writeFileSync(entryPath, [
    `export { RUN_CHECKPOINT_PRUNE_THRESHOLD, RUN_CHECKPOINT_RETENTION, SqliteRunStore } from ${JSON.stringify(path.join(workspace, 'server/sqlite-run-store.ts'))};`,
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
    `export { RUN_STATE_ROOT_CODEC } from ${JSON.stringify(path.join(workspace, 'server/run-state-codec.ts'))};`,
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
  const readStoredChunk = (hash) => {
    const row = database.prepare(`
      SELECT hash, codec, raw_size, data FROM chunks WHERE hash = ?
    `).get(hash);
    assert.ok(row, `fixture missing chunk ${hash}`);
    return {
      hash: String(row.hash),
      codec: String(row.codec),
      rawSize: Number(row.raw_size),
      data: Buffer.from(row.data),
    };
  };
  const insertChunk = (chunk) => database.prepare(`
    INSERT OR IGNORE INTO chunks(hash, codec, raw_size, data) VALUES (?, ?, ?, ?)
  `).run(chunk.hash, chunk.codec, chunk.rawSize, chunk.data);

  const runId = 'checkpoint-prune';
  const atMonth = 12;
  const initial = api.createInitialState(62_103, {
    endpoint: { kind: 'months', value: 120 },
  });
  initial.clock.elapsedMonths = atMonth;
  const created = await store.create({ id: runId, state: initial });
  database.prepare(`
    UPDATE run_checkpoints SET revision = ? WHERE run_id = ? AND revision = 1
  `).run(api.RUN_CHECKPOINT_PRUNE_THRESHOLD, runId);
  database.prepare(`
    UPDATE runs SET revision = ? WHERE id = ? AND revision = 1
  `).run(api.RUN_CHECKPOINT_PRUNE_THRESHOLD, runId);

  const run = database.prepare(`
    SELECT state_hash, revision, event_count, updated_at FROM runs WHERE id = ?
  `).get(runId);
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
  const physical = await api.decodeBoundedRunStateWithPhysicalProjection(
    rootChunk,
    readStoredChunk,
    { hotEventLimit: 256 },
  );
  const encodedPhysical = api.encodePhysicalStructureLedgerSidecar(
    physical.physicalProjection,
  );
  const emptyDerivedDemand = {
    settledCultivationProjects: [],
    residentialStructures: [],
    retainedEventIds: [],
    futureEventIds: [],
  };
  const encodedDerived = api.encodeObserverDerivedHistorySidecar({
    sourceDemand: emptyDerivedDemand,
    projection: api.projectObserverDerivedHistoryFromFullHistory(
      created.state.world.past,
      target,
      emptyDerivedDemand,
    ),
  });
  const encodedCivilization = api.encodeObserverCivilizationHistorySidecar(
    api.projectObserverCivilizationHistoryFromFullHistory(created.state.world.past, target),
  );
  const encodedCheckpoint = api.encodeCheckpointAccumulator(
    await api.projectCheckpointAccumulatorFromVerifiedRunRoot(
      created.state,
      rootChunk,
      readStoredChunk,
      { ...authority, month: atMonth },
    ),
  );
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

  const insertHistoricalCheckpoint = database.prepare(`
    INSERT INTO run_checkpoints(run_id, revision, month, state_hash, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (let revision = 1; revision < api.RUN_CHECKPOINT_PRUNE_THRESHOLD; revision += 1) {
    insertHistoricalCheckpoint.run(
      runId,
      revision,
      atMonth,
      authority.stateHash,
      String(run.updated_at),
    );
  }
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

  const countSchemaRootCheckpoints = () => database.prepare(`
    SELECT COUNT(*) AS count, MIN(checkpoint.revision) AS min_revision,
      MAX(checkpoint.revision) AS max_revision
    FROM run_checkpoints AS checkpoint
    JOIN chunks AS state_root ON state_root.hash = checkpoint.state_hash
    WHERE checkpoint.run_id = ? AND state_root.codec = ?
  `).get(runId, api.RUN_STATE_ROOT_CODEC);
  assert.equal(
    Number(countSchemaRootCheckpoints().count),
    api.RUN_CHECKPOINT_PRUNE_THRESHOLD,
    'fixture 应以真实 schema root 填满 threshold，而不是演化 256 个重月份',
  );

  store.close();
  store = new api.SqliteRunStore(dataDirectory);
  database = store.database;
  const source = await store.openBoundedEvolutionContinuation(runId);
  assert.equal(source.meta.revision, api.RUN_CHECKPOINT_PRUNE_THRESHOLD);
  const startedAt = performance.now();
  const staged = await store.stageBoundedNonProjectionMonth(runId);
  const published = await store.publishBoundedNonProjectionMonth(staged);
  const durationMs = performance.now() - startedAt;
  assert.equal(published.revision, api.RUN_CHECKPOINT_PRUNE_THRESHOLD + 1);
  assert.equal(published.month, atMonth + 1);

  const stats = countSchemaRootCheckpoints();
  assert.equal(Number(stats.count), api.RUN_CHECKPOINT_RETENTION,
    'bounded publish 跨过 threshold 后应立即收敛到 retention');
  assert.equal(
    Number(stats.min_revision),
    api.RUN_CHECKPOINT_PRUNE_THRESHOLD + 2 - api.RUN_CHECKPOINT_RETENTION,
  );
  assert.equal(Number(stats.max_revision), published.revision);
  assert.ok(database.prepare(`
    SELECT 1
    FROM runs AS run
    JOIN run_checkpoints AS checkpoint
      ON checkpoint.run_id = run.id
      AND checkpoint.revision = run.revision
      AND checkpoint.state_hash = run.state_hash
    JOIN run_continuations AS continuation
      ON continuation.run_id = run.id
      AND continuation.revision = run.revision
      AND continuation.state_hash = run.state_hash
    WHERE run.id = ?
  `).get(runId), 'pruning 不得删除当前 exact checkpoint 或 continuation authority');

  store.close();
  store = new api.SqliteRunStore(dataDirectory);
  const reopened = await store.openBoundedEvolutionContinuation(runId);
  assert.equal(reopened.meta.revision, published.revision);
  assert.equal(reopened.meta.elapsedMonths, atMonth + 1);
  assert.equal(reopened.state.clock.elapsedMonths, atMonth + 1);
  assert.equal(reopened.basis.stateHash, published.stateHash);

  const maxRssBytes = process.resourceUsage().maxRSS * 1_024;
  assert.ok(maxRssBytes <= 256 * 1_024 * 1_024,
    `fixture max RSS ${maxRssBytes} 超过 256MiB`);
  console.log(JSON.stringify({
    ok: true,
    threshold: api.RUN_CHECKPOINT_PRUNE_THRESHOLD,
    retained: Number(stats.count),
    minRevision: Number(stats.min_revision),
    maxRevision: Number(stats.max_revision),
    coldReopenedRevision: reopened.meta.revision,
    durationMs: Number(durationMs.toFixed(2)),
    maxRssBytes,
  }));
} finally {
  store?.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
