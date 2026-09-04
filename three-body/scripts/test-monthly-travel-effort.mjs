import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-monthly-travel-'));
const gridBundlePath = path.join(temporaryDirectory, 'grid.mjs');
const calendarBundlePath = path.join(temporaryDirectory, 'calendar.mjs');
const materialBundlePath = path.join(temporaryDirectory, 'material.mjs');

try {
  for (const [entry, output] of [
    ['src/game/eland/world/grid.ts', gridBundlePath],
    ['src/game/eland/domain/calendar.ts', calendarBundlePath],
    ['src/game/eland/domain/material.ts', materialBundlePath],
  ]) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
    ], { stdio: 'pipe' });
  }

  const grid = await import(`${pathToFileURL(gridBundlePath).href}?test=${Date.now()}`);
  const calendar = await import(`${pathToFileURL(calendarBundlePath).href}?test=${Date.now()}`);
  const { MATERIAL_PALETTE, Material } = await import(`${pathToFileURL(materialBundlePath).href}?test=${Date.now()}`);
  const voxels = new Uint16Array(grid.WORLD_VOXEL_COUNT);
  for (let id = 0; id < grid.WORLD_CELL_COUNT; id += 1) voxels[id] = Material.Soil;
  const world = {
    version: 2,
    width: grid.WORLD_WIDTH,
    depth: grid.WORLD_DEPTH,
    levels: grid.WORLD_LEVELS,
    generator: { version: 'material-world-v4-regional-geology', seed: 374 },
    palette: MATERIAL_PALETTE,
    voxels,
  };

  const localPath = Array.from({ length: 31 }, (_, x) => ({
    cellId: grid.cellId(x, 1),
    z: 1,
  }));
  const localSegment = grid.standingPathSegmentForEffort(world, localPath);
  const localEstimate = grid.standingPathTravelEstimate(world, localPath);
  assert.equal(localSegment.length - 1, 4, '一个移动片段应覆盖连续短途，而不是只走一个相邻格');
  assert.deepEqual(localSegment, localPath.slice(0, localSegment.length), '移动片段必须保留逐格连续路径证据');
  assert.deepEqual(localEstimate, {
    movementEffort: 60,
    workEffort: 60,
    episodes: 8,
    months: 1,
  }, '三十格普通地面旅行应在同一个人物月内完成');

  const expeditionPath = [
    ...Array.from({ length: 84 }, (_, x) => ({ cellId: grid.cellId(x, 2), z: 1 })),
    ...Array.from({ length: 47 }, (_, offset) => ({ cellId: grid.cellId(83 - offset, 3), z: 1 })),
  ];
  const expeditionEstimate = grid.standingPathTravelEstimate(world, expeditionPath);
  assert.equal(expeditionEstimate.movementEffort, 260);
  assert.equal(expeditionEstimate.months, 3, '横跨地图的真实远征仍应自然跨月');

  const healthyCapacity = calendar.physicalWorkCapacityMultiplier({
    locomotion: 60, hydration: 80, nutrition: 80, conditions: [],
  });
  const impairedCapacity = calendar.physicalWorkCapacityMultiplier({
    locomotion: 60,
    hydration: 8,
    nutrition: 25,
    conditions: [{ kind: 'wound', stage: 2 }],
  });
  assert.ok(impairedCapacity < healthyCapacity, '脱水、饥饿和伤势必须降低真实旅行吞吐量');
  assert.ok(
    grid.standingPathTravelEstimate(world, localPath, impairedCapacity).months
      > grid.standingPathTravelEstimate(world, localPath, healthyCapacity).months,
    '相同路线的跨月估算必须反映人物当下身体能力',
  );

  console.log('monthly travel effort tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
