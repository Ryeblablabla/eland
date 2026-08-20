import type { ActionFact, DropState, SimulationState } from '../../domain/model';
import { Material, materialDefinition, type MaterialId } from '../../domain/material';
import { bestProductionToolStack } from '../../domain/production-tool';
import { inventoryQuantity, isAlive, type PersonState } from '../../domain/person';
import type {
  ProjectLogisticsEndingReason,
  ProjectLogisticsEpisode,
  ProjectLogisticsEpisodeStatus,
  ProjectMaterialDemand,
  ProjectProgressEvidence,
  ProjectSearchCampaign,
  ProjectState,
} from '../../domain/project';
import { worldEventById } from '../../domain/event-index';
import {
  cellX,
  cellY,
  findStandingPath,
  neighbors4,
  standingPositions,
  surfaceMaterial,
  topPosition,
  voxelAt,
  type StandingPosition,
} from '../../world/grid';
import { seededFraction } from '../../world/generator';
import { visibleCellsFor } from './project-perception';
import type { ProjectStep } from './project-step';

export interface ProjectSearchDestination {
  target: StandingPosition;
  pathLength: number;
  campaignId: string;
}

const PROJECT_SEARCH_CAMPAIGN_ACTION_BUDGET = 16;

export function logisticsEpisodes(project: ProjectState): ProjectLogisticsEpisode[] {
  project.logisticsEpisodes ??= [];
  return project.logisticsEpisodes;
}

export function activeLogisticsEpisode(project: ProjectState): ProjectLogisticsEpisode | undefined {
  if (!project.activeLogisticsEpisodeId) return undefined;
  const episode = logisticsEpisodes(project).find((candidate) => candidate.id === project.activeLogisticsEpisodeId
    && candidate.status === 'active');
  if (!episode) delete project.activeLogisticsEpisodeId;
  return episode;
}

export function endLogisticsEpisode(
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

export function endActiveLogisticsEpisode(
  project: ProjectState,
  endedAt: number,
  status: Exclude<ProjectLogisticsEpisodeStatus, 'active'>,
  endingReason: ProjectLogisticsEndingReason,
): void {
  const episode = activeLogisticsEpisode(project);
  if (episode) endLogisticsEpisode(project, episode, endedAt, status, endingReason);
}

export function closeProjectSearchCampaigns(project: ProjectState, atMonth: number): void {
  for (const campaign of project.searchCampaigns ?? []) {
    if (campaign.status !== 'active') continue;
    campaign.status = 'closed';
    campaign.closedAt = atMonth;
  }
}

export function endingReasonForProject(project: ProjectState): ProjectLogisticsEndingReason {
  if (project.status === 'completed') return 'project-completed';
  if (project.status === 'abandoned') return 'project-abandoned';
  return 'project-blocked';
}

export function endingStatusForProject(
  project: ProjectState,
): Exclude<ProjectLogisticsEpisodeStatus, 'active'> {
  return project.status === 'completed' ? 'fulfilled' : 'exhausted';
}

export function recordProjectProgress(project: ProjectState, evidence: ProjectProgressEvidence): void {
  project.progressEvidence ??= [];
  if (project.progressEvidence.some((item) => item.eventId === evidence.eventId)) return;
  project.progressEvidence.push(evidence);
  project.lastProgressAtMonth = Math.max(project.lastProgressAtMonth, evidence.atMonth);
}

export function logisticsAdvanceEvidence(
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

function searchCampaignBasisKey(
  project: ProjectState,
  person: PersonState,
  materialIds: MaterialId[],
): string {
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

export function searchEpisodeCommittedActionIds(
  state: SimulationState,
  episode: ProjectLogisticsEpisode,
  pendingFact?: ActionFact,
): string[] {
  if (episode.kind !== 'search') return [];
  return episode.actionEventIds.filter((eventId) => {
    const event = pendingFact?.id === eventId ? pendingFact : worldEventById(state, eventId);
    // Persisted episodes are authoritative even when an older event window is unavailable.
    if (!event) return true;
    return event.kind === 'action'
      && event.cause === 'intent'
      && event.action.kind === 'move'
      && event.action.toCellId === episode.target.cellId
      && event.action.toZ === episode.target.z;
  });
}

function searchCampaignCommittedActionCount(
  state: SimulationState,
  project: ProjectState,
  campaignId: string,
  pendingFact?: ActionFact,
): number {
  const eventIds = new Set((project.logisticsEpisodes ?? [])
    .filter((episode) => episode.kind === 'search' && episode.searchCampaignId === campaignId)
    .flatMap((episode) => searchEpisodeCommittedActionIds(state, episode, pendingFact)));
  return eventIds.size;
}

function exhaustSearchCampaign(project: ProjectState, campaignId: string, atMonth: number): void {
  const campaign = project.searchCampaigns?.find((candidate) => candidate.id === campaignId);
  if (!campaign || (campaign.status !== 'active' && campaign.status !== 'exhausted')) return;
  campaign.status = 'exhausted';
  campaign.closedAt ??= atMonth;
}

export function searchCampaignBudgetReached(
  state: SimulationState,
  project: ProjectState,
  campaignId: string | undefined,
  atMonth: number,
  pendingFact?: ActionFact,
): boolean {
  if (!campaignId
    || searchCampaignCommittedActionCount(state, project, campaignId, pendingFact)
      < PROJECT_SEARCH_CAMPAIGN_ACTION_BUDGET) return false;
  exhaustSearchCampaign(project, campaignId, atMonth);
  return true;
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
  if (searchCampaignBudgetReached(state, project, campaign.id, atMonth)) return null;
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

export function projectRequirementSourceEventIds(
  person: PersonState,
  project: ProjectState,
  materialIds: MaterialId[],
): string[] {
  return localRequirementSourceEventIds(person, project, materialIds);
}
export interface VisibleMaterialSource {
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

export function canWorkSource(
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

export function visibleMaterialSource(
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

export function startDropLogisticsEpisode(
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
      ...projectRequirementSourceEventIds(person, project, [drop.materialId]),
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

export function startSourceLogisticsEpisode(
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
      ...projectRequirementSourceEventIds(person, project, [source.outputMaterialId]),
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

export function startSearchLogisticsEpisode(
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
      ...projectRequirementSourceEventIds(person, project, materialIds),
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
  const tool = bestProductionToolStack(person);
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
  if (searchCampaignBudgetReached(state, project, episode.searchCampaignId, atMonth)) {
    endLogisticsEpisode(project, episode, atMonth, 'exhausted', 'search-budget-exhausted');
    return null;
  }
  if (person.position.cellId === episode.target.cellId && person.position.z === episode.target.z) {
    endLogisticsEpisode(project, episode, atMonth, 'fulfilled', 'search-target-reached');
    return null;
  }
  if (searchEpisodeCommittedActionIds(state, episode).length >= (episode.actionBudget ?? 1)) {
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

export function activeEpisodeStep(
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
