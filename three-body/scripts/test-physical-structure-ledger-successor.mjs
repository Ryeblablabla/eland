import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-physical-successor-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'entry.mjs');

function baseEvent(id, atMonth) {
  return {
    id, atMonth, orderInMonth: 0, planningTick: 1, orderInTick: 0, cellId: 0,
  };
}

function environment(id, atMonth) {
  return {
    ...baseEvent(id, atMonth), kind: 'environment', change: 'condition', result: id, diff: {},
  };
}

function construction(id, atMonth, materialId, position) {
  return {
    ...baseEvent(id, atMonth), kind: 'action', actionTick: 1, who: 'builder', cause: 'intent',
    action: { kind: 'act', operation: 'combine', targets: [] },
    fromCellId: 0, toCellId: 0, fromZ: 1, toZ: 1, pathSegment: [],
    status: 'completed', result: id, diff: { outputMaterialId: materialId, position },
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
    generator: { version: 'material-world-v4-regional-geology', seed: 61 },
    palette: api.MATERIAL_PALETTE,
    voxels,
  };
}

function applyConstruction(api, grid, event) {
  if (event.kind !== 'action'
    || event.status !== 'completed'
    || event.action.kind !== 'act'
    || event.action.operation !== 'combine') return;
  const { x, y, z } = event.diff.position;
  api.setVoxel(grid, x, y, z, event.diff.outputMaterialId);
}

