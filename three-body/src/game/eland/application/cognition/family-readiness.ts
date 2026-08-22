import type { DecisionContext } from '../../domain/model';
import { reproductiveResponsibility } from '../../domain/dependent-care';
import { personTrustsEraPrediction, isActionableChaosPrediction } from '../../domain/era-prediction';
import { materialHas } from '../../domain/material';
import { findReachableShelter } from '../../domain/shelter-access';
import { findCurrentVisibleStoredMaterialAccess } from '../../domain/stored-food-access';
import { shelterGeometryAt } from '../../domain/structure';
import { findReachableWater } from '../../domain/water-access';
import { findStandingPath } from '../../world/grid';

export interface FamilyReadinessAssessment {
  readiness: number;
  food: number;
  water: number;
  shelter: number;
  careCapacity: number;
  climateSafety: number;
  basisKeys: string[];
  reasons: string[];
  sourceFactIds: string[];
}

const RECENT_RESOLUTION_MONTHS = 12;
const FAMILY_RELEVANT_FUNCTIONS = new Set([
  'settled-cultivation',
  'reserve-storage',
  'reliable-water',
  'weather-shelter',
  'crop-processing',
]);

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function functionLabel(desiredFunction: string): string {
  if (desiredFunction === 'settled-cultivation') return '定居耕作';
  if (desiredFunction === 'reserve-storage') return '储备存放';
  if (desiredFunction === 'reliable-water') return '可靠水源';
  if (desiredFunction === 'weather-shelter') return '遮蔽住所';
  if (desiredFunction === 'crop-processing') return '作物加工';
  return desiredFunction;
}

/**
 * Derives family readiness exclusively from this person's body, responsibilities,
 * inventory, visible/reachable resources, trusted forecasts, and sourced personal
 * completion episodes. Completion memories explain confidence but never create stock.
 */
