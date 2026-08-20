import type { ActionOption, PrimitiveAction } from '../domain/action';
import { inventoryCombinationRules, inventoryCombinationTechniqueId } from '../domain/interaction-rules';
import type { MaterialId } from '../domain/material';
import type { ActionFact, DropState, SimulationState } from '../domain/model';
import { isAlive, type PersonState } from '../domain/person';
import {
  cloneProjectForPlanning,
  instantiateProject,
  type ProjectProposal,
  type ProjectState,
} from '../domain/project';
import {
  inspectProjectMaterialContributionRequest,
  transferMatchesProjectMaterialRequest,
} from '../domain/project-material-request';
import type { ProjectPressureView } from './project-pressure';
import {
  closeProjectHypothesisCampaign,
  recordProjectHypothesisAttempt,
  recordProjectHypothesisVerification,
} from './project-hypotheses';
import { projectCompletionEvidence, projectFunctionSatisfied } from './projects/project-completion';
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
} from './projects/project-step-compiler';
export {
  buildProjectInquiryOpportunityBasis,
  hasCausalShelterAdaptationNeed,
  projectFunctionSatisfied,
  refreshProjectPressure,
  visibleReachableSearchDestination,
};

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
  if (projectFunctionSatisfied(state, project)) {
    const evidenceEventIds = projectCompletionEvidence(state, project);
    completeProject(state, project, atMonth, evidenceEventIds);
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
  const ownerProjectIntent = [...state.intents].reverse().find((intent) => intent.ownerId === project.ownerId
    && intent.projectId === project.id
    && (intent.status === 'active' || intent.status === 'suspended'));
  const hibernationSuspensionActive = Boolean(ownerProjectIntent?.suspendedForHibernationConditionId
    && owner.conditions.some((condition) => condition.kind === 'dehydrated-hibernation'
      && condition.id === ownerProjectIntent.suspendedForHibernationConditionId));
  const progressAnchor = Math.max(
    project.lastProgressAtMonth,
    ownerProjectIntent?.lastResumedAtMonth ?? 0,
    ownerProjectIntent?.suspendedAtMonth ?? 0,
    hibernationSuspensionActive ? atMonth : 0,
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
    && project.ownerId !== person.id
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
    && project.ownerId !== person.id
    && project.need === 'alloy-capability'
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
          : `看见${state.people.find((candidate) => candidate.id === project.ownerId)?.name ?? '他人'}在可见工地留下真实施工进展；继续同一结构比另开重复项目更有用`,
        projectPressure: Math.max(35, project.pressure - 8),
      });
      break;
    }
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
  const existing = state.projects.find((project) => project.id === proposal.id);
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
