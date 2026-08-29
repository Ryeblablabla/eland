import type { ActionOption } from '../../domain/action';
import type { DecisionContext } from '../../domain/model';
import type { ProjectState } from '../../domain/project';
import { projectIsLedBy } from '../../domain/project-leadership';
import { projectById } from '../../domain/state-index';

/**
 * Resolve only the current project that already passed record-use planning.
 * This is cognition-only: it must never promote the instrumental child to an
 * ordinary project intent or route its acquire/read actions into progress.
 */
export function currentRecordUseProject(
  context: DecisionContext,
  option: ActionOption,
): ProjectState | undefined {
  const basis = option.recordUseBasis;
  if (!basis
    || basis.readerId !== context.person.id
    || basis.demand.projectId !== basis.projectId) return undefined;
  const project = projectById(context.state, basis.projectId);
  if (!project
    || project.status !== 'active'
    || project.ownerId !== basis.projectOwnerId
    || !projectIsLedBy(project, context.person.id)) return undefined;
  return project;
}
