import type { SimulationState } from '../../src/game/eland/simulation';
import type { CosmosSnapshot, GameFrame, SkySample } from '../../src/game/societyContract';
import { normalizeConversationTurn } from './conversation-coordinator';
import type { BranchTimeline } from './timeline';

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
}

export function validateRecoverySnapshot(snapshot: ElandSessionRecoverySnapshot): {
  state: SimulationState;
  frame: GameFrame;
  cosmosSnapshot?: CosmosSnapshot;
} {
  if (snapshot.schemaVersion !== 1 || !snapshot.latestState || !snapshot.latestFrame) {
    throw new Error('实时演化会话快照版本不受支持');
  }
  const state = snapshot.latestState;
  const frame = snapshot.latestFrame;
  const timeline = snapshot.branches instanceof Map ? snapshot.branches.get(snapshot.activeBranchId) : undefined;
  const head = timeline?.history.at(-1);
  if (state.schemaVersion !== 17
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
  return { state, frame, ...(cosmosSnapshot ? { cosmosSnapshot } : {}) };
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
  };
}
