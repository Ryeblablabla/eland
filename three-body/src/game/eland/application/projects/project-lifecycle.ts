import type { SimulationState } from '../../domain/model';
import { isAlive, type PersonState } from '../../domain/person';
import type { ProjectState } from '../../domain/project';
import { shelterGeometryAt } from '../../domain/structure';
import { recordProjectNeedResolution } from '../../domain/cognition';
import { applyRelationEvidence } from '../../domain/relation';
import { remember } from '../../domain/memory';
import { buildProjectPressureBasis } from '../project-pressure';
import { closeProjectHypothesisCampaign } from '../project-hypotheses';
import { recordJointProjectSocialLearning } from '../../domain/social-learning';
import { projectCurrentLeadId } from '../../domain/project-leadership';
import { recordRecurringDutyProjectCompletion } from '../../domain/governance';
import {
  closeProjectSearchCampaigns,
  endActiveLogisticsEpisode,
} from './project-logistics';

export function refreshProjectPressure(
  state: SimulationState,
  project: ProjectState,
  atMonth: number,
): void {
  if (project.status !== 'active') return;
  const leadId = projectCurrentLeadId(project);
  const lead = state.people.find((person) => person.id === leadId && isAlive(person));
  if (!lead) return;
  const observed = buildProjectPressureBasis(state, lead, project, atMonth);
  project.pressureHistory ??= [];
  if (!project.pressureBasis || project.pressureBasis.basisKey !== observed.basisKey) {
    project.pressure = observed.pressure;
    project.pressureBasis = observed;
    if (!project.pressureHistory.some((basis) => basis.basisKey === observed.basisKey)) {
      project.pressureHistory.push(structuredClone(observed));
    }
  }
}

function rememberJointCompletion(state: SimulationState, project: ProjectState): void {
  const evidenceId = project.completionEventIds.at(-1) ?? project.actionEventIds.at(-1);
  if (!evidenceId || project.contributorIds.length < 2) return;
  const contributors = project.contributorIds
    .map((personId) => state.people.find((person) => person.id === personId && isAlive(person)))
    .filter((person): person is PersonState => Boolean(person));
  for (const person of contributors) {
    const partners = contributors.filter((other) => other.id !== person.id);
    for (const partner of partners) applyRelationEvidence(person, partner.id, evidenceId, { trust: 6, bond: 4 });
    remember(person, {
      id: `memory:joint-project:${project.id}:${person.id}`,
      kind: 'episode',
      summary: `与${partners.map((partner) => partner.name).join('、')}共同完成了“${project.summary}”`,
      importance: 78,
      createdAtMonth: project.completedAtMonth ?? state.clock.elapsedMonths,
      lastRecalledAtMonth: project.completedAtMonth ?? state.clock.elapsedMonths,
      personIds: partners.map((partner) => partner.id),
      sourceEventIds: [...project.completionEventIds],
    });
  }
}

function finalCompletionActor(state: SimulationState, project: ProjectState): PersonState | undefined {
  const completionIds = new Set(project.completionEventIds);
  const finalProjectActionId = [...project.actionEventIds].reverse().find((eventId) => completionIds.has(eventId))
    ?? project.completionEventIds.at(-1);
  if (!finalProjectActionId) return undefined;
  const actorId = [...(project.progressEvidence ?? [])].reverse()
    .find((evidence) => evidence.eventId === finalProjectActionId)?.actorId;
  if (!actorId) return undefined;
  return state.people.find((person) => person.id === actorId && isAlive(person));
}

export function completeProject(
  state: SimulationState,
  project: ProjectState,
  atMonth: number,
  evidenceEventIds: string[],
): void {
  endActiveLogisticsEpisode(project, atMonth, 'fulfilled', 'project-completed');
  closeProjectSearchCampaigns(project, atMonth);
  closeProjectHypothesisCampaign(project, atMonth, 'project-completed');
  project.status = 'completed';
  project.completedAtMonth = atMonth;
  project.completionEventIds = [...new Set(evidenceEventIds)];
  project.reservations = [];
  project.missingMaterialIds = [];
  project.materialDemands = [];
  if (project.shelterRequirement && project.site) {
    const shelter = shelterGeometryAt(state.world.grid, project.site);
    if (shelter) project.shelterOutcome = {
      enclosedSides: shelter.enclosedSides,
      openSides: shelter.openSides,
      weatherProtection: shelter.weatherProtection,
      thermalInsulation: shelter.thermalInsulation,
      evidenceEventIds: [...new Set(evidenceEventIds)],
    };
  }
  const completionActor = finalCompletionActor(state, project);
  if (completionActor) recordProjectNeedResolution(completionActor, project, atMonth);
  recordJointProjectSocialLearning(state, project, atMonth);
  recordRecurringDutyProjectCompletion(state, project);
  rememberJointCompletion(state, project);
}
