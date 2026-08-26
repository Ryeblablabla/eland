import type { MaterialId } from './material';
import type { ElectricalPowerPlan } from './electrical-power';
import type { MechanicalPowerProjectPlan } from './mechanical-power';
import type { PersonId } from './person';

export type ProjectKind = 'production' | 'construction' | 'inquiry';

export type ProjectNeed =
  | 'thermal-safety'
  | 'hunting-safety'
  | 'care-capability'
  | 'food-preparation'
  | 'shelter-capacity'
  | 'knowledge-preservation'
  | 'production-efficiency'
  | 'reserve-security'
  | 'water-security'
  | 'coordination-capacity'
  | 'high-heat-capability'
  | 'alloy-capability'
  | 'iron-capability'
  | 'mechanical-power-capability'
  | 'equipment-reliability'
  | 'remote-work-power'
  | 'measurement-uncertainty';

export type ProjectFunction =
  | 'insulation'
  | 'safer-hunting'
  | 'healing'
  | 'prepared-food'
  | 'weather-shelter'
  | 'durable-record'
  | 'efficient-production'
  | 'workshop-production'
  | 'reserve-storage'
  | 'reliable-water'
  | 'settled-cultivation'
  | 'crop-processing'
  | 'community-coordination'
  | 'high-heat-processing'
  | 'brick-firing'
  | 'copper-charge'
  | 'copper-smelting'
  | 'tin-charge'
  | 'tin-smelting'
  | 'bronze-alloying'
  | 'bronze-tooling'
  | 'bronze-workshop'
  | 'civic-coordination'
  | 'iron-workshop'
  | 'iron-charge'
  | 'iron-reduction'
  | 'iron-working'
  | 'iron-tooling'
  | 'fortified-coordination'
  | 'water-powered-crop-processing'
  | 'restore-water-powered-crop-processing'
  | 'durable-power-transmission'
  | 'remote-work-power-delivery'
  | 'restore-electrical-power-delivery'
  | 'comparable-mass-measurement';

export interface RemoteWorkPowerPosition {
  cellId: number;
  z: number;
}

/**
 * Frozen, person-local evidence that repeated trips between a commissioned
 * mechanical source and one fixed remote workplace made transmitting useful
 * work worth investigating. It names no electrical component or recipe.
 */
export interface RemoteWorkPowerTransmissionBasis {
  version: 'remote-work-power-transmission-basis-v1';
  observerId: PersonId;
  atMonth: number;
  mechanicalInstallationProjectId: string;
  mechanicalNetworkId: string;
  mechanicalPlanKey: string;
  sourceSegmentId: string;
  sourceWorkPosition: RemoteWorkPowerPosition;
  remoteWorkPosition: RemoteWorkPowerPosition;
  /** Exactly two personally remembered, authoritative Seed -> Food services. */
  mechanicalServiceEventIds: [string, string];
  /** Exactly two personally remembered non-mechanical work facts at one site. */
  remoteWorkEventIds: [string, string];
  /** One remembered physical move from each of the three alternating legs. */
  travelEventIds: [string, string, string];
  routeDistance: number;
  /** Minimal chronological union of the seven facts above. */
  sourceFactIds: string[];
  basisKey: string;
}

export type PerceivedLoadBand = 'trace' | 'light' | 'hand-load' | 'burdensome';

/** One current entity whose coarse hand-feel contributed to a comparison doubt. */
export interface MeasurementUncertaintySampleBasis {
  personId: PersonId;
  stackId: string;
  materialId: MaterialId;
  quantity: number;
  perceivedLoadBand: PerceivedLoadBand;
  /** Complete current stack provenance, not a replaceable material category. */
  sourceEventIds: string[];
  /** Personally performed production facts among that provenance. */
  productionEventIds: string[];
}

/**
 * Frozen person-local evidence for a mass-comparison inquiry. It records only
 * an overlapping coarse felt-load band; exact physical mass never enters the
 * proposal or planner-facing project state.
 */
