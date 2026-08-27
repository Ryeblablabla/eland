import type { ActionOption, PrimitiveAction } from '../domain/action';
import { inventoryCombinationRules, inventoryCombinationTechniqueId } from '../domain/interaction-rules';
import { Material, type MaterialId } from '../domain/material';
import type { ActionFact, DropState, SimulationState } from '../domain/model';
import { isAlive, type PersonState } from '../domain/person';
import { inheritPlanningEventOverlay, worldEventById } from '../domain/event-index';
import {
  intentsOwnedBy,
  invalidateProjectLeadershipIndex,
  personById,
  projectById,
  projectsLedBy,
  projectsRequiringMonthlySynchronization,
} from '../domain/state-index';
import {
  cloneProjectForPlanning,
  instantiateProject,
  type ProjectFunction,
  type ProjectProposal,
  type ProjectState,
} from '../domain/project';
import {
  inspectProjectMaterialContributionRequest,
  projectMaterialContributionRequestHasAuthoritativeSource,
  transferMatchesProjectMaterialRequest,
} from '../domain/project-material-request';
import {
  inspectProjectKnowledgeRequest,
  pendingProjectKnowledgeOutput,
  projectKnowledgeRequestHasAuthoritativeSource,
} from '../domain/project-knowledge-request';
import { techniqueOutputMaterialId } from '../domain/technique-demonstration';
import { registerProjectParticipantMembership } from '../domain/project-participant-index';
import type { ProjectPressureView } from './project-pressure';
import { mechanicalPowerProjectHasCurrentRecoveryWait } from './mechanical-power-options';
import { findStandingPath, surfaceMaterial } from '../world/grid';
import {
  appendProjectLeadershipSuccession,
  appendProjectLeadershipVacancy,
  buildProjectLeadershipSuccessionBasis,
  inspectProjectLeadership,
  latestProjectLeadershipContribution,
  projectIsLedBy,
  projectLeadershipDeathFact,
  projectLeadershipInspectionFactId,
  projectLeadershipInspectionPosition,
  projectCurrentLeadId,
  projectSupportsLeadershipSuccession,
} from '../domain/project-leadership';
import { recordRecurringDutyProjectProgress } from '../domain/governance';
import {
  closeProjectHypothesisCampaign,
  recordProjectHypothesisAttempt,
  recordProjectHypothesisVerification,
} from './project-hypotheses';
import {
  completedFunctionMaterialIds,
  projectCultivationCells,
  projectActionFacts,
  projectCompletionEvidence,
  projectFunctionSatisfied,
} from './projects/project-completion';
import {
  activeLogisticsEpisode,
  closeProjectSearchCampaigns,
  endActiveLogisticsEpisode,
  endingReasonForProject,
  endingStatusForProject,
  endLogisticsEpisode,
  logisticsAdvanceEvidence,
  recordProjectProgress,
  searchCampaignBudgetReached,
  searchEpisodeCommittedActionIds,
  visibleReachableSearchDestination,
} from './projects/project-logistics';
import { completeProject, refreshProjectPressure } from './projects/project-lifecycle';
import { visibleDropsFor } from './projects/project-perception';
import {
  buildProjectInquiryOpportunityBasis,
  freezeTerminalInquiryOpportunityBasis,
  openingStepUsesRenewalCommitment,
} from './projects/project-inquiry';
import {
  activeProjectOverlapsLocalProposal,
  deriveProjectProposals,
  hasCausalShelterAdaptationNeed,
  personHasProjectLink,
  shelterAdaptationProposal,
  visibleConstructionProgress,
} from './projects/project-proposals';
import {
  compileProjectStep,
  projectContributionStep,
  projectOption,
  projectSupportsMaterialContribution,
} from './projects/project-step-compiler';
import type { ProjectStep } from './projects/project-step';
import {
  projectProposalPressureGroups,
  projectProposalWithFunctionIdentity,
  rankExecutableProjectFrontier,
} from './projects/project-frontier';
export {
  buildProjectInquiryOpportunityBasis,
  hasCausalShelterAdaptationNeed,
  projectFunctionSatisfied,
  refreshProjectPressure,
  visibleReachableSearchDestination,
};

