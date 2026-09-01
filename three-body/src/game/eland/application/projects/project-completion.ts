import { Material, materialHas, type MaterialId } from '../../domain/material';
import { productionToolMultiplier, productionToolRank } from '../../domain/production-tool';
import type { ActionFact, DropState, SimulationState } from '../../domain/model';
import { isAlive } from '../../domain/person';
import type {
  ProjectFunction,
  ProjectFunctionalCommissioning,
  ProjectState,
} from '../../domain/project';
import {
  projectCurrentLeadId,
  projectEventHasEventTimeLead,
} from '../../domain/project-leadership';
import { shelterGeometryAt } from '../../domain/structure';
import { compareWorldEventsInCanonicalOrder, worldEventById } from '../../domain/event-index';
import { cellsInRadius, voxelAt } from '../../world/grid';
import {
  mechanicalPowerCompletionEvidence,
  mechanicalPowerMaintenanceCompletionEvidence,
} from '../mechanical-power-options';
import { massMeasurementProjectCompletionEvidence } from '../measurement-options';
import { electricalPowerProjectCompletionEvidence } from '../electrical-power-options';
import { electricalPowerMaintenanceCompletionEvidence } from '../electrical-power-maintenance-options';
import { capabilityReplicationAcquisitionFact } from './capability-replication';

export function completedFunctionMaterialIds(
  project: Pick<ProjectState, 'desiredFunction'>,
): MaterialId[] {
  if (project.desiredFunction === 'insulation') return [Material.LeatherClothing, Material.Clothing];
  if (project.desiredFunction === 'safer-hunting') return [Material.Spear];
  if (project.desiredFunction === 'healing') return [Material.HerbalMedicine];
  if (project.desiredFunction === 'prepared-food') return [Material.CookedFood];
  if (project.desiredFunction === 'efficient-production') return [Material.StoneHoe, Material.WoodTool];
  if (project.desiredFunction === 'workshop-production') return [Material.Workshop];
  if (project.desiredFunction === 'reserve-storage') return [Material.Granary];
  if (project.desiredFunction === 'reliable-water') return [Material.Cistern];
  if (project.desiredFunction === 'crop-processing') return [Material.Mill];
  if (project.desiredFunction === 'community-coordination') return [Material.CouncilHearth];
  if (project.desiredFunction === 'high-heat-processing') return [Material.Kiln];
  if (project.desiredFunction === 'brick-firing') return [Material.FiredBrick];
  if (project.desiredFunction === 'copper-charge') return [Material.CopperCharge];
  if (project.desiredFunction === 'copper-smelting') return [Material.Copper];
  if (project.desiredFunction === 'tin-charge') return [Material.TinCharge];
  if (project.desiredFunction === 'tin-smelting') return [Material.Tin];
  if (project.desiredFunction === 'bronze-alloying') return [Material.Bronze];
  if (project.desiredFunction === 'bronze-tooling') return [Material.BronzeTool];
  if (project.desiredFunction === 'bronze-workshop') return [Material.Foundry];
  if (project.desiredFunction === 'civic-coordination') return [Material.CivicHall];
  if (project.desiredFunction === 'iron-workshop') return [Material.Smithy];
  if (project.desiredFunction === 'iron-charge') return [Material.IronCharge];
  if (project.desiredFunction === 'iron-reduction') return [Material.IronBloom];
  if (project.desiredFunction === 'iron-working') return [Material.Iron];
  if (project.desiredFunction === 'iron-tooling') return [Material.IronTool];
  if (project.desiredFunction === 'fortified-coordination') return [Material.KeepCore];
  return [];
}

export function placedFunctionMaterialIds(project: ProjectState): MaterialId[] {
  return completedFunctionMaterialIds(project).filter((materialId) => materialHas(materialId, 'facility'));
}

export function projectActionFacts(state: SimulationState, project: ProjectState): ActionFact[] {
  return project.actionEventIds.flatMap((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action' ? [event] : [];
  });
}

