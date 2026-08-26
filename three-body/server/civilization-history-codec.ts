import { createHash } from 'node:crypto';

import {
  CAPABILITY_MILESTONE_DEFINITIONS,
  CAPABILITY_MILESTONE_DEFINITION_VERSION,
} from '../src/game/eland/projection/capability-milestones';
import {
  DEFAULT_OBSERVER_CIVILIZATION_HISTORY_LIMITS,
  OBSERVER_CIVILIZATION_HISTORY_CONTINUATION_GAPS,
  type ObserverCivilizationEvidenceRef,
  type ObserverCivilizationEventHistory,
  type ObserverCivilizationHistoryLimits,
  type ObserverCivilizationHistoryProjection,
  type ObserverCivilizationHistoryTarget,
  type ObserverMilestoneDefinitionBasis,
  type ObserverMilestoneEpisodeBasis,
} from './observer-civilization-history-projection';

/**
 * Canonical persistence codec for the exact bounded civilization-observer
 * projection. The projection remains post-fact evidence and never becomes a
 * planner input, reward, unlock, or store authority token.
 */
export const OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC =
  'eland-observer-civilization-history-projection-json-v1';
export const OBSERVER_CIVILIZATION_HISTORY_SIDECAR_SCHEMA_VERSION = 1 as const;
export const OBSERVER_CIVILIZATION_HISTORY_SIDECAR_DOMAIN =
  'eland-observer-civilization-history-sidecar-v1' as const;

/** Parsing, canonicalization and normalization may coexist briefly in memory. */
export const MAX_OBSERVER_CIVILIZATION_HISTORY_SIDECAR_STORED_BYTES = 16 * 1_024 * 1_024;
export const MAX_OBSERVER_CIVILIZATION_HISTORY_SIDECAR_IDENTIFIER_BYTES = 4_096;
export const MAX_OBSERVER_CIVILIZATION_HISTORY_SIDECAR_GAP_BYTES = 16 * 1_024;
export const MAX_OBSERVER_CIVILIZATION_HISTORY_EVIDENCE_ORDER_KEY_BYTES = 512 * 1_024;

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_REPLAYABLE_EVIDENCE_EVENTS_PER_DEFINITION = 64;
const STRICT_MILESTONE_DEFINITIONS = CAPABILITY_MILESTONE_DEFINITIONS.filter(
  (definition) => definition.support === 'strict',
);
const STRICT_MILESTONE_DEFINITION_BY_ID = new Map(
  STRICT_MILESTONE_DEFINITIONS.map((definition) => [definition.id, definition]),
);
const LIMIT_KEYS = [
  'maxTaughtFactIds',
  'maxRealizedProcessKeys',
  'maxInteractionDyadKeys',
  'maxInteractionKinds',
  'maxCausalEventAnchorIds',
  'maxTurningCategories',
  'maxMilestoneParticipantIdsPerDefinition',
  'maxMilestoneAffectedPersonIdsPerDefinition',
] as const satisfies readonly (keyof ObserverCivilizationHistoryLimits)[];
const EXPECTED_CONTINUATION_GAPS = OBSERVER_CIVILIZATION_HISTORY_CONTINUATION_GAPS;

type UnknownRecord = Record<string, unknown>;

export interface ObserverCivilizationHistorySidecarPayloadV1 {
  readonly schemaVersion: 1;
  readonly domain: typeof OBSERVER_CIVILIZATION_HISTORY_SIDECAR_DOMAIN;
  readonly projection: Readonly<ObserverCivilizationHistoryProjection>;
}

export interface ObserverCivilizationHistorySidecarChunk {
  hash: string;
  codec: string;
  /** Stored-byte length. V1 stores canonical UTF-8 JSON directly. */
  rawSize: number;
  data: Buffer | Uint8Array;
}

export interface ObserverCivilizationHistorySidecarContentReferenceV1 {
  kind: 'content-hash';
  codec: typeof OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC;
  hash: string;
}

/** Must be selected from the same continuation bundle/root CAS as the reference. */
export interface ObserverCivilizationHistorySidecarBoundaryV1 {
  target: Readonly<ObserverCivilizationHistoryTarget>;
}

export interface ObserverCivilizationHistorySidecarDecodeExpectationV1 {
  /** Must be selected from the exact continuation bundle by the owning store. */
  reference: Readonly<ObserverCivilizationHistorySidecarContentReferenceV1>;
  /** Must be selected from the same exact run/root store snapshot. */
  boundary: Readonly<ObserverCivilizationHistorySidecarBoundaryV1>;
}

export interface EncodedObserverCivilizationHistorySidecar {
  chunk: Readonly<ObserverCivilizationHistorySidecarChunk>;
  reference: Readonly<ObserverCivilizationHistorySidecarContentReferenceV1>;
  sidecar: Readonly<ObserverCivilizationHistorySidecarPayloadV1>;
}

