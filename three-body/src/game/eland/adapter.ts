/** 领域状态到 UI 读取模型的纯投影。 */
import type {
  ActionVisualView,
  AgentHistoryItem,
  AgentHistoryView,
  AgentMemoryView,
  EraKey,
  SocietyAgent,
  SocietyState,
  SpeechLineView,
} from '../societyContract';
import type { ClimateKind, EpochKind, SimulationState, TerminalCatastropheKind, WorldEvent } from './simulation';
import { Material, materialDefinition } from './domain/material';
import { ageMonths, isAlive, isDormantDehydratedHibernating, type PersonState } from './domain/person';
import { personalityScore } from './domain/personality';
import { CONTAINER_CAPACITY } from './domain/container';
import { animalAgeMonths, animalSpecies, isAnimalAlive, type AnimalState } from './domain/animal';
import type { PrimitiveAction, WorldRef } from './domain/action';
import { actionActivityIndex } from './domain/event-index';
import { bodyHistoryLabel, playerTextForEvent } from './projection/player-narrative';
import { projectSocietyWorld } from './projection/society-world-cache';
import { portraitForPerson } from '../personPortraits';
import { voxelAt } from './world/grid';
import { traitDefinition, traitStatesOf } from './domain/trait';
import { validateElectricalPowerTopology, type ElectricalPowerNetworkState } from './domain/electrical-power';
import {
  speechHistoryTextForEvent,
  verifiedSpeechLinesBySourceEventId,
} from './projection/speech-history';
import { retrieveAgentMemories } from './domain/agent-memory';
import { projectPersonMindMarkdown } from './domain/person-mind';
import { languageBroadcastFromDiff } from './domain/language-perception';
import { relationshipEpisodesWith } from './domain/relationship-episode';

export { projectPlayerNarrative } from './projection/player-narrative';
export type { WorldEventLookup } from './projection/player-narrative';

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

function meaningfulRelationsOf(person: PersonState): PersonState['relations'] {
  return person.relations.filter((relation) => relation.trust !== 0
    || relation.bond !== 0
    || relation.fear !== 0
    || relation.sourceEventIds.length > 0);
}

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

