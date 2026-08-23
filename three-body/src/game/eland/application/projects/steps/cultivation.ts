import { Material } from '../../../domain/material';
import { bestProductionToolStack } from '../../../domain/production-tool';
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
  if (cultivatedCells.length >= 6) return null;
  const seed = person.inventory.find((stack) => stack.materialId === Material.Seed
    && isConsumableProjectStack(stack));
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
