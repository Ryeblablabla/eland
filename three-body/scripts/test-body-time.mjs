import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Supplied reserves, inventory and actions isolate the time contract. This is
// not an autonomous survival or civilization experiment and makes no model calls.
const temporary = mkdtempSync(path.join(tmpdir(), 'eland-body-time-'));
try {
  const bundle = path.join(temporary, 'body-time.mjs');
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=body-time-test.ts', `--outfile=${bundle}`, '--log-level=error',
  ], { input: `export { createInitialState } from './src/game/eland/simulation';
    export { settleBodyMetabolism, BASE_DAILY_HYDRATION_COST, BASE_DAILY_NUTRITION_COST } from './src/game/eland/domain/body-metabolism';
    export { advanceBodyTime, advanceBodies } from './src/game/eland/domain/monthly-processes';
    export { executePrimitiveAction } from './src/game/eland/domain/action-executor';
    export { commitDecision } from './src/game/eland/application/simulation/intent-execution';
    export { createMonthExecution, executePlanningTick, finishMonthExecution } from './src/game/eland/application/simulation/month-execution';
    export { simulationObservationProjector } from './src/game/eland/projection/simulation-observation-projector';
    export { cellId, setVoxel, voxelAt } from './src/game/eland/world/grid';
    export { Material } from './src/game/eland/domain/material';`, stdio: ['pipe', 'pipe', 'pipe'] });
  const api = await import(pathToFileURL(bundle).href);
  const near = (actual, expected, label) => assert(Math.abs(actual - expected) < 1e-8, `${label}: ${actual} != ${expected}`);
  const fixture = () => {
    const state = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
    state.people = [state.people[0]];
    const person = state.people[0];
    person.body = { health: 100, hydration: 100, nutrition: 100 };
    person.conditions = [];
    person.traits = [];
    person.inventory = [];
    person.bornAtMonth = -240;
    person.lifespanMonths = 960;
    state.world.animals = [];
    state.civilization.epoch = 'stable';
    state.civilization.climate = { kind: 'temperate', severity: 0 };
    state.civilization.weather = { kind: 'clear', intensity: 0, sinceMonth: 1 };
    return { state, person };
  };
  const environment = { droughtIntensity: 0, fireProtected: false, severeChaoticClimate: false };
  const partitioned = fixture().person, singleInterval = structuredClone(partitioned);
  for (let tick = 1; tick <= 3; tick++) api.settleBodyMetabolism(partitioned, 2, environment);
  api.settleBodyMetabolism(singleInterval, 6, environment);
  for (const key of ['health', 'hydration', 'nutrition']) near(partitioned.body[key], singleInterval.body[key], `elapsed-time partition ${key}`);
  assert(partitioned.body.health < 100, 'shortage harms the body within the month');

  const noIntake = fixture();
  const deathEvents = [];
  for (let tick = 1; tick <= 15; tick++) deathEvents.push(...api.advanceBodyTime(noIntake.state, 1, tick, 2, deathEvents.length));
  const death = deathEvents.find((fact) => fact.change === 'death');
  assert(death && death.planningTick < 15, 'no intake cannot support an awake person for many months');
  assert.equal(noIntake.person.diedAtMonth, 1);
  assert.equal(deathEvents.filter((fact) => fact.change === 'death').length, 1);
  assert(death.diff.sourceEventIds.some((id) => deathEvents.some((fact) => fact.id === id && fact.diff.metabolicProfile === 'awake')));
  assert.equal(noIntake.state.world.remains.find((remains) => remains.personId === noIntake.person.id).deathEventId, death.id);
  assert.equal(api.advanceBodies(noIntake.state, 1).filter((fact) => fact.change === 'death').length, 0);
  assert.equal(new Set(deathEvents.map((fact) => fact.id)).size, deathEvents.length);

  const fed = fixture();
  fed.person.body.hydration = 20;
  fed.person.body.nutrition = 20;
  fed.person.inventory = [
    { id: 'food', materialId: api.Material.Food, quantity: 1, sourceEventIds: ['controlled-food'] },
    { id: 'water', materialId: api.Material.Water, quantity: 1, sourceEventIds: ['controlled-water'] },
  ];
  for (const [index, stackId] of ['food', 'water'].entries()) {
    const fact = api.executePrimitiveAction(fed.state, fed.person, { kind: 'act', operation: 'ingest',
      targets: [{ kind: 'inventory-stack', personId: fed.person.id, stackId }] }, 1, index, { cause: 'intent', actionTick: 2 });
    assert.equal(fact.status, 'completed', fact.result);
  }
  near(fed.person.body.hydration, 82, 'real drink 58 plus food water 4');
  near(fed.person.body.nutrition, 68, 'real food 48');
  assert.equal(fed.person.inventory.length, 0, 'actual portions were consumed');
  api.advanceBodyTime(fed.state, 1, 2, 2);
  near(fed.person.body.hydration, 82 - 2 * api.BASE_DAILY_HYDRATION_COST, 'two days after drinking');
  near(fed.person.body.nutrition, 68 - 2 * api.BASE_DAILY_NUTRITION_COST, 'two days after eating');
  const reservesBeforeMonthEnd = { ...fed.person.body };
  api.advanceBodies(fed.state, 1);
  near(fed.person.body.hydration, reservesBeforeMonthEnd.hydration, 'no month-end hydration double charge');
  near(fed.person.body.nutrition, reservesBeforeMonthEnd.nutrition, 'no month-end nutrition double charge');
  near(fed.person.body.health, reservesBeforeMonthEnd.health, 'no month-end shortage double charge');

  const executionFor = ({ state, person }) => api.createMonthExecution({
    prepared: { state, atMonth: 1, events: [], contexts: [], candidates: [], naturallyTriggeredPeople: new Set(), livingAgents: 1 },
    decisions: new Map(), usage: { inputTokens: 0, outputTokens: 0 }, attempted: { total: 0, ordinary: 0, exempt: 0 },
    observationProjector: api.simulationObservationProjector, controlledPersonId: person.id,
  });
  const active = fixture();
  const execution = executionFor(active);
  const observed = [];
  for (let tick = 0; tick < 2; tick++) api.executePlanningTick(execution, ({ person }) => {
    observed.push(person.body.hydration);
    return { kind: 'wait' };
  });
  near(observed[0], 100, 'first action opportunity precedes elapsed cost');
  near(observed[1], 100 - 2 * api.BASE_DAILY_HYDRATION_COST, 'next action sees the elapsed reserve change');
  assert.equal(execution.completedTick, 2);

  const working = fixture();
  const target = { x: 13, y: 12, z: 1 };
  for (let x = 10; x <= 15; x++) for (let y = 10; y <= 15; y++) {
    for (let z = 0; z < working.state.world.grid.levels; z++) api.setVoxel(working.state.world.grid, x, y, z,
      z === 0 ? api.Material.Stone : api.Material.Air);
  }
  working.person.position = { ...working.person.position, cellId: api.cellId(12, 12), z: 1 };
  working.person.body.hydration = 40;
  working.person.body.nutrition = 40;
  api.setVoxel(working.state.world.grid, 11, 12, 0, api.Material.Water);
  working.person.inventory = [
    { id: 'meal', materialId: api.Material.Food, quantity: 1, sourceEventIds: ['controlled-meal'] },
    { id: 'timber', materialId: api.Material.Wood, quantity: 1, sourceEventIds: ['controlled-timber'] },
  ];
  const workingMonth = executionFor(working);
  const chosenWork = { id: 'controlled-timber-placement', summary: '把持有的木材放在已选择的位置',
    reason: '受控执行验证', goal: { kind: 'voxel-is', position: target, materialId: api.Material.Plank },
    nextAction: { kind: 'act', operation: 'combine', targets: [
      { kind: 'inventory-stack', personId: working.person.id, stackId: 'timber' },
      { kind: 'voxel', position: target },
    ] }, estimatedDuration: 'one-month', sourceFactIds: ['controlled-timber'], domain: 'strategic' };
  api.commitDecision(working.state, working.person, { state: working.state, person: working.person,
    visibleCells: [], visiblePeople: [], visibleDrops: [], visibleAnimals: [], options: [chosenWork], followUpOptions: [] },
  { kind: 'start', optionId: chosenWork.id, reason: chosenWork.reason }, false, 1, workingMonth.prepared.events, 1);
  const originalWorkId = working.person.activeIntentId;
  api.executePlanningTick(workingMonth);
  const intakeAndWork = workingMonth.prepared.events.filter((fact) => fact.kind === 'action');
  assert.deepEqual(intakeAndWork.map((fact) => [fact.action.kind, fact.action.operation, fact.status, fact.actionTick]), [
    ['act', 'ingest', 'completed', 1], ['act', 'ingest', 'completed', 1], ['act', 'combine', 'completed', 1],
  ], 'real drinking and eating at hand finish before one already chosen body step in the same episode');
  assert.equal(intakeAndWork[0].diff.materialId, api.Material.Water);
  assert.equal(intakeAndWork[1].diff.materialId, api.Material.Food);
  assert.equal(intakeAndWork[2].intentId, originalWorkId, 'resume the original work, do not choose a new goal');
  assert.equal(api.voxelAt(working.state.world.grid, target.x, target.y, target.z), api.Material.Plank);
  assert.equal(working.person.inventory.length, 0, 'both meal and construction consume their real supplied material');
  near(working.person.body.nutrition, 88 - 2 * api.BASE_DAILY_NUTRITION_COST, 'one elapsed-time charge after intake and work');
  near(working.person.body.hydration, 100 - 2 * api.BASE_DAILY_HYDRATION_COST, 'both intakes precede one two-day hydration charge');

  const sleeper = fixture();
  sleeper.person.conditions.push({ id: 'controlled-sleep', kind: 'dehydrated-hibernation', stage: 1,
    sinceMonth: 0, hibernationPhase: 'dormant', sourceEventIds: ['controlled-sleep-entry'] });
  const sleepingMonth = executionFor(sleeper);
  for (let tick = 0; tick < 15; tick++) api.executePlanningTick(sleepingMonth);
  api.finishMonthExecution(sleepingMonth);
  near(sleeper.person.body.hydration, 99.65, 'whole-month dormant hydration cost');
  near(sleeper.person.body.nutrition, 99.7, 'whole-month dormant nutrition cost');
  near(sleeper.person.body.health, 99.75, 'whole-month dormant health cost');
  assert.equal(sleeper.state.clock.elapsedMonths, 1);
  assert.equal(sleeper.person.inventory.length, 0, 'time settlement supplies no food or water');
  console.log('body-time: elapsed reserves, real intake, action opportunities, monthly lifecycle and dormant cost passed (0 model calls)');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