function needsFor(
  person: PersonState,
  meaningfulRelations = meaningfulRelationsOf(person),
): SocietyAgent['needs'] {
  const physiological = Math.max(100 - person.body.health, 100 - person.body.hydration, 100 - person.body.nutrition);
  const safety = Math.max(person.conditions.reduce((value, condition) => Math.max(value, condition.stage * 25), 0), 100 - person.body.health);
  const socialSupport = meaningfulRelations.reduce((sum, relation) => sum + Math.max(0, relation.bond) + Math.max(0, relation.trust) * 0.35, 0)
    / Math.max(1, meaningfulRelations.length);
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
  const electricalPowerOperation = fact?.diff.electricalPowerOperation === true;
  const electricalPowerDelivered = fact?.diff.electricalPowerDelivered === true;
  const electricalPowerFault = fact?.diff.electricalPowerFault === true;
  const electricalPowerRepair = fact?.diff.electricalPowerRepair === true;
  const electricalNetworkId = typeof fact?.diff.electricalNetworkId === 'string'
    ? fact.diff.electricalNetworkId
    : undefined;
  const linkedFacilityCellIds = mechanicalNetworkId
    ? state.world.mechanicalPower?.networks.find((network) => network.id === mechanicalNetworkId)?.components
      .map((component) => component.position.x + component.position.y * state.world.grid.width)
    : undefined;
  const factLocation: Pick<ActionVisualView,
    | 'sourceEventId' | 'sourceOrderInMonth' | 'sourceCellId' | 'sourceZ'
    | 'targetCellId' | 'targetZ' | 'facilityMaterialId'
    | 'mechanicalPowerOperation' | 'linkedFacilityCellIds'
    | 'electricalPowerOperation' | 'electricalPowerDelivered' | 'electricalPowerFault'
    | 'electricalPowerRepair' | 'electricalNetworkId'
  > = fact ? {
    sourceEventId: fact.id,
    sourceOrderInMonth: fact.orderInMonth,
    sourceCellId: fact.fromCellId,
    sourceZ: fact.fromZ,
    targetCellId: fact.toCellId,
    targetZ: fact.toZ,
    ...(facilityMaterialId !== undefined ? { facilityMaterialId } : {}),
    ...(mechanicalPowerOperation ? { mechanicalPowerOperation: true } : {}),
    ...(linkedFacilityCellIds?.length ? { linkedFacilityCellIds: [...new Set(linkedFacilityCellIds)] } : {}),
    ...(electricalPowerOperation ? { electricalPowerOperation: true } : {}),
    ...(electricalPowerDelivered ? { electricalPowerDelivered: true } : {}),
    ...(electricalPowerFault ? { electricalPowerFault: true } : {}),
    ...(electricalPowerRepair ? { electricalPowerRepair: true } : {}),
    ...(electricalNetworkId ? { electricalNetworkId } : {}),
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
      ...(fact?.status === 'completed' && action.measurement
        ? { measurementMode: action.measurement.mode }
        : {}),
    };
  }
  if (action.kind === 'world-interact') {
    const target = action.adjudication.targets[0];
    return {
      actionKind: 'world-interact',
      ...factLocation,
      ...targetIdentity(target),
      ...worldRefLocation(state, lookup, target),
    };
  }
  if (action.kind === 'inscribe') {
    const toolMaterialId = lookup.inventoryByPersonId.get(person.id)?.get(action.carrierStackId)?.materialId;
    return {
      actionKind: 'inscribe',
      ...factLocation,
      ...(toolMaterialId !== undefined ? { toolMaterialId } : {}),
    };
  }
  const perceivedId = fact
    ? languageBroadcastFromDiff(fact.diff)?.perceivedByPersonIds[0]
    : undefined;
  return {
    actionKind: 'talk', communicationKind: action.speakerMeaning.kind,
    ...factLocation,
    ...(perceivedId ? {
      targetKind: 'person' as const,
      targetPersonId: perceivedId,
      ...worldRefLocation(state, lookup, { kind: 'person', personId: perceivedId }),
    } : {}),
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
  if (event.action.kind === 'world-interact') {
    const targets = event.action.adjudication.targets
      .map((target) => historyWorldRefLabel(state, lookup, target)).join('、') || '无明确对象';
    return `${to} · ${event.action.adjudication.request} · 对象 ${targets}`;
  }
  if (event.action.kind === 'inscribe') return `${to} · 在记录载体上留下刻痕`;
  const perceived = languageBroadcastFromDiff(event.diff)?.perceivedByPersonIds
    .map((id) => lookup.peopleById.get(id)?.name ?? '未知人物').join('、') || '无人明确感知';
  return `${to} · 说出语言，被 ${perceived} 感知`;
}

