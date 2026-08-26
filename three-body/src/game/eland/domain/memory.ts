import type { ActionFact, SimulationState } from './model';
import { isAlive, type MemoryRecord, type PersonState } from './person';
import { causalMemoryTraceForAction, isMeaningfulCognitiveOutcome } from './cognition';
import { memoryCapacityMultiplier, memoryDurationMultiplier } from './trait';
import { personById } from './state-index';

const MAX_MEMORIES = 24;
const MAX_PROJECTED_MEMORIES = 8;

type MemoryOwner = Pick<PersonState, 'id' | 'traits' | 'memories'>;

interface ScheduledMemoryMaintenance {
  month: number;
  generation: number;
  person: PersonState;
}

interface MemoryMaintenanceIndex {
  people: PersonState[];
  knownLength: number;
  firstKnownPerson?: PersonState;
  lastKnownPerson?: PersonState;
  living: PersonState[];
  members: WeakSet<PersonState>;
  dirty: Set<PersonState>;
  scheduledGeneration: WeakMap<PersonState, number>;
  heap: ScheduledMemoryMaintenance[];
  lastMaintainedAtMonth?: number;
  retired: boolean;
}

const MEMORY_MAINTENANCE_BY_STATE = new WeakMap<SimulationState, MemoryMaintenanceIndex>();
const MEMORY_MAINTENANCE_BY_PERSON = new WeakMap<PersonState, MemoryMaintenanceIndex>();

function markMemoryMaintenanceDirty(person: PersonState): void {
  const owner = MEMORY_MAINTENANCE_BY_PERSON.get(person);
  if (owner && !owner.retired) owner.dirty.add(person);
}

function retireMemoryMaintenanceIndex(index: MemoryMaintenanceIndex): void {
  index.retired = true;
  index.people = [];
  index.living = [];
  index.heap = [];
  index.dirty.clear();
}

/**
 * `state.people` is append-only during ordinary evolution. A same-array
 * splice, sort, or in-place person replacement is an exceptional ownership
 * rewrite and must call this hook so the next month takes the safe O(P)
 * rebuild path. Whole-array replacement is detected automatically.
 */
export function invalidateMemoryMaintenanceIndex(state: SimulationState): void {
  const existing = MEMORY_MAINTENANCE_BY_STATE.get(state);
  if (existing) retireMemoryMaintenanceIndex(existing);
  MEMORY_MAINTENANCE_BY_STATE.delete(state);
}

/**
 * `remember` invalidates a registered person automatically. Call this after
 * directly replacing or mutating a dead person's memories or traits. Living
 * people are maintained every month and do not require the hook.
 */
export function invalidatePersonMemoryMaintenance(person: PersonState): void {
  markMemoryMaintenanceDirty(person);
}

export function personMemoryCapacity(person: Pick<PersonState, 'traits'>): number {
  return Math.round(MAX_MEMORIES * memoryCapacityMultiplier(person));
}

