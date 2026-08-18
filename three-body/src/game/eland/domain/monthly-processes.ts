import { createBiologicalSex, createLifespanMonths, deterministicFraction } from '../population';
import { Material, materialHas } from './material';
import type { ActionFact, EnvironmentFact, EraSchedule, SimulationState, WeatherKind, WorldEvent } from './model';
import type { ConditionInstance, PersonState } from './person';
import { ageMonths, isAlive, sameLocation } from './person';
import { createMotiveSensitivity, createPersonality } from './personality';
import { inventoryQuantity } from './person';
import { addDrop } from './action-executor';
import { WORLD_CELL_COUNT, cellX, cellY, cellsInRadius, neighbors4, setVoxel, surfaceMaterial, surfaceStandingPosition, topZ, voxelAt } from '../world/grid';
import { seededFraction } from '../world/generator';
import { shelterGeometryAt, shelterHeatRelief } from './structure';
import { geneticKinshipRisk, inheritedGeneticLoad, KINSHIP_RISK_KNOWLEDGE_ID } from './kinship';
import { remember } from './memory';
import { applyRelationEvidence, relationshipPairKey } from './relation';
import { createNewbornName } from '../naming';
import {
  animalAgeMonths,
  animalSpecies,
  isAnimalAlive,
  type AnimalState,
} from './animal';
import { humanResourceCompetitionMultiplier } from './population-capacity';

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

const HIBERNATION_HYDRATION_COST = 0.35;
const HIBERNATION_NUTRITION_COST = 0.3;
const HIBERNATION_HEALTH_COST = 0.25;

function event(state: SimulationState, atMonth: number, events: EnvironmentFact[], change: EnvironmentFact['change'], result: string, diff: Record<string, unknown>, person?: PersonState): EnvironmentFact {
  void state;
  const fact: EnvironmentFact = {
    id: `e-${atMonth}-environment-${change}-${events.length}`,
    kind: 'environment', atMonth, orderInMonth: events.length,
    cellId: person?.position.cellId ?? 0,
    change, ...(person ? { who: person.id } : {}), result, diff,
  };
  events.push(fact);
  return fact;
}

function eraDuration(seed: number, sequence: number, kind: EraSchedule['kind'], chaosIntensity: number): number {
  const chaos = Math.max(0, Math.min(10, chaosIntensity));
  const sample = seededFraction(seed, `era-duration:${sequence}:${kind}`);
  if (kind === 'stable') {
    const maximum = Math.max(18, 48 - chaos * 2);
    return 6 + Math.floor(sample * (maximum - 5));
  }
  const maximum = Math.min(42, 24 + chaos * 2);
  return 3 + Math.floor(sample * (maximum - 2));
}

function chaoticClimate(seed: number, sequence: number, bias: SimulationState['civilization']['conditions']['climateBias']): EraSchedule['dominantClimate'] {
  const sample = seededFraction(seed, `era-climate:${sequence}`);
  const coldBias = bias === 'cold' ? 0.18 : 0;
  const heatBias = bias === 'hot' ? 0.18 : 0;
  if (sample < 0.42 + coldBias) return 'cold';
  if (sample > 0.88 - heatBias) return 'fire';
  return 'heat';
}

export function initialEraSchedule(seed: number, chaosIntensity: number): EraSchedule {
  const duration = eraDuration(seed, 0, 'stable', chaosIntensity);
  return { sequence: 0, kind: 'stable', sinceMonth: 0, endsAtMonth: duration, dominantClimate: 'temperate' };
}

function nextEra(state: SimulationState, atMonth: number): EraSchedule {
  const sequence = state.civilization.era.sequence + 1;
  const kind = state.civilization.era.kind === 'stable' ? 'chaotic' : 'stable';
  const duration = eraDuration(state.seed, sequence, kind, state.civilization.conditions.chaosIntensity);
  return {
    sequence,
    kind,
    sinceMonth: atMonth,
    endsAtMonth: atMonth + duration - 1,
    dominantClimate: kind === 'stable'
      ? 'temperate'
      : chaoticClimate(state.seed, sequence, state.civilization.conditions.climateBias),
  };
}

export function resolveClimate(state: SimulationState, atMonth: number): EnvironmentFact[] {
  const events: EnvironmentFact[] = [];
  const external = state.civilization.externalClimate;
  let eraTransition = false;
  if (!external && atMonth > state.civilization.era.endsAtMonth) {
    state.civilization.era = nextEra(state, atMonth);
    eraTransition = true;
  }
  const scheduled = state.civilization.era;
  const epoch = external?.epoch ?? scheduled.kind;
  let kind = external?.kind ?? scheduled.dominantClimate;
  if (!external && epoch === 'chaotic') {
    const shift = seededFraction(state.seed, `era-climate-shift:${scheduled.sequence}:${Math.floor((atMonth - scheduled.sinceMonth) / 3)}`);
    if (shift > 0.82) kind = kind === 'cold' ? 'heat' : kind === 'heat' ? 'cold' : 'heat';
  }
  const chaos = state.civilization.conditions.chaosIntensity / 10;
  const severity = external?.severity
    ?? (epoch === 'stable' ? 1 : Math.min(10, 3 + Math.floor(seededFraction(state.seed, `climate-severity:${scheduled.sequence}:${atMonth}`) * (5 + chaos * 3))));
  const changed = state.civilization.climate.kind !== kind || state.civilization.climate.severity !== severity || state.civilization.epoch !== epoch;
  state.civilization.epoch = epoch;
  state.civilization.climate = { kind, severity, sinceMonth: changed ? atMonth : state.civilization.climate.sinceMonth };
  if (changed || atMonth === 1 || eraTransition) event(
    state,
    atMonth,
    events,
    'climate',
    `${eraTransition ? `${epoch === 'stable' ? '恒纪元' : '乱纪元'}开始；` : ''}本月地表处于${kind === 'temperate' ? '温和' : kind === 'cold' ? '寒冷' : kind === 'heat' ? '炎热' : '烈火'}环境`,
    {
      epoch, kind, severity, eraSequence: scheduled.sequence,
      eraSinceMonth: scheduled.sinceMonth,
      ...(eraTransition ? { eraTransition: true } : {}),
    },
  );
  return events;
}

export function resolveWeather(state: SimulationState, atMonth: number): EnvironmentFact[] {
  const events: EnvironmentFact[] = [];
  const climate = state.civilization.climate;
  const sample = seededFraction(state.seed, `weather:${state.civilization.era.sequence}:${atMonth}`);
  let kind: WeatherKind = 'clear';
  if (climate.kind === 'cold') kind = sample < 0.48 ? 'snow' : sample < 0.62 ? 'storm' : sample < 0.76 ? 'fog' : 'clear';
  else if (climate.kind === 'heat' || climate.kind === 'fire') kind = sample < 0.46 ? 'drought' : sample < 0.58 ? 'storm' : 'clear';
  else kind = sample < 0.27 ? 'rain' : sample < 0.34 ? 'storm' : sample < 0.46 ? 'fog' : sample < 0.51 ? 'drought' : 'clear';
  const intensity = kind === 'clear' ? 1 : 1 + Math.floor(seededFraction(state.seed, `weather-intensity:${atMonth}`) * (state.civilization.epoch === 'chaotic' ? 5 : 3));
  const changed = state.civilization.weather.kind !== kind || state.civilization.weather.intensity !== intensity;
  state.civilization.weather = { kind, intensity, sinceMonth: changed ? atMonth : state.civilization.weather.sinceMonth };
  if (changed || atMonth === 1) {
    const label: Record<WeatherKind, string> = { clear: '晴朗', rain: '降雨', storm: '风暴', drought: '干旱', snow: '降雪', fog: '浓雾' };
    event(state, atMonth, events, 'weather', `本月天气转为${label[kind]}`, { kind, intensity });
  }
  return events;
}

