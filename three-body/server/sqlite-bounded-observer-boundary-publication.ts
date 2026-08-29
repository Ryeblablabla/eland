import { isDeepStrictEqual } from "node:util";

import type { SimulationState } from "../src/game/eland/simulation";
import {
  registerLiveSocialEvidenceDescriptors,
  retainedLiveSocialEvidenceForLivingSources,
} from "../src/game/eland/domain/event-index";
import {
  livePersonSocialSourceEventIds,
  type RetainedLiveSocialEvidenceDescriptor,
} from "../src/game/eland/domain/live-social-evidence";
import { rematerializePhysicalStructureIndex } from "../src/game/eland/domain/physical-structure-index";
import { livingPeople } from "../src/game/eland/domain/state-index";
import { hydrateWorld } from "../src/game/eland/world/grid";
import {
  boundedObserverBoundaryMatchesState,
  stepOwnedBoundedObserverBoundaryMonth,
  stepOwnedBoundedTerminalMonth,
  type BoundedObserverBoundaryKind,
  type BoundedObserverBoundaryMonthResult,
} from "./bounded-observer-boundary-month-controller";
import { materializeBoundedCertifiedCivilizationDevelopment } from "./bounded-observer-civilization-materializer";
import { materializeDecodedBoundedObserverDerivedSubset } from "./bounded-observer-derived-materializer";
import {
  assertLastMaterializedObserverBasis,
  materializeBoundedObserverHotShell,
  type LastMaterializedObserverBasis,
} from "./bounded-observer-hot-shell";
import {
  LAST_MATERIALIZED_OBSERVER_BASIS_FIELD,
  materializedObserverMilestoneCount,
} from "./bounded-gameplay-shell";
import {
  encodeCheckpointAccumulator,
  projectCheckpointAccumulatorFromVerifiedSuccessor,
} from "./checkpoint-accumulator";
import {
  assertVerifiedObserverCivilizationHistorySuccessor,
  projectObserverCivilizationHistoryFromVerifiedSuccessor,
} from "./observer-civilization-history-successor";
import type { HistoryRetentionProjectionResult } from "./history-retention-projection";
import {
  assertVerifiedHistoryRetentionSuccessor,
  projectHistoryRetentionFromVerifiedSuccessor,
} from "./history-retention-successor";
import {
  decodeObserverDerivedHistorySidecar,
} from "./observer-derived-history-codec";
import {
  assertVerifiedObserverDerivedHistorySuccessor,
  projectObserverDerivedHistoryFromVerifiedSuccessor,
} from "./observer-derived-history-successor";
import { encodePhysicalStructureLedgerSidecar } from "./physical-structure-ledger-codec";
import {
  projectPhysicalStructureLedgerFromVerifiedSuccessor,
  type PhysicalStructureLedgerProjectionResult,
} from "./physical-structure-ledger-projection";
import {
  encodeRunContinuationBundle,
  hashRunContinuationStoredContent,
  RUN_CONTINUATION_BUNDLE_SCHEMA_VERSION,
  type RunContinuationBundleV1,
  type RunContinuationObserverMaterializationSourceV1,
} from "./run-continuation-bundle";
import { RunWriteConflictError, type RunSummary } from "./run-persistence";
import {
  decodeSegmentedRunStateGameplayBounded,
  parseRunStateRoot,
  runHistoryCursorFromRootMetadata,
  type RunHistoryCursor,
  type RunStateChunk,
  type RunStateRootMetadata,
} from "./run-state-codec";
import type {
  BoundedPublicationCheckpointRow as ObserverBoundaryCheckpointRow,
  BoundedPublicationChunkIdentity as ObserverBoundaryChunkIdentity,
  BoundedPublicationContinuationRow as ObserverBoundaryContinuationRow,
  BoundedPublicationEncodedSidecars as ObserverBoundaryEncodedSidecars,
  BoundedPublicationOwnedSuccessorStage as ObserverBoundaryOwnedSuccessorStage,
  BoundedPublicationRunRow as ObserverBoundaryRunRow,
  BoundedPublicationSourceRecord as ObserverBoundarySourceRecord,
  BoundedPublicationSuccessorRecord as ObserverBoundarySuccessorRecord,
} from "./sqlite-bounded-publication-contract";

