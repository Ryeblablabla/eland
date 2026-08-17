import type { ActionOption, Intent, PrimitiveAction } from '../domain/action';
import { Material, materialDefinition, materialHas } from '../domain/material';
import { inventoryQuantity, isAlive, sameLocation, type PersonState } from '../domain/person';
import { ageMonths, MIN_TEACHING_AGE_MONTHS } from '../domain/person';
import type { DecisionContext, DropState, SimulationState } from '../domain/model';
import {
  acceptedExchangeFor,
  acceptedReproductionBetween,
  exchangeTermFulfilled,
  openExchangeOfferFor,
  openReproductionOfferFor,
} from '../domain/social-facts';
import {
  cellsInRadius,
  cellX,
  cellY,
  findStandingPath,
  isPassable,
  nearestCell,
  neighbors4,
  surfaceMaterial,
  topPosition,
  topZ,
  voxelAt,
} from '../world/grid';
import { seededFraction } from '../world/generator';
import { buildSocialOptions } from './social-options';
import { PLANNING_TICKS_PER_MONTH } from '../domain/calendar';
import { compileAgreementContinuations } from './agreement-continuation';
import { permissionById } from '../domain/permission';
import { buildConstructionOptions } from './construction-options';
import { findReachableWater } from '../domain/water-access';
import { findReachableShelter } from '../domain/shelter-access';
import { geneticKinshipRisk, hasLearnedKinshipRisk } from '../domain/kinship';
import { mandateById } from '../domain/governance';
import { buildMaterialSeparationOptions } from './separation-options';
import { separationToolFits, voxelSeparationRuleFor } from '../domain/separation-rules';
import { buildContainerOptions, findContainerAccess } from './container-options';
import { canAccessContainer, containerById, containerQuantity } from '../domain/container';
import {
  inventoryNoResponseFactId,
  knowsReliableNoResponse,
  voxelNoResponseFactId,
} from '../domain/interaction-knowledge';
import { worldEventById } from '../domain/event-index';
import { animalSpecies, isAnimalAlive, type AnimalState } from '../domain/animal';
import {
  buildProjectOptions,
  recompileProjectNextAction,
} from './project-options';
import {
  buildDemandBoundRecordUseOptions,
  recompileRecordUseNextAction,
} from './record-use-options';
import {
  buildRelationshipCausalBasis,
  canOfferRelationshipProposal,
  hasCultivatedReproductiveRelationship,
} from '../domain/relationship-evidence';

function distance(a: number, b: number): number {
  return Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
}

const MAX_LOCAL_INTERACTION_OPTIONS = 3;

function tangibleInventoryStacks(person: PersonState, excludedStackId?: string): PersonState['inventory'] {
  return person.inventory
    .filter((stack) => {
      const material = materialDefinition(stack.materialId);
      return stack.quantity > 0
        && stack.id !== excludedStackId
        && material.phase !== 'gas'
        && material.mass > 0;
    })
    .sort((a, b) => a.materialId - b.materialId || a.id.localeCompare(b.id));
}

function oneStackPerMaterial(stacks: PersonState['inventory']): PersonState['inventory'] {
  const seen = new Set<number>();
  return stacks.filter((stack) => {
    if (seen.has(stack.materialId)) return false;
    seen.add(stack.materialId);
    return true;
  });
}

function materialPairKey(firstMaterialId: number, secondMaterialId: number): string {
  return firstMaterialId <= secondMaterialId
    ? `${firstMaterialId}+${secondMaterialId}`
    : `${secondMaterialId}+${firstMaterialId}`;
}

function inventoryCombinationTechniquePrefix(firstMaterialId: number, secondMaterialId: number): string {
  const first = Math.min(firstMaterialId, secondMaterialId);
  const second = Math.max(firstMaterialId, secondMaterialId);
  const inputKey = first === second ? `${first}x2` : `${first}x1+${second}x1`;
  return `technique:combine-inventory:${inputKey}:`;
}

function knownTechniqueForPrefix(person: PersonState, prefix: string) {
  return person.knowledge.find((fact) => fact.kind === 'technique' && fact.id.startsWith(prefix));
}

function productionToolRank(materialId: number): number {
  if (materialId === Material.IronTool) return 5;
  if (materialId === Material.BronzeTool) return 4;
  if (materialId === Material.StoneHoe) return 3;
  if (materialId === Material.StoneTool || materialId === Material.Spear) return 2;
  if (materialId === Material.WoodTool || materialId === Material.BoneTool) return 1;
  return 0;
}

function bestProductionTool(person: PersonState) {
  return person.inventory
    .filter((stack) => stack.quantity > 0 && productionToolRank(stack.materialId) > 0)
    .sort((left, right) => productionToolRank(right.materialId) - productionToolRank(left.materialId)
      || left.id.localeCompare(right.id))[0];
}

export function visibleRadius(person: PersonState): number {
  return 4 + Math.floor(person.baselineCapacities.perception / 25);
}

export function visibleCellsFor(person: PersonState): number[] {
  return cellsInRadius(person.position.cellId, visibleRadius(person));
}

function actionForDrop(person: PersonState, drop: DropState): PrimitiveAction {
  if (person.position.cellId === drop.cellId && person.position.z === drop.z) {
    return {
      kind: 'transfer',
      materialId: drop.materialId,
      quantity: Math.min(3, drop.quantity),
      from: { kind: 'ground', cellId: drop.cellId, z: drop.z },
      to: { kind: 'person', personId: person.id },
      dropId: drop.id,
    };
  }
  return { kind: 'move', toCellId: drop.cellId, toZ: drop.z };
}

function optionForDrop(person: PersonState, drop: DropState): ActionOption {
  const material = materialDefinition(drop.materialId);
  const current = inventoryQuantity(person, drop.materialId);
  return {
    id: `collect:${drop.id}`,
    summary: `取得${material.name}`,
    reason: `看见地上的${material.name}`,
    goal: { kind: 'inventory-at-least', materialId: drop.materialId, quantity: current + Math.min(3, drop.quantity) },
    nextAction: actionForDrop(person, drop),
    estimatedDuration: person.position.cellId === drop.cellId && person.position.z === drop.z ? 'one-month' : 'several-months',
    sourceFactIds: drop.sourceEventIds,
  };
}

function withPlanning(state: SimulationState, person: PersonState, option: ActionOption): ActionOption | null {
  const recentlyFailed = person.memories.some((memory) => memory.kind === 'failure'
    && state.clock.elapsedMonths - memory.createdAtMonth <= 6
    && memory.summary.includes(option.summary));
  if (recentlyFailed) return null;
  const destination = option.nextAction.kind === 'move' ? option.nextAction.toCellId : person.position.cellId;
  const path = findStandingPath(state.world.grid, person.position, {
    cellId: destination,
    ...(option.nextAction.kind === 'move' && option.nextAction.toZ !== undefined ? { z: option.nextAction.toZ } : {}),
  });
  if (option.nextAction.kind === 'move' && !path.length) return null;
  const estimatedMonths = option.nextAction.kind === 'move' ? Math.max(1, Math.ceil((path.length - 1) / PLANNING_TICKS_PER_MONTH)) : 1;
  const risks: string[] = [];
  if (person.body.hydration - estimatedMonths * 1.6 < 18) risks.push('途中可能脱水');
  if (person.body.nutrition - estimatedMonths * 1.5 < 18) risks.push('途中可能饥饿');
  const inferredDomain = option.nextAction.kind === 'communicate' || option.target?.kind === 'person' || option.goal.kind === 'near-person'
    ? 'social'
    : 'strategic';
  return { ...option, domain: option.domain ?? inferredDomain, estimatedMonths, risks };
}

const REQUIRED_SOCIAL_RESPONSE = /^(?:(?:accept|reject)-(?:assist|companion|exchange|reproduce|collective|membership|permission|decision-rule|mandate):|respond-conversation:)/;
const FULFILLMENT_OPTION = /^(settle-exchange|fulfill-assist|meet-to-assist|join-water-assist|contribute-mandate|distribute-mandate|use-permission|demonstrate-technique):/;

function socialInteractionKey(action: PrimitiveAction): string | null {
  if (action.kind !== 'communicate') return null;
  const content = action.content;
  const proposalKind = (content.kind === 'request' || content.kind === 'offer') ? content.proposal?.kind : undefined;
  const subject = proposalKind
    ?? (content.kind === 'claim' ? content.conversation?.basisKey ?? content.factId ?? 'situation' : content.kind);
  return `${content.kind}:${subject}:${[...action.audience].sort().join(',')}`;
}

function isOptionalSocialInitiation(option: ActionOption): boolean {
  if (option.domain !== 'social' || option.nextAction.kind !== 'communicate') return false;
  if (REQUIRED_SOCIAL_RESPONSE.test(option.id) || FULFILLMENT_OPTION.test(option.id)) return false;
  return option.nextAction.content.kind === 'request'
    || option.nextAction.content.kind === 'offer'
    || option.nextAction.content.kind === 'claim';
}

function recentlyRepeatedSocialOption(state: SimulationState, person: PersonState, option: ActionOption): boolean {
  if (!isOptionalSocialInitiation(option)) return false;
  const key = socialInteractionKey(option.nextAction);
  if (!key) return false;
  const oldestRelevantMonth = state.clock.elapsedMonths - 2;
  for (let index = state.world.past.length - 1; index >= 0; index -= 1) {
    const event = state.world.past[index];
    if (event.atMonth < oldestRelevantMonth) break;
    if (event.kind === 'action'
      && event.who === person.id
      && socialInteractionKey(event.action) === key) return true;
  }
  return false;
}

