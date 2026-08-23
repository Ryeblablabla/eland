import type { VoxelPosition } from '../action';
import type { SimulationState } from '../model';
import type { MaterialId } from '../material';
import { isAlive, type PersonState } from '../person';
import { cellId, cellX, cellY, cellsInRadius, surfaceMaterial } from '../../world/grid';

export function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

export function sameIds(first: string[], second: string[]): boolean {
  return [...new Set(first)].sort().join(',') === [...new Set(second)].sort().join(',');
}

export function samePosition(left: VoxelPosition, right: VoxelPosition): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

export function distanceToPosition(person: PersonState, position: VoxelPosition): number {
  const horizontal = Math.abs(cellX(person.position.cellId) - position.x)
    + Math.abs(cellY(person.position.cellId) - position.y);
  // 双脚以上两格是身体与手臂可及范围；相邻列的头部高度体素仍可被操作。
  const vertical = Math.max(0, Math.abs(person.position.z - position.z) - 1);
  return Math.max(horizontal, vertical);
}

export function bodyOccupies(state: SimulationState, position: VoxelPosition): boolean {
  const targetCell = cellId(position.x, position.y);
  return state.people.some((candidate) => isAlive(candidate)
    && candidate.position.cellId === targetCell
    && (candidate.position.z === position.z || candidate.position.z + 1 === position.z));
}

export function bodyStandsOn(state: SimulationState, position: VoxelPosition): boolean {
  const targetCell = cellId(position.x, position.y);
  return state.people.some((candidate) => isAlive(candidate)
    && candidate.position.cellId === targetCell
    && candidate.position.z === position.z + 1);
}

export function nearbyFacilityMaterialAtCell(
  state: SimulationState,
  originCellId: number,
  materialIds: readonly MaterialId[],
  radius = 1,
): MaterialId | undefined {
  const accepted = new Set(materialIds);
  return cellsInRadius(originCellId, radius)
    .map((cell) => surfaceMaterial(state.world.grid, cell))
    .find((materialId) => accepted.has(materialId));
}

export function nearbyFacilityMaterial(
  state: SimulationState,
  person: PersonState,
  materialIds: readonly MaterialId[],
  radius = 1,
): MaterialId | undefined {
  return nearbyFacilityMaterialAtCell(state, person.position.cellId, materialIds, radius);
}
