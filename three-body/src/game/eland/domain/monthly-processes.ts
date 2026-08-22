import { createBiologicalSex, createLifespanMonths, deterministicFraction } from '../population';
import { Material, materialHas } from './material';
import type { ActionFact, EnvironmentFact, EraSchedule, Intent, SimulationState, WeatherKind, WorldEvent } from './model';
import type { ConditionInstance, PersonState } from './person';
import {
  HIBERNATION_RECOVERY_SAFE_RESERVE,
  ageMonths,
  hibernationPhase,
  isAlive,
  sameLocation,
} from './person';
import {
  createMotiveSensitivity,
  createPersonality,
  newbornInitialTrust,
  sharedActivityTickThreshold,
  youthfulSharedActivityTrustBonus,
} from './personality';
import { createCognitionState, recordIntentGoalOutcome } from './cognition';
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
  applyTraitCapacityModifiers,
  applyTraitLifespanModifier,
  bindTraitSource,
  coldHarmMultiplier,
  grantProphetKnowledge,
  hasTrait,
  heatHarmMultiplier,
  heatHydrationMultiplier,
  injuryRecoveryMultiplier,
  injuryWorseningRiskMultiplier,
  nutritionMetabolicMultiplier,
  personTraitsAtBirth,
  traitDefinition,
  type TraitBirthResult,
} from './trait';
import {
  animalAgeMonths,
  animalSpecies,
  isAnimalAlive,
  type AnimalState,
} from './animal';
import { humanResourceCompetitionMultiplier } from './population-capacity';
import {
  companionLivingAnchor,
  companionSharesLivingArea,
  positionWithinLivingArea,
  REQUIRED_SHARED_LIVING_MONTHS,
  SHARED_LIVING_RELATION_EVIDENCE_INTERVAL_MONTHS,
} from './shared-living';
import {
  HERBIVORE_DANGER_RADIUS,
  PACK_CUE_SHARE_RADIUS,
  WOLF_PERCEPTION_RADIUS,
  behaviorFromIntent,
  createInitialAnimalEcology,
  normalizeAnimalEcologies,
  planWildlifeIntents,
  reachableWildlifeCells,
  synchronizeWolfPackCues,
  wildlifeAnimalSnapshot,
  wildlifeEdiblePlant,
  wildlifePersonSnapshot,
  wolfMovementAllowed,
  type WildlifeAnimalSnapshot,
  type WildlifeIntent,
} from './wildlife-ecology';
import { intentById, intentsOwnedBy, projectById } from './state-index';

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
  const previousEpoch = state.civilization.epoch;
  const previousClimate = state.civilization.climate;
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
  // Observed external epoch changes are historical facts. Keep eraTransition
  // reserved for the local schedule because prediction rules consume it.
  const epochChanged = previousEpoch !== epoch;
  const climateKindChanged = previousClimate.kind !== kind;
  const climateSeverityChanged = previousClimate.severity !== severity;
  const changed = climateKindChanged || climateSeverityChanged || epochChanged;
  state.civilization.epoch = epoch;
  state.civilization.climate = { kind, severity, sinceMonth: changed ? atMonth : previousClimate.sinceMonth };
  if (changed || atMonth === 1 || eraTransition) event(
    state,
    atMonth,
    events,
    'climate',
    `${eraTransition ? `${epoch === 'stable' ? '恒纪元' : '乱纪元'}开始；` : ''}本月地表处于${kind === 'temperate' ? '温和' : kind === 'cold' ? '寒冷' : kind === 'heat' ? '炎热' : '烈火'}环境`,
    {
      epoch, kind, severity, eraSequence: scheduled.sequence,
      eraSinceMonth: scheduled.sinceMonth,
      previousEpoch,
      previousKind: previousClimate.kind,
      previousSeverity: previousClimate.severity,
      ...(epochChanged ? { epochChanged: true } : {}),
      ...(climateKindChanged ? { climateKindChanged: true } : {}),
      ...(climateSeverityChanged ? { climateSeverityChanged: true } : {}),
      ...(eraTransition ? { eraTransition: true } : {}),
    },
  );
  return events;
}

/**
 * A real three-sun collapse is not survivable weather. It resolves before the
 * first planning tick so shelters, hibernation, traits, or queued actions
 * cannot turn a terminal astronomical event into an ordinary heat episode.
 */
export function resolveTerminalCatastrophe(
  state: SimulationState,
  atMonth: number,
  events: EnvironmentFact[],
): boolean {
  if (state.civilization.externalClimate?.terminalCatastrophe !== 'triple-sun-vaporization') return false;
  const catastropheFact: EnvironmentFact = {
    id: `e-${atMonth}-environment-triple-sun-vaporization`,
    kind: 'environment',
    atMonth,
    orderInMonth: events.length,
    planningTick: 1,
    orderInTick: 0,
    cellId: 0,
    change: 'climate',
    result: '三日凌空，地表在第一个规划刻度内进入足以汽化全部人类的辐射与烈焰',
    diff: {
      terminalCatastrophe: 'triple-sun-vaporization',
      vaporization: true,
      bypassesShelter: true,
      bypassesHibernation: true,
      bypassesTraits: true,
    },
  };
  events.push(catastropheFact);
  for (const person of state.people.filter(isAlive)) {
    die(state, person, atMonth, events, 'triple-sun-vaporization', {
      sourceEventIds: [catastropheFact.id],
      vaporized: true,
    });
  }
  return true;
}

const WEATHER_LABEL: Record<WeatherKind, string> = {
  clear: '晴朗',
  rain: '降雨',
  storm: '风暴',
  drought: '干旱',
  snow: '降雪',
  fog: '浓雾',
};

const WEATHER_CONTINUATION_PROBABILITY = 0.55;

function sampledWeatherKind(state: SimulationState, atMonth: number): WeatherKind {
  const climate = state.civilization.climate;
  const sample = seededFraction(state.seed, `weather:${state.civilization.era.sequence}:${atMonth}`);
  if (climate.kind === 'cold') return sample < 0.48 ? 'snow' : sample < 0.62 ? 'storm' : sample < 0.76 ? 'fog' : 'clear';
  if (climate.kind === 'heat' || climate.kind === 'fire') return sample < 0.46 ? 'drought' : sample < 0.58 ? 'storm' : 'clear';
  return sample < 0.27 ? 'rain' : sample < 0.34 ? 'storm' : sample < 0.46 ? 'fog' : sample < 0.51 ? 'drought' : 'clear';
}

function sampledWeatherIntensity(state: SimulationState, atMonth: number, kind: WeatherKind): number {
  if (kind === 'clear') return 1;
  const maximum = state.civilization.epoch === 'chaotic' ? 5 : 3;
  return 1 + Math.floor(seededFraction(
    state.seed,
    `weather-intensity:${state.civilization.era.sequence}:${atMonth}:${kind}`,
  ) * maximum);
}

function weatherFitsClimate(kind: WeatherKind, climate: SimulationState['civilization']['climate']['kind']): boolean {
  if (kind === 'snow') return climate === 'cold';
  if (kind === 'rain') return climate === 'temperate';
  if (kind === 'drought') return climate !== 'cold';
  return true;
}

function driftedWeatherIntensity(state: SimulationState, atMonth: number): number {
  const weather = state.civilization.weather;
  if (weather.kind === 'clear') return 1;
  const maximum = state.civilization.epoch === 'chaotic' ? 5 : 3;
  if (weather.intensity > maximum) return weather.intensity - 1;
  if (seededFraction(state.seed, `weather-intensity-drift:${weather.sinceMonth}:${atMonth}`) >= 0.12) {
    return weather.intensity;
  }
  const direction = seededFraction(state.seed, `weather-intensity-direction:${weather.sinceMonth}:${atMonth}`) < 0.5 ? -1 : 1;
  return Math.max(1, Math.min(maximum, weather.intensity + direction));
}

