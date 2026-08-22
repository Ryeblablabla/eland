import type { ActionOption, Intent, PrimitiveAction, VoxelPosition } from '../domain/action';
import { Material, materialDefinition, materialHas } from '../domain/material';
import {
  bereavementFor,
  memorialForRemains,
  remainsById,
  type HumanRemainsState,
} from '../domain/mortuary';
import { isAlive, type PersonState } from '../domain/person';
import { productionToolRank } from '../domain/production-tool';
import type { SimulationState } from '../domain/model';
import {
  cellX,
  cellY,
  cellsInRadius,
  findStandingPath,
  neighbors4,
  standingPositions,
  topPosition,
  voxelAt,
} from '../world/grid';

function sameStanding(person: PersonState, position: { cellId: number; z: number }): boolean {
  return person.position.cellId === position.cellId && person.position.z === position.z;
}

function accessPosition(remains: HumanRemainsState): { cellId: number; z: number } {
  return remains.grave?.accessPosition ?? remains.position;
}

function approach(
  state: SimulationState,
  person: PersonState,
  destination: { cellId: number; z: number },
): { reachable: boolean; move?: PrimitiveAction } {
  if (sameStanding(person, destination)) return { reachable: true };
  const path = findStandingPath(state.world.grid, person.position, destination);
  return path.length
    ? { reachable: true, move: { kind: 'move', toCellId: destination.cellId, toZ: destination.z } }
    : { reachable: false };
}

function gravePositionTaken(state: SimulationState, position: VoxelPosition): boolean {
  return (state.world.remains ?? []).some((candidate) => candidate.grave
    && candidate.grave.position.x === position.x
    && candidate.grave.position.y === position.y
    && candidate.grave.position.z === position.z);
}

export function chooseGraveSite(state: SimulationState, person: PersonState): VoxelPosition | null {
  return findGravePreparation(state, person)?.position ?? null;
}

function findGravePreparation(
  state: SimulationState,
  person: PersonState,
): { position: VoxelPosition; accessPosition: { cellId: number; z: number }; pathLength: number } | null {
  const candidates = cellsInRadius(person.position.cellId, 6).flatMap((cellId) => {
    const position = topPosition(state.world.grid, cellId);
    const materialId = voxelAt(state.world.grid, position.x, position.y, position.z);
    const above = voxelAt(state.world.grid, position.x, position.y, position.z + 1);
    if (!materialHas(materialId, 'ground')
      || above !== Material.Air
      || gravePositionTaken(state, position)
      || state.people.some((candidate) => isAlive(candidate) && candidate.position.cellId === cellId)) return [];
    const access = neighbors4(cellId).flatMap((accessCellId) => standingPositions(state.world.grid, accessCellId)
      .map((accessPosition) => ({
        accessPosition,
        path: findStandingPath(state.world.grid, person.position, accessPosition),
      })))
      .filter(({ accessPosition, path }) => sameStanding(person, accessPosition) || path.length > 0)
      .sort((left, right) => left.path.length - right.path.length
        || left.accessPosition.cellId - right.accessPosition.cellId
        || left.accessPosition.z - right.accessPosition.z)[0];
    return access ? [{
      position,
      accessPosition: access.accessPosition,
      pathLength: access.path.length,
      hardness: materialDefinition(materialId).hardness,
      cellId,
    }] : [];
  }).sort((left, right) => left.pathLength - right.pathLength
    || left.hardness - right.hardness
    || left.cellId - right.cellId);
  return candidates[0] ?? null;
}

function markerInputs(person: PersonState) {
  const tablet = person.inventory.find((stack) => stack.materialId === Material.WoodTablet
    && stack.quantity > 0
    && !stack.recordPayloadId);
  const minimumRank = productionToolRank(Material.StoneTool);
  const tool = person.inventory
    .filter((stack) => stack.quantity > 0 && productionToolRank(stack.materialId) >= minimumRank)
    .sort((left, right) => productionToolRank(right.materialId) - productionToolRank(left.materialId)
      || left.id.localeCompare(right.id))[0];
  return tablet && tool ? { tablet, tool } : null;
}

function compileMournAction(state: SimulationState, person: PersonState, remains: HumanRemainsState): PrimitiveAction | null {
  const bereavement = bereavementFor(person, remains.id);
  if (!bereavement || bereavement.lastMournedAtMonth !== undefined) return null;
  const destination = accessPosition(remains);
  const destinationApproach = approach(state, person, destination);
  if (!destinationApproach.reachable) return null;
  return destinationApproach.move ?? {
    kind: 'act', operation: 'inter', mortuaryPhase: 'mourn',
    targets: [{ kind: 'remains', remainsId: remains.id }],
  };
}

