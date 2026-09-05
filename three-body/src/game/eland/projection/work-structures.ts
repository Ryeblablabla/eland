import type { StructureView } from '../../societyContract';
import type { SimulationState } from '../domain/model';
import { WORK_COLLAPSE_CONDITION } from '../domain/works';
import { workOccupiedVoxels } from '../domain/work-layout';
import { survivalShelterAt } from '../domain/structure';
import { cellId, standingPositions, voxelAt } from '../world/grid';

/** Open constructions retain their creators' names in the player's world. */
export function projectWorkStructures(state: SimulationState): StructureView[] {
  return (state.world.works ?? []).filter((work) => work.condition > WORK_COLLAPSE_CONDITION
    && voxelAt(state.world.grid, work.position.x, work.position.y, work.position.z) === work.anchorMaterialId)
    .map((work) => {
      const occupied = workOccupiedVoxels(work).filter((voxel) => voxelAt(state.world.grid,
        voxel.position.x, voxel.position.y, voxel.position.z) === voxel.materialId);
      const occupiedCells = [...new Set(occupied.map((voxel) => cellId(voxel.position.x, voxel.position.y)))];
      const interiors = occupiedCells.flatMap((cell) => standingPositions(state.world.grid, cell))
        .flatMap((position) => {
          const shelter = survivalShelterAt(state, position);
          return shelter?.workIds.includes(work.id) ? [shelter] : [];
        });
      return {
      id: work.id,
      name: work.summary,
      occupiedCells,
      interiorCells: [...new Set(interiors.map((interior) => interior.position.cellId))],
      interiorPositions: interiors.map((interior) => ({ ...interior.position })),
      componentCount: work.components.reduce((sum, component) => sum + component.quantity, 0),
      complete: true,
      effects: {
        weatherProtection: Math.max(0, ...interiors.map((interior) => interior.weatherProtection)),
        thermalInsulation: Math.max(0, ...interiors.map((interior) => interior.thermalInsulation)),
        capacity: interiors.length,
      },
      sourceEventIds: [...work.sourceEventIds],
      materialIds: [...new Set(work.components.map((component) => component.materialId))],
    };
  });
}
