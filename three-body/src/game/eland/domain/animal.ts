import type { BiologicalSex } from '../population';
import { Material, type MaterialId } from './material';
import {
  WORLD_CELL_COUNT,
  cellsInRadius,
  isPassable,
  surfaceStandingPosition,
  type VoxelWorld,
} from '../world/grid';
import { seededFraction } from '../world/generator';
import {
  createInitialAnimalEcology,
  initialWolfPackId,
  reachableWildlifeCells,
  type AnimalEcologyState,
} from './wildlife-ecology';

export type AnimalSpeciesId = 'deer' | 'rabbit' | 'boar' | 'wolf';

export interface AnimalProduct {
  materialId: MaterialId;
  minQuantity: number;
  maxQuantity: number;
}

export interface AnimalSpeciesDefinition {
  id: AnimalSpeciesId;
  name: string;
  diet: 'herbivore' | 'predator';
  adultAtMonths: number;
  lifespanMonths: number;
  movementPerMonth: number;
  hungerPerMonth: number;
  evasion: number;
  aggression: number;
  /** Human-visible caution radius; behavior still requires local reachability. */
  alarmRadius: number;
  carryingCapacity: number;
  products: AnimalProduct[];
}

export interface AnimalState {
  id: string;
  speciesId: AnimalSpeciesId;
  sex: BiologicalSex;
  bornAtMonth: number;
  lifespanMonths: number;
  geneticParents: string[];
  position: { cellId: number; z: number; previousCellId: number; previousZ: number };
  health: number;
  hunger: number;
  lastAteAtMonth: number;
  ecology: AnimalEcologyState;
  diedAtMonth?: number;
}

export const ANIMAL_SPECIES: Record<AnimalSpeciesId, AnimalSpeciesDefinition> = {
  deer: {
    id: 'deer', name: '鹿', diet: 'herbivore', adultAtMonths: 18, lifespanMonths: 15 * 12,
    movementPerMonth: 3, hungerPerMonth: 9, evasion: 34, aggression: 0, alarmRadius: 2, carryingCapacity: 30,
    products: [
      { materialId: Material.RawMeat, minQuantity: 4, maxQuantity: 7 },
      { materialId: Material.Hide, minQuantity: 1, maxQuantity: 2 },
      { materialId: Material.Bone, minQuantity: 1, maxQuantity: 3 },
    ],
  },
  rabbit: {
    id: 'rabbit', name: '兔', diet: 'herbivore', adultAtMonths: 6, lifespanMonths: 7 * 12,
    movementPerMonth: 2, hungerPerMonth: 12, evasion: 48, aggression: 0, alarmRadius: 1, carryingCapacity: 56,
    products: [
      { materialId: Material.RawMeat, minQuantity: 1, maxQuantity: 2 },
      { materialId: Material.Hide, minQuantity: 0, maxQuantity: 1 },
    ],
  },
  boar: {
    id: 'boar', name: '野猪', diet: 'herbivore', adultAtMonths: 14, lifespanMonths: 12 * 12,
    movementPerMonth: 2, hungerPerMonth: 10, evasion: 24, aggression: 42, alarmRadius: 3, carryingCapacity: 18,
    products: [
      { materialId: Material.RawMeat, minQuantity: 5, maxQuantity: 9 },
      { materialId: Material.Hide, minQuantity: 1, maxQuantity: 2 },
      { materialId: Material.Bone, minQuantity: 1, maxQuantity: 3 },
    ],
  },
  wolf: {
    id: 'wolf', name: '狼', diet: 'predator', adultAtMonths: 16, lifespanMonths: 11 * 12,
    movementPerMonth: 4, hungerPerMonth: 13, evasion: 38, aggression: 68, alarmRadius: 5, carryingCapacity: 12,
    products: [
      { materialId: Material.RawMeat, minQuantity: 2, maxQuantity: 4 },
      { materialId: Material.Hide, minQuantity: 1, maxQuantity: 2 },
      { materialId: Material.Bone, minQuantity: 1, maxQuantity: 2 },
    ],
  },
};

export function animalSpecies(id: AnimalSpeciesId): AnimalSpeciesDefinition {
  return ANIMAL_SPECIES[id];
}

export function isAnimalAlive(animal: AnimalState): boolean {
  return animal.diedAtMonth === undefined && animal.health > 0;
}

export function animalAgeMonths(animal: AnimalState, atMonth: number): number {
  return Math.max(0, atMonth - animal.bornAtMonth);
}

