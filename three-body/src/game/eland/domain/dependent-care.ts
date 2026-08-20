import type { PrimitiveAction } from './action';
import { materialHas } from './material';
import type { DropState, SimulationState } from './model';
import {
  ageMonths,
  canEnterDehydratedHibernation,
  HIBERNATION_ENTRY_LEGAL_RESERVE,
  HIBERNATION_RECOVERY_SAFE_RESERVE,
  hibernationPhase,
  isAlive,
  isDormantDehydratedHibernating,
  sameLocation,
  type PersonState,
} from './person';
import { findReachableWater, findVisibleWaterSearchDestination } from './water-access';
import { findReachableShelter } from './shelter-access';
import { shelterGeometryAt } from './structure';
import { lifePlanningStage } from './life-stage';
import { cellsInRadius, findStandingPath } from '../world/grid';
import { observedHibernationEntryEvidence } from './hibernation-entry';
import { findCurrentVisibleStoredMaterialAccess, retrieveStoredMaterialOrMove } from './stored-food-access';

const INFANT_MONTHS = 3 * 12;
const DEPENDENT_MONTHS = 12 * 12;

export interface ReproductiveResponsibility {
  pressure: number;
  dependentCount: number;
  infantCount: number;
  reasons: string[];
  sourceFactIds: string[];
  basisKeys: string[];
}

function visibleRadius(person: PersonState): number {
  return 4 + Math.floor(person.baselineCapacities.perception / 25);
}

function dependentChildren(state: SimulationState, caregiver: PersonState): PersonState[] {
  return state.people
    .filter((candidate) => isAlive(candidate)
      && candidate.geneticParents.includes(caregiver.id)
      && ageMonths(candidate, state.clock.elapsedMonths + 1) < DEPENDENT_MONTHS)
    .sort((a, b) => Math.min(a.body.hydration, a.body.nutrition) - Math.min(b.body.hydration, b.body.nutrition) || a.id.localeCompare(b.id));
}

function visibleYoungDependents(state: SimulationState, caregiver: PersonState): PersonState[] {
  const visible = new Set(cellsInRadius(caregiver.position.cellId, visibleRadius(caregiver)));
  return dependentChildren(state, caregiver).filter((candidate) => visible.has(candidate.position.cellId));
}

function coLocatedYoungDependents(state: SimulationState, caregiver: PersonState): PersonState[] {
  return dependentChildren(state, caregiver).filter((candidate) => sameLocation(candidate, caregiver));
}

/**
 * A person's remembered responsibility for living biological children. Child
 * age is known from the birth history; an extra crisis cost is used only when
 * parent and child are co-located, so the decision never reads remote health.
 */
export function reproductiveResponsibility(
  state: SimulationState,
  caregiver: PersonState,
  atMonth = state.clock.elapsedMonths,
): ReproductiveResponsibility {
  const dependents = state.people
    .filter((candidate) => isAlive(candidate)
      && candidate.geneticParents.includes(caregiver.id)
      && ageMonths(candidate, atMonth) < DEPENDENT_MONTHS)
    .sort((left, right) => left.id.localeCompare(right.id));
  const postpartum = caregiver.conditions.find((condition) => condition.kind === 'postpartum-recovery');
  let pressure = postpartum ? 72 : 0;
  let infantCount = 0;
  const reasons: string[] = postpartum ? ['本人仍处于产后恢复期'] : [];
  const sourceFactIds = new Set(postpartum?.sourceEventIds ?? []);
  const basisKeys: string[] = postpartum
    ? [`postpartum-recovery:stage-${postpartum.stage}`]
    : [];
  for (const dependent of dependents) {
    const age = ageMonths(dependent, atMonth);
    const ageBand = age < INFANT_MONTHS ? 'infant' : age < 6 * 12 ? 'young-child' : 'older-child';
    const base = ageBand === 'infant' ? 24 : ageBand === 'young-child' ? 14 : 6;
    if (ageBand === 'infant') infantCount += 1;
    pressure += base;
    basisKeys.push(`dependent-care:${dependent.id}:${ageBand}`);
    caregiver.relations.find((relation) => relation.personId === dependent.id)
      ?.sourceEventIds.forEach((eventId) => sourceFactIds.add(eventId));
    if (sameLocation(dependent, caregiver)) {
      const reserve = Math.min(dependent.body.health, dependent.body.hydration, dependent.body.nutrition);
      if (reserve < 45) {
        pressure += Math.min(24, (45 - reserve) * 1.5);
        basisKeys.push(`dependent-care:${dependent.id}:local-crisis`);
        reasons.push(`${dependent.name}在身边且身体储备偏低`);
      }
    }
  }
  if (infantCount > 0) reasons.push(`已有${infantCount}名婴幼儿需要持续照护`);
  else if (dependents.length > 0) reasons.push(`已有${dependents.length}名未成年子女需要照护`);
  return {
    pressure: Math.min(140, pressure),
    dependentCount: dependents.length,
    infantCount,
    reasons,
    sourceFactIds: [...sourceFactIds].sort(),
    basisKeys: [...new Set(basisKeys)].sort(),
  };
}

