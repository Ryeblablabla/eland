import { isDeepStrictEqual } from "node:util";

import type { SimulationState } from "../src/game/eland/simulation";
import { boundedObserverBoundaryMatchesState } from "./bounded-observer-boundary-month-controller";
import { assertLastMaterializedObserverBasis, type LastMaterializedObserverBasis } from "./bounded-observer-hot-shell";
import { LAST_MATERIALIZED_OBSERVER_BASIS_FIELD } from "./bounded-gameplay-shell";
import { adoptStoreDecodedBoundedSimulationState } from "./bounded-simulation-adoption";
import {
  decodeCheckpointAccumulator, encodeCheckpointAccumulator,
  projectCheckpointAccumulatorFromVerifiedRunRoot, type CheckpointAccumulatorV1,
} from "./checkpoint-accumulator";
import {
  decodeObserverCivilizationHistorySidecar, encodeObserverCivilizationHistorySidecar,
  type ObserverCivilizationHistorySidecarPayloadV1,
} from "./civilization-history-codec";
import {
  beginObserverCivilizationHistoryProjection, finishObserverCivilizationHistoryProjection,
  foldVerifiedObserverCivilizationHistorySegment,
} from "./observer-civilization-history-projection";
import { decodeHistoryRetentionSidecar, encodeHistoryRetentionSidecar } from "./history-retention-codec";
import {
  assertHistoryRetentionProjectionMatchesShell, beginHistoryRetentionProjection,
  finishHistoryRetentionProjection, foldHistoryRetentionSegment,
  type HistoryRetentionProjectionResult,
} from "./history-retention-projection";
import { liveSocialColdMaterializationOrdinals, projectPressureColdMaterializationOrdinals } from "./retained-history-evidence";
import {
  decodeObserverDerivedHistorySidecar, encodeObserverDerivedHistorySidecar,
  type ObserverDerivedHistorySidecarPayloadV1,
} from "./observer-derived-history-codec";
import { collectObserverDerivedHistoryGenesisDemandFromVerifiedShell } from "./observer-derived-history-demand";
import {
  beginObserverDerivedHistoryProjection, finishObserverDerivedHistoryProjection,
  foldVerifiedObserverDerivedHistorySegment,
} from "./observer-derived-history-projection";
import { decodePhysicalStructureLedgerSidecar, encodePhysicalStructureLedgerSidecar } from "./physical-structure-ledger-codec";
import {
  bootstrapPhysicalStructureLedgerFromStrictDecodedSidecar, decodeBoundedGameplayRunStateWithPhysicalProjection,
  type PhysicalStructureLedgerProjectionResult,
} from "./physical-structure-ledger-projection";
import {
  encodeRunContinuationBundle, RUN_CONTINUATION_BUNDLE_SCHEMA_VERSION,
  type RunContinuationBundleV1, type RunContinuationContentHashReferenceV1,
  type RunContinuationObserverMaterializationSourceV1,
} from "./run-continuation-bundle";
import {
  materializeVerifiedRunHistoryPinnedEvents, parseRunStateRoot,
  runHistoryCursorFromRootMetadata, snapshotRunStateChunk, streamVerifiedRunHistorySegments,
  RUN_STATE_ROOT_CODEC,
  type DecodedBoundedGameplayRunState, type RunHistoryCursor, type RunStateChunk,
  type RunStateGameplayBoundedDecodeOptions, type RunStatePinnedEvent, type RunStateRootMetadata,
} from "./run-state-codec";
import type {
  BoundedPublicationCheckpointRow, BoundedPublicationChunkIdentity,
  BoundedPublicationContinuationRow, BoundedPublicationEncodedSidecars, BoundedPublicationRunRow,
} from "./sqlite-bounded-publication-contract";

export const RUN_CONTINUATION_SIDECAR_NAMES = [
  "retention", "physical", "derivedObserver", "civilizationObserver", "checkpoint",
] as const;
export type RunContinuationSidecarName = typeof RUN_CONTINUATION_SIDECAR_NAMES[number];

export interface BoundedContinuationBootstrapSourceSnapshot {
  readonly run: BoundedPublicationRunRow;
  readonly checkpoint: BoundedPublicationCheckpointRow;
  readonly root: RunStateChunk;
  readonly metadata: Readonly<RunStateRootMetadata>;
}

export interface BoundedContinuationRefreshSourceSnapshot
  extends BoundedContinuationBootstrapSourceSnapshot {
  readonly continuation: BoundedPublicationContinuationRow;
  readonly bundleChunk: RunStateChunk;
  readonly bundle: Readonly<RunContinuationBundleV1>;
  readonly sidecars: Readonly<Record<RunContinuationSidecarName, BoundedPublicationChunkIdentity>>;
  readonly observerMaterializationSourceRoot?: RunStateChunk;
}

export interface BuiltBoundedContinuationArtifacts {
  readonly continuation: BoundedPublicationContinuationRow;
  readonly encodedSidecars: Readonly<BoundedPublicationEncodedSidecars>;
  readonly encodedBundle: ReturnType<typeof encodeRunContinuationBundle>;
  readonly physicalProjection: Readonly<PhysicalStructureLedgerProjectionResult>;
}