function projectPlanBasisTransitionAtMonth(
  state: SimulationState,
  project: ProjectState,
  owner: PersonState,
): number | undefined {
  let latestTransitionAtMonth: number | undefined;
  for (const request of project.knowledgeRequests ?? []) {
    if (request.version !== 'project-knowledge-request-v1'
      || request.projectId !== project.id
      || request.requesterId !== owner.id
      || !projectKnowledgeRequestHasAuthoritativeSource(state, project, request)
      || !request.responseEventId
      || !request.responderId
      || !request.techniqueId) continue;
    const response = worldEventById(state, request.responseEventId);
    if (!response
      || response.kind !== 'action'
      || response.status !== 'completed'
      || response.who !== request.responderId
      || response.action.kind !== 'communicate'
      || response.action.content.kind !== 'claim'
      || response.action.content.factId !== request.techniqueId
      || response.action.content.projectKnowledgeResponse?.version !== 'project-knowledge-response-v1'
      || response.action.content.projectKnowledgeResponse.projectId !== project.id
      || response.action.content.projectKnowledgeResponse.requestEventId !== request.requestEventId
      || response.action.content.projectKnowledgeResponse.requesterId !== owner.id
      || response.action.content.projectKnowledgeResponse.outputMaterialId !== request.outputMaterialId
      || response.diff.projectKnowledgeResponse !== true
      || response.diff.projectKnowledgeProjectId !== project.id
      || response.diff.projectKnowledgeRequestEventId !== request.requestEventId
      || response.diff.projectKnowledgeOutputMaterialId !== request.outputMaterialId
      || response.diff.projectKnowledgeTechniqueId !== request.techniqueId
      || !Array.isArray(response.diff.audience)
      || !response.diff.audience.includes(owner.id)) continue;
    const learnedTechnique = owner.knowledge.find((fact) => fact.id === request.techniqueId
      && fact.kind === 'technique'
      && fact.confidence >= 55
      && fact.sourceEventIds.includes(response.id));
    if (!learnedTechnique
      || techniqueOutputMaterialId(learnedTechnique.id) !== request.outputMaterialId
      || pendingProjectKnowledgeOutput(state, project) === request.outputMaterialId) continue;
    latestTransitionAtMonth = Math.max(latestTransitionAtMonth ?? response.atMonth, response.atMonth);
  }
  return latestTransitionAtMonth;
}

function sameMaterialBasis(left: readonly MaterialId[], right: readonly MaterialId[]): boolean {
  const normalizedLeft = [...new Set(left)].sort((a, b) => a - b);
  const normalizedRight = [...new Set(right)].sort((a, b) => a - b);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((materialId, index) => materialId === normalizedRight[index]);
}

function currentOutstandingMaterialIds(project: ProjectState): MaterialId[] {
  const demands = (project.materialDemands ?? [])
    .filter((demand) => demand.outstandingQuantity > 0)
    .map((demand) => demand.materialId);
  return [...new Set(demands.length ? demands : project.missingMaterialIds)].sort((a, b) => a - b);
}

function projectInquiryExhaustedAtMonth(project: ProjectState): number | undefined {
  const currentMaterials = currentOutstandingMaterialIds(project);
  if (currentMaterials.length) {
    const relevantSearches = (project.searchCampaigns ?? []).filter((campaign) => (
      campaign.planKnowledgeId === project.planKnowledgeId
      && sameMaterialBasis(campaign.materialIds, currentMaterials)
    ));
    if (relevantSearches.some((campaign) => campaign.status === 'active')) return undefined;
    const latestRelevantSearch = relevantSearches
      .filter((campaign) => campaign.status === 'exhausted')
      .sort((left, right) => (right.closedAt ?? right.openedAt) - (left.closedAt ?? left.openedAt))[0];
    const exhaustedAtMonth = latestRelevantSearch?.closedAt ?? latestRelevantSearch?.openedAt;
    return exhaustedAtMonth !== undefined && exhaustedAtMonth >= project.lastProgressAtMonth
      ? exhaustedAtMonth
      : undefined;
  }
  // Search and entity hypotheses are consecutive branches. Once there is no
  // current material deficit, an old still-active search cannot keep a later
  // exhausted hypothesis alive; while a material deficit exists, the inverse
  // is also true and only its exact search basis is relevant.
  if (project.hypothesisCampaign?.status === 'active') return undefined;
  const exhaustedAtMonth = project.hypothesisCampaign?.status === 'exhausted'
    ? project.hypothesisCampaign.endedAt ?? project.hypothesisCampaign.openedAt
    : undefined;
  return exhaustedAtMonth !== undefined && exhaustedAtMonth >= project.lastProgressAtMonth
    ? exhaustedAtMonth
    : undefined;
}

function projectInquiryExplicitlyExhausted(project: ProjectState): boolean {
  return projectInquiryExhaustedAtMonth(project) !== undefined;
}

function projectHasLegitimateWait(
  state: SimulationState,
  owner: PersonState,
  project: ProjectState,
  atMonth: number,
): boolean {
  if (project.desiredFunction === 'water-powered-crop-processing'
    && mechanicalPowerProjectHasCurrentRecoveryWait(state, owner, project)) return true;
  if (project.desiredFunction === 'settled-cultivation') {
    // Old seed searches describe an older material branch. The compiler keeps
    // Seed outstanding only while the anchored plot still has fewer than six
    // planted cells; once that physical threshold is met, sprouts are a real
    // growth wait even when the last carried seed was just planted.
    const seedOutstanding = currentOutstandingMaterialIds(project).includes(Material.Seed);
    if (seedOutstanding) return false;
    return projectCultivationCells(project).some((cellId) => {
      const materialId = surfaceMaterial(state.world.grid, cellId);
      return materialId === Material.CropSprout || materialId === Material.CropMature;
    });
  }
  if (owner.conditions.some((condition) => condition.kind === 'dehydrated-hibernation')) return true;
  const episode = activeLogisticsEpisode(project);
  if (episode?.status === 'active' && episode.actorId !== owner.id) return true;
  const openContribution = project.materialContributionRequests?.some((request) => {
    const demand = project.materialDemands?.find((candidate) => candidate.materialId === request.materialId);
    return Boolean(demand
      && projectMaterialContributionRequestHasAuthoritativeSource(state, project, request)
      && inspectProjectMaterialContributionRequest(
        state,
        project,
        request,
        atMonth,
        demand,
      ).status === 'open');
  });
  if (openContribution) return true;
  const openKnowledgeRequest = project.knowledgeRequests?.some((request) => (
    projectKnowledgeRequestHasAuthoritativeSource(state, project, request)
      && inspectProjectKnowledgeRequest(state, project, request, atMonth) === 'open'
  ));
  if (openKnowledgeRequest) return true;
  const pendingOutputs = new Set(completedFunctionMaterialIds(project));
  return projectActionFacts(state, project).some((event) => event.status === 'completed'
    && event.atMonth === atMonth
    && pendingOutputs.has(Number(event.diff.outputMaterialId))
    && !event.diff.position);
}

