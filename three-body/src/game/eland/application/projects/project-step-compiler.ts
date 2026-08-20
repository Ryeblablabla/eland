import type { ActionOption, WorldRef } from '../../domain/action';
import {
  inventoryCombinationForOutput,
  inventoryCombinationRules,
  inventoryCombinationTechniqueId,
  type ExertionRule,
  type InventoryCombinationRule,
} from '../../domain/interaction-rules';
import { Material, materialDefinition, materialHas, type MaterialId } from '../../domain/material';
import { bestProductionToolStack, productionToolRank } from '../../domain/production-tool';
import type { DropState, SimulationState } from '../../domain/model';
import {
  inventoryQuantity,
  isAlive,
  sameLocation,
  type ItemStack,
  type PersonState,
} from '../../domain/person';
import type {
  ProjectFunction,
  ProjectHypothesisQuestionKind,
  ProjectMaterialDemand,
  ProjectProposal,
  ProjectState,
} from '../../domain/project';
import { shelterGeometryAt } from '../../domain/structure';
import { inspectProjectMaterialContributionRequest } from '../../domain/project-material-request';
import { findCurrentVisibleStoredMaterialAccess, retrieveStoredMaterialOrMove } from '../../domain/stored-food-access';
import {
  cellX,
  cellY,
  findStandingPath,
  neighbors4,
  standingPositions,
  surfaceMaterial,
  topPosition,
  voxelAt,
} from '../../world/grid';
import { seededFraction } from '../../world/generator';
import { closeProjectHypothesisCampaign } from '../project-hypotheses';
import {
  mechanicalPowerMissingMaterials,
  mechanicalPowerProjectStep,
} from '../mechanical-power-options';
import {
  completedFunctionMaterialIds,
  cultivationSurfaceMaterials,
  durableRecordWriteEvidence,
  placedFunctionEvidence,
  placedFunctionMaterialIds,
  plantableCultivationMaterials,
  projectActionFacts,
  projectCultivationCells,
  projectCultivationHarvests,
  projectProductionToolBaselineRank,
  verifiedProductionToolFunctions,
} from './project-completion';
import {
  activeEpisodeStep,
  activeLogisticsEpisode,
  startDropLogisticsEpisode,
  startSearchLogisticsEpisode,
  startSourceLogisticsEpisode,
  visibleMaterialSource,
  visibleReachableSearchDestination,
} from './project-logistics';
import {
  consumableInventoryQuantity,
  dropStep,
  isConsumableProjectStack,
  materialDemand,
  nearestDrop,
  nearestRememberedDrop,
  reservation,
} from './project-material-planning';
import { locallyKnownPlacedContainer, visibleCellsFor } from './project-perception';
import {
  activeHypothesisCandidate,
  blankRecordCarrier,
  hypothesisStep,
  inventorySourceKey,
  questionAllowsAnotherExert,
  reliableExertionTechniques,
  reliableExposureTechniques,
  sourceEventIdsForTarget,
  stacksForCandidateSlots,
  tentativeTechniqueStep,
  type CandidateInventorySlot,
  type ReliableExertionTechnique,
} from './project-inquiry';
import {
  localHotTarget,
  localOpenExertionTarget,
  localTargetForKnownExertion,
  visiblePlacementApproach,
  type LocalVoxelTarget,
} from './project-spatial-planning';
import type { ProjectStep } from './project-step';
import { fixedFacilityWorkplace } from './project-workplace';
function knownRecipe(person: PersonState, outputMaterialId: MaterialId): { rule: InventoryCombinationRule; knowledgeId: string } | null {
  const rule = inventoryCombinationForOutput(outputMaterialId);
  if (!rule) return null;
  const knowledgeId = inventoryCombinationTechniqueId(rule);
  return person.knowledge.some((fact) => fact.id === knowledgeId && fact.confidence >= 55)
    ? { rule, knowledgeId }
    : null;
}

function reliableKnownRecipe(
  person: PersonState,
  outputFits: (materialId: MaterialId) => boolean,
): { rule: InventoryCombinationRule; knowledgeId: string } | null {
  for (const fact of person.knowledge) {
    if (fact.kind !== 'technique' || fact.confidence < 55) continue;
    const rule = inventoryCombinationRules().find((candidate) => inventoryCombinationTechniqueId(candidate) === fact.id);
    if (rule && outputFits(rule.output.materialId)) return { rule, knowledgeId: fact.id };
  }
  return null;
}

function stackRefsForRule(person: PersonState, rule: InventoryCombinationRule): Extract<WorldRef, { kind: 'inventory-stack' }>[] | null {
  const refs: Extract<WorldRef, { kind: 'inventory-stack' }>[] = [];
  for (const input of rule.inputs) {
    const stack = person.inventory.find((candidate) => candidate.materialId === input.materialId
      && isConsumableProjectStack(candidate)
      && candidate.quantity >= input.quantity);
    if (!stack) return null;
    for (let count = 0; count < input.quantity; count += 1) refs.push({ kind: 'inventory-stack', personId: person.id, stackId: stack.id });
  }
  return refs;
}

function compileKnownOutput(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  outputMaterialId: MaterialId,
  purpose: string,
  visited = new Set<MaterialId>(),
): ProjectStep | null {
  if (visited.has(outputMaterialId)) return null;
  visited.add(outputMaterialId);
  const known = knownRecipe(person, outputMaterialId);
  if (!known) return null;
  const knowledge = person.knowledge.find((fact) => fact.id === known.knowledgeId);
  const deficits = known.rule.inputs
    .filter((input) => consumableInventoryQuantity(person, input.materialId) < input.quantity);
  const missing = deficits.map((input) => input.materialId);
  if (missing.length) {
    const drop = nearestDrop(state, person, visibleDrops, missing);
    if (drop) {
      const input = deficits.find((candidate) => candidate.materialId === drop.materialId);
      const demand = materialDemand(
        person,
        drop.materialId,
        input?.quantity ?? 1,
        `known-recipe:${known.rule.id}:${drop.materialId}`,
        knowledge?.sourceEventIds ?? [],
      );
      const step = dropStep(person, drop, purpose, demand);
      if (step) return { ...step, planKnowledgeId: known.knowledgeId, missingMaterialIds: missing };
    }
    for (const materialId of missing) {
      const nested = compileKnownOutput(state, person, visibleDrops, materialId, purpose, new Set(visited));
      if (nested) return { ...nested, missingMaterialIds: missing };
    }
    return null;
  }
  const refs = stackRefsForRule(person, known.rule);
  if (!refs) return null;
  const reservations = refs.flatMap((ref) => reservation(person, ref.stackId));
  return {
    key: `known-recipe-${known.rule.id}`,
    summary: `按已核验经验制作${materialDefinition(outputMaterialId).name}`,
    reason: '本人已经核验这项制作经验，并已持有所有前置材料',
    action: { kind: 'act', operation: 'combine', targets: refs },
    sourceFactIds: [...new Set([
      ...(knowledge?.sourceEventIds ?? []),
      ...refs.flatMap((ref) => person.inventory.find((stack) => stack.id === ref.stackId)?.sourceEventIds ?? []),
    ])],
    missingMaterialIds: [],
    reservations,
    planKnowledgeId: known.knowledgeId,
  };
}

interface ProjectMaterialRequirement {
  materialIds: MaterialId[];
  demands: ProjectMaterialDemand[];
  sourceEventIds: string[];
  planKnowledgeId?: string;
}

function knownOutputRequirement(
  person: PersonState,
  outputMaterialId: MaterialId,
  visited = new Set<MaterialId>(),
): ProjectMaterialRequirement | null {
  if (visited.has(outputMaterialId)) return null;
  visited.add(outputMaterialId);
  const known = knownRecipe(person, outputMaterialId);
  if (!known) return null;
  const knowledge = person.knowledge.find((fact) => fact.id === known.knowledgeId);
  const demands: ProjectMaterialDemand[] = [];
  const sourceEventIds = [...(knowledge?.sourceEventIds ?? [])];
  for (const input of known.rule.inputs) {
    if (consumableInventoryQuantity(person, input.materialId) >= input.quantity) continue;
    const nested = knownOutputRequirement(person, input.materialId, new Set(visited));
    if (nested?.demands.length) {
      demands.push(...nested.demands);
      sourceEventIds.push(...nested.sourceEventIds);
    } else {
      demands.push(materialDemand(
        person,
        input.materialId,
        input.quantity,
        `known-requirement:${known.rule.id}:${input.materialId}`,
        knowledge?.sourceEventIds ?? [],
      ));
    }
  }
  return {
    materialIds: [...new Set(demands.filter((demand) => demand.outstandingQuantity > 0).map((demand) => demand.materialId))],
    demands: demands.filter((demand) => demand.outstandingQuantity > 0),
    sourceEventIds: [...new Set(sourceEventIds)],
    planKnowledgeId: known.knowledgeId,
  };
}

function exertionInputQuantities(rule: ExertionRule): Map<MaterialId, number> {
  const quantities = new Map<MaterialId, number>();
  quantities.set(rule.toolMaterialId, (quantities.get(rule.toolMaterialId) ?? 0) + 1);
  quantities.set(rule.inputMaterialId, (quantities.get(rule.inputMaterialId) ?? 0) + 1);
  return quantities;
}

