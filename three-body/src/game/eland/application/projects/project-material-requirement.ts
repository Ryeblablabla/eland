import type {
  ExertionRule,
  InventoryCombinationRule,
} from '../../domain/interaction-rules';
import { Material, materialHas, type MaterialId } from '../../domain/material';
import type { SimulationState } from '../../domain/model';
import { inventoryQuantity, isAlive, type PersonState } from '../../domain/person';
import type { ProjectMaterialDemand, ProjectState } from '../../domain/project';
import { personReliablyKnowsOutput } from '../../domain/project-knowledge-request';
import { resolvePersonKnownProcess } from '../../domain/person-known-process';
import {
  mechanicalPowerMaintenanceMaterialRequirement,
  mechanicalPowerMaterialRequirement,
  mechanicalPowerReliabilityMaterialRequirement,
} from '../mechanical-power-options';
import { electricalPowerMaterialRequirement } from '../electrical-power-options';
import { electricalPowerMaintenanceMaterialRequirement } from '../electrical-power-maintenance-options';
import { currentMassMeasurementInstrument, currentMassMeasurementReference } from '../measurement-options';
import {
  completedFunctionMaterialIds,
  projectCultivationPlantingCells,
} from './project-completion';
import { consumableInventoryQuantity, materialDemand } from './project-material-planning';
import { locallyKnownPlacedContainer, visibleCellsFor } from './project-perception';
import {
  auditedTechniqueMaterialPlanProvenance,
  projectMaterialPlanProvenance,
  type ProjectMaterialPlanProvenance,
} from './project-material-provenance';
import {
  blankRecordCarrier,
  reliableExertionTechniques,
  type ReliableExertionTechnique,
} from './project-inquiry';
import { shelterBuildingStack } from './steps/construction';
import {
  knownExposurePlan,
  knownRecipe,
  localFinishedOutputAccess,
  reliableKnownRecipe,
  type KnownOutputAccessOptions,
} from './steps/known-material-production';

export function projectSupportsMaterialContribution(project: Pick<ProjectState, 'need' | 'desiredFunction'>): boolean {
  return project.need === 'alloy-capability'
    || project.need === 'iron-capability'
    || project.need === 'mechanical-power-capability'
    || project.need === 'equipment-reliability'
    || (project.need === 'coordination-capacity' && project.desiredFunction === 'civic-coordination');
}

