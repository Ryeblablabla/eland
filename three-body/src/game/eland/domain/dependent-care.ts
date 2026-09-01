import type { DependentTransportBasis, PrimitiveAction } from './action';
import { materialHas } from './material';
import type { DecisionAuthorityState, DropState, SimulationState, WorldEvent } from './model';
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
import { compileBoundedWaterSearchMove, findReachableWater, moveTowardWaterAccess } from './water-access';
import { findReachableShelter } from './shelter-access';
import { shelterGeometryAt } from './structure';
import { lifePlanningStage } from './life-stage';
import { cellsInRadius, findStandingPath } from '../world/grid';
import { observedHibernationEntryEvidence } from './hibernation-entry';
import { findCurrentVisibleStoredMaterialAccess, retrieveStoredMaterialOrMove } from './stored-food-access';
import { relationTo } from './relation';
import { intentById } from './state-index';

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

function selectedDependentCareTarget(state: SimulationState, caregiver: PersonState): PersonState | undefined {
  const intent = caregiver.activeIntentId ? intentById(state, caregiver.activeIntentId) : undefined;
  if (!intent
    || intent.ownerId !== caregiver.id
    || intent.status !== 'active'
    || intent.interruptionKind !== 'dependent-care') return undefined;
  const directPersonId = intent.goal.kind === 'near-person' || intent.goal.kind === 'condition'
    ? intent.goal.personId
    : undefined;
  const dependents = dependentChildren(state, caregiver);
  if (directPersonId) return dependents.find((candidate) => candidate.id === directPersonId);
  if (intent.goal.kind === 'at-cell') {
    const targetCellId = intent.goal.cellId;
    return dependents.find((candidate) => candidate.position.cellId === targetCellId);
  }
  return undefined;
}

/**
 * A care trip starts from a locally visible child. Once selected, the child
 * may cross the edge of current perception for one or more route steps; the
 * stored child intent remains the source of that target until it resolves.
 */
function actionableYoungDependents(state: SimulationState, caregiver: PersonState): PersonState[] {
  const selected = selectedDependentCareTarget(state, caregiver);
  return [...new Map([
    ...(selected ? [selected] : []),
    ...visibleYoungDependents(state, caregiver),
  ].map((dependent) => [dependent.id, dependent])).values()];
}

function coLocatedYoungDependents(state: SimulationState, caregiver: PersonState): PersonState[] {
  return dependentChildren(state, caregiver).filter((candidate) => sameLocation(candidate, caregiver));
}

function moveWithDependentTransport(
  state: SimulationState,
  caregiver: PersonState,
  dependent: PersonState,
  action: PrimitiveAction,
  atMonth: number,
  reason: DependentTransportBasis['reason'],
): PrimitiveAction {
  if (action.kind !== 'move'
    || !sameLocation(caregiver, dependent)
    || !isInfant(state, dependent, atMonth)
    || isDormantDehydratedHibernating(dependent)) return action;
  const relevantConditions = dependent.conditions.filter((condition) => (
    reason === 'thermal-shelter'
      ? condition.kind === 'cold' || condition.kind === 'heat'
      : reason === 'hibernation-recovery'
        ? condition.kind === 'dehydrated-hibernation' && hibernationPhase(condition) === 'recovering'
        : false
  ));
  return {
    ...action,
    dependentTransportBasis: {
      version: 'dependent-transport-v1',
      dependentId: dependent.id,
      observedAtMonth: atMonth,
      reason,
      conditionIds: relevantConditions.map((condition) => condition.id).sort(),
      sourceFactIds: [...new Set(relevantConditions.flatMap((condition) => condition.sourceEventIds))].sort(),
    },
  };
}

/**
 * A person's remembered responsibility for biological children. A remote
 * child's objective death cannot release that responsibility until the parent
 * has learned the death through a sourced bereavement. Child age is known from
 * birth history; extra crisis cost is used only when parent and child are
 * co-located, so the decision never reads remote health.
 */
