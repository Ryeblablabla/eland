import { Material, materialHas, type MaterialId } from './material';
import type { PrimitiveAction, WaterSearchBasis } from './action';
import type { ActionFact, DecisionAuthorityState, SimulationState, WorldEvent } from './model';
import type { PersonState } from './person';
import { actionFactsForPerson } from './event-index';
import {
  cellId,
  cellX,
  cellY,
  cellsInRadius,
  findStandingPath,
  neighbors4,
  standingPositions,
  surfaceMaterial,
  topPosition,
  voxelAt,
  type StandingPosition,
} from '../world/grid';

export interface WaterAccess {
  materialId: MaterialId;
  waterPosition: { x: number; y: number; z: number };
  bankPosition: StandingPosition;
  pathLength: number;
  remembered: boolean;
  sourceEventIds: string[];
}

type WaterSearchMove = Extract<PrimitiveAction, { kind: 'move' }>;

interface WaterSearchCandidate {
  position: StandingPosition;
  firstStepCellId: number;
  pathLength: number;
  x: number;
  y: number;
  recentVisits: number;
  visibleTraffic: number;
}

function defaultVisibleCells(person: PersonState): number[] {
  const radius = 4 + Math.floor(person.baselineCapacities.perception / 25);
  return cellsInRadius(person.position.cellId, radius);
}

/** 返回本人看见或记得、且此刻物质仍为水并可实际走到岸边的最近水源。 */
function findReachableDrinkable(
  state: Pick<DecisionAuthorityState, 'world'>,
  person: PersonState,
  visibleCellIds: Iterable<number>,
  accepts: (materialId: MaterialId) => boolean,
  acceptsAccess: (access: WaterAccess) => boolean = () => true,
): WaterAccess | null {
  const visible = new Set(visibleCellIds);
  const positions = new Map<string, { position: WaterAccess['waterPosition']; remembered: boolean; sourceEventIds: string[] }>();
  for (const waterCell of visible) {
    const surface = surfaceMaterial(state.world.grid, waterCell);
    if (!accepts(surface)) continue;
    const position = topPosition(state.world.grid, waterCell);
    positions.set(`${position.x}:${position.y}:${position.z}`, { position, remembered: false, sourceEventIds: [] });
  }
  for (const place of person.knownPlaces) {
    if (!accepts(place.materialId)) continue;
    const key = `${place.position.x}:${place.position.y}:${place.position.z}`;
    if (!positions.has(key)) positions.set(key, { position: place.position, remembered: true, sourceEventIds: place.sourceEventIds });
  }

  const candidates: WaterAccess[] = [];
  for (const known of positions.values()) {
    const { position } = known;
    const currentMaterial = voxelAt(state.world.grid, position.x, position.y, position.z);
    if (!accepts(currentMaterial)) continue;
    const waterCell = cellId(position.x, position.y);
    for (const bankCell of neighbors4(waterCell)) {
      for (const bankPosition of standingPositions(state.world.grid, bankCell)) {
        if (Math.abs(bankPosition.z - position.z) > 2) continue;
        const path = findStandingPath(state.world.grid, person.position, bankPosition);
        if (!path.length) continue;
        const access = {
          materialId: currentMaterial,
          waterPosition: { ...position },
          bankPosition,
          pathLength: path.length,
          remembered: known.remembered,
          sourceEventIds: known.sourceEventIds,
        } satisfies WaterAccess;
        if (acceptsAccess(access)) candidates.push(access);
      }
    }
  }
  return candidates.sort((a, b) => a.pathLength - b.pathLength
    || Number(a.remembered) - Number(b.remembered)
    || a.bankPosition.cellId - b.bankPosition.cellId
    || a.bankPosition.z - b.bankPosition.z)[0] ?? null;
}

/** 返回本人看见或记得、且此刻仍可饮用并可实际走到岸边的最近水源。 */
export function findReachableWater(
  state: Pick<DecisionAuthorityState, 'world'>,
  person: PersonState,
  visibleCellIds: Iterable<number> = defaultVisibleCells(person),
): WaterAccess | null {
  return findReachableDrinkable(state, person, visibleCellIds, (materialId) => materialHas(materialId, 'drinkable'));
}

/**
 * Return a drinkable source perceived or remembered by the guide whose exact
 * bank position is also physically reachable by the companion. This proves a
 * shared route without giving either person hidden map knowledge.
 */
export function findSharedReachableWater(
  state: Pick<DecisionAuthorityState, 'world'>,
  guide: PersonState,
  companion: PersonState,
  visibleCellIds: Iterable<number> = defaultVisibleCells(guide),
): WaterAccess | null {
  return findReachableDrinkable(
    state,
    guide,
    visibleCellIds,
    (materialId) => materialHas(materialId, 'drinkable'),
    (access) => findStandingPath(state.world.grid, companion.position, access.bankPosition).length > 0,
  );
}