export function durableRecordWriteEvidence(
  state: SimulationState,
  project: ProjectState,
): Array<{ writeFact: ActionFact; record: SimulationState['records'][number]; carrierStackId: string }> {
  if (project.desiredFunction !== 'durable-record' || !project.targetKnowledgeId) return [];
  return projectActionFacts(state, project).flatMap((writeFact) => {
    if (writeFact.status !== 'completed'
      || writeFact.who !== project.ownerId
      || writeFact.action.kind !== 'inscribe'
      || writeFact.action.inscriptionMeaning.factId !== project.targetKnowledgeId
      || writeFact.diff.knowledgeId !== project.targetKnowledgeId
      || typeof writeFact.diff.recordPayloadId !== 'string'
      || typeof writeFact.diff.carrierStackId !== 'string') return [];
    const record = state.records.find((candidate) => candidate.id === writeFact.diff.recordPayloadId
      && candidate.authorId === project.ownerId
      && candidate.knowledgeId === project.targetKnowledgeId
      && candidate.sourceEventIds.includes(writeFact.id));
    return record ? [{ writeFact, record, carrierStackId: writeFact.diff.carrierStackId }] : [];
  });
}

export function durableRecordPublicationEvidence(
  state: SimulationState,
  project: ProjectState,
): { writeFact: ActionFact; placementFact: ActionFact; drop: DropState } | null {
  // Legacy active projects without a fixed site remain explicitly unpublished.
  // Moving their site to the owner's current position would rewrite old intent.
  if (project.desiredFunction !== 'durable-record' || !project.site) return null;
  const actions = projectActionFacts(state, project);
  for (const written of durableRecordWriteEvidence(state, project).reverse()) {
    const placementFact = [...actions].reverse().find((fact) => fact.status === 'completed'
      && fact.who === project.ownerId
      && fact.action.kind === 'transfer'
      && fact.action.from.kind === 'person'
      && fact.action.from.personId === project.ownerId
      && fact.action.to.kind === 'ground'
      && fact.action.to.cellId === project.site?.cellId
      && fact.action.to.z === project.site?.z
      && fact.action.stackId === written.carrierStackId
      && fact.diff.recordPayloadId === written.record.id);
    if (!placementFact) continue;
    const sourceLineageKey = `inventory:${project.ownerId}:${written.carrierStackId}`;
    const drop = state.world.drops.find((candidate) => candidate.quantity > 0
      && candidate.cellId === project.site?.cellId
      && candidate.z === project.site?.z
      && candidate.recordPayloadId === written.record.id
      && candidate.sourceEventIds.includes(written.writeFact.id)
      && candidate.sourceEventIds.includes(placementFact.id)
      && candidate.sourceLineageKeys?.includes(sourceLineageKey));
    if (drop) return { writeFact: written.writeFact, placementFact, drop };
  }
  return null;
}

export const cultivationSurfaceMaterials = new Set<MaterialId>([
  Material.CropSprout,
  Material.CropMature,
  Material.ExhaustedSoil,
]);

export const plantableCultivationMaterials = new Set<MaterialId>([
  Material.WetSoil,
  Material.RichSoil,
  Material.ExhaustedSoil,
]);

export const harvestableSeedSourceMaterials = new Set<MaterialId>([
  Material.BerryBush,
  Material.CropMature,
]);

export function projectCultivationCells(project: Pick<ProjectState, 'site'>): number[] {
  return project.site ? cellsInRadius(project.site.cellId, 2) : [];
}

export function projectCultivationHarvests(
  state: SimulationState,
  project: ProjectState,
): ActionFact[] {
  return projectActionFacts(state, project).filter((event) => event.status === 'completed'
    && event.action.kind === 'act'
    && event.action.operation === 'separate'
    && Number(event.diff.sourceMaterialId) === Material.CropMature);
}

/** Distinct cells this exact project has actually planted, independent of their current surface. */
export function projectCultivationPlantingCells(
  state: SimulationState,
  project: ProjectState,
): number[] {
  return [...new Set(projectActionFacts(state, project).flatMap((event) => {
    if (event.status !== 'completed'
      || event.action.kind !== 'act'
      || event.action.operation !== 'combine'
      || Number(event.diff.outputMaterialId) !== Material.CropSprout) return [];
    const position = event.diff.position as { x?: unknown; y?: unknown } | undefined;
    if (![position?.x, position?.y].every((value) => Number.isInteger(Number(value)))) return [];
    return [Number(position?.x) + Number(position?.y) * state.world.grid.width];
  }))];
}

