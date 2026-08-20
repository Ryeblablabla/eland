/** ELAND 应用会话：编排月度用例、读取投影与可回溯快照。 */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';
import {
  createSimulation,
  createDefaultSimulationConfig,
  buildDecisionContextForPerson,
  MAX_SIMULATION_MONTHS,
  type SimulationController,
  type SimulationState,
  type WorldEvent,
} from '../src/game/eland/simulation';
import { calendarDate } from '../src/game/eland/domain/calendar';
import { isAlive } from '../src/game/eland/domain/person';
import { worldEventById } from '../src/game/eland/domain/event-index';
import { WORLD_CELL_COUNT, setVoxel } from '../src/game/eland/world/grid';
import { ERA_TO_ENV, monthSpeaker, projectPlayerNarrative, toAgentHistory, toSocietyState } from '../src/game/eland/adapter';
import { projectLiveSpeechDrafts } from '../src/game/eland/projection/live-speech';
import {
  validatePlayerInteractionChoice,
  type PlayerInteractionChoiceFailure,
} from '../src/game/eland/application/player-interaction-choice';
import type {
  CivilizationIndexHistoryPoint,
  CosmosSnapshot,
  GameFrame,
  NarrativeEntryView,
  SkySample,
  SpeechLineView,
} from '../src/game/societyContract';
import type { AgentHistoryView } from '../src/game/societyContract';
import type { ElandSaveSummary } from '../src/game/societyContract';
import { summarizePlayerNarrativeEntries } from './narrative-enhancements';
import {
  createServerLlmDecider,
  type PendingPlayerInteraction,
} from './backend-decider';
import {
  requestAgentInteraction,
  type AgentInteractionRequestKind,
  type AgentInteractionStance,
} from './agent-interaction-gateway';
import { realizeLiveSpeechLines, retainDecisionSpeechLines } from './live-speech-service';
import { hasExplicitModelRoute, modelEndpointStatus, readEvolutionMode, readSummaryMode } from './model-config';
import { logPerf, perfElapsed, perfNow } from './perf';
import {
  SqliteElandStore,
  type ManagedLiveSessionSnapshot,
} from './sqlite-eland-store';

export type FrameEntry = NarrativeEntryView;

export type Frame = GameFrame;

const MAX_HISTORY_MONTHS = 2_400;
const SNAPSHOT_CHECKPOINT_INTERVAL = 12;
const DEFAULT_SESSION_TTL_MS = 60 * 1_000;
const DEFAULT_SESSION_RECOVERY_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_SESSIONS = 16;
const DEFAULT_ACTIVE_STEP_PROTECTION_MS = 30 * 1_000;
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

