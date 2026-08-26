import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deserialize } from 'node:v8';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-bounded-bootstrap-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');
const dataDirectory = path.join(temporaryDirectory, 'data');
const childEnvironment = { ...process.env, NODE_OPTIONS: '--max-old-space-size=256' };
let store;

function appendFixtureHistory(state, count) {
  const cursor = state.world.historyCursor;
  assert.ok(cursor, 'fixture state 必须携带 absolute history cursor');
  state.clock.elapsedMonths = 24;
  const start = cursor.eventCount;
  const events = Array.from({ length: count }, (_, orderInMonth) => ({
    id: `bounded-bootstrap-event-${start + orderInMonth}`,
    kind: 'environment',
    atMonth: 24,
    orderInMonth,
    planningTick: 0,
    orderInTick: orderInMonth,
    cellId: 0,
    change: 'material',
    result: 'bounded continuation bootstrap fixture fact',
    diff: {
      fixtureKind: 'bounded-continuation-bootstrap',
      absoluteIndex: start + orderInMonth,
    },
  }));
  state.world.past.push(...events);
  cursor.eventCount += events.length;
  cursor.tailEventId = events.at(-1)?.id ?? cursor.tailEventId;
  state.lastStep = events.slice(-8);
}

try {
  writeFileSync(entryPath, [
    `export { SqliteRunStore } from ${JSON.stringify(path.join(workspace, 'server/sqlite-run-store.ts'))};`,
    `export { createInitialState } from ${JSON.stringify(path.join(workspace, 'src/game/eland/simulation.ts'))};`,
    `export { decodeRunContinuationBundle } from ${JSON.stringify(path.join(workspace, 'server/run-continuation-bundle.ts'))};`,
    `export { decodeHistoryRetentionSidecar } from ${JSON.stringify(path.join(workspace, 'server/history-retention-codec.ts'))};`,
    `export { decodePhysicalStructureLedgerSidecar } from ${JSON.stringify(path.join(workspace, 'server/physical-structure-ledger-codec.ts'))};`,
    `export { decodeObserverDerivedHistorySidecar } from ${JSON.stringify(path.join(workspace, 'server/observer-derived-history-codec.ts'))};`,
    `export { decodeObserverCivilizationHistorySidecar } from ${JSON.stringify(path.join(workspace, 'server/civilization-history-codec.ts'))};`,
    `export { decodeCheckpointAccumulator } from ${JSON.stringify(path.join(workspace, 'server/checkpoint-accumulator.ts'))};`,
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
  const state = api.createInitialState(72_601, {
    endpoint: { kind: 'months', value: 12_000 },
  });
  appendFixtureHistory(state, 320);
  const created = await store.create({ id: 'schema3-streaming-bootstrap', state });

  function readChunk(hash) {
    const row = database.prepare(`
      SELECT hash, codec, raw_size, data FROM chunks WHERE hash = ?
    `).get(hash);
    assert.ok(row, `fixture chunk ${hash} 必须存在`);
    return {
      hash: String(row.hash),
      codec: String(row.codec),
      rawSize: Number(row.raw_size),
      data: Buffer.from(row.data),
    };
  }

  const beforeRun = structuredClone(database.prepare(`
    SELECT * FROM runs WHERE id = ?
  `).get(created.meta.id));
  const beforeCheckpoint = structuredClone(database.prepare(`
    SELECT * FROM run_checkpoints WHERE run_id = ? AND revision = ?
  `).get(created.meta.id, created.meta.revision));
  assert.equal(deserialize(readChunk(String(beforeRun.state_hash)).data).schemaVersion, 3);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM run_continuations WHERE run_id = ?
  `).get(created.meta.id).count, 0);

  await assert.rejects(
    () => store.bootstrapBoundedEvolutionContinuation(created.meta.id, 0),
    /hotEventLimit/u,
  );
  await assert.rejects(
    () => store.bootstrapBoundedEvolutionContinuation(created.meta.id, 65_537),
    /hotEventLimit/u,
  );

  const receipt = await store.bootstrapBoundedEvolutionContinuation(created.meta.id, 64);
  assert.deepEqual(Reflect.ownKeys(receipt), [
    'kind',
    'persisted',
    'continuationReady',
  ]);
  assert.equal(receipt.persisted, true);
  assert.equal(receipt.continuationReady, false);
  assert.deepEqual(structuredClone(
    database.prepare(`SELECT * FROM runs WHERE id = ?`).get(created.meta.id),
  ), beforeRun,
    'bootstrap 不得推进或改写 run authority');
  assert.deepEqual(structuredClone(database.prepare(`
    SELECT * FROM run_checkpoints WHERE run_id = ? AND revision = ?
  `).get(created.meta.id, created.meta.revision)), beforeCheckpoint,
  'bootstrap 不得改写 exact checkpoint');

  const continuation = database.prepare(`
    SELECT * FROM run_continuations WHERE run_id = ?
  `).get(created.meta.id);
  assert.ok(continuation);
  assert.equal(String(continuation.state_hash), String(beforeRun.state_hash));
  assert.equal(Number(continuation.revision), Number(beforeRun.revision));
  assert.equal(Number(continuation.event_count), Number(beforeRun.event_count));
  assert.equal(Number(continuation.hot_event_limit), 64);
  const bundle = api.decodeRunContinuationBundle(readChunk(String(continuation.bundle_hash)));
  assert.equal(bundle.authority.stateHash, String(beforeRun.state_hash));
  assert.equal(bundle.authority.revision, Number(beforeRun.revision));
  assert.equal(bundle.authority.eventCount, Number(beforeRun.event_count));
  assert.equal(bundle.hotStartIndex, Number(beforeRun.event_count) - 64);

  const target = {
    stateHash: String(beforeRun.state_hash),
    eventCount: Number(beforeRun.event_count),
    tailEventId: bundle.authority.tailEventId,
  };
  const retentionBoundary = {
    authority: { stateHash: target.stateHash },
    target: { eventCount: target.eventCount, tailEventId: target.tailEventId },
  };
  const checkpointBoundary = {
    ...bundle.authority,
    month: Number(beforeRun.elapsed_months),
  };
  const retention = api.decodeHistoryRetentionSidecar(
    readChunk(bundle.sidecars.retention.hash),
    { reference: bundle.sidecars.retention, boundary: retentionBoundary },
  );
  const physical = api.decodePhysicalStructureLedgerSidecar(
    readChunk(bundle.sidecars.physical.hash),
    { reference: bundle.sidecars.physical, boundary: retentionBoundary },
  );
  const derived = api.decodeObserverDerivedHistorySidecar(
    readChunk(bundle.sidecars.derivedObserver.hash),
    { reference: bundle.sidecars.derivedObserver, boundary: { target } },
  );
  const civilization = api.decodeObserverCivilizationHistorySidecar(
    readChunk(bundle.sidecars.civilizationObserver.hash),
    { reference: bundle.sidecars.civilizationObserver, boundary: { target } },
  );
  const checkpoint = api.decodeCheckpointAccumulator(
    readChunk(bundle.sidecars.checkpoint.hash),
    { reference: bundle.sidecars.checkpoint, boundary: checkpointBoundary },
  );
  assert.equal(retention.authority.stateHash, target.stateHash);
  assert.equal(physical.authority.stateHash, target.stateHash);
  assert.equal(derived.projection.target.stateHash, target.stateHash);
  assert.deepEqual(derived.sourceDemand.retainedEventIds, [],
    'genesis derived demand 不得继承 caller-supplied retained IDs');
  assert.equal(civilization.projection.target.stateHash, target.stateHash);
  assert.equal(checkpoint.boundary.stateHash, target.stateHash);

  await assert.rejects(
    () => store.bootstrapBoundedEvolutionContinuation(created.meta.id, 64),
    /已有 bounded continuation/u,
  );

  const openedBeforeRefresh = await store.openBoundedEvolutionContinuation(created.meta.id);
  const staleToken = openedBeforeRefresh.continuationToken;
  assert.equal(store.ownsBoundedEvolutionContinuationToken(staleToken), true);
  const continuationBeforeRefresh = structuredClone(database.prepare(`
    SELECT * FROM run_continuations WHERE run_id = ?
  `).get(created.meta.id));
  const chunkCountBeforeRefresh = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM chunks
  `).get().count);

  store.failNextBoundedPublicationAfterChunkWritesForTests();
  await assert.rejects(
    () => store.refreshBoundedEvolutionContinuation(created.meta.id, 48),
    /fixture injected bounded publication failure/u,
  );
  assert.deepEqual(structuredClone(database.prepare(`
    SELECT * FROM run_continuations WHERE run_id = ?
  `).get(created.meta.id)), continuationBeforeRefresh,
  'refresh 失败必须回滚 continuation CAS');
  assert.equal(Number(database.prepare(`
    SELECT COUNT(*) AS count FROM chunks
  `).get().count), chunkCountBeforeRefresh,
  'refresh 失败必须回滚新 sidecar/bundle chunks');
  assert.equal(store.ownsBoundedEvolutionContinuationToken(staleToken), true,
    'refresh 失败不得使原 token 失效');

  const refreshReceipt = await store.refreshBoundedEvolutionContinuation(
    created.meta.id,
    48,
  );
  assert.deepEqual(Reflect.ownKeys(refreshReceipt), [
    'kind',
    'persisted',
    'continuationReady',
  ]);
  assert.equal(refreshReceipt.persisted, true);
  assert.equal(refreshReceipt.continuationReady, false);
  assert.equal(store.ownsBoundedEvolutionContinuationToken(staleToken), false,
    '同 revision/state 的 manifest refresh 必须使旧 token 失效');
  assert.deepEqual(structuredClone(
    database.prepare(`SELECT * FROM runs WHERE id = ?`).get(created.meta.id),
  ), beforeRun,
  'refresh 不得推进或改写 run authority');
  assert.deepEqual(structuredClone(database.prepare(`
    SELECT * FROM run_checkpoints WHERE run_id = ? AND revision = ?
  `).get(created.meta.id, created.meta.revision)), beforeCheckpoint,
  'refresh 不得改写 exact checkpoint');

  const continuationAfterRefresh = database.prepare(`
    SELECT * FROM run_continuations WHERE run_id = ?
  `).get(created.meta.id);
  assert.equal(String(continuationAfterRefresh.state_hash), String(beforeRun.state_hash));
  assert.equal(Number(continuationAfterRefresh.revision), Number(beforeRun.revision));
  assert.equal(Number(continuationAfterRefresh.event_count), Number(beforeRun.event_count));
  assert.equal(Number(continuationAfterRefresh.hot_event_limit), 48);
  assert.notEqual(
    String(continuationAfterRefresh.bundle_hash),
    String(continuationBeforeRefresh.bundle_hash),
    '不同 hot window 的全量重建必须发布新 bundle',
  );
  const refreshedBundle = api.decodeRunContinuationBundle(
    readChunk(String(continuationAfterRefresh.bundle_hash)),
  );
  assert.equal(refreshedBundle.authority.stateHash, String(beforeRun.state_hash));
  assert.equal(refreshedBundle.authority.revision, Number(beforeRun.revision));
  assert.equal(refreshedBundle.hotStartIndex, Number(beforeRun.event_count) - 48);
  const openedAfterRefresh = await store.openBoundedEvolutionContinuation(created.meta.id);
  assert.equal(openedAfterRefresh.state.world.past.length, 48);
  assert.equal(
    store.ownsBoundedEvolutionContinuationToken(openedAfterRefresh.continuationToken),
    true,
  );

  store.close();
  store = new api.SqliteRunStore(dataDirectory);
  database = store.database;
  const reopened = await store.openBoundedEvolutionContinuation(created.meta.id);
  assert.equal(reopened.meta.revision, created.meta.revision);
  assert.equal(reopened.meta.elapsedMonths, 24);
  assert.equal(reopened.basis.stateHash, String(beforeRun.state_hash));
  assert.equal(reopened.state.world.historyCursor.eventCount, Number(beforeRun.event_count));
  assert.equal(reopened.state.world.past.length, 48);
  assert.equal(store.ownsBoundedEvolutionContinuationToken(reopened.continuationToken), true);

  const genesisState = api.createInitialState(72_602, {
    endpoint: { kind: 'months', value: 12_000 },
  });
  const genesis = await store.create({ id: 'all-hot-genesis-bootstrap', state: genesisState });
  await store.bootstrapBoundedEvolutionContinuation(genesis.meta.id, 64);
  const genesisContinuation = database.prepare(`
    SELECT * FROM run_continuations WHERE run_id = ?
  `).get(genesis.meta.id);
  const genesisBundle = api.decodeRunContinuationBundle(
    readChunk(String(genesisContinuation.bundle_hash)),
  );
  assert.equal(genesisBundle.hotStartIndex, 0);
  assert.deepEqual(genesisBundle.coldPins, []);
  const openedGenesis = await store.openBoundedEvolutionContinuation(genesis.meta.id);
  assert.equal(openedGenesis.state.world.historyCursor.hotStartIndex, 0);
  assert.equal(openedGenesis.state.world.past.length, 1);
  assert.equal(openedGenesis.state.world.past[0].id, 'e-0-environment-founding-0');

  console.log(JSON.stringify({
    ok: true,
    rootSchemaVersion: 3,
    revision: reopened.meta.revision,
    month: reopened.meta.elapsedMonths,
    eventCount: reopened.state.world.historyCursor.eventCount,
    hotEventCount: reopened.state.world.past.length,
    sidecars: Object.keys(refreshedBundle.sidecars).length,
    refreshedBundle: String(continuationAfterRefresh.bundle_hash),
    rollback: 'post-chunk failure preserved old continuation and token',
    allHotGenesis: 'one founding fact bootstrapped without synthetic warmup',
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
  }));
} finally {
  store?.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
