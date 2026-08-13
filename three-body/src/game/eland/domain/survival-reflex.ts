import type { PrimitiveAction } from './action';
import { executePrimitiveAction } from './action-executor';
import { Material, materialHas } from './material';
import type { ActionFact, DropState, SimulationState } from './model';
import { isAlive, type PersonState } from './person';
import { cellsInRadius, findPath, isPassable, neighbors4, surfaceMaterial, topPosition } from '../world/grid';

export interface SurvivalReflexResult {
  events: ActionFact[];
  occupiedPersonIds: Set<string>;
}

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

function chooseReflex(state: SimulationState, person: PersonState): PrimitiveAction | null {
  const food = person.inventory.find((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'edible'));
  const water = reachableWater(state, person);
  const waterTravelMonths = water ? Math.max(0, Math.ceil((water.pathLength - 1) / Math.max(2, Math.floor(person.baselineCapacities.locomotion / 12)))) : Number.POSITIVE_INFINITY;
  const dehydrationMonths = Math.max(0, Math.floor(person.body.hydration / 1.6) - 6);
  const starvationMonths = Math.max(0, Math.floor(person.body.nutrition / 1.5) - 6);

  if (person.body.hydration < 58 && water && (person.position.cellId === water.bankCell || waterTravelMonths >= dehydrationMonths || person.body.hydration < 32)) {
    return person.position.cellId === water.bankCell
      ? { kind: 'act', operation: 'ingest', targets: [{ kind: 'voxel', position: topPosition(state.world.grid, water.waterCell) }] }
      : { kind: 'move', toCellId: water.bankCell };
  }
  if (food && person.body.nutrition < 52) {
    return { kind: 'act', operation: 'ingest', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: food.id }] };
  }
  if (!food && person.body.nutrition < 34 && starvationMonths <= 8) {
    const drop = reachableFood(state, person);
    if (drop) return person.position.cellId === drop.cellId
      ? { kind: 'transfer', materialId: drop.materialId, quantity: Math.min(3, drop.quantity), from: { kind: 'ground', cellId: drop.cellId }, to: { kind: 'person', personId: person.id }, dropId: drop.id }
      : { kind: 'move', toCellId: drop.cellId };
  }
  return null;
}

export function executeSurvivalReflexes(state: SimulationState, atMonth: number, orderOffset: number): SurvivalReflexResult {
  const events: ActionFact[] = [];
  const occupiedPersonIds = new Set<string>();
  for (const person of state.people.filter(isAlive)) {
    const action = chooseReflex(state, person);
    if (!action) continue;
    const fact = executePrimitiveAction(state, person, action, atMonth, orderOffset + events.length, { cause: 'survival-reflex' });
    events.push(fact);
    if (action.kind === 'move') occupiedPersonIds.add(person.id);
    person.currentActionText = fact.result;
  }
  return { events, occupiedPersonIds };
}
