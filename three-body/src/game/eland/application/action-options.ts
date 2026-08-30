import type { ActionOption, Intent, PrimitiveAction } from '../domain/action';
import { Material, materialDefinition, materialHas } from '../domain/material';
import {
  canEnterDehydratedHibernation,
  HIBERNATION_ENTRY_LEGAL_RESERVE,
  HIBERNATION_PREDICTIVE_ENTRY_RESERVE,
  hibernationPhase,
  inventoryQuantity,
  isAlive,
  sameLocation,
  type PersonState,
} from '../domain/person';
import { ageMonths, MIN_TEACHING_AGE_MONTHS } from '../domain/person';
import type {
  DecisionAuthorityState,
  DecisionContext,
  DropState,
  SimulationState,
} from '../domain/model';
import {
  acceptedExchangeFor,
  exchangeTermFulfilled,
  hasOpenExchangeOfferBetween,
  openExchangeOfferFor,
} from '../domain/social-facts';
import {
  cellsInRadius,
  cellX,
  cellY,
  findStandingPath,
  isPassable,
  nearestCell,
  neighbors4,
  surfaceStandingPosition,
  surfaceMaterial,
  standingPathMovementTicks,
  topPosition,
  topZ,
  voxelAt,
} from '../world/grid';
import { seededFraction } from '../world/generator';
import { buildSocialOptions } from './social-options';
import { PLANNING_TICKS_PER_MONTH } from '../domain/calendar';
import { compileAgreementContinuations } from './agreement-continuation';
import { relationTo } from '../domain/relation';
import { permissionById } from '../domain/permission';
import { buildConstructionOptions } from './construction-options';
import { findReachableWater } from '../domain/water-access';
import { findReachableShelter } from '../domain/shelter-access';
import { mandateById } from '../domain/governance';
import { buildMaterialSeparationOptions } from './separation-options';
import { separationToolFits, voxelSeparationRuleFor } from '../domain/separation-rules';
import { buildContainerOptions, findContainerAccess } from './container-options';
import { canAccessContainer, containerById, containerQuantity } from '../domain/container';
import {
  inventoryNoResponseFactId,
  knowsReliableNoResponse,
  voxelNoResponseFactId,
} from '../domain/interaction-knowledge';
import {
  eraForecastTransitionFacts,
  recentEraForecastEnvironmentFacts,
  worldEventById,
} from '../domain/event-index';
import { animalSpecies, isAnimalAlive, type AnimalState } from '../domain/animal';
import {
  buildProjectOptions,
  recompileProjectNextAction,
} from './project-options';
import {
  buildDemandBoundRecordUseOptions,
  recompileRecordUseNextAction,
} from './record-use-options';
import { cloneProjectForPlanning } from '../domain/project';
import { lifePlanningStage } from '../domain/life-stage';
import { optionAllowedForLearningChildCareRadius, optionAllowedForLifeStage } from './age-planning';
import { followUpSemanticallyMatches, isGroundedConversationOpening } from '../domain/intent-follow-up';
import { agreementById, reproductionAttemptedBetweenInMonth } from '../domain/agreement';
import {
  isActionableChaosPrediction,
  MAX_ERA_PREDICTION_HORIZON_MONTHS,
  personTrustsEraPrediction,
} from '../domain/era-prediction';
import { observedHibernationEntryEvidence } from '../domain/hibernation-entry';
import {
  hasKnowledgeFact,
  intentById,
  knowledgeFactById,
  livingPeople,
  personById,
} from '../domain/state-index';
import {
  buildMechanicalPowerServiceOptions,
  buildWaterCurrentObservationOptions,
} from './mechanical-power-options';
import { buildElectricalPowerServiceOptions } from './electrical-power-service-options';
import { buildElectricalPowerMaintenanceOptions } from './electrical-power-maintenance-options';
import { MECHANICAL_POWER_OPERATION_TECHNIQUE_ID } from '../domain/mechanical-power';
import {
  bestHuntingToolStack,
  bestProductionToolStack,
  isProductionToolMaterial,
  productionToolRank,
  recentPersonalProductionLaborEvents,
} from '../domain/production-tool';
import { knowsDeath, remainsForPerson, type HumanRemainsState } from '../domain/mortuary';
import { buildMortuaryOptions, recompileMortuaryNextAction } from './mortuary-options';
import { techniqueOutputMaterialId } from '../domain/technique-demonstration';
import { canPersonPlanToCollectProjectMaterialDrop } from '../domain/project-material-request';
import { openProjectKnowledgeRequestsFor } from '../domain/project-knowledge-request';
import { productionToolUpgradeTradeCandidate } from './projects/capability-replication';
import {
  conversationalRendezvous,
  crowdingReliefTarget,
  peopleWithinVoiceRange,
  positionsWithinVoiceRange,
} from '../domain/social-space';
import {
  actionOptionSemantics,
  assertClassifiedActionOption,
  classifyActionOption,
  defineActionOptionSemantics,
  isCommitmentActionOption,
  isRequiredResponseOption,
} from '../domain/action-option-semantics';
import { buildCharacterAgendaOptions } from './character-agenda';
import {
  buildFailureRetryContext,
  isCurrentlyBodyBlockedPlacement,
  isFailureRetryCoolingDown,
  optionHasCurrentlyBodyBlockedPlacement,
  type FailureRetryContext,
} from './action-failure-retry';
import { buildReproductionOptions } from './reproduction-options';

export {
  isCurrentlyBodyBlockedPlacement,
  isFailureRetryCoolingDown,
  optionHasCurrentlyBodyBlockedPlacement,
};

function distance(a: number, b: number): number {
  return Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
}

const MAX_LOCAL_INTERACTION_OPTIONS = 3;

export function projectKnowledgeTeachingOpportunity(
  state: SimulationState,
  teacher: PersonState,
  atMonth: number,
) {
  return openProjectKnowledgeRequestsFor(state, teacher, atMonth).flatMap((requested) => {
    if (!positionsWithinVoiceRange(teacher.position, requested.requester.position)
      || ageMonths(requested.requester, atMonth) < MIN_TEACHING_AGE_MONTHS) return [];
    return teacher.knowledge
      .filter((fact) => fact.kind === 'technique'
        && fact.confidence >= 55
        && techniqueOutputMaterialId(fact.id) === requested.request.outputMaterialId)
      .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id))
      .map((fact) => ({ ...requested, fact, learner: requested.requester }));
  })[0];
}

function tangibleInventoryStacks(person: PersonState, excludedStackId?: string): PersonState['inventory'] {
  return person.inventory
    .filter((stack) => {
      const material = materialDefinition(stack.materialId);
      return stack.quantity > 0
        && stack.id !== excludedStackId
        && !stack.recordPayloadId
        && material.phase !== 'gas'
        && material.mass > 0;
    })
    .sort((a, b) => a.materialId - b.materialId || a.id.localeCompare(b.id));
}

function oneStackPerMaterial(stacks: PersonState['inventory']): PersonState['inventory'] {
  const seen = new Set<number>();
  return stacks.filter((stack) => {
    if (seen.has(stack.materialId)) return false;
    seen.add(stack.materialId);
    return true;
  });
}

function materialPairKey(firstMaterialId: number, secondMaterialId: number): string {
  return firstMaterialId <= secondMaterialId
    ? `${firstMaterialId}+${secondMaterialId}`
    : `${secondMaterialId}+${firstMaterialId}`;
}

function inventoryCombinationTechniquePrefix(firstMaterialId: number, secondMaterialId: number): string {
  const first = Math.min(firstMaterialId, secondMaterialId);
  const second = Math.max(firstMaterialId, secondMaterialId);
  const inputKey = first === second ? `${first}x2` : `${first}x1+${second}x1`;
  return `technique:combine-inventory:${inputKey}:`;
}

function knownTechniqueForPrefix(person: PersonState, prefix: string) {
  return person.knowledge.find((fact) => fact.kind === 'technique' && fact.id.startsWith(prefix));
}

function knownTechniqueOutputMaterialId(technique: ReturnType<typeof knownTechniqueForPrefix>): number | undefined {
  if (!technique) return undefined;
  const outputMaterialId = Number(technique.id.split(':').at(-1));
  return Number.isInteger(outputMaterialId) ? outputMaterialId : undefined;
}

/**
 * A knowledge-gain affordance must still be capable of changing knowledge at
 * the moment it enters DecisionContext. In particular, a saturated technique
 * must not keep creating already-achieved, zero-action Intent episodes.
 * `attempt:*` is an execution marker rather than a persisted knowledge fact.
 */
function knowledgeGoalAlreadySatisfied(
  state: SimulationState,
  person: PersonState,
  option: ActionOption,
): boolean {
  const goal = option.goal;
  if (goal.kind !== 'knowledge' || goal.factId.startsWith('attempt:')) return false;
  const owner = goal.personId ? personById(state, goal.personId) : person;
  return Boolean(owner && hasKnowledgeFact(
    owner,
    goal.factId,
    (fact) => fact.confidence >= (goal.minConfidence ?? 0),
  ));
}

export function visibleRadius(person: PersonState): number {
  return 4 + Math.floor(person.baselineCapacities.perception / 25);
}

export function visibleCellsFor(person: PersonState): number[] {
  return cellsInRadius(person.position.cellId, visibleRadius(person));
}

export function cloneMutableProjectsForPlanning(
  projects: SimulationState['projects'],
): SimulationState['projects'] {
  return projects.map((project) => project.status === 'active' ? cloneProjectForPlanning(project) : project);
}

function dropStandingZ(state: SimulationState, drop: DropState): number {
  return Number.isInteger(drop.z)
    ? drop.z
    : surfaceStandingPosition(state.world.grid, drop.cellId)?.z ?? 1;
}

function actionForDrop(state: SimulationState, person: PersonState, drop: DropState): PrimitiveAction {
  const dropZ = dropStandingZ(state, drop);
  const estateRemains = drop.estateOfPersonId ? remainsForPerson(state, drop.estateOfPersonId) : undefined;
  const estateCarePersonId = drop.estateOfPersonId && estateRemains && knowsDeath(person, estateRemains.id)
    ? drop.estateOfPersonId
    : undefined;
  if (person.position.cellId === drop.cellId && person.position.z === dropZ) {
    return {
      kind: 'transfer',
      materialId: drop.materialId,
      quantity: Math.min(3, drop.quantity),
      from: { kind: 'ground', cellId: drop.cellId, z: dropZ },
      to: { kind: 'person', personId: person.id },
      dropId: drop.id,
      ...(estateCarePersonId ? { estateCarePersonId } : {}),
    };
  }
  return { kind: 'move', toCellId: drop.cellId, toZ: dropZ };
}

function optionForDrop(state: SimulationState, person: PersonState, drop: DropState): ActionOption {
  const material = materialDefinition(drop.materialId);
  const current = inventoryQuantity(person, drop.materialId);
  const dropZ = dropStandingZ(state, drop);
  const estateOwner = drop.estateOfPersonId ? personById(state, drop.estateOfPersonId) : undefined;
  const estateRemains = estateOwner ? remainsForPerson(state, estateOwner.id) : undefined;
  const awareEstate = Boolean(estateOwner && estateRemains && knowsDeath(person, estateRemains.id));
  return {
    id: `${awareEstate ? 'estate' : 'collect'}:${drop.id}`,
    summary: awareEstate ? `收拢${estateOwner?.name}留下的${material.name}` : `取得${material.name}`,
    reason: awareEstate ? `本人知道${estateOwner?.name}已经死亡，并看见其有来源的遗物` : `看见地上的${material.name}`,
    goal: { kind: 'inventory-at-least', materialId: drop.materialId, quantity: current + Math.min(3, drop.quantity) },
    nextAction: actionForDrop(state, person, drop),
    target: { kind: 'drop', dropId: drop.id },
    estimatedDuration: person.position.cellId === drop.cellId && person.position.z === dropZ ? 'one-month' : 'several-months',
    sourceFactIds: drop.sourceEventIds,
    semantics: defineActionOptionSemantics(awareEstate
      ? {
          purpose: 'mortuary-care',
          minimumLifeStage: 'learning-child',
          needKinds: ['bereavement'],
        }
      : {
          purpose: 'resource',
          minimumLifeStage: 'learning-child',
          needKinds: ['reserve'],
        }),
  };
}

