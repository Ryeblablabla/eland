import { deserialize, serialize } from 'node:v8';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';

import type { SimulationState, WorldEvent } from '../../src/game/eland/simulation';
import { WORLD_CELL_COUNT, setVoxel } from '../../src/game/eland/world/grid';
import type { CivilizationIndexHistoryPoint, GameFrame } from '../../src/game/societyContract';
import type { AgentConversationTurn } from './conversation-coordinator';

type SnapshotState = Omit<SimulationState, 'world'>;
type SnapshotWorld = Omit<SimulationState['world'], 'grid' | 'past'>;

export type StoredFrame = Omit<GameFrame, 'society'> & {
  /** Small observer-only projection retained beside the replay frame. */
  civilizationIndex?: CivilizationIndexHistoryPoint;
};

export interface SimulationCheckpoint {
  kind: 'checkpoint';
  data: Buffer;
}

interface SimulationDeltaPayload {
  state: SnapshotState;
  world: SnapshotWorld;
  events: WorldEvent[];
  voxelIndices: Uint32Array;
  voxelValues: Uint16Array;
}

export interface SimulationDelta {
  kind: 'delta';
  data: Buffer;
}

export type StoredSnapshot = SimulationCheckpoint | SimulationDelta;

export interface SnapshotBaseline {
  eventCount: number;
  firstEventId?: string;
  lastEventId?: string;
  voxels: Uint16Array;
}

export interface BranchTimeline {
  id: string;
  parentBranchId?: string;
  forkAtMonth: number;
  createdAt: string;
  history: StoredFrame[];
  frameByMonth: Map<number, StoredFrame>;
  snapshots: Map<number, StoredSnapshot>;
  /** Player-to-person model conversations are branch-local inputs, not world facts. */
  conversationTurns?: AgentConversationTurn[];
}

function pack<T>(value: T): Buffer {
  return brotliCompressSync(serialize(value), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 3 },
  });
}

function unpack<T>(data: Buffer): T {
  return deserialize(brotliDecompressSync(data)) as T;
}

export function checkpoint(state: SimulationState): SimulationCheckpoint {
  return { kind: 'checkpoint', data: pack(state) };
}

export function baselineFor(state: SimulationState): SnapshotBaseline {
  const events = state.world.past;
  return {
    eventCount: events.length,
    ...(events[0]?.id ? { firstEventId: events[0].id } : {}),
    ...(events.at(-1)?.id ? { lastEventId: events.at(-1)!.id } : {}),
    voxels: state.world.grid.voxels.slice(),
  };
}

export function deltaBetween(previous: SnapshotBaseline, state: SimulationState): StoredSnapshot {
  const events = state.world.past;
  const prefixStable = events.length >= previous.eventCount
    && (previous.eventCount === 0
      || events[0]?.id === previous.firstEventId
      && events[previous.eventCount - 1]?.id === previous.lastEventId);
  const voxels = state.world.grid.voxels;
  if (!prefixStable || previous.voxels.length !== voxels.length) return checkpoint(state);

  const changedIndices: number[] = [];
  const changedValues: number[] = [];
  for (let index = 0; index < voxels.length; index += 1) {
    if (previous.voxels[index] === voxels[index]) continue;
    changedIndices.push(index);
    changedValues.push(voxels[index]);
  }
  const { world, ...stateFields } = state;
  const worldFields = { ...world } as Partial<SimulationState['world']>;
  delete worldFields.grid;
  delete worldFields.past;
  return {
    kind: 'delta',
    data: pack<SimulationDeltaPayload>({
      state: stateFields,
      world: worldFields as SnapshotWorld,
      events: events.slice(previous.eventCount),
      voxelIndices: Uint32Array.from(changedIndices),
      voxelValues: Uint16Array.from(changedValues),
    }),
  };
}

