import type { VoxelPosition } from './action';
import { materialDefinition } from './material';
import { voxelAt, voxelWorldRevision, type VoxelWorld } from '../world/grid';

export interface SolidSupportEdit { position: VoxelPosition; solid: boolean }

interface SupportCache {
  revision: number;
  nextToRoot: Map<number, number | null>;
  unrooted: Set<number>;
}
const caches = new WeakMap<VoxelWorld, SupportCache>();
const freshCache = (revision: number): SupportCache => ({ revision, nextToRoot: new Map(), unrooted: new Set() });

function worldCache(world: VoxelWorld): SupportCache {
  const revision = voxelWorldRevision(world);
  let cache = caches.get(world);
  if (!cache || cache.revision !== revision) {
    cache = freshCache(revision);
    caches.set(world, cache);
  }
  return cache;
}

/**
 * The voxel world's foundation is solid matter at z=0. Support requires a
 * six-face chain to that boundary, not a neighbouring block that may itself
 * float. This is a connectivity model, not a claim about span strength.
 * Queries descend first and cache proven paths/unsupported components until
 * a voxel revision changes; they do not rescan the whole world each tick.
 * Prospective layout edits use an isolated cache and never mutate the grid.
 */
export function solidSupportQuery(world: VoxelWorld, edits: readonly SolidSupportEdit[] = []) {
  const plane = world.width * world.depth;
  const indexOf = (p: VoxelPosition) => p.z * plane + p.y * world.width + p.x;
  const positionOf = (index: number): VoxelPosition => ({
    x: index % world.width, y: Math.floor(index / world.width) % world.depth, z: Math.floor(index / plane),
  });
  const inside = (p: VoxelPosition) => Number.isInteger(p.x) && Number.isInteger(p.y) && Number.isInteger(p.z)
    && p.x >= 0 && p.x < world.width && p.y >= 0 && p.y < world.depth && p.z >= 0 && p.z < world.levels;
  const overlay = new Map(edits.map((edit) => [indexOf(edit.position), edit.solid]));
  const solid = (p: VoxelPosition) => inside(p)
    && (overlay.get(indexOf(p)) ?? (materialDefinition(voxelAt(world, p.x, p.y, p.z)).phase === 'solid'));
  let cache = edits.length ? freshCache(voxelWorldRevision(world)) : worldCache(world);
  const offsets = [[0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, -1]];
  return (position: VoxelPosition): VoxelPosition[] | null => {
    if (!solid(position)) return null;
    if (cache.revision !== voxelWorldRevision(world)) {
      cache = edits.length ? freshCache(voxelWorldRevision(world)) : worldCache(world);
    }
    const start = indexOf(position);
    if (cache.unrooted.has(start)) return null;
    const parents = new Map<number, number | null>([[start, null]]);
    const frontier = [start];
    while (frontier.length) {
      const index = frontier.pop()!;
      const current = positionOf(index);
      if (current.z === 0 || cache.nextToRoot.has(index)) {
        const path: number[] = [];
        let predecessor: number | null = index;
        while (predecessor !== null) {
          path.push(predecessor);
          predecessor = parents.get(predecessor)!;
        }
        path.reverse();
        let tail = cache.nextToRoot.get(index) ?? null;
        while (tail !== null) {
          path.push(tail);
          tail = cache.nextToRoot.get(tail) ?? null;
        }
        path.forEach((entry, at) => cache.nextToRoot.set(entry, path[at + 1] ?? null));
        return path.map(positionOf);
      }
      for (const [dx, dy, dz] of offsets) {
        const next = { x: current.x + dx, y: current.y + dy, z: current.z + dz };
        if (!solid(next)) continue;
        const nextIndex = indexOf(next);
        if (parents.has(nextIndex) || cache.unrooted.has(nextIndex)) continue;
        parents.set(nextIndex, index);
        frontier.push(nextIndex);
      }
    }
    for (const index of parents.keys()) cache.unrooted.add(index);
    return null;
  };
}

export function rootedSolidPath(world: VoxelWorld, position: VoxelPosition): VoxelPosition[] | null {
  return solidSupportQuery(world)(position);
}
