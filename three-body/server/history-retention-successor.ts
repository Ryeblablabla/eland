import type { SimulationState } from '../src/game/eland/domain/model';
import {
  assertDecodedHistoryRetentionSidecar,
  encodeHistoryRetentionSidecar,
  type EncodedHistoryRetentionSidecar,
} from './history-retention-codec';
import {
  assertHistoryRetentionProjectionMatchesDemandSnapshot,
  finishHistoryRetentionProjection,
  foldHistoryRetentionSegment,
  prepareHistoryRetentionDemandSnapshot,
  resumeHistoryRetentionProjection,
  seedVerifiedPrefixLogisticsIndexMatches,
  seedVerifiedPrefixRecentTerminalFailureActionMatches,
  seedVerifiedPrefixSocialLearningSourceMatches,
  unresolvedVerifiedPrefixLogisticsIndexEventIds,
  unresolvedVerifiedPrefixRecentTerminalFailureActionEventIds,
  unresolvedVerifiedPrefixSocialLearningSourceEventIds,
  type HistoryRetentionDemandSnapshot,
  type HistoryRetentionContinuationMatch,
  type HistoryRetentionProjectionResult,
  type HistoryRetentionSeal,
} from './history-retention-projection';
import {
  parseRunStateRoot,
  snapshotRunStateChunk,
  streamVerifiedRunHistorySegments,
  streamVerifiedRunHistorySuccessorSegments,
  verifyRunStateSameHistoryShellSuccessor,
  type RunStateChunk,
} from './run-state-codec';

export const HISTORY_RETENTION_VERIFIED_SUCCESSOR_DEFINITION =
  'history-retention-verified-successor-v1' as const;

export interface VerifiedHistoryRetentionSuccessor {
  readonly kind: typeof HISTORY_RETENTION_VERIFIED_SUCCESSOR_DEFINITION;
  readonly previousRootHash: string;
  readonly nextRootHash: string;
  readonly suffixEventCount: number;
  readonly projection: Readonly<HistoryRetentionProjectionResult>;
  readonly encoded: Readonly<EncodedHistoryRetentionSidecar>;
}

interface VerifiedSuccessorOwnership {
  readonly nextState: SimulationState;
  readonly previousRootHash: string;
  readonly nextRootHash: string;
  readonly demandSnapshot: HistoryRetentionDemandSnapshot;
}

/**
 * Process-local join between the exact next shell and its verified retention
 * successor. Store selection and SQLite CAS remain the publisher's job.
 */
const verifiedSuccessors = new WeakMap<object, VerifiedSuccessorOwnership>();

function stableRoot(chunk: RunStateChunk, label: string) {
  const root = parseRunStateRoot(chunk);
  if (root.schemaVersion !== 2 && root.schemaVersion !== 3) {
    throw new Error(`${label} 只接受稳定尾校验的 schema 2/3 run root`);
  }
  return root;
}

function shellSeal(state: SimulationState, label: string): HistoryRetentionSeal {
  const cursor = state.world.historyCursor;
  if (!cursor
    || cursor.version !== 1
    || !Number.isSafeInteger(cursor.eventCount)
    || cursor.eventCount < 0
    || !Number.isSafeInteger(cursor.hotStartIndex)
    || cursor.hotStartIndex < 0
    || cursor.hotStartIndex > cursor.eventCount
    || cursor.eventCount - cursor.hotStartIndex !== state.world.past.length
    || (cursor.eventCount === 0
      ? cursor.tailEventId !== null
      : typeof cursor.tailEventId !== 'string' || cursor.tailEventId.length === 0)
    || (state.world.past.length > 0 && state.world.past.at(-1)?.id !== cursor.tailEventId)) {
    throw new Error(`${label} 的绝对 history cursor 无效`);
  }
  return { eventCount: cursor.eventCount, tailEventId: cursor.tailEventId };
}

function sameSeal(left: HistoryRetentionSeal, right: HistoryRetentionSeal): boolean {
  return left.eventCount === right.eventCount && left.tailEventId === right.tailEventId;
}

/**
 * Resume retention only across an exact content-addressed history successor.
 * The caller supplies no suffix and cannot substitute the bounded hot window:
 * every appended segment is read through the root ancestry verifier into a
 * private fold, and the fold is exposed only after the final receipt seals.
 *
 * `nextState` must remain store-private and be decoded from `nextRootChunk` by
 * the eventual publisher. This module binds their object identity for later
 * misuse checks, but it does not itself grant store/CAS authority.
 */
