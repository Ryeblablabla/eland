import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { deserialize, serialize } from 'node:v8';
import {
  brotliCompress,
  brotliDecompressSync,
  constants as zlibConstants,
} from 'node:zlib';

import type {
  SimulationState,
  WorldEvent,
  WorldHistoryCursorV1,
} from '../src/game/eland/simulation';
import {
  createBoundedGameplayShellAccumulator,
  LAST_MATERIALIZED_OBSERVER_BASIS_FIELD,
  type BoundedGameplayShellAuthority,
} from './bounded-gameplay-shell';
import { internEventHistoryAuditStrings } from './event-history-memory';

export const RUN_STATE_ROOT_CODEC = 'eland-run-state-root-v1';
export const RUN_STATE_SHELL_CODEC = 'eland-run-state-shell-v1';
export const RUN_STATE_SHELL_MANIFEST_CODEC = 'eland-run-state-shell-manifest-v1';
export const RUN_STATE_SHELL_PART_CODEC = 'eland-run-state-shell-part-v1';
export const RUN_HISTORY_NODE_CODEC = 'eland-run-history-node-v1';
export const RUN_STATE_EVENT_SEGMENT_CODEC = 'eland-run-state-events-v1';
export const RUN_STATE_CODECS = [
  RUN_STATE_ROOT_CODEC,
  RUN_STATE_SHELL_CODEC,
  RUN_STATE_SHELL_MANIFEST_CODEC,
  RUN_STATE_SHELL_PART_CODEC,
  RUN_HISTORY_NODE_CODEC,
  RUN_STATE_EVENT_SEGMENT_CODEC,
] as const;

const EVENT_CONTENT_DOMAIN = 'eland-run-event-content-v2';
const SHELL_PART_RAW_CONTENT_DOMAIN = 'eland-run-state-shell-part-raw-v1';
const MAX_EVENTS_PER_SEGMENT = 2_048;
/**
 * Successor streaming is intended for adjacent persisted checkpoints. It is
 * deliberately bounded and does not promise to bridge an arbitrarily long
 * checkpoint gap in one call. Limits fail closed; metadata is never truncated.
 */
export const MAX_VERIFIED_RUN_HISTORY_SUCCESSOR_NODES = 4_096;
export const MAX_VERIFIED_RUN_HISTORY_SUCCESSOR_SEGMENT_REFERENCES = 16_384;
/**
 * A positional boundary is deliberately independent of values and evolution
 * outcomes. Append-mostly historical arrays can therefore reuse every full
 * prefix segment while small arrays still have useful member-level reuse.
 */
export const MAX_SHELL_ARRAY_ITEMS_PER_SEGMENT = 64;
export const DEFAULT_SHELL_PART_ENCODE_CACHE_MAX_ENTRIES = 4_096;
export const DEFAULT_SHELL_PART_ENCODE_CACHE_MAX_BYTES = 128 * 1_024 * 1_024;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const LINEAGE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const compress = promisify(brotliCompress);

export interface RunStateChunk {
  hash: string;
  codec: string;
  rawSize: number;
  data: Buffer | Uint8Array;
}

/**
 * Take an owned, synchronous copy before an authority flow crosses an await.
 * The byte buffer is intentionally not shared with the caller, so later
 * mutation of the input chunk cannot switch roots between decode phases.
 */
export function snapshotRunStateChunk(chunk: RunStateChunk): RunStateChunk {
  return Object.freeze({
    hash: chunk.hash,
    codec: chunk.codec,
    rawSize: chunk.rawSize,
    data: Buffer.from(chunk.data),
  });
}

export interface RunStateSegmentReference {
  hash: string;
  eventCount: number;
}

/**
 * `lineageId` is an opaque branch identity. It remains stable during append
 * and changes on explicit replacement; it is deliberately not a content hash.
 * Chunk hashes are the codec-scoped content/integrity hashes.
 */
export interface RunStateRootMetadata {
  schemaVersion: 1 | 2 | 3;
  shellHash: string;
  historyHeadHash: string | null;
  lineageId: string;
  eventCount: number;
  tailEventContentHash: string | null;
}

/**
 * Bounded continuation state for an authoritative append-only history. Unlike
 * `RunStateRootMetadata`, it has no shell dependency and can therefore be kept
 * beside a hot suffix while older event segments remain in the chunk ledger.
 */
export interface RunHistoryCursor {
  lineageId: string;
  historyHeadHash: string | null;
  eventCount: number;
  tailEventContentHash: string | null;
}

export interface RunHistoryNodeMetadata {
  schemaVersion: 1;
  lineageId: string;
  parentHash: string | null;
  startEventIndex: number;
  eventCount: number;
  totalEventCount: number;
  segments: RunStateSegmentReference[];
}

export interface RunStateShellPartReference {
  hash: string;
  itemCount: number;
}

export type RunStateShellFieldReference =
  | {
    name: string;
    kind: 'value';
    hash: string;
  }
  | {
    name: string;
    kind: 'array';
    length: number;
    segments: RunStateShellPartReference[];
  };

/**
 * Field order is authoritative. It preserves the original object insertion
 * order; array segment order preserves each SimulationState collection exactly.
 */
export interface RunStateShellManifestMetadata {
  schemaVersion: 1;
  fields: RunStateShellFieldReference[];
  worldFields: RunStateShellFieldReference[];
}

export type RunStateShellFieldScope = 'state' | 'world';

interface VerifiedRunStateShellFieldPositionBase {
  /** `state` fields are visited first, followed by `world`, in manifest order. */
  scope: RunStateShellFieldScope;
  fieldName: string;
  /** Zero-based within its own manifest field group. */
  fieldIndex: number;
  /** Zero-based across state fields followed by world fields. */
  absoluteFieldIndex: number;
}

export interface VerifiedRunStateShellValuePosition
  extends VerifiedRunStateShellFieldPositionBase {
  kind: 'value';
  chunkHash: string;
}

export interface VerifiedRunStateShellArraySegmentPosition
  extends VerifiedRunStateShellFieldPositionBase {
  kind: 'array-segment';
  fieldLength: number;
  segmentIndex: number;
  segmentCount: number;
  startItemIndex: number;
  itemCount: number;
  chunkHash: string;
}

export type VerifiedRunStateShellFieldPosition =
  | (VerifiedRunStateShellFieldPositionBase & {
    kind: 'value';
    chunkHash: string;
  })
  | (VerifiedRunStateShellFieldPositionBase & {
    kind: 'array';
    fieldLength: number;
    segmentCount: number;
  });

export interface VerifiedSchema3RunStateShellVisitor {
  /** Manifest-order field boundary, including empty array fields. */
  visitField?: (
    position: Readonly<VerifiedRunStateShellFieldPosition>,
  ) => void | Promise<void>;
  /**
   * The value chunk is hash/codec verified and decoded before this callback,
   * but staged consumer output is not authoritative until the final receipt.
   */
  visitValue?: (
    value: unknown,
    position: Readonly<VerifiedRunStateShellValuePosition>,
  ) => void | Promise<void>;
  /**
   * At most `MAX_SHELL_ARRAY_ITEMS_PER_SEGMENT` decoded items are exposed per
   * callback. The array is a private decoded segment, never a whole field.
   */
  visitArraySegment?: (
    items: readonly unknown[],
    position: Readonly<VerifiedRunStateShellArraySegmentPosition>,
  ) => void | Promise<void>;
}

declare const verifiedSchema3RunStateShellReceiptBrand: unique symbol;

export interface VerifiedSchema3RunStateShellReceipt {
  readonly kind: 'verified-schema3-run-state-shell-receipt-v1';
  readonly rootHash: string;
  readonly manifestHash: string;
  readonly stateFieldCount: number;
  readonly worldFieldCount: number;
  readonly valueFieldCount: number;
  readonly arrayFieldCount: number;
  readonly arraySegmentCount: number;
  readonly arrayItemCount: number;
  /** Non-zero only for the closed gameplay stream that carries observer blobs opaquely. */
  readonly opaqueObserverValueFieldCount: number;
  readonly [verifiedSchema3RunStateShellReceiptBrand]: true;
}

export interface EncodedRunState {
  root: RunStateChunk;
  parts: RunStateChunk[];
  metadata: RunStateRootMetadata;
  /** Present only when the caller supplied a run-scoped shell reuse authority. */
  shellReuseIdentity?: Readonly<VerifiedRunStateShellReuseIdentity>;
}

export interface EncodedRunHistorySuffix {
  cursor: RunHistoryCursor;
  parts: RunStateChunk[];
}

export interface RunStateEncodeOptions {
  /** Synthetic-test seam; authoritative persistence always uses 2,048. */
  maxEventsPerSegmentForTests?: number;
  /**
   * Process-local authority for exact previous-root shell segment reuse.
   * The opaque authority must be unique to one run and retained by its store.
   */
  shellReuse?: RunStateShellReuseOptions;
}

declare const verifiedRunStateShellReuseIdentityBrand: unique symbol;

/**
 * Opaque receipt minted by this codec after one complete schema-3 encode.
 * Its scalar fields are diagnostic only; the reusable segment bindings live
 * in a module-private WeakMap and cannot be forged from this public shape.
 */
export interface VerifiedRunStateShellReuseIdentity {
  readonly kind: 'verified-run-state-shell-reuse-identity-v1';
  readonly rootHash: string;
  readonly manifestHash: string;
  readonly reusableCompletedProjectSegments: number;
  readonly [verifiedRunStateShellReuseIdentityBrand]: true;
}

export interface RunStateShellReuseOptions {
  /** Store-owned object unique to one run/process lifetime. */
  authority: object;
  /** Both previous fields are required together; omission starts a cold identity. */
  previousRoot?: RunStateChunk;
  previousIdentity?: Readonly<VerifiedRunStateShellReuseIdentity>;
}

export interface RunHistorySegmentPosition {
  nodeHash: string;
  segmentHash: string;
  startEventIndex: number;
}

export interface VerifiedRunHistorySuccessor {
  previousRootHash: string;
  nextRootHash: string;
  previous: Readonly<RunHistoryCursor>;
  next: Readonly<RunHistoryCursor>;
  suffixEventCount: number;
}

export interface DecodedRunState {
  state: SimulationState;
  metadata: RunStateRootMetadata;
}

export interface RunStatePinnedEvent {
  /** Zero-based ordinal in the complete authoritative event ledger. */
  absoluteIndex: number;
  event: WorldEvent;
}

export interface RunStateBoundedDecodeOptions {
  /** Number of contiguous authoritative tail events retained in `world.past`. */
  hotEventLimit: number;
  /** Additional cold facts selected by absolute ordinal, never by event id. */
  pinnedEventIndexes?: readonly number[];
}

export interface RunStateGameplayBoundedDecodeOptions
  extends RunStateBoundedDecodeOptions {
  /** Store-selected exact run row plus its last materialized milestone count. */
  observerAuthority: Readonly<BoundedGameplayShellAuthority>;
}

export interface DecodedBoundedRunState extends DecodedRunState {
  /** Cold pinned facts only; requested ordinals inside the hot tail are omitted. */
  pinnedEvents: RunStatePinnedEvent[];
}

export interface DecodedBoundedGameplayRunState extends DecodedBoundedRunState {
  readonly gameplayShell: {
    readonly sourceArrayLengths: Readonly<Record<string, number>>;
    readonly retainedArrayLengths: Readonly<Record<string, number>>;
  };
}

export interface RunStateDecodeOptions {
  /** Benchmark escape hatch; authoritative restore always uses the default. */
  canonicalizeEventIdReferences?: boolean;
  /** Synthetic-test observation only; authoritative callers never set it. */
  onBeforeShellDecodeForTests?: (temporaryPools: {
    releasedAuditStringCount: number;
    auditStringCount: number;
    canonicalEventIdCount: number;
    compactCanonicalEventIdCount: number;
  }) => void;
  /** Synthetic-test observation only; authoritative callers never set it. */
  onAfterShellValidationForTests?: (temporaryPools: {
    compactCanonicalEventIdCount: number;
  }) => void;
}

export interface RunStateShellPartEncodeCacheControl {
  enabled?: boolean;
  maxEntries?: number;
  maxBytes?: number;
  clear?: boolean;
  resetStatistics?: boolean;
}

export interface RunStateShellPartEncodeCacheStats {
  enabled: boolean;
  maxEntries: number;
  maxBytes: number;
  entries: number;
  bytes: number;
  peakEntries: number;
  peakBytes: number;
  requests: number;
  hits: number;
  misses: number;
  brotliCalls: number;
  evictions: number;
  skippedOversize: number;
  shellEncodes: number;
  totalShellEncodeMilliseconds: number;
  lastShellEncodeMilliseconds: number;
  serializeCalls: number;
  serializedRawBytes: number;
  compressedOutputBytes: number;
  identityReuseEnabled: boolean;
  identityReuseChecks: number;
  identityReuseHits: number;
  identityReuseMisses: number;
  stabilizedCompletedProjects: number;
  capturedReusableCompletedProjectSegments: number;
}

export interface RunStateShellSegmentIdentityReuseControl {
  enabled?: boolean;
  resetStatistics?: boolean;
}

export interface RunStateReachabilityMemo {
  chunks: Set<string>;
  historyNodes: Set<string>;
  /** Optional for callers compiled against v14; initialized lazily by v15. */
  shellManifests?: Set<string>;
  /** Avoid re-reading/re-hashing one reused part through every retained manifest. */
  shellParts?: Set<string>;
}

export type RunStateWritePlan =
  | { mode: 'replace' }
  | { mode: 'append'; previous: RunStateRootMetadata };

type SimulationStateShell = Omit<SimulationState, 'world'> & {
  world: Omit<SimulationState['world'], 'past'>;
};

