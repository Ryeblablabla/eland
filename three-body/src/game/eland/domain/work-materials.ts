import type { VoxelPosition } from './action';
import { Material, type MaterialId } from './material';
import type { DropState } from './model';
import { deriveWorkProfile, workAt, type WorkComponent, type WorkState } from './works';
import { workOccupiedVoxels } from './work-layout';
import { cellId, voxelAt, type VoxelWorld } from '../world/grid';

export type WorkMaterialWorld = { grid: VoxelWorld; works?: WorkState[]; drops: DropState[] };
const samePosition = (a: VoxelPosition, b: VoxelPosition) => a.x === b.x && a.y === b.y && a.z === b.z;

/** A layout voxel represents one portion, never a natural resource yield.
 * Extra invested portions in an older compact layout remain in the aggregate.
 * Matching-material portions are allocated in the committed layout order.
 */
function componentAt(work: WorkState, position: VoxelPosition): WorkComponent | undefined {
  const voxels = workOccupiedVoxels(work);
  const index = voxels.findIndex((voxel) => samePosition(voxel.position, position));
  if (index < 0) return undefined;
  const materialId = voxels[index].materialId;
  let ordinal = voxels.slice(0, index).filter((voxel) => voxel.materialId === materialId).length;
  for (const component of work.components) {
    if (component.materialId !== materialId) continue;
    if (ordinal < component.quantity) return component;
    ordinal -= component.quantity;
  }
  return undefined;
}

export function workMaterialAt(world: Pick<WorkMaterialWorld, 'grid' | 'works'>, position: VoxelPosition) {
  const work = workAt(world, position);
  if (!work) return undefined;
  const voxel = workOccupiedVoxels(work).find((part) => samePosition(part.position, position))!;
  if (voxelAt(world.grid, position.x, position.y, position.z) !== voxel.materialId) return undefined;
  const component = componentAt(work, position);
  return component ? { work, component: structuredClone({ ...component, quantity: 1 }) } : undefined;
}

export function workComponentSources(work: WorkState, component: WorkComponent, eventId?: string) {
  return {
    sourceEventIds: [...new Set([...(component.sourceEventIds ?? []), ...work.sourceEventIds, ...(eventId ? [eventId] : [])])].slice(-24),
    sourceLineageKeys: [...new Set([...(component.sourceLineageKeys ?? []), `work:${work.id}`])].slice(-32),
  };
}

function retainGeometry(work: WorkState, occupied: ReturnType<typeof workOccupiedVoxels>, atMonth: number, eventId?: string) {
  const anchor = occupied.find((voxel) => samePosition(voxel.position, work.position)) ?? occupied[0];
  work.position = { ...anchor.position };
  work.anchorMaterialId = anchor.materialId;
  work.layout = { version: 'work-layout-v1', voxels: occupied.map((voxel) => ({
    materialId: voxel.materialId,
    offset: { x: voxel.position.x - anchor.position.x, y: voxel.position.y - anchor.position.y, z: voxel.position.z - anchor.position.z },
  })) };
  work.profile = deriveWorkProfile(work.arrangement, work.components);
  work.lastTouchedAtMonth = atMonth;
  if (eventId) work.sourceEventIds = [...new Set([...work.sourceEventIds, eventId])].slice(-16);
}

/** Apply a known physical mutation to the matching Work claim only. Callers
 * mutate the voxel in the same operation. No material is paid for a mismatch.
 * On losing the last physical part, extra compacted inputs fall to the ground.
 */
export function syncWorkVoxelMutation(
  world: WorkMaterialWorld, position: VoxelPosition, from: MaterialId, to: MaterialId,
  atMonth: number, eventId?: string,
) {
  const work = workAt(world, position);
  if (!work) return undefined;
  const occupied = workOccupiedVoxels(work);
  const index = occupied.findIndex((voxel) => samePosition(voxel.position, position) && voxel.materialId === from);
  if (index < 0 || from === to) return undefined;
  const component = componentAt(work, position);
  const removed = component ? structuredClone({ ...component, quantity: 1, ...workComponentSources(work, component, eventId) }) : undefined;
  if (component) component.quantity -= 1;
  work.components = work.components.filter((part) => part.quantity > 0);
  if (to === Material.Air) occupied.splice(index, 1);
  else {
    occupied[index].materialId = to;
    if (removed) work.components.push({ ...removed, materialId: to });
  }
  const released: DropState[] = [];
  if (occupied.length) retainGeometry(work, occupied, atMonth, eventId);
  else {
    for (const [partIndex, part] of work.components.entries()) {
      const drop: DropState = {
        id: `work-remainder:${eventId ?? atMonth}:${work.id}:${partIndex}`,
        materialId: part.materialId, quantity: part.quantity, cellId: cellId(position.x, position.y), z: position.z,
        ...workComponentSources(work, part, eventId), createdAtMonth: atMonth,
        ...(part.recordPayloadId ? { recordPayloadId: part.recordPayloadId } : {}),
        ...(part.mechanicalState ? { mechanicalState: structuredClone(part.mechanicalState) } : {}),
      };
      world.drops.push(drop); released.push(drop);
    }
    world.works = world.works?.filter((candidate) => candidate.id !== work.id);
  }
  return { workId: work.id, position: { ...position }, previousMaterialId: from, materialId: to,
    ...(removed ? { component: removed } : {}), releasedDropIds: released.map((drop) => drop.id),
    remainingComponents: occupied.length ? structuredClone(work.components) : [],
    ...(occupied.length ? { remainingPosition: { ...work.position }, remainingLayout: structuredClone(work.layout) } : {}),
  };
}

/** Unknown external replacement is loss of the old claim, never permission to
 * resurrect it or to claim the unrelated replacement. Explicit transformations
 * use syncWorkVoxelMutation instead and retain the transformed portion.
 */
export function reconcileWorkMaterials(world: WorkMaterialWorld, work: WorkState, atMonth: number, eventId?: string) {
  for (const voxel of workOccupiedVoxels(work)) {
    if (voxelAt(world.grid, voxel.position.x, voxel.position.y, voxel.position.z) !== voxel.materialId) {
      syncWorkVoxelMutation(world, voxel.position, voxel.materialId, Material.Air, atMonth, eventId);
    }
  }
  return world.works?.find((candidate) => candidate.id === work.id);
}
