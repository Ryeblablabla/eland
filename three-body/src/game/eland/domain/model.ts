import { MONTHS_PER_YEAR } from './calendar';
import type { ActionOption, Intent, IntentDecision, PrimitiveAction, WorldRef } from './action';
import type { MaterialId } from './material';
import type { PersonId, PersonState } from './person';
import type { VoxelWorld } from '../world/grid';
import type { Agreement } from './agreement';
import type { RecordPayload } from './record';
import type { CollectiveState } from './collective';
import type { ResourcePermission } from './permission';
import type { ContainerState } from './container';
import type { WorkState } from './works';
import type { AnimalBondState } from './animal-bonds';
import type { AnimalState } from './animal';
import type { ProjectState } from './project';
import type { MechanicalPowerWorldState } from './mechanical-power';
import type { ElectricalPowerWorldState } from './electrical-power';
import type { HumanRemainsState, MemorialMarkerState } from './mortuary';
import type { CharacterAgendaDecisionEvidence } from './character-agenda';
import type { AgentMemoryStoreState } from './agent-memory';
import type { PersonMindView } from './person-mind';
import type { LanguageBroadcast } from './language-perception';

export * from './action';
export * from './material';
export * from './person';
export * from './mechanical-power';
export * from './electrical-power';
export * from './mortuary';
export * from './mental-act';
export * from './person-mind';

export type EpochKind = 'stable' | 'chaotic';
export type ClimateKind = 'temperate' | 'cold' | 'heat' | 'fire';
export type TerminalCatastropheKind = 'triple-sun-vaporization';
export type ClimateBias = 'balanced' | 'cold' | 'hot';
export type WeatherKind = 'clear' | 'rain' | 'storm' | 'drought' | 'snow' | 'fog';

export interface SimulationConfig {
  civilizationNo: number;
  climateBias: ClimateBias;
  chaosIntensity: number;
  endpoint: { kind: 'months' | 'milestones'; value: number };
  characterIds?: string[];
}

export interface DropState {
  id: string;
  materialId: MaterialId;
  cellId: number;
  /** 掉落物所在的可站立空气体素高度。 */
  z: number;
  quantity: number;
  createdAtMonth: number;
  sourceEventIds: string[];
  /** Exact physical sources this drop descended from across transfers. */
  sourceLineageKeys?: string[];
  recordPayloadId?: string;
  /** The deceased owner whose private inventory produced this exact drop. */
  estateOfPersonId?: PersonId;
  /** A request-bound project delivery remains reserved only while its demand is still live. */
  projectMaterialDelivery?: {
    version: 'project-material-delivery-v1';
    projectId: string;
    requestEventId: string;
    requesterId: PersonId;
    expiresAtMonth: number;
  };
}

/** Durable semantic state created by a Plan Agent interaction when no narrower subsystem owns it. */
export interface OpenWorldFact {
  id: string;
  atMonth: number;
  cellId: number;
  z: number;
  actorId: PersonId;
  summary: string;
  targetRefs: WorldRef[];
  /** Exact entity/property owned by this current open state. */
  targetRef?: WorldRef;
  stateKey?: string;
  stateValue?: string;
  sourceEventId: string;
}

/**
 * Authoritative facts available while an agent is choosing what to do.
 *
 * Observer-owned projections are deliberately absent. A complete
 * `SimulationState` remains structurally assignable to this view, so planning
 * does not need a clone, wrapper, cast, or second state identity at runtime.
 */
export type DecisionAuthorityState = Omit<SimulationState, 'civilization' | 'derived'> & {
  civilization: Omit<
    SimulationState['civilization'],
    'stage' | 'civilizationIndex' | 'development' | 'externalEraRegime'
  >;
};

export interface DecisionContext {
  state: DecisionAuthorityState;
  person: PersonState;
  visibleCells: number[];
  visiblePeople: PersonState[];
  visibleDrops: DropState[];
  visibleAnimals: AnimalState[];
  visibleRemains?: HumanRemainsState[];
  options: ActionOption[];
  followUpOptions: ActionOption[];
  activeIntent?: Intent;
  /** Month/tick at which this read-only context was compiled. */
  decisionMonth?: number;
  planningTick?: number;
  /** Already-realized facts from the current uncommitted month. */
  currentMonthEvents?: WorldEvent[];
  /** Unified subjective read view; optional only for old fixtures/adapters. */
  mind?: PersonMindView;
}

