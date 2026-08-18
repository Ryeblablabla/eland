/** 领域状态到 UI 读取模型的纯投影。 */
import type { ActionVisualView, AgentHistoryItem, AgentHistoryView, EraKey, SocietyAgent, SocietyState } from '../societyContract';
import type { ClimateKind, EpochKind, SimulationState, WorldEvent } from './simulation';
import { Material, materialDefinition } from './domain/material';
import { ageMonths, isAlive, type PersonState } from './domain/person';
import { personalityScore } from './domain/personality';
import { WORLD_CELL_COUNT, columnMaterials, surfaceMaterial, topZ } from './world/grid';
import { biomeAt } from './world/biome';
import { CONTAINER_CAPACITY } from './domain/container';
import { animalAgeMonths, animalSpecies, isAnimalAlive, type AnimalState } from './domain/animal';
import type { PrimitiveAction, WorldRef } from './domain/action';
import { playerTextForEvent } from './projection/player-narrative';
import { portraitForPerson } from '../personPortraits';

export { projectPlayerNarrative } from './projection/player-narrative';

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
  'dehydrated-hibernation': '脱水休眠',
  cold: '寒冷', heat: '炎热', wound: '受伤', illness: '患病', aging: '衰老', pregnancy: '妊娠',
  'postpartum-recovery': '产后恢复', restrained: '拘束',
};

function needsFor(person: PersonState): SocietyAgent['needs'] {
  const physiological = Math.max(100 - person.body.health, 100 - person.body.hydration, 100 - person.body.nutrition);
  const safety = Math.max(person.conditions.reduce((value, condition) => Math.max(value, condition.stage * 25), 0), 100 - person.body.health);
  const socialSupport = person.relations.reduce((sum, relation) => sum + Math.max(0, relation.bond) + Math.max(0, relation.trust) * 0.35, 0)
    / Math.max(1, person.relations.length);
  const belonging = Math.max(0, 58 - socialSupport
    + (personalityScore(person, 'emotionality') - 50) * 0.18
    + (personalityScore(person, 'extraversion') - 50) * 0.12);
  const esteem = Math.max(10, (person.motiveSensitivity.control + person.motiveSensitivity.status) / 2 - 25);
  const selfActualization = Math.max(8, personalityScore(person, 'openness') - physiological * 0.45);
  const values = [physiological, safety, belonging, esteem, selfActualization].map((value) => Math.max(0, Math.min(100, value)));
  const dominantIndex = values.indexOf(Math.max(...values));
  return NEED_LEVELS.map(([level, label], index) => ({ level, label, intensity: values[index], dominant: index === dominantIndex }));
}

function materialForTarget(state: SimulationState, target: WorldRef): number | undefined {
  if (target.kind === 'inventory-stack') {
    return state.people.find((person) => person.id === target.personId)
      ?.inventory.find((stack) => stack.id === target.stackId)?.materialId;
  }
  if (target.kind === 'drop') return state.world.drops.find((drop) => drop.id === target.dropId)?.materialId;
  if (target.kind === 'container') return Material.Container;
  if (target.kind === 'voxel') {
    const { x, y, z } = target.position;
    return state.world.grid.voxels[x + y * state.world.grid.width + z * state.world.grid.width * state.world.grid.depth];
  }
  return undefined;
}

function targetIdentity(target: WorldRef | undefined): Pick<ActionVisualView, 'targetKind' | 'targetPersonId' | 'targetAnimalId'> {
  if (!target) return {};
  return {
    targetKind: target.kind,
    ...(target.kind === 'person' ? { targetPersonId: target.personId } : {}),
    ...(target.kind === 'animal' ? { targetAnimalId: target.animalId } : {}),
  };
}

