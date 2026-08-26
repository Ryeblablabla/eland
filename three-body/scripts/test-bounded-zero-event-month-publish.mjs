import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-zero-event-month-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');
const dataDirectory = path.join(temporaryDirectory, 'data');
const childEnvironment = { ...process.env, NODE_OPTIONS: '--max-old-space-size=320' };
const sidecarNames = [
  'retention',
  'physical',
  'derivedObserver',
  'civilizationObserver',
  'checkpoint',
];
let store;

function fixtureEvent(runId, atMonth) {
  return {
    id: `${runId}-source-fact`,
    kind: 'environment',
    atMonth,
    orderInMonth: 0,
    planningTick: 0,
    orderInTick: 0,
    cellId: 0,
    change: 'material',
    result: 'zero-event bounded successor source fact',
    diff: { fixtureKind: 'bounded-zero-event-month' },
  };
}

function makeQuietState(api, runId, sourceMonth, eraEndsAtMonth, seed) {
  const state = api.createInitialState(seed, {
    endpoint: { kind: 'months', value: 120 },
    chaosIntensity: 0,
  });
  state.clock.elapsedMonths = sourceMonth;
  state.civilization.epoch = 'stable';
  state.civilization.era = {
    sequence: 0,
    kind: 'stable',
    sinceMonth: 0,
    endsAtMonth: eraEndsAtMonth,
    dominantClimate: 'temperate',
  };
  state.civilization.climate = { kind: 'temperate', severity: 1, sinceMonth: 0 };
  state.civilization.weather = { kind: 'clear', intensity: 1, sinceMonth: 0 };
  delete state.civilization.externalClimate;
  state.eraPredictions = [];
  state.intents = [];
  state.agreements = [];
  state.projects = [];
  state.collectives = [];
  state.permissions = [];
  state.world.animals = [];
  state.world.drops = [];
  for (let cell = 0; cell < api.WORLD_CELL_COUNT; cell += 1) {
    const z = api.topZ(state.world.grid, cell);
    if (z >= 0) {
      api.setVoxel(
        state.world.grid,
        api.cellX(cell),
        api.cellY(cell),
        z,
        api.Material.Stone,
      );
    }
  }
  delete state.world.physicalStructureIndex;
  for (const person of state.people) {
    person.bornAtMonth = sourceMonth;
    person.generation = 1;
    person.geneticParents = [];
    person.activeIntentId = undefined;
    person.conditions = [];
    person.inventory = [];
    person.memories = [];
    person.knowledge = [];
    person.relations = [];
    person.bereavements = [];
    person.maternalTeachingSourceEventIds = [];
    person.traits = [];
    if (person.personality) person.personality.changes = [];
    if (person.cognition) {
      person.cognition.outcomeBeliefs = [];
      person.cognition.goalOutcomeBeliefs = [];
      person.cognition.needResolutionEpisodes = [];
    }
    person.body = { health: 100, hydration: 100, nutrition: 100 };
  }
  const sourceFact = fixtureEvent(runId, sourceMonth);
  state.world.past = [sourceFact];
  state.world.historyCursor = {
    version: 1,
    eventCount: 1,
    hotStartIndex: 0,
    tailEventId: sourceFact.id,
  };
  state.lastStep = [sourceFact];
  return state;
}