interface InFlightStep {
  baseAuthorityRevision: string;
  baseCivilizationId: number;
  baseBranchId: string;
  baseElapsedMonths: number;
  requests: Map<string, string>;
  promise: Promise<Frame | null>;
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

function createAuthorityRevision(): string {
  return `authority-${randomUUID()}`;
}

type SnapshotState = Omit<SimulationState, 'world'>;
type SnapshotWorld = Omit<SimulationState['world'], 'grid' | 'past'>;
type StoredFrame = Omit<Frame, 'society'> & {
  /** Small observer-only projection retained beside the replay frame. */
  civilizationIndex?: CivilizationIndexHistoryPoint;
};

interface SimulationCheckpoint {
  kind: 'checkpoint';
  data: Buffer;
}

interface SimulationDeltaPayload {
  state: SnapshotState;
  world: SnapshotWorld;
  events: WorldEvent[];
  voxelIndices: Uint32Array;
  voxelValues: Uint16Array;
}

interface SimulationDelta {
  kind: 'delta';
  data: Buffer;
}

type StoredSnapshot = SimulationCheckpoint | SimulationDelta;

interface SnapshotBaseline {
  eventCount: number;
  firstEventId?: string;
  lastEventId?: string;
  voxels: Uint16Array;
}

interface BranchTimeline {
  id: string;
  parentBranchId?: string;
  forkAtMonth: number;
  createdAt: string;
  history: StoredFrame[];
  frameByMonth: Map<number, StoredFrame>;
  snapshots: Map<number, StoredSnapshot>;
  /** Player-to-person model conversations are branch-local inputs, not world facts. */
  conversationTurns?: AgentConversationTurn[];
}

export type AgentConversationInfluenceStatus =
  | 'none'
  | 'queued'
  | 'deferred'
  | 'applied'
  | 'completed'
  | 'blocked'
  | 'stale'
  /** Legacy statuses retained so recent recoverable sessions remain readable. */
  | 'pending'
  | 'considered'
  | 'failed';

export interface AgentConversationTurn {
  id: string;
  clientMessageId: string;
  agentId: string;
  branchId: string;
  requestedAtMonth: number;
  completedAtMonth: number;
  userMessage: string;
  agentReply: string;
  requestKind: AgentInteractionRequestKind;
  stance: AgentInteractionStance;
  guidance?: string;
  reason?: string;
  grounding?: 'supported' | 'unknown' | 'opinion';
  evidenceIds?: string[];
  /** The legal direction extracted from this reply; it is not yet an action fact. */
  choice?: {
    optionId: string;
    followUpOptionId?: string;
    summary: string;
    choiceKey: string;
    reason: string;
  };
  influenceStatus: AgentConversationInfluenceStatus;
  /** Local, replayable result of trying to attach the choice to the action chain. */
  influenceOutcome?: {
    atMonth: number;
    summary: string;
    detail?: string;
    decisionEventId?: string;
    intentId?: string;
    actionEventIds?: string[];
  };
  model: { endpointId: string; protocol: string; model: string };
  usage: { inputTokens: number; outputTokens: number };
}

export interface AgentConversationView {
  agentId: string;
  branchId: string;
  throughMonth: number;
  model: { configured: boolean; endpointId?: string; model?: string; issue?: string };
  turns: AgentConversationTurn[];
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

function conversationFingerprint(input: {
  agentId: string;
  branchId: string;
  message: string;
  requestKind: AgentInteractionRequestKind;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([input.branchId, input.agentId, input.requestKind, input.message]))
    .digest('hex');
}

function conversationRequestKey(agentId: string, clientMessageId: string): string {
  return JSON.stringify([agentId, clientMessageId]);
}

function normalizeConversationTurn(turn: AgentConversationTurn): AgentConversationTurn {
  const normalized = { ...turn } as AgentConversationTurn & { mode?: unknown };
  delete normalized.mode;
  return {
    ...normalized,
    requestKind: normalized.requestKind === 'suggestion' ? 'suggestion' : 'conversation',
  };
}

function conversationChoiceBlockedDetail(
  failure: PlayerInteractionChoiceFailure,
  summary: string,
): string {
  if (failure === 'emergency-first') return `我得先让身体脱离眼前的危险。“${summary}”还留着。`;
  if (failure === 'required-response-first') return `眼前有人正等我答复，我得先处理那件事。“${summary}”还留着。`;
  if (failure === 'fulfillment-first') return `我得先履行已经答应的事。“${summary}”还留着。`;
  if (failure === 'choice-ambiguous') return `眼前出现了几种都像“${summary}”的做法，我不能替过去的自己随便挑一个。`;
  if (failure === 'follow-up-unavailable') return `“${summary}”已经找不到可以接下去的做法。`;
  return `对话结束前，眼前的条件已经变了，“${summary}”不再是可行的下一步。`;
}

function projectConversationTurnOutcome(
  turn: AgentConversationTurn,
  state: SimulationState,
): AgentConversationTurn {
  if (turn.influenceStatus !== 'applied' || !turn.influenceOutcome?.intentId) return turn;
  const intent = state.intents.find((candidate) => candidate.id === turn.influenceOutcome?.intentId);
  if (!intent) {
    return {
      ...turn,
      influenceStatus: 'stale',
      influenceOutcome: {
        atMonth: state.clock.elapsedMonths,
        summary: '原来的行动结果不在当前时间线',
        detail: '这条时间线里找不到当时形成的打算，因此不会把另一条时间线的结果算在这里。',
      },
    };
  }
  const actionEvents = intent.actionEventIds.flatMap((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action' ? [event] : [];
  });
  const lastAction = actionEvents.at(-1);
  const choiceSummary = turn.choice?.summary ?? intent.summary;
  const outcome = {
    ...turn.influenceOutcome,
    atMonth: lastAction?.atMonth ?? intent.lastProgressAtMonth,
    ...(lastAction ? { detail: lastAction.result } : {}),
    ...(actionEvents.length ? { actionEventIds: actionEvents.map((event) => event.id) } : {}),
  };
  if (intent.status === 'completed') {
    return {
      ...turn,
      influenceStatus: 'completed',
      influenceOutcome: { ...outcome, summary: `已经做成“${choiceSummary}”` },
    };
  }
  if (intent.status === 'blocked' || intent.status === 'failed' || intent.status === 'abandoned') {
    return {
      ...turn,
      influenceStatus: 'blocked',
      influenceOutcome: {
        ...outcome,
        summary: `后来没能做成“${choiceSummary}”`,
        detail: intent.blockedReason ?? lastAction?.result ?? '这个打算后来停下了。',
      },
    };
  }
  if (intent.status === 'suspended') {
    return {
      ...turn,
      influenceStatus: 'deferred',
      influenceOutcome: {
        ...outcome,
        summary: '眼前有更急的事打断了原来的决定',
        detail: `${lastAction?.result ?? '原来的方向已经开始'}；这个打算还保留着。`,
      },
    };
  }
  return { ...turn, influenceOutcome: outcome };
}

export class AgentConversationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConversationConflictError';
  }
}

export interface ElandSessionRecoverySnapshot {
  schemaVersion: 1;
  savedAt: number;
  runId: string;
  civilizationId: number;
  latestState: SimulationState;
  latestFrame: Frame;
  branches: Map<string, BranchTimeline>;
  activeBranchId: string;
  forkSequence: number;
  skySample: SkySample;
  cosmosSnapshot?: CosmosSnapshot;
}

interface PersistedSessionIndexEntry {
  civilizationId: number;
  savedAt: number;
  lastStepAt: number;
  leaseId: string;
  creationId: string;
}

function pack<T>(value: T): Buffer {
  return brotliCompressSync(serialize(value), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 3 },
  });
}

function unpack<T>(data: Buffer): T {
  return deserialize(brotliDecompressSync(data)) as T;
}

function checkpoint(state: SimulationState): SimulationCheckpoint {
  return { kind: 'checkpoint', data: pack(state) };
}

function baselineFor(state: SimulationState): SnapshotBaseline {
  const events = state.world.past;
  return {
    eventCount: events.length,
    ...(events[0]?.id ? { firstEventId: events[0].id } : {}),
    ...(events.at(-1)?.id ? { lastEventId: events.at(-1)!.id } : {}),
    voxels: state.world.grid.voxels.slice(),
  };
}

function deltaBetween(previous: SnapshotBaseline, state: SimulationState): StoredSnapshot {
  const events = state.world.past;
  const prefixStable = events.length >= previous.eventCount
    && (previous.eventCount === 0
      || events[0]?.id === previous.firstEventId
      && events[previous.eventCount - 1]?.id === previous.lastEventId);
  const voxels = state.world.grid.voxels;
  if (!prefixStable || previous.voxels.length !== voxels.length) return checkpoint(state);

  const changedIndices: number[] = [];
  const changedValues: number[] = [];
  for (let index = 0; index < voxels.length; index += 1) {
    if (previous.voxels[index] === voxels[index]) continue;
    changedIndices.push(index);
    changedValues.push(voxels[index]);
  }
  const { world, ...stateFields } = state;
  const { grid: _grid, past: _past, ...worldFields } = world;
  return {
    kind: 'delta',
    data: pack<SimulationDeltaPayload>({
      state: stateFields,
      world: worldFields,
      events: events.slice(previous.eventCount),
      voxelIndices: Uint32Array.from(changedIndices),
      voxelValues: Uint16Array.from(changedValues),
    }),
  };
}

