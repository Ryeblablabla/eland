import { Material, type MaterialId } from '../material';
import type { SimulationState } from '../model';
import { isAlive } from '../person';
import { livingPeople, personById } from '../state-index';
import { remember } from '../memory';
import {
  cellX, cellY, isStandingPosition, neighbors4, voxelAt, type StandingPosition,
} from '../../world/grid';

interface BodySupportSnapshot {
  personId: string;
  position: StandingPosition;
  /** Only the occupied body's support, feet and head voxels are relevant. */
  materials: [MaterialId, MaterialId, MaterialId];
}

export interface SupportSettlement {
  personId: string;
  from: StandingPosition;
  to: StandingPosition;
  landed: boolean;
  fallDistance: number;
  healthDamage: number;
  sourceEventIds: string[];
  result: string;
}

function bodyMaterials(state: SimulationState, position: StandingPosition): BodySupportSnapshot['materials'] {
  const x = cellX(position.cellId);
  const y = cellY(position.cellId);
  return [-1, 0, 1].map((offset) => voxelAt(state.world.grid, x, y, position.z + offset)) as BodySupportSnapshot['materials'];
}

export function captureBodySupports(state: SimulationState): BodySupportSnapshot[] {
  return livingPeople(state).map((person) => ({
    personId: person.id,
    position: { cellId: person.position.cellId, z: person.position.z },
    materials: bodyMaterials(state, person.position),
  }));
}

/** A body falls to the first floor below it; it cannot cross another solid voxel. */
function landingPosition(state: SimulationState, from: StandingPosition): StandingPosition | undefined {
  const grid = state.world.grid;
  const x = cellX(from.cellId);
  const y = cellY(from.cellId);
  if (voxelAt(grid, x, y, from.z) !== Material.Air
    || voxelAt(grid, x, y, from.z + 1) !== Material.Air) return undefined;
  for (let z = from.z - 1; z > 0; z -= 1) {
    if (voxelAt(grid, x, y, z) !== Material.Air) break;
    const position = { cellId: from.cellId, z };
    if (isStandingPosition(grid, position)) return position;
  }
  // A thaw or changed ground can leave no floor in the column. Catching an
  // immediately adjacent foothold is a single physical step, not a search for
  // some distant/high surface through walls. Never move a body upwards.
  for (const z of [from.z, from.z - 1]) {
    for (const cellId of neighbors4(from.cellId)) {
      const position = { cellId, z };
      if (!isStandingPosition(grid, position)) continue;
      if (voxelAt(grid, cellX(cellId), cellY(cellId), from.z + 1) !== Material.Air) continue;
      return position;
    }
  }
  return undefined;
}

// Grid locomotion already permits a one-voxel step. Beyond that, impact grows
// linearly with falling height (gravitational potential energy), on the same
// 0..100 health scale as other physical harm. It is unrelated to agent policy.
const FALL_DAMAGE_PER_EXCESS_VOXEL = 8;

/** Settle physical consequences once, immediately after the causal mutation. */
export function settleChangedBodySupports(
  state: SimulationState,
  before: readonly BodySupportSnapshot[],
  atMonth: number,
  sourceEventId: string,
): SupportSettlement[] {
  const settlements: SupportSettlement[] = [];
  for (const snapshot of before) {
    const person = personById(state, snapshot.personId);
    if (!person || !isAlive(person) || isStandingPosition(state.world.grid, person.position)) continue;
    const from = { cellId: person.position.cellId, z: person.position.z };
    const materials = bodyMaterials(state, from);
    if (from.cellId === snapshot.position.cellId && from.z === snapshot.position.z
      && materials.every((materialId, index) => materialId === snapshot.materials[index])) continue;
    const destination = landingPosition(state, from);
    const fallDistance = destination ? Math.max(0, from.z - destination.z) : 0;
    const healthDamage = Math.min(person.body.health,
      Math.max(0, fallDistance - 1) * FALL_DAMAGE_PER_EXCESS_VOXEL);
    if (destination) {
      person.position.cellId = destination.cellId;
      person.position.z = destination.z;
      person.position.lastPath.push(destination.cellId);
      person.body.health -= healthDamage;
      if (healthDamage > 0) {
        const wound = person.conditions.find((condition) => condition.kind === 'wound');
        if (wound) {
          wound.stage = Math.min(3, wound.stage + 1) as 1 | 2 | 3;
          wound.sourceEventIds.push(sourceEventId);
        } else person.conditions.push({
          id: `condition-wound-fall-${person.id}-${sourceEventId}`,
          kind: 'wound', stage: healthDamage >= 7 ? 2 : 1, sinceMonth: atMonth,
          sourceEventIds: [sourceEventId],
        });
      }
    }
    const result = !destination
      ? `${person.name}脚下支撑改变，身边没有可直接落脚的位置`
      : `${person.name}脚下支撑改变，${destination.cellId === from.cellId ? `下落 ${fallDistance} 格` : '移到相邻落脚处'}至 (${cellX(destination.cellId)},${cellY(destination.cellId)},${destination.z})`
        + (healthDamage > 0 ? `，撞击损失 ${healthDamage} 健康并受伤` : '');
    settlements.push({
      personId: person.id, from, to: destination ?? from, landed: Boolean(destination),
      fallDistance, healthDamage, sourceEventIds: [sourceEventId], result,
    });
    // A person standing on somebody else's removed support experiences this
    // too, even when they were not named as a target of the original action.
    remember(person, {
      id: `memory:support-settlement:${sourceEventId}:${person.id}`, kind: 'episode', summary: result,
      importance: healthDamage > 0 ? 88 : 58, createdAtMonth: atMonth, lastRecalledAtMonth: atMonth,
      personIds: [person.id], sourceEventIds: [sourceEventId],
    });
  }
  return settlements;
}
