import { MATERIAL_PALETTE, Material, materialDefinition, materialHas, type MaterialId } from '../domain/material';

export const WORLD_WIDTH = 84;
export const WORLD_DEPTH = 52;
export const WORLD_LEVELS = 12;
export const WORLD_CELL_COUNT = WORLD_WIDTH * WORLD_DEPTH;
export const WORLD_VOXEL_COUNT = WORLD_CELL_COUNT * WORLD_LEVELS;

export type WorldGeneratorVersion = 'material-world-v1' | 'material-world-v2-flat' | 'material-world-v3-biomes' | 'material-world-v4-regional-geology';

export interface VoxelWorld {
  version: 2;
  width: typeof WORLD_WIDTH;
  depth: typeof WORLD_DEPTH;
  levels: typeof WORLD_LEVELS;
  generator: { version: WorldGeneratorVersion; seed: number };
  palette: typeof MATERIAL_PALETTE;
  voxels: Uint16Array;
}

export interface StandingPosition {
  cellId: number;
  /** 双脚所在的空气体素。 */
  z: number;
}

interface SpatialCache {
  standingZByCell: Array<number[] | undefined>;
  paths: Map<string, Int32Array>;
}

interface VoxelWorldRevisionState {
  revision: number;
  cellRevisions: Float64Array;
}

const spatialCaches = new WeakMap<VoxelWorld, SpatialCache>();
const voxelWorldRevisions = new WeakMap<VoxelWorld, VoxelWorldRevisionState>();
// A 50-person planning month can compile several thousand distinct routes.
// Keep the month-local cache from clearing itself midway through compilation.
const MAX_CACHED_PATHS = 8_192;

interface StandingPathScratch {
  generation: number;
  touchedAt: Uint32Array;
  cameFrom: Int32Array;
  gScore: Float64Array;
  fScore: Float64Array;
  heap: Int32Array;
  heapPosition: Int32Array;
  heapSize: number;
}

// Path searches are synchronous, so one module-local workspace can be reused safely.
// Generation stamps make an untouched score behave like Infinity without clearing all
// 52,416 entries before every route compilation.
const standingPathScratch: StandingPathScratch = {
  generation: 0,
  touchedAt: new Uint32Array(WORLD_VOXEL_COUNT),
  cameFrom: new Int32Array(WORLD_VOXEL_COUNT),
  gScore: new Float64Array(WORLD_VOXEL_COUNT),
  fScore: new Float64Array(WORLD_VOXEL_COUNT),
  heap: new Int32Array(WORLD_VOXEL_COUNT),
  heapPosition: new Int32Array(WORLD_VOXEL_COUNT),
  heapSize: 0,
};

function spatialCache(world: VoxelWorld): SpatialCache {
  let cache = spatialCaches.get(world);
  if (!cache) {
    cache = { standingZByCell: new Array(WORLD_CELL_COUNT), paths: new Map() };
    spatialCaches.set(world, cache);
  }
  return cache;
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
  const index = voxelIndex(x, y, z);
  if (world.voxels[index] === materialId) return;
  world.voxels[index] = materialId;
  let revisionState = voxelWorldRevisions.get(world);
  if (!revisionState) {
    revisionState = { revision: 0, cellRevisions: new Float64Array(WORLD_CELL_COUNT) };
    voxelWorldRevisions.set(world, revisionState);
  }
  revisionState.revision += 1;
  revisionState.cellRevisions[cellId(x, y)] = revisionState.revision;
  const cache = spatialCaches.get(world);
  if (cache) {
    cache.standingZByCell[cellId(x, y)] = undefined;
    cache.paths.clear();
  }
}

export function voxelWorldRevision(world: VoxelWorld): number {
  return voxelWorldRevisions.get(world)?.revision ?? 0;
}

