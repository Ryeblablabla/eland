import type { SimulationState } from '../../domain/model';
import { isAlive, type PersonState } from '../../domain/person';
import type { ProjectState } from '../../domain/project';
import { shelterGeometryAt } from '../../domain/structure';
import { applyRelationEvidence } from '../../domain/relation';
import { remember } from '../../domain/memory';
import { buildProjectPressureBasis } from '../project-pressure';
import { closeProjectHypothesisCampaign } from '../project-hypotheses';
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
  const owner = state.people.find((person) => person.id === project.ownerId && isAlive(person));
  if (!owner) return;
  const observed = buildProjectPressureBasis(state, owner, project, atMonth);
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
  rememberJointCompletion(state, project);
}
