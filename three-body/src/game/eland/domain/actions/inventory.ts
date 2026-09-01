import type { ContainerState } from '../container';
import type { MaterialId } from '../material';
import type { DropState, SimulationState } from '../model';
import type { ItemStack, PersonState } from '../person';
import { surfaceStandingPosition } from '../../world/grid';

export const ITEM_SOURCE_EVENT_LIMIT = 24;

export function boundedItemSourceEventIds(sourceEventIds: readonly string[]): string[] {
  return [...new Set(sourceEventIds)].slice(-ITEM_SOURCE_EVENT_LIMIT);
}

export function removeEmptyStacks(person: PersonState): void {
  person.inventory = person.inventory.filter((stack) => stack.quantity > 0);
}

export function addInventory(
  person: PersonState,
  materialId: MaterialId,
  quantity: number,
  sourceEventIds: string[],
  stackId = `stack-${person.id}-${materialId}`,
  recordPayloadId?: string,
  sourceLineageKeys: string[] = [],
): ItemStack {
  const existing = person.inventory.find((stack) => stack.materialId === materialId
    && stack.recordPayloadId === recordPayloadId);
  if (existing) {
    existing.quantity += quantity;
    existing.sourceEventIds = boundedItemSourceEventIds([
      ...existing.sourceEventIds,
      ...sourceEventIds,
    ]);
    existing.sourceLineageKeys = [...new Set([
      ...(existing.sourceLineageKeys ?? []),
      ...sourceLineageKeys,
    ])].slice(-32);
    return existing;
  }
  const stack = {
    id: stackId,
    materialId,
    quantity,
    sourceEventIds: boundedItemSourceEventIds(sourceEventIds),
    ...(sourceLineageKeys.length ? { sourceLineageKeys: [...new Set(sourceLineageKeys)].slice(-32) } : {}),
    ...(recordPayloadId ? { recordPayloadId } : {}),
  };
  person.inventory.push(stack);
  return stack;
}

export function addContainedInventory(
  person: PersonState,
  materialId: MaterialId,
  quantity: number,
  containerStackId: string,
  sourceEventIds: string[],
  stackId = `stack-${person.id}-${materialId}-${containerStackId}`,
  sourceLineageKeys: string[] = [],
): ItemStack {
  const existing = person.inventory.find((stack) => stack.materialId === materialId
    && stack.containedByStackId === containerStackId);
  if (existing) {
    existing.quantity += quantity;
    existing.sourceEventIds = boundedItemSourceEventIds([...existing.sourceEventIds, ...sourceEventIds]);
    existing.sourceLineageKeys = [...new Set([
      ...(existing.sourceLineageKeys ?? []),
      ...sourceLineageKeys,
    ])].slice(-32);
    return existing;
  }
  const stack: ItemStack = {
    id: stackId,
    materialId,
    quantity,
    containedByStackId: containerStackId,
    sourceEventIds: boundedItemSourceEventIds(sourceEventIds),
    ...(sourceLineageKeys.length ? { sourceLineageKeys: [...new Set(sourceLineageKeys)].slice(-32) } : {}),
  };
  person.inventory.push(stack);
  return stack;
}

export function addContainerInventory(
  container: ContainerState,
  materialId: MaterialId,
  quantity: number,
  sourceEventIds: string[],
  stackId: string,
  recordPayloadId?: string,
  sourceLineageKeys: string[] = [],
): ItemStack {
  const existing = container.inventory.find((stack) => stack.materialId === materialId
    && stack.recordPayloadId === recordPayloadId);
  if (existing) {
    existing.quantity += quantity;
    existing.sourceEventIds = boundedItemSourceEventIds([
      ...existing.sourceEventIds,
      ...sourceEventIds,
    ]);
    existing.sourceLineageKeys = [...new Set([
      ...(existing.sourceLineageKeys ?? []),
      ...sourceLineageKeys,
    ])].slice(-32);
    return existing;
  }
  const stack = {
    id: stackId,
    materialId,
    quantity,
    sourceEventIds: boundedItemSourceEventIds(sourceEventIds),
    ...(sourceLineageKeys.length ? { sourceLineageKeys: [...new Set(sourceLineageKeys)].slice(-32) } : {}),
    ...(recordPayloadId ? { recordPayloadId } : {}),
  };
  container.inventory.push(stack);
  return stack;
}

export function addDrop(
  state: SimulationState,
  materialId: MaterialId,
  quantity: number,
  cell: number,
  atMonth: number,
  sourceEventIds: string[],
  idHint: string,
  recordPayloadId?: string,
  z?: number,
  sourceLineageKeys: string[] = [],
  estateOfPersonId?: string,
  projectMaterialDelivery?: DropState['projectMaterialDelivery'],
): DropState {
  const resolvedZ = z ?? surfaceStandingPosition(state.world.grid, cell)?.z ?? 1;
  const existing = state.world.drops.find((drop) => drop.cellId === cell
    && drop.z === resolvedZ
    && drop.materialId === materialId
    && drop.recordPayloadId === recordPayloadId
    && drop.estateOfPersonId === estateOfPersonId
    && drop.projectMaterialDelivery?.requestEventId === projectMaterialDelivery?.requestEventId
    && drop.projectMaterialDelivery?.projectId === projectMaterialDelivery?.projectId
    && drop.projectMaterialDelivery?.requesterId === projectMaterialDelivery?.requesterId
    && drop.projectMaterialDelivery?.expiresAtMonth === projectMaterialDelivery?.expiresAtMonth
    && drop.quantity > 0);
  if (existing) {
    existing.quantity += quantity;
    existing.sourceEventIds = boundedItemSourceEventIds([
      ...existing.sourceEventIds,
      ...sourceEventIds,
    ]);
    existing.sourceLineageKeys = [...new Set([
      ...(existing.sourceLineageKeys ?? []),
      ...sourceLineageKeys,
    ])].slice(-32);
    return existing;
  }
  const drop: DropState = {
    id: `drop-${atMonth}-${idHint}-${state.world.drops.length}`,
    materialId,
    cellId: cell,
    z: resolvedZ,
    quantity,
    createdAtMonth: atMonth,
    sourceEventIds: boundedItemSourceEventIds(sourceEventIds),
    ...(sourceLineageKeys.length ? { sourceLineageKeys: [...new Set(sourceLineageKeys)].slice(-32) } : {}),
    ...(recordPayloadId ? { recordPayloadId } : {}),
    ...(estateOfPersonId ? { estateOfPersonId } : {}),
    ...(projectMaterialDelivery ? { projectMaterialDelivery: { ...projectMaterialDelivery } } : {}),
  };
  state.world.drops.push(drop);
  return drop;
}