export function advanceEraPredictions(state: SimulationState, atMonth: number, eraTransition: boolean): EnvironmentFact[] {
  const events: EnvironmentFact[] = [];
  for (const prediction of state.eraPredictions.filter((candidate) => candidate.status === 'pending')) {
    let correct: boolean | null = null;
    let errorMonths: number | undefined;
    if (eraTransition) {
      errorMonths = Math.abs(prediction.predictedStartMonth - atMonth);
      correct = prediction.targetEpoch === state.civilization.epoch && errorMonths <= prediction.toleranceMonths;
    } else if (atMonth > prediction.expiresAtMonth) {
      errorMonths = Math.abs(prediction.predictedStartMonth - atMonth);
      correct = false;
    }
    if (correct === null) continue;
    prediction.status = correct ? 'correct' : 'incorrect';
    prediction.resolvedAtMonth = atMonth;
    prediction.errorMonths = errorMonths;
    const predictor = state.people.find((person) => person.id === prediction.predictorId);
    const fact = event(
      state,
      atMonth,
      events,
      'prediction',
      `${predictor?.name ?? '某人'}对${prediction.targetEpoch === 'chaotic' ? '乱纪元' : '恒纪元'}的预言${correct ? '命中' : '失误'}`,
      { predictionId: prediction.id, correct, errorMonths, predictorId: prediction.predictorId },
      predictor,
    );
    prediction.sourceEventIds.push(fact.id);
    if (predictor) {
      const known = predictor.knowledge.find((knowledge) => knowledge.id === 'technique:era-forecast');
      if (known) {
        known.confidence = clamp(known.confidence + (correct ? 14 : -6));
        known.sourceEventIds = [...new Set([...known.sourceEventIds, fact.id])].slice(-24);
      }
    }
    for (const listener of state.people.filter((person) => prediction.audienceIds.includes(person.id))) {
      applyRelationEvidence(listener, prediction.predictorId, fact.id, { trust: correct ? 11 : -6, bond: correct ? 2 : 0 });
      remember(listener, {
        id: `memory:era-prediction:${prediction.id}:${listener.id}`,
        kind: correct ? 'episode' : 'failure',
        summary: `${predictor?.name ?? '某人'}对纪元变化的预言${correct ? '应验了' : '没有在预言时间窗内应验'}`,
        importance: correct ? 82 : 68,
        createdAtMonth: atMonth,
        lastRecalledAtMonth: atMonth,
        personIds: [prediction.predictorId],
        sourceEventIds: [fact.id],
      });
    }
    const disputedWakes = state.world.past.filter((candidate): candidate is ActionFact => (
      candidate.kind === 'action'
        && candidate.status === 'completed'
        && candidate.action.kind === 'act'
        && candidate.action.operation === 'rehydrate'
        && candidate.diff.rehydrationBasis === 'disputed-pending-prediction'
        && candidate.diff.hibernationPredictionId === prediction.id
        && typeof candidate.diff.rehydratedPersonId === 'string'
    ));
    const chaosArrived = eraTransition
      && prediction.targetEpoch === 'chaotic'
      && state.civilization.epoch === 'chaotic';
    for (const wake of disputedWakes) {
      const sleeper = state.people.find((person) => person.id === wake.diff.rehydratedPersonId);
      const helper = state.people.find((person) => person.id === wake.who);
      if (!sleeper || !helper || sleeper.id === helper.id) continue;
      applyRelationEvidence(sleeper, helper.id, fact.id, chaosArrived
        ? { trust: -8, bond: -2 }
        : { trust: 5, bond: 2 });
      applyRelationEvidence(helper, sleeper.id, fact.id, chaosArrived
        ? { trust: 2, bond: -1 }
        : { trust: 1, bond: 1 });
      remember(sleeper, {
        id: `memory:hibernation-wake-outcome:${prediction.id}:${wake.id}:${sleeper.id}`,
        kind: chaosArrived ? 'failure' : 'episode',
        summary: chaosArrived
          ? `${helper.name}提前唤醒自己后乱纪元仍然到来，这次干预打断了合理的休眠计划`
          : `${helper.name}提前唤醒自己后预言窗口平稳过去，这次有争议的判断最终避免了无效休眠`,
        importance: chaosArrived ? 90 : 76,
        createdAtMonth: atMonth,
        lastRecalledAtMonth: atMonth,
        personIds: [helper.id, prediction.predictorId],
        sourceEventIds: [wake.id, fact.id],
      });
    }
    if (disputedWakes.length) fact.diff.disputedWakeOutcomes = disputedWakes.length;
  }
  return events;
}

export function advanceWorldProcesses(state: SimulationState, atMonth: number): EnvironmentFact[] {
  const events: EnvironmentFact[] = [];
  const changes: Array<{ cellId: number; from: number; to: number; process: string }> = [];
  const climate = state.civilization.climate;
  const weather = state.civilization.weather;
  const pending: Array<{ cell: number; to: number; process: string }> = [];
  for (let cell = 0; cell < WORLD_CELL_COUNT; cell += 1) {
    const surface = surfaceMaterial(state.world.grid, cell);
    const sample = seededFraction(state.seed, `world-process:${atMonth}:${cell}:${surface}`);
    if (surface === Material.CropSprout) {
      const weatherGrowth = weather.kind === 'rain' ? 1.35 : weather.kind === 'drought' ? 0.28 : weather.kind === 'storm' ? 0.75 : 1;
      const rate = (climate.kind === 'temperate' ? 0.2 : climate.kind === 'cold' ? 0.055 : 0.1) * weatherGrowth;
      if (sample < rate) pending.push({ cell, to: Material.CropMature, process: 'plant-growth' });
      else if (weather.kind === 'drought' && sample < 0.035 * weather.intensity) pending.push({ cell, to: Material.ExhaustedSoil, process: 'crop-drought-loss' });
    } else if (surface === Material.Shrub && sample < (climate.kind === 'temperate' ? 0.025 : 0.008)) {
      pending.push({ cell, to: Material.BerryBush, process: 'berry-growth' });
    } else if (surface === Material.BerryBush && weather.kind === 'drought' && sample < weather.intensity * 0.025) {
      pending.push({ cell, to: Material.Shrub, process: 'berry-drought-loss' });
    } else if (surface === Material.Water && (climate.kind === 'cold' || weather.kind === 'snow') && sample < Math.min(0.42, climate.severity * 0.08 + weather.intensity * 0.025)) {
      pending.push({ cell, to: Material.Ice, process: 'freeze' });
    } else if (surface === Material.Water && weather.kind === 'drought' && sample < weather.intensity * 0.004) {
      pending.push({ cell, to: Material.Sand, process: 'evaporation' });
    } else if (surface === Material.Ice && climate.kind !== 'cold' && sample < 0.35) {
      pending.push({ cell, to: Material.Water, process: 'thaw' });
    } else if (surface === Material.WetSoil && (climate.kind === 'heat' || climate.kind === 'fire') && sample < climate.severity * 0.045) {
      pending.push({ cell, to: Material.Soil, process: 'drying' });
    } else if (surface === Material.ExhaustedSoil && neighbors4(cell).some((neighbor) => surfaceMaterial(state.world.grid, neighbor) === Material.Water) && sample < 0.045) {
      pending.push({ cell, to: Material.WetSoil, process: 'soil-recovery' });
    } else if (surface === Material.Fire && (sample < 0.28 || weather.kind === 'rain' || weather.kind === 'storm' || weather.kind === 'snow')) {
      pending.push({ cell, to: Material.Ash, process: 'burn-out' });
      for (const neighbor of neighbors4(cell)) {
        const nearby = surfaceMaterial(state.world.grid, neighbor);
        if (materialHas(nearby, 'flammable') && seededFraction(state.seed, `fire-spread:${atMonth}:${cell}:${neighbor}`) < climate.severity * 0.12) {
          pending.push({ cell: neighbor, to: Material.Fire, process: 'fire-spread' });
        }
      }
    } else if ((surface === Material.Soil || surface === Material.ExhaustedSoil) && weather.kind === 'rain' && sample < weather.intensity * 0.022) {
      pending.push({ cell, to: Material.WetSoil, process: 'rain-soak' });
    }
  }
  for (const change of pending.slice(0, 160)) {
    const from = surfaceMaterial(state.world.grid, change.cell);
    if (from === change.to) continue;
    setVoxel(state.world.grid, cellX(change.cell), cellY(change.cell), topZ(state.world.grid, change.cell), change.to);
    changes.push({ cellId: change.cell, from, to: change.to, process: change.process });
  }
  const destroyedContainers = state.containers.filter((container) => {
    const materialId = voxelAt(state.world.grid, container.position.x, container.position.y, container.position.z);
    return materialId !== Material.Container && materialId !== Material.Granary;
  });
  for (const container of destroyedContainers) {
    const origin = container.position.x + container.position.y * state.world.grid.width;
    const spillPosition = [origin, ...neighbors4(origin)]
      .flatMap((cell) => {
        const position = surfaceStandingPosition(state.world.grid, cell);
        return position ? [position] : [];
      })[0];
    if (spillPosition) for (const stack of container.inventory) {
      addDrop(state, stack.materialId, stack.quantity, spillPosition.cellId, atMonth, [...container.sourceEventIds, ...stack.sourceEventIds], 'destroyed-container', stack.recordPayloadId, spillPosition.z);
    }
  }
  if (destroyedContainers.length) state.containers = state.containers.filter((container) => !destroyedContainers.includes(container));
  if (changes.length) event(state, atMonth, events, 'material', `${changes.length} 个格子的物质因自然过程发生变化`, { changes });

  advanceAnimals(state, atMonth, events);
  return events;
}

