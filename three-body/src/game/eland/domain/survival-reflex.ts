import type { FactPredicate, Intent, PrimitiveAction, WorldRef } from './action';
import { Material, materialDefinition, materialHas } from './material';
import type { DropState, SimulationState, WorldEvent } from './model';
import {
  canEnterDehydratedHibernation,
  HIBERNATION_ENTRY_LEGAL_RESERVE,
  HIBERNATION_RECOVERY_SAFE_RESERVE,
  isAlive,
  isRecoveringFromDehydratedHibernation,
  sameLocation,
  type PersonState,
} from './person';
import { isInfant } from './dependent-care';
import { canAccessContainer, containerById } from './container';
import { distanceToPosition } from './actions/execution-helpers';
import { intentById } from './state-index';
import { lifePlanningStage } from './life-stage';
import { compileBoundedWaterSearchMove, findReachableWater, moveTowardWaterAccess } from './water-access';
import { findReachableShelter } from './shelter-access';
import { shelterGeometryAt } from './structure';
import { observedHibernationEntryEvidence } from './hibernation-entry';
import { findCurrentVisibleStoredMaterialAccess, retrieveStoredMaterialOrMove } from './stored-food-access';
import { compileWildlifeThreatResponse, wildlifeThreatUrgency } from './wildlife-threat';
import { cellsInRadius, findStandingPath, isPassable, nearestCell, neighbors4, surfaceMaterial, topPosition, voxelAt } from '../world/grid';

export interface SelectedSurvivalAttempt {
  need: 'hydration' | 'nutrition';
  goal: FactPredicate;
  target: WorldRef;
  completionAction: PrimitiveAction;
}

/** Preserve what a selected approach is for, using the exact selected source. */
export function selectedSurvivalAttempt(
  state: SimulationState, person: PersonState, action: PrimitiveAction,
): SelectedSurvivalAttempt | undefined {
  const selected = (need: 'hydration' | 'nutrition', target: WorldRef, completionAction: PrimitiveAction): SelectedSurvivalAttempt => ({
    need, target, completionAction,
    goal: { kind: 'body-at-least', field: need, value: Math.min(100, person.body[need] + 1) },
  });
  if (action.kind === 'act' && action.operation === 'ingest' && action.targets[0]) {
    const target = action.targets[0];
    const materialId = target.kind === 'voxel' ? voxelAt(state.world.grid, target.position.x, target.position.y, target.position.z)
      : target.kind === 'inventory-stack' && target.personId === person.id
        ? person.inventory.find((stack) => stack.id === target.stackId)?.materialId : undefined;
    return selected(materialId !== undefined && materialHas(materialId, 'drinkable') ? 'hydration' : 'nutrition', target, action);
  }
  if (action.kind === 'move' && action.waterAccessBasis) {
    const target: WorldRef = { kind: 'voxel', position: action.waterAccessBasis.waterPosition };
    return selected('hydration', target, { kind: 'act', operation: 'ingest', targets: [target] });
  }
  if (action.kind === 'transfer' && action.to.kind === 'person' && action.to.personId === person.id && materialHas(action.materialId, 'edible')) {
    const target: WorldRef | undefined = action.dropId ? { kind: 'drop', dropId: action.dropId }
      : action.from.kind === 'container' ? { kind: 'container', containerId: action.from.containerId } : undefined;
    return target ? selected('nutrition', target, action) : undefined;
  }
  if (action.kind === 'act' && action.operation === 'separate' && action.targets[0]?.kind === 'voxel') {
    const target = action.targets[0];
    const materialId = voxelAt(state.world.grid, target.position.x, target.position.y, target.position.z);
    if (materialId === Material.BerryBush || materialId === Material.CropMature) return selected('nutrition', target, action);
  }
  if (action.kind !== 'move' || action.wildlifeThreatBasis || action.caregiverRef || action.waterSearchBasis) return undefined;
  const drop = reachableFood(state, person);
  if (drop && action.toCellId === drop.cellId && action.toZ === drop.z) return selected('nutrition', { kind: 'drop', dropId: drop.id }, {
    kind: 'transfer', materialId: drop.materialId, quantity: 1,
    from: { kind: 'ground', cellId: drop.cellId, z: drop.z }, to: { kind: 'person', personId: person.id }, dropId: drop.id,
  });
  const plant = reachableFoodPlant(state, person);
  if (plant && action.toCellId === plant.standCell) {
    const target: WorldRef = { kind: 'voxel', position: topPosition(state.world.grid, plant.plantCell) };
    return selected('nutrition', target, { kind: 'act', operation: 'separate', targets: [target] });
  }
  const stored = findCurrentVisibleStoredMaterialAccess(state, person, (stack) => materialHas(stack.materialId, 'edible'));
  if (stored && action.toCellId === stored.accessPosition.cellId && action.toZ === stored.accessPosition.z) {
    return selected('nutrition', { kind: 'container', containerId: stored.container.id }, {
      kind: 'transfer', materialId: stored.stack.materialId, quantity: 1,
      from: { kind: 'container', containerId: stored.container.id }, to: { kind: 'person', personId: person.id }, stackId: stored.stack.id,
    });
  }
  return undefined;
}

