import { Material } from './material';
import type { SimulationState } from './model';
import { inventoryQuantity, type PersonState } from './person';
import type { AnimalSpeciesId, AnimalState } from './animal';
import {
  cellX,
  cellY,
  neighbors4,
  surfaceMaterial,
  surfaceStandingPosition,
  type StandingPosition,
  type VoxelWorld,
} from '../world/grid';

// Keep these thresholds expressed in domain terms rather than civilization-stage
// gates. They are deliberately local: an animal can react only to bodies it can
// reach from its month-opening position.
export const WILDLIFE_ECOLOGY_VERSION = 'local-threat-ecology-v1' as const;
export const WOLF_HUMAN_PURSUIT_HUNGER = 92;
export const WOLF_LOW_HEALTH = 44;
export const WOLF_PERCEPTION_RADIUS = 6;
export const HERBIVORE_DANGER_RADIUS = 4;
export const PACK_CUE_SHARE_RADIUS = 3;
export const PACK_CUE_LIFETIME_MONTHS = 3;
export const WOLF_TERRITORY_RADIUS = 12;

export type WildlifeBehaviorMode =
  | 'wander'
  | 'forage'
  | 'flee'
  | 'defend'
  | 'hunt-prey'
  | 'pursue-human'
  | 'avoid-humans'
  | 'territory-return';

export interface WildlifeLastSeenCue {
  kind: 'human' | 'prey';
  targetId: string;
  cellId: number;
  observedAtMonth: number;
  expiresAtMonth: number;
  sourceAnimalId: string;
}

export interface WildlifeBehaviorState {
  atMonth: number;
  mode: WildlifeBehaviorMode;
  targetCellId?: number;
  targetAnimalId?: string;
  targetPersonId?: string;
  /** Present when the target came from a pack member's unrenewed cue. */
  sourceCueObservedAtMonth?: number;
}

export interface AnimalEcologyState {
  version: typeof WILDLIFE_ECOLOGY_VERSION;
  /** Wolves have a pack. Other species omit it. */
  packId?: string;
  /** A hard spatial boundary for wolf hunting decisions and movement. */
  territory?: { anchorCellId: number; radius: number };
  lastSeenCue?: WildlifeLastSeenCue;
  currentBehavior: WildlifeBehaviorState;
  /** Contact reached after this month's movement; it never authorizes an attack in the same month. */
  pursuitContact?: { targetPersonId: string; atMonth: number; cellId: number };
}

export interface WildlifeAnimalSnapshot {
  id: string;
  speciesId: AnimalSpeciesId;
  cellId: number;
  z: number;
  health: number;
  hunger: number;
  ecology: AnimalEcologyState;
}

export interface WildlifePersonSnapshot {
  id: string;
  cellId: number;
  z: number;
  health: number;
  woundStage: number;
  armed: boolean;
  sheltered: boolean;
}

export interface WildlifeIntent {
  animalId: string;
  mode: WildlifeBehaviorMode;
  targetCellId?: number;
  targetAnimalId?: string;
  targetPersonId?: string;
  sourceCueObservedAtMonth?: number;
  perceivedThreatAnimalIds?: string[];
  perceivedPersonIds?: string[];
  perceivedPreyIds?: string[];
  targetSelectionBasis?: {
    order: 'reachable-distance-asc,wound-desc,health-asc,visible-defense-asc,id-asc';
    selectedDefense: number;
    selectedWoundStage: number;
    selectedHealth: number;
  };
  /** Only a person already near at the month opening can be settled as an attack. */
  attackEligiblePersonId?: string;
}

function cellDistance(firstCell: number, secondCell: number): number {
  return Math.abs(cellX(firstCell) - cellX(secondCell)) + Math.abs(cellY(firstCell) - cellY(secondCell));
}

function stablePackNumber(id: string): number {
  let value = 0;
  for (let index = 0; index < id.length; index += 1) value = (value * 31 + id.charCodeAt(index)) >>> 0;
  return value % 2;
}

