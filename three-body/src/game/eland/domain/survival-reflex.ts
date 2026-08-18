import type { PrimitiveAction } from './action';
import { Material, materialHas } from './material';
import type { DropState, SimulationState } from './model';
import type { PersonState } from './person';
import { isInfant } from './dependent-care';
import { RULE_ACTION_TICKS_PER_MONTH } from './calendar';
import { findReachableWater, findVisibleWaterSearchDestination } from './water-access';
import { findReachableShelter } from './shelter-access';
import { shelterGeometryAt } from './structure';
import { cellsInRadius, findStandingPath, isPassable, nearestCell, neighbors4, surfaceMaterial, topPosition } from '../world/grid';

function visibleRadius(person: PersonState): number {
  return 4 + Math.floor(person.baselineCapacities.perception / 25);
}

function reachableFood(state: SimulationState, person: PersonState): DropState | null {
  const visible = new Set(cellsInRadius(person.position.cellId, visibleRadius(person)));
  return state.world.drops
    .filter((drop) => drop.quantity > 0 && visible.has(drop.cellId) && materialHas(drop.materialId, 'edible'))
    .map((drop) => ({ drop, path: findStandingPath(state.world.grid, person.position, { cellId: drop.cellId, z: drop.z }) }))
    .filter(({ path }) => path.length > 0)
    .sort((a, b) => a.path.length - b.path.length || a.drop.id.localeCompare(b.drop.id))[0]?.drop ?? null;
}

function reachableFoodPlant(state: SimulationState, person: PersonState): { plantCell: number; standCell: number; pathLength: number } | null {
  const candidates = cellsInRadius(person.position.cellId, visibleRadius(person)).flatMap((plantCell) => {
    const material = surfaceMaterial(state.world.grid, plantCell);
    if (material !== Material.BerryBush && material !== Material.CropMature) return [];
    const standCell = nearestCell(person.position.cellId, [plantCell, ...neighbors4(plantCell)].filter((cell) => isPassable(state.world.grid, cell)));
    if (standCell === null) return [];
    const path = findStandingPath(state.world.grid, person.position, { cellId: standCell });
    return path.length ? [{ plantCell, standCell, pathLength: path.length }] : [];
  });
  return candidates.sort((a, b) => a.pathLength - b.pathLength || a.plantCell - b.plantCell)[0] ?? null;
}

/** Comparable urgency for choosing between self-preservation and dependent care. */
export function survivalReflexUrgency(person: PersonState): number {
  const hydration = Math.max(0, 58 - person.body.hydration) * 2.4;
  const nutrition = Math.max(0, 52 - person.body.nutrition) * 1.9;
  const health = Math.max(0, 45 - person.body.health) * 2.2;
  const thermal = person.conditions
    .filter((condition) => condition.kind === 'cold' || condition.kind === 'heat')
    .reduce((maximum, condition) => Math.max(maximum, condition.stage * 34), 0);
  return Math.max(hydration, nutrition, health, thermal);
}

export function chooseSurvivalReflex(
  state: SimulationState,
  person: PersonState,
  options: { suppressThermalShelter?: boolean } = {},
): PrimitiveAction | null {
  const cannotTravelAlone = isInfant(state, person, state.clock.elapsedMonths + 1);
  const food = person.inventory.find((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'edible'));
  const starvationMonths = Math.max(0, Math.floor(person.body.nutrition / 1.5) - 6);

  if (person.body.hydration < 58) {
    const visible = cellsInRadius(person.position.cellId, visibleRadius(person));
    const water = findReachableWater(state, person, visible);
    const waterTravelMonths = water ? Math.max(0, Math.ceil((water.pathLength - 1) / RULE_ACTION_TICKS_PER_MONTH)) : Number.POSITIVE_INFINITY;
    const dehydrationMonths = Math.max(0, Math.floor(person.body.hydration / 1.6) - 6);
    const atBank = water && person.position.cellId === water.bankPosition.cellId && person.position.z === water.bankPosition.z;
    if (water && (atBank || (!cannotTravelAlone && (waterTravelMonths <= dehydrationMonths || person.body.hydration < 32)))) {
      return atBank
        ? { kind: 'act', operation: 'ingest', targets: [{ kind: 'voxel', position: water.waterPosition }] }
        : { kind: 'move', toCellId: water.bankPosition.cellId, toZ: water.bankPosition.z };
    }
    if (!water && !cannotTravelAlone) {
      const search = findVisibleWaterSearchDestination(state, person, visible);
      if (search) return { kind: 'move', toCellId: search.cellId, toZ: search.z };
    }
  }
  if (food && person.body.nutrition < 52) {
    return { kind: 'act', operation: 'ingest', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: food.id }] };
  }
  if (!food && person.body.nutrition < 34 && starvationMonths <= 8) {
    const drop = reachableFood(state, person);
    const atDrop = drop && person.position.cellId === drop.cellId && person.position.z === drop.z;
    if (drop && (!cannotTravelAlone || atDrop)) return atDrop
      ? { kind: 'transfer', materialId: drop.materialId, quantity: 1, from: { kind: 'ground', cellId: drop.cellId, z: drop.z }, to: { kind: 'person', personId: person.id }, dropId: drop.id }
      : { kind: 'move', toCellId: drop.cellId, toZ: drop.z };
    const plant = reachableFoodPlant(state, person);
    if (plant && (!cannotTravelAlone || person.position.cellId === plant.standCell)) return person.position.cellId === plant.standCell
      ? { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position: topPosition(state.world.grid, plant.plantCell) }] }
      : { kind: 'move', toCellId: plant.standCell };
  }

  const thermalPressure = person.conditions
    .filter((condition) => condition.kind === 'cold' || condition.kind === 'heat')
    .sort((a, b) => b.stage - a.stage)[0];
  if (!options.suppressThermalShelter
    && !cannotTravelAlone
    && thermalPressure
    && person.body.hydration >= 25
    && person.body.nutrition >= 20) {
    const shelter = findReachableShelter(state, person);
    if (shelter) return { kind: 'move', toCellId: shelter.position.cellId, toZ: shelter.position.z };
  }
  return null;
}

/** Staying under real cover is state maintenance, not a repeated decision or synthetic action. */
export function shouldRemainSheltered(state: SimulationState, person: PersonState): boolean {
  if (!shelterGeometryAt(state.world.grid, person.position)) return false;
  if (person.body.hydration < 45 || person.body.nutrition < 40) return false;
  return person.conditions.some((condition) => (condition.kind === 'cold' || condition.kind === 'heat') && condition.stage >= 1);
}
