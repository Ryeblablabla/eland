import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-physical-v30-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'entry.mjs');

function baseEvent(id, atMonth) {
  return { id, atMonth, orderInMonth: 0, planningTick: 1, orderInTick: 0, cellId: 0 };
}

function environment(id, atMonth) {
  return { ...baseEvent(id, atMonth), kind: 'environment', change: 'condition', result: id, diff: {} };
}

function construction(api, id, atMonth, materialId, position, status = 'completed') {
  return {
    ...baseEvent(id, atMonth), kind: 'action', actionTick: 1, who: 'p1', cause: 'intent',
    action: { kind: 'act', operation: 'combine', targets: [] },
    fromCellId: 0, toCellId: 0, fromZ: 1, toZ: 1, pathSegment: [],
    status, result: id, diff: { outputMaterialId: materialId, position },
  };
}

function exert(api, id, atMonth, materialId, position) {
  return {
    ...construction(api, id, atMonth, materialId, position),
    action: { kind: 'act', operation: 'exert', targets: [] },
  };
}

function blankGrid(api) {
  const voxels = new Uint16Array(api.WORLD_VOXEL_COUNT);
  for (let y = 0; y < api.WORLD_DEPTH; y += 1) {
    for (let x = 0; x < api.WORLD_WIDTH; x += 1) {
      voxels[x + y * api.WORLD_WIDTH] = api.Material.PackedSoil;
    }
  }
  return {
    version: 2, width: api.WORLD_WIDTH, depth: api.WORLD_DEPTH, levels: api.WORLD_LEVELS,
    generator: { version: 'material-world-v4-regional-geology', seed: 30 },
    palette: api.MATERIAL_PALETTE, voxels,
  };
}

function stateFor(api, events, grid, atMonth = 1) {
  return {
    schemaVersion: 17,
    clock: { unit: 'month', elapsedMonths: atMonth, monthsPerYear: 12 },
    world: {
      grid, past: [...events], drops: [], animals: [],
      historyCursor: {
        version: 1, eventCount: events.length, hotStartIndex: 0,
        tailEventId: events.at(-1)?.id ?? null,
      },
    },
    derived: { structures: [] },
    lastStep: events.slice(-1),
  };
}

function applyConstructionGrid(api, grid, event) {
  if (event.kind !== 'action' || event.status !== 'completed'
    || event.action.kind !== 'act' || event.action.operation !== 'combine') return;
  const { x, y, z } = event.diff.position;
  api.setVoxel(grid, x, y, z, event.diff.outputMaterialId);
}

function stableIndex(index) {
  const { voxelRevision: _runtimeVoxelRevision, ...stable } = index;
  return {
    ...stable,
    constructionRecords: index.constructionRecords?.map((record) => ({ ...record })),
    structures: index.structures.map((structure) => ({
      ...structure,
      occupiedCells: [...structure.occupiedCells],
      interiorCells: [...structure.interiorCells],
      interiorPositions: structure.interiorPositions.map((position) => ({ ...position })),
      materialIds: [...structure.materialIds],
      sourceEventIds: [...structure.sourceEventIds],
    })),
  };
}