export function initialWolfPackId(index: number): string {
  return `wolf-pack-${Math.floor(Math.max(0, index) / 2) % 2 === 0 ? 'a' : 'b'}`;
}

export function createInitialAnimalEcology(
  speciesId: AnimalSpeciesId,
  animalId: string,
  cellId: number,
  packId?: string,
): AnimalEcologyState {
  const wolfPackId = speciesId === 'wolf' ? (packId ?? `wolf-pack-${stablePackNumber(animalId) ? 'b' : 'a'}`) : undefined;
  return {
    version: WILDLIFE_ECOLOGY_VERSION,
    ...(wolfPackId ? { packId: wolfPackId, territory: { anchorCellId: cellId, radius: WOLF_TERRITORY_RADIUS } } : {}),
    currentBehavior: { atMonth: -1, mode: 'wander' },
  };
}

function validCue(input: AnimalEcologyState['lastSeenCue']): input is WildlifeLastSeenCue {
  return Boolean(input
    && (input.kind === 'human' || input.kind === 'prey')
    && typeof input.targetId === 'string'
    && Number.isInteger(input.cellId)
    && Number.isInteger(input.observedAtMonth)
    && Number.isInteger(input.expiresAtMonth)
    && typeof input.sourceAnimalId === 'string');
}

function validEcology(input: AnimalEcologyState | undefined): input is AnimalEcologyState {
  return Boolean(input?.version === WILDLIFE_ECOLOGY_VERSION
    && input.currentBehavior
    && Number.isInteger(input.currentBehavior.atMonth));
}

function canonicalFounderWolfIndex(animalId: string): number | undefined {
  const match = /^animal-wolf-(\d+)$/.exec(animalId);
  if (!match) return undefined;
  const index = Number(match[1]);
  return Number.isInteger(index) ? index : undefined;
}

/**
 * Schema 17 predates local threat ecology, so restoration fills only missing or
 * malformed animal-local state. Sorting and parent lookup make the fill stable
 * even when an old JSON object's animal array has been reordered.
 */