export function reproductiveResponsibility(
  state: Pick<DecisionAuthorityState, 'clock' | 'people'>,
  caregiver: PersonState,
  atMonth = state.clock.elapsedMonths,
): ReproductiveResponsibility {
  const rememberedChildren = state.people
    .filter((candidate) => candidate.geneticParents.includes(caregiver.id)
      && ageMonths(candidate, atMonth) < DEPENDENT_MONTHS);
  const knownChildDeaths = new Map((caregiver.bereavements ?? [])
    .filter((bereavement) => rememberedChildren.some((child) => child.id === bereavement.deceasedPersonId))
    .map((bereavement) => [bereavement.deceasedPersonId, bereavement]));
  const dependents = rememberedChildren
    .filter((candidate) => !knownChildDeaths.has(candidate.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const postpartum = caregiver.conditions.find((condition) => condition.kind === 'postpartum-recovery');
  let pressure = postpartum ? 72 : 0;
  let infantCount = 0;
  const reasons: string[] = postpartum ? ['本人仍处于产后恢复期'] : [];
  const sourceFactIds = new Set(postpartum?.sourceEventIds ?? []);
  const basisKeys: string[] = postpartum
    ? [`postpartum-recovery:stage-${postpartum.stage}`]
    : [];
  for (const child of rememberedChildren.filter((candidate) => knownChildDeaths.has(candidate.id))) {
    const knownDeath = knownChildDeaths.get(child.id);
    basisKeys.push(`dependent-care:${child.id}:known-death`);
    reasons.push(`本人已有来源得知${child.name}死亡，不再把对方计作持续照护责任`);
    knownDeath?.sourceEventIds.forEach((eventId) => sourceFactIds.add(eventId));
  }
  for (const dependent of dependents) {
    const age = ageMonths(dependent, atMonth);
    const ageBand = age < INFANT_MONTHS ? 'infant' : age < 6 * 12 ? 'young-child' : 'older-child';
    const base = ageBand === 'infant' ? 24 : ageBand === 'young-child' ? 14 : 6;
    if (ageBand === 'infant') infantCount += 1;
    pressure += base;
    basisKeys.push(`dependent-care:${dependent.id}:${ageBand}`);
    relationTo(caregiver, dependent.id)
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
  return actionableYoungDependents(state, caregiver)
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
  options: { suppressThermalShelter?: boolean; currentMonthEvents?: readonly WorldEvent[] } = {},
): PrimitiveAction | null {
  const dependent = actionableYoungDependents(state, caregiver)
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
    || (Boolean(thermalPressure)
      && !shelterGeometryAt(state.world.grid, dependent.position)));
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
    // A thawed, flooded, or otherwise invalid target position can remain
    // visible while no standing path exists. Never fall through to a direct
    // transfer/dehydrate/carry action that the executor will reject for lack
    // of proximity; wait for natural displacement or another legal route.
    return null;
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
        : moveWithDependentTransport(
          state,
          caregiver,
          dependent,
          moveTowardWaterAccess(water, atMonth),
          atMonth,
          'hibernation-recovery',
        );
    }
  }

  if (infant && dependent.body.hydration < 40) {
    const visible = cellsInRadius(caregiver.position.cellId, visibleRadius(caregiver));
    const water = findReachableWater(state, caregiver, visible);
    if (water) {
      const atBank = caregiver.position.cellId === water.bankPosition.cellId
        && caregiver.position.z === water.bankPosition.z;
      return atBank
        ? { kind: 'act', operation: 'rehydrate', targets: [{ kind: 'person', personId: dependent.id }] }
        : moveWithDependentTransport(
          state,
          caregiver,
          dependent,
          moveTowardWaterAccess(water, atMonth),
          atMonth,
          'hydration-access',
        );
    }
    if (!water) {
      const search = compileBoundedWaterSearchMove(
        state,
        caregiver,
        dependent.id,
        visible,
        options.currentMonthEvents,
      );
      if (search) return moveWithDependentTransport(
        state,
        caregiver,
        dependent,
        search,
        atMonth,
        'hydration-access',
      );
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
      : moveWithDependentTransport(
        state,
        caregiver,
        dependent,
        { kind: 'move', toCellId: food.cellId, toZ: food.z },
        atMonth,
        'food-access',
      );
    const stored = findCurrentVisibleStoredMaterialAccess(
      state,
      caregiver,
      (stack) => materialHas(stack.materialId, 'edible'),
    );
    if (stored) return moveWithDependentTransport(
      state,
      caregiver,
      dependent,
      retrieveStoredMaterialOrMove(caregiver, stored),
      atMonth,
      'food-access',
    );
  }

  if (infant && thermalPressure && !options.suppressThermalShelter) {
    if (together && shelterGeometryAt(state.world.grid, caregiver.position)) return null;
    if (!together && shelterGeometryAt(state.world.grid, dependent.position)) return null;
    const shelter = findReachableShelter(state, caregiver) ?? findReachableShelter(state, dependent);
    if (shelter) return moveWithDependentTransport(
      state,
      caregiver,
      dependent,
      { kind: 'move', toCellId: shelter.position.cellId, toZ: shelter.position.z },
      atMonth,
      'thermal-shelter',
    );
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
