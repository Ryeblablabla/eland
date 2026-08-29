import type { DecisionAuthorityState, SimulationState } from './model';
import type { PersonState } from './person';
import { worldEventById } from './event-index';

function exposureMatchesClimate(
  climateKind: SimulationState['civilization']['climate']['kind'],
  exposureKind: 'cold' | 'heat',
): boolean {
  return exposureKind === 'cold'
    ? climateKind === 'cold'
    : climateKind === 'heat' || climateKind === 'fire';
}

/**
 * Resolve the person's current severe exposure back to authoritative facts.
 * Global climate alone is not an observed-entry basis, including when a
 * caregiver acts for a dependent.
 */
export function observedHibernationEntryEvidence(
  state: Pick<DecisionAuthorityState, 'civilization' | 'world'>,
  person: PersonState,
): string[] {
  if (state.civilization.epoch !== 'chaotic' || state.civilization.climate.severity < 4) return [];
  const evidenceEventIds = person.conditions
    .filter((condition): condition is typeof condition & { kind: 'cold' | 'heat' } => (
      (condition.kind === 'cold' || condition.kind === 'heat')
      && condition.stage >= 2
      && exposureMatchesClimate(state.civilization.climate.kind, condition.kind)
    ))
    .flatMap((condition) => condition.sourceEventIds.filter((eventId) => {
      const source = worldEventById(state, eventId);
      return source?.kind === 'environment'
        && source.change === 'condition'
        && source.who === person.id
        && source.diff.condition === condition.kind
        && Number(source.diff.stage) >= 2;
    }));
  return [...new Set(evidenceEventIds)];
}
