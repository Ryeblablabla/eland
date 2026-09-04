import { materialDefinition, materialHas, type MaterialId } from './material';
import type { ActionFact, PhysicalStructure } from './model';
import type { PersonId } from './person';
import { WORK_SHELTER_COVER_THRESHOLD, workShelterCoverAt, type WorkState } from './works';
import {
  cellId,
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

function structuredWitnessIds(value: unknown): PersonId[] {
  const result = new Set<PersonId>();
  const collect = (candidate: unknown, parentKey = '', depth = 0): void => {
    if (!candidate || typeof candidate !== 'object' || depth > 4) return;
    if (Array.isArray(candidate)) {
      if (/(?:witness|observer|perceived|interpreter).*ids?$/iu.test(parentKey)) {
        candidate.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
          .forEach((entry) => result.add(entry));
      } else candidate.forEach((entry) => collect(entry, parentKey, depth + 1));
      return;
    }
    Object.entries(candidate).forEach(([key, entry]) => collect(entry, key, depth + 1));
  };
  collect(value);
  return [...result];
}

function actionFunctionKey(event: ActionFact): string {
  if (event.action.kind === 'act') return `act:${event.action.operation}`;
  if (event.action.kind === 'talk') return `talk:${event.action.speakerMeaning.kind}`;
  return event.action.kind;
}

function targetCells(event: ActionFact): number[] {
  if (event.action.kind === 'act') return event.action.targets.flatMap((target) => (
    target.kind === 'voxel' ? [cellId(target.position.x, target.position.y)] : []
  ));
  if (event.action.kind === 'world-interact') return event.action.adjudication.targets.flatMap((target) => (
    target.kind === 'voxel' ? [cellId(target.position.x, target.position.y)] : []
  ));
  return [];
}

function structureUseEvidencePaths(event: ActionFact): string[] {
  if (event.action.kind === 'move' && event.pathSegment.length) return ['pathSegment'];
  return Object.entries(event.diff)
    .filter(([, value]) => value !== undefined
      && value !== null
      && (!Array.isArray(value) || value.length > 0)
      && (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0))
    .map(([key]) => `diff.${key}`)
    .slice(0, 8);
}

/**
 * 通过真实行为的发生地回放结构使用。同一结构的建造事件被明确排除；
 * “打算建一座工坊”或结构的名字都不会产生这种回执。
 */
export function observePhysicalStructureUseReceipts(
  structure: PhysicalStructure,
  events: readonly ActionFact[],
): StructureUseReceipt[] {
  if (!structure.complete || structure.capacity <= 0) return [];
  const usableCells = new Set(structure.interiorCells.length
    ? structure.interiorCells
    : structure.occupiedCells);
  return events.flatMap((event) => {
    if (event.status !== 'completed' || structure.sourceEventIds.includes(event.id)) return [];
    const touched = usableCells.has(event.toCellId)
      || (event.action.kind !== 'move' && usableCells.has(event.cellId))
      || targetCells(event).some((candidate) => usableCells.has(candidate));
    if (!touched) return [];
    const evidencePaths = structureUseEvidencePaths(event);
    if (!evidencePaths.length) return [];
    const witnessIds = structuredWitnessIds(event.diff).filter((personId) => personId !== event.who);
    const kind = witnessIds.length ? 'demonstration' as const : 'use' as const;
    return [{
      version: STRUCTURE_USE_RECEIPT_VERSION,
      id: `structure-use:${structure.id}:${event.id}`,
      structureId: structure.id,
      kind,
      functionKey: actionFunctionKey(event),
      actorId: event.who,
      witnessIds,
      atMonth: event.atMonth,
      sourceEventId: event.id,
      evidencePaths,
    }];
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
 * 项目压力仍只读当下的物理遮蔽。文明观察是另一条路径：无论体素
 * 结构还是 Works，都要在实际使用后才会进入文明证据。
 */
export function survivalShelterAt(
  state: { world: { grid: VoxelWorld; works?: WorkState[] } },
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