function actionVisual(state: SimulationState, person: PersonState, action: PrimitiveAction): ActionVisualView {
  if (action.kind === 'move') return { actionKind: 'move' };
  if (action.kind === 'transfer') {
    const target = action.to.kind === 'person'
      ? { kind: 'person' as const, personId: action.to.personId }
      : undefined;
    return { actionKind: 'transfer', materialId: action.materialId, ...targetIdentity(target) };
  }
  if (action.kind === 'act') {
    const materialIds = action.targets
      .map((target) => materialForTarget(state, target))
      .filter((materialId): materialId is number => materialId !== undefined);
    const toolMaterialId = action.toolStackId
      ? person.inventory.find((stack) => stack.id === action.toolStackId)?.materialId
      : undefined;
    return {
      actionKind: 'act', operation: action.operation,
      ...targetIdentity(action.targets[0]),
      ...(materialIds[0] !== undefined ? { materialId: materialIds[0] } : {}),
      ...(materialIds.length ? { materialIds } : {}),
      ...(toolMaterialId !== undefined ? { toolMaterialId } : {}),
    };
  }
  if (action.kind === 'attend') {
    const toolMaterialId = action.instrumentStackId
      ? person.inventory.find((stack) => stack.id === action.instrumentStackId)?.materialId
      : undefined;
    return {
      actionKind: 'attend', ...targetIdentity(action.target),
      ...(toolMaterialId !== undefined ? { toolMaterialId } : {}),
      ...(materialForTarget(state, action.target) !== undefined ? { materialId: materialForTarget(state, action.target) } : {}),
    };
  }
  const toolMaterialId = action.carrierStackId
    ? person.inventory.find((stack) => stack.id === action.carrierStackId)?.materialId
    : undefined;
  return {
    actionKind: 'communicate', channel: action.channel, communicationKind: action.content.kind,
    ...(action.audience[0] ? { targetKind: 'person', targetPersonId: action.audience[0] } : {}),
    ...(toolMaterialId !== undefined ? { toolMaterialId } : {}),
  };
}

function recentActionFor(state: SimulationState, person: PersonState): ActionVisualView | undefined {
  const fact = [...state.lastStep, ...state.world.past.slice(-120)].reverse().find((event) => (
    event.kind === 'action' && event.who === person.id && event.atMonth === state.clock.elapsedMonths
  ));
  return fact?.kind === 'action' ? actionVisual(state, person, fact.action) : undefined;
}

function personStateOf(person: PersonState): SocietyAgent['state'] {
  if (!isAlive(person)) return 'dead';
  if (person.conditions.some((condition) => condition.kind === 'dehydrated-hibernation')) return 'hibernating';
  if (person.body.hydration < 10) return 'dehydrated';
  return 'active';
}

function historyCellLabel(state: SimulationState, cellId: number, z?: number): string {
  const x = cellId % state.world.grid.width;
  const y = Math.floor(cellId / state.world.grid.width);
  return `格位 ${x}, ${y}${z === undefined ? '' : ` · 高度 ${z}`}`;
}

function historyWorldRefLabel(state: SimulationState, target: WorldRef): string {
  if (target.kind === 'voxel') {
    const cellId = target.position.x + target.position.y * state.world.grid.width;
    return historyCellLabel(state, cellId, target.position.z);
  }
  if (target.kind === 'person') return state.people.find((person) => person.id === target.personId)?.name ?? '未知人物';
  if (target.kind === 'animal') {
    const animal = state.world.animals.find((item) => item.id === target.animalId);
    return animal ? animalSpecies(animal.speciesId).name : '未知动物';
  }
  if (target.kind === 'drop') {
    const drop = state.world.drops.find((item) => item.id === target.dropId);
    return drop ? `${materialDefinition(drop.materialId).name} · ${historyCellLabel(state, drop.cellId, drop.z)}` : '已消失的地面物品';
  }
  if (target.kind === 'container') {
    const container = state.containers.find((item) => item.id === target.containerId);
    const cellId = container ? container.position.x + container.position.y * state.world.grid.width : -1;
    return container ? `${materialDefinition(Material.Container).name} · ${historyCellLabel(state, cellId, container.position.z)}` : '未知容器';
  }
  const owner = state.people.find((person) => person.id === target.personId);
  const stack = owner?.inventory.find((item) => item.id === target.stackId);
  return `${owner?.name ?? '未知人物'}持有的${stack ? materialDefinition(stack.materialId).name : '物品'}`;
}

