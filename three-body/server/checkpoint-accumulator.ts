import { createHash } from 'node:crypto';

import type { SimulationState, WorldEvent } from '../src/game/eland/simulation';
import { committedHistoryView } from '../src/game/eland/domain/history';
import {
  checkpointFor,
  type EvolutionCheckpoint,
} from './evolution-artifacts';
import {
  parseRunStateRoot,
  snapshotRunStateChunk,
  streamVerifiedRunHistorySegments,
  streamVerifiedRunHistorySuccessorSegments,
  verifyRunStateSameHistoryShellSuccessor,
  type RunStateChunk,
  type RunStateRootMetadata,
} from './run-state-codec';

/**
 * Persisted scalar fold for `checkpointFor`'s only full-history dependency.
 * This codec is deliberately independent from the evolution stage observer.
 */
export const CHECKPOINT_ACCUMULATOR_CODEC = 'eland-evolution-checkpoint-accumulator-json-v1';
export const CHECKPOINT_ACCUMULATOR_SCHEMA_VERSION = 1 as const;
export const CHECKPOINT_ACCUMULATOR_DOMAIN = 'eland-evolution-checkpoint-decisions-v1' as const;

export const MAX_CHECKPOINT_ACCUMULATOR_STORED_BYTES = 64 * 1_024;
export const MAX_CHECKPOINT_ACCUMULATOR_SEGMENT_EVENTS = 65_536;
export const MAX_CHECKPOINT_ACCUMULATOR_IDENTIFIER_BYTES = 4_096;

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const LINEAGE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type UnknownRecord = Record<string, unknown>;

/**
 * Exact store-selected boundary which owns one accumulator. `month` comes from
 * the exact checkpoint row; the other fields mirror the continuation/root
 * authority selected under the same store CAS.
 */
export interface CheckpointAccumulatorBoundaryV1 {
  readonly runId: string;
  readonly revision: number;
  readonly month: number;
  readonly stateHash: string;
  readonly rootSchemaVersion: 2 | 3;
  readonly shellHash: string;
  readonly historyLineageId: string;
  readonly historyHeadHash: string | null;
  readonly eventCount: number;
  readonly tailEventId: string | null;
  readonly tailEventContentHash: string | null;
}

export interface CheckpointDecisionTotalsV1 {
  readonly ruleDecisions: number;
  readonly modelDecisions: number;
}

export interface CheckpointAccumulatorV1 {
  readonly schemaVersion: 1;
  readonly domain: typeof CHECKPOINT_ACCUMULATOR_DOMAIN;
  readonly boundary: Readonly<CheckpointAccumulatorBoundaryV1>;
  readonly decisions: Readonly<CheckpointDecisionTotalsV1>;
}

export interface CheckpointAccumulatorChunk {
  hash: string;
  codec: string;
  /** Stored-byte length. This v1 codec stores canonical UTF-8 JSON directly. */
  rawSize: number;
  data: Buffer | Uint8Array;
}

export interface CheckpointAccumulatorContentReferenceV1 {
  kind: 'content-hash';
  codec: typeof CHECKPOINT_ACCUMULATOR_CODEC;
  hash: string;
}

export interface CheckpointAccumulatorDecodeExpectationV1 {
  /** Must be selected from the exact continuation bundle by the owning store. */
  reference: Readonly<CheckpointAccumulatorContentReferenceV1>;
  /** Must be selected from the same exact run/root/checkpoint store snapshot. */
  boundary: Readonly<CheckpointAccumulatorBoundaryV1>;
}

export interface EncodedCheckpointAccumulator {
  chunk: Readonly<CheckpointAccumulatorChunk>;
  reference: Readonly<CheckpointAccumulatorContentReferenceV1>;
  accumulator: Readonly<CheckpointAccumulatorV1>;
}

interface DecisionFold {
  nextAbsoluteIndex: number;
  ruleDecisions: number;
  modelDecisions: number;
  lastEventId: string | null;
}