function animalDistance(firstCell: number, secondCell: number): number {
  return Math.abs(cellX(firstCell) - cellX(secondCell)) + Math.abs(cellY(firstCell) - cellY(secondCell));
}

function moveAnimal(state: SimulationState, animal: AnimalState, targetCell: number | undefined, atMonth: number): void {
  const species = animalSpecies(animal.speciesId);
  animal.position.previousCellId = animal.position.cellId;
  animal.position.previousZ = animal.position.z;
  for (let step = 0; step < species.movementPerMonth; step += 1) {
    const candidates = neighbors4(animal.position.cellId)
      .flatMap((cell) => {
        const standing = surfaceStandingPosition(state.world.grid, cell);
        return standing ? [standing] : [];
      });
    if (!candidates.length) break;
    candidates.sort((a, b) => {
      const targetDelta = targetCell === undefined ? 0 : animalDistance(a.cellId, targetCell) - animalDistance(b.cellId, targetCell);
      return targetDelta
        || seededFraction(state.seed, `animal-move:${atMonth}:${animal.id}:${step}:${a.cellId}`)
          - seededFraction(state.seed, `animal-move:${atMonth}:${animal.id}:${step}:${b.cellId}`)
        || a.cellId - b.cellId;
    });
    const next = candidates[0];
    animal.position.cellId = next.cellId;
    animal.position.z = next.z;
    if (targetCell !== undefined && next.cellId === targetCell) break;
  }
}

function animalEvent(
  state: SimulationState,
  atMonth: number,
  events: EnvironmentFact[],
  animal: AnimalState,
  result: string,
  diff: Record<string, unknown>,
  person?: PersonState,
): EnvironmentFact {
  const fact = event(state, atMonth, events, 'animal', result, { animalId: animal.id, animalSpeciesId: animal.speciesId, ...diff }, person);
  fact.cellId = animal.position.cellId;
  return fact;
}

function dropAnimalProducts(state: SimulationState, animal: AnimalState, atMonth: number, sourceEventId: string): Array<{ materialId: number; quantity: number }> {
  const species = animalSpecies(animal.speciesId);
  return species.products.flatMap((product) => {
    const span = Math.max(0, product.maxQuantity - product.minQuantity);
    const quantity = product.minQuantity + Math.floor(seededFraction(state.seed, `animal-product:${animal.id}:${atMonth}:${product.materialId}`) * (span + 1));
    if (quantity <= 0) return [];
    addDrop(state, product.materialId, quantity, animal.position.cellId, atMonth, [sourceEventId], `${animal.id}-carcass`, undefined, animal.position.z);
    return [{ materialId: product.materialId, quantity }];
  });
}

function killAnimal(state: SimulationState, animal: AnimalState, atMonth: number, events: EnvironmentFact[], process: string, killerAnimalId?: string): void {
  if (animal.diedAtMonth !== undefined) return;
  animal.health = 0;
  animal.diedAtMonth = atMonth;
  const fact = animalEvent(state, atMonth, events, animal, `${animalSpecies(animal.speciesId).name}在生态过程中死亡`, {
    process, outcome: 'death', ...(killerAnimalId ? { killerAnimalId } : {}),
  });
  fact.diff.products = dropAnimalProducts(state, animal, atMonth, fact.id);
}

function ediblePlant(materialId: number): boolean {
  return materialId === Material.Grass
    || materialId === Material.Shrub
    || materialId === Material.BerryBush
    || materialId === Material.CropSprout
    || materialId === Material.CropMature;
}

function advanceAnimalBirths(state: SimulationState, atMonth: number, events: EnvironmentFact[]): void {
  if (atMonth % 12 !== 3) return;
  for (const speciesId of ['deer', 'rabbit', 'boar', 'wolf'] as const) {
    const species = animalSpecies(speciesId);
    const living = state.world.animals.filter((animal) => animal.speciesId === speciesId && isAnimalAlive(animal));
    if (living.length >= species.carryingCapacity) continue;
    const mothers = living.filter((animal) => animal.sex === 'female' && animalAgeMonths(animal, atMonth) >= species.adultAtMonths && animal.hunger <= 62);
    let births = 0;
    for (const mother of mothers) {
      if (living.length + births >= species.carryingCapacity || births >= 4) break;
      const father = living.find((candidate) => candidate.sex === 'male'
        && animalAgeMonths(candidate, atMonth) >= species.adultAtMonths
        && animalDistance(candidate.position.cellId, mother.position.cellId) <= 3);
      if (!father) continue;
      const chance = speciesId === 'rabbit' ? 0.48 : speciesId === 'boar' ? 0.25 : speciesId === 'deer' ? 0.2 : 0.16;
      if (seededFraction(state.seed, `animal-birth:${atMonth}:${mother.id}:${father.id}`) >= chance) continue;
      const id = `animal-${speciesId}-born-${atMonth}-${state.world.animals.length}`;
      const child: AnimalState = {
        id,
        speciesId,
        sex: seededFraction(state.seed, `${id}:sex`) < 0.5 ? 'female' : 'male',
        bornAtMonth: atMonth,
        lifespanMonths: Math.round(species.lifespanMonths * (0.82 + seededFraction(state.seed, `${id}:lifespan`) * 0.36)),
        geneticParents: [mother.id, father.id],
        position: {
          cellId: mother.position.cellId, z: mother.position.z,
          previousCellId: mother.position.cellId, previousZ: mother.position.z,
        },
        health: 72,
        hunger: 18,
        lastAteAtMonth: atMonth,
      };
      state.world.animals.push(child);
      births += 1;
      animalEvent(state, atMonth, events, child, `一只${species.name}幼仔出生`, {
        process: 'birth', outcome: 'birth', parentIds: [mother.id, father.id],
      });
    }
  }
}

