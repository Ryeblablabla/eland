import { materialDefinition, materialHas, type MaterialId } from './material';
import { WORK_SHELTER_COVER_THRESHOLD, workShelterCoverAt } from './works';
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
  return materialHas(materialId, 'solid') && (materialHas(materialId, 'building') || materialHas(materialId, 'ground'));
}

/** 结构效果只来自人物所在体素周围的真实物质拓扑，不读取结构标签或预设蓝图。 */
export function shelterGeometryAt(world: VoxelWorld, position: StandingPosition): ShelterGeometry | null {
  if (!isStandingPosition(world, position)) return null;  const x = cellX(position.cellId);
  const y = cellY(position.cellId);
  const overheadMaterialId = voxelAt(world, x, y, position.z + 2);
  if (!materialHas(overheadMaterialId, 'solid')) return null;
  let enclosedSides = 0;
  let openSides = 0;
  for (const neighbor of neighbors4(position.cellId)) {
    const enclosed = solidBuildingAt(world, neighbor, position.z) || solidBuildingAt(world, neighbor, position.z + 1);
    if (enclosed) enclosedSides += 1;
    else if (standingPositions(world, neighbor).some((candidate) => Math.abs(candidate.z - position.z) <= 1)) openSides += 1;
  }
  // 至少保留一个能由身体通过的侧向开口；完全封死的空腔不算可用住所。
  if (openSides < 1) return null;
  const overhead = materialDefinition(overheadMaterialId);
  const weatherProtection = Math.min(100, 58 + enclosedSides * 10 + (overhead.tags.includes('insulating') ? 8 : 0));
  const thermalInsulation = Math.min(100, 16 + enclosedSides * 18 + (overhead.tags.includes('insulating') ? 18 : 0));
  return { position, overheadMaterialId, enclosedSides, openSides, weatherProtection, thermalInsulation };
}

/**
 * 生存向住所判定：规则住所（体素几何）优先；没有规则住所时，
 * 人物亲手搭的 Works（棚架/垒堆/框架）按 cover 提供应急遮蔽。
 * 时代门槛、项目压力与文明指数仍只读 shelterGeometryAt —— Works 救急不解锁。
 */
export function survivalShelterAt(
  state: { world: { grid: VoxelWorld; works?: import('./works').WorkState[] } },
  position: StandingPosition,
): ShelterGeometry | null {
  const geometry = shelterGeometryAt(state.world.grid, position);
  if (geometry) return geometry;
  const cover = workShelterCoverAt(state.world, position);
  if (cover < WORK_SHELTER_COVER_THRESHOLD) return null;
  return {
    position,
    overheadMaterialId: 0,
    enclosedSides: 1,
    openSides: 3,
    weatherProtection: cover,
    thermalInsulation: Math.round(cover * 0.45),
  };
}
