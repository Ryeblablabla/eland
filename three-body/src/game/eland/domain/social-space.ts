import type { DecisionAuthorityState, SimulationState } from './model';
import { isAlive, type PersonState } from './person';
import {
  cellsInRadius,
  cellX,
  cellY,
  findStandingPath,
  isCellId,
  standingPositions,
  voxelAt,
  type StandingPosition,
  type VoxelWorld,
} from '../world/grid';
import { Material } from './material';

/** More than two people on one exact standing position creates a soft pressure to spread out. */
export const SOFT_STANDING_CAPACITY = 2;

/** Every finite position can receive a non-zero signal; execution decides how much survives. */
export function positionsCanShareLanguage(
  first: StandingPosition,
  second: StandingPosition,
): boolean {
  return isCellId(first.cellId)
    && isCellId(second.cellId)
    && Number.isFinite(first.z)
    && Number.isFinite(second.z);
}

export function visibleLanguageCandidates(person: PersonState, people: PersonState[]): PersonState[] {
  return people.filter((other) => other.id !== person.id
    && isAlive(other)
    && positionsCanShareLanguage(person.position, other.position));
}

export function standingOccupancy(
  state: Pick<DecisionAuthorityState, 'people'>,
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
 * Language no longer forces a rendezvous. A person speaks from their current
 * position and material-aware propagation decides what reaches everybody.
 */
export function conversationalRendezvous(
  state: SimulationState,
  mover: PersonState,
  listener: PersonState,
): SocialRendezvous | null {
  void listener;
  return {
    position: { cellId: mover.position.cellId, z: mover.position.z },
    path: [{ cellId: mover.position.cellId, z: mover.position.z }],
    occupancy: standingOccupancy(state, mover.position, mover.id),
  };
}

/** Adjacent bodies can touch across an open shared face, never through a floor or wall. */
export function positionsCanTouch(world: VoxelWorld, first: StandingPosition, second: StandingPosition): boolean {
  if (!isCellId(first.cellId) || !isCellId(second.cellId)
    || !Number.isInteger(first.z) || !Number.isInteger(second.z)) return false;
  const horizontal = Math.abs(cellX(first.cellId) - cellX(second.cellId))
    + Math.abs(cellY(first.cellId) - cellY(second.cellId));
  if (horizontal > 1 || Math.abs(first.z - second.z) > 1
    || (horizontal === 0 && first.z !== second.z)) return false;
  const sharedHeight = Math.max(first.z, second.z);
  return [first, second].every((position) => voxelAt(
    world, cellX(position.cellId), cellY(position.cellId), sharedHeight,
  ) === Material.Air);
}

/** Find a reachable place beside the other person; sharing their exact voxel is unnecessary. */
export function physicalRendezvous(state: SimulationState, mover: PersonState, other: PersonState): SocialRendezvous | null {
  if (positionsCanTouch(state.world.grid, mover.position, other.position)) return {
    position: { cellId: mover.position.cellId, z: mover.position.z },
    path: [{ cellId: mover.position.cellId, z: mover.position.z }],
    occupancy: standingOccupancy(state, mover.position, mover.id),
  };
  return cellsInRadius(other.position.cellId, 1)
    .filter((candidate) => candidate !== other.position.cellId)
    .flatMap((candidate) => standingPositions(state.world.grid, candidate))
    .filter((position) => positionsCanTouch(state.world.grid, position, other.position))
    .flatMap((position) => {
      const path = findStandingPath(state.world.grid, mover.position, position);
      return path.length ? [{ position, path, occupancy: standingOccupancy(state, position, mover.id) }] : [];
    })
    .sort((left, right) => left.occupancy - right.occupancy || left.path.length - right.path.length
      || left.position.cellId - right.position.cellId || left.position.z - right.position.z)[0] ?? null;
}

export function crowdingUrgency(
  state: Pick<DecisionAuthorityState, 'people'>,
  person: PersonState,
): number {
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