function stateFor(events, grid) {
  return {
    schemaVersion: 17,
    seed: 61,
    branchId: 'physical-successor-fixture',
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
}

function physicalState(api, events) {
  const grid = blankGrid(api);
  events.forEach((event) => applyConstruction(api, grid, event));
  const state = stateFor(events, grid);
  state.world.physicalStructureIndex = api.derivePhysicalStructureIndex(state);
  return state;
}

function stableIndex(index) {
  const { voxelRevision: _runtimeRevision, ...stable } = index;
  return structuredClone(stable);
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

  const genesis = environment('genesis', 0);
  const branchAConstruction = construction(
    'branch-a-construction', 1, api.Material.Plank, { x: 10, y: 10, z: 1 },
  );
  const branchBConstruction = construction(
    'branch-b-construction', 1, api.Material.Stone, { x: 14, y: 10, z: 1 },
  );
  const suffix = [
    environment('successor-pulse', 2),
    construction('successor-workshop', 2, api.Material.Workshop, { x: 11, y: 10, z: 1 }),
  ];
  const commonEvents = [genesis];
  const previousAEvents = [...commonEvents, branchAConstruction];
  const previousBEvents = [...commonEvents, branchBConstruction];
  const nextAEvents = [...previousAEvents, ...suffix];
  const nextBEvents = [...previousBEvents, ...suffix];

  const commonState = physicalState(api, commonEvents);
  const previousAState = physicalState(api, previousAEvents);
  const previousBState = physicalState(api, previousBEvents);
  const nextAState = physicalState(api, nextAEvents);
  const nextBState = physicalState(api, nextBEvents);
  const segmentOptions = { maxEventsPerSegmentForTests: 1 };
  const common = await api.encodeSegmentedRunState(
    commonState,
    { mode: 'replace' },
    segmentOptions,
  );
  const previousA = await api.encodeSegmentedRunState(
    previousAState,
    { mode: 'append', previous: common.metadata },
    segmentOptions,
  );
  const previousB = await api.encodeSegmentedRunState(
    previousBState,
    { mode: 'append', previous: common.metadata },
    segmentOptions,
  );
  const nextA = await api.encodeSegmentedRunState(
    nextAState,
    { mode: 'append', previous: previousA.metadata },
    segmentOptions,
  );
  const nextB = await api.encodeSegmentedRunState(
    nextBState,
    { mode: 'append', previous: previousB.metadata },
    segmentOptions,
  );
  const replacementNextA = await api.encodeSegmentedRunState(
    nextAState,
    { mode: 'replace' },
    segmentOptions,
  );
  assert.equal(previousA.metadata.schemaVersion, 3);
  assert.equal(nextA.metadata.schemaVersion, 3);

  const chunks = new Map();
  for (const snapshot of [common, previousA, previousB, nextA, nextB, replacementNextA]) {
    for (const chunk of [snapshot.root, ...snapshot.parts]) chunks.set(chunk.hash, chunk);
  }
  const readChunk = (hash) => {
    const chunk = chunks.get(hash);
    if (!chunk) throw new Error(`physical successor fixture missing chunk ${hash}`);
    return chunk;
  };

  const previousDecoded = await api.decodeBoundedRunStateWithPhysicalProjection(
    previousA.root,
    readChunk,
    { hotEventLimit: 1 },
  );
  const previousProjection = previousDecoded.physicalProjection;
  const sidecar = api.encodePhysicalStructureLedgerSidecar(previousProjection);
  const decodedCanonicalSidecar = api.decodePhysicalStructureLedgerSidecar(sidecar.chunk, {
    reference: sidecar.reference,
    boundary: {
      authority: previousProjection.authority,
      target: previousProjection.target,
    },
  });
  api.assertDecodedPhysicalStructureLedgerSidecar(decodedCanonicalSidecar);
  const bootstrappedProjection =
    await api.bootstrapPhysicalStructureLedgerFromStrictDecodedSidecar(
      decodedCanonicalSidecar,
      previousDecoded.state,
      previousA.root,
      readChunk,
    );
  assert.notEqual(bootstrappedProjection, decodedCanonicalSidecar,
    'bootstrap 必须返回重新全量验证并铸造 brand 的新 projection');
  assert.deepEqual(bootstrappedProjection, decodedCanonicalSidecar,
    'bootstrap 新 projection 必须逐字段等于 strict-decoded sidecar');
  api.assertPhysicalStructureLedgerProjectionMatchesShell(
    previousDecoded.state,
    previousA.root.hash,
    bootstrappedProjection,
  );

  const successorProjection = await api.projectPhysicalStructureLedgerFromVerifiedSuccessor(
    bootstrappedProjection,
    previousA.root,
    nextAState,
    nextA.root,
    readChunk,
  );
  const fullNextOracle = await api.decodeBoundedRunStateWithPhysicalProjection(
    nextA.root,
    readChunk,
    { hotEventLimit: 1 },
  );
  assert.deepEqual(
    stableIndex(successorProjection.index),
    stableIndex(fullNextOracle.physicalProjection.index),
    'verified successor 必须与 next root 全量 physical 投影 oracle 完全等价',
  );
  assert.equal(successorProjection.authority.stateHash, nextA.root.hash);
  assert.equal(successorProjection.target.eventCount, nextAEvents.length);
  assert.equal(successorProjection.target.tailEventId, suffix.at(-1).id);
  api.assertPhysicalStructureLedgerProjectionMatchesShell(
    nextAState,
    nextA.root.hash,
    successorProjection,
  );

  await assert.rejects(
    api.projectPhysicalStructureLedgerFromVerifiedSuccessor(
      decodedCanonicalSidecar,
      previousA.root,
      nextAState,
      nextA.root,
      readChunk,
    ),
    /canonical sidecar 不能充当 provenance/u,
    '内容和 shape 均 canonical 的 decoded sidecar 仍不得自行铸造 source authority',
  );
  await assert.rejects(
    api.bootstrapPhysicalStructureLedgerFromStrictDecodedSidecar(
      structuredClone(decodedCanonicalSidecar),
      previousDecoded.state,
      previousA.root,
      readChunk,
    ),
    /strict store-selected decoder/u,
    'canonical clone 不得伪造 strict-decoded bootstrap provenance',
  );
  await assert.rejects(
    api.bootstrapPhysicalStructureLedgerFromStrictDecodedSidecar(
      decodedCanonicalSidecar,
      previousBState,
      previousB.root,
      readChunk,
    ),
    /exact previous root boundary/u,
    'strict sidecar 配错 root/state 必须拒绝',
  );

  const wrongIndexProjection = structuredClone(previousProjection);
  wrongIndexProjection.index.constructionEventCount += 1;
  const wrongIndexSidecar = api.encodePhysicalStructureLedgerSidecar(wrongIndexProjection);
  const strictWrongIndex = api.decodePhysicalStructureLedgerSidecar(wrongIndexSidecar.chunk, {
    reference: wrongIndexSidecar.reference,
    boundary: {
      authority: wrongIndexProjection.authority,
      target: wrongIndexProjection.target,
    },
  });
  await assert.rejects(
    api.bootstrapPhysicalStructureLedgerFromStrictDecodedSidecar(
      strictWrongIndex,
      previousDecoded.state,
      previousA.root,
      readChunk,
    ),
    /strict-decoded sidecar.*全量投影不一致/u,
    'shape-valid 但错误的 strict-decoded index 必须被 exact-root 重算拒绝',
  );
  await assert.rejects(
    api.projectPhysicalStructureLedgerFromVerifiedSuccessor(
      bootstrappedProjection,
      previousB.root,
      nextAState,
      nextA.root,
      readChunk,
    ),
    /不属于当前权威 state root/u,
    '正确 projection 配错 previous root 必须拒绝',
  );
  await assert.rejects(
    api.projectPhysicalStructureLedgerFromVerifiedSuccessor(
      bootstrappedProjection,
      previousA.root,
      nextAState,
      replacementNextA.root,
      readChunk,
    ),
    /lineage/u,
    'replace lineage 的错误 next root 必须拒绝',
  );
  await assert.rejects(
    api.projectPhysicalStructureLedgerFromVerifiedSuccessor(
      bootstrappedProjection,
      previousA.root,
      nextAState,
      nextB.root,
      readChunk,
    ),
    /未精确到达 previous root/u,
    '同 lineage 的 alternate parent 不得伪装成连续 suffix',
  );

  const mismatchedIndexState = {
    ...nextAState,
    world: {
      ...nextAState.world,
      physicalStructureIndex: {
        ...nextAState.world.physicalStructureIndex,
        constructionEventCount:
          nextAState.world.physicalStructureIndex.constructionEventCount + 1,
      },
    },
  };
  await assert.rejects(
    api.projectPhysicalStructureLedgerFromVerifiedSuccessor(
      bootstrappedProjection,
      previousA.root,
      mismatchedIndexState,
      nextA.root,
      readChunk,
    ),
    /physicalStructureIndex 不一致/u,
    'next shell 的 physicalStructureIndex 必须逐字段匹配 verified suffix fold',
  );

  const memoryUsage = process.memoryUsage();
  assert.ok(memoryUsage.rss < 256 * 1024 * 1024, 'physical successor fixture RSS 不得超过 256 MiB');
  console.log(JSON.stringify({
    result: 'passed',
    previousEventCount: previousAEvents.length,
    suffixEventCount: suffix.length,
    nextEventCount: nextAEvents.length,
    constructionRecords: successorProjection.index.constructionRecords.length,
    bootstrapRecomputed: true,
    rssBytes: memoryUsage.rss,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
