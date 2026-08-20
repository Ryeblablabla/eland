import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { deserialize, serialize } from 'node:v8';
import {
  brotliCompress,
  brotliDecompress,
  constants as zlibConstants,
} from 'node:zlib';

import type { SimulationState, WorldEvent } from '../src/game/eland/simulation';

export const RUN_STATE_ROOT_CODEC = 'eland-run-state-root-v1';
export const RUN_STATE_SHELL_CODEC = 'eland-run-state-shell-v1';
export const RUN_HISTORY_NODE_CODEC = 'eland-run-history-node-v1';
export const RUN_STATE_EVENT_SEGMENT_CODEC = 'eland-run-state-events-v1';
export const RUN_STATE_CODECS = [
  RUN_STATE_ROOT_CODEC,
  RUN_STATE_SHELL_CODEC,
  RUN_HISTORY_NODE_CODEC,
  RUN_STATE_EVENT_SEGMENT_CODEC,
] as const;

const EVENT_CONTENT_DOMAIN = 'eland-run-event-content-v1';
const MAX_EVENTS_PER_SEGMENT = 2_048;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const LINEAGE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);

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
  schemaVersion: 1;
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

export interface EncodedRunState {
  root: RunStateChunk;
  parts: RunStateChunk[];
  metadata: RunStateRootMetadata;
}

export interface DecodedRunState {
  state: SimulationState;
  metadata: RunStateRootMetadata;
}

export interface RunStateReachabilityMemo {
  chunks: Set<string>;
  historyNodes: Set<string>;
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

function eventContentHash(event: WorldEvent): string {
  return createHash('sha256')
    .update(EVENT_CONTENT_DOMAIN)
    .update('\0')
    .update(serialize(event))
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

async function compressedV8Chunk(codec: string, value: unknown): Promise<RunStateChunk> {
  const raw = serialize(value);
  const data = await compress(raw, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
  });
  return storedChunk(codec, data);
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
  if (root.schemaVersion !== 1
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

async function decodeCompressedV8<T>(chunk: RunStateChunk, codec: string, label: string): Promise<T> {
  const compressed = verifiedRunStateChunkData(chunk, codec, label);
  let raw: Buffer;
  try {
    raw = await decompress(compressed);
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

  const shell = await compressedV8Chunk(RUN_STATE_SHELL_CODEC, stateShell(state));
  parts.unshift(shell);
  const metadata: RunStateRootMetadata = {
    schemaVersion: 1,
    shellHash: shell.hash,
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

/** Return every codec-owned chunk reachable from one verified state root. */
export function markReachableRunStateChunks(
  rootChunk: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
  memo: RunStateReachabilityMemo = { chunks: new Set<string>(), historyNodes: new Set<string>() },
): RunStateReachabilityMemo {
  const root = parseRunStateRoot(rootChunk);
  memo.chunks.add(rootChunk.hash);
  memo.chunks.add(root.shellHash);
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

/** Decode and verify every referenced shell/node/segment before hydration. */
export async function decodeSegmentedRunState(
  rootChunk: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
): Promise<DecodedRunState> {
  const root = parseRunStateRoot(rootChunk);
  const shell = await decodeCompressedV8<SimulationStateShell>(
    readChunk(root.shellHash),
    RUN_STATE_SHELL_CODEC,
    '运行状态 shell',
  );
  if (!shell || typeof shell !== 'object' || !shell.world || typeof shell.world !== 'object') {
    throw new Error('运行状态 shell 内容无效');
  }
  if (Object.prototype.hasOwnProperty.call(shell.world, 'past')) {
    throw new Error('运行状态 shell 非法包含 world.past');
  }

  const events: WorldEvent[] = [];
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
      events.push(...segment as WorldEvent[]);
    }
  }
  if (events.length !== root.eventCount || tailEventContentHash(events) !== root.tailEventContentHash) {
    throw new Error('运行状态事件历史与状态根不一致');
  }

  const eventsById = new Map(events.map((event) => [event.id, event]));
  const lastStep = shell.lastStep.map((event) => eventsById.get(event.id) ?? event);
  return {
    state: {
      ...shell,
      world: { ...shell.world, past: events },
      lastStep,
    },
    metadata: root,
  };
}
