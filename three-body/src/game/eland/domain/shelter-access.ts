import type { DerivedStructure, SimulationState } from './model';
import type { PersonState } from './person';
import { shelterGeometryAt } from './structure';
import {
  cellId,
  cellsInRadius,
  findStandingPath,
  type StandingPosition,
} from '../world/grid';

export interface ShelterAccess {
  structureId: string;
  position: StandingPosition;
  pathLength: number;
  remembered: boolean;
  sourceEventIds: string[];
}

function defaultVisibleCells(person: PersonState): number[] {
  const radius = 4 + Math.floor(person.baselineCapacities.perception / 25);
  return cellsInRadius(person.position.cellId, radius);
}

function rememberedEvidence(person: PersonState, structure: DerivedStructure): string[] {
  return person.knownPlaces.flatMap((place) => {
    const placeCell = cellId(place.position.x, place.position.y);
    if (!structure.occupiedCells.includes(placeCell) || !structure.materialIds.includes(place.materialId)) return [];
    return place.sourceEventIds;
  });
}

/**
 * 住所不是全知地图上的标签：人物只能前往眼前可见，或由本人有限地点记忆确认过的真实结构。
 * 候选内部位置还会重新核验当前体素拓扑，已损坏的旧投影不会继续提供保护。
 */
export function findReachableShelter(
  state: SimulationState,
  person: PersonState,
  visibleCellIds: Iterable<number> = defaultVisibleCells(person),
): ShelterAccess | null {
  if (shelterGeometryAt(state.world.grid, person.position)) return null;
  const visible = new Set(visibleCellIds);
  const candidates: ShelterAccess[] = [];
  for (const structure of state.derived.structures) {
    if (!structure.complete) continue;
    const seenNow = structure.occupiedCells.some((cell) => visible.has(cell))
      || structure.interiorPositions.some((position) => visible.has(position.cellId));
    const rememberedSourceIds = rememberedEvidence(person, structure);
    if (!seenNow && rememberedSourceIds.length === 0) continue;
    for (const position of structure.interiorPositions) {
      if (!shelterGeometryAt(state.world.grid, position)) continue;
      const path = findStandingPath(state.world.grid, person.position, position);
      if (!path.length) continue;
      candidates.push({
        structureId: structure.id,
        position,
        pathLength: path.length,
        remembered: !seenNow,
        sourceEventIds: seenNow ? [] : [...new Set(rememberedSourceIds)],
      });
    }
  }
  return candidates.sort((a, b) => a.pathLength - b.pathLength
    || Number(a.remembered) - Number(b.remembered)
    || a.structureId.localeCompare(b.structureId)
    || a.position.cellId - b.position.cellId
    || a.position.z - b.position.z)[0] ?? null;
}
