import type { Agreement } from './agreement';
import type { SharedLivingAnchor } from './action';
import { worldEventById } from './event-index';
import type { DecisionAuthorityState, SimulationState } from './model';
import type { PersonState } from './person';
import { livingPeople } from './state-index';
import {
  cellX,
  cellY,
  cellsInRadius,
  findStandingPath,
  standingPositions,
  type StandingPosition,
} from '../world/grid';

export const SHARED_LIVING_RADIUS = 2;
export const REQUIRED_SHARED_LIVING_MONTHS = 12;
/** Established companions may travel independently for two full calendar months. */
export const ESTABLISHED_COMPANION_RETURN_AFTER_AWAY_MONTHS = 3;
/**
 * Once a companionship is established, every three additional months that
 * both parties actually spend in their agreed living area provide one small,
 * replayable unit of relationship evidence.  This is deliberately slower
 * than joint work, while still letting a kept long-term commitment matter.
 */
export const SHARED_LIVING_RELATION_EVIDENCE_INTERVAL_MONTHS = 3;

function validAnchor(value: SharedLivingAnchor | undefined): value is SharedLivingAnchor {
  return value?.version === 'shared-living-anchor-v1'
    && Number.isInteger(value.cellId)
    && Number.isInteger(value.z)
    && Number.isInteger(value.radius)
    && value.radius >= 1
    && value.radius <= 4;
}

/** Legacy active agreements recover the same stable place from their offer fact. */
export function companionLivingAnchor(
  state: Pick<DecisionAuthorityState, 'world'>,
  agreement: Agreement,
): SharedLivingAnchor | null {
  if (agreement.proposal.kind !== 'companion') return null;
  if (validAnchor(agreement.proposal.sharedLivingAnchor)) {
    return { ...agreement.proposal.sharedLivingAnchor };
  }
  const source = worldEventById(state, agreement.proposalEventId);
  if (source?.kind !== 'action') return null;
  return {
    version: 'shared-living-anchor-v1',
    cellId: source.toCellId,
    z: source.toZ,
    radius: SHARED_LIVING_RADIUS,
  };
}

export function positionWithinLivingArea(position: StandingPosition, anchor: SharedLivingAnchor): boolean {
  return Math.abs(cellX(position.cellId) - cellX(anchor.cellId))
      + Math.abs(cellY(position.cellId) - cellY(anchor.cellId)) <= anchor.radius
    && Math.abs(position.z - anchor.z) <= 1;
}

export function personWithinLivingArea(person: PersonState, anchor: SharedLivingAnchor): boolean {
  return positionWithinLivingArea(person.position, anchor);
}

export function companionSharesLivingArea(state: SimulationState, agreement: Agreement): boolean {
  const anchor = companionLivingAnchor(state, agreement);
  if (!anchor) return false;
  const living = livingPeople(state);
  const parties = agreement.partyIds
    .map((id) => living.find((candidate) => candidate.id === id));
  return parties.length >= 2
    && parties.every((person): person is PersonState => Boolean(person))
    && parties.every((person) => personWithinLivingArea(person, anchor));
}

/** Return to the fixed anchor only when a bounded or established commitment is due. */
export function companionReturnRequired(agreement: Agreement, atMonth: number): boolean {
  if (agreement.status !== 'active' || agreement.proposal.kind !== 'companion') return false;
  if (agreement.companionEstablishedAtMonth !== undefined) {
    // Older active saves do not have the optional calendar field. Establishment
    // is a truthful lower bound because it required twelve real shared-living months.
    const lastCoLocatedAtMonth = agreement.lastCompanionCoLocatedAtMonth
      ?? agreement.companionEstablishedAtMonth;
    return atMonth - lastCoLocatedAtMonth >= ESTABLISHED_COMPANION_RETURN_AFTER_AWAY_MONTHS;
  }
  const missingMonths = Math.max(0, REQUIRED_SHARED_LIVING_MONTHS - (agreement.coLocatedMonths ?? 0));
  const monthsLeft = Math.max(0, (agreement.dueAtMonth ?? atMonth) - atMonth + 1);
  return missingMonths > 0 && missingMonths >= monthsLeft;
}

function distanceFromAnchor(position: StandingPosition, anchor: SharedLivingAnchor): number {
  return Math.abs(cellX(position.cellId) - cellX(anchor.cellId))
    + Math.abs(cellY(position.cellId) - cellY(anchor.cellId))
    + Math.abs(position.z - anchor.z);
}

/** Pick a stable, reachable slot in the shared area instead of another person's cell. */
export function sharedLivingReturnTarget(
  state: SimulationState,
  agreement: Agreement,
  person: PersonState,
): StandingPosition | null {
  const anchor = companionLivingAnchor(state, agreement);
  if (!anchor) return null;
  const candidates = cellsInRadius(anchor.cellId, anchor.radius)
    .flatMap((cellId) => standingPositions(state.world.grid, cellId))
    .filter((position) => Math.abs(position.z - anchor.z) <= 1)
    .sort((left, right) => distanceFromAnchor(left, anchor) - distanceFromAnchor(right, anchor)
      || left.cellId - right.cellId
      || left.z - right.z);
  if (!candidates.length) return null;
  const partyIndex = [...agreement.partyIds].sort().indexOf(person.id);
  const rotated = candidates.map((_, index) => candidates[(index + Math.max(0, partyIndex)) % candidates.length]!);
  const reachable = rotated.filter((position) => findStandingPath(state.world.grid, person.position, position).length > 0);
  if (!reachable.length) return null;
  const living = livingPeople(state);
  return reachable.find((position) => !living.some((candidate) => candidate.id !== person.id
    && candidate.position.cellId === position.cellId
    && candidate.position.z === position.z)) ?? reachable[0]!;
}
