import type { DropState, SimulationState } from '../../domain/model';
import { Material } from '../../domain/material';
import type { PersonState } from '../../domain/person';
import { cellsInRadius, voxelAt } from '../../world/grid';

export function visibleCellsFor(person: PersonState): number[] {
  return cellsInRadius(person.position.cellId, 4 + Math.floor(person.baselineCapacities.perception / 25));
}

export function visibleDropsFor(state: SimulationState, person: PersonState): DropState[] {
  const visible = new Set(visibleCellsFor(person));
  return state.world.drops.filter((drop) => drop.quantity > 0 && visible.has(drop.cellId));
}

export function locallyKnownPlacedContainer(
  state: SimulationState,
  person: PersonState,
  container: SimulationState['containers'][number],
): boolean {
  const materialId = voxelAt(
    state.world.grid,
    container.position.x,
    container.position.y,
    container.position.z,
  );
  if (materialId !== Material.Container) return false;
  const containerCellId = container.position.x + container.position.y * state.world.grid.width;
  if (visibleCellsFor(person).includes(containerCellId)) return true;
  return person.knownPlaces.some((place) => place.materialId === Material.Container
    && place.position.x === container.position.x
    && place.position.y === container.position.y
    && place.position.z === container.position.z);
}
