import type { AnimalSpeciesId, AnimalState } from './animal';
import { animalSpecies, isAnimalAlive } from './animal';
import type { SimulationState, WorldEvent } from './model';
import { isAlive, isDormantDehydratedHibernating, type PersonState } from './person';
import { lifePlanningStage } from './life-stage';
import { intentById } from './state-index';
import { findReachableShelter } from './shelter-access';
import { shelterGeometryAt } from './structure';
import {
  cellX,
  cellY,
  cellsInRadius,
  findStandingPath,
  neighbors4,
  standingPositions,
  type StandingPosition,
} from '../world/grid';

export type WildlifeThreatResponse = 'shelter-step' | 'flee-step' | 'hold';

export interface VisibleWildlifeThreatObservation {
  animalId: string;
  speciesId: AnimalSpeciesId;
  cellId: number;
  z: number;
  distance: number;
  alarmRadius: number;
  targetingPersonId?: string;
  behaviorMode?: string;
}

/**
 * A compact, local basis for one emergency response. It records only what the
 * person can currently see and the exact physical response selected from it.
 */
export interface WildlifeThreatBasis {
  version: 'visible-wildlife-threat-v1';
  basisKey: string;
  observedAtMonth: number;
  personId: string;
  observedPersonPosition: StandingPosition;
  visibleRadius: number;
  protectedPersonIds: string[];
  threats: VisibleWildlifeThreatObservation[];
  response: WildlifeThreatResponse;
  destination: StandingPosition;
  shelter?: {
    structureId: string;
    position: StandingPosition;
  };
}

export interface WildlifeThreatResponsePlan {
  toCellId: number;
  toZ: number;
  basis: WildlifeThreatBasis;
}

function personVisibleRadius(person: PersonState): number {
  return 4 + Math.floor(person.baselineCapacities.perception / 25);
}

function standingDistance(first: StandingPosition, second: StandingPosition): number {
  return Math.abs(cellX(first.cellId) - cellX(second.cellId))
    + Math.abs(cellY(first.cellId) - cellY(second.cellId))
    + Math.abs(first.z - second.z);
}

function behaviorTargetPerson(animal: AnimalState, atMonth: number): string | undefined {
  const behavior = animal.ecology?.currentBehavior;
  return behavior?.atMonth === atMonth && behavior.mode === 'pursue-human'
    ? behavior.targetPersonId
    : undefined;
}

function protectedPersonIds(state: SimulationState, person: PersonState): string[] {
  return [
    person.id,
    ...state.people
      .filter((candidate) => isAlive(candidate)
        && candidate.geneticParents.includes(person.id)
        && candidate.position.cellId === person.position.cellId
        && candidate.position.z === person.position.z)
      .map((candidate) => candidate.id),
  ].sort();
}

function protectedByCoLocatedParent(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
): boolean {
  if (lifePlanningStage(person, atMonth) !== 'dependent-child') return false;
  return state.people.some((candidate) => person.geneticParents.includes(candidate.id)
    && isAlive(candidate)
    && !isDormantDehydratedHibernating(candidate)
    && !candidate.conditions.some((condition) => condition.kind === 'restrained')
    && candidate.position.cellId === person.position.cellId
    && candidate.position.z === person.position.z);
}

/**
 * The exact animals that started the person's still-active escape episode.
 * This is short-lived intent evidence, not remote tracking: an animal must
 * still be physically visible from the person's new position to continue the
 * episode.
 */
function continuingThreatAnimalIds(state: SimulationState, person: PersonState): Set<string> {
  const intent = person.activeIntentId ? intentById(state, person.activeIntentId) : undefined;
  if (intent?.status !== 'active'
    || intent.interruptionKind !== 'survival-reflex'
    || intent.nextAction.kind !== 'move'
    || !intent.nextAction.wildlifeThreatBasis
    // A completed hold has no escape route to continue. On the next planning
    // tick the animal must independently remain inside its alarm radius or be
    // visibly pursuing a protected person. Otherwise an old animal identity
    // can monopolize every later survival action while the person starves in
    // place despite carrying food.
    || intent.nextAction.wildlifeThreatBasis.response === 'hold') return new Set();
  return new Set(intent.nextAction.wildlifeThreatBasis.threats.map((threat) => threat.animalId));
}