export function hasReproductiveRecoveryCondition(person: PersonState): boolean {
  return person.conditions.some((condition) => condition.kind === 'pregnancy' || condition.kind === 'postpartum-recovery');
}

function nearestFood(state: SimulationState, caregiver: PersonState): DropState | null {
  const visible = new Set(cellsInRadius(caregiver.position.cellId, visibleRadius(caregiver)));
  return state.world.drops
    .filter((drop) => drop.quantity > 0 && visible.has(drop.cellId) && materialHas(drop.materialId, 'edible'))
    .map((drop) => ({ drop, path: findStandingPath(state.world.grid, caregiver.position, { cellId: drop.cellId, z: drop.z }) }))
    .filter(({ path }) => path.length)
    .sort((a, b) => a.path.length - b.path.length || a.drop.id.localeCompare(b.drop.id))[0]?.drop ?? null;
}

/** Comparable urgency for choosing a child's crisis over a milder self reflex. */
export function dependentCareUrgency(state: SimulationState, caregiver: PersonState): number {
  return visibleYoungDependents(state, caregiver)
    .filter((dependent) => !isDormantDehydratedHibernating(dependent))
    .reduce((maximum, dependent) => {
      const hydration = Math.max(0, 48 - dependent.body.hydration) * 3;
      const nutrition = Math.max(0, 46 - dependent.body.nutrition) * 2.4;
      const health = Math.max(0, 48 - dependent.body.health) * 2.6;
      const thermal = dependent.conditions
        .filter((condition) => condition.kind === 'cold' || condition.kind === 'heat')
        .reduce((stageMaximum, condition) => Math.max(stageMaximum, condition.stage * 38), 0);
      return Math.max(maximum, hydration, nutrition, health, thermal);
    }, 0);
}

