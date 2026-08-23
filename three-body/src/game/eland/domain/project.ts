import type { MaterialId } from './material';
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
  | 'mechanical-power-capability';

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
  | 'restore-water-powered-crop-processing';

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

export type ProjectProgressKind = 'material-contribution' | 'knowledge-contribution' | 'logistics-advance';

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
  | 'seek-local-heat'
  | 'shape-portable-surface'
  | 'transform-subject-with-observed-heat';

export type ProjectHypothesisResponseRef =
  | { kind: 'inventory-stack'; stackId: string; materialId: MaterialId }
  | { kind: 'voxel'; position: { x: number; y: number; z: number }; materialId: MaterialId };

export interface ProjectHypothesisCandidate {
  key: string;
  operation: ProjectHypothesisOperation;
  questionKind: ProjectHypothesisQuestionKind;
  /** Combine uses [left,right], exert uses [tool,input], expose uses [input,target]. */
  materialIds: [MaterialId, MaterialId];
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
  /** Rank derived only from observable material properties plus a replayable local perturbation. */
  observableScore: number;
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
