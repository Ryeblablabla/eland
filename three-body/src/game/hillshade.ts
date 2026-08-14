/**
 * 地形起伏明暗（hillshade）：纯函数，不做 3D、不动相机——
 * 只按高度场的东西/南北梯度给俯视像素打明暗，
 * 光源固定在西北，山体向光面暖亮、背光面冷暗。
 */

/**
 * 返回 [-1, 1] 的明暗系数；调用方映射成正（暖亮）/负（冷暗）两层叠加。
 * @param elevation 每格高度（world.elevation）
 * @param strength  强度系数（高度差 → 明暗的斜率）
 */
export function hillshade(
  elevation: number[],
  width: number,
  height: number,
  cellId: number,
  strength = 0.16,
): number {
  const x = cellId % width;
  const y = Math.floor(cellId / width);
  const w = x > 0 ? elevation[cellId - 1] : elevation[cellId];
  const e = x < width - 1 ? elevation[cellId + 1] : elevation[cellId];
  const n = y > 0 ? elevation[cellId - width] : elevation[cellId];
  const s = y < height - 1 ? elevation[cellId + width] : elevation[cellId];
  // 高度向东/南增大 → 坡面朝西北 → 正对光源 → 亮
  const lit = ((e - w) + (s - n)) / 2;
  const v = lit * strength;
  return Math.max(-1, Math.min(1, v));
}

/** 明暗系数 → 叠加层填充色；接近 0 时返回 null（跳过绘制省开销） */
export function hillshadeFill(v: number): string | null {
  if (v > 0.03) return `rgba(255,244,214,${(v * 0.3).toFixed(3)})`;
  if (v < -0.03) return `rgba(3,8,16,${(-v * 0.34).toFixed(3)})`;
  return null;
}
