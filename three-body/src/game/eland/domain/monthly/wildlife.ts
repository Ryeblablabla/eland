import { Material } from '../material';
import type { EnvironmentFact, SimulationState } from '../model';
import type { PersonState } from '../person';
import { isAlive } from '../person';
import { addDrop } from '../action-executor';
import {
  animalAgeMonths,
  animalSpecies,
  isAnimalAlive,
  type AnimalState,
} from '../animal';
import { shelterGeometryAt } from '../structure';
import {
  cellX,
  cellY,
  neighbors4,
  setVoxel,
  surfaceMaterial,
  surfaceStandingPosition,
  topZ,
} from '../../world/grid';
import { seededFraction } from '../../world/generator';
import {
  HERBIVORE_DANGER_RADIUS,
  PACK_CUE_SHARE_RADIUS,
  WOLF_PERCEPTION_RADIUS,
  behaviorFromIntent,
  createInitialAnimalEcology,
  normalizeAnimalEcologies,
  planWildlifeIntents,
  reachableWildlifeCells,
  synchronizeWolfPackCues,
  wildlifeAnimalSnapshot,
  wildlifeEdiblePlant,
  wildlifePersonSnapshot,
  wolfMovementAllowed,
  type WildlifeAnimalSnapshot,
  type WildlifeIntent,
} from '../wildlife-ecology';

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function event(
  state: SimulationState,
  atMonth: number,
  events: EnvironmentFact[],
  change: EnvironmentFact['change'],
  result: string,
  diff: Record<string, unknown>,
  person?: PersonState,
): EnvironmentFact {
  void state;
  const fact: EnvironmentFact = {
    id: `e-${atMonth}-environment-${change}-${events.length}`,
    kind: 'environment',
    atMonth,
    orderInMonth: events.length,
    cellId: person?.position.cellId ?? 0,
    change,
    ...(person ? { who: person.id } : {}),
    result,
    diff,
  };
  events.push(fact);
  return fact;
}

function animalDistance(firstCell: number, secondCell: number): number {
  return Math.abs(cellX(firstCell) - cellX(secondCell)) + Math.abs(cellY(firstCell) - cellY(secondCell));
}

function moveAnimal(state: SimulationState, animal: AnimalState, targetCell: number | undefined, atMonth: number): void {
  const species = animalSpecies(animal.speciesId);
  animal.position.previousCellId = animal.position.cellId;
  animal.position.previousZ = animal.position.z;
  if (targetCell === animal.position.cellId) return;
  for (let step = 0; step < species.movementPerMonth; step += 1) {
    const candidates = neighbors4(animal.position.cellId)
      .flatMap((cell) => {
        const standing = surfaceStandingPosition(state.world.grid, cell);
        return standing ? [standing] : [];
      })
      .filter((candidate) => Math.abs(candidate.z - animal.position.z) <= 1)
      .filter((candidate) => animal.speciesId !== 'wolf' || wolfMovementAllowed(animal, candidate.cellId));
    if (!candidates.length) break;
    candidates.sort((a, b) => {
      const targetDelta = targetCell === undefined ? 0 : animalDistance(a.cellId, targetCell) - animalDistance(b.cellId, targetCell);
      return targetDelta
        || seededFraction(state.seed, `animal-move:${atMonth}:${animal.id}:${step}:${a.cellId}`)
          - seededFraction(state.seed, `animal-move:${atMonth}:${animal.id}:${step}:${b.cellId}`)
        || a.cellId - b.cellId;
    });
    const next = candidates[0];
    animal.position.cellId = next.cellId;
    animal.position.z = next.z;
    if (targetCell !== undefined && next.cellId === targetCell) break;
  }
}

function animalEvent(
  state: SimulationState,
  atMonth: number,
  events: EnvironmentFact[],
  animal: AnimalState,
  result: string,
  diff: Record<string, unknown>,
  person?: PersonState,
): EnvironmentFact {
  const fact = event(state, atMonth, events, 'animal', result, { animalId: animal.id, animalSpeciesId: animal.speciesId, ...diff }, person);
  fact.cellId = animal.position.cellId;
  return fact;
}

