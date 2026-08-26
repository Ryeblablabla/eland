import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-observer-boundary-publish-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');
const dataDirectory = path.join(temporaryDirectory, 'data');
const childEnvironment = { ...process.env, NODE_OPTIONS: '--max-old-space-size=256' };
// The fixture now exercises the bounded lower-era floor and gate materializer
// in addition to root A/B, rollback and five sidecars. Keep a tight explicit
// process budget without forcing production code to optimize for test overlap.
const MAX_FIXTURE_RSS_BYTES = 288 * 1_024 * 1_024;
const basisField = 'lastMaterializedObserverBasis';
let store;

function appendFixtureMonth(state, atMonth, runId) {
  const cursor = state.world.historyCursor;
  assert.ok(cursor, 'fixture state 必须有 history cursor');
  const firstAbsoluteIndex = cursor.eventCount;
  const events = Array.from({ length: 320 }, (_, orderInMonth) => ({
    id: `${runId}-fixture-${firstAbsoluteIndex + orderInMonth}`,
    kind: 'environment',
    atMonth,
    orderInMonth,
    planningTick: 0,
    orderInTick: orderInMonth,
    cellId: 0,
    change: 'material',
    result: 'bounded observer boundary publication fixture fact',
    diff: { fixtureKind: 'bounded-observer-boundary-publish', orderInMonth },
  }));
  state.clock.elapsedMonths = atMonth;
  state.world.past.push(...events);
  cursor.eventCount += events.length;
  cursor.tailEventId = events.at(-1).id;
  state.lastStep = events.slice(-8);
}

function appendFixtureConstruction(state, atMonth, runId, api) {
  const cursor = state.world.historyCursor;
  assert.ok(cursor, 'fixture state 必须有 history cursor');
  const position = { x: 0, y: 0, z: 5 };
  const event = {
    id: `${runId}-legacy-physical-structure`,
    kind: 'action',
    atMonth,
    orderInMonth: 0,
    planningTick: 0,
    orderInTick: 0,
    actionTick: 1,
    who: state.people[0].id,
    cause: 'intent',
    action: { kind: 'act', operation: 'combine', targets: [] },
    fromCellId: 0,
    toCellId: 0,
    fromZ: 5,
    toZ: 5,
    pathSegment: [0],
    status: 'completed',
    result: 'legacy physical structure fact',
    diff: { outputMaterialId: api.Material.Stone, position },
  };
  api.setVoxel(state.world.grid, position.x, position.y, position.z, api.Material.Stone);
  state.clock.elapsedMonths = atMonth;
  state.world.past.push(event);
  cursor.eventCount += 1;
  cursor.tailEventId = event.id;
  state.lastStep = [event];
}

