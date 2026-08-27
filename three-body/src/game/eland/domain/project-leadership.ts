import type { PrimitiveAction, VoxelPosition } from './action';
import { worldEventById } from './event-index';
import type { ActionFact, EnvironmentFact, SimulationState, WorldEvent } from './model';
import { remainsForPerson } from './mortuary';
import { isAlive, type PersonId, type PersonState } from './person';
import type { ProjectProgressEvidence, ProjectSite, ProjectState } from './project';
import { cellX, cellY } from '../world/grid';

export const PROJECT_LEADERSHIP_VERSION = 'project-leadership-v1' as const;
export const PROJECT_LEADERSHIP_VACANCY_MONTHS = 120;
export const PROJECT_LEADERSHIP_TRANSITION_LIMIT = 16;

interface ProjectLeadershipCoordinate {
  atMonth: number;
  orderInMonth: number;
  planningTick: number;
  orderInTick: number;
}

export interface ProjectLeadershipVacancyTransition extends ProjectLeadershipCoordinate {
  version: typeof PROJECT_LEADERSHIP_VERSION;
  id: string;
  kind: 'vacancy';
  projectId: string;
  predecessorId: PersonId;
  deathEventId: string;
  expiresAtMonth: number;
  sourceEventIds: [string];
}

export interface ProjectLeadershipSuccessionTransition extends ProjectLeadershipCoordinate {
  version: typeof PROJECT_LEADERSHIP_VERSION;
  id: string;
  kind: 'succession';
  projectId: string;
  predecessorId: PersonId;
  successorId: PersonId;
  vacancyTransitionId: string;
  deathEventId: string;
  contributionEventId: string;
  successionEventId: string;
  site: ProjectSite;
  sourceEventIds: [string, string, string];
}

export type ProjectLeadershipTransition =
  | ProjectLeadershipVacancyTransition
  | ProjectLeadershipSuccessionTransition;

/** Frozen local evidence carried by the one typed site inspection action. */
export interface ProjectLeadershipSuccessionActionBasis {
  version: typeof PROJECT_LEADERSHIP_VERSION;
  projectId: string;
  predecessorId: PersonId;
  successorId: PersonId;
  vacancyTransitionId: string;
  deathEventId: string;
  deathKnowledgeSourceEventIds: string[];
  contributionEventId: string;
  site: ProjectSite;
  sourceFactIds: string[];
}

export type ProjectLeadershipView =
  | { status: 'led'; currentLeadId: PersonId; latestSuccession?: ProjectLeadershipSuccessionTransition }
  | { status: 'vacant'; vacancy: ProjectLeadershipVacancyTransition }
  | { status: 'invalid'; reason: string };

function finiteInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function validCoordinate(value: ProjectLeadershipCoordinate): boolean {
  return finiteInteger(value.atMonth)
    && finiteInteger(value.orderInMonth)
    && finiteInteger(value.planningTick)
    && finiteInteger(value.orderInTick);
}

function transitionCoordinate(transition: ProjectLeadershipTransition): ProjectLeadershipCoordinate & { id: string } {
  return {
    atMonth: transition.atMonth,
    orderInMonth: transition.orderInMonth,
    planningTick: transition.planningTick,
    orderInTick: transition.orderInTick,
    id: transition.id,
  };
}

function eventCoordinate(event: WorldEvent): ProjectLeadershipCoordinate & { id: string } {
  return {
    atMonth: event.atMonth,
    orderInMonth: event.orderInMonth,
    planningTick: event.planningTick ?? 0,
    orderInTick: event.orderInTick ?? 0,
    id: event.id,
  };
}

function compareCoordinates(
  left: ProjectLeadershipCoordinate & { id: string },
  right: ProjectLeadershipCoordinate & { id: string },
): number {
  return left.atMonth - right.atMonth
    || left.orderInMonth - right.orderInMonth
    || left.planningTick - right.planningTick
    || left.orderInTick - right.orderInTick
    || left.id.localeCompare(right.id);
}