function decisionOptionPriority(option: ActionOption): number {
  if (REQUIRED_SOCIAL_RESPONSE.test(option.id)) return 0;
  if (FULFILLMENT_OPTION.test(option.id)) return 1;
  return option.domain === 'strategic' ? 2 : 3;
}

function localPeopleWithDifferentGoods(person: PersonState, people: PersonState[]) {
  return people.flatMap((other) => {
    if (!sameLocation(other, person)) return [];
    const own = person.inventory.find((stack) => stack.quantity >= 2 && !other.inventory.some((item) => item.materialId === stack.materialId));
    const their = other.inventory.find((stack) => stack.quantity >= 2 && !person.inventory.some((item) => item.materialId === stack.materialId));
    return own && their ? [{ person: other, own, their }] : [];
  });
}

function nextFirePosition(state: SimulationState, person: PersonState): { x: number; y: number; z: number } | null {
  const occupied = new Set(state.people.filter(isAlive).map((candidate) => candidate.position.cellId));
  const targetCell = neighbors4(person.position.cellId)
    .filter((cellId) => {
      const surface = surfaceMaterial(state.world.grid, cellId);
      return surface !== Material.Air && surface !== Material.Water && surface !== Material.Fire && !occupied.has(cellId);
    })
    .sort((a, b) => a - b)
    .find((cellId) => {
      const z = topZ(state.world.grid, cellId) + 1;
      return z >= 0 && z < state.world.grid.levels && voxelAt(state.world.grid, cellX(cellId), cellY(cellId), z) === Material.Air;
    });
  if (targetCell === undefined) return null;
  return { x: cellX(targetCell), y: cellY(targetCell), z: topZ(state.world.grid, targetCell) + 1 };
}

