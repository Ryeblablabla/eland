import { createHash } from 'node:crypto';

import {
  MATERIAL_PALETTE,
  Material,
  type MaterialId,
} from '../src/game/eland/domain/material';
import {
  WORLD_CELL_COUNT,
  WORLD_DEPTH,
  WORLD_LEVELS,
  WORLD_WIDTH,
  cellId,
} from '../src/game/eland/world/grid';
import {
  OBSERVER_DERIVED_HISTORY_DEFINITION,
  OBSERVER_DERIVED_HISTORY_DEMAND_ENTITY_LIMIT,
  OBSERVER_DERIVED_HISTORY_DEMAND_REFERENCE_LIMIT,
  OBSERVER_DERIVED_HISTORY_EVENT_BASIS_LIMIT,
  OBSERVER_DERIVED_HISTORY_EVENT_COLLECTION_LIMIT,
  OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT,
  OBSERVER_DERIVED_HISTORY_FACILITY_LIMIT,
  OBSERVER_DERIVED_HISTORY_IDENTITY_MEMBERSHIP_LIMIT,
  OBSERVER_DERIVED_HISTORY_SPATIAL_KEY_LIMIT,
  type ObserverCultivationEventBasis,
  type ObserverDemandEventBasisEntry,
  type ObserverDerivedHistoryProjection,
  type ObserverDerivedHistoryTarget,
  type ObserverEstablishedCultivationWitness,
  type ObserverFunctionalBuildingHistory,
  type ObserverFunctionalBuildingKind,
  type ObserverHistoryEvidenceRef,
  type ObserverInstitutionBasisHistory,
  type ObserverMaterialCapabilityHistory,
  type ObserverMaterialCapabilityKey,
  type ObserverPracticeHistory,
  type ObserverPracticeKey,
  type ObserverResidentialRegionHistory,
  type ObserverSettledCultivationProjectHistory,
} from './observer-derived-history-projection';

/**
 * Persistence envelope for the v2 derived-observer projection. The source
 * demand is intentionally retained: the projection result alone has already
 * discarded IDs and site cells needed to independently recompute its demand
 * fingerprint.
 */
export const OBSERVER_DERIVED_HISTORY_SIDECAR_CODEC =
  'eland-observer-derived-history-projection-json-v1';
export const OBSERVER_DERIVED_HISTORY_SIDECAR_SCHEMA_VERSION = 1 as const;
export const OBSERVER_DERIVED_HISTORY_SIDECAR_DOMAIN =
  'eland-observer-derived-history-sidecar-v1' as const;

/** Parsing temporarily owns the stored bytes, parsed graph, and normalized graph. */
export const MAX_OBSERVER_DERIVED_HISTORY_SIDECAR_STORED_BYTES = 32 * 1_024 * 1_024;
export const MAX_OBSERVER_DERIVED_HISTORY_SIDECAR_IDENTIFIER_BYTES = 4_096;
export const MAX_OBSERVER_DERIVED_HISTORY_SIDECAR_GAP_BYTES = 16 * 1_024;

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const POSITION_KEY_PATTERN = /^(\d+):(\d+):(\d+)$/u;
const FACILITY_ID_PATTERN = /^facility:(\d+):(\d+):(\d+):(\d+)$/u;
const MATERIAL_IDS = new Set(MATERIAL_PALETTE.map((material) => material.id));

const PRACTICE_KEYS = [
  'transfer',
  'storage',
  'travel',
  'cultivation',
  'mortuary-care',
] as const satisfies readonly ObserverPracticeKey[];

const CAPABILITY_KEYS = [
  'processed-wood',
  'masonry-stone',
  'bronze',
  'iron',
] as const satisfies readonly ObserverMaterialCapabilityKey[];

const FUNCTIONAL_BUILDING_KINDS = [
  'core',
  'storage',
  'water',
  'workshop',
  'kiln',
  'mill',
  'foundry',
  'smithy',
] as const satisfies readonly ObserverFunctionalBuildingKind[];

const FACILITY_DEFINITIONS = new Map<MaterialId, ObserverFunctionalBuildingKind>([
  [Material.CouncilHearth, 'core'],
  [Material.CivicHall, 'core'],
  [Material.KeepCore, 'core'],
  [Material.Granary, 'storage'],
  [Material.Cistern, 'water'],
  [Material.Workshop, 'workshop'],
  [Material.Kiln, 'kiln'],
  [Material.Mill, 'mill'],
  [Material.Foundry, 'foundry'],
  [Material.Smithy, 'smithy'],
]);

const CAPABILITY_SITE_MATERIALS: Readonly<Record<ObserverMaterialCapabilityKey, ReadonlySet<MaterialId>>> = {
  'processed-wood': new Set([Material.CouncilHearth, Material.Workshop, Material.Granary]),
  'masonry-stone': new Set([Material.Cistern, Material.Kiln, Material.Mill]),
  bronze: new Set([Material.Kiln, Material.Foundry, Material.CivicHall]),
  iron: new Set([Material.Smithy, Material.KeepCore]),
};

/** Version-pinned fail-closed gaps emitted by observer-derived-history-v2. */
const CONTINUATION_GAPS = [
  'current-grid facility activity and region cells still require exact final-shell reconciliation',
  'retained/future demand closure is not yet wired to active-project and physical-provenance collectors',
  'bounded evidence arrays require versioned materialization instead of legacy all-event ID arrays',
  'development era, institution fragments, civilization index, and milestones are not materialized here',
  'the result is not yet exact-run-root branded or persisted in the state revision CAS transaction',
] as const;

type UnknownRecord = Record<string, unknown>;

export interface ObserverDerivedHistoryCanonicalCultivationDemandV1 {
  readonly projectId: string;
  readonly completedAtMonth: number;
  readonly siteCellIds: readonly number[];
  readonly actionEventIds: readonly string[];
  readonly completionEventIds: readonly string[];
}

export interface ObserverDerivedHistoryCanonicalResidentialDemandV1 {
  readonly structureId: string;
  /** Source order is semantic: the observer selects the first resolved source. */
  readonly sourceEventIds: readonly string[];
}

export interface ObserverDerivedHistoryCanonicalDemandV1 {
  readonly settledCultivationProjects: readonly ObserverDerivedHistoryCanonicalCultivationDemandV1[];
  readonly residentialStructures: readonly ObserverDerivedHistoryCanonicalResidentialDemandV1[];
  readonly retainedEventIds: readonly string[];
  readonly futureEventIds: readonly string[];
}

export interface ObserverDerivedHistorySidecarInputV1 {
  readonly sourceDemand: Readonly<ObserverDerivedHistoryCanonicalDemandV1>;
  readonly projection: Readonly<ObserverDerivedHistoryProjection>;
}

export interface ObserverDerivedHistorySidecarPayloadV1 {
  readonly schemaVersion: 1;
  readonly domain: typeof OBSERVER_DERIVED_HISTORY_SIDECAR_DOMAIN;
  readonly sourceDemand: Readonly<ObserverDerivedHistoryCanonicalDemandV1>;
  readonly projection: Readonly<ObserverDerivedHistoryProjection>;
}

export interface ObserverDerivedHistorySidecarChunk {
  hash: string;
  codec: string;
  /** Stored-byte length. V1 stores canonical UTF-8 JSON directly. */
  rawSize: number;
  data: Buffer | Uint8Array;
}

export interface ObserverDerivedHistorySidecarContentReferenceV1 {
  kind: 'content-hash';
  codec: typeof OBSERVER_DERIVED_HISTORY_SIDECAR_CODEC;
  hash: string;
}

export interface ObserverDerivedHistorySidecarBoundaryV1 {
  /** Must be selected from the same exact run-root store snapshot as the reference. */
  target: Readonly<ObserverDerivedHistoryTarget>;
}

export interface ObserverDerivedHistorySidecarDecodeExpectationV1 {
  /** A store-selected reference, never a digest supplied as authority by the caller. */
  reference: Readonly<ObserverDerivedHistorySidecarContentReferenceV1>;
  boundary: Readonly<ObserverDerivedHistorySidecarBoundaryV1>;
}

export interface EncodedObserverDerivedHistorySidecar {
  chunk: Readonly<ObserverDerivedHistorySidecarChunk>;
  reference: Readonly<ObserverDerivedHistorySidecarContentReferenceV1>;
  sidecar: Readonly<ObserverDerivedHistorySidecarPayloadV1>;
}

const decodedObserverDerivedHistorySidecars = new WeakSet<object>();

/** Runtime provenance seam: only the strict decoder can mint this identity. */
export function assertDecodedObserverDerivedHistorySidecar(
  value: unknown,
): asserts value is Readonly<ObserverDerivedHistorySidecarPayloadV1> {
  if (!value || typeof value !== 'object' || !decodedObserverDerivedHistorySidecars.has(value)) {
    throw new Error('observer derived sidecar 未经过 strict store-selected decoder');
  }
}

interface NormalizedDemandState {
  sourceDemand: ObserverDerivedHistoryCanonicalDemandV1;
  fingerprintBasis: {
    settledCultivationProjects: ObserverDerivedHistoryCanonicalCultivationDemandV1[];
    residentialStructures: ObserverDerivedHistoryCanonicalResidentialDemandV1[];
    retainedEventIds: string[];
    futureEventIds: string[];
    trackedEventIds: string[];
    worldRequiredEventIds: string[];
    actionRequiredEventIds: string[];
  };
}

interface EvidenceIdentityRegistry {
  byAbsoluteIndex: Map<number, ObserverHistoryEvidenceRef>;
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): asserts value is UnknownRecord {
  if (!isRecord(value)) throw new Error(`${label} 必须是对象`);
}

