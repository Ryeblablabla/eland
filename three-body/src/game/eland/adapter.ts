/** 领域状态到 UI 读取模型的纯投影。 */
import type { ActionVisualView, AgentHistoryItem, AgentHistoryView, EraKey, SocietyAgent, SocietyState } from '../societyContract';
import type { ClimateKind, EpochKind, SimulationState, TerminalCatastropheKind, WorldEvent } from './simulation';
import { Material, materialDefinition } from './domain/material';
import { ageMonths, isAlive, isDormantDehydratedHibernating, type PersonState } from './domain/person';
import { personalityScore } from './domain/personality';
import { CONTAINER_CAPACITY } from './domain/container';
import { animalAgeMonths, animalSpecies, isAnimalAlive, type AnimalState } from './domain/animal';
import type { PrimitiveAction, WorldRef } from './domain/action';
import { actionActivityIndex } from './domain/event-index';
import { playerTextForEvent } from './projection/player-narrative';
import { projectSocietyWorld } from './projection/society-world-cache';
import { portraitForPerson } from '../personPortraits';
import { voxelAt } from './world/grid';
import { traitDefinition, traitStatesOf } from './domain/trait';

export { projectPlayerNarrative } from './projection/player-narrative';

export const ERA_TO_ENV: Record<EraKey, {
  epoch: EpochKind;
  kind: ClimateKind;
  severity: number;
  terminalCatastrophe?: TerminalCatastropheKind;
}> = {
  stable: { epoch: 'stable', kind: 'temperate', severity: 1 },
  chaotic: { epoch: 'chaotic', kind: 'temperate', severity: 4 },
  'chaotic-heat': { epoch: 'chaotic', kind: 'heat', severity: 7 },
  'chaotic-cold': { epoch: 'chaotic', kind: 'cold', severity: 7 },
  burned: { epoch: 'chaotic', kind: 'fire', severity: 10, terminalCatastrophe: 'triple-sun-vaporization' },
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

type ActionEvent = Extract<WorldEvent, { kind: 'action' }>;
type EnvironmentEvent = Extract<WorldEvent, { kind: 'environment' }>;
type InventoryStack = PersonState['inventory'][number];

interface StateLookup {
  peopleById: Map<string, PersonState>;
  intentsById: Map<string, SimulationState['intents'][number]>;
  animalsById: Map<string, AnimalState>;
  dropsById: Map<string, SimulationState['world']['drops'][number]>;
  containersById: Map<string, SimulationState['containers'][number]>;
  inventoryByPersonId: Map<string, Map<string, InventoryStack>>;
}

interface SocietyProjectionLookup extends StateLookup {
  recentActionByPersonId: Map<string, ActionEvent>;
  latestAnimalFactById: Map<string, EnvironmentEvent>;
  huntedAnimalIds: Set<string>;
}

function stateLookup(state: SimulationState): StateLookup {
  return {
    peopleById: new Map(state.people.map((person) => [person.id, person])),
    intentsById: new Map(state.intents
      .filter((intent) => intent.status === 'active')
      .map((intent) => [intent.id, intent])),
    animalsById: new Map(state.world.animals.map((animal) => [animal.id, animal])),
    dropsById: new Map(state.world.drops.map((drop) => [drop.id, drop])),
    containersById: new Map(state.containers.map((container) => [container.id, container])),
    inventoryByPersonId: new Map(state.people.map((person) => [
      person.id,
      new Map(person.inventory.map((stack) => [stack.id, stack])),
    ])),
  };
}

function societyProjectionLookup(state: SimulationState): SocietyProjectionLookup {
  const base = stateLookup(state);
  const recentActionByPersonId = new Map<string, ActionEvent>();
  const recentPersonEvents = [...state.lastStep, ...state.world.past.slice(-120)];
  for (let index = recentPersonEvents.length - 1; index >= 0; index -= 1) {
    const event = recentPersonEvents[index];
    if (event.kind === 'action'
      && event.atMonth === state.clock.elapsedMonths
      && !recentActionByPersonId.has(event.who)) recentActionByPersonId.set(event.who, event);
  }

  const latestAnimalFactById = new Map<string, EnvironmentEvent>();
  const huntedAnimalIds = new Set<string>();
  const recentAnimalEvents = [...state.lastStep, ...state.world.past.slice(-160)];
  for (let index = recentAnimalEvents.length - 1; index >= 0; index -= 1) {
    const event = recentAnimalEvents[index];
    if (event.atMonth !== state.clock.elapsedMonths) continue;
    if (event.kind === 'environment' && event.change === 'animal') {
      const animalId = typeof event.diff.animalId === 'string' ? event.diff.animalId : undefined;
      if (animalId && !latestAnimalFactById.has(animalId)) latestAnimalFactById.set(animalId, event);
      continue;
    }
    if (event.kind !== 'action' || event.action.kind !== 'act' || event.action.operation !== 'hunt') continue;
    event.action.targets.forEach((target) => {
      if (target.kind === 'animal') huntedAnimalIds.add(target.animalId);
    });
  }
  return { ...base, recentActionByPersonId, latestAnimalFactById, huntedAnimalIds };
}

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

function materialForTarget(state: SimulationState, lookup: StateLookup, target: WorldRef): number | undefined {
  if (target.kind === 'inventory-stack') {
    return lookup.inventoryByPersonId.get(target.personId)?.get(target.stackId)?.materialId;
  }
  if (target.kind === 'drop') return lookup.dropsById.get(target.dropId)?.materialId;
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

function worldRefLocation(state: SimulationState, lookup: StateLookup, target: WorldRef | undefined): Pick<ActionVisualView, 'targetCellId' | 'targetZ'> {
  if (!target) return {};
  if (target.kind === 'voxel') return {
    targetCellId: target.position.x + target.position.y * state.world.grid.width,
    targetZ: target.position.z,
  };
  if (target.kind === 'drop') {
    const drop = lookup.dropsById.get(target.dropId);
    return drop ? { targetCellId: drop.cellId, targetZ: drop.z } : {};
  }
  if (target.kind === 'container') {
    const container = lookup.containersById.get(target.containerId);
    return container ? {
      targetCellId: container.position.x + container.position.y * state.world.grid.width,
      targetZ: container.position.z,
    } : {};
  }
  if (target.kind === 'animal') {
    const animal = lookup.animalsById.get(target.animalId);
    return animal ? { targetCellId: animal.position.cellId, targetZ: animal.position.z } : {};
  }
  if (target.kind === 'remains') {
    const remains = state.world.remains?.find((candidate) => candidate.id === target.remainsId);
    return remains ? { targetCellId: remains.position.cellId, targetZ: remains.position.z } : {};
  }
  const targetPersonId = target.personId;
  const targetPerson = lookup.peopleById.get(targetPersonId);
  return targetPerson ? { targetCellId: targetPerson.position.cellId, targetZ: targetPerson.position.z } : {};
}

function transferTargetLocation(
  state: SimulationState,
  lookup: StateLookup,
  target: Extract<PrimitiveAction, { kind: 'transfer' }>['to'],
): Pick<ActionVisualView, 'targetCellId' | 'targetZ'> {
  if (target.kind === 'ground') return { targetCellId: target.cellId, ...(target.z !== undefined ? { targetZ: target.z } : {}) };
  if (target.kind === 'container') return worldRefLocation(state, lookup, { kind: 'container', containerId: target.containerId });
  return worldRefLocation(state, lookup, { kind: 'person', personId: target.personId });
}

function actionVisual(
  state: SimulationState,
  lookup: StateLookup,
  person: PersonState,
  action: PrimitiveAction,
  fact?: ActionEvent,
): ActionVisualView {
  const facilityMaterialId = fact && typeof fact.diff.facilityMaterialId === 'number'
    ? fact.diff.facilityMaterialId
    : undefined;
  const mechanicalPowerOperation = fact?.diff.mechanicalPowerOperation === true;
  const mechanicalNetworkId = mechanicalPowerOperation && typeof fact?.diff.networkId === 'string'
    ? fact.diff.networkId
    : undefined;
  const linkedFacilityCellIds = mechanicalNetworkId
    ? state.world.mechanicalPower?.networks.find((network) => network.id === mechanicalNetworkId)?.components
      .map((component) => component.position.x + component.position.y * state.world.grid.width)
    : undefined;
  const factLocation: Pick<ActionVisualView, 'sourceEventId' | 'sourceOrderInMonth' | 'sourceCellId' | 'sourceZ' | 'targetCellId' | 'targetZ' | 'facilityMaterialId' | 'mechanicalPowerOperation' | 'linkedFacilityCellIds'> = fact ? {
    sourceEventId: fact.id,
    sourceOrderInMonth: fact.orderInMonth,
    sourceCellId: fact.fromCellId,
    sourceZ: fact.fromZ,
    targetCellId: fact.toCellId,
    targetZ: fact.toZ,
    ...(facilityMaterialId !== undefined ? { facilityMaterialId } : {}),
    ...(mechanicalPowerOperation ? { mechanicalPowerOperation: true } : {}),
    ...(linkedFacilityCellIds?.length ? { linkedFacilityCellIds: [...new Set(linkedFacilityCellIds)] } : {}),
  } : {};
  if (action.kind === 'move') return { actionKind: 'move', ...factLocation };
  if (action.kind === 'transfer') {
    const target = action.to.kind === 'person'
      ? { kind: 'person' as const, personId: action.to.personId }
      : undefined;
    return {
      actionKind: 'transfer', materialId: action.materialId,
      ...factLocation, ...targetIdentity(target), ...transferTargetLocation(state, lookup, action.to),
    };
  }
  if (action.kind === 'act') {
    const targetMaterialIds = action.targets
      .map((target) => materialForTarget(state, lookup, target))
      .filter((materialId): materialId is number => materialId !== undefined);
    const diffSourceMaterialId = action.operation === 'separate'
      ? Number(fact?.diff.sourceMaterialId ?? fact?.diff.materialId)
      : Number.NaN;
    const sourceMaterialId = Number.isInteger(diffSourceMaterialId)
      ? diffSourceMaterialId
      : undefined;
    const materialIds = fact && action.operation === 'separate'
      ? (sourceMaterialId === undefined ? [] : [sourceMaterialId])
      : sourceMaterialId === undefined
        ? targetMaterialIds
        : [sourceMaterialId, ...targetMaterialIds.filter((materialId) => materialId !== sourceMaterialId)];
    const facilityTarget = action.targets.find((target) => {
      const materialId = materialForTarget(state, lookup, target);
      return materialId !== undefined && materialDefinition(materialId).tags.includes('facility');
    });
    const visualTarget = facilityTarget ?? action.targets[0];
    const diffToolMaterialId = Number(fact?.diff.toolMaterialId);
    const toolMaterialId = Number.isInteger(diffToolMaterialId)
      ? diffToolMaterialId
      : action.toolStackId
        ? lookup.inventoryByPersonId.get(person.id)?.get(action.toolStackId)?.materialId
        : undefined;
    return {
      actionKind: 'act', operation: action.operation,
      ...(action.mortuaryPhase ? { mortuaryPhase: action.mortuaryPhase } : {}),
      ...factLocation, ...targetIdentity(visualTarget), ...worldRefLocation(state, lookup, visualTarget),
      ...(sourceMaterialId !== undefined ? { sourceMaterialId } : {}),
      ...(materialIds[0] !== undefined ? { materialId: materialIds[0] } : {}),
      ...(materialIds.length ? { materialIds } : {}),
      ...(toolMaterialId !== undefined ? { toolMaterialId } : {}),
    };
  }
  if (action.kind === 'attend') {
    const toolMaterialId = action.instrumentStackId
      ? lookup.inventoryByPersonId.get(person.id)?.get(action.instrumentStackId)?.materialId
      : undefined;
    const materialId = materialForTarget(state, lookup, action.target);
    return {
      actionKind: 'attend', ...factLocation, ...targetIdentity(action.target), ...worldRefLocation(state, lookup, action.target),
      ...(toolMaterialId !== undefined ? { toolMaterialId } : {}),
      ...(materialId !== undefined ? { materialId } : {}),
    };
  }
  const toolMaterialId = action.carrierStackId
    ? lookup.inventoryByPersonId.get(person.id)?.get(action.carrierStackId)?.materialId
    : undefined;
  return {
    actionKind: 'communicate', channel: action.channel, communicationKind: action.content.kind,
    ...factLocation,
    ...(action.audience[0] ? {
      targetKind: 'person' as const,
      targetPersonId: action.audience[0],
      ...worldRefLocation(state, lookup, { kind: 'person', personId: action.audience[0] }),
    } : {}),
    ...(toolMaterialId !== undefined ? { toolMaterialId } : {}),
  };
}

function recentActionFor(state: SimulationState, lookup: SocietyProjectionLookup, person: PersonState): ActionVisualView | undefined {
  const fact = lookup.recentActionByPersonId.get(person.id);
  return fact ? actionVisual(state, lookup, person, fact.action, fact) : undefined;
}

function personStateOf(person: PersonState): SocietyAgent['state'] {
  if (!isAlive(person)) return 'dead';
  if (isDormantDehydratedHibernating(person)) return 'hibernating';
  if (person.body.hydration < 10) return 'dehydrated';
  return 'active';
}

function historyCellLabel(state: SimulationState, cellId: number, z?: number): string {
  const x = cellId % state.world.grid.width;
  const y = Math.floor(cellId / state.world.grid.width);
  return `格位 ${x}, ${y}${z === undefined ? '' : ` · 高度 ${z}`}`;
}

function historyWorldRefLabel(state: SimulationState, lookup: StateLookup, target: WorldRef): string {
  if (target.kind === 'voxel') {
    const cellId = target.position.x + target.position.y * state.world.grid.width;
    return historyCellLabel(state, cellId, target.position.z);
  }
  if (target.kind === 'person') return lookup.peopleById.get(target.personId)?.name ?? '未知人物';
  if (target.kind === 'animal') {
    const animal = lookup.animalsById.get(target.animalId);
    return animal ? animalSpecies(animal.speciesId).name : '未知动物';
  }
  if (target.kind === 'drop') {
    const drop = lookup.dropsById.get(target.dropId);
    return drop ? `${materialDefinition(drop.materialId).name} · ${historyCellLabel(state, drop.cellId, drop.z)}` : '已消失的地面物品';
  }
  if (target.kind === 'container') {
    const container = lookup.containersById.get(target.containerId);
    const cellId = container ? container.position.x + container.position.y * state.world.grid.width : -1;
    return container ? `${materialDefinition(Material.Container).name} · ${historyCellLabel(state, cellId, container.position.z)}` : '未知容器';
  }
  if (target.kind === 'remains') {
    const remains = state.world.remains?.find((candidate) => candidate.id === target.remainsId);
    const deceased = remains ? lookup.peopleById.get(remains.personId) : undefined;
    return deceased ? `${deceased.name}的遗体` : '未知遗体';
  }
  const owner = lookup.peopleById.get(target.personId);
  const stack = lookup.inventoryByPersonId.get(target.personId)?.get(target.stackId);
  return `${owner?.name ?? '未知人物'}持有的${stack ? materialDefinition(stack.materialId).name : '物品'}`;
}

function historyHolderLabel(state: SimulationState, lookup: StateLookup, holder: Extract<PrimitiveAction, { kind: 'transfer' }>['from']): string {
  if (holder.kind === 'ground') return historyCellLabel(state, holder.cellId, holder.z);
  if (holder.kind === 'person') return lookup.peopleById.get(holder.personId)?.name ?? '未知人物';
  const container = lookup.containersById.get(holder.containerId);
  const cellId = container ? container.position.x + container.position.y * state.world.grid.width : -1;
  return container ? `${materialDefinition(Material.Container).name} · ${historyCellLabel(state, cellId, container.position.z)}` : '未知容器';
}

function actionHistoryDetail(state: SimulationState, lookup: StateLookup, event: ActionEvent): string {
  const from = historyCellLabel(state, event.fromCellId, event.fromZ);
  const to = historyCellLabel(state, event.toCellId, event.toZ);
  if (event.action.kind === 'move') {
    const distance = Math.max(0, event.pathSegment.length - 1);
    return `${from} → ${to} · 路径 ${distance} 格`;
  }
  if (event.action.kind === 'transfer') {
    return `${from} · ${historyHolderLabel(state, lookup, event.action.from)} → ${historyHolderLabel(state, lookup, event.action.to)}`;
  }
  if (event.action.kind === 'act') {
    const action = event.action;
    const targets = action.targets.map((target) => historyWorldRefLabel(state, lookup, target)).join('、') || '无明确对象';
    const tool = action.toolStackId
      ? lookup.inventoryByPersonId.get(event.who)?.get(action.toolStackId)
      : undefined;
    return `${to} · 对象 ${targets}${tool ? ` · 使用 ${materialDefinition(tool.materialId).name}` : ''}`;
  }
  if (event.action.kind === 'attend') return `${to} · 观察 ${historyWorldRefLabel(state, lookup, event.action.target)}`;
  const audience = event.action.audience.map((id) => lookup.peopleById.get(id)?.name ?? '未知人物').join('、') || '身边的人';
  const channel = event.action.channel === 'voice' ? '交谈' : event.action.channel === 'gesture' ? '手势' : '记录';
  return `${to} · 通过${channel}面向 ${audience}`;
}

function personView(state: SimulationState, lookup: SocietyProjectionLookup, person: PersonState): SocietyAgent {
  const needs = needsFor(person);
  const activeIntent = person.activeIntentId ? lookup.intentsById.get(person.activeIntentId) : undefined;
  const active = activeIntent?.status === 'active' ? activeIntent : undefined;
  const currentNeed = needs.find((need) => need.dominant)?.label ?? '维持生活';
  const visualAction = recentActionFor(state, lookup, person);
  const visualSourceMaterialId = visualAction?.sourceMaterialId ?? visualAction?.materialId;
  const currentActionText = visualAction?.operation === 'separate' && visualSourceMaterialId === Material.BerryBush
    ? '采集野果'
    : visualAction?.operation === 'separate' && visualSourceMaterialId === Material.CropMature
      ? '收割成熟作物'
      : person.currentActionText;
  const remains = state.world.remains?.find((candidate) => candidate.personId === person.id);
  const projectedPosition = remains?.status === 'interred' && remains.grave
    ? { cellId: remains.position.cellId, z: remains.grave.position.z + 1 }
    : remains?.position ?? person.position;
  const remainsPath = [projectedPosition.cellId];
  return {
    id: person.id,
    name: person.name,
    portrait: portraitForPerson(person),
    title: person.profile.description,
    cellId: projectedPosition.cellId,
    z: projectedPosition.z,
    previousCellId: remains ? projectedPosition.cellId : person.position.previousCellId,
    lastPath: remains ? remainsPath : [...person.position.lastPath],
    tickPath: remains ? remainsPath : [...person.position.tickPath],
    state: personStateOf(person),
    ...(remains ? { bodyDisposition: remains.status } : {}),
    doing: currentActionText,
    ...(active ? { activeIntentId: active.id } : {}),
    sex: person.sex,
    lifespanMonths: person.lifespanMonths,
    generation: person.generation,
    traits: traitStatesOf(person).map((trait) => {
      const definition = traitDefinition(trait.id);
      return { id: definition.id, name: definition.name, description: definition.description };
    }),
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
      const other = lookup.peopleById.get(relation.personId);
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

function animalActivity(state: SimulationState, lookup: SocietyProjectionLookup, animal: AnimalState): NonNullable<SocietyState['animals'][number]['activity']> {
  if (!isAnimalAlive(animal)) return 'dead';
  const animalFact = lookup.latestAnimalFactById.get(animal.id);
  if (animalFact) {
    if (animalFact.diff.process === 'attack-human') return 'attack';
    if (animalFact.diff.process === 'birth') return 'birth';
    if (animalFact.diff.process === 'forage') return 'graze';
  }
  if (lookup.huntedAnimalIds.has(animal.id)) return animal.health < 55 ? 'injured' : 'flee';
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
  const lookup = societyProjectionLookup(state);
  const civilizationIndex = state.civilization.civilizationIndex;
  const componentPoints = (key: keyof typeof civilizationIndex.components): number => {
    const component = civilizationIndex.components[key];
    return Math.round(component.score * component.weight * 100) / 100;
  };
  return {
    world: {
      ...projectSocietyWorld(grid),
      activity: actionActivityIndex(state),
    },
    agents: state.people.map((person) => personView(state, lookup, person)),
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
      activity: animalActivity(state, lookup, animal),
    }; }),
    drops: state.world.drops.map((drop) => {
      const estateOwner = drop.estateOfPersonId ? lookup.peopleById.get(drop.estateOfPersonId) : undefined;
      return {
        id: drop.id,
        materialId: drop.materialId,
        name: estateOwner ? `${estateOwner.name}遗留的${materialDefinition(drop.materialId).name}` : materialDefinition(drop.materialId).name,
        cellId: drop.cellId,
        z: drop.z,
        quantity: drop.quantity,
      };
    }),
    containers: state.containers.map((container) => {
      const materialId = voxelAt(state.world.grid, container.position.x, container.position.y, container.position.z);
      return {
        id: container.id,
        materialId,
        name: materialDefinition(materialId).name,
        cellId: container.position.x + container.position.y * grid.width,
        z: container.position.z,
        capacity: container.capacity ?? CONTAINER_CAPACITY,
        usedCapacity: container.inventory.reduce((sum, stack) => sum + stack.quantity, 0),
        contents: container.inventory.map((stack) => ({ materialId: stack.materialId, name: materialDefinition(stack.materialId).name, quantity: stack.quantity })),
      };
    }),
    graves: (state.world.remains ?? []).flatMap((remains) => {
      if (remains.status !== 'interred' || !remains.grave) return [];
      const deceased = lookup.peopleById.get(remains.personId);
      const marker = state.world.memorials?.find((candidate) => candidate.remainsId === remains.id);
      return [{
        id: `grave:${remains.id}`,
        remainsId: remains.id,
        personId: remains.personId,
        personName: deceased?.name ?? '无名死者',
        cellId: remains.position.cellId,
        z: remains.grave.position.z + 1,
        marked: Boolean(marker),
        ...(marker ? { markerMaterialId: marker.materialId, inscription: marker.inscription } : {}),
      }];
    }),
    structures: state.derived.structures.map((structure) => ({
      id: structure.id,
      name: structure.name,
      occupiedCells: [...structure.occupiedCells],
      interiorCells: [...structure.interiorCells],
      interiorPositions: structure.interiorPositions.map((position) => ({ ...position })),
      componentCount: structure.sourceEventIds.length, complete: structure.complete,
      effects: { weatherProtection: structure.weatherProtection, thermalInsulation: structure.thermalInsulation, capacity: structure.capacity },
      sourceEventIds: [...structure.sourceEventIds],
      materialIds: [...structure.materialIds],
    })),
    intents: state.intents.filter((intent) => intent.status === 'active').map((intent) => {
      const person = lookup.peopleById.get(intent.ownerId);
      return {
        id: intent.id, ownerId: intent.ownerId, summary: intent.summary,
        ...(person ? actionVisual(state, lookup, person, intent.nextAction) : { actionKind: intent.nextAction.kind }),
        status: intent.status, progress: intent.progress, createdAtMonth: intent.createdAtMonth, lastProgressAtMonth: intent.lastProgressAtMonth,
      };
    }),
    regions: state.derived.regions.map(({ id, kind, cells, confidence, label }) => ({ id, kind, cells: [...cells], confidence, ...(label ? { label } : {}) })),
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
  const lookup = stateLookup(state);
  if (!lookup.peopleById.has(agentId)) return null;
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
      return [{ id: event.id, month: event.atMonth, orderInMonth: event.orderInMonth, actionTick: event.actionTick, cellId: event.cellId, kind: 'action', label: event.cause === 'survival-reflex' ? `应对眼前危险 · ${label}` : label, summary: playerTextForEvent(state, event), detail: actionHistoryDetail(state, lookup, event), ...(event.intentId ? { intentId: event.intentId } : {}), status: event.status }];
    }
    if (event.kind === 'environment' && event.who === agentId
      && event.change === 'animal' && event.diff.process === 'attack-human') {
      return [{
        id: event.id,
        month: event.atMonth,
        orderInMonth: event.orderInMonth,
        cellId: event.cellId,
        kind: 'life',
        label: '遭遇野兽袭击',
        summary: playerTextForEvent(state, event),
        detail: historyCellLabel(state, event.cellId),
        status: 'animal-attack',
      }];
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
  if (!fact || !('who' in fact) || !fact.who) return null;
  const speakerId = fact.who;
  return state.people.find((person) => person.id === speakerId)?.name ?? null;
}