export function placedFunctionEvidence(state: SimulationState, project: ProjectState): ActionFact[] {
  const desired = new Set(placedFunctionMaterialIds(project));
  if (!desired.size) return [];
  return projectActionFacts(state, project).filter((event) => {
    if (event.status !== 'completed') return false;
    const outputMaterialId = Number(event.diff.outputMaterialId);
    const position = event.diff.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
    if (!desired.has(outputMaterialId)
      || ![position?.x, position?.y, position?.z].every((value) => Number.isInteger(Number(value)))) return false;
    return voxelAt(state.world.grid, Number(position?.x), Number(position?.y), Number(position?.z)) === outputMaterialId;
  });
}

interface FunctionalCommissioningRequirement {
  desiredFunction: ProjectFunction;
  serviceKind: ProjectFunctionalCommissioning['serviceKind'];
  facilityMaterialId: MaterialId;
  serviceRadius: number;
}

function functionalCommissioningRequirement(
  project: Pick<ProjectState, 'desiredFunction'>,
): FunctionalCommissioningRequirement | null {
  if (project.desiredFunction === 'crop-processing') return {
    desiredFunction: 'crop-processing',
    serviceKind: 'crop-mature-separation',
    facilityMaterialId: Material.Mill,
    serviceRadius: 1,
  };
  return null;
}

export function projectRequiresFunctionalCommissioning(
  project: Pick<ProjectState, 'desiredFunction'>,
): boolean {
  return functionalCommissioningRequirement(project) !== null;
}

function factOutputPosition(fact: ActionFact): { x: number; y: number; z: number } | null {
  const position = fact.diff.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
  if (![position?.x, position?.y, position?.z].every((value) => Number.isInteger(Number(value)))) return null;
  return { x: Number(position?.x), y: Number(position?.y), z: Number(position?.z) };
}

function installationFactMatches(
  state: SimulationState,
  project: ProjectState,
  requirement: FunctionalCommissioningRequirement,
  fact: ActionFact,
): boolean {
  if (fact.status !== 'completed'
    || fact.action.kind !== 'act'
    || fact.action.operation !== 'combine'
    || Number(fact.diff.inputMaterialId) !== requirement.facilityMaterialId
    || Number(fact.diff.targetMaterialId) !== Material.Air
    || Number(fact.diff.outputMaterialId) !== requirement.facilityMaterialId
    || fact.diff.sourceEventId !== fact.id) return false;
  const position = factOutputPosition(fact);
  const target = fact.action.targets.find((candidate) => candidate.kind === 'voxel');
  if (!position
    || target?.kind !== 'voxel'
    || target.position.x !== position.x
    || target.position.y !== position.y
    || target.position.z !== position.z
    || voxelAt(state.world.grid, position.x, position.y, position.z) !== requirement.facilityMaterialId) return false;
  if (project.site) {
    const installationCellId = position.x + position.y * state.world.grid.width;
    if (installationCellId !== project.site.cellId || position.z !== project.site.z) return false;
  }
  return true;
}

function currentCommissioningInstallation(
  state: SimulationState,
  project: ProjectState,
  requirement: FunctionalCommissioningRequirement,
): ActionFact | null {
  return projectActionFacts(state, project)
    .filter((fact) => installationFactMatches(state, project, requirement, fact))
    .sort((left, right) => right.atMonth - left.atMonth
      || right.orderInMonth - left.orderInMonth
      || right.id.localeCompare(left.id))[0] ?? null;
}

/**
 * Enter commissioning only from this project's still-present installation.
 * Calling this while compiling a step freezes eligibility before the service
 * action is executed, preventing an unrelated action from authorizing itself.
 */
