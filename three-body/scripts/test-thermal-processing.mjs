import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Supplied choices and weather controls verify a physical function, not an
// autonomous invention, a social agreement, or a civilization milestone.
const temporary = mkdtempSync(path.join(tmpdir(), 'eland-thermal-processing-'));
try {
  const bundle = path.join(temporary, 'thermal.mjs');
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=thermal-test.ts', `--outfile=${bundle}`, '--log-level=error',
  ], { input: `export { createInitialState } from './src/game/eland/simulation';
      export { executePrimitiveAction } from './src/game/eland/domain/action-executor';
      export { advanceWorldProcesses } from './src/game/eland/domain/monthly-processes';
      export { observeWorkAdoption } from './src/game/eland/domain/works';
      export { rainCoverAt } from './src/game/eland/domain/thermal-process';
      export { appendCommittedEvents } from './src/game/eland/domain/history';
      export { Material } from './src/game/eland/domain/material';
      export { seededFraction } from './src/game/eland/world/generator';
      export { cellId, setVoxel, voxelAt } from './src/game/eland/world/grid';`, stdio: ['pipe', 'pipe', 'pipe'] });
  const api = await import(pathToFileURL(bundle).href);
  const { Material: M } = api;
  const base = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  const grid = base.world.grid;
  for (let x = 10; x <= 18; x++) for (let y = 9; y <= 16; y++) for (let z = 0; z < grid.levels; z++) {
    api.setVoxel(grid, x, y, z, z === 0 ? M.Stone : M.Air);
  }
  base.world.animals = [];
  base.world.works = [];
  base.world.drops = [];
  const actor = base.people[0];
  const other = base.people[1];
  actor.position = { ...actor.position, cellId: api.cellId(15, 11), z: 1 };
  other.position = { ...other.position, cellId: api.cellId(13, 11), z: 1 };
  actor.inventory = [{ id: 'roof-wood', materialId: M.Wood, quantity: 4, sourceEventIds: ['fixture-wood'] },
    { id: 'raw-meat', materialId: M.RawMeat, quantity: 1, sourceEventIds: ['fixture-food'], sourceLineageKeys: ['animal:fixture-meat'] }];
  other.inventory = [];
  base.people = [actor, other];
  let order = 10;
  const act = (state, person, action, month = 0) => {
    const fact = api.executePrimitiveAction(state, person, action, month, ++order, { cause: 'intent', actionTick: order });
    api.appendCommittedEvents(state, [fact]);
    return fact;
  };
  const roof = { x: 14, y: 12, z: 3 };
  const fire = { x: 14, y: 12, z: 1 };
  const built = act(base, actor, { kind: 'world-interact', adjudication: {
    version: 'world-adjudicated-interaction-v1', request: '按明确位置排列木材', status: 'completed', result: '摆放实际材料',
    targets: [{ kind: 'voxel', position: { x: 15, y: 12, z: 1 } },
      { kind: 'inventory-stack', personId: actor.id, stackId: 'roof-wood' }], effects: [
      { kind: 'consume', target: { kind: 'inventory-stack', personId: actor.id, stackId: 'roof-wood' }, quantity: 4 },
      { kind: 'assemble', target: { kind: 'voxel', position: { x: 15, y: 12, z: 1 } }, arrangement: 'pile',
        summary: '四份材料的实际排列', layout: { version: 'work-layout-v1', voxels: [
          { offset: { x: 0, y: 0, z: 0 }, materialId: M.Wood },
          { offset: { x: 0, y: 0, z: 1 }, materialId: M.Wood },
          { offset: { x: 0, y: 0, z: 2 }, materialId: M.Wood },
          { offset: { x: -1, y: 0, z: 2 }, materialId: M.Wood },
        ] } },
    ],
  } });
  assert.equal(built.status, 'completed', built.result);
  const workId = base.world.works[0].id;
  assert.equal(actor.inventory.find((stack) => stack.materialId === M.Wood), undefined);
  const positioned = act(base, actor, { kind: 'move', toCellId: api.cellId(13, 12), toZ: 1 });
  assert.equal(positioned.status, 'completed', positioned.result);
  // An actual existing fire is the controlled input; this fixture does not
  // claim a new ignition/fuel capability.
  api.setVoxel(grid, fire.x, fire.y, fire.z, M.Fire);
  assert.equal(api.rainCoverAt(base.world, fire)?.workId, workId);
  assert.equal(base.world.works[0].useReceipts.length, 0, 'construction/proximity is not thermal processing use');
  const fireCell = api.cellId(fire.x, fire.y);
  const sample = (month) => api.seededFraction(base.seed, `world-process:${month}:${fireCell}:${M.Fire}`);
  const months = Array.from({ length: 48 }, (_, index) => index + 1);
  const survivalMonth = months.find((month) => sample(month) >= 0.28);
  const burnoutMonth = months.find((month) => sample(month) < 0.28);
  assert(survivalMonth && burnoutMonth);

  const advance = (state, month, weather) => {
    state.civilization.climate = { ...state.civilization.climate, kind: 'temperate', severity: 0 };
    state.civilization.weather = { kind: weather, intensity: 1, sinceMonth: month };
    const events = api.advanceWorldProcesses(state, month);
    api.appendCommittedEvents(state, events);
    const source = events.find((event) => event.diff.fireProcesses?.some((entry) => entry.position.x === fire.x
      && entry.position.y === fire.y && entry.position.z === fire.z));
    assert(source, 'covered fire must have a real monthly process fact');
    const evidence = source.diff.fireProcesses.find((entry) => entry.position.x === fire.x
      && entry.position.y === fire.y && entry.position.z === fire.z);
    return { source, evidence };
  };
  const cook = (state, month) => act(state, state.people[0], { kind: 'act', operation: 'expose', targets: [
    { kind: 'inventory-stack', personId: actor.id, stackId: 'raw-meat' }, { kind: 'voxel', position: fire },
  ] }, month);

  const intact = structuredClone(base);
  const protectedFire = advance(intact, survivalMonth, 'rain');
  assert.equal(protectedFire.evidence.naturalBurnoutSample, sample(survivalMonth));
  assert.equal(protectedFire.evidence.survived, true);
  assert.equal(protectedFire.evidence.rainExposed, false);
  assert.equal(protectedFire.evidence.cover.workId, workId);
  assert.equal(intact.world.works[0].useReceipts.length, 0, 'rain protection alone is not a person processing food');
  const cooked = cook(intact, survivalMonth);
  assert.equal(cooked.status, 'completed', cooked.result);
  assert.equal(cooked.diff.inputQuantity, 1);
  assert.equal(cooked.diff.outputQuantity, 1);
  assert.equal(cooked.diff.fireRainProtection.environmentEventId, protectedFire.source.id);
  assert.equal(cooked.diff.workUseReceipts.length, 1);
  const producer = intact.people[0], recipient = intact.people[1];
  const meal = producer.inventory.find((stack) => stack.materialId === M.CookedFood);
  assert.equal(meal.quantity, 1);
  assert(meal.sourceEventIds.includes('fixture-food') && meal.sourceEventIds.includes(cooked.id));
  assert(meal.sourceLineageKeys.includes('animal:fixture-meat'));
  assert(!producer.inventory.some((stack) => stack.materialId === M.RawMeat));
  const transfer = act(intact, producer, { kind: 'transfer', materialId: M.CookedFood, quantity: 1,
    from: { kind: 'person', personId: producer.id }, to: { kind: 'person', personId: recipient.id }, stackId: meal.id }, survivalMonth);
  assert.equal(transfer.status, 'completed', transfer.result);
  assert.equal(transfer.diff.quantity, 1);
  const received = recipient.inventory.find((stack) => stack.materialId === M.CookedFood);
  assert(received.sourceEventIds.includes(cooked.id) && received.sourceEventIds.includes(transfer.id));
  recipient.body.nutrition = 20;
  recipient.body.health = 60;
  const eating = act(intact, recipient, { kind: 'act', operation: 'ingest', targets: [
    { kind: 'inventory-stack', personId: recipient.id, stackId: received.id },
  ] }, survivalMonth);
  assert.equal(eating.status, 'completed', eating.result);
  assert.equal(recipient.body.nutrition, 80);
  assert.equal(recipient.body.health, 62);
  assert(!recipient.inventory.some((stack) => stack.materialId === M.CookedFood));
  assert(eating.diff.consumedSourceEventIds.includes(cooked.id));
  assert.equal(api.observeWorkAdoption(intact.world.works[0], intact.world.past, survivalMonth).receipts.length, 1);

  for (const [variant, damagePosition] of [['opening', roof], ['unrooted', { x: 15, y: 12, z: 1 }]]) {
    const damaged = structuredClone(base);
    if (variant === 'unrooted') damaged.people[0].position.cellId = api.cellId(15, 11);
    const removed = act(damaged, damaged.people[0], { kind: 'act', operation: 'separate',
      targets: [{ kind: 'voxel', position: damagePosition }] });
    assert.equal(removed.status, 'completed', removed.result);
    damaged.people[0].position.cellId = api.cellId(13, 12);
    assert.equal(api.rainCoverAt(damaged.world, fire), undefined);
    const checked = advance(damaged, survivalMonth, 'rain');
    assert.equal(checked.evidence.naturalBurnoutSample, protectedFire.evidence.naturalBurnoutSample);
    assert.equal(checked.evidence.rainExposed, true);
    assert.equal(api.voxelAt(damaged.world.grid, fire.x, fire.y, fire.z), M.Ash);
    assert.equal(cook(damaged, survivalMonth).status, 'blocked');
    assert.equal(damaged.people[0].inventory.find((stack) => stack.materialId === M.RawMeat).quantity, 1);
    assert(!damaged.people[0].inventory.some((stack) => stack.materialId === M.CookedFood));
    assert(damaged.world.works.every((work) => !work.useReceipts.length), 'nearby remains are not thermal use');
  }
  const sunny = structuredClone(base);
  advance(sunny, survivalMonth, 'clear');
  const sunnyCook = cook(sunny, survivalMonth);
  assert.equal(sunnyCook.status, 'completed', sunnyCook.result);
  assert.equal(sunnyCook.diff.fireRainProtection, undefined);
  assert.equal(sunny.world.works[0].useReceipts.length, 0);
  const exhausted = structuredClone(base);
  const burned = advance(exhausted, burnoutMonth, 'rain');
  assert.equal(burned.evidence.naturalBurnout, true);
  assert.equal(api.voxelAt(exhausted.world.grid, fire.x, fire.y, fire.z), M.Ash, 'a roof does not prevent ordinary burnout');

  // JSON checkpoints use numeric-key voxel objects: dimensions remain the
  // authoritative scan bounds. Reloading evidence also preserves causal use.
  const reloaded = JSON.parse(JSON.stringify(base));
  advance(reloaded, survivalMonth, 'rain');
  const reloadedAfterMonth = JSON.parse(JSON.stringify(reloaded));
  const replayCook = cook(reloadedAfterMonth, survivalMonth);
  assert.equal(replayCook.status, 'completed', replayCook.result);
  assert.equal(replayCook.diff.workUseReceipts.length, 1);
  assert.equal(api.observeWorkAdoption(reloadedAfterMonth.world.works[0], reloadedAfterMonth.world.past, survivalMonth).receipts.length, 1);
  const reloadedBurnout = JSON.parse(JSON.stringify(base));
  advance(reloadedBurnout, burnoutMonth, 'rain');
  assert.equal(api.voxelAt(reloadedBurnout.world.grid, fire.x, fire.y, fire.z), M.Ash);
  console.log('[thermal-processing] actual rain cover → surviving fire → one cooked portion → another person eats; opening, floating cover, sun, burnout and JSON reload controls passed');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
