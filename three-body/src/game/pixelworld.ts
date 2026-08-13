import type { PixelWorldView } from './societyContract';

export interface Rgb { r: number; g: number; b: number }

const BASE: Rgb[] = [
  { r: 78, g: 91, b: 62 },
  { r: 104, g: 100, b: 91 },
  { r: 137, g: 116, b: 72 },
  { r: 111, g: 83, b: 61 },
  { r: 33, g: 73, b: 94 },
];

export function cellColor(world: PixelWorldView, cellId: number): Rgb {
  const terrain = BASE[world.cells.terrainKind[cellId]] ?? BASE[0];
  const elevation = (world.cells.elevation[cellId] - 50) * 0.35;
  const moisture = world.cells.moisture[cellId] / 100;
  const vegetation = world.cells.vegetation[cellId] / 100;
  const water = world.cells.waterDepth[cellId];
  const cover = world.cells.surfaceCover[cellId];
  if (water > 35) {
    const shade = Math.max(0, Math.min(36, water * 0.28));
    return { r: 20, g: 62 + shade * 0.45, b: 82 + shade };
  }
  let r = terrain.r + elevation;
  let g = terrain.g + elevation;
  let b = terrain.b + elevation;
  if (cover === 2) { r -= 32 * vegetation; g += 24 * vegetation; b -= 22 * vegetation; }
  else if (cover === 1) { r -= 13 * vegetation; g += 20 * vegetation; b -= 11 * vegetation; }
  else if (cover === 3) { r -= 7; g += 16; b -= 8; }
  if (moisture > 0.72) { r -= 8; g += 5; b += 7; }
  if (world.cells.fire[cellId] > 0) { r += 75; g -= 25; b -= 25; }
  if (world.cells.ice[cellId] > 0) { r += 55; g += 68; b += 78; }
  return {
    r: Math.max(0, Math.min(255, Math.round(r))),
    g: Math.max(0, Math.min(255, Math.round(g))),
    b: Math.max(0, Math.min(255, Math.round(b))),
  };
}

export function cellCoordinates(cellId: number, width: number): { x: number; y: number } {
  return { x: cellId % width, y: Math.floor(cellId / width) };
}

export function cellLabel(cellId: number, width: number): string {
  const { x, y } = cellCoordinates(cellId, width);
  return `格 ${x}, ${y}`;
}

export function interpolatePath(path: number[], width: number, progress: number): { x: number; y: number } {
  if (!path.length) return { x: 0, y: 0 };
  if (path.length === 1) return cellCoordinates(path[0], width);
  const offset = Math.max(0, Math.min(0.9999, progress)) * (path.length - 1);
  const index = Math.floor(offset);
  const local = offset - index;
  const a = cellCoordinates(path[index], width);
  const b = cellCoordinates(path[Math.min(path.length - 1, index + 1)], width);
  return { x: a.x + (b.x - a.x) * local, y: a.y + (b.y - a.y) * local };
}
