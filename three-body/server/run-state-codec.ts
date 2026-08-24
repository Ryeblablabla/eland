import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { deserialize, serialize } from 'node:v8';
import {
  brotliCompress,
  brotliDecompressSync,
  constants as zlibConstants,
} from 'node:zlib';

import type { SimulationState, WorldEvent } from '../src/game/eland/simulation';
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
const MAX_EVENTS_PER_SEGMENT = 2_048;
/**
 * A positional boundary is deliberately independent of values and evolution
 * outcomes. Append-mostly historical arrays can therefore reuse every full
 * prefix segment while small arrays still have useful member-level reuse.
 */
export const MAX_SHELL_ARRAY_ITEMS_PER_SEGMENT = 64;
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

export interface EncodedRunState {
  root: RunStateChunk;
  parts: RunStateChunk[];
  metadata: RunStateRootMetadata;
}

export interface DecodedRunState {
  state: SimulationState;
  metadata: RunStateRootMetadata;
}

export interface RunStateDecodeOptions {
  /** Benchmark escape hatch; authoritative restore always uses the default. */
  canonicalizeEventIdReferences?: boolean;
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

function asBuffer(data: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(data)
    ? data
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function hashStoredChunk(codec: string, data: Uint8Array): string {
  return createHash('sha256').update(codec).update('\0').update(data).digest('hex');
}

function storedChunk(codec: string, data: Buffer): RunStateChunk {
  return {
    hash: hashStoredChunk(codec, data),
    codec,
    rawSize: data.byteLength,
    data,
  };
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

function tailEventContentHash(events: WorldEvent[]): string | null {
  const event = events.at(-1);
  return event ? eventContentHash(event) : null;
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

async function encodeShellFieldReferences(fields: Record<string, unknown>): Promise<{
  chunks: RunStateChunk[];
  references: RunStateShellFieldReference[];
}> {
  const chunks: RunStateChunk[] = [];
  const references: RunStateShellFieldReference[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (!Array.isArray(value)) {
      const chunk = await compressedV8Chunk(RUN_STATE_SHELL_PART_CODEC, value);
      chunks.push(chunk);
      references.push({ name, kind: 'value', hash: chunk.hash });
      continue;
    }

    const segments: RunStateShellPartReference[] = [];
    for (let offset = 0; offset < value.length; offset += MAX_SHELL_ARRAY_ITEMS_PER_SEGMENT) {
      const segment = value.slice(offset, offset + MAX_SHELL_ARRAY_ITEMS_PER_SEGMENT);
      const chunk = await compressedV8Chunk(RUN_STATE_SHELL_PART_CODEC, segment);
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
  const fields = await encodeShellFieldReferences(groups.fields);
  const worldFields = await encodeShellFieldReferences(groups.worldFields);
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

async function encodeEventSegments(events: WorldEvent[]): Promise<{
  chunks: RunStateChunk[];
  references: RunStateSegmentReference[];
}> {
  const chunks: RunStateChunk[] = [];
  const references: RunStateSegmentReference[] = [];
  for (let offset = 0; offset < events.length; offset += MAX_EVENTS_PER_SEGMENT) {
    const segment = events.slice(offset, offset + MAX_EVENTS_PER_SEGMENT);
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

function validSegmentReferences(value: unknown): value is RunStateSegmentReference[] {
  return Array.isArray(value) && value.every((segment) => segment
    && typeof segment === 'object'
    && validHash((segment as Partial<RunStateSegmentReference>).hash)
    && Number.isSafeInteger((segment as Partial<RunStateSegmentReference>).eventCount)
    && Number((segment as Partial<RunStateSegmentReference>).eventCount) > 0);
}

function validShellPartReferences(value: unknown, expectedLength: number): value is RunStateShellPartReference[] {
  if (!Array.isArray(value)) return false;
  let itemCount = 0;
  for (let index = 0; index < value.length; index += 1) {
    const reference = value[index] as Partial<RunStateShellPartReference> | null;
    if (!reference
      || typeof reference !== 'object'
      || !validHash(reference.hash)
      || !Number.isSafeInteger(reference.itemCount)
      || Number(reference.itemCount) <= 0
      || Number(reference.itemCount) > MAX_SHELL_ARRAY_ITEMS_PER_SEGMENT
      || (index < value.length - 1
        && Number(reference.itemCount) !== MAX_SHELL_ARRAY_ITEMS_PER_SEGMENT)) {
      return false;
    }
    itemCount += Number(reference.itemCount);
  }
  return itemCount === expectedLength
    && (expectedLength === 0) === (value.length === 0);
}

function validShellFieldReferences(value: unknown): value is RunStateShellFieldReference[] {
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
      || !validShellPartReferences(candidate.segments, Number(candidate.length))) {
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
    || !validShellFieldReferences(manifest.fields)
    || !validShellFieldReferences(manifest.worldFields)
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
 * Append reads only the preceding root metadata and encodes the new suffix.
 * Callers that intentionally truncate or rewrite older events must select the
 * replacement path, which starts an independent lineage and encodes all events.
 */
export async function encodeSegmentedRunState(
  state: SimulationState,
  plan: RunStateWritePlan = { mode: 'replace' },
): Promise<EncodedRunState> {
  const events = state.world.past;
  let lineageId: string;
  let previousHeadHash: string | null;
  let startEventIndex: number;
  if (plan.mode === 'append') {
    assertAppendBoundary(state, plan.previous);
    lineageId = plan.previous.lineageId;
    previousHeadHash = plan.previous.historyHeadHash;
    startEventIndex = plan.previous.eventCount;
  } else {
    lineageId = randomUUID();
    previousHeadHash = null;
    startEventIndex = 0;
  }

  const suffix = events.slice(startEventIndex);
  const encodedSegments = await encodeEventSegments(suffix);
  const parts: RunStateChunk[] = [...encodedSegments.chunks];
  let historyHeadHash = previousHeadHash;
  if (suffix.length > 0) {
    const node: RunHistoryNodeMetadata = {
      schemaVersion: 1,
      lineageId,
      parentHash: previousHeadHash,
      startEventIndex,
      eventCount: suffix.length,
      totalEventCount: events.length,
      segments: encodedSegments.references,
    };
    const nodeChunk = storedChunk(RUN_HISTORY_NODE_CODEC, serialize(node));
    parts.push(nodeChunk);
    historyHeadHash = nodeChunk.hash;
  }

  const shell = await encodeSegmentedShell(state);
  parts.unshift(...shell.parts, shell.manifest);
  const metadata: RunStateRootMetadata = {
    schemaVersion: 3,
    shellHash: shell.manifest.hash,
    historyHeadHash,
    lineageId,
    eventCount: events.length,
    tailEventContentHash: tailEventContentHash(events),
  };
  const root = storedChunk(RUN_STATE_ROOT_CODEC, serialize(metadata));
  return { root, parts, metadata };
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
    const node = parseRunHistoryNode(readChunk(nodeHash));
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
  const shellChunk = readChunk(shellHash);
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
      readChunk(partHash),
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
    const node = parseRunHistoryNode(readChunk(nodeHash));
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
  canonicalEventIds?: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.kind === 'value') {
      const value = decodeCompressedV8<unknown>(
        readChunk(field.hash),
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
        readChunk(reference.hash),
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
  canonicalEventIds?: ReadonlyMap<string, string>,
): SimulationStateShell {
  const shellHash = root.shellHash;
  const shellChunk = readChunk(shellHash);
  if (shellChunk.codec === RUN_STATE_SHELL_CODEC) {
    if (root.schemaVersion === 3) {
      throw new Error('运行状态根 schemaVersion 3 必须引用 shell manifest');
    }
    const shell = decodeCompressedV8<SimulationStateShell>(
      shellChunk,
      RUN_STATE_SHELL_CODEC,
      '运行状态 shell',
    );
    if (canonicalEventIds) canonicalizeEventIdReferences(shell, canonicalEventIds);
    return shell;
  }
  if (shellChunk.codec !== RUN_STATE_SHELL_MANIFEST_CODEC) {
    throw new Error(`运行状态 shell ${shellHash} 使用了不支持的编码 ${shellChunk.codec}`);
  }
  if (root.schemaVersion !== 3) {
    throw new Error('旧版运行状态根不得引用 shell manifest');
  }
  const manifest = parseRunStateShellManifest(shellChunk);
  return {
    ...decodeShellFieldReferences(manifest.fields, readChunk, canonicalEventIds),
    world: decodeShellFieldReferences(manifest.worldFields, readChunk, canonicalEventIds),
  } as unknown as SimulationStateShell;
}

/**
 * Replace strings that equal an authoritative event id with the exact string
 * value held by that WorldEvent. Only decoded, mutable container values are
 * changed; keys, prototypes, typed buffers and other opaque objects are kept.
 */
function canonicalizeEventIdReferences(
  value: unknown,
  canonicalEventIds: ReadonlyMap<string, string>,
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
          const canonical = canonicalEventIds.get(child);
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
          const canonical = canonicalEventIds.get(child);
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
          const canonical = canonicalEventIds.get(child);
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
        const canonical = canonicalEventIds.get(child);
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
  options: RunStateDecodeOptions = {},
): Promise<DecodedRunState> {
  const root = parseRunStateRoot(rootChunk);
  const events: WorldEvent[] = [];
  const auditStringPool = new Map<string, string>();
  for (const { node } of orderedHistoryNodes(root, readChunk)) {
    for (const reference of node.segments) {
      const segment = await decodeCompressedV8<unknown>(
        readChunk(reference.hash),
        RUN_STATE_EVENT_SEGMENT_CODEC,
        '运行状态事件分段',
      );
      if (!Array.isArray(segment) || segment.length !== reference.eventCount) {
        throw new Error(`运行状态事件分段 ${reference.hash} 的事件数量与历史节点不一致`);
      }
      const segmentEvents = segment as WorldEvent[];
      internEventHistoryAuditStrings(segmentEvents, auditStringPool);
      events.push(...segmentEvents);
    }
  }
  if (events.length !== root.eventCount
    || (root.schemaVersion >= 2 && tailEventContentHash(events) !== root.tailEventContentHash)) {
    throw new Error('运行状态事件历史与状态根不一致');
  }

  let canonicalEventIds: Map<string, string> | undefined;
  if (options.canonicalizeEventIdReferences !== false) {
    canonicalEventIds = new Map<string, string>();
    for (const event of events) canonicalEventIds.set(event.id, event.id);
  }
  const shell = decodeRunStateShell(root, readChunk, canonicalEventIds);
  if (!shell || typeof shell !== 'object' || !shell.world || typeof shell.world !== 'object') {
    throw new Error('运行状态 shell 内容无效');
  }
  if (Object.prototype.hasOwnProperty.call(shell.world, 'past')) {
    throw new Error('运行状态 shell 非法包含 world.past');
  }

  const lastStepIds = new Set(shell.lastStep.map((event) => event.id));
  const lastStepEventsById = new Map<string, WorldEvent>();
  for (let index = events.length - 1; index >= 0 && lastStepEventsById.size < lastStepIds.size; index -= 1) {
    const event = events[index];
    if (lastStepIds.has(event.id)) lastStepEventsById.set(event.id, event);
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