function withPlanning(
  state: SimulationState,
  person: PersonState,
  option: ActionOption,
  atMonth: number,
  failureRetryContext: FailureRetryContext,
  pathCache: Map<string, ReturnType<typeof findStandingPath>>,
): ActionOption | null {
  if (isFailureRetryCoolingDown(state, person, option, atMonth, failureRetryContext)) return null;
  let plannedOption = option;
  if (option.nextAction.kind === 'communicate'
    && option.nextAction.channel === 'voice'
    && option.nextAction.content.kind !== 'prediction'
    && option.target?.kind === 'person') {
    const target = personById(state, option.target.personId);
    if (!target || !isAlive(target)) return null;
    if (!positionsWithinVoiceRange(person.position, target.position)) {
      const rendezvous = conversationalRendezvous(state, person, target);
      if (!rendezvous) return null;
      plannedOption = {
        ...option,
        nextAction: {
          kind: 'move',
          toCellId: rendezvous.position.cellId,
          toZ: rendezvous.position.z,
        },
        completionAction: option.nextAction,
      };
    }
  } else if (option.nextAction.kind === 'move'
    && option.completionAction?.kind === 'communicate'
    && option.target?.kind === 'person') {
    const target = personById(state, option.target.personId);
    if (!target || !isAlive(target)) return null;
    const rendezvous = conversationalRendezvous(state, person, target);
    if (!rendezvous) return null;
    if (positionsWithinVoiceRange(person.position, target.position)) {
      const { completionAction, ...withoutCompletion } = option;
      plannedOption = { ...withoutCompletion, nextAction: completionAction };
    } else plannedOption = {
      ...option,
      nextAction: {
        kind: 'move',
        toCellId: rendezvous.position.cellId,
        toZ: rendezvous.position.z,
      },
    };
  }
  if (optionHasCurrentlyBodyBlockedPlacement(state, person, plannedOption)) return null;
  let estimatedMonths = 1;
  if (plannedOption.nextAction.kind === 'move') {
    const cacheKey = `${plannedOption.nextAction.toCellId}:${plannedOption.nextAction.toZ ?? ''}`;
    let path = pathCache.get(cacheKey);
    if (!path) {
      path = findStandingPath(state.world.grid, person.position, {
        cellId: plannedOption.nextAction.toCellId,
        ...(plannedOption.nextAction.toZ !== undefined ? { z: plannedOption.nextAction.toZ } : {}),
      });
      pathCache.set(cacheKey, path);
    }
    if (!path.length) return null;
    estimatedMonths = Math.max(1, Math.ceil(standingPathMovementTicks(state.world.grid, path) / PLANNING_TICKS_PER_MONTH));
  }
  const risks: string[] = [];
  if (person.body.hydration - estimatedMonths * 1.6 < 18) risks.push('途中可能脱水');
  if (person.body.nutrition - estimatedMonths * 1.5 < 18) risks.push('途中可能饥饿');
  const inferredDomain = option.nextAction.kind === 'communicate' || option.target?.kind === 'person' || option.goal.kind === 'near-person'
    ? 'social'
    : 'strategic';
  return {
    ...plannedOption,
    domain: plannedOption.domain ?? inferredDomain,
    estimatedDuration: plannedOption.nextAction.kind === 'move'
      ? estimatedMonths <= 1 ? 'one-month' : 'several-months'
      : plannedOption.estimatedDuration,
    estimatedMonths,
    risks,
  };
}

function decisionOptionPriority(option: ActionOption): number {
  if (isRequiredResponseOption(option)) return 0;
  if (isCommitmentActionOption(option)) return 1;
  return option.domain === 'strategic' ? 2 : 3;
}

export function isObservedEmergencyHibernationOption(
  state: Pick<DecisionAuthorityState, 'civilization' | 'world'>,
  person: PersonState,
  option: ActionOption,
): boolean {
  if (option.nextAction.kind !== 'act'
    || option.nextAction.operation !== 'dehydrate'
    || option.nextAction.hibernationPredictionId !== undefined) return false;
  const resolvableEvidenceIds = new Set(observedHibernationEntryEvidence(state, person));
  return (option.nextAction.hibernationEvidenceEventIds ?? [])
    .some((eventId) => resolvableEvidenceIds.has(eventId));
}

function localPeopleWithDifferentGoods(person: PersonState, people: PersonState[]) {
  const currentProductionToolRank = productionToolRank(bestProductionToolStack(person)?.materialId ?? Material.Air);
  return people.flatMap((other) => {
    if (!sameLocation(other, person)) return [];
    const own = person.inventory.find((stack) => stack.quantity >= 2 && !other.inventory.some((item) => item.materialId === stack.materialId));
    const their = other.inventory.find((stack) => stack.quantity >= 2
      && !person.inventory.some((item) => item.materialId === stack.materialId)
      && productionToolRank(stack.materialId) <= currentProductionToolRank);
    return own && their ? [{ person: other, own, their }] : [];
  });
}

function betterGroundProductionTool(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
): { drop: DropState; pathLength: number } | undefined {
  const currentRank = productionToolRank(bestProductionToolStack(person)?.materialId ?? Material.Air);
  return visibleDrops
    .filter((drop) => drop.quantity > 0
      && isProductionToolMaterial(drop.materialId)
      && productionToolRank(drop.materialId) > currentRank)
    .map((drop) => ({
      drop,
      pathLength: findStandingPath(state.world.grid, person.position, { cellId: drop.cellId, z: drop.z }).length,
    }))
    .filter((candidate) => candidate.pathLength > 0)
    .sort((left, right) => productionToolRank(right.drop.materialId) - productionToolRank(left.drop.materialId)
      || left.pathLength - right.pathLength
      || left.drop.id.localeCompare(right.drop.id))[0];
}

function acceptedExchangeAt(state: SimulationState, person: PersonState, atMonth: number) {
  const exchange = acceptedExchangeFor(state, person.id, atMonth);
  const agreementId = exchange?.offer.action.kind === 'communicate'
    ? exchange.offer.action.content.id
    : undefined;
  const agreement = agreementId ? agreementById(state, agreementId) : undefined;
  return exchange
    && agreement
    && (agreement.acceptedAtMonth ?? Number.POSITIVE_INFINITY) <= atMonth
    && (agreement.dueAtMonth ?? Number.NEGATIVE_INFINITY) >= atMonth
    ? exchange
    : null;
}

function nextFirePosition(state: SimulationState, person: PersonState): { x: number; y: number; z: number } | null {
  const occupied = new Set(livingPeople(state).map((candidate) => candidate.position.cellId));
  const targetCell = neighbors4(person.position.cellId)
    .filter((cellId) => {
      const surface = surfaceMaterial(state.world.grid, cellId);
      return surface !== Material.Air && surface !== Material.Water && surface !== Material.Fire && !occupied.has(cellId);
    })
    .sort((a, b) => a - b)
    .find((cellId) => {
      const z = topZ(state.world.grid, cellId) + 1;
      return z >= 0 && z < state.world.grid.levels && voxelAt(state.world.grid, cellX(cellId), cellY(cellId), z) === Material.Air;
    });
  if (targetCell === undefined) return null;
  return { x: cellX(targetCell), y: cellY(targetCell), z: topZ(state.world.grid, targetCell) + 1 };
}

