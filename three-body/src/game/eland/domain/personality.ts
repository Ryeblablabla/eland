import type { ActionFact, SimulationState } from './model';
import type {
  HexacoTrait,
  HexacoVector,
  MotiveSensitivity,
  PersonalityEvidence,
  PersonalityState,
  PersonState,
} from './person';
import { isAlive } from './person';
import { seededFraction } from '../world/generator';
import { intentById, personById, projectById } from './state-index';

export const HEXACO_TRAITS: HexacoTrait[] = [
  'honestyHumility',
  'emotionality',
  'extraversion',
  'agreeableness',
  'conscientiousness',
  'openness',
];

const ZERO_VECTOR: HexacoVector = {
  honestyHumility: 0,
  emotionality: 0,
  extraversion: 0,
  agreeableness: 0,
  conscientiousness: 0,
  openness: 0,
};

const MAX_EVIDENCE = 120;
const MAX_CHANGES = 48;
const MAX_LEARNED_DELTA = 20;
const MIN_EVIDENCE_MONTHS = 3;
const MIN_EVIDENCE_CONTEXTS = 2;
const MIN_EVIDENCE_STRENGTH = 120;
const MAX_CHANGES_PER_ROLLING_YEAR = 2;

type PersonalityOwner = Pick<PersonState, 'id' | 'personality'>;

interface ScheduledPersonalityConsolidation {
  month: number;
  generation: number;
  person: PersonState;
}

interface PersonalityConsolidationIndex {
  people: PersonState[];
  knownLength: number;
  firstKnownPerson?: PersonState;
  lastKnownPerson?: PersonState;
  living: PersonState[];
  members: WeakSet<PersonState>;
  dirty: Set<PersonState>;
  scheduledGeneration: WeakMap<PersonState, number>;
  heap: ScheduledPersonalityConsolidation[];
  lastConsolidatedAtMonth?: number;
  retired: boolean;
}

const PERSONALITY_CONSOLIDATION_BY_STATE = new WeakMap<SimulationState, PersonalityConsolidationIndex>();
const PERSONALITY_CONSOLIDATION_BY_PERSON = new WeakMap<PersonState, PersonalityConsolidationIndex>();

function markPersonalityConsolidationDirty(person: PersonState): void {
  const owner = PERSONALITY_CONSOLIDATION_BY_PERSON.get(person);
  if (owner && !owner.retired) owner.dirty.add(person);
}

function retirePersonalityConsolidationIndex(index: PersonalityConsolidationIndex): void {
  index.retired = true;
  index.people = [];
  index.living = [];
  index.heap = [];
  index.dirty.clear();
}

/**
 * `state.people` is append-only during ordinary evolution. Same-array middle
 * replacement, splice, or sort is an exceptional ownership rewrite and must
 * call this hook so the next month takes the safe all-person rebuild path.
 * Whole-array replacement, truncation, and a changed old tail are detected.
 */
export function invalidatePersonalityConsolidationIndex(state: SimulationState): void {
  const existing = PERSONALITY_CONSOLIDATION_BY_STATE.get(state);
  if (existing) retirePersonalityConsolidationIndex(existing);
  PERSONALITY_CONSOLIDATION_BY_STATE.delete(state);
}

/**
 * Normal personality evidence writes invalidate their person automatically.
 * Call this after directly replacing or mutating a dead person's personality;
 * living people are consolidated every month.
 */