export type Decision = IntentDecision;
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported prefix-cache accounting when available. */
  cacheHitInputTokens?: number;
  cacheMissInputTokens?: number;
}
export interface AgentDecider {
  decide(context: DecisionContext): Decision;
  /** The model-backed runtime may reserve subjective social forks for model review. */
  readonly defersVoluntarySocialChoicesToModel?: boolean;
}
export interface ModelInvocationMetadata {
  endpointId: string;
  protocol: string;
  model: string;
  /** Actual upstream provider requests, distinct from person contexts. */
  providerRequests?: number;
}
export interface BatchDecider {
  decideAll(contexts: DecisionContext[]): Promise<(Decision | null)[]>;
  /** Null/error fallback and later local ticks must not invent subjective social choices. */
  readonly ownsVoluntarySocialChoices?: boolean;
  /** Optional infrastructure policy. Omitted by deterministic tests and legacy callers. */
  shouldDecide?(context: DecisionContext, atMonth: number): boolean;
  /** A player-initiated choice may request one fresh local revalidation at the next month boundary. */
  forceReview?(context: DecisionContext, atMonth: number): boolean;
  /** Player-interaction choices use their own ledger rather than ordinary person-month credits. */
  isBudgetExempt?(context: DecisionContext, atMonth: number): boolean;
  takeUsage?(): TokenUsage;
  takeMetadata?(): ModelInvocationMetadata | null;
}

export interface BaseEvent {
  id: string;
  atMonth: number;
  orderInMonth: number;
  /** 0 denotes a month-boundary system process; person actions use 1..15. */
  planningTick?: number;
  /** Stable order among facts committed in the same planning tick. */
  orderInTick?: number;
  cellId: number;
}

export interface DecisionOpportunityFact extends BaseEvent {
  kind: 'decision-opportunity';
  who: PersonId;
  probability: number;
  sample: number;
  triggered: boolean;
  reasons: string[];
  result: string;
}

export interface ReproductionDecisionEvidence {
  version: 'family-readiness-v2';
  optionId: string;
  direction: 'proceed' | 'withdraw';
  generativityUrgency: number;
  needActivation: number;
  motivation: number;
  aspiration: number;
  relationshipGate: number;
  readinessGate: number;
  familyReadiness?: {
    readiness: number;
    food: number;
    water: number;
    shelter: number;
    careCapacity: number;
    climateSafety: number;
    basisKeys: string[];
    /** Total unique sources before the event keeps a bounded audit sample. */
    sourceFactCount?: number;
    sourceFactIds: string[];
  };
  sourceFactIds: string[];
}

/** Bounded, person-local planning audit; it records no simulated future fact. */
export interface ForesightDecisionEvidence {
  version: 'bounded-foresight-decision-v1';
  selectedOptionId: string;
  selectedWasExpanded: boolean;
  changedLocalSelection: boolean;
  selectedMatchesAdjustedChoice: boolean;
  rootCount: number;
  expandedNodes: number;
  maxDepth: number;
  budgetCutoff: boolean;
  expectedValue: number;
  valueOfInformation: number;
  adjustment: number;
  sourceFactCount: number;
  sourceFactIds: string[];
}

export interface DecisionFact extends BaseEvent {
  kind: 'decision';
  who: PersonId;
  decision: Decision;
  intentId?: string;
  usedModel: boolean;
  domain?: 'strategic' | 'social';
  /** Missing on older facts means an ordinary review. Edge reviews do not spend the ordinary cadence budget. */
  planningChannel?: 'ordinary' | 'edge';
  reproductionEvidence?: ReproductionDecisionEvidence;
  foresightEvidence?: ForesightDecisionEvidence;
  /** Accepted subjective concerns and their locally compiled disposition. */
  characterAgendaEvidence?: CharacterAgendaDecisionEvidence[];
  /** The one outward language wave emitted by a model-authored decision. */
  languageBroadcast?: LanguageBroadcast;
  result: string;
}

export interface ActionFact extends BaseEvent {
  kind: 'action';
  actionTick: number;
  who: PersonId;
  intentId?: string;
  /** The rule path that authorized this action; provenance never relaxes validation. */
  cause: 'intent' | 'survival-reflex' | 'player-embodiment';
  action: PrimitiveAction;
  fromCellId: number;
  toCellId: number;
  fromZ: number;
  toZ: number;
  pathSegment: number[];
  status: 'progressed' | 'completed' | 'blocked' | 'failed';
  result: string;
  diff: Record<string, unknown>;
}

export interface EnvironmentFact extends BaseEvent {
  kind: 'environment';
  change: 'founding' | 'climate' | 'weather' | 'prediction' | 'relationship' | 'animal' | 'body' | 'condition' | 'death' | 'resource' | 'material';
  who?: PersonId;
  result: string;
  diff: Record<string, unknown>;
}

