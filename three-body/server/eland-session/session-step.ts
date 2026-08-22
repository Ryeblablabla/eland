import { createHash } from 'node:crypto';

import {
  createDefaultSimulationConfig,
  createSimulation,
  MAX_SIMULATION_MONTHS,
  type SimulationController,
  type SimulationState,
} from '../../src/game/eland/simulation';
import { isAlive } from '../../src/game/eland/domain/person';
import { ERA_TO_ENV } from '../../src/game/eland/adapter';
import { projectLiveSpeechDrafts } from '../../src/game/eland/projection/live-speech';
import type {
  CosmosSnapshot,
  GameFrame,
  NarrativeEntryView,
  SkySample,
  SpeechLineView,
} from '../../src/game/societyContract';
import { summarizePlayerNarrativeEntries } from '../narrative-enhancements';
import {
  createServerLlmDecider,
  type PendingPlayerInteraction,
  type PlayerInteractionDecisionAttempt,
} from '../backend-decider';
import { realizeLiveSpeechLines, retainDecisionSpeechLines } from '../live-speech-service';
import { hasExplicitModelRoute, modelEndpointStatus, readEvolutionMode, readSummaryMode } from '../model-config';
import { realizeNewbornNames } from '../newborn-naming-service';
import { logPerf, perfElapsed, perfNow } from '../perf';
import { entriesFor } from './frame-history-projector';

const MAX_COMPLETED_STEP_RECEIPTS = 64;

export interface ElandStepOptions {
  skySample: SkySample;
  cosmosSnapshot?: CosmosSnapshot;
  /** Stable identity reused while the caller is uncertain whether this month committed. */
  stepId?: string;
  /** Opaque server authority instance observed with the rest of the expected identity. */
  expectedAuthorityRevision?: string;
  /** Civilization observed together with expectedBranchId and expectedElapsedMonths. */
  expectedCivilizationId?: number;
  /** Branch observed together with expectedCivilizationId and expectedElapsedMonths. */
  expectedBranchId?: string;
  /** Last authoritative month observed by the caller before requesting one new month. */
  expectedElapsedMonths?: number;
}

export class ElandStepConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElandStepConflictError';
  }
}

interface InFlightStep {
  baseAuthorityRevision: string;
  baseCivilizationId: number;
  baseBranchId: string;
  baseElapsedMonths: number;
  requests: Map<string, string>;
  promise: Promise<GameFrame | null>;
}

function stepRequestFingerprint(options: ElandStepOptions): string {
  return createHash('sha256').update(JSON.stringify({
    expectedAuthorityRevision: options.expectedAuthorityRevision,
    expectedCivilizationId: options.expectedCivilizationId,
    expectedBranchId: options.expectedBranchId,
    expectedElapsedMonths: options.expectedElapsedMonths,
    skySample: options.skySample,
    cosmosSnapshot: options.cosmosSnapshot,
  })).digest('hex');
}

export function createSessionBeginning(input: {
  civilizationId: number;
  worldSeed: number;
  skySample: SkySample;
  characterIds?: string[];
  cosmosSnapshot?: CosmosSnapshot;
}): {
  controller: SimulationController;
  state: SimulationState;
  cosmosSnapshot?: CosmosSnapshot;
} {
  const controller = createSimulation({
    seed: input.worldSeed,
    config: createDefaultSimulationConfig({
      civilizationNo: input.civilizationId,
      chaosIntensity: 0,
      endpoint: { kind: 'months', value: MAX_SIMULATION_MONTHS },
      ...(input.characterIds?.length ? { characterIds: input.characterIds } : {}),
    }),
  });
  const env = ERA_TO_ENV[input.skySample.fate];
  controller.setExternalClimate(env.epoch, env.kind, env.severity, env.terminalCatastrophe);
  return {
    controller,
    state: controller.ownedState(),
    ...(input.cosmosSnapshot
      ? { cosmosSnapshot: { ...input.cosmosSnapshot, civilizations: input.civilizationId } }
      : {}),
  };
}

