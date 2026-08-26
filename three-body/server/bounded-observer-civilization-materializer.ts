import { isDeepStrictEqual } from 'node:util';

import { committedHistoryView } from '../src/game/eland/domain/history';
import {
  CIVILIZATION_INDEX_CERTIFIED_FLOOR_FORMULA_VERSION,
  calculateCertifiedCivilizationIndexFloor,
} from '../src/game/eland/domain/civilization-index';
import { Material, materialHas } from '../src/game/eland/domain/material';
import type {
  CivilizationIndex,
  CivilizationDevelopmentObservation,
  DevelopmentEraKey,
  SimulationState,
  WorldEvent,
} from '../src/game/eland/domain/model';
import {
  DEVELOPMENT_ERA_LABELS,
  DEVELOPMENT_OBSERVER_VERSION,
  civilizationDevelopmentGateState,
  highestSatisfiedDevelopmentEra,
  materialCapabilityObservationFromExactFacts,
  normalizeDevelopmentEra,
  observeModernCivilizationEvidence,
  reduceCivilizationDevelopmentStability,
  supportingMaterialCapabilityInstitutionKeys,
} from '../src/game/eland/domain/era-progression';
import {
  copyPhysicalStructures,
  rematerializePhysicalStructureIndex,
} from '../src/game/eland/domain/physical-structure-index';
import { voxelWorldRevision } from '../src/game/eland/world/grid';
import {
  assertDecodedObserverCivilizationHistorySidecar,
  encodeObserverCivilizationHistorySidecar,
  type ObserverCivilizationHistorySidecarPayloadV1,
} from './civilization-history-codec';
import {
  OBSERVER_CIVILIZATION_HISTORY_CONTINUATION_GAPS,
  finishObserverCivilizationHistoryProjection,
  foldVerifiedObserverCivilizationHistorySegment,
  resumeObserverCivilizationHistoryProjection,
  type ObserverCivilizationEventHistory,
  type ObserverCivilizationHistoryProjection,
  type ObserverCivilizationHistoryTarget,
} from './observer-civilization-history-projection';
import {
  BOUNDED_OBSERVER_HOT_SHELL_PROFILE,
  BOUNDED_OBSERVER_HOT_SHELL_VERSION,
  assertLastMaterializedObserverBasis,
  type CanonicalDevelopmentStabilitySnapshot,
  type CanonicalHotCivilizationIndex,
  type LastMaterializedObserverBasis,
  type LastMaterializedObserverBasisV2,
} from './bounded-observer-hot-shell';
import {
  BOUNDED_OBSERVER_FUNCTIONAL_BUILDING_EVIDENCE_SEMANTICS,
  BOUNDED_OBSERVER_FUNCTIONAL_BUILDING_OBSERVATION_VERSION,
  type BoundedObserverDerivedSubsetMaterialization,
} from './bounded-observer-derived-materializer';
import type {
  ObserverDerivedHistoryProjection,
  ObserverHistoryEvidenceRef,
} from './observer-derived-history-projection';

/**
 * Post-fact server boundary only. Domain/application code must never import this
 * module: these observations cannot authorise actions, unlock capabilities, or
 * become a planner reward.
 */
export const BOUNDED_OBSERVER_CIVILIZATION_MATERIALIZATION_DEFINITION =
  'bounded-observer-civilization-incomplete-v1' as const;
export const MAX_BOUNDED_CIVILIZATION_OBSERVER_SUFFIX_EVENTS = 65_536;
export const MAX_BOUNDED_CIVILIZATION_OBSERVER_SUFFIX_BYTES = 32 * 1_024 * 1_024;
export const MAX_BOUNDED_CIVILIZATION_OBSERVER_SHELL_ITEMS = 65_536;
export const BOUNDED_MODERN_DEVELOPMENT_MATERIALIZATION_DEFINITION =
  'bounded-modern-development-materialization-v1' as const;
export const BOUNDED_CERTIFIED_DEVELOPMENT_MATERIALIZATION_DEFINITION =
  'bounded-certified-development-materialization-v1' as const;
export const BOUNDED_CIVILIZATION_INDEX_FLOOR_SEMANTICS =
  'proven-current-root-nonnegative-lower-bound-v1' as const;
/** Three replayable completion loops are sufficient; no second time gate. */
export const MODERN_DEVELOPMENT_STABILITY_MONTHS = 0 as const;

const MODERN_ERA = 'modern-civilization' as const;
const MODERN_STAGE = DEVELOPMENT_ERA_LABELS[MODERN_ERA];
const MODERN_GATE_IDS = Object.freeze([
  'power:complete-network-useful-load',
  'measurement:calibrated-comparable-mass',
  'record:independent-experiment-reuse',
] as const);

export type CivilizationObserverOwnedField =
  | 'civilization.civilizationIndex'
  | 'civilization.stage'
  | 'civilization.development'
  | 'derived.milestones';

export interface CivilizationObserverFieldMaterializationStatus {
  readonly field: CivilizationObserverOwnedField;
  readonly status: 'materialized' | 'incomplete-preserved';
  readonly reason: string;
}

export interface BoundedModernDevelopmentMaterialization {
  readonly kind: typeof BOUNDED_MODERN_DEVELOPMENT_MATERIALIZATION_DEFINITION;
  readonly target: Readonly<ObserverCivilizationHistoryTarget>;
  readonly continuationReady: false;
  readonly materializedFields: readonly [
    'civilization.stage',
    'civilization.development',
  ];
  readonly preservedFields: readonly [
    'civilization.civilizationIndex',
    'derived.milestones',
  ];
  readonly fieldStatus: readonly CivilizationObserverFieldMaterializationStatus[];
  readonly gameplayEraSchedulePreserved: true;
  readonly observation: Readonly<CivilizationDevelopmentObservation>;
  /** Compact gate witnesses only; this is not a second authoritative event ledger. */
  readonly modernEvidence: Readonly<{
    satisfied: boolean;
    satisfiedGateIds: readonly string[];
    missingGateIds: readonly string[];
    supportingEventIds: readonly string[];
  }>;
  /** The caller publishes this seal with the materialized state in the final root. */
  readonly nextBasis: Readonly<LastMaterializedObserverBasisV2>;
}