try {
  writeFileSync(entryPath, [
    `export { SqliteRunStore } from ${JSON.stringify(path.join(workspace, 'server/sqlite-run-store.ts'))};`,
    `export { decodeRunContinuationBundle } from ${JSON.stringify(path.join(workspace, 'server/run-continuation-bundle.ts'))};`,
    `export { markReachableRunStateChunks, parseRunStateRoot } from ${JSON.stringify(path.join(workspace, 'server/run-state-codec.ts'))};`,
    `export { assertCanonicalBoundedObserverHotShell } from ${JSON.stringify(path.join(workspace, 'server/bounded-observer-hot-shell.ts'))};`,
    `export { createInitialState } from ${JSON.stringify(path.join(workspace, 'src/game/eland/simulation.ts'))};`,
    `export { Material } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/material.ts'))};`,
    `export { setVoxel } from ${JSON.stringify(path.join(workspace, 'src/game/eland/world/grid.ts'))};`,
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
      data: row.data,
    };
  }

  function authoritySnapshot() {
    return structuredClone({
      runs: database.prepare(`
        SELECT id, state_hash, revision, elapsed_months, event_count,
               milestone_count, updated_at
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

  async function createBootstrappedRun(runId, seed, endpoint, mutate) {
    const state = api.createInitialState(seed, { endpoint, chaosIntensity: 0 });
    mutate?.(state);
    appendFixtureMonth(state, 11, runId);
    const created = await store.create({ id: runId, state });
    await store.bootstrapBoundedEvolutionContinuation(runId, 256);
    return created;
  }

  await createBootstrappedRun(
    'annual-running',
    82_601,
    { kind: 'months', value: 120 },
    (state) => appendFixtureConstruction(state, 10, 'annual-running', api),
  );
  const sourceOpened = await store.openBoundedEvolutionContinuation('annual-running');
  assert.ok(
    sourceOpened.state.world.physicalStructureIndex.structures.length > 0,
    'fixture 必须让月末物理索引产生非空 compatibility structures',
  );
  assert.deepEqual(
    sourceOpened.state.derived.structures,
    [],
    '年度源 continuation 必须以 canonical bounded observer hot shell 进入规则月',
  );
  const sourceIndex = structuredClone(sourceOpened.state.civilization.civilizationIndex);
  const sourceMilestoneCount = sourceOpened.meta.milestoneCount;
  const staging = await store.stageBoundedObserverBoundaryMonth('annual-running');
  assert.equal(store.ownsBoundedObserverBoundaryMonthStagingReceipt(staging), true);
  await assert.rejects(
    () => store.publishBoundedObserverBoundaryMonth(Object.freeze({
      kind: 'bounded-observer-boundary-month-staging-receipt-v1',
      persisted: false,
      continuationReady: false,
    })),
    /不是当前 store 铸造/u,
  );

  const beforeInjectedFailure = authoritySnapshot();
  store.failNextBoundedPublicationAfterChunkWritesForTests();
  await assert.rejects(
    () => store.publishBoundedObserverBoundaryMonth(staging),
    /fixture injected bounded publication failure/u,
  );
  assert.deepEqual(
    authoritySnapshot(),
    beforeInjectedFailure,
    'A/B chunks 写入后的注入失败必须回滚全部 SQLite authority 与 chunks',
  );
  assert.equal(
    store.ownsBoundedObserverBoundaryMonthStagingReceipt(staging),
    true,
    '回滚不得消费年度边界 receipt',
  );

  const published = await store.publishBoundedObserverBoundaryMonth(staging);
  assert.deepEqual(Reflect.ownKeys(published), [
    'kind',
    'boundaryKind',
    'persisted',
    'continuationReady',
    'revision',
    'month',
    'stateHash',
    'status',
    'stage',
  ]);
  assert.equal(published.kind, 'bounded-observer-boundary-month-published-receipt-v1');
  assert.equal(published.boundaryKind, 'annual');
  assert.equal(published.persisted, true);
  assert.equal(published.continuationReady, false);
  assert.equal(published.revision, 2);
  assert.equal(published.month, 12);
  assert.equal(published.status, 'running');
  assert.equal(typeof published.stage, 'string');
  assert.equal(store.ownsBoundedObserverBoundaryMonthStagingReceipt(staging), false);
  assert.equal(store.ownsBoundedObserverBoundaryMonthPublishedReceipt(published), true);

  const persistedRun = database.prepare(`
    SELECT state_hash, revision, elapsed_months, status, milestone_count
    FROM runs WHERE id = ?
  `).get('annual-running');
  const persistedContinuation = database.prepare(`
    SELECT state_hash, revision, bundle_hash FROM run_continuations WHERE run_id = ?
  `).get('annual-running');
  assert.equal(Number(persistedRun.revision), 2);
  assert.equal(Number(persistedRun.elapsed_months), 12);
  assert.equal(String(persistedRun.status), 'running');
  assert.equal(Number(persistedRun.milestone_count), sourceMilestoneCount);
  assert.equal(String(persistedRun.state_hash), published.stateHash);
  assert.equal(String(persistedContinuation.state_hash), published.stateHash);

  const bundle = api.decodeRunContinuationBundle(
    readStoredChunk(String(persistedContinuation.bundle_hash)),
  );
  const factSource = bundle.observerMaterializationSource;
  assert.ok(factSource, '年度 bundle 必须保留 private fact root A');
  assert.deepEqual(factSource, {
    stateHash: factSource.stateHash,
    revision: 2,
    month: 12,
  });
  assert.notEqual(factSource.stateHash, published.stateHash, 'root A 与 authority root B 必须不同');
  assert.equal(Number(database.prepare(`
    SELECT COUNT(*) AS count FROM run_checkpoints
    WHERE run_id = ? AND state_hash = ?
  `).get('annual-running', factSource.stateHash).count), 0, 'root A 不得伪装成 checkpoint');
  assert.equal(Number(database.prepare(`
    SELECT COUNT(*) AS count FROM run_checkpoints WHERE run_id = ?
  `).get('annual-running').count), 2, '只为 authority root B 新增 checkpoint');

  const factRootChunk = readStoredChunk(factSource.stateHash);
  const factRoot = api.parseRunStateRoot(factRootChunk);
  const finalRoot = api.parseRunStateRoot(readStoredChunk(published.stateHash));
  assert.equal(factRoot.schemaVersion, 3);
  assert.equal(factRoot.lineageId, finalRoot.lineageId);
  assert.equal(factRoot.historyHeadHash, finalRoot.historyHeadHash);
  assert.equal(factRoot.eventCount, finalRoot.eventCount);
  assert.equal(factRoot.tailEventContentHash, finalRoot.tailEventContentHash);
  const reachable = { chunks: new Set(), historyNodes: new Set() };
  api.markReachableRunStateChunks(factRootChunk, readStoredChunk, reachable);
  assert.ok(reachable.chunks.has(factSource.stateHash));

  store.close();
  store = new api.SqliteRunStore(dataDirectory);
  database = store.database;
  const reopened = await store.openBoundedEvolutionContinuation('annual-running');
  assert.equal(reopened.meta.revision, 2);
  assert.equal(reopened.meta.elapsedMonths, 12);
  assert.equal(reopened.meta.status, 'running');
  assert.equal(reopened.state.clock.elapsedMonths, 12);
  assert.equal(reopened.state.civilization.stage, published.stage);
  api.assertCanonicalBoundedObserverHotShell({
    civilization: reopened.state.civilization,
    derived: reopened.state.derived,
    lastMaterializedObserverBasis: reopened.state[basisField],
  });
  assert.deepEqual(
    reopened.state.derived.structures,
    [],
    '最终权威 root B 必须恢复 canonical 空 observer structures，物理索引仍独立保留',
  );
  assert.ok(reopened.state.world.physicalStructureIndex.structures.length > 0);
  assert.deepEqual(reopened.state[basisField].source, factSource);
  assert.notDeepEqual(reopened.state.civilization.civilizationIndex, sourceIndex,
    '年度物化不得沿用上一边界的 stale civilization index');
  assert.equal(
    reopened.state.civilization.civilizationIndex.formulaVersion,
    'open-material-institution-v1-certified-current-root-lower-bound-v1',
  );
  assert.equal(reopened.state.civilization.civilizationIndex.calculatedAtMonth, 12);
  assert.ok(reopened.state.civilization.civilizationIndex.total >= 0);
  assert.equal(reopened.state[basisField].milestoneCount, sourceMilestoneCount);
  assert.equal(reopened.meta.milestoneCount, sourceMilestoneCount);
  assert.equal(reopened.continuationReady, false);

  const beforeNonAnnual = authoritySnapshot();
  await assert.rejects(
    () => store.stageBoundedObserverBoundaryMonth('annual-running'),
    /既非年度边界.*未到达 months endpoint/u,
  );
  assert.deepEqual(authoritySnapshot(), beforeNonAnnual, '非年度拒绝不得写 SQLite');

  const ordinaryMonth = await store.stageBoundedNonProjectionMonth('annual-running');
  const ordinaryPublished = await store.publishBoundedNonProjectionMonth(ordinaryMonth);
  assert.equal(ordinaryPublished.month, 13);
  const ordinaryContinuation = database.prepare(`
    SELECT bundle_hash FROM run_continuations WHERE run_id = ?
  `).get('annual-running');
  const ordinaryBundle = api.decodeRunContinuationBundle(
    readStoredChunk(String(ordinaryContinuation.bundle_hash)),
  );
  assert.deepEqual(
    ordinaryBundle.observerMaterializationSource,
    factSource,
    '后续非投影 publication 必须原样传递最近一次 private fact root A',
  );
  store.collectUnreferencedRunStateChunks();
  for (const hash of reachable.chunks) readStoredChunk(hash);
  const afterOrdinaryReopen = await store.openBoundedEvolutionContinuation('annual-running');
  assert.equal(afterOrdinaryReopen.meta.elapsedMonths, 13);
  assert.deepEqual(afterOrdinaryReopen.state[basisField].source, factSource);

  await createBootstrappedRun(
    'milestones-endpoint',
    82_603,
    { kind: 'milestones', value: 999 },
  );
  await assert.rejects(
    () => store.stageBoundedObserverBoundaryMonth('milestones-endpoint'),
    /拒绝 milestones endpoint/u,
  );

  const maxRssBytes = process.resourceUsage().maxRSS * 1_024;
  assert.ok(maxRssBytes <= MAX_FIXTURE_RSS_BYTES,
    `fixture max RSS ${maxRssBytes} 超过 288MiB`);
  console.log(JSON.stringify({
    ok: true,
    published: 'annual root A -> materialized root B + five B sidecars',
    rollback: 'post-chunk failure rolled back and same receipt retried',
    observerMaterializationSource: factSource,
    ordinaryMonthPreservedObserverSource: ordinaryPublished.month,
    gcPreservedFactRootChunks: reachable.chunks.size,
    reopenedStage: reopened.state.civilization.stage,
    preservedMilestoneCount: reopened.meta.milestoneCount,
    rejected: ['nonannual', 'milestones-endpoint'],
    maxRssBytes,
  }));
} finally {
  store?.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