/**
 * Only values produced by a verified root scan, a verified exact successor, or
 * a decoder bound to an externally selected content reference and root
 * boundary may feed `checkpointForVerifiedAccumulator` or be re-encoded.
 *
 * This is process-local misuse resistance, not store authority. The store must
 * still keep its continuation token private and compare the expected boundary
 * and sidecar reference under CAS. A canonical hash proves byte integrity only.
 */
const verifiedAccumulators = new WeakSet<object>();

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

function assertSafeIntegerAtLeast(
  value: unknown,
  minimum: number,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${label} 必须是大于等于 ${minimum} 的安全整数`);
  }
}

function assertBoundedIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} 必须是非空字符串`);
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_CHECKPOINT_ACCUMULATOR_IDENTIFIER_BYTES) {
    throw new Error(`${label} 超过 ${MAX_CHECKPOINT_ACCUMULATOR_IDENTIFIER_BYTES} 字节上限`);
  }
}

function normalizeBoundary(value: unknown, label: string): CheckpointAccumulatorBoundaryV1 {
  assertRecord(value, label);
  assertExactKeys(value, [
    'runId',
    'revision',
    'month',
    'stateHash',
    'rootSchemaVersion',
    'shellHash',
    'historyLineageId',
    'historyHeadHash',
    'eventCount',
    'tailEventId',
    'tailEventContentHash',
  ], label);
  assertBoundedIdentifier(value.runId, `${label}.runId`);
  assertSafeIntegerAtLeast(value.revision, 1, `${label}.revision`);
  assertSafeIntegerAtLeast(value.month, 0, `${label}.month`);
  assertHash(value.stateHash, `${label}.stateHash`);
  if (value.rootSchemaVersion !== 2 && value.rootSchemaVersion !== 3) {
    throw new Error(`${label}.rootSchemaVersion 必须是 2 或 3`);
  }
  assertHash(value.shellHash, `${label}.shellHash`);
  if (typeof value.historyLineageId !== 'string' || !LINEAGE_PATTERN.test(value.historyLineageId)) {
    throw new Error(`${label}.historyLineageId 必须是小写 UUID`);
  }
  assertNullableHash(value.historyHeadHash, `${label}.historyHeadHash`);
  assertSafeIntegerAtLeast(value.eventCount, 0, `${label}.eventCount`);
  if (value.tailEventId !== null) {
    assertBoundedIdentifier(value.tailEventId, `${label}.tailEventId`);
  }
  assertNullableHash(value.tailEventContentHash, `${label}.tailEventContentHash`);
  const empty = value.eventCount === 0;
  if (empty !== (value.historyHeadHash === null)
    || empty !== (value.tailEventId === null)
    || empty !== (value.tailEventContentHash === null)) {
    throw new Error(`${label} 的 eventCount 与 history/tail 边界不一致`);
  }
  return {
    runId: value.runId,
    revision: value.revision,
    month: value.month,
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

function normalizeDecisions(value: unknown, eventCount: number): CheckpointDecisionTotalsV1 {
  assertRecord(value, 'checkpoint accumulator decisions');
  assertExactKeys(value, ['ruleDecisions', 'modelDecisions'], 'checkpoint accumulator decisions');
  assertSafeIntegerAtLeast(value.ruleDecisions, 0, 'checkpoint accumulator decisions.ruleDecisions');
  assertSafeIntegerAtLeast(value.modelDecisions, 0, 'checkpoint accumulator decisions.modelDecisions');
  const decisionCount = value.ruleDecisions + value.modelDecisions;
  if (!Number.isSafeInteger(decisionCount) || decisionCount > eventCount) {
    throw new Error('checkpoint accumulator decision 总数超过 eventCount');
  }
  return {
    ruleDecisions: value.ruleDecisions,
    modelDecisions: value.modelDecisions,
  };
}

function normalizeAccumulator(value: unknown): CheckpointAccumulatorV1 {
  assertRecord(value, 'checkpoint accumulator');
  assertExactKeys(
    value,
    ['schemaVersion', 'domain', 'boundary', 'decisions'],
    'checkpoint accumulator',
  );
  if (value.schemaVersion !== CHECKPOINT_ACCUMULATOR_SCHEMA_VERSION) {
    throw new Error('checkpoint accumulator schemaVersion 无效');
  }
  if (value.domain !== CHECKPOINT_ACCUMULATOR_DOMAIN) {
    throw new Error('checkpoint accumulator domain 无效');
  }
  const boundary = normalizeBoundary(value.boundary, 'checkpoint accumulator boundary');
  return {
    schemaVersion: CHECKPOINT_ACCUMULATOR_SCHEMA_VERSION,
    domain: CHECKPOINT_ACCUMULATOR_DOMAIN,
    boundary,
    decisions: normalizeDecisions(value.decisions, boundary.eventCount),
  };
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value)
    .sort()
    .map((key) => [key, canonicalJsonValue(value[key])]));
}