export async function projectHistoryRetentionFromVerifiedSuccessor(
  previous: Readonly<HistoryRetentionProjectionResult>,
  previousRootChunkInput: RunStateChunk,
  nextState: SimulationState,
  nextRootChunkInput: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
): Promise<Readonly<VerifiedHistoryRetentionSuccessor>> {
  assertDecodedHistoryRetentionSidecar(previous);
  const previousRootChunk = snapshotRunStateChunk(previousRootChunkInput);
  const nextRootChunk = snapshotRunStateChunk(nextRootChunkInput);
  const previousRoot = stableRoot(previousRootChunk, 'retention successor source');
  const nextRoot = stableRoot(nextRootChunk, 'retention successor target');
  const nextSeal = shellSeal(nextState, 'retention successor next shell');

  if (previous.authority.stateHash !== previousRootChunk.hash
    || previous.target.eventCount !== previousRoot.eventCount) {
    throw new Error('retention successor source sidecar 与 previous root boundary 不一致');
  }
  if (nextSeal.eventCount !== nextRoot.eventCount) {
    throw new Error('retention successor next shell 与 next root eventCount 不一致');
  }
  if (nextRootChunk.hash === previousRootChunk.hash
    || nextSeal.eventCount < previous.target.eventCount) {
    throw new Error('retention successor 必须推进到历史不倒退的不同 state root');
  }

  const demandSnapshot = prepareHistoryRetentionDemandSnapshot(nextState);
  const fold = resumeHistoryRetentionProjection(
    previous,
    nextState,
    { stateHash: nextRootChunk.hash },
    demandSnapshot,
  );
  const successor = nextSeal.eventCount === previous.target.eventCount
    ? verifyRunStateSameHistoryShellSuccessor(previousRootChunk, nextRootChunk)
    : await streamVerifiedRunHistorySuccessorSegments(
      previousRootChunk,
      nextRootChunk,
      readChunk,
      (events, position) => {
        foldHistoryRetentionSegment(fold, events, position.startEventIndex);
      },
    );
  if (successor.previousRootHash !== previousRootChunk.hash
    || successor.nextRootHash !== nextRootChunk.hash
    || successor.previous.lineageId !== previousRoot.lineageId
    || successor.previous.historyHeadHash !== previousRoot.historyHeadHash
    || successor.previous.eventCount !== previous.target.eventCount
    || successor.previous.tailEventContentHash !== previousRoot.tailEventContentHash
    || successor.next.lineageId !== nextRoot.lineageId
    || successor.next.historyHeadHash !== nextRoot.historyHeadHash
    || successor.next.eventCount !== nextSeal.eventCount
    || successor.next.tailEventContentHash !== nextRoot.tailEventContentHash
    || successor.suffixEventCount !== nextSeal.eventCount - previous.target.eventCount) {
    throw new Error('retention successor receipt 与 exact roots/shell 不一致');
  }

  const unresolvedPrefixLogisticsIds = unresolvedVerifiedPrefixLogisticsIndexEventIds(fold);
  const unresolvedPrefixTerminalFailureIds =
    unresolvedVerifiedPrefixRecentTerminalFailureActionEventIds(fold);
  const unresolvedPrefixSocialLearningIds =
    unresolvedVerifiedPrefixSocialLearningSourceEventIds(fold);
  const unresolvedPrefixIds = [...new Set([
    ...unresolvedPrefixLogisticsIds,
    ...unresolvedPrefixTerminalFailureIds,
    ...unresolvedPrefixSocialLearningIds,
  ])].sort();
  if (unresolvedPrefixIds.length > 0) {
    const required = new Set(unresolvedPrefixIds);
    const matchesByEventId = new Map<string, HistoryRetentionContinuationMatch>();
    const verifiedPrefix = await streamVerifiedRunHistorySegments(
      previousRoot,
      readChunk,
      (events, position) => {
        for (let offset = 0; offset < events.length; offset += 1) {
          const event = events[offset];
          if (required.has(event.id)) matchesByEventId.set(event.id, {
            absoluteIndex: position.startEventIndex + offset,
            eventId: event.id,
          });
        }
      },
    );
    if (verifiedPrefix.eventCount !== previousRoot.eventCount
      || verifiedPrefix.historyHeadHash !== previousRoot.historyHeadHash
      || verifiedPrefix.lineageId !== previousRoot.lineageId
      || verifiedPrefix.tailEventContentHash !== previousRoot.tailEventContentHash) {
      throw new Error('retention prefix storage bridge 未验证 exact previous root');
    }
    seedVerifiedPrefixLogisticsIndexMatches(
      fold,
      verifiedPrefix.eventCount,
      unresolvedPrefixLogisticsIds.flatMap((eventId) => {
        const match = matchesByEventId.get(eventId);
        return match ? [match] : [];
      }).sort((left, right) => (
        left.eventId.localeCompare(right.eventId) || left.absoluteIndex - right.absoluteIndex
      )),
    );
    seedVerifiedPrefixRecentTerminalFailureActionMatches(
      fold,
      verifiedPrefix.eventCount,
      unresolvedPrefixTerminalFailureIds.flatMap((eventId) => {
        const match = matchesByEventId.get(eventId);
        return match ? [match] : [];
      }).sort((left, right) => (
        left.eventId.localeCompare(right.eventId) || left.absoluteIndex - right.absoluteIndex
      )),
    );
    seedVerifiedPrefixSocialLearningSourceMatches(
      fold,
      verifiedPrefix.eventCount,
      unresolvedPrefixSocialLearningIds.flatMap((eventId) => {
        const match = matchesByEventId.get(eventId);
        return match ? [match] : [];
      }).sort((left, right) => (
        left.eventId.localeCompare(right.eventId) || left.absoluteIndex - right.absoluteIndex
      )),
    );
  }

  const finished = finishHistoryRetentionProjection(fold);
  if (finished.authority.stateHash !== nextRootChunk.hash
    || !sameSeal(finished.target, nextSeal)) {
    throw new Error('retention successor projection 未封印到 next root/shell');
  }
  assertHistoryRetentionProjectionMatchesDemandSnapshot(
    nextState,
    finished,
    demandSnapshot,
  );
  const encoded = encodeHistoryRetentionSidecar(finished);
  const result: VerifiedHistoryRetentionSuccessor = Object.freeze({
    kind: HISTORY_RETENTION_VERIFIED_SUCCESSOR_DEFINITION,
    previousRootHash: previousRootChunk.hash,
    nextRootHash: nextRootChunk.hash,
    suffixEventCount: successor.suffixEventCount,
    projection: encoded.projection,
    encoded,
  });
  verifiedSuccessors.set(result, {
    nextState,
    previousRootHash: previousRootChunk.hash,
    nextRootHash: nextRootChunk.hash,
    demandSnapshot,
  });
  return result;
}

