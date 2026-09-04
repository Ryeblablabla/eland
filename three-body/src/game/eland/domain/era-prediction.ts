import type { DecisionAuthorityState, EraPrediction } from './model';
import type { PersonState } from './person';
import { relationTo } from './relation';

export const MAX_ERA_PREDICTION_HORIZON_MONTHS = 6;

export function personTrustsEraPrediction(
  state: Pick<DecisionAuthorityState, 'eraPredictions'>,
  person: PersonState,
  prediction: EraPrediction,
): boolean {
  if (prediction.predictorId === person.id) return true;
  if (!prediction.perceivedByPersonIds.includes(person.id)) return false;
  const resolved = state.eraPredictions.filter((candidate) => (
    candidate.predictorId === prediction.predictorId
      && candidate.status !== 'pending'
  ));
  const correct = resolved.filter((candidate) => candidate.status === 'correct').length;
  const trust = relationTo(person, prediction.predictorId)?.trust ?? 0;
  return trust >= 22 || (resolved.length >= 2 && correct / resolved.length >= 0.6 && trust >= 8);
}

export function isActionableChaosPrediction(prediction: EraPrediction, atMonth: number): boolean {
  return prediction.status === 'pending'
    && prediction.targetEpoch === 'chaotic'
    && prediction.predictedStartMonth - atMonth <= 5
    && prediction.predictedStartMonth + prediction.toleranceMonths >= atMonth;
}
