import { MICRO_PER_CELL } from './catalog';

export const MICRO = 1 / MICRO_PER_CELL;

export type DecorBucket =
  | 'leaf' | 'wood' | 'organicDark' | 'groundMark' | 'stone' | 'plaster' | 'thatch' | 'roofTile'
  | 'glowWarm' | 'glowRed' | 'accent' | 'dark';

export const DECOR_BUCKETS: DecorBucket[] = [
  'leaf', 'wood', 'organicDark', 'groundMark', 'stone', 'plaster', 'thatch', 'roofTile',
  'glowWarm', 'glowRed', 'accent', 'dark',
];

export interface DecorInstance {
  b: DecorBucket;
  x: number; y: number; z: number;      // 世界坐标（实例中心）
  sx: number; sy: number; sz: number;   // 实例尺寸
  ry?: number;                          // 绕世界 Y 轴旋转（弧度）；用于斜向道路等静态构件
  c: number;                            // 0xRRGGBB
  entityId?: string;                    // 动态实体 id；静态装饰不设置
  entityX?: number; entityY?: number; entityZ?: number; // 动画原点
  entityRotation?: number;              // Kit 的 90° 朝向；设施部件动画据此选择转轴
  part?: string;                        // body / head / tail / leg-N
  animation?: 'fire' | 'wind' | 'facility-smoke' | 'facility-lift' | 'wheel-spin' | 'mill-turn';
  /** 时代切换时单独交叉渐变的聚落装饰；不参与领域状态与观察器计算。 */
  visualLayer?: 'settlement-era';
}

/** 格内确定性强散列 */
export function hash01(n: number, salt = 0): number {
  let v = (n ^ 0x811c9dc5 ^ Math.imul(salt + 1, 0x01000193)) >>> 0;
  v ^= v >>> 16; v = Math.imul(v, 0x7feb352d) >>> 0; v ^= v >>> 15;
  return (v >>> 0) / 0x100000000;
}

/** 颜色亮度抖动 */
export function jit(hex: number, r: number): number {
  const f = 0.9 + r * 0.2;
  const cr = Math.min(255, ((hex >> 16) & 255) * f);
  const cg = Math.min(255, ((hex >> 8) & 255) * f);
  const cb = Math.min(255, (hex & 255) * f);
  return (Math.round(cr) << 16) | (Math.round(cg) << 8) | Math.round(cb);
}

/**
 * 天气驱动的摆动强度：风暴 > 雨 > 旱 > 雪 > 雾 > 晴。
 * 树冠摇摆旗标与地表颗粒微风共用同一权威天气映射；乱纪元加成由调用方叠加。
 */
export function weatherSwayStrength(weather?: { kind: string; intensity: number } | null): number {
  if (!weather) return 0.15;
  const kindBase: Record<string, number> = {
    storm: 0.72, rain: 0.42, drought: 0.3, snow: 0.22, fog: 0.12, clear: 0.14,
  };
  const base = kindBase[weather.kind] ?? 0.15;
  return Math.min(1, base + Math.max(0, weather.intensity) * 0.055);
}

/** 天气驱动的湿润度：雨/风暴让石头、砖、灰泥与地表变润；雪微润；其余干燥。 */
export function weatherWetness(weather?: { kind: string; intensity: number } | null): number {
  if (!weather) return 0;
  const strength = Math.min(1, Math.max(0, weather.intensity) / 10);
  if (weather.kind === 'storm') return 0.5 + strength * 0.5;
  if (weather.kind === 'rain') return 0.3 + strength * 0.5;
  if (weather.kind === 'snow') return 0.18;
  return 0;
}
