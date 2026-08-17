import { WORLD_DEPTH, WORLD_WIDTH } from './grid';

export type BiomeKey =
  | 'taiga'
  | 'temperate'
  | 'birch'
  | 'blossom'
  | 'savanna'
  | 'tropical'
  | 'meadow';

/**
 * Tree species are a deterministic visual projection. The authoritative world
 * continues to store every complete tree as Wood topped by Leaves.
 */
export type TreeSpeciesKey = 'spruce' | 'oak' | 'birch' | 'cherry' | 'acacia' | 'palm';

export interface BiomeProfile {
  key: BiomeKey;
  treeDensity: number;
  shrubDensity: number;
  berryDensity: number;
  sandChance: number;
  richSoilChance: number;
  treeSpecies: readonly Readonly<{ key: TreeSpeciesKey; weight: number }>[];
}

export const BIOME_PROFILES: Readonly<Record<BiomeKey, BiomeProfile>> = {
  taiga: {
    key: 'taiga',
    treeDensity: 0.155,
    shrubDensity: 0.075,
    berryDensity: 0.065,
    sandChance: 0.01,
    richSoilChance: 0.12,
    treeSpecies: [
      { key: 'spruce', weight: 0.84 },
      { key: 'birch', weight: 0.16 },
    ],
  },
  temperate: {
    key: 'temperate',
    treeDensity: 0.11,
    shrubDensity: 0.1,
    berryDensity: 0.095,
    sandChance: 0.03,
    richSoilChance: 0.27,
    treeSpecies: [
      { key: 'oak', weight: 0.5 },
      { key: 'birch', weight: 0.22 },
      { key: 'cherry', weight: 0.16 },
      { key: 'spruce', weight: 0.12 },
    ],
  },
  birch: {
    key: 'birch',
    treeDensity: 0.135,
    shrubDensity: 0.08,
    berryDensity: 0.08,
    sandChance: 0.02,
    richSoilChance: 0.3,
    treeSpecies: [
      { key: 'birch', weight: 0.7 },
      { key: 'oak', weight: 0.18 },
      { key: 'spruce', weight: 0.12 },
    ],
  },
  blossom: {
    key: 'blossom',
    treeDensity: 0.12,
    shrubDensity: 0.08,
    berryDensity: 0.12,
    sandChance: 0.02,
    richSoilChance: 0.36,
    treeSpecies: [
      { key: 'cherry', weight: 0.7 },
      { key: 'oak', weight: 0.2 },
      { key: 'birch', weight: 0.1 },
    ],
  },
  savanna: {
    key: 'savanna',
    treeDensity: 0.045,
    shrubDensity: 0.14,
    berryDensity: 0.04,
    sandChance: 0.28,
    richSoilChance: 0.04,
    treeSpecies: [
      { key: 'acacia', weight: 0.72 },
      { key: 'oak', weight: 0.18 },
      { key: 'palm', weight: 0.1 },
    ],
  },
  tropical: {
    key: 'tropical',
    treeDensity: 0.165,
    shrubDensity: 0.105,
    berryDensity: 0.13,
    sandChance: 0.04,
    richSoilChance: 0.45,
    treeSpecies: [
      { key: 'palm', weight: 0.46 },
      { key: 'oak', weight: 0.32 },
      { key: 'acacia', weight: 0.22 },
    ],
  },
  meadow: {
    key: 'meadow',
    treeDensity: 0.03,
    shrubDensity: 0.12,
    berryDensity: 0.095,
    sandChance: 0.025,
    richSoilChance: 0.22,
    treeSpecies: [
      { key: 'oak', weight: 0.48 },
      { key: 'birch', weight: 0.34 },
      { key: 'cherry', weight: 0.18 },
    ],
  },
};

function fraction(seed: number, key: string): number {
  let value = (Math.trunc(seed) ^ 0x811c9dc5) >>> 0;
  for (let index = 0; index < key.length; index += 1) {
    value ^= key.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  return (value >>> 0) / 0x100000000;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothStep(value: number): number {
  return value * value * (3 - 2 * value);
}

/** Low-frequency value noise. Interpolated samples avoid cell-sized biome speckle. */
function smoothField(seed: number, x: number, y: number, scale: number, key: string): number {
  const gx = Math.floor(x / scale);
  const gy = Math.floor(y / scale);
  const fx = smoothStep((x - gx * scale) / scale);
  const fy = smoothStep((y - gy * scale) / scale);
  const sample = (sx: number, sy: number) => fraction(seed, `${key}:${sx}:${sy}`);
  const north = sample(gx, gy) + (sample(gx + 1, gy) - sample(gx, gy)) * fx;
  const south = sample(gx, gy + 1) + (sample(gx + 1, gy + 1) - sample(gx, gy + 1)) * fx;
  return north + (south - north) * fy;
}

function climateAt(seed: number, x: number, y: number): { temperature: number; humidity: number; identity: number } {
  const latitude = Math.abs((y / Math.max(1, WORLD_DEPTH - 1)) * 2 - 1);
  const broadTemperature = smoothField(seed + 1_117, x, y, 24, 'temperature');
  const localTemperature = smoothField(seed + 1_193, x, y, 11, 'temperature-detail');
  const temperature = clamp01(0.94 - latitude * 0.82 + (broadTemperature - 0.5) * 0.28 + (localTemperature - 0.5) * 0.1);
  const broadHumidity = smoothField(seed + 2_003, x, y, 21, 'humidity');
  const localHumidity = smoothField(seed + 2_039, x, y, 9, 'humidity-detail');
  const coastBias = 1 - Math.abs((x / Math.max(1, WORLD_WIDTH - 1)) * 2 - 1);
  const humidity = clamp01(broadHumidity * 0.72 + localHumidity * 0.2 + coastBias * 0.08);
  const identity = smoothField(seed + 3_001, x, y, 16, 'biome-identity');
  return { temperature, humidity, identity };
}

export function biomeAt(seed: number, x: number, y: number): BiomeKey {
  const { temperature, humidity, identity } = climateAt(seed, x, y);
  if (temperature < 0.3) return 'taiga';
  if (temperature > 0.7) {
    if (humidity < 0.47) return 'savanna';
    if (humidity > 0.62) return 'tropical';
    return identity < 0.52 ? 'savanna' : 'tropical';
  }
  if (humidity < 0.34) return 'meadow';
  if (humidity > 0.68) return identity < 0.46 ? 'blossom' : 'birch';
  if (identity < 0.32) return 'birch';
  if (identity > 0.78 && temperature > 0.45) return 'blossom';
  return 'temperate';
}

export function biomeProfileAt(seed: number, x: number, y: number): BiomeProfile {
  return BIOME_PROFILES[biomeAt(seed, x, y)];
}

export function treeSpeciesAt(seed: number, x: number, y: number): TreeSpeciesKey {
  const species = biomeProfileAt(seed, x, y).treeSpecies;
  // Nearby cells lean toward the same species, while a small cell jitter keeps
  // a grove from becoming a perfectly uniform stamp.
  const grove = smoothField(seed + 4_009, x, y, 7, 'tree-species');
  const sample = grove * 0.82 + fraction(seed, `tree-species-jitter:${x}:${y}`) * 0.18;
  let cumulative = 0;
  for (const candidate of species) {
    cumulative += candidate.weight;
    if (sample < cumulative) return candidate.key;
  }
  return species.at(-1)?.key ?? 'oak';
}