function projectHasOpenBoundedExternalRequest(
  state: SimulationState,
  project: ProjectState,
  atMonth: number,
): boolean {
  const openContribution = project.materialContributionRequests?.some((request) => {
    const demand = project.materialDemands?.find((candidate) => candidate.materialId === request.materialId);
    return Boolean(demand
      && projectMaterialContributionRequestHasAuthoritativeSource(state, project, request)
      && inspectProjectMaterialContributionRequest(
      state,
      project,
      request,
      atMonth,
      demand,
    ).status === 'open');
  });
  if (openContribution) return true;
  const openKnowledgeRequest = project.knowledgeRequests?.some((request) => (
    projectKnowledgeRequestHasAuthoritativeSource(state, project, request)
      && inspectProjectKnowledgeRequest(state, project, request, atMonth) === 'open'
  ));
  return Boolean(openKnowledgeRequest);
}

interface ProjectReviewTiming {
  planBasisTransitionAtMonth?: number;
  reviewDeadline: number;
  progressAnchor: number;
}

function projectReviewTiming(
  state: SimulationState,
  owner: PersonState,
  project: ProjectState,
  atMonth: number,
): ProjectReviewTiming {
  const ownerProjectIntent = [...intentsOwnedBy(state, owner.id)].reverse().find((intent) => (
    intent.projectId === project.id
    && (intent.status === 'active' || intent.status === 'suspended')
  ));
  const hibernationSuspensionActive = Boolean(ownerProjectIntent?.suspendedForHibernationConditionId
    && owner.conditions.some((condition) => condition.kind === 'dehydrated-hibernation'
      && condition.id === ownerProjectIntent.suspendedForHibernationConditionId));
  const progressAnchor = Math.max(
    project.lastProgressAtMonth,
    projectInquiryExhaustedAtMonth(project) ?? 0,
    ownerProjectIntent?.lastResumedAtMonth ?? 0,
    ownerProjectIntent?.suspendedAtMonth ?? 0,
    hibernationSuspensionActive ? atMonth : 0,
  );
  const reviewWindowMonths = Math.max(1, project.reviewAtMonth - project.createdAtMonth);
  const planBasisTransitionAtMonth = projectPlanBasisTransitionAtMonth(state, project, owner);
  const leadership = inspectProjectLeadership(project);
  const leadershipTransitionAtMonth = leadership.status === 'led'
    ? leadership.latestSuccession?.atMonth
    : undefined;
  return {
    ...(planBasisTransitionAtMonth !== undefined ? { planBasisTransitionAtMonth } : {}),
    reviewDeadline: Math.max(
      project.reviewAtMonth,
      planBasisTransitionAtMonth !== undefined
        ? planBasisTransitionAtMonth + reviewWindowMonths
        : project.reviewAtMonth,
      leadershipTransitionAtMonth !== undefined
        ? leadershipTransitionAtMonth + reviewWindowMonths
        : project.reviewAtMonth,
    ),
    progressAnchor,
  };
}

function projectReviewWindowElapsed(
  state: SimulationState,
  owner: PersonState,
  project: ProjectState,
  atMonth: number,
): ProjectReviewTiming | null {
  const timing = projectReviewTiming(state, owner, project, atMonth);
  return atMonth > timing.reviewDeadline && atMonth - timing.progressAnchor >= 4
    ? timing
    : null;
}

function projectHasCurrentRecoveryStep(
  state: SimulationState,
  owner: PersonState,
  project: ProjectState,
): boolean {
  const previewOwner = structuredClone(owner);
  const previewProject = cloneProjectForPlanning(project);
  const previewState: SimulationState = {
    ...state,
    people: state.people.map((candidate) => candidate.id === owner.id ? previewOwner : candidate),
    projects: state.projects.map((candidate) => candidate.id === project.id ? previewProject : candidate),
  };
  inheritPlanningEventOverlay(state, previewState);
  return Boolean(compileProjectStep(
    previewState,
    previewOwner,
    visibleDropsFor(previewState, previewOwner),
    previewProject,
  ));
}

