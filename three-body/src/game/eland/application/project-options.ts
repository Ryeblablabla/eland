import type { ActionOption, PrimitiveAction, WorldRef } from '../domain/action';
import {
  exposureRuleFor,
  exposureTechniqueId,
  exertionRuleFor,
  exertionTechniqueId,
  inventoryCombinationForOutput,
  inventoryCombinationRules,
  inventoryCombinationTechniqueId,
  type ExertionRule,
  type ExposureRule,
  type InventoryCombinationRule,
} from '../domain/interaction-rules';
import { Material, materialDefinition, materialHas, type MaterialId } from '../domain/material';
import type { ActionFact, DropState, SimulationState } from '../domain/model';
import {
  ageMonths,
  inventoryQuantity,
  isAlive,
  sameLocation,
  type ItemStack,
  type PersonState,
} from '../domain/person';
import {
  cloneProjectForPlanning,
  instantiateProject,
  type ProjectHypothesisCandidate,
  type ProjectHypothesisQuestionKind,
  type ProjectFunction,
  type ProjectInquiryOpportunityBasis,
  type ProjectInquiryOpportunitySource,
  type ProjectLogisticsEndingReason,
  type ProjectLogisticsEpisode,
  type ProjectLogisticsEpisodeStatus,
  type ProjectMaterialDemand,
  type ProjectNeed,
  type ProjectPressureBasis,
  type ProjectProgressEvidence,
  type ProjectProposal,
  type ProjectReservation,
  type ProjectSearchCampaign,
  type ProjectState,
} from '../domain/project';
import { shelterGeometryAt } from '../domain/structure';
import { worldEventById } from '../domain/event-index';
import { applyRelationEvidence } from '../domain/relation';
import { remember } from '../domain/memory';
import {
  cellX,
  cellY,
  cellsInRadius,
  findStandingPath,
  neighbors4,
  standingPositions,
  surfaceMaterial,
  topPosition,
  voxelAt,
  type StandingPosition,
} from '../world/grid';
import { seededFraction } from '../world/generator';
import { buildProjectPressureBasis, projectPressureReasonPresent, type ProjectPressureView } from './project-pressure';
import { buildLocalMaterialEvidence } from './local-material-evidence';
import {
  closeProjectHypothesisCampaign,
  nextProjectHypothesisCandidate,
  recordProjectHypothesisAttempt,
  recordProjectHypothesisVerification,
  type ProjectHypothesisRequest,
} from './project-hypotheses';

interface ProjectStep {
  key: string;
  summary: string;
  reason: string;
  action: PrimitiveAction;
  target?: WorldRef;
  sourceFactIds: string[];
  missingMaterialIds: MaterialId[];
  reservations: ProjectReservation[];
  planKnowledgeId?: string;
  materialDemands?: ProjectMaterialDemand[];
}

function visibleCellsFor(person: PersonState): number[] {
  return cellsInRadius(person.position.cellId, 4 + Math.floor(person.baselineCapacities.perception / 25));
}

function visibleDropsFor(state: SimulationState, person: PersonState): DropState[] {
  const visible = new Set(visibleCellsFor(person));
  return state.world.drops.filter((drop) => drop.quantity > 0 && visible.has(drop.cellId));
}

function locallyKnownPlacedContainer(
  state: SimulationState,
  person: PersonState,
  container: SimulationState['containers'][number],
): boolean {
  const materialId = voxelAt(
    state.world.grid,
    container.position.x,
    container.position.y,
    container.position.z,
  );
  if (materialId !== Material.Container) return false;
  const cellId = container.position.x + container.position.y * state.world.grid.width;
  if (visibleCellsFor(person).includes(cellId)) return true;
  return person.knownPlaces.some((place) => place.materialId === Material.Container
    && place.position.x === container.position.x
    && place.position.y === container.position.y
    && place.position.z === container.position.z);
}