function assertExactKeys(value: UnknownRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (actual.length !== canonicalExpected.length
    || actual.some((key, index) => key !== canonicalExpected[index])) {
    throw new Error(`${label} 字段集合无效`);
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new Error(`${label} 必须是 64 位小写十六进制 SHA-256`);
  }
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} 必须是布尔值`);
}

function assertSafeIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value)
    || Number(value) < minimum
    || Number(value) > maximum) {
    throw new Error(`${label} 必须是 ${minimum} 到 ${maximum} 的安全整数`);
  }
}

function assertBoundedString(
  value: unknown,
  label: string,
  maximumBytes = MAX_OBSERVER_DERIVED_HISTORY_SIDECAR_IDENTIFIER_BYTES,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} 必须是非空字符串`);
  }
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new Error(`${label} 超过 ${maximumBytes} 字节上限`);
  }
}

function assertArray(value: unknown, maximumLength: number, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  if (value.length > maximumLength) {
    throw new Error(`${label} 超过 ${maximumLength} 项上限`);
  }
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function normalizeUniqueStringArray(
  value: unknown,
  maximumLength: number,
  label: string,
  options: { sorted?: boolean; nonEmpty?: boolean } = {},
): string[] {
  assertArray(value, maximumLength, label);
  if (options.nonEmpty && value.length === 0) throw new Error(`${label} 必须是非空数组`);
  const result = value.map((item, index) => {
    assertBoundedString(item, `${label}[${index}]`);
    return item;
  });
  const seen = new Set<string>();
  for (const item of result) {
    if (seen.has(item)) throw new Error(`${label} 包含重复项 ${item}`);
    seen.add(item);
  }
  if (options.sorted) result.sort(compareStrings);
  return result;
}

function normalizeSortedUniqueStrings(
  value: unknown,
  maximumLength: number,
  label: string,
): string[] {
  const result = normalizeUniqueStringArray(value, maximumLength, label);
  for (let index = 1; index < result.length; index += 1) {
    if (compareStrings(result[index - 1], result[index]) >= 0) {
      throw new Error(`${label} 重复或未按字典序严格排列`);
    }
  }
  return result;
}

function normalizeSortedUniqueIntegers(
  value: unknown,
  maximumLength: number,
  maximumValue: number,
  label: string,
): number[] {
  assertArray(value, maximumLength, label);
  const result: number[] = [];
  let previous = -1;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    assertSafeIntegerInRange(item, 0, maximumValue, `${label}[${index}]`);
    if (item <= previous) throw new Error(`${label} 重复或未按数值严格递增`);
    result.push(item);
    previous = item;
  }
  return result;
}

function normalizeTarget(value: unknown, label: string): ObserverDerivedHistoryTarget {
  assertRecord(value, label);
  assertExactKeys(value, ['stateHash', 'eventCount', 'tailEventId'], label);
  assertHash(value.stateHash, `${label}.stateHash`);
  assertSafeIntegerInRange(value.eventCount, 0, Number.MAX_SAFE_INTEGER, `${label}.eventCount`);
  if (value.eventCount === 0) {
    if (value.tailEventId !== null) throw new Error(`${label}.tailEventId 必须为空`);
  } else {
    assertBoundedString(value.tailEventId, `${label}.tailEventId`);
  }
  return {
    stateHash: value.stateHash,
    eventCount: value.eventCount,
    tailEventId: value.tailEventId as string | null,
  };
}

function sameTarget(
  left: ObserverDerivedHistoryTarget,
  right: ObserverDerivedHistoryTarget,
): boolean {
  return left.stateHash === right.stateHash
    && left.eventCount === right.eventCount
    && left.tailEventId === right.tailEventId;
}

function normalizeSourceDemand(value: unknown): NormalizedDemandState {
  assertRecord(value, 'observer derived sidecar sourceDemand');
  assertExactKeys(value, [
    'settledCultivationProjects',
    'residentialStructures',
    'retainedEventIds',
    'futureEventIds',
  ], 'observer derived sidecar sourceDemand');
  assertArray(
    value.settledCultivationProjects,
    OBSERVER_DERIVED_HISTORY_DEMAND_ENTITY_LIMIT,
    'observer derived sourceDemand.settledCultivationProjects',
  );
  assertArray(
    value.residentialStructures,
    OBSERVER_DERIVED_HISTORY_DEMAND_ENTITY_LIMIT,
    'observer derived sourceDemand.residentialStructures',
  );

  let totalReferences = 0;
  let totalSiteCells = 0;
  const projectIds = new Set<string>();
  const settledCultivationProjects = value.settledCultivationProjects.map((candidate, index) => {
    const label = `observer derived sourceDemand.settledCultivationProjects[${index}]`;
    assertRecord(candidate, label);
    assertExactKeys(candidate, [
      'projectId',
      'completedAtMonth',
      'siteCellIds',
      'actionEventIds',
      'completionEventIds',
    ], label);
    assertBoundedString(candidate.projectId, `${label}.projectId`);
    if (projectIds.has(candidate.projectId)) {
      throw new Error(`observer derived sourceDemand project ${candidate.projectId} 重复`);
    }
    projectIds.add(candidate.projectId);
    assertSafeIntegerInRange(
      candidate.completedAtMonth,
      0,
      Number.MAX_SAFE_INTEGER,
      `${label}.completedAtMonth`,
    );
    const siteCellIds = normalizeSortedUniqueIntegers(
      candidate.siteCellIds,
      OBSERVER_DERIVED_HISTORY_SPATIAL_KEY_LIMIT,
      WORLD_CELL_COUNT - 1,
      `${label}.siteCellIds`,
    );
    const actionEventIds = normalizeUniqueStringArray(
      candidate.actionEventIds,
      OBSERVER_DERIVED_HISTORY_DEMAND_REFERENCE_LIMIT,
      `${label}.actionEventIds`,
      { sorted: true },
    );
    const completionEventIds = normalizeUniqueStringArray(
      candidate.completionEventIds,
      OBSERVER_DERIVED_HISTORY_DEMAND_REFERENCE_LIMIT,
      `${label}.completionEventIds`,
    );
    const actionIds = new Set(actionEventIds);
    if (completionEventIds.some((eventId) => !actionIds.has(eventId))) {
      throw new Error(`${label}.completionEventIds 必须是 actionEventIds 的子集`);
    }
    totalReferences += actionEventIds.length + completionEventIds.length;
    totalSiteCells += siteCellIds.length;
    if (totalReferences > OBSERVER_DERIVED_HISTORY_DEMAND_REFERENCE_LIMIT) {
      throw new Error('observer derived sourceDemand cultivation references 超过上限');
    }
    if (totalSiteCells > OBSERVER_DERIVED_HISTORY_SPATIAL_KEY_LIMIT) {
      throw new Error('observer derived sourceDemand cultivation site cells 超过上限');
    }
    return {
      projectId: candidate.projectId,
      completedAtMonth: candidate.completedAtMonth,
      siteCellIds,
      actionEventIds,
      completionEventIds,
    };
  }).sort((left, right) => left.completedAtMonth - right.completedAtMonth
    || compareStrings(left.projectId, right.projectId));

  const structureIds = new Set<string>();
  const residentialStructures = value.residentialStructures.map((candidate, index) => {
    const label = `observer derived sourceDemand.residentialStructures[${index}]`;
    assertRecord(candidate, label);
    assertExactKeys(candidate, ['structureId', 'sourceEventIds'], label);
    assertBoundedString(candidate.structureId, `${label}.structureId`);
    if (structureIds.has(candidate.structureId)) {
      throw new Error(`observer derived sourceDemand structure ${candidate.structureId} 重复`);
    }
    structureIds.add(candidate.structureId);
    const sourceEventIds = normalizeUniqueStringArray(
      candidate.sourceEventIds,
      OBSERVER_DERIVED_HISTORY_DEMAND_REFERENCE_LIMIT,
      `${label}.sourceEventIds`,
    );
    totalReferences += sourceEventIds.length;
    if (totalReferences > OBSERVER_DERIVED_HISTORY_DEMAND_REFERENCE_LIMIT) {
      throw new Error('observer derived sourceDemand references 超过上限');
    }
    return { structureId: candidate.structureId, sourceEventIds };
  }).sort((left, right) => compareStrings(left.structureId, right.structureId));

  const retainedEventIds = normalizeUniqueStringArray(
    value.retainedEventIds,
    OBSERVER_DERIVED_HISTORY_DEMAND_REFERENCE_LIMIT,
    'observer derived sourceDemand.retainedEventIds',
    { sorted: true },
  );
  const futureEventIds = normalizeUniqueStringArray(
    value.futureEventIds,
    OBSERVER_DERIVED_HISTORY_DEMAND_REFERENCE_LIMIT,
    'observer derived sourceDemand.futureEventIds',
    { sorted: true },
  );
  totalReferences += retainedEventIds.length + futureEventIds.length;
  if (totalReferences > OBSERVER_DERIVED_HISTORY_DEMAND_REFERENCE_LIMIT) {
    throw new Error('observer derived sourceDemand references 超过上限');
  }

  const worldRequiredIds = new Set<string>([...retainedEventIds, ...futureEventIds]);
  const actionRequiredIds = new Set<string>(futureEventIds);
  for (const structure of residentialStructures) {
    structure.sourceEventIds.forEach((eventId) => worldRequiredIds.add(eventId));
  }
  for (const project of settledCultivationProjects) {
    project.actionEventIds.forEach((eventId) => actionRequiredIds.add(eventId));
    project.completionEventIds.forEach((eventId) => actionRequiredIds.add(eventId));
  }
  const trackedEventIds = [...new Set([...worldRequiredIds, ...actionRequiredIds])]
    .sort(compareStrings);
  if (trackedEventIds.length > OBSERVER_DERIVED_HISTORY_EVENT_BASIS_LIMIT) {
    throw new Error('observer derived sourceDemand event basis 超过上限');
  }
  const worldRequiredEventIds = [...worldRequiredIds].sort(compareStrings);
  const actionRequiredEventIds = [...actionRequiredIds].sort(compareStrings);
  const sourceDemand: ObserverDerivedHistoryCanonicalDemandV1 = {
    settledCultivationProjects,
    residentialStructures,
    retainedEventIds,
    futureEventIds,
  };
  return {
    sourceDemand,
    // Property order intentionally mirrors normalizeDemand in the projection.
    fingerprintBasis: {
      settledCultivationProjects,
      residentialStructures,
      retainedEventIds,
      futureEventIds,
      trackedEventIds,
      worldRequiredEventIds,
      actionRequiredEventIds,
    },
  };
}

