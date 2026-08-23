import type { ActionOption } from '../../domain/action';
import {
  type ExertionRule,
  type InventoryCombinationRule,
} from '../../domain/interaction-rules';
import { Material, materialDefinition, materialHas, type MaterialId } from '../../domain/material';
import { productionToolRank } from '../../domain/production-tool';
import type { ActionFact, DropState, SimulationState } from '../../domain/model';
import {
  inventoryQuantity,
  isAlive,
  sameLocation,
  type PersonState,
} from '../../domain/person';
import type {
  ProjectFunction,
  ProjectHypothesisQuestionKind,
  ProjectMaterialContributionRequestBasis,
  ProjectMaterialDemand,
  ProjectProposal,
  ProjectState,
} from '../../domain/project';
import {
  inspectProjectMaterialContributionRequest,
  transferMatchesProjectMaterialRequest,
} from '../../domain/project-material-request';
import {
  inspectProjectKnowledgeRequest,
  pendingProjectKnowledgeGap,
} from '../../domain/project-knowledge-request';
import { resolvePersonKnownProcess } from '../../domain/person-known-process';
import { findCurrentVisibleStoredMaterialAccess, retrieveStoredMaterialOrMove } from '../../domain/stored-food-access';
import {
  cellX,
  cellY,
  findStandingPath,
  neighbors4,
  standingPositions,
  surfaceMaterial,
} from '../../world/grid';
import { closeProjectHypothesisCampaign } from '../project-hypotheses';
import {
  mechanicalPowerMaintenanceMaterialRequirement,
  mechanicalPowerMaintenanceProjectStep,
  mechanicalPowerMaterialRequirement,
  mechanicalPowerProjectStep,
} from '../mechanical-power-options';
import {
  completedFunctionMaterialIds,
  cultivationSurfaceMaterials,
  durableRecordWriteEvidence,
  placedFunctionEvidence,
  placedFunctionMaterialIds,
  projectActionFacts,
  projectCultivationCells,
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
} from './project-spatial-planning';
import type { ProjectStep } from './project-step';
import { fixedFacilityWorkplace } from './project-workplace';
import { careApplicationProjectStep } from './steps/care';
import { constructionProjectStep, shelterBuildingStack } from './steps/construction';
import { settledCultivationProjectStep } from './steps/cultivation';
import {
  compileKnownExposureStep,
  compileKnownOutput,
  knownExposurePlan,
  knownRecipe,
  localFinishedOutputAccess,
  reliableKnownRecipe,
  type KnownOutputAccessOptions,
} from './steps/known-material-production';

const IRON_WORKPLACE_MATERIALS = [Material.Smithy] as const;
const IRON_WORKSHOP_DIRECT_OUTPUTS = [Material.Bronze, Material.FiredBrick] as const;

export function projectSupportsMaterialContribution(project: Pick<ProjectState, 'need' | 'desiredFunction'>): boolean {
  return project.need === 'alloy-capability'
    || project.need === 'iron-capability'
    || project.need === 'mechanical-power-capability'
    || (project.need === 'coordination-capacity' && project.desiredFunction === 'civic-coordination');
}

function projectUsesFixedMetallurgyWorkplace(project: Pick<ProjectState, 'need' | 'desiredFunction'>): boolean {
  return project.need === 'alloy-capability'
    || project.desiredFunction === 'brick-firing'
    || (project.need === 'iron-capability' && project.desiredFunction !== 'iron-workshop');
}

function fixedProjectWorkplace(
  state: SimulationState,
  person: PersonState,
  project: Pick<ProjectState, 'need' | 'desiredFunction' | 'site'>,
) {
  return fixedFacilityWorkplace(
    state,
    person,
    project.site,
    project.need === 'iron-capability' ? IRON_WORKPLACE_MATERIALS : undefined,
  );
}
function localFinishedIronWorkshopOutputs(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): MaterialId[] {
  if (project.desiredFunction !== 'iron-workshop') return [];
  return IRON_WORKSHOP_DIRECT_OUTPUTS.filter((materialId) => (
    consumableInventoryQuantity(person, materialId) === 0
    && localFinishedOutputAccess(state, person, materialId, {
      preferLocalFinishedOutput: true,
      allowVisibleHolder: projectSupportsMaterialContribution(project),
    }) !== null
  ));
}

interface ProjectMaterialRequirement {
  materialIds: MaterialId[];
  demands: ProjectMaterialDemand[];
  sourceEventIds: string[];
  planKnowledgeId?: string;
}