export function establishProjectFunctionalCommissioning(
  state: SimulationState,
  project: ProjectState,
): ProjectFunctionalCommissioning | null {
  const requirement = functionalCommissioningRequirement(project);
  if (!requirement) return null;
  const installation = currentCommissioningInstallation(state, project, requirement);
  if (!installation) return null;
  const position = factOutputPosition(installation);
  if (!position) return null;
  const eligiblePersonIds = [...new Set([
    project.ownerId,
    ...project.beneficiaryIds,
    ...project.contributorIds,
  ])];
  const current = project.functionalCommissioning;
  if (current?.version === 'project-functional-commissioning-v1'
    && current.desiredFunction === requirement.desiredFunction
    && current.serviceKind === requirement.serviceKind
    && current.facilityMaterialId === requirement.facilityMaterialId
    && current.installationEventId === installation.id
    && current.installationPosition.x === position.x
    && current.installationPosition.y === position.y
    && current.installationPosition.z === position.z
    && current.serviceRadius === requirement.serviceRadius) {
    return current;
  }
  project.functionalCommissioning = {
    version: 'project-functional-commissioning-v1',
    desiredFunction: requirement.desiredFunction,
    serviceKind: requirement.serviceKind,
    facilityMaterialId: requirement.facilityMaterialId,
    installationEventId: installation.id,
    installationPosition: position,
    serviceRadius: requirement.serviceRadius,
    enteredAtMonth: installation.atMonth,
    eligiblePersonIds,
    sourceFactIds: [installation.id],
  };
  return project.functionalCommissioning;
}

function currentFunctionalCommissioning(
  state: SimulationState,
  project: ProjectState,
): ProjectFunctionalCommissioning | null {
  const requirement = functionalCommissioningRequirement(project);
  const commissioning = project.functionalCommissioning;
  if (!requirement
    || commissioning?.version !== 'project-functional-commissioning-v1'
    || commissioning.desiredFunction !== requirement.desiredFunction
    || commissioning.serviceKind !== requirement.serviceKind
    || commissioning.facilityMaterialId !== requirement.facilityMaterialId
    || commissioning.serviceRadius !== requirement.serviceRadius) return null;
  const installation = currentCommissioningInstallation(state, project, requirement);
  if (!installation || installation.id !== commissioning.installationEventId) return null;
  const position = factOutputPosition(installation);
  if (!position
    || position.x !== commissioning.installationPosition.x
    || position.y !== commissioning.installationPosition.y
    || position.z !== commissioning.installationPosition.z) return null;
  return commissioning;
}

function eventFollowsInstallation(service: ActionFact, installation: ActionFact): boolean {
  return service.atMonth > installation.atMonth
    || service.atMonth === installation.atMonth && service.orderInMonth > installation.orderInMonth;
}

function positiveCropProcessingService(fact: ActionFact): boolean {
  if (fact.status !== 'completed'
    || fact.action.kind !== 'act'
    || fact.action.operation !== 'separate'
    || Number(fact.diff.sourceMaterialId) !== Material.CropMature
    || Number(fact.diff.replacementMaterialId) !== Material.ExhaustedSoil
    || Number(fact.diff.facilityMaterialId) !== Material.Mill) return false;
  const multiplier = Number(fact.diff.productionMultiplier);
  if (!Number.isFinite(multiplier) || multiplier <= 0 || !Array.isArray(fact.diff.outputs)) return false;
  const foodQuantity = fact.diff.outputs.reduce((sum, output) => {
    if (!output || typeof output !== 'object') return sum;
    const candidate = output as { materialId?: unknown; quantity?: unknown };
    return Number(candidate.materialId) === Material.Food
      ? sum + Math.max(0, Number(candidate.quantity) || 0)
      : sum;
  }, 0);
  const withoutFacility = Math.max(4, Math.floor(4 * multiplier));
  return foodQuantity > withoutFacility;
}

