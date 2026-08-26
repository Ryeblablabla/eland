import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-physical-source-seal-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'entry.mjs');

function baseEvent(id, atMonth) {
  return { id, atMonth, orderInMonth: 0, planningTick: 1, orderInTick: 0, cellId: 0 };
}

function environment(id, atMonth) {
  return {
    ...baseEvent(id, atMonth),
    kind: 'environment',
    change: 'condition',
    result: id,
    diff: {},
  };
}

function construction(id, atMonth, materialId, position) {
  return {
    ...baseEvent(id, atMonth),
    kind: 'action',
    actionTick: 1,
    who: 'builder',
    cause: 'intent',
    action: { kind: 'act', operation: 'combine', targets: [] },
    fromCellId: 0,
    toCellId: 0,
    fromZ: 1,
    toZ: 1,
    pathSegment: [],
    status: 'completed',
    result: id,
    diff: { outputMaterialId: materialId, position },
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
    version: 2,
    width: api.WORLD_WIDTH,
    depth: api.WORLD_DEPTH,
    levels: api.WORLD_LEVELS,
    generator: { version: 'material-world-v4-regional-geology', seed: 73 },
    palette: api.MATERIAL_PALETTE,
    voxels,
  };
}

function applyConstruction(api, grid, event) {
  if (event.kind === 'action'
    && event.status === 'completed'
    && event.action?.kind === 'act'
    && event.action.operation === 'combine') {
    const { x, y, z } = event.diff.position;
    api.setVoxel(grid, x, y, z, event.diff.outputMaterialId);
  }
}

function physicalState(api, events) {
  const grid = blankGrid(api);
  events.forEach((event) => applyConstruction(api, grid, event));
  const state = {
    schemaVersion: 17,
    seed: 73,
    branchId: 'physical-source-seal-fixture',
    clock: {
      unit: 'month',
      elapsedMonths: events.at(-1)?.atMonth ?? 0,
      monthsPerYear: 12,
    },
    world: {
      grid,
      past: [...events],
      drops: [],
      animals: [],
      historyCursor: {
        version: 1,
        eventCount: events.length,
        hotStartIndex: 0,
        tailEventId: events.at(-1)?.id ?? null,
      },
    },
    people: [],
    projects: [],
    derived: { structures: [] },
    lastStep: events.slice(-1),
  };
  state.world.physicalStructureIndex = api.derivePhysicalStructureIndex(state);
  return state;
}