function dropAnimalProducts(state: SimulationState, animal: AnimalState, atMonth: number, sourceEventId: string): Array<{ materialId: number; quantity: number }> {
  const species = animalSpecies(animal.speciesId);
  return species.products.flatMap((product) => {
    const span = Math.max(0, product.maxQuantity - product.minQuantity);
    const quantity = product.minQuantity + Math.floor(seededFraction(state.seed, `animal-product:${animal.id}:${atMonth}:${product.materialId}`) * (span + 1));
    if (quantity <= 0) return [];
    addDrop(state, product.materialId, quantity, animal.position.cellId, atMonth, [sourceEventId], `${animal.id}-carcass`, undefined, animal.position.z);
    return [{ materialId: product.materialId, quantity }];
  });
}

function killAnimal(state: SimulationState, animal: AnimalState, atMonth: number, events: EnvironmentFact[], process: string, killerAnimalId?: string): void {
  if (animal.diedAtMonth !== undefined) return;
  animal.health = 0;
  animal.diedAtMonth = atMonth;
  const fact = animalEvent(state, atMonth, events, animal, `${animalSpecies(animal.speciesId).name}在生态过程中死亡`, {
    process, outcome: 'death', ...(killerAnimalId ? { killerAnimalId } : {}),
  });
  fact.diff.products = dropAnimalProducts(state, animal, atMonth, fact.id);
}

function advanceAnimalBirths(state: SimulationState, atMonth: number, events: EnvironmentFact[]): void {
  if (atMonth % 12 !== 3) return;
  for (const speciesId of ['deer', 'rabbit', 'boar', 'wolf'] as const) {
    const species = animalSpecies(speciesId);
    const living = state.world.animals
      .filter((animal) => animal.speciesId === speciesId && isAnimalAlive(animal))
      .sort((first, second) => first.id.localeCompare(second.id));
    if (living.length >= species.carryingCapacity) continue;
    const mothers = living.filter((animal) => animal.sex === 'female' && animalAgeMonths(animal, atMonth) >= species.adultAtMonths && animal.hunger <= 62);
    let births = 0;
    for (const mother of mothers) {
      if (living.length + births >= species.carryingCapacity || births >= 4) break;
      const reachableMates = reachableWildlifeCells(
        state.world.grid,
        { cellId: mother.position.cellId, z: mother.position.z },
        3,
        mother.ecology.territory,
      );
      const father = living.find((candidate) => candidate.sex === 'male'
        && animalAgeMonths(candidate, atMonth) >= species.adultAtMonths
        && reachableMates.has(candidate.position.cellId)
        && surfaceStandingPosition(state.world.grid, candidate.position.cellId)?.z === candidate.position.z);
      if (!father) continue;
      const chance = speciesId === 'rabbit' ? 0.48 : speciesId === 'boar' ? 0.25 : speciesId === 'deer' ? 0.2 : 0.16;
      if (seededFraction(state.seed, `animal-birth:${atMonth}:${mother.id}:${father.id}`) >= chance) continue;
      const id = `animal-${speciesId}-born-${atMonth}-${state.world.animals.length}`;
      const childEcology = createInitialAnimalEcology(
        speciesId,
        id,
        mother.ecology.territory?.anchorCellId ?? mother.position.cellId,
        mother.ecology.packId,
      );
      if (mother.ecology.territory) childEcology.territory = { ...mother.ecology.territory };
      const child: AnimalState = {
        id,
        speciesId,
        sex: seededFraction(state.seed, `${id}:sex`) < 0.5 ? 'female' : 'male',
        bornAtMonth: atMonth,
        lifespanMonths: Math.round(species.lifespanMonths * (0.82 + seededFraction(state.seed, `${id}:lifespan`) * 0.36)),
        geneticParents: [mother.id, father.id],
        position: {
          cellId: mother.position.cellId, z: mother.position.z,
          previousCellId: mother.position.cellId, previousZ: mother.position.z,
        },
        health: 72,
        hunger: 18,
        lastAteAtMonth: atMonth,
        ecology: childEcology,
      };
      state.world.animals.push(child);
      births += 1;
      animalEvent(state, atMonth, events, child, `一只${species.name}幼仔出生`, {
        process: 'birth', outcome: 'birth', parentIds: [mother.id, father.id],
      });
    }
  }
}