function historyHolderLabel(state: SimulationState, holder: Extract<PrimitiveAction, { kind: 'transfer' }>['from']): string {
  if (holder.kind === 'ground') return historyCellLabel(state, holder.cellId, holder.z);
  if (holder.kind === 'person') return state.people.find((person) => person.id === holder.personId)?.name ?? '未知人物';
  const container = state.containers.find((item) => item.id === holder.containerId);
  const cellId = container ? container.position.x + container.position.y * state.world.grid.width : -1;
  return container ? `${materialDefinition(Material.Container).name} · ${historyCellLabel(state, cellId, container.position.z)}` : '未知容器';
}

function actionHistoryDetail(state: SimulationState, event: Extract<WorldEvent, { kind: 'action' }>): string {
  const from = historyCellLabel(state, event.fromCellId, event.fromZ);
  const to = historyCellLabel(state, event.toCellId, event.toZ);
  if (event.action.kind === 'move') {
    const distance = Math.max(0, event.pathSegment.length - 1);
    return `${from} → ${to} · 路径 ${distance} 格`;
  }
  if (event.action.kind === 'transfer') {
    return `${from} · ${historyHolderLabel(state, event.action.from)} → ${historyHolderLabel(state, event.action.to)}`;
  }
  if (event.action.kind === 'act') {
    const action = event.action;
    const targets = action.targets.map((target) => historyWorldRefLabel(state, target)).join('、') || '无明确对象';
    const tool = action.toolStackId
      ? state.people.find((person) => person.id === event.who)?.inventory.find((stack) => stack.id === action.toolStackId)
      : undefined;
    return `${to} · 对象 ${targets}${tool ? ` · 使用 ${materialDefinition(tool.materialId).name}` : ''}`;
  }
  if (event.action.kind === 'attend') return `${to} · 观察 ${historyWorldRefLabel(state, event.action.target)}`;
  const audience = event.action.audience.map((id) => state.people.find((person) => person.id === id)?.name ?? '未知人物').join('、') || '身边的人';
  const channel = event.action.channel === 'voice' ? '交谈' : event.action.channel === 'gesture' ? '手势' : '记录';
  return `${to} · 通过${channel}面向 ${audience}`;
}

function personView(state: SimulationState, person: PersonState): SocietyAgent {
  const needs = needsFor(person);
  const active = state.intents.find((intent) => intent.id === person.activeIntentId && intent.status === 'active');
  const currentNeed = needs.find((need) => need.dominant)?.label ?? '维持生活';
  const visualAction = recentActionFor(state, person);
  return {
    id: person.id,
    name: person.name,
    portrait: portraitForPerson(person),
    title: person.profile.description,
    cellId: person.position.cellId,
    z: person.position.z,
    previousCellId: person.position.previousCellId,
    lastPath: person.position.lastPath,
    tickPath: person.position.tickPath,
    state: personStateOf(person),
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
    relations: person.relations.flatMap((relation) => {
      const other = state.people.find((candidate) => candidate.id === relation.personId);
      if (!other) return [];
      return [{
        personId: other.id,
        name: other.name,
        portrait: portraitForPerson(other),
        state: personStateOf(other),
        trust: relation.trust,
        bond: relation.bond,
        fear: relation.fear,
        sourceEventIds: [...relation.sourceEventIds],
      }];
    }),
    ...(visualAction ? { visualAction } : {}),
  };
}

function animalActivity(state: SimulationState, animal: AnimalState): NonNullable<SocietyState['animals'][number]['activity']> {
  if (!isAnimalAlive(animal)) return 'dead';
  const currentEvents = [...state.lastStep, ...state.world.past.slice(-160)].filter((event) => event.atMonth === state.clock.elapsedMonths);
  const animalFact = [...currentEvents].reverse().find((event) => (
    event.kind === 'environment' && event.change === 'animal' && event.diff.animalId === animal.id
  ));
  if (animalFact?.kind === 'environment') {
    if (animalFact.diff.process === 'attack-human') return 'attack';
    if (animalFact.diff.process === 'birth') return 'birth';
    if (animalFact.diff.process === 'forage') return 'graze';
  }
  const hunt = [...currentEvents].reverse().find((event) => event.kind === 'action'
    && event.action.kind === 'act'
    && event.action.operation === 'hunt'
    && event.action.targets.some((target) => target.kind === 'animal' && target.animalId === animal.id));
  if (hunt) return animal.health < 55 ? 'injured' : 'flee';
  const species = animalSpecies(animal.speciesId);
  if (animal.lastAteAtMonth === state.clock.elapsedMonths) return species.diet === 'predator' ? 'feed' : 'graze';
  if (animal.health < 45) return 'injured';
  if (animal.position.cellId !== animal.position.previousCellId || animal.position.z !== animal.position.previousZ) {
    return species.diet === 'predator' && animal.hunger >= 45 ? 'chase' : 'walk';
  }
  return 'idle';
}