export function voxelWorldChangedCellsSince(world: VoxelWorld, revision: number): number[] {
  if (!Number.isFinite(revision) || revision <= 0) {
    return Array.from({ length: WORLD_CELL_COUNT }, (_, id) => id);
  }
  const revisionState = voxelWorldRevisions.get(world);
  // A hydrated/copied world starts a new identity at revision zero. A positive
  // revision from another identity cannot safely be compared with it.
  if (!revisionState) return Array.from({ length: WORLD_CELL_COUNT }, (_, id) => id);
  if (revision >= revisionState.revision) return [];
  const changed: number[] = [];
  for (let id = 0; id < WORLD_CELL_COUNT; id += 1) {
    if (revisionState.cellRevisions[id] > revision) changed.push(id);
  }
  return changed;
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

function supportsStanding(materialId: MaterialId): boolean {
  if (materialId === Material.Air || materialId === Material.Water || materialId === Material.Fire) return false;
  if (materialId === Material.Wood || materialId === Material.Leaves) return false;
  return materialHas(materialId, 'ground') || materialHas(materialId, 'plant') || materialId === Material.Ice || materialId === Material.Plank;
}

export function isStandingPosition(world: VoxelWorld, position: StandingPosition): boolean {
  if (!isCellId(position.cellId) || position.z <= 0 || position.z + 1 >= world.levels) return false;
  const x = cellX(position.cellId);
  const y = cellY(position.cellId);
  return voxelAt(world, x, y, position.z) === Material.Air
    && voxelAt(world, x, y, position.z + 1) === Material.Air
    && supportsStanding(voxelAt(world, x, y, position.z - 1));
}

export function standingPositions(world: VoxelWorld, id: number): StandingPosition[] {
  if (!isCellId(id)) return [];
  const cache = spatialCache(world);
  const cached = cache.standingZByCell[id];
  if (cached) return cached.map((z) => ({ cellId: id, z }));
  const standingZ: number[] = [];
  for (let z = 1; z + 1 < world.levels; z += 1) {
    const position = { cellId: id, z };
    if (isStandingPosition(world, position)) standingZ.push(z);
  }
  cache.standingZByCell[id] = standingZ;
  return standingZ.map((z) => ({ cellId: id, z }));
}

export function surfaceStandingPosition(world: VoxelWorld, id: number): StandingPosition | null {
  return standingPositions(world, id).at(-1) ?? null;
}

export function sameStandingPosition(first: StandingPosition, second: StandingPosition): boolean {
  return first.cellId === second.cellId && first.z === second.z;
}

export function movementCost(world: VoxelWorld, from: number, to: number): number {
  const climb = Math.max(0, topZ(world, to) - topZ(world, from));
  const surface = surfaceMaterial(world, to);
  const material = materialDefinition(surface);
  const plantPenalty = material.tags.includes('plant') && surface !== Material.Grass ? 1 : 0;
  const roadRelief = surface === Material.PackedSoil || surface === Material.Plank ? 1 : 0;
  return Math.max(1, 2 + climb + plantPenalty - roadRelief);
}

export function standingMovementCost(world: VoxelWorld, from: StandingPosition, to: StandingPosition): number {
  const x = cellX(to.cellId);
  const y = cellY(to.cellId);
  const support = materialDefinition(voxelAt(world, x, y, to.z - 1));
  const plantPenalty = support.tags.includes('plant') && support.id !== Material.Grass ? 1 : 0;
  const roadRelief = support.id === Material.PackedSoil || support.id === Material.Plank ? 1 : 0;
  return Math.max(1, 2 + Math.max(0, to.z - from.z) + plantPenalty - roadRelief);
}

/** 普通平地恰好消耗一个刻度；连续低成本路面可以在同一刻度继续前进。 */
export const STANDING_MOVEMENT_BUDGET_PER_TICK = 2 as const;

export function standingPathMovementCost(world: VoxelWorld, path: readonly StandingPosition[]): number {
  let cost = 0;
  for (let index = 1; index < path.length; index += 1) {
    cost += standingMovementCost(world, path[index - 1], path[index]);
  }
  return cost;
}

export function standingPathSegmentForTick(
  world: VoxelWorld,
  path: readonly StandingPosition[],
): StandingPosition[] {
  if (path.length <= 1) return path.map((position) => ({ ...position }));
  const segment = [{ ...path[0] }];
  let spent = 0;
  for (let index = 1; index < path.length; index += 1) {
    const edgeCost = standingMovementCost(world, path[index - 1], path[index]);
    // 高成本地形仍允许人物至少跨过一条相邻边，不能因预算不足永久卡死。
    if (segment.length > 1 && spent + edgeCost > STANDING_MOVEMENT_BUDGET_PER_TICK) break;
    segment.push({ ...path[index] });
    spent += edgeCost;
  }
  return segment;
}

/** 用与执行器相同的预算规则估算整条站立路径需要多少规划刻度。 */
export function standingPathMovementTicks(world: VoxelWorld, path: readonly StandingPosition[]): number {
  let ticks = 0;
  let index = 0;
  while (index < path.length - 1) {
    let spent = 0;
    let moved = false;
    while (index < path.length - 1) {
      const edgeCost = standingMovementCost(world, path[index], path[index + 1]);
      if (moved && spent + edgeCost > STANDING_MOVEMENT_BUDGET_PER_TICK) break;
      spent += edgeCost;
      moved = true;
      index += 1;
    }
    ticks += 1;
  }
  return ticks;
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

function standingIndex(position: StandingPosition): number {
  return position.z * WORLD_CELL_COUNT + position.cellId;
}

function positionFromStandingIndex(index: number): StandingPosition {
  return { cellId: index % WORLD_CELL_COUNT, z: Math.floor(index / WORLD_CELL_COUNT) };
}

function rememberPath(cache: SpatialCache, key: string, path: StandingPosition[]): StandingPosition[] {
  if (cache.paths.size >= MAX_CACHED_PATHS) cache.paths.clear();
  cache.paths.set(key, Int32Array.from(path.map(standingIndex)));
  return path;
}

function standingHeuristic(position: StandingPosition, goals: StandingPosition[]): number {
  return goals.reduce((best, goal) => Math.min(best,
    Math.abs(cellX(position.cellId) - cellX(goal.cellId))
      + Math.abs(cellY(position.cellId) - cellY(goal.cellId))
      + Math.abs(position.z - goal.z)), Number.POSITIVE_INFINITY);
}

function beginStandingPathSearch(): StandingPathScratch {
  const nextGeneration = (standingPathScratch.generation + 1) >>> 0;
  if (nextGeneration === 0) {
    standingPathScratch.touchedAt.fill(0);
    standingPathScratch.generation = 1;
  } else {
    standingPathScratch.generation = nextGeneration;
  }
  standingPathScratch.heapSize = 0;
  return standingPathScratch;
}

function touchStandingPathIndex(scratch: StandingPathScratch, index: number): void {
  if (scratch.touchedAt[index] === scratch.generation) return;
  scratch.touchedAt[index] = scratch.generation;
  scratch.cameFrom[index] = -1;
  scratch.gScore[index] = Number.POSITIVE_INFINITY;
  scratch.fScore[index] = Number.POSITIVE_INFINITY;
  scratch.heapPosition[index] = -1;
}

function standingHeapPrecedes(scratch: StandingPathScratch, firstIndex: number, secondIndex: number): boolean {
  const firstScore = scratch.fScore[firstIndex];
  const secondScore = scratch.fScore[secondIndex];
  return firstScore < secondScore || (firstScore === secondScore && firstIndex < secondIndex);
}

function swapStandingHeapEntries(scratch: StandingPathScratch, firstPosition: number, secondPosition: number): void {
  const firstIndex = scratch.heap[firstPosition];
  const secondIndex = scratch.heap[secondPosition];
  scratch.heap[firstPosition] = secondIndex;
  scratch.heap[secondPosition] = firstIndex;
  scratch.heapPosition[firstIndex] = secondPosition;
  scratch.heapPosition[secondIndex] = firstPosition;
}

function bubbleStandingHeapUp(scratch: StandingPathScratch, initialPosition: number): void {
  let position = initialPosition;
  while (position > 0) {
    const parent = Math.floor((position - 1) / 2);
    if (!standingHeapPrecedes(scratch, scratch.heap[position], scratch.heap[parent])) return;
    swapStandingHeapEntries(scratch, position, parent);
    position = parent;
  }
}

function pushOrDecreaseStandingHeap(scratch: StandingPathScratch, index: number): void {
  const existingPosition = scratch.heapPosition[index];
  if (existingPosition >= 0) {
    bubbleStandingHeapUp(scratch, existingPosition);
    return;
  }
  const position = scratch.heapSize;
  scratch.heapSize += 1;
  scratch.heap[position] = index;
  scratch.heapPosition[index] = position;
  bubbleStandingHeapUp(scratch, position);
}

function popStandingHeap(scratch: StandingPathScratch): number {
  const result = scratch.heap[0];
  scratch.heapSize -= 1;
  scratch.heapPosition[result] = -1;
  if (scratch.heapSize === 0) return result;
  const replacement = scratch.heap[scratch.heapSize];
  scratch.heap[0] = replacement;
  scratch.heapPosition[replacement] = 0;
  let position = 0;
  while (true) {
    const left = position * 2 + 1;
    if (left >= scratch.heapSize) break;
    const right = left + 1;
    let best = left;
    if (right < scratch.heapSize
      && standingHeapPrecedes(scratch, scratch.heap[right], scratch.heap[left])) best = right;
    if (!standingHeapPrecedes(scratch, scratch.heap[best], scratch.heap[position])) break;
    swapStandingHeapEntries(scratch, position, best);
    position = best;
  }
  return result;
}

/**
 * 在真正可容纳身体的空气体素间寻路。人物能沿水平相邻格上下一级，不能穿过屋顶或实心柱。
 */
export function findStandingPath(
  world: VoxelWorld,
  start: StandingPosition,
  goal: { cellId: number; z?: number },
): StandingPosition[] {
  const cache = spatialCache(world);
  const cacheKey = `${start.cellId}:${start.z}>${goal.cellId}:${goal.z ?? '*'}`;
  const cached = cache.paths.get(cacheKey);
  if (cached) return Array.from(cached, positionFromStandingIndex);
  if (!isStandingPosition(world, start)) return rememberPath(cache, cacheKey, []);
  const goals = standingPositions(world, goal.cellId).filter((position) => goal.z === undefined || position.z === goal.z);
  if (!goals.length) return rememberPath(cache, cacheKey, []);
  if (goals.some((candidate) => sameStandingPosition(candidate, start))) return rememberPath(cache, cacheKey, [{ ...start }]);
  const goalIndexes = new Set(goals.map(standingIndex));
  const startIndex = standingIndex(start);
  const scratch = beginStandingPathSearch();
  touchStandingPathIndex(scratch, startIndex);
  scratch.gScore[startIndex] = 0;
  scratch.fScore[startIndex] = standingHeuristic(start, goals);
  pushOrDecreaseStandingHeap(scratch, startIndex);
  while (scratch.heapSize > 0) {
    let currentIndex = popStandingHeap(scratch);
    if (goalIndexes.has(currentIndex)) {
      const path = [positionFromStandingIndex(currentIndex)];
      while (scratch.cameFrom[currentIndex] >= 0) {
        currentIndex = scratch.cameFrom[currentIndex];
        path.push(positionFromStandingIndex(currentIndex));
      }
      return rememberPath(cache, cacheKey, path.reverse());
    }
    const current = positionFromStandingIndex(currentIndex);
    for (const nextCell of neighbors4(current.cellId)) {
      for (const next of standingPositions(world, nextCell)) {
        if (Math.abs(next.z - current.z) > 1) continue;
        const nextIndex = standingIndex(next);
        touchStandingPathIndex(scratch, nextIndex);
        const tentative = scratch.gScore[currentIndex] + standingMovementCost(world, current, next);
        if (tentative >= scratch.gScore[nextIndex]) continue;
        scratch.cameFrom[nextIndex] = currentIndex;
        scratch.gScore[nextIndex] = tentative;
        scratch.fScore[nextIndex] = tentative + standingHeuristic(next, goals);
        pushOrDecreaseStandingHeap(scratch, nextIndex);
      }
    }
  }
  return rememberPath(cache, cacheKey, []);
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
    generator: {
      version: input.generator?.version ?? 'material-world-v1',
      seed: Number(input.generator?.seed ?? 0),
    },
    palette: MATERIAL_PALETTE,
    voxels,
  };
}

export function copyWorld(input: VoxelWorld): VoxelWorld {
  return hydrateWorld(input);
}
