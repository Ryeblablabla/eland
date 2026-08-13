/**
 * 服务端演化会话 —— ELAND runtime 的后端宿主。
 *
 * 设计要点：
 *  - 演化推进权在后端：默认暂停，只在收到 step/play 指令时推进（LLM 调用进程内直发）
 *  - 每年一帧历史（社会状态 + 史册条目 + 世界快照），支持回放（零 LLM）与截断续演
 *  - 天象由客户端宇宙层通过 setEra 推送，引擎内置掷骰保持关闭
 */
import {
  createSimulation,
  createDefaultSimulationConfig,
  type BatchDecider,
  type SimulationController,
  type SimulationState,
} from '../src/game/eland/simulation';
import { ERA_TO_ENV, eventToChronicle, toSocietyState, yearSpeaker } from '../src/game/eland/adapter';
import { handleDecide, summarizeYearWithModel, type YearSummaryInput } from './deepseek-decide';
import { loadLlmKey } from './env';
import { DEFAULT_MODEL_PROVIDER, normalizeModelProvider, type ModelProvider } from '../src/game/llm';
import type { GameFrame, SkySample } from '../src/game/societyContract';

export interface FrameEntry {
  text: string;
  tone: 'plain' | 'good' | 'bad' | 'era';
  kind: 'action' | 'prediction' | 'epoch';
}

export type Frame = GameFrame;

const MAX_HISTORY = 600;
interface StepOptions {
  fast?: boolean;
  skySample: SkySample;
}

export class ElandSession {
  private civilizationId = 0;
  private controller: SimulationController | null = null;
  private stepping = false;
  private history: Frame[] = [];
  private snapshots = new Map<number, SimulationState>();
  private modelProvider: ModelProvider = DEFAULT_MODEL_PROVIDER;
  private skySample: SkySample;
  readonly runId: string;

  constructor(runId: string, initialSkySample: SkySample) {
    this.runId = runId;
    this.skySample = initialSkySample;
  }

  /** LLM 决策器：按当前会话选择调用模型，失败返回 null 由引擎回退 Mock */
  private decider: BatchDecider = {
    decideAll: async (contexts) => {
      if (!contexts.length) return [];
      const provider = this.modelProvider;
      const result = await handleDecide({
        contexts: contexts.map((context) => ({ agentId: context.agent.id, state: context.state })),
      }, loadLlmKey(provider), provider);
      const body = result.body as { decisions?: (unknown | null)[] };
      if (result.status !== 200 || !Array.isArray(body.decisions)) return contexts.map(() => null);
      return body.decisions as never;
    },
  };

  begin(civilizationId: number, skySample: SkySample, provider?: unknown, characterIds?: string[]): Frame {
    if (provider !== undefined) this.setModel(provider);
    this.civilizationId = civilizationId;
    this.skySample = skySample;
    const simulationConfig = createDefaultSimulationConfig({
      civilizationNo: civilizationId,
      startingPoint: 'origin',
      chaosIntensity: 0,
      endpoint: { kind: 'ticks', value: 99999 },
      ...(characterIds && characterIds.length > 0 ? { characterIds } : {}),
    });
    this.controller = createSimulation({ seed: 154 + civilizationId * 31, config: simulationConfig });
    const env = ERA_TO_ENV[skySample.fate];
    this.controller.setExternalClimate(env.epoch, env.kind, env.severity);
    this.history = [];
    this.snapshots.clear();
    return this.record(this.controller.getState(), []);
  }

  setModel(provider: unknown): ModelProvider {
    this.modelProvider = normalizeModelProvider(provider);
    return this.modelProvider;
  }

  model(): ModelProvider {
    return this.modelProvider;
  }

  private record(state: SimulationState, events: SimulationState['lastStep'], entries: FrameEntry[] = []): Frame {
    const frame: Frame = {
      runId: this.runId,
      civilizationId: this.civilizationId,
      civilizationYear: state.tick - state.civilization.startedAtTick,
      universeTime: this.skySample.toTime,
      skySample: this.skySample,
      society: toSocietyState(state),
      civilizationEnd: state.civilization.status === 'ended' && state.civilization.outcome
        ? {
            kind: state.civilization.outcome.kind,
            cause: state.civilization.outcome.cause,
            summary: state.civilization.outcome.summary,
          }
        : null,
      entries,
      speaker: yearSpeaker(state, events),
    };
    this.history.push(frame);
    this.snapshots.set(frame.civilizationYear, state);
    if (this.history.length > MAX_HISTORY) {
      const dropped = this.history.shift()!;
      this.snapshots.delete(dropped.civilizationYear);
    }
    return frame;
  }