function applyDelta(state: SimulationState, delta: SimulationDelta): SimulationState {
  const payload = unpack<SimulationDeltaPayload>(delta.data);
  for (let offset = 0; offset < payload.voxelIndices.length; offset += 1) {
    const index = payload.voxelIndices[offset];
    const cell = index % WORLD_CELL_COUNT;
    setVoxel(
      state.world.grid,
      cell % state.world.grid.width,
      Math.floor(cell / state.world.grid.width),
      Math.floor(index / WORLD_CELL_COUNT),
      payload.voxelValues[offset],
    );
  }
  return {
    ...payload.state,
    world: {
      ...payload.world,
      grid: state.world.grid,
      past: [...state.world.past, ...payload.events],
    },
  };
}

export function createBranchTimeline(
  id: string,
  forkAtMonth: number,
  options: { parentBranchId?: string; initialFrame?: StoredFrame; initialState?: SimulationState } = {},
): BranchTimeline {
  const history = options.initialFrame ? [options.initialFrame] : [];
  return {
    id,
    ...(options.parentBranchId ? { parentBranchId: options.parentBranchId } : {}),
    forkAtMonth,
    createdAt: new Date().toISOString(),
    history,
    frameByMonth: new Map(history.map((frame) => [frame.elapsedMonths, frame])),
    snapshots: new Map(options.initialState ? [[forkAtMonth, checkpoint(options.initialState)]] : []),
    conversationTurns: [],
  };
}

export function activeTimeline(
  branches: Map<string, BranchTimeline>,
  activeBranchId: string,
): BranchTimeline {
  const timeline = branches.get(activeBranchId);
  if (!timeline) throw new Error('活动分支不存在');
  return timeline;
}

export function inheritedFrames(
  branches: Map<string, BranchTimeline>,
  timeline: BranchTimeline,
): StoredFrame[] {
  if (!timeline.parentBranchId) return timeline.history;
  const parent = branches.get(timeline.parentBranchId);
  if (!parent) return timeline.history;
  return [
    ...inheritedFrames(branches, parent).filter((frame) => frame.elapsedMonths < timeline.forkAtMonth),
    ...timeline.history,
  ];
}

export function inheritedSnapshot(
  branches: Map<string, BranchTimeline>,
  timeline: BranchTimeline,
  month: number,
): SimulationState | undefined {
  if (month < timeline.forkAtMonth && timeline.parentBranchId) {
    const parent = branches.get(timeline.parentBranchId);
    return parent ? inheritedSnapshot(branches, parent, month) : undefined;
  }
  if (!timeline.snapshots.has(month)) return undefined;
  const months = [...timeline.snapshots.keys()].filter((candidate) => candidate <= month).sort((a, b) => a - b);
  const checkpointOffset = months.findLastIndex((candidate) => timeline.snapshots.get(candidate)?.kind === 'checkpoint');
  if (checkpointOffset < 0) return undefined;
  let state: SimulationState | undefined;
  for (const candidate of months.slice(checkpointOffset)) {
    const snapshot = timeline.snapshots.get(candidate)!;
    if (snapshot.kind === 'checkpoint') state = unpack<SimulationState>(snapshot.data);
    else if (state) state = applyDelta(state, snapshot);
  }
  return state;
}

export function pruneSnapshots(timeline: BranchTimeline): void {
  const oldestFrameMonth = timeline.history[0]?.elapsedMonths;
  if (oldestFrameMonth === undefined) return;
  const retainedCheckpoint = [...timeline.snapshots.entries()]
    .filter(([month, snapshot]) => month <= oldestFrameMonth && snapshot.kind === 'checkpoint')
    .map(([month]) => month)
    .sort((a, b) => b - a)[0];
  if (retainedCheckpoint === undefined) return;
  for (const month of timeline.snapshots.keys()) {
    if (month < retainedCheckpoint) timeline.snapshots.delete(month);
  }
}

export function findStoredFrame(
  branches: Map<string, BranchTimeline>,
  timeline: BranchTimeline,
  month: number,
): StoredFrame | null {
  const local = timeline.frameByMonth.get(month);
  if (local) return local;
  if (!timeline.parentBranchId || month > timeline.forkAtMonth) return null;
  const parent = branches.get(timeline.parentBranchId);
  return parent ? findStoredFrame(branches, parent, month) : null;
}