function sourceDemandFingerprint(demand: NormalizedDemandState): string {
  return createHash('sha256')
    .update(`${OBSERVER_DERIVED_HISTORY_DEFINITION}\0`)
    .update(JSON.stringify(demand.fingerprintBasis))
    .digest('hex');
}

function registerEvidenceIdentity(
  registry: EvidenceIdentityRegistry,
  evidence: ObserverHistoryEvidenceRef,
  label: string,
): void {
  const existing = registry.byAbsoluteIndex.get(evidence.absoluteIndex);
  if (existing !== undefined && !sameEvidence(existing, evidence)) {
    throw new Error(`${label} 与 absoluteIndex ${evidence.absoluteIndex} 的 evidence identity 冲突`);
  }
  // Duplicate event IDs at different ordinals are legal last-write history.
  registry.byAbsoluteIndex.set(evidence.absoluteIndex, evidence);
}

function normalizeEvidence(
  value: unknown,
  target: ObserverDerivedHistoryTarget,
  lastEventMonth: number | null,
  registry: EvidenceIdentityRegistry,
  label: string,
): ObserverHistoryEvidenceRef {
  assertRecord(value, label);
  const hasWho = Object.prototype.hasOwnProperty.call(value, 'who');
  assertExactKeys(value, hasWho
    ? ['absoluteIndex', 'eventId', 'atMonth', 'who']
    : ['absoluteIndex', 'eventId', 'atMonth'], label);
  assertSafeIntegerInRange(
    value.absoluteIndex,
    0,
    target.eventCount - 1,
    `${label}.absoluteIndex`,
  );
  assertBoundedString(value.eventId, `${label}.eventId`);
  assertSafeIntegerInRange(
    value.atMonth,
    0,
    lastEventMonth ?? -1,
    `${label}.atMonth`,
  );
  if (hasWho) assertBoundedString(value.who, `${label}.who`);
  if (value.absoluteIndex === target.eventCount - 1
    && (value.eventId !== target.tailEventId || value.atMonth !== lastEventMonth)) {
    throw new Error(`${label} 与 target 尾事件不一致`);
  }
  const evidence: ObserverHistoryEvidenceRef = {
    absoluteIndex: value.absoluteIndex,
    eventId: value.eventId,
    atMonth: value.atMonth,
    ...(hasWho ? { who: value.who as string } : {}),
  };
  registerEvidenceIdentity(registry, evidence, label);
  return evidence;
}

function normalizeEvidenceArray(
  value: unknown,
  observedCount: number,
  target: ObserverDerivedHistoryTarget,
  lastEventMonth: number | null,
  registry: EvidenceIdentityRegistry,
  label: string,
  options: { orderedByAbsoluteIndex?: boolean } = {},
): ObserverHistoryEvidenceRef[] {
  assertArray(value, OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT, label);
  const expectedLength = Math.min(observedCount, OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT);
  if (value.length !== expectedLength) {
    throw new Error(`${label} 未精确保存 bounded first evidence`);
  }
  const result: ObserverHistoryEvidenceRef[] = [];
  const ordinals = new Set<number>();
  let previousAbsoluteIndex = -1;
  for (let index = 0; index < value.length; index += 1) {
    const evidence = normalizeEvidence(
      value[index],
      target,
      lastEventMonth,
      registry,
      `${label}[${index}]`,
    );
    if (ordinals.has(evidence.absoluteIndex)
      || (options.orderedByAbsoluteIndex !== false
        && evidence.absoluteIndex <= previousAbsoluteIndex)) {
      throw new Error(`${label} 的 absoluteIndex 重复或顺序无效`);
    }
    result.push(evidence);
    ordinals.add(evidence.absoluteIndex);
    previousAbsoluteIndex = evidence.absoluteIndex;
  }
  return result;
}

function normalizeObservedMonths(
  count: number,
  firstValue: unknown,
  lastValue: unknown,
  evidence: readonly ObserverHistoryEvidenceRef[],
  lastEventMonth: number | null,
  label: string,
): { firstObservedMonth: number | null; lastObservedMonth: number | null } {
  if (count === 0) {
    if (firstValue !== null || lastValue !== null || evidence.length !== 0) {
      throw new Error(`${label} 的零计数与月份/evidence 不一致`);
    }
    return { firstObservedMonth: null, lastObservedMonth: null };
  }
  assertSafeIntegerInRange(firstValue, 0, lastEventMonth ?? -1, `${label}.firstObservedMonth`);
  assertSafeIntegerInRange(lastValue, firstValue, lastEventMonth ?? -1, `${label}.lastObservedMonth`);
  if (evidence[0]?.atMonth !== firstValue
    || evidence.some((item) => item.atMonth < firstValue || item.atMonth > lastValue)
    || (count <= OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT
      && evidence[evidence.length - 1]?.atMonth !== lastValue)) {
    throw new Error(`${label} 的月份范围与 bounded evidence 不一致`);
  }
  return { firstObservedMonth: firstValue, lastObservedMonth: lastValue };
}

function normalizePractice(
  value: unknown,
  key: ObserverPracticeKey,
  target: ObserverDerivedHistoryTarget,
  lastEventMonth: number | null,
  registry: EvidenceIdentityRegistry,
): ObserverPracticeHistory {
  const label = `observer derived projection.practices.${key}`;
  assertRecord(value, label);
  assertExactKeys(value, [
    'key',
    'count',
    'firstObservedMonth',
    'lastObservedMonth',
    'agentIds',
    'evidence',
  ], label);
  if (value.key !== key) throw new Error(`${label}.key 无效`);
  assertSafeIntegerInRange(value.count, 0, target.eventCount, `${label}.count`);
  const agentIds = normalizeSortedUniqueStrings(
    value.agentIds,
    OBSERVER_DERIVED_HISTORY_IDENTITY_MEMBERSHIP_LIMIT,
    `${label}.agentIds`,
  );
  const evidence = normalizeEvidenceArray(
    value.evidence,
    value.count,
    target,
    lastEventMonth,
    registry,
    `${label}.evidence`,
  );
  const months = normalizeObservedMonths(
    value.count,
    value.firstObservedMonth,
    value.lastObservedMonth,
    evidence,
    lastEventMonth,
    label,
  );
  if ((value.count === 0) !== (agentIds.length === 0) || agentIds.length > value.count) {
    throw new Error(`${label}.agentIds 与 count 不一致`);
  }
  return { key, count: value.count, ...months, agentIds, evidence };
}

function normalizeTrailRegion(
  value: unknown,
  target: ObserverDerivedHistoryTarget,
  lastEventMonth: number | null,
  registry: EvidenceIdentityRegistry,
): ObserverDerivedHistoryProjection['regions']['trail'] {
  const label = 'observer derived projection.regions.trail';
  assertRecord(value, label);
  assertExactKeys(value, [
    'formationActionCount',
    'changedCellCount',
    'cellIds',
    'firstObservedMonth',
    'lastObservedMonth',
    'evidence',
  ], label);
  assertSafeIntegerInRange(
    value.formationActionCount,
    0,
    target.eventCount,
    `${label}.formationActionCount`,
  );
  assertSafeIntegerInRange(
    value.changedCellCount,
    value.formationActionCount,
    Number.MAX_SAFE_INTEGER,
    `${label}.changedCellCount`,
  );
  if (value.changedCellCount > target.eventCount * OBSERVER_DERIVED_HISTORY_EVENT_COLLECTION_LIMIT) {
    throw new Error(`${label}.changedCellCount 超出逐事件 collection 上限`);
  }
  const cellIds = normalizeSortedUniqueIntegers(
    value.cellIds,
    OBSERVER_DERIVED_HISTORY_SPATIAL_KEY_LIMIT,
    WORLD_CELL_COUNT - 1,
    `${label}.cellIds`,
  );
  if (cellIds.length > value.changedCellCount) throw new Error(`${label}.cellIds 多于 changedCellCount`);
  const evidence = normalizeEvidenceArray(
    value.evidence,
    value.formationActionCount,
    target,
    lastEventMonth,
    registry,
    `${label}.evidence`,
  );
  const months = normalizeObservedMonths(
    value.formationActionCount,
    value.firstObservedMonth,
    value.lastObservedMonth,
    evidence,
    lastEventMonth,
    label,
  );
  return {
    formationActionCount: value.formationActionCount,
    changedCellCount: value.changedCellCount,
    cellIds,
    ...months,
    evidence,
  };
}