function sameSite(left: ProjectSite, right: ProjectSite): boolean {
  return left.cellId === right.cellId && left.z === right.z;
}

function uniqueStrings(values: readonly string[]): boolean {
  return values.every((value) => typeof value === 'string' && value.length > 0)
    && new Set(values).size === values.length;
}

/**
 * Old snapshots have no transitions and therefore remain founder-led. New
 * snapshots are deliberately strict: current leadership is never copied into
 * a mutable scalar and malformed append histories cannot grant authority.
 */
export function inspectProjectLeadership(project: ProjectState): ProjectLeadershipView {
  const transitions = project.leadershipTransitions;
  if (transitions === undefined || transitions.length === 0) {
    return { status: 'led', currentLeadId: project.ownerId };
  }
  if (!Array.isArray(transitions) || transitions.length > PROJECT_LEADERSHIP_TRANSITION_LIMIT) {
    return { status: 'invalid', reason: '项目负责人 transition 数量无效' };
  }
  let currentLeadId: PersonId | undefined = project.ownerId;
  let openVacancy: ProjectLeadershipVacancyTransition | undefined;
  let latestSuccession: ProjectLeadershipSuccessionTransition | undefined;
  let previousCoordinate: ReturnType<typeof transitionCoordinate> | undefined;
  const ids = new Set<string>();
  for (const transition of transitions) {
    const coordinate = transitionCoordinate(transition);
    if (transition.version !== PROJECT_LEADERSHIP_VERSION
      || transition.projectId !== project.id
      || !transition.id
      || ids.has(transition.id)
      || !validCoordinate(transition)
      || (previousCoordinate && compareCoordinates(coordinate, previousCoordinate) <= 0)) {
      return { status: 'invalid', reason: '项目负责人 transition 身份、顺序或坐标无效' };
    }
    ids.add(transition.id);
    previousCoordinate = coordinate;
    if (transition.kind === 'vacancy') {
      if (!currentLeadId
        || openVacancy
        || transition.predecessorId !== currentLeadId
        || transition.expiresAtMonth !== transition.atMonth + PROJECT_LEADERSHIP_VACANCY_MONTHS
        || transition.sourceEventIds.length !== 1
        || transition.sourceEventIds[0] !== transition.deathEventId
        || !uniqueStrings(transition.sourceEventIds)) {
        return { status: 'invalid', reason: '项目负责人 vacancy transition 无效' };
      }
      currentLeadId = undefined;
      openVacancy = transition;
      continue;
    }
    if (!project.site
      || !openVacancy
      || currentLeadId
      || transition.vacancyTransitionId !== openVacancy.id
      || transition.predecessorId !== openVacancy.predecessorId
      || transition.deathEventId !== openVacancy.deathEventId
      || transition.successorId === transition.predecessorId
      || transition.atMonth > openVacancy.expiresAtMonth
      || !sameSite(transition.site, project.site)
      || transition.sourceEventIds.length !== 3
      || transition.sourceEventIds[0] !== transition.deathEventId
      || transition.sourceEventIds[1] !== transition.contributionEventId
      || transition.sourceEventIds[2] !== transition.successionEventId
      || !uniqueStrings(transition.sourceEventIds)) {
      return { status: 'invalid', reason: '项目负责人 succession transition 无效' };
    }
    currentLeadId = transition.successorId;
    latestSuccession = transition;
    openVacancy = undefined;
  }
  return openVacancy
    ? { status: 'vacant', vacancy: openVacancy }
    : currentLeadId
      ? { status: 'led', currentLeadId, ...(latestSuccession ? { latestSuccession } : {}) }
      : { status: 'invalid', reason: '项目负责人 transition 没有可推导的终态' };
}

