import type { WorldRef } from '../domain/action';
import { Material, materialHas, type MaterialId } from '../domain/material';
import type { DropState, SimulationState } from '../domain/model';
import {
  HIBERNATION_RECOVERY_SAFE_RESERVE,
  hibernationPhase,
  isAlive,
  sameLocation,
  type ItemStack,
  type PersonState,
} from '../domain/person';
import type {
  HibernationRescueBasis,
  ProjectProposal,
  ProjectState,
} from '../domain/project';
import { personReliablyKnowsOutput } from '../domain/project-knowledge-request';
import { findReachableLiquidWater, moveTowardWaterAccess } from '../domain/water-access';
import {
  cellId,
  cellsInRadius,
  findStandingPath,
  surfaceMaterial,
} from '../world/grid';
import { buildProjectPressureBasis } from './project-pressure';
import { reservation } from './projects/project-material-planning';
import type { ProjectStep } from './projects/project-step';

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function rescueActionable(
  state: SimulationState,
  sleeper: PersonState,
  condition: PersonState['conditions'][number],
  atMonth: number,
): boolean {
  if (state.civilization.epoch !== 'stable') return false;
  if (hibernationPhase(condition) === 'recovering') {
    return Math.min(sleeper.body.health, sleeper.body.hydration, sleeper.body.nutrition)
      < HIBERNATION_RECOVERY_SAFE_RESERVE;
  }
  const prediction = condition.triggerPredictionId
    ? state.eraPredictions.find((candidate) => candidate.id === condition.triggerPredictionId)
    : undefined;
  const predictionInvalidated = Boolean(prediction
    && (prediction.status !== 'pending' || atMonth > prediction.expiresAtMonth));
  const newStableEra = condition.sinceMonth < state.civilization.era.sinceMonth;
  const bodyEmergency = sleeper.body.health < 35
    || sleeper.body.hydration < 28
    || sleeper.body.nutrition < 28;
  return predictionInvalidated || newStableEra || bodyEmergency;
}

export function hibernationRescueProposal(
  state: SimulationState,
  helper: PersonState,
  visiblePeople: readonly PersonState[],
  atMonth: number,
): ProjectProposal | null {
  const candidate = visiblePeople
    .filter((person) => person.id !== helper.id && isAlive(person))
    .flatMap((sleeper) => sleeper.conditions
      .filter((condition) => condition.kind === 'dehydrated-hibernation'
        && rescueActionable(state, sleeper, condition, atMonth))
      .map((condition) => ({ sleeper, condition })))
    .sort((left, right) => {
      const leftReserve = Math.min(left.sleeper.body.health, left.sleeper.body.hydration, left.sleeper.body.nutrition);
      const rightReserve = Math.min(right.sleeper.body.health, right.sleeper.body.hydration, right.sleeper.body.nutrition);
      return leftReserve - rightReserve || left.sleeper.id.localeCompare(right.sleeper.id);
    })[0];
  if (!candidate) return null;
  const { sleeper, condition } = candidate;
  const prediction = condition.triggerPredictionId
    ? state.eraPredictions.find((item) => item.id === condition.triggerPredictionId)
    : undefined;
  const sourceFactIds = unique([
    ...condition.sourceEventIds,
    ...(prediction?.sourceEventIds ?? []),
  ]);
  if (!sourceFactIds.length) return null;
  const basis: HibernationRescueBasis = {
    version: 'hibernation-rescue-basis-v1',
    helperId: helper.id,
    sleeperId: sleeper.id,
    hibernationConditionId: condition.id,
    observedAtMonth: atMonth,
    lastKnownPosition: { cellId: sleeper.position.cellId, z: sleeper.position.z },
    ...(prediction ? { triggerPredictionId: prediction.id } : {}),
    sourceFactIds,
    // The causal subject is the sleeper's exact hibernation episode. Multiple
    // witnesses may contribute to one rescue project; helper identity belongs
    // in participant state rather than manufacturing duplicate projects.
    basisKey: `hibernation-rescue-v1|sleeper=${sleeper.id}|condition=${condition.id}|era=${state.civilization.era.sequence}`,
  };
  const proposal: ProjectProposal = {
    id: `project-hibernation-rescue-${condition.id}-era-${state.civilization.era.sequence}`,
    kind: 'inquiry',
    need: 'care-capability',
    desiredFunction: 'healing',
    summary: `使${sleeper.name}脱离脱水休眠并恢复安全身体储备`,
    ownerId: helper.id,
    beneficiaryIds: [sleeper.id],
    triggerFactIds: sourceFactIds,
    pressure: 0,
    createdAtMonth: atMonth,
    reviewAtMonth: atMonth + 24,
    site: { ...basis.lastKnownPosition },
    hibernationRescueBasis: basis,
  };
  const pressureBasis = buildProjectPressureBasis(state, helper, proposal, atMonth, {
    visiblePeople: [...visiblePeople],
  });
  proposal.pressureBasis = pressureBasis;
  proposal.pressure = pressureBasis.pressure;
  return proposal;
}

