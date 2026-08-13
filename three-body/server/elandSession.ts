/** ELAND 应用会话：编排月度用例、读取投影与可回溯快照。 */
import {
  createSimulation,
  createDefaultSimulationConfig,
  type SimulationController,
  type SimulationState,
  type WorldEvent,
} from '../src/game/eland/simulation';
import { calendarDate } from '../src/game/eland/domain/calendar';
import { ERA_TO_ENV, eventToChronicle, monthSpeaker, toAgentHistory, toSocietyState } from '../src/game/eland/adapter';
import { createServerLlmDecider } from './backend-decider';
import { loadLlmKey } from './env';
import type { ModelProvider } from '../src/game/llm';
import type { GameFrame, SkySample } from '../src/game/societyContract';
import type { AgentHistoryView } from '../src/game/societyContract';

export interface FrameEntry {
  text: string;
  tone: 'plain' | 'good' | 'bad' | 'era';
  kind: 'action' | 'decision' | 'epoch';
}

export type Frame = GameFrame;

const MAX_HISTORY_MONTHS = 2_400;

interface BranchTimeline {
  id: string;
  parentBranchId?: string;
  forkAtMonth: number;
  createdAt: string;
  history: Frame[];
  snapshots: Map<number, SimulationState>;
}

function entriesFor(state: SimulationState, events: WorldEvent[]): FrameEntry[] {
  const important = events.filter((event) =>
    event.kind === 'decision'
    || (event.kind === 'action' && (event.status === 'completed' || event.status === 'blocked'))
    || (event.kind === 'environment' && event.change === 'death'));
  const source = important.length ? important : events.filter((event) => event.kind === 'action');
  const entries = source.slice(0, 4).flatMap((event) => {
    const chronicle = eventToChronicle(event);
    if (!chronicle) return [];
    return [{
      ...chronicle,
      kind: event.kind === 'decision' ? 'decision' as const : event.kind === 'environment' ? 'epoch' as const : 'action' as const,
    }];
  });
  if (entries.length) return entries;
  const date = calendarDate(state.clock.elapsedMonths);
  return [{ text: `${date.label}：人们沿着各自既有计划继续生活。`, tone: 'plain', kind: 'epoch' }];
}

export class ElandSession {
  private civilizationId = 0;
  private controller: SimulationController | null = null;
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

  begin(civilizationId: number, skySample: SkySample, characterIds?: string[]): Frame {
    this.civilizationId = civilizationId;
    this.skySample = skySample;
    this.controller = createSimulation({
      seed: 154 + civilizationId * 31,
      config: createDefaultSimulationConfig({
        civilizationNo: civilizationId,
        chaosIntensity: 0,
        endpoint: { kind: 'months', value: 9_999 },
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
      snapshots: new Map(),
    }]]);
    this.forkSequence = 0;
    return this.record(state, []);
  }

  model(): ModelProvider {
    return 'kimi';
  }

  private activeTimeline(): BranchTimeline {
    const timeline = this.branches.get(this.activeBranchId);
    if (!timeline) throw new Error('活动分支不存在');
    return timeline;
  }

  private inheritedFrames(timeline: BranchTimeline): Frame[] {
    if (!timeline.parentBranchId) return timeline.history;
    const parent = this.branches.get(timeline.parentBranchId);
    if (!parent) return timeline.history;
    return [
      ...this.inheritedFrames(parent).filter((frame) => frame.elapsedMonths < timeline.forkAtMonth),
      ...timeline.history,
    ];
  }

  private inheritedSnapshot(timeline: BranchTimeline, month: number): SimulationState | undefined {
    const local = timeline.snapshots.get(month);
    if (local) return local;
    if (!timeline.parentBranchId || month > timeline.forkAtMonth) return undefined;
    const parent = this.branches.get(timeline.parentBranchId);
    return parent ? this.inheritedSnapshot(parent, month) : undefined;
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
    timeline.history.push(frame);
    timeline.snapshots.set(frame.elapsedMonths, state);
    if (timeline.history.length > MAX_HISTORY_MONTHS) {
      const dropped = timeline.history.shift();
      if (dropped) timeline.snapshots.delete(dropped.elapsedMonths);
    }
    return frame;
  }

  latest(): Frame | null {
    return this.inheritedFrames(this.activeTimeline()).at(-1) ?? null;
  }

  async step(options: { skySample: SkySample }): Promise<Frame | null> {
    if (!this.controller || this.stepping) return this.latest();
    this.stepping = true;
    try {
      this.skySample = options.skySample;
      const env = ERA_TO_ENV[this.skySample.fate];
      const apiKey = loadLlmKey('kimi');
      if (!apiKey) throw new Error('未配置 KIMI_API_KEY，真实演化无法开始');
      const candidate = createSimulation({ state: this.controller.getState() });
      candidate.setExternalClimate(env.epoch, env.kind, env.severity);
      const state = await candidate.stepAsync(createServerLlmDecider(apiKey, 'kimi'));
      this.controller.restore(state);
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
    return this.inheritedFrames(this.activeTimeline()).find((frame) => frame.elapsedMonths === month) ?? null;
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
    this.activeBranchId = branchId;
    const branchFrame: Frame = { ...frame, branchId };
    this.branches.set(branchId, {
      id: branchId,
      parentBranchId: source.id,
      forkAtMonth: month,
      createdAt: new Date().toISOString(),
      history: [branchFrame],
      snapshots: new Map([[month, branchState]]),
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

export class ElandSessionManager {
  private readonly sessions = new Map<string, ElandSession>();

  begin(runId: string, civilizationId: number, skySample: SkySample, characterIds?: string[]): Frame {
    const session = new ElandSession(runId, skySample);
    this.sessions.set(runId, session);
    return session.begin(civilizationId, skySample, characterIds);
  }

  get(runId: string): ElandSession | null {
    return this.sessions.get(runId) ?? null;
  }
}

export const elandSessions = new ElandSessionManager();
