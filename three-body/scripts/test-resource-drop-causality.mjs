import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-resource-causality-test-'));
const bundlePath = path.join(temporaryDirectory, 'resource-causality.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export { advanceWorldProcesses } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/monthly-processes.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { cellId, cellX, cellY, neighbors4, setVoxel, surfaceMaterial, surfaceStandingPosition, topZ, voxelAt } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=resource-causality-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    advanceWorldProcesses,
    cellId,
    cellX,
    cellY,
    createInitialState,
    executePrimitiveAction,
    neighbors4,
    setVoxel,
    surfaceMaterial,
    surfaceStandingPosition,
    topZ,
    voxelAt,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const initial = createInitialState(185, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const berryCells = Array.from(
    { length: initial.world.grid.width * initial.world.grid.depth },
    (_, cellId) => cellId,
  ).filter((cellId) => surfaceMaterial(initial.world.grid, cellId) === Material.BerryBush);
  assert.ok(berryCells.length > 0, '开局应保留可由人物真实采集的结果灌木');
  assert.equal(
    initial.world.drops.filter((drop) => drop.materialId === Material.Food || drop.materialId === Material.Seed).length,
    0,
    '未发生采集时，开局不得预生成 Food/Seed drop',
  );
  const initialWoodDrops = initial.world.drops.filter((drop) => drop.materialId === Material.Wood);
  assert.equal(initialWoodDrops.length, 1, '完整树体旁不得预生成 Wood，只保留一份必要的开局木材');
  assert.ok(initialWoodDrops[0].id.startsWith(`starter-${Material.Wood}-`), '唯一开局 Wood 必须来自 starter 保障');

  const passive = structuredClone(initial);
  passive.world.animals = [];
  for (let month = 1; month <= 24; month += 1) advanceWorldProcesses(passive, month);
  assert.equal(
    passive.world.drops.filter((drop) => drop.materialId === Material.Food || drop.materialId === Material.Seed).length,
    0,
    '无人行动的月度生态过程不得凭空投放 Food/Seed',
  );

  const hydrology = createInitialState(20260815, { endpoint: { kind: 'months', value: 1200 }, chaosIntensity: 0 });
  hydrology.world.animals = [];
  hydrology.civilization.climate = { kind: 'temperate', severity: 1, sinceMonth: 0 };
  hydrology.civilization.weather = { kind: 'drought', intensity: 4, sinceMonth: 0 };
  const riverPositions = [...new Map(hydrology.world.mechanicalPower.sources
    .flatMap((segment) => segment.requiredWaterVoxels)
    .map((position) => [`${position.x}:${position.y}:${position.z}`, position])).values()];
  const riverCellIds = new Set(riverPositions.map((position) => cellId(position.x, position.y)));
  const rechargeTarget = riverPositions.find((position) => neighbors4(cellId(position.x, position.y))
    .some((neighbor) => riverPositions.some((candidate) => cellId(candidate.x, candidate.y) === neighbor)));
  assert.ok(rechargeTarget, '水文夹具需要一个邻接其他河道格的真实河道体素');
  const rechargeNeighbor = riverPositions.find((position) => neighbors4(cellId(rechargeTarget.x, rechargeTarget.y))
    .includes(cellId(position.x, position.y)));
  assert.ok(rechargeNeighbor);
  const ordinarySandCell = Array.from(
    { length: hydrology.world.grid.width * hydrology.world.grid.depth },
    (_, candidateCellId) => candidateCellId,
  ).find((candidateCellId) => !riverCellIds.has(candidateCellId)
    && surfaceMaterial(hydrology.world.grid, candidateCellId) !== Material.Air
    && surfaceMaterial(hydrology.world.grid, candidateCellId) !== Material.Water);
  assert.notEqual(ordinarySandCell, undefined);
  setVoxel(
    hydrology.world.grid,
    cellX(ordinarySandCell),
    cellY(ordinarySandCell),
    topZ(hydrology.world.grid, ordinarySandCell),
    Material.Sand,
  );
  let evaporationEvent;
  for (let month = 1; month <= 600 && !evaporationEvent; month += 1) {
    evaporationEvent = advanceWorldProcesses(hydrology, month).find((fact) => fact.diff.changes?.some((change) => (
      change.cellId === cellId(rechargeTarget.x, rechargeTarget.y)
        && change.process === 'evaporation'
    )));
  }
  assert.ok(evaporationEvent, '真实干旱仍应能把生成河道 Water 蒸发为 Sand');
  assert.equal(voxelAt(hydrology.world.grid, rechargeTarget.x, rechargeTarget.y, rechargeTarget.z), Material.Sand);
  setVoxel(
    hydrology.world.grid,
    rechargeNeighbor.x,
    rechargeNeighbor.y,
    rechargeNeighbor.z,
    Material.Water,
  );
  hydrology.civilization.weather = { kind: 'rain', intensity: 4, sinceMonth: 601 };
  let rechargeEvent;
  for (let month = 601; month <= 1200 && !rechargeEvent; month += 1) {
    rechargeEvent = advanceWorldProcesses(hydrology, month).find((fact) => fact.diff.changes?.some((change) => (
      change.cellId === cellId(rechargeTarget.x, rechargeTarget.y)
        && change.process === 'river-recharge'
    )));
  }
  assert.ok(rechargeEvent, '后续真实降雨应能从邻接 Water 逐格补给干涸河道');
  assert.equal(voxelAt(hydrology.world.grid, rechargeTarget.x, rechargeTarget.y, rechargeTarget.z), Material.Water);
  assert.equal(surfaceMaterial(hydrology.world.grid, ordinarySandCell), Material.Sand,
    '不属于生成河道的普通 Sand 不得因降雨凭空变成 Water');

  const harvested = createInitialState(185, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const berryCell = Array.from(
    { length: harvested.world.grid.width * harvested.world.grid.depth },
    (_, cellId) => cellId,
  ).find((cellId) => surfaceMaterial(harvested.world.grid, cellId) === Material.BerryBush);
  assert.notEqual(berryCell, undefined, '采集夹具需要一个结果灌木');
  const actor = harvested.people[0];
  const standing = surfaceStandingPosition(harvested.world.grid, berryCell);
  assert.ok(actor && standing, '人物必须能站在结果灌木的可操作位置');
  actor.position = {
    cellId: standing.cellId,
    z: standing.z,
    previousCellId: standing.cellId,
    previousZ: standing.z,
    lastPath: [],
    tickPath: [standing.cellId],
  };
  const separation = executePrimitiveAction(
    harvested,
    actor,
    {
      kind: 'act',
      operation: 'separate',
      targets: [{
        kind: 'voxel',
        position: { x: cellX(berryCell), y: cellY(berryCell), z: topZ(harvested.world.grid, berryCell) },
      }],
    },
    1,
    0,
    { cause: 'intent', actionTick: 1 },
  );
  assert.equal(separation.status, 'completed', '人物应能真实采集结果灌木');
  assert.deepEqual(
    separation.diff.outputs.map(({ materialId, quantity }) => ({ materialId, quantity })),
    [
      { materialId: Material.Food, quantity: 3 },
      { materialId: Material.Seed, quantity: 1 },
    ],
    'Food/Seed 必须来自结果灌木的真实 separate 后果',
  );
  const foodDrop = harvested.world.drops.find((drop) => drop.materialId === Material.Food && drop.sourceEventIds.includes(separation.id));
  const seedDrop = harvested.world.drops.find((drop) => drop.materialId === Material.Seed && drop.sourceEventIds.includes(separation.id));
  assert.equal(foodDrop?.quantity, 3);
  assert.equal(seedDrop?.quantity, 1);
  assert.equal(foodDrop?.cellId, actor.position.cellId);
  assert.equal(foodDrop?.z, actor.position.z);

  const foodBeforePickup = actor.inventory
    .filter((stack) => stack.materialId === Material.Food)
    .reduce((sum, stack) => sum + stack.quantity, 0);
  const pickup = executePrimitiveAction(
    harvested,
    actor,
    {
      kind: 'transfer',
      materialId: Material.Food,
      quantity: 1,
      from: { kind: 'ground', cellId: foodDrop.cellId, z: foodDrop.z },
      to: { kind: 'person', personId: actor.id },
      dropId: foodDrop.id,
    },
    1,
    1,
    { cause: 'intent', actionTick: 2 },
  );
  assert.equal(pickup.status, 'completed', '真实采集产出的 Food drop 必须可以搬运');
  assert.equal(foodDrop.quantity, 2);
  assert.equal(
    actor.inventory.filter((stack) => stack.materialId === Material.Food).reduce((sum, stack) => sum + stack.quantity, 0),
    foodBeforePickup + 1,
  );

  console.log('resource drop causality checks passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