  private async summarizeYear(before: SimulationState, after: SimulationState, events: SimulationState['lastStep']): Promise<FrameEntry> {
    const livingBefore = before.agents.filter((agent) => agent.body.state !== 'dead');
    const livingAfter = after.agents.filter((agent) => agent.body.state !== 'dead');
    const beforeCompleted = new Set(before.world.matter.filter((matter) => matter.construction?.complete).map((matter) => matter.id));
    const completedStructures = after.world.matter.filter((matter) => matter.construction?.complete && !beforeCompleted.has(matter.id)).map((matter) => matter.name);
    const beforeMilestones = new Set(before.derived.milestones.map((milestone) => milestone.id));
    const newMilestones = after.derived.milestones.filter((milestone) => !beforeMilestones.has(milestone.id)).map((milestone) => milestone.label);
    const born = after.agents.filter((agent) => !before.agents.some((previous) => previous.id === agent.id)).map((agent) => agent.name);
    const died = after.agents.filter((agent) => agent.body.state === 'dead' && before.agents.some((previous) => previous.id === agent.id && previous.body.state !== 'dead')).map((agent) => agent.name);
    const environmentChanges = events
      .filter((event) => event.kind === 'environment' && (event.change === 'illness' || event.change === 'injury' || event.change === 'birth' || event.change === 'survival'))
      .map((event) => event.result);
    const tribeChanges = [
      before.civilization.stage !== after.civilization.stage ? `部落阶段由“${before.civilization.stage}”进入“${after.civilization.stage}”` : '',
      ...completedStructures.map((name) => `${name}建成`),
      ...newMilestones.map((label) => `形成${label}`),
    ].filter(Boolean);
    const input: YearSummaryInput = {
      year: after.tick,
      climate: { epoch: after.civilization.epoch, kind: after.civilization.climate.kind, severity: after.civilization.climate.severity },
      people: {
        before: livingBefore.length,
        after: livingAfter.length,
        active: after.agents.filter((agent) => agent.body.state === 'active').length,
        dehydrated: after.agents.filter((agent) => agent.body.state === 'dehydrated').length,
        dead: after.agents.filter((agent) => agent.body.state === 'dead').length,
        changes: [...(born.length ? [`新生：${born.join('、')}`] : []), ...(died.length ? [`死亡：${died.join('、')}`] : []), ...environmentChanges].slice(0, 10),
      },
      tribe: {
        stageBefore: before.civilization.stage,
        stageAfter: after.civilization.stage,
        integrityBefore: before.civilization.integrity,
        integrityAfter: after.civilization.integrity,
        changes: tribeChanges.slice(0, 8),
      },
      facts: events.map((event) => event.result).slice(0, 18),
    };
    const provider = this.modelProvider;
    const modelSummary = await summarizeYearWithModel(input, loadLlmKey(provider), provider);
    const fallbackFacts = events
      .map((event) => eventToChronicle(after, event)?.text)
      .filter((text): text is string => Boolean(text))
      .slice(0, 3);
    const fallback = [
      fallbackFacts.join('；'),
      tribeChanges.length ? `部落方面，${tribeChanges.slice(0, 2).join('，')}。` : `部落维持在${after.civilization.stage}阶段。`,
    ].filter(Boolean).join(' ').slice(0, 180);
    const prediction = events.find((event) => event.kind === 'environment' && event.change === 'prediction');
    const deathOccurred = died.length > 0;
    const positiveChange = born.length > 0 || completedStructures.length > 0 || newMilestones.length > 0;
    return {
      text: modelSummary ?? fallback ?? `这一年，${livingAfter.length}名成员维持着部落生活。`,
      tone: deathOccurred ? 'bad' : positiveChange ? 'good' : 'plain',
      kind: prediction ? 'prediction' : 'epoch',
    };
  }

  latest(): Frame | null {
    return this.history.at(-1) ?? null;
  }

  /** 推进一年（LLM 优先，整体失败回退 Mock） */
  async step(options: StepOptions): Promise<Frame | null> {
    if (!this.controller || this.stepping) return this.latest();
    this.stepping = true;
    try {
      this.skySample = options.skySample;
      const env = ERA_TO_ENV[this.skySample.fate];
      this.controller.setExternalClimate(env.epoch, env.kind, env.severity);
      const before = this.controller.getState();
      let state: SimulationState;
      try {
        state = await this.controller.stepAsync(this.decider);
      } catch {
        state = this.controller.step();
      }
      const annualEntry = await this.summarizeYear(before, state, state.lastStep);
      return this.record(state, state.lastStep, [annualEntry]);
    } finally {
      this.stepping = false;
    }
  }

  /** 历史列表（回放/续演选择器用） */
  historyList(): { year: number; summary: string }[] {
    return this.history.map((f) => ({ year: f.civilizationYear, summary: f.entries[0]?.text ?? '' }));
  }

  frameAt(year: number): Frame | null {
    return this.history.find((f) => f.civilizationYear === year) ?? null;
  }

  /** 从某年截断，重新演化（恢复世界快照） */
  seek(year: number): Frame | null {
    const frame = this.frameAt(year);
    const snap = frame ? this.snapshots.get(frame.civilizationYear) : undefined;
    if (!snap || !this.controller) return null;
    this.controller.restore(snap);
    this.history = this.history.filter((f) => f.civilizationYear <= year);
    for (const t of [...this.snapshots.keys()]) if (t > year) this.snapshots.delete(t);
    return this.latest();
  }
}

export class ElandSessionManager {
  private readonly sessions = new Map<string, ElandSession>();

  begin(runId: string, civilizationId: number, skySample: SkySample, provider?: unknown, characterIds?: string[]): Frame {
    const session = new ElandSession(runId, skySample);
    this.sessions.set(runId, session);
    return session.begin(civilizationId, skySample, provider, characterIds);
  }

  get(runId: string): ElandSession | null {
    return this.sessions.get(runId) ?? null;
  }
}

export const elandSessions = new ElandSessionManager();