export function assertVerifiedHistoryRetentionSuccessor(
  value: unknown,
  nextState: SimulationState,
  previousRootHash: string,
  nextRootHash: string,
): asserts value is Readonly<VerifiedHistoryRetentionSuccessor> {
  if (!value || typeof value !== 'object') {
    throw new Error('retention successor result 缺少模块 provenance');
  }
  const owned = verifiedSuccessors.get(value);
  if (!owned
    || owned.nextState !== nextState
    || owned.previousRootHash !== previousRootHash
    || owned.nextRootHash !== nextRootHash) {
    throw new Error('retention successor result 不属于指定的 exact roots/next shell');
  }
}

/**
 * Revalidate a strict-decoded copy of the successor sidecar against the same
 * immutable shell demand used by the exact-root fold. This preserves the
 * publication's fail-closed provenance without collecting the whole shell a
 * third time.
 */
export function assertHistoryRetentionProjectionMatchesVerifiedSuccessor(
  value: unknown,
  nextState: SimulationState,
  projection: HistoryRetentionProjectionResult,
): void {
  if (!value || typeof value !== 'object') {
    throw new Error('retention successor result 缺少模块 provenance');
  }
  const owned = verifiedSuccessors.get(value);
  if (!owned || owned.nextState !== nextState) {
    throw new Error('retention successor result 不属于指定的 next shell');
  }
  assertHistoryRetentionProjectionMatchesDemandSnapshot(
    nextState,
    projection,
    owned.demandSnapshot,
  );
}
