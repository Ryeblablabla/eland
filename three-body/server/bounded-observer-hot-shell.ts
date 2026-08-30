import { isDeepStrictEqual } from 'node:util';

import type {
  CivilizationIndex,
  CivilizationIndexComponent,
  CivilizationDevelopmentObservation,
  DevelopmentEraKey,
  SimulationState,
} from '../src/game/eland/domain/model';

/**
 * Store-side profile only. Domain/application code must not import this module:
 * the compact values are a continuation shell, not new gameplay evidence.
 */
export const BOUNDED_OBSERVER_HOT_SHELL_PROFILE =
  'bounded-gameplay-hot-observer-v2' as const;
export const BOUNDED_OBSERVER_HOT_SHELL_VERSION = 2 as const;
export const MAX_BOUNDED_OBSERVER_STAGE_UTF8_BYTES = 4 * 1_024;
export const MAX_BOUNDED_OBSERVER_FORMULA_VERSION_UTF8_BYTES = 256;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const EPOCHS = new Set(['stable', 'chaotic']);
const CLIMATES = new Set(['temperate', 'cold', 'heat', 'fire']);
const WEATHERS = new Set(['clear', 'rain', 'storm', 'drought', 'snow', 'fog']);
const CLIMATE_BIASES = new Set(['balanced', 'cold', 'hot']);
const OUTCOME_KINDS = new Set(['destroyed', 'boundary', 'milestones', 'concluded']);
const COMPONENT_KEYS = [
  'population',
  'territory',
  'technology',
  'social',
  'history',
] as const;
const DEVELOPMENT_ERAS = new Set<DevelopmentEraKey>([
  'primitive-tribe',
  'agrarian-settlement',
  'ancient-civilization',
  'modern-civilization',
  'medieval',
]);
const DEVELOPMENT_OBSERVER_VERSIONS = new Set<CivilizationDevelopmentObservation['observerVersion']>([
  'material-institution-era-v1',
  'material-institution-era-v2',
  'material-institution-era-v3',
  'material-institution-era-v4',
  'material-institution-era-v5',
  'material-institution-era-v6',
  'material-institution-era-v7',
]);

type CivilizationState = SimulationState['civilization'];
type PersistedObservations = SimulationState['derived'];

export interface ObserverHotShellSource {
  readonly stateHash: string;
  readonly revision: number;
  readonly month: number;
}

export interface CanonicalHotCivilizationIndexComponent {
  score: number;
  weight: number;
  evidence: Record<string, never>;
}

export interface CanonicalHotCivilizationIndex {
  formulaVersion?: string;
  total: number;
  calculatedAtMonth: number;
  components: {
    population: CanonicalHotCivilizationIndexComponent;
    territory: CanonicalHotCivilizationIndexComponent;
    technology: CanonicalHotCivilizationIndexComponent;
    social: CanonicalHotCivilizationIndexComponent;
    history: CanonicalHotCivilizationIndexComponent;
  };
}

export type CanonicalGameplayHotCivilization = Omit<
  CivilizationState,
  'civilizationIndex' | 'development'
> & {
  civilizationIndex: CanonicalHotCivilizationIndex;
  development?: never;
};

export interface CanonicalGameplayHotDerived {
  practices: [];
  institutions: [];
  milestones: [];
  regions: [];
  structures: [];
  functionalBuildings?: never;
}

export interface LastMaterializedObserverBasisV1 {
  readonly version: 1;
  readonly profile: 'bounded-gameplay-hot-observer-v1';
  readonly source: Readonly<ObserverHotShellSource>;
  readonly milestoneCount: number;
  readonly stage: string;
  readonly indexSnapshot: Readonly<CanonicalHotCivilizationIndex>;
}

/**
 * Only the previous-observation scalars read by the era stability observer.
 * Gate lists, event witnesses and material capability evidence are rebuilt at
 * an observer boundary and therefore remain outside the gameplay hot shell.
 */
export interface CanonicalDevelopmentStabilitySnapshot {
  readonly observerVersion: CivilizationDevelopmentObservation['observerVersion'];
  readonly currentEra: DevelopmentEraKey;
  readonly historicalPeakEra: DevelopmentEraKey;
  readonly candidateEra: DevelopmentEraKey;
  readonly candidateSinceMonth: number;
}

