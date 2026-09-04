import type { SimulationState, WorldEvent } from '../src/game/eland/simulation';
import { committedHistoryView } from '../src/game/eland/domain/history';
import { Material, materialHas } from '../src/game/eland/domain/material';
import { languageInterpreterIds } from '../src/game/eland/domain/language-perception';
import { hypothesisMetrics } from './evolution-artifacts/hypothesis-metrics';
import { inquiryOpportunityMetrics } from './evolution-artifacts/inquiry-opportunity-metrics';
import { objectRecord } from './evolution-artifacts/object-record';
import { techniqueLearningMetrics } from './evolution-artifacts/technique-learning-metrics';

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
 * shell plus the explicit token-usage input.
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
  personMaterialTransfers: number;
  personMaterialTransferReversals: number;
  personMaterialSameMonthReversals: number;
  permissionTransfers: number;
  permissionTransferReversals: number;
  permissionTransfersMissingUseBasis: number;
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
  groundedConversationSubstantiveResponses: number;
  groundedConversationAcknowledgements: number;
  groundedConversationGenericResponses: number;
  groundedConversationClosedEpisodes: number;
  groundedConversationMaxTurns: number;
  groundedConversationMaxDurationMonths: number;
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
    if (event.status !== 'completed' || action.kind !== 'talk') continue;
    const content = objectRecord(action.speakerMeaning);
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