export interface BoundedCertifiedDevelopmentMaterialization {
  readonly kind: typeof BOUNDED_CERTIFIED_DEVELOPMENT_MATERIALIZATION_DEFINITION;
  readonly target: Readonly<ObserverCivilizationHistoryTarget>;
  readonly continuationReady: false;
  readonly materializedFields: readonly [
    'civilization.civilizationIndex',
    'civilization.stage',
    'civilization.development',
  ];
  readonly preservedFields: readonly ['derived.milestones'];
  readonly fieldStatus: readonly CivilizationObserverFieldMaterializationStatus[];
  readonly gameplayEraSchedulePreserved: true;
  readonly observation: Readonly<CivilizationDevelopmentObservation>;
  readonly civilizationIndexFloor: Readonly<{
    semantics: typeof BOUNDED_CIVILIZATION_INDEX_FLOOR_SEMANTICS;
    formulaVersion: typeof CIVILIZATION_INDEX_CERTIFIED_FLOOR_FORMULA_VERSION;
    exactReplayEquivalent: false;
    threshold120: 'proven' | 'unknown';
    total: number;
  }>;
  readonly gateCertainty: Readonly<{
    unknownGateIds: readonly string[];
    exactFalseGateIds: readonly string[];
  }>;
  /** Counts/stages are exact; ID arrays are bounded witnesses only. */
  readonly evidenceSemantics: 'exact-counts-with-bounded-witnesses-v1';
  readonly modernEvidence: BoundedModernDevelopmentMaterialization['modernEvidence'];
  readonly nextBasis: Readonly<LastMaterializedObserverBasisV2>;
}

export interface BoundedObserverCivilizationMaterialization {
  readonly kind: typeof BOUNDED_OBSERVER_CIVILIZATION_MATERIALIZATION_DEFINITION;
  readonly target: Readonly<ObserverCivilizationHistoryTarget>;
  readonly continuationReady: false;
  readonly projectionGaps: readonly string[];
  /** No field may be replaced until the exact detector/shell accumulator exists. */
  readonly materializedFields: readonly CivilizationObserverOwnedField[];
  readonly preservedFields: readonly CivilizationObserverOwnedField[];
  readonly fieldStatus: readonly CivilizationObserverFieldMaterializationStatus[];
  /** `civilization.era` is the authoritative恒/乱纪元 schedule, not an observer field. */
  readonly gameplayEraSchedulePreserved: true;
  /** Exact cumulative facts that this sidecar can currently prove. */
  readonly eventHistory: Readonly<ObserverCivilizationEventHistory>;
  readonly milestoneCoverage: Readonly<{
    completeDefinitionIds: readonly string[];
    basisDefinitionIds: readonly string[];
  }>;
}

export interface AdvancedBoundedObserverCivilizationMaterialization {
  readonly kind: 'advanced-bounded-observer-civilization-incomplete-v1';
  readonly continuationReady: false;
  readonly projection: Readonly<ObserverCivilizationHistoryProjection>;
  readonly sidecar: Readonly<ObserverCivilizationHistorySidecarPayloadV1>;
  readonly materialization: Readonly<BoundedObserverCivilizationMaterialization>;
}

const PRESERVED_FIELDS = Object.freeze<CivilizationObserverOwnedField[]>([
  'civilization.civilizationIndex',
  'civilization.stage',
  'civilization.development',
  'derived.milestones',
]);

const FIELD_STATUS = Object.freeze<CivilizationObserverFieldMaterializationStatus[]>([
  Object.freeze({
    field: 'civilization.civilizationIndex',
    status: 'incomplete-preserved',
    reason: 'territory, material-capability, milestone, and completed-project accumulators are not complete',
  }),
  Object.freeze({
    field: 'civilization.stage',
    status: 'incomplete-preserved',
    reason: 'stage depends on an exact development observation and civilization index',
  }),
  Object.freeze({
    field: 'civilization.development',
    status: 'incomplete-preserved',
    reason: 'development gates and candidate stability history are not accumulated by this sidecar',
  }),
  Object.freeze({
    field: 'derived.milestones',
    status: 'incomplete-preserved',
    reason: 'detector coverage, current-shell gates, and non-monotonic episode retraction are incomplete',
  }),
]);

const MODERN_PARTIAL_FIELD_STATUS = Object.freeze<CivilizationObserverFieldMaterializationStatus[]>([
  Object.freeze({
    field: 'civilization.civilizationIndex',
    status: 'incomplete-preserved',
    reason: 'exact civilization-index accumulators are not closed by the modern fact observer',
  }),
  Object.freeze({
    field: 'civilization.stage',
    status: 'materialized',
    reason: 'only an upward merged-modern achievement is materialized; an existing lower stage is preserved',
  }),
  Object.freeze({
    field: 'civilization.development',
    status: 'materialized',
    reason: 'v7 merged-modern gates are committed at the next authoritative observation without a second time gate',
  }),
  Object.freeze({
    field: 'derived.milestones',
    status: 'incomplete-preserved',
    reason: 'milestone detector coverage and episode retraction remain incomplete',
  }),
]);