export function projectCurrentLeadId(project: ProjectState): PersonId | undefined {
  const view = inspectProjectLeadership(project);
  return view.status === 'led' ? view.currentLeadId : undefined;
}

export function projectIsLedBy(project: ProjectState, personId: PersonId): boolean {
  return projectCurrentLeadId(project) === personId;
}

export function projectLeadershipVacancy(project: ProjectState): ProjectLeadershipVacancyTransition | undefined {
  const view = inspectProjectLeadership(project);
  return view.status === 'vacant' ? view.vacancy : undefined;
}

export function projectLeadershipStartCoordinate(project: ProjectState): ProjectLeadershipCoordinate | undefined {
  const view = inspectProjectLeadership(project);
  if (view.status !== 'led' || !view.latestSuccession) return undefined;
  return transitionCoordinate(view.latestSuccession);
}

export function eventAfterCurrentLeadership(project: ProjectState, event: WorldEvent): boolean {
  const start = projectLeadershipStartCoordinate(project);
  return !start || compareCoordinates(eventCoordinate(event), { ...start, id: '' }) > 0;
}

/** First version deliberately excludes private-body, knowledge and personal inquiry projects. */
export function projectSupportsLeadershipSuccession(project: ProjectState): boolean {
  if (project.status !== 'active'
    || !project.site
    || project.kind === 'inquiry'
    || project.targetKnowledgeId
    || project.shelterRequirement
    || project.measurementUncertaintyBasis
    || project.remoteWorkPowerBasis
    || project.mechanicalReliabilityBasis
    || project.electricalPowerMaintenanceBasis) return false;
  return project.desiredFunction !== 'healing'
    && project.desiredFunction !== 'durable-record'
    && project.desiredFunction !== 'comparable-mass-measurement'
    && project.desiredFunction !== 'remote-work-power-delivery'
    && project.desiredFunction !== 'durable-power-transmission'
    && project.desiredFunction !== 'restore-water-powered-crop-processing'
    && project.desiredFunction !== 'restore-electrical-power-delivery';
}

function contributionMatches(
  state: SimulationState,
  project: ProjectState,
  personId: PersonId,
  evidence: ProjectProgressEvidence,
): ActionFact | null {
  if (evidence.actorId !== personId || !project.actionEventIds.includes(evidence.eventId)) return null;
  const event = worldEventById(state, evidence.eventId);
  return event?.kind === 'action'
    && event.who === personId
    && (event.status === 'completed' || event.status === 'progressed')
    && event.atMonth === evidence.atMonth
    ? event
    : null;
}

export function latestProjectLeadershipContribution(
  state: SimulationState,
  project: ProjectState,
  personId: PersonId,
): ActionFact | null {
  if (!project.contributorIds.includes(personId)) return null;
  return (project.progressEvidence ?? [])
    .flatMap((evidence) => {
      const event = contributionMatches(state, project, personId, evidence);
      return event ? [event] : [];
    })
    .sort((left, right) => compareCoordinates(eventCoordinate(left), eventCoordinate(right)))
    .at(-1) ?? null;
}

export function projectLeadershipDeathFact(
  state: SimulationState,
  personId: PersonId,
): EnvironmentFact | null {
  const remains = remainsForPerson(state, personId);
  const death = remains ? worldEventById(state, remains.deathEventId) : undefined;
  return death?.kind === 'environment'
    && death.change === 'death'
    && death.who === personId
    && death.diff.personId === personId
    ? death
    : null;
}

