import { isDeepStrictEqual } from 'node:util';

import { committedHistoryView } from '../src/game/eland/domain/history';
import type { SimulationState } from '../src/game/eland/domain/model';
import {
  assertDecodedObserverCivilizationHistorySidecar,
  encodeObserverCivilizationHistorySidecar,
  type EncodedObserverCivilizationHistorySidecar,
  type ObserverCivilizationHistorySidecarPayloadV1,
} from './civilization-history-codec';
import {
  OBSERVER_CIVILIZATION_HISTORY_CONTINUATION_GAPS,
  finishObserverCivilizationHistoryProjection,
  foldVerifiedObserverCivilizationHistorySegment,
  resumeObserverCivilizationHistoryProjection,
  type ObserverCivilizationHistoryTarget,
} from './observer-civilization-history-projection';
import {
  parseRunStateRoot,
  snapshotRunStateChunk,
  streamVerifiedRunHistorySuccessorSegments,
  verifyRunStateSameHistoryShellSuccessor,
  type RunStateChunk,
  type RunStateRootMetadata,
} from './run-state-codec';

/**
 * Exact-root, event-history-only successor for the incomplete civilization
 * observer. This remains post-fact server evidence: it must never be imported
 * by planners or used to authorize a gameplay action, stage, or capability.
 *
 * Revisions and both roots must be selected by the future owning store. The
 * module proves content-addressed history ancestry, but does not mint store/CAS
 * authority by itself.
 */
export const VERIFIED_OBSERVER_CIVILIZATION_HISTORY_SUCCESSOR_KIND =
  'verified-observer-civilization-history-successor-v1' as const;

declare const verifiedObserverCivilizationHistorySuccessorBrand: unique symbol;

export interface ObserverCivilizationHistorySuccessorInput {
  /** Identity minted by the strict store-selected sidecar decoder. */
  readonly previous: Readonly<ObserverCivilizationHistorySidecarPayloadV1>;
  /** Store-selected revision owning `previousRootChunk`. */
  readonly previousRevision: number;
  readonly previousRootChunk: RunStateChunk;
  /** Store-selected revision which will own `nextRootChunk`. */
  readonly nextRevision: number;
  readonly nextRootChunk: RunStateChunk;
  /** Bounded decode of the exact next root; no full history is required. */
  readonly nextState: SimulationState;
  readonly readChunk: (hash: string) => RunStateChunk;
}

export interface VerifiedObserverCivilizationHistorySuccessor {
  readonly kind: typeof VERIFIED_OBSERVER_CIVILIZATION_HISTORY_SUCCESSOR_KIND;
  readonly persisted: false;
  readonly continuationReady: false;
  readonly previousRevision: number;
  readonly nextRevision: number;
  readonly previousTarget: Readonly<ObserverCivilizationHistoryTarget>;
  readonly nextTarget: Readonly<ObserverCivilizationHistoryTarget>;
  readonly suffixEventCount: number;
  /** Canonical bytes may be retained privately by a future atomic publisher. */
  readonly encoded: Readonly<EncodedObserverCivilizationHistorySidecar>;
  readonly [verifiedObserverCivilizationHistorySuccessorBrand]: true;
}

interface ObserverOwnedShellSnapshot {
  civilizationIndex: unknown;
  stage: unknown;
  development: unknown;
  milestones: unknown;
}

