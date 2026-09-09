/**
 * Compositional rules shared by the riverbend study and normal world generation.
 * Pure coordinate sampling: no renderer, storage, simulation or browser state.
 */
export interface LandformSample {
  /** Number of solid/water cells below a standing position, from 2 to 9. */
  height: number;
  surface: 'water' | 'sand' | 'grass' | 'rich_soil' | 'stone';
  riverDistance: number;
  woodland: number;
  clearing: number;
}

export interface SettlementLot {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  height: number;
  material: 'wood' | 'mixed' | 'stone';
}

export const RIVERBEND_SEED = 41027;

export const RIVERBEND_LOTS: readonly SettlementLot[] = [
  { id: 'hearth-house', name: '炉火之家', x: 34, y: 22, width: 5, depth: 3, height: 5, material: 'wood' },
  { id: 'weaver-house', name: '织者小屋', x: 39, y: 24, width: 3, depth: 4, height: 5, material: 'mixed' },
  { id: 'upper-house', name: '坡上石屋', x: 40, y: 16, width: 3, depth: 4, height: 6, material: 'stone' },
  { id: 'mill-house', name: '河岸磨屋', x: 46, y: 27, width: 3, depth: 3, height: 4, material: 'wood' },
  { id: 'orchard-house', name: '果园边的小屋', x: 29, y: 24, width: 3, depth: 4, height: 5, material: 'mixed' },
];

export const RIVERBEND_PATHS: readonly (readonly (readonly [number, number])[])[] = [
  [[26, 28], [28, 29], [33, 29], [35, 28], [38, 29], [42, 30], [46, 31], [49, 31]],
  [[43, 30], [43, 27], [44, 25], [44, 21], [43, 20]],
  [[36, 29], [36, 27], [35, 26]],
  [[28, 29], [27, 27], [27, 26]],
  [[47, 31], [47, 30]],
];

export function landscapeHash(seed: number, x: number, y: number): number {
  let h = (seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(a: number, b: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function broadNoise(seed: number, x: number, y: number, scale: number): number {
  const ix = Math.floor(x / scale), iy = Math.floor(y / scale);
  const fx = smoothstep(0, 1, x / scale - ix);
  const fy = smoothstep(0, 1, y / scale - iy);
  const a = landscapeHash(seed, ix, iy), b = landscapeHash(seed, ix + 1, iy);
  const c = landscapeHash(seed, ix, iy + 1), d = landscapeHash(seed, ix + 1, iy + 1);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/**
 * Wide quiet clearings and dense groves use one low-frequency density field.
 * Feed the result into existing seeded placement, preserving all material rules.
 * A multiplier below one creates breathing room; a grove can reach 2.35.
 */
export function woodlandDensityMultiplier(seed: number, x: number, y: number): number {
  const canopy = broadNoise(seed + 373, x, y, 12) * 0.78
    + broadNoise(seed + 829, x, y, 25) * 0.22;
  return 0.12 + smoothstep(0.27, 0.72, canopy) * 2.23;
}

/** Shared shelf profile; the caller supplies its actual authoritative river distance. */
export function riverbankRelief(
  distanceFromBank: number,
  waterHeight = 2,
  plateauHeight = 5,
  slope = 0.32,
): number {
  return waterHeight + Math.min(Math.max(0, plateauHeight - waterHeight), Math.max(0, distanceFromBank) * slope);
}

export function riverbendRiverCenter(x: number, width = 84, height = 52, seed = RIVERBEND_SEED): number {
  const phase = (landscapeHash(seed, 3, 9) - 0.5) * 0.35;
  const u = x / width;
  return height * 0.6 + Math.sin(u * Math.PI * 2 - 0.75 + phase) * height * 0.093
    + Math.exp(-((u - 0.57) ** 2) / 0.026) * height * 0.045;
}

export function sampleRiverbendLandform(
  seed: number, x: number, y: number, width = 84, height = 52,
): LandformSample {
  const riverY = riverbendRiverCenter(x, width, height, seed);
  const signedRiverDistance = y - riverY;
  const riverDistance = Math.abs(signedRiverDistance);
  const halfWidth = 1.6 + smoothstep(0.34, 0.64, x / width) * 0.9;
  const villageDistance = Math.hypot((x - width * 0.47) / 1.2, y - height * 0.47);
  const clearing = 1 - smoothstep(7.5, 15, villageDistance);
  const grove = woodlandDensityMultiplier(seed, x, y);
  const woodland = grove * (1 - clearing * 0.98)
    * smoothstep(halfWidth + 1.5, halfWidth + 5, riverDistance);

  if (riverDistance < halfWidth) return { height: 2, surface: 'water', riverDistance, woodland: 0, clearing };

  // The inner bank shelves down gently, while the outer bank exposes rock.
  const upperBank = signedRiverDistance < 0;
  const bank = riverDistance - halfWidth;
  const northRidge = smoothstep(height * 0.37, height * 0.10, y);
  const ridgeShape = 0.42 + broadNoise(seed + 54, x, y, 15) * 0.64;
  const relief = upperBank
    ? riverbankRelief(bank, 2, 5) + northRidge * 3.4 * ridgeShape
    : riverbankRelief(bank, 2, 4.5, 0.25);
  let groundHeight = Math.max(2, Math.min(9, Math.round(relief)));
  // A broad habitable terrace, not five isolated foundations.
  if (clearing > 0.3 && upperBank && bank > 3.5) {
    groundHeight = Math.round(groundHeight * (1 - clearing) + 5 * clearing);
  }
  const cliff = upperBank && y < height * 0.28 && groundHeight >= 7;
  const surface = bank < 1.4 ? 'sand'
    : cliff && broadNoise(seed + 37, x, y, 4) > 0.73 ? 'stone'
      : bank < 3 ? 'rich_soil' : 'grass';
  return { height: groundHeight, surface, riverDistance, woodland, clearing };
}

/** Cardinal connected raster line; paths never break at diagonal corners. */
export function cellsAlongPath(points: readonly (readonly [number, number])[], width: number): number[] {
  const cells = new Set<number>();
  for (let i = 1; i < points.length; i++) {
    let [x, y] = points[i - 1];
    const [toX, toY] = points[i];
    const dx = Math.abs(toX - x), dy = Math.abs(toY - y);
    const sx = Math.sign(toX - x), sy = Math.sign(toY - y);
    let error = dx - dy;
    cells.add(y * width + x);
    while (x !== toX || y !== toY) {
      const e2 = error * 2;
      if (e2 > -dy && x !== toX) { error -= dy; x += sx; cells.add(y * width + x); }
      if (e2 < dx && y !== toY) { error += dx; y += sy; cells.add(y * width + x); }
    }
  }
  return [...cells];
}
