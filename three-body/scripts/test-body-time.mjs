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
    export { createActivityWorkBudget } from './src/game/eland/domain/action-work';
    export { advanceBodyTime, advanceBodies } from './src/game/eland/domain/monthly-processes';
    export { executePrimitiveAction } from './src/game/eland/domain/action-executor';
    export { commitDecision, executeProtectiveInterruption } from './src/game/eland/application/simulation/intent-execution';
    export { chooseSurvivalReflex } from './src/game/eland/domain/survival-reflex';
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

  // The natural-04 failure was a real one-cell trip to a berry bush: the
  // move's small water cost crossed the thirst threshold before harvesting.
  const foraging = fixture();
  foraging.state.world.drops = [];
  for (let x = 9; x <= 23; x++) for (let y = 9; y <= 17; y++) {
    for (let z = 0; z < foraging.state.world.grid.levels; z++) api.setVoxel(foraging.state.world.grid, x, y, z,
      z === 0 ? api.Material.Stone : api.Material.Air);
  }
  foraging.person.position = { ...foraging.person.position, cellId: api.cellId(12, 12), z: 1 };
  foraging.person.body.hydration = 58;
  foraging.person.body.nutrition = 0;
  api.setVoxel(foraging.state.world.grid, 11, 12, 0, api.Material.Water);
  api.setVoxel(foraging.state.world.grid, 11, 13, 0, api.Material.BerryBush);
  const forageMonth = executionFor(foraging);
  api.executePlanningTick(forageMonth);
  const forageActions = forageMonth.prepared.events.filter((fact) => fact.kind === 'action');
  const harvest = forageActions.find((fact) => fact.action.kind === 'act' && fact.action.operation === 'separate');
  const eating = forageActions.filter((fact) => fact.action.kind === 'act' && fact.action.operation === 'ingest'
    && fact.diff.materialId === api.Material.Food);
  assert(harvest?.status === 'completed', 'the chosen trip must continue to the actual berry harvest');
  assert(eating.length > 0 && eating.every((fact) => fact.actionTick === 1 && fact.status === 'completed'),
    'actually acquired food must reach the mouth within the available activity effort: ' + JSON.stringify(forageActions.map((fact) => ({action:fact.action,status:fact.status,diff:fact.diff}))) );
  assert.equal(forageActions[0].action.kind, 'move');
  assert.equal(harvest.intentId, forageActions[0].intentId, 'reaching a cell does not replace the selected self-care attempt');
  assert(eating[0].diff.consumedSourceEventIds.includes(harvest.id));
  const totalForageWork = forageActions.reduce((sum, fact) => sum + Number(fact.diff.spentWork ?? 0), 0);
  assert(totalForageWork <= 8, 'approach, acquisition and intake share one activity effort allowance');
  near(forageMonth.activityWorkBudgets.get(foraging.person.id).remainingEffort, 8 - totalForageWork, 'remaining actor effort');
  assert.equal(forageMonth.prepared.events.filter((fact) => fact.diff?.metabolicProfile).length, 1);
  assert(foraging.person.body.nutrition > 0 && foraging.person.body.health > 0);
  assert.equal(api.voxelAt(foraging.state.world.grid, 11, 13, 0), api.Material.Shrub);

  const walker = structuredClone(foraging);
  walker.person = walker.state.people[0];
  walker.person.body = { health: 100, hydration: 50, nutrition: 50 };
  walker.person.baselineCapacities.locomotion = 50;
  walker.person.position.cellId = api.cellId(12, 15);
  walker.person.position.z = 1;
  delete walker.person.actionWork;
  const shared = api.createActivityWorkBudget();
  const firstWalk = api.executePrimitiveAction(walker.state, walker.person, { kind: 'move', toCellId: api.cellId(13, 15), toZ: 1 },
    1, 1000, { cause: 'intent', actionTick: 1, workBudget: shared });
  const secondWalk = api.executePrimitiveAction(walker.state, walker.person, { kind: 'move', toCellId: api.cellId(21, 15), toZ: 1 },
    1, 1001, { cause: 'intent', actionTick: 1, workBudget: shared });
  near(firstWalk.diff.spentWork, 2, 'first short route work');
  near(secondWalk.diff.spentWork, 6, 'second route uses only the remaining work');
  near(shared.remainingEffort, 0, 'no fresh budget for a second movement');
  assert.equal(walker.person.position.cellId, api.cellId(16, 15));

  // Reproduce natural-05: a weak person has paid most of a two-work edge,
  // then a fresh Mind goal installs a different survival interruption.
  const continuity = structuredClone(walker.state);
  const weakWalker = continuity.people[0];
  continuity.intents = [];
  delete weakWalker.activeIntentId;
  delete weakWalker.actionWork;
  delete weakWalker.movementWork;
  weakWalker.position.cellId = api.cellId(12, 15);
  weakWalker.position.z = 1;
  weakWalker.body = { health: 100, hydration: 0, nutrition: 0 };
  api.setVoxel(continuity.world.grid, 14, 15, 0, api.Material.Water);
  const continuityEvents = [];
  const chooseNewGoal = (destination, tick) => {
    const option = { id: `controlled-new-goal-${tick}`, summary: '继续处理本人新选择的事情', reason: '受控意图更换',
      goal: { kind: 'at-cell', cellId: destination, z: 1 }, nextAction: { kind: 'move', toCellId: destination, toZ: 1 },
      estimatedDuration: 'one-month', sourceFactIds: [], domain: 'strategic' };
    api.commitDecision(continuity, weakWalker, { state: continuity, person: weakWalker,
      visibleCells: [], visiblePeople: [], visibleDrops: [], visibleAnimals: [], options: [option], followUpOptions: [],
      activeIntent: continuity.intents.find((intent) => intent.id === weakWalker.activeIntentId) },
    { kind: 'start', optionId: option.id, reason: option.reason }, false, 1, continuityEvents, tick);
    return weakWalker.activeIntentId;
  };
  const parentBefore = chooseNewGoal(api.cellId(20, 15), 1);
  const bankStep = api.chooseSurvivalReflex(continuity, weakWalker);
  assert.equal(bankStep.toCellId, api.cellId(13, 15));
  const firstInterruptedMove = api.executeProtectiveInterruption(continuity, weakWalker, bankStep,
    'survival-reflex', 1, 1, continuityEvents, api.createActivityWorkBudget());
  assert.equal(firstInterruptedMove.status, 'progressed');
  assert.equal(weakWalker.position.cellId, api.cellId(12, 15));
  near(weakWalker.movementWork.completedWork, 1.6, 'actual first-edge work is owned by the body');
  const changedPremises = structuredClone(continuity);
  const parentAfter = chooseNewGoal(api.cellId(21, 15), 2);
  assert.notEqual(parentAfter, parentBefore, 'the scenario really replaces the parent intention');
  const secondBudget = api.createActivityWorkBudget();
  const secondInterruptedMove = api.executeProtectiveInterruption(continuity, weakWalker,
    api.chooseSurvivalReflex(continuity, weakWalker), 'survival-reflex', 1, 2, continuityEvents, secondBudget);
  assert.notEqual(secondInterruptedMove.intentId, firstInterruptedMove.intentId, 'the survival child identity really changes');
  assert.equal(secondInterruptedMove.status, 'completed', 'equivalent new intent must finish the partially paid edge');
  assert.equal(weakWalker.position.cellId, api.cellId(13, 15));
  near(secondInterruptedMove.diff.spentWork, 2, 'only the unpaid 0.4 physical work remains');
  assert(secondInterruptedMove.diff.workCompletionSourceEventIds.includes(firstInterruptedMove.id));
  assert.equal(weakWalker.movementWork, undefined);
  const changedWalker = changedPremises.people[0];
  api.setVoxel(changedPremises.world.grid, 13, 15, 0, api.Material.PackedSoil);
  const changedRoad = api.executePrimitiveAction(changedPremises, changedWalker, bankStep, 1, 1100,
    { cause: 'intent', actionTick: 2, workBudget: api.createActivityWorkBudget() });
  near(changedRoad.diff.spentWork, 5, 'a changed edge cost invalidates the old premise rather than granting a free step');
  assert(!changedRoad.diff.workCompletionSourceEventIds?.includes(firstInterruptedMove.id));

  walker.person.inventory = [{ id: 'slow-timber', materialId: api.Material.Wood, quantity: 1, sourceEventIds: ['controlled-slow-timber'] }];
  const slowTarget = { x: 17, y: 15, z: 1 };
  const installation = { kind: 'act', operation: 'combine', targets: [
    { kind: 'inventory-stack', personId: walker.person.id, stackId: 'slow-timber' },
    { kind: 'voxel', position: slowTarget },
  ] };
  const unfinished = api.executePrimitiveAction(walker.state, walker.person, installation, 1, 1002,
    { cause: 'intent', actionTick: 1, workBudget: { remainingEffort: 1 } });
  assert.equal(unfinished.status, 'progressed');
  assert.equal(walker.person.inventory[0].quantity, 1, 'unfinished work has not consumed its input');
  assert.equal(api.voxelAt(walker.state.world.grid, 17, 15, 1), api.Material.Air, 'unfinished work has no premature product');
  const finished = api.executePrimitiveAction(walker.state, walker.person, installation, 1, 1003,
    { cause: 'intent', actionTick: 2, workBudget: api.createActivityWorkBudget() });
  assert.equal(finished.status, 'completed');
  near(unfinished.diff.spentWork + finished.diff.spentWork, 4, 'previous labour is retained, not charged again');
  assert(finished.diff.workCompletionSourceEventIds.includes(unfinished.id));
  assert.equal(walker.person.inventory.length, 0);
  assert.equal(api.voxelAt(walker.state.world.grid, 17, 15, 1), api.Material.Plank);

  const transfers = structuredClone(walker.state);
  const giver = transfers.people[0];
  giver.body = { health: 100, hydration: 50, nutrition: 50 };
  giver.baselineCapacities.locomotion = 50;
  giver.inventory = [{ id: 'one-timber', materialId: api.Material.Wood, quantity: 1, sourceEventIds: ['controlled-transfer-input'] }];
  const receiver = structuredClone(giver);
  receiver.id = 'controlled-receiver';
  receiver.name = '受控接收者';
  receiver.body = { health: 100, hydration: 100, nutrition: 100 };
  receiver.position.cellId = api.cellId(16, 16);
  receiver.inventory = [];
  delete receiver.activeIntentId;
  transfers.people.push(receiver);
  const requestMany = { kind: 'transfer', materialId: api.Material.Wood, quantity: 50,
    from: { kind: 'person', personId: giver.id }, to: { kind: 'person', personId: receiver.id }, stackId: 'one-timber' };
  const limitedStock = api.executePrimitiveAction(transfers, giver, requestMany, 1, 1010,
    { cause: 'intent', actionTick: 3, workBudget: { remainingEffort: 2 } });
  assert.equal(limitedStock.status, 'completed', 'requesting fifty cannot manufacture fifty portions of labour when only one exists');
  assert.equal(limitedStock.diff.quantity, 1);
  near(limitedStock.diff.spentWork, 1, 'one actual available portion of handling');
  assert.equal(giver.inventory.length, 0);
  assert.equal(receiver.inventory[0].quantity, 1);

  giver.inventory = [{ id: 'four-timbers', materialId: api.Material.Wood, quantity: 4, sourceEventIds: ['controlled-capacity-input'] }];
  const noChangeBudget = { remainingEffort: 0.5 };
  const noChange = api.executePrimitiveAction(transfers, giver, { ...requestMany,
    stackId: 'four-timbers', to: { kind: 'person', personId: giver.id } }, 1, 1011,
  { cause: 'intent', actionTick: 3, workBudget: noChangeBudget });
  assert.equal(noChange.status, 'completed');
  assert.equal(noChange.diff.transferNoChange, true);
  assert.equal(noChange.diff.quantity, 0);
  near(noChange.diff.spentWork, 0, 'same-holder transfer performs no labour');
  near(noChangeBudget.remainingEffort, 0.5, 'no phantom unfinished work for a zero transfer');
  assert.equal(giver.actionWork, undefined);
  assert.equal(giver.inventory[0].quantity, 4);

  api.setVoxel(transfers.world.grid, 17, 15, 1, api.Material.Container);
  transfers.containers.push({ id: 'controlled-one-capacity', position: { x: 17, y: 15, z: 1 },
    capacity: 1, inventory: [], createdAtMonth: 0, sourceEventIds: ['controlled-container'] });
  const limitedCapacity = api.executePrimitiveAction(transfers, giver, { ...requestMany, stackId: 'four-timbers',
    to: { kind: 'container', containerId: 'controlled-one-capacity' } }, 1, 1012,
  { cause: 'intent', actionTick: 3, workBudget: { remainingEffort: 2 } });
  assert.equal(limitedCapacity.status, 'completed');
  assert.equal(limitedCapacity.diff.quantity, 1);
  near(limitedCapacity.diff.spentWork, 1, 'handling is limited by the actual receiving capacity');
  assert.equal(giver.inventory[0].quantity, 3);

  giver.baselineCapacities.manipulation = 1;
  receiver.baselineCapacities.manipulation = 100;
  receiver.baselineCapacities.perception = 100;
  const taking = { kind: 'transfer', materialId: api.Material.Wood, quantity: 50,
    from: { kind: 'person', personId: receiver.id }, to: { kind: 'person', personId: giver.id }, stackId: receiver.inventory[0].id };
  const resistedBudget = { remainingEffort: 2 };
  const resisted = api.executePrimitiveAction(transfers, giver, taking, 1, 1013,
    { cause: 'intent', actionTick: 3, workBudget: resistedBudget });
  assert.equal(resisted.status, 'blocked');
  assert.equal(resisted.diff.attempted, true);
  assert.equal(resisted.diff.attemptedQuantity, 1);
  assert(resisted.diff.takingContest, 'the owner actually resisted a physical taking attempt');
  near(resisted.diff.spentWork, 1, 'a real resisted attempt is not a free preflight rejection');
  near(resistedBudget.remainingEffort, 1, 'the attempted available portion consumed effort');
  assert.equal(receiver.inventory[0].quantity, 1, 'resistance prevents the transfer');
  receiver.position.cellId = api.cellId(50, 45);
  const unreachableBudget = { remainingEffort: 2 };
  const unreachable = api.executePrimitiveAction(transfers, giver, taking, 1, 1014,
    { cause: 'intent', actionTick: 3, workBudget: unreachableBudget });
  assert.equal(unreachable.status, 'blocked');
  assert.notEqual(unreachable.diff.attempted, true);
  near(unreachable.diff.spentWork, 0, 'a physically unstarted transfer does not incur taking labour');
  near(unreachableBudget.remainingEffort, 2, 'unstarted preflight leaves available work intact');

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