export interface LastMaterializedObserverBasisV2 {
  readonly version: typeof BOUNDED_OBSERVER_HOT_SHELL_VERSION;
  readonly profile: typeof BOUNDED_OBSERVER_HOT_SHELL_PROFILE;
  readonly source: Readonly<ObserverHotShellSource>;
  readonly milestoneCount: number;
  readonly stage: string;
  readonly indexSnapshot: Readonly<CanonicalHotCivilizationIndex>;
  readonly developmentSnapshot: Readonly<CanonicalDevelopmentStabilitySnapshot> | null;
}

export type LastMaterializedObserverBasis = LastMaterializedObserverBasisV1
  | LastMaterializedObserverBasisV2;

export interface BoundedObserverHotShell {
  readonly civilization: CanonicalGameplayHotCivilization;
  readonly derived: CanonicalGameplayHotDerived;
  readonly lastMaterializedObserverBasis: Readonly<LastMaterializedObserverBasis>;
}

export interface BoundedObserverHotShellInput {
  readonly civilization: Readonly<CivilizationState>;
  readonly source: Readonly<ObserverHotShellSource>;
  /** Store/CAS-selected count from the exact last materialized observer basis. */
  readonly lastMaterializedMilestoneCount: number;
  /** Preserve an already sealed basis when reopening a compact continuation root. */
  readonly lastMaterializedObserverBasis?: Readonly<LastMaterializedObserverBasis>;
}