const verifiedSuccessors = new WeakSet<object>();

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label}必须是非负安全整数`);
  }
}

function sameTarget(
  left: Readonly<ObserverCivilizationHistoryTarget>,
  right: Readonly<ObserverCivilizationHistoryTarget>,
): boolean {
  return left.stateHash === right.stateHash
    && left.eventCount === right.eventCount
    && left.tailEventId === right.tailEventId;
}

function assertSchemaTwoOrThreeRoot(root: RunStateRootMetadata, label: string): void {
  if (root.schemaVersion !== 2 && root.schemaVersion !== 3) {
    throw new Error(`${label}只接受 schema 2/3 root`);
  }
}

function assertKnownContinuationGaps(
  sidecar: Readonly<ObserverCivilizationHistorySidecarPayloadV1>,
  label: string,
): void {
  const projection = sidecar.projection;
  if (projection.continuationReady !== false
    || projection.continuationGaps.length !== OBSERVER_CIVILIZATION_HISTORY_CONTINUATION_GAPS.length
    || projection.continuationGaps.some(
      (gap, index) => gap !== OBSERVER_CIVILIZATION_HISTORY_CONTINUATION_GAPS[index],
    )) {
    throw new Error(`${label}必须保持 continuationReady:false 与完整显式 gaps`);
  }
}

function observerOwnedShellSnapshot(state: SimulationState): ObserverOwnedShellSnapshot {
  return structuredClone({
    civilizationIndex: state.civilization.civilizationIndex,
    stage: state.civilization.stage,
    development: state.civilization.development,
    milestones: state.derived.milestones,
  });
}

function assertObserverOwnedShellUnchanged(
  before: ObserverOwnedShellSnapshot,
  state: SimulationState,
): void {
  if (!isDeepStrictEqual(before, observerOwnedShellSnapshot(state))) {
    throw new Error(
      'civilization history successor 不得改写 civilizationIndex/stage/development/derived.milestones',
    );
  }
}

function targetForNextBoundedState(
  state: SimulationState,
  rootChunk: Readonly<RunStateChunk>,
  root: Readonly<RunStateRootMetadata>,
): ObserverCivilizationHistoryTarget {
  const history = committedHistoryView(state);
  const cursor = state.world.historyCursor;
  if (!cursor
    || history.eventCount !== root.eventCount
    || cursor.eventCount !== root.eventCount) {
    throw new Error('civilization history successor 的 next bounded state cursor 与 root 不一致');
  }
  return {
    stateHash: rootChunk.hash,
    eventCount: root.eventCount,
    tailEventId: cursor.tailEventId,
  };
}

/** Runtime provenance check for a result minted only after the exact stream sealed. */
export function assertVerifiedObserverCivilizationHistorySuccessor(
  value: unknown,
): asserts value is VerifiedObserverCivilizationHistorySuccessor {
  if (!value || typeof value !== 'object' || !verifiedSuccessors.has(value)) {
    throw new Error('civilization history successor 未经过 module-verified exact-root fold');
  }
}

/**
 * Fold only the authoritative event suffix between two exact schema-2/3 roots.
 * The caller cannot supply a suffix or hot-window slice. A private fold is
 * encoded only after the complete ancestry stream and its final tail seal pass.
 *
 * This function deliberately does not call any materializer. In particular it
 * neither derives nor replaces civilizationIndex, stage, development, or
 * derived.milestones. `civilization.era` is not an observer-owned field and is
 * intentionally outside that preservation assertion.
 */
export async function projectObserverCivilizationHistoryFromVerifiedSuccessor(
  input: Readonly<ObserverCivilizationHistorySuccessorInput>,
): Promise<Readonly<VerifiedObserverCivilizationHistorySuccessor>> {
  assertDecodedObserverCivilizationHistorySidecar(input.previous);
  assertKnownContinuationGaps(input.previous, 'civilization history previous sidecar');
  assertNonNegativeSafeInteger(input.previousRevision, 'civilization history previous revision');
  assertNonNegativeSafeInteger(input.nextRevision, 'civilization history next revision');
  if (input.nextRevision <= input.previousRevision) {
    throw new Error('civilization history successor revision 必须严格推进');
  }

  // Own both caller chunks synchronously before the first await.
  const previousRootChunk = snapshotRunStateChunk(input.previousRootChunk);
  const nextRootChunk = snapshotRunStateChunk(input.nextRootChunk);
  const previousRoot = parseRunStateRoot(previousRootChunk);
  const nextRoot = parseRunStateRoot(nextRootChunk);
  assertSchemaTwoOrThreeRoot(previousRoot, 'civilization history previous root');
  assertSchemaTwoOrThreeRoot(nextRoot, 'civilization history next root');

  const previousTarget = input.previous.projection.target;
  if (previousTarget.stateHash !== previousRootChunk.hash
    || previousTarget.eventCount !== previousRoot.eventCount) {
    throw new Error('civilization history previous sidecar target 与 exact previous root 不一致');
  }
  if (nextRootChunk.hash === previousRootChunk.hash
    || nextRoot.eventCount < previousRoot.eventCount) {
    throw new Error('civilization history successor root 必须不同且 event count 不得倒退');
  }

  const nextTarget = targetForNextBoundedState(input.nextState, nextRootChunk, nextRoot);
  const ownedShellBefore = observerOwnedShellSnapshot(input.nextState);
  const fold = resumeObserverCivilizationHistoryProjection(
    input.previous.projection,
    nextTarget,
  );

  const successor = nextTarget.eventCount === previousTarget.eventCount
    ? verifyRunStateSameHistoryShellSuccessor(previousRootChunk, nextRootChunk)
    : await streamVerifiedRunHistorySuccessorSegments(
      previousRootChunk,
      nextRootChunk,
      input.readChunk,
      (events, position) => {
        foldVerifiedObserverCivilizationHistorySegment(
          fold,
          events,
          position.startEventIndex,
        );
      },
    );

  if (successor.previousRootHash !== previousRootChunk.hash
    || successor.nextRootHash !== nextRootChunk.hash
    || successor.previous.eventCount !== previousTarget.eventCount
    || successor.next.eventCount !== nextTarget.eventCount
    || successor.suffixEventCount !== nextTarget.eventCount - previousTarget.eventCount) {
    throw new Error('civilization history successor receipt 与 exact root targets 不一致');
  }

  // Reject state/cursor mutation across the stream before sealing any result.
  assertObserverOwnedShellUnchanged(ownedShellBefore, input.nextState);
  const targetAfterStream = targetForNextBoundedState(input.nextState, nextRootChunk, nextRoot);
  if (!sameTarget(targetAfterStream, nextTarget)) {
    throw new Error('civilization history successor 的 next bounded state cursor 在折叠期间漂移');
  }

  const projection = finishObserverCivilizationHistoryProjection(fold);
  const encoded = encodeObserverCivilizationHistorySidecar(projection);
  if (!sameTarget(encoded.sidecar.projection.target, nextTarget)) {
    throw new Error('civilization history successor canonical sidecar target 漂移');
  }
  assertKnownContinuationGaps(encoded.sidecar, 'civilization history successor sidecar');
  assertObserverOwnedShellUnchanged(ownedShellBefore, input.nextState);

  const result = Object.freeze({
    kind: VERIFIED_OBSERVER_CIVILIZATION_HISTORY_SUCCESSOR_KIND,
    persisted: false as const,
    continuationReady: false as const,
    previousRevision: input.previousRevision,
    nextRevision: input.nextRevision,
    previousTarget: Object.freeze({ ...previousTarget }),
    nextTarget: Object.freeze({ ...nextTarget }),
    suffixEventCount: successor.suffixEventCount,
    encoded,
  }) as Readonly<VerifiedObserverCivilizationHistorySuccessor>;
  verifiedSuccessors.add(result);
  return result;
}