function personView(state: SimulationState, lookup: SocietyProjectionLookup, person: PersonState): SocietyAgent {
  const meaningfulRelations = meaningfulRelationsOf(person);
  const relationshipPersonIds = [...new Set([
    ...meaningfulRelations.map((relation) => relation.personId),
    ...(person.relationshipEpisodes ?? []).map((episode) => episode.otherPersonId),
  ])];
  const needs = needsFor(person, meaningfulRelations);
  const currentAgeMonths = ageMonths(person, state.clock.elapsedMonths);
  const activeIntent = person.activeIntentId ? lookup.intentsById.get(person.activeIntentId) : undefined;
  const active = activeIntent?.status === 'active' ? activeIntent : undefined;
  const currentNeed = needs.find((need) => need.dominant)?.label ?? '维持生活';
  const projectedPersonState = personStateOf(person);
  const visualAction = recentActionFor(state, lookup, person);
  const visualSourceMaterialId = visualAction?.sourceMaterialId ?? visualAction?.materialId;
  const currentActionText = visualAction?.operation === 'separate' && visualSourceMaterialId === Material.BerryBush
    ? '采集野果'
    : visualAction?.operation === 'separate' && visualSourceMaterialId === Material.CropMature
      ? '收割成熟作物'
      : person.currentActionText;
  const activityKind: SocietyAgent['activity']['kind'] = projectedPersonState === 'hibernating'
    ? 'waiting'
    : visualAction?.actionKind === 'move'
    ? 'travelling'
    : visualAction
      ? 'acting'
      : active
        ? 'waiting'
        : 'idle';
  const hibernationSinceMonth = person.conditions.find((condition) => condition.kind === 'dehydrated-hibernation')?.sinceMonth;
  const activitySinceMonth = projectedPersonState === 'hibernating' && hibernationSinceMonth !== undefined
    ? hibernationSinceMonth
    : visualAction
    ? state.clock.elapsedMonths
    : Math.min(
      state.clock.elapsedMonths,
      Math.max(person.bornAtMonth, (person.lastActionAtMonth ?? state.clock.elapsedMonths) + 1),
    );
  const remains = state.world.remains?.find((candidate) => candidate.personId === person.id);
  const projectedPosition = remains?.status === 'interred' && remains.grave
    ? { cellId: remains.position.cellId, z: remains.grave.position.z + 1 }
    : remains?.position ?? person.position;
  const remainsPath = [projectedPosition.cellId];
  return {
    id: person.id,
    name: person.name,
    portrait: portraitForPerson(person, currentAgeMonths),
    title: person.profile.description,
    cellId: projectedPosition.cellId,
    z: projectedPosition.z,
    previousCellId: remains ? projectedPosition.cellId : person.position.previousCellId,
    lastPath: remains ? remainsPath : [...person.position.lastPath],
    tickPath: remains ? remainsPath : [...person.position.tickPath],
    state: projectedPersonState,
    ...(remains ? { bodyDisposition: remains.status } : {}),
    doing: currentActionText,
    activity: {
      kind: activityKind,
      reason: currentActionText,
      sinceMonth: activitySinceMonth,
    },
    ...(active ? { activeIntentId: active.id } : {}),
    sex: person.sex,
    lifespanMonths: person.lifespanMonths,
    generation: person.generation,
    traits: traitStatesOf(person).map((trait) => {
      const definition = traitDefinition(trait.id);
      return { id: definition.id, name: definition.name, description: definition.description };
    }),
    respect: Math.round(meaningfulRelations.reduce((sum, relation) => sum + relation.trust, 0) / Math.max(1, meaningfulRelations.length)),
    mind: {
      want: `当前最迫切的是${currentNeed}`,
      choice: person.lastDecisionText,
      ought: active ? `意图：${active.summary}` : person.knowledge.at(-1)?.summary ?? '只依据自己见过和经历过的事实',
    },
    needs,
    body: { ...person.body, ageMonths: currentAgeMonths },
    conditions: person.conditions.map((condition) => ({ id: condition.id, kind: condition.kind, label: CONDITION_LABELS[condition.kind] ?? condition.kind, stage: condition.stage, sinceMonth: condition.sinceMonth })),
    inventory: person.inventory.map((stack) => ({ id: stack.id, materialId: stack.materialId, name: materialDefinition(stack.materialId).name, quantity: stack.quantity })),
    relations: relationshipPersonIds.flatMap((personId) => {
      const relation = meaningfulRelations.find((candidate) => candidate.personId === personId);
      const subjective = relationshipEpisodesWith(person, personId).at(-1);
      const other = lookup.peopleById.get(personId);
      if (!other) return [];
      return [{
        personId: other.id,
        name: other.name,
        portrait: portraitForPerson(other, ageMonths(other, state.clock.elapsedMonths)),
        state: personStateOf(other),
        trust: relation?.trust ?? 0,
        bond: relation?.bond ?? 0,
        fear: relation?.fear ?? 0,
        sourceEventIds: [...new Set([
          ...(relation?.sourceEventIds ?? []),
          ...(subjective?.sourceFactIds ?? []),
        ])],
        ...(subjective ? {
          subjective: {
            meanings: [...subjective.appraisal.meanings],
            interpretation: subjective.appraisal.interpretation,
            ...(subjective.appraisal.unresolvedExpectation
              ? { unresolvedExpectation: subjective.appraisal.unresolvedExpectation }
              : {}),
            ...(subjective.appraisal.desiredResponse
              ? { desiredResponse: subjective.appraisal.desiredResponse }
              : {}),
            experiencedAtMonth: subjective.experiencedAtMonth,
            sourceEventIds: [...subjective.sourceFactIds],
          },
        } : {}),
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

function electricalPowerView(state: SimulationState): SocietyState['electricalPower'] | undefined {
  const electricalPower = state.world.electricalPower;
  if (!electricalPower?.networks.length) return undefined;
  const { grid } = state.world;
  const positionView = (position: { x: number; y: number; z: number }) => ({
    cellId: position.x + position.y * grid.width,
    z: position.z,
  });
  const recentEvents = [...state.lastStep, ...state.world.past.slice(-160)];
  const electricalActivityFor = (network: ElectricalPowerNetworkState): NonNullable<SocietyState['electricalPower']>['networks'][number]['activity'] => {
    let latest: ActionEvent | undefined;
    for (const event of recentEvents) {
      if (event.kind !== 'action'
        || event.status !== 'completed'
        || event.atMonth !== state.clock.elapsedMonths
        || event.diff.electricalNetworkId !== network.id
        || (typeof event.diff.electricalPowerDelivered !== 'boolean'
          && event.diff.electricalPowerOperation !== true
          && event.diff.electricalPowerFault !== true
          && event.diff.electricalPowerRepair !== true
          && event.diff.electricalPowerInstallation !== true)) continue;
      if (!latest || event.orderInMonth > latest.orderInMonth) latest = event;
    }
    if (!latest) return undefined;
    const operation = latest.diff.electricalPowerOperation === true
      && latest.diff.electricalPowerDelivered === true
      && network.recentOperationEventIds.includes(latest.id)
      && !network.fault
      && validateElectricalPowerTopology(grid, network).valid;
    const fault = latest.diff.electricalPowerFault === true
      && network.fault?.faultEventId === latest.id;
    const repair = latest.diff.electricalPowerRepair === true
      && !network.fault
      && network.recentRepairEventIds.includes(latest.id);
    const installation = latest.diff.electricalPowerInstallation === true
      && network.installationEventIds.includes(latest.id);
    const kind = operation ? 'operation' as const
      : fault ? 'fault' as const
        : repair ? 'repair' as const
          : installation ? 'installation' as const
            : undefined;
    if (!kind) return undefined;
    return {
      kind,
      sourceEventId: latest.id,
      delivered: operation,
    };
  };
  return {
    networks: electricalPower.networks.map((network) => {
      const visibleComponents = network.components.flatMap((component) => {
        const materialId = voxelAt(grid, component.position.x, component.position.y, component.position.z);
        const faultPosition = network.fault?.componentPosition;
        const physicalMatch = component.role === 'source' ? materialId === Material.MechanicalDynamo
          : component.role === 'load' ? materialId === Material.ResistiveLoad
            : materialId === Material.CopperConductor
              || (materialId === Material.BrokenCopperConductor
                && faultPosition?.x === component.position.x
                && faultPosition.y === component.position.y
                && faultPosition.z === component.position.z);
        return physicalMatch ? [{
          role: component.role,
          materialId,
          ...positionView(component.position),
        }] : [];
      });
      const faultMaterial = network.fault ? voxelAt(
        grid,
        network.fault.componentPosition.x,
        network.fault.componentPosition.y,
        network.fault.componentPosition.z,
      ) : undefined;
      const activity = electricalActivityFor(network);
      return {
        id: network.id,
        planPath: [
          network.plan.generatorPosition,
          ...network.plan.conductorPositions,
          network.plan.loadPosition,
        ].map(positionView),
        components: visibleComponents,
        ...(network.fault && faultMaterial === Material.BrokenCopperConductor ? {
        fault: {
          ...positionView(network.fault.componentPosition),
          atMonth: network.fault.atMonth,
          sourceEventId: network.fault.faultEventId,
        },
      } : {}),
        ...(activity ? { activity } : {}),
      };
    }),
  };
}

export function toSocietyState(state: SimulationState): SocietyState {
  const { grid } = state.world;
  const lookup = societyProjectionLookup(state);
  const civilizationIndex = state.civilization.civilizationIndex;
  const electricalPower = electricalPowerView(state);
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
    ...(electricalPower ? { electricalPower } : {}),
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
    epoch: state.civilization.epoch,
    climate: { ...state.civilization.climate },
    weather: { ...state.civilization.weather },
  };
}

export function toAgentHistory(
  state: SimulationState,
  agentId: string,
  limit = 80,
  speechLines: readonly SpeechLineView[] = [],
): AgentHistoryView | null {
  const lookup = stateLookup(state);
  if (!lookup.peopleById.has(agentId)) return null;
  const speechLinesBySourceEventId = verifiedSpeechLinesBySourceEventId(
    speechLines,
    new Map(state.world.past.map((event) => [event.id, event])),
  );
  const events = state.world.past.flatMap((event): AgentHistoryItem[] => {
    if (event.kind === 'decision-opportunity') {
      if (event.who !== agentId || event.triggered) return [];
      return [{ id: event.id, month: event.atMonth, orderInMonth: event.orderInMonth, cellId: event.cellId, kind: 'continuation', label: '照原计划行动', summary: '本月没有改动原来的安排。' }];
    }
    if (event.kind === 'decision') {
      if (event.who !== agentId) return [];
      const meaningfulAgendaReflection = event.characterAgendaEvidence?.some((evidence) => (
        evidence.outcome === 'created'
        || evidence.outcome === 'updated'
        || evidence.outcome === 'paused'
        || evidence.outcome === 'abandoned'
      ));
      if (event.decision.kind === 'idle' && !meaningfulAgendaReflection && !event.languageBroadcast) return [];
      const summary = playerTextForEvent(state, event);
      if (!summary) return [];
      const utterance = 'mentalAct' in event.decision ? event.decision.mentalAct?.utterance.trim() : undefined;
      return [{ id: event.id, month: event.atMonth, orderInMonth: event.orderInMonth, cellId: event.cellId, kind: 'decision', label: event.decision.kind === 'idle' ? '开口表达' : '作出选择', summary, detail: utterance ? `说：“${utterance}” · ${historyCellLabel(state, event.cellId)}` : historyCellLabel(state, event.cellId), ...(event.intentId ? { intentId: event.intentId } : {}), usedModel: event.usedModel }];
    }
    if (event.kind === 'action') {
      if (event.who !== agentId) return [];
      const label = event.status === 'completed' ? '行动完成' : event.status === 'blocked' ? '行动受阻' : event.status === 'failed' ? '行动失败' : '正在行动';
      return [{ id: event.id, month: event.atMonth, orderInMonth: event.orderInMonth, actionTick: event.actionTick, cellId: event.cellId, kind: 'action', label: event.cause === 'survival-reflex' ? `应对眼前危险 · ${label}` : label, summary: speechHistoryTextForEvent(event, speechLinesBySourceEventId) ?? playerTextForEvent(state, event), detail: actionHistoryDetail(state, lookup, event), ...(event.intentId ? { intentId: event.intentId } : {}), status: event.status }];
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
      return [{ id: event.id, month: event.atMonth, orderInMonth: event.orderInMonth, cellId: event.cellId, kind: 'life', label: event.change === 'death' ? '生命终止' : event.change === 'condition' ? '状态变化' : bodyHistoryLabel(event), summary: playerTextForEvent(state, event), detail: historyCellLabel(state, event.cellId), status: event.change }];
    }
    return [];
  });
  return { agentId, throughMonth: state.clock.elapsedMonths, events: events.slice(-Math.max(1, Math.min(240, Math.floor(limit)))) };
}

export function toAgentMemory(
  state: SimulationState,
  agentId: string,
  limit = 24,
): AgentMemoryView | null {
  const person = state.people.find((candidate) => candidate.id === agentId);
  if (!person) return null;
  const markdown = person.mindMarkdown
    ?? projectPersonMindMarkdown(state, person, state.clock.elapsedMonths);
  const nameById = new Map(state.people.map((candidate) => [candidate.id, candidate.name]));
  const remembered = retrieveAgentMemories(state, person, {
    atMonth: state.clock.elapsedMonths,
    unresolved: true,
    laneLimits: {
      episodic: 3,
      semantic: 2,
      social: 2,
      procedural: 2,
      prospective: 3,
      dialogue: 4,
    },
    limit: Math.max(1, Math.min(16, Math.floor(limit))),
    tokenBudget: 1_800,
  }).map((memory) => ({
    id: memory.id,
    lane: memory.lane,
    gist: memory.exactUtterance ? `“${memory.exactUtterance}”` : memory.gist,
    precision: memory.precision,
    confidence: memory.confidence,
    salience: memory.salience,
    emotionalValence: memory.emotionalValence,
    unresolved: memory.unresolved,
    personNames: memory.personIds.map((personId) => nameById.get(personId) ?? '记不清是谁'),
    firstMonth: memory.firstExperiencedAtMonth,
    lastMonth: memory.lastExperiencedAtMonth,
  }));
  return { agentId, throughMonth: state.clock.elapsedMonths, markdown, remembered };
}

export function monthSpeaker(state: SimulationState, events: WorldEvent[]): string | null {
  const fact = [...events].reverse().find((event) => 'who' in event && event.who);
  if (!fact || !('who' in fact) || !fact.who) return null;
  const speakerId = fact.who;
  return state.people.find((person) => person.id === speakerId)?.name ?? null;
}
