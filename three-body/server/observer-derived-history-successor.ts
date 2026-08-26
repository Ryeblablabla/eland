import { isDeepStrictEqual } from 'node:util';

import { committedHistoryView } from '../src/game/eland/domain/history';
import type { SimulationState } from '../src/game/eland/domain/model';
import {
  assertDecodedObserverDerivedHistorySidecar,
  encodeObserverDerivedHistorySidecar,
  type EncodedObserverDerivedHistorySidecar,
  type ObserverDerivedHistorySidecarPayloadV1,
} from './observer-derived-history-codec';
import { collectObserverDerivedHistoryDemandFromVerifiedShell } from './observer-derived-history-demand';
import {
  OBSERVER_DERIVED_HISTORY_CONTINUATION_GAPS,
  finishObserverDerivedHistoryProjection,
  foldVerifiedObserverDerivedHistorySegment,
  resumeObserverDerivedHistoryProjection,
  seedVerifiedPrefixDemandLastWrites,
  unresolvedVerifiedPrefixDemandEventIds,
  verifiedObserverPrefixDemandOccurrence,
  type ObserverVerifiedPrefixDemandLastWrite,
  type ObserverDerivedHistoryProjectionFold,
  type ObserverDerivedHistoryTarget,
} from './observer-derived-history-projection';
import {
  assertPhysicalStructureLedgerProjectionMatchesShell,
  type PhysicalStructureLedgerProjectionResult,
} from './physical-structure-ledger-projection';
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
 * Fold-only exact-root successor. It produces canonical bytes for a future
 * store transaction but neither publishes them nor materializes into state.
 */
export const VERIFIED_OBSERVER_DERIVED_HISTORY_SUCCESSOR_KIND =
  'verified-observer-derived-history-successor-v1' as const;

declare const verifiedObserverDerivedHistorySuccessorBrand: unique symbol;

export interface ObserverDerivedHistorySuccessorInput {
  /** Identity minted by the strict store-selected sidecar decoder. */
  readonly previous: Readonly<ObserverDerivedHistorySidecarPayloadV1>;
  readonly previousRootChunk: RunStateChunk;
  /** Bounded shell decoded from the exact next root. */
  readonly nextState: SimulationState;
  readonly nextRootChunk: RunStateChunk;
  /** Must be module-verified and bound to this exact `nextState` identity/root. */
  readonly nextPhysicalProjection: PhysicalStructureLedgerProjectionResult;
  readonly readChunk: (hash: string) => RunStateChunk;
}

export interface VerifiedObserverDerivedHistorySuccessor {
  readonly kind: typeof VERIFIED_OBSERVER_DERIVED_HISTORY_SUCCESSOR_KIND;
  readonly persisted: false;
  readonly authority: Readonly<{ stateHash: string }>;
  readonly previousTarget: Readonly<ObserverDerivedHistoryTarget>;
  readonly target: Readonly<ObserverDerivedHistoryTarget>;
  readonly suffixEventCount: number;
  readonly continuationReady: false;
  readonly continuationGaps: readonly string[];
  readonly encoded: Readonly<EncodedObserverDerivedHistorySidecar>;
  readonly [verifiedObserverDerivedHistorySuccessorBrand]: true;
}

const verifiedSuccessors = new WeakSet<object>();

function sameTarget(
  left: Readonly<ObserverDerivedHistoryTarget>,
  right: Readonly<ObserverDerivedHistoryTarget>,
): boolean {
  return left.stateHash === right.stateHash
    && left.eventCount === right.eventCount
    && left.tailEventId === right.tailEventId;
}

function assertStableRoot(root: Readonly<RunStateRootMetadata>, label: string): void {
  if (root.schemaVersion !== 2 && root.schemaVersion !== 3) {
    throw new Error(`${label}只接受 schema 2/3 root`);
  }
}

function assertKnownContinuationGaps(
  sidecar: Readonly<ObserverDerivedHistorySidecarPayloadV1>,
  label: string,
): void {
  const projection = sidecar.projection;
  if (projection.continuationReady !== false
    || projection.continuationGaps.length !== OBSERVER_DERIVED_HISTORY_CONTINUATION_GAPS.length
    || projection.continuationGaps.some(
      (gap, index) => gap !== OBSERVER_DERIVED_HISTORY_CONTINUATION_GAPS[index],
    )) {
    throw new Error(`${label}必须保持 continuationReady:false 与完整显式 gaps`);
  }
}

