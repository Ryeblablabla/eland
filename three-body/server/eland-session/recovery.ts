import type {
  Decision,
  SimulationState,
  TokenUsage,
} from '../../src/game/eland/simulation';
import type { CivilizationRequiem } from '../../src/game/civilizationRequiem';
import type {
  EmbodimentCommandReceipt,
  EmbodimentReleaseReceipt,
} from '../../src/game/embodimentContract';
import { PLANNING_TICKS_PER_MONTH } from '../../src/game/eland/domain/calendar';
import type { CosmosSnapshot, GameFrame, SkySample } from '../../src/game/societyContract';
import type { ModelAttemptSummary } from '../../src/game/eland/infrastructure-api';
import { normalizeConversationTurn } from './conversation-coordinator';
import type { BranchTimeline } from './timeline';

export interface FrozenEmbodimentDecision {
  personId: string;
  decision: Decision;
  usedModel: boolean;
}

export interface StoredEmbodimentCommandReceipt {
  fingerprint: string;
  receipt: EmbodimentCommandReceipt;
}

/** Stable, replayable boundary for one staged month. */
export interface ActiveEmbodimentSnapshot {
  schemaVersion: 1;
  id: string;
  actorId: string;
  status: 'awaiting-command';
  beginFingerprint: string;
  baseAuthorityRevision: string;
  civilizationId: number;
  branchId: string;
  baseElapsedMonths: number;
  atMonth: number;
  skySample: SkySample;
  cosmosSnapshot?: CosmosSnapshot;
  completedTick: number;
  revision: number;
  frozenInitialDecisions: FrozenEmbodimentDecision[];
  decisionUsage: TokenUsage;
  decisionAttempts: ModelAttemptSummary;
  commands: StoredEmbodimentCommandReceipt[];
  /** Missing means the legacy hash payload used before observer fields were excluded. */
  stagedStateHashVersion?: 2 | 3;
  stagedStateHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface CompletedEmbodimentSnapshot {
  schemaVersion: 1;
  id: string;
  beginFingerprint: string;
  civilizationId: number;
  branchId: string;
  baseElapsedMonths: number;
  committedElapsedMonths: number;
  commandReceipts: StoredEmbodimentCommandReceipt[];
  release?: { fingerprint: string; receipt: EmbodimentReleaseReceipt };
  completedAt: number;
}

export interface ElandSessionRecoverySnapshot {
  schemaVersion: 1;
  /** New snapshots guarantee that the active timeline head exactly matches latestState. */
  timelineHeadComplete?: true;
  savedAt: number;
  runId: string;
  civilizationId: number;
  latestState: SimulationState;
  latestFrame: GameFrame;
  branches: Map<string, BranchTimeline>;
  activeBranchId: string;
  forkSequence: number;
  skySample: SkySample;
  cosmosSnapshot?: CosmosSnapshot;
  /** Projection-only ending poems, keyed by civilization/branch/end month. */
  requiems?: CivilizationRequiem[];
  /** A staged month remains outside latestState/latestFrame until tick 15. */
  activeEmbodiment?: ActiveEmbodimentSnapshot;
  /** Bounded terminal receipts keep tick-15/release retries idempotent. */
  completedEmbodiments?: CompletedEmbodimentSnapshot[];
}

function isNonEmptyBoundedId(value: unknown, maximum = 320): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximum
    && value === value.trim();
}

