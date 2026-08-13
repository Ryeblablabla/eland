/** 领域状态到 UI 读取模型的纯投影。 */
import type { AgentHistoryItem, AgentHistoryView, EraKey, SocietyAgent, SocietyState } from '../societyContract';
import type { ClimateKind, EpochKind, SimulationState, WorldEvent } from './simulation';
import { calendarDate } from './domain/calendar';
import { materialDefinition } from './domain/material';
import { ageMonths, isAlive, type PersonState } from './domain/person';
import { WORLD_CELL_COUNT, columnMaterials, surfaceMaterial, topZ } from './world/grid';

export const ERA_TO_ENV: Record<EraKey, { epoch: EpochKind; kind: ClimateKind; severity: number }> = {
  stable: { epoch: 'stable', kind: 'temperate', severity: 1 },
  chaotic: { epoch: 'chaotic', kind: 'temperate', severity: 4 },
  'chaotic-heat': { epoch: 'chaotic', kind: 'heat', severity: 7 },
  'chaotic-cold': { epoch: 'chaotic', kind: 'cold', severity: 7 },
  burned: { epoch: 'chaotic', kind: 'fire', severity: 10 },
  frozen: { epoch: 'chaotic', kind: 'cold', severity: 10 },
  extinct: { epoch: 'chaotic', kind: 'fire', severity: 10 },
};

const NEED_LEVELS = [
  ['physiological', '生理需求'],
  ['safety', '安全需求'],
  ['belonging', '归属与爱'],
  ['esteem', '尊重需求'],
  ['selfActualization', '自我实现'],
] as const;

const CONDITION_LABELS: Record<string, string> = {
  cold: '寒冷', heat: '炎热', wound: '受伤', illness: '患病', pregnancy: '妊娠', restrained: '拘束',
};

function needsFor(person: PersonState): SocietyAgent['needs'] {
  const physiological = Math.max(100 - person.body.health, 100 - person.body.hydration, 100 - person.body.nutrition);
  const safety = Math.max(person.conditions.reduce((value, condition) => Math.max(value, condition.stage * 25), 0), 100 - person.body.health);
  const belonging = Math.max(0, 72 - person.driveBias.affiliation - person.relations.reduce((sum, relation) => sum + relation.bond, 0) / Math.max(1, person.relations.length));
  const esteem = Math.max(10, (person.driveBias.autonomy + person.driveBias.recognition) / 2 - 25);
  const selfActualization = Math.max(8, person.driveBias.inquiryCreation - physiological * 0.45);
  const values = [physiological, safety, belonging, esteem, selfActualization].map((value) => Math.max(0, Math.min(100, value)));
  const dominantIndex = values.indexOf(Math.max(...values));
  return NEED_LEVELS.map(([level, label], index) => ({ level, label, intensity: values[index], dominant: index === dominantIndex }));
}

function personView(state: SimulationState, person: PersonState): SocietyAgent {
  const needs = needsFor(person);
  const active = state.intents.find((intent) => intent.id === person.activeIntentId && intent.status === 'active');
  const currentNeed = needs.find((need) => need.dominant)?.label ?? '维持生活';
  return {
    id: person.id,
    name: person.name,
    title: person.profile.description,
    cellId: person.position.cellId,
    previousCellId: person.position.previousCellId,
    lastPath: person.position.lastPath,
    state: !isAlive(person) ? 'dead' : person.body.hydration < 10 ? 'dehydrated' : 'active',
    doing: person.currentActionText,
    ...(person.activeIntentId ? { activeIntentId: person.activeIntentId } : {}),
    sex: person.sex,
    lifespanMonths: person.lifespanMonths,
    generation: person.generation,
    respect: Math.round(person.relations.reduce((sum, relation) => sum + relation.trust, 0) / Math.max(1, person.relations.length)),
    mind: {
      want: `当前最迫切的是${currentNeed}`,
      choice: person.lastDecisionText,
      ought: active ? `意图：${active.summary}` : person.knowledge.at(-1)?.summary ?? '只依据自己见过和经历过的事实',
    },
    needs,
    body: { ...person.body, ageMonths: ageMonths(person, state.clock.elapsedMonths) },
    conditions: person.conditions.map((condition) => ({ id: condition.id, kind: condition.kind, label: CONDITION_LABELS[condition.kind] ?? condition.kind, stage: condition.stage, sinceMonth: condition.sinceMonth })),
    inventory: person.inventory.map((stack) => ({ id: stack.id, materialId: stack.materialId, name: materialDefinition(stack.materialId).name, quantity: stack.quantity })),
  };
}