function targetForBoundedShell(
  state: SimulationState,
  rootChunk: Readonly<RunStateChunk>,
  root: Readonly<RunStateRootMetadata>,
): ObserverDerivedHistoryTarget {
  const history = committedHistoryView(state);
  const cursor = state.world.historyCursor;
  if (!cursor
    || history.events.length !== history.hotEventCount
    || history.eventCount !== root.eventCount
    || cursor.eventCount !== root.eventCount
    || cursor.hotStartIndex + history.hotEventCount !== cursor.eventCount) {
    throw new Error('derived history successor 的 next bounded shell/cursor 与 exact root 不一致');
  }
  return {
    stateHash: rootChunk.hash,
    eventCount: root.eventCount,
    tailEventId: cursor.tailEventId,
  };
}

/** Runtime provenance check for an artifact minted only after the exact stream sealed. */
export function assertVerifiedObserverDerivedHistorySuccessor(
  value: unknown,
): asserts value is VerifiedObserverDerivedHistorySuccessor {
  if (!value || typeof value !== 'object' || !verifiedSuccessors.has(value)) {
    throw new Error('derived history successor 未经过 module-verified exact-root fold');
  }
}

/**
 * Resume from one strict-decoded observer sidecar and fold only the exact
 * content-addressed history suffix. The caller supplies neither suffix events
 * nor observer demand. Demand is derived from the next bounded shell plus the
 * physical module's root-bound authority before and after streaming.
 */