function portableWater(person: PersonState): ItemStack | undefined {
  return person.inventory.find((stack) => stack.materialId === Material.Water
    && stack.quantity > 0
    && typeof stack.containedByStackId === 'string'
    && person.inventory.some((container) => container.id === stack.containedByStackId
      && container.materialId === Material.Container
      && container.quantity > 0));
}

function emptyContainer(person: PersonState): ItemStack | undefined {
  return person.inventory.find((stack) => stack.materialId === Material.Container
    && stack.quantity > 0
    && !person.inventory.some((contents) => contents.containedByStackId === stack.id && contents.quantity > 0));
}

function visibleDropAcquisitionStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: readonly DropState[],
  project: ProjectState,
  materialId: MaterialId,
): ProjectStep | null {
  const candidates = visibleDrops
    .filter((drop) => drop.materialId === materialId && drop.quantity > 0)
    .map((drop) => ({ drop, path: findStandingPath(state.world.grid, person.position, { cellId: drop.cellId, z: drop.z }) }))
    .filter((candidate) => candidate.path.length > 0)
    .sort((left, right) => left.path.length - right.path.length || left.drop.id.localeCompare(right.drop.id));
  const candidate = candidates[0];
  if (!candidate) return null;
  const target: WorldRef = { kind: 'drop', dropId: candidate.drop.id };
  if (person.position.cellId !== candidate.drop.cellId || person.position.z !== candidate.drop.z) return {
    key: `rescue-approach-material-${project.id}-${candidate.drop.id}`,
    summary: `为休眠救援前往取得${materialId === Material.Container ? '可携带容器' : '木板'}`,
    reason: '救援所需物资位于本人当前可见且可达的位置，先完成真实移动',
    action: { kind: 'move', toCellId: candidate.drop.cellId, toZ: candidate.drop.z },
    target,
    sourceFactIds: [...candidate.drop.sourceEventIds],
    missingMaterialIds: [materialId],
    reservations: [],
  };
  return {
    key: `rescue-collect-material-${project.id}-${candidate.drop.id}`,
    summary: `为休眠救援取得${materialId === Material.Container ? '可携带容器' : '木板'}`,
    reason: '物资已经真实到达脚边，必须由转移动作进入背包',
    action: {
      kind: 'transfer',
      materialId,
      quantity: materialId === Material.Plank ? Math.min(2, candidate.drop.quantity) : 1,
      from: { kind: 'ground', cellId: candidate.drop.cellId, z: candidate.drop.z },
      to: { kind: 'person', personId: person.id },
      dropId: candidate.drop.id,
    },
    target,
    sourceFactIds: [...candidate.drop.sourceEventIds],
    missingMaterialIds: [materialId],
    reservations: [],
  };
}

function containerPreparationStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: readonly DropState[],
  project: ProjectState,
): ProjectStep | null {
  const visibleContainer = visibleDropAcquisitionStep(state, person, visibleDrops, project, Material.Container);
  if (visibleContainer) return visibleContainer;
  const planks = person.inventory.find((stack) => stack.materialId === Material.Plank && stack.quantity >= 2);
  if (planks && personReliablyKnowsOutput(person, Material.Container)) return {
    key: `rescue-craft-container-${project.id}-${planks.id}`,
    summary: '为运送救援用水制作可携带容器',
    reason: '本人可靠掌握木板容器做法，并持有两份真实木板',
    action: {
      kind: 'act',
      operation: 'combine',
      targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: planks.id },
        { kind: 'inventory-stack', personId: person.id, stackId: planks.id },
      ],
    },
    sourceFactIds: [...planks.sourceEventIds],
    missingMaterialIds: [],
    reservations: reservation(person, planks.id, 2),
  };
  return visibleDropAcquisitionStep(state, person, visibleDrops, project, Material.Plank);
}