function personallyKnownProcessRequirement(
  state: SimulationState,
  person: PersonState,
  outputMaterialId: MaterialId,
  accessOptions: KnownOutputAccessOptions = {},
): ProjectMaterialRequirement {
  const resolution = resolvePersonKnownProcess(state, person, outputMaterialId, {
    directAccess: (materialId, quantity) => quantity <= 1
      ? localFinishedOutputAccess(state, person, materialId, accessOptions)
      : null,
  });
  const grouped = new Map<MaterialId, { quantity: number; sourceFactIds: string[]; branchKeys: string[] }>();
  for (const leaf of resolution.leaves) {
    const current = grouped.get(leaf.materialId) ?? { quantity: 0, sourceFactIds: [], branchKeys: [] };
    current.quantity += leaf.quantity;
    current.sourceFactIds.push(...leaf.sourceFactIds);
    current.branchKeys.push(`${leaf.kind}:${leaf.techniquePath.join('>') || 'root'}`);
    grouped.set(leaf.materialId, current);
  }
  const demands = [...grouped].map(([materialId, basis]) => materialDemand(
    person,
    materialId,
    basis.quantity,
    `person-known-process:${outputMaterialId}:${materialId}:${basis.branchKeys.sort().join('+')}`,
    [...new Set(basis.sourceFactIds)],
  )).filter((demand) => demand.outstandingQuantity > 0);
  return {
    materialIds: [...new Set(demands.map((demand) => demand.materialId))],
    demands,
    sourceEventIds: [...resolution.sourceFactIds],
    ...(resolution.techniqueIds[0] ? { planKnowledgeId: resolution.techniqueIds[0] } : {}),
  };
}

type ProjectMaterialHandoff = {
  kind: 'open';
  request: ProjectMaterialContributionRequestBasis;
  demand: ProjectMaterialDemand;
} | {
  kind: 'delivered';
  request: ProjectMaterialContributionRequestBasis;
  demand: ProjectMaterialDemand;
  deliveryFact: ActionFact;
};