try {
  writeFileSync(entryPath, [
    `export * from ${JSON.stringify(path.resolve('server/physical-structure-ledger-projection.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('server/physical-structure-ledger-codec.ts'))};`,
    `export { encodeSegmentedRunState } from ${JSON.stringify(path.resolve('server/run-state-codec.ts'))};`,
    `export { derivePhysicalStructureIndex } from ${JSON.stringify(path.resolve('src/game/eland/domain/physical-structure-index.ts'))};`,
    `export { Material, MATERIAL_PALETTE } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};`,
    `export { WORLD_WIDTH, WORLD_DEPTH, WORLD_LEVELS, WORLD_VOXEL_COUNT, setVoxel } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};`,
  ].join('\n'));
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
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

  const previousEvents = [
    environment('genesis', 0),
    construction('previous-wall', 1, api.Material.Plank, { x: 10, y: 10, z: 1 }),
  ];
  const suffixEvents = [
    environment('successor-pulse', 2),
    construction('successor-workshop', 2, api.Material.Workshop, { x: 11, y: 10, z: 1 }),
  ];
  const alternatePreviousEvents = [
    environment('alternate-genesis', 0),
    construction('alternate-wall', 1, api.Material.Stone, { x: 14, y: 10, z: 1 }),
  ];
  const previousState = physicalState(api, previousEvents);
  const nextState = physicalState(api, [...previousEvents, ...suffixEvents]);
  const alternatePreviousState = physicalState(api, alternatePreviousEvents);
  const segmentOptions = { maxEventsPerSegmentForTests: 1 };
  const previous = await api.encodeSegmentedRunState(
    previousState,
    { mode: 'replace' },
    segmentOptions,
  );
  const next = await api.encodeSegmentedRunState(
    nextState,
    { mode: 'append', previous: previous.metadata },
    segmentOptions,
  );
  const alternatePrevious = await api.encodeSegmentedRunState(
    alternatePreviousState,
    { mode: 'replace' },
    segmentOptions,
  );
  const replacementNext = await api.encodeSegmentedRunState(
    nextState,
    { mode: 'replace' },
    segmentOptions,
  );
  const chunks = new Map();
  for (const snapshot of [previous, next, alternatePrevious, replacementNext]) {
    for (const chunk of [snapshot.root, ...snapshot.parts]) chunks.set(chunk.hash, chunk);
  }
  const readChunk = (hash) => {
    const chunk = chunks.get(hash);
    if (!chunk) throw new Error(`physical source seal fixture missing chunk ${hash}`);
    return chunk;
  };

  const decoded = await api.decodeBoundedRunStateWithPhysicalProjection(
    previous.root,
    readChunk,
    { hotEventLimit: 1 },
  );
  const encodedSidecar = api.encodePhysicalStructureLedgerSidecar(decoded.physicalProjection);
  const strictSidecar = api.decodePhysicalStructureLedgerSidecar(encodedSidecar.chunk, {
    reference: encodedSidecar.reference,
    boundary: {
      authority: decoded.physicalProjection.authority,
      target: decoded.physicalProjection.target,
    },
  });
  const previousProjection = await api.bootstrapPhysicalStructureLedgerFromStrictDecodedSidecar(
    strictSidecar,
    decoded.state,
    previous.root,
    readChunk,
  );
  const sourceSeal = api.physicalStructureLedgerProjectionSourceSeal(previousProjection);
  assert.equal(Object.isFrozen(sourceSeal), true, 'source provenance seal 必须不可变');
  assert.deepEqual(Object.keys(sourceSeal).sort(), [
    'elapsedMonths',
    'eventCount',
    'schemaVersion',
    'stateHash',
    'tailEventId',
    'voxelContentHash',
    'voxelRevision',
  ]);
  assert.ok(Object.values(sourceSeal).every((value) => value === null
    || ['string', 'number'].includes(typeof value)),
  'registry 对外证明的来源值只含标量，不得含 state/grid/history 对象');

  // The controller is free to evolve this decoded object in place. Its former
  // state must not be consulted by successor provenance after bootstrap.
  decoded.state.clock.elapsedMonths += 100;
  decoded.state.world.grid.voxels[0] = api.Material.Air;
  decoded.state.world.historyCursor.tailEventId = 'mutated-after-bootstrap';
  assert.deepEqual(
    api.physicalStructureLedgerProjectionSourceSeal(previousProjection),
    sourceSeal,
    'source state 后续突变不得改写或撤销已铸造的标量 provenance',
  );

  const successor = await api.projectPhysicalStructureLedgerFromVerifiedSuccessor(
    previousProjection,
    previous.root,
    nextState,
    next.root,
    readChunk,
  );
  assert.equal(successor.authority.stateHash, next.root.hash);
  assert.equal(successor.target.eventCount, previousEvents.length + suffixEvents.length);

  const projectionClone = structuredClone(previousProjection);
  assert.throws(
    () => api.physicalStructureLedgerProjectionSourceSeal(projectionClone),
    /canonical sidecar 不能充当 provenance/u,
    '字段完全相同的 decoded/structured clone 不得获得私有 brand',
  );
  await assert.rejects(
    api.projectPhysicalStructureLedgerFromVerifiedSuccessor(
      projectionClone,
      previous.root,
      nextState,
      next.root,
      readChunk,
    ),
    /canonical sidecar 不能充当 provenance/u,
  );
  await assert.rejects(
    api.projectPhysicalStructureLedgerFromVerifiedSuccessor(
      previousProjection,
      alternatePrevious.root,
      nextState,
      next.root,
      readChunk,
    ),
    /source seal.*exact previous root shell|不属于当前权威 state root/u,
    '品牌 projection 配错 previous root 必须失败关闭',
  );
  await assert.rejects(
    api.projectPhysicalStructureLedgerFromVerifiedSuccessor(
      previousProjection,
      previous.root,
      nextState,
      replacementNext.root,
      readChunk,
    ),
    /lineage/u,
    '错误 next lineage 不得伪装成 verified successor',
  );

  const mismatchedGridState = structuredClone(nextState);
  mismatchedGridState.world.grid.voxels[0] = api.Material.Air;
  await assert.rejects(
    api.projectPhysicalStructureLedgerFromVerifiedSuccessor(
      previousProjection,
      previous.root,
      mismatchedGridState,
      next.root,
      readChunk,
    ),
    /state\/history\/grid 与 exact root shell 不一致/u,
    'next state 的体素内容必须与 exact next root shell 一致',
  );

  const memoryUsage = process.memoryUsage();
  assert.ok(memoryUsage.rss < 256 * 1024 * 1024, 'source seal fixture RSS 不得超过 256 MiB');
  console.log(JSON.stringify({
    result: 'passed',
    sourceSealScalarCount: Object.keys(sourceSeal).length,
    previousEventCount: previousEvents.length,
    suffixEventCount: suffixEvents.length,
    rssBytes: memoryUsage.rss,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