function applyDelta(state: SimulationState, delta: SimulationDelta): SimulationState {
  const payload = unpack<SimulationDeltaPayload>(delta.data);
  for (let offset = 0; offset < payload.voxelIndices.length; offset += 1) {
    const index = payload.voxelIndices[offset];
    const cell = index % WORLD_CELL_COUNT;
    setVoxel(
      state.world.grid,
      cell % state.world.grid.width,
      Math.floor(cell / state.world.grid.width),
      Math.floor(index / WORLD_CELL_COUNT),
      payload.voxelValues[offset],
    );
  }
  return {
    ...payload.state,
    world: {
      ...payload.world,
      grid: state.world.grid,
      past: [...state.world.past, ...payload.events],
    },
  };
}

function entriesFor(state: SimulationState, events: WorldEvent[]): FrameEntry[] {
  return projectPlayerNarrative(state, events, 4);
}

function foundingEventsFor(state: SimulationState): WorldEvent[] {
  return state.world.past.filter((event) => (
    event.kind === 'environment'
      && event.change === 'founding'
      && event.atMonth === 0
  ));
}

function endingEntryFor(state: SimulationState, events: WorldEvent[]): FrameEntry | null {
  const outcome = state.civilization.outcome;
  if (state.civilization.status !== 'ended' || !outcome) return null;
  const deathEvents = outcome.kind === 'destroyed'
    ? events.filter((event): event is Extract<WorldEvent, { kind: 'environment' }> => (
      event.kind === 'environment' && event.change === 'death'
    ))
    : [];
  const actorIds = [...new Set(deathEvents.flatMap((event) => (
    event.who ? [event.who] : typeof event.diff.personId === 'string' ? [event.diff.personId] : []
  )))];
  const text = outcome.kind === 'destroyed'
    ? `文明毁灭于${outcome.cause}。`
    : outcome.kind === 'boundary'
      ? `文明演化至第 ${outcome.atMonth} 月，观察结束。`
      : `文明达到观察目标，演化结束。`;
  return {
    id: `narrative:civilization:${state.civilization.number}:${outcome.kind}:${outcome.atMonth}`,
    month: outcome.atMonth,
    text,
    detail: outcome.summary,
    tone: outcome.kind === 'destroyed' ? 'bad' : 'era',
    kind: 'epoch',
    importance: 200,
    sourceEventIds: deathEvents.map((event) => event.id),
    actorIds,
  };
}

function withCivilizationEntries(
  state: SimulationState,
  events: WorldEvent[],
  entries: FrameEntry[],
): FrameEntry[] {
  const ending = endingEntryFor(state, events);
  if (!ending) return entries;
  const deathEventIds = new Set(ending.sourceEventIds);
  return [
    ...entries.filter((entry) => !(
      entry.id === ending.id
        || (entry.sourceEventIds.length > 0
          && entry.sourceEventIds.every((eventId) => deathEventIds.has(eventId)))
    )),
    ending,
  ];
}

export class ElandSession {
  private civilizationId = 0;
  private controller: SimulationController | null = null;
  private latestState: SimulationState | null = null;
  private latestFrame: Frame | null = null;
  private stepping = false;
  private stepWaiters: Array<() => void> = [];
  private inFlightStep: InFlightStep | null = null;
  private readonly completedStepReceipts = new Map<string, string>();
  private interactionRequestCount = 0;
  private readonly agentConversationTails = new Map<string, Promise<void>>();
  private readonly pendingAgentConversations = new Map<string, PendingAgentConversation>();
  private lastNarrativeFallbackLogAt = 0;
  private lastSpeechFallbackLogAt = 0;
  private snapshotBaseline: SnapshotBaseline | null = null;
  private lastRecordPerf = { projectionMs: 0, snapshotMs: 0 };
  private branches = new Map<string, BranchTimeline>();
  private activeBranchId = '';
  private forkSequence = 0;
  private authorityRevision = createAuthorityRevision();
  private skySample: SkySample;
  private cosmosSnapshot?: CosmosSnapshot;
  readonly runId: string;

  constructor(runId: string, initialSkySample: SkySample) {
    this.runId = runId;
    this.skySample = initialSkySample;
  }

  private rotateAuthorityRevision(): string {
    this.authorityRevision = createAuthorityRevision();
    this.completedStepReceipts.clear();
    return this.authorityRevision;
  }