function buildOptions(
  state: SimulationState,
  person: PersonState,
  visibleCells: number[],
  visibleDrops: DropState[],
  visiblePeople: PersonState[],
  visibleAnimals: AnimalState[],
): ActionOption[] {
  const options: ActionOption[] = [];
  const visible = new Set(visibleCells);
  const localPeople = visiblePeople.filter((other) => sameLocation(other, person));
  const foodStack = person.inventory.find((stack) => materialHas(stack.materialId, 'edible') && stack.quantity > 0);
  if (foodStack && person.body.nutrition < 88) options.push({
    id: `eat:${foodStack.id}`,
    summary: `食用${materialDefinition(foodStack.materialId).name}`,
    reason: '背包里有可食物质',
    goal: { kind: 'body-at-least', field: 'nutrition', value: Math.min(100, person.body.nutrition + 35) },
    nextAction: { kind: 'act', operation: 'ingest', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: foodStack.id }] },
    estimatedDuration: 'one-month',
    sourceFactIds: foodStack.sourceEventIds,
  });

  const water = findReachableWater(state, person, visible);
  if (water && person.body.hydration < 90) {
    const atBank = person.position.cellId === water.bankPosition.cellId && person.position.z === water.bankPosition.z;
    options.push({
      id: `drink:${water.waterPosition.x}:${water.waterPosition.y}:${water.waterPosition.z}`,
      summary: '接近并饮用地表水',
      reason: water.remembered ? '记得一处仍存在且可以走到的水源' : '看见邻近地表水',
      goal: { kind: 'body-at-least', field: 'hydration', value: Math.min(100, person.body.hydration + 45) },
      nextAction: atBank
        ? { kind: 'act', operation: 'ingest', targets: [{ kind: 'voxel', position: water.waterPosition }] }
        : { kind: 'move', toCellId: water.bankPosition.cellId, toZ: water.bankPosition.z },
      estimatedDuration: atBank ? 'one-month' : 'several-months',
      sourceFactIds: water.sourceEventIds,
    });
  }

  const localSleepers = localPeople.filter((other) => other.conditions.some((condition) => condition.kind === 'dehydrated-hibernation'
    && condition.sinceMonth < state.civilization.era.sinceMonth));
  if (state.civilization.epoch === 'stable' && water && localSleepers.length) {
    const sleeper = localSleepers[0];
    options.push({
      id: `rehydrate:${sleeper.id}:${state.clock.elapsedMonths}`,
      summary: `使${sleeper.name}重新水化苏醒`,
      reason: '恒纪元已经到来，附近有水源且对方仍处于脱水休眠',
      goal: { kind: 'condition', personId: sleeper.id, condition: 'dehydrated-hibernation', present: false },
      nextAction: { kind: 'act', operation: 'rehydrate', targets: [{ kind: 'person', personId: sleeper.id }] },
      target: { kind: 'person', personId: sleeper.id },
      estimatedDuration: 'one-month',
      sourceFactIds: sleeper.conditions.find((condition) => condition.kind === 'dehydrated-hibernation')?.sourceEventIds ?? [],
    });
  }

  const predictionsAboutChaos = state.eraPredictions
    .filter((prediction) => prediction.status === 'pending'
      && prediction.targetEpoch === 'chaotic'
      && prediction.predictedStartMonth - state.clock.elapsedMonths <= 5
      && prediction.predictedStartMonth + prediction.toleranceMonths >= state.clock.elapsedMonths)
    .sort((a, b) => a.predictedStartMonth - b.predictedStartMonth || a.id.localeCompare(b.id));
  const trustedChaosPrediction = predictionsAboutChaos.find((prediction) => {
    if (prediction.predictorId === person.id) return true;
    if (!prediction.audienceIds.includes(person.id)) return false;
    const resolved = state.eraPredictions.filter((candidate) => candidate.predictorId === prediction.predictorId && candidate.status !== 'pending');
    const correct = resolved.filter((candidate) => candidate.status === 'correct').length;
    const trust = person.relations.find((relation) => relation.personId === prediction.predictorId)?.trust ?? 0;
    return trust >= 22 || (resolved.length >= 2 && correct / resolved.length >= 0.6 && trust >= 8);
  });
  const canHibernate = !person.conditions.some((condition) => condition.kind === 'dehydrated-hibernation'
    || condition.kind === 'pregnancy'
    || ((condition.kind === 'wound' || condition.kind === 'illness') && condition.stage >= 2))
    && Math.min(person.body.health, person.body.hydration, person.body.nutrition) >= 45;
  if (canHibernate && (trustedChaosPrediction || (state.civilization.epoch === 'chaotic' && state.civilization.climate.severity >= 4))) {
    options.push({
      id: `dehydrate-chaos:${trustedChaosPrediction?.id ?? `observed-${state.civilization.era.sequence}`}`,
      summary: '主动进入脱水休眠',
      reason: trustedChaosPrediction
        ? '一项自己相信的预言指向即将到来的乱纪元'
        : '乱纪元已在造成强烈环境压力',
      goal: { kind: 'condition', personId: person.id, condition: 'dehydrated-hibernation', present: true },
      nextAction: { kind: 'act', operation: 'dehydrate', targets: [{ kind: 'person', personId: person.id }] },
      target: { kind: 'person', personId: person.id },
      estimatedDuration: 'one-month',
      sourceFactIds: trustedChaosPrediction?.sourceEventIds ?? [],
      domain: 'strategic',
    });
  }

  const forecastCapacity = person.baselineCapacities.cognition + person.baselineCapacities.perception;
  const existingForecast = state.eraPredictions.some((prediction) => prediction.predictorId === person.id && prediction.status === 'pending');
  const recentForecast = state.eraPredictions.some((prediction) => prediction.predictorId === person.id && state.clock.elapsedMonths - prediction.madeAtMonth < 6);
  const predictionAudience = visiblePeople.slice(0, 4);
  if (predictionAudience.length && forecastCapacity >= 118 && !existingForecast && !recentForecast) {
    const actualStart = state.civilization.era.endsAtMonth + 1;
    const skill = forecastCapacity / 2;
    const uncertainty = Math.max(3, Math.round(17 - (skill - 42) * 0.22));
    const noise = Math.round((seededFraction(state.seed, `era-forecast:${state.clock.elapsedMonths}:${person.id}:${state.civilization.era.sequence}`) * 2 - 1) * uncertainty);
    const predictedStartMonth = Math.max(state.clock.elapsedMonths + 2, actualStart + noise);
    const targetEpoch = state.civilization.epoch === 'stable' ? 'chaotic' as const : 'stable' as const;
    const representationId = `predict-era:${state.clock.elapsedMonths}:${person.id}:${state.civilization.era.sequence}`;
    options.push({
      id: representationId,
      summary: `预言第 ${predictedStartMonth} 月前后将进入${targetEpoch === 'chaotic' ? '乱纪元' : '恒纪元'}`,
      reason: '对天象、气温和过去纪元节律的观察可以形成一项有误差的预测',
      goal: { kind: 'representation-made', representationId },
      nextAction: {
        kind: 'communicate',
        content: {
          id: representationId,
          kind: 'prediction',
          summary: `预言第 ${predictedStartMonth} 月前后将进入${targetEpoch === 'chaotic' ? '乱纪元' : '恒纪元'}`,
          prediction: {
            targetEpoch,
            predictedStartMonth,
            toleranceMonths: 3,
            expiresAtMonth: predictedStartMonth + 3,
          },
        },
        audience: predictionAudience.map((listener) => listener.id),
        channel: 'voice',
      },
      estimatedDuration: 'one-month',
      sourceFactIds: state.world.past
        .filter((event) => event.kind === 'environment' && (event.change === 'climate' || event.change === 'weather'))
        .slice(-8)
        .map((event) => event.id),
      domain: 'strategic',
    });
  }

  const thermalPressure = person.conditions
    .filter((condition) => condition.kind === 'cold' || condition.kind === 'heat')
    .sort((a, b) => b.stage - a.stage)[0];
  const hostileClimate = state.civilization.climate.kind === 'cold'
    || state.civilization.climate.kind === 'heat'
    || state.civilization.climate.kind === 'fire';
  if (thermalPressure || hostileClimate) {
    const shelter = findReachableShelter(state, person, visible);
    if (shelter) options.push({
      id: `shelter:${shelter.structureId}:${shelter.position.cellId}:${shelter.position.z}`,
      summary: '进入可用住所躲避环境压力',
      reason: thermalPressure
        ? `${thermalPressure.kind === 'cold' ? '寒冷' : '炎热'}状态已经影响身体`
        : `当前${state.civilization.climate.kind === 'cold' ? '寒冷' : state.civilization.climate.kind === 'heat' ? '炎热' : '烈火'}环境会持续消耗身体`,
      goal: { kind: 'sheltered' },
      nextAction: { kind: 'move', toCellId: shelter.position.cellId, toZ: shelter.position.z },
      estimatedDuration: shelter.pathLength <= 2 ? 'one-month' : 'several-months',
      sourceFactIds: shelter.sourceEventIds,
    });
  }

  const nearestDropsByMaterial = new Map<number, DropState>();
  for (const drop of [...visibleDrops].sort((a, b) => distance(person.position.cellId, a.cellId) - distance(person.position.cellId, b.cellId) || a.id.localeCompare(b.id))) {
    if (!nearestDropsByMaterial.has(drop.materialId)) nearestDropsByMaterial.set(drop.materialId, drop);
  }
  for (const drop of [...nearestDropsByMaterial.values()].slice(0, 8)) {
    options.push(optionForDrop(person, drop));
  }

  const huntingTool = person.inventory.find((stack) => stack.quantity > 0 && stack.materialId === Material.Spear)
    ?? bestProductionTool(person);
  const nearbyAnimals = [...visibleAnimals]
    .filter(isAnimalAlive)
    .sort((a, b) => distance(person.position.cellId, a.position.cellId) - distance(person.position.cellId, b.position.cellId) || a.id.localeCompare(b.id));
  for (const animal of nearbyAnimals.slice(0, 3)) {
    const species = animalSpecies(animal.speciesId);
    const together = person.position.cellId === animal.position.cellId && person.position.z === animal.position.z;
    options.push({
      id: `hunt:${animal.id}`,
      summary: `追踪并捕猎${species.name}`,
      reason: species.diet === 'predator'
        ? '附近的捕食动物可能伤害人类，也可提供肉、皮与骨'
        : person.body.nutrition < 62 ? '食物储备不高，眼前动物可以成为新的食物来源' : '动物可以提供尚未掌握的肉、皮与骨',
      goal: { kind: 'inventory-at-least', materialId: Material.RawMeat, quantity: inventoryQuantity(person, Material.RawMeat) + 1 },
      nextAction: together
        ? { kind: 'act', operation: 'hunt', targets: [{ kind: 'animal', animalId: animal.id }], ...(huntingTool ? { toolStackId: huntingTool.id } : {}) }
        : { kind: 'move', toCellId: animal.position.cellId, toZ: animal.position.z },
      target: { kind: 'animal', animalId: animal.id },
      estimatedDuration: together ? 'one-month' : 'several-months',
      sourceFactIds: [],
      risks: species.aggression > 0 ? ['动物可能反击'] : [],
    });
  }
  const unknownAnimal = nearbyAnimals.find((animal) => !person.knowledge.some((fact) => fact.id === `animal:${animal.speciesId}`));
  if (unknownAnimal) options.push({
    id: `attend-animal:${unknownAnimal.id}`,
    summary: `持续观察${animalSpecies(unknownAnimal.speciesId).name}`,
    reason: '这种活体的行为还没有形成可靠认识',
    goal: { kind: 'knowledge', factId: `animal:${unknownAnimal.speciesId}` },
    nextAction: { kind: 'attend', target: { kind: 'animal', animalId: unknownAnimal.id } },
    target: { kind: 'animal', animalId: unknownAnimal.id },
    estimatedDuration: 'one-month',
    sourceFactIds: [],
  });

  options.push(...buildMaterialSeparationOptions(state, person, visibleCells));
  options.push(...buildContainerOptions(state, person, visibleCells));

  const productionTool = bestProductionTool(person);

  for (const cellId of visibleCells) {
    const surface = surfaceMaterial(state.world.grid, cellId);
    const position = topPosition(state.world.grid, cellId);
    if (surface === Material.Wood || surface === Material.Leaves) {
      const standCell = nearestCell(person.position.cellId, neighbors4(cellId).filter((id) => isPassable(state.world.grid, id)));
      if (standCell !== null) options.push({
        id: `separate:wood:${cellId}`,
        summary: '从树木取得木材',
        reason: '看见可以分离的树木物质',
        goal: { kind: 'inventory-at-least', materialId: Material.Wood, quantity: inventoryQuantity(person, Material.Wood) + 2 },
        nextAction: person.position.cellId === standCell
          ? { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position }], ...(productionTool ? { toolStackId: productionTool.id } : {}) }
          : { kind: 'move', toCellId: standCell },
        target: { kind: 'voxel', position },
        estimatedDuration: 'several-months',
        sourceFactIds: [],
      });
    }
    if (surface === Material.CropMature || surface === Material.BerryBush) options.push({
      id: `harvest:${cellId}`,
      summary: surface === Material.CropMature ? '分离成熟作物' : '从结果灌木分离食物与种子',
      reason: surface === Material.CropMature ? '看见已经成熟的作物物质' : '看见结出可分离食物的灌木物质',
      goal: { kind: 'inventory-at-least', materialId: Material.Food, quantity: inventoryQuantity(person, Material.Food) + 2 },
      nextAction: person.position.cellId === cellId
        ? { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position }], ...(productionTool ? { toolStackId: productionTool.id } : {}) }
        : { kind: 'move', toCellId: cellId },
      target: { kind: 'voxel', position },
      estimatedDuration: 'several-months',
      sourceFactIds: [],
    });
  }

  const combinableStacks = tangibleInventoryStacks(person);
  const inventoryTrials: Array<{
    first: typeof combinableStacks[number];
    second: typeof combinableStacks[number];
    materialKey: string;
  }> = [];
  const seenInventoryTrialKeys = new Set<string>();
  for (let firstIndex = 0; firstIndex < combinableStacks.length; firstIndex += 1) {
    for (let secondIndex = firstIndex; secondIndex < combinableStacks.length; secondIndex += 1) {
      const first = combinableStacks[firstIndex];
      const second = combinableStacks[secondIndex];
      if (first.id === second.id && first.quantity < 2) continue;
      const materialKey = materialPairKey(first.materialId, second.materialId);
      if (seenInventoryTrialKeys.has(materialKey)) continue;
      seenInventoryTrialKeys.add(materialKey);
      inventoryTrials.push({ first, second, materialKey });
    }
  }
  for (const { first, second, known } of inventoryTrials
    .filter(({ first, second }) => !knowsReliableNoResponse(person, inventoryNoResponseFactId([first.materialId, second.materialId])))
    .map((trial) => ({
      ...trial,
      known: knownTechniqueForPrefix(person, inventoryCombinationTechniquePrefix(trial.first.materialId, trial.second.materialId)),
      stableRank: seededFraction(state.seed, `ordinary-inventory-combine:${person.id}:${trial.materialKey}`),
    }))
    .sort((a, b) => (a.known ? 0 : 1) - (b.known ? 0 : 1)
      || a.stableRank - b.stableRank
      || a.materialKey.localeCompare(b.materialKey)
      || a.first.id.localeCompare(b.first.id)
      || a.second.id.localeCompare(b.second.id))
    .slice(0, MAX_LOCAL_INTERACTION_OPTIONS)) {
    const trialId = `${known ? 'repeat-inventory-combine' : 'try-inventory-combine'}:${first.id}:${second.id}`;
    options.push({
      id: trialId,
      summary: known ? `尝试复现“${known.summary}”` : `尝试结合${materialDefinition(first.materialId).name}与${materialDefinition(second.materialId).name}`,
      reason: known ? '自己已有这项物质经验' : '背包中的两种物质可以尝试局部结合，但结果未知',
      goal: { kind: 'knowledge', factId: `attempt:${trialId}:${state.clock.elapsedMonths}` },
      nextAction: {
        kind: 'act', operation: 'combine',
        targets: [
          { kind: 'inventory-stack', personId: person.id, stackId: first.id },
          { kind: 'inventory-stack', personId: person.id, stackId: second.id },
        ],
      },
      estimatedDuration: 'one-month',
      sourceFactIds: [...new Set([...first.sourceEventIds, ...second.sourceEventIds, ...(known?.sourceEventIds ?? [])])],
    });
  }

  const stoneTool = tangibleInventoryStacks(person).find((stack) => stack.materialId === Material.StoneTool);
  const exertPosition = stoneTool ? nextFirePosition(state, person) : null;
  if (stoneTool && exertPosition) {
    const exertInputs = oneStackPerMaterial(tangibleInventoryStacks(person, stoneTool.id))
      .filter((input) => !knowsReliableNoResponse(person, voxelNoResponseFactId('exert', input.materialId, Material.Air, stoneTool.materialId)))
      .map((input) => ({
        input,
        known: knownTechniqueForPrefix(person, `technique:exert:${stoneTool.materialId}:${input.materialId}:${Material.Air}:`),
        stableRank: seededFraction(state.seed, `ordinary-exert:${person.id}:${stoneTool.materialId}:${input.materialId}`),
      }))
      .sort((a, b) => (a.known ? 0 : 1) - (b.known ? 0 : 1)
        || a.stableRank - b.stableRank
        || a.input.materialId - b.input.materialId
        || a.input.id.localeCompare(b.input.id))
      .slice(0, MAX_LOCAL_INTERACTION_OPTIONS);
    for (const { input, known } of exertInputs) {
      options.push({
        id: `${known ? 'repeat-exert' : 'try-exert'}:${stoneTool.id}:${input.id}:${exertPosition.x}:${exertPosition.y}:${exertPosition.z}`,
        summary: known ? `尝试复现“${known.summary}”` : `尝试用石制工具向${materialDefinition(input.materialId).name}施力`,
        reason: known ? '自己已有这项物质经验' : `手中的硬质工具与${materialDefinition(input.materialId).name}可以进行局部施力尝试，但结果未知`,
        goal: known
          ? { kind: 'knowledge', factId: known.id, minConfidence: Math.min(100, known.confidence + 18) }
          : { kind: 'knowledge', factId: `attempt:exert:${state.clock.elapsedMonths}:${person.id}:${input.id}` },
        nextAction: {
          kind: 'act', operation: 'exert', toolStackId: stoneTool.id,
          targets: [
            { kind: 'inventory-stack', personId: person.id, stackId: input.id },
            { kind: 'voxel', position: exertPosition },
          ],
        },
        target: { kind: 'voxel', position: exertPosition },
        estimatedDuration: 'one-month',
        sourceFactIds: [...new Set([...stoneTool.sourceEventIds, ...input.sourceEventIds, ...(known?.sourceEventIds ?? [])])],
      });
    }
  }

  const blankRecord = person.inventory.find((stack) => stack.materialId === Material.WoodTablet && !stack.recordPayloadId && stack.quantity > 0);
  const recordableKnowledge = person.knowledge
    .filter((fact) => fact.kind !== 'codebook'
      && fact.confidence >= 55
      && !state.records.some((record) => record.authorId === person.id && record.knowledgeId === fact.id))
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))[0];
  if (blankRecord && recordableKnowledge) {
    const representationId = `write-record:${state.clock.elapsedMonths}:${person.id}:${recordableKnowledge.id}`;
    options.push({
      id: representationId,
      summary: `把已核验知识刻写到木制记录板`,
      reason: '持有空白实体载体，可以让个人知识在记忆之外持续存在',
      goal: { kind: 'representation-made', representationId },
      nextAction: { kind: 'communicate', content: { id: representationId, kind: 'claim', summary: recordableKnowledge.summary, factId: recordableKnowledge.id }, audience: [], channel: 'record', carrierStackId: blankRecord.id },
      target: { kind: 'inventory-stack', personId: person.id, stackId: blankRecord.id },
      estimatedDuration: 'one-month', sourceFactIds: [...recordableKnowledge.sourceEventIds, ...blankRecord.sourceEventIds],
      domain: 'strategic',
    });
  }

  const nearbyFireCell = cellsInRadius(person.position.cellId, 1)
    .filter((cellId) => materialHas(surfaceMaterial(state.world.grid, cellId), 'hot'))
    .sort((a, b) => distance(person.position.cellId, a) - distance(person.position.cellId, b) || a - b)[0];
  if (nearbyFireCell !== undefined) {
    const position = topPosition(state.world.grid, nearbyFireCell);
    const hotMaterialId = surfaceMaterial(state.world.grid, nearbyFireCell);
    const exposureInputs = oneStackPerMaterial(tangibleInventoryStacks(person))
      .filter((input) => !knowsReliableNoResponse(person, voxelNoResponseFactId('expose', input.materialId, hotMaterialId)))
      .map((input) => ({
        input,
        known: knownTechniqueForPrefix(person, `technique:expose:${input.materialId}:${hotMaterialId}:`),
        stableRank: seededFraction(state.seed, `ordinary-expose:${person.id}:${input.materialId}:${hotMaterialId}`),
      }))
      .sort((a, b) => (a.known ? 0 : 1) - (b.known ? 0 : 1)
        || a.stableRank - b.stableRank
        || a.input.materialId - b.input.materialId
        || a.input.id.localeCompare(b.input.id))
      .slice(0, MAX_LOCAL_INTERACTION_OPTIONS);
    for (const { input, known } of exposureInputs) {
      options.push({
        id: `${known ? 'repeat-expose' : 'try-expose'}:${input.id}:${nearbyFireCell}`,
        summary: known ? `尝试复现“${known.summary}”` : `尝试让${materialDefinition(input.materialId).name}暴露于邻近${materialDefinition(hotMaterialId).name}`,
        reason: known ? '自己已有这项物质经验' : `手中的${materialDefinition(input.materialId).name}与持续放热的${materialDefinition(hotMaterialId).name}近在身边，可以尝试观察其变化`,
        goal: known
          ? { kind: 'knowledge', factId: known.id, minConfidence: Math.min(100, known.confidence + 18) }
          : { kind: 'knowledge', factId: `attempt:expose:${state.clock.elapsedMonths}:${person.id}:${input.id}` },
        nextAction: { kind: 'act', operation: 'expose', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: input.id }, { kind: 'voxel', position }] },
        target: { kind: 'voxel', position }, estimatedDuration: 'one-month',
        sourceFactIds: [...new Set([...input.sourceEventIds, ...(known?.sourceEventIds ?? [])])],
      });
    }
  }

  const seed = person.inventory.find((stack) => stack.materialId === Material.Seed && stack.quantity > 0);
  if (seed) {
    const trialSurfaces = new Set<number>([Material.Soil, Material.WetSoil, Material.RichSoil, Material.ExhaustedSoil, Material.Sand, Material.Grass]);
    const candidateSurfaces = new Map<number, number>();
    for (const cellId of [...visibleCells].sort((a, b) => distance(person.position.cellId, a) - distance(person.position.cellId, b) || a - b)) {
      const surface = surfaceMaterial(state.world.grid, cellId);
      if (!trialSurfaces.has(surface)) continue;
      if (!candidateSurfaces.has(surface)) candidateSurfaces.set(surface, cellId);
    }
    const learnedTargetMaterials = new Set(person.knowledge
      .filter((fact) => fact.kind === 'technique' && fact.id.startsWith(`technique:combine:${Material.Seed}:`))
      .map((fact) => Number(fact.id.split(':')[3])));
    const candidates = [...candidateSurfaces]
      .filter(([materialId]) => learnedTargetMaterials.has(materialId)
        || !knowsReliableNoResponse(person, voxelNoResponseFactId('combine', Material.Seed, materialId)))
      .sort(([materialA, cellA], [materialB, cellB]) => {
        const learnedA = learnedTargetMaterials.has(materialA) ? 1 : 0;
        const learnedB = learnedTargetMaterials.has(materialB) ? 1 : 0;
        return learnedB - learnedA || distance(person.position.cellId, cellA) - distance(person.position.cellId, cellB) || materialA - materialB;
      }).slice(0, 3);
    for (const [targetMaterial, soilCell] of candidates) {
      const position = topPosition(state.world.grid, soilCell);
      const technique = person.knowledge.find((fact) => fact.id === `technique:combine:${Material.Seed}:${targetMaterial}:${Material.CropSprout}`);
      options.push({
        id: `${technique ? 'repeat-combine' : 'try-combine'}:${Material.Seed}:${targetMaterial}:${soilCell}:${seed.id}`,
        summary: technique
          ? `尝试复现“${technique.summary}”`
          : `尝试让种子接触${materialDefinition(targetMaterial).name}`,
        reason: technique
          ? `自己${technique.confidence >= 55 ? '已经核验' : '听说或初步见过'}这项物质经验`
          : '持有种子，可以对一种眼前物质作局部尝试，但结果未知',
        goal: { kind: 'voxel-is', position, materialId: Material.CropSprout },
        nextAction: person.position.cellId === soilCell
          ? { kind: 'act', operation: 'combine', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: seed.id }, { kind: 'voxel', position }] }
          : { kind: 'move', toCellId: soilCell },
        target: { kind: 'voxel', position },
        estimatedDuration: 'several-months',
        sourceFactIds: [...seed.sourceEventIds, ...(technique?.sourceEventIds ?? [])],
      });
    }
  }

  // Free-form building materials are governed by causal construction projects,
  // but an already crafted placeable utility still needs a legal placement affordance.
  options.push(...buildConstructionOptions(state, person)
    .filter((option) => option.goal.kind === 'voxel-is' && option.goal.materialId === Material.Container));
  const projectOptions = buildProjectOptions(state, person, visibleCells, visibleDrops, visiblePeople);
  options.push(...projectOptions);
  options.push(...buildDemandBoundRecordUseOptions(state, person, visiblePeople));

  const carriedFood = person.inventory.find((stack) => stack.materialId === Material.Food && stack.quantity >= 2);
  const hungry = visiblePeople.filter((other) => other.body.nutrition < 45).sort((a, b) => a.body.nutrition - b.body.nutrition)[0];
  if (carriedFood && hungry && sameLocation(hungry, person)) options.push({
    id: `share:${carriedFood.id}:${hungry.id}`,
    summary: `把食物交给${hungry.name}`,
    reason: `${hungry.name}营养不足且就在身边`,
    goal: { kind: 'inventory-at-least', materialId: Material.Food, quantity: inventoryQuantity(hungry, Material.Food) + 1, personId: hungry.id },
    nextAction: {
      kind: 'transfer', materialId: Material.Food, quantity: 1,
      from: { kind: 'person', personId: person.id }, to: { kind: 'person', personId: hungry.id }, stackId: carriedFood.id,
    },
    estimatedDuration: 'one-month',
    sourceFactIds: carriedFood.sourceEventIds,
  });

  const incomingExchange = openExchangeOfferFor(state, person.id);
  if (incomingExchange) {
    const proposal = incomingExchange.content.proposal;
    const offerer = state.people.find((other) => other.id === incomingExchange.fact.who);
    if (proposal?.kind === 'exchange' && offerer) {
      const representationId = `accept:${incomingExchange.content.id}:${person.id}`;
      const together = sameLocation(offerer, person);
      const acceptAction = { kind: 'communicate' as const, content: { id: representationId, kind: 'accept' as const, referenceId: incomingExchange.content.id }, audience: [offerer.id], channel: 'voice' as const };
      if (inventoryQuantity(person, proposal.partnerMaterialId) >= proposal.partnerQuantity) options.push({
        id: `accept-exchange:${incomingExchange.content.id}`,
        summary: `接受以${materialDefinition(proposal.partnerMaterialId).name}换取${materialDefinition(proposal.offererMaterialId).name}`,
        reason: '存在一项自己有能力履行的交换报价',
        goal: { kind: 'representation-made', representationId },
        nextAction: together ? acceptAction : { kind: 'move', toCellId: offerer.position.cellId, toZ: offerer.position.z },
        ...(!together ? { completionAction: acceptAction } : {}),
        target: { kind: 'person', personId: offerer.id },
        estimatedDuration: together ? 'one-month' : 'several-months',
        sourceFactIds: [incomingExchange.fact.id],
      });
      const rejectId = `reject:${incomingExchange.content.id}:${person.id}`;
      const rejectAction = { kind: 'communicate' as const, content: { id: rejectId, kind: 'reject' as const, referenceId: incomingExchange.content.id }, audience: [offerer.id], channel: 'voice' as const };
      options.push({
        id: `reject-exchange:${incomingExchange.content.id}`,
        summary: `拒绝这项物质交换`,
        reason: '存在一项需要明确回应的交换报价',
        goal: { kind: 'representation-made', representationId: rejectId },
        nextAction: together ? rejectAction : { kind: 'move', toCellId: offerer.position.cellId, toZ: offerer.position.z },
        ...(!together ? { completionAction: rejectAction } : {}),
        target: { kind: 'person', personId: offerer.id }, estimatedDuration: together ? 'one-month' : 'several-months', sourceFactIds: [incomingExchange.fact.id],
      });
    }
  }

  const acceptedExchange = acceptedExchangeFor(state, person.id, state.clock.elapsedMonths);
  if (acceptedExchange && !exchangeTermFulfilled(state, acceptedExchange.offer.action.kind === 'communicate' ? acceptedExchange.offer.action.content.id : '', person.id)) {
    const proposal = acceptedExchange.proposal;
    const materialId = proposal.offererId === person.id ? proposal.offererMaterialId : proposal.partnerMaterialId;
    const quantity = proposal.offererId === person.id ? proposal.offererQuantity : proposal.partnerQuantity;
    const receiverId = proposal.offererId === person.id ? proposal.partnerId : proposal.offererId;
    const stack = person.inventory.find((item) => item.materialId === materialId && item.quantity >= quantity);
    const receiver = state.people.find((other) => other.id === receiverId);
    if (stack && receiver) options.push({
      id: `settle-exchange:${acceptedExchange.offer.id}:${person.id}`,
      summary: `交付交换中的${materialDefinition(materialId).name}`,
      reason: '双方已经接受报价，本人尚未履行自己的交付',
      goal: { kind: 'inventory-at-least', materialId, quantity: inventoryQuantity(state.people.find((other) => other.id === receiverId) ?? person, materialId) + quantity, personId: receiverId },
      nextAction: sameLocation(receiver, person)
        ? { kind: 'transfer', materialId, quantity, from: { kind: 'person', personId: person.id }, to: { kind: 'person', personId: receiverId }, stackId: stack.id, authorizationRef: acceptedExchange.offer.action.kind === 'communicate' ? acceptedExchange.offer.action.content.id : undefined }
        : { kind: 'move', toCellId: receiver.position.cellId, toZ: receiver.position.z },
      target: { kind: 'person', personId: receiverId },
      estimatedDuration: 'one-month',
      sourceFactIds: [acceptedExchange.offer.id, acceptedExchange.acceptance.id],
    });
  }

  const tradePartner = !incomingExchange && !acceptedExchange ? localPeopleWithDifferentGoods(person, visiblePeople)[0] : undefined;
  if (tradePartner) {
    const representationId = `offer-exchange:${state.clock.elapsedMonths}:${person.id}:${tradePartner.person.id}`;
    options.push({
      id: representationId,
      summary: `向${tradePartner.person.name}提出物质交换`,
      reason: `双方分别持有${materialDefinition(tradePartner.own.materialId).name}与${materialDefinition(tradePartner.their.materialId).name}`,
      goal: { kind: 'representation-made', representationId },
      nextAction: {
        kind: 'communicate',
        content: { id: representationId, kind: 'offer', summary: `用${materialDefinition(tradePartner.own.materialId).name}换取${materialDefinition(tradePartner.their.materialId).name}`, proposal: { kind: 'exchange', offererId: person.id, partnerId: tradePartner.person.id, offererMaterialId: tradePartner.own.materialId, offererQuantity: 1, partnerMaterialId: tradePartner.their.materialId, partnerQuantity: 1, expiresAtMonth: state.clock.elapsedMonths + 12 } },
        audience: [tradePartner.person.id], channel: 'voice',
      },
      target: { kind: 'person', personId: tradePartner.person.id },
      estimatedDuration: 'one-month',
      sourceFactIds: [...tradePartner.own.sourceEventIds, ...tradePartner.their.sourceEventIds],
    });
  }

  const fiber = person.inventory.find((stack) => stack.materialId === Material.HerbalMedicine && stack.quantity > 0)
    ?? person.inventory.find((stack) => stack.materialId === Material.Fiber && stack.quantity > 0);
  const injured = visiblePeople
    .filter((other) => sameLocation(other, person) && other.conditions.some((condition) => condition.kind === 'wound' || condition.kind === 'illness'))
    .sort((a, b) => a.body.health - b.body.health)[0];
  if (fiber && injured) options.push({
    id: `care:${fiber.id}:${injured.id}`,
    summary: `把${materialDefinition(fiber.materialId).name}用于${injured.name}的伤病处`,
    reason: `${injured.name}有持续性伤病，且背包里有可用的${materialDefinition(fiber.materialId).name}`,
    goal: { kind: 'condition', personId: injured.id, condition: injured.conditions.some((item) => item.kind === 'wound') ? 'wound' : 'illness', present: false },
    nextAction: { kind: 'act', operation: 'combine', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: fiber.id }, { kind: 'person', personId: injured.id }] },
    target: { kind: 'person', personId: injured.id },
    estimatedDuration: 'one-month',
    sourceFactIds: [...fiber.sourceEventIds, ...injured.conditions.flatMap((condition) => condition.sourceEventIds)],
  });

  const incomingOffer = openReproductionOfferFor(state, person.id);
  if (incomingOffer) {
    const proposer = state.people.find((other) => other.id === incomingOffer.fact.who);
    if (proposer) {
      const responseBasis = buildRelationshipCausalBasis(state, person, proposer, 'reproduce');
      const relationshipReady = hasCultivatedReproductiveRelationship(state, person, proposer, responseBasis);
      const representationId = `accept:${incomingOffer.content.id}:${person.id}`;
      const together = sameLocation(proposer, person);
      const acceptAction = { kind: 'communicate' as const, content: { id: representationId, kind: 'accept' as const, referenceId: incomingOffer.content.id }, audience: [proposer.id], channel: 'voice' as const };
      const learnedRisk = hasLearnedKinshipRisk(person) && geneticKinshipRisk(state, person, proposer) > 0;
      if (relationshipReady) options.push({
        id: `accept-reproduce:${incomingOffer.content.id}`,
        summary: `接受${proposer.name}的共同生殖提议`,
        reason: learnedRisk ? '过去的后代体弱或疾病记忆使这项选择具有已知风险' : '彼此已有可追溯的共同经历，并建立了最低程度的信任与亲近',
        goal: { kind: 'representation-made', representationId },
        nextAction: together ? acceptAction : { kind: 'move', toCellId: proposer.position.cellId, toZ: proposer.position.z },
        ...(!together ? { completionAction: acceptAction } : {}),
        target: { kind: 'person', personId: proposer.id },
        estimatedDuration: together ? 'one-month' : 'several-months',
        sourceFactIds: [incomingOffer.fact.id],
      });
      const rejectId = `reject:${incomingOffer.content.id}:${person.id}`;
      const rejectAction = { kind: 'communicate' as const, content: { id: rejectId, kind: 'reject' as const, referenceId: incomingOffer.content.id }, audience: [proposer.id], channel: 'voice' as const };
      options.push({
        id: `reject-reproduce:${incomingOffer.content.id}`,
        summary: '拒绝共同生殖提议',
        reason: !relationshipReady
          ? '彼此尚未通过共同经历建立足够的信任与亲近'
          : learnedRisk
            ? '记忆中已有近亲后代体弱或疾病的可追溯经验'
            : '存在一项需要本人明确回应的生殖提议',
        goal: { kind: 'representation-made', representationId: rejectId },
        nextAction: together ? rejectAction : { kind: 'move', toCellId: proposer.position.cellId, toZ: proposer.position.z },
        ...(!together ? { completionAction: rejectAction } : {}),
        target: { kind: 'person', personId: proposer.id },
        estimatedDuration: together ? 'one-month' : 'several-months',
        sourceFactIds: [incomingOffer.fact.id],
      });
    }
  }

  const learnedKinshipRisk = hasLearnedKinshipRisk(person);
  const reproductiveCandidate = visiblePeople.filter((other) => {
    if (other.sex === person.sex) return false;
    const female = person.sex === 'female' ? person : other;
    const male = person.sex === 'male' ? person : other;
    if (ageMonths(female, state.clock.elapsedMonths) < 16 * 12 || ageMonths(female, state.clock.elapsedMonths) > 45 * 12 || ageMonths(male, state.clock.elapsedMonths) < 16 * 12) return false;
    if (female.conditions.some((condition) => condition.kind === 'pregnancy')) return false;
    return Math.min(person.body.health, person.body.hydration, person.body.nutrition, other.body.health, other.body.hydration, other.body.nutrition) >= 62;
  }).map((other) => ({
    other,
    accepted: acceptedReproductionBetween(state, person.id, other.id, state.clock.elapsedMonths),
    basis: buildRelationshipCausalBasis(state, person, other, 'reproduce'),
  })).filter((candidate) => candidate.accepted || canOfferRelationshipProposal(state, person, candidate.other, candidate.basis))
    .sort((a, b) => (a.accepted ? 0 : 1) - (b.accepted ? 0 : 1)
      || (learnedKinshipRisk ? geneticKinshipRisk(state, person, a.other) - geneticKinshipRisk(state, person, b.other) : 0)
      || a.other.id.localeCompare(b.other.id))[0];
  if (reproductiveCandidate) {
    const { other: reproductivePartner, accepted, basis } = reproductiveCandidate;
    const female = person.sex === 'female' ? person : reproductivePartner;
    const together = sameLocation(reproductivePartner, person);
    if (accepted && person.id === female.id) options.push({
      id: `reproduce:${accepted.offer.id}:${reproductivePartner.id}`,
      summary: `与${reproductivePartner.name}共同进行生殖过程`,
      reason: '双方已经通过沟通形成可追溯的接受事实',
      goal: { kind: 'condition', personId: female.id, condition: 'pregnancy', present: true },
      nextAction: together
        ? { kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: reproductivePartner.id }] }
        : { kind: 'move', toCellId: reproductivePartner.position.cellId, toZ: reproductivePartner.position.z },
      ...(!together ? { completionAction: { kind: 'act' as const, operation: 'reproduce' as const, targets: [{ kind: 'person' as const, personId: reproductivePartner.id }] } } : {}),
      target: { kind: 'person', personId: reproductivePartner.id },
      estimatedDuration: 'several-months',
      sourceFactIds: [accepted.offer.id, accepted.acceptance.id],
    });
    else if (!accepted && !incomingOffer) {
      const representationId = `offer-reproduce:${state.clock.elapsedMonths}:${person.id}:${reproductivePartner.id}`;
      options.push({
        id: representationId,
        summary: `向${reproductivePartner.name}提出共同生殖`,
        reason: together
          ? '彼此已有可追溯的共同经历和最低信任、亲近，且身体条件允许生殖'
          : '彼此已有可追溯的共同经历和最低信任、亲近，对方可见且身体条件允许生殖',
        goal: { kind: 'representation-made', representationId },
        nextAction: together ? {
          kind: 'communicate',
          content: { id: representationId, kind: 'offer', summary: '是否愿意共同生育后代', proposal: { kind: 'reproduce', proposerId: person.id, partnerId: reproductivePartner.id, expiresAtMonth: state.clock.elapsedMonths + 4, basis } },
          audience: [reproductivePartner.id], channel: 'voice',
        } : { kind: 'move', toCellId: reproductivePartner.position.cellId, toZ: reproductivePartner.position.z },
        ...(!together ? { completionAction: {
          kind: 'communicate' as const,
          content: { id: representationId, kind: 'offer' as const, summary: '是否愿意共同生育后代', proposal: { kind: 'reproduce' as const, proposerId: person.id, partnerId: reproductivePartner.id, expiresAtMonth: state.clock.elapsedMonths + 4, basis } },
          audience: [reproductivePartner.id], channel: 'voice' as const,
        } } : {}),
        target: { kind: 'person', personId: reproductivePartner.id },
        estimatedDuration: together ? 'one-month' : 'several-months',
        sourceFactIds: basis.sourceFactIds,
        relationshipBasis: basis,
      });
    }
  }

  const vulnerableCarrier = localPeople.find((other) => other.inventory.some((stack) => stack.materialId === Material.Food && stack.quantity > 0));
  if (vulnerableCarrier && person.body.nutrition < 24 && inventoryQuantity(person, Material.Food) === 0) {
    const targetStack = vulnerableCarrier.inventory.find((stack) => stack.materialId === Material.Food && stack.quantity > 0);
    if (targetStack) options.push({
      id: `take-without-permission:${vulnerableCarrier.id}:${targetStack.id}`,
      summary: `尝试从${vulnerableCarrier.name}处取得食物`,
      reason: '自身营养进入危险区，眼前他人持有食物',
      goal: { kind: 'inventory-at-least', materialId: Material.Food, quantity: 1 },
      nextAction: { kind: 'transfer', materialId: Material.Food, quantity: 1, from: { kind: 'person', personId: vulnerableCarrier.id }, to: { kind: 'person', personId: person.id }, stackId: targetStack.id },
      target: { kind: 'person', personId: vulnerableCarrier.id },
      estimatedDuration: 'one-month',
      sourceFactIds: targetStack.sourceEventIds,
    });
  }

  const ownRestraint = person.conditions.find((condition) => condition.kind === 'restrained');
  if (ownRestraint) options.push({
    id: `separate-restraint:${ownRestraint.id}`,
    summary: '尝试分离自己身上的绳',
    reason: '身体受到可触及的绳索拘束，无法正常移动',
    goal: { kind: 'condition', personId: person.id, condition: 'restrained', present: false },
    nextAction: { kind: 'act', operation: 'separate', targets: [{ kind: 'person', personId: person.id }] },
    target: { kind: 'person', personId: person.id }, estimatedDuration: 'one-month', sourceFactIds: ownRestraint.sourceEventIds,
  });

  const restrainedOther = localPeople.find((other) => other.conditions.some((condition) => condition.kind === 'restrained'));
  if (restrainedOther) {
    const restraint = restrainedOther.conditions.find((condition) => condition.kind === 'restrained');
    if (restraint) options.push({
      id: `release-restraint:${restrainedOther.id}:${restraint.id}`,
      summary: `从${restrainedOther.name}身上分离绳`,
      reason: `${restrainedOther.name}近身且正受到绳索拘束`,
      goal: { kind: 'condition', personId: restrainedOther.id, condition: 'restrained', present: false },
      nextAction: { kind: 'act', operation: 'separate', targets: [{ kind: 'person', personId: restrainedOther.id }] },
      target: { kind: 'person', personId: restrainedOther.id }, estimatedDuration: 'one-month', sourceFactIds: restraint.sourceEventIds,
    });
  }

  const rope = person.inventory.find((stack) => stack.materialId === Material.Rope && stack.quantity > 0);
  const restraintTarget = localPeople.find((other) => {
    if (other.conditions.some((condition) => condition.kind === 'restrained')) return false;
    const relation = person.relations.find((item) => item.personId === other.id);
    const unableToResist = other.body.health <= 20 || other.conditions.some((condition) => condition.kind === 'wound' && condition.stage === 3);
    return unableToResist && (person.body.nutrition < 18 || (relation?.fear ?? 0) > 45);
  });
  if (rope && restraintTarget) options.push({
    id: `combine-restraint:${rope.id}:${restraintTarget.id}`,
    summary: `尝试让绳与${restraintTarget.name}的身体结合`,
    reason: '对方严重虚弱或重伤，资源压力或恐惧使强制约束成为可选手段',
    goal: { kind: 'condition', personId: restraintTarget.id, condition: 'restrained', present: true },
    nextAction: { kind: 'act', operation: 'combine', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: rope.id }, { kind: 'person', personId: restraintTarget.id }] },
    target: { kind: 'person', personId: restraintTarget.id }, estimatedDuration: 'one-month',
    sourceFactIds: [...rope.sourceEventIds, ...(person.relations.find((item) => item.personId === restraintTarget.id)?.sourceEventIds ?? [])],
  });

  const fearedOpponent = localPeople.find((other) => {
    const relation = person.relations.find((item) => item.personId === other.id);
    return relation && relation.trust < 12 && (relation.fear > 45 || person.body.nutrition < 18);
  });
  if (fearedOpponent) options.push({
    id: `exert-person:${fearedOpponent.id}:${state.clock.elapsedMonths}`,
    summary: `对${fearedOpponent.name}施力`,
    reason: '极低信任与恐惧或资源压力使近身冲突成为可选手段',
    goal: { kind: 'body-at-most', personId: fearedOpponent.id, field: 'health', value: Math.max(0, fearedOpponent.body.health - 4) },
    nextAction: { kind: 'act', operation: 'exert', targets: [{ kind: 'person', personId: fearedOpponent.id }] },
    target: { kind: 'person', personId: fearedOpponent.id },
    estimatedDuration: 'one-month',
    sourceFactIds: person.relations.find((item) => item.personId === fearedOpponent.id)?.sourceEventIds ?? [],
  });

  const teachableFacts = person.knowledge
    .filter((fact) => (fact.kind === 'codebook' || fact.kind === 'technique')
      && fact.confidence >= 55
      && localPeople.some((other) => ageMonths(other, state.clock.elapsedMonths) >= MIN_TEACHING_AGE_MONTHS
        && !other.knowledge.some((known) => known.id === fact.id && known.confidence >= 55)))
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
    .slice(0, 3);
  for (const teachable of teachableFacts) {
    const learnedThreshold = 55;
    const learner = localPeople.find((other) => ageMonths(other, state.clock.elapsedMonths) >= MIN_TEACHING_AGE_MONTHS
      && !other.knowledge.some((known) => known.id === teachable.id && known.confidence >= learnedThreshold));
    if (!learner) continue;
    const representationId = `teach:${state.clock.elapsedMonths}:${person.id}:${teachable.id}:${learner.id}`;
    const communicate = { kind: 'communicate' as const, content: { id: representationId, kind: 'claim' as const, summary: teachable.summary, factId: teachable.id }, audience: [learner.id], channel: 'voice' as const };
    options.push({
      id: representationId,
      summary: teachable.kind === 'codebook'
        ? `教${learner.name}辨认一组记录刻痕`
        : `把“${teachable.summary}”教给${learner.name}`,
      reason: teachable.kind === 'codebook'
        ? '自己可靠掌握这组符号，而身边达到学习年龄的人还不理解'
        : '自己可靠掌握这项技术，而身边达到学习年龄的人还不会；一次明确教导即可传授',
      goal: { kind: 'knowledge', factId: teachable.id, minConfidence: learnedThreshold, personId: learner.id },
      nextAction: communicate,
      target: { kind: 'person', personId: learner.id },
      estimatedDuration: 'one-month',
      sourceFactIds: teachable.sourceEventIds,
    });
  }

  const tentativeTechnique = person.knowledge.find((fact) => fact.kind === 'technique' && fact.confidence < 55 && fact.sourceEventIds.some((sourceId) => {
    const source = worldEventById(state, sourceId);
    if (source?.kind !== 'action'
      || source.action.kind !== 'act'
      || source.action.techniqueDemonstration
      || !['combine', 'exert', 'expose'].includes(source.action.operation)) return false;
    const outputStackId = typeof source.diff.outputStackId === 'string' ? source.diff.outputStackId : undefined;
    if (outputStackId && person.inventory.some((stack) => stack.id === outputStackId && stack.materialId === Number(source.diff.outputMaterialId))) return true;
    const position = source.diff.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
    if (![position?.x, position?.y, position?.z].every((value) => Number.isInteger(value))) return false;
    const cell = Number(position?.x) + Number(position?.y) * state.world.grid.width;
    return visible.has(cell) && voxelAt(state.world.grid, Number(position?.x), Number(position?.y), Number(position?.z)) === Number(source.diff.outputMaterialId);
  }));
  if (tentativeTechnique) {
    const source = tentativeTechnique.sourceEventIds.map((eventId) => worldEventById(state, eventId)).find((event) => event?.kind === 'action'
      && event.action.kind === 'act'
      && !event.action.techniqueDemonstration
      && ['combine', 'exert', 'expose'].includes(event.action.operation));
    const rawPosition = source?.kind === 'action' ? source.diff.position as { x: number; y: number; z: number } | undefined : undefined;
    const outputStackId = source?.kind === 'action' && typeof source.diff.outputStackId === 'string' ? source.diff.outputStackId : undefined;
    const verificationTarget = rawPosition
      ? { kind: 'voxel' as const, position: rawPosition }
      : outputStackId && person.inventory.some((stack) => stack.id === outputStackId)
        ? { kind: 'inventory-stack' as const, personId: person.id, stackId: outputStackId }
        : undefined;
    if (verificationTarget) options.push({
      id: `verify-technique:${tentativeTechnique.id}:${source?.id}`,
      summary: `复查${tentativeTechnique.summary}的结果`,
      reason: '一次成功结合只形成暂定经验，需要再次观察产物才能可靠传授',
      goal: { kind: 'knowledge', factId: tentativeTechnique.id, minConfidence: 55 },
      nextAction: { kind: 'attend', target: verificationTarget },
      target: verificationTarget,
      estimatedDuration: 'one-month',
      sourceFactIds: [...tentativeTechnique.sourceEventIds],
    });
  }

  const unknown = visibleCells.find((cellId) => {
    const material = materialDefinition(surfaceMaterial(state.world.grid, cellId));
    return !person.knowledge.some((fact) => fact.id === `material:${material.id}`);
  });
  if (unknown !== undefined) {
    const position = topPosition(state.world.grid, unknown);
    options.push({
      id: `attend:${unknown}`,
      summary: `持续观察${materialDefinition(surfaceMaterial(state.world.grid, unknown)).name}`,
      reason: '眼前物质尚未形成可靠认识',
      goal: { kind: 'knowledge', factId: `material:${surfaceMaterial(state.world.grid, unknown)}` },
      nextAction: { kind: 'attend', target: { kind: 'voxel', position } },
      estimatedDuration: 'one-month',
      sourceFactIds: [],
    });
  }

  {
    const direction = Math.floor(seededFraction(state.seed, `explore-direction:${state.clock.elapsedMonths}:${person.id}`) * 4);
    const dx = [0, 1, 0, -1][direction];
    const dy = [-1, 0, 1, 0][direction];
    const tx = Math.max(0, Math.min(state.world.grid.width - 1, cellX(person.position.cellId) + dx * 7));
    const ty = Math.max(0, Math.min(state.world.grid.depth - 1, cellY(person.position.cellId) + dy * 7));
    const target = nearestCell(person.position.cellId, cellsInRadius(tx + ty * state.world.grid.width, 3).filter((id) => isPassable(state.world.grid, id)));
    if (target !== null && target !== person.position.cellId) options.push({
      id: `explore:${target}`,
      summary: '走向尚未熟悉的地表',
      reason: '探索可能发现新的物质与路径',
      goal: { kind: 'at-cell', cellId: target },
      nextAction: { kind: 'move', toCellId: target },
      estimatedDuration: 'several-months',
      sourceFactIds: [],
    });
  }
  options.push(...buildSocialOptions(state, person, visiblePeople));
  return [...new Map(options.map((option) => [option.id, option])).values()]
    .flatMap((option) => {
      const planned = withPlanning(state, person, option);
      return planned ? [planned] : [];
    });
}

