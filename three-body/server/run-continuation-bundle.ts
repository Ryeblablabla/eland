import { createHash } from 'node:crypto';
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
} from 'node:zlib';

/**
 * Integrity codec for a bounded continuation manifest. This is deliberately
 * not a database authority token: a store still has to compare every authority
 * field with the current exact root/revision in one CAS transaction.
 */
export const RUN_CONTINUATION_BUNDLE_CODEC = 'eland-run-continuation-v1';
export const RUN_CONTINUATION_BUNDLE_SCHEMA_VERSION = 1 as const;
export const RUN_CONTINUATION_HISTORY_MODE = 'bounded-hot-tail-plus-cold-pins-v1' as const;

/** Bounds fail closed. No manifest member is silently dropped or truncated. */
export const MAX_RUN_CONTINUATION_HOT_EVENTS = 65_536;
export const MAX_RUN_CONTINUATION_COLD_PINS = 16_384;
export const MAX_RUN_CONTINUATION_LEASE_KEYS_PER_PIN = 64;
export const MAX_RUN_CONTINUATION_TOTAL_LEASE_KEYS = 65_536;
export const MAX_RUN_CONTINUATION_IDENTIFIER_BYTES = 4_096;
export const MAX_RUN_CONTINUATION_REFERENCE_NAMESPACE_BYTES = 256;
export const MAX_RUN_CONTINUATION_RAW_BYTES = 16 * 1_024 * 1_024;
export const MAX_RUN_CONTINUATION_STORED_BYTES = 16 * 1_024 * 1_024;

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const LINEAGE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const BROTLI_OPTIONS = {
  params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
} as const;

type UnknownRecord = Record<string, unknown>;

export interface RunContinuationBundleChunk {
  hash: string;
  codec: string;
  /** Stored-byte length, matching the run-state chunk convention. */
  rawSize: number;
  data: Buffer | Uint8Array;
}

export interface RunContinuationAuthorityV1 {
  runId: string;
  revision: number;
  stateHash: string;
  rootSchemaVersion: 2 | 3;
  shellHash: string;
  historyLineageId: string;
  historyHeadHash: string | null;
  eventCount: number;
  tailEventId: string | null;
  tailEventContentHash: string | null;
}

/**
 * Content-addressed reference to the private fact root used as the input of an
 * observer materialization step. It only keeps root A reachable for audit and
 * garbage collection. It is not authority, does not participate in CAS, and
 * cannot replace `authority` or any observer sidecar reference.
 */
export interface RunContinuationObserverMaterializationSourceV1 {
  stateHash: string;
  revision: number;
  month: number;
}

export interface RunContinuationColdPinV1 {
  /** Zero-based ordinal in the complete authoritative history ledger. */
  absoluteIndex: number;
  eventId: string;
  leaseKeys: readonly string[];
}

export interface RunContinuationContentHashReferenceV1 {
  kind: 'content-hash';
  /** Codec or other content-addressing namespace used by the referenced bytes. */
  codec: string;
  hash: string;
}

export interface RunContinuationCanonicalDigestReferenceV1 {
  kind: 'canonical-digest';
  /** Domain separator used by the sidecar's canonical digest function. */
  domain: string;
  hash: string;
}

export type RunContinuationSidecarReferenceV1 =
  | RunContinuationContentHashReferenceV1
  | RunContinuationCanonicalDigestReferenceV1;

export interface RunContinuationSidecarsV1 {
  retention: RunContinuationSidecarReferenceV1;
  physical: RunContinuationSidecarReferenceV1;
  derivedObserver: RunContinuationSidecarReferenceV1;
  civilizationObserver: RunContinuationSidecarReferenceV1;
  checkpoint: RunContinuationSidecarReferenceV1;
}

/**
 * This shape never contains a partial `SimulationState` or an events array.
 * `historyMode` makes the bounded coverage explicit, while the exact history
 * root remains in `authority` for a future store-owned CAS wrapper to verify.
 */
export interface RunContinuationBundleV1 {
  schemaVersion: 1;
  historyMode: typeof RUN_CONTINUATION_HISTORY_MODE;
  authority: Readonly<RunContinuationAuthorityV1>;
  hotEventLimit: number;
  hotStartIndex: number;
  coldPins: readonly Readonly<RunContinuationColdPinV1>[];
  sidecars: Readonly<RunContinuationSidecarsV1>;
  observerMaterializationSource?: Readonly<RunContinuationObserverMaterializationSourceV1>;
}