function advanceAnimals(state: SimulationState, atMonth: number, events: EnvironmentFact[]): void {
  const animalsAtStart = state.world.animals.filter(isAnimalAlive);
  for (const animal of animalsAtStart) {
    if (!isAnimalAlive(animal)) continue;
    const species = animalSpecies(animal.speciesId);
    animal.hunger = Math.min(120, animal.hunger + species.hungerPerMonth + (state.civilization.weather.kind === 'drought' ? 2 : 0));
    if (animalAgeMonths(animal, atMonth) > animal.lifespanMonths) {
      const agePressure = (animalAgeMonths(animal, atMonth) - animal.lifespanMonths) / 24;
      if (seededFraction(state.seed, `animal-aging:${atMonth}:${animal.id}`) < Math.min(0.7, 0.08 + agePressure)) {
        killAnimal(state, animal, atMonth, events, 'aging');
        continue;
      }
    }
    if (animal.hunger >= 100) animal.health = Math.max(0, animal.health - 9);
    if (animal.health <= 0) {
      killAnimal(state, animal, atMonth, events, 'starvation');
      continue;
    }

    if (species.diet === 'herbivore') {
      const target = cellsInRadius(animal.position.cellId, 5)
        .filter((cell) => ediblePlant(surfaceMaterial(state.world.grid, cell)))
        .sort((a, b) => animalDistance(animal.position.cellId, a) - animalDistance(animal.position.cellId, b) || a - b)[0];
      moveAnimal(state, animal, target, atMonth);
      const food = surfaceMaterial(state.world.grid, animal.position.cellId);
      if (ediblePlant(food) && animal.hunger >= 34) {
        const replacement = food === Material.BerryBush ? Material.Shrub
          : food === Material.CropMature || food === Material.CropSprout ? Material.ExhaustedSoil
            : food === Material.Shrub ? Material.Soil : Material.Grass;
        if (replacement !== food) setVoxel(state.world.grid, cellX(animal.position.cellId), cellY(animal.position.cellId), topZ(state.world.grid, animal.position.cellId), replacement);
        animal.hunger = Math.max(0, animal.hunger - (food === Material.CropMature || food === Material.BerryBush ? 58 : 36));
        animal.lastAteAtMonth = atMonth;
        if (food === Material.CropMature || food === Material.CropSprout || food === Material.BerryBush) {
          animalEvent(state, atMonth, events, animal, `${species.name}取食并改变了一处植物地表`, {
            process: 'forage', fromMaterialId: food, toMaterialId: replacement,
          });
        }
      }
      const localPerson = state.people.find((person) => isAlive(person)
        && person.position.cellId === animal.position.cellId
        && person.position.z === animal.position.z);
      if (species.aggression > 0 && animal.hunger >= 78 && localPerson && !shelterGeometryAt(state.world.grid, localPerson.position)) {
        const chance = species.aggression / 240;
        if (seededFraction(state.seed, `animal-attack:${atMonth}:${animal.id}:${localPerson.id}`) < chance) {
          const damage = 4 + Math.floor(species.aggression / 14);
          localPerson.body.health = clamp(localPerson.body.health - damage);
          const wound = localPerson.conditions.find((condition) => condition.kind === 'wound');
          if (wound) wound.stage = Math.min(3, wound.stage + 1) as 1 | 2 | 3;
          else localPerson.conditions.push({ id: `condition-wound-animal-${localPerson.id}-${atMonth}`, kind: 'wound', stage: 1, sinceMonth: atMonth, sourceEventIds: [] });
          const fact = animalEvent(state, atMonth, events, animal, `${species.name}袭击${localPerson.name}并造成伤害`, {
            process: 'attack-human', victimId: localPerson.id, damage,
          }, localPerson);
          const condition = localPerson.conditions.find((candidate) => candidate.id === `condition-wound-animal-${localPerson.id}-${atMonth}`);
          if (condition) condition.sourceEventIds.push(fact.id);
        }
      }
    } else {
      const prey = state.world.animals
        .filter((candidate) => isAnimalAlive(candidate) && animalSpecies(candidate.speciesId).diet === 'herbivore')
        .sort((a, b) => animalDistance(animal.position.cellId, a.position.cellId) - animalDistance(animal.position.cellId, b.position.cellId) || a.id.localeCompare(b.id))[0];
      moveAnimal(state, animal, prey?.position.cellId, atMonth);
      if (prey && prey.position.cellId === animal.position.cellId && animal.hunger >= 45) {
        const chance = Math.min(0.82, 0.38 + (species.aggression - animalSpecies(prey.speciesId).evasion) / 180);
        if (seededFraction(state.seed, `animal-hunt:${atMonth}:${animal.id}:${prey.id}`) < chance) {
          killAnimal(state, prey, atMonth, events, 'predation', animal.id);
          animal.hunger = Math.max(0, animal.hunger - 72);
          animal.lastAteAtMonth = atMonth;
        }
      }
      const victim = state.people.find((person) => isAlive(person)
        && person.position.cellId === animal.position.cellId
        && person.position.z === animal.position.z
        && !shelterGeometryAt(state.world.grid, person.position));
      if (victim && animal.hunger >= 72) {
        const chance = species.aggression / 180;
        if (seededFraction(state.seed, `predator-attack:${atMonth}:${animal.id}:${victim.id}`) < chance) {
          const damage = 6 + Math.floor(species.aggression / 11);
          victim.body.health = clamp(victim.body.health - damage);
          const wound = victim.conditions.find((condition) => condition.kind === 'wound');
          if (wound) wound.stage = Math.min(3, wound.stage + 1) as 1 | 2 | 3;
          else victim.conditions.push({ id: `condition-wound-animal-${victim.id}-${atMonth}`, kind: 'wound', stage: 2, sinceMonth: atMonth, sourceEventIds: [] });
          const fact = animalEvent(state, atMonth, events, animal, `${species.name}袭击${victim.name}并造成伤害`, {
            process: 'attack-human', victimId: victim.id, damage,
          }, victim);
          const condition = victim.conditions.find((candidate) => candidate.id === `condition-wound-animal-${victim.id}-${atMonth}`);
          if (condition) condition.sourceEventIds.push(fact.id);
        }
      }
    }
  }
  advanceAnimalBirths(state, atMonth, events);
}

function nearbyFires(state: SimulationState, person: PersonState): number {
  let count = 0;
  for (const cell of cellsInRadius(person.position.cellId, 2)) {
    for (let z = Math.max(0, person.position.z - 2); z <= Math.min(state.world.grid.levels - 1, person.position.z + 2); z += 1) {
      if (voxelAt(state.world.grid, cellX(cell), cellY(cell), z) === Material.Fire) count += 1;
    }
  }
  return count;
}

function condition(state: SimulationState, person: PersonState, kind: ConditionInstance['kind']): ConditionInstance | undefined {
  void state;
  return person.conditions.find((item) => item.kind === kind);
}