export function hibernationRescueProjectStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: readonly DropState[],
  project: ProjectState,
): ProjectStep | null {
  const basis = project.hibernationRescueBasis;
  if (!basis
    || (basis.helperId !== person.id && !project.contributorIds.includes(person.id))
    || project.status !== 'active') return null;
  const sleeper = state.people.find((candidate) => candidate.id === basis.sleeperId && isAlive(candidate));
  const condition = sleeper?.conditions.find((candidate) => candidate.id === basis.hibernationConditionId
    && candidate.kind === 'dehydrated-hibernation');
  if (!sleeper || !condition) return null;
  const target: WorldRef = { kind: 'person', personId: sleeper.id };
  if (!sameLocation(person, sleeper)) {
    const visible = new Set(cellsInRadius(person.position.cellId, 4 + Math.floor(person.baselineCapacities.perception / 25)));
    const destination = visible.has(sleeper.position.cellId)
      ? { cellId: sleeper.position.cellId, z: sleeper.position.z }
      : basis.lastKnownPosition;
    const path = findStandingPath(state.world.grid, person.position, destination);
    if (!path.length) return null;
    return {
      key: `rescue-approach-sleeper-${project.id}-${destination.cellId}-${destination.z}`,
      summary: `前往${sleeper.name}最后确认的休眠位置`,
      reason: '本人已看到或有来源地记得休眠者的位置，必须先近身才能实施照护',
      action: { kind: 'move', toCellId: destination.cellId, toZ: destination.z },
      target,
      sourceFactIds: [...basis.sourceFactIds],
      missingMaterialIds: [],
      reservations: [],
    };
  }

  const waterNearby = cellsInRadius(person.position.cellId, 2).some((candidateCellId) => (
    materialHas(surfaceMaterial(state.world.grid, candidateCellId), 'drinkable')
  ));
  if (waterNearby) return {
    key: `rescue-rehydrate-nearby-${project.id}-${condition.id}`,
    summary: `用附近真实水源帮助${sleeper.name}恢复`,
    reason: '救援者、休眠者和真实可饮用水源已经近身，无需制造或运输额外物资',
    action: {
      kind: 'act',
      operation: 'rehydrate',
      targets: [target],
      ...(basis.triggerPredictionId ? { hibernationPredictionId: basis.triggerPredictionId } : {}),
    },
    target,
    sourceFactIds: [...basis.sourceFactIds],
    missingMaterialIds: [],
    reservations: [],
  };

  const water = portableWater(person);
  if (water) return {
    key: `rescue-rehydrate-${project.id}-${water.id}`,
    summary: `用随身容器中的水帮助${sleeper.name}恢复`,
    reason: '救援者、休眠者和有来源的携带水已经在同一位置，满足近身补水条件',
    action: {
      kind: 'act',
      operation: 'rehydrate',
      targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: water.id },
        target,
      ],
      ...(basis.triggerPredictionId ? { hibernationPredictionId: basis.triggerPredictionId } : {}),
    },
    target,
    sourceFactIds: unique([...basis.sourceFactIds, ...water.sourceEventIds]),
    missingMaterialIds: [],
    reservations: [],
  };

  if (hibernationPhase(condition) === 'recovering'
    && sleeper.body.nutrition < HIBERNATION_RECOVERY_SAFE_RESERVE) {
    const food = person.inventory.find((stack) => stack.quantity > 0
      && (stack.materialId === Material.Food || stack.materialId === Material.CookedFood));
    if (food) return {
      key: `rescue-transfer-food-${project.id}-${food.id}`,
      summary: `把食物交给正在恢复的${sleeper.name}`,
      reason: '休眠者已经清醒但营养仍低于安全储备，近身交付后由其本人摄入',
      action: {
        kind: 'transfer',
        materialId: food.materialId,
        quantity: 1,
        from: { kind: 'person', personId: person.id },
        to: { kind: 'person', personId: sleeper.id },
        stackId: food.id,
      },
      target,
      sourceFactIds: unique([...basis.sourceFactIds, ...food.sourceEventIds]),
      missingMaterialIds: [],
      reservations: reservation(person, food.id, 1),
    };
  }

  const container = emptyContainer(person);
  if (!container) return containerPreparationStep(state, person, visibleDrops, project);
  const reachableWater = findReachableLiquidWater(state, person);
  if (!reachableWater) return null;
  const atBank = person.position.cellId === reachableWater.bankPosition.cellId
    && person.position.z === reachableWater.bankPosition.z;
  if (!atBank) return {
    key: `rescue-approach-water-${project.id}-${reachableWater.bankPosition.cellId}-${reachableWater.bankPosition.z}`,
    summary: `为${sleeper.name}的休眠救援前往可达水源`,
    reason: reachableWater.remembered ? '本人记得这处水源且当前仍可达' : '本人看见了可达水源',
    action: moveTowardWaterAccess(reachableWater, state.clock.elapsedMonths + 1),
    target: { kind: 'voxel', position: reachableWater.waterPosition },
    sourceFactIds: unique([...basis.sourceFactIds, ...reachableWater.sourceEventIds]),
    missingMaterialIds: [Material.Water],
    reservations: [],
  };
  const waterCellId = cellId(reachableWater.waterPosition.x, reachableWater.waterPosition.y);
  return {
    key: `rescue-fill-water-${project.id}-${container.id}-${waterCellId}-${reachableWater.waterPosition.z}`,
    summary: `为${sleeper.name}的休眠救援装取一份水`,
    reason: '空容器和真实水源已经近身，装取后必须把同一份水带回休眠者身边',
    action: {
      kind: 'transfer',
      materialId: Material.Water,
      quantity: 1,
      from: { kind: 'ground', cellId: waterCellId, z: reachableWater.waterPosition.z },
      to: { kind: 'person', personId: person.id },
      containerStackId: container.id,
    },
    target: { kind: 'voxel', position: reachableWater.waterPosition },
    sourceFactIds: unique([...basis.sourceFactIds, ...reachableWater.sourceEventIds]),
    missingMaterialIds: [],
    reservations: [],
  };
}