/** Continue the chosen source through acquisition and actual intake, not just reaching its cell. */
export function continuingSurvivalAttempt(
  state: SimulationState, person: PersonState, intent: Intent | undefined,
): PrimitiveAction | undefined {
  if (!intent || intent.ownerId !== person.id || intent.status !== 'active'
    || intent.interruptionKind !== 'survival-reflex' || !intent.survivalNeed
    || !intent.completionAction || !intent.target || intent.goal.kind !== 'body-at-least'
    || person.body[intent.survivalNeed] >= intent.goal.value) return undefined;
  const completion = intent.completionAction;
  const target = intent.target;
  if (intent.survivalNeed === 'nutrition') {
    const acquired = person.inventory.find((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'edible')
      && stack.sourceEventIds.some((id) => intent.actionEventIds.includes(id)));
    if (acquired) return { kind: 'act', operation: 'ingest', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: acquired.id }] };
    const produced = state.world.drops.find((drop) => drop.quantity > 0 && materialHas(drop.materialId, 'edible')
      && drop.sourceEventIds.some((id) => intent.actionEventIds.includes(id)));
    if (produced) return person.position.cellId === produced.cellId && person.position.z === produced.z ? {
      kind: 'transfer', materialId: produced.materialId, quantity: 1,
      from: { kind: 'ground', cellId: produced.cellId, z: produced.z },
      to: { kind: 'person', personId: person.id }, dropId: produced.id,
    } : { kind: 'move', toCellId: produced.cellId, toZ: produced.z };
  }
  if (target.kind === 'inventory-stack') {
    return target.personId === person.id && person.inventory.some((stack) => stack.id === target.stackId && stack.quantity > 0)
      ? completion : undefined;
  }
  if (target.kind === 'voxel') {
    const materialId = voxelAt(state.world.grid, target.position.x, target.position.y, target.position.z);
    if (intent.survivalNeed === 'hydration' ? !materialHas(materialId, 'drinkable')
      : materialId !== Material.BerryBush && materialId !== Material.CropMature) return undefined;
    if (distanceToPosition(person, target.position) <= 1) return completion;
    return intent.nextAction.kind === 'move' ? intent.nextAction : undefined;
  }
  if (target.kind === 'drop') {
    const drop = state.world.drops.find((candidate) => candidate.id === target.dropId && candidate.quantity > 0);
    if (!drop) return undefined;
    return person.position.cellId === drop.cellId && person.position.z === drop.z ? completion
      : { kind: 'move', toCellId: drop.cellId, toZ: drop.z };
  }
  if (target.kind === 'container') {
    const container = containerById(state, target.containerId);
    if (!container || completion.kind !== 'transfer'
      || !container.inventory.some((stack) => stack.id === completion.stackId && stack.quantity > 0)) return undefined;
    if (canAccessContainer(person, container)) return completion;
    return intent.nextAction.kind === 'move' ? intent.nextAction : undefined;
  }
  return undefined;
}