function learnFromInheritedOutcome(observer: PersonState, child: PersonState, atMonth: number, sourceEventId: string, kind: 'birth' | 'illness'): void {
  if (ageMonths(observer, atMonth) < 12 * 12) return;
  remember(observer, {
    id: `memory:inherited-outcome:${sourceEventId}:${observer.id}`,
    kind: 'episode',
    summary: kind === 'birth'
      ? `${child.name}的亲代关系很近，出生时的体质与能力低于双亲的平均状态`
      : `${child.name}在有较高遗传负荷时出现了反复疾病`,
    importance: kind === 'birth' ? 76 : 88,
    createdAtMonth: atMonth,
    lastRecalledAtMonth: atMonth,
    personIds: [child.id, ...child.geneticParents],
    sourceEventIds: [sourceEventId],
  });
  const known = observer.knowledge.find((fact) => fact.id === KINSHIP_RISK_KNOWLEDGE_ID);
  const confidence = kind === 'birth' ? 42 : 48;
  if (known) {
    known.confidence = clamp(known.confidence + (kind === 'birth' ? 16 : 20));
    known.sourceEventIds = [...new Set([...known.sourceEventIds, sourceEventId])].slice(-24);
  } else observer.knowledge.push({
    id: KINSHIP_RISK_KNOWLEDGE_ID,
    kind: 'claim',
    summary: '亲缘很近的双方繁衍时，后代更容易体弱、能力下降或反复生病',
    confidence,
    learnedAtMonth: atMonth,
    sourceEventIds: [sourceEventId],
  });
}

function advanceInheritedSusceptibility(state: SimulationState, person: PersonState, atMonth: number, events: EnvironmentFact[]): void {
  const load = person.geneticLoad ?? 0;
  if (load < 0.15 || condition(state, person, 'illness')) return;
  const risk = load * 0.012;
  if (seededFraction(state.seed, `inherited-illness:${atMonth}:${person.id}`) >= risk) return;
  const illness: ConditionInstance = {
    id: `condition-illness-inherited-${person.id}-${atMonth}`,
    kind: 'illness',
    stage: load >= 0.72 ? 2 : 1,
    sinceMonth: atMonth,
    sourceEventIds: [],
  };
  person.conditions.push(illness);
  const fact = event(state, atMonth, events, 'condition', `${person.name}因遗传易感性出现疾病`, {
    condition: 'illness', stage: illness.stage, inheritedSusceptibility: true, geneticLoad: load, risk,
  }, person);
  illness.sourceEventIds.push(fact.id);
  for (const observer of state.people.filter((candidate) => isAlive(candidate)
    && sameLocation(candidate, person)
    && (candidate.id === person.id || candidate.geneticParents.includes(person.id) || person.geneticParents.includes(candidate.id) || candidate.relations.some((relation) => relation.personId === person.id && relation.bond >= 10)))) {
    learnFromInheritedOutcome(observer, person, atMonth, fact.id, 'illness');
  }
}

function upsertExposureCondition(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
  kind: 'cold' | 'heat',
  load: number,
  protectedHere: boolean,
  protectedByFire: boolean,
  events: EnvironmentFact[],
): void {
  const current = condition(state, person, kind);
  if (load > 0 && !current) {
    const probability = Math.min(0.9, 0.18 + load * 0.18);
    const sample = seededFraction(state.seed, `condition-enter:${atMonth}:${person.id}:${kind}`);
    if (sample < probability) {
      const created: ConditionInstance = { id: `condition-${kind}-${person.id}-${atMonth}`, kind, stage: Math.min(3, Math.max(1, Math.ceil(load))) as 1 | 2 | 3, sinceMonth: atMonth, sourceEventIds: [] };
      person.conditions.push(created);
      const fact = event(state, atMonth, events, 'condition', `${person.name}进入${kind === 'cold' ? '寒冷' : '炎热'}状态`, { condition: kind, stage: created.stage }, person);
      created.sourceEventIds.push(fact.id);
    }
  } else if (current && load > current.stage + 0.6) {
    current.stage = Math.min(3, current.stage + 1) as 1 | 2 | 3;
    const fact = event(state, atMonth, events, 'condition', `${person.name}的${kind === 'cold' ? '寒冷' : '炎热'}加重`, { condition: kind, stage: current.stage }, person);
    current.sourceEventIds.push(fact.id);
  } else if (current && (load <= 0 || protectedHere)) {
    const probability = protectedHere ? 0.7 : 0.35;
    if (seededFraction(state.seed, `condition-exit:${atMonth}:${person.id}:${kind}`) < probability) {
      person.conditions = person.conditions.filter((item) => item.id !== current.id);
      event(state, atMonth, events, 'condition', `${person.name}退出${kind === 'cold' ? '寒冷' : '炎热'}状态`, { condition: kind, exited: true, ...(protectedByFire ? { protectedByFire: true } : {}) }, person);
    }
  }
}

function clearOppositeExposure(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
  activeKind: 'cold' | 'heat',
  events: EnvironmentFact[],
): void {
  const oppositeKind = activeKind === 'cold' ? 'heat' : 'cold';
  const opposite = condition(state, person, oppositeKind);
  if (!opposite) return;
  person.conditions = person.conditions.filter((item) => item.id !== opposite.id);
  event(state, atMonth, events, 'condition', `${person.name}的${oppositeKind === 'cold' ? '寒冷' : '炎热'}状态因相反热负荷而退出`, {
    condition: oppositeKind,
    exited: true,
    counteredBy: activeKind,
  }, person);
}

function recoverInjuries(state: SimulationState, person: PersonState, atMonth: number, sheltered: boolean, events: EnvironmentFact[]): void {
  for (const current of [...person.conditions]) {
    if (current.kind !== 'wound' && current.kind !== 'illness') continue;
    const nourished = person.body.nutrition >= 55 && person.body.hydration >= 55;
    const recovery = 0.08 + (nourished ? 0.17 : 0) + (sheltered ? 0.12 : 0);
    if (seededFraction(state.seed, `condition-recover:${atMonth}:${person.id}:${current.id}`) < recovery) {
      if (current.stage > 1) current.stage = (current.stage - 1) as 1 | 2;
      else person.conditions = person.conditions.filter((item) => item.id !== current.id);
      event(state, atMonth, events, 'condition', `${person.name}的${current.kind === 'wound' ? '伤口' : '疾病'}有所恢复`, { condition: current.kind, stage: current.stage }, person);
    }
  }
  const wound = condition(state, person, 'wound');
  if (wound && !condition(state, person, 'illness')) {
    const infectionRisk = 0.018 * wound.stage * (person.body.nutrition < 35 ? 2 : 1);
    if (seededFraction(state.seed, `wound-infection:${atMonth}:${person.id}`) < infectionRisk) {
      const illness: ConditionInstance = { id: `condition-illness-${person.id}-${atMonth}`, kind: 'illness', stage: 1, sinceMonth: atMonth, sourceEventIds: [...wound.sourceEventIds] };
      person.conditions.push(illness);
      const fact = event(state, atMonth, events, 'condition', `${person.name}的伤口引发疾病`, { condition: 'illness', stage: 1 }, person);
      illness.sourceEventIds.push(fact.id);
    }
  }
}