export function refreshProjectPressure(state: SimulationState, project: ProjectState, atMonth: number): void {
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

function logisticsEpisodes(project: ProjectState): ProjectLogisticsEpisode[] {
  project.logisticsEpisodes ??= [];
  return project.logisticsEpisodes;
}

function activeLogisticsEpisode(project: ProjectState): ProjectLogisticsEpisode | undefined {
  if (!project.activeLogisticsEpisodeId) return undefined;
  const episode = logisticsEpisodes(project).find((candidate) => candidate.id === project.activeLogisticsEpisodeId
    && candidate.status === 'active');
  if (!episode) delete project.activeLogisticsEpisodeId;
  return episode;
}

function endLogisticsEpisode(
  project: ProjectState,
  episode: ProjectLogisticsEpisode,
  endedAt: number,
  status: Exclude<ProjectLogisticsEpisodeStatus, 'active'>,
  endingReason: ProjectLogisticsEndingReason,
): void {
  if (episode.status !== 'active') return;
  episode.status = status;
  episode.endedAt = endedAt;
  episode.endingReason = endingReason;
  if (project.activeLogisticsEpisodeId === episode.id) delete project.activeLogisticsEpisodeId;
}

function endActiveLogisticsEpisode(
  project: ProjectState,
  endedAt: number,
  status: Exclude<ProjectLogisticsEpisodeStatus, 'active'>,
  endingReason: ProjectLogisticsEndingReason,
): void {
  const episode = activeLogisticsEpisode(project);
  if (episode) endLogisticsEpisode(project, episode, endedAt, status, endingReason);
}

function closeProjectSearchCampaigns(project: ProjectState, atMonth: number): void {
  for (const campaign of project.searchCampaigns ?? []) {
    if (campaign.status !== 'active') continue;
    campaign.status = 'closed';
    campaign.closedAt = atMonth;
  }
}

function endingReasonForProject(project: ProjectState): ProjectLogisticsEndingReason {
  if (project.status === 'completed') return 'project-completed';
  if (project.status === 'abandoned') return 'project-abandoned';
  return 'project-blocked';
}

function endingStatusForProject(project: ProjectState): Exclude<ProjectLogisticsEpisodeStatus, 'active'> {
  return project.status === 'completed' ? 'fulfilled' : 'exhausted';
}

function completedFunctionMaterialIds(project: Pick<ProjectState, 'desiredFunction'>): MaterialId[] {
  if (project.desiredFunction === 'insulation') return [Material.LeatherClothing, Material.Clothing];
  if (project.desiredFunction === 'safer-hunting') return [Material.Spear];
  if (project.desiredFunction === 'healing') return [Material.HerbalMedicine];
  if (project.desiredFunction === 'prepared-food') return [Material.CookedFood];
  if (project.desiredFunction === 'efficient-production') return [Material.StoneHoe, Material.WoodTool];
  if (project.desiredFunction === 'workshop-production') return [Material.Workshop];
  if (project.desiredFunction === 'reserve-storage') return [Material.Granary];
  if (project.desiredFunction === 'reliable-water') return [Material.Cistern];
  if (project.desiredFunction === 'crop-processing') return [Material.Mill];
  if (project.desiredFunction === 'community-coordination') return [Material.CouncilHearth];
  if (project.desiredFunction === 'high-heat-processing') return [Material.Kiln];
  if (project.desiredFunction === 'brick-firing') return [Material.FiredBrick];
  if (project.desiredFunction === 'copper-charge') return [Material.CopperCharge];
  if (project.desiredFunction === 'copper-smelting') return [Material.Copper];
  if (project.desiredFunction === 'tin-charge') return [Material.TinCharge];
  if (project.desiredFunction === 'tin-smelting') return [Material.Tin];
  if (project.desiredFunction === 'bronze-alloying') return [Material.Bronze];
  if (project.desiredFunction === 'bronze-tooling') return [Material.BronzeTool];
  if (project.desiredFunction === 'bronze-workshop') return [Material.Foundry];
  if (project.desiredFunction === 'civic-coordination') return [Material.CivicHall];
  if (project.desiredFunction === 'iron-workshop') return [Material.Smithy];
  if (project.desiredFunction === 'iron-charge') return [Material.IronCharge];
  if (project.desiredFunction === 'iron-reduction') return [Material.IronBloom];
  if (project.desiredFunction === 'iron-working') return [Material.Iron];
  if (project.desiredFunction === 'iron-tooling') return [Material.IronTool];
  if (project.desiredFunction === 'fortified-coordination') return [Material.KeepCore];
  return [];
}

function placedFunctionMaterialIds(project: ProjectState): MaterialId[] {
  return completedFunctionMaterialIds(project).filter((materialId) => materialHas(materialId, 'facility'));
}

function projectActionFacts(state: SimulationState, project: ProjectState): ActionFact[] {
  return project.actionEventIds.flatMap((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action' ? [event] : [];
  });
}

const cultivationSurfaceMaterials = new Set<MaterialId>([
  Material.CropSprout,
  Material.CropMature,
  Material.ExhaustedSoil,
]);

const plantableCultivationMaterials = new Set<MaterialId>([
  Material.WetSoil,
  Material.RichSoil,
  Material.ExhaustedSoil,
]);

const harvestableSeedSourceMaterials = new Set<MaterialId>([
  Material.BerryBush,
  Material.CropMature,
]);

function projectCultivationCells(project: Pick<ProjectState, 'site'>): number[] {
  return project.site ? cellsInRadius(project.site.cellId, 2) : [];
}

function projectCultivationHarvests(state: SimulationState, project: ProjectState): ActionFact[] {
  return projectActionFacts(state, project).filter((event) => event.status === 'completed'
    && event.action.kind === 'act'
    && event.action.operation === 'separate'
    && Number(event.diff.sourceMaterialId) === Material.CropMature);
}

function placedFunctionEvidence(state: SimulationState, project: ProjectState): ActionFact[] {
  const desired = new Set(placedFunctionMaterialIds(project));
  if (!desired.size) return [];
  return projectActionFacts(state, project).filter((event) => {
    if (event.status !== 'completed') return false;
    const outputMaterialId = Number(event.diff.outputMaterialId);
    const position = event.diff.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
    if (!desired.has(outputMaterialId)
      || ![position?.x, position?.y, position?.z].every((value) => Number.isInteger(Number(value)))) return false;
    return voxelAt(state.world.grid, Number(position?.x), Number(position?.y), Number(position?.z)) === outputMaterialId;
  });
}

export function projectFunctionSatisfied(state: SimulationState, project: ProjectState): boolean {
  if (project.desiredFunction === 'weather-shelter') {
    if (!project.site) return false;
    const shelter = shelterGeometryAt(state.world.grid, project.site);
    if (!shelter) return false;
    const requirement = project.shelterRequirement;
    if (!requirement) return true;
    return shelter.enclosedSides >= requirement.minimumEnclosedSides
      && shelter.weatherProtection > requirement.baselineWeatherProtection
      && shelter.thermalInsulation > requirement.baselineThermalInsulation;
  }
  if (project.desiredFunction === 'durable-record') {
    return Boolean(project.targetKnowledgeId && state.records.some((record) => record.authorId === project.ownerId
      && record.knowledgeId === project.targetKnowledgeId));
  }
  if (project.desiredFunction === 'settled-cultivation') {
    const plantedCells = projectActionFacts(state, project).flatMap((event) => {
      if (event.kind !== 'action'
        || event.status !== 'completed'
        || event.action.kind !== 'act'
        || event.action.operation !== 'combine'
        || Number(event.diff.outputMaterialId) !== Material.CropSprout) return [];
      const position = event.diff.position as { x?: unknown; y?: unknown } | undefined;
      if (![position?.x, position?.y].every((value) => Number.isInteger(Number(value)))) return [];
      return [Number(position?.x) + Number(position?.y) * state.world.grid.width];
    });
    const plantedByProject = new Set(plantedCells).size >= 6;
    const harvests = projectCultivationHarvests(state, project).length;
    return plantedByProject && harvests >= 2;
  }
  if (project.desiredFunction === 'reserve-storage') {
    return placedFunctionEvidence(state, project).some((event) => {
      const position = event.diff.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
      const container = state.containers.find((candidate) => candidate.position.x === Number(position?.x)
        && candidate.position.y === Number(position?.y)
        && candidate.position.z === Number(position?.z));
      const storedFood = container?.inventory.reduce((sum, stack) => (
        materialHas(stack.materialId, 'edible') ? sum + stack.quantity : sum
      ), 0) ?? 0;
      const transfers = projectActionFacts(state, project).filter((candidate) => candidate.status === 'completed'
        && candidate.action.kind === 'transfer'
        && candidate.action.to.kind === 'container'
        && candidate.action.to.containerId === container?.id).length;
      return storedFood >= 2 && transfers >= 2;
    });
  }
  if (placedFunctionMaterialIds(project).length) return placedFunctionEvidence(state, project).length > 0;
  if (project.desiredFunction === 'healing') return false;
  const owner = state.people.find((person) => person.id === project.ownerId && isAlive(person));
  return Boolean(owner && completedFunctionMaterialIds(project).some((materialId) => inventoryQuantity(owner, materialId) > 0));
}

function completionEvidence(state: SimulationState, project: ProjectState): string[] {
  if (project.desiredFunction === 'weather-shelter') return [...project.actionEventIds];
  if (project.desiredFunction === 'durable-record') {
    return [...new Set(state.records
      .filter((record) => record.authorId === project.ownerId && record.knowledgeId === project.targetKnowledgeId)
      .flatMap((record) => record.sourceEventIds))];
  }
  if (project.desiredFunction === 'settled-cultivation') {
    return [...new Set(projectActionFacts(state, project)
      .filter((event) => event.status === 'completed')
      .map((event) => event.id))];
  }
  if (placedFunctionMaterialIds(project).length) return [...new Set([
    ...placedFunctionEvidence(state, project).map((event) => event.id),
    ...(project.desiredFunction === 'reserve-storage'
      ? projectActionFacts(state, project).filter((event) => event.status === 'completed'
        && event.action.kind === 'transfer'
        && event.action.to.kind === 'container').map((event) => event.id)
      : []),
  ])];
  const owner = state.people.find((person) => person.id === project.ownerId);
  const desired = new Set(completedFunctionMaterialIds(project));
  return owner
    ? [...new Set(owner.inventory.filter((stack) => desired.has(stack.materialId)).flatMap((stack) => stack.sourceEventIds))]
    : [];
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

function completeProject(state: SimulationState, project: ProjectState, atMonth: number, evidenceEventIds: string[]): void {
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

export function synchronizeProject(state: SimulationState, project: ProjectState, atMonth = state.clock.elapsedMonths): void {
  if (project.status !== 'active') {
    const terminalOwner = state.people.find((person) => person.id === project.ownerId);
    if (project.status === 'blocked' && terminalOwner) {
      freezeTerminalInquiryOpportunityBasis(state, terminalOwner, project, atMonth);
    }
    endActiveLogisticsEpisode(project, atMonth, endingStatusForProject(project), endingReasonForProject(project));
    if (project.status === 'completed') closeProjectHypothesisCampaign(project, atMonth, 'project-completed');
    else if (project.status === 'abandoned') closeProjectHypothesisCampaign(project, atMonth, 'project-abandoned');
    else if (project.status === 'blocked') closeProjectHypothesisCampaign(project, atMonth, 'project-blocked');
    return;
  }
  const owner = state.people.find((person) => person.id === project.ownerId);
  if (!owner || !isAlive(owner)) {
    if (owner) freezeTerminalInquiryOpportunityBasis(state, owner, project, atMonth);
    project.status = 'blocked';
    project.blockedAtMonth = atMonth;
    project.blockedReason = '项目发起者已经无法继续行动';
    project.materialDemands = [];
    endActiveLogisticsEpisode(project, atMonth, 'exhausted', 'project-blocked');
    closeProjectSearchCampaigns(project, atMonth);
    closeProjectHypothesisCampaign(project, atMonth, 'project-blocked');
    return;
  }
  refreshProjectPressure(state, project, atMonth);
  if (project.desiredFunction === 'healing') {
    const unresolved = project.beneficiaryIds.some((personId) => state.people.find((person) => person.id === personId && isAlive(person))
      ?.conditions.some((condition) => condition.kind === 'wound' || condition.kind === 'illness'));
    if (!unresolved) {
      project.status = 'abandoned';
      project.abandonedAtMonth = atMonth;
      project.blockedReason = '伤病在项目形成有效照护结果前已经消失';
      project.reservations = [];
      project.materialDemands = [];
      endActiveLogisticsEpisode(project, atMonth, 'exhausted', 'project-abandoned');
      closeProjectSearchCampaigns(project, atMonth);
      closeProjectHypothesisCampaign(project, atMonth, 'project-abandoned');
      return;
    }
  }
  if (projectFunctionSatisfied(state, project)) {
    completeProject(state, project, atMonth, completionEvidence(state, project));
    return;
  }
  const ownerProjectIntent = [...state.intents].reverse().find((intent) => intent.ownerId === project.ownerId
    && intent.projectId === project.id
    && (intent.status === 'active' || intent.status === 'suspended'));
  const progressAnchor = Math.max(
    project.lastProgressAtMonth,
    ownerProjectIntent?.lastResumedAtMonth ?? 0,
    ownerProjectIntent?.suspendedAtMonth ?? 0,
  );
  if (atMonth > project.reviewAtMonth && atMonth - progressAnchor >= 4) {
    freezeTerminalInquiryOpportunityBasis(state, owner, project, atMonth);
    project.status = 'blocked';
    project.blockedAtMonth = atMonth;
    project.blockedReason = '复核期内持续缺少可执行的材料、知识或空间步骤';
    project.reservations = [];
    project.materialDemands = [];
    endActiveLogisticsEpisode(project, atMonth, 'exhausted', 'project-blocked');
    closeProjectSearchCampaigns(project, atMonth);
    closeProjectHypothesisCampaign(project, atMonth, 'project-blocked');
  }
}

export function advanceProjects(state: SimulationState, atMonth = state.clock.elapsedMonths): void {
  for (const project of state.projects) synchronizeProject(state, project, atMonth);
}

function recordProjectProgress(project: ProjectState, evidence: ProjectProgressEvidence): void {
  project.progressEvidence ??= [];
  if (project.progressEvidence.some((item) => item.eventId === evidence.eventId)) return;
  project.progressEvidence.push(evidence);
  project.lastProgressAtMonth = Math.max(project.lastProgressAtMonth, evidence.atMonth);
}

function logisticsAdvanceEvidence(
  state: SimulationState,
  episode: ProjectLogisticsEpisode | undefined,
  fact: ActionFact,
): ProjectProgressEvidence | null {
  if (!episode
    || episode.actorId !== fact.who
    || episode.status !== 'active'
    || fact.action.kind !== 'move'
    || (fact.status !== 'progressed' && fact.status !== 'completed')) return null;
  const beforePath = findStandingPath(state.world.grid, { cellId: fact.fromCellId, z: fact.fromZ }, episode.target);
  const afterPath = findStandingPath(state.world.grid, { cellId: fact.toCellId, z: fact.toZ }, episode.target);
  if (!beforePath.length || !afterPath.length) return null;
  const distanceBefore = beforePath.length - 1;
  const distanceAfter = afterPath.length - 1;
  if (distanceAfter >= distanceBefore) return null;
  return {
    eventId: fact.id,
    atMonth: fact.atMonth,
    kind: 'logistics-advance',
    actorId: fact.who,
    episodeId: episode.id,
    target: structuredClone(episode.target),
    distanceBefore,
    distanceAfter,
  };
}

export function recordProjectAction(state: SimulationState, projectId: string, fact: ActionFact): void {
  const project = state.projects.find((candidate) => candidate.id === projectId);
  if (!project || project.status !== 'active') return;
  const actor = state.people.find((candidate) => candidate.id === fact.who);
  recordProjectHypothesisAttempt(project, fact, actor);
  recordProjectHypothesisVerification(
    project,
    actor,
    fact,
  );
  if (!project.actionEventIds.includes(fact.id)) project.actionEventIds.push(fact.id);
  const episode = activeLogisticsEpisode(project);
  if (episode?.actorId === fact.who && !episode.actionEventIds.includes(fact.id)) episode.actionEventIds.push(fact.id);
  const materialContribution = fact.status === 'completed'
    && (fact.action.kind === 'act'
      || fact.action.kind === 'transfer'
      || fact.action.kind === 'attend'
      || (fact.action.kind === 'communicate' && fact.action.channel === 'record'));
  if (fact.status === 'completed'
    && fact.action.kind === 'transfer'
    && fact.action.from.kind === 'person'
    && fact.action.from.personId === fact.who) {
    for (const request of project.materialContributionRequests ?? []) {
      if (!request.contributorIds.includes(fact.who)
        || fact.atMonth < request.atMonth
        || fact.atMonth > request.expiresAtMonth
        || fact.action.materialId !== request.materialId
        || request.contributionEventIds?.includes(fact.id)) continue;
      const quantity = Math.max(0, Number(fact.diff.quantity ?? 0));
      request.contributedQuantity = Math.min(
        request.requestedQuantity,
        (request.contributedQuantity ?? 0) + quantity,
      );
      request.contributionEventIds = [...(request.contributionEventIds ?? []), fact.id];
    }
  }
  const logisticsProgress = logisticsAdvanceEvidence(state, episode, fact);
  if (logisticsProgress) recordProjectProgress(project, logisticsProgress);
  if (materialContribution) recordProjectProgress(project, {
    eventId: fact.id,
    atMonth: fact.atMonth,
    kind: 'material-contribution',
    actorId: fact.who,
    ...(episode ? { episodeId: episode.id, target: structuredClone(episode.target) } : {}),
  });
  if (materialContribution && !project.contributorIds.includes(fact.who)) project.contributorIds.push(fact.who);
  if (project.desiredFunction === 'healing'
    && typeof fact.diff.caredPersonId === 'string'
    && project.beneficiaryIds.includes(fact.diff.caredPersonId)) {
    completeProject(state, project, fact.atMonth, [fact.id]);
    return;
  }
  if (fact.status === 'blocked' || fact.status === 'failed') {
    if (!project.failureEventIds.includes(fact.id)) project.failureEventIds.push(fact.id);
  }
  if (episode?.actorId === fact.who && episode.status === 'active') {
    if (episode.kind === 'drop'
      && episode.sourceRef.kind === 'drop'
      && fact.status === 'completed'
      && fact.action.kind === 'transfer'
      && fact.action.from.kind === 'ground'
      && fact.action.dropId === episode.sourceRef.dropId) {
      endLogisticsEpisode(project, episode, fact.atMonth, 'fulfilled', 'material-acquired');
    } else if (episode.kind === 'source'
      && episode.sourceRef.kind === 'voxel-source'
      && fact.status === 'completed'
      && fact.action.kind === 'act'
      && fact.action.operation === 'separate') {
      const expectedMaterialId = episode.materialIds[0];
      const target = fact.action.targets[0];
      const position = episode.sourceRef.position;
      const targetMatches = target?.kind === 'voxel'
        && target.position.x === position.x
        && target.position.y === position.y
        && target.position.z === position.z;
      const producedMaterial = Array.isArray(fact.diff.outputs)
        && fact.diff.outputs.some((output) => {
          if (!output || typeof output !== 'object') return false;
          const item = output as { materialId?: unknown; quantity?: unknown };
          return Number(item.materialId) === expectedMaterialId && Number(item.quantity) > 0;
        });
      endLogisticsEpisode(
        project,
        episode,
        fact.atMonth,
        targetMatches && producedMaterial ? 'fulfilled' : 'invalidated',
        targetMatches && producedMaterial ? 'material-produced' : 'source-invalidated',
      );
    } else if (fact.status === 'blocked' || fact.status === 'failed') {
      const reason = episode.kind === 'search'
        ? 'search-target-unreachable'
        : fact.action.kind === 'move' ? 'source-unreachable' : 'source-invalidated';
      endLogisticsEpisode(project, episode, fact.atMonth, 'invalidated', reason);
    } else if (episode.kind === 'search' && fact.action.kind === 'move') {
      const reached = fact.toCellId === episode.target.cellId && fact.toZ === episode.target.z;
      if (reached && fact.status === 'completed') {
        endLogisticsEpisode(project, episode, fact.atMonth, 'fulfilled', 'search-target-reached');
      } else if (episode.actionEventIds.length >= (episode.actionBudget ?? 1)) {
        endLogisticsEpisode(project, episode, fact.atMonth, 'exhausted', 'search-budget-exhausted');
      }
    }
  }
  synchronizeProject(state, project, fact.atMonth);
}

function reservation(person: PersonState, stackId: string, quantity = 1): ProjectReservation[] {
  const stack = person.inventory.find((candidate) => candidate.id === stackId);
  return stack ? [{ personId: person.id, stackId, materialId: stack.materialId, quantity }] : [];
}

function materialDemand(
  person: PersonState,
  materialId: MaterialId,
  requiredQuantity: number,
  branchKey: string,
  sourceFactIds: string[] = [],
): ProjectMaterialDemand {
  const availableQuantity = inventoryQuantity(person, materialId);
  return {
    materialId,
    requiredQuantity: Math.max(0, Math.floor(requiredQuantity)),
    availableQuantity,
    outstandingQuantity: Math.max(0, Math.floor(requiredQuantity) - availableQuantity),
    branchKey,
    sourceFactIds: [...new Set(sourceFactIds)],
  };
}

function dropStep(
  person: PersonState,
  drop: DropState,
  purpose: string,
  demand = materialDemand(person, drop.materialId, inventoryQuantity(person, drop.materialId) + 1, `direct:${drop.materialId}`),
): ProjectStep | null {
  if (demand.materialId !== drop.materialId || demand.outstandingQuantity <= 0) return null;
  const material = materialDefinition(drop.materialId).name;
  const together = person.position.cellId === drop.cellId && person.position.z === drop.z;
  const requestedQuantity = Math.min(demand.outstandingQuantity, drop.quantity);
  if (requestedQuantity <= 0) return null;
  return {
    key: `collect-${drop.id}`,
    summary: `为${purpose}取得${material}`,
    reason: `眼前可见的${material}符合当前项目缺少的物质性质`,
    action: together
      ? {
          kind: 'transfer', materialId: drop.materialId, quantity: requestedQuantity,
          from: { kind: 'ground', cellId: drop.cellId, z: drop.z }, to: { kind: 'person', personId: person.id }, dropId: drop.id,
        }
      : { kind: 'move', toCellId: drop.cellId, toZ: drop.z },
    target: { kind: 'drop', dropId: drop.id },
    sourceFactIds: drop.sourceEventIds,
    missingMaterialIds: [drop.materialId],
    materialDemands: [structuredClone(demand)],
    reservations: [],
  };
}

function nearestDrop(state: SimulationState, person: PersonState, drops: DropState[], materialIds: Iterable<MaterialId>): DropState | undefined {
  const wanted = new Set(materialIds);
  return drops
    .filter((drop) => wanted.has(drop.materialId))
    .flatMap((drop) => {
      const path = findStandingPath(state.world.grid, person.position, { cellId: drop.cellId, z: drop.z });
      return path.length ? [{ drop, pathLength: path.length }] : [];
    })
    .sort((a, b) => a.pathLength - b.pathLength || a.drop.id.localeCompare(b.drop.id))[0]?.drop;
}

function nearestRememberedDrop(
  state: SimulationState,
  person: PersonState,
  materialIds: Iterable<MaterialId>,
): DropState | undefined {
  const wanted = new Set(materialIds);
  const remembered = person.knownPlaces.filter((place) => wanted.has(place.materialId));
  return state.world.drops
    .filter((drop) => drop.quantity > 0 && wanted.has(drop.materialId))
    .filter((drop) => remembered.some((place) => place.materialId === drop.materialId
      && place.position.x === cellX(drop.cellId)
      && place.position.y === cellY(drop.cellId)
      && place.position.z === drop.z))
    .flatMap((drop) => {
      const path = findStandingPath(state.world.grid, person.position, { cellId: drop.cellId, z: drop.z });
      return path.length ? [{ drop, pathLength: path.length }] : [];
    })
    .sort((left, right) => left.pathLength - right.pathLength || left.drop.id.localeCompare(right.drop.id))[0]?.drop;
}

const METALLURGY_FACILITIES = [Material.Kiln, Material.Foundry] as const;

function fixedFacilityWorkplace(
  state: SimulationState,
  person: PersonState,
  site: ProjectState['site'],
  allowedMaterialIds: readonly MaterialId[] = METALLURGY_FACILITIES,
): { target: LocalVoxelTarget; workingPosition: StandingPosition; pathLength: number } | null {
  if (!site) return null;
  const x = cellX(site.cellId);
  const y = cellY(site.cellId);
  const materialId = voxelAt(state.world.grid, x, y, site.z);
  if (!allowedMaterialIds.includes(materialId)) return null;
  return [site.cellId, ...neighbors4(site.cellId)]
    .flatMap((cellId) => standingPositions(state.world.grid, cellId))
    .filter((position) => canWorkSource(position, { x, y, z: site.z }))
    .flatMap((workingPosition) => {
      const path = findStandingPath(state.world.grid, person.position, workingPosition);
      return path.length ? [{
        target: { position: { x, y, z: site.z }, materialId },
        workingPosition,
        pathLength: path.length - 1,
      }] : [];
    })
    .sort((left, right) => left.pathLength - right.pathLength
      || left.workingPosition.cellId - right.workingPosition.cellId
      || left.workingPosition.z - right.workingPosition.z)[0] ?? null;
}

function knownFacilitySite(
  state: SimulationState,
  person: PersonState,
  materialIds: readonly MaterialId[] = METALLURGY_FACILITIES,
): ProjectState['site'] | undefined {
  const accepted = new Set(materialIds);
  const visible = visibleCellsFor(person).flatMap((cellId) => {
    const position = topPosition(state.world.grid, cellId);
    return accepted.has(voxelAt(state.world.grid, position.x, position.y, position.z))
      ? [{ cellId, z: position.z }]
      : [];
  });
  const remembered = person.knownPlaces.flatMap((place) => {
    const cellId = place.position.x + place.position.y * state.world.grid.width;
    return accepted.has(place.materialId)
      && voxelAt(state.world.grid, place.position.x, place.position.y, place.position.z) === place.materialId
      ? [{ cellId, z: place.position.z }]
      : [];
  });
  return [...visible, ...remembered]
    .flatMap((site) => {
      const work = fixedFacilityWorkplace(state, person, site, materialIds);
      return work ? [{ site, pathLength: work.pathLength }] : [];
    })
    .sort((left, right) => left.pathLength - right.pathLength
      || left.site.cellId - right.site.cellId
      || left.site.z - right.site.z)[0]?.site;
}

interface VisibleMaterialSource {
  sourcePosition: { x: number; y: number; z: number };
  sourceMaterialId: MaterialId;
  outputMaterialId: MaterialId;
  workingPosition: StandingPosition;
  pathLength: number;
}

function bodyStandsOnSource(
  state: SimulationState,
  sourcePosition: { x: number; y: number; z: number },
): boolean {
  const sourceCellId = sourcePosition.x + sourcePosition.y * state.world.grid.width;
  return state.people.some((candidate) => isAlive(candidate)
    && candidate.position.cellId === sourceCellId
    && candidate.position.z === sourcePosition.z + 1);
}

function canWorkSource(
  position: StandingPosition,
  sourcePosition: { x: number; y: number; z: number },
): boolean {
  const horizontal = Math.abs(cellX(position.cellId) - sourcePosition.x)
    + Math.abs(cellY(position.cellId) - sourcePosition.y);
  return horizontal <= 1 && Math.abs(position.z - sourcePosition.z) <= 2;
}

function sourceProduces(sourceMaterialId: MaterialId, outputMaterialId: MaterialId): boolean {
  if (outputMaterialId === Material.Wood) {
    return sourceMaterialId === Material.Wood || sourceMaterialId === Material.Leaves;
  }
  if (outputMaterialId === Material.Fiber) {
    return sourceMaterialId === Material.Shrub
      || sourceMaterialId === Material.Wood
      || sourceMaterialId === Material.Leaves;
  }
  if (outputMaterialId === Material.Seed) {
    return sourceMaterialId === Material.BerryBush || sourceMaterialId === Material.CropMature;
  }
  return false;
}

function visibleMaterialSource(
  state: SimulationState,
  person: PersonState,
  outputMaterialId: MaterialId,
): VisibleMaterialSource | null {
  return visibleCellsFor(person)
    .filter((cellId) => {
      const materialId = surfaceMaterial(state.world.grid, cellId);
      return sourceProduces(materialId, outputMaterialId);
    })
    .flatMap((cellId) => {
      const sourcePosition = topPosition(state.world.grid, cellId);
      if (bodyStandsOnSource(state, sourcePosition)) return [];
      const sourceMaterialId = voxelAt(
        state.world.grid,
        sourcePosition.x,
        sourcePosition.y,
        sourcePosition.z,
      );
      return [cellId, ...neighbors4(cellId)]
        .flatMap((workingCellId) => standingPositions(state.world.grid, workingCellId))
        .filter((workingPosition) => canWorkSource(workingPosition, sourcePosition))
        .flatMap((workingPosition) => {
          const path = findStandingPath(state.world.grid, person.position, workingPosition);
          return path.length ? [{
            sourcePosition,
            sourceMaterialId,
            outputMaterialId,
            workingPosition,
            pathLength: path.length - 1,
          }] : [];
        });
    })
    .sort((left, right) => left.pathLength - right.pathLength
      || left.workingPosition.cellId - right.workingPosition.cellId
      || left.sourcePosition.x - right.sourcePosition.x
      || left.sourcePosition.y - right.sourcePosition.y
      || left.sourcePosition.z - right.sourcePosition.z)[0] ?? null;
}

interface ProjectSearchDestination {
  target: StandingPosition;
  pathLength: number;
  campaignId: string;
}

function searchCampaignBasisKey(project: ProjectState, person: PersonState, materialIds: MaterialId[]): string {
  return [
    'project-search-campaign-v1',
    `project=${project.id}`,
    `actor=${person.id}`,
    `materials=${[...new Set(materialIds)].sort((a, b) => a - b).join(',')}`,
    `plan=${project.planKnowledgeId ?? 'none'}`,
  ].join('|');
}

function projectSearchCampaigns(project: ProjectState): ProjectSearchCampaign[] {
  project.searchCampaigns ??= [];
  return project.searchCampaigns;
}

function targetKey(target: StandingPosition): string {
  return `${target.cellId}:${target.z}`;
}

function targetCellId(key: string): number | null {
  const separator = key.indexOf(':');
  if (separator <= 0) return null;
  const cellId = Number(key.slice(0, separator));
  return Number.isInteger(cellId) ? cellId : null;
}

function sameMaterialBasis(left: MaterialId[], right: MaterialId[]): boolean {
  const normalizedLeft = [...new Set(left)].sort((a, b) => a - b);
  const normalizedRight = [...new Set(right)].sort((a, b) => a - b);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((materialId, index) => materialId === normalizedRight[index]);
}

function campaignPlanKnowledgeId(campaign: ProjectSearchCampaign): string | undefined {
  if (campaign.planKnowledgeId) return campaign.planKnowledgeId;
  const match = campaign.basisKey.match(/(?:^|\|)plan=([^|]+)/);
  return match?.[1] && match[1] !== 'none' ? match[1] : undefined;
}

function inheritedSearchExperience(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  materialIds: MaterialId[],
  cellIds: number[],
): { campaignIds: string[]; targetKeys: string[] } {
  const visible = new Set(cellIds);
  const campaignIds = new Set<string>();
  const targetKeys = new Set<string>();
  for (const priorProject of state.projects) {
    if (priorProject.id === project.id) continue;
    for (const campaign of priorProject.searchCampaigns ?? []) {
      if (campaign.actorId !== person.id
        || campaignPlanKnowledgeId(campaign) !== project.planKnowledgeId
        || !sameMaterialBasis(campaign.materialIds, materialIds)) continue;
      const overlapping = [
        ...(campaign.inheritedTargetKeys ?? []),
        ...campaign.attemptedTargetKeys,
      ].filter((key) => {
        const cellId = targetCellId(key);
        return cellId !== null && visible.has(cellId);
      });
      if (!overlapping.length) continue;
      campaignIds.add(campaign.id);
      for (const key of overlapping) targetKeys.add(key);
    }
  }
  return {
    campaignIds: [...campaignIds].sort(),
    targetKeys: [...targetKeys].sort(),
  };
}

function searchCampaignFor(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  materialIds: MaterialId[],
  atMonth: number,
): ProjectSearchCampaign {
  const campaigns = projectSearchCampaigns(project);
  const basisKey = searchCampaignBasisKey(project, person, materialIds);
  const existing = campaigns.find((campaign) => campaign.basisKey === basisKey
    && (campaign.status === 'active' || campaign.status === 'exhausted'));
  if (existing) return existing;
  for (const campaign of campaigns) {
    if (campaign.actorId !== person.id || campaign.status !== 'active') continue;
    campaign.status = 'superseded';
    campaign.closedAt = atMonth;
  }
  const cellIds = [...new Set(visibleCellsFor(person))].sort((a, b) => a - b);
  const inherited = inheritedSearchExperience(state, person, project, materialIds, cellIds);
  const campaign: ProjectSearchCampaign = {
    id: `project-search-campaign:${project.id}:${campaigns.length}:${person.id}`,
    projectId: project.id,
    ownerId: project.ownerId,
    actorId: person.id,
    materialIds: [...new Set(materialIds)].sort((a, b) => a - b),
    ...(project.planKnowledgeId ? { planKnowledgeId: project.planKnowledgeId } : {}),
    basisKey,
    openedAt: atMonth,
    anchor: { cellId: person.position.cellId, z: person.position.z },
    cellIds,
    inheritedTargetKeys: inherited.targetKeys,
    inheritedCampaignIds: inherited.campaignIds,
    attemptedTargetKeys: [],
    sourceFactIds: localRequirementSourceEventIds(person, project, materialIds),
    status: 'active',
  };
  campaigns.push(campaign);
  return campaign;
}

export function visibleReachableSearchDestination(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  materialIds: MaterialId[],
): ProjectSearchDestination | null {
  const atMonth = state.clock.elapsedMonths + 1;
  const campaign = searchCampaignFor(state, person, project, materialIds, atMonth);
  if (campaign.status === 'exhausted') return null;
  const visible = new Set(campaign.cellIds);
  const attempted = new Set([
    ...(campaign.inheritedTargetKeys ?? []),
    ...campaign.attemptedTargetKeys,
  ]);
  const visits = new Map<number, number>();
  for (const cellId of person.position.lastPath) visits.set(cellId, (visits.get(cellId) ?? 0) + 1);
  const candidates = [...visible].sort((a, b) => a - b).flatMap((candidateCell) => {
    if (candidateCell === person.position.cellId) return [];
    return standingPositions(state.world.grid, candidateCell).flatMap((target) => {
      if (attempted.has(targetKey(target))) return [];
      const path = findStandingPath(state.world.grid, person.position, target);
      if (path.length <= 1 || path.some((position) => !visible.has(position.cellId))) return [];
      return [{
        target,
        firstStepCellId: path[1].cellId,
        pathLength: path.length - 1,
        recentVisits: visits.get(candidateCell) ?? 0,
        visibleTraffic: state.world.traffic?.[`${candidateCell}:${target.z}`] ?? 0,
        seededRank: seededFraction(
          state.seed,
          `project-search:${campaign.id}:${materialIds.join(',')}:${candidateCell}:${target.z}`,
        ),
      }];
    });
  });
  if (!candidates.length) {
    campaign.status = 'exhausted';
    campaign.closedAt = atMonth;
    return null;
  }
  const previousStep = person.position.lastPath.length >= 2
    ? person.position.lastPath.at(-2)
    : person.position.previousCellId;
  const nonReversing = candidates.filter((candidate) => candidate.firstStepCellId !== previousStep);
  const pool = nonReversing.length ? nonReversing : candidates;
  const selected = pool.sort((a, b) => a.recentVisits - b.recentVisits
    || a.visibleTraffic - b.visibleTraffic
    || b.pathLength - a.pathLength
    || a.seededRank - b.seededRank
      || a.target.cellId - b.target.cellId
      || a.target.z - b.target.z)[0];
  campaign.attemptedTargetKeys.push(targetKey(selected.target));
  return { target: selected.target, pathLength: selected.pathLength, campaignId: campaign.id };
}

function localRequirementSourceEventIds(
  person: PersonState,
  project: ProjectState,
  materialIds: MaterialId[],
): string[] {
  const wanted = new Set(materialIds);
  const plan = project.planKnowledgeId
    ? person.knowledge.find((fact) => fact.id === project.planKnowledgeId)
    : undefined;
  return [...new Set([
    ...project.triggerFactIds,
    ...(project.pressureBasis?.sourceFactIds ?? []),
    ...(plan?.sourceEventIds ?? []),
    ...person.inventory.filter((stack) => wanted.has(stack.materialId)).flatMap((stack) => stack.sourceEventIds),
  ])];
}

function startDropLogisticsEpisode(
  project: ProjectState,
  person: PersonState,
  drop: DropState,
  sourceEventIds: string[],
  createdAt: number,
  demand: ProjectMaterialDemand,
): ProjectLogisticsEpisode {
  const episodes = logisticsEpisodes(project);
  const episode: ProjectLogisticsEpisode = {
    id: `project-logistics:${project.id}:${episodes.length}:drop:${drop.id}`,
    kind: 'drop',
    actorId: person.id,
    materialIds: [drop.materialId],
    target: { cellId: drop.cellId, z: drop.z },
    sourceRef: { kind: 'drop', dropId: drop.id },
    sourceEventIds: [...new Set([
      ...sourceEventIds,
      ...drop.sourceEventIds,
      ...localRequirementSourceEventIds(person, project, [drop.materialId]),
    ])],
    createdAt,
    status: 'active',
    actionEventIds: [],
    startingQuantity: inventoryQuantity(person, drop.materialId),
    materialDemand: structuredClone(demand),
    requestedQuantity: Math.min(demand.outstandingQuantity, drop.quantity),
  };
  episodes.push(episode);
  project.activeLogisticsEpisodeId = episode.id;
  return episode;
}

function startSourceLogisticsEpisode(
  project: ProjectState,
  person: PersonState,
  source: VisibleMaterialSource,
  sourceEventIds: string[],
  createdAt: number,
  demand: ProjectMaterialDemand,
): ProjectLogisticsEpisode {
  const episodes = logisticsEpisodes(project);
  const sourceKey = `${source.sourcePosition.x}:${source.sourcePosition.y}:${source.sourcePosition.z}`;
  const episode: ProjectLogisticsEpisode = {
    id: `project-logistics:${project.id}:${episodes.length}:source:${sourceKey}`,
    kind: 'source',
    actorId: person.id,
    materialIds: [source.outputMaterialId],
    target: { ...source.workingPosition },
    sourceRef: {
      kind: 'voxel-source',
      position: { ...source.sourcePosition },
      sourceMaterialId: source.sourceMaterialId,
    },
    sourceEventIds: [...new Set([
      ...sourceEventIds,
      ...localRequirementSourceEventIds(person, project, [source.outputMaterialId]),
    ])],
    createdAt,
    status: 'active',
    actionEventIds: [],
    visibleSourceCountAtCreation: 1,
    sourcePathLengthAtCreation: source.pathLength,
    startingQuantity: inventoryQuantity(person, source.outputMaterialId),
    materialDemand: structuredClone(demand),
  };
  episodes.push(episode);
  project.activeLogisticsEpisodeId = episode.id;
  return episode;
}

function startSearchLogisticsEpisode(
  project: ProjectState,
  person: PersonState,
  materialIds: MaterialId[],
  destination: ProjectSearchDestination,
  sourceEventIds: string[],
  createdAt: number,
  demands: ProjectMaterialDemand[],
  visibleSourceCountAtCreation?: number,
): ProjectLogisticsEpisode {
  const episodes = logisticsEpisodes(project);
  const episode: ProjectLogisticsEpisode = {
    id: `project-logistics:${project.id}:${episodes.length}:search`,
    kind: 'search',
    actorId: person.id,
    materialIds: [...new Set(materialIds)],
    target: { ...destination.target },
    sourceRef: { kind: 'project-requirement', projectId: project.id },
    searchCampaignId: destination.campaignId,
    sourceEventIds: [...new Set([
      ...sourceEventIds,
      ...localRequirementSourceEventIds(person, project, materialIds),
    ])],
    createdAt,
    status: 'active',
    actionEventIds: [],
    actionBudget: Math.max(4, Math.min(16, destination.pathLength + 4)),
    ...(visibleSourceCountAtCreation === undefined ? {} : { visibleSourceCountAtCreation }),
    materialDemands: structuredClone(demands),
  };
  episodes.push(episode);
  project.activeLogisticsEpisodeId = episode.id;
  return episode;
}

function dropEpisodeStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  project: ProjectState,
  episode: ProjectLogisticsEpisode,
): ProjectStep | null {
  if (episode.kind !== 'drop' || episode.sourceRef.kind !== 'drop') return null;
  const materialId = episode.materialIds[0];
  if (materialId === undefined) {
    endLogisticsEpisode(project, episode, state.clock.elapsedMonths + 1, 'invalidated', 'source-invalidated');
    return null;
  }
  const requestedQuantity = Math.max(0, Math.floor(episode.requestedQuantity ?? 1));
  const gainedQuantity = episode.startingQuantity === undefined
    ? 0
    : Math.max(0, inventoryQuantity(person, materialId) - episode.startingQuantity);
  if (requestedQuantity <= 0) {
    endLogisticsEpisode(project, episode, state.clock.elapsedMonths + 1, 'invalidated', 'source-invalidated');
    return null;
  }
  if (episode.startingQuantity !== undefined && gainedQuantity >= requestedQuantity) {
    const newEvidence = person.inventory
      .filter((stack) => stack.materialId === materialId)
      .flatMap((stack) => stack.sourceEventIds)
      .filter((eventId) => !episode.sourceEventIds.includes(eventId) && !episode.actionEventIds.includes(eventId));
    episode.actionEventIds.push(...newEvidence);
    endLogisticsEpisode(project, episode, state.clock.elapsedMonths + 1, 'fulfilled', 'material-acquired');
    return null;
  }
  const dropId = episode.sourceRef.dropId;
  const source = visibleDrops.find((drop) => drop.id === dropId
    && drop.quantity > 0
    && drop.materialId === materialId
    && drop.cellId === episode.target.cellId
    && drop.z === episode.target.z);
  const targetVisible = visibleCellsFor(person).includes(episode.target.cellId);
  if (targetVisible && !source) {
    endLogisticsEpisode(project, episode, state.clock.elapsedMonths + 1, 'invalidated', 'source-invalidated');
    return null;
  }
  const together = person.position.cellId === episode.target.cellId && person.position.z === episode.target.z;
  if (!together) {
    const path = findStandingPath(state.world.grid, person.position, episode.target);
    if (!path.length) {
      endLogisticsEpisode(project, episode, state.clock.elapsedMonths + 1, 'invalidated', 'source-unreachable');
      return null;
    }
    return {
      key: `locked-drop-${episode.id}`,
      summary: `继续前往已锁定的${materialDefinition(materialId).name}来源`,
      reason: '该地面来源已经由本人亲眼确认；其他更近来源不会替换尚未结算的项目目标',
      action: { kind: 'move', toCellId: episode.target.cellId, toZ: episode.target.z },
      target: { kind: 'drop', dropId },
      sourceFactIds: [...episode.sourceEventIds],
      missingMaterialIds: [...episode.materialIds],
      materialDemands: episode.materialDemand ? [structuredClone(episode.materialDemand)] : undefined,
      reservations: [],
    };
  }
  if (!source) {
    endLogisticsEpisode(project, episode, state.clock.elapsedMonths + 1, 'invalidated', 'source-invalidated');
    return null;
  }
  const remainingQuantity = Math.max(0, requestedQuantity - gainedQuantity);
  if (remainingQuantity <= 0) {
    endLogisticsEpisode(project, episode, state.clock.elapsedMonths + 1, 'fulfilled', 'material-acquired');
    return null;
  }
  return {
    key: `locked-drop-${episode.id}`,
    summary: `从已锁定来源取得${materialDefinition(materialId).name}`,
    reason: '本人已经抵达先前亲眼确认并持续保留的项目来源',
    action: {
      kind: 'transfer', materialId, quantity: Math.min(remainingQuantity, source.quantity),
      from: { kind: 'ground', cellId: source.cellId, z: source.z },
      to: { kind: 'person', personId: person.id }, dropId: source.id,
    },
    target: { kind: 'drop', dropId: source.id },
    sourceFactIds: [...episode.sourceEventIds],
    missingMaterialIds: [...episode.materialIds],
    materialDemands: episode.materialDemand ? [structuredClone(episode.materialDemand)] : undefined,
    reservations: [],
  };
}

function sourceEpisodeStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  episode: ProjectLogisticsEpisode,
): ProjectStep | null {
  if (episode.kind !== 'source' || episode.sourceRef.kind !== 'voxel-source') return null;
  const atMonth = state.clock.elapsedMonths + 1;
  const demand = episode.materialDemand;
  const outputMaterialId = episode.materialIds[0];
  if (!demand
    || outputMaterialId === undefined
    || demand.materialId !== outputMaterialId
    || demand.outstandingQuantity <= 0
    || episode.materialIds.length !== 1) {
    endLogisticsEpisode(project, episode, atMonth, 'invalidated', 'source-invalidated');
    return null;
  }
  const sourcePosition = episode.sourceRef.position;
  const sourceMaterialId = voxelAt(
    state.world.grid,
    sourcePosition.x,
    sourcePosition.y,
    sourcePosition.z,
  );
  if (!sourceProduces(sourceMaterialId, outputMaterialId)) {
    endLogisticsEpisode(project, episode, atMonth, 'invalidated', 'source-invalidated');
    return null;
  }
  const together = person.position.cellId === episode.target.cellId
    && person.position.z === episode.target.z;
  if (!together) {
    const path = findStandingPath(state.world.grid, person.position, episode.target);
    if (!path.length) {
      endLogisticsEpisode(project, episode, atMonth, 'invalidated', 'source-unreachable');
      return null;
    }
    const outputName = materialDefinition(outputMaterialId).name;
    return {
      key: `locked-source-${episode.id}`,
      summary: `继续前往已看见的${outputName}来源`,
      reason: `当前项目明确缺${outputName}；这处来源和可达工作位置已经由本人视野固定，不会逐月漂移`,
      action: { kind: 'move', toCellId: episode.target.cellId, toZ: episode.target.z },
      target: { kind: 'voxel', position: { ...sourcePosition } },
      sourceFactIds: [...episode.sourceEventIds],
      missingMaterialIds: [outputMaterialId],
      materialDemands: [structuredClone(demand)],
      reservations: [],
    };
  }
  if (!canWorkSource(person.position, sourcePosition)) {
    endLogisticsEpisode(project, episode, atMonth, 'invalidated', 'source-unreachable');
    return null;
  }
  const tool = person.inventory
    .filter((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'tool'))
    .sort((left, right) => materialDefinition(right.materialId).hardness - materialDefinition(left.materialId).hardness)[0];
  const outputName = materialDefinition(outputMaterialId).name;
  return {
    key: `locked-source-${episode.id}`,
    summary: `从已看见的来源分离项目所缺${outputName}`,
    reason: '本人已经抵达可接触的真实物质来源；分离产量仍由物质规则裁决，产物不会直接凭空进入背包',
    action: {
      kind: 'act',
      operation: 'separate',
      targets: [{ kind: 'voxel', position: { ...sourcePosition } }],
      ...(tool ? { toolStackId: tool.id } : {}),
    },
    target: { kind: 'voxel', position: { ...sourcePosition } },
    sourceFactIds: [...new Set([...episode.sourceEventIds, ...(tool?.sourceEventIds ?? [])])],
    missingMaterialIds: [outputMaterialId],
    materialDemands: [structuredClone(demand)],
    reservations: [],
  };
}

function searchEpisodeStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  episode: ProjectLogisticsEpisode,
): ProjectStep | null {
  if (episode.kind !== 'search') return null;
  const atMonth = state.clock.elapsedMonths + 1;
  if (person.position.cellId === episode.target.cellId && person.position.z === episode.target.z) {
    endLogisticsEpisode(project, episode, atMonth, 'fulfilled', 'search-target-reached');
    return null;
  }
  if (episode.actionEventIds.length >= (episode.actionBudget ?? 1)) {
    endLogisticsEpisode(project, episode, atMonth, 'exhausted', 'search-budget-exhausted');
    return null;
  }
  const path = findStandingPath(state.world.grid, person.position, episode.target);
  if (!path.length) {
    endLogisticsEpisode(project, episode, atMonth, 'invalidated', 'search-target-unreachable');
    return null;
  }
  const materialNames = episode.materialIds.slice(0, 3).map((materialId) => materialDefinition(materialId).name).join('、');
  return {
    key: `local-search-${episode.id}`,
    summary: `沿已固定的局部方向搜索${materialNames || '项目材料'}`,
    reason: '当前没有本人可执行的已知来源；目标只来自可见可达地形和项目缺料事实，并保持到抵达或预算耗尽',
    action: { kind: 'move', toCellId: episode.target.cellId, toZ: episode.target.z },
    sourceFactIds: [...episode.sourceEventIds],
    missingMaterialIds: [...episode.materialIds],
    materialDemands: episode.materialDemands ? structuredClone(episode.materialDemands) : undefined,
    reservations: [],
  };
}

function activeEpisodeStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  project: ProjectState,
  episode: ProjectLogisticsEpisode,
): ProjectStep | null {
  if (episode.kind === 'drop') return dropEpisodeStep(state, person, visibleDrops, project, episode);
  if (episode.kind === 'source') return sourceEpisodeStep(state, person, project, episode);
  return searchEpisodeStep(state, person, project, episode);
}

function knownRecipe(person: PersonState, outputMaterialId: MaterialId): { rule: InventoryCombinationRule; knowledgeId: string } | null {
  const rule = inventoryCombinationForOutput(outputMaterialId);
  if (!rule) return null;
  const knowledgeId = inventoryCombinationTechniqueId(rule);
  return person.knowledge.some((fact) => fact.id === knowledgeId && fact.confidence >= 55)
    ? { rule, knowledgeId }
    : null;
}

interface ReliableExertionTechnique {
  rule: ExertionRule;
  knowledgeId: string;
  sourceEventIds: string[];
}

interface ReliableExposureTechnique {
  rule: ExposureRule;
  knowledgeId: string;
  sourceEventIds: string[];
}

function reliableExertionTechniques(person: PersonState): ReliableExertionTechnique[] {
  return person.knowledge.flatMap((fact) => {
    if (fact.kind !== 'technique' || fact.confidence < 55) return [];
    const match = fact.id.match(/^technique:exert:(\d+):(\d+):(\d+):(\d+)$/);
    if (!match) return [];
    const [toolMaterialId, inputMaterialId, targetMaterialId, outputMaterialId] = match.slice(1).map(Number);
    if (![toolMaterialId, inputMaterialId, targetMaterialId, outputMaterialId].every(Number.isSafeInteger)) return [];
    const rule = exertionRuleFor(toolMaterialId, inputMaterialId, targetMaterialId);
    if (!rule || rule.outputMaterialId !== outputMaterialId || exertionTechniqueId(rule) !== fact.id) return [];
    return [{ rule, knowledgeId: fact.id, sourceEventIds: [...fact.sourceEventIds] }];
  }).sort((left, right) => left.knowledgeId.localeCompare(right.knowledgeId));
}

function reliableExposureTechniques(person: PersonState): ReliableExposureTechnique[] {
  return person.knowledge.flatMap((fact) => {
    if (fact.kind !== 'technique' || fact.confidence < 55) return [];
    const match = fact.id.match(/^technique:expose:(\d+):(\d+):(\d+)$/);
    if (!match) return [];
    const [inputMaterialId, targetMaterialId, outputMaterialId] = match.slice(1).map(Number);
    if (![inputMaterialId, targetMaterialId, outputMaterialId].every(Number.isSafeInteger)) return [];
    const rule = exposureRuleFor(inputMaterialId, targetMaterialId);
    if (!rule || rule.outputMaterialId !== outputMaterialId || exposureTechniqueId(rule) !== fact.id) return [];
    return [{ rule, knowledgeId: fact.id, sourceEventIds: [...fact.sourceEventIds] }];
  }).sort((left, right) => left.knowledgeId.localeCompare(right.knowledgeId));
}

function reliableKnownRecipe(
  person: PersonState,
  outputFits: (materialId: MaterialId) => boolean,
): { rule: InventoryCombinationRule; knowledgeId: string } | null {
  for (const fact of person.knowledge) {
    if (fact.kind !== 'technique' || fact.confidence < 55) continue;
    const rule = inventoryCombinationRules().find((candidate) => inventoryCombinationTechniqueId(candidate) === fact.id);
    if (rule && outputFits(rule.output.materialId)) return { rule, knowledgeId: fact.id };
  }
  return null;
}

function stackRefsForRule(person: PersonState, rule: InventoryCombinationRule): Extract<WorldRef, { kind: 'inventory-stack' }>[] | null {
  const refs: Extract<WorldRef, { kind: 'inventory-stack' }>[] = [];
  for (const input of rule.inputs) {
    const stack = person.inventory.find((candidate) => candidate.materialId === input.materialId && candidate.quantity >= input.quantity);
    if (!stack) return null;
    for (let count = 0; count < input.quantity; count += 1) refs.push({ kind: 'inventory-stack', personId: person.id, stackId: stack.id });
  }
  return refs;
}

function compileKnownOutput(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  outputMaterialId: MaterialId,
  purpose: string,
  visited = new Set<MaterialId>(),
): ProjectStep | null {
  if (visited.has(outputMaterialId)) return null;
  visited.add(outputMaterialId);
  const known = knownRecipe(person, outputMaterialId);
  if (!known) return null;
  const knowledge = person.knowledge.find((fact) => fact.id === known.knowledgeId);
  const deficits = known.rule.inputs
    .filter((input) => inventoryQuantity(person, input.materialId) < input.quantity);
  const missing = deficits.map((input) => input.materialId);
  if (missing.length) {
    const drop = nearestDrop(state, person, visibleDrops, missing);
    if (drop) {
      const input = deficits.find((candidate) => candidate.materialId === drop.materialId);
      const demand = materialDemand(
        person,
        drop.materialId,
        input?.quantity ?? 1,
        `known-recipe:${known.rule.id}:${drop.materialId}`,
        knowledge?.sourceEventIds ?? [],
      );
      const step = dropStep(person, drop, purpose, demand);
      if (step) return { ...step, planKnowledgeId: known.knowledgeId, missingMaterialIds: missing };
    }
    for (const materialId of missing) {
      const nested = compileKnownOutput(state, person, visibleDrops, materialId, purpose, new Set(visited));
      if (nested) return { ...nested, missingMaterialIds: missing };
    }
    return null;
  }
  const refs = stackRefsForRule(person, known.rule);
  if (!refs) return null;
  const reservations = refs.flatMap((ref) => reservation(person, ref.stackId));
  return {
    key: `known-recipe-${known.rule.id}`,
    summary: `按已核验经验制作${materialDefinition(outputMaterialId).name}`,
    reason: '本人已经核验这项制作经验，并已持有所有前置材料',
    action: { kind: 'act', operation: 'combine', targets: refs },
    sourceFactIds: [...new Set([
      ...(knowledge?.sourceEventIds ?? []),
      ...refs.flatMap((ref) => person.inventory.find((stack) => stack.id === ref.stackId)?.sourceEventIds ?? []),
    ])],
    missingMaterialIds: [],
    reservations,
    planKnowledgeId: known.knowledgeId,
  };
}

function tentativeTechniqueStep(state: SimulationState, person: PersonState, project: ProjectState): ProjectStep | null {
  const pendingAttempt = [...(project.hypothesisCampaign?.attempts ?? [])].reverse().find((attempt) => (
    attempt.outcome === 'response'
      && !attempt.verifiedEventId
      && attempt.verificationLostAtMonth === undefined
      && attempt.techniqueId
      && attempt.responseRef
  ));
  if (pendingAttempt?.techniqueId && pendingAttempt.responseRef) {
    const responseRef = pendingAttempt.responseRef;
    const target: WorldRef = responseRef.kind === 'inventory-stack'
      ? { kind: 'inventory-stack', personId: person.id, stackId: responseRef.stackId }
      : { kind: 'voxel', position: { ...responseRef.position } };
    const reservations = responseRef.kind === 'inventory-stack'
      ? reservation(person, responseRef.stackId)
      : [];
    return {
      key: `verify-response-${pendingAttempt.eventId}`,
      summary: `核验刚才产生的${materialDefinition(responseRef.materialId).name}`,
      reason: '真实响应先形成暂定经验；只有观察同一响应产生的实体，才能把它作为下一阶段的可靠依据',
      action: {
        kind: 'attend',
        target,
        verification: {
          techniqueId: pendingAttempt.techniqueId,
          sourceEventId: pendingAttempt.eventId,
          expectedMaterialId: responseRef.materialId,
        },
      },
      target,
      sourceFactIds: [...new Set([pendingAttempt.eventId, ...pendingAttempt.sourceFactIds])],
      missingMaterialIds: [],
      reservations,
      planKnowledgeId: pendingAttempt.techniqueId,
    };
  }
  const tentative = person.knowledge.find((fact) => fact.kind === 'technique'
    && fact.confidence < 55
    && !project.techniqueDemonstrations?.some((basis) => basis.techniqueId === fact.id
      && fact.sourceEventIds.includes(basis.demonstrationEventId))
    && fact.sourceEventIds.some((eventId) => project.actionEventIds.includes(eventId)));
  if (!tentative) return null;
  const source = tentative.sourceEventIds.map((eventId) => worldEventById(state, eventId)).find((event) => event?.kind === 'action');
  if (!source || source.kind !== 'action') return null;
  const outputStackId = typeof source.diff.outputStackId === 'string' ? source.diff.outputStackId : undefined;
  const stack = outputStackId ? person.inventory.find((candidate) => candidate.id === outputStackId) : undefined;
  const position = source.diff.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
  const expectedOutput = Number(source.diff.outputMaterialId);
  const worldOutputStillPresent = [position?.x, position?.y, position?.z].every((value) => Number.isInteger(value))
    && voxelAt(state.world.grid, Number(position?.x), Number(position?.y), Number(position?.z)) === expectedOutput;
  const target: WorldRef | undefined = stack
    ? { kind: 'inventory-stack', personId: person.id, stackId: stack.id }
    : worldOutputStillPresent
      ? { kind: 'voxel', position: { x: Number(position?.x), y: Number(position?.y), z: Number(position?.z) } }
      : undefined;
  if (!target) return null;
  return {
    key: `verify-${tentative.id}`,
    summary: `复查项目试验“${tentative.summary}”`,
    reason: '一次变化只形成暂定经验，项目继续前需要本人观察核验',
    action: { kind: 'attend', target },
    target,
    sourceFactIds: [...tentative.sourceEventIds],
    missingMaterialIds: [],
    reservations: stack ? reservation(person, stack.id) : [],
    planKnowledgeId: tentative.id,
  };
}

function inventorySourceKey(person: PersonState, stack: ItemStack): string {
  return `inventory:${person.id}:${stack.id}`;
}

function dropSourceKey(drop: DropState): string {
  return `drop:${drop.id}`;
}

interface CandidateInventorySlot {
  materialId: MaterialId;
  sourceKey?: string;
}

function assignCandidateSource(
  slots: CandidateInventorySlot[],
  materialId: MaterialId | undefined,
  sourceKey: string | undefined,
): void {
  if (materialId === undefined || !sourceKey) return;
  const slot = slots.find((candidate) => candidate.materialId === materialId && candidate.sourceKey === undefined);
  if (slot) slot.sourceKey = sourceKey;
}

function pairSlots(candidate: ProjectHypothesisCandidate): CandidateInventorySlot[] {
  const slots = candidate.materialIds.map((materialId) => ({ materialId }));
  assignCandidateSource(
    slots,
    candidate.toolRoleMaterialId ?? candidate.toolMaterialId,
    candidate.toolSourceKey,
  );
  assignCandidateSource(
    slots,
    candidate.inputRoleMaterialId ?? candidate.inputMaterialId,
    candidate.inputSourceKey,
  );
  return slots;
}

function stacksForCandidateSlots(
  person: PersonState,
  slots: CandidateInventorySlot[],
  groundedDropSourceKeys: ReadonlySet<string>,
): ItemStack[] | null {
  const selected: Array<ItemStack | undefined> = new Array(slots.length);
  const usedQuantities = new Map<string, number>();
  const available = (stack: ItemStack): boolean => stack.quantity > (usedQuantities.get(stack.id) ?? 0);
  const take = (index: number, stack: ItemStack): void => {
    selected[index] = stack;
    usedQuantities.set(stack.id, (usedQuantities.get(stack.id) ?? 0) + 1);
  };

  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    if (!slot.sourceKey) continue;
    const exact = person.inventory.find((stack) => stack.materialId === slot.materialId
      && inventorySourceKey(person, stack) === slot.sourceKey
      && available(stack));
    if (exact) take(index, exact);
  }
  for (let index = 0; index < slots.length; index += 1) {
    if (selected[index]) continue;
    const slot = slots[index];
    if (slot.sourceKey && groundedDropSourceKeys.has(slot.sourceKey)) return null;
    const fallback = person.inventory.find((stack) => stack.materialId === slot.materialId && available(stack));
    if (!fallback) return null;
    take(index, fallback);
  }
  return selected.every((stack): stack is ItemStack => Boolean(stack)) ? selected : null;
}

function refsForPair(
  person: PersonState,
  candidate: ProjectHypothesisCandidate,
  groundedDropSourceKeys: ReadonlySet<string>,
): Extract<WorldRef, { kind: 'inventory-stack' }>[] | null {
  const stacks = stacksForCandidateSlots(person, pairSlots(candidate), groundedDropSourceKeys);
  return stacks?.map((stack) => ({
    kind: 'inventory-stack' as const,
    personId: person.id,
    stackId: stack.id,
  })) ?? null;
}

function sourceEventIdsForTarget(
  state: SimulationState,
  project: ProjectState,
  position: { x: number; y: number; z: number },
  materialId: MaterialId,
): string[] {
  return project.actionEventIds.filter((eventId) => {
    const event = worldEventById(state, eventId);
    if (event?.kind !== 'action' || event.status !== 'completed') return false;
    const outputPosition = event.diff.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
    return Number(event.diff.outputMaterialId) === materialId
      && outputPosition?.x === position.x
      && outputPosition?.y === position.y
      && outputPosition?.z === position.z;
  });
}

function refsForExertCandidate(
  person: PersonState,
  candidate: ProjectHypothesisCandidate,
  groundedDropSourceKeys: ReadonlySet<string>,
): { toolStackId: string; inputRef: Extract<WorldRef, { kind: 'inventory-stack' }> } | null {
  const toolMaterialId = candidate.toolMaterialId ?? candidate.materialIds[0];
  const inputMaterialId = candidate.inputMaterialId ?? candidate.materialIds[1];
  const stacks = stacksForCandidateSlots(person, [
    { materialId: toolMaterialId, ...(candidate.toolSourceKey ? { sourceKey: candidate.toolSourceKey } : {}) },
    { materialId: inputMaterialId, ...(candidate.inputSourceKey ? { sourceKey: candidate.inputSourceKey } : {}) },
  ], groundedDropSourceKeys);
  if (!stacks) return null;
  return {
    toolStackId: stacks[0].id,
    inputRef: { kind: 'inventory-stack', personId: person.id, stackId: stacks[1].id },
  };
}

function inventorySlotsForCandidate(candidate: ProjectHypothesisCandidate): CandidateInventorySlot[] {
  if (candidate.operation === 'combine-inventory') return pairSlots(candidate);
  if (candidate.operation === 'exert-air') return [
    {
      materialId: candidate.toolMaterialId ?? candidate.materialIds[0],
      ...(candidate.toolSourceKey ? { sourceKey: candidate.toolSourceKey } : {}),
    },
    {
      materialId: candidate.inputMaterialId ?? candidate.materialIds[1],
      ...(candidate.inputSourceKey ? { sourceKey: candidate.inputSourceKey } : {}),
    },
  ];
  return [{
    materialId: candidate.inputMaterialId ?? candidate.materialIds[0],
    ...(candidate.inputSourceKey ? { sourceKey: candidate.inputSourceKey } : {}),
  }];
}

function projectRetrievedDrop(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  dropId: string,
): boolean {
  return project.actionEventIds.some((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action'
      && event.status === 'completed'
      && event.who === person.id
      && event.action.kind === 'transfer'
      && event.action.from.kind === 'ground'
      && event.action.to.kind === 'person'
      && event.action.to.personId === person.id
      && event.action.dropId === dropId;
  });
}

function groundedDropSourceKeysForCandidate(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  candidate: ProjectHypothesisCandidate,
  reachableDrops: DropState[],
): Set<string> {
  const candidateKeys = new Set(inventorySlotsForCandidate(candidate)
    .map((slot) => slot.sourceKey)
    .filter((sourceKey): sourceKey is string => Boolean(sourceKey)));
  return new Set(reachableDrops
    .filter((drop) => candidateKeys.has(dropSourceKey(drop))
      && !projectRetrievedDrop(state, person, project, drop.id))
    .map(dropSourceKey));
}

function groundedCandidateDrop(
  candidate: ProjectHypothesisCandidate,
  reachableDrops: DropState[],
  groundedDropSourceKeys: ReadonlySet<string>,
): { drop: DropState; quantity: number } | null {
  for (const drop of reachableDrops) {
    const sourceKey = dropSourceKey(drop);
    if (!groundedDropSourceKeys.has(sourceKey)) continue;
    const quantity = inventorySlotsForCandidate(candidate).filter((slot) => slot.sourceKey === sourceKey).length;
    if (quantity > 0) return { drop, quantity };
  }
  return null;
}

function hypothesisStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  project: ProjectState,
  request: ProjectHypothesisRequest = { operation: 'combine-inventory' },
  targetPosition?: { x: number; y: number; z: number },
): ProjectStep | null {
  const reachableDrops = visibleDrops.filter((drop) => findStandingPath(
    state.world.grid,
    person.position,
    { cellId: drop.cellId, z: drop.z },
  ).length > 0);
  const purpose = project.summary;
  const candidate = nextProjectHypothesisCandidate(
    state.seed,
    state.clock.elapsedMonths + 1,
    person,
    project,
    reachableDrops,
    request,
  );
  if (!candidate) return null;
  const pair = candidate.materialIds;
  const groundedDropSourceKeys = groundedDropSourceKeysForCandidate(
    state,
    person,
    project,
    candidate,
    reachableDrops,
  );
  if (candidate.operation === 'combine-inventory') {
    const refs = refsForPair(person, candidate, groundedDropSourceKeys);
    if (refs) return {
      key: `hypothesis-${candidate.key}`,
      summary: `为${purpose}试验${materialDefinition(pair[0]).name}与${materialDefinition(pair[1]).name}`,
      reason: candidate.reasonKeys.includes('verified-response-material')
        ? '本人刚核验了一种真实物质变化；把新物质放进下一次有限试验，观察它是否带来新的响应'
        : '当前困境与本人已经接触到的物质性质形成一个有限的局部假设；世界是否响应仍未知',
      action: { kind: 'act', operation: 'combine', targets: refs },
      sourceFactIds: [...candidate.sourceFactIds],
      missingMaterialIds: [],
      reservations: refs.flatMap((ref) => reservation(person, ref.stackId)),
    };
  }
  if (candidate.operation === 'exert-air' && targetPosition) {
    const exert = refsForExertCandidate(person, candidate, groundedDropSourceKeys);
    if (exert) return {
      key: `hypothesis-${candidate.key}`,
      summary: `为${purpose}尝试用${materialDefinition(candidate.toolMaterialId ?? pair[0]).name}向${materialDefinition(candidate.inputMaterialId ?? pair[1]).name}施力`,
      reason: '已持有的硬物、可触及材料和眼前受支撑的空位形成局部施力假设；结果仍由真实物质响应裁决',
      action: {
        kind: 'act',
        operation: 'exert',
        toolStackId: exert.toolStackId,
        targets: [exert.inputRef, { kind: 'voxel', position: targetPosition }],
      },
      target: { kind: 'voxel', position: targetPosition },
      sourceFactIds: [...candidate.sourceFactIds],
      missingMaterialIds: [],
      reservations: [
        ...reservation(person, exert.toolStackId),
        ...reservation(person, exert.inputRef.stackId),
      ],
    };
  }
  if (candidate.operation === 'expose-local' && targetPosition) {
    const inputMaterialId = candidate.inputMaterialId ?? pair[0];
    const input = stacksForCandidateSlots(person, [{
      materialId: inputMaterialId,
      ...(candidate.inputSourceKey ? { sourceKey: candidate.inputSourceKey } : {}),
    }], groundedDropSourceKeys)?.[0];
    if (input) return {
      key: `hypothesis-${candidate.key}`,
      summary: `为${purpose}让${materialDefinition(inputMaterialId).name}接触眼前的${materialDefinition(candidate.targetMaterialId ?? pair[1]).name}`,
      reason: '这个热源已经真实存在于近旁；人物只试验手中物质与它接触后的可观察变化，不预知产物',
      action: {
        kind: 'act',
        operation: 'expose',
        targets: [
          { kind: 'inventory-stack', personId: person.id, stackId: input.id },
          { kind: 'voxel', position: targetPosition },
        ],
      },
      target: { kind: 'voxel', position: targetPosition },
      sourceFactIds: [...candidate.sourceFactIds],
      missingMaterialIds: [],
      reservations: reservation(person, input.id),
    };
  }
  const exactDrop = groundedCandidateDrop(candidate, reachableDrops, groundedDropSourceKeys);
  if (exactDrop) {
    const demand = materialDemand(
      person,
      exactDrop.drop.materialId,
      inventoryQuantity(person, exactDrop.drop.materialId) + exactDrop.quantity,
      `hypothesis-source:${candidate.operation}:${candidate.key}:${exactDrop.drop.id}`,
      candidate.sourceFactIds,
    );
    const step = dropStep(person, exactDrop.drop, purpose, demand);
    if (step) return { ...step, missingMaterialIds: [exactDrop.drop.materialId] };
  }
  const quantities = new Map<MaterialId, number>();
  if (candidate.operation === 'combine-inventory') {
    pair.forEach((materialId) => quantities.set(materialId, (quantities.get(materialId) ?? 0) + 1));
  } else {
    const inputMaterialId = candidate.inputMaterialId ?? pair[candidate.operation === 'exert-air' ? 1 : 0];
    quantities.set(inputMaterialId, 1);
  }
  const missing = [...quantities]
    .filter(([materialId, quantity]) => inventoryQuantity(person, materialId) < quantity)
    .map(([materialId]) => materialId);
  const drop = nearestDrop(state, person, reachableDrops, missing);
  if (!drop) return null;
  const demand = materialDemand(
    person,
    drop.materialId,
    quantities.get(drop.materialId) ?? 1,
    `hypothesis:${candidate.operation}:${candidate.key}:${drop.materialId}`,
    candidate.sourceFactIds,
  );
  const step = dropStep(person, drop, purpose, demand);
  return step ? { ...step, missingMaterialIds: missing } : null;
}

interface ProjectMaterialRequirement {
  materialIds: MaterialId[];
  demands: ProjectMaterialDemand[];
  sourceEventIds: string[];
  planKnowledgeId?: string;
}

function knownOutputRequirement(
  person: PersonState,
  outputMaterialId: MaterialId,
  visited = new Set<MaterialId>(),
): ProjectMaterialRequirement | null {
  if (visited.has(outputMaterialId)) return null;
  visited.add(outputMaterialId);
  const known = knownRecipe(person, outputMaterialId);
  if (!known) return null;
  const knowledge = person.knowledge.find((fact) => fact.id === known.knowledgeId);
  const demands: ProjectMaterialDemand[] = [];
  const sourceEventIds = [...(knowledge?.sourceEventIds ?? [])];
  for (const input of known.rule.inputs) {
    if (inventoryQuantity(person, input.materialId) >= input.quantity) continue;
    const nested = knownOutputRequirement(person, input.materialId, new Set(visited));
    if (nested?.demands.length) {
      demands.push(...nested.demands);
      sourceEventIds.push(...nested.sourceEventIds);
    } else {
      demands.push(materialDemand(
        person,
        input.materialId,
        input.quantity,
        `known-requirement:${known.rule.id}:${input.materialId}`,
        knowledge?.sourceEventIds ?? [],
      ));
    }
  }
  return {
    materialIds: [...new Set(demands.filter((demand) => demand.outstandingQuantity > 0).map((demand) => demand.materialId))],
    demands: demands.filter((demand) => demand.outstandingQuantity > 0),
    sourceEventIds: [...new Set(sourceEventIds)],
    planKnowledgeId: known.knowledgeId,
  };
}

function exertionInputQuantities(rule: ExertionRule): Map<MaterialId, number> {
  const quantities = new Map<MaterialId, number>();
  quantities.set(rule.toolMaterialId, (quantities.get(rule.toolMaterialId) ?? 0) + 1);
  quantities.set(rule.inputMaterialId, (quantities.get(rule.inputMaterialId) ?? 0) + 1);
  return quantities;
}

function knownExertionRequirement(
  person: PersonState,
  technique: ReliableExertionTechnique,
): ProjectMaterialRequirement | null {
  const demands: ProjectMaterialDemand[] = [];
  const sourceEventIds = [...technique.sourceEventIds];
  for (const [materialId, quantity] of exertionInputQuantities(technique.rule)) {
    if (inventoryQuantity(person, materialId) >= quantity) continue;
    const nested = knownOutputRequirement(person, materialId);
    if (nested?.demands.length) {
      demands.push(...nested.demands);
      sourceEventIds.push(...nested.sourceEventIds);
      continue;
    }
    demands.push(materialDemand(
      person,
      materialId,
      quantity,
      `known-exertion:${technique.rule.id}:${materialId}`,
      technique.sourceEventIds,
    ));
  }
  const outstanding = demands.filter((demand) => demand.outstandingQuantity > 0);
  return outstanding.length ? {
    materialIds: [...new Set(outstanding.map((demand) => demand.materialId))],
    demands: outstanding,
    sourceEventIds: [...new Set(sourceEventIds)],
    planKnowledgeId: technique.knowledgeId,
  } : null;
}

function blankRecordCarrier(person: PersonState): ItemStack | undefined {
  return person.inventory.find((stack) => stack.quantity > 0
    && !stack.recordPayloadId
    && materialHas(stack.materialId, 'recordable'));
}

function reliableHeatTechnique(person: PersonState): ReliableExertionTechnique | undefined {
  return reliableExertionTechniques(person).find((technique) => technique.rule.outputLocation === 'world'
    && materialHas(technique.rule.outputMaterialId, 'hot'));
}

function reliableRecordCarrierTechnique(person: PersonState): ReliableExertionTechnique | undefined {
  return reliableExertionTechniques(person).find((technique) => technique.rule.outputLocation === 'inventory'
    && materialHas(technique.rule.outputMaterialId, 'recordable'));
}

function reliableRecordCarrierRecipe(person: PersonState): { rule: InventoryCombinationRule; knowledgeId: string } | null {
  return reliableKnownRecipe(person, (materialId) => materialHas(materialId, 'recordable'));
}

function reliableMissingManipulatorRecipe(person: PersonState): { rule: InventoryCombinationRule; knowledgeId: string } | null {
  return reliableKnownRecipe(person, (materialId) => materialHas(materialId, 'tool')
    && inventoryQuantity(person, materialId) === 0);
}

function projectMaterialRequirement(state: SimulationState, person: PersonState, project: ProjectState): ProjectMaterialRequirement | null {
  const rawRequirements = new Map<MaterialId, number>();
  const requireRaw = (materialId: MaterialId, quantity: number) => {
    if (inventoryQuantity(person, materialId) < quantity) rawRequirements.set(materialId, Math.max(
      rawRequirements.get(materialId) ?? 0, quantity,
    ));
  };
  if (project.desiredFunction === 'efficient-production') {
    requireRaw(Material.Wood, 1);
    if (inventoryQuantity(person, Material.Rope) === 0) requireRaw(Material.Fiber, 2);
  }
  if (project.desiredFunction === 'settled-cultivation') {
    requireRaw(Material.Seed, 1);
  }
  if (project.desiredFunction === 'community-coordination') {
    if (inventoryQuantity(person, Material.Plank) === 0) requireRaw(Material.Wood, 2);
    if (inventoryQuantity(person, Material.Rope) === 0) requireRaw(Material.Fiber, 2);
  }
  if (project.desiredFunction === 'reserve-storage' || project.desiredFunction === 'reliable-water') {
    const hasContainer = inventoryQuantity(person, Material.Container) > 0
      || state.containers.some((container) => locallyKnownPlacedContainer(state, person, container));
    if (project.desiredFunction === 'reserve-storage') {
      if (!hasContainer && inventoryQuantity(person, Material.Plank) < 3) requireRaw(Material.Wood, 4);
      if (hasContainer && inventoryQuantity(person, Material.Plank) < 1) requireRaw(Material.Wood, 2);
    } else {
      if (!hasContainer && inventoryQuantity(person, Material.Plank) < 2) requireRaw(Material.Wood, 2);
      requireRaw(Material.Stone, 1);
    }
  }
  if (project.desiredFunction === 'crop-processing') {
    requireRaw(Material.Stone, 1);
    if (inventoryQuantity(person, Material.Plank) === 0) requireRaw(Material.Wood, 2);
  }
  if (project.desiredFunction === 'high-heat-processing') {
    requireRaw(Material.Clay, 1);
    requireRaw(Material.Stone, 1);
  }
  if (project.desiredFunction === 'copper-charge' || project.desiredFunction === 'tin-charge') {
    requireRaw(project.desiredFunction === 'copper-charge' ? Material.CopperOre : Material.TinOre, 1);
    if (inventoryQuantity(person, Material.Charcoal) === 0) {
      requireRaw(Material.Charcoal, 1);
      // A fixed kiln can turn ordinary wood into the missing charcoal; keeping
      // wood as a separate demand lets a contributor or visible source supply it.
      requireRaw(Material.Wood, 1);
    }
  }
  if (project.desiredFunction === 'copper-smelting') requireRaw(Material.CopperCharge, 1);
  if (project.desiredFunction === 'tin-smelting') requireRaw(Material.TinCharge, 1);
  if (project.desiredFunction === 'bronze-alloying') {
    requireRaw(Material.Copper, 1);
    requireRaw(Material.Tin, 1);
  }
  if (project.desiredFunction === 'bronze-tooling') {
    requireRaw(Material.Bronze, 1);
    requireRaw(Material.Wood, 1);
  }
  if (project.desiredFunction === 'bronze-workshop') {
    requireRaw(Material.Bronze, 1);
    requireRaw(Material.Stone, 1);
  }
  const rawDemands = [...rawRequirements].map(([materialId, quantity]) => materialDemand(
    person, materialId, quantity, `development-subassembly:${project.desiredFunction}:${materialId}`,
  )).filter((demand) => demand.outstandingQuantity > 0);
  if (rawDemands.length) return {
    materialIds: rawDemands.map((demand) => demand.materialId),
    demands: rawDemands,
    sourceEventIds: [...new Set(project.triggerFactIds)],
  };
  if (project.desiredFunction === 'weather-shelter') {
    if (buildingStack(person)) return null;
    return {
      materialIds: [Material.Stone, Material.Wood, Material.Plank],
      demands: [Material.Stone, Material.Wood, Material.Plank].map((materialId) => materialDemand(
        person, materialId, 1, `shelter-building-substitute:${materialId}`,
      )),
      sourceEventIds: [],
    };
  }
  if (project.desiredFunction === 'prepared-food') {
    const raw = person.inventory.find((stack) => stack.quantity > 0
      && (stack.materialId === Material.RawMeat || stack.materialId === Material.Food));
    if (!raw) return {
      materialIds: [Material.RawMeat, Material.Food],
      demands: [Material.RawMeat, Material.Food].map((materialId) => materialDemand(
        person, materialId, 1, `prepared-food-input-substitute:${materialId}`,
      )),
      sourceEventIds: [],
    };
    const knownHeat = reliableHeatTechnique(person);
    if (knownHeat) return knownExertionRequirement(person, knownHeat);
    const knownManipulator = reliableMissingManipulatorRecipe(person);
    if (knownManipulator) return knownOutputRequirement(person, knownManipulator.rule.output.materialId);
    return null;
  }
  if (project.desiredFunction === 'durable-record') {
    if (blankRecordCarrier(person)) return null;
    const knownCarrierRecipe = reliableRecordCarrierRecipe(person);
    if (knownCarrierRecipe) return knownOutputRequirement(person, knownCarrierRecipe.rule.output.materialId);
    const knownCarrierTechnique = reliableRecordCarrierTechnique(person);
    if (knownCarrierTechnique) return knownExertionRequirement(person, knownCarrierTechnique);
    const knownManipulator = reliableMissingManipulatorRecipe(person);
    if (knownManipulator) return knownOutputRequirement(person, knownManipulator.rule.output.materialId);
    return null;
  }
  for (const output of completedFunctionMaterialIds(project)) {
    const known = knownOutputRequirement(person, output);
    if (known?.materialIds.length) return known;
  }
  return null;
}

interface LocalVoxelTarget {
  position: { x: number; y: number; z: number };
  materialId: MaterialId;
}

function adjacentSupportedTarget(
  state: SimulationState,
  person: PersonState,
  targetFits: (materialId: MaterialId) => boolean,
): LocalVoxelTarget | null {
  for (const cellId of [...neighbors4(person.position.cellId)].sort((left, right) => left - right)) {
    const position = { x: cellX(cellId), y: cellY(cellId), z: person.position.z };
    const supportMaterialId = voxelAt(state.world.grid, position.x, position.y, position.z - 1);
    const targetMaterialId = voxelAt(state.world.grid, position.x, position.y, position.z);
    if (materialDefinition(supportMaterialId).phase === 'solid' && targetFits(targetMaterialId)) {
      return { position, materialId: targetMaterialId };
    }
  }
  return null;
}

function localOpenExertionTarget(state: SimulationState, person: PersonState): LocalVoxelTarget | null {
  return adjacentSupportedTarget(state, person, (materialId) => materialHas(materialId, 'air'));
}

function visiblePlacementApproach(
  state: SimulationState,
  person: PersonState,
): StandingPosition | null {
  const visible = new Set(visibleCellsFor(person));
  return [...visible].flatMap((cellId) => standingPositions(state.world.grid, cellId))
    .flatMap((position) => {
      const hasOpenSide = neighbors4(position.cellId).some((targetCellId) => {
        const x = cellX(targetCellId);
        const y = cellY(targetCellId);
        const targetMaterialId = voxelAt(state.world.grid, x, y, position.z);
        const supportMaterialId = voxelAt(state.world.grid, x, y, position.z - 1);
        const occupied = state.people.some((candidate) => isAlive(candidate)
          && candidate.position.cellId === targetCellId
          && candidate.position.z === position.z);
        return materialHas(targetMaterialId, 'air')
          && materialDefinition(supportMaterialId).phase === 'solid'
          && !occupied;
      });
      if (!hasOpenSide) return [];
      const path = findStandingPath(state.world.grid, person.position, position);
      return path.length > 1 ? [{ position, pathLength: path.length - 1 }] : [];
    })
    .sort((left, right) => left.pathLength - right.pathLength
      || left.position.cellId - right.position.cellId
      || left.position.z - right.position.z)[0]?.position ?? null;
}

function localTargetForKnownExertion(
  state: SimulationState,
  person: PersonState,
  rule: ExertionRule,
): LocalVoxelTarget | null {
  return adjacentSupportedTarget(state, person, (materialId) => materialId === rule.targetMaterialId);
}

function localHotTarget(state: SimulationState, person: PersonState): LocalVoxelTarget | null {
  return cellsInRadius(person.position.cellId, 1)
    .map((cellId) => {
      const position = topPosition(state.world.grid, cellId);
      const materialId = voxelAt(state.world.grid, position.x, position.y, position.z);
      return { position, materialId };
    })
    .filter((target) => materialHas(target.materialId, 'hot'))
    .sort((left, right) => left.position.x - right.position.x
      || left.position.y - right.position.y
      || left.position.z - right.position.z)[0] ?? null;
}

function combineSubassemblyStep(
  person: PersonState,
  firstMaterialId: MaterialId,
  secondMaterialId: MaterialId,
  outputName: string,
  purpose: string,
): ProjectStep | null {
  const first = person.inventory.find((stack) => stack.materialId === firstMaterialId
    && stack.quantity >= (firstMaterialId === secondMaterialId ? 2 : 1));
  const second = firstMaterialId === secondMaterialId
    ? first
    : person.inventory.find((stack) => stack.materialId === secondMaterialId && stack.quantity > 0);
  if (!first || !second) return null;
  return {
    key: `project-subassembly-${firstMaterialId}-${secondMaterialId}-${first.id}-${second.id}`,
    summary: `为${purpose}先尝试制作${outputName}`,
    reason: '压力已经形成长期项目；人物按手中材料的可见形状与既有加工经验制作必要子组件，实体规则仍决定是否产生响应',
    action: {
      kind: 'act', operation: 'combine', targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: first.id },
        { kind: 'inventory-stack', personId: person.id, stackId: second.id },
      ],
    },
    sourceFactIds: [...new Set([...first.sourceEventIds, ...second.sourceEventIds])],
    missingMaterialIds: [],
    reservations: [
      ...reservation(person, first.id),
      ...reservation(person, second.id),
    ],
  };
}

function developmentSubassemblyStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): ProjectStep | null {
  const needsRope = ['efficient-production', 'community-coordination'].includes(project.desiredFunction);
  if (needsRope && inventoryQuantity(person, Material.Rope) === 0) {
    const rope = combineSubassemblyStep(person, Material.Fiber, Material.Fiber, '绳索', project.summary);
    if (rope) return rope;
  }
  const needsPlank = [
    'community-coordination', 'reserve-storage', 'reliable-water', 'crop-processing',
    'workshop-production',
  ].includes(project.desiredFunction);
  const requiredPlanks = ['reserve-storage', 'reliable-water'].includes(project.desiredFunction)
    && !state.containers.some((container) => locallyKnownPlacedContainer(state, person, container))
    && inventoryQuantity(person, Material.Container) === 0
    ? project.desiredFunction === 'reserve-storage' ? 3 : 2
    : project.desiredFunction === 'reserve-storage' ? 1 : 0;
  if (needsPlank && inventoryQuantity(person, Material.Plank) < requiredPlanks) {
    const plank = combineSubassemblyStep(person, Material.Wood, Material.Wood, '木板', project.summary);
    if (plank) return plank;
  }
  const needsTablet = ['workshop-production', 'civic-coordination'].includes(project.desiredFunction);
  if (needsTablet && inventoryQuantity(person, Material.WoodTablet) === 0) {
    const tool = person.inventory.find((stack) => stack.materialId === Material.StoneTool && stack.quantity > 0);
    const wood = person.inventory.find((stack) => stack.materialId === Material.Wood && stack.quantity > 0);
    const target = tool && wood ? localOpenExertionTarget(state, person) : null;
    if (tool && wood && target) return {
      key: `project-subassembly-tablet-${tool.id}-${wood.id}`,
      summary: `为${project.summary}先制作可记录的木牍`,
      reason: '固定工坊和公共厅堂都需要可携带的记录载体，人物使用已经在手的硬质工具和木料尝试加工',
      action: {
        kind: 'act', operation: 'exert', toolStackId: tool.id,
        targets: [
          { kind: 'inventory-stack', personId: person.id, stackId: wood.id },
          { kind: 'voxel', position: target.position },
        ],
      },
      target: { kind: 'voxel', position: target.position },
      sourceFactIds: [...new Set([...tool.sourceEventIds, ...wood.sourceEventIds])],
      missingMaterialIds: [],
      reservations: [...reservation(person, tool.id), ...reservation(person, wood.id)],
    };
  }
  return null;
}

function containerUpgradeStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): ProjectStep | null {
  const inputMaterialId = project.desiredFunction === 'reserve-storage'
    ? Material.Plank
    : project.desiredFunction === 'reliable-water'
      ? Material.Stone
      : undefined;
  if (inputMaterialId === undefined) return null;
  const carriedContainer = person.inventory.find((candidate) => candidate.materialId === Material.Container && candidate.quantity > 0);
  const stack = person.inventory.find((candidate) => candidate.materialId === inputMaterialId && candidate.quantity > 0);
  if (carriedContainer && stack) {
    return {
      key: `prepare-container-upgrade-${carriedContainer.id}-${stack.id}`,
      summary: `用${materialDefinition(inputMaterialId).name}加固木制容器，准备设置为${project.desiredFunction === 'reserve-storage' ? '公共谷仓' : '蓄水井'}`,
      reason: '公共设施仍要经过真实容器和结构材料两项前置；先完成可携带构件，随后必须把成品设置到实体空间才产生功能',
      action: {
        kind: 'act', operation: 'combine', targets: [
          { kind: 'inventory-stack', personId: person.id, stackId: carriedContainer.id },
          { kind: 'inventory-stack', personId: person.id, stackId: stack.id },
        ],
      },
      sourceFactIds: [...new Set([...carriedContainer.sourceEventIds, ...stack.sourceEventIds])],
      missingMaterialIds: [],
      reservations: [...reservation(person, carriedContainer.id), ...reservation(person, stack.id)],
    };
  }
  const hasPlacedContainer = state.containers.some((container) => locallyKnownPlacedContainer(state, person, container));
  const plankStack = person.inventory.find((candidate) => candidate.materialId === Material.Plank && candidate.quantity >= 2);
  if (!hasPlacedContainer && plankStack) return {
    key: `make-container-for-upgrade-${plankStack.id}`,
    summary: '先把两份木板结合成公共设施所需的木制容器',
    reason: '项目不会绕过容器前置；人口或缺水压力只让人物主动解决这个可观察的结构缺口',
    action: {
      kind: 'act', operation: 'combine', targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: plankStack.id },
        { kind: 'inventory-stack', personId: person.id, stackId: plankStack.id },
      ],
    },
    sourceFactIds: [...plankStack.sourceEventIds],
    missingMaterialIds: [],
    reservations: reservation(person, plankStack.id, 2),
  };
  if (!stack) return null;
  const candidates = state.containers.flatMap((container) => {
    if (!locallyKnownPlacedContainer(state, person, container)) return [];
    const containerCell = container.position.x + container.position.y * state.world.grid.width;
    const access = neighbors4(containerCell).flatMap((cellId) => standingPositions(state.world.grid, cellId))
      .map((position) => ({ position, path: findStandingPath(state.world.grid, person.position, position) }))
      .filter((candidate) => candidate.path.length > 0)
      .sort((left, right) => left.path.length - right.path.length || left.position.cellId - right.position.cellId)[0];
    return access ? [{ container, access }] : [];
  }).sort((left, right) => left.access.path.length - right.access.path.length);
  const selected = candidates[0];
  if (!selected) return null;
  const target = { ...selected.container.position };
  const horizontal = Math.abs(cellX(person.position.cellId) - target.x) + Math.abs(cellY(person.position.cellId) - target.y);
  const vertical = Math.max(0, Math.abs(person.position.z - target.z) - 1);
  if (Math.max(horizontal, vertical) > 1) return {
    key: `approach-container-upgrade-${selected.container.id}`,
    summary: `前往木制容器，将它改造为${project.desiredFunction === 'reserve-storage' ? '公共谷仓' : '蓄水井'}`,
    reason: '已有容器是真实的前置设施，项目先抵达它的可操作位置，再投入结构材料',
    action: { kind: 'move', toCellId: selected.access.position.cellId, toZ: selected.access.position.z },
    target: { kind: 'container', containerId: selected.container.id },
    sourceFactIds: [...new Set([...stack.sourceEventIds, ...selected.container.sourceEventIds])],
    missingMaterialIds: [],
    reservations: reservation(person, stack.id),
  };
  return {
    key: `upgrade-container-${selected.container.id}-${inputMaterialId}`,
    summary: `用${materialDefinition(inputMaterialId).name}把木制容器改造成${project.desiredFunction === 'reserve-storage' ? '公共谷仓' : '蓄水井'}`,
    reason: '人口和环境压力已经指向公共储备或供水；改造保留实体容器这一材料前置，而不是凭空生成建筑',
    action: {
      kind: 'act', operation: 'combine', targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: stack.id },
        { kind: 'voxel', position: target },
      ],
    },
    target: { kind: 'voxel', position: target },
    sourceFactIds: [...new Set([...stack.sourceEventIds, ...selected.container.sourceEventIds])],
    missingMaterialIds: [],
    reservations: reservation(person, stack.id),
  };
}

function reserveStockingStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  project: ProjectState,
): ProjectStep | null {
  if (project.desiredFunction !== 'reserve-storage') return null;
  const placement = placedFunctionEvidence(state, project)[0];
  const position = placement?.diff.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
  const container = placement ? state.containers.find((candidate) => candidate.position.x === Number(position?.x)
    && candidate.position.y === Number(position?.y)
    && candidate.position.z === Number(position?.z)) : undefined;
  if (!container) return null;
  const foodStack = person.inventory
    .filter((stack) => stack.quantity > 0
      && (materialHas(stack.materialId, 'seed')
        || (materialHas(stack.materialId, 'edible') && person.body.nutrition >= 45)))
    .sort((left, right) => Number(materialHas(right.materialId, 'edible')) - Number(materialHas(left.materialId, 'edible'))
      || right.quantity - left.quantity
      || left.materialId - right.materialId)[0];
  if (foodStack) {
    const containerCellId = container.position.x + container.position.y * state.world.grid.width;
    const horizontal = Math.abs(cellX(person.position.cellId) - container.position.x)
      + Math.abs(cellY(person.position.cellId) - container.position.y);
    const vertical = Math.max(0, Math.abs(person.position.z - container.position.z) - 1);
    if (Math.max(horizontal, vertical) <= 1) return {
      key: `stock-project-granary-${container.id}-${foodStack.id}`,
      summary: `把${materialDefinition(foodStack.materialId).name}存入刚建成的公共谷仓`,
      reason: '谷仓只有开始承接真实粮食或种子，才算缓解了人口与天气压力；项目不会在空仓落成时提前完成',
      action: {
        kind: 'transfer', materialId: foodStack.materialId, quantity: 1,
        from: { kind: 'person', personId: person.id },
        to: { kind: 'container', containerId: container.id },
        stackId: foodStack.id,
      },
      target: { kind: 'container', containerId: container.id },
      sourceFactIds: [...new Set([placement.id, ...foodStack.sourceEventIds])],
      missingMaterialIds: [],
      reservations: reservation(person, foodStack.id),
    };
    const access = neighbors4(containerCellId)
      .flatMap((cellId) => standingPositions(state.world.grid, cellId))
      .map((candidate) => ({ candidate, path: findStandingPath(state.world.grid, person.position, candidate) }))
      .filter((candidate) => candidate.path.length > 0)
      .sort((left, right) => left.path.length - right.path.length
        || left.candidate.cellId - right.candidate.cellId
        || left.candidate.z - right.candidate.z)[0];
    if (access) return {
      key: `approach-project-granary-${container.id}`,
      summary: '把项目粮食带到刚建成的公共谷仓',
      reason: '谷仓是本人刚设置并仍有项目证据的固定地点；先抵达可操作位置，再执行真实转移',
      action: { kind: 'move', toCellId: access.candidate.cellId, toZ: access.candidate.z },
      target: { kind: 'container', containerId: container.id },
      sourceFactIds: [...new Set([placement.id, ...foodStack.sourceEventIds])],
      missingMaterialIds: [],
      reservations: reservation(person, foodStack.id),
    };
  }
  const foodDrop = nearestDrop(
    state,
    person,
    visibleDrops.filter((drop) => materialHas(drop.materialId, 'edible') || materialHas(drop.materialId, 'seed')),
    visibleDrops.map((drop) => drop.materialId),
  );
  return foodDrop ? dropStep(
    person,
    foodDrop,
    '给刚建成的公共谷仓形成第一批真实储备',
    materialDemand(person, foodDrop.materialId, 1, `stock-granary:${container.id}:${foodDrop.materialId}`, [placement.id]),
  ) : null;
}

function reliableTechniqueFacts(
  person: PersonState,
  desiredFunction: ProjectFunction,
): PersonState['knowledge'] {
  const outputs = new Map<string, MaterialId>([
    ...inventoryCombinationRules().map((rule) => [inventoryCombinationTechniqueId(rule), rule.output.materialId] as const),
    ...reliableExertionTechniques(person).map((technique) => [technique.knowledgeId, technique.rule.outputMaterialId] as const),
    ...reliableExposureTechniques(person).map((technique) => [technique.knowledgeId, technique.rule.outputMaterialId] as const),
  ]);
  const supportsFunction = (materialId: MaterialId): boolean => {
    if (desiredFunction === 'insulation') return materialHas(materialId, 'insulating');
    if (desiredFunction === 'safer-hunting') return materialHas(materialId, 'tool');
    if (desiredFunction === 'healing') return (materialDefinition(materialId).consume?.health ?? 0) > 0;
    if (desiredFunction === 'prepared-food') return materialId === Material.CookedFood || materialHas(materialId, 'hot');
    if (desiredFunction === 'durable-record') return materialHas(materialId, 'recordable');
    return completedFunctionMaterialIds({ desiredFunction }).includes(materialId);
  };
  return person.knowledge.filter((fact) => fact.kind === 'technique'
    && fact.confidence >= 55
    && outputs.has(fact.id)
    && supportsFunction(outputs.get(fact.id)!));
}

/**
 * Builds only positive, person-local opportunity evidence. A no-response fact
 * can remove a candidate elsewhere, but cannot make a later project look new.
 */
export function buildProjectInquiryOpportunityBasis(
  state: SimulationState,
  person: PersonState,
  desiredFunction: ProjectFunction,
  visibleDrops: DropState[] = visibleDropsFor(state, person),
  atMonth = state.clock.elapsedMonths + 1,
): ProjectInquiryOpportunityBasis {
  const materialSources = new Map<MaterialId, { sourceKey: string; sourceFactIds: string[] }>();
  for (const stack of [...person.inventory].filter((item) => item.quantity > 0)
    .sort((left, right) => left.materialId - right.materialId || left.id.localeCompare(right.id))) {
    if (!materialSources.has(stack.materialId)) materialSources.set(stack.materialId, {
      sourceKey: inventorySourceKey(person, stack),
      sourceFactIds: [...stack.sourceEventIds],
    });
  }
  for (const drop of [...visibleDrops].filter((item) => item.quantity > 0)
    .sort((left, right) => left.materialId - right.materialId || left.id.localeCompare(right.id))) {
    if (!materialSources.has(drop.materialId)) materialSources.set(drop.materialId, {
      sourceKey: dropSourceKey(drop),
      sourceFactIds: [...drop.sourceEventIds],
    });
  }
  const techniques = reliableTechniqueFacts(person, desiredFunction);
  const verifiedAttempts = state.projects
    .filter((project) => project.ownerId === person.id && project.desiredFunction === desiredFunction)
    .flatMap((project) => project.hypothesisCampaign?.attempts ?? [])
    .filter((attempt) => attempt.outcome === 'response'
      && Boolean(attempt.verifiedEventId)
      && Boolean(attempt.responseRef)
      && verifiedResponseEntityStillPresent(state, person, attempt.responseRef));
  const hotTarget = ['prepared-food', 'brick-firing', 'copper-smelting', 'tin-smelting', 'iron-reduction'].includes(desiredFunction)
    ? localHotTarget(state, person)
    : null;
  const targetSourceKeys = hotTarget
    ? [`voxel:${hotTarget.position.x}:${hotTarget.position.y}:${hotTarget.position.z}:${hotTarget.materialId}`]
    : [];
  const readyCarrier = desiredFunction === 'durable-record' ? blankRecordCarrier(person) : undefined;
  const readyCarrierSourceKey = readyCarrier ? inventorySourceKey(person, readyCarrier) : undefined;
  const materialIds = [...materialSources.keys()].sort((left, right) => left - right);
  const techniqueIds = [...new Set(techniques.map((fact) => fact.id))].sort();
  const verifiedResponseEventIds = [...new Set(verifiedAttempts
    .map((attempt) => attempt.verifiedEventId)
    .filter((eventId): eventId is string => Boolean(eventId)))].sort();
  const opportunityKeys = [
    ...materialIds.map((materialId) => `material:${materialId}`),
    ...techniqueIds.map((techniqueId) => `knowledge:${techniqueId}`),
    ...targetSourceKeys.map((sourceKey) => `target:${sourceKey}`),
    ...(readyCarrierSourceKey ? [`ready-record-carrier:${readyCarrierSourceKey}`] : []),
    ...verifiedResponseEventIds.map((eventId) => `response:${eventId}`),
  ].sort();
  const opportunitySources: ProjectInquiryOpportunitySource[] = [
    ...[...materialSources].map(([materialId, source]) => ({
      opportunityKey: `material:${materialId}`,
      kind: 'material' as const,
      materialId,
      sourceKeys: [source.sourceKey],
      sourceFactIds: [...source.sourceFactIds],
    })),
    ...techniques.map((fact) => ({
      opportunityKey: `knowledge:${fact.id}`,
      kind: 'knowledge' as const,
      sourceKeys: [`knowledge:${fact.id}`],
      sourceFactIds: [...fact.sourceEventIds],
    })),
    ...targetSourceKeys.map((sourceKey) => ({
      opportunityKey: `target:${sourceKey}`,
      kind: 'target' as const,
      ...(hotTarget ? { materialId: hotTarget.materialId } : {}),
      sourceKeys: [sourceKey],
      sourceFactIds: [],
    })),
    ...(readyCarrier && readyCarrierSourceKey ? [{
      opportunityKey: `ready-record-carrier:${readyCarrierSourceKey}`,
      kind: 'ready-record-carrier' as const,
      materialId: readyCarrier.materialId,
      sourceKeys: [readyCarrierSourceKey],
      sourceFactIds: [...readyCarrier.sourceEventIds],
    }] : []),
    ...verifiedAttempts.flatMap((attempt) => {
      if (!attempt.verifiedEventId || !attempt.responseRef) return [];
      const sourceKey = attempt.responseRef.kind === 'inventory-stack'
        ? `inventory:${person.id}:${attempt.responseRef.stackId}`
        : `voxel:${attempt.responseRef.position.x}:${attempt.responseRef.position.y}:${attempt.responseRef.position.z}:${attempt.responseRef.materialId}`;
      return [{
        opportunityKey: `response:${attempt.verifiedEventId}`,
        kind: 'verified-response' as const,
        materialId: attempt.responseRef.materialId,
        sourceKeys: [sourceKey],
        sourceFactIds: [attempt.eventId, attempt.verifiedEventId],
      }];
    }),
  ].sort((left, right) => left.opportunityKey.localeCompare(right.opportunityKey));
  return {
    version: 'project-inquiry-opportunity-basis-v1',
    actorId: person.id,
    desiredFunction,
    atMonth,
    materialIds,
    techniqueIds,
    targetSourceKeys,
    verifiedResponseEventIds,
    opportunityKeys,
    opportunitySources,
    sourceFactIds: [...new Set(opportunitySources.flatMap((source) => source.sourceFactIds))],
    sourceKeys: [...new Set(opportunitySources.flatMap((source) => source.sourceKeys))],
    basisKey: `${person.id}:${desiredFunction}:${opportunityKeys.join('|')}`,
    inheritedProjectIds: [],
    renewalKeys: [],
  };
}

function failedInquiryProjects(
  state: SimulationState,
  person: PersonState,
  desiredFunction: ProjectFunction,
): ProjectState[] {
  return state.projects.filter((project) => project.ownerId === person.id
    && project.desiredFunction === desiredFunction
    && project.status === 'blocked'
    && Boolean(project.hypothesisCampaign?.attempts.length));
}

function exploredOpportunityKeys(project: ProjectState): string[] {
  const stored = project.terminalInquiryOpportunityBasis ?? project.inquiryOpportunityBasis;
  if (stored) return [...stored.opportunityKeys];
  return [
    ...(project.hypothesisCampaign?.observedMaterialIds ?? []).map((materialId) => `material:${materialId}`),
    ...(project.hypothesisCampaign?.attempts ?? []).flatMap((attempt) => attempt.verifiedEventId
      ? [`response:${attempt.verifiedEventId}`]
      : []),
    ...(project.planKnowledgeId ? [`knowledge:${project.planKnowledgeId}`] : []),
  ];
}

function proposalWithInquiryOpportunityMemory(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  candidate: ProjectProposal,
): ProjectProposal | null {
  if (candidate.kind === 'construction') return candidate;
  const basis = buildProjectInquiryOpportunityBasis(
    state,
    person,
    candidate.desiredFunction,
    visibleDrops,
    candidate.createdAtMonth,
  );
  const prior = failedInquiryProjects(state, person, candidate.desiredFunction);
  const explored = new Set(prior.flatMap(exploredOpportunityKeys));
  const renewalKeys = basis.opportunityKeys.filter((key) => !explored.has(key));
  if (prior.length > 0 && renewalKeys.length === 0) return null;
  return {
    ...candidate,
    inquiryOpportunityBasis: {
      ...basis,
      inheritedProjectIds: prior.map((project) => project.id).sort(),
      renewalKeys: prior.length > 0 ? renewalKeys : [],
    },
  };
}

function freezeTerminalInquiryOpportunityBasis(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  atMonth: number,
): void {
  if (!project.hypothesisCampaign?.attempts.length || project.terminalInquiryOpportunityBasis) return;
  const current = buildProjectInquiryOpportunityBasis(
    state,
    person,
    project.desiredFunction,
    visibleDropsFor(state, person),
    atMonth,
  );
  const opening = project.inquiryOpportunityBasis;
  const materialIds = [...new Set([...(opening?.materialIds ?? []), ...current.materialIds])]
    .sort((left, right) => left - right);
  const techniqueIds = [...new Set([...(opening?.techniqueIds ?? []), ...current.techniqueIds])].sort();
  const targetSourceKeys = [...new Set([...(opening?.targetSourceKeys ?? []), ...current.targetSourceKeys])].sort();
  const verifiedResponseEventIds = [...new Set([
    ...(opening?.verifiedResponseEventIds ?? []),
    ...current.verifiedResponseEventIds,
  ])].sort();
  const opportunityKeys = [...new Set([...(opening?.opportunityKeys ?? []), ...current.opportunityKeys])].sort();
  const opportunitySources = [...(opening?.opportunitySources ?? []), ...current.opportunitySources]
    .filter((source, index, all) => all.findIndex((candidate) => candidate.opportunityKey === source.opportunityKey
      && candidate.kind === source.kind
      && candidate.sourceKeys.join('|') === source.sourceKeys.join('|')) === index)
    .sort((left, right) => left.opportunityKey.localeCompare(right.opportunityKey)
      || left.sourceKeys.join('|').localeCompare(right.sourceKeys.join('|')));
  project.terminalInquiryOpportunityBasis = {
    ...current,
    materialIds,
    techniqueIds,
    targetSourceKeys,
    verifiedResponseEventIds,
    opportunityKeys,
    opportunitySources,
    sourceFactIds: [...new Set([...(opening?.sourceFactIds ?? []), ...current.sourceFactIds])],
    sourceKeys: [...new Set([...(opening?.sourceKeys ?? []), ...current.sourceKeys])],
    basisKey: `${person.id}:${project.desiredFunction}:${opportunityKeys.join('|')}`,
    inheritedProjectIds: [...(opening?.inheritedProjectIds ?? [])],
    renewalKeys: [...(opening?.renewalKeys ?? [])],
  };
}

function compileKnownExertionStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  project: ProjectState,
  technique: ReliableExertionTechnique,
): ProjectStep | null {
  const target = localTargetForKnownExertion(state, person, technique.rule);
  if (!target) return null;
  const slots: CandidateInventorySlot[] = [
    { materialId: technique.rule.toolMaterialId },
    { materialId: technique.rule.inputMaterialId },
  ];
  const stacks = stacksForCandidateSlots(person, slots, new Set());
  if (!stacks) {
    const missing = [...exertionInputQuantities(technique.rule)]
      .filter(([materialId, quantity]) => inventoryQuantity(person, materialId) < quantity)
      .map(([materialId]) => materialId);
    const drop = nearestDrop(state, person, visibleDrops, missing);
    if (drop) {
      const requiredQuantity = exertionInputQuantities(technique.rule).get(drop.materialId) ?? 1;
      const demand = materialDemand(
        person,
        drop.materialId,
        requiredQuantity,
        `known-exertion:${technique.rule.id}:${drop.materialId}`,
        technique.sourceEventIds,
      );
      const step = dropStep(person, drop, project.summary, demand);
      if (step) return { ...step, missingMaterialIds: missing, planKnowledgeId: technique.knowledgeId };
    }
    for (const materialId of missing) {
      const nested = compileKnownOutput(state, person, visibleDrops, materialId, project.summary);
      if (nested) return { ...nested, missingMaterialIds: missing };
    }
    return null;
  }
  const [tool, input] = stacks;
  return {
    key: `known-exertion-${technique.rule.id}-${tool.id}-${input.id}`,
    summary: `按已核验经验得到${materialDefinition(technique.rule.outputMaterialId).name}`,
    reason: '本人已经核验这项完整施力经验；具体输入、目标和结果来自该经验对应的权威物质规则',
    action: {
      kind: 'act',
      operation: 'exert',
      toolStackId: tool.id,
      targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: input.id },
        { kind: 'voxel', position: target.position },
      ],
    },
    target: { kind: 'voxel', position: target.position },
    sourceFactIds: [...new Set([
      ...technique.sourceEventIds,
      ...tool.sourceEventIds,
      ...input.sourceEventIds,
    ])],
    missingMaterialIds: [],
    reservations: [...reservation(person, tool.id), ...reservation(person, input.id)],
    planKnowledgeId: technique.knowledgeId,
  };
}

function compileKnownExposureStep(
  person: PersonState,
  project: ProjectState,
  subject: ItemStack,
  target: LocalVoxelTarget,
  allowedOutputMaterialIds = completedFunctionMaterialIds(project),
): ProjectStep | null {
  const desiredOutputs = new Set(allowedOutputMaterialIds);
  const technique = reliableExposureTechniques(person).find((candidate) => (
    candidate.rule.inputMaterialId === subject.materialId
      && candidate.rule.targetMaterialId === target.materialId
      && desiredOutputs.has(candidate.rule.outputMaterialId)
  ));
  if (!technique) return null;
  return {
    key: `known-exposure-${technique.rule.id}-${subject.id}`,
    summary: `按已核验经验得到${materialDefinition(technique.rule.outputMaterialId).name}`,
    reason: '本人已经核验这项完整接触经验；当前 subject 与眼前目标都和经验中的实体条件一致',
    action: {
      kind: 'act',
      operation: 'expose',
      targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: subject.id },
        { kind: 'voxel', position: target.position },
      ],
    },
    target: { kind: 'voxel', position: target.position },
    sourceFactIds: [...new Set([...technique.sourceEventIds, ...subject.sourceEventIds])],
    missingMaterialIds: [],
    reservations: reservation(person, subject.id),
    planKnowledgeId: technique.knowledgeId,
  };
}

function metallurgyWorkStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  project: ProjectState,
): ProjectStep | null {
  const metallurgyFunctions = new Set<ProjectFunction>([
    'copper-charge', 'copper-smelting', 'tin-charge', 'tin-smelting',
    'bronze-alloying', 'bronze-tooling', 'bronze-workshop',
  ]);
  if (!metallurgyFunctions.has(project.desiredFunction)) return null;
  const workplace = fixedFacilityWorkplace(state, person, project.site);
  if (!workplace) return null;
  const atWorkplace = person.position.cellId === workplace.workingPosition.cellId
    && person.position.z === workplace.workingPosition.z;
  if (!atWorkplace) return {
    key: `approach-metallurgy-site-${project.id}-${workplace.workingPosition.cellId}-${workplace.workingPosition.z}`,
    summary: `前往固定冶炼工地继续${project.summary}`,
    reason: '冶炼材料、贡献者和高温设施需要汇合到同一处固定地点，项目不会追逐移动中的持料者',
    action: {
      kind: 'move',
      toCellId: workplace.workingPosition.cellId,
      toZ: workplace.workingPosition.z,
    },
    target: { kind: 'voxel', position: workplace.target.position },
    sourceFactIds: [...new Set([
      ...project.triggerFactIds,
      ...person.knownPlaces
        .filter((place) => place.materialId === workplace.target.materialId
          && place.position.x === workplace.target.position.x
          && place.position.y === workplace.target.position.y
          && place.position.z === workplace.target.position.z)
        .flatMap((place) => place.sourceEventIds),
    ])],
    missingMaterialIds: [...project.missingMaterialIds],
    materialDemands: structuredClone(project.materialDemands ?? []),
    reservations: [],
  };

  if ((project.desiredFunction === 'copper-charge' || project.desiredFunction === 'tin-charge')
    && inventoryQuantity(person, Material.Charcoal) === 0) {
    const wood = person.inventory.find((stack) => stack.materialId === Material.Wood && stack.quantity > 0);
    if (!wood) return null;
    const known = compileKnownExposureStep(person, project, wood, workplace.target, [Material.Charcoal]);
    if (known) return known;
    return hypothesisStep(state, person, visibleDrops, project, {
      operation: 'expose-local',
      questionKind: 'transform-subject-with-observed-heat',
      targetMaterialId: workplace.target.materialId,
      targetSourceFactIds: sourceEventIdsForTarget(
        state,
        project,
        workplace.target.position,
        workplace.target.materialId,
      ),
      targetSourceKeys: [`voxel:${workplace.target.position.x}:${workplace.target.position.y}:${workplace.target.position.z}:${workplace.target.materialId}`],
      subjectSourceKeys: [inventorySourceKey(person, wood)],
    }, workplace.target.position);
  }

  const smeltingInput = project.desiredFunction === 'copper-smelting'
    ? Material.CopperCharge
    : project.desiredFunction === 'tin-smelting'
      ? Material.TinCharge
      : undefined;
  if (smeltingInput !== undefined) {
    const subject = person.inventory.find((stack) => stack.materialId === smeltingInput && stack.quantity > 0);
    if (!subject) return null;
    const known = compileKnownExposureStep(person, project, subject, workplace.target);
    if (known) return known;
    return hypothesisStep(state, person, visibleDrops, project, {
      operation: 'expose-local',
      questionKind: 'transform-subject-with-observed-heat',
      targetMaterialId: workplace.target.materialId,
      targetSourceFactIds: sourceEventIdsForTarget(
        state,
        project,
        workplace.target.position,
        workplace.target.materialId,
      ),
      targetSourceKeys: [`voxel:${workplace.target.position.x}:${workplace.target.position.y}:${workplace.target.position.z}:${workplace.target.materialId}`],
      subjectSourceKeys: [inventorySourceKey(person, subject)],
    }, workplace.target.position);
  }
  return null;
}

function activeHypothesisCandidate(project: ProjectState): ProjectHypothesisCandidate | undefined {
  const activeKey = project.hypothesisCampaign?.activeCandidateKey;
  return activeKey
    ? project.hypothesisCampaign?.candidates.find((candidate) => candidate.key === activeKey)
    : undefined;
}

function actionInventorySourceKeys(person: PersonState, action: PrimitiveAction): string[] {
  const stackIds: string[] = [];
  if (action.kind === 'act') {
    stackIds.push(...action.targets.flatMap((target) => target.kind === 'inventory-stack'
      && target.personId === person.id ? [target.stackId] : []));
    if (action.toolStackId) stackIds.push(action.toolStackId);
  } else if (action.kind === 'attend' && action.target.kind === 'inventory-stack'
    && action.target.personId === person.id) {
    stackIds.push(action.target.stackId);
    if (action.instrumentStackId) stackIds.push(action.instrumentStackId);
  } else if (action.kind === 'communicate' && action.carrierStackId) {
    stackIds.push(action.carrierStackId);
  } else if (action.kind === 'transfer' && action.stackId) {
    stackIds.push(action.stackId);
  }
  return [...new Set(stackIds.map((stackId) => `inventory:${person.id}:${stackId}`))];
}

function openingStepUsesRenewalCommitment(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  step: ProjectStep,
): boolean {
  const basis = project.inquiryOpportunityBasis;
  if (!basis?.renewalKeys.length) return true;
  const renewalKeys = new Set(basis.renewalKeys);
  const sources = (basis.opportunitySources ?? []).filter((source) => renewalKeys.has(source.opportunityKey));
  if (!sources.length) return false;
  const active = activeHypothesisCandidate(project);
  if (active?.reasonKeys.includes('cross-project-renewal-opportunity')) return true;
  const inventorySourceKeys = actionInventorySourceKeys(person, step.action);
  const stepSourceKeys = new Set([
    ...inventorySourceKeys,
    ...(step.target?.kind === 'drop' ? [`drop:${step.target.dropId}`] : []),
    ...(step.target?.kind === 'inventory-stack'
      ? [`inventory:${step.target.personId}:${step.target.stackId}`]
      : []),
    ...(step.target?.kind === 'voxel'
      ? [`voxel:${step.target.position.x}:${step.target.position.y}:${step.target.position.z}:${voxelAt(
          state.world.grid,
          step.target.position.x,
          step.target.position.y,
          step.target.position.z,
        )}`]
      : []),
  ]);
  return sources.some((source) => {
    if (source.kind === 'knowledge') return step.planKnowledgeId === source.opportunityKey.slice('knowledge:'.length);
    if (source.kind === 'verified-response') return source.sourceFactIds.some((eventId) => step.sourceFactIds.includes(eventId))
      && source.sourceKeys.some((sourceKey) => stepSourceKeys.has(sourceKey));
    return source.sourceKeys.some((sourceKey) => stepSourceKeys.has(sourceKey));
  });
}

function verifiedResponseEntityStillPresent(
  state: SimulationState,
  person: PersonState,
  responseRef: NonNullable<ProjectState['hypothesisCampaign']>['attempts'][number]['responseRef'],
): boolean {
  if (!responseRef) return false;
  if (responseRef.kind === 'inventory-stack') {
    return person.inventory.some((stack) => stack.id === responseRef.stackId
      && stack.materialId === responseRef.materialId
      && stack.quantity > 0);
  }
  return voxelAt(
    state.world.grid,
    responseRef.position.x,
    responseRef.position.y,
    responseRef.position.z,
  ) === responseRef.materialId;
}

function questionAllowsAnotherExert(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  questionKind: ProjectHypothesisQuestionKind,
): boolean {
  const attempts = project.hypothesisCampaign?.attempts ?? [];
  let latestQuestionIndex = -1;
  for (let index = 0; index < attempts.length; index += 1) {
    if (attempts[index].questionKind === questionKind) latestQuestionIndex = index;
  }
  if (latestQuestionIndex < 0) return true;
  return attempts.slice(latestQuestionIndex).some((attempt) => attempt.outcome === 'response'
    && Boolean(attempt.verifiedEventId)
    && Boolean(attempt.responseRef)
    && verifiedResponseEntityStillPresent(state, person, attempt.responseRef));
}

function blindExertThenCombineStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  project: ProjectState,
  questionKind: Extract<ProjectHypothesisQuestionKind, 'seek-local-heat' | 'shape-portable-surface'>,
  subjectSourceKeys: string[] = [],
): ProjectStep | null {
  const active = activeHypothesisCandidate(project);
  if (active?.operation === 'combine-inventory') {
    return hypothesisStep(state, person, visibleDrops, project, {
      operation: 'combine-inventory',
      questionKind: active.questionKind,
      subjectSourceKeys,
    });
  }
  const target = localOpenExertionTarget(state, person);
  if (target && questionAllowsAnotherExert(state, person, project, questionKind)) {
    const exert = hypothesisStep(state, person, visibleDrops, project, {
      operation: 'exert-air',
      questionKind,
      targetMaterialId: target.materialId,
      targetSourceKeys: [`voxel:${target.position.x}:${target.position.y}:${target.position.z}:${target.materialId}`],
      subjectSourceKeys,
    }, target.position);
    if (exert) return exert;
  }
  return hypothesisStep(state, person, visibleDrops, project, {
    operation: 'combine-inventory',
    questionKind: 'connect-manipulator-shapes',
    subjectSourceKeys,
  });
}

function foodPreparationStep(state: SimulationState, person: PersonState, visibleDrops: DropState[], project: ProjectState): ProjectStep | null {
  const raw = person.inventory.find((stack) => stack.quantity > 0 && (stack.materialId === Material.RawMeat || stack.materialId === Material.Food));
  if (!raw) {
    const drop = nearestDrop(state, person, visibleDrops, [Material.RawMeat, Material.Food]);
    if (drop) return dropStep(person, drop, project.summary, materialDemand(
      person, drop.materialId, 1, `prepared-food-input-substitute:${drop.materialId}`, drop.sourceEventIds,
    ));
    return null;
  }
  const hotTarget = localHotTarget(state, person);
  if (hotTarget) {
    const knownExposure = compileKnownExposureStep(person, project, raw, hotTarget);
    if (knownExposure) return knownExposure;
    return hypothesisStep(state, person, visibleDrops, project, {
      operation: 'expose-local',
      questionKind: 'transform-subject-with-observed-heat',
      targetMaterialId: hotTarget.materialId,
      targetSourceFactIds: sourceEventIdsForTarget(state, project, hotTarget.position, hotTarget.materialId),
      targetSourceKeys: [`voxel:${hotTarget.position.x}:${hotTarget.position.y}:${hotTarget.position.z}:${hotTarget.materialId}`],
      subjectSourceKeys: [inventorySourceKey(person, raw)],
    }, hotTarget.position);
  }
  const knownHeat = reliableHeatTechnique(person);
  if (knownHeat) return compileKnownExertionStep(state, person, visibleDrops, project, knownHeat);
  const knownManipulator = reliableMissingManipulatorRecipe(person);
  if (knownManipulator) {
    return compileKnownOutput(
      state,
      person,
      visibleDrops,
      knownManipulator.rule.output.materialId,
      project.summary,
    );
  }
  return blindExertThenCombineStep(
    state,
    person,
    visibleDrops,
    project,
    'seek-local-heat',
    [inventorySourceKey(person, raw)],
  );
}

function buildingStack(person: PersonState) {
  return person.inventory
    .filter((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'solid') && materialHas(stack.materialId, 'building'))
    .sort((a, b) => b.quantity - a.quantity || a.materialId - b.materialId)[0];
}

function solidBuildingAt(state: SimulationState, position: { x: number; y: number; z: number }): boolean {
  const materialId = voxelAt(state.world.grid, position.x, position.y, position.z);
  return materialHas(materialId, 'solid') && (materialHas(materialId, 'building') || materialHas(materialId, 'ground'));
}

function constructionPosition(state: SimulationState, project: ProjectState): { x: number; y: number; z: number } | null {
  if (!project.site) return null;
  const site = project.site;
  const requirement = project.shelterRequirement;
  const currentShelter = shelterGeometryAt(state.world.grid, site);
  if (requirement) {
    // An adaptation project is bound to the enclosure that produced its
    // exposure evidence. If that geometry disappears, or already satisfies
    // the requirement before project status is synchronized, it must not
    // fall through into the generic shelter blueprint and place an unrelated
    // upper wall or roof.
    if (!currentShelter || currentShelter.enclosedSides >= requirement.minimumEnclosedSides) return null;
    const openSide = neighbors4(site.cellId)
      .map((neighbor) => ({
        cellId: neighbor,
        lower: { x: cellX(neighbor), y: cellY(neighbor), z: site.z },
        upper: { x: cellX(neighbor), y: cellY(neighbor), z: site.z + 1 },
      }))
      .filter((candidate) => {
        const support = voxelAt(state.world.grid, candidate.lower.x, candidate.lower.y, candidate.lower.z - 1);
        const wasTraversableOpening = standingPositions(state.world.grid, candidate.cellId)
          .some((position) => Math.abs(position.z - site.z) <= 1);
        return support !== Material.Air
          && support !== Material.Water
          && voxelAt(state.world.grid, candidate.lower.x, candidate.lower.y, candidate.lower.z) === Material.Air
          && !solidBuildingAt(state, candidate.upper)
          && currentShelter.openSides - Number(wasTraversableOpening) >= 1;
      })
      .sort((left, right) => seededFraction(state.seed, `project-adapt-wall:${project.id}:${left.cellId}`)
        - seededFraction(state.seed, `project-adapt-wall:${project.id}:${right.cellId}`)
        || left.cellId - right.cellId)[0];
    return openSide?.lower ?? null;
  }
  const sides = neighbors4(site.cellId).map((neighbor) => ({
    cellId: neighbor,
    lower: { x: cellX(neighbor), y: cellY(neighbor), z: site.z },
    upper: { x: cellX(neighbor), y: cellY(neighbor), z: site.z + 1 },
  })).sort((a, b) => seededFraction(state.seed, `project-wall:${project.id}:${a.cellId}`)
    - seededFraction(state.seed, `project-wall:${project.id}:${b.cellId}`));
  const side = sides.find((candidate) => {
    const support = voxelAt(state.world.grid, candidate.lower.x, candidate.lower.y, candidate.lower.z - 1);
    const lower = voxelAt(state.world.grid, candidate.lower.x, candidate.lower.y, candidate.lower.z);
    return support !== Material.Air
      && support !== Material.Water
      && (lower === Material.Air || solidBuildingAt(state, candidate.lower));
  });
  if (!side) return null;
  {
    const support = voxelAt(state.world.grid, side.lower.x, side.lower.y, side.lower.z - 1);
    if (support !== Material.Air && support !== Material.Water && voxelAt(state.world.grid, side.lower.x, side.lower.y, side.lower.z) === Material.Air) return side.lower;
  }
  if (solidBuildingAt(state, side.lower) && voxelAt(state.world.grid, side.upper.x, side.upper.y, side.upper.z) === Material.Air) return side.upper;
  const roof = { x: cellX(site.cellId), y: cellY(site.cellId), z: site.z + 2 };
  if (voxelAt(state.world.grid, roof.x, roof.y, roof.z) === Material.Air && solidBuildingAt(state, side.upper)) return roof;
  return null;
}

function constructionStep(state: SimulationState, person: PersonState, visibleDrops: DropState[], project: ProjectState): ProjectStep | null {
  if (!project.site) return null;
  const stack = buildingStack(person);
  if (!stack) {
    const candidates = visibleDrops
      .filter((candidate) => materialHas(candidate.materialId, 'solid') && materialHas(candidate.materialId, 'building'));
    const drop = nearestDrop(state, person, candidates, candidates.map((candidate) => candidate.materialId));
    if (!drop) return null;
    const step = dropStep(person, drop, project.summary, materialDemand(
      person, drop.materialId, 1, `construction-next-placement:${drop.materialId}`, drop.sourceEventIds,
    ));
    return step ? { ...step, missingMaterialIds: [drop.materialId] } : null;
  }
  if (person.position.cellId !== project.site.cellId || person.position.z !== project.site.z) return {
    key: `return-site-${project.site.cellId}-${project.site.z}`,
    summary: `带着材料回到未完成遮蔽项目的工作位置`,
    reason: '已经取得项目所需材料，回到原址继续连接比另开碎片化地点更有用',
    action: { kind: 'move', toCellId: project.site.cellId, toZ: project.site.z },
    sourceFactIds: [...new Set([...project.actionEventIds, ...stack.sourceEventIds])],
    missingMaterialIds: [],
    reservations: reservation(person, stack.id),
  };
  const position = constructionPosition(state, project);
  if (!position) return null;
  const target: WorldRef = { kind: 'voxel', position };
  return {
    key: `place-${position.x}-${position.y}-${position.z}-${stack.id}`,
    summary: `继续${project.summary}的下一处实体连接`,
    reason: '目标位置是同一功能结构当前最早缺失的支撑、侧向连接或顶盖，不会另开碎片化地点',
    action: { kind: 'act', operation: 'combine', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: stack.id }, target] },
    target,
    sourceFactIds: [...new Set([...project.actionEventIds, ...stack.sourceEventIds])],
    missingMaterialIds: [],
    reservations: reservation(person, stack.id),
  };
}

function careApplicationStep(state: SimulationState, person: PersonState, project: ProjectState): ProjectStep | null {
  if (project.desiredFunction !== 'healing') return null;
  const medicine = person.inventory.find((stack) => stack.materialId === Material.HerbalMedicine && stack.quantity > 0);
  if (!medicine) return null;
  const beneficiary = project.beneficiaryIds
    .map((personId) => state.people.find((candidate) => candidate.id === personId && isAlive(candidate)))
    .find((candidate) => candidate?.conditions.some((condition) => condition.kind === 'wound' || condition.kind === 'illness'));
  if (!beneficiary) return null;
  const target: WorldRef = { kind: 'person', personId: beneficiary.id };
  return {
    key: `apply-care-${medicine.id}-${beneficiary.id}`,
    summary: `把项目制得的草药用于${beneficiary.name}的具体伤病`,
    reason: '项目的功能结果是改变伤病，而不是仅把材料留在背包里',
    action: sameLocation(person, beneficiary)
      ? { kind: 'act', operation: 'combine', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: medicine.id }, target] }
      : { kind: 'move', toCellId: beneficiary.position.cellId, toZ: beneficiary.position.z },
    target,
    sourceFactIds: [...medicine.sourceEventIds, ...beneficiary.conditions.flatMap((condition) => condition.sourceEventIds)],
    missingMaterialIds: [],
    reservations: reservation(person, medicine.id),
  };
}

function durableRecordStep(state: SimulationState, person: PersonState, visibleDrops: DropState[], project: ProjectState): ProjectStep | null {
  if (project.desiredFunction !== 'durable-record' || !project.targetKnowledgeId) return null;
  const knowledge = person.knowledge.find((fact) => fact.id === project.targetKnowledgeId && fact.confidence >= 55);
  if (!knowledge) return null;
  const carrier = blankRecordCarrier(person);
  if (carrier) {
    const representationId = `project-record:${project.id}:${knowledge.id}`;
    return {
      key: `write-${carrier.id}-${knowledge.id}`,
      summary: `把“${knowledge.summary}”写入已有空白载体`,
      reason: '本人已经因经验中断风险形成保存目标；空白载体和已核验知识都在手中',
      action: {
        kind: 'communicate',
        content: { id: representationId, kind: 'claim', summary: knowledge.summary, factId: knowledge.id },
        audience: [], channel: 'record', carrierStackId: carrier.id,
      },
      target: { kind: 'inventory-stack', personId: person.id, stackId: carrier.id },
      sourceFactIds: [...new Set([...project.triggerFactIds, ...knowledge.sourceEventIds, ...carrier.sourceEventIds])],
      missingMaterialIds: [],
      reservations: reservation(person, carrier.id),
      planKnowledgeId: knowledge.id,
    };
  }
  const knownCarrierRecipe = reliableRecordCarrierRecipe(person);
  if (knownCarrierRecipe) {
    return compileKnownOutput(
      state,
      person,
      visibleDrops,
      knownCarrierRecipe.rule.output.materialId,
      project.summary,
    );
  }
  const knownCarrierTechnique = reliableRecordCarrierTechnique(person);
  if (knownCarrierTechnique) {
    return compileKnownExertionStep(state, person, visibleDrops, project, knownCarrierTechnique);
  }
  const knownManipulator = reliableMissingManipulatorRecipe(person);
  if (knownManipulator) {
    return compileKnownOutput(
      state,
      person,
      visibleDrops,
      knownManipulator.rule.output.materialId,
      project.summary,
    );
  }
  return blindExertThenCombineStep(
    state,
    person,
    visibleDrops,
    project,
    'shape-portable-surface',
  );
}

function settledCultivationStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): ProjectStep | null {
  if (project.desiredFunction !== 'settled-cultivation') return null;
  const visible = new Set(visibleCellsFor(person));
  if (!project.site) {
    const anchor = [...visible]
      .filter((cellId) => cultivationSurfaceMaterials.has(surfaceMaterial(state.world.grid, cellId))
        || plantableCultivationMaterials.has(surfaceMaterial(state.world.grid, cellId)))
      .map((cellId) => ({
        cellId,
        position: topPosition(state.world.grid, cellId),
        path: findStandingPath(state.world.grid, person.position, { cellId }),
      }))
      .filter((candidate) => candidate.path.length > 0)
      .sort((left, right) => left.path.length - right.path.length || left.cellId - right.cellId)[0];
    if (anchor) project.site = { cellId: anchor.cellId, z: anchor.position.z };
  }
  const cultivatedCells = projectCultivationCells(project)
    .filter((cellId) => cultivationSurfaceMaterials.has(surfaceMaterial(state.world.grid, cellId)));
  const harvests = projectCultivationHarvests(state, project);
  const matureCell = cultivatedCells
    .filter((cellId) => visible.has(cellId) && surfaceMaterial(state.world.grid, cellId) === Material.CropMature)
    .map((cellId) => ({
      cellId,
      position: topPosition(state.world.grid, cellId),
      path: findStandingPath(state.world.grid, person.position, { cellId }),
    }))
    .filter((candidate) => candidate.path.length > 0)
    .sort((left, right) => left.path.length - right.path.length || left.cellId - right.cellId)[0];
  if (matureCell && (harvests.length < 2 || inventoryQuantity(person, Material.Seed) === 0)) {
    const tool = person.inventory
      .filter((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'tool'))
      .sort((left, right) => materialDefinition(right.materialId).hardness - materialDefinition(left.materialId).hardness)[0];
    const closeEnough = Math.abs(cellX(person.position.cellId) - matureCell.position.x)
      + Math.abs(cellY(person.position.cellId) - matureCell.position.y) <= 1;
    return {
      key: `settled-cultivation-harvest-${matureCell.cellId}`,
      summary: closeEnough ? '收获定居耕地中的成熟作物并留下下一轮种子' : '前往已经成熟的定居耕地',
      reason: '农耕定居不仅需要播种，还必须完成真实生长、收获与留种循环',
      action: closeEnough
        ? {
          kind: 'act', operation: 'separate',
          targets: [{ kind: 'voxel', position: matureCell.position }],
          ...(tool ? { toolStackId: tool.id } : {}),
        }
        : { kind: 'move', toCellId: matureCell.path.at(-1)!.cellId, toZ: matureCell.path.at(-1)!.z },
      target: { kind: 'voxel', position: matureCell.position },
      sourceFactIds: [...new Set([...project.triggerFactIds, ...harvests.slice(-2).map((event) => event.id)])],
      missingMaterialIds: [],
      reservations: tool ? reservation(person, tool.id) : [],
    };
  }
  if (cultivatedCells.length >= 6) return null;
  const seed = person.inventory.find((stack) => stack.materialId === Material.Seed && stack.quantity > 0);
  if (!seed) return null;
  const target = projectCultivationCells(project)
    .filter((cellId) => visible.has(cellId)
      && plantableCultivationMaterials.has(surfaceMaterial(state.world.grid, cellId)))
    .map((cellId) => ({
      cellId,
      position: topPosition(state.world.grid, cellId),
      path: findStandingPath(state.world.grid, person.position, { cellId }),
    }))
    .filter((candidate) => candidate.path.length > 0)
    .sort((left, right) => left.path.length - right.path.length || left.cellId - right.cellId)[0];
  if (!target) return null;
  const closeEnough = Math.abs(cellX(person.position.cellId) - target.position.x)
    + Math.abs(cellY(person.position.cellId) - target.position.y) <= 1;
  return {
    key: `settled-cultivation-plant-${target.cellId}-${seed.id}`,
    summary: closeEnough ? '把留存种子播入适合耕作的湿润土壤' : '带着种子前往适合耕作的湿润土壤',
    reason: '本人感知到食物压力，并把偶然采集转变成固定地点上的可重复生产',
    action: closeEnough
      ? {
        kind: 'act', operation: 'combine',
        targets: [
          { kind: 'inventory-stack', personId: person.id, stackId: seed.id },
          { kind: 'voxel', position: target.position },
        ],
      }
      : { kind: 'move', toCellId: target.path.at(-1)!.cellId, toZ: target.path.at(-1)!.z },
    target: { kind: 'voxel', position: target.position },
    sourceFactIds: [...new Set([...project.triggerFactIds, ...seed.sourceEventIds])],
    missingMaterialIds: [],
    reservations: reservation(person, seed.id),
  };
}

function compileProjectWorkStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  project: ProjectState,
): ProjectStep | null {
  const verification = tentativeTechniqueStep(state, person, project);
  if (verification) return verification;
  const cultivation = settledCultivationStep(state, person, project);
  if (cultivation) return cultivation;
  if (project.desiredFunction === 'weather-shelter') return constructionStep(state, person, visibleDrops, project);
  if (project.desiredFunction === 'prepared-food') return foodPreparationStep(state, person, visibleDrops, project);
  if (project.desiredFunction === 'durable-record') return durableRecordStep(state, person, visibleDrops, project);
  const metallurgy = metallurgyWorkStep(state, person, visibleDrops, project);
  if (metallurgy) return metallurgy;
  const subassembly = developmentSubassemblyStep(state, person, project);
  if (subassembly) return subassembly;
  const upgrade = containerUpgradeStep(state, person, project);
  if (upgrade) return upgrade;
  if (project.desiredFunction === 'reserve-storage' && placedFunctionEvidence(state, project).length) {
    return reserveStockingStep(state, person, visibleDrops, project);
  }
  for (const materialId of placedFunctionMaterialIds(project)) {
    const stack = person.inventory.find((candidate) => candidate.materialId === materialId && candidate.quantity > 0);
    const target = stack ? localOpenExertionTarget(state, person) : null;
    if (stack && target) return {
      key: `place-project-facility-${materialId}-${target.position.x}-${target.position.y}-${target.position.z}`,
      summary: `把${materialDefinition(materialId).name}设置为可共同使用的固定设施`,
      reason: '设施已经制作完成，但只有落在可抵达的实体位置并被持续使用，才会产生公共功能',
      action: {
        kind: 'act',
        operation: 'combine',
        targets: [
          { kind: 'inventory-stack', personId: person.id, stackId: stack.id },
          { kind: 'voxel', position: target.position },
        ],
      },
      target: { kind: 'voxel', position: target.position },
      sourceFactIds: [...stack.sourceEventIds],
      missingMaterialIds: [],
      reservations: reservation(person, stack.id),
    };
    const approach = stack ? visiblePlacementApproach(state, person) : null;
    if (stack && approach) return {
      key: `approach-project-facility-site-${materialId}-${approach.cellId}-${approach.z}`,
      summary: `寻找可设置${materialDefinition(materialId).name}的近处实体位置`,
      reason: '设施构件已经完成，但眼前没有可落地的空气体素；人物只前往本人可见可达且有固体承托的位置',
      action: { kind: 'move', toCellId: approach.cellId, toZ: approach.z },
      sourceFactIds: [...stack.sourceEventIds],
      missingMaterialIds: [],
      reservations: reservation(person, stack.id),
    };
  }
  const care = careApplicationStep(state, person, project);
  if (care) return care;
  for (const output of completedFunctionMaterialIds(project)) {
    const known = compileKnownOutput(state, person, visibleDrops, output, project.summary);
    if (known) return known;
  }
  // Cultivation already has a complete physical loop. When the anchored field
  // is waiting for moisture or growth, there is no unknown recipe to guess.
  // Returning null lets the outer compiler source a missing seed, or wait.
  if (project.desiredFunction === 'settled-cultivation') return null;
  const pendingSubassembly = [
    'efficient-production', 'community-coordination', 'reserve-storage',
    'reliable-water', 'crop-processing', 'high-heat-processing',
    'copper-charge', 'copper-smelting', 'tin-charge', 'tin-smelting',
    'bronze-alloying', 'bronze-tooling', 'bronze-workshop',
  ].includes(project.desiredFunction)
    && Boolean(projectMaterialRequirement(state, person, project)?.demands.length);
  if (pendingSubassembly) return null;
  return hypothesisStep(state, person, visibleDrops, project);
}

function materialContributionRequestStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  requirement: ProjectMaterialRequirement,
): ProjectStep | null {
  if (project.ownerId !== person.id || project.need !== 'alloy-capability' || !project.site) return null;
  const visible = new Set(visibleCellsFor(person));
  const possibleContributors = state.people.filter((candidate) => candidate.id !== person.id
    && isAlive(candidate)
    && visible.has(candidate.position.cellId));
  const selected = requirement.demands.flatMap((demand) => {
    if (demand.outstandingQuantity <= 0
      || project.materialContributionRequests?.some((request) => request.materialId === demand.materialId)) return [];
    const holders = possibleContributors.filter((candidate) => inventoryQuantity(candidate, demand.materialId) > 0);
    return holders.length ? [{ demand, holders }] : [];
  }).sort((left, right) => left.demand.materialId - right.demand.materialId)[0];
  if (!selected) return null;
  const quantity = Math.min(
    selected.demand.outstandingQuantity,
    selected.holders.reduce((sum, holder) => sum + inventoryQuantity(holder, selected.demand.materialId), 0),
  );
  if (quantity <= 0) return null;
  const materialName = materialDefinition(selected.demand.materialId).name;
  return {
    key: `request-project-material-${project.id}-${selected.demand.materialId}`,
    summary: `请求附近持料者把${materialName}送到固定冶炼工地`,
    reason: '项目已经记录具体缺口和固定设施；请求只发给眼前确实持有该材料的人，不会读取远处背包或追逐移动目标',
    action: {
      kind: 'communicate',
      content: {
        id: `project-material-request:${project.id}:${selected.demand.materialId}`,
        kind: 'request',
        summary: `“${project.summary}”还缺${materialName} × ${quantity}，请送到工地`,
        projectMaterialContribution: {
          version: 'project-material-contribution-request-v1',
          projectId: project.id,
          requesterId: person.id,
          materialId: selected.demand.materialId,
          quantity,
          site: { ...project.site },
          expiresAtMonth: state.clock.elapsedMonths + 12,
        },
      },
      audience: selected.holders.map((holder) => holder.id),
      channel: 'gesture',
    },
    sourceFactIds: [...new Set([
      ...project.triggerFactIds,
      ...selected.demand.sourceFactIds,
      ...selected.holders.flatMap((holder) => holder.inventory
        .filter((stack) => stack.materialId === selected.demand.materialId && stack.quantity > 0)
        .flatMap((stack) => stack.sourceEventIds)),
    ])],
    missingMaterialIds: [selected.demand.materialId],
    materialDemands: structuredClone(requirement.demands),
    reservations: [],
  };
}

function contributedQuantityForRequest(
  state: SimulationState,
  project: ProjectState,
  request: NonNullable<ProjectState['materialContributionRequests']>[number],
): number {
  const historicalQuantity = project.actionEventIds.reduce((sum, eventId) => {
    const event = worldEventById(state, eventId);
    if (event?.kind !== 'action'
      || event.status !== 'completed'
      || event.atMonth < request.atMonth
      || !request.contributorIds.includes(event.who)
      || event.action.kind !== 'transfer'
      || event.action.materialId !== request.materialId
      || event.action.from.kind !== 'person'
      || event.action.from.personId !== event.who) return sum;
    return sum + Number(event.diff.quantity ?? 0);
  }, 0);
  return Math.min(request.requestedQuantity, Math.max(request.contributedQuantity ?? 0, historicalQuantity));
}

function projectContributionStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): ProjectStep | null {
  if (project.ownerId === person.id || project.need !== 'alloy-capability' || !project.site) return null;
  const owner = state.people.find((candidate) => candidate.id === project.ownerId && isAlive(candidate));
  if (!owner) return null;
  const request = (project.materialContributionRequests ?? [])
    .filter((candidate) => candidate.contributorIds.includes(person.id)
      && candidate.expiresAtMonth >= state.clock.elapsedMonths + 1)
    .sort((left, right) => left.atMonth - right.atMonth || left.materialId - right.materialId)
    .find((candidate) => contributedQuantityForRequest(state, project, candidate) < candidate.requestedQuantity);
  if (!request) return null;
  const stack = person.inventory.find((candidate) => candidate.materialId === request.materialId && candidate.quantity > 0);
  if (!stack) return null;
  const remaining = Math.max(0, request.requestedQuantity - contributedQuantityForRequest(state, project, request));
  if (!remaining) return null;
  const workplace = fixedFacilityWorkplace(state, person, request.site);
  if (!workplace) return null;
  const atWorkplace = person.position.cellId === workplace.workingPosition.cellId
    && person.position.z === workplace.workingPosition.z;
  const materialName = materialDefinition(request.materialId).name;
  if (!atWorkplace) return {
    key: `carry-project-material-${project.id}-${request.requestEventId}`,
    summary: `把${materialName}运往固定冶炼工地`,
    reason: '本人收到与真实项目缺口绑定的请求；运输目标是固定设施，不追逐正在移动的项目所有者',
    action: { kind: 'move', toCellId: workplace.workingPosition.cellId, toZ: workplace.workingPosition.z },
    target: { kind: 'voxel', position: workplace.target.position },
    sourceFactIds: [...new Set([request.requestEventId, ...stack.sourceEventIds])],
    missingMaterialIds: [],
    reservations: reservation(person, stack.id, Math.min(remaining, stack.quantity)),
  };
  const quantity = Math.min(remaining, stack.quantity);
  return {
    key: `contribute-project-material-${project.id}-${request.requestEventId}-${stack.id}`,
    summary: `向“${project.summary}”贡献${materialName} × ${quantity}`,
    reason: sameLocation(person, owner)
      ? '项目所有者已经在固定工地，材料当面交接并保留来源'
      : '项目所有者暂时不在工位，材料留在固定设施旁，后续仍需由真实取物动作接续',
    action: {
      kind: 'transfer',
      materialId: request.materialId,
      quantity,
      from: { kind: 'person', personId: person.id },
      to: sameLocation(person, owner)
        ? { kind: 'person', personId: owner.id }
        : { kind: 'ground', cellId: person.position.cellId, z: person.position.z },
      stackId: stack.id,
    },
    target: { kind: 'voxel', position: workplace.target.position },
    sourceFactIds: [...new Set([request.requestEventId, ...stack.sourceEventIds])],
    missingMaterialIds: [],
    reservations: reservation(person, stack.id, quantity),
  };
}

function compileProjectStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  project: ProjectState,
): ProjectStep | null {
  if (project.ownerId !== person.id && project.need === 'alloy-capability') {
    return projectContributionStep(state, person, project);
  }
  const existingEpisode = activeLogisticsEpisode(project);
  if (existingEpisode?.actorId === person.id) {
    const episodeStep = activeEpisodeStep(state, person, visibleDrops, project, existingEpisode);
    if (episodeStep) return episodeStep;
    if (activeLogisticsEpisode(project)?.id === existingEpisode.id) return null;
  }

  const workStep = compileProjectWorkStep(state, person, visibleDrops, project);
  const foreignEpisode = activeLogisticsEpisode(project);
  if (foreignEpisode && foreignEpisode.actorId !== person.id) {
    return workStep?.target?.kind === 'drop' ? null : workStep;
  }
  if (workStep?.planKnowledgeId) {
    project.planKnowledgeId = workStep.planKnowledgeId;
    const reliableTechnique = workStep.planKnowledgeId.startsWith('technique:')
      && person.knowledge.some((fact) => fact.id === workStep.planKnowledgeId && fact.confidence >= 55);
    if (reliableTechnique) closeProjectHypothesisCampaign(
      project,
      state.clock.elapsedMonths + 1,
      'reliable-knowledge',
    );
  }
  if (workStep?.target?.kind === 'drop') {
    const dropId = workStep.target.dropId;
    const drop = visibleDrops.find((candidate) => candidate.id === dropId);
    if (!drop) return null;
    const demand = workStep.materialDemands?.find((candidate) => candidate.materialId === drop.materialId);
    if (!demand || demand.outstandingQuantity <= 0) return null;
    const episode = startDropLogisticsEpisode(
      project,
      person,
      drop,
      workStep.sourceFactIds,
      state.clock.elapsedMonths + 1,
      demand,
    );
    return activeEpisodeStep(state, person, visibleDrops, project, episode);
  }
  if (workStep) return workStep;

  const requirement = projectMaterialRequirement(state, person, project);
  if (!requirement?.materialIds.length) return null;
  if (requirement.planKnowledgeId) project.planKnowledgeId = requirement.planKnowledgeId;
  const contributionRequest = materialContributionRequestStep(state, person, project, requirement);
  if (contributionRequest) return contributionRequest;
  const availableDrop = nearestDrop(state, person, visibleDrops, requirement.materialIds)
    ?? nearestRememberedDrop(state, person, requirement.materialIds);
  if (availableDrop) {
    const demand = requirement.demands.find((candidate) => candidate.materialId === availableDrop.materialId);
    if (demand) {
      const episode = startDropLogisticsEpisode(
        project,
        person,
        availableDrop,
        requirement.sourceEventIds,
        state.clock.elapsedMonths + 1,
        demand,
      );
      return activeEpisodeStep(state, person, visibleDrops, project, episode);
    }
  }
  const renewableSourceDemand = requirement.demands.find((demand) => (
    demand.materialId === Material.Wood || demand.materialId === Material.Fiber || demand.materialId === Material.Seed
  ) && demand.outstandingQuantity > 0);
  if (renewableSourceDemand) {
    const source = visibleMaterialSource(state, person, renewableSourceDemand.materialId);
    if (source) {
      const episode = startSourceLogisticsEpisode(
        project,
        person,
        source,
        requirement.sourceEventIds,
        state.clock.elapsedMonths + 1,
        renewableSourceDemand,
      );
      return activeEpisodeStep(state, person, visibleDrops, project, episode);
    }
  }
  const destination = visibleReachableSearchDestination(state, person, project, requirement.materialIds);
  if (!destination) return null;
  const episode = startSearchLogisticsEpisode(
    project,
    person,
    requirement.materialIds,
    destination,
    requirement.sourceEventIds,
    state.clock.elapsedMonths + 1,
    requirement.demands,
    renewableSourceDemand ? 0 : undefined,
  );
  return activeEpisodeStep(state, person, visibleDrops, project, episode);
}

function projectOption(project: ProjectState, step: ProjectStep, proposal?: ProjectProposal): ActionOption {
  const initialLogisticsEpisode = proposal ? activeLogisticsEpisode(project) : undefined;
  const initialSearchCampaign = initialLogisticsEpisode?.searchCampaignId
    ? project.searchCampaigns?.find((campaign) => campaign.id === initialLogisticsEpisode.searchCampaignId)
    : undefined;
  const sourcedProposal = proposal ? {
    ...proposal,
    ...(initialLogisticsEpisode ? { initialLogisticsEpisode: structuredClone(initialLogisticsEpisode) } : {}),
    ...(initialSearchCampaign ? { initialSearchCampaign: structuredClone(initialSearchCampaign) } : {}),
    ...(step.materialDemands?.length ? { initialMaterialDemands: structuredClone(step.materialDemands) } : {}),
    ...(project.hypothesisCampaign
      ? { initialHypothesisCampaign: structuredClone(project.hypothesisCampaign) }
      : {}),
  } : undefined;
  return {
    id: `project:${project.id}:${step.key}`,
    summary: step.summary,
    reason: step.reason,
    goal: { kind: 'project-completed', projectId: project.id },
    nextAction: step.action,
    ...(step.target ? { target: step.target } : {}),
    estimatedDuration: 'long',
    estimatedMonths: Math.max(1, project.reviewAtMonth - project.createdAtMonth),
    sourceFactIds: [...new Set([...project.triggerFactIds, ...(project.pressureBasis?.sourceFactIds ?? []), ...step.sourceFactIds])],
    domain: 'strategic',
    projectId: project.id,
    ...(sourcedProposal ? { projectProposal: sourcedProposal } : {}),
    projectPressure: project.pressure,
  };
}

function proposal(
  state: SimulationState,
  person: PersonState,
  need: ProjectNeed,
  input: Omit<ProjectProposal, 'id' | 'need' | 'ownerId' | 'createdAtMonth' | 'reviewAtMonth' | 'triggerFactIds' | 'pressure' | 'pressureBasis'>,
  view: ProjectPressureView,
  pressureBasis?: ProjectPressureBasis,
): ProjectProposal {
  const createdAtMonth = state.clock.elapsedMonths + 1;
  const reviewMonths = [
    'production-efficiency', 'reserve-security', 'water-security', 'coordination-capacity',
  ].includes(need) ? 23 : [
    'high-heat-capability', 'alloy-capability', 'iron-capability',
  ].includes(need) ? 35 : 11;
  const subject = {
    need,
    beneficiaryIds: input.beneficiaryIds,
    createdAtMonth,
    ...(input.targetKnowledgeId ? { targetKnowledgeId: input.targetKnowledgeId } : {}),
    ...(input.shelterRequirement ? { shelterRequirement: input.shelterRequirement } : {}),
  };
  const basis = pressureBasis ?? buildProjectPressureBasis(state, person, subject, createdAtMonth, view);
  return {
    id: `project-${createdAtMonth}-${person.id}-${need}`,
    need,
    ownerId: person.id,
    createdAtMonth,
    reviewAtMonth: createdAtMonth + reviewMonths,
    ...input,
    triggerFactIds: [...basis.sourceFactIds],
    pressure: basis.pressure,
    pressureBasis: basis,
  };
}

interface ShelterAdaptationCandidate {
  beneficiary: PersonState;
  condition: PersonState['conditions'][number] & { kind: 'cold' | 'heat' };
  shelter: NonNullable<ReturnType<typeof shelterGeometryAt>>;
  sourceEventIds: string[];
}

function shelterAdaptationCandidate(
  state: SimulationState,
  person: PersonState,
  visiblePeople: PersonState[],
  proposalMonth: number,
): ShelterAdaptationCandidate | undefined {
  return [...new Map([person, ...visiblePeople].map((candidate) => [candidate.id, candidate])).values()]
    .filter((candidate) => candidate.id === person.id
      || (candidate.geneticParents.includes(person.id) && ageMonths(candidate, proposalMonth) < 12 * 12))
    .flatMap((beneficiary) => beneficiary.conditions
      .filter((condition): condition is typeof condition & { kind: 'cold' | 'heat' } => (
        (condition.kind === 'cold' || condition.kind === 'heat') && condition.sourceEventIds.length > 0
      ))
      .flatMap((condition) => {
        const shelter = shelterGeometryAt(state.world.grid, beneficiary.position);
        const sourceEventIds = condition.sourceEventIds.filter((eventId) => {
          const event = worldEventById(state, eventId);
          return event?.kind === 'environment'
            && event.change === 'condition'
            && event.who === beneficiary.id
            && event.cellId === beneficiary.position.cellId
            && event.diff.condition === condition.kind;
        });
        return shelter && shelter.enclosedSides < 3 && sourceEventIds.length
          ? [{ beneficiary, condition, shelter, sourceEventIds }]
          : [];
      }))
    .sort((left, right) => right.condition.stage - left.condition.stage
      || Number(right.beneficiary.id === person.id) - Number(left.beneficiary.id === person.id)
      || left.beneficiary.id.localeCompare(right.beneficiary.id))[0];
}

function shelterAdaptationProposal(
  state: SimulationState,
  person: PersonState,
  visiblePeople: PersonState[],
  pressureView: ProjectPressureView,
): ProjectProposal | null {
  const adaptation = shelterAdaptationCandidate(state, person, visiblePeople, state.clock.elapsedMonths + 1);
  if (!adaptation) return null;
  return proposal(state, person, 'shelter-capacity', {
    kind: 'construction', desiredFunction: 'weather-shelter',
    summary: `补强${adaptation.beneficiary.name}仍受到${adaptation.condition.kind === 'cold' ? '寒冷' : '炎热'}伤害的住所`,
    beneficiaryIds: [adaptation.beneficiary.id],
    site: { ...adaptation.shelter.position },
    shelterRequirement: {
      exposureKind: adaptation.condition.kind,
      beneficiaryId: adaptation.beneficiary.id,
      baselineEnclosedSides: adaptation.shelter.enclosedSides,
      baselineOpenSides: adaptation.shelter.openSides,
      baselineWeatherProtection: adaptation.shelter.weatherProtection,
      baselineThermalInsulation: adaptation.shelter.thermalInsulation,
      minimumEnclosedSides: 3,
      sourceEventIds: [...adaptation.sourceEventIds],
    },
  }, pressureView);
}

/**
 * A person sheltering from an exposure still needs one planning tick in which
 * to perceive that the current enclosure failed. This predicate is read-only:
 * it opens planning but neither creates a project nor changes the body.
 */
export function hasCausalShelterAdaptationNeed(state: SimulationState, person: PersonState): boolean {
  const activeProjects = state.projects.filter((project) => project.ownerId === person.id && project.status === 'active');
  if (activeProjects.some((project) => project.shelterRequirement)) return true;
  if (activeProjects.length) return false;
  const visibleCells = visibleCellsFor(person);
  const visible = new Set(visibleCells);
  const visiblePeople = state.people.filter((candidate) => candidate.id !== person.id
    && isAlive(candidate)
    && visible.has(candidate.position.cellId));
  return Boolean(shelterAdaptationCandidate(state, person, visiblePeople, state.clock.elapsedMonths + 1));
}

