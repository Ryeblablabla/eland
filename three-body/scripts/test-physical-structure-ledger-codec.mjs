import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-physical-ledger-codec-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'entry.mjs');
const childEnvironment = { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' };

function baseEvent(id, atMonth) {
  return { id, atMonth, orderInMonth: 0, planningTick: 1, orderInTick: 0, cellId: 0 };
}

function environment(id, atMonth) {
  return { ...baseEvent(id, atMonth), kind: 'environment', change: 'condition', result: id, diff: {} };
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
    generator: { version: 'material-world-v4-regional-geology', seed: 53 },
    palette: api.MATERIAL_PALETTE,
    voxels,
  };
}

function stateFor(events, grid) {
  return {
    schemaVersion: 17,
    seed: 53,
    branchId: 'physical-ledger-codec-fixture',
    clock: { unit: 'month', elapsedMonths: 2, monthsPerYear: 12 },
    world: {
      grid,
      past: events,
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

function cloneChunk(chunk) {
  return { ...chunk, data: Buffer.from(chunk.data) };
}

try {
  writeFileSync(entryPath, [
    `export * from ${JSON.stringify(path.resolve('server/physical-structure-ledger-codec.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('server/physical-structure-ledger-projection.ts'))};`,
    `export { encodeSegmentedRunState } from ${JSON.stringify(path.resolve('server/run-state-codec.ts'))};`,
    `export { Material, MATERIAL_PALETTE } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};`,
    `export { WORLD_WIDTH, WORLD_DEPTH, WORLD_LEVELS, WORLD_VOXEL_COUNT, setVoxel } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};`,
  ].join('\n'));
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { env: childEnvironment, stdio: 'pipe' });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  const roofPosition = { x: 10, y: 10, z: 3 };
  const workshopPosition = { x: 12, y: 10, z: 1 };
  const events = [
    environment('genesis', 0),
    construction('roof-source', 1, api.Material.Plank, roofPosition),
    construction('workshop-tail', 2, api.Material.Workshop, workshopPosition),
  ];
  const grid = blankGrid(api);
  api.setVoxel(grid, roofPosition.x, roofPosition.y, roofPosition.z, api.Material.Plank);
  api.setVoxel(
    grid,
    workshopPosition.x,
    workshopPosition.y,
    workshopPosition.z,
    api.Material.Workshop,
  );
  const state = stateFor(events, grid);
  const encodedState = await api.encodeSegmentedRunState(
    state,
    { mode: 'replace' },
    { maxEventsPerSegmentForTests: 2 },
  );
  const chunks = new Map(
    [encodedState.root, ...encodedState.parts].map((chunk) => [chunk.hash, cloneChunk(chunk)]),
  );
  const projected = await api.decodeBoundedRunStateWithPhysicalProjection(
    encodedState.root,
    (hash) => {
      const chunk = chunks.get(hash);
      if (!chunk) throw new Error(`missing fixture chunk ${hash}`);
      return cloneChunk(chunk);
    },
    { hotEventLimit: 1 },
  );
  const sourceProjection = projected.physicalProjection;
  assert.equal(sourceProjection.index.projectionVersion, 2);
  assert.equal(sourceProjection.index.appliedHistoryEventCount, events.length);
  assert.equal(sourceProjection.index.calculatedAtMonth, 2);
  assert.equal(sourceProjection.index.constructionRecords.length, 2);
  assert.equal(sourceProjection.index.structures.length, 1);
  assert.equal(sourceProjection.index.structures[0].complete, true);

  const mutableInput = structuredClone(sourceProjection);
  const sidecar = api.encodePhysicalStructureLedgerSidecar(mutableInput);
  const originalBytes = Buffer.from(sidecar.chunk.data);
  mutableInput.index.calculatedAtMonth = 999;
  assert.equal(sidecar.projection.index.calculatedAtMonth, 2, 'encode 必须拥有归一化 projection');
  const boundary = {
    authority: sourceProjection.authority,
    target: sourceProjection.target,
  };
  const decoded = api.decodePhysicalStructureLedgerSidecar(sidecar.chunk, {
    reference: sidecar.reference,
    boundary,
  });
  assert.deepEqual(decoded, sourceProjection);
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.index));
  assert.ok(Object.isFrozen(decoded.index.constructionRecords[0]));
  assert.ok(Object.isFrozen(decoded.index.structures[0].interiorPositions[0]));
  assert.equal('continuationReady' in decoded, false, 'codec 不得发布 continuation readiness');

  const exposedBytes = sidecar.chunk.data;
  exposedBytes.fill(0);
  assert.deepEqual(sidecar.chunk.data, originalBytes, 'encode 不得暴露私有字节');

  assert.throws(
    () => api.decodePhysicalStructureLedgerSidecar(sidecar.chunk, {
      reference: { ...sidecar.reference, hash: '0'.repeat(64) },
      boundary,
    }),
    /store-selected content reference/u,
  );
  assert.throws(
    () => api.decodePhysicalStructureLedgerSidecar(sidecar.chunk, {
      reference: sidecar.reference,
      boundary: {
        authority: { stateHash: 'f'.repeat(64) },
        target: boundary.target,
      },
    }),
    /expected authority\/target boundary/u,
  );
  assert.throws(
    () => api.decodePhysicalStructureLedgerSidecar(sidecar.chunk, {
      reference: {
        kind: 'canonical-digest',
        codec: api.PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC,
        hash: sidecar.reference.hash,
      },
      boundary,
    }),
    /content-hash/u,
  );

  const changedBytes = cloneChunk(sidecar.chunk);
  changedBytes.data[0] ^= 0xff;
  assert.throws(
    () => api.decodePhysicalStructureLedgerSidecar(changedBytes, {
      reference: sidecar.reference,
      boundary,
    }),
    /SHA-256 校验失败/u,
  );

  function sidecarForParsed(parsed) {
    const data = Buffer.from(JSON.stringify(parsed), 'utf8');
    const hash = api.hashPhysicalStructureLedgerStoredContent(
      api.PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC,
      data,
    );
    return {
      chunk: {
        hash,
        codec: api.PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC,
        rawSize: data.byteLength,
        data,
      },
      expectation: {
        reference: {
          kind: 'content-hash',
          codec: api.PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC,
          hash,
        },
        boundary,
      },
    };
  }

  function assertRejectedMutation(mutate, pattern) {
    const parsed = JSON.parse(originalBytes.toString('utf8'));
    mutate(parsed);
    const forged = sidecarForParsed(parsed);
    assert.throws(
      () => api.decodePhysicalStructureLedgerSidecar(forged.chunk, forged.expectation),
      pattern,
    );
  }

  assertRejectedMutation(
    (parsed) => { parsed.index.appliedHistoryEventCount -= 1; },
    /applied history boundary/u,
  );
  assertRejectedMutation(
    (parsed) => { parsed.index.calculatedAtMonth = -1; },
    /calculatedAtMonth/u,
  );
  assertRejectedMutation(
    (parsed) => { parsed.index.voxelRevision = -1; },
    /voxelRevision/u,
  );
  assertRejectedMutation(
    (parsed) => { parsed.index.constructionRecords[0].x = api.WORLD_WIDTH; },
    /\.x/u,
  );
  assertRejectedMutation(
    (parsed) => { parsed.index.constructionRecords[0].materialId = api.Material.Air; },
    /solid building material/u,
  );
  assertRejectedMutation(
    (parsed) => { parsed.index.constructionRecords.at(-1).sourceEventId = 'not-the-tail'; },
    /tailEventId/u,
  );
  assertRejectedMutation(
    (parsed) => { parsed.index.structures[0].sourceEventIds[0] = 'missing-source'; },
    /缺少对应 construction record/u,
  );
  assertRejectedMutation(
    (parsed) => { parsed.index.structures[0].capacity += 1; },
    /capacity\/complete/u,
  );
  assertRejectedMutation(
    (parsed) => { parsed.index.structures[0].name = 'forged-name'; },
    /name 与材料和完整性不一致/u,
  );
  assertRejectedMutation(
    (parsed) => { parsed.index.constructionRecords[0].extra = true; },
    /字段集合无效/u,
  );

  const prettyBytes = Buffer.from(
    JSON.stringify(JSON.parse(originalBytes.toString('utf8')), null, 2),
    'utf8',
  );
  const prettyHash = api.hashPhysicalStructureLedgerStoredContent(
    api.PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC,
    prettyBytes,
  );
  assert.throws(
    () => api.decodePhysicalStructureLedgerSidecar({
      hash: prettyHash,
      codec: api.PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC,
      rawSize: prettyBytes.byteLength,
      data: prettyBytes,
    }, {
      reference: {
        kind: 'content-hash',
        codec: api.PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC,
        hash: prettyHash,
      },
      boundary,
    }),
    /不是 canonical UTF-8 JSON/u,
  );

  const oversizedBytes = Buffer.alloc(
    api.MAX_PHYSICAL_STRUCTURE_LEDGER_SIDECAR_STORED_BYTES + 1,
  );
  const oversizedHash = api.hashPhysicalStructureLedgerStoredContent(
    api.PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC,
    oversizedBytes,
  );
  assert.throws(
    () => api.decodePhysicalStructureLedgerSidecar({
      hash: oversizedHash,
      codec: api.PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC,
      rawSize: oversizedBytes.byteLength,
      data: oversizedBytes,
    }, {
      reference: {
        kind: 'content-hash',
        codec: api.PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC,
        hash: oversizedHash,
      },
      boundary,
    }),
    /硬上限|rawSize/u,
  );

  const callerOwnedChunk = cloneChunk(sidecar.chunk);
  const snapshot = api.snapshotPhysicalStructureLedgerSidecarChunk(callerOwnedChunk);
  callerOwnedChunk.data.fill(0);
  assert.deepEqual(snapshot.data, originalBytes);
  const snapshotBytes = snapshot.data;
  snapshotBytes.fill(0);
  assert.deepEqual(snapshot.data, originalBytes);

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1_024 * 1_024, `fixture RSS ${rssBytes} 超过 256 MiB`);
  console.log(JSON.stringify({
    result: 'passed',
    codec: api.PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC,
    eventCount: decoded.target.eventCount,
    constructionRecordCount: decoded.index.constructionRecords.length,
    structureCount: decoded.index.structures.length,
    rssBytes,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
