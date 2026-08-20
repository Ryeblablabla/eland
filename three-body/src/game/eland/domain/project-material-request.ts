import type { ActionFact, SimulationState } from './model';
import { worldEventById } from './event-index';
import { inventoryQuantity, isAlive } from './person';
import type {
  ProjectMaterialContributionRequestBasis,
  ProjectMaterialDemand,
  ProjectState,
} from './project';

export type ProjectMaterialContributionRequestStatus =
  | 'open'
  | 'fulfilled'
  | 'expired'
  | 'contributors-unavailable';

export interface ProjectMaterialContributionRequestView {
  status: ProjectMaterialContributionRequestStatus;
  contributedQuantity: number;
  requestRemainingQuantity: number;
  outstandingQuantity: number;
  deliverableQuantity: number;
  availableContributorIds: string[];
}

/**
 * New project deliveries bind to one request through `authorizationRef`.
 * Historical saves predate that binding, so an unreferenced transfer remains
 * compatible when it came from an addressed contributor inside the request's
 * own validity window.
 */
export function transferMatchesProjectMaterialRequest(
  request: ProjectMaterialContributionRequestBasis,
  event: ActionFact,
): boolean {
  if (event.status !== 'completed'
    || event.atMonth < request.atMonth
    || event.atMonth > request.expiresAtMonth
    || !request.contributorIds.includes(event.who)
    || event.action.kind !== 'transfer'
    || event.action.materialId !== request.materialId
    || event.action.from.kind !== 'person'
    || event.action.from.personId !== event.who) return false;
  return !event.action.authorizationRef || event.action.authorizationRef === request.requestEventId;
}

export function contributedQuantityForProjectMaterialRequest(
  state: SimulationState,
  project: ProjectState,
  request: ProjectMaterialContributionRequestBasis,
): number {
  const historicalQuantity = project.actionEventIds.reduce((sum, eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action' && transferMatchesProjectMaterialRequest(request, event)
      ? sum + Math.max(0, Number(event.diff.quantity ?? 0))
      : sum;
  }, 0);
  return Math.min(
    request.requestedQuantity,
    Math.max(0, request.contributedQuantity ?? 0, historicalQuantity),
  );
}

/**
 * Request status is derived from current branch facts rather than persisted as
 * a second state machine. Only a still-useful request with a living, equipped
 * addressee remains open and suppresses a renewal.
 */
export function inspectProjectMaterialContributionRequest(
  state: SimulationState,
  project: ProjectState,
  request: ProjectMaterialContributionRequestBasis,
  atMonth: number,
  demand: ProjectMaterialDemand | undefined,
): ProjectMaterialContributionRequestView {
  const owner = state.people.find((person) => person.id === project.ownerId);
  const outstandingQuantity = demand?.materialId === request.materialId && owner
    ? Math.max(0, demand.requiredQuantity - inventoryQuantity(owner, request.materialId))
    : 0;
  const contributedQuantity = contributedQuantityForProjectMaterialRequest(state, project, request);
  const requestRemainingQuantity = Math.max(0, request.requestedQuantity - contributedQuantity);
  const availableContributorIds = request.contributorIds.filter((personId) => {
    const contributor = state.people.find((person) => person.id === personId);
    return Boolean(contributor
      && isAlive(contributor)
      && inventoryQuantity(contributor, request.materialId) > 0);
  });
  const deliverableQuantity = Math.min(requestRemainingQuantity, outstandingQuantity);
  const status: ProjectMaterialContributionRequestStatus = outstandingQuantity <= 0 || requestRemainingQuantity <= 0
    ? 'fulfilled'
    : request.expiresAtMonth < atMonth
      ? 'expired'
      : availableContributorIds.length === 0
        ? 'contributors-unavailable'
        : 'open';
  return {
    status,
    contributedQuantity,
    requestRemainingQuantity,
    outstandingQuantity,
    deliverableQuantity,
    availableContributorIds,
  };
}