const CERTIFIED_DEVELOPMENT_FIELD_STATUS = Object.freeze<CivilizationObserverFieldMaterializationStatus[]>([
  Object.freeze({
    field: 'civilization.civilizationIndex',
    status: 'materialized',
    reason: 'current-root certified non-negative lower bound; below a threshold remains unknown',
  }),
  Object.freeze({
    field: 'civilization.stage',
    status: 'materialized',
    reason: 'highest independently proven era bundle with shared stability semantics',
  }),
  Object.freeze({
    field: 'civilization.development',
    status: 'materialized',
    reason: 'exact derived sidecar counts plus current shell facts; bounded arrays are witnesses only',
  }),
  Object.freeze({
    field: 'derived.milestones',
    status: 'incomplete-preserved',
    reason: 'milestone detector coverage and episode retraction remain incomplete',
  }),
]);

const DEVELOPMENT_ERA_ORDER: readonly DevelopmentEraKey[] = Object.freeze([
  'primitive-tribe',
  'agrarian-settlement',
  'ancient-civilization',
  MODERN_ERA,
]);

function deepFreeze<T>(value: T, visited = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object') return value;
  const object = value as object;
  if (visited.has(object)) return value;
  visited.add(object);
  for (const child of Object.values(object as Record<string, unknown>)) deepFreeze(child, visited);
  return Object.freeze(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function developmentEraRank(value: DevelopmentEraKey): number {
  return DEVELOPMENT_ERA_ORDER.indexOf(normalizeDevelopmentEra(value));
}

function stageEraFallback(stage: string): DevelopmentEraKey {
  if (stage === DEVELOPMENT_ERA_LABELS[MODERN_ERA]) return MODERN_ERA;
  if (stage === DEVELOPMENT_ERA_LABELS['ancient-civilization'] || stage === '中世纪') {
    return 'ancient-civilization';
  }
  if (stage === DEVELOPMENT_ERA_LABELS['agrarian-settlement']) return 'agrarian-settlement';
  if (stage === DEVELOPMENT_ERA_LABELS['primitive-tribe']) return 'primitive-tribe';
  return 'primitive-tribe';
}

interface PreviousDevelopmentStability {
  currentEra: DevelopmentEraKey;
  historicalPeakEra: DevelopmentEraKey;
  candidateEra: DevelopmentEraKey;
  candidateSinceMonth: number;
  candidateObserverVersion: CivilizationDevelopmentObservation['observerVersion'] | null;
}

function previousDevelopmentStability(
  basis: Readonly<LastMaterializedObserverBasis>,
  currentMonth: number,
): PreviousDevelopmentStability {
  const snapshot = basis.version === BOUNDED_OBSERVER_HOT_SHELL_VERSION
    ? basis.developmentSnapshot
    : null;
  if (snapshot === null) {
    const fallback = stageEraFallback(basis.stage);
    return {
      currentEra: fallback,
      historicalPeakEra: fallback,
      candidateEra: fallback,
      candidateSinceMonth: currentMonth,
      candidateObserverVersion: null,
    };
  }
  const currentEra = normalizeDevelopmentEra(snapshot.currentEra);
  const historical = normalizeDevelopmentEra(snapshot.historicalPeakEra);
  const historicalPeakEra = developmentEraRank(currentEra) > developmentEraRank(historical)
    ? currentEra
    : historical;
  return {
    currentEra,
    historicalPeakEra,
    candidateEra: normalizeDevelopmentEra(snapshot.candidateEra),
    candidateSinceMonth: snapshot.candidateSinceMonth,
    candidateObserverVersion: snapshot.observerVersion,
  };
}

function assertModernMaterializationBoundary(
  state: SimulationState,
  basis: Readonly<LastMaterializedObserverBasis>,
  exactTarget: Readonly<ObserverCivilizationHistoryTarget>,
): void {
  assertLastMaterializedObserverBasis(basis);
  if (state.schemaVersion !== 17) {
    throw new Error('bounded modern materializer 只接受 schema-3 内的 SimulationState v17 shell');
  }
  if (state.civilization.conditions.endpoint.kind !== 'months') {
    throw new Error('bounded modern materializer 只处理 months endpoint 的年度观察边界');
  }
  if (basis.source.stateHash !== exactTarget.stateHash) {
    throw new Error('bounded modern materializer 的 basis source 与 exact target hash 不一致');
  }
  if (basis.source.month !== state.clock.elapsedMonths) {
    throw new Error('bounded modern materializer 的 basis source month 与 current shell 不一致');
  }
  if (basis.stage !== state.civilization.stage) {
    throw new Error('bounded modern materializer 的 basis stage 与 current compact shell 不一致');
  }
  if (!isDeepStrictEqual(basis.indexSnapshot, state.civilization.civilizationIndex)) {
    throw new Error('bounded modern materializer 的 basis index snapshot 与 current compact shell 不一致');
  }
  const attachedBasis = (state as unknown as Record<string, unknown>).lastMaterializedObserverBasis;
  if (attachedBasis === undefined) {
    throw new Error('bounded modern materializer 缺少 schema-3 bounded observer basis');
  }
  assertLastMaterializedObserverBasis(attachedBasis);
  if (!isDeepStrictEqual(attachedBasis, basis)) {
    throw new Error('bounded modern materializer 的 state basis 与调用 basis 不一致');
  }
  const history = committedHistoryView(state);
  if (history.events.length !== history.hotEventCount
    || history.eventCount !== exactTarget.eventCount
    || state.world.historyCursor?.tailEventId !== exactTarget.tailEventId) {
    throw new Error('bounded modern materializer 的 shell 与 exact target cursor 不一致');
  }
}

function modernGateReceipt(state: SimulationState) {
  const evidence = observeModernCivilizationEvidence(state);
  const gateState = [
    [MODERN_GATE_IDS[0], evidence.electricalPower !== null],
    [MODERN_GATE_IDS[1], evidence.comparableMeasurement !== null],
    [MODERN_GATE_IDS[2], evidence.independentRecordExperiment !== null],
  ] as const;
  if (evidence.supportingEventIds.length > MAX_BOUNDED_CIVILIZATION_OBSERVER_SHELL_ITEMS
    || evidence.supportingEventIds.some((eventId) => typeof eventId !== 'string' || eventId.length === 0)) {
    throw new Error('bounded modern materializer 的 supporting event witnesses 无效或超出上限');
  }
  return {
    satisfied: evidence.satisfied,
    satisfiedGateIds: gateState.filter(([, satisfied]) => satisfied).map(([id]) => id),
    missingGateIds: gateState.filter(([, satisfied]) => !satisfied).map(([id]) => id),
    supportingEventIds: [...new Set(evidence.supportingEventIds)],
  };
}

/**
 * Narrow post-fact observer for the merged modern achievement. It intentionally
 * does not recalculate civilization index, milestones, lower-era gates, or
 * material capabilities. The store must bind `basis.source` to the private
 * fact root at `exactTarget` before calling this function.
 */
export function materializeBoundedModernCivilizationDevelopment(
  state: SimulationState,
  basis: Readonly<LastMaterializedObserverBasis>,
  exactTarget: Readonly<ObserverCivilizationHistoryTarget>,
): Readonly<BoundedModernDevelopmentMaterialization> {
  assertModernMaterializationBoundary(state, basis, exactTarget);
  const preservedIndex = state.civilization.civilizationIndex;
  const preservedMilestones = state.derived.milestones;
  const month = state.clock.elapsedMonths;
  const previous = previousDevelopmentStability(basis, month);
  const gates = modernGateReceipt(state);
  const currentlyModern = previous.currentEra === MODERN_ERA;

  let currentEra = currentlyModern ? MODERN_ERA : previous.currentEra;
  let historicalPeakEra = previous.historicalPeakEra;
  let candidateEra: DevelopmentEraKey;
  let candidateSinceMonth: number;
  if (currentlyModern) {
    candidateEra = MODERN_ERA;
    candidateSinceMonth = previous.candidateEra === MODERN_ERA
      ? previous.candidateSinceMonth
      : month;
  } else if (gates.satisfied) {
    candidateEra = MODERN_ERA;
    candidateSinceMonth = previous.candidateObserverVersion === DEVELOPMENT_OBSERVER_VERSION
      && previous.candidateEra === MODERN_ERA
      ? previous.candidateSinceMonth
      : month;
    currentEra = MODERN_ERA;
    historicalPeakEra = MODERN_ERA;
  } else {
    candidateEra = currentEra;
    candidateSinceMonth = month;
  }

  const transitionProgress = currentEra === MODERN_ERA
    ? 1
    : gates.satisfiedGateIds.length / MODERN_GATE_IDS.length;
  const observation: CivilizationDevelopmentObservation = {
    observerVersion: DEVELOPMENT_OBSERVER_VERSION,
    currentEra,
    historicalPeakEra,
    candidateEra,
    candidateSinceMonth,
    transitionProgress: Math.round(transitionProgress * 100) / 100,
    satisfiedGateIds: [...gates.satisfiedGateIds],
    missingGateIds: [...gates.missingGateIds],
    supportingEventIds: [...gates.supportingEventIds],
    // This narrow materializer has no complete material-capability accumulator.
    materialCapabilities: [],
  };
  const nextStage = currentEra === MODERN_ERA
    ? MODERN_STAGE
    : basis.stage === '中世纪' ? DEVELOPMENT_ERA_LABELS['ancient-civilization'] : basis.stage;
  const developmentSnapshot: CanonicalDevelopmentStabilitySnapshot = {
    observerVersion: observation.observerVersion,
    currentEra: observation.currentEra,
    historicalPeakEra: observation.historicalPeakEra,
    candidateEra: observation.candidateEra,
    candidateSinceMonth: observation.candidateSinceMonth,
  };
  const nextBasis: LastMaterializedObserverBasisV2 = {
    version: BOUNDED_OBSERVER_HOT_SHELL_VERSION,
    profile: BOUNDED_OBSERVER_HOT_SHELL_PROFILE,
    source: { ...basis.source },
    milestoneCount: basis.milestoneCount,
    stage: nextStage,
    indexSnapshot: clone(basis.indexSnapshot),
    developmentSnapshot,
  };
  assertLastMaterializedObserverBasis(nextBasis);

  state.civilization.stage = nextStage;
  state.civilization.development = clone(observation);
  (state as unknown as Record<string, unknown>).lastMaterializedObserverBasis = clone(nextBasis);
  if (state.civilization.civilizationIndex !== preservedIndex
    || state.derived.milestones !== preservedMilestones) {
    throw new Error('bounded modern materializer 意外替换 civilization index 或 milestones');
  }

  return deepFreeze({
    kind: BOUNDED_MODERN_DEVELOPMENT_MATERIALIZATION_DEFINITION,
    target: { ...exactTarget },
    continuationReady: false,
    materializedFields: [
      'civilization.stage',
      'civilization.development',
    ],
    preservedFields: [
      'civilization.civilizationIndex',
      'derived.milestones',
    ],
    fieldStatus: clone(MODERN_PARTIAL_FIELD_STATUS),
    gameplayEraSchedulePreserved: true,
    observation: clone(observation),
    modernEvidence: clone(gates),
    nextBasis: clone(nextBasis),
  });
}

function evidenceEventIds(values: readonly ObserverHistoryEvidenceRef[]): string[] {
  if (values.length > MAX_BOUNDED_CIVILIZATION_OBSERVER_SHELL_ITEMS) {
    throw new Error('bounded certified development witness array 超出上限');
  }
  return values.map((value) => value.eventId);
}

function compactCivilizationIndex(index: CivilizationIndex): CanonicalHotCivilizationIndex {
  const compact = (key: keyof CivilizationIndex['components']) => ({
    score: index.components[key].score,
    weight: index.components[key].weight,
    evidence: {},
  });
  return {
    ...(index.formulaVersion === undefined ? {} : { formulaVersion: index.formulaVersion }),
    total: index.total,
    calculatedAtMonth: index.calculatedAtMonth,
    components: {
      population: compact('population'),
      territory: compact('territory'),
      technology: compact('technology'),
      social: compact('social'),
      history: compact('history'),
    },
  };
}

function assertExactDerivedCivilizationBasis(
  state: SimulationState,
  derived: Readonly<BoundedObserverDerivedSubsetMaterialization>,
  projection: Readonly<ObserverDerivedHistoryProjection>,
  exactTarget: Readonly<ObserverCivilizationHistoryTarget>,
): void {
  const targetMatches = (target: Readonly<{ stateHash: string; eventCount: number; tailEventId: string | null }>) => (
    target.stateHash === exactTarget.stateHash
      && target.eventCount === exactTarget.eventCount
      && target.tailEventId === exactTarget.tailEventId
  );
  if (!targetMatches(derived.target)
    || !targetMatches(projection.target)
    || projection.reducedThrough.eventCount !== exactTarget.eventCount
    || projection.reducedThrough.tailEventId !== exactTarget.tailEventId
    || derived.evidenceSemantics !== 'bounded-witnesses-with-exact-counts-v1'
    || !isDeepStrictEqual(derived.materialCapabilities, projection.materialCapabilities)
    || !isDeepStrictEqual(state.derived.functionalBuildings, derived.functionalBuildings)
    || !isDeepStrictEqual(state.derived.institutions, derived.institutions)
    || !isDeepStrictEqual(state.derived.regions, derived.regions)
    || !isDeepStrictEqual(state.derived.structures, derived.structures)) {
    throw new Error('bounded certified development 的 exact derived/root basis 失配');
  }
}

/**
 * Full lower-era observer for one exact bounded root. The historical sidecar
 * supplies exact counters; the current shell supplies current activity,
 * inventory, people, structures and records. The civilization index remains a
 * certified lower bound, never a reconstructed exact replay score.
 */
export function materializeBoundedCertifiedCivilizationDevelopment(
  state: SimulationState,
  basis: Readonly<LastMaterializedObserverBasis>,
  exactTarget: Readonly<ObserverCivilizationHistoryTarget>,
  derived: Readonly<BoundedObserverDerivedSubsetMaterialization>,
  derivedProjection: Readonly<ObserverDerivedHistoryProjection>,
): Readonly<BoundedCertifiedDevelopmentMaterialization> {
  assertModernMaterializationBoundary(state, basis, exactTarget);
  assertExactDerivedCivilizationBasis(state, derived, derivedProjection, exactTarget);
  const preservedMilestones = state.derived.milestones;
  const institutionKeys = state.derived.institutions.map((institution) => institution.key);
  if (institutionKeys.some((key) => typeof key !== 'string' || key.length === 0)
    || new Set(institutionKeys).size !== institutionKeys.length) {
    throw new Error('bounded certified development institution keys 必须 canonical 且不可重复');
  }
  const cultivatedRegions = state.derived.regions.filter((region) => region.kind === 'cultivated');
  if (cultivatedRegions.length > 1
    || cultivatedRegions.some((region) => new Set(region.cells).size !== region.cells.length)) {
    throw new Error('bounded certified development cultivated region 必须 canonical 且 cell 不可重复');
  }
  const capabilityKeys = ['processed-wood', 'masonry-stone', 'bronze', 'iron'] as const;
  const materialCapabilities = capabilityKeys.map((key) => {
    const facts = derived.materialCapabilities[key];
    const firstSupportingInstitutionKey = supportingMaterialCapabilityInstitutionKeys(
      key,
      institutionKeys,
    )[0];
    return materialCapabilityObservationFromExactFacts({
      key,
      successfulBatchCount: facts.successfulBatchCount,
      failedBatchCount: facts.failedBatchCount,
      adoptedActionCount: facts.adoptedActionCount,
      firstSuccessfulMonth: facts.firstSuccessfulMonth,
      lastSuccessfulMonth: facts.lastSuccessfulMonth,
      producerIds: facts.producerIds,
      productionSiteMaterialIds: facts.productionSiteMaterialIds,
      // Institutional stage needs exact existence, not an unbounded list. Keep
      // one canonical witness key while the materialized institution set stays
      // the exact count source for the index floor.
      supportingInstitutionKeys: firstSupportingInstitutionKey
        ? [firstSupportingInstitutionKey]
        : [],
      successfulBatchEventIds: evidenceEventIds(facts.successfulBatchEvidence),
      failedBatchEventIds: evidenceEventIds(facts.failedBatchEvidence),
      adoptedActionEventIds: evidenceEventIds(facts.adoptedActionEvidence),
    });
  });
  const facilities = derived.functionalBuildings.map((facility) => {
    if (facility.observationVersion !== BOUNDED_OBSERVER_FUNCTIONAL_BUILDING_OBSERVATION_VERSION
      || facility.evidenceSemantics !== BOUNDED_OBSERVER_FUNCTIONAL_BUILDING_EVIDENCE_SEMANTICS
      || !Number.isSafeInteger(facility.installationCount)
      || facility.installationCount < 1
      || !Number.isSafeInteger(facility.useCount)
      || facility.useCount < 0
      || new Set(facility.userIds).size !== facility.userIds.length) {
      throw new Error(`bounded certified development facility ${facility.id} 缺少 exact count contract`);
    }
    return {
      id: facility.id,
      materialId: facility.materialId,
      active: facility.active,
      useCount: facility.useCount,
      userCount: facility.userIds.length,
    };
  });
  const indexFloor = calculateCertifiedCivilizationIndexFloor(state, {
    materialCapabilities,
    facilities,
  });
  const indexThreshold120Proven = indexFloor.total >= 120;
  const storedFoodUnits = state.containers.reduce((sum, container) => sum
    + container.inventory.reduce((inner, stack) => (
      materialHas(stack.materialId, 'edible') ? inner + stack.quantity : inner
    ), 0), 0);
  const modern = modernGateReceipt(state);
  const gates = civilizationDevelopmentGateState({
    indexAtLeast120Proven: indexThreshold120Proven,
    materialCapabilities,
    settledCultivationEstablished: derivedProjection.establishedCultivationWitness !== null,
    storedFoodUnits,
    facilities: facilities.map((facility) => ({
      materialId: facility.materialId,
      active: facility.active,
      useCount: facility.useCount,
    })),
    functionalInstitutionCount: state.derived.institutions.length,
    modern: {
      electricalPower: modern.satisfiedGateIds.includes(MODERN_GATE_IDS[0]),
      comparableMeasurement: modern.satisfiedGateIds.includes(MODERN_GATE_IDS[1]),
      independentRecordExperiment: modern.satisfiedGateIds.includes(MODERN_GATE_IDS[2]),
    },
  });
  const previous = previousDevelopmentStability(basis, state.clock.elapsedMonths);
  let candidateEra = highestSatisfiedDevelopmentEra(gates);
  const agrarianGates = gates['agrarian-settlement'] ?? [];
  const indexIsOnlyUnknownAgrarianGate = !indexThreshold120Proven
    && agrarianGates
      .filter(([gateId]) => gateId !== 'index:120')
      .every(([, satisfied]) => Boolean(satisfied));
  if (indexIsOnlyUnknownAgrarianGate
    && developmentEraRank(candidateEra) < developmentEraRank(previous.currentEra)) {
    // An unknown lower bound must not masquerade as proof that a previously
    // certified achievement disappeared.
    candidateEra = previous.currentEra;
  }
  const stability = reduceCivilizationDevelopmentStability(
    state.clock.elapsedMonths,
    candidateEra,
    {
      observerVersion: previous.candidateObserverVersion,
      currentEra: previous.currentEra,
      historicalPeakEra: previous.historicalPeakEra,
      candidateEra: previous.candidateEra,
      candidateSinceMonth: previous.candidateSinceMonth,
    },
  );
  const targetGates = stability.targetEra ? gates[stability.targetEra] ?? [] : [];
  const satisfiedGateIds = targetGates
    .filter(([, satisfied]) => Boolean(satisfied))
    .map(([gateId]) => gateId);
  const missingGateIds = targetGates
    .filter(([, satisfied]) => !Boolean(satisfied))
    .map(([gateId]) => gateId);

  const gateFacilities = [
    facilities.find((facility) => facility.active
      && facility.materialId === Material.Granary && facility.useCount >= 2),
    facilities.find((facility) => facility.active
      && facility.materialId === Material.CouncilHearth && facility.useCount >= 1),
  ].filter((facility): facility is NonNullable<typeof facility> => facility !== undefined);
  const gateFacilityIds = new Set(gateFacilities.map((facility) => facility.id));
  const gateInstitutionKeys = new Set(materialCapabilities.flatMap(
    (capability) => capability.supportingInstitutionKeys,
  ));
  if (state.derived.institutions[0]) gateInstitutionKeys.add(state.derived.institutions[0].key);
  const supportingEventIds = [...new Set([
    ...materialCapabilities.flatMap((capability) => [
      ...capability.successfulBatchEventIds,
      ...capability.adoptedActionEventIds,
    ]),
    ...derived.functionalBuildings
      .filter((facility) => gateFacilityIds.has(facility.id))
      .flatMap((facility) => [...facility.installationEventIds, ...facility.useEventIds]),
    ...(derivedProjection.establishedCultivationWitness
      ? [
        ...evidenceEventIds(derivedProjection.establishedCultivationWitness.plantingEvidence),
        ...evidenceEventIds(derivedProjection.establishedCultivationWitness.harvestEvidence),
      ]
      : []),
    ...state.derived.institutions.filter((institution) => gateInstitutionKeys.has(institution.key))
      .flatMap((institution) => institution.evidenceEventIds),
    ...modern.supportingEventIds,
  ])];
  if (supportingEventIds.length > MAX_BOUNDED_CIVILIZATION_OBSERVER_SHELL_ITEMS
    || supportingEventIds.some((eventId) => typeof eventId !== 'string' || eventId.length === 0)) {
    throw new Error('bounded certified development supporting witnesses 无效或超出上限');
  }
  const gateProgress = targetGates.length ? satisfiedGateIds.length / targetGates.length : 1;
  const stabilityProgress = stability.upward && stability.requiredStableMonths > 0
    ? Math.min(1, stability.stableMonths / stability.requiredStableMonths)
    : 1;
  const observation: CivilizationDevelopmentObservation = {
    observerVersion: DEVELOPMENT_OBSERVER_VERSION,
    currentEra: stability.currentEra,
    historicalPeakEra: stability.historicalPeakEra,
    candidateEra: stability.candidateEra,
    candidateSinceMonth: stability.candidateSinceMonth,
    transitionProgress: Math.round(gateProgress * stabilityProgress * 100) / 100,
    satisfiedGateIds,
    missingGateIds,
    supportingEventIds,
    materialCapabilities,
  };
  const nextStage = DEVELOPMENT_ERA_LABELS[stability.currentEra];
  const developmentSnapshot: CanonicalDevelopmentStabilitySnapshot = {
    observerVersion: observation.observerVersion,
    currentEra: observation.currentEra,
    historicalPeakEra: observation.historicalPeakEra,
    candidateEra: observation.candidateEra,
    candidateSinceMonth: observation.candidateSinceMonth,
  };
  const nextBasis: LastMaterializedObserverBasisV2 = {
    version: BOUNDED_OBSERVER_HOT_SHELL_VERSION,
    profile: BOUNDED_OBSERVER_HOT_SHELL_PROFILE,
    source: { ...basis.source },
    milestoneCount: basis.milestoneCount,
    stage: nextStage,
    indexSnapshot: compactCivilizationIndex(indexFloor),
    developmentSnapshot,
  };
  assertLastMaterializedObserverBasis(nextBasis);

  state.civilization.civilizationIndex = clone(indexFloor);
  state.civilization.stage = nextStage;
  state.civilization.development = clone(observation);
  (state as unknown as Record<string, unknown>).lastMaterializedObserverBasis = clone(nextBasis);
  if (state.derived.milestones !== preservedMilestones) {
    throw new Error('bounded certified development 意外替换 milestones');
  }

  const unknownGateIds = indexThreshold120Proven ? [] : ['index:120'];
  return deepFreeze({
    kind: BOUNDED_CERTIFIED_DEVELOPMENT_MATERIALIZATION_DEFINITION,
    target: { ...exactTarget },
    continuationReady: false,
    materializedFields: [
      'civilization.civilizationIndex',
      'civilization.stage',
      'civilization.development',
    ],
    preservedFields: ['derived.milestones'],
    fieldStatus: clone(CERTIFIED_DEVELOPMENT_FIELD_STATUS),
    gameplayEraSchedulePreserved: true,
    observation: clone(observation),
    civilizationIndexFloor: {
      semantics: BOUNDED_CIVILIZATION_INDEX_FLOOR_SEMANTICS,
      formulaVersion: CIVILIZATION_INDEX_CERTIFIED_FLOOR_FORMULA_VERSION,
      exactReplayEquivalent: false,
      threshold120: indexThreshold120Proven ? 'proven' : 'unknown',
      total: indexFloor.total,
    },
    gateCertainty: {
      unknownGateIds,
      exactFalseGateIds: missingGateIds.filter((gateId) => !unknownGateIds.includes(gateId)),
    },
    evidenceSemantics: 'exact-counts-with-bounded-witnesses-v1',
    modernEvidence: clone(modern),
    nextBasis: clone(nextBasis),
  });
}

function sameTarget(
  left: Readonly<ObserverCivilizationHistoryTarget>,
  right: Readonly<ObserverCivilizationHistoryTarget>,
): boolean {
  return left.stateHash === right.stateHash
    && left.eventCount === right.eventCount
    && left.tailEventId === right.tailEventId;
}

function assertKnownProjectionGaps(projection: ObserverCivilizationHistoryProjection): void {
  if (projection.continuationGaps.length !== OBSERVER_CIVILIZATION_HISTORY_CONTINUATION_GAPS.length
    || projection.continuationGaps.some(
      (gap, index) => gap !== OBSERVER_CIVILIZATION_HISTORY_CONTINUATION_GAPS[index],
    )) {
    throw new Error('bounded civilization observer 拒绝缺失、重复或未知 projection gap');
  }
}

function assertCivilizationIndexShell(value: CivilizationIndex): void {
  if (!value || typeof value !== 'object'
    || !Number.isFinite(value.total)
    || !Number.isSafeInteger(value.calculatedAtMonth)
    || value.calculatedAtMonth < 0
    || !value.components
    || typeof value.components !== 'object') {
    throw new Error('bounded civilization observer 的 civilization index shell 无效');
  }
  for (const key of ['population', 'territory', 'technology', 'social', 'history'] as const) {
    const component = value.components[key];
    if (!component || !Number.isFinite(component.score) || !Number.isFinite(component.weight)
      || !component.evidence || typeof component.evidence !== 'object') {
      throw new Error(`bounded civilization observer 的 civilization index ${key} component 无效`);
    }
  }
}

function assertCurrentShellAndDerivedPrerequisites(
  state: SimulationState,
  target: ObserverCivilizationHistoryTarget,
): void {
  const history = committedHistoryView(state);
  if (history.events.length !== history.hotEventCount
    || history.eventCount !== target.eventCount
    || state.world.historyCursor?.tailEventId !== target.tailEventId) {
    throw new Error('bounded civilization observer 的 shell 与 exact target cursor 不一致');
  }
  if (typeof state.civilization.stage !== 'string' || state.civilization.stage.length === 0) {
    throw new Error('bounded civilization observer 的 stage shell 无效');
  }
  assertCivilizationIndexShell(state.civilization.civilizationIndex);
  for (const key of ['practices', 'institutions', 'regions', 'structures', 'milestones'] as const) {
    const values = state.derived[key];
    if (!Array.isArray(values) || values.length > MAX_BOUNDED_CIVILIZATION_OBSERVER_SHELL_ITEMS) {
      throw new Error(`bounded civilization observer 的 derived.${key} prerequisite 无效或超出上限`);
    }
  }
  if (state.derived.functionalBuildings !== undefined
    && (!Array.isArray(state.derived.functionalBuildings)
      || state.derived.functionalBuildings.length > MAX_BOUNDED_CIVILIZATION_OBSERVER_SHELL_ITEMS)) {
    throw new Error('bounded civilization observer 的 derived.functionalBuildings prerequisite 无效或超出上限');
  }
  const physical = state.world.physicalStructureIndex;
  if (!physical
    || physical.projectionVersion !== 2
    || physical.appliedHistoryEventCount !== target.eventCount
    || physical.appliedTailEventId !== target.tailEventId
    || physical.calculatedAtMonth !== state.clock.elapsedMonths
    || physical.voxelRevision !== voxelWorldRevision(state.world.grid)) {
    throw new Error('bounded civilization observer 的 physical/derived prerequisite 与 target 不一致');
  }
  const rematerialized = rematerializePhysicalStructureIndex(state, physical);
  const structures = copyPhysicalStructures(rematerialized);
  if (!isDeepStrictEqual(physical.structures, rematerialized.structures)
    || !isDeepStrictEqual(state.derived.structures, structures)) {
    throw new Error('bounded civilization observer 的 current derived structures 与物理拓扑不一致');
  }
}

function materializeVerifiedIncompleteObservation(
  state: SimulationState,
  projection: ObserverCivilizationHistoryProjection,
  exactTarget: ObserverCivilizationHistoryTarget,
): Readonly<BoundedObserverCivilizationMaterialization> {
  if (!sameTarget(projection.target, exactTarget)) {
    throw new Error('bounded civilization observer 收到 stale projection target');
  }
  assertKnownProjectionGaps(projection);
  assertCurrentShellAndDerivedPrerequisites(state, exactTarget);

  // Deliberately no state mutation: every nominally owned field still lacks a
  // complete replay basis. Partial replacement would turn a hot tail into a
  // fabricated civilization stage. The authoritative era schedule is not an
  // observer field and is never touched here.
  return deepFreeze({
    kind: BOUNDED_OBSERVER_CIVILIZATION_MATERIALIZATION_DEFINITION,
    target: { ...exactTarget },
    continuationReady: false,
    projectionGaps: [...projection.continuationGaps],
    materializedFields: [],
    preservedFields: [...PRESERVED_FIELDS],
    fieldStatus: clone(FIELD_STATUS),
    gameplayEraSchedulePreserved: true,
    eventHistory: clone(projection.eventHistory),
    milestoneCoverage: {
      completeDefinitionIds: [...projection.completeMilestoneDefinitionIds],
      basisDefinitionIds: projection.milestoneBasis.map((basis) => basis.definitionId),
    },
  });
}

/**
 * Inspect/materialize only from an object minted by the strict store-selected
 * decoder at the exact run-root target.
 */
export function materializeDecodedBoundedObserverCivilization(
  state: SimulationState,
  decoded: Readonly<ObserverCivilizationHistorySidecarPayloadV1>,
  exactTarget: Readonly<ObserverCivilizationHistoryTarget>,
): Readonly<BoundedObserverCivilizationMaterialization> {
  assertDecodedObserverCivilizationHistorySidecar(decoded);
  return materializeVerifiedIncompleteObservation(state, decoded.projection, exactTarget);
}

/**
 * Resume one strict-decoded prefix, bind the supplied suffix to the exact
 * authoritative hot window, fold/finish it, and expose only the honest
 * incomplete materialization at the successor target.
 */
export function advanceBoundedObserverCivilization(
  state: SimulationState,
  decodedPrevious: Readonly<ObserverCivilizationHistorySidecarPayloadV1>,
  previousTarget: Readonly<ObserverCivilizationHistoryTarget>,
  nextTarget: Readonly<ObserverCivilizationHistoryTarget>,
  suffix: readonly WorldEvent[],
): Readonly<AdvancedBoundedObserverCivilizationMaterialization> {
  assertDecodedObserverCivilizationHistorySidecar(decodedPrevious);
  if (!sameTarget(decodedPrevious.projection.target, previousTarget)) {
    throw new Error('bounded civilization observer previous target 已过期');
  }
  assertKnownProjectionGaps(decodedPrevious.projection);
  if (!Number.isSafeInteger(suffix.length)
    || suffix.length > MAX_BOUNDED_CIVILIZATION_OBSERVER_SUFFIX_EVENTS
    || previousTarget.eventCount + suffix.length !== nextTarget.eventCount) {
    throw new Error('bounded civilization observer suffix 数量或 cursor 不连续');
  }
  assertCurrentShellAndDerivedPrerequisites(state, nextTarget);
  const history = committedHistoryView(state);
  const authoritative: WorldEvent[] = [];
  for (let offset = 0; offset < suffix.length; offset += 1) {
    const event = history.atAbsoluteIndex(previousTarget.eventCount + offset);
    if (!event || !isDeepStrictEqual(event, suffix[offset])) {
      throw new Error(`bounded civilization observer suffix ${offset} 未绑定到权威热事实`);
    }
    authoritative.push(event);
  }
  if (Buffer.byteLength(JSON.stringify(authoritative), 'utf8')
    > MAX_BOUNDED_CIVILIZATION_OBSERVER_SUFFIX_BYTES) {
    throw new Error('bounded civilization observer suffix 超出 byte 上限');
  }
  const fold = resumeObserverCivilizationHistoryProjection(
    decodedPrevious.projection,
    nextTarget,
  );
  foldVerifiedObserverCivilizationHistorySegment(
    fold,
    clone(authoritative),
    previousTarget.eventCount,
  );
  const projection = finishObserverCivilizationHistoryProjection(fold);
  const encoded = encodeObserverCivilizationHistorySidecar(projection);
  const materialization = materializeVerifiedIncompleteObservation(
    state,
    encoded.sidecar.projection,
    nextTarget,
  );
  return deepFreeze({
    kind: 'advanced-bounded-observer-civilization-incomplete-v1',
    continuationReady: false,
    projection: encoded.sidecar.projection,
    sidecar: encoded.sidecar,
    materialization,
  });
}