export function normalizeAnimalEcologies(animals: AnimalState[]): void {
  const byId = new Map(animals.map((animal) => [animal.id, animal]));
  const missingWolves = animals.filter((animal) => animal.speciesId === 'wolf'
    && !validEcology(animal.ecology as AnimalEcologyState | undefined));
  const fallbackById = new Map<string, { packId: string; territory: { anchorCellId: number; radius: number } }>();
  const canonicalGroups = new Map<string, Array<{ animal: AnimalState; index: number }>>();
  for (const animal of missingWolves) {
    const index = canonicalFounderWolfIndex(animal.id);
    if (index === undefined) continue;
    const packId = initialWolfPackId(index);
    const members = canonicalGroups.get(packId) ?? [];
    members.push({ animal, index });
    canonicalGroups.set(packId, members);
  }
  for (const [packId, members] of canonicalGroups) {
    const existingTerritory = animals.find((candidate) => candidate.speciesId === 'wolf'
      && validEcology(candidate.ecology as AnimalEcologyState | undefined)
      && candidate.ecology.packId === packId
      && candidate.ecology.territory)?.ecology.territory;
    const anchorCellId = existingTerritory?.anchorCellId
      ?? [...members].sort((first, second) => first.index - second.index || first.animal.id.localeCompare(second.animal.id))[0].animal.position.cellId;
    const territory = { anchorCellId, radius: existingTerritory?.radius ?? WOLF_TERRITORY_RADIUS };
    for (const { animal } of members) fallbackById.set(animal.id, { packId, territory: { ...territory } });
  }
  const unassigned = missingWolves.filter((animal) => !fallbackById.has(animal.id))
    .sort((first, second) => first.id.localeCompare(second.id));
  while (unassigned.length) {
    const first = unassigned.shift() as AnimalState;
    const partner = [...unassigned].sort((left, right) => cellDistance(first.position.cellId, left.position.cellId)
      - cellDistance(first.position.cellId, right.position.cellId)
      || left.id.localeCompare(right.id))[0];
    if (partner) unassigned.splice(unassigned.findIndex((candidate) => candidate.id === partner.id), 1);
    const packId = `legacy-wolf-pack:${first.id}${partner ? `:${partner.id}` : ''}`;
    const territory = { anchorCellId: first.position.cellId, radius: WOLF_TERRITORY_RADIUS };
    fallbackById.set(first.id, { packId, territory: { ...territory } });
    if (partner) fallbackById.set(partner.id, { packId, territory: { ...territory } });
  }
  const normalized = new Set<string>();
  const normalize = (animal: AnimalState, visiting = new Set<string>()): AnimalEcologyState => {
    if (normalized.has(animal.id)) return animal.ecology;
    const current = animal.ecology as AnimalEcologyState | undefined;
    if (validEcology(current)) {
      if (current.lastSeenCue && !validCue(current.lastSeenCue)) delete current.lastSeenCue;
      normalized.add(animal.id);
      return current;
    }
    let inheritedPackId: string | undefined;
    let inheritedTerritory: AnimalEcologyState['territory'];
    if (animal.speciesId === 'wolf' && !visiting.has(animal.id)) {
      const nextVisiting = new Set(visiting).add(animal.id);
      for (const parentId of [...animal.geneticParents].sort()) {
        const parent = byId.get(parentId);
        if (!parent || parent.speciesId !== 'wolf') continue;
        const parentEcology = normalize(parent, nextVisiting);
        if (!parentEcology.packId) continue;
        inheritedPackId = parentEcology.packId;
        inheritedTerritory = parentEcology.territory ? { ...parentEcology.territory } : undefined;
        break;
      }
    }
    const fallback = fallbackById.get(animal.id);
    const ecology = createInitialAnimalEcology(
      animal.speciesId,
      animal.id,
      inheritedTerritory?.anchorCellId ?? fallback?.territory.anchorCellId ?? animal.position.cellId,
      inheritedPackId ?? fallback?.packId,
    );
    if (inheritedTerritory) ecology.territory = inheritedTerritory;
    else if (fallback) ecology.territory = { ...fallback.territory };
    animal.ecology = ecology;
    normalized.add(animal.id);
    return ecology;
  };
  for (const animal of [...animals].sort((a, b) => a.id.localeCompare(b.id))) normalize(animal);
}

export function wildlifeAnimalSnapshot(animal: AnimalState): WildlifeAnimalSnapshot {
  return {
    id: animal.id,
    speciesId: animal.speciesId,
    cellId: animal.position.cellId,
    z: animal.position.z,
    health: animal.health,
    hunger: animal.hunger,
    ecology: structuredClone(animal.ecology),
  };
}

export function wildlifePersonSnapshot(
  person: PersonState,
  sheltered: boolean,
): WildlifePersonSnapshot {
  return {
    id: person.id,
    cellId: person.position.cellId,
    z: person.position.z,
    health: person.body.health,
    woundStage: person.conditions
      .filter((condition) => condition.kind === 'wound')
      .reduce((maximum, condition) => Math.max(maximum, condition.stage), 0),
    armed: inventoryQuantity(person, Material.Spear) > 0,
    sheltered,
  };
}

/** Reachable surface cells and their shortest step distance, bounded locally. */
export function reachableWildlifeCells(
  world: VoxelWorld,
  start: StandingPosition,
  radius: number,
  territory?: { anchorCellId: number; radius: number },
): Map<number, number> {
  const result = new Map<number, number>([[start.cellId, 0]]);
  const standingZ = new Map<number, number>([[start.cellId, start.z]]);
  const queue = [start.cellId];
  while (queue.length) {
    const cellId = queue.shift() as number;
    const distance = result.get(cellId) as number;
    if (distance >= radius) continue;
    const fromZ = standingZ.get(cellId) as number;
    for (const candidate of neighbors4(cellId)) {
      if (result.has(candidate)) continue;
      if (territory && cellDistance(candidate, territory.anchorCellId) > territory.radius) continue;
      const standing = surfaceStandingPosition(world, candidate);
      if (!standing || Math.abs(standing.z - fromZ) > 1) continue;
      result.set(candidate, distance + 1);
      standingZ.set(candidate, standing.z);
      queue.push(candidate);
    }
  }
  return result;
}