interface CanonicalEventIdLookup {
  readonly size: number;
  get(eventId: string): string | undefined;
}

class CompactCanonicalEventIdLookup implements CanonicalEventIdLookup {
  readonly values: string[];

  constructor(values: string[]) {
    this.values = values;
  }

  get size(): number {
    return this.values.length;
  }

  get(eventId: string): string | undefined {
    let lower = 0;
    let upper = this.values.length - 1;
    while (lower <= upper) {
      const middle = lower + Math.floor((upper - lower) / 2);
      const canonical = this.values[middle];
      if (canonical === eventId) return canonical;
      if (canonical < eventId) lower = middle + 1;
      else upper = middle - 1;
    }
    return undefined;
  }

  clear(): void {
    this.values.length = 0;
  }
}

interface ShellPartEncodeCacheEntry {
  chunk: RunStateChunk;
  bytes: number;
}

interface ReusableCompletedProjectSegmentBinding {
  readonly scope: 'state';
  readonly fieldName: 'projects';
  readonly segmentIndex: number;
  readonly itemCount: 1;
  readonly project: object;
  readonly chunk: RunStateChunk;
}

interface VerifiedRunStateShellReuseIdentityRecord {
  readonly authority: object;
  readonly rootHash: string;
  readonly manifestHash: string;
  readonly completedProjectSegments: ReadonlyMap<number, ReusableCompletedProjectSegmentBinding>;
}

interface PreparedRunStateShellReuse {
  readonly authority: object;
  readonly previous?: VerifiedRunStateShellReuseIdentityRecord;
}

interface EncodedShellFieldGroup {
  chunks: RunStateChunk[];
  references: RunStateShellFieldReference[];
  reusableCompletedProjectSegments: Map<number, ReusableCompletedProjectSegmentBinding>;
}

const shellPartEncodeCache = new Map<string, ShellPartEncodeCacheEntry>();
const verifiedSchema3RunStateShellReceipts = new WeakSet<object>();
const verifiedRunStateShellReuseIdentities = new WeakMap<
object,
VerifiedRunStateShellReuseIdentityRecord
>();
const stabilizedCompletedProjects = new WeakSet<object>();
let shellPartEncodeCacheEnabled = true;
let shellSegmentIdentityReuseEnabled = true;
let shellPartEncodeCacheMaxEntries = DEFAULT_SHELL_PART_ENCODE_CACHE_MAX_ENTRIES;
let shellPartEncodeCacheMaxBytes = DEFAULT_SHELL_PART_ENCODE_CACHE_MAX_BYTES;
let shellPartEncodeCacheBytes = 0;
let shellPartEncodeCachePeakEntries = 0;
let shellPartEncodeCachePeakBytes = 0;
let shellPartEncodeCacheRequests = 0;
let shellPartEncodeCacheHits = 0;
let shellPartEncodeCacheMisses = 0;
let shellPartEncodeBrotliCalls = 0;
let shellPartEncodeCacheEvictions = 0;
let shellPartEncodeCacheSkippedOversize = 0;
let shellPartEncodes = 0;
let shellPartTotalEncodeMilliseconds = 0;
let shellPartLastEncodeMilliseconds = 0;
let shellPartSerializeCalls = 0;
let shellPartSerializedRawBytes = 0;
let shellPartCompressedOutputBytes = 0;
let shellSegmentIdentityReuseChecks = 0;
let shellSegmentIdentityReuseHits = 0;
let shellSegmentIdentityReuseMisses = 0;
let shellSegmentStabilizedCompletedProjects = 0;
let shellSegmentCapturedReusableCompletedProjectSegments = 0;

function asBuffer(data: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(data)
    ? data
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function hashStoredChunk(codec: string, data: Uint8Array): string {
  return createHash('sha256').update(codec).update('\0').update(data).digest('hex');
}

function hashRawV8Chunk(codec: string, raw: Uint8Array): string {
  return createHash('sha256')
    .update(SHELL_PART_RAW_CONTENT_DOMAIN)
    .update('\0')
    .update(codec)
    .update('\0')
    .update(raw)
    .digest('hex');
}

function storedChunk(codec: string, data: Buffer): RunStateChunk {
  return {
    hash: hashStoredChunk(codec, data),
    codec,
    rawSize: data.byteLength,
    data,
  };
}

function resetShellPartEncodeCacheStatistics(): void {
  shellPartEncodeCachePeakEntries = shellPartEncodeCache.size;
  shellPartEncodeCachePeakBytes = shellPartEncodeCacheBytes;
  shellPartEncodeCacheRequests = 0;
  shellPartEncodeCacheHits = 0;
  shellPartEncodeCacheMisses = 0;
  shellPartEncodeBrotliCalls = 0;
  shellPartEncodeCacheEvictions = 0;
  shellPartEncodeCacheSkippedOversize = 0;
  shellPartEncodes = 0;
  shellPartTotalEncodeMilliseconds = 0;
  shellPartLastEncodeMilliseconds = 0;
  shellPartSerializeCalls = 0;
  shellPartSerializedRawBytes = 0;
  shellPartCompressedOutputBytes = 0;
  shellSegmentIdentityReuseChecks = 0;
  shellSegmentIdentityReuseHits = 0;
  shellSegmentIdentityReuseMisses = 0;
  shellSegmentStabilizedCompletedProjects = 0;
  shellSegmentCapturedReusableCompletedProjectSegments = 0;
}

function evictShellPartEncodeCacheToBounds(): void {
  while (shellPartEncodeCache.size > shellPartEncodeCacheMaxEntries
    || shellPartEncodeCacheBytes > shellPartEncodeCacheMaxBytes) {
    const oldestKey = shellPartEncodeCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) return;
    const entry = shellPartEncodeCache.get(oldestKey);
    shellPartEncodeCache.delete(oldestKey);
    if (entry) shellPartEncodeCacheBytes -= entry.bytes;
    shellPartEncodeCacheEvictions += 1;
  }
}

/**
 * Test/benchmark control only. Runtime persistence uses the bounded defaults;
 * neither configuration nor statistics are serialized into authoritative state.
 */
export function configureRunStateShellPartEncodeCacheForTests(
  control: RunStateShellPartEncodeCacheControl = {},
): void {
  if (control.maxEntries !== undefined) {
    if (!Number.isSafeInteger(control.maxEntries) || control.maxEntries < 1) {
      throw new Error('shell-part encode cache maxEntries 必须是正整数');
    }
    shellPartEncodeCacheMaxEntries = control.maxEntries;
  }
  if (control.maxBytes !== undefined) {
    if (!Number.isSafeInteger(control.maxBytes) || control.maxBytes < 1) {
      throw new Error('shell-part encode cache maxBytes 必须是正整数');
    }
    shellPartEncodeCacheMaxBytes = control.maxBytes;
  }
  if (control.enabled !== undefined) shellPartEncodeCacheEnabled = control.enabled;
  if (control.clear) {
    shellPartEncodeCache.clear();
    shellPartEncodeCacheBytes = 0;
  } else {
    evictShellPartEncodeCacheToBounds();
  }
  if (control.resetStatistics) resetShellPartEncodeCacheStatistics();
}

/** Synthetic-test control; production keeps exact-root identity reuse enabled. */
export function configureRunStateShellSegmentIdentityReuseForTests(
  control: RunStateShellSegmentIdentityReuseControl = {},
): void {
  if (control.enabled !== undefined) shellSegmentIdentityReuseEnabled = control.enabled;
  if (control.resetStatistics) resetShellPartEncodeCacheStatistics();
}

export function runStateShellPartEncodeCacheStatsForTests(): RunStateShellPartEncodeCacheStats {
  return {
    enabled: shellPartEncodeCacheEnabled,
    maxEntries: shellPartEncodeCacheMaxEntries,
    maxBytes: shellPartEncodeCacheMaxBytes,
    entries: shellPartEncodeCache.size,
    bytes: shellPartEncodeCacheBytes,
    peakEntries: shellPartEncodeCachePeakEntries,
    peakBytes: shellPartEncodeCachePeakBytes,
    requests: shellPartEncodeCacheRequests,
    hits: shellPartEncodeCacheHits,
    misses: shellPartEncodeCacheMisses,
    brotliCalls: shellPartEncodeBrotliCalls,
    evictions: shellPartEncodeCacheEvictions,
    skippedOversize: shellPartEncodeCacheSkippedOversize,
    shellEncodes: shellPartEncodes,
    totalShellEncodeMilliseconds: shellPartTotalEncodeMilliseconds,
    lastShellEncodeMilliseconds: shellPartLastEncodeMilliseconds,
    serializeCalls: shellPartSerializeCalls,
    serializedRawBytes: shellPartSerializedRawBytes,
    compressedOutputBytes: shellPartCompressedOutputBytes,
    identityReuseEnabled: shellSegmentIdentityReuseEnabled,
    identityReuseChecks: shellSegmentIdentityReuseChecks,
    identityReuseHits: shellSegmentIdentityReuseHits,
    identityReuseMisses: shellSegmentIdentityReuseMisses,
    stabilizedCompletedProjects: shellSegmentStabilizedCompletedProjects,
    capturedReusableCompletedProjectSegments:
      shellSegmentCapturedReusableCompletedProjectSegments,
  };
}

/** Verify cache-domain separation without exposing or retaining raw buffers. */
export function runStateRawV8CacheKeyForTests(codec: string, value: unknown): string {
  return hashRawV8Chunk(codec, serialize(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>)
    .sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => [key, canonicalJsonValue((value as Record<string, unknown>)[key])]));
}

function eventContentHash(event: WorldEvent): string {
  // V8 serialization is a storage codec, not a process-stable canonical form:
  // internalized and freshly allocated strings can produce different bytes in
  // the evolution worker and the long-lived API process. World events are
  // JSON-shaped facts, so sorted-key JSON gives the append boundary a stable
  // semantic hash without depending on one Node process's string internals.
  const canonical = JSON.stringify(canonicalJsonValue(event));
  return createHash('sha256')
    .update(EVENT_CONTENT_DOMAIN)
    .update('\0')
    .update(canonical)
    .digest('hex');
}

/** Persistence boundary check shared by full-array and bounded suffix writers. */
export function assertRunHistoryBoundaryEventContent(
  event: WorldEvent,
  expectedContentHash: string | null,
): void {
  if (expectedContentHash === null || eventContentHash(event) !== expectedContentHash) {
    throw new Error('运行历史的既有边界已改写；历史改写必须使用 replace 模式');
  }
}

function tailEventContentHash(events: readonly WorldEvent[]): string | null {
  const event = events.at(-1);
  return event ? eventContentHash(event) : null;
}

/** Freeze one codec-owned JSON-shaped value before sharing it with a visitor. */
function deepFreezeOwnedValue<T>(value: T, visited = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  const owned = value as object;
  if (visited.has(owned)) return value;
  visited.add(owned);
  for (const child of Object.values(owned as Record<string, unknown>)) {
    deepFreezeOwnedValue(child, visited);
  }
  Object.freeze(owned);
  return value;
}

function assertDomainHistoryCursorMatchesLedger(
  cursor: WorldHistoryCursorV1,
  expectedEventCount: number,
  expectedTailEventId: string | null,
  hotEventCount: number,
  label: string,
): void {
  if (cursor.version !== 1
    || !Number.isSafeInteger(cursor.eventCount)
    || !Number.isSafeInteger(cursor.hotStartIndex)
    || cursor.eventCount !== expectedEventCount
    || cursor.hotStartIndex < 0
    || cursor.hotStartIndex > cursor.eventCount
    || cursor.eventCount - cursor.hotStartIndex !== hotEventCount
    || cursor.tailEventId !== expectedTailEventId) {
    throw new Error(`${label} history cursor 与权威历史根不一致`);
  }
}

function assertFullDomainHistoryCursor(state: SimulationState): void {
  const cursor = state.world.historyCursor;
  if (!cursor) return;
  assertDomainHistoryCursorMatchesLedger(
    cursor,
    state.world.past.length,
    state.world.past.at(-1)?.id ?? null,
    state.world.past.length,
    '完整数组编码',
  );
}

function completedProjectIsClosedArchive(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const project = value as Record<string, unknown>;
  if (project.status !== 'completed'
    || Object.prototype.hasOwnProperty.call(project, 'activeLogisticsEpisodeId')) return false;
  const hasActive = (items: unknown): boolean => Array.isArray(items)
    && items.some((item) => item
      && typeof item === 'object'
      && !Array.isArray(item)
      && (item as Record<string, unknown>).status === 'active');
  if (hasActive(project.logisticsEpisodes) || hasActive(project.searchCampaigns)) return false;
  const hypothesis = project.hypothesisCampaign;
  return !hypothesis
    || typeof hypothesis !== 'object'
    || Array.isArray(hypothesis)
    || (hypothesis as Record<string, unknown>).status !== 'active';
}

function recursivelyPlainOwnedValue(
  value: unknown,
  visited = new WeakSet<object>(),
): boolean {
  if (value === null
    || value === undefined
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'bigint') return true;
  if (typeof value !== 'object' || visited.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype
    && prototype !== Array.prototype
    && prototype !== null) return false;
  visited.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false;
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) return false;
    if (!recursivelyPlainOwnedValue(descriptor.value, visited)) return false;
  }
  return true;
}

function recursivelyFreezeOwnedValue(
  value: unknown,
  visited = new WeakSet<object>(),
): void {
  if (!value || typeof value !== 'object' || visited.has(value)) return;
  visited.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    recursivelyFreezeOwnedValue(child, visited);
  }
  Object.freeze(value);
}