export type {
  ObserverBoundaryCheckpointRow,
  ObserverBoundaryChunkIdentity,
  ObserverBoundaryContinuationRow,
  ObserverBoundaryEncodedSidecars,
  ObserverBoundaryOwnedSuccessorStage,
  ObserverBoundaryRunRow,
  ObserverBoundarySourceRecord,
  ObserverBoundarySuccessorRecord,
};

const RUN_CONTINUATION_SIDECAR_NAMES = [
  "retention",
  "physical",
  "derivedObserver",
  "civilizationObserver",
  "checkpoint",
] as const;
type RunContinuationSidecarName = typeof RUN_CONTINUATION_SIDECAR_NAMES[number];

declare const boundedObserverBoundaryMonthStagingReceiptBrand: unique symbol;
declare const boundedObserverBoundaryMonthPublishedReceiptBrand: unique symbol;

/** Opaque store-owned join between one fact root A and its current continuation. */
export interface BoundedObserverBoundaryMonthStagingReceipt {
  readonly kind: "bounded-observer-boundary-month-staging-receipt-v1";
  readonly persisted: false;
  readonly continuationReady: false;
  readonly [boundedObserverBoundaryMonthStagingReceiptBrand]: true;
}

/** Proof that fact root A and observer-materialized authority root B committed together. */
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

export interface ObserverBoundaryMonthStagingRecord {
  readonly sourceToken: object;
  readonly sourceGeneration: number;
  readonly runId: string;
  readonly sourceMonth: number;
  readonly targetMonth: number;
  readonly boundaryKind: BoundedObserverBoundaryKind;
  readonly factSuccessorReceipt: object;
  readonly reusableLiveSocialDescriptors: readonly RetainedLiveSocialEvidenceDescriptor[];
}

export interface ObserverBoundaryStagingContext {
  readonly receipt: object;
  readonly stagedMonth: ObserverBoundaryMonthStagingRecord;
  readonly factSuccessor: ObserverBoundarySuccessorRecord;
  readonly sourceToken: object;
  readonly source: ObserverBoundarySourceRecord;
}

export interface ObserverBoundaryOpenedContinuation {
  readonly state: SimulationState;
  readonly meta: RunSummary;
  readonly continuationToken: object;
}

export interface ObserverBoundaryPublicationCommit {
  readonly staged: ObserverBoundaryStagingContext;
  readonly factSuccessor: ObserverBoundarySuccessorRecord;
  readonly finalSuccessor: ObserverBoundarySuccessorRecord;
  readonly encodedSidecars: Readonly<ObserverBoundaryEncodedSidecars>;
  readonly encodedBundle: ReturnType<typeof encodeRunContinuationBundle>;
  readonly nextCheckpoint: ObserverBoundaryCheckpointRow;
  readonly nextContinuation: ObserverBoundaryContinuationRow;
  readonly observerMaterializationSource: Readonly<RunContinuationObserverMaterializationSourceV1>;
}

export interface ObserverBoundaryPublicationFinalization {
  readonly staged: ObserverBoundaryStagingContext;
  readonly factSuccessorReceipt: object;
  readonly finalSuccessorReceipt: object;
  readonly finalSuccessor: ObserverBoundarySuccessorRecord;
  readonly nextPhysicalIdentity: ObserverBoundaryChunkIdentity;
  readonly finalPhysicalProjection: Readonly<PhysicalStructureLedgerProjectionResult>;
  readonly publishedReceipt: BoundedObserverBoundaryMonthPublishedReceipt;
  readonly publishedRecord: Readonly<{
    runId: string;
    revision: number;
    month: number;
    stateHash: string;
    stage: string;
    boundaryKind: BoundedObserverBoundaryKind;
    status: SimulationState["civilization"]["status"];
  }>;
}

/**
 * Narrow host port. The coordinator receives already-authenticated domain
 * snapshots and one purpose-built atomic commit capability; it never receives
 * SQLite, generic transaction/chunk writers or continuation registries.
 */