function blockExplicitlyExhaustedProject(
  state: SimulationState,
  owner: PersonState,
  project: ProjectState,
  atMonth: number,
): boolean {
  if (project.status !== 'active'
    || !projectInquiryExplicitlyExhausted(project)
    || !projectReviewWindowElapsed(state, owner, project, atMonth)
    || projectHasLegitimateWait(state, owner, project, atMonth)
    || projectHasOpenBoundedExternalRequest(state, project, atMonth)) return false;
  freezeTerminalInquiryOpportunityBasis(state, owner, project, atMonth);
  project.status = 'blocked';
  project.blockedAtMonth = atMonth;
  project.blockedReason = '有限材料搜索或实体假说已经穷尽，且当前没有协作者、休眠或自然生长等待依据';
  project.reservations = [];
  project.materialDemands = [];
  endActiveLogisticsEpisode(project, atMonth, 'exhausted', 'project-blocked');
  closeProjectSearchCampaigns(project, atMonth);
  closeProjectHypothesisCampaign(project, atMonth, 'project-blocked');
  return true;
}

function closeProjectLeadershipEpisode(project: ProjectState, atMonth: number): void {
  endActiveLogisticsEpisode(project, atMonth, 'invalidated', 'leadership-vacancy');
  closeProjectSearchCampaigns(project, atMonth);
  closeProjectHypothesisCampaign(project, atMonth, 'leadership-vacancy');
  delete project.hypothesisCampaign;
  project.reservations = [];
  project.missingMaterialIds = [];
  project.materialDemands = [];
  project.materialContributionRequests = [];
  project.knowledgeRequests = [];
  project.techniqueDemonstrationRequests = [];
  project.techniqueDemonstrations = [];
  delete project.planKnowledgeId;
  delete project.inquiryOpportunityBasis;
  delete project.pressureBasis;
}

function blockProjectForMissingLead(project: ProjectState, atMonth: number, reason: string): void {
  project.status = 'blocked';
  project.blockedAtMonth = atMonth;
  project.blockedReason = reason;
  project.reservations = [];
  project.materialDemands = [];
  endActiveLogisticsEpisode(project, atMonth, 'exhausted', 'project-blocked');
  closeProjectSearchCampaigns(project, atMonth);
  closeProjectHypothesisCampaign(project, atMonth, 'project-blocked');
}

