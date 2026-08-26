import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-mechanical-water-revisit-'));
const bundlePath = path.join(temporaryDirectory, 'mechanical-water-revisit.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export { buildWaterCurrentObservationOptions } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/mechanical-power-options.ts'))};
    export { MECHANICAL_POWER_WORLD_VERSION } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/mechanical-power.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { cellId, cellX, cellY, cellsInRadius, setVoxel } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=mechanical-water-revisit-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    MECHANICAL_POWER_WORLD_VERSION,
    Material,
    buildWaterCurrentObservationOptions,
    cellId,
    cellX,
    cellY,
    cellsInRadius,
    createInitialState,
    setVoxel,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  function createFixture() {
    const state = createInitialState(9917, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
    const person = state.people[0];
    assert.ok(person, '定向测试需要至少一名人物');
    const origin = cellId(42, 30);
    for (const localCell of cellsInRadius(origin, 18)) {
      for (let z = 0; z < state.world.grid.levels; z += 1) {
        setVoxel(state.world.grid, cellX(localCell), cellY(localCell), z,
          z === 0 ? Material.PackedSoil : Material.Air);
      }
    }
    state.people = [person];
    state.projects = [];
    state.world.drops = [];
    person.position = {
      cellId: origin,
      z: 1,
      previousCellId: origin,
      previousZ: 1,
      lastPath: [],
      tickPath: [origin],
    };
    person.conditions = [];
    person.knowledge = [];

    const firstWater = { x: cellX(origin), y: cellY(origin) + 10, z: 1 };
    const secondWater = { x: firstWater.x, y: firstWater.y + 1, z: 1 };
    setVoxel(state.world.grid, firstWater.x, firstWater.y, firstWater.z, Material.Water);
    setVoxel(state.world.grid, secondWater.x, secondWater.y, secondWater.z, Material.Water);
    state.world.mechanicalPower = {
      version: MECHANICAL_POWER_WORLD_VERSION,
      sources: [{
        id: 'water-current:revisit-fixture',
        kind: 'water-current-segment',
        from: { ...firstWater },
        to: { ...secondWater },
        direction: { dx: 0, dy: 1, dz: 0 },
        capacity: 1,
        upstreamSegmentIds: [],
        requiredWaterVoxels: [{ ...firstWater }, { ...secondWater }],
        sourceKeys: ['world-current:revisit-fixture'],
      }],
      networks: [],
    };

    const millLabor = {
      id: 'action:fixture-mill-labor',
      kind: 'action',
      actionTick: 1,
      atMonth: 2,
      orderInMonth: 1,
      cellId: origin,
      who: person.id,
      cause: 'intent',
      action: { kind: 'act', operation: 'separate', targets: [] },
      fromCellId: origin,
      toCellId: origin,
      fromZ: 1,
      toZ: 1,
      pathSegment: [],
      status: 'completed',
      result: '本人曾用磨坊处理成熟作物',
      diff: {
        sourceMaterialId: Material.CropMature,
        facilityMaterialId: Material.Mill,
      },
    };
    state.world.past = [millLabor];
    person.knownPlaces = [{
      id: `place:${Material.Water}:${firstWater.x}:${firstWater.y}:${firstWater.z}`,
      materialId: Material.Water,
      position: { ...firstWater },
      learnedAtMonth: 1,
      lastConfirmedAtMonth: 1,
      sourceEventIds: ['action:fixture-found-water'],
    }];
    return { state, person, origin, firstWater, millLabor };
  }

  {
    const { state, person, origin, millLabor } = createFixture();
    state.world.mechanicalPower.sources = [];
    const options = buildWaterCurrentObservationOptions(state, person, cellsInRadius(origin, 4));
    assert.equal(options.length, 1, '磨坊劳动者应只得到一条确定性的个人水地点返访路线');
    const revisit = options[0];
    assert.equal(revisit.nextAction.kind, 'move', '当前看不见真实水流时只能返访，不能直接观察或获得机械知识');
    assert.notEqual(revisit.nextAction.toCellId, person.position.cellId, '返访不得生成当前位置零移动');
    assert.ok(revisit.sourceFactIds.includes(millLabor.id), '返访必须引用本人的真实磨坊劳动事实');
    assert.ok(revisit.sourceFactIds.includes('action:fixture-found-water'), '返访必须引用本人水地点记忆的来源事实');
  }

  {
    const { state, person, firstWater } = createFixture();
    state.world.mechanicalPower.sources = [];
    const bankCell = cellId(firstWater.x + 1, firstWater.y);
    person.position = {
      cellId: bankCell,
      z: 1,
      previousCellId: bankCell,
      previousZ: 1,
      lastPath: [],
      tickPath: [bankCell],
    };
    assert.deepEqual(
      buildWaterCurrentObservationOptions(state, person, cellsInRadius(bankCell, 4)),
      [],
      '到达只有静态水的记忆地点后不得零移动重试，也不得把水记忆冒充 current',
    );
  }

  {
    const { state, person, origin } = createFixture();
    state.world.past = [];
    assert.deepEqual(
      buildWaterCurrentObservationOptions(state, person, cellsInRadius(origin, 4)),
      [],
      '没有本人磨坊劳动事实时，水地点记忆不得产生动力调查',
    );
  }

  {
    const { state, person, origin } = createFixture();
    person.knownPlaces = [];
    assert.deepEqual(
      buildWaterCurrentObservationOptions(state, person, cellsInRadius(origin, 4)),
      [],
      '没有本人来源化水地点记忆时，不得从全图机械水流反向选路',
    );
  }

  {
    const { state, person, firstWater } = createFixture();
    const bankCell = cellId(firstWater.x + 1, firstWater.y);
    person.position = {
      cellId: bankCell,
      z: 1,
      previousCellId: bankCell,
      previousZ: 1,
      lastPath: [],
      tickPath: [bankCell],
    };
    const options = buildWaterCurrentObservationOptions(state, person, cellsInRadius(bankCell, 4));
    assert.equal(options.length, 1, '到达真实水流附近后应保留既有的现场观察选项');
    assert.equal(options[0].nextAction.kind, 'attend', '真实可见 water current 必须优先于返访移动');
    assert.equal(options[0].nextAction.waterCurrentSegmentId, 'water-current:revisit-fixture');
  }

  console.log('mechanical water revisit test passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
