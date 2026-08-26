import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(
  path.join(tmpdir(), 'eland-observer-derived-successor-'),
);
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'entry.mjs');

function baseEvent(id, atMonth, orderInMonth = 0, cellId = 0) {
  return {
    id, atMonth, orderInMonth, planningTick: 1, orderInTick: orderInMonth, cellId,
  };
}

function environment(id, atMonth) {
  return {
    ...baseEvent(id, atMonth), kind: 'environment', change: 'condition', result: id, diff: {},
  };
}

function action(id, atMonth, primitive, diff, orderInMonth = 0, cellId = 0) {
  return {
    ...baseEvent(id, atMonth, orderInMonth, cellId),
    kind: 'action', actionTick: 1, who: 'farmer', cause: 'intent', action: primitive,
    fromCellId: cellId, toCellId: cellId, fromZ: 1, toZ: 1, pathSegment: [cellId],
    status: 'completed', result: id, diff,
  };
}

function construction(id, atMonth, materialId, position, orderInMonth) {
  return action(
    id,
    atMonth,
    { kind: 'act', operation: 'combine', targets: [] },
    { outputMaterialId: materialId, position },
    orderInMonth,
  );
}

function planting(id, atMonth, materialId, position, orderInMonth, cellId) {
  return action(
    id,
    atMonth,
    { kind: 'act', operation: 'combine', targets: [] },
    { outputMaterialId: materialId, position },
    orderInMonth,
    cellId,
  );
}

function harvest(id, atMonth, materialId, position, orderInMonth, cellId) {
  return action(
    id,
    atMonth,
    { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position }] },
    { sourceMaterialId: materialId },
    orderInMonth,
    cellId,
  );
}

function blankGrid(api) {
  const voxels = new Uint16Array(api.WORLD_VOXEL_COUNT);
  for (let y = 0; y < api.WORLD_DEPTH; y += 1) {
    for (let x = 0; x < api.WORLD_WIDTH; x += 1) {
      voxels[x + y * api.WORLD_WIDTH] = api.Material.PackedSoil;
    }
  }
  return {
    version: 2,
    width: api.WORLD_WIDTH,
    depth: api.WORLD_DEPTH,
    levels: api.WORLD_LEVELS,
    generator: { version: 'material-world-v4-regional-geology', seed: 83 },
    palette: api.MATERIAL_PALETTE,
    voxels,
  };
}

function applyConstruction(api, grid, event) {
  if (event.kind !== 'action'
    || event.status !== 'completed'
    || event.action.kind !== 'act'
    || event.action.operation !== 'combine'
    || !event.diff.position
    || event.diff.outputMaterialId !== api.Material.Plank) return;
  const { x, y, z } = event.diff.position;
  api.setVoxel(grid, x, y, z, event.diff.outputMaterialId);
}

function cultivationProject(siteCellId, actionEventIds, completed) {
  return {
    id: 'cultivation-project', kind: 'production', need: 'production-efficiency',
    desiredFunction: 'settled-cultivation', summary: 'fixture cultivation',
    ownerId: 'farmer', beneficiaryIds: ['farmer'], triggerFactIds: ['retained-anchor'],
    pressure: 80, createdAtMonth: 0, reviewAtMonth: 12, site: { cellId: siteCellId, z: 1 },
    status: completed ? 'completed' : 'active', lastProgressAtMonth: completed ? 2 : 1,
    missingMaterialIds: [], materialDemands: [], reservations: [], contributorIds: ['farmer'],
    actionEventIds: [...actionEventIds], failureEventIds: [],
    completionEventIds: completed ? [...actionEventIds] : [],
    ...(completed ? { completedAtMonth: 2 } : {}),
    progressEvidence: [], searchCampaigns: [], logisticsEpisodes: [],
  };
}