function functionalCommissioningEvidence(
  state: SimulationState,
  project: ProjectState,
): string[] {
  const commissioning = currentFunctionalCommissioning(state, project);
  if (!commissioning) return [];
  const installation = worldEventById(state, commissioning.installationEventId);
  if (installation?.kind !== 'action') return [];
  for (const fact of projectActionFacts(state, project)) {
    if (!eventFollowsInstallation(fact, installation)
      || !commissioning.eligiblePersonIds.includes(fact.who)
      || !positiveCropProcessingService(fact)) continue;
    const target = fact.action.kind === 'act'
      ? fact.action.targets.find((candidate) => candidate.kind === 'voxel')
      : undefined;
    if (target?.kind !== 'voxel') continue;
    const distance = Math.abs(target.position.x - commissioning.installationPosition.x)
      + Math.abs(target.position.y - commissioning.installationPosition.y);
    if (distance > commissioning.serviceRadius) continue;
    return [installation.id, fact.id];
  }
  return [];
}

function portableFunctionEvidenceIds(state: SimulationState, project: ProjectState): string[] {
  const currentLeadId = projectCurrentLeadId(project);
  const currentLead = state.people.find((person) => person.id === currentLeadId && isAlive(person));
  if (!currentLead) return [];
  const desired = new Set(completedFunctionMaterialIds(project));
  const projectActionIds = new Set(project.actionEventIds);
  return [...new Set(currentLead.inventory
    .filter((stack) => stack.quantity > 0 && desired.has(stack.materialId))
    .flatMap((stack) => stack.sourceEventIds.filter((eventId) => {
      if (!projectActionIds.has(eventId)) return false;
      const event = worldEventById(state, eventId);
      return event?.kind === 'action'
        && event.status === 'completed'
        && event.who === currentLead.id
        && projectEventHasEventTimeLead(project, event)
        && event.action.kind === 'act'
        && desired.has(Number(event.diff.outputMaterialId));
    })))];
}

export const verifiedProductionToolFunctions = new Set<ProjectFunction>([
  'efficient-production',
  'bronze-tooling',
  'iron-tooling',
]);

/**
 * Tool projects compare their output with the capability that existed when the
 * project opened. Legacy projects predate that frozen fact; rank zero keeps
 * them finishable while the normal project-made output and verification gates
 * still apply.
 */
export function projectProductionToolBaselineRank(project: ProjectState): number {
  const rank = project.productionToolBaselineRank;
  return typeof rank === 'number' && Number.isFinite(rank) && rank >= 0
    ? Math.floor(rank)
    : 0;
}

/**
 * A first accidental output is still only a sample. Tool projects finish after
 * the owner has a project-made upgrade in hand and the exact making technique
 * has become reliable (normally through the existing source-bound attend step).
 */
function verifiedProductionToolEvidenceIds(state: SimulationState, project: ProjectState): string[] {
  const currentLeadId = projectCurrentLeadId(project);
  const currentLead = state.people.find((person) => person.id === currentLeadId && isAlive(person));
  if (!currentLead) return [];
  const desired = new Set(completedFunctionMaterialIds(project));
  const portableEvidence = new Set(portableFunctionEvidenceIds(state, project));
  const baselineRank = projectProductionToolBaselineRank(project);
  const outputFacts = projectActionFacts(state, project).filter((event) => event.status === 'completed'
    && event.who === currentLead.id
    && projectEventHasEventTimeLead(project, event)
    && event.action.kind === 'act'
    && event.action.operation === 'combine'
    && desired.has(Number(event.diff.outputMaterialId))
    && productionToolRank(Number(event.diff.outputMaterialId)) > baselineRank
    && portableEvidence.has(event.id));
  for (const output of outputFacts.reverse()) {
    const techniqueId = typeof output.diff.techniqueId === 'string' ? output.diff.techniqueId : undefined;
    const knowledge = techniqueId ? currentLead.knowledge.find((fact) => fact.id === techniqueId
      && fact.kind === 'technique'
      && fact.confidence >= 55
      && fact.sourceEventIds.includes(output.id)) : undefined;
    if (!knowledge) continue;
    return [...new Set([
      output.id,
      ...project.actionEventIds.filter((eventId) => knowledge.sourceEventIds.includes(eventId)),
    ])];
  }
  return [];
}

