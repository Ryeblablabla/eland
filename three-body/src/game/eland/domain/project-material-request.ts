import type { ActionFact, SimulationState } from './model';
import { liveSocialEvidenceForPersonSource, worldEventById } from './event-index';
import type { MaterialId } from './material';
import { isAlive, type PersonState } from './person';
import type {
  ProjectMaterialContributionRequestBasis,
  ProjectMaterialDemand,
  ProjectState,
} from './project';
import {
  projectCurrentLeadId,
  projectEventHasEventTimeLead,
} from './project-leadership';

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

/** A material wait exists only when its stored basis projects a completed request action. */
export function projectMaterialContributionRequestHasAuthoritativeSource(
  state: SimulationState,
  project: ProjectState,
  request: ProjectMaterialContributionRequestBasis,
): boolean {
  const event = worldEventById(state, request.requestEventId);
  if (!event
    || event.kind !== 'action'
    || event.status !== 'completed'
    || event.who !== request.requesterId
    || event.atMonth !== request.atMonth
    || event.action.kind !== 'talk'
    || event.action.speakerMeaning.kind !== 'request') return false;
  const audience = ((event.diff.understoodByPersonIds as string[] | undefined) ?? []);
  const payload = event.action.speakerMeaning.projectMaterialContribution;
  return Boolean(payload
    && request.version === 'project-material-contribution-request-v1'
    && request.projectId === project.id
    && projectEventHasEventTimeLead(project, event)
    && project.actionEventIds.includes(request.requestEventId)
    && request.contributorIds.length > 0
    && new Set(request.contributorIds).size === request.contributorIds.length
    && request.contributorIds.every((personId) => audience.includes(personId))
    && payload.version === request.version
    && payload.projectId === request.projectId
    && payload.requesterId === request.requesterId
    && payload.materialId === request.materialId
    && payload.quantity === request.requestedQuantity
    && payload.site.cellId === request.site.cellId
    && payload.site.z === request.site.z
    && payload.expiresAtMonth === request.expiresAtMonth
    && project.site?.cellId === request.site.cellId
    && project.site.z === request.site.z);
}

export function activeProjectMaterialDeliveryRequest(
  state: SimulationState,
  drop: SimulationState['world']['drops'][number],
  atMonth: number,
): ProjectMaterialContributionRequestBasis | null {
  const delivery = drop.projectMaterialDelivery;
  if (!delivery || delivery.version !== 'project-material-delivery-v1' || delivery.expiresAtMonth < atMonth) return null;
  const project = state.projects.find((candidate) => candidate.id === delivery.projectId);
  if (!project
    || project.status !== 'active'
    || projectCurrentLeadId(project) !== delivery.requesterId) return null;
  const requester = state.people.find((person) => person.id === delivery.requesterId && isAlive(person));
  const request = project.materialContributionRequests?.find((candidate) => (
    candidate.requestEventId === delivery.requestEventId
    && candidate.requesterId === delivery.requesterId
    && candidate.materialId === drop.materialId
    && candidate.expiresAtMonth === delivery.expiresAtMonth
  ));
  const demand = project.materialDemands?.find((candidate) => candidate.materialId === drop.materialId);
  if (!request
    || !requester
    || !demand
    || !projectMaterialContributionRequestHasAuthoritativeSource(state, project, request)
    || consumableInventoryQuantity(requester, drop.materialId) >= demand.requiredQuantity) return null;
  return request;
}

export function canPersonCollectProjectMaterialDrop(
  state: SimulationState,
  personId: string,
  drop: SimulationState['world']['drops'][number],
  atMonth: number,
): boolean {
  const activeRequest = activeProjectMaterialDeliveryRequest(state, drop, atMonth);
  return !activeRequest || activeRequest.requesterId === personId;
}

/**
 * A restricted delivery remains ordinary visual evidence. Only the person who
 * actually attempted this exact drop/request and remembers the blocked fact
 * can treat it as a source that is not presently collectible. The predicate
 * stops applying as soon as the binding itself is no longer active.
 */
export function personRemembersProjectMaterialDeliveryRestriction(
  state: SimulationState,
  personId: string,
  drop: SimulationState['world']['drops'][number],
  atMonth: number,
): boolean {
  const delivery = drop.projectMaterialDelivery;
  const activeRequest = activeProjectMaterialDeliveryRequest(state, drop, atMonth);
  if (!delivery || !activeRequest || activeRequest.requesterId === personId) return false;
  const person = state.people.find((candidate) => candidate.id === personId);
  if (!person) return false;
  return person.memories.some((memory) => memory.kind === 'failure'
    && memory.sourceEventIds.some((eventId) => {
      const evidence = liveSocialEvidenceForPersonSource(state, person, eventId);
      const blocked = evidence?.action?.blockedDelivery;
      return Boolean(evidence?.action?.actorId === personId
        && blocked
        && blocked.dropId === drop.id
        && blocked.projectId === delivery.projectId
        && blocked.requestEventId === delivery.requestEventId);
    }));
}

/** First attempts remain natural; only personally learned failures cool down. */
export function canPersonPlanToCollectProjectMaterialDrop(
  state: SimulationState,
  personId: string,
  drop: SimulationState['world']['drops'][number],
  atMonth: number,
): boolean {
  return !personRemembersProjectMaterialDeliveryRestriction(state, personId, drop, atMonth);
}

/** Written carriers are preserved records, not blank project feedstock. */
function consumableInventoryQuantity(person: PersonState, materialId: MaterialId): number {
  return person.inventory.reduce((sum, stack) => (
    stack.materialId === materialId && !stack.recordPayloadId
      ? sum + Math.max(0, stack.quantity)
      : sum
  ), 0);
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
  const currentLeadId = projectCurrentLeadId(project);
  const currentLead = state.people.find((person) => person.id === currentLeadId && isAlive(person));
  const validCurrentRequest = currentLeadId === request.requesterId
    && projectMaterialContributionRequestHasAuthoritativeSource(state, project, request);
  const outstandingQuantity = demand?.materialId === request.materialId && currentLead
    ? Math.max(0, demand.requiredQuantity - consumableInventoryQuantity(currentLead, request.materialId))
    : 0;
  const contributedQuantity = contributedQuantityForProjectMaterialRequest(state, project, request);
  const requestRemainingQuantity = Math.max(0, request.requestedQuantity - contributedQuantity);
  const availableContributorIds = request.contributorIds.filter((personId) => {
    const contributor = state.people.find((person) => person.id === personId);
    return Boolean(contributor
      && isAlive(contributor)
      && consumableInventoryQuantity(contributor, request.materialId) > 0);
  });
  const deliverableQuantity = Math.min(requestRemainingQuantity, outstandingQuantity);
  const status: ProjectMaterialContributionRequestStatus = !validCurrentRequest
    ? 'expired'
    : outstandingQuantity <= 0 || requestRemainingQuantity <= 0
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
