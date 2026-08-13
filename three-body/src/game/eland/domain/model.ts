import type { BiologicalSex } from '../population';
import { MONTHS_PER_YEAR } from './calendar';
import type { ComponentKind, StructureEffects } from './structure-policy';
import type { PixelWorld } from '../world/grid';

export type { ComponentKind, StructureEffects } from './structure-policy';

export type AgentId = string;
export type MatterKind = string;
export type MatterTrait =
  | 'raw'
  | 'edible'
  | 'rigid'
  | 'building'
  | 'fuel'
  | 'recordable'
  | 'crafted'
  | 'structure'
  | 'shelter'
  | 'botanical';
export type EpochKind = 'stable' | 'chaotic';
export type ClimateKind = 'temperate' | 'cold' | 'heat' | 'fire';
export type ClimateBias = 'balanced' | 'cold' | 'hot';
export type MaslowNeedLevel = 'physiological' | 'safety' | 'belonging' | 'esteem' | 'selfActualization';
export type PlanMode = 'explore' | 'travel' | 'gather' | 'carry' | 'build' | 'recover';
export type PlanStatus = 'active' | 'suspended' | 'completed' | 'blocked' | 'abandoned' | 'failed';

export interface SimulationConfig {
  civilizationNo: number;
  climateBias: ClimateBias;
  chaosIntensity: number;
  endpoint: { kind: 'months' | 'milestones'; value: number };
  characterIds?: string[];
}

export interface MaslowPersonalityLayer {
  level: MaslowNeedLevel;
  label: string;
  baselineWeight: number;
  evidence: string[];
}

export interface MaslowPersonality {
  dominantLevel: MaslowNeedLevel;
  summary: string;
  layers: MaslowPersonalityLayer[];
}

export interface NeedLayer {
  level: MaslowNeedLevel;
  label: string;
  intensity: number;
  activeNeeds: Array<{ kind: string; label: string; intensity: number; reason: string }>;
}

export interface MatterState {
  id: string;
  kind: MatterKind;
  name: string;
  holder:
    | { kind: 'cell'; cellId: number }
    | { kind: 'agent'; agentId: AgentId }
    | { kind: 'structure'; structureId: string; slot: string };
  quantity: number;
  unitMass: number;
  composition: Record<string, number>;
  traits: MatterTrait[];
  madeBy?: AgentId;
  sourceEventIds: string[];
}

export interface StructureComponent {
  id: string;
  structureId: string;
  kind: ComponentKind;
  cellId: number;
  materialKinds: string[];
  integrity: number;
  sourceEventIds: string[];
}

export interface StructureState {
  id: string;
  name?: string;
  builderIds: AgentId[];
  componentIds: string[];
  occupiedCells: number[];
  interiorCells: number[];
  effects: StructureEffects;
  useEventIds: string[];
  sourceEventIds: string[];
}

export type SpatialTarget =
  | { kind: 'cell'; cellId: number }
  | { kind: 'matter'; matterId: string; cellId: number }
  | { kind: 'structure'; structureId: string; cellId: number };

export interface AgentPlan {
  id: string;
  ownerId: AgentId;
  objective: string;
  mode: PlanMode;
  target: SpatialTarget;
  status: PlanStatus;
  createdAtMonth: number;
  lastProgressAtMonth: number;
  progress: number;
  workRemaining: number;
  requestedQuantity?: number;
  acquiredQuantity?: number;
  path: number[];
  pathCursor: number;
  sourceDecisionEventId: string;
  progressEventIds: string[];
  blockedReason?: string;
  structureId?: string;
}

export interface AgentState {
  id: AgentId;
  name: string;
  color: string;
  profile: { description: string; personality: MaslowPersonality };
  position: { cellId: number; previousCellId: number; lastPath: number[] };
  activePlanId?: string;
  suspendedPlanIds: string[];
  mind: {
    needs: { focus: string; intensity: number; dominantLevel: MaslowNeedLevel; layers: NeedLayer[] };
    cognition: {
      perception: string;
      choice: string;
      interpretation: string;
      knownCells: number[];
      rememberedTargets: Array<{ kind: string; id: string; cellId: number; sourceEventIds: string[]; lastSeenAtMonth: number }>;
      memory: Array<{ id: string; atMonth: number; summary: string; sourceEventIds: string[] }>;
    };
  };
  limbs: {
    actionText: string;
    abilities: { move: number; interact: number; craft: number; build: number; observe: number; reason: number };
  };
  relations: Array<{ agentId: AgentId; strength: number; word: string; sourceEventIds: string[] }>;
  lineage: { generation: number; motherId?: string; fatherId?: string };
  standing: { respect: number; correctPredictions: number; failedPredictions: number; careTrust: number };
  body: {
    state: 'active' | 'dehydrated' | 'dead';
    hydration: number;
    nutrition: number;
    health: number;
    fatigue: number;
    temperature: number;
    ageMonths: number;
    sex: BiologicalSex;
    lifespanMonths: number;
  };
}

