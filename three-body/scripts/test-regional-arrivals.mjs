import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-regional-arrivals-'));
const bundlePath = path.join(temporaryDirectory, 'regional-arrivals.mjs');

try {
  const entry = `
    export { createInitialState, restoreSimulationState, stepSimulation, buildDecisionContexts } from ${JSON.stringify(path.resolve('src/game/eland/simulation.ts'))};
    export { eventProducesOrTransfersMaterial } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { cellX, cellY, isStandingPosition, setVoxel, WORLD_WIDTH, WORLD_DEPTH } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
    export { REGIONAL_ENTRY_CORRIDOR_RADIUS } from ${JSON.stringify(path.resolve('src/game/eland/application/regional-arrivals.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=regional-arrivals-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    buildDecisionContexts,
    cellX,
    cellY,
    createInitialState,
    eventProducesOrTransfersMaterial,
    isStandingPosition,
    Material,
    REGIONAL_ENTRY_CORRIDOR_RADIUS,
    restoreSimulationState,
    setVoxel,
    stepSimulation,
    WORLD_DEPTH,
    WORLD_WIDTH,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const seed = 374;
  const config = {
    civilizationNo: 374,
    endpoint: { kind: 'months', value: 1_200 },
    chaosIntensity: 0,
  };
  const initial = createInitialState(seed, config);
  const repeated = createInitialState(seed, config);
  assert.doesNotThrow(() => buildDecisionContexts(initial, 1),
    'genesis population source must be included before sealing the physical-structure history');
  assert.ok(initial.regionalPopulation?.sourceEventId);
  assert.deepEqual(initial.regionalPopulation, repeated.regionalPopulation,
    'the seed must fix the complete off-map roster, journeys, entries and dates at genesis');
  assert.equal(initial.people.length, 3, 'scheduled travelers are not local people before arrival');
  assert.ok(initial.people.every((person) => person.origin?.kind === 'founding'));
  const sourceFact = initial.world.past.find((event) => event.kind === 'population'
    && event.change === 'regional-source-established');
  assert.equal(sourceFact?.id, initial.regionalPopulation.sourceEventId);
  assert.equal(initial.regionalPopulation.journeys.length, 16);
  for (const journey of initial.regionalPopulation.journeys) {
    assert.ok(journey.expectedArrivalAtMonth > journey.departedAtMonth);
    assert.ok(journey.expectedArrivalAtMonth > 0);
    assert.ok(journey.traveler.carriedMaterials.length > 0);
    assert.ok(Array.isArray(journey.traveler.traits));
    assert.equal('cognition' in journey.traveler, false,
      'an off-map roster entry must not be a model-owning PersonState');
    const x = cellX(journey.entryPosition.cellId);
    const y = cellY(journey.entryPosition.cellId);
    assert.ok(x === 0 || y === 0 || x === WORLD_WIDTH - 1 || y === WORLD_DEPTH - 1,
      'every journey must terminate at a real world-edge cell');
  }

  const legacyFixture = (variant) => {
    const state = createInitialState(seed, config);
    delete state.regionalPopulation;
    state.world.past = state.world.past.filter((event) => event.kind !== 'population');
    state.world.historyCursor = {
      version: 1,
      eventCount: state.world.past.length,
      hotStartIndex: 0,
      tailEventId: state.world.past.at(-1)?.id ?? null,
    };
    state.clock.elapsedMonths = 55;
    state.lastStep = [];
    state.civilization.stage = variant === 'scarcity' ? '没有男性的小群体' : '现代都市';
    for (const person of state.people) {
      delete person.origin;
      person.sex = variant === 'scarcity' ? 'female' : 'male';
      person.conditions = variant === 'scarcity'
        ? [{
            id: `fixture-pregnancy:${person.id}`, kind: 'pregnancy', stage: 1,
            sinceMonth: 54, dueAtMonth: 63, sourceEventIds: ['fixture-pregnancy'],
          }]
        : [];
    }
    return state;
  };
  const restoredScarcity = restoreSimulationState(legacyFixture('scarcity'));
  const restoredAbundance = restoreSimulationState(legacyFixture('abundance'));
  assert.equal(restoredScarcity.people.length, 3,
    'restoring an old schema-19 civilization must not silently add a person');
  assert.deepEqual(restoredScarcity.regionalPopulation, restoredAbundance.regionalPopulation,
    'regional scheduling must not read local sex, pregnancy, stage, or a perceived shortage');
  assert.equal(restoredScarcity.regionalPopulation.establishedAtMonth, 55);
  assert.ok(restoredScarcity.regionalPopulation.journeys.every((journey) => journey.expectedArrivalAtMonth > 55));
  assert.equal(restoredScarcity.world.past.filter((event) => event.kind === 'population'
    && event.change === 'regional-arrival').length, 0);
  assert.equal(restoredScarcity.world.past.filter((event) => event.kind === 'population'
    && event.change === 'regional-source-established').length, 1,
  'restore first commits one explicit regional source fact and then waits for its journey');

  const endedLegacy = legacyFixture('scarcity');
  endedLegacy.civilization.status = 'ended';
  endedLegacy.civilization.outcome = {
    kind: 'boundary', cause: 'fixture-end', atMonth: 55, summary: 'fixture already ended',
  };
  const endedHistoryIds = endedLegacy.world.past.map((event) => event.id);
  const restoredEnded = restoreSimulationState(endedLegacy);
  assert.equal(restoredEnded.regionalPopulation, undefined,
    'restoring an ended legacy run must not establish a new off-map source');
  assert.deepEqual(restoredEnded.world.past.map((event) => event.id), endedHistoryIds,
    'restoring an ended run must not rewrite terminal history');

  const arrivalState = createInitialState(seed, config);
  const firstJourney = arrivalState.regionalPopulation.journeys[0];
  const arrivingPersonId = firstJourney.traveler.personId;
  arrivalState.clock.elapsedMonths = firstJourney.expectedArrivalAtMonth - 1;
  arrivalState.civilization.conditions.endpoint.value = firstJourney.expectedArrivalAtMonth + 12;
  arrivalState.world.animals = [];
  for (const person of arrivalState.people) {
    person.body = { health: 100, hydration: 100, nutrition: 100 };
    person.conditions = [];
  }
  const witness = arrivalState.people[0];
  witness.position = {
    ...witness.position,
    cellId: firstJourney.entryPosition.cellId,
    previousCellId: firstJourney.entryPosition.cellId,
    z: firstJourney.entryPosition.z,
    previousZ: firstJourney.entryPosition.z,
    lastPath: [firstJourney.entryPosition.cellId],
    tickPath: [firstJourney.entryPosition.cellId],
  };
  const modelSeenPersonIds = [];
  const idleDecider = {
    decide(context) {
      modelSeenPersonIds.push(context.person.id);
      return { kind: 'idle', reason: '聚焦测试中停留原地' };
    },
  };
  const arrivedState = stepSimulation(arrivalState, idleDecider);
  const arrivalFact = arrivedState.world.past.find((event) => event.kind === 'population'
    && event.change === 'regional-arrival'
    && event.journeyId === firstJourney.id);
  const arrived = arrivedState.people.find((person) => person.id === arrivingPersonId);
  assert.ok(arrivalFact && arrived);
  assert.equal(arrivedState.world.physicalStructureIndex?.appliedHistoryEventCount,
    arrivedState.world.historyCursor.eventCount,
  'month-end population facts must advance the authoritative structure fold seal even though they do not alter structures');
  assert.equal(arrivedState.world.physicalStructureIndex?.appliedTailEventId,
    arrivedState.world.historyCursor.tailEventId);
  assert.equal(arrivedState.clock.elapsedMonths, firstJourney.expectedArrivalAtMonth);
  assert.equal(modelSeenPersonIds.includes(arrivingPersonId), false,
    'the arriving traveler must not receive a model/local decision before the atomic month-end arrival');
  assert.equal(arrivedState.lastStep.some((event) => (event.kind === 'action' || event.kind === 'decision')
    && event.who === arrivingPersonId), false,
  'the new person cannot act in the month whose participant roster was already closed');
  assert.equal(arrived.origin?.kind, 'regional-arrival');
  assert.equal(arrived.origin?.journeyId, firstJourney.id);
  assert.ok(arrived.origin?.sourceEventIds.includes(arrivalFact.id));
  assert.ok(arrived.traits?.every((trait) => trait.sourceEventIds.includes(arrivalFact.id)));
  assert.ok(arrived.inventory.length > 0 && arrived.inventory.every((stack) => (
    stack.sourceEventIds.includes(arrivalFact.id)
      && stack.sourceLineageKeys?.some((key) => key.includes(arrivalFact.sourceCommunityId))
      && eventProducesOrTransfersMaterial(arrivalFact, stack.materialId)
  )), 'arrival-carried material must resolve to the population fact and a physical lineage key');
  assert.deepEqual(arrived.relations, [], 'arrival must not install automatic trust or bond');
  assert.equal(arrivedState.people.find((person) => person.id === witness.id)?.relations
    .some((relation) => relation.personId === arrived.id), false);
  assert.equal(arrivedState.collectives.some((collective) => collective.memberships
    .some((membership) => membership.personId === arrived.id)), false,
  'arrival must not install automatic collective membership');

  const encounter = arrivedState.world.past.find((event) => event.kind === 'population'
    && event.change === 'first-encounter'
    && event.personIds.includes(witness.id)
    && event.personIds.includes(arrived.id));
  assert.ok(encounter, 'mutual end-of-month visibility must produce a sourced first encounter');
  assert.ok(arrivedState.regionalPopulation.encounteredPairKeys.includes(
    [witness.id, arrived.id].sort().join('|'),
  ), 'the regional aggregate must remember the pair so long simulations cannot repeat the encounter');
  for (const personId of [witness.id, arrived.id]) {
    const person = arrivedState.people.find((candidate) => candidate.id === personId);
    assert.ok(person?.memories.some((memory) => memory.sourceEventIds.includes(encounter.id)),
      'both witnesses must retain the same first-encounter source without a relation mutation');
  }
  const nextMonthContexts = buildDecisionContexts(arrivedState, arrivedState.clock.elapsedMonths + 1);
  assert.ok(nextMonthContexts.some((context) => context.person.id === arrived.id),
    'the arrived person enters ordinary decision context construction on the following month');

  const rerouteState = createInitialState(seed, config);
  const rerouteJourney = rerouteState.regionalPopulation.journeys[0];
  const plannedEntry = { ...rerouteJourney.entryPosition };
  for (let z = 1; z < rerouteState.world.grid.levels; z += 1) {
    setVoxel(
      rerouteState.world.grid,
      cellX(plannedEntry.cellId),
      cellY(plannedEntry.cellId),
      z,
      Material.Stone,
    );
  }
  rerouteState.clock.elapsedMonths = rerouteJourney.expectedArrivalAtMonth - 1;
  rerouteState.civilization.conditions.endpoint.value = rerouteJourney.expectedArrivalAtMonth + 12;
  rerouteState.world.animals = [];
  for (const person of rerouteState.people) {
    person.body = { health: 100, hydration: 100, nutrition: 100 };
    person.conditions = [];
  }
  const rerouted = stepSimulation(rerouteState, idleDecider);
  const reroutedPerson = rerouted.people.find((person) => person.id === rerouteJourney.traveler.personId);
  const reroutedFact = rerouted.world.past.find((event) => event.kind === 'population'
    && event.change === 'regional-arrival'
    && event.journeyId === rerouteJourney.id);
  assert.ok(reroutedPerson && reroutedFact);
  assert.equal(isStandingPosition(rerouted.world.grid, reroutedPerson.position), true,
    'arrival must resolve a body-sized standing position against the current world');
  const rerouteDistance = Math.abs(cellX(reroutedPerson.position.cellId) - cellX(plannedEntry.cellId))
    + Math.abs(cellY(reroutedPerson.position.cellId) - cellY(plannedEntry.cellId));
  assert.ok(rerouteDistance <= REGIONAL_ENTRY_CORRIDOR_RADIUS,
    'a blocked corridor may reroute only to its nearby boundary, never a remote edge');
  assert.notEqual(reroutedPerson.position.cellId, plannedEntry.cellId);
  assert.deepEqual(reroutedFact.diff.plannedEntryPosition, plannedEntry);
  assert.deepEqual(reroutedFact.diff.entryPosition, {
    cellId: reroutedPerson.position.cellId,
    z: reroutedPerson.position.z,
  });

  const historyRecoveryInput = structuredClone(arrivedState);
  delete historyRecoveryInput.regionalPopulation;
  for (const event of historyRecoveryInput.world.past) {
    if (event.kind === 'population' && event.change === 'regional-source-established') {
      delete event.diff.journeyPlans;
    }
    if (event.kind === 'population' && event.change === 'regional-arrival') {
      delete event.diff.plannedEntryPosition;
    }
  }
  const recoveredHistoryLength = historyRecoveryInput.world.past.length;
  const recoveredEncounterCount = historyRecoveryInput.world.past.filter((event) => event.kind === 'population'
    && event.change === 'first-encounter'
    && event.personIds.includes(witness.id)
    && event.personIds.includes(arrived.id)).length;
  const historyRecovered = restoreSimulationState(historyRecoveryInput);
  assert.equal(historyRecovered.world.past.length, recoveredHistoryLength,
    'a ledger-backed regional aggregate must be rebuilt without appending a second source');
  assert.equal(historyRecovered.regionalPopulation.journeys.find((journey) => journey.id === firstJourney.id)?.status, 'arrived');
  assert.ok(historyRecovered.regionalPopulation.encounteredPairKeys.includes(
    [witness.id, arrived.id].sort().join('|'),
  ));
  const existingPersonIds = new Set(historyRecovered.people.map((person) => person.id));
  assert.ok(historyRecovered.regionalPopulation.journeys.every((journey) => (
    journey.status === 'arrived' || !existingPersonIds.has(journey.traveler.personId)
  )), 'recovered approaching journeys must never retain an already-present person id');
  const afterRecoveryMonth = stepSimulation(historyRecovered, idleDecider);
  assert.equal(afterRecoveryMonth.world.past.filter((event) => event.kind === 'population'
    && event.change === 'first-encounter'
    && event.personIds.includes(witness.id)
    && event.personIds.includes(arrived.id)).length, recoveredEncounterCount,
  'restored encounter pairs must not emit another first encounter');

  const traitRecoveryInput = structuredClone(arrivedState);
  const traitJourney = traitRecoveryInput.regionalPopulation.journeys.find((journey) => journey.id === firstJourney.id);
  const traitPerson = traitRecoveryInput.people.find((person) => person.id === arrivingPersonId);
  assert.ok(traitJourney && traitPerson);
  traitJourney.traveler.traits = [{
    id: 'prophet',
    origin: 'founder',
    inheritedFromPersonIds: [],
    sourceEventIds: [traitRecoveryInput.regionalPopulation.sourceEventId],
  }];
  delete traitPerson.traits;
  traitPerson.knowledge = [];
  const traitRecovered = restoreSimulationState(traitRecoveryInput);
  const recoveredTraveler = traitRecovered.people.find((person) => person.id === arrivingPersonId);
  assert.ok(recoveredTraveler?.traits?.some((trait) => trait.id === 'prophet'
    && trait.sourceEventIds.includes(arrivalFact.id)
    && !trait.sourceEventIds.includes('e-0-environment-founding-0')),
  'missing regional traits must recover from the journey and arrival, never the founding cohort');
  assert.ok(recoveredTraveler.knowledge.length > 0 && recoveredTraveler.knowledge.every((fact) => (
    fact.learnedAtMonth >= recoveredTraveler.origin.enteredAtMonth
      && fact.sourceEventIds.includes(arrivalFact.id)
      && !fact.sourceEventIds.includes('e-0-environment-founding-0')
  )), 'restored regional knowledge cannot predate entry or cite the founding event');

  const terminalState = createInitialState(seed, config);
  const terminalJourney = terminalState.regionalPopulation.journeys[0];
  terminalState.clock.elapsedMonths = terminalJourney.expectedArrivalAtMonth - 1;
  terminalState.civilization.conditions.endpoint.value = terminalJourney.expectedArrivalAtMonth;
  terminalState.world.animals = [];
  for (const person of terminalState.people) {
    person.body = { health: 100, hydration: 100, nutrition: 100 };
    person.conditions = [];
  }
  const terminalResult = stepSimulation(terminalState, idleDecider);
  assert.equal(terminalResult.civilization.status, 'ended');
  assert.equal(terminalResult.people.length, 3);
  assert.equal(terminalResult.world.past.some((event) => event.kind === 'population'
    && event.change === 'regional-arrival'), false,
  'a boundary or destroyed ending must resolve before arrivals and can never be revived by one');

  process.stdout.write('regional arrival tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