/** Actual immediate threats can interrupt a source-bound undertaking. */
export function survivalActionIsImmediateThreat(action: PrimitiveAction | null): boolean {
  return action?.kind === 'move' && Boolean(action.wildlifeThreatBasis || action.dependentTransportBasis || action.caregiverRef)
    || action?.kind === 'act' && (action.operation === 'dehydrate' || action.operation === 'rehydrate');
}

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

function visibleCaregiverRendezvous(state: SimulationState, person: PersonState): PrimitiveAction | null {
  if (lifePlanningStage(person, state.clock.elapsedMonths) !== 'learning-child') return null;
  if (state.people.some((candidate) => person.geneticParents.includes(candidate.id)
    && isAlive(candidate)
    && sameLocation(candidate, person))) return null;
  // A child already under real cover must not chase an adult who chose to work
  // outside during the same thermal episode. Hydration/food reflexes are
  // evaluated separately below, while a caregiver whose child's crisis is
  // genuinely more urgent still owns the return trip.
  if (shelterGeometryAt(state.world.grid, person.position)
    && person.conditions.some((condition) => condition.kind === 'cold' || condition.kind === 'heat')) {
    return null;
  }
  const underSurvivalPressure = person.body.hydration < 32
    || person.body.nutrition < 34
    || person.body.health < 45
    || person.conditions.some((condition) => condition.kind === 'cold' || condition.kind === 'heat');
  if (!underSurvivalPressure) return null;
  const radius = visibleRadius(person);
  const visible = new Set(cellsInRadius(person.position.cellId, radius));
  const caregiver = state.people
    .filter((candidate) => person.geneticParents.includes(candidate.id)
      && isAlive(candidate)
      && !sameLocation(candidate, person)
      && !person.position.tickPath.slice(1).includes(candidate.position.cellId)
      && visible.has(candidate.position.cellId)
      && Math.abs(candidate.position.z - person.position.z) <= radius)
    .map((candidate) => ({
      candidate,
      path: findStandingPath(state.world.grid, person.position, candidate.position),
    }))
    .filter(({ path }) => path.length > 0)
    .sort((left, right) => left.path.length - right.path.length || left.candidate.id.localeCompare(right.candidate.id))[0]?.candidate;
  return caregiver
    ? { kind: 'move', toCellId: caregiver.position.cellId, toZ: caregiver.position.z, caregiverRef: caregiver.id }
    : null;
}

/**
 * Recovering sleepers may only perform source-backed survival work. The
 * ordinary planner, social replies, and project actions remain queued until
 * the episode exits at the next month boundary.
 */
