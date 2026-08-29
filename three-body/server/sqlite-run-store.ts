import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { isDeepStrictEqual, promisify } from "node:util";
import { deserialize, serialize } from "node:v8";
import {
  brotliCompress,
  brotliDecompress,
  constants as zlibConstants,
} from "node:zlib";

import {
  createSimulation,
  type SimulationState,
  type WorldEvent,
} from "../src/game/eland/simulation";
import type { RetainedLiveSocialEvidenceDescriptor } from "../src/game/eland/domain/live-social-evidence";
import { livingPeople } from "../src/game/eland/domain/state-index";
import {
  type BoundedObserverBoundaryKind,
} from "./bounded-observer-boundary-month-controller";
import {
  materializedObserverMilestoneCount,
} from "./bounded-gameplay-shell";
import {
  CHECKPOINT_ACCUMULATOR_CODEC,
  type CheckpointAccumulatorV1,
} from "./checkpoint-accumulator";
import {
  OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC,
  type ObserverCivilizationHistorySidecarPayloadV1,
} from "./civilization-history-codec";
import type { EvolutionPath, EvolutionReport } from "./evolution-artifacts";
import {
  HISTORY_RETENTION_SIDECAR_CODEC,
  HISTORY_RETENTION_SIDECAR_LEGACY_CODEC,
} from "./history-retention-codec";
import type { HistoryRetentionProjectionResult } from "./history-retention-projection";
import type { NarrativeEnhancementArtifact } from "./narrative-enhancements";
import {
  OBSERVER_DERIVED_HISTORY_SIDECAR_CODEC,
  type ObserverDerivedHistorySidecarPayloadV1,
} from "./observer-derived-history-codec";
import {
  PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC,
} from "./physical-structure-ledger-codec";
import type { PhysicalStructureLedgerProjectionResult } from "./physical-structure-ledger-projection";
import {
  decodeRunContinuationBundle,
  hashRunContinuationStoredContent,
  MAX_RUN_CONTINUATION_HOT_EVENTS,
  RUN_CONTINUATION_BUNDLE_CODEC,
  RUN_CONTINUATION_BUNDLE_SCHEMA_VERSION,
  snapshotRunContinuationBundleChunk,
  type RunContinuationBundleV1,
  type RunContinuationContentHashReferenceV1,
  type RunContinuationObserverMaterializationSourceV1,
} from "./run-continuation-bundle";
import {
  RunAlreadyExistsError,
  RunNotFoundError,
  RunWriteConflictError,
  type PersistedRun,
  type RunStore,
  type RunSummary,
  type SaveRunOptions,
} from "./run-persistence";
import {
  assertRunHistoryBoundaryEventContent,
  decodeSegmentedRunStateGameplayBounded,
  decodeSegmentedRunStateBounded,
  decodeSegmentedRunState,
  encodeSegmentedRunState,
  encodeSegmentedRunStateFromHistorySuffix,
  markReachableRunStateChunks,
  parseRunStateRoot,
  runHistoryCursorFromRootMetadata,
  snapshotRunStateChunk,
  stabilizeCompletedProjectsForRunStateShellReuse,
  streamVerifiedRunHistorySuccessorSegments,
  verifyRunStateSameHistoryShellSuccessor,
  RUN_STATE_CODECS,
  RUN_STATE_ROOT_CODEC,
  type RunHistoryCursor,
  type EncodedRunState,
  type RunStateBoundedDecodeOptions,
  type RunStateChunk,
  type RunStatePinnedEvent,
  type RunStateReachabilityMemo,
  type RunStateRootMetadata,
  type VerifiedRunStateShellReuseIdentity,
} from "./run-state-codec";
import {
  ELAND_DATABASE_FILENAME,
  ELAND_DATABASE_SCHEMA_VERSION,
  sqliteUserVersion,
  withSqliteSchemaTransaction,
} from "./sqlite-schema";
import {
  ARTIFACT_EVOLUTION_PATH,
  ARTIFACT_EVOLUTION_REPORT,
  ARTIFACT_NARRATIVE_ENHANCEMENTS,
  SqliteRunOutputArtifactStore,
} from "./sqlite-run-output-artifact-store";
import {
  RUN_CONTINUATION_SIDECAR_NAMES,
  SqliteBoundedContinuationArtifactMaterialization,
  type BoundedContinuationBootstrapSourceSnapshot,
  type BoundedContinuationRefreshSourceSnapshot,
  type RunContinuationSidecarName,
} from "./sqlite-bounded-continuation-artifact-materialization";
import {
  SqliteBoundedObserverBoundaryPublication,
  type BoundedObserverBoundaryMonthPublishedReceipt,
  type BoundedObserverBoundaryMonthStagingReceipt,
  type ObserverBoundaryPublicationCommit,
  type ObserverBoundaryPublicationFinalization,
  type ObserverBoundaryStagingContext,
} from "./sqlite-bounded-observer-boundary-publication";
import {
  SqliteBoundedNonProjectionPublication,
  type BoundedNonProjectionMonthPublishedReceipt,
  type BoundedNonProjectionMonthStagingReceipt,
  type NonProjectionMonthStagingRecord,
  type NonProjectionPublicationCommit,
  type NonProjectionPublicationFinalization,
  type NonProjectionStagingCandidate,
} from "./sqlite-bounded-nonprojection-publication";

export {
  RunAlreadyExistsError,
  RunNotFoundError,
  RunWriteConflictError,
  type PersistedRun,
  type RunStore,
  type RunSummary,
  type SaveRunOptions,
} from "./run-persistence";
export {
  ELAND_DATABASE_FILENAME,
  ELAND_DATABASE_SCHEMA_VERSION,
} from "./sqlite-schema";
export type {
  BoundedObserverBoundaryMonthPublishedReceipt,
  BoundedObserverBoundaryMonthStagingReceipt,
} from "./sqlite-bounded-observer-boundary-publication";
export type {
  BoundedNonProjectionMonthPublishedReceipt,
  BoundedNonProjectionMonthStagingReceipt,
} from "./sqlite-bounded-nonprojection-publication";

const SQLITE_BUSY_TIMEOUT_MS = 5_000;
/** Batch pruning keeps a 128-checkpoint recovery floor without running global GC every year. */
export const RUN_CHECKPOINT_RETENTION = 128;
export const RUN_CHECKPOINT_PRUNE_THRESHOLD = RUN_CHECKPOINT_RETENTION * 2;

const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const V8_BROTLI_CODEC = "v8-br-v1";
const RUN_CONTINUATION_COLLECTIBLE_CODECS = [
  RUN_CONTINUATION_BUNDLE_CODEC,
  HISTORY_RETENTION_SIDECAR_LEGACY_CODEC,
  HISTORY_RETENTION_SIDECAR_CODEC,
  PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC,
  OBSERVER_DERIVED_HISTORY_SIDECAR_CODEC,
  OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC,
  CHECKPOINT_ACCUMULATOR_CODEC,
] as const;
/** Do not retain an accidentally unbounded encoded shell behind an opaque receipt. */
const MAX_BOUNDED_SUCCESSOR_STAGED_BYTES = 256 * 1_024 * 1_024;
export const DEFAULT_BOUNDED_CONTINUATION_HOT_EVENT_LIMIT = 4_096;

const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);

interface EncodedChunk {
  hash: string;
  codec: string;
  rawSize: number;
  data: Uint8Array;
}

interface RunRow {
  id: string;
  stateHash: string;
  meta: RunSummary;
}

interface ChunkRow {
  hash: string;
  codec: string;
  rawSize: number;
  data: Uint8Array;
}

interface RunContinuationRow {
  runId: string;
  revision: number;
  stateHash: string;
  rootSchemaVersion: number;
  shellHash: string;
  historyLineageId: string;
  historyHeadHash: string | null;
  eventCount: number;
  tailEventId: string | null;
  tailEventContentHash: string | null;
  hotEventLimit: number;
  bundleSchemaVersion: number;
  bundleHash: string;
  updatedAt: string;
}

interface ExactRunCheckpointRow {
  runId: string;
  revision: number;
  month: number;
  stateHash: string;
  createdAt: string;
}

/**
 * Scalar identity retained behind a token after a sidecar has been decoded.
 * The potentially large bytes are re-read and content-hash verified for CAS
 * checks instead of being retained beside the parsed artifact and state.
 */
interface ContinuationChunkIdentity {
  readonly hash: string;
  readonly codec: string;
  readonly rawSize: number;
}

interface BoundedContinuationVerifiedArtifacts {
  readonly retention: Readonly<HistoryRetentionProjectionResult>;
  readonly physical: Readonly<PhysicalStructureLedgerProjectionResult>;
  readonly derivedObserver: Readonly<ObserverDerivedHistorySidecarPayloadV1>;
  readonly civilizationObserver: Readonly<ObserverCivilizationHistorySidecarPayloadV1>;
  readonly checkpoint: Readonly<CheckpointAccumulatorV1>;
}

interface BoundedContinuationTokenRecord {
  readonly runId: string;
  readonly generation: number;
  spent: boolean;
  readonly run: RunRow;
  readonly continuation: RunContinuationRow;
  readonly checkpoint: ExactRunCheckpointRow;
  readonly root: RunStateChunk;
  readonly bundle: Readonly<ContinuationChunkIdentity>;
  readonly observerMaterializationSource?: Readonly<RunContinuationObserverMaterializationSourceV1>;
  readonly observerMaterializationSourceRoot?: RunStateChunk;
  readonly sidecars: Readonly<Record<RunContinuationSidecarName, ContinuationChunkIdentity>>;
  readonly artifacts: Readonly<BoundedContinuationVerifiedArtifacts>;
  /** Opaque, process-local and unique to this run's continuation generation chain. */
  readonly shellReuseAuthority: object;
  readonly shellReuseIdentity?: Readonly<VerifiedRunStateShellReuseIdentity>;
}

interface BoundedContinuationTokenRegistry {
  readonly generationsByRun: Map<string, number>;
  readonly tokens: WeakMap<object, BoundedContinuationTokenRecord>;
  readonly stagedSuccessors: WeakMap<object, BoundedEvolutionSuccessorStagingRecord>;
  readonly stagedNonProjectionMonths: WeakMap<object, BoundedNonProjectionMonthStagingRecord>;
  readonly ownedNonProjectionByRun: Map<string, {
    readonly receipt: object;
    readonly staging: BoundedNonProjectionMonthStagingRecord;
  }>;
  readonly warmNonProjectionByRun: Map<string, WarmBoundedContinuationRecord>;
  readonly publishedNonProjectionMonths: WeakMap<object, BoundedNonProjectionMonthPublishedRecord>;
  readonly stagedObserverBoundaryMonths: WeakMap<object, BoundedObserverBoundaryMonthStagingRecord>;
  readonly publishedObserverBoundaryMonths: WeakMap<object, BoundedObserverBoundaryMonthPublishedRecord>;
  readonly physicalByRun: Map<string, VerifiedPhysicalContinuationCacheRecord>;
}

interface BoundedEvolutionSuccessorStagingRecord {
  readonly sourceToken: object;
  readonly sourceGeneration: number;
  readonly run: RunRow;
  readonly root: RunStateChunk;
  readonly parts: readonly RunStateChunk[];
  readonly metadata: Readonly<RunStateRootMetadata>;
  readonly suffixEventCount: number;
  readonly historyTransition: "appended-events" | "same-history-shell";
  readonly shellReuseIdentity?: Readonly<VerifiedRunStateShellReuseIdentity>;
}

type BoundedNonProjectionMonthStagingRecord = NonProjectionMonthStagingRecord;

interface WarmBoundedContinuationRecord {
  readonly runId: string;
  readonly generation: number;
  readonly revision: number;
  readonly stateHash: string;
  readonly token: BoundedEvolutionContinuationToken;
  readonly state: SimulationState;
}

interface BoundedObserverBoundaryMonthStagingRecord {
  readonly sourceToken: object;
  readonly sourceGeneration: number;
  readonly runId: string;
  readonly sourceMonth: number;
  readonly targetMonth: number;
  readonly boundaryKind: BoundedObserverBoundaryKind;
  readonly factSuccessorReceipt: object;
  /** Body-free source descriptors captured before the owned boundary step changes history base. */
  readonly reusableLiveSocialDescriptors: readonly RetainedLiveSocialEvidenceDescriptor[];
}

interface VerifiedPhysicalContinuationCacheRecord {
  readonly runId: string;
  readonly revision: number;
  readonly stateHash: string;
  readonly sidecar: Readonly<ContinuationChunkIdentity>;
  readonly projection: Readonly<PhysicalStructureLedgerProjectionResult>;
}

interface BoundedNonProjectionMonthPublishedRecord {
  readonly runId: string;
  readonly revision: number;
  readonly month: number;
  readonly stateHash: string;
}

interface BoundedObserverBoundaryMonthPublishedRecord {
  readonly runId: string;
  readonly revision: number;
  readonly month: number;
  readonly stateHash: string;
  readonly stage: string;
  readonly boundaryKind: BoundedObserverBoundaryKind;
  readonly status: SimulationState["civilization"]["status"];
}

const boundedContinuationTokenRegistries = new WeakMap<object, BoundedContinuationTokenRegistry>();
/** Module-private capability; a runtime caller cannot forge it with a string flag. */
const storeOwnedSingleMonthSuccessorAuthority = Object.freeze({});

declare const boundedEvolutionContinuationTokenBrand: unique symbol;
declare const boundedEvolutionSuccessorStagingReceiptBrand: unique symbol;
declare const boundedEvolutionContinuationBootstrapReceiptBrand: unique symbol;
declare const boundedEvolutionContinuationRefreshReceiptBrand: unique symbol;

/**
 * Non-authoritative acknowledgement for a one-time persisted bootstrap. It is
 * deliberately not accepted by any evolution or publication API and exposes
 * neither the bounded state nor any sidecar bytes.
 */
export interface BoundedEvolutionContinuationBootstrapReceipt {
  readonly kind: "bounded-evolution-continuation-bootstrap-receipt-v1";
  readonly persisted: true;
  readonly continuationReady: false;
  readonly [boundedEvolutionContinuationBootstrapReceiptBrand]: true;
}

/** Non-authoritative acknowledgement that sidecars were rebuilt for one exact root. */
export interface BoundedEvolutionContinuationRefreshReceipt {
  readonly kind: "bounded-evolution-continuation-refresh-receipt-v1";
  readonly persisted: true;
  readonly continuationReady: false;
  readonly [boundedEvolutionContinuationRefreshReceiptBrand]: true;
}

/** Store-owned authority handle. Its structural fields never establish authenticity. */
export interface BoundedEvolutionContinuationToken {
  readonly kind: "bounded-evolution-continuation-token-v1";
  readonly continuationReady: false;
  readonly [boundedEvolutionContinuationTokenBrand]: true;
}

/**
 * Opaque in-memory staging handle. It is neither persisted nor accepted as
 * publication authority, and it does not consume its source token.
 */
export interface BoundedEvolutionSuccessorStagingReceipt {
  readonly kind: "bounded-evolution-successor-staging-receipt-v1";
  readonly persisted: false;
  readonly continuationReady: false;
  readonly [boundedEvolutionSuccessorStagingReceiptBrand]: true;
}

export interface SqliteRunStoreOptions {
  /** Open an existing database without creating files, tables, or WAL sidecars. */
  readOnly?: boolean;
}

/** Immutable CAS/read basis for the dedicated bounded evolution path. */
export interface EvolutionRunBasis {
  readonly runId: string;
  readonly revision: number;
  readonly stateHash: string;
  readonly history: Readonly<RunHistoryCursor>;
}

export interface LoadedEvolutionRun extends PersistedRun {
  /** Cold facts requested by absolute ordinal; never merged into `world.past`. */
  pinnedEvents: RunStatePinnedEvent[];
  basis: EvolutionRunBasis;
}

export interface PersistedEvolutionSave extends PersistedRun {
  basis: EvolutionRunBasis;
}

export interface OpenedBoundedEvolutionContinuation extends LoadedEvolutionRun {
  /** Remains false until the bounded controller and every sidecar commit path are closed. */
  readonly continuationReady: false;
  readonly continuationToken: BoundedEvolutionContinuationToken;
}

function normalizeId(value?: string): string {
  if (!value) {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    return `run-${stamp}-${randomUUID().slice(0, 8)}`;
  }
  if (!RUN_ID_PATTERN.test(value)) throw new Error("运行 id 仅支持 1-64 位字母、数字、下划线或连字符");
  return value;
}

function summaryFor(
  id: string,
  state: SimulationState,
  authoritativeEventCount: number,
  previous?: RunSummary,
  label?: string,
): RunSummary {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id,
    ...(label?.trim()
      ? { label: label.trim().slice(0, 100) }
      : previous?.label
        ? { label: previous.label }
        : {}),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    revision: previous ? previous.revision + 1 : 1,
    elapsedMonths: state.clock.elapsedMonths,
    civilizationNo: state.civilization.number,
    status: state.civilization.status,
    livingAgents: livingPeople(state).length,
    agentCount: state.people.length,
    eventCount: authoritativeEventCount,
    milestoneCount: materializedObserverMilestoneCount(state),
  };
}

function migrated(input: SimulationState): SimulationState {
  return createSimulation({ state: input }).getState();
}