export interface SqliteBoundedObserverBoundaryPublicationHost {
  openBoundedEvolutionContinuation(id: string): Promise<ObserverBoundaryOpenedContinuation>;
  stageOwnedSingleMonthSuccessor(
    token: object,
    state: SimulationState,
    label?: string,
    exactHistoryOwnerReceipt?: object,
  ): Promise<ObserverBoundaryOwnedSuccessorStage>;
  registerObserverBoundaryStaging(
    receipt: BoundedObserverBoundaryMonthStagingReceipt,
    record: ObserverBoundaryMonthStagingRecord,
  ): void;
  currentObserverBoundaryStaging(receipt: unknown): ObserverBoundaryStagingContext;
  assertObserverBoundaryStagingCurrent(
    receipt: object,
    expected: ObserverBoundaryStagingContext,
  ): void;
  assertOwnedSuccessorCurrent(
    receipt: object,
    successor: ObserverBoundarySuccessorRecord,
    sourceToken: object,
    sourceGeneration: number,
  ): void;
  hasPublishedObserverBoundaryReceipt(receipt: unknown): boolean;
  readRunStateChunk(hash: string): RunStateChunk;
  assertContinuationAuthority(
    run: ObserverBoundaryRunRow,
    continuation: ObserverBoundaryContinuationRow,
    checkpoint: ObserverBoundaryCheckpointRow,
    root: RunStateChunk,
    rootMetadata: RunStateRootMetadata,
    bundle: Readonly<RunContinuationBundleV1>,
  ): void;
  assertRetentionPinsMatchBundle(
    runId: string,
    projection: Readonly<HistoryRetentionProjectionResult>,
    bundle: Readonly<RunContinuationBundleV1>,
  ): void;
  commitObserverBoundaryPublication(input: ObserverBoundaryPublicationCommit): void;
  completeObserverBoundaryPublication(input: ObserverBoundaryPublicationFinalization): void;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && Buffer.from(left.buffer, left.byteOffset, left.byteLength)
      .equals(Buffer.from(right.buffer, right.byteOffset, right.byteLength));
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
  successor: Readonly<ObserverBoundarySuccessorRecord>,
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

function reusableLiveSocialDescriptorsForCurrentOwners(
  state: SimulationState,
  reusable: readonly RetainedLiveSocialEvidenceDescriptor[],
): readonly RetainedLiveSocialEvidenceDescriptor[] {
  const membershipByOwnerId = new Map(livingPeople(state).map((person) => [
    person.id,
    new Set(livePersonSocialSourceEventIds(person)),
  ]));
  return reusable.filter((item) => (
    membershipByOwnerId.get(item.ownerId)?.has(item.descriptor.eventId) === true
  ));
}

function assertDecodedRunSummary(run: ObserverBoundaryRunRow, state: SimulationState): void {
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

function snapshotContinuationChunkIdentity(chunk: {
  readonly hash: string;
  readonly codec: string;
  readonly rawSize: number;
  readonly data: Uint8Array;
}): ObserverBoundaryChunkIdentity {
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

/** Coordinates the fact-root A -> materialized-root B publication protocol. */
export class SqliteBoundedObserverBoundaryPublication {
  constructor(private readonly host: SqliteBoundedObserverBoundaryPublicationHost) {}

  ownsStagingReceipt(
    receipt: unknown,
  ): receipt is BoundedObserverBoundaryMonthStagingReceipt {
    try {
      this.host.currentObserverBoundaryStaging(receipt);
      return true;
    } catch {
      return false;
    }
  }

  ownsPublishedReceipt(
    receipt: unknown,
  ): receipt is BoundedObserverBoundaryMonthPublishedReceipt {
    return this.host.hasPublishedObserverBoundaryReceipt(receipt);
  }

  async stageScheduled(
    id: string,
    label?: string,
  ): Promise<BoundedObserverBoundaryMonthStagingReceipt> {
    const opened = await this.host.openBoundedEvolutionContinuation(id);
    const reusableLiveSocialDescriptors = Object.freeze([
      ...retainedLiveSocialEvidenceForLivingSources(opened.state),
    ]);
    const boundary = stepOwnedBoundedObserverBoundaryMonth(opened.state);
    return this.stageOwned(opened, boundary, reusableLiveSocialDescriptors, label);
  }

  async stageTerminal(
    id: string,
    label?: string,
  ): Promise<BoundedObserverBoundaryMonthStagingReceipt> {
    const opened = await this.host.openBoundedEvolutionContinuation(id);
    const reusableLiveSocialDescriptors = Object.freeze([
      ...retainedLiveSocialEvidenceForLivingSources(opened.state),
    ]);
    const boundary = stepOwnedBoundedTerminalMonth(opened.state);
    if (boundary.receipt.kind !== "extinction") {
      throw new Error(
        `bounded terminal probe 不接受 ${boundary.receipt.kind} 边界`,
      );
    }
    return this.stageOwned(opened, boundary, reusableLiveSocialDescriptors, label);
  }

  private async stageOwned(
    opened: ObserverBoundaryOpenedContinuation,
    boundary: Readonly<BoundedObserverBoundaryMonthResult>,
    reusableLiveSocialDescriptors: readonly RetainedLiveSocialEvidenceDescriptor[],
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
    const fact = await this.host.stageOwnedSingleMonthSuccessor(
      opened.continuationToken,
      boundary.state,
      label,
    );
    if (!fact.successor
      || fact.successor.sourceToken !== fact.sourceToken
      || fact.successor.sourceGeneration !== fact.source.generation
      || fact.successor.run.meta.status !== boundary.state.civilization.status
      || fact.successor.run.meta.elapsedMonths !== boundary.receipt.targetMonth) {
      throw new Error(
        "bounded 观察边界月没有生成同一 store generation 的 private fact root A",
      );
    }
    const sourceDirectIdentityByOrdinal = new Map(
      fact.source.artifacts.retention.continuationBasis.directMatches
        .map((match) => [match.absoluteIndex, match.eventId]),
    );
    if (reusableLiveSocialDescriptors.some((item) => (
      sourceDirectIdentityByOrdinal.get(item.absoluteIndex) !== item.descriptor.eventId
    ))) {
      throw new Error(
        "bounded 观察边界 source live-social descriptor 缺少 retention exact identity",
      );
    }
    const receipt = Object.freeze({
      kind: "bounded-observer-boundary-month-staging-receipt-v1",
      persisted: false,
      continuationReady: false,
    }) as BoundedObserverBoundaryMonthStagingReceipt;
    this.host.registerObserverBoundaryStaging(receipt, {
      sourceToken: fact.sourceToken,
      sourceGeneration: fact.source.generation,
      runId: fact.source.runId,
      sourceMonth,
      targetMonth: boundary.receipt.targetMonth,
      boundaryKind: boundary.receipt.kind,
      factSuccessorReceipt: fact.receipt,
      reusableLiveSocialDescriptors,
    });
    return receipt;
  }

  async publish(
    receiptInput: BoundedObserverBoundaryMonthStagingReceipt,
  ): Promise<BoundedObserverBoundaryMonthPublishedReceipt> {
    const staged = this.host.currentObserverBoundaryStaging(receiptInput);
    this.host.assertObserverBoundaryStagingCurrent(staged.receipt, staged);
    const { source, sourceToken, factSuccessor } = staged;
    if (factSuccessor.metadata.schemaVersion !== 3) {
      throw new Error("bounded 年度观察 publication 只接受 schema 3 private fact root A");
    }

    const privateChunkReader = (
      successor: ObserverBoundarySuccessorRecord,
      exactHistoryOwner?: ObserverBoundarySuccessorRecord,
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
      return (hash: string): RunStateChunk => chunks.get(hash)
        ?? this.host.readRunStateChunk(hash);
    };

    const decodePrivateSuccessor = async (
      successor: ObserverBoundarySuccessorRecord,
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
      this.host.assertObserverBoundaryStagingCurrent(staged.receipt, staged);
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
      successor: ObserverBoundarySuccessorRecord,
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
        staged.stagedMonth.reusableLiveSocialDescriptors,
      );
      this.host.assertObserverBoundaryStagingCurrent(staged.receipt, staged);
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
      this.host.assertObserverBoundaryStagingCurrent(staged.receipt, staged);

      const derived = await projectObserverDerivedHistoryFromVerifiedSuccessor({
        previous: source.artifacts.derivedObserver,
        previousRootChunk: source.root,
        nextState: state,
        nextRootChunk: successor.root,
        nextPhysicalProjection: physical,
        readChunk,
      });
      this.host.assertObserverBoundaryStagingCurrent(staged.receipt, staged);
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
      this.host.assertObserverBoundaryStagingCurrent(staged.receipt, staged);
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
      this.host.assertObserverBoundaryStagingCurrent(staged.receipt, staged);
      return { retention, physical, derived, civilization, checkpoint, authority };
    };

    const rebindLiveSocialDescriptorsToVerifiedSuccessor = (
      successorReceipt: object,
      successor: ObserverBoundarySuccessorRecord,
      state: SimulationState,
    ): void => {
      this.host.assertObserverBoundaryStagingCurrent(staged.receipt, staged);
      this.host.assertOwnedSuccessorCurrent(
        successorReceipt,
        successor,
        sourceToken,
        source.generation,
      );
      if (successor.run.stateHash !== successor.root.hash
        || !stagedHistoryTransitionMatchesSource(parseRunStateRoot(source.root), successor)) {
        throw new RunWriteConflictError(
          "bounded 年度观察 live-social descriptor 重绑缺少当前 exact successor authority",
        );
      }
      registerLiveSocialEvidenceDescriptors(
        state,
        reusableLiveSocialDescriptorsForCurrentOwners(
          state,
          staged.stagedMonth.reusableLiveSocialDescriptors,
        ),
        source.artifacts.retention.continuationBasis.directMatches,
      );
    };

    const observerMaterializationSource = Object.freeze({
      stateHash: factSuccessor.root.hash,
      revision: factSuccessor.run.meta.revision,
      month: factSuccessor.run.meta.elapsedMonths,
    }) satisfies Readonly<RunContinuationObserverMaterializationSourceV1>;
    let finalSuccessorReceipt!: object;
    let finalSuccessor: ObserverBoundarySuccessorRecord | undefined;
    {
      const readFactChunk = privateChunkReader(factSuccessor);
      const decodedFact = await decodePrivateSuccessor(
        factSuccessor,
        readFactChunk,
        "private fact root A",
      );
      rebindLiveSocialDescriptorsToVerifiedSuccessor(
        staged.stagedMonth.factSuccessorReceipt,
        factSuccessor,
        decodedFact.state,
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

      const final = await this.host.stageOwnedSingleMonthSuccessor(
        sourceToken,
        decodedFact.state,
        factSuccessor.run.meta.label,
        staged.stagedMonth.factSuccessorReceipt,
      );
      finalSuccessorReceipt = final.receipt;
      finalSuccessor = final.successor;
    }
    this.host.assertObserverBoundaryStagingCurrent(staged.receipt, staged);
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
    rebindLiveSocialDescriptorsToVerifiedSuccessor(
      finalSuccessorReceipt,
      finalSuccessor,
      decodedFinal.state,
    );
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
    this.host.assertRetentionPinsMatchBundle(
      finalSuccessor.run.id,
      finalProjection.retention.projection,
      encodedBundle.bundle,
    );

    const nextCheckpoint: ObserverBoundaryCheckpointRow = Object.freeze({
      runId: finalSuccessor.run.id,
      revision: finalSuccessor.run.meta.revision,
      month: finalSuccessor.run.meta.elapsedMonths,
      stateHash: finalSuccessor.root.hash,
      createdAt: finalSuccessor.run.meta.updatedAt,
    });
    const nextContinuation: ObserverBoundaryContinuationRow = Object.freeze({
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
    this.host.assertContinuationAuthority(
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

    this.host.commitObserverBoundaryPublication({
      staged,
      factSuccessor,
      finalSuccessor,
      encodedSidecars,
      encodedBundle,
      nextCheckpoint,
      nextContinuation,
      observerMaterializationSource,
    });

    this.host.completeObserverBoundaryPublication({
      staged,
      factSuccessorReceipt: staged.stagedMonth.factSuccessorReceipt,
      finalSuccessorReceipt,
      finalSuccessor,
      nextPhysicalIdentity,
      finalPhysicalProjection: finalProjection.physical,
      publishedReceipt,
      publishedRecord: Object.freeze({
        runId: source.runId,
        revision: finalSuccessor.run.meta.revision,
        month: finalSuccessor.run.meta.elapsedMonths,
        stateHash: finalSuccessor.root.hash,
        stage: decodedFinal.state.civilization.stage,
        boundaryKind: staged.stagedMonth.boundaryKind,
        status: decodedFinal.state.civilization.status,
      }),
    });
    return publishedReceipt;
  }
}