function behaviorEventDiff(
  animal: AnimalState,
  intent: WildlifeIntent,
  opening: WildlifeAnimalSnapshot,
): Record<string, unknown> {
  return {
    process: intent.mode === 'pursue-human' ? 'pursuit-human'
      : intent.mode === 'flee' ? 'flee-threat'
        : intent.mode === 'defend' ? 'defensive-charge'
          : intent.mode === 'avoid-humans' ? 'avoid-armed-group'
            : intent.mode === 'territory-return' ? 'territory-return'
              : intent.mode === 'hunt-prey' ? 'hunt-prey'
                : intent.mode,
    intentPhase: 'month-opening-snapshot',
    movementPhase: 'simultaneous-intent-resolution',
    monthOpeningCellId: opening.cellId,
    destinationCellId: animal.position.cellId,
    plannedTargetCellId: intent.targetCellId,
    targetAnimalId: intent.targetAnimalId,
    targetPersonId: intent.targetPersonId,
    perception: intent.mode === 'pursue-human' && intent.sourceCueObservedAtMonth !== undefined ? {
      basis: 'pack-last-seen-cue',
      currentTargetReachable: 'unknown',
      radius: null,
      sourceCueObservedAtMonth: intent.sourceCueObservedAtMonth,
      perceivedThreatAnimalIds: [],
      perceivedPreyIds: [],
      perceivedPersonIds: [],
    } : intent.mode === 'territory-return' ? {
      basis: 'territory-state',
      reachableOnly: false,
      radius: null,
      perceivedThreatAnimalIds: [],
      perceivedPreyIds: [],
      perceivedPersonIds: [],
    } : {
      basis: intent.mode === 'defend' ? 'month-opening-co-location' : 'local-reachable-perception',
      reachableOnly: true,
      radius: intent.mode === 'defend' ? 0
        : intent.mode === 'flee' ? HERBIVORE_DANGER_RADIUS
          : WOLF_PERCEPTION_RADIUS,
      perceivedThreatAnimalIds: intent.perceivedThreatAnimalIds ?? [],
      perceivedPreyIds: intent.perceivedPreyIds ?? [],
      perceivedPersonIds: intent.perceivedPersonIds ?? [],
    },
    territory: animal.ecology.territory ? { ...animal.ecology.territory, enforced: true } : null,
    pack: animal.ecology.packId ? {
      packId: animal.ecology.packId,
      cueSourceAnimalId: animal.ecology.lastSeenCue?.sourceAnimalId,
      cueExpiresAtMonth: animal.ecology.lastSeenCue?.expiresAtMonth,
      sharedWithinRadius: PACK_CUE_SHARE_RADIUS,
      sharingRenewsCue: false,
    } : null,
    targetSelection: intent.targetSelectionBasis ? {
      selectedPersonId: intent.targetPersonId,
      ...intent.targetSelectionBasis,
    } : intent.mode === 'hunt-prey' ? {
      selectedAnimalId: intent.targetAnimalId,
      candidateAnimalIds: intent.perceivedPreyIds ?? [],
      order: 'reachable-distance-asc,id-asc',
    } : intent.mode === 'pursue-human' && intent.sourceCueObservedAtMonth !== undefined ? {
      selectedPersonId: intent.targetPersonId,
      order: 'unexpired-pack-cue-observed-desc,source-id-asc,target-id-asc',
    } : intent.mode === 'flee' || intent.mode === 'avoid-humans' ? {
      selectedCellId: intent.targetCellId,
      order: 'minimum-threat-distance-desc,reachable-distance-desc,cell-id-asc',
    } : intent.mode === 'territory-return' ? {
      selectedCellId: intent.targetCellId,
      order: 'territory-anchor',
    } : null,
  };
}