function deriveProjectProposals(
  state: SimulationState,
  person: PersonState,
  visibleCells: number[],
  visibleDrops: DropState[],
  visiblePeople: PersonState[],
): ProjectProposal[] {
  if (state.projects.some((project) => project.ownerId === person.id && project.status === 'active')) return [];
  const visible = new Set(visibleCells);
  const pressureView: ProjectPressureView = { visibleCells, visibleDrops, visiblePeople };
  const proposals: ProjectProposal[] = [];
  const cold = person.conditions.find((condition) => condition.kind === 'cold');
  const climateCold = state.civilization.climate.kind === 'cold' && state.civilization.climate.severity >= 3;
  const hasInsulation = person.inventory.some((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'insulating'));
  if ((cold || climateCold) && !hasInsulation) proposals.push(proposal(state, person, 'thermal-safety', {
    kind: 'production', desiredFunction: 'insulation', summary: '减少反复寒冷造成的身体损耗',
    beneficiaryIds: [person.id],
  }, pressureView));

  const proposalMonth = state.clock.elapsedMonths + 1;
  const huntingSubject = { need: 'hunting-safety' as const, beneficiaryIds: [person.id], createdAtMonth: proposalMonth };
  const huntingBasis = buildProjectPressureBasis(state, person, huntingSubject, proposalMonth, pressureView);
  const ownHuntFailure = projectPressureReasonPresent(huntingBasis, 'own-hunt-failure');
  const personalAttack = projectPressureReasonPresent(huntingBasis, 'personal-animal-attack');
  const visibleThreat = projectPressureReasonPresent(huntingBasis, 'visible-aggressive-animal');
  if ((ownHuntFailure || personalAttack || visibleThreat) && inventoryQuantity(person, Material.Spear) === 0) proposals.push(proposal(state, person, 'hunting-safety', {
    kind: ownHuntFailure || personalAttack ? 'production' : 'inquiry', desiredFunction: 'safer-hunting', summary: '降低下一次捕猎或应对猛兽的受伤风险',
    beneficiaryIds: [person.id],
  }, pressureView, huntingBasis));

  const injured = [person, ...visiblePeople]
    .filter((candidate) => candidate.conditions.some((condition) => condition.kind === 'wound' || condition.kind === 'illness'))
    .sort((a, b) => a.body.health - b.body.health)[0];
  if (injured && inventoryQuantity(person, Material.HerbalMedicine) === 0) {
    proposals.push(proposal(state, person, 'care-capability', {
      kind: 'inquiry', desiredFunction: 'healing', summary: `为${injured.name}寻找比临时包扎更有效的照护材料`,
      beneficiaryIds: [injured.id],
    }, pressureView));
  }

  const rawMeat = inventoryQuantity(person, Material.RawMeat) + visibleDrops.filter((drop) => drop.materialId === Material.RawMeat).reduce((sum, drop) => sum + drop.quantity, 0);
  if (rawMeat > 0 && inventoryQuantity(person, Material.CookedFood) === 0) proposals.push(proposal(state, person, 'food-preparation', {
    kind: 'inquiry', desiredFunction: 'prepared-food', summary: '把容易伤身的生肉变成更可靠的食物',
    beneficiaryIds: [person.id],
  }, pressureView));

  const exposed = person.conditions.find((condition) => condition.kind === 'cold' || condition.kind === 'heat');
  const severeWeather = (state.civilization.weather.kind === 'storm' && state.civilization.weather.intensity >= 2)
    || state.civilization.climate.kind === 'fire'
    || ((state.civilization.climate.kind === 'cold' || state.civilization.climate.kind === 'heat') && state.civilization.climate.severity >= 3);
  const ownShelter = shelterGeometryAt(state.world.grid, person.position);
  const sheltered = Boolean(ownShelter);
  const adaptation = shelterAdaptationProposal(state, person, visiblePeople, pressureView);
  if (adaptation) proposals.push(adaptation);
  const visibleCompleteShelter = state.derived.structures.some((structure) => structure.complete
    && (structure.occupiedCells.some((cell) => visible.has(cell)) || structure.interiorCells.some((cell) => visible.has(cell))));
  if (!adaptation && (exposed || severeWeather) && !sheltered && !visibleCompleteShelter) proposals.push(proposal(state, person, 'shelter-capacity', {
    kind: 'construction', desiredFunction: 'weather-shelter', summary: '把同一处材料连接成能进入并遮蔽天气的住所',
    beneficiaryIds: [person.id],
    site: { cellId: person.position.cellId, z: person.position.z },
  }, pressureView));

  const authoredRecords = state.records.filter((record) => record.authorId === person.id);
  const durableKnowledge = person.knowledge
    .filter((fact) => fact.kind === 'technique'
      && fact.confidence >= 68
      && fact.sourceEventIds.length >= 2
      && !authoredRecords.some((record) => record.knowledgeId === fact.id))
    .sort((a, b) => b.confidence - a.confidence
      || b.sourceEventIds.length - a.sourceEventIds.length
      || a.id.localeCompare(b.id))[0];
  const knowledgeSubject = {
    need: 'knowledge-preservation' as const,
    beneficiaryIds: [person.id],
    createdAtMonth: proposalMonth,
    ...(durableKnowledge ? { targetKnowledgeId: durableKnowledge.id } : {}),
  };
  const knowledgeBasis = buildProjectPressureBasis(state, person, knowledgeSubject, proposalMonth, pressureView);
  const continuityPressure = knowledgeBasis.reasonKeys.some((reason) => reason.startsWith('age-band-'))
    || projectPressureReasonPresent(knowledgeBasis, 'personal-memory-disruption');
  if (continuityPressure && durableKnowledge && authoredRecords.length < 1) proposals.push(proposal(state, person, 'knowledge-preservation', {
    kind: 'inquiry', desiredFunction: 'durable-record',
    summary: `让“${durableKnowledge.summary}”在个人记忆中断后仍可留下`,
    beneficiaryIds: [person.id],
    targetKnowledgeId: durableKnowledge.id,
  }, pressureView, knowledgeBasis));

  const materialEvidence = buildLocalMaterialEvidence(state, person, { visibleCells, visibleDrops, visiblePeople });
  const hasObserved = (...materialIds: MaterialId[]) => materialIds.some((materialId) => (
    materialEvidence.observedMaterialIds.has(materialId)
  ));
  const hasOwn = (...materialIds: MaterialId[]) => materialIds.some((materialId) => inventoryQuantity(person, materialId) > 0);
  const ownsAll = (...materialIds: MaterialId[]) => materialIds.every((materialId) => inventoryQuantity(person, materialId) > 0);
  const hasObservedFacility = (...materialIds: MaterialId[]) => materialIds.some((materialId) => (
    materialHas(materialId, 'facility') && materialEvidence.observedMaterialIds.has(materialId)
  ));
  const hasFacility = (...materialIds: MaterialId[]) => hasObservedFacility(...materialIds);
  const completedJointProjects = state.projects.filter((project) => project.status === 'completed'
    && project.contributorIds.includes(person.id)
    && project.contributorIds.some((personId) => personId !== person.id));
  const pushDevelopmentProposal = (
    need: ProjectNeed,
    desiredFunction: ProjectFunction,
    summary: string,
    ready: boolean,
    kind: ProjectProposal['kind'] = 'production',
    site?: ProjectState['site'],
  ) => {
    if (!ready) return;
    const completedOutputStillObserved = completedFunctionMaterialIds({ desiredFunction })
      .some((materialId) => hasObserved(materialId));
    if (need === 'alloy-capability'
      && completedOutputStillObserved
      && state.projects.some((project) => project.status === 'completed'
        && project.desiredFunction === desiredFunction)) return;
    const visiblePendingFacility = kind === 'construction'
      && completedFunctionMaterialIds({ desiredFunction })
        .filter((materialId) => materialHas(materialId, 'facility'))
        .some((materialId) => visiblePeople.some((candidate) => inventoryQuantity(candidate, materialId) > 0));
    if (visiblePendingFacility) return;
    const duplicateActiveProject = state.projects.some((project) => {
      if (project.status !== 'active' || project.desiredFunction !== desiredFunction) return false;
      if (desiredFunction !== 'settled-cultivation') return true;
      if (!site || !project.site) return false;
      const distance = Math.abs(cellX(site.cellId) - cellX(project.site.cellId))
        + Math.abs(cellY(site.cellId) - cellY(project.site.cellId));
      return distance <= 4;
    });
    if (duplicateActiveProject) return;
    const subject = { need, desiredFunction, beneficiaryIds: [person.id], createdAtMonth: proposalMonth };
    const basis = buildProjectPressureBasis(state, person, subject, proposalMonth, pressureView);
    if (basis.pressure < 42) return;
    proposals.push(proposal(state, person, need, {
      kind,
      desiredFunction,
      summary,
      beneficiaryIds: kind === 'construction' || need === 'alloy-capability'
        ? [...new Set(visiblePeople.map((candidate) => candidate.id).concat(person.id))]
        : [person.id],
      ...(site ? { site: { ...site } } : {}),
    }, pressureView, basis));
  };

  // Pressure below still distinguishes personal access from observation. At
  // proposal time, however, an eye-visible tool is enough to avoid opening a
  // second identical project in the same locality; once people separate, the
  // observer can still start a personal tool project without a population gate.
  const hasProductionTool = hasObserved(Material.WoodTool, Material.StoneHoe, Material.BronzeTool, Material.IronTool);
  const cultivationSite = visibleCells
    .filter((cellId) => cultivationSurfaceMaterials.has(surfaceMaterial(state.world.grid, cellId))
      || plantableCultivationMaterials.has(surfaceMaterial(state.world.grid, cellId)))
    .map((cellId) => ({
      cellId,
      position: topPosition(state.world.grid, cellId),
      path: findStandingPath(state.world.grid, person.position, { cellId }),
      established: cultivationSurfaceMaterials.has(surfaceMaterial(state.world.grid, cellId)),
    }))
    .filter((candidate) => candidate.path.length > 0)
    .sort((left, right) => Number(right.established) - Number(left.established)
      || left.path.length - right.path.length
      || left.cellId - right.cellId)[0];
  const hasAccessibleSeedSource = hasOwn(Material.Seed)
    || visibleDrops.some((drop) => drop.materialId === Material.Seed && drop.quantity > 0)
    || visibleCells.some((cellId) => harvestableSeedSourceMaterials
      .has(surfaceMaterial(state.world.grid, cellId)))
    || person.knownPlaces.some((place) => harvestableSeedSourceMaterials.has(place.materialId)
      && voxelAt(state.world.grid, place.position.x, place.position.y, place.position.z) === place.materialId);
  const accessibleStorableUnits = [
    ...person.inventory.filter((stack) => stack.quantity > 0
      && (materialHas(stack.materialId, 'edible') || materialHas(stack.materialId, 'seed'))),
    ...visibleDrops.filter((drop) => drop.quantity > 0
      && (materialHas(drop.materialId, 'edible') || materialHas(drop.materialId, 'seed'))),
  ].reduce((sum, stack) => sum + stack.quantity, 0);
  const reserveWeatherRisk = state.civilization.weather.kind === 'storm'
    || state.civilization.climate.severity >= 3;
  const cultivationCellCount = cultivationSite
    ? projectCultivationCells({ site: { cellId: cultivationSite.cellId, z: cultivationSite.position.z } })
      .filter((cellId) => cultivationSurfaceMaterials.has(surfaceMaterial(state.world.grid, cellId))).length
    : 0;
  pushDevelopmentProposal(
    'production-efficiency',
    'efficient-production',
    '用专门工具缓解本人反复感知到的食物与采集压力',
    !hasProductionTool
      && hasObserved(Material.Leaves, Material.Shrub, Material.Wood, Material.Fiber, Material.Rope, Material.Plank),
  );
  pushDevelopmentProposal(
    'production-efficiency',
    'workshop-production',
    '建立固定工坊，把个人手艺变成可重复的生产能力',
    hasProductionTool && !hasFacility(Material.Workshop)
      && hasObserved(Material.Leaves, Material.Wood, Material.Plank, Material.WoodTablet),
    'construction',
  );
  pushDevelopmentProposal(
    'reserve-security',
    'reserve-storage',
    '建立公共谷仓，保存眼前余粮并应对坏天气造成的储备波动',
    (accessibleStorableUnits >= 2 || reserveWeatherRisk) && !hasFacility(Material.Granary)
      && hasObserved(Material.Leaves, Material.Wood, Material.Plank, Material.Container),
    'construction',
  );
  pushDevelopmentProposal(
    'water-security',
    'reliable-water',
    '修建蓄水设施，降低本人感知到的干热与缺水风险',
    !hasFacility(Material.Cistern)
      && hasObserved(Material.Stone)
      && hasObserved(Material.Leaves, Material.Wood, Material.Plank, Material.Container),
    'construction',
  );
  pushDevelopmentProposal(
    'production-efficiency',
    'settled-cultivation',
    '建立固定耕地，以播种、成熟、收获和留种循环缓解本人感知到的食物压力',
    Boolean(cultivationSite)
      && hasAccessibleSeedSource
      && cultivationCellCount < 6,
    'production',
    cultivationSite ? { cellId: cultivationSite.cellId, z: cultivationSite.position.z } : undefined,
  );
  pushDevelopmentProposal(
    'production-efficiency',
    'crop-processing',
    '建立石磨，提高定居作物的收获效率',
    hasObserved(Material.CropMature, Material.Seed) && !hasFacility(Material.Mill)
      && hasObserved(Material.Stone) && hasObserved(Material.Leaves, Material.Wood, Material.Plank),
    'construction',
  );
  pushDevelopmentProposal(
    'coordination-capacity',
    'community-coordination',
    '把已经发生的共同项目、分配与记忆安置到固定议事场所',
    completedJointProjects.length > 0
      && !hasFacility(Material.CouncilHearth, Material.CivicHall, Material.KeepCore)
      && hasObserved(Material.Leaves, Material.Shrub, Material.Wood, Material.Fiber, Material.Plank, Material.Rope),
    'construction',
  );

  pushDevelopmentProposal(
    'high-heat-capability',
    'high-heat-processing',
    '用黏土和石料建立窑炉，获得比露天火堆更稳定的高温',
    hasObserved(Material.Clay) && hasObserved(Material.Stone)
      && !hasObservedFacility(Material.Kiln, Material.Foundry, Material.Smithy),
    'construction',
  );
  pushDevelopmentProposal(
    'high-heat-capability',
    'brick-firing',
    '在固定窑炉中反复烧制砖料，为更复杂建筑准备耐火材料',
    hasOwn(Material.Clay) && hasObservedFacility(Material.Kiln, Material.Foundry),
  );
  const metallurgySite = knownFacilitySite(state, person);
  pushDevelopmentProposal('alloy-capability', 'copper-charge', '在固定窑炉汇合铜矿与木炭，配成可冶炼的铜料',
    Boolean(metallurgySite && hasObserved(Material.CopperOre)), 'production', metallurgySite);
  pushDevelopmentProposal('alloy-capability', 'copper-smelting', '在固定高温设施中从铜料得到金属铜',
    Boolean(metallurgySite && hasObserved(Material.CopperCharge)), 'production', metallurgySite);
  pushDevelopmentProposal('alloy-capability', 'tin-charge', '在固定窑炉汇合锡矿与木炭，配成可冶炼的锡料',
    Boolean(metallurgySite && hasObserved(Material.TinOre)), 'production', metallurgySite);
  pushDevelopmentProposal('alloy-capability', 'tin-smelting', '在固定高温设施中从锡料得到金属锡',
    Boolean(metallurgySite && hasObserved(Material.TinCharge)), 'production', metallurgySite);
  pushDevelopmentProposal('alloy-capability', 'bronze-alloying', '在固定工地汇合铜锡并反复校验比例，得到可用青铜',
    Boolean(metallurgySite && hasObserved(Material.Copper) && hasObserved(Material.Tin)), 'production', metallurgySite);
  pushDevelopmentProposal('alloy-capability', 'bronze-tooling', '在固定工地把青铜变成能显著提高生产效率的专门工具',
    Boolean(metallurgySite && hasObserved(Material.Bronze) && hasObserved(Material.Wood)), 'production', metallurgySite);
  pushDevelopmentProposal(
    'alloy-capability',
    'bronze-workshop',
    '建立铸造场，把偶然的青铜样品变成可分工复现的生产能力',
    Boolean(metallurgySite && hasObserved(Material.Bronze) && hasObserved(Material.Stone) && !hasObservedFacility(Material.Foundry)),
    'construction',
    metallurgySite,
  );
  pushDevelopmentProposal(
    'coordination-capacity',
    'civic-coordination',
    '建立公共厅堂，让记录、度量与分配成为稳定制度',
    hasObserved(Material.Bronze, Material.BronzeTool) && ownsAll(Material.FiredBrick, Material.WoodTablet)
      && !hasFacility(Material.CivicHall, Material.KeepCore),
    'construction',
  );

  pushDevelopmentProposal(
    'iron-capability',
    'iron-workshop',
    '建立铁匠铺，以青铜经验和耐火砖跨过铁器高温门槛',
    hasObserved(Material.Bronze, Material.BronzeTool) && ownsAll(Material.Bronze, Material.FiredBrick)
      && !hasObservedFacility(Material.Smithy),
    'construction',
  );
  pushDevelopmentProposal('iron-capability', 'iron-charge', '把铁矿与木炭配成可还原的铁料',
    ownsAll(Material.IronOre, Material.Charcoal) && hasObservedFacility(Material.Smithy));
  pushDevelopmentProposal('iron-capability', 'iron-reduction', '在铁匠铺中把铁料还原成海绵铁',
    hasOwn(Material.IronCharge) && hasObservedFacility(Material.Smithy));
  pushDevelopmentProposal('iron-capability', 'iron-working', '反复加热和锤炼海绵铁，得到可用铁料',
    ownsAll(Material.IronBloom, Material.Charcoal));
  pushDevelopmentProposal('iron-capability', 'iron-tooling', '锻造铁制生产工具，缓解更大人口的持续资源压力',
    ownsAll(Material.Iron, Material.Wood));
  pushDevelopmentProposal(
    'coordination-capacity',
    'fortified-coordination',
    '建立城堡核心，组织城镇防护、维护与跨工种协作',
    hasObserved(Material.IronTool) && ownsAll(Material.Iron, Material.FiredBrick) && !hasFacility(Material.KeepCore),
    'construction',
  );

  return proposals.flatMap((candidate) => {
    const grounded = proposalWithInquiryOpportunityMemory(state, person, visibleDrops, candidate);
    return grounded ? [grounded] : [];
  }).sort((a, b) => b.pressure - a.pressure
    || seededFraction(state.seed, `project-proposal:${state.clock.elapsedMonths}:${person.id}:${a.need}`)
      - seededFraction(state.seed, `project-proposal:${state.clock.elapsedMonths}:${person.id}:${b.need}`));
}

function adoptableConstructionProjects(state: SimulationState, person: PersonState, visibleCells: Set<number>): ProjectState[] {
  return state.projects.filter((project) => project.kind === 'construction'
    && project.status === 'active'
    && project.ownerId !== person.id
    && project.site
    && visibleCells.has(project.site.cellId)
    && project.actionEventIds.length > 0
    && project.contributorIds.length < 3);
}

function requestedMaterialProjects(state: SimulationState, person: PersonState): ProjectState[] {
  return state.projects.filter((project) => project.status === 'active'
    && project.ownerId !== person.id
    && project.need === 'alloy-capability'
    && project.materialContributionRequests?.some((request) => request.contributorIds.includes(person.id)
      && request.expiresAtMonth >= state.clock.elapsedMonths + 1
      && contributedQuantityForRequest(state, project, request) < request.requestedQuantity));
}

function previewProjectState(
  state: SimulationState,
  project: ProjectState,
): { state: SimulationState; project: ProjectState } {
  const previewProject = cloneProjectForPlanning(project);
  return {
    state: {
      ...state,
      projects: state.projects.map((candidate) => candidate.id === project.id ? previewProject : candidate),
    },
    project: previewProject,
  };
}

export function buildProjectOptions(
  state: SimulationState,
  person: PersonState,
  visibleCells: number[],
  visibleDrops: DropState[],
  visiblePeople: PersonState[],
): ActionOption[] {
  const options: ActionOption[] = [];
  for (const project of requestedMaterialProjects(state, person).slice(0, 1)) {
    const preview = previewProjectState(state, project);
    const step = projectContributionStep(preview.state, person, preview.project);
    if (step) options.push({
      ...projectOption(preview.project, step),
      reason: `${step.reason}；这项贡献来自本人实际收到的项目材料请求`,
      projectPressure: Math.max(64, project.pressure),
    });
  }
  const own = state.projects.filter((project) => project.ownerId === person.id && project.status === 'active');
  for (const project of own) {
    if (projectFunctionSatisfied(state, project)) continue;
    const preview = previewProjectState(state, project);
    const step = compileProjectStep(preview.state, person, visibleDrops, preview.project);
    if (step) options.push(projectOption(preview.project, step));
  }
  if (options.length || own.length) return options;

  // A witnessed failure of the shelter currently being used belongs ahead of
  // optional work on somebody else's structure. The proposal still has to
  // compile a legal material/logistics step before it becomes an option.
  const pressureView: ProjectPressureView = { visibleCells, visibleDrops, visiblePeople };
  const adaptation = shelterAdaptationProposal(state, person, visiblePeople, pressureView);
  if (adaptation) {
    const project = instantiateProject(adaptation);
    const step = compileProjectStep(state, person, visibleDrops, project);
    if (step) return [projectOption(project, step, adaptation)];
  }

  for (const project of adoptableConstructionProjects(state, person, new Set(visibleCells)).slice(0, 1)) {
    const preview = previewProjectState(state, project);
    const step = compileProjectStep(preview.state, person, visibleDrops, preview.project);
    if (step) options.push({
      ...projectOption(preview.project, step),
      reason: `看见${state.people.find((candidate) => candidate.id === project.ownerId)?.name ?? '他人'}在同一地点留下可继续的未完成遮蔽结构；自己的环境压力使贡献材料具有直接用途`,
      projectPressure: Math.max(35, project.pressure - 8),
    });
  }
  if (options.length) return options;

  for (const candidate of deriveProjectProposals(state, person, visibleCells, visibleDrops, visiblePeople).slice(0, 2)) {
    const project = instantiateProject(candidate);
    const step = compileProjectStep(state, person, visibleDrops, project);
    if (step && openingStepUsesRenewalCommitment(state, person, project, step)) {
      options.push(projectOption(project, step, candidate));
    }
  }
  return options;
}

export function ensureProject(state: SimulationState, proposal: ProjectProposal): ProjectState {
  const existing = state.projects.find((project) => project.id === proposal.id);
  if (existing) return existing;
  const created = instantiateProject(proposal);
  state.projects.push(created);
  return created;
}

export function recompileProjectNextAction(state: SimulationState, person: PersonState, projectId: string): PrimitiveAction | null {
  const project = state.projects.find((candidate) => candidate.id === projectId);
  if (!project || project.status !== 'active') return null;
  synchronizeProject(state, project, state.clock.elapsedMonths + 1);
  if (project.status !== 'active') return null;
  const step = compileProjectStep(state, person, visibleDropsFor(state, person), project);
  if (!step) {
    if (project.ownerId === person.id) {
      project.missingMaterialIds = [];
      project.materialDemands = [];
      project.reservations = [];
    } else {
      project.reservations = project.reservations.filter((reservation) => reservation.personId !== person.id);
    }
    return null;
  }
  if (project.ownerId === person.id) {
    project.missingMaterialIds = [...new Set(step.missingMaterialIds)];
    project.materialDemands = structuredClone(step.materialDemands ?? []);
    project.reservations = [...step.reservations];
    if (step.planKnowledgeId) project.planKnowledgeId = step.planKnowledgeId;
  } else {
    project.reservations = [
      ...project.reservations.filter((reservation) => reservation.personId !== person.id),
      ...step.reservations,
    ];
  }
  return step.action;
}

export function hasViableConstructionProjectOption(state: SimulationState, options: ActionOption[]): boolean {
  return options.some((option) => option.projectProposal?.kind === 'construction'
    || Boolean(option.projectId && state.projects.some((project) => project.id === option.projectId && project.kind === 'construction')));
}

export function knownProductionOutputs(person: PersonState): MaterialId[] {
  return inventoryCombinationRules()
    .filter((rule) => person.knowledge.some((fact) => fact.id === inventoryCombinationTechniqueId(rule) && fact.confidence >= 55))
    .map((rule) => rule.output.materialId);
}
