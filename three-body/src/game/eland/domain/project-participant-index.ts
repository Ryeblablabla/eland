import type { SimulationState } from './model';
import type { PersonId } from './person';
import type { ProjectState } from './project';

interface ProjectParticipantIndex {
  projectsLength: number;
  tailProject: ProjectState | undefined;
  projectOrders: Map<ProjectState, number>;
  projectsByFirstAndSecondId: Map<PersonId, Map<PersonId, ProjectState[]>>;
}

const projectParticipantIndexes = new WeakMap<ProjectState[], ProjectParticipantIndex>();

function orderedPair(firstId: PersonId, secondId: PersonId): [PersonId, PersonId] {
  return firstId <= secondId ? [firstId, secondId] : [secondId, firstId];
}

function projectsForPair(
  index: ProjectParticipantIndex,
  firstId: PersonId,
  secondId: PersonId,
): ProjectState[] | undefined {
  const [orderedFirstId, orderedSecondId] = orderedPair(firstId, secondId);
  return index.projectsByFirstAndSecondId.get(orderedFirstId)?.get(orderedSecondId);
}

function insertProjectForPair(
  index: ProjectParticipantIndex,
  project: ProjectState,
  firstId: PersonId,
  secondId: PersonId,
): void {
  const [orderedFirstId, orderedSecondId] = orderedPair(firstId, secondId);
  let bySecondId = index.projectsByFirstAndSecondId.get(orderedFirstId);
  if (!bySecondId) {
    bySecondId = new Map();
    index.projectsByFirstAndSecondId.set(orderedFirstId, bySecondId);
  }
  const projects = bySecondId.get(orderedSecondId) ?? [];
  if (projects.includes(project)) return;
  const projectOrder = index.projectOrders.get(project);
  if (projectOrder === undefined) return;
  const insertionIndex = projects.findIndex((candidate) => (
    (index.projectOrders.get(candidate) ?? Number.POSITIVE_INFINITY) > projectOrder
  ));
  if (insertionIndex < 0) projects.push(project);
  else projects.splice(insertionIndex, 0, project);
  bySecondId.set(orderedSecondId, projects);
}

function registerAllParticipantPairs(
  index: ProjectParticipantIndex,
  project: ProjectState,
  participantIds: PersonId[],
): void {
  for (let firstIndex = 0; firstIndex < participantIds.length; firstIndex += 1) {
    for (let secondIndex = firstIndex; secondIndex < participantIds.length; secondIndex += 1) {
      insertProjectForPair(
        index,
        project,
        participantIds[firstIndex]!,
        participantIds[secondIndex]!,
      );
    }
  }
}

function buildProjectParticipantIndex(projects: ProjectState[]): ProjectParticipantIndex {
  const index: ProjectParticipantIndex = {
    projectsLength: projects.length,
    tailProject: projects.at(-1),
    projectOrders: new Map(),
    projectsByFirstAndSecondId: new Map(),
  };
  projects.forEach((project, projectOrder) => {
    index.projectOrders.set(project, projectOrder);
    const participantIds = [...new Set([project.ownerId, ...project.contributorIds])];
    registerAllParticipantPairs(index, project, participantIds);
  });
  return index;
}

function projectParticipantIndex(state: SimulationState): ProjectParticipantIndex {
  const projects = state.projects;
  const existing = projectParticipantIndexes.get(projects);
  if (existing
    && existing.projectsLength === projects.length
    && existing.tailProject === projects.at(-1)) return existing;
  const rebuilt = buildProjectParticipantIndex(projects);
  projectParticipantIndexes.set(projects, rebuilt);
  return rebuilt;
}

/**
 * Project membership is indexed, while all mutable eligibility is checked at
 * query time. Candidate arrays retain authoritative project insertion order;
 * walking them backwards preserves the former reverse().find first match.
 */
export function latestSharedProjectBetween(
  state: SimulationState,
  firstPersonId: PersonId,
  secondPersonId: PersonId,
): ProjectState | undefined {
  const index = projectParticipantIndex(state);
  const candidates = projectsForPair(index, firstPersonId, secondPersonId) ?? [];
  for (let candidateIndex = candidates.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
    const project = candidates[candidateIndex]!;
    const projectOrder = index.projectOrders.get(project);
    if (projectOrder === undefined || state.projects[projectOrder] !== project) continue;
    const participantIds = new Set([project.ownerId, ...project.contributorIds]);
    if (!participantIds.has(firstPersonId) || !participantIds.has(secondPersonId)) continue;
    if (project.completionEventIds.length + project.actionEventIds.length > 0) return project;
  }
  return undefined;
}

/** Register same-month project/contributor membership after its authoritative push. */
export function registerProjectParticipantMembership(
  state: SimulationState,
  project: ProjectState,
): void {
  const projects = state.projects;
  const existing = projectParticipantIndexes.get(projects);
  if (!existing) return;
  if (existing.projectsLength !== projects.length || existing.tailProject !== projects.at(-1)) {
    projectParticipantIndexes.set(projects, buildProjectParticipantIndex(projects));
    return;
  }
  if (!existing.projectOrders.has(project)) return;
  const participantIds = [...new Set([project.ownerId, ...project.contributorIds])];
  registerAllParticipantPairs(existing, project, participantIds);
}