/** 容器运输只接受真实液态水；冰可现场摄入，但不能被无加热规则地装成水。 */
export function findReachableLiquidWater(
  state: Pick<DecisionAuthorityState, 'world'>,
  person: PersonState,
  visibleCellIds: Iterable<number> = defaultVisibleCells(person),
): WaterAccess | null {
  return findReachableDrinkable(state, person, visibleCellIds, (materialId) => materialId === Material.Water);
}

/** Compile travel that turns a real sighting into a replayable place memory. */
export function moveTowardWaterAccess(
  water: WaterAccess,
  atMonth: number,
): WaterSearchMove {
  const mode = water.remembered ? 'remembered' as const : 'visible' as const;
  const sourceFactIds = [...new Set(water.sourceEventIds)];
  return {
    kind: 'move',
    toCellId: water.bankPosition.cellId,
    toZ: water.bankPosition.z,
    waterAccessBasis: {
      version: 'water-access-basis-v1',
      mode,
      materialId: water.materialId,
      waterPosition: { ...water.waterPosition },
      bankPosition: { ...water.bankPosition },
      observedAtMonth: atMonth,
      sourceFactIds,
      basisKey: [
        'water-access-basis-v1',
        `mode=${mode}`,
        `material=${water.materialId}`,
        `water=${water.waterPosition.x}:${water.waterPosition.y}:${water.waterPosition.z}`,
        `bank=${water.bankPosition.cellId}:${water.bankPosition.z}`,
        `sources=${sourceFactIds.sort().join(',')}`,
      ].join('|'),
    },
  };
}

/**
 * Select a visible, passable frontier for a thirsty person who has no visible
 * or remembered water. This deliberately does not inspect hidden water cells:
 * the person searches low-traffic terrain and can discover water only after it
 * enters perception range.
 */
export function findVisibleWaterSearchDestination(
  state: SimulationState,
  person: PersonState,
  visibleCellIds: Iterable<number> = defaultVisibleCells(person),
): StandingPosition | null {
  return visibleWaterSearchCandidates(state, person, visibleCellIds)[0]?.position ?? null;
}

function rankedVisibleWaterSearchCandidates(
  state: SimulationState,
  person: PersonState,
  visibleCellIds: Iterable<number>,
): WaterSearchCandidate[] {
  const recent = new Map<number, number>();
  for (const visited of person.position.lastPath) recent.set(visited, (recent.get(visited) ?? 0) + 1);
  return [...new Set(visibleCellIds)].flatMap((candidateCell) => {
    if (candidateCell === person.position.cellId) return [];
    return standingPositions(state.world.grid, candidateCell).flatMap((position) => {
      const path = findStandingPath(state.world.grid, person.position, position);
      if (path.length <= 1) return [];
      return [{
        position,
        firstStepCellId: path[1].cellId,
        pathLength: path.length,
        x: cellX(candidateCell),
        y: cellY(candidateCell),
        recentVisits: recent.get(candidateCell) ?? 0,
        visibleTraffic: state.world.traffic?.[`${candidateCell}:${position.z}`] ?? 0,
      }];
    });
  });
}

function candidateRank(first: WaterSearchCandidate, second: WaterSearchCandidate): number {
  return first.recentVisits - second.recentVisits
    || first.visibleTraffic - second.visibleTraffic
    || second.pathLength - first.pathLength
    || first.position.cellId - second.position.cellId
    || first.position.z - second.position.z;
}

function visibleWaterSearchCandidates(
  state: SimulationState,
  person: PersonState,
  visibleCellIds: Iterable<number>,
): WaterSearchCandidate[] {
  const candidates = rankedVisibleWaterSearchCandidates(state, person, visibleCellIds);
  if (!candidates.length) return [];
  const previousStep = person.position.lastPath.length >= 2
    ? person.position.lastPath.at(-2)
    : person.position.previousCellId;
  const nonReversing = candidates.filter((candidate) => candidate.firstStepCellId !== previousStep);
  const searchCandidates = nonReversing.length ? nonReversing : candidates;
  const identity = [...person.id].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  const directions = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
  const preferred = (identity + Math.floor(state.clock.elapsedMonths / 3)) % directions.length;
  const originX = cellX(person.position.cellId);
  const originY = cellY(person.position.cellId);
  const selected: WaterSearchCandidate[] = [];
  const selectedPositions = new Set<string>();
  for (let offset = 0; offset < directions.length; offset += 1) {
    const direction = directions[(preferred + offset) % directions.length];
    const originProjection = originX * direction.x + originY * direction.y;
    const forward = searchCandidates.filter((candidate) => candidate.x * direction.x + candidate.y * direction.y > originProjection);
    if (!forward.length) continue;
    const candidate = forward.sort((first, second) => {
      const projection = (second.x * direction.x + second.y * direction.y)
        - (first.x * direction.x + first.y * direction.y);
      return projection
        || first.recentVisits - second.recentVisits
        || first.visibleTraffic - second.visibleTraffic
        || second.pathLength - first.pathLength
        || first.position.cellId - second.position.cellId
        || first.position.z - second.position.z;
    })[0];
    const key = `${candidate.position.cellId}:${candidate.position.z}`;
    if (!selectedPositions.has(key)) {
      selected.push(candidate);
      selectedPositions.add(key);
    }
  }
  for (const candidate of searchCandidates.sort(candidateRank)) {
    if (selected.length >= 4) break;
    const key = `${candidate.position.cellId}:${candidate.position.z}`;
    if (selectedPositions.has(key)) continue;
    selected.push(candidate);
    selectedPositions.add(key);
  }
  return selected.slice(0, 4);
}