function initialAnimal(
  seed: number,
  speciesId: AnimalSpeciesId,
  index: number,
  world: VoxelWorld,
  cellId: number,
  packId?: string,
  ecologyAnchorCellId = cellId,
): AnimalState {
  const species = animalSpecies(speciesId);
  const id = `animal-${speciesId}-${index}`;
  const standing = surfaceStandingPosition(world, cellId);
  const age = Math.floor(seededFraction(seed, `${id}:age`) * species.lifespanMonths * 0.55);
  const lifespanNoise = 0.82 + seededFraction(seed, `${id}:lifespan`) * 0.36;
  return {
    id,
    speciesId,
    sex: index % 2 === 0 ? 'female' : 'male',
    bornAtMonth: -age,
    lifespanMonths: Math.round(species.lifespanMonths * lifespanNoise),
    geneticParents: [],
    position: {
      cellId,
      z: standing?.z ?? 1,
      previousCellId: cellId,
      previousZ: standing?.z ?? 1,
    },
    health: 78 + Math.floor(seededFraction(seed, `${id}:health`) * 20),
    hunger: 15 + Math.floor(seededFraction(seed, `${id}:hunger`) * 30),
    lastAteAtMonth: 0,
    ecology: createInitialAnimalEcology(speciesId, id, ecologyAnchorCellId, packId),
  };
}

/** Deterministic wildlife population generated from physical, passable cells. */
export function createInitialAnimals(seed: number, world: VoxelWorld, humanSpawnCells: number[]): AnimalState[] {
  const humanArea = new Set(humanSpawnCells.flatMap((cell) => cellsInRadius(cell, 4)));
  const passable = Array.from({ length: WORLD_CELL_COUNT }, (_, cellId) => cellId)
    .filter((cellId) => isPassable(world, cellId));
  const used = new Set<number>();
  const animals: AnimalState[] = [];
  const populations: Array<[AnimalSpeciesId, number]> = [
    ['deer', 12],
    ['rabbit', 18],
    ['boar', 6],
    ['wolf', 4],
  ];
  const wolfPackAnchors: number[] = [];
  for (const [speciesId, count] of populations) {
    for (let index = 0; index < count; index += 1) {
      const wolfPackIndex = speciesId === 'wolf' ? Math.floor(index / 2) : -1;
      const wolfPackAnchor = wolfPackIndex >= 0 ? wolfPackAnchors[wolfPackIndex] : undefined;
      const wolfPackStanding = wolfPackAnchor === undefined ? undefined : surfaceStandingPosition(world, wolfPackAnchor);
      const nearbyPackCells = wolfPackAnchor === undefined
        ? []
        : [...reachableWildlifeCells(world, wolfPackStanding ?? { cellId: wolfPackAnchor, z: 1 }, 2).keys()]
          .sort((first, second) => seededFraction(seed, `animal-pack-spawn:${speciesId}:${index}:${first}`)
            - seededFraction(seed, `animal-pack-spawn:${speciesId}:${index}:${second}`)
            || first - second);
      const candidates = nearbyPackCells.length ? nearbyPackCells : passable;
      const start = Math.floor(seededFraction(seed, `animal-spawn:${speciesId}:${index}`) * candidates.length);
      let cellId: number | undefined;
      for (let probe = 0; probe < candidates.length; probe += 1) {
        const candidate = candidates[(start + probe * 97) % candidates.length];
        if (used.has(candidate) || (speciesId === 'wolf' && humanArea.has(candidate))) continue;
        if (speciesId === 'wolf' && wolfPackAnchor === undefined
          && wolfPackAnchors.some((anchor) => cellsInRadius(anchor, 8).includes(candidate))) continue;
        if (speciesId === 'wolf' && wolfPackAnchor === undefined
          && ![...reachableWildlifeCells(
            world,
            surfaceStandingPosition(world, candidate) ?? { cellId: candidate, z: 1 },
            2,
          ).keys()].some((neighbor) => neighbor !== candidate
            && !used.has(neighbor)
            && !humanArea.has(neighbor))) continue;
        cellId = candidate;
        break;
      }
      if (cellId === undefined) break;
      if (speciesId === 'wolf' && wolfPackAnchor === undefined) wolfPackAnchors[wolfPackIndex] = cellId;
      used.add(cellId);
      animals.push(initialAnimal(
        seed,
        speciesId,
        index,
        world,
        cellId,
        speciesId === 'wolf' ? initialWolfPackId(index) : undefined,
        speciesId === 'wolf' ? wolfPackAnchors[wolfPackIndex] : cellId,
      ));
    }
  }
  return animals;
}
