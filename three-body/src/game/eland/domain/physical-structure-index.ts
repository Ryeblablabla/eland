import { completedConstructionActions } from './event-index';
import { materialDefinition, materialHas, type MaterialId } from './material';
import type {
  PhysicalStructure,
  PhysicalStructureIndex,
  SimulationState,
} from './model';
import { shelterGeometryAt } from './structure';
import {
  cellX,
  cellY,
  standingPositions,
  voxelAt,
  voxelWorldRevision,
} from '../world/grid';

interface StructureComponent {
  x: number;
  y: number;
  z: number;
  materialId: MaterialId;
  sourceEventId: string;
}

function structureComponents(
  state: SimulationState,
  constructionEvents: ReturnType<typeof completedConstructionActions>,
): StructureComponent[] {
  const byPosition = new Map<string, StructureComponent>();
  for (const event of constructionEvents) {
    const materialId = Number(event.diff.outputMaterialId);
    const position = event.diff.position as { x?: unknown; y?: unknown; z?: unknown } | undefined;
    if (!materialHas(materialId, 'solid') || !materialHas(materialId, 'building') || materialHas(materialId, 'placeable')
      || ![position?.x, position?.y, position?.z].every((value) => Number.isInteger(value))) continue;
    const component = {
      x: Number(position?.x),
      y: Number(position?.y),
      z: Number(position?.z),
      materialId,
      sourceEventId: event.id,
    };
    if (voxelAt(state.world.grid, component.x, component.y, component.z) !== materialId) continue;
    byPosition.set(`${component.x}:${component.y}:${component.z}`, component);
  }
  return [...byPosition.values()];
}

/**
 * Rebuild the physical structure index exclusively from committed construction
 * facts and the current voxel grid. Observer milestones, regions and labels are
 * deliberately absent from this dependency chain.
 */
export function derivePhysicalStructureIndex(state: SimulationState): PhysicalStructureIndex {
  const constructionEvents = completedConstructionActions(state);
  const all = structureComponents(state, constructionEvents);
  const byKey = new Map(all.map((position) => [`${position.x}:${position.y}:${position.z}`, position]));
  const visited = new Set<string>();
  const structures: PhysicalStructure[] = [];
  for (const origin of all) {
    const originKey = `${origin.x}:${origin.y}:${origin.z}`;
    if (visited.has(originKey)) continue;
    const queue = [origin];
    const group: StructureComponent[] = [];
    visited.add(originKey);
    while (queue.length) {
      const current = queue.shift();
      if (!current) break;
      group.push(current);
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const key = `${current.x + dx}:${current.y + dy}:${current.z + dz}`;
        const next = byKey.get(key);
        if (next && !visited.has(key)) {
          visited.add(key);
          queue.push(next);
        }
      }
    }
    const occupiedCells = [...new Set(group.map((position) => position.x + position.y * state.world.grid.width))];
    const sourceEventIds = group.map((component) => component.sourceEventId);
    const groupKeys = new Set(group.map((position) => `${position.x}:${position.y}:${position.z}`));
    const interiorPositions = occupiedCells.flatMap((cell) => standingPositions(state.world.grid, cell))
      .flatMap((position) => {
        const geometry = shelterGeometryAt(state.world.grid, position);
        if (!geometry) return [];
        const overheadKey = `${cellX(position.cellId)}:${cellY(position.cellId)}:${position.z + 2}`;
        return groupKeys.has(overheadKey) ? [geometry] : [];
      });
    const complete = interiorPositions.length > 0;
    const weatherProtection = interiorPositions.length
      ? Math.round(interiorPositions.reduce((sum, interior) => sum + interior.weatherProtection, 0) / interiorPositions.length)
      : 0;
    const thermalInsulation = interiorPositions.length
      ? Math.round(interiorPositions.reduce((sum, interior) => sum + interior.thermalInsulation, 0) / interiorPositions.length)
      : 0;
    const materialIds = [...new Set(group.map((component) => component.materialId))];
    const materialLabel = materialIds.map((materialId) => materialDefinition(materialId).name).join('、');
    structures.push({
      id: `structure-${originKey}`,
      name: complete ? `${materialLabel}遮蔽结构` : `未完成${materialLabel}结构`,
      occupiedCells,
      interiorCells: [...new Set(interiorPositions.map((interior) => interior.position.cellId))],
      interiorPositions: interiorPositions.map((interior) => interior.position),
      materialIds,
      weatherProtection,
      thermalInsulation,
      capacity: interiorPositions.length,
      complete,
      sourceEventIds,
    });
  }
  return {
    calculatedAtMonth: state.clock.elapsedMonths,
    voxelRevision: voxelWorldRevision(state.world.grid),
    constructionEventCount: constructionEvents.length,
    structures,
  };
}

function physicalStructureIndexIsFresh(
  state: SimulationState,
  physicalStructureIndex: PhysicalStructureIndex,
): boolean {
  return physicalStructureIndex.voxelRevision !== undefined
    && physicalStructureIndex.constructionEventCount !== undefined
    && physicalStructureIndex.voxelRevision === voxelWorldRevision(state.world.grid)
    && physicalStructureIndex.constructionEventCount === completedConstructionActions(state).length;
}

/**
 * Narrow read boundary for gameplay rules. Production states install a physical
 * index at creation, month commit or restore time. A raw legacy schema-17 state
 * is rebuilt from authoritative facts on demand; its observer mirror is never
 * accepted as gameplay input.
 */
export function physicalStructuresOf(state: SimulationState): readonly PhysicalStructure[] {
  const current = state.world.physicalStructureIndex;
  if (current && physicalStructureIndexIsFresh(state, current)) return current.structures;
  const rebuilt = derivePhysicalStructureIndex(state);
  state.world.physicalStructureIndex = rebuilt;
  return rebuilt.structures;
}

/** Deep copy used only for the schema-17 observer compatibility mirror. */
export function copyPhysicalStructures(
  physicalStructureIndex: PhysicalStructureIndex,
): PhysicalStructure[] {
  return physicalStructureIndex.structures.map((structure) => ({
    ...structure,
    occupiedCells: [...structure.occupiedCells],
    interiorCells: [...structure.interiorCells],
    interiorPositions: structure.interiorPositions.map((position) => ({ ...position })),
    materialIds: [...structure.materialIds],
    sourceEventIds: [...structure.sourceEventIds],
  }));
}

/** Compatibility helper for callers that historically consumed an array. */
export function derivePhysicalStructures(state: SimulationState): PhysicalStructure[] {
  return derivePhysicalStructureIndex(state).structures;
}
