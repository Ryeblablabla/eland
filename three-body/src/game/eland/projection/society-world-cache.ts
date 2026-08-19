import type { PixelWorldView } from '../../societyContract';
import {
  WORLD_CELL_COUNT,
  columnMaterials,
  surfaceMaterial,
  topZ,
  voxelWorldChangedCellsSince,
  voxelWorldRevision,
  type VoxelWorld,
} from '../world/grid';
import { biomeAt } from '../world/biome';

type StaticWorldProjection = Pick<PixelWorldView, 'generator' | 'palette' | 'biomes'>;
type GeometryProjection = Pick<PixelWorldView, 'surface' | 'elevation' | 'columns'>;

interface CachedWorldProjection {
  generatorSeed: number;
  generatorVersion: string;
  paletteSource: VoxelWorld['palette'];
  staticProjection: StaticWorldProjection;
  revision: number;
  geometry: GeometryProjection;
}

const worldProjections = new WeakMap<VoxelWorld, CachedWorldProjection>();

function staticProjection(grid: VoxelWorld): StaticWorldProjection {
  return {
    generator: { ...grid.generator },
    palette: grid.palette.map(({ id, key, name, color, tags }) => ({
      id,
      key,
      name,
      color: [...color] as [number, number, number],
      tags: [...tags],
    })),
    biomes: Array.from({ length: WORLD_CELL_COUNT }, (_, cell) => biomeAt(
      grid.generator.seed,
      cell % grid.width,
      Math.floor(cell / grid.width),
    )),
  };
}

function fullGeometry(grid: VoxelWorld): GeometryProjection {
  return {
    surface: Array.from({ length: WORLD_CELL_COUNT }, (_, cell) => surfaceMaterial(grid, cell)),
    elevation: Array.from({ length: WORLD_CELL_COUNT }, (_, cell) => topZ(grid, cell)),
    columns: Array.from({ length: WORLD_CELL_COUNT }, (_, cell) => columnMaterials(grid, cell)),
  };
}

function nextGeometry(
  grid: VoxelWorld,
  previous: GeometryProjection,
  previousRevision: number,
): GeometryProjection {
  const changedCells = voxelWorldChangedCellsSince(grid, previousRevision);
  if (!changedCells.length) return previous;

  // Persistent copy-on-write: unchanged column arrays stay shared and are
  // never mutated; only changed cells receive freshly derived arrays.
  const surface = [...previous.surface];
  const elevation = [...previous.elevation];
  const columns = [...previous.columns];
  for (const cell of changedCells) {
    if (cell < 0 || cell >= WORLD_CELL_COUNT) continue;
    surface[cell] = surfaceMaterial(grid, cell);
    elevation[cell] = topZ(grid, cell);
    columns[cell] = columnMaterials(grid, cell);
  }
  return { surface, elevation, columns };
}

/**
 * Projects immutable-looking world arrays without storing observer data on the
 * authoritative grid. Voxel revisions and this cache both live in WeakMaps.
 */
export function projectSocietyWorld(grid: VoxelWorld): Omit<PixelWorldView, 'activity'> {
  const revision = voxelWorldRevision(grid);
  let cached = worldProjections.get(grid);
  if (!cached) {
    cached = {
      generatorSeed: grid.generator.seed,
      generatorVersion: grid.generator.version,
      paletteSource: grid.palette,
      staticProjection: staticProjection(grid),
      revision,
      geometry: fullGeometry(grid),
    };
    worldProjections.set(grid, cached);
  } else {
    if (cached.generatorSeed !== grid.generator.seed
      || cached.generatorVersion !== grid.generator.version
      || cached.paletteSource !== grid.palette) {
      cached.staticProjection = staticProjection(grid);
      cached.generatorSeed = grid.generator.seed;
      cached.generatorVersion = grid.generator.version;
      cached.paletteSource = grid.palette;
    }
    if (cached.revision !== revision) {
      cached.geometry = nextGeometry(grid, cached.geometry, cached.revision);
      cached.revision = revision;
    }
  }

  return {
    width: grid.width,
    height: grid.depth,
    levels: grid.levels,
    ...cached.staticProjection,
    ...cached.geometry,
  };
}