function standingSnapshotIsReachable(
  world: VoxelWorld,
  reachable: Map<number, number>,
  body: { cellId: number; z: number },
): boolean {
  const standing = surfaceStandingPosition(world, body.cellId);
  return reachable.has(body.cellId) && standing?.z === body.z;
}

function personDefenseAtCell(people: WildlifePersonSnapshot[], cellId: number): number {
  const nearby = people.filter((person) => cellDistance(person.cellId, cellId) <= 1 && !person.sheltered);
  return nearby.filter((person) => person.armed).length * 2 + Math.max(0, nearby.length - 1);
}

/** Stable vulnerability order; never depends on the input array order. */
export function selectStableHumanTarget(
  candidates: WildlifePersonSnapshot[],
  allPeople: WildlifePersonSnapshot[],
): WildlifePersonSnapshot | undefined {
  return [...candidates].sort((first, second) => {
    const firstDefense = personDefenseAtCell(allPeople, first.cellId) + (first.armed ? 2 : 0);
    const secondDefense = personDefenseAtCell(allPeople, second.cellId) + (second.armed ? 2 : 0);
    return second.woundStage - first.woundStage
      || first.health - second.health
      || firstDefense - secondDefense
      || first.id.localeCompare(second.id);
  })[0];
}

function selectLocalHumanTarget(
  candidates: WildlifePersonSnapshot[],
  allPeople: WildlifePersonSnapshot[],
  reachable: Map<number, number>,
): WildlifePersonSnapshot | undefined {
  const minimumDistance = candidates.reduce(
    (minimum, person) => Math.min(minimum, reachable.get(person.cellId) ?? Number.POSITIVE_INFINITY),
    Number.POSITIVE_INFINITY,
  );
  return selectStableHumanTarget(
    candidates.filter((person) => reachable.get(person.cellId) === minimumDistance),
    allPeople,
  );
}

function targetSelectionBasis(
  target: WildlifePersonSnapshot,
  allPeople: WildlifePersonSnapshot[],
): NonNullable<WildlifeIntent['targetSelectionBasis']> {
  return {
    order: 'reachable-distance-asc,wound-desc,health-asc,visible-defense-asc,id-asc',
    selectedDefense: personDefenseAtCell(allPeople, target.cellId) + (target.armed ? 2 : 0),
    selectedWoundStage: target.woundStage,
    selectedHealth: target.health,
  };
}

function armedGroupCells(people: WildlifePersonSnapshot[]): number[] {
  const cells = [...new Set(people.filter((person) => !person.sheltered).map((person) => person.cellId))].sort((a, b) => a - b);
  return cells.filter((cellId) => {
    const group = people.filter((person) => !person.sheltered && cellDistance(person.cellId, cellId) <= 1);
    return group.length >= 2 && group.filter((person) => person.armed).length >= 1;
  });
}

function farthestReachableCell(
  reachable: Map<number, number>,
  threats: Array<{ cellId: number }>,
): number | undefined {
  if (!threats.length) return undefined;
  return [...reachable.keys()].sort((first, second) => {
    const firstSafety = Math.min(...threats.map((threat) => cellDistance(first, threat.cellId)));
    const secondSafety = Math.min(...threats.map((threat) => cellDistance(second, threat.cellId)));
    return secondSafety - firstSafety
      || (reachable.get(second) as number) - (reachable.get(first) as number)
      || first - second;
  })[0];
}