interface SessionStepHost {
  runId: string;
  controller(): SimulationController | null;
  latest(): GameFrame | null;
  authority(): {
    revision: string;
    civilizationId: number;
    branchId: string;
    ended: boolean;
  };
  pendingPlayerInteractions(): PendingPlayerInteraction[];
  commitSky(skySample: SkySample, cosmosSnapshot?: CosmosSnapshot): void;
  record(
    state: SimulationState,
    entries: NarrativeEntryView[],
    speechLines: SpeechLineView[],
  ): GameFrame;
  settleInteractionDecisionAttempts(
    attempts: PlayerInteractionDecisionAttempt[],
    state: SimulationState,
  ): void;
  recordPerf(): { projectionMs: number; snapshotMs: number };
}

/** Coordinates one atomic authoritative month; it does not own simulation facts. */
export class SessionStepCoordinator {
  private stepping = false;
  private stepWaiters: Array<() => void> = [];
  private inFlightStep: InFlightStep | null = null;
  private readonly completedStepReceipts = new Map<string, string>();
  private lastNarrativeFallbackLogAt = 0;
  private lastNamingFallbackLogAt = 0;
  private lastSpeechFallbackLogAt = 0;

  constructor(private readonly host: SessionStepHost) {}

  isStepping(): boolean {
    return this.stepping;
  }

  resetAuthorityReceipts(): void {
    this.completedStepReceipts.clear();
  }

  async waitForSettle(): Promise<void> {
    while (this.stepping) {
      await new Promise<void>((resolve) => { this.stepWaiters.push(resolve); });
    }
  }

  private rememberCompletedStep(stepId: string | undefined, fingerprint: string | undefined): void {
    if (!stepId || !fingerprint) return;
    this.completedStepReceipts.delete(stepId);
    this.completedStepReceipts.set(stepId, fingerprint);
    while (this.completedStepReceipts.size > MAX_COMPLETED_STEP_RECEIPTS) {
      const oldest = this.completedStepReceipts.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.completedStepReceipts.delete(oldest);
    }
  }

