import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = mkdtempSync(path.join(tmpdir(), 'eland-support-settlement-'));
try {
  const bundle = path.join(temporary, 'support.mjs');
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=support-test.ts', `--outfile=${bundle}`, '--log-level=error',
  ], {
    input: `export { createInitialState } from './src/game/eland/simulation';
      export { executePrimitiveAction } from './src/game/eland/domain/action-executor';
      export { advanceWorldProcesses } from './src/game/eland/domain/monthly-processes';
      export { createWork, observeWorkAdoption } from './src/game/eland/domain/works';
      export { shelterGeometryAt } from './src/game/eland/domain/structure';
      export { rootedSolidPath, solidSupportQuery } from './src/game/eland/domain/solid-support';
      export { planWorkLayout } from './src/game/eland/domain/work-layout';
      export { constructionProjectStep } from './src/game/eland/application/projects/steps/construction';
      export { captureBodySupports, settleChangedBodySupports } from './src/game/eland/domain/actions/support-settlement';
      export { Material } from './src/game/eland/domain/material';
      export { cellId, setVoxel, isStandingPosition, findStandingPath } from './src/game/eland/world/grid';`,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const api = await import(pathToFileURL(bundle).href);
  const state = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  const [person, counterpart] = state.people;
  const grid = state.world.grid;
  const resetColumn = (x, y) => {
    for (let z = 0; z < grid.levels; z += 1) {
      api.setVoxel(grid, x, y, z, z === 0 ? api.Material.Stone : api.Material.Air);
    }
  };
  for (let x = 10; x <= 16; x += 1) for (let y = 10; y <= 16; y += 1) resetColumn(x, y);
  const position = (x, y, z) => ({ cellId: api.cellId(x, y), z });
  const stand = (who, at) => { who.position = { ...who.position, ...at }; };
  const removeSupport = (x, y, z, order) => {
    const target = { kind: 'voxel', position: { x, y, z } };
    return api.executePrimitiveAction(state, person, {
      kind: 'world-interact', adjudication: {
        version: 'world-adjudicated-interaction-v1', request: '收回脚下的木板', result: '移走木板',
        targets: [target], status: 'completed', effects: [{ kind: 'consume', target, quantity: 1 }],
      },
    }, 1, order, { cause: 'intent', actionTick: order });
  };

  // r3: an agent consumed the plank it had stepped onto. The same action
  // must settle everybody on that support before the next plan can move.
  api.setVoxel(grid, 12, 12, 1, api.Material.Plank);
  stand(person, position(12, 12, 2));
  stand(counterpart, position(12, 12, 2));
  const healthBefore = person.body.health;
  const fact = removeSupport(12, 12, 1, 1);
  assert.equal(fact.status, 'completed', fact.result);
  assert.equal(fact.fromZ, 2);
  assert.equal(fact.toZ, 1, 'the action receipt includes its physical consequence');
  assert.equal(person.position.cellId, api.cellId(12, 12), 'landing stays in the same column');
  assert.equal(person.body.health, healthBefore, 'one normal step down causes no impact injury');
  assert.equal(counterpart.position.z, 1, 'another person on the removed support falls too');
  assert.equal(fact.diff.supportSettlements.length, 2);
  for (const settlement of fact.diff.supportSettlements) {
    assert.deepEqual(settlement.sourceEventIds, [fact.id]);
    assert.equal(settlement.fallDistance, 1);
  }
  assert(counterpart.memories.some((memory) => memory.sourceEventIds.includes(fact.id)
    && memory.id.startsWith('memory:support-settlement:')));
  assert(api.isStandingPosition(grid, person.position));
  assert(api.findStandingPath(grid, person.position, position(13, 12, 1)).length > 1);
  const moved = api.executePrimitiveAction(state, person, {
    kind: 'move', toCellId: api.cellId(13, 12), toZ: 1,
  }, 1, 2, { cause: 'intent', actionTick: 2 });
  assert.notEqual(moved.status, 'blocked', moved.result);
  assert.equal(person.position.cellId, api.cellId(13, 12));
  assert.equal(moved.diff.supportSettlements, undefined, 'landing is not charged again next action');

  // A lower floor intercepts the fall; neither a higher surface nor the
  // bottom of the column can replace this first real collision.
  api.setVoxel(grid, 14, 14, 3, api.Material.Plank);
  api.setVoxel(grid, 14, 14, 6, api.Material.Plank);
  stand(person, position(14, 14, 7));
  const beforeFall = person.body.health;
  const fell = removeSupport(14, 14, 6, 3);
  assert.equal(fell.status, 'completed', fell.result);
  assert.equal(person.position.z, 4);
  assert.equal(fell.diff.supportSettlements[0].fallDistance, 3);
  assert(person.body.health < beforeFall, 'multi-voxel impact must have a real body consequence');
  assert.equal(fell.diff.supportSettlements[0].healthDamage, beforeFall - person.body.health);
  assert(person.conditions.some((condition) => condition.kind === 'wound'
    && condition.sourceEventIds.includes(fell.id)));

  resetColumn(14, 14);
  api.setVoxel(grid, 14, 14, 6, api.Material.Plank);
  stand(person, position(14, 14, 7));
  person.body.health = 5;
  const lethal = removeSupport(14, 14, 6, 4);
  assert.equal(person.body.health, 0, 'fall settlement cannot keep somebody artificially alive');
  assert.equal(lethal.toZ, 1);
  assert.equal(lethal.diff.supportSettlements[0].healthDamage, 5);

  // The shared natural-process path handles thaw through a real adjacent
  // foothold. It cannot seek a high/distant surface through solid material.
  stand(counterpart, position(12, 12, 2));
  api.setVoxel(grid, 12, 12, 1, api.Material.Ice);
  const supported = api.captureBodySupports(state);
  api.setVoxel(grid, 12, 12, 1, api.Material.Water);
  const thawed = api.settleChangedBodySupports(state, supported, 1, 'real-thaw-source');
  const thaw = thawed.find((settlement) => settlement.personId === counterpart.id);
  assert(thaw?.landed);
  assert.equal(thaw.to.z, 1);
  assert(api.isStandingPosition(grid, counterpart.position));
  assert.deepEqual(thaw.sourceEventIds, ['real-thaw-source']);
  assert.equal(person.body.health, 0, 'later support changes do not revive dead bodies');

  stand(counterpart, position(12, 12, 2));
  api.setVoxel(grid, 12, 12, 1, api.Material.Ice);
  for (const [x, y] of [[11, 12], [13, 12], [12, 11], [12, 13]]) {
    api.setVoxel(grid, x, y, 2, api.Material.Stone);
  }
  const enclosed = api.captureBodySupports(state);
  api.setVoxel(grid, 12, 12, 1, api.Material.Water);
  const stranded = api.settleChangedBodySupports(state, enclosed, 1, 'enclosed-thaw-source')
    .find((settlement) => settlement.personId === counterpart.id);
  assert.equal(stranded.landed, false, 'nearby land cannot be reached through surrounding solid walls');
  assert.deepEqual(stranded.to, stranded.from);

  resetColumn(15, 15);
  const rottenFloor = api.createWork({ position: { x: 15, y: 15, z: 1 }, arrangement: 'support',
    components: [{ materialId: api.Material.Plank, quantity: 2 }], summary: '已经腐坏的木架',
    builderId: counterpart.id, atMonth: 0, sourceEventId: 'built-wooden-frame' });
  rottenFloor.condition = 0;
  state.world.works = [rottenFloor];
  api.setVoxel(grid, 15, 15, 1, rottenFloor.anchorMaterialId);
  stand(counterpart, position(15, 15, 2));
  const collapseEvents = api.advanceWorldProcesses(state, 2);
  const collapse = collapseEvents.find((event) => event.change === 'work-collapse'
    && event.diff.workId === rottenFloor.id);
  assert(collapse, 'the actual collapse source is an environment event in this month');
  const collapseLanding = collapseEvents.find((event) => event.who === counterpart.id
    && event.diff.process === 'work-collapse-support-displacement');
  assert(collapseLanding?.diff.landed, 'monthly collapse settles the person on the removed frame');
  assert.deepEqual(collapseLanding.diff.sourceEventIds, [collapse.id]);
  assert.equal(counterpart.position.z, 1);
  assert(api.isStandingPosition(grid, counterpart.position));

  // Geometry, not a facility name or nearby activity, establishes actual
  // structural support. Start with a real three-voxel work in the world.
  const walkingState = api.createInitialState(17, { endpoint: { kind: 'months', value: 2 } });
  const walker = walkingState.people[0];
  const walkingGrid = walkingState.world.grid;
  for (let x = 10; x <= 16; x += 1) for (let y = 10; y <= 14; y += 1) {
    for (let z = 0; z < walkingGrid.levels; z += 1) api.setVoxel(walkingGrid, x, y, z,
      z === 0 ? api.Material.Stone : api.Material.Air);
  }
  walker.body = { health: 100, hydration: 100, nutrition: 100 };
  walker.conditions = [];
  const supportingWork = api.createWork({ position: { x: 12, y: 12, z: 1 }, arrangement: 'pile',
    components: [{ materialId: api.Material.Plank, quantity: 3 }], summary: '三份按位置放下的材料',
    builderId: walker.id, atMonth: 0, sourceEventId: 'laid-three-material-voxels',
    layout: { version: 'work-layout-v1', voxels: [0, 1, 2].map((x) => ({
      offset: { x, y: 0, z: 0 }, materialId: api.Material.Plank,
    })) } });
  walkingState.world.works = [supportingWork];
  for (const x of [12, 13, 14]) api.setVoxel(walkingGrid, x, 12, 1, api.Material.Plank);
  const walkingEvents = [];
  const walk = (x, y, z, cause = 'intent') => {
    const event = api.executePrimitiveAction(walkingState, walker, { kind: 'move', toCellId: api.cellId(x, y), toZ: z },
      1, 100 + walkingEvents.length, { cause, actionTick: walkingEvents.length + 1 });
    walkingEvents.push(event);
    return event;
  };
  stand(walker, position(11, 11, 1));
  const nearbyWalk = walk(14, 11, 1);
  assert.equal(nearbyWalk.status, 'completed');
  assert.equal(nearbyWalk.diff.workSupportUse, undefined, 'walking beside a work on natural ground does not use its support');
  assert.equal(supportingWork.useReceipts.length, 0);
  stand(walker, position(12, 12, 2));
  const justLooking = api.executePrimitiveAction(walkingState, walker, { kind: 'attend', target: { kind: 'work', workId: supportingWork.id } },
    1, 99, { cause: 'intent', actionTick: 1 });
  assert.equal(justLooking.status, 'completed');
  assert.equal(justLooking.diff.workUseReceipts, undefined, 'even looking while on the work is not a walking receipt');
  assert.equal(supportingWork.useReceipts.length, 0);

  stand(walker, position(11, 12, 1));
  const supportedWalk = walk(12, 12, 2);
  assert.equal(supportedWalk.status, 'completed', supportedWalk.result);
  const use = supportedWalk.diff.workUseReceipts[0];
  assert.equal(use.workId, supportingWork.id);
  assert.equal(use.actorId, walker.id);
  assert.equal(use.sourceEventId, supportedWalk.id);
  assert.equal(use.functionKey, 'body-support');
  assert.equal(use.cause, 'intent');
  assert.deepEqual(use.positions, [{ x: 12, y: 12, z: 2 }]);
  assert.deepEqual(supportedWalk.diff.workSupportUse[0].contacts[0].supportPosition, { x: 12, y: 12, z: 1 });
  const reflexWalk = walk(14, 12, 2, 'survival-reflex');
  assert.equal(reflexWalk.status, 'completed', reflexWalk.result);
  assert.equal(reflexWalk.diff.workUseReceipts[0].cause, 'survival-reflex', 'protective movement retains its actual cause');
  assert(reflexWalk.diff.workUseReceipts[0].positions.some((pose) => pose.x === 13 && pose.y === 12 && pose.z === 2),
    'the non-anchor layout voxel can provide real support');
  assert.equal(api.observeWorkAdoption(supportingWork, walkingEvents, 1).receipts.length, 2);
  const wrongHeight = structuredClone(supportedWalk);
  wrongHeight.diff.verticalPath = wrongHeight.diff.verticalPath.map(() => 1);
  assert.equal(api.observeWorkAdoption(supportingWork, [wrongHeight], 1).receipts.length, 0,
    'a cached receipt must match the actual vertical walking path, not just horizontal proximity');

  const receiptsBeforeRemoval = supportingWork.useReceipts.length;
  for (const x of [12, 13, 14]) api.setVoxel(walkingGrid, x, 12, 1, api.Material.Air);
  stand(walker, position(11, 12, 1));
  const afterRemoval = walk(12, 12, 1);
  assert.equal(afterRemoval.status, 'completed');
  assert.equal(afterRemoval.diff.workSupportUse, undefined);
  // Natural material at the former height also cannot inherit the old Work.
  api.setVoxel(walkingGrid, 14, 12, 1, api.Material.Stone);
  stand(walker, position(14, 11, 1));
  const replacementGround = walk(14, 12, 2);
  assert.equal(replacementGround.status, 'completed');
  assert.equal(replacementGround.diff.workSupportUse, undefined);
  assert.equal(supportingWork.useReceipts.length, receiptsBeforeRemoval, 'missing or replaced work support creates no new use');
  assert.equal(api.observeWorkAdoption(supportingWork, walkingEvents, 1).receipts.length, 2,
    'later removal does not erase the sourced historical uses that really happened');
  assert.equal(walkingState.projects.length, 0);
  assert(!walker.knowledge.some((knowledge) => knowledge.kind === 'technique'));

  // A roof with a floating neighbour is still floating. All three consumers
  // (shelter, free layouts and native installation) use the same ground chain.
  const rootedState = api.createInitialState(17, { endpoint: { kind: 'months', value: 2 } });
  const builder = rootedState.people[0];
  const rootedGrid = rootedState.world.grid;
  for (let x = 10; x <= 16; x += 1) for (let y = 10; y <= 16; y += 1) {
    for (let z = 0; z < rootedGrid.levels; z += 1) api.setVoxel(rootedGrid, x, y, z,
      z === 0 ? api.Material.Stone : api.Material.Air);
  }
  const room = position(12, 12, 1), roof = { x: 12, y: 12, z: 3 };
  stand(builder, room);
  api.setVoxel(rootedGrid, 12, 12, 3, api.Material.Plank);
  assert.equal(api.shelterGeometryAt(rootedGrid, room), null, 'the old isolated overhead plank cannot provide shelter');
  api.setVoxel(rootedGrid, 13, 12, 3, api.Material.Plank);
  api.setVoxel(rootedGrid, 13, 12, 2, api.Material.Plank);
  const querySupport = api.solidSupportQuery(rootedGrid);
  assert.equal(querySupport(roof), null, 'a whole floating connected cluster has no root');
  assert.equal(api.shelterGeometryAt(rootedGrid, room), null);
  api.setVoxel(rootedGrid, 12, 12, 3, api.Material.Air);
  const proposedRoof = () => api.planWorkLayout({ grid: rootedGrid, position: roof, anchorMaterialId: api.Material.Plank,
    components: [{ materialId: api.Material.Plank, quantity: 1 }], otherWorks: [], people: [] });
  assert.equal(proposedRoof().ok, false, 'an external floating cluster cannot support a newly proposed Work');
  builder.inventory = [{ id: 'one-real-roof-material', materialId: api.Material.Wood, quantity: 1, sourceEventIds: [] }];
  const installRoof = { kind: 'act', operation: 'combine', targets: [
    { kind: 'inventory-stack', personId: builder.id, stackId: 'one-real-roof-material' },
    { kind: 'voxel', position: roof },
  ] };
  const rejectedRoof = api.executePrimitiveAction(rootedState, builder, installRoof, 1, 201, { cause: 'intent', actionTick: 1 });
  assert.equal(rejectedRoof.status, 'blocked');
  assert.equal(rejectedRoof.diff.unsupportedPlacement, true);
  assert.equal(builder.inventory[0].quantity, 1, 'invalid support cannot consume a material portion');
  api.setVoxel(rootedGrid, 13, 12, 1, api.Material.Plank);
  assert.equal(proposedRoof().ok, true);
  const installedRoof = api.executePrimitiveAction(rootedState, builder, installRoof, 1, 202, { cause: 'intent', actionTick: 2 });
  assert.equal(installedRoof.status, 'completed', installedRoof.result);
  const rootedPath = querySupport(roof);
  assert(rootedPath, 'the same query notices newly grounded matter after the voxel revision changes');
  assert.equal(rootedPath.at(-1).z, 0);
  for (let index = 1; index < rootedPath.length; index += 1) {
    const before = rootedPath[index - 1], after = rootedPath[index];
    assert.equal(Math.abs(before.x - after.x) + Math.abs(before.y - after.y) + Math.abs(before.z - after.z), 1);
  }
  assert(api.shelterGeometryAt(rootedGrid, room));
  api.setVoxel(rootedGrid, 13, 12, 1, api.Material.Air);
  assert.equal(querySupport(roof), null, 'removing the root invalidates the cached supporting chain');
  assert.equal(api.shelterGeometryAt(rootedGrid, room), null, 'the damaged floating roof loses its protection');

  // The kernel construction fallback now pays for a fourth, same-height
  // connection before the roof; it cannot count three disconnected planks.
  const templateState = api.createInitialState(17, { endpoint: { kind: 'months', value: 2 } });
  const templateBuilder = templateState.people[0];
  for (let x = 10; x <= 16; x += 1) for (let y = 10; y <= 16; y += 1) {
    for (let z = 0; z < templateState.world.grid.levels; z += 1) api.setVoxel(templateState.world.grid, x, y, z,
      z === 0 ? api.Material.Stone : api.Material.Air);
  }
  stand(templateBuilder, room);
  templateBuilder.inventory = [{ id: 'three-template-materials', materialId: api.Material.Wood, quantity: 3, sourceEventIds: [] }];
  const additionalMaterial = { id: 'actual-fourth-material', materialId: api.Material.Wood, quantity: 1,
    cellId: room.cellId, z: room.z, createdAtMonth: 0, sourceEventIds: [] };
  templateState.world.drops = [additionalMaterial];
  const project = { id: 'rooted-shelter-project', kind: 'construction', need: 'shelter-capacity', desiredFunction: 'weather-shelter',
    ownerId: templateBuilder.id, summary: '补足一处能够进入的遮蔽位置', site: room, createdAtMonth: 1,
    status: 'active', actionEventIds: [], triggerFactIds: [], beneficiaryIds: [templateBuilder.id] };
  const templateEvents = [];
  for (let tick = 1; !api.shelterGeometryAt(templateState.world.grid, room) && tick <= 8; tick += 1) {
    const step = api.constructionProjectStep(templateState, templateBuilder, templateState.world.drops, project);
    assert(step, 'the next real material placement or acquisition remains available');
    const event = api.executePrimitiveAction(templateState, templateBuilder, step.action, 1, 220 + tick,
      { cause: 'intent', actionTick: tick });
    assert.equal(event.status, 'completed', event.result);
    templateEvents.push(event);
    templateState.world.past.push(event);
    project.actionEventIds.push(event.id);
    if (templateEvents.filter((fact) => fact.action.kind === 'act').length === 3) {
      assert.equal(api.shelterGeometryAt(templateState.world.grid, room), null, 'three paid placements still lack the connected roof');
    }
  }
  const placements = templateEvents.filter((fact) => fact.action.kind === 'act');
  assert.equal(placements.length, 4);
  const acquired = templateEvents.filter((fact) => fact.action.kind === 'transfer');
  assert.equal(acquired.length, 1);
  assert.equal(acquired[0].action.dropId, additionalMaterial.id);
  assert.equal(acquired[0].diff.quantity, 1);
  assert.equal(templateState.world.drops.length, 0);
  assert.equal(templateBuilder.inventory.length, 0);
  const shelter = api.shelterGeometryAt(templateState.world.grid, room);
  assert(shelter && shelter.openSides >= 1);
  assert(api.isStandingPosition(templateState.world.grid, room));
  assert(api.findStandingPath(templateState.world.grid, position(12, 11, 1), room).length > 1,
    'the material-supported completed shape retains a real body entrance');
  assert(api.rootedSolidPath(templateState.world.grid, { x: 12, y: 12, z: 3 }));
  console.log('support settlement: consumed floor → sourced landing → next movement; first floor collision, injury, lethal fall and thaw passed');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
