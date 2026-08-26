/** ELAND 应用会话：编排月度用例、读取投影与可回溯快照。 */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  buildDecisionContextForPerson,
  createSimulationFromOwnedState,
  RulePlanner,
  type Decision,
  type SimulationController,
  type SimulationState,
  type WorldEvent,
} from '../src/game/eland/simulation';
import { concludeOwnedCivilization } from '../src/game/eland/application/civilization-settlement';
import { calendarDate } from '../src/game/eland/domain/calendar';
import { isAlive, type PersonId } from '../src/game/eland/domain/person';
import {
  civilizationRequiemKey,
  type CivilizationRequiem,
} from '../src/game/civilizationRequiem';
import {
  ERA_TO_ENV,
  toAgentHistory,
  toSocietyState,
  type WorldEventLookup,
} from '../src/game/eland/adapter';
import { prepareMonth } from '../src/game/eland/application/simulation/month-boundary';
import { createMonthExecution } from '../src/game/eland/application/simulation/month-execution';
import { copyState } from '../src/game/eland/application/simulation/state-utils';
import { simulationObservationProjector } from '../src/game/eland/projection/simulation-observation-projector';
import {
  validatePlayerInteractionChoice,
} from '../src/game/eland/application/player-interaction-choice';
import type {
  CivilizationIndexHistoryPoint,
  CosmosSnapshot,
  GameFrame,
  SkySample,
  SpeechLineView,
} from '../src/game/societyContract';
import type { AgentHistoryView } from '../src/game/societyContract';
import type {
  BeginEmbodimentRequest,
  EmbodimentReleaseResponse,
  EmbodimentStepRequest,
  EmbodimentStepResponse,
  EmbodimentView,
  ReleaseEmbodimentRequest,
} from '../src/game/embodimentContract';
import {
  type PendingPlayerInteraction,
  type PlayerInteractionDecisionAttempt,
} from './backend-decider';
import {
  requestAgentInteraction,
  type AgentInteractionRequestKind,
} from './agent-interaction-gateway';
import { hasExplicitModelRoute, modelEndpointStatus, readEvolutionMode } from './model-config';
import { perfElapsed, perfNow } from './perf';
import {
  generateCivilizationRequiem,
  requiemFactsFromState,
} from './civilization-requiem-service';
import type { SessionTimelineChunkResolver } from './session-snapshot-codec';
import {
  AgentConversationConflictError,
  conversationChoiceBlockedDetail,
  conversationFingerprint,
  conversationRequestKey,
  inheritedConversationTurns,
  localConversationTurns,
  projectConversationTurnOutcome,
  type AgentConversationInfluenceStatus,
  type AgentConversationTurn,
  type AgentConversationView,
} from './eland-session/conversation-coordinator';
import {
  activeTimeline,
  baselineFor,
  checkpoint,
  createBranchTimeline,
  deltaBetween,
  findStoredFrame,
  inheritedFrames,
  inheritedSnapshot,
  pruneSnapshots,
  type BranchTimeline,
  type SnapshotBaseline,
  type StoredFrame,
} from './eland-session/timeline';
import {
  entriesFor,
  projectChronicleFromProjection,
  foundingEventsFor,
  projectCivilizationIndexHistory,
  projectFrame,
  storeFrame,
  type FrameEntry,
} from './eland-session/frame-history-projector';
import {
  advanceChronicleProjection,
  createChronicleProjectionState,
  pruneChronicleProjection,
  rebuildChronicleProjection,
  type ChronicleProjectionState,
} from './eland-session/chronicle-projection';
import {
  createRecoverySnapshot,
  normalizeRecoveredBranches,
  validateRecoverySnapshot,
  type ElandSessionRecoverySnapshot,
  type CompletedEmbodimentSnapshot,
  type FrozenEmbodimentDecision,
} from './eland-session/recovery';
import {
  EmbodimentCommandRejectedError,
  EmbodimentConflictError,
  EmbodimentCoordinator,
  embodimentCommandFingerprint,
  embodimentReleaseFingerprint,
  type EmbodimentCoordinatorHost,
} from './eland-session/embodiment-coordinator';
import {
  DEFAULT_ACTIVE_STEP_PROTECTION_MS,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_SESSION_RECOVERY_TTL_MS,
  DEFAULT_SESSION_TTL_MS,
  ElandSessionBusyError,
  ElandSessionManagerCore,
  type ElandSessionManagerOptions,
} from './eland-session/session-manager';
import {
  createSessionBeginning,
  ElandStepConflictError,
  SessionStepCoordinator,
  type ElandStepOptions,
} from './eland-session/session-step';

export type { FrameEntry } from './eland-session/frame-history-projector';
export type {
  AgentConversationInfluenceStatus,
  AgentConversationTurn,
  AgentConversationView,
} from './eland-session/conversation-coordinator';
export { AgentConversationConflictError } from './eland-session/conversation-coordinator';
export {
  EmbodimentCommandRejectedError,
  EmbodimentConflictError,
  stagedExecutionHashForRecoveryVersion,
} from './eland-session/embodiment-coordinator';
export type { ElandSessionRecoverySnapshot } from './eland-session/recovery';
export {
  ElandSessionBusyError,
  ElandSessionCapacityError,
} from './eland-session/session-manager';
export { ElandStepConflictError } from './eland-session/session-step';
export type { ElandStepOptions } from './eland-session/session-step';

export type Frame = GameFrame;

const MAX_HISTORY_MONTHS = 2_400;
const SNAPSHOT_CHECKPOINT_INTERVAL = 12;

function createAuthorityRevision(): string {
  return `authority-${randomUUID()}`;
}

interface AgentConversationRequest {
  agentId: string;
  message: string;
  requestKind: AgentInteractionRequestKind;
  clientMessageId: string;
  observedBranchId?: string;
}

interface AgentConversationResult {
  conversation: AgentConversationView;
  turn: AgentConversationTurn;
}

interface PendingAgentConversation {
  fingerprint: string;
  promise: Promise<AgentConversationResult>;
}

interface QueuedAgentConversationRequest {
  agentId: string;
  message: string;
  requestKind: AgentInteractionRequestKind;
  clientMessageId: string;
  sourceBranchId: string;
  fingerprint: string;
}