export function assessFamilyReadiness(
  context: DecisionContext,
  atMonth: number,
): FamilyReadinessAssessment {
  const { state, person } = context;
  const basisKeys: string[] = [];
  const reasons: string[] = [];
  const sourceFactIds: string[] = [];
  const responsibility = reproductiveResponsibility(state, person, atMonth);
  const foodTarget = 4 + responsibility.dependentCount * 2;

  const carriedFood = person.inventory
    .filter((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'edible'))
    .sort((left, right) => left.id.localeCompare(right.id));
  const reachableDrops = context.visibleDrops
    .filter((drop) => drop.quantity > 0 && materialHas(drop.materialId, 'edible'))
    .map((drop) => ({
      drop,
      path: findStandingPath(state.world.grid, person.position, { cellId: drop.cellId, z: drop.z }),
    }))
    .filter(({ path }) => path.length > 0)
    .sort((left, right) => left.path.length - right.path.length || left.drop.id.localeCompare(right.drop.id));
  const storedFood = findCurrentVisibleStoredMaterialAccess(
    state,
    person,
    (stack) => stack.quantity > 0 && materialHas(stack.materialId, 'edible'),
  );
  const foodUnits = carriedFood.reduce((sum, stack) => sum + stack.quantity, 0)
    + reachableDrops.reduce((sum, { drop }) => sum + drop.quantity, 0)
    + (storedFood?.stack.quantity ?? 0);
  const food = clamp(foodUnits / foodTarget);

  basisKeys.push(`family-readiness:food-target:${foodTarget}`);
  for (const stack of carriedFood) {
    basisKeys.push(`family-readiness:carried-food:${stack.id}:${stack.quantity}`);
    sourceFactIds.push(...stack.sourceEventIds);
  }
  for (const { drop, path } of reachableDrops) {
    basisKeys.push(`family-readiness:reachable-food-drop:${drop.id}:${drop.quantity}:path-${path.length}`);
    sourceFactIds.push(...drop.sourceEventIds);
  }
  if (storedFood) {
    basisKeys.push(`family-readiness:visible-food-store:${storedFood.container.id}:${storedFood.stack.id}:${storedFood.stack.quantity}`);
    sourceFactIds.push(...storedFood.container.sourceEventIds, ...storedFood.stack.sourceEventIds);
  }
  reasons.push(food >= 1
    ? `本人可用食物${foodUnits}份，已达到当前${foodTarget}份储备目标`
    : `本人可用食物${foodUnits}份，低于当前${foodTarget}份储备目标`);

  const carriedWater = person.inventory
    .filter((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'drinkable'))
    .sort((left, right) => left.id.localeCompare(right.id));
  const reachableWater = carriedWater.length > 0
    ? null
    : findReachableWater(state, person, context.visibleCells);
  const water = carriedWater.length > 0 || reachableWater ? 1 : 0;
  for (const stack of carriedWater) {
    basisKeys.push(`family-readiness:carried-water:${stack.id}:${stack.quantity}`);
    sourceFactIds.push(...stack.sourceEventIds);
  }
  if (reachableWater) {
    basisKeys.push(`family-readiness:reachable-water:${reachableWater.waterPosition.x}:${reachableWater.waterPosition.y}:${reachableWater.waterPosition.z}`);
    sourceFactIds.push(...reachableWater.sourceEventIds);
  }
  reasons.push(carriedWater.length > 0
    ? '本人随身有可饮用物资'
    : reachableWater
      ? `本人${reachableWater.remembered ? '记得并' : '看见且'}能到达真实水源`
      : '本人当前未确认可达的水源或随身饮水');

  const currentShelter = shelterGeometryAt(state.world.grid, person.position);
  const reachableShelter = currentShelter
    ? null
    : findReachableShelter(state, person, context.visibleCells);
  const currentlyConfirmedReachableShelter = reachableShelter && !reachableShelter.remembered
    ? reachableShelter
    : null;
  const shelterStructure = currentShelter
    ? state.derived.structures.find((structure) => structure.complete
      && structure.interiorPositions.some((position) => position.cellId === person.position.cellId
        && position.z === person.position.z))
    : currentlyConfirmedReachableShelter
      ? state.derived.structures.find((structure) => structure.id === currentlyConfirmedReachableShelter.structureId && structure.complete)
      : undefined;
  const visibleCells = new Set([...context.visibleCells, person.position.cellId]);
  const validShelterSlots = shelterStructure?.interiorPositions.flatMap((position) => {
    if (!visibleCells.has(position.cellId)) return [];
    const geometry = shelterGeometryAt(state.world.grid, position);
    return geometry ? [{ position, geometry }] : [];
  }) ?? [];
  const shelterSlotKeys = new Set(validShelterSlots.map(({ position }) => `${position.cellId}:${position.z}`));
  const visibleOccupants = [person, ...context.visiblePeople]
    .filter((candidate, index, people) => people.findIndex((other) => other.id === candidate.id) === index)
    .filter((candidate) => candidate.diedAtMonth === undefined || candidate.diedAtMonth > atMonth);
  const occupiedShelterSlots = new Set(visibleOccupants
    .map((candidate) => `${candidate.position.cellId}:${candidate.position.z}`)
    .filter((key) => shelterSlotKeys.has(key)));
  const freeShelterGeometries = validShelterSlots.filter(({ position }) => (
    !occupiedShelterSlots.has(`${position.cellId}:${position.z}`)
  ));
  const freeShelterSlots = freeShelterGeometries.length;
  const shelter = freeShelterGeometries.reduce((maximum, { geometry }) => {
    const weather = clamp((geometry.weatherProtection - 50) / 40);
    const thermal = clamp((geometry.thermalInsulation - 10) / 65);
    return Math.max(maximum, Math.sqrt(weather * thermal));
  }, 0);
  if (currentShelter && shelterStructure) {
    basisKeys.push(`family-readiness:current-shelter:${shelterStructure.id}:${person.position.cellId}:${person.position.z}`);
    sourceFactIds.push(...shelterStructure.sourceEventIds);
  } else if (currentlyConfirmedReachableShelter && shelterStructure) {
    basisKeys.push(`family-readiness:reachable-shelter:${currentlyConfirmedReachableShelter.structureId}`);
    sourceFactIds.push(...currentlyConfirmedReachableShelter.sourceEventIds, ...shelterStructure.sourceEventIds);
  } else {
    basisKeys.push('family-readiness:no-confirmed-shelter');
    if (reachableShelter?.remembered) {
      basisKeys.push(`family-readiness:remembered-shelter-unverified:${reachableShelter.structureId}`);
      sourceFactIds.push(...reachableShelter.sourceEventIds);
      reasons.push('本人记得一处住所，但当前看不见其空余位置，不能据此确认新增家庭容量');
    }
  }
  basisKeys.push(`family-readiness:free-shelter-slots:${freeShelterSlots}`);
  basisKeys.push(`family-readiness:shelter-quality:${Math.round(shelter * 100)}`);
  reasons.push(currentShelter || currentlyConfirmedReachableShelter
    ? freeShelterSlots >= 1
      ? `本人确认真实遮蔽结构仍有${freeShelterSlots}个可见空余位置，最好一处的冷热防护质量为${Math.round(shelter * 100)}%`
      : '本人虽能确认真实遮蔽结构，但没有看见可供新增家庭成员使用的空余位置'
    : '本人当前未确认可达的遮蔽结构');

  const careCapacity = clamp(1 - responsibility.pressure / 100, 0.15, 1);
  basisKeys.push(...responsibility.basisKeys);
  sourceFactIds.push(...responsibility.sourceFactIds);
  reasons.push(...responsibility.reasons);
  reasons.push(`按已有照护责任估算，当前照护余量为${Math.round(careCapacity * 100)}%`);

  const temperatureConditions = person.conditions
    .filter((condition) => condition.kind === 'cold' || condition.kind === 'heat')
    .sort((left, right) => right.stage - left.stage || left.id.localeCompare(right.id));
  const maximumTemperatureStage = temperatureConditions[0]?.stage ?? 0;
  const conditionRisk = maximumTemperatureStage / 3;
  for (const condition of temperatureConditions.filter((candidate) => candidate.stage === maximumTemperatureStage)) {
    basisKeys.push(`family-readiness:${condition.kind}-condition:${condition.id}:stage-${condition.stage}`);
    sourceFactIds.push(...condition.sourceEventIds);
  }
  if (maximumTemperatureStage > 0) {
    reasons.push(`本人当前最高冷热损伤为${maximumTemperatureStage}阶`);
  }

  const trustedChaosPredictions = state.eraPredictions
    .filter((prediction) => isActionableChaosPrediction(prediction, atMonth)
      && personTrustsEraPrediction(state, person, prediction))
    .sort((left, right) => left.predictedStartMonth - right.predictedStartMonth || left.id.localeCompare(right.id));
  for (const prediction of trustedChaosPredictions) {
    basisKeys.push(`family-readiness:trusted-chaos-prediction:${prediction.id}`);
    sourceFactIds.push(...prediction.sourceEventIds);
  }
  if (trustedChaosPredictions.length > 0) reasons.push('本人信任的近期预言指向乱纪元');
  const climateRisk = Math.max(conditionRisk, trustedChaosPredictions.length > 0 ? 0.65 : 0);
  const climateSafety = 1 - climateRisk * 0.5;

  const recentResolutions = (person.cognition?.needResolutionEpisodes ?? [])
    .filter((episode) => FAMILY_RELEVANT_FUNCTIONS.has(episode.desiredFunction)
      && episode.observedAtMonth <= atMonth
      && atMonth - episode.observedAtMonth <= RECENT_RESOLUTION_MONTHS)
    .sort((left, right) => right.observedAtMonth - left.observedAtMonth || left.id.localeCompare(right.id));
  for (const episode of recentResolutions) {
    basisKeys.push(episode.basisKey, `family-readiness:recent-resolution:${episode.projectId}`);
    sourceFactIds.push(...episode.sourceFactIds);
    reasons.push(`本人近期亲历${functionLabel(episode.desiredFunction)}项目产生功能结果`);
  }

  // Shelter is counted twice because a new dependent cannot safely rely on
  // food and water alone during the era's thermal extremes. Tiny floors keep
  // this a soft preference instead of deleting a legal choice.
  const resourceReadiness = Math.pow(
    Math.max(0.05, food)
      * Math.max(0.05, water)
      * Math.pow(Math.max(0.02, shelter), 2),
    1 / 4,
  );
  const readiness = clamp(resourceReadiness * careCapacity * climateSafety);

  return {
    readiness,
    food,
    water,
    shelter,
    careCapacity,
    climateSafety,
    basisKeys: sortedUnique(basisKeys),
    reasons: sortedUnique(reasons),
    sourceFactIds: sortedUnique(sourceFactIds),
  };
}