export interface MeasurementUncertaintyBasis {
  version: 'measurement-uncertainty-basis-v1';
  observerId: PersonId;
  atMonth: number;
  uncertaintyKind: 'overlapping-felt-load-bands';
  samples: [MeasurementUncertaintySampleBasis, MeasurementUncertaintySampleBasis];
  productionEventIds: string[];
  experiencedMonthCount: number;
  sourceFactIds: string[];
  basisKey: string;
}

export interface MechanicalReliabilityFaultBasis {
  faultEventId: string;
  diagnosisEventId: string;
  shaftMaterialId: MaterialId;
  shaftInstallationEventId: string;
  shaftInstallationSourceEventIds: string[];
  shaftRepairEventId?: string;
  shaftRepairSourceEventIds: string[];
  serviceLoadedOperationCount: number;
  /** Exact successful loaded actions retained from this fault's bounded proof. */
  loadedOperationEventIds: string[];
}

/**
 * Frozen person-local evidence that repeated wear, rather than an observer
 * milestone, opened a reliability inquiry. It deliberately names no expected
 * replacement material or recipe.
 */
export interface MechanicalReliabilityBasis {
  version: 'mechanical-reliability-basis-v1';
  observerId: PersonId;
  networkId: string;
  installationProjectId: string;
  atMonth: number;
  faults: MechanicalReliabilityFaultBasis[];
  sourceFactIds: string[];
  basisKey: string;
}

/**
 * Frozen, person-local evidence for restoring one current electrical delivery
 * chain. It names the broken entity and personal diagnosis, but no replacement
 * recipe or observer milestone.
 */
export interface ElectricalPowerMaintenanceBasis {
  version: 'electrical-power-maintenance-basis-v1';
  observerId: PersonId;
  installationProjectId: string;
  networkId: string;
  planKey: string;
  faultEventId: string;
  diagnosisEventId: string;
  componentPosition: { x: number; y: number; z: number };
  atMonth: number;
  /** Exact two-fact causal basis: current overload and personal diagnosis. */
  sourceFactIds: [string, string];
  basisKey: string;
}

/**
 * A person's positive, locally observable reasons for reopening a functional
 * inquiry. Negative evidence may close candidates, but never fabricates a new
 * opportunity merely because another project was created later.
 */
export type ProjectInquiryOpportunityKind =
  | 'material'
  | 'knowledge'
  | 'target'
  | 'verified-response'
  | 'ready-record-carrier';

/** The exact, person-local evidence behind one otherwise coarse opportunity key. */
export interface ProjectInquiryOpportunitySource {
  opportunityKey: string;
  kind: ProjectInquiryOpportunityKind;
  materialId?: MaterialId;
  sourceKeys: string[];
  sourceFactIds: string[];
}

export interface ProjectInquiryOpportunityBasis {
  version: 'project-inquiry-opportunity-basis-v1';
  actorId: PersonId;
  desiredFunction: ProjectFunction;
  atMonth: number;
  materialIds: MaterialId[];
  techniqueIds: string[];
  targetSourceKeys: string[];
  verifiedResponseEventIds: string[];
  opportunityKeys: string[];
  /** v27 exact sources that a renewed project must actually use before falling back. */
  opportunitySources: ProjectInquiryOpportunitySource[];
  sourceFactIds: string[];
  sourceKeys: string[];
  basisKey: string;
  /** Earlier failed projects whose explored opportunities constrain this opening. */
  inheritedProjectIds: string[];
  /** Positive opportunities not present in any inherited failed-project basis. */
  renewalKeys: string[];
}

export interface ProjectPressureBasis {
  version: 'project-pressure-basis-v1';
  need: ProjectNeed;
  observerId: PersonId;
  atMonth: number;
  pressure: number;
  edgeKeys: string[];
  reasonKeys: string[];
  sourceFactIds: string[];
  basisKey: string;
}

export type ProjectStatus = 'active' | 'completed' | 'blocked' | 'abandoned';

export interface ProjectSite {
  cellId: number;
  z: number;
}