function compactRecoveredFrameIntents(frame: Frame, state: SimulationState): Frame {
  const activeIntentIds = new Set(state.intents
    .filter((intent) => intent.status === 'active')
    .map((intent) => intent.id));
  const intents = frame.society.intents.filter((intent) => activeIntentIds.has(intent.id));
  const agents = frame.society.agents.map((agent) => {
    if (!agent.activeIntentId || activeIntentIds.has(agent.activeIntentId)) return agent;
    const { activeIntentId: _staleActiveIntentId, ...rest } = agent;
    return rest;
  });
  if (intents.length === frame.society.intents.length
    && agents.every((agent, index) => agent === frame.society.agents[index])) return frame;
  return {
    ...frame,
    society: {
      ...frame.society,
      agents,
      intents,
    },
  };
}

export class ElandSession {
  private civilizationId = 0;
  private controller: SimulationController | null = null;
  private latestState: SimulationState | null = null;
  private latestFrame: Frame | null = null;
  private readonly stepCoordinator: SessionStepCoordinator;
  private embodimentCoordinator: EmbodimentCoordinator | null = null;
  private completedEmbodiments: CompletedEmbodimentSnapshot[] = [];
  private interactionRequestCount = 0;
  private readonly agentConversationTails = new Map<string, Promise<void>>();
  private readonly pendingAgentConversations = new Map<string, PendingAgentConversation>();
  private readonly requiems = new Map<string, CivilizationRequiem>();
  private readonly pendingRequiems = new Map<string, Promise<CivilizationRequiem>>();
  private snapshotBaseline: SnapshotBaseline | null = null;
  private lastRecordPerf = { projectionMs: 0, snapshotMs: 0 };
  private branches = new Map<string, BranchTimeline>();
  private replayCache: { branchId: string; month: number; state: SimulationState } | null = null;
  private eventById = new Map<string, WorldEvent>();
  private chronicleProjections = new Map<string, ChronicleProjectionState>();
  private activeBranchId = '';
  private forkSequence = 0;
  private authorityRevision = createAuthorityRevision();
  private skySample: SkySample;
  private cosmosSnapshot?: CosmosSnapshot;
  readonly runId: string;

  constructor(
    runId: string,
    initialSkySample: SkySample,
    private readonly timelineChunkResolver?: SessionTimelineChunkResolver,
  ) {
    this.runId = runId;
    this.skySample = initialSkySample;
    this.stepCoordinator = new SessionStepCoordinator({
      runId,
      controller: () => this.controller,
      latest: () => this.latest(),
      authority: () => ({
        revision: this.authorityRevision,
        civilizationId: this.civilizationId,
        branchId: this.activeBranchId,
        ended: this.latestState?.civilization.status === 'ended',
      }),
      pendingPlayerInteractions: () => this.pendingPlayerInteractions(),
      projectEntries: (state, events) => this.narrativeEntriesFor(state, events),
      commitSky: (skySample, cosmosSnapshot) => {
        this.skySample = skySample;
        this.cosmosSnapshot = cosmosSnapshot
          ? { ...cosmosSnapshot, civilizations: this.civilizationId }
          : undefined;
      },
      record: (state, entries, speechLines) => this.record(
        state,
        state.lastStep,
        entries,
        speechLines,
      ),
      settleInteractionDecisionAttempts: (attempts, state) => {
        this.settleInteractionDecisionAttempts(attempts, state);
      },
      recordPerf: () => this.lastRecordPerf,
    });
  }

  private replaceEventIndex(state: SimulationState): void {
    this.eventById = new Map(state.world.past.map((event) => [event.id, event]));
  }

  private indexEvents(events: WorldEvent[]): void {
    for (const event of events) this.eventById.set(event.id, event);
  }

  private eventLookupWith(events: WorldEvent[]): WorldEventLookup {
    const current = new Map(events.map((event) => [event.id, event]));
    return { get: (eventId: string) => current.get(eventId) ?? this.eventById.get(eventId) };
  }

  private narrativeEntriesFor(state: SimulationState, events: WorldEvent[]): FrameEntry[] {
    return entriesFor(state, events, this.eventLookupWith(events));
  }

  private chronicleProjectionFor(timeline: BranchTimeline): ChronicleProjectionState {
    const existing = this.chronicleProjections.get(timeline.id);
    if (existing) return existing;
    const rebuilt = this.latestState
      ? rebuildChronicleProjection(this.inheritedFrames(timeline), this.eventById)
      : createChronicleProjectionState();
    this.chronicleProjections.set(timeline.id, rebuilt);
    return rebuilt;
  }

  private rotateAuthorityRevision(): string {
    this.authorityRevision = createAuthorityRevision();
    this.stepCoordinator.resetAuthorityReceipts();
    return this.authorityRevision;
  }

  private embodimentHost(): EmbodimentCoordinatorHost {
    return {
      authority: () => ({
        revision: this.authorityRevision,
        civilizationId: this.civilizationId,
        branchId: this.activeBranchId,
        elapsedMonths: this.latestState?.clock.elapsedMonths ?? 0,
        ended: this.latestState?.civilization.status === 'ended',
      }),
      committedState: () => this.latestState,
      prepareExecution: ({
        state,
        actorId,
        skySample,
        frozenInitialDecisions,
      }) => {
        const working = copyState(state);
        const climate = ERA_TO_ENV[skySample.fate];
        working.civilization.externalClimate = {
          epoch: climate.epoch,
          kind: climate.kind,
          severity: Math.max(1, Math.min(10, climate.severity)),
          ...(climate.terminalCatastrophe
            ? { terminalCatastrophe: climate.terminalCatastrophe }
            : {}),
        };
        const prepared = prepareMonth(working, false, true);
        const decisions = new Map<PersonId, { decision: Decision; usedModel: boolean }>();
        const frozen: FrozenEmbodimentDecision[] = [];
        if (frozenInitialDecisions) {
          for (const item of frozenInitialDecisions) {
            decisions.set(item.personId as PersonId, {
              decision: structuredClone(item.decision),
              usedModel: item.usedModel,
            });
            frozen.push(structuredClone(item));
          }
        } else {
          const planner = new RulePlanner();
          for (const context of prepared.candidates) {
            if (context.person.id === actorId) continue;
            const decision = planner.decideAt(context, {
              atMonth: prepared.atMonth,
              planningTick: 1,
            });
            decisions.set(context.person.id, { decision, usedModel: false });
            frozen.push({ personId: context.person.id, decision, usedModel: false });
          }
        }
        return {
          execution: createMonthExecution({
            observationProjector: simulationObservationProjector,
            prepared,
            decisions,
            usage: { inputTokens: 0, outputTokens: 0 },
            attempted: { total: 0, ordinary: 0, exempt: 0 },
            controlledPersonId: actorId as PersonId,
            projectionCadence: 'monthly',
          }),
          frozenInitialDecisions: frozen,
        };
      },
      commitMonth: ({ state, skySample, cosmosSnapshot }) => {
        if (!this.controller) throw new EmbodimentConflictError('当前没有可提交的文明');
        this.skySample = skySample;
        this.cosmosSnapshot = cosmosSnapshot
          ? { ...cosmosSnapshot, civilizations: this.civilizationId }
          : undefined;
        const owned = this.controller.adoptOwnedState(state);
        return this.record(owned, owned.lastStep, this.narrativeEntriesFor(owned, owned.lastStep));
      },
    };
  }

