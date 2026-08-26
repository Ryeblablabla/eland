import type { SimulationState, WorldEvent } from '../src/game/eland/simulation';
import { committedHistoryView } from '../src/game/eland/domain/history';
import { Material, materialDefinition, materialHas } from '../src/game/eland/domain/material';
import { hypothesisMetrics } from './evolution-artifacts/hypothesis-metrics';
import { objectRecord } from './evolution-artifacts/object-record';

export interface EvolutionCheckpoint {
  month: number;
  eventCount: number;
  livingPeople: number;
  totalPeople: number;
  stage: string;
  civilizationIndex: SimulationState['civilization']['civilizationIndex'];
  milestoneIds: string[];
  ruleDecisions: number;
  modelDecisions: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The only prefix-history state consumed by `checkpointFor`.
 *
 * All other checkpoint fields are snapshots of the current authoritative
 * shell (plus the explicit token-usage input), so a bounded history reducer
 * must carry exactly these three scalars and no observer-facing stage data.
 */
export interface EvolutionCheckpointDecisionAccumulator {
  readonly eventCount: number;
  readonly ruleDecisions: number;
  readonly modelDecisions: number;
}

export interface EvolutionTurningPoint {
  id: string;
  month: number;
  kind: 'milestone' | 'birth' | 'death';
  title: string;
  summary: string;
  evidenceEventIds: string[];
  personIds: string[];
}

export interface EvolutionPath {
  schemaVersion: 2;
  runId: string;
  provider: 'local' | 'kimi';
  model: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  updatedAt: string;
  fromMonth: number;
  requestedEndMonth: number;
  reachedMonth: number;
  checkpoints: EvolutionCheckpoint[];
  turningPoints: EvolutionTurningPoint[];
  failure?: string;
}

export interface EvolutionReport {
  schemaVersion: 4;
  runId: string;
  generatedAt: string;
  throughMonth: number;
  status: SimulationState['civilization']['status'];
  outcome: SimulationState['civilization']['outcome'] | null;
  initialPopulation: number;
  finalPopulation: number;
  births: number;
  reproductionOffers: number;
  reproductionAcceptances: number;
  reproductionAttempts: number;
  reproductionConceptions: number;
  deaths: number;
  childDeaths: number;
  childExposureDeaths: number;
  kinRelatedBirths: number;
  inheritedIllnesses: number;
  kinshipRiskLearners: number;
  civilizationIndex: SimulationState['civilization']['civilizationIndex'];
  stableEras: number;
  chaoticEras: number;
  correctPredictions: number;
  incorrectPredictions: number;
  dehydrationHibernations: number;
  assistedDependentHibernations: number;
  wildlifePopulation: number;
  animalsHunted: number;
  animalAttacks: number;
  completedActions: number;
  actionPersonMonths: number;
  projectActionPersonMonths: number;
  projectActionMonthShare: number | null;
  ruleDecisions: number;
  kimiDecisions: number;
  strategicIntents: number;
  socialIntents: number;
  survivalReflexActions: number;
  communications: number;
  containersBuilt: number;
  standingContainers: number;
  containerTransfers: number;
  storedUnits: number;
  projectsStarted: number;
  projectsCompleted: number;
  projectsBlocked: number;
  inquiryOpportunityBasisProjects: number;
  inquiryOpportunityBasisCoverage: number;
  inquiryOpportunityFailedProjects: number;
  inquiryOpportunityTerminalBasisProjects: number;
  inquiryOpportunityTerminalBasisCoverage: number;
  inquiryOpportunityRenewalProjects: number;
  inquiryOpportunityRenewalKeys: number;
  inquiryOpportunityReopenWithoutRenewalViolations: number;
  inquiryOpportunityUnresolvedInheritedProjects: number;
  inquiryOpportunityInheritedActorMismatches: number;
  inquiryOpportunityInheritedFunctionMismatches: number;
  inquiryOpportunityInheritedStatusMismatches: number;
  inquiryOpportunityRenewalKeyMismatches: number;
  hypothesisReliableNoResponseExcessAttempts: number;
  inquiryOpportunityRenewalHypothesisProjects: number;
  inquiryOpportunityRenewalHypothesisCandidateCoverage: number;
  inquiryOpportunityRenewalHypothesisAttemptProjects: number;
  inquiryOpportunityRenewalHypothesisFirstAttemptCoverage: number;
  inquiryOpportunityConstructionRenewalHypothesisProjects: number;
  inquiryOpportunityConstructionRenewalHypothesisCandidateCoverage: number;
  inquiryOpportunityConstructionRenewalHypothesisAttemptProjects: number;
  inquiryOpportunityConstructionRenewalHypothesisFirstAttemptCoverage: number;
  inquiryOpportunitySourceBasisProjects: number;
  inquiryOpportunitySourceBasisCoverage: number;
  inquiryOpportunityRenewalCommitmentProjects: number;
  inquiryOpportunityRenewalCommitmentProjectCoverage: number;
  inquiryOpportunityRenewalCommitmentSourceCoverage: number;
  inquiryOpportunityUnresolvedSources: number;
  inquiryOpportunityRenewalCommitmentActorMismatches: number;
  inquiryOpportunityRenewalCommitmentFunctionMismatches: number;
  inquiryOpportunityRenewalCommitmentInheritedStatusMismatches: number;
  inquiryOpportunityRenewalFirstCandidateExactSourceCoverage: number;
  inquiryOpportunityRenewalFirstAttemptExactSourceCoverage: number;
  inquiryOpportunityRenewalFallbackBeforeCommitmentViolations: number;
  inquiryOpportunityMaterialOnlyCommitmentAttributionViolations: number;
  inquiryOpportunityConstructionRenewalFirstCandidateExactSourceCoverage: number;
  inquiryOpportunityConstructionRenewalFirstAttemptExactSourceCoverage: number;
  inquiryOpportunityConstructionRenewalFallbackBeforeCommitmentViolations: number;
  inquiryOpportunityConstructionMaterialOnlyCommitmentAttributionViolations: number;
  techniqueDemonstrationRequestAttempts: number;
  techniqueDemonstrationRequests: number;
  techniqueDemonstrationUniqueProjectTeachers: number;
  techniqueDemonstrationDuplicateRequests: number;
  techniqueDemonstrationActions: number;
  techniqueDemonstrationResponses: number;
  techniqueDemonstrationBases: number;
  techniqueDemonstrationSourcedBases: number;
  techniqueDemonstrationSourceCoverage: number;
  techniqueDemonstrationExactSourceCoverage: number;
  techniqueDemonstrationTentativeLessons: number;
  techniqueDemonstrationDirectReliableViolations: number;
  techniqueDemonstrationUnresolvedBases: number;
  techniqueDemonstrationUnresolvedRequestEvents: number;
  techniqueDemonstrationUnresolvedActionEvents: number;
  techniqueDemonstrationRequestPersonMismatches: number;
  techniqueDemonstrationRequestProjectMismatches: number;
  techniqueDemonstrationRequestFunctionMismatches: number;
  techniqueDemonstrationDemonstratorMismatches: number;
  techniqueDemonstrationDemonstratorReliabilityMismatches: number;
  techniqueDemonstrationLearnerMismatches: number;
  techniqueDemonstrationProjectMismatches: number;
  techniqueDemonstrationFunctionMismatches: number;
  techniqueDemonstrationColocationMismatches: number;
  techniqueDemonstrationTechniqueMismatches: number;
  techniqueDemonstrationOperationMismatches: number;
  techniqueDemonstrationResponseMismatches: number;
  techniqueDemonstrationOrderViolations: number;
  techniqueDemonstrationSourceMismatches: number;
  techniqueDemonstrationExactSourceMismatches: number;
  techniqueImitationAttempts: number;
  techniqueImitationResponses: number;
  techniqueImitationExactSourceCoverage: number;
  techniqueImitationUnresolvedBases: number;
  techniqueImitationSourceMismatches: number;
  techniqueImitationActorMismatches: number;
  techniqueImitationProjectMismatches: number;
  techniqueImitationTechniqueMismatches: number;
  techniqueImitationOperationMismatches: number;
  techniqueImitationResponseMismatches: number;
  techniqueImitationOrderViolations: number;
  techniqueImitationExactSourceMismatches: number;
  techniqueDemonstrationReliableLearners: number;
  techniqueReliableWithoutOwnImitationViolations: number;
  completeTechniqueLearningChains: number;
  completeTechniqueLearningProjectProgressChains: number;
  completeTechniqueLearningProjectCompletionChains: number;
  generationGtZeroCausalReliableLearners: number;
  techniqueTeachingActions: number;
  techniqueTeachingLearners: number;
  techniqueTeachingUnderageViolations: number;
  techniqueTeachingUnreliableTeacherViolations: number;
  groundedConversationOpenings: number;
  groundedConversationResponses: number;
  groundedConversationResponseCoverage: number;
  groundedConversationUniqueTopics: number;
  groundedConversationParticipants: number;
  groundedConversationGenerationGtZeroParticipants: number;
  groundedConversationSourcedOpenings: number;
  groundedConversationSourceCoverage: number;
  groundedConversationDuplicateBases: number;
  groundedConversationUnresolvedSources: number;
  groundedConversationParticipantMismatches: number;
  groundedConversationResponseMismatches: number;
  groundedConversationRelationshipEffectMismatches: number;
  groundedConversationBlockedAttempts: number;
  hypothesisCampaigns: number;
  hypothesisCandidates: number;
  hypothesisAttempts: number;
  hypothesisResponses: number;
  hypothesisNoResponses: number;
  hypothesisExhaustedCampaigns: number;
  hypothesisFirstAttemptResponses: number;
  hypothesisFirstAttemptNoResponses: number;
  hypothesisCombineAttempts: number;
  hypothesisCombineResponses: number;
  hypothesisCombineNoResponses: number;
  hypothesisExertAttempts: number;
  hypothesisExertResponses: number;
  hypothesisExertNoResponses: number;
  hypothesisExposeAttempts: number;
  hypothesisExposeResponses: number;
  hypothesisExposeNoResponses: number;
  hypothesisConnectManipulatorShapesCandidates: number;
  hypothesisConnectManipulatorShapesAttempts: number;
  hypothesisConnectManipulatorShapesResponses: number;
  hypothesisConnectManipulatorShapesNoResponses: number;
  hypothesisConnectFlexibleLayersCandidates: number;
  hypothesisConnectFlexibleLayersAttempts: number;
  hypothesisConnectFlexibleLayersResponses: number;
  hypothesisConnectFlexibleLayersNoResponses: number;
  hypothesisAssembleBalancedSuspensionCandidates: number;
  hypothesisAssembleBalancedSuspensionAttempts: number;
  hypothesisAssembleBalancedSuspensionResponses: number;
  hypothesisAssembleBalancedSuspensionNoResponses: number;
  hypothesisShapeRepeatableReferenceCandidates: number;
  hypothesisShapeRepeatableReferenceAttempts: number;
  hypothesisShapeRepeatableReferenceResponses: number;
  hypothesisShapeRepeatableReferenceNoResponses: number;
  hypothesisAssembleFlowDrivenRotorCandidates: number;
  hypothesisAssembleFlowDrivenRotorAttempts: number;
  hypothesisAssembleFlowDrivenRotorResponses: number;
  hypothesisAssembleFlowDrivenRotorNoResponses: number;
  hypothesisShapeRigidRotatingConnectorCandidates: number;
  hypothesisShapeRigidRotatingConnectorAttempts: number;
  hypothesisShapeRigidRotatingConnectorResponses: number;
  hypothesisShapeRigidRotatingConnectorNoResponses: number;
  hypothesisSeekLocalHeatCandidates: number;
  hypothesisSeekLocalHeatAttempts: number;
  hypothesisSeekLocalHeatResponses: number;
  hypothesisSeekLocalHeatNoResponses: number;
  hypothesisShapePortableSurfaceCandidates: number;
  hypothesisShapePortableSurfaceAttempts: number;
  hypothesisShapePortableSurfaceResponses: number;
  hypothesisShapePortableSurfaceNoResponses: number;
  hypothesisTransformSubjectWithObservedHeatCandidates: number;
  hypothesisTransformSubjectWithObservedHeatAttempts: number;
  hypothesisTransformSubjectWithObservedHeatResponses: number;
  hypothesisTransformSubjectWithObservedHeatNoResponses: number;
  hypothesisCandidatesWithRoleBasis: number;
  hypothesisAttemptsWithRoleBasis: number;
  hypothesisCandidateRoleBasisCoverage: number;
  hypothesisAttemptRoleBasisCoverage: number;
  hypothesisCandidatesWithEntityRoleBasis: number;
  hypothesisAttemptsWithEntityRoleBasis: number;
  hypothesisActionDiffsWithEntityRoleBasis: number;
  hypothesisCandidateEntityRoleBasisCoverage: number;
  hypothesisAttemptEntityRoleBasisCoverage: number;
  hypothesisActionDiffEntityRoleBasisCoverage: number;
  hypothesisCandidatesMissingQuestionKind: number;
  hypothesisCandidatesMissingRoleBasis: number;
  hypothesisAttemptsMissingQuestionKind: number;
  hypothesisAttemptsMissingRoleBasis: number;
  hypothesisCandidateAttemptRoleBasisMismatches: number;
  hypothesisActionDiffRoleBasisMismatches: number;
  hypothesisNonFiniteRoleScores: number;
  hypothesisQuestionOperationMismatches: number;
  hypothesisExertVerifiedResponseToolAttempts: number;
  hypothesisExertVerifiedResponseInputAttempts: number;
  hypothesisExactEntityVerifiedResponseToolAttempts: number;
  hypothesisExactEntityVerifiedResponseInputAttempts: number;
  hypothesisMaterialOnlyVerifiedResponseAttributionViolations: number;
  hypothesisVerifiedResponses: number;
  hypothesisResponseDrivenTransitions: number;
  hypothesisUniquePairs: number;
  hypothesisUniqueSignatures: number;
  hypothesisUnresolvedProjects: number;
  hypothesisProjectMismatches: number;
  hypothesisUnresolvedActors: number;
  hypothesisActorMismatches: number;
  hypothesisUnresolvedCampaigns: number;
  hypothesisCampaignMismatches: number;
  hypothesisUnresolvedActionEvents: number;
  hypothesisActionMismatches: number;
  hypothesisOperationMismatches: number;
  hypothesisDuplicateProjectPairs: number;
  hypothesisDuplicateProjectSignatures: number;
  hypothesisBudgetExceeds: number;
  hypothesisTotalBudgetExceeds: number;
  hypothesisNoResponseBudgetExceeds: number;
  hypothesisResponseBudgetExceeds: number;
  hypothesisAttemptOrdinalMismatches: number;
  hypothesisActionDiffPairMismatches: number;
  hypothesisActionDiffSignatureMismatches: number;
  hypothesisActionDiffOutcomeMismatches: number;
  hypothesisMissingSourceKeys: number;
  hypothesisReliableKnowledgeViolations: number;
  projectLogisticsEpisodes: number;
  projectLogisticsFulfilled: number;
  projectLogisticsExhausted: number;
  projectSearchEpisodes: number;
  projectDropEpisodes: number;
  projectLogisticsActionEvents: number;
  jointProjectsCompleted: number;
  productionProjectsCompleted: number;
  constructionProjectsCompleted: number;
  totalStructures: number;
  completedStructures: number;
  constructionPlacements: number;
  movementActions: number;
  movementActionShare: number;
  spearsCrafted: number;
  leatherClothingCrafted: number;
  herbalMedicineCrafted: number;
  cookedFoodProduced: number;
  recordsCreated: number;
  recordUseShares: number;
  recordUseAcquisitions: number;
  recordUseReads: number;
  recordUseExperiments: number;
  recordUseExperimentSuccesses: number;
  recordUseProjectProgresses: number;
  completeRecordUseChains: number;
  recordUseUniqueBases: number;
  recordUseActionsMissingBasisKey: number;
  recordUseUnresolvedProjects: number;
  recordUseReaderMismatches: number;
  recordUseTechniqueMismatches: number;
  recordUseAcquisitionSourceMismatches: number;
  recordUseReadsWithoutAcquisition: number;
  recordUseExperimentsWithoutRead: number;
  recordUseProjectMismatches: number;
  recordUseUnresolvedActionEvents: number;
  recordUseAuthorMismatches: number;
  recordUsePayloadMismatches: number;
  recordUseCodebookMismatches: number;
  recordUseReadUnderstandingViolations: number;
  recordUseReadReliabilityViolations: number;
  recordUseExperimentOutputMismatches: number;
  recordUseExperimentConfidenceMismatches: number;
  functionalInstitutions: number;
  inputTokens: number;
  outputTokens: number;
  milestones: SimulationState['derived']['milestones'];
  turningPoints: EvolutionTurningPoint[];
  checkpoints: EvolutionCheckpoint[];
}

function eventById(state: SimulationState): Map<string, WorldEvent> {
  return new Map(state.world.past.map((event) => [event.id, event]));
}

function projectLogisticsMetrics(state: SimulationState): {
  projectLogisticsEpisodes: number;
  projectLogisticsFulfilled: number;
  projectLogisticsExhausted: number;
  projectSearchEpisodes: number;
  projectDropEpisodes: number;
  projectLogisticsActionEvents: number;
} {
  const projects = (state as unknown as { projects?: unknown }).projects;
  const episodes = (Array.isArray(projects) ? projects : []).flatMap((project) => {
    if (!project || typeof project !== 'object') return [];
    const value = (project as { logisticsEpisodes?: unknown }).logisticsEpisodes;
    if (!Array.isArray(value)) return [];
    return value.filter((episode): episode is Record<string, unknown> => (
      episode !== null && typeof episode === 'object' && !Array.isArray(episode)
    ));
  });
  const actionEventIds = new Set<string>();
  for (const episode of episodes) {
    if (!Array.isArray(episode.actionEventIds)) continue;
    for (const eventId of episode.actionEventIds) {
      if (typeof eventId === 'string') actionEventIds.add(eventId);
    }
  }
  const hasValue = (episode: Record<string, unknown>, field: 'kind' | 'status', value: string) => (
    typeof episode[field] === 'string' && episode[field].trim().toLowerCase() === value
  );
  return {
    projectLogisticsEpisodes: episodes.length,
    projectLogisticsFulfilled: episodes.filter((episode) => hasValue(episode, 'status', 'fulfilled')).length,
    projectLogisticsExhausted: episodes.filter((episode) => hasValue(episode, 'status', 'exhausted')).length,
    projectSearchEpisodes: episodes.filter((episode) => hasValue(episode, 'kind', 'search')).length,
    projectDropEpisodes: episodes.filter((episode) => hasValue(episode, 'kind', 'drop')).length,
    projectLogisticsActionEvents: actionEventIds.size,
  };
}

function observerBehaviorMetrics(state: SimulationState): {
  actionPersonMonths: number;
  projectActionPersonMonths: number;
  projectActionMonthShare: number | null;
  reproductionOffers: number;
  reproductionAcceptances: number;
  reproductionAttempts: number;
  reproductionConceptions: number;
} {
  const rawState = state as unknown as { intents?: unknown; world?: { past?: unknown } };
  const intents = Array.isArray(rawState.intents)
    ? rawState.intents.map(objectRecord).filter((intent): intent is Record<string, unknown> => intent !== null)
    : [];
  const historicalEvents = rawState.world?.past;
  const events = Array.isArray(historicalEvents)
    ? historicalEvents.map(objectRecord).filter((event): event is Record<string, unknown> => event !== null)
    : [];
  const projectIntentIds = new Set(intents.flatMap((intent) => (
    typeof intent.id === 'string' && typeof intent.projectId === 'string' && intent.projectId.length > 0
      ? [intent.id]
      : []
  )));
  const actionPersonMonths = new Set<string>();
  const projectActionPersonMonths = new Set<string>();
  const reproductionOfferIds = new Set<string>();
  const reproductionAcceptanceRefs: string[] = [];
  let reproductionOffers = 0;
  let reproductionAttempts = 0;
  let reproductionConceptions = 0;

  for (const event of events) {
    if (event.kind !== 'action') continue;
    const intentId = typeof event.intentId === 'string' && event.intentId.length > 0 ? event.intentId : null;
    if (intentId && typeof event.who === 'string' && typeof event.atMonth === 'number' && Number.isFinite(event.atMonth)) {
      const personMonth = `${event.who}\u0000${event.atMonth}`;
      actionPersonMonths.add(personMonth);
      if (projectIntentIds.has(intentId)) projectActionPersonMonths.add(personMonth);
    }

    const action = objectRecord(event.action);
    if (!action) continue;
    if (event.status === 'completed' && action.kind === 'act' && action.operation === 'reproduce') {
      reproductionAttempts += 1;
      if (objectRecord(event.diff)?.conceived === true) reproductionConceptions += 1;
      continue;
    }
    if (event.status !== 'completed' || action.kind !== 'communicate') continue;
    const content = objectRecord(action.content);
    if (!content) continue;
    if (content.kind === 'offer' && objectRecord(content.proposal)?.kind === 'reproduce') {
      reproductionOffers += 1;
      if (typeof content.id === 'string') reproductionOfferIds.add(content.id);
    } else if (content.kind === 'accept' && typeof content.referenceId === 'string') {
      reproductionAcceptanceRefs.push(content.referenceId);
    }
  }

  const projectActionMonthShare = actionPersonMonths.size > 0
    ? Math.round(projectActionPersonMonths.size / actionPersonMonths.size * 10_000) / 100
    : null;
  return {
    actionPersonMonths: actionPersonMonths.size,
    projectActionPersonMonths: projectActionPersonMonths.size,
    projectActionMonthShare,
    reproductionOffers,
    reproductionAcceptances: reproductionAcceptanceRefs.filter((referenceId) => reproductionOfferIds.has(referenceId)).length,
    reproductionAttempts,
    reproductionConceptions,
  };
}

function recordUseMetrics(state: SimulationState): {
  recordUseShares: number;
  recordUseAcquisitions: number;
  recordUseReads: number;
  recordUseExperiments: number;
  recordUseExperimentSuccesses: number;
  recordUseProjectProgresses: number;
  completeRecordUseChains: number;
  recordUseUniqueBases: number;
  recordUseActionsMissingBasisKey: number;
  recordUseUnresolvedProjects: number;
  recordUseReaderMismatches: number;
  recordUseTechniqueMismatches: number;
  recordUseAcquisitionSourceMismatches: number;
  recordUseReadsWithoutAcquisition: number;
  recordUseExperimentsWithoutRead: number;
  recordUseProjectMismatches: number;
  recordUseUnresolvedActionEvents: number;
  recordUseAuthorMismatches: number;
  recordUsePayloadMismatches: number;
  recordUseCodebookMismatches: number;
  recordUseReadUnderstandingViolations: number;
  recordUseReadReliabilityViolations: number;
  recordUseExperimentOutputMismatches: number;
  recordUseExperimentConfidenceMismatches: number;
} {
  type RecordUseStage = 'share' | 'acquire' | 'read' | 'experiment';
  const rawState = state as unknown as {
    intents?: unknown;
    people?: unknown;
    projects?: unknown;
    records?: unknown;
    world?: { past?: unknown };
  };
  const records = (value: unknown) => (
    Array.isArray(value)
      ? value.map(objectRecord).filter((item): item is Record<string, unknown> => item !== null)
      : []
  );
  const stringValue = (value: unknown): string | null => (
    typeof value === 'string' && value.length > 0 ? value : null
  );
  const stageValue = (value: unknown): RecordUseStage | null => (
    value === 'share' || value === 'acquire' || value === 'read' || value === 'experiment' ? value : null
  );
  const intents = records(rawState.intents);
  const people = records(rawState.people);
  const projects = records(rawState.projects);
  const payloads = records(rawState.records);
  const events = records(rawState.world?.past);
  const intentById = new Map(intents.flatMap((intent) => {
    const id = stringValue(intent.id);
    return id ? [[id, intent] as const] : [];
  }));
  const projectById = new Map(projects.flatMap((project) => {
    const id = stringValue(project.id);
    return id ? [[id, project] as const] : [];
  }));
  const personIds = new Set(people.flatMap((person) => {
    const id = stringValue(person.id);
    return id ? [id] : [];
  }));
  const personById = new Map(people.flatMap((person) => {
    const id = stringValue(person.id);
    return id ? [[id, person] as const] : [];
  }));
  const payloadById = new Map(payloads.flatMap((payload) => {
    const id = stringValue(payload.id);
    return id ? [[id, payload] as const] : [];
  }));
  const eventById = new Map(events.flatMap((event) => {
    const id = stringValue(event.id);
    return id ? [[id, event] as const] : [];
  }));
  const recordUseIntents = intents.filter((intent) => (
    objectRecord(intent.recordUseBasis) !== null || stringValue(intent.recordUseStage) !== null
  ));
  const relevantProjectIds = new Set<string>();
  const unresolvedProjects = new Set<string>();
  const unresolvedActionEvents = new Set<string>();
  const projectMismatches = new Set<string>();
  const readerMismatches = new Set<string>();
  const techniqueMismatches = new Set<string>();
  const acquisitionSourceMismatches = new Set<string>();
  const authorMismatches = new Set<string>();
  const payloadMismatches = new Set<string>();
  const codebookMismatches = new Set<string>();
  const readUnderstandingViolations = new Set<string>();
  const readReliabilityViolations = new Set<string>();
  const experimentOutputMismatches = new Set<string>();
  const experimentConfidenceMismatches = new Set<string>();

  const auditProject = (projectId: string | null, sourceKey: string) => {
    if (!projectId) {
      unresolvedProjects.add(`missing:${sourceKey}`);
      return;
    }
    relevantProjectIds.add(projectId);
    if (!projectById.has(projectId)) unresolvedProjects.add(projectId);
  };

  for (const [intentIndex, intent] of recordUseIntents.entries()) {
    const intentKey = stringValue(intent.id) ?? `#${intentIndex}`;
    const basis = objectRecord(intent.recordUseBasis);
    if (basis) auditProject(stringValue(basis.projectId), `intent:${intentKey}`);
    const intentProjectId = stringValue(intent.projectId);
    if (intentProjectId) relevantProjectIds.add(intentProjectId);
    const actionEventIds = Array.isArray(intent.actionEventIds) ? intent.actionEventIds : [];
    for (const [eventIndex, eventIdValue] of actionEventIds.entries()) {
      const eventId = stringValue(eventIdValue);
      const event = eventId ? eventById.get(eventId) : undefined;
      if (!event || event.kind !== 'action') {
        unresolvedActionEvents.add(eventId ?? `intent:${intentKey}:#${eventIndex}`);
      }
    }
  }

  const recordUseDiffFields = [
    'recordUseBasisKey', 'recordUseStage', 'recordUseProjectId', 'recordUseRecordId',
    'recordUseKnowledgeId', 'recordUseReaderId', 'recordUseCarrierSourceKind',
    'recordUseCarrierSourceId', 'recordUseAcquisitionRequired',
  ];
  const actions = events.flatMap((event, eventIndex) => {
    if (event.kind !== 'action') return [];
    const diff = objectRecord(event.diff) ?? {};
    const intentId = stringValue(event.intentId);
    const intent = intentId ? intentById.get(intentId) : undefined;
    const basis = objectRecord(intent?.recordUseBasis);
    const stage = stageValue(diff.recordUseStage);
    const action = objectRecord(event.action);
    const legacyIntentStage = stringValue(intent?.recordUseStage);
    const legacyActionMatches = stringValue(basis?.version) === 'record-use-basis-v1'
      && ((legacyIntentStage === 'share' && action?.kind === 'transfer')
        || (legacyIntentStage === 'read-experiment' && (action?.kind === 'attend' || action?.kind === 'act')));
    const hasRecordUseMarker = recordUseDiffFields.some((field) => field in diff) || legacyActionMatches;
    if (!hasRecordUseMarker) return [];
    const id = stringValue(event.id) ?? `#${eventIndex}`;
    const basisKey = stringValue(diff.recordUseBasisKey);
    const projectId = stringValue(diff.recordUseProjectId);
    const knowledgeId = stringValue(diff.recordUseKnowledgeId);
    const readerId = stringValue(diff.recordUseReaderId);
    auditProject(projectId, `action:${id}`);

    const basisProjectId = stringValue(basis?.projectId);
    const intentProjectId = stringValue(intent?.projectId);
    if ((basis && projectId !== basisProjectId) || (intentProjectId && projectId !== intentProjectId)) {
      projectMismatches.add(id);
    }
    if (basis && knowledgeId !== stringValue(basis.knowledgeId)) techniqueMismatches.add(id);
    if (basis && stringValue(diff.recordUseTechniqueId) !== stringValue(basis.techniqueId)) techniqueMismatches.add(id);
    const basisReaderId = stringValue(basis?.readerId);
    if ((basis && readerId !== basisReaderId)
      || !readerId
      || !personIds.has(readerId)
      || ((stage === 'acquire' || stage === 'read' || stage === 'experiment') && event.who !== readerId)) {
      readerMismatches.add(id);
    }
    const recordId = stringValue(diff.recordUseRecordId);
    const payload = recordId ? payloadById.get(recordId) : undefined;
    const basisAuthorId = stringValue(basis?.recordAuthorId);
    if (!payload
      || payload.kind !== 'technique'
      || stringValue(payload.knowledgeId) !== knowledgeId
      || (basis && stringValue(payload.codebookId) !== stringValue(basis.codebookId))) {
      payloadMismatches.add(id);
    }
    const payloadAuthorId = stringValue(payload?.authorId);
    if (!readerId || !payloadAuthorId || payloadAuthorId === readerId
      || (basisAuthorId && basisAuthorId !== payloadAuthorId)) authorMismatches.add(id);
    const reader = readerId ? personById.get(readerId) : undefined;
    const codebookId = stringValue(basis?.codebookId) ?? stringValue(payload?.codebookId);
    const readerKnowledge = Array.isArray(reader?.knowledge) ? reader?.knowledge : [];
    if (!codebookId || !readerKnowledge.some((knowledgeValue) => {
      const knowledge = objectRecord(knowledgeValue);
      return stringValue(knowledge?.id) === codebookId
        && knowledge?.kind === 'codebook'
        && Number(knowledge?.confidence) >= 55;
    })) codebookMismatches.add(id);
    const basisVersion = stringValue(basis?.version);
    const carrierSource = objectRecord(basis?.carrierSource);
    const acquisitionRequired = basis?.acquisitionRequired === true;
    if (stage === 'acquire') {
      const action = objectRecord(event.action);
      const from = objectRecord(action?.from);
      const to = objectRecord(action?.to);
      const expectedDropId = stringValue(carrierSource?.dropId);
      const expectedCellId = Number(carrierSource?.cellId);
      const expectedZ = Number(carrierSource?.z);
      if ((basisVersion !== 'record-use-basis-v2' && basisVersion !== 'record-use-basis-v3')
        || !acquisitionRequired
        || carrierSource?.kind !== 'ground'
        || action?.kind !== 'transfer'
        || from?.kind !== 'ground'
        || to?.kind !== 'person'
        || stringValue(action?.dropId) !== expectedDropId
        || Number(from?.cellId) !== expectedCellId
        || Number(from?.z) !== expectedZ
        || stringValue(to?.personId) !== readerId
        || stringValue(diff.recordUseCarrierSourceKind) !== 'ground'
        || stringValue(diff.recordUseCarrierSourceId) !== expectedDropId
        || Number(diff.recordUseCarrierSourceCellId) !== expectedCellId
        || Number(diff.recordUseCarrierSourceZ) !== expectedZ
        || diff.recordUseAcquisitionRequired !== true
        || stringValue(diff.recordPayloadId) !== recordId
        || event.status !== 'completed') {
        acquisitionSourceMismatches.add(id);
      }
    }
    if (stage === 'read' && event.status === 'completed') {
      if (diff.understood !== true) readUnderstandingViolations.add(id);
      if (Number(diff.recordUseKnowledgeConfidenceAfter) > 54) readReliabilityViolations.add(id);
    }
    if (stage === 'experiment' && event.status === 'completed') {
      const expectedOutput = Number(basis?.expectedOutputMaterialId ?? diff.recordUseExpectedOutputMaterialId);
      if (!Number.isFinite(expectedOutput) || Number(diff.outputMaterialId) !== expectedOutput) {
        experimentOutputMismatches.add(id);
      }
      const before = Number(diff.recordUseKnowledgeConfidenceBefore);
      const after = Number(diff.recordUseKnowledgeConfidenceAfter);
      if (!Number.isFinite(before) || !Number.isFinite(after) || before >= 55 || after - before !== 18 || after < 55) {
        experimentConfidenceMismatches.add(id);
      }
    }

    return [{
      id,
      event,
      stage,
      basisKey,
      projectId,
      completed: event.status === 'completed',
      acquisitionRequired,
      eventIndex,
    }];
  });
  const actionById = new Map(actions.map((action) => [action.id, action]));
  const numberValue = (value: unknown, fallback: number) => (
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
  );
  const orderedActions = [...actions].sort((left, right) => (
    numberValue(left.event.atMonth, 0) - numberValue(right.event.atMonth, 0)
    || numberValue(left.event.orderInMonth, 0) - numberValue(right.event.orderInMonth, 0)
    || numberValue(left.event.actionTick, 0) - numberValue(right.event.actionTick, 0)
    || left.eventIndex - right.eventIndex
  ));
  const completedAcquisitionBasisKeys = new Set<string>();
  const completedReadBasisKeys = new Set<string>();
  const readsBeforeExperiment = new Set<string>();
  let recordUseReadsWithoutAcquisition = 0;
  let recordUseExperimentsWithoutRead = 0;
  const passesCommonGuards = (action: typeof orderedActions[number]): boolean => Boolean(
    action.basisKey
    && action.projectId
    && projectById.has(action.projectId)
    && !projectMismatches.has(action.id)
    && !readerMismatches.has(action.id)
    && !techniqueMismatches.has(action.id)
    && !authorMismatches.has(action.id)
    && !payloadMismatches.has(action.id)
    && !codebookMismatches.has(action.id),
  );
  for (const action of orderedActions) {
    if (action.stage === 'acquire'
      && action.completed
      && action.basisKey
      && passesCommonGuards(action)
      && !acquisitionSourceMismatches.has(action.id)) {
      completedAcquisitionBasisKeys.add(action.basisKey);
    }
    if (action.stage === 'read'
      && action.completed
      && action.basisKey
      && passesCommonGuards(action)
      && !readUnderstandingViolations.has(action.id)
      && !readReliabilityViolations.has(action.id)) {
      if (action.acquisitionRequired && !completedAcquisitionBasisKeys.has(action.basisKey)) {
        recordUseReadsWithoutAcquisition += 1;
      } else {
        completedReadBasisKeys.add(action.basisKey);
      }
    }
    if (action.stage === 'experiment') {
      if (!action.basisKey || !completedReadBasisKeys.has(action.basisKey)) {
        recordUseExperimentsWithoutRead += 1;
      } else if (action.completed
        && passesCommonGuards(action)
        && !experimentOutputMismatches.has(action.id)
        && !experimentConfidenceMismatches.has(action.id)) {
        readsBeforeExperiment.add(action.id);
      }
    }
  }

  const projectProgressEventIds = new Set<string>();
  for (const [projectIndex, project] of projects.entries()) {
    const projectId = stringValue(project.id);
    const evidence = Array.isArray(project.progressEvidence) ? project.progressEvidence : [];
    for (const [evidenceIndex, evidenceValue] of evidence.entries()) {
      const evidence = objectRecord(evidenceValue);
      const eventId = stringValue(evidence?.eventId);
      const action = eventId ? actionById.get(eventId) : undefined;
      const recordUseRelevant = Boolean(projectId && relevantProjectIds.has(projectId))
        || action?.stage === 'experiment';
      if (!recordUseRelevant) continue;
      if (!eventId || !action) {
        unresolvedActionEvents.add(eventId ?? `project:${projectId ?? `#${projectIndex}`}:#${evidenceIndex}`);
        continue;
      }
      if (action.stage !== 'experiment') continue;
      if (!projectId || action.projectId !== projectId) {
        projectMismatches.add(action.id);
        continue;
      }
      if (action.completed) projectProgressEventIds.add(action.id);
    }
  }

  const completeBasisKeys = new Set<string>();
  for (const eventId of projectProgressEventIds) {
    const action = actionById.get(eventId);
    if (action?.basisKey && readsBeforeExperiment.has(eventId)) completeBasisKeys.add(action.basisKey);
  }

  return {
    recordUseShares: actions.filter((action) => action.stage === 'share').length,
    recordUseAcquisitions: actions.filter((action) => action.stage === 'acquire').length,
    recordUseReads: actions.filter((action) => action.stage === 'read').length,
    recordUseExperiments: actions.filter((action) => action.stage === 'experiment').length,
    recordUseExperimentSuccesses: actions.filter((action) => action.stage === 'experiment' && action.completed).length,
    recordUseProjectProgresses: projectProgressEventIds.size,
    completeRecordUseChains: completeBasisKeys.size,
    recordUseUniqueBases: new Set(actions.flatMap((action) => action.basisKey ? [action.basisKey] : [])).size,
    recordUseActionsMissingBasisKey: actions.filter((action) => !action.basisKey).length,
    recordUseUnresolvedProjects: unresolvedProjects.size,
    recordUseReaderMismatches: readerMismatches.size,
    recordUseTechniqueMismatches: techniqueMismatches.size,
    recordUseAcquisitionSourceMismatches: acquisitionSourceMismatches.size,
    recordUseReadsWithoutAcquisition,
    recordUseExperimentsWithoutRead,
    recordUseProjectMismatches: projectMismatches.size,
    recordUseUnresolvedActionEvents: unresolvedActionEvents.size,
    recordUseAuthorMismatches: authorMismatches.size,
    recordUsePayloadMismatches: payloadMismatches.size,
    recordUseCodebookMismatches: codebookMismatches.size,
    recordUseReadUnderstandingViolations: readUnderstandingViolations.size,
    recordUseReadReliabilityViolations: readReliabilityViolations.size,
    recordUseExperimentOutputMismatches: experimentOutputMismatches.size,
    recordUseExperimentConfidenceMismatches: experimentConfidenceMismatches.size,
  };
}

interface InquiryOpportunityMetrics {
  inquiryOpportunityBasisProjects: number;
  inquiryOpportunityBasisCoverage: number;
  inquiryOpportunityFailedProjects: number;
  inquiryOpportunityTerminalBasisProjects: number;
  inquiryOpportunityTerminalBasisCoverage: number;
  inquiryOpportunityRenewalProjects: number;
  inquiryOpportunityRenewalKeys: number;
  inquiryOpportunityReopenWithoutRenewalViolations: number;
  inquiryOpportunityUnresolvedInheritedProjects: number;
  inquiryOpportunityInheritedActorMismatches: number;
  inquiryOpportunityInheritedFunctionMismatches: number;
  inquiryOpportunityInheritedStatusMismatches: number;
  inquiryOpportunityRenewalKeyMismatches: number;
  hypothesisReliableNoResponseExcessAttempts: number;
  inquiryOpportunityRenewalHypothesisProjects: number;
  inquiryOpportunityRenewalHypothesisCandidateCoverage: number;
  inquiryOpportunityRenewalHypothesisAttemptProjects: number;
  inquiryOpportunityRenewalHypothesisFirstAttemptCoverage: number;
  inquiryOpportunityConstructionRenewalHypothesisProjects: number;
  inquiryOpportunityConstructionRenewalHypothesisCandidateCoverage: number;
  inquiryOpportunityConstructionRenewalHypothesisAttemptProjects: number;
  inquiryOpportunityConstructionRenewalHypothesisFirstAttemptCoverage: number;
  inquiryOpportunitySourceBasisProjects: number;
  inquiryOpportunitySourceBasisCoverage: number;
  inquiryOpportunityRenewalCommitmentProjects: number;
  inquiryOpportunityRenewalCommitmentProjectCoverage: number;
  inquiryOpportunityRenewalCommitmentSourceCoverage: number;
  inquiryOpportunityUnresolvedSources: number;
  inquiryOpportunityRenewalCommitmentActorMismatches: number;
  inquiryOpportunityRenewalCommitmentFunctionMismatches: number;
  inquiryOpportunityRenewalCommitmentInheritedStatusMismatches: number;
  inquiryOpportunityRenewalFirstCandidateExactSourceCoverage: number;
  inquiryOpportunityRenewalFirstAttemptExactSourceCoverage: number;
  inquiryOpportunityRenewalFallbackBeforeCommitmentViolations: number;
  inquiryOpportunityMaterialOnlyCommitmentAttributionViolations: number;
  inquiryOpportunityConstructionRenewalFirstCandidateExactSourceCoverage: number;
  inquiryOpportunityConstructionRenewalFirstAttemptExactSourceCoverage: number;
  inquiryOpportunityConstructionRenewalFallbackBeforeCommitmentViolations: number;
  inquiryOpportunityConstructionMaterialOnlyCommitmentAttributionViolations: number;
}

function inquiryOpportunityMetrics(state: SimulationState): InquiryOpportunityMetrics {
  type HypothesisOperation = 'combine-inventory' | 'exert-air' | 'expose-local';
  type OpportunityKind = 'material' | 'knowledge' | 'target' | 'verified-response' | 'ready-record-carrier';
  type OpportunitySource = {
    opportunityKey: string;
    kind: OpportunityKind;
    materialId: number | null;
    currentSourceKey: string | null;
    sourceKeys: string[];
    sourceFactIds: string[];
  };
  const rawState = state as unknown as {
    people?: unknown;
    projects?: unknown;
    world?: { past?: unknown };
  };
  const records = (value: unknown): Record<string, unknown>[] => (
    Array.isArray(value)
      ? value.map(objectRecord).filter((item): item is Record<string, unknown> => item !== null)
      : []
  );
  const stringValue = (value: unknown): string | null => (
    typeof value === 'string' && value.length > 0 ? value : null
  );
  const stringKeys = (value: unknown): string[] => (
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : []
  );
  const exactStringKeys = (value: unknown): string[] | null => (
    Array.isArray(value)
      && value.every((item) => typeof item === 'string' && item.length > 0)
      ? value as string[]
      : null
  );
  const integerValue = (value: unknown): number | null => (
    typeof value === 'number' && Number.isInteger(value) ? value : null
  );
  const coverage = (covered: number, total: number): number => (
    total ? Math.round(covered / total * 10_000) / 100 : 100
  );
  const operationValue = (value: unknown): HypothesisOperation | null => (
    value === 'combine-inventory' || value === 'exert-air' || value === 'expose-local'
      ? value
      : null
  );
  const signatureFor = (
    operation: HypothesisOperation,
    attempt: Record<string, unknown>,
  ): string | null => {
    if (!Array.isArray(attempt.materialIds) || attempt.materialIds.length !== 2) return null;
    const first = integerValue(attempt.materialIds[0]);
    const second = integerValue(attempt.materialIds[1]);
    if (first === null || second === null) return null;
    if (operation === 'combine-inventory') {
      return first <= second ? `${first}+${second}` : `${second}+${first}`;
    }
    const target = integerValue(attempt.targetMaterialId);
    if (operation === 'exert-air') {
      return `exert-air:${first}>${second}@${target ?? Material.Air}`;
    }
    return `expose-local:${first}@${target ?? second}`;
  };

  const projects = records(rawState.projects).map((project, projectIndex) => ({ project, projectIndex }));
  const inquiryProjects = projects.filter(({ project }) => (
    project.kind === 'production' || project.kind === 'inquiry'
  ));
  const exhaustedSearchCampaigns = (project: Record<string, unknown>): Record<string, unknown>[] => (
    records(project.searchCampaigns).filter((campaign) => campaign.status === 'exhausted')
  );
  const hasHypothesisAttempts = (project: Record<string, unknown>): boolean => (
    records(objectRecord(project.hypothesisCampaign)?.attempts).length > 0
  );
  const isReopenConstraint = (project: Record<string, unknown>): boolean => (
    project.status === 'blocked'
      && (exhaustedSearchCampaigns(project).length > 0
        || hasHypothesisAttempts(project))
  );
  const failedProjects = projects.filter(({ project }) => isReopenConstraint(project));
  const reopenConstraintProjects = failedProjects;
  // A construction project joins the opportunity-source audit only after the
  // opportunity-memory/renewal gate has attached a basis. Ordinary first-attempt
  // constructions remain outside the production/inquiry opening-basis denominator.
  const sourceAuditProjects = projects.filter(({ project }) => (
    project.kind === 'production'
      || project.kind === 'inquiry'
      || objectRecord(project.inquiryOpportunityBasis) !== null
  ));
  const projectEntriesById = new Map<string, typeof projects>();
  for (const entry of projects) {
    const projectId = stringValue(entry.project.id);
    if (!projectId) continue;
    const matches = projectEntriesById.get(projectId) ?? [];
    matches.push(entry);
    projectEntriesById.set(projectId, matches);
  }
  const actionById = new Map(records(rawState.world?.past).flatMap((event) => {
    const eventId = stringValue(event.id);
    return eventId ? [[eventId, event] as const] : [];
  }));
  const opportunityKind = (value: unknown): OpportunityKind | null => (
    value === 'material' || value === 'knowledge' || value === 'target'
      || value === 'verified-response' || value === 'ready-record-carrier'
      ? value
      : null
  );
  const parseOpportunitySource = (
    value: unknown,
    opportunityKeys: ReadonlySet<string>,
  ): OpportunitySource | null => {
    const source = objectRecord(value);
    const opportunityKey = stringValue(source?.opportunityKey);
    const kind = opportunityKind(source?.kind);
    const sourceKeys = exactStringKeys(source?.sourceKeys);
    const sourceFactIds = exactStringKeys(source?.sourceFactIds);
    const materialId = integerValue(source?.materialId);
    if (!source || !opportunityKey || !kind || !sourceKeys?.length || sourceFactIds === null
      || !opportunityKeys.has(opportunityKey)
      || sourceFactIds.some((eventId) => !actionById.has(eventId))) return null;
    const currentMaterialSourceKey = sourceKeys[0] ?? null;
    const tangibleCurrentMaterialSource = currentMaterialSourceKey !== null
      && (currentMaterialSourceKey.startsWith('inventory:') || currentMaterialSourceKey.startsWith('drop:'));
    const searchSourcePrefix = materialId === null ? null : `search-source:${materialId}:`;
    const exactSearchSourceKey = searchSourcePrefix && opportunityKey.startsWith(searchSourcePrefix)
      ? opportunityKey.slice(searchSourcePrefix.length)
      : null;
    const valid = kind === 'material'
      ? materialId !== null
        && ((opportunityKey === `material:${materialId}` && tangibleCurrentMaterialSource)
          || (exactSearchSourceKey !== null
            && (exactSearchSourceKey.startsWith('inventory:') || exactSearchSourceKey.startsWith('drop:'))
            && exactSearchSourceKey === currentMaterialSourceKey))
      : kind === 'knowledge'
        ? opportunityKey.startsWith('knowledge:') && sourceKeys.includes(opportunityKey)
        : kind === 'target'
          ? sourceKeys.some((key) => opportunityKey === `target:${key}` && key.startsWith('voxel:'))
          : kind === 'verified-response'
            ? materialId !== null && opportunityKey.startsWith('response:')
              && sourceFactIds.includes(opportunityKey.slice('response:'.length))
              && sourceKeys.every((key) => key.startsWith('inventory:') || key.startsWith('voxel:'))
            : materialId !== null && opportunityKey.startsWith('ready-record-carrier:')
              && sourceKeys.some((key) => opportunityKey === `ready-record-carrier:${key}`
                && key.startsWith('inventory:'));
    return valid ? {
      opportunityKey,
      kind,
      materialId,
      currentSourceKey: kind === 'material' ? currentMaterialSourceKey : null,
      sourceKeys,
      sourceFactIds,
    } : null;
  };
  const inventorySourceActor = (sourceKey: string): string | null => {
    const match = /^inventory:([^:]+):.+$/.exec(sourceKey);
    return match?.[1] ?? null;
  };
  const sourceLineageMatches = (
    source: OpportunitySource,
    evidence: Record<string, unknown>,
  ): boolean => {
    const evidenceKeys = stringKeys(evidence.sourceKeys);
    if (source.sourceKeys.some((sourceKey) => evidenceKeys.includes(sourceKey))) return true;
    const evidenceFactIds = new Set(stringKeys(evidence.sourceFactIds));
    return source.sourceFactIds.length > 0
      && source.sourceFactIds.some((eventId) => evidenceFactIds.has(eventId));
  };
  const evidenceUsesOpportunitySource = (
    source: OpportunitySource,
    evidence: Record<string, unknown>,
  ): boolean => {
    if (source.kind === 'knowledge' || source.kind === 'ready-record-carrier') return false;
    const materialIds = Array.isArray(evidence.materialIds)
      ? evidence.materialIds.map(integerValue).filter((value): value is number => value !== null)
      : [];
    if (source.materialId !== null && source.kind !== 'target' && !materialIds.includes(source.materialId)) {
      return false;
    }
    if (source.kind === 'target' && source.materialId !== null
      && integerValue(evidence.targetMaterialId) !== source.materialId) return false;
    const exactSource = source.sourceKeys.some((sourceKey) => stringKeys(evidence.sourceKeys).includes(sourceKey));
    if (source.kind === 'material') {
      if (source.opportunityKey.startsWith('search-source:')) {
        return source.currentSourceKey !== null
          && stringKeys(evidence.sourceKeys).includes(source.currentSourceKey);
      }
      return sourceLineageMatches(source, evidence);
    }
    if (source.kind === 'target') return exactSource;
    return exactSource
      && source.sourceFactIds.some((eventId) => stringKeys(evidence.sourceFactIds).includes(eventId));
  };
  const hasCommitmentReason = (value: unknown): boolean => (
    stringKeys(value).includes('cross-project-renewal-opportunity')
  );
  const techniqueOutputMaterialId = (techniqueId: string): number | null => {
    const numeric = (value: string | undefined): number | null => (
      value && /^\d+$/.test(value) ? Number(value) : null
    );
    const inventoryPrefix = 'technique:combine-inventory:';
    if (techniqueId.startsWith(inventoryPrefix)) {
      const [, output, ...rest] = techniqueId.slice(inventoryPrefix.length).split(':');
      return rest.length === 0 ? numeric(output) : null;
    }
    const parts = techniqueId.split(':');
    if (parts[0] !== 'technique') return null;
    if (parts[1] === 'combine' && parts.length === 5) return numeric(parts[4]);
    if (parts[1] === 'exert' && parts.length === 6) return numeric(parts[5]);
    if (parts[1] === 'expose' && parts.length === 5) return numeric(parts[4]);
    return null;
  };
  const materialSupportsFunction = (desiredFunction: string, materialId: number): boolean => {
    if (desiredFunction === 'insulation') return materialHas(materialId, 'insulating');
    if (desiredFunction === 'safer-hunting') return materialHas(materialId, 'tool');
    if (desiredFunction === 'healing') return (materialDefinition(materialId).consume?.health ?? 0) > 0;
    if (desiredFunction === 'prepared-food') {
      return materialId === Material.CookedFood || materialHas(materialId, 'hot');
    }
    if (desiredFunction === 'durable-record') return materialHas(materialId, 'recordable');
    const exactOutputs = new Map<string, number[]>([
      ['efficient-production', [Material.StoneHoe, Material.WoodTool]],
      ['workshop-production', [Material.Workshop]],
      ['reserve-storage', [Material.Granary]],
      ['reliable-water', [Material.Cistern]],
      ['crop-processing', [Material.Mill]],
      ['community-coordination', [Material.CouncilHearth]],
      ['high-heat-processing', [Material.Kiln]],
      ['brick-firing', [Material.FiredBrick]],
      ['copper-charge', [Material.CopperCharge]],
      ['copper-smelting', [Material.Copper]],
      ['tin-charge', [Material.TinCharge]],
      ['tin-smelting', [Material.Tin]],
      ['bronze-alloying', [Material.Bronze]],
      ['bronze-tooling', [Material.BronzeTool]],
      ['bronze-workshop', [Material.Foundry]],
      ['civic-coordination', [Material.CivicHall]],
      ['iron-workshop', [Material.Smithy]],
      ['iron-charge', [Material.IronCharge]],
      ['iron-reduction', [Material.IronBloom]],
      ['iron-working', [Material.Iron]],
      ['iron-tooling', [Material.IronTool]],
      ['fortified-coordination', [Material.KeepCore]],
    ]);
    return exactOutputs.get(desiredFunction)?.includes(materialId) ?? false;
  };
  const personHasReliableFunctionalTechnique = (
    personId: string,
    desiredFunction: string,
    techniqueId: string,
  ): boolean => {
    const person = records(rawState.people).find((candidate) => candidate.id === personId);
    const fact = records(person?.knowledge).find((candidate) => candidate.id === techniqueId
      && candidate.kind === 'technique'
      && typeof candidate.confidence === 'number'
      && candidate.confidence >= 55);
    const outputMaterialId = techniqueOutputMaterialId(techniqueId);
    return Boolean(fact && outputMaterialId !== null
      && materialSupportsFunction(desiredFunction, outputMaterialId));
  };
  const terminalOpportunityBasis = (project: Record<string, unknown>): Record<string, unknown> | null => (
    objectRecord(project.terminalInquiryOpportunityBasis)
      ?? objectRecord(project.inquiryOpportunityBasis)
  );

  let basisProjects = 0;
  let terminalBasisProjects = 0;
  let renewalProjects = 0;
  let renewalKeys = 0;
  let sourceBasisProjects = 0;
  let renewalCommitmentProjects = 0;
  let renewalCommitmentCoveredKeys = 0;
  const reopenWithoutRenewal = new Set<string>();
  const unresolvedInheritedProjects = new Set<string>();
  const inheritedActorMismatches = new Set<string>();
  const inheritedFunctionMismatches = new Set<string>();
  const inheritedStatusMismatches = new Set<string>();
  const renewalKeyMismatches = new Set<string>();
  const unresolvedSources = new Set<string>();
  const renewalCommitmentActorMismatches = new Set<string>();
  const renewalCommitmentFunctionMismatches = new Set<string>();
  const renewalCommitmentInheritedStatusMismatches = new Set<string>();
  const sourceAuditByProjectIndex = new Map<number, {
    renewalKeys: string[];
    renewalSources: OpportunitySource[];
    coveredRenewalKeys: string[];
  }>();

  for (const { project, projectIndex } of sourceAuditProjects) {
    const projectId = stringValue(project.id) ?? `#${projectIndex}`;
    const basis = objectRecord(project.inquiryOpportunityBasis);
    if (basis) basisProjects += 1;
    const inheritedProjectIds = stringKeys(basis?.inheritedProjectIds);
    const projectRenewalKeys = stringKeys(basis?.renewalKeys);
    const opportunityKeys = new Set(stringKeys(basis?.opportunityKeys));
    const rawOpportunitySources = Array.isArray(basis?.opportunitySources)
      ? basis.opportunitySources
      : null;
    if (basis && rawOpportunitySources) sourceBasisProjects += 1;
    const parsedSources: OpportunitySource[] = [];
    for (const [sourceIndex, value] of (rawOpportunitySources ?? []).entries()) {
      const source = parseOpportunitySource(value, opportunityKeys);
      if (!source) unresolvedSources.add(`${projectId}\u0000source:${sourceIndex}`);
      else parsedSources.push(source);
    }
    const renewalSources = parsedSources.filter((source) => projectRenewalKeys.includes(source.opportunityKey));
    const coveredKeys = projectRenewalKeys.filter((renewalKey) => (
      renewalSources.some((source) => source.opportunityKey === renewalKey)
    ));
    sourceAuditByProjectIndex.set(projectIndex, {
      renewalKeys: projectRenewalKeys,
      renewalSources,
      coveredRenewalKeys: coveredKeys,
    });
    if (projectRenewalKeys.length > 0) {
      renewalProjects += 1;
      renewalKeys += projectRenewalKeys.length;
      renewalCommitmentCoveredKeys += coveredKeys.length;
      if (coveredKeys.length === projectRenewalKeys.length) renewalCommitmentProjects += 1;
      for (const renewalKey of projectRenewalKeys) {
        if (!coveredKeys.includes(renewalKey)) unresolvedSources.add(`${projectId}\u0000renewal:${renewalKey}`);
      }
      if (basis?.actorId !== project.ownerId) renewalCommitmentActorMismatches.add(projectId);
      if (basis?.desiredFunction !== project.desiredFunction) renewalCommitmentFunctionMismatches.add(projectId);
      const campaign = objectRecord(project.hypothesisCampaign);
      if (campaign && campaign.actorId !== project.ownerId) {
        renewalCommitmentActorMismatches.add(`${projectId}\u0000campaign`);
      }
      for (const source of renewalSources) {
        const sourceActor = source.currentSourceKey
          ? inventorySourceActor(source.currentSourceKey)
          : null;
        if (sourceActor && sourceActor !== project.ownerId) {
          renewalCommitmentActorMismatches.add(`${projectId}\u0000${source.currentSourceKey}`);
        }
      }
    }
    for (const renewalKey of projectRenewalKeys) {
      if (!opportunityKeys.has(renewalKey)) renewalKeyMismatches.add(`${projectId}\u0000${renewalKey}`);
    }

    for (const inheritedProjectId of inheritedProjectIds) {
      const referenceKey = `${projectId}\u0000${inheritedProjectId}`;
      const matches = projectEntriesById.get(inheritedProjectId) ?? [];
      if (matches.length !== 1) {
        unresolvedInheritedProjects.add(referenceKey);
        continue;
      }
      const inherited = matches[0].project;
      if (inherited.ownerId !== project.ownerId) {
        inheritedActorMismatches.add(referenceKey);
        if (projectRenewalKeys.length > 0) renewalCommitmentActorMismatches.add(referenceKey);
      }
      if (inherited.desiredFunction !== project.desiredFunction) {
        inheritedFunctionMismatches.add(referenceKey);
        if (projectRenewalKeys.length > 0) renewalCommitmentFunctionMismatches.add(referenceKey);
      }
      if (inherited.status !== 'blocked') {
        inheritedStatusMismatches.add(referenceKey);
        if (projectRenewalKeys.length > 0) renewalCommitmentInheritedStatusMismatches.add(referenceKey);
      }
    }
  }

  // Search exhaustion is shared by production, inquiry, and construction
  // projects. Audit the complete project stream rather than the narrower
  // hypothesis-metric subset above.
  for (const { project, projectIndex } of projects) {
    const projectId = stringValue(project.id) ?? `#${projectIndex}`;
    const basis = objectRecord(project.inquiryOpportunityBasis);
    const inheritedProjectIds = stringKeys(basis?.inheritedProjectIds);
    const createdAtMonth = integerValue(project.createdAtMonth);
    const priorFailures = createdAtMonth === null ? [] : reopenConstraintProjects.filter((prior) => (
      prior.projectIndex < projectIndex
        && prior.project.ownerId === project.ownerId
        && prior.project.desiredFunction === project.desiredFunction
        && integerValue(prior.project.blockedAtMonth) !== null
        && integerValue(prior.project.blockedAtMonth)! <= createdAtMonth
    ));
    const priorSearchCampaigns = priorFailures.flatMap(({ project: prior }) => (
      exhaustedSearchCampaigns(prior)
    ));
    const sourceAudit = sourceAuditByProjectIndex.get(projectIndex);
    const basisIdentityMatches = basis?.actorId === project.ownerId
      && basis?.desiredFunction === project.desiredFunction;
    const priorOpportunityKeys = new Set(priorFailures.flatMap(({ project: prior }) => (
      stringKeys(terminalOpportunityBasis(prior)?.opportunityKeys)
    )));
    const priorSearchMaterialIds = new Set(priorSearchCampaigns.flatMap((campaign) => (
      Array.isArray(campaign.materialIds)
        ? campaign.materialIds.map(integerValue).filter((value): value is number => value !== null)
        : []
    )));
    const priorMaterialSources = priorFailures.flatMap(({ project: prior }) => (
      records(terminalOpportunityBasis(prior)?.opportunitySources).filter((source) => (
        source.kind === 'material' && integerValue(source.materialId) !== null
      ))
    ));
    const priorSearchSourceFactIdsByMaterial = new Map<number, Set<string>>();
    for (const campaign of priorSearchCampaigns) {
      const sourceFactIds = stringKeys(campaign.sourceFactIds);
      for (const materialId of (Array.isArray(campaign.materialIds)
        ? campaign.materialIds.map(integerValue).filter((value): value is number => value !== null)
        : [])) {
        const known = priorSearchSourceFactIdsByMaterial.get(materialId) ?? new Set<string>();
        for (const eventId of sourceFactIds) known.add(eventId);
        priorSearchSourceFactIdsByMaterial.set(materialId, known);
      }
    }
    const priorTerminalSourceFactIds = new Set(priorFailures.flatMap(({ project: prior }) => (
      stringKeys(terminalOpportunityBasis(prior)?.sourceFactIds)
    )));
    const sourceIsNew = (source: OpportunitySource): boolean => {
      const matchesStoredSource = priorMaterialSources.some((prior) => {
        if (integerValue(prior.materialId) !== source.materialId) return false;
        const priorSourceKeys = stringKeys(prior.sourceKeys);
        if (source.sourceKeys.some((sourceKey) => priorSourceKeys.includes(sourceKey))) return true;
        const priorFactIds = new Set(stringKeys(prior.sourceFactIds));
        return source.sourceFactIds.length > 0
          && source.sourceFactIds.some((eventId) => priorFactIds.has(eventId));
      });
      if (matchesStoredSource) return false;
      if (source.materialId === null || !priorSearchMaterialIds.has(source.materialId)) return true;
      const campaignSourceFactIds = priorSearchSourceFactIdsByMaterial.get(source.materialId)
        ?? new Set<string>();
      return !source.sourceFactIds.some((eventId) => (
        campaignSourceFactIds.has(eventId) || priorTerminalSourceFactIds.has(eventId)
      ));
    };
    const priorHypothesisFailures = priorFailures.filter(({ project: prior }) => (
      hasHypothesisAttempts(prior)
    ));
    const sourceActorMatches = (source: OpportunitySource): boolean => {
      if (!source.currentSourceKey) return true;
      const actorId = inventorySourceActor(source.currentSourceKey);
      return actorId === null || actorId === project.ownerId;
    };
    const declaredRenewalIsNew = (source: OpportunitySource): boolean => {
      if (priorFailures.length === 0 || !basisIdentityMatches || !sourceActorMatches(source)
        || typeof project.ownerId !== 'string' || typeof project.desiredFunction !== 'string') return false;
      if (source.opportunityKey.startsWith('search-source:')) {
        return source.kind === 'material'
          && source.materialId !== null
          && priorSearchMaterialIds.has(source.materialId)
          && sourceIsNew(source);
      }
      if (source.kind === 'knowledge' && source.opportunityKey.startsWith('knowledge:')) {
        const techniqueId = source.opportunityKey.slice('knowledge:'.length);
        return !priorOpportunityKeys.has(source.opportunityKey)
          && personHasReliableFunctionalTechnique(
            project.ownerId,
            project.desiredFunction,
            techniqueId,
          );
      }
      return priorHypothesisFailures.length > 0
        && !priorOpportunityKeys.has(source.opportunityKey);
    };
    const hasValidDeclaredRenewal = Boolean(sourceAudit?.renewalSources.some(declaredRenewalIsNew));
    if ((priorFailures.length > 0 || inheritedProjectIds.length > 0) && !hasValidDeclaredRenewal) {
      reopenWithoutRenewal.add(projectId);
    }
  }

  for (const { project } of failedProjects) {
    if (objectRecord(project.terminalInquiryOpportunityBasis)) terminalBasisProjects += 1;
  }

  type RenewalHypothesisProject = (typeof projects)[number] & {
    campaign: Record<string, unknown>;
  };
  const renewalHypothesisProjectsFor = (
    entries: typeof projects,
  ): RenewalHypothesisProject[] => entries.flatMap((entry) => {
    const basis = objectRecord(entry.project.inquiryOpportunityBasis);
    const campaign = objectRecord(entry.project.hypothesisCampaign);
    return campaign && stringKeys(basis?.renewalKeys).length > 0 ? [{ ...entry, campaign }] : [];
  });
  const summarizeRenewalHypothesisScope = (entries: RenewalHypothesisProject[]) => {
    const candidateProjects = entries.filter(({ campaign }) => (
      records(campaign.candidates).some((candidate) => (
        stringKeys(candidate.reasonKeys).includes('cross-project-renewal-opportunity')
      ))
    )).length;
    const attemptProjects = entries.filter(({ campaign }) => (
      records(campaign.attempts).length > 0
    ));
    const firstAttempts = attemptProjects.filter(({ campaign }) => {
      const firstAttempt = records(campaign.attempts)[0];
      const eventId = stringValue(firstAttempt?.eventId);
      const diff = eventId ? objectRecord(actionById.get(eventId)?.diff) : null;
      return stringKeys(diff?.projectHypothesisReasonKeys)
        .includes('cross-project-renewal-opportunity');
    }).length;
    return { candidateProjects, attemptProjects, firstAttempts };
  };
  // Preserve the established production/inquiry denominator. Construction
  // renewal hypotheses are reported separately so their new audit cannot hide
  // a regression in the legacy scope.
  const renewalHypothesisProjects = renewalHypothesisProjectsFor(inquiryProjects);
  const constructionRenewalHypothesisProjects = renewalHypothesisProjectsFor(
    projects.filter(({ project }) => project.kind === 'construction'),
  );
  const renewalHypothesisSummary = summarizeRenewalHypothesisScope(renewalHypothesisProjects);
  const constructionRenewalHypothesisSummary = summarizeRenewalHypothesisScope(
    constructionRenewalHypothesisProjects,
  );

  const exactCommitmentCandidate = (
    candidate: Record<string, unknown>,
    sources: OpportunitySource[],
  ): boolean => hasCommitmentReason(candidate.reasonKeys)
    && sources.some((source) => evidenceUsesOpportunitySource(source, candidate));
  const diffEvidence = (diff: Record<string, unknown>): Record<string, unknown> => ({
    materialIds: diff.projectHypothesisMaterialIds,
    targetMaterialId: diff.projectHypothesisTargetMaterialId,
    sourceKeys: diff.projectHypothesisSourceKeys,
    sourceFactIds: diff.projectHypothesisSourceFactIds,
  });
  const exactCommitmentAttempt = (
    campaign: Record<string, unknown>,
    attempt: Record<string, unknown>,
    sources: OpportunitySource[],
  ): boolean => {
    const candidateKey = stringValue(attempt.candidateKey);
    const candidate = records(campaign.candidates).find((item) => stringValue(item.key) === candidateKey);
    const eventId = stringValue(attempt.eventId);
    const diff = eventId ? objectRecord(actionById.get(eventId)?.diff) : null;
    if (!candidate || !diff || !hasCommitmentReason(candidate.reasonKeys)
      || !hasCommitmentReason(diff.projectHypothesisReasonKeys)) return false;
    const projected = diffEvidence(diff);
    return sources.some((source) => evidenceUsesOpportunitySource(source, candidate)
      && evidenceUsesOpportunitySource(source, attempt)
      && evidenceUsesOpportunitySource(source, projected));
  };
  const materialOnlyAttribution = (
    evidence: Record<string, unknown>,
    reasonKeys: unknown,
    sources: OpportunitySource[],
  ): boolean => {
    if (!hasCommitmentReason(reasonKeys)) return false;
    const materialIds = Array.isArray(evidence.materialIds)
      ? evidence.materialIds.map(integerValue).filter((value): value is number => value !== null)
      : [];
    const sameMaterial = sources.some((source) => source.kind === 'material'
      && source.materialId !== null && materialIds.includes(source.materialId));
    return sameMaterial && !sources.some((source) => evidenceUsesOpportunitySource(source, evidence));
  };

  const auditExactSourceCommitments = (entries: RenewalHypothesisProject[]) => {
    const exactSourceProjects = entries.filter(({ projectIndex }) => (
      sourceAuditByProjectIndex.get(projectIndex)?.renewalKeys.some((renewalKey) => (
        renewalKey.startsWith('material:')
          || renewalKey.startsWith('search-source:')
          || renewalKey.startsWith('target:')
          || renewalKey.startsWith('response:')
      ))
    ));
    let firstCandidateExactSourceProjects = 0;
    let firstAttemptExactSourceProjects = 0;
    let firstAttemptProjects = 0;
    const fallbackBeforeCommitmentViolations = new Set<string>();
    const materialOnlyCommitmentAttributionViolations = new Set<string>();
    for (const { project, projectIndex, campaign } of exactSourceProjects) {
      const projectId = stringValue(project.id) ?? `#${projectIndex}`;
      const sources = sourceAuditByProjectIndex.get(projectIndex)?.renewalSources
        .filter((source) => source.kind === 'material'
          || source.kind === 'target'
          || source.kind === 'verified-response') ?? [];
      const candidates = records(campaign.candidates);
      const firstCommitmentCandidate = candidates.find((candidate) => hasCommitmentReason(candidate.reasonKeys));
      if (firstCommitmentCandidate && exactCommitmentCandidate(firstCommitmentCandidate, sources)) {
        firstCandidateExactSourceProjects += 1;
      }
      for (const [candidateIndex, candidate] of candidates.entries()) {
        if (materialOnlyAttribution(candidate, candidate.reasonKeys, sources)) {
          materialOnlyCommitmentAttributionViolations.add(`${projectId}\u0000candidate:${candidateIndex}`);
        }
      }

      const attempts = records(campaign.attempts);
      if (attempts.length > 0) {
        firstAttemptProjects += 1;
        if (exactCommitmentAttempt(campaign, attempts[0], sources)) {
          firstAttemptExactSourceProjects += 1;
        }
      }
      let commitmentAttempted = false;
      for (const [attemptIndex, attempt] of attempts.entries()) {
        const exactAttempt = exactCommitmentAttempt(campaign, attempt, sources);
        if (!commitmentAttempted && !exactAttempt) {
          fallbackBeforeCommitmentViolations.add(`${projectId}\u0000attempt:${attemptIndex}`);
        }
        if (exactAttempt) commitmentAttempted = true;
        const eventId = stringValue(attempt.eventId);
        const diff = eventId ? objectRecord(actionById.get(eventId)?.diff) : null;
        if (materialOnlyAttribution(attempt, diff?.projectHypothesisReasonKeys, sources)
          || (diff && materialOnlyAttribution(
            diffEvidence(diff),
            diff.projectHypothesisReasonKeys,
            sources,
          ))) {
          materialOnlyCommitmentAttributionViolations.add(`${projectId}\u0000attempt:${attemptIndex}`);
        }
      }
    }
    return {
      exactSourceProjects,
      firstCandidateExactSourceProjects,
      firstAttemptExactSourceProjects,
      firstAttemptProjects,
      fallbackBeforeCommitmentViolations,
      materialOnlyCommitmentAttributionViolations,
    };
  };
  const exactSourceCommitmentAudit = auditExactSourceCommitments(renewalHypothesisProjects);
  const constructionExactSourceCommitmentAudit = auditExactSourceCommitments(
    constructionRenewalHypothesisProjects,
  );

  const noResponseCounts = new Map<string, number>();
  for (const { project } of inquiryProjects) {
    const campaign = objectRecord(project.hypothesisCampaign);
    const actorId = stringValue(campaign?.actorId);
    const desiredFunction = stringValue(project.desiredFunction);
    if (!campaign || !actorId || !desiredFunction) continue;
    for (const attempt of records(campaign.attempts)) {
      if (attempt.outcome !== 'no-response') continue;
      const operation = operationValue(attempt.operation);
      const signature = operation ? signatureFor(operation, attempt) : null;
      if (!operation || !signature) continue;
      const key = `${actorId}\u0000${desiredFunction}\u0000${operation}\u0000${signature}`;
      noResponseCounts.set(key, (noResponseCounts.get(key) ?? 0) + 1);
    }
  }
  const reliableNoResponseExcessAttempts = [...noResponseCounts.values()]
    .reduce((sum, count) => sum + Math.max(0, count - 2), 0);

  return {
    inquiryOpportunityBasisProjects: basisProjects,
    inquiryOpportunityBasisCoverage: coverage(basisProjects, sourceAuditProjects.length),
    inquiryOpportunityFailedProjects: failedProjects.length,
    inquiryOpportunityTerminalBasisProjects: terminalBasisProjects,
    inquiryOpportunityTerminalBasisCoverage: coverage(terminalBasisProjects, failedProjects.length),
    inquiryOpportunityRenewalProjects: renewalProjects,
    inquiryOpportunityRenewalKeys: renewalKeys,
    inquiryOpportunityReopenWithoutRenewalViolations: reopenWithoutRenewal.size,
    inquiryOpportunityUnresolvedInheritedProjects: unresolvedInheritedProjects.size,
    inquiryOpportunityInheritedActorMismatches: inheritedActorMismatches.size,
    inquiryOpportunityInheritedFunctionMismatches: inheritedFunctionMismatches.size,
    inquiryOpportunityInheritedStatusMismatches: inheritedStatusMismatches.size,
    inquiryOpportunityRenewalKeyMismatches: renewalKeyMismatches.size,
    hypothesisReliableNoResponseExcessAttempts: reliableNoResponseExcessAttempts,
    inquiryOpportunityRenewalHypothesisProjects: renewalHypothesisProjects.length,
    inquiryOpportunityRenewalHypothesisCandidateCoverage: coverage(
      renewalHypothesisSummary.candidateProjects,
      renewalHypothesisProjects.length,
    ),
    inquiryOpportunityRenewalHypothesisAttemptProjects:
      renewalHypothesisSummary.attemptProjects.length,
    inquiryOpportunityRenewalHypothesisFirstAttemptCoverage: coverage(
      renewalHypothesisSummary.firstAttempts,
      renewalHypothesisSummary.attemptProjects.length,
    ),
    inquiryOpportunityConstructionRenewalHypothesisProjects:
      constructionRenewalHypothesisProjects.length,
    inquiryOpportunityConstructionRenewalHypothesisCandidateCoverage: coverage(
      constructionRenewalHypothesisSummary.candidateProjects,
      constructionRenewalHypothesisProjects.length,
    ),
    inquiryOpportunityConstructionRenewalHypothesisAttemptProjects:
      constructionRenewalHypothesisSummary.attemptProjects.length,
    inquiryOpportunityConstructionRenewalHypothesisFirstAttemptCoverage: coverage(
      constructionRenewalHypothesisSummary.firstAttempts,
      constructionRenewalHypothesisSummary.attemptProjects.length,
    ),
    inquiryOpportunitySourceBasisProjects: sourceBasisProjects,
    inquiryOpportunitySourceBasisCoverage: coverage(sourceBasisProjects, basisProjects),
    inquiryOpportunityRenewalCommitmentProjects: renewalCommitmentProjects,
    inquiryOpportunityRenewalCommitmentProjectCoverage: coverage(
      renewalCommitmentProjects,
      renewalProjects,
    ),
    inquiryOpportunityRenewalCommitmentSourceCoverage: coverage(
      renewalCommitmentCoveredKeys,
      renewalKeys,
    ),
    inquiryOpportunityUnresolvedSources: unresolvedSources.size,
    inquiryOpportunityRenewalCommitmentActorMismatches: renewalCommitmentActorMismatches.size,
    inquiryOpportunityRenewalCommitmentFunctionMismatches: renewalCommitmentFunctionMismatches.size,
    inquiryOpportunityRenewalCommitmentInheritedStatusMismatches:
      renewalCommitmentInheritedStatusMismatches.size,
    inquiryOpportunityRenewalFirstCandidateExactSourceCoverage: coverage(
      exactSourceCommitmentAudit.firstCandidateExactSourceProjects,
      exactSourceCommitmentAudit.exactSourceProjects.length,
    ),
    inquiryOpportunityRenewalFirstAttemptExactSourceCoverage: coverage(
      exactSourceCommitmentAudit.firstAttemptExactSourceProjects,
      exactSourceCommitmentAudit.firstAttemptProjects,
    ),
    inquiryOpportunityRenewalFallbackBeforeCommitmentViolations:
      exactSourceCommitmentAudit.fallbackBeforeCommitmentViolations.size,
    inquiryOpportunityMaterialOnlyCommitmentAttributionViolations:
      exactSourceCommitmentAudit.materialOnlyCommitmentAttributionViolations.size,
    inquiryOpportunityConstructionRenewalFirstCandidateExactSourceCoverage: coverage(
      constructionExactSourceCommitmentAudit.firstCandidateExactSourceProjects,
      constructionExactSourceCommitmentAudit.exactSourceProjects.length,
    ),
    inquiryOpportunityConstructionRenewalFirstAttemptExactSourceCoverage: coverage(
      constructionExactSourceCommitmentAudit.firstAttemptExactSourceProjects,
      constructionExactSourceCommitmentAudit.firstAttemptProjects,
    ),
    inquiryOpportunityConstructionRenewalFallbackBeforeCommitmentViolations:
      constructionExactSourceCommitmentAudit.fallbackBeforeCommitmentViolations.size,
    inquiryOpportunityConstructionMaterialOnlyCommitmentAttributionViolations:
      constructionExactSourceCommitmentAudit.materialOnlyCommitmentAttributionViolations.size,
  };
}

function techniqueLearningMetrics(state: SimulationState) {
  type LearningOperation = 'combine' | 'exert' | 'expose';
  type TechniqueSignature = {
    operation: LearningOperation;
    inputMaterialIds: number[];
    toolMaterialId: number | null;
    targetMaterialId: number | null;
    outputMaterialId: number;
  };
  type IndexedRecord = { value: Record<string, unknown>; index: number; key: string };
  type BasisAudit = {
    key: string;
    project: Record<string, unknown>;
    projectId: string | null;
    learnerId: string | null;
    demonstratorId: string | null;
    techniqueId: string | null;
    requestEventId: string | null;
    demonstrationEventId: string | null;
    demonstrationIndex: number | null;
    signature: TechniqueSignature | null;
    valid: boolean;
    exactSource: boolean;
    tentative: boolean;
  };
  type ImitationAudit = {
    key: string;
    event: Record<string, unknown>;
    eventIndex: number;
    basis: BasisAudit | null;
    valid: boolean;
    exactSource: boolean;
  };

  const rawState = state as unknown as {
    people?: unknown;
    projects?: unknown;
    records?: unknown;
    world?: { past?: unknown };
  };
  const indexedRecords = (value: unknown): IndexedRecord[] => (
    Array.isArray(value)
      ? value.flatMap((item, index) => {
        const record = objectRecord(item);
        if (!record) return [];
        const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : `#${index}`;
        return [{ value: record, index, key: id }];
      })
      : []
  );
  const records = (value: unknown): Record<string, unknown>[] => (
    Array.isArray(value)
      ? value.map(objectRecord).filter((item): item is Record<string, unknown> => item !== null)
      : []
  );
  const stringValue = (value: unknown): string | null => (
    typeof value === 'string' && value.length > 0 ? value : null
  );
  const integerValue = (value: unknown): number | null => (
    typeof value === 'number' && Number.isInteger(value) ? value : null
  );
  const finiteValue = (value: unknown): number | null => (
    typeof value === 'number' && Number.isFinite(value) ? value : null
  );
  const exactStringKeys = (value: unknown): string[] | null => {
    if (!Array.isArray(value)
      || !value.every((item) => typeof item === 'string' && item.length > 0)) return null;
    const keys = value as string[];
    return new Set(keys).size === keys.length ? keys : null;
  };
  const stringKeys = (value: unknown): string[] => (
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : []
  );
  const exactIntegerValues = (value: unknown): number[] | null => (
    Array.isArray(value) && value.every((item) => Number.isInteger(item))
      ? value as number[]
      : null
  );
  const coverage = (covered: number, total: number): number => (
    total ? Math.round(covered / total * 10_000) / 100 : 100
  );
  const sameStrings = (left: string[], right: string[]): boolean => {
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.length === sortedRight.length
      && sortedLeft.every((value, index) => value === sortedRight[index]);
  };
  const sameMaterials = (left: number[], right: number[]): boolean => {
    const sortedLeft = [...left].sort((a, b) => a - b);
    const sortedRight = [...right].sort((a, b) => a - b);
    return sortedLeft.length === sortedRight.length
      && sortedLeft.every((value, index) => value === sortedRight[index]);
  };
  const operationValue = (value: unknown): LearningOperation | null => (
    value === 'combine' || value === 'exert' || value === 'expose' ? value : null
  );
  const parseMaterial = (value: string): number | null => {
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const parseTechnique = (techniqueId: string | null): TechniqueSignature | null => {
    if (!techniqueId) return null;
    const inventoryPrefix = 'technique:combine-inventory:';
    if (techniqueId.startsWith(inventoryPrefix)) {
      const [inputKey, outputKey, ...rest] = techniqueId.slice(inventoryPrefix.length).split(':');
      const outputMaterialId = parseMaterial(outputKey ?? '');
      if (!inputKey || outputMaterialId === null || rest.length > 0) return null;
      const inputMaterialIds: number[] = [];
      for (const token of inputKey.split('+')) {
        const match = /^(\d+)x(\d+)$/.exec(token);
        const materialId = match ? parseMaterial(match[1]) : null;
        const quantity = match ? parseMaterial(match[2]) : null;
        if (materialId === null || quantity === null || quantity <= 0) return null;
        inputMaterialIds.push(...Array.from({ length: quantity }, () => materialId));
      }
      return {
        operation: 'combine',
        inputMaterialIds,
        toolMaterialId: null,
        targetMaterialId: null,
        outputMaterialId,
      };
    }
    const parts = techniqueId.split(':');
    if (parts[0] !== 'technique') return null;
    if (parts[1] === 'combine' && parts.length === 5) {
      const values = parts.slice(2).map(parseMaterial);
      if (values.some((value) => value === null)) return null;
      return {
        operation: 'combine',
        inputMaterialIds: [values[0]!],
        toolMaterialId: null,
        targetMaterialId: values[1]!,
        outputMaterialId: values[2]!,
      };
    }
    if (parts[1] === 'exert' && parts.length === 6) {
      const values = parts.slice(2).map(parseMaterial);
      if (values.some((value) => value === null)) return null;
      return {
        operation: 'exert',
        inputMaterialIds: [values[1]!],
        toolMaterialId: values[0]!,
        targetMaterialId: values[2]!,
        outputMaterialId: values[3]!,
      };
    }
    if (parts[1] === 'expose' && parts.length === 5) {
      const values = parts.slice(2).map(parseMaterial);
      if (values.some((value) => value === null)) return null;
      return {
        operation: 'expose',
        inputMaterialIds: [values[0]!],
        toolMaterialId: null,
        targetMaterialId: values[1]!,
        outputMaterialId: values[2]!,
      };
    }
    return null;
  };
  const basisSignature = (basis: Record<string, unknown>): TechniqueSignature | null => {
    const operation = operationValue(basis.operation);
    const inputMaterialIds = exactIntegerValues(basis.inputMaterialIds);
    const outputMaterialId = integerValue(basis.outputMaterialId);
    if (!operation || !inputMaterialIds?.length || outputMaterialId === null) return null;
    return {
      operation,
      inputMaterialIds,
      toolMaterialId: integerValue(basis.toolMaterialId),
      targetMaterialId: integerValue(basis.targetMaterialId),
      outputMaterialId,
    };
  };
  const signaturesMatch = (left: TechniqueSignature, right: TechniqueSignature): boolean => (
    left.operation === right.operation
      && sameMaterials(left.inputMaterialIds, right.inputMaterialIds)
      && left.toolMaterialId === right.toolMaterialId
      && left.targetMaterialId === right.targetMaterialId
      && left.outputMaterialId === right.outputMaterialId
  );
  const actionRecord = (event: Record<string, unknown>): Record<string, unknown> | null => (
    event.kind === 'action' ? objectRecord(event.action) : null
  );
  const diffRecord = (event: Record<string, unknown>): Record<string, unknown> => (
    objectRecord(event.diff) ?? {}
  );
  const responseSignature = (event: Record<string, unknown>): TechniqueSignature | null => {
    const action = actionRecord(event);
    const diff = diffRecord(event);
    const operation = action?.kind === 'act' ? operationValue(action.operation) : null;
    const outputMaterialId = integerValue(diff.outputMaterialId);
    if (!operation || outputMaterialId === null) return null;
    const inputMaterialIds = exactIntegerValues(diff.inputMaterialIds)
      ?? (integerValue(diff.inputMaterialId) === null ? null : [integerValue(diff.inputMaterialId)!]);
    if (!inputMaterialIds?.length) return null;
    return {
      operation,
      inputMaterialIds,
      toolMaterialId: integerValue(diff.toolMaterialId),
      targetMaterialId: integerValue(diff.targetMaterialId),
      outputMaterialId,
    };
  };
  const basicLearningResponse = (
    event: Record<string, unknown>,
    stage: 'demonstration' | 'imitation',
  ): boolean => {
    const action = actionRecord(event);
    const diff = diffRecord(event);
    return event.status === 'completed'
      && action?.kind === 'act'
      && operationValue(action.operation) !== null
      && diff.techniqueLearningStage === stage
      && stringValue(diff.techniqueId) !== null
      && stringValue(diff.techniqueProjectId) !== null
      && stringValue(diff.techniqueLearnerId) !== null
      && stringValue(diff.sourceEventId) === stringValue(event.id)
      && responseSignature(event) !== null;
  };
  const requestPayload = (content: Record<string, unknown> | null): Record<string, unknown> | null => (
    objectRecord(content?.techniqueDemonstration)
      ?? objectRecord(objectRecord(content?.request)?.techniqueDemonstration)
  );
  const sourceKeyActor = (sourceKey: string): string | null => (
    /^inventory:([^:]+):/.exec(sourceKey)?.[1] ?? null
  );
  const physicalActionSourceKeys = (event: Record<string, unknown>): { keys: string[]; complete: boolean } => {
    const action = actionRecord(event);
    const diff = diffRecord(event);
    if (action?.kind !== 'act' || !operationValue(action.operation)) return { keys: [], complete: false };
    const targets = records(action.targets);
    const keys: string[] = [];
    let complete = true;
    for (const target of targets) {
      if (target.kind === 'inventory-stack') {
        const personId = stringValue(target.personId);
        const stackId = stringValue(target.stackId);
        if (!personId || !stackId) complete = false;
        else keys.push(`inventory:${personId}:${stackId}`);
      } else if (target.kind === 'voxel') {
        const position = objectRecord(target.position);
        const x = integerValue(position?.x);
        const y = integerValue(position?.y);
        const z = integerValue(position?.z);
        const materialId = integerValue(diff.targetMaterialId);
        if (x === null || y === null || z === null || materialId === null) complete = false;
        else keys.push(`voxel:${x}:${y}:${z}:${materialId}`);
      }
    }
    const toolStackId = stringValue(action.toolStackId);
    const actorId = stringValue(event.who);
    if (toolStackId && actorId) keys.push(`inventory:${actorId}:${toolStackId}`);
    else if (toolStackId) complete = false;
    return { keys: [...new Set(keys)], complete: complete && keys.length > 0 };
  };
  const supportsFunction = (desiredFunction: string | null, outputMaterialId: number | null): boolean => {
    if (!desiredFunction || outputMaterialId === null) return false;
    if (desiredFunction === 'insulation') return materialHas(outputMaterialId, 'insulating');
    if (desiredFunction === 'safer-hunting') return materialHas(outputMaterialId, 'tool');
    if (desiredFunction === 'healing') return (materialDefinition(outputMaterialId).consume?.health ?? 0) > 0;
    if (desiredFunction === 'prepared-food') {
      return outputMaterialId === Material.CookedFood || materialHas(outputMaterialId, 'hot');
    }
    if (desiredFunction === 'durable-record') return materialHas(outputMaterialId, 'recordable');
    return false;
  };

  const people = indexedRecords(rawState.people);
  const projects = indexedRecords(rawState.projects);
  const sourceRecords = indexedRecords(rawState.records);
  const events = indexedRecords(rawState.world?.past);
  const personById = new Map(people.flatMap((entry) => {
    const id = stringValue(entry.value.id);
    return id ? [[id, entry.value] as const] : [];
  }));
  const projectEntriesById = new Map<string, IndexedRecord[]>();
  for (const entry of projects) {
    const id = stringValue(entry.value.id);
    if (!id) continue;
    const matches = projectEntriesById.get(id) ?? [];
    matches.push(entry);
    projectEntriesById.set(id, matches);
  }
  const eventById = new Map(events.flatMap((entry) => {
    const id = stringValue(entry.value.id);
    return id ? [[id, entry] as const] : [];
  }));
  const sourceRecordById = new Map(sourceRecords.flatMap((entry) => {
    const id = stringValue(entry.value.id);
    return id ? [[id, entry.value] as const] : [];
  }));
  const actionPositionsByPerson = new Map<string, Array<{ index: number; cellId: number; z: number }>>();
  for (const entry of events) {
    if (entry.value.kind !== 'action') continue;
    const personId = stringValue(entry.value.who);
    const cellId = integerValue(entry.value.toCellId);
    const z = integerValue(entry.value.toZ);
    if (!personId || cellId === null || z === null) continue;
    const positions = actionPositionsByPerson.get(personId) ?? [];
    positions.push({ index: entry.index, cellId, z });
    actionPositionsByPerson.set(personId, positions);
  }
  const positionBefore = (personId: string | null, eventIndex: number | null) => {
    if (!personId || eventIndex === null) return null;
    const positions = actionPositionsByPerson.get(personId) ?? [];
    let low = 0;
    let high = positions.length - 1;
    let match: { index: number; cellId: number; z: number } | null = null;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (positions[middle].index < eventIndex) {
        match = positions[middle];
        low = middle + 1;
      } else high = middle - 1;
    }
    return match;
  };
  const reliableTechnique = (personId: string | null, techniqueId: string | null) => {
    const person = personId ? personById.get(personId) : null;
    return records(person?.knowledge).find((fact) => fact.id === techniqueId
      && fact.kind === 'technique'
      && (finiteValue(fact.confidence) ?? -Infinity) >= 55) ?? null;
  };

  const requestAttempts: Array<{
    entry: IndexedRecord;
    action: Record<string, unknown>;
    content: Record<string, unknown>;
    request: Record<string, unknown> | null;
    audienceIds: string[];
  }> = [];
  for (const entry of events) {
    const action = actionRecord(entry.value);
    const content = objectRecord(action?.content);
    if (action?.kind !== 'communicate' || content?.kind !== 'request') continue;
    const directMarker = Object.prototype.hasOwnProperty.call(content, 'techniqueDemonstration');
    const nestedMarker = Object.prototype.hasOwnProperty.call(objectRecord(content.request) ?? {}, 'techniqueDemonstration');
    if (!directMarker && !nestedMarker) continue;
    requestAttempts.push({
      entry,
      action,
      content,
      request: requestPayload(content),
      audienceIds: stringKeys(action.audience),
    });
  }
  const requestByEventId = new Map(requestAttempts.flatMap((request) => {
    const eventId = stringValue(request.entry.value.id);
    return eventId ? [[eventId, request] as const] : [];
  }));
  const requestPersonMismatches = new Set<string>();
  const requestProjectMismatches = new Set<string>();
  const requestFunctionMismatches = new Set<string>();
  const requestPairCounts = new Map<string, number>();
  for (const requestEntry of requestAttempts) {
    const { entry, request, audienceIds } = requestEntry;
    const requesterId = stringValue(request?.requesterId);
    const projectId = stringValue(request?.projectId);
    const desiredFunction = stringValue(request?.desiredFunction);
    const requestKey = entry.key;
    const projectMatches = projectId ? projectEntriesById.get(projectId) ?? [] : [];
    const project = projectMatches.length === 1 ? projectMatches[0].value : null;
    const uniqueAudienceIds = [...new Set(audienceIds)];
    if (!requesterId || requesterId !== entry.value.who || !personById.has(requesterId)
      || !audienceIds.length || uniqueAudienceIds.length !== audienceIds.length
      || audienceIds.some((audienceId) => audienceId === requesterId || !personById.has(audienceId))) {
      requestPersonMismatches.add(requestKey);
    }
    const createdAtMonth = integerValue(project?.createdAtMonth);
    const requestMonth = integerValue(entry.value.atMonth);
    if (!project || project.ownerId !== requesterId
      || project.kind !== 'inquiry'
      || createdAtMonth === null || requestMonth === null || createdAtMonth > requestMonth) {
      requestProjectMismatches.add(requestKey);
    }
    if (!desiredFunction || desiredFunction !== project?.desiredFunction) {
      requestFunctionMismatches.add(requestKey);
    }
    if (projectId) {
      for (const audienceId of uniqueAudienceIds) {
        const pairKey = `${projectId}\u0000${audienceId}`;
        requestPairCounts.set(pairKey, (requestPairCounts.get(pairKey) ?? 0) + 1);
      }
    }
  }
  const uniqueProjectTeachers = requestPairCounts.size;
  const duplicateRequests = [...requestPairCounts.values()]
    .reduce((sum, count) => sum + Math.max(0, count - 1), 0);

  const demonstrationActions = events.filter((entry) => {
    const action = actionRecord(entry.value);
    const diff = diffRecord(entry.value);
    return objectRecord(action?.techniqueDemonstration) !== null
      || diff.techniqueLearningStage === 'demonstration';
  });
  const demonstrationResponses = demonstrationActions.filter((entry) => (
    basicLearningResponse(entry.value, 'demonstration')
  )).length;
  const unresolvedBases = new Set<string>();
  const unresolvedRequestEvents = new Set<string>();
  const unresolvedActionEvents = new Set<string>();
  const demonstratorMismatches = new Set<string>();
  const demonstratorReliabilityMismatches = new Set<string>();
  const learnerMismatches = new Set<string>();
  const projectMismatches = new Set<string>();
  const functionMismatches = new Set<string>();
  const colocationMismatches = new Set<string>();
  const techniqueMismatches = new Set<string>();
  const operationMismatches = new Set<string>();
  const responseMismatches = new Set<string>();
  const orderViolations = new Set<string>();
  const sourceMismatches = new Set<string>();
  const exactSourceMismatches = new Set<string>();
  const directReliableViolations = new Set<string>();
  for (const entry of demonstrationActions) {
    if ((finiteValue(diffRecord(entry.value).techniqueConfidenceAfter) ?? -Infinity) >= 55) {
      directReliableViolations.add(stringValue(entry.value.id) ?? entry.key);
    }
  }
  const basisAudits: BasisAudit[] = [];
  let demonstrationBases = 0;
  let sourcedBases = 0;
  let exactSourceBases = 0;
  let tentativeLessons = 0;

  for (const projectEntry of projects) {
    const project = projectEntry.value;
    const rawBases = Array.isArray(project.techniqueDemonstrations)
      ? project.techniqueDemonstrations
      : [];
    for (const [basisIndex, rawBasis] of rawBases.entries()) {
      demonstrationBases += 1;
      const key = `${stringValue(project.id) ?? projectEntry.key}\u0000basis:${basisIndex}`;
      const basis = objectRecord(rawBasis);
      if (!basis) {
        unresolvedBases.add(key);
        projectMismatches.add(key);
        sourceMismatches.add(key);
        responseMismatches.add(key);
        continue;
      }
      const projectId = stringValue(basis.projectId);
      const learnerId = stringValue(basis.learnerId);
      const demonstratorId = stringValue(basis.demonstratorId);
      const requestEventId = stringValue(basis.requestEventId);
      const demonstrationEventId = stringValue(basis.demonstrationEventId);
      const techniqueId = stringValue(basis.techniqueId);
      const desiredFunction = stringValue(basis.desiredFunction);
      const requestEntry = requestEventId ? requestByEventId.get(requestEventId) : null;
      const request = requestEntry?.request ?? null;
      const demonstrationEntry = demonstrationEventId ? eventById.get(demonstrationEventId) : null;
      const demonstrationEvent = demonstrationEntry?.value ?? null;
      const demonstrationAction = demonstrationEvent ? actionRecord(demonstrationEvent) : null;
      const demonstrationRef = objectRecord(demonstrationAction?.techniqueDemonstration);
      const demonstrationDiff = demonstrationEvent ? diffRecord(demonstrationEvent) : {};
      const signature = basisSignature(basis);
      const parsedTechnique = parseTechnique(techniqueId);
      const actualSignature = demonstrationEvent ? responseSignature(demonstrationEvent) : null;
      const requestResolved = Boolean(requestEntry && request);
      const demonstrationResolved = Boolean(demonstrationEntry
        && demonstrationEvent?.kind === 'action'
        && demonstrationAction?.kind === 'act');
      if (!requestResolved) unresolvedRequestEvents.add(key);
      if (!demonstrationResolved) unresolvedActionEvents.add(key);

      const requestPersonMatches = Boolean(requestResolved
        && requestEntry?.entry.value.status === 'completed'
        && request?.requesterId === learnerId
        && requestEntry?.entry.value.who === learnerId);
      const demonstratorMatches = Boolean(demonstratorId
        && demonstratorId !== learnerId
        && personById.has(demonstratorId)
        && requestEntry?.audienceIds.includes(demonstratorId)
        && demonstrationEvent?.who === demonstratorId
        && demonstrationRef?.requestEventId === requestEventId
        && demonstrationDiff.techniqueRequestEventId === requestEventId
        && demonstrationDiff.techniqueDemonstratorId === demonstratorId);
      if (!demonstratorMatches) demonstratorMismatches.add(key);
      const demonstrationMonth = integerValue(demonstrationEvent?.atMonth);
      const demonstratorFact = reliableTechnique(demonstratorId, techniqueId);
      const demonstratorReliable = Boolean(demonstratorFact
        && demonstrationMonth !== null
        && (integerValue(demonstratorFact.learnedAtMonth) ?? Infinity) <= demonstrationMonth);
      if (!demonstratorReliable) demonstratorReliabilityMismatches.add(key);
      const learnerMatches = Boolean(learnerId
        && personById.has(learnerId)
        && project.ownerId === learnerId
        && requestPersonMatches
        && demonstrationRef?.learnerId === learnerId
        && demonstrationDiff.techniqueLearnerId === learnerId);
      if (!learnerMatches) learnerMismatches.add(key);
      const projectActionEventIds = stringKeys(project.actionEventIds);
      const projectMatches = Boolean(projectId
        && projectId === project.id
        && project.kind === 'inquiry'
        && (projectEntriesById.get(projectId)?.length ?? 0) === 1
        && demonstrationRef?.projectId === projectId
        && demonstrationDiff.techniqueProjectId === projectId
        && request?.projectId === projectId
        && demonstrationEventId
        && projectActionEventIds.includes(demonstrationEventId));
      if (!projectMatches) projectMismatches.add(key);
      const functionMatches = Boolean(desiredFunction
        && desiredFunction === project.desiredFunction
        && request?.desiredFunction === desiredFunction
        && signature
        && supportsFunction(desiredFunction, signature.outputMaterialId));
      if (!functionMatches) functionMismatches.add(key);
      const teacherCell = integerValue(demonstrationEvent?.fromCellId);
      const teacherZ = integerValue(demonstrationEvent?.fromZ);
      const learnerPosition = positionBefore(learnerId, demonstrationEntry?.index ?? null);
      const learner = learnerId ? personById.get(learnerId) : null;
      const observationRadius = learner
        ? 4 + Math.floor((finiteValue(objectRecord(learner.baselineCapacities)?.perception) ?? 0) / 25)
        : -1;
      const observable = teacherCell !== null && teacherZ !== null && learnerPosition !== null
        && observationRadius >= 0
        && Math.abs((teacherCell % state.world.grid.width) - (learnerPosition.cellId % state.world.grid.width))
          + Math.abs(Math.floor(teacherCell / state.world.grid.width) - Math.floor(learnerPosition.cellId / state.world.grid.width)) <= observationRadius
        && Math.abs(teacherZ - learnerPosition.z) <= 2;
      if (!observable) colocationMismatches.add(key);
      const techniqueMatches = Boolean(techniqueId
        && demonstrationRef?.techniqueId === techniqueId
        && demonstrationDiff.techniqueId === techniqueId
        && signature
        && parsedTechnique
        && signaturesMatch(signature, parsedTechnique));
      if (!techniqueMatches) techniqueMismatches.add(key);
      const operationMatches = Boolean(signature
        && demonstrationAction?.operation === signature.operation
        && parsedTechnique?.operation === signature.operation);
      if (!operationMatches) operationMismatches.add(key);
      const responseMatches = Boolean(demonstrationEvent
        && signature
        && actualSignature
        && basicLearningResponse(demonstrationEvent, 'demonstration')
        && signaturesMatch(signature, actualSignature));
      if (!responseMatches) responseMismatches.add(key);
      const requestIndex = requestEntry?.entry.index ?? null;
      const demonstrationIndex = demonstrationEntry?.index ?? null;
      const requestMonth = integerValue(requestEntry?.entry.value.atMonth);
      const expiresAtMonth = integerValue(request?.expiresAtMonth);
      const basisMonth = integerValue(basis.atMonth);
      let orderMatches = requestIndex !== null && demonstrationIndex !== null
        && requestIndex < demonstrationIndex
        && requestMonth !== null && demonstrationMonth !== null
        && requestMonth <= demonstrationMonth
        && expiresAtMonth !== null && demonstrationMonth <= expiresAtMonth
        && basisMonth === demonstrationMonth;
      const basisSourceKeys = exactStringKeys(basis.sourceKeys);
      const basisSourceFactIds = exactStringKeys(basis.sourceFactIds);
      const sourceFactsResolve = Boolean(basisSourceFactIds?.length
        && basisSourceFactIds.every((sourceId) => (
          eventById.has(sourceId) || sourceRecordById.has(sourceId)
        )));
      if (sourceFactsResolve && demonstrationIndex !== null) {
        const futureSource = basisSourceFactIds!.some((sourceId) => {
          const sourceEvent = eventById.get(sourceId);
          if (sourceEvent) return sourceEvent.index > demonstrationIndex;
          const sourceRecordMonth = integerValue(sourceRecordById.get(sourceId)?.createdAtMonth);
          return sourceRecordMonth === null || demonstrationMonth === null
            || sourceRecordMonth > demonstrationMonth;
        });
        if (futureSource) orderMatches = false;
      }
      if (!orderMatches) orderViolations.add(key);
      const sourced = Boolean(basisSourceKeys?.length && sourceFactsResolve);
      if (sourced) sourcedBases += 1;
      else sourceMismatches.add(key);
      const diffSourceKeys = exactStringKeys(demonstrationDiff.techniqueSourceKeys);
      const physicalSources = demonstrationEvent
        ? physicalActionSourceKeys(demonstrationEvent)
        : { keys: [], complete: false };
      const exactSource = Boolean(sourced
        && diffSourceKeys?.length
        && physicalSources.complete
        && sameStrings(basisSourceKeys!, diffSourceKeys)
        && physicalSources.keys.every((sourceKey) => diffSourceKeys.includes(sourceKey))
        && physicalSources.keys.every((sourceKey) => {
          const actorId = sourceKeyActor(sourceKey);
          return actorId === null || actorId === demonstratorId;
        }));
      if (exactSource) exactSourceBases += 1;
      else exactSourceMismatches.add(key);
      const initialConfidence = finiteValue(basis.initialConfidence);
      const confidenceBefore = finiteValue(demonstrationDiff.techniqueConfidenceBefore);
      const confidenceAfter = finiteValue(demonstrationDiff.techniqueConfidenceAfter);
      const tentative = initialConfidence !== null
        && initialConfidence >= 0 && initialConfidence < 55
        && confidenceBefore !== null && confidenceBefore < 55
        && confidenceAfter === initialConfidence;
      if (tentative) tentativeLessons += 1;
      if ((initialConfidence !== null && initialConfidence >= 55)
        || (confidenceAfter !== null && confidenceAfter >= 55)) {
        directReliableViolations.add(demonstrationEventId ?? key);
      }
      if (!tentative) responseMismatches.add(key);
      const requestPairKey = projectId && demonstratorId ? `${projectId}\u0000${demonstratorId}` : null;
      const valid = requestResolved
        && demonstrationResolved
        && requestPersonMatches
        && demonstratorMatches
        && demonstratorReliable
        && learnerMatches
        && projectMatches
        && functionMatches
        && observable
        && techniqueMatches
        && operationMatches
        && responseMatches
        && orderMatches
        && sourced
        && exactSource
        && tentative
        && Boolean(requestPairKey && requestPairCounts.get(requestPairKey) === 1);
      basisAudits.push({
        key,
        project,
        projectId,
        learnerId,
        demonstratorId,
        techniqueId,
        requestEventId,
        demonstrationEventId,
        demonstrationIndex,
        signature,
        valid,
        exactSource,
        tentative,
      });
    }
  }
  const basisAuditsByDemonstration = new Map<string, BasisAudit[]>();
  for (const audit of basisAudits) {
    if (!audit.demonstrationEventId) continue;
    const matches = basisAuditsByDemonstration.get(audit.demonstrationEventId) ?? [];
    matches.push(audit);
    basisAuditsByDemonstration.set(audit.demonstrationEventId, matches);
  }
  for (const entry of demonstrationActions) {
    const eventId = stringValue(entry.value.id);
    if (!eventId || (basisAuditsByDemonstration.get(eventId)?.length ?? 0) !== 1) {
      unresolvedBases.add(eventId ?? entry.key);
    }
  }

  const imitationAttempts = events.filter((entry) => {
    const action = actionRecord(entry.value);
    const diff = diffRecord(entry.value);
    return objectRecord(action?.techniqueImitation) !== null
      || diff.techniqueLearningStage === 'imitation';
  });
  const imitationResponses = imitationAttempts.filter((entry) => (
    basicLearningResponse(entry.value, 'imitation')
  )).length;
  const imitationUnresolvedBases = new Set<string>();
  const imitationSourceMismatches = new Set<string>();
  const imitationActorMismatches = new Set<string>();
  const imitationProjectMismatches = new Set<string>();
  const imitationTechniqueMismatches = new Set<string>();
  const imitationOperationMismatches = new Set<string>();
  const imitationResponseMismatches = new Set<string>();
  const imitationOrderViolations = new Set<string>();
  const imitationExactSourceMismatches = new Set<string>();
  const imitationAudits: ImitationAudit[] = [];
  let exactSourceImitations = 0;

  for (const entry of imitationAttempts) {
    const event = entry.value;
    const key = entry.key;
    const action = actionRecord(event);
    const imitationRef = objectRecord(action?.techniqueImitation);
    const diff = diffRecord(event);
    const demonstrationEventId = stringValue(imitationRef?.demonstrationEventId)
      ?? stringValue(diff.techniqueDemonstrationEventId);
    const basisMatches = demonstrationEventId
      ? basisAuditsByDemonstration.get(demonstrationEventId) ?? []
      : [];
    const basis = basisMatches.length === 1 ? basisMatches[0] : null;
    if (!basis) imitationUnresolvedBases.add(key);
    const signature = basis?.signature ?? null;
    const actualSignature = responseSignature(event);
    const parsedTechnique = parseTechnique(basis?.techniqueId ?? null);
    const physicalSources = physicalActionSourceKeys(event);
    const normalizedActorMatches = Boolean(basis?.learnerId
      && event.who === basis.learnerId
      && diff.techniqueLearnerId === basis.learnerId
      && physicalSources.keys.every((sourceKey) => {
        const sourceActor = sourceKeyActor(sourceKey);
        return sourceActor === null || sourceActor === basis.learnerId;
      }));
    if (!normalizedActorMatches) imitationActorMismatches.add(key);
    const projectMatches = Boolean(basis?.projectId
      && imitationRef?.projectId === basis.projectId
      && diff.techniqueProjectId === basis.projectId
      && stringKeys(basis.project.actionEventIds).includes(stringValue(event.id) ?? ''));
    if (!projectMatches) imitationProjectMismatches.add(key);
    const techniqueMatches = Boolean(basis?.techniqueId
      && imitationRef?.techniqueId === basis.techniqueId
      && diff.techniqueId === basis.techniqueId
      && signature
      && parsedTechnique
      && signaturesMatch(signature, parsedTechnique));
    if (!techniqueMatches) imitationTechniqueMismatches.add(key);
    const operationMatches = Boolean(signature
      && action?.kind === 'act'
      && action.operation === signature.operation);
    if (!operationMatches) imitationOperationMismatches.add(key);
    const responseMatches = Boolean(signature
      && actualSignature
      && basicLearningResponse(event, 'imitation')
      && signaturesMatch(signature, actualSignature)
      && diff.techniqueDemonstrationEventId === basis?.demonstrationEventId
      && (finiteValue(diff.techniqueConfidenceBefore) ?? Infinity) < 55
      && (finiteValue(diff.techniqueConfidenceAfter) ?? -Infinity) >= 55);
    if (!responseMatches) imitationResponseMismatches.add(key);
    const sourceMatches = Boolean(signature && actualSignature
      && sameMaterials(signature.inputMaterialIds, actualSignature.inputMaterialIds)
      && signature.toolMaterialId === actualSignature.toolMaterialId
      && signature.targetMaterialId === actualSignature.targetMaterialId);
    if (!sourceMatches) imitationSourceMismatches.add(key);
    const orderMatches = Boolean(basis?.demonstrationIndex !== null
      && basis?.demonstrationIndex !== undefined
      && basis.demonstrationIndex < entry.index);
    if (!orderMatches) imitationOrderViolations.add(key);
    const imitationSourceKeys = exactStringKeys(diff.techniqueImitationSourceKeys);
    const exactSource = Boolean(imitationSourceKeys?.length
      && physicalSources.complete
      && physicalSources.keys.every((sourceKey) => imitationSourceKeys.includes(sourceKey))
      && physicalSources.keys.every((sourceKey) => {
        const sourceActor = sourceKeyActor(sourceKey);
        return sourceActor === null || sourceActor === basis?.learnerId;
      }));
    if (exactSource) exactSourceImitations += 1;
    else imitationExactSourceMismatches.add(key);
    imitationAudits.push({
      key,
      event,
      eventIndex: entry.index,
      basis,
      valid: Boolean(basis?.valid
        && normalizedActorMatches
        && projectMatches
        && techniqueMatches
        && operationMatches
        && responseMatches
        && sourceMatches
        && orderMatches
        && exactSource),
      exactSource,
    });
  }

  const reliableLearnerIds = new Set<string>();
  for (const basis of basisAudits) {
    if (!basis.learnerId || !basis.techniqueId || !reliableTechnique(basis.learnerId, basis.techniqueId)) continue;
    reliableLearnerIds.add(basis.learnerId);
  }
  const reliableWithoutOwnImitation = new Set<string>();
  const completeChains = new Set<string>();
  const progressChains = new Set<string>();
  const completionChains = new Set<string>();
  const generationLearners = new Set<string>();
  for (const basis of basisAudits) {
    if (!basis.learnerId || !basis.techniqueId) continue;
    const lessonKey = `${basis.learnerId}\u0000${basis.techniqueId}`;
    const reliable = reliableTechnique(basis.learnerId, basis.techniqueId);
    const validImitations = imitationAudits.filter((imitation) => (
      imitation.valid && imitation.basis?.key === basis.key
    ));
    if (reliable && validImitations.length === 0) reliableWithoutOwnImitation.add(lessonKey);
    if (!basis.valid || !reliable || validImitations.length === 0) continue;
    const imitation = validImitations.sort((left, right) => left.eventIndex - right.eventIndex)[0];
    completeChains.add(basis.key);
    const progressAfter = records(basis.project.progressEvidence).some((evidence) => {
      const eventId = stringValue(evidence.eventId);
      const progressIndex = eventId ? eventById.get(eventId)?.index : undefined;
      return progressIndex !== undefined && progressIndex >= imitation.eventIndex;
    });
    if (progressAfter) progressChains.add(basis.key);
    const completionAfter = basis.project.status === 'completed'
      && stringKeys(basis.project.completionEventIds).some((eventId) => (
        (eventById.get(eventId)?.index ?? -1) >= imitation.eventIndex
      ));
    if (completionAfter) completionChains.add(basis.key);
    const learner = personById.get(basis.learnerId);
    if ((integerValue(learner?.generation) ?? 0) > 0) generationLearners.add(basis.learnerId);
  }

  const techniqueTeachingEvents = events.filter((entry) => {
    const event = entry.value;
    const action = actionRecord(event);
    const content = objectRecord(action?.content);
    return event.status === 'completed'
      && action?.kind === 'communicate'
      && content?.kind === 'claim'
      && stringValue(content.id)?.startsWith('teach:') === true
      && stringValue(content.factId)?.startsWith('technique:') === true
      && requestPayload(content) === null;
  });
  const techniqueTeachingLearnerIds = new Set<string>();
  let techniqueTeachingUnderageViolations = 0;
  let techniqueTeachingUnreliableTeacherViolations = 0;
  for (const entry of techniqueTeachingEvents) {
    const event = entry.value;
    const diff = diffRecord(event);
    const teacherConfidence = finiteValue(diff.teachingTeacherConfidence);
    if (teacherConfidence === null || teacherConfidence < 55) techniqueTeachingUnreliableTeacherViolations += 1;
    const atMonth = integerValue(event.atMonth) ?? 0;
    for (const learnerId of stringKeys(diff.taughtAudienceIds)) {
      techniqueTeachingLearnerIds.add(learnerId);
      const learner = personById.get(learnerId);
      const bornAtMonth = integerValue(learner?.bornAtMonth);
      if (bornAtMonth !== null && atMonth - bornAtMonth < 6 * 12) techniqueTeachingUnderageViolations += 1;
    }
  }

  return {
    techniqueDemonstrationRequestAttempts: requestAttempts.length,
    techniqueDemonstrationRequests: requestAttempts.filter((request) => request.entry.value.status === 'completed').length,
    techniqueDemonstrationUniqueProjectTeachers: uniqueProjectTeachers,
    techniqueDemonstrationDuplicateRequests: duplicateRequests,
    techniqueDemonstrationActions: demonstrationActions.length,
    techniqueDemonstrationResponses: demonstrationResponses,
    techniqueDemonstrationBases: demonstrationBases,
    techniqueDemonstrationSourcedBases: sourcedBases,
    techniqueDemonstrationSourceCoverage: coverage(sourcedBases, demonstrationBases),
    techniqueDemonstrationExactSourceCoverage: coverage(exactSourceBases, demonstrationBases),
    techniqueDemonstrationTentativeLessons: tentativeLessons,
    techniqueDemonstrationDirectReliableViolations: directReliableViolations.size,
    techniqueDemonstrationUnresolvedBases: unresolvedBases.size,
    techniqueDemonstrationUnresolvedRequestEvents: unresolvedRequestEvents.size,
    techniqueDemonstrationUnresolvedActionEvents: unresolvedActionEvents.size,
    techniqueDemonstrationRequestPersonMismatches: requestPersonMismatches.size,
    techniqueDemonstrationRequestProjectMismatches: requestProjectMismatches.size,
    techniqueDemonstrationRequestFunctionMismatches: requestFunctionMismatches.size,
    techniqueDemonstrationDemonstratorMismatches: demonstratorMismatches.size,
    techniqueDemonstrationDemonstratorReliabilityMismatches: demonstratorReliabilityMismatches.size,
    techniqueDemonstrationLearnerMismatches: learnerMismatches.size,
    techniqueDemonstrationProjectMismatches: projectMismatches.size,
    techniqueDemonstrationFunctionMismatches: functionMismatches.size,
    techniqueDemonstrationColocationMismatches: colocationMismatches.size,
    techniqueDemonstrationTechniqueMismatches: techniqueMismatches.size,
    techniqueDemonstrationOperationMismatches: operationMismatches.size,
    techniqueDemonstrationResponseMismatches: responseMismatches.size,
    techniqueDemonstrationOrderViolations: orderViolations.size,
    techniqueDemonstrationSourceMismatches: sourceMismatches.size,
    techniqueDemonstrationExactSourceMismatches: exactSourceMismatches.size,
    techniqueImitationAttempts: imitationAttempts.length,
    techniqueImitationResponses: imitationResponses,
    techniqueImitationExactSourceCoverage: coverage(exactSourceImitations, imitationAttempts.length),
    techniqueImitationUnresolvedBases: imitationUnresolvedBases.size,
    techniqueImitationSourceMismatches: imitationSourceMismatches.size,
    techniqueImitationActorMismatches: imitationActorMismatches.size,
    techniqueImitationProjectMismatches: imitationProjectMismatches.size,
    techniqueImitationTechniqueMismatches: imitationTechniqueMismatches.size,
    techniqueImitationOperationMismatches: imitationOperationMismatches.size,
    techniqueImitationResponseMismatches: imitationResponseMismatches.size,
    techniqueImitationOrderViolations: imitationOrderViolations.size,
    techniqueImitationExactSourceMismatches: imitationExactSourceMismatches.size,
    techniqueDemonstrationReliableLearners: reliableLearnerIds.size,
    techniqueReliableWithoutOwnImitationViolations: reliableWithoutOwnImitation.size,
    completeTechniqueLearningChains: completeChains.size,
    completeTechniqueLearningProjectProgressChains: progressChains.size,
    completeTechniqueLearningProjectCompletionChains: completionChains.size,
    generationGtZeroCausalReliableLearners: generationLearners.size,
    techniqueTeachingActions: techniqueTeachingEvents.length,
    techniqueTeachingLearners: techniqueTeachingLearnerIds.size,
    techniqueTeachingUnderageViolations,
    techniqueTeachingUnreliableTeacherViolations,
  };
}

function groundedConversationMetrics(state: SimulationState) {
  const allActionEvents = state.world.past.filter((event) => event.kind === 'action');
  const eventIds = new Set(state.world.past.map((event) => event.id));
  const grounded = allActionEvents.flatMap((event) => {
    if (event.status !== 'completed'
      || event.action.kind !== 'communicate'
      || event.action.content.kind !== 'claim'
      || !event.action.content.conversation) return [];
    return [{ event, conversation: event.action.content.conversation }];
  });
  const openings = grounded.filter((entry) => entry.conversation.turn === 'opening');
  const responses = grounded.filter((entry) => entry.conversation.turn === 'response');
  const openingById = new Map(openings.map((entry) => [entry.event.id, entry]));
  const topicIds = new Set(grounded.map((entry) => entry.conversation.topic));
  const participantIds = new Set(grounded.flatMap((entry) => [entry.conversation.speakerId, entry.conversation.listenerId]));
  const generationGtZeroParticipants = state.people.filter((person) => participantIds.has(person.id) && person.generation > 0).length;
  const sourcedOpenings = openings.filter((entry) => entry.conversation.sourceFactIds.length > 0
    && entry.conversation.sourceFactIds.every((sourceId) => eventIds.has(sourceId))).length;
  const unresolvedSources = grounded.filter((entry) => entry.conversation.sourceFactIds.length === 0
    || entry.conversation.sourceFactIds.some((sourceId) => !eventIds.has(sourceId))).length;
  const basisCounts = new Map<string, number>();
  for (const entry of openings) basisCounts.set(entry.conversation.basisKey, (basisCounts.get(entry.conversation.basisKey) ?? 0) + 1);
  const duplicateBases = [...basisCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const participantMismatches = grounded.filter((entry) => entry.event.who !== entry.conversation.speakerId
    || entry.event.action.kind !== 'communicate'
    || entry.event.action.audience.length !== 1
    || entry.event.action.audience[0] !== entry.conversation.listenerId).length;
  const responseMatchesOpening = (entry: typeof responses[number]) => {
    const referenceId = entry.conversation.referenceEventId;
    const opening = referenceId ? openingById.get(referenceId) : undefined;
    return Boolean(opening
      && opening.conversation.speakerId === entry.conversation.listenerId
      && opening.conversation.listenerId === entry.conversation.speakerId
      && opening.conversation.topic === entry.conversation.topic
      && opening.conversation.basisKey === entry.conversation.basisKey
      && [...new Set(opening.conversation.sourceFactIds)].sort().join(',')
        === [...new Set(entry.conversation.sourceFactIds)].sort().join(','));
  };
  const validResponses = responses.filter(responseMatchesOpening);
  const responseReferenceCounts = new Map<string, number>();
  for (const entry of validResponses) {
    const referenceId = entry.conversation.referenceEventId;
    if (referenceId) responseReferenceCounts.set(referenceId, (responseReferenceCounts.get(referenceId) ?? 0) + 1);
  }
  const responseReferences = new Set(responseReferenceCounts.keys());
  const duplicateResponses = [...responseReferenceCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const responseMismatches = responses.length - validResponses.length + duplicateResponses;
  const relationshipEffectMismatches = grounded.filter((entry) => {
    const expected = entry.conversation.turn === 'opening'
      ? {
          trust: ['care', 'gratitude', 'shared-work', 'family'].includes(entry.conversation.topic) ? 1 : 0,
          bond: entry.conversation.topic === 'discovery' ? 1 : 2,
        }
      : entry.conversation.stance === 'guarded'
        ? { trust: 0, bond: 1 }
        : { trust: 1, bond: 2 };
    return Number(entry.event.diff.relationTrustDelta) !== expected.trust
      || Number(entry.event.diff.relationBondDelta) !== expected.bond
      || entry.event.diff.groundedConversationBasisKey !== entry.conversation.basisKey;
  }).length;
  const blockedAttempts = allActionEvents.filter((event) => event.diff.groundedConversationBlocked === true).length;
  return {
    groundedConversationOpenings: openings.length,
    groundedConversationResponses: responses.length,
    groundedConversationResponseCoverage: openings.length
      ? Math.round(responseReferences.size / openings.length * 10_000) / 100
      : 100,
    groundedConversationUniqueTopics: topicIds.size,
    groundedConversationParticipants: participantIds.size,
    groundedConversationGenerationGtZeroParticipants: generationGtZeroParticipants,
    groundedConversationSourcedOpenings: sourcedOpenings,
    groundedConversationSourceCoverage: openings.length
      ? Math.round(sourcedOpenings / openings.length * 10_000) / 100
      : 100,
    groundedConversationDuplicateBases: duplicateBases,
    groundedConversationUnresolvedSources: unresolvedSources,
    groundedConversationParticipantMismatches: participantMismatches,
    groundedConversationResponseMismatches: responseMismatches,
    groundedConversationRelationshipEffectMismatches: relationshipEffectMismatches,
    groundedConversationBlockedAttempts: blockedAttempts,
  };
}

function personIdsFrom(event: WorldEvent | undefined): string[] {
  if (!event) return [];
  if ('who' in event && event.who) return [event.who];
  return [];
}

function latestCheckpointEventCount(previous: EvolutionPath | undefined, currentEventCount: number): number {
  const eventCount = previous?.checkpoints.at(-1)?.eventCount;
  if (typeof eventCount !== 'number' || !Number.isInteger(eventCount)) return 0;
  return eventCount >= 0 && eventCount <= currentEventCount ? eventCount : 0;
}

function turningPoints(state: SimulationState, previous?: EvolutionPath): EvolutionTurningPoint[] {
  const points: EvolutionTurningPoint[] = [...(previous?.turningPoints ?? [])];
  const existingIds = new Set(points.map((point) => point.id));
  const newMilestones = state.derived.milestones.filter((milestone) => !existingIds.has(`milestone:${milestone.id}`));
  const history = committedHistoryView(state);
  const events = history.events;
  const fromAbsoluteIndex = latestCheckpointEventCount(previous, history.eventCount);
  if (fromAbsoluteIndex < history.hotStartIndex) {
    throw new Error(`演化转折点缺少绝对序号 ${fromAbsoluteIndex} 至 ${history.hotStartIndex - 1} 的连续历史`);
  }
  const fromEventIndex = fromAbsoluteIndex - history.hotStartIndex;
  const newMilestoneEvidenceIds = new Set(newMilestones.flatMap((milestone) => milestone.evidenceEventIds));
  const newMilestoneEvidence = new Map<string, WorldEvent>();
  for (let index = fromEventIndex; index < history.hotEventCount; index += 1) {
    const event = events[index];
    if (newMilestoneEvidenceIds.has(event.id)) newMilestoneEvidence.set(event.id, event);
    if (event.kind !== 'environment') continue;
    const bornPersonId = typeof event.diff.bornPersonId === 'string' ? event.diff.bornPersonId : undefined;
    const birthId = `birth:${event.id}`;
    if (bornPersonId && !existingIds.has(birthId)) {
      points.push({
        id: birthId, month: event.atMonth, kind: 'birth', title: '新生命诞生', summary: event.result,
        evidenceEventIds: [event.id], personIds: [bornPersonId, ...personIdsFrom(event)],
      });
      existingIds.add(birthId);
    }
    const deathId = `death:${event.id}`;
    if (event.change === 'death' && !existingIds.has(deathId)) {
      points.push({
        id: deathId, month: event.atMonth, kind: 'death', title: '生命终止', summary: event.result,
        evidenceEventIds: [event.id], personIds: personIdsFrom(event),
      });
      existingIds.add(deathId);
    }
  }
  for (const milestone of newMilestones) {
    const evidence = milestone.evidenceEventIds.map((id) => newMilestoneEvidence.get(id)).filter(Boolean) as WorldEvent[];
    const evidenceMonth = evidence.length ? Math.min(...evidence.map((event) => event.atMonth)) : undefined;
    const point: EvolutionTurningPoint = {
      id: `milestone:${milestone.id}`,
      month: milestone.observedAtMonth ?? evidenceMonth ?? state.clock.elapsedMonths,
      kind: 'milestone',
      title: milestone.label,
      summary: milestone.note,
      evidenceEventIds: milestone.evidenceEventIds,
      personIds: [...new Set([
        ...(milestone.participantIds ?? []),
        ...(milestone.affectedPersonIds ?? []),
        ...evidence.flatMap(personIdsFrom),
      ])],
    };
    points.push(point);
    existingIds.add(point.id);
  }
  return points.sort((a, b) => a.month - b.month || a.id.localeCompare(b.id));
}

export function checkpointFor(
  state: SimulationState,
  usage: { inputTokens: number; outputTokens: number },
  previous?: EvolutionCheckpointDecisionAccumulator,
): EvolutionCheckpoint {
  const through = state.clock.elapsedMonths;
  const history = committedHistoryView(state);
  const eventCount = history.eventCount;
  const canIncrement = previous !== undefined
    && Number.isInteger(previous.eventCount)
    && previous.eventCount >= 0
    && previous.eventCount <= eventCount
    && Number.isInteger(previous.ruleDecisions)
    && previous.ruleDecisions >= 0
    && Number.isInteger(previous.modelDecisions)
    && previous.modelDecisions >= 0;
  const fromAbsoluteIndex = canIncrement ? previous.eventCount : 0;
  if (fromAbsoluteIndex < history.hotStartIndex) {
    throw new Error(`演化检查点缺少绝对序号 ${fromAbsoluteIndex} 至 ${history.hotStartIndex - 1} 的连续决策历史`);
  }
  const fromEventIndex = fromAbsoluteIndex - history.hotStartIndex;
  let ruleDecisions = canIncrement ? previous.ruleDecisions : 0;
  let modelDecisions = canIncrement ? previous.modelDecisions : 0;
  for (let index = fromEventIndex; index < history.hotEventCount; index += 1) {
    const event = history.events[index];
    if (event.kind !== 'decision') continue;
    if (event.usedModel) modelDecisions += 1;
    else ruleDecisions += 1;
  }
  return {
    month: through,
    eventCount,
    livingPeople: state.people.filter((person) => person.bornAtMonth <= through && (person.diedAtMonth === undefined || person.diedAtMonth > through)).length,
    totalPeople: state.people.length,
    stage: state.civilization.stage,
    civilizationIndex: structuredClone(state.civilization.civilizationIndex),
    milestoneIds: state.derived.milestones.map((milestone) => milestone.id),
    ruleDecisions,
    modelDecisions,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

export function evolvePath(
  state: SimulationState,
  input: { runId: string; provider?: EvolutionPath['provider']; model: string; fromMonth: number; requestedEndMonth: number; previous?: EvolutionPath; checkpoint?: EvolutionCheckpoint; status: EvolutionPath['status']; failure?: string },
): EvolutionPath {
  const now = new Date().toISOString();
  const checkpoints = [...(input.previous?.checkpoints ?? [])];
  if (input.checkpoint) {
    const index = checkpoints.findIndex((item) => item.month === input.checkpoint?.month);
    if (index >= 0) checkpoints[index] = input.checkpoint;
    else checkpoints.push(input.checkpoint);
  }
  checkpoints.sort((a, b) => a.month - b.month);
  return {
    schemaVersion: 2,
    runId: input.runId,
    provider: input.provider ?? input.previous?.provider ?? 'local',
    model: input.model,
    status: input.status,
    startedAt: input.previous?.startedAt ?? now,
    updatedAt: now,
    fromMonth: input.previous?.fromMonth ?? input.fromMonth,
    requestedEndMonth: input.requestedEndMonth,
    reachedMonth: state.clock.elapsedMonths,
    checkpoints,
    turningPoints: turningPoints(state, input.previous),
    ...(input.failure ? { failure: input.failure } : {}),
  };
}

export function buildEvolutionFactsReport(state: SimulationState, path: EvolutionPath): EvolutionReport {
  const committedHistory = committedHistoryView(state);
  if (committedHistory.hotStartIndex > 0) {
    throw new Error(
      `演化事实报告缺少绝对序号 0 至 ${committedHistory.hotStartIndex - 1} 的累计报告投影`,
    );
  }
  const births = state.world.past.filter((event) => event.kind === 'environment' && typeof event.diff.bornPersonId === 'string').length;
  const deathEvents = state.world.past.filter((event): event is Extract<WorldEvent, { kind: 'environment' }> => (
    event.kind === 'environment' && event.change === 'death'
  ));
  const deaths = deathEvents.length;
  const events = eventById(state);
  const childDeathEvents = deathEvents.filter((event) => Number(event.diff.ageMonths) < 12 * 12);
  const lastCheckpoint = path.checkpoints.at(-1);
  const actionEvents = state.world.past.filter((event) => event.kind === 'action');
  const completedActionEvents = actionEvents.filter((event) => event.status === 'completed');
  const outputCount = (materialId: number) => completedActionEvents.reduce((sum, event) => (
    Number(event.diff.outputMaterialId) === materialId ? sum + Number(event.diff.outputQuantity ?? 1) : sum
  ), 0);
  const constructionPlacements = completedActionEvents.filter((event) => {
    const materialId = Number(event.diff.outputMaterialId);
    return event.action.kind === 'act'
      && event.action.operation === 'combine'
      && event.diff.position !== undefined
      && materialHas(materialId, 'solid')
      && materialHas(materialId, 'building');
  }).length;
  const movementActions = actionEvents.filter((event) => event.action.kind === 'move' && event.pathSegment.length > 1).length;
  const completedProjects = state.projects.filter((project) => project.status === 'completed');
  const logisticsMetrics = projectLogisticsMetrics(state);
  const behaviorMetrics = observerBehaviorMetrics(state);
  const derivedRecordUseMetrics = recordUseMetrics(state);
  const derivedInquiryOpportunityMetrics = inquiryOpportunityMetrics(state);
  const derivedTechniqueLearningMetrics = techniqueLearningMetrics(state);
  const derivedGroundedConversationMetrics = groundedConversationMetrics(state);
  const derivedHypothesisMetrics = hypothesisMetrics(state);
  return {
    schemaVersion: 4,
    runId: path.runId,
    generatedAt: new Date().toISOString(),
    throughMonth: state.clock.elapsedMonths,
    status: state.civilization.status,
    outcome: state.civilization.outcome ?? null,
    initialPopulation: state.people.filter((person) => person.bornAtMonth <= path.fromMonth && (person.diedAtMonth === undefined || person.diedAtMonth > path.fromMonth)).length,
    finalPopulation: state.people.filter((person) => person.diedAtMonth === undefined && person.body.health > 0).length,
    births,
    reproductionOffers: behaviorMetrics.reproductionOffers,
    reproductionAcceptances: behaviorMetrics.reproductionAcceptances,
    reproductionAttempts: behaviorMetrics.reproductionAttempts,
    reproductionConceptions: behaviorMetrics.reproductionConceptions,
    deaths,
    childDeaths: childDeathEvents.length,
    childExposureDeaths: childDeathEvents.filter((event) => {
      const sourceEventIds: unknown[] = Array.isArray(event.diff.sourceEventIds) ? event.diff.sourceEventIds : [];
      return sourceEventIds.some((sourceId) => {
        const source = typeof sourceId === 'string' ? events.get(sourceId) : undefined;
        if (!source || source.kind !== 'environment') return false;
        return source.diff.condition === 'cold' || source.diff.condition === 'heat';
      });
    }).length,
    kinRelatedBirths: state.world.past.filter((event) => event.kind === 'environment'
      && typeof event.diff.bornPersonId === 'string'
      && Number(event.diff.parentalKinshipRisk) > 0).length,
    inheritedIllnesses: state.world.past.filter((event) => event.kind === 'environment' && event.diff.inheritedSusceptibility === true).length,
    kinshipRiskLearners: state.people.filter((person) => person.knowledge.some((fact) => fact.id === 'claim:close-kin-offspring-risk' && fact.confidence >= 55)).length,
    civilizationIndex: structuredClone(state.civilization.civilizationIndex),
    stableEras: 1 + state.world.past.filter((event) => event.kind === 'environment' && event.diff.eraTransition === true && event.diff.epoch === 'stable').length,
    chaoticEras: state.world.past.filter((event) => event.kind === 'environment' && event.diff.eraTransition === true && event.diff.epoch === 'chaotic').length,
    correctPredictions: state.eraPredictions.filter((prediction) => prediction.status === 'correct').length,
    incorrectPredictions: state.eraPredictions.filter((prediction) => prediction.status === 'incorrect').length,
    dehydrationHibernations: state.world.past.filter((event) => event.kind === 'action'
      && event.action.kind === 'act'
      && event.action.operation === 'dehydrate'
      && event.status === 'completed').length,
    assistedDependentHibernations: state.world.past.filter((event) => event.kind === 'action'
      && event.action.kind === 'act'
      && event.action.operation === 'dehydrate'
      && event.status === 'completed'
      && typeof event.diff.assistedDependentId === 'string').length,
    wildlifePopulation: state.world.animals.filter((animal) => animal.diedAtMonth === undefined && animal.health > 0).length,
    animalsHunted: state.world.past.filter((event) => event.kind === 'action' && event.action.kind === 'act' && event.action.operation === 'hunt' && event.diff.killed === true).length,
    animalAttacks: state.world.past.filter((event) => event.kind === 'environment' && event.change === 'animal' && event.diff.process === 'attack-human').length,
    completedActions: state.world.past.filter((event) => event.kind === 'action' && event.status === 'completed').length,
    actionPersonMonths: behaviorMetrics.actionPersonMonths,
    projectActionPersonMonths: behaviorMetrics.projectActionPersonMonths,
    projectActionMonthShare: behaviorMetrics.projectActionMonthShare,
    ruleDecisions: state.world.past.filter((event) => event.kind === 'decision' && !event.usedModel).length,
    kimiDecisions: state.world.past.filter((event) => event.kind === 'decision' && event.usedModel).length,
    strategicIntents: state.world.past.filter((event) => event.kind === 'decision' && event.domain === 'strategic').length,
    socialIntents: state.world.past.filter((event) => event.kind === 'decision' && event.domain === 'social').length,
    survivalReflexActions: state.world.past.filter((event) => event.kind === 'action' && event.cause === 'survival-reflex').length,
    communications: state.world.past.filter((event) => event.kind === 'action' && event.action.kind === 'communicate' && event.status === 'completed').length,
    containersBuilt: state.world.past.filter((event) => event.kind === 'action' && event.status === 'completed' && typeof event.diff.containerId === 'string').length,
    standingContainers: state.containers.length,
    containerTransfers: state.world.past.filter((event) => event.kind === 'action'
      && event.status === 'completed'
      && event.action.kind === 'transfer'
      && (event.action.from.kind === 'container' || event.action.to.kind === 'container')).length,
    storedUnits: state.containers.reduce((sum, container) => sum + container.inventory.reduce((containerSum, stack) => containerSum + stack.quantity, 0), 0),
    projectsStarted: state.projects.length,
    projectsCompleted: completedProjects.length,
    projectsBlocked: state.projects.filter((project) => project.status === 'blocked').length,
    ...derivedInquiryOpportunityMetrics,
    ...derivedTechniqueLearningMetrics,
    ...derivedGroundedConversationMetrics,
    ...derivedHypothesisMetrics,
    ...logisticsMetrics,
    jointProjectsCompleted: completedProjects.filter((project) => project.contributorIds.length >= 2).length,
    productionProjectsCompleted: completedProjects.filter((project) => project.kind === 'production' || project.kind === 'inquiry').length,
    constructionProjectsCompleted: completedProjects.filter((project) => project.kind === 'construction').length,
    totalStructures: state.derived.structures.length,
    completedStructures: state.derived.structures.filter((structure) => structure.complete).length,
    constructionPlacements,
    movementActions,
    movementActionShare: actionEvents.length ? Math.round(movementActions / actionEvents.length * 10_000) / 100 : 0,
    spearsCrafted: outputCount(Material.Spear),
    leatherClothingCrafted: outputCount(Material.LeatherClothing),
    herbalMedicineCrafted: outputCount(Material.HerbalMedicine),
    cookedFoodProduced: outputCount(Material.CookedFood),
    recordsCreated: state.records.length,
    ...derivedRecordUseMetrics,
    functionalInstitutions: state.derived.institutions.length,
    inputTokens: lastCheckpoint?.inputTokens ?? 0,
    outputTokens: lastCheckpoint?.outputTokens ?? 0,
    milestones: structuredClone(state.derived.milestones),
    turningPoints: path.turningPoints,
    checkpoints: path.checkpoints,
  };
}
