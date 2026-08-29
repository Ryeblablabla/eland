import type { SimulationState, WorldEvent } from "../src/game/eland/simulation";
import {
  retainedLiveSocialEvidenceForLivingSources,
  retainedProjectPressureEvidenceForLivingSources,
  worldEventById,
} from "../src/game/eland/domain/event-index";
import type { RetainedLiveSocialEvidenceDescriptor } from "../src/game/eland/domain/live-social-evidence";
import { trimCommittedHistoryAfterPersistedCursor } from "../src/game/eland/domain/history";
import { rematerializePhysicalStructureIndex } from "../src/game/eland/domain/physical-structure-index";
import { hydrateWorld } from "../src/game/eland/world/grid";
import { stepOwnedBoundedNonProjectionMonth } from "./bounded-nonprojection-month-controller";
import { adoptStoreDecodedBoundedSimulationState } from "./bounded-simulation-adoption";
import {
  decodeCheckpointAccumulator,
  encodeCheckpointAccumulator,
  projectCheckpointAccumulatorFromVerifiedSuccessor,
  type CheckpointAccumulatorV1,
} from "./checkpoint-accumulator";
import {
  decodeObserverCivilizationHistorySidecar,
  type ObserverCivilizationHistorySidecarPayloadV1,
} from "./civilization-history-codec";
import {
  assertVerifiedObserverCivilizationHistorySuccessor,
  projectObserverCivilizationHistoryFromVerifiedSuccessor,
} from "./observer-civilization-history-successor";
import { decodeHistoryRetentionSidecar } from "./history-retention-codec";
import type { HistoryRetentionProjectionResult } from "./history-retention-projection";
import {
  assertHistoryRetentionProjectionMatchesVerifiedSuccessor,
  assertVerifiedHistoryRetentionSuccessor,
  projectHistoryRetentionFromVerifiedSuccessor,
} from "./history-retention-successor";
import {
  liveSocialColdMaterializationOrdinals,
  projectPressureColdMaterializationOrdinals,
} from "./retained-history-evidence";
import {
  decodeObserverDerivedHistorySidecar,
  type ObserverDerivedHistorySidecarPayloadV1,
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
  RUN_CONTINUATION_BUNDLE_SCHEMA_VERSION,
  type RunContinuationBundleV1,
  type RunContinuationObserverMaterializationSourceV1,
} from "./run-continuation-bundle";
import {
  materializeVerifiedRunHistoryPinnedEvents,
  parseRunStateRoot,
  runHistoryCursorFromRootMetadata,
  type RunHistoryCursor,
  type RunStateChunk,
  type RunStatePinnedEvent,
  type RunStateRootMetadata,
} from "./run-state-codec";
import { RunWriteConflictError } from "./run-persistence";
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

declare const boundedNonProjectionMonthStagingReceiptBrand: unique symbol;
declare const boundedNonProjectionMonthPublishedReceiptBrand: unique symbol;

/** Store-minted proof of one controller-stepped, not-yet-persisted month. */
export interface BoundedNonProjectionMonthStagingReceipt {
  readonly kind: "bounded-nonprojection-month-staging-receipt-v1";
  readonly persisted: false;
  readonly continuationReady: false;
  readonly [boundedNonProjectionMonthStagingReceiptBrand]: true;
}

/** Proof that one bounded month and all successor sidecars committed atomically. */
export interface BoundedNonProjectionMonthPublishedReceipt {
  readonly persisted: true;
  readonly continuationReady: false;
  readonly revision: number;
  readonly month: number;
  readonly stateHash: string;
  readonly [boundedNonProjectionMonthPublishedReceiptBrand]: true;
}

export interface NonProjectionSourceRecord extends ObserverBoundarySourceRecord {
  readonly observerMaterializationSource?: Readonly<RunContinuationObserverMaterializationSourceV1>;
  readonly observerMaterializationSourceRoot?: RunStateChunk;
}

