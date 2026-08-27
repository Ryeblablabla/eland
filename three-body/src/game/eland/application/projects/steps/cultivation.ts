import { Material } from '../../../domain/material';
import {
  bestProductionToolStack,
  isProductionToolMaterial,
  productionToolRank,
} from '../../../domain/production-tool';
import { groundToolInteractionTechniquePrefix } from '../../../domain/interaction-rules';
import {
  knowsReliableNoResponse,
  voxelNoResponseFactId,
} from '../../../domain/interaction-knowledge';
import type { SimulationState } from '../../../domain/model';
import { inventoryQuantity, type PersonState } from '../../../domain/person';
import type { ProjectState } from '../../../domain/project';
import {
  cellX,
  cellY,
  findStandingPath,
  surfaceMaterial,
  topPosition,
} from '../../../world/grid';
import {
  cultivationSurfaceMaterials,
  plantableCultivationMaterials,
  projectCultivationCells,
  projectCultivationHarvests,
  projectCultivationPlantingCells,
} from '../project-completion';
import { isConsumableProjectStack, reservation } from '../project-material-planning';
import { visibleCellsFor } from '../project-perception';
import type { ProjectStep } from '../project-step';

export function settledCultivationProjectStep(
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
  const siteCells = projectCultivationCells(project);
  const cultivatedCells = siteCells
    .filter((cellId) => cultivationSurfaceMaterials.has(surfaceMaterial(state.world.grid, cellId)));
  const plantedCells = new Set(projectCultivationPlantingCells(state, project));
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
          kind: 'act',
          operation: 'separate',
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
  if (plantedCells.size >= 6) return null;
  const seed = person.inventory.find((stack) => stack.materialId === Material.Seed
    && isConsumableProjectStack(stack));
  const target = siteCells
    .filter((cellId) => visible.has(cellId)
      && !plantedCells.has(cellId)
      && plantableCultivationMaterials.has(surfaceMaterial(state.world.grid, cellId)))
    .map((cellId) => ({
      cellId,
      position: topPosition(state.world.grid, cellId),
      path: findStandingPath(state.world.grid, person.position, { cellId }),
    }))
    .filter((candidate) => candidate.path.length > 0)
    .sort((left, right) => left.path.length - right.path.length || left.cellId - right.cellId)[0];
  if (target) {
    if (!seed) return null;
    const closeEnough = Math.abs(cellX(person.position.cellId) - target.position.x)
      + Math.abs(cellY(person.position.cellId) - target.position.y) <= 1;
    return {
      key: `settled-cultivation-plant-${target.cellId}-${seed.id}`,
      summary: closeEnough ? '把留存种子播入尚未耕种的本地土壤' : '带着种子前往尚未耕种的本地土壤',
      reason: '项目仍缺少真实播种过的位置；先使用本人眼前可达且尚未计入项目的地块',
      action: closeEnough
        ? {
          kind: 'act',
          operation: 'combine',
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

  const packedTarget = siteCells
    .filter((cellId) => visible.has(cellId)
      && !plantedCells.has(cellId)
      && surfaceMaterial(state.world.grid, cellId) === Material.PackedSoil)
    .map((cellId) => ({
      cellId,
      position: topPosition(state.world.grid, cellId),
      path: findStandingPath(state.world.grid, person.position, { cellId }),
    }))
    .filter((candidate) => candidate.path.length > 0)
    .sort((left, right) => left.path.length - right.path.length || left.cellId - right.cellId)[0];
  if (!packedTarget) return null;
  const toolCandidate = person.inventory
    .filter((stack) => stack.quantity > 0 && isProductionToolMaterial(stack.materialId))
    .map((stack) => {
      const techniquePrefix = groundToolInteractionTechniquePrefix(
        stack.materialId,
        Material.PackedSoil,
      );
      return {
        stack,
        knownTechnique: person.knowledge.find((fact) => fact.kind === 'technique'
          && fact.id.startsWith(techniquePrefix)
          && fact.sourceEventIds.length > 0),
        noResponseFactId: voxelNoResponseFactId(
          'exert',
          Material.PackedSoil,
          Material.PackedSoil,
          stack.materialId,
        ),
      };
    })
    .filter((candidate) => candidate.knownTechnique
      || !knowsReliableNoResponse(person, candidate.noResponseFactId))
    .sort((left, right) => Number(Boolean(right.knownTechnique)) - Number(Boolean(left.knownTechnique))
      // Unknown experiments begin with the lower generic capability rank;
      // this is a bounded, observable ordering rather than a hidden rule match.
      || (left.knownTechnique
        ? (right.knownTechnique?.confidence ?? 0) - left.knownTechnique.confidence
        : productionToolRank(left.stack.materialId) - productionToolRank(right.stack.materialId))
      || left.stack.sourceEventIds.join('|').localeCompare(right.stack.sourceEventIds.join('|'))
      || left.stack.id.localeCompare(right.stack.id))[0];
  if (!toolCandidate) return null;
  const fieldTool = toolCandidate.stack;
  const knownTechnique = toolCandidate.knownTechnique;
  const closeEnough = Math.abs(cellX(person.position.cellId) - packedTarget.position.x)
    + Math.abs(cellY(person.position.cellId) - packedTarget.position.y) <= 1;
  return {
    key: `settled-cultivation-${knownTechnique ? 'reuse-ground-practice' : 'try-ground-effect'}-${packedTarget.cellId}-${fieldTool.id}`,
    summary: closeEnough
      ? knownTechnique ? `复用“${knownTechnique.summary}”` : '尝试让田间工具作用于眼前夯实地表'
      : knownTechnique ? '前往本地夯实地表复用已有田间经验' : '前往本地夯实地表进行一次田间工具尝试',
    reason: knownTechnique
      ? '本人已经从真实物质变化中取得这项有来源经验，项目仍缺少新的播种位置'
      : '项目仍缺少新的播种位置；本人只根据眼前夯实地表与手持田间工具进行局部尝试，结果尚未知',
    action: closeEnough
      ? {
        kind: 'act',
        operation: 'exert',
        toolStackId: fieldTool.id,
        targets: [{ kind: 'voxel', position: packedTarget.position }],
      }
      : {
        kind: 'move',
        toCellId: packedTarget.path.at(-1)!.cellId,
        toZ: packedTarget.path.at(-1)!.z,
      },
    target: { kind: 'voxel', position: packedTarget.position },
    sourceFactIds: [...new Set([
      ...project.triggerFactIds,
      ...fieldTool.sourceEventIds,
      ...(knownTechnique?.sourceEventIds ?? []),
    ])],
    missingMaterialIds: [],
    reservations: reservation(person, fieldTool.id),
  };
}