function capabilityReplicationEvidenceIds(state: SimulationState, project: ProjectState): string[] {
  const basis = project.capabilityReplicationBasis;
  const owner = basis
    ? state.people.find((person) => person.id === project.ownerId && isAlive(person))
    : undefined;
  if (!basis
    || !owner
    || basis.observerId !== owner.id
    || project.need !== 'production-efficiency'
    || project.desiredFunction !== 'efficient-production') return [];
  for (const stack of owner.inventory
    .filter((candidate) => candidate.quantity > 0 && candidate.materialId === basis.outputMaterialId)
    .sort((left, right) => left.id.localeCompare(right.id))) {
    const acquisition = capabilityReplicationAcquisitionFact(state, owner, project, stack);
    if (!acquisition) continue;
    const use = projectActionFacts(state, project).find((event) => event.status === 'completed'
      && event.who === owner.id
      && projectEventHasEventTimeLead(project, event)
      && compareWorldEventsInCanonicalOrder(acquisition, event) < 0
      && event.action.kind === 'act'
      && event.action.operation === 'separate'
      && event.action.toolStackId === stack.id
      && event.diff.toolStackId === stack.id
      && Number(event.diff.toolMaterialId) === basis.outputMaterialId
      && Number(event.diff.productionMultiplier) === productionToolMultiplier(basis.outputMaterialId)
      && typeof event.diff.sourceMaterialId === 'number'
      && Array.isArray(event.diff.outputs)
      && event.diff.outputs.some((output) => Boolean(output)
        && typeof output === 'object'
        && Number((output as { quantity?: unknown }).quantity) > 0));
    if (!use) continue;
    const teachingResponseIds = (project.knowledgeRequests ?? []).flatMap((request) => (
      request.outputMaterialId === basis.outputMaterialId && request.responseEventId
        ? [request.responseEventId]
        : []
    ));
    return [...new Set([...teachingResponseIds, acquisition.id, use.id])];
  }
  return [];
}

export function projectFunctionSatisfied(state: SimulationState, project: ProjectState): boolean {
  if (project.hibernationRescueBasis) {
    const sleeper = state.people.find((person) => person.id === project.hibernationRescueBasis?.sleeperId && isAlive(person));
    return Boolean(sleeper
      && !sleeper.conditions.some((condition) => condition.id === project.hibernationRescueBasis?.hibernationConditionId)
      && Math.min(sleeper.body.health, sleeper.body.hydration, sleeper.body.nutrition) >= 45);
  }
  if (project.capabilityReplicationBasis) {
    return capabilityReplicationEvidenceIds(state, project).length > 0;
  }
  if (project.desiredFunction === 'restore-electrical-power-delivery') {
    return electricalPowerMaintenanceCompletionEvidence(state, project).length > 0;
  }
  if (project.desiredFunction === 'remote-work-power-delivery') {
    return electricalPowerProjectCompletionEvidence(state, project).length > 0;
  }
  if (project.desiredFunction === 'comparable-mass-measurement') {
    return massMeasurementProjectCompletionEvidence(state, project).length > 0;
  }
  if (project.desiredFunction === 'restore-water-powered-crop-processing'
    || project.desiredFunction === 'durable-power-transmission') {
    return mechanicalPowerMaintenanceCompletionEvidence(state, project).length > 0;
  }
  if (project.desiredFunction === 'water-powered-crop-processing') {
    return mechanicalPowerCompletionEvidence(state, project).length > 0;
  }
  if (project.desiredFunction === 'weather-shelter') {
    if (!project.site) return false;
    const shelter = shelterGeometryAt(state.world.grid, project.site);
    if (!shelter) return false;
    const requirement = project.shelterRequirement;
    if (!requirement) return true;
    return shelter.enclosedSides >= requirement.minimumEnclosedSides
      && shelter.weatherProtection > requirement.baselineWeatherProtection
      && shelter.thermalInsulation > requirement.baselineThermalInsulation;
  }
  if (project.desiredFunction === 'durable-record') {
    return durableRecordPublicationEvidence(state, project) !== null;
  }
  if (project.desiredFunction === 'settled-cultivation') {
    const plantedByProject = projectCultivationPlantingCells(state, project).length >= 6;
    const harvests = projectCultivationHarvests(state, project).length;
    return plantedByProject && harvests >= 2;
  }
  if (projectRequiresFunctionalCommissioning(project)) {
    return functionalCommissioningEvidence(state, project).length > 0;
  }
  if (project.desiredFunction === 'reserve-storage') {
    return placedFunctionEvidence(state, project).some((event) => {
      const position = event.diff.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
      const container = state.containers.find((candidate) => candidate.position.x === Number(position?.x)
        && candidate.position.y === Number(position?.y)
        && candidate.position.z === Number(position?.z));
      const storedFood = container?.inventory.reduce((sum, stack) => (
        materialHas(stack.materialId, 'edible') ? sum + stack.quantity : sum
      ), 0) ?? 0;
      const transfers = projectActionFacts(state, project).filter((candidate) => candidate.status === 'completed'
        && candidate.action.kind === 'transfer'
        && candidate.action.to.kind === 'container'
        && candidate.action.to.containerId === container?.id).length;
      return storedFood >= 2 && transfers >= 2;
    });
  }
  if (placedFunctionMaterialIds(project).length) return placedFunctionEvidence(state, project).length > 0;
  if (project.desiredFunction === 'healing') return false;
  if (verifiedProductionToolFunctions.has(project.desiredFunction)) {
    return verifiedProductionToolEvidenceIds(state, project).length > 0;
  }
  return portableFunctionEvidenceIds(state, project).length > 0;
}