export interface AgreementFact extends BaseEvent {
  kind: 'agreement';
  agreementId: string;
  change: 'expired' | 'fulfilled' | 'breached' | 'cancelled' | 'response-deadline-paused' | 'response-deadline-resumed';
  partyIds: PersonId[];
  responderId?: PersonId;
  hibernationConditionId?: string;
  deadlineScope?: 'response' | 'fulfillment';
  effectiveFromMonth?: number;
  sourceEventIds?: string[];
  result: string;
}

export interface PermissionFact extends BaseEvent {
  kind: 'permission';
  permissionId: string;
  change: 'expired' | 'ended';
  partyIds: PersonId[];
  result: string;
}

export type WorldEvent = DecisionOpportunityFact | DecisionFact | ActionFact | EnvironmentFact | AgreementFact | PermissionFact;

export interface PracticeObservation {
  key: string;
  label: string;
  count: number;
  agentIds: PersonId[];
  eventIds: string[];
  stability: number;
}

export interface InstitutionObservation { key: string; label: string; evidenceEventIds: string[]; note: string }
export type MilestoneValence = 'constructive' | 'harmful' | 'ambivalent';
export type MilestonePhase = 'emergence' | 'practice' | 'stable' | 'decline' | 'collapse' | 'recovery' | 'harm' | 'response';

/**
 * A replayable observer result, never an agent goal or unlock flag.
 * Optional metadata keeps the original numeric milestones
 * readable while the capability-map observer is introduced incrementally.
 */
export interface MilestoneObservation {
  id: string;
  label: string;
  evidenceEventIds: string[];
  note: string;
  observedAtMonth?: number;
  capabilityId?: number;
  catalogKind?: 'map' | 'world-specific';
  mapLabel?: string;
  domain?: string;
  valence?: MilestoneValence;
  phase?: MilestonePhase;
  participantIds?: PersonId[];
  affectedPersonIds?: PersonId[];
  definitionVersion?: string;
  occurrenceCount?: number;
}

export interface EmergentRegion {
  id: string;
  kind: 'natural' | 'residential' | 'trail' | 'cultivated';
  cells: number[];
  confidence: number;
  evidenceEventIds: string[];
  firstObservedMonth: number;
  lastObservedMonth: number;
  label?: string;
}

/** A physical index entry reconstructed from committed construction facts and voxels. */
export interface PhysicalStructure {
  id: string;
  name: string;
  occupiedCells: number[];
  interiorCells: number[];
  interiorPositions: Array<{ cellId: number; z: number }>;
  materialIds: MaterialId[];
  weatherProtection: number;
  thermalInsulation: number;
  capacity: number;
  complete: boolean;
  sourceEventIds: string[];
}

/**
 * Bounded construction provenance for one voxel/material pair. A coordinate
 * may retain more than one material because the current grid can later return
 * to an older constructed material without another combine action.
 */
export interface PhysicalConstructionRecord {
  x: number;
  y: number;
  z: number;
  materialId: MaterialId;
  firstSeenAbsoluteIndex: number;
  latestSourceAbsoluteIndex: number;
  sourceEventId: string;
}

export interface PhysicalStructureIndex {
  /** Optional only for schema-17 states written before the bounded v2 fold. */
  projectionVersion?: 2;
  /** Absolute committed-ledger cursor covered by `constructionRecords`. */
  appliedHistoryEventCount?: number;
  /** Exact event id at `appliedHistoryEventCount - 1`, or null at genesis. */
  appliedTailEventId?: string | null;
  calculatedAtMonth: number;
  /** Optional only for schema-17 states written before freshness tracking. */
  voxelRevision?: number;
  /** Optional only for schema-17 states written before freshness tracking. */
  constructionEventCount?: number;
  /** Optional only for schema-17 states written before the bounded v2 fold. */
  constructionRecords?: PhysicalConstructionRecord[];
  structures: PhysicalStructure[];
}

/** @deprecated Use PhysicalStructure. Kept for schema-17 and public type compatibility. */
export type DerivedStructure = PhysicalStructure;

export interface DecisionMonthLedger {
  atMonth: number;
  livingAgents: number;
  candidates: number;
  modelContexts: number;
  ordinaryModelContexts?: number;
  exemptModelContexts?: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitInputTokens?: number;
  cacheMissInputTokens?: number;
  chargedTokens: number;
  ordinaryChargedTokens?: number;
  modelEndpointId?: string;
  modelProtocol?: string;
  modelName?: string;
  /** Total provider calls this month, including expression calls and retries. */
  providerRequests?: number;
  speechInputTokens?: number;
  speechOutputTokens?: number;
  speechProviderRequests?: number;
  memoryCompactionInputTokens?: number;
  memoryCompactionOutputTokens?: number;
  memoryCompactionProviderRequests?: number;
  memoryCompactionCapsules?: number;
}

