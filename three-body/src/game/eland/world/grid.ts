import { MATERIAL_PALETTE, Material, materialDefinition, materialHas, type MaterialId } from '../domain/material';

export const WORLD_WIDTH = 84;
export const WORLD_DEPTH = 52;
export const WORLD_LEVELS = 12;
export const WORLD_CELL_COUNT = WORLD_WIDTH * WORLD_DEPTH;
export const WORLD_VOXEL_COUNT = WORLD_CELL_COUNT * WORLD_LEVELS;

export interface VoxelWorld {
  version: 2;
  width: typeof WORLD_WIDTH;
  depth: typeof WORLD_DEPTH;
  levels: typeof WORLD_LEVELS;
  generator: { version: 'material-world-v1'; seed: number };
  palette: typeof MATERIAL_PALETTE;
  voxels: Uint16Array;
}

export function cellId(x: number, y: number): number {
  return y * WORLD_WIDTH + x;
}

export function cellX(id: number): number {
  return id % WORLD_WIDTH;
}

export function cellY(id: number): number {
  return Math.floor(id / WORLD_WIDTH);
}

export function isCellId(id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < WORLD_CELL_COUNT;
}

export function voxelIndex(x: number, y: number, z: number): number {
  return z * WORLD_CELL_COUNT + cellId(x, y);
}

export function voxelAt(world: VoxelWorld, x: number, y: number, z: number): MaterialId {
  if (x < 0 || x >= world.width || y < 0 || y >= world.depth || z < 0 || z >= world.levels) return Material.Air;
  return world.voxels[voxelIndex(x, y, z)] ?? Material.Air;
}

export function setVoxel(world: VoxelWorld, x: number, y: number, z: number, materialId: MaterialId): void {
  if (x < 0 || x >= world.width || y < 0 || y >= world.depth || z < 0 || z >= world.levels) return;
  world.voxels[voxelIndex(x, y, z)] = materialId;
}

export function topZ(world: VoxelWorld, id: number): number {
  if (!isCellId(id)) return -1;
  const x = cellX(id);
  const y = cellY(id);
  for (let z = world.levels - 1; z >= 0; z -= 1) {
    if (voxelAt(world, x, y, z) !== Material.Air) return z;
  }
  return -1;
}

export function surfaceMaterial(world: VoxelWorld, id: number): MaterialId {
  const z = topZ(world, id);
  return z < 0 ? Material.Air : voxelAt(world, cellX(id), cellY(id), z);
}

export function columnMaterials(world: VoxelWorld, id: number): MaterialId[] {
  if (!isCellId(id)) return [];
  const result: MaterialId[] = [];
  const x = cellX(id);
  const y = cellY(id);
  for (let z = world.levels - 1; z >= 0; z -= 1) {
    const materialId = voxelAt(world, x, y, z);
    if (materialId !== Material.Air) result.push(materialId);
  }
  return result;
}

export function waterDepth(world: VoxelWorld, id: number): number {
  if (!isCellId(id)) return 0;
  const x = cellX(id);
  const y = cellY(id);
  let depth = 0;
  for (let z = world.levels - 1; z >= 0; z -= 1) {
    const materialId = voxelAt(world, x, y, z);
    if (materialId === Material.Air && depth === 0) continue;
    if (materialId !== Material.Water) break;
    depth += 1;
  }
  return depth;
}

export function topPosition(world: VoxelWorld, id: number): { x: number; y: number; z: number } {
  return { x: cellX(id), y: cellY(id), z: Math.max(0, topZ(world, id)) };
}

export function neighbors4(id: number): number[] {
  const x = cellX(id);
  const y = cellY(id);
  const result: number[] = [];
  if (y > 0) result.push(id - WORLD_WIDTH);
  if (x > 0) result.push(id - 1);
  if (x + 1 < WORLD_WIDTH) result.push(id + 1);
  if (y + 1 < WORLD_DEPTH) result.push(id + WORLD_WIDTH);
  return result;
}

export function isPassable(world: VoxelWorld, id: number): boolean {
  if (!isCellId(id)) return false;
  const surface = surfaceMaterial(world, id);
  if (surface === Material.Air || surface === Material.Water || surface === Material.Fire) return false;
  if (surface === Material.Wood || surface === Material.Leaves) return false;
  return materialHas(surface, 'ground') || materialHas(surface, 'plant') || surface === Material.Ice || surface === Material.Plank;
}

