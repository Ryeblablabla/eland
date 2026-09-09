import type { DecisionContext } from '../domain/model';
import { visibleConstructionProgress } from './projects/project-proposals';

/** Model-facing capabilities may continue established projects; a local
 * planner's unselected proposal is not an authored goal or known method. */
export function knownProjectCapabilities(context: DecisionContext) {
  const { state, person } = context;
  const knownSourceIds = new Set([
    ...person.memories.flatMap((memory) => memory.sourceEventIds),
    ...person.knowledge.flatMap((knowledge) => knowledge.sourceEventIds),
  ]);
  const visibleCells = new Set(context.visibleCells);
  const projects = state.projects.filter((project) => project.ownerId === person.id
    || project.contributorIds.includes(person.id)
    || visibleConstructionProgress(project, visibleCells)
    || [
      ...(project.materialContributionRequests ?? []),
      ...(project.techniqueDemonstrationRequests ?? []),
      ...(project.knowledgeRequests ?? []),
    ].some((request) => knownSourceIds.has(request.requestEventId)));
  const projectIds = new Set(projects.map((project) => project.id));
  const allowed = (option: DecisionContext['options'][number]) => [
    option.projectId, option.projectProposal?.id, option.recordUseBasis?.projectId,
    ...(option.goal.kind === 'project-completed' ? [option.goal.projectId] : []),
  ].every((id) => !id || projectIds.has(id));
  return {
    projects,
    options: context.options.filter(allowed),
    followUpOptions: context.followUpOptions.filter(allowed),
  };
}
