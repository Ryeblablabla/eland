import { materialHas, type MaterialId } from '../domain/material';
import type { DropState, SimulationState } from '../domain/model';
import type { PersonState } from '../domain/person';
import { findStandingPath, surfaceMaterial, voxelAt } from '../world/grid';

export interface LocalMaterialEvidenceView {
  visibleCells: number[];
  visibleDrops: DropState[];
  visiblePeople: PersonState[];
}

/**
 * Keeps three facts separate:
 *
 * - observation can teach that a material or technique exists;
 * - portable access means the observer can legally use or pick it up now;
 * - a facility only functions after it has been placed in the world.
 *
 * In particular, another person's inventory is observation evidence, never
 * personal access. Remembered facilities are revalidated against the current
 * voxel before they can suppress a new facility need.
 */
export function buildLocalMaterialEvidence(
  state: SimulationState,
  observer: PersonState,
  view: LocalMaterialEvidenceView,
): {
  observedMaterialIds: Set<MaterialId>;
  accessiblePortableMaterialIds: Set<MaterialId>;
  placedFacilityMaterialIds: Set<MaterialId>;
} {
  const ownMaterialIds = observer.inventory
    .filter((stack) => stack.quantity > 0)
    .map((stack) => stack.materialId);
  const visibleDropMaterialIds = view.visibleDrops
    .filter((drop) => drop.quantity > 0)
    .map((drop) => drop.materialId);
  const accessibleDropMaterialIds = view.visibleDrops
    .filter((drop) => drop.quantity > 0
      && findStandingPath(state.world.grid, observer.position, { cellId: drop.cellId, z: drop.z }).length > 0)
    .map((drop) => drop.materialId);
  const visibleSurfaceMaterialIds = view.visibleCells
    .map((cellId) => surfaceMaterial(state.world.grid, cellId));
  const otherObservedMaterialIds = view.visiblePeople
    .filter((person) => person.id !== observer.id)
    .flatMap((person) => person.inventory
      .filter((stack) => stack.quantity > 0)
      .map((stack) => stack.materialId));
  const confirmedRememberedFacilities = observer.knownPlaces
    .filter((place) => materialHas(place.materialId, 'facility')
      && voxelAt(
        state.world.grid,
        place.position.x,
        place.position.y,
        place.position.z,
      ) === place.materialId)
    .map((place) => place.materialId);

  return {
    observedMaterialIds: new Set([
      ...ownMaterialIds,
      ...otherObservedMaterialIds,
      ...visibleDropMaterialIds,
      ...visibleSurfaceMaterialIds,
      ...observer.knownPlaces.map((place) => place.materialId),
    ]),
    accessiblePortableMaterialIds: new Set([
      ...ownMaterialIds,
      ...accessibleDropMaterialIds,
    ]),
    placedFacilityMaterialIds: new Set([
      ...visibleSurfaceMaterialIds.filter((materialId) => materialHas(materialId, 'facility')),
      ...confirmedRememberedFacilities,
    ]),
  };
}
