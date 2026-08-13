export const WORLD_WIDTH = 84;
export const WORLD_HEIGHT = 52;
export const WORLD_CELL_COUNT = WORLD_WIDTH * WORLD_HEIGHT;

export const TerrainKind = {
  Soil: 0,
  Rock: 1,
  Sand: 2,
  Clay: 3,
  Waterbed: 4,
} as const;

export const SurfaceCover = {
  Bare: 0,
  Grass: 1,
  Shrub: 2,
  Tree: 3,
  Crop: 4,
  Ash: 5,
  Snow: 6,
} as const;

export type DenseU8 = Uint8Array;
export type DenseU16 = Uint16Array;
export type DenseI16 = Int16Array;

export interface CellLayers {
  terrainKind: DenseU8;
  elevation: DenseI16;
  fertility: DenseU8;
  waterDepth: DenseU8;
  surfaceCover: DenseU8;
  moisture: DenseU8;
  temperature: DenseI16;
  vegetation: DenseU8;
  fire: DenseU8;
  ice: DenseU8;
  contamination: DenseU8;
}

export interface TraceLayers {
  traffic: DenseU16;
  rest: DenseU16;
  cultivation: DenseU16;
  care: DenseU16;
  trade: DenseU16;
  gathering: DenseU16;
  burial: DenseU16;
}

export interface PixelWorld {
  version: 1;
  width: typeof WORLD_WIDTH;
  height: typeof WORLD_HEIGHT;
  generator: { version: "pixel-world-v1"; seed: number };
  cells: CellLayers;
  traces: TraceLayers;
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

export function neighbors4(id: number): number[] {
  const x = cellX(id);
  const y = cellY(id);
  const result: number[] = [];
  if (y > 0) result.push(id - WORLD_WIDTH);
  if (x > 0) result.push(id - 1);
  if (x + 1 < WORLD_WIDTH) result.push(id + 1);
  if (y + 1 < WORLD_HEIGHT) result.push(id + WORLD_WIDTH);
  return result;
}

export function createCellLayers(): CellLayers {
  return {
    terrainKind: new Uint8Array(WORLD_CELL_COUNT),
    elevation: new Int16Array(WORLD_CELL_COUNT),
    fertility: new Uint8Array(WORLD_CELL_COUNT),
    waterDepth: new Uint8Array(WORLD_CELL_COUNT),
    surfaceCover: new Uint8Array(WORLD_CELL_COUNT),
    moisture: new Uint8Array(WORLD_CELL_COUNT),
    temperature: new Int16Array(WORLD_CELL_COUNT),
    vegetation: new Uint8Array(WORLD_CELL_COUNT),
    fire: new Uint8Array(WORLD_CELL_COUNT),
    ice: new Uint8Array(WORLD_CELL_COUNT),
    contamination: new Uint8Array(WORLD_CELL_COUNT),
  };
}

export function createTraceLayers(): TraceLayers {
  return {
    traffic: new Uint16Array(WORLD_CELL_COUNT),
    rest: new Uint16Array(WORLD_CELL_COUNT),
    cultivation: new Uint16Array(WORLD_CELL_COUNT),
    care: new Uint16Array(WORLD_CELL_COUNT),
    trade: new Uint16Array(WORLD_CELL_COUNT),
    gathering: new Uint16Array(WORLD_CELL_COUNT),
    burial: new Uint16Array(WORLD_CELL_COUNT),
  };
}

function asTyped<T extends Uint8Array | Uint16Array | Int16Array>(
  value: unknown,
  Type: { new(values: ArrayLike<number>): T },
): T {
  if (value instanceof Type) return new Type(value);
  if (Array.isArray(value)) return new Type(value);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const numeric = Object.keys(record)
      .filter((key) => /^\d+$/.test(key))
      .sort((a, b) => Number(a) - Number(b))
      .map((key) => Number(record[key]));
    if (numeric.length) return new Type(numeric);
  }
  return new Type(WORLD_CELL_COUNT);
}

export function hydrateWorld(input: PixelWorld): PixelWorld {
  return {
    version: 1,
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    generator: { version: "pixel-world-v1", seed: Number(input.generator?.seed ?? 0) },
    cells: {
      terrainKind: asTyped(input.cells?.terrainKind, Uint8Array),
      elevation: asTyped(input.cells?.elevation, Int16Array),
      fertility: asTyped(input.cells?.fertility, Uint8Array),
      waterDepth: asTyped(input.cells?.waterDepth, Uint8Array),
      surfaceCover: asTyped(input.cells?.surfaceCover, Uint8Array),
      moisture: asTyped(input.cells?.moisture, Uint8Array),
      temperature: asTyped(input.cells?.temperature, Int16Array),
      vegetation: asTyped(input.cells?.vegetation, Uint8Array),
      fire: asTyped(input.cells?.fire, Uint8Array),
      ice: asTyped(input.cells?.ice, Uint8Array),
      contamination: asTyped(input.cells?.contamination, Uint8Array),
    },
    traces: {
      traffic: asTyped(input.traces?.traffic, Uint16Array),
      rest: asTyped(input.traces?.rest, Uint16Array),
      cultivation: asTyped(input.traces?.cultivation, Uint16Array),
      care: asTyped(input.traces?.care, Uint16Array),
      trade: asTyped(input.traces?.trade, Uint16Array),
      gathering: asTyped(input.traces?.gathering, Uint16Array),
      burial: asTyped(input.traces?.burial, Uint16Array),
    },
  };
}

export function copyWorld(input: PixelWorld): PixelWorld {
  return hydrateWorld(input);
}

export function isPassable(world: PixelWorld, id: number): boolean {
  if (!isCellId(id)) return false;
  const cells = world.cells;
  return cells.waterDepth[id] <= 35 && cells.fire[id] < 45;
}

export function movementCost(world: PixelWorld, from: number, to: number): number {
  const cells = world.cells;
  const climb = Math.max(0, cells.elevation[to] - cells.elevation[from]);
  const vegetation = cells.vegetation[to];
  const water = cells.waterDepth[to];
  const ice = cells.ice[to];
  const roadRelief = Math.min(3, Math.floor(world.traces.traffic[to] / 12));
  return Math.max(1, 2 + Math.ceil(climb / 8) + Math.ceil(vegetation / 30) + Math.ceil(water / 15) + Math.ceil(ice / 35) - roadRelief);
}

function manhattan(a: number, b: number): number {
  return Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
}

export function findPath(world: PixelWorld, start: number, goal: number): number[] {
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
      if (score < best || (score === best && candidate < current)) {
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
      if (!isPassable(world, next)) continue;
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
  for (let y = Math.max(0, oy - radius); y <= Math.min(WORLD_HEIGHT - 1, oy + radius); y += 1) {
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
