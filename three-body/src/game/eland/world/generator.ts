import { MATERIAL_PALETTE, Material, type MaterialId } from '../domain/material';
import {
  WORLD_CELL_COUNT,
  WORLD_DEPTH,
  WORLD_LEVELS,
  WORLD_VOXEL_COUNT,
  WORLD_WIDTH,
  cellId,
  isPassable,
  neighbors4,
  setVoxel,
  surfaceStandingPosition,
  topZ,
  type VoxelWorld,
} from './grid';

export interface GeneratedDrop {
  id: string;
  materialId: MaterialId;
  cellId: number;
  z: number;
  quantity: number;
  sourceEventIds: string[];
  createdAtMonth: number;
}

export function seededFraction(seed: number, key: string): number {
  let value = (Math.trunc(seed) ^ 0x811c9dc5) >>> 0;
  for (let index = 0; index < key.length; index += 1) {
    value ^= key.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  return (value >>> 0) / 0x100000000;
}

function smoothNoise(seed: number, x: number, y: number, scale: number): number {
  const gx = Math.floor(x / scale);
  const gy = Math.floor(y / scale);
  const fx = (x % scale) / scale;
  const fy = (y % scale) / scale;
  const sample = (sx: number, sy: number) => seededFraction(seed, `noise:${sx}:${sy}:${scale}`);
  const a = sample(gx, gy);
  const b = sample(gx + 1, gy);
  const c = sample(gx, gy + 1);
  const d = sample(gx + 1, gy + 1);
  const top = a + (b - a) * fx;
  const bottom = c + (d - c) * fx;
  return top + (bottom - top) * fy;
}

function fillColumn(world: VoxelWorld, x: number, y: number, height: number, surface: MaterialId): void {
  for (let z = 0; z < height - 2; z += 1) setVoxel(world, x, y, z, Material.Stone);
  setVoxel(world, x, y, Math.max(0, height - 2), surface === Material.Sand ? Material.Sand : Material.Soil);
  setVoxel(world, x, y, Math.max(0, height - 1), surface);
}

export function generateVoxelWorld(seed: number): { world: VoxelWorld; drops: GeneratedDrop[]; spawnCells: number[] } {
  const world: VoxelWorld = {
    version: 2,
    width: WORLD_WIDTH,
    depth: WORLD_DEPTH,
    levels: WORLD_LEVELS,
    generator: { version: 'material-world-v1', seed },
    palette: MATERIAL_PALETTE,
    voxels: new Uint16Array(WORLD_VOXEL_COUNT),
  };
  const drops: GeneratedDrop[] = [];
  const heights = new Uint8Array(WORLD_CELL_COUNT);
  for (let y = 0; y < WORLD_DEPTH; y += 1) {
    for (let x = 0; x < WORLD_WIDTH; x += 1) {
      const id = cellId(x, y);
      const broad = smoothNoise(seed + 13, x, y, 13);
      const detail = smoothNoise(seed + 71, x, y, 5);
      const height = Math.max(3, Math.min(8, 3 + Math.floor((broad * 0.7 + detail * 0.3) * 5)));
      heights[id] = height;
      fillColumn(world, x, y, height, detail < 0.13 ? Material.Sand : detail > 0.68 ? Material.RichSoil : Material.Grass);
    }
  }

  let riverX = 10 + Math.floor(seededFraction(seed, 'river-start') * 5);
  let riverAtSpawn = riverX;
  for (let y = 0; y < WORLD_DEPTH; y += 1) {
    const turn = seededFraction(seed, `river-turn:${y}`);
    if (turn < 0.3) riverX -= 1;
    else if (turn > 0.7) riverX += 1;
    riverX = Math.max(5, Math.min(18, riverX));
    if (y === 27) riverAtSpawn = riverX;
    for (let dx = 0; dx < 2; dx += 1) {
      const x = riverX + dx;
      const id = cellId(x, y);
      const surfaceZ = Math.max(2, heights[id] - 1);
      setVoxel(world, x, y, surfaceZ, Material.Sand);
      setVoxel(world, x, y, surfaceZ + 1, Material.Water);
    }
    for (const bankX of [riverX - 1, riverX + 2]) {
      if (bankX < 0 || bankX >= WORLD_WIDTH) continue;
      const id = cellId(bankX, y);
      setVoxel(world, bankX, y, topZ(world, id), Material.WetSoil);
    }
  }

  for (let id = 0; id < WORLD_CELL_COUNT; id += 1) {
    if (!isPassable(world, id)) continue;
    const x = id % WORLD_WIDTH;
    const y = Math.floor(id / WORLD_WIDTH);
    const z = topZ(world, id);
    const forest = smoothNoise(seed + 313, x, y, 9);
    const sample = seededFraction(seed, `life:${id}`);
    if (forest > 0.61 && sample > 0.42 && z + 2 < WORLD_LEVELS) {
      setVoxel(world, x, y, z + 1, Material.Wood);
      setVoxel(world, x, y, z + 2, Material.Leaves);
      if (sample > 0.86) drops.push({ id: `wood-${id}`, materialId: Material.Wood, cellId: id, z: z + 1, quantity: 4, sourceEventIds: [], createdAtMonth: 0 });
    } else if (sample > 0.86) {
      setVoxel(world, x, y, z, Material.BerryBush);
      drops.push({ id: `food-${id}`, materialId: Material.Food, cellId: id, z: z + 1, quantity: 4, sourceEventIds: [], createdAtMonth: 0 });
      drops.push({ id: `seed-${id}`, materialId: Material.Seed, cellId: id, z: z + 1, quantity: 2, sourceEventIds: [], createdAtMonth: 0 });
    } else if (sample > 0.75) {
      setVoxel(world, x, y, z, Material.Shrub);
      drops.push({ id: `fiber-${id}`, materialId: Material.Fiber, cellId: id, z: z + 1, quantity: 3, sourceEventIds: [], createdAtMonth: 0 });
    }
    if (seededFraction(seed, `stone:${id}`) > 0.955) drops.push({ id: `stone-${id}`, materialId: Material.Stone, cellId: id, z: z + 1, quantity: 3, sourceEventIds: [], createdAtMonth: 0 });
  }
  // 树干可能在掉落物生成后占据原空气体素；把自然掉落物落到最近的真实可站立位置。
  for (const drop of drops) {
    const landing = surfaceStandingPosition(world, drop.cellId)
      ?? neighbors4(drop.cellId).flatMap((neighbor) => surfaceStandingPosition(world, neighbor) ?? [])[0];
    if (!landing) continue;
    drop.cellId = landing.cellId;
    drop.z = landing.z;
  }

  const centerX = Math.min(WORLD_WIDTH - 3, riverAtSpawn + 4);
  const centerY = 27;
  const spawnCells: number[] = [];
  for (let radius = 0; radius < 18 && spawnCells.length < 16; radius += 1) {
    for (let y = Math.max(0, centerY - radius); y <= Math.min(WORLD_DEPTH - 1, centerY + radius); y += 1) {
      for (let x = Math.max(0, centerX - radius); x <= Math.min(WORLD_WIDTH - 1, centerX + radius); x += 1) {
        if (Math.abs(x - centerX) + Math.abs(y - centerY) !== radius) continue;
        const id = cellId(x, y);
        if (isPassable(world, id)) spawnCells.push(id);
      }
    }
  }
  const nearby = new Set(spawnCells.slice(0, 16));
  const ensureDrop = (materialId: MaterialId, quantity: number): void => {
    if (drops.some((drop) => drop.materialId === materialId && nearby.has(drop.cellId))) return;
    const target = spawnCells.find((id, index) => index > 3 && !drops.some((drop) => drop.cellId === id)) ?? spawnCells[0];
    drops.push({ id: `starter-${materialId}-${target}`, materialId, cellId: target, z: topZ(world, target) + 1, quantity, sourceEventIds: [], createdAtMonth: 0 });
  };
  ensureDrop(Material.Food, 12);
  ensureDrop(Material.Wood, 12);
  ensureDrop(Material.Seed, 6);
  ensureDrop(Material.Fiber, 6);
  ensureDrop(Material.Stone, 4);
  return { world, drops, spawnCells };
}