export interface NonProjectionMonthStagingRecord {
  readonly sourceToken: object;
  readonly sourceGeneration: number;
  readonly runId: string;
  readonly sourceRootHash: string;
  readonly sourceMonth: number;
  readonly nextMonth: number;
  readonly nextRootHash: string;
  readonly successorReceipt: object;
  readonly ownedNextState: SimulationState;
  readonly reusableLiveSocialDescriptors: readonly RetainedLiveSocialEvidenceDescriptor[];
}

export interface NonProjectionStagingContext {
  readonly receipt: object;
  readonly stagedMonth: NonProjectionMonthStagingRecord;
  readonly successor: ObserverBoundarySuccessorRecord;
  readonly sourceToken: object;
  readonly source: NonProjectionSourceRecord;
}

export interface NonProjectionStagingCandidate
  extends Omit<NonProjectionStagingContext, "successor"> {
  readonly successor?: ObserverBoundarySuccessorRecord;
}

export interface NonProjectionVerifiedArtifacts {
  readonly retention: Readonly<HistoryRetentionProjectionResult>;
  readonly physical: Readonly<PhysicalStructureLedgerProjectionResult>;
  readonly derivedObserver: Readonly<ObserverDerivedHistorySidecarPayloadV1>;
  readonly civilizationObserver: Readonly<ObserverCivilizationHistorySidecarPayloadV1>;
  readonly checkpoint: Readonly<CheckpointAccumulatorV1>;
}

export interface NonProjectionPublicationCommit {
  readonly staged: NonProjectionStagingContext;
  readonly successor: ObserverBoundarySuccessorRecord;
  readonly encodedSidecars: Readonly<ObserverBoundaryEncodedSidecars>;
  readonly encodedBundle: ReturnType<typeof encodeRunContinuationBundle>;
  readonly nextCheckpoint: ObserverBoundaryCheckpointRow;
  readonly nextContinuation: ObserverBoundaryContinuationRow;
}

export interface PreparedWarmNonProjectionContinuation {
  readonly state: SimulationState;
  readonly artifacts: Readonly<NonProjectionVerifiedArtifacts>;
}

export interface NonProjectionPublicationFinalization {
  readonly staged: NonProjectionStagingContext;
  readonly successor: ObserverBoundarySuccessorRecord;
  readonly encodedSidecars: Readonly<ObserverBoundaryEncodedSidecars>;
  readonly encodedBundle: ReturnType<typeof encodeRunContinuationBundle>;
  readonly nextCheckpoint: ObserverBoundaryCheckpointRow;
  readonly nextContinuation: ObserverBoundaryContinuationRow;
  readonly physicalProjection: Readonly<PhysicalStructureLedgerProjectionResult>;
  readonly nextPhysicalIdentity: ObserverBoundaryChunkIdentity;
  readonly publishedReceipt: BoundedNonProjectionMonthPublishedReceipt;
  readonly publishedRecord: Readonly<{
    runId: string;
    revision: number;
    month: number;
    stateHash: string;
  }>;
  readonly prepareWarmContinuation: () => PreparedWarmNonProjectionContinuation;
}

/** Narrow composition port; no SQLite, generic transaction/writer or registry escapes it. */
export interface SqliteBoundedNonProjectionPublicationHost {
  openOwnedMonth(id: string): Promise<{
    readonly state: SimulationState;
    readonly continuationToken: object;
  }>;
  stageOwnedSingleMonthSuccessor(
    token: object,
    state: SimulationState,
    label?: string,
  ): Promise<ObserverBoundaryOwnedSuccessorStage>;
  registerStaging(
    receipt: BoundedNonProjectionMonthStagingReceipt,
    record: NonProjectionMonthStagingRecord,
  ): void;
  resolveStaging(receipt: unknown): NonProjectionStagingCandidate;
  discardStaging(receipt: object, staging: NonProjectionMonthStagingRecord): void;
  assertSourceSnapshotCurrent(sourceToken: object, source: NonProjectionSourceRecord): void;
  hasPublishedReceipt(receipt: unknown): boolean;
  readRunStateChunk(hash: string): RunStateChunk;
  assertDecodedRunSummary(run: ObserverBoundaryRunRow, state: SimulationState): void;
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
  snapshotContinuationChunkIdentity(chunk: {
    readonly hash: string;
    readonly codec: string;
    readonly rawSize: number;
    readonly data: Uint8Array;
  }): ObserverBoundaryChunkIdentity;
  commitPublication(input: NonProjectionPublicationCommit): void;
  completePublication(input: NonProjectionPublicationFinalization): void;
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

export class SqliteBoundedNonProjectionPublication {
  constructor(private readonly host: SqliteBoundedNonProjectionPublicationHost) {}

