import type { DirectedRelation, PersonState } from './person';

export const FOUNDER_INITIAL_RELATION = 55;
export const COMPANION_RELATION_THRESHOLD = 20;

export function relationshipPairKey(firstId: string, secondId: string): string {
  return [firstId, secondId].sort().join('|');
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function relationTo(person: PersonState, otherId: string): DirectedRelation | undefined {
  return person.relations.find((relation) => relation.personId === otherId);
}

/** Relation values are caches over witnessed events; every mutation carries evidence. */
export function applyRelationEvidence(
  person: PersonState,
  otherId: string,
  eventId: string,
  delta: Partial<Pick<DirectedRelation, 'trust' | 'bond' | 'fear'>>,
): void {
  const relation = relationTo(person, otherId);
  if (!relation) return;
  relation.trust = clamp(relation.trust + (delta.trust ?? 0));
  relation.bond = clamp(relation.bond + (delta.bond ?? 0));
  relation.fear = clamp(relation.fear + (delta.fear ?? 0));
  relation.sourceEventIds = [...new Set([...relation.sourceEventIds, eventId])].slice(-24);
}