async function encodeValue(value: unknown): Promise<EncodedChunk> {
  const raw = serialize(value);
  const data = await compress(raw, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
    },
  });
  return {
    hash: createHash("sha256").update(raw).digest("hex"),
    codec: V8_BROTLI_CODEC,
    rawSize: raw.byteLength,
    data,
  };
}

async function decodeValue<T>(chunk: ChunkRow): Promise<T> {
  if (chunk.codec !== V8_BROTLI_CODEC) {
    throw new Error(`不支持的运行数据编码：${chunk.codec}`);
  }
  const raw = await decompress(Buffer.from(chunk.data));
  if (raw.byteLength !== chunk.rawSize) throw new Error("运行数据解压后的长度与记录不一致");
  const actualHash = createHash("sha256").update(raw).digest("hex");
  if (actualHash !== chunk.hash) throw new Error(`运行数据块 ${chunk.hash} 的 SHA-256 校验失败`);
  return deserialize(raw) as T;
}

function parseRunRow(row: Record<string, unknown> | undefined): RunRow | null {
  if (!row) return null;
  return {
    id: String(row.id),
    stateHash: String(row.state_hash),
    meta: {
      schemaVersion: Number(row.schema_version) as 1,
      id: String(row.id),
      ...(row.label == null ? {} : { label: String(row.label) }),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      revision: Number(row.revision),
      elapsedMonths: Number(row.elapsed_months),
      civilizationNo: Number(row.civilization_no),
      status: String(row.status) as SimulationState["civilization"]["status"],
      livingAgents: Number(row.living_agents),
      agentCount: Number(row.agent_count),
      eventCount: Number(row.event_count),
      milestoneCount: Number(row.milestone_count),
    },
  };
}

function parseChunkRow(row: Record<string, unknown> | undefined): ChunkRow | null {
  if (!row) return null;
  const data = row.data;
  if (!(data instanceof Uint8Array)) throw new Error("运行数据块不是有效的二进制内容");
  return {
    hash: String(row.hash),
    codec: String(row.codec),
    rawSize: Number(row.raw_size),
    data,
  };
}

function parseRunContinuationRow(
  row: Record<string, unknown> | undefined,
): RunContinuationRow | null {
  if (!row) return null;
  return {
    runId: String(row.run_id),
    revision: Number(row.revision),
    stateHash: String(row.state_hash),
    rootSchemaVersion: Number(row.root_schema_version),
    shellHash: String(row.shell_hash),
    historyLineageId: String(row.history_lineage_id),
    historyHeadHash: row.history_head_hash == null ? null : String(row.history_head_hash),
    eventCount: Number(row.event_count),
    tailEventId: row.tail_event_id == null ? null : String(row.tail_event_id),
    tailEventContentHash: row.tail_event_content_hash == null
      ? null
      : String(row.tail_event_content_hash),
    hotEventLimit: Number(row.hot_event_limit),
    bundleSchemaVersion: Number(row.bundle_schema_version),
    bundleHash: String(row.bundle_hash),
    updatedAt: String(row.updated_at),
  };
}

function parseExactRunCheckpointRow(
  row: Record<string, unknown> | undefined,
): ExactRunCheckpointRow | null {
  if (!row) return null;
  return {
    runId: String(row.run_id),
    revision: Number(row.revision),
    month: Number(row.month),
    stateHash: String(row.state_hash),
    createdAt: String(row.created_at),
  };
}

function runColumnValues(meta: RunSummary): Array<string | number | null> {
  return [
    meta.schemaVersion,
    meta.label ?? null,
    meta.createdAt,
    meta.updatedAt,
    meta.revision,
    meta.elapsedMonths,
    meta.civilizationNo,
    meta.status,
    meta.livingAgents,
    meta.agentCount,
    meta.eventCount,
    meta.milestoneCount,
  ];
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && Buffer.from(left.buffer, left.byteOffset, left.byteLength)
      .equals(Buffer.from(right.buffer, right.byteOffset, right.byteLength));
}

function sameRunRow(left: RunRow, right: RunRow): boolean {
  return left.id === right.id
    && left.stateHash === right.stateHash
    && left.meta.schemaVersion === right.meta.schemaVersion
    && left.meta.id === right.meta.id
    && left.meta.label === right.meta.label
    && left.meta.createdAt === right.meta.createdAt
    && left.meta.updatedAt === right.meta.updatedAt
    && left.meta.revision === right.meta.revision
    && left.meta.elapsedMonths === right.meta.elapsedMonths
    && left.meta.civilizationNo === right.meta.civilizationNo
    && left.meta.status === right.meta.status
    && left.meta.livingAgents === right.meta.livingAgents
    && left.meta.agentCount === right.meta.agentCount
    && left.meta.eventCount === right.meta.eventCount
    && left.meta.milestoneCount === right.meta.milestoneCount;
}

function sameRunContinuationRow(
  left: RunContinuationRow,
  right: RunContinuationRow,
): boolean {
  return left.runId === right.runId
    && left.revision === right.revision
    && left.stateHash === right.stateHash
    && left.rootSchemaVersion === right.rootSchemaVersion
    && left.shellHash === right.shellHash
    && left.historyLineageId === right.historyLineageId
    && left.historyHeadHash === right.historyHeadHash
    && left.eventCount === right.eventCount
    && left.tailEventId === right.tailEventId
    && left.tailEventContentHash === right.tailEventContentHash
    && left.hotEventLimit === right.hotEventLimit
    && left.bundleSchemaVersion === right.bundleSchemaVersion
    && left.bundleHash === right.bundleHash
    && left.updatedAt === right.updatedAt;
}

function sameExactRunCheckpointRow(
  left: ExactRunCheckpointRow,
  right: ExactRunCheckpointRow,
): boolean {
  return left.runId === right.runId
    && left.revision === right.revision
    && left.month === right.month
    && left.stateHash === right.stateHash
    && left.createdAt === right.createdAt;
}

function snapshotContinuationChunkIdentity(chunk: ChunkRow): ContinuationChunkIdentity {
  if (chunk.rawSize !== chunk.data.byteLength) {
    throw new Error(`continuation sidecar ${chunk.hash} 长度与记录不一致`);
  }
  if (hashRunContinuationStoredContent(chunk.codec, chunk.data) !== chunk.hash) {
    throw new Error(`continuation sidecar ${chunk.hash} 内容哈希校验失败`);
  }
  return Object.freeze({
    hash: chunk.hash,
    codec: chunk.codec,
    rawSize: chunk.rawSize,
  });
}

function sameContinuationChunkIdentity(
  identity: Readonly<ContinuationChunkIdentity>,
  current: ChunkRow,
): boolean {
  return identity.hash === current.hash
    && identity.codec === current.codec
    && identity.rawSize === current.rawSize
    && current.rawSize === current.data.byteLength
    && hashRunContinuationStoredContent(current.codec, current.data) === current.hash;
}

function sameChunkSnapshot(
  snapshot: {
    readonly hash: string;
    readonly codec: string;
    readonly rawSize: number;
    readonly data: Buffer | Uint8Array;
  },
  current: ChunkRow,
): boolean {
  return snapshot.hash === current.hash
    && snapshot.codec === current.codec
    && snapshot.rawSize === current.rawSize
    && sameBytes(snapshot.data, current.data);
}

function assertContinuationAuthority(
  run: RunRow,
  continuation: RunContinuationRow,
  checkpoint: ExactRunCheckpointRow,
  root: RunStateChunk,
  rootMetadata: RunStateRootMetadata,
  bundle: Readonly<RunContinuationBundleV1>,
): void {
  const authority = bundle.authority;
  if (continuation.runId !== run.id
    || continuation.revision !== run.meta.revision
    || continuation.stateHash !== run.stateHash
    || continuation.eventCount !== run.meta.eventCount) {
    throw new Error(`运行 ${run.id} 的 continuation 行不属于当前 run authority`);
  }
  if (checkpoint.runId !== run.id
    || checkpoint.revision !== run.meta.revision
    || checkpoint.stateHash !== run.stateHash
    || checkpoint.month !== run.meta.elapsedMonths) {
    throw new Error(`运行 ${run.id} 的 exact checkpoint 与当前 run authority 不一致`);
  }
  if (root.hash !== run.stateHash
    || continuation.rootSchemaVersion !== rootMetadata.schemaVersion
    || continuation.shellHash !== rootMetadata.shellHash
    || continuation.historyLineageId !== rootMetadata.lineageId
    || continuation.historyHeadHash !== rootMetadata.historyHeadHash
    || continuation.eventCount !== rootMetadata.eventCount
    || continuation.tailEventContentHash !== rootMetadata.tailEventContentHash) {
    throw new Error(`运行 ${run.id} 的 continuation 行与 exact state root 不一致`);
  }
  if (continuation.bundleSchemaVersion !== RUN_CONTINUATION_BUNDLE_SCHEMA_VERSION
    || continuation.bundleHash.length === 0
    || continuation.runId !== authority.runId
    || continuation.revision !== authority.revision
    || continuation.stateHash !== authority.stateHash
    || continuation.rootSchemaVersion !== authority.rootSchemaVersion
    || continuation.shellHash !== authority.shellHash
    || continuation.historyLineageId !== authority.historyLineageId
    || continuation.historyHeadHash !== authority.historyHeadHash
    || continuation.eventCount !== authority.eventCount
    || continuation.tailEventId !== authority.tailEventId
    || continuation.tailEventContentHash !== authority.tailEventContentHash
    || continuation.hotEventLimit !== bundle.hotEventLimit) {
    throw new Error(`运行 ${run.id} 的 continuation bundle 与 authority 行不一致`);
  }
}

function contentHashReferenceFor(
  reference: RunContinuationBundleV1["sidecars"][RunContinuationSidecarName],
  runId: string,
  name: RunContinuationSidecarName,
): Readonly<RunContinuationContentHashReferenceV1> {
  if (reference.kind !== "content-hash") {
    throw new Error(
      `运行 ${runId} 的 continuation sidecar ${name}`
      + " 只有 canonical digest，store 无法验证其 codec 与 bytes",
    );
  }
  return reference;
}

function assertRetentionPinsMatchBundle(
  runId: string,
  projection: Readonly<HistoryRetentionProjectionResult>,
  bundle: Readonly<RunContinuationBundleV1>,
): void {
  const projectedColdPins = projection.pins.filter(
    (pin) => pin.absoluteIndex < bundle.hotStartIndex,
  );
  if (projectedColdPins.length !== bundle.coldPins.length) {
    throw new Error(`运行 ${runId} 的 retention pins 与 bundle coldPins 数量不一致`);
  }
  for (let index = 0; index < bundle.coldPins.length; index += 1) {
    const expected = bundle.coldPins[index];
    const actual = projectedColdPins[index];
    if (!actual
      || actual.absoluteIndex !== expected.absoluteIndex
      || actual.eventId !== expected.eventId
      || actual.leaseKeys.length !== expected.leaseKeys.length
      || actual.leaseKeys.some((leaseKey, offset) => leaseKey !== expected.leaseKeys[offset])) {
      throw new Error(
        `运行 ${runId} 的 retention pin ${expected.absoluteIndex} 与 bundle coldPins/leaseKeys 不一致`,
      );
    }
  }
}

function assertDecodedRunSummary(run: RunRow, state: SimulationState): void {
  const livingAgents = livingPeople(state).length;
  if (state.clock.elapsedMonths !== run.meta.elapsedMonths
    || state.civilization.number !== run.meta.civilizationNo
    || state.civilization.status !== run.meta.status
    || livingAgents !== run.meta.livingAgents
    || state.people.length !== run.meta.agentCount
    || materializedObserverMilestoneCount(state) !== run.meta.milestoneCount) {
    throw new Error(`运行 ${run.id} 的 decoded shell 与当前 run summary 不一致`);
  }
}

function sameHistoryCursor(
  left: Readonly<RunHistoryCursor>,
  right: Readonly<RunHistoryCursor>,
): boolean {
  return left.lineageId === right.lineageId
    && left.historyHeadHash === right.historyHeadHash
    && left.eventCount === right.eventCount
    && left.tailEventContentHash === right.tailEventContentHash;
}

function stagedHistoryTransitionMatchesSource(
  sourceRoot: Readonly<RunStateRootMetadata>,
  successor: Readonly<BoundedEvolutionSuccessorStagingRecord>,
): boolean {
  const sourceCursor = runHistoryCursorFromRootMetadata(sourceRoot);
  const nextCursor = runHistoryCursorFromRootMetadata(successor.metadata);
  const eventDelta = nextCursor.eventCount - sourceCursor.eventCount;
  if (successor.suffixEventCount !== eventDelta || eventDelta < 0) return false;
  if (eventDelta === 0) {
    return successor.historyTransition === "same-history-shell"
      && sourceRoot.shellHash !== successor.metadata.shellHash
      && sameHistoryCursor(sourceCursor, nextCursor);
  }
  return successor.historyTransition === "appended-events";
}

function evolutionBasisFor(
  row: RunRow,
  metadata: RunStateRootMetadata,
): EvolutionRunBasis {
  const history = Object.freeze({ ...runHistoryCursorFromRootMetadata(metadata) });
  return Object.freeze({
    runId: row.id,
    revision: row.meta.revision,
    stateHash: row.stateHash,
    history,
  });
}

function historySuffixFromBoundedState(
  state: SimulationState,
  basis: EvolutionRunBasis,
): readonly WorldEvent[] {
  const cursor = state.world.historyCursor;
  if (!cursor
    || cursor.version !== 1
    || !Number.isSafeInteger(cursor.eventCount)
    || cursor.eventCount < 0
    || !Number.isSafeInteger(cursor.hotStartIndex)
    || cursor.hotStartIndex < 0
    || cursor.hotStartIndex > cursor.eventCount
    || (cursor.eventCount === 0
      ? cursor.tailEventId !== null
      : typeof cursor.tailEventId !== "string")) {
    throw new Error("bounded evolution 状态缺少有效的绝对 history cursor");
  }

  const hotEventCount = cursor.eventCount - cursor.hotStartIndex;
  if (state.world.past.length !== hotEventCount) {
    throw new Error("bounded evolution 状态的热窗口与绝对 history cursor 不一致");
  }
  const localTail = state.world.past.at(-1);
  if (localTail && localTail.id !== cursor.tailEventId) {
    throw new Error("bounded evolution 状态的热窗口末事件与绝对 history cursor 不一致");
  }
  if (cursor.hotStartIndex > basis.history.eventCount) {
    throw new Error(
      `运行 ${basis.runId} 的未持久化历史已被裁出热窗口：hotStartIndex ${cursor.hotStartIndex}`
      + ` 超过 basis eventCount ${basis.history.eventCount}`,
    );
  }

  const suffixOffset = basis.history.eventCount - cursor.hotStartIndex;
  if (!Number.isSafeInteger(suffixOffset)
    || suffixOffset < 0
    || suffixOffset > state.world.past.length) {
    throw new Error("bounded evolution 状态无法从 basis 换算出连续历史 suffix");
  }
  if (suffixOffset > 0) {
    const boundary = state.world.past[suffixOffset - 1];
    if (!boundary) throw new Error("bounded evolution 状态缺少 basis 尾边界事实");
    assertRunHistoryBoundaryEventContent(
      boundary,
      basis.history.tailEventContentHash,
    );
  }
  const suffix = state.world.past.slice(suffixOffset);
  if (cursor.eventCount !== basis.history.eventCount + suffix.length) {
    throw new Error("bounded evolution 状态的历史 suffix 与绝对事件总数不连续");
  }
  return suffix;
}

/** SQLite-backed run persistence using content-addressed V8+Brotli chunks. */
export class SqliteRunStore implements RunStore {
  private readonly database: DatabaseSync;
  private readonly databaseFile: string;
  private readonly selectRun: StatementSync;
  private readonly selectChunk: StatementSync;
  private readonly selectRunContinuation: StatementSync;
  private readonly selectExactRunCheckpoint: StatementSync;
  private readonly insertChunk: StatementSync;
  private readonly insertRun: StatementSync;
  private readonly updateRun: StatementSync;
  private readonly insertCheckpoint: StatementSync;
  private readonly insertRunContinuation: StatementSync;
  private readonly updateRunContinuationCas: StatementSync;
  private readonly outputArtifacts: SqliteRunOutputArtifactStore;
  private readonly continuationArtifactMaterialization:
    SqliteBoundedContinuationArtifactMaterialization;
  private readonly observerBoundaryPublication: SqliteBoundedObserverBoundaryPublication;
  private readonly nonProjectionPublication: SqliteBoundedNonProjectionPublication;
  private readonly readOnly: boolean;
  private failNextBoundedPublicationAfterChunkWrites = false;
  private readonly boundedGameplayDecodePhaseCounts = {
    continuationOpen: 0,
    nonProjectionPublish: 0,
  };
  private closed = false;

