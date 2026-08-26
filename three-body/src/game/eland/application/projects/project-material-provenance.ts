import { worldEventById } from '../../domain/event-index';
import type { SimulationState } from '../../domain/model';
import type { PersonState } from '../../domain/person';
import { resolvePersonKnownProcess } from '../../domain/person-known-process';
import type { ProjectState } from '../../domain/project';
import { completedFunctionMaterialIds } from './project-completion';

export interface ProjectMaterialPlanProvenance {
  version: 'project-material-plan-provenance-v1';
  kind: 'verified-technique' | 'completed-recipe';
  knowledgeId?: string;
  sourceFactIds: string[];
}

function verifiedTechniqueProvenance(
  person: PersonState,
  knowledgeId: string | undefined,
): ProjectMaterialPlanProvenance | null {
  if (!knowledgeId) return null;
  const fact = person.knowledge.find((candidate) => candidate.id === knowledgeId
    && candidate.kind === 'technique'
    && candidate.confidence >= 55);
  return fact ? {
    version: 'project-material-plan-provenance-v1',
    kind: 'verified-technique',
    knowledgeId: fact.id,
    sourceFactIds: [...new Set(fact.sourceEventIds)],
  } : null;
}

export function auditedTechniqueMaterialPlanProvenance(
  person: PersonState,
  knowledgeId: string | undefined,
): ProjectMaterialPlanProvenance | null {
  return verifiedTechniqueProvenance(person, knowledgeId);
}

/**
 * Exact project demands are epistemic claims, not consequences of merely
 * naming a desired function. They are available only when this person has a
 * verified technique/record, or a personally completed recipe fact for one
 * of the project's tangible outputs. Missing retained evidence fails closed.
 */
export function projectMaterialPlanProvenance(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): ProjectMaterialPlanProvenance | null {
  const outputMaterialIds = new Set(completedFunctionMaterialIds(project));
  const knowledgeIds = new Set<string>();
  if (project.planKnowledgeId) knowledgeIds.add(project.planKnowledgeId);
  for (const outputMaterialId of outputMaterialIds) {
    const resolution = resolvePersonKnownProcess(state, person, outputMaterialId);
    for (const techniqueId of resolution.techniqueIds) knowledgeIds.add(techniqueId);
  }
  for (const knowledgeId of [...knowledgeIds].sort()) {
    const provenance = verifiedTechniqueProvenance(person, knowledgeId);
    if (provenance) return provenance;
  }

  const candidateEventIds = new Set([
    ...project.actionEventIds,
    ...person.knowledge.flatMap((fact) => fact.sourceEventIds),
  ]);
  for (const eventId of [...candidateEventIds].sort()) {
    const event = worldEventById(state, eventId);
    if (event?.kind !== 'action'
      || event.who !== person.id
      || event.status !== 'completed'
      || event.action.kind !== 'act'
      || !outputMaterialIds.has(Number(event.diff.outputMaterialId))) continue;
    return {
      version: 'project-material-plan-provenance-v1',
      kind: 'completed-recipe',
      sourceFactIds: [event.id],
    };
  }
  return null;
}
