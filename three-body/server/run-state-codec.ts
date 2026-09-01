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
 * A positional boundary is deliberately independent of values and evolution
 * outcomes. Append-mostly historical arrays can therefore reuse every full
 * prefix segment while small arrays still have useful member-level reuse.
 */
export const MAX_SHELL_ARRAY_ITEMS_PER_SEGMENT = 64;
const SHELL_PART_ENCODE_CACHE_MAX_ENTRIES = 4_096;
const SHELL_PART_ENCODE_CACHE_MAX_BYTES = 128 * 1_024 * 1_024;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const LINEAGE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const compress = promisify(brotliCompress);

export interface RunStateChunk {
  hash: string;
  codec: string;
  rawSize: number;
  data: Buffer | Uint8Array;
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

/** Shell-independent cursor for appending to an authoritative history root. */
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

export interface EncodedRunState {
  root: RunStateChunk;
  parts: RunStateChunk[];
  metadata: RunStateRootMetadata;
}

export interface EncodedRunHistorySuffix {
  cursor: RunHistoryCursor;
  parts: RunStateChunk[];
}

export interface DecodedRunState {
  state: SimulationState;
  metadata: RunStateRootMetadata;
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

interface EncodedShellFieldGroup {
  chunks: RunStateChunk[];
  references: RunStateShellFieldReference[];
}

const shellPartEncodeCache = new Map<string, ShellPartEncodeCacheEntry>();
let shellPartEncodeCacheBytes = 0;

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

function evictShellPartEncodeCacheToBounds(): void {
  while (shellPartEncodeCache.size > SHELL_PART_ENCODE_CACHE_MAX_ENTRIES
    || shellPartEncodeCacheBytes > SHELL_PART_ENCODE_CACHE_MAX_BYTES) {
    const oldestKey = shellPartEncodeCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) return;
    const entry = shellPartEncodeCache.get(oldestKey);
    shellPartEncodeCache.delete(oldestKey);
    if (entry) shellPartEncodeCacheBytes -= entry.bytes;
  }
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

/** Verify that a full-state append still starts at the previously committed boundary. */
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
  const raw = serialize(value);
  const cacheKey = hashRawV8Chunk(RUN_STATE_SHELL_PART_CODEC, raw);
  const cached = shellPartEncodeCache.get(cacheKey);
  if (cached) {
    shellPartEncodeCache.delete(cacheKey);
    shellPartEncodeCache.set(cacheKey, cached);
    return cached.chunk;
  }

  const data = await compress(raw, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
  });
  const chunk = storedChunk(RUN_STATE_SHELL_PART_CODEC, data);
  if (data.byteLength > SHELL_PART_ENCODE_CACHE_MAX_BYTES) return chunk;

  // Concurrent encodes may have populated the same content while Brotli was
  // pending. Keep cache accounting capped and return the canonical chunk.
  const concurrentlyCached = shellPartEncodeCache.get(cacheKey);
  if (concurrentlyCached) {
    shellPartEncodeCache.delete(cacheKey);
    shellPartEncodeCache.set(cacheKey, concurrentlyCached);
    return concurrentlyCached.chunk;
  }
  shellPartEncodeCache.set(cacheKey, { chunk, bytes: data.byteLength });
  shellPartEncodeCacheBytes += data.byteLength;
  evictShellPartEncodeCacheToBounds();
  return chunk;
}

function shellArrayItemsPerSegment(
  scope: RunStateShellFieldScope,
  fieldName: string,
): number {
  // A terminal project may carry substantially more closed planning history
  // than other shell members. Keeping projects content-addressed one at a time
  // prevents one changed/live project from forcing a 64-project decode peak,
  // while every other collection retains the established positional layout.
  return scope === 'state' && fieldName === 'projects'
    ? 1
    : MAX_SHELL_ARRAY_ITEMS_PER_SEGMENT;
}

