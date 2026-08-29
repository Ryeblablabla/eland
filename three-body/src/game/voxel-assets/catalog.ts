import catalogSource from './catalog.json';

export type VoxelAssetKey = 'rabbit' | 'boar' | 'wolf';
export type VoxelAssetBucket =
  | 'leaf'
  | 'wood'
  | 'organicDark'
  | 'groundMark'
  | 'stone'
  | 'plaster'
  | 'thatch'
  | 'roofTile'
  | 'glowWarm'
  | 'glowRed'
  | 'accent'
  | 'dark';
export type VoxelAssetAgeBand = 'juvenile' | 'adult' | 'elder';
export type VoxelAssetSex = 'female' | 'male';

type Vector3Tuple = readonly [number, number, number];

export interface VoxelAssetPartCondition {
  readonly sex?: readonly VoxelAssetSex[];
  readonly ageBand?: readonly VoxelAssetAgeBand[];
}

export interface VoxelAssetPartVariation {
  readonly productionBrightness?: readonly [number, number];
  readonly previewHsl?: readonly [number, number, number];
}

export interface VoxelAssetCatalogPart {
  readonly id: string;
  readonly bucket: VoxelAssetBucket;
  readonly position: Vector3Tuple;
  readonly size: Vector3Tuple;
  readonly color: string;
  readonly part: string;
  readonly gaitPhase?: -1 | 1;
  readonly variation?: VoxelAssetPartVariation;
  readonly when?: VoxelAssetPartCondition;
}

export interface VoxelAssetDefinition {
  readonly kind: 'animal';
  readonly status: 'live' | 'prototype';
  readonly palette: Readonly<Record<string, string>>;
  readonly parts: readonly VoxelAssetCatalogPart[];
}

export interface VoxelAssetCatalog {
  readonly schemaVersion: number;
  readonly units: {
    readonly microPerCell: number;
    readonly worldCellHeight: number;
  };
  readonly assets: Readonly<Record<VoxelAssetKey, VoxelAssetDefinition>>;
}

export interface VoxelAssetContext {
  readonly sex?: VoxelAssetSex;
  readonly ageBand?: VoxelAssetAgeBand;
}

export interface ResolvedVoxelAssetPart {
  readonly id: string;
  readonly bucket: VoxelAssetBucket;
  readonly position: Vector3Tuple;
  readonly size: Vector3Tuple;
  readonly color: number;
  readonly part: string;
  readonly gaitPhase?: -1 | 1;
  readonly variation?: VoxelAssetPartVariation;
}

export const VOXEL_ASSET_CATALOG = catalogSource as unknown as VoxelAssetCatalog;
export const VOXEL_ASSET_KEYS = ['rabbit', 'boar', 'wolf'] as const satisfies readonly VoxelAssetKey[];
export const MICRO_PER_CELL = VOXEL_ASSET_CATALOG.units.microPerCell;
export const WORLD_CELL_HEIGHT = VOXEL_ASSET_CATALOG.units.worldCellHeight;

function conditionMatches(condition: VoxelAssetPartCondition | undefined, context: VoxelAssetContext): boolean {
  if (!condition) return true;
  const sex = context.sex ?? 'male';
  const ageBand = context.ageBand ?? 'adult';
  return (!condition.sex || condition.sex.includes(sex))
    && (!condition.ageBand || condition.ageBand.includes(ageBand));
}

function parseColor(hex: string): number {
  return Number.parseInt(hex.replace(/^#/, ''), 16);
}

function productionColor(
  color: number,
  variation: VoxelAssetPartVariation | undefined,
  colorSeed: number | undefined,
): number {
  const brightness = variation?.productionBrightness;
  if (!brightness || colorSeed === undefined) return color;
  const factor = brightness[0] + colorSeed * (brightness[1] - brightness[0]);
  const red = Math.min(255, ((color >> 16) & 255) * factor);
  const green = Math.min(255, ((color >> 8) & 255) * factor);
  const blue = Math.min(255, (color & 255) * factor);
  return (Math.round(red) << 16) | (Math.round(green) << 8) | Math.round(blue);
}

/**
 * Resolve one catalog asset into immutable cuboids ready for the production Kit adapter.
 * Sex and age only select declared parts; no domain fact or animation is invented here.
 */
export function resolveVoxelAssetParts(
  key: VoxelAssetKey,
  context: VoxelAssetContext = {},
  colorSeed?: number,
): readonly ResolvedVoxelAssetPart[] {
  const asset = VOXEL_ASSET_CATALOG.assets[key];
  return asset.parts
    .filter((part) => conditionMatches(part.when, context))
    .map((part) => {
      const baseColor = parseColor(asset.palette[part.color]);
      return {
        id: part.id,
        bucket: part.bucket,
        position: part.position,
        size: part.size,
        color: productionColor(baseColor, part.variation, colorSeed),
        part: part.part,
        ...(part.gaitPhase === undefined ? {} : { gaitPhase: part.gaitPhase }),
        ...(part.variation === undefined ? {} : { variation: part.variation }),
      };
    });
}