export interface BoundedObserverHotShellFromExactObservationsInput {
  readonly civilization: Readonly<CivilizationState>;
  readonly derived: Readonly<PersistedObservations>;
  readonly source: Readonly<ObserverHotShellSource>;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label}必须是 plain object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new Error(`${label}包含未知字段 ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label}.${key}必须是 enumerable data property`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`${label}缺少字段 ${key}`);
    }
  }
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label}必须是有限数字`);
  }
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label}必须是非负安全整数`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label}必须是非空字符串`);
  }
}

function assertValidUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new Error(`${label}包含未配对 UTF-16 surrogate`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error(`${label}包含未配对 UTF-16 surrogate`);
    }
  }
}

function assertUtf8BoundedString(
  value: unknown,
  maximumBytes: number,
  label: string,
): asserts value is string {
  assertNonEmptyString(value, label);
  assertValidUnicode(value, label);
  const byteLength = new TextEncoder().encode(value).byteLength;
  if (byteLength > maximumBytes) {
    throw new Error(`${label}超过 UTF-8 ${maximumBytes} 字节硬上限`);
  }
}

function assertMember(value: unknown, members: ReadonlySet<string>, label: string): asserts value is string {
  if (typeof value !== 'string' || !members.has(value)) {
    throw new Error(`${label}枚举值无效`);
  }
}

function assertSource(value: unknown): asserts value is ObserverHotShellSource {
  const source = requiredRecord(value, 'observer hot shell source');
  assertExactKeys(source, ['stateHash', 'revision', 'month'], [], 'observer hot shell source');
  if (typeof source.stateHash !== 'string' || !SHA256_PATTERN.test(source.stateHash)) {
    throw new Error('observer hot shell source.stateHash 必须是小写 SHA-256');
  }
  assertNonNegativeSafeInteger(source.revision, 'observer hot shell source.revision');
  assertNonNegativeSafeInteger(source.month, 'observer hot shell source.month');
}

function assertEra(value: unknown): void {
  const era = requiredRecord(value, 'civilization.era');
  assertExactKeys(
    era,
    ['sequence', 'kind', 'sinceMonth', 'endsAtMonth', 'dominantClimate'],
    [],
    'civilization.era',
  );
  assertNonNegativeSafeInteger(era.sequence, 'civilization.era.sequence');
  assertMember(era.kind, EPOCHS, 'civilization.era.kind');
  assertNonNegativeSafeInteger(era.sinceMonth, 'civilization.era.sinceMonth');
  assertNonNegativeSafeInteger(era.endsAtMonth, 'civilization.era.endsAtMonth');
  if (era.endsAtMonth < era.sinceMonth) {
    throw new Error('civilization.era.endsAtMonth 不能早于 sinceMonth');
  }
  assertMember(era.dominantClimate, CLIMATES, 'civilization.era.dominantClimate');
}

function assertClimate(value: unknown): void {
  const climate = requiredRecord(value, 'civilization.climate');
  assertExactKeys(climate, ['kind', 'severity', 'sinceMonth'], [], 'civilization.climate');
  assertMember(climate.kind, CLIMATES, 'civilization.climate.kind');
  assertFiniteNumber(climate.severity, 'civilization.climate.severity');
  assertNonNegativeSafeInteger(climate.sinceMonth, 'civilization.climate.sinceMonth');
}

function assertWeather(value: unknown): void {
  const weather = requiredRecord(value, 'civilization.weather');
  assertExactKeys(weather, ['kind', 'intensity', 'sinceMonth'], [], 'civilization.weather');
  assertMember(weather.kind, WEATHERS, 'civilization.weather.kind');
  assertFiniteNumber(weather.intensity, 'civilization.weather.intensity');
  assertNonNegativeSafeInteger(weather.sinceMonth, 'civilization.weather.sinceMonth');
}

function assertExternalClimate(value: unknown): void {
  const external = requiredRecord(value, 'civilization.externalClimate');
  assertExactKeys(
    external,
    ['epoch', 'kind', 'severity'],
    ['terminalCatastrophe'],
    'civilization.externalClimate',
  );
  assertMember(external.epoch, EPOCHS, 'civilization.externalClimate.epoch');
  assertMember(external.kind, CLIMATES, 'civilization.externalClimate.kind');
  assertFiniteNumber(external.severity, 'civilization.externalClimate.severity');
  if (external.terminalCatastrophe !== undefined
    && external.terminalCatastrophe !== 'triple-sun-vaporization') {
    throw new Error('civilization.externalClimate.terminalCatastrophe 无效');
  }
}

function assertExternalEraRegime(value: unknown): void {
  const regime = requiredRecord(value, 'civilization.externalEraRegime');
  assertExactKeys(
    regime,
    ['sinceMonth', 'candidateEpoch', 'candidateSinceMonth', 'candidateConsecutiveMonths'],
    [],
    'civilization.externalEraRegime',
  );
  assertNonNegativeSafeInteger(regime.sinceMonth, 'civilization.externalEraRegime.sinceMonth');
  if (regime.candidateEpoch !== null) {
    assertMember(regime.candidateEpoch, EPOCHS, 'civilization.externalEraRegime.candidateEpoch');
  }
  assertNonNegativeSafeInteger(
    regime.candidateSinceMonth,
    'civilization.externalEraRegime.candidateSinceMonth',
  );
  assertNonNegativeSafeInteger(
    regime.candidateConsecutiveMonths,
    'civilization.externalEraRegime.candidateConsecutiveMonths',
  );
}

function assertConditions(value: unknown): void {
  const conditions = requiredRecord(value, 'civilization.conditions');
  assertExactKeys(
    conditions,
    ['civilizationNo', 'climateBias', 'chaosIntensity', 'endpoint'],
    ['characterIds'],
    'civilization.conditions',
  );
  assertNonNegativeSafeInteger(conditions.civilizationNo, 'civilization.conditions.civilizationNo');
  assertMember(conditions.climateBias, CLIMATE_BIASES, 'civilization.conditions.climateBias');
  assertFiniteNumber(conditions.chaosIntensity, 'civilization.conditions.chaosIntensity');
  const endpoint = requiredRecord(conditions.endpoint, 'civilization.conditions.endpoint');
  assertExactKeys(endpoint, ['kind', 'value'], [], 'civilization.conditions.endpoint');
  if (endpoint.kind !== 'months' && endpoint.kind !== 'milestones') {
    throw new Error('civilization.conditions.endpoint.kind 无效');
  }
  assertNonNegativeSafeInteger(endpoint.value, 'civilization.conditions.endpoint.value');
  if (conditions.characterIds !== undefined) {
    if (!Array.isArray(conditions.characterIds)
      || conditions.characterIds.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new Error('civilization.conditions.characterIds 无效');
    }
  }
}

function assertOutcome(value: unknown): void {
  const outcome = requiredRecord(value, 'civilization.outcome');
  assertExactKeys(outcome, ['kind', 'cause', 'atMonth', 'summary'], [], 'civilization.outcome');
  assertMember(outcome.kind, OUTCOME_KINDS, 'civilization.outcome.kind');
  assertNonEmptyString(outcome.cause, 'civilization.outcome.cause');
  assertValidUnicode(outcome.cause, 'civilization.outcome.cause');
  assertNonNegativeSafeInteger(outcome.atMonth, 'civilization.outcome.atMonth');
  assertNonEmptyString(outcome.summary, 'civilization.outcome.summary');
  assertValidUnicode(outcome.summary, 'civilization.outcome.summary');
}

function assertIndexComponent(value: unknown, label: string, requireEmptyEvidence: boolean): void {
  const component = requiredRecord(value, label);
  assertExactKeys(component, ['score', 'weight', 'evidence'], [], label);
  assertFiniteNumber(component.score, `${label}.score`);
  assertFiniteNumber(component.weight, `${label}.weight`);
  const evidence = requiredRecord(component.evidence, `${label}.evidence`);
  if (requireEmptyEvidence && Reflect.ownKeys(evidence).length !== 0) {
    throw new Error(`${label}.evidence 必须为空`);
  }
  for (const [key, evidenceValue] of Object.entries(evidence)) {
    if (key.length === 0) throw new Error(`${label}.evidence key 不能为空`);
    assertFiniteNumber(evidenceValue, `${label}.evidence.${key}`);
  }
}

function assertCivilizationIndex(value: unknown, requireEmptyEvidence: boolean): void {
  const index = requiredRecord(value, 'civilization.civilizationIndex');
  assertExactKeys(
    index,
    ['total', 'calculatedAtMonth', 'components'],
    ['formulaVersion'],
    'civilization.civilizationIndex',
  );
  if (index.formulaVersion !== undefined) {
    assertUtf8BoundedString(
      index.formulaVersion,
      MAX_BOUNDED_OBSERVER_FORMULA_VERSION_UTF8_BYTES,
      'civilization.civilizationIndex.formulaVersion',
    );
  }
  assertFiniteNumber(index.total, 'civilization.civilizationIndex.total');
  assertNonNegativeSafeInteger(
    index.calculatedAtMonth,
    'civilization.civilizationIndex.calculatedAtMonth',
  );
  const components = requiredRecord(index.components, 'civilization.civilizationIndex.components');
  assertExactKeys(
    components,
    COMPONENT_KEYS,
    [],
    'civilization.civilizationIndex.components',
  );
  for (const key of COMPONENT_KEYS) {
    assertIndexComponent(
      components[key],
      `civilization.civilizationIndex.components.${key}`,
      requireEmptyEvidence,
    );
  }
}

function assertDevelopmentStabilitySnapshot(
  value: unknown,
  sourceMonth: number,
): asserts value is CanonicalDevelopmentStabilitySnapshot {
  const snapshot = requiredRecord(value, 'development stability snapshot');
  assertExactKeys(
    snapshot,
    ['observerVersion', 'currentEra', 'historicalPeakEra', 'candidateEra', 'candidateSinceMonth'],
    [],
    'development stability snapshot',
  );
  assertMember(
    snapshot.observerVersion,
    DEVELOPMENT_OBSERVER_VERSIONS,
    'development stability snapshot.observerVersion',
  );
  assertMember(snapshot.currentEra, DEVELOPMENT_ERAS, 'development stability snapshot.currentEra');
  assertMember(
    snapshot.historicalPeakEra,
    DEVELOPMENT_ERAS,
    'development stability snapshot.historicalPeakEra',
  );
  assertMember(snapshot.candidateEra, DEVELOPMENT_ERAS, 'development stability snapshot.candidateEra');
  assertNonNegativeSafeInteger(
    snapshot.candidateSinceMonth,
    'development stability snapshot.candidateSinceMonth',
  );
  if (snapshot.candidateSinceMonth > sourceMonth) {
    throw new Error('development stability snapshot.candidateSinceMonth 来自未来月份');
  }
}

function assertCivilization(value: unknown, canonical: boolean): asserts value is CivilizationState {
  const civilization = requiredRecord(value, 'civilization');
  assertExactKeys(
    civilization,
    ['number', 'status', 'stage', 'epoch', 'era', 'climate', 'weather', 'conditions', 'civilizationIndex'],
    canonical
      ? ['externalClimate', 'externalEraRegime', 'outcome']
      : ['externalClimate', 'externalEraRegime', 'development', 'outcome'],
    'civilization',
  );
  assertNonNegativeSafeInteger(civilization.number, 'civilization.number');
  if (civilization.status !== 'running' && civilization.status !== 'ended') {
    throw new Error('civilization.status 无效');
  }
  assertUtf8BoundedString(
    civilization.stage,
    MAX_BOUNDED_OBSERVER_STAGE_UTF8_BYTES,
    'civilization.stage',
  );
  assertMember(civilization.epoch, EPOCHS, 'civilization.epoch');
  assertEra(civilization.era);
  assertClimate(civilization.climate);
  assertWeather(civilization.weather);
  if (civilization.externalClimate !== undefined) {
    assertExternalClimate(civilization.externalClimate);
  }
  if (civilization.externalEraRegime !== undefined) {
    assertExternalEraRegime(civilization.externalEraRegime);
  }
  assertConditions(civilization.conditions);
  assertCivilizationIndex(civilization.civilizationIndex, canonical);
  if (civilization.outcome !== undefined) assertOutcome(civilization.outcome);
}

function assertDerived(value: unknown, canonical: boolean): asserts value is PersistedObservations {
  const derived = requiredRecord(value, 'derived');
  assertExactKeys(
    derived,
    ['practices', 'institutions', 'milestones', 'regions', 'structures'],
    canonical ? [] : ['functionalBuildings'],
    'derived',
  );
  for (const key of ['practices', 'institutions', 'milestones', 'regions', 'structures'] as const) {
    if (!Array.isArray(derived[key])) throw new Error(`derived.${key}必须是数组`);
    if (canonical && derived[key].length !== 0) throw new Error(`derived.${key}必须为空`);
  }
  if (!canonical && derived.functionalBuildings !== undefined
    && !Array.isArray(derived.functionalBuildings)) {
    throw new Error('derived.functionalBuildings 必须是数组');
  }
}

function compactIndex(index: CivilizationIndex): CanonicalHotCivilizationIndex {
  const component = (value: CivilizationIndexComponent): CanonicalHotCivilizationIndexComponent => ({
    score: value.score,
    weight: value.weight,
    evidence: {},
  });
  return {
    ...(index.formulaVersion === undefined ? {} : { formulaVersion: index.formulaVersion }),
    total: index.total,
    calculatedAtMonth: index.calculatedAtMonth,
    components: {
      population: component(index.components.population),
      territory: component(index.components.territory),
      technology: component(index.components.technology),
      social: component(index.components.social),
      history: component(index.components.history),
    },
  };
}

function cloneGameplayCivilization(
  civilization: CivilizationState,
  civilizationIndex: CanonicalHotCivilizationIndex,
): CanonicalGameplayHotCivilization {
  return {
    number: civilization.number,
    status: civilization.status,
    stage: civilization.stage,
    epoch: civilization.epoch,
    era: { ...civilization.era },
    climate: { ...civilization.climate },
    weather: { ...civilization.weather },
    ...(civilization.externalClimate === undefined
      ? {}
      : { externalClimate: { ...civilization.externalClimate } }),
    ...(civilization.externalEraRegime === undefined
      ? {}
      : { externalEraRegime: { ...civilization.externalEraRegime } }),
    conditions: {
      civilizationNo: civilization.conditions.civilizationNo,
      climateBias: civilization.conditions.climateBias,
      chaosIntensity: civilization.conditions.chaosIntensity,
      endpoint: { ...civilization.conditions.endpoint },
      ...(civilization.conditions.characterIds === undefined
        ? {}
        : { characterIds: [...civilization.conditions.characterIds] }),
    },
    civilizationIndex,
    ...(civilization.outcome === undefined ? {} : { outcome: { ...civilization.outcome } }),
  };
}

function gameplayCivilizationSnapshot(civilization: CivilizationState | CanonicalGameplayHotCivilization) {
  return {
    number: civilization.number,
    status: civilization.status,
    stage: civilization.stage,
    epoch: civilization.epoch,
    era: civilization.era,
    climate: civilization.climate,
    weather: civilization.weather,
    externalClimate: civilization.externalClimate,
    externalEraRegime: civilization.externalEraRegime,
    conditions: civilization.conditions,
    outcome: civilization.outcome,
  };
}

function deepFreeze<T>(value: T, visited = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object') return value;
  const object = value as object;
  if (visited.has(object)) return value;
  visited.add(object);
  for (const child of Object.values(object as Record<string, unknown>)) deepFreeze(child, visited);
  return Object.freeze(value);
}

/** Fail closed if any gameplay-owned civilization field changed during compaction. */
export function assertGameplayCivilizationPreserved(
  exact: Readonly<CivilizationState>,
  canonical: Readonly<CanonicalGameplayHotCivilization>,
): void {
  assertCivilization(exact, false);
  assertCivilization(canonical, true);
  if (!isDeepStrictEqual(
    gameplayCivilizationSnapshot(exact),
    gameplayCivilizationSnapshot(canonical),
  )) {
    throw new Error('bounded observer hot shell 改写了 gameplay civilization 字段');
  }
}

export function assertLastMaterializedObserverBasis(
  value: unknown,
): asserts value is LastMaterializedObserverBasis {
  const basis = requiredRecord(value, 'last materialized observer basis');
  const legacy = basis.version === 1 && basis.profile === 'bounded-gameplay-hot-observer-v1';
  const current = basis.version === BOUNDED_OBSERVER_HOT_SHELL_VERSION
    && basis.profile === BOUNDED_OBSERVER_HOT_SHELL_PROFILE;
  if (!legacy && !current) {
    throw new Error('last materialized observer basis version/profile 无效');
  }
  assertExactKeys(
    basis,
    ['version', 'profile', 'source', 'milestoneCount', 'stage', 'indexSnapshot'],
    current ? ['developmentSnapshot'] : [],
    'last materialized observer basis',
  );
  assertSource(basis.source);
  assertNonNegativeSafeInteger(basis.milestoneCount, 'last materialized observer basis.milestoneCount');
  assertUtf8BoundedString(
    basis.stage,
    MAX_BOUNDED_OBSERVER_STAGE_UTF8_BYTES,
    'last materialized observer basis.stage',
  );
  assertCivilizationIndex(basis.indexSnapshot, true);
  const snapshot = basis.indexSnapshot as CanonicalHotCivilizationIndex;
  const source = basis.source as ObserverHotShellSource;
  if (snapshot.calculatedAtMonth > source.month) {
    throw new Error('last materialized observer basis indexSnapshot 来自未来月份');
  }
  if (current) {
    if (!Object.prototype.hasOwnProperty.call(basis, 'developmentSnapshot')) {
      throw new Error('last materialized observer basis v2 缺少 developmentSnapshot');
    }
    if (basis.developmentSnapshot !== null) {
      assertDevelopmentStabilitySnapshot(basis.developmentSnapshot, source.month);
    }
  }
}

/**
 * Canonical shape check for store integration and persistence codecs. It proves
 * compactness and internal basis equality, not authority over an exact run root.
 */
export function assertCanonicalBoundedObserverHotShell(
  value: unknown,
): asserts value is BoundedObserverHotShell {
  const shell = requiredRecord(value, 'bounded observer hot shell');
  assertExactKeys(
    shell,
    ['civilization', 'derived', 'lastMaterializedObserverBasis'],
    [],
    'bounded observer hot shell',
  );
  assertCivilization(shell.civilization, true);
  assertDerived(shell.derived, true);
  assertLastMaterializedObserverBasis(shell.lastMaterializedObserverBasis);
  const civilization = shell.civilization as CanonicalGameplayHotCivilization;
  const basis = shell.lastMaterializedObserverBasis as LastMaterializedObserverBasis;
  if (civilization.stage !== basis.stage
    || !isDeepStrictEqual(civilization.civilizationIndex, basis.indexSnapshot)) {
    throw new Error('bounded observer hot shell 与 last-materialized basis 不一致');
  }
}

/**
 * Build a bounded continuation shell from one exact, already-materialized
 * observer snapshot. No detector is run and no observer value is inferred.
 */
export function materializeBoundedObserverHotShell(
  input: Readonly<BoundedObserverHotShellInput>,
): BoundedObserverHotShell {
  const inputRecord = requiredRecord(input, 'bounded observer hot shell input');
  assertExactKeys(
    inputRecord,
    ['civilization', 'source', 'lastMaterializedMilestoneCount'],
    ['lastMaterializedObserverBasis'],
    'bounded observer hot shell input',
  );
  assertSource(input.source);
  assertCivilization(input.civilization, false);
  assertNonNegativeSafeInteger(
    input.lastMaterializedMilestoneCount,
    'bounded observer hot shell input.lastMaterializedMilestoneCount',
  );
  if (input.civilization.civilizationIndex.calculatedAtMonth > input.source.month) {
    throw new Error('observer hot shell civilizationIndex 来自 source 未来月份');
  }

  const civilizationIndex = compactIndex(input.civilization.civilizationIndex);
  const basisIndex = compactIndex(input.civilization.civilizationIndex);
  const civilization = cloneGameplayCivilization(input.civilization, civilizationIndex);
  const source = {
    stateHash: input.source.stateHash,
    revision: input.source.revision,
    month: input.source.month,
  };
  let basis: Readonly<LastMaterializedObserverBasis>;
  if (input.lastMaterializedObserverBasis !== undefined) {
    assertLastMaterializedObserverBasis(input.lastMaterializedObserverBasis);
    if (!isDeepStrictEqual(input.lastMaterializedObserverBasis.source, source)
      || input.lastMaterializedObserverBasis.milestoneCount
        !== input.lastMaterializedMilestoneCount
      || input.lastMaterializedObserverBasis.stage !== input.civilization.stage
      || !isDeepStrictEqual(input.lastMaterializedObserverBasis.indexSnapshot, basisIndex)) {
      throw new Error('既有 last-materialized observer basis 与 compact root 不一致');
    }
    basis = deepFreeze(structuredClone(input.lastMaterializedObserverBasis));
  } else {
    const development = input.civilization.development;
    const developmentSnapshot = development ? {
      observerVersion: development.observerVersion,
      currentEra: development.currentEra,
      historicalPeakEra: development.historicalPeakEra,
      candidateEra: development.candidateEra,
      candidateSinceMonth: development.candidateSinceMonth,
    } satisfies CanonicalDevelopmentStabilitySnapshot : null;
    basis = deepFreeze<LastMaterializedObserverBasisV2>({
      version: BOUNDED_OBSERVER_HOT_SHELL_VERSION,
      profile: BOUNDED_OBSERVER_HOT_SHELL_PROFILE,
      source,
      milestoneCount: input.lastMaterializedMilestoneCount,
      stage: input.civilization.stage,
      indexSnapshot: basisIndex,
      developmentSnapshot,
    });
  }
  const shell: BoundedObserverHotShell = {
    civilization,
    derived: {
      practices: [],
      institutions: [],
      milestones: [],
      regions: [],
      structures: [],
    },
    lastMaterializedObserverBasis: basis,
  };

  assertGameplayCivilizationPreserved(input.civilization, shell.civilization);
  assertCanonicalBoundedObserverHotShell(shell);
  return shell;
}

/**
 * Convenience boundary for already-decoded exact observations. Large legacy
 * roots should use `materializeBoundedObserverHotShell` and pass a store/CAS-
 * selected milestone count so their opaque derived segment is never decoded.
 */
export function materializeBoundedObserverHotShellFromExactObservations(
  input: Readonly<BoundedObserverHotShellFromExactObservationsInput>,
): BoundedObserverHotShell {
  const inputRecord = requiredRecord(
    input,
    'bounded observer hot shell exact-observations input',
  );
  assertExactKeys(
    inputRecord,
    ['civilization', 'derived', 'source'],
    [],
    'bounded observer hot shell exact-observations input',
  );
  assertDerived(input.derived, false);
  return materializeBoundedObserverHotShell({
    civilization: input.civilization,
    source: input.source,
    lastMaterializedMilestoneCount: input.derived.milestones.length,
  });
}