export function resolveWeather(state: SimulationState, atMonth: number): EnvironmentFact[] {
  const events: EnvironmentFact[] = [];
  const previous = state.civilization.weather;
  const initialObservation = atMonth === 1 && previous.sinceMonth === 0;
  const incompatibleWithClimate = !weatherFitsClimate(previous.kind, state.civilization.climate.kind);
  const continuation = seededFraction(
    state.seed,
    `weather-continuation:${state.civilization.era.sequence}:${atMonth}`,
  ) < WEATHER_CONTINUATION_PROBABILITY;
  const candidateKind = initialObservation || incompatibleWithClimate || !continuation
    ? sampledWeatherKind(state, atMonth)
    : previous.kind;

  if (initialObservation || incompatibleWithClimate || candidateKind !== previous.kind) {
    const intensity = sampledWeatherIntensity(state, atMonth, candidateKind);
    state.civilization.weather = { kind: candidateKind, intensity, sinceMonth: atMonth };
    event(state, atMonth, events, 'weather', `本月天气转为${WEATHER_LABEL[candidateKind]}`, {
      kind: candidateKind,
      intensity,
      previousKind: previous.kind,
      previousIntensity: previous.intensity,
      episodeStarted: true,
    });
    return events;
  }

  const intensity = driftedWeatherIntensity(state, atMonth);
  if (intensity !== previous.intensity) {
    state.civilization.weather = { ...previous, intensity };
    event(
      state,
      atMonth,
      events,
      'weather',
      `本月${WEATHER_LABEL[previous.kind]}强度${intensity > previous.intensity ? '升至' : '降至'}${intensity}`,
      {
        kind: previous.kind,
        intensity,
        previousIntensity: previous.intensity,
        episodeStarted: false,
      },
    );
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
  if (targetCell === animal.position.cellId) return;
  for (let step = 0; step < species.movementPerMonth; step += 1) {
    const candidates = neighbors4(animal.position.cellId)
      .flatMap((cell) => {
        const standing = surfaceStandingPosition(state.world.grid, cell);
        return standing ? [standing] : [];
      })
      .filter((candidate) => Math.abs(candidate.z - animal.position.z) <= 1)
      .filter((candidate) => animal.speciesId !== 'wolf' || wolfMovementAllowed(animal, candidate.cellId));
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

function advanceAnimalBirths(state: SimulationState, atMonth: number, events: EnvironmentFact[]): void {
  if (atMonth % 12 !== 3) return;
  for (const speciesId of ['deer', 'rabbit', 'boar', 'wolf'] as const) {
    const species = animalSpecies(speciesId);
    const living = state.world.animals
      .filter((animal) => animal.speciesId === speciesId && isAnimalAlive(animal))
      .sort((first, second) => first.id.localeCompare(second.id));
    if (living.length >= species.carryingCapacity) continue;
    const mothers = living.filter((animal) => animal.sex === 'female' && animalAgeMonths(animal, atMonth) >= species.adultAtMonths && animal.hunger <= 62);
    let births = 0;
    for (const mother of mothers) {
      if (living.length + births >= species.carryingCapacity || births >= 4) break;
      const reachableMates = reachableWildlifeCells(
        state.world.grid,
        { cellId: mother.position.cellId, z: mother.position.z },
        3,
        mother.ecology.territory,
      );
      const father = living.find((candidate) => candidate.sex === 'male'
        && animalAgeMonths(candidate, atMonth) >= species.adultAtMonths
        && reachableMates.has(candidate.position.cellId)
        && surfaceStandingPosition(state.world.grid, candidate.position.cellId)?.z === candidate.position.z);
      if (!father) continue;
      const chance = speciesId === 'rabbit' ? 0.48 : speciesId === 'boar' ? 0.25 : speciesId === 'deer' ? 0.2 : 0.16;
      if (seededFraction(state.seed, `animal-birth:${atMonth}:${mother.id}:${father.id}`) >= chance) continue;
      const id = `animal-${speciesId}-born-${atMonth}-${state.world.animals.length}`;
      const childEcology = createInitialAnimalEcology(
        speciesId,
        id,
        mother.ecology.territory?.anchorCellId ?? mother.position.cellId,
        mother.ecology.packId,
      );
      if (mother.ecology.territory) childEcology.territory = { ...mother.ecology.territory };
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
        ecology: childEcology,
      };
      state.world.animals.push(child);
      births += 1;
      animalEvent(state, atMonth, events, child, `一只${species.name}幼仔出生`, {
        process: 'birth', outcome: 'birth', parentIds: [mother.id, father.id],
      });
    }
  }
}

function behaviorEventDiff(
  animal: AnimalState,
  intent: WildlifeIntent,
  opening: WildlifeAnimalSnapshot,
): Record<string, unknown> {
  return {
    process: intent.mode === 'pursue-human' ? 'pursuit-human'
      : intent.mode === 'flee' ? 'flee-threat'
        : intent.mode === 'defend' ? 'defensive-charge'
          : intent.mode === 'avoid-humans' ? 'avoid-armed-group'
            : intent.mode === 'territory-return' ? 'territory-return'
              : intent.mode === 'hunt-prey' ? 'hunt-prey'
                : intent.mode,
    intentPhase: 'month-opening-snapshot',
    movementPhase: 'simultaneous-intent-resolution',
    monthOpeningCellId: opening.cellId,
    destinationCellId: animal.position.cellId,
    plannedTargetCellId: intent.targetCellId,
    targetAnimalId: intent.targetAnimalId,
    targetPersonId: intent.targetPersonId,
    perception: intent.mode === 'pursue-human' && intent.sourceCueObservedAtMonth !== undefined ? {
      basis: 'pack-last-seen-cue',
      currentTargetReachable: 'unknown',
      radius: null,
      sourceCueObservedAtMonth: intent.sourceCueObservedAtMonth,
      perceivedThreatAnimalIds: [],
      perceivedPreyIds: [],
      perceivedPersonIds: [],
    } : intent.mode === 'territory-return' ? {
      basis: 'territory-state',
      reachableOnly: false,
      radius: null,
      perceivedThreatAnimalIds: [],
      perceivedPreyIds: [],
      perceivedPersonIds: [],
    } : {
      basis: intent.mode === 'defend' ? 'month-opening-co-location' : 'local-reachable-perception',
      reachableOnly: true,
      radius: intent.mode === 'defend' ? 0
        : intent.mode === 'flee' ? HERBIVORE_DANGER_RADIUS
          : WOLF_PERCEPTION_RADIUS,
      perceivedThreatAnimalIds: intent.perceivedThreatAnimalIds ?? [],
      perceivedPreyIds: intent.perceivedPreyIds ?? [],
      perceivedPersonIds: intent.perceivedPersonIds ?? [],
    },
    territory: animal.ecology.territory ? { ...animal.ecology.territory, enforced: true } : null,
    pack: animal.ecology.packId ? {
      packId: animal.ecology.packId,
      cueSourceAnimalId: animal.ecology.lastSeenCue?.sourceAnimalId,
      cueExpiresAtMonth: animal.ecology.lastSeenCue?.expiresAtMonth,
      sharedWithinRadius: PACK_CUE_SHARE_RADIUS,
      sharingRenewsCue: false,
    } : null,
    targetSelection: intent.targetSelectionBasis ? {
      selectedPersonId: intent.targetPersonId,
      ...intent.targetSelectionBasis,
    } : intent.mode === 'hunt-prey' ? {
      selectedAnimalId: intent.targetAnimalId,
      candidateAnimalIds: intent.perceivedPreyIds ?? [],
      order: 'reachable-distance-asc,id-asc',
    } : intent.mode === 'pursue-human' && intent.sourceCueObservedAtMonth !== undefined ? {
      selectedPersonId: intent.targetPersonId,
      order: 'unexpired-pack-cue-observed-desc,source-id-asc,target-id-asc',
    } : intent.mode === 'flee' || intent.mode === 'avoid-humans' ? {
      selectedCellId: intent.targetCellId,
      order: 'minimum-threat-distance-desc,reachable-distance-desc,cell-id-asc',
    } : intent.mode === 'territory-return' ? {
      selectedCellId: intent.targetCellId,
      order: 'territory-anchor',
    } : null,
  };
}

function applyAnimalAttack(
  state: SimulationState,
  atMonth: number,
  events: EnvironmentFact[],
  animal: AnimalState,
  victim: PersonState,
  intent: WildlifeIntent,
  opening: WildlifeAnimalSnapshot,
): void {
  const species = animalSpecies(animal.speciesId);
  const chance = species.aggression / 180;
  if (seededFraction(state.seed, `predator-attack:${atMonth}:${animal.id}:${victim.id}`) >= chance) return;
  const damage = 6 + Math.floor(species.aggression / 11);
  const healthBefore = victim.body.health;
  victim.body.health = clamp(victim.body.health - damage);
  const wound = victim.conditions.find((condition) => condition.kind === 'wound');
  const woundStageBefore = wound?.stage ?? 0;
  if (wound) wound.stage = Math.min(3, wound.stage + 1) as 1 | 2 | 3;
  else victim.conditions.push({
    id: `condition-wound-animal-${victim.id}-${atMonth}`,
    kind: 'wound',
    stage: 2,
    sinceMonth: atMonth,
    sourceEventIds: [],
  });
  const fact = animalEvent(state, atMonth, events, animal, `${species.name}袭击${victim.name}并造成伤害`, {
    process: 'attack-human',
    victimId: victim.id,
    damage,
    healthBefore,
    healthAfter: victim.body.health,
    woundStageBefore,
    woundStageAfter: wound?.stage ?? 2,
    monthOpeningCoLocated: opening.cellId === victim.position.cellId && opening.z === victim.position.z,
    attackEligibility: 'month-opening-contact-only',
    targetSelection: intent.targetSelectionBasis ? {
      selectedPersonId: victim.id,
      ...intent.targetSelectionBasis,
    } : { selectedPersonId: victim.id, order: 'reachable-distance-asc,wound-desc,health-asc,visible-defense-asc,id-asc' },
    perception: {
      reachableOnly: true,
      radius: WOLF_PERCEPTION_RADIUS,
      perceivedPersonIds: intent.perceivedPersonIds ?? [],
    },
    territory: animal.ecology.territory ? { ...animal.ecology.territory, enforced: true } : null,
    packId: animal.ecology.packId,
  }, victim);
  const affectedWound = wound ?? victim.conditions.find((candidate) => candidate.id === `condition-wound-animal-${victim.id}-${atMonth}`);
  if (affectedWound) affectedWound.sourceEventIds = [...new Set([...affectedWound.sourceEventIds, fact.id])];
}

function applyBoarDefensiveAttack(
  state: SimulationState,
  atMonth: number,
  events: EnvironmentFact[],
  animal: AnimalState,
  victim: PersonState,
  intent: WildlifeIntent,
  opening: WildlifeAnimalSnapshot,
): void {
  const species = animalSpecies(animal.speciesId);
  const chance = species.aggression / 240;
  if (seededFraction(state.seed, `animal-attack:${atMonth}:${animal.id}:${victim.id}`) >= chance) return;
  const damage = 4 + Math.floor(species.aggression / 14);
  const healthBefore = victim.body.health;
  victim.body.health = clamp(victim.body.health - damage);
  const wound = victim.conditions.find((condition) => condition.kind === 'wound');
  const woundStageBefore = wound?.stage ?? 0;
  if (wound) wound.stage = Math.min(3, wound.stage + 1) as 1 | 2 | 3;
  else victim.conditions.push({
    id: `condition-wound-animal-${victim.id}-${atMonth}`,
    kind: 'wound',
    stage: 1,
    sinceMonth: atMonth,
    sourceEventIds: [],
  });
  const fact = animalEvent(state, atMonth, events, animal, `${species.name}在被近身时冲撞${victim.name}并造成伤害`, {
    process: 'attack-human',
    behavior: 'defensive-charge',
    victimId: victim.id,
    damage,
    healthBefore,
    healthAfter: victim.body.health,
    woundStageBefore,
    woundStageAfter: wound?.stage ?? 1,
    monthOpeningCoLocated: opening.cellId === victim.position.cellId && opening.z === victim.position.z,
    attackEligibility: 'month-opening-contact-only',
    pursuit: false,
    targetSelection: intent.targetSelectionBasis ? {
      selectedPersonId: victim.id,
      ...intent.targetSelectionBasis,
    } : { selectedPersonId: victim.id, order: 'reachable-distance-asc,wound-desc,health-asc,visible-defense-asc,id-asc' },
    perception: {
      reachableOnly: true,
      radius: 0,
      perceivedPersonIds: intent.perceivedPersonIds ?? [],
    },
  }, victim);
  const affectedWound = wound ?? victim.conditions.find((candidate) => candidate.id === `condition-wound-animal-${victim.id}-${atMonth}`);
  if (affectedWound) affectedWound.sourceEventIds = [...new Set([...affectedWound.sourceEventIds, fact.id])];
}

/**
 * Local threat ecology is resolved in phases: physiology, immutable opening
 * perception/intent, movement, then contacts and attacks. Stable ID ordering is
 * only a commit order and cannot change any animal's intent.
 */
export function advanceAnimals(state: SimulationState, atMonth: number, events: EnvironmentFact[]): void {
  normalizeAnimalEcologies(state.world.animals);
  const physiologicalOrder = state.world.animals.filter(isAnimalAlive)
    .sort((first, second) => first.id.localeCompare(second.id));
  for (const animal of physiologicalOrder) {
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
    if (animal.health <= 0) killAnimal(state, animal, atMonth, events, 'starvation');
  }

  const livingAtOpening = state.world.animals.filter(isAnimalAlive)
    .sort((first, second) => first.id.localeCompare(second.id));
  const animalSnapshots = livingAtOpening.map(wildlifeAnimalSnapshot);
  const peopleAtOpening = state.people.filter(isAlive).sort((first, second) => first.id.localeCompare(second.id));
  const personSnapshots = peopleAtOpening.map((person) => wildlifePersonSnapshot(
    person,
    Boolean(shelterGeometryAt(state.world.grid, person.position)),
  ));
  const openingAnimalById = new Map(animalSnapshots.map((animal) => [animal.id, animal]));
  const openingPersonById = new Map(personSnapshots.map((person) => [person.id, person]));

  const cues = synchronizeWolfPackCues(state, atMonth, animalSnapshots, personSnapshots);
  for (const animal of livingAtOpening.filter((candidate) => candidate.speciesId === 'wolf')) {
    const prior = animal.ecology.lastSeenCue;
    const next = cues.get(animal.id);
    if (next) animal.ecology.lastSeenCue = structuredClone(next);
    else delete animal.ecology.lastSeenCue;
    if (next && next.sourceAnimalId === animal.id
      && (!prior || prior.observedAtMonth !== next.observedAtMonth
        || prior.targetId !== next.targetId || prior.cellId !== next.cellId)) {
      animalEvent(state, atMonth, events, animal, `狼在局部可达范围内留下了一条直接目击线索`, {
        process: 'observe-last-seen-cue',
        intentPhase: 'month-opening-snapshot',
        targetKind: next.kind,
        targetId: next.targetId,
        targetCellId: next.cellId,
        observedAtMonth: next.observedAtMonth,
        expiresAtMonth: next.expiresAtMonth,
        perception: { reachableOnly: true, radius: WOLF_PERCEPTION_RADIUS },
        territory: animal.ecology.territory ? { ...animal.ecology.territory, enforced: true } : null,
        pack: { packId: animal.ecology.packId, sourceAnimalId: animal.id },
        targetSelection: {
          selectedPersonId: next.targetId,
          order: 'reachable-distance-asc,wound-desc,health-asc,visible-defense-asc,id-asc',
        },
      });
    } else if (next && next.sourceAnimalId !== animal.id
      && (!prior || prior.observedAtMonth !== next.observedAtMonth || prior.sourceAnimalId !== next.sourceAnimalId)) {
      animalEvent(state, atMonth, events, animal, `狼群成员共享了未续期的近距目击线索`, {
        process: 'share-pack-last-seen-cue',
        intentPhase: 'month-opening-snapshot',
        packId: animal.ecology.packId,
        receiverAnimalId: animal.id,
        sourceAnimalId: next.sourceAnimalId,
        targetKind: next.kind,
        targetId: next.targetId,
        targetCellId: next.cellId,
        observedAtMonth: next.observedAtMonth,
        expiresAtMonth: next.expiresAtMonth,
        shareRadius: PACK_CUE_SHARE_RADIUS,
        renewedBySharing: false,
        perception: { reachableOnly: true, radius: PACK_CUE_SHARE_RADIUS, sourceAnimalId: next.sourceAnimalId },
        territory: animal.ecology.territory ? { ...animal.ecology.territory, enforced: true } : null,
        targetSelection: {
          selectedPersonId: next.targetId,
          order: 'direct-source-only,cue-observed-desc,source-id-asc,target-id-asc',
        },
      });
    } else if (prior && !next) {
      animalEvent(state, atMonth, events, animal, `狼停止使用一条已经过期的最后目击线索`, {
        process: 'expire-last-seen-cue',
        expiredTargetKind: prior.kind,
        expiredTargetId: prior.targetId,
        expiredCellId: prior.cellId,
        observedAtMonth: prior.observedAtMonth,
        expiresAtMonth: prior.expiresAtMonth,
        expiredWithoutRenewal: true,
        packId: animal.ecology.packId,
      });
    }
  }

  const intents = planWildlifeIntents(state, atMonth, animalSnapshots, personSnapshots, cues);
  const intentByAnimalId = new Map(intents.map((intent) => [intent.animalId, intent]));

  // Movement phase: every target was frozen above, before any animal moved.
  for (const animal of livingAtOpening) {
    const intent = intentByAnimalId.get(animal.id);
    const opening = openingAnimalById.get(animal.id);
    if (!intent || !opening) continue;
    animal.ecology.currentBehavior = behaviorFromIntent(atMonth, intent);
    moveAnimal(state, animal, intent.targetCellId, atMonth);
    if (intent.mode === 'pursue-human'
      || intent.mode === 'flee'
      || intent.mode === 'defend'
      || intent.mode === 'avoid-humans'
      || intent.mode === 'territory-return'
      || intent.mode === 'hunt-prey') {
      animalEvent(state, atMonth, events, animal, intent.mode === 'pursue-human'
        ? intent.sourceCueObservedAtMonth !== undefined
          ? `${animalSpecies(animal.speciesId).name}基于未续期的狼群最后目击线索追踪一名人类`
          : `${animalSpecies(animal.speciesId).name}基于局部可达感知追踪一名人类`
        : intent.mode === 'flee'
          ? `${animalSpecies(animal.speciesId).name}从局部威胁旁逃离`
          : intent.mode === 'defend'
            ? `饥饿的野猪在被近身时作出防御性冲撞姿态`
            : intent.mode === 'avoid-humans'
              ? `低健康的狼避开了可见的持械人群`
              : intent.mode === 'territory-return'
                ? `狼转向自己的领地边界以内`
                : `狼追踪局部可达的自然猎物`,
      behaviorEventDiff(animal, intent, opening));
    }
  }

  // Settlement phase: contacts use final positions, but attack permission was
  // frozen from month-opening co-location and cannot be created by this move.
  for (const animal of livingAtOpening) {
    if (!isAnimalAlive(animal)) continue;
    const intent = intentByAnimalId.get(animal.id);
    const opening = openingAnimalById.get(animal.id);
    if (!intent || !opening) continue;
    const species = animalSpecies(animal.speciesId);
    if (species.diet === 'herbivore') {
      if (intent.mode === 'defend' && intent.attackEligiblePersonId) {
        const victim = state.people.find((person) => person.id === intent.attackEligiblePersonId && isAlive(person));
        const victimOpening = openingPersonById.get(intent.attackEligiblePersonId);
        if (victim && victimOpening
          && animal.position.cellId === victim.position.cellId
          && animal.position.z === victim.position.z
          && opening.cellId === victimOpening.cellId
          && opening.z === victimOpening.z
          && !shelterGeometryAt(state.world.grid, victim.position)) {
          applyBoarDefensiveAttack(state, atMonth, events, animal, victim, intent, opening);
        }
        continue;
      }
      const food = surfaceMaterial(state.world.grid, animal.position.cellId);
      if (wildlifeEdiblePlant(food) && animal.hunger >= 34) {
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
      continue;
    }

    if (intent.mode === 'hunt-prey' && intent.targetAnimalId) {
      const prey = state.world.animals.find((candidate) => candidate.id === intent.targetAnimalId && isAnimalAlive(candidate));
      if (prey && prey.position.cellId === animal.position.cellId && animal.hunger >= 45) {
        const chance = Math.min(0.82, 0.38 + (species.aggression - animalSpecies(prey.speciesId).evasion) / 180);
        if (seededFraction(state.seed, `animal-hunt:${atMonth}:${animal.id}:${prey.id}`) < chance) {
          killAnimal(state, prey, atMonth, events, 'predation', animal.id);
          animal.hunger = Math.max(0, animal.hunger - 72);
          animal.lastAteAtMonth = atMonth;
        }
      }
      continue;
    }

    if (intent.mode !== 'pursue-human' || !intent.targetPersonId) continue;
    const victim = state.people.find((person) => person.id === intent.targetPersonId && isAlive(person));
    const victimOpening = openingPersonById.get(intent.targetPersonId);
    if (!victim || !victimOpening || shelterGeometryAt(state.world.grid, victim.position)) continue;
    const reached = animal.position.cellId === victim.position.cellId && animal.position.z === victim.position.z;
    if (reached && opening.cellId !== victimOpening.cellId) {
      animal.ecology.pursuitContact = { targetPersonId: victim.id, atMonth, cellId: victim.position.cellId };
      animalEvent(state, atMonth, events, animal, `狼追到${victim.name}的近身位置，但本月只形成接触`, {
        process: 'pursuit-contact',
        targetPersonId: victim.id,
        intentPhase: 'month-opening-snapshot',
        contactPhase: 'post-movement-settlement',
        monthOpeningDistance: animalDistance(opening.cellId, victimOpening.cellId),
        attackAuthorizedThisMonth: false,
        nextMonthEscapeWindow: true,
        packId: animal.ecology.packId,
        territory: animal.ecology.territory ? { ...animal.ecology.territory, enforced: true } : null,
      }, victim);
    }
    if (reached && intent.attackEligiblePersonId === victim.id
      && opening.cellId === victimOpening.cellId && opening.z === victimOpening.z) {
      applyAnimalAttack(state, atMonth, events, animal, victim, intent, opening);
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
  const risk = load * 0.012 * injuryWorseningRiskMultiplier(person);
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
    const recovery = Math.min(1, (0.08 + (nourished ? 0.17 : 0) + (sheltered ? 0.12 : 0)) * injuryRecoveryMultiplier(person));
    if (seededFraction(state.seed, `condition-recover:${atMonth}:${person.id}:${current.id}`) < recovery) {
      if (current.stage > 1) current.stage = (current.stage - 1) as 1 | 2;
      else person.conditions = person.conditions.filter((item) => item.id !== current.id);
      event(state, atMonth, events, 'condition', `${person.name}的${current.kind === 'wound' ? '伤口' : '疾病'}有所恢复`, { condition: current.kind, stage: current.stage }, person);
    }
  }
  const wound = condition(state, person, 'wound');
  if (wound && !condition(state, person, 'illness')) {
    const infectionRisk = 0.018 * wound.stage * (person.body.nutrition < 35 ? 2 : 1) * injuryWorseningRiskMultiplier(person);
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

function newborn(state: SimulationState, mother: PersonState, fatherId: string, atMonth: number): { child: PersonState; inheritance: TraitBirthResult } {
  const id = `born-${atMonth}-${mother.id}-${state.people.length}`;
  const father = state.people.find((person) => person.id === fatherId);
  const sex = createBiologicalSex(state.seed, id);
  const inheritance = personTraitsAtBirth(state.seed, id, sex, mother, father);
  const namingSource = inheritance.matrilinealBirth ? mother : father ?? mother;
  const naming = createNewbornName(state.seed, id, sex, namingSource, state.people.map((person) => person.name));
  const geneticLoad = inheritedGeneticLoad(state, mother, father);
  const average = (field: keyof PersonState['baselineCapacities']) => Math.round((mother.baselineCapacities[field] + (father?.baselineCapacities[field] ?? mother.baselineCapacities[field])) / 2);
  const inheritedCapacity = (field: keyof PersonState['baselineCapacities']) => Math.max(20, average(field) - Math.round(geneticLoad * (5 + deterministicFraction(state.seed, `${id}:genetic:${field}`) * 7)));
  const baselineLifespan = createLifespanMonths(state.seed, id);
  const capacities = applyTraitCapacityModifiers({
    locomotion: inheritedCapacity('locomotion'), manipulation: inheritedCapacity('manipulation'), perception: inheritedCapacity('perception'),
    communication: inheritedCapacity('communication'), cognition: inheritedCapacity('cognition'),
  }, inheritance.traits);
  const child: PersonState = {
    id,
    name: naming.name,
    color: mother.color,
    profile: { description: `${mother.name}与${father?.name ?? '未知者'}的后代` },
    bornAtMonth: atMonth,
    lifespanMonths: applyTraitLifespanModifier(Math.max(36 * 12, Math.round(baselineLifespan * (1 - geneticLoad * 0.18))), inheritance.traits),
    sex,
    familyName: naming.familyName,
    namingTradition: naming.namingTradition,
    geneticParents: [mother.id, fatherId],
    generation: Math.max(mother.generation, father?.generation ?? 0) + 1,
    geneticLoad,
    traits: inheritance.traits,
    position: {
      cellId: mother.position.cellId,
      z: mother.position.z,
      previousCellId: mother.position.cellId,
      previousZ: mother.position.z,
      lastPath: [mother.position.cellId],
      tickPath: [mother.position.cellId],
    },
    body: { health: Math.max(48, 72 - Math.round(geneticLoad * 11)), hydration: 74, nutrition: 76 },
    baselineCapacities: capacities,
    personality: createPersonality(
      state.seed,
      id,
      [mother.personality, ...(father ? [father.personality] : [])],
    ),
    motiveSensitivity: createMotiveSensitivity(state.seed, id),
    cognition: createCognitionState(),
    conditions: [], inventory: [], knowledge: [], knownPlaces: [], memories: [],
    bereavements: [],
    relations: state.people.filter(isAlive).map((person) => ({ personId: person.id, trust: 0, bond: 0, fear: 0, sourceEventIds: [] })),
    currentActionText: '依赖身边人的照护', lastDecisionText: '尚不能独立决策',
  };
  return { child, inheritance };
}

export function pregnancyLossChance(person: Pick<PersonState, 'body'>, twinPregnancy: boolean): number {
  const severeBodyDeterioration = person.body.health < 18 || person.body.nutrition < 10;
  if (!severeBodyDeterioration && !twinPregnancy) return 0;
  return Math.min(0.75, (severeBodyDeterioration ? 0.28 : 0) * (twinPregnancy ? 1.5 : 1) + (twinPregnancy ? 0.015 : 0));
}

function recordNewborn(
  state: SimulationState,
  person: PersonState,
  father: PersonState | undefined,
  child: PersonState,
  inheritance: TraitBirthResult,
  atMonth: number,
  events: EnvironmentFact[],
  birth: {
    count: number;
    index: number;
    multipleBirthId?: string;
    twinTraitPersonIds: string[];
    recoveryMonths: number;
    recoveryUntilMonth?: number;
    postpartumSkippedByTrait: boolean;
  },
): EnvironmentFact {
  const parentalKinshipRisk = father ? geneticKinshipRisk(state, person, father) : 0;
  state.people.push(child);
  const multipleLabel = birth.count > 1 ? `（双胞胎第 ${birth.index} 个）` : '';
  const recoveryResult = birth.postpartumSkippedByTrait ? '，魅魔特质使其无需产后恢复' : '，进入产后恢复期';
  const fact = event(state, atMonth, events, 'body', `${person.name}生下了${child.name}${multipleLabel}${recoveryResult}`, {
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
    matrilinealBirth: inheritance.matrilinealBirth,
    namingParentId: inheritance.matrilinealBirth ? person.id : father?.id ?? person.id,
    inheritedTraits: child.traits?.filter((trait) => trait.origin === 'inherited').map((trait) => ({
      id: trait.id,
      name: traitDefinition(trait.id).name,
      inheritedFromPersonIds: trait.inheritedFromPersonIds,
      chance: trait.inheritanceChance,
      sample: trait.inheritanceSample,
    })) ?? [],
    spontaneousTraits: child.traits?.filter((trait) => trait.origin === 'spontaneous').map((trait) => ({
      id: trait.id,
      name: traitDefinition(trait.id).name,
      chance: trait.spontaneousChance,
      sample: trait.spontaneousSample,
    })) ?? [],
    traitInheritanceAttempts: inheritance.attempts,
    traitSpontaneousAttempts: inheritance.spontaneousAttempts,
    twinBirth: birth.count > 1,
    twinTraitPersonIds: birth.twinTraitPersonIds,
    ...(birth.multipleBirthId ? {
      multipleBirthId: birth.multipleBirthId,
      multipleBirthIndex: birth.index,
      multipleBirthCount: birth.count,
    } : {}),
    postpartumRecoveryMonths: birth.recoveryMonths,
    ...(birth.recoveryUntilMonth !== undefined ? { postpartumRecoveryUntilMonth: birth.recoveryUntilMonth } : {}),
    postpartumSkippedByTrait: birth.postpartumSkippedByTrait,
  }, person);
  bindTraitSource(child, fact.id);
  grantProphetKnowledge(child, atMonth, fact.id);
  if (child.geneticLoad >= 0.3) {
    for (const parent of state.people.filter((candidate) => child.geneticParents.includes(candidate.id) && sameLocation(candidate, child))) {
      learnFromInheritedOutcome(parent, child, atMonth, fact.id, 'birth');
    }
  }
  const locallyPerceivedPersonIds = state.people
    .filter((candidate) => candidate.id !== child.id && isAlive(candidate) && sameLocation(candidate, child))
    .map((candidate) => candidate.id)
    .sort();
  const locallyPerceivedPeople = new Set(locallyPerceivedPersonIds);
  const initialTrust = newbornInitialTrust(child);
  for (const relation of child.relations) {
    if (!locallyPerceivedPeople.has(relation.personId)) continue;
    relation.trust = initialTrust;
    relation.sourceEventIds = [...new Set([...relation.sourceEventIds, fact.id])];
  }
  fact.diff.initialSocialTrust = initialTrust;
  fact.diff.initialSocialTrustPersonIds = locallyPerceivedPersonIds;
  child.relations.forEach((relation) => {
    if (!child.geneticParents.includes(relation.personId)) return;
    relation.bond = inheritance.matrilinealBirth && relation.personId === person.id ? 18 : 12;
    relation.sourceEventIds = [...new Set([...relation.sourceEventIds, fact.id])];
  });
  for (const existing of state.people) {
    if (existing.id === child.id || existing.relations.some((relation) => relation.personId === child.id)) continue;
    const closeKin = child.geneticParents.includes(existing.id);
    existing.relations.push({
      personId: child.id,
      trust: 0,
      bond: closeKin ? (inheritance.matrilinealBirth && existing.id === person.id ? 18 : 12) : 0,
      fear: 0,
      sourceEventIds: closeKin ? [fact.id] : [],
    });
  }
  return fact;
}

function advancePregnancies(state: SimulationState, person: PersonState, atMonth: number, events: EnvironmentFact[]): void {
  const pregnancy = condition(state, person, 'pregnancy');
  if (!pregnancy?.dueAtMonth) return;
  const remaining = pregnancy.dueAtMonth - atMonth;
  pregnancy.stage = remaining <= 2 ? 3 : remaining <= 5 ? 2 : 1;
  const father = state.people.find((candidate) => candidate.id === pregnancy.otherPersonId);
  const twinTraitPersonIds = [person, ...(father ? [father] : [])]
    .filter((candidate) => hasTrait(candidate, 'twin-bearer'))
    .map((candidate) => candidate.id);
  const twinPregnancy = twinTraitPersonIds.length > 0;
  const lossChance = pregnancyLossChance(person, twinPregnancy);
  if (lossChance > 0) {
    const lossSample = seededFraction(state.seed, `pregnancy-loss:${atMonth}:${person.id}`);
    if (lossSample < lossChance) {
      person.conditions = person.conditions.filter((item) => item.id !== pregnancy.id);
      event(state, atMonth, events, 'condition', `${person.name}的妊娠过程${twinPregnancy ? '因双生负担与身体风险' : '因身体恶化'}而中止`, {
        pregnancyEnded: true,
        lossChance,
        lossSample,
        twinPregnancy,
        twinTraitPersonIds,
      }, person);
    }
  }
  if (person.body.health < 18 || person.body.nutrition < 10 || !person.conditions.includes(pregnancy)) {
    return;
  }
  if (atMonth < pregnancy.dueAtMonth) return;
  person.conditions = person.conditions.filter((item) => item.id !== pregnancy.id);
  const postpartumSkippedByTrait = hasTrait(person, 'succubus');
  const minimumReserve = Math.min(person.body.health, person.body.hydration, person.body.nutrition);
  const recoveryMonths = postpartumSkippedByTrait ? 0 : minimumReserve >= 70 ? 9 : minimumReserve >= 50 ? 12 : 15;
  const recoveryUntilMonth = postpartumSkippedByTrait ? undefined : atMonth + recoveryMonths;
  const birthCount = twinPregnancy ? 2 : 1;
  const multipleBirthId = twinPregnancy ? `multiple-birth:${pregnancy.id}:${atMonth}` : undefined;
  const birthFacts: EnvironmentFact[] = [];
  const bornChildren: PersonState[] = [];
  for (let index = 1; index <= birthCount; index += 1) {
    const { child, inheritance } = newborn(state, person, pregnancy.otherPersonId ?? 'unknown', atMonth);
    bornChildren.push(child);
    birthFacts.push(recordNewborn(state, person, father, child, inheritance, atMonth, events, {
      count: birthCount,
      index,
      multipleBirthId,
      twinTraitPersonIds,
      recoveryMonths,
      recoveryUntilMonth,
      postpartumSkippedByTrait,
    }));
  }
  if (!postpartumSkippedByTrait) {
    person.conditions.push({
      id: `condition-postpartum-recovery-${person.id}-${atMonth}`,
      kind: 'postpartum-recovery',
      stage: 3,
      sinceMonth: atMonth,
      endsAtMonth: recoveryUntilMonth,
      sourceEventIds: birthFacts.map((fact) => fact.id),
      otherPersonId: bornChildren[0]?.id,
    });
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

type DeathCause = 'body-failure' | 'aging-terminal' | 'triple-sun-vaporization';

function die(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
  events: EnvironmentFact[],
  cause: DeathCause,
  options: { sourceEventIds?: string[]; vaporized?: boolean } = {},
): void {
  const healthBeforeDeath = person.body.health;
  person.diedAtMonth = atMonth;
  person.body.health = 0;
  const deathEventId = `e-${atMonth}-environment-death-${events.length}`;
  state.world.remains ??= [];
  const destroyedInventory = options.vaporized
    ? person.inventory.map((stack) => ({
        stackId: stack.id,
        materialId: stack.materialId,
        quantity: stack.quantity,
        ...(stack.recordPayloadId ? { recordPayloadId: stack.recordPayloadId } : {}),
      }))
    : [];
  if (options.vaporized) {
    state.world.remains = state.world.remains.filter((remains) => remains.carriedByPersonId !== person.id);
  } else {
    for (const carried of state.world.remains.filter((remains) => remains.carriedByPersonId === person.id)) {
      carried.status = 'exposed';
      carried.position = { cellId: person.position.cellId, z: person.position.z };
      delete carried.carriedByPersonId;
    }
    for (const stack of person.inventory) {
      addDrop(
        state,
        stack.materialId,
        stack.quantity,
        person.position.cellId,
        atMonth,
        [...new Set([...stack.sourceEventIds, deathEventId])],
        `${person.id}-death`,
        stack.recordPayloadId,
        person.position.z,
        [`inventory:${person.id}:${stack.id}`, ...(stack.sourceLineageKeys ?? [])],
        person.id,
      );
    }
  }
  person.inventory = [];
  if (!options.vaporized && !state.world.remains.some((remains) => remains.personId === person.id)) state.world.remains.push({
    id: `remains:${person.id}`,
    personId: person.id,
    position: { cellId: person.position.cellId, z: person.position.z },
    status: 'exposed',
    createdAtMonth: atMonth,
    deathEventId,
    sourceEventIds: [deathEventId],
  });
  const dyingDuringHibernation = person.conditions.some((condition) => condition.kind === 'dehydrated-hibernation');
  const hibernationFailedIntentIds: string[] = [];
  const intent = person.activeIntentId ? intentById(state, person.activeIntentId) : undefined;
  const justRestoredAncestorIds = new Set<string>();
  let returnToIntentId = intent?.lastHibernationResumedAtMonth === atMonth ? intent.returnToIntentId : undefined;
  while (returnToIntentId && !justRestoredAncestorIds.has(returnToIntentId)) {
    const ancestor = intentById(state, returnToIntentId);
    if (!ancestor
      || ancestor.ownerId !== person.id
      || ancestor.status !== 'suspended'
      || ancestor.lastHibernationResumedAtMonth !== atMonth) break;
    justRestoredAncestorIds.add(ancestor.id);
    returnToIntentId = ancestor.returnToIntentId;
  }
  const dyingImmediatelyAfterHibernationRestore = justRestoredAncestorIds.size > 0;
  if (intent) {
    intent.status = 'failed';
    intent.blockedReason = options.vaporized
      ? '人物在三日凌空中汽化，无法继续原意图'
      : '人物已经死亡，无法继续原意图';
    recordIntentGoalOutcome(
      state,
      intent,
      intent.actionEventIds.length ? 'attempted-unmet' : 'not-evaluated',
      atMonth,
      [...new Set([...intent.actionEventIds, deathEventId])],
    );
    if (intent.returnToIntentId) {
      intent.returnOutcome = 'parent-unavailable';
      intent.returnResolvedAtMonth = atMonth;
    }
    if (dyingDuringHibernation || dyingImmediatelyAfterHibernationRestore) {
      hibernationFailedIntentIds.push(intent.id);
    }
  }
  for (const suspended of intentsOwnedBy(state, person.id).filter((candidate) => candidate.ownerId === person.id
    && candidate.status === 'suspended')) {
    const hibernationRelated = dyingDuringHibernation
      || Boolean(suspended.suspendedForHibernationConditionId)
      || justRestoredAncestorIds.has(suspended.id);
    suspended.status = 'failed';
    suspended.blockedReason = options.vaporized
      ? '人物在三日凌空中汽化，无法继续暂停意图'
      : hibernationRelated
      ? '人物在休眠 episode 完成恢复前已经死亡'
      : '人物已经死亡，无法继续暂停意图';
    recordIntentGoalOutcome(
      state,
      suspended,
      suspended.actionEventIds.length ? 'attempted-unmet' : 'not-evaluated',
      atMonth,
      [...new Set([...suspended.actionEventIds, deathEventId])],
    );
    if (suspended.returnToIntentId) {
      suspended.returnOutcome = 'parent-unavailable';
      suspended.returnResolvedAtMonth = atMonth;
    }
    delete suspended.suspendedForHibernationConditionId;
    delete suspended.suspendedAtMonth;
    delete suspended.suspendedByIntentId;
    if (hibernationRelated) hibernationFailedIntentIds.push(suspended.id);
  }
  delete person.activeIntentId;
  const causalConditions = person.conditions.flatMap((current) => current.sourceEventIds);
  const sourceEventIds = [...new Set([...causalConditions, ...(options.sourceEventIds ?? [])])].slice(-24);
  const deathFact = event(state, atMonth, events, 'death', options.vaporized
    ? `${person.name}在三日凌空中于第 ${atMonth} 月瞬间汽化，没有留下遗体或遗物`
    : `${person.name}在第 ${atMonth} 月死亡，遗体和私有背包留在原地`, {
    personId: person.id,
    ageMonths: atMonth - person.bornAtMonth,
    cause,
    healthBeforeDeath,
    sourceEventIds,
    ...(options.vaporized ? {
      vaporized: true,
      remainsCreated: false,
      destroyedInventory,
    } : {}),
    ...(hibernationFailedIntentIds.length
      ? { hibernationFailedIntentIds: [...new Set(hibernationFailedIntentIds)] }
      : {}),
  }, person);
  if (options.vaporized) deathFact.planningTick = 1;
  if (deathFact.id !== deathEventId) throw new Error('死亡事实与遗体来源事件顺序不一致');
}

function maintainHibernationIntentSuspension(
  state: SimulationState,
  person: PersonState,
  hibernationConditionId: string,
  atMonth: number,
): { intentId?: string; intentChainIds: string[]; newlySuspended: boolean } {
  const alreadySuspended = intentsOwnedBy(state, person.id).filter((intent) => intent.ownerId === person.id
    && intent.status === 'suspended'
    && intent.suspendedForHibernationConditionId === hibernationConditionId);
  if (alreadySuspended.length) {
    const leaf = alreadySuspended.find((intent) => !intent.suspendedByIntentId)
      ?? alreadySuspended[alreadySuspended.length - 1];
    if (leaf) leaf.suspendedAtMonth = atMonth;
    return {
      intentId: leaf?.id,
      intentChainIds: alreadySuspended.map((intent) => intent.id),
      newlySuspended: false,
    };
  }
  const activeCandidate = person.activeIntentId ? intentById(state, person.activeIntentId) : undefined;
  const active = activeCandidate?.ownerId === person.id && activeCandidate.status === 'active'
    ? activeCandidate
    : undefined;
  if (!active) return { intentChainIds: [], newlySuspended: false };
  active.status = 'suspended';
  const chain = [];
  let current: typeof active | undefined = active;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    current.suspendedForHibernationConditionId = hibernationConditionId;
    if (current.id === active.id) current.suspendedAtMonth = atMonth;
    chain.push(current);
    const parent: Intent | undefined = current.returnToIntentId
      ? intentById(state, current.returnToIntentId)
      : undefined;
    current = parent?.ownerId === person.id && parent.status === 'suspended' ? parent : undefined;
  }
  delete person.activeIntentId;
  return { intentId: active.id, intentChainIds: chain.map((intent) => intent.id), newlySuspended: true };
}

function restoreHibernationSuspendedIntent(
  state: SimulationState,
  person: PersonState,
  hibernationConditionId: string,
  atMonth: number,
): { intentId?: string; status?: string } {
  const suspendedChain = intentsOwnedBy(state, person.id).filter((candidate) => candidate.ownerId === person.id
    && candidate.status === 'suspended'
    && candidate.suspendedForHibernationConditionId === hibernationConditionId);
  const intent = suspendedChain.find((candidate) => !candidate.suspendedByIntentId)
    ?? suspendedChain[suspendedChain.length - 1];
  if (!intent) return {};
  for (const suspended of suspendedChain) {
    delete suspended.suspendedForHibernationConditionId;
    suspended.lastResumedAtMonth = atMonth;
    suspended.lastHibernationResumedAtMonth = atMonth;
    if (suspended.id === intent.id) delete suspended.suspendedAtMonth;
  }
  const project = intent.projectId ? projectById(state, intent.projectId) : undefined;
  if (!isAlive(person)) {
    intent.status = 'failed';
    intent.blockedReason = '人物在休眠恢复完成前已经死亡';
    recordIntentGoalOutcome(
      state,
      intent,
      intent.actionEventIds.length ? 'attempted-unmet' : 'not-evaluated',
      atMonth,
      [...new Set(intent.actionEventIds.length ? intent.actionEventIds : [intent.sourceDecisionEventId])],
    );
  } else if (project?.status === 'completed') {
    intent.status = 'completed';
    intent.progress = 1;
    recordIntentGoalOutcome(
      state,
      intent,
      'achieved',
      atMonth,
      [...new Set(project.completionEventIds.length ? project.completionEventIds : [intent.sourceDecisionEventId])],
    );
  } else if (project?.status === 'blocked') {
    intent.status = 'blocked';
    intent.blockedReason = project.blockedReason ?? '休眠期间项目已经阻塞';
    const sources = [...new Set([...intent.actionEventIds, ...project.failureEventIds])];
    recordIntentGoalOutcome(
      state,
      intent,
      sources.length ? 'attempted-unmet' : 'not-evaluated',
      atMonth,
      sources.length ? sources : [intent.sourceDecisionEventId],
    );
  } else if (project?.status === 'abandoned') {
    intent.status = 'abandoned';
    intent.blockedReason = project.blockedReason ?? '休眠期间项目已经放弃';
    recordIntentGoalOutcome(
      state,
      intent,
      intent.actionEventIds.length ? 'attempted-unmet' : 'not-evaluated',
      atMonth,
      [...new Set(intent.actionEventIds.length ? intent.actionEventIds : [intent.sourceDecisionEventId])],
    );
  } else if (intent.projectId && !project) {
    intent.status = 'abandoned';
    intent.blockedReason = '休眠期间项目已经不存在';
    recordIntentGoalOutcome(
      state,
      intent,
      'not-evaluated',
      atMonth,
      [intent.sourceDecisionEventId],
    );
  } else {
    intent.status = 'active';
    intent.lastResumedAtMonth = atMonth;
    person.activeIntentId = intent.id;
  }
  return { intentId: intent.id, status: intent.status };
}

/**
 * Advance the phase of an existing hibernation episode before anyone acts.
 * Legacy episodes have no phase field and therefore enter here as dormant.
 * Physical recovery remains action-owned; this transition never adds reserves.
 */
export function advanceHibernationRecoveryPhases(
  state: SimulationState,
  atMonth: number,
): EnvironmentFact[] {
  const events: EnvironmentFact[] = [];
  for (const person of state.people.filter(isAlive)) {
    const episode = person.conditions.find((current) => current.kind === 'dehydrated-hibernation');
    if (!episode) continue;
    const suspension = maintainHibernationIntentSuspension(state, person, episode.id, atMonth);
    const phase = hibernationPhase(episode);
    let result: string | undefined;
    let diff: Record<string, unknown> | undefined;
    if (state.civilization.epoch === 'chaotic' && phase === 'recovering') {
      const completedRecoverySourceEventIds = [...new Set(episode.recoverySourceEventIds ?? [])];
      episode.hibernationPhase = 'dormant';
      delete episode.recoveryStartedAtMonth;
      delete episode.recoverySourceEventIds;
      result = `${person.name}在新乱纪元中沿用原有脱水休眠 episode，再次转入低代谢休眠`;
      diff = {
        condition: 'dehydrated-hibernation',
        hibernationConditionId: episode.id,
        phaseFrom: 'recovering',
        phaseTo: 'dormant',
        continuedEpisode: true,
        originalSinceMonth: episode.sinceMonth,
        stage: episode.stage,
        recoverySourceEventIds: completedRecoverySourceEventIds,
        entryHydrationCost: 0,
        ...(suspension.intentId ? { suspendedIntentId: suspension.intentId } : {}),
        ...(suspension.intentChainIds.length > 1 ? { suspendedIntentChainIds: suspension.intentChainIds } : {}),
      };
    } else if (state.civilization.epoch === 'stable'
      && phase === 'dormant'
      && episode.sinceMonth < state.civilization.era.sinceMonth) {
      episode.hibernationPhase = 'recovering';
      episode.recoveryStartedAtMonth = atMonth;
      episode.recoverySourceEventIds = [];
      result = `${person.name}在恒纪元中从低代谢休眠转入受限恢复`;
      diff = {
        condition: 'dehydrated-hibernation',
        hibernationConditionId: episode.id,
        phaseFrom: 'dormant',
        phaseTo: 'recovering',
        originalSinceMonth: episode.sinceMonth,
        stage: episode.stage,
        reserveIncrease: 0,
        ...(suspension.intentId ? { suspendedIntentId: suspension.intentId } : {}),
        ...(suspension.intentChainIds.length > 1 ? { suspendedIntentChainIds: suspension.intentChainIds } : {}),
      };
    } else if (state.civilization.epoch === 'stable' && phase === 'recovering') {
      const minimumReserve = Math.min(person.body.health, person.body.hydration, person.body.nutrition);
      const recoverySourceEventIds = [...new Set(episode.recoverySourceEventIds ?? [])];
      if (minimumReserve >= HIBERNATION_RECOVERY_SAFE_RESERVE && recoverySourceEventIds.length > 0) {
        person.conditions = person.conditions.filter((current) => current.id !== episode.id);
        const restoration = restoreHibernationSuspendedIntent(state, person, episode.id, atMonth);
        result = `${person.name}依靠真实补水与进食恢复到安全储备，结束脱水休眠 episode`;
        diff = {
          condition: 'dehydrated-hibernation',
          hibernationConditionId: episode.id,
          exited: true,
          phaseFrom: 'recovering',
          minimumReserve,
          safeReserve: HIBERNATION_RECOVERY_SAFE_RESERVE,
          recoveryStartedAtMonth: episode.recoveryStartedAtMonth,
          recoverySourceEventIds,
          ...(restoration.intentId ? {
            restoredIntentId: restoration.intentId,
            restoredIntentStatus: restoration.status,
          } : {}),
        };
      }
    }
    if (!result && suspension.newlySuspended && suspension.intentId) {
      result = `${person.name}在脱水休眠 episode 中暂停当前意图，等待同一 episode 完成恢复`;
      diff = {
        condition: 'dehydrated-hibernation',
        hibernationConditionId: episode.id,
        hibernationPhase: phase,
        hibernationIntentSuspended: true,
        suspendedIntentId: suspension.intentId,
        ...(suspension.intentChainIds.length > 1 ? { suspendedIntentChainIds: suspension.intentChainIds } : {}),
      };
    }
    if (!result || !diff) continue;
    const fact: EnvironmentFact = {
      id: `e-${atMonth}-environment-hibernation-phase-${person.id}-${events.length}`,
      kind: 'environment',
      atMonth,
      orderInMonth: events.length,
      cellId: person.position.cellId,
      change: 'condition',
      who: person.id,
      result,
      diff,
    };
    events.push(fact);
  }
  return events;
}

/**
 * Capture hibernation entered during one of this month's planning ticks. This
 * runs after body/death settlement so a person who died this month cannot
 * leave a newly suspended orphan intent behind.
 */
export function synchronizeHibernationIntentSuspensions(
  state: SimulationState,
  atMonth: number,
): EnvironmentFact[] {
  const events: EnvironmentFact[] = [];
  for (const person of state.people.filter(isAlive)) {
    const episode = person.conditions.find((condition) => condition.kind === 'dehydrated-hibernation');
    if (!episode) continue;
    const suspension = maintainHibernationIntentSuspension(state, person, episode.id, atMonth);
    if (!suspension.newlySuspended || !suspension.intentId) continue;
    events.push({
      id: `e-${atMonth}-environment-hibernation-suspension-${person.id}`,
      kind: 'environment',
      atMonth,
      orderInMonth: events.length,
      cellId: person.position.cellId,
      change: 'condition',
      who: person.id,
      result: `${person.name}在本月进入脱水休眠后暂停当前意图`,
      diff: {
        condition: 'dehydrated-hibernation',
        hibernationConditionId: episode.id,
        hibernationPhase: hibernationPhase(episode),
        hibernationIntentSuspended: true,
        suspendedIntentId: suspension.intentId,
        ...(suspension.intentChainIds.length > 1
          ? { suspendedIntentChainIds: suspension.intentChainIds }
          : {}),
      },
    });
  }
  return events;
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
    const hibernating = Boolean(hibernationCondition && hibernationPhase(hibernationCondition) === 'dormant');
    const hibernationBodyBefore = hibernationCondition ? { ...person.body } : undefined;
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
    const coldTraitMultiplier = coldHarmMultiplier(person);
    const heatTraitMultiplier = heatHarmMultiplier(person);
    const coldLoad = climate.kind === 'cold'
      ? Math.max(0, climate.severity + weatherCold - shelterColdRelief - (fireProtected ? 2.2 : 0) - (clothed ? 0.9 : 0)) * hibernationRelief * coldTraitMultiplier
      : 0;
    const heatLoad = climate.kind === 'heat' || climate.kind === 'fire'
      ? Math.max(0, climate.severity + weatherHeat - heatReliefFromShelter + (fireProtected ? 0.6 : 0) + (clothed ? 0.25 : 0)) * hibernationRelief * heatTraitMultiplier
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
    const heatHydrationExtra = (heat ? 1.35 * ([1, 1.3, 1.7, 2.2][heat] - 1) : 0)
      + (weather.kind === 'drought' ? weather.intensity * 0.18 : 0);
    const coldNutritionExtra = cold ? 1.25 * ([1, 1.25, 1.5, 1.8][cold] - 1) * coldTraitMultiplier : 0;
    const hydrationCost = (hibernating
      ? HIBERNATION_HYDRATION_COST
      : 1.35 + heatHydrationExtra * heatHydrationMultiplier(person) + illness * 0.35 + pregnancy * 0.22 + postpartum * 0.12) * resourceCompetition;
    const nutritionCost = (hibernating
      ? HIBERNATION_NUTRITION_COST
      : 1.25 + coldNutritionExtra + illness * 0.38 + pregnancy * 0.28 + postpartum * 0.18)
      * resourceCompetition
      * nutritionMetabolicMultiplier(person);
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
      if (cold >= 3) healthDelta -= 2 * coldTraitMultiplier;
      if (heat >= 3) healthDelta -= 3 * heatTraitMultiplier;
      healthDelta -= Math.max(0, wound - 1) * 1.5 + Math.max(0, illness - 1) * 1.5;
      if (aging >= 2 && (person.body.hydration < 45 || person.body.nutrition < 45)) healthDelta -= aging === 3 ? 1.5 : 0.5;
      if (person.body.hydration >= 65 && person.body.nutrition >= 65 && (sheltered || fireProtected || climate.kind === 'temperate') && !wound && !illness) {
        healthDelta += 1.4 * (aging === 1 ? 0.9 : aging === 2 ? 0.65 : aging === 3 ? 0.3 : 1);
      }
    }
    person.body.health = clamp(person.body.health + healthDelta);
    if (hibernationCondition) {
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
      const suspendedIntents = intentsOwnedBy(state, person.id).filter((intent) => intent.ownerId === person.id
        && intent.status === 'suspended'
        && intent.suspendedForHibernationConditionId === hibernationCondition.id);
      const suspendedIntent = suspendedIntents.find((intent) => !intent.suspendedByIntentId)
        ?? suspendedIntents[suspendedIntents.length - 1];
      event(state, atMonth, events, 'body', `${person.name}结算了脱水休眠 episode 的本月身体代价`, {
        hibernationMonthlySettlement: true,
        hibernationConditionId: hibernationCondition.id,
        hibernationPhase: hibernationPhase(hibernationCondition),
        monthlyCostApplied: true,
        metabolicProfile: hibernating ? 'dormant' : 'awake-recovery',
        hydrationCost,
        nutritionCost,
        healthDelta,
        bodyBefore: hibernationBodyBefore,
        bodyAfter: { ...person.body },
        ...(suspendedIntent ? { suspendedIntentId: suspendedIntent.id } : {}),
      }, person);
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

/** Personality turns 3..5 nearby action ticks into replayable relationship evidence. */
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
  const sharedLivingAreaByPair = new Map(state.agreements
    .filter((agreement) => agreement.status === 'active' && agreement.proposal.kind === 'companion')
    .flatMap((agreement) => {
      const anchor = companionLivingAnchor(state, agreement);
      return anchor ? [[relationshipPairKey(agreement.partyIds[0]!, agreement.partyIds[1]!), anchor] as const] : [];
    }));
  const actionsByTick = new Map<number, ActionFact[]>();
  for (const fact of currentMonthEvents) {
    if (fact.kind !== 'action'
      || (fact.status !== 'completed' && fact.status !== 'progressed')
      || fact.action.kind === 'communicate'
      || !peopleById.has(fact.who)) continue;
    const actions = actionsByTick.get(fact.actionTick) ?? [];
    actions.push(fact);
    actionsByTick.set(fact.actionTick, actions);
  }
  const pairActivity = new Map<string, {
    first: PersonState;
    second: PersonState;
    ticks: Set<number>;
    sourceEventIds: Set<string>;
    cellId: number;
  }>();
  for (const actions of actionsByTick.values()) {
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
        const exactPlace = leftAction.toCellId === rightAction.toCellId && leftAction.toZ === rightAction.toZ;
        const livingAnchor = sharedLivingAreaByPair.get(pairKey);
        const sharedLivingPlace = Boolean(livingAnchor
          && positionWithinLivingArea({ cellId: leftAction.toCellId, z: leftAction.toZ }, livingAnchor)
          && positionWithinLivingArea({ cellId: rightAction.toCellId, z: rightAction.toZ }, livingAnchor));
        if (!exactPlace && !sharedLivingPlace) continue;
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
    const participants = [activity.first, activity.second].sort((left, right) => left.id.localeCompare(right.id));
    const relationshipDeltas = participants.map((observer) => {
      const other = participants.find((person) => person.id !== observer.id)!;
      const tickThreshold = sharedActivityTickThreshold(observer);
      const baseDelta = Math.floor(qualifyingTicks.length / tickThreshold);
      const youthTrustBonus = baseDelta > 0
        ? youthfulSharedActivityTrustBonus(ageMonths(observer, atMonth))
        : 0;
      return {
        observerId: observer.id,
        otherPersonId: other.id,
        tickThreshold,
        baseDelta,
        youthTrustBonus,
        trustDelta: baseDelta + youthTrustBonus,
        bondDelta: baseDelta,
      };
    });
    if (relationshipDeltas.every((delta) => delta.baseDelta <= 0)) continue;
    const mutualTrustDelta = Math.min(...relationshipDeltas.map((delta) => delta.trustDelta));
    const mutualBondDelta = Math.min(...relationshipDeltas.map((delta) => delta.bondDelta));
    const fact: EnvironmentFact = {
      id: `e-${atMonth}-environment-relationship-${facts.length}`,
      kind: 'environment',
      atMonth,
      orderInMonth: facts.length,
      cellId: activity.cellId,
      change: 'relationship',
      result: `${participants.map((person) => person.name).join('、')}本月共同活动 ${qualifyingTicks.length} 个规划刻度，按各自性格与年龄形成可追溯的共同经历`,
      diff: {
        process: 'shared-action-ticks',
        participantIds: participants.map((person) => person.id),
        qualifyingTicks,
        sharedActionTicks: qualifyingTicks.length,
        sourceEventIds: [...activity.sourceEventIds].sort(),
        relationshipDeltas,
        trustDelta: mutualTrustDelta,
        bondDelta: mutualBondDelta,
      },
    };
    for (const delta of relationshipDeltas) {
      if (delta.baseDelta <= 0) continue;
      const observer = participants.find((person) => person.id === delta.observerId)!;
      applyRelationEvidence(observer, delta.otherPersonId, fact.id, {
        trust: delta.trustDelta,
        bond: delta.bondDelta,
      });
    }
    facts.push(fact);
  }
  const establishedCompanions = state.agreements
    .filter((agreement) => agreement.status === 'active'
      && agreement.proposal.kind === 'companion'
      && agreement.companionEstablishedAtMonth !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const agreement of establishedCompanions) {
    const pairKey = relationshipPairKey(agreement.partyIds[0]!, agreement.partyIds[1]!);
    if (adversePairs.has(pairKey) || !companionSharesLivingArea(state, agreement)) continue;
    const lastCredited = Math.max(
      REQUIRED_SHARED_LIVING_MONTHS,
      agreement.lastCompanionRelationshipAtCoLocatedMonth ?? REQUIRED_SHARED_LIVING_MONTHS,
    );
    const uncreditedMonths = Math.max(0, agreement.coLocatedMonths - lastCredited);
    const relationshipDelta = Math.floor(uncreditedMonths / SHARED_LIVING_RELATION_EVIDENCE_INTERVAL_MONTHS);
    if (relationshipDelta <= 0) continue;
    const participants = agreement.partyIds
      .map((personId) => peopleById.get(personId))
      .filter((person): person is PersonState => Boolean(person))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (participants.length !== 2) continue;
    const creditedThrough = lastCredited + relationshipDelta * SHARED_LIVING_RELATION_EVIDENCE_INTERVAL_MONTHS;
    const sourceEventIds = [...agreement.sourceEventIds].slice(-24);
    const fact: EnvironmentFact = {
      id: `e-${atMonth}-environment-relationship-${facts.length}`,
      kind: 'environment',
      atMonth,
      orderInMonth: facts.length,
      cellId: companionLivingAnchor(state, agreement)?.cellId ?? participants[0].position.cellId,
      change: 'relationship',
      result: `${participants.map((person) => person.name).join('、')}继续履行共同生活约定，累计 ${agreement.coLocatedMonths} 个真实共同生活月`,
      diff: {
        process: 'persistent-shared-living',
        agreementId: agreement.id,
        participantIds: participants.map((person) => person.id),
        sharedLivingMonths: agreement.coLocatedMonths,
        creditedThroughSharedLivingMonth: creditedThrough,
        sourceEventIds,
        trustDelta: relationshipDelta,
        bondDelta: relationshipDelta,
      },
    };
    agreement.lastCompanionRelationshipAtCoLocatedMonth = creditedThrough;
    agreement.sourceEventIds = [...new Set([...agreement.sourceEventIds, fact.id])];
    applyRelationEvidence(participants[0], participants[1].id, fact.id, { trust: relationshipDelta, bond: relationshipDelta });
    applyRelationEvidence(participants[1], participants[0].id, fact.id, { trust: relationshipDelta, bond: relationshipDelta });
    facts.push(fact);
  }
  return facts;
}