export interface ProjectShelterRequirement {
  exposureKind: 'cold' | 'heat';
  beneficiaryId: PersonId;
  baselineEnclosedSides: number;
  baselineOpenSides: number;
  baselineWeatherProtection: number;
  baselineThermalInsulation: number;
  minimumEnclosedSides: number;
  sourceEventIds: string[];
}

export interface ProjectShelterOutcome {
  enclosedSides: number;
  openSides: number;
  weatherProtection: number;
  thermalInsulation: number;
  evidenceEventIds: string[];
}

export interface ProjectProposal {
  id: string;
  kind: ProjectKind;
  need: ProjectNeed;
  desiredFunction: ProjectFunction;
  summary: string;
  ownerId: PersonId;
  beneficiaryIds: PersonId[];
  triggerFactIds: string[];
  pressure: number;
  pressureBasis?: ProjectPressureBasis;
  /** Best production-tool rank personally held when this tool project was proposed. */
  productionToolBaselineRank?: number;
  createdAtMonth: number;
  reviewAtMonth: number;
  site?: ProjectSite;
  /** A locally observed exposure that an already functional shelter failed to prevent. */
  shelterRequirement?: ProjectShelterRequirement;
  /** A fact the owner already knows and has a local reason to preserve. */
  targetKnowledgeId?: string;
  /** Person-local evidence that makes this inquiry newly actionable. */
  inquiryOpportunityBasis?: ProjectInquiryOpportunityBasis;
  /** Preserve the first sourced route compiled before this proposal is accepted. */
  initialLogisticsEpisode?: ProjectLogisticsEpisode;
  /** Preserve the finite local search area compiled with the first route. */
  initialSearchCampaign?: ProjectSearchCampaign;
  /** Preserve the first selected step's local quantity deficit. */
  initialMaterialDemands?: ProjectMaterialDemand[];
  /** Preserve the first locally grounded, fallible material hypothesis campaign. */
  initialHypothesisCampaign?: ProjectHypothesisCampaign;
  /** Exact locally observed source and component sites, frozen when proposed. */
  mechanicalPowerPlan?: MechanicalPowerProjectPlan;
  /** Frozen derived identities let persisted projects reject a geometrically different action basis. */
  mechanicalPowerPlanKey?: string;
  mechanicalPowerNetworkId?: string;
  /** Present only for a maintenance project bound to one still-current physical fault. */
  mechanicalPowerFaultEventId?: string;
  /** Present only when repeated personally diagnosed wear opened a reliability inquiry. */
  mechanicalReliabilityBasis?: MechanicalReliabilityBasis;
  /** Present only when remembered, current craft batches formed a comparison doubt. */
  measurementUncertaintyBasis?: MeasurementUncertaintyBasis;
  /** Present only when personal mechanical service plus repeated remote travel opened the inquiry. */
  remoteWorkPowerBasis?: RemoteWorkPowerTransmissionBasis;
  /** Present only for restoration of one personally diagnosed current electrical fault. */
  electricalPowerMaintenanceBasis?: ElectricalPowerMaintenanceBasis;
  /** Frozen only after all required component techniques were personally discovered and verified. */
  electricalPowerPlan?: ElectricalPowerPlan;
  electricalPowerPlanKey?: string;
  electricalPowerNetworkId?: string;
}

export interface ProjectReservation {
  personId: PersonId;
  stackId: string;
  materialId: MaterialId;
  quantity: number;
}

export interface ProjectMaterialDemand {
  materialId: MaterialId;
  requiredQuantity: number;
  availableQuantity: number;
  outstandingQuantity: number;
  branchKey: string;
  sourceFactIds: string[];
}

export type ProjectProgressKind =
  | 'material-contribution'
  | 'knowledge-contribution'
  | 'logistics-advance'
  | 'action-progress';

export interface ProjectProgressEvidence {
  eventId: string;
  atMonth: number;
  kind: ProjectProgressKind;
  actorId: PersonId;
  episodeId?: string;
  target?: ProjectSite;
  distanceBefore?: number;
  distanceAfter?: number;
}

