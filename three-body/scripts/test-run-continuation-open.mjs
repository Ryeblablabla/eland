import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deserialize } from 'node:v8';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-run-continuation-open-'));
const storeBundlePath = path.join(temporaryDirectory, 'sqlite-run-store.mjs');
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const continuationBundlePath = path.join(temporaryDirectory, 'run-continuation-bundle.mjs');
const sidecarEntryPath = path.join(temporaryDirectory, 'sidecar-entry.ts');
const sidecarBundlePath = path.join(temporaryDirectory, 'sidecar-entry.mjs');
const dataDirectory = path.join(temporaryDirectory, 'data');
const childEnvironment = { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' };

function appendSyntheticEvents(state, count, plankMaterialId) {
  const cursor = state.world.historyCursor;
  assert.ok(cursor, 'fixture state 必须携带 history cursor');
  const firstAbsoluteIndex = cursor.eventCount;
  const events = Array.from({ length: count }, (_, orderInMonth) => {
    const absoluteIndex = firstAbsoluteIndex + orderInMonth;
    if (orderInMonth === 2) {
      const builder = state.people[0];
      return {
        id: `continuation-event-${absoluteIndex}`,
        atMonth: state.clock.elapsedMonths + 1,
        orderInMonth,
        planningTick: 1,
        orderInTick: 0,
        kind: 'action',
        actionTick: 1,
        who: builder.id,
        cause: 'intent',
        action: { kind: 'act', operation: 'combine', targets: [] },
        fromCellId: builder.position.cellId,
        toCellId: builder.position.cellId,
        fromZ: builder.position.z,
        toZ: builder.position.z,
        pathSegment: [],
        status: 'completed',
        result: 'fixture construction provenance without a matching current voxel',
        diff: {
          fixtureKind: 'continuation-open-construction',
          outputMaterialId: plankMaterialId,
          position: { x: 0, y: 0, z: state.world.grid.levels - 1 },
        },
      };
    }
    return {
      id: `continuation-event-${absoluteIndex}`,
      atMonth: state.clock.elapsedMonths + 1,
      orderInMonth,
      planningTick: 0,
      orderInTick: orderInMonth,
      cellId: absoluteIndex,
      kind: 'environment',
      change: 'material',
      result: 'trusted continuation fixture fact',
      diff: { fixtureKind: 'continuation-open', absoluteIndex },
    };
  });
  state.world.past.push(...events);
  cursor.eventCount += events.length;
  cursor.tailEventId = events.at(-1).id;
  return events;
}

try {
  writeFileSync(sidecarEntryPath, [
    `export { beginHistoryRetentionProjection, foldHistoryRetentionSegment, finishHistoryRetentionProjection } from ${JSON.stringify(path.resolve('server/history-retention-projection.ts'))};`,
    `export { encodeHistoryRetentionSidecar } from ${JSON.stringify(path.resolve('server/history-retention-codec.ts'))};`,
    `export { decodeBoundedRunStateWithPhysicalProjection } from ${JSON.stringify(path.resolve('server/physical-structure-ledger-projection.ts'))};`,
    `export { encodePhysicalStructureLedgerSidecar } from ${JSON.stringify(path.resolve('server/physical-structure-ledger-codec.ts'))};`,
    `export { projectObserverDerivedHistoryFromFullHistory } from ${JSON.stringify(path.resolve('server/observer-derived-history-projection.ts'))};`,
    `export { encodeObserverDerivedHistorySidecar } from ${JSON.stringify(path.resolve('server/observer-derived-history-codec.ts'))};`,
    `export { projectObserverCivilizationHistoryFromFullHistory } from ${JSON.stringify(path.resolve('server/observer-civilization-history-projection.ts'))};`,
    `export { encodeObserverCivilizationHistorySidecar } from ${JSON.stringify(path.resolve('server/civilization-history-codec.ts'))};`,
    `export { CHECKPOINT_ACCUMULATOR_CODEC, encodeCheckpointAccumulator, hashCheckpointAccumulatorStoredContent, projectCheckpointAccumulatorFromVerifiedRunRoot } from ${JSON.stringify(path.resolve('server/checkpoint-accumulator.ts'))};`,
    `export { Material, materialDefinition } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};`,
  ].join('\n'));
  for (const [entry, outfile] of [
    ['server/sqlite-run-store.ts', storeBundlePath],
    ['src/game/eland/simulation.ts', simulationBundlePath],
    ['server/run-continuation-bundle.ts', continuationBundlePath],
    [sidecarEntryPath, sidecarBundlePath],
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
    RunWriteConflictError,
    SqliteRunStore,
  } = await import(`${pathToFileURL(storeBundlePath).href}?v=${Date.now()}`);
  const { createInitialState } = await import(
    `${pathToFileURL(simulationBundlePath).href}?v=${Date.now()}`
  );
  const {
    encodeRunContinuationBundle,
  } = await import(`${pathToFileURL(continuationBundlePath).href}?v=${Date.now()}`);
  const sidecarApi = await import(`${pathToFileURL(sidecarBundlePath).href}?v=${Date.now()}`);

  const state = createInitialState(4301, { endpoint: { kind: 'months', value: 12_000 } });
  const events = appendSyntheticEvents(state, 8, sidecarApi.Material.Plank);
  state.eraPredictions.push({
    id: 'fixture-pending-era-prediction',
    predictorId: state.people[0].id,
    audienceIds: state.people.slice(1).map((person) => person.id),
    madeAtMonth: 0,
    targetEpoch: 'chaotic',
    predictedStartMonth: 4,
    toleranceMonths: 2,
    expiresAtMonth: 6,
    status: 'pending',
    sourceEventIds: [events[1].id, events[4].id],
  });
  const store = new SqliteRunStore(dataDirectory);
  const created = await store.create({ id: 'trusted-continuation', state });
  const database = store.database;
  const run = database.prepare(`
    SELECT id, state_hash, revision, event_count, updated_at
    FROM runs WHERE id = ?
  `).get(created.meta.id);
  const rootChunk = database.prepare(`
    SELECT hash, codec, raw_size, data FROM chunks WHERE hash = ?
  `).get(run.state_hash);
  const root = deserialize(rootChunk.data);
  const syntheticStartIndex = root.eventCount - events.length;
  const hotStartIndex = root.eventCount - 3;

  function readStoredChunk(hash) {
    const row = database.prepare(`
      SELECT hash, codec, raw_size, data FROM chunks WHERE hash = ?
    `).get(hash);
    if (!row) throw new Error(`missing fixture chunk ${hash}`);
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

  function insertSidecar(name, encoded) {
    const data = Buffer.from(encoded.chunk.data);
    insertChunk({ ...encoded.chunk, data });
    return {
      name,
      codec: encoded.chunk.codec,
      hash: encoded.chunk.hash,
      data,
      reference: encoded.reference,
    };
  }

  const authority = {
    runId: created.meta.id,
    revision: Number(run.revision),
    stateHash: String(run.state_hash),
    rootSchemaVersion: root.schemaVersion,
    shellHash: root.shellHash,
    historyLineageId: root.lineageId,
    historyHeadHash: root.historyHeadHash,
    eventCount: root.eventCount,
    tailEventId: events.at(-1).id,
    tailEventContentHash: root.tailEventContentHash,
  };
  const target = {
    stateHash: authority.stateHash,
    eventCount: authority.eventCount,
    tailEventId: authority.tailEventId,
  };
  const rootStateChunk = readStoredChunk(authority.stateHash);

  const retentionFold = sidecarApi.beginHistoryRetentionProjection(
    created.state,
    { stateHash: authority.stateHash },
  );
  sidecarApi.foldHistoryRetentionSegment(retentionFold, created.state.world.past, 0);
  const retentionProjection = sidecarApi.finishHistoryRetentionProjection(retentionFold);
  const encodedRetention = sidecarApi.encodeHistoryRetentionSidecar(retentionProjection);

  const physicalDecoded = await sidecarApi.decodeBoundedRunStateWithPhysicalProjection(
    rootStateChunk,
    readStoredChunk,
    { hotEventLimit: 3 },
  );
  const physicalProjection = physicalDecoded.physicalProjection;
  const encodedPhysical = sidecarApi.encodePhysicalStructureLedgerSidecar(physicalProjection);

  const emptyDerivedDemand = {
    settledCultivationProjects: [],
    residentialStructures: [],
    retainedEventIds: [],
    futureEventIds: [],
  };
  const derivedProjection = sidecarApi.projectObserverDerivedHistoryFromFullHistory(
    created.state.world.past,
    target,
    emptyDerivedDemand,
  );
  const encodedDerivedObserver = sidecarApi.encodeObserverDerivedHistorySidecar({
    sourceDemand: emptyDerivedDemand,
    projection: derivedProjection,
  });
  const civilizationProjection = sidecarApi.projectObserverCivilizationHistoryFromFullHistory(
    created.state.world.past,
    target,
  );
  const encodedCivilizationObserver = sidecarApi.encodeObserverCivilizationHistorySidecar(
    civilizationProjection,
  );
  const checkpointBoundary = {
    ...authority,
    month: created.meta.elapsedMonths,
  };
  const checkpointAccumulator = await sidecarApi.projectCheckpointAccumulatorFromVerifiedRunRoot(
    created.state,
    rootStateChunk,
    readStoredChunk,
    checkpointBoundary,
  );
  const encodedCheckpoint = sidecarApi.encodeCheckpointAccumulator(checkpointAccumulator);

  const sidecarList = [
    insertSidecar('retention', encodedRetention),
    insertSidecar('physical', encodedPhysical),
    insertSidecar('derived-observer', encodedDerivedObserver),
    insertSidecar('civilization-observer', encodedCivilizationObserver),
    insertSidecar('checkpoint', encodedCheckpoint),
  ];
  const sidecars = {
    retention: sidecarList[0].reference,
    physical: sidecarList[1].reference,
    derivedObserver: sidecarList[2].reference,
    civilizationObserver: sidecarList[3].reference,
    checkpoint: sidecarList[4].reference,
  };
  const coldPins = retentionProjection.pins
    .filter((pin) => pin.absoluteIndex < hotStartIndex)
    .map((pin) => ({
      absoluteIndex: pin.absoluteIndex,
      eventId: pin.eventId,
      leaseKeys: [...pin.leaseKeys],
    }));
  assert.deepEqual(
    coldPins.filter((pin) => pin.eventId === events[1].id || pin.eventId === events[4].id)
      .map((pin) => pin.absoluteIndex),
    [syntheticStartIndex + 1, syntheticStartIndex + 4],
    'fixture 的 pending prediction 两项 retention demand 必须形成 cold pins',
  );
  const baseBundleInput = {
    schemaVersion: 1,
    historyMode: 'bounded-hot-tail-plus-cold-pins-v1',
    authority,
    hotEventLimit: 3,
    hotStartIndex,
    coldPins,
    sidecars,
  };
  const encodedBundle = encodeRunContinuationBundle(baseBundleInput);
  insertChunk(encodedBundle.chunk);
  const originalUpdatedAt = '2026-08-25T12:00:00.000Z';
  database.prepare(`
    INSERT INTO run_continuations(
      run_id, revision, state_hash, root_schema_version, shell_hash,
      history_lineage_id, history_head_hash, event_count, tail_event_id,
      tail_event_content_hash, hot_event_limit, bundle_schema_version,
      bundle_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    created.meta.id,
    run.revision,
    run.state_hash,
    root.schemaVersion,
    root.shellHash,
    root.lineageId,
    root.historyHeadHash,
    root.eventCount,
    events.at(-1).id,
    root.tailEventContentHash,
    3,
    encodedBundle.chunk.hash,
    originalUpdatedAt,
  );

  const opened = await store.openBoundedEvolutionContinuation(created.meta.id);
  assert.equal(opened.continuationReady, false);
  assert.equal(opened.state.world.past.length, 3);
  assert.equal(opened.state.world.historyCursor.hotStartIndex, hotStartIndex);
  assert.deepEqual(
    opened.pinnedEvents.map((pin) => pin.absoluteIndex),
    coldPins.map((pin) => pin.absoluteIndex),
  );
  assert.deepEqual(
    opened.pinnedEvents.map((pin) => pin.event.id),
    coldPins.map((pin) => pin.eventId),
  );
  assert.equal(opened.state.world.physicalStructureIndex.constructionRecords.length, 1);
  assert.equal(opened.state.world.physicalStructureIndex.structures.length, 0,
    '当前 voxel 不匹配的建造来源不得物化为结构');
  assert.ok(Object.isFrozen(opened.continuationToken));
  assert.deepEqual(Reflect.ownKeys(opened.continuationToken), ['kind', 'continuationReady'],
    'token 不得暴露 sidecar bytes、投影或 checkpoint accumulator');
  assert.equal('artifacts' in opened, false);
  assert.equal('sidecars' in opened, false);
  assert.equal(store.ownsBoundedEvolutionContinuationToken(opened.continuationToken), true);
  assert.equal(store.ownsBoundedEvolutionContinuationToken({
    kind: 'bounded-evolution-continuation-token-v1',
    continuationReady: false,
  }), false, '匹配公共形状的对象不得伪造 store token');

  const otherStore = new SqliteRunStore(dataDirectory, { readOnly: true });
  const foreignOpened = await otherStore.openBoundedEvolutionContinuation(created.meta.id);
  assert.equal(otherStore.ownsBoundedEvolutionContinuationToken(opened.continuationToken), false);
  assert.equal(store.ownsBoundedEvolutionContinuationToken(foreignOpened.continuationToken), false);
  assert.equal(otherStore.ownsBoundedEvolutionContinuationToken(foreignOpened.continuationToken), true);
  otherStore.close();
  assert.equal(otherStore.ownsBoundedEvolutionContinuationToken(foreignOpened.continuationToken), false);

  const reopened = await store.openBoundedEvolutionContinuation(created.meta.id);
  assert.equal(store.ownsBoundedEvolutionContinuationToken(opened.continuationToken), false,
    '同 run 的新 generation 必须使旧 token 失效');
  assert.equal(store.ownsBoundedEvolutionContinuationToken(reopened.continuationToken), true);

  const persistedShape = () => ({
    run: database.prepare(`SELECT state_hash, revision, event_count FROM runs WHERE id = ?`)
      .get(created.meta.id),
    continuation: database.prepare(`
      SELECT revision, state_hash, bundle_hash, updated_at
      FROM run_continuations WHERE run_id = ?
    `).get(created.meta.id),
    checkpoints: Number(database.prepare(`
      SELECT COUNT(*) AS count FROM run_checkpoints WHERE run_id = ?
    `).get(created.meta.id).count),
    chunks: Number(database.prepare(`SELECT COUNT(*) AS count FROM chunks`).get().count),
  });
  const beforeStaging = persistedShape();
  const successorState = structuredClone(reopened.state);
  const successorEvents = appendSyntheticEvents(
    successorState,
    2,
    sidecarApi.Material.Plank,
  );
  successorState.clock.elapsedMonths += 1;
  successorState.lastStep = successorEvents;
  const staged = await store.stageBoundedEvolutionSuccessor(
    reopened.continuationToken,
    successorState,
  );
  assert.ok(Object.isFrozen(staged));
  assert.equal(staged.persisted, false);
  assert.equal(staged.continuationReady, false);
  assert.equal(store.ownsBoundedEvolutionSuccessorStagingReceipt(staged), true);
  assert.equal(store.ownsBoundedEvolutionContinuationToken(reopened.continuationToken), true,
    'staging 成功不得消费 source token');
  assert.deepEqual(persistedShape(), beforeStaging,
    'staging 不得写 chunk、run、checkpoint 或 continuation');
  assert.equal(store.ownsBoundedEvolutionSuccessorStagingReceipt({
    kind: 'bounded-evolution-successor-staging-receipt-v1',
    persisted: false,
    continuationReady: false,
  }), false, '匹配公共形状的 staging receipt 不得伪造');
  await assert.rejects(
    store.stageBoundedEvolutionSuccessor(opened.continuationToken, successorState),
    (error) => error instanceof RunWriteConflictError,
    '旧 token generation 不得进入 successor staging',
  );

  queueMicrotask(() => {
    database.prepare(`UPDATE run_continuations SET updated_at = ? WHERE run_id = ?`)
      .run('2026-08-25T12:00:00.500Z', created.meta.id);
  });
  await assert.rejects(
    store.stageBoundedEvolutionSuccessor(reopened.continuationToken, successorState),
    (error) => error instanceof RunWriteConflictError,
    'staging await 期间 token snapshot 变化必须失败',
  );
  database.prepare(`UPDATE run_continuations SET updated_at = ? WHERE run_id = ?`)
    .run(originalUpdatedAt, created.meta.id);
  assert.equal(store.ownsBoundedEvolutionContinuationToken(reopened.continuationToken), true,
    'staging 失败不得消费 source token');
  assert.equal(store.ownsBoundedEvolutionSuccessorStagingReceipt(staged), true,
    '失败的另一个 staging 不得撤销既有 receipt');

  const originalBundleBytes = Buffer.from(encodedBundle.chunk.data);
  const tamperedBundleBytes = Buffer.from(originalBundleBytes);
  tamperedBundleBytes[0] ^= 0xff;
  database.prepare(`UPDATE chunks SET data = ? WHERE hash = ?`)
    .run(tamperedBundleBytes, encodedBundle.chunk.hash);
  await assert.rejects(
    store.openBoundedEvolutionContinuation(created.meta.id),
    /SHA-256 校验失败/u,
    'bundle bytes 篡改必须在解码前失败',
  );
  database.prepare(`UPDATE chunks SET data = ? WHERE hash = ?`)
    .run(originalBundleBytes, encodedBundle.chunk.hash);

  const missing = sidecarList[0];
  database.prepare(`DELETE FROM chunks WHERE hash = ?`).run(missing.hash);
  await assert.rejects(
    store.openBoundedEvolutionContinuation(created.meta.id),
    /不存在/u,
    '缺失 sidecar 不得铸造 token',
  );
  database.prepare(`INSERT INTO chunks(hash, codec, raw_size, data) VALUES (?, ?, ?, ?)`)
    .run(missing.hash, missing.codec, missing.data.byteLength, missing.data);

  const changedSidecar = sidecarList[1];
  const changedSidecarBytes = Buffer.from(changedSidecar.data);
  changedSidecarBytes[0] ^= 0xff;
  database.prepare(`UPDATE chunks SET data = ? WHERE hash = ?`)
    .run(changedSidecarBytes, changedSidecar.hash);
  await assert.rejects(
    store.openBoundedEvolutionContinuation(created.meta.id),
    /SHA-256 校验失败|内容哈希校验失败/u,
    'sidecar 内容必须重新计算 codec-domain hash',
  );
  database.prepare(`UPDATE chunks SET data = ? WHERE hash = ?`)
    .run(changedSidecar.data, changedSidecar.hash);

  function selectBundle(input) {
    const encoded = encodeRunContinuationBundle(input);
    insertChunk(encoded.chunk);
    database.prepare(`UPDATE run_continuations SET bundle_hash = ? WHERE run_id = ?`)
      .run(encoded.chunk.hash, created.meta.id);
    return encoded;
  }

  function restoreBaseBundle() {
    database.prepare(`UPDATE run_continuations SET bundle_hash = ? WHERE run_id = ?`)
      .run(encodedBundle.chunk.hash, created.meta.id);
  }

  selectBundle({
    ...baseBundleInput,
    sidecars: {
      ...sidecars,
      checkpoint: {
        ...sidecars.checkpoint,
        codec: 'eland-forged-checkpoint-codec-v1',
      },
    },
  });
  await assert.rejects(
    store.openBoundedEvolutionContinuation(created.meta.id),
    /expected reference codec|codec 无效/u,
    'bundle 中错误的 typed sidecar codec 必须被相应 decoder 拒绝',
  );
  restoreBaseBundle();

  const forgedColdPins = coldPins.map((pin, index) => ({
    ...pin,
    leaseKeys: index === 0 ? [...pin.leaseKeys, 'forged:lease-key'].sort() : [...pin.leaseKeys],
  }));
  selectBundle({ ...baseBundleInput, coldPins: forgedColdPins });
  await assert.rejects(
    store.openBoundedEvolutionContinuation(created.meta.id),
    /retention pin .*coldPins\/leaseKeys/u,
    'bundle cold pin 的 leaseKeys 必须与 retention projection 完全一致',
  );
  restoreBaseBundle();

  const alteredDemandShell = structuredClone(created.state);
  alteredDemandShell.eraPredictions.push({
    ...alteredDemandShell.eraPredictions[0],
    id: 'fixture-second-pending-era-prediction',
    sourceEventIds: [events[0].id],
  });
  const alteredDemandFold = sidecarApi.beginHistoryRetentionProjection(
    alteredDemandShell,
    { stateHash: authority.stateHash },
  );
  sidecarApi.foldHistoryRetentionSegment(
    alteredDemandFold,
    alteredDemandShell.world.past,
    0,
  );
  const alteredRetention = sidecarApi.encodeHistoryRetentionSidecar(
    sidecarApi.finishHistoryRetentionProjection(alteredDemandFold),
  );
  insertChunk(alteredRetention.chunk);
  selectBundle({
    ...baseBundleInput,
    sidecars: { ...sidecars, retention: alteredRetention.reference },
  });
  await assert.rejects(
    store.openBoundedEvolutionContinuation(created.meta.id),
    /retention projection demand .*bounded state/u,
    'shape-valid retention sidecar 的 demand fingerprint 仍须匹配 decoded shell',
  );
  restoreBaseBundle();

  const wrongObserverTarget = { ...target, stateHash: 'f'.repeat(64) };
  const wrongDerivedProjection = sidecarApi.projectObserverDerivedHistoryFromFullHistory(
    created.state.world.past,
    wrongObserverTarget,
    emptyDerivedDemand,
  );
  const wrongDerivedSidecar = sidecarApi.encodeObserverDerivedHistorySidecar({
    sourceDemand: emptyDerivedDemand,
    projection: wrongDerivedProjection,
  });
  insertChunk(wrongDerivedSidecar.chunk);
  selectBundle({
    ...baseBundleInput,
    sidecars: { ...sidecars, derivedObserver: wrongDerivedSidecar.reference },
  });
  await assert.rejects(
    store.openBoundedEvolutionContinuation(created.meta.id),
    /store-selected exact target/u,
    'observer sidecar 必须绑定 exact stateHash/eventCount/tailEventId',
  );
  restoreBaseBundle();

  const wrongPhysicalProjection = structuredClone(physicalProjection);
  wrongPhysicalProjection.index.calculatedAtMonth += 1;
  const wrongPhysicalSidecar = sidecarApi.encodePhysicalStructureLedgerSidecar(
    wrongPhysicalProjection,
  );
  insertChunk(wrongPhysicalSidecar.chunk);
  selectBundle({
    ...baseBundleInput,
    sidecars: { ...sidecars, physical: wrongPhysicalSidecar.reference },
  });
  await assert.rejects(
    store.openBoundedEvolutionContinuation(created.meta.id),
    /physical ledger .*与.*(?:shell|全量投影)/u,
    'physical sidecar 的同月 shell 封印必须精确匹配',
  );
  restoreBaseBundle();

  const checkpointJson = JSON.parse(sidecarList[4].data.toString('utf8'));
  checkpointJson.boundary.month += 1;
  const wrongCheckpointBytes = Buffer.from(JSON.stringify(checkpointJson), 'utf8');
  const wrongCheckpointHash = sidecarApi.hashCheckpointAccumulatorStoredContent(
    sidecarApi.CHECKPOINT_ACCUMULATOR_CODEC,
    wrongCheckpointBytes,
  );
  const wrongCheckpointChunk = {
    hash: wrongCheckpointHash,
    codec: sidecarApi.CHECKPOINT_ACCUMULATOR_CODEC,
    rawSize: wrongCheckpointBytes.byteLength,
    data: wrongCheckpointBytes,
  };
  insertChunk(wrongCheckpointChunk);
  selectBundle({
    ...baseBundleInput,
    sidecars: {
      ...sidecars,
      checkpoint: {
        kind: 'content-hash',
        codec: wrongCheckpointChunk.codec,
        hash: wrongCheckpointChunk.hash,
      },
    },
  });
  await assert.rejects(
    store.openBoundedEvolutionContinuation(created.meta.id),
    /expected boundary 不一致/u,
    'checkpoint accumulator 必须绑定 exact run/revision/month/root authority',
  );
  restoreBaseBundle();

  const physicalRecord = physicalProjection.index.constructionRecords[0];
  assert.ok(physicalRecord, 'fixture 必须含一条 verified construction provenance');
  assert.equal(physicalProjection.index.structures.length, 0);
  const bogusPhysicalProjection = structuredClone(physicalProjection);
  const materialName = sidecarApi.materialDefinition(physicalRecord.materialId).name;
  bogusPhysicalProjection.index.structures.push({
    id: `structure-${physicalRecord.x}:${physicalRecord.y}:${physicalRecord.z}`,
    name: `未完成${materialName}结构`,
    occupiedCells: [physicalRecord.x + physicalRecord.y * created.state.world.grid.width],
    interiorCells: [],
    interiorPositions: [],
    materialIds: [physicalRecord.materialId],
    weatherProtection: 0,
    thermalInsulation: 0,
    capacity: 0,
    complete: false,
    sourceEventIds: [physicalRecord.sourceEventId],
  });
  const bogusPhysicalSidecar = sidecarApi.encodePhysicalStructureLedgerSidecar(
    bogusPhysicalProjection,
  );
  insertChunk(bogusPhysicalSidecar.chunk);
  selectBundle({
    ...baseBundleInput,
    sidecars: { ...sidecars, physical: bogusPhysicalSidecar.reference },
  });
  await assert.rejects(
    store.openBoundedEvolutionContinuation(created.meta.id),
    /physical ledger .*与.*全量投影/u,
    'codec-valid 但与当前 voxel 不符的 persisted structures 必须 fail-closed',
  );
  assert.equal(bogusPhysicalSidecar.projection.index.structures.length, 1);
  restoreBaseBundle();

  database.prepare(`UPDATE run_continuations SET tail_event_id = ? WHERE run_id = ?`)
    .run('forged-tail', created.meta.id);
  await assert.rejects(
    store.openBoundedEvolutionContinuation(created.meta.id),
    /bundle 与 authority 行不一致/u,
    'continuation table authority 不得偏离 bundle/root',
  );
  database.prepare(`UPDATE run_continuations SET tail_event_id = ? WHERE run_id = ?`)
    .run(events.at(-1).id, created.meta.id);

  database.prepare(`UPDATE run_checkpoints SET month = month + 1 WHERE run_id = ? AND revision = ?`)
    .run(created.meta.id, run.revision);
  await assert.rejects(
    store.openBoundedEvolutionContinuation(created.meta.id),
    /exact checkpoint/u,
    'checkpoint month 必须与当前 run authority 一致',
  );
  database.prepare(`UPDATE run_checkpoints SET month = ? WHERE run_id = ? AND revision = ?`)
    .run(created.meta.elapsedMonths, created.meta.id, run.revision);

  database.prepare(`UPDATE runs SET agent_count = agent_count + 1 WHERE id = ?`)
    .run(created.meta.id);
  await assert.rejects(
    store.openBoundedEvolutionContinuation(created.meta.id),
    /decoded shell/u,
    'run summary 不得与解码后的权威 shell 偏离',
  );
  database.prepare(`UPDATE runs SET agent_count = ? WHERE id = ?`)
    .run(created.meta.agentCount, created.meta.id);

  queueMicrotask(() => {
    database.prepare(`UPDATE run_continuations SET updated_at = ? WHERE run_id = ?`)
      .run('2026-08-25T12:00:01.000Z', created.meta.id);
  });
  await assert.rejects(
    store.openBoundedEvolutionContinuation(created.meta.id),
    (error) => error instanceof RunWriteConflictError,
    'await 期间 authority 行变化必须由二次读取捕获',
  );
  database.prepare(`UPDATE run_continuations SET updated_at = ? WHERE run_id = ?`)
    .run(originalUpdatedAt, created.meta.id);

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1_024 * 1_024, `fixture RSS ${rssBytes} 超过 256 MiB`);
  store.close();
  assert.equal(store.ownsBoundedEvolutionContinuationToken(reopened.continuationToken), false);
  console.log(JSON.stringify({
    result: 'passed',
    eventCount: root.eventCount,
    hotEventCount: opened.state.world.past.length,
    coldPinCount: opened.pinnedEvents.length,
    rssBytes,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