export async function projectObserverDerivedHistoryFromVerifiedSuccessor(
  input: Readonly<ObserverDerivedHistorySuccessorInput>,
): Promise<Readonly<VerifiedObserverDerivedHistorySuccessor>> {
  assertDecodedObserverDerivedHistorySidecar(input.previous);
  assertKnownContinuationGaps(input.previous, 'derived history previous sidecar');

  // Own both caller chunks synchronously before the first await.
  const previousRootChunk = snapshotRunStateChunk(input.previousRootChunk);
  const nextRootChunk = snapshotRunStateChunk(input.nextRootChunk);
  const previousRoot = parseRunStateRoot(previousRootChunk);
  const nextRoot = parseRunStateRoot(nextRootChunk);
  assertStableRoot(previousRoot, 'derived history previous root');
  assertStableRoot(nextRoot, 'derived history next root');

  const previousTarget = input.previous.projection.target;
  if (previousTarget.stateHash !== previousRootChunk.hash
    || previousTarget.eventCount !== previousRoot.eventCount) {
    throw new Error('derived history previous sidecar target 与 exact previous root 不一致');
  }
  if (nextRootChunk.hash === previousRootChunk.hash
    || nextRoot.eventCount < previousRoot.eventCount) {
    throw new Error('derived history successor root 必须不同且 event count 不得倒退');
  }

  const target = targetForBoundedShell(input.nextState, nextRootChunk, nextRoot);
  assertPhysicalStructureLedgerProjectionMatchesShell(
    input.nextState,
    nextRootChunk.hash,
    input.nextPhysicalProjection,
  );
  const demand = collectObserverDerivedHistoryDemandFromVerifiedShell({
    previous: input.previous,
    nextState: input.nextState,
    nextStateHash: nextRootChunk.hash,
    physicalProjection: input.nextPhysicalProjection,
  });

  // The fold is never exposed. Releasing this sole reference in the catch path
  // discards all staged maps when root verification fails after a visitor ran.
  let fold: ObserverDerivedHistoryProjectionFold | undefined =
    resumeObserverDerivedHistoryProjection(input.previous.projection, target, demand);
  try {
    const successor = target.eventCount === previousTarget.eventCount
      ? verifyRunStateSameHistoryShellSuccessor(previousRootChunk, nextRootChunk)
      : await streamVerifiedRunHistorySuccessorSegments(
        previousRootChunk,
        nextRootChunk,
        input.readChunk,
        (events, position) => {
          if (!fold) throw new Error('derived history successor fold 已作废');
          foldVerifiedObserverDerivedHistorySegment(
            fold,
            events,
            position.startEventIndex,
          );
        },
      );

    if (successor.previousRootHash !== previousRootChunk.hash
      || successor.nextRootHash !== nextRootChunk.hash
      || successor.previous.lineageId !== previousRoot.lineageId
      || successor.previous.historyHeadHash !== previousRoot.historyHeadHash
      || successor.previous.eventCount !== previousTarget.eventCount
      || successor.previous.tailEventContentHash !== previousRoot.tailEventContentHash
      || successor.next.lineageId !== nextRoot.lineageId
      || successor.next.historyHeadHash !== nextRoot.historyHeadHash
      || successor.next.eventCount !== target.eventCount
      || successor.next.tailEventContentHash !== nextRoot.tailEventContentHash
      || successor.suffixEventCount !== target.eventCount - previousTarget.eventCount) {
      throw new Error('derived history successor receipt 与 exact roots/shell 不一致');
    }

    const unresolvedPrefixDemandIds = unresolvedVerifiedPrefixDemandEventIds(fold);
    if (unresolvedPrefixDemandIds.length > 0) {
      const required = new Set(unresolvedPrefixDemandIds);
      const lastWritesByEventId = new Map<string, ObserverVerifiedPrefixDemandLastWrite>(
        unresolvedPrefixDemandIds.map((eventId) => [eventId, {
          eventId,
          latestWorld: null,
          latestAction: null,
        }]),
      );
      const verifiedPrefix = await streamVerifiedRunHistorySegments(
        previousRoot,
        input.readChunk,
        (events, position) => {
          for (let offset = 0; offset < events.length; offset += 1) {
            const event = events[offset];
            if (!required.has(event.id)) continue;
            const occurrence = verifiedObserverPrefixDemandOccurrence(
              event,
              position.startEventIndex + offset,
            );
            const previousMatch = lastWritesByEventId.get(event.id);
            if (!previousMatch) {
              throw new Error(`derived history prefix demand ${event.id} 不属于 unresolved closure`);
            }
            lastWritesByEventId.set(event.id, {
              eventId: event.id,
              latestWorld: occurrence,
              latestAction: occurrence.isAction
                ? occurrence
                : previousMatch.latestAction,
            });
          }
        },
      );
      if (verifiedPrefix.eventCount !== previousRoot.eventCount
        || verifiedPrefix.historyHeadHash !== previousRoot.historyHeadHash
        || verifiedPrefix.lineageId !== previousRoot.lineageId
        || verifiedPrefix.tailEventContentHash !== previousRoot.tailEventContentHash) {
        throw new Error('derived history prefix demand bridge 未验证 exact previous root');
      }
      seedVerifiedPrefixDemandLastWrites(
        fold,
        verifiedPrefix.eventCount,
        [...lastWritesByEventId.values()].sort((left, right) => (
          left.eventId.localeCompare(right.eventId)
        )),
      );
    }

    const targetAfterStream = targetForBoundedShell(input.nextState, nextRootChunk, nextRoot);
    if (!sameTarget(targetAfterStream, target)) {
      throw new Error('derived history successor 的 next bounded shell 在折叠期间漂移');
    }
    assertPhysicalStructureLedgerProjectionMatchesShell(
      input.nextState,
      nextRootChunk.hash,
      input.nextPhysicalProjection,
    );
    const demandAfterStream = collectObserverDerivedHistoryDemandFromVerifiedShell({
      previous: input.previous,
      nextState: input.nextState,
      nextStateHash: nextRootChunk.hash,
      physicalProjection: input.nextPhysicalProjection,
    });
    if (!isDeepStrictEqual(demandAfterStream, demand)) {
      throw new Error('derived history successor 的 shell demand 在折叠期间漂移');
    }

    if (!fold) throw new Error('derived history successor fold 在 finish 前已作废');
    const projection = finishObserverDerivedHistoryProjection(fold);
    fold = undefined;
    const encoded = encodeObserverDerivedHistorySidecar({
      sourceDemand: demand,
      projection,
    });
    if (!sameTarget(encoded.sidecar.projection.target, target)
      || !isDeepStrictEqual(encoded.sidecar.sourceDemand, demand)) {
      throw new Error('derived history successor canonical sidecar authority/demand 漂移');
    }
    assertKnownContinuationGaps(encoded.sidecar, 'derived history successor sidecar');

    const result = Object.freeze({
      kind: VERIFIED_OBSERVER_DERIVED_HISTORY_SUCCESSOR_KIND,
      persisted: false as const,
      authority: Object.freeze({ stateHash: nextRootChunk.hash }),
      previousTarget: Object.freeze({ ...previousTarget }),
      target: Object.freeze({ ...target }),
      suffixEventCount: successor.suffixEventCount,
      continuationReady: false as const,
      continuationGaps: encoded.sidecar.projection.continuationGaps,
      encoded,
    }) as Readonly<VerifiedObserverDerivedHistorySuccessor>;
    verifiedSuccessors.add(result);
    return result;
  } catch (error) {
    fold = undefined;
    throw error;
  }
}
