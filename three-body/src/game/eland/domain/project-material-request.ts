import type { ActionFact, DecisionAuthorityState, DropState, SimulationState } from './model';
import { worldEventById } from './event-index';
import { materialDefinition, type MaterialId } from './material';
import { isAlive, isDormantDehydratedHibernating, type PersonState } from './person';
import { remember } from './memory';
import { permissionAuthorizesTransfer, permissionById } from './permission';
import { positionsCanTouch } from './social-space';
import { languageInterpreterIds } from './language-perception';
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
  state: DecisionAuthorityState,
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
  const interpreters = languageInterpreterIds(event.diff, event.action.speakerMeaning.id);
  const payload = event.action.speakerMeaning.projectMaterialContribution;
  return Boolean(payload
    && request.version === 'project-material-contribution-request-v1'
    && request.projectId === project.id
    && projectEventHasEventTimeLead(project, event)
    && project.actionEventIds.includes(request.requestEventId)
    && request.contributorIds.length > 0
    && new Set(request.contributorIds).size === request.contributorIds.length
    && request.contributorIds.every((personId) => interpreters.includes(personId))
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
  state: DecisionAuthorityState,
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

/** A delivery records the contributor's destination commitment, not a physical lock. */
export interface ProjectMaterialDeliveryUse {
  version: 'project-material-delivery-use-v1';
  operation: 'take' | 'consume' | 'relocate';
  sourceDropId: string;
  sourcePosition: { cellId: number; z: number };
  materialId: MaterialId;
  quantity: number;
  delivery: NonNullable<DropState['projectMaterialDelivery']>;
  active: boolean;
  authorized: boolean;
  authorizationRef?: string;
  sourceEventIds: string[];
  witnessedBy: string[];
  requestKnownBy: string[];
}

function personKnowsProjectDeliveryRequest(
  state: DecisionAuthorityState,
  observer: PersonState,
  delivery: NonNullable<DropState['projectMaterialDelivery']>,
): boolean {
  if (observer.id === delivery.requesterId) return true;
  const request = worldEventById(state, delivery.requestEventId);
  return Boolean(request?.kind === 'action' && request.action.kind === 'talk'
    && languageInterpreterIds(request.diff, request.action.speakerMeaning.id).includes(observer.id))
    || observer.memories.some((memory) => memory.sourceEventIds.includes(delivery.requestEventId))
    || observer.knowledge.some((fact) => fact.sourceEventIds.includes(delivery.requestEventId));
}

/** Caller supplies a currently observed drop; hidden commitments stay hidden. */
export function perceivedProjectMaterialDelivery(
  state: DecisionAuthorityState,
  observer: PersonState,
  drop: DropState,
  atMonth: number,
): { project: string; requester: string; active: boolean; requestEventId: string } | undefined {
  const delivery = drop.projectMaterialDelivery;
  if (!delivery || !personKnowsProjectDeliveryRequest(state, observer, delivery)) return undefined;
  return {
    project: state.projects.find((project) => project.id === delivery.projectId)?.summary ?? delivery.projectId,
    requester: state.people.find((person) => person.id === delivery.requesterId)?.name ?? delivery.requesterId,
    active: Boolean(activeProjectMaterialDeliveryRequest(state, drop, atMonth)),
    requestEventId: delivery.requestEventId,
  };
}

/** Capture before mutation; the receipt is published only after physical execution succeeds. */
export function captureProjectMaterialDeliveryUse(
  state: SimulationState,
  actor: PersonState,
  drop: DropState,
  use: { operation: ProjectMaterialDeliveryUse['operation']; quantity: number; atMonth: number; authorizationRef?: string },
): ProjectMaterialDeliveryUse | undefined {
  const delivery = drop.projectMaterialDelivery;
  if (!delivery) return undefined;
  const active = Boolean(activeProjectMaterialDeliveryRequest(state, drop, use.atMonth));
  const permission = use.authorizationRef ? permissionById(state, use.authorizationRef) : undefined;
  const permissionAuthorized = permission?.grantorId === delivery.requesterId && permissionAuthorizesTransfer(
    permission, actor.id, {
      kind: 'transfer', materialId: drop.materialId, quantity: use.quantity,
      from: { kind: 'person', personId: delivery.requesterId }, to: { kind: 'person', personId: actor.id },
    }, use.atMonth,
  );
  const sourcePosition = { cellId: drop.cellId, z: drop.z };
  const witnesses = state.people.filter((observer) => isAlive(observer)
    && !isDormantDehydratedHibernating(observer)
    && observer.baselineCapacities.perception > 0
    && (observer.id === actor.id
      || positionsCanTouch(state.world.grid, observer.position, actor.position)
        && positionsCanTouch(state.world.grid, observer.position, sourcePosition)));
  return {
    version: 'project-material-delivery-use-v1', operation: use.operation,
    sourceDropId: drop.id, sourcePosition, materialId: drop.materialId, quantity: use.quantity,
    delivery: { ...delivery }, active,
    authorized: !active || actor.id === delivery.requesterId || Boolean(permissionAuthorized),
    ...(permissionAuthorized ? { authorizationRef: use.authorizationRef } : {}),
    sourceEventIds: [...new Set([...drop.sourceEventIds, delivery.requestEventId])],
    witnessedBy: witnesses.map((observer) => observer.id),
    requestKnownBy: witnesses.filter((observer) => personKnowsProjectDeliveryRequest(state, observer, delivery))
      .map((observer) => observer.id),
  };
}

/** An observed event supplies experience. It never assigns blame, motives or a response. */
export function recordProjectMaterialDeliveryUses(state: SimulationState, fact: ActionFact): void {
  // Only committed native/effect receipts are read. An experiment may fail
  // after actually consuming material; its physical use is still witnessed.
  const candidates = [
    ...(Array.isArray(fact.diff.projectMaterialDeliveryUses) ? fact.diff.projectMaterialDeliveryUses : []),
    ...(Array.isArray(fact.diff.appliedEffects) ? fact.diff.appliedEffects.flatMap((effect) => (
      effect && typeof effect === 'object' && Array.isArray(effect.projectMaterialDeliveryUses)
        ? effect.projectMaterialDeliveryUses : []
    )) : []),
  ] as ProjectMaterialDeliveryUse[];
  const uses = [...new Map(candidates.map((use) => [`${use.sourceDropId}:${use.operation}`, use])).values()];
  const actor = state.people.find((person) => person.id === fact.who);
  if (!actor) return;
  for (const use of uses) {
    if (use.version !== 'project-material-delivery-use-v1') continue;
    const verb = use.operation === 'consume' ? '消耗' : use.operation === 'relocate' ? '搬移' : '取用';
    for (const observerId of use.witnessedBy) {
      const observer = state.people.find((person) => person.id === observerId);
      if (!observer) continue;
      const knowsRequest = use.requestKnownBy.includes(observer.id);
      const requester = state.people.find((person) => person.id === use.delivery.requesterId);
      const project = state.projects.find((candidate) => candidate.id === use.delivery.projectId);
      const commitment = knowsRequest
        ? `；这些材料原本是应${requester?.name ?? '请求者'}的请求为“${project?.summary ?? '项目'}”交付的${use.active ? '' : '，该请求当前已不再有效'}`
        : '';
      remember(observer, {
        id: `memory:project-material-use:${fact.id}:${use.sourceDropId}:${use.operation}:${observer.id}`,
        kind: 'episode',
        summary: `${observer.id === actor.id ? '自己实际' : `亲眼看见${actor.name}`}${verb}了${use.quantity}份${materialDefinition(use.materialId).name}${commitment}`,
        importance: 38, createdAtMonth: fact.atMonth, lastRecalledAtMonth: fact.atMonth,
        personIds: [...new Set([actor.id, ...(knowsRequest ? [use.delivery.requesterId] : [])])].filter((id) => id !== observer.id),
        sourceEventIds: [fact.id, ...(knowsRequest ? [use.delivery.requestEventId] : [])],
      });
    }
  }
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