function knownOutputRequirement(
  state: SimulationState,
  person: PersonState,
  outputMaterialId: MaterialId,
  accessOptions: KnownOutputAccessOptions = {},
  visited = new Set<MaterialId>(),
): ProjectMaterialRequirement | null {
  if (visited.has(outputMaterialId)) return null;
  visited.add(outputMaterialId);
  const direct = localFinishedOutputAccess(state, person, outputMaterialId, accessOptions);
  if (direct) {
    const demand = materialDemand(
      person,
      outputMaterialId,
      1,
      `known-direct-output:${direct.kind}:${outputMaterialId}`,
      direct.sourceFactIds,
    );
    return {
      materialIds: demand.outstandingQuantity > 0 ? [outputMaterialId] : [],
      demands: demand.outstandingQuantity > 0 ? [demand] : [],
      sourceEventIds: [...direct.sourceFactIds],
    };
  }
  const known = knownRecipe(person, outputMaterialId);
  if (known) {
    const knowledge = person.knowledge.find((fact) => fact.id === known.knowledgeId);
    const demands: ProjectMaterialDemand[] = [];
    const sourceEventIds = [...(knowledge?.sourceEventIds ?? [])];
    for (const input of known.rule.inputs) {
      if (consumableInventoryQuantity(person, input.materialId) >= input.quantity) continue;
      const nested = knownOutputRequirement(
        state,
        person,
        input.materialId,
        accessOptions,
        new Set(visited),
      );
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

  const exposure = knownExposurePlan(state, person, outputMaterialId);
  if (!exposure) return null;
  const { technique } = exposure;
  const inputMaterialId = technique.rule.inputMaterialId;
  const demands: ProjectMaterialDemand[] = [];
  const sourceEventIds = [...technique.sourceEventIds];
  if (consumableInventoryQuantity(person, inputMaterialId) === 0) {
    const nested = knownOutputRequirement(
      state,
      person,
      inputMaterialId,
      accessOptions,
      new Set(visited),
    );
    if (nested?.demands.length) {
      demands.push(...nested.demands);
      sourceEventIds.push(...nested.sourceEventIds);
    } else demands.push(materialDemand(
      person,
      inputMaterialId,
      1,
      `known-exposure-requirement:${technique.rule.id}:${inputMaterialId}`,
      technique.sourceEventIds,
    ));
  }
  return {
    materialIds: [...new Set(demands.filter((demand) => demand.outstandingQuantity > 0).map((demand) => demand.materialId))],
    demands: demands.filter((demand) => demand.outstandingQuantity > 0),
    sourceEventIds: [...new Set(sourceEventIds)],
    planKnowledgeId: technique.knowledgeId,
  };
}

function exertionInputQuantities(rule: ExertionRule): Map<MaterialId, number> {
  const quantities = new Map<MaterialId, number>();
  quantities.set(rule.toolMaterialId, (quantities.get(rule.toolMaterialId) ?? 0) + 1);
  quantities.set(rule.inputMaterialId, (quantities.get(rule.inputMaterialId) ?? 0) + 1);
  return quantities;
}

function knownExertionRequirement(
  state: SimulationState,
  person: PersonState,
  technique: ReliableExertionTechnique,
): ProjectMaterialRequirement | null {
  const demands: ProjectMaterialDemand[] = [];
  const sourceEventIds = [...technique.sourceEventIds];
  for (const [materialId, quantity] of exertionInputQuantities(technique.rule)) {
    if (consumableInventoryQuantity(person, materialId) >= quantity) continue;
    const nested = knownOutputRequirement(state, person, materialId);
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
  const knownIntermediateRequirements: ProjectMaterialRequirement[] = [];
  const knownOutputAccess = {
    preferLocalFinishedOutput: project.desiredFunction === 'iron-workshop'
      || project.desiredFunction === 'water-powered-crop-processing'
      || project.desiredFunction === 'restore-water-powered-crop-processing',
    allowVisibleHolder: projectSupportsMaterialContribution(project),
  };
  let explicitRequirementPlanKnowledgeId: string | undefined;
  let explicitRequirementSourceFactIds: string[] = [];
  const requireRaw = (materialId: MaterialId, quantity: number) => {
    if (consumableInventoryQuantity(person, materialId) < quantity) rawRequirements.set(materialId, Math.max(
      rawRequirements.get(materialId) ?? 0, quantity,
    ));
  };
  const requireKnownOutputOrRaw = (materialId: MaterialId, quantity = 1) => {
    if (consumableInventoryQuantity(person, materialId) >= quantity) return;
    const known = knownOutputRequirement(state, person, materialId, knownOutputAccess);
    if (known) knownIntermediateRequirements.push(known);
    else requireRaw(materialId, quantity);
  };
  if (project.desiredFunction === 'water-powered-crop-processing') {
    const mechanicalRequirement = mechanicalPowerMaterialRequirement(state, person, project);
    for (const materialId of mechanicalRequirement.materialIds) {
      const known = personallyKnownProcessRequirement(state, person, materialId, knownOutputAccess);
      if (known.demands.length || known.planKnowledgeId) knownIntermediateRequirements.push(known);
      else requireRaw(materialId, 1);
    }
    explicitRequirementPlanKnowledgeId = mechanicalRequirement.planKnowledgeId;
    explicitRequirementSourceFactIds = mechanicalRequirement.sourceFactIds;
  }
  if (project.desiredFunction === 'restore-water-powered-crop-processing') {
    const mechanicalRequirement = mechanicalPowerMaintenanceMaterialRequirement(state, person, project);
    for (const materialId of mechanicalRequirement.materialIds) {
      const known = personallyKnownProcessRequirement(state, person, materialId, knownOutputAccess);
      if (known.demands.length || known.planKnowledgeId) knownIntermediateRequirements.push(known);
      else requireRaw(materialId, 1);
    }
    explicitRequirementPlanKnowledgeId = mechanicalRequirement.planKnowledgeId;
    explicitRequirementSourceFactIds = mechanicalRequirement.sourceFactIds;
  }
  if (project.desiredFunction === 'efficient-production') {
    requireRaw(Material.Wood, 1);
    if (consumableInventoryQuantity(person, Material.Rope) === 0) requireRaw(Material.Fiber, 2);
  }
  if (project.desiredFunction === 'settled-cultivation') {
    const cultivatedCells = projectCultivationCells(project)
      .filter((cellId) => cultivationSurfaceMaterials.has(surfaceMaterial(state.world.grid, cellId)));
    if (cultivatedCells.length < 6) requireRaw(Material.Seed, 1);
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
  if (project.desiredFunction === 'brick-firing') requireRaw(Material.Clay, 1);
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
  if (project.desiredFunction === 'iron-workshop') {
    // Both inputs are already explicit consequences of the observed workshop
    // hypothesis. Resolve each through the same personal known-output graph;
    // this does not infer any hidden Smithy recipe or remote material source.
    requireKnownOutputOrRaw(Material.Bronze);
    requireKnownOutputOrRaw(Material.FiredBrick);
  }
  if (project.desiredFunction === 'iron-charge') {
    requireRaw(Material.IronOre, 1);
    requireRaw(Material.Charcoal, 1);
  }
  if (project.desiredFunction === 'iron-reduction') requireRaw(Material.IronCharge, 1);
  if (project.desiredFunction === 'iron-working') {
    requireRaw(Material.IronBloom, 1);
    requireRaw(Material.Charcoal, 1);
  }
  if (project.desiredFunction === 'iron-tooling') {
    requireRaw(Material.Iron, 1);
    requireRaw(Material.Wood, 1);
  }
  if (project.desiredFunction === 'civic-coordination') {
    requireRaw(Material.FiredBrick, 1);
    if (consumableInventoryQuantity(person, Material.WoodTablet) === 0) {
      const visible = new Set(visibleCellsFor(person));
      const visibleTabletHolder = state.people.some((candidate) => candidate.id !== person.id
        && isAlive(candidate)
        && visible.has(candidate.position.cellId)
        && consumableInventoryQuantity(candidate, Material.WoodTablet) > 0);
      if (visibleTabletHolder) requireRaw(Material.WoodTablet, 1);
      else {
        requireRaw(Material.Wood, 1);
        requireRaw(Material.StoneTool, 1);
      }
    }
  }
  const rawDemands = [...rawRequirements].map(([materialId, quantity]) => materialDemand(
    person, materialId, quantity, `development-subassembly:${project.desiredFunction}:${materialId}`,
  )).filter((demand) => demand.outstandingQuantity > 0);
  const materialDemands = [
    ...knownIntermediateRequirements.flatMap((requirement) => requirement.demands),
    ...rawDemands,
  ].filter((demand) => demand.outstandingQuantity > 0);
  if (materialDemands.length) return {
    materialIds: [...new Set(materialDemands.map((demand) => demand.materialId))],
    demands: materialDemands,
    sourceEventIds: [...new Set([
      ...project.triggerFactIds,
      ...knownIntermediateRequirements.flatMap((requirement) => requirement.sourceEventIds),
      ...explicitRequirementSourceFactIds,
    ])],
    ...((knownIntermediateRequirements.find((requirement) => requirement.planKnowledgeId)?.planKnowledgeId
      ?? explicitRequirementPlanKnowledgeId)
      ? { planKnowledgeId: knownIntermediateRequirements.find((requirement) => requirement.planKnowledgeId)?.planKnowledgeId
        ?? explicitRequirementPlanKnowledgeId }
      : {}),
  };
  if (project.desiredFunction === 'weather-shelter') {
    if (shelterBuildingStack(person)) return null;
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
    if (knownHeat) return knownExertionRequirement(state, person, knownHeat);
    const knownManipulator = reliableMissingManipulatorRecipe(person);
    if (knownManipulator) return knownOutputRequirement(
      state, person, knownManipulator.rule.output.materialId, knownOutputAccess,
    );
    return null;
  }
  if (project.desiredFunction === 'durable-record') {
    if (blankRecordCarrier(person)) return null;
    const knownCarrierRecipe = reliableRecordCarrierRecipe(person);
    if (knownCarrierRecipe) return knownOutputRequirement(
      state, person, knownCarrierRecipe.rule.output.materialId, knownOutputAccess,
    );
    const knownCarrierTechnique = reliableRecordCarrierTechnique(person);
    if (knownCarrierTechnique) return knownExertionRequirement(state, person, knownCarrierTechnique);
    const knownManipulator = reliableMissingManipulatorRecipe(person);
    if (knownManipulator) return knownOutputRequirement(
      state, person, knownManipulator.rule.output.materialId, knownOutputAccess,
    );
    return null;
  }
  for (const output of completedFunctionMaterialIds(project)) {
    const known = knownOutputRequirement(state, person, output, knownOutputAccess);
    if (known?.materialIds.length) return known;
  }
  return null;
}

function activeProjectMaterialDemands(
  project: ProjectState,
  requirement: ProjectMaterialRequirement,
): ProjectMaterialDemand[] {
  if (project.desiredFunction !== 'iron-workshop') return requirement.demands;
  const directRootDemands = requirement.demands.filter((demand) => (
    demand.outstandingQuantity > 0
    && IRON_WORKSHOP_DIRECT_OUTPUTS.includes(demand.materialId as typeof IRON_WORKSHOP_DIRECT_OUTPUTS[number])
    && demand.branchKey.startsWith('known-direct-output:')
  ));
  return directRootDemands.length ? directRootDemands : requirement.demands;
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
      const nested = compileKnownOutput(
        state,
        person,
        visibleDrops,
        materialId,
        project.summary,
        {
          preferLocalFinishedOutput: project.desiredFunction === 'iron-workshop',
          allowVisibleHolder: projectSupportsMaterialContribution(project),
        },
      );
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

function metallurgyWorkStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  project: ProjectState,
): ProjectStep | null {
  const metallurgyFunctions = new Set<ProjectFunction>([
    'brick-firing',
    'copper-charge', 'copper-smelting', 'tin-charge', 'tin-smelting',
    'bronze-alloying', 'bronze-tooling', 'bronze-workshop',
    'iron-charge', 'iron-reduction', 'iron-working', 'iron-tooling',
  ]);
  if (!metallurgyFunctions.has(project.desiredFunction)) return null;
  const workplace = fixedProjectWorkplace(state, person, project);
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
    const known = compileKnownExposureStep(person, wood, workplace.target, [Material.Charcoal]);
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

  const smeltingInput = project.desiredFunction === 'brick-firing'
    ? Material.Clay
    : project.desiredFunction === 'copper-smelting'
      ? Material.CopperCharge
    : project.desiredFunction === 'tin-smelting'
      ? Material.TinCharge
      : project.desiredFunction === 'iron-reduction'
        ? Material.IronCharge
      : undefined;
  if (smeltingInput !== undefined) {
    const subject = person.inventory.find((stack) => stack.materialId === smeltingInput && isConsumableProjectStack(stack));
    if (!subject) return null;
    const known = compileKnownExposureStep(
      person,
      subject,
      workplace.target,
      completedFunctionMaterialIds(project),
    );
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
    const knownExposure = compileKnownExposureStep(
      person,
      raw,
      hotTarget,
      completedFunctionMaterialIds(project),
    );
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

function compileProjectWorkStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  project: ProjectState,
): ProjectStep | null {
  if (project.desiredFunction === 'restore-water-powered-crop-processing') {
    const mechanicalStep = mechanicalPowerMaintenanceProjectStep(state, person, project);
    if (mechanicalStep) return mechanicalStep;
    const requirement = mechanicalPowerMaintenanceMaterialRequirement(state, person, project);
    for (const outputMaterialId of requirement.materialIds) {
      const known = compileKnownOutput(
        state,
        person,
        visibleDrops,
        outputMaterialId,
        project.summary,
        {
          preferLocalFinishedOutput: true,
          allowVisibleHolder: projectSupportsMaterialContribution(project),
        },
      );
      if (known) return known;
    }
    return null;
  }
  if (project.desiredFunction === 'water-powered-crop-processing') {
    const mechanicalStep = mechanicalPowerProjectStep(state, person, project);
    if (mechanicalStep) return mechanicalStep;
    const requirement = mechanicalPowerMaterialRequirement(state, person, project);
    for (const outputMaterialId of requirement.materialIds) {
      const known = compileKnownOutput(
        state,
        person,
        visibleDrops,
        outputMaterialId,
        project.summary,
        {
          preferLocalFinishedOutput: true,
          allowVisibleHolder: projectSupportsMaterialContribution(project),
        },
      );
      if (known) return known;
    }
    return null;
  }
  const verification = tentativeTechniqueStep(state, person, project);
  if (verification) return verification;
  const cultivation = settledCultivationProjectStep(state, person, project);
  if (cultivation) return cultivation;
  if (project.desiredFunction === 'weather-shelter') return constructionProjectStep(state, person, visibleDrops, project);
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
  if (project.desiredFunction === 'iron-workshop') {
    // A direct root object already in local reach outranks manufacturing any
    // sibling precursor. The full AND requirement is still compiled below;
    // only this month's executable branch is deferred to ordinary logistics.
    if (!localFinishedIronWorkshopOutputs(state, person, project).length) {
      for (const output of IRON_WORKSHOP_DIRECT_OUTPUTS) {
        if (consumableInventoryQuantity(person, output) > 0) continue;
        const known = compileKnownOutput(
          state,
          person,
          visibleDrops,
          output,
          project.summary,
          {
            preferLocalFinishedOutput: true,
            allowVisibleHolder: projectSupportsMaterialContribution(project),
          },
        );
        if (known) return known;
      }
    }
  }
  const metallurgy = metallurgyWorkStep(state, person, visibleDrops, project);
  if (metallurgy) return metallurgy;
  const subassembly = developmentSubassemblyStep(state, person, project);
  if (subassembly) return subassembly;
  const upgrade = containerUpgradeStep(state, person, project);
  if (upgrade) return upgrade;
  const care = careApplicationProjectStep(state, person, project);
  if (care) return care;
  const baselineProductionToolRank = projectProductionToolBaselineRank(project);
  const candidateOutputs = completedFunctionMaterialIds(project)
    .sort((left, right) => productionToolRank(right) - productionToolRank(left));
  for (const output of candidateOutputs) {
    if (verifiedProductionToolFunctions.has(project.desiredFunction)
      && productionToolRank(output) <= baselineProductionToolRank) continue;
    const known = compileKnownOutput(
      state,
      person,
      visibleDrops,
      output,
      project.summary,
      {
        preferLocalFinishedOutput: project.desiredFunction === 'iron-workshop',
        allowVisibleHolder: projectSupportsMaterialContribution(project),
      },
    );
    if (known) return known;
  }
  // Cultivation already has a complete physical loop. When the anchored field
  // is waiting for moisture or growth, there is no unknown recipe to guess.
  // Returning null lets the outer compiler source a missing seed, or wait.
  if (project.desiredFunction === 'settled-cultivation') return null;
  const pendingSubassembly = [
    'efficient-production', 'community-coordination', 'reserve-storage',
    'reliable-water', 'crop-processing', 'high-heat-processing', 'brick-firing',
    'copper-charge', 'copper-smelting', 'tin-charge', 'tin-smelting',
    'bronze-alloying', 'bronze-tooling', 'bronze-workshop', 'civic-coordination',
    'iron-workshop', 'iron-charge', 'iron-reduction', 'iron-working', 'iron-tooling',
  ].includes(project.desiredFunction)
    && Boolean(projectMaterialRequirement(state, person, project)?.demands.length);
  if (pendingSubassembly) return null;
  return hypothesisStep(state, person, visibleDrops, project);
}

type ProjectKnowledgeRequestCompilation =
  | { status: 'action'; step: ProjectStep }
  | { status: 'waiting' }
  | { status: 'unavailable' };

function mechanicalProjectKnowledgeRequestStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  outputMaterialId: MaterialId,
  prerequisiteSourceFactIds: string[] = [],
): ProjectKnowledgeRequestCompilation {
  const previous = (project.knowledgeRequests ?? [])
    .filter((request) => request.outputMaterialId === outputMaterialId)
    .sort((left, right) => right.atMonth - left.atMonth
      || right.requestEventId.localeCompare(left.requestEventId))[0];
  if (previous) {
    return inspectProjectKnowledgeRequest(
      state,
      project,
      previous,
      state.clock.elapsedMonths + 1,
    ) === 'open' ? { status: 'waiting' } : { status: 'unavailable' };
  }
  const visible = new Set(visibleCellsFor(person));
  const listeners = state.people.filter((candidate) => candidate.id !== person.id
    && isAlive(candidate)
    && visible.has(candidate.position.cellId)
    && Math.abs(candidate.position.z - person.position.z) <= 2)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (!listeners.length) return { status: 'unavailable' };
  const materialName = materialDefinition(outputMaterialId).name;
  const representationId = `project-knowledge-request:${project.id}:${outputMaterialId}`;
  return {
    status: 'action',
    step: {
      key: representationId,
      summary: `向眼前的人询问怎样制作项目下一步所需的${materialName}`,
      reason: '本人能够从亲身劳动与冻结计划辨认下一部件，但尚无可靠制作经验；请求只说明部件，不包含本人未知的配方输入，也不预判谁会回答',
      action: {
        kind: 'communicate',
        content: {
          id: representationId,
          kind: 'request',
          summary: `“${project.summary}”下一步需要${materialName}，我还不知道怎样制作，谁能教我？`,
          projectKnowledgeRequest: {
            version: 'project-knowledge-request-v1',
            projectId: project.id,
            requesterId: person.id,
            outputMaterialId,
            expiresAtMonth: state.clock.elapsedMonths + 12,
          },
        },
        audience: listeners.map((listener) => listener.id),
        channel: 'gesture',
      },
      sourceFactIds: [...new Set([...project.triggerFactIds, ...prerequisiteSourceFactIds])],
      missingMaterialIds: [],
      reservations: [],
    },
  };
}

function materialContributionRequestStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  requirement: ProjectMaterialRequirement,
  activeDemands: ProjectMaterialDemand[] = requirement.demands,
): ProjectStep | null {
  if (project.ownerId !== person.id
    || !projectSupportsMaterialContribution(project)
    || !project.site) return null;
  const visible = new Set(visibleCellsFor(person));
  const possibleContributors = state.people.filter((candidate) => candidate.id !== person.id
    && isAlive(candidate)
    && visible.has(candidate.position.cellId));
  const selected = activeDemands.flatMap((demand) => {
    if (demand.outstandingQuantity <= 0
      || project.materialContributionRequests?.some((request) => request.materialId === demand.materialId
        && inspectProjectMaterialContributionRequest(
          state,
          project,
          request,
          state.clock.elapsedMonths + 1,
          demand,
        ).status === 'open')) return [];
    const holders = possibleContributors.filter((candidate) => (
      consumableInventoryQuantity(candidate, demand.materialId) > 0
    ));
    return holders.length ? [{ demand, holders }] : [];
  }).sort((left, right) => left.demand.materialId - right.demand.materialId)[0];
  if (!selected) return null;
  const quantity = Math.min(
    selected.demand.outstandingQuantity,
    selected.holders.reduce((sum, holder) => (
      sum + consumableInventoryQuantity(holder, selected.demand.materialId)
    ), 0),
  );
  if (quantity <= 0) return null;
  const materialName = materialDefinition(selected.demand.materialId).name;
  const metallurgyRequest = projectUsesFixedMetallurgyWorkplace(project);
  return {
    key: `request-project-material-${project.id}-${selected.demand.materialId}`,
    summary: `请求附近持料者把${materialName}送到${metallurgyRequest ? '固定冶炼工地' : '固定项目工地'}`,
    reason: metallurgyRequest
      ? '项目已经记录具体缺口和固定设施；请求只发给眼前确实持有该材料的人，不会读取远处背包或追逐移动目标'
      : '项目已经记录具体缺口和固定地点；请求只发给眼前确实持有该材料的人，不会读取远处背包或追逐移动目标',
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
        .filter((stack) => stack.materialId === selected.demand.materialId && isConsumableProjectStack(stack))
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
  activeDemands: ProjectMaterialDemand[] = requirement.demands,
): ProjectStep | null {
  const demands = new Map(activeDemands
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
  if (project.ownerId === person.id
    || !projectSupportsMaterialContribution(project)
    || !project.site) return null;
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
  const stack = person.inventory.find((candidate) => candidate.materialId === request.materialId
    && isConsumableProjectStack(candidate));
  if (!stack) return null;
  const remaining = view.deliverableQuantity;
  if (!remaining) return null;
  const usesFixedWorkplace = projectUsesFixedMetallurgyWorkplace(project);
  const metallurgyWorkplace = usesFixedWorkplace
    ? fixedProjectWorkplace(state, person, { ...project, site: request.site })
    : null;
  if (usesFixedWorkplace && !metallurgyWorkplace) return null;
  const destination = metallurgyWorkplace?.workingPosition ?? request.site;
  const atWorkplace = person.position.cellId === destination.cellId
    && person.position.z === destination.z;
  const materialName = materialDefinition(request.materialId).name;
  if (!atWorkplace) return {
    key: `carry-project-material-${project.id}-${request.requestEventId}`,
    summary: `把${materialName}运往${usesFixedWorkplace ? '固定冶炼工地' : '固定项目工地'}`,
    reason: usesFixedWorkplace
      ? '本人收到与真实项目缺口绑定的请求；运输目标是固定设施，不追逐正在移动的项目所有者'
      : '本人收到与真实项目缺口绑定的请求；运输目标是固定地点，不追逐正在移动的项目所有者',
    action: { kind: 'move', toCellId: destination.cellId, toZ: destination.z },
    ...(metallurgyWorkplace ? { target: { kind: 'voxel' as const, position: metallurgyWorkplace.target.position } } : {}),
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
    ...(metallurgyWorkplace ? { target: { kind: 'voxel' as const, position: metallurgyWorkplace.target.position } } : {}),
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
  if (project.ownerId !== person.id
    && projectSupportsMaterialContribution(project)) {
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

  if (project.desiredFunction === 'water-powered-crop-processing') {
    const mechanicalRequirement = mechanicalPowerMaterialRequirement(state, person, project);
    if (mechanicalRequirement.unknownRecipeOutputMaterialId !== undefined) {
      const knowledgeGap = pendingProjectKnowledgeGap(state, project);
      const knowledgeRequest = mechanicalProjectKnowledgeRequestStep(
        state,
        person,
        project,
        mechanicalRequirement.unknownRecipeOutputMaterialId,
        knowledgeGap?.outputMaterialId === mechanicalRequirement.unknownRecipeOutputMaterialId
          ? knowledgeGap.sourceFactIds
          : [],
      );
      if (knowledgeRequest.status === 'action') return knowledgeRequest.step;
      if (knowledgeRequest.status === 'waiting') return null;
      // One unanswered bounded request does not become an unlimited social
      // retry. The existing finite, local and fallible inquiry remains the
      // only fallback once no request can currently advance the project.
      return hypothesisStep(state, person, visibleDrops, project);
    }
  }

  const requirement = projectMaterialRequirement(state, person, project);
  if (!requirement?.materialIds.length) return null;
  // Keep the exact current branch on the authoritative project even when the
  // finite source search has no next step. Lifecycle release can then compare
  // an exhausted campaign with the demand that actually produced it instead
  // of treating any historical search failure as terminal.
  project.missingMaterialIds = [...new Set(requirement.materialIds)];
  project.materialDemands = structuredClone(requirement.demands);
  if (requirement.planKnowledgeId) project.planKnowledgeId = requirement.planKnowledgeId;
  // Keep the authoritative AND requirement intact. When a local direct root
  // exists, only narrow the candidates considered for this immediate action;
  // after it is acquired, recompilation naturally exposes the sibling branch.
  const activeDemands = activeProjectMaterialDemands(project, requirement);
  const activeMaterialIds = [...new Set(activeDemands.map((demand) => demand.materialId))];
  const usesFixedWorkplace = projectUsesFixedMetallurgyWorkplace(project);
  const workplace = usesFixedWorkplace ? fixedProjectWorkplace(state, person, project) : null;
  if (usesFixedWorkplace && !workplace) return null;
  const destination = workplace?.workingPosition ?? project.site;
  const projectFacts = projectActionFacts(state, project);
  const materialHandoff = (project.materialContributionRequests ?? []).flatMap<ProjectMaterialHandoff>((request) => {
    const demand = activeDemands.find((candidate) => candidate.materialId === request.materialId);
    if (!demand || !destination) return [];
    const view = inspectProjectMaterialContributionRequest(
      state,
      project,
      request,
      state.clock.elapsedMonths + 1,
      demand,
    );
    const reversedDeliveryIndex = [...projectFacts].reverse().findIndex((event) => (
      transferMatchesProjectMaterialRequest(request, event)
      && event.action.kind === 'transfer'
      && event.action.to.kind === 'ground'
    ));
    const deliveryIndex = reversedDeliveryIndex < 0
      ? -1
      : projectFacts.length - 1 - reversedDeliveryIndex;
    const deliveryFact = deliveryIndex >= 0 ? projectFacts[deliveryIndex] : undefined;
    const ownerInspectedAfterDelivery = deliveryIndex >= 0 && projectFacts.slice(deliveryIndex + 1)
      .some((event) => event.who === project.ownerId
        && event.cellId === destination.cellId
        && event.toZ === destination.z);
    const deliveredDropVisible = Boolean(deliveryFact && visibleDrops.some((drop) => (
      drop.materialId === request.materialId
      && drop.cellId === destination.cellId
      && drop.z === destination.z
      && drop.sourceEventIds.includes(deliveryFact.id)
    )));
    const deliveredForInspection = view.outstandingQuantity > 0
      && Boolean(deliveryFact)
      && (!ownerInspectedAfterDelivery || deliveredDropVisible);
    if (view.status === 'open') return [{ kind: 'open' as const, request, demand }];
    return deliveredForInspection && deliveryFact
      ? [{ kind: 'delivered' as const, request, demand, deliveryFact }]
      : [];
  }).sort((left, right) => Number(right.kind === 'delivered') - Number(left.kind === 'delivered')
    || left.request.atMonth - right.request.atMonth
    || left.request.materialId - right.request.materialId)[0];
  if (materialHandoff && destination) {
    const atDestination = person.position.cellId === destination.cellId
      && person.position.z === destination.z;
    if (!atDestination) return {
      key: `return-for-project-material-${project.id}-${materialHandoff.request.requestEventId}`,
      summary: `返回固定${usesFixedWorkplace ? '冶炼工位' : '项目工地'}${materialHandoff.kind === 'delivered' ? '查收' : '接收'}${materialDefinition(materialHandoff.request.materialId).name}`,
      reason: materialHandoff.kind === 'delivered'
        ? '贡献事件已经记录材料留在请求绑定的固定地点；所有者必须先返场查收，不能把 fulfilled 误当成自己已经持有'
        : '本人已经向眼前持料者发出有期限的真实贡献请求；先回到请求绑定的固定地点，避免追逐材料或让交付物脱离项目视野',
      action: { kind: 'move', toCellId: destination.cellId, toZ: destination.z },
      ...(workplace ? { target: { kind: 'voxel' as const, position: workplace.target.position } } : {}),
      sourceFactIds: [...new Set([
        materialHandoff.request.requestEventId,
        ...(materialHandoff.kind === 'delivered' ? [materialHandoff.deliveryFact.id] : []),
        ...materialHandoff.demand.sourceFactIds,
      ])],
      missingMaterialIds: [...requirement.materialIds],
      materialDemands: structuredClone(requirement.demands),
      reservations: [],
    };
    if (materialHandoff.kind === 'delivered') {
      const deliveredDrop = nearestDrop(
        state,
        person,
        visibleDrops.filter((drop) => drop.sourceEventIds.includes(materialHandoff.deliveryFact.id)),
        [materialHandoff.request.materialId],
      );
      if (deliveredDrop) {
        const episode = startDropLogisticsEpisode(
          project,
          person,
          deliveredDrop,
          [...requirement.sourceEventIds, materialHandoff.deliveryFact.id],
          state.clock.elapsedMonths + 1,
          materialHandoff.demand,
        );
        return activeEpisodeStep(state, person, visibleDrops, project, episode);
      }
    }
    // At the fixed hand-off point there is no additional primitive action to
    // invent. Keeping the demand and request open lets the addressed holder's
    // request-bound transfer become the next causal event.
    if (materialHandoff.kind === 'open') return null;
  }
  const storedMaterial = storedProjectMaterialStep(state, person, project, requirement, activeDemands);
  if (storedMaterial) return storedMaterial;
  const contributionRequest = materialContributionRequestStep(
    state,
    person,
    project,
    requirement,
    activeDemands,
  );
  if (contributionRequest) return contributionRequest;
  const availableDrop = nearestDrop(state, person, visibleDrops, activeMaterialIds)
    ?? nearestRememberedDrop(state, person, activeMaterialIds);
  if (availableDrop) {
    const demand = activeDemands.find((candidate) => candidate.materialId === availableDrop.materialId);
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
  const renewableSourceDemand = activeDemands.find((demand) => (
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
  if (project.desiredFunction === 'water-powered-crop-processing') {
    const knowledgeGap = pendingProjectKnowledgeGap(state, project);
    if (knowledgeGap && activeDemands.some((demand) => (
      demand.materialId === knowledgeGap.outputMaterialId
        && demand.outstandingQuantity > 0
    ))) {
      const knowledgeRequest = mechanicalProjectKnowledgeRequestStep(
        state,
        person,
        project,
        knowledgeGap.outputMaterialId,
        knowledgeGap.sourceFactIds,
      );
      if (knowledgeRequest.status === 'action') return knowledgeRequest.step;
      if (knowledgeRequest.status === 'waiting') return null;
    }
  }
  const searchDestination = visibleReachableSearchDestination(state, person, project, activeMaterialIds);
  if (!searchDestination) return null;
  const episode = startSearchLogisticsEpisode(
    project,
    person,
    activeMaterialIds,
    searchDestination,
    requirement.sourceEventIds,
    state.clock.elapsedMonths + 1,
    activeDemands,
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
