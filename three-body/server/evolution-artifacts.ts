import type { SimulationState, WorldEvent } from '../src/game/eland/simulation';
import { Material, materialDefinition, materialHas } from '../src/game/eland/domain/material';

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

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
      if (basisVersion !== 'record-use-basis-v2'
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
}

function inquiryOpportunityMetrics(state: SimulationState): InquiryOpportunityMetrics {
  type HypothesisOperation = 'combine-inventory' | 'exert-air' | 'expose-local';
  type OpportunityKind = 'material' | 'knowledge' | 'target' | 'verified-response' | 'ready-record-carrier';
  type OpportunitySource = {
    opportunityKey: string;
    kind: OpportunityKind;
    materialId: number | null;
    sourceKeys: string[];
    sourceFactIds: string[];
  };
  const rawState = state as unknown as {
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
  const failedProjects = inquiryProjects.filter(({ project }) => (
    project.status === 'blocked'
      && records(objectRecord(project.hypothesisCampaign)?.attempts).length > 0
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
    const valid = kind === 'material'
      ? materialId !== null && opportunityKey === `material:${materialId}`
        && sourceKeys.every((key) => key.startsWith('inventory:') || key.startsWith('drop:'))
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
    return valid ? { opportunityKey, kind, materialId, sourceKeys, sourceFactIds } : null;
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
    if (source.kind === 'material') return sourceLineageMatches(source, evidence);
    if (source.kind === 'target') return exactSource;
    return exactSource
      && source.sourceFactIds.some((eventId) => stringKeys(evidence.sourceFactIds).includes(eventId));
  };
  const hasCommitmentReason = (value: unknown): boolean => (
    stringKeys(value).includes('cross-project-renewal-opportunity')
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
  }>();

  for (const { project, projectIndex } of inquiryProjects) {
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
    sourceAuditByProjectIndex.set(projectIndex, { renewalKeys: projectRenewalKeys, renewalSources });
    if (projectRenewalKeys.length > 0) {
      renewalProjects += 1;
      renewalKeys += projectRenewalKeys.length;
      const coveredKeys = projectRenewalKeys.filter((renewalKey) => (
        renewalSources.some((source) => source.opportunityKey === renewalKey)
      ));
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
        for (const sourceKey of source.sourceKeys) {
          const sourceActor = inventorySourceActor(sourceKey);
          if (sourceActor && sourceActor !== project.ownerId) {
            renewalCommitmentActorMismatches.add(`${projectId}\u0000${sourceKey}`);
          }
        }
      }
    }
    for (const renewalKey of projectRenewalKeys) {
      if (!opportunityKeys.has(renewalKey)) renewalKeyMismatches.add(`${projectId}\u0000${renewalKey}`);
    }

    const createdAtMonth = integerValue(project.createdAtMonth);
    const hasPriorFailure = createdAtMonth !== null && failedProjects.some((prior) => (
      prior.projectIndex < projectIndex
        && prior.project.ownerId === project.ownerId
        && prior.project.desiredFunction === project.desiredFunction
        && integerValue(prior.project.blockedAtMonth) !== null
        && integerValue(prior.project.blockedAtMonth)! <= createdAtMonth
    ));
    if ((hasPriorFailure || inheritedProjectIds.length > 0) && projectRenewalKeys.length === 0) {
      reopenWithoutRenewal.add(projectId);
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

  for (const { project } of failedProjects) {
    if (objectRecord(project.terminalInquiryOpportunityBasis)) terminalBasisProjects += 1;
  }

  const renewalHypothesisProjects = inquiryProjects.flatMap((entry) => {
    const basis = objectRecord(entry.project.inquiryOpportunityBasis);
    const campaign = objectRecord(entry.project.hypothesisCampaign);
    return campaign && stringKeys(basis?.renewalKeys).length > 0 ? [{ ...entry, campaign }] : [];
  });
  const renewalHypothesisCandidateProjects = renewalHypothesisProjects.filter(({ campaign }) => (
    records(campaign.candidates).some((candidate) => (
      stringKeys(candidate.reasonKeys).includes('cross-project-renewal-opportunity')
    ))
  )).length;
  const renewalHypothesisAttemptProjects = renewalHypothesisProjects.filter(({ campaign }) => (
    records(campaign.attempts).length > 0
  ));
  const renewalHypothesisFirstAttempts = renewalHypothesisAttemptProjects.filter(({ campaign }) => {
    const firstAttempt = records(campaign.attempts)[0];
    const eventId = stringValue(firstAttempt?.eventId);
    const diff = eventId ? objectRecord(actionById.get(eventId)?.diff) : null;
    return stringKeys(diff?.projectHypothesisReasonKeys)
      .includes('cross-project-renewal-opportunity');
  }).length;

  const exactSourceHypothesisProjects = renewalHypothesisProjects.filter(({ projectIndex }) => (
    sourceAuditByProjectIndex.get(projectIndex)?.renewalKeys.some((renewalKey) => (
      renewalKey.startsWith('material:')
        || renewalKey.startsWith('target:')
        || renewalKey.startsWith('response:')
    ))
  ));
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

  let renewalFirstCandidateExactSourceProjects = 0;
  let renewalFirstAttemptExactSourceProjects = 0;
  let renewalFirstAttemptProjects = 0;
  const fallbackBeforeCommitmentViolations = new Set<string>();
  const materialOnlyCommitmentAttributionViolations = new Set<string>();
  for (const { project, projectIndex, campaign } of exactSourceHypothesisProjects) {
    const projectId = stringValue(project.id) ?? `#${projectIndex}`;
    const sources = sourceAuditByProjectIndex.get(projectIndex)?.renewalSources
      .filter((source) => source.kind === 'material'
        || source.kind === 'target'
        || source.kind === 'verified-response') ?? [];
    const candidates = records(campaign.candidates);
    const firstCommitmentCandidate = candidates.find((candidate) => hasCommitmentReason(candidate.reasonKeys));
    if (firstCommitmentCandidate && exactCommitmentCandidate(firstCommitmentCandidate, sources)) {
      renewalFirstCandidateExactSourceProjects += 1;
    }
    for (const [candidateIndex, candidate] of candidates.entries()) {
      if (materialOnlyAttribution(candidate, candidate.reasonKeys, sources)) {
        materialOnlyCommitmentAttributionViolations.add(`${projectId}\u0000candidate:${candidateIndex}`);
      }
    }

    const attempts = records(campaign.attempts);
    if (attempts.length > 0) {
      renewalFirstAttemptProjects += 1;
      if (exactCommitmentAttempt(campaign, attempts[0], sources)) {
        renewalFirstAttemptExactSourceProjects += 1;
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
    inquiryOpportunityBasisCoverage: coverage(basisProjects, inquiryProjects.length),
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
      renewalHypothesisCandidateProjects,
      renewalHypothesisProjects.length,
    ),
    inquiryOpportunityRenewalHypothesisAttemptProjects: renewalHypothesisAttemptProjects.length,
    inquiryOpportunityRenewalHypothesisFirstAttemptCoverage: coverage(
      renewalHypothesisFirstAttempts,
      renewalHypothesisAttemptProjects.length,
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
      renewalFirstCandidateExactSourceProjects,
      exactSourceHypothesisProjects.length,
    ),
    inquiryOpportunityRenewalFirstAttemptExactSourceCoverage: coverage(
      renewalFirstAttemptExactSourceProjects,
      renewalFirstAttemptProjects,
    ),
    inquiryOpportunityRenewalFallbackBeforeCommitmentViolations:
      fallbackBeforeCommitmentViolations.size,
    inquiryOpportunityMaterialOnlyCommitmentAttributionViolations:
      materialOnlyCommitmentAttributionViolations.size,
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

interface HypothesisMetrics {
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
}

function emptyHypothesisMetrics(): HypothesisMetrics {
  return {
    hypothesisCampaigns: 0,
    hypothesisCandidates: 0,
    hypothesisAttempts: 0,
    hypothesisResponses: 0,
    hypothesisNoResponses: 0,
    hypothesisExhaustedCampaigns: 0,
    hypothesisFirstAttemptResponses: 0,
    hypothesisFirstAttemptNoResponses: 0,
    hypothesisCombineAttempts: 0,
    hypothesisCombineResponses: 0,
    hypothesisCombineNoResponses: 0,
    hypothesisExertAttempts: 0,
    hypothesisExertResponses: 0,
    hypothesisExertNoResponses: 0,
    hypothesisExposeAttempts: 0,
    hypothesisExposeResponses: 0,
    hypothesisExposeNoResponses: 0,
    hypothesisConnectManipulatorShapesCandidates: 0,
    hypothesisConnectManipulatorShapesAttempts: 0,
    hypothesisConnectManipulatorShapesResponses: 0,
    hypothesisConnectManipulatorShapesNoResponses: 0,
    hypothesisConnectFlexibleLayersCandidates: 0,
    hypothesisConnectFlexibleLayersAttempts: 0,
    hypothesisConnectFlexibleLayersResponses: 0,
    hypothesisConnectFlexibleLayersNoResponses: 0,
    hypothesisSeekLocalHeatCandidates: 0,
    hypothesisSeekLocalHeatAttempts: 0,
    hypothesisSeekLocalHeatResponses: 0,
    hypothesisSeekLocalHeatNoResponses: 0,
    hypothesisShapePortableSurfaceCandidates: 0,
    hypothesisShapePortableSurfaceAttempts: 0,
    hypothesisShapePortableSurfaceResponses: 0,
    hypothesisShapePortableSurfaceNoResponses: 0,
    hypothesisTransformSubjectWithObservedHeatCandidates: 0,
    hypothesisTransformSubjectWithObservedHeatAttempts: 0,
    hypothesisTransformSubjectWithObservedHeatResponses: 0,
    hypothesisTransformSubjectWithObservedHeatNoResponses: 0,
    hypothesisCandidatesWithRoleBasis: 0,
    hypothesisAttemptsWithRoleBasis: 0,
    hypothesisCandidateRoleBasisCoverage: 100,
    hypothesisAttemptRoleBasisCoverage: 100,
    hypothesisCandidatesWithEntityRoleBasis: 0,
    hypothesisAttemptsWithEntityRoleBasis: 0,
    hypothesisActionDiffsWithEntityRoleBasis: 0,
    hypothesisCandidateEntityRoleBasisCoverage: 100,
    hypothesisAttemptEntityRoleBasisCoverage: 100,
    hypothesisActionDiffEntityRoleBasisCoverage: 100,
    hypothesisCandidatesMissingQuestionKind: 0,
    hypothesisCandidatesMissingRoleBasis: 0,
    hypothesisAttemptsMissingQuestionKind: 0,
    hypothesisAttemptsMissingRoleBasis: 0,
    hypothesisCandidateAttemptRoleBasisMismatches: 0,
    hypothesisActionDiffRoleBasisMismatches: 0,
    hypothesisNonFiniteRoleScores: 0,
    hypothesisQuestionOperationMismatches: 0,
    hypothesisExertVerifiedResponseToolAttempts: 0,
    hypothesisExertVerifiedResponseInputAttempts: 0,
    hypothesisExactEntityVerifiedResponseToolAttempts: 0,
    hypothesisExactEntityVerifiedResponseInputAttempts: 0,
    hypothesisMaterialOnlyVerifiedResponseAttributionViolations: 0,
    hypothesisVerifiedResponses: 0,
    hypothesisResponseDrivenTransitions: 0,
    hypothesisUniquePairs: 0,
    hypothesisUniqueSignatures: 0,
    hypothesisUnresolvedProjects: 0,
    hypothesisProjectMismatches: 0,
    hypothesisUnresolvedActors: 0,
    hypothesisActorMismatches: 0,
    hypothesisUnresolvedCampaigns: 0,
    hypothesisCampaignMismatches: 0,
    hypothesisUnresolvedActionEvents: 0,
    hypothesisActionMismatches: 0,
    hypothesisOperationMismatches: 0,
    hypothesisDuplicateProjectPairs: 0,
    hypothesisDuplicateProjectSignatures: 0,
    hypothesisBudgetExceeds: 0,
    hypothesisTotalBudgetExceeds: 0,
    hypothesisNoResponseBudgetExceeds: 0,
    hypothesisResponseBudgetExceeds: 0,
    hypothesisAttemptOrdinalMismatches: 0,
    hypothesisActionDiffPairMismatches: 0,
    hypothesisActionDiffSignatureMismatches: 0,
    hypothesisActionDiffOutcomeMismatches: 0,
    hypothesisMissingSourceKeys: 0,
    hypothesisReliableKnowledgeViolations: 0,
  };
}

function hypothesisMetrics(state: SimulationState): HypothesisMetrics {
  type HypothesisOutcome = 'response' | 'no-response';
  type HypothesisOperation = 'combine-inventory' | 'exert-air' | 'expose-local';
  type HypothesisQuestionKind =
    | 'connect-manipulator-shapes'
    | 'connect-flexible-layers'
    | 'seek-local-heat'
    | 'shape-portable-surface'
    | 'transform-subject-with-observed-heat';
  type MaterialPair = [number, number];
  type QuestionCounts = { candidates: number; attempts: number; responses: number; noResponses: number };
  type RoleBasis = {
    questionKind: unknown;
    roleScore: unknown;
    toolRoleScore: unknown;
    inputRoleScore: unknown;
    surfaceRoleScore: unknown;
    toolSourceKey: unknown;
    inputSourceKey: unknown;
    toolRoleMaterialId: unknown;
    inputRoleMaterialId: unknown;
    surfaceRoleMaterialId: unknown;
    roleReasonKeys: unknown;
    sourceKeys: unknown;
  };
  const rawState = state as unknown as {
    projects?: unknown;
    people?: unknown;
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
  const integerValue = (value: unknown): number | null => (
    typeof value === 'number' && Number.isInteger(value) ? value : null
  );
  const outcomeValue = (value: unknown): HypothesisOutcome | null => (
    value === 'response' || value === 'no-response' ? value : null
  );
  const operationValue = (value: unknown, legacyCombine = false): HypothesisOperation | null => {
    if (value === 'combine-inventory' || value === 'exert-air' || value === 'expose-local') return value;
    return value === undefined && legacyCombine ? 'combine-inventory' : null;
  };
  const questionValue = (value: unknown): HypothesisQuestionKind | null => {
    if (value === 'connect-manipulator-shapes'
      || value === 'connect-flexible-layers'
      || value === 'seek-local-heat'
      || value === 'shape-portable-surface'
      || value === 'transform-subject-with-observed-heat') return value;
    return null;
  };
  const expectedQuestionOperation = (question: HypothesisQuestionKind): HypothesisOperation => (
    question === 'connect-manipulator-shapes' || question === 'connect-flexible-layers'
      ? 'combine-inventory'
      : question === 'transform-subject-with-observed-heat'
        ? 'expose-local'
        : 'exert-air'
  );
  const stringKeys = (value: unknown): string[] => (
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : []
  );
  const materialPair = (value: unknown): MaterialPair | null => {
    if (!Array.isArray(value) || value.length !== 2) return null;
    const left = integerValue(value[0]);
    const right = integerValue(value[1]);
    return left === null || right === null ? null : [left, right];
  };
  const normalizedPair = (operation: HypothesisOperation, pair: MaterialPair): MaterialPair => (
    operation === 'combine-inventory' && pair[0] > pair[1] ? [pair[1], pair[0]] : pair
  );
  const candidateKeyFor = (
    operation: HypothesisOperation,
    pair: MaterialPair,
    targetMaterialId?: number | null,
  ): string => {
    const [left, right] = normalizedPair(operation, pair);
    if (operation === 'combine-inventory') return String(left) + '+' + String(right);
    if (operation === 'exert-air') {
      return 'exert-air:' + String(left) + '>' + String(right) + '@' + String(targetMaterialId ?? Material.Air);
    }
    return 'expose-local:' + String(left) + '@' + String(targetMaterialId ?? right);
  };
  const signatureFor = (
    operation: HypothesisOperation | null,
    pair: MaterialPair | null,
    targetMaterialId?: number | null,
  ): string | null => (
    operation && pair ? operation + '\u0000' + candidateKeyFor(operation, pair, targetMaterialId) : null
  );
  const optionalIntegerMatches = (
    record: Record<string, unknown>,
    field: string,
    expected: number,
  ): boolean => record[field] === undefined || integerValue(record[field]) === expected;
  const roleMaterialIdsMatch = (
    record: Record<string, unknown>,
    operation: HypothesisOperation,
    pair: MaterialPair,
    prefix = '',
  ): boolean => {
    const toolField = prefix + 'ToolMaterialId';
    const inputField = prefix + 'InputMaterialId';
    const targetField = prefix + 'TargetMaterialId';
    if (operation === 'exert-air') return optionalIntegerMatches(record, toolField, pair[0])
      && optionalIntegerMatches(record, inputField, pair[1])
      && optionalIntegerMatches(record, targetField, Material.Air);
    if (operation === 'expose-local') return optionalIntegerMatches(record, inputField, pair[0])
      && optionalIntegerMatches(record, targetField, pair[1]);
    return true;
  };
  const actualSignature = (
    diff: Record<string, unknown>,
    operation: HypothesisOperation,
  ): string | null => {
    if (operation === 'combine-inventory') {
      return signatureFor(operation, materialPair(diff.inputMaterialIds));
    }
    const inputMaterialId = integerValue(diff.inputMaterialId);
    const targetMaterialId = integerValue(diff.targetMaterialId);
    if (inputMaterialId === null || targetMaterialId === null) return null;
    if (operation === 'exert-air') {
      const toolMaterialId = integerValue(diff.toolMaterialId);
      if (toolMaterialId === null || targetMaterialId !== Material.Air) return null;
      return signatureFor(operation, [toolMaterialId, inputMaterialId], targetMaterialId);
    }
    return signatureFor(operation, [inputMaterialId, targetMaterialId], targetMaterialId);
  };
  const legacyPairShape = (
    record: Record<string, unknown> | undefined,
    keyField: 'key' | 'candidateKey',
  ): boolean => {
    if (!record || record.operation !== undefined) return false;
    const pair = materialPair(record.materialIds);
    const key = stringValue(record[keyField]);
    return pair !== null && key === candidateKeyFor('combine-inventory', pair);
  };
  const expectedActionOperation = (operation: HypothesisOperation): 'combine' | 'exert' | 'expose' => (
    operation === 'combine-inventory' ? 'combine' : operation === 'exert-air' ? 'exert' : 'expose'
  );
  const storedRoleBasis = (record: Record<string, unknown>): RoleBasis => ({
    questionKind: record.questionKind,
    roleScore: record.roleScore,
    toolRoleScore: record.toolRoleScore,
    inputRoleScore: record.inputRoleScore,
    surfaceRoleScore: record.surfaceRoleScore,
    toolSourceKey: record.toolSourceKey,
    inputSourceKey: record.inputSourceKey,
    toolRoleMaterialId: record.toolRoleMaterialId,
    inputRoleMaterialId: record.inputRoleMaterialId,
    surfaceRoleMaterialId: record.surfaceRoleMaterialId,
    roleReasonKeys: record.roleReasonKeys,
    sourceKeys: record.sourceKeys,
  });
  const diffRoleBasis = (record: Record<string, unknown>): RoleBasis => ({
    questionKind: record.projectHypothesisQuestionKind,
    roleScore: record.projectHypothesisRoleScore,
    toolRoleScore: record.projectHypothesisToolRoleScore,
    inputRoleScore: record.projectHypothesisInputRoleScore,
    surfaceRoleScore: record.projectHypothesisSurfaceRoleScore,
    toolSourceKey: record.projectHypothesisToolSourceKey,
    inputSourceKey: record.projectHypothesisInputSourceKey,
    toolRoleMaterialId: record.projectHypothesisToolRoleMaterialId,
    inputRoleMaterialId: record.projectHypothesisInputRoleMaterialId,
    surfaceRoleMaterialId: record.projectHypothesisSurfaceRoleMaterialId,
    roleReasonKeys: record.projectHypothesisRoleReasonKeys,
    sourceKeys: record.projectHypothesisSourceKeys,
  });
  const exactReasonKeys = (value: unknown): string[] | null => (
    Array.isArray(value)
      && value.every((item) => typeof item === 'string' && item.length > 0)
      ? value as string[]
      : null
  );
  const requiredRoleScores = (
    basis: RoleBasis,
    operation: HypothesisOperation | null,
  ): Array<keyof RoleBasis> => (
    questionValue(basis.questionKind) === 'connect-flexible-layers'
      || questionValue(basis.questionKind) === 'transform-subject-with-observed-heat'
      || operation === 'expose-local'
      ? ['roleScore', 'inputRoleScore']
      : operation === 'combine-inventory' || operation === 'exert-air'
        ? ['roleScore', 'toolRoleScore', 'inputRoleScore']
        : ['roleScore']
  );
  const isExplicitNoFitReason = (reason: string): boolean => (
    reason.startsWith('role-') && reason.endsWith('-no-observed-fit')
  );
  const roleBasisPresent = (basis: RoleBasis, operation: HypothesisOperation | null): boolean => {
    const reasons = exactReasonKeys(basis.roleReasonKeys);
    if (!requiredRoleScores(basis, operation).every((field) => basis[field] !== undefined)
      || !reasons || reasons.length === 0) return false;
    return basis.roleScore !== 0 || reasons.some(isExplicitNoFitReason);
  };
  const roleBasisFinite = (basis: RoleBasis, operation: HypothesisOperation | null): boolean => (
    requiredRoleScores(basis, operation).every((field) => Number.isFinite(basis[field]))
  );
  const entityRoleBasisPresent = (
    basis: RoleBasis,
    operation: HypothesisOperation | null,
  ): boolean => {
    if (!roleBasisPresent(basis, operation) || !roleBasisFinite(basis, operation)) return false;
    const sourceKeys = exactReasonKeys(basis.sourceKeys);
    if (!sourceKeys) return false;
    const reasons = exactReasonKeys(basis.roleReasonKeys) ?? [];
    const roleEntityPresent = (
      scoreField: 'toolRoleScore' | 'inputRoleScore',
      sourceField: 'toolSourceKey' | 'inputSourceKey',
      materialField: 'toolRoleMaterialId' | 'inputRoleMaterialId',
      role: 'tool' | 'input',
    ): boolean => {
      if (!requiredRoleScores(basis, operation).includes(scoreField)) return true;
      const sourceKey = stringValue(basis[sourceField]);
      if (sourceKey && integerValue(basis[materialField]) !== null && sourceKeys.includes(sourceKey)) return true;
      const noFitRoles = role === 'input' ? ['input', 'surface'] : ['tool'];
      return basis[scoreField] === 0 && reasons.some((reason) => (
        isExplicitNoFitReason(reason) && noFitRoles.some((name) => reason.startsWith(`role-${name}-`))
      ));
    };
    if (!roleEntityPresent('toolRoleScore', 'toolSourceKey', 'toolRoleMaterialId', 'tool')
      || !roleEntityPresent('inputRoleScore', 'inputSourceKey', 'inputRoleMaterialId', 'input')) return false;
    const hasSurfaceRole = basis.surfaceRoleScore !== undefined || basis.surfaceRoleMaterialId !== undefined;
    if (!hasSurfaceRole) return true;
    const inputSourceKey = stringValue(basis.inputSourceKey);
    return Number.isFinite(basis.surfaceRoleScore)
      && integerValue(basis.surfaceRoleMaterialId) !== null
      && ((inputSourceKey !== null && sourceKeys.includes(inputSourceKey))
        || (basis.surfaceRoleScore === 0
          && reasons.some((reason) => reason === 'role-surface-no-observed-fit')));
  };
  const hasNonFiniteRoleScore = (basis: RoleBasis): boolean => (
    (['roleScore', 'toolRoleScore', 'inputRoleScore', 'surfaceRoleScore'] as const)
      .some((field) => basis[field] !== undefined && !Number.isFinite(basis[field]))
  );
  const roleBasisMatches = (left: RoleBasis, right: RoleBasis, compareSourceKeys = false): boolean => {
    const leftReasons = exactReasonKeys(left.roleReasonKeys);
    const rightReasons = exactReasonKeys(right.roleReasonKeys);
    const bothReasonsAbsent = left.roleReasonKeys === undefined && right.roleReasonKeys === undefined;
    const reasonsMatch = bothReasonsAbsent || (leftReasons !== null
      && rightReasons !== null
      && leftReasons.length === rightReasons.length
      && leftReasons.every((key, index) => key === rightReasons[index]));
    return left.questionKind === right.questionKind
      && left.roleScore === right.roleScore
      && left.toolRoleScore === right.toolRoleScore
      && left.inputRoleScore === right.inputRoleScore
      && left.surfaceRoleScore === right.surfaceRoleScore
      && left.toolSourceKey === right.toolSourceKey
      && left.inputSourceKey === right.inputSourceKey
      && left.toolRoleMaterialId === right.toolRoleMaterialId
      && left.inputRoleMaterialId === right.inputRoleMaterialId
      && left.surfaceRoleMaterialId === right.surfaceRoleMaterialId
      && reasonsMatch
      && (!compareSourceKeys || (() => {
        const leftSourceKeys = exactReasonKeys(left.sourceKeys);
        const rightSourceKeys = exactReasonKeys(right.sourceKeys);
        return leftSourceKeys !== null && rightSourceKeys !== null
          && leftSourceKeys.length === rightSourceKeys.length
          && leftSourceKeys.every((key, index) => key === rightSourceKeys[index]);
      })());
  };
  const responseRefSourceKey = (
    responseRef: Record<string, unknown> | null,
    actorId: string | null,
  ): string | null => {
    const materialId = integerValue(responseRef?.materialId);
    if (materialId === null) return null;
    if (responseRef?.kind === 'inventory-stack') {
      const stackId = stringValue(responseRef.stackId);
      return actorId && stackId ? `inventory:${actorId}:${stackId}` : null;
    }
    if (responseRef?.kind !== 'voxel') return null;
    const position = objectRecord(responseRef.position);
    const x = integerValue(position?.x);
    const y = integerValue(position?.y);
    const z = integerValue(position?.z);
    return x === null || y === null || z === null
      ? null
      : `voxel:${x}:${y}:${z}:${materialId}`;
  };

  const projects = records(rawState.projects);
  const people = records(rawState.people);
  const events = records(rawState.world?.past);
  const campaignEntries = projects.flatMap((project, projectIndex) => {
    const campaign = objectRecord(project.hypothesisCampaign);
    if (!campaign) return [];
    const projectId = stringValue(project.id);
    const campaignId = stringValue(campaign.id);
    return [{
      project,
      projectIndex,
      projectId,
      campaign,
      campaignId,
      key: (projectId ?? '#' + String(projectIndex)) + '\u0000' + (campaignId ?? '#campaign'),
    }];
  });
  if (campaignEntries.length === 0) return emptyHypothesisMetrics();

  type CampaignEntry = (typeof campaignEntries)[number];
  const projectById = new Map(projects.flatMap((project) => {
    const id = stringValue(project.id);
    return id ? [[id, project] as const] : [];
  }));
  const personIds = new Set(people.flatMap((person) => {
    const id = stringValue(person.id);
    return id ? [id] : [];
  }));
  const campaignEntriesById = new Map<string, CampaignEntry[]>();
  for (const entry of campaignEntries) {
    if (!entry.campaignId) continue;
    const matches = campaignEntriesById.get(entry.campaignId) ?? [];
    matches.push(entry);
    campaignEntriesById.set(entry.campaignId, matches);
  }
  const actionEntries = events.flatMap((event, eventIndex) => {
    if (event.kind !== 'action') return [];
    const id = stringValue(event.id);
    return [{
      event,
      eventIndex,
      id,
      key: id ?? '#' + String(eventIndex),
      diff: objectRecord(event.diff) ?? {},
    }];
  });
  const actionById = new Map(actionEntries.flatMap((entry) => (
    entry.id ? [[entry.id, entry] as const] : []
  )));
  const candidateEntries = campaignEntries.flatMap((entry) => (
    records(entry.campaign.candidates).map((candidate, candidateIndex) => ({
      ...entry,
      candidate,
      candidateIndex,
      candidateEntryKey: entry.key + '\u0000candidate:' + String(candidateIndex),
    }))
  ));
  const attemptEntries = campaignEntries.flatMap((entry) => {
    const attempts = Array.isArray(entry.campaign.attempts) ? entry.campaign.attempts : [];
    return attempts.flatMap((value, attemptIndex) => {
      const attempt = objectRecord(value);
      return attempt ? [{
        ...entry,
        attempt,
        attemptIndex,
        attemptKey: entry.key + '\u0000#' + String(attemptIndex),
      }] : [];
    });
  });
  type AttemptEntry = (typeof attemptEntries)[number];
  const attemptsByEventId = new Map<string, AttemptEntry[]>();
  for (const entry of attemptEntries) {
    const eventId = stringValue(entry.attempt.eventId);
    if (!eventId) continue;
    const matches = attemptsByEventId.get(eventId) ?? [];
    matches.push(entry);
    attemptsByEventId.set(eventId, matches);
  }

  const unresolvedProjects = new Set<string>();
  const projectMismatches = new Set<string>();
  const unresolvedActors = new Set<string>();
  const actorMismatches = new Set<string>();
  const unresolvedCampaigns = new Set<string>();
  const campaignMismatches = new Set<string>();
  const unresolvedActionEvents = new Set<string>();
  const actionMismatches = new Set<string>();
  const operationMismatches = new Set<string>();
  const duplicateProjectSignatures = new Set<string>();
  const budgetExceeds = new Set<string>();
  const totalBudgetExceeds = new Set<string>();
  const noResponseBudgetExceeds = new Set<string>();
  const responseBudgetExceeds = new Set<string>();
  const attemptOrdinalMismatches = new Set<string>();
  const actionDiffSignatureMismatches = new Set<string>();
  const actionDiffOutcomeMismatches = new Set<string>();
  const missingSourceKeys = new Set<string>();
  const reliableKnowledgeViolations = new Set<string>();
  const candidatesMissingQuestionKind = new Set<string>();
  const candidatesMissingRoleBasis = new Set<string>();
  const attemptsMissingQuestionKind = new Set<string>();
  const attemptsMissingRoleBasis = new Set<string>();
  const candidateAttemptRoleBasisMismatches = new Set<string>();
  const actionDiffRoleBasisMismatches = new Set<string>();
  const nonFiniteRoleScores = new Set<string>();
  const questionOperationMismatches = new Set<string>();
  const uniqueSignatures = new Set<string>();
  const projectSignatures = new Map<string, Set<string>>();
  const verifiedResponses = new Set<string>();
  const responseDrivenTransitions = new Set<string>();
  const exertVerifiedResponseToolAttempts = new Set<string>();
  const exertVerifiedResponseInputAttempts = new Set<string>();
  const exactEntityVerifiedResponseToolAttempts = new Set<string>();
  const exactEntityVerifiedResponseInputAttempts = new Set<string>();
  const materialOnlyVerifiedResponseAttributionViolations = new Set<string>();
  const operationCounts: Record<HypothesisOperation, {
    attempts: number;
    responses: number;
    noResponses: number;
  }> = {
    'combine-inventory': { attempts: 0, responses: 0, noResponses: 0 },
    'exert-air': { attempts: 0, responses: 0, noResponses: 0 },
    'expose-local': { attempts: 0, responses: 0, noResponses: 0 },
  };
  const questionCounts: Record<HypothesisQuestionKind, QuestionCounts> = {
    'connect-manipulator-shapes': { candidates: 0, attempts: 0, responses: 0, noResponses: 0 },
    'connect-flexible-layers': { candidates: 0, attempts: 0, responses: 0, noResponses: 0 },
    'seek-local-heat': { candidates: 0, attempts: 0, responses: 0, noResponses: 0 },
    'shape-portable-surface': { candidates: 0, attempts: 0, responses: 0, noResponses: 0 },
    'transform-subject-with-observed-heat': { candidates: 0, attempts: 0, responses: 0, noResponses: 0 },
  };
  const attemptDetails = new Map<string, {
    operation: HypothesisOperation | null;
    materialIds: MaterialPair | null;
    candidate?: Record<string, unknown>;
  }>();
  let hypothesisResponses = 0;
  let hypothesisNoResponses = 0;
  let hypothesisFirstAttemptResponses = 0;
  let hypothesisFirstAttemptNoResponses = 0;
  let candidatesWithRoleBasis = 0;
  let attemptsWithRoleBasis = 0;
  let candidatesWithEntityRoleBasis = 0;
  let attemptsWithEntityRoleBasis = 0;
  let actionDiffsWithEntityRoleBasis = 0;

  for (const entry of candidateEntries) {
    const legacyCampaign = stringValue(entry.campaign.version) !== 'project-hypothesis-campaign-v2';
    const legacyCandidate = entry.candidate.operation === undefined
      && (legacyCampaign || legacyPairShape(entry.candidate, 'key'));
    const operation = operationValue(entry.candidate.operation, legacyCandidate);
    const question = questionValue(entry.candidate.questionKind);
    const basis = storedRoleBasis(entry.candidate);
    if (question) questionCounts[question].candidates += 1;
    else candidatesMissingQuestionKind.add(entry.candidateEntryKey);
    if (!roleBasisPresent(basis, operation)) candidatesMissingRoleBasis.add(entry.candidateEntryKey);
    if (question && roleBasisPresent(basis, operation) && roleBasisFinite(basis, operation)) {
      candidatesWithRoleBasis += 1;
    }
    if (question && entityRoleBasisPresent(basis, operation)) candidatesWithEntityRoleBasis += 1;
    if (hasNonFiniteRoleScore(basis)) nonFiniteRoleScores.add('candidate:' + entry.candidateEntryKey);
    if (question && operation !== expectedQuestionOperation(question)) {
      questionOperationMismatches.add('candidate:' + entry.candidateEntryKey);
    }
  }

  for (const entry of campaignEntries) {
    const campaignProjectId = stringValue(entry.campaign.projectId);
    const campaignActorId = stringValue(entry.campaign.actorId);
    const version = stringValue(entry.campaign.version);
    const totalBudget = integerValue(entry.campaign.budget);
    const noResponseBudget = integerValue(entry.campaign.noResponseBudget);
    const responseBudget = integerValue(entry.campaign.responseBudget);
    if (!campaignProjectId || !projectById.has(campaignProjectId)) unresolvedProjects.add('campaign:' + entry.key);
    if (!entry.projectId || campaignProjectId !== entry.projectId) projectMismatches.add('campaign:' + entry.key);
    if (!campaignActorId || !personIds.has(campaignActorId)) unresolvedActors.add('campaign:' + entry.key);
    if (!entry.campaignId) unresolvedCampaigns.add('campaign:' + entry.key);
    else if ((campaignEntriesById.get(entry.campaignId)?.length ?? 0) !== 1) campaignMismatches.add('campaign:' + entry.key);
    if (version !== null
      && version !== 'project-hypothesis-campaign-v1'
      && version !== 'project-hypothesis-campaign-v2') {
      campaignMismatches.add('version:' + entry.key);
    }
    if (totalBudget === null || totalBudget < 0) campaignMismatches.add('budget:' + entry.key);
    if (version === 'project-hypothesis-campaign-v2'
      && (noResponseBudget === null || noResponseBudget < 0
        || responseBudget === null || responseBudget < 0)) {
      campaignMismatches.add('stage-budgets:' + entry.key);
    }
  }

  for (const entry of attemptEntries) {
    const { campaign, attempt, attemptIndex, attemptKey } = entry;
    const attemptEventId = stringValue(attempt.eventId);
    const operationMismatchKey = attemptEventId ?? attemptKey;
    const candidateKey = stringValue(attempt.candidateKey);
    const attemptMaterialIds = materialPair(attempt.materialIds);
    const legacyCampaign = stringValue(campaign.version) !== 'project-hypothesis-campaign-v2';
    const legacyAttempt = attempt.operation === undefined
      && (legacyCampaign || legacyPairShape(attempt, 'candidateKey'));
    const operation = operationValue(attempt.operation, legacyAttempt);
    const outcome = outcomeValue(attempt.outcome);
    const question = questionValue(attempt.questionKind);
    const attemptRoleBasis = storedRoleBasis(attempt);
    if (question) {
      const counts = questionCounts[question];
      counts.attempts += 1;
      if (outcome === 'response') counts.responses += 1;
      else if (outcome === 'no-response') counts.noResponses += 1;
    } else {
      attemptsMissingQuestionKind.add(attemptKey);
    }
    if (!roleBasisPresent(attemptRoleBasis, operation)) attemptsMissingRoleBasis.add(attemptKey);
    if (question && roleBasisPresent(attemptRoleBasis, operation)
      && roleBasisFinite(attemptRoleBasis, operation)) {
      attemptsWithRoleBasis += 1;
    }
    if (question && entityRoleBasisPresent(attemptRoleBasis, operation)) attemptsWithEntityRoleBasis += 1;
    if (hasNonFiniteRoleScore(attemptRoleBasis)) nonFiniteRoleScores.add('attempt:' + attemptKey);
    if (question && operation !== expectedQuestionOperation(question)) {
      questionOperationMismatches.add('attempt:' + attemptKey);
    }
    if (outcome === 'response') {
      hypothesisResponses += 1;
      if (attemptIndex === 0) hypothesisFirstAttemptResponses += 1;
    } else if (outcome === 'no-response') {
      hypothesisNoResponses += 1;
      if (attemptIndex === 0) hypothesisFirstAttemptNoResponses += 1;
    }
    if (operation) {
      operationCounts[operation].attempts += 1;
      if (outcome === 'response') operationCounts[operation].responses += 1;
      else if (outcome === 'no-response') operationCounts[operation].noResponses += 1;
    } else {
      operationMismatches.add(operationMismatchKey);
    }

    const attemptTargetMaterialId = integerValue(attempt.targetMaterialId);
    const attemptSignature = signatureFor(operation, attemptMaterialIds, attemptTargetMaterialId);
    const expectedCandidateKey = operation && attemptMaterialIds
      ? candidateKeyFor(operation, attemptMaterialIds, attemptTargetMaterialId)
      : null;
    if (attemptSignature) uniqueSignatures.add(attemptSignature);
    if (attemptSignature) {
      const projectKey = entry.projectId ?? '#' + String(entry.projectIndex);
      const seenSignatures = projectSignatures.get(projectKey) ?? new Set<string>();
      if (seenSignatures.has(attemptSignature)) duplicateProjectSignatures.add(attemptKey);
      else seenSignatures.add(attemptSignature);
      projectSignatures.set(projectKey, seenSignatures);
    }
    if (!attemptSignature || !candidateKey || candidateKey !== expectedCandidateKey
      || (operation && attemptMaterialIds && !roleMaterialIdsMatch(attempt, operation, attemptMaterialIds))) {
      actionDiffSignatureMismatches.add(attemptKey);
    }

    const ordinal = integerValue(attempt.ordinal);
    if (ordinal !== attemptIndex + 1) attemptOrdinalMismatches.add(attemptKey);
    const totalBudget = integerValue(campaign.budget);
    const noResponseBudget = integerValue(campaign.noResponseBudget);
    const responseBudget = integerValue(campaign.responseBudget);
    const attemptsThroughCurrent = (Array.isArray(campaign.attempts)
      ? campaign.attempts.slice(0, attemptIndex + 1)
      : []).map(objectRecord).filter((item): item is Record<string, unknown> => item !== null);
    const noResponsesThroughCurrent = attemptsThroughCurrent
      .filter((item) => outcomeValue(item.outcome) === 'no-response').length;
    const responsesThroughCurrent = attemptsThroughCurrent
      .filter((item) => outcomeValue(item.outcome) === 'response').length;
    if (totalBudget !== null && (attemptIndex >= totalBudget || (ordinal !== null && ordinal > totalBudget))) {
      totalBudgetExceeds.add(attemptKey);
      budgetExceeds.add(attemptKey);
    }
    if (noResponseBudget !== null && noResponsesThroughCurrent > noResponseBudget) {
      noResponseBudgetExceeds.add(attemptKey);
      budgetExceeds.add(attemptKey);
    }
    if (responseBudget !== null && responsesThroughCurrent > responseBudget) {
      responseBudgetExceeds.add(attemptKey);
      budgetExceeds.add(attemptKey);
    }

    const candidates = records(campaign.candidates);
    const candidateMatches = candidateKey
      ? candidates.filter((item) => stringValue(item.key) === candidateKey)
      : [];
    const candidate = candidateMatches.length === 1 ? candidateMatches[0] : undefined;
    if (candidateMatches.length !== 1) campaignMismatches.add(attemptKey);
    const candidateMaterialIds = materialPair(candidate?.materialIds);
    const legacyCandidate = candidate?.operation === undefined
      && (legacyCampaign || legacyPairShape(candidate, 'key'));
    const candidateOperation = candidate
      ? operationValue(candidate.operation, legacyCandidate)
      : null;
    const candidateTargetMaterialId = integerValue(candidate?.targetMaterialId);
    const candidateSignature = signatureFor(candidateOperation, candidateMaterialIds, candidateTargetMaterialId);
    const candidateExpectedKey = candidateOperation && candidateMaterialIds
      ? candidateKeyFor(candidateOperation, candidateMaterialIds, candidateTargetMaterialId)
      : null;
    const candidateQuestion = questionValue(candidate?.questionKind);
    if (candidate && !roleBasisMatches(
      storedRoleBasis(candidate),
      attemptRoleBasis,
      Array.isArray(attempt.sourceKeys),
    )) {
      candidateAttemptRoleBasisMismatches.add(attemptKey);
    }
    if (question && candidateQuestion !== question) {
      candidateAttemptRoleBasisMismatches.add(attemptKey);
    }
    if (!operation || !candidateOperation || candidateOperation !== operation
      || (candidate?.operation === undefined && attempt.operation !== undefined)) {
      operationMismatches.add(operationMismatchKey);
    }
    if (!attemptSignature || !candidateSignature || candidateSignature !== attemptSignature
      || !candidateKey || stringValue(candidate?.key) !== candidateKey
      || candidateKey !== expectedCandidateKey || stringValue(candidate?.key) !== candidateExpectedKey
      || (candidateOperation && candidateMaterialIds
        && !roleMaterialIdsMatch(candidate!, candidateOperation, candidateMaterialIds))) {
      actionDiffSignatureMismatches.add(attemptKey);
    }
    if (stringKeys(campaign.sourceKeys).length === 0
      || stringKeys(candidate?.sourceKeys).length === 0) {
      missingSourceKeys.add(attemptKey);
    }
    attemptDetails.set(attemptKey, {
      operation,
      materialIds: attemptMaterialIds,
      candidate,
    });

    const eventId = attemptEventId;
    const actionEntry = eventId ? actionById.get(eventId) : undefined;
    if (!eventId || !actionEntry) {
      unresolvedActionEvents.add(eventId ?? attemptKey);
      continue;
    }
    const { event, diff } = actionEntry;
    const action = objectRecord(event.action);
    const eventWho = stringValue(event.who);
    const campaignActorId = stringValue(campaign.actorId);
    const diffActorId = stringValue(diff.projectHypothesisActorId);
    const campaignProjectId = stringValue(campaign.projectId);
    const diffProjectId = stringValue(diff.projectHypothesisProjectId);
    const diffCampaignId = stringValue(diff.projectHypothesisCampaignId);
    if (!eventWho || !personIds.has(eventWho) || !diffActorId || !personIds.has(diffActorId)) {
      unresolvedActors.add('action:' + actionEntry.key);
    }
    if (eventWho !== campaignActorId || diffActorId !== campaignActorId || diffActorId !== eventWho) {
      actorMismatches.add(actionEntry.key);
    }
    if (!diffProjectId || !projectById.has(diffProjectId)) unresolvedProjects.add('action:' + actionEntry.key);
    if (diffProjectId !== entry.projectId || diffProjectId !== campaignProjectId) {
      projectMismatches.add(actionEntry.key);
    }
    if (!diffCampaignId || !campaignEntriesById.has(diffCampaignId)) {
      unresolvedCampaigns.add('action:' + actionEntry.key);
    }
    if (diffCampaignId !== entry.campaignId
      || (diffCampaignId && (campaignEntriesById.get(diffCampaignId)?.length ?? 0) !== 1)) {
      campaignMismatches.add(actionEntry.key);
    }
    const projectActionEventIds = stringKeys(entry.project.actionEventIds);
    if (action?.kind !== 'act'
      || integerValue(event.atMonth) !== integerValue(attempt.atMonth)
      || !projectActionEventIds.includes(eventId)) {
      actionMismatches.add(actionEntry.key);
    }
    const diffOperation = operationValue(
      diff.projectHypothesisOperation,
      legacyAttempt && operation === 'combine-inventory',
    );
    const projectedRoleBasis = diffRoleBasis(diff);
    const diffQuestion = questionValue(projectedRoleBasis.questionKind);
    if (!roleBasisMatches(attemptRoleBasis, projectedRoleBasis, Array.isArray(attempt.sourceKeys))) {
      actionDiffRoleBasisMismatches.add(attemptKey);
    }
    if (diffQuestion && entityRoleBasisPresent(projectedRoleBasis, diffOperation)) {
      actionDiffsWithEntityRoleBasis += 1;
    }
    if (hasNonFiniteRoleScore(projectedRoleBasis)) {
      nonFiniteRoleScores.add('action:' + actionEntry.key);
    }
    if (diffQuestion && (diffOperation !== expectedQuestionOperation(diffQuestion)
      || action?.kind !== 'act'
      || action.operation !== expectedActionOperation(expectedQuestionOperation(diffQuestion)))) {
      questionOperationMismatches.add('action:' + actionEntry.key);
    }
    if (!operation || diffOperation !== operation
      || (legacyAttempt && stringValue(campaign.version) === 'project-hypothesis-campaign-v2'
        && diff.projectHypothesisOperation !== undefined)
      || action?.kind !== 'act'
      || action.operation !== expectedActionOperation(operation)) {
      operationMismatches.add(operationMismatchKey);
      actionMismatches.add(actionEntry.key);
    }
    const diffOrdinal = integerValue(diff.projectHypothesisAttemptOrdinal);
    if (diffOrdinal !== ordinal || diffOrdinal !== attemptIndex + 1) {
      attemptOrdinalMismatches.add(attemptKey);
    }
    const diffBudget = integerValue(diff.projectHypothesisBudget);
    const legacyBudgetMatches = legacyAttempt && totalBudget !== null && diffBudget !== null
      && diffBudget >= (ordinal ?? attemptIndex + 1) && diffBudget <= totalBudget;
    if (diffBudget !== totalBudget && !legacyBudgetMatches) actionMismatches.add(actionEntry.key);
    const diffNoResponseBudget = integerValue(diff.projectHypothesisNoResponseBudget);
    const diffResponseBudget = integerValue(diff.projectHypothesisResponseBudget);
    if (legacyAttempt) {
      if (diffNoResponseBudget !== null && diffNoResponseBudget !== noResponseBudget) {
        actionMismatches.add(actionEntry.key);
      }
      if (diffResponseBudget !== null && diffResponseBudget !== responseBudget) {
        actionMismatches.add(actionEntry.key);
      }
    } else if (diffNoResponseBudget !== noResponseBudget || diffResponseBudget !== responseBudget) {
      actionMismatches.add(actionEntry.key);
    }
    if (totalBudget !== null && diffOrdinal !== null && diffOrdinal > totalBudget) {
      totalBudgetExceeds.add(attemptKey);
      budgetExceeds.add(attemptKey);
    }
    const projectedMaterialIds = materialPair(diff.projectHypothesisMaterialIds);
    const projectedTargetMaterialId = integerValue(diff.projectHypothesisTargetMaterialId);
    const projectedSignature = signatureFor(diffOperation, projectedMaterialIds, projectedTargetMaterialId);
    const reconstructedActualSignature = operation ? actualSignature(diff, operation) : null;
    const diffCandidateKey = stringValue(diff.projectHypothesisCandidateKey);
    if (!attemptSignature || reconstructedActualSignature !== attemptSignature
      || projectedSignature !== attemptSignature || diffCandidateKey !== candidateKey
      || (diffOperation && projectedMaterialIds
        && !roleMaterialIdsMatch(diff, diffOperation, projectedMaterialIds, 'projectHypothesis'))) {
      actionDiffSignatureMismatches.add(attemptKey);
    }
    const actionOutcome = event.status === 'completed'
      ? 'response'
      : event.status === 'blocked' ? 'no-response' : null;
    if (!outcome || outcomeValue(diff.projectHypothesisOutcome) !== outcome || actionOutcome !== outcome) {
      actionDiffOutcomeMismatches.add(attemptKey);
    }
    if (stringKeys(diff.projectHypothesisSourceKeys).length === 0) missingSourceKeys.add(attemptKey);
    if (diff.projectHypothesisHadReliableKnowledge !== false) reliableKnowledgeViolations.add(actionEntry.key);
  }

  const validVerificationByAttempt = new Map<string, {
    outputMaterialId: number;
    sourceKey: string;
    responseEventId: string;
    verifiedEventId: string;
    verifiedAtMonth: number;
    verificationEventIndex: number;
    actorId: string | null;
  }>();
  for (const entry of attemptEntries) {
    if (outcomeValue(entry.attempt.outcome) !== 'response') continue;
    const details = attemptDetails.get(entry.attemptKey);
    const responseEventId = stringValue(entry.attempt.eventId);
    const verifiedEventId = stringValue(entry.attempt.verifiedEventId);
    const verifiedAtMonth = integerValue(entry.attempt.verifiedAtMonth);
    const outputMaterialId = integerValue(entry.attempt.outputMaterialId);
    const verificationEntry = verifiedEventId ? actionById.get(verifiedEventId) : undefined;
    const verificationAction = verificationEntry ? objectRecord(verificationEntry.event.action) : null;
    const verificationRequest = objectRecord(verificationAction?.verification);
    const verificationTarget = objectRecord(verificationAction?.target);
    const verificationDiff = verificationEntry?.diff;
    const attemptTechniqueId = stringValue(entry.attempt.techniqueId);
    const responseRef = objectRecord(entry.attempt.responseRef);
    const sourceKey = responseRefSourceKey(responseRef, stringValue(entry.campaign.actorId));
    const responseTargetMatches = responseRef?.kind === 'inventory-stack'
      ? verificationTarget?.kind === 'inventory-stack'
        && stringValue(verificationTarget.stackId) === stringValue(responseRef.stackId)
        && integerValue(responseRef.materialId) === outputMaterialId
      : responseRef?.kind === 'voxel'
        ? verificationTarget?.kind === 'voxel'
          && JSON.stringify(objectRecord(verificationTarget.position)) === JSON.stringify(objectRecord(responseRef.position))
          && integerValue(responseRef.materialId) === outputMaterialId
        : false;
    if (!details?.operation || !responseEventId || !verifiedEventId || verifiedAtMonth === null
      || outputMaterialId === null || !verificationEntry || verificationAction?.kind !== 'attend'
      || !attemptTechniqueId || !sourceKey || !responseTargetMatches
      || stringValue(verificationRequest?.techniqueId) !== attemptTechniqueId
      || stringValue(verificationRequest?.sourceEventId) !== responseEventId
      || integerValue(verificationRequest?.expectedMaterialId) !== outputMaterialId
      || verificationEntry.event.status !== 'completed'
      || stringValue(verificationEntry.event.who) !== stringValue(entry.campaign.actorId)
      || integerValue(verificationEntry.event.atMonth) !== verifiedAtMonth
      || verifiedAtMonth < (integerValue(entry.attempt.atMonth) ?? verifiedAtMonth)
      || !stringKeys(entry.project.actionEventIds).includes(verifiedEventId)
      || stringValue(verificationDiff?.projectHypothesisVerificationCampaignId) !== entry.campaignId
      || stringValue(verificationDiff?.projectHypothesisVerificationProjectId) !== entry.projectId
      || stringValue(verificationDiff?.projectHypothesisVerifiedAttemptEventId) !== responseEventId
      || stringValue(verificationDiff?.projectHypothesisVerifiedCandidateKey)
        !== stringValue(entry.attempt.candidateKey)
      || operationValue(verificationDiff?.projectHypothesisVerifiedOperation) !== details.operation
      || integerValue(verificationDiff?.projectHypothesisVerifiedOutputMaterialId) !== outputMaterialId
      || stringValue(verificationDiff?.verifiedSourceEventId) !== responseEventId) {
      continue;
    }
    verifiedResponses.add(entry.attemptKey);
    validVerificationByAttempt.set(entry.attemptKey, {
      outputMaterialId,
      sourceKey,
      responseEventId,
      verifiedEventId,
      verifiedAtMonth,
      verificationEventIndex: verificationEntry.eventIndex,
      actorId: stringValue(entry.campaign.actorId),
    });
  }
  for (const entry of attemptEntries) {
    const details = attemptDetails.get(entry.attemptKey);
    const candidate = details?.candidate;
    const atMonth = integerValue(entry.attempt.atMonth);
    if (!details?.materialIds || !candidate || atMonth === null
      || !stringKeys(candidate.reasonKeys).includes('verified-response-material')) {
      continue;
    }
    const sourceFactIds = new Set([
      ...stringKeys(entry.attempt.sourceFactIds),
      ...stringKeys(candidate.sourceFactIds),
    ]);
    const earlierAttempts = attemptEntries
      .filter((prior) => prior.key === entry.key && prior.attemptIndex < entry.attemptIndex)
      .sort((left, right) => right.attemptIndex - left.attemptIndex);
    const source = earlierAttempts.find((prior) => {
      const verification = validVerificationByAttempt.get(prior.attemptKey);
      return verification !== undefined
        && atMonth >= verification.verifiedAtMonth
        && details.materialIds!.includes(verification.outputMaterialId)
        && sourceFactIds.has(verification.responseEventId);
    });
    if (source) responseDrivenTransitions.add(entry.attemptKey);
  }
  for (const entry of attemptEntries) {
    const details = attemptDetails.get(entry.attemptKey);
    if (!details?.operation || !details.materialIds) continue;
    const atMonth = integerValue(entry.attempt.atMonth);
    const actionEventId = stringValue(entry.attempt.eventId);
    const actionEntry = actionEventId ? actionById.get(actionEventId) : undefined;
    const actionEventIndex = actionEntry?.eventIndex;
    const actorId = stringValue(entry.campaign.actorId);
    if (atMonth === null || !actionEntry || actionEventIndex === undefined || !actorId) continue;
    const materialAttributionSourceFactIds = new Set([
      ...stringKeys(entry.attempt.sourceFactIds),
      ...stringKeys(details.candidate?.sourceFactIds),
    ]);
    const priorVerifiedEntities = [...validVerificationByAttempt.values()].filter((verification) => (
      verification.actorId === actorId
        && (verification.verifiedAtMonth < atMonth
          || (verification.verifiedAtMonth === atMonth
            && verification.verificationEventIndex < actionEventIndex))
        && (materialAttributionSourceFactIds.has(verification.responseEventId)
          || materialAttributionSourceFactIds.has(verification.verifiedEventId))
    ));
    const toolMaterialId = integerValue(entry.attempt.toolRoleMaterialId)
      ?? integerValue(entry.attempt.toolMaterialId)
      ?? details.materialIds[0];
    const inputMaterialId = integerValue(entry.attempt.inputRoleMaterialId)
      ?? integerValue(entry.attempt.inputMaterialId)
      ?? (details.operation === 'expose-local' ? details.materialIds[0] : details.materialIds[1]);
    if (details.operation === 'exert-air') {
      const verifiedMaterials = new Set(priorVerifiedEntities.map((verification) => verification.outputMaterialId));
      if (verifiedMaterials.has(toolMaterialId)) exertVerifiedResponseToolAttempts.add(entry.attemptKey);
      if (verifiedMaterials.has(inputMaterialId)) exertVerifiedResponseInputAttempts.add(entry.attemptKey);
    }

    const reasons = exactReasonKeys(entry.attempt.roleReasonKeys) ?? [];
    const attemptSourceFactIds = new Set(stringKeys(entry.attempt.sourceFactIds));
    const attemptSourceKeys = new Set(stringKeys(entry.attempt.sourceKeys));
    const actionSourceKeys = new Set(stringKeys(actionEntry.diff.projectHypothesisSourceKeys));
    const actionBasisMatches = roleBasisMatches(
      storedRoleBasis(entry.attempt),
      diffRoleBasis(actionEntry.diff),
      Array.isArray(entry.attempt.sourceKeys),
    );
    const causallySourcedEntities = priorVerifiedEntities.filter((verification) => (
      attemptSourceFactIds.has(verification.responseEventId)
        || attemptSourceFactIds.has(verification.verifiedEventId)
    ));
    const auditRoleAttribution = (
      role: 'tool' | 'input',
      materialId: number,
      sourceField: 'toolSourceKey' | 'inputSourceKey',
      diffSourceField: 'projectHypothesisToolSourceKey' | 'projectHypothesisInputSourceKey',
      exactAttempts: Set<string>,
    ) => {
      const legacyReason = `verified-response-as-${role}`;
      const exactReason = `exact-verified-response-as-${role}`;
      if (!reasons.includes(legacyReason) && !reasons.includes(exactReason)) return;
      const sourceKey = stringValue(entry.attempt[sourceField]);
      const actionSourceKey = stringValue(actionEntry.diff[diffSourceField]);
      const exactEntity = sourceKey ? causallySourcedEntities.find((verification) => (
        verification.outputMaterialId === materialId && verification.sourceKey === sourceKey
      )) : undefined;
      if (sourceKey && exactEntity && actionBasisMatches && actionSourceKey === sourceKey
        && attemptSourceKeys.has(sourceKey) && actionSourceKeys.has(sourceKey)) {
        exactAttempts.add(entry.attemptKey);
      } else {
        materialOnlyVerifiedResponseAttributionViolations.add(entry.attemptKey);
      }
    };
    auditRoleAttribution(
      'tool',
      toolMaterialId,
      'toolSourceKey',
      'projectHypothesisToolSourceKey',
      exactEntityVerifiedResponseToolAttempts,
    );
    auditRoleAttribution(
      'input',
      inputMaterialId,
      'inputSourceKey',
      'projectHypothesisInputSourceKey',
      exactEntityVerifiedResponseInputAttempts,
    );
  }

  const hypothesisDiffFields = [
    'projectHypothesisCampaignId', 'projectHypothesisProjectId', 'projectHypothesisActorId',
    'projectHypothesisCandidateKey', 'projectHypothesisOperation', 'projectHypothesisMaterialIds',
    'projectHypothesisToolMaterialId', 'projectHypothesisInputMaterialId',
    'projectHypothesisTargetMaterialId', 'projectHypothesisToolSourceKey',
    'projectHypothesisInputSourceKey', 'projectHypothesisAttemptOrdinal',
    'projectHypothesisQuestionKind', 'projectHypothesisRoleScore',
    'projectHypothesisToolRoleScore', 'projectHypothesisInputRoleScore',
    'projectHypothesisSurfaceRoleScore', 'projectHypothesisToolRoleMaterialId',
    'projectHypothesisInputRoleMaterialId', 'projectHypothesisSurfaceRoleMaterialId',
    'projectHypothesisRoleReasonKeys',
    'projectHypothesisBudget', 'projectHypothesisNoResponseBudget', 'projectHypothesisResponseBudget',
    'projectHypothesisOutcome', 'projectHypothesisSourceKeys', 'projectHypothesisHadReliableKnowledge',
  ];
  for (const actionEntry of actionEntries) {
    const { event, diff } = actionEntry;
    if (!hypothesisDiffFields.some((field) => field in diff)) continue;
    const matches = actionEntry.id ? attemptsByEventId.get(actionEntry.id) ?? [] : [];
    if (matches.length !== 1) actionMismatches.add(actionEntry.key);
    const diffProjectId = stringValue(diff.projectHypothesisProjectId);
    const diffActorId = stringValue(diff.projectHypothesisActorId);
    const diffCampaignId = stringValue(diff.projectHypothesisCampaignId);
    if (!diffProjectId || !projectById.has(diffProjectId)) unresolvedProjects.add('action:' + actionEntry.key);
    if (!diffActorId || !personIds.has(diffActorId)) unresolvedActors.add('action:' + actionEntry.key);
    if (!diffCampaignId || !campaignEntriesById.has(diffCampaignId)) {
      unresolvedCampaigns.add('action:' + actionEntry.key);
    } else if ((campaignEntriesById.get(diffCampaignId)?.length ?? 0) !== 1) {
      campaignMismatches.add(actionEntry.key);
    }
    const action = objectRecord(event.action);
    const explicitDiffOperation = operationValue(diff.projectHypothesisOperation);
    const inferredLegacyOperation = explicitDiffOperation ?? (
      diff.projectHypothesisOperation === undefined
        && action?.kind === 'act' && action.operation === 'combine'
        ? 'combine-inventory'
        : null
    );
    if (!inferredLegacyOperation || action?.kind !== 'act'
      || action.operation !== expectedActionOperation(inferredLegacyOperation)) {
      operationMismatches.add(actionEntry.key);
      actionMismatches.add(actionEntry.key);
    }
    const projectedRoleBasis = diffRoleBasis(diff);
    const diffQuestion = questionValue(projectedRoleBasis.questionKind);
    if (hasNonFiniteRoleScore(projectedRoleBasis)) {
      nonFiniteRoleScores.add('action:' + actionEntry.key);
    }
    if (diffQuestion && (inferredLegacyOperation !== expectedQuestionOperation(diffQuestion)
      || action?.kind !== 'act'
      || action.operation !== expectedActionOperation(expectedQuestionOperation(diffQuestion)))) {
      questionOperationMismatches.add('action:' + actionEntry.key);
    }
    if (stringKeys(diff.projectHypothesisSourceKeys).length === 0) missingSourceKeys.add('action:' + actionEntry.key);
    if (diff.projectHypothesisHadReliableKnowledge !== false) reliableKnowledgeViolations.add(actionEntry.key);
  }

  return {
    hypothesisCampaigns: campaignEntries.length,
    hypothesisCandidates: candidateEntries.length,
    hypothesisAttempts: attemptEntries.length,
    hypothesisResponses,
    hypothesisNoResponses,
    hypothesisExhaustedCampaigns: campaignEntries.filter((entry) => entry.campaign.status === 'exhausted').length,
    hypothesisFirstAttemptResponses,
    hypothesisFirstAttemptNoResponses,
    hypothesisCombineAttempts: operationCounts['combine-inventory'].attempts,
    hypothesisCombineResponses: operationCounts['combine-inventory'].responses,
    hypothesisCombineNoResponses: operationCounts['combine-inventory'].noResponses,
    hypothesisExertAttempts: operationCounts['exert-air'].attempts,
    hypothesisExertResponses: operationCounts['exert-air'].responses,
    hypothesisExertNoResponses: operationCounts['exert-air'].noResponses,
    hypothesisExposeAttempts: operationCounts['expose-local'].attempts,
    hypothesisExposeResponses: operationCounts['expose-local'].responses,
    hypothesisExposeNoResponses: operationCounts['expose-local'].noResponses,
    hypothesisConnectManipulatorShapesCandidates: questionCounts['connect-manipulator-shapes'].candidates,
    hypothesisConnectManipulatorShapesAttempts: questionCounts['connect-manipulator-shapes'].attempts,
    hypothesisConnectManipulatorShapesResponses: questionCounts['connect-manipulator-shapes'].responses,
    hypothesisConnectManipulatorShapesNoResponses: questionCounts['connect-manipulator-shapes'].noResponses,
    hypothesisConnectFlexibleLayersCandidates: questionCounts['connect-flexible-layers'].candidates,
    hypothesisConnectFlexibleLayersAttempts: questionCounts['connect-flexible-layers'].attempts,
    hypothesisConnectFlexibleLayersResponses: questionCounts['connect-flexible-layers'].responses,
    hypothesisConnectFlexibleLayersNoResponses: questionCounts['connect-flexible-layers'].noResponses,
    hypothesisSeekLocalHeatCandidates: questionCounts['seek-local-heat'].candidates,
    hypothesisSeekLocalHeatAttempts: questionCounts['seek-local-heat'].attempts,
    hypothesisSeekLocalHeatResponses: questionCounts['seek-local-heat'].responses,
    hypothesisSeekLocalHeatNoResponses: questionCounts['seek-local-heat'].noResponses,
    hypothesisShapePortableSurfaceCandidates: questionCounts['shape-portable-surface'].candidates,
    hypothesisShapePortableSurfaceAttempts: questionCounts['shape-portable-surface'].attempts,
    hypothesisShapePortableSurfaceResponses: questionCounts['shape-portable-surface'].responses,
    hypothesisShapePortableSurfaceNoResponses: questionCounts['shape-portable-surface'].noResponses,
    hypothesisTransformSubjectWithObservedHeatCandidates:
      questionCounts['transform-subject-with-observed-heat'].candidates,
    hypothesisTransformSubjectWithObservedHeatAttempts:
      questionCounts['transform-subject-with-observed-heat'].attempts,
    hypothesisTransformSubjectWithObservedHeatResponses:
      questionCounts['transform-subject-with-observed-heat'].responses,
    hypothesisTransformSubjectWithObservedHeatNoResponses:
      questionCounts['transform-subject-with-observed-heat'].noResponses,
    hypothesisCandidatesWithRoleBasis: candidatesWithRoleBasis,
    hypothesisAttemptsWithRoleBasis: attemptsWithRoleBasis,
    hypothesisCandidateRoleBasisCoverage: candidateEntries.length
      ? Math.round(candidatesWithRoleBasis / candidateEntries.length * 10_000) / 100
      : 100,
    hypothesisAttemptRoleBasisCoverage: attemptEntries.length
      ? Math.round(attemptsWithRoleBasis / attemptEntries.length * 10_000) / 100
      : 100,
    hypothesisCandidatesWithEntityRoleBasis: candidatesWithEntityRoleBasis,
    hypothesisAttemptsWithEntityRoleBasis: attemptsWithEntityRoleBasis,
    hypothesisActionDiffsWithEntityRoleBasis: actionDiffsWithEntityRoleBasis,
    hypothesisCandidateEntityRoleBasisCoverage: candidateEntries.length
      ? Math.round(candidatesWithEntityRoleBasis / candidateEntries.length * 10_000) / 100
      : 100,
    hypothesisAttemptEntityRoleBasisCoverage: attemptEntries.length
      ? Math.round(attemptsWithEntityRoleBasis / attemptEntries.length * 10_000) / 100
      : 100,
    hypothesisActionDiffEntityRoleBasisCoverage: attemptEntries.length
      ? Math.round(actionDiffsWithEntityRoleBasis / attemptEntries.length * 10_000) / 100
      : 100,
    hypothesisCandidatesMissingQuestionKind: candidatesMissingQuestionKind.size,
    hypothesisCandidatesMissingRoleBasis: candidatesMissingRoleBasis.size,
    hypothesisAttemptsMissingQuestionKind: attemptsMissingQuestionKind.size,
    hypothesisAttemptsMissingRoleBasis: attemptsMissingRoleBasis.size,
    hypothesisCandidateAttemptRoleBasisMismatches: candidateAttemptRoleBasisMismatches.size,
    hypothesisActionDiffRoleBasisMismatches: actionDiffRoleBasisMismatches.size,
    hypothesisNonFiniteRoleScores: nonFiniteRoleScores.size,
    hypothesisQuestionOperationMismatches: questionOperationMismatches.size,
    hypothesisExertVerifiedResponseToolAttempts: exertVerifiedResponseToolAttempts.size,
    hypothesisExertVerifiedResponseInputAttempts: exertVerifiedResponseInputAttempts.size,
    hypothesisExactEntityVerifiedResponseToolAttempts: exactEntityVerifiedResponseToolAttempts.size,
    hypothesisExactEntityVerifiedResponseInputAttempts: exactEntityVerifiedResponseInputAttempts.size,
    hypothesisMaterialOnlyVerifiedResponseAttributionViolations:
      materialOnlyVerifiedResponseAttributionViolations.size,
    hypothesisVerifiedResponses: verifiedResponses.size,
    hypothesisResponseDrivenTransitions: responseDrivenTransitions.size,
    hypothesisUniquePairs: uniqueSignatures.size,
    hypothesisUniqueSignatures: uniqueSignatures.size,
    hypothesisUnresolvedProjects: unresolvedProjects.size,
    hypothesisProjectMismatches: projectMismatches.size,
    hypothesisUnresolvedActors: unresolvedActors.size,
    hypothesisActorMismatches: actorMismatches.size,
    hypothesisUnresolvedCampaigns: unresolvedCampaigns.size,
    hypothesisCampaignMismatches: campaignMismatches.size,
    hypothesisUnresolvedActionEvents: unresolvedActionEvents.size,
    hypothesisActionMismatches: actionMismatches.size,
    hypothesisOperationMismatches: operationMismatches.size,
    hypothesisDuplicateProjectPairs: duplicateProjectSignatures.size,
    hypothesisDuplicateProjectSignatures: duplicateProjectSignatures.size,
    hypothesisBudgetExceeds: budgetExceeds.size,
    hypothesisTotalBudgetExceeds: totalBudgetExceeds.size,
    hypothesisNoResponseBudgetExceeds: noResponseBudgetExceeds.size,
    hypothesisResponseBudgetExceeds: responseBudgetExceeds.size,
    hypothesisAttemptOrdinalMismatches: attemptOrdinalMismatches.size,
    hypothesisActionDiffPairMismatches: actionDiffSignatureMismatches.size,
    hypothesisActionDiffSignatureMismatches: actionDiffSignatureMismatches.size,
    hypothesisActionDiffOutcomeMismatches: actionDiffOutcomeMismatches.size,
    hypothesisMissingSourceKeys: missingSourceKeys.size,
    hypothesisReliableKnowledgeViolations: reliableKnowledgeViolations.size,
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
  const events = state.world.past;
  const fromEventIndex = latestCheckpointEventCount(previous, events.length);
  const newMilestoneEvidenceIds = new Set(newMilestones.flatMap((milestone) => milestone.evidenceEventIds));
  const newMilestoneEvidence = new Map<string, WorldEvent>();
  for (let index = fromEventIndex; index < events.length; index += 1) {
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
  previous?: EvolutionCheckpoint,
): EvolutionCheckpoint {
  const through = state.clock.elapsedMonths;
  const eventCount = state.world.past.length;
  const canIncrement = previous !== undefined
    && Number.isInteger(previous.eventCount)
    && previous.eventCount >= 0
    && previous.eventCount <= eventCount
    && Number.isInteger(previous.ruleDecisions)
    && previous.ruleDecisions >= 0
    && Number.isInteger(previous.modelDecisions)
    && previous.modelDecisions >= 0;
  const fromEventIndex = canIncrement ? previous.eventCount : 0;
  let ruleDecisions = canIncrement ? previous.ruleDecisions : 0;
  let modelDecisions = canIncrement ? previous.modelDecisions : 0;
  for (let index = fromEventIndex; index < eventCount; index += 1) {
    const event = state.world.past[index];
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