export interface BoundedContinuationOpenArtifactSource {
  readonly run: BoundedPublicationRunRow;
  readonly checkpoint: BoundedPublicationCheckpointRow;
  readonly root: RunStateChunk;
  readonly metadata: Readonly<RunStateRootMetadata>;
  readonly bundle: Readonly<RunContinuationBundleV1>;
}

export interface MaterializedBoundedContinuationOpenArtifacts {
  readonly state: SimulationState;
  readonly pinnedEvents: RunStatePinnedEvent[];
  readonly observerMaterializationSourceRoot?: RunStateChunk;
  readonly sidecars: Readonly<
    Record<RunContinuationSidecarName, BoundedPublicationChunkIdentity>
  >;
  readonly artifacts: Readonly<{
    retention: Readonly<HistoryRetentionProjectionResult>;
    physical: Readonly<PhysicalStructureLedgerProjectionResult>;
    derivedObserver: Readonly<ObserverDerivedHistorySidecarPayloadV1>;
    civilizationObserver: Readonly<ObserverCivilizationHistorySidecarPayloadV1>;
    checkpoint: Readonly<CheckpointAccumulatorV1>;
  }>;
}

interface BoundedContinuationPhysicalCacheSelection {
  readonly runId: string;
  readonly revision: number;
  readonly stateHash: string;
  readonly sidecar: Readonly<BoundedPublicationChunkIdentity>;
}

/**
 * Narrow read/materialization port. SQLite, transactions, continuation
 * registries, cache maps and token ownership remain in the composing store.
 */
export interface SqliteBoundedContinuationArtifactMaterializationHost {
  readRunStateChunk(hash: string): RunStateChunk;
  decodeContinuationOpenGameplay(
    root: RunStateChunk,
    readChunk: (hash: string) => RunStateChunk,
    options: RunStateGameplayBoundedDecodeOptions,
  ): Promise<DecodedBoundedGameplayRunState>;
  selectCachedPhysicalProjection(
    selection: BoundedContinuationPhysicalCacheSelection,
  ): Readonly<PhysicalStructureLedgerProjectionResult> | null;
  assertDecodedRunSummary(run: BoundedPublicationRunRow, state: SimulationState): void;
  assertContinuationAuthority(
    run: BoundedPublicationRunRow,
    continuation: BoundedPublicationContinuationRow,
    checkpoint: BoundedPublicationCheckpointRow,
    root: RunStateChunk,
    rootMetadata: RunStateRootMetadata,
    bundle: Readonly<RunContinuationBundleV1>,
  ): void;
  assertRetentionPinsMatchBundle(
    runId: string,
    projection: Readonly<HistoryRetentionProjectionResult>,
    bundle: Readonly<RunContinuationBundleV1>,
  ): void;
  contentHashReferenceFor(
    reference: RunContinuationBundleV1["sidecars"][RunContinuationSidecarName],
    runId: string,
    name: RunContinuationSidecarName,
  ): Readonly<RunContinuationContentHashReferenceV1>;
  snapshotContinuationChunkIdentity(
    chunk: RunStateChunk,
  ): BoundedPublicationChunkIdentity;
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

function sameHistoryCursor(
  left: Readonly<RunHistoryCursor>,
  right: Readonly<RunHistoryCursor>,
): boolean {
  return left.lineageId === right.lineageId
    && left.historyHeadHash === right.historyHeadHash
    && left.eventCount === right.eventCount
    && left.tailEventContentHash === right.tailEventContentHash;
}

/** Non-transactional construction and reopening of bounded continuation artifacts. */
export class SqliteBoundedContinuationArtifactMaterialization {
  constructor(
    private readonly host: SqliteBoundedContinuationArtifactMaterializationHost,
  ) {}

