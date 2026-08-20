import type { BiomeKey } from './world/biome';
import type { GameFrame, PixelWorldView, SocietyState } from '../societyContract';

type NumberPatch = Array<[index: number, value: number]>;

export interface SocietyWorldPatch {
  cells: Array<[
    index: number,
    surface: number,
    elevation: number,
    columns: number[],
    biome: BiomeKey | null,
  ]>;
  activity: {
    traffic: NumberPatch;
    transfer: NumberPatch;
    action: NumberPatch;
    attention: NumberPatch;
  };
}

export type SocietyPatch = Omit<SocietyState, 'world'> & { world: SocietyWorldPatch };

export type ElandStepPayload =
  | { kind: 'full'; frame: GameFrame | null }
  | {
      kind: 'patch';
      baseAuthorityRevision: string;
      baseElapsedMonths: number;
      frame: Omit<GameFrame, 'society'>;
      society: SocietyPatch;
    };

function sameNumberArray(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function samePalette(left: PixelWorldView['palette'], right: PixelWorldView['palette']): boolean {
  return left.length === right.length && left.every((material, index) => {
    const candidate = right[index];
    return Boolean(candidate)
      && material.id === candidate.id
      && material.key === candidate.key
      && material.name === candidate.name
      && sameNumberArray(material.color, candidate.color)
      && material.tags.length === candidate.tags.length
      && material.tags.every((tag, tagIndex) => tag === candidate.tags[tagIndex]);
  });
}

function compatibleWorld(left: PixelWorldView, right: PixelWorldView): boolean {
  return left.width === right.width
    && left.height === right.height
    && left.levels === right.levels
    && left.generator.version === right.generator.version
    && left.generator.seed === right.generator.seed
    && left.surface.length === right.surface.length
    && left.elevation.length === right.elevation.length
    && left.columns.length === right.columns.length
    && (left.biomes?.length ?? -1) === (right.biomes?.length ?? -1)
    && samePalette(left.palette, right.palette);
}

function numberPatch(previous: readonly number[], current: readonly number[]): NumberPatch {
  const patch: NumberPatch = [];
  for (let index = 0; index < current.length; index += 1) {
    if (previous[index] !== current[index]) patch.push([index, current[index]]);
  }
  return patch;
}

export function createSocietyPatch(previous: SocietyState, current: SocietyState): SocietyPatch | null {
  if (!compatibleWorld(previous.world, current.world)) return null;
  const cells: SocietyWorldPatch['cells'] = [];
  for (let index = 0; index < current.world.surface.length; index += 1) {
    const previousBiome = previous.world.biomes?.[index] ?? null;
    const currentBiome = current.world.biomes?.[index] ?? null;
    if (previous.world.surface[index] === current.world.surface[index]
      && previous.world.elevation[index] === current.world.elevation[index]
      && previousBiome === currentBiome
      && sameNumberArray(previous.world.columns[index] ?? [], current.world.columns[index] ?? [])) continue;
    cells.push([
      index,
      current.world.surface[index],
      current.world.elevation[index],
      [...(current.world.columns[index] ?? [])],
      currentBiome,
    ]);
  }
  const { world: _world, ...dynamic } = current;
  return {
    ...dynamic,
    world: {
      cells,
      activity: {
        traffic: numberPatch(previous.world.activity.traffic, current.world.activity.traffic),
        transfer: numberPatch(previous.world.activity.transfer, current.world.activity.transfer),
        action: numberPatch(previous.world.activity.action, current.world.activity.action),
        attention: numberPatch(previous.world.activity.attention, current.world.activity.attention),
      },
    },
  };
}

function applyNumberPatch(previous: number[], patch: NumberPatch): number[] {
  if (!patch.length) return previous;
  const next = previous.slice();
  for (const [index, value] of patch) next[index] = value;
  return next;
}

export function applySocietyPatch(previous: SocietyState, patch: SocietyPatch): SocietyState {
  const cellsChanged = patch.world.cells.length > 0;
  const surface = cellsChanged ? previous.world.surface.slice() : previous.world.surface;
  const elevation = cellsChanged ? previous.world.elevation.slice() : previous.world.elevation;
  const columns = cellsChanged ? previous.world.columns.slice() : previous.world.columns;
  const biomes = cellsChanged && previous.world.biomes ? previous.world.biomes.slice() : previous.world.biomes;
  for (const [index, materialId, z, column, biome] of patch.world.cells) {
    surface[index] = materialId;
    elevation[index] = z;
    columns[index] = column;
    if (biomes && biome) biomes[index] = biome;
  }
  const { world: _world, ...dynamic } = patch;
  return {
    ...dynamic,
    world: {
      ...previous.world,
      surface,
      elevation,
      columns,
      ...(biomes ? { biomes } : {}),
      activity: {
        traffic: applyNumberPatch(previous.world.activity.traffic, patch.world.activity.traffic),
        transfer: applyNumberPatch(previous.world.activity.transfer, patch.world.activity.transfer),
        action: applyNumberPatch(previous.world.activity.action, patch.world.activity.action),
        attention: applyNumberPatch(previous.world.activity.attention, patch.world.activity.attention),
      },
    },
  };
}

export function createStepPayload(previous: GameFrame | null, current: GameFrame | null): ElandStepPayload {
  if (!previous || !current
    || previous.runId !== current.runId
    || previous.authorityRevision !== current.authorityRevision
    || previous.branchId !== current.branchId
    || previous.elapsedMonths >= current.elapsedMonths) return { kind: 'full', frame: current };
  const society = createSocietyPatch(previous.society, current.society);
  if (!society) return { kind: 'full', frame: current };
  const { society: _society, ...frame } = current;
  return {
    kind: 'patch',
    baseAuthorityRevision: previous.authorityRevision,
    baseElapsedMonths: previous.elapsedMonths,
    frame,
    society,
  };
}

export function applyStepPayload(previous: GameFrame | null, payload: ElandStepPayload): GameFrame | null {
  if (payload.kind === 'full') return payload.frame;
  if (!previous
    || previous.runId !== payload.frame.runId
    || previous.authorityRevision !== payload.baseAuthorityRevision
    || payload.frame.authorityRevision !== payload.baseAuthorityRevision
    || previous.branchId !== payload.frame.branchId
    || previous.elapsedMonths !== payload.baseElapsedMonths) return null;
  return { ...payload.frame, society: applySocietyPatch(previous.society, payload.society) };
}