function stateFor(api, events, project) {
  const grid = blankGrid(api);
  events.forEach((event) => applyConstruction(api, grid, event));
  const state = {
    schemaVersion: 17,
    seed: 83,
    branchId: 'observer-derived-successor-fixture',
    clock: { unit: 'month', elapsedMonths: events.at(-1)?.atMonth ?? 0, monthsPerYear: 12 },
    world: {
      grid, past: [...events], drops: [], animals: [],
      historyCursor: {
        version: 1, eventCount: events.length, hotStartIndex: 0,
        tailEventId: events.at(-1)?.id ?? null,
      },
    },
    people: [],
    projects: [project],
    derived: { structures: [] },
    lastStep: events.slice(-1),
  };
  state.world.physicalStructureIndex = api.derivePhysicalStructureIndex(state);
  return state;
}

function targetFor(encoded, state) {
  return {
    stateHash: encoded.root.hash,
    eventCount: encoded.metadata.eventCount,
    tailEventId: state.world.historyCursor.tailEventId,
  };
}

async function projectExactRootOracle(api, encoded, state, demand, readChunk) {
  const target = targetFor(encoded, state);
  const fold = api.beginObserverDerivedHistoryProjection(target, demand);
  const receipt = await api.streamVerifiedRunHistorySegments(
    api.parseRunStateRoot(encoded.root),
    readChunk,
    (events, position) => {
      api.foldVerifiedObserverDerivedHistorySegment(fold, events, position.startEventIndex);
    },
  );
  assert.equal(receipt.eventCount, target.eventCount);
  return api.finishObserverDerivedHistoryProjection(fold);
}