function buildOptions(
  state: SimulationState,
  person: PersonState,
  visibleCells: number[],
  visibleDrops: DropState[],
  visiblePeople: PersonState[],
  visibleAnimals: AnimalState[],
  visibleRemains: HumanRemainsState[],
  atMonth: number,
): ActionOption[] {
  const options: ActionOption[] = [];
  options.push(...buildMortuaryOptions(state, person, visibleRemains));
  const planningStage = lifePlanningStage(person, atMonth);
  if (planningStage === 'learning-child') {
    const visibleParent = visiblePeople.find((candidate) => person.geneticParents.includes(candidate.id));
    if (visibleParent && !sameLocation(visibleParent, person)) options.push({
      id: `follow-parent:${visibleParent.id}`,
      summary: `跟随${visibleParent.name}`,
      reason: '仍处于跟随学习阶段，优先回到可见亲代身边再进行取水、采集与简单劳动',
      goal: { kind: 'near-person', personId: visibleParent.id },
      nextAction: { kind: 'move', toCellId: visibleParent.position.cellId, toZ: visibleParent.position.z },
      target: { kind: 'person', personId: visibleParent.id },
      estimatedDuration: 'several-months',
      sourceFactIds: relationTo(person, visibleParent.id)?.sourceEventIds ?? [],
    });
  }
  const visible = new Set(visibleCells);
  const localPeople = visiblePeople.filter((other) => sameLocation(other, person));
  const conversationalPeople = peopleWithinVoiceRange(person, visiblePeople);
  const crowdingRelief = planningStage === 'adult' ? crowdingReliefTarget(state, person) : null;
  if (crowdingRelief) options.push({
    id: `relieve-crowding:${crowdingRelief.position.cellId}:${crowdingRelief.position.z}`,
    summary: '挪到旁边较空的位置',
    reason: '当前位置挤着太多人，附近有能够站立且更宽松的空位',
    goal: { kind: 'at-cell', cellId: crowdingRelief.position.cellId },
    nextAction: {
      kind: 'move',
      toCellId: crowdingRelief.position.cellId,
      toZ: crowdingRelief.position.z,
    },
    estimatedDuration: 'one-month',
    sourceFactIds: [],
    semantics: defineActionOptionSemantics({
      purpose: 'spatial-comfort',
      minimumLifeStage: 'adult',
      needKinds: ['spatial-comfort'],
    }),
  });
  const foodStack = person.inventory.find((stack) => materialHas(stack.materialId, 'edible') && stack.quantity > 0);
  if (foodStack && person.body.nutrition < 88) options.push({
    id: `eat:${foodStack.id}`,
    summary: `食用${materialDefinition(foodStack.materialId).name}`,
    reason: '背包里有可食物质',
    goal: { kind: 'body-at-least', field: 'nutrition', value: Math.min(100, person.body.nutrition + 35) },
    nextAction: { kind: 'act', operation: 'ingest', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: foodStack.id }] },
    estimatedDuration: 'one-month',
    sourceFactIds: foodStack.sourceEventIds,
  });

  const water = findReachableWater(state, person, visible);
  if (water && person.body.hydration < 90) {
    const atBank = person.position.cellId === water.bankPosition.cellId && person.position.z === water.bankPosition.z;
    options.push({
      id: `drink:${water.waterPosition.x}:${water.waterPosition.y}:${water.waterPosition.z}`,
      summary: '接近并饮用地表水',
      reason: water.remembered ? '记得一处仍存在且可以走到的水源' : '看见邻近地表水',
      goal: { kind: 'body-at-least', field: 'hydration', value: Math.min(100, person.body.hydration + 45) },
      nextAction: atBank
        ? { kind: 'act', operation: 'ingest', targets: [{ kind: 'voxel', position: water.waterPosition }] }
        : { kind: 'move', toCellId: water.bankPosition.cellId, toZ: water.bankPosition.z },
      estimatedDuration: atBank ? 'one-month' : 'several-months',
      sourceFactIds: water.sourceEventIds,
    });
  }

  // A conscious helper acts from present local facts; an era transition is not
  // a physical prerequisite for rehydrating someone who entered sleep early.
  const localSleepers = localPeople.filter((other) => other.conditions.some((condition) => condition.kind === 'dehydrated-hibernation'
    && hibernationPhase(condition) === 'dormant'));
  const localRehydrationMaterial = cellsInRadius(person.position.cellId, 2)
    .map((cell) => surfaceMaterial(state.world.grid, cell))
    .find((materialId) => materialHas(materialId, 'drinkable'));
  if (state.civilization.epoch === 'stable' && localRehydrationMaterial !== undefined && localSleepers.length) {
    const wake = localSleepers.flatMap((sleeper) => {
      const hibernation = sleeper.conditions.find((condition) => condition.kind === 'dehydrated-hibernation');
      if (!hibernation) return [];
      const triggerPrediction = hibernation.triggerPredictionId
        ? state.eraPredictions.find((prediction) => prediction.id === hibernation.triggerPredictionId)
        : undefined;
      const predictionStillPending = Boolean(triggerPrediction
        && triggerPrediction.status === 'pending'
        && atMonth <= triggerPrediction.expiresAtMonth);
      const bodyEmergency = sleeper.body.health < 35
        || sleeper.body.hydration < 28
        || sleeper.body.nutrition < 28;
      const helperTrustsPrediction = Boolean(triggerPrediction
        && personTrustsEraPrediction(state, person, triggerPrediction));
      const priorDisputedWake = (hibernation.wakeDisputeEventIds?.length ?? 0) > 0;
      if (predictionStillPending && !bodyEmergency && (helperTrustsPrediction || priorDisputedWake)) return [];
      const wakeBasis = bodyEmergency
        ? 'body-emergency' as const
        : predictionStillPending
          ? 'disputed-pending-prediction' as const
          : triggerPrediction?.status === 'incorrect'
            ? 'prediction-invalidated' as const
            : triggerPrediction?.status === 'correct'
              ? 'post-chaos-recovery' as const
              : 'unbound-stable-recovery' as const;
      const reason = wakeBasis === 'body-emergency'
        ? `${sleeper.name}的身体储备已经危及继续休眠`
        : wakeBasis === 'disputed-pending-prediction'
          ? `本人不相信支撑${sleeper.name}休眠的预言，决定承担提前唤醒的后果`
          : wakeBasis === 'prediction-invalidated'
            ? `支撑${sleeper.name}休眠的预言已经失误`
            : wakeBasis === 'post-chaos-recovery'
              ? '乱纪元已经过去，环境重新稳定'
              : `环境稳定，身边的${materialDefinition(localRehydrationMaterial).name}可以使休眠者重新水化`;
      return [{ sleeper, hibernation, triggerPrediction, wakeBasis, reason }];
    })[0];
    if (wake) options.push({
      id: `rehydrate:${wake.sleeper.id}:${atMonth}`,
      summary: `使${wake.sleeper.name}重新水化苏醒`,
      reason: wake.reason,
      goal: {
        kind: 'condition', personId: wake.sleeper.id, condition: 'dehydrated-hibernation', present: true, phase: 'recovering',
      },
      nextAction: {
        kind: 'act', operation: 'rehydrate', targets: [{ kind: 'person', personId: wake.sleeper.id }],
        ...(wake.triggerPrediction ? { hibernationPredictionId: wake.triggerPrediction.id } : {}),
        hibernationWakeBasis: wake.wakeBasis,
      },
      target: { kind: 'person', personId: wake.sleeper.id },
      estimatedDuration: 'one-month',
      sourceFactIds: [...new Set([
        ...wake.hibernation.sourceEventIds,
        ...(wake.triggerPrediction?.sourceEventIds ?? []),
      ])],
    });
  }

  const predictionsAboutChaos = state.eraPredictions
    .filter((prediction) => isActionableChaosPrediction(prediction, atMonth))
    .sort((a, b) => a.predictedStartMonth - b.predictedStartMonth || a.id.localeCompare(b.id));
  const trustedChaosPrediction = predictionsAboutChaos.find((prediction) => (
    personTrustsEraPrediction(state, person, prediction)
  ));
  const observedExposureSourceIds = observedHibernationEntryEvidence(state, person);
  const canEnterObservedEmergency = observedExposureSourceIds.length > 0
    && canEnterDehydratedHibernation(person, HIBERNATION_ENTRY_LEGAL_RESERVE);
  const canEnterPrediction = !canEnterObservedEmergency
    && Boolean(trustedChaosPrediction)
    && canEnterDehydratedHibernation(person, HIBERNATION_PREDICTIVE_ENTRY_RESERVE);
  const hibernationTriggerPrediction = canEnterPrediction ? trustedChaosPrediction : undefined;
  if (canEnterObservedEmergency || hibernationTriggerPrediction) {
    options.push({
      id: `dehydrate-chaos:${hibernationTriggerPrediction?.id ?? `observed-${state.civilization.era.sequence}`}`,
      summary: '主动进入脱水休眠',
      reason: hibernationTriggerPrediction
        ? '一项自己相信的预言指向即将到来的乱纪元'
        : '乱纪元已在造成强烈环境压力',
      goal: { kind: 'condition', personId: person.id, condition: 'dehydrated-hibernation', present: true },
      nextAction: {
        kind: 'act', operation: 'dehydrate', targets: [{ kind: 'person', personId: person.id }],
        ...(hibernationTriggerPrediction ? { hibernationPredictionId: hibernationTriggerPrediction.id } : {}),
        ...(observedExposureSourceIds.length ? {
          hibernationEvidenceEventIds: [...new Set(observedExposureSourceIds)],
        } : {}),
      },
      target: { kind: 'person', personId: person.id },
      estimatedDuration: 'one-month',
      sourceFactIds: hibernationTriggerPrediction?.sourceEventIds ?? [...new Set(observedExposureSourceIds)],
      domain: 'strategic',
    });
  }

  const forecastCapacity = person.baselineCapacities.cognition + person.baselineCapacities.perception;
  const existingForecast = state.eraPredictions.some((prediction) => prediction.predictorId === person.id && prediction.status === 'pending');
  const recentForecast = state.eraPredictions.some((prediction) => prediction.predictorId === person.id && atMonth - prediction.madeAtMonth < 6);
  const predictionAudience = visiblePeople.slice(0, 4);
  if (predictionAudience.length && forecastCapacity >= 118 && !existingForecast && !recentForecast) {
    const skill = forecastCapacity / 2;
    const uncertainty = Math.max(3, Math.round(17 - (skill - 42) * 0.22));
    const noise = Math.round((seededFraction(state.seed, `era-forecast:${atMonth}:${person.id}:${state.civilization.era.sequence}`) * 2 - 1) * uncertainty);
    const transitions = eraForecastTransitionFacts(state)
      .sort((left, right) => left.atMonth - right.atMonth || left.id.localeCompare(right.id));
    const completedDurations = transitions.slice(1).flatMap((event, index) => {
      const previous = transitions[index];
      const previousEpoch = previous.diff.epoch;
      return previousEpoch === state.civilization.epoch ? [event.atMonth - previous.atMonth] : [];
    }).filter((duration) => duration >= 2);
    const estimatedDuration = completedDurations.length
      ? [...completedDurations].sort((left, right) => left - right)[Math.floor(completedDurations.length / 2)]
      : 8 + Math.round(seededFraction(state.seed, `first-era-duration-belief:${person.id}:${state.civilization.epoch}`) * 12);
    const historicalEstimate = state.civilization.era.sinceMonth + estimatedDuration + noise;
    const predictedStartMonth = Math.max(atMonth + 2, historicalEstimate);
    const targetEpoch = state.civilization.epoch === 'stable' ? 'chaotic' as const : 'stable' as const;
    const representationId = `predict-era:${atMonth}:${person.id}:${state.civilization.era.sequence}`;
    if (predictedStartMonth <= atMonth + MAX_ERA_PREDICTION_HORIZON_MONTHS) options.push({
      id: representationId,
      summary: `预言第 ${predictedStartMonth} 月前后将进入${targetEpoch === 'chaotic' ? '乱纪元' : '恒纪元'}`,
      reason: '对天象、气温和过去纪元节律的观察可以形成一项有误差的预测',
      goal: { kind: 'representation-made', representationId },
      nextAction: {
        kind: 'communicate',
        content: {
          id: representationId,
          kind: 'prediction',
          summary: `预言第 ${predictedStartMonth} 月前后将进入${targetEpoch === 'chaotic' ? '乱纪元' : '恒纪元'}`,
          prediction: {
            targetEpoch,
            predictedStartMonth,
            toleranceMonths: 3,
            expiresAtMonth: predictedStartMonth + 3,
          },
        },
        audience: predictionAudience.map((listener) => listener.id),
        channel: 'voice',
      },
      estimatedDuration: 'one-month',
      sourceFactIds: recentEraForecastEnvironmentFacts(state, 8)
        .map((event) => event.id),
      domain: 'strategic',
    });
  }

  const thermalPressure = person.conditions
    .filter((condition) => condition.kind === 'cold' || condition.kind === 'heat')
    .sort((a, b) => b.stage - a.stage)[0];
  const hostileClimate = state.civilization.climate.kind === 'cold'
    || state.civilization.climate.kind === 'heat'
    || state.civilization.climate.kind === 'fire';
  if (thermalPressure || hostileClimate) {
    const shelter = findReachableShelter(state, person, visible);
    if (shelter) options.push({
      id: `shelter:${shelter.structureId}:${shelter.position.cellId}:${shelter.position.z}`,
      summary: '进入可用住所躲避环境压力',
      reason: thermalPressure
        ? `${thermalPressure.kind === 'cold' ? '寒冷' : '炎热'}状态已经影响身体`
        : `当前${state.civilization.climate.kind === 'cold' ? '寒冷' : state.civilization.climate.kind === 'heat' ? '炎热' : '烈火'}环境会持续消耗身体`,
      goal: { kind: 'sheltered' },
      nextAction: { kind: 'move', toCellId: shelter.position.cellId, toZ: shelter.position.z },
      estimatedDuration: shelter.pathLength <= 2 ? 'one-month' : 'several-months',
      sourceFactIds: shelter.sourceEventIds,
    });
  }

  const recentProductionLabor = recentPersonalProductionLaborEvents(state, person.id, atMonth);
  const groundToolUpgrade = recentProductionLabor.length
    ? betterGroundProductionTool(
        state,
        person,
        visibleDrops.filter((drop) => canPersonPlanToCollectProjectMaterialDrop(state, person.id, drop, atMonth)),
      )
    : undefined;
  if (groundToolUpgrade) {
    const drop = groundToolUpgrade.drop;
    const material = materialDefinition(drop.materialId);
    options.push({
      id: `adopt-production-tool:${drop.id}`,
      summary: `取得更高效的${material.name}`,
      reason: `本人近期完成过真实生产劳动，并看见可达的${material.name}能替代当前较低效工具`,
      goal: {
        kind: 'inventory-at-least',
        materialId: drop.materialId,
        quantity: inventoryQuantity(person, drop.materialId) + 1,
      },
      nextAction: actionForDrop(state, person, drop),
      target: { kind: 'drop', dropId: drop.id },
      estimatedDuration: groundToolUpgrade.pathLength <= 1 ? 'one-month' : 'several-months',
      sourceFactIds: [...recentProductionLabor.map((event) => event.id), ...drop.sourceEventIds],
      domain: 'strategic',
    });
  }

  const nearestDropsByMaterial = new Map<number, DropState>();
  for (const drop of [...visibleDrops].sort((a, b) => distance(person.position.cellId, a.cellId) - distance(person.position.cellId, b.cellId) || a.id.localeCompare(b.id))) {
    if (drop.id === groundToolUpgrade?.drop.id) continue;
    if (!canPersonPlanToCollectProjectMaterialDrop(state, person.id, drop, atMonth)) continue;
    if (!nearestDropsByMaterial.has(drop.materialId)) nearestDropsByMaterial.set(drop.materialId, drop);
  }
  for (const drop of [...nearestDropsByMaterial.values()].slice(0, 8)) {
    options.push(optionForDrop(state, person, drop));
  }

  const huntingTool = bestHuntingToolStack(person);
  const nearbyAnimals = [...visibleAnimals]
    .filter(isAnimalAlive)
    .sort((a, b) => distance(person.position.cellId, a.position.cellId) - distance(person.position.cellId, b.position.cellId) || a.id.localeCompare(b.id));
  for (const animal of nearbyAnimals.slice(0, 3)) {
    const species = animalSpecies(animal.speciesId);
    const together = person.position.cellId === animal.position.cellId && person.position.z === animal.position.z;
    options.push({
      id: `hunt:${animal.id}`,
      summary: `追踪并捕猎${species.name}`,
      reason: species.diet === 'predator'
        ? '附近的捕食动物可能伤害人类，也可提供肉、皮与骨'
        : person.body.nutrition < 62 ? '食物储备不高，眼前动物可以成为新的食物来源' : '动物可以提供尚未掌握的肉、皮与骨',
      goal: { kind: 'inventory-at-least', materialId: Material.RawMeat, quantity: inventoryQuantity(person, Material.RawMeat) + 1 },
      nextAction: together
        ? { kind: 'act', operation: 'hunt', targets: [{ kind: 'animal', animalId: animal.id }], ...(huntingTool ? { toolStackId: huntingTool.id } : {}) }
        : { kind: 'move', toCellId: animal.position.cellId, toZ: animal.position.z },
      target: { kind: 'animal', animalId: animal.id },
      estimatedDuration: together ? 'one-month' : 'several-months',
      sourceFactIds: [],
      risks: species.aggression > 0 ? ['动物可能反击'] : [],
    });
  }
  const unknownAnimal = nearbyAnimals.find((animal) => !hasKnowledgeFact(person, `animal:${animal.speciesId}`));
  if (unknownAnimal) options.push({
    id: `attend-animal:${unknownAnimal.id}`,
    summary: `持续观察${animalSpecies(unknownAnimal.speciesId).name}`,
    reason: '这种活体的行为还没有形成可靠认识',
    goal: { kind: 'knowledge', factId: `animal:${unknownAnimal.speciesId}` },
    nextAction: { kind: 'attend', target: { kind: 'animal', animalId: unknownAnimal.id } },
    target: { kind: 'animal', animalId: unknownAnimal.id },
    estimatedDuration: 'one-month',
    sourceFactIds: [],
  });

  options.push(...buildMaterialSeparationOptions(state, person, visibleCells));
  options.push(...buildContainerOptions(state, person, visibleCells));

  const productionTool = bestProductionToolStack(person);

  for (const cellId of visibleCells) {
    const surface = surfaceMaterial(state.world.grid, cellId);
    const position = topPosition(state.world.grid, cellId);
    if (surface === Material.Wood || surface === Material.Leaves) {
      const standCell = nearestCell(person.position.cellId, neighbors4(cellId).filter((id) => isPassable(state.world.grid, id)));
      if (standCell !== null) options.push({
        id: `separate:wood:${cellId}`,
        summary: '从树木取得木材',
        reason: '看见可以分离的树木物质',
        goal: { kind: 'inventory-at-least', materialId: Material.Wood, quantity: inventoryQuantity(person, Material.Wood) + 2 },
        nextAction: person.position.cellId === standCell
          ? { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position }], ...(productionTool ? { toolStackId: productionTool.id } : {}) }
          : { kind: 'move', toCellId: standCell },
        target: { kind: 'voxel', position },
        estimatedDuration: 'several-months',
        sourceFactIds: [],
        semantics: defineActionOptionSemantics({
          purpose: 'resource', minimumLifeStage: 'learning-child', needKinds: ['reserve', 'capability'],
        }),
      });
    }
    if (surface === Material.CropMature || surface === Material.BerryBush) options.push({
      id: `harvest:${cellId}`,
      summary: surface === Material.CropMature ? '分离成熟作物' : '从结果灌木分离食物与种子',
      reason: surface === Material.CropMature ? '看见已经成熟的作物物质' : '看见结出可分离食物的灌木物质',
      goal: { kind: 'inventory-at-least', materialId: Material.Food, quantity: inventoryQuantity(person, Material.Food) + 2 },
      nextAction: person.position.cellId === cellId
        ? { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position }], ...(productionTool ? { toolStackId: productionTool.id } : {}) }
        : { kind: 'move', toCellId: cellId },
      target: { kind: 'voxel', position },
      estimatedDuration: 'several-months',
      sourceFactIds: [],
      semantics: defineActionOptionSemantics({
        purpose: 'resource', minimumLifeStage: 'learning-child', needKinds: ['reserve'],
      }),
    });
  }

  const combinableStacks = tangibleInventoryStacks(person);
  const inventoryTrials: Array<{
    first: typeof combinableStacks[number];
    second: typeof combinableStacks[number];
    materialKey: string;
  }> = [];
  const seenInventoryTrialKeys = new Set<string>();
  for (let firstIndex = 0; firstIndex < combinableStacks.length; firstIndex += 1) {
    for (let secondIndex = firstIndex; secondIndex < combinableStacks.length; secondIndex += 1) {
      const first = combinableStacks[firstIndex];
      const second = combinableStacks[secondIndex];
      if (first.id === second.id && first.quantity < 2) continue;
      const materialKey = materialPairKey(first.materialId, second.materialId);
      if (seenInventoryTrialKeys.has(materialKey)) continue;
      seenInventoryTrialKeys.add(materialKey);
      inventoryTrials.push({ first, second, materialKey });
    }
  }
  for (const { first, second, known } of inventoryTrials
    .filter(({ first, second }) => !knowsReliableNoResponse(person, inventoryNoResponseFactId([first.materialId, second.materialId])))
    .map((trial) => ({
      ...trial,
      known: knownTechniqueForPrefix(person, inventoryCombinationTechniquePrefix(trial.first.materialId, trial.second.materialId)),
      stableRank: seededFraction(state.seed, `ordinary-inventory-combine:${person.id}:${trial.materialKey}`),
    }))
    // A verified facility recipe is a legal project step, not a permanent
    // free-form hobby. Repeating it here makes people fill their backpacks with
    // granaries, kilns, and other public facilities after the need is solved.
    .filter(({ known }) => {
      const outputMaterialId = knownTechniqueOutputMaterialId(known);
      return outputMaterialId === undefined || !materialHas(outputMaterialId, 'facility');
    })
    .sort((a, b) => (a.known ? 0 : 1) - (b.known ? 0 : 1)
      || a.stableRank - b.stableRank
      || a.materialKey.localeCompare(b.materialKey)
      || a.first.id.localeCompare(b.first.id)
      || a.second.id.localeCompare(b.second.id))
    .slice(0, MAX_LOCAL_INTERACTION_OPTIONS)) {
    const trialId = `${known ? 'repeat-inventory-combine' : 'try-inventory-combine'}:${first.id}:${second.id}`;
    options.push({
      id: trialId,
      summary: known ? `尝试复现“${known.summary}”` : `尝试结合${materialDefinition(first.materialId).name}与${materialDefinition(second.materialId).name}`,
      reason: known ? '自己已有这项物质经验' : '背包中的两种物质可以尝试局部结合，但结果未知',
      goal: { kind: 'knowledge', factId: `attempt:${trialId}:${atMonth}` },
      nextAction: {
        kind: 'act', operation: 'combine',
        targets: [
          { kind: 'inventory-stack', personId: person.id, stackId: first.id },
          { kind: 'inventory-stack', personId: person.id, stackId: second.id },
        ],
      },
      estimatedDuration: 'one-month',
      sourceFactIds: [...new Set([...first.sourceEventIds, ...second.sourceEventIds, ...(known?.sourceEventIds ?? [])])],
    });
  }

  const stoneTool = tangibleInventoryStacks(person).find((stack) => stack.materialId === Material.StoneTool);
  const exertPosition = stoneTool ? nextFirePosition(state, person) : null;
  if (stoneTool && exertPosition) {
    const exertInputs = oneStackPerMaterial(tangibleInventoryStacks(person, stoneTool.id))
      .filter((input) => !knowsReliableNoResponse(person, voxelNoResponseFactId('exert', input.materialId, Material.Air, stoneTool.materialId)))
      .map((input) => ({
        input,
        known: knownTechniqueForPrefix(person, `technique:exert:${stoneTool.materialId}:${input.materialId}:${Material.Air}:`),
        stableRank: seededFraction(state.seed, `ordinary-exert:${person.id}:${stoneTool.materialId}:${input.materialId}`),
      }))
      .sort((a, b) => (a.known ? 0 : 1) - (b.known ? 0 : 1)
        || a.stableRank - b.stableRank
        || a.input.materialId - b.input.materialId
        || a.input.id.localeCompare(b.input.id))
      .slice(0, MAX_LOCAL_INTERACTION_OPTIONS);
    for (const { input, known } of exertInputs) {
      options.push({
        id: `${known ? 'repeat-exert' : 'try-exert'}:${stoneTool.id}:${input.id}:${exertPosition.x}:${exertPosition.y}:${exertPosition.z}`,
        summary: known ? `尝试复现“${known.summary}”` : `尝试用石制工具向${materialDefinition(input.materialId).name}施力`,
        reason: known ? '自己已有这项物质经验' : `手中的硬质工具与${materialDefinition(input.materialId).name}可以进行局部施力尝试，但结果未知`,
        goal: known
          ? { kind: 'knowledge', factId: known.id, minConfidence: Math.min(100, known.confidence + 18) }
          : { kind: 'knowledge', factId: `attempt:exert:${atMonth}:${person.id}:${input.id}` },
        nextAction: {
          kind: 'act', operation: 'exert', toolStackId: stoneTool.id,
          targets: [
            { kind: 'inventory-stack', personId: person.id, stackId: input.id },
            { kind: 'voxel', position: exertPosition },
          ],
        },
        target: { kind: 'voxel', position: exertPosition },
        estimatedDuration: 'one-month',
        sourceFactIds: [...new Set([...stoneTool.sourceEventIds, ...input.sourceEventIds, ...(known?.sourceEventIds ?? [])])],
      });
    }
  }

  const blankRecord = person.inventory.find((stack) => stack.materialId === Material.WoodTablet && !stack.recordPayloadId && stack.quantity > 0);
  const recordableKnowledge = person.knowledge
    .filter((fact) => fact.kind !== 'codebook'
      && fact.confidence >= 55
      && !state.records.some((record) => record.authorId === person.id && record.knowledgeId === fact.id))
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))[0];
  if (blankRecord && recordableKnowledge) {
    const representationId = `write-record:${atMonth}:${person.id}:${recordableKnowledge.id}`;
    options.push({
      id: representationId,
      summary: `把已核验知识刻写到木制记录板`,
      reason: '持有空白实体载体，可以让个人知识在记忆之外持续存在',
      goal: { kind: 'representation-made', representationId },
      nextAction: { kind: 'communicate', content: { id: representationId, kind: 'claim', summary: recordableKnowledge.summary, factId: recordableKnowledge.id }, audience: [], channel: 'record', carrierStackId: blankRecord.id },
      target: { kind: 'inventory-stack', personId: person.id, stackId: blankRecord.id },
      estimatedDuration: 'one-month', sourceFactIds: [...recordableKnowledge.sourceEventIds, ...blankRecord.sourceEventIds],
      domain: 'strategic',
    });
  }

  const nearbyFireCell = cellsInRadius(person.position.cellId, 1)
    .filter((cellId) => materialHas(surfaceMaterial(state.world.grid, cellId), 'hot'))
    .sort((a, b) => distance(person.position.cellId, a) - distance(person.position.cellId, b) || a - b)[0];
  if (nearbyFireCell !== undefined) {
    const position = topPosition(state.world.grid, nearbyFireCell);
    const hotMaterialId = surfaceMaterial(state.world.grid, nearbyFireCell);
    const exposureInputs = oneStackPerMaterial(tangibleInventoryStacks(person))
      .filter((input) => !knowsReliableNoResponse(person, voxelNoResponseFactId('expose', input.materialId, hotMaterialId)))
      .map((input) => ({
        input,
        known: knownTechniqueForPrefix(person, `technique:expose:${input.materialId}:${hotMaterialId}:`),
        edible: materialHas(input.materialId, 'edible'),
        stableRank: seededFraction(state.seed, `ordinary-expose:${person.id}:${input.materialId}:${hotMaterialId}`),
      }))
      .sort((a, b) => (a.known ? 0 : 1) - (b.known ? 0 : 1)
        || (a.edible ? 0 : 1) - (b.edible ? 0 : 1)
        || a.stableRank - b.stableRank
        || a.input.materialId - b.input.materialId
        || a.input.id.localeCompare(b.input.id))
      .slice(0, MAX_LOCAL_INTERACTION_OPTIONS);
    for (const { input, known } of exposureInputs) {
      options.push({
        id: `${known ? 'repeat-expose' : 'try-expose'}:${input.id}:${nearbyFireCell}`,
        summary: known ? `尝试复现“${known.summary}”` : `尝试让${materialDefinition(input.materialId).name}暴露于邻近${materialDefinition(hotMaterialId).name}`,
        reason: known ? '自己已有这项物质经验' : `手中的${materialDefinition(input.materialId).name}与持续放热的${materialDefinition(hotMaterialId).name}近在身边，可以尝试观察其变化`,
        goal: known
          ? { kind: 'knowledge', factId: known.id, minConfidence: Math.min(100, known.confidence + 18) }
          : { kind: 'knowledge', factId: `attempt:expose:${atMonth}:${person.id}:${input.id}` },
        nextAction: { kind: 'act', operation: 'expose', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: input.id }, { kind: 'voxel', position }] },
        target: { kind: 'voxel', position }, estimatedDuration: 'one-month',
        sourceFactIds: [...new Set([...input.sourceEventIds, ...(known?.sourceEventIds ?? [])])],
      });
    }
  }

  const seed = person.inventory.find((stack) => stack.materialId === Material.Seed && stack.quantity > 0);
  if (seed) {
    const trialSurfaces = new Set<number>([Material.Soil, Material.WetSoil, Material.RichSoil, Material.ExhaustedSoil, Material.Sand, Material.Grass]);
    const candidateSurfaces = new Map<number, number>();
    for (const cellId of [...visibleCells].sort((a, b) => distance(person.position.cellId, a) - distance(person.position.cellId, b) || a - b)) {
      const surface = surfaceMaterial(state.world.grid, cellId);
      if (!trialSurfaces.has(surface)) continue;
      if (!candidateSurfaces.has(surface)) candidateSurfaces.set(surface, cellId);
    }
    const learnedTargetMaterials = new Set(person.knowledge
      .filter((fact) => fact.kind === 'technique' && fact.id.startsWith(`technique:combine:${Material.Seed}:`))
      .map((fact) => Number(fact.id.split(':')[3])));
    const candidates = [...candidateSurfaces]
      .filter(([materialId]) => learnedTargetMaterials.has(materialId)
        || !knowsReliableNoResponse(person, voxelNoResponseFactId('combine', Material.Seed, materialId)))
      .sort(([materialA, cellA], [materialB, cellB]) => {
        const learnedA = learnedTargetMaterials.has(materialA) ? 1 : 0;
        const learnedB = learnedTargetMaterials.has(materialB) ? 1 : 0;
        return learnedB - learnedA || distance(person.position.cellId, cellA) - distance(person.position.cellId, cellB) || materialA - materialB;
      }).slice(0, 3);
    for (const [targetMaterial, soilCell] of candidates) {
      const position = topPosition(state.world.grid, soilCell);
      const technique = knowledgeFactById(person, `technique:combine:${Material.Seed}:${targetMaterial}:${Material.CropSprout}`);
      options.push({
        id: `${technique ? 'repeat-combine' : 'try-combine'}:${Material.Seed}:${targetMaterial}:${soilCell}:${seed.id}`,
        summary: technique
          ? `尝试复现“${technique.summary}”`
          : `尝试让种子接触${materialDefinition(targetMaterial).name}`,
        reason: technique
          ? `自己${technique.confidence >= 55 ? '已经核验' : '听说或初步见过'}这项物质经验`
          : '持有种子，可以对一种眼前物质作局部尝试，但结果未知',
        goal: { kind: 'voxel-is', position, materialId: Material.CropSprout },
        nextAction: person.position.cellId === soilCell
          ? { kind: 'act', operation: 'combine', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: seed.id }, { kind: 'voxel', position }] }
          : { kind: 'move', toCellId: soilCell },
        target: { kind: 'voxel', position },
        estimatedDuration: 'several-months',
        sourceFactIds: [...seed.sourceEventIds, ...(technique?.sourceEventIds ?? [])],
      });
    }
  }

  // Free-form building materials are governed by causal construction projects,
  // but an already crafted placeable utility still needs a legal placement affordance.
  options.push(...buildConstructionOptions(state, person)
    .filter((option) => option.goal.kind === 'voxel-is' && option.goal.materialId === Material.Container));
  options.push(...buildWaterCurrentObservationOptions(state, person, visibleCells));
  options.push(...buildMechanicalPowerServiceOptions(state, person, visibleCells));
  options.push(...buildElectricalPowerMaintenanceOptions(state, person, visibleCells));
  options.push(...buildElectricalPowerServiceOptions(state, person, visibleCells, atMonth));
  const projectOptions = buildProjectOptions(state, person, visibleCells, visibleDrops, visiblePeople);
  options.push(...projectOptions);
  options.push(...buildDemandBoundRecordUseOptions(state, person, visibleDrops));

  const carriedFood = person.inventory.find((stack) => stack.materialId === Material.Food && stack.quantity >= 2);
  const hungry = visiblePeople.filter((other) => other.body.nutrition < 45).sort((a, b) => a.body.nutrition - b.body.nutrition)[0];
  if (carriedFood && hungry && sameLocation(hungry, person)) options.push({
    id: `share:${carriedFood.id}:${hungry.id}`,
    summary: `把食物交给${hungry.name}`,
    reason: `${hungry.name}营养不足且就在身边`,
    goal: { kind: 'inventory-at-least', materialId: Material.Food, quantity: inventoryQuantity(hungry, Material.Food) + 1, personId: hungry.id },
    nextAction: {
      kind: 'transfer', materialId: Material.Food, quantity: 1,
      from: { kind: 'person', personId: person.id }, to: { kind: 'person', personId: hungry.id }, stackId: carriedFood.id,
    },
    estimatedDuration: 'one-month',
    sourceFactIds: carriedFood.sourceEventIds,
  });

  const incomingExchange = openExchangeOfferFor(state, person.id);
  if (incomingExchange) {
    const proposal = incomingExchange.content.proposal;
    const offerer = personById(state, incomingExchange.fact.who);
    if (proposal?.kind === 'exchange' && offerer) {
      const representationId = `accept:${incomingExchange.content.id}:${person.id}`;
      const together = sameLocation(offerer, person);
      const acceptAction = { kind: 'communicate' as const, content: { id: representationId, kind: 'accept' as const, referenceId: incomingExchange.content.id }, audience: [offerer.id], channel: 'voice' as const };
      if (inventoryQuantity(person, proposal.partnerMaterialId) >= proposal.partnerQuantity) options.push({
        id: `accept-exchange:${incomingExchange.content.id}`,
        summary: `接受以${materialDefinition(proposal.partnerMaterialId).name}换取${materialDefinition(proposal.offererMaterialId).name}`,
        reason: '存在一项自己有能力履行的交换报价',
        goal: { kind: 'representation-made', representationId },
        nextAction: together ? acceptAction : { kind: 'move', toCellId: offerer.position.cellId, toZ: offerer.position.z },
        ...(!together ? { completionAction: acceptAction } : {}),
        target: { kind: 'person', personId: offerer.id },
        estimatedDuration: together ? 'one-month' : 'several-months',
        sourceFactIds: [incomingExchange.fact.id],
        semantics: defineActionOptionSemantics({
          obligation: 'required-response', planningChannel: 'edge',
          purpose: 'social-coordination', minimumLifeStage: 'adolescent',
          needKinds: ['autonomy', 'reserve'], edgeTrigger: 'required-response',
          socialContext: {
            cooperationKind: 'exchange', phase: 'response', counterpartIds: [offerer.id],
            referenceId: incomingExchange.content.id, materialId: proposal.partnerMaterialId,
          },
        }),
      });
      const rejectId = `reject:${incomingExchange.content.id}:${person.id}`;
      const rejectAction = { kind: 'communicate' as const, content: { id: rejectId, kind: 'reject' as const, referenceId: incomingExchange.content.id }, audience: [offerer.id], channel: 'voice' as const };
      options.push({
        id: `reject-exchange:${incomingExchange.content.id}`,
        summary: `拒绝这项物质交换`,
        reason: '存在一项需要明确回应的交换报价',
        goal: { kind: 'representation-made', representationId: rejectId },
        nextAction: together ? rejectAction : { kind: 'move', toCellId: offerer.position.cellId, toZ: offerer.position.z },
        ...(!together ? { completionAction: rejectAction } : {}),
        target: { kind: 'person', personId: offerer.id }, estimatedDuration: together ? 'one-month' : 'several-months', sourceFactIds: [incomingExchange.fact.id],
        semantics: defineActionOptionSemantics({
          obligation: 'required-response', planningChannel: 'edge',
          purpose: 'social-coordination', minimumLifeStage: 'adolescent',
          needKinds: ['autonomy'], edgeTrigger: 'required-response',
          socialContext: {
            cooperationKind: 'exchange', phase: 'response', counterpartIds: [offerer.id],
            referenceId: incomingExchange.content.id, materialId: proposal.partnerMaterialId,
          },
        }),
      });
    }
  }

  const acceptedExchange = acceptedExchangeAt(state, person, atMonth);
  if (acceptedExchange && !exchangeTermFulfilled(state, acceptedExchange.offer.action.kind === 'communicate' ? acceptedExchange.offer.action.content.id : '', person.id)) {
    const proposal = acceptedExchange.proposal;
    const materialId = proposal.offererId === person.id ? proposal.offererMaterialId : proposal.partnerMaterialId;
    const quantity = proposal.offererId === person.id ? proposal.offererQuantity : proposal.partnerQuantity;
    const receiverId = proposal.offererId === person.id ? proposal.partnerId : proposal.offererId;
    const stack = person.inventory.find((item) => item.materialId === materialId && item.quantity >= quantity);
    const receiver = personById(state, receiverId);
    if (stack && receiver) options.push({
      id: `settle-exchange:${acceptedExchange.offer.id}:${person.id}`,
      summary: `交付交换中的${materialDefinition(materialId).name}`,
      reason: '双方已经接受报价，本人尚未履行自己的交付',
      goal: { kind: 'inventory-at-least', materialId, quantity: inventoryQuantity(personById(state, receiverId) ?? person, materialId) + quantity, personId: receiverId },
      nextAction: sameLocation(receiver, person)
        ? { kind: 'transfer', materialId, quantity, from: { kind: 'person', personId: person.id }, to: { kind: 'person', personId: receiverId }, stackId: stack.id, authorizationRef: acceptedExchange.offer.action.kind === 'communicate' ? acceptedExchange.offer.action.content.id : undefined }
        : { kind: 'move', toCellId: receiver.position.cellId, toZ: receiver.position.z },
      target: { kind: 'person', personId: receiverId },
      estimatedDuration: 'one-month',
      sourceFactIds: [acceptedExchange.offer.id, acceptedExchange.acceptance.id],
      semantics: defineActionOptionSemantics({
        obligation: 'commitment-action',
        planningChannel: 'edge',
        purpose: 'social-coordination',
        minimumLifeStage: 'adolescent',
        needKinds: ['commitment', 'reserve'],
        edgeTrigger: 'commitment-action',
        socialContext: {
          cooperationKind: 'exchange', phase: 'fulfillment', counterpartIds: [receiverId],
          referenceId: acceptedExchange.offer.id, materialId,
        },
      }),
    });
  }

  const toolUpgradeTrade = !incomingExchange && !acceptedExchange && recentProductionLabor.length
    ? productionToolUpgradeTradeCandidate(state, person, visiblePeople)
    : undefined;
  if (toolUpgradeTrade) {
    const representationId = `offer-tool-upgrade:${atMonth}:${person.id}:${toolUpgradeTrade.person.id}:${toolUpgradeTrade.their.id}`;
    const offeredMaterial = materialDefinition(toolUpgradeTrade.own.materialId);
    const requestedTool = materialDefinition(toolUpgradeTrade.their.materialId);
    options.push({
      id: representationId,
      summary: `向${toolUpgradeTrade.person.name}提出生产工具升级交换`,
      reason: `本人近期完成过真实生产劳动；对方可保留另一件生产工具，并持有更高效的${requestedTool.name}`,
      goal: { kind: 'representation-made', representationId },
      nextAction: {
        kind: 'communicate',
        content: {
          id: representationId,
          kind: 'offer',
          summary: `用${offeredMaterial.name}换取${requestedTool.name}`,
          proposal: {
            kind: 'exchange',
            offererId: person.id,
            partnerId: toolUpgradeTrade.person.id,
            offererMaterialId: toolUpgradeTrade.own.materialId,
            offererQuantity: 1,
            partnerMaterialId: toolUpgradeTrade.their.materialId,
            partnerQuantity: 1,
            expiresAtMonth: atMonth + 12,
          },
        },
        audience: [toolUpgradeTrade.person.id],
        channel: 'voice',
      },
      target: { kind: 'person', personId: toolUpgradeTrade.person.id },
      estimatedDuration: 'one-month',
      sourceFactIds: [
        ...recentProductionLabor.map((event) => event.id),
        ...toolUpgradeTrade.own.sourceEventIds,
        ...toolUpgradeTrade.their.sourceEventIds,
      ],
      domain: 'social',
    });
  }

  const tradePartner = !incomingExchange && !acceptedExchange && !toolUpgradeTrade
    ? localPeopleWithDifferentGoods(person, visiblePeople)
      .find((candidate) => !hasOpenExchangeOfferBetween(state, person.id, candidate.person.id))
    : undefined;
  if (tradePartner) {
    const representationId = `offer-exchange:${atMonth}:${person.id}:${tradePartner.person.id}`;
    options.push({
      id: representationId,
      summary: `向${tradePartner.person.name}提出物质交换`,
      reason: `双方分别持有${materialDefinition(tradePartner.own.materialId).name}与${materialDefinition(tradePartner.their.materialId).name}`,
      goal: { kind: 'representation-made', representationId },
      nextAction: {
        kind: 'communicate',
        content: { id: representationId, kind: 'offer', summary: `用${materialDefinition(tradePartner.own.materialId).name}换取${materialDefinition(tradePartner.their.materialId).name}`, proposal: { kind: 'exchange', offererId: person.id, partnerId: tradePartner.person.id, offererMaterialId: tradePartner.own.materialId, offererQuantity: 1, partnerMaterialId: tradePartner.their.materialId, partnerQuantity: 1, expiresAtMonth: atMonth + 12 } },
        audience: [tradePartner.person.id], channel: 'voice',
      },
      target: { kind: 'person', personId: tradePartner.person.id },
      estimatedDuration: 'one-month',
      sourceFactIds: [...tradePartner.own.sourceEventIds, ...tradePartner.their.sourceEventIds],
    });
  }

  const fiber = person.inventory.find((stack) => stack.materialId === Material.HerbalMedicine && stack.quantity > 0)
    ?? person.inventory.find((stack) => stack.materialId === Material.Fiber && stack.quantity > 0);
  const injured = visiblePeople
    .filter((other) => sameLocation(other, person) && other.conditions.some((condition) => condition.kind === 'wound' || condition.kind === 'illness'))
    .sort((a, b) => a.body.health - b.body.health)[0];
  if (fiber && injured) options.push({
    id: `care:${fiber.id}:${injured.id}`,
    summary: `把${materialDefinition(fiber.materialId).name}用于${injured.name}的伤病处`,
    reason: `${injured.name}有持续性伤病，且背包里有可用的${materialDefinition(fiber.materialId).name}`,
    goal: { kind: 'condition', personId: injured.id, condition: injured.conditions.some((item) => item.kind === 'wound') ? 'wound' : 'illness', present: false },
    nextAction: { kind: 'act', operation: 'combine', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: fiber.id }, { kind: 'person', personId: injured.id }] },
    target: { kind: 'person', personId: injured.id },
    estimatedDuration: 'one-month',
    sourceFactIds: [...fiber.sourceEventIds, ...injured.conditions.flatMap((condition) => condition.sourceEventIds)],
    semantics: defineActionOptionSemantics({
      purpose: 'care', minimumLifeStage: 'learning-child', needKinds: ['care'],
    }),
  });

  options.push(...buildReproductionOptions(state, person, visiblePeople, atMonth));

  const vulnerableCarrier = localPeople.find((other) => other.inventory.some((stack) => stack.materialId === Material.Food && stack.quantity > 0));
  if (vulnerableCarrier && person.body.nutrition < 24 && inventoryQuantity(person, Material.Food) === 0) {
    const targetStack = vulnerableCarrier.inventory.find((stack) => stack.materialId === Material.Food && stack.quantity > 0);
    if (targetStack) options.push({
      id: `take-without-permission:${vulnerableCarrier.id}:${targetStack.id}`,
      summary: `尝试从${vulnerableCarrier.name}处取得食物`,
      reason: '自身营养进入危险区，眼前他人持有食物',
      goal: { kind: 'inventory-at-least', materialId: Material.Food, quantity: 1 },
      nextAction: { kind: 'transfer', materialId: Material.Food, quantity: 1, from: { kind: 'person', personId: vulnerableCarrier.id }, to: { kind: 'person', personId: person.id }, stackId: targetStack.id },
      target: { kind: 'person', personId: vulnerableCarrier.id },
      estimatedDuration: 'one-month',
      sourceFactIds: targetStack.sourceEventIds,
    });
  }

  const ownRestraint = person.conditions.find((condition) => condition.kind === 'restrained');
  if (ownRestraint) options.push({
    id: `separate-restraint:${ownRestraint.id}`,
    summary: '尝试分离自己身上的绳',
    reason: '身体受到可触及的绳索拘束，无法正常移动',
    goal: { kind: 'condition', personId: person.id, condition: 'restrained', present: false },
    nextAction: { kind: 'act', operation: 'separate', targets: [{ kind: 'person', personId: person.id }] },
    target: { kind: 'person', personId: person.id }, estimatedDuration: 'one-month', sourceFactIds: ownRestraint.sourceEventIds,
  });

  const restrainedOther = localPeople.find((other) => other.conditions.some((condition) => condition.kind === 'restrained'));
  if (restrainedOther) {
    const restraint = restrainedOther.conditions.find((condition) => condition.kind === 'restrained');
    if (restraint) options.push({
      id: `release-restraint:${restrainedOther.id}:${restraint.id}`,
      summary: `从${restrainedOther.name}身上分离绳`,
      reason: `${restrainedOther.name}近身且正受到绳索拘束`,
      goal: { kind: 'condition', personId: restrainedOther.id, condition: 'restrained', present: false },
      nextAction: { kind: 'act', operation: 'separate', targets: [{ kind: 'person', personId: restrainedOther.id }] },
      target: { kind: 'person', personId: restrainedOther.id }, estimatedDuration: 'one-month', sourceFactIds: restraint.sourceEventIds,
    });
  }

  const rope = person.inventory.find((stack) => stack.materialId === Material.Rope && stack.quantity > 0);
  const restraintTarget = localPeople.find((other) => {
    if (other.conditions.some((condition) => condition.kind === 'restrained')) return false;
    const relation = relationTo(person, other.id);
    const unableToResist = other.body.health <= 20 || other.conditions.some((condition) => condition.kind === 'wound' && condition.stage === 3);
    return unableToResist && (person.body.nutrition < 18 || (relation?.fear ?? 0) > 45);
  });
  if (rope && restraintTarget) options.push({
    id: `combine-restraint:${rope.id}:${restraintTarget.id}`,
    summary: `尝试让绳与${restraintTarget.name}的身体结合`,
    reason: '对方严重虚弱或重伤，资源压力或恐惧使强制约束成为可选手段',
    goal: { kind: 'condition', personId: restraintTarget.id, condition: 'restrained', present: true },
    nextAction: { kind: 'act', operation: 'combine', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: rope.id }, { kind: 'person', personId: restraintTarget.id }] },
    target: { kind: 'person', personId: restraintTarget.id }, estimatedDuration: 'one-month',
    sourceFactIds: [...rope.sourceEventIds, ...(relationTo(person, restraintTarget.id)?.sourceEventIds ?? [])],
  });

  const fearedOpponent = localPeople.find((other) => {
    const relation = relationTo(person, other.id);
    return (relation?.trust ?? 0) < 12 && ((relation?.fear ?? 0) > 45 || person.body.nutrition < 18);
  });
  if (fearedOpponent) options.push({
    id: `exert-person:${fearedOpponent.id}:${atMonth}`,
    summary: `对${fearedOpponent.name}施力`,
    reason: '极低信任与恐惧或资源压力使近身冲突成为可选手段',
    goal: { kind: 'body-at-most', personId: fearedOpponent.id, field: 'health', value: Math.max(0, fearedOpponent.body.health - 4) },
    nextAction: { kind: 'act', operation: 'exert', targets: [{ kind: 'person', personId: fearedOpponent.id }] },
    target: { kind: 'person', personId: fearedOpponent.id },
    estimatedDuration: 'one-month',
    sourceFactIds: relationTo(person, fearedOpponent.id)?.sourceEventIds ?? [],
  });

  const projectTeaching = projectKnowledgeTeachingOpportunity(state, person, atMonth);
  const visibleCompletedMechanicalNetwork = state.world.mechanicalPower?.networks.some((network) => {
    const project = state.projects.find((candidate) => candidate.id === network.installationProjectId
      && candidate.status === 'completed'
      && candidate.desiredFunction === 'water-powered-crop-processing');
    const load = project?.mechanicalPowerPlan?.loadPosition;
    return Boolean(load && visible.has(load.x + load.y * state.world.grid.width));
  }) ?? false;
  const mechanicalOperationTeaching = visibleCompletedMechanicalNetwork
    ? person.knowledge.flatMap((fact) => {
      if (fact.id !== MECHANICAL_POWER_OPERATION_TECHNIQUE_ID
        || fact.kind !== 'technique'
        || fact.confidence < 55) return [];
      const learner = conversationalPeople.find((other) => ageMonths(other, atMonth) >= MIN_TEACHING_AGE_MONTHS
        && !hasKnowledgeFact(other, fact.id, (known) => known.confidence >= 55));
      return learner ? [{ fact, learner }] : [];
    })[0]
    : undefined;
  const ordinaryTeachableFacts = person.knowledge
    .filter((fact) => (fact.kind === 'codebook' || fact.kind === 'technique')
      && fact.confidence >= 55
      && conversationalPeople.some((other) => ageMonths(other, atMonth) >= MIN_TEACHING_AGE_MONTHS
        && !hasKnowledgeFact(other, fact.id, (known) => known.confidence >= 55)))
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
  const teachableFacts = [
    ...(projectTeaching ? [projectTeaching.fact] : []),
    ...(mechanicalOperationTeaching ? [mechanicalOperationTeaching.fact] : []),
    ...ordinaryTeachableFacts.filter((fact) => fact.id !== projectTeaching?.fact.id
      && fact.id !== mechanicalOperationTeaching?.fact.id),
  ].slice(0, 3);
  for (const teachable of teachableFacts) {
    const learnedThreshold = 55;
    const prioritizedProjectTeaching = projectTeaching?.fact.id === teachable.id ? projectTeaching : undefined;
    const prioritizedMechanicalTeaching = mechanicalOperationTeaching?.fact.id === teachable.id
      ? mechanicalOperationTeaching
      : undefined;
    const learner = prioritizedProjectTeaching?.learner ?? prioritizedMechanicalTeaching?.learner
      ?? conversationalPeople.find((other) => ageMonths(other, atMonth) >= MIN_TEACHING_AGE_MONTHS
        && !hasKnowledgeFact(other, teachable.id, (known) => known.confidence >= learnedThreshold));
    if (!learner) continue;
    const representationId = prioritizedProjectTeaching
      ? `teach:${atMonth}:${person.id}:${teachable.id}:${learner.id}:${prioritizedProjectTeaching.request.requestEventId}`
      : `teach:${atMonth}:${person.id}:${teachable.id}:${learner.id}`;
    const communicate = {
      kind: 'communicate' as const,
      content: {
        id: representationId,
        kind: 'claim' as const,
        summary: teachable.summary,
        factId: teachable.id,
        ...(prioritizedProjectTeaching ? {
          projectKnowledgeResponse: {
            version: 'project-knowledge-response-v1' as const,
            projectId: prioritizedProjectTeaching.project.id,
            requestEventId: prioritizedProjectTeaching.request.requestEventId,
            requesterId: prioritizedProjectTeaching.request.requesterId,
            outputMaterialId: prioritizedProjectTeaching.request.outputMaterialId,
          },
        } : {}),
      },
      audience: [learner.id],
      channel: 'voice' as const,
    };
    options.push({
      id: representationId,
      summary: teachable.kind === 'codebook'
        ? `教${learner.name}辨认一组记录刻痕`
        : `把“${teachable.summary}”教给${learner.name}`,
      reason: teachable.kind === 'codebook'
        ? '自己可靠掌握这组符号，而身边达到学习年龄的人还不理解'
        : prioritizedProjectTeaching
          ? `本人实际收到“${prioritizedProjectTeaching.project.summary}”对${materialDefinition(prioritizedProjectTeaching.request.outputMaterialId).name}制作知识的请求，并可靠掌握匹配技术`
        : prioritizedMechanicalTeaching
          ? '本人在眼前完成网络上做成过真实负载作业，身边成年人还不会独立操作这类网络'
        : '自己可靠掌握这项技术，而身边达到学习年龄的人还不会；一次明确教导即可传授',
      goal: { kind: 'knowledge', factId: teachable.id, minConfidence: learnedThreshold, personId: learner.id },
      nextAction: communicate,
      target: { kind: 'person', personId: learner.id },
      estimatedDuration: 'one-month',
      sourceFactIds: [...new Set([
        ...teachable.sourceEventIds,
        ...(prioritizedProjectTeaching ? [prioritizedProjectTeaching.request.requestEventId] : []),
      ])],
    });
  }

  const tentativeTechnique = person.knowledge.find((fact) => fact.kind === 'technique' && fact.confidence < 55 && fact.sourceEventIds.some((sourceId) => {
    const source = worldEventById(state, sourceId);
    if (source?.kind !== 'action'
      || source.action.kind !== 'act'
      || source.action.techniqueDemonstration
      || !['combine', 'exert', 'expose'].includes(source.action.operation)) return false;
    const outputStackId = typeof source.diff.outputStackId === 'string' ? source.diff.outputStackId : undefined;
    if (outputStackId && person.inventory.some((stack) => stack.id === outputStackId && stack.materialId === Number(source.diff.outputMaterialId))) return true;
    const position = source.diff.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
    if (![position?.x, position?.y, position?.z].every((value) => Number.isInteger(value))) return false;
    const cell = Number(position?.x) + Number(position?.y) * state.world.grid.width;
    return visible.has(cell) && voxelAt(state.world.grid, Number(position?.x), Number(position?.y), Number(position?.z)) === Number(source.diff.outputMaterialId);
  }));
  if (tentativeTechnique) {
    const source = tentativeTechnique.sourceEventIds.map((eventId) => worldEventById(state, eventId)).find((event) => event?.kind === 'action'
      && event.action.kind === 'act'
      && !event.action.techniqueDemonstration
      && ['combine', 'exert', 'expose'].includes(event.action.operation));
    const rawPosition = source?.kind === 'action' ? source.diff.position as { x: number; y: number; z: number } | undefined : undefined;
    const outputStackId = source?.kind === 'action' && typeof source.diff.outputStackId === 'string' ? source.diff.outputStackId : undefined;
    const verificationTarget = rawPosition
      ? { kind: 'voxel' as const, position: rawPosition }
      : outputStackId && person.inventory.some((stack) => stack.id === outputStackId)
        ? { kind: 'inventory-stack' as const, personId: person.id, stackId: outputStackId }
        : undefined;
    if (verificationTarget) options.push({
      id: `verify-technique:${tentativeTechnique.id}:${source?.id}`,
      summary: `复查${tentativeTechnique.summary}的结果`,
      reason: '一次成功结合只形成暂定经验，需要再次观察产物才能可靠传授',
      goal: { kind: 'knowledge', factId: tentativeTechnique.id, minConfidence: 55 },
      nextAction: { kind: 'attend', target: verificationTarget },
      target: verificationTarget,
      estimatedDuration: 'one-month',
      sourceFactIds: [...tentativeTechnique.sourceEventIds],
    });
  }

  const unknown = visibleCells.find((cellId) => {
    const material = materialDefinition(surfaceMaterial(state.world.grid, cellId));
    return !hasKnowledgeFact(person, `material:${material.id}`);
  });
  if (unknown !== undefined) {
    const position = topPosition(state.world.grid, unknown);
    options.push({
      id: `attend:${unknown}`,
      summary: `持续观察${materialDefinition(surfaceMaterial(state.world.grid, unknown)).name}`,
      reason: '眼前物质尚未形成可靠认识',
      goal: { kind: 'knowledge', factId: `material:${surfaceMaterial(state.world.grid, unknown)}` },
      nextAction: { kind: 'attend', target: { kind: 'voxel', position } },
      estimatedDuration: 'one-month',
      sourceFactIds: [],
    });
  }

  options.push(...buildCharacterAgendaOptions({
    state,
    person,
    visibleCells,
    visiblePeople,
    visibleDrops,
    visibleAnimals,
    visibleRemains,
    options: [],
    followUpOptions: [],
    activeIntent: person.activeIntentId && intentById(state, person.activeIntentId)?.status === 'active'
      ? intentById(state, person.activeIntentId)
      : undefined,
  }, atMonth));

  options.push(...buildSocialOptions(state, person, visiblePeople, atMonth));
  const failureRetryContext = buildFailureRetryContext(state, person, atMonth);
  const pathCache = new Map<string, ReturnType<typeof findStandingPath>>();
  return [...new Map(options.map((option) => [option.id, option])).values()]
    .flatMap((option) => {
      const classified = classifyActionOption(option);
      const planned = withPlanning(state, person, classified, atMonth, failureRetryContext, pathCache);
      if (!planned) return [];
      if (knowledgeGoalAlreadySatisfied(state, person, planned)) return [];
      assertClassifiedActionOption(planned);
      return [planned];
    });
}

