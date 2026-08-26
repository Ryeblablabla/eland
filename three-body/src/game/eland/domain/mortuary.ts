import type { VoxelPosition } from './action';
import { remember } from './memory';
import type { EnvironmentFact, SimulationState } from './model';
import { isAlive, type PersonId, type PersonState } from './person';
import { personalityScore } from './personality';
import { cellsInRadius } from '../world/grid';
import { relationTo } from './relation';
import { livingPeople, personById } from './state-index';

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

interface IndexedPerceivableRemains {
  remains: HumanRemainsState;
  offset: number;
  cellId: number;
  z: number;
}

interface MortuaryPerceptionIndex {
  remains: HumanRemainsState[];
  memorials: MemorialMarkerState[];
  indexedRemainsLength: number;
  indexedMemorialLength: number;
  lastIndexedRemains?: HumanRemainsState;
  lastIndexedMemorial?: MemorialMarkerState;
  /** First-wins lookup tables preserve the authoritative Array.find semantics. */
  remainsById: Map<string, HumanRemainsState>;
  remainsByPersonId: Map<PersonId, HumanRemainsState>;
  memorialByRemainsId: Map<string, MemorialMarkerState>;
  markedRemainsIds: Set<string>;
  /** Remains whose status or position may still change under authoritative rules. */
  openRemains: Map<HumanRemainsState, number>;
  /** Stable interments that are locally invisible until a later marker exists. */
  unmarkedInterredById: Map<string, IndexedPerceivableRemains[]>;
  /**
   * Interred remains with a marker are monotonic domain facts: no legal action
   * moves or exposes them again. Only that stable subset is cached spatially.
   */
  stableMarkedByCell: Map<number, IndexedPerceivableRemains[]>;
}

const mortuaryPerceptionIndexes = new WeakMap<SimulationState, MortuaryPerceptionIndex>();

/**
 * `world.remains` and `world.memorials` are append-only during ordinary play;
 * replacing either array is detected automatically. Migration/debug code that
 * exceptionally splices, sorts, or rewrites an existing array in place must
 * call this hook before the next mortuary read so a stale grave can never be
 * mistaken for an authoritative current fact.
 */
export function invalidateMortuaryPerceptionIndex(state: SimulationState): void {
  mortuaryPerceptionIndexes.delete(state);
}

function indexFirst<K, V>(items: Map<K, V>, key: K, value: V): void {
  if (!items.has(key)) items.set(key, value);
}

function cacheStableMarkedRemains(
  index: MortuaryPerceptionIndex,
  remains: HumanRemainsState,
  offset: number,
): void {
  const cached = {
    remains,
    offset,
    cellId: remains.position.cellId,
    z: remains.position.z,
  };
  const atCell = index.stableMarkedByCell.get(cached.cellId) ?? [];
  atCell.push(cached);
  index.stableMarkedByCell.set(cached.cellId, atCell);
}

function cacheUnmarkedInterredRemains(
  index: MortuaryPerceptionIndex,
  remains: HumanRemainsState,
  offset: number,
): void {
  const pending = index.unmarkedInterredById.get(remains.id) ?? [];
  pending.push({
    remains,
    offset,
    cellId: remains.position.cellId,
    z: remains.position.z,
  });
  index.unmarkedInterredById.set(remains.id, pending);
}

function promoteMarkedInterments(index: MortuaryPerceptionIndex, remainsId: string): void {
  const pending = index.unmarkedInterredById.get(remainsId);
  if (!pending) return;
  for (const cached of pending) {
    const atCell = index.stableMarkedByCell.get(cached.cellId) ?? [];
    atCell.push(cached);
    index.stableMarkedByCell.set(cached.cellId, atCell);
  }
  index.unmarkedInterredById.delete(remainsId);
}