try {
  writeFileSync(entryPath, [
    `export { SqliteRunStore } from ${JSON.stringify(path.join(workspace, 'server/sqlite-run-store.ts'))};`,
    `export { decodeRunContinuationBundle } from ${JSON.stringify(path.join(workspace, 'server/run-continuation-bundle.ts'))};`,
    `export { parseRunStateRoot } from ${JSON.stringify(path.join(workspace, 'server/run-state-codec.ts'))};`,
    `export { stepOwnedBoundedNonProjectionMonth } from ${JSON.stringify(path.join(workspace, 'server/bounded-nonprojection-month-controller.ts'))};`,
    `export { stepOwnedBoundedObserverBoundaryMonth } from ${JSON.stringify(path.join(workspace, 'server/bounded-observer-boundary-month-controller.ts'))};`,
    `export { createInitialState } from ${JSON.stringify(path.join(workspace, 'src/game/eland/simulation.ts'))};`,
    `export { Material } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/material.ts'))};`,
    `export { WORLD_CELL_COUNT, cellX, cellY, setVoxel, topZ } from ${JSON.stringify(path.join(workspace, 'src/game/eland/world/grid.ts'))};`,
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
    assert.ok(row, `fixture missing chunk ${hash}`);
    return {
      hash: String(row.hash),
      codec: String(row.codec),
      rawSize: Number(row.raw_size),
      data: Buffer.from(row.data),
    };
  }

  function authority(runId) {
    const run = database.prepare(`
      SELECT state_hash, revision, elapsed_months, event_count
      FROM runs WHERE id = ?
    `).get(runId);
    const continuation = database.prepare(`
      SELECT state_hash, revision, shell_hash, history_lineage_id,
             history_head_hash, event_count, tail_event_id,
             tail_event_content_hash, bundle_hash
      FROM run_continuations WHERE run_id = ?
    `).get(runId);
    assert.ok(run && continuation, `fixture ${runId} missing authority`);
    const rootChunk = readStoredChunk(String(run.state_hash));
    return {
      run,
      continuation,
      rootChunk,
      root: api.parseRunStateRoot(rootChunk),
      bundle: api.decodeRunContinuationBundle(
        readStoredChunk(String(continuation.bundle_hash)),
      ),
    };
  }

  async function createQuietRun(runId, sourceMonth, eraEndsAtMonth, seedStart, boundary) {
    let state;
    let preview;
    for (let offset = 0; offset < 32; offset += 1) {
      const candidate = makeQuietState(
        api,
        runId,
        sourceMonth,
        eraEndsAtMonth,
        seedStart + offset,
      );
      const candidatePreview = boundary === 'annual'
        ? api.stepOwnedBoundedObserverBoundaryMonth(structuredClone(candidate)).state
        : api.stepOwnedBoundedNonProjectionMonth(structuredClone(candidate));
      if (candidatePreview.lastStep.length === 0) {
        state = candidate;
        preview = candidatePreview;
        break;
      }
    }
    assert.ok(state && preview, `${runId} fixture 在 32 个确定性 seed 内没有找到零事件月`);
    assert.equal(preview.clock.elapsedMonths, sourceMonth + 1);
    await store.create({ id: runId, state });
    await store.bootstrapBoundedEvolutionContinuation(runId, 64);
  }

  await createQuietRun('ordinary-zero', 8, 9, 91_001, 'ordinary');
  const ordinarySource = authority('ordinary-zero');
  const publicOpened = await store.openBoundedEvolutionContinuation('ordinary-zero');
  const callerZeroRewrite = structuredClone(publicOpened.state);
  callerZeroRewrite.clock.elapsedMonths += 1;
  callerZeroRewrite.lastStep = [];
  await assert.rejects(
    () => store.stageBoundedEvolutionSuccessor(
      publicOpened.continuationToken,
      callerZeroRewrite,
    ),
    /不接受零事件 shell 改写/u,
  );
  await assert.rejects(
    () => store.stageBoundedEvolutionSuccessorInternal(
      publicOpened.continuationToken,
      callerZeroRewrite,
      undefined,
      Object.freeze({}),
    ),
    /不接受零事件 shell 改写/u,
  );

  const staleReceipt = await store.stageBoundedNonProjectionMonth('ordinary-zero');
  assert.equal(store.ownsBoundedNonProjectionMonthStagingReceipt(staleReceipt), true);
  await store.openBoundedEvolutionContinuation('ordinary-zero');
  assert.equal(store.ownsBoundedNonProjectionMonthStagingReceipt(staleReceipt), false);
  await assert.rejects(
    () => store.publishBoundedNonProjectionMonth(staleReceipt),
    /不是当前 store 铸造/u,
  );

  const ordinaryStage = await store.stageBoundedNonProjectionMonth('ordinary-zero');
  const ordinaryPublished = await store.publishBoundedNonProjectionMonth(ordinaryStage);
  const ordinaryZero = authority('ordinary-zero');
  assert.equal(ordinaryPublished.month, 9);
  assert.equal(Number(ordinaryZero.run.revision), Number(ordinarySource.run.revision) + 1);
  assert.equal(Number(ordinaryZero.run.event_count), Number(ordinarySource.run.event_count));
  assert.notEqual(ordinaryZero.rootChunk.hash, ordinarySource.rootChunk.hash);
  assert.equal(ordinaryZero.root.lineageId, ordinarySource.root.lineageId);
  assert.equal(ordinaryZero.root.historyHeadHash, ordinarySource.root.historyHeadHash);
  assert.equal(ordinaryZero.root.eventCount, ordinarySource.root.eventCount);
  assert.equal(
    ordinaryZero.root.tailEventContentHash,
    ordinarySource.root.tailEventContentHash,
  );
  for (const name of sidecarNames) {
    assert.notEqual(
      ordinaryZero.bundle.sidecars[name].hash,
      ordinarySource.bundle.sidecars[name].hash,
      `ordinary zero-event ${name} sidecar 必须重绑新 root/shell`,
    );
  }
  const reopenedOrdinaryZero = await store.openBoundedEvolutionContinuation('ordinary-zero');
  assert.equal(reopenedOrdinaryZero.meta.elapsedMonths, 9);
  assert.equal(reopenedOrdinaryZero.meta.eventCount, Number(ordinarySource.run.event_count));

  await assert.rejects(
    () => store.stageBoundedEvolutionSuccessor(
      publicOpened.continuationToken,
      callerZeroRewrite,
    ),
    /失效|已消费/u,
  );

  const ordinaryAppendStage = await store.stageBoundedNonProjectionMonth('ordinary-zero');
  const ordinaryAppendPublished = await store.publishBoundedNonProjectionMonth(
    ordinaryAppendStage,
  );
  const ordinaryAppended = authority('ordinary-zero');
  assert.equal(ordinaryAppendPublished.month, 10);
  assert.ok(
    Number(ordinaryAppended.run.event_count) > Number(ordinaryZero.run.event_count),
    '零事件 ordinary shell successor 后的下一有事件月必须继续 append',
  );
  const reopenedOrdinaryAppend = await store.openBoundedEvolutionContinuation('ordinary-zero');
  assert.equal(reopenedOrdinaryAppend.meta.elapsedMonths, 10);

  await createQuietRun('annual-zero', 11, 12, 91_002, 'annual');
  const annualSource = authority('annual-zero');
  const annualStage = await store.stageBoundedObserverBoundaryMonth('annual-zero');
  const annualPublished = await store.publishBoundedObserverBoundaryMonth(annualStage);
  const annualZero = authority('annual-zero');
  assert.equal(annualPublished.month, 12);
  assert.equal(Number(annualZero.run.revision), Number(annualSource.run.revision) + 1);
  assert.equal(Number(annualZero.run.event_count), Number(annualSource.run.event_count));
  assert.notEqual(annualZero.rootChunk.hash, annualSource.rootChunk.hash);
  assert.equal(annualZero.root.lineageId, annualSource.root.lineageId);
  assert.equal(annualZero.root.historyHeadHash, annualSource.root.historyHeadHash);
  assert.equal(annualZero.root.eventCount, annualSource.root.eventCount);
  assert.equal(annualZero.root.tailEventContentHash, annualSource.root.tailEventContentHash);
  const factSource = annualZero.bundle.observerMaterializationSource;
  assert.ok(factSource, 'annual zero-event bundle 必须保留 private fact root A');
  assert.notEqual(factSource.stateHash, annualZero.rootChunk.hash);
  const factRoot = api.parseRunStateRoot(readStoredChunk(factSource.stateHash));
  assert.equal(factRoot.lineageId, annualSource.root.lineageId);
  assert.equal(factRoot.historyHeadHash, annualSource.root.historyHeadHash);
  assert.equal(factRoot.eventCount, annualSource.root.eventCount);
  assert.equal(factRoot.tailEventContentHash, annualSource.root.tailEventContentHash);
  for (const name of sidecarNames) {
    assert.notEqual(
      annualZero.bundle.sidecars[name].hash,
      annualSource.bundle.sidecars[name].hash,
      `annual zero-event ${name} sidecar 必须重绑 final root B`,
    );
  }
  const reopenedAnnualZero = await store.openBoundedEvolutionContinuation('annual-zero');
  assert.equal(reopenedAnnualZero.meta.elapsedMonths, 12);
  assert.equal(reopenedAnnualZero.meta.eventCount, Number(annualSource.run.event_count));

  const annualAppendStage = await store.stageBoundedNonProjectionMonth('annual-zero');
  const annualAppendPublished = await store.publishBoundedNonProjectionMonth(annualAppendStage);
  const annualAppended = authority('annual-zero');
  assert.equal(annualAppendPublished.month, 13);
  assert.ok(
    Number(annualAppended.run.event_count) > Number(annualZero.run.event_count),
    '零事件 annual A/B successor 后的下一有事件月必须继续 append',
  );
  const reopenedAnnualAppend = await store.openBoundedEvolutionContinuation('annual-zero');
  assert.equal(reopenedAnnualAppend.meta.elapsedMonths, 13);

  const maxRssBytes = process.resourceUsage().maxRSS * 1_024;
  assert.ok(maxRssBytes <= 320 * 1_024 * 1_024,
    `fixture max RSS ${maxRssBytes} 超过 320MiB`);
  console.log(JSON.stringify({
    ok: true,
    ordinary: {
      zeroMonth: ordinaryPublished.month,
      unchangedEventCount: Number(ordinaryZero.run.event_count),
      appendedMonth: ordinaryAppendPublished.month,
      appendedEventCount: Number(ordinaryAppended.run.event_count),
    },
    annual: {
      zeroMonth: annualPublished.month,
      factRoot: factSource.stateHash,
      finalRoot: annualPublished.stateHash,
      unchangedEventCount: Number(annualZero.run.event_count),
      appendedMonth: annualAppendPublished.month,
      appendedEventCount: Number(annualAppended.run.event_count),
    },
    rejected: [
      'public zero-event shell rewrite',
      'forged private controller capability',
      'stale controller receipt',
      'stale token',
    ],
    reboundSidecars: sidecarNames,
    maxRssBytes,
  }));
} finally {
  store?.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