export function appendProjectLeadershipVacancy(
  project: ProjectState,
  death: EnvironmentFact,
): ProjectLeadershipVacancyTransition | null {
  const view = inspectProjectLeadership(project);
  if (view.status !== 'led'
    || view.currentLeadId !== death.who
    || death.change !== 'death'
    || death.diff.personId !== death.who
    || (project.leadershipTransitions?.length ?? 0) >= PROJECT_LEADERSHIP_TRANSITION_LIMIT) return null;
  const transition: ProjectLeadershipVacancyTransition = {
    version: PROJECT_LEADERSHIP_VERSION,
    id: `project-leadership-vacancy:${project.id}:${death.id}`,
    kind: 'vacancy',
    projectId: project.id,
    predecessorId: death.who,
    deathEventId: death.id,
    atMonth: death.atMonth,
    orderInMonth: death.orderInMonth,
    planningTick: death.planningTick ?? 0,
    orderInTick: death.orderInTick ?? 0,
    expiresAtMonth: death.atMonth + PROJECT_LEADERSHIP_VACANCY_MONTHS,
    sourceEventIds: [death.id],
  };
  project.leadershipTransitions ??= [];
  project.leadershipTransitions.push(transition);
  if (!project.triggerFactIds.includes(death.id)) project.triggerFactIds.push(death.id);
  return transition;
}

function exactDeathKnowledge(
  state: SimulationState,
  person: PersonState,
  predecessorId: PersonId,
  deathEventId: string,
): string[] | null {
  const remains = remainsForPerson(state, predecessorId);
  const bereavement = (person.bereavements ?? []).find((candidate) => (
    candidate.remainsId === remains?.id
      && candidate.deceasedPersonId === predecessorId
      && candidate.deathEventId === deathEventId
      && candidate.sourceEventIds.includes(deathEventId)
  ));
  const death = worldEventById(state, deathEventId);
  if (!bereavement
    || death?.kind !== 'environment'
    || death.change !== 'death'
    || death.who !== predecessorId
    || death.diff.personId !== predecessorId) return null;
  const otherSources = [...new Set(bereavement.sourceEventIds)]
    .filter((eventId) => eventId !== deathEventId)
    .slice(-21);
  return [deathEventId, ...otherSources];
}

export function buildProjectLeadershipSuccessionBasis(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  atMonth: number,
): ProjectLeadershipSuccessionActionBasis | null {
  const vacancy = projectLeadershipVacancy(project);
  if (!vacancy
    || atMonth < vacancy.atMonth
    || atMonth > vacancy.expiresAtMonth
    || !isAlive(person)
    || person.id === vacancy.predecessorId
    || !project.site) return null;
  const contribution = latestProjectLeadershipContribution(state, project, person.id);
  const deathKnowledgeSourceEventIds = exactDeathKnowledge(
    state, person, vacancy.predecessorId, vacancy.deathEventId,
  );
  if (!contribution || !deathKnowledgeSourceEventIds) return null;
  return {
    version: PROJECT_LEADERSHIP_VERSION,
    projectId: project.id,
    predecessorId: vacancy.predecessorId,
    successorId: person.id,
    vacancyTransitionId: vacancy.id,
    deathEventId: vacancy.deathEventId,
    deathKnowledgeSourceEventIds,
    contributionEventId: contribution.id,
    site: { ...project.site },
    sourceFactIds: [...new Set([
      vacancy.deathEventId,
      contribution.id,
      ...deathKnowledgeSourceEventIds,
    ])],
  };
}

export function projectLeadershipInspectionFactId(
  basis: ProjectLeadershipSuccessionActionBasis,
): string {
  return `observation:project-leadership:${basis.projectId}:${basis.vacancyTransitionId}:${basis.successorId}`;
}

