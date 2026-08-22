import { Material, type MaterialId } from '../../domain/material';
import type { SimulationState } from '../../domain/model';
import type { PersonState } from '../../domain/person';
import type { ProjectState } from '../../domain/project';
import {
  cellX,
  cellY,
  findStandingPath,
  neighbors4,
  standingPositions,
  topPosition,
  voxelAt,
  type StandingPosition,
} from '../../world/grid';
import { canWorkSource } from './project-logistics';
import { visibleCellsFor } from './project-perception';

// A foundry is the specialized continuation of kiln metallurgy. Once a person
// can perceive and reach one, later metallurgy projects should return there so
// its real batch effect can become a repeated practice instead of leaving the
// new facility idle beside older kilns.
const METALLURGY_FACILITIES = [Material.Foundry, Material.Kiln] as const;

export function fixedFacilityWorkplace(
  state: SimulationState,
  person: PersonState,
  site: ProjectState['site'],
  allowedMaterialIds: readonly MaterialId[] = METALLURGY_FACILITIES,
): { target: { position: { x: number; y: number; z: number }; materialId: MaterialId }; workingPosition: StandingPosition; pathLength: number } | null {
  if (!site) return null;
  const x = cellX(site.cellId);
  const y = cellY(site.cellId);
  const materialId = voxelAt(state.world.grid, x, y, site.z);
  if (!allowedMaterialIds.includes(materialId)) return null;
  return [site.cellId, ...neighbors4(site.cellId)]
    .flatMap((cellId) => standingPositions(state.world.grid, cellId))
    .filter((position) => canWorkSource(position, { x, y, z: site.z }))
    .flatMap((workingPosition) => {
      const path = findStandingPath(state.world.grid, person.position, workingPosition);
      return path.length ? [{
        target: { position: { x, y, z: site.z }, materialId },
        workingPosition,
        pathLength: path.length - 1,
      }] : [];
    })
    .sort((left, right) => left.pathLength - right.pathLength
      || left.workingPosition.cellId - right.workingPosition.cellId
      || left.workingPosition.z - right.workingPosition.z)[0] ?? null;
}

export function knownFacilitySite(
  state: SimulationState,
  person: PersonState,
  materialIds: readonly MaterialId[] = METALLURGY_FACILITIES,
): ProjectState['site'] | undefined {
  const accepted = new Set(materialIds);
  const visible = visibleCellsFor(person).flatMap((cellId) => {
    const position = topPosition(state.world.grid, cellId);
    return accepted.has(voxelAt(state.world.grid, position.x, position.y, position.z))
      ? [{ cellId, z: position.z }]
      : [];
  });
  const remembered = person.knownPlaces.flatMap((place) => {
    const rememberedCellId = place.position.x + place.position.y * state.world.grid.width;
    return accepted.has(place.materialId)
      && voxelAt(state.world.grid, place.position.x, place.position.y, place.position.z) === place.materialId
      ? [{ cellId: rememberedCellId, z: place.position.z }]
      : [];
  });
  return [...visible, ...remembered]
    .flatMap((site) => {
      const work = fixedFacilityWorkplace(state, person, site, materialIds);
      return work ? [{ site, pathLength: work.pathLength }] : [];
    })
    .sort((left, right) => {
      const leftMaterialId = voxelAt(state.world.grid, cellX(left.site.cellId), cellY(left.site.cellId), left.site.z);
      const rightMaterialId = voxelAt(state.world.grid, cellX(right.site.cellId), cellY(right.site.cellId), right.site.z);
      return materialIds.indexOf(leftMaterialId) - materialIds.indexOf(rightMaterialId)
        || left.pathLength - right.pathLength
      || left.site.cellId - right.site.cellId
        || left.site.z - right.site.z;
    })[0]?.site;
}
