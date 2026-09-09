import type { VoxelPosition } from './action';
import type { ContainerState } from './container';
import type { SimulationState } from './model';
import { Material, materialDefinition, materialHas } from './material';
import { workOccupiedVoxels } from './work-layout';
import type { WorkState } from './works';
import { cellId, neighbors4, surfaceStandingPosition, voxelAt, type VoxelWorld } from '../world/grid';
import { addContainerInventory, addDrop } from './actions/inventory';

export interface WorkStorageSpace {
  cells: VoxelPosition[];
  mouth: VoxelPosition;
  capacity: number;
  retainsWater: boolean;
}

const key = (position: VoxelPosition) => `${position.x}:${position.y}:${position.z}`;
const samePosition = (left: VoxelPosition, right: VoxelPosition) => key(left) === key(right);
const directions = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;

/** Open cavities bounded by actual solid faces. One empty voxel holds one
 * material portion; names and arrangement labels confer no storage ability.
 * There is no fluid simulation: a breached face loses the finite stored water. */
export function workStorageSpaces(world: { grid: VoxelWorld }, work: WorkState): WorkStorageSpace[] {
  const occupied = workOccupiedVoxels(work).filter(({ position, materialId }) =>
    voxelAt(world.grid, position.x, position.y, position.z) === materialId);
  if (!occupied.length) return [];
  const positions = occupied.map((voxel) => voxel.position);
  const min = { x: Math.min(...positions.map((p) => p.x)), y: Math.min(...positions.map((p) => p.y)), z: Math.min(...positions.map((p) => p.z)) };
  const max = { x: Math.max(...positions.map((p) => p.x)), y: Math.max(...positions.map((p) => p.y)), z: Math.max(...positions.map((p) => p.z)) };
  const owned = new Set(positions.map(key)), visited = new Set<string>();
  const spaces: WorkStorageSpace[] = [];
  for (let z = min.z + 1; z <= max.z; z++) for (let y = min.y; y <= max.y; y++) for (let x = min.x; x <= max.x; x++) {
    const seed = { x, y, z };
    if (visited.has(key(seed)) || voxelAt(world.grid, x, y, z) !== Material.Air) continue;
    const cells = [seed], mouths: VoxelPosition[] = [];
    let closed = true, boundaryOwned = false, retainsWater = true;
    visited.add(key(seed));
    for (let index = 0; index < cells.length; index++) {
      const current = cells[index];
      for (const [dx, dy, dz] of directions) {
        const next = { x: current.x + dx, y: current.y + dy, z: current.z + dz };
        const materialId = voxelAt(world.grid, next.x, next.y, next.z);
        if (materialId !== Material.Air) {
          const solid = materialDefinition(materialId).phase === 'solid'
            && (materialHas(materialId, 'solid') || materialHas(materialId, 'ground'));
          if (!solid) closed = false;
          if (!materialDefinition(materialId).retainsWater) retainsWater = false;
          if (owned.has(key(next))) boundaryOwned = true;
          continue;
        }
        if (next.x < min.x || next.x > max.x || next.y < min.y || next.y > max.y || next.z <= min.z) {
          closed = false;
          continue;
        }
        if (next.z > max.z) { mouths.push(current); continue; }
        if (!visited.has(key(next))) { visited.add(key(next)); cells.push(next); }
      }
    }
    if (!closed || !boundaryOwned || !mouths.length) continue;
    cells.sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y);
    mouths.sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);
    spaces.push({ cells, mouth: mouths[0], capacity: cells.length, retainsWater });
  }
  return spaces;
}

export interface WorkStorageChange {
  workId: string;
  containerId: string;
  change: 'opened' | 'reshaped' | 'merged' | 'lost-containment' | 'contents-spilled';
  capacity?: number;
  retainsWater?: boolean;
  contents?: Array<{ materialId: number; quantity: number; sourceStackId: string;
    sourceEventIds: string[]; sourceLineageKeys: string[]; dropId?: string; lost?: true }>;
}

/** Settle a material mutation with its real event id, retaining input lineage.
 * No weather or facility label creates contents here. */