try {
  writeFileSync(entryPath, [
    `export * from ${JSON.stringify(path.join(workspace, 'server/observer-derived-history-successor.ts'))};`,
    `export * from ${JSON.stringify(path.join(workspace, 'server/observer-derived-history-demand.ts'))};`,
    `export * from ${JSON.stringify(path.join(workspace, 'server/observer-derived-history-projection.ts'))};`,
    `export * from ${JSON.stringify(path.join(workspace, 'server/observer-derived-history-codec.ts'))};`,
    `export * from ${JSON.stringify(path.join(workspace, 'server/physical-structure-ledger-projection.ts'))};`,
    `export { encodeSegmentedRunState, parseRunStateRoot, streamVerifiedRunHistorySegments } from ${JSON.stringify(path.join(workspace, 'server/run-state-codec.ts'))};`,
    `export { derivePhysicalStructureIndex } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/physical-structure-index.ts'))};`,
    `export { Material, MATERIAL_PALETTE } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/material.ts'))};`,
    `export { WORLD_WIDTH, WORLD_DEPTH, WORLD_LEVELS, WORLD_VOXEL_COUNT, cellId, cellsInRadius, setVoxel } from ${JSON.stringify(path.join(workspace, 'src/game/eland/world/grid.ts'))};`,
  ].join('\n'));
  execFileSync(path.join(workspace, 'node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], {
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=256' },
    stdio: 'pipe',
  });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  const siteCellId = api.cellId(8, 8);
  const retained = environment('retained-anchor', 0);
  const wallBottom = construction(
    'wall-bottom', 1, api.Material.Plank, { x: 21, y: 20, z: 1 }, 0,
  );
  const wallMiddle = construction(
    'wall-middle', 1, api.Material.Plank, { x: 21, y: 20, z: 2 }, 1,
  );
  const floatingConstruction = construction(
    'floating-construction', 1, api.Material.Plank, { x: 30, y: 30, z: 6 }, 2,
  );
  const cultivationPositions = [
    { x: 8, y: 8, z: 1 },
    { x: 7, y: 8, z: 1 },
    { x: 9, y: 8, z: 1 },
    { x: 8, y: 7, z: 1 },
    { x: 8, y: 9, z: 1 },
    { x: 6, y: 8, z: 1 },
  ];
  const plants = cultivationPositions.map((position, index) => planting(
    `plant-${index}`,
    1,
    api.Material.CropSprout,
    position,
    3 + index,
    api.cellId(position.x, position.y),
  ));
  const harvests = [
    harvest('harvest-0', 2, api.Material.CropMature, { x: 8, y: 8, z: 1 }, 0, api.cellId(8, 8)),
    harvest('harvest-1', 2, api.Material.CropMature, { x: 7, y: 8, z: 1 }, 1, api.cellId(7, 8)),
  ];
  const wallTop = construction(
    'wall-top', 2, api.Material.Plank, { x: 21, y: 20, z: 3 }, 2,
  );
  const roof = construction(
    'roof', 2, api.Material.Plank, { x: 20, y: 20, z: 3 }, 3,
  );

  const commonEvents = [retained];
  const previousEvents = [
    ...commonEvents,
    wallBottom,
    wallMiddle,
    floatingConstruction,
    ...plants,
  ];
  const suffixEvents = [...harvests, wallTop, roof];
  const nextEvents = [...previousEvents, ...suffixEvents];
  const previousActionIds = plants.map((event) => event.id);
  const nextActionIds = [...previousActionIds, ...harvests.map((event) => event.id)];
  const commonState = stateFor(
    api,
    commonEvents,
    cultivationProject(siteCellId, [], false),
  );
  const previousState = stateFor(
    api,
    previousEvents,
    cultivationProject(siteCellId, previousActionIds, false),
  );
  // Keep the authoritative construction provenance while making the voxel
  // temporarily inactive. A later topology/grid change can make that old
  // record observable as a structure source again.
  api.setVoxel(
    previousState.world.grid,
    30,
    30,
    6,
    api.Material.Air,
  );
  previousState.world.physicalStructureIndex = api.derivePhysicalStructureIndex(previousState);
  const nextState = stateFor(
    api,
    nextEvents,
    cultivationProject(siteCellId, nextActionIds, true),
  );

  const segmentOptions = { maxEventsPerSegmentForTests: 2 };
  const common = await api.encodeSegmentedRunState(
    commonState,
    { mode: 'replace' },
    segmentOptions,
  );
  const previous = await api.encodeSegmentedRunState(
    previousState,
    { mode: 'append', previous: common.metadata },
    segmentOptions,
  );
  const next = await api.encodeSegmentedRunState(
    nextState,
    { mode: 'append', previous: previous.metadata },
    segmentOptions,
  );
  // Same lineage and same final shell, but the history node chain skips the
  // exact previous root. This must not be accepted as its successor.
  const noncontiguousNext = await api.encodeSegmentedRunState(
    nextState,
    { mode: 'append', previous: common.metadata },
    segmentOptions,
  );
  assert.ok([2, 3].includes(previous.metadata.schemaVersion));
  assert.ok([2, 3].includes(next.metadata.schemaVersion));

  const chunks = new Map();
  for (const snapshot of [common, previous, next, noncontiguousNext]) {
    for (const chunk of [snapshot.root, ...snapshot.parts]) chunks.set(chunk.hash, chunk);
  }
  const readChunk = (hash) => {
    const chunk = chunks.get(hash);
    if (!chunk) throw new Error(`observer derived fixture missing chunk ${hash}`);
    return chunk;
  };

  const previousDecoded = await api.decodeBoundedRunStateWithPhysicalProjection(
    previous.root,
    readChunk,
    { hotEventLimit: 2 },
  );
  const nextDecoded = await api.decodeBoundedRunStateWithPhysicalProjection(
    next.root,
    readChunk,
    { hotEventLimit: suffixEvents.length },
  );
  assert.equal(previousDecoded.state.world.historyCursor.hotStartIndex, previousEvents.length - 2);
  assert.equal(nextDecoded.state.world.historyCursor.hotStartIndex, previousEvents.length);
  assert.ok(previousDecoded.physicalProjection.index.constructionRecords.some(
    (record) => record.sourceEventId === floatingConstruction.id,
  ));
  assert.equal(previousDecoded.physicalProjection.index.structures.some(
    (structure) => structure.sourceEventIds.includes(floatingConstruction.id),
  ), false, '悬空 construction record 在形成连通结构前不得伪装成 structure');
  const collectedPreviousDemand = api.collectObserverDerivedHistoryGenesisDemandFromVerifiedShell({
    state: previousDecoded.state,
    stateHash: previous.root.hash,
    physicalProjection: previousDecoded.physicalProjection,
  });
  assert.ok(collectedPreviousDemand.futureEventIds.includes(floatingConstruction.id),
    '尚未进入任何 structure 的 construction record 必须提前进入 future closure');

  const preparedFutureIds = [
    wallBottom.id,
    wallMiddle.id,
    floatingConstruction.id,
    ...previousActionIds,
  ].sort((left, right) => left.localeCompare(right));
  const previousDemand = {
    settledCultivationProjects: [],
    residentialStructures: [],
    retainedEventIds: [retained.id],
    futureEventIds: preparedFutureIds,
  };
  const previousProjection = await projectExactRootOracle(
    api,
    previous,
    previousState,
    previousDemand,
    readChunk,
  );
  const previousEncodedSidecar = api.encodeObserverDerivedHistorySidecar({
    sourceDemand: previousDemand,
    projection: previousProjection,
  });
  const strictPrevious = api.decodeObserverDerivedHistorySidecar(
    previousEncodedSidecar.chunk,
    {
      reference: previousEncodedSidecar.reference,
      boundary: { target: targetFor(previous, previousState) },
    },
  );

  const nextProjectsBefore = structuredClone(nextDecoded.state.projects);
  const nextPhysicalBefore = structuredClone(nextDecoded.state.world.physicalStructureIndex);
  const successor = await api.projectObserverDerivedHistoryFromVerifiedSuccessor({
    previous: strictPrevious,
    previousRootChunk: previous.root,
    nextState: nextDecoded.state,
    nextRootChunk: next.root,
    nextPhysicalProjection: nextDecoded.physicalProjection,
    readChunk,
  });
  api.assertVerifiedObserverDerivedHistorySuccessor(successor);

  const expectedDemand = {
    settledCultivationProjects: [{
      projectId: 'cultivation-project',
      completedAtMonth: 2,
      siteCellIds: api.cellsInRadius(siteCellId, 2).sort((left, right) => left - right),
      actionEventIds: [...nextActionIds].sort((left, right) => left.localeCompare(right)),
      completionEventIds: [...nextActionIds],
    }],
    residentialStructures: [{
      structureId: 'structure-21:20:1',
      sourceEventIds: [wallBottom.id, wallMiddle.id, wallTop.id, roof.id],
    }],
    retainedEventIds: [retained.id],
    futureEventIds: [floatingConstruction.id],
  };
  assert.deepEqual(successor.encoded.sidecar.sourceDemand, expectedDemand,
    'next demand 必须只来自 current project/physical shell 和原样 retained lease');
  const fullNextRootOracle = await projectExactRootOracle(
    api,
    next,
    nextState,
    expectedDemand,
    readChunk,
  );
  assert.deepEqual(
    successor.encoded.sidecar.projection,
    fullNextRootOracle,
    'verified incremental fold 必须等于 next exact-root 全量 projection oracle',
  );
  assert.equal(successor.authority.stateHash, next.root.hash);
  assert.equal(successor.target.eventCount, nextEvents.length);
  assert.equal(successor.suffixEventCount, suffixEvents.length);
  assert.equal(successor.continuationReady, false);
  assert.deepEqual(successor.continuationGaps, api.OBSERVER_DERIVED_HISTORY_CONTINUATION_GAPS);
  assert.equal(
    successor.encoded.sidecar.projection.establishedCultivationWitness?.projectId,
    'cultivation-project',
  );
  assert.deepEqual(nextDecoded.state.projects, nextProjectsBefore,
    'fold-only successor 不得改写 next projects');
  assert.deepEqual(nextDecoded.state.world.physicalStructureIndex, nextPhysicalBefore,
    'fold-only successor 不得改写 next physical shell');

  await assert.rejects(
    api.projectObserverDerivedHistoryFromVerifiedSuccessor({
      previous: structuredClone(strictPrevious),
      previousRootChunk: previous.root,
      nextState: nextDecoded.state,
      nextRootChunk: next.root,
      nextPhysicalProjection: nextDecoded.physicalProjection,
      readChunk,
    }),
    /strict store-selected decoder/u,
    'decoded sidecar clone 不得伪造 previous provenance',
  );
  await assert.rejects(
    api.projectObserverDerivedHistoryFromVerifiedSuccessor({
      previous: strictPrevious,
      previousRootChunk: common.root,
      nextState: nextDecoded.state,
      nextRootChunk: next.root,
      nextPhysicalProjection: nextDecoded.physicalProjection,
      readChunk,
    }),
    /previous sidecar target.*previous root/u,
    '错 previous root 必须在 fold 前拒绝',
  );

  const noncontiguousDecoded = await api.decodeBoundedRunStateWithPhysicalProjection(
    noncontiguousNext.root,
    readChunk,
    { hotEventLimit: suffixEvents.length },
  );
  await assert.rejects(
    api.projectObserverDerivedHistoryFromVerifiedSuccessor({
      previous: strictPrevious,
      previousRootChunk: previous.root,
      nextState: noncontiguousDecoded.state,
      nextRootChunk: noncontiguousNext.root,
      nextPhysicalProjection: noncontiguousDecoded.physicalProjection,
      readChunk,
    }),
    /previous root|previous.*边界/u,
    '同 lineage 但未精确到达 previous head 的 suffix 必须拒绝',
  );

  await assert.rejects(
    api.projectObserverDerivedHistoryFromVerifiedSuccessor({
      previous: strictPrevious,
      previousRootChunk: previous.root,
      nextState: structuredClone(nextDecoded.state),
      nextRootChunk: next.root,
      nextPhysicalProjection: nextDecoded.physicalProjection,
      readChunk,
    }),
    /不属于当前权威 state root/u,
    'caller shell clone 不得与另一个 state identity 的 physical authority 配对',
  );
  assert.throws(
    () => api.assertVerifiedObserverDerivedHistorySuccessor(structuredClone(successor)),
    /module-verified exact-root fold/u,
    'artifact clone 不得伪造 successor provenance',
  );

  const unpreparedDemand = {
    ...previousDemand,
    futureEventIds: preparedFutureIds.filter((eventId) => eventId !== plants[0].id),
  };
  const unpreparedProjection = await projectExactRootOracle(
    api,
    previous,
    previousState,
    unpreparedDemand,
    readChunk,
  );
  const unpreparedEncoded = api.encodeObserverDerivedHistorySidecar({
    sourceDemand: unpreparedDemand,
    projection: unpreparedProjection,
  });
  const strictUnprepared = api.decodeObserverDerivedHistorySidecar(
    unpreparedEncoded.chunk,
    {
      reference: unpreparedEncoded.reference,
      boundary: { target: targetFor(previous, previousState) },
    },
  );
  const legacyRecovered = await api.projectObserverDerivedHistoryFromVerifiedSuccessor({
    previous: strictUnprepared,
    previousRootChunk: previous.root,
    nextState: nextDecoded.state,
    nextRootChunk: next.root,
    nextPhysicalProjection: nextDecoded.physicalProjection,
    readChunk,
  });
  assert.deepEqual(
    legacyRecovered.encoded.sidecar.projection,
    fullNextRootOracle,
    '旧 sidecar 新增 prefix demand 必须由 exact previous-root scan 恢复，不得从 hot window 猜测',
  );
  assert.equal(
    legacyRecovered.encoded.sidecar.projection.demandEventBasis.find(
      (entry) => entry.eventId === plants[0].id,
    )?.latestWorldEvidence?.absoluteIndex,
    previousEvents.indexOf(plants[0]),
  );

  const memoryUsage = process.memoryUsage();
  assert.ok(memoryUsage.rss < 256 * 1_024 * 1_024,
    'observer derived successor fixture RSS 必须低于 256 MiB');
  console.log(JSON.stringify({
    result: 'passed',
    previousEventCount: previousEvents.length,
    suffixEventCount: successor.suffixEventCount,
    nextEventCount: successor.target.eventCount,
    residentialStructures: successor.encoded.sidecar.sourceDemand.residentialStructures.length,
    settledCultivationProjects:
      successor.encoded.sidecar.sourceDemand.settledCultivationProjects.length,
    retainedEventIds: successor.encoded.sidecar.sourceDemand.retainedEventIds.length,
    futureEventIds: successor.encoded.sidecar.sourceDemand.futureEventIds.length,
    continuationReady: successor.continuationReady,
    continuationGaps: successor.continuationGaps.length,
    rssBytes: memoryUsage.rss,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
