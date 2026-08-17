import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-biome-generation-test-'));
const bundlePath = path.join(temporaryDirectory, 'biome-generation.mjs');

try {
  const entry = `
    export { BIOME_PROFILES, biomeAt, treeSpeciesAt } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/biome.ts'))};
    export { generateVoxelWorld } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/generator.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { WORLD_CELL_COUNT, WORLD_DEPTH, WORLD_WIDTH, hydrateWorld, voxelAt } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=biome-generation-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    BIOME_PROFILES,
    Material,
    WORLD_CELL_COUNT,
    WORLD_DEPTH,
    WORLD_WIDTH,
    biomeAt,
    generateVoxelWorld,
    hydrateWorld,
    treeSpeciesAt,
    voxelAt,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const seeds = [185, 20_260_815, 20_260_816];
  const biomeSequences = [];
  const speciesSequences = [];

  for (const seed of seeds) {
    const first = generateVoxelWorld(seed);
    const second = generateVoxelWorld(seed);
    assert.equal(first.world.generator.version, 'material-world-v3-biomes');
    assert.equal(first.world.generator.seed, seed);
    assert.equal('biomes' in first.world, false, '群系必须由 seed + 坐标重建，不得持久化大数组');
    assert.deepEqual(Array.from(first.world.voxels), Array.from(second.world.voxels), '同种子体素生成必须确定');
    assert.deepEqual(first.drops, second.drops, '同种子初始掉落物必须确定');

    const biomes = [];
    const treeSpecies = [];
    const treeCells = [];
    const biomeCounts = new Map();
    let matchingNeighborEdges = 0;
    let neighborEdges = 0;
    let outerTaiga = 0;
    let outerCells = 0;
    let centerTaiga = 0;
    let centerCells = 0;
    let completeTrees = 0;
    let matchingSurfaceEdges = 0;
    let surfaceEdges = 0;

    for (let y = 0; y < WORLD_DEPTH; y += 1) {
      for (let x = 0; x < WORLD_WIDTH; x += 1) {
        const biome = biomeAt(seed, x, y);
        biomes.push(biome);
        biomeCounts.set(biome, (biomeCounts.get(biome) ?? 0) + 1);
        if (x > 0) {
          neighborEdges += 1;
          if (biomeAt(seed, x - 1, y) === biome) matchingNeighborEdges += 1;
        }
        if (y > 0) {
          neighborEdges += 1;
          if (biomeAt(seed, x, y - 1) === biome) matchingNeighborEdges += 1;
        }
        if (y < 8 || y >= WORLD_DEPTH - 8) {
          outerCells += 1;
          if (biome === 'taiga') outerTaiga += 1;
        }
        if (y >= 21 && y <= 30) {
          centerCells += 1;
          if (biome === 'taiga') centerTaiga += 1;
        }

        assert.notEqual(voxelAt(first.world, x, y, 4), Material.Air, '所有初始列的地平面必须保持在 z=4');
        const planeMaterial = voxelAt(first.world, x, y, 4);
        if (planeMaterial === Material.Water) {
          assert.equal(voxelAt(first.world, x, y, 5), Material.Air, '河流水格上方不得长出树干');
          assert.equal(voxelAt(first.world, x, y, 6), Material.Air, '河流水格上方不得长出树冠');
        }
        const isBareSurface = planeMaterial === Material.Grass
          || planeMaterial === Material.RichSoil
          || planeMaterial === Material.Sand;
        if (x > 0 && isBareSurface) {
          const westMaterial = voxelAt(first.world, x - 1, y, 4);
          if (westMaterial === Material.Grass || westMaterial === Material.RichSoil || westMaterial === Material.Sand) {
            surfaceEdges += 1;
            if (westMaterial === planeMaterial) matchingSurfaceEdges += 1;
          }
        }
        const isTree = voxelAt(first.world, x, y, 5) === Material.Wood
          && voxelAt(first.world, x, y, 6) === Material.Leaves;
        if (isTree) {
          completeTrees += 1;
          treeCells.push([x, y]);
          const species = treeSpeciesAt(seed, x, y);
          treeSpecies.push(species);
          assert.ok(
            BIOME_PROFILES[biome].treeSpecies.some((candidate) => candidate.key === species),
            `树种 ${species} 必须属于群系 ${biome} 的视觉白名单`,
          );
        }
      }
    }

    assert.equal(biomes.length, WORLD_CELL_COUNT);
    assert.deepEqual(
      biomes,
      Array.from({ length: WORLD_CELL_COUNT }, (_, cellId) => biomeAt(
        seed,
        cellId % WORLD_WIDTH,
        Math.floor(cellId / WORLD_WIDTH),
      )),
      '群系纯函数必须确定',
    );
    assert.ok(biomeCounts.size >= 3, `种子 ${seed} 至少应生成 3 个群系`);
    assert.ok(
      [...biomeCounts.values()].filter((count) => count >= 32).length >= 3,
      `种子 ${seed} 至少应有 3 个成片群系`,
    );
    assert.ok(matchingNeighborEdges / neighborEdges > 0.84, `种子 ${seed} 的群系应形成连续区域而不是逐格噪声`);
    assert.ok(matchingSurfaceEdges / surfaceEdges > 0.68, `种子 ${seed} 的裸露地表应形成连续斑块`);
    assert.ok(outerTaiga / outerCells > centerTaiga / centerCells, `种子 ${seed} 的寒带应呈纬度趋势`);
    assert.ok(completeTrees > 150, `种子 ${seed} 应保留足够的权威 Wood+Leaves 树木`);
    assert.ok(completeTrees < WORLD_CELL_COUNT * 0.13, `种子 ${seed} 的树木密度应控制在 13% 以下`);
    assert.ok(new Set(treeSpecies).size >= 3, `种子 ${seed} 的真实树格至少应投影 3 种树种`);
    assert.deepEqual(
      treeSpecies,
      treeCells.map(([x, y]) => treeSpeciesAt(seed, x, y)),
      '树种视觉投影必须确定',
    );

    const forbiddenDrops = first.drops.filter((drop) => (
      drop.materialId === Material.Food
      || drop.materialId === Material.Seed
      || drop.materialId === Material.Fiber
    ));
    assert.equal(forbiddenDrops.length, 0, '自然生成不得预创建 Food/Seed/Fiber');
    const woodDrops = first.drops.filter((drop) => drop.materialId === Material.Wood);
    assert.equal(woodDrops.length, 1, '完整树旁不得预创建 Wood，只保留一份 starter Wood');
    assert.ok(woodDrops[0].id.startsWith(`starter-${Material.Wood}-`));
    assert.ok(first.drops.some((drop) => drop.materialId === Material.Stone), '开局必须保留可达 Stone');

    const spawnCenter = first.spawnCells[0];
    const spawnX = spawnCenter % WORLD_WIDTH;
    const spawnY = Math.floor(spawnCenter / WORLD_WIDTH);
    const clearingCells = [];
    for (let y = 0; y < WORLD_DEPTH; y += 1) {
      for (let x = 0; x < WORLD_WIDTH; x += 1) {
        if (Math.abs(x - spawnX) + Math.abs(y - spawnY) <= 6) clearingCells.push(y * WORLD_WIDTH + x);
      }
    }
    for (const cellId of clearingCells) {
      const x = cellId % WORLD_WIDTH;
      const y = Math.floor(cellId / WORLD_WIDTH);
      assert.notEqual(voxelAt(first.world, x, y, 4), Material.BerryBush, '出生开阔区不得生成结果灌木');
      assert.notEqual(voxelAt(first.world, x, y, 4), Material.Shrub, '出生开阔区不得生成灌木');
      assert.notEqual(voxelAt(first.world, x, y, 5), Material.Wood, '出生开阔区不得生成树干');
      assert.notEqual(voxelAt(first.world, x, y, 6), Material.Leaves, '出生开阔区不得生成树冠');
    }
    assert.ok(
      clearingCells.some((cellId) => voxelAt(first.world, cellId % WORLD_WIDTH, Math.floor(cellId / WORLD_WIDTH), 4) === Material.WetSoil),
      '清理出生区植被时必须保留河岸 WetSoil',
    );
    assert.ok(
      first.drops.filter((drop) => clearingCells.includes(drop.cellId)).every((drop) => drop.id.startsWith('starter-')),
      '出生开阔区只允许 starter 掉落物，不允许随机石滑入',
    );
    assert.ok(
      first.drops.some((drop) => clearingCells.includes(drop.cellId) && drop.id.startsWith(`starter-${Material.Wood}-`)),
      '出生开阔区必须保留 starter Wood',
    );
    assert.ok(
      first.drops.some((drop) => clearingCells.includes(drop.cellId) && drop.id.startsWith(`starter-${Material.Stone}-`)),
      '出生开阔区必须保留 starter Stone',
    );

    const oldV1 = hydrateWorld({ ...first.world, generator: { version: 'material-world-v1', seed } });
    const oldV2 = hydrateWorld({ ...first.world, generator: { version: 'material-world-v2-flat', seed } });
    assert.equal(oldV1.generator.version, 'material-world-v1');
    assert.equal(oldV2.generator.version, 'material-world-v2-flat');
    assert.equal(biomeAt(oldV1.generator.seed, 17, 19), biomeAt(seed, 17, 19), '旧存档应能由 seed 重建群系');

    biomeSequences.push(biomes.join(','));
    speciesSequences.push(treeSpecies.join(','));
  }

  assert.equal(new Set(biomeSequences).size, seeds.length, '不同种子的群系序列不应完全相同');
  assert.equal(new Set(speciesSequences).size, seeds.length, '不同种子的树种序列不应完全相同');
  assert.ok(new Set(Object.values(BIOME_PROFILES).map((profile) => profile.treeDensity)).size > 1, '群系树木密度必须有差异');
  assert.ok(new Set(Object.values(BIOME_PROFILES).map((profile) => profile.berryDensity)).size > 1, '群系结果灌木密度必须有差异');

  console.log('biome generation checks passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