  /** Advances at most one month for a caller-observed authority head. */
  async step(options: ElandStepOptions): Promise<GameFrame | null> {
    const stepId = options.stepId?.trim() || undefined;
    if (stepId && stepId.length > 160) throw new ElandStepConflictError('stepId 过长');
    if (options.expectedAuthorityRevision !== undefined
      && (!options.expectedAuthorityRevision.trim()
        || options.expectedAuthorityRevision !== options.expectedAuthorityRevision.trim()
        || options.expectedAuthorityRevision.length > 160)) {
      throw new ElandStepConflictError('expectedAuthorityRevision 无效');
    }
    if (options.expectedElapsedMonths !== undefined
      && (!Number.isInteger(options.expectedElapsedMonths) || options.expectedElapsedMonths < 0)) {
      throw new ElandStepConflictError('expectedElapsedMonths 必须是非负整数');
    }
    if (options.expectedCivilizationId !== undefined
      && (!Number.isInteger(options.expectedCivilizationId) || options.expectedCivilizationId < 1)) {
      throw new ElandStepConflictError('expectedCivilizationId 必须是正整数');
    }
    if (options.expectedBranchId !== undefined
      && (!options.expectedBranchId.trim()
        || options.expectedBranchId !== options.expectedBranchId.trim()
        || options.expectedBranchId.length > 320)) {
      throw new ElandStepConflictError('expectedBranchId 无效');
    }
    if (stepId && (options.expectedAuthorityRevision === undefined
      || options.expectedCivilizationId === undefined
      || options.expectedBranchId === undefined
      || options.expectedElapsedMonths === undefined)) {
      throw new ElandStepConflictError('带 stepId 的请求必须提供完整权威身份');
    }
    const fingerprint = stepId ? stepRequestFingerprint(options) : undefined;
    const completedFingerprint = stepId ? this.completedStepReceipts.get(stepId) : undefined;
    if (completedFingerprint) {
      if (completedFingerprint !== fingerprint) {
        throw new ElandStepConflictError('stepId 已用于不同的月份或天象');
      }
      return this.host.latest();
    }

    const active = this.inFlightStep;
    if (active) {
      if (stepId) {
        const activeFingerprint = active.requests.get(stepId);
        if (activeFingerprint && activeFingerprint !== fingerprint) {
          throw new ElandStepConflictError('stepId 正在用于不同的月份或天象');
        }
      }
      const matchesActiveAuthority = (options.expectedAuthorityRevision === undefined
          || options.expectedAuthorityRevision === active.baseAuthorityRevision)
        && (options.expectedCivilizationId === undefined
          || options.expectedCivilizationId === active.baseCivilizationId)
        && (options.expectedBranchId === undefined
          || options.expectedBranchId === active.baseBranchId)
        && (options.expectedElapsedMonths === undefined
          || options.expectedElapsedMonths === active.baseElapsedMonths);
      if (matchesActiveAuthority) {
        if (stepId && fingerprint) active.requests.set(stepId, fingerprint);
        const frame = await active.promise;
        this.rememberCompletedStep(stepId, fingerprint);
        return frame;
      }
      await active.promise;
      return this.step(options);
    }

    const current = this.host.latest();
    if (!this.host.controller()) return current;
    const authority = this.host.authority();
    const matchesCurrentAuthority = (options.expectedAuthorityRevision === undefined
        || options.expectedAuthorityRevision === current?.authorityRevision)
      && (options.expectedCivilizationId === undefined
        || options.expectedCivilizationId === current?.civilizationId)
      && (options.expectedBranchId === undefined
        || options.expectedBranchId === current?.branchId)
      && (options.expectedElapsedMonths === undefined
        || options.expectedElapsedMonths === current?.elapsedMonths);
    if (!matchesCurrentAuthority) {
      this.rememberCompletedStep(stepId, fingerprint);
      return current;
    }
    if (authority.ended) {
      this.rememberCompletedStep(stepId, fingerprint);
      return current;
    }

    const requests = new Map<string, string>();
    if (stepId && fingerprint) requests.set(stepId, fingerprint);
    const promise = this.advanceStep(options);
    const inFlight: InFlightStep = {
      baseAuthorityRevision: current?.authorityRevision ?? authority.revision,
      baseCivilizationId: current?.civilizationId ?? authority.civilizationId,
      baseBranchId: current?.branchId ?? authority.branchId,
      baseElapsedMonths: current?.elapsedMonths ?? 0,
      requests,
      promise,
    };
    this.inFlightStep = inFlight;
    try {
      const frame = await promise;
      for (const [requestId, requestFingerprint] of inFlight.requests) {
        this.rememberCompletedStep(requestId, requestFingerprint);
      }
      return frame;
    } finally {
      if (this.inFlightStep === inFlight) this.inFlightStep = null;
    }
  }