  constructor(private readonly rootDir: string, options: SqliteRunStoreOptions = {}) {
    this.readOnly = options.readOnly === true;
    if (!this.readOnly) mkdirSync(rootDir, { recursive: true });
    this.databaseFile = path.join(rootDir, ELAND_DATABASE_FILENAME);
    this.database = new DatabaseSync(this.databaseFile, { readOnly: this.readOnly });
    this.database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    const currentSchemaVersion = sqliteUserVersion(this.database);
    if (currentSchemaVersion > ELAND_DATABASE_SCHEMA_VERSION) {
      this.database.close();
      throw new Error(`SQLite 数据库版本 ${currentSchemaVersion} 高于当前支持的 ${ELAND_DATABASE_SCHEMA_VERSION}`);
    }
    if (this.readOnly && currentSchemaVersion !== ELAND_DATABASE_SCHEMA_VERSION) {
      this.database.close();
      throw new Error(`只读 SQLite 数据库版本 ${currentSchemaVersion} 不受支持`);
    }
    if (!this.readOnly) {
      this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec("PRAGMA foreign_keys = ON");
      this.database.exec("PRAGMA synchronous = NORMAL");
      withSqliteSchemaTransaction(this.database, (lockedSchemaVersion) => {
        if (lockedSchemaVersion > ELAND_DATABASE_SCHEMA_VERSION) {
          throw new Error(
            `SQLite 数据库版本 ${lockedSchemaVersion} 高于当前支持的 ${ELAND_DATABASE_SCHEMA_VERSION}`,
          );
        }
        this.database.exec(`
        CREATE TABLE IF NOT EXISTS chunks (
          hash TEXT PRIMARY KEY,
          codec TEXT NOT NULL,
          raw_size INTEGER NOT NULL CHECK (raw_size >= 0),
          data BLOB NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          state_hash TEXT NOT NULL REFERENCES chunks(hash),
          schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          label TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          elapsed_months INTEGER NOT NULL CHECK (elapsed_months >= 0),
          civilization_no INTEGER NOT NULL CHECK (civilization_no >= 1),
          status TEXT NOT NULL,
          living_agents INTEGER NOT NULL CHECK (living_agents >= 0),
          agent_count INTEGER NOT NULL CHECK (agent_count >= 0),
          event_count INTEGER NOT NULL CHECK (event_count >= 0),
          milestone_count INTEGER NOT NULL CHECK (milestone_count >= 0)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS runs_by_state_hash
          ON runs(state_hash);

        CREATE TABLE IF NOT EXISTS run_checkpoints (
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          month INTEGER NOT NULL CHECK (month >= 0),
          state_hash TEXT NOT NULL REFERENCES chunks(hash),
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, revision)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS run_checkpoints_by_month
          ON run_checkpoints(run_id, month, revision);

        CREATE INDEX IF NOT EXISTS run_checkpoints_by_state_hash
          ON run_checkpoints(state_hash);

        CREATE TABLE IF NOT EXISTS artifacts (
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN (
            '${ARTIFACT_EVOLUTION_PATH}',
            '${ARTIFACT_EVOLUTION_REPORT}',
            '${ARTIFACT_NARRATIVE_ENHANCEMENTS}'
          )),
          chunk_hash TEXT NOT NULL REFERENCES chunks(hash),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (run_id, kind)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS artifacts_by_chunk_hash
          ON artifacts(chunk_hash);

        CREATE UNIQUE INDEX IF NOT EXISTS run_checkpoints_exact
          ON run_checkpoints(run_id, revision, state_hash);

        CREATE TABLE IF NOT EXISTS run_continuations (
          run_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          state_hash TEXT NOT NULL,
          root_schema_version INTEGER NOT NULL CHECK (root_schema_version IN (2, 3)),
          shell_hash TEXT NOT NULL REFERENCES chunks(hash),
          history_lineage_id TEXT NOT NULL,
          history_head_hash TEXT REFERENCES chunks(hash),
          event_count INTEGER NOT NULL CHECK (event_count >= 0),
          tail_event_id TEXT,
          tail_event_content_hash TEXT,
          hot_event_limit INTEGER NOT NULL CHECK (hot_event_limit >= 0),
          bundle_schema_version INTEGER NOT NULL CHECK (bundle_schema_version = 1),
          bundle_hash TEXT NOT NULL REFERENCES chunks(hash),
          updated_at TEXT NOT NULL,
          FOREIGN KEY (run_id, revision, state_hash)
            REFERENCES run_checkpoints(run_id, revision, state_hash)
            ON DELETE CASCADE,
          CHECK (
            (event_count = 0
              AND history_head_hash IS NULL
              AND tail_event_id IS NULL
              AND tail_event_content_hash IS NULL)
            OR
            (event_count > 0
              AND history_head_hash IS NOT NULL
              AND tail_event_id IS NOT NULL
              AND tail_event_content_hash IS NOT NULL)
          )
        ) STRICT;

        CREATE INDEX IF NOT EXISTS run_continuations_by_bundle_hash
          ON run_continuations(bundle_hash);
        `);
        if (lockedSchemaVersion < ELAND_DATABASE_SCHEMA_VERSION) {
          this.database.exec(`PRAGMA user_version = ${ELAND_DATABASE_SCHEMA_VERSION}`);
        }
      });
    }

    this.selectRun = this.database.prepare(`
      SELECT id, state_hash, schema_version, label, created_at, updated_at,
             revision, elapsed_months, civilization_no, status, living_agents,
             agent_count, event_count, milestone_count
      FROM runs
      WHERE id = ?
    `);
    this.selectChunk = this.database.prepare(`
      SELECT hash, codec, raw_size, data
      FROM chunks
      WHERE hash = ?
    `);
    this.selectRunContinuation = this.database.prepare(`
      SELECT run_id, revision, state_hash, root_schema_version, shell_hash,
             history_lineage_id, history_head_hash, event_count, tail_event_id,
             tail_event_content_hash, hot_event_limit, bundle_schema_version,
             bundle_hash, updated_at
      FROM run_continuations
      WHERE run_id = ?
    `);
    this.selectExactRunCheckpoint = this.database.prepare(`
      SELECT run_id, revision, month, state_hash, created_at
      FROM run_checkpoints
      WHERE run_id = ? AND revision = ? AND state_hash = ?
    `);
    this.insertChunk = this.database.prepare(`
      INSERT OR IGNORE INTO chunks(hash, codec, raw_size, data)
      VALUES (?, ?, ?, ?)
    `);
    this.insertRun = this.database.prepare(`
      INSERT INTO runs(
        id, state_hash, schema_version, label, created_at, updated_at, revision,
        elapsed_months, civilization_no, status, living_agents, agent_count,
        event_count, milestone_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateRun = this.database.prepare(`
      UPDATE runs
      SET state_hash = ?, schema_version = ?, label = ?, created_at = ?, updated_at = ?,
          revision = ?, elapsed_months = ?, civilization_no = ?, status = ?,
          living_agents = ?, agent_count = ?, event_count = ?, milestone_count = ?
      WHERE id = ? AND revision = ? AND state_hash = ?
    `);
    this.insertCheckpoint = this.database.prepare(`
      INSERT INTO run_checkpoints(run_id, revision, month, state_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.insertRunContinuation = this.database.prepare(`
      INSERT INTO run_continuations(
        run_id, revision, state_hash, root_schema_version, shell_hash,
        history_lineage_id, history_head_hash, event_count, tail_event_id,
        tail_event_content_hash, hot_event_limit, bundle_schema_version,
        bundle_hash, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateRunContinuationCas = this.database.prepare(`
      UPDATE run_continuations
      SET revision = ?, state_hash = ?, root_schema_version = ?, shell_hash = ?,
          history_lineage_id = ?, history_head_hash = ?, event_count = ?,
          tail_event_id = ?, tail_event_content_hash = ?, hot_event_limit = ?,
          bundle_schema_version = ?, bundle_hash = ?, updated_at = ?
      WHERE run_id = ? AND revision = ? AND state_hash = ?
        AND bundle_hash = ? AND updated_at = ?
    `);
    this.outputArtifacts = new SqliteRunOutputArtifactStore(
      this.database,
      V8_BROTLI_CODEC,
      {
        normalizeRunId: normalizeId,
        assertRunExists: (id) => {
          this.assertRunExists(id);
        },
        encodeValue,
        decodeValue,
        storeChunk: (chunk) => this.storeChunk(chunk),
        transaction: (operation) => this.transaction(operation),
      },
    );
    boundedContinuationTokenRegistries.set(this, {
      generationsByRun: new Map<string, number>(),
      tokens: new WeakMap<object, BoundedContinuationTokenRecord>(),
      stagedSuccessors: new WeakMap<object, BoundedEvolutionSuccessorStagingRecord>(),
      stagedNonProjectionMonths: new WeakMap<object, BoundedNonProjectionMonthStagingRecord>(),
      ownedNonProjectionByRun: new Map(),
      warmNonProjectionByRun: new Map(),
      publishedNonProjectionMonths: new WeakMap<object, BoundedNonProjectionMonthPublishedRecord>(),
      stagedObserverBoundaryMonths: new WeakMap<object, BoundedObserverBoundaryMonthStagingRecord>(),
      publishedObserverBoundaryMonths: new WeakMap<object, BoundedObserverBoundaryMonthPublishedRecord>(),
      physicalByRun: new Map<string, VerifiedPhysicalContinuationCacheRecord>(),
    });
    this.continuationArtifactMaterialization =
      new SqliteBoundedContinuationArtifactMaterialization({
        readRunStateChunk: (hash) => this.chunkRow(hash),
        decodeContinuationOpenGameplay: (root, readChunk, decodeOptions) => (
          this.decodeBoundedGameplayForPhase(
            "continuationOpen",
            root,
            readChunk,
            decodeOptions,
          )
        ),
        selectCachedPhysicalProjection: ({ runId, revision, stateHash, sidecar }) => {
          const cached = this.continuationTokenRegistry().physicalByRun.get(runId);
          if (cached
            && cached.runId === runId
            && cached.revision === revision
            && cached.stateHash === stateHash
            && cached.sidecar.hash === sidecar.hash
            && cached.sidecar.codec === sidecar.codec
            && cached.sidecar.rawSize === sidecar.rawSize) {
            return cached.projection;
          }
          return null;
        },
        assertDecodedRunSummary,
        assertContinuationAuthority,
        assertRetentionPinsMatchBundle,
        contentHashReferenceFor,
        snapshotContinuationChunkIdentity,
      });
    this.observerBoundaryPublication = new SqliteBoundedObserverBoundaryPublication({
      openBoundedEvolutionContinuation: async (id) => this.openBoundedEvolutionContinuation(id),
      stageOwnedSingleMonthSuccessor: async (
        token,
        state,
        label,
        exactHistoryOwnerReceipt,
      ) => {
        const receipt = await this.stageBoundedEvolutionSuccessorInternal(
          token as BoundedEvolutionContinuationToken,
          state,
          label,
          storeOwnedSingleMonthSuccessorAuthority,
          exactHistoryOwnerReceipt as BoundedEvolutionSuccessorStagingReceipt | undefined,
        );
        const current = this.currentContinuationTokenRecord(token);
        return {
          receipt,
          sourceToken: current.token,
          source: current.record,
          successor: this.continuationTokenRegistry().stagedSuccessors.get(receipt),
        };
      },
      registerObserverBoundaryStaging: (receipt, record) => {
        this.continuationTokenRegistry().stagedObserverBoundaryMonths.set(receipt, {
          ...record,
          factSuccessorReceipt:
            record.factSuccessorReceipt as BoundedEvolutionSuccessorStagingReceipt,
        });
      },
      currentObserverBoundaryStaging: (receipt) => (
        this.currentBoundedObserverBoundaryMonthStaging(receipt)
      ),
      assertObserverBoundaryStagingCurrent: (receipt, expected) => {
        this.assertBoundedObserverBoundaryStagingCurrent(receipt, expected);
      },
      assertOwnedSuccessorCurrent: (
        receipt,
        successor,
        sourceToken,
        sourceGeneration,
      ) => {
        const registered = this.continuationTokenRegistry().stagedSuccessors.get(receipt);
        if (registered !== successor
          || registered?.sourceToken !== sourceToken
          || registered.sourceGeneration !== sourceGeneration) {
          throw new RunWriteConflictError(
            "bounded 年度观察 live-social descriptor 重绑缺少当前 exact successor authority",
          );
        }
      },
      hasPublishedObserverBoundaryReceipt: (receipt) => {
        if (this.closed
          || (typeof receipt !== "object" && typeof receipt !== "function")
          || receipt === null) {
          return false;
        }
        return this.continuationTokenRegistry().publishedObserverBoundaryMonths.has(receipt);
      },
      readRunStateChunk: (hash) => this.chunkRow(hash),
      assertContinuationAuthority,
      assertRetentionPinsMatchBundle,
      commitObserverBoundaryPublication: (input) => {
        this.commitObserverBoundaryPublication(input);
      },
      completeObserverBoundaryPublication: (input) => {
        this.completeObserverBoundaryPublication(input);
      },
    });
    this.nonProjectionPublication = new SqliteBoundedNonProjectionPublication({
      openOwnedMonth: async (id) => {
        const normalizedId = normalizeId(id);
        const warm = this.takeWarmNonProjectionContinuation(normalizedId);
        if (warm) {
          return { state: warm.state, continuationToken: warm.token };
        }
        const opened = await this.openBoundedEvolutionContinuation(normalizedId);
        return { state: opened.state, continuationToken: opened.continuationToken };
      },
      stageOwnedSingleMonthSuccessor: async (token, state, label) => {
        const receipt = await this.stageBoundedEvolutionSuccessorInternal(
          token as BoundedEvolutionContinuationToken,
          state,
          label,
          storeOwnedSingleMonthSuccessorAuthority,
        );
        const current = this.currentContinuationTokenRecord(token);
        return {
          receipt,
          sourceToken: current.token,
          source: current.record,
          successor: this.continuationTokenRegistry().stagedSuccessors.get(receipt),
        };
      },
      registerStaging: (receipt, record) => {
        const registry = this.continuationTokenRegistry();
        registry.stagedNonProjectionMonths.set(receipt, record);
        registry.ownedNonProjectionByRun.set(record.runId, {
          receipt,
          staging: record,
        });
      },
      resolveStaging: (receipt) => this.resolveBoundedNonProjectionMonthStaging(receipt),
      discardStaging: (receipt, staging) => {
        this.discardOwnedNonProjectionStaging(
          this.continuationTokenRegistry(),
          receipt,
          staging,
        );
      },
      assertSourceSnapshotCurrent: (sourceToken, source) => {
        this.assertContinuationTokenSnapshotCurrent(
          sourceToken,
          source as BoundedContinuationTokenRecord,
        );
      },
      hasPublishedReceipt: (receipt) => {
        if (this.closed
          || (typeof receipt !== "object" && typeof receipt !== "function")
          || receipt === null) {
          return false;
        }
        return this.continuationTokenRegistry().publishedNonProjectionMonths.has(receipt);
      },
      readRunStateChunk: (hash) => this.chunkRow(hash),
      assertDecodedRunSummary,
      assertContinuationAuthority,
      assertRetentionPinsMatchBundle,
      snapshotContinuationChunkIdentity,
      commitPublication: (input) => {
        this.commitNonProjectionPublication(input);
      },
      completePublication: (input) => {
        this.completeNonProjectionPublication(input);
      },
    });
  }

  dataDirectory(): string {
    return this.rootDir;
  }

  filePath(): string {
    return this.databaseFile;
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
    const registry = boundedContinuationTokenRegistries.get(this);
    if (registry) {
      for (const { receipt, staging } of registry.ownedNonProjectionByRun.values()) {
        registry.stagedNonProjectionMonths.delete(receipt);
        registry.stagedSuccessors.delete(staging.successorReceipt);
      }
      registry.ownedNonProjectionByRun.clear();
      registry.warmNonProjectionByRun.clear();
    }
    registry?.generationsByRun.clear();
    registry?.physicalByRun.clear();
  }

  private runRow(id: string): RunRow | null {
    return parseRunRow(this.selectRun.get(normalizeId(id)));
  }

  private chunkRow(hash: string): ChunkRow {
    const chunk = parseChunkRow(this.selectChunk.get(hash));
    if (!chunk) throw new Error(`运行数据块 ${hash} 不存在`);
    return chunk;
  }

  private continuationRow(id: string): RunContinuationRow | null {
    return parseRunContinuationRow(this.selectRunContinuation.get(id));
  }

  private exactCheckpointRow(
    runId: string,
    revision: number,
    stateHash: string,
  ): ExactRunCheckpointRow | null {
    return parseExactRunCheckpointRow(
      this.selectExactRunCheckpoint.get(runId, revision, stateHash),
    );
  }

  private continuationTokenRegistry(): BoundedContinuationTokenRegistry {
    const registry = boundedContinuationTokenRegistries.get(this);
    if (!registry) throw new Error("bounded continuation token registry 未初始化");
    return registry;
  }

  private storedChunkSnapshotCurrent(snapshot: {
    readonly hash: string;
    readonly codec: string;
    readonly rawSize: number;
    readonly data: Buffer | Uint8Array;
  }): boolean {
    try {
      return sameChunkSnapshot(snapshot, this.chunkRow(snapshot.hash));
    } catch {
      return false;
    }
  }

  private storedContinuationChunkIdentityCurrent(
    identity: Readonly<ContinuationChunkIdentity>,
  ): boolean {
    try {
      return sameContinuationChunkIdentity(identity, this.chunkRow(identity.hash));
    } catch {
      return false;
    }
  }

  private currentContinuationTokenRecord(
    token: unknown,
  ): { token: object; record: BoundedContinuationTokenRecord } {
    if (this.closed) throw new RunWriteConflictError("bounded continuation store 已关闭");
    if ((typeof token !== "object" && typeof token !== "function") || token === null) {
      throw new RunWriteConflictError("bounded continuation token 不是当前 store 铸造的对象");
    }
    const registry = this.continuationTokenRegistry();
    const record = registry.tokens.get(token);
    if (!record
      || record.spent
      || registry.generationsByRun.get(record.runId) !== record.generation) {
      throw new RunWriteConflictError("bounded continuation token 已失效、已消费或不属于当前 store generation");
    }
    return { token, record };
  }

  private discardOwnedNonProjectionStaging(
    registry: BoundedContinuationTokenRegistry,
    receipt: object,
    staging: BoundedNonProjectionMonthStagingRecord,
  ): void {
    registry.stagedNonProjectionMonths.delete(receipt);
    registry.stagedSuccessors.delete(staging.successorReceipt);
    const active = registry.ownedNonProjectionByRun.get(staging.runId);
    if (active?.receipt === receipt && active.staging === staging) {
      registry.ownedNonProjectionByRun.delete(staging.runId);
    }
  }

  private discardWarmNonProjectionContinuation(
    registry: BoundedContinuationTokenRegistry,
    runId: string,
    expected?: WarmBoundedContinuationRecord,
  ): void {
    const current = registry.warmNonProjectionByRun.get(runId);
    if (current && (!expected || current === expected)) {
      registry.warmNonProjectionByRun.delete(runId);
    }
  }

  private takeWarmNonProjectionContinuation(
    normalizedId: string,
  ): WarmBoundedContinuationRecord | null {
    if (this.closed) return null;
    const registry = this.continuationTokenRegistry();
    const warm = registry.warmNonProjectionByRun.get(normalizedId);
    if (!warm) return null;
    this.discardWarmNonProjectionContinuation(registry, normalizedId, warm);
    try {
      const current = this.currentContinuationTokenRecord(warm.token);
      this.assertContinuationTokenSnapshotCurrent(current.token, current.record);
      if (current.record.runId !== warm.runId
        || current.record.generation !== warm.generation
        || current.record.run.meta.revision !== warm.revision
        || current.record.run.stateHash !== warm.stateHash
        || current.record.root.hash !== warm.stateHash
        || warm.state.clock.elapsedMonths !== current.record.run.meta.elapsedMonths) {
        return null;
      }
      return warm;
    } catch {
      return null;
    }
  }

  private resolveBoundedNonProjectionMonthStaging(
    receiptInput: unknown,
  ): NonProjectionStagingCandidate {
    if ((typeof receiptInput !== "object" && typeof receiptInput !== "function")
      || receiptInput === null) {
      throw new RunWriteConflictError(
        "bounded 非投影单月 receipt 不是当前 store 铸造的对象",
      );
    }
    const registry = boundedContinuationTokenRegistries.get(this);
    if (!registry) {
      throw new RunWriteConflictError("bounded continuation token registry 未初始化");
    }
    const stagedMonth = registry.stagedNonProjectionMonths.get(receiptInput);
    if (this.closed) {
      if (stagedMonth) {
        this.discardOwnedNonProjectionStaging(registry, receiptInput, stagedMonth);
      }
      throw new RunWriteConflictError("bounded 非投影单月 store 已关闭");
    }
    if (!stagedMonth) {
      throw new RunWriteConflictError(
        "bounded 非投影单月 receipt 不是当前 store 铸造的 staging authority",
      );
    }
    let current: { token: object; record: BoundedContinuationTokenRecord };
    try {
      current = this.currentContinuationTokenRecord(stagedMonth.sourceToken);
    } catch (error) {
      this.discardOwnedNonProjectionStaging(registry, receiptInput, stagedMonth);
      throw error;
    }
    const successor = registry.stagedSuccessors.get(stagedMonth.successorReceipt);
    return {
      receipt: receiptInput,
      stagedMonth,
      successor,
      sourceToken: current.token,
      source: current.record,
    };
  }

  private currentBoundedObserverBoundaryMonthStaging(
    receiptInput: unknown,
  ): {
    receipt: object;
    stagedMonth: BoundedObserverBoundaryMonthStagingRecord;
    factSuccessor: BoundedEvolutionSuccessorStagingRecord;
    sourceToken: object;
    source: BoundedContinuationTokenRecord;
  } {
    if (this.closed
      || (typeof receiptInput !== "object" && typeof receiptInput !== "function")
      || receiptInput === null) {
      throw new RunWriteConflictError(
        "bounded 年度观察边界月 receipt 不是当前 store 铸造的对象",
      );
    }
    const registry = this.continuationTokenRegistry();
    const stagedMonth = registry.stagedObserverBoundaryMonths.get(receiptInput);
    if (!stagedMonth) {
      throw new RunWriteConflictError(
        "bounded 年度观察边界月 receipt 不是当前 store 铸造的 staging authority",
      );
    }
    const current = this.currentContinuationTokenRecord(stagedMonth.sourceToken);
    const factSuccessor = registry.stagedSuccessors.get(stagedMonth.factSuccessorReceipt);
    const sourceRoot = parseRunStateRoot(current.record.root);
    if (!factSuccessor
      || current.record.runId !== stagedMonth.runId
      || current.record.generation !== stagedMonth.sourceGeneration
      || factSuccessor.sourceToken !== current.token
      || factSuccessor.sourceGeneration !== current.record.generation
      || current.record.run.meta.elapsedMonths !== stagedMonth.sourceMonth
      || factSuccessor.run.id !== current.record.runId
      || factSuccessor.run.meta.revision !== current.record.run.meta.revision + 1
      || factSuccessor.run.meta.elapsedMonths !== stagedMonth.targetMonth
      || factSuccessor.run.stateHash !== factSuccessor.root.hash
      || stagedMonth.targetMonth !== stagedMonth.sourceMonth + 1
      || (stagedMonth.boundaryKind === "annual"
        ? stagedMonth.targetMonth % 12 !== 0
          || factSuccessor.run.meta.status !== "running"
        : factSuccessor.run.meta.status !== "ended")
      || !stagedHistoryTransitionMatchesSource(sourceRoot, factSuccessor)) {
      throw new RunWriteConflictError(
        "bounded 年度观察边界月 receipt 与 source token/private fact root A 失配",
      );
    }
    return {
      receipt: receiptInput,
      stagedMonth,
      factSuccessor,
      sourceToken: current.token,
      source: current.record,
    };
  }

  private assertBoundedObserverBoundaryStagingCurrent(
    receipt: object,
    expected: ObserverBoundaryStagingContext,
  ): void {
    const current = this.currentBoundedObserverBoundaryMonthStaging(receipt);
    if (current.stagedMonth !== expected.stagedMonth
      || current.factSuccessor !== expected.factSuccessor
      || current.sourceToken !== expected.sourceToken
      || current.source !== expected.source) {
      throw new RunWriteConflictError(
        "bounded 年度观察边界月 staging join 在异步物化期间发生替换",
      );
    }
    this.assertContinuationTokenSnapshotCurrent(current.sourceToken, current.source);
  }

  private assertContinuationTokenSnapshotCurrent(
    token: object,
    record: BoundedContinuationTokenRecord,
  ): void {
    const current = this.currentContinuationTokenRecord(token);
    if (current.record !== record) {
      throw new RunWriteConflictError("bounded continuation token registry 记录已替换");
    }
    const run = this.runRow(record.runId);
    const continuation = this.continuationRow(record.runId);
    const checkpoint = this.exactCheckpointRow(
      record.continuation.runId,
      record.continuation.revision,
      record.continuation.stateHash,
    );
    if (!run
      || !continuation
      || !checkpoint
      || !sameRunRow(record.run, run)
      || !sameRunContinuationRow(record.continuation, continuation)
      || !sameExactRunCheckpointRow(record.checkpoint, checkpoint)) {
      throw new RunWriteConflictError(
        `运行 ${record.runId} 的 bounded continuation token snapshot 已过期`,
      );
    }
    if (!this.storedChunkSnapshotCurrent(record.root)
      || !this.storedContinuationChunkIdentityCurrent(record.bundle)) {
      throw new RunWriteConflictError(
        `运行 ${record.runId} 的 bounded continuation root 或 bundle snapshot 已过期`,
      );
    }
    if (record.observerMaterializationSourceRoot
      && !this.storedChunkSnapshotCurrent(record.observerMaterializationSourceRoot)) {
      throw new RunWriteConflictError(
        `运行 ${record.runId} 的 observer materialization source root 已失效`,
      );
    }
    for (const name of RUN_CONTINUATION_SIDECAR_NAMES) {
      const sidecar = record.sidecars[name];
      if (!this.storedContinuationChunkIdentityCurrent(sidecar)) {
        throw new RunWriteConflictError(
          `运行 ${record.runId} 的 bounded continuation sidecar ${name} snapshot 已过期`,
        );
      }
    }
  }

  private transaction<T>(operation: () => T): T {
    if (this.readOnly) throw new Error("只读 SQLite 运行存储不能写入");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure if SQLite has already rolled back.
      }
      throw error;
    }
  }

  private storeChunk(chunk: EncodedChunk): void {
    const result = this.insertChunk.run(chunk.hash, chunk.codec, chunk.rawSize, chunk.data);
    if (Number(result.changes) > 0) return;
    const existing = this.chunkRow(chunk.hash);
    if (existing.codec !== chunk.codec
      || existing.rawSize !== chunk.rawSize
      || !sameBytes(existing.data, chunk.data)) {
      throw new Error(`运行数据块 ${chunk.hash} 命中已有哈希，但编码、长度或内容不一致`);
    }
  }

  private assertRunExists(id: string): RunRow {
    const row = this.runRow(id);
    if (!row) throw new RunNotFoundError(`运行 ${id} 不存在`);
    return row;
  }

  private async decodeRunState(hash: string): Promise<{
    state: SimulationState;
    metadata?: RunStateRootMetadata;
  }> {
    const root = this.chunkRow(hash);
    if (root.codec === V8_BROTLI_CODEC) {
      return { state: await decodeValue<SimulationState>(root) };
    }
    if (root.codec === RUN_STATE_ROOT_CODEC) {
      const decoded = await decodeSegmentedRunState(root, (chunkHash) => this.chunkRow(chunkHash));
      return { state: decoded.state, metadata: decoded.metadata };
    }
    throw new Error(`不支持的运行状态根编码：${root.codec}`);
  }

  private decodeBoundedGameplayForPhase(
    phase: "continuationOpen" | "nonProjectionPublish",
    ...input: Parameters<typeof decodeSegmentedRunStateGameplayBounded>
  ): ReturnType<typeof decodeSegmentedRunStateGameplayBounded> {
    this.boundedGameplayDecodePhaseCounts[phase] += 1;
    return decodeSegmentedRunStateGameplayBounded(...input);
  }

  private runStateRootMetadata(hash: string): RunStateRootMetadata | null {
    const root = this.chunkRow(hash);
    if (root.codec === V8_BROTLI_CODEC) return null;
    if (root.codec === RUN_STATE_ROOT_CODEC) return parseRunStateRoot(root);
    throw new Error(`不支持的运行状态根编码：${root.codec}`);
  }

  private strictEvolutionRoot(row: RunRow): {
    root: RunStateChunk;
    metadata: RunStateRootMetadata;
  } {
    const root = this.chunkRow(row.stateHash);
    if (root.codec !== RUN_STATE_ROOT_CODEC) {
      throw new Error(
        `运行 ${row.id} 不是 schema 2/3 segmented 状态，不能使用 bounded evolution load`,
      );
    }
    const metadata = parseRunStateRoot(root);
    if (metadata.schemaVersion !== 2 && metadata.schemaVersion !== 3) {
      throw new Error(
        `运行 ${row.id} 的状态根 schemaVersion ${metadata.schemaVersion} 不支持 bounded evolution load`,
      );
    }
    if (row.meta.eventCount !== metadata.eventCount) {
      throw new Error(
        `运行 ${row.id} 的 runs.event_count ${row.meta.eventCount}`
        + ` 与状态根 eventCount ${metadata.eventCount} 不一致`,
      );
    }
    return { root, metadata };
  }

  private boundedContinuationBootstrapSource(
    normalizedId: string,
  ): BoundedContinuationBootstrapSourceSnapshot {
    if (this.closed) throw new RunWriteConflictError("bounded continuation store 已关闭");
    if (this.readOnly) throw new Error("只读 SQLite 运行存储不能建立 bounded continuation");
    const currentRun = this.runRow(normalizedId);
    if (!currentRun) throw new RunNotFoundError(`运行 ${normalizedId} 不存在`);
    if (this.continuationRow(normalizedId)) {
      throw new RunWriteConflictError(`运行 ${normalizedId} 已有 bounded continuation`);
    }
    const { root, metadata } = this.strictEvolutionRoot(currentRun);
    const checkpoint = this.exactCheckpointRow(
      currentRun.id,
      currentRun.meta.revision,
      currentRun.stateHash,
    );
    if (!checkpoint
      || checkpoint.month !== currentRun.meta.elapsedMonths
      || checkpoint.stateHash !== root.hash) {
      throw new Error(`运行 ${normalizedId} 缺少当前 root 的 exact checkpoint`);
    }
    return Object.freeze({
      run: Object.freeze({
        id: currentRun.id,
        stateHash: currentRun.stateHash,
        meta: Object.freeze({ ...currentRun.meta }),
      }),
      checkpoint: Object.freeze({ ...checkpoint }),
      root: snapshotRunStateChunk(root),
      metadata: Object.freeze({ ...metadata }),
    });
  }

  private assertBoundedContinuationBootstrapSourceCurrent(
    source: Readonly<BoundedContinuationBootstrapSourceSnapshot>,
  ): void {
    if (this.closed) throw new RunWriteConflictError("bounded continuation store 已关闭");
    const currentRun = this.runRow(source.run.id);
    const currentCheckpoint = this.exactCheckpointRow(
      source.run.id,
      source.run.meta.revision,
      source.run.stateHash,
    );
    if (!currentRun
      || !currentCheckpoint
      || !sameRunRow(source.run, currentRun)
      || !sameExactRunCheckpointRow(source.checkpoint, currentCheckpoint)
      || currentCheckpoint.month !== currentRun.meta.elapsedMonths
      || this.continuationRow(source.run.id) !== null) {
      throw new RunWriteConflictError(
        `运行 ${source.run.id} 的 bounded continuation bootstrap source 已变化`,
      );
    }
    let currentRoot: RunStateChunk;
    try {
      currentRoot = snapshotRunStateChunk(this.chunkRow(source.root.hash));
    } catch (error) {
      throw new RunWriteConflictError(
        `运行 ${source.run.id} 的 bounded continuation bootstrap root 已失效`,
        { cause: error },
      );
    }
    if (!sameChunkSnapshot(source.root, currentRoot)) {
      throw new RunWriteConflictError(
        `运行 ${source.run.id} 的 bounded continuation bootstrap root 已变化`,
      );
    }
    const currentMetadata = parseRunStateRoot(currentRoot);
    if (currentMetadata.schemaVersion !== source.metadata.schemaVersion
      || currentMetadata.shellHash !== source.metadata.shellHash
      || currentMetadata.lineageId !== source.metadata.lineageId
      || currentMetadata.historyHeadHash !== source.metadata.historyHeadHash
      || currentMetadata.eventCount !== source.metadata.eventCount
      || currentMetadata.tailEventContentHash !== source.metadata.tailEventContentHash) {
      throw new RunWriteConflictError(
        `运行 ${source.run.id} 的 bounded continuation bootstrap metadata 已变化`,
      );
    }
  }

  private boundedContinuationRefreshSource(
    normalizedId: string,
  ): BoundedContinuationRefreshSourceSnapshot {
    if (this.closed) throw new RunWriteConflictError("bounded continuation store 已关闭");
    if (this.readOnly) throw new Error("只读 SQLite 运行存储不能刷新 bounded continuation");
    const currentRun = this.runRow(normalizedId);
    if (!currentRun) throw new RunNotFoundError(`运行 ${normalizedId} 不存在`);
    const currentContinuation = this.continuationRow(normalizedId);
    if (!currentContinuation) {
      throw new RunWriteConflictError(`运行 ${normalizedId} 没有可刷新的 bounded continuation`);
    }
    const { root, metadata } = this.strictEvolutionRoot(currentRun);
    const rootSnapshot = snapshotRunStateChunk(root);
    const checkpoint = this.exactCheckpointRow(
      currentRun.id,
      currentRun.meta.revision,
      currentRun.stateHash,
    );
    if (!checkpoint
      || checkpoint.month !== currentRun.meta.elapsedMonths
      || checkpoint.stateHash !== rootSnapshot.hash) {
      throw new Error(`运行 ${normalizedId} 缺少当前 root 的 exact checkpoint`);
    }

    const bundleChunk = snapshotRunContinuationBundleChunk(
      this.chunkRow(currentContinuation.bundleHash),
    );
    const bundle = decodeRunContinuationBundle(bundleChunk);
    assertContinuationAuthority(
      currentRun,
      currentContinuation,
      checkpoint,
      rootSnapshot,
      metadata,
      bundle,
    );
    const sidecars = {} as Record<RunContinuationSidecarName, ContinuationChunkIdentity>;
    for (const name of RUN_CONTINUATION_SIDECAR_NAMES) {
      const reference = contentHashReferenceFor(bundle.sidecars[name], normalizedId, name);
      sidecars[name] = snapshotContinuationChunkIdentity(this.chunkRow(reference.hash));
    }

    let observerMaterializationSourceRoot: RunStateChunk | undefined;
    if (bundle.observerMaterializationSource) {
      observerMaterializationSourceRoot = snapshotRunStateChunk(
        this.chunkRow(bundle.observerMaterializationSource.stateHash),
      );
      if (observerMaterializationSourceRoot.codec !== RUN_STATE_ROOT_CODEC) {
        throw new Error(
          `运行 ${normalizedId} 的 observer materialization source 不是 segmented root`,
        );
      }
      const sourceMetadata = parseRunStateRoot(observerMaterializationSourceRoot);
      if (sourceMetadata.schemaVersion !== 3
        || sourceMetadata.lineageId !== metadata.lineageId
        || sourceMetadata.eventCount > metadata.eventCount
        || (sourceMetadata.eventCount === metadata.eventCount
          && sourceMetadata.tailEventContentHash !== metadata.tailEventContentHash)) {
        throw new Error(
          `运行 ${normalizedId} 的 observer materialization source 与 refresh root 历史失配`,
        );
      }
    }

    return Object.freeze({
      run: Object.freeze({
        id: currentRun.id,
        stateHash: currentRun.stateHash,
        meta: Object.freeze({ ...currentRun.meta }),
      }),
      checkpoint: Object.freeze({ ...checkpoint }),
      root: rootSnapshot,
      metadata: Object.freeze({ ...metadata }),
      continuation: Object.freeze({ ...currentContinuation }),
      bundleChunk,
      bundle,
      sidecars: Object.freeze(sidecars),
      ...(observerMaterializationSourceRoot ? { observerMaterializationSourceRoot } : {}),
    });
  }

  private assertBoundedContinuationRefreshSourceCurrent(
    source: Readonly<BoundedContinuationRefreshSourceSnapshot>,
  ): void {
    if (this.closed) throw new RunWriteConflictError("bounded continuation store 已关闭");
    const currentRun = this.runRow(source.run.id);
    const currentCheckpoint = this.exactCheckpointRow(
      source.run.id,
      source.run.meta.revision,
      source.run.stateHash,
    );
    const currentContinuation = this.continuationRow(source.run.id);
    if (!currentRun
      || !currentCheckpoint
      || !currentContinuation
      || !sameRunRow(source.run, currentRun)
      || !sameExactRunCheckpointRow(source.checkpoint, currentCheckpoint)
      || !sameRunContinuationRow(source.continuation, currentContinuation)
      || currentCheckpoint.month !== currentRun.meta.elapsedMonths) {
      throw new RunWriteConflictError(
        `运行 ${source.run.id} 的 bounded continuation refresh source 已变化`,
      );
    }
    if (!this.storedChunkSnapshotCurrent(source.root)
      || !this.storedChunkSnapshotCurrent(source.bundleChunk)) {
      throw new RunWriteConflictError(
        `运行 ${source.run.id} 的 bounded continuation refresh root 或 bundle 已变化`,
      );
    }
    if (source.observerMaterializationSourceRoot
      && !this.storedChunkSnapshotCurrent(source.observerMaterializationSourceRoot)) {
      throw new RunWriteConflictError(
        `运行 ${source.run.id} 的 observer materialization source root 已变化`,
      );
    }
    for (const name of RUN_CONTINUATION_SIDECAR_NAMES) {
      if (!this.storedContinuationChunkIdentityCurrent(source.sidecars[name])) {
        throw new RunWriteConflictError(
          `运行 ${source.run.id} 的 bounded continuation refresh sidecar ${name} 已变化`,
        );
      }
    }
  }

  private assertEvolutionBasisCurrent(
    normalizedId: string,
    basis: EvolutionRunBasis,
  ): { row: RunRow; root: RunStateChunk; metadata: RunStateRootMetadata } {
    if (!basis || basis.runId !== normalizedId) {
      throw new RunWriteConflictError(
        `bounded evolution basis 不属于运行 ${normalizedId}`,
      );
    }
    const row = this.runRow(normalizedId);
    if (!row) {
      throw new RunWriteConflictError(`运行 ${normalizedId} 的 bounded evolution basis 已失效：运行不存在`);
    }
    if (basis.revision !== row.meta.revision || basis.stateHash !== row.stateHash) {
      throw new RunWriteConflictError(
        `运行 ${normalizedId} 的 bounded evolution basis 已过期：期望 revision ${basis.revision}`
        + ` / ${basis.stateHash}，当前为 revision ${row.meta.revision} / ${row.stateHash}`,
      );
    }
    const { root, metadata } = this.strictEvolutionRoot(row);
    const currentHistory = runHistoryCursorFromRootMetadata(metadata);
    if (!basis.history || !sameHistoryCursor(basis.history, currentHistory)) {
      throw new RunWriteConflictError(
        `运行 ${normalizedId} 的 bounded evolution history basis 与当前权威历史根不一致`,
      );
    }
    return { row, root, metadata };
  }

  private storeRunState(snapshot: EncodedRunState): void {
    for (const part of snapshot.parts) this.storeChunk(part);
    this.storeChunk(snapshot.root);
  }

  private pruneRunCheckpoints(id: string): boolean {
    const checkpointCount = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM run_checkpoints AS checkpoint
      JOIN chunks AS state_root ON state_root.hash = checkpoint.state_hash
      WHERE checkpoint.run_id = ?
        AND state_root.codec = ?
    `).get(id, RUN_STATE_ROOT_CODEC);
    if (Number(checkpointCount?.count ?? 0) <= RUN_CHECKPOINT_PRUNE_THRESHOLD) return false;

    const result = this.database.prepare(`
      DELETE FROM run_checkpoints
      WHERE run_id = ?
        AND state_hash IN (
          SELECT hash FROM chunks WHERE codec = ?
        )
        AND revision NOT IN (
          SELECT checkpoint.revision
          FROM run_checkpoints AS checkpoint
          JOIN chunks AS state_root ON state_root.hash = checkpoint.state_hash
          WHERE checkpoint.run_id = ?
            AND state_root.codec = ?
          ORDER BY checkpoint.revision DESC
          LIMIT ?
        )
    `).run(
      id,
      RUN_STATE_ROOT_CODEC,
      id,
      RUN_STATE_ROOT_CODEC,
      RUN_CHECKPOINT_RETENTION,
    );
    return Number(result.changes) > 0;
  }

  private collectUnreferencedRunStateChunks(
    activeContinuation?: Readonly<BoundedContinuationTokenRecord>,
  ): void {
    const collectibleCodecs = [
      ...RUN_STATE_CODECS,
      ...RUN_CONTINUATION_COLLECTIBLE_CODECS,
    ];
    const codecPlaceholders = collectibleCodecs.map(() => "?").join(", ");
    const memo: RunStateReachabilityMemo = {
      chunks: new Set<string>(),
      historyNodes: new Set<string>(),
    };
    const markStateRoot = (hash: string, label: string): void => {
      const chunk = this.chunkRow(hash);
      if (chunk.codec !== RUN_STATE_ROOT_CODEC) {
        throw new Error(`${label} ${hash} 不是 run-state root`);
      }
      markReachableRunStateChunks(
        chunk,
        (childHash) => this.chunkRow(childHash),
        memo,
      );
    };
    const markContinuationReferences = (
      bundleHash: string,
      runId: string,
    ): void => {
      // Mark before decoding so any fail-closed exit retains the manifest. The
      // surrounding write transaction rolls back every attempted collection.
      memo.chunks.add(bundleHash);
      const bundle = decodeRunContinuationBundle(
        snapshotRunContinuationBundleChunk(this.chunkRow(bundleHash)),
      );
      for (const name of RUN_CONTINUATION_SIDECAR_NAMES) {
        const reference = contentHashReferenceFor(bundle.sidecars[name], runId, name);
        const sidecar = this.chunkRow(reference.hash);
        if (sidecar.codec !== reference.codec) {
          throw new Error(
            `运行 ${runId} 的 continuation sidecar ${name} codec 与引用不一致`,
          );
        }
        memo.chunks.add(reference.hash);
      }
      if (bundle.observerMaterializationSource) {
        markStateRoot(
          bundle.observerMaterializationSource.stateHash,
          `运行 ${runId} 的 observer materialization source`,
        );
      }
    };
    const stateRoots = this.database.prepare(`
      SELECT state_hash AS hash FROM runs
      UNION
      SELECT state_hash AS hash FROM run_checkpoints
      UNION
      SELECT state_hash AS hash FROM run_continuations
    `).all();
    for (const row of stateRoots) {
      const hash = String(row.hash);
      const chunk = this.chunkRow(hash);
      memo.chunks.add(hash);
      if (chunk.codec === RUN_STATE_ROOT_CODEC) {
        markReachableRunStateChunks(chunk, (childHash) => this.chunkRow(childHash), memo);
      } else if (chunk.codec !== V8_BROTLI_CODEC) {
        throw new Error(`运行状态根 ${hash} 使用了不支持的编码 ${chunk.codec}`);
      }
    }

    // Current manifests are roots in their own right: retain the bundle, all
    // five typed content references, and any private same-month fact root A.
    for (const row of this.database.prepare(`
      SELECT run_id, bundle_hash AS hash FROM run_continuations
    `).all()) {
      markContinuationReferences(String(row.hash), String(row.run_id));
    }

    // Publication invokes GC after its new CAS but before COMMIT can consume
    // the source token. Keep that still-live process-local snapshot intact;
    // the following sweep may reclaim it after a later generation advances.
    if (activeContinuation) {
      memo.chunks.add(activeContinuation.bundle.hash);
      for (const name of RUN_CONTINUATION_SIDECAR_NAMES) {
        memo.chunks.add(activeContinuation.sidecars[name].hash);
      }
      markStateRoot(activeContinuation.root.hash, "active continuation root");
      if (activeContinuation.observerMaterializationSourceRoot) {
        markStateRoot(
          activeContinuation.observerMaterializationSourceRoot.hash,
          "active continuation observer materialization source",
        );
      }
    }

    for (const row of this.database.prepare(`SELECT chunk_hash AS hash FROM artifacts`).all()) {
      const hash = String(row.hash);
      const chunk = this.chunkRow(hash);
      memo.chunks.add(hash);
      if (chunk.codec === RUN_STATE_ROOT_CODEC) {
        markReachableRunStateChunks(chunk, (childHash) => this.chunkRow(childHash), memo);
      }
    }

    const deleteChunk = this.database.prepare(`
      DELETE FROM chunks WHERE hash = ? AND codec IN (${codecPlaceholders})
    `);
    for (const row of this.database.prepare(`
      SELECT hash FROM chunks WHERE codec IN (${codecPlaceholders})
    `).all(...collectibleCodecs)) {
      const hash = String(row.hash);
      if (!memo.chunks.has(hash)) deleteChunk.run(hash, ...collectibleCodecs);
    }
  }

  async list(): Promise<RunSummary[]> {
    return this.database.prepare(`
      SELECT id, state_hash, schema_version, label, created_at, updated_at,
             revision, elapsed_months, civilization_no, status, living_agents,
             agent_count, event_count, milestone_count
      FROM runs
      ORDER BY updated_at DESC, id ASC
    `).all().map((row) => parseRunRow(row)!.meta);
  }

  async load(id: string): Promise<PersistedRun> {
    const normalizedId = normalizeId(id);
    const row = this.runRow(normalizedId);
    if (!row) throw new RunNotFoundError(`运行 ${normalizedId} 不存在`);
    const stored = await this.decodeRunState(row.stateHash);
    // Segmented roots are written only from current-schema authoritative state.
    // Legacy monoliths still pass through the migration/normalization layer once.
    const state = stored.metadata ? stored.state : migrated(stored.state);
    if (stored.metadata && !state.world.historyCursor) {
      state.world.historyCursor = {
        version: 1,
        eventCount: stored.metadata.eventCount,
        hotStartIndex: 0,
        tailEventId: state.world.past.at(-1)?.id ?? null,
      };
    }
    return { meta: row.meta, state };
  }

  async loadForEvolution(
    id: string,
    options: RunStateBoundedDecodeOptions,
  ): Promise<LoadedEvolutionRun> {
    const normalizedId = normalizeId(id);
    const row = this.runRow(normalizedId);
    if (!row) throw new RunNotFoundError(`运行 ${normalizedId} 不存在`);
    const { root, metadata } = this.strictEvolutionRoot(row);
    const decoded = await decodeSegmentedRunStateBounded(
      root,
      (chunkHash) => this.chunkRow(chunkHash),
      options,
    );
    return {
      meta: row.meta,
      state: decoded.state,
      pinnedEvents: decoded.pinnedEvents,
      basis: evolutionBasisFor(row, metadata),
    };
  }

  /**
   * Authenticity probe only. A matching public shape is insufficient: the
   * object must be the current unspent generation minted by this store.
   */
  ownsBoundedEvolutionContinuationToken(
    token: unknown,
  ): token is BoundedEvolutionContinuationToken {
    if (this.closed || (typeof token !== "object" && typeof token !== "function") || token === null) {
      return false;
    }
    const registry = boundedContinuationTokenRegistries.get(this);
    const record = registry?.tokens.get(token);
    return Boolean(record
      && !record.spent
      && registry?.generationsByRun.get(record.runId) === record.generation);
  }

  ownsBoundedEvolutionSuccessorStagingReceipt(
    receipt: unknown,
  ): receipt is BoundedEvolutionSuccessorStagingReceipt {
    if (this.closed
      || (typeof receipt !== "object" && typeof receipt !== "function")
      || receipt === null) {
      return false;
    }
    const registry = boundedContinuationTokenRegistries.get(this);
    const staged = registry?.stagedSuccessors.get(receipt);
    if (!registry || !staged) return false;
    const source = registry.tokens.get(staged.sourceToken);
    return Boolean(source
      && source.generation === staged.sourceGeneration
      && !source.spent
      && registry.generationsByRun.get(source.runId) === source.generation);
  }

  ownsBoundedNonProjectionMonthStagingReceipt(
    receipt: unknown,
  ): receipt is BoundedNonProjectionMonthStagingReceipt {
    return this.nonProjectionPublication.ownsStagingReceipt(receipt);
  }

  ownsBoundedNonProjectionMonthPublishedReceipt(
    receipt: unknown,
  ): receipt is BoundedNonProjectionMonthPublishedReceipt {
    return this.nonProjectionPublication.ownsPublishedReceipt(receipt);
  }

  ownsBoundedObserverBoundaryMonthStagingReceipt(
    receipt: unknown,
  ): receipt is BoundedObserverBoundaryMonthStagingReceipt {
    return this.observerBoundaryPublication.ownsStagingReceipt(receipt);
  }

  ownsBoundedObserverBoundaryMonthPublishedReceipt(
    receipt: unknown,
  ): receipt is BoundedObserverBoundaryMonthPublishedReceipt {
    return this.observerBoundaryPublication.ownsPublishedReceipt(receipt);
  }

  /**
   * One-shot rollback seam for the bounded publication fixture. It can only
   * force a failure after chunk writes and cannot relax any production check.
   */
  failNextBoundedPublicationAfterChunkWritesForTests(): void {
    if (this.readOnly || this.closed) {
      throw new Error("bounded publication rollback seam 只接受打开的可写 store");
    }
    this.failNextBoundedPublicationAfterChunkWrites = true;
  }

  /** Scalar-only phase probe; it cannot expose a decoded state or authority token. */
  boundedGameplayDecodePhaseCountsForTests(): Readonly<{
    continuationOpen: number;
    nonProjectionPublish: number;
  }> {
    return Object.freeze({ ...this.boundedGameplayDecodePhaseCounts });
  }

  /** Advance one scheduled annual/endpoint fact month into private root A. */
  async stageBoundedObserverBoundaryMonth(
    id: string,
    label?: string,
  ): Promise<BoundedObserverBoundaryMonthStagingReceipt> {
    return this.observerBoundaryPublication.stageScheduled(id, label);
  }

  /**
   * Closed replay of one otherwise ordinary source month. Only a naturally
   * produced, non-annual extinction can become a staging receipt.
   */
  async stageBoundedTerminalMonth(
    id: string,
    label?: string,
  ): Promise<BoundedObserverBoundaryMonthStagingReceipt> {
    return this.observerBoundaryPublication.stageTerminal(id, label);
  }

  async publishBoundedObserverBoundaryMonth(
    receipt: BoundedObserverBoundaryMonthStagingReceipt,
  ): Promise<BoundedObserverBoundaryMonthPublishedReceipt> {
    return this.observerBoundaryPublication.publish(receipt);
  }

  /**
   * Purpose-built atomic SQLite adapter for the two-root observer publication.
   * The coordinator cannot access the database, transaction or generic chunk
   * writer through this seam.
   */
  private commitObserverBoundaryPublication(
    input: ObserverBoundaryPublicationCommit,
  ): void {
    const {
      staged,
      factSuccessor,
      finalSuccessor,
      encodedSidecars,
      encodedBundle,
      nextCheckpoint,
      nextContinuation,
      observerMaterializationSource,
    } = input;
    const { source } = staged;
    this.transaction(() => {
      this.assertBoundedObserverBoundaryStagingCurrent(staged.receipt, staged);
      for (const part of factSuccessor.parts) this.storeChunk(part);
      this.storeChunk(factSuccessor.root);
      for (const part of finalSuccessor.parts) this.storeChunk(part);
      this.storeChunk(finalSuccessor.root);
      for (const name of RUN_CONTINUATION_SIDECAR_NAMES) {
        this.storeChunk(encodedSidecars[name].chunk);
      }
      this.storeChunk(encodedBundle.chunk);

      if (this.failNextBoundedPublicationAfterChunkWrites) {
        this.failNextBoundedPublicationAfterChunkWrites = false;
        throw new Error("fixture injected bounded publication failure after chunk writes");
      }

      this.insertCheckpoint.run(
        nextCheckpoint.runId,
        nextCheckpoint.revision,
        nextCheckpoint.month,
        nextCheckpoint.stateHash,
        nextCheckpoint.createdAt,
      );
      const runUpdate = this.updateRun.run(
        finalSuccessor.root.hash,
        ...runColumnValues(finalSuccessor.run.meta),
        source.run.id,
        source.run.meta.revision,
        source.run.stateHash,
      );
      if (Number(runUpdate.changes) !== 1) {
        throw new RunWriteConflictError(
          `运行 ${source.run.id} 的 bounded 年度观察 run CAS 失败`,
        );
      }
      const continuationUpdate = this.updateRunContinuationCas.run(
        nextContinuation.revision,
        nextContinuation.stateHash,
        nextContinuation.rootSchemaVersion,
        nextContinuation.shellHash,
        nextContinuation.historyLineageId,
        nextContinuation.historyHeadHash,
        nextContinuation.eventCount,
        nextContinuation.tailEventId,
        nextContinuation.tailEventContentHash,
        nextContinuation.hotEventLimit,
        nextContinuation.bundleSchemaVersion,
        nextContinuation.bundleHash,
        nextContinuation.updatedAt,
        source.continuation.runId,
        source.continuation.revision,
        source.continuation.stateHash,
        source.continuation.bundleHash,
        source.continuation.updatedAt,
      );
      if (Number(continuationUpdate.changes) !== 1) {
        throw new RunWriteConflictError(
          `运行 ${source.run.id} 的 bounded 年度观察 continuation CAS 失败`,
        );
      }

      const persistedRun = this.runRow(finalSuccessor.run.id);
      const persistedContinuation = this.continuationRow(finalSuccessor.run.id);
      const persistedCheckpoint = this.exactCheckpointRow(
        nextCheckpoint.runId,
        nextCheckpoint.revision,
        nextCheckpoint.stateHash,
      );
      if (!persistedRun
        || !persistedContinuation
        || !persistedCheckpoint
        || !sameRunRow(finalSuccessor.run, persistedRun)
        || !sameRunContinuationRow(nextContinuation, persistedContinuation)
        || !sameExactRunCheckpointRow(nextCheckpoint, persistedCheckpoint)) {
        throw new RunWriteConflictError(
          `运行 ${source.run.id} 的 bounded 年度观察 authority 回读失配`,
        );
      }
      const persistedFactRoot = snapshotRunStateChunk(
        this.chunkRow(observerMaterializationSource.stateHash),
      );
      if (!sameChunkSnapshot(factSuccessor.root, persistedFactRoot)) {
        throw new RunWriteConflictError(
          `运行 ${source.run.id} 的 private fact root A 回读失配`,
        );
      }
      markReachableRunStateChunks(
        persistedFactRoot,
        (hash) => this.chunkRow(hash),
        { chunks: new Set<string>(), historyNodes: new Set<string>() },
      );
      const persistedFinalRoot = snapshotRunStateChunk(
        this.chunkRow(finalSuccessor.root.hash),
      );
      if (!sameChunkSnapshot(finalSuccessor.root, persistedFinalRoot)) {
        throw new RunWriteConflictError(
          `运行 ${source.run.id} 的 final materialized root B 回读失配`,
        );
      }
      const persistedBundleChunk = snapshotRunContinuationBundleChunk(
        this.chunkRow(nextContinuation.bundleHash),
      );
      const persistedBundle = decodeRunContinuationBundle(persistedBundleChunk);
      assertContinuationAuthority(
        persistedRun,
        persistedContinuation,
        persistedCheckpoint,
        persistedFinalRoot,
        parseRunStateRoot(persistedFinalRoot),
        persistedBundle,
      );
      if (!isDeepStrictEqual(
        persistedBundle.observerMaterializationSource,
        observerMaterializationSource,
      )) {
        throw new RunWriteConflictError(
          `运行 ${source.run.id} 的 bundle 没有保留 private fact root A`,
        );
      }
      for (const name of RUN_CONTINUATION_SIDECAR_NAMES) {
        const reference = contentHashReferenceFor(
          persistedBundle.sidecars[name],
          finalSuccessor.run.id,
          name,
        );
        const persistedSidecar = snapshotContinuationChunkIdentity(
          this.chunkRow(reference.hash),
        );
        const encoded = encodedSidecars[name];
        if (persistedSidecar.hash !== encoded.reference.hash
          || persistedSidecar.codec !== encoded.reference.codec
          || persistedSidecar.rawSize !== encoded.chunk.rawSize) {
          throw new RunWriteConflictError(
            `运行 ${source.run.id} 的 bounded 年度观察 sidecar ${name} 回读失配`,
          );
        }
      }
    });
  }

  /**
   * Consumes process-local capabilities only after the SQLite transaction
   * commits. A rollback therefore leaves the original staging receipt retryable.
   */
  private completeObserverBoundaryPublication(
    input: ObserverBoundaryPublicationFinalization,
  ): void {
    const source = input.staged.source as BoundedContinuationTokenRecord;
    source.spent = true;
    const registry = this.continuationTokenRegistry();
    registry.generationsByRun.set(source.runId, source.generation + 1);
    registry.physicalByRun.set(source.runId, Object.freeze({
      runId: source.runId,
      revision: input.finalSuccessor.run.meta.revision,
      stateHash: input.finalSuccessor.root.hash,
      sidecar: input.nextPhysicalIdentity,
      projection: input.finalPhysicalProjection,
    }));
    registry.stagedObserverBoundaryMonths.delete(input.staged.receipt);
    registry.stagedSuccessors.delete(input.factSuccessorReceipt);
    registry.stagedSuccessors.delete(input.finalSuccessorReceipt);
    registry.publishedObserverBoundaryMonths.set(
      input.publishedReceipt,
      input.publishedRecord,
    );
  }

  async stageBoundedNonProjectionMonth(
    id: string,
    label?: string,
  ): Promise<BoundedNonProjectionMonthStagingReceipt> {
    return this.nonProjectionPublication.stage(id, label);
  }

  async publishBoundedNonProjectionMonth(
    receipt: BoundedNonProjectionMonthStagingReceipt,
  ): Promise<BoundedNonProjectionMonthPublishedReceipt> {
    return this.nonProjectionPublication.publish(receipt);
  }

  /** Dedicated atomic adapter; generic SQLite capabilities stay private here. */
  private commitNonProjectionPublication(
    input: NonProjectionPublicationCommit,
  ): void {
    const {
      staged,
      successor,
      encodedSidecars,
      encodedBundle,
      nextCheckpoint,
      nextContinuation,
    } = input;
    const { source } = staged;
    try {
      this.transaction(() => {
        this.nonProjectionPublication.assertCurrentStaging(staged.receipt, staged);
        for (const part of successor.parts) this.storeChunk(part);
        this.storeChunk(successor.root);
        for (const name of RUN_CONTINUATION_SIDECAR_NAMES) {
          this.storeChunk(encodedSidecars[name].chunk);
        }
        this.storeChunk(encodedBundle.chunk);

        if (this.failNextBoundedPublicationAfterChunkWrites) {
          this.failNextBoundedPublicationAfterChunkWrites = false;
          throw new Error("fixture injected bounded publication failure after chunk writes");
        }

        this.insertCheckpoint.run(
          nextCheckpoint.runId,
          nextCheckpoint.revision,
          nextCheckpoint.month,
          nextCheckpoint.stateHash,
          nextCheckpoint.createdAt,
        );
        const runUpdate = this.updateRun.run(
          successor.root.hash,
          ...runColumnValues(successor.run.meta),
          source.run.id,
          source.run.meta.revision,
          source.run.stateHash,
        );
        if (Number(runUpdate.changes) !== 1) {
          throw new RunWriteConflictError(
            `运行 ${source.run.id} 的 bounded publication run CAS 失败`,
          );
        }
        const continuationUpdate = this.updateRunContinuationCas.run(
          nextContinuation.revision,
          nextContinuation.stateHash,
          nextContinuation.rootSchemaVersion,
          nextContinuation.shellHash,
          nextContinuation.historyLineageId,
          nextContinuation.historyHeadHash,
          nextContinuation.eventCount,
          nextContinuation.tailEventId,
          nextContinuation.tailEventContentHash,
          nextContinuation.hotEventLimit,
          nextContinuation.bundleSchemaVersion,
          nextContinuation.bundleHash,
          nextContinuation.updatedAt,
          source.continuation.runId,
          source.continuation.revision,
          source.continuation.stateHash,
          source.continuation.bundleHash,
          source.continuation.updatedAt,
        );
        if (Number(continuationUpdate.changes) !== 1) {
          throw new RunWriteConflictError(
            `运行 ${source.run.id} 的 bounded publication continuation CAS 失败`,
          );
        }

        const persistedRun = this.runRow(successor.run.id);
        const persistedContinuation = this.continuationRow(successor.run.id);
        const persistedCheckpoint = this.exactCheckpointRow(
          nextCheckpoint.runId,
          nextCheckpoint.revision,
          nextCheckpoint.stateHash,
        );
        if (!persistedRun
          || !persistedContinuation
          || !persistedCheckpoint
          || !sameRunRow(successor.run, persistedRun)
          || !sameRunContinuationRow(nextContinuation, persistedContinuation)
          || !sameExactRunCheckpointRow(nextCheckpoint, persistedCheckpoint)) {
          throw new RunWriteConflictError(
            `运行 ${source.run.id} 的 bounded publication authority 回读失配`,
          );
        }
        const persistedRoot = snapshotRunStateChunk(this.chunkRow(successor.root.hash));
        if (!sameChunkSnapshot(successor.root, persistedRoot)) {
          throw new RunWriteConflictError(
            `运行 ${source.run.id} 的 bounded publication root 回读失配`,
          );
        }
        const persistedBundleChunk = snapshotRunContinuationBundleChunk(
          this.chunkRow(nextContinuation.bundleHash),
        );
        const persistedBundle = decodeRunContinuationBundle(persistedBundleChunk);
        assertContinuationAuthority(
          persistedRun,
          persistedContinuation,
          persistedCheckpoint,
          persistedRoot,
          parseRunStateRoot(persistedRoot),
          persistedBundle,
        );
        for (const name of RUN_CONTINUATION_SIDECAR_NAMES) {
          const reference = contentHashReferenceFor(
            persistedBundle.sidecars[name],
            successor.run.id,
            name,
          );
          const persistedSidecar = snapshotContinuationChunkIdentity(
            this.chunkRow(reference.hash),
          );
          const encoded = encodedSidecars[name];
          if (persistedSidecar.hash !== encoded.reference.hash
            || persistedSidecar.codec !== encoded.reference.codec
            || persistedSidecar.rawSize !== encoded.chunk.rawSize) {
            throw new RunWriteConflictError(
              `运行 ${source.run.id} 的 bounded publication sidecar ${name} 回读失配`,
            );
          }
        }
        if (this.pruneRunCheckpoints(source.run.id)) {
          this.collectUnreferencedRunStateChunks(source as BoundedContinuationTokenRecord);
        }
      });
    } catch (error) {
      // Stale/CAS conflicts sever owned state; fixture/IO rollback keeps the
      // exact unchanged join, including its retryable receipt.
      if (error instanceof RunWriteConflictError) {
        const registry = this.continuationTokenRegistry();
        this.discardOwnedNonProjectionStaging(
          registry,
          staged.receipt,
          staged.stagedMonth,
        );
      }
      throw error;
    }
  }

  /** Consume and optionally warm process-local authority only after COMMIT. */
  private completeNonProjectionPublication(
    input: NonProjectionPublicationFinalization,
  ): void {
    const source = input.staged.source as BoundedContinuationTokenRecord;
    source.spent = true;
    const registry = this.continuationTokenRegistry();
    registry.generationsByRun.set(source.runId, source.generation + 1);
    registry.physicalByRun.set(source.runId, Object.freeze({
      runId: source.runId,
      revision: input.successor.run.meta.revision,
      stateHash: input.successor.root.hash,
      sidecar: input.nextPhysicalIdentity,
      projection: input.physicalProjection,
    }));
    this.discardOwnedNonProjectionStaging(
      registry,
      input.staged.receipt,
      input.staged.stagedMonth,
    );
    this.discardWarmNonProjectionContinuation(registry, source.runId);
    try {
      const prepared = input.prepareWarmContinuation();
      const sidecars = {} as Record<RunContinuationSidecarName, ContinuationChunkIdentity>;
      for (const name of RUN_CONTINUATION_SIDECAR_NAMES) {
        sidecars[name] = snapshotContinuationChunkIdentity({
          hash: input.encodedSidecars[name].chunk.hash,
          codec: input.encodedSidecars[name].chunk.codec,
          rawSize: input.encodedSidecars[name].chunk.rawSize,
          data: input.encodedSidecars[name].chunk.data,
        });
      }
      const generation = source.generation + 1;
      const warmToken = Object.freeze({
        kind: "bounded-evolution-continuation-token-v1",
        continuationReady: false,
      }) as BoundedEvolutionContinuationToken;
      registry.tokens.set(warmToken, {
        runId: source.runId,
        generation,
        spent: false,
        run: input.successor.run,
        continuation: input.nextContinuation,
        checkpoint: input.nextCheckpoint,
        root: input.successor.root,
        bundle: snapshotContinuationChunkIdentity({
          hash: input.encodedBundle.chunk.hash,
          codec: input.encodedBundle.chunk.codec,
          rawSize: input.encodedBundle.chunk.rawSize,
          data: input.encodedBundle.chunk.data,
        }),
        ...(source.observerMaterializationSource
          ? {
            observerMaterializationSource: source.observerMaterializationSource,
            observerMaterializationSourceRoot: source.observerMaterializationSourceRoot,
          }
          : {}),
        sidecars: Object.freeze(sidecars),
        artifacts: prepared.artifacts,
        shellReuseAuthority: source.shellReuseAuthority,
        shellReuseIdentity: input.successor.shellReuseIdentity,
      });
      registry.warmNonProjectionByRun.set(source.runId, Object.freeze({
        runId: source.runId,
        generation,
        revision: input.successor.run.meta.revision,
        stateHash: input.successor.root.hash,
        token: warmToken,
        state: prepared.state,
      }));
    } catch {
      // Authority is committed; warm normalization degrades to cold-open.
      this.discardWarmNonProjectionContinuation(registry, source.runId);
    }
    registry.publishedNonProjectionMonths.set(
      input.publishedReceipt,
      input.publishedRecord,
    );
  }

  /**
   * Encode and prove an exact history successor entirely in memory. This is a
   * non-authoritative staging seam: it writes no chunks or rows, does not
   * consume the source token, and its opaque receipt is not itself accepted by
   * the controller-only publication API.
   *
   * This general seam never retains a caller's mutable state. The Store-owned
   * non-projection controller may separately join its own just-stepped state to
   * this receipt/root/generation; no public receipt can supply or recover it.
   *
   * Existing continuation sidecars are decoded and retained privately by the
   * source token; this receipt alone can never commit the staged root.
   */
  async stageBoundedEvolutionSuccessor(
    tokenInput: BoundedEvolutionContinuationToken,
    state: SimulationState,
    label?: string,
  ): Promise<BoundedEvolutionSuccessorStagingReceipt> {
    return this.stageBoundedEvolutionSuccessorInternal(
      tokenInput,
      state,
      label,
      undefined,
    );
  }

  /**
   * The zero-event mode is reachable only from the two closed one-month
   * controllers above. Their stepped state remains store-owned behind a
   * controller receipt; this helper never exposes an opt-in flag publicly.
   */
  private async stageBoundedEvolutionSuccessorInternal(
    tokenInput: BoundedEvolutionContinuationToken,
    state: SimulationState,
    label: string | undefined,
    authority: typeof storeOwnedSingleMonthSuccessorAuthority | undefined,
    exactHistoryOwnerReceipt?: BoundedEvolutionSuccessorStagingReceipt,
  ): Promise<BoundedEvolutionSuccessorStagingReceipt> {
    const { token, record } = this.currentContinuationTokenRecord(tokenInput);
    this.assertContinuationTokenSnapshotCurrent(token, record);
    if (Number((state as { schemaVersion?: number }).schemaVersion) !== 17) {
      throw new Error("bounded successor staging 只接受 schemaVersion 17 状态");
    }
    if (state.clock.elapsedMonths <= record.run.meta.elapsedMonths) {
      throw new Error("bounded successor staging 必须推进到更晚月份");
    }
    if (authority === storeOwnedSingleMonthSuccessorAuthority
      && state.clock.elapsedMonths !== record.run.meta.elapsedMonths + 1) {
      throw new Error("store-owned bounded successor 必须恰好推进一个月");
    }

    const sourceRoot = parseRunStateRoot(record.root);
    const sourceBasis = evolutionBasisFor(record.run, sourceRoot);
    const suffix = historySuffixFromBoundedState(state, sourceBasis);
    const sameHistoryShell = suffix.length === 0;
    if (sameHistoryShell && authority !== storeOwnedSingleMonthSuccessorAuthority) {
      throw new Error("bounded successor staging 不接受零事件 shell 改写");
    }
    const registry = this.continuationTokenRegistry();
    const exactHistoryOwner = exactHistoryOwnerReceipt === undefined
      ? undefined
      : registry.stagedSuccessors.get(exactHistoryOwnerReceipt);
    if (exactHistoryOwnerReceipt !== undefined
      && (!exactHistoryOwner
        || authority !== storeOwnedSingleMonthSuccessorAuthority
        || exactHistoryOwner.sourceToken !== token
        || exactHistoryOwner.sourceGeneration !== record.generation
        || exactHistoryOwner.run.id !== record.runId
        || exactHistoryOwner.run.meta.revision !== record.run.meta.revision + 1
        || exactHistoryOwner.run.meta.elapsedMonths !== state.clock.elapsedMonths
        || exactHistoryOwner.run.meta.status !== state.civilization.status
        || exactHistoryOwner.suffixEventCount !== suffix.length
        || exactHistoryOwner.metadata.eventCount !== state.world.historyCursor?.eventCount
        || !stagedHistoryTransitionMatchesSource(sourceRoot, exactHistoryOwner))) {
      throw new Error(
        "bounded successor exact-history reuse 不是当前 store generation 的 private fact root",
      );
    }
    const ownsMutableSuccessor = authority === storeOwnedSingleMonthSuccessorAuthority;
    // Freeze/replace only behind the closed store-owned controller. The public
    // staging seam remains observational and must never mutate caller state.
    if (ownsMutableSuccessor) stabilizeCompletedProjectsForRunStateShellReuse(state);
    let stateForEncoding = state;
    if ((state.world.historyCursor?.hotStartIndex ?? 0) > 0) {
      const world = { ...state.world };
      delete world.historyCursor;
      stateForEncoding = { ...state, world };
    }

    const previousShellOwner = exactHistoryOwner ?? record;
    const previousShellReuseIdentity = previousShellOwner.shellReuseIdentity;
    const encoded = await encodeSegmentedRunStateFromHistorySuffix(
      stateForEncoding,
      exactHistoryOwner
        ? { ...runHistoryCursorFromRootMetadata(exactHistoryOwner.metadata) }
        : { ...sourceBasis.history },
      exactHistoryOwner ? [] : suffix,
      ownsMutableSuccessor
        ? {
          shellReuse: {
            authority: record.shellReuseAuthority,
            ...(previousShellReuseIdentity
              ? {
                previousRoot: previousShellOwner.root,
                previousIdentity: previousShellReuseIdentity,
              }
              : {}),
          },
        }
        : {},
    );
    if (ownsMutableSuccessor && !encoded.shellReuseIdentity) {
      throw new Error("bounded successor shell encode 未生成 run-scoped reuse identity");
    }
    this.assertContinuationTokenSnapshotCurrent(token, record);

    // These codec-owned compressed chunks are never exposed to the caller.
    // Retain their internal references instead of copying every shell part and
    // doubling the staging peak (some immutable shell chunks may come from the
    // codec's bounded process-local cache).
    const root = encoded.root;
    const partsByHash = new Map<string, RunStateChunk>();
    let stagedBytes = root.data.byteLength;
    if (stagedBytes > MAX_BOUNDED_SUCCESSOR_STAGED_BYTES) {
      throw new Error(
        `bounded successor staging 超过 ${MAX_BOUNDED_SUCCESSOR_STAGED_BYTES} bytes 硬上限`,
      );
    }
    for (const encodedPart of encoded.parts) {
      const part = encodedPart;
      const existing = partsByHash.get(part.hash);
      if (existing) {
        if (existing.codec !== part.codec
          || existing.rawSize !== part.rawSize
          || !sameBytes(existing.data, part.data)) {
          throw new Error(`bounded successor staging chunk ${part.hash} 内容寻址冲突`);
        }
        continue;
      }
      stagedBytes += part.data.byteLength;
      if (stagedBytes > MAX_BOUNDED_SUCCESSOR_STAGED_BYTES) {
        throw new Error(
          `bounded successor staging 超过 ${MAX_BOUNDED_SUCCESSOR_STAGED_BYTES} bytes 硬上限`,
        );
      }
      partsByHash.set(part.hash, part);
    }
    const metadata = Object.freeze({ ...parseRunStateRoot(root) });
    const nextMeta = summaryFor(
      record.run.id,
      state,
      metadata.eventCount,
      record.run.meta,
      label,
    );
    if (nextMeta.revision !== record.run.meta.revision + 1) {
      throw new Error("bounded successor staging revision 不是 source revision + 1");
    }
    const nextRun: RunRow = Object.freeze({
      id: record.run.id,
      stateHash: root.hash,
      meta: Object.freeze({ ...nextMeta }),
    });
    assertDecodedRunSummary(nextRun, state);

    if (exactHistoryOwner) {
      const sharedHistory = verifyRunStateSameHistoryShellSuccessor(
        exactHistoryOwner.root,
        root,
      );
      if (sharedHistory.previousRootHash !== exactHistoryOwner.root.hash
        || sharedHistory.nextRootHash !== root.hash
        || sharedHistory.suffixEventCount !== 0
        || sharedHistory.next.eventCount !== metadata.eventCount) {
        throw new Error("bounded successor 未精确复用 private fact root 历史");
      }
    }
    const readStagedChunk = (hash: string): RunStateChunk => {
      if (hash === root.hash) return root;
      const currentPart = partsByHash.get(hash);
      if (currentPart) return currentPart;
      if (exactHistoryOwner) {
        if (hash === exactHistoryOwner.root.hash) return exactHistoryOwner.root;
        const ownerPart = exactHistoryOwner.parts.find((part) => part.hash === hash);
        if (ownerPart) return ownerPart;
      }
      return snapshotRunStateChunk(this.chunkRow(hash));
    };
    const verified = sameHistoryShell
      ? verifyRunStateSameHistoryShellSuccessor(record.root, root)
      : await streamVerifiedRunHistorySuccessorSegments(
        record.root,
        root,
        readStagedChunk,
        () => undefined,
      );
    this.assertContinuationTokenSnapshotCurrent(token, record);
    if (verified.previousRootHash !== record.root.hash
      || verified.nextRootHash !== root.hash
      || verified.suffixEventCount !== suffix.length
      || verified.next.eventCount !== metadata.eventCount) {
      throw new Error("bounded successor staging 未通过 exact successor receipt 校验");
    }

    const receipt = Object.freeze({
      kind: "bounded-evolution-successor-staging-receipt-v1",
      persisted: false,
      continuationReady: false,
    }) as BoundedEvolutionSuccessorStagingReceipt;
    this.continuationTokenRegistry().stagedSuccessors.set(receipt, {
      sourceToken: token,
      sourceGeneration: record.generation,
      run: nextRun,
      root,
      parts: Object.freeze([...partsByHash.values()]),
      metadata,
      suffixEventCount: verified.suffixEventCount,
      historyTransition: sameHistoryShell ? "same-history-shell" : "appended-events",
      ...(encoded.shellReuseIdentity
        ? { shellReuseIdentity: encoded.shellReuseIdentity }
        : {}),
    });
    return receipt;
  }
  /**
   * Establish the first bounded continuation for the current exact run root
   * without advancing time or rewriting any run/checkpoint/root authority.
   *
   * Every historical reducer is built outside SQLite from verified schema-3
   * streams. Schema-2 roots keep their legacy monolithic observer blob and
   * must be rewritten through the normal full-load migration path first. The
   * only write phase is one short transaction containing the five
   * sidecars, their bundle, and a non-upserting continuation INSERT. A coherent
   * old read therefore cannot attach artifacts to a newer run generation.
   */
  async bootstrapBoundedEvolutionContinuation(
    id: string,
    hotEventLimit = DEFAULT_BOUNDED_CONTINUATION_HOT_EVENT_LIMIT,
  ): Promise<BoundedEvolutionContinuationBootstrapReceipt> {
    if (!Number.isSafeInteger(hotEventLimit)
      || hotEventLimit < 1
      || hotEventLimit > MAX_RUN_CONTINUATION_HOT_EVENTS) {
      throw new Error(
        `bounded continuation hotEventLimit 必须是 1-${MAX_RUN_CONTINUATION_HOT_EVENTS} 的安全整数`,
      );
    }
    const normalizedId = normalizeId(id);
    const source = this.boundedContinuationBootstrapSource(normalizedId);
    const {
      continuation,
      encodedSidecars,
      encodedBundle,
      physicalProjection,
    } = await this.continuationArtifactMaterialization.buildBoundedContinuationArtifacts(
      source,
      hotEventLimit,
      () => this.assertBoundedContinuationBootstrapSourceCurrent(source),
      "bootstrap",
    );

    this.transaction(() => {
      this.assertBoundedContinuationBootstrapSourceCurrent(source);
      for (const name of RUN_CONTINUATION_SIDECAR_NAMES) {
        this.storeChunk(encodedSidecars[name].chunk);
      }
      this.storeChunk(encodedBundle.chunk);
      const inserted = this.insertRunContinuation.run(
        continuation.runId,
        continuation.revision,
        continuation.stateHash,
        continuation.rootSchemaVersion,
        continuation.shellHash,
        continuation.historyLineageId,
        continuation.historyHeadHash,
        continuation.eventCount,
        continuation.tailEventId,
        continuation.tailEventContentHash,
        continuation.hotEventLimit,
        continuation.bundleSchemaVersion,
        continuation.bundleHash,
        continuation.updatedAt,
      );
      if (Number(inserted.changes) !== 1) {
        throw new RunWriteConflictError(
          `运行 ${source.run.id} 的 bounded continuation INSERT 未写入唯一 authority`,
        );
      }

      const persistedRun = this.runRow(source.run.id);
      const persistedCheckpoint = this.exactCheckpointRow(
        source.run.id,
        source.run.meta.revision,
        source.run.stateHash,
      );
      const persistedContinuation = this.continuationRow(source.run.id);
      const persistedRoot = snapshotRunStateChunk(this.chunkRow(source.root.hash));
      if (!persistedRun
        || !persistedCheckpoint
        || !persistedContinuation
        || !sameRunRow(source.run, persistedRun)
        || !sameExactRunCheckpointRow(source.checkpoint, persistedCheckpoint)
        || !sameChunkSnapshot(source.root, persistedRoot)
        || !sameRunContinuationRow(continuation, persistedContinuation)) {
        throw new RunWriteConflictError(
          `运行 ${source.run.id} 的 bounded continuation bootstrap authority 回读失配`,
        );
      }
      const persistedBundleChunk = snapshotRunContinuationBundleChunk(
        this.chunkRow(continuation.bundleHash),
      );
      const persistedBundle = decodeRunContinuationBundle(persistedBundleChunk);
      assertContinuationAuthority(
        persistedRun,
        persistedContinuation,
        persistedCheckpoint,
        persistedRoot,
        parseRunStateRoot(persistedRoot),
        persistedBundle,
      );
      for (const name of RUN_CONTINUATION_SIDECAR_NAMES) {
        const reference = contentHashReferenceFor(
          persistedBundle.sidecars[name],
          source.run.id,
          name,
        );
        const persistedSidecar = snapshotContinuationChunkIdentity(
          this.chunkRow(reference.hash),
        );
        const encoded = encodedSidecars[name];
        if (persistedSidecar.hash !== encoded.reference.hash
          || persistedSidecar.codec !== encoded.reference.codec
          || persistedSidecar.rawSize !== encoded.chunk.rawSize) {
          throw new RunWriteConflictError(
            `运行 ${source.run.id} 的 bounded continuation bootstrap sidecar ${name} 回读失配`,
          );
        }
      }
    });

    this.continuationTokenRegistry().physicalByRun.set(source.run.id, Object.freeze({
      runId: source.run.id,
      revision: source.run.meta.revision,
      stateHash: source.root.hash,
      sidecar: snapshotContinuationChunkIdentity({
        hash: encodedSidecars.physical.chunk.hash,
        codec: encodedSidecars.physical.chunk.codec,
        rawSize: encodedSidecars.physical.chunk.rawSize,
        data: encodedSidecars.physical.chunk.data,
      }),
      projection: physicalProjection,
    }));
    return Object.freeze({
      kind: "bounded-evolution-continuation-bootstrap-receipt-v1",
      persisted: true as const,
      continuationReady: false as const,
    }) as BoundedEvolutionContinuationBootstrapReceipt;
  }

  /**
   * Rebuild every bounded continuation sidecar for the current exact root.
   * Time, run authority, checkpoint and root are immutable inputs; only the
   * continuation bundle is replaced by CAS after an external verified stream.
   */
  async refreshBoundedEvolutionContinuation(
    id: string,
    hotEventLimit?: number,
  ): Promise<BoundedEvolutionContinuationRefreshReceipt> {
    const normalizedId = normalizeId(id);
    const source = this.boundedContinuationRefreshSource(normalizedId);
    const selectedHotEventLimit = hotEventLimit ?? source.continuation.hotEventLimit;
    if (!Number.isSafeInteger(selectedHotEventLimit)
      || selectedHotEventLimit < 1
      || selectedHotEventLimit > MAX_RUN_CONTINUATION_HOT_EVENTS) {
      throw new Error(
        `bounded continuation hotEventLimit 必须是 1-${MAX_RUN_CONTINUATION_HOT_EVENTS} 的安全整数`,
      );
    }

    const {
      continuation,
      encodedSidecars,
      encodedBundle,
      physicalProjection,
    } = await this.continuationArtifactMaterialization.buildBoundedContinuationArtifacts(
      source,
      selectedHotEventLimit,
      () => this.assertBoundedContinuationRefreshSourceCurrent(source),
      "refresh",
      source.bundle.observerMaterializationSource,
    );

    this.transaction(() => {
      this.assertBoundedContinuationRefreshSourceCurrent(source);
      for (const name of RUN_CONTINUATION_SIDECAR_NAMES) {
        this.storeChunk(encodedSidecars[name].chunk);
      }
      this.storeChunk(encodedBundle.chunk);
      if (this.failNextBoundedPublicationAfterChunkWrites) {
        this.failNextBoundedPublicationAfterChunkWrites = false;
        throw new Error("fixture injected bounded publication failure after chunk writes");
      }

      const continuationUpdate = this.updateRunContinuationCas.run(
        continuation.revision,
        continuation.stateHash,
        continuation.rootSchemaVersion,
        continuation.shellHash,
        continuation.historyLineageId,
        continuation.historyHeadHash,
        continuation.eventCount,
        continuation.tailEventId,
        continuation.tailEventContentHash,
        continuation.hotEventLimit,
        continuation.bundleSchemaVersion,
        continuation.bundleHash,
        continuation.updatedAt,
        source.continuation.runId,
        source.continuation.revision,
        source.continuation.stateHash,
        source.continuation.bundleHash,
        source.continuation.updatedAt,
      );
      if (Number(continuationUpdate.changes) !== 1) {
        throw new RunWriteConflictError(
          `运行 ${source.run.id} 的 bounded continuation refresh CAS 失败`,
        );
      }

      const persistedRun = this.runRow(source.run.id);
      const persistedCheckpoint = this.exactCheckpointRow(
        source.run.id,
        source.run.meta.revision,
        source.run.stateHash,
      );
      const persistedContinuation = this.continuationRow(source.run.id);
      const persistedRoot = snapshotRunStateChunk(this.chunkRow(source.root.hash));
      if (!persistedRun
        || !persistedCheckpoint
        || !persistedContinuation
        || !sameRunRow(source.run, persistedRun)
        || !sameExactRunCheckpointRow(source.checkpoint, persistedCheckpoint)
        || !sameChunkSnapshot(source.root, persistedRoot)
        || !sameRunContinuationRow(continuation, persistedContinuation)) {
        throw new RunWriteConflictError(
          `运行 ${source.run.id} 的 bounded continuation refresh authority 回读失配`,
        );
      }
      const persistedBundleChunk = snapshotRunContinuationBundleChunk(
        this.chunkRow(continuation.bundleHash),
      );
      const persistedBundle = decodeRunContinuationBundle(persistedBundleChunk);
      assertContinuationAuthority(
        persistedRun,
        persistedContinuation,
        persistedCheckpoint,
        persistedRoot,
        parseRunStateRoot(persistedRoot),
        persistedBundle,
      );
      if (!isDeepStrictEqual(
        persistedBundle.observerMaterializationSource,
        source.bundle.observerMaterializationSource,
      )) {
        throw new RunWriteConflictError(
          `运行 ${source.run.id} 的 bounded continuation refresh 丢失 observer source`,
        );
      }
      for (const name of RUN_CONTINUATION_SIDECAR_NAMES) {
        const reference = contentHashReferenceFor(
          persistedBundle.sidecars[name],
          source.run.id,
          name,
        );
        const persistedSidecar = snapshotContinuationChunkIdentity(
          this.chunkRow(reference.hash),
        );
        const encoded = encodedSidecars[name];
        if (persistedSidecar.hash !== encoded.reference.hash
          || persistedSidecar.codec !== encoded.reference.codec
          || persistedSidecar.rawSize !== encoded.chunk.rawSize) {
          throw new RunWriteConflictError(
            `运行 ${source.run.id} 的 bounded continuation refresh sidecar ${name} 回读失配`,
          );
        }
      }
    });

    // A same-revision manifest replacement invalidates every previously
    // opened token and all receipts staged from it. Cache only the new physical
    // sidecar identity after COMMIT succeeds.
    const registry = this.continuationTokenRegistry();
    this.discardWarmNonProjectionContinuation(registry, source.run.id);
    const staleOwnedStaging = registry.ownedNonProjectionByRun.get(source.run.id);
    if (staleOwnedStaging) {
      this.discardOwnedNonProjectionStaging(
        registry,
        staleOwnedStaging.receipt,
        staleOwnedStaging.staging,
      );
    }
    registry.generationsByRun.set(
      source.run.id,
      (registry.generationsByRun.get(source.run.id) ?? 0) + 1,
    );
    registry.physicalByRun.set(source.run.id, Object.freeze({
      runId: source.run.id,
      revision: source.run.meta.revision,
      stateHash: source.root.hash,
      sidecar: snapshotContinuationChunkIdentity({
        hash: encodedSidecars.physical.chunk.hash,
        codec: encodedSidecars.physical.chunk.codec,
        rawSize: encodedSidecars.physical.chunk.rawSize,
        data: encodedSidecars.physical.chunk.data,
      }),
      projection: physicalProjection,
    }));
    return Object.freeze({
      kind: "bounded-evolution-continuation-refresh-receipt-v1",
      persisted: true as const,
      continuationReady: false as const,
    }) as BoundedEvolutionContinuationRefreshReceipt;
  }

  /**
   * Closed read boundary for a persisted bounded continuation. The manifest,
   * its exact run root and every content-addressed sidecar are store-selected;
   * callers cannot supply pins or replace any authority input.
   *
   * The returned token is never accepted directly by a commit path. Only a
   * controller-minted one-month receipt may reach atomic publication, and the
   * physical sidecar is bootstrapped/cached against the verified exact root.
   * `continuationReady` stays false because annual observer materialization and
   * its declared continuation gaps remain outside this non-projection slice.
   */
  async openBoundedEvolutionContinuation(
    id: string,
  ): Promise<OpenedBoundedEvolutionContinuation> {
    const normalizedId = normalizeId(id);
    this.discardWarmNonProjectionContinuation(
      this.continuationTokenRegistry(),
      normalizedId,
    );
    const initialRun = this.runRow(normalizedId);
    if (!initialRun) throw new RunNotFoundError(`运行 ${normalizedId} 不存在`);
    const initialContinuation = this.continuationRow(normalizedId);
    if (!initialContinuation) {
      throw new Error(`运行 ${normalizedId} 没有已持久化的 bounded continuation`);
    }
    const initialCheckpoint = this.exactCheckpointRow(
      initialContinuation.runId,
      initialContinuation.revision,
      initialContinuation.stateHash,
    );
    if (!initialCheckpoint) {
      throw new Error(`运行 ${normalizedId} 的 continuation 缺少 exact checkpoint`);
    }

    const runSnapshot: RunRow = Object.freeze({
      id: initialRun.id,
      stateHash: initialRun.stateHash,
      meta: Object.freeze({ ...initialRun.meta }),
    });
    const continuationSnapshot = Object.freeze({ ...initialContinuation });
    const checkpointSnapshot = Object.freeze({ ...initialCheckpoint });
    const rootSnapshot = snapshotRunStateChunk(this.chunkRow(runSnapshot.stateHash));
    if (rootSnapshot.codec !== RUN_STATE_ROOT_CODEC) {
      throw new Error(`运行 ${normalizedId} 的 continuation root 不是 segmented state root`);
    }
    const rootMetadata = parseRunStateRoot(rootSnapshot);
    if (rootMetadata.schemaVersion !== 3) {
      throw new Error(`运行 ${normalizedId} 的 continuation root 不是可流式读取的 schema 3 root`);
    }

    const bundleSnapshot = snapshotRunContinuationBundleChunk(
      this.chunkRow(continuationSnapshot.bundleHash),
    );
    if (bundleSnapshot.hash !== continuationSnapshot.bundleHash) {
      throw new Error(`运行 ${normalizedId} 的 continuation bundle 引用发生替换`);
    }
    const bundle = decodeRunContinuationBundle(bundleSnapshot);
    assertContinuationAuthority(
      runSnapshot,
      continuationSnapshot,
      checkpointSnapshot,
      rootSnapshot,
      rootMetadata,
      bundle,
    );

    const materialized = await this.continuationArtifactMaterialization
      .materializeBoundedContinuationOpen({
        run: runSnapshot,
        checkpoint: checkpointSnapshot,
        root: rootSnapshot,
        metadata: rootMetadata,
        bundle,
      });
    const {
      state: openedState,
      pinnedEvents,
      observerMaterializationSourceRoot,
      sidecars,
      artifacts: {
        retention,
        physical,
        derivedObserver,
        civilizationObserver,
        checkpoint,
      },
    } = materialized;

    // The decoder is an async boundary. Re-read every authority row and every
    // bounded snapshot before minting; a coherent old read never authorizes a
    // newer run/manifest generation.
    const currentRun = this.runRow(normalizedId);
    const currentContinuation = this.continuationRow(normalizedId);
    const currentCheckpoint = this.exactCheckpointRow(
      continuationSnapshot.runId,
      continuationSnapshot.revision,
      continuationSnapshot.stateHash,
    );
    if (!currentRun
      || !currentContinuation
      || !currentCheckpoint
      || !sameRunRow(runSnapshot, currentRun)
      || !sameRunContinuationRow(continuationSnapshot, currentContinuation)
      || !sameExactRunCheckpointRow(checkpointSnapshot, currentCheckpoint)) {
      throw new RunWriteConflictError(
        `运行 ${normalizedId} 在 bounded continuation 打开期间已更新`,
      );
    }
    if (!sameChunkSnapshot(rootSnapshot, this.chunkRow(rootSnapshot.hash))
      || !sameChunkSnapshot(bundleSnapshot, this.chunkRow(bundleSnapshot.hash))) {
      throw new RunWriteConflictError(
        `运行 ${normalizedId} 的 continuation root 或 bundle 在打开期间已变化`,
      );
    }
    if (observerMaterializationSourceRoot
      && !sameChunkSnapshot(
        observerMaterializationSourceRoot,
        this.chunkRow(observerMaterializationSourceRoot.hash),
      )) {
      throw new RunWriteConflictError(
        `运行 ${normalizedId} 的 observer materialization source 在打开期间已变化`,
      );
    }
    for (const name of RUN_CONTINUATION_SIDECAR_NAMES) {
      if (!this.storedContinuationChunkIdentityCurrent(sidecars[name])) {
        throw new RunWriteConflictError(
          `运行 ${normalizedId} 的 continuation sidecar ${name} 在打开期间已变化`,
        );
      }
    }

    const registry = this.continuationTokenRegistry();
    registry.physicalByRun.set(normalizedId, Object.freeze({
      runId: normalizedId,
      revision: runSnapshot.meta.revision,
      stateHash: runSnapshot.stateHash,
      sidecar: sidecars.physical,
      projection: physical,
    }));
    const previousOwnedStaging = registry.ownedNonProjectionByRun.get(normalizedId);
    if (previousOwnedStaging) {
      this.discardOwnedNonProjectionStaging(
        registry,
        previousOwnedStaging.receipt,
        previousOwnedStaging.staging,
      );
    }
    const generation = (registry.generationsByRun.get(normalizedId) ?? 0) + 1;
    registry.generationsByRun.set(normalizedId, generation);
    const token = Object.freeze({
      kind: "bounded-evolution-continuation-token-v1",
      continuationReady: false,
    }) as BoundedEvolutionContinuationToken;
    registry.tokens.set(token, {
      runId: normalizedId,
      generation,
      spent: false,
      run: runSnapshot,
      continuation: continuationSnapshot,
      checkpoint: checkpointSnapshot,
      root: rootSnapshot,
      bundle: snapshotContinuationChunkIdentity({
        hash: bundleSnapshot.hash,
        codec: bundleSnapshot.codec,
        rawSize: bundleSnapshot.rawSize,
        data: bundleSnapshot.data,
      }),
      ...(bundle.observerMaterializationSource
        ? {
          observerMaterializationSource: Object.freeze({
            ...bundle.observerMaterializationSource,
          }),
          observerMaterializationSourceRoot,
        }
        : {}),
      sidecars: Object.freeze(sidecars),
      artifacts: Object.freeze({
        retention,
        physical,
        derivedObserver,
        civilizationObserver,
        checkpoint,
      }),
      shellReuseAuthority: Object.freeze({ runId: normalizedId }),
    });

    return {
      meta: { ...runSnapshot.meta },
      state: openedState,
      pinnedEvents,
      basis: evolutionBasisFor(runSnapshot, rootMetadata),
      continuationReady: false,
      continuationToken: token,
    };
  }

  async create(input: { id?: string; label?: string; state: SimulationState }): Promise<PersistedRun> {
    const id = normalizeId(input.id);
    if (this.runRow(id)) throw new RunAlreadyExistsError(`运行 ${id} 已存在`);

    const state = migrated(input.state);
    const snapshot = await encodeSegmentedRunState(state);
    const meta = summaryFor(id, state, snapshot.metadata.eventCount, undefined, input.label);

    this.transaction(() => {
      if (this.runRow(id)) throw new RunAlreadyExistsError(`运行 ${id} 已存在`);
      this.storeRunState(snapshot);
      this.insertRun.run(id, snapshot.root.hash, ...runColumnValues(meta));
      this.insertCheckpoint.run(id, meta.revision, meta.elapsedMonths, snapshot.root.hash, meta.updatedAt);
    });
    return { meta, state };
  }

  async save(
    id: string,
    stateInput: SimulationState,
    label?: string,
    options: SaveRunOptions = {},
  ): Promise<PersistedRun> {
    const normalizedId = normalizeId(id);
    const encodedAgainst = this.assertRunExists(normalizedId);
    const hasExpectedRevision = options.expectedRevision !== undefined;
    const hasExpectedStateHash = options.expectedStateHash !== undefined;
    if (hasExpectedRevision !== hasExpectedStateHash) {
      throw new Error("expectedRevision 与 expectedStateHash 必须同时提供");
    }
    if (hasExpectedRevision
      && (options.expectedRevision !== encodedAgainst.meta.revision
        || options.expectedStateHash !== encodedAgainst.stateHash)) {
      throw new RunWriteConflictError(
        `运行 ${normalizedId} 写入基线已过期：期望 revision ${options.expectedRevision} / ${options.expectedStateHash}，`
        + `当前为 revision ${encodedAgainst.meta.revision} / ${encodedAgainst.stateHash}`,
      );
    }
    if (Number((stateInput as { schemaVersion?: number }).schemaVersion) !== 17) {
      throw new Error("保存的运行状态必须是 schemaVersion 17");
    }
    // Long evolution already supplies an authoritative current-schema snapshot;
    // cloning/migrating it here would copy the entire event history every year.
    const state = stateInput;
    const previousMetadata = this.runStateRootMetadata(encodedAgainst.stateHash);
    const snapshot = await encodeSegmentedRunState(
      state,
      previousMetadata && previousMetadata.schemaVersion >= 2 && options.historyMode !== "replace"
        ? { mode: "append", previous: previousMetadata }
        : { mode: "replace" },
    );
    const next = summaryFor(
      encodedAgainst.id,
      state,
      snapshot.metadata.eventCount,
      encodedAgainst.meta,
      label,
    );

    const meta = this.transaction(() => {
      this.storeRunState(snapshot);
      const update = this.updateRun.run(
        snapshot.root.hash,
        ...runColumnValues(next),
        encodedAgainst.id,
        encodedAgainst.meta.revision,
        encodedAgainst.stateHash,
      );
      if (Number(update.changes) !== 1) {
        const current = this.runRow(normalizedId);
        throw new RunWriteConflictError(
          `运行 ${normalizedId} 在编码期间已更新：期望 revision ${encodedAgainst.meta.revision}`
          + ` / ${encodedAgainst.stateHash}，当前为 ${current
            ? `revision ${current.meta.revision} / ${current.stateHash}`
            : "不存在"}`,
        );
      }
      this.insertCheckpoint.run(
        encodedAgainst.id,
        next.revision,
        next.elapsedMonths,
        snapshot.root.hash,
        next.updatedAt,
      );
      if (this.pruneRunCheckpoints(encodedAgainst.id)) this.collectUnreferencedRunStateChunks();
      return next;
    });
    return { meta, state };
  }

  async saveFromHistorySuffix(
    id: string,
    state: SimulationState,
    basis: EvolutionRunBasis,
    label?: string,
  ): Promise<PersistedEvolutionSave> {
    const normalizedId = normalizeId(id);
    const encodedAgainst = this.assertEvolutionBasisCurrent(normalizedId, basis);
    const trustedBasis = evolutionBasisFor(encodedAgainst.row, encodedAgainst.metadata);
    if (Number((state as { schemaVersion?: number }).schemaVersion) !== 17) {
      throw new Error("保存的运行状态必须是 schemaVersion 17");
    }
    const suffix = historySuffixFromBoundedState(state, trustedBasis);

    // A bounded cursor describes the caller's resident suffix, whereas a full
    // decoder hydrates the complete ledger. Do not persist that local window
    // offset in the shell; both bounded and full loads reconstruct it from the
    // verified root they actually hydrate.
    let stateForEncoding = state;
    if ((state.world.historyCursor?.hotStartIndex ?? 0) > 0) {
      const world = { ...state.world };
      delete world.historyCursor;
      stateForEncoding = { ...state, world };
    }
    const snapshot = await encodeSegmentedRunStateFromHistorySuffix(
      stateForEncoding,
      { ...trustedBasis.history },
      suffix,
    );
    const next = summaryFor(
      encodedAgainst.row.id,
      state,
      snapshot.metadata.eventCount,
      encodedAgainst.row.meta,
      label,
    );

    const meta = this.transaction(() => {
      // Re-read and verify every CAS dimension before writing even a chunk.
      this.assertEvolutionBasisCurrent(normalizedId, trustedBasis);
      this.storeRunState(snapshot);
      const update = this.updateRun.run(
        snapshot.root.hash,
        ...runColumnValues(next),
        encodedAgainst.row.id,
        trustedBasis.revision,
        trustedBasis.stateHash,
      );
      if (Number(update.changes) !== 1) {
        const current = this.runRow(normalizedId);
        throw new RunWriteConflictError(
          `运行 ${normalizedId} 在 bounded suffix 编码期间已更新：期望 revision ${trustedBasis.revision}`
          + ` / ${trustedBasis.stateHash}，当前为 ${current
            ? `revision ${current.meta.revision} / ${current.stateHash}`
            : "不存在"}`,
        );
      }
      this.insertCheckpoint.run(
        encodedAgainst.row.id,
        next.revision,
        next.elapsedMonths,
        snapshot.root.hash,
        next.updatedAt,
      );
      if (this.pruneRunCheckpoints(encodedAgainst.row.id)) this.collectUnreferencedRunStateChunks();
      return next;
    });

    const nextRow: RunRow = {
      id: encodedAgainst.row.id,
      stateHash: snapshot.root.hash,
      meta,
    };
    return {
      meta,
      state,
      basis: evolutionBasisFor(nextRow, snapshot.metadata),
    };
  }

  async loadEvolutionPath(id: string): Promise<EvolutionPath | null> {
    return this.outputArtifacts.loadEvolutionPath(id);
  }

  async saveEvolutionPath(id: string, evolution: EvolutionPath): Promise<void> {
    await this.outputArtifacts.saveEvolutionPath(id, evolution);
  }

  async loadEvolutionReport(id: string): Promise<EvolutionReport | null> {
    return this.outputArtifacts.loadEvolutionReport(id);
  }

  async saveEvolutionReport(id: string, report: EvolutionReport): Promise<void> {
    await this.outputArtifacts.saveEvolutionReport(id, report);
  }

  async loadNarrativeEnhancements(id: string): Promise<NarrativeEnhancementArtifact | null> {
    return this.outputArtifacts.loadNarrativeEnhancements(id);
  }

  async saveNarrativeEnhancements(id: string, artifact: NarrativeEnhancementArtifact): Promise<void> {
    await this.outputArtifacts.saveNarrativeEnhancements(id, artifact);
  }
}

export { SqliteRunStore as SQLiteRunStore };
