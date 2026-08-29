import type { PrimitiveAction } from './action';
import {
  canAccessContainer,
  canAccessContainerFrom,
  containerById,
  containerCell,
  type ContainerState,
} from './container';
import type { DecisionAuthorityState } from './model';
import type { ItemStack, PersonState } from './person';
import {
  cellsInRadius,
  findStandingPath,
  neighbors4,
  standingPositions,
  type StandingPosition,
} from '../world/grid';

export interface CurrentVisibleStoredMaterialAccess {
  container: ContainerState;
  stack: ItemStack;
  accessPosition: StandingPosition;
  pathLength: number;
}

export function currentPerceptionRadius(person: PersonState): number {
  return 4 + Math.floor(person.baselineCapacities.perception / 25);
}

/**
 * Reads live inventory only from a currently visible, still-physical container
 * with a reachable operating position. Remembered places are deliberately not
 * consulted because they cannot reveal current stock.
 */
export function findCurrentVisibleStoredMaterialAccess(
  state: Pick<DecisionAuthorityState, 'containers' | 'world'>,
  person: PersonState,
  accepts: (stack: ItemStack) => boolean,
): CurrentVisibleStoredMaterialAccess | null {
  const radius = currentPerceptionRadius(person);
  const visibleCells = new Set(cellsInRadius(person.position.cellId, radius));
  return state.containers
    .flatMap((candidate) => {
      const container = containerById(state, candidate.id);
      if (!container
        || !visibleCells.has(containerCell(container))
        || Math.abs(container.position.z - person.position.z) > radius) return [];
      const access = [containerCell(container), ...neighbors4(containerCell(container))]
        .flatMap((cell) => standingPositions(state.world.grid, cell))
        .filter((position) => canAccessContainerFrom(position, container))
        .map((position) => ({ position, path: findStandingPath(state.world.grid, person.position, position) }))
        .filter(({ path }) => path.length > 0)
        .sort((left, right) => left.path.length - right.path.length
          || left.position.cellId - right.position.cellId
          || left.position.z - right.position.z)[0];
      if (!access) return [];
      return container.inventory
        .filter((stack) => stack.quantity > 0 && accepts(stack))
        .map((stack) => ({
          container,
          stack,
          accessPosition: access.position,
          pathLength: access.path.length,
        }));
    })
    .sort((left, right) => left.pathLength - right.pathLength
      || left.container.id.localeCompare(right.container.id)
      || left.stack.id.localeCompare(right.stack.id))[0] ?? null;
}

export function retrieveStoredMaterialOrMove(
  person: PersonState,
  stored: CurrentVisibleStoredMaterialAccess,
): PrimitiveAction {
  return canAccessContainer(person, stored.container)
    ? {
      kind: 'transfer',
      materialId: stored.stack.materialId,
      quantity: 1,
      from: { kind: 'container', containerId: stored.container.id },
      to: { kind: 'person', personId: person.id },
      stackId: stored.stack.id,
    }
    : { kind: 'move', toCellId: stored.accessPosition.cellId, toZ: stored.accessPosition.z };
}
