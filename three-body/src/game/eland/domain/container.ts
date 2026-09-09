import type { ItemStack, PersonState } from './person';
import type { DecisionAuthorityState } from './model';
import { Material } from './material';
import { cellId, cellX, cellY, voxelAt } from '../world/grid';
import { workStorageSpaces } from './work-storage';
import { workById } from './works';

export interface ContainerState {
  id: string;
  position: { x: number; y: number; z: number };
  inventory: ItemStack[];
  createdAtMonth: number;
  sourceEventIds: string[];
  /** Physical capacity belongs to the placed object, not to a global unlock. */
  capacity?: number;
  /** An actual open cavity in a Work, separate from legacy container voxels. */
  carrier?: { kind: 'work'; workId: string; cavityPoint: { x: number; y: number; z: number } };
  retainsWater?: boolean;
}

export const CONTAINER_CAPACITY = 24;
export const GRANARY_CAPACITY = 96;

export function containerIdAt(position: { x: number; y: number; z: number }): string {
  return `container:${position.x}:${position.y}:${position.z}`;
}

export function containerById(
  state: Pick<DecisionAuthorityState, 'containers' | 'world'>,
  id: string,
): ContainerState | undefined {
  const container = state.containers.find((candidate) => candidate.id === id);
  if (!container) return undefined;
  if (container.carrier) {
    const work = workById(state.world, container.carrier.workId);
    const point = container.carrier.cavityPoint;
    return work && workStorageSpaces(state.world, work).some((space) => space.cells.some((cell) =>
      cell.x === point.x && cell.y === point.y && cell.z === point.z)) ? container : undefined;
  }
  const materialId = voxelAt(state.world.grid, container.position.x, container.position.y, container.position.z);
  return materialId === Material.Container || materialId === Material.Granary ? container : undefined;
}

/** A Work with several separate cavities requires a specific container ref. */
export function containerForWork(
  state: Pick<DecisionAuthorityState, 'containers' | 'world'>,
  workId: string,
): ContainerState | undefined {
  const containers = state.containers.filter((candidate) => candidate.carrier?.workId === workId
    && containerById(state, candidate.id));
  return containers.length === 1 ? containers[0] : undefined;
}

export function containerCell(container: ContainerState): number {
  return cellId(container.position.x, container.position.y);
}

export function canAccessContainerFrom(position: { cellId: number; z: number }, container: ContainerState): boolean {
  const horizontal = Math.abs(cellX(position.cellId) - container.position.x)
    + Math.abs(cellY(position.cellId) - container.position.y);
  return horizontal <= 1 && Math.abs(position.z - container.position.z) <= 2;
}

/** 容器是有体素位置的持有者；接触范围只决定能否操作，不授予任何所有权。 */
export function canAccessContainer(person: PersonState, container: ContainerState): boolean {
  return canAccessContainerFrom(person.position, container);
}

export function containerQuantity(container: ContainerState, materialId: number): number {
  return container.inventory.reduce((sum, stack) => sum + (stack.materialId === materialId ? stack.quantity : 0), 0);
}

export function containerUsedCapacity(container: ContainerState): number {
  return container.inventory.reduce((sum, stack) => sum + stack.quantity, 0);
}

export function containerRemainingCapacity(container: ContainerState): number {
  return Math.max(0, (container.capacity ?? CONTAINER_CAPACITY) - containerUsedCapacity(container));
}
