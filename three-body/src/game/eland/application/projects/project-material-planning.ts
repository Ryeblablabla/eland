import type { DropState, SimulationState } from '../../domain/model';
import { materialDefinition, type MaterialId } from '../../domain/material';
import type { ItemStack, PersonState } from '../../domain/person';
import type {
  ProjectMaterialDemand,
  ProjectReservation,
} from '../../domain/project';
import { canPersonPlanToCollectProjectMaterialDrop } from '../../domain/project-material-request';
import { cellX, cellY, findStandingPath } from '../../world/grid';
import type { ProjectStep } from './project-step';

export function reservation(person: PersonState, stackId: string, quantity = 1): ProjectReservation[] {
  const stack = person.inventory.find((candidate) => candidate.id === stackId);
  return stack ? [{ personId: person.id, stackId, materialId: stack.materialId, quantity }] : [];
}

export function isConsumableProjectStack(stack: ItemStack): boolean {
  return stack.quantity > 0 && !stack.recordPayloadId;
}

export function consumableInventoryQuantity(person: PersonState, materialId: MaterialId): number {
  return person.inventory
    .filter((stack) => stack.materialId === materialId && isConsumableProjectStack(stack))
    .reduce((sum, stack) => sum + stack.quantity, 0);
}

export function materialDemand(
  person: PersonState,
  materialId: MaterialId,
  requiredQuantity: number,
  branchKey: string,
  sourceFactIds: string[] = [],
): ProjectMaterialDemand {
  const availableQuantity = consumableInventoryQuantity(person, materialId);
  return {
    materialId,
    requiredQuantity: Math.max(0, Math.floor(requiredQuantity)),
    availableQuantity,
    outstandingQuantity: Math.max(0, Math.floor(requiredQuantity) - availableQuantity),
    branchKey,
    sourceFactIds: [...new Set(sourceFactIds)],
  };
}

export function dropStep(
  person: PersonState,
  drop: DropState,
  purpose: string,
  demand = materialDemand(
    person,
    drop.materialId,
    consumableInventoryQuantity(person, drop.materialId) + 1,
    `direct:${drop.materialId}`,
  ),
): ProjectStep | null {
  if (demand.materialId !== drop.materialId || demand.outstandingQuantity <= 0) return null;
  const material = materialDefinition(drop.materialId).name;
  const together = person.position.cellId === drop.cellId && person.position.z === drop.z;
  const requestedQuantity = Math.min(demand.outstandingQuantity, drop.quantity);
  if (requestedQuantity <= 0) return null;
  return {
    key: `collect-${drop.id}`,
    summary: `为${purpose}取得${material}`,
    reason: `眼前可见的${material}符合当前项目缺少的物质性质`,
    action: together
      ? {
          kind: 'transfer', materialId: drop.materialId, quantity: requestedQuantity,
          from: { kind: 'ground', cellId: drop.cellId, z: drop.z }, to: { kind: 'person', personId: person.id }, dropId: drop.id,
        }
      : { kind: 'move', toCellId: drop.cellId, toZ: drop.z },
    target: { kind: 'drop', dropId: drop.id },
    sourceFactIds: drop.sourceEventIds,
    missingMaterialIds: [drop.materialId],
    materialDemands: [structuredClone(demand)],
    reservations: [],
  };
}

export function nearestDrop(
  state: SimulationState,
  person: PersonState,
  drops: DropState[],
  materialIds: Iterable<MaterialId>,
): DropState | undefined {
  const wanted = new Set(materialIds);
  return drops
    .filter((drop) => wanted.has(drop.materialId)
      && canPersonPlanToCollectProjectMaterialDrop(state, person.id, drop, state.clock.elapsedMonths + 1))
    .flatMap((drop) => {
      const path = findStandingPath(state.world.grid, person.position, { cellId: drop.cellId, z: drop.z });
      return path.length ? [{ drop, pathLength: path.length }] : [];
    })
    .sort((a, b) => a.pathLength - b.pathLength || a.drop.id.localeCompare(b.drop.id))[0]?.drop;
}

export function nearestRememberedDrop(
  state: SimulationState,
  person: PersonState,
  materialIds: Iterable<MaterialId>,
): DropState | undefined {
  const wanted = new Set(materialIds);
  const remembered = person.knownPlaces.filter((place) => wanted.has(place.materialId));
  return state.world.drops
    .filter((drop) => drop.quantity > 0
      && wanted.has(drop.materialId)
      && canPersonPlanToCollectProjectMaterialDrop(state, person.id, drop, state.clock.elapsedMonths + 1))
    .filter((drop) => remembered.some((place) => place.materialId === drop.materialId
      && place.position.x === cellX(drop.cellId)
      && place.position.y === cellY(drop.cellId)
      && place.position.z === drop.z))
    .flatMap((drop) => {
      const path = findStandingPath(state.world.grid, person.position, { cellId: drop.cellId, z: drop.z });
      return path.length ? [{ drop, pathLength: path.length }] : [];
    })
    .sort((left, right) => left.pathLength - right.pathLength || left.drop.id.localeCompare(right.drop.id))[0]?.drop;
}