  static restore(snapshot: ElandSessionRecoverySnapshot, runId = snapshot.runId): ElandSession {
    if (snapshot.schemaVersion !== 1 || !snapshot.latestState || !snapshot.latestFrame) {
      throw new Error('实时演化会话快照版本不受支持');
    }
    const state = snapshot.latestState;
    const frame = snapshot.latestFrame;
    const timeline = snapshot.branches instanceof Map ? snapshot.branches.get(snapshot.activeBranchId) : undefined;
    const head = timeline?.history.at(-1);
    if (state.schemaVersion !== 17
      || state.civilization.number !== snapshot.civilizationId
      || frame.civilizationId !== snapshot.civilizationId
      || state.branchId !== snapshot.activeBranchId
      || frame.branchId !== snapshot.activeBranchId
      || state.clock.elapsedMonths !== frame.elapsedMonths
      || head?.elapsedMonths !== frame.elapsedMonths
      || frame.universeTime !== frame.skySample.toTime
      || frame.skySample.toTime !== snapshot.skySample.toTime) {
      throw new Error('实时演化会话快照的文明、分支或月份不一致');
    }
    const storedCosmosSnapshot = snapshot.cosmosSnapshot ?? frame.cosmosSnapshot;
    const cosmosSnapshot = storedCosmosSnapshot
      ? { ...storedCosmosSnapshot, civilizations: snapshot.civilizationId }
      : undefined;
    if (cosmosSnapshot && cosmosSnapshot.t !== frame.skySample.toTime) {
      throw new Error('实时演化会话快照的宇宙时刻与已提交月份不一致');
    }
    const session = new ElandSession(runId, snapshot.skySample);
    session.civilizationId = snapshot.civilizationId;
    session.controller = createSimulation({ state: snapshot.latestState });
    session.latestState = session.controller.getState();
    // latestFrame is the committed observer result for this exact month. The
    // controller may refresh annual derived state while hydrating, but recovery
    // must not silently rewrite an already shown/replayable frame.
    session.latestFrame = {
      ...snapshot.latestFrame,
      runId,
      authorityRevision: session.authorityRevision,
      ...(cosmosSnapshot ? { cosmosSnapshot } : {}),
    };
    session.branches = new Map([...snapshot.branches.entries()].map(([branchId, timeline]) => {
      const history = timeline.history.map((frame) => ({
        ...frame,
        runId,
        authorityRevision: session.authorityRevision,
      }));
      return [branchId, {
        ...timeline,
        history,
        frameByMonth: new Map(history.map((frame) => [frame.elapsedMonths, frame])),
        conversationTurns: Array.isArray(timeline.conversationTurns)
          ? timeline.conversationTurns.map(normalizeConversationTurn)
          : [],
      }];
    }));
    session.activeBranchId = snapshot.activeBranchId;
    session.forkSequence = snapshot.forkSequence;
    session.cosmosSnapshot = cosmosSnapshot;
    const restoredTimeline = session.branches.get(session.activeBranchId);
    if (!restoredTimeline) throw new Error('实时演化会话缺少活动分支');
    // Repair a possibly incomplete legacy head delta with the saved committed
    // state, while leaving the controller free to use its migrated working copy.
    restoredTimeline.snapshots.set(session.latestFrame.elapsedMonths, checkpoint(state));
    session.snapshotBaseline = baselineFor(session.latestState);
    return session;
  }

  recoverySnapshot(savedAt = Date.now()): ElandSessionRecoverySnapshot | null {
    if (!this.latestState || !this.latestFrame || !this.controller) return null;
    return {
      schemaVersion: 1,
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
    };
  }

  begin(civilizationId: number, worldSeed: number, skySample: SkySample, characterIds?: string[], cosmosSnapshot?: CosmosSnapshot): Frame {
    this.rotateAuthorityRevision();
    this.civilizationId = civilizationId;
    this.skySample = skySample;
    this.cosmosSnapshot = cosmosSnapshot
      ? { ...cosmosSnapshot, civilizations: civilizationId }
      : undefined;
    this.controller = createSimulation({
      seed: worldSeed,
      config: createDefaultSimulationConfig({
        civilizationNo: civilizationId,
        chaosIntensity: 0,
        endpoint: { kind: 'months', value: MAX_SIMULATION_MONTHS },
        ...(characterIds?.length ? { characterIds } : {}),
      }),
    });
    const env = ERA_TO_ENV[skySample.fate];
    this.controller.setExternalClimate(env.epoch, env.kind, env.severity);
    const state = this.controller.getState();
    this.activeBranchId = state.branchId;
    this.branches = new Map([[state.branchId, {
      id: state.branchId,
      forkAtMonth: 0,
      createdAt: new Date().toISOString(),
      history: [],
      frameByMonth: new Map(),
      snapshots: new Map(),
      conversationTurns: [],
    }]]);
    this.forkSequence = 0;
    const foundingEvents = foundingEventsFor(state);
    return this.record(state, foundingEvents, entriesFor(state, foundingEvents));
  }

  model(): string {
    if (readEvolutionMode() !== 'model' || !hasExplicitModelRoute('decision')) return 'local';
    const endpoint = modelEndpointStatus('decision');
    return endpoint.configured && endpoint.endpointId ? endpoint.endpointId : 'local';
  }

  private activeTimeline(): BranchTimeline {
    const timeline = this.branches.get(this.activeBranchId);
    if (!timeline) throw new Error('活动分支不存在');
    return timeline;
  }

  private inheritedFrames(timeline: BranchTimeline): StoredFrame[] {
    if (!timeline.parentBranchId) return timeline.history;
    const parent = this.branches.get(timeline.parentBranchId);
    if (!parent) return timeline.history;
    return [
      ...this.inheritedFrames(parent).filter((frame) => frame.elapsedMonths < timeline.forkAtMonth),
      ...timeline.history,
    ];
  }

  private localConversationTurns(timeline = this.activeTimeline()): AgentConversationTurn[] {
    return timeline.conversationTurns ??= [];
  }

  private inheritedConversationTurns(timeline: BranchTimeline): AgentConversationTurn[] {
    const local = this.localConversationTurns(timeline);
    if (!timeline.parentBranchId) return local;
    const parent = this.branches.get(timeline.parentBranchId);
    if (!parent) return local;
    const inherited = this.inheritedConversationTurns(parent)
      .filter((turn) => turn.completedAtMonth <= timeline.forkAtMonth)
      .map((turn) => turn.influenceStatus === 'pending'
        || turn.influenceStatus === 'queued'
        || turn.influenceStatus === 'deferred'
        || (turn.influenceOutcome?.atMonth ?? -1) > timeline.forkAtMonth
        ? {
            ...turn,
            influenceStatus: 'stale' as const,
            influenceOutcome: {
              atMonth: timeline.forkAtMonth,
              summary: '原来的决定或结果留在了另一条时间线',
              detail: '你回到了更早的时间点，这次尚未发生的决定或结果没有被带进新的时间线。',
            },
          }
        : turn);
    return [...inherited, ...local];
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
    if (month < timeline.forkAtMonth && timeline.parentBranchId) {
      const parent = this.branches.get(timeline.parentBranchId);
      return parent ? this.inheritedSnapshot(parent, month) : undefined;
    }
    if (!timeline.snapshots.has(month)) return undefined;
    const months = [...timeline.snapshots.keys()].filter((candidate) => candidate <= month).sort((a, b) => a - b);
    const checkpointOffset = months.findLastIndex((candidate) => timeline.snapshots.get(candidate)?.kind === 'checkpoint');
    if (checkpointOffset < 0) return undefined;
    let state: SimulationState | undefined;
    for (const candidate of months.slice(checkpointOffset)) {
      const snapshot = timeline.snapshots.get(candidate)!;
      if (snapshot.kind === 'checkpoint') state = unpack<SimulationState>(snapshot.data);
      else if (state) state = applyDelta(state, snapshot);
    }
    return state;
  }