export function reconcileWorkStorage(state: SimulationState, atMonth: number, eventId: string): WorkStorageChange[] {
  const changes: WorkStorageChange[] = [];
  const existing = state.containers.filter((container) => container.carrier?.kind === 'work');
  const retained = new Set<string>();
  const spill = (container: ContainerState, quantityToRemove: number, liquidsOnly = false): void => {
    const contents: NonNullable<WorkStorageChange['contents']> = [];
    const origin = cellId(container.position.x, container.position.y);
    const landing = [origin, ...neighbors4(origin)].flatMap((id) => {
      const position = surfaceStandingPosition(state.world.grid, id);
      return position ? [position] : [];
    })[0] ?? { cellId: origin, z: container.position.z };
    for (const stack of container.inventory) {
      if (quantityToRemove <= 0) break;
      const liquid = materialDefinition(stack.materialId).phase === 'liquid';
      if (liquidsOnly && !liquid) continue;
      const quantity = Math.min(stack.quantity, quantityToRemove);
      if (quantity <= 0) continue;
      const sources = [...new Set([...stack.sourceEventIds, ...container.sourceEventIds, eventId])];
      const lineage = [...new Set([...(stack.sourceLineageKeys ?? []), `container:${container.id}:${stack.id}`])];
      const drop = liquid ? undefined : addDrop(state, stack.materialId, quantity, landing.cellId, atMonth,
        sources, `work-storage-spill:${container.id}`, stack.recordPayloadId, landing.z, lineage, undefined, undefined, stack.mechanicalState);
      contents.push({ materialId: stack.materialId, quantity, sourceStackId: stack.id,
        sourceEventIds: sources, sourceLineageKeys: lineage, ...(drop ? { dropId: drop.id } : { lost: true as const }) });
      stack.quantity -= quantity;
      quantityToRemove -= quantity;
    }
    container.inventory = container.inventory.filter((stack) => stack.quantity > 0);
    if (contents.length) changes.push({ workId: container.carrier!.workId, containerId: container.id, change: 'contents-spilled', contents });
  };
  for (const work of state.world.works ?? []) {
    for (const space of workStorageSpaces(state.world, work)) {
      const matches = existing.filter((container) => !retained.has(container.id) && container.carrier!.workId === work.id
        && space.cells.some((position) => samePosition(position, container.carrier!.cavityPoint)));
      let container = matches[0];
      if (!container) {
        const point = space.cells[0];
        container = { id: `work-storage:${work.id}:${key(point)}`, position: { ...space.mouth },
          inventory: [], capacity: space.capacity, retainsWater: space.retainsWater,
          carrier: { kind: 'work', workId: work.id, cavityPoint: { ...point } }, createdAtMonth: atMonth,
          sourceEventIds: [...new Set([...work.sourceEventIds, eventId])] };
        state.containers.push(container);
        changes.push({ workId: work.id, containerId: container.id, change: 'opened', capacity: space.capacity, retainsWater: space.retainsWater });
      } else if (container.capacity !== space.capacity || container.retainsWater !== space.retainsWater
        || !samePosition(container.position, space.mouth)) {
        changes.push({ workId: work.id, containerId: container.id, change: 'reshaped', capacity: space.capacity, retainsWater: space.retainsWater });
      }
      retained.add(container.id);
      for (const merged of matches.slice(1)) {
        for (const stack of merged.inventory) addContainerInventory(container, stack.materialId, stack.quantity,
          [...new Set([...stack.sourceEventIds, eventId])], stack.id, stack.recordPayloadId,
          [...new Set([...(stack.sourceLineageKeys ?? []), `container:${merged.id}:${stack.id}`])], stack.mechanicalState);
        merged.inventory = [];
        changes.push({ workId: work.id, containerId: merged.id, change: 'merged' });
      }
      container.position = { ...space.mouth };
      container.capacity = space.capacity;
      container.retainsWater = space.retainsWater;
      if (!space.retainsWater) spill(container, Number.POSITIVE_INFINITY, true);
      spill(container, Math.max(0, container.inventory.reduce((sum, stack) => sum + stack.quantity, 0) - space.capacity));
    }
  }
  for (const container of existing) if (!retained.has(container.id)) {
    spill(container, Number.POSITIVE_INFINITY);
    changes.push({ workId: container.carrier!.workId, containerId: container.id, change: 'lost-containment' });
  }
  state.containers = state.containers.filter((container) => !container.carrier || retained.has(container.id));
  return changes;
}
