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
import {
  retainedProjectPressureEvidenceForLivingSources,
  worldEventById,
} from "../src/game/eland/domain/event-index";
import { trimCommittedHistoryAfterPersistedCursor } from "../src/game/eland/domain/history";
import { rematerializePhysicalStructureIndex } from "../src/game/eland/domain/physical-structure-index";
import { livingPeople } from "../src/game/eland/domain/state-index";
import { hydrateWorld } from "../src/game/eland/world/grid";
import { stepOwnedBoundedNonProjectionMonth } from "./bounded-nonprojection-month-controller";
import {
  stepOwnedBoundedObserverBoundaryMonth,
  stepOwnedBoundedTerminalMonth,
  type BoundedObserverBoundaryKind,
  type BoundedObserverBoundaryMonthResult,
} from "./bounded-observer-boundary-month-controller";
import {
  materializeBoundedCertifiedCivilizationDevelopment,
} from "./bounded-observer-civilization-materializer";
import {
  materializeDecodedBoundedObserverDerivedSubset,
} from "./bounded-observer-derived-materializer";
import {
  assertLastMaterializedObserverBasis,
  materializeBoundedObserverHotShell,
  type LastMaterializedObserverBasis,
} from "./bounded-observer-hot-shell";
import {
  LAST_MATERIALIZED_OBSERVER_BASIS_FIELD,
  materializedObserverMilestoneCount,
} from "./bounded-gameplay-shell";
import { adoptStoreDecodedBoundedSimulationState } from "./bounded-simulation-adoption";
import {
  CHECKPOINT_ACCUMULATOR_CODEC,
  decodeCheckpointAccumulator,
  encodeCheckpointAccumulator,
  projectCheckpointAccumulatorFromVerifiedRunRoot,
  projectCheckpointAccumulatorFromVerifiedSuccessor,
  type CheckpointAccumulatorV1,
} from "./checkpoint-accumulator";
import {
  decodeObserverCivilizationHistorySidecar,
  encodeObserverCivilizationHistorySidecar,
  OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC,
  type ObserverCivilizationHistorySidecarPayloadV1,
} from "./civilization-history-codec";
import {
  beginObserverCivilizationHistoryProjection,
  finishObserverCivilizationHistoryProjection,
  foldVerifiedObserverCivilizationHistorySegment,
} from "./observer-civilization-history-projection";
import {
  assertVerifiedObserverCivilizationHistorySuccessor,
  projectObserverCivilizationHistoryFromVerifiedSuccessor,
} from "./observer-civilization-history-successor";
import type { EvolutionPath, EvolutionReport } from "./evolution-artifacts";
import {
  decodeHistoryRetentionSidecar,
  encodeHistoryRetentionSidecar,
  HISTORY_RETENTION_SIDECAR_CODEC,
  HISTORY_RETENTION_SIDECAR_LEGACY_CODEC,
} from "./history-retention-codec";
import {
  assertHistoryRetentionProjectionMatchesShell,
  beginHistoryRetentionProjection,
  finishHistoryRetentionProjection,
  foldHistoryRetentionSegment,
  type HistoryRetentionProjectionResult,
} from "./history-retention-projection";
import {
  assertHistoryRetentionProjectionMatchesVerifiedSuccessor,
  assertVerifiedHistoryRetentionSuccessor,
  projectHistoryRetentionFromVerifiedSuccessor,
} from "./history-retention-successor";
import { projectPressureColdMaterializationOrdinals } from "./retained-history-evidence";
import type { NarrativeEnhancementArtifact } from "./narrative-enhancements";
import {
  decodeObserverDerivedHistorySidecar,
  encodeObserverDerivedHistorySidecar,
  OBSERVER_DERIVED_HISTORY_SIDECAR_CODEC,
  type ObserverDerivedHistorySidecarPayloadV1,
} from "./observer-derived-history-codec";
import {
  collectObserverDerivedHistoryGenesisDemandFromVerifiedShell,
} from "./observer-derived-history-demand";
import {
  beginObserverDerivedHistoryProjection,
  finishObserverDerivedHistoryProjection,
  foldVerifiedObserverDerivedHistorySegment,
} from "./observer-derived-history-projection";
import {
  assertVerifiedObserverDerivedHistorySuccessor,
  projectObserverDerivedHistoryFromVerifiedSuccessor,
} from "./observer-derived-history-successor";
import {
  decodePhysicalStructureLedgerSidecar,
  encodePhysicalStructureLedgerSidecar,
  PHYSICAL_STRUCTURE_LEDGER_SIDECAR_CODEC,
} from "./physical-structure-ledger-codec";
import {
  bootstrapPhysicalStructureLedgerFromStrictDecodedSidecar,
  decodeBoundedGameplayRunStateWithPhysicalProjection,
  projectPhysicalStructureLedgerFromVerifiedSuccessor,
  type PhysicalStructureLedgerProjectionResult,
} from "./physical-structure-ledger-projection";
import {
  decodeRunContinuationBundle,
  encodeRunContinuationBundle,
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
  materializeVerifiedRunHistoryPinnedEvents,
  markReachableRunStateChunks,
  parseRunStateRoot,
  runHistoryCursorFromRootMetadata,
  snapshotRunStateChunk,
  streamVerifiedRunHistorySegments,
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
} from "./run-state-codec";
import {
  ELAND_DATABASE_FILENAME,
  ELAND_DATABASE_SCHEMA_VERSION,
  sqliteUserVersion,
  withSqliteSchemaTransaction,
} from "./sqlite-schema";

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

const SQLITE_BUSY_TIMEOUT_MS = 5_000;
/** Batch pruning keeps a 128-checkpoint recovery floor without running global GC every year. */
export const RUN_CHECKPOINT_RETENTION = 128;
export const RUN_CHECKPOINT_PRUNE_THRESHOLD = RUN_CHECKPOINT_RETENTION * 2;

const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const V8_BROTLI_CODEC = "v8-br-v1";
const ARTIFACT_EVOLUTION_PATH = "evolution-path";
const ARTIFACT_EVOLUTION_REPORT = "evolution-report";
const ARTIFACT_NARRATIVE_ENHANCEMENTS = "narrative-enhancements";
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
}

interface BoundedNonProjectionMonthStagingRecord {
  readonly sourceToken: object;
  readonly sourceGeneration: number;
  readonly runId: string;
  readonly sourceRootHash: string;
  readonly sourceMonth: number;
  readonly nextMonth: number;
  readonly nextRootHash: string;
  readonly successorReceipt: object;
  /** Store-owned state produced by the controller; never exposed by a receipt. */
  readonly ownedNextState: SimulationState;
}

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
  readonly factSuccessorReceipt: BoundedEvolutionSuccessorStagingReceipt;
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

interface BoundedContinuationBootstrapSourceSnapshot {
  readonly run: RunRow;
  readonly checkpoint: ExactRunCheckpointRow;
  readonly root: RunStateChunk;
  readonly metadata: Readonly<RunStateRootMetadata>;
}

interface BoundedContinuationRefreshSourceSnapshot
  extends BoundedContinuationBootstrapSourceSnapshot {
  readonly continuation: RunContinuationRow;
  readonly bundleChunk: ReturnType<typeof snapshotRunContinuationBundleChunk>;
  readonly bundle: Readonly<RunContinuationBundleV1>;
  readonly sidecars: Readonly<Record<RunContinuationSidecarName, ContinuationChunkIdentity>>;
  readonly observerMaterializationSourceRoot?: RunStateChunk;
}

interface BuiltBoundedContinuationArtifacts {
  readonly continuation: RunContinuationRow;
  readonly encodedSidecars: Readonly<{
    retention: ReturnType<typeof encodeHistoryRetentionSidecar>;
    physical: ReturnType<typeof encodePhysicalStructureLedgerSidecar>;
    derivedObserver: ReturnType<typeof encodeObserverDerivedHistorySidecar>;
    civilizationObserver: ReturnType<typeof encodeObserverCivilizationHistorySidecar>;
    checkpoint: ReturnType<typeof encodeCheckpointAccumulator>;
  }>;
  readonly encodedBundle: ReturnType<typeof encodeRunContinuationBundle>;
  readonly physicalProjection: Readonly<PhysicalStructureLedgerProjectionResult>;
}

const RUN_CONTINUATION_SIDECAR_NAMES = [
  "retention",
  "physical",
  "derivedObserver",
  "civilizationObserver",
  "checkpoint",
] as const;
type RunContinuationSidecarName = typeof RUN_CONTINUATION_SIDECAR_NAMES[number];

const boundedContinuationTokenRegistries = new WeakMap<object, BoundedContinuationTokenRegistry>();
/** Module-private capability; a runtime caller cannot forge it with a string flag. */
const storeOwnedSingleMonthSuccessorAuthority = Object.freeze({});

declare const boundedEvolutionContinuationTokenBrand: unique symbol;
declare const boundedEvolutionSuccessorStagingReceiptBrand: unique symbol;
declare const boundedNonProjectionMonthStagingReceiptBrand: unique symbol;
declare const boundedNonProjectionMonthPublishedReceiptBrand: unique symbol;
declare const boundedObserverBoundaryMonthStagingReceiptBrand: unique symbol;
declare const boundedObserverBoundaryMonthPublishedReceiptBrand: unique symbol;
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

/**
 * Opaque proof that the store itself opened, rule-stepped and staged exactly one
 * non-observation month. It is not a publication receipt and writes no SQLite
 * authority. The ordinary caller-supplied-state staging receipt stays private.
 */
export interface BoundedNonProjectionMonthStagingReceipt {
  readonly kind: "bounded-nonprojection-month-staging-receipt-v1";
  readonly persisted: false;
  readonly continuationReady: false;
  readonly [boundedNonProjectionMonthStagingReceiptBrand]: true;
}

/**
 * Store-owned proof that one controller-approved non-observation month and all
 * five successor sidecars were committed under one SQLite CAS transaction.
 * It grants no continuation authority and exposes no state or sidecar bytes.
 */
export interface BoundedNonProjectionMonthPublishedReceipt {
  readonly persisted: true;
  readonly continuationReady: false;
  readonly revision: number;
  readonly month: number;
  readonly stateHash: string;
  readonly [boundedNonProjectionMonthPublishedReceiptBrand]: true;
}

/**
 * Opaque store-owned join between one annual fact root A and its still-current
 * continuation token. It writes no SQLite authority and exposes neither root.
 */
export interface BoundedObserverBoundaryMonthStagingReceipt {
  readonly kind: "bounded-observer-boundary-month-staging-receipt-v1";
  readonly persisted: false;
  readonly continuationReady: false;
  readonly [boundedObserverBoundaryMonthStagingReceiptBrand]: true;
}

