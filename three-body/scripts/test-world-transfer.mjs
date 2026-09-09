import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = mkdtempSync(path.join(tmpdir(), 'eland-world-transfer-'));
try {
  const bundle = path.join(temporary, 'transfer.mjs');
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=transfer-test.ts', `--outfile=${bundle}`, '--log-level=error',
  ], {
    input: `export { createInitialState, buildDecisionContexts } from './src/game/eland/simulation';
      export { executePrimitiveAction } from './src/game/eland/domain/action-executor';
      export { recompileNextAction } from './src/game/eland/application/action-options';
      export { compileNativeOperation } from './src/game/eland/application/native-operation';
      export { buildDecisionRequestContext } from './src/game/eland/application/model-decision/decision-context';
      export { buildDecisionProbeHandleMap, buildCharacterAgendaProbeCandidates } from './src/game/eland/application/model-decision/capability-handles';
      export { Material } from './src/game/eland/domain/material';
      export { cellId, setVoxel } from './src/game/eland/world/grid';`,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const api = await import(pathToFileURL(bundle).href);
  const state = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  const [actor, owner] = state.people;
  const grid = state.world.grid;
  for (let x = 8; x <= 18; x += 1) for (let y = 8; y <= 18; y += 1) {
    for (let z = 0; z < grid.levels; z += 1) {
      api.setVoxel(grid, x, y, z, z === 0 ? api.Material.Stone : api.Material.Air);
    }
  }
  const stand = (person, x, y) => { person.position = { ...person.position, cellId: api.cellId(x, y), z: 1 }; };
  stand(actor, 12, 12);
  stand(owner, 13, 12);
  actor.body = { health: 100, hydration: 100, nutrition: 100 };
  owner.body = { health: 100, hydration: 100, nutrition: 100 };
  owner.inventory = [api.Material.Wood, api.Material.Stone, api.Material.Food].map((materialId, index) => ({
    id: `owner-stack-${index}`, materialId, quantity: 2, sourceEventIds: ['original-material-source'],
  }));
  const quantity = (person, material) => person.inventory.filter((stack) => stack.materialId === material)
    .reduce((total, stack) => total + stack.quantity, 0);
  const context = () => api.buildDecisionContexts(state, 1).find((candidate) => candidate.person.id === actor.id);
  const third = context().options.find((option) => option.id === `take-without-permission:${owner.id}:owner-stack-2`);
  assert(third, 'adjacent visible owners expose the third stack as well as the first two');
  assert.equal(third.nextAction.kind, 'transfer');
  stand(owner, 16, 12);
  assert(!context().options.some((option) => option.id.startsWith(`take-without-permission:${owner.id}:`)),
    'far-away private inventory is not exposed as newly observed taking options');
  const chosen = { ...third, id: 'chosen-taking', ownerId: actor.id, status: 'active',
    createdAtMonth: 1, lastProgressAtMonth: 1, progress: 0, sourceDecisionEventId: 'real-choice',
    actionEventIds: [], replanCount: 0 };
  const approach = api.recompileNextAction(state, actor, chosen, 1);
  assert.equal(approach.kind, 'move');
  assert.notEqual(approach.toCellId, owner.position.cellId, 'rendezvous does not require overlapping bodies');
  api.executePrimitiveAction(state, actor, approach, 1, 1, { cause: 'intent', actionTick: 1 });
  chosen.nextAction = approach;
  assert.equal(api.recompileNextAction(state, actor, chosen, 1).kind, 'transfer', 'the exact chosen stack survives approach');

  stand(actor, 12, 12);
  stand(owner, 13, 12);
  let order = 2;
  const transfer = (target, destination, requestedQuantity, extra = []) => api.executePrimitiveAction(state, actor, {
    kind: 'world-interact', adjudication: {
      version: 'world-adjudicated-interaction-v1', request: '尝试拿取或交付点名的实物', result: '拟议取放',
      targets: [target, destination], status: 'completed', effects: [
        { kind: 'transfer', target, destination, quantity: requestedQuantity }, ...extra,
      ],
    },
  }, 1, order++, { cause: 'intent', actionTick: 2 });
  const thirdRef = { kind: 'inventory-stack', personId: owner.id, stackId: 'owner-stack-2' };
  const self = { kind: 'person', personId: actor.id };
  actor.baselineCapacities.manipulation = 1;
  actor.baselineCapacities.locomotion = 1;
  owner.baselineCapacities.perception = 100;
  owner.baselineCapacities.manipulation = 100;
  const foodBefore = quantity(actor, api.Material.Food) + quantity(owner, api.Material.Food);
  const rejected = transfer(thirdRef, self, 999, [
    { kind: 'produce', materialId: api.Material.Stone, quantity: 8, destination: 'inventory' },
  ]);
  assert.equal(rejected.status, 'blocked');
  assert.equal(rejected.diff.resistedBy, owner.id);
  assert(rejected.diff.takingContest);
  assert.equal(quantity(owner, api.Material.Food), 2);
  assert.equal(rejected.diff.deferredEffects.length, 1);
  assert(!rejected.diff.appliedEffects.some((effect) => effect.kind === 'produce'), 'resistance cannot be followed by invented production');
  assert(owner.memories.some((memory) => memory.sourceEventIds.includes(rejected.id)), 'the affected holder remembers the attempt');

  actor.baselineCapacities.manipulation = 100;
  actor.baselineCapacities.locomotion = 100;
  owner.baselineCapacities.perception = 1;
  owner.baselineCapacities.manipulation = 1;
  const taken = transfer(thirdRef, self, 999, [
    { kind: 'produce', materialId: api.Material.Stone, quantity: 8, destination: 'inventory' },
  ]);
  assert.equal(taken.status, 'completed', taken.result);
  assert.equal(taken.diff.quantity, 2, 'native availability caps the actual quantity, not a magic World maximum');
  assert.equal(taken.diff.authorized, false);
  assert(taken.diff.takingContest);
  assert.equal(taken.diff.transferStepResolved, true);
  assert.equal(taken.diff.deferredEffects.length, 1, 'further processing needs the actual taking receipt first');
  assert.equal(quantity(actor, api.Material.Food) + quantity(owner, api.Material.Food), foodBefore);
  assert.equal(owner.inventory.some((stack) => stack.id === thirdRef.stackId), false);
  assert.match(taken.result, /未经授权/);

  actor.inventory.push({ id: 'giving-stone', materialId: api.Material.Stone, quantity: 12, sourceEventIds: ['quarried-stone'] });
  const stoneRef = { kind: 'inventory-stack', personId: actor.id, stackId: 'giving-stone' };
  const recipient = { kind: 'person', personId: owner.id };
  const given = transfer(stoneRef, recipient, 10);
  assert.equal(given.status, 'completed', given.result);
  assert.equal(given.diff.quantity, 10, 'physical transfer may exceed eight existing items');
  assert.equal(given.diff.authorized, true);
  const place = { kind: 'voxel', position: { x: 12, y: 13, z: 0 } };
  const put = transfer(stoneRef, place, 2);
  assert.equal(put.status, 'completed', put.result);
  const placed = state.world.drops.find((drop) => drop.sourceEventIds.includes(put.id));
  assert.equal(placed.cellId, api.cellId(12, 13));
  assert.equal(placed.z, 1, 'ground placement uses the real free space above the named surface');
  const pickedUp = transfer({ kind: 'drop', dropId: placed.id }, self, 2);
  assert.equal(pickedUp.status, 'completed', pickedUp.result);

  const nativeTransfer = (action) => api.executePrimitiveAction(state, actor, action, 1, order++, { cause: 'intent', actionTick: 2 });
  const namedWood = { id: 'named-wood-not-food', materialId: api.Material.Wood, quantity: 2,
    sourceEventIds: ['actual-wood-source'] };
  actor.inventory.push(namedWood);
  const wrongMaterialRequest = { kind: 'transfer', materialId: api.Material.Food, quantity: 1,
    stackId: namedWood.id, from: self, to: { kind: 'ground', cellId: actor.position.cellId, z: actor.position.z } };
  const beforeWrongMaterial = structuredClone({ actorInventory: actor.inventory, ownerInventory: owner.inventory,
    drops: state.world.drops, records: state.records });
  const wrongMaterial = nativeTransfer(wrongMaterialRequest);
  assert.equal(wrongMaterial.status, 'blocked');
  assert.match(wrongMaterial.result, /实际是2份木材.*请求转移1份食物.*没有转移物品/);
  assert.equal(wrongMaterial.diff.sourceStackId, namedWood.id);
  assert.equal(wrongMaterial.diff.actualMaterialId, api.Material.Wood);
  assert.equal(wrongMaterial.diff.requestedMaterialId, api.Material.Food);
  assert.deepEqual({ actorInventory: actor.inventory, ownerInventory: owner.inventory,
    drops: state.world.drops, records: state.records }, beforeWrongMaterial, 'explaining the mismatch cannot replace, consume or transfer any material');
  namedWood.quantity = 0;
  const exhaustedSource = nativeTransfer(wrongMaterialRequest);
  assert.match(exhaustedSource.result, /已经耗尽/);
  assert.equal(exhaustedSource.diff.transferSourceMismatch, undefined, 'an exhausted source is not misreported as a material mismatch');
  actor.inventory = actor.inventory.filter((stack) => stack.id !== namedWood.id);
  const missingSource = nativeTransfer(wrongMaterialRequest);
  assert.match(missingSource.result, /已经不存在/);
  assert.equal(missingSource.diff.transferSourceMismatch, undefined);
  const heldBeforeSelfTransfer = structuredClone(actor.inventory);
  const personalEffectsBefore = structuredClone({ knowledge: actor.knowledge, cognition: actor.cognition,
    memories: actor.memories, relations: actor.relations, records: state.records,
    agreements: state.agreements, permissions: state.permissions });
  const ration = actor.inventory.find((stack) => stack.materialId === api.Material.Food && stack.quantity > 0);
  const selfTransfer = nativeTransfer({ kind: 'transfer', materialId: ration.materialId, quantity: ration.quantity,
    stackId: ration.id, from: self, to: self });
  assert.equal(selfTransfer.status, 'completed');
  assert.equal(selfTransfer.diff.quantity, 0, 'same-holder attempts move no units');
  assert.equal(selfTransfer.diff.transferNoChange, true);
  assert.match(selfTransfer.result, /没有转移物品/);
  assert.deepEqual(actor.inventory, heldBeforeSelfTransfer, 'self-transfer preserves ration identity and all provenance');
  assert.deepEqual({ knowledge: actor.knowledge, cognition: actor.cognition, memories: actor.memories,
    relations: actor.relations, records: state.records, agreements: state.agreements, permissions: state.permissions },
    personalEffectsBefore, 'a no-change attempt creates no learned transfer, delivery or social accomplishment');
  const worldSelfTransfer = transfer({ kind: 'inventory-stack', personId: actor.id, stackId: ration.id }, self, ration.quantity);
  assert.equal(worldSelfTransfer.diff.transferNoChange, true, 'World uses the same native no-change result');
  assert.equal(worldSelfTransfer.diff.quantity, 0);
  assert.deepEqual(actor.inventory, heldBeforeSelfTransfer);

  const storedRecord = { id: 'unchanged-record-stack', materialId: api.Material.Wood, quantity: 2,
    recordPayloadId: 'unchanged-record-payload', sourceEventIds: ['written-record-source'] };
  const containerA = { id: 'container-a', position: { x: 11, y: 12, z: 1 }, inventory: [storedRecord],
    capacity: 2, createdAtMonth: 1, sourceEventIds: ['container-built-a'] };
  const containerB = { id: 'container-b', position: { x: 12, y: 13, z: 1 }, inventory: [],
    capacity: 2, createdAtMonth: 1, sourceEventIds: ['container-built-b'] };
  for (const container of [containerA, containerB]) {
    api.setVoxel(grid, container.position.x, container.position.y, container.position.z, api.Material.Container);
    state.containers.push(container);
  }
  const containerBefore = structuredClone(containerA);
  const containerSelfTransfer = nativeTransfer({ kind: 'transfer', materialId: storedRecord.materialId, quantity: 2,
    stackId: storedRecord.id, from: { kind: 'container', containerId: containerA.id }, to: { kind: 'container', containerId: containerA.id } });
  assert.equal(containerSelfTransfer.status, 'completed', 'a same-container no-op does not require spare capacity');
  assert.equal(containerSelfTransfer.diff.quantity, 0);
  assert.deepEqual(containerA, containerBefore, 'record payload and stack identity remain unchanged');
  const reorganized = nativeTransfer({ kind: 'transfer', materialId: storedRecord.materialId, quantity: 1,
    stackId: storedRecord.id, from: { kind: 'container', containerId: containerA.id }, to: { kind: 'container', containerId: containerB.id } });
  assert.equal(reorganized.diff.quantity, 1, 'different containers remain real distinct locations even when used by the same person');
  assert.equal(containerA.inventory[0].quantity, 1);
  assert.equal(containerB.inventory[0].recordPayloadId, storedRecord.recordPayloadId);
  for (const container of [containerA, containerB]) api.setVoxel(grid, container.position.x, container.position.y, container.position.z, api.Material.Air);
  state.containers = state.containers.filter((container) => container.id !== containerA.id && container.id !== containerB.id);

  const stationaryDrop = { id: 'same-place-delivery', materialId: api.Material.Stone, quantity: 2,
    cellId: actor.position.cellId, z: actor.position.z, createdAtMonth: 1, sourceEventIds: ['original-delivery'],
    projectMaterialDelivery: { version: 'project-material-delivery-v1', projectId: 'delivery-project', requestEventId: 'delivery-request',
      requesterId: owner.id, expiresAtMonth: 2 } };
  state.world.drops.push(stationaryDrop);
  const groundBefore = structuredClone(state.world.drops);
  const groundSelfTransfer = nativeTransfer({ kind: 'transfer', materialId: stationaryDrop.materialId, quantity: 2,
    dropId: stationaryDrop.id, from: { kind: 'ground', cellId: stationaryDrop.cellId, z: stationaryDrop.z },
    to: { kind: 'ground', cellId: stationaryDrop.cellId, z: stationaryDrop.z } });
  assert.equal(groundSelfTransfer.diff.quantity, 0);
  assert.equal(groundSelfTransfer.diff.projectMaterialDeliveryUses, undefined);
  assert.deepEqual(state.world.drops, groundBefore, 'the same physical pile is not recreated, split or reported as delivered');

  // One physical portion bends and fragments without turning into a recipe
  // output. Its state must survive the existing possession/ground/container path.
  const bendState = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  const [bender, receiver] = bendState.people;
  for (let x = 10; x <= 15; x += 1) for (let y = 10; y <= 15; y += 1) {
    for (let z = 0; z < bendState.world.grid.levels; z += 1) api.setVoxel(bendState.world.grid, x, y, z,
      z === 0 ? api.Material.Stone : api.Material.Air);
  }
  stand(bender, 12, 12); stand(receiver, 13, 12);
  bender.body = { health: 100, hydration: 100, nutrition: 100 };
  bender.conditions = [];
  bender.baselineCapacities.manipulation = 50;
  bender.inventory = [
    { id: 'three-wood-portions', materialId: api.Material.Wood, quantity: 3, sourceEventIds: ['original-wood'] },
    { id: 'stone-comparison', materialId: api.Material.Stone, quantity: 1, sourceEventIds: ['original-stone'] },
    { id: 'unsupported-water', materialId: api.Material.Water, quantity: 1, sourceEventIds: [] },
  ];
  receiver.inventory = [{ id: 'receiver-intact-wood', materialId: api.Material.Wood, quantity: 2, sourceEventIds: [] }];
  const originalKnowledge = bender.knowledge.filter((fact) => fact.kind === 'technique').length;
  let bendOrder = 200;
  const physical = (person, action) => {
    const fact = api.executePrimitiveAction(bendState, person, action, 1, bendOrder++, { cause: 'intent', actionTick: 3 });
    bendState.world.past.push(fact);
    return fact;
  };
  const bend = (stackId) => physical(bender, { kind: 'act', operation: 'exert',
    targets: [{ kind: 'inventory-stack', personId: bender.id, stackId }] });
  const unsupportedBefore = structuredClone(bender.inventory);
  assert.equal(bend('unsupported-water').status, 'blocked');
  assert.deepEqual(bender.inventory, unsupportedBefore, 'missing bend parameters cannot fabricate a physical response');
  const stoneBend = bend('stone-comparison');
  assert.equal(stoneBend.status, 'completed', stoneBend.result);
  assert(stoneBend.diff.mechanicalResponse.appliedLoad > 0);
  assert(stoneBend.diff.mechanicalResponse.peakDisplacement > 0, 'an elastic trial has a computed response even when it recovers');
  assert.equal(stoneBend.diff.mechanicalCondition.shape, 'unchanged');
  const contextForBender = () => api.buildDecisionContexts(bendState, 1).find((context) => context.person.id === bender.id);
  const chosenBend = { kind: 'act', operation: 'exert',
    targets: [{ kind: 'inventory-stack', personId: bender.id, stackId: 'three-wood-portions' }] };
  const compiledBend = api.compileNativeOperation({ ...contextForBender(), options: [], followUpOptions: [] }, chosenBend, 'bend-one-portion');
  assert(compiledBend.ok, JSON.stringify(compiledBend.problem));
  assert.equal(api.compileNativeOperation({ ...contextForBender(), options: [], followUpOptions: [] },
    { ...chosenBend, tool: { kind: 'inventory-stack', personId: bender.id, stackId: 'stone-comparison' } }, 'not-bare-handed').ok, false);
  const bodyBeforeBend = structuredClone(bender.body);
  let woodBend = physical(bender, compiledBend.option.nextAction);
  assert.equal(woodBend.status, 'completed', woodBend.result);
  assert.equal(woodBend.diff.mechanicalCondition.shape, 'bent');
  assert(woodBend.diff.mechanicalResponse.peakDisplacement > stoneBend.diff.mechanicalResponse.peakDisplacement,
    'different actual materials respond differently to the same body load');
  assert(woodBend.diff.mechanicalResponse.residualIncrement > 0);
  assert.equal(bender.inventory.find((stack) => stack.id === 'three-wood-portions').quantity, 2);
  const affectedId = woodBend.diff.affectedStackId;
  assert.notEqual(affectedId, 'three-wood-portions');
  assert.equal(quantity(bender, api.Material.Wood), 3);
  assert.deepEqual(bender.body, bodyBeforeBend, 'the material solver cannot double-charge existing act/body accounting');
  bender.baselineCapacities.manipulation = 100;
  for (let attempt = 0; woodBend.diff.mechanicalCondition.shape !== 'fragmented' && attempt < 5; attempt += 1) {
    const prior = structuredClone(bender.inventory.find((stack) => stack.id === affectedId).mechanicalState);
    woodBend = bend(affectedId);
    assert.deepEqual(woodBend.diff.mechanicalResponse.before, prior, 'another attempt uses this same portion\'s real residual state');
    assert.equal(quantity(bender, api.Material.Wood), 3);
    assert(woodBend.diff.mechanicalResponse.mechanicalWork <= 8, 'one ordinary episode bounds the physical work');
  }
  assert.equal(woodBend.diff.mechanicalCondition.shape, 'fragmented');
  const brokenState = structuredClone(bender.inventory.find((stack) => stack.id === affectedId).mechanicalState);
  assert.equal(brokenState.segments.reduce((sum, segment) => sum + segment.massFraction, 0), 1);
  assert.equal(bender.knowledge.filter((fact) => fact.id === `observation:held-bend:${affectedId}`).length, 1,
    'repeating the same sample updates its observation instead of manufacturing a technique or new knowledge every tick');
  assert.equal(bender.knowledge.filter((fact) => fact.kind === 'technique').length, originalKnowledge);
  assert(!/归一化|载荷\d|挠度/.test(woodBend.result), 'the actor receives qualitative experience, not internal solver measurements');
  const requestWithFragments = api.buildDecisionRequestContext(contextForBender());
  const publicBend = requestWithFragments.person.inventory.find((stack) => stack.stackId === affectedId);
  assert.equal(publicBend.mechanicalCondition.shape, 'fragmented');
  const bendHandles = api.buildDecisionProbeHandleMap(requestWithFragments);
  const bendCandidates = api.buildCharacterAgendaProbeCandidates(requestWithFragments, bendHandles);
  assert(bendCandidates.held.some((entry) => entry.mechanicalCondition?.shape === 'fragmented'));

  const benderRef = { kind: 'person', personId: bender.id }, receiverRef = { kind: 'person', personId: receiver.id };
  const sendBroken = physical(bender, { kind: 'transfer', materialId: api.Material.Wood, quantity: 1,
    stackId: affectedId, from: benderRef, to: receiverRef });
  assert.equal(sendBroken.status, 'completed', sendBroken.result);
  const receivedBroken = receiver.inventory.find((stack) => stack.mechanicalState);
  assert.deepEqual(receivedBroken.mechanicalState, brokenState);
  assert.equal(receiver.inventory.find((stack) => stack.id === 'receiver-intact-wood').quantity, 2);
  bendState.world.drops = [{ id: 'ground-intact-wood', materialId: api.Material.Wood, quantity: 5,
    cellId: bender.position.cellId, z: 1, createdAtMonth: 0, sourceEventIds: [] }];
  const setDown = physical(receiver, { kind: 'transfer', materialId: api.Material.Wood, quantity: 1,
    stackId: receivedBroken.id, from: receiverRef, to: { kind: 'ground', cellId: bender.position.cellId, z: 1 } });
  assert.equal(setDown.status, 'completed', setDown.result);
  const brokenDrop = bendState.world.drops.find((drop) => drop.mechanicalState);
  assert.deepEqual(brokenDrop.mechanicalState, brokenState);
  assert.equal(bendState.world.drops.find((drop) => drop.id === 'ground-intact-wood').quantity, 5);
  const storage = { id: 'fragment-storage', position: { x: 12, y: 13, z: 1 },
    inventory: [{ id: 'stored-intact-wood', materialId: api.Material.Wood, quantity: 3, sourceEventIds: [] }],
    capacity: 10, createdAtMonth: 1, sourceEventIds: [] };
  bendState.containers.push(storage);
  api.setVoxel(bendState.world.grid, 12, 13, 1, api.Material.Container);
  const storeFragments = physical(bender, { kind: 'transfer', materialId: api.Material.Wood, quantity: 1,
    dropId: brokenDrop.id, from: { kind: 'ground', cellId: brokenDrop.cellId, z: brokenDrop.z },
    to: { kind: 'container', containerId: storage.id } });
  assert.equal(storeFragments.status, 'completed', storeFragments.result);
  const storedBroken = storage.inventory.find((stack) => stack.mechanicalState);
  assert.deepEqual(storedBroken.mechanicalState, brokenState);
  assert.equal(storage.inventory.find((stack) => stack.id === 'stored-intact-wood').quantity, 3);
  const reclaimFragments = physical(bender, { kind: 'transfer', materialId: api.Material.Wood, quantity: 1,
    stackId: storedBroken.id, from: { kind: 'container', containerId: storage.id }, to: benderRef });
  assert.equal(reclaimFragments.status, 'completed', reclaimFragments.result);
  const returnedBroken = bender.inventory.find((stack) => stack.mechanicalState?.segments.length > 1);
  assert.deepEqual(returnedBroken.mechanicalState, brokenState);
  assert(returnedBroken.sourceEventIds.includes(woodBend.id) && returnedBroken.sourceEventIds.includes(reclaimFragments.id));
  assert.equal(quantity(bender, api.Material.Wood) + quantity(receiver, api.Material.Wood)
    + storage.inventory.reduce((sum, stack) => sum + stack.quantity, 0)
    + bendState.world.drops.reduce((sum, drop) => sum + drop.quantity, 0), 13, 'splitting, giving, dropping and storing conserve all wood portions');
  const segmentTrial = bend(returnedBroken.id);
  assert.deepEqual(segmentTrial.diff.mechanicalResponse.before, brokenState);
  assert.equal(segmentTrial.diff.mechanicalResponse.before.segments[segmentTrial.diff.mechanicalResponse.segmentIndex].massFraction, 0.5,
    'a later bend grips a real connected fragment, not the vanished original full length');
  assert(!bender.inventory.some((stack) => [api.Material.Fiber, api.Material.StoneTool, api.Material.WoodTablet].includes(stack.materialId)));
  assert.equal(bendState.world.works?.length ?? 0, 0);

  stand(actor, 11, 12);
  for (const [x, y] of [[12, 12], [14, 12], [13, 11], [13, 13]]) {
    api.setVoxel(grid, x, y, 1, api.Material.Stone);
    api.setVoxel(grid, x, y, 2, api.Material.Stone);
  }
  const isolatedRef = { kind: 'inventory-stack', personId: owner.id, stackId: 'owner-stack-0' };
  const blocked = transfer(isolatedRef, self, 1);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.diff.worldAdjudicatedNoPath, true, 'an observed ref does not let hands pass through walls');
  assert.equal(quantity(owner, api.Material.Wood), 2);
  console.log('world transfer: all visible stacks, physical rendezvous, resistance, real quantities, deferred processing and four transfer directions passed');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