function knownExertionRequirement(
  person: PersonState,
  technique: ReliableExertionTechnique,
): ProjectMaterialRequirement | null {
  const demands: ProjectMaterialDemand[] = [];
  const sourceEventIds = [...technique.sourceEventIds];
  for (const [materialId, quantity] of exertionInputQuantities(technique.rule)) {
    if (consumableInventoryQuantity(person, materialId) >= quantity) continue;
    const nested = knownOutputRequirement(person, materialId);
    if (nested?.demands.length) {
      demands.push(...nested.demands);
      sourceEventIds.push(...nested.sourceEventIds);
      continue;
    }
    demands.push(materialDemand(
      person,
      materialId,
      quantity,
      `known-exertion:${technique.rule.id}:${materialId}`,
      technique.sourceEventIds,
    ));
  }
  const outstanding = demands.filter((demand) => demand.outstandingQuantity > 0);
  return outstanding.length ? {
    materialIds: [...new Set(outstanding.map((demand) => demand.materialId))],
    demands: outstanding,
    sourceEventIds: [...new Set(sourceEventIds)],
    planKnowledgeId: technique.knowledgeId,
  } : null;
}

function reliableHeatTechnique(person: PersonState): ReliableExertionTechnique | undefined {
  return reliableExertionTechniques(person).find((technique) => technique.rule.outputLocation === 'world'
    && materialHas(technique.rule.outputMaterialId, 'hot'));
}

function reliableRecordCarrierTechnique(person: PersonState): ReliableExertionTechnique | undefined {
  return reliableExertionTechniques(person).find((technique) => technique.rule.outputLocation === 'inventory'
    && materialHas(technique.rule.outputMaterialId, 'recordable'));
}

function reliableRecordCarrierRecipe(person: PersonState): { rule: InventoryCombinationRule; knowledgeId: string } | null {
  return reliableKnownRecipe(person, (materialId) => materialHas(materialId, 'recordable'));
}

function reliableMissingManipulatorRecipe(person: PersonState): { rule: InventoryCombinationRule; knowledgeId: string } | null {
  return reliableKnownRecipe(person, (materialId) => materialHas(materialId, 'tool')
    && inventoryQuantity(person, materialId) === 0);
}

function projectMaterialRequirement(state: SimulationState, person: PersonState, project: ProjectState): ProjectMaterialRequirement | null {
  const rawRequirements = new Map<MaterialId, number>();
  const requireRaw = (materialId: MaterialId, quantity: number) => {
    if (consumableInventoryQuantity(person, materialId) < quantity) rawRequirements.set(materialId, Math.max(
      rawRequirements.get(materialId) ?? 0, quantity,
    ));
  };
  if (project.desiredFunction === 'water-powered-crop-processing') {
    for (const materialId of mechanicalPowerMissingMaterials(state, person, project)) requireRaw(materialId, 1);
  }
  if (project.desiredFunction === 'efficient-production') {
    requireRaw(Material.Wood, 1);
    if (consumableInventoryQuantity(person, Material.Rope) === 0) requireRaw(Material.Fiber, 2);
  }
  if (project.desiredFunction === 'settled-cultivation') {
    requireRaw(Material.Seed, 1);
  }
  if (project.desiredFunction === 'community-coordination') {
    if (consumableInventoryQuantity(person, Material.Plank) === 0) requireRaw(Material.Wood, 2);
    if (consumableInventoryQuantity(person, Material.Rope) === 0) requireRaw(Material.Fiber, 2);
  }
  if (project.desiredFunction === 'reserve-storage' || project.desiredFunction === 'reliable-water') {
    const hasContainer = consumableInventoryQuantity(person, Material.Container) > 0
      || state.containers.some((container) => locallyKnownPlacedContainer(state, person, container));
    if (project.desiredFunction === 'reserve-storage') {
      if (!hasContainer && consumableInventoryQuantity(person, Material.Plank) < 3) requireRaw(Material.Wood, 4);
      if (hasContainer && consumableInventoryQuantity(person, Material.Plank) < 1) requireRaw(Material.Wood, 2);
    } else {
      if (!hasContainer && consumableInventoryQuantity(person, Material.Plank) < 2) requireRaw(Material.Wood, 2);
      requireRaw(Material.Stone, 1);
    }
  }
  if (project.desiredFunction === 'crop-processing') {
    requireRaw(Material.Stone, 1);
    if (consumableInventoryQuantity(person, Material.Plank) === 0) requireRaw(Material.Wood, 2);
  }
  if (project.desiredFunction === 'high-heat-processing') {
    requireRaw(Material.Clay, 1);
    requireRaw(Material.Stone, 1);
  }
  if (project.desiredFunction === 'copper-charge' || project.desiredFunction === 'tin-charge') {
    requireRaw(project.desiredFunction === 'copper-charge' ? Material.CopperOre : Material.TinOre, 1);
    if (consumableInventoryQuantity(person, Material.Charcoal) === 0) {
      requireRaw(Material.Charcoal, 1);
      // A fixed kiln can turn ordinary wood into the missing charcoal; keeping
      // wood as a separate demand lets a contributor or visible source supply it.
      requireRaw(Material.Wood, 1);
    }
  }
  if (project.desiredFunction === 'copper-smelting') requireRaw(Material.CopperCharge, 1);
  if (project.desiredFunction === 'tin-smelting') requireRaw(Material.TinCharge, 1);
  if (project.desiredFunction === 'bronze-alloying') {
    requireRaw(Material.Copper, 1);
    requireRaw(Material.Tin, 1);
  }
  if (project.desiredFunction === 'bronze-tooling') {
    requireRaw(Material.Bronze, 1);
    requireRaw(Material.Wood, 1);
  }
  if (project.desiredFunction === 'bronze-workshop') {
    requireRaw(Material.Bronze, 1);
    requireRaw(Material.Stone, 1);
  }
  const rawDemands = [...rawRequirements].map(([materialId, quantity]) => materialDemand(
    person, materialId, quantity, `development-subassembly:${project.desiredFunction}:${materialId}`,
  )).filter((demand) => demand.outstandingQuantity > 0);
  if (rawDemands.length) return {
    materialIds: rawDemands.map((demand) => demand.materialId),
    demands: rawDemands,
    sourceEventIds: [...new Set(project.triggerFactIds)],
  };
  if (project.desiredFunction === 'weather-shelter') {
    if (buildingStack(person)) return null;
    return {
      materialIds: [Material.Stone, Material.Wood, Material.Plank],
      demands: [Material.Stone, Material.Wood, Material.Plank].map((materialId) => materialDemand(
        person, materialId, 1, `shelter-building-substitute:${materialId}`,
      )),
      sourceEventIds: [],
    };
  }
  if (project.desiredFunction === 'prepared-food') {
    const raw = person.inventory.find((stack) => stack.quantity > 0
      && (stack.materialId === Material.RawMeat || stack.materialId === Material.Food));
    if (!raw) return {
      materialIds: [Material.RawMeat, Material.Food],
      demands: [Material.RawMeat, Material.Food].map((materialId) => materialDemand(
        person, materialId, 1, `prepared-food-input-substitute:${materialId}`,
      )),
      sourceEventIds: [],
    };
    const knownHeat = reliableHeatTechnique(person);
    if (knownHeat) return knownExertionRequirement(person, knownHeat);
    const knownManipulator = reliableMissingManipulatorRecipe(person);
    if (knownManipulator) return knownOutputRequirement(person, knownManipulator.rule.output.materialId);
    return null;
  }
  if (project.desiredFunction === 'durable-record') {
    if (blankRecordCarrier(person)) return null;
    const knownCarrierRecipe = reliableRecordCarrierRecipe(person);
    if (knownCarrierRecipe) return knownOutputRequirement(person, knownCarrierRecipe.rule.output.materialId);
    const knownCarrierTechnique = reliableRecordCarrierTechnique(person);
    if (knownCarrierTechnique) return knownExertionRequirement(person, knownCarrierTechnique);
    const knownManipulator = reliableMissingManipulatorRecipe(person);
    if (knownManipulator) return knownOutputRequirement(person, knownManipulator.rule.output.materialId);
    return null;
  }
  for (const output of completedFunctionMaterialIds(project)) {
    const known = knownOutputRequirement(person, output);
    if (known?.materialIds.length) return known;
  }
  return null;
}

function combineSubassemblyStep(
  person: PersonState,
  firstMaterialId: MaterialId,
  secondMaterialId: MaterialId,
  outputName: string,
  purpose: string,
): ProjectStep | null {
  const first = person.inventory.find((stack) => stack.materialId === firstMaterialId
    && isConsumableProjectStack(stack)
    && stack.quantity >= (firstMaterialId === secondMaterialId ? 2 : 1));
  const second = firstMaterialId === secondMaterialId
    ? first
    : person.inventory.find((stack) => stack.materialId === secondMaterialId && isConsumableProjectStack(stack));
  if (!first || !second) return null;
  return {
    key: `project-subassembly-${firstMaterialId}-${secondMaterialId}-${first.id}-${second.id}`,
    summary: `为${purpose}先尝试制作${outputName}`,
    reason: '压力已经形成长期项目；人物按手中材料的可见形状与既有加工经验制作必要子组件，实体规则仍决定是否产生响应',
    action: {
      kind: 'act', operation: 'combine', targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: first.id },
        { kind: 'inventory-stack', personId: person.id, stackId: second.id },
      ],
    },
    sourceFactIds: [...new Set([...first.sourceEventIds, ...second.sourceEventIds])],
    missingMaterialIds: [],
    reservations: [
      ...reservation(person, first.id),
      ...reservation(person, second.id),
    ],
  };
}

function developmentSubassemblyStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): ProjectStep | null {
  const needsRope = ['efficient-production', 'community-coordination'].includes(project.desiredFunction);
  if (needsRope && consumableInventoryQuantity(person, Material.Rope) === 0) {
    const rope = combineSubassemblyStep(person, Material.Fiber, Material.Fiber, '绳索', project.summary);
    if (rope) return rope;
  }
  const needsPlank = [
    'community-coordination', 'reserve-storage', 'reliable-water', 'crop-processing',
    'workshop-production',
  ].includes(project.desiredFunction);
  const requiredPlanks = ['reserve-storage', 'reliable-water'].includes(project.desiredFunction)
    && !state.containers.some((container) => locallyKnownPlacedContainer(state, person, container))
    && consumableInventoryQuantity(person, Material.Container) === 0
    ? project.desiredFunction === 'reserve-storage' ? 3 : 2
    : project.desiredFunction === 'reserve-storage' ? 1 : 0;
  if (needsPlank && consumableInventoryQuantity(person, Material.Plank) < requiredPlanks) {
    const plank = combineSubassemblyStep(person, Material.Wood, Material.Wood, '木板', project.summary);
    if (plank) return plank;
  }
  const needsTablet = ['workshop-production', 'civic-coordination'].includes(project.desiredFunction);
  if (needsTablet && consumableInventoryQuantity(person, Material.WoodTablet) === 0) {
    const tool = person.inventory.find((stack) => stack.materialId === Material.StoneTool && stack.quantity > 0);
    const wood = person.inventory.find((stack) => stack.materialId === Material.Wood && isConsumableProjectStack(stack));
    const target = tool && wood ? localOpenExertionTarget(state, person) : null;
    if (tool && wood && target) return {
      key: `project-subassembly-tablet-${tool.id}-${wood.id}`,
      summary: `为${project.summary}先制作可记录的木牍`,
      reason: '固定工坊和公共厅堂都需要可携带的记录载体，人物使用已经在手的硬质工具和木料尝试加工',
      action: {
        kind: 'act', operation: 'exert', toolStackId: tool.id,
        targets: [
          { kind: 'inventory-stack', personId: person.id, stackId: wood.id },
          { kind: 'voxel', position: target.position },
        ],
      },
      target: { kind: 'voxel', position: target.position },
      sourceFactIds: [...new Set([...tool.sourceEventIds, ...wood.sourceEventIds])],
      missingMaterialIds: [],
      reservations: [...reservation(person, tool.id), ...reservation(person, wood.id)],
    };
  }
  return null;
}

function containerUpgradeStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): ProjectStep | null {
  const inputMaterialId = project.desiredFunction === 'reserve-storage'
    ? Material.Plank
    : project.desiredFunction === 'reliable-water'
      ? Material.Stone
      : undefined;
  if (inputMaterialId === undefined) return null;
  const carriedContainer = person.inventory.find((candidate) => candidate.materialId === Material.Container
    && isConsumableProjectStack(candidate));
  const stack = person.inventory.find((candidate) => candidate.materialId === inputMaterialId
    && isConsumableProjectStack(candidate));
  if (carriedContainer && stack) {
    return {
      key: `prepare-container-upgrade-${carriedContainer.id}-${stack.id}`,
      summary: `用${materialDefinition(inputMaterialId).name}加固木制容器，准备设置为${project.desiredFunction === 'reserve-storage' ? '公共谷仓' : '蓄水井'}`,
      reason: '公共设施仍要经过真实容器和结构材料两项前置；先完成可携带构件，随后必须把成品设置到实体空间才产生功能',
      action: {
        kind: 'act', operation: 'combine', targets: [
          { kind: 'inventory-stack', personId: person.id, stackId: carriedContainer.id },
          { kind: 'inventory-stack', personId: person.id, stackId: stack.id },
        ],
      },
      sourceFactIds: [...new Set([...carriedContainer.sourceEventIds, ...stack.sourceEventIds])],
      missingMaterialIds: [],
      reservations: [...reservation(person, carriedContainer.id), ...reservation(person, stack.id)],
    };
  }
  const hasPlacedContainer = state.containers.some((container) => locallyKnownPlacedContainer(state, person, container));
  const plankStack = person.inventory.find((candidate) => candidate.materialId === Material.Plank
    && isConsumableProjectStack(candidate)
    && candidate.quantity >= 2);
  if (!hasPlacedContainer && plankStack) return {
    key: `make-container-for-upgrade-${plankStack.id}`,
    summary: '先把两份木板结合成公共设施所需的木制容器',
    reason: '项目不会绕过容器前置；人口或缺水压力只让人物主动解决这个可观察的结构缺口',
    action: {
      kind: 'act', operation: 'combine', targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: plankStack.id },
        { kind: 'inventory-stack', personId: person.id, stackId: plankStack.id },
      ],
    },
    sourceFactIds: [...plankStack.sourceEventIds],
    missingMaterialIds: [],
    reservations: reservation(person, plankStack.id, 2),
  };
  if (!stack) return null;
  const candidates = state.containers.flatMap((container) => {
    if (!locallyKnownPlacedContainer(state, person, container)) return [];
    const containerCell = container.position.x + container.position.y * state.world.grid.width;
    const access = neighbors4(containerCell).flatMap((cellId) => standingPositions(state.world.grid, cellId))
      .map((position) => ({ position, path: findStandingPath(state.world.grid, person.position, position) }))
      .filter((candidate) => candidate.path.length > 0)
      .sort((left, right) => left.path.length - right.path.length || left.position.cellId - right.position.cellId)[0];
    return access ? [{ container, access }] : [];
  }).sort((left, right) => left.access.path.length - right.access.path.length);
  const selected = candidates[0];
  if (!selected) return null;
  const target = { ...selected.container.position };
  const horizontal = Math.abs(cellX(person.position.cellId) - target.x) + Math.abs(cellY(person.position.cellId) - target.y);
  const vertical = Math.max(0, Math.abs(person.position.z - target.z) - 1);
  if (Math.max(horizontal, vertical) > 1) return {
    key: `approach-container-upgrade-${selected.container.id}`,
    summary: `前往木制容器，将它改造为${project.desiredFunction === 'reserve-storage' ? '公共谷仓' : '蓄水井'}`,
    reason: '已有容器是真实的前置设施，项目先抵达它的可操作位置，再投入结构材料',
    action: { kind: 'move', toCellId: selected.access.position.cellId, toZ: selected.access.position.z },
    target: { kind: 'container', containerId: selected.container.id },
    sourceFactIds: [...new Set([...stack.sourceEventIds, ...selected.container.sourceEventIds])],
    missingMaterialIds: [],
    reservations: reservation(person, stack.id),
  };
  return {
    key: `upgrade-container-${selected.container.id}-${inputMaterialId}`,
    summary: `用${materialDefinition(inputMaterialId).name}把木制容器改造成${project.desiredFunction === 'reserve-storage' ? '公共谷仓' : '蓄水井'}`,
    reason: '人口和环境压力已经指向公共储备或供水；改造保留实体容器这一材料前置，而不是凭空生成建筑',
    action: {
      kind: 'act', operation: 'combine', targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: stack.id },
        { kind: 'voxel', position: target },
      ],
    },
    target: { kind: 'voxel', position: target },
    sourceFactIds: [...new Set([...stack.sourceEventIds, ...selected.container.sourceEventIds])],
    missingMaterialIds: [],
    reservations: reservation(person, stack.id),
  };
}

function reserveStockingStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  project: ProjectState,
): ProjectStep | null {
  if (project.desiredFunction !== 'reserve-storage') return null;
  const placement = placedFunctionEvidence(state, project)[0];
  const position = placement?.diff.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
  const container = placement ? state.containers.find((candidate) => candidate.position.x === Number(position?.x)
    && candidate.position.y === Number(position?.y)
    && candidate.position.z === Number(position?.z)) : undefined;
  if (!container) return null;
  const foodStack = person.inventory
    .filter((stack) => stack.quantity > 0
      && (materialHas(stack.materialId, 'seed')
        || (materialHas(stack.materialId, 'edible') && person.body.nutrition >= 45)))
    .sort((left, right) => Number(materialHas(right.materialId, 'edible')) - Number(materialHas(left.materialId, 'edible'))
      || right.quantity - left.quantity
      || left.materialId - right.materialId)[0];
  if (foodStack) {
    const containerCellId = container.position.x + container.position.y * state.world.grid.width;
    const horizontal = Math.abs(cellX(person.position.cellId) - container.position.x)
      + Math.abs(cellY(person.position.cellId) - container.position.y);
    const vertical = Math.max(0, Math.abs(person.position.z - container.position.z) - 1);
    if (Math.max(horizontal, vertical) <= 1) return {
      key: `stock-project-granary-${container.id}-${foodStack.id}`,
      summary: `把${materialDefinition(foodStack.materialId).name}存入刚建成的公共谷仓`,
      reason: '谷仓只有开始承接真实粮食或种子，才算缓解了人口与天气压力；项目不会在空仓落成时提前完成',
      action: {
        kind: 'transfer', materialId: foodStack.materialId, quantity: 1,
        from: { kind: 'person', personId: person.id },
        to: { kind: 'container', containerId: container.id },
        stackId: foodStack.id,
      },
      target: { kind: 'container', containerId: container.id },
      sourceFactIds: [...new Set([placement.id, ...foodStack.sourceEventIds])],
      missingMaterialIds: [],
      reservations: reservation(person, foodStack.id),
    };
    const access = neighbors4(containerCellId)
      .flatMap((cellId) => standingPositions(state.world.grid, cellId))
      .map((candidate) => ({ candidate, path: findStandingPath(state.world.grid, person.position, candidate) }))
      .filter((candidate) => candidate.path.length > 0)
      .sort((left, right) => left.path.length - right.path.length
        || left.candidate.cellId - right.candidate.cellId
        || left.candidate.z - right.candidate.z)[0];
    if (access) return {
      key: `approach-project-granary-${container.id}`,
      summary: '把项目粮食带到刚建成的公共谷仓',
      reason: '谷仓是本人刚设置并仍有项目证据的固定地点；先抵达可操作位置，再执行真实转移',
      action: { kind: 'move', toCellId: access.candidate.cellId, toZ: access.candidate.z },
      target: { kind: 'container', containerId: container.id },
      sourceFactIds: [...new Set([placement.id, ...foodStack.sourceEventIds])],
      missingMaterialIds: [],
      reservations: reservation(person, foodStack.id),
    };
  }
  const foodDrop = nearestDrop(
    state,
    person,
    visibleDrops.filter((drop) => materialHas(drop.materialId, 'edible') || materialHas(drop.materialId, 'seed')),
    visibleDrops.map((drop) => drop.materialId),
  );
  return foodDrop ? dropStep(
    person,
    foodDrop,
    '给刚建成的公共谷仓形成第一批真实储备',
    materialDemand(person, foodDrop.materialId, 1, `stock-granary:${container.id}:${foodDrop.materialId}`, [placement.id]),
  ) : null;
}

function compileKnownExertionStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  project: ProjectState,
  technique: ReliableExertionTechnique,
): ProjectStep | null {
  const target = localTargetForKnownExertion(state, person, technique.rule);
  if (!target) return null;
  const slots: CandidateInventorySlot[] = [
    { materialId: technique.rule.toolMaterialId },
    { materialId: technique.rule.inputMaterialId },
  ];
  const stacks = stacksForCandidateSlots(person, slots, new Set());
  if (!stacks) {
    const missing = [...exertionInputQuantities(technique.rule)]
      .filter(([materialId, quantity]) => consumableInventoryQuantity(person, materialId) < quantity)
      .map(([materialId]) => materialId);
    const drop = nearestDrop(state, person, visibleDrops, missing);
    if (drop) {
      const requiredQuantity = exertionInputQuantities(technique.rule).get(drop.materialId) ?? 1;
      const demand = materialDemand(
        person,
        drop.materialId,
        requiredQuantity,
        `known-exertion:${technique.rule.id}:${drop.materialId}`,
        technique.sourceEventIds,
      );
      const step = dropStep(person, drop, project.summary, demand);
      if (step) return { ...step, missingMaterialIds: missing, planKnowledgeId: technique.knowledgeId };
    }
    for (const materialId of missing) {
      const nested = compileKnownOutput(state, person, visibleDrops, materialId, project.summary);
      if (nested) return { ...nested, missingMaterialIds: missing };
    }
    return null;
  }
  const [tool, input] = stacks;
  return {
    key: `known-exertion-${technique.rule.id}-${tool.id}-${input.id}`,
    summary: `按已核验经验得到${materialDefinition(technique.rule.outputMaterialId).name}`,
    reason: '本人已经核验这项完整施力经验；具体输入、目标和结果来自该经验对应的权威物质规则',
    action: {
      kind: 'act',
      operation: 'exert',
      toolStackId: tool.id,
      targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: input.id },
        { kind: 'voxel', position: target.position },
      ],
    },
    target: { kind: 'voxel', position: target.position },
    sourceFactIds: [...new Set([
      ...technique.sourceEventIds,
      ...tool.sourceEventIds,
      ...input.sourceEventIds,
    ])],
    missingMaterialIds: [],
    reservations: [...reservation(person, tool.id), ...reservation(person, input.id)],
    planKnowledgeId: technique.knowledgeId,
  };
}

function compileKnownExposureStep(
  person: PersonState,
  project: ProjectState,
  subject: ItemStack,
  target: LocalVoxelTarget,
  allowedOutputMaterialIds = completedFunctionMaterialIds(project),
): ProjectStep | null {
  if (!isConsumableProjectStack(subject)) return null;
  const desiredOutputs = new Set(allowedOutputMaterialIds);
  const technique = reliableExposureTechniques(person).find((candidate) => (
    candidate.rule.inputMaterialId === subject.materialId
      && candidate.rule.targetMaterialId === target.materialId
      && desiredOutputs.has(candidate.rule.outputMaterialId)
  ));
  if (!technique) return null;
  return {
    key: `known-exposure-${technique.rule.id}-${subject.id}`,
    summary: `按已核验经验得到${materialDefinition(technique.rule.outputMaterialId).name}`,
    reason: '本人已经核验这项完整接触经验；当前 subject 与眼前目标都和经验中的实体条件一致',
    action: {
      kind: 'act',
      operation: 'expose',
      targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: subject.id },
        { kind: 'voxel', position: target.position },
      ],
    },
    target: { kind: 'voxel', position: target.position },
    sourceFactIds: [...new Set([...technique.sourceEventIds, ...subject.sourceEventIds])],
    missingMaterialIds: [],
    reservations: reservation(person, subject.id),
    planKnowledgeId: technique.knowledgeId,
  };
}

function metallurgyWorkStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  project: ProjectState,
): ProjectStep | null {
  const metallurgyFunctions = new Set<ProjectFunction>([
    'copper-charge', 'copper-smelting', 'tin-charge', 'tin-smelting',
    'bronze-alloying', 'bronze-tooling', 'bronze-workshop',
  ]);
  if (!metallurgyFunctions.has(project.desiredFunction)) return null;
  const workplace = fixedFacilityWorkplace(state, person, project.site);
  if (!workplace) return null;
  const atWorkplace = person.position.cellId === workplace.workingPosition.cellId
    && person.position.z === workplace.workingPosition.z;
  if (!atWorkplace) return {
    key: `approach-metallurgy-site-${project.id}-${workplace.workingPosition.cellId}-${workplace.workingPosition.z}`,
    summary: `前往固定冶炼工地继续${project.summary}`,
    reason: '冶炼材料、贡献者和高温设施需要汇合到同一处固定地点，项目不会追逐移动中的持料者',
    action: {
      kind: 'move',
      toCellId: workplace.workingPosition.cellId,
      toZ: workplace.workingPosition.z,
    },
    target: { kind: 'voxel', position: workplace.target.position },
    sourceFactIds: [...new Set([
      ...project.triggerFactIds,
      ...person.knownPlaces
        .filter((place) => place.materialId === workplace.target.materialId
          && place.position.x === workplace.target.position.x
          && place.position.y === workplace.target.position.y
          && place.position.z === workplace.target.position.z)
        .flatMap((place) => place.sourceEventIds),
    ])],
    missingMaterialIds: [...project.missingMaterialIds],
    materialDemands: structuredClone(project.materialDemands ?? []),
    reservations: [],
  };

  if ((project.desiredFunction === 'copper-charge' || project.desiredFunction === 'tin-charge')
    && consumableInventoryQuantity(person, Material.Charcoal) === 0) {
    const wood = person.inventory.find((stack) => stack.materialId === Material.Wood && isConsumableProjectStack(stack));
    if (!wood) return null;
    const known = compileKnownExposureStep(person, project, wood, workplace.target, [Material.Charcoal]);
    if (known) return known;
    return hypothesisStep(state, person, visibleDrops, project, {
      operation: 'expose-local',
      questionKind: 'transform-subject-with-observed-heat',
      targetMaterialId: workplace.target.materialId,
      targetSourceFactIds: sourceEventIdsForTarget(
        state,
        project,
        workplace.target.position,
        workplace.target.materialId,
      ),
      targetSourceKeys: [`voxel:${workplace.target.position.x}:${workplace.target.position.y}:${workplace.target.position.z}:${workplace.target.materialId}`],
      subjectSourceKeys: [inventorySourceKey(person, wood)],
    }, workplace.target.position);
  }

  const smeltingInput = project.desiredFunction === 'copper-smelting'
    ? Material.CopperCharge
    : project.desiredFunction === 'tin-smelting'
      ? Material.TinCharge
      : undefined;
  if (smeltingInput !== undefined) {
    const subject = person.inventory.find((stack) => stack.materialId === smeltingInput && isConsumableProjectStack(stack));
    if (!subject) return null;
    const known = compileKnownExposureStep(person, project, subject, workplace.target);
    if (known) return known;
    return hypothesisStep(state, person, visibleDrops, project, {
      operation: 'expose-local',
      questionKind: 'transform-subject-with-observed-heat',
      targetMaterialId: workplace.target.materialId,
      targetSourceFactIds: sourceEventIdsForTarget(
        state,
        project,
        workplace.target.position,
        workplace.target.materialId,
      ),
      targetSourceKeys: [`voxel:${workplace.target.position.x}:${workplace.target.position.y}:${workplace.target.position.z}:${workplace.target.materialId}`],
      subjectSourceKeys: [inventorySourceKey(person, subject)],
    }, workplace.target.position);
  }
  return null;
}

function blindExertThenCombineStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  project: ProjectState,
  questionKind: Extract<ProjectHypothesisQuestionKind, 'seek-local-heat' | 'shape-portable-surface'>,
  subjectSourceKeys: string[] = [],
): ProjectStep | null {
  const active = activeHypothesisCandidate(project);
  if (active?.operation === 'combine-inventory') {
    return hypothesisStep(state, person, visibleDrops, project, {
      operation: 'combine-inventory',
      questionKind: active.questionKind,
      subjectSourceKeys,
    });
  }
  const target = localOpenExertionTarget(state, person);
  if (target && questionAllowsAnotherExert(state, person, project, questionKind)) {
    const exert = hypothesisStep(state, person, visibleDrops, project, {
      operation: 'exert-air',
      questionKind,
      targetMaterialId: target.materialId,
      targetSourceKeys: [`voxel:${target.position.x}:${target.position.y}:${target.position.z}:${target.materialId}`],
      subjectSourceKeys,
    }, target.position);
    if (exert) return exert;
  }
  return hypothesisStep(state, person, visibleDrops, project, {
    operation: 'combine-inventory',
    questionKind: 'connect-manipulator-shapes',
    subjectSourceKeys,
  });
}

