import { materialDefinition, materialHas, type MaterialId } from './material';
import type { ActionFact, EnvironmentFact, PhysicalStructure } from './model';
import type { PersonId } from './person';
import { workAt, type WorkState } from './works';
import { rootedSolidPath } from './solid-support';
import {
  cellX,
  cellY,
  isStandingPosition,
  neighbors4,
  standingPositions,
  voxelAt,
  type StandingPosition,
  type VoxelWorld,
} from '../world/grid';

export interface ShelterGeometry {
  position: StandingPosition;
  overheadMaterialId: MaterialId;
  enclosedSides: number;
  openSides: number;
  weatherProtection: number;
  thermalInsulation: number;
  /** Physical works whose computed cover actually supplied this shelter. */
  workIds: string[];
}

export const STRUCTURE_USE_RECEIPT_VERSION = 'structure-use-receipt-v1' as const;

/**
 * 从行为账本即时折叠出的结构使用回执。它不存在结构实体里，
 * 因此不会把观察器的结论反馈给世界规则。
 */
export interface StructureUseReceipt {
  version: typeof STRUCTURE_USE_RECEIPT_VERSION;
  id: string;
  structureId: string;
  kind: 'use' | 'demonstration';
  functionKey: string;
  actorId: PersonId;
  witnessIds: PersonId[];
  atMonth: number;
  sourceEventId: string;
  evidencePaths: string[];
}

/** Captured by real exposure settlement, never reconstructed from later geometry. */
export interface PhysicalStructureUseBasis {
  structureId: string;
  constructionSourceEventIds: string[];
}

/**
 * 使用依据来自功能执行当时的回执。当前结构即使损坏，也不改变过去的
 * 实际减负；同位置取材、建造、观察或通行不能被追认为设施使用。
 */
export function observePhysicalStructureUseReceipts(
  structure: PhysicalStructure,
  events: readonly (ActionFact | EnvironmentFact)[],
): StructureUseReceipt[] {
  return events.flatMap((event) => {
    if (event.kind === 'environment') {
      const use = event.diff.shelterUse as {
        structures?: PhysicalStructureUseBasis[];
        coldLoadWithoutShelter?: number; coldLoad?: number;
        heatLoadWithoutShelter?: number; heatLoad?: number;
      } | undefined;
      if (event.change !== 'body' || !event.who || !Array.isArray(use?.structures)) return [];
      const captured = use.structures.some((basis) => basis.structureId === structure.id
        && Array.isArray(basis.constructionSourceEventIds)
        && basis.constructionSourceEventIds.some((id) => structure.sourceEventIds.includes(id)));
      if (!captured) return [];
      const reduced = (typeof use.coldLoadWithoutShelter === 'number' && typeof use.coldLoad === 'number' && use.coldLoadWithoutShelter > use.coldLoad)
        || (typeof use.heatLoadWithoutShelter === 'number' && typeof use.heatLoad === 'number' && use.heatLoadWithoutShelter > use.heatLoad);
      if (!reduced) return [];
      return [{
        version: STRUCTURE_USE_RECEIPT_VERSION,
        id: `structure-use:${structure.id}:${event.id}`,
        structureId: structure.id, kind: 'use' as const, functionKey: 'thermal-protection',
        actorId: event.who, witnessIds: [], atMonth: event.atMonth,
        sourceEventId: event.id, evidencePaths: ['diff.shelterUse', 'diff.shelterUse.structures'],
      }];
    }
    return [];
  });
}

/**
 * A roof and one wall provide shade; additional real side layers let the
 * structure's insulation buffer heat instead of merely satisfying a label.
 */
export function shelterHeatRelief(shelter: ShelterGeometry | null | undefined): number {
  if (!shelter) return 0;
  const shadeRelief = shelter.weatherProtection / 145;
  const layeredSides = Math.max(0, shelter.enclosedSides - 1);
  return shadeRelief + layeredSides * shelter.thermalInsulation / 80;
}

function solidBuildingAt(world: VoxelWorld, cell: number, z: number): boolean {
  const materialId = voxelAt(world, cellX(cell), cellY(cell), z);
  return materialHas(materialId, 'solid') && (materialHas(materialId, 'building') || materialHas(materialId, 'ground'))
    && Boolean(rootedSolidPath(world, { x: cellX(cell), y: cellY(cell), z }));
}

/** 结构效果只来自人物所在体素周围的真实物质拓扑，不读取结构标签或预设蓝图。 */
export function shelterGeometryAt(world: VoxelWorld, position: StandingPosition): ShelterGeometry | null {
  if (!isStandingPosition(world, position)) return null;
  const x = cellX(position.cellId);
  const y = cellY(position.cellId);
  const overheadMaterialId = voxelAt(world, x, y, position.z + 2);
  if (!materialHas(overheadMaterialId, 'solid')
    || !rootedSolidPath(world, { x, y, z: position.z - 1 })
    || !rootedSolidPath(world, { x, y, z: position.z + 2 })) return null;
  let enclosedSides = 0;
  let openSides = 0;
  for (const neighbor of neighbors4(position.cellId)) {
    const enclosed = solidBuildingAt(world, neighbor, position.z) || solidBuildingAt(world, neighbor, position.z + 1);
    if (enclosed) enclosedSides += 1;
    else if (standingPositions(world, neighbor).some((candidate) => Math.abs(candidate.z - position.z) <= 1
      && rootedSolidPath(world, { x: cellX(neighbor), y: cellY(neighbor), z: candidate.z - 1 }))) openSides += 1;
  }
  // 至少保留一个能由身体通过的侧向开口；完全封死的空腔不算可用住所。
  if (openSides < 1) return null;
  const overhead = materialDefinition(overheadMaterialId);
  const weatherProtection = Math.min(100, 58 + enclosedSides * 10 + (overhead.tags.includes('insulating') ? 8 : 0));
  const thermalInsulation = Math.min(100, 16 + enclosedSides * 18 + (overhead.tags.includes('insulating') ? 18 : 0));
  return { position, overheadMaterialId, enclosedSides, openSides, weatherProtection, thermalInsulation, workIds: [] };
}

/** Shelter comes from actual geometry; nearby works identify the contributing matter. */
export function survivalShelterAt(
  state: { world: { grid: VoxelWorld; works?: WorkState[] } },
  position: StandingPosition,
): ShelterGeometry | null {
  const geometry = shelterGeometryAt(state.world.grid, position);
  if (!geometry) return null;
  const contributingPositions = [
    { x: cellX(position.cellId), y: cellY(position.cellId), z: position.z + 2 },
    ...neighbors4(position.cellId).flatMap((neighbor) => [
      { x: cellX(neighbor), y: cellY(neighbor), z: position.z },
      { x: cellX(neighbor), y: cellY(neighbor), z: position.z + 1 },
    ]),
  ];
  return {
    ...geometry,
    workIds: [...new Set(contributingPositions.flatMap((position) => {
      const work = workAt(state.world, position);
      const material = voxelAt(state.world.grid, position.x, position.y, position.z);
      return work && materialHas(material, 'solid') ? [work.id] : [];
    }))],
  };
}