  private rememberCompletedEmbodiment(completed: CompletedEmbodimentSnapshot): void {
    this.completedEmbodiments = [
      ...this.completedEmbodiments.filter((candidate) => candidate.id !== completed.id),
      structuredClone(completed),
    ].slice(-64);
  }

  static restore(
    snapshot: ElandSessionRecoverySnapshot,
    runId = snapshot.runId,
    timelineChunkResolver?: SessionTimelineChunkResolver,
  ): ElandSession {
    const {
      state,
      cosmosSnapshot,
      activeEmbodiment,
      completedEmbodiments,
    } = validateRecoverySnapshot(snapshot);
    // Legacy active-embodiment hashes were calculated before controller
    // adoption refreshed observer fields or synthesized newer compatibility
    // state. Keep their exact persisted replay basis until the staged month is
    // verified and migrated to the current hash payload.
    const legacyEmbodimentState = activeEmbodiment?.stagedStateHashVersion === undefined
      ? structuredClone(state)
      : undefined;
    const session = new ElandSession(runId, snapshot.skySample, timelineChunkResolver);
    session.civilizationId = snapshot.civilizationId;
    session.controller = createSimulationFromOwnedState(state);
    session.latestState = session.controller.ownedState();
    session.replaceEventIndex(session.latestState);
    // latestFrame is the committed observer result for this exact month. The
    // controller may refresh annual derived state while hydrating, but recovery
    // must not silently rewrite an already shown/replayable frame.
    session.latestFrame = compactRecoveredFrameIntents({
      ...snapshot.latestFrame,
      runId,
      authorityRevision: session.authorityRevision,
      ...(cosmosSnapshot ? { cosmosSnapshot } : {}),
    }, session.latestState);
    session.branches = normalizeRecoveredBranches(snapshot.branches, runId, session.authorityRevision);
    session.activeBranchId = snapshot.activeBranchId;
    session.chronicleProjections.clear();
    session.forkSequence = snapshot.forkSequence;
    session.cosmosSnapshot = cosmosSnapshot;
    for (const requiem of snapshot.requiems ?? []) {
      if (requiem.schemaVersion === 4) session.requiems.set(requiem.id, requiem);
    }
    const restoredTimeline = session.branches.get(session.activeBranchId);
    if (!restoredTimeline) throw new Error('实时演化会话缺少活动分支');
    // Legacy schema-17 snapshots could contain a present but incomplete head
    // delta. New snapshots carry an explicit completeness marker, so only old
    // or actually missing heads pay the one-time checkpoint repair cost.
    if (snapshot.timelineHeadComplete !== true
      || !restoredTimeline.snapshots.has(session.latestFrame.elapsedMonths)) {
      restoredTimeline.snapshots.set(session.latestFrame.elapsedMonths, checkpoint(state));
    }
    session.snapshotBaseline = baselineFor(session.latestState);
    session.completedEmbodiments = structuredClone(completedEmbodiments);
    if (activeEmbodiment) {
      session.embodimentCoordinator = EmbodimentCoordinator.restore(
        session.embodimentHost(),
        activeEmbodiment,
        legacyEmbodimentState,
      );
    }
    return session;
  }

  recoverySnapshot(savedAt = Date.now()): ElandSessionRecoverySnapshot | null {
    if (!this.latestState || !this.latestFrame || !this.controller) return null;
    return createRecoverySnapshot({
      savedAt,
      runId: this.runId,
      civilizationId: this.civilizationId,
      latestState: this.latestState,
      latestFrame: this.latestFrame,
      branches: this.branches,
      activeBranchId: this.activeBranchId,
      forkSequence: this.forkSequence,
      skySample: this.skySample,
      ...(this.cosmosSnapshot ? { cosmosSnapshot: this.cosmosSnapshot } : {}),
      requiems: [...this.requiems.values()],
      ...(this.embodimentCoordinator && !this.embodimentCoordinator.isComplete()
        ? { activeEmbodiment: this.embodimentCoordinator.snapshot() }
        : {}),
      ...(this.completedEmbodiments.length
        ? { completedEmbodiments: this.completedEmbodiments }
        : {}),
    });
  }

  begin(civilizationId: number, worldSeed: number, skySample: SkySample, characterIds?: string[], cosmosSnapshot?: CosmosSnapshot): Frame {
    this.rotateAuthorityRevision();
    this.embodimentCoordinator = null;
    this.completedEmbodiments = [];
    this.civilizationId = civilizationId;
    this.skySample = skySample;
    const beginning = createSessionBeginning({
      civilizationId,
      worldSeed,
      skySample,
      ...(characterIds?.length ? { characterIds } : {}),
      ...(cosmosSnapshot ? { cosmosSnapshot } : {}),
    });
    this.controller = beginning.controller;
    this.cosmosSnapshot = beginning.cosmosSnapshot;
    const state = beginning.state;
    this.activeBranchId = state.branchId;
    this.branches = new Map([[state.branchId, createBranchTimeline(state.branchId, 0)]]);
    this.replaceEventIndex(state);
    this.chronicleProjections = new Map([[state.branchId, createChronicleProjectionState()]]);
    this.requiems.clear();
    this.pendingRequiems.clear();
    this.forkSequence = 0;
    const foundingEvents = foundingEventsFor(state);
    return this.record(state, foundingEvents, this.narrativeEntriesFor(state, foundingEvents));
  }

  model(): string {
    if (readEvolutionMode() !== 'model' || !hasExplicitModelRoute('decision')) return 'local';
    const endpoint = modelEndpointStatus('decision');
    return endpoint.configured && endpoint.endpointId ? endpoint.endpointId : 'local';
  }