function normalizeCultivatedRegion(
  value: unknown,
  target: ObserverDerivedHistoryTarget,
  lastEventMonth: number | null,
  registry: EvidenceIdentityRegistry,
): ObserverDerivedHistoryProjection['regions']['cultivated'] {
  const label = 'observer derived projection.regions.cultivated';
  assertRecord(value, label);
  assertExactKeys(value, [
    'plantingActionCount',
    'harvestActionCount',
    'cellIds',
    'firstObservedMonth',
    'lastObservedMonth',
    'evidence',
  ], label);
  assertSafeIntegerInRange(value.plantingActionCount, 0, target.eventCount, `${label}.plantingActionCount`);
  assertSafeIntegerInRange(value.harvestActionCount, 0, target.eventCount, `${label}.harvestActionCount`);
  const count = value.plantingActionCount + value.harvestActionCount;
  if (!Number.isSafeInteger(count) || count > target.eventCount) {
    throw new Error(`${label} 的 planting/harvest 总数超过 eventCount`);
  }
  const cellIds = normalizeSortedUniqueIntegers(
    value.cellIds,
    OBSERVER_DERIVED_HISTORY_SPATIAL_KEY_LIMIT,
    WORLD_CELL_COUNT - 1,
    `${label}.cellIds`,
  );
  if (cellIds.length > count) throw new Error(`${label}.cellIds 多于 cultivation actions`);
  const evidence = normalizeEvidenceArray(
    value.evidence,
    count,
    target,
    lastEventMonth,
    registry,
    `${label}.evidence`,
  );
  const months = normalizeObservedMonths(
    count,
    value.firstObservedMonth,
    value.lastObservedMonth,
    evidence,
    lastEventMonth,
    label,
  );
  return {
    plantingActionCount: value.plantingActionCount,
    harvestActionCount: value.harvestActionCount,
    cellIds,
    ...months,
    evidence,
  };
}

function sameEvidence(
  left: ObserverHistoryEvidenceRef | null,
  right: ObserverHistoryEvidenceRef | null,
): boolean {
  return left === null
    ? right === null
    : right !== null
      && left.absoluteIndex === right.absoluteIndex
      && left.eventId === right.eventId
      && left.atMonth === right.atMonth
      && left.who === right.who;
}

function sameEvidenceArray(
  left: readonly ObserverHistoryEvidenceRef[],
  right: readonly ObserverHistoryEvidenceRef[],
): boolean {
  return left.length === right.length && left.every((item, index) => sameEvidence(item, right[index]));
}

function normalizeResidentialRegions(
  value: unknown,
  target: ObserverDerivedHistoryTarget,
  lastEventMonth: number | null,
  registry: EvidenceIdentityRegistry,
): ObserverResidentialRegionHistory[] {
  assertArray(
    value,
    OBSERVER_DERIVED_HISTORY_DEMAND_ENTITY_LIMIT,
    'observer derived projection.regions.residential',
  );
  const result: ObserverResidentialRegionHistory[] = [];
  let previousId: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    const label = `observer derived projection.regions.residential[${index}]`;
    assertRecord(candidate, label);
    assertExactKeys(candidate, [
      'structureId',
      'sourceRank',
      'firstObservedMonth',
      'sourceEvidence',
    ], label);
    assertBoundedString(candidate.structureId, `${label}.structureId`);
    if (previousId !== null && compareStrings(previousId, candidate.structureId) >= 0) {
      throw new Error('observer derived residential structures 重复或未严格排序');
    }
    let sourceRank: number | null = null;
    let sourceEvidence: ObserverHistoryEvidenceRef | null = null;
    if (candidate.sourceRank === null) {
      if (candidate.firstObservedMonth !== null || candidate.sourceEvidence !== null) {
        throw new Error(`${label} 的空 source 与 month/evidence 不一致`);
      }
    } else {
      assertSafeIntegerInRange(
        candidate.sourceRank,
        0,
        OBSERVER_DERIVED_HISTORY_DEMAND_REFERENCE_LIMIT - 1,
        `${label}.sourceRank`,
      );
      sourceRank = candidate.sourceRank;
      sourceEvidence = normalizeEvidence(
        candidate.sourceEvidence,
        target,
        lastEventMonth,
        registry,
        `${label}.sourceEvidence`,
      );
      if (candidate.firstObservedMonth !== sourceEvidence.atMonth) {
        throw new Error(`${label}.firstObservedMonth 与 sourceEvidence 不一致`);
      }
    }
    result.push({
      structureId: candidate.structureId,
      sourceRank,
      firstObservedMonth: sourceEvidence?.atMonth ?? null,
      sourceEvidence,
    });
    previousId = candidate.structureId;
  }
  return result;
}

function normalizeFacility(
  value: unknown,
  target: ObserverDerivedHistoryTarget,
  lastEventMonth: number | null,
  registry: EvidenceIdentityRegistry,
  label: string,
): ObserverFunctionalBuildingHistory {
  assertRecord(value, label);
  assertExactKeys(value, [
    'id',
    'kind',
    'materialId',
    'cellId',
    'z',
    'installedAtMonth',
    'installationCount',
    'installationEvidence',
    'useCount',
    'userIds',
    'useEvidence',
  ], label);
  assertBoundedString(value.id, `${label}.id`);
  if (!FUNCTIONAL_BUILDING_KINDS.includes(value.kind as ObserverFunctionalBuildingKind)) {
    throw new Error(`${label}.kind 无效`);
  }
  assertSafeIntegerInRange(value.materialId, 0, Number.MAX_SAFE_INTEGER, `${label}.materialId`);
  if (!MATERIAL_IDS.has(value.materialId)) throw new Error(`${label}.materialId 不在 material palette`);
  const match = FACILITY_ID_PATTERN.exec(value.id);
  if (!match) throw new Error(`${label}.id 不是 canonical facility ID`);
  const materialId = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  const z = Number(match[4]);
  assertSafeIntegerInRange(x, 0, WORLD_WIDTH - 1, `${label}.id.x`);
  assertSafeIntegerInRange(y, 0, WORLD_DEPTH - 1, `${label}.id.y`);
  assertSafeIntegerInRange(z, 0, WORLD_LEVELS - 1, `${label}.id.z`);
  assertSafeIntegerInRange(value.cellId, 0, WORLD_CELL_COUNT - 1, `${label}.cellId`);
  assertSafeIntegerInRange(value.z, 0, WORLD_LEVELS - 1, `${label}.z`);
  if (materialId !== value.materialId
    || z !== value.z
    || cellId(x, y) !== value.cellId
    || FACILITY_DEFINITIONS.get(materialId) !== value.kind) {
    throw new Error(`${label} 的 id/kind/material/position 不一致`);
  }
  assertSafeIntegerInRange(value.installationCount, 1, target.eventCount, `${label}.installationCount`);
  assertSafeIntegerInRange(value.installedAtMonth, 0, lastEventMonth ?? -1, `${label}.installedAtMonth`);
  const installationEvidence = normalizeEvidenceArray(
    value.installationEvidence,
    value.installationCount,
    target,
    lastEventMonth,
    registry,
    `${label}.installationEvidence`,
  );
  if (installationEvidence[0]?.atMonth !== value.installedAtMonth) {
    throw new Error(`${label}.installedAtMonth 与 installationEvidence 不一致`);
  }
  assertSafeIntegerInRange(value.useCount, 0, target.eventCount, `${label}.useCount`);
  const userIds = normalizeSortedUniqueStrings(
    value.userIds,
    OBSERVER_DERIVED_HISTORY_IDENTITY_MEMBERSHIP_LIMIT,
    `${label}.userIds`,
  );
  if ((value.useCount === 0) !== (userIds.length === 0) || userIds.length > value.useCount) {
    throw new Error(`${label}.userIds 与 useCount 不一致`);
  }
  const useEvidence = normalizeEvidenceArray(
    value.useEvidence,
    value.useCount,
    target,
    lastEventMonth,
    registry,
    `${label}.useEvidence`,
  );
  return {
    id: value.id,
    kind: value.kind as ObserverFunctionalBuildingKind,
    materialId: value.materialId,
    cellId: value.cellId,
    z: value.z,
    installedAtMonth: value.installedAtMonth,
    installationCount: value.installationCount,
    installationEvidence,
    useCount: value.useCount,
    userIds,
    useEvidence,
  };
}

function normalizeFacilities(
  value: unknown,
  target: ObserverDerivedHistoryTarget,
  lastEventMonth: number | null,
  registry: EvidenceIdentityRegistry,
): ObserverFunctionalBuildingHistory[] {
  assertArray(value, OBSERVER_DERIVED_HISTORY_FACILITY_LIMIT, 'observer derived projection.functionalBuildings');
  const result: ObserverFunctionalBuildingHistory[] = [];
  let previousId: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const facility = normalizeFacility(
      value[index],
      target,
      lastEventMonth,
      registry,
      `observer derived projection.functionalBuildings[${index}]`,
    );
    if (previousId !== null && compareStrings(previousId, facility.id) >= 0) {
      throw new Error('observer derived functionalBuildings 重复或未严格排序');
    }
    result.push(facility);
    previousId = facility.id;
  }
  return result;
}

