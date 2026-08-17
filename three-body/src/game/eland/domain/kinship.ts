import type { SimulationState } from './model';
import type { PersonState } from './person';

export const KINSHIP_RISK_KNOWLEDGE_ID = 'claim:close-kin-offspring-risk';

function ancestorDepths(state: SimulationState, person: PersonState): Map<string, number> {
  const depths = new Map<string, number>();
  const pending = person.geneticParents.map((parentId) => ({ personId: parentId, depth: 1 }));
  while (pending.length) {
    const current = pending.shift();
    if (!current || (depths.get(current.personId) ?? Number.POSITIVE_INFINITY) <= current.depth) continue;
    depths.set(current.personId, current.depth);
    const parent = state.people.find((candidate) => candidate.id === current.personId);
    if (parent) pending.push(...parent.geneticParents.map((personId) => ({ personId, depth: current.depth + 1 })));
  }
  return depths;
}

/** Biological relatedness is a risk input, never an action prohibition. */
export function geneticKinshipRisk(state: SimulationState, first: PersonState, second: PersonState): number {
  if (first.id === second.id) return 1;
  const firstAncestors = ancestorDepths(state, first);
  const secondAncestors = ancestorDepths(state, second);
  const directDepth = firstAncestors.get(second.id) ?? secondAncestors.get(first.id);
  if (directDepth !== undefined) return directDepth === 1 ? 1 : directDepth === 2 ? 0.72 : 0.5;

  let nearestSharedDepth = Number.POSITIVE_INFINITY;
  for (const [ancestorId, firstDepth] of firstAncestors) {
    const secondDepth = secondAncestors.get(ancestorId);
    if (secondDepth !== undefined) nearestSharedDepth = Math.min(nearestSharedDepth, firstDepth + secondDepth);
  }
  if (nearestSharedDepth === 2) return 0.9;
  if (nearestSharedDepth === 3) return 0.62;
  if (nearestSharedDepth === 4) return 0.36;
  if (Number.isFinite(nearestSharedDepth)) return 0.2;
  return 0;
}

export function inheritedGeneticLoad(state: SimulationState, mother: PersonState, father?: PersonState): number {
  const parentalLoad = father
    ? ((mother.geneticLoad ?? 0) + (father.geneticLoad ?? 0)) / 2
    : mother.geneticLoad ?? 0;
  const relationshipRisk = father ? geneticKinshipRisk(state, mother, father) : 0;
  return Math.max(0, Math.min(1, parentalLoad * 0.5 + relationshipRisk * 0.55));
}

export function hasLearnedKinshipRisk(person: PersonState): boolean {
  return person.knowledge.some((fact) => fact.id === KINSHIP_RISK_KNOWLEDGE_ID && fact.confidence >= 55);
}