export function buildDecisionContext(
  state: SimulationState,
  person: PersonState,
  atMonth = state.clock.elapsedMonths,
): DecisionContext {
  const visibleCells = visibleCellsFor(person);
  const visibleSet = new Set(visibleCells);
  const visibleRadius = 4 + Math.floor(person.baselineCapacities.perception / 25);
  const visibleDrops = state.world.drops.filter((drop) => drop.quantity > 0
    && visibleSet.has(drop.cellId)
    && Math.abs(drop.z - person.position.z) <= visibleRadius);
  const visiblePeople = livingPeople(state).filter((other) => other.id !== person.id
    && visibleSet.has(other.position.cellId)
    && Math.abs(other.position.z - person.position.z) <= visibleRadius);
  const visibleAnimals = state.world.animals.filter((animal) => isAnimalAlive(animal)
    && visibleSet.has(animal.position.cellId)
    && Math.abs(animal.position.z - person.position.z) <= visibleRadius);
  const visibleRemains = (state.world.remains ?? []).filter((remains) => visibleSet.has(remains.position.cellId)
    && Math.abs(remains.position.z - person.position.z) <= visibleRadius);
  // Project options own a copy of the one project they may route; unrelated
  // projects and all terminal evidence are read-only in this context.
  const planningState = state;
  const planningPerson = personById(planningState, person.id) ?? person;
  const stage = lifePlanningStage(person, atMonth);
  const allOptions = buildOptions(planningState, planningPerson, visibleCells, visibleDrops, visiblePeople, visibleAnimals, visibleRemains, atMonth)
    .filter((option) => {
      const action = option.completionAction ?? option.nextAction;
      return !(actionOptionSemantics(option).purpose === 'homeostasis'
        && action.kind === 'act'
        && action.operation === 'ingest');
    })
    .filter((option) => optionAllowedForLifeStage(stage, option))
    .filter((option) => stage !== 'learning-child' || optionAllowedForLearningChildCareRadius(state, person, option))
    .sort((a, b) => decisionOptionPriority(a) - decisionOptionPriority(b) || a.id.localeCompare(b.id));
  const followUpOptions = allOptions.filter((option) => !option.recordUseBasis
    && option.nextAction.kind !== 'communicate');
  const options = allOptions
    .map((option) => isGroundedConversationOpening(option)
      && followUpOptions.some((followUp) => followUpSemanticallyMatches(option, followUp))
      ? { ...option, requiresFollowUp: true }
      : { ...option, requiresFollowUp: false });
  const requiredSocialResponses = options.filter(isRequiredResponseOption);
  const observedEmergencyHibernation = options.filter((option) => (
    isObservedEmergencyHibernationOption(state, person, option)
  ));
  return {
    state,
    person,
    visibleCells,
    visiblePeople,
    visibleDrops,
    visibleAnimals,
    visibleRemains,
    options: requiredSocialResponses.length
      ? [...observedEmergencyHibernation, ...requiredSocialResponses]
      : options,
    followUpOptions,
    activeIntent: person.activeIntentId && intentById(state, person.activeIntentId)?.status === 'active'
      ? intentById(state, person.activeIntentId)
      : undefined,
  };
}