export function chooseHibernationRecoveryReflex(
  state: SimulationState,
  person: PersonState,
  currentMonthEvents: readonly WorldEvent[] = [],
): PrimitiveAction | null {
  if (!isRecoveringFromDehydratedHibernation(person) || state.civilization.epoch !== 'stable') return null;
  const wildlifeThreat = compileWildlifeThreatResponse(state, person);
  if (wildlifeThreat) return {
    kind: 'move',
    toCellId: wildlifeThreat.toCellId,
    toZ: wildlifeThreat.toZ,
    wildlifeThreatBasis: wildlifeThreat.basis,
  };
  const episode = person.conditions.find((condition) => condition.kind === 'dehydrated-hibernation');
  const lacksPhysicalRecoverySource = (episode?.recoverySourceEventIds?.length ?? 0) === 0;
  const stableRecoveryReserve = 65;
  const healthRecoveryNeeded = person.body.health < HIBERNATION_RECOVERY_SAFE_RESERVE;
  const restorativeFood = person.inventory
    .filter((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'edible'))
    .sort((left, right) => {
      const leftRecovery = materialDefinition(left.materialId).consume ?? {};
      const rightRecovery = materialDefinition(right.materialId).consume ?? {};
      return (healthRecoveryNeeded
        ? (rightRecovery.health ?? 0) - (leftRecovery.health ?? 0)
          || (rightRecovery.nutrition ?? 0) - (leftRecovery.nutrition ?? 0)
        : (rightRecovery.nutrition ?? 0) - (leftRecovery.nutrition ?? 0)
          || (rightRecovery.health ?? 0) - (leftRecovery.health ?? 0))
        || left.id.localeCompare(right.id);
    })[0];
  const restorativeFoodHealth = restorativeFood
    ? materialDefinition(restorativeFood.materialId).consume?.health ?? 0
    : 0;
  // The ordinary survival reflex already treats children under three as
  // unable to travel alone. Recovery must use the same physical boundary:
  // they may consume what they carry, while a caregiver owns any trip to a
  // remote water or food source.
  if (isInfant(state, person, state.clock.elapsedMonths + 1)) {
    const carriedDrink = person.inventory.find((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'drinkable'));
    if (carriedDrink && (person.body.hydration < stableRecoveryReserve || lacksPhysicalRecoverySource)) {
      return { kind: 'act', operation: 'ingest', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: carriedDrink.id }] };
    }
    if (restorativeFood && (person.body.nutrition < stableRecoveryReserve
      || (healthRecoveryNeeded && restorativeFoodHealth > 0)
      || lacksPhysicalRecoverySource)) {
      return { kind: 'act', operation: 'ingest', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: restorativeFood.id }] };
    }
    return null;
  }
  const carriedDrink = person.inventory.find((stack) => stack.quantity > 0
    && materialHas(stack.materialId, 'drinkable'));
  if (carriedDrink && (person.body.hydration < stableRecoveryReserve || lacksPhysicalRecoverySource)) {
    return { kind: 'act', operation: 'ingest', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: carriedDrink.id }] };
  }
  const visible = cellsInRadius(person.position.cellId, visibleRadius(person));
  const water = findReachableWater(state, person, visible);
  if (water && (person.body.hydration < stableRecoveryReserve || lacksPhysicalRecoverySource)) {
    const atBank = person.position.cellId === water.bankPosition.cellId && person.position.z === water.bankPosition.z;
    return atBank
      ? { kind: 'act', operation: 'ingest', targets: [{ kind: 'voxel', position: water.waterPosition }] }
      : moveTowardWaterAccess(water, state.clock.elapsedMonths + 1);
  }
  if (!water && person.body.hydration < HIBERNATION_RECOVERY_SAFE_RESERVE) {
    const search = compileBoundedWaterSearchMove(state, person, person.id, visible, currentMonthEvents);
    if (search) return search;
  }
  if (restorativeFood && (person.body.nutrition < stableRecoveryReserve
    || (person.body.health < HIBERNATION_RECOVERY_SAFE_RESERVE && restorativeFoodHealth > 0)
    || lacksPhysicalRecoverySource)) {
    return { kind: 'act', operation: 'ingest', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: restorativeFood.id }] };
  }
  if (!restorativeFood && (person.body.nutrition < HIBERNATION_RECOVERY_SAFE_RESERVE || lacksPhysicalRecoverySource)) {
    const drop = reachableFood(state, person);
    if (drop) return person.position.cellId === drop.cellId && person.position.z === drop.z
      ? { kind: 'transfer', materialId: drop.materialId, quantity: 1, from: { kind: 'ground', cellId: drop.cellId, z: drop.z }, to: { kind: 'person', personId: person.id }, dropId: drop.id }
      : { kind: 'move', toCellId: drop.cellId, toZ: drop.z };
    const plant = reachableFoodPlant(state, person);
    if (plant) return person.position.cellId === plant.standCell
      ? { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position: topPosition(state.world.grid, plant.plantCell) }] }
      : { kind: 'move', toCellId: plant.standCell };
    const stored = findCurrentVisibleStoredMaterialAccess(state, person, (stack) => materialHas(stack.materialId, 'edible'));
    if (stored) return retrieveStoredMaterialOrMove(person, stored);
  }
  return null;
}