function waterSearchActions(
  state: SimulationState,
  person: PersonState,
  currentMonthEvents: readonly WorldEvent[],
): ActionFact[] {
  const byId = new Map<string, ActionFact>();
  for (const fact of actionFactsForPerson(state, person.id)) byId.set(fact.id, fact);
  for (const event of currentMonthEvents) {
    if (event.kind === 'action' && event.who === person.id) byId.set(event.id, event);
  }
  return [...byId.values()];
}

function currentWaterEvidenceKey(person: PersonState, actions: readonly ActionFact[]): string {
  const places = person.knownPlaces
    .filter((place) => materialHas(place.materialId, 'drinkable'))
    .map((place) => `${place.id}:${place.lastConfirmedAtMonth}:${[...place.sourceEventIds].sort().join(',')}`)
    .sort();
  const latestDrink = [...actions].reverse().find((fact) => fact.status === 'completed'
    && fact.action.kind === 'act'
    && fact.action.operation === 'ingest'
    && fact.action.targets.some((target) => target.kind === 'voxel'));
  return `${places.join('|')}#${latestDrink?.id ?? 'no-drink-fact'}`;
}

function compactEvidenceHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function searchMove(
  state: SimulationState,
  person: PersonState,
  basis: Omit<WaterSearchBasis, 'candidateIndex'>,
  startIndex: number,
): WaterSearchMove | null {
  for (let candidateIndex = startIndex; candidateIndex < basis.candidates.length; candidateIndex += 1) {
    const target = basis.candidates[candidateIndex];
    const path = findStandingPath(state.world.grid, person.position, target);
    if (path.length <= 1) continue;
    return {
      kind: 'move',
      toCellId: target.cellId,
      toZ: target.z,
      waterSearchBasis: { ...basis, candidateIndex },
    };
  }
  return null;
}

/**
 * Continue or open one finite water-search episode. A completed/blocked target
 * advances only within the frozen initial candidate list. The actor's newly
 * exposed cells never extend that list, so a failed search can truly end.
 */
export function compileBoundedWaterSearchMove(
  state: SimulationState,
  person: PersonState,
  beneficiaryId: string,
  visibleCellIds: Iterable<number> = defaultVisibleCells(person),
  currentMonthEvents: readonly WorldEvent[] = [],
): WaterSearchMove | null {
  const actions = waterSearchActions(state, person, currentMonthEvents);
  const evidenceKey = currentWaterEvidenceKey(person, actions);
  const latest = [...actions].reverse().find((fact) => fact.action.kind === 'move'
    && fact.action.waterSearchBasis?.beneficiaryId === beneficiaryId);
  const latestBasis = latest?.action.kind === 'move' ? latest.action.waterSearchBasis : undefined;
  if (latest && latestBasis?.evidenceKey === evidenceKey) {
    const { candidateIndex: _candidateIndex, ...episode } = latestBasis;
    const nextIndex = latest.status === 'progressed'
      ? latestBasis.candidateIndex
      : latestBasis.candidateIndex + 1;
    return searchMove(state, person, episode, nextIndex);
  }

  const candidates = visibleWaterSearchCandidates(state, person, visibleCellIds)
    .map(({ position }) => ({ cellId: position.cellId, z: position.z }));
  if (!candidates.length) return null;
  const openedAtMonth = state.clock.elapsedMonths + 1;
  const origin = { cellId: person.position.cellId, z: person.position.z };
  const episode = {
    version: 'bounded-water-search-v1' as const,
    episodeId: `water-search:${person.id}:${beneficiaryId}:${openedAtMonth}:${origin.cellId}:${origin.z}:${compactEvidenceHash(evidenceKey)}`,
    beneficiaryId,
    openedAtMonth,
    origin,
    candidates,
    evidenceKey,
  };
  return searchMove(state, person, episode, 0);
}