  private activeTimeline(): BranchTimeline {
    return activeTimeline(this.branches, this.activeBranchId);
  }

  private inheritedFrames(timeline: BranchTimeline): StoredFrame[] {
    return inheritedFrames(this.branches, timeline);
  }

  private localConversationTurns(timeline = this.activeTimeline()): AgentConversationTurn[] {
    return localConversationTurns(timeline);
  }

  private inheritedConversationTurns(timeline: BranchTimeline): AgentConversationTurn[] {
    return inheritedConversationTurns(this.branches, timeline);
  }

  private pendingPlayerInteractions(): PendingPlayerInteraction[] {
    const latestByAgent = new Map<string, AgentConversationTurn>();
    for (const turn of this.localConversationTurns()) {
      if (turn.influenceStatus === 'pending' && !turn.choice) {
        turn.influenceStatus = 'blocked';
        turn.influenceOutcome = {
          atMonth: this.latestState?.clock.elapsedMonths ?? turn.completedAtMonth,
          summary: '这句话没有形成一个具体的下一步',
          detail: '这是旧版对话留下的自由文本建议；请在当前时间线里重新和我说一次。',
        };
        continue;
      }
      if ((turn.influenceStatus === 'queued'
        || turn.influenceStatus === 'deferred'
        || turn.influenceStatus === 'pending')
        && turn.choice
        && (turn.stance === 'accept' || turn.stance === 'consider')) {
        const person = this.latestState?.people.find((candidate) => candidate.id === turn.agentId);
        if (!person || !isAlive(person)) {
          turn.influenceStatus = 'stale';
          turn.influenceOutcome = {
            atMonth: this.latestState?.clock.elapsedMonths ?? turn.completedAtMonth,
            summary: '这个决定已经无法继续',
            detail: '人物已经死亡，原来的下一步不会再执行。',
          };
          continue;
        }
        latestByAgent.set(turn.agentId, turn);
      }
    }
    return [...latestByAgent.values()].map((turn) => ({
      id: turn.id,
      agentId: turn.agentId,
      sourceMonth: turn.requestedAtMonth,
      playerMessage: turn.userMessage,
      stance: turn.stance as 'accept' | 'consider',
      ...(turn.guidance ? { guidance: turn.guidance } : {}),
      choice: turn.choice!,
    }));
  }

  private inheritedSnapshot(timeline: BranchTimeline, month: number): SimulationState | undefined {
    return inheritedSnapshot(this.branches, timeline, month, this.timelineChunkResolver);
  }

  /** Keep at most one reconstructed historical state for adjacent read APIs. */
  private snapshotForRead(timeline: BranchTimeline, month: number): SimulationState | undefined {
    if (!this.stepCoordinator.isStepping()
      && timeline.id === this.activeBranchId
      && this.latestState?.clock.elapsedMonths === month) {
      this.replayCache = null;
      return this.latestState;
    }
    if (this.replayCache?.branchId === timeline.id && this.replayCache.month === month) {
      return this.replayCache.state;
    }
    const state = this.inheritedSnapshot(timeline, month);
    this.replayCache = state ? { branchId: timeline.id, month, state } : null;
    return state;
  }

  /** Transfer an internal replay state into a new authoritative branch. */
  private takeSnapshotForFork(timeline: BranchTimeline, month: number): SimulationState | undefined {
    if (timeline.id === this.activeBranchId && this.latestState?.clock.elapsedMonths === month) {
      this.replayCache = null;
      return this.latestState;
    }
    if (this.replayCache?.branchId === timeline.id && this.replayCache.month === month) {
      const state = this.replayCache.state;
      this.replayCache = null;
      return state;
    }
    this.replayCache = null;
    return this.inheritedSnapshot(timeline, month);
  }

  private pruneSnapshots(timeline: BranchTimeline): void {
    pruneSnapshots(timeline);
  }

  private record(
    state: SimulationState,
    events: WorldEvent[],
    entries = events.length ? this.narrativeEntriesFor(state, events) : [],
    speechLines: SpeechLineView[] = [],
  ): Frame {
    const projectionStartedAt = perfNow();
    const timeline = this.activeTimeline();
    const chronicleProjection = this.chronicleProjectionFor(timeline);
    this.indexEvents(events);
    const rawFrame = projectFrame({
      runId: this.runId,
      authorityRevision: this.authorityRevision,
      civilizationId: this.civilizationId,
      state,
      events,
      entries,
      speechLines,
      skySample: this.skySample,
      ...(this.cosmosSnapshot ? { cosmosSnapshot: this.cosmosSnapshot } : {}),
    });
    const frame = {
      ...rawFrame,
      entries: advanceChronicleProjection(
        chronicleProjection,
        rawFrame.elapsedMonths,
        rawFrame.entries,
        this.eventById,
      ),
    };
    const projectionMs = perfElapsed(projectionStartedAt);
    const storedFrame = storeFrame(frame);
    timeline.history.push(storedFrame);
    timeline.frameByMonth.set(frame.elapsedMonths, storedFrame);
    const shouldCheckpoint = this.latestState === null
      || timeline.history.length === 1
      || frame.elapsedMonths % SNAPSHOT_CHECKPOINT_INTERVAL === 0;
    const snapshotStartedAt = perfNow();
    timeline.snapshots.set(
      frame.elapsedMonths,
      shouldCheckpoint || !this.snapshotBaseline ? checkpoint(state) : deltaBetween(this.snapshotBaseline, state),
    );
    this.snapshotBaseline = baselineFor(state);
    this.lastRecordPerf = { projectionMs, snapshotMs: perfElapsed(snapshotStartedAt) };
    this.latestState = state;
    this.latestFrame = frame;
    this.replayCache = null;
    if (timeline.history.length > MAX_HISTORY_MONTHS) {
      const dropped = timeline.history.shift();
      if (dropped) timeline.frameByMonth.delete(dropped.elapsedMonths);
      this.pruneSnapshots(timeline);
      const earliestMonth = timeline.history[0]?.elapsedMonths;
      if (earliestMonth !== undefined) pruneChronicleProjection(chronicleProjection, earliestMonth);
    }
    return frame;
  }

  latest(): Frame | null {
    if (!this.stepCoordinator.isStepping()) this.replayCache = null;
    return this.latestFrame;
  }

  isBusy(): boolean {
    return this.stepCoordinator.isStepping()
      || this.interactionRequestCount > 0
      || this.pendingRequiems.size > 0
      || this.embodimentCoordinator !== null;
  }

