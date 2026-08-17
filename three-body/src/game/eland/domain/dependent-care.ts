import type { PrimitiveAction } from './action';
import { materialHas } from './material';
import type { DropState, SimulationState } from './model';
import { ageMonths, isAlive, sameLocation, type PersonState } from './person';
import { findReachableWater, findVisibleWaterSearchDestination } from './water-access';
import { findReachableShelter } from './shelter-access';
import { shelterGeometryAt } from './structure';
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

/** Emergency care is an engine reflex. Long-term family choices remain ordinary rule-planned intents. */
export function chooseDependentCareReflex(
  state: SimulationState,
  caregiver: PersonState,
  options: { suppressThermalShelter?: boolean } = {},
): PrimitiveAction | null {
  const dependent = youngDependents(state, caregiver)
    .find((candidate) => !candidate.conditions.some((condition) => condition.kind === 'dehydrated-hibernation'));
  if (!dependent) return null;

  const dehydrationContraindicated = dependent.conditions.some((condition) => condition.kind === 'pregnancy'
    || ((condition.kind === 'wound' || condition.kind === 'illness') && condition.stage >= 2));
  if (state.civilization.epoch === 'chaotic'
    && state.civilization.climate.severity >= 4
    && !dehydrationContraindicated
    && Math.min(dependent.body.health, dependent.body.hydration, dependent.body.nutrition) >= 45) {
    return { kind: 'act', operation: 'dehydrate', targets: [{ kind: 'person', personId: dependent.id }] };
  }

  if (dependent.body.hydration < 40) {
    const visible = cellsInRadius(caregiver.position.cellId, visibleRadius(caregiver));
    const water = findReachableWater(state, caregiver, visible);
    if (water && (caregiver.position.cellId !== water.bankPosition.cellId || caregiver.position.z !== water.bankPosition.z)) {
      return { kind: 'move', toCellId: water.bankPosition.cellId, toZ: water.bankPosition.z };
    }
    if (!water) {
      const search = findVisibleWaterSearchDestination(state, caregiver, visible);
      if (search) return { kind: 'move', toCellId: search.cellId, toZ: search.z };
    }
  }

  if (dependent.body.nutrition < 40) {
    const carriedFood = caregiver.inventory.find((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'edible'));
    if (carriedFood) return {
      kind: 'transfer', materialId: carriedFood.materialId, quantity: 1,
      from: { kind: 'person', personId: caregiver.id }, to: { kind: 'person', personId: dependent.id }, stackId: carriedFood.id,
    };
    const food = nearestFood(state, caregiver);
    if (food) return caregiver.position.cellId === food.cellId && caregiver.position.z === food.z
      ? { kind: 'transfer', materialId: food.materialId, quantity: 1, from: { kind: 'ground', cellId: food.cellId, z: food.z }, to: { kind: 'person', personId: dependent.id }, dropId: food.id }
      : { kind: 'move', toCellId: food.cellId, toZ: food.z };
  }

  const thermalPressure = dependent.conditions
    .filter((condition) => condition.kind === 'cold' || condition.kind === 'heat')
    .sort((a, b) => b.stage - a.stage)[0];
  if (thermalPressure && !options.suppressThermalShelter) {
    const shelter = findReachableShelter(state, caregiver) ?? findReachableShelter(state, dependent);
    if (shelter) return { kind: 'move', toCellId: shelter.position.cellId, toZ: shelter.position.z };
  }

  return null;
}

export function shouldRemainShelteredForDependent(state: SimulationState, caregiver: PersonState): boolean {
  if (!shelterGeometryAt(state.world.grid, caregiver.position)) return false;
  if (caregiver.body.hydration < 45 || caregiver.body.nutrition < 40) return false;
  return youngDependents(state, caregiver).some((dependent) => dependent.conditions.some((condition) => (
    condition.kind === 'cold' || condition.kind === 'heat'
  ) && condition.stage >= 1));
}

export function isInfant(state: SimulationState, person: PersonState, atMonth = state.clock.elapsedMonths): boolean {
  return ageMonths(person, atMonth) < INFANT_MONTHS;
}