function cueRank(first: WildlifeLastSeenCue, second: WildlifeLastSeenCue): number {
  return second.observedAtMonth - first.observedAtMonth
    || first.sourceAnimalId.localeCompare(second.sourceAnimalId)
    || first.targetId.localeCompare(second.targetId);
}

/**
 * Applies direct sightings and short-range pack sharing against one immutable
 * month-opening position snapshot. Shared cues retain their original observed
 * and expiry months, so information cannot be kept alive by relaying it.
 */
export function synchronizeWolfPackCues(
  state: SimulationState,
  atMonth: number,
  animals: WildlifeAnimalSnapshot[],
  people: WildlifePersonSnapshot[],
): Map<string, WildlifeLastSeenCue | undefined> {
  const result = new Map<string, WildlifeLastSeenCue | undefined>();
  const wolves = animals.filter((animal) => animal.speciesId === 'wolf').sort((a, b) => a.id.localeCompare(b.id));
  for (const wolf of wolves) {
    const territory = wolf.ecology.territory;
    const reachable = reachableWildlifeCells(
      state.world.grid,
      { cellId: wolf.cellId, z: wolf.z },
      WOLF_PERCEPTION_RADIUS,
      territory,
    );
    const locallyVisible = people.filter((person) => !person.sheltered
      && standingSnapshotIsReachable(state.world.grid, reachable, person));
    const target = selectLocalHumanTarget(locallyVisible, locallyVisible, reachable);
    if (target) result.set(wolf.id, {
      kind: 'human',
      targetId: target.id,
      cellId: target.cellId,
      observedAtMonth: atMonth,
      expiresAtMonth: atMonth + PACK_CUE_LIFETIME_MONTHS,
      sourceAnimalId: wolf.id,
    });
    else {
      const prior = wolf.ecology.lastSeenCue;
      result.set(wolf.id, prior && prior.expiresAtMonth >= atMonth ? structuredClone(prior) : undefined);
    }
  }
  const directSourceCues = new Map([...result.entries()].filter(([animalId, cue]) => cue?.sourceAnimalId === animalId));
  for (const receiver of wolves) {
    const packId = receiver.ecology.packId;
    if (!packId) continue;
    const shareReachable = reachableWildlifeCells(
      state.world.grid,
      { cellId: receiver.cellId, z: receiver.z },
      PACK_CUE_SHARE_RADIUS,
      receiver.ecology.territory,
    );
    const candidates = wolves
      .filter((source) => source.id !== receiver.id
        && source.ecology.packId === packId
        && standingSnapshotIsReachable(state.world.grid, shareReachable, source))
      .flatMap((source) => {
        const cue = directSourceCues.get(source.id);
        return cue && cue.expiresAtMonth >= atMonth ? [cue] : [];
      })
      .sort(cueRank);
    const own = result.get(receiver.id);
    const shared = candidates[0];
    if (shared && (!own || cueRank(shared, own) < 0)) result.set(receiver.id, structuredClone(shared));
  }
  return result;
}

function closestByDistance<T extends { id: string; cellId: number }>(
  candidates: T[],
  reachable: Map<number, number>,
): T | undefined {
  return [...candidates].sort((first, second) => (reachable.get(first.cellId) ?? Number.POSITIVE_INFINITY)
    - (reachable.get(second.cellId) ?? Number.POSITIVE_INFINITY)
    || first.id.localeCompare(second.id))[0];
}

function safeNaturalPrey(
  world: VoxelWorld,
  animals: WildlifeAnimalSnapshot[],
  people: WildlifePersonSnapshot[],
  reachable: Map<number, number>,
): WildlifeAnimalSnapshot[] {
  return animals.filter((candidate) => candidate.speciesId !== 'wolf'
    && standingSnapshotIsReachable(world, reachable, candidate)
    && !people.some((person) => person.armed && cellDistance(person.cellId, candidate.cellId) <= 1));
}