function advanceAging(state: SimulationState, person: PersonState, atMonth: number, events: EnvironmentFact[]): void {
  const age = atMonth - person.bornAtMonth;
  const baseline = Math.max(1, person.lifespanMonths);
  const ratio = age / baseline;
  const current = condition(state, person, 'aging');
  const targetStage = ratio >= 0.94 ? 3 : ratio >= 0.82 ? 2 : ratio >= 0.66 ? 1 : 0;
  if (!current && targetStage > 0) {
    const pressure = Math.max(0, ratio - 0.66);
    const probability = Math.min(0.35, 0.012 + pressure * 0.22);
    if (seededFraction(state.seed, `aging-enter:${atMonth}:${person.id}`) < probability) {
      const created: ConditionInstance = { id: `condition-aging-${person.id}-${atMonth}`, kind: 'aging', stage: 1, sinceMonth: atMonth, sourceEventIds: [] };
      person.conditions.push(created);
      const fact = event(state, atMonth, events, 'condition', `${person.name}进入衰老第一阶段`, { condition: 'aging', stage: 1, ageMonths: age }, person);
      created.sourceEventIds.push(fact.id);
    }
    return;
  }
  if (!current || targetStage <= current.stage) return;
  const pressure = Math.max(0, ratio - (current.stage === 1 ? 0.82 : 0.94));
  const probability = Math.min(0.45, 0.018 + pressure * 0.28);
  if (seededFraction(state.seed, `aging-progress:${atMonth}:${person.id}:${current.stage}`) >= probability) return;
  current.stage = (current.stage + 1) as 2 | 3;
  const fact = event(state, atMonth, events, 'condition', `${person.name}的衰老进入第 ${current.stage} 阶段`, { condition: 'aging', stage: current.stage, ageMonths: age }, person);
  current.sourceEventIds.push(fact.id);
}

function newborn(state: SimulationState, mother: PersonState, fatherId: string, atMonth: number): PersonState {
  const id = `born-${atMonth}-${mother.id}-${state.people.length}`;
  const father = state.people.find((person) => person.id === fatherId);
  const sex = createBiologicalSex(state.seed, id);
  const naming = createNewbornName(state.seed, id, sex, father ?? mother, state.people.map((person) => person.name));
  const geneticLoad = inheritedGeneticLoad(state, mother, father);
  const average = (field: keyof PersonState['baselineCapacities']) => Math.round((mother.baselineCapacities[field] + (father?.baselineCapacities[field] ?? mother.baselineCapacities[field])) / 2);
  const inheritedCapacity = (field: keyof PersonState['baselineCapacities']) => Math.max(20, average(field) - Math.round(geneticLoad * (5 + deterministicFraction(state.seed, `${id}:genetic:${field}`) * 7)));
  const baselineLifespan = createLifespanMonths(state.seed, id);
  return {
    id,
    name: naming.name,
    color: mother.color,
    profile: { description: `${mother.name}与${father?.name ?? '未知者'}的后代` },
    bornAtMonth: atMonth,
    lifespanMonths: Math.max(36 * 12, Math.round(baselineLifespan * (1 - geneticLoad * 0.18))),
    sex,
    familyName: naming.familyName,
    namingTradition: naming.namingTradition,
    geneticParents: [mother.id, fatherId],
    generation: Math.max(mother.generation, father?.generation ?? 0) + 1,
    geneticLoad,
    position: {
      cellId: mother.position.cellId,
      z: mother.position.z,
      previousCellId: mother.position.cellId,
      previousZ: mother.position.z,
      lastPath: [mother.position.cellId],
      tickPath: [mother.position.cellId],
    },
    body: { health: Math.max(48, 72 - Math.round(geneticLoad * 11)), hydration: 74, nutrition: 76 },
    baselineCapacities: {
      locomotion: inheritedCapacity('locomotion'), manipulation: inheritedCapacity('manipulation'), perception: inheritedCapacity('perception'),
      communication: inheritedCapacity('communication'), cognition: inheritedCapacity('cognition'),
    },
    personality: createPersonality(
      state.seed,
      id,
      [mother.personality, ...(father ? [father.personality] : [])],
    ),
    motiveSensitivity: createMotiveSensitivity(state.seed, id),
    conditions: [], inventory: [], knowledge: [], knownPlaces: [], memories: [],
    relations: state.people.filter(isAlive).map((person) => ({ personId: person.id, trust: 0, bond: 0, fear: 0, sourceEventIds: [] })),
    currentActionText: '依赖身边人的照护', lastDecisionText: '尚不能独立决策',
  };
}

function advancePregnancies(state: SimulationState, person: PersonState, atMonth: number, events: EnvironmentFact[]): void {
  const pregnancy = condition(state, person, 'pregnancy');
  if (!pregnancy?.dueAtMonth) return;
  const remaining = pregnancy.dueAtMonth - atMonth;
  pregnancy.stage = remaining <= 2 ? 3 : remaining <= 5 ? 2 : 1;
  if (person.body.health < 18 || person.body.nutrition < 10) {
    if (seededFraction(state.seed, `pregnancy-loss:${atMonth}:${person.id}`) < 0.28) {
      person.conditions = person.conditions.filter((item) => item.id !== pregnancy.id);
      event(state, atMonth, events, 'condition', `${person.name}的妊娠过程因身体恶化而中止`, { pregnancyEnded: true }, person);
    }
    return;
  }
  if (atMonth < pregnancy.dueAtMonth) return;
  const child = newborn(state, person, pregnancy.otherPersonId ?? 'unknown', atMonth);
  const father = state.people.find((candidate) => candidate.id === pregnancy.otherPersonId);
  const parentalKinshipRisk = father ? geneticKinshipRisk(state, person, father) : 0;
  state.people.push(child);
  person.conditions = person.conditions.filter((item) => item.id !== pregnancy.id);
  const minimumReserve = Math.min(person.body.health, person.body.hydration, person.body.nutrition);
  const recoveryMonths = minimumReserve >= 70 ? 9 : minimumReserve >= 50 ? 12 : 15;
  const recoveryUntilMonth = atMonth + recoveryMonths;
  const fact = event(state, atMonth, events, 'body', `${person.name}生下了${child.name}，进入产后恢复期`, {
    bornPersonId: child.id,
    bornPersonName: child.name,
    sex: child.sex,
    familyName: child.familyName,
    namingTradition: child.namingTradition,
    parents: child.geneticParents,
    generation: child.generation,
    parentalKinshipRisk,
    geneticLoad: child.geneticLoad,
    inheritedHealth: child.body.health,
    inheritedCapacities: child.baselineCapacities,
    postpartumRecoveryMonths: recoveryMonths,
    postpartumRecoveryUntilMonth: recoveryUntilMonth,
  }, person);
  person.conditions.push({
    id: `condition-postpartum-recovery-${person.id}-${atMonth}`,
    kind: 'postpartum-recovery',
    stage: 3,
    sinceMonth: atMonth,
    endsAtMonth: recoveryUntilMonth,
    sourceEventIds: [fact.id],
    otherPersonId: child.id,
  });
  if (child.geneticLoad >= 0.3) {
    for (const parent of state.people.filter((candidate) => child.geneticParents.includes(candidate.id) && sameLocation(candidate, child))) {
      learnFromInheritedOutcome(parent, child, atMonth, fact.id, 'birth');
    }
  }
  child.relations.forEach((relation) => {
    if (!child.geneticParents.includes(relation.personId)) return;
    relation.bond = 12;
    relation.sourceEventIds = [fact.id];
  });
  for (const existing of state.people) {
    if (existing.id === child.id || existing.relations.some((relation) => relation.personId === child.id)) continue;
    const closeKin = child.geneticParents.includes(existing.id);
    existing.relations.push({ personId: child.id, trust: 0, bond: closeKin ? 12 : 0, fear: 0, sourceEventIds: closeKin ? [fact.id] : [] });
  }
}

function advancePostpartumRecovery(state: SimulationState, person: PersonState, atMonth: number, events: EnvironmentFact[]): void {
  const recovery = condition(state, person, 'postpartum-recovery');
  if (!recovery) return;
  const endsAtMonth = recovery.endsAtMonth ?? recovery.sinceMonth + 12;
  if (atMonth >= endsAtMonth) {
    person.conditions = person.conditions.filter((item) => item.id !== recovery.id);
    event(state, atMonth, events, 'condition', `${person.name}结束了产后恢复期`, {
      postpartumRecoveryEnded: true,
      postpartumConditionId: recovery.id,
    }, person);
    return;
  }
  const progress = (atMonth - recovery.sinceMonth) / Math.max(1, endsAtMonth - recovery.sinceMonth);
  recovery.stage = progress < 1 / 3 ? 3 : progress < 2 / 3 ? 2 : 1;
}