  /**
   * Build all continuation projections from one immutable schema-3 root. This
   * does no SQLite writes; bootstrap and same-root refresh supply their own
   * source-current assertion and short publication transaction.
   */
  async buildBoundedContinuationArtifacts(
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
    const readSourceChunk = (hash: string): RunStateChunk => (
      this.host.readRunStateChunk(hash)
    );
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
    this.host.assertDecodedRunSummary(source.run, state);

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
    this.host.assertRetentionPinsMatchBundle(
      source.run.id,
      encodedSidecars.retention.projection,
      encodedBundle.bundle,
    );

    const continuation: BoundedPublicationContinuationRow = Object.freeze({
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
    this.host.assertContinuationAuthority(
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

  /** Decode and join every store-selected continuation artifact without minting authority. */
  async materializeBoundedContinuationOpen(
    source: Readonly<BoundedContinuationOpenArtifactSource>,
  ): Promise<MaterializedBoundedContinuationOpenArtifacts> {
    const normalizedId = source.run.id;
    const runSnapshot = source.run;
    const checkpointSnapshot = source.checkpoint;
    const rootSnapshot = source.root;
    const rootMetadata = source.metadata;
    const bundle = source.bundle;

    // The manifest alone selects every retained cold ordinal. There is no
    // caller-provided option merge or event-id lookup on this authority path.
    const decoded = await this.host.decodeContinuationOpenGameplay(
      rootSnapshot,
      (chunkHash) => this.host.readRunStateChunk(chunkHash),
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
    this.host.assertDecodedRunSummary(runSnapshot, decoded.state);
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
        this.host.readRunStateChunk(observerSource.stateHash),
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
    const sidecars = {} as Record<
      RunContinuationSidecarName,
      BoundedPublicationChunkIdentity
    >;

    // Decode one store-selected sidecar at a time. Only its scalar content
    // identity and normalized artifact survive the local scope; raw bytes are
    // eligible for collection before the next potentially large sidecar opens.
    const retention = (() => {
      const name = "retention" as const;
      const reference = this.host.contentHashReferenceFor(
        bundle.sidecars[name],
        normalizedId,
        name,
      );
      const chunk = this.host.readRunStateChunk(reference.hash);
      const artifact = decodeHistoryRetentionSidecar(chunk, {
        reference,
        boundary: retentionBoundary,
      });
      sidecars[name] = this.host.snapshotContinuationChunkIdentity(chunk);
      return artifact;
    })();
    this.host.assertRetentionPinsMatchBundle(normalizedId, retention, bundle);

    const physicalSidecar = (() => {
      const name = "physical" as const;
      const reference = this.host.contentHashReferenceFor(
        bundle.sidecars[name],
        normalizedId,
        name,
      );
      const chunk = this.host.readRunStateChunk(reference.hash);
      const artifact = decodePhysicalStructureLedgerSidecar(chunk, {
        reference,
        boundary: retentionBoundary,
      });
      sidecars[name] = this.host.snapshotContinuationChunkIdentity(chunk);
      return artifact;
    })();

    const derivedObserver = (() => {
      const name = "derivedObserver" as const;
      const reference = this.host.contentHashReferenceFor(
        bundle.sidecars[name],
        normalizedId,
        name,
      );
      const chunk = this.host.readRunStateChunk(reference.hash);
      const artifact = decodeObserverDerivedHistorySidecar(chunk, {
        reference,
        boundary: { target: observerTarget },
      });
      sidecars[name] = this.host.snapshotContinuationChunkIdentity(chunk);
      return artifact;
    })();

    const civilizationObserver = (() => {
      const name = "civilizationObserver" as const;
      const reference = this.host.contentHashReferenceFor(
        bundle.sidecars[name],
        normalizedId,
        name,
      );
      const chunk = this.host.readRunStateChunk(reference.hash);
      const artifact = decodeObserverCivilizationHistorySidecar(chunk, {
        reference,
        boundary: { target: observerTarget },
      });
      sidecars[name] = this.host.snapshotContinuationChunkIdentity(chunk);
      return artifact;
    })();

    const checkpoint = (() => {
      const name = "checkpoint" as const;
      const reference = this.host.contentHashReferenceFor(
        bundle.sidecars[name],
        normalizedId,
        name,
      );
      const chunk = this.host.readRunStateChunk(reference.hash);
      const artifact = decodeCheckpointAccumulator(chunk, {
        reference,
        boundary: checkpointBoundary,
      });
      sidecars[name] = this.host.snapshotContinuationChunkIdentity(chunk);
      return artifact;
    })();

    const cachedPhysical = this.host.selectCachedPhysicalProjection({
      runId: normalizedId,
      revision: runSnapshot.meta.revision,
      stateHash: runSnapshot.stateHash,
      sidecar: sidecars.physical,
    });
    let physical: Readonly<PhysicalStructureLedgerProjectionResult>;
    if (cachedPhysical) {
      physical = cachedPhysical;
    } else {
      // Bootstrap seals only the exact root/history/grid scalars. It does not
      // retain the decoded state, so the controller may advance this same
      // object in place without an expensive restart-only clone.
      physical = await bootstrapPhysicalStructureLedgerFromStrictDecodedSidecar(
        physicalSidecar,
        decoded.state,
        rootSnapshot,
        (chunkHash) => this.host.readRunStateChunk(chunkHash),
      );
    }
    const canonicalPhysical = encodePhysicalStructureLedgerSidecar(physical);
    const selectedPhysicalReference = this.host.contentHashReferenceFor(
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
      (chunkHash) => this.host.readRunStateChunk(chunkHash),
      projectPressureColdMaterializationOrdinals(
        decoded.state,
        retention,
        decoded.pinnedEvents,
      ),
    );
    const liveSocialSources = materializeVerifiedRunHistoryPinnedEvents(
      rootMetadata,
      (chunkHash) => this.host.readRunStateChunk(chunkHash),
      liveSocialColdMaterializationOrdinals(
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
      liveSocialSources,
      [],
      physicalSidecar,
    );

    return Object.freeze({
      state: decoded.state,
      pinnedEvents: decoded.pinnedEvents,
      ...(observerMaterializationSourceRoot ? { observerMaterializationSourceRoot } : {}),
      sidecars: Object.freeze(sidecars),
      artifacts: Object.freeze({
        retention,
        physical,
        derivedObserver,
        civilizationObserver,
        checkpoint,
      }),
    });
  }
}
