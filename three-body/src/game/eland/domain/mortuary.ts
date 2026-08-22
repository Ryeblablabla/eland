import type { VoxelPosition } from './action';
import { remember } from './memory';
import type { EnvironmentFact, SimulationState } from './model';
import { isAlive, type PersonId, type PersonState } from './person';
import { personalityScore } from './personality';
import { cellsInRadius } from '../world/grid';

export type HumanRemainsStatus = 'exposed' | 'carried' | 'placed' | 'interred';
export type MortuaryPhase = 'mourn' | 'lift' | 'prepare-grave' | 'place-in-grave' | 'cover-grave' | 'mark';

export interface GraveState {
  position: VoxelPosition;
  accessPosition: { cellId: number; z: number };
  originalMaterialId: number;
  preparedByPersonId: PersonId;
  preparedAtMonth: number;
  excavationEventId: string;
  coverMaterialStackId: string;
  placementEventId?: string;
  burialEventId?: string;
}

export interface HumanRemainsState {
  id: string;
  personId: PersonId;
  position: { cellId: number; z: number };
  status: HumanRemainsStatus;
  createdAtMonth: number;
  deathEventId: string;
  sourceEventIds: string[];
  carriedByPersonId?: PersonId;
  grave?: GraveState;
  interredAtMonth?: number;
  interredByPersonId?: PersonId;
}

export interface MemorialMarkerState {
  id: string;
  remainsId: string;
  personId: PersonId;
  position: VoxelPosition;
  materialId: number;
  inscription: string;
  madeByPersonId: PersonId;
  createdAtMonth: number;
  sourceEventIds: string[];
}