function groundedConversationMetrics(state: SimulationState) {
  const allActionEvents = state.world.past.filter((event) => event.kind === 'action');
  const eventIds = new Set(state.world.past.map((event) => event.id));
  const grounded = allActionEvents.flatMap((event) => {
    if (event.status !== 'completed'
      || event.action.kind !== 'talk'
      || event.action.speakerMeaning.kind !== 'claim'
      || !event.action.speakerMeaning.conversation) return [];
    return [{ event, conversation: event.action.speakerMeaning.conversation }];
  });
  const openings = grounded.filter((entry) => entry.conversation.turn === 'opening');
  const responses = grounded.filter((entry) => entry.conversation.turn === 'response');
  const groundedById = new Map(grounded.map((entry) => [entry.event.id, entry]));
  const topicIds = new Set(grounded.map((entry) => entry.conversation.topic));
  const participantIds = new Set(grounded.flatMap((entry) => [
    entry.event.who,
    ...languageInterpreterIds(entry.event.diff, entry.event.action.kind === 'talk'
      ? entry.event.action.speakerMeaning.id
      : undefined),
  ]));
  const generationGtZeroParticipants = state.people.filter((person) => participantIds.has(person.id) && person.generation > 0).length;
  const sourcedOpenings = openings.filter((entry) => entry.conversation.sourceFactIds.length > 0
    && entry.conversation.sourceFactIds.every((sourceId) => eventIds.has(sourceId))).length;
  const unresolvedSources = grounded.filter((entry) => entry.conversation.sourceFactIds.length === 0
    || entry.conversation.sourceFactIds.some((sourceId) => !eventIds.has(sourceId))).length;
  const basisCounts = new Map<string, number>();
  for (const entry of openings) basisCounts.set(entry.conversation.basisKey, (basisCounts.get(entry.conversation.basisKey) ?? 0) + 1);
  const duplicateBases = [...basisCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const participantMismatches = grounded.filter((entry) => entry.event.action.kind !== 'talk'
    || languageInterpreterIds(entry.event.diff, entry.event.action.speakerMeaning.id).length === 0).length;
  const responseMatchesOpening = (entry: typeof responses[number]) => {
    const referenceId = entry.conversation.referenceEventId;
    const previous = referenceId ? groundedById.get(referenceId) : undefined;
    const previousPrecedesResponse = Boolean(previous && (
      previous.event.atMonth < entry.event.atMonth
      || (previous.event.atMonth === entry.event.atMonth
        && previous.event.orderInMonth < entry.event.orderInMonth)
    ));
    return Boolean(previous
      && previousPrecedesResponse
      && languageInterpreterIds(previous.event.diff, previous.event.action.kind === 'talk'
        ? previous.event.action.speakerMeaning.id
        : undefined).includes(entry.event.who)
      && languageInterpreterIds(entry.event.diff, entry.event.action.kind === 'talk'
        ? entry.event.action.speakerMeaning.id
        : undefined).includes(previous.event.who)
      && previous.conversation.topic === entry.conversation.topic
      && previous.conversation.basisKey === entry.conversation.basisKey
      && [...new Set(previous.conversation.sourceFactIds)].sort().join(',')
        === [...new Set(entry.conversation.sourceFactIds)].sort().join(','));
  };
  const validResponses = responses.filter(responseMatchesOpening);
  const responseReferenceCounts = new Map<string, number>();
  for (const entry of validResponses) {
    const referenceId = entry.conversation.referenceEventId;
    if (referenceId) responseReferenceCounts.set(referenceId, (responseReferenceCounts.get(referenceId) ?? 0) + 1);
  }
  const responseReferences = new Set(validResponses.flatMap((entry) => {
    let current = entry;
    const visited = new Set<string>();
    while (current.conversation.referenceEventId && !visited.has(current.conversation.referenceEventId)) {
      visited.add(current.conversation.referenceEventId);
      const previous = groundedById.get(current.conversation.referenceEventId);
      if (!previous) break;
      if (previous.conversation.turn === 'opening') return [previous.event.id];
      current = previous;
    }
    return [];
  }));
  const duplicateResponses = [...responseReferenceCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const responseMismatches = responses.length - validResponses.length + duplicateResponses;
  const relationshipEffectMismatches = grounded.filter((entry) => {
    const lowStakes = ['open', 'everyday', 'reminiscence', 'playful'].includes(entry.conversation.topic);
    const warm = ['care', 'gratitude', 'shared-work', 'family', 'loss'].includes(entry.conversation.topic);
    const supportive = entry.conversation.stance === 'supportive'
      && (entry.conversation.move === undefined || entry.conversation.move === 'support');
    const expected = entry.conversation.turn === 'opening'
      ? { trust: warm ? 1 : 0, bond: lowStakes ? 0 : entry.conversation.topic === 'discovery' ? 1 : 2 }
      : { trust: supportive && !lowStakes ? 1 : 0, bond: supportive && !lowStakes ? 2 : 0 };
    return Number(entry.event.diff.relationTrustDelta) !== expected.trust
      || Number(entry.event.diff.relationBondDelta) !== expected.bond
      || entry.event.diff.groundedConversationBasisKey !== entry.conversation.basisKey;
  }).length;
  const blockedAttempts = allActionEvents.filter((event) => event.diff.groundedConversationBlocked === true).length;
  const substantiveMoves = new Set(['support', 'question', 'challenge', 'share-fact', 'commit']);
  const substantiveResponses = responses.filter((entry) => substantiveMoves.has(
    entry.conversation.move ?? (entry.conversation.stance === 'supportive' ? 'support' : 'acknowledge'),
  )).length;
  const acknowledgements = responses.filter((entry) => (
    entry.conversation.move ?? (entry.conversation.stance === 'supportive' ? 'support' : 'acknowledge')
  ) === 'acknowledge').length;
  const genericResponses = responses.filter((entry) => /^(?:回应.+刚才|接着回应)/u.test(entry.event.action.kind === 'talk'
    && entry.event.action.speakerMeaning.kind === 'claim'
    ? entry.event.action.speakerMeaning.summary
    : '')).length;
  const episodes = new Map<string, typeof grounded>();
  for (const entry of grounded) {
    let episodeId = entry.event.id;
    let cursor = entry;
    const visited = new Set<string>();
    while (cursor.conversation.referenceEventId && !visited.has(cursor.conversation.referenceEventId)) {
      visited.add(cursor.conversation.referenceEventId);
      const previous = groundedById.get(cursor.conversation.referenceEventId);
      if (!previous) break;
      episodeId = previous.event.id;
      cursor = previous;
    }
    const turns = episodes.get(episodeId) ?? [];
    turns.push(entry);
    episodes.set(episodeId, turns);
  }
  const episodeTurns = [...episodes.values()].map((entries) => entries.length);
  const episodeDurations = [...episodes.values()].map((entries) => {
    const months = entries.map((entry) => entry.event.atMonth);
    return Math.max(...months) - Math.min(...months);
  });
  const closedEpisodes = [...episodes.values()].filter((entries) => {
    const last = entries.at(-1)?.conversation;
    return last?.turn === 'response'
      && !['question', 'challenge', 'share-fact', 'commit'].includes(last.move ?? 'acknowledge');
  }).length;
  return {
    groundedConversationOpenings: openings.length,
    groundedConversationResponses: responses.length,
    groundedConversationResponseCoverage: openings.length
      ? Math.round(responseReferences.size / openings.length * 10_000) / 100
      : 100,
    groundedConversationSubstantiveResponses: substantiveResponses,
    groundedConversationAcknowledgements: acknowledgements,
    groundedConversationGenericResponses: genericResponses,
    groundedConversationClosedEpisodes: closedEpisodes,
    groundedConversationMaxTurns: Math.max(0, ...episodeTurns),
    groundedConversationMaxDurationMonths: Math.max(0, ...episodeDurations),
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

function materialTransferMetrics(state: SimulationState) {
  const transfers = state.world.past.filter((event): event is Extract<WorldEvent, { kind: 'action' }> => (
    event.kind === 'action'
      && event.status === 'completed'
      && event.action.kind === 'transfer'
      && event.action.from.kind === 'person'
      && event.action.to.kind === 'person'
  ));
  const lastByPairAndMaterial = new Map<string, (typeof transfers)[number]>();
  let reversals = 0;
  let sameMonthReversals = 0;
  let permissionReversals = 0;
  for (const event of transfers) {
    if (event.action.kind !== 'transfer'
      || event.action.from.kind !== 'person'
      || event.action.to.kind !== 'person') continue;
    const pair = [event.action.from.personId, event.action.to.personId].sort().join('|');
    const key = `${event.action.materialId}|${pair}`;
    const previous = lastByPairAndMaterial.get(key);
    if (previous?.action.kind === 'transfer'
      && previous.action.from.kind === 'person'
      && previous.action.to.kind === 'person'
      && previous.action.from.personId === event.action.to.personId
      && previous.action.to.personId === event.action.from.personId) {
      reversals += 1;
      if (previous.atMonth === event.atMonth) sameMonthReversals += 1;
      if (previous.diff.permissionAuthorized === true || event.diff.permissionAuthorized === true) {
        permissionReversals += 1;
      }
    }
    lastByPairAndMaterial.set(key, event);
  }
  const permissionTransfers = transfers.filter((event) => event.diff.permissionAuthorized === true);
  return {
    personMaterialTransfers: transfers.length,
    personMaterialTransferReversals: reversals,
    personMaterialSameMonthReversals: sameMonthReversals,
    permissionTransfers: permissionTransfers.length,
    permissionTransferReversals: permissionReversals,
    permissionTransfersMissingUseBasis: permissionTransfers.filter((event) => (
      event.action.kind !== 'transfer' || !event.action.permissionUseBasis
    )).length,
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
  const derivedMaterialTransferMetrics = materialTransferMetrics(state);
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
    communications: state.world.past.filter((event) => event.kind === 'action' && event.action.kind === 'talk' && event.status === 'completed').length,
    ...derivedMaterialTransferMetrics,
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