export function personProjectedMemoryCapacity(person: Pick<PersonState, 'traits'>): number {
  return Math.round(MAX_PROJECTED_MEMORIES * memoryCapacityMultiplier(person));
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

export function remember(person: PersonState, memory: MemoryRecord): void {
  const existing = person.memories.find((item) => item.id === memory.id);
  if (existing) {
    existing.summary = memory.summary;
    existing.importance = Math.max(existing.importance, memory.importance);
    existing.lastRecalledAtMonth = Math.max(existing.lastRecalledAtMonth, memory.lastRecalledAtMonth);
    existing.personIds = [...new Set([...existing.personIds, ...memory.personIds])];
    existing.sourceEventIds = [...new Set([...existing.sourceEventIds, ...memory.sourceEventIds])].slice(-12);
    if (!existing.causal && memory.causal) existing.causal = structuredClone(memory.causal);
    markMemoryMaintenanceDirty(person);
    return;
  }
  person.memories.push(memory);
  person.memories = person.memories
    .sort((a, b) => {
      const aDurable = a.kind === 'commitment'
        ? 30
        : a.kind === 'failure' ? a.expiresAtMonth !== undefined && a.expiresAtMonth >= a.createdAtMonth ? 47 : 12 : 0;
      const bDurable = b.kind === 'commitment'
        ? 30
        : b.kind === 'failure' ? b.expiresAtMonth !== undefined && b.expiresAtMonth >= b.createdAtMonth ? 47 : 12 : 0;
      return b.importance + bDurable - (a.importance + aDurable) || b.createdAtMonth - a.createdAtMonth;
    })
    .slice(0, personMemoryCapacity(person));
  markMemoryMaintenanceDirty(person);
}

function score(person: Pick<PersonState, 'traits'>, memory: MemoryRecord, atMonth: number): number {
  const age = Math.max(0, atMonth - memory.createdAtMonth) / memoryDurationMultiplier(person);
  const durable = memory.kind === 'commitment' ? 28 : memory.kind === 'failure' ? 12 : memory.kind === 'summary' ? 10 : 0;
  const activeCommitment = memory.kind === 'commitment' && (memory.expiresAtMonth ?? atMonth) >= atMonth ? 35 : 0;
  const activeBoundedFailure = memory.kind === 'failure'
    && memory.expiresAtMonth !== undefined
    && memory.expiresAtMonth >= atMonth
    ? 35
    : 0;
  return memory.importance + durable + activeCommitment + activeBoundedFailure - Math.min(55, age * 1.4);
}

function boundedFailureRetentionPriority(memory: MemoryRecord, atMonth: number): number {
  return memory.kind === 'failure'
    && memory.expiresAtMonth !== undefined
    && memory.expiresAtMonth >= atMonth
    ? 1
    : 0;
}

function compareForRetention(
  person: Pick<PersonState, 'traits'>,
  atMonth: number,
  left: MemoryRecord,
  right: MemoryRecord,
): number {
  return boundedFailureRetentionPriority(right, atMonth) - boundedFailureRetentionPriority(left, atMonth)
    || score(person, right, atMonth) - score(person, left, atMonth)
    || right.createdAtMonth - left.createdAtMonth;
}

function maintainPersonMemories(person: MemoryOwner, atMonth: number): void {
  const retained = person.memories.filter((memory) => (
    memory.kind === 'commitment' || memory.kind === 'failure' && memory.expiresAtMonth !== undefined
  ) && (memory.expiresAtMonth ?? atMonth) >= atMonth);
  const candidates = person.memories
    .filter((memory) => !retained.includes(memory))
    .map((memory) => ({ memory, score: score(person, memory, atMonth) }))
    .filter(({ memory, score: value }) => value >= 12 || atMonth - memory.createdAtMonth <= 6 * memoryDurationMultiplier(person))
    .sort((a, b) => compareForRetention(person, atMonth, a.memory, b.memory));
  const forgotten = person.memories.filter((memory) => !retained.includes(memory) && !candidates.some((item) => item.memory === memory));
  const summaries = forgotten.filter((memory) => memory.kind !== 'summary').slice(-6);
  const next = [...retained, ...candidates.map((item) => item.memory)]
    .sort((a, b) => compareForRetention(person, atMonth, a, b))
    .slice(0, personMemoryCapacity(person));
  if (summaries.length && !next.some((memory) => memory.id === `memory-summary-${person.id}-${Math.floor(atMonth / 12)}`)) {
    next.push({
      id: `memory-summary-${person.id}-${Math.floor(atMonth / 12)}`,
      kind: 'summary',
      summary: `较早经历：${summaries.map((memory) => memory.summary).join('；').slice(0, 260)}`,
      importance: clamp(Math.max(...summaries.map((memory) => memory.importance)) - 12),
      createdAtMonth: atMonth,
      lastRecalledAtMonth: atMonth,
      personIds: [...new Set(summaries.flatMap((memory) => memory.personIds))].slice(0, 5),
      sourceEventIds: [...new Set(summaries.flatMap((memory) => memory.sourceEventIds))].slice(-8),
    });
  }
  person.memories = next
    .sort((a, b) => compareForRetention(person, atMonth, a, b))
    .slice(0, personMemoryCapacity(person));
}

/** Exact all-person fold retained as a simple reference implementation. */
export function maintainMemories(state: SimulationState, atMonth: number): void {
  invalidateMemoryMaintenanceIndex(state);
  for (const person of state.people) maintainPersonMemories(person, atMonth);
}

function scheduledBefore(left: ScheduledMemoryMaintenance, right: ScheduledMemoryMaintenance): boolean {
  return left.month < right.month
    || left.month === right.month && left.person.id.localeCompare(right.person.id) < 0;
}

function pushScheduled(index: MemoryMaintenanceIndex, item: ScheduledMemoryMaintenance): void {
  index.heap.push(item);
  let child = index.heap.length - 1;
  while (child > 0) {
    const parent = Math.floor((child - 1) / 2);
    if (!scheduledBefore(index.heap[child], index.heap[parent])) break;
    [index.heap[parent], index.heap[child]] = [index.heap[child], index.heap[parent]];
    child = parent;
  }
}

function popScheduled(index: MemoryMaintenanceIndex): ScheduledMemoryMaintenance | undefined {
  const first = index.heap[0];
  const last = index.heap.pop();
  if (!first || !last || index.heap.length === 0) return first;
  index.heap[0] = last;
  let parent = 0;
  while (true) {
    const left = parent * 2 + 1;
    const right = left + 1;
    let next = parent;
    if (left < index.heap.length && scheduledBefore(index.heap[left], index.heap[next])) next = left;
    if (right < index.heap.length && scheduledBefore(index.heap[right], index.heap[next])) next = right;
    if (next === parent) return first;
    [index.heap[parent], index.heap[next]] = [index.heap[next], index.heap[parent]];
    parent = next;
  }
}

function memorySequenceChanged(before: readonly MemoryRecord[], after: readonly MemoryRecord[]): boolean {
  return before.length !== after.length || before.some((memory, index) => memory !== after[index]);
}

/**
 * A dead person's retained records are immutable between sourced `remember`
 * writes. Their fold can therefore change only while an age penalty is still
 * moving, or on the first integer month after a finite expiry. We replay those
 * exact candidate months on a tiny private clone and schedule only the first
 * month whose authoritative record sequence actually changes.
 */
function nextDeadMemoryChangeMonth(person: PersonState, afterMonth: number): number | undefined {
  if (!Number.isSafeInteger(afterMonth)) return afterMonth + 1;
  const duration = memoryDurationMultiplier(person);
  const candidates = new Set<number>();
  for (const memory of person.memories) {
    if (!Number.isSafeInteger(memory.createdAtMonth)
      || memory.expiresAtMonth !== undefined && !Number.isSafeInteger(memory.expiresAtMonth)) {
      return afterMonth + 1;
    }
    const firstMovingMonth = Math.max(afterMonth + 1, Math.floor(memory.createdAtMonth) + 1);
    const cappedAtMonth = Math.ceil(memory.createdAtMonth + 55 * duration / 1.4);
    for (let month = firstMovingMonth; month <= cappedAtMonth; month += 1) candidates.add(month);
    if (memory.expiresAtMonth !== undefined) {
      const expiryTransitionMonth = Math.floor(memory.expiresAtMonth) + 1;
      if (expiryTransitionMonth > afterMonth) candidates.add(expiryTransitionMonth);
    }
  }
  if (!candidates.size) return undefined;
  const forecast: MemoryOwner = {
    id: person.id,
    traits: structuredClone(person.traits),
    memories: structuredClone(person.memories),
  };
  for (const month of [...candidates].sort((left, right) => left - right)) {
    const before = [...forecast.memories];
    maintainPersonMemories(forecast, month);
    if (memorySequenceChanged(before, forecast.memories)) return month;
  }
  return undefined;
}

function registerPerson(index: MemoryMaintenanceIndex, person: PersonState): void {
  index.members.add(person);
  MEMORY_MAINTENANCE_BY_PERSON.set(person, index);
}

function createMemoryMaintenanceIndex(state: SimulationState): MemoryMaintenanceIndex {
  const index: MemoryMaintenanceIndex = {
    people: state.people,
    knownLength: state.people.length,
    firstKnownPerson: state.people[0],
    lastKnownPerson: state.people[state.people.length - 1],
    living: [],
    members: new WeakSet(),
    dirty: new Set(),
    scheduledGeneration: new WeakMap(),
    heap: [],
    retired: false,
  };
  for (const person of state.people) registerPerson(index, person);
  MEMORY_MAINTENANCE_BY_STATE.set(state, index);
  return index;
}

function replaceMemoryMaintenanceIndex(state: SimulationState, previous?: MemoryMaintenanceIndex): MemoryMaintenanceIndex {
  if (previous) retireMemoryMaintenanceIndex(previous);
  return createMemoryMaintenanceIndex(state);
}

function appendedPeople(index: MemoryMaintenanceIndex, people: PersonState[]): PersonState[] | null {
  if (people !== index.people || people.length < index.knownLength) return null;
  if (index.knownLength > 0 && (
    people[0] !== index.firstKnownPerson
    || people[index.knownLength - 1] !== index.lastKnownPerson
  )) return null;
  return people.slice(index.knownLength);
}

function scheduleNextDeadMaintenance(
  index: MemoryMaintenanceIndex,
  person: PersonState,
  afterMonth: number,
): void {
  const generation = (index.scheduledGeneration.get(person) ?? 0) + 1;
  index.scheduledGeneration.set(person, generation);
  const month = nextDeadMemoryChangeMonth(person, afterMonth);
  if (month !== undefined) pushScheduled(index, { month, generation, person });
}

/**
 * Incremental authoritative memory fold for the monthly main loop. The first
 * call (and any ownership rewrite) performs one O(P) rebuild. Sequential
 * steady-state months visit every living person, newly appended people,
 * explicitly dirtied dead people, and only dead people whose forecasted fold
 * changes in that month. The index and forecast clones are runtime-only.
 */
export function maintainDueMemories(state: SimulationState, atMonth: number): void {
  let index = MEMORY_MAINTENANCE_BY_STATE.get(state);
  let targets: PersonState[];
  if (!index) {
    index = createMemoryMaintenanceIndex(state);
    targets = [...state.people];
  } else {
    const suffix = appendedPeople(index, state.people);
    const sequential = index.lastMaintainedAtMonth !== undefined
      && atMonth === index.lastMaintainedAtMonth + 1;
    if (!suffix || !sequential) {
      index = replaceMemoryMaintenanceIndex(state, index);
      targets = [...state.people];
    } else {
      for (const person of suffix) registerPerson(index, person);
      const selected = new Set<PersonState>(index.living);
      while (index.heap.length > 0 && index.heap[0].month <= atMonth) {
        const scheduled = popScheduled(index);
        if (!scheduled
          || index.scheduledGeneration.get(scheduled.person) !== scheduled.generation
          || !index.members.has(scheduled.person)) continue;
        selected.add(scheduled.person);
      }
      for (const person of index.dirty) {
        if (index.members.has(person)) selected.add(person);
      }
      index.dirty.clear();
      for (const person of suffix) selected.add(person);
      targets = [...selected];
    }
  }

  const living: PersonState[] = [];
  for (const person of targets) {
    maintainPersonMemories(person, atMonth);
    if (isAlive(person)) living.push(person);
    else scheduleNextDeadMaintenance(index, person, atMonth);
  }
  index.living = living;
  index.knownLength = state.people.length;
  index.firstKnownPerson = state.people[0];
  index.lastKnownPerson = state.people[state.people.length - 1];
  index.lastMaintainedAtMonth = atMonth;
}

export function projectMemories(person: PersonState, atMonth: number): Array<Pick<MemoryRecord, 'kind' | 'summary' | 'importance' | 'personIds'>> {
  const ranked = person.memories
    .filter((memory) => memory.kind !== 'commitment' || (memory.expiresAtMonth ?? atMonth) >= atMonth)
    .sort((a, b) => score(person, b, atMonth) - score(person, a, atMonth) || b.createdAtMonth - a.createdAtMonth);
  let dialogueCount = 0;
  return ranked
    .filter((memory) => memory.kind !== 'dialogue' || dialogueCount++ < 2)
    .slice(0, personProjectedMemoryCapacity(person))
    .map(({ kind, summary, importance, personIds }) => ({ kind, summary, importance, personIds }));
}

export function rememberAction(state: SimulationState, fact: ActionFact): void {
  const actor = personById(state, fact.who);
  if (!actor) return;
  const causal = isMeaningfulCognitiveOutcome(fact)
    ? causalMemoryTraceForAction(state, fact)
    : undefined;
  const participantIds = fact.action.kind === 'communicate'
    ? fact.action.audience
    : fact.action.kind === 'transfer'
      ? [
          ...(fact.action.from.kind === 'person' ? [fact.action.from.personId] : []),
          ...(fact.action.to.kind === 'person' ? [fact.action.to.personId] : []),
        ]
      : fact.action.kind === 'act'
        ? fact.action.targets.flatMap((target) => target.kind === 'person' ? [target.personId] : [])
        : fact.action.kind === 'attend' && fact.action.target.kind === 'person'
          ? [fact.action.target.personId]
          : [];
  const others = [...new Set(participantIds)]
    .filter((personId) => personId !== actor.id)
    .flatMap((personId) => {
      const person = personById(state, personId);
      return person ? [person] : [];
    });
  const failed = fact.status === 'blocked' || fact.status === 'failed';
  const boundedFailureExpiresAt = failed
    && fact.diff.projectMaterialDeliveryRestricted === true
    && Number.isFinite(Number(fact.diff.expiresAtMonth))
    ? Number(fact.diff.expiresAtMonth)
    : undefined;
  const groundedCommunication = fact.action.kind === 'communicate'
    && fact.action.content.kind === 'claim'
    && Boolean(fact.action.content.conversation);
  const structuredCommunication = fact.action.kind === 'communicate'
    && (['request', 'offer', 'accept'].includes(fact.action.content.kind)
      || (fact.action.content.kind === 'claim' && Boolean(fact.action.content.factId)));
  remember(actor, {
    id: `memory:${fact.id}:${actor.id}`,
    kind: failed ? 'failure' : fact.action.kind === 'communicate' && ['request', 'offer', 'accept'].includes(fact.action.content.kind) ? 'commitment' : fact.action.kind === 'communicate' ? 'dialogue' : 'episode',
    summary: fact.result,
    importance: failed ? 72 : groundedCommunication ? 62 : structuredCommunication ? 64 : fact.action.kind === 'communicate' ? 42 : 38,
    createdAtMonth: fact.atMonth,
    lastRecalledAtMonth: fact.atMonth,
    personIds: others.map((person) => person.id),
    sourceEventIds: [fact.id],
    ...(causal ? { causal } : {}),
    ...(boundedFailureExpiresAt !== undefined ? { expiresAtMonth: boundedFailureExpiresAt } : {}),
    ...(fact.action.kind === 'communicate' && (fact.action.content.kind === 'request' || fact.action.content.kind === 'offer')
      ? { expiresAtMonth: fact.action.content.proposal?.expiresAtMonth ?? fact.atMonth + 6 }
      : {}),
  });
  if (fact.action.kind === 'act' && fact.action.operation === 'exert' && typeof fact.diff.victimId === 'string') {
    const victimId = fact.diff.victimId;
    const observerIds = Array.isArray(fact.diff.witnessedBy) ? fact.diff.witnessedBy.filter((id): id is string => typeof id === 'string') : [];
    for (const observerId of new Set([victimId, ...observerIds])) {
      const observer = personById(state, observerId);
      if (!observer || observer.id === actor.id) continue;
      const victim = personById(state, victimId);
      remember(observer, {
        id: `memory:${fact.id}:${observer.id}`,
        kind: 'episode',
        summary: observer.id === victimId
          ? `${actor.name}对自己施力并造成了${Number(fact.diff.damage) || 0}点伤害`
          : `亲眼看见${actor.name}对${victim?.name ?? '另一人'}施力并造成伤害`,
        importance: observer.id === victimId ? 96 : 78,
        createdAtMonth: fact.atMonth,
        lastRecalledAtMonth: fact.atMonth,
        personIds: [...new Set([actor.id, victimId])],
        sourceEventIds: [fact.id],
      });
    }
  }
  const personTransfer = fact.action.kind === 'transfer' && fact.action.from.kind === 'person' ? fact.action : undefined;
  if (personTransfer) {
    const transfer = personTransfer;
    const transferFrom = transfer.from;
    const transferTo = transfer.to;
    if (transferFrom.kind !== 'person') return;
    const sourceOwnerId = transferFrom.personId;
    const sourceOwner = personById(state, sourceOwnerId);
    const receiverId = transferTo.kind === 'person' ? transferTo.personId : undefined;
    const receiver = receiverId ? personById(state, receiverId) : undefined;
    const unauthorized = fact.diff.authorized === false;
    const observerIds = Array.isArray(fact.diff.witnessedBy) ? fact.diff.witnessedBy.filter((id): id is string => typeof id === 'string') : [];
    const participantIds = unauthorized ? [sourceOwner?.id, receiver?.id, ...observerIds] : [receiver?.id];
    for (const observerId of new Set(participantIds.filter((id): id is string => Boolean(id)))) {
      const observer = personById(state, observerId);
      if (!observer || observer.id === actor.id) continue;
      remember(observer, {
        id: `memory:${fact.id}:${observer.id}`,
        kind: 'episode',
        summary: unauthorized
          ? `${actor.name}未经允许试图从${sourceOwner?.name ?? '他人'}处取得物质：${fact.result}`
          : `${actor.name}把物质转交给自己：${fact.result}`,
        importance: unauthorized ? (observer.id === sourceOwner?.id ? 94 : 76) : 72,
        createdAtMonth: fact.atMonth,
        lastRecalledAtMonth: fact.atMonth,
        personIds: [...new Set([actor.id, ...(sourceOwner ? [sourceOwner.id] : []), ...(receiver ? [receiver.id] : [])])],
        sourceEventIds: [fact.id],
      });
    }
  }
  if (fact.action.kind === 'act' && typeof fact.diff.caredPersonId === 'string') {
    const cared = personById(state, fact.diff.caredPersonId);
    if (cared && cared.id !== actor.id) remember(cared, {
      id: `memory:${fact.id}:${cared.id}`,
      kind: 'episode',
      summary: `${actor.name}使用具体材料照护了自己的伤病`,
      importance: 84,
      createdAtMonth: fact.atMonth,
      lastRecalledAtMonth: fact.atMonth,
      personIds: [actor.id],
      sourceEventIds: [fact.id],
    });
  }
  if (fact.action.kind === 'act' && typeof fact.diff.restrainedPersonId === 'string' && typeof fact.diff.conditionId === 'string') {
    const restrainedId = fact.diff.restrainedPersonId;
    const observerIds = Array.isArray(fact.diff.witnessedBy) ? fact.diff.witnessedBy.filter((id): id is string => typeof id === 'string') : [];
    for (const observerId of new Set([restrainedId, ...observerIds])) {
      const observer = personById(state, observerId);
      if (!observer || observer.id === actor.id) continue;
      const restrained = personById(state, restrainedId);
      remember(observer, {
        id: `memory:${fact.id}:${observer.id}`, kind: 'episode',
        summary: observer.id === restrainedId ? `${actor.name}用绳拘束了我` : `亲眼看见${actor.name}用绳拘束${restrained?.name ?? '另一人'}`,
        importance: observer.id === restrainedId ? 98 : 82,
        createdAtMonth: fact.atMonth, lastRecalledAtMonth: fact.atMonth,
        personIds: [...new Set([actor.id, restrainedId])], sourceEventIds: [fact.id],
      });
    }
  }
  if (fact.action.kind !== 'communicate') return;
  const content = fact.action.content;
  const commitment = content.kind === 'request' || content.kind === 'offer' || content.kind === 'accept';
  for (const listener of others) {
    remember(listener, {
      id: `memory:${fact.id}:${listener.id}`,
      kind: commitment ? 'commitment' : 'dialogue',
      summary: fact.result,
      importance: commitment ? 82 : content.kind === 'claim' && content.factId ? 66 : 40,
      createdAtMonth: fact.atMonth,
      lastRecalledAtMonth: fact.atMonth,
      personIds: [actor.id],
      sourceEventIds: [fact.id],
      ...(content.kind === 'request' || content.kind === 'offer' ? { expiresAtMonth: content.proposal?.expiresAtMonth ?? fact.atMonth + 6 } : {}),
    });
  }
}