function wolfIntent(
  state: SimulationState,
  atMonth: number,
  wolf: WildlifeAnimalSnapshot,
  animals: WildlifeAnimalSnapshot[],
  people: WildlifePersonSnapshot[],
  cue: WildlifeLastSeenCue | undefined,
): WildlifeIntent {
  const territory = wolf.ecology.territory;
  if (territory && cellDistance(wolf.cellId, territory.anchorCellId) > territory.radius) return {
    animalId: wolf.id,
    mode: 'territory-return',
    targetCellId: territory.anchorCellId,
  };
  const reachable = reachableWildlifeCells(state.world.grid, { cellId: wolf.cellId, z: wolf.z }, WOLF_PERCEPTION_RADIUS, territory);
  const visiblePeople = people.filter((person) => !person.sheltered
    && standingSnapshotIsReachable(state.world.grid, reachable, person));
  const defendedCells = armedGroupCells(visiblePeople).filter((cellId) => reachable.has(cellId));
  if (wolf.health <= WOLF_LOW_HEALTH && defendedCells.length) return {
    animalId: wolf.id,
    mode: 'avoid-humans',
    targetCellId: farthestReachableCell(reachable, defendedCells.map((cellId) => ({ cellId }))),
    perceivedPersonIds: visiblePeople.map((person) => person.id).sort(),
  };
  const prey = safeNaturalPrey(state.world.grid, animals, visiblePeople, reachable);
  const nearestPrey = closestByDistance(prey, reachable);
  if (nearestPrey && wolf.hunger >= 45) return {
    animalId: wolf.id,
    mode: 'hunt-prey',
    targetCellId: nearestPrey.cellId,
    targetAnimalId: nearestPrey.id,
    perceivedPreyIds: prey.map((candidate) => candidate.id).sort(),
  };
  if (wolf.hunger >= WOLF_HUMAN_PURSUIT_HUNGER && !nearestPrey) {
    const directTarget = selectLocalHumanTarget(visiblePeople, visiblePeople, reachable);
    const cueTarget = !directTarget && cue?.kind === 'human' && cue.expiresAtMonth >= atMonth ? cue : undefined;
    const targetPersonId = directTarget?.id ?? cueTarget?.targetId;
    const targetCellId = directTarget?.cellId ?? cueTarget?.cellId;
    if (targetPersonId !== undefined && targetCellId !== undefined
      && (!territory || cellDistance(targetCellId, territory.anchorCellId) <= territory.radius)) {
      const nearAtOpening = directTarget
        && cellDistance(wolf.cellId, directTarget.cellId) <= 1
        && Math.abs(wolf.z - directTarget.z) <= 1;
      return {
        animalId: wolf.id,
        mode: 'pursue-human',
        targetCellId,
        targetPersonId,
        perceivedPersonIds: visiblePeople.map((person) => person.id).sort(),
        ...(directTarget ? { targetSelectionBasis: targetSelectionBasis(directTarget, visiblePeople) } : {}),
        ...(cueTarget ? { sourceCueObservedAtMonth: cueTarget.observedAtMonth } : {}),
        ...(nearAtOpening && cellDistance(wolf.cellId, directTarget.cellId) === 0
          ? { attackEligiblePersonId: directTarget.id }
          : {}),
      };
    }
  }
  return { animalId: wolf.id, mode: 'wander' };
}

