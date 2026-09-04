import { completedConstructionActions, planningOverlayEvents } from './event-index';
import { committedHistoryView } from './history';
import { materialDefinition, materialHas, type MaterialId } from './material';
import type {
  ActionFact,
  PhysicalConstructionRecord,
  PhysicalStructure,
  PhysicalStructureIndex,
  DecisionAuthorityState,
  WorldEvent,
} from './model';
import { shelterGeometryAt } from './structure';
import {
  cellX,
  cellY,
  standingPositions,
  voxelAt,
  voxelWorldRevision,
  type VoxelWorld,
} from '../world/grid';

interface StructureComponent {
  x: number;
  y: number;
  z: number;
  materialId: MaterialId;
  sourceEventId: string;
}

interface ConstructionChange {
  x: number;
  y: number;
  z: number;
  materialId: MaterialId;
}

export interface PhysicalStructureFold {
  readonly width: number;
  readonly depth: number;
  readonly levels: number;
  appliedHistoryEventCount: number;
  appliedTailEventId: string | null;
  constructionEventCount: number;
  readonly recordsByPositionAndMaterial: Map<string, PhysicalConstructionRecord>;
}

interface HistorySeal {
  eventCount: number;
  tailEventId: string | null;
}

type PhysicalStructureState = Pick<DecisionAuthorityState, 'clock' | 'world'>;

function positionKey(x: number, y: number, z: number): string {
  return `${x}:${y}:${z}`;
}

function recordKey(x: number, y: number, z: number, materialId: MaterialId): string {
  return `${x}:${y}:${z}:${materialId}`;
}

function inWorld(fold: PhysicalStructureFold, x: number, y: number, z: number): boolean {
  return x >= 0 && x < fold.width && y >= 0 && y < fold.depth && z >= 0 && z < fold.levels;
}