function applyAnimalAttack(
  state: SimulationState,
  atMonth: number,
  events: EnvironmentFact[],
  animal: AnimalState,
  victim: PersonState,
  intent: WildlifeIntent,
  opening: WildlifeAnimalSnapshot,
): void {
  const species = animalSpecies(animal.speciesId);
  const chance = species.aggression / 180;
  if (seededFraction(state.seed, `predator-attack:${atMonth}:${animal.id}:${victim.id}`) >= chance) return;
  const damage = 6 + Math.floor(species.aggression / 11);
  const healthBefore = victim.body.health;
  victim.body.health = clamp(victim.body.health - damage);
  const wound = victim.conditions.find((condition) => condition.kind === 'wound');
  const woundStageBefore = wound?.stage ?? 0;
  if (wound) wound.stage = Math.min(3, wound.stage + 1) as 1 | 2 | 3;
  else victim.conditions.push({
    id: `condition-wound-animal-${victim.id}-${atMonth}`,
    kind: 'wound',
    stage: 2,
    sinceMonth: atMonth,
    sourceEventIds: [],
  });
  const fact = animalEvent(state, atMonth, events, animal, `${species.name}袭击${victim.name}并造成伤害`, {
    process: 'attack-human',
    victimId: victim.id,
    damage,
    healthBefore,
    healthAfter: victim.body.health,
    woundStageBefore,
    woundStageAfter: wound?.stage ?? 2,
    monthOpeningCoLocated: opening.cellId === victim.position.cellId && opening.z === victim.position.z,
    attackEligibility: 'month-opening-contact-only',
    targetSelection: intent.targetSelectionBasis ? {
      selectedPersonId: victim.id,
      ...intent.targetSelectionBasis,
    } : { selectedPersonId: victim.id, order: 'reachable-distance-asc,wound-desc,health-asc,visible-defense-asc,id-asc' },
    perception: {
      reachableOnly: true,
      radius: WOLF_PERCEPTION_RADIUS,
      perceivedPersonIds: intent.perceivedPersonIds ?? [],
    },
    territory: animal.ecology.territory ? { ...animal.ecology.territory, enforced: true } : null,
    packId: animal.ecology.packId,
  }, victim);
  const affectedWound = wound ?? victim.conditions.find((candidate) => candidate.id === `condition-wound-animal-${victim.id}-${atMonth}`);
  if (affectedWound) affectedWound.sourceEventIds = [...new Set([...affectedWound.sourceEventIds, fact.id])];
}

function applyBoarDefensiveAttack(
  state: SimulationState,
  atMonth: number,
  events: EnvironmentFact[],
  animal: AnimalState,
  victim: PersonState,
  intent: WildlifeIntent,
  opening: WildlifeAnimalSnapshot,
): void {
  const species = animalSpecies(animal.speciesId);
  const chance = species.aggression / 240;
  if (seededFraction(state.seed, `animal-attack:${atMonth}:${animal.id}:${victim.id}`) >= chance) return;
  const damage = 4 + Math.floor(species.aggression / 14);
  const healthBefore = victim.body.health;
  victim.body.health = clamp(victim.body.health - damage);
  const wound = victim.conditions.find((condition) => condition.kind === 'wound');
  const woundStageBefore = wound?.stage ?? 0;
  if (wound) wound.stage = Math.min(3, wound.stage + 1) as 1 | 2 | 3;
  else victim.conditions.push({
    id: `condition-wound-animal-${victim.id}-${atMonth}`,
    kind: 'wound',
    stage: 1,
    sinceMonth: atMonth,
    sourceEventIds: [],
  });
  const fact = animalEvent(state, atMonth, events, animal, `${species.name}在被近身时冲撞${victim.name}并造成伤害`, {
    process: 'attack-human',
    behavior: 'defensive-charge',
    victimId: victim.id,
    damage,
    healthBefore,
    healthAfter: victim.body.health,
    woundStageBefore,
    woundStageAfter: wound?.stage ?? 1,
    monthOpeningCoLocated: opening.cellId === victim.position.cellId && opening.z === victim.position.z,
    attackEligibility: 'month-opening-contact-only',
    pursuit: false,
    targetSelection: intent.targetSelectionBasis ? {
      selectedPersonId: victim.id,
      ...intent.targetSelectionBasis,
    } : { selectedPersonId: victim.id, order: 'reachable-distance-asc,wound-desc,health-asc,visible-defense-asc,id-asc' },
    perception: {
      reachableOnly: true,
      radius: 0,
      perceivedPersonIds: intent.perceivedPersonIds ?? [],
    },
  }, victim);
  const affectedWound = wound ?? victim.conditions.find((candidate) => candidate.id === `condition-wound-animal-${victim.id}-${atMonth}`);
  if (affectedWound) affectedWound.sourceEventIds = [...new Set([...affectedWound.sourceEventIds, fact.id])];
}