  private committedStateForConversation(): SimulationState | null {
    if (this.embodimentCoordinator) return null;
    if (!this.stepCoordinator.isStepping()) return this.latestState;
    if (!this.latestFrame || !this.branches.has(this.activeBranchId)) return this.latestState;
    return this.snapshotForRead(this.activeTimeline(), this.latestFrame.elapsedMonths) ?? this.latestState;
  }

  private async waitForStepToSettle(): Promise<void> {
    await this.stepCoordinator.waitForSettle();
  }

  private settleInteractionDecisionAttempts(
    attempts: PlayerInteractionDecisionAttempt[],
    state: SimulationState,
  ): void {
    if (!attempts.length) return;
    const turns = this.localConversationTurns();
    const committedByInteractionId = new Map<string, Extract<WorldEvent, { kind: 'decision' }>>();
    state.lastStep.forEach((event) => {
      if (event.kind !== 'decision' || !event.usedModel || !event.intentId) return;
      if (event.decision.kind !== 'start' && event.decision.kind !== 'revise') return;
      if (event.decision.sourceInteractionId) {
        committedByInteractionId.set(event.decision.sourceInteractionId, event);
      }
    });
    for (const attempt of attempts) {
      const turn = turns.find((candidate) => candidate.id === attempt.interactionId
        && (candidate.influenceStatus === 'queued'
          || candidate.influenceStatus === 'deferred'
          || candidate.influenceStatus === 'pending'));
      if (!turn) continue;
      const committed = committedByInteractionId.get(attempt.interactionId);
      if (committed) {
        turn.influenceStatus = 'applied';
        const actionEvents = state.lastStep.filter((event) => event.kind === 'action'
          && event.who === turn.agentId
          && event.intentId === committed.intentId);
        turn.influenceOutcome = {
          atMonth: state.clock.elapsedMonths,
          summary: `已经把“${turn.choice?.summary ?? committed.result}”定为下一步`,
          detail: actionEvents.length
            ? actionEvents.map((event) => event.result).join('；')
            : committed.result,
          decisionEventId: committed.id,
          ...(committed.intentId ? { intentId: committed.intentId } : {}),
          ...(actionEvents.length ? { actionEventIds: actionEvents.map((event) => event.id) } : {}),
        };
      } else if (attempt.failure === 'emergency-first'
        || attempt.failure === 'required-response-first'
        || attempt.failure === 'fulfillment-first') {
        turn.influenceStatus = 'deferred';
        turn.influenceOutcome = {
          atMonth: state.clock.elapsedMonths,
          summary: '先处理眼前必须回应或履行的事',
          ...(attempt.detail ? { detail: `${attempt.detail} 原来的决定还保留着。` } : {}),
        };
      } else {
        turn.influenceStatus = 'blocked';
        turn.influenceOutcome = {
          atMonth: state.clock.elapsedMonths,
          summary: `没能开始“${turn.choice?.summary ?? turn.guidance ?? '原来的打算'}”`,
          detail: attempt.detail ?? '条件在决定提交前发生了变化。',
        };
      }
    }
  }

  /**
   * Advances at most one month for a caller-observed authority head.
   *
   * A transport timeout cannot cancel the server computation. Reusing stepId
   * returns the current authoritative head, while a different request with the
   * same expected month joins the already-running computation. A stale expected
   * month is an acknowledgement/read, never permission to advance again.
   */
  async step(options: ElandStepOptions): Promise<Frame | null> {
    if (this.embodimentCoordinator) {
      throw new ElandStepConflictError('有一个人物正处于逐刻化身月份，请先完成或交还自主');
    }
    return this.stepCoordinator.step(options);
  }

  hasActiveEmbodiment(): boolean {
    return this.embodimentCoordinator !== null;
  }

  embodimentView(): EmbodimentView | null {
    return this.embodimentCoordinator?.view() ?? null;
  }

  beginEmbodiment(input: BeginEmbodimentRequest): EmbodimentView {
    if (this.stepCoordinator.isStepping() || this.interactionRequestCount > 0) {
      throw new ElandSessionBusyError(this.runId, '进入人物化身');
    }
    if (this.embodimentCoordinator) {
      if (this.embodimentCoordinator.matchesBegin(input)) return this.embodimentCoordinator.view();
      throw new EmbodimentConflictError('当前已经有一个正在进行的化身月份');
    }
    this.embodimentCoordinator = EmbodimentCoordinator.begin(this.embodimentHost(), input);
    return this.embodimentCoordinator.view();
  }

  async stepEmbodiment(input: EmbodimentStepRequest): Promise<EmbodimentStepResponse> {
    const coordinator = this.embodimentCoordinator;
    if (!coordinator) {
      const completed = this.completedEmbodiments.find((candidate) => candidate.id === input.embodimentId);
      const stored = completed?.commandReceipts.find((candidate) => candidate.receipt.commandId === input.commandId);
      if (completed
        && stored
        && this.latestFrame?.branchId === completed.branchId
        && this.latestFrame.elapsedMonths === completed.committedElapsedMonths) {
        if (stored.fingerprint !== embodimentCommandFingerprint(input)) {
          throw new EmbodimentConflictError('commandId 已用于不同的化身行动');
        }
        return { receipt: stored.receipt, committedFrame: this.latestFrame };
      }
      throw new EmbodimentConflictError('当前没有等待行动的化身月份');
    }
    const result = await coordinator.step(input);
    if ('committedFrame' in result) {
      const completed = coordinator.completedSnapshot();
      if (completed) this.rememberCompletedEmbodiment(completed);
      if (this.embodimentCoordinator === coordinator) this.embodimentCoordinator = null;
    }
    return result;
  }

  async releaseEmbodiment(input: ReleaseEmbodimentRequest): Promise<EmbodimentReleaseResponse> {
    const coordinator = this.embodimentCoordinator;
    if (!coordinator) {
      const completed = this.completedEmbodiments.find((candidate) => candidate.id === input.embodimentId);
      if (completed?.release
        && this.latestFrame?.branchId === completed.branchId
        && this.latestFrame.elapsedMonths === completed.committedElapsedMonths) {
        if (completed.release.fingerprint !== embodimentReleaseFingerprint(input)) {
          throw new EmbodimentConflictError('releaseId 已用于不同的交还请求');
        }
        return { receipt: completed.release.receipt, committedFrame: this.latestFrame };
      }
      throw new EmbodimentConflictError('当前没有可交还的化身月份');
    }
    const result = await coordinator.release(input);
    const completed = coordinator.completedSnapshot();
    if (completed) this.rememberCompletedEmbodiment(completed);
    if (this.embodimentCoordinator === coordinator) this.embodimentCoordinator = null;
    return result;
  }