export interface ProjectTechniqueDemonstrationBasis {
  version: 'project-technique-demonstration-basis-v1';
  projectId: string;
  desiredFunction: ProjectFunction;
  learnerId: PersonId;
  demonstratorId: PersonId;
  requestEventId: string;
  demonstrationEventId: string;
  techniqueId: string;
  operation: 'combine' | 'exert' | 'expose';
  inputMaterialIds: MaterialId[];
  toolMaterialId?: MaterialId;
  targetMaterialId?: MaterialId;
  outputMaterialId: MaterialId;
  sourceKeys: string[];
  sourceFactIds: string[];
  initialConfidence: number;
  atMonth: number;
}

export interface ProjectTechniqueDemonstrationRequestBasis {
  version: 'project-technique-demonstration-request-v1';
  requestEventId: string;
  projectId: string;
  requesterId: PersonId;
  teacherIds: PersonId[];
  desiredFunction: ProjectFunction;
  expiresAtMonth: number;
  atMonth: number;
}

export interface ProjectMaterialContributionRequestBasis {
  version: 'project-material-contribution-request-v1';
  requestEventId: string;
  projectId: string;
  requesterId: PersonId;
  contributorIds: PersonId[];
  materialId: MaterialId;
  requestedQuantity: number;
  contributedQuantity?: number;
  contributionEventIds?: string[];
  site: ProjectSite;
  expiresAtMonth: number;
  atMonth: number;
}

export interface ProjectKnowledgeRequestBasis {
  version: 'project-knowledge-request-v1';
  requestEventId: string;
  projectId: string;
  requesterId: PersonId;
  listenerIds: PersonId[];
  outputMaterialId: MaterialId;
  expiresAtMonth: number;
  atMonth: number;
  responseEventId?: string;
  responderId?: PersonId;
  techniqueId?: string;
}

export type ProjectLogisticsEpisodeKind = 'search' | 'drop' | 'source';
export type ProjectLogisticsEpisodeStatus = 'active' | 'fulfilled' | 'exhausted' | 'invalidated';

export type ProjectLogisticsEndingReason =
  | 'material-acquired'
  | 'material-produced'
  | 'source-invalidated'
  | 'source-unreachable'
  | 'search-target-reached'
  | 'search-budget-exhausted'
  | 'search-target-unreachable'
  | 'project-completed'
  | 'project-blocked'
  | 'project-abandoned';

/** v9 deliberately supports only a seen ground drop or the project's own missing requirement. */
export type ProjectLogisticsSourceRef =
  | { kind: 'drop'; dropId: string }
  | {
      kind: 'voxel-source';
      position: { x: number; y: number; z: number };
      sourceMaterialId: MaterialId;
    }
  | { kind: 'project-requirement'; projectId: string };

export interface ProjectLogisticsEpisode {
  id: string;
  kind: ProjectLogisticsEpisodeKind;
  actorId: PersonId;
  materialIds: MaterialId[];
  target: ProjectSite;
  sourceRef: ProjectLogisticsSourceRef;
  searchCampaignId?: string;
  sourceEventIds: string[];
  /** Simulation month in which this locally sourced target was fixed. */
  createdAt: number;
  status: ProjectLogisticsEpisodeStatus;
  actionEventIds: string[];
  /** Search actions are bounded; survival-reflex actions do not consume this budget. */
  actionBudget?: number;
  /** Locally visible demand-producing sources when this route was compiled. */
  visibleSourceCountAtCreation?: number;
  /** Path length to a fixed world source when it was selected. */
  sourcePathLengthAtCreation?: number;
  /** Quantity carried when a drop was fixed, so another local action can satisfy the need. */
  startingQuantity?: number;
  /** Exact local deficit selected when this source was fixed. */
  materialDemand?: ProjectMaterialDemand;
  /** Search may cover multiple current deficits or legitimate substitutes. */
  materialDemands?: ProjectMaterialDemand[];
  /** Units requested from this source; may be lower than the full deficit when the source is small. */
  requestedQuantity?: number;
  endedAt?: number;
  endingReason?: ProjectLogisticsEndingReason;
}