function buildMortuaryPerceptionIndex(state: SimulationState): MortuaryPerceptionIndex {
  const remains = state.world.remains ?? [];
  const memorials = state.world.memorials ?? [];
  const markedRemainsIds = new Set(memorials.map((marker) => marker.remainsId));
  const index: MortuaryPerceptionIndex = {
    remains,
    memorials,
    indexedRemainsLength: remains.length,
    indexedMemorialLength: memorials.length,
    lastIndexedRemains: remains.at(-1),
    lastIndexedMemorial: memorials.at(-1),
    remainsById: new Map(),
    remainsByPersonId: new Map(),
    memorialByRemainsId: new Map(),
    markedRemainsIds,
    openRemains: new Map(),
    unmarkedInterredById: new Map(),
    stableMarkedByCell: new Map(),
  };
  for (const marker of memorials) {
    indexFirst(index.memorialByRemainsId, marker.remainsId, marker);
  }
  remains.forEach((candidate, offset) => {
    indexFirst(index.remainsById, candidate.id, candidate);
    indexFirst(index.remainsByPersonId, candidate.personId, candidate);
    if (candidate.status !== 'interred') {
      if (!index.openRemains.has(candidate)) index.openRemains.set(candidate, offset);
    } else if (markedRemainsIds.has(candidate.id)) cacheStableMarkedRemains(index, candidate, offset);
    else cacheUnmarkedInterredRemains(index, candidate, offset);
  });
  mortuaryPerceptionIndexes.set(state, index);
  return index;
}

function appendOnlyPrefixChanged<T>(items: T[], indexedLength: number, lastIndexed: T | undefined): boolean {
  return items.length < indexedLength
    || (indexedLength > 0 && items[indexedLength - 1] !== lastIndexed);
}

function currentMortuaryPerceptionIndex(state: SimulationState): MortuaryPerceptionIndex {
  const remains = state.world.remains ?? [];
  const memorials = state.world.memorials ?? [];
  const index = mortuaryPerceptionIndexes.get(state);
  if (!index
    || index.remains !== remains
    || index.memorials !== memorials
    || appendOnlyPrefixChanged(remains, index.indexedRemainsLength, index.lastIndexedRemains)
    || appendOnlyPrefixChanged(memorials, index.indexedMemorialLength, index.lastIndexedMemorial)) {
    return buildMortuaryPerceptionIndex(state);
  }

  for (let offset = index.indexedMemorialLength; offset < memorials.length; offset += 1) {
    const marker = memorials[offset];
    const remainsId = marker.remainsId;
    indexFirst(index.memorialByRemainsId, remainsId, marker);
    if (!index.markedRemainsIds.has(remainsId)) promoteMarkedInterments(index, remainsId);
    index.markedRemainsIds.add(remainsId);
  }
  for (let offset = index.indexedRemainsLength; offset < remains.length; offset += 1) {
    const candidate = remains[offset];
    indexFirst(index.remainsById, candidate.id, candidate);
    indexFirst(index.remainsByPersonId, candidate.personId, candidate);
    if (candidate.status !== 'interred') {
      if (!index.openRemains.has(candidate)) index.openRemains.set(candidate, offset);
    } else if (index.markedRemainsIds.has(candidate.id)) cacheStableMarkedRemains(index, candidate, offset);
    else cacheUnmarkedInterredRemains(index, candidate, offset);
  }
  index.indexedRemainsLength = remains.length;
  index.indexedMemorialLength = memorials.length;
  index.lastIndexedRemains = remains.at(-1);
  index.lastIndexedMemorial = memorials.at(-1);
  return index;
}

interface MortuaryPerceptionSnapshot {
  index: MortuaryPerceptionIndex;
  openByCell: Map<number, IndexedPerceivableRemains[]>;
}

function createMortuaryPerceptionSnapshot(state: SimulationState): MortuaryPerceptionSnapshot | null {
  const index = currentMortuaryPerceptionIndex(state);
  const openByCell = new Map<number, IndexedPerceivableRemains[]>();
  for (const [candidate, offset] of index.openRemains) {
    if (index.remains[offset] !== candidate) return null;
    if (candidate.status === 'interred') {
      index.openRemains.delete(candidate);
      if (index.markedRemainsIds.has(candidate.id)) cacheStableMarkedRemains(index, candidate, offset);
      else cacheUnmarkedInterredRemains(index, candidate, offset);
      continue;
    }
    const entry = {
      remains: candidate,
      offset,
      cellId: candidate.position.cellId,
      z: candidate.position.z,
    };
    const atCell = openByCell.get(entry.cellId) ?? [];
    atCell.push(entry);
    openByCell.set(entry.cellId, atCell);
  }
  return { index, openByCell };
}

