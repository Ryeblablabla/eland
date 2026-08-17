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
  surfaceMaterial,
  surfaceStandingPosition,
  topZ,
  type VoxelWorld,
} from './grid';
import { biomeProfileAt } from './biome';

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

const INITIAL_TERRAIN_HEIGHT = 5;
const SPAWN_CLEARING_RADIUS = 6;

export function generateVoxelWorld(seed: number): { world: VoxelWorld; drops: GeneratedDrop[]; spawnCells: number[] } {
  const world: VoxelWorld = {
    version: 2,
    width: WORLD_WIDTH,
    depth: WORLD_DEPTH,
    levels: WORLD_LEVELS,
    generator: { version: 'material-world-v4-regional-geology', seed },
    palette: MATERIAL_PALETTE,
    voxels: new Uint16Array(WORLD_VOXEL_COUNT),
  };
  const drops: GeneratedDrop[] = [];
  for (let y = 0; y < WORLD_DEPTH; y += 1) {
    for (let x = 0; x < WORLD_WIDTH; x += 1) {
      const profile = biomeProfileAt(seed, x, y);
      const surfaceSample = smoothNoise(seed + 71, x, y, 5) * 0.86
        + seededFraction(seed + 71, `surface-detail:${x}:${y}`) * 0.14;
      const surface = surfaceSample < profile.sandChance
        ? Material.Sand
        : surfaceSample < profile.sandChance + profile.richSoilChance
          ? Material.RichSoil
          : Material.Grass;
      fillColumn(
        world,
        x,
        y,
        INITIAL_TERRAIN_HEIGHT,
        surface,
      );
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
      // 河床下切一层，但水面与初始陆地齐平，避免整条河凸成蓝色墙带。
      setVoxel(world, x, y, INITIAL_TERRAIN_HEIGHT - 2, Material.Sand);
      setVoxel(world, x, y, INITIAL_TERRAIN_HEIGHT - 1, Material.Water);
    }
    for (const bankX of [riverX - 1, riverX + 2]) {
      if (bankX < 0 || bankX >= WORLD_WIDTH) continue;
      const id = cellId(bankX, y);
      setVoxel(world, bankX, y, topZ(world, id), Material.WetSoil);
    }
  }

  const centerX = Math.min(WORLD_WIDTH - 3, riverAtSpawn + 4);
  const centerY = 27;
  const inSpawnClearing = (id: number): boolean => {
    const x = id % WORLD_WIDTH;
    const y = Math.floor(id / WORLD_WIDTH);
    return Math.abs(x - centerX) + Math.abs(y - centerY) <= SPAWN_CLEARING_RADIUS;
  };

  for (let id = 0; id < WORLD_CELL_COUNT; id += 1) {
    if (surfaceMaterial(world, id) === Material.Water) continue;
    if (!isPassable(world, id)) continue;
    if (inSpawnClearing(id)) continue;
    const x = id % WORLD_WIDTH;
    const y = Math.floor(id / WORLD_WIDTH);
    const z = topZ(world, id);
    const profile = biomeProfileAt(seed, x, y);
    const forest = smoothNoise(seed + 313, x, y, 9);
    const sample = seededFraction(seed, `life:${id}`);
    const treeChance = Math.min(0.68, profile.treeDensity * (0.68 + forest * 0.64));
    if (sample < treeChance && z + 2 < WORLD_LEVELS) {
      setVoxel(world, x, y, z + 1, Material.Wood);
      setVoxel(world, x, y, z + 2, Material.Leaves);
    } else if (sample < treeChance + profile.berryDensity) {
      setVoxel(world, x, y, z, Material.BerryBush);
    } else if (sample < treeChance + profile.berryDensity + profile.shrubDensity) {
      setVoxel(world, x, y, z, Material.Shrub);
    }
    if (seededFraction(seed, `stone:${id}`) > 0.955) drops.push({ id: `stone-${id}`, materialId: Material.Stone, cellId: id, z: z + 1, quantity: 3, sourceEventIds: [], createdAtMonth: 0 });
    const geology = seededFraction(seed, `geology:${id}`);
    const closeToWater = neighbors4(id).some((neighbor) => surfaceMaterial(world, neighbor) === Material.Water);
    if (closeToWater && geology < 0.07) {
      drops.push({ id: `clay-${id}`, materialId: Material.Clay, cellId: id, z: z + 1, quantity: 2, sourceEventIds: [], createdAtMonth: 0 });
    } else if (geology > 0.985) {
      drops.push({ id: `iron-ore-${id}`, materialId: Material.IronOre, cellId: id, z: z + 1, quantity: 2, sourceEventIds: [], createdAtMonth: 0 });
    } else if (geology > 0.973) {
      drops.push({ id: `copper-ore-${id}`, materialId: Material.CopperOre, cellId: id, z: z + 1, quantity: 2, sourceEventIds: [], createdAtMonth: 0 });
    } else if (geology > 0.967) {
      drops.push({ id: `tin-ore-${id}`, materialId: Material.TinOre, cellId: id, z: z + 1, quantity: 1, sourceEventIds: [], createdAtMonth: 0 });
    }
  }
  // 树干可能在掉落物生成后占据原空气体素；把自然掉落物落到最近的真实可站立位置。
  for (const drop of drops) {
    const landing = [drop.cellId, ...neighbors4(drop.cellId)]
      .filter((candidate) => !inSpawnClearing(candidate))
      .flatMap((candidate) => surfaceStandingPosition(world, candidate) ?? [])
      .at(0);
    if (!landing) continue;
    drop.cellId = landing.cellId;
    drop.z = landing.z;
  }

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
  const ensureRegionalOre = (
    materialId: MaterialId,
    minDistance: number,
    maxDistance: number,
    minimumSites: number,
    quantity: number,
  ): void => {
    const distanceFromSpawn = (id: number) => Math.abs((id % WORLD_WIDTH) - centerX)
      + Math.abs(Math.floor(id / WORLD_WIDTH) - centerY);
    const inBand = drops.filter((drop) => drop.materialId === materialId
      && distanceFromSpawn(drop.cellId) >= minDistance
      && distanceFromSpawn(drop.cellId) <= maxDistance);
    const missingSites = Math.max(0, minimumSites - inBand.length);
    if (!missingSites) return;
    const groundMaterials = new Set<MaterialId>([
      Material.Grass, Material.Soil, Material.WetSoil, Material.RichSoil,
      Material.ExhaustedSoil, Material.PackedSoil, Material.Sand,
    ]);
    const candidates = Array.from({ length: WORLD_CELL_COUNT }, (_, id) => id)
      .filter((id) => distanceFromSpawn(id) >= minDistance
        && distanceFromSpawn(id) <= maxDistance
        && groundMaterials.has(surfaceMaterial(world, id))
        && isPassable(world, id)
        && !drops.some((drop) => drop.cellId === id))
      .map((id) => ({ id, rank: seededFraction(seed, `regional-ore:${materialId}:${id}`) }))
      .sort((left, right) => left.rank - right.rank || left.id - right.id);
    const anchor = candidates[0]?.id;
    if (anchor === undefined) return;
    const anchorX = anchor % WORLD_WIDTH;
    const anchorY = Math.floor(anchor / WORLD_WIDTH);
    const selected = candidates
      .sort((left, right) => {
        const leftDistance = Math.abs((left.id % WORLD_WIDTH) - anchorX)
          + Math.abs(Math.floor(left.id / WORLD_WIDTH) - anchorY);
        const rightDistance = Math.abs((right.id % WORLD_WIDTH) - anchorX)
          + Math.abs(Math.floor(right.id / WORLD_WIDTH) - anchorY);
        return leftDistance - rightDistance || left.rank - right.rank || left.id - right.id;
      })
      .slice(0, missingSites);
    for (const { id } of selected) {
      const standing = surfaceStandingPosition(world, id);
      if (!standing) continue;
      drops.push({
        id: `regional-ore-${materialId}-${id}`,
        materialId,
        cellId: id,
        z: standing.z,
        quantity,
        sourceEventIds: [],
        createdAtMonth: 0,
      });
    }
  };
  // Raw ore, not metal, is regionally guaranteed. Tin remains farther and scarcer,
  // so alloying still needs exploration and transport instead of a starter grant.
  ensureRegionalOre(Material.CopperOre, 7, 16, 3, 4);
  ensureRegionalOre(Material.TinOre, 12, 24, 2, 3);
  const ensureDrop = (materialId: MaterialId, quantity: number): void => {
    if (drops.some((drop) => drop.materialId === materialId && nearby.has(drop.cellId))) return;
    const target = spawnCells.find((id, index) => index > 3 && !drops.some((drop) => drop.cellId === id)) ?? spawnCells[0];
    drops.push({ id: `starter-${materialId}-${target}`, materialId, cellId: target, z: topZ(world, target) + 1, quantity, sourceEventIds: [], createdAtMonth: 0 });
  };
  ensureDrop(Material.Wood, 12);
  ensureDrop(Material.Stone, 4);
  return { world, drops, spawnCells };
}