function compileIntermentAction(state: SimulationState, person: PersonState, remains: HumanRemainsState): PrimitiveAction | null {
  if (!bereavementFor(person, remains.id) || remains.status === 'interred') return null;
  if (remains.status === 'carried' && remains.carriedByPersonId !== person.id) return null;
  if (remains.status === 'exposed') {
    const remainsApproach = approach(state, person, remains.position);
    if (!remainsApproach.reachable) return null;
    return remainsApproach.move ?? {
      kind: 'act', operation: 'inter', mortuaryPhase: 'lift',
      targets: [{ kind: 'remains', remainsId: remains.id }],
    };
  }
  if (remains.status === 'carried') {
    if (remains.grave) {
      const graveApproach = approach(state, person, remains.grave.accessPosition);
      if (!graveApproach.reachable) return null;
      return graveApproach.move ?? {
        kind: 'act', operation: 'inter', mortuaryPhase: 'place-in-grave',
        targets: [{ kind: 'remains', remainsId: remains.id }],
      };
    }
    const graveSite = findGravePreparation(state, person);
    if (!graveSite) return null;
    const graveApproach = approach(state, person, graveSite.accessPosition);
    if (!graveApproach.reachable) return null;
    return graveApproach.move ?? {
      kind: 'act', operation: 'inter', mortuaryPhase: 'prepare-grave',
      targets: [
        { kind: 'remains', remainsId: remains.id },
        { kind: 'voxel', position: graveSite.position },
      ],
    };
  }
  if (remains.status === 'placed' && remains.grave) {
    const graveApproach = approach(state, person, remains.grave.accessPosition);
    if (!graveApproach.reachable) return null;
    if (graveApproach.move) return graveApproach.move;
    const cover = person.inventory.find((stack) => stack.id === remains.grave?.coverMaterialStackId
      && stack.materialId === remains.grave?.originalMaterialId
      && stack.quantity > 0
      && stack.sourceEventIds.includes(remains.grave?.excavationEventId ?? ''));
    return cover ? {
      kind: 'act', operation: 'inter', mortuaryPhase: 'cover-grave',
      targets: [
        { kind: 'remains', remainsId: remains.id },
        { kind: 'inventory-stack', personId: person.id, stackId: cover.id },
      ],
    } : null;
  }
  return null;
}

function compileMarkerAction(state: SimulationState, person: PersonState, remains: HumanRemainsState): PrimitiveAction | null {
  if (remains.status !== 'interred' || !remains.grave || memorialForRemains(state, remains.id)) return null;
  const bereavement = bereavementFor(person, remains.id);
  const inputs = markerInputs(person);
  if (!bereavement || !inputs) return null;
  const graveApproach = approach(state, person, remains.grave.accessPosition);
  if (!graveApproach.reachable) return null;
  return graveApproach.move ?? {
    kind: 'act', operation: 'inter', mortuaryPhase: 'mark',
    targets: [
      { kind: 'remains', remainsId: remains.id },
      { kind: 'inventory-stack', personId: person.id, stackId: inputs.tablet.id },
    ],
    toolStackId: inputs.tool.id,
  };
}

export function recompileMortuaryNextAction(
  state: SimulationState,
  person: PersonState,
  intent: Intent,
): PrimitiveAction | null {
  if (intent.goal.kind !== 'death-mourned'
    && intent.goal.kind !== 'remains-interred'
    && intent.goal.kind !== 'memorial-marked') return null;
  const remains = remainsById(state, intent.goal.remainsId);
  if (!remains) return null;
  if (intent.goal.kind === 'death-mourned') return compileMournAction(state, person, remains);
  if (intent.goal.kind === 'remains-interred') return compileIntermentAction(state, person, remains);
  return compileMarkerAction(state, person, remains);
}

export function buildMortuaryOptions(
  state: SimulationState,
  person: PersonState,
  visibleRemains: HumanRemainsState[],
): ActionOption[] {
  const options: ActionOption[] = [];
  for (const remains of visibleRemains) {
    const deceased = state.people.find((candidate) => candidate.id === remains.personId);
    const bereavement = bereavementFor(person, remains.id);
    if (!deceased || !bereavement) continue;
    const sourceFactIds = [...new Set([...bereavement.sourceEventIds, remains.deathEventId])].slice(-24);
    const mournAction = compileMournAction(state, person, remains);
    if (mournAction) options.push({
      id: `mourn:${remains.id}`,
      summary: remains.status === 'interred' ? `到${deceased.name}墓前悼念` : `停下来悼念${deceased.name}`,
      reason: `本人以可追溯来源得知${deceased.name}死亡，并受到这段关系影响`,
      goal: { kind: 'death-mourned', remainsId: remains.id },
      nextAction: mournAction,
      target: { kind: 'remains', remainsId: remains.id },
      estimatedDuration: mournAction.kind === 'move' ? 'several-months' : 'one-month',
      sourceFactIds,
    });
    const intermentAction = compileIntermentAction(state, person, remains);
    if (intermentAction) options.push({
      id: `inter-remains:${remains.id}`,
      summary: `收敛并安葬${deceased.name}的遗体`,
      reason: '可见遗体、死亡记忆与可达地面共同形成了真实照料机会',
      goal: { kind: 'remains-interred', remainsId: remains.id },
      nextAction: intermentAction,
      target: { kind: 'remains', remainsId: remains.id },
      estimatedDuration: 'several-months',
      sourceFactIds,
    });
    const markerAction = compileMarkerAction(state, person, remains);
    if (markerAction) options.push({
      id: `mark-memorial:${remains.id}`,
      summary: `用木制记录板为${deceased.name}留下墓记`,
      reason: '遗体已经真实安葬，本人持有空白记录板和可刻写工具',
      goal: { kind: 'memorial-marked', remainsId: remains.id },
      nextAction: markerAction,
      target: { kind: 'remains', remainsId: remains.id },
      estimatedDuration: markerAction.kind === 'move' ? 'several-months' : 'one-month',
      sourceFactIds: [...new Set([...sourceFactIds, remains.grave?.burialEventId ?? ''])].filter(Boolean),
    });
  }
  return options;
}

export function remainsCell(remains: HumanRemainsState): number {
  return remains.position.cellId;
}

export function remainsCoordinates(remains: HumanRemainsState): { x: number; y: number; z: number } {
  return { x: cellX(remains.position.cellId), y: cellY(remains.position.cellId), z: remains.position.z };
}
