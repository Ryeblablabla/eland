import { createHash } from 'node:crypto';
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
} from 'node:zlib';

import {
  HISTORY_RETENTION_MAX_ACTIVE_PROJECT_ACTION_EVENT_IDS,
  HISTORY_RETENTION_MAX_CALIBRATION_INSTRUMENTS,
  HISTORY_RETENTION_MAX_CALIBRATION_INSTRUMENTS_PER_PERSON,
  HISTORY_RETENTION_MAX_LIVE_GAMEPLAY_SELECTOR_PERSONS,
  HISTORY_RETENTION_MAX_LIVE_INTENT_CORE_EVENT_IDS,
  HISTORY_RETENTION_MAX_LIVE_PERSON_SOCIAL_EVENT_IDS,
  HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_SOURCE_GROUPS,
  HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_SOURCE_EVENT_IDS,
  HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_UNIQUE_EVENT_IDS,
  HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_PER_PERSON,
  HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_TOTAL,
  HISTORY_RETENTION_MAX_SOCIAL_LEARNING_EVENT_IDS_PER_PERSON,
  HISTORY_RETENTION_MAX_SOCIAL_LEARNING_EVENT_IDS_TOTAL,
  HISTORY_RETENTION_MAX_LIVE_PROJECT_PRESSURE_SOURCE_EVENT_IDS,
  HISTORY_RETENTION_MAX_FUTURE_FAMILY_STORED_FOOD_SOURCE_EVENT_IDS,
  HISTORY_RETENTION_MAX_FUTURE_SOCIAL_REPETITION_SOURCE_EVENT_IDS,
  HISTORY_RETENTION_MAX_FUTURE_COGNITIVE_APPRAISAL_SOURCE_EVENT_IDS,
  HISTORY_RETENTION_MAX_FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_EVENT_IDS,
  HISTORY_RETENTION_MAX_FUTURE_MATERIAL_AFFORDANCE_SOURCE_EVENT_IDS,
  HISTORY_RETENTION_MAX_MEASUREMENT_STACK_SOURCE_EVENT_IDS,
  HISTORY_RETENTION_MAX_PENDING_PREDICTION_WAKE_MATCHES,
  HISTORY_RETENTION_MAX_REPRODUCTION_ATTEMPT_EVENT_IDS,
  HISTORY_RETENTION_REQUIREMENTS,
  type HistoryRetentionAuthority,
  type HistoryRetentionContinuationDemand,
  type HistoryRetentionContinuationMatch,
  type HistoryRetentionDemandGroupResult,
  type HistoryRetentionPin,
  type HistoryRetentionProjectionResult,
  type HistoryRetentionSeal,
  type HistoryRetentionSummary,
  type MechanicalTeachingOperationWitness,
  type UnresolvedHistoryRetentionDemand,
  LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY,
  FUTURE_FAMILY_STORED_FOOD_SOURCE_LEASE_KEY,
  FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY,
  FUTURE_COGNITIVE_APPRAISAL_SOURCE_LEASE_KEY,
  FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_LEASE_KEY,
  FUTURE_MATERIAL_AFFORDANCE_SOURCE_LEASE_KEY,
  calibrationLeaseKeysFromDemandGroups,
  assertProjectPressureHistoryRetentionDemandGroups,
  assertLiveIntentHistoryRetentionDemandGroups,
  waterAssistanceSelectiveLeaseKeysFromDemandGroups,
  historyRetentionDemandFingerprint,
  historyRetentionRequirementBlocks,
  historyRetentionRequirementPinsResolvedEvents,
  parseGroundedConversationResponseSourceLeaseKey,
  parseRecentTerminalFailureActionLeaseKey,
  parseSocialLearningSourceLeaseKey,
  productionWindowMonthFromDemandGroups,
} from './history-retention-contract';
import {
  GROUNDED_CONVERSATION_RESPONSE_WINDOW_MONTHS,
  parseGroundedConversationWindowLeaseKey,
  parseWaterAssistanceFulfillmentMembershipGroupKey,
} from '../src/game/eland/domain/event-index';
import {
  livePersonSocialEvidenceLeaseKey,
  livePersonSocialStrictEvidenceLeaseKey,
  parseLivePersonSocialEvidenceGroupKey,
} from '../src/game/eland/domain/live-social-evidence';
import {
  parseRecentPersonalProductionLaborSelectorLeaseKey,
  RECENT_PERSONAL_PRODUCTION_MONTHS,
  recentPersonalProductionLaborLeaseKey,
} from '../src/game/eland/domain/production-tool';
import { parsePersonalMassCalibrationLeaseKey } from '../src/game/eland/domain/actions/measurement-actions';
import {
  MODERN_ELECTRICAL_USEFUL_LOAD_LEASE_KEY,
  MODERN_RECORD_EXPERIMENT_LEASE_KEY,
  parseModernElectricalUsefulLoadLeaseKey,
} from '../src/game/eland/domain/era-progression';
import { hashRunContinuationStoredContent } from './run-continuation-bundle';

/**
 * Canonical, typed persistence codec for one exact retention projection.
 * Integrity is deliberately separate from store authority: decoding requires
 * both the content reference and the exact authority/target boundary selected
 * by the owning continuation store.
 */
export const HISTORY_RETENTION_SIDECAR_LEGACY_CODEC =
  'eland-history-retention-projection-json-v1';
export const HISTORY_RETENTION_SIDECAR_CODEC =
  'eland-history-retention-projection-json-brotli-v2';
export const HISTORY_RETENTION_SIDECAR_SCHEMA_VERSION = 1 as const;

/** Fail closed instead of allowing a retention sidecar to grow without bound. */
export const MAX_HISTORY_RETENTION_SIDECAR_STORED_BYTES = 8 * 1_024 * 1_024;
export const MAX_HISTORY_RETENTION_SIDECAR_CANONICAL_BYTES = 32 * 1_024 * 1_024;
export const MAX_HISTORY_RETENTION_SIDECAR_IDENTIFIER_BYTES = 4_096;
export const MAX_HISTORY_RETENTION_SIDECAR_DESCRIPTION_BYTES = 16 * 1_024;

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const BROTLI_OPTIONS = {
  params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
} as const;
const CONTINUATION_GAP_CODES = [
  'dynamic-pending-era-prediction',
  'dynamic-non-birth-person',
  'mutated-reproduction-selector',
  'bounded-pending-era-prediction-wakes',
  'bounded-active-project-action-history',
  'unsealed-exact-root-lineage',
] as const;

type UnknownRecord = Record<string, unknown>;
type HistoryRetentionRequirementValue = typeof HISTORY_RETENTION_REQUIREMENTS[number];

export interface HistoryRetentionSidecarChunk {
  hash: string;
  codec: string;
  /** Stored-byte length. V1 is JSON; current writes are bounded Brotli bytes. */
  rawSize: number;
  data: Buffer | Uint8Array;
}

export interface HistoryRetentionSidecarContentReferenceV1 {
  kind: 'content-hash';
  codec: typeof HISTORY_RETENTION_SIDECAR_CODEC
    | typeof HISTORY_RETENTION_SIDECAR_LEGACY_CODEC;
  hash: string;
}

export interface HistoryRetentionSidecarBoundaryV1 {
  authority: Readonly<HistoryRetentionAuthority>;
  target: Readonly<HistoryRetentionSeal>;
}

export interface HistoryRetentionSidecarDecodeExpectationV1 {
  /** Must be selected from the exact continuation bundle by the owning store. */
  reference: Readonly<HistoryRetentionSidecarContentReferenceV1>;
  /** Must be selected from the same exact run/root store snapshot. */
  boundary: Readonly<HistoryRetentionSidecarBoundaryV1>;
}

export interface EncodedHistoryRetentionSidecar {
  chunk: Readonly<HistoryRetentionSidecarChunk>;
  reference: Readonly<HistoryRetentionSidecarContentReferenceV1>;
  projection: Readonly<HistoryRetentionProjectionResult>;
}

/**
 * Process-local provenance for payloads which passed the strict content
 * reference and exact authority/target decoder boundary. A canonical object
 * with the same enumerable fields is deliberately insufficient for an
 * incremental successor.
 */
const decodedHistoryRetentionSidecars = new WeakSet<object>();

export function assertDecodedHistoryRetentionSidecar(
  value: unknown,
): asserts value is Readonly<HistoryRetentionProjectionResult> {
  if (!value || typeof value !== 'object' || !decodedHistoryRetentionSidecars.has(value)) {
    throw new Error('retention successor source 必须来自 strict sidecar decoder');
  }
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

function assertSafeIntegerAtLeast(
  value: unknown,
  minimum: number,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${label} 必须是大于等于 ${minimum} 的安全整数`);
  }
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} 必须是布尔值`);
}

function assertHistoryRetentionRequirement(
  value: unknown,
  label: string,
): asserts value is HistoryRetentionRequirementValue {
  if (typeof value !== 'string'
    || !HISTORY_RETENTION_REQUIREMENTS.includes(value as HistoryRetentionRequirementValue)) {
    throw new Error(`${label} 无效`);
  }
}

