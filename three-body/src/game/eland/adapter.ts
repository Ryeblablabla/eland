/**
 * ELAND 适配器 —— 把社会鱼缸引擎落到三体游戏的"人间态"。
 *
 * 职责：
 *  1. 持有 ELAND SimulationController，每年 step 一次（同步 Mock 决策；LLM 决策接入点预留）
 *  2. 天象覆盖：引擎内部 rollEpoch 已被 chaosIntensity=0 中和，
 *     每步前把三体宇宙纪元写回控制器，让当年的生存与决策使用同一权威天象
 *  3. 把 SimulationState 翻译为游戏地图消费的 SocietyState 契约
 */
import {
  createSimulation,
  createDefaultSimulationConfig,
  type BatchDecider,
  type SimulationController,
  type SimulationState,
  type WorldEvent,
} from './simulation';
import { createDeepSeekDecider } from './deepseek-decider';
import type { EraKey, SocietyAgent, SocietyState } from '../societyContract';

/** 我们的纪元 → ELAND 环境（epoch + climate + severity） */
export const ERA_TO_ENV: Record<EraKey, { epoch: 'stable' | 'chaotic'; kind: 'temperate' | 'cold' | 'heat' | 'fire'; severity: number }> = {
  stable: { epoch: 'stable', kind: 'temperate', severity: 1 },
  chaotic: { epoch: 'chaotic', kind: 'temperate', severity: 4 },
  'chaotic-heat': { epoch: 'chaotic', kind: 'heat', severity: 6 },
  'chaotic-cold': { epoch: 'chaotic', kind: 'cold', severity: 6 },
  burned: { epoch: 'chaotic', kind: 'fire', severity: 9 },
  frozen: { epoch: 'chaotic', kind: 'cold', severity: 9 },
  extinct: { epoch: 'chaotic', kind: 'cold', severity: 9 },
};

export interface YearResult {
  state: SimulationState;
  events: WorldEvent[];
}

export class ElandRuntime {
  private controller: SimulationController;
  private decider: BatchDecider | null = null;

  constructor(seed: number, civNo: number) {
    this.controller = createSimulation({
      seed,
      config: createDefaultSimulationConfig({
        civilizationNo: civNo,
        startingPoint: 'records', // 道路与观测刻痕起点
        chaosIntensity: 0,        // 引擎内置掷骰关闭：天象由三体宇宙权威决定
        endpoint: { kind: 'ticks', value: 99999 },
      }),
    });
  }

  getState(): SimulationState {
    return this.controller.getState();
  }

  /** 把宇宙层的权威天象写回控制器，供本年生存与决策共同使用。 */
  private applySky(era: EraKey): void {
    const env = ERA_TO_ENV[era];
    this.controller.setExternalClimate(env.epoch, env.kind, env.severity);
  }

  /** 推进一年（Mock 同步决策，LLM 不可用时的回退） */
  stepYear(era: EraKey): YearResult {
    this.applySky(era);
    const state = this.controller.step();
    return { state, events: state.lastStep };
  }

  /** 推进一年（LLM 异步决策；个别人物决策失败时引擎自动回退 Mock） */
  async stepYearLLM(era: EraKey): Promise<YearResult> {
    if (!this.decider) this.decider = createDeepSeekDecider();
    this.applySky(era);
    const state = await this.controller.stepAsync(this.decider);
    return { state, events: state.lastStep };
  }
}

// ---------------------------------------------------------------------------
// SimulationState → SocietyState 契约翻译
// ---------------------------------------------------------------------------

const LEVEL_LABEL: Record<string, string> = {
  physiological: '活下去',
  safety: '求得安稳',
  belonging: '融入群体',
  esteem: '赢得尊重',
  selfActualization: '实现自我',
};