  ownsStagingReceipt(receipt: unknown): receipt is BoundedNonProjectionMonthStagingReceipt {
    try {
      this.currentStaging(receipt);
      return true;
    } catch {
      return false;
    }
  }

  ownsPublishedReceipt(receipt: unknown): receipt is BoundedNonProjectionMonthPublishedReceipt {
    return this.host.hasPublishedReceipt(receipt);
  }

  private currentStaging(receipt: unknown): NonProjectionStagingContext {
    const current = this.host.resolveStaging(receipt);
    const { stagedMonth, successor, sourceToken, source } = current;
    const sourceRoot = parseRunStateRoot(source.root);
    if (!successor
      || source.runId !== stagedMonth.runId
      || source.generation !== stagedMonth.sourceGeneration
      || source.root.hash !== stagedMonth.sourceRootHash
      || successor.sourceToken !== sourceToken
      || successor.sourceGeneration !== source.generation
      || source.run.meta.elapsedMonths !== stagedMonth.sourceMonth
      || successor.run.id !== source.runId
      || successor.run.meta.revision !== source.run.meta.revision + 1
      || successor.run.meta.elapsedMonths !== stagedMonth.nextMonth
      || successor.run.stateHash !== successor.root.hash
      || successor.root.hash !== stagedMonth.nextRootHash
      || stagedMonth.ownedNextState.clock.elapsedMonths !== stagedMonth.nextMonth
      || stagedMonth.nextMonth !== stagedMonth.sourceMonth + 1
      || stagedMonth.nextMonth % 12 === 0
      || !stagedHistoryTransitionMatchesSource(sourceRoot, successor)) {
      this.host.discardStaging(current.receipt, stagedMonth);
      throw new RunWriteConflictError(
        "bounded 非投影单月 receipt 与 source token/exact successor staging 失配",
      );
    }
    return { ...current, successor };
  }

  assertCurrentStaging(
    receipt: object,
    expected: NonProjectionStagingContext,
  ): void {
    const current = this.currentStaging(receipt);
    if (current.stagedMonth !== expected.stagedMonth
      || current.successor !== expected.successor
      || current.sourceToken !== expected.sourceToken
      || current.source !== expected.source) {
      throw new RunWriteConflictError(
        "bounded 非投影单月 staging join 在异步投影期间发生替换",
      );
    }
    this.host.assertSourceSnapshotCurrent(current.sourceToken, current.source);
  }

  async stage(
    id: string,
    label?: string,
  ): Promise<BoundedNonProjectionMonthStagingReceipt> {
    const opened = await this.host.openOwnedMonth(id);
    const sourceMonth = opened.state.clock.elapsedMonths;
    const reusableLiveSocialDescriptors = Object.freeze([
      ...retainedLiveSocialEvidenceForLivingSources(opened.state),
    ]);
    const stepped = stepOwnedBoundedNonProjectionMonth(opened.state);
    const staged = await this.host.stageOwnedSingleMonthSuccessor(
      opened.continuationToken,
      stepped,
      label,
    );
    if (!staged.successor
      || staged.successor.sourceToken !== staged.sourceToken
      || staged.successor.sourceGeneration !== staged.source.generation) {
      throw new Error("bounded 非投影单月没有生成同一 store generation 的 exact successor staging");
    }
    const receipt = Object.freeze({
      kind: "bounded-nonprojection-month-staging-receipt-v1",
      persisted: false,
      continuationReady: false,
    }) as BoundedNonProjectionMonthStagingReceipt;
    this.host.registerStaging(receipt, Object.freeze({
      sourceToken: staged.sourceToken,
      sourceGeneration: staged.source.generation,
      runId: staged.source.runId,
      sourceRootHash: staged.source.root.hash,
      sourceMonth,
      nextMonth: stepped.clock.elapsedMonths,
      nextRootHash: staged.successor.root.hash,
      successorReceipt: staged.receipt,
      ownedNextState: stepped,
      reusableLiveSocialDescriptors,
    }));
    return receipt;
  }