export type ProjectSearchCampaignStatus = 'active' | 'exhausted' | 'superseded' | 'closed';

export interface ProjectSearchCampaign {
  id: string;
  projectId: string;
  ownerId: PersonId;
  actorId: PersonId;
  materialIds: MaterialId[];
  /** Plan edge under which absence was observed; a changed plan may justify a fresh search. */
  planKnowledgeId?: string;
  basisKey: string;
  openedAt: number;
  anchor: ProjectSite;
  cellIds: number[];
  /** Targets this actor already checked in older projects under the same material/plan basis. */
  inheritedTargetKeys?: string[];
  /** Older personal campaigns that supplied `inheritedTargetKeys`. */
  inheritedCampaignIds?: string[];
  attemptedTargetKeys: string[];
  sourceFactIds: string[];
  status: ProjectSearchCampaignStatus;
  closedAt?: number;
}

export type ProjectHypothesisCampaignStatus = 'active' | 'exhausted' | 'closed' | 'superseded';
export type ProjectHypothesisAttemptOutcome = 'response' | 'no-response';
export type ProjectHypothesisOperation = 'combine-inventory' | 'exert-air' | 'expose-local';
export type ProjectHypothesisQuestionKind =
  | 'connect-manipulator-shapes'
  | 'connect-flexible-layers'
  | 'assemble-balanced-suspension'
  | 'shape-repeatable-reference'
  | 'assemble-flow-driven-rotor'
  | 'shape-rigid-rotating-connector'
  | 'seek-local-heat'
  | 'shape-portable-surface'
  | 'transform-subject-with-observed-heat';

/** Lexicographic, causal ranking. Randomness may only break an exact tie. */
export interface ProjectHypothesisRankBasis {
  requiredRoleFit: number;
  learnedEvidence: number;
  informationRelevance: number;
  optionalTraitFit: number;
  seedTieBreak: number;
}

export type ProjectHypothesisResponseRef =
  | { kind: 'inventory-stack'; stackId: string; materialId: MaterialId }
  | { kind: 'voxel'; position: { x: number; y: number; z: number }; materialId: MaterialId };

export interface ProjectHypothesisCandidate {
  key: string;
  operation: ProjectHypothesisOperation;
  questionKind: ProjectHypothesisQuestionKind;
  /** Combine uses [left,right], exert uses [tool,input], expose uses [input,target]. */
  materialIds: [MaterialId, MaterialId];
  /** Exact bounded combine slots; omitted on legacy two-slot candidates. */
  inventoryMaterialIds?: [MaterialId, MaterialId] | [MaterialId, MaterialId, MaterialId];
  toolMaterialId?: MaterialId;
  inputMaterialId?: MaterialId;
  targetMaterialId?: MaterialId;
  /** Exact local entities selected for the provisional roles. */
  toolSourceKey?: string;
  inputSourceKey?: string;
  toolRoleMaterialId?: MaterialId;
  inputRoleMaterialId?: MaterialId;
  surfaceRoleMaterialId?: MaterialId;
  /** Observable role judgment, distinct from whether the world will respond. */
  roleScore: number;
  toolRoleScore?: number;
  inputRoleScore?: number;
  surfaceRoleScore?: number;
  roleReasonKeys: string[];
  /** Diagnostic aggregate of observable role fit; never an expected-output score. */
  observableScore: number;
  /** Present on next-generation candidates; absent only on persisted legacy campaigns. */
  rankBasis?: ProjectHypothesisRankBasis;
  /** Legacy field; next-generation candidates use it only as an exact causal-tier tie key. */
  seededRank: number;
  reasonKeys: string[];
  sourceFactIds: string[];
  /** Current tangible references cover month-zero objects that predate the event log. */
  sourceKeys: string[];
}