/** Comparable urgency for choosing between self-preservation and dependent care. */
export function survivalReflexUrgency(state: SimulationState, person: PersonState): number {
  const hydration = Math.max(0, 58 - person.body.hydration) * 2.4;
  const nutrition = Math.max(0, 52 - person.body.nutrition) * 1.9;
  const health = Math.max(0, 45 - person.body.health) * 2.2;
  const thermal = person.conditions
    .filter((condition) => condition.kind === 'cold' || condition.kind === 'heat')
    .reduce((maximum, condition) => Math.max(maximum, condition.stage * 34), 0);
  return Math.max(hydration, nutrition, health, thermal, wildlifeThreatUrgency(state, person));
}

/**
 * A maxed-out shelter can be causally proven insufficient without reopening
 * the whole planner. The response remains an ordinary, executor-validated
 * dehydrate action and is grounded in the person's local exposure history.
 */
export function chooseFailedShelterHibernationReflex(
  state: SimulationState,
  person: PersonState,
): PrimitiveAction | null {
  if (lifePlanningStage(person, state.clock.elapsedMonths + 1) === 'dependent-child') return null;
  if (state.civilization.epoch !== 'chaotic' || state.civilization.climate.severity < 4) return null;
  if (!canEnterDehydratedHibernation(person, HIBERNATION_ENTRY_LEGAL_RESERVE)) return null;

  const shelter = shelterGeometryAt(state.world.grid, person.position);
  if (!shelter || shelter.enclosedSides < 3) return null;
  const hibernationEvidenceEventIds = observedHibernationEntryEvidence(state, person);
  if (!hibernationEvidenceEventIds.length) return null;
  return {
    kind: 'act',
    operation: 'dehydrate',
    targets: [{ kind: 'person', personId: person.id }],
    hibernationEvidenceEventIds,
  };
}