function continuingShelterChoice(
  state: SimulationState,
  person: PersonState,
): WildlifeThreatBasis['shelter'] | undefined {
  const intent = person.activeIntentId ? intentById(state, person.activeIntentId) : undefined;
  const basis = intent?.status === 'active'
    && intent.interruptionKind === 'survival-reflex'
    && intent.nextAction.kind === 'move'
    ? intent.nextAction.wildlifeThreatBasis
    : undefined;
  const shelter = basis?.response === 'shelter-step' ? basis.shelter : undefined;
  if (!shelter
    || !shelterGeometryAt(state.world.grid, shelter.position)
    || shelterGeometryAt(state.world.grid, person.position)) return undefined;
  return shelter;
}

/** Current visible danger only; no remembered remote animal or hidden hunger. */
export function visibleWildlifeThreats(
  state: SimulationState,
  person: PersonState,
  atMonth = state.clock.elapsedMonths + 1,
): VisibleWildlifeThreatObservation[] {
  const radius = personVisibleRadius(person);
  const visible = new Set(cellsInRadius(person.position.cellId, radius));
  const protectedIds = new Set(protectedPersonIds(state, person));
  const continuingThreats = continuingThreatAnimalIds(state, person);
  return state.world.animals
    .filter((animal) => isAnimalAlive(animal)
      && visible.has(animal.position.cellId)
      && Math.abs(animal.position.z - person.position.z) <= radius)
    .flatMap((animal) => {
      const species = animalSpecies(animal.speciesId);
      if (species.aggression <= 0) return [];
      const distance = standingDistance(person.position, animal.position);
      const targetingPersonId = behaviorTargetPerson(animal, atMonth);
      const targetsProtectedPerson = targetingPersonId !== undefined && protectedIds.has(targetingPersonId);
      if (!targetsProtectedPerson
        && distance > species.alarmRadius
        && !continuingThreats.has(animal.id)) return [];
      return [{
        animalId: animal.id,
        speciesId: animal.speciesId,
        cellId: animal.position.cellId,
        z: animal.position.z,
        distance,
        alarmRadius: species.alarmRadius,
        ...(targetingPersonId ? { targetingPersonId } : {}),
        ...(animal.ecology?.currentBehavior?.atMonth === atMonth
          ? { behaviorMode: animal.ecology.currentBehavior.mode }
          : {}),
      }];
    })
    .sort((left, right) => Number(Boolean(right.targetingPersonId)) - Number(Boolean(left.targetingPersonId))
      || left.distance - right.distance
      || animalSpecies(right.speciesId).aggression - animalSpecies(left.speciesId).aggression
      || left.animalId.localeCompare(right.animalId))
    .slice(0, 8);
}

/**
 * Aggressive animals that the person can currently see and whose caution area
 * physically covers a planned work/source position. This is narrower than an
 * emergency around the person: it lets planning recognize that a destination
 * is unsafe before walking into the animal's alarm radius, without revealing a
 * remote animal or remembering a stale position across monthly ecology steps.
 */
export function visibleWildlifeThreatsGuardingPosition(
  state: SimulationState,
  person: PersonState,
  position: StandingPosition,
  atMonth = state.clock.elapsedMonths + 1,
): VisibleWildlifeThreatObservation[] {
  const radius = personVisibleRadius(person);
  const visible = new Set(cellsInRadius(person.position.cellId, radius));
  return state.world.animals
    .filter((animal) => isAnimalAlive(animal)
      && animalSpecies(animal.speciesId).aggression > 0
      && visible.has(animal.position.cellId)
      && Math.abs(animal.position.z - person.position.z) <= radius)
    .flatMap((animal) => {
      const species = animalSpecies(animal.speciesId);
      if (standingDistance(position, animal.position) > species.alarmRadius) return [];
      const targetingPersonId = behaviorTargetPerson(animal, atMonth);
      return [{
        animalId: animal.id,
        speciesId: animal.speciesId,
        cellId: animal.position.cellId,
        z: animal.position.z,
        distance: standingDistance(person.position, animal.position),
        alarmRadius: species.alarmRadius,
        ...(targetingPersonId ? { targetingPersonId } : {}),
        ...(animal.ecology?.currentBehavior?.atMonth === atMonth
          ? { behaviorMode: animal.ecology.currentBehavior.mode }
          : {}),
      }];
    })
    .sort((left, right) => standingDistance(position, left) - standingDistance(position, right)
      || Number(Boolean(right.targetingPersonId)) - Number(Boolean(left.targetingPersonId))
      || left.animalId.localeCompare(right.animalId))
    .slice(0, 8);
}