export interface EraSchedule {
  sequence: number;
  kind: EpochKind;
  sinceMonth: number;
  endsAtMonth: number;
  dominantClimate: ClimateKind;
}

/**
 * Sustained external-sky evidence used to distinguish a real era regime from
 * a short orbital disturbance. The raw sky sample remains separately stored
 * by the live session and terminal catastrophes bypass this confirmation.
 */
export interface ExternalEraRegime {
  sinceMonth: number;
  candidateEpoch: EpochKind | null;
  candidateSinceMonth: number;
  candidateConsecutiveMonths: number;
}

export interface EraPrediction {
  id: string;
  predictorId: PersonId;
  perceivedByPersonIds: PersonId[];
  madeAtMonth: number;
  targetEpoch: EpochKind;
  predictedStartMonth: number;
  toleranceMonths: number;
  expiresAtMonth: number;
  status: 'pending' | 'correct' | 'incorrect';
  resolvedAtMonth?: number;
  errorMonths?: number;
  sourceEventIds: string[];
}

export interface CivilizationIndexComponent {
  score: number;
  weight: number;
  evidence: Record<string, number>;
}

export interface CivilizationIndex {
  /** Observer formula only; planners never read this value. */
  formulaVersion?: string;
  total: number;
  calculatedAtMonth: number;
  components: {
    population: CivilizationIndexComponent;
    territory: CivilizationIndexComponent;
    technology: CivilizationIndexComponent;
    social: CivilizationIndexComponent;
    history: CivilizationIndexComponent;
  };
}

/** `medieval` remains readable only for persisted observer snapshots from v1-v4. */
export type DevelopmentEraKey =
  | 'primitive-tribe'
  | 'agrarian-settlement'
  | 'ancient-civilization'
  | 'modern-civilization'
  | 'medieval';
export type MaterialCapabilityStage = 'hypothesis' | 'sample' | 'repeatable' | 'distributed' | 'institutional';

export interface MaterialCapabilityObservation {
  key: 'processed-wood' | 'masonry-stone' | 'bronze' | 'iron';
  stage: MaterialCapabilityStage;
  successfulBatchEventIds: string[];
  failedBatchEventIds: string[];
  producerIds: PersonId[];
  adoptedActionEventIds: string[];
  productionSiteMaterialIds: MaterialId[];
  supportingInstitutionKeys: string[];
}

export interface FunctionalBuildingObservation {
  id: string;
  kind: 'core' | 'storage' | 'water' | 'workshop' | 'kiln' | 'mill' | 'foundry' | 'smithy';
  materialId: MaterialId;
  cellId: number;
  z: number;
  installedAtMonth: number;
  installationEventIds: string[];
  useEventIds: string[];
  userIds: PersonId[];
  functionSummary: string;
  active: boolean;
}

export interface CivilizationDevelopmentObservation {
  /** v1-v7 remain readable for persisted snapshots; new observations are emitted as v8. */
  observerVersion:
    | 'material-institution-era-v1'
    | 'material-institution-era-v2'
    | 'material-institution-era-v3'
    | 'material-institution-era-v4'
    | 'material-institution-era-v5'
    | 'material-institution-era-v6'
    | 'material-institution-era-v7'
    | 'material-institution-era-v8';
  currentEra: DevelopmentEraKey;
  historicalPeakEra: DevelopmentEraKey;
  candidateEra: DevelopmentEraKey;
  candidateSinceMonth: number;
  transitionProgress: number;
  satisfiedGateIds: string[];
  missingGateIds: string[];
  supportingEventIds: string[];
  materialCapabilities: MaterialCapabilityObservation[];
}

/** Pure observer output. It contains no gameplay-readable physical index. */
export interface SimulationObservations {
  practices: PracticeObservation[];
  institutions: InstitutionObservation[];
  milestones: MilestoneObservation[];
  regions: EmergentRegion[];
  functionalBuildings?: FunctionalBuildingObservation[];
}

/** Schema-17 serialized observer shape with its historical structures mirror. */
export interface PersistedSimulationObservations extends SimulationObservations {
  /**
   * Compatibility mirror of world.physicalStructureIndex.structures.
   * Gameplay rules must read the physical index through physicalStructuresOf.
   */
  structures: PhysicalStructure[];
}