/** Emergency care is an engine reflex. Long-term family choices remain ordinary rule-planned intents. */
export function chooseDependentCareReflex(
  state: SimulationState,
  caregiver: PersonState,
  options: { suppressThermalShelter?: boolean } = {},
): PrimitiveAction | null {
  const dependent = visibleYoungDependents(state, caregiver)
    .find((candidate) => !isDormantDehydratedHibernating(candidate));
  if (!dependent) return null;

  const atMonth = state.clock.elapsedMonths + 1;
  const together = sameLocation(dependent, caregiver);
  const infant = isInfant(state, dependent, state.clock.elapsedMonths + 1);
  const dependentChild = lifePlanningStage(dependent, atMonth) === 'dependent-child';
  const recoveryEpisode = dependent.conditions.find((condition) => condition.kind === 'dehydrated-hibernation'
    && hibernationPhase(condition) === 'recovering');
  const needsRecoveryWater = state.civilization.epoch === 'stable'
    && dependentChild
    && dependent.body.hydration < HIBERNATION_RECOVERY_SAFE_RESERVE
    && recoveryEpisode?.lastRecoveryAssistedAtMonth !== atMonth;
  const thermalPressure = dependent.conditions
    .filter((condition) => condition.kind === 'cold' || condition.kind === 'heat')
    .sort((a, b) => b.stage - a.stage)[0];
  const hibernationEvidenceEventIds = observedHibernationEntryEvidence(state, dependent);
  const hibernationReady = hibernationEvidenceEventIds.length > 0
    && canEnterDehydratedHibernation(dependent, HIBERNATION_ENTRY_LEGAL_RESERVE);
  const carriedFood = caregiver.inventory.find((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'edible'));
  const dependentCarriedFood = dependent.inventory.find((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'edible'));
  const lacksRecoverySource = (recoveryEpisode?.recoverySourceEventIds?.length ?? 0) === 0;
  const childNeedsFood = !dependentCarriedFood
    && (dependent.body.nutrition < 40
      || Boolean(recoveryEpisode
        && (dependent.body.nutrition < HIBERNATION_RECOVERY_SAFE_RESERVE || lacksRecoverySource)));
  const canProvideCarriedFood = childNeedsFood && Boolean(carriedFood);
  const canCarryInfantToHelp = infant && (dependent.body.hydration < 40
    || dependent.body.nutrition < 40
    || Boolean(thermalPressure));
  if (!together && (hibernationReady || canProvideCarriedFood || canCarryInfantToHelp || needsRecoveryWater)) {
    const path = findStandingPath(state.world.grid, caregiver.position, {
      cellId: dependent.position.cellId,
      z: dependent.position.z,
    });
    if (path.length > 0) return {
      kind: 'move',
      toCellId: dependent.position.cellId,
      toZ: dependent.position.z,
    };
  }

  if (hibernationReady) {
    return {
      kind: 'act', operation: 'dehydrate', targets: [{ kind: 'person', personId: dependent.id }],
      hibernationEvidenceEventIds,
    };
  }

  if (needsRecoveryWater && together) {
    const visible = cellsInRadius(caregiver.position.cellId, visibleRadius(caregiver));
    const water = findReachableWater(state, caregiver, visible);
    if (water) {
      const atBank = caregiver.position.cellId === water.bankPosition.cellId
        && caregiver.position.z === water.bankPosition.z;
      return atBank
        ? { kind: 'act', operation: 'rehydrate', targets: [{ kind: 'person', personId: dependent.id }] }
        : { kind: 'move', toCellId: water.bankPosition.cellId, toZ: water.bankPosition.z };
    }
  }

  if (infant && dependent.body.hydration < 40) {
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

  if (childNeedsFood) {
    if (carriedFood) return {
      kind: 'transfer', materialId: carriedFood.materialId, quantity: 1,
      from: { kind: 'person', personId: caregiver.id }, to: { kind: 'person', personId: dependent.id }, stackId: carriedFood.id,
    };
    const food = infant ? nearestFood(state, caregiver) : null;
    if (food) return caregiver.position.cellId === food.cellId && caregiver.position.z === food.z
      ? { kind: 'transfer', materialId: food.materialId, quantity: 1, from: { kind: 'ground', cellId: food.cellId, z: food.z }, to: { kind: 'person', personId: dependent.id }, dropId: food.id }
      : { kind: 'move', toCellId: food.cellId, toZ: food.z };
    const stored = findCurrentVisibleStoredMaterialAccess(
      state,
      caregiver,
      (stack) => materialHas(stack.materialId, 'edible'),
    );
    if (stored) return retrieveStoredMaterialOrMove(caregiver, stored);
  }

  if (infant && thermalPressure && !options.suppressThermalShelter) {
    const shelter = findReachableShelter(state, caregiver) ?? findReachableShelter(state, dependent);
    if (shelter) return { kind: 'move', toCellId: shelter.position.cellId, toZ: shelter.position.z };
  }

  return null;
}

export function shouldRemainShelteredForDependent(state: SimulationState, caregiver: PersonState): boolean {
  if (!shelterGeometryAt(state.world.grid, caregiver.position)) return false;
  if (caregiver.body.hydration < 45 || caregiver.body.nutrition < 40) return false;
  return coLocatedYoungDependents(state, caregiver).some((dependent) => dependent.conditions.some((condition) => (
    condition.kind === 'cold' || condition.kind === 'heat'
  ) && condition.stage >= 1));
}

export function isInfant(state: SimulationState, person: PersonState, atMonth = state.clock.elapsedMonths): boolean {
  return ageMonths(person, atMonth) < INFANT_MONTHS;
}