function minimumThreatDistance(position: StandingPosition, threats: VisibleWildlifeThreatObservation[]): number {
  return threats.reduce((minimum, threat) => Math.min(minimum, standingDistance(position, threat)), Number.POSITIVE_INFINITY);
}

function responseBasis(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
  threats: VisibleWildlifeThreatObservation[],
  response: WildlifeThreatResponse,
  destination: StandingPosition,
  shelter?: WildlifeThreatBasis['shelter'],
): WildlifeThreatBasis {
  const radius = personVisibleRadius(person);
  const protectedIds = protectedPersonIds(state, person);
  const keyParts = [
    atMonth,
    person.id,
    `${person.position.cellId}:${person.position.z}`,
    response,
    `${destination.cellId}:${destination.z}`,
    ...threats.map((threat) => `${threat.animalId}:${threat.cellId}:${threat.z}:${threat.targetingPersonId ?? '-'}`),
    shelter?.structureId ?? '-',
  ];
  return {
    version: 'visible-wildlife-threat-v1',
    basisKey: `wildlife-threat:${keyParts.join('|')}`,
    observedAtMonth: atMonth,
    personId: person.id,
    observedPersonPosition: { cellId: person.position.cellId, z: person.position.z },
    visibleRadius: radius,
    protectedPersonIds: protectedIds,
    threats: threats.map((threat) => ({ ...threat })),
    response,
    destination: { ...destination },
    ...(shelter ? { shelter } : {}),
  };
}

/**
 * Compile exactly one adjacent refuge/flee step. The active interruption keeps
 * the triggering animal identity while every tick recomputes current, locally
 * visible danger and the next physical step from the new position.
 */
export function compileWildlifeThreatResponse(
  state: SimulationState,
  person: PersonState,
  atMonth = state.clock.elapsedMonths + 1,
): WildlifeThreatResponsePlan | null {
  // A co-located capable parent owns the escape step and carries a dependent.
  // This prevents the child from taking a second independent step later in the
  // same action tick after the parent has already moved it to safety.
  if (protectedByCoLocatedParent(state, person, atMonth)) return null;
  const threats = visibleWildlifeThreats(state, person, atMonth);
  if (shelterGeometryAt(state.world.grid, person.position)) return null;
  // Finish the already selected, locally known shelter route even when the
  // triggering animal drops just beyond the current alarm/visibility boundary
  // midway. Otherwise the parent resumes toward the same risky target and
  // re-enters danger every few ticks.
  const continuingShelter = continuingShelterChoice(state, person);
  if (continuingShelter) {
    const path = findStandingPath(state.world.grid, person.position, continuingShelter.position);
    const next = path[1];
    if (next) return {
      toCellId: next.cellId,
      toZ: next.z,
      basis: responseBasis(
        state,
        person,
        atMonth,
        threats,
        'shelter-step',
        next,
        continuingShelter,
      ),
    };
  }
  if (!threats.length) return null;
  const radius = personVisibleRadius(person);
  const visibleCells = cellsInRadius(person.position.cellId, radius);
  const shelter = findReachableShelter(state, person, visibleCells);
  if (shelter && shelter.pathLength - 1 <= radius) {
    const path = findStandingPath(state.world.grid, person.position, shelter.position);
    const next = path[1];
    if (next) {
      const shelterBasis = {
        structureId: shelter.structureId,
        position: { ...shelter.position },
      };
      return {
        toCellId: next.cellId,
        toZ: next.z,
        basis: responseBasis(state, person, atMonth, threats, 'shelter-step', next, shelterBasis),
      };
    }
  }

  const beforeDistance = minimumThreatDistance(person.position, threats);
  const visitedThisMonth = new Set(person.position.tickPath);
  const candidates = neighbors4(person.position.cellId)
    .flatMap((cellId) => standingPositions(state.world.grid, cellId))
    .filter((position) => Math.abs(position.z - person.position.z) <= 1)
    .filter((position) => !visitedThisMonth.has(position.cellId))
    .filter((position) => !threats.some((threat) => threat.cellId === position.cellId && threat.z === position.z))
    .map((position) => ({ position, distance: minimumThreatDistance(position, threats) }))
    .filter((candidate) => candidate.distance > beforeDistance)
    .sort((left, right) => right.distance - left.distance
      || left.position.cellId - right.position.cellId
      || left.position.z - right.position.z);
  const flee = candidates[0]?.position;
  if (flee) return {
    toCellId: flee.cellId,
    toZ: flee.z,
    basis: responseBasis(state, person, atMonth, threats, 'flee-step', flee),
  };

  const hold = { cellId: person.position.cellId, z: person.position.z };
  return {
    toCellId: hold.cellId,
    toZ: hold.z,
    basis: responseBasis(state, person, atMonth, threats, 'hold', hold),
  };
}

