import type { DecisionRequestContext } from './decision-context';
import type { DecisionProbeHandleMap } from './capability-handles';
import { cellX, cellY } from '../../world/grid';

export type WorldTargetDerivationContext = { person: Record<string, unknown>; actionSpace?: unknown; visible?: unknown } & Partial<Pick<DecisionRequestContext,
  'visiblePeople' | 'visiblePossessions' | 'visibleDrops' | 'visibleAnimals' | 'visibleRemains'
  | 'visibleContainers' | 'visibleWorks' | 'visibleVoxels'>>;

export interface WorldTargetDerivation {
  allowedHandles: string[];
  derived: Array<{ handle: string; sourceHandle: string; relation: 'actor-possession' | 'perceived-placement' | 'visible-possession' | 'public-position' | 'support-surface' }>;
  unresolvedPositions: Array<{ sourceHandle: string; reason: 'position-not-public' | 'position-handle-not-exposed' }>;
  unknownHandles: string[];
}

type Position = { x: number; y: number; z: number };

function publicPosition(value: unknown): Position | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const position = value as Record<string, unknown>;
  if (!Number.isInteger(position.z)) return undefined;
  if (Number.isInteger(position.x) && Number.isInteger(position.y)) return {
    x: position.x as number, y: position.y as number, z: position.z as number,
  };
  if (Number.isInteger(position.cellId)) return {
    x: cellX(position.cellId as number), y: cellY(position.cellId as number), z: position.z as number,
  };
  return undefined;
}

const samePosition = (first: Position, second: Position) => first.x === second.x && first.y === second.y && first.z === second.z;

/** Request-local reference closure over already exposed data. It neither
 * inspects simulation state nor invents a placement, possession or location. */
export function deriveWorldTargets(
  context: WorldTargetDerivationContext,
  handles: DecisionProbeHandleMap,
  selected: readonly string[],
): WorldTargetDerivation {
  const known = new Set([...handles.held, ...handles.visible, ...handles.voxels].map((item) => item.handle));
  if (handles.actorId || typeof context.person.id === 'string') known.add('self');
  const explicit = new Set(selected.filter((handle) => known.has(handle)));
  const allowed = new Set(explicit);
  if (known.has('self')) allowed.add('self');
  const derived: WorldTargetDerivation['derived'] = [];
  const add = (handle: string, sourceHandle: string, relation: WorldTargetDerivation['derived'][number]['relation']) => {
    if (!known.has(handle)) return;
    allowed.add(handle);
    if (!explicit.has(handle) && !derived.some((entry) => entry.handle === handle
      && entry.sourceHandle === sourceHandle && entry.relation === relation)) derived.push({ handle, sourceHandle, relation });
  };
  const entities = new Set([...explicit].filter((handle) => !handles.voxels.some((voxel) => voxel.handle === handle)));
  if (known.has('self')) {
    entities.add('self');
    // Held handles come from the actor's inventory, not another person's
    // possessions. Make inputs available without choosing or consuming them.
    const inventory = Array.isArray(context.person.inventory) ? context.person.inventory : undefined;
    const actionSpace = context.actionSpace && typeof context.actionSpace === 'object'
      ? context.actionSpace as Record<string, unknown> : undefined;
    const exposedHeld = Array.isArray(actionSpace?.heldObjects)
      ? new Set(actionSpace.heldObjects.map((item) => item && typeof item === 'object' ? (item as Record<string, unknown>).ref : undefined)) : undefined;
    const visible = context.visible && typeof context.visible === 'object'
      ? context.visible as Record<string, unknown> : undefined;
    const exposedPlacements = Array.isArray(visible?.surfaces)
      ? new Set(visible.surfaces.map((item) => item && typeof item === 'object' ? (item as Record<string, unknown>).ref : undefined)) : undefined;
    for (const held of handles.held) {
      if (exposedHeld && !exposedHeld.has(held.handle)) continue;
      if (inventory && !inventory.some((value) => value && typeof value === 'object'
        && ((value as Record<string, unknown>).stackId ?? (value as Record<string, unknown>).id) === held.stackId
        && Number((value as Record<string, unknown>).quantity) > 0)) continue;
      add(held.handle, 'self', 'actor-possession');
      entities.add(held.handle);
    }
    // Every voxel handle is already projected as a visible/referenceable
    // surface. A possible work site need not be underneath its input material.
    // Availability here says nothing about support, occupancy or reachability.
    for (const voxel of handles.voxels) {
      if (exposedPlacements && !exposedPlacements.has(voxel.handle)) continue;
      add(voxel.handle, 'self', 'perceived-placement');
    }
  }
  for (const sourceHandle of explicit) {
    const owner = handles.visible.find((item) => item.handle === sourceHandle && item.kind === 'person');
    if (owner?.kind !== 'person') continue;
    for (const possession of handles.visible) {
      if (possession.kind !== 'inventory-stack' || possession.personId !== owner.personId
        || !context.visiblePossessions?.some((item) => item.personId === possession.personId && item.stackId === possession.stackId)) continue;
      add(possession.handle, sourceHandle, 'visible-possession');
      entities.add(possession.handle);
    }
  }
  const entityPosition = (handle: string): Position | undefined => {
    if (handle === 'self' || handles.held.some((held) => held.handle === handle)) return publicPosition(context.person.position);
    const ref = handles.visible.find((item) => item.handle === handle);
    if (!ref) return undefined;
    if (ref.kind === 'person') return publicPosition(context.visiblePeople?.find((person) => person.id === ref.personId));
    if (ref.kind === 'inventory-stack') return publicPosition(context.visiblePossessions?.find((item) => item.personId === ref.personId && item.stackId === ref.stackId));
    if (ref.kind === 'drop') return publicPosition(context.visibleDrops?.find((drop) => drop.id === ref.dropId));
    if (ref.kind === 'animal') return publicPosition(context.visibleAnimals?.find((animal) => animal.id === ref.animalId));
    if (ref.kind === 'remains') return publicPosition(context.visibleRemains?.find((remains) => remains.id === ref.remainsId));
    if (ref.kind === 'work') return publicPosition(context.visibleWorks?.find((work) => work.id === ref.workId)?.position);
    return publicPosition(context.visibleContainers?.find((container) => container.id === ref.containerId)?.position);
  };
  const unresolvedPositions: WorldTargetDerivation['unresolvedPositions'] = [];
  for (const sourceHandle of entities) {
    const position = entityPosition(sourceHandle);
    if (!position) { unresolvedPositions.push({ sourceHandle, reason: 'position-not-public' }); continue; }
    const support = { ...position, z: position.z - 1 };
    const publiclySeenSupport = context.visibleVoxels?.some((voxel) => samePosition(voxel.position, support));
    let found = false;
    for (const voxel of handles.voxels) {
      if (samePosition(voxel.position, position)) {
        add(voxel.handle, sourceHandle, 'public-position'); found = true;
      } else if (publiclySeenSupport && samePosition(voxel.position, support)) {
        add(voxel.handle, sourceHandle, 'support-surface'); found = true;
      }
    }
    if (!found) unresolvedPositions.push({ sourceHandle, reason: 'position-handle-not-exposed' });
  }
  return { allowedHandles: [...allowed], derived, unresolvedPositions,
    unknownHandles: [...new Set(selected.filter((handle) => !known.has(handle)))] };
}
