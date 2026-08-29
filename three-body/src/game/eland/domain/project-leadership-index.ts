import type { SimulationState } from './model';
import type { PersonId } from './person';
import type { ProjectState } from './project';
import { projectCurrentLeadId } from './project-leadership';

interface ProjectLeadershipIndex {
  indexedLength: number;
  lastIndexedProject?: ProjectState;
  byLeadId: Map<PersonId, ProjectState[]>;
}

const projectLeadershipIndexes = new WeakMap<SimulationState['projects'], ProjectLeadershipIndex>();

/** Founder ownership remains immutable; this view follows the append-only current lead. */
export function projectsLedBy(state: SimulationState, leadId: PersonId): readonly ProjectState[] {
  const projects = state.projects;
  let index = projectLeadershipIndexes.get(projects);
  if (!index
    || index.indexedLength !== projects.length
    || index.lastIndexedProject !== projects.at(-1)) {
    const byLeadId = new Map<PersonId, ProjectState[]>();
    for (const project of projects) {
      const currentLeadId = projectCurrentLeadId(project);
      if (!currentLeadId) continue;
      const led = byLeadId.get(currentLeadId) ?? [];
      led.push(project);
      byLeadId.set(currentLeadId, led);
    }
    index = {
      indexedLength: projects.length,
      lastIndexedProject: projects.at(-1),
      byLeadId,
    };
    projectLeadershipIndexes.set(projects, index);
  }
  return index.byLeadId.get(leadId) ?? [];
}

/** Leadership transitions mutate project shells in place, so callers invalidate explicitly after an append. */
export function invalidateProjectLeadershipIndex(state: SimulationState): void {
  projectLeadershipIndexes.delete(state.projects);
}
