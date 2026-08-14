import type { PrimitiveAction } from './action';
import { materialHas } from './material';
import type { DropState, SimulationState } from './model';
import { ageMonths, isAlive, sameLocation, type PersonState } from './person';
import { findReachableWater } from './water-access';
import { cellsInRadius, findStandingPath } from '../world/grid';

const INFANT_MONTHS = 3 * 12;
const DEPENDENT_MONTHS = 12 * 12;

function visibleRadius(person: PersonState): number {
  return 4 + Math.floor(person.baselineCapacities.perception / 25);
}

function youngDependents(state: SimulationState, caregiver: PersonState): PersonState[] {
  return state.people
    .filter((candidate) => isAlive(candidate)
      && candidate.geneticParents.includes(caregiver.id)
      && ageMonths(candidate, state.clock.elapsedMonths + 1) < DEPENDENT_MONTHS
      && sameLocation(candidate, caregiver))
    .sort((a, b) => Math.min(a.body.hydration, a.body.nutrition) - Math.min(b.body.hydration, b.body.nutrition) || a.id.localeCompare(b.id));
}

function nearestFood(state: SimulationState, caregiver: PersonState): DropState | null {
  const visible = new Set(cellsInRadius(caregiver.position.cellId, visibleRadius(caregiver)));
  return state.world.drops
    .filter((drop) => drop.quantity > 0 && visible.has(drop.cellId) && materialHas(drop.materialId, 'edible'))
    .map((drop) => ({ drop, path: findStandingPath(state.world.grid, caregiver.position, { cellId: drop.cellId, z: drop.z }) }))
    .filter(({ path }) => path.length)
    .sort((a, b) => a.path.length - b.path.length || a.drop.id.localeCompare(b.drop.id))[0]?.drop ?? null;
}

/** Emergency care is an engine reflex. Long-term family choices remain model-selected intents. */
export function chooseDependentCareReflex(state: SimulationState, caregiver: PersonState): PrimitiveAction | null {
  const dependent = youngDependents(state, caregiver)[0];
  if (!dependent) return null;
  const requiresCarrying = isInfant(state, dependent, state.clock.elapsedMonths + 1);

  if (requiresCarrying && dependent.body.hydration < 40) {
    const water = findReachableWater(state, caregiver, cellsInRadius(caregiver.position.cellId, visibleRadius(caregiver)));
    if (water && (caregiver.position.cellId !== water.bankPosition.cellId || caregiver.position.z !== water.bankPosition.z)) {
      return { kind: 'move', toCellId: water.bankPosition.cellId, toZ: water.bankPosition.z };
    }
  }

  if (dependent.body.nutrition < 40) {
    const carriedFood = caregiver.inventory.find((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'edible'));
    if (carriedFood) return {
      kind: 'transfer', materialId: carriedFood.materialId, quantity: 1,
      from: { kind: 'person', personId: caregiver.id }, to: { kind: 'person', personId: dependent.id }, stackId: carriedFood.id,
    };
    const food = requiresCarrying ? nearestFood(state, caregiver) : null;
    if (food) return caregiver.position.cellId === food.cellId && caregiver.position.z === food.z
      ? { kind: 'transfer', materialId: food.materialId, quantity: 1, from: { kind: 'ground', cellId: food.cellId, z: food.z }, to: { kind: 'person', personId: dependent.id }, dropId: food.id }
      : { kind: 'move', toCellId: food.cellId, toZ: food.z };
  }

  return null;
}

export function isInfant(state: SimulationState, person: PersonState, atMonth = state.clock.elapsedMonths): boolean {
  return ageMonths(person, atMonth) < INFANT_MONTHS;
}