export function toSocietyState(state: SimulationState): SocietyState {
  const locIds = state.world.space.locations.map((l) => l.id);
  const locIndex = (id: string) => Math.max(0, locIds.indexOf(id));

  const agents: SocietyAgent[] = state.agents.map((a) => {
    const dominant = a.mind.needs.layers.find((l) => l.level === a.mind.needs.dominantLevel);
    const want = dominant?.activeNeeds[0]?.label ?? LEVEL_LABEL[a.mind.needs.dominantLevel] ?? '活着';
    return {
      id: a.id,
      name: a.name,
      title: a.profile?.description?.split(/[；;。]/)[0] ?? '',
      loc: locIndex(a.locationId),
      state: a.body.state, // active / dehydrated / dead
      doing: a.limbs.actionText || '静思',
      sex: a.body.sex,
      lifespanYears: a.body.lifespanYears,
      generation: a.lineage.generation,
      respect: a.standing.respect,
      predictionRecord: { correct: a.standing.correctPredictions, failed: a.standing.failedPredictions },
      pregnant: Boolean(a.body.pregnancy),
      mind: {
        want,
        choice: a.mind.cognition.choice || a.limbs.actionText || '——',
        ought: a.mind.cognition.knowledge.at(-1)?.claim ?? '尚无成文认识',
      },
      needs: a.mind.needs.layers.map((l) => ({
        level: l.level,
        label: l.label,
        intensity: l.intensity,
        dominant: l.level === a.mind.needs.dominantLevel,
      })),
      body: {
        health: a.body.health,
        nutrition: a.body.nutrition,
        hydration: a.body.hydration,
        fatigue: a.body.fatigue,
        ageYears: a.body.ageYears,
      },
    };
  });

  const routes = state.world.space.routes.map((r) => ({
    id: r.id,
    from: locIndex(r.from),
    to: locIndex(r.to),
    traffic: r.traffic,
    state: r.state,
  }));

  const structures: NonNullable<SocietyState['structures']> = [];
  for (const m of state.world.matter) {
    if (m.construction && m.holder.kind === 'space') {
      const progress = Math.min(100, (m.construction.progress / m.construction.requiredMass) * 100);
      structures.push({
        id: m.id,
        name: m.name,
        loc: locIndex(m.holder.id),
        progress,
        complete: m.construction.complete,
        traits: m.traits,
        composition: m.composition,
        effects: m.construction.effects ? {
          weatherProtection: m.construction.effects.weatherProtection,
          thermalInsulation: m.construction.effects.thermalInsulation,
          enclosure: m.construction.effects.enclosure,
          capacity: m.construction.effects.capacity,
        } : undefined,
        useCount: m.construction.useEventIds?.length ?? 0,
        sourceEventIds: m.sourceEventIds ?? [],
      });
    }
  }

  return {
    agents,
    routes,
    locations: state.world.space.locations.map((l) => {
      // 开发度：完工建筑 → 2；进行中的工地/火种/记录刻痕 → 1；否则荒野
      const here = state.world.matter.filter((m) => m.holder.kind === 'space' && m.holder.id === l.id);
      const hasCompleted = here.some((m) => m.construction?.complete);
      const hasTrace = here.some(
        (m) => (m.construction && !m.construction.complete) || m.traits.includes('burning') || (m.records?.length ?? 0) > 0,
      );
      return {
        id: l.id,
        name: l.name,
        x: l.x,
        y: l.y,
        dev: (hasCompleted ? 2 : hasTrace ? 1 : 0) as 0 | 1 | 2,
        terrain: { ...l.terrain, irrigated: Boolean(l.terrain.irrigated) },
        matter: here
          .filter((m) => m.quantity > 0 && m.kind !== 'metabolized')
          .map((m) => ({ kind: m.kind, name: m.name, quantity: m.quantity, traits: m.traits })),
      };
    }),
    structures,
    observations: {
      practices: state.derived.practices.map(({ key, label, count, stability }) => ({ key, label, count, stability })),
      institutions: state.derived.institutions.map(({ key, label, note }) => ({ key, label, note })),
      milestones: state.derived.milestones.map(({ id, label, note }) => ({ id, label, note })),
    },
  };
}

/** 编年史条目化：把 ELAND 世界事件翻译为史册语言 */
export function eventToChronicle(state: SimulationState, ev: WorldEvent): { text: string; tone: 'plain' | 'good' | 'bad' | 'era'; kind: 'action' | 'prediction' | 'epoch' } | null {
  if (ev.kind === 'action') {
    const who = state.agents.find((a) => a.id === ev.who)?.name ?? '有人';
    const resultAlreadyNamesActor = ev.result.startsWith(who);
    return { text: (resultAlreadyNamesActor ? ev.result : `${who}：${ev.result}`).slice(0, 72), tone: 'plain', kind: 'action' };
  }
  if (ev.change === 'prediction') {
    const confirmed = (ev.diff as { confirmed?: boolean } | undefined)?.confirmed;
    return { text: ev.result.slice(0, 72), tone: confirmed ? 'good' : 'bad', kind: 'prediction' };
  }
  if (ev.change === 'birth') {
    return { text: ev.result.slice(0, 72), tone: 'good', kind: 'epoch' };
  }
  if (ev.change === 'survival') {
    const died = (ev.diff as { bodyState?: unknown }).bodyState === 'dead';
    const childCare = (ev.diff as { cause?: unknown }).cause === 'dependent-child-care';
    return { text: ev.result.slice(0, 72), tone: died ? 'bad' : childCare ? 'good' : 'era', kind: 'epoch' };
  }
  if (ev.change === 'epoch') {
    return { text: ev.result.slice(0, 72), tone: 'era', kind: 'epoch' };
  }
  return { text: ev.result.slice(0, 72), tone: 'plain', kind: 'action' };
}

/** 当年主角：第一个行动事件的人物（地图高亮用） */
export function yearSpeaker(state: SimulationState, events: WorldEvent[]): string | null {
  const first = events.find((e) => e.kind === 'action');
  if (!first || first.kind !== 'action') return null;
  return state.agents.find((a) => a.id === first.who)?.name ?? null;
}