  settleCivilization(): Frame {
    if (this.stepCoordinator.isStepping() || this.interactionRequestCount > 0 || this.embodimentCoordinator) {
      throw new ElandSessionBusyError(this.runId, '结算文明');
    }
    if (!this.controller || !this.latestState || !this.latestFrame) throw new Error('当前没有可以结算的文明');
    if (this.latestState.civilization.status === 'ended') return this.latestFrame;
    const state = this.controller.ownedState();
    const events = concludeOwnedCivilization(state);
    return this.record(state, events, this.narrativeEntriesFor(state, events));
  }

  async civilizationRequiem(): Promise<CivilizationRequiem> {
    if (!this.latestState || !this.latestFrame) throw new Error('当前没有可以生成终章的文明');
    const facts = requiemFactsFromState(this.latestState, this.chronicle());
    const key = civilizationRequiemKey({
      civilizationId: facts.civilizationId,
      branchId: facts.branchId,
      endedAtMonth: facts.endedAtMonth,
    });
    const existing = this.requiems.get(key);
    if (existing) return existing;
    const pending = this.pendingRequiems.get(key);
    if (pending) return pending;
    const generation = generateCivilizationRequiem(facts).then((requiem) => {
      this.requiems.set(key, requiem);
      return requiem;
    }).finally(() => {
      if (this.pendingRequiems.get(key) === generation) this.pendingRequiems.delete(key);
    });
    this.pendingRequiems.set(key, generation);
    return generation;
  }

  historyList(): { month: number; label: string; summary: string }[] {
    return this.chronicle().map((entry) => {
      const date = calendarDate(entry.month);
      return {
        month: entry.month,
        label: date.label,
        summary: entry.text,
      };
    });
  }

  chronicle(): FrameEntry[] {
    const timeline = this.activeTimeline();
    return projectChronicleFromProjection(
      this.chronicleProjectionFor(timeline),
      this.latestState,
      this.eventById,
    );
  }

  civilizationIndexHistory(): CivilizationIndexHistoryPoint[] {
    return projectCivilizationIndexHistory(
      this.inheritedFrames(this.activeTimeline()),
      this.latestFrame?.society.observations.civilizationIndex,
    );
  }

  frameAt(month: number): Frame | null {
    if (this.latestFrame?.elapsedMonths === month) return this.latestFrame;
    const timeline = this.activeTimeline();
    const frame = findStoredFrame(this.branches, timeline, month);
    const snapshot = frame ? this.snapshotForRead(timeline, month) : undefined;
    return frame && snapshot ? { ...frame, society: toSocietyState(snapshot) } : null;
  }

  agentHistory(agentId: string, month: number, limit = 80): AgentHistoryView | null {
    const timeline = this.activeTimeline();
    const snapshot = this.snapshotForRead(timeline, month);
    return snapshot ? toAgentHistory(snapshot, agentId, limit) : null;
  }

  agentConversation(agentId: string): AgentConversationView | null {
    const state = this.latestState;
    const person = state?.people.find((candidate) => candidate.id === agentId);
    if (!state || !person) return null;
    const endpoint = modelEndpointStatus('interaction');
    return {
      agentId,
      branchId: state.branchId,
      throughMonth: state.clock.elapsedMonths,
      model: {
        configured: endpoint.configured,
        ...(endpoint.endpointId ? { endpointId: endpoint.endpointId } : {}),
        ...(endpoint.model ? { model: endpoint.model } : {}),
        ...(endpoint.issue ? { issue: endpoint.issue } : {}),
      },
      turns: this.inheritedConversationTurns(this.activeTimeline())
        .filter((turn) => turn.agentId === agentId)
        .map((turn) => projectConversationTurnOutcome(turn, state)),
    };
  }