function assertBoundedString(
  value: unknown,
  label: string,
  maximumBytes = MAX_HISTORY_RETENTION_SIDECAR_IDENTIFIER_BYTES,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} 必须是非空字符串`);
  }
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new Error(`${label} 超过 ${maximumBytes} 字节上限`);
  }
}

function assertStringArray(
  value: unknown,
  label: string,
  options: { sorted?: boolean; nonEmpty?: boolean } = {},
): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
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
  if (options.sorted) {
    const sorted = [...result].sort();
    if (sorted.some((item, index) => item !== result[index])) {
      throw new Error(`${label} 必须按字典序排列`);
    }
  }
  return result;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function sameSeal(left: HistoryRetentionSeal, right: HistoryRetentionSeal): boolean {
  return left.eventCount === right.eventCount && left.tailEventId === right.tailEventId;
}

function sameAuthority(
  left: HistoryRetentionAuthority,
  right: HistoryRetentionAuthority,
): boolean {
  return left.stateHash === right.stateHash;
}

function normalizeAuthority(value: unknown, label: string): HistoryRetentionAuthority {
  assertRecord(value, label);
  assertExactKeys(value, ['stateHash'], label);
  assertHash(value.stateHash, `${label}.stateHash`);
  return { stateHash: value.stateHash };
}

function normalizeSeal(value: unknown, label: string): HistoryRetentionSeal {
  assertRecord(value, label);
  assertExactKeys(value, ['eventCount', 'tailEventId'], label);
  assertSafeIntegerAtLeast(value.eventCount, 0, `${label}.eventCount`);
  if (value.eventCount === 0) {
    if (value.tailEventId !== null) throw new Error(`${label}.tailEventId 必须为空`);
  } else {
    assertBoundedString(value.tailEventId, `${label}.tailEventId`);
  }
  return { eventCount: value.eventCount, tailEventId: value.tailEventId as string | null };
}

function normalizeMatch(
  value: unknown,
  target: HistoryRetentionSeal,
  label: string,
): HistoryRetentionContinuationMatch {
  assertRecord(value, label);
  assertExactKeys(value, ['absoluteIndex', 'eventId'], label);
  assertSafeIntegerAtLeast(value.absoluteIndex, 0, `${label}.absoluteIndex`);
  if (value.absoluteIndex >= target.eventCount) {
    throw new Error(`${label}.absoluteIndex 超出目标 history seal`);
  }
  assertBoundedString(value.eventId, `${label}.eventId`);
  return { absoluteIndex: value.absoluteIndex, eventId: value.eventId };
}

function normalizeWitness(
  value: unknown,
  target: HistoryRetentionSeal,
  label: string,
): MechanicalTeachingOperationWitness | null {
  if (value === null) return null;
  assertRecord(value, label);
  assertExactKeys(value, [
    'audienceId',
    'teachingAbsoluteIndex',
    'teachingEventId',
    'operationAbsoluteIndex',
    'operationEventId',
  ], label);
  assertBoundedString(value.audienceId, `${label}.audienceId`);
  const teaching = normalizeMatch({
    absoluteIndex: value.teachingAbsoluteIndex,
    eventId: value.teachingEventId,
  }, target, `${label}.teaching`);
  const operation = normalizeMatch({
    absoluteIndex: value.operationAbsoluteIndex,
    eventId: value.operationEventId,
  }, target, `${label}.operation`);
  if (teaching.absoluteIndex >= operation.absoluteIndex) {
    throw new Error(`${label} 的教学必须早于独立操作`);
  }
  return {
    audienceId: value.audienceId,
    teachingAbsoluteIndex: teaching.absoluteIndex,
    teachingEventId: teaching.eventId,
    operationAbsoluteIndex: operation.absoluteIndex,
    operationEventId: operation.eventId,
  };
}

const MECHANICAL_COUNT_KEYS = [
  'millLaborActions',
  'waterCurrentObservations',
  'componentInstallations',
  'loadedOperations',
  'serviceOperations',
  'faultEvents',
  'commissioningFaults',
  'wornDriveShaftFaults',
  'faultDiagnoses',
  'repairs',
  'recoveryOperations',
  'completedExplicitMechanicalTeachings',
  'independentTaughtOperatorWitnesses',
] as const;

function normalizeSummary(
  value: unknown,
  target: HistoryRetentionSeal,
  label: string,
): HistoryRetentionSummary {
  assertRecord(value, label);
  assertExactKeys(value, [
    'schemaVersion',
    'reducedThrough',
    'ruleDecisions',
    'modelDecisions',
    'mechanicalTeachingOperationAchieved',
    'mechanicalP0',
  ], label);
  if (value.schemaVersion !== 1) throw new Error(`${label}.schemaVersion 无效`);
  const reducedThrough = normalizeSeal(value.reducedThrough, `${label}.reducedThrough`);
  if (!sameSeal(reducedThrough, target)) throw new Error(`${label} 未精确归约到目标 history seal`);
  assertSafeIntegerAtLeast(value.ruleDecisions, 0, `${label}.ruleDecisions`);
  assertSafeIntegerAtLeast(value.modelDecisions, 0, `${label}.modelDecisions`);
  if (value.ruleDecisions + value.modelDecisions > target.eventCount) {
    throw new Error(`${label} 的 decision 累计超过历史事件数`);
  }
  assertBoolean(
    value.mechanicalTeachingOperationAchieved,
    `${label}.mechanicalTeachingOperationAchieved`,
  );
  const mechanicalP0Value = value.mechanicalP0;
  assertRecord(mechanicalP0Value, `${label}.mechanicalP0`);
  assertExactKeys(mechanicalP0Value, MECHANICAL_COUNT_KEYS, `${label}.mechanicalP0`);
  const mechanicalP0 = Object.fromEntries(MECHANICAL_COUNT_KEYS.map((key) => {
    const count = mechanicalP0Value[key];
    assertSafeIntegerAtLeast(count, 0, `${label}.mechanicalP0.${key}`);
    if (count > target.eventCount) {
      throw new Error(`${label}.mechanicalP0.${key} 超过历史事件数`);
    }
    return [key, count];
  })) as unknown as HistoryRetentionSummary['mechanicalP0'];
  if (mechanicalP0.serviceOperations > mechanicalP0.loadedOperations
    || mechanicalP0.commissioningFaults + mechanicalP0.wornDriveShaftFaults
      > mechanicalP0.faultEvents) {
    throw new Error(`${label}.mechanicalP0 的累计包含关系无效`);
  }
  return {
    schemaVersion: 1,
    reducedThrough,
    ruleDecisions: value.ruleDecisions,
    modelDecisions: value.modelDecisions,
    mechanicalTeachingOperationAchieved: value.mechanicalTeachingOperationAchieved,
    mechanicalP0,
  };
}

function normalizePins(value: unknown, target: HistoryRetentionSeal): HistoryRetentionPin[] {
  if (!Array.isArray(value)) throw new Error('retention projection.pins 必须是数组');
  const pins: HistoryRetentionPin[] = [];
  const eventIds = new Set<string>();
  let previousOrdinal = -1;
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    const label = `retention projection.pins[${index}]`;
    assertRecord(candidate, label);
    assertExactKeys(candidate, ['absoluteIndex', 'eventId', 'leaseKeys'], label);
    const match = normalizeMatch({
      absoluteIndex: candidate.absoluteIndex,
      eventId: candidate.eventId,
    }, target, label);
    if (match.absoluteIndex <= previousOrdinal) {
      throw new Error('retention projection.pins 的 absoluteIndex 重复或未严格递增');
    }
    if (eventIds.has(match.eventId)) {
      throw new Error(`retention projection.pins 的 eventId ${match.eventId} 重复`);
    }
    const leaseKeys = assertStringArray(candidate.leaseKeys, `${label}.leaseKeys`, {
      sorted: true,
      nonEmpty: true,
    });
    pins.push({ ...match, leaseKeys });
    eventIds.add(match.eventId);
    previousOrdinal = match.absoluteIndex;
  }
  return pins;
}

function normalizeDemandGroups(value: unknown): HistoryRetentionDemandGroupResult[] {
  if (!Array.isArray(value)) throw new Error('retention projection.demandGroups 必须是数组');
  const groups: HistoryRetentionDemandGroupResult[] = [];
  let previousGroupKey: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    const label = `retention projection.demandGroups[${index}]`;
    assertRecord(candidate, label);
    assertExactKeys(candidate, [
      'groupKey',
      'requirement',
      'leaseKeys',
      'eventIds',
      'resolvedEventIds',
      'unresolvedEventIds',
      'satisfied',
      'blocking',
    ], label);
    assertBoundedString(candidate.groupKey, `${label}.groupKey`);
    if (previousGroupKey !== null && previousGroupKey.localeCompare(candidate.groupKey) >= 0) {
      throw new Error('retention projection.demandGroups 的 groupKey 重复或未严格排序');
    }
    assertHistoryRetentionRequirement(candidate.requirement, `${label}.requirement`);
    const leaseKeys = assertStringArray(candidate.leaseKeys, `${label}.leaseKeys`, {
      sorted: true,
      nonEmpty: true,
    });
    const eventIds = assertStringArray(candidate.eventIds, `${label}.eventIds`, {
      nonEmpty: candidate.groupKey !== LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY
        && parseWaterAssistanceFulfillmentMembershipGroupKey(candidate.groupKey) === null,
    });
    const resolvedEventIds = assertStringArray(
      candidate.resolvedEventIds,
      `${label}.resolvedEventIds`,
    );
    const unresolvedEventIds = assertStringArray(
      candidate.unresolvedEventIds,
      `${label}.unresolvedEventIds`,
    );
    const eventSet = new Set(eventIds);
    const resolvedSet = new Set(resolvedEventIds);
    const unresolvedSet = new Set(unresolvedEventIds);
    if (resolvedEventIds.some((eventId) => !eventSet.has(eventId) || unresolvedSet.has(eventId))
      || unresolvedEventIds.some((eventId) => !eventSet.has(eventId))
      || resolvedSet.size + unresolvedSet.size !== eventSet.size) {
      throw new Error(`${label} 的 resolved/unresolved partition 无效`);
    }
    assertBoolean(candidate.satisfied, `${label}.satisfied`);
    assertBoolean(candidate.blocking, `${label}.blocking`);
    const satisfied = candidate.requirement === 'any'
      ? resolvedEventIds.length > 0
      : unresolvedEventIds.length === 0;
    const blocking = historyRetentionRequirementBlocks(candidate.requirement) && !satisfied;
    if (candidate.satisfied !== satisfied || candidate.blocking !== blocking) {
      throw new Error(`${label} 的 satisfied/blocking 语义无效`);
    }
    groups.push({
      groupKey: candidate.groupKey,
      requirement: candidate.requirement as HistoryRetentionDemandGroupResult['requirement'],
      leaseKeys,
      eventIds,
      resolvedEventIds,
      unresolvedEventIds,
      satisfied,
      blocking,
    });
    previousGroupKey = candidate.groupKey;
  }
  waterAssistanceSelectiveLeaseKeysFromDemandGroups(groups);
  return groups;
}

function normalizeUnresolvedDemands(
  value: unknown,
  groups: readonly HistoryRetentionDemandGroupResult[],
): UnresolvedHistoryRetentionDemand[] {
  if (!Array.isArray(value)) throw new Error('retention projection.unresolvedDemands 必须是数组');
  const groupsByKey = new Map(groups.map((group) => [group.groupKey, group]));
  const unresolvedIdsByGroup = new Map(groups.map((group) => [
    group.groupKey,
    new Set(group.unresolvedEventIds),
  ]));
  const unresolved: UnresolvedHistoryRetentionDemand[] = [];
  let previousGroupKey: string | null = null;
  let previousEventId: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    const label = `retention projection.unresolvedDemands[${index}]`;
    assertRecord(candidate, label);
    assertExactKeys(candidate, [
      'eventId',
      'leaseKeys',
      'requirement',
      'groupKey',
      'blocking',
    ], label);
    assertBoundedString(candidate.eventId, `${label}.eventId`);
    assertBoundedString(candidate.groupKey, `${label}.groupKey`);
    assertHistoryRetentionRequirement(candidate.requirement, `${label}.requirement`);
    assertBoolean(candidate.blocking, `${label}.blocking`);
    const leaseKeys = assertStringArray(candidate.leaseKeys, `${label}.leaseKeys`, {
      sorted: true,
      nonEmpty: true,
    });
    const group = groupsByKey.get(candidate.groupKey);
    if (!group
      || !unresolvedIdsByGroup.get(candidate.groupKey)?.has(candidate.eventId)
      || candidate.requirement !== group.requirement
      || candidate.blocking !== group.blocking
      || !sameStrings(leaseKeys, group.leaseKeys)) {
      throw new Error(`${label} 与 demand group 不一致`);
    }
    if (previousGroupKey !== null && (previousGroupKey.localeCompare(candidate.groupKey) > 0
      || (previousGroupKey === candidate.groupKey
        && previousEventId !== null
        && previousEventId.localeCompare(candidate.eventId) >= 0))) {
      throw new Error('retention projection.unresolvedDemands 重复或未严格排序');
    }
    unresolved.push({
      eventId: candidate.eventId,
      leaseKeys,
      requirement: candidate.requirement as UnresolvedHistoryRetentionDemand['requirement'],
      groupKey: candidate.groupKey,
      blocking: candidate.blocking,
    });
    previousGroupKey = candidate.groupKey;
    previousEventId = candidate.eventId;
  }
  const expected = groups.flatMap((group) => group.unresolvedEventIds.map((eventId) => ({
    groupKey: group.groupKey,
    eventId,
  }))).sort((left, right) => left.groupKey.localeCompare(right.groupKey)
    || left.eventId.localeCompare(right.eventId));
  if (unresolved.length !== expected.length
    || unresolved.some((item, index) => item.groupKey !== expected[index].groupKey
      || item.eventId !== expected[index].eventId)) {
    throw new Error('retention projection.unresolvedDemands 未完整覆盖 group 缺口');
  }
  return unresolved;
}

function normalizeSourceDemand(
  value: unknown,
  options: {
    allowLegacyMissingProjectPressure?: boolean;
    allowLegacyFutureSocialRepetitionAudit?: boolean;
    allowLegacyLivePersonSocialAll?: boolean;
  } = {},
): HistoryRetentionContinuationDemand {
  assertRecord(value, 'retention continuation sourceDemand');
  assertExactKeys(value, [
    'groups',
    'millLaborPersonIds',
    'pendingEraPredictionIds',
    'livingChildIds',
    'reproductionFacts',
  ], 'retention continuation sourceDemand');
  if (!Array.isArray(value.groups)) throw new Error('retention continuation sourceDemand.groups 必须是数组');
  const groups: HistoryRetentionContinuationDemand['groups'] = [];
  let previousGroupKey: string | null = null;
  let groundedResponseSourceGroupCount = 0;
  const groundedResponseSourceEventIds = new Set<string>();
  let recentTerminalFailureGroupCount = 0;
  let recentTerminalFailureEventIdCount = 0;
  const recentTerminalFailureOwnerIds = new Set<string>();
  let socialLearningGroupCount = 0;
  let socialLearningEventIdMembershipCount = 0;
  const socialLearningObserverIds = new Set<string>();
  for (let index = 0; index < value.groups.length; index += 1) {
    const candidate = value.groups[index];
    const label = `retention continuation sourceDemand.groups[${index}]`;
    assertRecord(candidate, label);
    assertExactKeys(candidate, ['groupKey', 'requirement', 'leaseKeys', 'eventIds'], label);
    assertBoundedString(candidate.groupKey, `${label}.groupKey`);
    if (previousGroupKey !== null && previousGroupKey.localeCompare(candidate.groupKey) >= 0) {
      throw new Error('retention continuation sourceDemand.groups 重复或未严格排序');
    }
    assertHistoryRetentionRequirement(candidate.requirement, `${label}.requirement`);
    const leaseKeys = assertStringArray(candidate.leaseKeys, `${label}.leaseKeys`, {
      sorted: true,
      nonEmpty: true,
    });
    const eventIds = assertStringArray(candidate.eventIds, `${label}.eventIds`, {
      sorted: true,
      nonEmpty: candidate.groupKey !== LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY
        && parseWaterAssistanceFulfillmentMembershipGroupKey(candidate.groupKey) === null,
    });
    if ((candidate.groupKey.startsWith('active-mechanical-project:')
      || candidate.groupKey.startsWith('active-project:'))
      && eventIds.length > HISTORY_RETENTION_MAX_ACTIVE_PROJECT_ACTION_EVENT_IDS) {
      throw new Error(`${label}.eventIds 超出 active project 有界上限`);
    }
    if (candidate.groupKey.startsWith('live-intent:')
      && candidate.groupKey.endsWith(':anchors')
      && eventIds.length > HISTORY_RETENTION_MAX_LIVE_INTENT_CORE_EVENT_IDS) {
      throw new Error(`${label}.eventIds 超出 live intent 有界上限`);
    }
    const liveSocial = parseLivePersonSocialEvidenceGroupKey(candidate.groupKey);
    if (liveSocial) {
      const expectedLeaseKey = liveSocial.kind === 'broad'
        ? livePersonSocialEvidenceLeaseKey(liveSocial.ownerId)
        : livePersonSocialStrictEvidenceLeaseKey(liveSocial.ownerId, liveSocial.kind);
      const validRequirement = liveSocial.kind === 'broad'
        ? candidate.requirement === 'index-only'
          || options.allowLegacyLivePersonSocialAll && candidate.requirement === 'all'
        : candidate.requirement === 'all';
      if (!validRequirement
        || leaseKeys.length !== 1
        || leaseKeys[0] !== expectedLeaseKey
        || eventIds.length > HISTORY_RETENTION_MAX_LIVE_PERSON_SOCIAL_EVENT_IDS) {
        throw new Error(`${label} 的 living person social selector 无效或超界`);
      }
    }
    if (parseGroundedConversationResponseSourceLeaseKey(candidate.groupKey)) {
      groundedResponseSourceGroupCount += 1;
      if (candidate.requirement !== 'all'
        || leaseKeys.length !== 1
        || leaseKeys[0] !== candidate.groupKey
        || eventIds.length > HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_SOURCE_EVENT_IDS) {
        throw new Error(`${label} 的 grounded response sources 无效或超界`);
      }
      eventIds.forEach((eventId) => groundedResponseSourceEventIds.add(eventId));
    }
    const recentTerminalFailure = parseRecentTerminalFailureActionLeaseKey(candidate.groupKey);
    if (recentTerminalFailure) {
      recentTerminalFailureGroupCount += 1;
      if (candidate.requirement !== 'all'
        || leaseKeys.length !== 1
        || leaseKeys[0] !== candidate.groupKey
        || eventIds.length
          > HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_PER_PERSON) {
        throw new Error(`${label} 的 recent terminal failure actions 无效或超界`);
      }
      recentTerminalFailureOwnerIds.add(recentTerminalFailure.ownerId);
      recentTerminalFailureEventIdCount += eventIds.length;
    }
    const socialLearning = parseSocialLearningSourceLeaseKey(candidate.groupKey);
    if (socialLearning) {
      socialLearningGroupCount += 1;
      socialLearningEventIdMembershipCount += eventIds.length;
      if (candidate.requirement !== 'all'
        || leaseKeys.length !== 1
        || leaseKeys[0] !== candidate.groupKey
        || eventIds.length > HISTORY_RETENTION_MAX_SOCIAL_LEARNING_EVENT_IDS_PER_PERSON) {
        throw new Error(`${label} 的 social learning sources 无效或超界`);
      }
      socialLearningObserverIds.add(socialLearning.observerId);
    }
    if (candidate.groupKey === LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY
      && ((candidate.requirement !== 'audit-only' && candidate.requirement !== 'index-only')
        || leaseKeys.length !== 1
        || leaseKeys[0] !== LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY
        || eventIds.length > HISTORY_RETENTION_MAX_LIVE_PROJECT_PRESSURE_SOURCE_EVENT_IDS)) {
      throw new Error(`${label} 的 living project-pressure source selector 无效或超界`);
    }
    if (candidate.groupKey === FUTURE_FAMILY_STORED_FOOD_SOURCE_LEASE_KEY
      && (candidate.requirement !== 'audit-only'
        || leaseKeys.length !== 1
        || leaseKeys[0] !== FUTURE_FAMILY_STORED_FOOD_SOURCE_LEASE_KEY
        || eventIds.length > HISTORY_RETENTION_MAX_FUTURE_FAMILY_STORED_FOOD_SOURCE_EVENT_IDS)) {
      throw new Error(`${label} 的 future family stored-food source selector 无效或超界`);
    }
    if (candidate.groupKey === FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY
      && (candidate.requirement !== 'index-only'
        && !(options.allowLegacyFutureSocialRepetitionAudit
          && candidate.requirement === 'audit-only')
        || leaseKeys.length !== 1
        || leaseKeys[0] !== FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY
        || eventIds.length > HISTORY_RETENTION_MAX_FUTURE_SOCIAL_REPETITION_SOURCE_EVENT_IDS)) {
      throw new Error(`${label} 的 future social-repetition source selector 无效或超界`);
    }
    if (candidate.groupKey === FUTURE_COGNITIVE_APPRAISAL_SOURCE_LEASE_KEY
      && ((candidate.requirement !== 'index-only' && candidate.requirement !== 'audit-only')
        || leaseKeys.length !== 1
        || leaseKeys[0] !== FUTURE_COGNITIVE_APPRAISAL_SOURCE_LEASE_KEY
        || eventIds.length > HISTORY_RETENTION_MAX_FUTURE_COGNITIVE_APPRAISAL_SOURCE_EVENT_IDS)) {
      throw new Error(`${label} 的 future cognitive-appraisal source selector 无效或超界`);
    }
    if (candidate.groupKey === FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_LEASE_KEY
      && (candidate.requirement !== 'index-only'
        || leaseKeys.length !== 1
        || leaseKeys[0] !== FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_LEASE_KEY
        || eventIds.length
          > HISTORY_RETENTION_MAX_FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_EVENT_IDS)) {
      throw new Error(`${label} 的 future active-project logistics source selector 无效或超界`);
    }
    if (candidate.groupKey === FUTURE_MATERIAL_AFFORDANCE_SOURCE_LEASE_KEY
      && (candidate.requirement !== 'audit-only'
        || leaseKeys.length !== 1
        || leaseKeys[0] !== FUTURE_MATERIAL_AFFORDANCE_SOURCE_LEASE_KEY
        || eventIds.length > HISTORY_RETENTION_MAX_FUTURE_MATERIAL_AFFORDANCE_SOURCE_EVENT_IDS)) {
      throw new Error(`${label} 的 future material-affordance source selector 无效或超界`);
    }
    groups.push({
      groupKey: candidate.groupKey,
      requirement: candidate.requirement as HistoryRetentionContinuationDemand['groups'][number]['requirement'],
      leaseKeys,
      eventIds,
    });
    previousGroupKey = candidate.groupKey;
  }
  if (groundedResponseSourceGroupCount > HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_SOURCE_GROUPS
    || groundedResponseSourceEventIds.size
      > HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_UNIQUE_EVENT_IDS) {
    throw new Error('retention continuation grounded response source groups 超出有界上限');
  }
  if (recentTerminalFailureGroupCount > HISTORY_RETENTION_MAX_LIVE_GAMEPLAY_SELECTOR_PERSONS
    || recentTerminalFailureEventIdCount
      > HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_TOTAL) {
    throw new Error('retention continuation recent terminal failure action leases 超出有界上限');
  }
  if (socialLearningGroupCount > HISTORY_RETENTION_MAX_LIVE_GAMEPLAY_SELECTOR_PERSONS
    || socialLearningEventIdMembershipCount
      > HISTORY_RETENTION_MAX_SOCIAL_LEARNING_EVENT_IDS_TOTAL) {
    throw new Error('retention continuation social learning source leases 超出有界上限');
  }
  assertLiveIntentHistoryRetentionDemandGroups(
    groups,
    'retention continuation sourceDemand group',
  );
  waterAssistanceSelectiveLeaseKeysFromDemandGroups(groups);
  const millLaborPersonIds = assertStringArray(
    value.millLaborPersonIds,
    'retention continuation sourceDemand.millLaborPersonIds',
    { sorted: true },
  );
  if (millLaborPersonIds.length > HISTORY_RETENTION_MAX_LIVE_GAMEPLAY_SELECTOR_PERSONS) {
    throw new Error('retention continuation sourceDemand living selector 人数超界');
  }
  const livingPersonIds = new Set(millLaborPersonIds);
  assertProjectPressureHistoryRetentionDemandGroups(
    groups,
    'retention continuation sourceDemand',
    { allowLegacyMissing: options.allowLegacyMissingProjectPressure },
  );
  if ([...recentTerminalFailureOwnerIds].some((ownerId) => !livingPersonIds.has(ownerId))) {
    throw new Error('retention continuation recent terminal failure owner 不属于存活人物');
  }
  if ([...socialLearningObserverIds].some((observerId) => !livingPersonIds.has(observerId))) {
    throw new Error('retention continuation social learning observer 不属于存活人物');
  }
  const pendingEraPredictionIds = assertStringArray(
    value.pendingEraPredictionIds,
    'retention continuation sourceDemand.pendingEraPredictionIds',
    { sorted: true },
  );
  const livingChildIds = assertStringArray(
    value.livingChildIds,
    'retention continuation sourceDemand.livingChildIds',
    { sorted: true },
  );
  if (!Array.isArray(value.reproductionFacts)) {
    throw new Error('retention continuation sourceDemand.reproductionFacts 必须是数组');
  }
  const reproductionFacts: HistoryRetentionContinuationDemand['reproductionFacts'] = [];
  let previousIntentId: string | null = null;
  for (let index = 0; index < value.reproductionFacts.length; index += 1) {
    const candidate = value.reproductionFacts[index];
    const label = `retention continuation sourceDemand.reproductionFacts[${index}]`;
    assertRecord(candidate, label);
    assertExactKeys(candidate, [
      'intentId',
      'ownerId',
      'createdAtMonth',
      'femaleId',
      'agreementId',
      'acceptedAtMonth',
      'dueAtMonth',
      'lastAttemptAtMonth',
      'attemptEventIds',
    ], label);
    assertBoundedString(candidate.intentId, `${label}.intentId`);
    if (previousIntentId !== null && previousIntentId.localeCompare(candidate.intentId) >= 0) {
      throw new Error('retention continuation reproductionFacts 重复或未严格排序');
    }
    assertBoundedString(candidate.ownerId, `${label}.ownerId`);
    assertSafeIntegerAtLeast(candidate.createdAtMonth, 0, `${label}.createdAtMonth`);
    if (candidate.femaleId !== null) assertBoundedString(candidate.femaleId, `${label}.femaleId`);
    if (candidate.agreementId !== null) {
      assertBoundedString(candidate.agreementId, `${label}.agreementId`);
    }
    const attemptEventIds = assertStringArray(candidate.attemptEventIds, `${label}.attemptEventIds`, {
      sorted: true,
    });
    if (attemptEventIds.length > HISTORY_RETENTION_MAX_REPRODUCTION_ATTEMPT_EVENT_IDS) {
      throw new Error(`${label}.attemptEventIds 超出固定 consent window`);
    }
    const acceptedIsNull = candidate.acceptedAtMonth === null;
    const dueIsNull = candidate.dueAtMonth === null;
    if (acceptedIsNull !== dueIsNull) throw new Error(`${label} 的 consent window 不完整`);
    if (!acceptedIsNull) {
      assertSafeIntegerAtLeast(candidate.acceptedAtMonth, 0, `${label}.acceptedAtMonth`);
      assertSafeIntegerAtLeast(candidate.dueAtMonth, 0, `${label}.dueAtMonth`);
      if (candidate.dueAtMonth - candidate.acceptedAtMonth + 1
        !== HISTORY_RETENTION_MAX_REPRODUCTION_ATTEMPT_EVENT_IDS) {
        throw new Error(`${label} 的 consent window 长度无效`);
      }
    }
    if (candidate.lastAttemptAtMonth !== null) {
      assertSafeIntegerAtLeast(candidate.lastAttemptAtMonth, 0, `${label}.lastAttemptAtMonth`);
      if (acceptedIsNull
        || candidate.lastAttemptAtMonth < Number(candidate.acceptedAtMonth)
        || candidate.lastAttemptAtMonth > Number(candidate.dueAtMonth)) {
        throw new Error(`${label}.lastAttemptAtMonth 超出 consent window`);
      }
    }
    if ((attemptEventIds.length > 0) !== (candidate.lastAttemptAtMonth !== null)) {
      throw new Error(`${label} 的 attempt IDs 与 lastAttemptAtMonth 不一致`);
    }
    reproductionFacts.push({
      intentId: candidate.intentId,
      ownerId: candidate.ownerId,
      createdAtMonth: candidate.createdAtMonth,
      femaleId: candidate.femaleId as string | null,
      agreementId: candidate.agreementId as string | null,
      acceptedAtMonth: candidate.acceptedAtMonth as number | null,
      dueAtMonth: candidate.dueAtMonth as number | null,
      lastAttemptAtMonth: candidate.lastAttemptAtMonth as number | null,
      attemptEventIds,
    });
    previousIntentId = candidate.intentId;
  }
  const calibrationLeaseKeys = calibrationLeaseKeysFromDemandGroups(groups);
  if (calibrationLeaseKeys.length > HISTORY_RETENTION_MAX_CALIBRATION_INSTRUMENTS) {
    throw new Error('retention continuation calibration selectors 超界');
  }
  const calibrationCountsByPersonId = new Map<string, number>();
  for (const leaseKey of calibrationLeaseKeys) {
    const selector = parsePersonalMassCalibrationLeaseKey(leaseKey);
    if (!selector || !millLaborPersonIds.includes(selector.personId)) {
      throw new Error(`retention continuation calibration selector ${leaseKey} 人物无效`);
    }
    const personCount = (calibrationCountsByPersonId.get(selector.personId) ?? 0) + 1;
    if (personCount > HISTORY_RETENTION_MAX_CALIBRATION_INSTRUMENTS_PER_PERSON) {
      throw new Error(`retention continuation calibration selector ${selector.personId} 栈数超界`);
    }
    calibrationCountsByPersonId.set(selector.personId, personCount);
    const group = groups.find((candidate) => candidate.leaseKeys.length === 1
      && candidate.leaseKeys[0] === leaseKey
      && candidate.groupKey === `${leaseKey}:instrument-sources`);
    if (!group || group.eventIds.length > HISTORY_RETENTION_MAX_MEASUREMENT_STACK_SOURCE_EVENT_IDS) {
      throw new Error(`retention continuation calibration selector ${leaseKey} source IDs 超界`);
    }
  }
  productionWindowMonthFromDemandGroups(groups);
  return {
    groups,
    millLaborPersonIds,
    pendingEraPredictionIds,
    livingChildIds,
    reproductionFacts,
  };
}

function assertSourceDemandSelectorGroups(demand: HistoryRetentionContinuationDemand): void {
  const groupsByKey = new Map(demand.groups.map((group) => [group.groupKey, group]));
  const livingPersonIds = new Set(demand.millLaborPersonIds);
  if (demand.livingChildIds.some((childId) => !livingPersonIds.has(childId))) {
    throw new Error('retention continuation living child 不属于当前存活人物集合');
  }
  const productionWindowMonth = productionWindowMonthFromDemandGroups(demand.groups);
  if (productionWindowMonth !== null) {
    const group = groupsByKey.get(`recent-personal-production-window:${productionWindowMonth}`);
    if (!group
      || group.requirement !== 'all'
      || group.leaseKeys.length !== 1
      || group.leaseKeys[0] !== 'retention:recent-personal-production:window'
      || group.eventIds.length !== 1) {
      throw new Error('retention continuation production window selector group 无效');
    }
  }
  for (const predictionId of demand.pendingEraPredictionIds) {
    const groupKey = `pending-era-prediction:${predictionId}:source`;
    const group = groupsByKey.get(groupKey);
    if (!group
      || group.requirement !== 'all'
      || !sameStrings(group.leaseKeys, [pendingEraPredictionWakeLeaseKey(predictionId)])) {
      throw new Error(`retention continuation pending prediction ${predictionId} 缺少 source demand`);
    }
  }
  for (const item of demand.reproductionFacts) {
    const groupKey = `active-reproduction-intent:${item.intentId}:facts`;
    const group = groupsByKey.get(groupKey);
    const expectedLeases = [
      reproductionAttemptLeaseKey(item.intentId),
      ...(item.femaleId ? [reproductionConceptionLeaseKey(item.intentId)] : []),
    ].sort();
    if (!group
      || group.requirement !== 'all'
      || !sameStrings(group.leaseKeys, expectedLeases)) {
      throw new Error(`retention continuation reproduction selector ${item.intentId} 缺少 anchor demand`);
    }
  }
}

interface MatchIdentityRegistry {
  byOrdinal: Map<number, string>;
  byEventId: Map<string, number>;
}

function registerMatchIdentity(
  registry: MatchIdentityRegistry,
  match: HistoryRetentionContinuationMatch,
  label: string,
): void {
  const ordinalEventId = registry.byOrdinal.get(match.absoluteIndex);
  if (ordinalEventId !== undefined && ordinalEventId !== match.eventId) {
    throw new Error(`${label} 与 ordinal ${match.absoluteIndex} 的 eventId 冲突`);
  }
  const eventOrdinal = registry.byEventId.get(match.eventId);
  if (eventOrdinal !== undefined && eventOrdinal !== match.absoluteIndex) {
    throw new Error(`${label} 的 eventId ${match.eventId} 出现在多个 ordinal`);
  }
  registry.byOrdinal.set(match.absoluteIndex, match.eventId);
  registry.byEventId.set(match.eventId, match.absoluteIndex);
}

function pendingEraPredictionWakeLeaseKey(predictionId: string): string {
  return `gameplay:pending-era-prediction:${predictionId}:disputed-wake`;
}

function livingChildBirthLeaseKey(childId: string): string {
  return `gameplay:living-child:${childId}:birth`;
}

function reproductionAttemptLeaseKey(intentId: string): string {
  return `gameplay:reproduction-intent:${intentId}:attempt`;
}

function reproductionConceptionLeaseKey(intentId: string): string {
  return `gameplay:reproduction-intent:${intentId}:conception`;
}

function normalizedResultDemandGroups(
  groups: readonly HistoryRetentionDemandGroupResult[],
): HistoryRetentionContinuationDemand['groups'] {
  return groups.map((group) => ({
    groupKey: group.groupKey,
    requirement: group.requirement,
    leaseKeys: [...group.leaseKeys].sort(),
    eventIds: [...group.eventIds].sort(),
  })).sort((left, right) => left.groupKey.localeCompare(right.groupKey));
}

function normalizeContinuationBasis(
  value: unknown,
  projection: {
    authority: HistoryRetentionAuthority;
    target: HistoryRetentionSeal;
    demandFingerprint: string;
    millLaborPersonIds: string[];
    demandGroups: HistoryRetentionDemandGroupResult[];
    minimalMechanicalTeachingWitness: MechanicalTeachingOperationWitness | null;
    summary: HistoryRetentionSummary;
  },
  registry: MatchIdentityRegistry,
  options: {
    allowLegacyMissingProjectPressure?: boolean;
    allowLegacyFutureSocialRepetitionAudit?: boolean;
    allowLegacyLivePersonSocialAll?: boolean;
  } = {},
): HistoryRetentionProjectionResult['continuationBasis'] {
  assertRecord(value, 'retention projection.continuationBasis');
  assertExactKeys(value, [
    'schemaVersion',
    'sourceAuthority',
    'sourceTarget',
    'sourceDemandFingerprint',
    'sourceDemand',
    'directMatches',
    'millLaborRings',
    'pendingMechanicalTeachings',
    'witnessedMechanicalAudienceIds',
    'reproductionAttempts',
    'selectiveMatches',
    'livingChildBirthMatches',
    'minimalMechanicalTeachingWitness',
    'summary',
    'basisHash',
  ], 'retention projection.continuationBasis');
  if (value.schemaVersion !== 1) {
    throw new Error('retention projection.continuationBasis.schemaVersion 无效');
  }
  const sourceAuthority = normalizeAuthority(
    value.sourceAuthority,
    'retention projection.continuationBasis.sourceAuthority',
  );
  const sourceTarget = normalizeSeal(
    value.sourceTarget,
    'retention projection.continuationBasis.sourceTarget',
  );
  if (!sameAuthority(sourceAuthority, projection.authority)
    || !sameSeal(sourceTarget, projection.target)) {
    throw new Error('retention continuation basis 的 authority/target 与 projection 不一致');
  }
  assertHash(
    value.sourceDemandFingerprint,
    'retention projection.continuationBasis.sourceDemandFingerprint',
  );
  if (value.sourceDemandFingerprint !== projection.demandFingerprint) {
    throw new Error('retention continuation basis 的 demand fingerprint 与 projection 不一致');
  }
  const sourceDemand = normalizeSourceDemand(value.sourceDemand, options);
  assertSourceDemandSelectorGroups(sourceDemand);
  if (historyRetentionDemandFingerprint(sourceDemand) !== value.sourceDemandFingerprint) {
    throw new Error('retention continuation basis 的 sourceDemand/fingerprint 不一致');
  }
  if (JSON.stringify(normalizedResultDemandGroups(projection.demandGroups))
    !== JSON.stringify(sourceDemand.groups)
    || !sameStrings(projection.millLaborPersonIds, sourceDemand.millLaborPersonIds)) {
    throw new Error('retention continuation basis 的 sourceDemand 与 projection demand 不一致');
  }

  const demandedEventIds = new Set(sourceDemand.groups.flatMap((group) => group.eventIds));
  const livingPersonIds = new Set(sourceDemand.millLaborPersonIds);
  const livingChildIds = new Set(sourceDemand.livingChildIds);

  if (!Array.isArray(value.directMatches)) {
    throw new Error('retention continuation basis.directMatches 必须是数组');
  }
  const directMatches: HistoryRetentionContinuationMatch[] = [];
  const directEventIds = new Set<string>();
  let previousDirectEventId: string | null = null;
  for (let index = 0; index < value.directMatches.length; index += 1) {
    const match = normalizeMatch(
      value.directMatches[index],
      sourceTarget,
      `retention continuation basis.directMatches[${index}]`,
    );
    if (!demandedEventIds.has(match.eventId) || directEventIds.has(match.eventId)) {
      throw new Error(`retention continuation direct match ${match.eventId} 非需求或重复`);
    }
    if (previousDirectEventId !== null
      && previousDirectEventId.localeCompare(match.eventId) >= 0) {
      throw new Error('retention continuation directMatches 未按 eventId 严格排序');
    }
    registerMatchIdentity(registry, match, 'retention continuation direct match');
    directMatches.push(match);
    directEventIds.add(match.eventId);
    previousDirectEventId = match.eventId;
  }

  if (!Array.isArray(value.millLaborRings)) {
    throw new Error('retention continuation basis.millLaborRings 必须是数组');
  }
  const millLaborRings: HistoryRetentionProjectionResult['continuationBasis']['millLaborRings'] = [];
  let previousRingPersonId: string | null = null;
  for (let index = 0; index < value.millLaborRings.length; index += 1) {
    const candidate = value.millLaborRings[index];
    const label = `retention continuation basis.millLaborRings[${index}]`;
    assertRecord(candidate, label);
    assertExactKeys(candidate, ['personId', 'matches'], label);
    assertBoundedString(candidate.personId, `${label}.personId`);
    if (!livingPersonIds.has(candidate.personId)
      || (previousRingPersonId !== null
        && previousRingPersonId.localeCompare(candidate.personId) >= 0)) {
      throw new Error(`${label}.personId 非存活人物、重复或未排序`);
    }
    if (!Array.isArray(candidate.matches)
      || candidate.matches.length === 0
      || candidate.matches.length > 3) {
      throw new Error(`${label}.matches 超出最近三次有界环`);
    }
    const matches: HistoryRetentionContinuationMatch[] = [];
    let previousOrdinal = -1;
    for (let matchIndex = 0; matchIndex < candidate.matches.length; matchIndex += 1) {
      const match = normalizeMatch(
        candidate.matches[matchIndex],
        sourceTarget,
        `${label}.matches[${matchIndex}]`,
      );
      if (match.absoluteIndex <= previousOrdinal) {
        throw new Error(`${label}.matches ordinal 重复或未严格递增`);
      }
      registerMatchIdentity(registry, match, `${label}.matches[${matchIndex}]`);
      matches.push(match);
      previousOrdinal = match.absoluteIndex;
    }
    millLaborRings.push({ personId: candidate.personId, matches });
    previousRingPersonId = candidate.personId;
  }

  if (!Array.isArray(value.pendingMechanicalTeachings)) {
    throw new Error('retention continuation basis.pendingMechanicalTeachings 必须是数组');
  }
  const pendingMechanicalTeachings:
    HistoryRetentionProjectionResult['continuationBasis']['pendingMechanicalTeachings'] = [];
  const pendingAudienceIds = new Set<string>();
  let previousPendingAudienceId: string | null = null;
  for (let index = 0; index < value.pendingMechanicalTeachings.length; index += 1) {
    const candidate = value.pendingMechanicalTeachings[index];
    const label = `retention continuation basis.pendingMechanicalTeachings[${index}]`;
    assertRecord(candidate, label);
    assertExactKeys(candidate, ['audienceId', 'absoluteIndex', 'eventId'], label);
    assertBoundedString(candidate.audienceId, `${label}.audienceId`);
    if (!livingPersonIds.has(candidate.audienceId)
      || (previousPendingAudienceId !== null
        && previousPendingAudienceId.localeCompare(candidate.audienceId) >= 0)) {
      throw new Error(`${label}.audienceId 非存活人物、重复或未排序`);
    }
    const match = normalizeMatch({
      absoluteIndex: candidate.absoluteIndex,
      eventId: candidate.eventId,
    }, sourceTarget, label);
    registerMatchIdentity(registry, match, label);
    pendingMechanicalTeachings.push({ audienceId: candidate.audienceId, ...match });
    pendingAudienceIds.add(candidate.audienceId);
    previousPendingAudienceId = candidate.audienceId;
  }

  const witnessedMechanicalAudienceIds = assertStringArray(
    value.witnessedMechanicalAudienceIds,
    'retention continuation basis.witnessedMechanicalAudienceIds',
    { sorted: true },
  );
  if (witnessedMechanicalAudienceIds.some((audienceId) => !livingPersonIds.has(audienceId)
    || pendingAudienceIds.has(audienceId))) {
    throw new Error('retention continuation witnessed audience 非存活或与 pending 冲突');
  }

  const reproductionByIntentId = new Map(sourceDemand.reproductionFacts.map(
    (item) => [item.intentId, item],
  ));
  if (!Array.isArray(value.reproductionAttempts)) {
    throw new Error('retention continuation basis.reproductionAttempts 必须是数组');
  }
  const reproductionAttempts:
    HistoryRetentionProjectionResult['continuationBasis']['reproductionAttempts'] = [];
  let previousReproductionIntentId: string | null = null;
  for (let index = 0; index < value.reproductionAttempts.length; index += 1) {
    const candidate = value.reproductionAttempts[index];
    const label = `retention continuation basis.reproductionAttempts[${index}]`;
    assertRecord(candidate, label);
    assertExactKeys(candidate, ['intentId', 'resolved'], label);
    assertBoundedString(candidate.intentId, `${label}.intentId`);
    const source = reproductionByIntentId.get(candidate.intentId);
    if (!source || (previousReproductionIntentId !== null
      && previousReproductionIntentId.localeCompare(candidate.intentId) >= 0)) {
      throw new Error(`${label}.intentId 非 source selector、重复或未排序`);
    }
    if (!Array.isArray(candidate.resolved)) throw new Error(`${label}.resolved 必须是数组`);
    const resolved: Array<{ eventId: string; atMonth: number }> = [];
    const resolvedEventIds = new Set<string>();
    const resolvedMonths = new Set<number>();
    let previousResolvedEventId: string | null = null;
    for (let resolvedIndex = 0; resolvedIndex < candidate.resolved.length; resolvedIndex += 1) {
      const item = candidate.resolved[resolvedIndex];
      const itemLabel = `${label}.resolved[${resolvedIndex}]`;
      assertRecord(item, itemLabel);
      assertExactKeys(item, ['eventId', 'atMonth'], itemLabel);
      assertBoundedString(item.eventId, `${itemLabel}.eventId`);
      assertSafeIntegerAtLeast(item.atMonth, 0, `${itemLabel}.atMonth`);
      if (!source.attemptEventIds.includes(item.eventId)
        || resolvedEventIds.has(item.eventId)
        || resolvedMonths.has(item.atMonth)
        || (previousResolvedEventId !== null
          && previousResolvedEventId.localeCompare(item.eventId) >= 0)
        || source.acceptedAtMonth === null
        || source.dueAtMonth === null
        || item.atMonth < source.acceptedAtMonth
        || item.atMonth > source.dueAtMonth) {
        throw new Error(`${itemLabel} 不是唯一、排序且位于 consent window 的 attempt`);
      }
      resolved.push({ eventId: item.eventId, atMonth: item.atMonth });
      resolvedEventIds.add(item.eventId);
      resolvedMonths.add(item.atMonth);
      previousResolvedEventId = item.eventId;
    }
    if (resolvedEventIds.size !== source.attemptEventIds.length
      || (resolved.length > 0
        && Math.max(...resolved.map((item) => item.atMonth)) !== source.lastAttemptAtMonth)) {
      throw new Error(`${label} 未完整解析 reproduction attempts`);
    }
    reproductionAttempts.push({ intentId: candidate.intentId, resolved });
    previousReproductionIntentId = candidate.intentId;
  }
  if (reproductionAttempts.length !== sourceDemand.reproductionFacts.length) {
    throw new Error('retention continuation reproductionAttempts 未完整覆盖 source selectors');
  }

  const allMatchSelectiveLeaseKeys = new Set(sourceDemand.pendingEraPredictionIds.map(
    pendingEraPredictionWakeLeaseKey,
  ));
  const productionWindowMonth = productionWindowMonthFromDemandGroups(sourceDemand.groups);
  const productionSelectorPersonIds = new Set<string>();
  const allowedSelectiveLeaseKeys = new Set<string>([
    ...allMatchSelectiveLeaseKeys,
    ...calibrationLeaseKeysFromDemandGroups(sourceDemand.groups),
    ...waterAssistanceSelectiveLeaseKeysFromDemandGroups(sourceDemand.groups),
    MODERN_RECORD_EXPERIMENT_LEASE_KEY,
    ...sourceDemand.reproductionFacts.flatMap((item) => [
      reproductionAttemptLeaseKey(item.intentId),
      ...(item.femaleId ? [reproductionConceptionLeaseKey(item.intentId)] : []),
    ]),
  ]);
  if (!Array.isArray(value.selectiveMatches)) {
    throw new Error('retention continuation basis.selectiveMatches 必须是数组');
  }
  const selectiveMatches: HistoryRetentionProjectionResult['continuationBasis']['selectiveMatches'] = [];
  let previousLeaseKey: string | null = null;
  for (let index = 0; index < value.selectiveMatches.length; index += 1) {
    const candidate = value.selectiveMatches[index];
    const label = `retention continuation basis.selectiveMatches[${index}]`;
    assertRecord(candidate, label);
    assertExactKeys(candidate, ['leaseKey', 'matches'], label);
    assertBoundedString(candidate.leaseKey, `${label}.leaseKey`);
    const production = parseRecentPersonalProductionLaborSelectorLeaseKey(candidate.leaseKey);
    const validProduction = production !== null
      && productionWindowMonth !== null
      && livingPersonIds.has(production.personId)
      && production.eventMonth >= productionWindowMonth - RECENT_PERSONAL_PRODUCTION_MONTHS
      && production.eventMonth <= productionWindowMonth
      && !productionSelectorPersonIds.has(production.personId);
    const groundedConversation = parseGroundedConversationWindowLeaseKey(candidate.leaseKey);
    const validGroundedConversation = groundedConversation !== null
      && productionWindowMonth !== null
      && livingPersonIds.has(groundedConversation.listenerId)
      && groundedConversation.eventMonth
        >= productionWindowMonth - GROUNDED_CONVERSATION_RESPONSE_WINDOW_MONTHS
      && groundedConversation.eventMonth <= productionWindowMonth;
    const validModernElectrical = candidate.leaseKey === MODERN_ELECTRICAL_USEFUL_LOAD_LEASE_KEY
      || parseModernElectricalUsefulLoadLeaseKey(candidate.leaseKey) !== null;
    if ((!allowedSelectiveLeaseKeys.has(candidate.leaseKey)
      && !validModernElectrical
      && !validProduction
      && !validGroundedConversation)
      || (previousLeaseKey !== null && previousLeaseKey.localeCompare(candidate.leaseKey) >= 0)) {
      throw new Error(`${label}.leaseKey 非 source selector、重复或未排序`);
    }
    if (validProduction && production) productionSelectorPersonIds.add(production.personId);
    if (!Array.isArray(candidate.matches) || candidate.matches.length === 0) {
      throw new Error(`${label}.matches 必须是非空数组`);
    }
    if (allMatchSelectiveLeaseKeys.has(candidate.leaseKey) || validGroundedConversation) {
      if (candidate.matches.length > HISTORY_RETENTION_MAX_PENDING_PREDICTION_WAKE_MATCHES) {
        throw new Error(`${label}.matches 超出 gameplay all-match 上限`);
      }
    } else if (candidate.matches.length > 1) {
      throw new Error(`${label}.matches 超出 latest selector 上限`);
    }
    const matches: HistoryRetentionContinuationMatch[] = [];
    let previousOrdinal = -1;
    for (let matchIndex = 0; matchIndex < candidate.matches.length; matchIndex += 1) {
      const match = normalizeMatch(
        candidate.matches[matchIndex],
        sourceTarget,
        `${label}.matches[${matchIndex}]`,
      );
      if (match.absoluteIndex <= previousOrdinal) {
        throw new Error(`${label}.matches ordinal 重复或未严格递增`);
      }
      registerMatchIdentity(registry, match, `${label}.matches[${matchIndex}]`);
      matches.push(match);
      previousOrdinal = match.absoluteIndex;
    }
    selectiveMatches.push({ leaseKey: candidate.leaseKey, matches });
    previousLeaseKey = candidate.leaseKey;
  }

  if (!Array.isArray(value.livingChildBirthMatches)) {
    throw new Error('retention continuation basis.livingChildBirthMatches 必须是数组');
  }
  const livingChildBirthMatches:
    HistoryRetentionProjectionResult['continuationBasis']['livingChildBirthMatches'] = [];
  let previousChildId: string | null = null;
  for (let index = 0; index < value.livingChildBirthMatches.length; index += 1) {
    const candidate = value.livingChildBirthMatches[index];
    const label = `retention continuation basis.livingChildBirthMatches[${index}]`;
    assertRecord(candidate, label);
    assertExactKeys(candidate, ['childId', 'match'], label);
    assertBoundedString(candidate.childId, `${label}.childId`);
    if (!livingChildIds.has(candidate.childId)
      || (previousChildId !== null && previousChildId.localeCompare(candidate.childId) >= 0)) {
      throw new Error(`${label}.childId 非存活后代、重复或未排序`);
    }
    const match = normalizeMatch(candidate.match, sourceTarget, `${label}.match`);
    registerMatchIdentity(registry, match, `${label}.match`);
    livingChildBirthMatches.push({ childId: candidate.childId, match });
    previousChildId = candidate.childId;
  }
  if (livingChildBirthMatches.length !== sourceDemand.livingChildIds.length) {
    throw new Error('retention continuation livingChildBirthMatches 未完整覆盖 living children');
  }

  const minimalMechanicalTeachingWitness = normalizeWitness(
    value.minimalMechanicalTeachingWitness,
    sourceTarget,
    'retention continuation basis.minimalMechanicalTeachingWitness',
  );
  if (JSON.stringify(minimalMechanicalTeachingWitness)
    !== JSON.stringify(projection.minimalMechanicalTeachingWitness)) {
    throw new Error('retention continuation basis 的 minimal witness 与 projection 不一致');
  }
  if (minimalMechanicalTeachingWitness) {
    registerMatchIdentity(registry, {
      absoluteIndex: minimalMechanicalTeachingWitness.teachingAbsoluteIndex,
      eventId: minimalMechanicalTeachingWitness.teachingEventId,
    }, 'retention continuation minimal witness teaching');
    registerMatchIdentity(registry, {
      absoluteIndex: minimalMechanicalTeachingWitness.operationAbsoluteIndex,
      eventId: minimalMechanicalTeachingWitness.operationEventId,
    }, 'retention continuation minimal witness operation');
  }
  const summary = normalizeSummary(
    value.summary,
    sourceTarget,
    'retention continuation basis.summary',
  );
  if (JSON.stringify(summary) !== JSON.stringify(projection.summary)) {
    throw new Error('retention continuation basis 的 summary 与 projection 不一致');
  }

  assertHash(value.basisHash, 'retention continuation basis.basisHash');
  const withoutHash = {
    schemaVersion: 1 as const,
    sourceAuthority,
    sourceTarget,
    sourceDemandFingerprint: value.sourceDemandFingerprint,
    sourceDemand,
    directMatches,
    millLaborRings,
    pendingMechanicalTeachings,
    witnessedMechanicalAudienceIds,
    reproductionAttempts,
    selectiveMatches,
    livingChildBirthMatches,
    minimalMechanicalTeachingWitness,
    summary,
  };
  const expectedBasisHash = createHash('sha256')
    .update('eland-history-retention-continuation-v1\0')
    .update(JSON.stringify(withoutHash))
    .digest('hex');
  if (value.basisHash !== expectedBasisHash) {
    throw new Error('retention continuation basis.basisHash 无效');
  }
  return { ...withoutHash, basisHash: value.basisHash };
}

function normalizeContinuationGaps(value: unknown): HistoryRetentionProjectionResult['continuationGaps'] {
  if (!Array.isArray(value)) throw new Error('retention projection.continuationGaps 必须是数组');
  if (value.length !== CONTINUATION_GAP_CODES.length) {
    throw new Error('retention projection.continuationGaps 缺失或包含未知 gap');
  }
  return value.map((candidate, index) => {
    const label = `retention projection.continuationGaps[${index}]`;
    assertRecord(candidate, label);
    assertExactKeys(candidate, ['code', 'policy', 'description'], label);
    const expectedCode = CONTINUATION_GAP_CODES[index];
    if (candidate.code !== expectedCode) {
      throw new Error(`${label}.code 缺失、重复、未知或未按规范顺序排列`);
    }
    if (candidate.policy !== 'fail-closed') throw new Error(`${label}.policy 必须为 fail-closed`);
    assertBoundedString(
      candidate.description,
      `${label}.description`,
      MAX_HISTORY_RETENTION_SIDECAR_DESCRIPTION_BYTES,
    );
    return {
      code: expectedCode,
      policy: 'fail-closed' as const,
      description: candidate.description,
    };
  });
}

function addExpectedPin(
  pins: Map<number, HistoryRetentionPin>,
  match: HistoryRetentionContinuationMatch,
  leaseKeys: readonly string[],
): void {
  const existing = pins.get(match.absoluteIndex);
  if (existing) {
    if (existing.eventId !== match.eventId) {
      throw new Error(`retention expected pin ordinal ${match.absoluteIndex} 的 eventId 冲突`);
    }
    existing.leaseKeys = [...new Set([...existing.leaseKeys, ...leaseKeys])].sort();
  } else {
    pins.set(match.absoluteIndex, {
      absoluteIndex: match.absoluteIndex,
      eventId: match.eventId,
      leaseKeys: [...new Set(leaseKeys)].sort(),
    });
  }
}

function assertProjectionDerivedSemantics(
  projection: HistoryRetentionProjectionResult,
  registry: MatchIdentityRegistry,
): void {
  const basis = projection.continuationBasis;
  const directByEventId = new Map(basis.directMatches.map((match) => [match.eventId, match]));
  const expectedPins = new Map<number, HistoryRetentionPin>();
  for (const group of projection.demandGroups) {
    const matches = group.eventIds.flatMap((eventId) => {
      const match = directByEventId.get(eventId);
      return match ? [match] : [];
    }).sort((left, right) => left.absoluteIndex - right.absoluteIndex);
    const expectedResolvedEventIds = matches.map((match) => match.eventId);
    const resolvedSet = new Set(expectedResolvedEventIds);
    const expectedUnresolvedEventIds = group.eventIds.filter((eventId) => !resolvedSet.has(eventId));
    if (!sameStrings(group.resolvedEventIds, expectedResolvedEventIds)
      || !sameStrings(group.unresolvedEventIds, expectedUnresolvedEventIds)) {
      throw new Error(`retention demand group ${group.groupKey} 的 resolution 与 direct basis 不一致`);
    }
    const pinMatches = historyRetentionRequirementPinsResolvedEvents(group.requirement)
      ? group.requirement === 'any' ? matches.slice(-1) : matches
      : [];
    for (const match of pinMatches) addExpectedPin(expectedPins, match, group.leaseKeys);
  }
  const witness = projection.minimalMechanicalTeachingWitness;
  if (witness) {
    const base = `mechanical-teaching-operation-witness:${witness.audienceId}`;
    addExpectedPin(expectedPins, {
      absoluteIndex: witness.teachingAbsoluteIndex,
      eventId: witness.teachingEventId,
    }, [`${base}:teaching`]);
    addExpectedPin(expectedPins, {
      absoluteIndex: witness.operationAbsoluteIndex,
      eventId: witness.operationEventId,
    }, [`${base}:operation`]);
  }
  for (const ring of basis.millLaborRings) {
    for (const match of ring.matches) {
      addExpectedPin(expectedPins, match, [`living-mill-labor:${ring.personId}:recent-3`]);
    }
  }
  for (const item of basis.livingChildBirthMatches) {
    addExpectedPin(expectedPins, item.match, [livingChildBirthLeaseKey(item.childId)]);
  }
  for (const item of basis.selectiveMatches) {
    const production = parseRecentPersonalProductionLaborSelectorLeaseKey(item.leaseKey);
    const leases = production
      ? [item.leaseKey, recentPersonalProductionLaborLeaseKey(production.personId)]
      : [item.leaseKey];
    for (const match of item.matches) addExpectedPin(expectedPins, match, leases);
  }

  const expected = [...expectedPins.values()].sort(
    (left, right) => left.absoluteIndex - right.absoluteIndex,
  );
  if (JSON.stringify(expected) !== JSON.stringify(projection.pins)) {
    throw new Error('retention projection.pins 无法由 demand/basis selectors 精确重建');
  }
  for (const pin of projection.pins) registerMatchIdentity(registry, pin, 'retention projection pin');

  const witnessAchieved = witness !== null;
  if (projection.summary.mechanicalTeachingOperationAchieved !== witnessAchieved
    || (projection.summary.mechanicalP0.independentTaughtOperatorWitnesses > 0) !== witnessAchieved) {
    throw new Error('retention projection 的 mechanical teaching witness/summary 不一致');
  }
}

function normalizeProjection(
  value: unknown,
  options: {
    allowLegacyMissingProjectPressure?: boolean;
    allowLegacyFutureSocialRepetitionAudit?: boolean;
    allowLegacyLivePersonSocialAll?: boolean;
  } = {},
): HistoryRetentionProjectionResult {
  assertRecord(value, 'retention projection');
  assertExactKeys(value, [
    'schemaVersion',
    'authority',
    'target',
    'demandFingerprint',
    'millLaborPersonIds',
    'pins',
    'demandGroups',
    'unresolvedDemands',
    'minimalMechanicalTeachingWitness',
    'summary',
    'continuationReady',
    'continuationGaps',
    'continuationBasis',
  ], 'retention projection');
  if (value.schemaVersion !== HISTORY_RETENTION_SIDECAR_SCHEMA_VERSION) {
    throw new Error('retention projection.schemaVersion 无效');
  }
  const authority = normalizeAuthority(value.authority, 'retention projection.authority');
  const target = normalizeSeal(value.target, 'retention projection.target');
  assertHash(value.demandFingerprint, 'retention projection.demandFingerprint');
  const millLaborPersonIds = assertStringArray(
    value.millLaborPersonIds,
    'retention projection.millLaborPersonIds',
    { sorted: true },
  );
  const pins = normalizePins(value.pins, target);
  const demandGroups = normalizeDemandGroups(value.demandGroups);
  for (const group of demandGroups) {
    const liveSocial = parseLivePersonSocialEvidenceGroupKey(group.groupKey);
    if (!liveSocial) continue;
    const expectedLeaseKey = liveSocial.kind === 'broad'
      ? livePersonSocialEvidenceLeaseKey(liveSocial.ownerId)
      : livePersonSocialStrictEvidenceLeaseKey(liveSocial.ownerId, liveSocial.kind);
    const validRequirement = liveSocial.kind === 'broad'
      ? group.requirement === 'index-only'
        || options.allowLegacyLivePersonSocialAll && group.requirement === 'all'
      : group.requirement === 'all';
    if (!validRequirement
      || group.leaseKeys.length !== 1
      || group.leaseKeys[0] !== expectedLeaseKey
      || group.eventIds.length > HISTORY_RETENTION_MAX_LIVE_PERSON_SOCIAL_EVENT_IDS) {
      throw new Error(`retention projection demand group ${group.groupKey} social selector 无效或超界`);
    }
  }
  assertProjectPressureHistoryRetentionDemandGroups(
    demandGroups,
    'retention projection demand group',
    { allowLegacyMissing: options.allowLegacyMissingProjectPressure },
  );
  assertLiveIntentHistoryRetentionDemandGroups(
    demandGroups,
    'retention projection demand group',
  );
  const unresolvedDemands = normalizeUnresolvedDemands(value.unresolvedDemands, demandGroups);
  const minimalMechanicalTeachingWitness = normalizeWitness(
    value.minimalMechanicalTeachingWitness,
    target,
    'retention projection.minimalMechanicalTeachingWitness',
  );
  const summary = normalizeSummary(value.summary, target, 'retention projection.summary');
  if (value.continuationReady !== false) {
    throw new Error('retention projection.continuationReady 必须保持 false');
  }
  const continuationGaps = normalizeContinuationGaps(value.continuationGaps);
  const registry: MatchIdentityRegistry = { byOrdinal: new Map(), byEventId: new Map() };
  const continuationBasis = normalizeContinuationBasis(value.continuationBasis, {
    authority,
    target,
    demandFingerprint: value.demandFingerprint,
    millLaborPersonIds,
    demandGroups,
    minimalMechanicalTeachingWitness,
    summary,
  }, registry, options);
  const hasProjectPressureGroup = demandGroups.some((group) => (
    group.groupKey === LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY
  ));
  const sourceHasProjectPressureGroup = continuationBasis.sourceDemand.groups.some((group) => (
    group.groupKey === LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY
  ));
  if (hasProjectPressureGroup !== sourceHasProjectPressureGroup) {
    throw new Error('retention legacy project-pressure 缺组必须同时缺于 projection/sourceDemand');
  }
  if (!hasProjectPressureGroup) {
    const hasProjectPressurePin = pins.some((pin) => pin.leaseKeys.some((leaseKey) => (
      leaseKey.startsWith('gameplay:live-person-project-pressure:')
    )));
    const hasProjectPressureUnresolved = unresolvedDemands.some((item) => (
      item.groupKey.startsWith('gameplay:live-person-project-pressure:')
      || item.leaseKeys.some((leaseKey) => (
        leaseKey.startsWith('gameplay:live-person-project-pressure:')
      ))
    ));
    const hasProjectPressureSelector = continuationBasis.selectiveMatches.some((item) => (
      item.leaseKey.startsWith('gameplay:live-person-project-pressure:')
    ));
    if (hasProjectPressurePin || hasProjectPressureUnresolved || hasProjectPressureSelector) {
      throw new Error('retention legacy project-pressure 缺组仍携带 lease/unresolved 残留');
    }
  }
  const projection: HistoryRetentionProjectionResult = {
    schemaVersion: 1,
    authority,
    target,
    demandFingerprint: value.demandFingerprint,
    millLaborPersonIds,
    pins,
    demandGroups,
    unresolvedDemands,
    minimalMechanicalTeachingWitness,
    summary,
    continuationReady: false,
    continuationGaps,
    continuationBasis,
  };
  assertProjectionDerivedSemantics(projection, registry);
  return projection;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value)
    .sort()
    .map((key) => [key, canonicalJsonValue(value[key])]));
}

function canonicalBytes(projection: HistoryRetentionProjectionResult): Buffer {
  return Buffer.from(JSON.stringify(canonicalJsonValue(projection)), 'utf8');
}

function deepFreeze<T>(value: T, visited = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  const object = value as object;
  if (visited.has(object)) return value;
  visited.add(object);
  for (const child of Object.values(object as UnknownRecord)) deepFreeze(child, visited);
  return Object.freeze(value);
}

function ownedChunk(
  hash: string,
  codec: string,
  rawSize: number,
  data: Buffer | Uint8Array,
): Readonly<HistoryRetentionSidecarChunk> {
  if (data.byteLength > MAX_HISTORY_RETENTION_SIDECAR_STORED_BYTES) {
    throw new Error(
      `retention sidecar 存储内容超过硬上限 ${MAX_HISTORY_RETENTION_SIDECAR_STORED_BYTES}`,
    );
  }
  const ownedData = Buffer.from(data);
  return Object.freeze({
    hash,
    codec,
    rawSize,
    get data(): Buffer { return Buffer.from(ownedData); },
  });
}

export function hashHistoryRetentionStoredContent(codec: string, data: Uint8Array): string {
  return hashRunContinuationStoredContent(codec, data);
}

/**
 * Encode a completely validated result into owned canonical bytes. The
 * resulting reference proves content integrity only; it is not a store token.
 */
export function encodeHistoryRetentionSidecar(input: unknown): Readonly<EncodedHistoryRetentionSidecar> {
  const normalized = normalizeProjection(input);
  assertProjectPressureHistoryRetentionDemandGroups(
    normalized.demandGroups,
    'retention sidecar encoder demand group',
  );
  const projection = deepFreeze(normalized);
  const canonical = canonicalBytes(projection);
  if (canonical.byteLength > MAX_HISTORY_RETENTION_SIDECAR_CANONICAL_BYTES) {
    throw new Error(
      `retention sidecar canonical 内容超过硬上限 ${MAX_HISTORY_RETENTION_SIDECAR_CANONICAL_BYTES}`,
    );
  }
  const data = brotliCompressSync(canonical, BROTLI_OPTIONS);
  const hash = hashHistoryRetentionStoredContent(HISTORY_RETENTION_SIDECAR_CODEC, data);
  const chunk = ownedChunk(hash, HISTORY_RETENTION_SIDECAR_CODEC, data.byteLength, data);
  const reference = Object.freeze({
    kind: 'content-hash' as const,
    codec: HISTORY_RETENTION_SIDECAR_CODEC,
    hash,
  });
  return Object.freeze({ chunk, reference, projection });
}

function normalizeBoundary(value: unknown): HistoryRetentionSidecarBoundaryV1 {
  assertRecord(value, 'retention sidecar expected boundary');
  assertExactKeys(value, ['authority', 'target'], 'retention sidecar expected boundary');
  return {
    authority: normalizeAuthority(
      value.authority,
      'retention sidecar expected boundary.authority',
    ),
    target: normalizeSeal(value.target, 'retention sidecar expected boundary.target'),
  };
}

function normalizeDecodeExpectation(value: unknown): HistoryRetentionSidecarDecodeExpectationV1 {
  assertRecord(value, 'retention sidecar decode expectation');
  assertExactKeys(value, ['reference', 'boundary'], 'retention sidecar decode expectation');
  assertRecord(value.reference, 'retention sidecar expected reference');
  assertExactKeys(
    value.reference,
    ['kind', 'codec', 'hash'],
    'retention sidecar expected reference',
  );
  if (value.reference.kind !== 'content-hash') {
    throw new Error('retention sidecar 只接受 store-selected content-hash 引用');
  }
  if (value.reference.codec !== HISTORY_RETENTION_SIDECAR_CODEC
    && value.reference.codec !== HISTORY_RETENTION_SIDECAR_LEGACY_CODEC) {
    throw new Error('retention sidecar expected reference codec 无效');
  }
  assertHash(value.reference.hash, 'retention sidecar expected reference.hash');
  return {
    reference: {
      kind: 'content-hash',
      codec: value.reference.codec,
      hash: value.reference.hash,
    },
    boundary: normalizeBoundary(value.boundary),
  };
}

/**
 * Decode only bytes selected by a store-owned content reference and exact
 * authority/target boundary. Public bytes and hashes never grant authority.
 */
export function decodeHistoryRetentionSidecar(
  chunk: HistoryRetentionSidecarChunk,
  expectedInput: unknown,
): Readonly<HistoryRetentionProjectionResult> {
  const expected = normalizeDecodeExpectation(expectedInput);
  if (!chunk || typeof chunk !== 'object') throw new Error('retention sidecar chunk 必须是对象');
  const claimedHash = chunk.hash;
  const claimedCodec = chunk.codec;
  const claimedSize = chunk.rawSize;
  const suppliedData = chunk.data;
  if (claimedCodec !== expected.reference.codec || claimedHash !== expected.reference.hash) {
    throw new Error('retention sidecar chunk 不属于 store-selected content reference');
  }
  assertHash(claimedHash, 'retention sidecar chunk.hash');
  assertSafeIntegerAtLeast(claimedSize, 1, 'retention sidecar chunk.rawSize');
  if (!(Buffer.isBuffer(suppliedData) || suppliedData instanceof Uint8Array)) {
    throw new Error('retention sidecar chunk.data 必须是字节数组');
  }
  if (suppliedData.byteLength !== claimedSize) {
    throw new Error('retention sidecar chunk 长度与记录不一致');
  }
  if (suppliedData.byteLength > MAX_HISTORY_RETENTION_SIDECAR_STORED_BYTES) {
    throw new Error(
      `retention sidecar 存储内容超过硬上限 ${MAX_HISTORY_RETENTION_SIDECAR_STORED_BYTES}`,
    );
  }
  const data = Buffer.from(suppliedData);
  if (hashHistoryRetentionStoredContent(claimedCodec, data) !== claimedHash) {
    throw new Error(`retention sidecar chunk ${claimedHash} 的 SHA-256 校验失败`);
  }
  let canonical: Buffer;
  try {
    canonical = claimedCodec === HISTORY_RETENTION_SIDECAR_LEGACY_CODEC
      ? data
      : brotliDecompressSync(data, {
          maxOutputLength: MAX_HISTORY_RETENTION_SIDECAR_CANONICAL_BYTES,
        });
  } catch (error) {
    throw new Error(`retention sidecar chunk ${claimedHash} 无法解压`, { cause: error });
  }
  if (canonical.byteLength > MAX_HISTORY_RETENTION_SIDECAR_CANONICAL_BYTES) {
    throw new Error(
      `retention sidecar canonical 内容超过硬上限 ${MAX_HISTORY_RETENTION_SIDECAR_CANONICAL_BYTES}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonical.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`retention sidecar chunk ${claimedHash} 无法解析`, { cause: error });
  }
  const projection = normalizeProjection(parsed, {
    allowLegacyMissingProjectPressure: true,
    allowLegacyFutureSocialRepetitionAudit: true,
    allowLegacyLivePersonSocialAll: true,
  });
  if (!canonical.equals(canonicalBytes(projection))) {
    throw new Error('retention sidecar payload 不是 canonical 编码');
  }
  if (!sameAuthority(projection.authority, expected.boundary.authority)
    || !sameSeal(projection.target, expected.boundary.target)) {
    throw new Error('retention sidecar payload 与 expected authority/target boundary 不一致');
  }
  const decoded = deepFreeze(projection);
  decodedHistoryRetentionSidecars.add(decoded);
  return decoded;
}

/** Take an owned byte snapshot before a future store authority flow awaits. */
export function snapshotHistoryRetentionSidecarChunk(
  chunk: HistoryRetentionSidecarChunk,
): Readonly<HistoryRetentionSidecarChunk> {
  const claimedHash = chunk.hash;
  const claimedCodec = chunk.codec;
  const claimedSize = chunk.rawSize;
  const suppliedData = chunk.data;
  return ownedChunk(claimedHash, claimedCodec, claimedSize, suppliedData);
}