function validateActiveEmbodimentSnapshot(
  active: ActiveEmbodimentSnapshot,
  snapshot: ElandSessionRecoverySnapshot,
): void {
  if (active.schemaVersion !== 1
    || active.status !== 'awaiting-command'
    || !isNonEmptyBoundedId(active.id, 160)
    || !isNonEmptyBoundedId(active.actorId)
    || !/^[0-9a-f]{64}$/u.test(active.beginFingerprint)
    || !isNonEmptyBoundedId(active.baseAuthorityRevision, 160)
    || active.civilizationId !== snapshot.civilizationId
    || active.branchId !== snapshot.activeBranchId
    || active.baseElapsedMonths !== snapshot.latestFrame.elapsedMonths
    || active.atMonth !== active.baseElapsedMonths + 1
    || !Number.isInteger(active.completedTick)
    || active.completedTick < 0
    || active.completedTick >= PLANNING_TICKS_PER_MONTH
    || !Number.isInteger(active.revision)
    || active.revision !== active.completedTick
    || active.commands.length !== active.completedTick
    || (active.stagedStateHashVersion !== undefined
      && active.stagedStateHashVersion !== 2
      && active.stagedStateHashVersion !== 3)
    || !/^[0-9a-f]{64}$/u.test(active.stagedStateHash)
    || !Number.isFinite(active.createdAt)
    || !Number.isFinite(active.updatedAt)
    || active.updatedAt < active.createdAt) {
    throw new Error('实时演化会话的有限化身快照无效');
  }
  if (!active.frozenInitialDecisions.every((entry) => (
    isNonEmptyBoundedId(entry.personId)
      && entry.decision
      && typeof entry.decision === 'object'
      && typeof entry.usedModel === 'boolean'
  ))) {
    throw new Error('实时演化会话的有限化身月初决定无效');
  }
  active.commands.forEach((stored, index) => {
    const receipt = stored.receipt;
    const actionTick = index + 1;
    if (!/^[0-9a-f]{64}$/u.test(stored.fingerprint)
      || !isNonEmptyBoundedId(receipt.commandId, 160)
      || receipt.embodimentId !== active.id
      || receipt.actionTick !== actionTick
      || receipt.completedTick !== actionTick
      || receipt.revision !== actionTick
      || !receipt.command
      || typeof receipt.command !== 'object') {
      throw new Error('实时演化会话的有限化身命令收据无效');
    }
  });
  const duplicateCommandIds = new Set<string>();
  for (const stored of active.commands) {
    if (duplicateCommandIds.has(stored.receipt.commandId)) {
      throw new Error('实时演化会话的有限化身命令标识重复');
    }
    duplicateCommandIds.add(stored.receipt.commandId);
  }
  if (active.cosmosSnapshot && active.cosmosSnapshot.t !== active.skySample.toTime) {
    throw new Error('实时演化会话的有限化身宇宙时刻不一致');
  }
}

function validateCompletedEmbodimentSnapshot(
  completed: CompletedEmbodimentSnapshot,
  snapshot: ElandSessionRecoverySnapshot,
): void {
  if (completed.schemaVersion !== 1
    || !isNonEmptyBoundedId(completed.id, 160)
    || !/^[0-9a-f]{64}$/u.test(completed.beginFingerprint)
    || completed.civilizationId !== snapshot.civilizationId
    || !isNonEmptyBoundedId(completed.branchId)
    || !snapshot.branches.has(completed.branchId)
    || !Number.isInteger(completed.baseElapsedMonths)
    || completed.baseElapsedMonths < 0
    || completed.committedElapsedMonths !== completed.baseElapsedMonths + 1
    || completed.committedElapsedMonths > snapshot.latestFrame.elapsedMonths
    || !Number.isFinite(completed.completedAt)) {
    throw new Error('实时演化会话的有限化身完成收据无效');
  }
  const released = completed.release;
  if ((!released && completed.commandReceipts.length !== PLANNING_TICKS_PER_MONTH)
    || (released && completed.commandReceipts.length >= PLANNING_TICKS_PER_MONTH)) {
    throw new Error('实时演化会话的有限化身完成路径无效');
  }
  const commandIds = new Set<string>();
  completed.commandReceipts.forEach((stored, index) => {
    const receipt = stored.receipt;
    const actionTick = index + 1;
    if (!/^[0-9a-f]{64}$/u.test(stored.fingerprint)
      || !isNonEmptyBoundedId(receipt.commandId, 160)
      || receipt.embodimentId !== completed.id
      || receipt.actionTick !== actionTick
      || receipt.completedTick !== actionTick
      || receipt.revision !== actionTick
      || !receipt.command
      || typeof receipt.command !== 'object'
      || commandIds.has(receipt.commandId)) {
      throw new Error('实时演化会话的有限化身完成命令收据无效');
    }
    commandIds.add(receipt.commandId);
  });
  if (released && (!/^[0-9a-f]{64}$/u.test(released.fingerprint)
    || !isNonEmptyBoundedId(released.receipt.releaseId, 160)
    || released.receipt.embodimentId !== completed.id
    || released.receipt.revision !== completed.commandReceipts.length + 1
    || released.receipt.releasedAfterTick !== completed.commandReceipts.length
    || released.receipt.committedElapsedMonths !== completed.committedElapsedMonths)) {
    throw new Error('实时演化会话的有限化身交还收据无效');
  }
}