function die(state: SimulationState, person: PersonState, atMonth: number, events: EnvironmentFact[], cause: 'body-failure' | 'aging-terminal'): void {
  const healthBeforeDeath = person.body.health;
  person.diedAtMonth = atMonth;
  person.body.health = 0;
  for (const stack of person.inventory) {
    addDrop(
      state,
      stack.materialId,
      stack.quantity,
      person.position.cellId,
      atMonth,
      [...stack.sourceEventIds],
      `${person.id}-death`,
      stack.recordPayloadId,
      person.position.z,
      [`inventory:${person.id}:${stack.id}`, ...(stack.sourceLineageKeys ?? [])],
    );
  }
  person.inventory = [];
  const intent = state.intents.find((candidate) => candidate.id === person.activeIntentId);
  if (intent) intent.status = 'failed';
  delete person.activeIntentId;
  const causalConditions = person.conditions.flatMap((current) => current.sourceEventIds);
  event(state, atMonth, events, 'death', `${person.name}在第 ${atMonth} 月死亡，私有背包遗留在原地`, {
    personId: person.id,
    ageMonths: atMonth - person.bornAtMonth,
    cause,
    healthBeforeDeath,
    sourceEventIds: [...new Set(causalConditions)].slice(-24),
  }, person);
}

export function advanceBodies(state: SimulationState, atMonth: number): EnvironmentFact[] {
  const events: EnvironmentFact[] = [];
  const peopleAtStart = [...state.people];
  const resourceCompetition = humanResourceCompetitionMultiplier(peopleAtStart.filter(isAlive).length);
  for (const person of peopleAtStart) {
    if (person.diedAtMonth !== undefined) continue;
    if (person.body.health <= 0) {
      die(state, person, atMonth, events, 'body-failure');
      continue;
    }
    advanceInheritedSusceptibility(state, person, atMonth, events);
    const hibernationCondition = person.conditions.find((current) => current.kind === 'dehydrated-hibernation');
    let hibernating = Boolean(hibernationCondition);
    const enteredBeforeCurrentEra = Boolean(hibernationCondition
      && hibernationCondition.sinceMonth < state.civilization.era.sinceMonth);
    if (hibernating && state.civilization.epoch === 'stable' && enteredBeforeCurrentEra) {
      const waterNearby = cellsInRadius(person.position.cellId, 2).some((cell) => {
        const surface = surfaceMaterial(state.world.grid, cell);
        return surface === Material.Water || surface === Material.Ice;
      });
      const helperNearby = state.people.some((candidate) => candidate.id !== person.id
        && isAlive(candidate)
        && !candidate.conditions.some((current) => current.kind === 'dehydrated-hibernation')
        && sameLocation(candidate, person));
      const ambientRecovery = atMonth > state.civilization.era.sinceMonth;
      if (waterNearby || helperNearby || ambientRecovery) {
        person.conditions = person.conditions.filter((current) => current.kind !== 'dehydrated-hibernation');
        person.body.hydration = clamp(person.body.hydration + 12);
        hibernating = false;
        event(state, atMonth, events, 'condition', `${person.name}在新恒纪元恢复可利用水分后重新水化苏醒`, {
          condition: 'dehydrated-hibernation', exited: true, waterNearby, helperNearby, ambientRecovery,
        }, person);
      }
    }
    const shelter = shelterGeometryAt(state.world.grid, person.position);
    const sheltered = Boolean(shelter);
    const fires = nearbyFires(state, person);
    const fireProtected = fires > 0;
    const clothed = inventoryQuantity(person, Material.Clothing) > 0 || inventoryQuantity(person, Material.LeatherClothing) > 0;
    const climate = state.civilization.climate;
    const weather = state.civilization.weather;
    const shelterColdRelief = (shelter?.weatherProtection ?? 0) / 72 + (shelter?.thermalInsulation ?? 0) / 180;
    const heatReliefFromShelter = shelterHeatRelief(shelter);
    const weatherCold = weather.kind === 'snow' ? weather.intensity * 0.45 : weather.kind === 'storm' && climate.kind === 'cold' ? weather.intensity * 0.18 : 0;
    const weatherHeat = weather.kind === 'drought' ? weather.intensity * 0.38 : 0;
    const hibernationRelief = hibernating ? 0.08 : 1;
    const coldLoad = climate.kind === 'cold'
      ? Math.max(0, climate.severity + weatherCold - shelterColdRelief - (fireProtected ? 2.2 : 0) - (clothed ? 0.9 : 0)) * hibernationRelief
      : 0;
    const heatLoad = climate.kind === 'heat' || climate.kind === 'fire'
      ? Math.max(0, climate.severity + weatherHeat - heatReliefFromShelter + (fireProtected ? 0.6 : 0) + (clothed ? 0.25 : 0)) * hibernationRelief
      : 0;
    if (coldLoad > 0) clearOppositeExposure(state, person, atMonth, 'cold', events);
    else if (heatLoad > 0) clearOppositeExposure(state, person, atMonth, 'heat', events);
    upsertExposureCondition(state, person, atMonth, 'cold', coldLoad, coldLoad <= 0 && (sheltered || fireProtected), fireProtected, events);
    upsertExposureCondition(state, person, atMonth, 'heat', heatLoad, heatLoad <= 0 && sheltered, false, events);

    const coldCondition = condition(state, person, 'cold')?.stage ?? 0;
    const cold = fireProtected ? Math.max(0, coldCondition - 2) : coldCondition;
    const heat = condition(state, person, 'heat')?.stage ?? 0;
    const wound = condition(state, person, 'wound')?.stage ?? 0;
    const illness = condition(state, person, 'illness')?.stage ?? 0;
    const pregnancy = condition(state, person, 'pregnancy')?.stage ?? 0;
    advancePostpartumRecovery(state, person, atMonth, events);
    const postpartum = condition(state, person, 'postpartum-recovery')?.stage ?? 0;
    advanceAging(state, person, atMonth, events);
    const aging = condition(state, person, 'aging')?.stage ?? 0;
    const hydrationCost = (hibernating
      ? HIBERNATION_HYDRATION_COST
      : 1.35 * (heat ? [1, 1.3, 1.7, 2.2][heat] : 1) + illness * 0.35 + pregnancy * 0.22 + postpartum * 0.12 + (weather.kind === 'drought' ? weather.intensity * 0.18 : 0)) * resourceCompetition;
    const nutritionCost = (hibernating
      ? HIBERNATION_NUTRITION_COST
      : 1.25 * (cold ? [1, 1.25, 1.5, 1.8][cold] : 1) + illness * 0.38 + pregnancy * 0.28 + postpartum * 0.18) * resourceCompetition;
    person.body.hydration = clamp(person.body.hydration - hydrationCost);
    person.body.nutrition = clamp(person.body.nutrition - nutritionCost);
    let healthDelta = 0;
    if (hibernating) {
      healthDelta -= HIBERNATION_HEALTH_COST;
      if (state.civilization.epoch === 'chaotic' && climate.severity >= 8) healthDelta -= 0.15;
    } else {
      if (person.body.hydration < 10) healthDelta -= 7;
      else if (person.body.hydration < 25) healthDelta -= 2;
      if (person.body.nutrition < 10) healthDelta -= 6;
      else if (person.body.nutrition < 25) healthDelta -= 2;
      if (cold >= 3) healthDelta -= 2;
      if (heat >= 3) healthDelta -= 3;
      healthDelta -= Math.max(0, wound - 1) * 1.5 + Math.max(0, illness - 1) * 1.5;
      if (aging >= 2 && (person.body.hydration < 45 || person.body.nutrition < 45)) healthDelta -= aging === 3 ? 1.5 : 0.5;
      if (person.body.hydration >= 65 && person.body.nutrition >= 65 && (sheltered || fireProtected || climate.kind === 'temperate') && !wound && !illness) {
        healthDelta += 1.4 * (aging === 1 ? 0.9 : aging === 2 ? 0.65 : aging === 3 ? 0.3 : 1);
      }
    }
    person.body.health = clamp(person.body.health + healthDelta);
    if (hibernating && hibernationCondition) {
      const hibernationMonths = Math.max(1, atMonth - hibernationCondition.sinceMonth + 1);
      const minimumReserve = Math.min(person.body.health, person.body.hydration, person.body.nutrition);
      const nextStage = hibernationMonths >= 18 || minimumReserve < 30
        ? 3
        : hibernationMonths >= 6 || minimumReserve < 45
          ? 2
          : 1;
      if (nextStage > hibernationCondition.stage) {
        hibernationCondition.stage = nextStage;
        const deterioration = event(state, atMonth, events, 'condition', `${person.name}的长期脱水休眠开始明显消耗身体机能`, {
          condition: 'dehydrated-hibernation',
          hibernationConditionId: hibernationCondition.id,
          hibernationMonths,
          stage: nextStage,
          health: person.body.health,
          hydration: person.body.hydration,
          nutrition: person.body.nutrition,
        }, person);
        hibernationCondition.sourceEventIds = [...new Set([...hibernationCondition.sourceEventIds, deterioration.id])].slice(-24);
      }
    }
    if (!hibernating) recoverInjuries(state, person, atMonth, sheltered || fireProtected, events);
    advancePregnancies(state, person, atMonth, events);
    const ageRatio = (atMonth - person.bornAtMonth) / Math.max(1, person.lifespanMonths);
    const terminalRisk = aging === 3
      ? Math.min(0.42, Math.max(0, ageRatio - 1) * 0.035 + Math.max(0, 45 - person.body.health) * 0.002 + illness * 0.012 + wound * 0.008)
      : 0;
    const terminal = terminalRisk > 0 && seededFraction(state.seed, `aging-terminal:${atMonth}:${person.id}`) < terminalRisk;
    if (person.body.health <= 0 || terminal) die(state, person, atMonth, events, terminal ? 'aging-terminal' : 'body-failure');
    else if (Math.abs(healthDelta) >= 2 || person.body.hydration < 25 || person.body.nutrition < 25) {
      event(state, atMonth, events, 'body', `${person.name}的身体储备发生显著变化`, { health: person.body.health, hydration: person.body.hydration, nutrition: person.body.nutrition, healthDelta }, person);
    }
  }
  return events;
}