/**
 * Store-owned proof that one scheduled observer boundary or a closed
 * non-annual extinction probe was atomically published through private fact
 * root A and final materialized root B.
 */
export interface BoundedObserverBoundaryMonthPublishedReceipt {
  readonly kind: "bounded-observer-boundary-month-published-receipt-v1";
  readonly boundaryKind: BoundedObserverBoundaryKind;
  readonly persisted: true;
  readonly continuationReady: false;
  readonly revision: number;
  readonly month: number;
  readonly stateHash: string;
  readonly status: SimulationState["civilization"]["status"];
  /** Materialized stage read from authority root B, never inferred from index. */
  readonly stage: string;
  readonly [boundedObserverBoundaryMonthPublishedReceiptBrand]: true;
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

function attachedLastMaterializedObserverBasis(
  state: SimulationState,
): Readonly<LastMaterializedObserverBasis> {
  const basis = (state as unknown as Record<string, unknown>)[
    LAST_MATERIALIZED_OBSERVER_BASIS_FIELD
  ];
  assertLastMaterializedObserverBasis(basis);
  return basis;
}

function bindObserverBasisToPrivateFactRoot(
  state: SimulationState,
  source: Readonly<RunContinuationObserverMaterializationSourceV1>,
): Readonly<LastMaterializedObserverBasis> {
  const previous = attachedLastMaterializedObserverBasis(state);
  const rebound = structuredClone({
    ...previous,
    source: { ...source },
  }) as LastMaterializedObserverBasis;
  assertLastMaterializedObserverBasis(rebound);
  (state as unknown as Record<string, unknown>)[LAST_MATERIALIZED_OBSERVER_BASIS_FIELD] = rebound;
  return rebound;
}

function installBoundedObserverHotShell(
  state: SimulationState,
  source: Readonly<RunContinuationObserverMaterializationSourceV1>,
  lastMaterializedMilestoneCount: number,
  basis: Readonly<LastMaterializedObserverBasis>,
): void {
  const shell = materializeBoundedObserverHotShell({
    civilization: state.civilization,
    source,
    lastMaterializedMilestoneCount,
    lastMaterializedObserverBasis: basis,
  });
  state.civilization = structuredClone(shell.civilization) as SimulationState["civilization"];
  state.derived = structuredClone(shell.derived) as SimulationState["derived"];
  (state as unknown as Record<string, unknown>)[LAST_MATERIALIZED_OBSERVER_BASIS_FIELD] =
    structuredClone(shell.lastMaterializedObserverBasis);
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

function boundedObserverBoundaryMatchesState(
  kind: BoundedObserverBoundaryKind,
  state: SimulationState,
  targetMonth: number,
): boolean {
  const endpoint = state.civilization.conditions.endpoint;
  if (endpoint.kind !== "months"
    || state.clock.elapsedMonths !== targetMonth
    || state.civilization.outcome?.atMonth !== (
      kind === "annual" ? undefined : targetMonth
    )) {
    return false;
  }
  if (kind === "annual") {
    return targetMonth % 12 === 0
      && targetMonth < endpoint.value
      && state.civilization.status === "running"
      && state.civilization.outcome === undefined;
  }
  if (kind === "extinction") {
    return state.civilization.status === "ended"
      && state.civilization.outcome?.kind === "destroyed"
      && livingPeople(state).length === 0;
  }
  return targetMonth === endpoint.value
    && state.civilization.status === "ended"
    && state.civilization.outcome?.kind === "boundary"
    && livingPeople(state).length > 0;
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
  private readonly selectArtifactChunk: StatementSync;
  private readonly selectArtifactHash: StatementSync;
  private readonly upsertArtifact: StatementSync;
  private readonly deleteUnreferencedArtifactChunk: StatementSync;
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
    this.selectArtifactChunk = this.database.prepare(`
      SELECT chunks.hash, chunks.codec, chunks.raw_size, chunks.data
      FROM artifacts
      JOIN chunks ON chunks.hash = artifacts.chunk_hash
      WHERE artifacts.run_id = ? AND artifacts.kind = ?
    `);
    this.selectArtifactHash = this.database.prepare(`
      SELECT chunk_hash FROM artifacts WHERE run_id = ? AND kind = ?
    `);
    this.upsertArtifact = this.database.prepare(`
      INSERT INTO artifacts(run_id, kind, chunk_hash, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(run_id, kind) DO UPDATE SET
        chunk_hash = excluded.chunk_hash,
        updated_at = excluded.updated_at
    `);
    this.deleteUnreferencedArtifactChunk = this.database.prepare(`
      DELETE FROM chunks
      WHERE hash = ? AND codec = ?
        AND NOT EXISTS (SELECT 1 FROM runs WHERE state_hash = chunks.hash)
        AND NOT EXISTS (SELECT 1 FROM run_checkpoints WHERE state_hash = chunks.hash)
        AND NOT EXISTS (SELECT 1 FROM artifacts WHERE chunk_hash = chunks.hash)
    `);
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

  private currentBoundedNonProjectionMonthStaging(
    receiptInput: unknown,
  ): {
    receipt: object;
    stagedMonth: BoundedNonProjectionMonthStagingRecord;
    successor: BoundedEvolutionSuccessorStagingRecord;
    sourceToken: object;
    source: BoundedContinuationTokenRecord;
  } {
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
    const sourceRoot = parseRunStateRoot(current.record.root);
    if (!successor
      || current.record.runId !== stagedMonth.runId
      || current.record.generation !== stagedMonth.sourceGeneration
      || current.record.root.hash !== stagedMonth.sourceRootHash
      || successor.sourceToken !== current.token
      || successor.sourceGeneration !== current.record.generation
      || current.record.run.meta.elapsedMonths !== stagedMonth.sourceMonth
      || successor.run.id !== current.record.runId
      || successor.run.meta.revision !== current.record.run.meta.revision + 1
      || successor.run.meta.elapsedMonths !== stagedMonth.nextMonth
      || successor.run.stateHash !== successor.root.hash
      || successor.root.hash !== stagedMonth.nextRootHash
      || stagedMonth.ownedNextState.clock.elapsedMonths !== stagedMonth.nextMonth
      || stagedMonth.nextMonth !== stagedMonth.sourceMonth + 1
      || stagedMonth.nextMonth % 12 === 0
      || !stagedHistoryTransitionMatchesSource(sourceRoot, successor)) {
      this.discardOwnedNonProjectionStaging(registry, receiptInput, stagedMonth);
      throw new RunWriteConflictError(
        "bounded 非投影单月 receipt 与 source token/exact successor staging 失配",
      );
    }
    return {
      receipt: receiptInput,
      stagedMonth,
      successor,
      sourceToken: current.token,
      source: current.record,
    };
  }

  private assertBoundedPublicationStagingCurrent(
    receipt: object,
    expected: {
      readonly stagedMonth: BoundedNonProjectionMonthStagingRecord;
      readonly successor: BoundedEvolutionSuccessorStagingRecord;
      readonly sourceToken: object;
      readonly source: BoundedContinuationTokenRecord;
    },
  ): void {
    const current = this.currentBoundedNonProjectionMonthStaging(receipt);
    if (current.stagedMonth !== expected.stagedMonth
      || current.successor !== expected.successor
      || current.sourceToken !== expected.sourceToken
      || current.source !== expected.source) {
      throw new RunWriteConflictError(
        "bounded 非投影单月 staging join 在异步投影期间发生替换",
      );
    }
    this.assertContinuationTokenSnapshotCurrent(current.sourceToken, current.source);
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
    expected: {
      readonly stagedMonth: BoundedObserverBoundaryMonthStagingRecord;
      readonly factSuccessor: BoundedEvolutionSuccessorStagingRecord;
      readonly sourceToken: object;
      readonly source: BoundedContinuationTokenRecord;
    },
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
    try {
      this.currentBoundedNonProjectionMonthStaging(receipt);
      return true;
    } catch {
      return false;
    }
  }

  ownsBoundedNonProjectionMonthPublishedReceipt(
    receipt: unknown,
  ): receipt is BoundedNonProjectionMonthPublishedReceipt {
    if (this.closed
      || (typeof receipt !== "object" && typeof receipt !== "function")
      || receipt === null) {
      return false;
    }
    return this.continuationTokenRegistry().publishedNonProjectionMonths.has(receipt);
  }

  ownsBoundedObserverBoundaryMonthStagingReceipt(
    receipt: unknown,
  ): receipt is BoundedObserverBoundaryMonthStagingReceipt {
    try {
      this.currentBoundedObserverBoundaryMonthStaging(receipt);
      return true;
    } catch {
      return false;
    }
  }

  ownsBoundedObserverBoundaryMonthPublishedReceipt(
    receipt: unknown,
  ): receipt is BoundedObserverBoundaryMonthPublishedReceipt {
    if (this.closed
      || (typeof receipt !== "object" && typeof receipt !== "function")
      || receipt === null) {
      return false;
    }
    return this.continuationTokenRegistry().publishedObserverBoundaryMonths.has(receipt);
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
    const opened = await this.openBoundedEvolutionContinuation(id);
    const boundary = stepOwnedBoundedObserverBoundaryMonth(opened.state);
    return this.stageOwnedBoundedObserverBoundaryMonth(opened, boundary, label);
  }

  /**
   * Closed replay of one otherwise ordinary source month. It can stage only a
   * naturally produced, non-annual extinction; a still-running replay and every
   * configured observer boundary fail closed inside the controller.
   */
  async stageBoundedTerminalMonth(
    id: string,
    label?: string,
  ): Promise<BoundedObserverBoundaryMonthStagingReceipt> {
    const opened = await this.openBoundedEvolutionContinuation(id);
    const boundary = stepOwnedBoundedTerminalMonth(opened.state);
    if (boundary.receipt.kind !== "extinction") {
      throw new Error(
        `bounded terminal probe 不接受 ${boundary.receipt.kind} 边界`,
      );
    }
    return this.stageOwnedBoundedObserverBoundaryMonth(opened, boundary, label);
  }

  private async stageOwnedBoundedObserverBoundaryMonth(
    opened: OpenedBoundedEvolutionContinuation,
    boundary: Readonly<BoundedObserverBoundaryMonthResult>,
    label?: string,
  ): Promise<BoundedObserverBoundaryMonthStagingReceipt> {
    const sourceMonth = boundary.receipt.sourceMonth;
    if (opened.meta.elapsedMonths !== sourceMonth
      || boundary.receipt.projectCallCount !== 1
      || !boundedObserverBoundaryMatchesState(
        boundary.receipt.kind,
        boundary.state,
        boundary.receipt.targetMonth,
      )) {
      throw new Error(
        `bounded 观察边界 publication 的 ${boundary.receipt.kind} fact month 无效`,
      );
    }
    const factSuccessorReceipt = await this.stageBoundedEvolutionSuccessorInternal(
      opened.continuationToken,
      boundary.state,
      label,
      storeOwnedSingleMonthSuccessorAuthority,
    );
    const { token, record } = this.currentContinuationTokenRecord(opened.continuationToken);
    const factSuccessor = this.continuationTokenRegistry().stagedSuccessors.get(
      factSuccessorReceipt,
    );
    if (!factSuccessor
      || factSuccessor.sourceToken !== token
      || factSuccessor.sourceGeneration !== record.generation
      || factSuccessor.run.meta.status !== boundary.state.civilization.status
      || factSuccessor.run.meta.elapsedMonths !== boundary.receipt.targetMonth) {
      throw new Error(
        "bounded 观察边界月没有生成同一 store generation 的 private fact root A",
      );
    }
    const receipt = Object.freeze({
      kind: "bounded-observer-boundary-month-staging-receipt-v1",
      persisted: false,
      continuationReady: false,
    }) as BoundedObserverBoundaryMonthStagingReceipt;
    this.continuationTokenRegistry().stagedObserverBoundaryMonths.set(receipt, {
      sourceToken: token,
      sourceGeneration: record.generation,
      runId: record.runId,
      sourceMonth,
      targetMonth: boundary.receipt.targetMonth,
      boundaryKind: boundary.receipt.kind,
      factSuccessorReceipt,
    });
    return receipt;
  }

  /**
   * Publish one scheduled or proven-terminal observer boundary through two
   * immutable roots. Root A contains only the rule-produced fact month and is
   * retained as the observer input. Root B contains the compact materialized
   * observer shell and alone becomes run/continuation/checkpoint authority.
   */
  async publishBoundedObserverBoundaryMonth(
    receiptInput: BoundedObserverBoundaryMonthStagingReceipt,
  ): Promise<BoundedObserverBoundaryMonthPublishedReceipt> {
    const staged = this.currentBoundedObserverBoundaryMonthStaging(receiptInput);
    this.assertBoundedObserverBoundaryStagingCurrent(staged.receipt, staged);
    const { source, sourceToken, factSuccessor } = staged;
    if (factSuccessor.metadata.schemaVersion !== 3) {
      throw new Error("bounded 年度观察 publication 只接受 schema 3 private fact root A");
    }

    const privateChunkReader = (
      successor: BoundedEvolutionSuccessorStagingRecord,
      exactHistoryOwner?: BoundedEvolutionSuccessorStagingRecord,
    ): ((hash: string) => RunStateChunk) => {
      const chunks = new Map<string, RunStateChunk>();
      chunks.set(successor.root.hash, successor.root);
      const addPart = (part: RunStateChunk): void => {
        const existing = chunks.get(part.hash);
        if (existing
          && (existing.codec !== part.codec
            || existing.rawSize !== part.rawSize
            || !sameBytes(existing.data, part.data))) {
          throw new Error(`bounded 年度观察 staged chunk ${part.hash} 内容寻址冲突`);
        }
        chunks.set(part.hash, part);
      };
      for (const part of successor.parts) addPart(part);
      if (exactHistoryOwner) {
        for (const part of exactHistoryOwner.parts) addPart(part);
      }
      return (hash: string): RunStateChunk => chunks.get(hash) ?? this.chunkRow(hash);
    };

    const decodePrivateSuccessor = async (
      successor: BoundedEvolutionSuccessorStagingRecord,
      readChunk: (hash: string) => RunStateChunk,
      label: string,
    ) => {
      const decoded = await decodeSegmentedRunStateGameplayBounded(
        successor.root,
        readChunk,
        {
          hotEventLimit: source.continuation.hotEventLimit,
          observerAuthority: {
            stateHash: successor.root.hash,
            revision: successor.run.meta.revision,
            month: successor.run.meta.elapsedMonths,
            lastMaterializedMilestoneCount: source.run.meta.milestoneCount,
          },
        },
      );
      this.assertBoundedObserverBoundaryStagingCurrent(staged.receipt, staged);
      const state = decoded.state;
      const root = parseRunStateRoot(successor.root);
      const cursor = state.world.historyCursor;
      if (root.schemaVersion !== 3
        || root.schemaVersion !== successor.metadata.schemaVersion
        || root.shellHash !== successor.metadata.shellHash
        || root.lineageId !== successor.metadata.lineageId
        || root.historyHeadHash !== successor.metadata.historyHeadHash
        || root.eventCount !== successor.metadata.eventCount
        || root.tailEventContentHash !== successor.metadata.tailEventContentHash
        || !cursor
        || cursor.eventCount !== root.eventCount
        || cursor.eventCount - cursor.hotStartIndex !== state.world.past.length
        || cursor.tailEventId !== state.world.past.at(-1)?.id
        || successor.run.meta.eventCount !== root.eventCount
        || successor.run.meta.milestoneCount !== source.run.meta.milestoneCount
        || successor.run.meta.revision !== source.run.meta.revision + 1
        || successor.run.meta.elapsedMonths !== staged.stagedMonth.targetMonth
        || state.clock.elapsedMonths !== staged.stagedMonth.targetMonth
        || !boundedObserverBoundaryMatchesState(
          staged.stagedMonth.boundaryKind,
          state,
          staged.stagedMonth.targetMonth,
        )) {
        throw new Error(`bounded 观察边界 ${label} 的 root/shell/cursor/运行边界失配`);
      }
      assertDecodedRunSummary(successor.run, state);
      const authenticatedPhysicalIndex = state.world.physicalStructureIndex;
      if (!authenticatedPhysicalIndex) {
        throw new Error(`bounded 年度观察 ${label} 缺少 physicalStructureIndex v2 provenance`);
      }
      state.world.grid = hydrateWorld(state.world.grid);
      state.world.physicalStructureIndex = rematerializePhysicalStructureIndex(
        state,
        authenticatedPhysicalIndex,
      );
      return { state, root, cursor };
    };

    const projectSuccessors = async (
      successor: BoundedEvolutionSuccessorStagingRecord,
      state: SimulationState,
      root: Readonly<RunStateRootMetadata>,
      cursor: NonNullable<SimulationState["world"]["historyCursor"]>,
      readChunk: (hash: string) => RunStateChunk,
    ) => {
      const retention = await projectHistoryRetentionFromVerifiedSuccessor(
        source.artifacts.retention,
        source.root,
        state,
        successor.root,
        readChunk,
      );
      this.assertBoundedObserverBoundaryStagingCurrent(staged.receipt, staged);
      assertVerifiedHistoryRetentionSuccessor(
        retention,
        state,
        source.root.hash,
        successor.root.hash,
      );

      const physical = await projectPhysicalStructureLedgerFromVerifiedSuccessor(
        source.artifacts.physical,
        source.root,
        state,
        successor.root,
        readChunk,
      );
      this.assertBoundedObserverBoundaryStagingCurrent(staged.receipt, staged);

      const derived = await projectObserverDerivedHistoryFromVerifiedSuccessor({
        previous: source.artifacts.derivedObserver,
        previousRootChunk: source.root,
        nextState: state,
        nextRootChunk: successor.root,
        nextPhysicalProjection: physical,
        readChunk,
      });
      this.assertBoundedObserverBoundaryStagingCurrent(staged.receipt, staged);
      assertVerifiedObserverDerivedHistorySuccessor(derived);

      const civilization = await projectObserverCivilizationHistoryFromVerifiedSuccessor({
        previous: source.artifacts.civilizationObserver,
        previousRevision: source.run.meta.revision,
        previousRootChunk: source.root,
        nextRevision: successor.run.meta.revision,
        nextRootChunk: successor.root,
        nextState: state,
        readChunk,
      });
      this.assertBoundedObserverBoundaryStagingCurrent(staged.receipt, staged);
      assertVerifiedObserverCivilizationHistorySuccessor(civilization);

      const authority = Object.freeze({
        runId: successor.run.id,
        revision: successor.run.meta.revision,
        stateHash: successor.root.hash,
        rootSchemaVersion: root.schemaVersion,
        shellHash: root.shellHash,
        historyLineageId: root.lineageId,
        historyHeadHash: root.historyHeadHash,
        eventCount: root.eventCount,
        tailEventId: cursor.tailEventId,
        tailEventContentHash: root.tailEventContentHash,
      });
      const checkpoint = await projectCheckpointAccumulatorFromVerifiedSuccessor(
        source.artifacts.checkpoint,
        source.root,
        state,
        successor.root,
        readChunk,
        Object.freeze({ ...authority, month: successor.run.meta.elapsedMonths }),
      );
      this.assertBoundedObserverBoundaryStagingCurrent(staged.receipt, staged);
      return { retention, physical, derived, civilization, checkpoint, authority };
    };

    const observerMaterializationSource = Object.freeze({
      stateHash: factSuccessor.root.hash,
      revision: factSuccessor.run.meta.revision,
      month: factSuccessor.run.meta.elapsedMonths,
    }) satisfies Readonly<RunContinuationObserverMaterializationSourceV1>;
    let finalSuccessorReceipt!: BoundedEvolutionSuccessorStagingReceipt;
    {
      // Keep root A's decoded state and projection lifetimes inside this block.
      // Once B is staged, neither complete state is retained in the registry or
      // concurrently held while B is decoded below.
      const readFactChunk = privateChunkReader(factSuccessor);
      const decodedFact = await decodePrivateSuccessor(
        factSuccessor,
        readFactChunk,
        "private fact root A",
      );
      const factProjection = await projectSuccessors(
        factSuccessor,
        decodedFact.state,
        decodedFact.root,
        decodedFact.cursor,
        readFactChunk,
      );
      const factTarget = Object.freeze({
        stateHash: factSuccessor.root.hash,
        eventCount: decodedFact.root.eventCount,
        tailEventId: decodedFact.cursor.tailEventId,
      });
      const decodedFactDerived = decodeObserverDerivedHistorySidecar(
        factProjection.derived.encoded.chunk,
        {
          reference: factProjection.derived.encoded.reference,
          boundary: { target: factTarget },
        },
      );
      const factDerivedMaterialization = materializeDecodedBoundedObserverDerivedSubset(
        decodedFact.state,
        decodedFactDerived,
        factTarget,
      );
      const reboundBasis = bindObserverBasisToPrivateFactRoot(
        decodedFact.state,
        observerMaterializationSource,
      );
      const development = materializeBoundedCertifiedCivilizationDevelopment(
        decodedFact.state,
        reboundBasis,
        factTarget,
        factDerivedMaterialization,
        decodedFactDerived.projection,
      );
      installBoundedObserverHotShell(
        decodedFact.state,
        observerMaterializationSource,
        source.run.meta.milestoneCount,
        development.nextBasis,
      );
      if (materializedObserverMilestoneCount(decodedFact.state)
          !== source.run.meta.milestoneCount
        || !isDeepStrictEqual(
          attachedLastMaterializedObserverBasis(decodedFact.state).source,
          observerMaterializationSource,
        )) {
        throw new Error(
          "bounded 年度观察 root B hot shell 改写 milestone authority 或丢失 root A basis",
        );
      }

      // Root B is encoded from the same exact source token/history suffix. Its
      // only permitted difference from A is the observer-owned compact shell.
      finalSuccessorReceipt = await this.stageBoundedEvolutionSuccessorInternal(
        sourceToken as BoundedEvolutionContinuationToken,
        decodedFact.state,
        factSuccessor.run.meta.label,
        storeOwnedSingleMonthSuccessorAuthority,
        staged.stagedMonth.factSuccessorReceipt,
      );
    }
    this.assertBoundedObserverBoundaryStagingCurrent(staged.receipt, staged);
    const finalSuccessor = this.continuationTokenRegistry().stagedSuccessors.get(
      finalSuccessorReceipt,
    );
    if (!finalSuccessor
      || finalSuccessor.sourceToken !== sourceToken
      || finalSuccessor.sourceGeneration !== source.generation
      || finalSuccessor.root.hash === factSuccessor.root.hash
      || finalSuccessor.metadata.lineageId !== factSuccessor.metadata.lineageId
      || finalSuccessor.metadata.historyHeadHash !== factSuccessor.metadata.historyHeadHash
      || finalSuccessor.metadata.eventCount !== factSuccessor.metadata.eventCount
      || finalSuccessor.metadata.tailEventContentHash
        !== factSuccessor.metadata.tailEventContentHash
      || finalSuccessor.suffixEventCount !== factSuccessor.suffixEventCount) {
      throw new Error(
        "bounded 年度观察 final root B 没有严格复用 root A 的事实历史"
        + ` A=${JSON.stringify({
          hash: factSuccessor.root.hash,
          lineageId: factSuccessor.metadata.lineageId,
          historyHeadHash: factSuccessor.metadata.historyHeadHash,
          eventCount: factSuccessor.metadata.eventCount,
          tailEventContentHash: factSuccessor.metadata.tailEventContentHash,
          suffixEventCount: factSuccessor.suffixEventCount,
        })}`
        + ` B=${JSON.stringify({
          hash: finalSuccessor?.root.hash,
          lineageId: finalSuccessor?.metadata.lineageId,
          historyHeadHash: finalSuccessor?.metadata.historyHeadHash,
          eventCount: finalSuccessor?.metadata.eventCount,
          tailEventContentHash: finalSuccessor?.metadata.tailEventContentHash,
          suffixEventCount: finalSuccessor?.suffixEventCount,
        })}`,
      );
    }

    // Never reuse an A-target sidecar for authority B. Re-decode B and fold all
    // five exact successors from the original source token/root.
    const readFinalChunk = privateChunkReader(finalSuccessor, factSuccessor);
    const decodedFinal = await decodePrivateSuccessor(
      finalSuccessor,
      readFinalChunk,
      "final materialized root B",
    );
    const finalBasis = attachedLastMaterializedObserverBasis(decodedFinal.state);
    if (!isDeepStrictEqual(finalBasis.source, observerMaterializationSource)
      || finalBasis.milestoneCount !== source.run.meta.milestoneCount
      || finalBasis.stage !== decodedFinal.state.civilization.stage) {
      throw new Error("bounded 年度观察 final root B 的 materialization basis 无效");
    }
    const finalProjection = await projectSuccessors(
      finalSuccessor,
      decodedFinal.state,
      decodedFinal.root,
      decodedFinal.cursor,
      readFinalChunk,
    );
    const encodedSidecars = Object.freeze({
      retention: finalProjection.retention.encoded,
      physical: encodePhysicalStructureLedgerSidecar(finalProjection.physical),
      derivedObserver: finalProjection.derived.encoded,
      civilizationObserver: finalProjection.civilization.encoded,
      checkpoint: encodeCheckpointAccumulator(finalProjection.checkpoint),
    });

    const hotStartIndex = Math.max(
      0,
      decodedFinal.root.eventCount - source.continuation.hotEventLimit,
    );
    const coldPins = finalProjection.retention.projection.pins
      .filter((pin) => pin.absoluteIndex < hotStartIndex)
      .map((pin) => Object.freeze({
        absoluteIndex: pin.absoluteIndex,
        eventId: pin.eventId,
        leaseKeys: Object.freeze([...pin.leaseKeys]),
      }));
    const reopenableEventIds = new Set([
      ...decodedFinal.state.world.past.map((event) => event.id),
      ...coldPins.map((pin) => pin.eventId),
    ]);
    if (decodedFinal.state.lastStep.some((event) => !reopenableEventIds.has(event.id))) {
      throw new Error(
        "bounded 年度观察 final root B 的 hot window/retention pins 无法重开完整 lastStep",
      );
    }
    const encodedBundle = encodeRunContinuationBundle({
      schemaVersion: RUN_CONTINUATION_BUNDLE_SCHEMA_VERSION,
      historyMode: "bounded-hot-tail-plus-cold-pins-v1",
      authority: finalProjection.authority,
      hotEventLimit: source.continuation.hotEventLimit,
      hotStartIndex,
      coldPins,
      sidecars: {
        retention: encodedSidecars.retention.reference,
        physical: encodedSidecars.physical.reference,
        derivedObserver: encodedSidecars.derivedObserver.reference,
        civilizationObserver: encodedSidecars.civilizationObserver.reference,
        checkpoint: encodedSidecars.checkpoint.reference,
      },
      observerMaterializationSource,
    });
    assertRetentionPinsMatchBundle(
      finalSuccessor.run.id,
      finalProjection.retention.projection,
      encodedBundle.bundle,
    );

    const nextCheckpoint: ExactRunCheckpointRow = Object.freeze({
      runId: finalSuccessor.run.id,
      revision: finalSuccessor.run.meta.revision,
      month: finalSuccessor.run.meta.elapsedMonths,
      stateHash: finalSuccessor.root.hash,
      createdAt: finalSuccessor.run.meta.updatedAt,
    });
    const nextContinuation: RunContinuationRow = Object.freeze({
      runId: finalSuccessor.run.id,
      revision: finalSuccessor.run.meta.revision,
      stateHash: finalSuccessor.root.hash,
      rootSchemaVersion: decodedFinal.root.schemaVersion,
      shellHash: decodedFinal.root.shellHash,
      historyLineageId: decodedFinal.root.lineageId,
      historyHeadHash: decodedFinal.root.historyHeadHash,
      eventCount: decodedFinal.root.eventCount,
      tailEventId: decodedFinal.cursor.tailEventId,
      tailEventContentHash: decodedFinal.root.tailEventContentHash,
      hotEventLimit: source.continuation.hotEventLimit,
      bundleSchemaVersion: RUN_CONTINUATION_BUNDLE_SCHEMA_VERSION,
      bundleHash: encodedBundle.chunk.hash,
      updatedAt: finalSuccessor.run.meta.updatedAt,
    });
    assertContinuationAuthority(
      finalSuccessor.run,
      nextContinuation,
      nextCheckpoint,
      finalSuccessor.root,
      decodedFinal.root,
      encodedBundle.bundle,
    );

    const nextPhysicalIdentity = snapshotContinuationChunkIdentity({
      hash: encodedSidecars.physical.chunk.hash,
      codec: encodedSidecars.physical.chunk.codec,
      rawSize: encodedSidecars.physical.chunk.rawSize,
      data: encodedSidecars.physical.chunk.data,
    });
    const publishedReceipt = Object.freeze({
      kind: "bounded-observer-boundary-month-published-receipt-v1" as const,
      boundaryKind: staged.stagedMonth.boundaryKind,
      persisted: true as const,
      continuationReady: false as const,
      revision: finalSuccessor.run.meta.revision,
      month: finalSuccessor.run.meta.elapsedMonths,
      stateHash: finalSuccessor.root.hash,
      status: decodedFinal.state.civilization.status,
      stage: decodedFinal.state.civilization.stage,
    }) as BoundedObserverBoundaryMonthPublishedReceipt;

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

    // Only COMMIT consumes the source generation. A rollback keeps A staging
    // live, so the same opaque receipt can rebuild B and retry deterministically.
    source.spent = true;
    const registry = this.continuationTokenRegistry();
    registry.generationsByRun.set(source.runId, source.generation + 1);
    registry.physicalByRun.set(source.runId, Object.freeze({
      runId: source.runId,
      revision: finalSuccessor.run.meta.revision,
      stateHash: finalSuccessor.root.hash,
      sidecar: nextPhysicalIdentity,
      projection: finalProjection.physical,
    }));
    registry.stagedObserverBoundaryMonths.delete(staged.receipt);
    registry.stagedSuccessors.delete(staged.stagedMonth.factSuccessorReceipt);
    registry.stagedSuccessors.delete(finalSuccessorReceipt);
    registry.publishedObserverBoundaryMonths.set(publishedReceipt, Object.freeze({
      runId: source.runId,
      revision: finalSuccessor.run.meta.revision,
      month: finalSuccessor.run.meta.elapsedMonths,
      stateHash: finalSuccessor.root.hash,
      stage: decodedFinal.state.civilization.stage,
      boundaryKind: staged.stagedMonth.boundaryKind,
      status: decodedFinal.state.civilization.status,
    }));
    return publishedReceipt;
  }

  /**
   * Closed, non-persisting controller slice. The bounded state and continuation
   * token never leave this method: callers receive only a controller-branded
   * receipt privately joined to the ordinary exact-successor staging receipt.
   * Only `publishBoundedNonProjectionMonth` accepts that controller receipt;
   * the ordinary caller-state staging receipt remains non-authoritative.
   */
  async stageBoundedNonProjectionMonth(
    id: string,
    label?: string,
  ): Promise<BoundedNonProjectionMonthStagingReceipt> {
    const normalizedId = normalizeId(id);
    const warm = this.takeWarmNonProjectionContinuation(normalizedId);
    let ownedState: SimulationState;
    let continuationToken: BoundedEvolutionContinuationToken;
    if (warm) {
      ownedState = warm.state;
      continuationToken = warm.token;
    } else {
      const opened = await this.openBoundedEvolutionContinuation(normalizedId);
      ownedState = opened.state;
      continuationToken = opened.continuationToken;
    }
    const sourceMonth = ownedState.clock.elapsedMonths;
    const stepped = stepOwnedBoundedNonProjectionMonth(ownedState);
    const successorReceipt = await this.stageBoundedEvolutionSuccessorInternal(
      continuationToken,
      stepped,
      label,
      storeOwnedSingleMonthSuccessorAuthority,
    );
    const { token, record } = this.currentContinuationTokenRecord(continuationToken);
    const stagedSuccessor = this.continuationTokenRegistry().stagedSuccessors.get(successorReceipt);
    if (!stagedSuccessor
      || stagedSuccessor.sourceToken !== token
      || stagedSuccessor.sourceGeneration !== record.generation) {
      throw new Error("bounded 非投影单月没有生成同一 store generation 的 exact successor staging");
    }
    const receipt = Object.freeze({
      kind: "bounded-nonprojection-month-staging-receipt-v1",
      persisted: false,
      continuationReady: false,
    }) as BoundedNonProjectionMonthStagingReceipt;
    const staging: BoundedNonProjectionMonthStagingRecord = Object.freeze({
      sourceToken: token,
      sourceGeneration: record.generation,
      runId: record.runId,
      sourceRootHash: record.root.hash,
      sourceMonth,
      nextMonth: stepped.clock.elapsedMonths,
      nextRootHash: stagedSuccessor.root.hash,
      successorReceipt,
      ownedNextState: stepped,
    });
    const registry = this.continuationTokenRegistry();
    registry.stagedNonProjectionMonths.set(receipt, staging);
    registry.ownedNonProjectionByRun.set(record.runId, { receipt, staging });
    return receipt;
  }

  /**
   * Publish one store-stepped, non-observation month. The exact-successor root
   * and the controller-produced state are retained only behind the same private
   * receipt/source-generation join; callers cannot pair a receipt with a state
   * or any sidecar. Expensive exact-root folds finish before the synchronous
   * SQLite transaction, while rollback keeps the unchanged owned state retryable.
   */
  async publishBoundedNonProjectionMonth(
    receiptInput: BoundedNonProjectionMonthStagingReceipt,
  ): Promise<BoundedNonProjectionMonthPublishedReceipt> {
    const staged = this.currentBoundedNonProjectionMonthStaging(receiptInput);
    this.assertBoundedPublicationStagingCurrent(staged.receipt, staged);
    const { source, successor } = staged;
    if (successor.metadata.schemaVersion !== 2 && successor.metadata.schemaVersion !== 3) {
      throw new Error("bounded 非投影单月 publication 只接受 schema 2/3 staged root");
    }

    const stagedChunks = new Map<string, RunStateChunk>();
    stagedChunks.set(successor.root.hash, successor.root);
    for (const part of successor.parts) {
      const existing = stagedChunks.get(part.hash);
      if (existing
        && (existing.codec !== part.codec
          || existing.rawSize !== part.rawSize
          || !sameBytes(existing.data, part.data))) {
        throw new Error(`bounded publication staged chunk ${part.hash} 内容寻址冲突`);
      }
      stagedChunks.set(part.hash, part);
    }
    const readPublicationChunk = (hash: string): RunStateChunk => {
      const privateChunk = stagedChunks.get(hash);
      // Staged chunks are store-owned immutable values and persisted chunks
      // are returned from this private synchronous reader. Each async codec or
      // projection boundary takes the authority snapshot it needs, so copying
      // here would double every streamed part for no additional isolation.
      return privateChunk ?? this.chunkRow(hash);
    };

    const nextState = staged.stagedMonth.ownedNextState;
    const nextRoot = parseRunStateRoot(successor.root);
    const nextCursor = nextState.world.historyCursor;
    if ((nextRoot.schemaVersion !== 2 && nextRoot.schemaVersion !== 3)
      || nextRoot.schemaVersion !== successor.metadata.schemaVersion
      || nextRoot.shellHash !== successor.metadata.shellHash
      || nextRoot.lineageId !== successor.metadata.lineageId
      || nextRoot.historyHeadHash !== successor.metadata.historyHeadHash
      || nextRoot.eventCount !== successor.metadata.eventCount
      || nextRoot.tailEventContentHash !== successor.metadata.tailEventContentHash
      || !nextCursor
      || !Number.isSafeInteger(nextCursor.hotStartIndex)
      || nextCursor.hotStartIndex < 0
      || nextCursor.hotStartIndex > nextCursor.eventCount
      || nextCursor.eventCount !== nextRoot.eventCount
      || nextCursor.eventCount - nextCursor.hotStartIndex !== nextState.world.past.length
      || (nextCursor.eventCount === 0
        ? nextCursor.tailEventId !== null
        : typeof nextCursor.tailEventId !== "string")
      || (nextState.world.past.length > 0
        && nextCursor.tailEventId !== nextState.world.past.at(-1)?.id)
      || successor.run.meta.eventCount !== nextRoot.eventCount
      || successor.run.meta.milestoneCount !== source.run.meta.milestoneCount) {
      throw new Error("bounded publication 的 owned state/root/shell/cursor 失配");
    }
    if (nextState.civilization.status !== "running"
      || nextState.civilization.conditions.endpoint.kind !== "months"
      || staged.stagedMonth.nextMonth >= nextState.civilization.conditions.endpoint.value
      || staged.stagedMonth.nextMonth % 12 === 0
      || nextState.clock.elapsedMonths !== staged.stagedMonth.nextMonth) {
      throw new Error("bounded publication staged root 不再满足非投影单月资格");
    }
    assertDecodedRunSummary(successor.run, nextState);

    // Canonical sidecars must survive process restart, where a voxel grid has
    // revision zero. Re-hydrate only this grid buffer and rematerialize its
    // authenticated index; this is bounded shell normalization, not a second
    // gameplay/history decode.
    const authenticatedPhysicalIndex = nextState.world.physicalStructureIndex;
    if (!authenticatedPhysicalIndex) {
      throw new Error("bounded publication owned state 缺少 physicalStructureIndex v2 provenance");
    }
    nextState.world.grid = hydrateWorld(nextState.world.grid);
    nextState.world.physicalStructureIndex = rematerializePhysicalStructureIndex(
      nextState,
      authenticatedPhysicalIndex,
    );

    const retentionSuccessor = await projectHistoryRetentionFromVerifiedSuccessor(
      source.artifacts.retention,
      source.root,
      nextState,
      successor.root,
      readPublicationChunk,
    );
    this.assertBoundedPublicationStagingCurrent(staged.receipt, staged);
    assertVerifiedHistoryRetentionSuccessor(
      retentionSuccessor,
      nextState,
      source.root.hash,
      successor.root.hash,
    );

    const physicalSuccessor = await projectPhysicalStructureLedgerFromVerifiedSuccessor(
      source.artifacts.physical,
      source.root,
      nextState,
      successor.root,
      readPublicationChunk,
    );
    this.assertBoundedPublicationStagingCurrent(staged.receipt, staged);

    const derivedSuccessor = await projectObserverDerivedHistoryFromVerifiedSuccessor({
      previous: source.artifacts.derivedObserver,
      previousRootChunk: source.root,
      nextState,
      nextRootChunk: successor.root,
      nextPhysicalProjection: physicalSuccessor,
      readChunk: readPublicationChunk,
    });
    this.assertBoundedPublicationStagingCurrent(staged.receipt, staged);
    assertVerifiedObserverDerivedHistorySuccessor(derivedSuccessor);

    const civilizationSuccessor = await projectObserverCivilizationHistoryFromVerifiedSuccessor({
      previous: source.artifacts.civilizationObserver,
      previousRevision: source.run.meta.revision,
      previousRootChunk: source.root,
      nextRevision: successor.run.meta.revision,
      nextRootChunk: successor.root,
      nextState,
      readChunk: readPublicationChunk,
    });
    this.assertBoundedPublicationStagingCurrent(staged.receipt, staged);
    assertVerifiedObserverCivilizationHistorySuccessor(civilizationSuccessor);

    const nextAuthority = Object.freeze({
      runId: successor.run.id,
      revision: successor.run.meta.revision,
      stateHash: successor.root.hash,
      rootSchemaVersion: nextRoot.schemaVersion,
      shellHash: nextRoot.shellHash,
      historyLineageId: nextRoot.lineageId,
      historyHeadHash: nextRoot.historyHeadHash,
      eventCount: nextRoot.eventCount,
      tailEventId: nextCursor.tailEventId,
      tailEventContentHash: nextRoot.tailEventContentHash,
    });
    const nextBoundary = Object.freeze({
      ...nextAuthority,
      month: successor.run.meta.elapsedMonths,
    });
    const checkpointSuccessor = await projectCheckpointAccumulatorFromVerifiedSuccessor(
      source.artifacts.checkpoint,
      source.root,
      nextState,
      successor.root,
      readPublicationChunk,
      nextBoundary,
    );
    this.assertBoundedPublicationStagingCurrent(staged.receipt, staged);

    const encodedSidecars = Object.freeze({
      retention: retentionSuccessor.encoded,
      physical: encodePhysicalStructureLedgerSidecar(physicalSuccessor),
      derivedObserver: derivedSuccessor.encoded,
      civilizationObserver: civilizationSuccessor.encoded,
      checkpoint: encodeCheckpointAccumulator(checkpointSuccessor),
    });
    const hotStartIndex = Math.max(
      0,
      nextRoot.eventCount - source.continuation.hotEventLimit,
    );
    const coldPins = retentionSuccessor.projection.pins
      .filter((pin) => pin.absoluteIndex < hotStartIndex)
      .map((pin) => Object.freeze({
        absoluteIndex: pin.absoluteIndex,
        eventId: pin.eventId,
        leaseKeys: Object.freeze([...pin.leaseKeys]),
      }));
    const reopenableEventIds = new Set([
      ...nextState.world.past.map((event) => event.id),
      ...coldPins.map((pin) => pin.eventId),
    ]);
    if (nextState.lastStep.some((event) => !reopenableEventIds.has(event.id))) {
      throw new Error(
        "bounded publication 的 hot window/retention pins 无法重开完整 lastStep，拒绝持久化",
      );
    }
    const encodedBundle = encodeRunContinuationBundle({
      schemaVersion: RUN_CONTINUATION_BUNDLE_SCHEMA_VERSION,
      historyMode: "bounded-hot-tail-plus-cold-pins-v1",
      authority: nextAuthority,
      hotEventLimit: source.continuation.hotEventLimit,
      hotStartIndex,
      coldPins,
      sidecars: {
        retention: encodedSidecars.retention.reference,
        physical: encodedSidecars.physical.reference,
        derivedObserver: encodedSidecars.derivedObserver.reference,
        civilizationObserver: encodedSidecars.civilizationObserver.reference,
        checkpoint: encodedSidecars.checkpoint.reference,
      },
      ...(source.observerMaterializationSource
        ? { observerMaterializationSource: source.observerMaterializationSource }
        : {}),
    });
    assertRetentionPinsMatchBundle(
      successor.run.id,
      retentionSuccessor.projection,
      encodedBundle.bundle,
    );

    // Seal strict-decoder identities before publication so a successful COMMIT
    // can mint the next private generation without reopening the full root.
    const retentionBoundary = Object.freeze({
      authority: Object.freeze({ stateHash: successor.root.hash }),
      target: Object.freeze({
        eventCount: nextRoot.eventCount,
        tailEventId: nextCursor.tailEventId,
      }),
    });
    const observerTarget = Object.freeze({
      stateHash: successor.root.hash,
      eventCount: nextRoot.eventCount,
      tailEventId: nextCursor.tailEventId,
    });
    const warmArtifacts: BoundedContinuationVerifiedArtifacts = Object.freeze({
      retention: decodeHistoryRetentionSidecar(encodedSidecars.retention.chunk, {
        reference: encodedSidecars.retention.reference,
        boundary: retentionBoundary,
      }),
      physical: physicalSuccessor,
      derivedObserver: decodeObserverDerivedHistorySidecar(
        encodedSidecars.derivedObserver.chunk,
        {
          reference: encodedSidecars.derivedObserver.reference,
          boundary: { target: observerTarget },
        },
      ),
      civilizationObserver: decodeObserverCivilizationHistorySidecar(
        encodedSidecars.civilizationObserver.chunk,
        {
          reference: encodedSidecars.civilizationObserver.reference,
          boundary: { target: observerTarget },
        },
      ),
      checkpoint: decodeCheckpointAccumulator(encodedSidecars.checkpoint.chunk, {
        reference: encodedSidecars.checkpoint.reference,
        boundary: nextBoundary,
      }),
    });
    assertHistoryRetentionProjectionMatchesVerifiedSuccessor(
      retentionSuccessor,
      nextState,
      warmArtifacts.retention,
    );
    const warmEventsByAbsoluteIndex = new Map<number, WorldEvent>();
    const missingWarmPins = encodedBundle.bundle.coldPins.filter((pin) => {
      const event = worldEventById(nextState, pin.eventId);
      if (!event || event.id !== pin.eventId) return true;
      warmEventsByAbsoluteIndex.set(pin.absoluteIndex, event);
      return false;
    });
    const materializedWarmPins = materializeVerifiedRunHistoryPinnedEvents(
      nextRoot,
      readPublicationChunk,
      missingWarmPins.map((pin) => pin.absoluteIndex),
    );
    for (let offset = 0; offset < missingWarmPins.length; offset += 1) {
      const expected = missingWarmPins[offset];
      const actual = materializedWarmPins[offset];
      if (!actual
        || actual.absoluteIndex !== expected.absoluteIndex
        || actual.event.id !== expected.eventId) {
        throw new Error(
          `bounded publication warm pin ${expected.absoluteIndex}/${expected.eventId} 与 exact successor history 不一致`,
        );
      }
      warmEventsByAbsoluteIndex.set(actual.absoluteIndex, actual.event);
    }
    const warmPinnedEvents = encodedBundle.bundle.coldPins.map((pin) => {
      const event = warmEventsByAbsoluteIndex.get(pin.absoluteIndex);
      if (!event || event.id !== pin.eventId) {
        throw new Error(
          `bounded publication warm pin ${pin.absoluteIndex}/${pin.eventId} 无法物化`,
        );
      }
      return Object.freeze({ absoluteIndex: pin.absoluteIndex, event });
    });
    const reusableProjectPressureDescriptors =
      retainedProjectPressureEvidenceForLivingSources(nextState);
    const nextHotStartIndex = Math.max(
      0,
      nextRoot.eventCount - source.continuation.hotEventLimit,
    );

    const nextCheckpoint: ExactRunCheckpointRow = Object.freeze({
      runId: successor.run.id,
      revision: successor.run.meta.revision,
      month: successor.run.meta.elapsedMonths,
      stateHash: successor.root.hash,
      createdAt: successor.run.meta.updatedAt,
    });
    const nextContinuation: RunContinuationRow = Object.freeze({
      runId: successor.run.id,
      revision: successor.run.meta.revision,
      stateHash: successor.root.hash,
      rootSchemaVersion: nextRoot.schemaVersion,
      shellHash: nextRoot.shellHash,
      historyLineageId: nextRoot.lineageId,
      historyHeadHash: nextRoot.historyHeadHash,
      eventCount: nextRoot.eventCount,
      tailEventId: nextCursor.tailEventId,
      tailEventContentHash: nextRoot.tailEventContentHash,
      hotEventLimit: source.continuation.hotEventLimit,
      bundleSchemaVersion: RUN_CONTINUATION_BUNDLE_SCHEMA_VERSION,
      bundleHash: encodedBundle.chunk.hash,
      updatedAt: successor.run.meta.updatedAt,
    });
    assertContinuationAuthority(
      successor.run,
      nextContinuation,
      nextCheckpoint,
      successor.root,
      nextRoot,
      encodedBundle.bundle,
    );

    const nextPhysicalIdentity = snapshotContinuationChunkIdentity({
      hash: encodedSidecars.physical.chunk.hash,
      codec: encodedSidecars.physical.chunk.codec,
      rawSize: encodedSidecars.physical.chunk.rawSize,
      data: encodedSidecars.physical.chunk.data,
    });
    const publishedReceipt = Object.freeze({
      persisted: true as const,
      continuationReady: false as const,
      revision: successor.run.meta.revision,
      month: successor.run.meta.elapsedMonths,
      stateHash: successor.root.hash,
    }) as BoundedNonProjectionMonthPublishedReceipt;

    try {
      this.transaction(() => {
        this.assertBoundedPublicationStagingCurrent(staged.receipt, staged);
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
        this.collectUnreferencedRunStateChunks(source);
      }
      });
    } catch (error) {
      // A genuine stale/CAS conflict permanently severs this owned state from
      // authority. Fixture/IO rollback errors keep the exact unchanged join so
      // the existing retry contract remains intact.
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

    // Nothing below runs until COMMIT has succeeded. Rollback leaves the token
    // and both staging joins intact; successful publication spends them once.
    source.spent = true;
    const registry = this.continuationTokenRegistry();
    registry.generationsByRun.set(source.runId, source.generation + 1);
    registry.physicalByRun.set(source.runId, Object.freeze({
      runId: source.runId,
      revision: successor.run.meta.revision,
      stateHash: successor.root.hash,
      sidecar: nextPhysicalIdentity,
      projection: physicalSuccessor,
    }));
    this.discardOwnedNonProjectionStaging(
      registry,
      staged.receipt,
      staged.stagedMonth,
    );
    this.discardWarmNonProjectionContinuation(registry, source.runId);
    try {
      const warmProjectPressureSources = materializeVerifiedRunHistoryPinnedEvents(
        nextRoot,
        readPublicationChunk,
        projectPressureColdMaterializationOrdinals(
          nextState,
          warmArtifacts.retention,
          warmPinnedEvents,
          reusableProjectPressureDescriptors,
          nextHotStartIndex,
        ),
      );
      trimCommittedHistoryAfterPersistedCursor(
        nextState,
        {
          eventCount: nextRoot.eventCount,
          tailEventId: nextCursor.tailEventId,
        },
        nextContinuation.hotEventLimit,
      );
      adoptStoreDecodedBoundedSimulationState(
        nextState,
        successor.root.hash,
        warmArtifacts.retention,
        warmPinnedEvents,
        warmProjectPressureSources,
        reusableProjectPressureDescriptors,
        warmArtifacts.physical,
      );

      const sidecars = {} as Record<RunContinuationSidecarName, ContinuationChunkIdentity>;
      for (const name of RUN_CONTINUATION_SIDECAR_NAMES) {
        sidecars[name] = snapshotContinuationChunkIdentity({
          hash: encodedSidecars[name].chunk.hash,
          codec: encodedSidecars[name].chunk.codec,
          rawSize: encodedSidecars[name].chunk.rawSize,
          data: encodedSidecars[name].chunk.data,
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
        run: successor.run,
        continuation: nextContinuation,
        checkpoint: nextCheckpoint,
        root: successor.root,
        bundle: snapshotContinuationChunkIdentity({
          hash: encodedBundle.chunk.hash,
          codec: encodedBundle.chunk.codec,
          rawSize: encodedBundle.chunk.rawSize,
          data: encodedBundle.chunk.data,
        }),
        ...(source.observerMaterializationSource
          ? {
            observerMaterializationSource: source.observerMaterializationSource,
            observerMaterializationSourceRoot: source.observerMaterializationSourceRoot,
          }
          : {}),
        sidecars: Object.freeze(sidecars),
        artifacts: warmArtifacts,
      });
      registry.warmNonProjectionByRun.set(source.runId, Object.freeze({
        runId: source.runId,
        generation,
        revision: successor.run.meta.revision,
        stateHash: successor.root.hash,
        token: warmToken,
        state: nextState,
      }));
    } catch {
      // Authority is already committed. Any warm-state normalization failure
      // degrades to the existing cold-open path instead of misreporting COMMIT.
      this.discardWarmNonProjectionContinuation(registry, source.runId);
    }
    registry.publishedNonProjectionMonths.set(publishedReceipt, Object.freeze({
      runId: source.runId,
      revision: successor.run.meta.revision,
      month: successor.run.meta.elapsedMonths,
      stateHash: successor.root.hash,
    }));
    return publishedReceipt;
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
    let stateForEncoding = state;
    if ((state.world.historyCursor?.hotStartIndex ?? 0) > 0) {
      const world = { ...state.world };
      delete world.historyCursor;
      stateForEncoding = { ...state, world };
    }

    const encoded = await encodeSegmentedRunStateFromHistorySuffix(
      stateForEncoding,
      exactHistoryOwner
        ? { ...runHistoryCursorFromRootMetadata(exactHistoryOwner.metadata) }
        : { ...sourceBasis.history },
      exactHistoryOwner ? [] : suffix,
    );
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
    });
    return receipt;
  }

  /**
   * Build all continuation projections from one immutable schema-3 root. This
   * does no SQLite writes; bootstrap and same-root refresh supply their own
   * source-current assertion and short publication transaction.
   */
  private async buildBoundedContinuationArtifacts(
    source: Readonly<BoundedContinuationBootstrapSourceSnapshot>,
    hotEventLimit: number,
    assertSourceCurrent: () => void,
    operationName: "bootstrap" | "refresh",
    observerMaterializationSource?: Readonly<RunContinuationObserverMaterializationSourceV1>,
  ): Promise<BuiltBoundedContinuationArtifacts> {
    const rootMetadata = source.metadata;
    if (rootMetadata.schemaVersion !== 3) {
      throw new Error(
        `运行 ${source.run.id} 不是可流式${operationName === "bootstrap" ? "建立" : "刷新"}`
        + " continuation 的 schema 3 root",
      );
    }
    // Codec/projection boundaries synchronously take owned snapshots before
    // crossing awaits. The store reader therefore retains no duplicate full
    // history while all reducers share one verified stream.
    const readSourceChunk = (hash: string): RunStateChunk => this.chunkRow(hash);
    const decodedPhysical = await decodeBoundedGameplayRunStateWithPhysicalProjection(
      source.root,
      readSourceChunk,
      {
        hotEventLimit,
        observerAuthority: {
          stateHash: source.root.hash,
          revision: source.run.meta.revision,
          month: source.run.meta.elapsedMonths,
          lastMaterializedMilestoneCount: source.run.meta.milestoneCount,
        },
      },
    );
    assertSourceCurrent();

    const state = decodedPhysical.state;
    const cursor = state.world.historyCursor;
    const expectedHotStartIndex = Math.max(0, rootMetadata.eventCount - hotEventLimit);
    const expectedHotEventCount = rootMetadata.eventCount - expectedHotStartIndex;
    if (decodedPhysical.metadata.schemaVersion !== rootMetadata.schemaVersion
      || decodedPhysical.metadata.shellHash !== rootMetadata.shellHash
      || decodedPhysical.metadata.lineageId !== rootMetadata.lineageId
      || decodedPhysical.metadata.historyHeadHash !== rootMetadata.historyHeadHash
      || decodedPhysical.metadata.eventCount !== rootMetadata.eventCount
      || decodedPhysical.metadata.tailEventContentHash !== rootMetadata.tailEventContentHash
      || !cursor
      || cursor.eventCount !== rootMetadata.eventCount
      || cursor.hotStartIndex !== expectedHotStartIndex
      || cursor.tailEventId !== state.world.past.at(-1)?.id
      || state.world.past.length !== expectedHotEventCount) {
      throw new Error(`运行 ${source.run.id} 的 bounded shell/physical root join 失配`);
    }
    if (observerMaterializationSource
      && !isDeepStrictEqual(
        attachedLastMaterializedObserverBasis(state).source,
        observerMaterializationSource,
      )) {
      throw new Error(
        `运行 ${source.run.id} 的 observer materialization source 与 refresh shell 失配`,
      );
    }
    assertDecodedRunSummary(source.run, state);

    const observerTarget = Object.freeze({
      stateHash: source.root.hash,
      eventCount: rootMetadata.eventCount,
      tailEventId: cursor.tailEventId,
    });
    const derivedDemand = collectObserverDerivedHistoryGenesisDemandFromVerifiedShell({
      state,
      stateHash: source.root.hash,
      physicalProjection: decodedPhysical.physicalProjection,
    });
    const retentionFold = beginHistoryRetentionProjection(
      state,
      { stateHash: source.root.hash },
    );
    const derivedFold = beginObserverDerivedHistoryProjection(observerTarget, derivedDemand);
    const civilizationFold = beginObserverCivilizationHistoryProjection(observerTarget);
    const verifiedHistory = await streamVerifiedRunHistorySegments(
      rootMetadata,
      readSourceChunk,
      (events, position) => {
        foldHistoryRetentionSegment(retentionFold, events, position.startEventIndex);
        foldVerifiedObserverDerivedHistorySegment(
          derivedFold,
          events,
          position.startEventIndex,
        );
        foldVerifiedObserverCivilizationHistorySegment(
          civilizationFold,
          events,
          position.startEventIndex,
        );
      },
    );
    assertSourceCurrent();
    if (!sameHistoryCursor(
      verifiedHistory,
      runHistoryCursorFromRootMetadata(rootMetadata),
    )) {
      throw new Error(`运行 ${source.run.id} 的 ${operationName} verified history seal 失配`);
    }

    const retention = finishHistoryRetentionProjection(retentionFold);
    assertHistoryRetentionProjectionMatchesShell(state, retention);
    const derivedObserver = finishObserverDerivedHistoryProjection(derivedFold);
    const civilizationObserver = finishObserverCivilizationHistoryProjection(civilizationFold);
    const checkpointBoundary = Object.freeze({
      runId: source.run.id,
      revision: source.run.meta.revision,
      month: source.run.meta.elapsedMonths,
      stateHash: source.root.hash,
      rootSchemaVersion: rootMetadata.schemaVersion,
      shellHash: rootMetadata.shellHash,
      historyLineageId: rootMetadata.lineageId,
      historyHeadHash: rootMetadata.historyHeadHash,
      eventCount: rootMetadata.eventCount,
      tailEventId: cursor.tailEventId,
      tailEventContentHash: rootMetadata.tailEventContentHash,
    });
    const checkpoint = await projectCheckpointAccumulatorFromVerifiedRunRoot(
      state,
      source.root,
      readSourceChunk,
      checkpointBoundary,
    );
    assertSourceCurrent();

    const encodedSidecars = Object.freeze({
      retention: encodeHistoryRetentionSidecar(retention),
      physical: encodePhysicalStructureLedgerSidecar(decodedPhysical.physicalProjection),
      derivedObserver: encodeObserverDerivedHistorySidecar({
        sourceDemand: derivedDemand,
        projection: derivedObserver,
      }),
      civilizationObserver: encodeObserverCivilizationHistorySidecar(civilizationObserver),
      checkpoint: encodeCheckpointAccumulator(checkpoint),
    });
    const hotStartIndex = Math.max(0, rootMetadata.eventCount - hotEventLimit);
    const coldPins = encodedSidecars.retention.projection.pins
      .filter((pin) => pin.absoluteIndex < hotStartIndex)
      .map((pin) => Object.freeze({
        absoluteIndex: pin.absoluteIndex,
        eventId: pin.eventId,
        leaseKeys: Object.freeze([...pin.leaseKeys]),
      }));
    const reopenableEventIds = new Set([
      ...state.world.past.map((event) => event.id),
      ...coldPins.map((pin) => pin.eventId),
    ]);
    if (state.lastStep.some((event) => !reopenableEventIds.has(event.id))) {
      throw new Error(
        `运行 ${source.run.id} 的 hot window/retention pins 无法重开完整 lastStep`,
      );
    }

    const authority = Object.freeze({
      runId: source.run.id,
      revision: source.run.meta.revision,
      stateHash: source.root.hash,
      rootSchemaVersion: rootMetadata.schemaVersion,
      shellHash: rootMetadata.shellHash,
      historyLineageId: rootMetadata.lineageId,
      historyHeadHash: rootMetadata.historyHeadHash,
      eventCount: rootMetadata.eventCount,
      tailEventId: cursor.tailEventId,
      tailEventContentHash: rootMetadata.tailEventContentHash,
    });
    const encodedBundle = encodeRunContinuationBundle({
      schemaVersion: RUN_CONTINUATION_BUNDLE_SCHEMA_VERSION,
      historyMode: "bounded-hot-tail-plus-cold-pins-v1",
      authority,
      hotEventLimit,
      hotStartIndex,
      coldPins,
      sidecars: {
        retention: encodedSidecars.retention.reference,
        physical: encodedSidecars.physical.reference,
        derivedObserver: encodedSidecars.derivedObserver.reference,
        civilizationObserver: encodedSidecars.civilizationObserver.reference,
        checkpoint: encodedSidecars.checkpoint.reference,
      },
      ...(observerMaterializationSource ? { observerMaterializationSource } : {}),
    });
    assertRetentionPinsMatchBundle(
      source.run.id,
      encodedSidecars.retention.projection,
      encodedBundle.bundle,
    );

    const continuation: RunContinuationRow = Object.freeze({
      runId: source.run.id,
      revision: source.run.meta.revision,
      stateHash: source.root.hash,
      rootSchemaVersion: rootMetadata.schemaVersion,
      shellHash: rootMetadata.shellHash,
      historyLineageId: rootMetadata.lineageId,
      historyHeadHash: rootMetadata.historyHeadHash,
      eventCount: rootMetadata.eventCount,
      tailEventId: cursor.tailEventId,
      tailEventContentHash: rootMetadata.tailEventContentHash,
      hotEventLimit,
      bundleSchemaVersion: RUN_CONTINUATION_BUNDLE_SCHEMA_VERSION,
      bundleHash: encodedBundle.chunk.hash,
      updatedAt: source.run.meta.updatedAt,
    });
    assertContinuationAuthority(
      source.run,
      continuation,
      source.checkpoint,
      source.root,
      rootMetadata,
      encodedBundle.bundle,
    );
    return Object.freeze({
      continuation,
      encodedSidecars,
      encodedBundle,
      physicalProjection: decodedPhysical.physicalProjection,
    });
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
    } = await this.buildBoundedContinuationArtifacts(
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
    } = await this.buildBoundedContinuationArtifacts(
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

    // The manifest alone selects every retained cold ordinal. There is no
    // caller-provided option merge or event-id lookup on this authority path.
    const decoded = await this.decodeBoundedGameplayForPhase(
      "continuationOpen",
      rootSnapshot,
      (chunkHash) => this.chunkRow(chunkHash),
      {
        hotEventLimit: bundle.hotEventLimit,
        pinnedEventIndexes: bundle.coldPins.map((pin) => pin.absoluteIndex),
        observerAuthority: {
          stateHash: rootSnapshot.hash,
          revision: runSnapshot.meta.revision,
          month: runSnapshot.meta.elapsedMonths,
          lastMaterializedMilestoneCount: runSnapshot.meta.milestoneCount,
        },
      },
    );
    const cursor = decoded.state.world.historyCursor;
    if (!cursor
      || cursor.eventCount !== bundle.authority.eventCount
      || cursor.hotStartIndex !== bundle.hotStartIndex
      || cursor.tailEventId !== bundle.authority.tailEventId
      || decoded.state.world.past.length !== cursor.eventCount - cursor.hotStartIndex) {
      throw new Error(`运行 ${normalizedId} 的 bounded tail 与 continuation bundle 不一致`);
    }
    assertDecodedRunSummary(runSnapshot, decoded.state);
    let observerMaterializationSourceRoot: RunStateChunk | undefined;
    if (bundle.observerMaterializationSource) {
      const observerSource = bundle.observerMaterializationSource;
      const basis = attachedLastMaterializedObserverBasis(decoded.state);
      const terminalBoundaryKind = decoded.state.civilization.outcome?.kind === "destroyed"
        ? "extinction"
        : decoded.state.civilization.outcome?.kind === "boundary"
          ? "months-endpoint"
          : null;
      const nonAnnualTerminalMaterialization = terminalBoundaryKind !== null
        && runSnapshot.meta.status === "ended"
        && decoded.state.civilization.status === "ended"
        && boundedObserverBoundaryMatchesState(
          terminalBoundaryKind,
          decoded.state,
          runSnapshot.meta.elapsedMonths,
        )
        && observerSource.revision === runSnapshot.meta.revision
        && observerSource.month === runSnapshot.meta.elapsedMonths;
      if (observerSource.revision > runSnapshot.meta.revision
        || observerSource.month > runSnapshot.meta.elapsedMonths
        || (observerSource.month % 12 !== 0 && !nonAnnualTerminalMaterialization)
        || observerSource.stateHash === runSnapshot.stateHash
        || !isDeepStrictEqual(basis.source, observerSource)) {
        throw new Error(
          `运行 ${normalizedId} 的 observer materialization source 与 final root basis 不一致`,
        );
      }
      observerMaterializationSourceRoot = snapshotRunStateChunk(
        this.chunkRow(observerSource.stateHash),
      );
      if (observerMaterializationSourceRoot.codec !== RUN_STATE_ROOT_CODEC) {
        throw new Error(
          `运行 ${normalizedId} 的 observer materialization source 不是 segmented root`,
        );
      }
      const observerSourceMetadata = parseRunStateRoot(observerMaterializationSourceRoot);
      if (observerSourceMetadata.schemaVersion !== 3
        || observerSourceMetadata.lineageId !== rootMetadata.lineageId
        || observerSourceMetadata.eventCount > rootMetadata.eventCount
        || (observerSourceMetadata.eventCount === rootMetadata.eventCount
          && observerSourceMetadata.tailEventContentHash !== rootMetadata.tailEventContentHash)) {
        throw new Error(
          `运行 ${normalizedId} 的 observer materialization source 与 final root 历史失配`,
        );
      }
    }
    if (decoded.pinnedEvents.length !== bundle.coldPins.length) {
      throw new Error(`运行 ${normalizedId} 的 bounded cold pins 数量不一致`);
    }
    for (let offset = 0; offset < bundle.coldPins.length; offset += 1) {
      const expected = bundle.coldPins[offset];
      const actual = decoded.pinnedEvents[offset];
      if (!actual
        || actual.absoluteIndex !== expected.absoluteIndex
        || actual.event.id !== expected.eventId) {
        throw new Error(
          `运行 ${normalizedId} 的 bounded cold pin ${expected.absoluteIndex} 与 manifest 不一致`,
        );
      }
    }

    const retentionBoundary = Object.freeze({
      authority: Object.freeze({ stateHash: runSnapshot.stateHash }),
      target: Object.freeze({
        eventCount: bundle.authority.eventCount,
        tailEventId: bundle.authority.tailEventId,
      }),
    });
    const observerTarget = Object.freeze({
      stateHash: runSnapshot.stateHash,
      eventCount: bundle.authority.eventCount,
      tailEventId: bundle.authority.tailEventId,
    });
    const checkpointBoundary = Object.freeze({
      runId: runSnapshot.id,
      revision: runSnapshot.meta.revision,
      month: checkpointSnapshot.month,
      stateHash: runSnapshot.stateHash,
      rootSchemaVersion: rootMetadata.schemaVersion,
      shellHash: rootMetadata.shellHash,
      historyLineageId: rootMetadata.lineageId,
      historyHeadHash: rootMetadata.historyHeadHash,
      eventCount: rootMetadata.eventCount,
      tailEventId: bundle.authority.tailEventId,
      tailEventContentHash: rootMetadata.tailEventContentHash,
    });
    const sidecars = {} as Record<RunContinuationSidecarName, ContinuationChunkIdentity>;

    // Decode one store-selected sidecar at a time. Only its scalar content
    // identity and normalized artifact survive the local scope; raw bytes are
    // eligible for collection before the next potentially large sidecar opens.
    const retention = (() => {
      const name = "retention" as const;
      const reference = contentHashReferenceFor(bundle.sidecars[name], normalizedId, name);
      const chunk = this.chunkRow(reference.hash);
      const artifact = decodeHistoryRetentionSidecar(chunk, {
        reference,
        boundary: retentionBoundary,
      });
      sidecars[name] = snapshotContinuationChunkIdentity(chunk);
      return artifact;
    })();
    assertHistoryRetentionProjectionMatchesShell(decoded.state, retention);
    assertRetentionPinsMatchBundle(normalizedId, retention, bundle);

    const physicalSidecar = (() => {
      const name = "physical" as const;
      const reference = contentHashReferenceFor(bundle.sidecars[name], normalizedId, name);
      const chunk = this.chunkRow(reference.hash);
      const artifact = decodePhysicalStructureLedgerSidecar(chunk, {
        reference,
        boundary: retentionBoundary,
      });
      sidecars[name] = snapshotContinuationChunkIdentity(chunk);
      return artifact;
    })();

    const derivedObserver = (() => {
      const name = "derivedObserver" as const;
      const reference = contentHashReferenceFor(bundle.sidecars[name], normalizedId, name);
      const chunk = this.chunkRow(reference.hash);
      const artifact = decodeObserverDerivedHistorySidecar(chunk, {
        reference,
        boundary: { target: observerTarget },
      });
      sidecars[name] = snapshotContinuationChunkIdentity(chunk);
      return artifact;
    })();

    const civilizationObserver = (() => {
      const name = "civilizationObserver" as const;
      const reference = contentHashReferenceFor(bundle.sidecars[name], normalizedId, name);
      const chunk = this.chunkRow(reference.hash);
      const artifact = decodeObserverCivilizationHistorySidecar(chunk, {
        reference,
        boundary: { target: observerTarget },
      });
      sidecars[name] = snapshotContinuationChunkIdentity(chunk);
      return artifact;
    })();

    const checkpoint = (() => {
      const name = "checkpoint" as const;
      const reference = contentHashReferenceFor(bundle.sidecars[name], normalizedId, name);
      const chunk = this.chunkRow(reference.hash);
      const artifact = decodeCheckpointAccumulator(chunk, {
        reference,
        boundary: checkpointBoundary,
      });
      sidecars[name] = snapshotContinuationChunkIdentity(chunk);
      return artifact;
    })();

    const registry = this.continuationTokenRegistry();
    const cachedPhysical = registry.physicalByRun.get(normalizedId);
    let physical: Readonly<PhysicalStructureLedgerProjectionResult>;
    if (cachedPhysical
      && cachedPhysical.runId === normalizedId
      && cachedPhysical.revision === runSnapshot.meta.revision
      && cachedPhysical.stateHash === runSnapshot.stateHash
      && cachedPhysical.sidecar.hash === sidecars.physical.hash
      && cachedPhysical.sidecar.codec === sidecars.physical.codec
      && cachedPhysical.sidecar.rawSize === sidecars.physical.rawSize) {
      physical = cachedPhysical.projection;
    } else {
      // Bootstrap seals only the exact root/history/grid scalars. It does not
      // retain the decoded state, so the controller may advance this same
      // object in place without an expensive restart-only clone.
      physical = await bootstrapPhysicalStructureLedgerFromStrictDecodedSidecar(
        physicalSidecar,
        decoded.state,
        rootSnapshot,
        (chunkHash) => this.chunkRow(chunkHash),
      );
    }
    const canonicalPhysical = encodePhysicalStructureLedgerSidecar(physical);
    const selectedPhysicalReference = contentHashReferenceFor(
      bundle.sidecars.physical,
      normalizedId,
      "physical",
    );
    if (canonicalPhysical.reference.codec !== selectedPhysicalReference.codec
      || canonicalPhysical.reference.hash !== selectedPhysicalReference.hash
      || canonicalPhysical.chunk.rawSize !== sidecars.physical.rawSize) {
      throw new Error(
        `运行 ${normalizedId} 的 physical bootstrap/cache 未重现 store-selected canonical sidecar`,
      );
    }

    const projectPressureSources = materializeVerifiedRunHistoryPinnedEvents(
      rootMetadata,
      (chunkHash) => this.chunkRow(chunkHash),
      projectPressureColdMaterializationOrdinals(
        decoded.state,
        retention,
        decoded.pinnedEvents,
      ),
    );
    adoptStoreDecodedBoundedSimulationState(
      decoded.state,
      runSnapshot.stateHash,
      retention,
      decoded.pinnedEvents,
      projectPressureSources,
      [],
      physicalSidecar,
    );

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
    });

