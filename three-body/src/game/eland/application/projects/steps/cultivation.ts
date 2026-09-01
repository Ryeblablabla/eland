import { Material, type MaterialId } from '../../../domain/material';
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

const FIELD_PREPARATION_SURFACES: readonly MaterialId[] = [
  Material.Soil,
  Material.PackedSoil,
  Material.Grass,
];

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

  const toolCandidate = siteCells
    .filter((cellId) => visible.has(cellId)
      && !plantedCells.has(cellId)
      && FIELD_PREPARATION_SURFACES.includes(surfaceMaterial(state.world.grid, cellId)))
    .map((cellId) => ({
      cellId,
      position: topPosition(state.world.grid, cellId),
      path: findStandingPath(state.world.grid, person.position, { cellId }),
      materialId: surfaceMaterial(state.world.grid, cellId),
    }))
    .filter((candidate) => candidate.path.length > 0)
    .flatMap((target) => person.inventory
      .filter((stack) => stack.quantity > 0 && isProductionToolMaterial(stack.materialId))
      .map((stack) => {
        const techniquePrefix = groundToolInteractionTechniquePrefix(
          stack.materialId,
          target.materialId,
        );
        return {
          target,
          stack,
          knownTechnique: person.knowledge.find((fact) => fact.kind === 'technique'
            && fact.id.startsWith(techniquePrefix)
            && fact.sourceEventIds.length > 0),
          noResponseFactId: voxelNoResponseFactId(
            'exert',
            target.materialId,
            target.materialId,
            stack.materialId,
          ),
        };
      }))
    .filter((candidate) => candidate.knownTechnique
      || !knowsReliableNoResponse(person, candidate.noResponseFactId))
    .sort((left, right) => (FIELD_PREPARATION_SURFACES.indexOf(left.target.materialId)
      - FIELD_PREPARATION_SURFACES.indexOf(right.target.materialId))
      || Number(Boolean(right.knownTechnique)) - Number(Boolean(left.knownTechnique))
      || left.target.path.length - right.target.path.length
      // Unknown experiments begin with the lower generic capability rank;
      // this is a bounded, observable ordering rather than a hidden rule match.
      || (left.knownTechnique
        ? (right.knownTechnique?.confidence ?? 0) - left.knownTechnique.confidence
        : productionToolRank(left.stack.materialId) - productionToolRank(right.stack.materialId))
      || left.stack.sourceEventIds.join('|').localeCompare(right.stack.sourceEventIds.join('|'))
      || left.stack.id.localeCompare(right.stack.id)
      || left.target.cellId - right.target.cellId)[0];
  if (!toolCandidate) {
    const clearingCapability = person.inventory
      .filter((stack) => stack.quantity > 0 && isProductionToolMaterial(stack.materialId))
      .map((stack) => ({
        stack,
        technique: person.knowledge.find((fact) => fact.kind === 'technique'
          && fact.id.startsWith(groundToolInteractionTechniquePrefix(stack.materialId, Material.Soil))
          && fact.sourceEventIds.length > 0),
      }))
      .filter((candidate): candidate is typeof candidate & { technique: NonNullable<typeof candidate.technique> } => (
        Boolean(candidate.technique)
      ))
      .sort((left, right) => right.technique.confidence - left.technique.confidence
        || productionToolRank(right.stack.materialId) - productionToolRank(left.stack.materialId)
        || left.stack.id.localeCompare(right.stack.id))[0];
    if (!clearingCapability) return null;
    const clearingTarget = siteCells
      .filter((cellId) => visible.has(cellId) && !plantedCells.has(cellId))
      .map((cellId) => ({
        cellId,
        position: topPosition(state.world.grid, cellId),
        path: findStandingPath(state.world.grid, person.position, { cellId }),
        materialId: surfaceMaterial(state.world.grid, cellId),
      }))
      .filter((candidate) => candidate.path.length > 0
        && (candidate.materialId === Material.Shrub || candidate.materialId === Material.Leaves))
      .sort((left, right) => Number(left.materialId === Material.Leaves)
        - Number(right.materialId === Material.Leaves)
        || left.path.length - right.path.length
        || left.cellId - right.cellId)[0];
    if (!clearingTarget) return null;
    const closeEnough = Math.abs(cellX(person.position.cellId) - clearingTarget.position.x)
      + Math.abs(cellY(person.position.cellId) - clearingTarget.position.y) <= 1;
    return {
      key: `settled-cultivation-clear-vegetation-${clearingTarget.cellId}`,
      summary: closeEnough ? '尝试分离固定地块内妨碍继续播种的植被' : '前往固定地块内尚未清理的植被',
      reason: '本项目仍缺少新的播种位置，且较易整理的裸土、夯土和草地已经用尽；只尝试分离眼前植被，不预告会得到何种地表',
      action: closeEnough
        ? {
          kind: 'act',
          operation: 'separate',
          targets: [{ kind: 'voxel', position: clearingTarget.position }],
          toolStackId: clearingCapability.stack.id,
        }
        : {
          kind: 'move',
          toCellId: clearingTarget.path.at(-1)!.cellId,
          toZ: clearingTarget.path.at(-1)!.z,
        },
      target: { kind: 'voxel', position: clearingTarget.position },
      sourceFactIds: [...new Set([
        ...project.triggerFactIds,
        ...clearingCapability.stack.sourceEventIds,
        ...clearingCapability.technique.sourceEventIds,
      ])],
      missingMaterialIds: [],
      reservations: reservation(person, clearingCapability.stack.id),
    };
  }
  const groundTarget = toolCandidate.target;
  const fieldTool = toolCandidate.stack;
  const knownTechnique = toolCandidate.knownTechnique;
  const closeEnough = Math.abs(cellX(person.position.cellId) - groundTarget.position.x)
    + Math.abs(cellY(person.position.cellId) - groundTarget.position.y) <= 1;
  return {
    key: `settled-cultivation-${knownTechnique ? 'reuse-ground-practice' : 'try-ground-effect'}-${groundTarget.cellId}-${fieldTool.id}`,
    summary: closeEnough
      ? knownTechnique ? `复用“${knownTechnique.summary}”` : '尝试让田间工具作用于眼前尚不可播种的地表'
      : knownTechnique ? '前往本地地表复用已有田间经验' : '前往本地尚不可播种的地表进行一次田间工具尝试',
    reason: knownTechnique
      ? '本人已经从真实物质变化中取得这项有来源经验，项目仍缺少新的播种位置'
      : '项目仍缺少新的播种位置；本人只根据眼前地表与手持田间工具进行局部尝试，结果尚未知',
    action: closeEnough
      ? {
        kind: 'act',
        operation: 'exert',
        toolStackId: fieldTool.id,
        targets: [{ kind: 'voxel', position: groundTarget.position }],
      }
      : {
        kind: 'move',
        toCellId: groundTarget.path.at(-1)!.cellId,
        toZ: groundTarget.path.at(-1)!.z,
      },
    target: { kind: 'voxel', position: groundTarget.position },
    sourceFactIds: [...new Set([
      ...project.triggerFactIds,
      ...fieldTool.sourceEventIds,
      ...(knownTechnique?.sourceEventIds ?? []),
    ])],
    missingMaterialIds: [],
    reservations: reservation(person, fieldTool.id),
  };
}