/**
 * Canonicalize only closed completed-project archives after a rule month has
 * finished. Replacing the whole array invalidates every array-keyed domain
 * index; the isolated clone prevents recursive freeze from touching any shared
 * mutable value elsewhere in the state graph.
 */
export function stabilizeCompletedProjectsForRunStateShellReuse(
  state: SimulationState,
): number {
  let stabilized = 0;
  const projects = state.projects.map((project) => {
    if (!completedProjectIsClosedArchive(project)
      || stabilizedCompletedProjects.has(project)) return project;
    const owned = structuredClone(project) as typeof project;
    if (!recursivelyPlainOwnedValue(owned)) return project;
    recursivelyFreezeOwnedValue(owned);
    stabilizedCompletedProjects.add(owned);
    stabilized += 1;
    return owned;
  });
  if (stabilized > 0) state.projects = projects;
  shellSegmentStabilizedCompletedProjects += stabilized;
  return stabilized;
}

function stateShell(state: SimulationState): SimulationStateShell {
  const { past: _past, ...world } = state.world;
  return { ...state, world };
}

function stateShellFieldGroups(state: SimulationState): {
  fields: Record<string, unknown>;
  worldFields: Record<string, unknown>;
} {
  const shell = stateShell(state);
  const { world, ...fields } = shell;
  return { fields, worldFields: world };
}

async function compressedV8Chunk(codec: string, value: unknown): Promise<RunStateChunk> {
  const raw = serialize(value);
  const data = await compress(raw, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
  });
  return storedChunk(codec, data);
}

async function compressedShellPartV8Chunk(value: unknown): Promise<RunStateChunk> {
  shellPartSerializeCalls += 1;
  const raw = serialize(value);
  shellPartSerializedRawBytes += raw.byteLength;
  shellPartEncodeCacheRequests += 1;
  const cacheKey = shellPartEncodeCacheEnabled
    ? hashRawV8Chunk(RUN_STATE_SHELL_PART_CODEC, raw)
    : null;
  if (shellPartEncodeCacheEnabled) {
    const cached = shellPartEncodeCache.get(cacheKey!);
    if (cached) {
      shellPartEncodeCache.delete(cacheKey!);
      shellPartEncodeCache.set(cacheKey!, cached);
      shellPartEncodeCacheHits += 1;
      return cached.chunk;
    }
  }

  shellPartEncodeCacheMisses += 1;
  shellPartEncodeBrotliCalls += 1;
  const data = await compress(raw, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
  });
  shellPartCompressedOutputBytes += data.byteLength;
  const chunk = storedChunk(RUN_STATE_SHELL_PART_CODEC, data);
  if (!shellPartEncodeCacheEnabled || cacheKey === null) return chunk;
  if (data.byteLength > shellPartEncodeCacheMaxBytes) {
    shellPartEncodeCacheSkippedOversize += 1;
    return chunk;
  }

  // Concurrent encodes may have populated the same content while Brotli was
  // pending. Keep accounting bounded and return the already canonical chunk.
  const concurrentlyCached = shellPartEncodeCache.get(cacheKey);
  if (concurrentlyCached) {
    shellPartEncodeCache.delete(cacheKey);
    shellPartEncodeCache.set(cacheKey, concurrentlyCached);
    return concurrentlyCached.chunk;
  }
  shellPartEncodeCache.set(cacheKey, { chunk, bytes: data.byteLength });
  shellPartEncodeCacheBytes += data.byteLength;
  evictShellPartEncodeCacheToBounds();
  shellPartEncodeCachePeakEntries = Math.max(
    shellPartEncodeCachePeakEntries,
    shellPartEncodeCache.size,
  );
  shellPartEncodeCachePeakBytes = Math.max(
    shellPartEncodeCachePeakBytes,
    shellPartEncodeCacheBytes,
  );
  return chunk;
}

function shellArrayItemsPerSegment(
  scope: RunStateShellFieldScope,
  fieldName: string,
): number {
  // A completed project may carry substantially more closed planning history
  // than other shell members. Keeping projects content-addressed one at a time
  // prevents one changed/live project from forcing a 64-project decode peak,
  // while every other collection retains the established positional layout.
  return scope === 'state' && fieldName === 'projects'
    ? 1
    : MAX_SHELL_ARRAY_ITEMS_PER_SEGMENT;
}

function preparedRunStateShellReuse(
  options: RunStateEncodeOptions,
): PreparedRunStateShellReuse | undefined {
  const reuse = options.shellReuse;
  if (!reuse) return undefined;
  if ((!reuse.authority || typeof reuse.authority !== 'object')
    && typeof reuse.authority !== 'function') {
    throw new Error('shell segment reuse authority 必须是对象');
  }
  const hasPreviousRoot = reuse.previousRoot !== undefined;
  const hasPreviousIdentity = reuse.previousIdentity !== undefined;
  if (hasPreviousRoot !== hasPreviousIdentity) {
    throw new Error('shell segment reuse previous root/identity 必须成对提供');
  }
  if (!reuse.previousRoot || !reuse.previousIdentity) {
    return { authority: reuse.authority };
  }
  const previousRootChunk = snapshotRunStateChunk(reuse.previousRoot);
  const previousRoot = parseRunStateRoot(previousRootChunk);
  if (previousRoot.schemaVersion !== 3) {
    throw new Error('shell segment reuse previous root 必须是 schemaVersion 3');
  }
  const identity = verifiedRunStateShellReuseIdentities.get(reuse.previousIdentity);
  if (!identity
    || identity.authority !== reuse.authority
    || identity.rootHash !== previousRootChunk.hash
    || identity.manifestHash !== previousRoot.shellHash
    || reuse.previousIdentity.rootHash !== identity.rootHash
    || reuse.previousIdentity.manifestHash !== identity.manifestHash
    || reuse.previousIdentity.reusableCompletedProjectSegments
      !== identity.completedProjectSegments.size) {
    throw new Error('shell segment reuse identity 未绑定当前 run/exact previous root/manifest');
  }
  return { authority: reuse.authority, previous: identity };
}

function reusableCompletedProjectSegment(
  scope: RunStateShellFieldScope,
  fieldName: string,
  segmentIndex: number,
  segment: readonly unknown[],
  reuse: PreparedRunStateShellReuse | undefined,
): ReusableCompletedProjectSegmentBinding | undefined {
  if (scope !== 'state'
    || fieldName !== 'projects'
    || segment.length !== 1
    || !completedProjectIsClosedArchive(segment[0])
    || !stabilizedCompletedProjects.has(segment[0])) return undefined;
  const previous = reuse?.previous?.completedProjectSegments.get(segmentIndex);
  if (!reuse?.previous) return undefined;
  shellSegmentIdentityReuseChecks += 1;
  if (shellSegmentIdentityReuseEnabled
    && previous
    && previous.scope === scope
    && previous.fieldName === fieldName
    && previous.segmentIndex === segmentIndex
    && previous.itemCount === segment.length
    && previous.project === segment[0]) {
    shellSegmentIdentityReuseHits += 1;
    return previous;
  }
  shellSegmentIdentityReuseMisses += 1;
  return undefined;
}

function capturedCompletedProjectSegment(
  scope: RunStateShellFieldScope,
  fieldName: string,
  segmentIndex: number,
  segment: readonly unknown[],
  chunk: RunStateChunk,
): ReusableCompletedProjectSegmentBinding | undefined {
  if (scope !== 'state'
    || fieldName !== 'projects'
    || segment.length !== 1
    || !completedProjectIsClosedArchive(segment[0])
    || !stabilizedCompletedProjects.has(segment[0])) return undefined;
  return Object.freeze({
    scope: 'state' as const,
    fieldName: 'projects' as const,
    segmentIndex,
    itemCount: 1 as const,
    project: segment[0],
    chunk,
  });
}

async function encodeShellFieldReferences(
  fields: Record<string, unknown>,
  scope: RunStateShellFieldScope,
  reuse?: PreparedRunStateShellReuse,
): Promise<EncodedShellFieldGroup> {
  const chunks: RunStateChunk[] = [];
  const references: RunStateShellFieldReference[] = [];
  const reusableCompletedProjectSegments = new Map<
    number,
    ReusableCompletedProjectSegmentBinding
  >();
  for (const [name, value] of Object.entries(fields)) {
    if (!Array.isArray(value)) {
      const chunk = await compressedShellPartV8Chunk(value);
      chunks.push(chunk);
      references.push({ name, kind: 'value', hash: chunk.hash });
      continue;
    }

    const segments: RunStateShellPartReference[] = [];
    const segmentSize = shellArrayItemsPerSegment(scope, name);
    for (let offset = 0; offset < value.length; offset += segmentSize) {
      const segment = value.slice(offset, offset + segmentSize);
      const segmentIndex = segments.length;
      const reused = reusableCompletedProjectSegment(
        scope,
        name,
        segmentIndex,
        segment,
        reuse,
      );
      const chunk = reused?.chunk ?? await compressedShellPartV8Chunk(segment);
      if (!reused) chunks.push(chunk);
      segments.push({ hash: chunk.hash, itemCount: segment.length });
      const captured = reused ?? capturedCompletedProjectSegment(
        scope,
        name,
        segmentIndex,
        segment,
        chunk,
      );
      if (captured) reusableCompletedProjectSegments.set(segmentIndex, captured);
    }
    references.push({ name, kind: 'array', length: value.length, segments });
  }
  return { chunks, references, reusableCompletedProjectSegments };
}

async function encodeSegmentedShell(
  state: SimulationState,
  reuse?: PreparedRunStateShellReuse,
): Promise<{
  manifest: RunStateChunk;
  parts: RunStateChunk[];
  reusableCompletedProjectSegments: Map<number, ReusableCompletedProjectSegmentBinding>;
}> {
  const startedAt = performance.now();
  const groups = stateShellFieldGroups(state);
  const fields = await encodeShellFieldReferences(groups.fields, 'state', reuse);
  const worldFields = await encodeShellFieldReferences(groups.worldFields, 'world', reuse);
  const metadata: RunStateShellManifestMetadata = {
    schemaVersion: 1,
    fields: fields.references,
    worldFields: worldFields.references,
  };
  const encoded = {
    manifest: storedChunk(RUN_STATE_SHELL_MANIFEST_CODEC, serialize(metadata)),
    parts: [...fields.chunks, ...worldFields.chunks],
    reusableCompletedProjectSegments: fields.reusableCompletedProjectSegments,
  };
  shellPartLastEncodeMilliseconds = performance.now() - startedAt;
  shellPartTotalEncodeMilliseconds += shellPartLastEncodeMilliseconds;
  shellPartEncodes += 1;
  return encoded;
}

function maxEventsPerSegment(options: RunStateEncodeOptions): number {
  const requested = options.maxEventsPerSegmentForTests;
  if (requested === undefined) return MAX_EVENTS_PER_SEGMENT;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new Error('测试事件分段大小必须是正整数');
  }
  return requested;
}

async function encodeEventSegments(
  events: readonly WorldEvent[],
  options: RunStateEncodeOptions = {},
): Promise<{
  chunks: RunStateChunk[];
  references: RunStateSegmentReference[];
}> {
  const chunks: RunStateChunk[] = [];
  const references: RunStateSegmentReference[] = [];
  const segmentSize = maxEventsPerSegment(options);
  for (let offset = 0; offset < events.length; offset += segmentSize) {
    const segment = events.slice(offset, offset + segmentSize);
    const chunk = await compressedV8Chunk(RUN_STATE_EVENT_SEGMENT_CODEC, segment);
    chunks.push(chunk);
    references.push({ hash: chunk.hash, eventCount: segment.length });
  }
  return { chunks, references };
}