export interface ProjectHypothesisAttempt {
  candidateKey: string;
  operation: ProjectHypothesisOperation;
  questionKind: ProjectHypothesisQuestionKind;
  materialIds: [MaterialId, MaterialId];
  inventoryMaterialIds?: [MaterialId, MaterialId] | [MaterialId, MaterialId, MaterialId];
  toolMaterialId?: MaterialId;
  inputMaterialId?: MaterialId;
  targetMaterialId?: MaterialId;
  toolSourceKey?: string;
  inputSourceKey?: string;
  toolRoleMaterialId?: MaterialId;
  inputRoleMaterialId?: MaterialId;
  surfaceRoleMaterialId?: MaterialId;
  roleScore: number;
  toolRoleScore?: number;
  inputRoleScore?: number;
  surfaceRoleScore?: number;
  roleReasonKeys: string[];
  rankBasis?: ProjectHypothesisRankBasis;
  eventId: string;
  atMonth: number;
  ordinal: number;
  candidateRank: number;
  outcome: ProjectHypothesisAttemptOutcome;
  outputMaterialId?: MaterialId;
  /** Executor-created technique and entity produced by this exact response. */
  techniqueId?: string;
  responseRef?: ProjectHypothesisResponseRef;
  /** Only an entity-attend that raises the response technique above the reliable threshold opens a new stage. */
  verifiedEventId?: string;
  verifiedAtMonth?: number;
  verificationLostAtMonth?: number;
  sourceFactIds: string[];
  sourceKeys: string[];
}

/**
 * A finite project-local search over tangible material pairs. It records what
 * the person tried, but deliberately contains no expected output or rule id.
 */
export interface ProjectHypothesisCampaign {
  version: 'project-hypothesis-campaign-v1' | 'project-hypothesis-campaign-v2';
  id: string;
  projectId: string;
  actorId: PersonId;
  openedAt: number;
  /** Total response plus no-response attempts. */
  budget: number;
  /** A response never refunds failures already observed. */
  noResponseBudget?: number;
  /** Maximum number of material responses that can open successive stages. */
  responseBudget?: number;
  observedMaterialIds: MaterialId[];
  sourceFactIds: string[];
  sourceKeys: string[];
  candidates: ProjectHypothesisCandidate[];
  attempts: ProjectHypothesisAttempt[];
  status: ProjectHypothesisCampaignStatus;
  activeCandidateKey?: string;
  endedAt?: number;
  endingReason?:
    | 'attempt-budget-exhausted'
    | 'total-attempt-budget-exhausted'
    | 'no-response-budget-exhausted'
    | 'response-stage-budget-exhausted'
    | 'project-completed'
    | 'project-blocked'
    | 'project-abandoned'
    | 'reliable-knowledge';
}

/**
 * A placed capability carrier is not yet a delivered function. This basis is
 * frozen from one project-owned installation and names only the already-known
 * physical service envelope; the later service action still has to pass the
 * ordinary world rules.
 */
export interface ProjectFunctionalCommissioning {
  version: 'project-functional-commissioning-v1';
  desiredFunction: ProjectFunction;
  serviceKind: 'crop-mature-separation';
  facilityMaterialId: MaterialId;
  installationEventId: string;
  installationPosition: { x: number; y: number; z: number };
  serviceRadius: number;
  enteredAtMonth: number;
  /** Membership is frozen before the service action, so that action cannot authorize its own actor. */
  eligiblePersonIds: PersonId[];
  sourceFactIds: string[];
}

/**
 * A project is the persistence unit between a local need and primitive actions.
 * `desiredFunction` is deliberately not a hidden recipe or civilization target.
 */