try {
  writeFileSync(entryPath, [
    `export * from ${JSON.stringify(path.resolve('src/game/eland/domain/physical-structure-index.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('server/physical-structure-ledger-projection.ts'))};`,
    `export { encodeSegmentedRunState, decodeSegmentedRunStateBounded } from ${JSON.stringify(path.resolve('server/run-state-codec.ts'))};`,
    `export { appendCommittedEvents } from ${JSON.stringify(path.resolve('src/game/eland/domain/history.ts'))};`,
    `export { clearPlanningEventOverlay, registerPlanningEventOverlay } from ${JSON.stringify(path.resolve('src/game/eland/domain/event-index.ts'))};`,
    `export { Material, MATERIAL_PALETTE } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};`,
    `export { WORLD_WIDTH, WORLD_DEPTH, WORLD_LEVELS, WORLD_VOXEL_COUNT, setVoxel } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};`,
  ].join('\n'));
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entryPath, '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' }, stdio: 'pipe' });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  const a = { x: 10, y: 10, z: 1 };
  const bridge = { x: 11, y: 10, z: 1 };
  const c = { x: 12, y: 10, z: 1 };
  const workshop = { x: 10, y: 11, z: 1 };
  const prefix = [
    environment('genesis', 0),
    construction(api, 'duplicate-source', 1, api.Material.Plank, a),
    construction(api, 'duplicate-source', 1, api.Material.Stone, c),
    construction(api, 'workshop-source', 1, api.Material.Workshop, workshop),
    construction(api, 'blocked-combine', 1, api.Material.Stone, { x: 13, y: 10, z: 1 }, 'blocked'),
    exert(api, 'not-a-combine', 1, api.Material.Stone, { x: 14, y: 10, z: 1 }),
  ];
  const suffix = [
    construction(api, 'bridge-source', 2, api.Material.FiredBrick, bridge),
    construction(api, 'a-stone-source', 2, api.Material.Stone, a),
  ];
  const all = [...prefix, ...suffix];

  const incrementalGrid = blankGrid(api);
  prefix.forEach((event) => applyConstructionGrid(api, incrementalGrid, event));
  const incrementalState = stateFor(api, prefix, incrementalGrid, 1);
  const prefixIndex = api.derivePhysicalStructureIndex(incrementalState);
  incrementalState.world.physicalStructureIndex = prefixIndex;
  suffix.forEach((event) => applyConstructionGrid(api, incrementalGrid, event));
  const previousSeal = { eventCount: prefix.length, tailEventId: prefix.at(-1).id };
  api.appendCommittedEvents(incrementalState, suffix);
  incrementalState.clock.elapsedMonths = 2;
  const incremental = api.advancePhysicalStructureIndex(
    incrementalState, prefixIndex, suffix, previousSeal,
  );

  const fullGrid = blankGrid(api);
  all.forEach((event) => applyConstructionGrid(api, fullGrid, event));
  const fullState = stateFor(api, all, fullGrid, 2);
  const full = api.derivePhysicalStructureIndex(fullState);
  assert.deepEqual(stableIndex(incremental), stableIndex(full), 'full 与本月增量必须完全等价');
  assert.equal(full.projectionVersion, 2);
  assert.equal(full.appliedHistoryEventCount, all.length);
  assert.equal(full.constructionEventCount, 5, '只计 completed combine，blocked/exert 不计');
  assert.equal(full.constructionRecords.length, 5, '同坐标不同材料必须保留各自 bounded provenance');
  assert.equal(full.structures.length, 1, '三块非 placeable 建筑材料必须连成一个结构');
  assert.equal(full.structures[0].id, 'structure-12:10:1', 'origin 顺序必须来自当前材料的首次建造 ordinal');
  assert.deepEqual(full.structures[0].sourceEventIds, ['duplicate-source', 'bridge-source', 'a-stone-source']);

  const forgedGrid = blankGrid(api);
  prefix.forEach((event) => applyConstructionGrid(api, forgedGrid, event));
  suffix.forEach((event) => applyConstructionGrid(api, forgedGrid, event));
  const forgedState = stateFor(api, prefix, forgedGrid, 2);
  const forgedPrefixIndex = api.derivePhysicalStructureIndex(forgedState);
  api.appendCommittedEvents(forgedState, suffix);
  assert.throws(() => api.advancePhysicalStructureIndex(
    forgedState,
    forgedPrefixIndex,
    [structuredClone(suffix[0]), suffix[1]],
    previousSeal,
  ), /未绑定到权威历史/u, '同长度同尾 ID 的伪 suffix 也必须被拒绝');

  fullState.world.physicalStructureIndex = full;
  const connections = api.constructedConnectionPositionsOf(fullState);
  assert.equal(connections.has('10:11:1'), true, 'placeable 建筑必须进入 construction connection lane');
  assert.equal(full.structures.some((structure) => structure.occupiedCells.includes(10 + 11 * api.WORLD_WIDTH)), false,
    'placeable 建筑不得进入 physical shelter structure lane');

  const planningState = structuredClone(fullState);
  const committedPlanningIndex = planningState.world.physicalStructureIndex;
  const planningPosition = { x: 20, y: 20, z: 1 };
  const planningEvent = construction(api, 'planning-construction', 2, api.Material.Stone, planningPosition);
  api.setVoxel(planningState.world.grid, planningPosition.x, planningPosition.y, planningPosition.z, api.Material.Stone);
  api.registerPlanningEventOverlay(planningState, [planningEvent]);
  const planningPreview = api.physicalStructureIndexOf(planningState);
  assert.equal(planningPreview.constructionRecords.length, full.constructionRecords.length + 1);
  assert.strictEqual(planningState.world.physicalStructureIndex, committedPlanningIndex,
    'planning preview 不得写回 committed physical cache');
  api.clearPlanningEventOverlay(planningState);

  const snapshot = await api.encodeSegmentedRunState(
    fullState, { mode: 'replace' }, { maxEventsPerSegmentForTests: 3 },
  );
  const chunks = new Map([snapshot.root, ...snapshot.parts].map((chunk) => [chunk.hash, chunk]));
  const readChunk = (hash) => {
    const chunk = chunks.get(hash);
    if (!chunk) throw new Error(`fixture 缺少 chunk ${hash}`);
    return chunk;
  };
  const decoded = await api.decodeBoundedRunStateWithPhysicalProjection(
    snapshot.root, readChunk, { hotEventLimit: 2 },
  );
  const malformedDimensionsState = structuredClone(fullState);
  malformedDimensionsState.world.grid.width = api.WORLD_WIDTH - 1;
  const malformedDimensionsSnapshot = await api.encodeSegmentedRunState(
    malformedDimensionsState, { mode: 'replace' }, { maxEventsPerSegmentForTests: 3 },
  );
  const malformedDimensionsChunks = new Map(
    [malformedDimensionsSnapshot.root, ...malformedDimensionsSnapshot.parts]
      .map((chunk) => [chunk.hash, chunk]),
  );
  await assert.rejects(
    api.decodeBoundedRunStateWithPhysicalProjection(
      malformedDimensionsSnapshot.root,
      (hash) => malformedDimensionsChunks.get(hash),
      { hotEventLimit: 2 },
    ),
    /canonical world dimensions/u,
    'hash-valid root 的非 canonical 尺寸必须在 provenance fold 前失败关闭',
  );
  const boundedState = decoded.state;
  const missingProjectionState = structuredClone(boundedState);
  delete missingProjectionState.world.physicalStructureIndex;
  assert.throws(() => api.physicalStructureIndexOf(missingProjectionState), /缺少.*v2 投影/u,
    'bounded hot tail 不得冒充完整建造历史');

  const streamed = decoded.physicalProjection;
  assert.deepEqual(stableIndex(streamed.index), stableIndex(full), 'verified segmented fold 必须与 full 完全等价');
  api.assertPhysicalStructureLedgerProjectionMatchesShell(boundedState, snapshot.root.hash, streamed);
  assert.throws(
    () => api.assertPhysicalStructureLedgerProjectionMatchesShell(boundedState, 'c'.repeat(64), streamed),
    /不属于当前权威/u,
  );
  const shellFromAnotherObject = structuredClone(boundedState);
  assert.throws(
    () => api.assertPhysicalStructureLedgerProjectionMatchesShell(
      shellFromAnotherObject, snapshot.root.hash, streamed,
    ),
    /不属于当前权威/u,
    '真实 ledger projection 不得绑定到另一个 shell 对象',
  );
  assert.throws(
    () => api.assertPhysicalStructureLedgerProjectionMatchesShell(
      boundedState, snapshot.root.hash, { ...streamed },
    ),
    /不属于当前权威/u,
    '复制字段不能伪造私有 projection provenance',
  );
  assert.throws(() => {
    streamed.index.structures = [];
  }, TypeError, 'verified projection result 必须深冻结，不能在验证后篡改');
  const gap = api.beginPhysicalStructureFold(boundedState.world.grid);
  assert.throws(() => api.foldPhysicalStructureEvents(gap, all.slice(0, 1), 1), /重复或跳跃/u);

  incrementalState.world.physicalStructureIndex = incremental;
  api.setVoxel(incrementalGrid, bridge.x, bridge.y, bridge.z, api.Material.Air);
  const remove = environment('remove-bridge', 3);
  const removalSeal = { eventCount: all.length, tailEventId: all.at(-1).id };
  api.appendCommittedEvents(incrementalState, [remove]);
  incrementalState.clock.elapsedMonths = 3;
  const removed = api.advancePhysicalStructureIndex(incrementalState, incremental, [remove], removalSeal);
  const removedFull = stateFor(api, [...all, remove], structuredClone(incrementalGrid), 3);
  assert.deepEqual(stableIndex(removed), stableIndex(api.derivePhysicalStructureIndex(removedFull)),
    '非建造拆除后 topology 重算仍须与 full 等价');
  assert.equal(removed.structures.length, 2);

  incrementalState.world.physicalStructureIndex = removed;
  api.setVoxel(incrementalGrid, a.x, a.y, a.z, api.Material.Plank);
  const restore = environment('restore-old-material-without-combine', 4);
  const restoreSeal = { eventCount: all.length + 1, tailEventId: remove.id };
  api.appendCommittedEvents(incrementalState, [restore]);
  incrementalState.clock.elapsedMonths = 4;
  const restored = api.advancePhysicalStructureIndex(incrementalState, removed, [restore], restoreSeal);
  const restoredFullState = stateFor(api, [...all, remove, restore], structuredClone(incrementalGrid), 4);
  const restoredFull = api.derivePhysicalStructureIndex(restoredFullState);
  assert.deepEqual(stableIndex(restored), stableIndex(restoredFull),
    '非 combine 恢复旧材料时必须重新采用旧材料建造来源');
  assert.equal(restored.structures.find((structure) => structure.id === 'structure-10:10:1')?.sourceEventIds[0], 'duplicate-source');

  const memoryUsage = process.memoryUsage();
  assert.ok(memoryUsage.rss < 256 * 1024 * 1024, 'v30 synthetic fixture RSS 不得超过 256 MiB');
  console.log(JSON.stringify({
    result: 'passed', eventCount: all.length, constructionRecords: full.constructionRecords.length,
    structureCount: full.structures.length, removedStructureCount: removed.structures.length,
    rssBytes: memoryUsage.rss,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
