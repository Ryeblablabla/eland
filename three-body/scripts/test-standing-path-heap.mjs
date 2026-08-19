import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-standing-path-heap-test-'));
const bundlePath = path.join(temporaryDirectory, 'standing-path-heap.mjs');

try {
  const entry = `
    export { MATERIAL_PALETTE, Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { generateVoxelWorld } from ${JSON.stringify(path.resolve('src/game/eland/world/generator.ts'))};
    export {
      WORLD_CELL_COUNT, WORLD_DEPTH, WORLD_LEVELS, WORLD_VOXEL_COUNT, WORLD_WIDTH,
      cellId, cellX, cellY, findStandingPath, hydrateWorld, isStandingPosition,
      neighbors4, sameStandingPosition, setVoxel, standingMovementCost, standingPositions,
      voxelIndex, voxelWorldChangedCellsSince, voxelWorldRevision,
    } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=standing-path-heap-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    MATERIAL_PALETTE, Material,
    WORLD_CELL_COUNT, WORLD_DEPTH, WORLD_LEVELS, WORLD_VOXEL_COUNT, WORLD_WIDTH,
    cellId, cellX, cellY, findStandingPath, generateVoxelWorld, hydrateWorld,
    isStandingPosition, neighbors4, sameStandingPosition, setVoxel,
    standingMovementCost, standingPositions, voxelIndex,
    voxelWorldChangedCellsSince, voxelWorldRevision,
  } = api;

  // Frozen copy of the former Set-based implementation. This is intentionally kept
  // in the regression test so heap ordering changes must prove exact path parity.
  const standingIndex = (position) => position.z * WORLD_CELL_COUNT + position.cellId;
  const positionFromStandingIndex = (index) => ({
    cellId: index % WORLD_CELL_COUNT,
    z: Math.floor(index / WORLD_CELL_COUNT),
  });
  const standingHeuristic = (position, goals) => goals.reduce((best, goal) => Math.min(
    best,
    Math.abs(cellX(position.cellId) - cellX(goal.cellId))
      + Math.abs(cellY(position.cellId) - cellY(goal.cellId))
      + Math.abs(position.z - goal.z),
  ), Number.POSITIVE_INFINITY);

  function referenceFindStandingPath(world, start, goal) {
    if (!isStandingPosition(world, start)) return [];
    const goals = standingPositions(world, goal.cellId)
      .filter((position) => goal.z === undefined || position.z === goal.z);
    if (!goals.length) return [];
    if (goals.some((candidate) => sameStandingPosition(candidate, start))) return [{ ...start }];
    const goalIndexes = new Set(goals.map(standingIndex));
    const startIndex = standingIndex(start);
    const open = new Set([startIndex]);
    const cameFrom = new Int32Array(WORLD_VOXEL_COUNT).fill(-1);
    const gScore = new Float64Array(WORLD_VOXEL_COUNT).fill(Number.POSITIVE_INFINITY);
    const fScore = new Float64Array(WORLD_VOXEL_COUNT).fill(Number.POSITIVE_INFINITY);
    gScore[startIndex] = 0;
    fScore[startIndex] = standingHeuristic(start, goals);
    while (open.size) {
      let currentIndex = -1;
      let best = Number.POSITIVE_INFINITY;
      for (const candidate of open) {
        const score = fScore[candidate];
        if (score < best || (score === best && (currentIndex < 0 || candidate < currentIndex))) {
          currentIndex = candidate;
          best = score;
        }
      }
      if (goalIndexes.has(currentIndex)) {
        const result = [positionFromStandingIndex(currentIndex)];
        while (cameFrom[currentIndex] >= 0) {
          currentIndex = cameFrom[currentIndex];
          result.push(positionFromStandingIndex(currentIndex));
        }
        return result.reverse();
      }
      open.delete(currentIndex);
      const current = positionFromStandingIndex(currentIndex);
      for (const nextCell of neighbors4(current.cellId)) {
        for (const next of standingPositions(world, nextCell)) {
          if (Math.abs(next.z - current.z) > 1) continue;
          const nextIndex = standingIndex(next);
          const tentative = gScore[currentIndex] + standingMovementCost(world, current, next);
          if (tentative >= gScore[nextIndex]) continue;
          cameFrom[nextIndex] = currentIndex;
          gScore[nextIndex] = tentative;
          fScore[nextIndex] = tentative + standingHeuristic(next, goals);
          open.add(nextIndex);
        }
      }
    }
    return [];
  }

  function assertPathParity(world, start, goal, label) {
    const expected = referenceFindStandingPath(world, start, goal);
    const actual = findStandingPath(world, start, goal);
    assert.deepEqual(actual, expected, label);
    assert.deepEqual(findStandingPath(world, start, goal), expected, `${label}（缓存命中）`);
    return actual;
  }

  function makeLayeredWorld() {
    const world = {
      version: 2,
      width: WORLD_WIDTH,
      depth: WORLD_DEPTH,
      levels: WORLD_LEVELS,
      generator: { version: 'material-world-v2-flat', seed: 20260820 },
      palette: MATERIAL_PALETTE,
      voxels: new Uint16Array(WORLD_VOXEL_COUNT),
    };
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 14; x += 1) {
        world.voxels[voxelIndex(x, y, 0)] = (x + y) % 4 === 0
          ? Material.PackedSoil
          : Material.Grass;
      }
    }
    for (let y = 2; y <= 7; y += 1) {
      for (let x = 4; x <= 9; x += 1) world.voxels[voxelIndex(x, y, 1)] = Material.Soil;
    }
    for (let y = 4; y <= 5; y += 1) {
      for (let x = 6; x <= 7; x += 1) world.voxels[voxelIndex(x, y, 2)] = Material.Stone;
    }
    for (let y = 1; y <= 8; y += 1) {
      if (y !== 5) world.voxels[voxelIndex(11, y, 0)] = Material.Water;
    }
    return world;
  }

  const layeredWorld = makeLayeredWorld();
  const layeredCases = [
    [{ cellId: cellId(1, 1), z: 1 }, { cellId: cellId(12, 8) }],
    [{ cellId: cellId(3, 3), z: 1 }, { cellId: cellId(8, 6), z: 2 }],
    [{ cellId: cellId(5, 3), z: 2 }, { cellId: cellId(7, 4), z: 3 }],
    [{ cellId: cellId(7, 4), z: 3 }, { cellId: cellId(2, 8) }],
    [{ cellId: cellId(12, 2), z: 1 }, { cellId: cellId(2, 2) }],
  ];
  layeredCases.forEach(([start, goal], index) => {
    assertPathParity(layeredWorld, start, goal, `分层地形路径 ${index + 1} 必须与旧算法逐项一致`);
  });
  assertPathParity(
    layeredWorld,
    { cellId: cellId(1, 1), z: 0 },
    { cellId: cellId(2, 2) },
    '非法起点必须继续返回空路径',
  );
  assertPathParity(
    layeredWorld,
    { cellId: cellId(1, 1), z: 1 },
    { cellId: cellId(30, 30) },
    '没有站立位的终点必须继续返回空路径',
  );

  let generatedCaseCount = 0;
  for (const seed of [185, 815]) {
    const { world } = generateVoxelWorld(seed);
    const positions = Array.from({ length: WORLD_CELL_COUNT }, (_, id) => standingPositions(world, id)).flat();
    for (let sample = 0; sample < 12; sample += 1) {
      const start = positions[(sample * 211 + seed) % positions.length];
      const target = positions[(sample * 389 + seed * 3 + 97) % positions.length];
      const goal = sample % 2 === 0 ? { cellId: target.cellId, z: target.z } : { cellId: target.cellId };
      assertPathParity(world, start, goal, `生成世界 seed=${seed} sample=${sample}`);
      generatedCaseCount += 1;
    }
  }

  const cacheWorld = makeLayeredWorld();
  const cacheStart = { cellId: cellId(1, 1), z: 1 };
  const cacheGoal = { cellId: cellId(3, 1), z: 1 };
  const beforeMutation = assertPathParity(cacheWorld, cacheStart, cacheGoal, '变更前直线路径');
  assert.deepEqual(beforeMutation.map((position) => position.cellId), [
    cellId(1, 1), cellId(2, 1), cellId(3, 1),
  ]);
  assert.equal(voxelWorldRevision(cacheWorld), 0, '直接载入的新 world 初始 revision 应为 0');
  setVoxel(cacheWorld, 2, 1, 0, Material.Water);
  assert.equal(voxelWorldRevision(cacheWorld), 1, '真实体素写入应推进 revision');
  const afterMutation = assertPathParity(cacheWorld, cacheStart, cacheGoal, 'setVoxel 后必须清除旧路径缓存');
  assert.notDeepEqual(afterMutation, beforeMutation, '阻断直线后不能继续返回旧缓存路径');
  setVoxel(cacheWorld, 2, 1, 0, Material.Water);
  assert.equal(voxelWorldRevision(cacheWorld), 1, '写入相同材质不能伪造新 revision');
  const nextChangedCell = cellId(13, 9);
  setVoxel(cacheWorld, 13, 9, 0, Material.Water);
  assert.equal(voxelWorldRevision(cacheWorld), 2);
  assert.deepEqual(
    voxelWorldChangedCellsSince(cacheWorld, 1),
    [nextChangedCell],
    '列 revision 应只报告基线后实际变化的列',
  );
  assert.equal(voxelWorldChangedCellsSince(cacheWorld, 0).length, WORLD_CELL_COUNT);
  const hydrated = hydrateWorld(cacheWorld);
  assert.equal(voxelWorldRevision(hydrated), 0, 'hydrate 后的新 world identity 应从 revision 0 开始');
  assert.equal(
    voxelWorldChangedCellsSince(hydrated, 2).length,
    WORLD_CELL_COUNT,
    '不能把旧 world 的 revision 错用于新 identity',
  );

  console.log(`standing path heap regression passed (${layeredCases.length + 2 + generatedCaseCount + 2} parity cases)`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
