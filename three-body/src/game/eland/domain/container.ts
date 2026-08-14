import type { ItemStack, PersonState } from './person';
import type { SimulationState } from './model';
import { Material } from './material';
import { cellId, cellX, cellY, voxelAt } from '../world/grid';

export interface ContainerState {
  id: string;
  position: { x: number; y: number; z: number };
  inventory: ItemStack[];
  createdAtMonth: number;
  sourceEventIds: string[];
}

export function containerIdAt(position: { x: number; y: number; z: number }): string {
  return `container:${position.x}:${position.y}:${position.z}`;
}

export function containerById(state: SimulationState, id: string): ContainerState | undefined {
  const container = state.containers.find((candidate) => candidate.id === id);
  return container && voxelAt(state.world.grid, container.position.x, container.position.y, container.position.z) === Material.Container
    ? container
    : undefined;
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