export function synchronizeProject(state: SimulationState, project: ProjectState, atMonth = state.clock.elapsedMonths): void {
  if (project.status !== 'active') {
    const terminalOwner = personById(state, projectCurrentLeadId(project) ?? project.ownerId);
    if (project.status === 'blocked' && terminalOwner) {
      freezeTerminalInquiryOpportunityBasis(state, terminalOwner, project, atMonth);
    }
    endActiveLogisticsEpisode(project, atMonth, endingStatusForProject(project), endingReasonForProject(project));
    if (project.status === 'completed') closeProjectHypothesisCampaign(project, atMonth, 'project-completed');
    else if (project.status === 'abandoned') closeProjectHypothesisCampaign(project, atMonth, 'project-abandoned');
    else if (project.status === 'blocked') closeProjectHypothesisCampaign(project, atMonth, 'project-blocked');
    return;
  }
  if (projectFunctionSatisfied(state, project)) {
    const evidenceEventIds = projectCompletionEvidence(state, project);
    completeProject(state, project, atMonth, evidenceEventIds);
    return;
  }
  const leadership = inspectProjectLeadership(project);
  if (leadership.status === 'invalid') {
    blockProjectForMissingLead(project, atMonth, `项目负责人历史无效：${leadership.reason}`);
    return;
  }
  if (leadership.status === 'vacant') {
    if (atMonth > leadership.vacancy.expiresAtMonth) {
      blockProjectForMissingLead(project, atMonth, '项目负责人死亡后，有界接任期内没有真实贡献者到场接续');
    }
    return;
  }
  const owner = personById(state, leadership.currentLeadId);
  if (!owner || !isAlive(owner)) {
    const hasSourcedContributor = projectSupportsLeadershipSuccession(project)
      && project.contributorIds.some((personId) => personId !== leadership.currentLeadId
        && Boolean(latestProjectLeadershipContribution(state, project, personId)));
    const death = owner ? projectLeadershipDeathFact(state, owner.id) : null;
    if (owner && death && hasSourcedContributor) {
      const vacancy = appendProjectLeadershipVacancy(project, death);
      if (vacancy) {
        invalidateProjectLeadershipIndex(state);
        closeProjectLeadershipEpisode(project, atMonth);
        return;
      }
    }
    if (owner) freezeTerminalInquiryOpportunityBasis(state, owner, project, atMonth);
    blockProjectForMissingLead(project, atMonth, '当前项目负责人已经无法继续行动');
    return;
  }
  refreshProjectPressure(state, project, atMonth);
  if (project.desiredFunction === 'healing') {
    const unresolved = project.beneficiaryIds.some((personId) => {
      const beneficiary = personById(state, personId);
      return Boolean(beneficiary && isAlive(beneficiary)
        && beneficiary.conditions.some((condition) => condition.kind === 'wound' || condition.kind === 'illness'));
    });
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
  const reviewTiming = projectReviewWindowElapsed(state, owner, project, atMonth);
  const exhaustedInquiryHasRecovery = Boolean(reviewTiming)
    && projectInquiryExplicitlyExhausted(project)
    && projectHasCurrentRecoveryStep(state, owner, project);
  if (reviewTiming
    && !projectHasLegitimateWait(state, owner, project, atMonth)
    && !projectHasOpenBoundedExternalRequest(state, project, atMonth)
    && !exhaustedInquiryHasRecovery) {
    freezeTerminalInquiryOpportunityBasis(state, owner, project, atMonth);
    project.status = 'blocked';
    project.blockedAtMonth = atMonth;
    project.blockedReason = reviewTiming.planBasisTransitionAtMonth !== undefined
      ? '取得新的项目计划基础后，有界阶段内仍未提交下一阶段进展'
      : '复核期内持续缺少可执行的材料、知识或空间步骤';
    project.reservations = [];
    project.materialDemands = [];
    endActiveLogisticsEpisode(project, atMonth, 'exhausted', 'project-blocked');
    closeProjectSearchCampaigns(project, atMonth);
    closeProjectHypothesisCampaign(project, atMonth, 'project-blocked');
  }
}

function isSourceBoundProjectStateTransition(
  state: SimulationState,
  project: ProjectState,
  fact: ActionFact,
): boolean {
  const basis = fact.action.kind === 'act' ? fact.action.mechanicalPowerBasis : undefined;
  const plan = project.mechanicalPowerPlan;
  const network = state.world.mechanicalPower?.networks.find((candidate) => (
    candidate.id === project.mechanicalPowerNetworkId
    && candidate.installationProjectId === project.id
    && candidate.planKey === project.mechanicalPowerPlanKey
    && candidate.fault?.faultEventId === fact.id
  ));
  return fact.status === 'progressed'
    && fact.diff.mechanicalPowerFault === true
    && fact.diff.faultKind === 'commissioning-misalignment'
    && fact.diff.projectId === project.id
    && fact.diff.planKey === project.mechanicalPowerPlanKey
    && fact.diff.networkId === project.mechanicalPowerNetworkId
    && fact.diff.sourceSegmentId === plan?.sourceSegmentId
    && basis?.mode === 'operate'
    && basis.projectId === project.id
    && basis.planKey === project.mechanicalPowerPlanKey
    && basis.networkId === project.mechanicalPowerNetworkId
    && basis.sourceSegmentId === plan?.sourceSegmentId
    && Boolean(network);
}

export function advanceProjects(state: SimulationState, atMonth = state.clock.elapsedMonths): void {
  for (const project of projectsRequiringMonthlySynchronization(state)) {
    synchronizeProject(state, project, atMonth);
  }
}

export function recordProjectAction(state: SimulationState, projectId: string, fact: ActionFact): void {
  const project = projectById(state, projectId);
  if (!project || project.status !== 'active') return;
  if (fact.action.kind === 'attend' && fact.diff.projectLeadershipSuccession === true) {
    const transition = appendProjectLeadershipSuccession(project, fact);
    if (!transition) return;
    invalidateProjectLeadershipIndex(state);
  }
  if (fact.status === 'completed'
    && fact.action.kind === 'attend'
    && fact.action.waterCurrentSegmentId === project.mechanicalPowerPlan?.sourceSegmentId
    && fact.diff.mechanicalPowerObservation === true
    && projectIsLedBy(project, fact.who)
    && !project.triggerFactIds.includes(fact.id)) {
    project.triggerFactIds.push(fact.id);
  }
  const actor = personById(state, fact.who);
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
  const knowledgeContribution = fact.status === 'completed'
    && fact.action.kind === 'communicate'
    && fact.action.content.kind === 'claim'
    && Boolean(fact.action.content.projectKnowledgeResponse)
    && fact.diff.projectKnowledgeResponse === true
    && fact.diff.projectKnowledgeProjectId === project.id
    && fact.diff.projectKnowledgeRequestEventId
      === fact.action.content.projectKnowledgeResponse?.requestEventId;
  if (fact.status === 'completed'
    && fact.action.kind === 'transfer'
    && fact.action.from.kind === 'person'
    && fact.action.from.personId === fact.who) {
    for (const request of project.materialContributionRequests ?? []) {
      if (!transferMatchesProjectMaterialRequest(request, fact)
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
  if (isSourceBoundProjectStateTransition(state, project, fact)) recordProjectProgress(project, {
    eventId: fact.id,
    atMonth: fact.atMonth,
    kind: 'action-progress',
    actorId: fact.who,
  });
  if (materialContribution) recordProjectProgress(project, {
    eventId: fact.id,
    atMonth: fact.atMonth,
    kind: 'material-contribution',
    actorId: fact.who,
    ...(episode ? { episodeId: episode.id, target: structuredClone(episode.target) } : {}),
  });
  if (knowledgeContribution) recordProjectProgress(project, {
    eventId: fact.id,
    atMonth: fact.atMonth,
    kind: 'knowledge-contribution',
    actorId: fact.who,
  });
  for (const evidence of (project.progressEvidence ?? []).filter((candidate) => (
    candidate.eventId === fact.id && candidate.actorId === fact.who
  ))) {
    recordRecurringDutyProjectProgress(state, project, fact, evidence);
  }
  if ((materialContribution || knowledgeContribution) && !project.contributorIds.includes(fact.who)) {
    project.contributorIds.push(fact.who);
    registerProjectParticipantMembership(state, project);
  }
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
    const campaignBudgetReached = episode.kind === 'search' && searchCampaignBudgetReached(
      state,
      project,
      episode.searchCampaignId,
      fact.atMonth,
      fact,
    );
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
      } else if (campaignBudgetReached
        || searchEpisodeCommittedActionIds(state, episode, fact).length >= (episode.actionBudget ?? 1)) {
        endLogisticsEpisode(project, episode, fact.atMonth, 'exhausted', 'search-budget-exhausted');
      }
    }
  }
  synchronizeProject(state, project, fact.atMonth);
}

function adoptableConstructionProjects(state: SimulationState, person: PersonState, visibleCells: Set<number>): ProjectState[] {
  const atMonth = state.clock.elapsedMonths + 1;
  return state.projects.filter((project) => project.kind === 'construction'
    && project.status === 'active'
    && !projectIsLedBy(project, person.id)
    && project.contributorIds.length < 3
    && (personHasProjectLink(state, project, person, atMonth)
      || visibleConstructionProgress(project, visibleCells)))
    .sort((left, right) => Number(personHasProjectLink(state, right, person, atMonth))
      - Number(personHasProjectLink(state, left, person, atMonth))
      || left.createdAtMonth - right.createdAtMonth
      || left.id.localeCompare(right.id));
}

function requestedMaterialProjects(state: SimulationState, person: PersonState): ProjectState[] {
  return state.projects.filter((project) => project.status === 'active'
    && !projectIsLedBy(project, person.id)
    && projectSupportsMaterialContribution(project)
    && project.materialContributionRequests?.some((request) => {
      if (!request.contributorIds.includes(person.id)) return false;
      const demand = project.materialDemands?.find((candidate) => candidate.materialId === request.materialId);
      return Boolean(demand && inspectProjectMaterialContributionRequest(
        state,
        project,
        request,
        state.clock.elapsedMonths + 1,
        demand,
      ).status === 'open');
    }));
}

function previewProjectState(
  state: SimulationState,
  project: ProjectState,
): { state: SimulationState; project: ProjectState } {
  const previewProject = cloneProjectForPlanning(project);
  const previewState: SimulationState = {
    ...state,
    projects: state.projects.map((candidate) => candidate.id === project.id ? previewProject : candidate),
  };
  inheritPlanningEventOverlay(state, previewState);
  return { state: previewState, project: previewProject };
}

/**
 * Compile one owner project against isolated person/project clones. A caller
 * may pass a person clone with planning-only knowledge changes; compiler-made
 * demands, reservations and logistics campaigns stay non-authoritative until
 * its returned primitive action is selected and executed in the real world.
 */
export function previewOwnedProjectStep(
  state: SimulationState,
  person: PersonState,
  projectId: string,
): ProjectStep | null {
  const project = projectById(state, projectId);
  if (!project || project.status !== 'active' || !projectIsLedBy(project, person.id)) return null;
  const previewPerson = structuredClone(person);
  const previewProject = cloneProjectForPlanning(project);
  const previewState: SimulationState = {
    ...state,
    people: state.people.map((candidate) => (
      candidate.id === previewPerson.id ? previewPerson : candidate
    )),
    projects: state.projects.map((candidate) => (
      candidate.id === previewProject.id ? previewProject : candidate
    )),
  };
  inheritPlanningEventOverlay(state, previewState);
  synchronizeProject(previewState, previewProject, state.clock.elapsedMonths + 1);
  if (previewProject.status !== 'active') return null;
  const step = compileProjectStep(
    previewState,
    previewPerson,
    visibleDropsFor(previewState, previewPerson),
    previewProject,
  );
  if (!step) return null;
  return structuredClone({
    ...step,
    ...(step.planKnowledgeId
      ? { planKnowledgeId: step.planKnowledgeId }
      : previewProject.planKnowledgeId
        ? { planKnowledgeId: previewProject.planKnowledgeId }
        : {}),
  });
}

/**
 * Planning previews may prove an already-authoritative finite campaign has no
 * remaining candidate. Commit only that terminal fact; routes, demands and
 * newly generated preview state remain non-authoritative until an action is
 * actually selected.
 */
function commitPreviewTerminalInquiryCampaign(
  project: ProjectState,
  preview: ProjectState,
): void {
  const previewHypothesis = preview.hypothesisCampaign;
  const hypothesis = project.hypothesisCampaign;
  if (previewHypothesis?.status === 'exhausted'
    && hypothesis?.status === 'active'
    && hypothesis.id === previewHypothesis.id) {
    hypothesis.status = 'exhausted';
    hypothesis.endedAt = previewHypothesis.endedAt;
    hypothesis.endingReason = previewHypothesis.endingReason;
    delete hypothesis.activeCandidateKey;
  }
  for (const previewSearch of preview.searchCampaigns ?? []) {
    if (previewSearch.status !== 'exhausted') continue;
    const search = project.searchCampaigns?.find((candidate) => (
      candidate.id === previewSearch.id
      && candidate.basisKey === previewSearch.basisKey
      && candidate.status === 'active'
    ));
    if (!search) continue;
    search.status = 'exhausted';
    search.closedAt = previewSearch.closedAt;
  }
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
  for (const project of state.projects) {
    if (!projectSupportsLeadershipSuccession(project)) continue;
    const basis = buildProjectLeadershipSuccessionBasis(
      state, person, project, state.clock.elapsedMonths + 1,
    );
    if (!basis || !visibleCells.includes(basis.site.cellId)) continue;
    const path = findStandingPath(state.world.grid, person.position, basis.site);
    if (!path.length) continue;
    const targetPosition = projectLeadershipInspectionPosition(basis.site);
    const atSite = person.position.cellId === basis.site.cellId && person.position.z === basis.site.z;
    options.push(atSite ? {
      id: `inspect-project-leadership:${basis.projectId}:${basis.vacancyTransitionId}:${person.id}`,
      summary: `亲自检查固定工地并考虑接续“${project.summary}”`,
      reason: '本人真实参与过该项目，也有来源地知道前任负责人死亡；只有亲自到场检查后才会自愿承担后续责任',
      goal: { kind: 'knowledge', factId: projectLeadershipInspectionFactId(basis), minConfidence: 55 },
      nextAction: {
        kind: 'attend',
        target: { kind: 'voxel', position: targetPosition },
        projectLeadershipSuccession: structuredClone(basis),
      },
      target: { kind: 'voxel', position: targetPosition },
      estimatedDuration: 'one-month',
      sourceFactIds: [...basis.sourceFactIds],
      projectPressure: Math.max(42, project.pressure),
      domain: 'strategic',
      semantics: {
        version: 'action-option-semantics-v1',
        obligation: 'optional',
        planningChannel: 'ordinary',
        purpose: 'project',
        minimumLifeStage: 'learning-child',
        needKinds: ['bereavement', 'capability', 'generativity', 'autonomy'],
      },
    } : {
      id: `approach-project-leadership:${basis.projectId}:${basis.vacancyTransitionId}:${person.id}`,
      summary: `回到固定工地查看是否接续“${project.summary}”`,
      reason: '本人真实参与过该固定工地，也有来源地知道前任负责人死亡；先沿可达路线回到现场，不在远处自动取得负责人身份',
      goal: { kind: 'at-cell', cellId: basis.site.cellId },
      nextAction: { kind: 'move', toCellId: basis.site.cellId, toZ: basis.site.z },
      target: { kind: 'voxel', position: targetPosition },
      estimatedDuration: path.length <= 15 ? 'one-month' : 'several-months',
      estimatedMonths: Math.max(1, Math.ceil((path.length - 1) / 15)),
      sourceFactIds: [...basis.sourceFactIds],
      projectPressure: Math.max(40, project.pressure - 4),
      domain: 'strategic',
      semantics: {
        version: 'action-option-semantics-v1',
        obligation: 'optional',
        planningChannel: 'ordinary',
        purpose: 'project',
        minimumLifeStage: 'learning-child',
        needKinds: ['bereavement', 'capability', 'generativity', 'autonomy'],
      },
    });
    break;
  }
  const own = projectsLedBy(state, person.id).filter((project) => project.status === 'active');
  for (const project of own) {
    if (projectFunctionSatisfied(state, project)) continue;
    const preview = previewProjectState(state, project);
    const step = compileProjectStep(preview.state, person, visibleDrops, preview.project);
    if (step) options.push(projectOption(preview.project, step));
    else if (projectInquiryExplicitlyExhausted(preview.project)) {
      commitPreviewTerminalInquiryCampaign(project, preview.project);
      blockExplicitlyExhaustedProject(state, person, project, state.clock.elapsedMonths + 1);
    }
  }
  if (options.length || own.some((project) => project.status === 'active')) return options;

  // A witnessed failure of the shelter currently being used belongs ahead of
  // optional work on somebody else's structure. The proposal still has to
  // compile a legal material/logistics step before it becomes an option.
  const pressureView: ProjectPressureView = { visibleCells, visibleDrops, visiblePeople };
  const adaptation = shelterAdaptationProposal(state, person, visiblePeople, pressureView);
  if (adaptation) {
    const visible = new Set(visibleCells);
    const atMonth = state.clock.elapsedMonths + 1;
    const overlappingProjects = state.projects.filter((project) => activeProjectOverlapsLocalProposal(
      state,
      project,
      person,
      adaptation.desiredFunction,
      adaptation.beneficiaryIds,
      adaptation.site,
      adaptation.targetKnowledgeId,
      visible,
      atMonth,
    ));
    if (overlappingProjects.length) {
      const adoptableIds = new Set(adoptableConstructionProjects(state, person, visible)
        .map((project) => project.id));
      for (const project of overlappingProjects.filter((candidate) => adoptableIds.has(candidate.id))) {
        const preview = previewProjectState(state, project);
        const step = compileProjectStep(preview.state, person, visibleDrops, preview.project);
        if (step) return [{
          ...projectOption(preview.project, step),
          reason: `${step.reason}；当前住所已有局部重叠的遮蔽项目，继续同一结构比另开适应项目更有用`,
          projectPressure: Math.max(35, project.pressure - 8),
        }];
      }
      return [];
    }
    const project = instantiateProject(adaptation);
    const step = compileProjectStep(state, person, visibleDrops, project);
    if (step) return [projectOption(project, step, adaptation)];
  }

  for (const project of adoptableConstructionProjects(state, person, new Set(visibleCells))) {
    const preview = previewProjectState(state, project);
    const step = compileProjectStep(preview.state, person, visibleDrops, preview.project);
    if (step) {
      const linked = personHasProjectLink(
        state,
        project,
        person,
        state.clock.elapsedMonths + 1,
      );
      options.push({
        ...projectOption(preview.project, step),
        reason: linked
          ? `${step.reason}；本人是该项目的受益者、既有贡献者，或收到过仍有效的项目请求`
          : `看见${personById(state, project.ownerId)?.name ?? '他人'}在可见工地留下真实施工进展；继续同一结构比另开重复项目更有用`,
        projectPressure: Math.max(35, project.pressure - 8),
      });
      break;
    }
  }
  if (options.length) return options;

  const completedFunctions = new Set<ProjectFunction>([
    ...projectsLedBy(state, person.id)
      .filter((project) => project.status === 'completed')
      .map((project) => project.desiredFunction),
    ...(person.cognition?.needResolutionEpisodes ?? [])
      .map((episode) => episode.desiredFunction),
  ]);
  const proposals = deriveProjectProposals(state, person, visibleCells, visibleDrops, visiblePeople)
    .map(projectProposalWithFunctionIdentity);
  for (const pressureGroup of projectProposalPressureGroups(proposals)) {
    const executable = pressureGroup.flatMap((candidate) => {
      const project = instantiateProject(candidate);
      const step = compileProjectStep(state, person, visibleDrops, project);
      return step && openingStepUsesRenewalCommitment(state, person, project, step)
        ? [{ proposal: candidate, project, step }]
        : [];
    });
    for (const candidate of rankExecutableProjectFrontier(executable, completedFunctions)) {
      options.push(projectOption(candidate.project, candidate.step, candidate.proposal));
      if (options.length >= 2) return options;
    }
  }
  return options;
}

export interface ProjectDecisionContext {
  person: PersonState;
  visibleCells: readonly number[];
  atMonth: number;
}

export function ensureProject(
  state: SimulationState,
  proposal: ProjectProposal,
  decisionContext?: ProjectDecisionContext,
): ProjectState {
  const existing = projectById(state, proposal.id);
  if (existing) return existing;
  if (decisionContext) {
    const overlapping = state.projects.find((project) => activeProjectOverlapsLocalProposal(
      state,
      project,
      decisionContext.person,
      proposal.desiredFunction,
      proposal.beneficiaryIds,
      proposal.site,
      proposal.targetKnowledgeId,
      new Set(decisionContext.visibleCells),
      decisionContext.atMonth,
    ));
    if (overlapping) {
      overlapping.beneficiaryIds = [...new Set([
        ...overlapping.beneficiaryIds,
        ...proposal.beneficiaryIds,
      ])];
      overlapping.triggerFactIds = [...new Set([
        ...overlapping.triggerFactIds,
        ...proposal.triggerFactIds,
      ])];
      return overlapping;
    }
  }
  const created = instantiateProject(proposal);
  state.projects.push(created);
  registerProjectParticipantMembership(state, created);
  return created;
}

export function recompileProjectNextAction(state: SimulationState, person: PersonState, projectId: string): PrimitiveAction | null {
  const project = projectById(state, projectId);
  if (!project || project.status !== 'active') return null;
  synchronizeProject(state, project, state.clock.elapsedMonths + 1);
  if (project.status !== 'active') return null;
  const step = compileProjectStep(state, person, visibleDropsFor(state, person), project);
  if (!step) {
    if (projectIsLedBy(project, person.id)) {
      const explicitlyExhausted = projectInquiryExplicitlyExhausted(project);
      const legitimateWait = projectHasLegitimateWait(
        state,
        person,
        project,
        state.clock.elapsedMonths + 1,
      );
      const blockedForExhaustion = blockExplicitlyExhaustedProject(
        state,
        person,
        project,
        state.clock.elapsedMonths + 1,
      );
      const awaitingInquiryReview = explicitlyExhausted
        && project.status === 'active'
        && !blockedForExhaustion;
      if (!legitimateWait && !awaitingInquiryReview) {
        project.missingMaterialIds = [];
        project.materialDemands = [];
        project.reservations = [];
      }
      if (blockedForExhaustion) return null;
    } else {
      project.reservations = project.reservations.filter((reservation) => reservation.personId !== person.id);
    }
    return null;
  }
  if (projectIsLedBy(project, person.id)) {
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
    || Boolean(option.projectId && projectById(state, option.projectId)?.kind === 'construction'));
}

export function knownProductionOutputs(person: PersonState): MaterialId[] {
  return inventoryCombinationRules()
    .filter((rule) => person.knowledge.some((fact) => fact.id === inventoryCombinationTechniqueId(rule) && fact.confidence >= 55))
    .map((rule) => rule.output.materialId);
}