export interface ProjectState extends ProjectProposal {
  status: ProjectStatus;
  lastProgressAtMonth: number;
  planKnowledgeId?: string;
  missingMaterialIds: MaterialId[];
  materialDemands?: ProjectMaterialDemand[];
  reservations: ProjectReservation[];
  contributorIds: PersonId[];
  actionEventIds: string[];
  failureEventIds: string[];
  /** Present after a project-owned carrier is installed and before a real positive service completes. */
  functionalCommissioning?: ProjectFunctionalCommissioning;
  completedAtMonth?: number;
  completionEventIds: string[];
  blockedReason?: string;
  blockedAtMonth?: number;
  abandonedAtMonth?: number;
  shelterOutcome?: ProjectShelterOutcome;
  progressEvidence?: ProjectProgressEvidence[];
  searchCampaigns?: ProjectSearchCampaign[];
  hypothesisCampaign?: ProjectHypothesisCampaign;
  /** Executed requests remain visible to their addressed teachers before month-end projection. */
  techniqueDemonstrationRequests?: ProjectTechniqueDemonstrationRequestBasis[];
  /** Project-bound requests let nearby holders stage exact missing materials at a fixed site. */
  materialContributionRequests?: ProjectMaterialContributionRequestBasis[];
  /** A one-shot request names a planned output but never exposes the requester's unknown recipe inputs. */
  knowledgeRequests?: ProjectKnowledgeRequestBasis[];
  /** v28 request-bound, physically executed demonstrations available for personal imitation. */
  techniqueDemonstrations?: ProjectTechniqueDemonstrationBasis[];
  /** Frozen when a failed inquiry terminates; later proposals compare against it. */
  terminalInquiryOpportunityBasis?: ProjectInquiryOpportunityBasis;
  pressureHistory?: ProjectPressureBasis[];
  /** Optional while v8 saves are migrated lazily by the project compiler. */
  logisticsEpisodes?: ProjectLogisticsEpisode[];
  activeLogisticsEpisodeId?: string;
}

export function cloneProjectForPlanning(project: ProjectState): ProjectState {
  // Planning may append to these evidence collections, but archived entries
  // are immutable protocol facts. Copy their shells without recursively
  // cloning megabytes of historical bases and event identifiers.
  const pressureHistory = project.pressureHistory ? [...project.pressureHistory] : undefined;
  const progressEvidence = project.progressEvidence ? [...project.progressEvidence] : undefined;
  const clone = structuredClone({
    ...project,
    pressureHistory: undefined,
    progressEvidence: undefined,
    triggerFactIds: [],
    beneficiaryIds: [],
    contributorIds: [],
    actionEventIds: [],
    failureEventIds: [],
    completionEventIds: [],
  } as ProjectState);
  clone.triggerFactIds = [...project.triggerFactIds];
  clone.beneficiaryIds = [...project.beneficiaryIds];
  clone.contributorIds = [...project.contributorIds];
  clone.actionEventIds = [...project.actionEventIds];
  clone.failureEventIds = [...project.failureEventIds];
  clone.completionEventIds = [...project.completionEventIds];
  if (pressureHistory) clone.pressureHistory = pressureHistory;
  if (progressEvidence) clone.progressEvidence = progressEvidence;
  return clone;
}

export function instantiateProject(proposal: ProjectProposal): ProjectState {
  const {
    initialLogisticsEpisode,
    initialSearchCampaign,
    initialMaterialDemands,
    initialHypothesisCampaign,
    ...base
  } = structuredClone(proposal);
  return {
    ...base,
    status: 'active',
    lastProgressAtMonth: proposal.createdAtMonth,
    missingMaterialIds: [],
    materialDemands: initialMaterialDemands ?? [],
    reservations: [],
    contributorIds: [proposal.ownerId],
    actionEventIds: [],
    failureEventIds: [],
    completionEventIds: [],
    progressEvidence: [],
    searchCampaigns: initialSearchCampaign ? [initialSearchCampaign] : [],
    ...(initialHypothesisCampaign ? { hypothesisCampaign: initialHypothesisCampaign } : {}),
    pressureHistory: proposal.pressureBasis ? [structuredClone(proposal.pressureBasis)] : [],
    logisticsEpisodes: initialLogisticsEpisode ? [initialLogisticsEpisode] : [],
    ...(initialLogisticsEpisode?.status === 'active' ? { activeLogisticsEpisodeId: initialLogisticsEpisode.id } : {}),
  };
}