export function invalidatePersonPersonalityConsolidation(person: PersonState): void {
  markPersonalityConsolidationDirty(person);
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function centeredSample(seed: number, key: string): number {
  const average = (
    seededFraction(seed, `${key}:a`)
    + seededFraction(seed, `${key}:b`)
    + seededFraction(seed, `${key}:c`)
  ) / 3;
  return Math.round(20 + average * 60);
}

function inheritedScore(seed: number, key: string, first: number, second = first): number {
  const parentMean = (first + second) / 2;
  const individualVariation = (seededFraction(seed, `${key}:variation`) - 0.5) * 24;
  return Math.round(clamp(parentMean + individualVariation, 15, 85));
}

export function createPersonality(
  seed: number,
  personId: string,
  parents: PersonalityState[] = [],
): PersonalityState {
  const baseline = Object.fromEntries(HEXACO_TRAITS.map((trait) => {
    if (!parents.length) return [trait, centeredSample(seed, `hexaco:${personId}:${trait}`)];
    return [trait, inheritedScore(
      seed,
      `hexaco:${personId}:${trait}`,
      parents[0].baseline[trait],
      parents[1]?.baseline[trait],
    )];
  })) as unknown as HexacoVector;
  return { baseline, learnedDelta: { ...ZERO_VECTOR }, evidence: [], changes: [] };
}

export function createMotiveSensitivity(seed: number, personId: string): MotiveSensitivity {
  return {
    control: centeredSample(seed, `motive:${personId}:control`),
    status: centeredSample(seed, `motive:${personId}:status`),
  };
}

export function personalityScore(person: PersonState, trait: HexacoTrait): number {
  return clamp(person.personality.baseline[trait] + person.personality.learnedDelta[trait]);
}

/**
 * Weak, replayable social prior for people actually present at a birth.
 * Agreeableness carries most of the weight and extraversion only adjusts
 * approach. The 3..9 range stays below companionship (20) and reproduction
 * (60), so temperament can open contact without inventing earned closeness.
 */
export function newbornInitialTrust(person: Pick<PersonState, 'personality'>): number {
  const agreeableness = clamp(
    person.personality.baseline.agreeableness + person.personality.learnedDelta.agreeableness,
  );
  const extraversion = clamp(
    person.personality.baseline.extraversion + person.personality.learnedDelta.extraversion,
  );
  return Math.round(clamp(2 + (agreeableness * 0.7 + extraversion * 0.3) * 0.08, 3, 9));
}

/**
 * How many same-place planning ticks this person needs before shared activity
 * becomes one unit of relationship evidence. Extraversion mainly affects how
 * readily repeated contact becomes familiarity; agreeableness affects how
 * readily that familiarity is interpreted positively.
 */
export function sharedActivityTickThreshold(
  person: Pick<PersonState, 'personality'>,
): 3 | 4 | 5 {
  const agreeableness = clamp(
    person.personality.baseline.agreeableness + person.personality.learnedDelta.agreeableness,
  );
  const extraversion = clamp(
    person.personality.baseline.extraversion + person.personality.learnedDelta.extraversion,
  );
  const socialReadiness = extraversion * 0.6 + agreeableness * 0.4;
  if (socialReadiness >= 65) return 3;
  if (socialReadiness >= 40) return 4;
  return 5;
}

/**
 * Young people turn an earned month of shared experience into trust more
 * readily. This never creates evidence by itself and does not accelerate bond.
 */
export function youthfulSharedActivityTrustBonus(ageInMonths: number): 0 | 1 | 2 {
  if (ageInMonths < 16 * 12) return 2;
  if (ageInMonths < 30 * 12) return 1;
  return 0;
}

export function effectivePersonality(person: PersonState): HexacoVector {
  return Object.fromEntries(HEXACO_TRAITS.map((trait) => [trait, personalityScore(person, trait)])) as unknown as HexacoVector;
}

/** Centered, capped decision modulation. Traits never make an illegal option legal. */
export function personalityBias(person: PersonState, trait: HexacoTrait, scale: number, cap = 10): number {
  return Math.max(-cap, Math.min(cap, (personalityScore(person, trait) - 50) * scale));
}

export function personalityEvidenceSourceIds(person: PersonState, traits: HexacoTrait[]): string[] {
  const selected = new Set(traits);
  return [...new Set(person.personality.changes
    .filter((change) => selected.has(change.trait))
    .slice(-6)
    .flatMap((change) => change.sourceEventIds))].slice(-24);
}

function evidence(
  person: PersonState,
  fact: ActionFact,
  trait: HexacoTrait,
  direction: -1 | 1,
  strength: number,
  contextKey: string,
): PersonalityEvidence {
  return {
    id: `personality-evidence:${person.id}:${fact.id}:${trait}:${direction}`,
    trait,
    direction,
    strength: Math.round(clamp(strength)),
    contextKey,
    atMonth: fact.atMonth,
    sourceEventIds: [fact.id],
  };
}

function addEvidence(person: PersonState, next: PersonalityEvidence): void {
  const sameContextThisMonth = person.personality.evidence.find((current) => !current.consolidatedInto
    && current.trait === next.trait
    && current.direction === next.direction
    && current.atMonth === next.atMonth
    && current.contextKey === next.contextKey);
  if (sameContextThisMonth) {
    sameContextThisMonth.strength = Math.max(sameContextThisMonth.strength, next.strength);
    sameContextThisMonth.sourceEventIds = [...new Set([...sameContextThisMonth.sourceEventIds, ...next.sourceEventIds])].slice(-8);
    markPersonalityConsolidationDirty(person);
    return;
  }
  person.personality.evidence.push(next);
  if (person.personality.evidence.length > MAX_EVIDENCE) {
    person.personality.evidence = [...person.personality.evidence]
      .sort((left, right) => Number(Boolean(left.consolidatedInto)) - Number(Boolean(right.consolidatedInto))
        || right.atMonth - left.atMonth)
      .slice(0, MAX_EVIDENCE)
      .sort((left, right) => left.atMonth - right.atMonth || left.id.localeCompare(right.id));
  }
  markPersonalityConsolidationDirty(person);
}

function projectContext(state: SimulationState, fact: ActionFact): string | undefined {
  if (!fact.intentId) return undefined;
  const intent = intentById(state, fact.intentId);
  if (!intent?.projectId) return undefined;
  return `project:${intent.projectId}`;
}

/**
 * Translate only diagnostic, voluntary action facts into person-local evidence.
 * Outcomes change expectations elsewhere; this function does not infer a trait
 * from failed reflexes, forced acts, or mere absence of behavior.
 */
export function recordPersonalityEvidence(state: SimulationState, fact: ActionFact): void {
  const resistedTaking = fact.action.kind === 'transfer' && fact.diff.attempted === true && fact.diff.authorized === false;
  if (fact.cause !== 'intent' || fact.status === 'failed' || (fact.status === 'blocked' && !resistedTaking)) return;
  const person = personById(state, fact.who);
  if (!person) return;
  const urgent = person.body.health < 25 || person.body.hydration < 22 || person.body.nutrition < 24;
  const action = fact.action;

  if (action.kind === 'transfer'
    && action.from.kind === 'person'
    && action.from.personId !== person.id
    && fact.diff.authorized === false) {
    addEvidence(person, evidence(person, fact, 'honestyHumility', -1, urgent ? 28 : 72, `unauthorized-taking:${action.from.personId}`));
  }

  if (action.kind === 'transfer' && action.authorizationRef && fact.diff.authorized === true) {
    addEvidence(person, evidence(person, fact, 'honestyHumility', 1, 46, `authorized-transfer:${action.authorizationRef}`));
    addEvidence(person, evidence(person, fact, 'conscientiousness', 1, 52, `fulfilled-transfer:${action.authorizationRef}`));
  }

  if (action.kind === 'communicate') {
    const content = action.content;
    const initiating = content.kind === 'claim' || content.kind === 'prediction' || content.kind === 'request' || content.kind === 'offer';
    if (initiating && action.channel !== 'record') {
      const audience = [...action.audience].sort().join(',') || 'public';
      addEvidence(person, evidence(person, fact, 'extraversion', 1, 38, `social-initiation:${audience}`));
    }
    if (content.kind === 'accept') {
      addEvidence(person, evidence(person, fact, 'agreeableness', 1, 32, `accepted-proposal:${content.referenceId}`));
    }
  }

  if (action.kind === 'attend') {
    addEvidence(person, evidence(person, fact, 'openness', 1, 48, `attend:${action.target.kind}`));
  }

  const projectKey = projectContext(state, fact);
  if (projectKey && (fact.status === 'completed' || fact.status === 'progressed')) {
    addEvidence(person, evidence(person, fact, 'conscientiousness', 1, 34, projectKey));
    const intent = fact.intentId ? intentById(state, fact.intentId) : undefined;
    const project = intent?.projectId ? projectById(state, intent.projectId) : undefined;
    if (project?.kind === 'inquiry') addEvidence(person, evidence(person, fact, 'openness', 1, 42, projectKey));
  }

  if (action.kind === 'act' && typeof fact.diff.caredPersonId === 'string') {
    const target = String(fact.diff.caredPersonId);
    addEvidence(person, evidence(person, fact, 'emotionality', 1, 44, `care:${target}`));
    addEvidence(person, evidence(person, fact, 'agreeableness', 1, 44, `care:${target}`));
  }

  if (action.kind === 'act' && action.operation === 'exert' && typeof fact.diff.victimId === 'string') {
    const target = String(fact.diff.victimId);
    addEvidence(person, evidence(person, fact, 'agreeableness', -1, urgent ? 34 : 70, `interpersonal-harm:${target}`));
    if (!urgent) addEvidence(person, evidence(person, fact, 'honestyHumility', -1, 42, `interpersonal-harm:${target}`));
  }

  if (action.kind === 'act' && typeof fact.diff.restrainedPersonId === 'string') {
    const target = String(fact.diff.restrainedPersonId);
    addEvidence(person, evidence(person, fact, 'agreeableness', -1, urgent ? 30 : 62, `restraint:${target}`));
    if (!urgent) addEvidence(person, evidence(person, fact, 'honestyHumility', -1, 42, `restraint:${target}`));
  }

  if (action.kind === 'act' && typeof fact.diff.releasedPersonId === 'string') {
    const target = String(fact.diff.releasedPersonId);
    addEvidence(person, evidence(person, fact, 'agreeableness', 1, 48, `release-restraint:${target}`));
  }
}

function eligibleEvidence(items: PersonalityEvidence[], direction: -1 | 1): PersonalityEvidence[] {
  return items.filter((item) => item.direction === direction && !item.consolidatedInto);
}

function qualifies(items: PersonalityEvidence[]): boolean {
  return new Set(items.map((item) => item.atMonth)).size >= MIN_EVIDENCE_MONTHS
    && new Set(items.map((item) => item.contextKey)).size >= MIN_EVIDENCE_CONTEXTS
    && items.reduce((sum, item) => sum + item.strength, 0) >= MIN_EVIDENCE_STRENGTH;
}

/** Consolidate at most two one-point changes per trait in any rolling year. */
function consolidatePersonalityForPerson(person: PersonalityOwner, atMonth: number): boolean {
  let changed = false;
  for (const trait of HEXACO_TRAITS) {
    const recentChanges = person.personality.changes.filter((change) => change.trait === trait && atMonth - change.atMonth < 12);
    if (recentChanges.length >= MAX_CHANGES_PER_ROLLING_YEAR) continue;
    const pending = person.personality.evidence.filter((item) => item.trait === trait && !item.consolidatedInto && atMonth - item.atMonth <= 36);
    const positive = eligibleEvidence(pending, 1);
    const negative = eligibleEvidence(pending, -1);
    const positiveStrength = qualifies(positive) ? positive.reduce((sum, item) => sum + item.strength, 0) : 0;
    const negativeStrength = qualifies(negative) ? negative.reduce((sum, item) => sum + item.strength, 0) : 0;
    if (!positiveStrength && !negativeStrength) continue;
    if (positiveStrength && negativeStrength && Math.abs(positiveStrength - negativeStrength) < 40) continue;
    const direction: -1 | 1 = positiveStrength > negativeStrength ? 1 : -1;
    const selected = direction === 1 ? positive : negative;
    const currentDelta = person.personality.learnedDelta[trait];
    const nextDelta = Math.max(-MAX_LEARNED_DELTA, Math.min(MAX_LEARNED_DELTA, currentDelta + direction));
    if (nextDelta === currentDelta) continue;
    const changeId = `personality-change:${person.id}:${trait}:${atMonth}:${person.personality.changes.length}`;
    const consumed = pending.filter((item) => item.direction === direction || Math.abs(positiveStrength - negativeStrength) >= 40);
    for (const item of consumed) item.consolidatedInto = changeId;
    person.personality.learnedDelta[trait] = nextDelta;
    person.personality.changes.push({
      id: changeId,
      trait,
      delta: direction,
      atMonth,
      evidenceIds: selected.map((item) => item.id),
      sourceEventIds: [...new Set(selected.flatMap((item) => item.sourceEventIds))].slice(-24),
    });
    person.personality.changes = person.personality.changes.slice(-MAX_CHANGES);
    changed = true;
  }
  return changed;
}

/** Exact all-person fold retained as the simple reference implementation. */
export function consolidatePersonality(state: SimulationState, atMonth: number): void {
  invalidatePersonalityConsolidationIndex(state);
  for (const person of state.people) consolidatePersonalityForPerson(person, atMonth);
}

function scheduledBefore(
  left: ScheduledPersonalityConsolidation,
  right: ScheduledPersonalityConsolidation,
): boolean {
  return left.month < right.month
    || left.month === right.month && left.person.id.localeCompare(right.person.id) < 0;
}

function pushScheduled(
  index: PersonalityConsolidationIndex,
  item: ScheduledPersonalityConsolidation,
): void {
  index.heap.push(item);
  let child = index.heap.length - 1;
  while (child > 0) {
    const parent = Math.floor((child - 1) / 2);
    if (!scheduledBefore(index.heap[child], index.heap[parent])) break;
    [index.heap[parent], index.heap[child]] = [index.heap[child], index.heap[parent]];
    child = parent;
  }
}

function popScheduled(index: PersonalityConsolidationIndex): ScheduledPersonalityConsolidation | undefined {
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

function compactScheduled(index: PersonalityConsolidationIndex): void {
  const maximumRetainedEntries = index.people.length * 2 + 64;
  if (index.heap.length <= maximumRetainedEntries) return;
  const current = index.heap.filter((scheduled) => (
    index.members.has(scheduled.person)
    && index.scheduledGeneration.get(scheduled.person) === scheduled.generation
  ));
  index.heap = [];
  for (const scheduled of current) pushScheduled(index, scheduled);
}

/**
 * Dead people receive no ordinary action evidence. Starting from an isolated
 * personality clone, replay at most the remaining 36-month evidence window
 * and return the first month whose normal fold changes authoritative
 * personality fields. Rolling-year releases and mixed-direction expiry are
 * therefore scheduled without mutating the real person's evidence.
 */
function nextDeadPersonalityChangeMonth(person: PersonState, afterMonth: number): number | undefined {
  if (!Number.isSafeInteger(afterMonth)) return afterMonth + 1;
  const unconsolidated = person.personality.evidence.filter((item) => !item.consolidatedInto);
  if (!unconsolidated.length) return undefined;
  if (unconsolidated.some((item) => !Number.isSafeInteger(item.atMonth) || item.atMonth > afterMonth)
    || person.personality.changes.some((change) => !Number.isSafeInteger(change.atMonth) || change.atMonth > afterMonth)) {
    return afterMonth + 1;
  }
  const stillPotentiallyVisible = unconsolidated.filter((item) => afterMonth - item.atMonth <= 36);
  if (!stillPotentiallyVisible.length) return undefined;
  const lastEvidenceMonth = Math.max(...stillPotentiallyVisible.map((item) => item.atMonth));
  const finalCandidateMonth = lastEvidenceMonth + 36;
  const forecast: PersonalityOwner = {
    id: person.id,
    personality: structuredClone(person.personality),
  };
  for (let month = afterMonth + 1; month <= finalCandidateMonth; month += 1) {
    if (consolidatePersonalityForPerson(forecast, month)) return month;
  }
  return undefined;
}

function registerPerson(index: PersonalityConsolidationIndex, person: PersonState): void {
  index.members.add(person);
  PERSONALITY_CONSOLIDATION_BY_PERSON.set(person, index);
}

function createPersonalityConsolidationIndex(state: SimulationState): PersonalityConsolidationIndex {
  const index: PersonalityConsolidationIndex = {
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
  PERSONALITY_CONSOLIDATION_BY_STATE.set(state, index);
  return index;
}

function replacePersonalityConsolidationIndex(
  state: SimulationState,
  previous?: PersonalityConsolidationIndex,
): PersonalityConsolidationIndex {
  if (previous) retirePersonalityConsolidationIndex(previous);
  return createPersonalityConsolidationIndex(state);
}

function appendedPeople(index: PersonalityConsolidationIndex, people: PersonState[]): PersonState[] | null {
  if (people !== index.people || people.length < index.knownLength) return null;
  if (index.knownLength > 0 && (
    people[0] !== index.firstKnownPerson
    || people[index.knownLength - 1] !== index.lastKnownPerson
  )) return null;
  return people.slice(index.knownLength);
}

function scheduleNextDeadConsolidation(
  index: PersonalityConsolidationIndex,
  person: PersonState,
  afterMonth: number,
): void {
  const generation = (index.scheduledGeneration.get(person) ?? 0) + 1;
  index.scheduledGeneration.set(person, generation);
  const month = nextDeadPersonalityChangeMonth(person, afterMonth);
  if (month !== undefined) pushScheduled(index, { month, generation, person });
}

/**
 * Incremental monthly personality fold. The first call and ownership rewrites
 * take the exact O(P) reference path. Sequential steady-state months visit all
 * living people, appended people, explicitly dirtied dead people, and only
 * dead people whose private forecast changes in that month.
 */
export function consolidateDuePersonalities(state: SimulationState, atMonth: number): void {
  let index = PERSONALITY_CONSOLIDATION_BY_STATE.get(state);
  let targets: PersonState[];
  if (!index) {
    index = createPersonalityConsolidationIndex(state);
    targets = [...state.people];
  } else {
    const suffix = appendedPeople(index, state.people);
    const sequential = index.lastConsolidatedAtMonth !== undefined
      && atMonth === index.lastConsolidatedAtMonth + 1;
    if (!suffix || !sequential) {
      index = replacePersonalityConsolidationIndex(state, index);
      targets = [...state.people];
    } else {
      for (const person of suffix) registerPerson(index, person);
      compactScheduled(index);
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
    consolidatePersonalityForPerson(person, atMonth);
    if (isAlive(person)) living.push(person);
    else scheduleNextDeadConsolidation(index, person, atMonth);
  }
  index.living = living;
  index.knownLength = state.people.length;
  index.firstKnownPerson = state.people[0];
  index.lastKnownPerson = state.people[state.people.length - 1];
  index.lastConsolidatedAtMonth = atMonth;
  compactScheduled(index);
}