export function toSocietyState(state: SimulationState): SocietyState {
  const { grid } = state.world;
  const traffic = new Array<number>(WORLD_CELL_COUNT).fill(0);
  const transfer = new Array<number>(WORLD_CELL_COUNT).fill(0);
  const action = new Array<number>(WORLD_CELL_COUNT).fill(0);
  const attention = new Array<number>(WORLD_CELL_COUNT).fill(0);
  for (const event of state.world.past) {
    if (event.kind !== 'action') continue;
    if (event.action.kind === 'move') event.pathSegment.forEach((cell) => { traffic[cell] += 1; });
    else if (event.action.kind === 'transfer') transfer[event.cellId] += 1;
    else if (event.action.kind === 'attend') attention[event.cellId] += 1;
    else action[event.cellId] += 1;
  }
  return {
    world: {
      width: grid.width,
      height: grid.depth,
      levels: grid.levels,
      generator: grid.generator,
      palette: grid.palette.map(({ id, key, name, color, tags }) => ({ id, key, name, color, tags: [...tags] })),
      surface: Array.from({ length: WORLD_CELL_COUNT }, (_, cell) => surfaceMaterial(grid, cell)),
      elevation: Array.from({ length: WORLD_CELL_COUNT }, (_, cell) => topZ(grid, cell)),
      columns: Array.from({ length: WORLD_CELL_COUNT }, (_, cell) => columnMaterials(grid, cell)),
      activity: { traffic, transfer, action, attention },
    },
    agents: state.people.map((person) => personView(state, person)),
    drops: state.world.drops.map((drop) => ({ id: drop.id, materialId: drop.materialId, name: materialDefinition(drop.materialId).name, cellId: drop.cellId, quantity: drop.quantity })),
    structures: state.derived.structures.map((structure) => ({
      id: structure.id, name: structure.name, occupiedCells: structure.occupiedCells, interiorCells: structure.interiorCells,
      componentCount: structure.sourceEventIds.length, complete: structure.complete,
      effects: { weatherProtection: structure.weatherProtection, thermalInsulation: structure.thermalInsulation, capacity: structure.capacity },
      sourceEventIds: structure.sourceEventIds,
    })),
    intents: state.intents.map((intent) => ({ id: intent.id, ownerId: intent.ownerId, summary: intent.summary, actionKind: intent.nextAction.kind, status: intent.status, progress: intent.progress, createdAtMonth: intent.createdAtMonth, lastProgressAtMonth: intent.lastProgressAtMonth })),
    regions: state.derived.regions.map(({ id, kind, cells, confidence, label }) => ({ id, kind, cells, confidence, ...(label ? { label } : {}) })),
    observations: {
      practices: state.derived.practices.map(({ key, label, count, stability }) => ({ key, label, count, stability })),
      institutions: state.derived.institutions.map(({ key, label, note }) => ({ key, label, note })),
      milestones: state.derived.milestones.map(({ id, label, note }) => ({ id, label, note })),
    },
  };
}

export function toAgentHistory(state: SimulationState, agentId: string, limit = 80): AgentHistoryView | null {
  if (!state.people.some((person) => person.id === agentId)) return null;
  const events = state.world.past.flatMap((event): AgentHistoryItem[] => {
    if (event.kind === 'decision-opportunity') {
      if (event.who !== agentId || event.triggered) return [];
      return [{ id: event.id, month: event.atMonth, orderInMonth: event.orderInMonth, cellId: event.cellId, kind: 'continuation', label: '延续意图', summary: event.result }];
    }
    if (event.kind === 'decision') {
      if (event.who !== agentId) return [];
      return [{ id: event.id, month: event.atMonth, orderInMonth: event.orderInMonth, cellId: event.cellId, kind: 'decision', label: '关键决策', summary: event.result, ...(event.intentId ? { intentId: event.intentId } : {}), usedModel: event.usedModel }];
    }
    if (event.kind === 'action') {
      if (event.who !== agentId) return [];
      const label = event.status === 'completed' ? '完成原子动作' : event.status === 'blocked' ? '动作受阻' : event.status === 'failed' ? '动作失败' : '推进原子动作';
      return [{ id: event.id, month: event.atMonth, orderInMonth: event.orderInMonth, cellId: event.cellId, kind: 'action', label: event.cause === 'survival-reflex' ? `生存反射 · ${label}` : label, summary: event.result, ...(event.intentId ? { intentId: event.intentId } : {}), status: event.status }];
    }
    if (event.kind === 'environment' && event.who === agentId && (event.change === 'death' || event.change === 'condition' || event.change === 'body')) {
      return [{ id: event.id, month: event.atMonth, orderInMonth: event.orderInMonth, cellId: event.cellId, kind: 'life', label: event.change === 'death' ? '生命终止' : event.change === 'condition' ? '状态变化' : '身体变化', summary: event.result, status: event.change }];
    }
    return [];
  });
  return { agentId, throughMonth: state.clock.elapsedMonths, events: events.slice(-Math.max(1, Math.min(240, Math.floor(limit)))) };
}

export function eventToChronicle(event: WorldEvent): { text: string; tone: 'plain' | 'good' | 'bad' | 'era' } | null {
  if (event.kind === 'decision-opportunity' && !event.triggered) return null;
  const tone = event.kind === 'environment' && event.change === 'death' ? 'bad'
    : event.kind === 'action' && event.status === 'completed' ? 'good'
      : event.kind === 'environment' && event.change === 'climate' ? 'era' : 'plain';
  return { text: `${calendarDate(event.atMonth).label}：${event.result}`, tone };
}

export function monthSpeaker(state: SimulationState, events: WorldEvent[]): string | null {
  const fact = [...events].reverse().find((event) => 'who' in event && event.who);
  return fact && 'who' in fact ? state.people.find((person) => person.id === fact.who)?.name ?? null : null;
}
