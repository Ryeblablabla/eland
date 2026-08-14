import type { PixelWorldView } from './societyContract';

/**
 * 格内材质细节：在权威数据不变的提下提高画面精度——
 * 植物格撒草点、岩土格撒碎屑、水面画漂移波痕与微光闪烁。
 * 一切从调色板颜色派生，无外部贴图。
 */

/** 每格稳定的伪随机 [0,1)（cellId + salt 哈希，纹理不随帧抖动） */
function cellRand(cellId: number, salt: number): number {
  let h = (cellId * 374761393 + salt * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * 在 terrain 底色与 hillshade 之后、活动痕迹之前调用。
 * @param px,py 格左上角画布坐标；scale 格边长（px）；now 时间戳（驱动水面动画）
 */
export function drawCellDetail(
  ctx: CanvasRenderingContext2D,
  world: PixelWorldView,
  cellId: number,
  px: number,
  py: number,
  scale: number,
  now: number,
): void {
  if (scale < 6) return; // 低缩放下细节不可见，省开销
  const material = world.palette[world.surface[cellId]];
  if (!material) return;
  const [r, g, b] = material.color;

  if (material.tags.includes('liquid')) {
    // 水面：两条横向波痕，异速漂移 + 透明度闪烁
    const t = now * 0.0011 + cellRand(cellId, 7) * 6.28;
    for (let k = 0; k < 2; k++) {
      const wl = scale * (0.3 + cellRand(cellId, 11 + k) * 0.2);
      const drift = now * 0.018 * (k === 0 ? 1 : -0.7) + cellRand(cellId, 3 + k) * 89;
      const wx = px + ((drift % (scale + wl)) + scale + wl) % (scale + wl) - wl;
      const wy = py + scale * (0.28 + k * 0.34) + Math.sin(t + k * 2.1) * scale * 0.05;
      const shimmer = 0.18 + 0.14 * Math.sin(t * 1.7 + k);
      ctx.fillStyle = `rgba(${Math.min(255, r + 46)},${Math.min(255, g + 52)},${Math.min(255, b + 40)},${shimmer.toFixed(3)})`;
      ctx.fillRect(wx, wy, wl, Math.max(1, scale * 0.06));
    }
    return;
  }

  // 植物多两点、岩土少而暗；位置按格哈希固定
  const isPlant = material.tags.includes('plant');
  const dots = isPlant ? 4 : 3;
  const amp = isPlant ? 20 : 14;
  for (let k = 0; k < dots; k++) {
    const dx = px + scale * (0.12 + cellRand(cellId, k * 2) * 0.76);
    const dy = py + scale * (0.12 + cellRand(cellId, k * 2 + 1) * 0.76);
    const light = cellRand(cellId, 20 + k) > 0.5 ? 1 : -1;
    ctx.fillStyle = `rgba(${Math.max(0, Math.min(255, r + light * amp))},${Math.max(0, Math.min(255, g + light * amp))},${Math.max(0, Math.min(255, b + light * amp))},0.5)`;
    const s = Math.max(1, scale * 0.08);
    ctx.fillRect(dx, dy, s, s);
  }
}
