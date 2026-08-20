import type { ExertionRule } from '../../domain/interaction-rules';
import { materialDefinition, materialHas, type MaterialId } from '../../domain/material';
import type { SimulationState } from '../../domain/model';
import { isAlive, type PersonState } from '../../domain/person';
import {
  cellX,
  cellY,
  cellsInRadius,
  findStandingPath,
  neighbors4,
  standingPositions,
  topPosition,
  voxelAt,
  type StandingPosition,
} from '../../world/grid';
import { visibleCellsFor } from './project-perception';

export interface LocalVoxelTarget {
  position: { x: number; y: number; z: number };
  materialId: MaterialId;
}

function adjacentSupportedTarget(
  state: SimulationState,
  person: PersonState,
  targetFits: (materialId: MaterialId) => boolean,
): LocalVoxelTarget | null {
  for (const targetCellId of [...neighbors4(person.position.cellId)].sort((left, right) => left - right)) {
    const position = { x: cellX(targetCellId), y: cellY(targetCellId), z: person.position.z };
    const supportMaterialId = voxelAt(state.world.grid, position.x, position.y, position.z - 1);
    const targetMaterialId = voxelAt(state.world.grid, position.x, position.y, position.z);
    if (materialDefinition(supportMaterialId).phase === 'solid' && targetFits(targetMaterialId)) {
      return { position, materialId: targetMaterialId };
    }
  }
  return null;
}

export function localOpenExertionTarget(
  state: SimulationState,
  person: PersonState,
): LocalVoxelTarget | null {
  return adjacentSupportedTarget(state, person, (materialId) => materialHas(materialId, 'air'));
}

export function visiblePlacementApproach(
  state: SimulationState,
  person: PersonState,
): StandingPosition | null {
  const visible = new Set(visibleCellsFor(person));
  return [...visible].flatMap((visibleCellId) => standingPositions(state.world.grid, visibleCellId))
    .flatMap((position) => {
      const hasOpenSide = neighbors4(position.cellId).some((targetCellId) => {
        const x = cellX(targetCellId);
        const y = cellY(targetCellId);
        const targetMaterialId = voxelAt(state.world.grid, x, y, position.z);
        const supportMaterialId = voxelAt(state.world.grid, x, y, position.z - 1);
        const occupied = state.people.some((candidate) => isAlive(candidate)
          && candidate.position.cellId === targetCellId
          && candidate.position.z === position.z);
        return materialHas(targetMaterialId, 'air')
          && materialDefinition(supportMaterialId).phase === 'solid'
          && !occupied;
      });
      if (!hasOpenSide) return [];
      const path = findStandingPath(state.world.grid, person.position, position);
      return path.length > 1 ? [{ position, pathLength: path.length - 1 }] : [];
    })
    .sort((left, right) => left.pathLength - right.pathLength
      || left.position.cellId - right.position.cellId
      || left.position.z - right.position.z)[0]?.position ?? null;
}

export function localTargetForKnownExertion(
  state: SimulationState,
  person: PersonState,
  rule: ExertionRule,
): LocalVoxelTarget | null {
  return adjacentSupportedTarget(state, person, (materialId) => materialId === rule.targetMaterialId);
}

export function localHotTarget(state: SimulationState, person: PersonState): LocalVoxelTarget | null {
  return cellsInRadius(person.position.cellId, 1)
    .map((nearbyCellId) => {
      const position = topPosition(state.world.grid, nearbyCellId);
      const materialId = voxelAt(state.world.grid, position.x, position.y, position.z);
      return { position, materialId };
    })
    .filter((target) => materialHas(target.materialId, 'hot'))
    .sort((left, right) => left.position.x - right.position.x
      || left.position.y - right.position.y
      || left.position.z - right.position.z)[0] ?? null;
}