  private pruneSnapshots(timeline: BranchTimeline): void {
    const oldestFrameMonth = timeline.history[0]?.elapsedMonths;
    if (oldestFrameMonth === undefined) return;
    const retainedCheckpoint = [...timeline.snapshots.entries()]
      .filter(([month, snapshot]) => month <= oldestFrameMonth && snapshot.kind === 'checkpoint')
      .map(([month]) => month)
      .sort((a, b) => b - a)[0];
    if (retainedCheckpoint === undefined) return;
    for (const month of timeline.snapshots.keys()) {
      if (month < retainedCheckpoint) timeline.snapshots.delete(month);
    }
  }

  private record(
    state: SimulationState,
    events: WorldEvent[],
    entries = events.length ? entriesFor(state, events) : [],
    speechLines: SpeechLineView[] = [],
  ): Frame {
    const date = calendarDate(state.clock.elapsedMonths);
    const chronicleEntries = withCivilizationEntries(state, events, entries);
    const projectionStartedAt = perfNow();
    const society = toSocietyState(state);
    const projectionMs = perfElapsed(projectionStartedAt);
    const frame: Frame = {
      runId: this.runId,
      authorityRevision: this.authorityRevision,
      branchId: state.branchId,
      civilizationId: this.civilizationId,
      elapsedMonths: state.clock.elapsedMonths,
      calendar: { year: date.year, month: date.month, label: date.label },
      universeTime: this.skySample.toTime,
      skySample: this.skySample,
      ...(this.cosmosSnapshot ? { cosmosSnapshot: this.cosmosSnapshot } : {}),
      society,
      civilizationEnd: state.civilization.status === 'ended' && state.civilization.outcome
        ? { kind: state.civilization.outcome.kind, cause: state.civilization.outcome.cause, summary: state.civilization.outcome.summary }
        : null,
      entries: chronicleEntries,
      ...(speechLines.length ? { speechLines } : {}),
      speaker: speechLines.at(-1)?.speakerName ?? monthSpeaker(state, events),
    };
    const timeline = this.activeTimeline();
    const { society: _society, ...storedFrameBase } = frame;
    const observedIndex = society.observations.civilizationIndex;
    const storedFrame: StoredFrame = {
      ...storedFrameBase,
      ...(observedIndex ? {
        civilizationIndex: {
          formulaVersion: observedIndex.formulaVersion,
          total: observedIndex.total,
          calculatedAtMonth: observedIndex.calculatedAtMonth,
          stage: observedIndex.stage,
        },
      } : {}),
    };
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
    if (timeline.history.length > MAX_HISTORY_MONTHS) {
      const dropped = timeline.history.shift();
      if (dropped) timeline.frameByMonth.delete(dropped.elapsedMonths);
      this.pruneSnapshots(timeline);
    }
    return frame;
  }

  latest(): Frame | null {
    return this.latestFrame;
  }

  isBusy(): boolean {
    return this.stepping || this.interactionRequestCount > 0;
  }

  private committedStateForConversation(): SimulationState | null {
    if (!this.stepping) return this.latestState;
    if (!this.latestFrame || !this.branches.has(this.activeBranchId)) return this.latestState;
    return this.inheritedSnapshot(this.activeTimeline(), this.latestFrame.elapsedMonths) ?? this.latestState;
  }

  private async waitForStepToSettle(): Promise<void> {
    while (this.stepping) {
      await new Promise<void>((resolve) => { this.stepWaiters.push(resolve); });
    }
  }