export interface ProjectMaterialRequirement {
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

export function exertionInputQuantities(rule: ExertionRule): Map<MaterialId, number> {
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

export function reliableHeatTechnique(person: PersonState): ReliableExertionTechnique | undefined {
  return reliableExertionTechniques(person).find((technique) => technique.rule.outputLocation === 'world'
    && materialHas(technique.rule.outputMaterialId, 'hot'));
}

export function reliableRecordCarrierTechnique(person: PersonState): ReliableExertionTechnique | undefined {
  return reliableExertionTechniques(person).find((technique) => technique.rule.outputLocation === 'inventory'
    && materialHas(technique.rule.outputMaterialId, 'recordable'));
}

export function reliableRecordCarrierRecipe(person: PersonState): { rule: InventoryCombinationRule; knowledgeId: string } | null {
  return reliableKnownRecipe(person, (materialId) => materialHas(materialId, 'recordable'));
}

export function reliableMissingManipulatorRecipe(person: PersonState): { rule: InventoryCombinationRule; knowledgeId: string } | null {
  return reliableKnownRecipe(person, (materialId) => materialHas(materialId, 'tool')
    && inventoryQuantity(person, materialId) === 0);
}

export function projectMaterialRequirement(state: SimulationState, person: PersonState, project: ProjectState): ProjectMaterialRequirement | null {
  const rawRequirements = new Map<MaterialId, number>();
  const knownIntermediateRequirements: ProjectMaterialRequirement[] = [];
  let exactPlanProvenance = projectMaterialPlanProvenance(state, person, project);
  const knownOutputAccess = {
    preferLocalFinishedOutput: project.desiredFunction === 'iron-workshop'
      || project.desiredFunction === 'water-powered-crop-processing'
      || project.desiredFunction === 'restore-water-powered-crop-processing'
      || project.desiredFunction === 'durable-power-transmission'
      || project.desiredFunction === 'remote-work-power-delivery'
      || project.desiredFunction === 'restore-electrical-power-delivery'
      || project.desiredFunction === 'comparable-mass-measurement',
    allowVisibleHolder: projectSupportsMaterialContribution(project),
  };
  let explicitRequirementPlanKnowledgeId: string | undefined;
  let explicitRequirementSourceFactIds: string[] = [];
  const requireRaw = (materialId: MaterialId, quantity: number) => {
    if (!exactPlanProvenance) return;
    if (consumableInventoryQuantity(person, materialId) < quantity) rawRequirements.set(materialId, Math.max(
      rawRequirements.get(materialId) ?? 0, quantity,
    ));
  };
  const acceptExplicitPlanProvenance = (
    knowledgeId: string | undefined,
    sourceFactIds: string[],
  ): ProjectMaterialPlanProvenance | null => {
    const verified = auditedTechniqueMaterialPlanProvenance(person, knowledgeId);
    if (!verified) return null;
    exactPlanProvenance ??= {
      ...verified,
      sourceFactIds: [...new Set([...verified.sourceFactIds, ...sourceFactIds])],
    };
    return exactPlanProvenance;
  };
  const requireKnownOutputOrRaw = (materialId: MaterialId, quantity = 1) => {
    if (consumableInventoryQuantity(person, materialId) >= quantity) return;
    const known = knownOutputRequirement(state, person, materialId, knownOutputAccess);
    if (known) knownIntermediateRequirements.push(known);
    else requireRaw(materialId, quantity);
  };
  if (project.desiredFunction === 'water-powered-crop-processing') {
    const mechanicalRequirement = mechanicalPowerMaterialRequirement(state, person, project);
    acceptExplicitPlanProvenance(mechanicalRequirement.planKnowledgeId, mechanicalRequirement.sourceFactIds);
    for (const materialId of exactPlanProvenance ? mechanicalRequirement.materialIds : []) {
      const known = personallyKnownProcessRequirement(state, person, materialId, knownOutputAccess);
      if (known.demands.length || known.planKnowledgeId) knownIntermediateRequirements.push(known);
      else requireRaw(materialId, 1);
    }
    explicitRequirementPlanKnowledgeId = mechanicalRequirement.planKnowledgeId;
    explicitRequirementSourceFactIds = mechanicalRequirement.sourceFactIds;
  }
  if (project.desiredFunction === 'restore-water-powered-crop-processing') {
    const mechanicalRequirement = mechanicalPowerMaintenanceMaterialRequirement(state, person, project);
    acceptExplicitPlanProvenance(mechanicalRequirement.planKnowledgeId, mechanicalRequirement.sourceFactIds);
    for (const materialId of exactPlanProvenance ? mechanicalRequirement.materialIds : []) {
      const known = personallyKnownProcessRequirement(state, person, materialId, knownOutputAccess);
      if (known.demands.length || known.planKnowledgeId) knownIntermediateRequirements.push(known);
      else requireRaw(materialId, 1);
    }
    explicitRequirementPlanKnowledgeId = mechanicalRequirement.planKnowledgeId;
    explicitRequirementSourceFactIds = mechanicalRequirement.sourceFactIds;
  }
  if (project.desiredFunction === 'durable-power-transmission') {
    const mechanicalRequirement = mechanicalPowerReliabilityMaterialRequirement(state, person, project);
    acceptExplicitPlanProvenance(mechanicalRequirement.planKnowledgeId, mechanicalRequirement.sourceFactIds);
    for (const materialId of exactPlanProvenance ? mechanicalRequirement.materialIds : []) {
      const known = personallyKnownProcessRequirement(state, person, materialId, knownOutputAccess);
      if (known.demands.length || known.planKnowledgeId) knownIntermediateRequirements.push(known);
      else requireRaw(materialId, 1);
    }
    explicitRequirementPlanKnowledgeId = mechanicalRequirement.planKnowledgeId;
    explicitRequirementSourceFactIds = mechanicalRequirement.sourceFactIds;
  }
  if (project.desiredFunction === 'remote-work-power-delivery') {
    const electricalRequirement = electricalPowerMaterialRequirement(state, person, project);
    acceptExplicitPlanProvenance(electricalRequirement.planKnowledgeId, electricalRequirement.sourceFactIds);
    for (const materialId of exactPlanProvenance ? electricalRequirement.materialIds : []) {
      const known = personallyKnownProcessRequirement(state, person, materialId, knownOutputAccess);
      if (known.demands.length || known.planKnowledgeId) knownIntermediateRequirements.push(known);
      else requireRaw(materialId, 1);
    }
    explicitRequirementPlanKnowledgeId = electricalRequirement.planKnowledgeId;
    explicitRequirementSourceFactIds = electricalRequirement.sourceFactIds;
  }
  if (project.desiredFunction === 'restore-electrical-power-delivery') {
    const electricalRequirement = electricalPowerMaintenanceMaterialRequirement(state, person, project);
    acceptExplicitPlanProvenance(electricalRequirement.planKnowledgeId, electricalRequirement.sourceFactIds);
    for (const materialId of exactPlanProvenance ? electricalRequirement.materialIds : []) {
      const known = personallyKnownProcessRequirement(state, person, materialId, knownOutputAccess);
      if (known.demands.length || known.planKnowledgeId) knownIntermediateRequirements.push(known);
      else requireRaw(materialId, 1);
    }
    explicitRequirementPlanKnowledgeId = electricalRequirement.planKnowledgeId;
    explicitRequirementSourceFactIds = electricalRequirement.sourceFactIds;
  }
  if (project.desiredFunction === 'comparable-mass-measurement') {
    const missingArtifacts = [
      ...(currentMassMeasurementInstrument(state, person) ? [] : [Material.BeamBalance]),
      ...(currentMassMeasurementReference(state, person) ? [] : [Material.StandardWeight]),
    ];
    for (const outputMaterialId of missingArtifacts) {
      const known = knownOutputRequirement(state, person, outputMaterialId, knownOutputAccess);
      if (known) knownIntermediateRequirements.push(known);
    }
  }
  if (project.capabilityReplicationBasis
    && personReliablyKnowsOutput(person, project.capabilityReplicationBasis.outputMaterialId)) {
    const known = personallyKnownProcessRequirement(
      state,
      person,
      project.capabilityReplicationBasis.outputMaterialId,
    );
    if (known.demands.length || known.planKnowledgeId) knownIntermediateRequirements.push(known);
  } else if (project.desiredFunction === 'efficient-production') {
    requireRaw(Material.Wood, 1);
    if (consumableInventoryQuantity(person, Material.Rope) === 0) requireRaw(Material.Fiber, 2);
  }
  if (project.desiredFunction === 'settled-cultivation') {
    if (projectCultivationPlantingCells(state, project).length < 6) requireRaw(Material.Seed, 1);
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
      ...(exactPlanProvenance?.sourceFactIds ?? []),
    ])],
    ...((knownIntermediateRequirements.find((requirement) => requirement.planKnowledgeId)?.planKnowledgeId
      ?? explicitRequirementPlanKnowledgeId
      ?? exactPlanProvenance?.knowledgeId)
      ? { planKnowledgeId: knownIntermediateRequirements.find((requirement) => requirement.planKnowledgeId)?.planKnowledgeId
        ?? explicitRequirementPlanKnowledgeId
        ?? exactPlanProvenance?.knowledgeId }
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
