import {
  SurfaceCover,
  TerrainKind,
  WORLD_CELL_COUNT,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  cellId,
  createCellLayers,
  createTraceLayers,
  type PixelWorld,
} from "./grid";

export interface GeneratedResource {
  id: string;
  kind: "wood" | "berries" | "stone" | "clay" | "fiber";
  name: string;
  cellId: number;
  quantity: number;
  unitMass: number;
  composition: Record<string, number>;
  traits: string[];
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
  return value / 0x100000000;
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

export function generatePixelWorld(seed: number): { world: PixelWorld; resources: GeneratedResource[]; spawnCells: number[] } {
  const cells = createCellLayers();
  const traces = createTraceLayers();
  const resources: GeneratedResource[] = [];

  for (let y = 0; y < WORLD_HEIGHT; y += 1) {
    for (let x = 0; x < WORLD_WIDTH; x += 1) {
      const id = cellId(x, y);
      const broad = smoothNoise(seed + 13, x, y, 13);
      const detail = smoothNoise(seed + 71, x, y, 5);
      const elevation = Math.round((broad * 0.72 + detail * 0.28) * 100);
      cells.elevation[id] = elevation;
      cells.terrainKind[id] = elevation > 76 ? TerrainKind.Rock : elevation < 22 ? TerrainKind.Clay : TerrainKind.Soil;
      cells.fertility[id] = Math.max(8, Math.min(95, Math.round(82 - Math.abs(elevation - 44) * 1.2 + detail * 14)));
      cells.moisture[id] = Math.max(5, Math.min(95, Math.round(78 - Math.abs(x - 13) * 1.1 + broad * 12)));
      cells.temperature[id] = 18;
      cells.surfaceCover[id] = SurfaceCover.Grass;
      cells.vegetation[id] = Math.max(8, Math.min(90, Math.round(cells.fertility[id] * 0.62 + cells.moisture[id] * 0.22)));
    }
  }

  let riverX = 10 + Math.floor(seededFraction(seed, "river-start") * 5);
  for (let y = 0; y < WORLD_HEIGHT; y += 1) {
    const turn = seededFraction(seed, `river-turn:${y}`);
    if (turn < 0.3) riverX -= 1;
    else if (turn > 0.7) riverX += 1;
    riverX = Math.max(5, Math.min(18, riverX));
    for (let dx = 0; dx < 2; dx += 1) {
      const id = cellId(riverX + dx, y);
      cells.terrainKind[id] = TerrainKind.Waterbed;
      cells.waterDepth[id] = 75;
      cells.moisture[id] = 100;
      cells.surfaceCover[id] = SurfaceCover.Bare;
      cells.vegetation[id] = 0;
      cells.elevation[id] = Math.min(cells.elevation[id], 18);
    }
    for (const bankX of [riverX - 1, riverX + 2]) {
      if (bankX < 0 || bankX >= WORLD_WIDTH) continue;
      const id = cellId(bankX, y);
      cells.moisture[id] = 92;
      cells.terrainKind[id] = TerrainKind.Clay;
    }
  }

  for (let id = 0; id < WORLD_CELL_COUNT; id += 1) {
    if (cells.waterDepth[id] > 35) continue;
    const x = id % WORLD_WIDTH;
    const y = Math.floor(id / WORLD_WIDTH);
    const forestNoise = smoothNoise(seed + 313, x, y, 9);
    if (cells.moisture[id] > 40 && cells.fertility[id] > 35 && forestNoise > 0.53) {
      cells.surfaceCover[id] = SurfaceCover.Tree;
      cells.vegetation[id] = Math.max(65, cells.vegetation[id]);
      if (seededFraction(seed, `wood:${id}`) > 0.72) {
        resources.push({
          id: `wood-${id}`,
          kind: "wood",
          name: "倒木",
          cellId: id,
          quantity: 4 + Math.floor(seededFraction(seed, `wood-q:${id}`) * 5),
          unitMass: 1,
          composition: { wood: 1 },
          traits: ["raw", "rigid", "building", "fuel"],
        });
      }
    } else if (cells.fertility[id] > 58 && seededFraction(seed, `berry:${id}`) > 0.91) {
      cells.surfaceCover[id] = SurfaceCover.Shrub;
      resources.push({
        id: `berries-${id}`,
        kind: "berries",
        name: "野果",
        cellId: id,
        quantity: 4 + Math.floor(seededFraction(seed, `berry-q:${id}`) * 5),
        unitMass: 0.2,
        composition: { biomass: 1 },
        traits: ["raw", "edible", "botanical"],
      });
    }
    if (cells.terrainKind[id] === TerrainKind.Rock && seededFraction(seed, `stone:${id}`) > 0.78) {
      resources.push({
        id: `stone-${id}`,
        kind: "stone",
        name: "石块",
        cellId: id,
        quantity: 3 + Math.floor(seededFraction(seed, `stone-q:${id}`) * 5),
        unitMass: 1.2,
        composition: { stone: 1 },
        traits: ["raw", "rigid", "building"],
      });
    }
    if (cells.terrainKind[id] === TerrainKind.Clay && cells.waterDepth[id] === 0 && seededFraction(seed, `clay:${id}`) > 0.92) {
      resources.push({
        id: `clay-${id}`,
        kind: "clay",
        name: "湿黏土",
        cellId: id,
        quantity: 5,
        unitMass: 0.7,
        composition: { clay: 1 },
        traits: ["raw", "recordable"],
      });
    }
  }

  const centerX = 42;
  const centerY = 27;
  const spawnCells: number[] = [];
  for (let radius = 0; radius < 18 && spawnCells.length < 16; radius += 1) {
    for (let y = Math.max(0, centerY - radius); y <= Math.min(WORLD_HEIGHT - 1, centerY + radius); y += 1) {
      for (let x = Math.max(0, centerX - radius); x <= Math.min(WORLD_WIDTH - 1, centerX + radius); x += 1) {
        if (Math.abs(x - centerX) + Math.abs(y - centerY) !== radius) continue;
        const id = cellId(x, y);
        if (cells.waterDepth[id] <= 20 && cells.fire[id] === 0 && cells.surfaceCover[id] !== SurfaceCover.Tree) spawnCells.push(id);
      }
    }
  }

  const world: PixelWorld = {
    version: 1,
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    generator: { version: "pixel-world-v1", seed },
    cells,
    traces,
  };
  return { world, resources, spawnCells };
}
