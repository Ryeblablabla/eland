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

export * from './action';
export * from './material';
export * from './person';

export type EpochKind = 'stable' | 'chaotic';
export type ClimateKind = 'temperate' | 'cold' | 'heat' | 'fire';
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
}

export interface DecisionContext {
  state: SimulationState;
  person: PersonState;
  visibleCells: number[];
  visiblePeople: PersonState[];
  visibleDrops: DropState[];
  visibleAnimals: AnimalState[];
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

export interface DecisionFact extends BaseEvent {
  kind: 'decision';
  who: PersonId;
  decision: Decision;
  intentId?: string;
  usedModel: boolean;
  domain?: 'strategic' | 'social';
  result: string;
}

export interface ActionFact extends BaseEvent {
  kind: 'action';
  actionTick: number;
  who: PersonId;
  intentId?: string;
  cause: 'intent' | 'survival-reflex';
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
  change: 'expired' | 'fulfilled' | 'breached' | 'cancelled';
  partyIds: PersonId[];
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

export interface DerivedStructure {
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
  observerVersion: 'material-institution-era-v1';
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

export interface SimulationState {
  schemaVersion: 17;
  seed: number;
  branchId: string;
  clock: { unit: 'month'; elapsedMonths: number; monthsPerYear: typeof MONTHS_PER_YEAR };
  world: {
    grid: VoxelWorld;
    drops: DropState[];
    animals: AnimalState[];
    past: WorldEvent[];
    /** Incremental traversal counts keyed by `cellId:z`. */
    traffic?: Record<string, number>;
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
    externalClimate?: { epoch: EpochKind; kind: ClimateKind; severity: number };
    conditions: SimulationConfig;
    civilizationIndex: CivilizationIndex;
    /** Pure observer state. Planners and world rules must never read it. */
    development?: CivilizationDevelopmentObservation;
    outcome?: { kind: 'destroyed' | 'boundary' | 'milestones'; cause: string; atMonth: number; summary: string };
  };
  decisionBudget: { credits: number; tokensPerContext: number; ledgers: DecisionMonthLedger[] };
  derived: {
    practices: PracticeObservation[];
    institutions: InstitutionObservation[];
    milestones: MilestoneObservation[];
    regions: EmergentRegion[];
    structures: DerivedStructure[];
    functionalBuildings?: FunctionalBuildingObservation[];
  };
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
