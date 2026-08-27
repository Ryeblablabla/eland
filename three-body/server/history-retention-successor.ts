import { isDeepStrictEqual } from 'node:util';

import {
  registerLiveSocialEvidenceDescriptors,
  retainedLiveSocialEvidenceForLivingSources,
} from '../src/game/eland/domain/event-index';
import type { SimulationState, WorldEvent } from '../src/game/eland/domain/model';
import { isAlive } from '../src/game/eland/domain/person';
import {
  livePersonSocialSourceEventIds,
  liveSocialEvidenceDescriptorFromWorldEvent,
  type LiveSocialEvidenceDescriptor,
  type RetainedLiveSocialEvidenceDescriptor,
} from '../src/game/eland/domain/live-social-evidence';
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
  seedVerifiedPrefixLiveSocialIndexMatches,
  seedVerifiedPrefixLogisticsIndexMatches,
  seedVerifiedPrefixProjectPressureIndexMatches,
  seedVerifiedPrefixRecentTerminalFailureActionMatches,
  seedVerifiedPrefixSocialLearningSourceMatches,
  seedVerifiedPrefixSocialRepetitionIndexMatches,
  unresolvedVerifiedPrefixLogisticsIndexEventIds,
  unresolvedVerifiedPrefixLiveSocialIndexEventIds,
  unresolvedVerifiedPrefixProjectPressureIndexEventIds,
  unresolvedVerifiedPrefixRecentTerminalFailureActionEventIds,
  unresolvedVerifiedPrefixSocialLearningSourceEventIds,
  unresolvedVerifiedPrefixSocialRepetitionIndexEventIds,
  type HistoryRetentionDemandSnapshot,
  type HistoryRetentionContinuationMatch,
  type HistoryRetentionProjectionResult,
  type HistoryRetentionSeal,
} from './history-retention-projection';
import {
  parseRunStateRoot,
  materializeVerifiedRunHistoryPinnedEvents,
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

interface VerifiedLiveSocialDescriptorPoolItem {
  readonly absoluteIndex: number;
  readonly descriptor: LiveSocialEvidenceDescriptor;
}

interface VerifiedSuccessorLiveSocialPrefixLookup {
  readonly searchedEventIds: readonly string[];
  readonly matches: readonly HistoryRetentionContinuationMatch[];
}

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
 * Rebuild the owner-scoped descriptor registry before the next shell compiles
 * its canonical demand. A new memory may name an old cold fact that was not in
 * the previous owner's membership, so source-owner wrappers are only a verified
 * descriptor pool: current living owners are rebound from their own exact
 * membership. Unknown non-event source IDs remain unresolved index identity.
 */
async function installVerifiedSuccessorLiveSocialDescriptors(
  previous: Readonly<HistoryRetentionProjectionResult>,
  previousRoot: ReturnType<typeof stableRoot>,
  previousRootChunk: RunStateChunk,
  nextState: SimulationState,
  nextRoot: ReturnType<typeof stableRoot>,
  nextRootChunk: RunStateChunk,
  readChunk: (hash: string) => RunStateChunk,
  sourceDescriptors: readonly RetainedLiveSocialEvidenceDescriptor[],
): Promise<VerifiedSuccessorLiveSocialPrefixLookup> {
  const cursor = nextState.world.historyCursor;
  if (!cursor || cursor.version !== 1
    || cursor.eventCount !== nextRoot.eventCount
    || cursor.eventCount - cursor.hotStartIndex !== nextState.world.past.length) {
    throw new Error('retention successor live-social descriptor 缺少有效 next history cursor');
  }
  const owners = nextState.people.filter(isAlive).map((person) => Object.freeze({
    ownerId: person.id,
    eventIds: Object.freeze(livePersonSocialSourceEventIds(person)),
  }));
  const requestedEventIds = new Set(owners.flatMap((owner) => owner.eventIds));
  if (requestedEventIds.size === 0) {
    registerLiveSocialEvidenceDescriptors(nextState, [], []);
    return Object.freeze({ searchedEventIds: Object.freeze([]), matches: Object.freeze([]) });
  }

  const previousMatchesById = new Map<string, HistoryRetentionContinuationMatch>();
  const previousIdentitiesByOrdinal = new Map<number, string>();
  for (const match of previous.continuationBasis.directMatches) {
    const byId = previousMatchesById.get(match.eventId);
    const byOrdinal = previousIdentitiesByOrdinal.get(match.absoluteIndex);
    if ((byId && byId.absoluteIndex !== match.absoluteIndex)
      || (byOrdinal && byOrdinal !== match.eventId)) {
      throw new Error('retention successor source direct match identity 冲突');
    }
    previousMatchesById.set(match.eventId, match);
    previousIdentitiesByOrdinal.set(match.absoluteIndex, match.eventId);
  }

  const pool = new Map<string, VerifiedLiveSocialDescriptorPoolItem>();
  const addDescriptor = (
    absoluteIndex: number,
    descriptor: LiveSocialEvidenceDescriptor,
    source: 'retained' | 'verified-event',
  ): void => {
    if (!requestedEventIds.has(descriptor.eventId)) return;
    const existing = pool.get(descriptor.eventId);
    if (existing && existing.absoluteIndex !== absoluteIndex) {
      throw new Error(`retention successor live-social ${descriptor.eventId} ordinal 冲突`);
    }
    if (existing && source === 'retained'
      && !isDeepStrictEqual(existing.descriptor, descriptor)) {
      throw new Error(`retention successor live-social ${descriptor.eventId} descriptor 冲突`);
    }
    // Exact event bodies (successor hot or root-decoded) outrank descriptors.
    if (!existing || source === 'verified-event') pool.set(descriptor.eventId, {
      absoluteIndex,
      descriptor,
    });
  };

  const reusable = [
    ...sourceDescriptors,
    ...retainedLiveSocialEvidenceForLivingSources(nextState),
  ];
  const seenReusableOwnerOrdinal = new Set<string>();
  for (const item of reusable) {
    const ownerOrdinal = JSON.stringify([item.ownerId, item.absoluteIndex]);
    if (seenReusableOwnerOrdinal.has(ownerOrdinal)) continue;
    seenReusableOwnerOrdinal.add(ownerOrdinal);
    const match = previousMatchesById.get(item.descriptor.eventId);
    if (!match || match.absoluteIndex !== item.absoluteIndex) {
      throw new Error(
        `retention successor source live-social descriptor ${item.ownerId}/${item.absoluteIndex}`
        + `/${item.descriptor.eventId} 缺少 previous exact identity`,
      );
    }
    addDescriptor(item.absoluteIndex, item.descriptor, 'retained');
  }

  for (let offset = 0; offset < nextState.world.past.length; offset += 1) {
    const event = nextState.world.past[offset]!;
    if (!requestedEventIds.has(event.id)) continue;
    addDescriptor(
      cursor.hotStartIndex + offset,
      liveSocialEvidenceDescriptorFromWorldEvent(event),
      'verified-event',
    );
  }

  const missingWithPreviousIdentity = [...requestedEventIds]
    .filter((eventId) => !pool.has(eventId) && previousMatchesById.has(eventId))
    .map((eventId) => previousMatchesById.get(eventId)!)
    .sort((left, right) => left.absoluteIndex - right.absoluteIndex);
  if (missingWithPreviousIdentity.length > 0) {
    const decoded = materializeVerifiedRunHistoryPinnedEvents(
      previousRoot,
      readChunk,
      missingWithPreviousIdentity.map((match) => match.absoluteIndex),
    );
    for (let offset = 0; offset < missingWithPreviousIdentity.length; offset += 1) {
      const expected = missingWithPreviousIdentity[offset]!;
      const actual = decoded[offset];
      if (!actual
        || actual.absoluteIndex !== expected.absoluteIndex
        || actual.event.id !== expected.eventId) {
        throw new Error(
          `retention successor live-social previous identity ${expected.absoluteIndex}`
          + `/${expected.eventId} 无法精确物化`,
        );
      }
      addDescriptor(
        actual.absoluteIndex,
        liveSocialEvidenceDescriptorFromWorldEvent(actual.event),
        'verified-event',
      );
    }
  }

  const unresolvedWithoutIdentity = new Set([...requestedEventIds].filter((eventId) => (
    !pool.has(eventId) && !previousMatchesById.has(eventId)
  )));
  if (unresolvedWithoutIdentity.size > 0 && nextRoot.eventCount > previousRoot.eventCount) {
    const suffixMatches = new Map<string, { absoluteIndex: number; event: WorldEvent }>();
    const verified = await streamVerifiedRunHistorySuccessorSegments(
      previousRootChunk,
      nextRootChunk,
      readChunk,
      (events, position) => {
        for (let offset = 0; offset < events.length; offset += 1) {
          const event = events[offset]!;
          if (!unresolvedWithoutIdentity.has(event.id)) continue;
          if (suffixMatches.has(event.id)) {
            throw new Error(`retention successor live-social suffix event ID ${event.id} 重复`);
          }
          suffixMatches.set(event.id, {
            absoluteIndex: position.startEventIndex + offset,
            event,
          });
        }
      },
    );
    if (verified.previousRootHash !== previous.authority.stateHash
      || verified.nextRootHash !== nextRootChunk.hash
      || verified.previous.eventCount !== previousRoot.eventCount
      || verified.next.eventCount !== nextRoot.eventCount
      || verified.previous.historyHeadHash !== previousRoot.historyHeadHash
      || verified.next.historyHeadHash !== nextRoot.historyHeadHash) {
      throw new Error('retention successor live-social suffix 未验证 exact roots');
    }
    for (const [eventId, match] of suffixMatches) {
      addDescriptor(
        match.absoluteIndex,
        liveSocialEvidenceDescriptorFromWorldEvent(match.event),
        'verified-event',
      );
      unresolvedWithoutIdentity.delete(eventId);
    }
  }

  // An older index-only broad group proves only stored membership, not that its
  // raw prefix was searched. Recheck every still-unidentified requested ID
  // against this exact previous root; non-events intentionally remain misses.
  const needsPreviousSearch = new Set(unresolvedWithoutIdentity);
  const verifiedPrefixMatches: HistoryRetentionContinuationMatch[] = [];
  if (needsPreviousSearch.size > 0) {
    const prefixMatches = new Map<string, { absoluteIndex: number; event: WorldEvent }>();
    const verifiedPrefix = await streamVerifiedRunHistorySegments(
      previousRoot,
      readChunk,
      (events, position) => {
        for (let offset = 0; offset < events.length; offset += 1) {
          const event = events[offset]!;
          if (!needsPreviousSearch.has(event.id)) continue;
          if (prefixMatches.has(event.id)) {
            throw new Error(`retention successor live-social prefix event ID ${event.id} 重复`);
          }
          prefixMatches.set(event.id, {
            absoluteIndex: position.startEventIndex + offset,
            event,
          });
        }
      },
    );
    if (verifiedPrefix.eventCount !== previousRoot.eventCount
      || verifiedPrefix.historyHeadHash !== previousRoot.historyHeadHash
      || verifiedPrefix.lineageId !== previousRoot.lineageId
      || verifiedPrefix.tailEventContentHash !== previousRoot.tailEventContentHash) {
      throw new Error('retention successor live-social prefix 未验证 exact previous root');
    }
    for (const match of prefixMatches.values()) {
      addDescriptor(
        match.absoluteIndex,
        liveSocialEvidenceDescriptorFromWorldEvent(match.event),
        'verified-event',
      );
      verifiedPrefixMatches.push(Object.freeze({
        absoluteIndex: match.absoluteIndex,
        eventId: match.event.id,
      }));
    }
  }

  const retained: RetainedLiveSocialEvidenceDescriptor[] = owners.flatMap((owner) => (
    owner.eventIds.flatMap((eventId) => {
      const match = pool.get(eventId);
      return match ? [Object.freeze({
        ownerId: owner.ownerId,
        absoluteIndex: match.absoluteIndex,
        descriptor: match.descriptor,
      })] : [];
    })
  )).sort((left, right) => left.ownerId.localeCompare(right.ownerId)
    || left.absoluteIndex - right.absoluteIndex
    || left.descriptor.eventId.localeCompare(right.descriptor.eventId));
  const verifiedColdByOrdinal = new Map<number, { absoluteIndex: number; eventId: string }>();
  for (const item of retained) {
    if (item.absoluteIndex >= cursor.hotStartIndex) continue;
    const existing = verifiedColdByOrdinal.get(item.absoluteIndex);
    if (existing && existing.eventId !== item.descriptor.eventId) {
      throw new Error(`retention successor live-social cold ordinal ${item.absoluteIndex} 身份冲突`);
    }
    verifiedColdByOrdinal.set(item.absoluteIndex, Object.freeze({
      absoluteIndex: item.absoluteIndex,
      eventId: item.descriptor.eventId,
    }));
  }
  const verifiedColdIdentities = [...verifiedColdByOrdinal.values()]
    .sort((left, right) => left.absoluteIndex - right.absoluteIndex);
  registerLiveSocialEvidenceDescriptors(nextState, retained, verifiedColdIdentities);
  return Object.freeze({
    searchedEventIds: Object.freeze([...needsPreviousSearch].sort()),
    matches: Object.freeze(verifiedPrefixMatches.sort((left, right) => (
      left.eventId.localeCompare(right.eventId) || left.absoluteIndex - right.absoluteIndex
    ))),
  });
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
  reusableLiveSocialDescriptors: readonly RetainedLiveSocialEvidenceDescriptor[] = [],
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

  const liveSocialPrefixLookup = await installVerifiedSuccessorLiveSocialDescriptors(
    previous,
    previousRoot,
    previousRootChunk,
    nextState,
    nextRoot,
    nextRootChunk,
    readChunk,
    reusableLiveSocialDescriptors,
  );
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

  const unresolvedPrefixLiveSocialIds = new Set(
    unresolvedVerifiedPrefixLiveSocialIndexEventIds(fold),
  );
  const searchedPrefixLiveSocialIds = liveSocialPrefixLookup.searchedEventIds
    .filter((eventId) => unresolvedPrefixLiveSocialIds.has(eventId));
  const searchedPrefixLiveSocialIdSet = new Set(searchedPrefixLiveSocialIds);
  seedVerifiedPrefixLiveSocialIndexMatches(
    fold,
    previousRoot.eventCount,
    searchedPrefixLiveSocialIds,
    liveSocialPrefixLookup.matches.filter((match) => (
      searchedPrefixLiveSocialIdSet.has(match.eventId)
    )),
  );

  const unresolvedPrefixLogisticsIds = unresolvedVerifiedPrefixLogisticsIndexEventIds(fold);
  const unresolvedPrefixTerminalFailureIds =
    unresolvedVerifiedPrefixRecentTerminalFailureActionEventIds(fold);
  const unresolvedPrefixSocialLearningIds =
    unresolvedVerifiedPrefixSocialLearningSourceEventIds(fold);
  const strictPrefixIds = new Set([
    ...unresolvedPrefixLogisticsIds,
    ...unresolvedPrefixTerminalFailureIds,
    ...unresolvedPrefixSocialLearningIds,
  ]);
  const unresolvedPrefixSocialRepetitionIds =
    unresolvedVerifiedPrefixSocialRepetitionIndexEventIds(fold)
      .filter((eventId) => !strictPrefixIds.has(eventId));
  const stricterPrefixIds = new Set([
    ...strictPrefixIds,
    ...unresolvedPrefixSocialRepetitionIds,
  ]);
  const unresolvedPrefixProjectPressureIds =
    unresolvedVerifiedPrefixProjectPressureIndexEventIds(fold)
      .filter((eventId) => !stricterPrefixIds.has(eventId));
  const unresolvedPrefixIds = [...new Set([
    ...unresolvedPrefixLogisticsIds,
    ...unresolvedPrefixProjectPressureIds,
    ...unresolvedPrefixTerminalFailureIds,
    ...unresolvedPrefixSocialLearningIds,
    ...unresolvedPrefixSocialRepetitionIds,
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
    seedVerifiedPrefixProjectPressureIndexMatches(
      fold,
      verifiedPrefix.eventCount,
      unresolvedPrefixProjectPressureIds,
      unresolvedPrefixProjectPressureIds.flatMap((eventId) => {
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
    seedVerifiedPrefixSocialRepetitionIndexMatches(
      fold,
      verifiedPrefix.eventCount,
      unresolvedPrefixSocialRepetitionIds.flatMap((eventId) => {
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