export function validateWildlifeThreatResponse(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
  destination: StandingPosition,
  basis: WildlifeThreatBasis,
): { valid: true; expected: WildlifeThreatResponsePlan } | { valid: false; reason: string } {
  if (basis.version !== 'visible-wildlife-threat-v1'
    || basis.personId !== person.id
    || basis.observedAtMonth !== atMonth
    || basis.observedPersonPosition.cellId !== person.position.cellId
    || basis.observedPersonPosition.z !== person.position.z) {
    return { valid: false, reason: '野兽威胁响应已经脱离本人当前观察位置' };
  }
  const expected = compileWildlifeThreatResponse(state, person, atMonth);
  if (!expected
    || expected.basis.basisKey !== basis.basisKey
    || expected.toCellId !== destination.cellId
    || expected.toZ !== destination.z) {
    return { valid: false, reason: '野兽位置、住所或安全退路已经变化' };
  }
  return { valid: true, expected };
}

export function wildlifeThreatResponseDiff(
  from: StandingPosition,
  to: StandingPosition,
  basis: WildlifeThreatBasis,
): Record<string, unknown> {
  return {
    wildlifeThreatResponse: true,
    wildlifeThreatBasisKey: basis.basisKey,
    wildlifeThreatResponseKind: basis.response,
    wildlifeThreatAnimalIds: basis.threats.map((threat) => threat.animalId),
    wildlifeThreatProtectedPersonIds: [...basis.protectedPersonIds],
    wildlifeThreatDistanceBefore: minimumThreatDistance(from, basis.threats),
    wildlifeThreatDistanceAfter: minimumThreatDistance(to, basis.threats),
    ...(basis.shelter ? { wildlifeThreatShelterStructureId: basis.shelter.structureId } : {}),
  };
}

export function wildlifeThreatUrgency(
  state: SimulationState,
  person: PersonState,
  atMonth = state.clock.elapsedMonths + 1,
): number {
  const threats = visibleWildlifeThreats(state, person, atMonth);
  if (!threats.length) return 0;
  const primary = threats[0];
  return Math.max(96, 132 - primary.distance * 8 + (primary.targetingPersonId ? 20 : 0));
}

export function shouldRemainShelteredFromWildlifeThreat(
  state: SimulationState,
  person: PersonState,
  atMonth = state.clock.elapsedMonths + 1,
  currentMonthEvents: readonly WorldEvent[] = [],
): boolean {
  if (!shelterGeometryAt(state.world.grid, person.position)) return false;
  if (visibleWildlifeThreats(state, person, atMonth).length) return true;
  // Entering cover can put the triggering animal just outside its alarm
  // radius. Keep that source-backed refuge episode through this month instead
  // of resuming an old outward intent on the next tick and seeing the same
  // animal again. The next month performs a fresh local observation.
  return currentMonthEvents.some((event) => event.kind === 'action'
    && event.atMonth === atMonth
    && event.who === person.id
    && event.status === 'completed'
    && event.action.kind === 'move'
    && event.action.wildlifeThreatBasis?.response === 'shelter-step'
    && event.diff.wildlifeThreatResponse === true);
}