export function buildDecisionContext(state: SimulationState, person: PersonState): DecisionContext {
  const visibleCells = visibleCellsFor(person);
  const visibleSet = new Set(visibleCells);
  const visibleDrops = state.world.drops.filter((drop) => drop.quantity > 0 && visibleSet.has(drop.cellId));
  const visiblePeople = state.people.filter((other) => other.id !== person.id && isAlive(other) && visibleSet.has(other.position.cellId));
  const visibleAnimals = state.world.animals.filter((animal) => isAnimalAlive(animal) && visibleSet.has(animal.position.cellId));
  const allOptions = buildOptions(state, person, visibleCells, visibleDrops, visiblePeople, visibleAnimals)
    .filter((option) => !option.id.startsWith('eat:') && !option.id.startsWith('drink:'))
    .filter((option) => !recentlyRepeatedSocialOption(state, person, option))
    .sort((a, b) => decisionOptionPriority(a) - decisionOptionPriority(b) || a.id.localeCompare(b.id));
  const followUpOptions = allOptions.filter((option) => option.nextAction.kind !== 'communicate');
  const options = allOptions
    .map((option) => option.nextAction.kind === 'communicate'
      && option.nextAction.channel !== 'record'
      && option.nextAction.content.kind !== 'accept'
      && option.nextAction.content.kind !== 'reject'
      && !(option.nextAction.content.kind === 'claim'
        && option.nextAction.content.conversation?.turn === 'response')
      && !(option.nextAction.content.kind === 'request'
        && option.nextAction.content.techniqueDemonstration)
      ? { ...option, requiresFollowUp: true }
      : option)
    .filter((option) => !option.requiresFollowUp || followUpOptions.length > 0);
  const requiredSocialResponses = options.filter((option) => REQUIRED_SOCIAL_RESPONSE.test(option.id));
  return {
    state,
    person,
    visibleCells,
    visiblePeople,
    visibleDrops,
    visibleAnimals,
    options: requiredSocialResponses.length ? requiredSocialResponses : options,
    followUpOptions,
    activeIntent: person.activeIntentId ? state.intents.find((intent) => intent.id === person.activeIntentId && intent.status === 'active') : undefined,
  };
}

