import type { ActionFact, EnvironmentFact, EraSchedule, SimulationState, WeatherKind } from '../model';
import type { PersonState } from '../person';
import { remember } from '../memory';
import { applyRelationEvidence } from '../relation';
import { retainedColdWorldEventsForLease, worldEventById } from '../event-index';
import { seededFraction } from '../../world/generator';
import { personById } from '../state-index';

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function pendingEraPredictionWakeLeaseKey(predictionId: string): string {
  return `gameplay:pending-era-prediction:${predictionId}:disputed-wake`;
}

function disputedWakeFactsForPendingPrediction(
  state: SimulationState,
  prediction: SimulationState['eraPredictions'][number],
): ActionFact[] {
  if ((state.world.historyCursor?.hotStartIndex ?? 0) > 0
    && prediction.sourceEventIds.some((eventId) => !worldEventById(state, eventId))) {
    throw new Error(`pending era prediction ${prediction.id} 缺少已验证来源事实`);
  }
  return [
    ...retainedColdWorldEventsForLease(state, pendingEraPredictionWakeLeaseKey(prediction.id)),
    ...state.world.past,
  ].filter((candidate): candidate is ActionFact => (
    candidate.kind === 'action'
      && candidate.status === 'completed'
      && candidate.action.kind === 'act'
      && candidate.action.operation === 'rehydrate'
      && candidate.diff.rehydrationBasis === 'disputed-pending-prediction'
      && candidate.diff.hibernationPredictionId === prediction.id
      && typeof candidate.diff.rehydratedPersonId === 'string'
  ));
}

function event(
  atMonth: number,
  events: EnvironmentFact[],
  change: EnvironmentFact['change'],
  result: string,
  diff: Record<string, unknown>,
  person?: PersonState,
): EnvironmentFact {
  const fact: EnvironmentFact = {
    id: `e-${atMonth}-environment-${change}-${events.length}`,
    kind: 'environment',
    atMonth,
    orderInMonth: events.length,
    cellId: person?.position.cellId ?? 0,
    change,
    ...(person ? { who: person.id } : {}),
    result,
    diff,
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

function chaoticClimate(
  seed: number,
  sequence: number,
  bias: SimulationState['civilization']['conditions']['climateBias'],
): EraSchedule['dominantClimate'] {
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
    ?? (epoch === 'stable'
      ? 1
      : Math.min(10, 3 + Math.floor(seededFraction(state.seed, `climate-severity:${scheduled.sequence}:${atMonth}`) * (5 + chaos * 3))));
  // Observed external epoch changes are historical facts. Keep eraTransition
  // reserved for the local schedule because prediction rules consume it.
  const epochChanged = previousEpoch !== epoch;
  const climateKindChanged = previousClimate.kind !== kind;
  const climateSeverityChanged = previousClimate.severity !== severity;
  const changed = climateKindChanged || climateSeverityChanged || epochChanged;
  state.civilization.epoch = epoch;
  state.civilization.climate = { kind, severity, sinceMonth: changed ? atMonth : previousClimate.sinceMonth };
  if (changed || atMonth === 1 || eraTransition) event(
    atMonth,
    events,
    'climate',
    `${eraTransition ? `${epoch === 'stable' ? '恒纪元' : '乱纪元'}开始；` : ''}本月地表处于${kind === 'temperate' ? '温和' : kind === 'cold' ? '寒冷' : kind === 'heat' ? '炎热' : '烈火'}环境`,
    {
      epoch,
      kind,
      severity,
      eraSequence: scheduled.sequence,
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
    event(atMonth, events, 'weather', `本月天气转为${WEATHER_LABEL[candidateKind]}`, {
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

export function advanceEraPredictions(
  state: SimulationState,
  atMonth: number,
  eraTransition: boolean,
): EnvironmentFact[] {
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
    const disputedWakes = disputedWakeFactsForPendingPrediction(state, prediction);
    prediction.status = correct ? 'correct' : 'incorrect';
    prediction.resolvedAtMonth = atMonth;
    prediction.errorMonths = errorMonths;
    const predictor = personById(state, prediction.predictorId);
    const fact = event(
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
    const chaosArrived = eraTransition
      && prediction.targetEpoch === 'chaotic'
      && state.civilization.epoch === 'chaotic';
    for (const wake of disputedWakes) {
      const rehydratedPersonId = wake.diff.rehydratedPersonId;
      if (typeof rehydratedPersonId !== 'string') continue;
      const sleeper = personById(state, rehydratedPersonId);
      const helper = personById(state, wake.who);
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
