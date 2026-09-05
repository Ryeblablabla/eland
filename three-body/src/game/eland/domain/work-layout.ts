import type { VoxelPosition } from './action';
import { Material, materialDefinition, type MaterialId } from './material';
import type { PersonState } from './person';
import type { WorkComponent, WorkState } from './works';
import { cellX, cellY, voxelAt, type VoxelWorld } from '../world/grid';

export interface WorkLayoutVoxel {
  offset: VoxelPosition;
  materialId: MaterialId;
}

/** Physical occupancy relative to the work's stable anchor, not a facility label. */
export interface WorkLayout {
  version: 'work-layout-v1';
  voxels: WorkLayoutVoxel[];
}

export interface OccupiedWorkVoxel {
  position: VoxelPosition;
  materialId: MaterialId;
}

type LayoutWork = Pick<WorkState, 'position' | 'anchorMaterialId' | 'layout'>;

/** Legacy/no-layout objects occupy exactly their one recorded anchor voxel. */
export function workOccupiedVoxels(work: LayoutWork): OccupiedWorkVoxel[] {
  const voxels = work.layout?.voxels ?? [{ offset: { x: 0, y: 0, z: 0 }, materialId: work.anchorMaterialId }];
  return voxels.map((voxel) => ({
    position: {
      x: work.position.x + voxel.offset.x,
      y: work.position.y + voxel.offset.y,
      z: work.position.z + voxel.offset.z,
    },
    materialId: voxel.materialId,
  }));
}

export interface PlanWorkLayoutInput {
  grid: VoxelWorld;
  position: VoxelPosition;
  /** Used only for a new single-voxel object without an explicit layout. */
  anchorMaterialId: MaterialId;
  /** All retained components plus newly contributed material. */
  components: readonly WorkComponent[];
  /** A modification supplies the complete replacement layout, not just additions. */
  layout?: WorkLayout;
  existingWork?: Pick<WorkState, 'id' | 'position' | 'anchorMaterialId' | 'layout'>;
  otherWorks?: readonly Pick<WorkState, 'id' | 'position' | 'anchorMaterialId' | 'layout'>[];
  people?: readonly Pick<PersonState, 'id' | 'position' | 'body' | 'diedAtMonth'>[];
}

export type PlannedWorkLayout = {
  ok: true;
  layout: WorkLayout;
  anchorMaterialId: MaterialId;
  occupiedVoxels: OccupiedWorkVoxel[];
  /** materialId is the old material that must still be present when cleared. */
  clearVoxels: OccupiedWorkVoxel[];
  placeVoxels: OccupiedWorkVoxel[];
  materialUsage: WorkComponent[];
} | {
  ok: false;
  reason: string;
  conflict?: 'invalid-layout' | 'insufficient-material' | 'outside-world' | 'occupied-world' | 'occupied-work' | 'occupied-person';
  blockingPersonIds?: string[];
  blockingPositions?: VoxelPosition[];
  blockingWorkIds?: string[];
};

function positionKey(position: VoxelPosition): string {
  return `${position.x}:${position.y}:${position.z}`;
}

function integerPosition(position: VoxelPosition): boolean {
  return Number.isSafeInteger(position.x) && Number.isSafeInteger(position.y) && Number.isSafeInteger(position.z);
}

function insideWorld(grid: VoxelWorld, position: VoxelPosition): boolean {
  return position.x >= 0 && position.x < grid.width && position.y >= 0 && position.y < grid.depth
    && position.z >= 0 && position.z < grid.levels;
}

function samePosition(first: VoxelPosition, second: VoxelPosition): boolean {
  return first.x === second.x && first.y === second.y && first.z === second.z;
}

/**
 * Pure transaction planning: material accounting and real occupancy determine
 * what can be placed. The caller applies all clears before all placements and
 * persists this exact layout. No name, recipe, cover score, or intended use is
 * consulted; existing components may be rearranged without being consumed twice.
 */
