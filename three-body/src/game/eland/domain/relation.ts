import type { DirectedRelation, PersonState } from './person';

/**
 * A shared arrival means the founders recognize one another; it is not a
 * pre-existing friendship or intimate bond.  Existing saves retain their
 * persisted relation caches, while newly created civilizations start below
 * every formal-companionship threshold and must grow the relation from lived
 * evidence.
 */
export const FOUNDER_INITIAL_RELATION = 10;
export const COMPANION_RELATION_THRESHOLD = 20;

export function relationshipPairKey(firstId: string, secondId: string): string {
  return [firstId, secondId].sort().join('|');
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

interface AppendOnlyRelationIndex {
  indexedLength: number;
  lastIndexedRelation?: DirectedRelation;
  offsetByPersonId: Map<string, number>;
}

/**
 * Relations remain an ordinary serializable array in authoritative state. The
 * production mutation contract is append-only writes through
 * applyRelationEvidence or replacement of the whole array. A replacement gets
 * a new WeakMap key and an append extends the indexed suffix. Any exceptional
 * in-place splice, sort, copyWithin, or index assignment must explicitly call
 * invalidateRelationIndex before the next lookup.
 */
const relationIndexes = new WeakMap<PersonState['relations'], AppendOnlyRelationIndex>();

/** Invalidate the disposable runtime index after an exceptional in-place array rewrite. */
export function invalidateRelationIndex(person: Pick<PersonState, 'relations'>): void {
  relationIndexes.delete(person.relations);
}

function relationIndexInvalid(relations: DirectedRelation[], index: AppendOnlyRelationIndex): boolean {
  return index.indexedLength > relations.length
    || (index.indexedLength > 0 && relations[index.indexedLength - 1] !== index.lastIndexedRelation);
}

function relationIndex(relations: DirectedRelation[]): AppendOnlyRelationIndex {
  let index = relationIndexes.get(relations);
  if (!index || relationIndexInvalid(relations, index)) {
    index = { indexedLength: 0, offsetByPersonId: new Map() };
    relationIndexes.set(relations, index);
  }
  for (let offset = index.indexedLength; offset < relations.length; offset += 1) {
    const relation = relations[offset]!;
    // Preserve Array.find semantics for malformed duplicate relation ids.
    if (!index.offsetByPersonId.has(relation.personId)) {
      index.offsetByPersonId.set(relation.personId, offset);
    }
  }
  index.indexedLength = relations.length;
  index.lastIndexedRelation = relations.at(-1);
  return index;
}

export function relationTo(person: PersonState, otherId: string): DirectedRelation | undefined {
  let index = relationIndex(person.relations);
  let offset = index.offsetByPersonId.get(otherId);
  let relation = offset === undefined ? undefined : person.relations[offset];
  if (relation && relation.personId !== otherId) {
    relationIndexes.delete(person.relations);
    index = relationIndex(person.relations);
    offset = index.offsetByPersonId.get(otherId);
    relation = offset === undefined ? undefined : person.relations[offset];
  }
  return relation;
}

/** Relation values are caches over witnessed events; every mutation carries evidence. */
export function applyRelationEvidence(
  person: PersonState,
  otherId: string,
  eventId: string,
  delta: Partial<Pick<DirectedRelation, 'trust' | 'bond' | 'fear'>>,
): void {
  const trustDelta = delta.trust ?? 0;
  const bondDelta = delta.bond ?? 0;
  const fearDelta = delta.fear ?? 0;
  if (eventId.length === 0) {
    // An empty, all-zero call remains a harmless no-op. A real mutation without
    // evidence is an authority violation and must stop before touching state.
    if (trustDelta !== 0 || bondDelta !== 0 || fearDelta !== 0) {
      throw new Error('relation evidence requires a non-empty event id');
    }
    return;
  }
  let relation = relationTo(person, otherId);
  if (!relation) {
    // Defensive write-only fallback: a caller that violated the in-place
    // rewrite contract must not make the stale index append a duplicate edge.
    const existing = person.relations.find((candidate) => candidate.personId === otherId);
    if (existing) {
      invalidateRelationIndex(person);
      relation = relationTo(person, otherId);
    }
  }
  if (!relation) {
    relation = { personId: otherId, trust: 0, bond: 0, fear: 0, sourceEventIds: [] };
    person.relations.push(relation);
  }
  relation.trust = clamp(relation.trust + trustDelta);
  relation.bond = clamp(relation.bond + bondDelta);
  relation.fear = clamp(relation.fear + fearDelta);
  relation.sourceEventIds = [...new Set([...relation.sourceEventIds, eventId])].slice(-24);
}

const CANONICAL_RELATION_KEYS = new Set(['personId', 'trust', 'bond', 'fear', 'sourceEventIds']);

function hasExactCanonicalRelationKeys(relation: DirectedRelation): boolean {
  const keys = Object.keys(relation);
  return keys.length === CANONICAL_RELATION_KEYS.size
    && keys.every((key) => CANONICAL_RELATION_KEYS.has(key));
}

/**
 * Return the canonical sparse relation array without mutating persistent
 * state. A caller may supply additional known-kin ids (for example children);
 * genetic parents are retained automatically even if their current values are
 * zero. Founder, witnessed, and otherwise sourced edges are naturally kept.
 */
export function compactCanonicalRelations(
  person: Pick<PersonState, 'geneticParents' | 'relations'>,
  additionalKinPersonIds: Iterable<string> = [],
): DirectedRelation[] {
  const kinPersonIds = new Set([...person.geneticParents, ...additionalKinPersonIds]);
  const compacted: DirectedRelation[] = [];
  for (const relation of person.relations) {
    const redundantDefault = hasExactCanonicalRelationKeys(relation)
      && relation.trust === 0
      && relation.bond === 0
      && relation.fear === 0
      && relation.sourceEventIds.length === 0
      && !kinPersonIds.has(relation.personId);
    if (!redundantDefault) compacted.push({ ...relation, sourceEventIds: [...relation.sourceEventIds] });
  }
  return compacted;
}