  async publish(
    receiptInput: BoundedNonProjectionMonthStagingReceipt,
  ): Promise<BoundedNonProjectionMonthPublishedReceipt> {
    const staged = this.currentStaging(receiptInput);
    this.assertCurrentStaging(staged.receipt, staged);
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
    const readPublicationChunk = (hash: string): RunStateChunk => (
      stagedChunks.get(hash) ?? this.host.readRunStateChunk(hash)
    );

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
    this.host.assertDecodedRunSummary(successor.run, nextState);

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
      staged.stagedMonth.reusableLiveSocialDescriptors,
    );
    this.assertCurrentStaging(staged.receipt, staged);
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
    this.assertCurrentStaging(staged.receipt, staged);

    const derivedSuccessor = await projectObserverDerivedHistoryFromVerifiedSuccessor({
      previous: source.artifacts.derivedObserver,
      previousRootChunk: source.root,
      nextState,
      nextRootChunk: successor.root,
      nextPhysicalProjection: physicalSuccessor,
      readChunk: readPublicationChunk,
    });
    this.assertCurrentStaging(staged.receipt, staged);
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
    this.assertCurrentStaging(staged.receipt, staged);
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
    this.assertCurrentStaging(staged.receipt, staged);

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
    this.host.assertRetentionPinsMatchBundle(
      successor.run.id,
      retentionSuccessor.projection,
      encodedBundle.bundle,
    );

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
    const warmArtifacts: NonProjectionVerifiedArtifacts = Object.freeze({
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
    const warmPinnedEvents: RunStatePinnedEvent[] = encodedBundle.bundle.coldPins.map((pin) => {
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
    const reusableLiveSocialDescriptors =
      retainedLiveSocialEvidenceForLivingSources(nextState);
    const nextHotStartIndex = Math.max(
      0,
      nextRoot.eventCount - source.continuation.hotEventLimit,
    );

    const nextCheckpoint: ObserverBoundaryCheckpointRow = Object.freeze({
      runId: successor.run.id,
      revision: successor.run.meta.revision,
      month: successor.run.meta.elapsedMonths,
      stateHash: successor.root.hash,
      createdAt: successor.run.meta.updatedAt,
    });
    const nextContinuation: ObserverBoundaryContinuationRow = Object.freeze({
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
    this.host.assertContinuationAuthority(
      successor.run,
      nextContinuation,
      nextCheckpoint,
      successor.root,
      nextRoot,
      encodedBundle.bundle,
    );

    const nextPhysicalIdentity = this.host.snapshotContinuationChunkIdentity({
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

    this.host.commitPublication({
      staged,
      successor,
      encodedSidecars,
      encodedBundle,
      nextCheckpoint,
      nextContinuation,
    });

    this.host.completePublication({
      staged,
      successor,
      encodedSidecars,
      encodedBundle,
      nextCheckpoint,
      nextContinuation,
      physicalProjection: physicalSuccessor,
      nextPhysicalIdentity,
      publishedReceipt,
      publishedRecord: Object.freeze({
        runId: source.runId,
        revision: successor.run.meta.revision,
        month: successor.run.meta.elapsedMonths,
        stateHash: successor.root.hash,
      }),
      prepareWarmContinuation: () => {
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
        const warmLiveSocialSources = materializeVerifiedRunHistoryPinnedEvents(
          nextRoot,
          readPublicationChunk,
          liveSocialColdMaterializationOrdinals(
            nextState,
            warmArtifacts.retention,
            warmPinnedEvents,
            reusableLiveSocialDescriptors,
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
          warmLiveSocialSources,
          reusableLiveSocialDescriptors,
          warmArtifacts.physical,
        );
        return { state: nextState, artifacts: warmArtifacts };
      },
    });
    return publishedReceipt;
  }
}