/**
 * Local threat ecology is resolved in phases: physiology, immutable opening
 * perception/intent, movement, then contacts and attacks. Stable ID ordering is
 * only a commit order and cannot change any animal's intent.
 */
export function advanceAnimals(state: SimulationState, atMonth: number, events: EnvironmentFact[]): void {
  normalizeAnimalEcologies(state.world.animals);
  const physiologicalOrder = state.world.animals.filter(isAnimalAlive)
    .sort((first, second) => first.id.localeCompare(second.id));
  for (const animal of physiologicalOrder) {
    const species = animalSpecies(animal.speciesId);
    animal.hunger = Math.min(120, animal.hunger + species.hungerPerMonth + (state.civilization.weather.kind === 'drought' ? 2 : 0));
    if (animalAgeMonths(animal, atMonth) > animal.lifespanMonths) {
      const agePressure = (animalAgeMonths(animal, atMonth) - animal.lifespanMonths) / 24;
      if (seededFraction(state.seed, `animal-aging:${atMonth}:${animal.id}`) < Math.min(0.7, 0.08 + agePressure)) {
        killAnimal(state, animal, atMonth, events, 'aging');
        continue;
      }
    }
    if (animal.hunger >= 100) animal.health = Math.max(0, animal.health - 9);
    if (animal.health <= 0) killAnimal(state, animal, atMonth, events, 'starvation');
  }

  const livingAtOpening = state.world.animals.filter(isAnimalAlive)
    .sort((first, second) => first.id.localeCompare(second.id));
  const animalSnapshots = livingAtOpening.map(wildlifeAnimalSnapshot);
  const peopleAtOpening = state.people.filter(isAlive).sort((first, second) => first.id.localeCompare(second.id));
  const personSnapshots = peopleAtOpening.map((person) => wildlifePersonSnapshot(
    person,
    Boolean(shelterGeometryAt(state.world.grid, person.position)),
  ));
  const openingAnimalById = new Map(animalSnapshots.map((animal) => [animal.id, animal]));
  const openingPersonById = new Map(personSnapshots.map((person) => [person.id, person]));

  const cues = synchronizeWolfPackCues(state, atMonth, animalSnapshots, personSnapshots);
  for (const animal of livingAtOpening.filter((candidate) => candidate.speciesId === 'wolf')) {
    const prior = animal.ecology.lastSeenCue;
    const next = cues.get(animal.id);
    if (next) animal.ecology.lastSeenCue = structuredClone(next);
    else delete animal.ecology.lastSeenCue;
    if (next && next.sourceAnimalId === animal.id
      && (!prior || prior.observedAtMonth !== next.observedAtMonth
        || prior.targetId !== next.targetId || prior.cellId !== next.cellId)) {
      animalEvent(state, atMonth, events, animal, `狼在局部可达范围内留下了一条直接目击线索`, {
        process: 'observe-last-seen-cue',
        intentPhase: 'month-opening-snapshot',
        targetKind: next.kind,
        targetId: next.targetId,
        targetCellId: next.cellId,
        observedAtMonth: next.observedAtMonth,
        expiresAtMonth: next.expiresAtMonth,
        perception: { reachableOnly: true, radius: WOLF_PERCEPTION_RADIUS },
        territory: animal.ecology.territory ? { ...animal.ecology.territory, enforced: true } : null,
        pack: { packId: animal.ecology.packId, sourceAnimalId: animal.id },
        targetSelection: {
          selectedPersonId: next.targetId,
          order: 'reachable-distance-asc,wound-desc,health-asc,visible-defense-asc,id-asc',
        },
      });
    } else if (next && next.sourceAnimalId !== animal.id
      && (!prior || prior.observedAtMonth !== next.observedAtMonth || prior.sourceAnimalId !== next.sourceAnimalId)) {
      animalEvent(state, atMonth, events, animal, `狼群成员共享了未续期的近距目击线索`, {
        process: 'share-pack-last-seen-cue',
        intentPhase: 'month-opening-snapshot',
        packId: animal.ecology.packId,
        receiverAnimalId: animal.id,
        sourceAnimalId: next.sourceAnimalId,
        targetKind: next.kind,
        targetId: next.targetId,
        targetCellId: next.cellId,
        observedAtMonth: next.observedAtMonth,
        expiresAtMonth: next.expiresAtMonth,
        shareRadius: PACK_CUE_SHARE_RADIUS,
        renewedBySharing: false,
        perception: { reachableOnly: true, radius: PACK_CUE_SHARE_RADIUS, sourceAnimalId: next.sourceAnimalId },
        territory: animal.ecology.territory ? { ...animal.ecology.territory, enforced: true } : null,
        targetSelection: {
          selectedPersonId: next.targetId,
          order: 'direct-source-only,cue-observed-desc,source-id-asc,target-id-asc',
        },
      });
    } else if (prior && !next) {
      animalEvent(state, atMonth, events, animal, `狼停止使用一条已经过期的最后目击线索`, {
        process: 'expire-last-seen-cue',
        expiredTargetKind: prior.kind,
        expiredTargetId: prior.targetId,
        expiredCellId: prior.cellId,
        observedAtMonth: prior.observedAtMonth,
        expiresAtMonth: prior.expiresAtMonth,
        expiredWithoutRenewal: true,
        packId: animal.ecology.packId,
      });
    }
  }

  const intents = planWildlifeIntents(state, atMonth, animalSnapshots, personSnapshots, cues);
  const intentByAnimalId = new Map(intents.map((intent) => [intent.animalId, intent]));

  // Movement phase: every target was frozen above, before any animal moved.
  for (const animal of livingAtOpening) {
    const intent = intentByAnimalId.get(animal.id);
    const opening = openingAnimalById.get(animal.id);
    if (!intent || !opening) continue;
    animal.ecology.currentBehavior = behaviorFromIntent(atMonth, intent);
    moveAnimal(state, animal, intent.targetCellId, atMonth);
    if (intent.mode === 'pursue-human'
      || intent.mode === 'flee'
      || intent.mode === 'defend'
      || intent.mode === 'avoid-humans'
      || intent.mode === 'territory-return'
      || intent.mode === 'hunt-prey') {
      animalEvent(state, atMonth, events, animal, intent.mode === 'pursue-human'
        ? intent.sourceCueObservedAtMonth !== undefined
          ? `${animalSpecies(animal.speciesId).name}基于未续期的狼群最后目击线索追踪一名人类`
          : `${animalSpecies(animal.speciesId).name}基于局部可达感知追踪一名人类`
        : intent.mode === 'flee'
          ? `${animalSpecies(animal.speciesId).name}从局部威胁旁逃离`
          : intent.mode === 'defend'
            ? `饥饿的野猪在被近身时作出防御性冲撞姿态`
            : intent.mode === 'avoid-humans'
              ? `低健康的狼避开了可见的持械人群`
              : intent.mode === 'territory-return'
                ? `狼转向自己的领地边界以内`
                : `狼追踪局部可达的自然猎物`,
      behaviorEventDiff(animal, intent, opening));
    }
  }

  // Settlement phase: contacts use final positions, but attack permission was
  // frozen from month-opening co-location and cannot be created by this move.
  for (const animal of livingAtOpening) {
    if (!isAnimalAlive(animal)) continue;
    const intent = intentByAnimalId.get(animal.id);
    const opening = openingAnimalById.get(animal.id);
    if (!intent || !opening) continue;
    const species = animalSpecies(animal.speciesId);
    if (species.diet === 'herbivore') {
      if (intent.mode === 'defend' && intent.attackEligiblePersonId) {
        const victim = state.people.find((person) => person.id === intent.attackEligiblePersonId && isAlive(person));
        const victimOpening = openingPersonById.get(intent.attackEligiblePersonId);
        if (victim && victimOpening
          && animal.position.cellId === victim.position.cellId
          && animal.position.z === victim.position.z
          && opening.cellId === victimOpening.cellId
          && opening.z === victimOpening.z
          && !shelterGeometryAt(state.world.grid, victim.position)) {
          applyBoarDefensiveAttack(state, atMonth, events, animal, victim, intent, opening);
        }
        continue;
      }
      const food = surfaceMaterial(state.world.grid, animal.position.cellId);
      if (wildlifeEdiblePlant(food) && animal.hunger >= 34) {
        const replacement = food === Material.BerryBush ? Material.Shrub
          : food === Material.CropMature || food === Material.CropSprout ? Material.ExhaustedSoil
            : food === Material.Shrub ? Material.Soil : Material.Grass;
        if (replacement !== food) setVoxel(state.world.grid, cellX(animal.position.cellId), cellY(animal.position.cellId), topZ(state.world.grid, animal.position.cellId), replacement);
        animal.hunger = Math.max(0, animal.hunger - (food === Material.CropMature || food === Material.BerryBush ? 58 : 36));
        animal.lastAteAtMonth = atMonth;
        if (food === Material.CropMature || food === Material.CropSprout || food === Material.BerryBush) {
          animalEvent(state, atMonth, events, animal, `${species.name}取食并改变了一处植物地表`, {
            process: 'forage', fromMaterialId: food, toMaterialId: replacement,
          });
        }
      }
      continue;
    }

    if (intent.mode === 'hunt-prey' && intent.targetAnimalId) {
      const prey = state.world.animals.find((candidate) => candidate.id === intent.targetAnimalId && isAnimalAlive(candidate));
      if (prey && prey.position.cellId === animal.position.cellId && animal.hunger >= 45) {
        const chance = Math.min(0.82, 0.38 + (species.aggression - animalSpecies(prey.speciesId).evasion) / 180);
        if (seededFraction(state.seed, `animal-hunt:${atMonth}:${animal.id}:${prey.id}`) < chance) {
          killAnimal(state, prey, atMonth, events, 'predation', animal.id);
          animal.hunger = Math.max(0, animal.hunger - 72);
          animal.lastAteAtMonth = atMonth;
        }
      }
      continue;
    }

    if (intent.mode !== 'pursue-human' || !intent.targetPersonId) continue;
    const victim = state.people.find((person) => person.id === intent.targetPersonId && isAlive(person));
    const victimOpening = openingPersonById.get(intent.targetPersonId);
    if (!victim || !victimOpening || shelterGeometryAt(state.world.grid, victim.position)) continue;
    const reached = animal.position.cellId === victim.position.cellId && animal.position.z === victim.position.z;
    if (reached && opening.cellId !== victimOpening.cellId) {
      animal.ecology.pursuitContact = { targetPersonId: victim.id, atMonth, cellId: victim.position.cellId };
      animalEvent(state, atMonth, events, animal, `狼追到${victim.name}的近身位置，但本月只形成接触`, {
        process: 'pursuit-contact',
        targetPersonId: victim.id,
        intentPhase: 'month-opening-snapshot',
        contactPhase: 'post-movement-settlement',
        monthOpeningDistance: animalDistance(opening.cellId, victimOpening.cellId),
        attackAuthorizedThisMonth: false,
        nextMonthEscapeWindow: true,
        packId: animal.ecology.packId,
        territory: animal.ecology.territory ? { ...animal.ecology.territory, enforced: true } : null,
      }, victim);
    }
    if (reached && intent.attackEligiblePersonId === victim.id
      && opening.cellId === victimOpening.cellId && opening.z === victimOpening.z) {
      applyAnimalAttack(state, atMonth, events, animal, victim, intent, opening);
    }
  }
  advanceAnimalBirths(state, atMonth, events);
}