  private async executeAgentConversation(input: QueuedAgentConversationRequest): Promise<AgentConversationResult> {
    // A monthly step may already have advanced the owned controller state while
    // still waiting for projection models. Build the conversation from the
    // latest fully recorded frame so the model never sees a torn month.
    const state = this.committedStateForConversation();
    if (!state) throw new AgentConversationConflictError('当前文明还没有可对话的权威状态');
    if (input.sourceBranchId !== state.branchId) {
      throw new AgentConversationConflictError('对话所依据的分支已经改变，请重新查看人物状态');
    }
    const timeline = this.activeTimeline();
    const existing = this.inheritedConversationTurns(timeline)
      .find((turn) => turn.clientMessageId === input.clientMessageId && turn.agentId === input.agentId);
    if (existing) {
      const existingFingerprint = conversationFingerprint({
        agentId: existing.agentId,
        branchId: existing.branchId,
        message: existing.userMessage,
        requestKind: existing.requestKind,
      });
      if (existingFingerprint !== input.fingerprint) {
        throw new AgentConversationConflictError('clientMessageId 已用于不同的人物对话内容');
      }
      const conversation = this.agentConversation(input.agentId);
      if (!conversation) throw new AgentConversationConflictError('人物已经不在当前分支');
      return { conversation, turn: existing };
    }
    const person = state.people.find((candidate) => candidate.id === input.agentId);
    if (!person || !isAlive(person)) throw new AgentConversationConflictError('这个人物已经无法回应对话');
    const context = buildDecisionContextForPerson(state, person);
    const sourceBranchId = state.branchId;
    const requestedAtMonth = state.clock.elapsedMonths;
    const priorTurns = this.inheritedConversationTurns(timeline)
      .filter((turn) => turn.agentId === person.id)
      // Old free-form replies had no source audit and may have confused an
      // in-world memory subject with the player. Keep them visible in the UI,
      // but never feed them back into a new model request.
      .filter((turn) => Boolean(turn.grounding) && Array.isArray(turn.evidenceIds))
      .slice(-12)
      .map((turn) => projectConversationTurnOutcome(turn, state))
      .map((turn) => ({
        user: turn.userMessage,
        agent: turn.agentReply,
        requestKind: turn.requestKind,
        stance: turn.stance,
        ...(turn.choice ? { choiceSummary: turn.choice.summary } : {}),
        ...(turn.influenceOutcome ? {
          outcome: {
            status: turn.influenceStatus,
            summary: turn.influenceOutcome.summary,
            ...(turn.influenceOutcome.detail ? { detail: turn.influenceOutcome.detail } : {}),
          },
        } : {}),
      }));
    const result = await requestAgentInteraction({
      context,
      turns: priorTurns,
      message: input.message,
      requestKind: input.requestKind,
    });

    // Let an overlapping month finish its atomic frame before attaching and
    // persisting this sidecar turn. The model wait never pauses the world.
    await this.waitForStepToSettle();

    const stillCurrentBranch = this.activeBranchId === sourceBranchId && this.latestState?.branchId === sourceBranchId;
    const currentPerson = stillCurrentBranch
      ? this.latestState?.people.find((candidate) => candidate.id === person.id)
      : undefined;
    const completedAtMonth = stillCurrentBranch
      ? this.latestState?.clock.elapsedMonths ?? requestedAtMonth
      : this.inheritedFrames(timeline).at(-1)?.elapsedMonths ?? requestedAtMonth;
    const wantsInfluence = Boolean(result.choice);
    let choice = result.choice ? {
      ...result.choice,
      reason: result.reason ?? '我在这次对话里定下了这个方向',
    } : undefined;
    let influenceStatus: AgentConversationInfluenceStatus = wantsInfluence ? 'stale' : 'none';
    let influenceOutcome: AgentConversationTurn['influenceOutcome'];
    if (choice && stillCurrentBranch && currentPerson && isAlive(currentPerson) && this.latestState) {
      const currentContext = buildDecisionContextForPerson(this.latestState, currentPerson);
      const validation = validatePlayerInteractionChoice(currentContext, choice);
      if (validation.ok) {
        choice = {
          ...choice,
          optionId: validation.optionId,
          ...(validation.followUpOptionId
            ? { followUpOptionId: validation.followUpOptionId }
            : { followUpOptionId: undefined }),
          summary: validation.summary,
          choiceKey: validation.choiceKey,
        };
        influenceStatus = 'queued';
      } else if (validation.failure === 'emergency-first'
        || validation.failure === 'required-response-first'
        || validation.failure === 'fulfillment-first') {
        influenceStatus = 'deferred';
        influenceOutcome = {
          atMonth: completedAtMonth,
          summary: '先处理眼前必须回应或履行的事',
          detail: conversationChoiceBlockedDetail(validation.failure, choice.summary),
        };
      } else {
        influenceStatus = 'blocked';
        influenceOutcome = {
          atMonth: completedAtMonth,
          summary: `没能开始“${choice.summary}”`,
          detail: conversationChoiceBlockedDetail(validation.failure, choice.summary),
        };
      }
    } else if (choice && !stillCurrentBranch) {
      influenceOutcome = {
        atMonth: completedAtMonth,
        summary: '这次决定留在了原来的时间线',
        detail: '人物回应期间时间线发生了变化；这个决定没有被带进当前时间线。',
      };
    } else if (choice && (!currentPerson || !isAlive(currentPerson))) {
      influenceOutcome = {
        atMonth: completedAtMonth,
        summary: '这个决定已经无法继续',
        detail: '人物在回应完成前已经死亡，原来的下一步不会再执行。',
      };
    }
    // Only a newer concrete choice supersedes an unreviewed choice. Pure
    // questions, reflection and refusals must not silently consume it.
    if (wantsInfluence
      && stillCurrentBranch
      && (influenceStatus === 'queued' || influenceStatus === 'deferred')) {
      for (const turn of this.localConversationTurns(timeline)) {
        if (turn.agentId === person.id && (
          turn.influenceStatus === 'pending'
          || turn.influenceStatus === 'queued'
          || turn.influenceStatus === 'deferred'
        )) {
          turn.influenceStatus = 'stale';
          turn.influenceOutcome = {
            atMonth: completedAtMonth,
            summary: '后来定下了新的下一步',
            detail: `“${turn.choice?.summary ?? turn.guidance ?? '原来的打算'}”被这次新的决定替代。`,
          };
        }
      }
    }
    const turn: AgentConversationTurn = {
      id: `agent-conversation:${createHash('sha256').update(`${sourceBranchId}:${person.id}:${input.clientMessageId}`).digest('hex').slice(0, 24)}`,
      clientMessageId: input.clientMessageId,
      agentId: person.id,
      branchId: sourceBranchId,
      requestedAtMonth,
      completedAtMonth,
      userMessage: input.message,
      agentReply: result.reply,
      requestKind: input.requestKind,
      stance: result.stance,
      ...(result.guidance ? { guidance: result.guidance } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      grounding: result.grounding,
      evidenceIds: result.evidenceIds,
      ...(choice ? { choice } : {}),
      influenceStatus,
      ...(influenceOutcome ? { influenceOutcome } : {}),
      model: { endpointId: result.endpointId, protocol: result.protocol, model: result.model },
      usage: result.usage,
    };
    this.localConversationTurns(timeline).push(turn);

    const conversation = stillCurrentBranch
      ? this.agentConversation(person.id)
      : {
          agentId: person.id,
          branchId: sourceBranchId,
          throughMonth: completedAtMonth,
          model: { configured: true, endpointId: result.endpointId, model: result.model },
          turns: this.inheritedConversationTurns(timeline).filter((candidate) => candidate.agentId === person.id),
        };
    if (!conversation) throw new AgentConversationConflictError('对话完成时人物分支已经不可用');
    return { conversation, turn };
  }

  async converseWithAgent(input: AgentConversationRequest): Promise<AgentConversationResult> {
    const state = this.committedStateForConversation();
    if (!state) throw new AgentConversationConflictError('当前文明还没有可对话的权威状态');
    const agentId = input.agentId.trim();
    const message = input.message.trim();
    const clientMessageId = input.clientMessageId.trim();
    if (!agentId) throw new Error('缺少 agentId');
    if (!message || message.length > 4_000) throw new Error('人物对话消息必须为 1–4000 个字符');
    if (!clientMessageId || clientMessageId.length > 160) throw new Error('clientMessageId 无效');
    const observedBranchId = input.observedBranchId?.trim();
    const sourceBranchId = observedBranchId || state.branchId;
    const requestKind = input.requestKind === 'suggestion' ? 'suggestion' : 'conversation';
    const fingerprint = conversationFingerprint({ agentId, branchId: sourceBranchId, message, requestKind });
    const requestKey = conversationRequestKey(agentId, clientMessageId);

    // Register the idempotency key before entering the per-agent queue. Exact
    // retries share one model request even while the original request is queued.
    const pending = this.pendingAgentConversations.get(requestKey);
    if (pending) {
      if (pending.fingerprint !== fingerprint) {
        throw new AgentConversationConflictError('clientMessageId 已用于不同的人物对话内容');
      }
      return pending.promise;
    }
    if (sourceBranchId !== state.branchId) {
      throw new AgentConversationConflictError('对话所依据的分支已经改变，请重新查看人物状态');
    }

    const timeline = this.activeTimeline();
    const existing = this.inheritedConversationTurns(timeline)
      .find((turn) => turn.clientMessageId === clientMessageId && turn.agentId === agentId);
    if (existing) {
      const existingFingerprint = conversationFingerprint({
        agentId: existing.agentId,
        branchId: existing.branchId,
        message: existing.userMessage,
        requestKind: existing.requestKind,
      });
      if (existingFingerprint !== fingerprint) {
        throw new AgentConversationConflictError('clientMessageId 已用于不同的人物对话内容');
      }
      const conversation = this.agentConversation(agentId);
      if (!conversation) throw new AgentConversationConflictError('人物已经不在当前分支');
      return { conversation, turn: existing };
    }

    const queuedInput: QueuedAgentConversationRequest = {
      agentId,
      message,
      requestKind,
      clientMessageId,
      sourceBranchId,
      fingerprint,
    };
    const previous = this.agentConversationTails.get(agentId) ?? Promise.resolve();
    this.interactionRequestCount += 1;
    const execution = previous.then(() => this.executeAgentConversation(queuedInput));
    const requestPromise: Promise<AgentConversationResult> = execution.finally(() => {
      const registered = this.pendingAgentConversations.get(requestKey);
      if (registered?.promise === requestPromise) this.pendingAgentConversations.delete(requestKey);
      this.interactionRequestCount -= 1;
    });
    const tail = requestPromise.then(() => undefined, () => undefined);
    this.agentConversationTails.set(agentId, tail);
    tail.then(() => {
      if (this.agentConversationTails.get(agentId) === tail) this.agentConversationTails.delete(agentId);
    });
    this.pendingAgentConversations.set(requestKey, { fingerprint, promise: requestPromise });
    return requestPromise;
  }

  seek(month: number): Frame | null {
    // 模型决策、台词和纪事仍属于同一个原子月。等待期间不能切换
    // controller / branch，否则旧月份会被写入新分支的 timeline。
    if (this.embodimentCoordinator) {
      throw new ElandSessionBusyError(this.runId, '切换化身月份所在的时间线');
    }
    if (this.stepCoordinator.isStepping()) return this.latest();
    const source = this.activeTimeline();
    const frame = findStoredFrame(this.branches, source, month);
    const snapshot = frame ? this.takeSnapshotForFork(source, frame.elapsedMonths) : undefined;
    if (!frame || !snapshot || !this.controller) return null;
    const inheritedThroughFork = this.inheritedFrames(source)
      .filter((candidate) => candidate.elapsedMonths <= frame.elapsedMonths);
    const sourceSociety = this.latestFrame?.elapsedMonths === frame.elapsedMonths
      ? this.latestFrame.society
      : toSocietyState(snapshot);
    const branchId = `${source.id}-fork-${month}-${++this.forkSequence}`;
    const branchState = snapshot;
    branchState.branchId = branchId;
    this.latestState = this.controller.adoptOwnedState(branchState);
    this.replaceEventIndex(this.latestState);
    this.activeBranchId = branchId;
    this.rotateAuthorityRevision();
    const branchFrame: Frame = {
      ...frame,
      society: sourceSociety,
      authorityRevision: this.authorityRevision,
      branchId,
    };
    this.skySample = branchFrame.skySample;
    this.cosmosSnapshot = branchFrame.cosmosSnapshot;
    const storedBranchFrame = storeFrame(branchFrame);
    this.latestFrame = branchFrame;
    this.branches.set(branchId, createBranchTimeline(branchId, month, {
      parentBranchId: source.id,
      initialFrame: storedBranchFrame,
      initialState: branchState,
    }));
    this.chronicleProjections.set(
      branchId,
      rebuildChronicleProjection(inheritedThroughFork, this.eventById),
    );
    this.snapshotBaseline = baselineFor(branchState);
    return branchFrame;
  }

  branchList(): Array<{ id: string; parentBranchId?: string; forkAtMonth: number; headAtMonth: number; active: boolean }> {
    return [...this.branches.values()].map((branch) => ({
      id: branch.id,
      ...(branch.parentBranchId ? { parentBranchId: branch.parentBranchId } : {}),
      forkAtMonth: branch.forkAtMonth,
      headAtMonth: this.inheritedFrames(branch).at(-1)?.elapsedMonths ?? branch.forkAtMonth,
      active: branch.id === this.activeBranchId,
    }));
  }
}

export class ElandSessionManager extends ElandSessionManagerCore<ElandSession> {
  constructor(options: ElandSessionManagerOptions = {}) {
    super({
      create: (runId, initialSkySample, timelineChunkResolver) => new ElandSession(
        runId,
        initialSkySample,
        timelineChunkResolver,
      ),
      restore: (snapshot, runId, timelineChunkResolver) => ElandSession.restore(
        snapshot,
        runId,
        timelineChunkResolver,
      ),
    }, options);
  }
}

export const elandSessions = new ElandSessionManager({
  ttlMs: Number(process.env.ELAND_SESSION_TTL_MS) || DEFAULT_SESSION_TTL_MS,
  recoveryTtlMs: Number(process.env.ELAND_SESSION_RECOVERY_TTL_MS) || DEFAULT_SESSION_RECOVERY_TTL_MS,
  maxSessions: Number(process.env.ELAND_MAX_SESSIONS) || DEFAULT_MAX_SESSIONS,
  activeStepProtectionMs: Number(process.env.ELAND_ACTIVE_STEP_PROTECTION_MS) || DEFAULT_ACTIVE_STEP_PROTECTION_MS,
  databaseDir: process.env.THREEBODY_DATA_DIR ?? path.join(process.cwd(), 'data'),
});

const sessionSweepTimer = setInterval(() => { elandSessions.sweep(); }, 60_000);
sessionSweepTimer.unref();
