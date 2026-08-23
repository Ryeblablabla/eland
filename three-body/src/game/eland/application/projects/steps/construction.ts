import type { WorldRef } from '../../../domain/action';
import { Material, materialHas, type MaterialId } from '../../../domain/material';
import type { DropState, SimulationState } from '../../../domain/model';
import type { PersonState } from '../../../domain/person';
import type { ProjectState } from '../../../domain/project';
import { shelterGeometryAt } from '../../../domain/structure';
import {
  cellX,
  cellY,
  neighbors4,
  standingPositions,
  voxelAt,
} from '../../../world/grid';
import { seededFraction } from '../../../world/generator';
import {
  dropStep,
  isConsumableProjectStack,
  materialDemand,
  nearestDrop,
  reservation,
} from '../project-material-planning';
import type { ProjectStep } from '../project-step';

function isShelterComponentMaterial(materialId: MaterialId): boolean {
  // Placeable objects are already assembled containers, facilities or machine
  // parts. They may stand on their own, but are not generic wall material.
  return materialHas(materialId, 'solid')
    && materialHas(materialId, 'building')
    && !materialHas(materialId, 'placeable');
}

export function shelterBuildingStack(person: PersonState) {
  return person.inventory
    .filter((stack) => isConsumableProjectStack(stack)
      && isShelterComponentMaterial(stack.materialId))
    .sort((a, b) => b.quantity - a.quantity || a.materialId - b.materialId)[0];
}

function solidBuildingAt(
  state: SimulationState,
  position: { x: number; y: number; z: number },
): boolean {
  const materialId = voxelAt(state.world.grid, position.x, position.y, position.z);
  return materialHas(materialId, 'solid')
    && (materialHas(materialId, 'building') || materialHas(materialId, 'ground'));
}

function nextConstructionPosition(
  state: SimulationState,
  project: ProjectState,
): { x: number; y: number; z: number } | null {
  if (!project.site) return null;
  const site = project.site;
  const requirement = project.shelterRequirement;
  const currentShelter = shelterGeometryAt(state.world.grid, site);
  if (requirement) {
    // An adaptation project remains bound to the enclosure that produced its
    // exposure evidence. It must not fall through to the generic blueprint.
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

  const support = voxelAt(state.world.grid, side.lower.x, side.lower.y, side.lower.z - 1);
  if (support !== Material.Air
    && support !== Material.Water
    && voxelAt(state.world.grid, side.lower.x, side.lower.y, side.lower.z) === Material.Air) return side.lower;
  if (solidBuildingAt(state, side.lower)
    && voxelAt(state.world.grid, side.upper.x, side.upper.y, side.upper.z) === Material.Air) return side.upper;
  const roof = { x: cellX(site.cellId), y: cellY(site.cellId), z: site.z + 2 };
  if (voxelAt(state.world.grid, roof.x, roof.y, roof.z) === Material.Air
    && solidBuildingAt(state, side.upper)) return roof;
  return null;
}

export function constructionProjectStep(
  state: SimulationState,
  person: PersonState,
  visibleDrops: DropState[],
  project: ProjectState,
): ProjectStep | null {
  if (project.desiredFunction !== 'weather-shelter' || !project.site) return null;
  const stack = shelterBuildingStack(person);
  if (!stack) {
    const candidates = visibleDrops
      .filter((candidate) => isShelterComponentMaterial(candidate.materialId));
    const drop = nearestDrop(state, person, candidates, candidates.map((candidate) => candidate.materialId));
    if (!drop) return null;
    const step = dropStep(person, drop, project.summary, materialDemand(
      person,
      drop.materialId,
      1,
      `construction-next-placement:${drop.materialId}`,
      drop.sourceEventIds,
    ));
    return step ? { ...step, missingMaterialIds: [drop.materialId] } : null;
  }
  if (person.position.cellId !== project.site.cellId || person.position.z !== project.site.z) return {
    key: `return-site-${project.site.cellId}-${project.site.z}`,
    summary: '带着材料回到未完成遮蔽项目的工作位置',
    reason: '已经取得项目所需材料，回到原址继续连接比另开碎片化地点更有用',
    action: { kind: 'move', toCellId: project.site.cellId, toZ: project.site.z },
    sourceFactIds: [...new Set([...project.actionEventIds, ...stack.sourceEventIds])],
    missingMaterialIds: [],
    reservations: reservation(person, stack.id),
  };
  const position = nextConstructionPosition(state, project);
  if (!position) return null;
  const target: WorldRef = { kind: 'voxel', position };
  return {
    key: `place-${position.x}-${position.y}-${position.z}-${stack.id}`,
    summary: `继续${project.summary}的下一处实体连接`,
    reason: '目标位置是同一功能结构当前最早缺失的支撑、侧向连接或顶盖，不会另开碎片化地点',
    action: {
      kind: 'act',
      operation: 'combine',
      targets: [{ kind: 'inventory-stack', personId: person.id, stackId: stack.id }, target],
    },
    target,
    sourceFactIds: [...new Set([...project.actionEventIds, ...stack.sourceEventIds])],
    missingMaterialIds: [],
    reservations: reservation(person, stack.id),
  };
}