function indexedPerceivableRemains(
  snapshot: MortuaryPerceptionSnapshot,
  visibleCells: Set<number>,
  observerZ: number,
  radius: number,
): HumanRemainsState[] | null {
  const { index, openByCell } = snapshot;
  const visible: IndexedPerceivableRemains[] = [];
  for (const cellId of visibleCells) {
    for (const cached of index.stableMarkedByCell.get(cellId) ?? []) {
      // Stable marked graves should never move under legal rules. If an
      // exceptional writer did so without invalidating, abandon the cache and
      // conservatively use the complete authoritative array for this month.
      if (index.remains[cached.offset] !== cached.remains
        || cached.remains.status !== 'interred'
        || cached.remains.position.cellId !== cached.cellId
        || cached.remains.position.z !== cached.z) return null;
      if (Math.abs(cached.z - observerZ) <= radius) visible.push(cached);
    }
    for (const current of openByCell.get(cellId) ?? []) {
      if (Math.abs(current.z - observerZ) <= radius) visible.push(current);
    }
  }
  return visible
    .sort((left, right) => left.offset - right.offset)
    .map((entry) => entry.remains);
}

export function remainsById(state: SimulationState, remainsId: string): HumanRemainsState | undefined {
  return currentMortuaryPerceptionIndex(state).remainsById.get(remainsId);
}

export function remainsForPerson(state: SimulationState, personId: PersonId): HumanRemainsState | undefined {
  return currentMortuaryPerceptionIndex(state).remainsByPersonId.get(personId);
}

export function memorialForRemains(state: SimulationState, remainsId: string): MemorialMarkerState | undefined {
  return currentMortuaryPerceptionIndex(state).memorialByRemainsId.get(remainsId);
}

export function bereavementFor(person: PersonState, remainsId: string): BereavementState | undefined {
  return person.bereavements?.find((bereavement) => bereavement.remainsId === remainsId);
}

export function knowsDeath(person: PersonState, remainsId: string): boolean {
  return Boolean(bereavementFor(person, remainsId));
}

function griefIntensity(observer: PersonState, deceased: PersonState, learnedBy: BereavementState['learnedBy']): number {
  const relation = relationTo(observer, deceased.id);
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
  const deceased = personById(state, remains.personId);
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
  return indexedBereavementUrgency(currentMortuaryPerceptionIndex(state), bereavement, atMonth);
}

function indexedBereavementUrgency(
  index: MortuaryPerceptionIndex,
  bereavement: BereavementState,
  atMonth: number,
): number {
  const remains = index.remainsById.get(bereavement.remainsId);
  if (!remains) return 0;
  const memorial = index.memorialByRemainsId.get(remains.id);
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

export interface StrongestBereavementUrgency {
  bereavement: BereavementState;
  urgency: number;
}

/**
 * Select the same item as the former stable descending sort without allocating
 * or reordering a copy. Equal urgency deliberately keeps the first
 * authoritative bereavement-array entry.
 */
export function strongestBereavement(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
): StrongestBereavementUrgency | undefined {
  const index = currentMortuaryPerceptionIndex(state);
  let strongest: StrongestBereavementUrgency | undefined;
  for (const bereavement of person.bereavements ?? []) {
    const urgency = indexedBereavementUrgency(index, bereavement, atMonth);
    if (!strongest || urgency > strongest.urgency) strongest = { bereavement, urgency };
  }
  return strongest;
}

export function strongestBereavementUrgency(state: SimulationState, person: PersonState, atMonth: number): number {
  return strongestBereavement(state, person, atMonth)?.urgency ?? 0;
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
  let perceptionSnapshot = createMortuaryPerceptionSnapshot(state);
  if (!perceptionSnapshot) invalidateMortuaryPerceptionIndex(state);
  for (const observer of livingPeople(state)) {
    const radius = 4 + Math.floor(observer.baselineCapacities.perception / 25);
    const visibleCells = new Set(cellsInRadius(observer.position.cellId, radius));
    const indexedVisible = perceptionSnapshot
      ? indexedPerceivableRemains(perceptionSnapshot, visibleCells, observer.position.z, radius)
      : null;
    if (perceptionSnapshot && !indexedVisible) {
      invalidateMortuaryPerceptionIndex(state);
      perceptionSnapshot = null;
    }
    const visibleRemains = indexedVisible ?? remainsList.filter((remains) => (
      remainsPerceivable(state, remains)
      && visibleCells.has(remains.position.cellId)
      && Math.abs(remains.position.z - observer.position.z) <= radius
    ));
    for (const remains of visibleRemains) {
      if (knowsDeath(observer, remains.id)) continue;
      const deceased = personById(state, remains.personId);
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