function herbivoreIntent(
  state: SimulationState,
  animal: WildlifeAnimalSnapshot,
  animals: WildlifeAnimalSnapshot[],
  people: WildlifePersonSnapshot[],
): WildlifeIntent {
  const reachable = reachableWildlifeCells(state.world.grid, { cellId: animal.cellId, z: animal.z }, HERBIVORE_DANGER_RADIUS);
  const wolves = animals.filter((candidate) => candidate.speciesId === 'wolf'
    && standingSnapshotIsReachable(state.world.grid, reachable, candidate));
  const localPeople = people.filter((person) => !person.sheltered
    && standingSnapshotIsReachable(state.world.grid, reachable, person));
  const armedPeople = localPeople.filter((person) => person.armed);
  const coLocatedPeople = localPeople.filter((person) => !person.sheltered
    && person.cellId === animal.cellId
    && person.z === animal.z);
  if (animal.speciesId === 'boar' && animal.hunger >= 78 && coLocatedPeople.length && !wolves.length) {
    const target = selectStableHumanTarget(coLocatedPeople, localPeople);
    if (target) return {
      animalId: animal.id,
      mode: 'defend',
      targetCellId: animal.cellId,
      targetPersonId: target.id,
      perceivedPersonIds: coLocatedPeople.map((person) => person.id).sort(),
      targetSelectionBasis: targetSelectionBasis(target, localPeople),
      attackEligiblePersonId: target.id,
    };
  }
  const threats = [...wolves, ...armedPeople];
  if (threats.length) return {
    animalId: animal.id,
    mode: 'flee',
    targetCellId: farthestReachableCell(reachable, threats),
    perceivedThreatAnimalIds: wolves.map((wolf) => wolf.id).sort(),
    perceivedPersonIds: armedPeople.map((person) => person.id).sort(),
  };
  const forageReachable = reachableWildlifeCells(state.world.grid, { cellId: animal.cellId, z: animal.z }, 5);
  const plantCells = [...forageReachable.keys()].filter((cellId) => ediblePlantAt(state.world.grid, cellId));
  const targetCellId = [...plantCells].sort((first, second) => cellDistance(animal.cellId, first) - cellDistance(animal.cellId, second)
    || first - second)[0];
  return { animalId: animal.id, mode: 'forage', ...(targetCellId !== undefined ? { targetCellId } : {}) };
}

/** Plans every animal from one immutable month-opening snapshot. */
export function planWildlifeIntents(
  state: SimulationState,
  atMonth: number,
  animals: WildlifeAnimalSnapshot[],
  people: WildlifePersonSnapshot[],
  cues: Map<string, WildlifeLastSeenCue | undefined>,
): WildlifeIntent[] {
  return [...animals].sort((a, b) => a.id.localeCompare(b.id)).map((animal) => animal.speciesId === 'wolf'
    ? wolfIntent(state, atMonth, animal, animals, people, cues.get(animal.id))
    : herbivoreIntent(state, animal, animals, people));
}

export function behaviorFromIntent(atMonth: number, intent: WildlifeIntent): WildlifeBehaviorState {
  return {
    atMonth,
    mode: intent.mode,
    ...(intent.targetCellId !== undefined ? { targetCellId: intent.targetCellId } : {}),
    ...(intent.targetAnimalId ? { targetAnimalId: intent.targetAnimalId } : {}),
    ...(intent.targetPersonId ? { targetPersonId: intent.targetPersonId } : {}),
    ...(intent.sourceCueObservedAtMonth !== undefined ? { sourceCueObservedAtMonth: intent.sourceCueObservedAtMonth } : {}),
  };
}

export function wolfMovementAllowed(animal: AnimalState, candidateCellId: number): boolean {
  const territory = animal.ecology.territory;
  if (!territory) return true;
  const currentDistance = cellDistance(animal.position.cellId, territory.anchorCellId);
  const candidateDistance = cellDistance(candidateCellId, territory.anchorCellId);
  return candidateDistance <= territory.radius || (currentDistance > territory.radius && candidateDistance < currentDistance);
}

export function animalCellDistance(firstCell: number, secondCell: number): number {
  return cellDistance(firstCell, secondCell);
}

export function wildlifeEdiblePlant(materialId: number): boolean {
  return materialId === Material.Grass
    || materialId === Material.Shrub
    || materialId === Material.BerryBush
    || materialId === Material.CropSprout
    || materialId === Material.CropMature;
}

function ediblePlantAt(world: VoxelWorld, cellId: number): boolean {
  return wildlifeEdiblePlant(surfaceMaterial(world, cellId));
}
