/** ELAND 应用会话：编排月度用例、读取投影与可回溯快照。 */
import { deserialize, serialize } from 'node:v8';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';
import {
  createSimulation,
  createDefaultSimulationConfig,
  MAX_SIMULATION_MONTHS,
  type SimulationController,
  type SimulationState,
  type WorldEvent,
} from '../src/game/eland/simulation';
import { calendarDate } from '../src/game/eland/domain/calendar';
import { ERA_TO_ENV, monthSpeaker, projectPlayerNarrative, toAgentHistory, toSocietyState } from '../src/game/eland/adapter';
import type { GameFrame, NarrativeEntryView, SkySample } from '../src/game/societyContract';
import type { AgentHistoryView } from '../src/game/societyContract';

export type FrameEntry = NarrativeEntryView;

export type Frame = GameFrame;

const MAX_HISTORY_MONTHS = 2_400;
const SNAPSHOT_CHECKPOINT_INTERVAL = 12;
const DEFAULT_SESSION_TTL_MS = 60 * 1_000;
const DEFAULT_MAX_SESSIONS = 16;
const DEFAULT_ACTIVE_STEP_PROTECTION_MS = 30 * 1_000;

type SnapshotState = Omit<SimulationState, 'world'>;
type SnapshotWorld = Omit<SimulationState['world'], 'grid' | 'past'>;
type StoredFrame = Omit<Frame, 'society'>;

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

interface BranchTimeline {
  id: string;
  parentBranchId?: string;
  forkAtMonth: number;
  createdAt: string;
  history: StoredFrame[];
  frameByMonth: Map<number, StoredFrame>;
  snapshots: Map<number, StoredSnapshot>;
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

function deltaBetween(previous: SimulationState, state: SimulationState): StoredSnapshot {
  const previousEvents = previous.world.past;
  const events = state.world.past;
  const prefixStable = events.length >= previousEvents.length
    && (previousEvents.length === 0
      || events[0]?.id === previousEvents[0]?.id
      && events[previousEvents.length - 1]?.id === previousEvents[previousEvents.length - 1]?.id);
  const previousVoxels = previous.world.grid.voxels;
  const voxels = state.world.grid.voxels;
  if (!prefixStable || previousVoxels.length !== voxels.length) return checkpoint(state);

  const changedIndices: number[] = [];
  const changedValues: number[] = [];
  for (let index = 0; index < voxels.length; index += 1) {
    if (previousVoxels[index] === voxels[index]) continue;
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
      events: events.slice(previousEvents.length),
      voxelIndices: Uint32Array.from(changedIndices),
      voxelValues: Uint16Array.from(changedValues),
    }),
  };
}