function normalizeInstitution(
  value: unknown,
  kind: 'distributedTeaching' | 'repeatedInterment',
  target: ObserverDerivedHistoryTarget,
  lastEventMonth: number | null,
  registry: EvidenceIdentityRegistry,
): ObserverInstitutionBasisHistory {
  const label = `observer derived projection.institutions.${kind}`;
  assertRecord(value, label);
  assertExactKeys(value, [
    'actionCount',
    'actorIds',
    'participantIds',
    'firstObservedMonth',
    'lastObservedMonth',
    'institutionThresholdSatisfied',
    'evidence',
  ], label);
  assertSafeIntegerInRange(value.actionCount, 0, target.eventCount, `${label}.actionCount`);
  const actorIds = normalizeSortedUniqueStrings(
    value.actorIds,
    OBSERVER_DERIVED_HISTORY_IDENTITY_MEMBERSHIP_LIMIT,
    `${label}.actorIds`,
  );
  const participantIds = normalizeSortedUniqueStrings(
    value.participantIds,
    OBSERVER_DERIVED_HISTORY_IDENTITY_MEMBERSHIP_LIMIT,
    `${label}.participantIds`,
  );
  if ((value.actionCount === 0) !== (actorIds.length === 0)
    || actorIds.length > value.actionCount
    || actorIds.some((actorId) => !participantIds.includes(actorId))) {
    throw new Error(`${label} 的 actor/participant 与 actionCount 不一致`);
  }
  if (kind === 'repeatedInterment' && !sameStrings(actorIds, participantIds)) {
    throw new Error(`${label} 的 participantIds 必须等于 actorIds`);
  }
  const evidence = normalizeEvidenceArray(
    value.evidence,
    value.actionCount,
    target,
    lastEventMonth,
    registry,
    `${label}.evidence`,
  );
  const months = normalizeObservedMonths(
    value.actionCount,
    value.firstObservedMonth,
    value.lastObservedMonth,
    evidence,
    lastEventMonth,
    label,
  );
  assertBoolean(value.institutionThresholdSatisfied, `${label}.institutionThresholdSatisfied`);
  const span = months.firstObservedMonth === null || months.lastObservedMonth === null
    ? 0 : months.lastObservedMonth - months.firstObservedMonth;
  const expectedThreshold = kind === 'distributedTeaching'
    ? value.actionCount >= 6 && participantIds.length >= 3
    : value.actionCount >= 3 && actorIds.length >= 2 && span >= 12;
  if (value.institutionThresholdSatisfied !== expectedThreshold) {
    throw new Error(`${label}.institutionThresholdSatisfied 与投影规则不一致`);
  }
  return {
    actionCount: value.actionCount,
    actorIds,
    participantIds,
    ...months,
    institutionThresholdSatisfied: expectedThreshold,
    evidence,
  };
}

function normalizeCapability(
  value: unknown,
  key: ObserverMaterialCapabilityKey,
  target: ObserverDerivedHistoryTarget,
  lastEventMonth: number | null,
  registry: EvidenceIdentityRegistry,
): ObserverMaterialCapabilityHistory {
  const label = `observer derived projection.materialCapabilities.${key}`;
  assertRecord(value, label);
  assertExactKeys(value, [
    'key',
    'successfulBatchCount',
    'failedBatchCount',
    'adoptedActionCount',
    'firstSuccessfulMonth',
    'lastSuccessfulMonth',
    'producerIds',
    'productionSiteMaterialIds',
    'successfulBatchEvidence',
    'failedBatchEvidence',
    'adoptedActionEvidence',
  ], label);
  if (value.key !== key) throw new Error(`${label}.key 无效`);
  assertSafeIntegerInRange(value.successfulBatchCount, 0, target.eventCount, `${label}.successfulBatchCount`);
  assertSafeIntegerInRange(value.failedBatchCount, 0, target.eventCount, `${label}.failedBatchCount`);
  assertSafeIntegerInRange(value.adoptedActionCount, 0, target.eventCount, `${label}.adoptedActionCount`);
  const producerIds = normalizeSortedUniqueStrings(
    value.producerIds,
    OBSERVER_DERIVED_HISTORY_IDENTITY_MEMBERSHIP_LIMIT,
    `${label}.producerIds`,
  );
  if ((value.successfulBatchCount === 0) !== (producerIds.length === 0)
    || producerIds.length > value.successfulBatchCount) {
    throw new Error(`${label}.producerIds 与 successfulBatchCount 不一致`);
  }
  const productionSiteMaterialIds = normalizeSortedUniqueIntegers(
    value.productionSiteMaterialIds,
    OBSERVER_DERIVED_HISTORY_EVENT_COLLECTION_LIMIT,
    Number.MAX_SAFE_INTEGER,
    `${label}.productionSiteMaterialIds`,
  );
  if (productionSiteMaterialIds.some((materialId) => !MATERIAL_IDS.has(materialId)
    || !CAPABILITY_SITE_MATERIALS[key].has(materialId))) {
    throw new Error(`${label}.productionSiteMaterialIds 包含非该 capability 场所`);
  }
  const successfulBatchEvidence = normalizeEvidenceArray(
    value.successfulBatchEvidence,
    value.successfulBatchCount,
    target,
    lastEventMonth,
    registry,
    `${label}.successfulBatchEvidence`,
  );
  const successMonths = normalizeObservedMonths(
    value.successfulBatchCount,
    value.firstSuccessfulMonth,
    value.lastSuccessfulMonth,
    successfulBatchEvidence,
    lastEventMonth,
    label,
  );
  const failedBatchEvidence = normalizeEvidenceArray(
    value.failedBatchEvidence,
    value.failedBatchCount,
    target,
    lastEventMonth,
    registry,
    `${label}.failedBatchEvidence`,
  );
  const adoptedActionEvidence = normalizeEvidenceArray(
    value.adoptedActionEvidence,
    value.adoptedActionCount,
    target,
    lastEventMonth,
    registry,
    `${label}.adoptedActionEvidence`,
  );
  return {
    key,
    successfulBatchCount: value.successfulBatchCount,
    failedBatchCount: value.failedBatchCount,
    adoptedActionCount: value.adoptedActionCount,
    firstSuccessfulMonth: successMonths.firstObservedMonth,
    lastSuccessfulMonth: successMonths.lastObservedMonth,
    producerIds,
    productionSiteMaterialIds,
    successfulBatchEvidence,
    failedBatchEvidence,
    adoptedActionEvidence,
  };
}

function normalizePositionKey(value: unknown, label: string): { key: string; siteCellId: number } {
  assertBoundedString(value, label);
  const match = POSITION_KEY_PATTERN.exec(value);
  if (!match) throw new Error(`${label} 不是 canonical voxel position key`);
  const x = Number(match[1]);
  const y = Number(match[2]);
  const z = Number(match[3]);
  assertSafeIntegerInRange(x, 0, WORLD_WIDTH - 1, `${label}.x`);
  assertSafeIntegerInRange(y, 0, WORLD_DEPTH - 1, `${label}.y`);
  assertSafeIntegerInRange(z, 0, WORLD_LEVELS - 1, `${label}.z`);
  return { key: value, siteCellId: cellId(x, y) };
}

function normalizeCultivationBasis(
  value: unknown,
  eventId: string,
  worldEvidence: ObserverHistoryEvidenceRef | null,
  actionResolved: boolean,
  target: ObserverDerivedHistoryTarget,
  lastEventMonth: number | null,
  registry: EvidenceIdentityRegistry,
  label: string,
): ObserverCultivationEventBasis | null {
  if (value === null) return null;
  assertRecord(value, label);
  assertExactKeys(value, ['kind', 'positionKey', 'siteCellId', 'evidence'], label);
  if (value.kind !== 'planting' && value.kind !== 'harvest') throw new Error(`${label}.kind 无效`);
  const position = normalizePositionKey(value.positionKey, `${label}.positionKey`);
  assertSafeIntegerInRange(value.siteCellId, 0, WORLD_CELL_COUNT - 1, `${label}.siteCellId`);
  if (position.siteCellId !== value.siteCellId) throw new Error(`${label}.siteCellId 与 positionKey 不一致`);
  const evidence = normalizeEvidence(
    value.evidence,
    target,
    lastEventMonth,
    registry,
    `${label}.evidence`,
  );
  if (!actionResolved
    || worldEvidence === null
    || evidence.eventId !== eventId
    || evidence.absoluteIndex > worldEvidence.absoluteIndex
    || evidence.atMonth > worldEvidence.atMonth) {
    throw new Error(`${label} 与 demand basis resolution/world evidence 不一致`);
  }
  return {
    kind: value.kind,
    positionKey: position.key,
    siteCellId: value.siteCellId,
    evidence,
  };
}

function normalizeDemandEventBasis(
  value: unknown,
  demand: NormalizedDemandState,
  target: ObserverDerivedHistoryTarget,
  lastEventMonth: number | null,
  registry: EvidenceIdentityRegistry,
): ObserverDemandEventBasisEntry[] {
  assertArray(value, OBSERVER_DERIVED_HISTORY_EVENT_BASIS_LIMIT, 'observer derived projection.demandEventBasis');
  const trackedIds = demand.fingerprintBasis.trackedEventIds;
  if (value.length !== trackedIds.length) {
    throw new Error('observer derived projection.demandEventBasis 未完整覆盖 source demand closure');
  }
  const worldRequired = new Set(demand.fingerprintBasis.worldRequiredEventIds);
  const actionRequired = new Set(demand.fingerprintBasis.actionRequiredEventIds);
  const result: ObserverDemandEventBasisEntry[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    const label = `observer derived projection.demandEventBasis[${index}]`;
    assertRecord(candidate, label);
    assertExactKeys(candidate, [
      'eventId',
      'latestWorldEvidence',
      'worldLastWriteResolved',
      'latestCultivationAction',
      'actionLastWriteResolved',
    ], label);
    if (candidate.eventId !== trackedIds[index]) {
      throw new Error(`${label}.eventId 缺失、重复或未按 demand closure 排序`);
    }
    assertBoolean(candidate.worldLastWriteResolved, `${label}.worldLastWriteResolved`);
    assertBoolean(candidate.actionLastWriteResolved, `${label}.actionLastWriteResolved`);
    if (candidate.actionLastWriteResolved && !candidate.worldLastWriteResolved) {
      throw new Error(`${label} 的 action resolution 不得先于 world resolution`);
    }
    if (worldRequired.has(candidate.eventId) && !candidate.worldLastWriteResolved) {
      throw new Error(`${label} 未解析 required world last-write`);
    }
    if (actionRequired.has(candidate.eventId) && !candidate.actionLastWriteResolved) {
      throw new Error(`${label} 未解析 required action last-write`);
    }
    const latestWorldEvidence = candidate.latestWorldEvidence === null
      ? null
      : normalizeEvidence(
        candidate.latestWorldEvidence,
        target,
        lastEventMonth,
        registry,
        `${label}.latestWorldEvidence`,
      );
    if (latestWorldEvidence !== null
      && (!candidate.worldLastWriteResolved || latestWorldEvidence.eventId !== candidate.eventId)) {
      throw new Error(`${label}.latestWorldEvidence 与 eventId/resolution 不一致`);
    }
    const latestCultivationAction = normalizeCultivationBasis(
      candidate.latestCultivationAction,
      candidate.eventId,
      latestWorldEvidence,
      candidate.actionLastWriteResolved,
      target,
      lastEventMonth,
      registry,
      `${label}.latestCultivationAction`,
    );
    result.push({
      eventId: candidate.eventId,
      latestWorldEvidence,
      worldLastWriteResolved: candidate.worldLastWriteResolved,
      latestCultivationAction,
      actionLastWriteResolved: candidate.actionLastWriteResolved,
    });
  }
  return result;
}