const decodedObserverCivilizationHistorySidecars = new WeakSet<object>();

/** Runtime provenance seam: only the strict store-selected decoder can mint this identity. */
export function assertDecodedObserverCivilizationHistorySidecar(
  value: unknown,
): asserts value is Readonly<ObserverCivilizationHistorySidecarPayloadV1> {
  if (!value || typeof value !== 'object' || !decodedObserverCivilizationHistorySidecars.has(value)) {
    throw new Error('civilization observer sidecar 未经过 strict store-selected decoder');
  }
}

interface EvidenceIdentity {
  absoluteIndex: number;
  eventId: string;
  atMonth: number;
  who?: string;
}

interface EvidenceIdentityRegistry {
  byAbsoluteIndex: Map<number, EvidenceIdentity>;
  byEventId: Map<string, EvidenceIdentity>;
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

function safeIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  assertSafeIntegerInRange(value, minimum, maximum, label);
  return value;
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} 必须是布尔值`);
}

function assertBoundedString(
  value: unknown,
  label: string,
  maximumBytes = MAX_OBSERVER_CIVILIZATION_HISTORY_SIDECAR_IDENTIFIER_BYTES,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
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

function normalizeTarget(value: unknown, label: string): ObserverCivilizationHistoryTarget {
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
  left: ObserverCivilizationHistoryTarget,
  right: ObserverCivilizationHistoryTarget,
): boolean {
  return left.stateHash === right.stateHash
    && left.eventCount === right.eventCount
    && left.tailEventId === right.tailEventId;
}

function normalizeLimits(value: unknown): ObserverCivilizationHistoryLimits {
  assertRecord(value, 'civilization projection.limits');
  assertExactKeys(value, LIMIT_KEYS, 'civilization projection.limits');
  const normalizedLimit = (key: keyof ObserverCivilizationHistoryLimits): number =>
    safeIntegerInRange(
      value[key],
      0,
      DEFAULT_OBSERVER_CIVILIZATION_HISTORY_LIMITS[key],
      `civilization projection.limits.${key}`,
    );
  return {
    maxTaughtFactIds: normalizedLimit('maxTaughtFactIds'),
    maxRealizedProcessKeys: normalizedLimit('maxRealizedProcessKeys'),
    maxInteractionDyadKeys: normalizedLimit('maxInteractionDyadKeys'),
    maxInteractionKinds: normalizedLimit('maxInteractionKinds'),
    maxCausalEventAnchorIds: normalizedLimit('maxCausalEventAnchorIds'),
    maxTurningCategories: normalizedLimit('maxTurningCategories'),
    maxMilestoneParticipantIdsPerDefinition: normalizedLimit(
      'maxMilestoneParticipantIdsPerDefinition',
    ),
    maxMilestoneAffectedPersonIdsPerDefinition: normalizedLimit(
      'maxMilestoneAffectedPersonIdsPerDefinition',
    ),
  };
}

function normalizeSortedUniqueStrings(
  value: unknown,
  maximumLength: number,
  label: string,
): string[] {
  assertArray(value, maximumLength, label);
  const result: string[] = [];
  let previous: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    assertBoundedString(item, `${label}[${index}]`);
    if (previous !== null && previous >= item) {
      throw new Error(`${label} 必须按字典序严格排列且无重复项`);
    }
    result.push(item);
    previous = item;
  }
  return result;
}

function normalizeEventHistory(
  value: unknown,
  target: ObserverCivilizationHistoryTarget,
  limits: ObserverCivilizationHistoryLimits,
): ObserverCivilizationEventHistory {
  assertRecord(value, 'civilization projection.eventHistory');
  assertExactKeys(value, [
    'births',
    'deaths',
    'agreementOutcomes',
    'eraTransitions',
    'taughtFactIds',
    'realizedProcessKeys',
    'interactionDyadKeys',
    'interactionKinds',
    'causalEventAnchorIds',
    'turningCategories',
  ], 'civilization projection.eventHistory');
  const births = safeIntegerInRange(
    value.births,
    0,
    target.eventCount,
    'civilization projection.eventHistory.births',
  );
  const deaths = safeIntegerInRange(
    value.deaths,
    0,
    target.eventCount,
    'civilization projection.eventHistory.deaths',
  );
  const agreementOutcomes = safeIntegerInRange(
    value.agreementOutcomes,
    0,
    target.eventCount,
    'civilization projection.eventHistory.agreementOutcomes',
  );
  const eraTransitions = safeIntegerInRange(
    value.eraTransitions,
    0,
    target.eventCount,
    'civilization projection.eventHistory.eraTransitions',
  );
  const taughtFactIds = normalizeSortedUniqueStrings(
    value.taughtFactIds,
    limits.maxTaughtFactIds,
    'civilization projection.eventHistory.taughtFactIds',
  );
  const realizedProcessKeys = normalizeSortedUniqueStrings(
    value.realizedProcessKeys,
    limits.maxRealizedProcessKeys,
    'civilization projection.eventHistory.realizedProcessKeys',
  );
  for (const [index, key] of realizedProcessKeys.entries()) {
    if (!/^(combine|separate|exert|expose|hunt):.+$/u.test(key)) {
      throw new Error(`civilization projection.eventHistory.realizedProcessKeys[${index}] 无效`);
    }
  }
  const interactionDyadKeys = normalizeSortedUniqueStrings(
    value.interactionDyadKeys,
    limits.maxInteractionDyadKeys,
    'civilization projection.eventHistory.interactionDyadKeys',
  );
  for (const [index, key] of interactionDyadKeys.entries()) {
    const separator = key.indexOf('|');
    if (separator <= 0 || separator !== key.lastIndexOf('|') || separator >= key.length - 1) {
      throw new Error(`civilization projection.eventHistory.interactionDyadKeys[${index}] 无效`);
    }
    const left = key.slice(0, separator);
    const right = key.slice(separator + 1);
    if (left >= right) {
      throw new Error(`civilization projection.eventHistory.interactionDyadKeys[${index}] 未 canonical 化`);
    }
  }
  const interactionKinds = normalizeSortedUniqueStrings(
    value.interactionKinds,
    limits.maxInteractionKinds,
    'civilization projection.eventHistory.interactionKinds',
  );
  const causalEventAnchorIds = normalizeSortedUniqueStrings(
    value.causalEventAnchorIds,
    limits.maxCausalEventAnchorIds,
    'civilization projection.eventHistory.causalEventAnchorIds',
  );
  const turningCategories = normalizeSortedUniqueStrings(
    value.turningCategories,
    limits.maxTurningCategories,
    'civilization projection.eventHistory.turningCategories',
  );
  const turningSet = new Set(turningCategories);
  if ((births > 0) !== turningSet.has('birth')
    || (deaths > 0) !== turningSet.has('death')) {
    throw new Error('civilization projection birth/death count 与 turningCategories 不一致');
  }
  const agreementCategories = turningCategories.filter((item) => item.startsWith('agreement:'));
  if (agreementCategories.some((item) => item !== 'agreement:fulfilled'
    && item !== 'agreement:breached')
    || (agreementOutcomes > 0) !== (agreementCategories.length > 0)
    || agreementCategories.length > agreementOutcomes) {
    throw new Error('civilization projection agreementOutcomes 与 turningCategories 不一致');
  }
  const eraCategories = turningCategories.filter((item) => item.startsWith('era:'));
  if ((eraTransitions > 0) !== (eraCategories.length > 0)
    || eraCategories.length > eraTransitions) {
    throw new Error('civilization projection eraTransitions 与 turningCategories 不一致');
  }
  const recognizedTurningCategoryCount = Number(births > 0)
    + Number(deaths > 0)
    + agreementCategories.length
    + eraCategories.length;
  if (recognizedTurningCategoryCount !== turningCategories.length) {
    throw new Error('civilization projection.turningCategories 包含未知类别');
  }
  const causalCount = births + deaths + agreementOutcomes + eraTransitions;
  if (!Number.isSafeInteger(causalCount)
    || (causalCount === 0) !== (causalEventAnchorIds.length === 0)
    || causalEventAnchorIds.length > causalCount) {
    throw new Error('civilization projection causal counts 与 causalEventAnchorIds 不一致');
  }
  return {
    births,
    deaths,
    agreementOutcomes,
    eraTransitions,
    taughtFactIds,
    realizedProcessKeys,
    interactionDyadKeys,
    interactionKinds,
    causalEventAnchorIds,
    turningCategories,
  };
}

function evidenceIdentityMatches(left: EvidenceIdentity, right: EvidenceIdentity): boolean {
  return left.absoluteIndex === right.absoluteIndex
    && left.eventId === right.eventId
    && left.atMonth === right.atMonth
    && left.who === right.who;
}

function registerEvidenceIdentity(
  registry: EvidenceIdentityRegistry,
  evidence: EvidenceIdentity,
  label: string,
): void {
  const byAbsoluteIndex = registry.byAbsoluteIndex.get(evidence.absoluteIndex);
  if (byAbsoluteIndex && !evidenceIdentityMatches(byAbsoluteIndex, evidence)) {
    throw new Error(`${label} 与同 absoluteIndex 的 evidence identity 冲突`);
  }
  const byEventId = registry.byEventId.get(evidence.eventId);
  if (byEventId && !evidenceIdentityMatches(byEventId, evidence)) {
    throw new Error(`${label} 与同 eventId 的 evidence identity 冲突`);
  }
  registry.byAbsoluteIndex.set(evidence.absoluteIndex, evidence);
  registry.byEventId.set(evidence.eventId, evidence);
}

function normalizeEvidenceReference(
  value: unknown,
  target: ObserverCivilizationHistoryTarget,
  registry: EvidenceIdentityRegistry,
  label: string,
): ObserverCivilizationEvidenceRef {
  assertRecord(value, label);
  const hasWho = Object.prototype.hasOwnProperty.call(value, 'who');
  assertExactKeys(value, hasWho
    ? ['absoluteIndex', 'eventId', 'atMonth', 'who']
    : ['absoluteIndex', 'eventId', 'atMonth'], label);
  if (target.eventCount === 0) throw new Error(`${label} 不得存在于空 history target`);
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
    Number.MAX_SAFE_INTEGER,
    `${label}.atMonth`,
  );
  if (hasWho) assertBoundedString(value.who, `${label}.who`);
  if ((value.absoluteIndex === target.eventCount - 1) !== (value.eventId === target.tailEventId)) {
    throw new Error(`${label} 与 target tail identity 不一致`);
  }
  const evidence: ObserverCivilizationEvidenceRef = {
    absoluteIndex: value.absoluteIndex,
    eventId: value.eventId,
    atMonth: value.atMonth,
    ...(hasWho ? { who: value.who as string } : {}),
  };
  registerEvidenceIdentity(registry, evidence, label);
  return evidence;
}

function normalizeEpisodeIds(
  value: unknown,
  maximumLength: number,
  label: string,
): string[] {
  return normalizeSortedUniqueStrings(value, maximumLength, label);
}

function normalizeMilestoneEpisode(
  value: unknown,
  target: ObserverCivilizationHistoryTarget,
  limits: ObserverCivilizationHistoryLimits,
  registry: EvidenceIdentityRegistry,
  label: string,
): ObserverMilestoneEpisodeBasis {
  assertRecord(value, label);
  assertExactKeys(
    value,
    ['observedAtMonth', 'evidence', 'participantIds', 'affectedPersonIds'],
    label,
  );
  assertSafeIntegerInRange(
    value.observedAtMonth,
    0,
    Number.MAX_SAFE_INTEGER,
    `${label}.observedAtMonth`,
  );
  assertArray(value.evidence, MAX_REPLAYABLE_EVIDENCE_EVENTS_PER_DEFINITION, `${label}.evidence`);
  if (value.evidence.length === 0) throw new Error(`${label}.evidence 必须是非空数组`);
  const evidence: ObserverCivilizationEvidenceRef[] = [];
  let previousAbsoluteIndex = -1;
  for (let index = 0; index < value.evidence.length; index += 1) {
    const reference = normalizeEvidenceReference(
      value.evidence[index],
      target,
      registry,
      `${label}.evidence[${index}]`,
    );
    if (reference.absoluteIndex <= previousAbsoluteIndex) {
      throw new Error(`${label}.evidence 未按 absoluteIndex 严格排列`);
    }
    evidence.push(reference);
    previousAbsoluteIndex = reference.absoluteIndex;
  }
  if (Math.max(...evidence.map((reference) => reference.atMonth)) !== value.observedAtMonth) {
    throw new Error(`${label}.observedAtMonth 与 evidence 尾月不一致`);
  }
  return {
    observedAtMonth: value.observedAtMonth,
    evidence,
    participantIds: normalizeEpisodeIds(
      value.participantIds,
      limits.maxMilestoneParticipantIdsPerDefinition,
      `${label}.participantIds`,
    ),
    affectedPersonIds: normalizeEpisodeIds(
      value.affectedPersonIds,
      limits.maxMilestoneAffectedPersonIdsPerDefinition,
      `${label}.affectedPersonIds`,
    ),
  };
}

function evidenceOrderKey(episode: ObserverMilestoneEpisodeBasis): string {
  return episode.evidence.map((reference) => reference.eventId).join('|');
}

function compareCandidateOrder(
  left: Readonly<{ observedAtMonth: number; evidenceOrderKey: string }>,
  right: Readonly<{ observedAtMonth: number; evidenceOrderKey: string }>,
): number {
  if (left.observedAtMonth !== right.observedAtMonth) {
    return left.observedAtMonth < right.observedAtMonth ? -1 : 1;
  }
  if (left.evidenceOrderKey === right.evidenceOrderKey) return 0;
  return left.evidenceOrderKey < right.evidenceOrderKey ? -1 : 1;
}

function normalizeLastCandidateOrder(
  value: unknown,
  label: string,
): { observedAtMonth: number; evidenceOrderKey: string } | null {
  if (value === null) return null;
  assertRecord(value, label);
  assertExactKeys(value, ['observedAtMonth', 'evidenceOrderKey'], label);
  assertSafeIntegerInRange(
    value.observedAtMonth,
    0,
    Number.MAX_SAFE_INTEGER,
    `${label}.observedAtMonth`,
  );
  assertBoundedString(
    value.evidenceOrderKey,
    `${label}.evidenceOrderKey`,
    MAX_OBSERVER_CIVILIZATION_HISTORY_EVIDENCE_ORDER_KEY_BYTES,
  );
  return {
    observedAtMonth: value.observedAtMonth,
    evidenceOrderKey: value.evidenceOrderKey,
  };
}

function normalizeMilestoneBasis(
  value: unknown,
  target: ObserverCivilizationHistoryTarget,
  limits: ObserverCivilizationHistoryLimits,
  registry: EvidenceIdentityRegistry,
  label: string,
): ObserverMilestoneDefinitionBasis {
  assertRecord(value, label);
  assertExactKeys(value, [
    'definitionId',
    'definitionVersion',
    'lastCandidateOrder',
    'episodes',
    'distinctEvidenceEvents',
    'distinctEvidenceMonths',
    'distinctParticipants',
    'stageCriteriaSatisfied',
  ], label);
  assertBoundedString(value.definitionId, `${label}.definitionId`);
  const definition = STRICT_MILESTONE_DEFINITION_BY_ID.get(value.definitionId);
  if (!definition) throw new Error(`${label}.definitionId 不是当前 strict milestone definition`);
  if (value.definitionVersion !== CAPABILITY_MILESTONE_DEFINITION_VERSION) {
    throw new Error(`${label}.definitionVersion 无效`);
  }
  const lastCandidateOrder = normalizeLastCandidateOrder(
    value.lastCandidateOrder,
    `${label}.lastCandidateOrder`,
  );
  assertArray(value.episodes, definition.stageCriteria.evidenceEpisodeLimit, `${label}.episodes`);
  const episodes: ObserverMilestoneEpisodeBasis[] = [];
  const evidenceEventIds = new Set<string>();
  const evidenceMonths = new Set<number>();
  const participantIds = new Set<string>();
  const affectedPersonIds = new Set<string>();
  const signatures = new Set<string>();
  let previousAcceptedOrder: { observedAtMonth: number; evidenceOrderKey: string } | null = null;
  for (let index = 0; index < value.episodes.length; index += 1) {
    const episode = normalizeMilestoneEpisode(
      value.episodes[index],
      target,
      limits,
      registry,
      `${label}.episodes[${index}]`,
    );
    const order = {
      observedAtMonth: episode.observedAtMonth,
      evidenceOrderKey: evidenceOrderKey(episode),
    };
    if (previousAcceptedOrder && compareCandidateOrder(previousAcceptedOrder, order) >= 0) {
      throw new Error(`${label}.episodes 未按 canonical candidate order 严格排列`);
    }
    const signature = [...episode.evidence.map((reference) => reference.eventId)].sort().join('|');
    if (signatures.has(signature)) throw new Error(`${label}.episodes 包含重复 evidence signature`);
    const hasNewEvidence = episode.evidence.some(
      (reference) => !evidenceEventIds.has(reference.eventId),
    );
    if (!hasNewEvidence) throw new Error(`${label}.episodes 缺少新增 evidence event`);
    signatures.add(signature);
    for (const reference of episode.evidence) {
      evidenceEventIds.add(reference.eventId);
      evidenceMonths.add(reference.atMonth);
    }
    for (const personId of episode.participantIds) participantIds.add(personId);
    for (const personId of episode.affectedPersonIds) affectedPersonIds.add(personId);
    if (evidenceEventIds.size > MAX_REPLAYABLE_EVIDENCE_EVENTS_PER_DEFINITION) {
      throw new Error(`${label} 的 distinct evidence events 超过显式上限`);
    }
    if (participantIds.size > limits.maxMilestoneParticipantIdsPerDefinition
      || affectedPersonIds.size > limits.maxMilestoneAffectedPersonIdsPerDefinition) {
      throw new Error(`${label} 的 milestone person IDs 超过配置上限`);
    }
    episodes.push(episode);
    previousAcceptedOrder = order;
  }
  if (previousAcceptedOrder
    && (!lastCandidateOrder || compareCandidateOrder(lastCandidateOrder, previousAcceptedOrder) < 0)) {
    throw new Error(`${label}.lastCandidateOrder 早于已接受 episode`);
  }
  if (target.eventCount === 0 && (episodes.length > 0 || lastCandidateOrder !== null)) {
    throw new Error(`${label} 不得在空 history target 中包含 candidate basis`);
  }
  assertSafeIntegerInRange(
    value.distinctEvidenceEvents,
    0,
    MAX_REPLAYABLE_EVIDENCE_EVENTS_PER_DEFINITION,
    `${label}.distinctEvidenceEvents`,
  );
  assertSafeIntegerInRange(
    value.distinctEvidenceMonths,
    0,
    target.eventCount,
    `${label}.distinctEvidenceMonths`,
  );
  assertSafeIntegerInRange(
    value.distinctParticipants,
    0,
    limits.maxMilestoneParticipantIdsPerDefinition,
    `${label}.distinctParticipants`,
  );
  assertBoolean(value.stageCriteriaSatisfied, `${label}.stageCriteriaSatisfied`);
  const criteria = definition.stageCriteria;
  const stageCriteriaSatisfied = episodes.length >= criteria.minEpisodes
    && evidenceMonths.size >= criteria.minDistinctMonths
    && participantIds.size >= criteria.minDistinctActors
    && evidenceEventIds.size >= criteria.minEvidenceEvents;
  if (value.distinctEvidenceEvents !== evidenceEventIds.size
    || value.distinctEvidenceMonths !== evidenceMonths.size
    || value.distinctParticipants !== participantIds.size
    || value.stageCriteriaSatisfied !== stageCriteriaSatisfied) {
    throw new Error(`${label} 的 derived milestone counts/stage criteria 不一致`);
  }
  return {
    definitionId: value.definitionId,
    definitionVersion: CAPABILITY_MILESTONE_DEFINITION_VERSION,
    lastCandidateOrder,
    episodes,
    distinctEvidenceEvents: evidenceEventIds.size,
    distinctEvidenceMonths: evidenceMonths.size,
    distinctParticipants: participantIds.size,
    stageCriteriaSatisfied,
  };
}

function validateEvidenceLedgerOrder(registry: EvidenceIdentityRegistry): void {
  const evidence = [...registry.byAbsoluteIndex.values()]
    .sort((left, right) => left.absoluteIndex - right.absoluteIndex);
  for (let index = 1; index < evidence.length; index += 1) {
    if (evidence[index].atMonth < evidence[index - 1].atMonth) {
      throw new Error('civilization projection milestone evidence month 与 ledger order 冲突');
    }
  }
}

function normalizeContinuationGaps(value: unknown): string[] {
  assertArray(value, EXPECTED_CONTINUATION_GAPS.length, 'civilization projection.continuationGaps');
  if (value.length !== EXPECTED_CONTINUATION_GAPS.length) {
    throw new Error('civilization projection.continuationGaps 缺少当前 fail-closed gap');
  }
  return value.map((item, index) => {
    assertBoundedString(
      item,
      `civilization projection.continuationGaps[${index}]`,
      MAX_OBSERVER_CIVILIZATION_HISTORY_SIDECAR_GAP_BYTES,
    );
    if (item !== EXPECTED_CONTINUATION_GAPS[index]) {
      throw new Error('civilization projection.continuationGaps 与当前 observer 定义不一致');
    }
    return item;
  });
}

function normalizeProjection(value: unknown): ObserverCivilizationHistoryProjection {
  assertRecord(value, 'civilization projection');
  assertExactKeys(value, [
    'schemaVersion',
    'target',
    'limits',
    'eventHistory',
    'milestoneDefinitionVersion',
    'milestoneBasis',
    'completeMilestoneDefinitionIds',
    'continuationReady',
    'continuationGaps',
  ], 'civilization projection');
  if (value.schemaVersion !== OBSERVER_CIVILIZATION_HISTORY_SIDECAR_SCHEMA_VERSION) {
    throw new Error('civilization projection.schemaVersion 无效');
  }
  const target = normalizeTarget(value.target, 'civilization projection.target');
  const limits = normalizeLimits(value.limits);
  const eventHistory = normalizeEventHistory(value.eventHistory, target, limits);
  if (value.milestoneDefinitionVersion !== CAPABILITY_MILESTONE_DEFINITION_VERSION) {
    throw new Error('civilization projection.milestoneDefinitionVersion 无效');
  }
  assertArray(
    value.milestoneBasis,
    STRICT_MILESTONE_DEFINITIONS.length,
    'civilization projection.milestoneBasis',
  );
  const registry: EvidenceIdentityRegistry = {
    byAbsoluteIndex: new Map(),
    byEventId: new Map(),
  };
  const milestoneBasis: ObserverMilestoneDefinitionBasis[] = [];
  const basisDefinitionIds = new Set<string>();
  let previousDefinitionId: string | null = null;
  for (let index = 0; index < value.milestoneBasis.length; index += 1) {
    const basis = normalizeMilestoneBasis(
      value.milestoneBasis[index],
      target,
      limits,
      registry,
      `civilization projection.milestoneBasis[${index}]`,
    );
    if (basisDefinitionIds.has(basis.definitionId)
      || (previousDefinitionId !== null
        && previousDefinitionId.localeCompare(basis.definitionId) >= 0)) {
      throw new Error('civilization projection.milestoneBasis 未按 definition ID 严格排列');
    }
    milestoneBasis.push(basis);
    basisDefinitionIds.add(basis.definitionId);
    previousDefinitionId = basis.definitionId;
  }
  validateEvidenceLedgerOrder(registry);
  const completeMilestoneDefinitionIds = normalizeSortedUniqueStrings(
    value.completeMilestoneDefinitionIds,
    STRICT_MILESTONE_DEFINITIONS.length,
    'civilization projection.completeMilestoneDefinitionIds',
  );
  for (const definitionId of completeMilestoneDefinitionIds) {
    if (!STRICT_MILESTONE_DEFINITION_BY_ID.has(definitionId)) {
      throw new Error(`civilization projection complete definition ${definitionId} 不是 strict definition`);
    }
    if (!basisDefinitionIds.has(definitionId)) {
      throw new Error(`civilization projection complete definition ${definitionId} 缺少完整 basis`);
    }
  }
  if (value.continuationReady !== false) {
    throw new Error('civilization projection.continuationReady 必须保持 false');
  }
  const continuationGaps = normalizeContinuationGaps(value.continuationGaps);
  return {
    schemaVersion: OBSERVER_CIVILIZATION_HISTORY_SIDECAR_SCHEMA_VERSION,
    target,
    limits,
    eventHistory,
    milestoneDefinitionVersion: CAPABILITY_MILESTONE_DEFINITION_VERSION,
    milestoneBasis,
    completeMilestoneDefinitionIds,
    continuationReady: false,
    continuationGaps,
  };
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value)
    .sort()
    .map((key) => [key, canonicalJsonValue(value[key])]));
}

function normalizeSidecarInput(value: unknown): ObserverCivilizationHistorySidecarPayloadV1 {
  return {
    schemaVersion: OBSERVER_CIVILIZATION_HISTORY_SIDECAR_SCHEMA_VERSION,
    domain: OBSERVER_CIVILIZATION_HISTORY_SIDECAR_DOMAIN,
    projection: normalizeProjection(value),
  };
}

function normalizeStoredSidecar(value: unknown): ObserverCivilizationHistorySidecarPayloadV1 {
  assertRecord(value, 'civilization sidecar');
  assertExactKeys(value, ['schemaVersion', 'domain', 'projection'], 'civilization sidecar');
  if (value.schemaVersion !== OBSERVER_CIVILIZATION_HISTORY_SIDECAR_SCHEMA_VERSION) {
    throw new Error('civilization sidecar.schemaVersion 无效');
  }
  if (value.domain !== OBSERVER_CIVILIZATION_HISTORY_SIDECAR_DOMAIN) {
    throw new Error('civilization sidecar.domain 无效');
  }
  return {
    schemaVersion: OBSERVER_CIVILIZATION_HISTORY_SIDECAR_SCHEMA_VERSION,
    domain: OBSERVER_CIVILIZATION_HISTORY_SIDECAR_DOMAIN,
    projection: normalizeProjection(value.projection),
  };
}

function canonicalBytes(sidecar: ObserverCivilizationHistorySidecarPayloadV1): Buffer {
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

export function hashObserverCivilizationHistoryStoredContent(
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
): Readonly<ObserverCivilizationHistorySidecarChunk> {
  assertHash(hash, 'civilization sidecar chunk.hash');
  if (codec !== OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC) {
    throw new Error('civilization sidecar chunk.codec 无效');
  }
  assertSafeIntegerInRange(rawSize, 1, Number.MAX_SAFE_INTEGER, 'civilization sidecar chunk.rawSize');
  if (rawSize > MAX_OBSERVER_CIVILIZATION_HISTORY_SIDECAR_STORED_BYTES) {
    throw new Error(
      `civilization sidecar 存储内容超过硬上限 ${MAX_OBSERVER_CIVILIZATION_HISTORY_SIDECAR_STORED_BYTES}`,
    );
  }
  if (!(Buffer.isBuffer(data) || data instanceof Uint8Array)) {
    throw new Error('civilization sidecar chunk.data 必须是字节数组');
  }
  if (data.byteLength !== rawSize) {
    throw new Error('civilization sidecar chunk 长度与记录不一致');
  }
  const ownedData = Buffer.from(data);
  return Object.freeze({
    hash,
    codec,
    rawSize,
    get data(): Buffer { return Buffer.from(ownedData); },
  });
}

/** Encode one completely validated projection into owned canonical bytes. */
export function encodeObserverCivilizationHistorySidecar(
  input: unknown,
): Readonly<EncodedObserverCivilizationHistorySidecar> {
  const sidecar = deepFreeze(normalizeSidecarInput(input));
  const data = canonicalBytes(sidecar);
  if (data.byteLength > MAX_OBSERVER_CIVILIZATION_HISTORY_SIDECAR_STORED_BYTES) {
    throw new Error(
      `civilization sidecar 存储内容超过硬上限 ${MAX_OBSERVER_CIVILIZATION_HISTORY_SIDECAR_STORED_BYTES}`,
    );
  }
  const hash = hashObserverCivilizationHistoryStoredContent(
    OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC,
    data,
  );
  const chunk = ownedChunk(
    hash,
    OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC,
    data.byteLength,
    data,
  );
  const reference = Object.freeze({
    kind: 'content-hash' as const,
    codec: OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC,
    hash,
  });
  return Object.freeze({ chunk, reference, sidecar });
}

function normalizeBoundary(value: unknown): ObserverCivilizationHistorySidecarBoundaryV1 {
  assertRecord(value, 'civilization sidecar expected boundary');
  assertExactKeys(value, ['target'], 'civilization sidecar expected boundary');
  return {
    target: normalizeTarget(value.target, 'civilization sidecar expected boundary.target'),
  };
}

function normalizeDecodeExpectation(
  value: unknown,
): ObserverCivilizationHistorySidecarDecodeExpectationV1 {
  assertRecord(value, 'civilization sidecar decode expectation');
  assertExactKeys(value, ['reference', 'boundary'], 'civilization sidecar decode expectation');
  assertRecord(value.reference, 'civilization sidecar expected reference');
  assertExactKeys(
    value.reference,
    ['kind', 'codec', 'hash'],
    'civilization sidecar expected reference',
  );
  if (value.reference.kind !== 'content-hash') {
    throw new Error('civilization sidecar 只接受 store-selected content-hash 引用');
  }
  if (value.reference.codec !== OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC) {
    throw new Error('civilization sidecar expected reference.codec 无效');
  }
  assertHash(value.reference.hash, 'civilization sidecar expected reference.hash');
  return {
    reference: {
      kind: 'content-hash',
      codec: OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC,
      hash: value.reference.hash,
    },
    boundary: normalizeBoundary(value.boundary),
  };
}

/**
 * Decode only bytes selected by a store-owned content reference and an exact
 * run/root/history boundary. A caller-computed digest never selects authority.
 */
export function decodeObserverCivilizationHistorySidecar(
  chunk: ObserverCivilizationHistorySidecarChunk,
  expectedInput: unknown,
): Readonly<ObserverCivilizationHistorySidecarPayloadV1> {
  const expected = normalizeDecodeExpectation(expectedInput);
  if (!chunk || typeof chunk !== 'object') throw new Error('civilization sidecar chunk 必须是对象');
  if (chunk.codec !== expected.reference.codec || chunk.hash !== expected.reference.hash) {
    throw new Error('civilization sidecar chunk 不属于 store-selected content reference');
  }
  const snapshot = ownedChunk(chunk.hash, chunk.codec, chunk.rawSize, chunk.data);
  const data = Buffer.from(snapshot.data);
  if (hashObserverCivilizationHistoryStoredContent(snapshot.codec, data) !== snapshot.hash) {
    throw new Error(`civilization sidecar chunk ${snapshot.hash} 的 SHA-256 校验失败`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`civilization sidecar chunk ${snapshot.hash} 无法解析`, { cause: error });
  }
  const sidecar = normalizeStoredSidecar(parsed);
  if (!data.equals(canonicalBytes(sidecar))) {
    throw new Error('civilization sidecar payload 不是 canonical UTF-8 JSON 编码');
  }
  if (!sameTarget(sidecar.projection.target, expected.boundary.target)) {
    throw new Error('civilization sidecar payload 与 store-selected exact target 不一致');
  }
  const decoded = deepFreeze(sidecar);
  decodedObserverCivilizationHistorySidecars.add(decoded);
  return decoded;
}

/** Take an owned byte snapshot before a future store authority flow awaits. */
export function snapshotObserverCivilizationHistorySidecarChunk(
  chunk: ObserverCivilizationHistorySidecarChunk,
): Readonly<ObserverCivilizationHistorySidecarChunk> {
  if (!chunk || typeof chunk !== 'object') throw new Error('civilization sidecar chunk 必须是对象');
  return ownedChunk(chunk.hash, chunk.codec, chunk.rawSize, chunk.data);
}
