import type { ActionFact, SimulationState } from './model';
import type {
  HexacoTrait,
  HexacoVector,
  MotiveSensitivity,
  PersonalityEvidence,
  PersonalityState,
  PersonState,
} from './person';
import { seededFraction } from '../world/generator';

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
    return;
  }
  person.personality.evidence.push(next);
  if (person.personality.evidence.length <= MAX_EVIDENCE) return;
  person.personality.evidence = [...person.personality.evidence]
    .sort((left, right) => Number(Boolean(left.consolidatedInto)) - Number(Boolean(right.consolidatedInto))
      || right.atMonth - left.atMonth)
    .slice(0, MAX_EVIDENCE)
    .sort((left, right) => left.atMonth - right.atMonth || left.id.localeCompare(right.id));
}

function projectContext(state: SimulationState, fact: ActionFact): string | undefined {
  if (!fact.intentId) return undefined;
  const intent = state.intents.find((candidate) => candidate.id === fact.intentId);
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
  const person = state.people.find((candidate) => candidate.id === fact.who);
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
    const intent = state.intents.find((candidate) => candidate.id === fact.intentId);
    const project = intent?.projectId ? state.projects.find((candidate) => candidate.id === intent.projectId) : undefined;
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
export function consolidatePersonality(state: SimulationState, atMonth: number): void {
  for (const person of state.people) for (const trait of HEXACO_TRAITS) {
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
  }
}
