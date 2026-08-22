import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-local-threat-ecology-'));
const bundlePath = path.join(temporaryDirectory, 'local-threat-ecology.mjs');

try {
  const entry = `
    export { createInitialState, restoreSimulationState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export { advanceAnimals } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/monthly-processes.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { seededFraction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/generator.ts'))};
    export {
      WILDLIFE_ECOLOGY_VERSION,
      WOLF_HUMAN_PURSUIT_HUNGER,
      WOLF_TERRITORY_RADIUS,
      animalCellDistance,
      createInitialAnimalEcology,
      planWildlifeIntents,
      reachableWildlifeCells,
      selectStableHumanTarget,
      synchronizeWolfPackCues,
      wildlifeAnimalSnapshot,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/wildlife-ecology.ts'))};
    export { cellId, cellX, cellY, cellsInRadius, setVoxel, surfaceStandingPosition } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=local-threat-ecology-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    WILDLIFE_ECOLOGY_VERSION,
    WOLF_HUMAN_PURSUIT_HUNGER,
    WOLF_TERRITORY_RADIUS,
    advanceAnimals,
    animalCellDistance,
    cellId,
    cellX,
    cellY,
    cellsInRadius,
    createInitialAnimalEcology,
    createInitialState,
    planWildlifeIntents,
    reachableWildlifeCells,
    restoreSimulationState,
    seededFraction,
    selectStableHumanTarget,
    setVoxel,
    surfaceStandingPosition,
    synchronizeWolfPackCues,
    wildlifeAnimalSnapshot,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  function flatten(state, center, radius = 15) {
    for (const localCell of cellsInRadius(center, radius)) {
      const x = cellX(localCell);
      const y = cellY(localCell);
      for (let z = 0; z < state.world.grid.levels; z += 1) {
        setVoxel(state.world.grid, x, y, z, z === 0 ? Material.PackedSoil : Material.Air);
      }
    }
  }

  function placePerson(person, cell, { health = 90, woundStage = 0, armed = false } = {}) {
    person.position = {
      ...person.position,
      cellId: cell,
      z: 1,
      previousCellId: cell,
      previousZ: 1,
      lastPath: [cell],
      tickPath: [cell],
    };
    delete person.diedAtMonth;
    person.body = { health, hydration: 90, nutrition: 90 };
    person.conditions = woundStage ? [{
      id: `test-wound:${person.id}`,
      kind: 'wound',
      stage: woundStage,
      sinceMonth: 1,
      sourceEventIds: [],
    }] : [];
    person.inventory = armed ? [{
      id: `test-spear:${person.id}`,
      materialId: Material.Spear,
      quantity: 1,
      sourceEventIds: [],
    }] : [];
  }

  function animal(speciesId, id, cell, options = {}) {
    const ecology = createInitialAnimalEcology(speciesId, id, options.territoryAnchor ?? cell, options.packId);
    if (options.territoryRadius !== undefined && ecology.territory) ecology.territory.radius = options.territoryRadius;
    return {
      id,
      speciesId,
      sex: options.sex ?? 'male',
      bornAtMonth: 0,
      lifespanMonths: 240,
      geneticParents: options.geneticParents ?? [],
      position: { cellId: cell, z: 1, previousCellId: cell, previousZ: 1 },
      health: options.health ?? 90,
      hunger: options.hunger ?? 96,
      lastAteAtMonth: 0,
      ecology,
    };
  }

  function personSnapshot(person, { sheltered = false } = {}) {
    return {
      id: person.id,
      cellId: person.position.cellId,
      z: person.position.z,
      health: person.body.health,
      woundStage: person.conditions.filter((condition) => condition.kind === 'wound')
        .reduce((maximum, condition) => Math.max(maximum, condition.stage), 0),
      armed: person.inventory.some((stack) => stack.materialId === Material.Spear && stack.quantity > 0),
      sheltered,
    };
  }

  function fixture(seed = 20_260_820) {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 12;
    state.world.past = [];
    state.world.drops = [];
    state.world.animals = [];
    state.civilization.weather = { kind: 'clear', intensity: 1, sinceMonth: 12 };
    const center = cellId(42, 26);
    flatten(state, center);
    for (const person of state.people) person.diedAtMonth = 0;
    return { state, center, atMonth: 13 };
  }

  // New worlds contain exactly two two-wolf packs. Packmates start near one
  // another and share a territory anchor; the two pack identities are distinct.
  {
    const state = createInitialState(20_260_821);
    const wolves = state.world.animals.filter((candidate) => candidate.speciesId === 'wolf');
    assert.equal(wolves.length, 4);
    const packs = Map.groupBy(wolves, (candidate) => candidate.ecology.packId);
    assert.deepEqual([...packs.keys()].sort(), ['wolf-pack-a', 'wolf-pack-b']);
    for (const members of packs.values()) {
      assert.equal(members.length, 2);
      assert.ok(animalCellDistance(members[0].position.cellId, members[1].position.cellId) <= 2);
      assert.equal(reachableWildlifeCells(
        state.world.grid,
        { cellId: members[0].position.cellId, z: members[0].position.z },
        2,
      ).has(members[1].position.cellId), true);
      assert.equal(members[0].ecology.territory.anchorCellId, members[1].ecology.territory.anchorCellId);
      assert.equal(members[0].ecology.territory.radius, WOLF_TERRITORY_RADIUS);
    }
  }

  // Reachable shortest-path distance, not Manhattan distance through an
  // obstacle, determines which locally visible person is pursued.
  {
    const { state, center, atMonth } = fixture();
    const pathNear = state.people[0];
    const pathFar = state.people[1];
    placePerson(pathNear, center + 2);
    placePerson(pathFar, center + state.world.grid.width * 3);
    setVoxel(state.world.grid, cellX(center + 1), cellY(center + 1), 0, Material.Water);
    const wolf = animal('wolf', 'wolf-path-choice', center, { packId: 'pack-path', hunger: 110 });
    const animals = [wildlifeAnimalSnapshot(wolf)];
    const people = [personSnapshot(pathNear), personSnapshot(pathFar)];
    const reachable = reachableWildlifeCells(state.world.grid, { cellId: center, z: 1 }, 6, wolf.ecology.territory);
    assert.ok(reachable.get(pathNear.position.cellId) > reachable.get(pathFar.position.cellId));
    const cues = synchronizeWolfPackCues(state, atMonth, animals, people);
    const intent = planWildlifeIntents(state, atMonth, animals, people, cues)[0];
    assert.equal(intent.targetPersonId, pathFar.id);
  }

  // Legacy schema-17 animals receive deterministic ecology, and a wolf pup
  // inherits its parent's pack and territory rather than getting a remote pack.
  {
    const source = createInitialState(20_260_822);
    const mother = source.world.animals.find((candidate) => candidate.speciesId === 'wolf' && candidate.sex === 'female');
    const pup = animal('wolf', 'animal-wolf-old-save-pup', mother.position.cellId, {
      sex: 'female', geneticParents: [mother.id], packId: 'temporary',
    });
    source.world.animals.push(pup);
    for (const candidate of source.world.animals) delete candidate.ecology;
    const first = restoreSimulationState(structuredClone(source));
    const secondInput = structuredClone(source);
    secondInput.world.animals.reverse();
    const second = restoreSimulationState(secondInput);
    const ecologyById = (state) => Object.fromEntries(state.world.animals
      .map((candidate) => [candidate.id, candidate.ecology])
      .sort(([firstId], [secondId]) => firstId.localeCompare(secondId)));
    assert.deepEqual(ecologyById(first), ecologyById(second));
    const founderWolves = first.world.animals
      .filter((candidate) => /^animal-wolf-[0-3]$/.test(candidate.id))
      .sort((left, right) => left.id.localeCompare(right.id));
    assert.deepEqual(founderWolves.map((candidate) => candidate.ecology.packId), [
      'wolf-pack-a', 'wolf-pack-a', 'wolf-pack-b', 'wolf-pack-b',
    ]);
    assert.equal(founderWolves[0].ecology.territory.anchorCellId, founderWolves[1].ecology.territory.anchorCellId);
    assert.equal(founderWolves[2].ecology.territory.anchorCellId, founderWolves[3].ecology.territory.anchorCellId);
    const restoredMother = first.world.animals.find((candidate) => candidate.id === mother.id);
    const restoredPup = first.world.animals.find((candidate) => candidate.id === pup.id);
    assert.equal(restoredPup.ecology.packId, restoredMother.ecology.packId);
    assert.deepEqual(restoredPup.ecology.territory, restoredMother.ecology.territory);
    assert.equal(restoredPup.ecology.version, WILDLIFE_ECOLOGY_VERSION);
  }

  // Human pursuit requires extreme hunger, a locally reachable person and no
  // locally safe natural prey. A reachable deer wins before the human target.
  {
    const { state, center, atMonth } = fixture();
    const target = state.people[0];
    placePerson(target, center);
    const wolf = animal('wolf', 'wolf-choice', center + 4, { packId: 'pack-choice', hunger: WOLF_HUMAN_PURSUIT_HUNGER });
    state.world.animals = [wolf];
    const people = [personSnapshot(target)];
    let animals = [wildlifeAnimalSnapshot(wolf)];
    let cues = synchronizeWolfPackCues(state, atMonth, animals, people);
    let intent = planWildlifeIntents(state, atMonth, animals, people, cues)[0];
    assert.equal(intent.mode, 'pursue-human');
    assert.equal(intent.targetPersonId, target.id);

    wolf.hunger = WOLF_HUMAN_PURSUIT_HUNGER - 1;
    animals = [wildlifeAnimalSnapshot(wolf)];
    cues = synchronizeWolfPackCues(state, atMonth, animals, people);
    intent = planWildlifeIntents(state, atMonth, animals, people, cues)[0];
    assert.notEqual(intent.mode, 'pursue-human');

    wolf.hunger = 110;
    const deer = animal('deer', 'deer-safe', wolf.position.cellId - 1, { hunger: 40 });
    animals = [wildlifeAnimalSnapshot(wolf), wildlifeAnimalSnapshot(deer)];
    cues = synchronizeWolfPackCues(state, atMonth, animals, people);
    intent = planWildlifeIntents(state, atMonth, animals, people, cues)
      .find((candidate) => candidate.animalId === wolf.id);
    assert.equal(intent.mode, 'hunt-prey');
    assert.equal(intent.targetAnimalId, deer.id);
  }

  // Manhattan-near but physically sealed targets cannot be perceived. This is
  // a reachability test, not a distance-only visibility test.
  {
    const { state, center, atMonth } = fixture();
    const wolf = animal('wolf', 'wolf-sealed', center, { packId: 'pack-sealed', hunger: 110 });
    const target = state.people[0];
    placePerson(target, center + 2);
    for (const blocked of [center - 1, center + 1, center - state.world.grid.width, center + state.world.grid.width]) {
      setVoxel(state.world.grid, cellX(blocked), cellY(blocked), 0, Material.Water);
    }
    const animals = [wildlifeAnimalSnapshot(wolf)];
    const cues = synchronizeWolfPackCues(state, atMonth, animals, [personSnapshot(target)]);
    const intent = planWildlifeIntents(state, atMonth, animals, [personSnapshot(target)], cues)[0];
    assert.equal(cues.get(wolf.id), undefined);
    assert.notEqual(intent.mode, 'pursue-human');
    assert.equal(reachableWildlifeCells(state.world.grid, { cellId: center, z: 1 }, 6).has(target.position.cellId), false);
  }

  // Herbivores increase their separation from a visible wolf. A wounded wolf
  // instead retreats from a visible group containing an armed defender.
  {
    const { state, center, atMonth } = fixture();
    const deer = animal('deer', 'deer-flee', center, { hunger: 50 });
    const wolf = animal('wolf', 'wolf-danger', center + 2, { packId: 'pack-danger', hunger: 40 });
    let animals = [wildlifeAnimalSnapshot(deer), wildlifeAnimalSnapshot(wolf)];
    let intents = planWildlifeIntents(state, atMonth, animals, [], new Map());
    const flee = intents.find((candidate) => candidate.animalId === deer.id);
    assert.equal(flee.mode, 'flee');
    assert.ok(animalCellDistance(flee.targetCellId, wolf.position.cellId) > animalCellDistance(deer.position.cellId, wolf.position.cellId));

    const first = state.people[0];
    const second = state.people[1];
    placePerson(first, center, { armed: true });
    placePerson(second, center + 1);
    wolf.position.cellId = center + 3;
    wolf.health = 35;
    wolf.hunger = 110;
    animals = [wildlifeAnimalSnapshot(wolf)];
    const people = [personSnapshot(first), personSnapshot(second)];
    const cues = synchronizeWolfPackCues(state, atMonth, animals, people);
    intents = planWildlifeIntents(state, atMonth, animals, people, cues);
    assert.equal(intents[0].mode, 'avoid-humans');
    assert.ok(animalCellDistance(intents[0].targetCellId, center) > animalCellDistance(wolf.position.cellId, center));
  }

  // A herbivore fleeing only an armed person records that person as its exact
  // local pressure source in the replayable behavior event.
  {
    const { state, center, atMonth } = fixture();
    const armed = state.people[0];
    placePerson(armed, center + 1, { armed: true });
    const deer = animal('deer', 'deer-armed-person', center, { hunger: 40 });
    state.people = [armed];
    state.world.animals = [deer];
    const events = [];
    advanceAnimals(state, atMonth, events);
    const flee = events.find((event) => event.diff.process === 'flee-threat');
    assert.ok(flee);
    assert.deepEqual(flee.diff.perception.perceivedPersonIds, [armed.id]);
    assert.deepEqual(flee.diff.perception.perceivedThreatAnimalIds, []);
  }

  // Co-located victim choice is stable under input reordering and uses visible
  // wounds, health, visible defense, and finally ID.
  {
    const people = [
      { id: 'armed-critical', cellId: 1, z: 1, health: 20, woundStage: 3, armed: true, sheltered: false },
      { id: 'healthy', cellId: 1, z: 1, health: 90, woundStage: 0, armed: false, sheltered: false },
      { id: 'wounded-b', cellId: 1, z: 1, health: 45, woundStage: 2, armed: false, sheltered: false },
      { id: 'wounded-a', cellId: 1, z: 1, health: 45, woundStage: 2, armed: false, sheltered: false },
    ];
    assert.equal(selectStableHumanTarget(people, people).id, 'armed-critical');
    assert.equal(selectStableHumanTarget([...people].reverse(), [...people].reverse()).id, 'armed-critical');
  }

  // A nearby packmate receives the original cue without renewing its timestamp;
  // sharing it again in a later month preserves the original expiry too.
  {
    const { state, center, atMonth } = fixture();
    const target = state.people[0];
    placePerson(target, center);
    const source = animal('wolf', 'wolf-cue-source', center + 6, { packId: 'pack-cue', hunger: 110, territoryAnchor: center + 6 });
    const receiver = animal('wolf', 'wolf-cue-receiver', center + 9, { packId: 'pack-cue', hunger: 110, territoryAnchor: center + 6 });
    const relayOnly = animal('wolf', 'wolf-cue-relay-only', center + 12, { packId: 'pack-cue', hunger: 110, territoryAnchor: center + 6 });
    let snapshots = [wildlifeAnimalSnapshot(source), wildlifeAnimalSnapshot(receiver), wildlifeAnimalSnapshot(relayOnly)];
    const first = synchronizeWolfPackCues(state, atMonth, snapshots, [personSnapshot(target)]);
    assert.equal(first.get(source.id).sourceAnimalId, source.id);
    assert.equal(first.get(receiver.id).sourceAnimalId, source.id);
    assert.equal(first.get(receiver.id).observedAtMonth, atMonth);
    assert.equal(first.get(receiver.id).expiresAtMonth, atMonth + 3);
    assert.equal(first.get(relayOnly.id), undefined, '同月共享不得从接收者继续多跳转发');
    source.ecology.lastSeenCue = structuredClone(first.get(source.id));
    receiver.ecology.lastSeenCue = structuredClone(first.get(receiver.id));
    snapshots = [wildlifeAnimalSnapshot(source), wildlifeAnimalSnapshot(receiver), wildlifeAnimalSnapshot(relayOnly)];
    const relayed = synchronizeWolfPackCues(state, atMonth + 1, snapshots, []);
    assert.equal(relayed.get(receiver.id).observedAtMonth, atMonth);
    assert.equal(relayed.get(receiver.id).expiresAtMonth, atMonth + 3);
    assert.equal(relayed.get(relayOnly.id), undefined, '旧共享线索也不得成为新的转发源');
  }

  // A hungry boar may defend itself only against people already sharing its
  // month-opening cell. It uses the same stable victim order and never pursues.
  {
    const { state, center, atMonth } = fixture();
    const healthy = state.people[0];
    const wounded = state.people[1];
    placePerson(healthy, center, { health: 90 });
    placePerson(wounded, center, { health: 55, woundStage: 2 });
    const boar = animal('boar', 'boar-defend', center, { hunger: 82 });
    state.people = [healthy, wounded];
    state.world.animals = [boar];
    let attackSeed = 1;
    while (seededFraction(attackSeed, `animal-attack:${atMonth}:${boar.id}:${wounded.id}`) >= 42 / 240) attackSeed += 1;
    state.seed = attackSeed;
    const events = [];
    advanceAnimals(state, atMonth, events);
    assert.equal(boar.ecology.currentBehavior.mode, 'defend');
    assert.equal(boar.ecology.currentBehavior.targetPersonId, wounded.id);
    const attack = events.find((event) => event.diff.process === 'attack-human');
    assert.ok(attack);
    assert.equal(attack.diff.behavior, 'defensive-charge');
    assert.equal(attack.diff.victimId, wounded.id);
    assert.equal(attack.diff.healthBefore, 55);
    assert.equal(attack.diff.healthAfter, 48);
    assert.equal(attack.diff.woundStageBefore, 2);
    assert.equal(attack.diff.woundStageAfter, 3);
    assert.equal(attack.diff.monthOpeningCoLocated, true);
    assert.equal(events.some((event) => event.diff.process === 'pursuit-human'), false);
    assert.ok(wounded.conditions.find((condition) => condition.kind === 'wound').sourceEventIds.includes(attack.id));
  }

  // Random wandering cannot cross a cliff higher than one standing level.
  {
    const { state, center, atMonth } = fixture();
    const wolf = animal('wolf', 'wolf-cliff', center, { packId: 'pack-cliff', hunger: 10 });
    const neighbors = [center - 1, center + 1, center - state.world.grid.width, center + state.world.grid.width];
    for (const candidate of neighbors) setVoxel(state.world.grid, cellX(candidate), cellY(candidate), 0, Material.Water);
    for (let z = 0; z <= 3; z += 1) setVoxel(state.world.grid, cellX(center + 1), cellY(center + 1), z, Material.PackedSoil);
    state.world.animals = [wolf];
    state.people = [];
    advanceAnimals(state, atMonth, []);
    assert.equal(wolf.position.cellId, center);
    assert.equal(wolf.position.z, 1);
  }

  // Crossing the final pursuit cells creates replayable contact but no same-
  // month attack. Only a wolf already co-located in the next opening snapshot
  // may settle the retained attack-human process.
  {
    const { state, center, atMonth } = fixture();
    const target = state.people[0];
    placePerson(target, center, { health: 90 });
    const wolf = animal('wolf', 'wolf-contact', center + 3, { packId: 'pack-contact', hunger: 100 });
    state.world.animals = [wolf];
    state.people = [target];
    const firstEvents = [];
    advanceAnimals(state, atMonth, firstEvents);
    assert.equal(wolf.position.cellId, center);
    assert.equal(wolf.ecology.currentBehavior.mode, 'pursue-human');
    const contact = firstEvents.find((event) => event.diff.process === 'pursuit-contact');
    assert.ok(contact);
    assert.equal(contact.diff.attackAuthorizedThisMonth, false);
    assert.equal(firstEvents.some((event) => event.diff.process === 'attack-human'), false);
    const pursuit = firstEvents.find((event) => event.diff.process === 'pursuit-human');
    assert.equal(pursuit.diff.intentPhase, 'month-opening-snapshot');
    assert.equal(pursuit.diff.perception.reachableOnly, true);
    assert.equal(pursuit.diff.territory.enforced, true);
    assert.equal(pursuit.diff.pack.sharingRenewsCue, false);
    assert.equal(pursuit.diff.targetSelection.order, 'reachable-distance-asc,wound-desc,health-asc,visible-defense-asc,id-asc');

    let attackSeed = 1;
    while (seededFraction(attackSeed, `predator-attack:${atMonth + 1}:${wolf.id}:${target.id}`) >= 68 / 180) attackSeed += 1;
    state.seed = attackSeed;
    const secondEvents = [];
    advanceAnimals(state, atMonth + 1, secondEvents);
    const attack = secondEvents.find((event) => event.diff.process === 'attack-human');
    assert.ok(attack);
    assert.equal(attack.diff.monthOpeningCoLocated, true);
    assert.equal(attack.diff.attackEligibility, 'month-opening-contact-only');
    assert.equal(attack.diff.healthBefore, 90);
    assert.equal(attack.diff.healthAfter, 78);
    assert.equal(attack.diff.woundStageBefore, 0);
    assert.equal(attack.diff.woundStageAfter, 2);
  }

  // Animal/person array order cannot affect month-opening intents or outcomes.
  {
    const build = () => {
      const { state, center, atMonth } = fixture();
      const firstPerson = state.people[0];
      const secondPerson = state.people[1];
      placePerson(firstPerson, center, { health: 60, woundStage: 1 });
      placePerson(secondPerson, center, { health: 90, armed: true });
      state.people = [firstPerson, secondPerson];
      state.world.animals = [
        animal('wolf', 'wolf-order-b', center + 3, { packId: 'pack-order', hunger: 100 }),
        animal('wolf', 'wolf-order-a', center + 4, { packId: 'pack-order', hunger: 100 }),
      ];
      return { state, atMonth };
    };
    const first = build();
    const second = build();
    second.state.world.animals.reverse();
    second.state.people.reverse();
    const firstEvents = [];
    const secondEvents = [];
    advanceAnimals(first.state, first.atMonth, firstEvents);
    advanceAnimals(second.state, second.atMonth, secondEvents);
    const animalsById = (state) => state.world.animals.map((candidate) => ({
      id: candidate.id,
      cellId: candidate.position.cellId,
      health: candidate.health,
      hunger: candidate.hunger,
      ecology: candidate.ecology,
    })).sort((left, right) => left.id.localeCompare(right.id));
    const peopleById = (state) => state.people.map((candidate) => ({
      id: candidate.id,
      health: candidate.body.health,
      conditions: candidate.conditions,
    })).sort((left, right) => left.id.localeCompare(right.id));
    assert.deepEqual(animalsById(first.state), animalsById(second.state));
    assert.deepEqual(peopleById(first.state), peopleById(second.state));
    assert.deepEqual(firstEvents.map((event) => ({ result: event.result, diff: event.diff })),
      secondEvents.map((event) => ({ result: event.result, diff: event.diff })));
  }

  // A wolf on its boundary never selects or moves to an out-of-territory human.
  {
    const { state, center, atMonth } = fixture();
    const anchor = center;
    const boundary = center + 2;
    const outside = center + 3;
    const target = state.people[0];
    placePerson(target, outside);
    const wolf = animal('wolf', 'wolf-boundary', boundary, {
      packId: 'pack-boundary', hunger: 110, territoryAnchor: anchor, territoryRadius: 2,
    });
    state.world.animals = [wolf];
    state.people = [target];
    const events = [];
    advanceAnimals(state, atMonth, events);
    assert.ok(animalCellDistance(wolf.position.cellId, anchor) <= 2);
    assert.notEqual(wolf.ecology.currentBehavior.targetPersonId, target.id);
  }

  console.log('local threat ecology tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
