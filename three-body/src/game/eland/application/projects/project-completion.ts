import { Material, materialHas, type MaterialId } from '../../domain/material';
import { productionToolRank } from '../../domain/production-tool';
import type { ActionFact, DropState, SimulationState } from '../../domain/model';
import { isAlive } from '../../domain/person';
import type { ProjectFunction, ProjectState } from '../../domain/project';
import { shelterGeometryAt } from '../../domain/structure';
import { worldEventById } from '../../domain/event-index';
import { cellsInRadius, voxelAt } from '../../world/grid';
import {
  mechanicalPowerCompletionEvidence,
  mechanicalPowerMaintenanceCompletionEvidence,
} from '../mechanical-power-options';

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
      || writeFact.action.kind !== 'communicate'
      || writeFact.action.channel !== 'record'
      || writeFact.action.content.kind !== 'claim'
      || writeFact.action.content.factId !== project.targetKnowledgeId
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

function portableFunctionEvidenceIds(state: SimulationState, project: ProjectState): string[] {
  const owner = state.people.find((person) => person.id === project.ownerId && isAlive(person));
  if (!owner) return [];
  const desired = new Set(completedFunctionMaterialIds(project));
  const projectActionIds = new Set(project.actionEventIds);
  return [...new Set(owner.inventory
    .filter((stack) => stack.quantity > 0 && desired.has(stack.materialId))
    .flatMap((stack) => stack.sourceEventIds.filter((eventId) => projectActionIds.has(eventId))))];
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
  const owner = state.people.find((person) => person.id === project.ownerId && isAlive(person));
  if (!owner) return [];
  const desired = new Set(completedFunctionMaterialIds(project));
  const portableEvidence = new Set(portableFunctionEvidenceIds(state, project));
  const baselineRank = projectProductionToolBaselineRank(project);
  const outputFacts = projectActionFacts(state, project).filter((event) => event.status === 'completed'
    && event.who === owner.id
    && event.action.kind === 'act'
    && event.action.operation === 'combine'
    && desired.has(Number(event.diff.outputMaterialId))
    && productionToolRank(Number(event.diff.outputMaterialId)) > baselineRank
    && portableEvidence.has(event.id));
  for (const output of outputFacts.reverse()) {
    const techniqueId = typeof output.diff.techniqueId === 'string' ? output.diff.techniqueId : undefined;
    const knowledge = techniqueId ? owner.knowledge.find((fact) => fact.id === techniqueId
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

export function projectFunctionSatisfied(state: SimulationState, project: ProjectState): boolean {
  if (project.desiredFunction === 'restore-water-powered-crop-processing') {
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
    const plantedCells = projectActionFacts(state, project).flatMap((event) => {
      if (event.kind !== 'action'
        || event.status !== 'completed'
        || event.action.kind !== 'act'
        || event.action.operation !== 'combine'
        || Number(event.diff.outputMaterialId) !== Material.CropSprout) return [];
      const position = event.diff.position as { x?: unknown; y?: unknown } | undefined;
      if (![position?.x, position?.y].every((value) => Number.isInteger(Number(value)))) return [];
      return [Number(position?.x) + Number(position?.y) * state.world.grid.width];
    });
    const plantedByProject = new Set(plantedCells).size >= 6;
    const harvests = projectCultivationHarvests(state, project).length;
    return plantedByProject && harvests >= 2;
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
  if (project.desiredFunction === 'restore-water-powered-crop-processing') {
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
