import { MONTHS_PER_YEAR } from './calendar';
import type { ActionOption, Intent, IntentDecision, PrimitiveAction } from './action';
import type { MaterialId } from './material';
import type { PersonId, PersonState } from './person';
import type { VoxelWorld } from '../world/grid';
import type { Agreement } from './agreement';
import type { RecordPayload } from './record';
import type { CollectiveState } from './collective';
import type { ResourcePermission } from './permission';
import type { ContainerState } from './container';
import type { AnimalState } from './animal';
import type { ProjectState } from './project';
import type { MechanicalPowerWorldState } from './mechanical-power';
import type { HumanRemainsState, MemorialMarkerState } from './mortuary';

export * from './action';
export * from './material';
export * from './person';
export * from './mechanical-power';
export * from './mortuary';

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

export interface DecisionContext {
  state: SimulationState;
  person: PersonState;
  visibleCells: number[];
  visiblePeople: PersonState[];
  visibleDrops: DropState[];
  visibleAnimals: AnimalState[];
  visibleRemains?: HumanRemainsState[];
  options: ActionOption[];
  followUpOptions: ActionOption[];
  activeIntent?: Intent;
}

export type Decision = IntentDecision;
export interface TokenUsage { inputTokens: number; outputTokens: number }
export interface AgentDecider { decide(context: DecisionContext): Decision }
export interface ModelInvocationMetadata {
  endpointId: string;
  protocol: string;
  model: string;
}
export interface BatchDecider {
  decideAll(contexts: DecisionContext[]): Promise<(Decision | null)[]>;
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

export interface DecisionFact extends BaseEvent {
  kind: 'decision';
  who: PersonId;
  decision: Decision;
  intentId?: string;
  usedModel: boolean;
  domain?: 'strategic' | 'social';
  reproductionEvidence?: ReproductionDecisionEvidence;
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

export interface PhysicalStructureIndex {
  calculatedAtMonth: number;
  /** Optional only for schema-17 states written before freshness tracking. */
  voxelRevision?: number;
  /** Optional only for schema-17 states written before freshness tracking. */
  constructionEventCount?: number;
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
  chargedTokens: number;
  ordinaryChargedTokens?: number;
  modelEndpointId?: string;
  modelProtocol?: string;
  modelName?: string;
}

export interface EraSchedule {
  sequence: number;
  kind: EpochKind;
  sinceMonth: number;
  endsAtMonth: number;
  dominantClimate: ClimateKind;
}

export interface EraPrediction {
  id: string;
  predictorId: PersonId;
  audienceIds: PersonId[];
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
export type DevelopmentEraKey = 'primitive-tribe' | 'agrarian-settlement' | 'ancient-civilization' | 'medieval';
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
  /** v1-v5 remain readable for persisted snapshots; new observations are emitted as v6. */
  observerVersion: 'material-institution-era-v1' | 'material-institution-era-v2' | 'material-institution-era-v3' | 'material-institution-era-v4' | 'material-institution-era-v5' | 'material-institution-era-v6';
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

export interface SimulationState {
  schemaVersion: 17;
  seed: number;
  branchId: string;
  clock: { unit: 'month'; elapsedMonths: number; monthsPerYear: typeof MONTHS_PER_YEAR };
  world: {
    grid: VoxelWorld;
    drops: DropState[];
    animals: AnimalState[];
    /** Optional only for old schema-v17 states and compact test fixtures. */
    remains?: HumanRemainsState[];
    /** Physical memorial carriers created by completed mortuary acts. */
    memorials?: MemorialMarkerState[];
    past: WorldEvent[];
    /** Incremental traversal counts keyed by `cellId:z`. */
    traffic?: Record<string, number>;
    /** Optional on schema v17 for compatibility; new and restored states initialize v1 explicitly. */
    mechanicalPower?: MechanicalPowerWorldState;
    /**
     * Physical cache rebuilt from committed construction facts and voxels.
     * Optional because persisted schema-17 states and hand-built fixtures can
     * omit it; creation, state adoption and month commit reconstruct it.
     */
    physicalStructureIndex?: PhysicalStructureIndex;
  };
  people: PersonState[];
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
  schemaVersion: 17;
  exportedAt: string;
  civilization: SimulationState['civilization'];
  finalState: SimulationState;
  checkpoints: SimulationState[];
  review: { milestones: MilestoneObservation[]; eventCount: number };
}
