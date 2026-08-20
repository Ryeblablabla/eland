import { geneticKinshipRisk, kinshipRiskAwareness, kinshipRiskKnowledge } from '../domain/kinship';
import type { SimulationState } from '../domain/model';
import type { PersonState } from '../domain/person';

/**
 * Full-confidence close-kin avoidance stays comparable to ordinary relationship
 * motives instead of acting as a hidden prohibition.
 */
export const MAX_PERCEIVED_KINSHIP_RISK_COST = 36;

export interface PerceivedKinshipRisk {
  biologicalRisk: number;
  knowledgeConfidence: number;
  awareness: number;
  cost: number;
  sourceFactIds: string[];
}

export function perceivedKinshipRisk(
  state: SimulationState,
  person: PersonState,
  other: PersonState,
): PerceivedKinshipRisk {
  const knowledge = kinshipRiskKnowledge(person);
  const awareness = kinshipRiskAwareness(person);
  const biologicalRisk = geneticKinshipRisk(state, person, other);
  return {
    biologicalRisk,
    knowledgeConfidence: knowledge?.confidence ?? 0,
    awareness,
    cost: biologicalRisk * awareness * MAX_PERCEIVED_KINSHIP_RISK_COST,
    sourceFactIds: knowledge?.sourceEventIds ?? [],
  };
}