export interface EncodedRunContinuationBundle {
  chunk: Readonly<RunContinuationBundleChunk>;
  bundle: Readonly<RunContinuationBundleV1>;
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

function assertNullableHash(value: unknown, label: string): asserts value is string | null {
  if (value !== null) assertHash(value, label);
}

function assertSafeIntegerAtLeast(value: unknown, minimum: number, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${label} 必须是大于等于 ${minimum} 的安全整数`);
  }
}

function assertBoundedString(
  value: unknown,
  label: string,
  maximumBytes = MAX_RUN_CONTINUATION_IDENTIFIER_BYTES,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} 必须是非空字符串`);
  }
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new Error(`${label} 超过 ${maximumBytes} 字节上限`);
  }
}

function normalizeAuthority(value: unknown): RunContinuationAuthorityV1 {
  assertRecord(value, 'continuation authority');
  assertExactKeys(value, [
    'runId',
    'revision',
    'stateHash',
    'rootSchemaVersion',
    'shellHash',
    'historyLineageId',
    'historyHeadHash',
    'eventCount',
    'tailEventId',
    'tailEventContentHash',
  ], 'continuation authority');

  assertBoundedString(value.runId, 'continuation authority.runId');
  assertSafeIntegerAtLeast(value.revision, 1, 'continuation authority.revision');
  assertHash(value.stateHash, 'continuation authority.stateHash');
  if (value.rootSchemaVersion !== 2 && value.rootSchemaVersion !== 3) {
    throw new Error('continuation authority.rootSchemaVersion 必须是支持 exact history root 的 2 或 3');
  }
  assertHash(value.shellHash, 'continuation authority.shellHash');
  if (typeof value.historyLineageId !== 'string' || !LINEAGE_PATTERN.test(value.historyLineageId)) {
    throw new Error('continuation authority.historyLineageId 必须是小写 UUID');
  }
  assertNullableHash(value.historyHeadHash, 'continuation authority.historyHeadHash');
  assertSafeIntegerAtLeast(value.eventCount, 0, 'continuation authority.eventCount');
  if (value.tailEventId !== null) {
    assertBoundedString(value.tailEventId, 'continuation authority.tailEventId');
  }
  assertNullableHash(value.tailEventContentHash, 'continuation authority.tailEventContentHash');

  const emptyHistory = value.eventCount === 0;
  if (emptyHistory !== (value.historyHeadHash === null)
    || emptyHistory !== (value.tailEventId === null)
    || emptyHistory !== (value.tailEventContentHash === null)) {
    throw new Error('continuation authority 的 eventCount、historyHeadHash 与 tail 边界不一致');
  }

  return {
    runId: value.runId,
    revision: value.revision,
    stateHash: value.stateHash,
    rootSchemaVersion: value.rootSchemaVersion,
    shellHash: value.shellHash,
    historyLineageId: value.historyLineageId,
    historyHeadHash: value.historyHeadHash,
    eventCount: value.eventCount,
    tailEventId: value.tailEventId,
    tailEventContentHash: value.tailEventContentHash,
  };
}

/**
 * Validate and own a reference to observer materialization fact root A.
 * Stores may reuse this helper while keeping their authority checks separate.
 */
export function normalizeRunContinuationObserverMaterializationSource(
  value: unknown,
): RunContinuationObserverMaterializationSourceV1 {
  assertRecord(value, 'continuation observerMaterializationSource');
  assertExactKeys(value, [
    'stateHash',
    'revision',
    'month',
  ], 'continuation observerMaterializationSource');
  assertHash(
    value.stateHash,
    'continuation observerMaterializationSource.stateHash',
  );
  assertSafeIntegerAtLeast(
    value.revision,
    1,
    'continuation observerMaterializationSource.revision',
  );
  assertSafeIntegerAtLeast(
    value.month,
    0,
    'continuation observerMaterializationSource.month',
  );
  return {
    stateHash: value.stateHash,
    revision: value.revision,
    month: value.month,
  };
}

