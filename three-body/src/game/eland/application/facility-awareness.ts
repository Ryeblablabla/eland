import { materialDefinition, materialHas } from '../domain/material';
import type { EnvironmentFact, SimulationState } from '../domain/model';
import type { PersonState } from '../domain/person';
import { rememberMaterialPlace } from '../domain/spatial-knowledge';
import { livingPeople } from '../domain/state-index';
import {
  cellX,
  cellY,
  cellsInRadius,
  topZ,
  voxelAt,
} from '../world/grid';

function alreadyKnowsFacility(
  person: PersonState,
  materialId: number,
  position: { x: number; y: number; z: number },
): boolean {
  return person.knownPlaces.some((place) => place.materialId === materialId
    && place.position.x === position.x
    && place.position.y === position.y
    && place.position.z === position.z);
}

/**
 * Seeing a placed facility is itself a sourced personal discovery. This runs
 * once at the month boundary so passive perception becomes durable spatial
 * memory without charging an action tick or granting knowledge of remote
 * inventory, access, ownership, or use.
 */
export function recordVisibleFacilityDiscoveries(
  state: SimulationState,
  atMonth: number,
  orderInMonth: number,
): EnvironmentFact[] {
  const events: EnvironmentFact[] = [];
  for (const person of livingPeople(state)) {
    const radius = 4 + Math.floor(person.baselineCapacities.perception / 25);
    for (const facilityCellId of cellsInRadius(person.position.cellId, radius)) {
      const z = topZ(state.world.grid, facilityCellId);
      if (z < 0 || Math.abs(z - person.position.z) > radius) continue;
      const position = { x: cellX(facilityCellId), y: cellY(facilityCellId), z };
      const materialId = voxelAt(state.world.grid, position.x, position.y, position.z);
      if (!materialHas(materialId, 'facility')
        || alreadyKnowsFacility(person, materialId, position)) continue;
      const event: EnvironmentFact = {
        id: `e-${atMonth}-environment-facility-discovery-${person.id}-${materialId}-${position.x}-${position.y}-${position.z}`,
        kind: 'environment',
        change: 'material',
        atMonth,
        orderInMonth: orderInMonth + events.length,
        planningTick: 0,
        orderInTick: orderInMonth + events.length,
        cellId: facilityCellId,
        who: person.id,
        result: `${person.name}发现并记住了${materialDefinition(materialId).name}的位置`,
        diff: {
          facilityDiscovery: true,
          facilityMaterialId: materialId,
          position,
          discoveryKind: 'direct-visibility',
        },
      };
      rememberMaterialPlace(person, materialId, position, atMonth, event.id);
      events.push(event);
    }
  }
  return events;
}
