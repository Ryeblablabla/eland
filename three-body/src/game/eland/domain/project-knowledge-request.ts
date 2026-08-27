import { pendingMechanicalPowerComponentMaterialId } from './mechanical-power';
import type { SimulationState } from './model';
import { worldEventById } from './event-index';
import { isAlive, type PersonState } from './person';
import {
  firstUnknownPersonKnownProcessOutput,
  resolvePersonKnownProcess,
} from './person-known-process';
import type { ProjectKnowledgeRequestBasis, ProjectState } from './project';
import {
  projectCurrentLeadId,
  projectEventHasEventTimeLead,
} from './project-leadership';
import { techniqueOutputMaterialId } from './technique-demonstration';
import {
  isCompletedPersonalProductionLaborEvent,
  isProductionToolMaterial,
  productionToolRank,
} from './production-tool';

export type ProjectKnowledgeRequestStatus = 'open' | 'answered' | 'expired' | 'obsolete';

interface ProjectKnowledgeRequestCandidate {
  project: ProjectState;
  request: ProjectKnowledgeRequestBasis;
  projectOrder: number;
  requestOrder: number;
}

interface ProjectKnowledgeRequestListenerIndex {
  projectsLength: number;
  tailProject: ProjectState | undefined;
  projectOrders: Map<ProjectState, number>;
  indexedRequests: WeakSet<ProjectKnowledgeRequestBasis>;
  candidatesByListenerId: Map<string, ProjectKnowledgeRequestCandidate[]>;
}

/**
 * Listener membership is immutable request evidence, while request lifecycle
 * state is not. Keying by the projects array keeps imported/replaced states
 * isolated without putting derived lookup data into authoritative state.
 */
const projectKnowledgeRequestListenerIndexes = new WeakMap<
  ProjectState[],
  ProjectKnowledgeRequestListenerIndex
>();

function buildProjectKnowledgeRequestListenerIndex(
  projects: ProjectState[],
): ProjectKnowledgeRequestListenerIndex {
  const index: ProjectKnowledgeRequestListenerIndex = {
    projectsLength: projects.length,
    tailProject: projects.at(-1),
    projectOrders: new Map(),
    indexedRequests: new WeakSet(),
    candidatesByListenerId: new Map(),
  };
  projects.forEach((project, projectOrder) => {
    index.projectOrders.set(project, projectOrder);
    (project.knowledgeRequests ?? []).forEach((request, requestOrder) => {
      index.indexedRequests.add(request);
      for (const listenerId of new Set(request.listenerIds)) {
        const candidates = index.candidatesByListenerId.get(listenerId) ?? [];
        candidates.push({ project, request, projectOrder, requestOrder });
        index.candidatesByListenerId.set(listenerId, candidates);
      }
    });
  });
  return index;
}

function projectKnowledgeRequestListenerIndex(
  state: SimulationState,
): ProjectKnowledgeRequestListenerIndex {
  const projects = state.projects;
  const existing = projectKnowledgeRequestListenerIndexes.get(projects);
  if (existing
    && existing.projectsLength === projects.length
    && existing.tailProject === projects.at(-1)) return existing;
  const rebuilt = buildProjectKnowledgeRequestListenerIndex(projects);
  projectKnowledgeRequestListenerIndexes.set(projects, rebuilt);
  return rebuilt;
}

/**
 * A completed request is pushed during a planning month after this index may
 * already have been read. Register that immutable listener membership at the
 * same authoritative write site so later ticks in the month can answer it.
 */
export function registerProjectKnowledgeRequestListeners(
  state: SimulationState,
  project: ProjectState,
  request: ProjectKnowledgeRequestBasis,
): void {
  const projects = state.projects;
  const existing = projectKnowledgeRequestListenerIndexes.get(projects);
  if (!existing) return;
  if (existing.projectsLength !== projects.length || existing.tailProject !== projects.at(-1)) {
    projectKnowledgeRequestListenerIndexes.set(
      projects,
      buildProjectKnowledgeRequestListenerIndex(projects),
    );
    return;
  }
  const projectOrder = existing.projectOrders.get(project);
  if (projectOrder === undefined || existing.indexedRequests.has(request)) return;
  const requestOrder = project.knowledgeRequests?.indexOf(request) ?? -1;
  if (requestOrder < 0) return;
  existing.indexedRequests.add(request);
  for (const listenerId of new Set(request.listenerIds)) {
    const candidates = existing.candidatesByListenerId.get(listenerId) ?? [];
    const insertionIndex = candidates.findIndex((candidate) => (
      candidate.projectOrder > projectOrder
      || (candidate.projectOrder === projectOrder && candidate.requestOrder > requestOrder)
    ));
    const candidate = { project, request, projectOrder, requestOrder };
    if (insertionIndex < 0) candidates.push(candidate);
    else candidates.splice(insertionIndex, 0, candidate);
    existing.candidatesByListenerId.set(listenerId, candidates);
  }
}

function samePersonIds(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((personId, index) => personId === normalizedRight[index]);
}

/**
 * Stored request bases are projections of completed communication facts. Keep
 * lifecycle waits tied to that source action so imported or stale array data
 * cannot keep a project active by itself.
 */
export function projectKnowledgeRequestHasAuthoritativeSource(
  state: SimulationState,
  project: ProjectState,
  request: ProjectKnowledgeRequestBasis,
): boolean {
  const event = worldEventById(state, request.requestEventId);
  if (!event
    || event.kind !== 'action'
    || event.status !== 'completed'
    || event.who !== request.requesterId
    || event.atMonth !== request.atMonth
    || event.action.kind !== 'communicate'
    || event.action.content.kind !== 'request') return false;
  const payload = event.action.content.projectKnowledgeRequest;
  return Boolean(payload
    && request.version === 'project-knowledge-request-v1'
    && request.projectId === project.id
    && projectEventHasEventTimeLead(project, event)
    && project.actionEventIds.includes(request.requestEventId)
    && request.listenerIds.length > 0
    && samePersonIds(request.listenerIds, event.action.audience)
    && payload.version === request.version
    && payload.projectId === request.projectId
    && payload.requesterId === request.requesterId
    && payload.outputMaterialId === request.outputMaterialId
    && payload.expiresAtMonth === request.expiresAtMonth);
}

