import type { DecisionAuthorityState } from './model';
import type { PersonId } from './person';

type RelationshipOutcomeState = Pick<DecisionAuthorityState, 'agreements' | 'projects'>;
type AgreementState = DecisionAuthorityState['agreements'][number];
type ProjectState = DecisionAuthorityState['projects'][number];

interface OutcomeIndex<T> {
  byEventId: Map<string, T[]>;
}

const fulfilledAgreementIndexes = new WeakMap<
  DecisionAuthorityState['agreements'],
  OutcomeIndex<AgreementState>
>();
const completedProjectIndexes = new WeakMap<
  DecisionAuthorityState['projects'],
  OutcomeIndex<ProjectState>
>();

function appendOutcome<T>(index: OutcomeIndex<T>, eventId: string, outcome: T): void {
  if (!eventId) return;
  const outcomes = index.byEventId.get(eventId) ?? [];
  outcomes.push(outcome);
  index.byEventId.set(eventId, outcomes);
}

function fulfilledAgreementIndex(state: RelationshipOutcomeState): OutcomeIndex<AgreementState> {
  let index = fulfilledAgreementIndexes.get(state.agreements);
  if (index) return index;
  index = { byEventId: new Map() };
  for (const agreement of state.agreements) {
    if (agreement.status !== 'fulfilled') continue;
    for (const eventId of agreement.fulfillmentEventIds) appendOutcome(index, eventId, agreement);
  }
  fulfilledAgreementIndexes.set(state.agreements, index);
  return index;
}

function completedProjectIndex(state: RelationshipOutcomeState): OutcomeIndex<ProjectState> {
  let index = completedProjectIndexes.get(state.projects);
  if (index) return index;
  index = { byEventId: new Map() };
  for (const project of state.projects) {
    if (project.status !== 'completed') continue;
    for (const eventId of project.completionEventIds) appendOutcome(index, eventId, project);
  }
  completedProjectIndexes.set(state.projects, index);
  return index;
}

/** Mutable aggregate completion must invalidate the disposable exact-event sidecar. */
export function invalidateFulfilledAgreementRelationshipEvidence(
  state: RelationshipOutcomeState,
): void {
  fulfilledAgreementIndexes.delete(state.agreements);
}

/** Mutable aggregate completion must invalidate the disposable exact-event sidecar. */
export function invalidateCompletedProjectRelationshipEvidence(
  state: RelationshipOutcomeState,
): void {
  completedProjectIndexes.delete(state.projects);
}

function exactPair(partyIds: readonly PersonId[], firstId: PersonId, secondId: PersonId): boolean {
  return firstId !== secondId && partyIds.includes(firstId) && partyIds.includes(secondId);
}

/**
 * The action body may only say "attend", "transfer", or "reproduce". The
 * agreement aggregate is the replayable fact that proves this exact action
 * closed an accepted obligation for these exact parties.
 */
export function fulfilledAgreementRelationshipEvidence(
  state: RelationshipOutcomeState,
  eventId: string,
  firstId: PersonId,
  secondId: PersonId,
): boolean {
  return (fulfilledAgreementIndex(state).byEventId.get(eventId) ?? []).some((agreement) => (
    agreement.status === 'fulfilled'
    && agreement.fulfillmentEventIds.includes(eventId)
    && exactPair(agreement.partyIds, firstId, secondId)
  ));
}

/**
 * A project's final primitive action names one actor, while the completed
 * aggregate preserves every real contributor. Both the exact completion
 * membership and both contributors are required; merely sharing a project id
 * or appearing in its beneficiary list is not relationship evidence.
 */
export function completedJointProjectRelationshipEvidence(
  state: RelationshipOutcomeState,
  eventId: string,
  firstId: PersonId,
  secondId: PersonId,
): boolean {
  return (completedProjectIndex(state).byEventId.get(eventId) ?? []).some((project) => (
    project.status === 'completed'
    && project.completionEventIds.includes(eventId)
    && exactPair(project.contributorIds, firstId, secondId)
  ));
}