export function validateRecoverySnapshot(snapshot: ElandSessionRecoverySnapshot): {
  state: SimulationState;
  frame: GameFrame;
  cosmosSnapshot?: CosmosSnapshot;
  activeEmbodiment?: ActiveEmbodimentSnapshot;
  completedEmbodiments: CompletedEmbodimentSnapshot[];
} {
  if (snapshot.schemaVersion !== 1 || !snapshot.latestState || !snapshot.latestFrame) {
    throw new Error('实时演化会话快照版本不受支持');
  }
  const state = snapshot.latestState;
  const frame = snapshot.latestFrame;
  const timeline = snapshot.branches instanceof Map ? snapshot.branches.get(snapshot.activeBranchId) : undefined;
  const head = timeline?.history.at(-1);
  if (state.schemaVersion !== 19
    || state.civilization.number !== snapshot.civilizationId
    || frame.civilizationId !== snapshot.civilizationId
    || state.branchId !== snapshot.activeBranchId
    || frame.branchId !== snapshot.activeBranchId
    || state.clock.elapsedMonths !== frame.elapsedMonths
    || head?.elapsedMonths !== frame.elapsedMonths
    || frame.universeTime !== frame.skySample.toTime
    || frame.skySample.toTime !== snapshot.skySample.toTime) {
    throw new Error('实时演化会话快照的文明、分支或月份不一致');
  }
  const storedCosmosSnapshot = snapshot.cosmosSnapshot ?? frame.cosmosSnapshot;
  const cosmosSnapshot = storedCosmosSnapshot
    ? { ...storedCosmosSnapshot, civilizations: snapshot.civilizationId }
    : undefined;
  if (cosmosSnapshot && cosmosSnapshot.t !== frame.skySample.toTime) {
    throw new Error('实时演化会话快照的宇宙时刻与已提交月份不一致');
  }
  if (snapshot.activeEmbodiment) validateActiveEmbodimentSnapshot(snapshot.activeEmbodiment, snapshot);
  const completedEmbodiments = snapshot.completedEmbodiments ?? [];
  if (!Array.isArray(completedEmbodiments) || completedEmbodiments.length > 64) {
    throw new Error('实时演化会话的有限化身完成收据数量无效');
  }
  completedEmbodiments.forEach((completed) => validateCompletedEmbodimentSnapshot(completed, snapshot));
  return {
    state,
    frame,
    ...(cosmosSnapshot ? { cosmosSnapshot } : {}),
    ...(snapshot.activeEmbodiment ? { activeEmbodiment: snapshot.activeEmbodiment } : {}),
    completedEmbodiments,
  };
}

export function normalizeRecoveredBranches(
  branches: Map<string, BranchTimeline>,
  runId: string,
  authorityRevision: string,
): Map<string, BranchTimeline> {
  return new Map([...branches.entries()].map(([branchId, timeline]) => {
    const history = timeline.history.map((frame) => ({
      ...frame,
      runId,
      authorityRevision,
    }));
    return [branchId, {
      ...timeline,
      history,
      frameByMonth: new Map(history.map((frame) => [frame.elapsedMonths, frame])),
      conversationTurns: Array.isArray(timeline.conversationTurns)
        ? timeline.conversationTurns.map(normalizeConversationTurn)
        : [],
    }];
  }));
}

export function createRecoverySnapshot(input: {
  savedAt: number;
  runId: string;
  civilizationId: number;
  latestState: SimulationState;
  latestFrame: GameFrame;
  branches: Map<string, BranchTimeline>;
  activeBranchId: string;
  forkSequence: number;
  skySample: SkySample;
  cosmosSnapshot?: CosmosSnapshot;
  requiems?: CivilizationRequiem[];
  activeEmbodiment?: ActiveEmbodimentSnapshot;
  completedEmbodiments?: CompletedEmbodimentSnapshot[];
}): ElandSessionRecoverySnapshot {
  return {
    schemaVersion: 1,
    timelineHeadComplete: true,
    savedAt: input.savedAt,
    runId: input.runId,
    civilizationId: input.civilizationId,
    latestState: input.latestState,
    latestFrame: input.latestFrame,
    branches: input.branches,
    activeBranchId: input.activeBranchId,
    forkSequence: input.forkSequence,
    skySample: input.skySample,
    ...(input.cosmosSnapshot ? { cosmosSnapshot: input.cosmosSnapshot } : {}),
    ...(input.requiems?.length ? { requiems: input.requiems } : {}),
    ...(input.activeEmbodiment ? { activeEmbodiment: input.activeEmbodiment } : {}),
    ...(input.completedEmbodiments?.length
      ? { completedEmbodiments: input.completedEmbodiments }
      : {}),
  };
}