function foodPreparationStep(state: SimulationState, person: PersonState, visibleDrops: DropState[], project: ProjectState): ProjectStep | null {
  const raw = person.inventory.find((stack) => isConsumableProjectStack(stack)
    && (stack.materialId === Material.RawMeat || stack.materialId === Material.Food));
  if (!raw) {
    const drop = nearestDrop(state, person, visibleDrops, [Material.RawMeat, Material.Food]);
    if (drop) return dropStep(person, drop, project.summary, materialDemand(
      person, drop.materialId, 1, `prepared-food-input-substitute:${drop.materialId}`, drop.sourceEventIds,
    ));
    return null;
  }
  const hotTarget = localHotTarget(state, person);
  if (hotTarget) {
    const knownExposure = compileKnownExposureStep(person, project, raw, hotTarget);
    if (knownExposure) return knownExposure;
    return hypothesisStep(state, person, visibleDrops, project, {
      operation: 'expose-local',
      questionKind: 'transform-subject-with-observed-heat',
      targetMaterialId: hotTarget.materialId,
      targetSourceFactIds: sourceEventIdsForTarget(state, project, hotTarget.position, hotTarget.materialId),
      targetSourceKeys: [`voxel:${hotTarget.position.x}:${hotTarget.position.y}:${hotTarget.position.z}:${hotTarget.materialId}`],
      subjectSourceKeys: [inventorySourceKey(person, raw)],
    }, hotTarget.position);
  }
  const knownHeat = reliableHeatTechnique(person);
  if (knownHeat) return compileKnownExertionStep(state, person, visibleDrops, project, knownHeat);
  const knownManipulator = reliableMissingManipulatorRecipe(person);
  if (knownManipulator) {
    return compileKnownOutput(
      state,
      person,
      visibleDrops,
      knownManipulator.rule.output.materialId,
      project.summary,
    );
  }
  return blindExertThenCombineStep(
    state,
    person,
    visibleDrops,
    project,
    'seek-local-heat',
    [inventorySourceKey(person, raw)],
  );
}

function isShelterComponentMaterial(materialId: MaterialId): boolean {
  // placeable 表示已经组装好的容器、设施或机械构件；它们可以独立落地，
  // 但不能再被住所项目当作一块通用墙材消费。
  return materialHas(materialId, 'solid')
    && materialHas(materialId, 'building')
    && !materialHas(materialId, 'placeable');
}

function buildingStack(person: PersonState) {
  return person.inventory
    .filter((stack) => isConsumableProjectStack(stack)
      && isShelterComponentMaterial(stack.materialId))
    .sort((a, b) => b.quantity - a.quantity || a.materialId - b.materialId)[0];
}

function solidBuildingAt(state: SimulationState, position: { x: number; y: number; z: number }): boolean {
  const materialId = voxelAt(state.world.grid, position.x, position.y, position.z);
  return materialHas(materialId, 'solid') && (materialHas(materialId, 'building') || materialHas(materialId, 'ground'));
}

function constructionPosition(state: SimulationState, project: ProjectState): { x: number; y: number; z: number } | null {
  if (!project.site) return null;
  const site = project.site;
  const requirement = project.shelterRequirement;
  const currentShelter = shelterGeometryAt(state.world.grid, site);
  if (requirement) {
    // An adaptation project is bound to the enclosure that produced its
    // exposure evidence. If that geometry disappears, or already satisfies
    // the requirement before project status is synchronized, it must not
    // fall through into the generic shelter blueprint and place an unrelated
    // upper wall or roof.
    if (!currentShelter || currentShelter.enclosedSides >= requirement.minimumEnclosedSides) return null;
    const openSide = neighbors4(site.cellId)
      .map((neighbor) => ({
        cellId: neighbor,
        lower: { x: cellX(neighbor), y: cellY(neighbor), z: site.z },
        upper: { x: cellX(neighbor), y: cellY(neighbor), z: site.z + 1 },
      }))
      .filter((candidate) => {
        const support = voxelAt(state.world.grid, candidate.lower.x, candidate.lower.y, candidate.lower.z - 1);
        const wasTraversableOpening = standingPositions(state.world.grid, candidate.cellId)
          .some((position) => Math.abs(position.z - site.z) <= 1);
        return support !== Material.Air
          && support !== Material.Water
          && voxelAt(state.world.grid, candidate.lower.x, candidate.lower.y, candidate.lower.z) === Material.Air
          && !solidBuildingAt(state, candidate.upper)
          && currentShelter.openSides - Number(wasTraversableOpening) >= 1;
      })
      .sort((left, right) => seededFraction(state.seed, `project-adapt-wall:${project.id}:${left.cellId}`)
        - seededFraction(state.seed, `project-adapt-wall:${project.id}:${right.cellId}`)
        || left.cellId - right.cellId)[0];
    return openSide?.lower ?? null;
  }
  const sides = neighbors4(site.cellId).map((neighbor) => ({
    cellId: neighbor,
    lower: { x: cellX(neighbor), y: cellY(neighbor), z: site.z },
    upper: { x: cellX(neighbor), y: cellY(neighbor), z: site.z + 1 },
  })).sort((a, b) => seededFraction(state.seed, `project-wall:${project.id}:${a.cellId}`)
    - seededFraction(state.seed, `project-wall:${project.id}:${b.cellId}`));
  const side = sides.find((candidate) => {
    const support = voxelAt(state.world.grid, candidate.lower.x, candidate.lower.y, candidate.lower.z - 1);
    const lower = voxelAt(state.world.grid, candidate.lower.x, candidate.lower.y, candidate.lower.z);
    return support !== Material.Air
      && support !== Material.Water
      && (lower === Material.Air || solidBuildingAt(state, candidate.lower));
  });
  if (!side) return null;
  {
    const support = voxelAt(state.world.grid, side.lower.x, side.lower.y, side.lower.z - 1);
    if (support !== Material.Air && support !== Material.Water && voxelAt(state.world.grid, side.lower.x, side.lower.y, side.lower.z) === Material.Air) return side.lower;
  }
  if (solidBuildingAt(state, side.lower) && voxelAt(state.world.grid, side.upper.x, side.upper.y, side.upper.z) === Material.Air) return side.upper;
  const roof = { x: cellX(site.cellId), y: cellY(site.cellId), z: site.z + 2 };
  if (voxelAt(state.world.grid, roof.x, roof.y, roof.z) === Material.Air && solidBuildingAt(state, side.upper)) return roof;
  return null;
}

function constructionStep(state: SimulationState, person: PersonState, visibleDrops: DropState[], project: ProjectState): ProjectStep | null {
  if (!project.site) return null;
  const stack = buildingStack(person);
  if (!stack) {
    const candidates = visibleDrops
      .filter((candidate) => isShelterComponentMaterial(candidate.materialId));
    const drop = nearestDrop(state, person, candidates, candidates.map((candidate) => candidate.materialId));
    if (!drop) return null;
    const step = dropStep(person, drop, project.summary, materialDemand(
      person, drop.materialId, 1, `construction-next-placement:${drop.materialId}`, drop.sourceEventIds,
    ));
    return step ? { ...step, missingMaterialIds: [drop.materialId] } : null;
  }
  if (person.position.cellId !== project.site.cellId || person.position.z !== project.site.z) return {
    key: `return-site-${project.site.cellId}-${project.site.z}`,
    summary: `带着材料回到未完成遮蔽项目的工作位置`,
    reason: '已经取得项目所需材料，回到原址继续连接比另开碎片化地点更有用',
    action: { kind: 'move', toCellId: project.site.cellId, toZ: project.site.z },
    sourceFactIds: [...new Set([...project.actionEventIds, ...stack.sourceEventIds])],
    missingMaterialIds: [],
    reservations: reservation(person, stack.id),
  };
  const position = constructionPosition(state, project);
  if (!position) return null;
  const target: WorldRef = { kind: 'voxel', position };
  return {
    key: `place-${position.x}-${position.y}-${position.z}-${stack.id}`,
    summary: `继续${project.summary}的下一处实体连接`,
    reason: '目标位置是同一功能结构当前最早缺失的支撑、侧向连接或顶盖，不会另开碎片化地点',
    action: { kind: 'act', operation: 'combine', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: stack.id }, target] },
    target,
    sourceFactIds: [...new Set([...project.actionEventIds, ...stack.sourceEventIds])],
    missingMaterialIds: [],
    reservations: reservation(person, stack.id),
  };
}

function careApplicationStep(state: SimulationState, person: PersonState, project: ProjectState): ProjectStep | null {
  if (project.desiredFunction !== 'healing') return null;
  const medicine = person.inventory.find((stack) => stack.materialId === Material.HerbalMedicine
    && isConsumableProjectStack(stack));
  if (!medicine) return null;
  const beneficiary = project.beneficiaryIds
    .map((personId) => state.people.find((candidate) => candidate.id === personId && isAlive(candidate)))
    .find((candidate) => candidate?.conditions.some((condition) => condition.kind === 'wound' || condition.kind === 'illness'));
  if (!beneficiary) return null;
  const target: WorldRef = { kind: 'person', personId: beneficiary.id };
  return {
    key: `apply-care-${medicine.id}-${beneficiary.id}`,
    summary: `把项目制得的草药用于${beneficiary.name}的具体伤病`,
    reason: '项目的功能结果是改变伤病，而不是仅把材料留在背包里',
    action: sameLocation(person, beneficiary)
      ? { kind: 'act', operation: 'combine', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: medicine.id }, target] }
      : { kind: 'move', toCellId: beneficiary.position.cellId, toZ: beneficiary.position.z },
    target,
    sourceFactIds: [...medicine.sourceEventIds, ...beneficiary.conditions.flatMap((condition) => condition.sourceEventIds)],
    missingMaterialIds: [],
    reservations: reservation(person, medicine.id),
  };
}

function durableRecordPublicationStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): ProjectStep | null {
  if (project.desiredFunction !== 'durable-record'
    || !project.targetKnowledgeId
    || project.ownerId !== person.id
    || !project.site) return null;
  const knowledge = person.knowledge.find((fact) => fact.id === project.targetKnowledgeId && fact.confidence >= 55);
  if (!knowledge) return null;
  const written = durableRecordWriteEvidence(state, project).reverse().find((candidate) => (
    person.inventory.some((stack) => stack.id === candidate.carrierStackId
      && stack.quantity > 0
      && stack.recordPayloadId === candidate.record.id)
  ));
  if (written) {
    const carrier = person.inventory.find((stack) => stack.id === written.carrierStackId
      && stack.quantity > 0
      && stack.recordPayloadId === written.record.id)!;
    const atPublicationSite = person.position.cellId === project.site.cellId
      && person.position.z === project.site.z;
    return {
      key: atPublicationSite
        ? `publish-record-${written.record.id}-${project.site.cellId}-${project.site.z}`
        : `carry-record-${written.record.id}-${project.site.cellId}-${project.site.z}`,
      summary: atPublicationSite
        ? `把“${knowledge.summary}”留在固定地点供后来者读取`
        : `把已写好的“${knowledge.summary}”带到固定发布地点`,
      reason: atPublicationSite
        ? '耐久记录只有脱离私人背包、留在项目预先固定的地点，才形成可延续的公共事实'
        : '记录已经写成，但仍是私人携带物；先回到项目形成时固定的发布地点',
      action: atPublicationSite
        ? {
          kind: 'transfer',
          materialId: carrier.materialId,
          quantity: 1,
          from: { kind: 'person', personId: person.id },
          to: { kind: 'ground', cellId: project.site.cellId, z: project.site.z },
          stackId: carrier.id,
        }
        : { kind: 'move', toCellId: project.site.cellId, toZ: project.site.z },
      target: { kind: 'inventory-stack', personId: person.id, stackId: carrier.id },
      sourceFactIds: [...new Set([
        ...project.triggerFactIds,
        ...written.record.sourceEventIds,
        ...carrier.sourceEventIds,
        written.writeFact.id,
      ])],
      missingMaterialIds: [],
      reservations: reservation(person, carrier.id),
      planKnowledgeId: knowledge.id,
    };
  }
  return null;
}

function durableRecordStep(state: SimulationState, person: PersonState, visibleDrops: DropState[], project: ProjectState): ProjectStep | null {
  const publication = durableRecordPublicationStep(state, person, project);
  if (publication) return publication;
  if (project.desiredFunction !== 'durable-record'
    || !project.targetKnowledgeId
    || project.ownerId !== person.id
    || !project.site) return null;
  const knowledge = person.knowledge.find((fact) => fact.id === project.targetKnowledgeId && fact.confidence >= 55);
  if (!knowledge) return null;
  const carrier = blankRecordCarrier(person);
  if (carrier) {
    const representationId = `project-record:${project.id}:${knowledge.id}`;
    return {
      key: `write-${carrier.id}-${knowledge.id}`,
      summary: `把“${knowledge.summary}”写入已有空白载体`,
      reason: '本人已经因经验中断风险形成保存目标；空白载体和已核验知识都在手中',
      action: {
        kind: 'communicate',
        content: { id: representationId, kind: 'claim', summary: knowledge.summary, factId: knowledge.id },
        audience: [], channel: 'record', carrierStackId: carrier.id,
      },
      target: { kind: 'inventory-stack', personId: person.id, stackId: carrier.id },
      sourceFactIds: [...new Set([...project.triggerFactIds, ...knowledge.sourceEventIds, ...carrier.sourceEventIds])],
      missingMaterialIds: [],
      reservations: reservation(person, carrier.id),
      planKnowledgeId: knowledge.id,
    };
  }
  const knownCarrierRecipe = reliableRecordCarrierRecipe(person);
  if (knownCarrierRecipe) {
    return compileKnownOutput(
      state,
      person,
      visibleDrops,
      knownCarrierRecipe.rule.output.materialId,
      project.summary,
    );
  }
  const knownCarrierTechnique = reliableRecordCarrierTechnique(person);
  if (knownCarrierTechnique) {
    return compileKnownExertionStep(state, person, visibleDrops, project, knownCarrierTechnique);
  }
  const knownManipulator = reliableMissingManipulatorRecipe(person);
  if (knownManipulator) {
    return compileKnownOutput(
      state,
      person,
      visibleDrops,
      knownManipulator.rule.output.materialId,
      project.summary,
    );
  }
  return blindExertThenCombineStep(
    state,
    person,
    visibleDrops,
    project,
    'shape-portable-surface',
  );
}

function settledCultivationStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): ProjectStep | null {
  if (project.desiredFunction !== 'settled-cultivation') return null;
  const visible = new Set(visibleCellsFor(person));
  if (!project.site) {
    const anchor = [...visible]
      .filter((cellId) => cultivationSurfaceMaterials.has(surfaceMaterial(state.world.grid, cellId))
        || plantableCultivationMaterials.has(surfaceMaterial(state.world.grid, cellId)))
      .map((cellId) => ({
        cellId,
        position: topPosition(state.world.grid, cellId),
        path: findStandingPath(state.world.grid, person.position, { cellId }),
      }))
      .filter((candidate) => candidate.path.length > 0)
      .sort((left, right) => left.path.length - right.path.length || left.cellId - right.cellId)[0];
    if (anchor) project.site = { cellId: anchor.cellId, z: anchor.position.z };
  }
  const cultivatedCells = projectCultivationCells(project)
    .filter((cellId) => cultivationSurfaceMaterials.has(surfaceMaterial(state.world.grid, cellId)));
  const harvests = projectCultivationHarvests(state, project);
  const matureCell = cultivatedCells
    .filter((cellId) => visible.has(cellId) && surfaceMaterial(state.world.grid, cellId) === Material.CropMature)
    .map((cellId) => ({
      cellId,
      position: topPosition(state.world.grid, cellId),
      path: findStandingPath(state.world.grid, person.position, { cellId }),
    }))
    .filter((candidate) => candidate.path.length > 0)
    .sort((left, right) => left.path.length - right.path.length || left.cellId - right.cellId)[0];
  if (matureCell && (harvests.length < 2 || inventoryQuantity(person, Material.Seed) === 0)) {
    const tool = bestProductionToolStack(person);
    const closeEnough = Math.abs(cellX(person.position.cellId) - matureCell.position.x)
      + Math.abs(cellY(person.position.cellId) - matureCell.position.y) <= 1;
    return {
      key: `settled-cultivation-harvest-${matureCell.cellId}`,
      summary: closeEnough ? '收获定居耕地中的成熟作物并留下下一轮种子' : '前往已经成熟的定居耕地',
      reason: '农耕定居不仅需要播种，还必须完成真实生长、收获与留种循环',
      action: closeEnough
        ? {
          kind: 'act', operation: 'separate',
          targets: [{ kind: 'voxel', position: matureCell.position }],
          ...(tool ? { toolStackId: tool.id } : {}),
        }
        : { kind: 'move', toCellId: matureCell.path.at(-1)!.cellId, toZ: matureCell.path.at(-1)!.z },
      target: { kind: 'voxel', position: matureCell.position },
      sourceFactIds: [...new Set([...project.triggerFactIds, ...harvests.slice(-2).map((event) => event.id)])],
      missingMaterialIds: [],
      reservations: tool ? reservation(person, tool.id) : [],
    };
  }
  if (cultivatedCells.length >= 6) return null;
  const seed = person.inventory.find((stack) => stack.materialId === Material.Seed && isConsumableProjectStack(stack));
  if (!seed) return null;
  const target = projectCultivationCells(project)
    .filter((cellId) => visible.has(cellId)
      && plantableCultivationMaterials.has(surfaceMaterial(state.world.grid, cellId)))
    .map((cellId) => ({
      cellId,
      position: topPosition(state.world.grid, cellId),
      path: findStandingPath(state.world.grid, person.position, { cellId }),
    }))
    .filter((candidate) => candidate.path.length > 0)
    .sort((left, right) => left.path.length - right.path.length || left.cellId - right.cellId)[0];
  if (!target) return null;
  const closeEnough = Math.abs(cellX(person.position.cellId) - target.position.x)
    + Math.abs(cellY(person.position.cellId) - target.position.y) <= 1;
  return {
    key: `settled-cultivation-plant-${target.cellId}-${seed.id}`,
    summary: closeEnough ? '把留存种子播入适合耕作的湿润土壤' : '带着种子前往适合耕作的湿润土壤',
    reason: '本人感知到食物压力，并把偶然采集转变成固定地点上的可重复生产',
    action: closeEnough
      ? {
        kind: 'act', operation: 'combine',
        targets: [
          { kind: 'inventory-stack', personId: person.id, stackId: seed.id },
          { kind: 'voxel', position: target.position },
        ],
      }
      : { kind: 'move', toCellId: target.path.at(-1)!.cellId, toZ: target.path.at(-1)!.z },
    target: { kind: 'voxel', position: target.position },
    sourceFactIds: [...new Set([...project.triggerFactIds, ...seed.sourceEventIds])],
    missingMaterialIds: [],
    reservations: reservation(person, seed.id),
  };
}

function compileProjectWorkStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  project: ProjectState,
): ProjectStep | null {
  if (project.desiredFunction === 'water-powered-crop-processing') {
    const mechanicalStep = mechanicalPowerProjectStep(state, person, project);
    if (mechanicalStep) return mechanicalStep;
    if (mechanicalPowerMissingMaterials(state, person, project).length) return null;
    // An unknown component recipe stays inside the existing bounded local
    // hypothesis loop; the mechanical chain never reads that hidden recipe.
    return hypothesisStep(state, person, visibleDrops, project);
  }
  const verification = tentativeTechniqueStep(state, person, project);
  if (verification) return verification;
  const cultivation = settledCultivationStep(state, person, project);
  if (cultivation) return cultivation;
  if (project.desiredFunction === 'weather-shelter') return constructionStep(state, person, visibleDrops, project);
  if (project.desiredFunction === 'prepared-food') return foodPreparationStep(state, person, visibleDrops, project);
  if (project.desiredFunction === 'durable-record') return durableRecordStep(state, person, visibleDrops, project);
  if (project.desiredFunction === 'reserve-storage' && placedFunctionEvidence(state, project).length) {
    // Once this project has placed its granary, the remaining obligation is
    // functional stocking. Falling back into subassembly here can manufacture
    // another granary while the first one is merely waiting for food.
    return reserveStockingStep(state, person, visibleDrops, project);
  }
  const facilityMaterialIds = placedFunctionMaterialIds(project);
  for (const materialId of facilityMaterialIds) {
    const stack = person.inventory.find((candidate) => candidate.materialId === materialId
      && isConsumableProjectStack(candidate));
    const target = stack ? localOpenExertionTarget(state, person) : null;
    if (stack && target) return {
      key: `place-project-facility-${materialId}-${target.position.x}-${target.position.y}-${target.position.z}`,
      summary: `把${materialDefinition(materialId).name}设置为可共同使用的固定设施`,
      reason: '设施已经制作完成，但只有落在可抵达的实体位置并被持续使用，才会产生公共功能',
      action: {
        kind: 'act',
        operation: 'combine',
        targets: [
          { kind: 'inventory-stack', personId: person.id, stackId: stack.id },
          { kind: 'voxel', position: target.position },
        ],
      },
      target: { kind: 'voxel', position: target.position },
      sourceFactIds: [...stack.sourceEventIds],
      missingMaterialIds: [],
      reservations: reservation(person, stack.id),
    };
    const approach = stack ? visiblePlacementApproach(state, person) : null;
    if (stack && approach) return {
      key: `approach-project-facility-site-${materialId}-${approach.cellId}-${approach.z}`,
      summary: `寻找可设置${materialDefinition(materialId).name}的近处实体位置`,
      reason: '设施构件已经完成，但眼前没有可落地的空气体素；人物只前往本人可见可达且有固体承托的位置',
      action: { kind: 'move', toCellId: approach.cellId, toZ: approach.z },
      sourceFactIds: [...stack.sourceEventIds],
      missingMaterialIds: [],
      reservations: reservation(person, stack.id),
    };
  }
  const currentMonth = state.clock.elapsedMonths + 1;
  const pendingSharedFacility = new Set(facilityMaterialIds);
  if (pendingSharedFacility.size && projectActionFacts(state, project).some((event) => event.status === 'completed'
    && event.atMonth === currentMonth
    && pendingSharedFacility.has(Number(event.diff.outputMaterialId))
    && !event.diff.position)) {
    // Another collaborator has already produced this project's final facility
    // during the current planning month. Let that physical object reach its
    // placement step before anybody spends a second set of materials.
    return null;
  }
  const metallurgy = metallurgyWorkStep(state, person, visibleDrops, project);
  if (metallurgy) return metallurgy;
  const subassembly = developmentSubassemblyStep(state, person, project);
  if (subassembly) return subassembly;
  const upgrade = containerUpgradeStep(state, person, project);
  if (upgrade) return upgrade;
  const care = careApplicationStep(state, person, project);
  if (care) return care;
  const baselineProductionToolRank = projectProductionToolBaselineRank(project);
  const candidateOutputs = completedFunctionMaterialIds(project)
    .sort((left, right) => productionToolRank(right) - productionToolRank(left));
  for (const output of candidateOutputs) {
    if (verifiedProductionToolFunctions.has(project.desiredFunction)
      && productionToolRank(output) <= baselineProductionToolRank) continue;
    const known = compileKnownOutput(state, person, visibleDrops, output, project.summary);
    if (known) return known;
  }
  // Cultivation already has a complete physical loop. When the anchored field
  // is waiting for moisture or growth, there is no unknown recipe to guess.
  // Returning null lets the outer compiler source a missing seed, or wait.
  if (project.desiredFunction === 'settled-cultivation') return null;
  const pendingSubassembly = [
    'efficient-production', 'community-coordination', 'reserve-storage',
    'reliable-water', 'crop-processing', 'high-heat-processing',
    'copper-charge', 'copper-smelting', 'tin-charge', 'tin-smelting',
    'bronze-alloying', 'bronze-tooling', 'bronze-workshop',
  ].includes(project.desiredFunction)
    && Boolean(projectMaterialRequirement(state, person, project)?.demands.length);
  if (pendingSubassembly) return null;
  return hypothesisStep(state, person, visibleDrops, project);
}

function materialContributionRequestStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  requirement: ProjectMaterialRequirement,
): ProjectStep | null {
  if (project.ownerId !== person.id || project.need !== 'alloy-capability' || !project.site) return null;
  const visible = new Set(visibleCellsFor(person));
  const possibleContributors = state.people.filter((candidate) => candidate.id !== person.id
    && isAlive(candidate)
    && visible.has(candidate.position.cellId));
  const selected = requirement.demands.flatMap((demand) => {
    if (demand.outstandingQuantity <= 0
      || project.materialContributionRequests?.some((request) => request.materialId === demand.materialId
        && inspectProjectMaterialContributionRequest(
          state,
          project,
          request,
          state.clock.elapsedMonths + 1,
          demand,
        ).status === 'open')) return [];
    const holders = possibleContributors.filter((candidate) => inventoryQuantity(candidate, demand.materialId) > 0);
    return holders.length ? [{ demand, holders }] : [];
  }).sort((left, right) => left.demand.materialId - right.demand.materialId)[0];
  if (!selected) return null;
  const quantity = Math.min(
    selected.demand.outstandingQuantity,
    selected.holders.reduce((sum, holder) => sum + inventoryQuantity(holder, selected.demand.materialId), 0),
  );
  if (quantity <= 0) return null;
  const materialName = materialDefinition(selected.demand.materialId).name;
  return {
    key: `request-project-material-${project.id}-${selected.demand.materialId}`,
    summary: `请求附近持料者把${materialName}送到固定冶炼工地`,
    reason: '项目已经记录具体缺口和固定设施；请求只发给眼前确实持有该材料的人，不会读取远处背包或追逐移动目标',
    action: {
      kind: 'communicate',
      content: {
        id: `project-material-request:${project.id}:${selected.demand.materialId}`,
        kind: 'request',
        summary: `“${project.summary}”还缺${materialName} × ${quantity}，请送到工地`,
        projectMaterialContribution: {
          version: 'project-material-contribution-request-v1',
          projectId: project.id,
          requesterId: person.id,
          materialId: selected.demand.materialId,
          quantity,
          site: { ...project.site },
          expiresAtMonth: state.clock.elapsedMonths + 12,
        },
      },
      audience: selected.holders.map((holder) => holder.id),
      channel: 'gesture',
    },
    sourceFactIds: [...new Set([
      ...project.triggerFactIds,
      ...selected.demand.sourceFactIds,
      ...selected.holders.flatMap((holder) => holder.inventory
        .filter((stack) => stack.materialId === selected.demand.materialId && stack.quantity > 0)
        .flatMap((stack) => stack.sourceEventIds)),
    ])],
    missingMaterialIds: [selected.demand.materialId],
    materialDemands: structuredClone(requirement.demands),
    reservations: [],
  };
}

function storedProjectMaterialStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  requirement: ProjectMaterialRequirement,
): ProjectStep | null {
  const demands = new Map(requirement.demands
    .filter((demand) => demand.outstandingQuantity > 0)
    .map((demand) => [demand.materialId, demand]));
  if (!demands.size) return null;
  const stored = findCurrentVisibleStoredMaterialAccess(
    state,
    person,
    (stack) => !stack.recordPayloadId && demands.has(stack.materialId),
  );
  if (!stored) return null;
  const demand = demands.get(stored.stack.materialId);
  if (!demand) return null;
  const action = retrieveStoredMaterialOrMove(person, stored);
  const materialName = materialDefinition(stored.stack.materialId).name;
  return {
    key: `${action.kind === 'move' ? 'approach' : 'retrieve'}-project-container-${stored.container.id}-${stored.stack.id}`,
    summary: action.kind === 'move'
      ? `前往当前看见的容器取得项目所缺${materialName}`
      : `从当前看见的容器取出项目所缺${materialName}`,
    reason: '项目已经形成真实物质缺口；先使用本人当前看见且可达的实体库存，再考虑请求他人或搜索未知来源',
    action,
    target: { kind: 'container', containerId: stored.container.id },
    sourceFactIds: [...new Set([
      ...project.triggerFactIds,
      ...requirement.sourceEventIds,
      ...demand.sourceFactIds,
      ...stored.container.sourceEventIds,
      ...stored.stack.sourceEventIds,
    ])],
    missingMaterialIds: [...requirement.materialIds],
    materialDemands: structuredClone(requirement.demands),
    reservations: [],
    ...(requirement.planKnowledgeId ? { planKnowledgeId: requirement.planKnowledgeId } : {}),
  };
}