export function recompileNextAction(state: SimulationState, person: PersonState, intent: Intent): PrimitiveAction | null {
  if (intent.recordUseBasis) return recompileRecordUseNextAction(state, person, intent);
  if ((intent.nextAction.kind === 'communicate'
      && intent.nextAction.content.kind === 'request'
      && intent.nextAction.content.techniqueDemonstration)
    || (intent.nextAction.kind === 'act'
      && (intent.nextAction.techniqueDemonstration || intent.nextAction.techniqueImitation))) return null;
  if (intent.projectId) return recompileProjectNextAction(state, person, intent.projectId);
  const agreementContinuation = intent.agreementId
    ? compileAgreementContinuations(state, intent.agreementId).find((continuation) => continuation.personId === person.id)
    : undefined;
  if (agreementContinuation) return agreementContinuation.nextAction;
  if (intent.nextAction.kind === 'transfer' && intent.nextAction.authorizationRef) {
    const mandate = mandateById(state, intent.nextAction.authorizationRef);
    const mandateAction = intent.nextAction;
    if (mandate?.status === 'active'
      && state.clock.elapsedMonths <= mandate.validUntilMonth
      && mandateAction.from.kind === 'person'
      && mandateAction.from.personId === person.id
      && mandateAction.to.kind === 'person') {
      const receiverId = mandateAction.to.personId;
      const receiver = state.people.find((candidate) => candidate.id === receiverId && isAlive(candidate));
      const stack = person.inventory.find((candidate) => candidate.materialId === mandateAction.materialId && candidate.quantity > 0);
      if (!receiver || !stack) return null;
      return sameLocation(receiver, person)
        ? { ...mandateAction, stackId: stack.id }
        : { kind: 'move', toCellId: receiver.position.cellId, toZ: receiver.position.z };
    }
    const permission = permissionById(state, intent.nextAction.authorizationRef);
    if (permission?.status === 'active' && permission.granteeId === person.id && state.clock.elapsedMonths <= permission.validUntilMonth) {
      const grantor = state.people.find((candidate) => candidate.id === permission.grantorId && isAlive(candidate));
      const stack = grantor?.inventory.find((candidate) => candidate.materialId === permission.materialId && candidate.quantity > 0);
      if (!grantor || !stack) return null;
      return sameLocation(grantor, person)
        ? { kind: 'transfer', materialId: permission.materialId, quantity: 1, from: { kind: 'person', personId: grantor.id }, to: { kind: 'person', personId: person.id }, stackId: stack.id, authorizationRef: permission.id }
        : { kind: 'move', toCellId: grantor.position.cellId, toZ: grantor.position.z };
    }
  }
  if (intent.completionAction && intent.target?.kind === 'person') {
    const targetPersonId = intent.target.personId;
    const target = state.people.find((candidate) => candidate.id === targetPersonId);
    if (!target || !isAlive(target)) return null;
    return sameLocation(target, person) ? intent.completionAction : { kind: 'move', toCellId: target.position.cellId, toZ: target.position.z };
  }
  if (intent.goal.kind === 'near-person') {
    const targetPersonId = intent.goal.personId;
    const target = state.people.find((candidate) => candidate.id === targetPersonId && isAlive(candidate));
    if (!target) return null;
    return sameLocation(target, person) ? null : { kind: 'move', toCellId: target.position.cellId, toZ: target.position.z };
  }
  if (intent.goal.kind === 'inventory-at-least' && intent.goal.personId && intent.target?.kind === 'person') {
    const goal = intent.goal;
    const receiverId = intent.target.personId;
    const receiver = state.people.find((candidate) => candidate.id === receiverId);
    const exchange = acceptedExchangeFor(state, person.id, state.clock.elapsedMonths);
    const stack = person.inventory.find((candidate) => candidate.materialId === goal.materialId && candidate.quantity > 0);
    const offerId = exchange?.offer.action.kind === 'communicate' ? exchange.offer.action.content.id : undefined;
    if (receiver && exchange && offerId && intent.sourceFactIds?.includes(exchange.offer.id) && stack) {
      if (!sameLocation(receiver, person)) return { kind: 'move', toCellId: receiver.position.cellId, toZ: receiver.position.z };
      return {
        kind: 'transfer', materialId: intent.goal.materialId, quantity: 1,
        from: { kind: 'person', personId: person.id }, to: { kind: 'person', personId: receiver.id },
        stackId: stack.id,
        authorizationRef: offerId,
      };
    }
  }
  if (intent.goal.kind === 'container-inventory-at-least' && intent.target?.kind === 'container') {
    const goal = intent.goal;
    const container = containerById(state, intent.target.containerId);
    const stack = person.inventory.find((candidate) => candidate.materialId === goal.materialId && candidate.quantity > 0);
    if (!container || !stack) return null;
    if (!canAccessContainer(person, container)) {
      const access = findContainerAccess(state, person, container);
      return access ? { kind: 'move', toCellId: access.position.cellId, toZ: access.position.z } : null;
    }
    return {
      kind: 'transfer', materialId: goal.materialId,
      quantity: Math.min(stack.quantity, Math.max(1, goal.quantity - containerQuantity(container, goal.materialId))),
      from: { kind: 'person', personId: person.id }, to: { kind: 'container', containerId: container.id }, stackId: stack.id,
    };
  }
  if (intent.goal.kind === 'inventory-at-least') {
    const materialId = intent.goal.materialId;
    if (intent.target?.kind === 'animal') {
      const animalId = intent.target.animalId;
      const animal = state.world.animals.find((candidate) => candidate.id === animalId && isAnimalAlive(candidate));
      if (animal) {
        const tool = bestProductionTool(person);
        return person.position.cellId === animal.position.cellId && person.position.z === animal.position.z
          ? { kind: 'act', operation: 'hunt', targets: [{ kind: 'animal', animalId }], ...(tool ? { toolStackId: tool.id } : {}) }
          : { kind: 'move', toCellId: animal.position.cellId, toZ: animal.position.z };
      }
    }
    if (intent.target?.kind === 'container') {
      const container = containerById(state, intent.target.containerId);
      const stack = container?.inventory.find((candidate) => candidate.materialId === materialId && candidate.quantity > 0);
      if (!container || !stack) return null;
      if (!canAccessContainer(person, container)) {
        const access = findContainerAccess(state, person, container);
        return access ? { kind: 'move', toCellId: access.position.cellId, toZ: access.position.z } : null;
      }
      return {
        kind: 'transfer', materialId, quantity: Math.min(stack.quantity, Math.max(1, intent.goal.quantity - inventoryQuantity(person, materialId))),
        from: { kind: 'container', containerId: container.id }, to: { kind: 'person', personId: person.id }, stackId: stack.id,
      };
    }
    if (intent.target?.kind === 'voxel') {
      const targetCell = intent.target.position.x + intent.target.position.y * state.world.grid.width;
      const targetMaterial = voxelAt(state.world.grid, intent.target.position.x, intent.target.position.y, intent.target.position.z);
      const separationRule = voxelSeparationRuleFor(targetMaterial);
      const targetStillMatches = (materialId === Material.Food && targetMaterial === Material.CropMature)
        || (materialId === Material.Wood && (targetMaterial === Material.Wood || targetMaterial === Material.Leaves))
        || Boolean(separationRule?.outputs.some((output) => output.materialId === materialId));
      if (targetStillMatches) {
        if (distance(person.position.cellId, targetCell) <= 1) {
          const requiredTool = separationRule?.requiredToolMaterialId === undefined
            ? undefined
            : person.inventory
              .filter((stack) => stack.quantity > 0 && separationToolFits(separationRule, stack.materialId))
              .sort((left, right) => productionToolRank(right.materialId) - productionToolRank(left.materialId))[0];
          if (separationRule?.requiredToolMaterialId !== undefined && !requiredTool) return null;
          return {
            kind: 'act', operation: 'separate', targets: [intent.target],
            ...(materialId === Material.Wood
              ? { toolStackId: bestProductionTool(person)?.id }
              : requiredTool ? { toolStackId: requiredTool.id } : {}),
          };
        }
        const destination = intent.nextAction.kind === 'move' ? intent.nextAction.toCellId : targetCell;
        return { kind: 'move', toCellId: destination };
      }
    }
    const local = state.world.drops.find((drop) => drop.cellId === person.position.cellId && drop.z === person.position.z && drop.materialId === materialId && drop.quantity > 0);
    if (local) return actionForDrop(person, local);
    const visible = new Set(visibleCellsFor(person));
    const reachable = state.world.drops
      .filter((drop) => visible.has(drop.cellId) && drop.materialId === materialId && drop.quantity > 0)
      .map((drop) => ({ drop, path: findStandingPath(state.world.grid, person.position, { cellId: drop.cellId, z: drop.z }) }))
      .filter(({ path }) => path.length > 0)
      .sort((a, b) => a.path.length - b.path.length || a.drop.id.localeCompare(b.drop.id))[0];
    if (reachable) return actionForDrop(person, reachable.drop);
    if (intent.nextAction.kind === 'move') {
      const toCellId = intent.nextAction.toCellId;
      const atTarget = state.world.drops.find((drop) => drop.cellId === toCellId && drop.materialId === materialId && drop.quantity > 0);
      if (atTarget) return actionForDrop(person, atTarget);
      if (intent.target?.kind === 'voxel') {
        const targetCell = intent.target.position.x + intent.target.position.y * state.world.grid.width;
        if (distance(person.position.cellId, targetCell) <= 1) {
          return { kind: 'act', operation: 'separate', targets: [intent.target] };
        }
      }
    }
  }
  if (intent.goal.kind === 'body-at-least' && intent.goal.field === 'hydration') {
    const water = findReachableWater(state, person, visibleCellsFor(person));
    if (!water) return null;
    return person.position.cellId === water.bankPosition.cellId && person.position.z === water.bankPosition.z
      ? { kind: 'act', operation: 'ingest', targets: [{ kind: 'voxel', position: water.waterPosition }] }
      : { kind: 'move', toCellId: water.bankPosition.cellId, toZ: water.bankPosition.z };
  }
  if (intent.goal.kind === 'voxel-is' && intent.nextAction.kind === 'move') {
    const targetCell = intent.goal.position.x + intent.goal.position.y * state.world.grid.width;
    if (intent.goal.materialId === Material.CropSprout && distance(person.position.cellId, targetCell) <= 1) {
      const seed = person.inventory.find((stack) => stack.materialId === Material.Seed && stack.quantity > 0);
      if (seed) return { kind: 'act', operation: 'combine', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: seed.id }, { kind: 'voxel', position: intent.goal.position }] };
    }
  }
  return intent.nextAction.kind === 'move'
    && person.position.cellId === intent.nextAction.toCellId
    && (intent.nextAction.toZ === undefined || person.position.z === intent.nextAction.toZ)
    ? null
    : intent.nextAction;
}