    return {
      meta: { ...runSnapshot.meta },
      state: decoded.state,
      pinnedEvents: decoded.pinnedEvents,
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

  private async loadArtifact<T>(id: string, kind: string): Promise<T | null> {
    const normalizedId = normalizeId(id);
    const chunk = parseChunkRow(this.selectArtifactChunk.get(normalizedId, kind));
    return chunk ? decodeValue<T>(chunk) : null;
  }

  private async saveArtifact(id: string, kind: string, value: unknown): Promise<void> {
    const normalizedId = normalizeId(id);
    this.assertRunExists(normalizedId);
    const chunk = await encodeValue(value);
    this.transaction(() => {
      this.assertRunExists(normalizedId);
      const previous = this.selectArtifactHash.get(normalizedId, kind);
      const previousHash = previous ? String(previous.chunk_hash) : null;
      this.storeChunk(chunk);
      this.upsertArtifact.run(normalizedId, kind, chunk.hash, new Date().toISOString());
      if (previousHash) {
        this.deleteUnreferencedArtifactChunk.run(previousHash, V8_BROTLI_CODEC);
      }
    });
  }

  async loadEvolutionPath(id: string): Promise<EvolutionPath | null> {
    return this.loadArtifact<EvolutionPath>(id, ARTIFACT_EVOLUTION_PATH);
  }

  async saveEvolutionPath(id: string, evolution: EvolutionPath): Promise<void> {
    await this.saveArtifact(id, ARTIFACT_EVOLUTION_PATH, evolution);
  }

  async loadEvolutionReport(id: string): Promise<EvolutionReport | null> {
    return this.loadArtifact<EvolutionReport>(id, ARTIFACT_EVOLUTION_REPORT);
  }

  async saveEvolutionReport(id: string, report: EvolutionReport): Promise<void> {
    await this.saveArtifact(id, ARTIFACT_EVOLUTION_REPORT, report);
  }

  async loadNarrativeEnhancements(id: string): Promise<NarrativeEnhancementArtifact | null> {
    return this.loadArtifact<NarrativeEnhancementArtifact>(id, ARTIFACT_NARRATIVE_ENHANCEMENTS);
  }

  async saveNarrativeEnhancements(id: string, artifact: NarrativeEnhancementArtifact): Promise<void> {
    await this.saveArtifact(id, ARTIFACT_NARRATIVE_ENHANCEMENTS, artifact);
  }
}

export { SqliteRunStore as SQLiteRunStore };
