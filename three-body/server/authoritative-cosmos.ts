import type { CosmosSnapshot, EraKey, SkySample } from '../src/game/societyContract';
import {
  DEFAULT_PRESET,
  PRESETS,
  createSystem,
  maxRadiusFromCOM,
  planetStatus,
  rk4Step,
  stellarFlux,
  type SimSystem,
} from '../src/lib/threebody';

export const COSMOS_TIME_PER_MONTH = 0.8 / 12;
const COSMOS_INTEGRATION_STEP = 0.001;
const COSMOS_STEPS_PER_MONTH = Math.max(1, Math.round(COSMOS_TIME_PER_MONTH / COSMOS_INTEGRATION_STEP));

function nextRandom(state: { value: number }): number {
  let value = state.value >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.value = value >>> 0 || 0x6d2b79f5;
  return state.value / 0x1_0000_0000;
}

function eraKey(fate: ReturnType<typeof planetStatus>['fate'], flux: number): EraKey {
  if (fate !== 'chaotic') return fate;
  if (flux > 1.8) return 'chaotic-heat';
  if (flux < 0.45) return 'chaotic-cold';
  return 'chaotic';
}

function systemOf(snapshot: CosmosSnapshot): SimSystem {
  if (snapshot.state.length !== 16 || snapshot.masses.length !== 4) {
    throw new Error('权威宇宙快照维度无效');
  }
  return {
    state: Float64Array.from(snapshot.state),
    masses: Float64Array.from(snapshot.masses),
  };
}

function sampleAt(snapshot: CosmosSnapshot, system: SimSystem): {
  flux: number;
  nearestStarDistance: number;
  fate: EraKey;
} {
  const status = snapshot.extinct
    ? { fate: 'extinct' as const, nearestDist: planetStatus(system).nearestDist }
    : planetStatus(system);
  const flux = stellarFlux(system) / snapshot.fluxBase;
  return {
    flux,
    nearestStarDistance: status.nearestDist,
    fate: eraKey(status.fate, flux),
  };
}

export function createInitialAuthoritativeCosmos(
  seed: number,
  presetKey = DEFAULT_PRESET.key,
): { cosmosSnapshot: CosmosSnapshot; skySample: SkySample } {
  const preset = PRESETS.find((candidate) => candidate.key === presetKey) ?? DEFAULT_PRESET;
  const random = { value: (seed >>> 0) || 0x6d2b79f5 };
  const system = createSystem(preset, () => nextRandom(random));
  const hostMass = Math.max(...preset.masses);
  const cosmosSnapshot: CosmosSnapshot = {
    schemaVersion: 1,
    presetKey: preset.key,
    state: Array.from(system.state),
    masses: Array.from(system.masses),
    randomState: random.value,
    respawnSequence: 0,
    t: 0,
    viewR: 2.2,
    civilizations: 1,
    extinct: false,
    pendingCollapse: null,
    fluxBase: Math.pow(hostMass, 3.5) / (preset.planetR * preset.planetR),
    planetR: preset.planetR,
  };
  const observation = sampleAt(cosmosSnapshot, system);
  return {
    cosmosSnapshot,
    skySample: {
      fromTime: 0,
      toTime: 0,
      fluxMean: observation.flux,
      fluxMin: observation.flux,
      fluxMax: observation.flux,
      nearestStarDistance: observation.nearestStarDistance,
      fate: observation.fate,
    },
  };
}

/**
 * Advances the committed three-body snapshot by one civilization month.
 * Sampling and catastrophe detection happen on the same fixed RK4 steps as the
 * visual universe, but only the completed snapshot becomes authoritative.
 */
export function advanceAuthoritativeCosmosMonth(snapshot: CosmosSnapshot): {
  cosmosSnapshot: CosmosSnapshot;
  skySample: SkySample;
} {
  const system = systemOf(snapshot);
  const fromTime = snapshot.t;
  let nextTime = fromTime;
  let fluxMin = Number.POSITIVE_INFINITY;
  let fluxMax = Number.NEGATIVE_INFINITY;
  let fluxSum = 0;
  let samples = 0;
  let nearestStarDistance = 1;
  let fate: EraKey = snapshot.pendingCollapse ?? (snapshot.extinct ? 'extinct' : 'stable');
  let pendingCollapse = snapshot.pendingCollapse;
  let extinct = snapshot.extinct;

  const observe = () => {
    const observation = sampleAt({ ...snapshot, extinct }, system);
    fluxMin = Math.min(fluxMin, observation.flux);
    fluxMax = Math.max(fluxMax, observation.flux);
    fluxSum += observation.flux;
    samples += 1;
    nearestStarDistance = observation.nearestStarDistance;
    fate = observation.fate;
  };
  observe();

  if (!pendingCollapse) {
    for (let step = 0; step < COSMOS_STEPS_PER_MONTH; step += 1) {
      rk4Step(system, COSMOS_INTEGRATION_STEP);
      nextTime += COSMOS_INTEGRATION_STEP;
      observe();
      if (fate === 'burned' || fate === 'frozen') {
        if (maxRadiusFromCOM(system) > 10) {
          extinct = true;
          pendingCollapse = 'extinct';
          fate = 'extinct';
        } else {
          pendingCollapse = fate;
        }
        break;
      }
    }
  }

  const cosmosSnapshot: CosmosSnapshot = {
    ...snapshot,
    state: Array.from(system.state),
    masses: Array.from(system.masses),
    t: nextTime,
    extinct,
    pendingCollapse,
  };
  const fallbackFlux = stellarFlux(system) / snapshot.fluxBase;
  return {
    cosmosSnapshot,
    skySample: {
      fromTime,
      toTime: nextTime,
      fluxMean: samples ? fluxSum / samples : fallbackFlux,
      fluxMin: samples ? fluxMin : fallbackFlux,
      fluxMax: samples ? fluxMax : fallbackFlux,
      nearestStarDistance,
      fate,
    },
  };
}