async function encodeShellFieldReferences(
  fields: Record<string, unknown>,
  scope: RunStateShellFieldScope,
): Promise<EncodedShellFieldGroup> {
  const chunks: RunStateChunk[] = [];
  const references: RunStateShellFieldReference[] = [];
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
      const chunk = await compressedShellPartV8Chunk(segment);
      chunks.push(chunk);
      segments.push({ hash: chunk.hash, itemCount: segment.length });
    }
    references.push({ name, kind: 'array', length: value.length, segments });
  }
  return { chunks, references };
}

async function encodeSegmentedShell(state: SimulationState): Promise<{
  manifest: RunStateChunk;
  parts: RunStateChunk[];
}> {
  const groups = stateShellFieldGroups(state);
  const fields = await encodeShellFieldReferences(groups.fields, 'state');
  const worldFields = await encodeShellFieldReferences(groups.worldFields, 'world');
  const metadata: RunStateShellManifestMetadata = {
    schemaVersion: 1,
    fields: fields.references,
    worldFields: worldFields.references,
  };
  return {
    manifest: storedChunk(RUN_STATE_SHELL_MANIFEST_CODEC, serialize(metadata)),
    parts: [...fields.chunks, ...worldFields.chunks],
  };
}

async function encodeEventSegments(
  events: readonly WorldEvent[],
): Promise<{
  chunks: RunStateChunk[];
  references: RunStateSegmentReference[];
}> {
  const chunks: RunStateChunk[] = [];
  const references: RunStateSegmentReference[] = [];
  const segmentSize = MAX_EVENTS_PER_SEGMENT;
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
 * Encode newly committed events against the previous verified history cursor.
 * An empty suffix leaves the cursor and ledger unchanged.
 */
export async function encodeRunHistorySuffix(
  previous: RunHistoryCursor,
  suffix: readonly WorldEvent[],
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

  const encodedSegments = await encodeEventSegments(suffix);
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
 * Encode a complete schema-3 root from the full state and its newly committed
 * history suffix.
 */
export async function encodeSegmentedRunStateFromHistorySuffix(
  state: SimulationState,
  previous: RunHistoryCursor,
  suffix: readonly WorldEvent[],
): Promise<EncodedRunState> {
  const history = await encodeRunHistorySuffix(previous, suffix);
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
  const shell = await encodeSegmentedShell(state);
  const metadata: RunStateRootMetadata = {
    schemaVersion: 3,
    shellHash: shell.manifest.hash,
    historyHeadHash: history.cursor.historyHeadHash,
    lineageId: history.cursor.lineageId,
    eventCount: history.cursor.eventCount,
    tailEventContentHash: history.cursor.tailEventContentHash,
  };
  const root = storedChunk(RUN_STATE_ROOT_CODEC, serialize(metadata));
  return {
    root,
    parts: [...shell.parts, shell.manifest, ...history.parts],
    metadata,
  };
}

/**
 * Append reads only the preceding root metadata and encodes the new suffix.
 * Callers that intentionally truncate or rewrite older events must select the
 * replacement path, which starts an independent lineage and encodes all events.
 */
export async function encodeSegmentedRunState(
  state: SimulationState,
  plan: RunStateWritePlan = { mode: 'replace' },
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
    );
  }

  const emptyCursor: RunHistoryCursor = {
    lineageId: randomUUID(),
    historyHeadHash: null,
    eventCount: 0,
    tailEventContentHash: null,
  };
  return encodeSegmentedRunStateFromHistorySuffix(state, emptyCursor, events);
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

/** Decode and verify every referenced shell/node/segment before hydration. */
export async function decodeSegmentedRunState(
  rootChunk: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
): Promise<DecodedRunState> {
  const root = parseRunStateRoot(rootChunk);
  const events: WorldEvent[] = [];
  const auditStringPool = new Map<string, string>();
  const canonicalEventIds = new Map<string, string>();
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
  auditStringPool.clear();
  const compactCanonicalEventIds = compactCanonicalEventIdLookup(canonicalEventIds);
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
  compactCanonicalEventIds.clear();

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