  private async advanceStep(options: ElandStepOptions): Promise<GameFrame | null> {
    const controller = this.host.controller();
    if (!controller) return this.host.latest();
    this.stepping = true;
    const stepStartedAt = perfNow();
    try {
      const nextSkySample = options.skySample;
      const nextCosmosSnapshot = options.cosmosSnapshot;
      const env = ERA_TO_ENV[nextSkySample.fate];
      const externalClimate = {
        epoch: env.epoch,
        kind: env.kind,
        severity: env.severity,
        ...(env.terminalCatastrophe ? { terminalCatastrophe: env.terminalCatastrophe } : {}),
      };
      const modelEvolutionEnabled = readEvolutionMode() === 'model';
      const decisionEndpoint = modelEvolutionEnabled && hasExplicitModelRoute('decision')
        ? modelEndpointStatus('decision')
        : { configured: false };
      const namingEndpoint = modelEvolutionEnabled
        && (hasExplicitModelRoute('naming') || hasExplicitModelRoute('decision'))
        ? modelEndpointStatus('naming')
        : { configured: false };
      const decisionEndpointId = decisionEndpoint.configured ? decisionEndpoint.endpointId : undefined;
      const interactions = this.host.pendingPlayerInteractions();
      let state: SimulationState;
      const simulationStartedAt = perfNow();
      let interactionAttempts: PlayerInteractionDecisionAttempt[] = [];
      if (decisionEndpointId || interactions.length) {
        const decider = createServerLlmDecider(decisionEndpointId, {
          interactions,
          pendingOnly: !decisionEndpoint.configured,
        });
        try {
          state = await controller.stepAsyncOwnedWithClimate(decider, externalClimate);
          interactionAttempts = decider.takeInteractionAttempts();
        } catch (error) {
          interactionAttempts = decider.takeInteractionAttempts();
          console.warn(`运行 ${this.host.runId} 的关键模型决策已回退到本地规划：${error instanceof Error ? error.message : String(error)}`);
          controller.setExternalClimate(env.epoch, env.kind, env.severity, env.terminalCatastrophe);
          state = controller.stepOwned();
        }
      } else {
        controller.setExternalClimate(env.epoch, env.kind, env.severity, env.terminalCatastrophe);
        state = controller.stepOwned();
      }
      const simulationMs = perfElapsed(simulationStartedAt);
      const presentationStartedAt = perfNow();
      if (namingEndpoint.configured && namingEndpoint.endpointId) {
        const naming = await realizeNewbornNames(state, state.lastStep, namingEndpoint.endpointId);
        if (naming.generationErrors.length || naming.rejectedChildIds.length) {
          const now = Date.now();
          if (now - this.lastNamingFallbackLogAt >= 60_000) {
            this.lastNamingFallbackLogAt = now;
            const detail = naming.generationErrors[0]
              ?? `${naming.rejectedChildIds.length} 个候选未通过本地姓名规则`;
            console.warn(`运行 ${this.host.runId} 的后代取名已保留本地姓名：${detail}`);
          }
        }
      }
      const speechDrafts = projectLiveSpeechDrafts(state, state.lastStep);
      const retainedDecisionLines = retainDecisionSpeechLines(speechDrafts);
      const speechPromise = decisionEndpoint.configured && decisionEndpoint.endpointId && speechDrafts.length > 0
        ? realizeLiveSpeechLines(state, state.lastStep, speechDrafts, decisionEndpoint.endpointId)
        : Promise.resolve({ lines: retainedDecisionLines, generationErrors: [] });
      const ruleEntries = entriesFor(state, state.lastStep);
      let entries = ruleEntries;
      if (readSummaryMode() === 'model' && state.civilization.status !== 'ended') {
        try {
          entries = await summarizePlayerNarrativeEntries(state, ruleEntries);
        } catch (error) {
          const now = Date.now();
          if (now - this.lastNarrativeFallbackLogAt >= 60_000) {
            this.lastNarrativeFallbackLogAt = now;
            console.warn(`运行 ${this.host.runId} 的即时叙事已回退到规则文本：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      let speechLines = retainedDecisionLines;
      try {
        const speech = await speechPromise;
        speechLines = speech.lines;
        if (speech.generationErrors.length) {
          const now = Date.now();
          if (now - this.lastSpeechFallbackLogAt >= 60_000) {
            this.lastSpeechFallbackLogAt = now;
            console.warn(`运行 ${this.host.runId} 的 ${speech.generationErrors.length} 批即时台词未生成文字气泡：${speech.generationErrors[0]}`);
          }
        }
      } catch (error) {
        const now = Date.now();
        if (now - this.lastSpeechFallbackLogAt >= 60_000) {
          this.lastSpeechFallbackLogAt = now;
          console.warn(`运行 ${this.host.runId} 的即时台词未生成文字气泡：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      this.host.commitSky(nextSkySample, nextCosmosSnapshot);
      const frame = this.host.record(state, entries, speechLines);
      this.host.settleInteractionDecisionAttempts(interactionAttempts, state);
      const recordPerf = this.host.recordPerf();
      logPerf('live-step', {
        runId: this.host.runId,
        branchId: frame.branchId,
        month: frame.elapsedMonths,
        people: state.people.length,
        livingPeople: state.people.filter(isAlive).length,
        eventsThisMonth: state.lastStep.length,
        totalEvents: state.world.past.length,
        simulationMs,
        presentationMs: perfElapsed(presentationStartedAt),
        projectionMs: recordPerf.projectionMs,
        snapshotMs: recordPerf.snapshotMs,
        totalMs: perfElapsed(stepStartedAt),
      });
      return frame;
    } finally {
      this.stepping = false;
      const waiters = this.stepWaiters;
      this.stepWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}