function normalizeSidecarReference(
  value: unknown,
  label: string,
): RunContinuationSidecarReferenceV1 {
  assertRecord(value, label);
  if (value.kind === 'content-hash') {
    assertExactKeys(value, ['kind', 'codec', 'hash'], label);
    assertBoundedString(
      value.codec,
      `${label}.codec`,
      MAX_RUN_CONTINUATION_REFERENCE_NAMESPACE_BYTES,
    );
    assertHash(value.hash, `${label}.hash`);
    return { kind: 'content-hash', codec: value.codec, hash: value.hash };
  }
  if (value.kind === 'canonical-digest') {
    assertExactKeys(value, ['kind', 'domain', 'hash'], label);
    assertBoundedString(
      value.domain,
      `${label}.domain`,
      MAX_RUN_CONTINUATION_REFERENCE_NAMESPACE_BYTES,
    );
    assertHash(value.hash, `${label}.hash`);
    return { kind: 'canonical-digest', domain: value.domain, hash: value.hash };
  }
  throw new Error(`${label}.kind 必须是 content-hash 或 canonical-digest`);
}

function normalizeSidecars(value: unknown): RunContinuationSidecarsV1 {
  assertRecord(value, 'continuation sidecars');
  assertExactKeys(value, [
    'retention',
    'physical',
    'derivedObserver',
    'civilizationObserver',
    'checkpoint',
  ], 'continuation sidecars');
  return {
    retention: normalizeSidecarReference(value.retention, 'continuation sidecars.retention'),
    physical: normalizeSidecarReference(value.physical, 'continuation sidecars.physical'),
    derivedObserver: normalizeSidecarReference(
      value.derivedObserver,
      'continuation sidecars.derivedObserver',
    ),
    civilizationObserver: normalizeSidecarReference(
      value.civilizationObserver,
      'continuation sidecars.civilizationObserver',
    ),
    checkpoint: normalizeSidecarReference(value.checkpoint, 'continuation sidecars.checkpoint'),
  };
}

function normalizeColdPins(
  value: unknown,
  hotStartIndex: number,
): RunContinuationColdPinV1[] {
  if (!Array.isArray(value)) throw new Error('continuation coldPins 必须是数组');
  if (value.length > MAX_RUN_CONTINUATION_COLD_PINS) {
    throw new Error(`continuation coldPins 超过硬上限 ${MAX_RUN_CONTINUATION_COLD_PINS}`);
  }

  const pins: RunContinuationColdPinV1[] = [];
  const absoluteIndexes = new Set<number>();
  let totalLeaseKeys = 0;
  for (let offset = 0; offset < value.length; offset += 1) {
    const candidate = value[offset];
    const label = `continuation coldPins[${offset}]`;
    assertRecord(candidate, label);
    assertExactKeys(candidate, ['absoluteIndex', 'eventId', 'leaseKeys'], label);
    assertSafeIntegerAtLeast(candidate.absoluteIndex, 0, `${label}.absoluteIndex`);
    if (candidate.absoluteIndex >= hotStartIndex) {
      throw new Error(`${label}.absoluteIndex 必须严格位于 cold 区`);
    }
    if (absoluteIndexes.has(candidate.absoluteIndex)) {
      throw new Error(`continuation coldPins 的 absoluteIndex ${candidate.absoluteIndex} 重复`);
    }
    absoluteIndexes.add(candidate.absoluteIndex);
    assertBoundedString(candidate.eventId, `${label}.eventId`);
    if (!Array.isArray(candidate.leaseKeys) || candidate.leaseKeys.length === 0) {
      throw new Error(`${label}.leaseKeys 必须是非空数组`);
    }
    if (candidate.leaseKeys.length > MAX_RUN_CONTINUATION_LEASE_KEYS_PER_PIN) {
      throw new Error(
        `${label}.leaseKeys 超过硬上限 ${MAX_RUN_CONTINUATION_LEASE_KEYS_PER_PIN}`,
      );
    }
    totalLeaseKeys += candidate.leaseKeys.length;
    if (totalLeaseKeys > MAX_RUN_CONTINUATION_TOTAL_LEASE_KEYS) {
      throw new Error(
        `continuation lease key 总数超过硬上限 ${MAX_RUN_CONTINUATION_TOTAL_LEASE_KEYS}`,
      );
    }
    const leaseKeys = candidate.leaseKeys.map((leaseKey, leaseOffset) => {
      assertBoundedString(leaseKey, `${label}.leaseKeys[${leaseOffset}]`);
      return leaseKey;
    }).sort();
    if (leaseKeys.some((leaseKey, leaseOffset) => leaseOffset > 0
      && leaseKey === leaseKeys[leaseOffset - 1])) {
      throw new Error(`${label}.leaseKeys 包含重复项`);
    }
    pins.push({
      absoluteIndex: candidate.absoluteIndex,
      eventId: candidate.eventId,
      leaseKeys,
    });
  }
  pins.sort((left, right) => left.absoluteIndex - right.absoluteIndex);
  return pins;
}

