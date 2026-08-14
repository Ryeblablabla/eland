import type { ActionOption, PrimitiveAction } from '../domain/action';
import { canAccessContainer, canAccessContainerFrom, containerCell, containerQuantity, type ContainerState } from '../domain/container';
import { Material, materialDefinition, materialHas } from '../domain/material';
import { inventoryQuantity, type PersonState } from '../domain/person';
import type { SimulationState } from '../domain/model';
import { findStandingPath, neighbors4, standingPositions, type StandingPosition } from '../world/grid';

export interface ContainerAccess {
  container: ContainerState;
  position: StandingPosition;
  pathLength: number;
  remembered: boolean;
  sourceEventIds: string[];
}

function knownEvidence(person: PersonState, container: ContainerState): string[] {
  return person.knownPlaces.flatMap((place) => place.materialId === Material.Container
    && place.position.x === container.position.x
    && place.position.y === container.position.y
    && place.position.z === container.position.z
    ? place.sourceEventIds
    : []);
}

export function findContainerAccess(
  state: SimulationState,
  person: PersonState,
  container: ContainerState,
  visibleCells?: Set<number>,
): ContainerAccess | null {
  const cell = containerCell(container);
  const seenNow = visibleCells?.has(cell) ?? false;
  const rememberedSourceIds = knownEvidence(person, container);
  if (visibleCells && !seenNow && rememberedSourceIds.length === 0) return null;
  const candidates = [cell, ...neighbors4(cell)]
    .flatMap((candidateCell) => standingPositions(state.world.grid, candidateCell))
    .filter((position) => canAccessContainerFrom(position, container))
    .map((position) => ({ position, path: findStandingPath(state.world.grid, person.position, position) }))
    .filter(({ path }) => path.length > 0)
    .sort((a, b) => a.path.length - b.path.length || a.position.cellId - b.position.cellId || a.position.z - b.position.z);
  const best = candidates[0];
  return best ? {
    container,
    position: best.position,
    pathLength: best.path.length,
    remembered: !seenNow,
    sourceEventIds: seenNow ? [] : [...new Set(rememberedSourceIds)],
  } : null;
}

function transferOrMove(person: PersonState, access: ContainerAccess, action: PrimitiveAction): PrimitiveAction {
  return canAccessContainer(person, access.container)
    ? action
    : { kind: 'move', toCellId: access.position.cellId, toZ: access.position.z };
}

/** 容器只提供 transfer 候选，不推断所有者，也不把“仓储”增加为新动作。 */
export function buildContainerOptions(state: SimulationState, person: PersonState, visibleCells: number[]): ActionOption[] {
  const visible = new Set(visibleCells);
  const access = state.containers
    .flatMap((container) => {
      const candidate = findContainerAccess(state, person, container, visible);
      return candidate ? [candidate] : [];
    })
    .sort((a, b) => a.pathLength - b.pathLength || a.container.id.localeCompare(b.container.id))[0];
  if (!access) return [];
  const options: ActionOption[] = [];
  const deposits = person.inventory
    .filter((stack) => stack.quantity >= 2
      && stack.materialId !== Material.Container
      && (!materialHas(stack.materialId, 'edible') || person.body.nutrition >= 58))
    .sort((a, b) => b.quantity - a.quantity || a.materialId - b.materialId)
    .slice(0, 2);
  for (const stack of deposits) {
    const quantity = Math.min(3, stack.quantity - 1);
    const current = containerQuantity(access.container, stack.materialId);
    const transfer: PrimitiveAction = {
      kind: 'transfer', materialId: stack.materialId, quantity,
      from: { kind: 'person', personId: person.id }, to: { kind: 'container', containerId: access.container.id }, stackId: stack.id,
    };
    options.push({
      id: `store-container:${access.container.id}:${stack.id}`,
      summary: `把${materialDefinition(stack.materialId).name}存入木制容器`,
      reason: `自己携带${stack.quantity}份，可留下1份并把剩余物质移入真实容器`,
      goal: { kind: 'container-inventory-at-least', containerId: access.container.id, materialId: stack.materialId, quantity: current + quantity },
      nextAction: transferOrMove(person, access, transfer),
      target: { kind: 'container', containerId: access.container.id },
      estimatedDuration: access.pathLength <= 2 ? 'one-month' : 'several-months',
      sourceFactIds: [...new Set([...access.sourceEventIds, ...stack.sourceEventIds])],
    });
  }
  for (const stack of [...access.container.inventory]
    .filter((item) => item.quantity > 0)
    .sort((a, b) => Number(materialHas(b.materialId, 'edible')) - Number(materialHas(a.materialId, 'edible')) || b.quantity - a.quantity || a.materialId - b.materialId)
    .slice(0, 2)) {
    const transfer: PrimitiveAction = {
      kind: 'transfer', materialId: stack.materialId, quantity: 1,
      from: { kind: 'container', containerId: access.container.id }, to: { kind: 'person', personId: person.id }, stackId: stack.id,
    };
    options.push({
      id: `retrieve-container:${access.container.id}:${stack.id}`,
      summary: `从木制容器取出${materialDefinition(stack.materialId).name}`,
      reason: '容器中实际存有这种物质，取出后才会进入私人背包',
      goal: { kind: 'inventory-at-least', materialId: stack.materialId, quantity: inventoryQuantity(person, stack.materialId) + 1 },
      nextAction: transferOrMove(person, access, transfer),
      target: { kind: 'container', containerId: access.container.id },
      estimatedDuration: access.pathLength <= 2 ? 'one-month' : 'several-months',
      sourceFactIds: [...new Set([...access.sourceEventIds, ...stack.sourceEventIds])],
    });
  }
  return options;
}
