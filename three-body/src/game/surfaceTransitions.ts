export type SurfaceTransitionKind =
  | 'grass'
  | 'soil'
  | 'wet-soil'
  | 'rich-soil'
  | 'exhausted-soil'
  | 'cultivated'
  | 'sand';

export type SurfaceTransitionDirection = 'north' | 'east' | 'south' | 'west';
export type SurfaceTransitionDiagonal = 'northEast' | 'southEast' | 'southWest' | 'northWest';

export type SurfaceTransitionNeighbors = Partial<Record<
  SurfaceTransitionDirection | SurfaceTransitionDiagonal,
  SurfaceTransitionKind
>>;
export type ShorelineNeighbors = Partial<Record<
  SurfaceTransitionDirection | SurfaceTransitionDiagonal,
  boolean
>>;

export interface SurfaceTransitionPatch {
  microX: number;
  microZ: number;
  source: SurfaceTransitionDirection;
  depth: 0 | 1;
}

export function surfaceTransitionKind(materialKey: string | undefined): SurfaceTransitionKind | undefined {
  switch (materialKey) {
    case 'grass': return 'grass';
    case 'soil': return 'soil';
    case 'wet_soil': return 'wet-soil';
    case 'rich_soil': return 'rich-soil';
    case 'exhausted_soil': return 'exhausted-soil';
    case 'crop_sprout': case 'crop_mature': return 'cultivated';
    case 'sand': return 'sand';
    default: return undefined;
  }
}

function transitionHash(seed: number, value: number, salt: number): number {
  let hash = (seed ^ value ^ Math.imul(salt + 1, 0x01000193)) >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d) >>> 0;
  hash = (hash ^ (hash >>> 15)) >>> 0;
  return hash / 0x100000000;
}

const CORNER_DIAGONAL: Record<string, SurfaceTransitionDiagonal> = {
  'north:east': 'northEast',
  'east:north': 'northEast',
  'south:east': 'southEast',
  'east:south': 'southEast',
  'south:west': 'southWest',
  'west:south': 'southWest',
  'north:west': 'northWest',
  'west:north': 'northWest',
};

/**
 * 把一个地表格的四条真实边界栅格化为 8×8 微体素过渡片。
 * 对角邻居只调整两个正交边相遇处的覆盖率，绝不会单独建立跨角连接。
 */
export function surfaceTransitionPatches(
  center: SurfaceTransitionKind,
  neighbors: SurfaceTransitionNeighbors,
  seed: number,
): SurfaceTransitionPatch[] {
  const patches: SurfaceTransitionPatch[] = [];
  for (let microZ = 0; microZ < 8; microZ++) {
    for (let microX = 0; microX < 8; microX++) {
      const candidates: Array<{
        direction: SurfaceTransitionDirection;
        depth: number;
        kind: SurfaceTransitionKind;
      }> = [];
      const consider = (direction: SurfaceTransitionDirection, depth: number) => {
        const kind = neighbors[direction];
        if (depth <= 1 && kind !== undefined && kind !== center) candidates.push({ direction, depth, kind });
      };
      consider('north', microZ);
      consider('east', 7 - microX);
      consider('south', 7 - microZ);
      consider('west', microX);
      if (candidates.length === 0) continue;

      const nearestDepth = Math.min(...candidates.map((candidate) => candidate.depth)) as 0 | 1;
      const nearest = candidates.filter((candidate) => candidate.depth === nearestDepth);
      const chosen = nearest.length === 1
        ? nearest[0]
        : nearest[Math.floor(transitionHash(seed, microZ * 8 + microX, 1) * nearest.length)];

      let coverage = nearestDepth === 0 ? 0.86 : 0.42;
      const vertical = candidates.find((candidate) => candidate.direction === 'north' || candidate.direction === 'south');
      const horizontal = candidates.find((candidate) => candidate.direction === 'east' || candidate.direction === 'west');
      if (vertical && horizontal && vertical.kind === horizontal.kind) {
        const diagonal = neighbors[CORNER_DIAGONAL[`${vertical.direction}:${horizontal.direction}`]];
        if (diagonal === vertical.kind) coverage += 0.12;
        else if (diagonal === center) coverage -= 0.3;
      }

      if (transitionHash(seed, microZ * 8 + microX, 2) > coverage) continue;
      patches.push({ microX, microZ, source: chosen.direction, depth: nearestDepth });
    }
  }
  return patches;
}

/**
 * 把与同高水面的真实正交邻接栅格化为窄岸线。这里仅返回位置；调用方使用
 * 湿沙或湿土色着色，绝不把水色混入陆地。对角水格仍只参与拐角收放。
 */
export function shorelinePatches(
  neighbors: ShorelineNeighbors,
  seed: number,
): SurfaceTransitionPatch[] {
  const patches: SurfaceTransitionPatch[] = [];
  for (let microZ = 0; microZ < 8; microZ++) {
    for (let microX = 0; microX < 8; microX++) {
      const candidates: Array<{ direction: SurfaceTransitionDirection; depth: number }> = [];
      const consider = (direction: SurfaceTransitionDirection, depth: number) => {
        if (depth <= 1 && neighbors[direction] === true) candidates.push({ direction, depth });
      };
      consider('north', microZ);
      consider('east', 7 - microX);
      consider('south', 7 - microZ);
      consider('west', microX);
      if (candidates.length === 0) continue;

      const nearestDepth = Math.min(...candidates.map((candidate) => candidate.depth)) as 0 | 1;
      const nearest = candidates.filter((candidate) => candidate.depth === nearestDepth);
      const chosen = nearest.length === 1
        ? nearest[0]
        : nearest[Math.floor(transitionHash(seed, microZ * 8 + microX, 3) * nearest.length)];

      let coverage = nearestDepth === 0 ? 0.94 : 0.56;
      const vertical = candidates.find((candidate) => candidate.direction === 'north' || candidate.direction === 'south');
      const horizontal = candidates.find((candidate) => candidate.direction === 'east' || candidate.direction === 'west');
      if (vertical && horizontal) {
        const diagonal = neighbors[CORNER_DIAGONAL[`${vertical.direction}:${horizontal.direction}`]];
        if (diagonal === true) coverage += 0.06;
        else if (diagonal === false) coverage -= 0.28;
      }

      if (transitionHash(seed, microZ * 8 + microX, 4) > coverage) continue;
      patches.push({ microX, microZ, source: chosen.direction, depth: nearestDepth });
    }
  }
  return patches;
}
