import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-road-movement-'));
const bundlePath = path.join(temporaryDirectory, 'road-movement.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export {
      cellId,
      setVoxel,
      standingPathMovementTicks,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=road-movement-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    cellId,
    createInitialState,
    executePrimitiveAction,
    setVoxel,
    standingPathMovementTicks,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  function movementFixture(supportMaterials, seed = 20260823) {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
    const actor = state.people[0];
    const cells = supportMaterials.map((_, index) => cellId(20 + index, 20));
    for (let index = 0; index < cells.length; index += 1) {
      const x = 20 + index;
      for (let z = 0; z < state.world.grid.levels; z += 1) {
        setVoxel(state.world.grid, x, 20, z, z === 0 ? supportMaterials[index] : Material.Air);
      }
    }
    actor.position = {
      ...actor.position,
      cellId: cells[0],
      z: 1,
      previousCellId: cells[0],
      previousZ: 1,
      lastPath: [cells[0]],
      tickPath: [cells[0]],
    };
    actor.body = { health: 90, hydration: 90, nutrition: 90 };
    actor.conditions = [];
    const before = { ...actor.body };
    const fact = executePrimitiveAction(
      state,
      actor,
      { kind: 'move', toCellId: cells.at(-1), toZ: 1 },
      1,
      1,
      { cause: 'intent', actionTick: 1 },
    );
    return { state, actor, before, cells, fact };
  }

  const road = movementFixture([
    Material.PackedSoil,
    Material.PackedSoil,
    Material.PackedSoil,
    Material.PackedSoil,
  ]);
  assert.deepEqual(road.fact.pathSegment, road.cells.slice(0, 3), '连续道路应在一个规划刻度跨过两条相邻边');
  assert.equal(road.fact.diff.movementCost, 2, '两条道路边应合计消耗 2 点移动预算');
  assert.equal(road.actor.position.cellId, road.cells[2]);
  assert.deepEqual(road.actor.position.lastPath, road.cells.slice(0, 3), '人物局部路径记忆应保留道路上的中间格');
  assert.equal(road.fact.status, 'progressed');

  const ground = movementFixture([
    Material.Soil,
    Material.Soil,
    Material.Soil,
    Material.Soil,
  ]);
  assert.deepEqual(ground.fact.pathSegment, ground.cells.slice(0, 2), '普通地面应在一个规划刻度前进一格');
  assert.equal(ground.fact.diff.movementCost, 2);
  assert.equal(ground.actor.position.cellId, ground.cells[1]);
  assert.equal(ground.before.hydration - ground.actor.body.hydration, road.before.hydration - road.actor.body.hydration, '两格道路与一格平地的水分消耗应相同');
  assert.equal(ground.before.nutrition - ground.actor.body.nutrition, road.before.nutrition - road.actor.body.nutrition, '两格道路与一格平地的营养消耗应相同');

  const mixed = movementFixture([
    Material.PackedSoil,
    Material.PackedSoil,
    Material.Soil,
    Material.Soil,
  ]);
  assert.deepEqual(mixed.fact.pathSegment, mixed.cells.slice(0, 2), '道路接普通地面时应在累计成本超过预算前停止');
  assert.equal(mixed.fact.diff.movementCost, 1);

  const roadPath = road.cells.map((currentCell) => ({ cellId: currentCell, z: 1 }));
  const groundPath = ground.cells.map((currentCell) => ({ cellId: currentCell, z: 1 }));
  // 直接使用夹具世界复核规划估时与执行预算一致。
  assert.equal(standingPathMovementTicks(road.state.world.grid, roadPath), 2, '三条道路边应按两个规划刻度估时');
  assert.equal(standingPathMovementTicks(ground.state.world.grid, groundPath), 3, '三条普通地面边应按三个规划刻度估时');

  for (const seed of [20260815, 20260822]) {
    const seededRoad = movementFixture([Material.PackedSoil, Material.PackedSoil, Material.PackedSoil, Material.PackedSoil], seed);
    const seededGround = movementFixture([Material.Soil, Material.Soil, Material.Soil, Material.Soil], seed);
    assert.equal(seededRoad.fact.pathSegment.length - 1, 2, `种子 ${seed} 的道路应前进两格`);
    assert.equal(seededGround.fact.pathSegment.length - 1, 1, `种子 ${seed} 的普通地面应前进一格`);
    assert.equal(
      seededRoad.before.hydration - seededRoad.actor.body.hydration,
      seededGround.before.hydration - seededGround.actor.body.hydration,
      `种子 ${seed} 的等预算路线应保持相同水分消耗`,
    );
  }

  console.log('road movement tests passed across 3 seeds: road 2 edges/tick, ground 1 edge/tick, mixed route respects budget');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