export function reproductionIntentAttemptedThisMonth(
  state: SimulationState,
  person: PersonState,
  intent: Intent,
  atMonth: number,
): boolean {
  const reproductionAction = [intent.nextAction, intent.completionAction].find((action) => action?.kind === 'act'
    && action.operation === 'reproduce');
  const partner = reproductionAction?.kind === 'act'
    ? reproductionAction.targets.find((target) => target.kind === 'person')
    : undefined;
  return Boolean(partner?.kind === 'person'
    && reproductionAttemptedBetweenInMonth(state, person.id, partner.personId, atMonth));
}

export function recompileNextAction(
  state: SimulationState,
  person: PersonState,
  intent: Intent,
  atMonth = state.clock.elapsedMonths,
): PrimitiveAction | null {
  if (reproductionIntentAttemptedThisMonth(state, person, intent, atMonth)) return null;
  if (intent.recordUseBasis) return recompileRecordUseNextAction(state, person, intent);
  if (intent.goal.kind === 'death-mourned'
    || intent.goal.kind === 'remains-interred'
    || intent.goal.kind === 'memorial-marked') return recompileMortuaryNextAction(state, person, intent);
  if ((intent.nextAction.kind === 'communicate'
      && intent.nextAction.content.kind === 'request'
      && intent.nextAction.content.techniqueDemonstration)
    || (intent.nextAction.kind === 'act'
      && (intent.nextAction.techniqueDemonstration || intent.nextAction.techniqueImitation))) return null;
  const physicalServiceCompletion = intent.completionAction?.kind === 'act'
    && (intent.completionAction.mechanicalPowerBasis?.mode === 'operate-service'
      || intent.completionAction.mechanicalPowerBasis?.mode === 'repair-service'
      || intent.completionAction.electricalPowerBasis?.mode === 'operate-service')
    ? intent.completionAction
    : undefined;
  if (physicalServiceCompletion && intent.target?.kind === 'voxel') {
    const target = intent.target.position;
    const horizontal = Math.abs(cellX(person.position.cellId) - target.x)
      + Math.abs(cellY(person.position.cellId) - target.y);
    const vertical = Math.max(0, Math.abs(person.position.z - target.z) - 1);
    const actorOccupiesTarget = person.position.cellId === target.x + target.y * state.world.grid.width
      && (person.position.z === target.z || person.position.z + 1 === target.z);
    return Math.max(horizontal, vertical) <= 1 && !actorOccupiesTarget
      ? physicalServiceCompletion
      : intent.nextAction;
  }
  if (intent.projectId) return recompileProjectNextAction(state, person, intent.projectId);
  const agreementContinuation = intent.agreementId
    ? compileAgreementContinuations(state, intent.agreementId, atMonth).find((continuation) => continuation.personId === person.id)
    : undefined;
  if (agreementContinuation) return agreementContinuation.nextAction;
  if (intent.nextAction.kind === 'transfer' && intent.nextAction.authorizationRef) {
    const mandate = mandateById(state, intent.nextAction.authorizationRef);
    const mandateAction = intent.nextAction;
    if (mandate?.status === 'active'
      && atMonth >= mandate.validFromMonth
      && atMonth <= mandate.validUntilMonth
      && mandateAction.from.kind === 'person'
      && mandateAction.from.personId === person.id
      && mandateAction.to.kind === 'person') {
      const receiverId = mandateAction.to.personId;
      const receiverCandidate = personById(state, receiverId);
      const receiver = receiverCandidate && isAlive(receiverCandidate) ? receiverCandidate : undefined;
      const stack = person.inventory.find((candidate) => candidate.materialId === mandateAction.materialId && candidate.quantity > 0);
      if (!receiver || !stack) return null;
      return sameLocation(receiver, person)
        ? { ...mandateAction, stackId: stack.id }
        : { kind: 'move', toCellId: receiver.position.cellId, toZ: receiver.position.z };
    }
    const permission = permissionById(state, intent.nextAction.authorizationRef);
    if (permission?.status === 'active'
      && permission.granteeId === person.id
      && atMonth >= permission.validFromMonth
      && atMonth <= permission.validUntilMonth) {
      const grantorCandidate = personById(state, permission.grantorId);
      const grantor = grantorCandidate && isAlive(grantorCandidate) ? grantorCandidate : undefined;
      const stack = grantor?.inventory.find((candidate) => candidate.materialId === permission.materialId && candidate.quantity > 0);
      if (!grantor || !stack) return null;
      return sameLocation(grantor, person)
        ? { kind: 'transfer', materialId: permission.materialId, quantity: 1, from: { kind: 'person', personId: grantor.id }, to: { kind: 'person', personId: person.id }, stackId: stack.id, authorizationRef: permission.id }
        : { kind: 'move', toCellId: grantor.position.cellId, toZ: grantor.position.z };
    }
    return null;
  }
  if (intent.completionAction && intent.target?.kind === 'person') {
    const targetPersonId = intent.target.personId;
    const target = personById(state, targetPersonId);
    if (!target || !isAlive(target)) return null;
    if (intent.completionAction.kind === 'communicate') {
      if (positionsWithinVoiceRange(target.position, person.position)) return intent.completionAction;
      const rendezvous = conversationalRendezvous(state, person, target);
      return rendezvous
        ? { kind: 'move', toCellId: rendezvous.position.cellId, toZ: rendezvous.position.z }
        : null;
    }
    return sameLocation(target, person) ? intent.completionAction : { kind: 'move', toCellId: target.position.cellId, toZ: target.position.z };
  }
  if (intent.goal.kind === 'near-person') {
    const targetPersonId = intent.goal.personId;
    const targetCandidate = personById(state, targetPersonId);
    const target = targetCandidate && isAlive(targetCandidate) ? targetCandidate : undefined;
    if (!target) return null;
    return sameLocation(target, person) ? null : { kind: 'move', toCellId: target.position.cellId, toZ: target.position.z };
  }
  if (intent.goal.kind === 'inventory-at-least' && intent.goal.personId && intent.target?.kind === 'person') {
    const goal = intent.goal;
    const receiverId = intent.target.personId;
    const receiver = personById(state, receiverId);
    const exchange = acceptedExchangeAt(state, person, atMonth);
    const stack = person.inventory.find((candidate) => candidate.materialId === goal.materialId && candidate.quantity > 0);
    const offerId = exchange?.offer.action.kind === 'communicate' ? exchange.offer.action.content.id : undefined;
    if (receiver && exchange && offerId && intent.sourceFactIds?.includes(exchange.offer.id) && stack) {
      if (!sameLocation(receiver, person)) return { kind: 'move', toCellId: receiver.position.cellId, toZ: receiver.position.z };
      return {
        kind: 'transfer', materialId: intent.goal.materialId, quantity: 1,
        from: { kind: 'person', personId: person.id }, to: { kind: 'person', personId: receiver.id },
        stackId: stack.id,
        authorizationRef: offerId,
      };
    }
  }
  if (intent.goal.kind === 'container-inventory-at-least' && intent.target?.kind === 'container') {
    const goal = intent.goal;
    const container = containerById(state, intent.target.containerId);
    const stack = person.inventory.find((candidate) => candidate.materialId === goal.materialId && candidate.quantity > 0);
    if (!container || !stack) return null;
    if (!canAccessContainer(person, container)) {
      const access = findContainerAccess(state, person, container);
      return access ? { kind: 'move', toCellId: access.position.cellId, toZ: access.position.z } : null;
    }
    const ordinaryGranaryFoodReserve = !intent.projectId
      && materialHas(goal.materialId, 'edible')
      && voxelAt(state.world.grid, container.position.x, container.position.y, container.position.z) === Material.Granary
      ? 1
      : 0;
    const quantity = Math.min(
      Math.max(0, stack.quantity - ordinaryGranaryFoodReserve),
      Math.max(1, goal.quantity - containerQuantity(container, goal.materialId)),
    );
    if (quantity <= 0) return null;
    return {
      kind: 'transfer', materialId: goal.materialId,
      quantity,
      from: { kind: 'person', personId: person.id }, to: { kind: 'container', containerId: container.id }, stackId: stack.id,
    };
  }
  if (intent.goal.kind === 'inventory-at-least') {
    const materialId = intent.goal.materialId;
    if (intent.target?.kind === 'drop') {
      const targetDropId = intent.target.dropId;
      const drop = state.world.drops.find((candidate) => candidate.id === targetDropId
        && candidate.materialId === materialId
        && candidate.quantity > 0
        && canPersonPlanToCollectProjectMaterialDrop(state, person.id, candidate, atMonth));
      if (!drop || drop.materialId !== materialId || drop.quantity <= 0) return null;
      const dropZ = dropStandingZ(state, drop);
      const path = findStandingPath(state.world.grid, person.position, { cellId: drop.cellId, z: dropZ });
      return path.length ? actionForDrop(state, person, drop) : null;
    }
    if (intent.target?.kind === 'animal') {
      const animalId = intent.target.animalId;
      const animal = state.world.animals.find((candidate) => candidate.id === animalId && isAnimalAlive(candidate));
      if (animal) {
        const tool = bestHuntingToolStack(person);
        return person.position.cellId === animal.position.cellId && person.position.z === animal.position.z
          ? { kind: 'act', operation: 'hunt', targets: [{ kind: 'animal', animalId }], ...(tool ? { toolStackId: tool.id } : {}) }
          : { kind: 'move', toCellId: animal.position.cellId, toZ: animal.position.z };
      }
    }
    if (intent.target?.kind === 'container') {
      const container = containerById(state, intent.target.containerId);
      const stack = container?.inventory.find((candidate) => candidate.materialId === materialId && candidate.quantity > 0);
      if (!container || !stack) return null;
      if (!canAccessContainer(person, container)) {
        const access = findContainerAccess(state, person, container);
        return access ? { kind: 'move', toCellId: access.position.cellId, toZ: access.position.z } : null;
      }
      return {
        kind: 'transfer', materialId, quantity: Math.min(stack.quantity, Math.max(1, intent.goal.quantity - inventoryQuantity(person, materialId))),
        from: { kind: 'container', containerId: container.id }, to: { kind: 'person', personId: person.id }, stackId: stack.id,
      };
    }
    if (intent.target?.kind === 'voxel') {
      const targetCell = intent.target.position.x + intent.target.position.y * state.world.grid.width;
      const targetMaterial = voxelAt(state.world.grid, intent.target.position.x, intent.target.position.y, intent.target.position.z);
      const separationRule = voxelSeparationRuleFor(targetMaterial);
      const targetStillMatches = (materialId === Material.Food
          && (targetMaterial === Material.CropMature || targetMaterial === Material.BerryBush))
        || (materialId === Material.Wood && (targetMaterial === Material.Wood || targetMaterial === Material.Leaves))
        || Boolean(separationRule?.outputs.some((output) => output.materialId === materialId));
      if (targetStillMatches) {
        if (distance(person.position.cellId, targetCell) <= 1) {
          const requiredTool = separationRule?.requiredToolMaterialId === undefined
            ? undefined
            : person.inventory
              .filter((stack) => stack.quantity > 0 && separationToolFits(separationRule, stack.materialId))
              .sort((left, right) => productionToolRank(right.materialId) - productionToolRank(left.materialId)
                || left.id.localeCompare(right.id))[0];
          if (separationRule?.requiredToolMaterialId !== undefined && !requiredTool) return null;
          const productionToolApplies = targetMaterial === Material.Wood
            || targetMaterial === Material.Leaves
            || targetMaterial === Material.CropMature
            || targetMaterial === Material.BerryBush
            || targetMaterial === Material.Shrub;
          const selectedTool = requiredTool ?? (productionToolApplies ? bestProductionToolStack(person) : undefined);
          return {
            kind: 'act', operation: 'separate', targets: [intent.target],
            ...(selectedTool ? { toolStackId: selectedTool.id } : {}),
          };
        }
        const destination = intent.nextAction.kind === 'move' ? intent.nextAction.toCellId : targetCell;
        return { kind: 'move', toCellId: destination };
      }
    }
    const local = state.world.drops.find((drop) => drop.cellId === person.position.cellId
      && dropStandingZ(state, drop) === person.position.z
      && drop.materialId === materialId
      && drop.quantity > 0
      && canPersonPlanToCollectProjectMaterialDrop(state, person.id, drop, atMonth));
    if (local) return actionForDrop(state, person, local);
    const visible = new Set(visibleCellsFor(person));
    const reachable = state.world.drops
      .filter((drop) => visible.has(drop.cellId)
        && drop.materialId === materialId
        && drop.quantity > 0
        && canPersonPlanToCollectProjectMaterialDrop(state, person.id, drop, atMonth))
      .map((drop) => ({
        drop,
        path: findStandingPath(state.world.grid, person.position, {
          cellId: drop.cellId,
          z: dropStandingZ(state, drop),
        }),
      }))
      .filter(({ path }) => path.length > 0)
      .sort((a, b) => a.path.length - b.path.length || a.drop.id.localeCompare(b.drop.id))[0];
    if (reachable) return actionForDrop(state, person, reachable.drop);
    if (intent.nextAction.kind === 'move') {
      const toCellId = intent.nextAction.toCellId;
      const atTarget = state.world.drops.find((drop) => drop.cellId === toCellId
        && drop.materialId === materialId
        && drop.quantity > 0
        && canPersonPlanToCollectProjectMaterialDrop(state, person.id, drop, atMonth));
      if (atTarget) return actionForDrop(state, person, atTarget);
    }
  }
  if (intent.goal.kind === 'body-at-least' && intent.goal.field === 'hydration') {
    const water = findReachableWater(state, person, visibleCellsFor(person));
    if (!water) return null;
    return person.position.cellId === water.bankPosition.cellId && person.position.z === water.bankPosition.z
      ? { kind: 'act', operation: 'ingest', targets: [{ kind: 'voxel', position: water.waterPosition }] }
      : { kind: 'move', toCellId: water.bankPosition.cellId, toZ: water.bankPosition.z };
  }
  if (intent.goal.kind === 'voxel-is' && intent.nextAction.kind === 'move') {
    const targetCell = intent.goal.position.x + intent.goal.position.y * state.world.grid.width;
    if (intent.goal.materialId === Material.CropSprout && distance(person.position.cellId, targetCell) <= 1) {
      const seed = person.inventory.find((stack) => stack.materialId === Material.Seed && stack.quantity > 0);
      if (seed) return { kind: 'act', operation: 'combine', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: seed.id }, { kind: 'voxel', position: intent.goal.position }] };
    }
  }
  return intent.nextAction.kind === 'move'
    && person.position.cellId === intent.nextAction.toCellId
    && (intent.nextAction.toZ === undefined || person.position.z === intent.nextAction.toZ)
    ? null
    : intent.nextAction;
}