function assertResidentialDerivedSemantics(
  residential: readonly ObserverResidentialRegionHistory[],
  demand: NormalizedDemandState,
  basis: readonly ObserverDemandEventBasisEntry[],
): void {
  const sourceStructures = demand.sourceDemand.residentialStructures;
  if (residential.length !== sourceStructures.length) {
    throw new Error('observer derived residential projection 未完整覆盖 source demand');
  }
  const basisById = new Map(basis.map((entry) => [entry.eventId, entry]));
  for (let index = 0; index < sourceStructures.length; index += 1) {
    const source = sourceStructures[index];
    const actual = residential[index];
    if (actual.structureId !== source.structureId) {
      throw new Error('observer derived residential projection 与 source demand 排序不一致');
    }
    let expectedRank: number | null = null;
    let expectedEvidence: ObserverHistoryEvidenceRef | null = null;
    for (let rank = 0; rank < source.sourceEventIds.length; rank += 1) {
      const evidence = basisById.get(source.sourceEventIds[rank])?.latestWorldEvidence ?? null;
      if (evidence === null) continue;
      expectedRank = rank;
      expectedEvidence = evidence;
      break;
    }
    if (actual.sourceRank !== expectedRank
      || !sameEvidence(actual.sourceEvidence, expectedEvidence)
      || actual.firstObservedMonth !== (expectedEvidence?.atMonth ?? null)) {
      throw new Error(`observer derived residential ${source.structureId} 未保持 first-match 语义`);
    }
  }
}

function normalizeSettledCultivationProjects(
  value: unknown,
  target: ObserverDerivedHistoryTarget,
  lastEventMonth: number | null,
  registry: EvidenceIdentityRegistry,
): ObserverSettledCultivationProjectHistory[] {
  assertArray(
    value,
    OBSERVER_DERIVED_HISTORY_DEMAND_ENTITY_LIMIT,
    'observer derived projection.settledCultivationProjects',
  );
  const result: ObserverSettledCultivationProjectHistory[] = [];
  let previous: { completedAtMonth: number; projectId: string } | null = null;
  let totalPlantingWitnesses = 0;
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    const label = `observer derived projection.settledCultivationProjects[${index}]`;
    assertRecord(candidate, label);
    assertExactKeys(candidate, [
      'projectId',
      'completedAtMonth',
      'distinctPlantingPositionCount',
      'harvestCountAtPlantedPositions',
      'plantingWitnesses',
      'harvestWitnesses',
    ], label);
    assertBoundedString(candidate.projectId, `${label}.projectId`);
    assertSafeIntegerInRange(candidate.completedAtMonth, 0, Number.MAX_SAFE_INTEGER, `${label}.completedAtMonth`);
    if (previous && (previous.completedAtMonth > candidate.completedAtMonth
      || (previous.completedAtMonth === candidate.completedAtMonth
        && compareStrings(previous.projectId, candidate.projectId) >= 0))) {
      throw new Error('observer derived settled cultivation projects 重复或未严格排序');
    }
    assertArray(
      candidate.plantingWitnesses,
      OBSERVER_DERIVED_HISTORY_SPATIAL_KEY_LIMIT,
      `${label}.plantingWitnesses`,
    );
    totalPlantingWitnesses += candidate.plantingWitnesses.length;
    if (totalPlantingWitnesses > OBSERVER_DERIVED_HISTORY_SPATIAL_KEY_LIMIT) {
      throw new Error('observer derived planting witnesses 超过全局 spatial 上限');
    }
    const positions = new Set<string>();
    const plantingWitnesses = candidate.plantingWitnesses.map((item, witnessIndex) => {
      const witnessLabel = `${label}.plantingWitnesses[${witnessIndex}]`;
      assertRecord(item, witnessLabel);
      assertExactKeys(item, ['positionKey', 'event'], witnessLabel);
      const position = normalizePositionKey(item.positionKey, `${witnessLabel}.positionKey`);
      if (positions.has(position.key)) throw new Error(`${label}.plantingWitnesses position 重复`);
      positions.add(position.key);
      return {
        positionKey: position.key,
        event: normalizeEvidence(
          item.event,
          target,
          lastEventMonth,
          registry,
          `${witnessLabel}.event`,
        ),
      };
    });
    assertSafeIntegerInRange(
      candidate.distinctPlantingPositionCount,
      0,
      OBSERVER_DERIVED_HISTORY_SPATIAL_KEY_LIMIT,
      `${label}.distinctPlantingPositionCount`,
    );
    if (candidate.distinctPlantingPositionCount !== plantingWitnesses.length) {
      throw new Error(`${label}.distinctPlantingPositionCount 与 witnesses 不一致`);
    }
    assertSafeIntegerInRange(
      candidate.harvestCountAtPlantedPositions,
      0,
      target.eventCount,
      `${label}.harvestCountAtPlantedPositions`,
    );
    const harvestWitnesses = normalizeEvidenceArray(
      candidate.harvestWitnesses,
      candidate.harvestCountAtPlantedPositions,
      target,
      lastEventMonth,
      registry,
      `${label}.harvestWitnesses`,
      { orderedByAbsoluteIndex: false },
    );
    result.push({
      projectId: candidate.projectId,
      completedAtMonth: candidate.completedAtMonth,
      distinctPlantingPositionCount: candidate.distinctPlantingPositionCount,
      harvestCountAtPlantedPositions: candidate.harvestCountAtPlantedPositions,
      plantingWitnesses,
      harvestWitnesses,
    });
    previous = { completedAtMonth: candidate.completedAtMonth, projectId: candidate.projectId };
  }
  return result;
}

function expectedCultivationProjects(
  demand: NormalizedDemandState,
  basis: readonly ObserverDemandEventBasisEntry[],
): ObserverSettledCultivationProjectHistory[] {
  const basisById = new Map(basis.map((entry) => [entry.eventId, entry]));
  return demand.sourceDemand.settledCultivationProjects.map((project) => {
    const plantingByPosition = new Map<string, ObserverHistoryEvidenceRef>();
    const siteCells = new Set(project.siteCellIds);
    for (const eventId of project.completionEventIds) {
      const candidate = basisById.get(eventId)?.latestCultivationAction;
      if (!candidate
        || candidate.kind !== 'planting'
        || !siteCells.has(candidate.siteCellId)
        || plantingByPosition.has(candidate.positionKey)) continue;
      plantingByPosition.set(candidate.positionKey, candidate.evidence);
    }
    let harvestCountAtPlantedPositions = 0;
    const harvestWitnesses: ObserverHistoryEvidenceRef[] = [];
    for (const eventId of project.completionEventIds) {
      const candidate = basisById.get(eventId)?.latestCultivationAction;
      if (!candidate
        || candidate.kind !== 'harvest'
        || !siteCells.has(candidate.siteCellId)
        || !plantingByPosition.has(candidate.positionKey)) continue;
      harvestCountAtPlantedPositions += 1;
      if (harvestWitnesses.length < OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT) {
        harvestWitnesses.push(candidate.evidence);
      }
    }
    return {
      projectId: project.projectId,
      completedAtMonth: project.completedAtMonth,
      distinctPlantingPositionCount: plantingByPosition.size,
      harvestCountAtPlantedPositions,
      plantingWitnesses: [...plantingByPosition].map(([positionKey, event]) => ({ positionKey, event })),
      harvestWitnesses,
    };
  });
}

function sameCultivationProject(
  left: ObserverSettledCultivationProjectHistory,
  right: ObserverSettledCultivationProjectHistory,
): boolean {
  return left.projectId === right.projectId
    && left.completedAtMonth === right.completedAtMonth
    && left.distinctPlantingPositionCount === right.distinctPlantingPositionCount
    && left.harvestCountAtPlantedPositions === right.harvestCountAtPlantedPositions
    && left.plantingWitnesses.length === right.plantingWitnesses.length
    && left.plantingWitnesses.every((item, index) => (
      item.positionKey === right.plantingWitnesses[index].positionKey
      && sameEvidence(item.event, right.plantingWitnesses[index].event)
    ))
    && sameEvidenceArray(left.harvestWitnesses, right.harvestWitnesses);
}

