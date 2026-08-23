import { Material, type MaterialId } from './material';
import type { SimulationState } from './model';
import { inventoryQuantity, type PersonState } from './person';
import {
  personallyKnownTechniquePrerequisitesForOutput,
  type PersonallyKnownTechniquePrerequisite,
} from './technique-demonstration';
import {
  cellX,
  cellY,
  cellsInRadius,
  findStandingPath,
  neighbors4,
  standingPositions,
  topPosition,
  voxelAt,
} from '../world/grid';

export type PersonKnownProcessLeafKind =
  | 'unknown-output'
  | 'direct-output'
  | 'target-blocked'
  | 'cycle';

export interface PersonKnownProcessLeaf {
  kind: PersonKnownProcessLeafKind;
  materialId: MaterialId;
  quantity: number;
  parentTechniqueId?: string;
  techniquePath: string[];
  sourceFactIds: string[];
}

export interface PersonKnownProcessResolution {
  rootOutputMaterialId: MaterialId;
  leaves: PersonKnownProcessLeaf[];
  techniqueIds: string[];
  sourceFactIds: string[];
}

export interface PersonKnownProcessOptions {
  directAccess?: (
    materialId: MaterialId,
    quantity: number,
  ) => { sourceFactIds: string[] } | null;
  ignoreRootInventory?: boolean;
}

function targetReachableFrom(
  state: SimulationState,
  person: PersonState,
  target: { x: number; y: number; z: number },
): boolean {
  const targetCellId = target.x + target.y * state.world.grid.width;
  return [targetCellId, ...neighbors4(targetCellId)]
    .flatMap((cellId) => standingPositions(state.world.grid, cellId))
    .filter((position) => Math.abs(cellX(position.cellId) - target.x)
      + Math.abs(cellY(position.cellId) - target.y) <= 1
      && Math.abs(position.z - target.z) <= 2)
    .some((position) => findStandingPath(state.world.grid, person.position, position).length > 0);
}

/** Spatial targets are preconditions, never portable recipe inputs. */
export function personKnowsReachableTechniqueTarget(
  state: SimulationState,
  person: PersonState,
  targetMaterialId: MaterialId,
): boolean {
  if (targetMaterialId === Material.Air) return true;
  const visible = cellsInRadius(
    person.position.cellId,
    4 + Math.floor(person.baselineCapacities.perception / 25),
  ).map((cellId) => topPosition(state.world.grid, cellId));
  const remembered = person.knownPlaces
    .filter((place) => place.materialId === targetMaterialId)
    .map((place) => ({ ...place.position }));
  const candidates = [...visible, ...remembered]
    .filter((position) => voxelAt(state.world.grid, position.x, position.y, position.z) === targetMaterialId)
    .filter((position, index, all) => all.findIndex((candidate) => candidate.x === position.x
      && candidate.y === position.y
      && candidate.z === position.z) === index);
  return candidates.some((position) => targetReachableFrom(state, person, position));
}

function usableTechnique(
  state: SimulationState,
  person: PersonState,
  outputMaterialId: MaterialId,
): PersonallyKnownTechniquePrerequisite | undefined {
  return personallyKnownTechniquePrerequisitesForOutput(person, outputMaterialId)
    .find((candidate) => candidate.targetMaterialId === undefined
      || personKnowsReachableTechniqueTarget(state, person, candidate.targetMaterialId));
}

export function resolvePersonKnownProcess(
  state: SimulationState,
  person: PersonState,
  rootOutputMaterialId: MaterialId,
  options: PersonKnownProcessOptions = {},
): PersonKnownProcessResolution {
  const techniqueIds: string[] = [];
  const sourceFactIds: string[] = [];
  const resolve = (
    materialId: MaterialId,
    quantity: number,
    techniquePath: string[],
    visiting: ReadonlySet<MaterialId>,
    depth: number,
  ): PersonKnownProcessLeaf[] => {
    if (!(depth === 0 && options.ignoreRootInventory)
      && inventoryQuantity(person, materialId) >= quantity) return [];
    const direct = options.directAccess?.(materialId, quantity);
    if (direct) return [{
      kind: 'direct-output',
      materialId,
      quantity,
      parentTechniqueId: techniquePath.at(-1),
      techniquePath: [...techniquePath],
      sourceFactIds: [...direct.sourceFactIds],
    }];
    if (visiting.has(materialId)) return [{
      kind: 'cycle',
      materialId,
      quantity,
      parentTechniqueId: techniquePath.at(-1),
      techniquePath: [...techniquePath],
      sourceFactIds: [],
    }];
    const knownCandidates = personallyKnownTechniquePrerequisitesForOutput(person, materialId);
    const technique = usableTechnique(state, person, materialId);
    if (!technique) return [{
      kind: knownCandidates.length ? 'target-blocked' : 'unknown-output',
      materialId,
      quantity,
      parentTechniqueId: techniquePath.at(-1),
      techniquePath: [...techniquePath],
      sourceFactIds: [...new Set(knownCandidates.flatMap((candidate) => candidate.sourceFactIds))],
    }];
    if (!techniqueIds.includes(technique.techniqueId)) techniqueIds.push(technique.techniqueId);
    sourceFactIds.push(...technique.sourceFactIds);
    const batches = Math.max(1, Math.ceil(quantity / Math.max(1, technique.outputQuantity)));
    const nextVisiting = new Set(visiting);
    nextVisiting.add(materialId);
    return technique.portableInputs.flatMap((input) => resolve(
      input.materialId,
      input.quantity * batches,
      [...techniquePath, technique.techniqueId],
      nextVisiting,
      depth + 1,
    ));
  };
  const leaves = resolve(rootOutputMaterialId, 1, [], new Set(), 0);
  return {
    rootOutputMaterialId,
    leaves,
    techniqueIds,
    sourceFactIds: [...new Set([
      ...sourceFactIds,
      ...leaves.flatMap((leaf) => leaf.sourceFactIds),
    ])],
  };
}

export function firstUnknownPersonKnownProcessOutput(
  resolution: PersonKnownProcessResolution,
): PersonKnownProcessLeaf | undefined {
  return resolution.leaves.find((leaf) => leaf.kind === 'unknown-output');
}
