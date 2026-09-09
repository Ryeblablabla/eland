import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Controlled domain regression. Materials, geometry and choices are fixtures;
// this is not evidence of autonomous invention or natural social development.
const temporary = mkdtempSync(path.join(tmpdir(), 'eland-work-storage-'));
const replayArgument = process.argv.indexOf('--replay-output');
const replayOutput = replayArgument >= 0 ? path.resolve(process.argv[replayArgument + 1]) : undefined;
if (replayOutput) mkdirSync(replayOutput);
try {
  const bundle = path.join(temporary, 'runtime.mjs');
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts', `--outfile=${bundle}`, '--log-level=error',
  ], { input: `export { createInitialState, buildDecisionContexts } from './src/game/eland/simulation';
    export { compileNativeOperation, resolveNativeTransferAction } from './src/game/eland/application/native-operation';
    export { executePrimitiveAction } from './src/game/eland/domain/action-executor';
    export { appendCommittedEvents } from './src/game/eland/domain/history';
    export { containerForWork, containerQuantity } from './src/game/eland/domain/container';
    export { observeWorkAdoption } from './src/game/eland/domain/works';
    export { buildDecisionRequestContext } from './src/game/eland/application/model-decision/decision-context';
    export { buildDecisionProbeHandleMap, buildCharacterAgendaProbeCandidates } from './src/game/eland/application/model-decision/capability-handles';
    export { compileModelNativeOperation } from './src/game/eland/application/model-decision/native-operation-context';
    export { Material } from './src/game/eland/domain/material';
    export { cellId, setVoxel, voxelAt } from './src/game/eland/world/grid';`, stdio: ['pipe', 'pipe', 'pipe'] });
  const api = await import(pathToFileURL(bundle).href), M = api.Material;
  const state = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  for (let x = 10; x <= 18; x++) for (let y = 9; y <= 16; y++) for (let z = 0; z < state.world.grid.levels; z++) {
    api.setVoxel(state.world.grid, x, y, z, z === 0 ? M.Stone : M.Air);
  }
  const builder = state.people[0], visitor = state.people[1];
  state.people = [builder, visitor]; state.world.animals = []; state.world.works = []; state.world.drops = []; state.containers = [];
  builder.position = { ...builder.position, cellId: api.cellId(13, 10), z: 1 };
  visitor.position = { ...visitor.position, cellId: api.cellId(14, 10), z: 1 };
  builder.conditions = []; visitor.conditions = []; visitor.body.hydration = 0;
  const anchor = { x: 13, y: 11, z: 1 }, positions = [anchor];
  for (let x = 12; x <= 16; x++) for (let y = 12; y <= 14; y++) {
    positions.push({ x, y, z: 1 });
    if (x === 12 || x === 16 || y === 12 || y === 14) positions.push({ x, y, z: 2 });
  }
  builder.inventory = [
    { id: 'clay-input', materialId: M.Clay, quantity: positions.length + 5, sourceEventIds: ['fixture-clay'] },
    { id: 'builder-jug', materialId: M.Container, quantity: 1, sourceEventIds: ['fixture-jug'] },
    { id: 'carried-water', materialId: M.Water, quantity: 3, containedByStackId: 'builder-jug',
      sourceEventIds: ['fixture-finite-water'], sourceLineageKeys: ['water:fixture-source'] },
    { id: 'food-input', materialId: M.Food, quantity: 1, sourceEventIds: ['fixture-food'] },
  ];
  visitor.inventory = [{ id: 'visitor-jug', materialId: M.Container, quantity: 1, sourceEventIds: ['fixture-visitor-jug'] }];
  const context = (person) => ({ ...api.buildDecisionContexts(state, 1).find((candidate) => candidate.person.id === person.id),
    options: [], followUpOptions: [] });
  let order = 10;
  const facts = [];
  const frames = [];
  const captureFrame = (label) => {
    if (!replayOutput) return;
    const index = frames.length, stateFile = `frame-${index}.json`;
    const snapshot = structuredClone(state);
    snapshot.lastStep = structuredClone(facts);
    writeFileSync(path.join(replayOutput, stateFile), JSON.stringify(snapshot));
    frames.push({ index, atMonth: 1, label, stateFile });
  };
  captureFrame('受控初始材料与人物；未运行模型');
  const perform = (person, request) => {
    const compiled = api.compileNativeOperation(context(person), request, `fixture-step-${order}`);
    assert(compiled.ok, compiled.problem?.message);
    const option = compiled.option;
    let action = option.nextAction;
    for (let step = 0; step < 30; step++) {
      const fact = api.executePrimitiveAction(state, person, action, 1, order++, { cause: 'intent', actionTick: order });
      facts.push(fact); api.appendCommittedEvents(state, [fact]);
      captureFrame(fact.result);
      assert(!['blocked', 'failed'].includes(fact.status), fact.result);
      if (fact.status === 'progressed') continue;
      if (action.kind !== 'move' || !option.completionAction) return fact;
      action = api.resolveNativeTransferAction(state, person, option.completionAction);
      assert(action, 'the selected transfer must remain executable after its real approach');
    }
    assert.fail('controlled activity did not finish');
  };
  const held = (person, stackId) => ({ kind: 'inventory-stack', personId: person.id, stackId });
  const built = perform(builder, { kind: 'assemble', target: { kind: 'voxel', position: anchor }, arrangement: 'form',
    inputs: [{ target: held(builder, 'clay-input'), quantity: positions.length }], summary: '按所选位置摆放的黏土',
    layout: { version: 'work-layout-v1', voxels: positions.map((position) => ({ materialId: M.Clay,
      offset: { x: position.x - anchor.x, y: position.y - anchor.y, z: position.z - anchor.z } })) } });
  const work = state.world.works[0], workRef = { kind: 'work', workId: work.id };
  let storage = api.containerForWork(state, work.id);
  assert.equal(storage.capacity, 3);
  assert.equal(storage.retainsWater, true);
  assert.equal(storage.inventory.length, 0, 'a built cavity starts empty');
  assert.equal(storage.carrier.workId, work.id);
  assert.equal(api.voxelAt(state.world.grid, anchor.x, anchor.y, anchor.z), M.Clay);
  assert.equal(work.components.reduce((sum, component) => sum + component.quantity, 0), positions.length);
  assert.equal(work.useReceipts.length, 0, 'construction alone is not storage use');
  assert(built.diff.workStorageChanges.some((change) => change.change === 'opened'));
  const poured = perform(builder, { kind: 'transfer', source: held(builder, 'carried-water'), destination: workRef, quantity: 3 });
  assert.equal(poured.diff.quantity, 3);
  assert.equal(api.containerQuantity(storage, M.Water), 3);
  assert(!builder.inventory.some((stack) => stack.materialId === M.Water));
  assert.equal(builder.inventory.find((stack) => stack.id === 'builder-jug').quantity, 1);

  // Closing the actual opening preserves the contents, while preventing
  // access; removing one real cover portion exposes the same stored water.
  const coveredPositions = [...positions, ...Array.from({ length: 5 }, (_, index) => ({ x: 12 + index, y: 13, z: 3 }))];
  perform(builder, { kind: 'assemble', target: workRef, inputs: [{ target: held(builder, 'clay-input'), quantity: 5 }],
    layout: { version: 'work-layout-v1', voxels: coveredPositions.map((position) => ({ materialId: M.Clay,
      offset: { x: position.x - anchor.x, y: position.y - anchor.y, z: position.z - anchor.z } })) } });
  storage = api.containerForWork(state, work.id);
  assert.equal(storage.accessible, false);
  assert.equal(api.containerQuantity(storage, M.Water), 3);
  assert(!api.buildDecisionRequestContext(context(visitor)).visibleContainers.some((item) => item.id === storage.id),
    'a covered cavity does not expose its contents to the other person');
  perform(builder, { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position: { x: 13, y: 13, z: 3 } }] });
  storage = api.containerForWork(state, work.id);
  assert.equal(storage.accessible, true);
  assert.equal(api.containerQuantity(storage, M.Water), 3);

  const publicRequest = api.buildDecisionRequestContext(context(visitor));
  const handles = api.buildDecisionProbeHandleMap(publicRequest);
  const visible = api.buildCharacterAgendaProbeCandidates(publicRequest, handles);
  const storageHandle = handles.visible.find((item) => item.kind === 'container' && item.containerId === storage.id).handle;
  const shown = visible.visible.find((item) => item.handle === storageHandle);
  assert.equal(shown.capacity, 3);
  assert.equal(shown.usedCapacity, 3);
  assert.deepEqual(shown.contents, [{ name: '水', quantity: 3 }]);
  assert.equal(shown.retainsWater, true);
  assert.equal(shown.workHandle, handles.visible.find((item) => item.kind === 'work' && item.workId === work.id).handle);
  const take = api.compileModelNativeOperation({ kind: 'transfer', sourceHandle: storageHandle, destinationHandle: 'self',
    materialKey: 'water', quantity: 1, containerHandle: handles.held.find((item) => item.stackId === 'visitor-jug').handle }, publicRequest, handles);
  assert(take, 'the current public container and contents bind through the normal model interface');
  const taken = perform(visitor, take);
  const portableWater = visitor.inventory.find((stack) => stack.materialId === M.Water);
  assert.equal(portableWater.quantity, 1);
  assert.equal(portableWater.containedByStackId, 'visitor-jug');
  assert(portableWater.sourceEventIds.includes(poured.id));
  assert(portableWater.sourceEventIds.includes(taken.id));
  assert(portableWater.sourceLineageKeys.includes('water:fixture-source'));
  assert.equal(api.containerQuantity(storage, M.Water), 2);
  perform(visitor, { kind: 'act', operation: 'ingest', targets: [held(visitor, portableWater.id)] });
  assert(visitor.body.hydration > 0);
  const directRequest = api.buildDecisionRequestContext(context(visitor));
  const directHandles = api.buildDecisionProbeHandleMap(directRequest);
  const directDrink = api.compileModelNativeOperation({ kind: 'act', operation: 'ingest',
    targetHandles: [directHandles.visible.find((item) => item.kind === 'container' && item.containerId === storage.id).handle] }, directRequest, directHandles);
  assert(directDrink, 'stored-water drinking is expressible through the ordinary public native act');
  const drank = perform(visitor, directDrink);
  assert.equal(drank.diff.remainingWater, 1);
  assert.equal(api.containerQuantity(storage, M.Water), 1);
  assert(drank.diff.consumedSourceEventIds.includes(poured.id));
  perform(builder, { kind: 'transfer', source: held(builder, 'food-input'), destination: workRef, quantity: 1 });
  const reloaded = JSON.parse(JSON.stringify(state));
  assert.equal(api.containerForWork(reloaded, work.id).capacity, 3);
  assert.equal(api.containerQuantity(api.containerForWork(reloaded, work.id), M.Water), 1);
  const uses = api.observeWorkAdoption(state.world.works.find((candidate) => candidate.id === work.id), facts, 1);
  assert(uses.userIds.includes(visitor.id));
  assert(uses.functionKeys.includes('stored-water-consumption'));
  assert(uses.functionKeys.includes('material-storage'));

  perform(builder, { kind: 'move', target: { kind: 'voxel', position: { x: 12, y: 12, z: 3 } }, withinDistance: 0 });
  const breached = perform(builder, { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position: { x: 12, y: 13, z: 2 } }] });
  assert.equal(api.containerForWork(state, work.id), undefined);
  const spilled = breached.diff.workStorageChanges.flatMap((change) => change.contents ?? []);
  const lostWater = spilled.find((item) => item.materialId === M.Water);
  assert.equal(lostWater.quantity, 1);
  assert.equal(lostWater.lost, true);
  assert(lostWater.sourceEventIds.includes(poured.id));
  assert(lostWater.sourceEventIds.includes(breached.id));
  const spilledFood = spilled.find((item) => item.materialId === M.Food);
  assert.equal(state.world.drops.find((drop) => drop.id === spilledFood.dropId).quantity, 1);
  assert(!state.world.drops.some((drop) => drop.materialId === M.Water), 'lost water is not a new infinite drinking voxel');
  assert.equal(facts.filter((fact) => fact.action.kind === 'act' && fact.action.operation === 'ingest').length + lostWater.quantity, 3);
  if (replayOutput) {
    writeFileSync(path.join(replayOutput, 'replay.json'), JSON.stringify({ version: 'eland-experiment-replay-v1', kind: 'controlled',
      label: '受控领域：黏土槽的有限储存、取用与破损（非自主演化）', frames }, null, 2));
    writeFileSync(path.join(replayOutput, 'provenance.json'), JSON.stringify({ kind: 'controlled-domain-regression',
      harness: 'scripts/test-work-storage.mjs', modelCalls: 0, choicesAndInitialMaterials: 'explicit fixtures',
      snapshots: 'actual intermediate domain states, not a stitched natural history' }, null, 2));
    console.log(`player replay: ${path.join(replayOutput, 'replay.json')}`);
  }
  console.log('controlled Work storage: real clay cavity → finite water transfer → other person withdraws/drinks → breach spills food and loses remaining water; public contents and provenance passed (zero model calls, not natural emergence)');
} finally { rmSync(temporary, { recursive: true, force: true }); }