function normalizeBundle(value: unknown): RunContinuationBundleV1 {
  assertRecord(value, 'continuation bundle');
  const hasObserverMaterializationSource = Object.prototype.hasOwnProperty.call(
    value,
    'observerMaterializationSource',
  );
  assertExactKeys(value, [
    'schemaVersion',
    'historyMode',
    'authority',
    'hotEventLimit',
    'hotStartIndex',
    'coldPins',
    'sidecars',
    ...(hasObserverMaterializationSource ? ['observerMaterializationSource'] : []),
  ], 'continuation bundle');
  if (value.schemaVersion !== RUN_CONTINUATION_BUNDLE_SCHEMA_VERSION) {
    throw new Error('continuation bundle schemaVersion 无效');
  }
  if (value.historyMode !== RUN_CONTINUATION_HISTORY_MODE) {
    throw new Error('continuation bundle historyMode 必须显式声明 bounded history');
  }
  const authority = normalizeAuthority(value.authority);
  assertSafeIntegerAtLeast(value.hotEventLimit, 0, 'continuation bundle.hotEventLimit');
  if (value.hotEventLimit > MAX_RUN_CONTINUATION_HOT_EVENTS) {
    throw new Error(
      `continuation bundle.hotEventLimit 超过硬上限 ${MAX_RUN_CONTINUATION_HOT_EVENTS}`,
    );
  }
  assertSafeIntegerAtLeast(value.hotStartIndex, 0, 'continuation bundle.hotStartIndex');
  const expectedHotStartIndex = Math.max(0, authority.eventCount - value.hotEventLimit);
  if (value.hotStartIndex !== expectedHotStartIndex) {
    throw new Error(
      `continuation bundle.hotStartIndex 必须等于 max(0, eventCount - hotEventLimit)=${expectedHotStartIndex}`,
    );
  }
  const bundle: RunContinuationBundleV1 = {
    schemaVersion: RUN_CONTINUATION_BUNDLE_SCHEMA_VERSION,
    historyMode: RUN_CONTINUATION_HISTORY_MODE,
    authority,
    hotEventLimit: value.hotEventLimit,
    hotStartIndex: value.hotStartIndex,
    coldPins: normalizeColdPins(value.coldPins, value.hotStartIndex),
    sidecars: normalizeSidecars(value.sidecars),
  };
  if (hasObserverMaterializationSource) {
    bundle.observerMaterializationSource =
      normalizeRunContinuationObserverMaterializationSource(
        value.observerMaterializationSource,
      );
  }
  return bundle;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value)
    .sort()
    .map((key) => [key, canonicalJsonValue(value[key])]));
}

function canonicalBytes(bundle: RunContinuationBundleV1): Buffer {
  return Buffer.from(JSON.stringify(canonicalJsonValue(bundle)), 'utf8');
}

/** Codec-scoped content address shared by persisted continuation sidecars. */
export function hashRunContinuationStoredContent(codec: string, data: Uint8Array): string {
  return createHash('sha256').update(codec).update('\0').update(data).digest('hex');
}

function ownedChunk(
  hash: string,
  codec: string,
  rawSize: number,
  data: Buffer | Uint8Array,
): Readonly<RunContinuationBundleChunk> {
  if (data.byteLength > MAX_RUN_CONTINUATION_STORED_BYTES) {
    throw new Error(`continuation bundle 存储内容超过硬上限 ${MAX_RUN_CONTINUATION_STORED_BYTES}`);
  }
  const ownedData = Buffer.from(data);
  return Object.freeze({
    hash,
    codec,
    rawSize,
    // Buffers cannot be recursively frozen. Never expose the privately owned
    // bytes directly; callers receive a disposable copy on every read.
    get data(): Buffer { return Buffer.from(ownedData); },
  });
}

function deepFreeze<T>(value: T, visited = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  const object = value as object;
  if (visited.has(object)) return value;
  visited.add(object);
  for (const child of Object.values(object as UnknownRecord)) deepFreeze(child, visited);
  return Object.freeze(value);
}

