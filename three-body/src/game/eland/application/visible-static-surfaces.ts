import { materialDefinition, type MaterialId } from '../domain/material';
import { perceiveMaterial } from '../domain/material-perception';
import type { SimulationState } from '../domain/model';
import type { PersonState } from '../domain/person';
import { cellX, cellY, surfaceMaterial, topPosition } from '../world/grid';

export interface VisibleStaticSurface {
  materialId: MaterialId;
  position: { x: number; y: number; z: number };
  name: string;
  properties: string[];
}

/** The same distinguished, currently visible surfaces used by model context.
 * Remembered coordinates and candidate-operation anchors are not perception. */
export function projectVisibleStaticSurfaces(
  state: Pick<SimulationState, 'world'>,
  person: Pick<PersonState, 'position'>,
  visibleCells: readonly number[],
): VisibleStaticSurface[] {
  return [...visibleCells].sort((left, right) => {
    const distance = (id: number) => Math.abs(cellX(id) - cellX(person.position.cellId))
      + Math.abs(cellY(id) - cellY(person.position.cellId));
    return distance(left) - distance(right) || left - right;
  }).map((id) => {
    const materialId = surfaceMaterial(state.world.grid, id);
    const perception = perceiveMaterial(materialId, 'visible');
    return { materialId, position: topPosition(state.world.grid, id), name: materialDefinition(materialId).name,
      properties: [...new Set([perception.phase, perception.form, perception.appearance])] };
  }).filter((surface, index, all) => all.findIndex((other) => other.materialId === surface.materialId) === index).slice(0, 12);
}
