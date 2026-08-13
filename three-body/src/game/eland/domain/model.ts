import { MONTHS_PER_YEAR } from './calendar';
import type { ActionOption, Intent, IntentDecision, PrimitiveAction } from './action';
import type { MaterialId } from './material';
import type { PersonId, PersonState } from './person';
import type { VoxelWorld } from '../world/grid';
import type { Agreement } from './agreement';

export * from './action';
export * from './material';
export * from './person';

export type EpochKind = 'stable' | 'chaotic';
export type ClimateKind = 'temperate' | 'cold' | 'heat' | 'fire';
export type ClimateBias = 'balanced' | 'cold' | 'hot';

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
  quantity: number;
  createdAtMonth: number;
  sourceEventIds: string[];
}

export interface DecisionContext {
  state: SimulationState;
  person: PersonState;
  visibleCells: number[];
  visiblePeople: PersonState[];
  visibleDrops: DropState[];
  options: ActionOption[];
  followUpOptions: ActionOption[];
  activeIntent?: Intent;
}

export type Decision = IntentDecision;
export interface TokenUsage { inputTokens: number; outputTokens: number }
export interface AgentDecider { decide(context: DecisionContext): Decision }
export interface BatchDecider {
  decideAll(contexts: DecisionContext[]): Promise<(Decision | null)[]>;
  takeUsage?(): TokenUsage;
}

export interface BaseEvent {
  id: string;
  atMonth: number;
  orderInMonth: number;
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
  pathSegment: number[];
  status: 'progressed' | 'completed' | 'blocked' | 'failed';
  result: string;
  diff: Record<string, unknown>;
}

export interface EnvironmentFact extends BaseEvent {
  kind: 'environment';
  change: 'climate' | 'body' | 'condition' | 'death' | 'resource' | 'material';
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

export type WorldEvent = DecisionOpportunityFact | DecisionFact | ActionFact | EnvironmentFact | AgreementFact;

export interface PracticeObservation {
  key: string;
  label: string;
  count: number;
  agentIds: PersonId[];
  eventIds: string[];
  stability: number;
}

export interface InstitutionObservation { key: string; label: string; evidenceEventIds: string[]; note: string }
export interface MilestoneObservation { id: string; label: string; evidenceEventIds: string[]; note: string; observedAtMonth?: number }

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
  inputTokens: number;
  outputTokens: number;
  chargedTokens: number;
}

export interface SimulationState {
  schemaVersion: 14;
  seed: number;
  branchId: string;
  clock: { unit: 'month'; elapsedMonths: number; monthsPerYear: typeof MONTHS_PER_YEAR };
  world: { grid: VoxelWorld; drops: DropState[]; past: WorldEvent[] };
  people: PersonState[];
  intents: Intent[];
  agreements: Agreement[];
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
    structures: DerivedStructure[];
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
  schemaVersion: 14;
  exportedAt: string;
  civilization: SimulationState['civilization'];
  finalState: SimulationState;
  checkpoints: SimulationState[];
  review: { milestones: MilestoneObservation[]; eventCount: number };
}