export interface Affordance {
  id: string;
  planMode: PlanMode;
  target: SpatialTarget;
  requiredRange: 0 | 1;
  visibleReason: string;
  estimatedDurationBand: 'one-month' | 'several-months' | 'long' | 'unknown';
  sourceFactIds: string[];
}

export type PlanDecision =
  | { kind: 'start'; affordanceId?: string; exploration?: { direction: 'n' | 'e' | 's' | 'w'; distanceBand: 'near' | 'far' }; reason: string }
  | { kind: 'continue'; planId: string; reason: string }
  | { kind: 'revise'; planId: string; affordanceId: string; reason: string }
  | { kind: 'suspend'; planId: string; reason: string }
  | { kind: 'resume'; planId: string; reason: string }
  | { kind: 'abandon'; planId: string; reason: string }
  | { kind: 'idle'; reason: string };

export type Decision = PlanDecision;

export interface DecisionContext {
  state: SimulationState;
  agent: AgentState;
  visibleCells: number[];
  visibleAgents: AgentState[];
  visibleMatter: MatterState[];
  affordances: Affordance[];
  activePlan?: AgentPlan;
}

export interface TokenUsage { inputTokens: number; outputTokens: number }
export interface AgentDecider { decide(context: DecisionContext): Decision }
export interface BatchDecider {
  decideAll(contexts: DecisionContext[]): Promise<(Decision | null)[]>;
  takeUsage?(): TokenUsage;
}

export interface DecisionOpportunityFact {
  id: string;
  kind: 'decision-opportunity';
  atMonth: number;
  orderInMonth: number;
  who: AgentId;
  cellId: number;
  probability: number;
  sample: number;
  triggered: boolean;
  reasons: string[];
  result: string;
}

export interface DecisionFact {
  id: string;
  kind: 'decision';
  atMonth: number;
  orderInMonth: number;
  who: AgentId;
  cellId: number;
  decision: Decision;
  planId?: string;
  usedModel: boolean;
  result: string;
}

export interface PlanProgressFact {
  id: string;
  kind: 'plan-progress';
  atMonth: number;
  orderInMonth: number;
  who: AgentId;
  cellId: number;
  planId: string;
  fromCellId: number;
  toCellId: number;
  pathSegment: number[];
  status: 'progressed' | 'completed' | 'blocked' | 'failed';
  progressBefore: number;
  progressAfter: number;
  result: string;
  diff: Record<string, unknown>;
}

export interface EnvironmentFact {
  id: string;
  kind: 'environment';
  atMonth: number;
  orderInMonth: number;
  cellId: number;
  change: 'climate' | 'body' | 'death' | 'resource';
  result: string;
  diff: Record<string, unknown>;
}

export type WorldEvent = DecisionOpportunityFact | DecisionFact | PlanProgressFact | EnvironmentFact;

export interface PracticeObservation {
  key: string;
  label: string;
  count: number;
  agentIds: AgentId[];
  eventIds: string[];
  stability: number;
}

export interface InstitutionObservation { key: string; label: string; evidenceEventIds: string[]; note: string }
export interface MilestoneObservation { id: string; label: string; evidenceEventIds: string[]; note: string }

export interface EmergentRegion {
  id: string;
  kind: 'natural' | 'residential' | 'trail';
  cells: number[];
  confidence: number;
  evidenceEventIds: string[];
  firstObservedMonth: number;
  lastObservedMonth: number;
  label?: string;
}

export interface DecisionMonthLedger {
  atMonth: number;
  livingAgents: number;
  candidates: number;
  modelContexts: number;
  inputTokens: number;
  outputTokens: number;
  chargedTokens: number;
}

export interface SimulationState {
  schemaVersion: 11;
  seed: number;
  branchId: string;
  clock: { unit: 'month'; elapsedMonths: number; monthsPerYear: typeof MONTHS_PER_YEAR };
  world: {
    grid: PixelWorld;
    matter: MatterState[];
    structures: StructureState[];
    components: StructureComponent[];
    past: WorldEvent[];
  };
  agents: AgentState[];
  plans: AgentPlan[];
  civilization: {
    number: number;
    status: 'running' | 'ended';
    stage: string;
    epoch: EpochKind;
    climate: { kind: ClimateKind; severity: number; sinceMonth: number };
    externalClimate?: { epoch: EpochKind; kind: ClimateKind; severity: number };
    conditions: SimulationConfig;
    integrity: number;
    outcome?: { kind: 'destroyed' | 'boundary' | 'milestones'; cause: string; atMonth: number; summary: string };
  };
  decisionBudget: { credits: number; tokensPerContext: number; ledgers: DecisionMonthLedger[] };
  derived: {
    practices: PracticeObservation[];
    institutions: InstitutionObservation[];
    milestones: MilestoneObservation[];
    regions: EmergentRegion[];
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
  schemaVersion: 11;
  exportedAt: string;
  civilization: SimulationState['civilization'];
  finalState: SimulationState;
  checkpoints: SimulationState[];
  review: { milestones: MilestoneObservation[]; eventCount: number };
}