export function toSocietyState(state: SimulationState): SocietyState {
  const { grid } = state.world;
  const civilizationIndex = state.civilization.civilizationIndex;
  const componentPoints = (key: keyof typeof civilizationIndex.components): number => {
    const component = civilizationIndex.components[key];
    return Math.round(component.score * component.weight * 100) / 100;
  };
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
      biomes: Array.from({ length: WORLD_CELL_COUNT }, (_, cell) => biomeAt(
        grid.generator.seed,
        cell % grid.width,
        Math.floor(cell / grid.width),
      )),
      activity: { traffic, transfer, action, attention },
    },
    agents: state.people.map((person) => personView(state, person)),
    animals: state.world.animals.filter((animal) => isAnimalAlive(animal) || animal.diedAtMonth === state.clock.elapsedMonths).map((animal) => {
      const species = animalSpecies(animal.speciesId);
      const age = animalAgeMonths(animal, state.clock.elapsedMonths);
      const ageBand = age < species.adultAtMonths ? 'juvenile'
        : age >= animal.lifespanMonths * 0.75 ? 'elder' : 'adult';
      return {
      id: animal.id,
      speciesId: animal.speciesId,
      name: species.name,
      cellId: animal.position.cellId,
      z: animal.position.z,
      previousCellId: animal.position.previousCellId,
      previousZ: animal.position.previousZ,
      health: animal.health,
      hunger: animal.hunger,
      sex: animal.sex,
      ageMonths: age,
      ageBand,
      activity: animalActivity(state, animal),
    }; }),
    drops: state.world.drops.map((drop) => ({ id: drop.id, materialId: drop.materialId, name: materialDefinition(drop.materialId).name, cellId: drop.cellId, z: drop.z, quantity: drop.quantity })),
    containers: state.containers.map((container) => ({
      id: container.id,
      materialId: Material.Container,
      name: materialDefinition(Material.Container).name,
      cellId: container.position.x + container.position.y * grid.width,
      z: container.position.z,
      capacity: CONTAINER_CAPACITY,
      usedCapacity: container.inventory.reduce((sum, stack) => sum + stack.quantity, 0),
      contents: container.inventory.map((stack) => ({ materialId: stack.materialId, name: materialDefinition(stack.materialId).name, quantity: stack.quantity })),
    })),
    structures: state.derived.structures.map((structure) => ({
      id: structure.id, name: structure.name, occupiedCells: structure.occupiedCells, interiorCells: structure.interiorCells, interiorPositions: structure.interiorPositions,
      componentCount: structure.sourceEventIds.length, complete: structure.complete,
      effects: { weatherProtection: structure.weatherProtection, thermalInsulation: structure.thermalInsulation, capacity: structure.capacity },
      sourceEventIds: structure.sourceEventIds,
      materialIds: [...structure.materialIds],
    })),
    intents: state.intents.map((intent) => {
      const person = state.people.find((candidate) => candidate.id === intent.ownerId);
      return {
        id: intent.id, ownerId: intent.ownerId, summary: intent.summary,
        ...(person ? actionVisual(state, person, intent.nextAction) : { actionKind: intent.nextAction.kind }),
        status: intent.status, progress: intent.progress, createdAtMonth: intent.createdAtMonth, lastProgressAtMonth: intent.lastProgressAtMonth,
      };
    }),
    regions: state.derived.regions.map(({ id, kind, cells, confidence, label }) => ({ id, kind, cells, confidence, ...(label ? { label } : {}) })),
    observations: {
      civilizationIndex: {
        formulaVersion: civilizationIndex.formulaVersion ?? 'unknown',
        total: civilizationIndex.total,
        calculatedAtMonth: civilizationIndex.calculatedAtMonth,
        stage: state.civilization.stage,
        components: {
          population: componentPoints('population'),
          territory: componentPoints('territory'),
          technology: componentPoints('technology'),
          social: componentPoints('social'),
          history: componentPoints('history'),
        },
      },
      practices: state.derived.practices.map(({ key, label, count, stability }) => ({ key, label, count, stability })),
      institutions: state.derived.institutions.map(({ key, label, note }) => ({ key, label, note })),
      milestones: state.derived.milestones.map(({
        id, label, note, capabilityId, catalogKind, mapLabel, domain, valence, phase, observedAtMonth,
        participantIds, affectedPersonIds, occurrenceCount,
      }) => ({
        id, label, note,
        ...(capabilityId !== undefined ? { capabilityId } : {}),
        ...(catalogKind ? { catalogKind } : {}),
        ...(mapLabel ? { mapLabel } : {}),
        ...(domain ? { domain } : {}),
        ...(valence ? { valence } : {}),
        ...(phase ? { phase } : {}),
        ...(observedAtMonth !== undefined ? { observedAtMonth } : {}),
        ...(participantIds?.length ? { participantIds: [...participantIds] } : {}),
        ...(affectedPersonIds?.length ? { affectedPersonIds: [...affectedPersonIds] } : {}),
        ...(occurrenceCount !== undefined ? { occurrenceCount } : {}),
      })),
    },
    weather: { ...state.civilization.weather },
  };
}