export function planWorkLayout(input: PlanWorkLayoutInput): PlannedWorkLayout {
  if (!integerPosition(input.position)) return { ok: false, conflict: 'invalid-layout', reason: '造物锚点必须是明确的整数体素坐标' };
  if (input.existingWork && !samePosition(input.existingWork.position, input.position)) {
    return { ok: false, conflict: 'invalid-layout', reason: '改造保持原实体锚点，布局相对同一个锚点重新排布' };
  }
  const requested = input.layout ?? input.existingWork?.layout ?? {
    version: 'work-layout-v1' as const,
    voxels: [{ offset: { x: 0, y: 0, z: 0 }, materialId: input.existingWork?.anchorMaterialId ?? input.anchorMaterialId }],
  };
  if (requested.version !== 'work-layout-v1' || !requested.voxels.length) {
    return { ok: false, conflict: 'invalid-layout', reason: '布局必须包含至少一个真实材料体素' };
  }
  const byOffset = new Map<string, WorkLayoutVoxel>();
  const used = new Map<MaterialId, number>();
  for (const voxel of requested.voxels) {
    if (!integerPosition(voxel.offset) || !Number.isSafeInteger(voxel.materialId)
      || voxel.materialId === Material.Air || materialDefinition(voxel.materialId).id !== voxel.materialId
      || materialDefinition(voxel.materialId).phase !== 'solid') {
      return { ok: false, conflict: 'invalid-layout', reason: '布局只包含整数相对坐标和真实固体组件材料' };
    }
    const key = positionKey(voxel.offset);
    if (byOffset.has(key)) return { ok: false, conflict: 'invalid-layout', reason: '同一布局位置不能同时放置两份材料' };
    byOffset.set(key, { offset: { ...voxel.offset }, materialId: voxel.materialId });
    used.set(voxel.materialId, (used.get(voxel.materialId) ?? 0) + 1);
  }
  const anchor = byOffset.get('0:0:0');
  if (!anchor) return { ok: false, conflict: 'invalid-layout', reason: '布局必须包含相对坐标为零的真实锚点材料' };
  const available = new Map<MaterialId, number>();
  for (const component of input.components) {
    if (!Number.isFinite(component.quantity) || component.quantity < 0) {
      return { ok: false, conflict: 'insufficient-material', reason: '组件数量不能作为有效的布局物料依据' };
    }
    available.set(component.materialId, (available.get(component.materialId) ?? 0) + component.quantity);
  }
  for (const [materialId, quantity] of used) {
    if (quantity > Math.floor(available.get(materialId) ?? 0)) return {
      ok: false, conflict: 'insufficient-material',
      reason: `布局需要${quantity}份${materialDefinition(materialId).name}，实体与新增投入中只有${available.get(materialId) ?? 0}份`,
    };
  }
  const layout: WorkLayout = {
    version: 'work-layout-v1',
    voxels: [...byOffset.values()].sort((a, b) => a.offset.z - b.offset.z || a.offset.y - b.offset.y || a.offset.x - b.offset.x),
  };
  const occupiedVoxels = workOccupiedVoxels({ position: input.position, anchorMaterialId: anchor.materialId, layout });
  const outside = occupiedVoxels.filter((voxel) => !insideWorld(input.grid, voxel.position));
  if (outside.length) return { ok: false, conflict: 'outside-world', reason: '布局的一部分越出了世界边界', blockingPositions: outside.map((voxel) => voxel.position) };
  const oldVoxels = input.existingWork ? workOccupiedVoxels(input.existingWork) : [];
  const oldByPosition = new Map(oldVoxels.map((voxel) => [positionKey(voxel.position), voxel]));
  const foreignOccupants = new Map<string, string[]>();
  for (const work of input.otherWorks ?? []) {
    if (work.id === input.existingWork?.id) continue;
    for (const voxel of workOccupiedVoxels(work)) {
      if (voxelAt(input.grid, voxel.position.x, voxel.position.y, voxel.position.z) !== voxel.materialId) continue;
      const key = positionKey(voxel.position);
      foreignOccupants.set(key, [...(foreignOccupants.get(key) ?? []), work.id]);
    }
  }
  const blockedWorks = occupiedVoxels.filter((voxel) => foreignOccupants.has(positionKey(voxel.position)));
  if (blockedWorks.length) return {
    ok: false, conflict: 'occupied-work', reason: '布局会占据另一件现存造物的实体部分',
    blockingPositions: blockedWorks.map((voxel) => voxel.position),
    blockingWorkIds: [...new Set(blockedWorks.flatMap((voxel) => foreignOccupants.get(positionKey(voxel.position))!))],
  };
  const bodyConflicts = occupiedVoxels.flatMap((voxel) => (input.people ?? []).flatMap((person) => (
    person.diedAtMonth === undefined && person.body.health > 0
      && cellX(person.position.cellId) === voxel.position.x && cellY(person.position.cellId) === voxel.position.y
      && (voxel.position.z === person.position.z || voxel.position.z === person.position.z + 1)
      ? [{ personId: person.id, position: voxel.position }] : []
  )));
  if (bodyConflicts.length) return {
    ok: false, conflict: 'occupied-person', reason: '布局中的材料位置正被人的身体占据，需要先让出施工位置',
    blockingPersonIds: [...new Set(bodyConflicts.map((conflict) => conflict.personId))],
    blockingPositions: [...new Map(bodyConflicts.map((conflict) => [positionKey(conflict.position), conflict.position])).values()],
  };
  const blockedWorld = occupiedVoxels.filter((voxel) => {
    const current = voxelAt(input.grid, voxel.position.x, voxel.position.y, voxel.position.z);
    const old = oldByPosition.get(positionKey(voxel.position));
    return current !== Material.Air && (!old || current !== old.materialId);
  });
  if (blockedWorld.length) return {
    ok: false, conflict: 'occupied-world', reason: '布局会覆盖未属于本件造物的现存物质',
    blockingPositions: blockedWorld.map((voxel) => voxel.position),
  };
  const newByPosition = new Map(occupiedVoxels.map((voxel) => [positionKey(voxel.position), voxel]));
  // Every disconnected part needs a path through matter to something already
  // supporting it. Material quantity alone cannot suspend a roof in empty air.
  const unvisited = new Set(newByPosition.keys());
  const offsets = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  while (unvisited.size) {
    const firstKey = unvisited.values().next().value!;
    const frontier = [newByPosition.get(firstKey)!];
    const component: OccupiedWorkVoxel[] = [];
    let supported = false;
    unvisited.delete(firstKey);
    for (let index = 0; index < frontier.length; index += 1) {
      const current = frontier[index];
      component.push(current);
      for (const [dx, dy, dz] of offsets) {
        const adjacent = { x: current.position.x + dx, y: current.position.y + dy, z: current.position.z + dz };
        const key = positionKey(adjacent);
        const next = newByPosition.get(key);
        if (next) {
          if (unvisited.delete(key)) frontier.push(next);
          continue;
        }
        // Removed old components cannot continue supporting the new form.
        if (!oldByPosition.has(key) && materialDefinition(voxelAt(input.grid, adjacent.x, adjacent.y, adjacent.z)).phase === 'solid') {
          supported = true;
        }
      }
    }
    if (!supported) return {
      ok: false, conflict: 'invalid-layout', reason: '部分构件悬在空中，尚未连接到支撑物，需要先搭支撑或调整排布',
      blockingPositions: component.map((voxel) => voxel.position),
    };
  }
  const clearVoxels = oldVoxels.flatMap((voxel) => {
    const key = positionKey(voxel.position);
    if (newByPosition.get(key)?.materialId === voxel.materialId || foreignOccupants.has(key)
      || voxelAt(input.grid, voxel.position.x, voxel.position.y, voxel.position.z) !== voxel.materialId) return [];
    return [{ position: { ...voxel.position }, materialId: voxel.materialId }];
  });
  const placeVoxels = occupiedVoxels.filter((voxel) => voxelAt(
    input.grid, voxel.position.x, voxel.position.y, voxel.position.z,
  ) !== voxel.materialId);
  return {
    ok: true, layout, anchorMaterialId: anchor.materialId, occupiedVoxels, clearVoxels, placeVoxels,
    materialUsage: [...used].map(([materialId, quantity]) => ({ materialId, quantity })).sort((a, b) => a.materialId - b.materialId),
  };
}