function adverseRelationshipPair(event: WorldEvent): string | undefined {
  if (event.kind !== 'action') return undefined;
  if (event.action.kind === 'act'
    && event.action.operation === 'exert'
    && event.status === 'completed'
    && typeof event.diff.victimId === 'string') {
    return relationshipPairKey(event.who, event.diff.victimId);
  }
  if (event.action.kind === 'act'
    && event.action.operation === 'combine'
    && event.status === 'completed'
    && typeof event.diff.restrainedPersonId === 'string'
    && typeof event.diff.conditionId === 'string') {
    return relationshipPairKey(event.who, event.diff.restrainedPersonId);
  }
  if (event.action.kind === 'transfer'
    && event.diff.authorized === false
    && event.action.from.kind === 'person') {
    return relationshipPairKey(event.who, event.action.from.personId);
  }
  return undefined;
}

/** Five co-located action ticks form one replayable unit of shared experience. */
export function advanceSharedRelationshipExperience(
  state: SimulationState,
  currentMonthEvents: readonly WorldEvent[],
  atMonth: number,
): EnvironmentFact[] {
  const adversePairs = new Set(currentMonthEvents.flatMap((fact) => {
    const pair = adverseRelationshipPair(fact);
    return pair ? [pair] : [];
  }));
  const peopleById = new Map(state.people.filter(isAlive).map((person) => [person.id, person]));
  const actionsByTickAndPlace = new Map<string, ActionFact[]>();
  for (const fact of currentMonthEvents) {
    if (fact.kind !== 'action'
      || (fact.status !== 'completed' && fact.status !== 'progressed')
      || fact.action.kind === 'communicate'
      || !peopleById.has(fact.who)) continue;
    const key = `${fact.actionTick}:${fact.toCellId}:${fact.toZ}`;
    const actions = actionsByTickAndPlace.get(key) ?? [];
    actions.push(fact);
    actionsByTickAndPlace.set(key, actions);
  }
  const pairActivity = new Map<string, {
    first: PersonState;
    second: PersonState;
    ticks: Set<number>;
    sourceEventIds: Set<string>;
    cellId: number;
  }>();
  for (const actions of actionsByTickAndPlace.values()) {
    const actorActions = [...new Map(actions.map((fact) => [fact.who, fact])).values()]
      .sort((left, right) => left.who.localeCompare(right.who));
    for (let left = 0; left < actorActions.length; left += 1) {
      for (let right = left + 1; right < actorActions.length; right += 1) {
        const leftAction = actorActions[left];
        const rightAction = actorActions[right];
        const first = peopleById.get(leftAction.who);
        const second = peopleById.get(rightAction.who);
        if (!first || !second) continue;
        const pairKey = relationshipPairKey(first.id, second.id);
        const activity = pairActivity.get(pairKey) ?? {
          first,
          second,
          ticks: new Set<number>(),
          sourceEventIds: new Set<string>(),
          cellId: leftAction.toCellId,
        };
        activity.ticks.add(leftAction.actionTick);
        activity.sourceEventIds.add(leftAction.id);
        activity.sourceEventIds.add(rightAction.id);
        pairActivity.set(pairKey, activity);
      }
    }
  }
  const facts: EnvironmentFact[] = [];
  for (const [pairKey, activity] of [...pairActivity.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (adversePairs.has(pairKey)) continue;
    const qualifyingTicks = [...activity.ticks].sort((left, right) => left - right);
    const relationshipDelta = Math.floor(qualifyingTicks.length / 5);
    if (relationshipDelta <= 0) continue;
    const participants = [activity.first, activity.second].sort((left, right) => left.id.localeCompare(right.id));
    const fact: EnvironmentFact = {
      id: `e-${atMonth}-environment-relationship-${facts.length}`,
      kind: 'environment',
      atMonth,
      orderInMonth: facts.length,
      cellId: activity.cellId,
      change: 'relationship',
      result: `${participants.map((person) => person.name).join('、')}本月共同活动 ${qualifyingTicks.length} 个规划刻度，形成可追溯的共同经历`,
      diff: {
        process: 'shared-action-ticks',
        participantIds: participants.map((person) => person.id),
        qualifyingTicks,
        sharedActionTicks: qualifyingTicks.length,
        sourceEventIds: [...activity.sourceEventIds].sort(),
        trustDelta: relationshipDelta,
        bondDelta: relationshipDelta,
      },
    };
    applyRelationEvidence(activity.first, activity.second.id, fact.id, { trust: relationshipDelta, bond: relationshipDelta });
    applyRelationEvidence(activity.second, activity.first.id, fact.id, { trust: relationshipDelta, bond: relationshipDelta });
    facts.push(fact);
  }
  return facts;
}
