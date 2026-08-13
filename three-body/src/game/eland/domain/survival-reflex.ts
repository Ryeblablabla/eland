import type { PrimitiveAction } from './action';
import { Material, materialHas } from './material';
import type { DropState, SimulationState } from './model';
import type { PersonState } from './person';
import { isInfant } from './dependent-care';
import { RULE_ACTION_TICKS_PER_MONTH } from './calendar';
import { cellsInRadius, findPath, isPassable, nearestCell, neighbors4, surfaceMaterial, topPosition } from '../world/grid';

function visibleRadius(person: PersonState): number {
  return 4 + Math.floor(person.baselineCapacities.perception / 25);
}

function reachableWater(state: SimulationState, person: PersonState): { waterCell: number; bankCell: number; pathLength: number } | null {
  const candidates: Array<{ waterCell: number; bankCell: number; pathLength: number }> = [];
  for (const waterCell of cellsInRadius(person.position.cellId, visibleRadius(person))) {
    if (surfaceMaterial(state.world.grid, waterCell) !== Material.Water) continue;
    for (const bankCell of neighbors4(waterCell).filter((cell) => isPassable(state.world.grid, cell))) {
      const path = findPath(state.world.grid, person.position.cellId, bankCell);
      if (path.length) candidates.push({ waterCell, bankCell, pathLength: path.length });
    }
  }
  return candidates.sort((a, b) => a.pathLength - b.pathLength || a.waterCell - b.waterCell)[0] ?? null;
}

function reachableFood(state: SimulationState, person: PersonState): DropState | null {
  const visible = new Set(cellsInRadius(person.position.cellId, visibleRadius(person)));
  return state.world.drops
    .filter((drop) => drop.quantity > 0 && visible.has(drop.cellId) && materialHas(drop.materialId, 'edible'))
    .map((drop) => ({ drop, path: findPath(state.world.grid, person.position.cellId, drop.cellId) }))
    .filter(({ path }) => path.length > 0)
    .sort((a, b) => a.path.length - b.path.length || a.drop.id.localeCompare(b.drop.id))[0]?.drop ?? null;
}

function reachableFoodPlant(state: SimulationState, person: PersonState): { plantCell: number; standCell: number; pathLength: number } | null {
  const candidates = cellsInRadius(person.position.cellId, visibleRadius(person)).flatMap((plantCell) => {
    const material = surfaceMaterial(state.world.grid, plantCell);
    if (material !== Material.BerryBush && material !== Material.CropMature) return [];
    const standCell = nearestCell(person.position.cellId, [plantCell, ...neighbors4(plantCell)].filter((cell) => isPassable(state.world.grid, cell)));
    if (standCell === null) return [];
    const path = findPath(state.world.grid, person.position.cellId, standCell);
    return path.length ? [{ plantCell, standCell, pathLength: path.length }] : [];
  });
  return candidates.sort((a, b) => a.pathLength - b.pathLength || a.plantCell - b.plantCell)[0] ?? null;
}

export function chooseSurvivalReflex(state: SimulationState, person: PersonState): PrimitiveAction | null {
  const cannotTravelAlone = isInfant(state, person, state.clock.elapsedMonths + 1);
  const food = person.inventory.find((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'edible'));
  const starvationMonths = Math.max(0, Math.floor(person.body.nutrition / 1.5) - 6);

  if (person.body.hydration < 58) {
    const water = reachableWater(state, person);
    const waterTravelMonths = water ? Math.max(0, Math.ceil((water.pathLength - 1) / RULE_ACTION_TICKS_PER_MONTH)) : Number.POSITIVE_INFINITY;
    const dehydrationMonths = Math.max(0, Math.floor(person.body.hydration / 1.6) - 6);
    if (water && (person.position.cellId === water.bankCell || (!cannotTravelAlone && (waterTravelMonths <= dehydrationMonths || person.body.hydration < 32)))) {
      return person.position.cellId === water.bankCell
        ? { kind: 'act', operation: 'ingest', targets: [{ kind: 'voxel', position: topPosition(state.world.grid, water.waterCell) }] }
        : { kind: 'move', toCellId: water.bankCell };
    }
  }
  if (food && person.body.nutrition < 52) {
    return { kind: 'act', operation: 'ingest', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: food.id }] };
  }
  if (!food && person.body.nutrition < 34 && starvationMonths <= 8) {
    const drop = reachableFood(state, person);
    if (drop && (!cannotTravelAlone || person.position.cellId === drop.cellId)) return person.position.cellId === drop.cellId
      ? { kind: 'transfer', materialId: drop.materialId, quantity: 1, from: { kind: 'ground', cellId: drop.cellId }, to: { kind: 'person', personId: person.id }, dropId: drop.id }
      : { kind: 'move', toCellId: drop.cellId };
    const plant = reachableFoodPlant(state, person);
    if (plant && (!cannotTravelAlone || person.position.cellId === plant.standCell)) return person.position.cellId === plant.standCell
      ? { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position: topPosition(state.world.grid, plant.plantCell) }] }
      : { kind: 'move', toCellId: plant.standCell };
  }
  return null;
}