export function toAgentHistory(state: SimulationState, agentId: string, limit = 80): AgentHistoryView | null {
  if (!state.people.some((person) => person.id === agentId)) return null;
  const events = state.world.past.flatMap((event): AgentHistoryItem[] => {
    if (event.kind === 'decision-opportunity') {
      if (event.who !== agentId || event.triggered) return [];
      return [{ id: event.id, month: event.atMonth, orderInMonth: event.orderInMonth, cellId: event.cellId, kind: 'continuation', label: '照原计划行动', summary: '本月没有改动原来的安排。' }];
    }
    if (event.kind === 'decision') {
      if (event.who !== agentId) return [];
      return [{ id: event.id, month: event.atMonth, orderInMonth: event.orderInMonth, cellId: event.cellId, kind: 'decision', label: '作出选择', summary: playerTextForEvent(state, event), detail: historyCellLabel(state, event.cellId), ...(event.intentId ? { intentId: event.intentId } : {}), usedModel: event.usedModel }];
    }
    if (event.kind === 'action') {
      if (event.who !== agentId) return [];
      const label = event.status === 'completed' ? '行动完成' : event.status === 'blocked' ? '行动受阻' : event.status === 'failed' ? '行动失败' : '正在行动';
      return [{ id: event.id, month: event.atMonth, orderInMonth: event.orderInMonth, actionTick: event.actionTick, cellId: event.cellId, kind: 'action', label: event.cause === 'survival-reflex' ? `应对眼前危险 · ${label}` : label, summary: playerTextForEvent(state, event), detail: actionHistoryDetail(state, event), ...(event.intentId ? { intentId: event.intentId } : {}), status: event.status }];
    }
    if (event.kind === 'environment' && event.who === agentId && (event.change === 'death' || event.change === 'condition' || event.change === 'body')) {
      return [{ id: event.id, month: event.atMonth, orderInMonth: event.orderInMonth, cellId: event.cellId, kind: 'life', label: event.change === 'death' ? '生命终止' : event.change === 'condition' ? '状态变化' : '身体变化', summary: playerTextForEvent(state, event), detail: historyCellLabel(state, event.cellId), status: event.change }];
    }
    return [];
  });
  return { agentId, throughMonth: state.clock.elapsedMonths, events: events.slice(-Math.max(1, Math.min(240, Math.floor(limit)))) };
}

export function monthSpeaker(state: SimulationState, events: WorldEvent[]): string | null {
  const fact = [...events].reverse().find((event) => 'who' in event && event.who);
  return fact && 'who' in fact ? state.people.find((person) => person.id === fact.who)?.name ?? null : null;
}