export interface BereavementState {
  id: string;
  remainsId: string;
  deceasedPersonId: PersonId;
  deathEventId: string;
  learnedAtMonth: number;
  learnedBy: 'witness' | 'told';
  intensity: number;
  sourceEventIds: string[];
  lastMournedAtMonth?: number;
  careResolvedAtMonth?: number;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function remainsById(state: SimulationState, remainsId: string): HumanRemainsState | undefined {
  return state.world.remains?.find((remains) => remains.id === remainsId);
}

export function remainsForPerson(state: SimulationState, personId: PersonId): HumanRemainsState | undefined {
  return state.world.remains?.find((remains) => remains.personId === personId);
}

export function memorialForRemains(state: SimulationState, remainsId: string): MemorialMarkerState | undefined {
  return state.world.memorials?.find((marker) => marker.remainsId === remainsId);
}

export function bereavementFor(person: PersonState, remainsId: string): BereavementState | undefined {
  return person.bereavements?.find((bereavement) => bereavement.remainsId === remainsId);
}

export function knowsDeath(person: PersonState, remainsId: string): boolean {
  return Boolean(bereavementFor(person, remainsId));
}

function griefIntensity(observer: PersonState, deceased: PersonState, learnedBy: BereavementState['learnedBy']): number {
  const relation = observer.relations.find((candidate) => candidate.personId === deceased.id);
  const directKin = deceased.geneticParents.includes(observer.id) || observer.geneticParents.includes(deceased.id);
  const sibling = observer.geneticParents.length > 0
    && observer.geneticParents.some((parentId) => deceased.geneticParents.includes(parentId));
  const relationship = clamp(((relation?.bond ?? 0) + (relation?.trust ?? 0) - Math.max(0, relation?.fear ?? 0) * 0.6) / 100);
  const relationalBase = directKin ? 0.92 : sibling ? 0.74 : Math.max(0.16, relationship);
  const temperament = 0.72
    + personalityScore(observer, 'emotionality') / 250
    + personalityScore(observer, 'agreeableness') / 500;
  return clamp(relationalBase * temperament * (learnedBy === 'told' ? 0.92 : 1), 0.08, 1);
}

export function learnOfDeath(
  state: SimulationState,
  observer: PersonState,
  remains: HumanRemainsState,
  learnedAtMonth: number,
  learnedBy: BereavementState['learnedBy'],
  learnedFromEventId: string,
): BereavementState | null {
  const deceased = state.people.find((candidate) => candidate.id === remains.personId);
  if (!deceased || observer.id === deceased.id || !isAlive(observer)) return null;
  observer.bereavements ??= [];
  const sourceEventIds = [...new Set([remains.deathEventId, learnedFromEventId])].filter(Boolean).slice(-24);
  let bereavement = bereavementFor(observer, remains.id);
  if (bereavement) {
    bereavement.sourceEventIds = [...new Set([...bereavement.sourceEventIds, ...sourceEventIds])].slice(-24);
  } else {
    bereavement = {
      id: `bereavement:${observer.id}:${remains.id}`,
      remainsId: remains.id,
      deceasedPersonId: deceased.id,
      deathEventId: remains.deathEventId,
      learnedAtMonth,
      learnedBy,
      intensity: griefIntensity(observer, deceased, learnedBy),
      sourceEventIds,
    };
    observer.bereavements.push(bereavement);
  }
  remember(observer, {
    id: `memory:death:${observer.id}:${remains.id}`,
    kind: 'episode',
    summary: learnedBy === 'witness'
      ? `亲眼确认${deceased.name}已经死亡`
      : `从有来源的交谈中得知${deceased.name}已经死亡`,
    importance: Math.round(48 + bereavement.intensity * 48),
    createdAtMonth: bereavement.learnedAtMonth,
    lastRecalledAtMonth: learnedAtMonth,
    personIds: [deceased.id],
    sourceEventIds: bereavement.sourceEventIds,
  });
  return bereavement;
}

export function bereavementUrgency(
  state: SimulationState,
  bereavement: BereavementState,
  atMonth: number,
): number {
  const remains = remainsById(state, bereavement.remainsId);
  if (!remains) return 0;
  const memorial = memorialForRemains(state, remains.id);
  const openCare = remains.status !== 'interred'
    ? 1
    : bereavement.lastMournedAtMonth === undefined
      ? 0.5
      : !memorial
        ? 0.2
        : 0;
  const age = Math.max(0, atMonth - bereavement.learnedAtMonth);
  return clamp(bereavement.intensity * Math.exp(-age / 60) * openCare);
}

export function strongestBereavementUrgency(state: SimulationState, person: PersonState, atMonth: number): number {
  return (person.bereavements ?? []).reduce(
    (maximum, bereavement) => Math.max(maximum, bereavementUrgency(state, bereavement, atMonth)),
    0,
  );
}

function remainsPerceivable(state: SimulationState, remains: HumanRemainsState): boolean {
  return remains.status !== 'interred' || Boolean(memorialForRemains(state, remains.id));
}

/**
 * Month-boundary perception is deliberately local. It creates sourced memory
 * only for a living person whose current sensory radius includes the remains
 * (or an already marked grave); kinship alone is never a global broadcast.
 */
export function synchronizeMortuaryPerceptions(
  state: SimulationState,
  atMonth: number,
  orderOffset: number,
): EnvironmentFact[] {
  const events: EnvironmentFact[] = [];
  const remainsList = state.world.remains ?? [];
  for (const observer of state.people.filter(isAlive)) {
    const radius = 4 + Math.floor(observer.baselineCapacities.perception / 25);
    const visibleCells = new Set(cellsInRadius(observer.position.cellId, radius));
    for (const remains of remainsList) {
      if (knowsDeath(observer, remains.id) || !remainsPerceivable(state, remains)) continue;
      if (!visibleCells.has(remains.position.cellId) || Math.abs(remains.position.z - observer.position.z) > radius) continue;
      const deceased = state.people.find((candidate) => candidate.id === remains.personId);
      if (!deceased) continue;
      const eventId = `e-${atMonth}-environment-relationship-${orderOffset + events.length}`;
      const fact: EnvironmentFact = {
        id: eventId,
        kind: 'environment',
        change: 'relationship',
        atMonth,
        orderInMonth: orderOffset + events.length,
        cellId: observer.position.cellId,
        who: observer.id,
        result: remains.status === 'interred'
          ? `${observer.name}辨认出${deceased.name}的墓记`
          : `${observer.name}亲眼确认${deceased.name}已经死亡`,
        diff: {
          mortuaryPerception: true,
          remainsId: remains.id,
          deceasedPersonId: deceased.id,
          deathEventId: remains.deathEventId,
          perception: remains.status === 'interred' ? 'marked-grave' : 'human-remains',
          sourceEventIds: [remains.deathEventId],
        },
      };
      learnOfDeath(state, observer, remains, atMonth, 'witness', fact.id);
      events.push(fact);
    }
  }
  return events;
}