export function personReliablyKnowsOutput(person: PersonState, outputMaterialId: number): boolean {
  return person.knowledge.some((fact) => fact.kind === 'technique'
    && fact.confidence >= 55
    && techniqueOutputMaterialId(fact.id) === outputMaterialId);
}

export function pendingProjectKnowledgeGap(
  state: SimulationState,
  project: ProjectState,
): { outputMaterialId: number; sourceFactIds: string[]; techniquePath: string[] } | undefined {
  const replication = project.capabilityReplicationBasis;
  if (replication) {
    const requester = state.people.find((person) => person.id === project.ownerId && isAlive(person));
    const labor = worldEventById(state, replication.recentLaborEventId);
    const structurallyValid = project.status === 'active'
      && project.need === 'production-efficiency'
      && project.desiredFunction === 'efficient-production'
      && projectCurrentLeadId(project) === project.ownerId
      && replication.version === 'project-capability-replication-basis-v1'
      && replication.kind === 'production-tool'
      && replication.observerId === project.ownerId
      && project.productionToolBaselineRank === replication.baselineToolRank
      && isProductionToolMaterial(replication.outputMaterialId)
      && replication.targetToolRank === productionToolRank(replication.outputMaterialId)
      && replication.targetToolRank > replication.baselineToolRank
      && replication.sourceFactIds.length === 1
      && replication.sourceFactIds[0] === replication.recentLaborEventId
      && project.triggerFactIds.includes(replication.recentLaborEventId)
      && Boolean(labor
        && requester
        && isCompletedPersonalProductionLaborEvent(labor, requester.id)
        && labor.atMonth <= replication.atMonth
        && labor.atMonth >= replication.atMonth - 12);
    if (!structurallyValid || !requester || personReliablyKnowsOutput(requester, replication.outputMaterialId)) {
      return undefined;
    }
    return {
      outputMaterialId: replication.outputMaterialId,
      sourceFactIds: [...replication.sourceFactIds],
      techniquePath: [],
    };
  }
  // Reliability inquiries ask collaborators about no privileged output. Their
  // finite material trials begin from repeated personal faults and observable
  // entities; naming SteelDriveShaft here would disclose the answer before any
  // physical response exists.
  if (project.need === 'equipment-reliability'
    || project.desiredFunction === 'durable-power-transmission') return undefined;
  if (project.status !== 'active'
    || project.need !== 'mechanical-power-capability'
    || project.desiredFunction !== 'water-powered-crop-processing'
    || !project.mechanicalPowerPlan) return undefined;
  const currentLeadId = projectCurrentLeadId(project);
  const requester = state.people.find((person) => person.id === currentLeadId && isAlive(person));
  const componentOutput = pendingMechanicalPowerComponentMaterialId(
    state.world.mechanicalPower,
    project.mechanicalPowerPlan,
  );
  if (!requester || componentOutput === undefined) return undefined;
  const resolution = resolvePersonKnownProcess(
    state,
    requester,
    componentOutput,
    { ignoreRootInventory: true },
  );
  const unknown = firstUnknownPersonKnownProcessOutput(resolution);
  return unknown ? {
    outputMaterialId: unknown.materialId,
    sourceFactIds: [...new Set([
      ...resolution.sourceFactIds,
      ...unknown.sourceFactIds,
    ])],
    techniquePath: [...unknown.techniquePath],
  } : undefined;
}

export function pendingProjectKnowledgeOutput(
  state: SimulationState,
  project: ProjectState,
): number | undefined {
  return pendingProjectKnowledgeGap(state, project)?.outputMaterialId;
}

export function inspectProjectKnowledgeRequest(
  state: SimulationState,
  project: ProjectState,
  request: ProjectKnowledgeRequestBasis,
  atMonth: number,
): ProjectKnowledgeRequestStatus {
  if (request.responseEventId) return 'answered';
  if (request.expiresAtMonth < atMonth) return 'expired';
  const requester = state.people.find((person) => person.id === request.requesterId && isAlive(person));
  const pendingOutput = pendingProjectKnowledgeOutput(state, project);
  if (!requester
    || project.status !== 'active'
    || projectCurrentLeadId(project) !== request.requesterId
    || request.projectId !== project.id
    || !projectKnowledgeRequestHasAuthoritativeSource(state, project, request)
    || pendingOutput !== request.outputMaterialId
    || personReliablyKnowsOutput(requester, request.outputMaterialId)) return 'obsolete';
  return 'open';
}

export function openProjectKnowledgeRequestsFor(
  state: SimulationState,
  teacher: PersonState,
  atMonth: number,
): { project: ProjectState; request: ProjectKnowledgeRequestBasis; requester: PersonState }[] {
  const candidates = projectKnowledgeRequestListenerIndex(state).candidatesByListenerId.get(teacher.id) ?? [];
  return candidates.flatMap(({ project, request }) => {
    if (inspectProjectKnowledgeRequest(state, project, request, atMonth) !== 'open') return [];
    const requester = state.people.find((person) => person.id === request.requesterId && isAlive(person));
    return requester ? [{ project, request, requester }] : [];
  }).sort((left, right) => left.request.atMonth - right.request.atMonth
    || left.request.requestEventId.localeCompare(right.request.requestEventId));
}