function chooseNewSurvivalReflex(
  state: SimulationState,
  person: PersonState,
  options: { suppressThermalShelter?: boolean; currentMonthEvents?: readonly WorldEvent[] } = {},
): PrimitiveAction | null {
  const cannotTravelAlone = isInfant(state, person, state.clock.elapsedMonths + 1);
  const caregiverRendezvous = visibleCaregiverRendezvous(state, person);
  const failedShelterHibernation = chooseFailedShelterHibernationReflex(state, person);
  const food = person.inventory.find((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'edible'));
  const wildlifeThreat = compileWildlifeThreatResponse(state, person);
  if (wildlifeThreat) return {
    kind: 'move',
    toCellId: wildlifeThreat.toCellId,
    toZ: wildlifeThreat.toZ,
    wildlifeThreatBasis: wildlifeThreat.basis,
  };

  if (person.body.hydration < 58) {
    const visible = cellsInRadius(person.position.cellId, visibleRadius(person));
    const water = findReachableWater(state, person, visible);
    const atBank = water && person.position.cellId === water.bankPosition.cellId && person.position.z === water.bankPosition.z;
    // A physically reachable water source remains useful even when the trip
    // may exhaust current reserves. Depletion is not immediate death; an
    // estimate must not postpone departure until the body is even weaker.
    if (water && (atBank || !cannotTravelAlone)) {
      return atBank
        ? { kind: 'act', operation: 'ingest', targets: [{ kind: 'voxel', position: water.waterPosition }] }
        : failedShelterHibernation ?? caregiverRendezvous ?? moveTowardWaterAccess(water, state.clock.elapsedMonths + 1);
    }
    if (!water && !cannotTravelAlone) {
      const search = compileBoundedWaterSearchMove(
        state,
        person,
        person.id,
        visible,
        options.currentMonthEvents,
      );
      if (search) return failedShelterHibernation ?? caregiverRendezvous ?? search;
    }
  }
  if (food && person.body.nutrition < 52) {
    return { kind: 'act', operation: 'ingest', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: food.id }] };
  }
  if (!food && person.body.nutrition < 34) {
    // This branch's old floor(nutrition / 1.5) - 6 <= 8 was only a
    // reserve gate. Preserve its exact range without calling it months.
    if (person.body.nutrition < 22.5) {
      const drop = reachableFood(state, person);
      const atDrop = drop && person.position.cellId === drop.cellId && person.position.z === drop.z;
      if (drop && (!cannotTravelAlone || atDrop)) return atDrop
        ? { kind: 'transfer', materialId: drop.materialId, quantity: 1, from: { kind: 'ground', cellId: drop.cellId, z: drop.z }, to: { kind: 'person', personId: person.id }, dropId: drop.id }
        : caregiverRendezvous ?? { kind: 'move', toCellId: drop.cellId, toZ: drop.z };
      const plant = reachableFoodPlant(state, person);
      if (plant && (!cannotTravelAlone || person.position.cellId === plant.standCell)) return person.position.cellId === plant.standCell
        ? { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position: topPosition(state.world.grid, plant.plantCell) }] }
        : caregiverRendezvous ?? { kind: 'move', toCellId: plant.standCell };
    }
    const stored = findCurrentVisibleStoredMaterialAccess(state, person, (stack) => materialHas(stack.materialId, 'edible'));
    if (stored) {
      const storedAction = retrieveStoredMaterialOrMove(person, stored);
      if (!cannotTravelAlone || storedAction.kind === 'transfer') return storedAction;
    }
  }

  if (failedShelterHibernation) return failedShelterHibernation;

  const thermalPressure = person.conditions
    .filter((condition) => condition.kind === 'cold' || condition.kind === 'heat')
    .sort((a, b) => b.stage - a.stage)[0];
  if (!options.suppressThermalShelter
    && !cannotTravelAlone
    && thermalPressure
    && person.body.hydration >= 25
    && person.body.nutrition >= 20) {
    const shelter = findReachableShelter(state, person);
    if (shelter) return caregiverRendezvous ?? { kind: 'move', toCellId: shelter.position.cellId, toZ: shelter.position.z };
  }
  return caregiverRendezvous;
}

export function chooseSurvivalReflex(
  state: SimulationState,
  person: PersonState,
  options: { suppressThermalShelter?: boolean; currentMonthEvents?: readonly WorldEvent[] } = {},
): PrimitiveAction | null {
  const incoming = chooseNewSurvivalReflex(state, person, options);
  if (survivalActionIsImmediateThreat(incoming)) return incoming;
  const active = person.activeIntentId ? intentById(state, person.activeIntentId) : undefined;
  return continuingSurvivalAttempt(state, person, active) ?? incoming;
}

/** Staying under real cover is state maintenance, not a repeated decision or synthetic action. */
export function shouldRemainSheltered(
  state: SimulationState,
  person: PersonState,
  groundedSurvivalAction: PrimitiveAction | null = null,
): boolean {
  if (!shelterGeometryAt(state.world.grid, person.position)) return false;
  const thermalPressure = person.conditions.some((condition) => (
    (condition.kind === 'cold' || condition.kind === 'heat') && condition.stage >= 1
  ));
  if (!thermalPressure) return false;
  // Low reserves justify leaving only when local perception has already
  // compiled a real water, food, care or hibernation action. Otherwise the
  // old intent would step outside and the thermal reflex would immediately
  // return through the same doorway without improving either need.
  if (groundedSurvivalAction
    && (person.body.hydration < 45 || person.body.nutrition < 40)) return false;
  return true;
}