export function projectContributionStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): ProjectStep | null {
  if (project.ownerId === person.id || project.need !== 'alloy-capability' || !project.site) return null;
  const owner = state.people.find((candidate) => candidate.id === project.ownerId && isAlive(candidate));
  if (!owner) return null;
  const selected = (project.materialContributionRequests ?? [])
    .flatMap((request) => {
      if (!request.contributorIds.includes(person.id)) return [];
      const demand = project.materialDemands?.find((candidate) => candidate.materialId === request.materialId
        && candidate.outstandingQuantity > 0);
      if (!demand) return [];
      const view = inspectProjectMaterialContributionRequest(
        state,
        project,
        request,
        state.clock.elapsedMonths + 1,
        demand,
      );
      return view.status === 'open' ? [{ request, view }] : [];
    })
    .sort((left, right) => left.request.atMonth - right.request.atMonth
      || left.request.materialId - right.request.materialId)[0];
  if (!selected) return null;
  const { request, view } = selected;
  const stack = person.inventory.find((candidate) => candidate.materialId === request.materialId && candidate.quantity > 0);
  if (!stack) return null;
  const remaining = view.deliverableQuantity;
  if (!remaining) return null;
  const workplace = fixedFacilityWorkplace(state, person, request.site);
  if (!workplace) return null;
  const atWorkplace = person.position.cellId === workplace.workingPosition.cellId
    && person.position.z === workplace.workingPosition.z;
  const materialName = materialDefinition(request.materialId).name;
  if (!atWorkplace) return {
    key: `carry-project-material-${project.id}-${request.requestEventId}`,
    summary: `把${materialName}运往固定冶炼工地`,
    reason: '本人收到与真实项目缺口绑定的请求；运输目标是固定设施，不追逐正在移动的项目所有者',
    action: { kind: 'move', toCellId: workplace.workingPosition.cellId, toZ: workplace.workingPosition.z },
    target: { kind: 'voxel', position: workplace.target.position },
    sourceFactIds: [...new Set([request.requestEventId, ...stack.sourceEventIds])],
    missingMaterialIds: [],
    reservations: reservation(person, stack.id, Math.min(remaining, stack.quantity)),
  };
  const quantity = Math.min(remaining, stack.quantity);
  return {
    key: `contribute-project-material-${project.id}-${request.requestEventId}-${stack.id}`,
    summary: `向“${project.summary}”贡献${materialName} × ${quantity}`,
    reason: sameLocation(person, owner)
      ? '项目所有者已经在固定工地，材料当面交接并保留来源'
      : '项目所有者暂时不在工位，材料留在固定设施旁，后续仍需由真实取物动作接续',
    action: {
      kind: 'transfer',
      materialId: request.materialId,
      quantity,
      from: { kind: 'person', personId: person.id },
      to: sameLocation(person, owner)
        ? { kind: 'person', personId: owner.id }
        : { kind: 'ground', cellId: person.position.cellId, z: person.position.z },
      stackId: stack.id,
      authorizationRef: request.requestEventId,
    },
    target: { kind: 'voxel', position: workplace.target.position },
    sourceFactIds: [...new Set([request.requestEventId, ...stack.sourceEventIds])],
    missingMaterialIds: [],
    reservations: reservation(person, stack.id, quantity),
  };
}

export function compileProjectStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  project: ProjectState,
): ProjectStep | null {
  if (project.ownerId !== person.id && project.need === 'alloy-capability') {
    return projectContributionStep(state, person, project);
  }
  // A project-bound written carrier is already the final private intermediate.
  // Publish it before resuming an older search route; the route remains active
  // until the physical placement lets normal project completion close it.
  const recordPublication = durableRecordPublicationStep(state, person, project);
  if (recordPublication) return recordPublication;
  const existingEpisode = activeLogisticsEpisode(project);
  if (existingEpisode?.actorId === person.id) {
    const episodeStep = activeEpisodeStep(state, person, visibleDrops, project, existingEpisode);
    if (episodeStep) return episodeStep;
    if (activeLogisticsEpisode(project)?.id === existingEpisode.id) return null;
  }

  const workStep = compileProjectWorkStep(state, person, visibleDrops, project);
  const foreignEpisode = activeLogisticsEpisode(project);
  if (foreignEpisode && foreignEpisode.actorId !== person.id) {
    return workStep?.target?.kind === 'drop' ? null : workStep;
  }
  if (workStep?.planKnowledgeId) {
    project.planKnowledgeId = workStep.planKnowledgeId;
    const reliableTechnique = workStep.planKnowledgeId.startsWith('technique:')
      && person.knowledge.some((fact) => fact.id === workStep.planKnowledgeId && fact.confidence >= 55);
    if (reliableTechnique) closeProjectHypothesisCampaign(
      project,
      state.clock.elapsedMonths + 1,
      'reliable-knowledge',
    );
  }
  if (workStep?.target?.kind === 'drop') {
    const dropId = workStep.target.dropId;
    const drop = visibleDrops.find((candidate) => candidate.id === dropId);
    if (!drop) return null;
    const demand = workStep.materialDemands?.find((candidate) => candidate.materialId === drop.materialId);
    if (!demand || demand.outstandingQuantity <= 0) return null;
    const episode = startDropLogisticsEpisode(
      project,
      person,
      drop,
      workStep.sourceFactIds,
      state.clock.elapsedMonths + 1,
      demand,
    );
    return activeEpisodeStep(state, person, visibleDrops, project, episode);
  }
  if (workStep) return workStep;

  const requirement = projectMaterialRequirement(state, person, project);
  if (!requirement?.materialIds.length) return null;
  if (requirement.planKnowledgeId) project.planKnowledgeId = requirement.planKnowledgeId;
  const storedMaterial = storedProjectMaterialStep(state, person, project, requirement);
  if (storedMaterial) return storedMaterial;
  const contributionRequest = materialContributionRequestStep(state, person, project, requirement);
  if (contributionRequest) return contributionRequest;
  const availableDrop = nearestDrop(state, person, visibleDrops, requirement.materialIds)
    ?? nearestRememberedDrop(state, person, requirement.materialIds);
  if (availableDrop) {
    const demand = requirement.demands.find((candidate) => candidate.materialId === availableDrop.materialId);
    if (demand) {
      const episode = startDropLogisticsEpisode(
        project,
        person,
        availableDrop,
        requirement.sourceEventIds,
        state.clock.elapsedMonths + 1,
        demand,
      );
      return activeEpisodeStep(state, person, visibleDrops, project, episode);
    }
  }
  const renewableSourceDemand = requirement.demands.find((demand) => (
    demand.materialId === Material.Wood || demand.materialId === Material.Fiber || demand.materialId === Material.Seed
  ) && demand.outstandingQuantity > 0);
  if (renewableSourceDemand) {
    const source = visibleMaterialSource(state, person, renewableSourceDemand.materialId);
    if (source) {
      const episode = startSourceLogisticsEpisode(
        project,
        person,
        source,
        requirement.sourceEventIds,
        state.clock.elapsedMonths + 1,
        renewableSourceDemand,
      );
      return activeEpisodeStep(state, person, visibleDrops, project, episode);
    }
  }
  const destination = visibleReachableSearchDestination(state, person, project, requirement.materialIds);
  if (!destination) return null;
  const episode = startSearchLogisticsEpisode(
    project,
    person,
    requirement.materialIds,
    destination,
    requirement.sourceEventIds,
    state.clock.elapsedMonths + 1,
    requirement.demands,
    renewableSourceDemand ? 0 : undefined,
  );
  return activeEpisodeStep(state, person, visibleDrops, project, episode);
}

export function projectOption(project: ProjectState, step: ProjectStep, proposal?: ProjectProposal): ActionOption {
  const initialLogisticsEpisode = proposal ? activeLogisticsEpisode(project) : undefined;
  const initialSearchCampaign = initialLogisticsEpisode?.searchCampaignId
    ? project.searchCampaigns?.find((campaign) => campaign.id === initialLogisticsEpisode.searchCampaignId)
    : undefined;
  const sourcedProposal = proposal ? {
    ...proposal,
    ...(initialLogisticsEpisode ? { initialLogisticsEpisode: structuredClone(initialLogisticsEpisode) } : {}),
    ...(initialSearchCampaign ? { initialSearchCampaign: structuredClone(initialSearchCampaign) } : {}),
    ...(step.materialDemands?.length ? { initialMaterialDemands: structuredClone(step.materialDemands) } : {}),
    ...(project.hypothesisCampaign
      ? { initialHypothesisCampaign: structuredClone(project.hypothesisCampaign) }
      : {}),
  } : undefined;
  return {
    id: `project:${project.id}:${step.key}`,
    summary: step.summary,
    reason: step.reason,
    goal: { kind: 'project-completed', projectId: project.id },
    nextAction: step.action,
    ...(step.target ? { target: step.target } : {}),
    estimatedDuration: 'long',
    estimatedMonths: Math.max(1, project.reviewAtMonth - project.createdAtMonth),
    sourceFactIds: [...new Set([...project.triggerFactIds, ...(project.pressureBasis?.sourceFactIds ?? []), ...step.sourceFactIds])],
    domain: 'strategic',
    projectId: project.id,
    ...(sourcedProposal ? { projectProposal: sourcedProposal } : {}),
    projectPressure: project.pressure,
  };
}