function normalizeEstablishedCultivationWitness(
  value: unknown,
  target: ObserverDerivedHistoryTarget,
  lastEventMonth: number | null,
  registry: EvidenceIdentityRegistry,
): ObserverEstablishedCultivationWitness | null {
  if (value === null) return null;
  const label = 'observer derived projection.establishedCultivationWitness';
  assertRecord(value, label);
  assertExactKeys(value, ['projectId', 'plantingEvidence', 'harvestEvidence'], label);
  assertBoundedString(value.projectId, `${label}.projectId`);
  const plantingEvidence = normalizeEvidenceArray(
    value.plantingEvidence,
    6,
    target,
    lastEventMonth,
    registry,
    `${label}.plantingEvidence`,
    { orderedByAbsoluteIndex: false },
  );
  const harvestEvidence = normalizeEvidenceArray(
    value.harvestEvidence,
    2,
    target,
    lastEventMonth,
    registry,
    `${label}.harvestEvidence`,
    { orderedByAbsoluteIndex: false },
  );
  return { projectId: value.projectId, plantingEvidence, harvestEvidence };
}

function expectedEstablishedWitness(
  projects: readonly ObserverSettledCultivationProjectHistory[],
): ObserverEstablishedCultivationWitness | null {
  const project = projects.find((candidate) => candidate.distinctPlantingPositionCount >= 6
    && candidate.harvestCountAtPlantedPositions >= 2);
  return project ? {
    projectId: project.projectId,
    plantingEvidence: project.plantingWitnesses.slice(0, 6).map((item) => item.event),
    harvestEvidence: project.harvestWitnesses.slice(0, 2),
  } : null;
}

function sameEstablishedWitness(
  left: ObserverEstablishedCultivationWitness | null,
  right: ObserverEstablishedCultivationWitness | null,
): boolean {
  return left === null
    ? right === null
    : right !== null
      && left.projectId === right.projectId
      && sameEvidenceArray(left.plantingEvidence, right.plantingEvidence)
      && sameEvidenceArray(left.harvestEvidence, right.harvestEvidence);
}

function normalizeContinuationGaps(value: unknown): string[] {
  assertArray(value, CONTINUATION_GAPS.length, 'observer derived projection.continuationGaps');
  if (value.length !== CONTINUATION_GAPS.length) {
    throw new Error('observer derived projection.continuationGaps 缺失或包含未知 gap');
  }
  return value.map((item, index) => {
    assertBoundedString(
      item,
      `observer derived projection.continuationGaps[${index}]`,
      MAX_OBSERVER_DERIVED_HISTORY_SIDECAR_GAP_BYTES,
    );
    if (item !== CONTINUATION_GAPS[index]) {
      throw new Error('observer derived projection.continuationGaps 缺失、重复、未知或顺序无效');
    }
    return item;
  });
}

function normalizeProjection(
  value: unknown,
  demand: NormalizedDemandState,
): ObserverDerivedHistoryProjection {
  assertRecord(value, 'observer derived projection');
  assertExactKeys(value, [
    'schemaVersion',
    'definitionVersion',
    'target',
    'reducedThrough',
    'demandFingerprint',
    'lastEventMonth',
    'practices',
    'regions',
    'functionalBuildings',
    'institutions',
    'materialCapabilities',
    'demandEventBasis',
    'settledCultivationProjects',
    'establishedCultivationWitness',
    'continuationReady',
    'continuationGaps',
  ], 'observer derived projection');
  if (value.schemaVersion !== 2) throw new Error('observer derived projection.schemaVersion 必须是 2');
  if (value.definitionVersion !== OBSERVER_DERIVED_HISTORY_DEFINITION) {
    throw new Error('observer derived projection.definitionVersion 无效');
  }
  const target = normalizeTarget(value.target, 'observer derived projection.target');
  assertRecord(value.reducedThrough, 'observer derived projection.reducedThrough');
  assertExactKeys(
    value.reducedThrough,
    ['eventCount', 'tailEventId'],
    'observer derived projection.reducedThrough',
  );
  assertSafeIntegerInRange(
    value.reducedThrough.eventCount,
    0,
    Number.MAX_SAFE_INTEGER,
    'observer derived projection.reducedThrough.eventCount',
  );
  if (value.reducedThrough.eventCount !== target.eventCount
    || value.reducedThrough.tailEventId !== target.tailEventId) {
    throw new Error('observer derived projection.reducedThrough 未精确 seal target');
  }
  assertHash(value.demandFingerprint, 'observer derived projection.demandFingerprint');
  if (value.demandFingerprint !== sourceDemandFingerprint(demand)) {
    throw new Error('observer derived projection.demandFingerprint 与 canonical sourceDemand 不一致');
  }
  let lastEventMonth: number | null;
  if (target.eventCount === 0) {
    if (value.lastEventMonth !== null) throw new Error('空 observer derived projection.lastEventMonth 必须为空');
    lastEventMonth = null;
  } else {
    assertSafeIntegerInRange(
      value.lastEventMonth,
      0,
      Number.MAX_SAFE_INTEGER,
      'observer derived projection.lastEventMonth',
    );
    lastEventMonth = value.lastEventMonth;
  }
  const registry: EvidenceIdentityRegistry = { byAbsoluteIndex: new Map() };

  assertRecord(value.practices, 'observer derived projection.practices');
  assertExactKeys(value.practices, PRACTICE_KEYS, 'observer derived projection.practices');
  const practices = {
    transfer: normalizePractice(value.practices.transfer, 'transfer', target, lastEventMonth, registry),
    storage: normalizePractice(value.practices.storage, 'storage', target, lastEventMonth, registry),
    travel: normalizePractice(value.practices.travel, 'travel', target, lastEventMonth, registry),
    cultivation: normalizePractice(value.practices.cultivation, 'cultivation', target, lastEventMonth, registry),
    'mortuary-care': normalizePractice(
      value.practices['mortuary-care'],
      'mortuary-care',
      target,
      lastEventMonth,
      registry,
    ),
  };
  if (practices.storage.count > practices.transfer.count) {
    throw new Error('observer derived storage practice count 超过 transfer count');
  }

  assertRecord(value.regions, 'observer derived projection.regions');
  assertExactKeys(value.regions, ['trail', 'cultivated', 'residential'], 'observer derived projection.regions');
  const regions = {
    trail: normalizeTrailRegion(value.regions.trail, target, lastEventMonth, registry),
    cultivated: normalizeCultivatedRegion(value.regions.cultivated, target, lastEventMonth, registry),
    residential: normalizeResidentialRegions(value.regions.residential, target, lastEventMonth, registry),
  };
  const functionalBuildings = normalizeFacilities(
    value.functionalBuildings,
    target,
    lastEventMonth,
    registry,
  );

  assertRecord(value.institutions, 'observer derived projection.institutions');
  assertExactKeys(
    value.institutions,
    ['distributedTeaching', 'repeatedInterment'],
    'observer derived projection.institutions',
  );
  const institutions = {
    distributedTeaching: normalizeInstitution(
      value.institutions.distributedTeaching,
      'distributedTeaching',
      target,
      lastEventMonth,
      registry,
    ),
    repeatedInterment: normalizeInstitution(
      value.institutions.repeatedInterment,
      'repeatedInterment',
      target,
      lastEventMonth,
      registry,
    ),
  };

  assertRecord(value.materialCapabilities, 'observer derived projection.materialCapabilities');
  assertExactKeys(
    value.materialCapabilities,
    CAPABILITY_KEYS,
    'observer derived projection.materialCapabilities',
  );
  const materialCapabilities = {
    'processed-wood': normalizeCapability(
      value.materialCapabilities['processed-wood'],
      'processed-wood',
      target,
      lastEventMonth,
      registry,
    ),
    'masonry-stone': normalizeCapability(
      value.materialCapabilities['masonry-stone'],
      'masonry-stone',
      target,
      lastEventMonth,
      registry,
    ),
    bronze: normalizeCapability(
      value.materialCapabilities.bronze,
      'bronze',
      target,
      lastEventMonth,
      registry,
    ),
    iron: normalizeCapability(
      value.materialCapabilities.iron,
      'iron',
      target,
      lastEventMonth,
      registry,
    ),
  };

  const demandEventBasis = normalizeDemandEventBasis(
    value.demandEventBasis,
    demand,
    target,
    lastEventMonth,
    registry,
  );
  assertResidentialDerivedSemantics(regions.residential, demand, demandEventBasis);
  const settledCultivationProjects = normalizeSettledCultivationProjects(
    value.settledCultivationProjects,
    target,
    lastEventMonth,
    registry,
  );
  const expectedProjects = expectedCultivationProjects(demand, demandEventBasis);
  if (settledCultivationProjects.length !== expectedProjects.length
    || settledCultivationProjects.some((project, index) => !sameCultivationProject(project, expectedProjects[index]))) {
    throw new Error('observer derived settled cultivation witnesses 与 source demand/event basis 不一致');
  }
  const establishedCultivationWitness = normalizeEstablishedCultivationWitness(
    value.establishedCultivationWitness,
    target,
    lastEventMonth,
    registry,
  );
  if (!sameEstablishedWitness(
    establishedCultivationWitness,
    expectedEstablishedWitness(settledCultivationProjects),
  )) {
    throw new Error('observer derived established cultivation witness 不是首个满足阈值的项目');
  }
  if (value.continuationReady !== false) {
    throw new Error('observer derived projection.continuationReady 必须保持 false');
  }
  const continuationGaps = normalizeContinuationGaps(value.continuationGaps);

  const identityMembershipCount = PRACTICE_KEYS.reduce(
    (sum, key) => sum + practices[key].agentIds.length,
    0,
  ) + functionalBuildings.reduce((sum, facility) => sum + facility.userIds.length, 0)
    + institutions.distributedTeaching.actorIds.length
    + institutions.distributedTeaching.participantIds.length
    + institutions.repeatedInterment.actorIds.length
    + institutions.repeatedInterment.participantIds.length
    + CAPABILITY_KEYS.reduce(
      (sum, key) => sum + materialCapabilities[key].producerIds.length,
      0,
    );
  if (identityMembershipCount > OBSERVER_DERIVED_HISTORY_IDENTITY_MEMBERSHIP_LIMIT) {
    throw new Error('observer derived projection identity memberships 超过全局上限');
  }

  return {
    schemaVersion: 2,
    definitionVersion: OBSERVER_DERIVED_HISTORY_DEFINITION,
    target,
    reducedThrough: { eventCount: target.eventCount, tailEventId: target.tailEventId },
    demandFingerprint: value.demandFingerprint,
    lastEventMonth,
    practices,
    regions,
    functionalBuildings,
    institutions,
    materialCapabilities,
    demandEventBasis,
    settledCultivationProjects,
    establishedCultivationWitness,
    continuationReady: false,
    continuationGaps,
  };
}