export function movementCost(world: VoxelWorld, from: number, to: number): number {
  const climb = Math.max(0, topZ(world, to) - topZ(world, from));
  const surface = surfaceMaterial(world, to);
  const material = materialDefinition(surface);
  const plantPenalty = material.tags.includes('plant') && surface !== Material.Grass ? 1 : 0;
  const roadRelief = surface === Material.PackedSoil || surface === Material.Plank ? 1 : 0;
  return Math.max(1, 2 + climb + plantPenalty - roadRelief);
}

function manhattan(a: number, b: number): number {
  return Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
}

export function findPath(world: VoxelWorld, start: number, goal: number): number[] {
  if (!isPassable(world, start) || !isPassable(world, goal)) return [];
  if (start === goal) return [start];
  const open = new Set<number>([start]);
  const cameFrom = new Int32Array(WORLD_CELL_COUNT).fill(-1);
  const gScore = new Float64Array(WORLD_CELL_COUNT).fill(Number.POSITIVE_INFINITY);
  const fScore = new Float64Array(WORLD_CELL_COUNT).fill(Number.POSITIVE_INFINITY);
  gScore[start] = 0;
  fScore[start] = manhattan(start, goal);
  while (open.size) {
    let current = -1;
    let best = Number.POSITIVE_INFINITY;
    for (const candidate of open) {
      const score = fScore[candidate];
      if (score < best || (score === best && (current < 0 || candidate < current))) {
        current = candidate;
        best = score;
      }
    }
    if (current === goal) {
      const path = [current];
      while (cameFrom[current] >= 0) {
        current = cameFrom[current];
        path.push(current);
      }
      return path.reverse();
    }
    open.delete(current);
    for (const next of neighbors4(current)) {
      if (!isPassable(world, next) || Math.abs(topZ(world, next) - topZ(world, current)) > 1) continue;
      const tentative = gScore[current] + movementCost(world, current, next);
      if (tentative >= gScore[next]) continue;
      cameFrom[next] = current;
      gScore[next] = tentative;
      fScore[next] = tentative + manhattan(next, goal);
      open.add(next);
    }
  }
  return [];
}

export function cellsInRadius(origin: number, radius: number): number[] {
  const ox = cellX(origin);
  const oy = cellY(origin);
  const result: number[] = [];
  for (let y = Math.max(0, oy - radius); y <= Math.min(WORLD_DEPTH - 1, oy + radius); y += 1) {
    for (let x = Math.max(0, ox - radius); x <= Math.min(WORLD_WIDTH - 1, ox + radius); x += 1) {
      if (Math.abs(x - ox) + Math.abs(y - oy) <= radius) result.push(cellId(x, y));
    }
  }
  return result;
}

export function nearestCell(origin: number, candidates: Iterable<number>): number | null {
  let best: number | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const nextDistance = manhattan(origin, candidate);
    if (nextDistance < distance || (nextDistance === distance && (best === null || candidate < best))) {
      best = candidate;
      distance = nextDistance;
    }
  }
  return best;
}

function asVoxels(value: unknown): Uint16Array {
  if (value instanceof Uint16Array) return new Uint16Array(value);
  if (Array.isArray(value)) return new Uint16Array(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const numeric = Object.keys(record)
      .filter((key) => /^\d+$/.test(key))
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => Number(record[key]));
    return new Uint16Array(numeric);
  }
  return new Uint16Array(WORLD_VOXEL_COUNT);
}

export function hydrateWorld(input: VoxelWorld): VoxelWorld {
  const voxels = asVoxels(input.voxels);
  if (voxels.length !== WORLD_VOXEL_COUNT) throw new Error(`体素数量错误：${voxels.length}`);
  return {
    version: 2,
    width: WORLD_WIDTH,
    depth: WORLD_DEPTH,
    levels: WORLD_LEVELS,
    generator: { version: 'material-world-v1', seed: Number(input.generator?.seed ?? 0) },
    palette: MATERIAL_PALETTE,
    voxels,
  };
}

export function copyWorld(input: VoxelWorld): VoxelWorld {
  return hydrateWorld(input);
}
