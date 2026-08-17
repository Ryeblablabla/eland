import { materialHas } from './material';
import type { SimulationState } from './model';
import type { PersonState } from './person';
import {
  cellId,
  cellX,
  cellY,
  cellsInRadius,
  findStandingPath,
  neighbors4,
  standingPositions,
  surfaceMaterial,
  topPosition,
  voxelAt,
  type StandingPosition,
} from '../world/grid';

export interface WaterAccess {
  waterPosition: { x: number; y: number; z: number };
  bankPosition: StandingPosition;
  pathLength: number;
  remembered: boolean;
  sourceEventIds: string[];
}

function defaultVisibleCells(person: PersonState): number[] {
  const radius = 4 + Math.floor(person.baselineCapacities.perception / 25);
  return cellsInRadius(person.position.cellId, radius);
}

/** 返回本人看见或记得、且此刻物质仍为水并可实际走到岸边的最近水源。 */
export function findReachableWater(
  state: SimulationState,
  person: PersonState,
  visibleCellIds: Iterable<number> = defaultVisibleCells(person),
): WaterAccess | null {
  const visible = new Set(visibleCellIds);
  const positions = new Map<string, { position: WaterAccess['waterPosition']; remembered: boolean; sourceEventIds: string[] }>();
  for (const waterCell of visible) {
    const surface = surfaceMaterial(state.world.grid, waterCell);
    if (!materialHas(surface, 'drinkable')) continue;
    const position = topPosition(state.world.grid, waterCell);
    positions.set(`${position.x}:${position.y}:${position.z}`, { position, remembered: false, sourceEventIds: [] });
  }
  for (const place of person.knownPlaces) {
    if (!materialHas(place.materialId, 'drinkable')) continue;
    const key = `${place.position.x}:${place.position.y}:${place.position.z}`;
    if (!positions.has(key)) positions.set(key, { position: place.position, remembered: true, sourceEventIds: place.sourceEventIds });
  }

  const candidates: WaterAccess[] = [];
  for (const known of positions.values()) {
    const { position } = known;
    const currentMaterial = voxelAt(state.world.grid, position.x, position.y, position.z);
    if (!materialHas(currentMaterial, 'drinkable')) continue;
    const waterCell = cellId(position.x, position.y);
    for (const bankCell of neighbors4(waterCell)) {
      for (const bankPosition of standingPositions(state.world.grid, bankCell)) {
        if (Math.abs(bankPosition.z - position.z) > 2) continue;
        const path = findStandingPath(state.world.grid, person.position, bankPosition);
        if (!path.length) continue;
        candidates.push({
          waterPosition: { ...position },
          bankPosition,
          pathLength: path.length,
          remembered: known.remembered,
          sourceEventIds: known.sourceEventIds,
        });
      }
    }
  }
  return candidates.sort((a, b) => a.pathLength - b.pathLength
    || Number(a.remembered) - Number(b.remembered)
    || a.bankPosition.cellId - b.bankPosition.cellId
    || a.bankPosition.z - b.bankPosition.z)[0] ?? null;
}

/**
 * Select a visible, passable frontier for a thirsty person who has no visible
 * or remembered water. This deliberately does not inspect hidden water cells:
 * the person searches low-traffic terrain and can discover water only after it
 * enters perception range.
 */
export function findVisibleWaterSearchDestination(
  state: SimulationState,
  person: PersonState,
  visibleCellIds: Iterable<number> = defaultVisibleCells(person),
): StandingPosition | null {
  const recent = new Map<number, number>();
  for (const visited of person.position.lastPath) recent.set(visited, (recent.get(visited) ?? 0) + 1);
  const candidates = [...new Set(visibleCellIds)].flatMap((candidateCell) => {
    if (candidateCell === person.position.cellId) return [];
    return standingPositions(state.world.grid, candidateCell).flatMap((position) => {
      const path = findStandingPath(state.world.grid, person.position, position);
      if (path.length <= 1) return [];
      return [{
        position,
        firstStepCellId: path[1].cellId,
        pathLength: path.length,
        x: cellX(candidateCell),
        y: cellY(candidateCell),
        recentVisits: recent.get(candidateCell) ?? 0,
        visibleTraffic: state.world.traffic?.[`${candidateCell}:${position.z}`] ?? 0,
      }];
    });
  });
  if (!candidates.length) return null;
  const previousStep = person.position.lastPath.length >= 2
    ? person.position.lastPath.at(-2)
    : person.position.previousCellId;
  const nonReversing = candidates.filter((candidate) => candidate.firstStepCellId !== previousStep);
  const searchCandidates = nonReversing.length ? nonReversing : candidates;
  const identity = [...person.id].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  const directions = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
  const preferred = (identity + Math.floor(state.clock.elapsedMonths / 3)) % directions.length;
  const originX = cellX(person.position.cellId);
  const originY = cellY(person.position.cellId);
  for (let offset = 0; offset < directions.length; offset += 1) {
    const direction = directions[(preferred + offset) % directions.length];
    const originProjection = originX * direction.x + originY * direction.y;
    const forward = searchCandidates.filter((candidate) => candidate.x * direction.x + candidate.y * direction.y > originProjection);
    if (!forward.length) continue;
    return forward.sort((first, second) => {
      const projection = (second.x * direction.x + second.y * direction.y)
        - (first.x * direction.x + first.y * direction.y);
      return projection
        || first.recentVisits - second.recentVisits
        || first.visibleTraffic - second.visibleTraffic
        || second.pathLength - first.pathLength
        || first.position.cellId - second.position.cellId
        || first.position.z - second.position.z;
    })[0].position;
  }
  return searchCandidates.sort((first, second) => first.recentVisits - second.recentVisits
    || first.visibleTraffic - second.visibleTraffic
    || second.pathLength - first.pathLength
    || first.position.cellId - second.position.cellId
    || first.position.z - second.position.z)[0].position;
}
