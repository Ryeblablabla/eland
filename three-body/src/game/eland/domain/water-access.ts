import { Material } from './material';
import type { SimulationState } from './model';
import type { PersonState } from './person';
import {
  cellId,
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
    if (surfaceMaterial(state.world.grid, waterCell) !== Material.Water) continue;
    const position = topPosition(state.world.grid, waterCell);
    positions.set(`${position.x}:${position.y}:${position.z}`, { position, remembered: false, sourceEventIds: [] });
  }
  for (const place of person.knownPlaces) {
    if (place.materialId !== Material.Water) continue;
    const key = `${place.position.x}:${place.position.y}:${place.position.z}`;
    if (!positions.has(key)) positions.set(key, { position: place.position, remembered: true, sourceEventIds: place.sourceEventIds });
  }

  const candidates: WaterAccess[] = [];
  for (const known of positions.values()) {
    const { position } = known;
    if (voxelAt(state.world.grid, position.x, position.y, position.z) !== Material.Water) continue;
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