function applyDelta(state: SimulationState, delta: SimulationDelta): SimulationState {
  const payload = unpack<SimulationDeltaPayload>(delta.data);
  for (let offset = 0; offset < payload.voxelIndices.length; offset += 1) {
    state.world.grid.voxels[payload.voxelIndices[offset]] = payload.voxelValues[offset];
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

export class ElandSession {
  private civilizationId = 0;
  private controller: SimulationController | null = null;
  private latestState: SimulationState | null = null;
  private latestFrame: Frame | null = null;
  private stepping = false;
  private branches = new Map<string, BranchTimeline>();
  private activeBranchId = '';
  private forkSequence = 0;
  private skySample: SkySample;
  readonly runId: string;

  constructor(runId: string, initialSkySample: SkySample) {
    this.runId = runId;
    this.skySample = initialSkySample;
  }

  begin(civilizationId: number, worldSeed: number, skySample: SkySample, characterIds?: string[]): Frame {
    this.civilizationId = civilizationId;
    this.skySample = skySample;
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
    }]]);
    this.forkSequence = 0;
    return this.record(state, []);
  }

  model(): 'local' {
    return 'local';
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

  private inheritedSnapshot(timeline: BranchTimeline, month: number): SimulationState | undefined {
    if (month < timeline.forkAtMonth && timeline.parentBranchId) {
      const parent = this.branches.get(timeline.parentBranchId);
      return parent ? this.inheritedSnapshot(parent, month) : undefined;
    }
    if (!timeline.snapshots.has(month)) return undefined;
    const months = [...timeline.snapshots.keys()].filter((candidate) => candidate <= month).sort((a, b) => a - b);
    let state: SimulationState | undefined;
    for (const candidate of months) {
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

  private record(state: SimulationState, events: WorldEvent[]): Frame {
    const date = calendarDate(state.clock.elapsedMonths);
    const frame: Frame = {
      runId: this.runId,
      branchId: state.branchId,
      civilizationId: this.civilizationId,
      elapsedMonths: state.clock.elapsedMonths,
      calendar: { year: date.year, month: date.month, label: date.label },
      universeTime: this.skySample.toTime,
      skySample: this.skySample,
      society: toSocietyState(state),
      civilizationEnd: state.civilization.status === 'ended' && state.civilization.outcome
        ? { kind: state.civilization.outcome.kind, cause: state.civilization.outcome.cause, summary: state.civilization.outcome.summary }
        : null,
      entries: events.length ? entriesFor(state, events) : [],
      speaker: monthSpeaker(state, events),
    };
    const timeline = this.activeTimeline();
    const { society: _society, ...storedFrame } = frame;
    timeline.history.push(storedFrame);
    timeline.frameByMonth.set(frame.elapsedMonths, storedFrame);
    const shouldCheckpoint = this.latestState === null
      || timeline.history.length === 1
      || frame.elapsedMonths % SNAPSHOT_CHECKPOINT_INTERVAL === 0;
    timeline.snapshots.set(
      frame.elapsedMonths,
      shouldCheckpoint || !this.latestState ? checkpoint(state) : deltaBetween(this.latestState, state),
    );
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

  async step(options: { skySample: SkySample }): Promise<Frame | null> {
    if (!this.controller || this.stepping) return this.latest();
    this.stepping = true;
    try {
      this.skySample = options.skySample;
      const env = ERA_TO_ENV[this.skySample.fate];
      // controller 是会话内唯一权威状态；直接推进可保留 WeakMap 增量索引，
      // 避免每月 getState → migrate → step → restore 的多轮全量深拷贝。
      this.controller.setExternalClimate(env.epoch, env.kind, env.severity);
      const state = this.controller.step();
      return this.record(state, state.lastStep);
    } finally {
      this.stepping = false;
    }
  }

  historyList(): { month: number; label: string; summary: string }[] {
    return this.inheritedFrames(this.activeTimeline()).map((frame) => ({
      month: frame.elapsedMonths,
      label: frame.calendar.label,
      summary: frame.entries[0]?.text ?? '世界初始状态',
    }));
  }

  frameAt(month: number): Frame | null {
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

  seek(month: number): Frame | null {
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
    const branchFrame: Frame = { ...frame, branchId };
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
    });
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

export class ElandSessionManager {
  private readonly sessions = new Map<string, {
    session: ElandSession;
    touchedAt: number;
    lastStepAt: number;
    leaseId: string;
  }>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly activeStepProtectionMs: number;

  constructor(options: { ttlMs?: number; maxSessions?: number; activeStepProtectionMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.activeStepProtectionMs = options.activeStepProtectionMs ?? DEFAULT_ACTIVE_STEP_PROTECTION_MS;
  }

  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [runId, entry] of this.sessions) {
      if (now - entry.touchedAt <= this.ttlMs) continue;
      this.sessions.delete(runId);
      removed += 1;
    }
    return removed;
  }

  private evictLeastRecentlyUsed(now: number): boolean {
    if (this.sessions.size < this.maxSessions) return true;
    const oldest = [...this.sessions.entries()]
      .filter(([, entry]) => now - entry.lastStepAt > this.activeStepProtectionMs)
      .sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
    if (!oldest) return false;
    this.sessions.delete(oldest[0]);
    return true;
  }

  begin(runId: string, civilizationId: number, worldSeed: number, skySample: SkySample, characterIds?: string[], leaseId = ''): Frame {
    const now = Date.now();
    this.sweep(now);
    if (!this.sessions.has(runId) && !this.evictLeastRecentlyUsed(now)) {
      throw new ElandSessionCapacityError(this.maxSessions);
    }
    const session = new ElandSession(runId, skySample);
    const frame = session.begin(civilizationId, worldSeed, skySample, characterIds);
    this.sessions.set(runId, { session, touchedAt: now, lastStepAt: 0, leaseId });
    return frame;
  }

  get(runId: string, activity: 'read' | 'step' = 'read'): ElandSession | null {
    const now = Date.now();
    this.sweep(now);
    const entry = this.sessions.get(runId);
    if (!entry) return null;
    entry.touchedAt = now;
    if (activity === 'step') entry.lastStepAt = now;
    return entry.session;
  }

  end(runId: string, leaseId = ''): boolean {
    const entry = this.sessions.get(runId);
    if (!entry || (leaseId && entry.leaseId && entry.leaseId !== leaseId)) return false;
    return this.sessions.delete(runId);
  }

  size(): number {
    this.sweep();
    return this.sessions.size;
  }
}

export const elandSessions = new ElandSessionManager({
  ttlMs: Number(process.env.ELAND_SESSION_TTL_MS) || DEFAULT_SESSION_TTL_MS,
  maxSessions: Number(process.env.ELAND_MAX_SESSIONS) || DEFAULT_MAX_SESSIONS,
  activeStepProtectionMs: Number(process.env.ELAND_ACTIVE_STEP_PROTECTION_MS) || DEFAULT_ACTIVE_STEP_PROTECTION_MS,
});

const sessionSweepTimer = setInterval(() => { elandSessions.sweep(); }, 60_000);
sessionSweepTimer.unref();