function canonicalBytes(value: CheckpointAccumulatorV1): Buffer {
  return Buffer.from(JSON.stringify(canonicalJsonValue(value)), 'utf8');
}

function deepFreeze<T>(value: T, visited = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  const object = value as object;
  if (visited.has(object)) return value;
  visited.add(object);
  for (const child of Object.values(object as UnknownRecord)) deepFreeze(child, visited);
  return Object.freeze(value);
}

export function hashCheckpointAccumulatorStoredContent(
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
): Readonly<CheckpointAccumulatorChunk> {
  if (data.byteLength > MAX_CHECKPOINT_ACCUMULATOR_STORED_BYTES) {
    throw new Error(
      `checkpoint accumulator 存储内容超过硬上限 ${MAX_CHECKPOINT_ACCUMULATOR_STORED_BYTES}`,
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

function sameBoundary(
  left: CheckpointAccumulatorBoundaryV1,
  right: CheckpointAccumulatorBoundaryV1,
): boolean {
  return left.runId === right.runId
    && left.revision === right.revision
    && left.month === right.month
    && left.stateHash === right.stateHash
    && left.rootSchemaVersion === right.rootSchemaVersion
    && left.shellHash === right.shellHash
    && left.historyLineageId === right.historyLineageId
    && left.historyHeadHash === right.historyHeadHash
    && left.eventCount === right.eventCount
    && left.tailEventId === right.tailEventId
    && left.tailEventContentHash === right.tailEventContentHash;
}

function assertBoundaryMatchesRoot(
  boundary: CheckpointAccumulatorBoundaryV1,
  rootChunk: Readonly<RunStateChunk>,
  root: RunStateRootMetadata,
  label: string,
): void {
  if (boundary.stateHash !== rootChunk.hash
    || boundary.rootSchemaVersion !== root.schemaVersion
    || boundary.shellHash !== root.shellHash
    || boundary.historyLineageId !== root.lineageId
    || boundary.historyHeadHash !== root.historyHeadHash
    || boundary.eventCount !== root.eventCount
    || boundary.tailEventContentHash !== root.tailEventContentHash) {
    throw new Error(`${label} 与 exact run root 不一致`);
  }
}

function assertBoundaryMatchesState(
  boundary: CheckpointAccumulatorBoundaryV1,
  state: SimulationState,
  label: string,
): void {
  if (state.schemaVersion !== 17) throw new Error(`${label} 只接受 schemaVersion 17 状态`);
  const history = committedHistoryView(state);
  if (state.clock.elapsedMonths !== boundary.month
    || history.eventCount !== boundary.eventCount
    || state.world.historyCursor?.tailEventId !== boundary.tailEventId) {
    throw new Error(`${label} 与当前 state shell 边界不一致`);
  }
}

function assertVerifiedAccumulator(
  value: Readonly<CheckpointAccumulatorV1>,
): asserts value is Readonly<CheckpointAccumulatorV1> {
  if (!value || typeof value !== 'object' || !verifiedAccumulators.has(value as object)) {
    throw new Error('checkpoint accumulator 未经外部权威边界验证');
  }
}

function verifiedAccumulator(
  boundary: CheckpointAccumulatorBoundaryV1,
  fold: DecisionFold,
): Readonly<CheckpointAccumulatorV1> {
  if (fold.nextAbsoluteIndex !== boundary.eventCount
    || fold.lastEventId !== boundary.tailEventId) {
    throw new Error('checkpoint accumulator fold 未精确覆盖 target 绝对边界');
  }
  const accumulator = deepFreeze(normalizeAccumulator({
    schemaVersion: CHECKPOINT_ACCUMULATOR_SCHEMA_VERSION,
    domain: CHECKPOINT_ACCUMULATOR_DOMAIN,
    boundary,
    decisions: {
      ruleDecisions: fold.ruleDecisions,
      modelDecisions: fold.modelDecisions,
    },
  }));
  verifiedAccumulators.add(accumulator);
  return accumulator;
}

function foldDecisionSegment(
  previous: Readonly<DecisionFold>,
  events: readonly WorldEvent[],
  startAbsoluteIndex: number,
): DecisionFold {
  assertSafeIntegerAtLeast(startAbsoluteIndex, 0, 'checkpoint segment startAbsoluteIndex');
  if (startAbsoluteIndex !== previous.nextAbsoluteIndex) {
    const kind = startAbsoluteIndex < previous.nextAbsoluteIndex ? '重复' : '缺口';
    throw new Error(
      `checkpoint accumulator suffix ${kind}：期望绝对序号 ${previous.nextAbsoluteIndex}，实际 ${startAbsoluteIndex}`,
    );
  }
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('checkpoint accumulator suffix segment 必须包含事件');
  }
  if (events.length > MAX_CHECKPOINT_ACCUMULATOR_SEGMENT_EVENTS) {
    throw new Error(
      `checkpoint accumulator suffix segment 超过 ${MAX_CHECKPOINT_ACCUMULATOR_SEGMENT_EVENTS} 事件上限`,
    );
  }
  const nextAbsoluteIndex = previous.nextAbsoluteIndex + events.length;
  if (!Number.isSafeInteger(nextAbsoluteIndex)) {
    throw new Error('checkpoint accumulator 绝对事件序号超出安全整数范围');
  }
  let ruleDecisions = previous.ruleDecisions;
  let modelDecisions = previous.modelDecisions;
  for (let offset = 0; offset < events.length; offset += 1) {
    const event = events[offset] as unknown;
    if (!isRecord(event)) throw new Error(`checkpoint suffix[${offset}] 必须是事件对象`);
    assertBoundedIdentifier(event.id, `checkpoint suffix[${offset}].id`);
    assertBoundedIdentifier(event.kind, `checkpoint suffix[${offset}].kind`);
    if (event.kind !== 'decision') continue;
    if (typeof event.usedModel !== 'boolean') {
      throw new Error(`checkpoint suffix[${offset}].usedModel 必须是布尔值`);
    }
    if (event.usedModel) modelDecisions += 1;
    else ruleDecisions += 1;
    if (!Number.isSafeInteger(ruleDecisions) || !Number.isSafeInteger(modelDecisions)) {
      throw new Error('checkpoint accumulator decision 计数超出安全整数范围');
    }
  }
  return {
    nextAbsoluteIndex,
    ruleDecisions,
    modelDecisions,
    lastEventId: (events.at(-1) as WorldEvent).id,
  };
}

/**
 * Scalar reducer test seam. The returned value is not branded and therefore
 * cannot be encoded or used to construct an authoritative checkpoint.
 */
export function reduceCheckpointDecisionSegmentForTests(
  previous: Readonly<DecisionFold>,
  events: readonly WorldEvent[],
  startAbsoluteIndex: number,
): Readonly<DecisionFold> {
  return Object.freeze(foldDecisionSegment(previous, events, startAbsoluteIndex));
}

export function emptyCheckpointDecisionFoldForTests(): Readonly<DecisionFold> {
  return Object.freeze({
    nextAbsoluteIndex: 0,
    ruleDecisions: 0,
    modelDecisions: 0,
    lastEventId: null,
  });
}

function foldFromAccumulator(previous?: Readonly<CheckpointAccumulatorV1>): DecisionFold {
  if (!previous) {
    return { nextAbsoluteIndex: 0, ruleDecisions: 0, modelDecisions: 0, lastEventId: null };
  }
  assertVerifiedAccumulator(previous);
  return {
    nextAbsoluteIndex: previous.boundary.eventCount,
    ruleDecisions: previous.decisions.ruleDecisions,
    modelDecisions: previous.decisions.modelDecisions,
    lastEventId: previous.boundary.tailEventId,
  };
}

/**
 * One-time genesis/backfill reducer. Every event segment is verified against a
 * content-addressed schema-2/3 history root before the scalar result is
 * returned; the full event array is never retained here.
 */
export async function projectCheckpointAccumulatorFromVerifiedRunRoot(
  state: SimulationState,
  rootChunkInput: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
  expectedBoundaryInput: unknown,
): Promise<Readonly<CheckpointAccumulatorV1>> {
  const boundary = deepFreeze(normalizeBoundary(
    expectedBoundaryInput,
    'checkpoint expected boundary',
  ));
  const rootChunk = snapshotRunStateChunk(rootChunkInput);
  const root = parseRunStateRoot(rootChunk);
  assertBoundaryMatchesRoot(boundary, rootChunk, root, 'checkpoint expected boundary');
  assertBoundaryMatchesState(boundary, state, 'checkpoint expected boundary');

  let fold = foldFromAccumulator();
  const verifiedCursor = await streamVerifiedRunHistorySegments(root, readChunk, (events, position) => {
    fold = foldDecisionSegment(fold, events, position.startEventIndex);
  });
  if (verifiedCursor.eventCount !== boundary.eventCount
    || verifiedCursor.lineageId !== boundary.historyLineageId
    || verifiedCursor.historyHeadHash !== boundary.historyHeadHash
    || verifiedCursor.tailEventContentHash !== boundary.tailEventContentHash) {
    throw new Error('checkpoint accumulator verified cursor 与 expected boundary 不一致');
  }
  assertBoundaryMatchesState(boundary, state, 'checkpoint expected boundary');
  return verifiedAccumulator(boundary, fold);
}

/**
 * Resume only across an exact content-addressed history successor. The visitor
 * mutates private scalar staging; nothing is exposed if a later node, segment,
 * absolute ordinal, or final tail check fails.
 */
export async function projectCheckpointAccumulatorFromVerifiedSuccessor(
  previous: Readonly<CheckpointAccumulatorV1>,
  previousRootChunkInput: RunStateChunk,
  nextState: SimulationState,
  nextRootChunkInput: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
  expectedNextBoundaryInput: unknown,
): Promise<Readonly<CheckpointAccumulatorV1>> {
  assertVerifiedAccumulator(previous);
  const target = deepFreeze(normalizeBoundary(
    expectedNextBoundaryInput,
    'checkpoint successor expected boundary',
  ));
  if (target.runId !== previous.boundary.runId
    || target.historyLineageId !== previous.boundary.historyLineageId
    || target.revision < previous.boundary.revision
    || target.month < previous.boundary.month
    || target.eventCount < previous.boundary.eventCount) {
    throw new Error('checkpoint successor target 不是 source boundary 的单调后继');
  }
  const sameRoot = target.stateHash === previous.boundary.stateHash;
  if (sameRoot) {
    if (target.month !== previous.boundary.month
      || target.shellHash !== previous.boundary.shellHash
      || target.historyHeadHash !== previous.boundary.historyHeadHash
      || target.eventCount !== previous.boundary.eventCount
      || target.tailEventId !== previous.boundary.tailEventId
      || target.tailEventContentHash !== previous.boundary.tailEventContentHash) {
      throw new Error('checkpoint successor 相同 state root 不得改写 shell 或历史边界');
    }
  } else if (target.revision <= previous.boundary.revision
    || target.eventCount < previous.boundary.eventCount) {
    throw new Error('checkpoint successor 新 state root 必须推进 revision 且绝对事件 cursor 不得倒退');
  }

  const previousRootChunk = snapshotRunStateChunk(previousRootChunkInput);
  const nextRootChunk = snapshotRunStateChunk(nextRootChunkInput);
  const previousRoot = parseRunStateRoot(previousRootChunk);
  const nextRoot = parseRunStateRoot(nextRootChunk);
  assertBoundaryMatchesRoot(
    previous.boundary,
    previousRootChunk,
    previousRoot,
    'checkpoint accumulator source boundary',
  );
  assertBoundaryMatchesRoot(target, nextRootChunk, nextRoot, 'checkpoint successor expected boundary');
  assertBoundaryMatchesState(target, nextState, 'checkpoint successor expected boundary');

  let fold = foldFromAccumulator(previous);
  const successor = target.eventCount === previous.boundary.eventCount
    ? verifyRunStateSameHistoryShellSuccessor(previousRootChunk, nextRootChunk)
    : await streamVerifiedRunHistorySuccessorSegments(
      previousRootChunk,
      nextRootChunk,
      readChunk,
      (events, position) => {
        fold = foldDecisionSegment(fold, events, position.startEventIndex);
      },
    );
  if (successor.previousRootHash !== previous.boundary.stateHash
    || successor.nextRootHash !== target.stateHash
    || successor.previous.eventCount !== previous.boundary.eventCount
    || successor.next.eventCount !== target.eventCount
    || successor.suffixEventCount !== target.eventCount - previous.boundary.eventCount
    || successor.next.lineageId !== target.historyLineageId
    || successor.next.historyHeadHash !== target.historyHeadHash
    || successor.next.tailEventContentHash !== target.tailEventContentHash) {
    throw new Error('checkpoint accumulator successor receipt 与 expected boundary 不一致');
  }
  assertBoundaryMatchesState(target, nextState, 'checkpoint successor expected boundary');
  return verifiedAccumulator(target, fold);
}

/** Encode only a module-verified accumulator into owned canonical bytes. */
export function encodeCheckpointAccumulator(
  accumulator: Readonly<CheckpointAccumulatorV1>,
): Readonly<EncodedCheckpointAccumulator> {
  assertVerifiedAccumulator(accumulator);
  const data = canonicalBytes(accumulator);
  if (data.byteLength > MAX_CHECKPOINT_ACCUMULATOR_STORED_BYTES) {
    throw new Error(
      `checkpoint accumulator 存储内容超过硬上限 ${MAX_CHECKPOINT_ACCUMULATOR_STORED_BYTES}`,
    );
  }
  const hash = hashCheckpointAccumulatorStoredContent(CHECKPOINT_ACCUMULATOR_CODEC, data);
  const chunk = ownedChunk(hash, CHECKPOINT_ACCUMULATOR_CODEC, data.byteLength, data);
  const reference = Object.freeze({
    kind: 'content-hash' as const,
    codec: CHECKPOINT_ACCUMULATOR_CODEC,
    hash,
  });
  return Object.freeze({ chunk, reference, accumulator });
}

function normalizeDecodeExpectation(value: unknown): CheckpointAccumulatorDecodeExpectationV1 {
  assertRecord(value, 'checkpoint accumulator decode expectation');
  assertExactKeys(
    value,
    ['reference', 'boundary'],
    'checkpoint accumulator decode expectation',
  );
  assertRecord(value.reference, 'checkpoint accumulator expected reference');
  assertExactKeys(
    value.reference,
    ['kind', 'codec', 'hash'],
    'checkpoint accumulator expected reference',
  );
  if (value.reference.kind !== 'content-hash') {
    throw new Error('checkpoint accumulator 只接受 store-selected content-hash 引用');
  }
  if (value.reference.codec !== CHECKPOINT_ACCUMULATOR_CODEC) {
    throw new Error('checkpoint accumulator expected reference codec 无效');
  }
  assertHash(value.reference.hash, 'checkpoint accumulator expected reference.hash');
  return {
    reference: {
      kind: 'content-hash',
      codec: CHECKPOINT_ACCUMULATOR_CODEC,
      hash: value.reference.hash,
    },
    boundary: normalizeBoundary(value.boundary, 'checkpoint accumulator expected boundary'),
  };
}

/**
 * Verify canonical content bytes only after binding them to the content hash
 * and exact root boundary selected by the owning store. Neither caller bytes
 * nor a caller-computed digest is an authority source by itself.
 */
export function decodeCheckpointAccumulator(
  chunk: CheckpointAccumulatorChunk,
  expectedInput: unknown,
): Readonly<CheckpointAccumulatorV1> {
  const expected = normalizeDecodeExpectation(expectedInput);
  if (!chunk || typeof chunk !== 'object') {
    throw new Error('checkpoint accumulator chunk 必须是对象');
  }
  const claimedHash = chunk.hash;
  const claimedCodec = chunk.codec;
  const claimedSize = chunk.rawSize;
  const suppliedData = chunk.data;
  if (claimedCodec !== expected.reference.codec || claimedHash !== expected.reference.hash) {
    throw new Error('checkpoint accumulator chunk 不属于 store-selected content reference');
  }
  assertHash(claimedHash, 'checkpoint accumulator chunk.hash');
  assertSafeIntegerAtLeast(claimedSize, 1, 'checkpoint accumulator chunk.rawSize');
  if (!(Buffer.isBuffer(suppliedData) || suppliedData instanceof Uint8Array)) {
    throw new Error('checkpoint accumulator chunk.data 必须是字节数组');
  }
  if (suppliedData.byteLength !== claimedSize) {
    throw new Error('checkpoint accumulator chunk 长度与记录不一致');
  }
  if (suppliedData.byteLength > MAX_CHECKPOINT_ACCUMULATOR_STORED_BYTES) {
    throw new Error(
      `checkpoint accumulator 存储内容超过硬上限 ${MAX_CHECKPOINT_ACCUMULATOR_STORED_BYTES}`,
    );
  }
  const data = Buffer.from(suppliedData);
  if (hashCheckpointAccumulatorStoredContent(claimedCodec, data) !== claimedHash) {
    throw new Error(`checkpoint accumulator chunk ${claimedHash} 的 SHA-256 校验失败`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`checkpoint accumulator chunk ${claimedHash} 无法解析`, { cause: error });
  }
  const accumulator = normalizeAccumulator(parsed);
  if (!sameBoundary(accumulator.boundary, expected.boundary)) {
    throw new Error('checkpoint accumulator payload 与 store-selected expected boundary 不一致');
  }
  if (!data.equals(canonicalBytes(accumulator))) {
    throw new Error('checkpoint accumulator payload 不是 canonical 编码');
  }
  const owned = deepFreeze(accumulator);
  verifiedAccumulators.add(owned);
  return owned;
}

/** Take an owned byte snapshot before a future authority flow crosses an await. */
export function snapshotCheckpointAccumulatorChunk(
  chunk: CheckpointAccumulatorChunk,
): Readonly<CheckpointAccumulatorChunk> {
  if (!chunk || typeof chunk !== 'object') {
    throw new Error('checkpoint accumulator chunk 必须是对象');
  }
  const claimedHash = chunk.hash;
  const claimedCodec = chunk.codec;
  const claimedSize = chunk.rawSize;
  const suppliedData = chunk.data;
  return ownedChunk(claimedHash, claimedCodec, claimedSize, suppliedData);
}

/**
 * Produce the same checkpoint snapshot as a genesis `checkpointFor` scan once
 * the caller's store-owned boundary has yielded a verified accumulator.
 */
export function checkpointForVerifiedAccumulator(
  state: SimulationState,
  usage: { inputTokens: number; outputTokens: number },
  accumulator: Readonly<CheckpointAccumulatorV1>,
): EvolutionCheckpoint {
  assertVerifiedAccumulator(accumulator);
  assertBoundaryMatchesState(accumulator.boundary, state, 'checkpoint accumulator');
  return checkpointFor(state, usage, {
    eventCount: accumulator.boundary.eventCount,
    ruleDecisions: accumulator.decisions.ruleDecisions,
    modelDecisions: accumulator.decisions.modelDecisions,
  });
}