export function projectCompletionEvidence(state: SimulationState, project: ProjectState): string[] {
  if (project.hibernationRescueBasis) {
    return projectActionFacts(state, project)
      .filter((event) => event.status === 'completed' && (
        event.action.kind === 'act' && event.action.operation === 'rehydrate'
        || event.action.kind === 'transfer' && (
          event.action.materialId === Material.Water
          || materialHas(event.action.materialId, 'edible')
        )
      ))
      .map((event) => event.id);
  }
  if (project.capabilityReplicationBasis) {
    return capabilityReplicationEvidenceIds(state, project);
  }
  if (project.desiredFunction === 'restore-electrical-power-delivery') {
    return electricalPowerMaintenanceCompletionEvidence(state, project);
  }
  if (project.desiredFunction === 'remote-work-power-delivery') {
    return electricalPowerProjectCompletionEvidence(state, project);
  }
  if (project.desiredFunction === 'comparable-mass-measurement') {
    return massMeasurementProjectCompletionEvidence(state, project);
  }
  if (project.desiredFunction === 'restore-water-powered-crop-processing'
    || project.desiredFunction === 'durable-power-transmission') {
    return mechanicalPowerMaintenanceCompletionEvidence(state, project);
  }
  if (project.desiredFunction === 'water-powered-crop-processing') {
    return mechanicalPowerCompletionEvidence(state, project);
  }
  if (project.desiredFunction === 'weather-shelter') return [...project.actionEventIds];
  if (project.desiredFunction === 'durable-record') {
    const publication = durableRecordPublicationEvidence(state, project);
    return publication ? [publication.writeFact.id, publication.placementFact.id] : [];
  }
  if (project.desiredFunction === 'settled-cultivation') {
    return [...new Set(projectActionFacts(state, project)
      .filter((event) => event.status === 'completed')
      .map((event) => event.id))];
  }
  if (projectRequiresFunctionalCommissioning(project)) {
    return functionalCommissioningEvidence(state, project);
  }
  if (placedFunctionMaterialIds(project).length) return [...new Set([
    ...placedFunctionEvidence(state, project).map((event) => event.id),
    ...(project.desiredFunction === 'reserve-storage'
      ? projectActionFacts(state, project).filter((event) => event.status === 'completed'
        && event.action.kind === 'transfer'
        && event.action.to.kind === 'container').map((event) => event.id)
      : []),
  ])];
  if (verifiedProductionToolFunctions.has(project.desiredFunction)) {
    return verifiedProductionToolEvidenceIds(state, project);
  }
  return portableFunctionEvidenceIds(state, project);
}
