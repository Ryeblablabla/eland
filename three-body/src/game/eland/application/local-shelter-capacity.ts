import type { SimulationState } from '../domain/model';
import { isAlive, type PersonState } from '../domain/person';
import { shelterGeometryAt } from '../domain/structure';
import { neighbors4, standingPositions } from '../world/grid';

export interface LocalShelterCapacityObservation {
  visiblePersonCount: number;
  shelterCapacity: number;
  occupiedShelterSlots: number;
  freeShelterSlots: number;
  capacityShortfall: number;
  unshelteredPersonIds: string[];
}

function positionKey(position: { cellId: number; z: number }): string {
  return `${position.cellId}:${position.z}`;
}

/**
 * Count only shelter interiors whose complete local geometry is visible to the
 * observer. This is a planning perception, not a global housing statistic.
 */
export function observeLocalShelterCapacity(
  state: SimulationState,
  observer: PersonState,
  visibleCells: readonly number[],
  visiblePeople: readonly PersonState[],
): LocalShelterCapacityObservation {
  const visible = new Set([...visibleCells, observer.position.cellId]);
  const shelterSlotKeys = new Set([...visible].flatMap((cell) => {
    if (!neighbors4(cell).every((neighbor) => visible.has(neighbor))) return [];
    return standingPositions(state.world.grid, cell)
      .filter((position) => Boolean(shelterGeometryAt(state.world.grid, position)))
      .map(positionKey);
  }));
  const people = [...new Map([observer, ...visiblePeople]
    .filter(isAlive)
    .map((person) => [person.id, person])).values()];
  const shelteredPeople = people.filter((person) => shelterSlotKeys.has(positionKey(person.position)));
  const occupiedShelterSlots = new Set(shelteredPeople.map((person) => positionKey(person.position))).size;
  return {
    visiblePersonCount: people.length,
    shelterCapacity: shelterSlotKeys.size,
    occupiedShelterSlots,
    freeShelterSlots: Math.max(0, shelterSlotKeys.size - occupiedShelterSlots),
    capacityShortfall: Math.max(0, people.length - shelterSlotKeys.size),
    unshelteredPersonIds: people
      .filter((person) => !shelterSlotKeys.has(positionKey(person.position)))
      .map((person) => person.id),
  };
}