/**
 * Observer-neutral position of the committed event ledger.
 *
 * `world.past` still contains the complete history in schema 17 today. The
 * separate cursor lets a later runtime retain only the window beginning at
 * `hotStartIndex` without changing absolute event ordinals or exposing an era
 * metric to planners.
 */
export interface WorldHistoryCursorV1 {
  version: 1;
  eventCount: number;
  hotStartIndex: number;
  tailEventId: string | null;
}

/**
 * Observer-neutral identity allocation state. These counters preserve entity
 * identity when terminal history is compacted out of the live gameplay shell.
 */
export interface SimulationIdentityCounters {
  /** Next ordinal reserved for a newly created intent. */
  intentOrdinal: number;
}

export interface SimulationState {
  schemaVersion: 19;
  seed: number;
  branchId: string;
  /** Optional only for compact test fixtures; creation initializes it. */
  identityCounters?: SimulationIdentityCounters;
  clock: { unit: 'month'; elapsedMonths: number; monthsPerYear: typeof MONTHS_PER_YEAR };
  world: {
    grid: VoxelWorld;
    drops: DropState[];
    animals: AnimalState[];
    /** Open-ended local changes adjudicated outside the fixed recipe/action catalogue. */
    openFacts?: OpenWorldFact[];
    /** Person-built composite entities (lean-tos, stacks, lattices) from open interaction. */
    works?: WorkState[];
    /** Person↔animal bond tracks derived from real contact (feeding, calming). */
    animalBonds?: AnimalBondState[];
    /** Optional only for compact test fixtures. */
    remains?: HumanRemainsState[];
    /** Physical memorial carriers created by completed mortuary acts. */
    memorials?: MemorialMarkerState[];
    past: WorldEvent[];
    /** Optional for compact fixtures; restore derives it from full history. */
    historyCursor?: WorldHistoryCursorV1;
    /** Incremental traversal counts keyed by `cellId:z`. */
    traffic?: Record<string, number>;
    /** Optional only for compact fixtures; new and restored states initialize v1 explicitly. */
    mechanicalPower?: MechanicalPowerWorldState;
    /** Optional until the first authoritative electrical installation initializes v1. */
    electricalPower?: ElectricalPowerWorldState;
    /**
     * Physical cache rebuilt from committed construction facts and voxels.
     * Optional because hand-built fixtures may omit it; creation, state
     * adoption and month commit reconstruct it.
     */
    physicalStructureIndex?: PhysicalStructureIndex;
  };
  people: PersonState[];
  /**
   * Unified owner-scoped cognitive memory. Optional only for compact fixtures;
   * state adoption creates the current version without migrating legacy data.
   */
  memoryStore?: AgentMemoryStoreState;
  intents: Intent[];
  agreements: Agreement[];
  records: RecordPayload[];
  collectives: CollectiveState[];
  permissions: ResourcePermission[];
  containers: ContainerState[];
  eraPredictions: EraPrediction[];
  projects: ProjectState[];
  civilization: {
    number: number;
    status: 'running' | 'ended';
    stage: string;
    epoch: EpochKind;
    era: EraSchedule;
    climate: { kind: ClimateKind; severity: number; sinceMonth: number };
    weather: { kind: WeatherKind; intensity: number; sinceMonth: number };
    externalClimate?: {
      epoch: EpochKind;
      kind: ClimateKind;
      severity: number;
      terminalCatastrophe?: TerminalCatastropheKind;
    };
    externalEraRegime?: ExternalEraRegime;
    conditions: SimulationConfig;
    civilizationIndex: CivilizationIndex;
    /** Pure observer state. Planners and world rules must never read it. */
    development?: CivilizationDevelopmentObservation;
    outcome?: { kind: 'destroyed' | 'boundary' | 'milestones' | 'concluded'; cause: string; atMonth: number; summary: string };
  };
  decisionBudget: { credits: number; tokensPerContext: number; ledgers: DecisionMonthLedger[] };
  derived: PersistedSimulationObservations;
  lastStep: WorldEvent[];
}

export interface EnvironmentEventInput {
  kind: 'climate' | 'resource';
  cellId: number;
  severity?: number;
  resource?: string;
  delta?: number;
  description?: string;
}

export interface EvolutionReport {
  schemaVersion: 19;
  exportedAt: string;
  civilization: SimulationState['civilization'];
  finalState: SimulationState;
  checkpoints: SimulationState[];
  review: { milestones: MilestoneObservation[]; eventCount: number };
}
