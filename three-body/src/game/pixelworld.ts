import type { PixelWorldView } from './societyContract';

export interface Rgb { r: number; g: number; b: number }

export function cellColor(world: PixelWorldView, cellId: number): Rgb {
  const definition = world.palette[world.surface[cellId]] ?? world.palette[0];
  const [r, g, b] = definition?.color ?? [13, 20, 24];
  const shade = Math.max(-12, Math.min(12, (world.elevation[cellId] - 5) * 2));
  return {
    r: Math.max(0, Math.min(255, Math.round(r + shade))),
    g: Math.max(0, Math.min(255, Math.round(g + shade))),
    b: Math.max(0, Math.min(255, Math.round(b + shade))),
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