function completedConstructionChanges(event: WorldEvent): ConstructionChange[] {
  if (event.kind !== 'action' || event.status !== 'completed') return [];
  if (event.action.kind === 'act' && event.action.operation === 'combine'
    && typeof event.diff.outputMaterialId === 'number' && event.diff.position) {
    const position = event.diff.position as { x?: unknown; y?: unknown; z?: unknown };
    if (![position.x, position.y, position.z].every(Number.isInteger)) return [];
    return [{
      x: Number(position.x),
      y: Number(position.y),
      z: Number(position.z),
      materialId: Number(event.diff.outputMaterialId) as MaterialId,
    }];
  }
  if (event.action.kind !== 'world-interact') return [];
  return event.action.adjudication.effects.flatMap((effect) => (
    effect.kind === 'replace-voxel'
      ? [{ ...effect.target.position, materialId: effect.materialId }]
      : []
  ));
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label}必须是非负安全整数`);
}

function assertPhysicalStructureIndexV2(
  index: PhysicalStructureIndex,
  world: VoxelWorld,
): asserts index is PhysicalStructureIndex & {
  projectionVersion: 2;
  appliedHistoryEventCount: number;
  appliedTailEventId: string | null;
  constructionEventCount: number;
  constructionRecords: PhysicalConstructionRecord[];
  voxelRevision: number;
} {
  const appliedHistoryEventCount = index.appliedHistoryEventCount;
  if (index.projectionVersion !== 2
    || !Number.isSafeInteger(appliedHistoryEventCount)
    || Number(appliedHistoryEventCount) < 0
    || !Number.isSafeInteger(index.constructionEventCount)
    || Number(index.constructionEventCount) < 0
    || !Number.isSafeInteger(index.voxelRevision)
    || Number(index.voxelRevision) < 0
    || !Array.isArray(index.constructionRecords)
    || (appliedHistoryEventCount === 0
      ? index.appliedTailEventId !== null
      : typeof index.appliedTailEventId !== 'string' || index.appliedTailEventId.length === 0)) {
    throw new Error('物理结构索引不是当前 bounded v2 投影');
  }
  const keys = new Set<string>();
  for (const record of index.constructionRecords) {
    const { x, y, z, materialId, firstSeenAbsoluteIndex, latestSourceAbsoluteIndex, sourceEventId } = record;
    if (![x, y, z].every(Number.isInteger)
      || x < 0 || x >= world.width || y < 0 || y >= world.depth || z < 0 || z >= world.levels
      || !Number.isInteger(materialId)
      || !materialHas(materialId, 'solid')
      || !materialHas(materialId, 'building')
      || !Number.isSafeInteger(firstSeenAbsoluteIndex)
      || firstSeenAbsoluteIndex < 0
      || !Number.isSafeInteger(latestSourceAbsoluteIndex)
      || latestSourceAbsoluteIndex < firstSeenAbsoluteIndex
      || latestSourceAbsoluteIndex >= Number(appliedHistoryEventCount)
      || typeof sourceEventId !== 'string'
      || sourceEventId.length === 0) {
      throw new Error('物理结构索引含无效建造来源记录');
    }
    const key = recordKey(x, y, z, materialId);
    if (keys.has(key)) throw new Error(`物理结构索引重复记录 ${key}`);
    keys.add(key);
  }
}

/** Begin a staged bounded fold, optionally from a previously sealed v2 index. */
export function beginPhysicalStructureFold(
  world: VoxelWorld,
  previous?: PhysicalStructureIndex,
): PhysicalStructureFold {
  if (!previous) return {
    width: world.width,
    depth: world.depth,
    levels: world.levels,
    appliedHistoryEventCount: 0,
    appliedTailEventId: null,
    constructionEventCount: 0,
    recordsByPositionAndMaterial: new Map(),
  };
  assertPhysicalStructureIndexV2(previous, world);
  return {
    width: world.width,
    depth: world.depth,
    levels: world.levels,
    appliedHistoryEventCount: previous.appliedHistoryEventCount,
    appliedTailEventId: previous.appliedTailEventId,
    constructionEventCount: previous.constructionEventCount,
    recordsByPositionAndMaterial: new Map(previous.constructionRecords.map((record) => [
      recordKey(record.x, record.y, record.z, record.materialId),
      { ...record },
    ])),
  };
}

/**
 * Fold a contiguous authoritative segment. Every event advances the absolute
 * seal; completed fixed combines and materialized Plan-Agent voxel placements
 * add bounded construction provenance.
 */
export function foldPhysicalStructureEvents(
  fold: PhysicalStructureFold,
  events: readonly WorldEvent[],
  startAbsoluteIndex: number,
): PhysicalStructureFold {
  assertNonNegativeSafeInteger(startAbsoluteIndex, '物理结构 fold 起始序号');
  if (startAbsoluteIndex !== fold.appliedHistoryEventCount) {
    throw new Error(`物理结构 fold 历史重复或跳跃：期望 ${fold.appliedHistoryEventCount}，收到 ${startAbsoluteIndex}`);
  }
  for (let offset = 0; offset < events.length; offset += 1) {
    const event = events[offset];
    const absoluteIndex = startAbsoluteIndex + offset;
    const constructionChanges = completedConstructionChanges(event)
      .filter((change) => materialHas(change.materialId, 'solid')
        && materialHas(change.materialId, 'building'));
    if (constructionChanges.length) {
      fold.constructionEventCount += 1;
      for (const { x, y, z, materialId } of constructionChanges) {
        if (inWorld(fold, x, y, z)) {
          const key = recordKey(x, y, z, materialId);
          const existing = fold.recordsByPositionAndMaterial.get(key);
          if (existing) {
            existing.latestSourceAbsoluteIndex = absoluteIndex;
            existing.sourceEventId = event.id;
          } else {
            fold.recordsByPositionAndMaterial.set(key, {
              x, y, z, materialId,
              firstSeenAbsoluteIndex: absoluteIndex,
              latestSourceAbsoluteIndex: absoluteIndex,
              sourceEventId: event.id,
            });
          }
        }
      }
    }
    fold.appliedHistoryEventCount = absoluteIndex + 1;
    fold.appliedTailEventId = event.id;
  }
  return fold;
}

function orderedRecords(fold: PhysicalStructureFold): PhysicalConstructionRecord[] {
  return [...fold.recordsByPositionAndMaterial.values()]
    .sort((left, right) => left.firstSeenAbsoluteIndex - right.firstSeenAbsoluteIndex
      || left.latestSourceAbsoluteIndex - right.latestSourceAbsoluteIndex
      || recordKey(left.x, left.y, left.z, left.materialId)
        .localeCompare(recordKey(right.x, right.y, right.z, right.materialId)));
}

function activeConstructionRecords(
  world: VoxelWorld,
  records: readonly PhysicalConstructionRecord[],
  includePlaceable: boolean,
): PhysicalConstructionRecord[] {
  return records.filter((record) => (includePlaceable || !materialHas(record.materialId, 'placeable'))
    && voxelAt(world, record.x, record.y, record.z) === record.materialId);
}

/**
 * Shelter construction deliberately leaves a walkable interior: its overhead
 * voxel and contributing side wall can therefore touch only along an edge.
 * Connect exactly those components that jointly produce one verified shelter
 * geometry; unrelated diagonal construction remains separate.
 */
function shelterFunctionalConnections(
  state: PhysicalStructureState,
  byKey: ReadonlyMap<string, StructureComponent>,
): Map<string, Set<string>> {
  const connections = new Map<string, Set<string>>();
  const connect = (left: string, right: string) => {
    if (left === right) return;
    const leftConnections = connections.get(left) ?? new Set<string>();
    const rightConnections = connections.get(right) ?? new Set<string>();
    leftConnections.add(right);
    rightConnections.add(left);
    connections.set(left, leftConnections);
    connections.set(right, rightConnections);
  };
  for (const overhead of byKey.values()) {
    const standingZ = overhead.z - 2;
    if (standingZ < 0) continue;
    const position = {
      cellId: overhead.x + overhead.y * state.world.grid.width,
      z: standingZ,
    };
    const shelter = shelterGeometryAt(state.world.grid, position);
    if (!shelter || shelter.overheadMaterialId !== overhead.materialId) continue;
    const overheadKey = positionKey(overhead.x, overhead.y, overhead.z);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const wallZ of [standingZ, standingZ + 1]) {
        const wallKey = positionKey(overhead.x + dx, overhead.y + dy, wallZ);
        if (byKey.has(wallKey)) connect(overheadKey, wallKey);
      }
    }
  }
  return connections;
}

function deriveStructuresFromRecords(
  state: PhysicalStructureState,
  records: readonly PhysicalConstructionRecord[],
): PhysicalStructure[] {
  const all: StructureComponent[] = activeConstructionRecords(state.world.grid, records, false)
    .map(({ x, y, z, materialId, sourceEventId }) => ({ x, y, z, materialId, sourceEventId }));
  const byKey = new Map(all.map((position) => [positionKey(position.x, position.y, position.z), position]));
  const functionalConnections = shelterFunctionalConnections(state, byKey);
  const visited = new Set<string>();
  const structures: PhysicalStructure[] = [];
  for (const origin of all) {
    const originKey = positionKey(origin.x, origin.y, origin.z);
    if (visited.has(originKey)) continue;
    const queue = [origin];
    let queueIndex = 0;
    const group: StructureComponent[] = [];
    visited.add(originKey);
    while (queueIndex < queue.length) {
      const current = queue[queueIndex];
      queueIndex += 1;
      group.push(current);
      const enqueue = (key: string) => {
        const next = byKey.get(key);
        if (next && !visited.has(key)) {
          visited.add(key);
          queue.push(next);
        }
      };
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        enqueue(positionKey(current.x + dx, current.y + dy, current.z + dz));
      }
      for (const key of functionalConnections.get(positionKey(current.x, current.y, current.z)) ?? []) enqueue(key);
    }
    const occupiedCells = [...new Set(group.map((position) => position.x + position.y * state.world.grid.width))];
    const sourceEventIds = group.map((component) => component.sourceEventId);
    const groupKeys = new Set(group.map((position) => positionKey(position.x, position.y, position.z)));
    const interiorPositions = occupiedCells.flatMap((cell) => standingPositions(state.world.grid, cell))
      .flatMap((position) => {
        const geometry = shelterGeometryAt(state.world.grid, position);
        if (!geometry) return [];
        const overheadKey = positionKey(cellX(position.cellId), cellY(position.cellId), position.z + 2);
        return groupKeys.has(overheadKey) ? [geometry] : [];
      });
    const complete = interiorPositions.length > 0;
    const weatherProtection = interiorPositions.length
      ? Math.round(interiorPositions.reduce((sum, interior) => sum + interior.weatherProtection, 0) / interiorPositions.length)
      : 0;
    const thermalInsulation = interiorPositions.length
      ? Math.round(interiorPositions.reduce((sum, interior) => sum + interior.thermalInsulation, 0) / interiorPositions.length)
      : 0;
    const materialIds = [...new Set(group.map((component) => component.materialId))];
    const materialLabel = materialIds.map((materialId) => materialDefinition(materialId).name).join('、');
    structures.push({
      id: `structure-${originKey}`,
      name: complete ? `${materialLabel}遮蔽结构` : `未完成${materialLabel}结构`,
      occupiedCells,
      interiorCells: [...new Set(interiorPositions.map((interior) => interior.position.cellId))],
      interiorPositions: interiorPositions.map((interior) => interior.position),
      materialIds,
      weatherProtection,
      thermalInsulation,
      capacity: interiorPositions.length,
      complete,
      sourceEventIds,
    });
  }
  return structures;
}

function materializePhysicalStructureIndex(
  state: PhysicalStructureState,
  fold: PhysicalStructureFold,
): PhysicalStructureIndex {
  const constructionRecords = orderedRecords(fold);
  return {
    projectionVersion: 2,
    appliedHistoryEventCount: fold.appliedHistoryEventCount,
    appliedTailEventId: fold.appliedTailEventId,
    calculatedAtMonth: state.clock.elapsedMonths,
    voxelRevision: voxelWorldRevision(state.world.grid),
    constructionEventCount: fold.constructionEventCount,
    constructionRecords,
    structures: deriveStructuresFromRecords(state, constructionRecords),
  };
}

function assertFoldMatchesSeal(fold: PhysicalStructureFold, seal: HistorySeal): void {
  assertNonNegativeSafeInteger(seal.eventCount, '物理结构封印 eventCount');
  if (seal.eventCount === 0 ? seal.tailEventId !== null : typeof seal.tailEventId !== 'string') {
    throw new Error('物理结构封印 tailEventId 无效');
  }
  if (fold.appliedHistoryEventCount !== seal.eventCount || fold.appliedTailEventId !== seal.tailEventId) {
    throw new Error('物理结构 fold 与权威历史封印不一致');
  }
}

/** Seal a staged fold only after its complete ledger has been verified. */
export function finishPhysicalStructureFold(
  state: PhysicalStructureState,
  fold: PhysicalStructureFold,
): PhysicalStructureIndex {
  const history = committedHistoryView(state);
  if (history.events.length !== history.hotEventCount) {
    throw new Error('物理结构 fold 不能封存 planning overlay');
  }
  assertFoldMatchesSeal(fold, {
    eventCount: history.eventCount,
    tailEventId: state.world.historyCursor?.tailEventId ?? null,
  });
  return materializePhysicalStructureIndex(state, fold);
}

/** Full-history compatibility path. A truncated ledger is rejected. */
export function derivePhysicalStructureIndex(state: PhysicalStructureState): PhysicalStructureIndex {
  const history = committedHistoryView(state);
  if (history.hotStartIndex !== 0 || history.events.length !== history.hotEventCount) {
    throw new Error('裁剪或 planning 历史不能全量重建物理结构索引');
  }
  const fold = beginPhysicalStructureFold(state.world.grid);
  foldPhysicalStructureEvents(fold, history.events.slice(0, history.hotEventCount), 0);
  return finishPhysicalStructureFold(state, fold);
}

/** Advance exactly one committed suffix without revisiting its historical prefix. */
export function advancePhysicalStructureIndex(
  state: PhysicalStructureState,
  previous: PhysicalStructureIndex,
  events: readonly WorldEvent[],
  previousSeal: HistorySeal,
): PhysicalStructureIndex {
  const finalHistory = committedHistoryView(state);
  if (finalHistory.events.length !== finalHistory.hotEventCount) {
    throw new Error('物理结构增量更新不能包含 planning overlay');
  }
  assertPhysicalStructureIndexV2(previous, state.world.grid);
  const priorFold = beginPhysicalStructureFold(state.world.grid, previous);
  assertFoldMatchesSeal(priorFold, previousSeal);
  if (previousSeal.eventCount + events.length !== finalHistory.eventCount) {
    throw new Error('物理结构增量 suffix 与绝对历史事件数不连续');
  }
  for (let offset = 0; offset < events.length; offset += 1) {
    if (finalHistory.atAbsoluteIndex(previousSeal.eventCount + offset) !== events[offset]) {
      throw new Error(`物理结构增量 suffix 的绝对事实 ${previousSeal.eventCount + offset} 未绑定到权威历史`);
    }
  }
  foldPhysicalStructureEvents(priorFold, events, previousSeal.eventCount);
  return finishPhysicalStructureFold(state, priorFold);
}

function cacheMatchesCommittedSeal(
  state: PhysicalStructureState,
  index: PhysicalStructureIndex,
): boolean {
  try {
    assertPhysicalStructureIndexV2(index, state.world.grid);
    const history = committedHistoryView(state);
    return index.appliedHistoryEventCount === history.eventCount
      && index.appliedTailEventId === (state.world.historyCursor?.tailEventId ?? null);
  } catch {
    return false;
  }
}

function legacyFullHistoryCacheIsFresh(
  state: PhysicalStructureState,
  index: PhysicalStructureIndex,
  hotStartIndex: number,
  hasOverlay: boolean,
): boolean {
  return index.projectionVersion === undefined
    && hotStartIndex === 0
    && !hasOverlay
    && index.voxelRevision !== undefined
    && index.constructionEventCount !== undefined
    && index.voxelRevision === voxelWorldRevision(state.world.grid)
    && index.constructionEventCount === completedConstructionActions(state).length;
}

function previewPhysicalStructureIndex(
  state: PhysicalStructureState,
  base: PhysicalStructureIndex,
  overlay: readonly WorldEvent[],
): PhysicalStructureIndex {
  const fold = beginPhysicalStructureFold(state.world.grid, base);
  foldPhysicalStructureEvents(fold, overlay, fold.appliedHistoryEventCount);
  return materializePhysicalStructureIndex(state, fold);
}

/** Narrow read boundary returning a fresh authoritative or planning-preview index. */
export function physicalStructureIndexOf(state: PhysicalStructureState): PhysicalStructureIndex {
  const history = committedHistoryView(state);
  const overlay = planningOverlayEvents(state);
  let base = state.world.physicalStructureIndex;
  // Raw schema-17 fixtures and old callers can still present the former cache
  // shape. It is accepted only with a complete ledger and the legacy freshness
  // proof; production adoption immediately replaces it with v2 provenance.
  if (base && legacyFullHistoryCacheIsFresh(state, base, history.hotStartIndex, overlay.length > 0)) {
    return base;
  }
  if (!base || !cacheMatchesCommittedSeal(state, base)) {
    if (history.hotStartIndex !== 0) {
      throw new Error('裁剪状态缺少与绝对历史一致的物理结构 v2 投影');
    }
    if (history.events.length !== history.hotEventCount && overlay.length === 0) {
      throw new Error('未登记的 planning 历史不能重建物理结构索引');
    }
    const committedState = history.events.length === history.hotEventCount
      ? state
      : { ...state, world: { ...state.world, past: history.events.slice(0, history.hotEventCount) } };
    base = derivePhysicalStructureIndex(committedState);
    if (overlay.length === 0) state.world.physicalStructureIndex = base;
  }
  if (overlay.length > 0) return previewPhysicalStructureIndex(state, base, overlay);
  if (base.voxelRevision === voxelWorldRevision(state.world.grid)
    && base.calculatedAtMonth === state.clock.elapsedMonths) return base;
  const refreshed = materializePhysicalStructureIndex(state, beginPhysicalStructureFold(state.world.grid, base));
  state.world.physicalStructureIndex = refreshed;
  return refreshed;
}

export function physicalStructuresOf(state: PhysicalStructureState): readonly PhysicalStructure[] {
  return physicalStructureIndexOf(state).structures;
}

/**
 * Recompute runtime topology from an already authenticated v2 provenance set.
 * This deliberately ignores the persisted voxel revision and never replays
 * the resident hot history.
 */
export function rematerializePhysicalStructureIndex(
  state: PhysicalStructureState,
  authenticated: PhysicalStructureIndex,
): PhysicalStructureIndex {
  assertPhysicalStructureIndexV2(authenticated, state.world.grid);
  const history = committedHistoryView(state);
  if (history.events.length !== history.hotEventCount
    || authenticated.appliedHistoryEventCount !== history.eventCount
    || authenticated.appliedTailEventId !== (state.world.historyCursor?.tailEventId ?? null)) {
    throw new Error('已认证物理结构 provenance 与当前绝对历史封印不一致');
  }
  return materializePhysicalStructureIndex(
    state,
    beginPhysicalStructureFold(state.world.grid, authenticated),
  );
}

/** Construction connectivity includes placeable building materials by design. */
export function constructedConnectionPositionsOf(
  state: PhysicalStructureState,
): ReadonlySet<string> {
  let index = physicalStructureIndexOf(state);
  if (!index.constructionRecords) {
    index = derivePhysicalStructureIndex(state);
    state.world.physicalStructureIndex = index;
  }
  const records = index.constructionRecords;
  if (!records) throw new Error('物理结构 v2 投影缺少建造来源记录');
  return new Set(activeConstructionRecords(state.world.grid, records, true)
    .map((record) => positionKey(record.x, record.y, record.z)));
}

/** Deep copy used only for the schema-17 observer compatibility mirror. */
export function copyPhysicalStructures(
  physicalStructureIndex: PhysicalStructureIndex,
): PhysicalStructure[] {
  return physicalStructureIndex.structures.map((structure) => ({
    ...structure,
    occupiedCells: [...structure.occupiedCells],
    interiorCells: [...structure.interiorCells],
    interiorPositions: structure.interiorPositions.map((position) => ({ ...position })),
    materialIds: [...structure.materialIds],
    sourceEventIds: [...structure.sourceEventIds],
  }));
}

/** Compatibility helper for callers that historically consumed an array. */
export function derivePhysicalStructures(state: PhysicalStructureState): PhysicalStructure[] {
  return derivePhysicalStructureIndex(state).structures;
}
