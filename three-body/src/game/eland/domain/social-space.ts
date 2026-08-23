import type { SimulationState } from './model';
import { isAlive, type PersonState } from './person';
import {
  cellX,
  cellY,
  cellsInRadius,
  findStandingPath,
  standingPositions,
  type StandingPosition,
} from '../world/grid';

/** Ordinary speech can cross one horizontal cell and one standing level. */
export const VOICE_HORIZONTAL_RANGE = 1;
export const VOICE_VERTICAL_RANGE = 1;

/** More than two people on one exact standing position creates a soft pressure to spread out. */
export const SOFT_STANDING_CAPACITY = 2;

export function positionsWithinVoiceRange(
  first: StandingPosition,
  second: StandingPosition,
): boolean {
  const horizontal = Math.abs(cellX(first.cellId) - cellX(second.cellId))
    + Math.abs(cellY(first.cellId) - cellY(second.cellId));
  return horizontal <= VOICE_HORIZONTAL_RANGE
    && Math.abs(first.z - second.z) <= VOICE_VERTICAL_RANGE;
}

export function peopleWithinVoiceRange(person: PersonState, people: PersonState[]): PersonState[] {
  return people.filter((other) => other.id !== person.id
    && isAlive(other)
    && positionsWithinVoiceRange(person.position, other.position));
}

export function standingOccupancy(
  state: SimulationState,
  position: StandingPosition,
  excludePersonId?: string,
): number {
  return state.people.filter((candidate) => candidate.id !== excludePersonId
    && isAlive(candidate)
    && candidate.position.cellId === position.cellId
    && candidate.position.z === position.z).length;
}

export interface SocialRendezvous {
  position: StandingPosition;
  path: StandingPosition[];
  occupancy: number;
}

/**
 * Find a reachable, low-occupancy standing position from which the listener can
 * hear ordinary speech. The listener's exact position is legal but deliberately
 * loses ties to an equally occupied adjacent position.
 */
export function conversationalRendezvous(
  state: SimulationState,
  mover: PersonState,
  listener: PersonState,
): SocialRendezvous | null {
  if (positionsWithinVoiceRange(mover.position, listener.position)) {
    return {
      position: { cellId: mover.position.cellId, z: mover.position.z },
      path: [{ cellId: mover.position.cellId, z: mover.position.z }],
      occupancy: standingOccupancy(state, mover.position, mover.id),
    };
  }
  const candidates = cellsInRadius(listener.position.cellId, VOICE_HORIZONTAL_RANGE)
    .flatMap((cellId) => standingPositions(state.world.grid, cellId))
    .filter((position) => positionsWithinVoiceRange(position, listener.position))
    .flatMap((position) => {
      const path = findStandingPath(state.world.grid, mover.position, position);
      return path.length ? [{
        position,
        path,
        occupancy: standingOccupancy(state, position, mover.id),
      }] : [];
    })
    .sort((left, right) => left.occupancy - right.occupancy
      || Number(left.position.cellId === listener.position.cellId && left.position.z === listener.position.z)
        - Number(right.position.cellId === listener.position.cellId && right.position.z === listener.position.z)
      || left.path.length - right.path.length
      || left.position.cellId - right.position.cellId
      || left.position.z - right.position.z);
  return candidates[0] ?? null;
}

export function crowdingUrgency(state: SimulationState, person: PersonState): number {
  const excess = Math.max(0, standingOccupancy(state, person.position) - SOFT_STANDING_CAPACITY);
  return excess <= 0 ? 0 : Math.min(0.72, 0.16 + excess / (excess + 6) * 0.56);
}

/** One-cell voluntary step that strictly lowers exact-position occupancy. */
export function crowdingReliefTarget(
  state: SimulationState,
  person: PersonState,
): SocialRendezvous | null {
  const currentOccupancy = standingOccupancy(state, person.position);
  if (currentOccupancy <= SOFT_STANDING_CAPACITY) return null;
  const candidates = cellsInRadius(person.position.cellId, 1)
    .filter((cellId) => cellId !== person.position.cellId)
    .flatMap((cellId) => standingPositions(state.world.grid, cellId))
    .flatMap((position) => {
      const occupancy = standingOccupancy(state, position, person.id);
      if (occupancy >= currentOccupancy) return [];
      const path = findStandingPath(state.world.grid, person.position, position);
      return path.length ? [{ position, path, occupancy }] : [];
    })
    .sort((left, right) => left.occupancy - right.occupancy
      || left.path.length - right.path.length
      || left.position.cellId - right.position.cellId
      || left.position.z - right.position.z);
  return candidates[0] ?? null;
}