  private settleInteractionDecisionAttempts(
    attempts: ReturnType<ReturnType<typeof createServerLlmDecider>['takeInteractionAttempts']>,
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

  /**
   * Advances at most one month for a caller-observed authority head.
   *
   * A transport timeout cannot cancel the server computation. Reusing stepId
   * returns the current authoritative head, while a different request with the
   * same expected month joins the already-running computation. A stale expected
   * month is an acknowledgement/read, never permission to advance again.
   */
  async step(options: ElandStepOptions): Promise<Frame | null> {
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
      return this.latest();
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
      // A request based on a different head is not the same authority step.
      // Re-evaluate it only after the current atomic month has settled.
      await active.promise;
      return this.step(options);
    }

    const current = this.latest();
    if (!this.controller) return current;
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
    if (this.latestState?.civilization.status === 'ended') {
      this.rememberCompletedStep(stepId, fingerprint);
      return current;
    }

    const requests = new Map<string, string>();
    if (stepId && fingerprint) requests.set(stepId, fingerprint);
    const promise = this.advanceStep(options);
    const inFlight: InFlightStep = {
      baseAuthorityRevision: current?.authorityRevision ?? this.authorityRevision,
      baseCivilizationId: current?.civilizationId ?? this.civilizationId,
      baseBranchId: current?.branchId ?? this.activeBranchId,
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

  private async advanceStep(options: ElandStepOptions): Promise<Frame | null> {
    const controller = this.controller;
    if (!controller) return this.latest();
    this.stepping = true;
    const stepStartedAt = perfNow();
    try {
      const nextSkySample = options.skySample;
      const nextCosmosSnapshot = options.cosmosSnapshot;
      const env = ERA_TO_ENV[nextSkySample.fate];
      // controller 是会话内唯一权威状态；直接推进可保留 WeakMap 增量索引，
      // 避免每月 getState → migrate → step → restore 的多轮全量深拷贝。
      controller.setExternalClimate(env.epoch, env.kind, env.severity);
      const decisionEndpoint = readEvolutionMode() === 'model' && hasExplicitModelRoute('decision')
        ? modelEndpointStatus('decision')
        : { configured: false };
      const decisionEndpointId = decisionEndpoint.configured ? decisionEndpoint.endpointId : undefined;
      const interactions = this.pendingPlayerInteractions();
      let state: SimulationState;
      const simulationStartedAt = perfNow();
      let interactionAttempts: ReturnType<ReturnType<typeof createServerLlmDecider>['takeInteractionAttempts']> = [];
      if (decisionEndpointId || interactions.length) {
        const decider = createServerLlmDecider(decisionEndpointId, {
          interactions,
          pendingOnly: !decisionEndpoint.configured,
        });
        try {
          state = await controller.stepAsyncOwned(decider);
          interactionAttempts = decider.takeInteractionAttempts();
        } catch (error) {
          interactionAttempts = decider.takeInteractionAttempts();
          // stepAsync 在供应商失败时已经使用本地决定；这里兜住基础设施之外的异常，
          // controller 尚未提交失败的异步结果，因此可安全执行同一个本地月份。
          console.warn(`运行 ${this.runId} 的关键模型决策已回退到本地规划：${error instanceof Error ? error.message : String(error)}`);
          state = controller.stepOwned();
        }
      } else {
        state = controller.stepOwned();
      }
      const simulationMs = perfElapsed(simulationStartedAt);
      const presentationStartedAt = perfNow();
      const speechDrafts = projectLiveSpeechDrafts(state, state.lastStep);
      const retainedDecisionLines = retainDecisionSpeechLines(speechDrafts);
      const speechPromise = decisionEndpoint.configured && decisionEndpoint.endpointId && speechDrafts.length > 0
        ? realizeLiveSpeechLines(state, state.lastStep, speechDrafts, decisionEndpoint.endpointId)
        : Promise.resolve({ lines: retainedDecisionLines, generationErrors: [] });
      const ruleEntries = entriesFor(state, state.lastStep);
      let entries = ruleEntries;
      // 终局需要按死亡事实精确替换为文明结局；若先交给模型与其他事实混写，
      // 之后既无法只删死亡半句，也可能连带丢掉同月的其他记录。
      if (readSummaryMode() === 'model' && state.civilization.status !== 'ended') {
        try {
          entries = await summarizePlayerNarrativeEntries(state, ruleEntries);
        } catch (error) {
          // 模型只改写投影文本；端点、超时、格式或事实校验失败时保留规则文本。
          const now = Date.now();
          if (now - this.lastNarrativeFallbackLogAt >= 60_000) {
            this.lastNarrativeFallbackLogAt = now;
            console.warn(`运行 ${this.runId} 的即时叙事已回退到规则文本：${error instanceof Error ? error.message : String(error)}`);
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
            console.warn(`运行 ${this.runId} 的 ${speech.generationErrors.length} 批即时台词未生成文字气泡：${speech.generationErrors[0]}`);
          }
        }
      } catch (error) {
        const now = Date.now();
        if (now - this.lastSpeechFallbackLogAt >= 60_000) {
          this.lastSpeechFallbackLogAt = now;
          console.warn(`运行 ${this.runId} 的即时台词未生成文字气泡：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // 天象与宇宙快照和新状态一起提交。模型等待期间手动存档仍只会看到
      // 上一个完整月份，避免写出“旧社会 + 新天空”的撕裂快照。
      this.skySample = nextSkySample;
      this.cosmosSnapshot = nextCosmosSnapshot
        ? { ...nextCosmosSnapshot, civilizations: this.civilizationId }
        : undefined;
      const frame = this.record(state, state.lastStep, entries, speechLines);
      this.settleInteractionDecisionAttempts(interactionAttempts, state);
      logPerf('live-step', {
        runId: this.runId,
        branchId: frame.branchId,
        month: frame.elapsedMonths,
        people: state.people.length,
        livingPeople: state.people.filter(isAlive).length,
        eventsThisMonth: state.lastStep.length,
        totalEvents: state.world.past.length,
        simulationMs,
        presentationMs: perfElapsed(presentationStartedAt),
        projectionMs: this.lastRecordPerf.projectionMs,
        snapshotMs: this.lastRecordPerf.snapshotMs,
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
    const entries = this.inheritedFrames(this.activeTimeline()).flatMap((frame) => frame.entries);
    if (!this.latestState) return entries;
    const foundingEntries = entriesFor(this.latestState, foundingEventsFor(this.latestState));
    const withFounding = foundingEntries.some((founding) => (
      !entries.some((entry) => entry.sourceEventIds.some((eventId) => founding.sourceEventIds.includes(eventId)))
    )) ? [...foundingEntries, ...entries] : entries;
    return withCivilizationEntries(this.latestState, this.latestState.lastStep, withFounding);
  }

  civilizationIndexHistory(): CivilizationIndexHistoryPoint[] {
    const points = this.inheritedFrames(this.activeTimeline())
      .map((frame) => frame.civilizationIndex)
      .filter((point): point is CivilizationIndexHistoryPoint => Boolean(point));
    const current = this.latestFrame?.society.observations.civilizationIndex;
    if (current && points.at(-1)?.calculatedAtMonth !== current.calculatedAtMonth) {
      points.push({
        formulaVersion: current.formulaVersion,
        total: current.total,
        calculatedAtMonth: current.calculatedAtMonth,
        stage: current.stage,
      });
    }
    return points;
  }

  frameAt(month: number): Frame | null {
    if (this.latestFrame?.elapsedMonths === month) return this.latestFrame;
    const find = (timeline: BranchTimeline): StoredFrame | null => {
      const local = timeline.frameByMonth.get(month);
      if (local) return local;
      if (!timeline.parentBranchId || month > timeline.forkAtMonth) return null;
      const parent = this.branches.get(timeline.parentBranchId);
      return parent ? find(parent) : null;
    };
    const timeline = this.activeTimeline();
    const frame = find(timeline);
    const snapshot = frame ? this.inheritedSnapshot(timeline, month) : undefined;
    return frame && snapshot ? { ...frame, society: toSocietyState(snapshot) } : null;
  }

  agentHistory(agentId: string, month: number, limit = 80): AgentHistoryView | null {
    const timeline = this.activeTimeline();
    const snapshot = this.inheritedSnapshot(timeline, month);
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
    let requestPromise: Promise<AgentConversationResult>;
    requestPromise = execution.finally(() => {
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
    if (this.stepping) return this.latest();
    const frame = this.frameAt(month);
    const source = this.activeTimeline();
    const snapshot = frame ? this.inheritedSnapshot(source, frame.elapsedMonths) : undefined;
    if (!frame || !snapshot || !this.controller) return null;
    const branchId = `${source.id}-fork-${month}-${++this.forkSequence}`;
    const branchState = structuredClone(snapshot);
    branchState.branchId = branchId;
    this.controller.restore(branchState);
    this.latestState = branchState;
    this.activeBranchId = branchId;
    this.rotateAuthorityRevision();
    const branchFrame: Frame = {
      ...frame,
      authorityRevision: this.authorityRevision,
      branchId,
    };
    this.skySample = branchFrame.skySample;
    this.cosmosSnapshot = branchFrame.cosmosSnapshot;
    const { society: _society, ...storedBranchFrame } = branchFrame;
    this.latestFrame = branchFrame;
    this.branches.set(branchId, {
      id: branchId,
      parentBranchId: source.id,
      forkAtMonth: month,
      createdAt: new Date().toISOString(),
      history: [storedBranchFrame],
      frameByMonth: new Map([[month, storedBranchFrame]]),
      snapshots: new Map([[month, checkpoint(branchState)]]),
      conversationTurns: [],
    });
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

export class ElandSessionCapacityError extends Error {
  constructor(readonly maxSessions: number) {
    super(`演化会话已达到上限（${maxSessions}），且现有会话最近仍在推进`);
    this.name = 'ElandSessionCapacityError';
  }
}

export class ElandSessionBusyError extends Error {
  constructor(readonly runId: string, operation: string) {
    super(`运行 ${runId} 正在完成模型对话或权威月份，暂时不能${operation}`);
    this.name = 'ElandSessionBusyError';
  }
}

export class ElandStepConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElandStepConflictError';
  }
}

export class ElandSessionManager {
  private readonly sessions = new Map<string, {
    session: ElandSession;
    touchedAt: number;
    lastStepAt: number;
    leaseId: string;
    creationId: string;
  }>();
  private readonly persistedSessions = new Map<string, PersistedSessionIndexEntry>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly activeStepProtectionMs: number;
  private readonly recoveryTtlMs: number;
  private readonly persistence: SqliteElandStore;
  private closed = false;

  constructor(options: {
    ttlMs?: number;
    recoveryTtlMs?: number;
    maxSessions?: number;
    activeStepProtectionMs?: number;
    databaseDir?: string;
    persistence?: SqliteElandStore;
  } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.recoveryTtlMs = options.recoveryTtlMs ?? DEFAULT_SESSION_RECOVERY_TTL_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.activeStepProtectionMs = options.activeStepProtectionMs ?? DEFAULT_ACTIVE_STEP_PROTECTION_MS;
    this.persistence = options.persistence ?? new SqliteElandStore(path.resolve(
      options.databaseDir ?? path.join(process.cwd(), 'data'),
    ));
    this.scanPersisted();
    const savedCivilizationHighWaterMark = this.persistence.listManualSaves()
      .reduce((maximum, save) => Math.max(maximum, save.civilizationId), 0);
    if (savedCivilizationHighWaterMark > 0) {
      this.persistence.observeCivilizationId(savedCivilizationHighWaterMark);
    }
  }

  private removePersisted(runId: string): void {
    this.persistedSessions.delete(runId);
    this.persistence.deleteLiveSession(runId);
  }

  private scanPersisted(): void {
    for (const summary of this.persistence.listLiveSessions()) {
      // 过期会话可以清理，但它曾经领取过的文明号仍然不能被复用。
      this.persistence.observeCivilizationId(summary.civilizationId);
      if (Date.now() - summary.savedAt > this.recoveryTtlMs) {
        this.removePersisted(summary.runId);
        continue;
      }
      this.persistedSessions.set(summary.runId, {
        civilizationId: summary.civilizationId,
        savedAt: summary.savedAt,
        lastStepAt: summary.lastStepAt,
        leaseId: summary.leaseId,
        creationId: summary.creationId,
      });
    }
  }

  private restorePersistedRun(runId: string): ElandSession | null {
    try {
      const snapshot = this.persistence.loadLiveSession(runId);
      if (!snapshot) return null;
      if (snapshot.schemaVersion !== 1 || snapshot.session.runId !== runId) {
        this.removePersisted(runId);
        return null;
      }
      this.persistence.observeCivilizationId(snapshot.session.civilizationId);
      if (Date.now() - snapshot.session.savedAt > this.recoveryTtlMs) {
        this.removePersisted(runId);
        return null;
      }
      this.persistedSessions.set(runId, {
        civilizationId: snapshot.session.civilizationId,
        savedAt: snapshot.session.savedAt,
        lastStepAt: snapshot.lastStepAt,
        leaseId: snapshot.leaseId,
        creationId: snapshot.creationId ?? '',
      });
      const session = ElandSession.restore(snapshot.session);
      this.sessions.set(runId, {
        session,
        touchedAt: Date.now(),
        lastStepAt: snapshot.lastStepAt,
        leaseId: snapshot.leaseId,
        creationId: snapshot.creationId ?? '',
      });
      return session;
    } catch (error) {
      console.warn(`实时演化会话 ${runId} 恢复失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private persistEntry(runId: string, entry: {
    session: ElandSession;
    touchedAt: number;
    lastStepAt: number;
    leaseId: string;
    creationId: string;
  }, now = Date.now()): boolean {
    const session = entry.session.recoverySnapshot(now);
    if (!session) return false;
    const snapshot: ManagedLiveSessionSnapshot = {
      schemaVersion: 1,
      touchedAt: entry.touchedAt,
      lastStepAt: entry.lastStepAt,
      leaseId: entry.leaseId,
      creationId: entry.creationId,
      session,
    };
    const persistenceStartedAt = perfNow();
    this.persistence.saveLiveSession(snapshot);
    this.persistedSessions.set(runId, {
      civilizationId: session.civilizationId,
      savedAt: session.savedAt,
      lastStepAt: entry.lastStepAt,
      leaseId: entry.leaseId,
      creationId: entry.creationId,
    });
    logPerf('live-persist', {
      runId,
      month: session.latestFrame.elapsedMonths,
      persistenceMs: perfElapsed(persistenceStartedAt),
    });
    return true;
  }

  persistAll(now = Date.now()): number {
    this.sweep(now);
    let persisted = 0;
    for (const [runId, entry] of this.sessions) {
      if (this.persistEntry(runId, entry, now)) persisted += 1;
    }
    return persisted;
  }

  persist(runId: string, now = Date.now()): boolean {
    const entry = this.sessions.get(runId);
    return entry ? this.persistEntry(runId, entry, now) : false;
  }

  persistIfCurrent(
    runId: string,
    expectedSession: ElandSession,
    now = Date.now(),
  ): { current: boolean; persisted: boolean } {
    const entry = this.sessions.get(runId);
    if (!entry || entry.session !== expectedSession) return { current: false, persisted: false };
    entry.touchedAt = now;
    return { current: true, persisted: this.persistEntry(runId, entry, now) };
  }

  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [runId, entry] of this.sessions) {
      if (now - entry.touchedAt <= this.ttlMs || entry.session.isBusy()) continue;
      this.persistEntry(runId, entry, now);
      this.sessions.delete(runId);
      removed += 1;
    }
    return removed;
  }

  private evictLeastRecentlyUsed(now: number): boolean {
    if (this.sessions.size < this.maxSessions) return true;
    const oldest = [...this.sessions.entries()]
      .filter(([, entry]) => !entry.session.isBusy() && now - entry.lastStepAt > this.activeStepProtectionMs)
      .sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
    if (!oldest) return false;
    this.persistEntry(oldest[0], oldest[1], now);
    this.sessions.delete(oldest[0]);
    return true;
  }

  begin(
    runId: string,
    creationId: string,
    worldSeed: number,
    skySample: SkySample,
    characterIds?: string[],
    leaseId = '',
    cosmosSnapshot?: CosmosSnapshot,
  ): Frame {
    const now = Date.now();
    this.sweep(now);
    if (!this.sessions.has(runId)) {
      const persisted = this.persistedSessions.get(runId);
      if (persisted && persisted.creationId !== creationId) this.removePersisted(runId);
      else this.restorePersistedRun(runId);
    }
    const existing = this.sessions.get(runId);
    if (existing?.creationId === creationId) {
      existing.touchedAt = now;
      if (leaseId) existing.leaseId = leaseId;
      const frame = existing.session.latest();
      if (frame) return frame;
    }
    if (existing?.session.isBusy()) throw new ElandSessionBusyError(runId, '重新创建文明');
    if (!this.sessions.has(runId) && !this.evictLeastRecentlyUsed(now)) {
      throw new ElandSessionCapacityError(this.maxSessions);
    }
    this.removePersisted(runId);
    const civilizationId = this.persistence.allocateCivilizationId();
    const session = new ElandSession(runId, skySample);
    const frame = session.begin(civilizationId, worldSeed, skySample, characterIds, cosmosSnapshot);
    this.sessions.set(runId, { session, touchedAt: now, lastStepAt: 0, leaseId, creationId });
    return frame;
  }

  listSaves(): ElandSaveSummary[] {
    return this.persistence.listManualSaves();
  }

  save(runId: string, label?: string): ElandSaveSummary | null {
    const session = this.get(runId);
    const snapshot = session?.recoverySnapshot();
    return snapshot?.cosmosSnapshot ? this.persistence.saveManual(snapshot, label) : null;
  }

  loadSave(runId: string, saveId: string, leaseId = ''): { meta: ElandSaveSummary; session: ElandSession; frame: Frame } {
    const now = Date.now();
    this.sweep(now);
    const existing = this.sessions.get(runId);
    if (existing?.session.isBusy()) throw new ElandSessionBusyError(runId, '载入存档');
    if (!this.sessions.has(runId) && !this.evictLeastRecentlyUsed(now)) {
      throw new ElandSessionCapacityError(this.maxSessions);
    }
    const loaded = this.persistence.loadManual(saveId);
    const session = ElandSession.restore(loaded.session, runId);
    const frame = session.latest();
    if (!frame) throw new Error(`存档 ${saveId} 没有可恢复的文明帧`);
    this.persistence.observeCivilizationId(frame.civilizationId);
    this.removePersisted(runId);
    this.sessions.set(runId, { session, touchedAt: now, lastStepAt: now, leaseId, creationId: '' });
    return { meta: loaded.meta, session, frame };
  }

  get(runId: string, activity: 'read' | 'step' = 'read'): ElandSession | null {
    const now = Date.now();
    this.sweep(now);
    let entry = this.sessions.get(runId);
    if (!entry) {
      const restored = this.restorePersistedRun(runId);
      if (!restored) return null;
      entry = this.sessions.get(runId);
    }
    if (!entry) return null;
    entry.touchedAt = now;
    if (activity === 'step') entry.lastStepAt = now;
    return entry.session;
  }

  end(runId: string, leaseId = ''): boolean {
    const entry = this.sessions.get(runId);
    if (!entry) {
      const persisted = this.persistedSessions.get(runId);
      if (!persisted || (leaseId && persisted.leaseId && persisted.leaseId !== leaseId)) return false;
      this.removePersisted(runId);
      return true;
    }
    if (leaseId && entry.leaseId && entry.leaseId !== leaseId) return false;
    if (entry.session.isBusy()) throw new ElandSessionBusyError(runId, '结束会话');
    const deleted = this.sessions.delete(runId);
    if (deleted) this.removePersisted(runId);
    return deleted;
  }

  size(): number {
    this.sweep();
    return this.sessions.size;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.persistence.close();
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
