import type { SimulationState } from '../src/game/eland/simulation';
import type { EvolutionPath, EvolutionReport } from './evolution-artifacts';
import type { NarrativeEnhancementArtifact } from './narrative-enhancements';

export interface RunSummary {
  schemaVersion: 1;
  id: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  elapsedMonths: number;
  civilizationNo: number;
  status: SimulationState['civilization']['status'];
  livingAgents: number;
  agentCount: number;
  eventCount: number;
  milestoneCount: number;
}

export interface PersistedRun {
  meta: RunSummary;
  state: SimulationState;
}

export interface SaveRunOptions {
  /** Append is the normal evolution path; replace is required for imported or rewritten history. */
  historyMode?: 'append' | 'replace';
  /** Both CAS fields must be supplied together when the caller has an explicit read basis. */
  expectedRevision?: number;
  expectedStateHash?: string;
}

/** Persistence capabilities required by the authoritative long-evolution use case. */
export interface EvolutionExecutionStore {
  load(id: string): Promise<PersistedRun>;
  save(
    id: string,
    state: SimulationState,
    label?: string,
    options?: SaveRunOptions,
  ): Promise<PersistedRun>;
  saveEvolutionPath(id: string, evolution: EvolutionPath): Promise<void>;
  saveEvolutionReport(id: string, report: EvolutionReport): Promise<void>;
}

/** Persistence capabilities exposed to the HTTP run adapter. */
export interface RunAccessStore {
  list(): Promise<RunSummary[]>;
  load(id: string): Promise<PersistedRun>;
  create(input: { id?: string; label?: string; state: SimulationState }): Promise<PersistedRun>;
  save(
    id: string,
    state: SimulationState,
    label?: string,
    options?: SaveRunOptions,
  ): Promise<PersistedRun>;
  loadEvolutionPath(id: string): Promise<EvolutionPath | null>;
  loadEvolutionReport(id: string): Promise<EvolutionReport | null>;
}

/** Persistence capabilities exposed to non-authoritative narrative enhancement. */
export interface NarrativeEnhancementStore {
  load(id: string): Promise<PersistedRun>;
  loadNarrativeEnhancements(id: string): Promise<NarrativeEnhancementArtifact | null>;
  saveNarrativeEnhancements(id: string, artifact: NarrativeEnhancementArtifact): Promise<void>;
}

export interface RunStore extends
  EvolutionExecutionStore,
  RunAccessStore,
  NarrativeEnhancementStore {
  dataDirectory(): string;
  filePath(): string;
  close(): void;
}

export class RunNotFoundError extends Error {}
export class RunAlreadyExistsError extends Error {}
export class RunWriteConflictError extends Error {}