function parsedV8Object(data: Buffer, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = deserialize(data);
  } catch (error) {
    throw new Error(`${label} 无法反序列化`, { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 内容无效`);
  }
  return value as Record<string, unknown>;
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

function validOptionalHash(value: unknown): value is string | null {
  return value === null || validHash(value);
}

function validLineage(value: unknown): value is string {
  return typeof value === 'string' && LINEAGE_PATTERN.test(value);
}

function assertValidRunHistoryCursor(cursor: RunHistoryCursor): void {
  if (!validLineage(cursor.lineageId)
    || !validOptionalHash(cursor.historyHeadHash)
    || !Number.isSafeInteger(cursor.eventCount)
    || cursor.eventCount < 0
    || !validOptionalHash(cursor.tailEventContentHash)
    || (cursor.eventCount === 0) !== (cursor.historyHeadHash === null)
    || (cursor.eventCount === 0) !== (cursor.tailEventContentHash === null)) {
    throw new Error('运行历史 cursor 内容无效');
  }
}

/** Derive the shell-independent continuation cursor from a schema 2/3 root. */
export function runHistoryCursorFromRootMetadata(
  root: RunStateRootMetadata,
): RunHistoryCursor {
  if (root.schemaVersion !== 2 && root.schemaVersion !== 3) {
    throw new Error('旧版运行状态根必须先升级，不能派生运行历史 cursor');
  }
  const cursor: RunHistoryCursor = {
    lineageId: root.lineageId,
    historyHeadHash: root.historyHeadHash,
    eventCount: root.eventCount,
    tailEventContentHash: root.tailEventContentHash,
  };
  assertValidRunHistoryCursor(cursor);
  return cursor;
}

function validSegmentReferences(value: unknown): value is RunStateSegmentReference[] {
  return Array.isArray(value) && value.every((segment) => segment
    && typeof segment === 'object'
    && validHash((segment as Partial<RunStateSegmentReference>).hash)
    && Number.isSafeInteger((segment as Partial<RunStateSegmentReference>).eventCount)
    && Number((segment as Partial<RunStateSegmentReference>).eventCount) > 0);
}

function validShellPartReferences(
  value: unknown,
  expectedLength: number,
  allowSingleItemSegments: boolean,
): value is RunStateShellPartReference[] {
  if (!Array.isArray(value)) return false;
  let itemCount = 0;
  let followsLegacyLayout = true;
  let followsSingleItemLayout = allowSingleItemSegments;
  for (let index = 0; index < value.length; index += 1) {
    const reference = value[index] as Partial<RunStateShellPartReference> | null;
    if (!reference
      || typeof reference !== 'object'
      || !validHash(reference.hash)
      || !Number.isSafeInteger(reference.itemCount)
      || Number(reference.itemCount) <= 0
      || Number(reference.itemCount) > MAX_SHELL_ARRAY_ITEMS_PER_SEGMENT) {
      return false;
    }
    const currentItemCount = Number(reference.itemCount);
    if (index < value.length - 1
      && currentItemCount !== MAX_SHELL_ARRAY_ITEMS_PER_SEGMENT) {
      followsLegacyLayout = false;
    }
    if (currentItemCount !== 1) followsSingleItemLayout = false;
    itemCount += currentItemCount;
    if (!Number.isSafeInteger(itemCount)) return false;
  }
  return itemCount === expectedLength
    && (expectedLength === 0) === (value.length === 0)
    && (followsLegacyLayout || followsSingleItemLayout);
}

function validShellFieldReferences(
  value: unknown,
  scope: RunStateShellFieldScope,
): value is RunStateShellFieldReference[] {
  if (!Array.isArray(value)) return false;
  const names = new Set<string>();
  for (const field of value) {
    if (!field || typeof field !== 'object') return false;
    const candidate = field as Partial<RunStateShellFieldReference>;
    if (typeof candidate.name !== 'string'
      || candidate.name.length === 0
      || names.has(candidate.name)) {
      return false;
    }
    names.add(candidate.name);
    if (candidate.kind === 'value') {
      if (!validHash(candidate.hash)) return false;
      continue;
    }
    if (candidate.kind !== 'array'
      || !Number.isSafeInteger(candidate.length)
      || Number(candidate.length) < 0
      || !validShellPartReferences(
        candidate.segments,
        Number(candidate.length),
        scope === 'state' && candidate.name === 'projects',
      )) {
      return false;
    }
  }
  return true;
}

export function verifiedRunStateChunkData(
  chunk: RunStateChunk,
  expectedCodec: string,
  label: string,
): Buffer {
  if (chunk.codec !== expectedCodec) {
    throw new Error(`${label} ${chunk.hash} 使用了不支持的编码 ${chunk.codec}`);
  }
  const data = asBuffer(chunk.data);
  if (chunk.rawSize !== data.byteLength) {
    throw new Error(`${label} ${chunk.hash} 的长度与记录不一致`);
  }
  const actualHash = hashStoredChunk(chunk.codec, data);
  if (actualHash !== chunk.hash) throw new Error(`${label} ${chunk.hash} 的 SHA-256 校验失败`);
  return data;
}

function readReferencedRunStateChunk(
  readChunk: (hash: string) => RunStateChunk,
  expectedHash: string,
  label: string,
): RunStateChunk {
  const chunk = readChunk(expectedHash);
  if (!chunk || chunk.hash !== expectedHash) {
    throw new Error(`${label} 返回的数据块不属于请求引用 ${expectedHash}`);
  }
  return chunk;
}

export function parseRunStateRoot(chunk: RunStateChunk): RunStateRootMetadata {
  const data = verifiedRunStateChunkData(chunk, RUN_STATE_ROOT_CODEC, '运行状态根');
  const root = parsedV8Object(data, '运行状态根');
  if ((root.schemaVersion !== 1 && root.schemaVersion !== 2 && root.schemaVersion !== 3)
    || !validHash(root.shellHash)
    || !validOptionalHash(root.historyHeadHash)
    || !validLineage(root.lineageId)
    || !Number.isSafeInteger(root.eventCount)
    || Number(root.eventCount) < 0
    || !validOptionalHash(root.tailEventContentHash)
    || (Number(root.eventCount) === 0) !== (root.historyHeadHash === null)
    || (Number(root.eventCount) === 0) !== (root.tailEventContentHash === null)) {
    throw new Error('运行状态根内容无效');
  }
  return root as unknown as RunStateRootMetadata;
}

export function parseRunStateShellManifest(chunk: RunStateChunk): RunStateShellManifestMetadata {
  const data = verifiedRunStateChunkData(
    chunk,
    RUN_STATE_SHELL_MANIFEST_CODEC,
    '运行状态 shell manifest',
  );
  const manifest = parsedV8Object(data, '运行状态 shell manifest');
  if (manifest.schemaVersion !== 1
    || !validShellFieldReferences(manifest.fields, 'state')
    || !validShellFieldReferences(manifest.worldFields, 'world')
    || manifest.fields.some((field) => field.name === 'world')
    || manifest.worldFields.some((field) => field.name === 'past')) {
    throw new Error('运行状态 shell manifest 内容无效');
  }
  return manifest as unknown as RunStateShellManifestMetadata;
}

export function parseRunHistoryNode(chunk: RunStateChunk): RunHistoryNodeMetadata {
  const data = verifiedRunStateChunkData(chunk, RUN_HISTORY_NODE_CODEC, '运行历史节点');
  const node = parsedV8Object(data, '运行历史节点');
  if (node.schemaVersion !== 1
    || !validLineage(node.lineageId)
    || !validOptionalHash(node.parentHash)
    || !Number.isSafeInteger(node.startEventIndex)
    || Number(node.startEventIndex) < 0
    || !Number.isSafeInteger(node.eventCount)
    || Number(node.eventCount) <= 0
    || !Number.isSafeInteger(node.totalEventCount)
    || Number(node.totalEventCount) !== Number(node.startEventIndex) + Number(node.eventCount)
    || !validSegmentReferences(node.segments)
    || node.segments.reduce((sum, segment) => sum + segment.eventCount, 0) !== node.eventCount) {
    throw new Error('运行历史节点内容无效');
  }
  return node as unknown as RunHistoryNodeMetadata;
}

function decodeCompressedV8<T>(chunk: RunStateChunk, codec: string, label: string): T {
  const compressed = verifiedRunStateChunkData(chunk, codec, label);
  let raw: Buffer;
  try {
    raw = brotliDecompressSync(compressed);
  } catch (error) {
    throw new Error(`${label} ${chunk.hash} 无法解压`, { cause: error });
  }
  try {
    return deserialize(raw) as T;
  } catch (error) {
    throw new Error(`${label} ${chunk.hash} 无法反序列化`, { cause: error });
  }
}

function assertAppendBoundary(state: SimulationState, previous: RunStateRootMetadata): void {
  if (previous.schemaVersion !== 2 && previous.schemaVersion !== 3) {
    throw new Error('旧版运行状态根必须先通过 replace 模式升级，不能直接追加');
  }
  const events = state.world.past;
  if (events.length < previous.eventCount) {
    throw new Error(
      `运行历史从 ${previous.eventCount} 条缩短为 ${events.length} 条；截断必须使用 replace 模式`,
    );
  }
  if (previous.eventCount === 0) return;
  const boundary = events[previous.eventCount - 1];
  if (!boundary || eventContentHash(boundary) !== previous.tailEventContentHash) {
    throw new Error('运行历史的既有边界已改写；历史改写必须使用 replace 模式');
  }
}

/**
 * Encode only newly committed events against a bounded, already verified
 * history cursor. The returned parts contain event segments followed by the
 * new history node; an empty suffix leaves the cursor and ledger unchanged.
 */
export async function encodeRunHistorySuffix(
  previous: RunHistoryCursor,
  suffix: readonly WorldEvent[],
  options: RunStateEncodeOptions = {},
): Promise<EncodedRunHistorySuffix> {
  assertValidRunHistoryCursor(previous);
  const totalEventCount = previous.eventCount + suffix.length;
  if (!Number.isSafeInteger(totalEventCount)) {
    throw new Error('运行历史事件总数超出安全整数范围');
  }
  if (suffix.length === 0) {
    return {
      cursor: { ...previous },
      parts: [],
    };
  }

  const encodedSegments = await encodeEventSegments(suffix, options);
  const node: RunHistoryNodeMetadata = {
    schemaVersion: 1,
    lineageId: previous.lineageId,
    parentHash: previous.historyHeadHash,
    startEventIndex: previous.eventCount,
    eventCount: suffix.length,
    totalEventCount,
    segments: encodedSegments.references,
  };
  const nodeChunk = storedChunk(RUN_HISTORY_NODE_CODEC, serialize(node));
  return {
    cursor: {
      lineageId: previous.lineageId,
      historyHeadHash: nodeChunk.hash,
      eventCount: totalEventCount,
      tailEventContentHash: tailEventContentHash(suffix),
    },
    parts: [...encodedSegments.chunks, nodeChunk],
  };
}

/**
 * Encode a complete schema-3 root from a shell state, a cold-ledger cursor and
 * only its new history suffix. `state.world.past` is intentionally ignored by
 * shell encoding, so callers do not need to hydrate the historical prefix.
 */
export async function encodeSegmentedRunStateFromHistorySuffix(
  state: SimulationState,
  previous: RunHistoryCursor,
  suffix: readonly WorldEvent[],
  options: RunStateEncodeOptions = {},
): Promise<EncodedRunState> {
  // Snapshot and authenticate the exact previous root before the first await.
  // Stabilization happens after the caller's rule month and before encoding;
  // planners never observe a partially frozen project graph.
  const shellReuse = preparedRunStateShellReuse(options);
  if (shellReuse) stabilizeCompletedProjectsForRunStateShellReuse(state);
  const history = await encodeRunHistorySuffix(previous, suffix, options);
  if (state.world.historyCursor) {
    const expectedTailEventId = suffix.at(-1)?.id ?? state.world.historyCursor.tailEventId;
    assertDomainHistoryCursorMatchesLedger(
      state.world.historyCursor,
      history.cursor.eventCount,
      expectedTailEventId,
      state.world.past.length,
      'suffix 编码 shell',
    );
  }
  const shell = await encodeSegmentedShell(state, shellReuse);
  const metadata: RunStateRootMetadata = {
    schemaVersion: 3,
    shellHash: shell.manifest.hash,
    historyHeadHash: history.cursor.historyHeadHash,
    lineageId: history.cursor.lineageId,
    eventCount: history.cursor.eventCount,
    tailEventContentHash: history.cursor.tailEventContentHash,
  };
  const root = storedChunk(RUN_STATE_ROOT_CODEC, serialize(metadata));
  const encoded: EncodedRunState = {
    root,
    parts: [...shell.parts, shell.manifest, ...history.parts],
    metadata,
  };
  if (shellReuse) {
    const completedProjectSegments = new Map(shell.reusableCompletedProjectSegments);
    const identity = Object.freeze({
      kind: 'verified-run-state-shell-reuse-identity-v1' as const,
      rootHash: root.hash,
      manifestHash: shell.manifest.hash,
      reusableCompletedProjectSegments: completedProjectSegments.size,
    }) as Readonly<VerifiedRunStateShellReuseIdentity>;
    verifiedRunStateShellReuseIdentities.set(identity, {
      authority: shellReuse.authority,
      rootHash: root.hash,
      manifestHash: shell.manifest.hash,
      completedProjectSegments,
    });
    shellSegmentCapturedReusableCompletedProjectSegments += completedProjectSegments.size;
    encoded.shellReuseIdentity = identity;
  }
  return encoded;
}

/**
 * Append reads only the preceding root metadata and encodes the new suffix.
 * Callers that intentionally truncate or rewrite older events must select the
 * replacement path, which starts an independent lineage and encodes all events.
 */
export async function encodeSegmentedRunState(
  state: SimulationState,
  plan: RunStateWritePlan = { mode: 'replace' },
  options: RunStateEncodeOptions = {},
): Promise<EncodedRunState> {
  const events = state.world.past;
  assertFullDomainHistoryCursor(state);
  if (plan.mode === 'append') {
    assertAppendBoundary(state, plan.previous);
    const cursor = runHistoryCursorFromRootMetadata(plan.previous);
    return encodeSegmentedRunStateFromHistorySuffix(
      state,
      cursor,
      events.slice(cursor.eventCount),
      options,
    );
  }

  const emptyCursor: RunHistoryCursor = {
    lineageId: randomUUID(),
    historyHeadHash: null,
    eventCount: 0,
    tailEventContentHash: null,
  };
  return encodeSegmentedRunStateFromHistorySuffix(state, emptyCursor, events, options);
}

function orderedHistoryNodes(
  root: RunStateRootMetadata,
  readChunk: (hash: string) => RunStateChunk,
): Array<{ hash: string; node: RunHistoryNodeMetadata }> {
  const reversed: Array<{ hash: string; node: RunHistoryNodeMetadata }> = [];
  const seen = new Set<string>();
  let expectedTotal = root.eventCount;
  let nodeHash = root.historyHeadHash;
  while (nodeHash) {
    if (seen.has(nodeHash)) throw new Error(`运行历史节点链在 ${nodeHash} 形成循环`);
    seen.add(nodeHash);
    const node = parseRunHistoryNode(readReferencedRunStateChunk(readChunk, nodeHash, '运行历史节点'));
    if (node.lineageId !== root.lineageId) {
      throw new Error(`运行历史节点 ${nodeHash} 与状态根 lineage 不一致`);
    }
    if (node.totalEventCount !== expectedTotal) {
      throw new Error(`运行历史节点 ${nodeHash} 的累计事件数不连续`);
    }
    reversed.push({ hash: nodeHash, node });
    expectedTotal = node.startEventIndex;
    nodeHash = node.parentHash;
  }
  if (expectedTotal !== 0) throw new Error('运行历史节点链缺少前缀');
  return reversed.reverse();
}

/**
 * Prove that two different schema-2/3 roots commit the exact same immutable
 * history while allowing their shell manifests to differ. This is deliberately
 * separate from `streamVerifiedRunHistorySuccessorSegments`: the ordinary
 * append verifier continues to reject every different-root zero-event rewrite.
 *
 * The proof is read-only and grants no persistence authority. A store still
 * has to keep both roots behind its private controller token/generation/CAS
 * join before a same-history shell successor can be published.
 */
export function verifyRunStateSameHistoryShellSuccessor(
  previousRootChunkInput: RunStateChunk,
  nextRootChunkInput: RunStateChunk,
): Readonly<VerifiedRunHistorySuccessor> {
  const previousRootChunk = snapshotRunStateChunk(previousRootChunkInput);
  const nextRootChunk = snapshotRunStateChunk(nextRootChunkInput);
  const previousRoot = parseRunStateRoot(previousRootChunk);
  const nextRoot = parseRunStateRoot(nextRootChunk);
  if ((previousRoot.schemaVersion !== 2 && previousRoot.schemaVersion !== 3)
    || (nextRoot.schemaVersion !== 2 && nextRoot.schemaVersion !== 3)) {
    throw new Error('同历史 shell successor 只接受稳定尾校验的 schema 2/3 运行状态根');
  }
  if (previousRootChunk.hash === nextRootChunk.hash) {
    throw new Error('同历史 shell successor 必须使用不同运行状态根');
  }
  if (previousRoot.shellHash === nextRoot.shellHash
    || previousRoot.lineageId !== nextRoot.lineageId
    || previousRoot.historyHeadHash !== nextRoot.historyHeadHash
    || previousRoot.eventCount !== nextRoot.eventCount
    || previousRoot.tailEventContentHash !== nextRoot.tailEventContentHash) {
    throw new Error('同历史 shell successor 必须精确复用 lineage/head/count/tail 且只改写 shell');
  }
  const previous = Object.freeze({ ...runHistoryCursorFromRootMetadata(previousRoot) });
  const next = Object.freeze({ ...runHistoryCursorFromRootMetadata(nextRoot) });
  return Object.freeze({
    previousRootHash: previousRootChunk.hash,
    nextRootHash: nextRootChunk.hash,
    previous,
    next,
    suffixEventCount: 0,
  });
}

/**
 * Verify that `nextRootChunk` extends the exact history head committed by
 * `previousRootChunk`, then expose only the newly appended segments. Lineage,
 * event counts and tail hashes are necessary checks, but the authoritative
 * ancestry proof is the content-addressed parent chain reaching the previous
 * head at exactly the previous absolute event count.
 *
 * Both roots are synchronously snapshotted before the first await. Segment
 * effects remain caller-staged: a receipt is returned only after the complete
 * suffix chain, segment contents, final event count and tail content hash pass.
 * A visitor can run before a later segment fails, so it MUST write only to
 * private staging and publish/swap that state after this Promise resolves. This
 * function cannot roll back side effects that a visitor publishes directly.
 *
 * This proves ancestry relative to the supplied previous root only. It does not
 * prove that previous root was selected by the authoritative store CAS; the
 * enclosing server boundary must supply that trusted previous root and keep its
 * continuation basis private.
 */
export async function streamVerifiedRunHistorySuccessorSegments(
  previousRootChunk: RunStateChunk,
  nextRootChunk: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
  visit: (
    events: readonly WorldEvent[],
    position: Readonly<RunHistorySegmentPosition>,
  ) => void | Promise<void>,
): Promise<Readonly<VerifiedRunHistorySuccessor>> {
  const previousRootSnapshot = snapshotRunStateChunk(previousRootChunk);
  const nextRootSnapshot = snapshotRunStateChunk(nextRootChunk);
  const previousRoot = parseRunStateRoot(previousRootSnapshot);
  const nextRoot = parseRunStateRoot(nextRootSnapshot);
  if ((previousRoot.schemaVersion !== 2 && previousRoot.schemaVersion !== 3)
    || (nextRoot.schemaVersion !== 2 && nextRoot.schemaVersion !== 3)) {
    throw new Error('运行历史 successor 只接受稳定尾校验的 schema 2/3 运行状态根');
  }

  const previous = runHistoryCursorFromRootMetadata(previousRoot);
  const next = runHistoryCursorFromRootMetadata(nextRoot);
  if (previousRootSnapshot.hash === nextRootSnapshot.hash) {
    return Object.freeze({
      previousRootHash: previousRootSnapshot.hash,
      nextRootHash: nextRootSnapshot.hash,
      previous: Object.freeze({ ...previous }),
      next: Object.freeze({ ...next }),
      suffixEventCount: 0,
    });
  }
  if (next.eventCount === previous.eventCount) {
    throw new Error('不同运行状态根不得以零事件 suffix 改写 shell 或历史');
  }
  if (next.eventCount < previous.eventCount) {
    throw new Error('运行历史 successor 的事件总数早于 previous root');
  }
  if (next.lineageId !== previous.lineageId) {
    throw new Error('运行历史 successor 与 previous root lineage 不一致');
  }

  const reversedSuffixNodes: Array<{ hash: string; node: RunHistoryNodeMetadata }> = [];
  let suffixSegmentReferenceCount = 0;
  let expectedTotal = next.eventCount;
  let nodeHash = next.historyHeadHash;
  while (expectedTotal > previous.eventCount) {
    if (!nodeHash) throw new Error('运行历史 successor 节点链在 previous root 前中断');
    const node = parseRunHistoryNode(
      readReferencedRunStateChunk(readChunk, nodeHash, '运行历史 successor 节点'),
    );
    if (node.lineageId !== next.lineageId) {
      throw new Error(`运行历史 successor 节点 ${nodeHash} 与 next root lineage 不一致`);
    }
    if (node.totalEventCount !== expectedTotal || node.startEventIndex >= expectedTotal) {
      throw new Error(`运行历史 successor 节点 ${nodeHash} 的累计事件数不连续`);
    }
    if (node.startEventIndex < previous.eventCount) {
      throw new Error(`运行历史 successor 节点 ${nodeHash} 跨过 previous root 绝对边界`);
    }
    if (reversedSuffixNodes.length >= MAX_VERIFIED_RUN_HISTORY_SUCCESSOR_NODES) {
      throw new Error(`运行历史 successor 超出 ${MAX_VERIFIED_RUN_HISTORY_SUCCESSOR_NODES} 个相邻 checkpoint 节点上限`);
    }
    suffixSegmentReferenceCount += node.segments.length;
    if (suffixSegmentReferenceCount > MAX_VERIFIED_RUN_HISTORY_SUCCESSOR_SEGMENT_REFERENCES) {
      throw new Error(`运行历史 successor 超出 ${MAX_VERIFIED_RUN_HISTORY_SUCCESSOR_SEGMENT_REFERENCES} 个 segment reference 上限`);
    }
    reversedSuffixNodes.push({ hash: nodeHash, node });
    expectedTotal = node.startEventIndex;
    nodeHash = node.parentHash;
  }
  if (expectedTotal !== previous.eventCount || nodeHash !== previous.historyHeadHash) {
    throw new Error('运行历史 successor 未精确到达 previous root 的 history head');
  }

  let streamedEventCount = previous.eventCount;
  let streamedTailEventContentHash: string | null = null;
  for (let nodeOffset = reversedSuffixNodes.length - 1; nodeOffset >= 0; nodeOffset -= 1) {
    const { hash: suffixNodeHash, node } = reversedSuffixNodes[nodeOffset];
    if (node.startEventIndex !== streamedEventCount) {
      throw new Error(`运行历史 successor 节点 ${suffixNodeHash} 的起始事件序号不连续`);
    }
    for (const reference of node.segments) {
      const segment = decodeCompressedV8<unknown>(
        readReferencedRunStateChunk(readChunk, reference.hash, '运行历史 successor 事件分段'),
        RUN_STATE_EVENT_SEGMENT_CODEC,
        '运行历史 successor 事件分段',
      );
      if (!Array.isArray(segment) || segment.length !== reference.eventCount) {
        throw new Error(`运行历史 successor 事件分段 ${reference.hash} 的事件数量与历史节点不一致`);
      }
      const segmentEvents = deepFreezeOwnedValue(segment as WorldEvent[]);
      const startEventIndex = streamedEventCount;
      streamedEventCount += segmentEvents.length;
      streamedTailEventContentHash = tailEventContentHash(segmentEvents);
      await visit(segmentEvents, {
        nodeHash: suffixNodeHash,
        segmentHash: reference.hash,
        startEventIndex,
      });
    }
    if (streamedEventCount !== node.totalEventCount) {
      throw new Error(`运行历史 successor 节点 ${suffixNodeHash} 的事件分段没有覆盖完整节点`);
    }
  }
  if (streamedEventCount !== next.eventCount
    || streamedTailEventContentHash !== next.tailEventContentHash) {
    throw new Error('运行历史 successor suffix 与 next root 不一致');
  }

  return Object.freeze({
    previousRootHash: previousRootSnapshot.hash,
    nextRootHash: nextRootSnapshot.hash,
    previous: Object.freeze({ ...previous }),
    next: Object.freeze({ ...next }),
    suffixEventCount: next.eventCount - previous.eventCount,
  });
}

/**
 * Verify and expose schema-2/3 history one decoded segment at a time in its
 * authoritative event order. A segment's stored hash, codec and declared
 * count are verified before its callback. The root event count and tail hash,
 * however, are known valid only after this Promise resolves. Visitors must
 * therefore stage work or be idempotent; commit staged work only after resolve
 * and never perform an irreversible side effect inside the callback. The codec
 * awaits each visitor before decoding the next segment and does not
 * canonicalize or rewrite any event references.
 */
export async function streamVerifiedRunHistorySegments(
  root: RunStateRootMetadata,
  readChunk: (hash: string) => RunStateChunk,
  visit: (
    events: readonly WorldEvent[],
    position: Readonly<RunHistorySegmentPosition>,
  ) => void | Promise<void>,
): Promise<RunHistoryCursor> {
  const cursor = runHistoryCursorFromRootMetadata(root);
  let streamedEventCount = 0;
  let streamedTailEventContentHash: string | null = null;
  for (const { hash: nodeHash, node } of orderedHistoryNodes(root, readChunk)) {
    if (node.startEventIndex !== streamedEventCount) {
      throw new Error(`运行历史节点 ${nodeHash} 的起始事件序号不连续`);
    }
    for (const reference of node.segments) {
      const segment = decodeCompressedV8<unknown>(
        readReferencedRunStateChunk(readChunk, reference.hash, '运行状态事件分段'),
        RUN_STATE_EVENT_SEGMENT_CODEC,
        '运行状态事件分段',
      );
      if (!Array.isArray(segment) || segment.length !== reference.eventCount) {
        throw new Error(`运行状态事件分段 ${reference.hash} 的事件数量与历史节点不一致`);
      }
      const segmentEvents = segment as WorldEvent[];
      const startEventIndex = streamedEventCount;
      streamedEventCount += segmentEvents.length;
      streamedTailEventContentHash = tailEventContentHash(segmentEvents);
      await visit(segmentEvents, {
        nodeHash,
        segmentHash: reference.hash,
        startEventIndex,
      });
    }
  }
  if (streamedEventCount !== cursor.eventCount
    || streamedTailEventContentHash !== cursor.tailEventContentHash) {
    throw new Error('运行状态事件历史与状态根不一致');
  }
  return cursor;
}

function shellPartHashes(manifest: RunStateShellManifestMetadata): string[] {
  const hashes: string[] = [];
  for (const field of [...manifest.fields, ...manifest.worldFields]) {
    if (field.kind === 'value') {
      hashes.push(field.hash);
    } else {
      hashes.push(...field.segments.map((segment) => segment.hash));
    }
  }
  return hashes;
}

function markReachableRunStateShellChunks(
  root: RunStateRootMetadata,
  readChunk: (hash: string) => RunStateChunk,
  memo: RunStateReachabilityMemo,
): void {
  const shellHash = root.shellHash;
  memo.chunks.add(shellHash);
  const shellChunk = readReferencedRunStateChunk(readChunk, shellHash, '运行状态 shell');
  if (shellChunk.codec === RUN_STATE_SHELL_CODEC) {
    if (root.schemaVersion === 3) {
      throw new Error('运行状态根 schemaVersion 3 必须引用 shell manifest');
    }
    verifiedRunStateChunkData(shellChunk, RUN_STATE_SHELL_CODEC, '运行状态 shell');
    return;
  }
  if (shellChunk.codec !== RUN_STATE_SHELL_MANIFEST_CODEC) {
    throw new Error(`运行状态 shell ${shellHash} 使用了不支持的编码 ${shellChunk.codec}`);
  }
  if (root.schemaVersion !== 3) {
    throw new Error('旧版运行状态根不得引用 shell manifest');
  }
  memo.shellManifests ??= new Set<string>();
  if (memo.shellManifests.has(shellHash)) return;
  memo.shellManifests.add(shellHash);
  const manifest = parseRunStateShellManifest(shellChunk);
  memo.shellParts ??= new Set<string>();
  for (const partHash of shellPartHashes(manifest)) {
    memo.chunks.add(partHash);
    if (memo.shellParts.has(partHash)) continue;
    memo.shellParts.add(partHash);
    verifiedRunStateChunkData(
      readReferencedRunStateChunk(readChunk, partHash, '运行状态 shell 子块'),
      RUN_STATE_SHELL_PART_CODEC,
      '运行状态 shell 子块',
    );
  }
}

/**
 * Prove that a receipt was minted only after this module verified every field
 * and segment referenced by the exact schema-3 root.
 */
export function assertVerifiedSchema3RunStateShellReceipt(
  value: unknown,
  expectedRootHash: string,
): asserts value is Readonly<VerifiedSchema3RunStateShellReceipt> {
  if (!validHash(expectedRootHash)
    || !value
    || typeof value !== 'object'
    || !verifiedSchema3RunStateShellReceipts.has(value)
    || (value as VerifiedSchema3RunStateShellReceipt).rootHash !== expectedRootHash) {
    throw new Error('schema3 shell receipt 未经过当前 exact root 的完整流式验证');
  }
}

/**
 * Stream one exact schema-3 shell without materializing any complete manifest
 * array field. The root is synchronously snapshotted before the first await;
 * its own `shellHash` is the only accepted manifest selection. Each referenced
 * part is likewise copied, codec/hash checked and decoded before its callback.
 *
 * Callbacks are a staging seam, not an authority seam: an early callback may
 * run before a later referenced chunk fails. Only the final module-branded
 * receipt proves that the complete ordered manifest reached its exact seal.
 * Schema 1/2 roots deliberately fail closed and keep their legacy full-shell
 * decoder path unchanged.
 */
async function streamVerifiedSchema3RunStateShellInternal(
  rootChunkInput: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
  visitor: Readonly<VerifiedSchema3RunStateShellVisitor> = {},
  carryDerivedObserverValueOpaque = false,
): Promise<Readonly<VerifiedSchema3RunStateShellReceipt>> {
  if (typeof readChunk !== 'function') {
    throw new Error('schema3 shell stream 缺少 chunk reader');
  }
  if (!visitor || typeof visitor !== 'object') {
    throw new Error('schema3 shell stream visitor 必须是对象');
  }
  const visitValue = visitor.visitValue;
  const visitArraySegment = visitor.visitArraySegment;
  const visitField = visitor.visitField;
  if (visitField !== undefined && typeof visitField !== 'function') {
    throw new Error('schema3 shell stream visitField 必须是函数');
  }
  if (visitValue !== undefined && typeof visitValue !== 'function') {
    throw new Error('schema3 shell stream visitValue 必须是函数');
  }
  if (visitArraySegment !== undefined && typeof visitArraySegment !== 'function') {
    throw new Error('schema3 shell stream visitArraySegment 必须是函数');
  }

  const rootChunk = snapshotRunStateChunk(rootChunkInput);
  const root = parseRunStateRoot(rootChunk);
  if (root.schemaVersion !== 3) {
    throw new Error('流式 shell primitive 只接受 schemaVersion 3 root');
  }
  const manifestChunk = snapshotRunStateChunk(readReferencedRunStateChunk(
    readChunk,
    root.shellHash,
    'schema3 shell manifest',
  ));
  const manifest = parseRunStateShellManifest(manifestChunk);

  let absoluteFieldIndex = 0;
  let valueFieldCount = 0;
  let arrayFieldCount = 0;
  let arraySegmentCount = 0;
  let arrayItemCount = 0;
  let opaqueObserverValueFieldCount = 0;
  const visitFields = async (
    scope: RunStateShellFieldScope,
    fields: readonly RunStateShellFieldReference[],
  ): Promise<void> => {
    for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
      const field = fields[fieldIndex];
      const currentAbsoluteFieldIndex = absoluteFieldIndex;
      absoluteFieldIndex += 1;
      if (visitField) {
        await visitField(Object.freeze(field.kind === 'value'
          ? {
            scope,
            fieldName: field.name,
            fieldIndex,
            absoluteFieldIndex: currentAbsoluteFieldIndex,
            kind: 'value' as const,
            chunkHash: field.hash,
          }
          : {
            scope,
            fieldName: field.name,
            fieldIndex,
            absoluteFieldIndex: currentAbsoluteFieldIndex,
            kind: 'array' as const,
            fieldLength: field.length,
            segmentCount: field.segments.length,
          }));
      }
      if (field.kind === 'value') {
        const part = snapshotRunStateChunk(readReferencedRunStateChunk(
          readChunk,
          field.hash,
          `schema3 shell ${scope} value ${field.name}`,
        ));
        if (carryDerivedObserverValueOpaque
          && scope === 'state'
          && field.name === 'derived') {
          verifiedRunStateChunkData(
            part,
            RUN_STATE_SHELL_PART_CODEC,
            `schema3 shell ${scope} opaque observer value ${field.name}`,
          );
          valueFieldCount += 1;
          opaqueObserverValueFieldCount += 1;
          continue;
        }
        const value = decodeCompressedV8<unknown>(
          part,
          RUN_STATE_SHELL_PART_CODEC,
          `schema3 shell ${scope} value ${field.name}`,
        );
        if (Array.isArray(value)) {
          throw new Error(`schema3 shell ${scope} value ${field.name} 非法解码为数组`);
        }
        valueFieldCount += 1;
        if (visitValue) {
          await visitValue(value, Object.freeze({
            scope,
            fieldName: field.name,
            fieldIndex,
            absoluteFieldIndex: currentAbsoluteFieldIndex,
            kind: 'value' as const,
            chunkHash: field.hash,
          }));
        }
        continue;
      }

      arrayFieldCount += 1;
      let startItemIndex = 0;
      for (let segmentIndex = 0; segmentIndex < field.segments.length; segmentIndex += 1) {
        const reference = field.segments[segmentIndex];
        const part = snapshotRunStateChunk(readReferencedRunStateChunk(
          readChunk,
          reference.hash,
          `schema3 shell ${scope} array ${field.name} segment ${segmentIndex}`,
        ));
        const decoded = decodeCompressedV8<unknown>(
          part,
          RUN_STATE_SHELL_PART_CODEC,
          `schema3 shell ${scope} array ${field.name} segment ${segmentIndex}`,
        );
        if (!Array.isArray(decoded) || decoded.length !== reference.itemCount) {
          throw new Error(
            `schema3 shell ${scope} array ${field.name} segment ${segmentIndex}`
            + ' 的 itemCount 与 manifest 不一致',
          );
        }
        const items = Object.freeze(decoded) as readonly unknown[];
        const position = Object.freeze({
          scope,
          fieldName: field.name,
          fieldIndex,
          absoluteFieldIndex: currentAbsoluteFieldIndex,
          kind: 'array-segment' as const,
          fieldLength: field.length,
          segmentIndex,
          segmentCount: field.segments.length,
          startItemIndex,
          itemCount: reference.itemCount,
          chunkHash: reference.hash,
        });
        if (visitArraySegment) await visitArraySegment(items, position);
        startItemIndex += reference.itemCount;
        arraySegmentCount += 1;
        arrayItemCount += reference.itemCount;
        if (!Number.isSafeInteger(startItemIndex)
          || !Number.isSafeInteger(arraySegmentCount)
          || !Number.isSafeInteger(arrayItemCount)) {
          throw new Error('schema3 shell stream 计数超出安全整数范围');
        }
      }
      if (startItemIndex !== field.length) {
        throw new Error(`schema3 shell ${scope} array ${field.name} 未精确覆盖字段长度`);
      }
    }
  };

  await visitFields('state', manifest.fields);
  await visitFields('world', manifest.worldFields);
  if (absoluteFieldIndex !== manifest.fields.length + manifest.worldFields.length) {
    throw new Error('schema3 shell stream 未精确覆盖 manifest 字段顺序');
  }
  if (carryDerivedObserverValueOpaque && opaqueObserverValueFieldCount !== 1) {
    throw new Error('gameplay shell stream 必须精确 opaque carry 一个 state.derived value');
  }

  const receipt = Object.freeze({
    kind: 'verified-schema3-run-state-shell-receipt-v1' as const,
    rootHash: rootChunk.hash,
    manifestHash: manifestChunk.hash,
    stateFieldCount: manifest.fields.length,
    worldFieldCount: manifest.worldFields.length,
    valueFieldCount,
    arrayFieldCount,
    arraySegmentCount,
    arrayItemCount,
    opaqueObserverValueFieldCount,
  }) as Readonly<VerifiedSchema3RunStateShellReceipt>;
  verifiedSchema3RunStateShellReceipts.add(receipt);
  return receipt;
}

/** Decode and visit every field in one exact schema-3 shell. */
export async function streamVerifiedSchema3RunStateShell(
  rootChunkInput: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
  visitor: Readonly<VerifiedSchema3RunStateShellVisitor> = {},
): Promise<Readonly<VerifiedSchema3RunStateShellReceipt>> {
  return streamVerifiedSchema3RunStateShellInternal(
    rootChunkInput,
    readChunk,
    visitor,
    false,
  );
}

/**
 * Closed gameplay continuation profile. The exact `state.derived` part remains
 * reference/hash/codec/length verified, but is not decompressed or deserialized.
 * No caller-selectable skip predicate exists; every other field is decoded.
 */
export async function streamVerifiedSchema3GameplayShell(
  rootChunkInput: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
  visitor: Readonly<VerifiedSchema3RunStateShellVisitor> = {},
): Promise<Readonly<VerifiedSchema3RunStateShellReceipt>> {
  return streamVerifiedSchema3RunStateShellInternal(
    rootChunkInput,
    readChunk,
    visitor,
    true,
  );
}

/** Return every codec-owned chunk reachable from one verified state root. */
export function markReachableRunStateChunks(
  rootChunk: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
  memo: RunStateReachabilityMemo = { chunks: new Set<string>(), historyNodes: new Set<string>() },
): RunStateReachabilityMemo {
  const root = parseRunStateRoot(rootChunk);
  memo.chunks.add(rootChunk.hash);
  markReachableRunStateShellChunks(root, readChunk, memo);
  let expectedTotal = root.eventCount;
  let nodeHash = root.historyHeadHash;
  while (nodeHash) {
    const node = parseRunHistoryNode(readReferencedRunStateChunk(readChunk, nodeHash, '运行历史节点'));
    if (node.lineageId !== root.lineageId || node.totalEventCount !== expectedTotal) {
      throw new Error(`运行历史节点 ${nodeHash} 与状态根不连续`);
    }
    memo.chunks.add(nodeHash);
    if (memo.historyNodes.has(nodeHash)) return memo;
    memo.historyNodes.add(nodeHash);
    for (const reference of node.segments) {
      memo.chunks.add(reference.hash);
    }
    expectedTotal = node.startEventIndex;
    nodeHash = node.parentHash;
  }
  if (expectedTotal !== 0) throw new Error('运行历史节点链缺少前缀');
  return memo;
}

function decodeShellFieldReferences(
  fields: RunStateShellFieldReference[],
  readChunk: (hash: string) => RunStateChunk,
  canonicalEventIds?: CanonicalEventIdLookup,
): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.kind === 'value') {
      const value = decodeCompressedV8<unknown>(
        readReferencedRunStateChunk(readChunk, field.hash, `运行状态 shell 字段 ${field.name}`),
        RUN_STATE_SHELL_PART_CODEC,
        `运行状态 shell 字段 ${field.name}`,
      );
      if (canonicalEventIds) canonicalizeEventIdReferences(value, canonicalEventIds);
      decoded[field.name] = value;
      continue;
    }
    const items: unknown[] = new Array(field.length);
    let offset = 0;
    for (const reference of field.segments) {
      const segment = decodeCompressedV8<unknown>(
        readReferencedRunStateChunk(readChunk, reference.hash, `运行状态 shell 数组 ${field.name}`),
        RUN_STATE_SHELL_PART_CODEC,
        `运行状态 shell 数组 ${field.name}`,
      );
      if (!Array.isArray(segment) || segment.length !== reference.itemCount) {
        throw new Error(`运行状态 shell 数组 ${field.name} 的子块 ${reference.hash} 数量不一致`);
      }
      if (canonicalEventIds) canonicalizeEventIdReferences(segment, canonicalEventIds);
      for (let index = 0; index < segment.length; index += 1) {
        if (Object.prototype.hasOwnProperty.call(segment, index)) {
          items[offset + index] = segment[index];
        }
      }
      offset += segment.length;
    }
    if (offset !== field.length) {
      throw new Error(`运行状态 shell 数组 ${field.name} 的总长度不一致`);
    }
    decoded[field.name] = items;
  }
  return decoded;
}

function decodeRunStateShell(
  root: RunStateRootMetadata,
  readChunk: (hash: string) => RunStateChunk,
  canonicalEventIds?: CanonicalEventIdLookup,
): SimulationStateShell {
  const shellHash = root.shellHash;
  const shellChunk = readReferencedRunStateChunk(readChunk, shellHash, '运行状态 shell');
  let shell: SimulationStateShell;
  if (shellChunk.codec === RUN_STATE_SHELL_CODEC) {
    if (root.schemaVersion === 3) {
      throw new Error('运行状态根 schemaVersion 3 必须引用 shell manifest');
    }
    shell = decodeCompressedV8<SimulationStateShell>(
      shellChunk,
      RUN_STATE_SHELL_CODEC,
      '运行状态 shell',
    );
    if (canonicalEventIds) canonicalizeEventIdReferences(shell, canonicalEventIds);
  } else {
    if (shellChunk.codec !== RUN_STATE_SHELL_MANIFEST_CODEC) {
      throw new Error(`运行状态 shell ${shellHash} 使用了不支持的编码 ${shellChunk.codec}`);
    }
    if (root.schemaVersion !== 3) {
      throw new Error('旧版运行状态根不得引用 shell manifest');
    }
    const manifest = parseRunStateShellManifest(shellChunk);
    shell = {
      ...decodeShellFieldReferences(manifest.fields, readChunk, canonicalEventIds),
      world: decodeShellFieldReferences(manifest.worldFields, readChunk, canonicalEventIds),
    } as unknown as SimulationStateShell;
  }
  if (Object.prototype.hasOwnProperty.call(shell, LAST_MATERIALIZED_OBSERVER_BASIS_FIELD)) {
    throw new Error('bounded gameplay root 必须通过 closed gameplay decoder 恢复');
  }
  return shell;
}

/**
 * Replace strings that equal an authoritative event id with the exact string
 * value held by that WorldEvent. Only decoded, mutable container values are
 * changed; keys, prototypes, typed buffers and other opaque objects are kept.
 */
function canonicalEventIdFromLookup(
  canonicalEventIds: CanonicalEventIdLookup,
  eventId: string,
): string | undefined {
  return canonicalEventIds.get(eventId);
}

function compactCanonicalEventIdLookup(
  canonicalEventIds: Map<string, string>,
): CompactCanonicalEventIdLookup {
  const compact = new Array<string>(canonicalEventIds.size);
  let offset = 0;
  for (const canonical of canonicalEventIds.values()) {
    compact[offset] = canonical;
    offset += 1;
  }
  canonicalEventIds.clear();
  compact.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return new CompactCanonicalEventIdLookup(compact);
}

function canonicalizeEventIdReferences(
  value: unknown,
  canonicalEventIds: CanonicalEventIdLookup,
): void {
  if (!value || typeof value !== 'object' || canonicalEventIds.size === 0) return;
  const pending: object[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);

    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(current, index)) continue;
        const child = current[index];
        if (typeof child === 'string') {
          const canonical = canonicalEventIdFromLookup(canonicalEventIds, child);
          if (canonical !== undefined) current[index] = canonical;
        } else if (child && typeof child === 'object') {
          pending.push(child);
        }
      }
      continue;
    }

    if (current instanceof Map) {
      for (const [key, child] of current) {
        if (typeof child === 'string') {
          const canonical = canonicalEventIdFromLookup(canonicalEventIds, child);
          if (canonical !== undefined) current.set(key, canonical);
        } else if (child && typeof child === 'object') {
          pending.push(child);
        }
        if (key && typeof key === 'object') pending.push(key);
      }
      continue;
    }

    if (current instanceof Set) {
      const items = [...current];
      let hasCanonicalString = false;
      for (let index = 0; index < items.length; index += 1) {
        const child = items[index];
        if (typeof child === 'string') {
          const canonical = canonicalEventIdFromLookup(canonicalEventIds, child);
          if (canonical !== undefined) {
            items[index] = canonical;
            hasCanonicalString = true;
          }
        } else if (child && typeof child === 'object') {
          pending.push(child);
        }
      }
      if (hasCanonicalString) {
        current.clear();
        for (const item of items) current.add(item);
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) continue;
    for (const key of Object.keys(current)) {
      const record = current as Record<string, unknown>;
      const child = record[key];
      if (typeof child === 'string') {
        const canonical = canonicalEventIdFromLookup(canonicalEventIds, child);
        if (canonical !== undefined) record[key] = canonical;
      } else if (child && typeof child === 'object') {
        pending.push(child);
      }
    }
  }
}

/** Narrow container-safety seam for the persistence codec's synthetic tests. */
export function canonicalizeEventIdReferencesForTests(
  value: unknown,
  canonicalEventIds: CanonicalEventIdLookup,
): void {
  canonicalizeEventIdReferences(value, canonicalEventIds);
}

/** Narrow release-boundary seam for the persistence codec's synthetic tests. */
export function compactCanonicalEventIdLookupForTests(
  canonicalEventIds: Map<string, string>,
): CompactCanonicalEventIdLookup {
  return compactCanonicalEventIdLookup(canonicalEventIds);
}

/** Narrow lookup-exactness seam for the persistence codec's synthetic tests. */
export function canonicalEventIdFromCompactLookupForTests(
  canonicalEventIds: CanonicalEventIdLookup,
  eventId: string,
): string | undefined {
  return canonicalEventIdFromLookup(canonicalEventIds, eventId);
}

/** Decode and verify every referenced shell/node/segment before hydration. */
export async function decodeSegmentedRunState(
  rootChunk: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
  options: RunStateDecodeOptions = {},
): Promise<DecodedRunState> {
  const root = parseRunStateRoot(rootChunk);
  const events: WorldEvent[] = [];
  const auditStringPool = new Map<string, string>();
  const canonicalEventIds = options.canonicalizeEventIdReferences !== false
    ? new Map<string, string>()
    : undefined;
  for (const { node } of orderedHistoryNodes(root, readChunk)) {
    for (const reference of node.segments) {
      const segment = await decodeCompressedV8<unknown>(
        readReferencedRunStateChunk(readChunk, reference.hash, '运行状态事件分段'),
        RUN_STATE_EVENT_SEGMENT_CODEC,
        '运行状态事件分段',
      );
      if (!Array.isArray(segment) || segment.length !== reference.eventCount) {
        throw new Error(`运行状态事件分段 ${reference.hash} 的事件数量与历史节点不一致`);
      }
      const segmentEvents = segment as WorldEvent[];
      internEventHistoryAuditStrings(segmentEvents, auditStringPool, canonicalEventIds);
      events.push(...segmentEvents);
    }
  }
  if (events.length !== root.eventCount
    || (root.schemaVersion >= 2 && tailEventContentHash(events) !== root.tailEventContentHash)) {
    throw new Error('运行状态事件历史与状态根不一致');
  }

  // Tail verification no longer needs the audit-text index. Release it before
  // shell hydration; canonical event IDs remain live for shell references.
  const releasedAuditStringCount = auditStringPool.size;
  auditStringPool.clear();
  const compactCanonicalEventIds = canonicalEventIds
    ? compactCanonicalEventIdLookup(canonicalEventIds)
    : undefined;
  options.onBeforeShellDecodeForTests?.({
    releasedAuditStringCount,
    auditStringCount: auditStringPool.size,
    canonicalEventIdCount: canonicalEventIds?.size ?? 0,
    compactCanonicalEventIdCount: compactCanonicalEventIds?.size ?? 0,
  });
  const shell = decodeRunStateShell(root, readChunk, compactCanonicalEventIds);
  if (!shell || typeof shell !== 'object' || !shell.world || typeof shell.world !== 'object') {
    throw new Error('运行状态 shell 内容无效');
  }
  if (Object.prototype.hasOwnProperty.call(shell.world, 'past')) {
    throw new Error('运行状态 shell 非法包含 world.past');
  }
  if (shell.world.historyCursor) {
    assertDomainHistoryCursorMatchesLedger(
      shell.world.historyCursor,
      root.eventCount,
      events.at(-1)?.id ?? null,
      events.length,
      '运行状态 shell',
    );
  }

  // The hydrated history and shell now own every canonical string reference.
  // Drop the compact lookup before building lastStep's local identity map so
  // restore peak does not retain both generations together.
  compactCanonicalEventIds?.clear();
  options.onAfterShellValidationForTests?.({
    compactCanonicalEventIdCount: compactCanonicalEventIds?.size ?? 0,
  });

  const lastStepIds = new Set(shell.lastStep.map((event) => event.id));
  const lastStepEventsById = new Map<string, WorldEvent>();
  for (let index = events.length - 1; index >= 0 && lastStepEventsById.size < lastStepIds.size; index -= 1) {
    const event = events[index];
    if (lastStepIds.has(event.id) && !lastStepEventsById.has(event.id)) {
      lastStepEventsById.set(event.id, event);
    }
  }
  const lastStep = shell.lastStep.map((event) => lastStepEventsById.get(event.id) ?? event);
  return {
    state: {
      ...shell,
      world: { ...shell.world, past: events },
      lastStep,
    },
    metadata: root,
  };
}

function boundedPinnedEventIndexes(
  indexes: readonly number[] | undefined,
  eventCount: number,
  hotStartIndex: number,
): number[] {
  if (indexes === undefined) return [];
  if (!Array.isArray(indexes)) throw new Error('bounded decode 的 pinnedEventIndexes 必须是数组');
  const unique = new Set<number>();
  for (const index of indexes) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= eventCount) {
      throw new Error(`bounded decode 的 pin 绝对序号 ${String(index)} 超出运行历史范围`);
    }
    if (index < hotStartIndex) unique.add(index);
  }
  return [...unique].sort((left, right) => left - right);
}

/**
 * Materialize exact, selected event bodies from a schema-2/3 history root.
 * Every history node is verified to preserve the absolute ordinal frame, but
 * unrelated event segments stay compressed. This is intentionally narrower
 * than full-ledger streaming: callers must still validate each selected event
 * identity against their own authenticated pin manifest.
 */
export function materializeVerifiedRunHistoryPinnedEvents(
  root: RunStateRootMetadata,
  readChunk: (hash: string) => RunStateChunk,
  absoluteIndexes: readonly number[],
): RunStatePinnedEvent[] {
  const cursor = runHistoryCursorFromRootMetadata(root);
  if (!Array.isArray(absoluteIndexes)) {
    throw new Error('历史 pin 物化的绝对序号必须是数组');
  }
  const requested = [...absoluteIndexes];
  let previousIndex = -1;
  for (const absoluteIndex of requested) {
    if (!Number.isSafeInteger(absoluteIndex)
      || absoluteIndex < 0
      || absoluteIndex >= cursor.eventCount) {
      throw new Error(`历史 pin 物化的绝对序号 ${String(absoluteIndex)} 超出运行历史范围`);
    }
    if (absoluteIndex <= previousIndex) {
      throw new Error('历史 pin 物化的绝对序号必须严格递增且不得重复');
    }
    previousIndex = absoluteIndex;
  }
  if (requested.length === 0) return [];

  const pinnedEvents = new Array<RunStatePinnedEvent>(requested.length);
  let nextPinOffset = requested.length - 1;
  let expectedNodeTotal = cursor.eventCount;
  let nodeHash = cursor.historyHeadHash;
  while (nodeHash) {
    const node = parseRunHistoryNode(
      readReferencedRunStateChunk(readChunk, nodeHash, '历史 pin 物化节点'),
    );
    if (node.lineageId !== cursor.lineageId) {
      throw new Error(`历史 pin 物化节点 ${nodeHash} 与状态根 lineage 不一致`);
    }
    if (node.totalEventCount !== expectedNodeTotal
      || node.startEventIndex >= expectedNodeTotal) {
      throw new Error(`历史 pin 物化节点 ${nodeHash} 的累计事件数没有严格递减`);
    }

    let segmentEndIndex = node.totalEventCount;
    for (let segmentIndex = node.segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
      const reference = node.segments[segmentIndex];
      const segmentStartIndex = segmentEndIndex - reference.eventCount;
      if (segmentStartIndex < node.startEventIndex) {
        throw new Error(`历史 pin 物化节点 ${nodeHash} 的事件分段序号不连续`);
      }
      const nextPinIndex = requested[nextPinOffset];
      if (nextPinOffset >= 0 && nextPinIndex >= segmentEndIndex) {
        throw new Error(`历史 pin 物化未找到绝对序号 ${nextPinIndex}`);
      }
      if (nextPinOffset >= 0 && nextPinIndex >= segmentStartIndex) {
        const decoded = decodeCompressedV8<unknown>(
          readReferencedRunStateChunk(readChunk, reference.hash, '历史 pin 物化事件分段'),
          RUN_STATE_EVENT_SEGMENT_CODEC,
          '历史 pin 物化事件分段',
        );
        if (!Array.isArray(decoded) || decoded.length !== reference.eventCount) {
          throw new Error(
            `历史 pin 物化事件分段 ${reference.hash} 的事件数量与历史节点不一致`,
          );
        }
        const segment = decoded as WorldEvent[];
        while (nextPinOffset >= 0 && requested[nextPinOffset] >= segmentStartIndex) {
          const absoluteIndex = requested[nextPinOffset];
          if (absoluteIndex >= segmentEndIndex) {
            throw new Error(`历史 pin 物化未找到绝对序号 ${absoluteIndex}`);
          }
          pinnedEvents[nextPinOffset] = Object.freeze({
            absoluteIndex,
            event: deepFreezeOwnedValue(segment[absoluteIndex - segmentStartIndex]),
          });
          nextPinOffset -= 1;
        }
      }
      segmentEndIndex = segmentStartIndex;
    }
    if (segmentEndIndex !== node.startEventIndex) {
      throw new Error(`历史 pin 物化节点 ${nodeHash} 的事件分段没有覆盖完整节点`);
    }
    expectedNodeTotal = node.startEventIndex;
    nodeHash = node.parentHash;
  }

  if (expectedNodeTotal !== 0) throw new Error('历史 pin 物化节点链缺少前缀');
  if (nextPinOffset !== -1) {
    throw new Error(`历史 pin 物化未找到绝对序号 ${requested[nextPinOffset]}`);
  }
  return pinnedEvents;
}

interface LastStepContentGroups {
  hashesByEventId: Map<string, Set<string>>;
  shellIndexesByHash: Map<string, number[]>;
}

interface DecodedBoundedRunHistory {
  hotEvents: WorldEvent[];
  pinnedEvents: RunStatePinnedEvent[];
  tailEventId: string | null;
  ledgerOccurrencesByLastStepHash: Map<string, number>;
}

function lastStepContentGroups(lastStep: readonly WorldEvent[]): LastStepContentGroups {
  const hashesByEventId = new Map<string, Set<string>>();
  const shellIndexesByHash = new Map<string, number[]>();
  for (let index = 0; index < lastStep.length; index += 1) {
    const event = lastStep[index];
    const hash = eventContentHash(event);
    const hashes = hashesByEventId.get(event.id);
    if (hashes) hashes.add(hash);
    else hashesByEventId.set(event.id, new Set([hash]));
    const shellIndexes = shellIndexesByHash.get(hash);
    if (shellIndexes) shellIndexes.push(index);
    else shellIndexesByHash.set(hash, [index]);
  }
  return { hashesByEventId, shellIndexesByHash };
}

function countLastStepContentOccurrences(
  events: readonly WorldEvent[],
  groups: LastStepContentGroups,
  counts: Map<string, number>,
): void {
  for (const event of events) {
    // Event IDs are a cheap rejection filter. Content hashing is needed only
    // for the handful of IDs present in the bounded shell's last step.
    const candidateHashes = groups.hashesByEventId.get(event.id);
    if (!candidateHashes) continue;
    const hash = eventContentHash(event);
    if (candidateHashes.has(hash)) counts.set(hash, (counts.get(hash) ?? 0) + 1);
  }
}

/**
 * Verify the ledger from its head towards the genesis without materializing
 * the node chain. `totalEventCount -> startEventIndex` must strictly decrease,
 * so a cycle or discontinuity fails with O(1) node metadata residency.
 */
function decodeBoundedRunHistoryReverse(
  root: RunStateRootMetadata,
  readChunk: (hash: string) => RunStateChunk,
  hotStartIndex: number,
  requestedColdPins: readonly number[],
  lastStepGroups: LastStepContentGroups,
): DecodedBoundedRunHistory {
  const hotEventCount = root.eventCount - hotStartIndex;
  const hotEvents = new Array<WorldEvent>(hotEventCount);
  const pinnedEvents = new Array<RunStatePinnedEvent>(requestedColdPins.length);
  const ledgerOccurrencesByLastStepHash = new Map<string, number>();
  let filledHotEventCount = 0;
  let nextPinOffset = requestedColdPins.length - 1;
  let expectedNodeTotal = root.eventCount;
  let nodeHash = root.historyHeadHash;
  let tailEventId: string | null = null;
  let streamedTailEventContentHash: string | null = null;
  let sawTailSegment = false;

  while (nodeHash) {
    const node = parseRunHistoryNode(readReferencedRunStateChunk(readChunk, nodeHash, '运行历史节点'));
    if (node.lineageId !== root.lineageId) {
      throw new Error(`运行历史节点 ${nodeHash} 与状态根 lineage 不一致`);
    }
    if (node.totalEventCount !== expectedNodeTotal
      || node.startEventIndex >= expectedNodeTotal) {
      throw new Error(`运行历史节点 ${nodeHash} 的累计事件数没有严格递减`);
    }

    let segmentEndIndex = node.totalEventCount;
    for (let segmentIndex = node.segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
      const reference = node.segments[segmentIndex];
      const segmentStartIndex = segmentEndIndex - reference.eventCount;
      if (segmentStartIndex < node.startEventIndex) {
        throw new Error(`运行历史节点 ${nodeHash} 的事件分段序号不连续`);
      }
      const decoded = decodeCompressedV8<unknown>(
        readReferencedRunStateChunk(readChunk, reference.hash, '运行状态事件分段'),
        RUN_STATE_EVENT_SEGMENT_CODEC,
        '运行状态事件分段',
      );
      if (!Array.isArray(decoded) || decoded.length !== reference.eventCount) {
        throw new Error(`运行状态事件分段 ${reference.hash} 的事件数量与历史节点不一致`);
      }
      const segment = decoded as WorldEvent[];
      if (!sawTailSegment) {
        streamedTailEventContentHash = tailEventContentHash(segment);
        tailEventId = segment.at(-1)?.id ?? null;
        sawTailSegment = true;
      }
      countLastStepContentOccurrences(
        segment,
        lastStepGroups,
        ledgerOccurrencesByLastStepHash,
      );

      while (nextPinOffset >= 0
        && requestedColdPins[nextPinOffset] >= segmentStartIndex) {
        const absoluteIndex = requestedColdPins[nextPinOffset];
        if (absoluteIndex >= segmentEndIndex) {
          throw new Error(`bounded decode 未找到 pin 绝对序号 ${absoluteIndex}`);
        }
        pinnedEvents[nextPinOffset] = {
          absoluteIndex,
          event: segment[absoluteIndex - segmentStartIndex],
        };
        nextPinOffset -= 1;
      }

      const retainedStartIndex = Math.max(segmentStartIndex, hotStartIndex);
      if (retainedStartIndex < segmentEndIndex) {
        for (let absoluteIndex = retainedStartIndex;
          absoluteIndex < segmentEndIndex;
          absoluteIndex += 1) {
          hotEvents[absoluteIndex - hotStartIndex] = segment[absoluteIndex - segmentStartIndex];
        }
        filledHotEventCount += segmentEndIndex - retainedStartIndex;
      }
      segmentEndIndex = segmentStartIndex;
    }
    if (segmentEndIndex !== node.startEventIndex) {
      throw new Error(`运行历史节点 ${nodeHash} 的事件分段没有覆盖完整节点`);
    }
    expectedNodeTotal = node.startEventIndex;
    nodeHash = node.parentHash;
  }

  if (expectedNodeTotal !== 0) throw new Error('运行历史节点链缺少前缀');
  if (filledHotEventCount !== hotEventCount) {
    throw new Error('bounded decode 的连续历史热窗口与状态根不一致');
  }
  if (nextPinOffset !== -1) {
    throw new Error(`bounded decode 未找到 pin 绝对序号 ${requestedColdPins[nextPinOffset]}`);
  }
  if (streamedTailEventContentHash !== root.tailEventContentHash
    || (root.eventCount === 0
      ? tailEventId !== null
      : typeof tailEventId !== 'string')) {
    throw new Error('运行状态事件历史与状态根不一致');
  }
  return {
    hotEvents,
    pinnedEvents,
    tailEventId,
    ledgerOccurrencesByLastStepHash,
  };
}

function rebindLastStepToRetainedEvents(
  lastStep: readonly WorldEvent[],
  pinnedEvents: readonly RunStatePinnedEvent[],
  hotEvents: readonly WorldEvent[],
  hotStartIndex: number,
  groups: LastStepContentGroups,
  ledgerOccurrencesByHash: ReadonlyMap<string, number>,
): WorldEvent[] {
  const retainedByContentHash = new Map<string, RunStatePinnedEvent[]>();
  const retain = (retained: RunStatePinnedEvent): void => {
    const candidateHashes = groups.hashesByEventId.get(retained.event.id);
    if (!candidateHashes) return;
    const hash = eventContentHash(retained.event);
    if (!candidateHashes.has(hash)) return;
    const matches = retainedByContentHash.get(hash);
    if (matches) matches.push(retained);
    else retainedByContentHash.set(hash, [retained]);
  };
  for (const pinned of pinnedEvents) retain(pinned);
  for (let index = 0; index < hotEvents.length; index += 1) {
    retain({ absoluteIndex: hotStartIndex + index, event: hotEvents[index] });
  }

  const rebound = [...lastStep];
  for (const [hash, shellIndexes] of groups.shellIndexesByHash) {
    const retained = retainedByContentHash.get(hash);
    const ledgerOccurrenceCount = ledgerOccurrencesByHash.get(hash) ?? 0;
    // A single exact fact is globally unique. Repeated byte-equal facts are
    // rebound only when every occurrence is retained and represented in the
    // shell group; a partial pin cannot impersonate another identical fact.
    if (!retained
      || ledgerOccurrenceCount !== shellIndexes.length
      || retained.length !== shellIndexes.length) {
      continue;
    }
    retained.sort((left, right) => left.absoluteIndex - right.absoluteIndex);
    for (let index = 0; index < shellIndexes.length; index += 1) {
      rebound[shellIndexes[index]] = retained[index].event;
    }
  }
  return rebound;
}

/**
 * Decode a schema-2/3 state while retaining only a continuous hot tail and a
 * small set of cold facts selected by absolute ordinal. The shell is restored
 * independently, then every history node and segment is verified from the head
 * towards genesis with only one node and segment resident at a time. All
 * retained values remain staged until the complete root event count and tail
 * content hash have passed; no partial state is ever returned.
 *
 * This is a dedicated continuation seam. It deliberately does not change the
 * full decoder, public store restore path or worker behavior.
 */
async function decodeSegmentedRunStateBoundedFromShell(
  rootChunk: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
  options: RunStateBoundedDecodeOptions,
  shell: SimulationStateShell,
): Promise<DecodedBoundedRunState> {
  const root = parseRunStateRoot(rootChunk);
  if (root.schemaVersion !== 2 && root.schemaVersion !== 3) {
    throw new Error('bounded decode 只支持带权威尾校验的 schema 2/3 运行状态');
  }
  if (!options || !Number.isSafeInteger(options.hotEventLimit) || options.hotEventLimit < 0) {
    throw new Error('bounded decode 的 hotEventLimit 必须是非负安全整数');
  }

  const hotStartIndex = Math.max(0, root.eventCount - options.hotEventLimit);
  const requestedColdPins = boundedPinnedEventIndexes(
    options.pinnedEventIndexes,
    root.eventCount,
    hotStartIndex,
  );

  if (!shell || typeof shell !== 'object' || !shell.world || typeof shell.world !== 'object') {
    throw new Error('运行状态 shell 内容无效');
  }
  if (Object.prototype.hasOwnProperty.call(shell.world, 'past')) {
    throw new Error('运行状态 shell 非法包含 world.past');
  }
  if (!Array.isArray(shell.lastStep)) throw new Error('运行状态 shell 的 lastStep 内容无效');

  const originalDomainCursor = shell.world.historyCursor;
  if (originalDomainCursor) {
    // The shell omits its old `world.past`, so its former hot length is not
    // available here. This still validates every cursor field that can agree
    // with the authoritative root before the streamed tail id is known.
    assertDomainHistoryCursorMatchesLedger(
      originalDomainCursor,
      root.eventCount,
      originalDomainCursor.tailEventId,
      originalDomainCursor.eventCount - originalDomainCursor.hotStartIndex,
      'bounded decode shell',
    );
  }

  const lastStepGroups = lastStepContentGroups(shell.lastStep);
  const boundedHistory = decodeBoundedRunHistoryReverse(
    root,
    readChunk,
    hotStartIndex,
    requestedColdPins,
    lastStepGroups,
  );
  if (originalDomainCursor) {
    assertDomainHistoryCursorMatchesLedger(
      originalDomainCursor,
      root.eventCount,
      boundedHistory.tailEventId,
      originalDomainCursor.eventCount - originalDomainCursor.hotStartIndex,
      'bounded decode shell',
    );
  }

  const historyCursor: WorldHistoryCursorV1 = {
    version: 1,
    eventCount: root.eventCount,
    hotStartIndex,
    tailEventId: boundedHistory.tailEventId,
  };
  const lastStep = rebindLastStepToRetainedEvents(
    shell.lastStep,
    boundedHistory.pinnedEvents,
    boundedHistory.hotEvents,
    hotStartIndex,
    lastStepGroups,
    boundedHistory.ledgerOccurrencesByLastStepHash,
  );
  return {
    state: {
      ...shell,
      world: {
        ...shell.world,
        historyCursor,
        past: boundedHistory.hotEvents,
      },
      lastStep,
    },
    metadata: root,
    pinnedEvents: boundedHistory.pinnedEvents,
  };
}

/**
 * Generic bounded history decoder. It restores every shell field exactly and
 * therefore remains unsuitable for legacy roots whose observer blobs dominate
 * memory; gameplay continuation uses the closed profile below.
 */
export async function decodeSegmentedRunStateBounded(
  rootChunk: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
  options: RunStateBoundedDecodeOptions,
): Promise<DecodedBoundedRunState> {
  const root = parseRunStateRoot(rootChunk);
  const shell = decodeRunStateShell(root, readChunk);
  return decodeSegmentedRunStateBoundedFromShell(rootChunk, readChunk, options, shell);
}

/**
 * Decode the closed schema-3 gameplay continuation profile. Large observer
 * history is carried opaquely, terminal rule objects are filtered in manifest
 * order, and no staged shell is returned before both shell and history seals
 * have succeeded.
 */
export async function decodeSegmentedRunStateGameplayBounded(
  rootChunkInput: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
  options: RunStateGameplayBoundedDecodeOptions,
): Promise<DecodedBoundedGameplayRunState> {
  const rootChunk = snapshotRunStateChunk(rootChunkInput);
  const root = parseRunStateRoot(rootChunk);
  if (root.schemaVersion !== 3) {
    throw new Error('bounded gameplay decode 只接受 schemaVersion 3 root');
  }
  if (!options
    || !Number.isSafeInteger(options.hotEventLimit)
    || options.hotEventLimit < 0
    || !options.observerAuthority
    || options.observerAuthority.stateHash !== rootChunk.hash) {
    throw new Error('bounded gameplay decode options/observer authority 无效');
  }

  const accumulator = createBoundedGameplayShellAccumulator(options.observerAuthority);
  const receipt = await streamVerifiedSchema3GameplayShell(
    rootChunk,
    readChunk,
    accumulator.visitor,
  );
  assertVerifiedSchema3RunStateShellReceipt(receipt, rootChunk.hash);
  const gameplayShell = accumulator.finish(receipt);
  const { past: _emptyPast, ...world } = gameplayShell.state.world;
  if (_emptyPast.length !== 0) {
    throw new Error('bounded gameplay shell accumulator 非法预装 world.past');
  }
  const shell = {
    ...gameplayShell.state,
    world,
  } as SimulationStateShell;
  const decoded = await decodeSegmentedRunStateBoundedFromShell(
    rootChunk,
    readChunk,
    options,
    shell,
  );
  return {
    ...decoded,
    gameplayShell: Object.freeze({
      sourceArrayLengths: gameplayShell.sourceArrayLengths,
      retainedArrayLengths: gameplayShell.retainedArrayLengths,
    }),
  };
}