function normalizeSidecarInput(value: unknown): ObserverDerivedHistorySidecarPayloadV1 {
  assertRecord(value, 'observer derived sidecar input');
  assertExactKeys(value, ['sourceDemand', 'projection'], 'observer derived sidecar input');
  const demand = normalizeSourceDemand(value.sourceDemand);
  return {
    schemaVersion: OBSERVER_DERIVED_HISTORY_SIDECAR_SCHEMA_VERSION,
    domain: OBSERVER_DERIVED_HISTORY_SIDECAR_DOMAIN,
    sourceDemand: demand.sourceDemand,
    projection: normalizeProjection(value.projection, demand),
  };
}

function normalizeStoredSidecar(value: unknown): ObserverDerivedHistorySidecarPayloadV1 {
  assertRecord(value, 'observer derived sidecar');
  assertExactKeys(
    value,
    ['schemaVersion', 'domain', 'sourceDemand', 'projection'],
    'observer derived sidecar',
  );
  if (value.schemaVersion !== OBSERVER_DERIVED_HISTORY_SIDECAR_SCHEMA_VERSION) {
    throw new Error('observer derived sidecar.schemaVersion 无效');
  }
  if (value.domain !== OBSERVER_DERIVED_HISTORY_SIDECAR_DOMAIN) {
    throw new Error('observer derived sidecar.domain 无效');
  }
  const demand = normalizeSourceDemand(value.sourceDemand);
  return {
    schemaVersion: OBSERVER_DERIVED_HISTORY_SIDECAR_SCHEMA_VERSION,
    domain: OBSERVER_DERIVED_HISTORY_SIDECAR_DOMAIN,
    sourceDemand: demand.sourceDemand,
    projection: normalizeProjection(value.projection, demand),
  };
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value)
    .sort()
    .map((key) => [key, canonicalJsonValue(value[key])]));
}

function canonicalBytes(sidecar: ObserverDerivedHistorySidecarPayloadV1): Buffer {
  return Buffer.from(JSON.stringify(canonicalJsonValue(sidecar)), 'utf8');
}

function deepFreeze<T>(value: T, visited = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  const object = value as object;
  if (visited.has(object)) return value;
  visited.add(object);
  for (const child of Object.values(object as UnknownRecord)) deepFreeze(child, visited);
  return Object.freeze(value);
}

export function hashObserverDerivedHistoryStoredContent(
  codec: string,
  data: Uint8Array,
): string {
  return createHash('sha256').update(codec).update('\0').update(data).digest('hex');
}

function ownedChunk(
  hash: string,
  codec: string,
  rawSize: number,
  data: Buffer | Uint8Array,
): Readonly<ObserverDerivedHistorySidecarChunk> {
  assertHash(hash, 'observer derived sidecar chunk.hash');
  if (codec !== OBSERVER_DERIVED_HISTORY_SIDECAR_CODEC) {
    throw new Error('observer derived sidecar chunk.codec 无效');
  }
  assertSafeIntegerInRange(rawSize, 1, Number.MAX_SAFE_INTEGER, 'observer derived sidecar chunk.rawSize');
  if (rawSize > MAX_OBSERVER_DERIVED_HISTORY_SIDECAR_STORED_BYTES) {
    throw new Error(
      `observer derived sidecar 存储内容超过硬上限 ${MAX_OBSERVER_DERIVED_HISTORY_SIDECAR_STORED_BYTES}`,
    );
  }
  if (!(Buffer.isBuffer(data) || data instanceof Uint8Array)) {
    throw new Error('observer derived sidecar chunk.data 必须是字节数组');
  }
  if (data.byteLength !== rawSize) throw new Error('observer derived sidecar chunk 长度与记录不一致');
  const ownedData = Buffer.from(data);
  return Object.freeze({
    hash,
    codec,
    rawSize,
    get data(): Buffer { return Buffer.from(ownedData); },
  });
}

/**
 * Encode validated source demand plus projection into canonical owned bytes.
 * The returned digest is only a content-address candidate; it is not a store
 * authority token and cannot publish a continuation.
 */
export function encodeObserverDerivedHistorySidecar(
  input: unknown,
): Readonly<EncodedObserverDerivedHistorySidecar> {
  const sidecar = deepFreeze(normalizeSidecarInput(input));
  const data = canonicalBytes(sidecar);
  if (data.byteLength > MAX_OBSERVER_DERIVED_HISTORY_SIDECAR_STORED_BYTES) {
    throw new Error(
      `observer derived sidecar 存储内容超过硬上限 ${MAX_OBSERVER_DERIVED_HISTORY_SIDECAR_STORED_BYTES}`,
    );
  }
  const hash = hashObserverDerivedHistoryStoredContent(
    OBSERVER_DERIVED_HISTORY_SIDECAR_CODEC,
    data,
  );
  const chunk = ownedChunk(
    hash,
    OBSERVER_DERIVED_HISTORY_SIDECAR_CODEC,
    data.byteLength,
    data,
  );
  const reference = Object.freeze({
    kind: 'content-hash' as const,
    codec: OBSERVER_DERIVED_HISTORY_SIDECAR_CODEC,
    hash,
  });
  return Object.freeze({ chunk, reference, sidecar });
}

function normalizeBoundary(value: unknown): ObserverDerivedHistorySidecarBoundaryV1 {
  assertRecord(value, 'observer derived sidecar expected boundary');
  assertExactKeys(value, ['target'], 'observer derived sidecar expected boundary');
  return { target: normalizeTarget(value.target, 'observer derived sidecar expected boundary.target') };
}

function normalizeDecodeExpectation(
  value: unknown,
): ObserverDerivedHistorySidecarDecodeExpectationV1 {
  assertRecord(value, 'observer derived sidecar decode expectation');
  assertExactKeys(value, ['reference', 'boundary'], 'observer derived sidecar decode expectation');
  assertRecord(value.reference, 'observer derived sidecar expected reference');
  assertExactKeys(
    value.reference,
    ['kind', 'codec', 'hash'],
    'observer derived sidecar expected reference',
  );
  if (value.reference.kind !== 'content-hash') {
    throw new Error('observer derived sidecar 只接受 store-selected content-hash 引用');
  }
  if (value.reference.codec !== OBSERVER_DERIVED_HISTORY_SIDECAR_CODEC) {
    throw new Error('observer derived sidecar expected reference.codec 无效');
  }
  assertHash(value.reference.hash, 'observer derived sidecar expected reference.hash');
  return {
    reference: {
      kind: 'content-hash',
      codec: OBSERVER_DERIVED_HISTORY_SIDECAR_CODEC,
      hash: value.reference.hash,
    },
    boundary: normalizeBoundary(value.boundary),
  };
}

/**
 * Decode only bytes bound to the reference and exact target selected by the
 * owning store. Passing a caller-computed digest as `expectedInput` does not
 * make it authoritative; future store integration must keep that selection
 * behind its private CAS token.
 */
export function decodeObserverDerivedHistorySidecar(
  chunk: ObserverDerivedHistorySidecarChunk,
  expectedInput: unknown,
): Readonly<ObserverDerivedHistorySidecarPayloadV1> {
  const expected = normalizeDecodeExpectation(expectedInput);
  if (!chunk || typeof chunk !== 'object') throw new Error('observer derived sidecar chunk 必须是对象');
  if (chunk.codec !== expected.reference.codec || chunk.hash !== expected.reference.hash) {
    throw new Error('observer derived sidecar chunk 不属于 store-selected content reference');
  }
  const snapshot = ownedChunk(chunk.hash, chunk.codec, chunk.rawSize, chunk.data);
  const data = Buffer.from(snapshot.data);
  if (hashObserverDerivedHistoryStoredContent(snapshot.codec, data) !== snapshot.hash) {
    throw new Error(`observer derived sidecar chunk ${snapshot.hash} 的 SHA-256 校验失败`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`observer derived sidecar chunk ${snapshot.hash} 无法解析`, { cause: error });
  }
  const sidecar = normalizeStoredSidecar(parsed);
  if (!data.equals(canonicalBytes(sidecar))) {
    throw new Error('observer derived sidecar payload 不是 canonical UTF-8 JSON 编码');
  }
  if (!sameTarget(sidecar.projection.target, expected.boundary.target)) {
    throw new Error('observer derived sidecar payload 与 store-selected exact target 不一致');
  }
  const decoded = deepFreeze(sidecar);
  decodedObserverDerivedHistorySidecars.add(decoded);
  return decoded;
}

/** Take an owned byte snapshot before a future store authority flow awaits. */
export function snapshotObserverDerivedHistorySidecarChunk(
  chunk: ObserverDerivedHistorySidecarChunk,
): Readonly<ObserverDerivedHistorySidecarChunk> {
  if (!chunk || typeof chunk !== 'object') throw new Error('observer derived sidecar chunk 必须是对象');
  return ownedChunk(chunk.hash, chunk.codec, chunk.rawSize, chunk.data);
}