export function projectLeadershipInspectionPosition(site: ProjectSite): VoxelPosition {
  return { x: cellX(site.cellId), y: cellY(site.cellId), z: Math.max(0, site.z - 1) };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function validateProjectLeadershipSuccessionAction(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'attend' }>,
  atMonth: number,
): { project: ProjectState; basis: ProjectLeadershipSuccessionActionBasis } | null {
  const basis = action.projectLeadershipSuccession;
  if (!basis || basis.version !== PROJECT_LEADERSHIP_VERSION) return null;
  const project = state.projects.find((candidate) => candidate.id === basis.projectId);
  const expected = project
    ? buildProjectLeadershipSuccessionBasis(state, person, project, atMonth)
    : null;
  const target = project?.site ? projectLeadershipInspectionPosition(project.site) : undefined;
  if (!project
    || !expected
    || basis.successorId !== person.id
    || person.position.cellId !== basis.site.cellId
    || person.position.z !== basis.site.z
    || action.target.kind !== 'voxel'
    || !target
    || action.target.position.x !== target.x
    || action.target.position.y !== target.y
    || action.target.position.z !== target.z
    || basis.predecessorId !== expected.predecessorId
    || basis.vacancyTransitionId !== expected.vacancyTransitionId
    || basis.deathEventId !== expected.deathEventId
    || basis.contributionEventId !== expected.contributionEventId
    || !sameSite(basis.site, expected.site)
    || !sameStrings(basis.deathKnowledgeSourceEventIds, expected.deathKnowledgeSourceEventIds)
    || !sameStrings(basis.sourceFactIds, expected.sourceFactIds)) return null;
  return { project, basis };
}

export function appendProjectLeadershipSuccession(
  project: ProjectState,
  fact: ActionFact,
): ProjectLeadershipSuccessionTransition | null {
  const basis = fact.action.kind === 'attend' ? fact.action.projectLeadershipSuccession : undefined;
  const vacancy = projectLeadershipVacancy(project);
  if (!basis
    || !vacancy
    || fact.status !== 'completed'
    || fact.who !== basis.successorId
    || fact.diff.projectLeadershipSuccession !== true
    || fact.diff.projectLeadershipProjectId !== project.id
    || fact.diff.projectLeadershipVacancyTransitionId !== vacancy.id
    || basis.projectId !== project.id
    || basis.vacancyTransitionId !== vacancy.id
    || basis.predecessorId !== vacancy.predecessorId
    || basis.deathEventId !== vacancy.deathEventId
    || compareCoordinates(eventCoordinate(fact), transitionCoordinate(vacancy)) <= 0
    || fact.atMonth > vacancy.expiresAtMonth
    || !project.site
    || !sameSite(basis.site, project.site)
    || (project.leadershipTransitions?.length ?? 0) >= PROJECT_LEADERSHIP_TRANSITION_LIMIT) return null;
  const transition: ProjectLeadershipSuccessionTransition = {
    version: PROJECT_LEADERSHIP_VERSION,
    id: `project-leadership-succession:${project.id}:${fact.id}`,
    kind: 'succession',
    projectId: project.id,
    predecessorId: basis.predecessorId,
    successorId: basis.successorId,
    vacancyTransitionId: basis.vacancyTransitionId,
    deathEventId: basis.deathEventId,
    contributionEventId: basis.contributionEventId,
    successionEventId: fact.id,
    site: { ...basis.site },
    atMonth: fact.atMonth,
    orderInMonth: fact.orderInMonth,
    planningTick: fact.planningTick ?? fact.actionTick,
    orderInTick: fact.orderInTick ?? 0,
    sourceEventIds: [basis.deathEventId, basis.contributionEventId, fact.id],
  };
  project.leadershipTransitions!.push(transition);
  project.lastProgressAtMonth = fact.atMonth;
  return transition;
}

export function projectLeadIdAtEvent(project: ProjectState, event: WorldEvent): PersonId | undefined {
  if (inspectProjectLeadership(project).status === 'invalid') return undefined;
  let leadId: PersonId | undefined = project.ownerId;
  const eventAt = eventCoordinate(event);
  for (const transition of project.leadershipTransitions ?? []) {
    if (compareCoordinates(transitionCoordinate(transition), eventAt) > 0) break;
    leadId = transition.kind === 'vacancy' ? undefined : transition.successorId;
  }
  return leadId;
}

export function projectEventHasEventTimeLead(project: ProjectState, event: ActionFact): boolean {
  return projectLeadIdAtEvent(project, event) === event.who;
}