/**
 * Encode an owned, canonical manifest. Input order is normalized, while
 * duplicate ordinals or lease keys are rejected instead of coalesced.
 */
export function encodeRunContinuationBundle(input: unknown): EncodedRunContinuationBundle {
  const bundle = deepFreeze(normalizeBundle(input));
  const raw = canonicalBytes(bundle);
  if (raw.byteLength > MAX_RUN_CONTINUATION_RAW_BYTES) {
    throw new Error(`continuation bundle 原始内容超过硬上限 ${MAX_RUN_CONTINUATION_RAW_BYTES}`);
  }
  const data = brotliCompressSync(raw, BROTLI_OPTIONS);
  if (data.byteLength > MAX_RUN_CONTINUATION_STORED_BYTES) {
    throw new Error(`continuation bundle 存储内容超过硬上限 ${MAX_RUN_CONTINUATION_STORED_BYTES}`);
  }
  const chunk = ownedChunk(
    hashRunContinuationStoredContent(RUN_CONTINUATION_BUNDLE_CODEC, data),
    RUN_CONTINUATION_BUNDLE_CODEC,
    data.byteLength,
    data,
  );
  return Object.freeze({ chunk, bundle });
}

/**
 * Verify content-addressed bytes, decode only canonical payloads, and return a
 * recursively frozen owned value. This proves integrity, not store authority.
 */
export function decodeRunContinuationBundle(chunk: RunContinuationBundleChunk): Readonly<RunContinuationBundleV1> {
  if (!chunk || typeof chunk !== 'object') throw new Error('continuation bundle chunk 必须是对象');
  // Snapshot scalar claims and bytes once. Accessors or later caller mutation
  // cannot switch the verified content between validation phases.
  const claimedCodec = chunk.codec;
  const claimedHash = chunk.hash;
  const claimedSize = chunk.rawSize;
  const suppliedData = chunk.data;
  if (claimedCodec !== RUN_CONTINUATION_BUNDLE_CODEC) {
    throw new Error(`continuation bundle chunk 使用了不支持的编码 ${claimedCodec}`);
  }
  assertHash(claimedHash, 'continuation bundle chunk.hash');
  assertSafeIntegerAtLeast(claimedSize, 1, 'continuation bundle chunk.rawSize');
  if (!(Buffer.isBuffer(suppliedData) || suppliedData instanceof Uint8Array)) {
    throw new Error('continuation bundle chunk.data 必须是字节数组');
  }
  if (suppliedData.byteLength !== claimedSize) {
    throw new Error('continuation bundle chunk 的长度与记录不一致');
  }
  if (suppliedData.byteLength > MAX_RUN_CONTINUATION_STORED_BYTES) {
    throw new Error(`continuation bundle 存储内容超过硬上限 ${MAX_RUN_CONTINUATION_STORED_BYTES}`);
  }
  const data = Buffer.from(suppliedData);
  if (hashRunContinuationStoredContent(claimedCodec, data) !== claimedHash) {
    throw new Error(`continuation bundle chunk ${claimedHash} 的 SHA-256 校验失败`);
  }

  let raw: Buffer;
  try {
    raw = brotliDecompressSync(data, { maxOutputLength: MAX_RUN_CONTINUATION_RAW_BYTES });
  } catch (error) {
    throw new Error(`continuation bundle chunk ${claimedHash} 无法解压`, { cause: error });
  }
  if (raw.byteLength > MAX_RUN_CONTINUATION_RAW_BYTES) {
    throw new Error(`continuation bundle 原始内容超过硬上限 ${MAX_RUN_CONTINUATION_RAW_BYTES}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`continuation bundle chunk ${claimedHash} 无法解析`, { cause: error });
  }
  const bundle = normalizeBundle(parsed);
  if (!raw.equals(canonicalBytes(bundle))) {
    throw new Error('continuation bundle payload 不是 canonical 编码');
  }
  return deepFreeze(bundle);
}

/** Take an owned byte snapshot before a future authority flow crosses an await. */
export function snapshotRunContinuationBundleChunk(
  chunk: RunContinuationBundleChunk,
): Readonly<RunContinuationBundleChunk> {
  const claimedHash = chunk.hash;
  const claimedCodec = chunk.codec;
  const claimedSize = chunk.rawSize;
  const suppliedData = chunk.data;
  return ownedChunk(claimedHash, claimedCodec, claimedSize, suppliedData);
}
