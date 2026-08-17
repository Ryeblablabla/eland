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
  // tickPath 会记录没有位移的规则 tick。视觉播放只保留实际发生的连续位移段，
  // 再把这些段均匀铺满完整周期，避免人物提前走完后长时间停在终点。
  const movingPath = [path[0]];
  for (let i = 1; i < path.length; i++) {
    if (path[i] !== path[i - 1]) movingPath.push(path[i]);
  }
  if (movingPath.length === 1) return cellCoordinates(movingPath[0], width);
  const offset = Math.max(0, Math.min(1, progress)) * (movingPath.length - 1);
  const index = Math.floor(offset);
  const local = offset - index;
  const a = cellCoordinates(movingPath[index], width);
  const b = cellCoordinates(movingPath[Math.min(movingPath.length - 1, index + 1)], width);
  return { x: a.x + (b.x - a.x) * local, y: a.y + (b.y - a.y) * local };
}
