import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-food-reserve-use-'));
const bundlePath = path.join(temporaryDirectory, 'food-reserve-use.mjs');

try {
  const entry = `
    export { createInitialState, stepSimulation } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { buildContainerOptions } from ${JSON.stringify(path.resolve('src/game/eland/application/container-options.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.resolve('src/game/eland/domain/project.ts'))};
    export { recordProjectAction, recompileProjectNextAction } from ${JSON.stringify(path.resolve('src/game/eland/application/project-options.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export { chooseDependentCareReflex } from ${JSON.stringify(path.resolve('src/game/eland/domain/dependent-care.ts'))};
    export { chooseHibernationRecoveryReflex, chooseSurvivalReflex } from ${JSON.stringify(path.resolve('src/game/eland/domain/survival-reflex.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { cellId, cellX, cellY, cellsInRadius, setVoxel } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=food-reserve-use-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    buildContainerOptions,
    cellId,
    cellX,
    cellY,
    cellsInRadius,
    chooseDependentCareReflex,
    chooseHibernationRecoveryReflex,
    chooseSurvivalReflex,
    createInitialState,
    executePrimitiveAction,
    instantiateProject,
    recordProjectAction,
    recompileProjectNextAction,
    setVoxel,
    stepSimulation,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  function createFixture(seed) {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
    const actor = state.people[0];
    assert.ok(actor, '专项夹具需要至少一名人物');
    const center = cellId(42, 26);
    for (const localCell of cellsInRadius(center, 14)) {
      const x = cellX(localCell);
      const y = cellY(localCell);
      for (let z = 0; z < state.world.grid.levels; z += 1) {
        setVoxel(state.world.grid, x, y, z, z === 0 ? Material.PackedSoil : Material.Air);
      }
    }
    state.clock.elapsedMonths = 0;
    state.civilization.epoch = 'stable';
    state.world.drops = [];
    state.containers = [];
    for (const other of state.people.slice(1)) other.diedAtMonth = 0;
    delete actor.diedAtMonth;
    actor.bornAtMonth = -30 * 12;
    actor.position = {
      cellId: center,
      z: 1,
      previousCellId: center,
      previousZ: 1,
      lastPath: [],
      tickPath: [center],
    };
    actor.body = { health: 90, hydration: 90, nutrition: 33 };
    actor.conditions = [];
    actor.inventory = [];
    actor.knownPlaces = [];
    actor.baselineCapacities.perception = 100;
    delete actor.activeIntentId;
    return { state, actor, center };
  }

  function placeGranary(state, center, input = {}) {
    const x = cellX(center) + (input.dx ?? 1);
    const y = cellY(center) + (input.dy ?? 0);
    const z = input.z ?? 1;
    const id = input.id ?? `granary:${x}:${y}:${z}`;
    setVoxel(state.world.grid, x, y, z, input.voxelMaterial ?? Material.Granary);
    const foodStack = {
      id: input.stackId ?? `${id}:food`,
      materialId: Material.Food,
      quantity: input.quantity ?? 3,
      sourceEventIds: input.sourceEventIds ?? [`source:${id}:food`],
      sourceLineageKeys: input.sourceLineageKeys ?? [`harvest:${id}:food`],
    };
    const container = {
      id,
      position: { x, y, z },
      inventory: [foodStack, ...(input.extraInventory ?? [])],
      createdAtMonth: 0,
      sourceEventIds: [`source:${id}`],
      capacity: 96,
    };
    state.containers.push(container);
    return { container, foodStack };
  }

  function execute(state, actor, action, tick) {
    const fact = executePrimitiveAction(state, actor, action, 1, tick, { cause: 'survival-reflex', actionTick: tick });
    state.world.past.push(fact);
    return fact;
  }

  function lineageIntersects(left, right) {
    const rightKeys = new Set(right);
    return left.some((key) => rightKeys.has(key));
  }

  // nutrition 33: adjacent visible granary -> real transfer of one -> next reflex preserves its lineage spectrum.
  {
    const { state, actor, center } = createFixture(8101);
    const { container, foodStack } = placeGranary(state, center, {
      id: 'granary:acute', stackId: 'granary:acute:food', sourceLineageKeys: ['harvest:acute'],
    });
    const retrieve = chooseSurvivalReflex(state, actor);
    assert.equal(retrieve?.kind, 'transfer', `nutrition=33 应从相邻可见谷仓取食：${JSON.stringify(retrieve)}`);
    assert.equal(retrieve?.kind === 'transfer' ? retrieve.from.kind : undefined, 'container');
    assert.equal(retrieve?.kind === 'transfer' && retrieve.from.kind === 'container' ? retrieve.from.containerId : undefined, container.id);
    const transferFact = execute(state, actor, retrieve, 1);
    assert.equal(transferFact.status, 'completed', transferFact.result);
    assert.equal(foodStack.quantity, 2, '取食必须只从真实容器堆扣除一份');
    assert.equal(transferFact.diff.quantity, 1);
    assert.ok(transferFact.diff.sourceLineageKeys.includes('container:granary:acute:granary:acute:food'));
    assert.ok(transferFact.diff.sourceLineageKeys.includes('harvest:acute'));
    const ingest = chooseSurvivalReflex(state, actor);
    assert.equal(ingest?.kind === 'act' ? ingest.operation : undefined, 'ingest');
    const ingestFact = execute(state, actor, ingest, 2);
    assert.equal(ingestFact.status, 'completed', ingestFact.result);
    assert.equal(ingestFact.diff.consumedStackId, ingest.targets[0].stackId);
    assert.ok(lineageIntersects(transferFact.diff.sourceLineageKeys, ingestFact.diff.consumedSourceLineageKeys),
      '未发生合并时，摄入来源谱必须保留刚才容器取物的 lineage');
    assert.ok(ingestFact.diff.consumedSourceEventIds.includes(transferFact.id),
      '摄入来源应包含刚才完成的 transfer 事实');
  }

  // Boundary: nutrition 34 is outside this acute reflex.
  {
    const { state, actor, center } = createFixture(8102);
    actor.body.nutrition = 34;
    placeGranary(state, center, { id: 'granary:boundary' });
    assert.equal(chooseSurvivalReflex(state, actor), null, 'nutrition=34 不应触发急性存粮取食');
  }

  // The old emergency threshold still gives ground/plant priority.
  {
    const { state, actor, center } = createFixture(8103);
    actor.body.nutrition = 20;
    const { foodStack } = placeGranary(state, center, { id: 'granary:ground-priority' });
    state.world.drops.push({
      id: 'visible-ground-food', materialId: Material.Food, quantity: 1,
      cellId: center, z: 1, createdAtMonth: 0,
      sourceEventIds: ['source:ground-food'], sourceLineageKeys: ['drop:ground-food'],
    });
    const ground = chooseSurvivalReflex(state, actor);
    assert.equal(ground?.kind, 'transfer');
    assert.equal(ground?.kind === 'transfer' ? ground.from.kind : undefined, 'ground', '可见地面食物必须优先于仓储');
    execute(state, actor, ground, 1);
    assert.equal(foodStack.quantity, 3, '地面优先链不得改动仓内实栈');
  }
  {
    const { state, actor, center } = createFixture(8104);
    actor.body.nutrition = 20;
    const { foodStack } = placeGranary(state, center, { id: 'granary:plant-priority', dx: -1 });
    const plantCell = cellId(cellX(center) + 1, cellY(center));
    setVoxel(state.world.grid, cellX(plantCell), cellY(plantCell), 1, Material.BerryBush);
    const plant = chooseSurvivalReflex(state, actor);
    assert.equal(plant?.kind === 'act' ? plant.operation : undefined, 'separate', '可采植物必须优先于仓储');
    execute(state, actor, plant, 1);
    assert.equal(foodStack.quantity, 3, '植物优先链不得改动仓内实栈');
  }

  // At nutrition 33, wild food remains outside its old threshold; only the new stored fallback applies.
  {
    const { state, actor, center } = createFixture(8110);
    const { foodStack } = placeGranary(state, center, { id: 'granary:isolated-attribution' });
    const wildDrop = {
      id: 'visible-wild-food-at-33', materialId: Material.Food, quantity: 1,
      cellId: center, z: 1, createdAtMonth: 0,
      sourceEventIds: ['source:wild-at-33'], sourceLineageKeys: ['wild:at-33'],
    };
    state.world.drops.push(wildDrop);
    const stored = chooseSurvivalReflex(state, actor);
    assert.equal(stored?.kind === 'transfer' ? stored.from.kind : undefined, 'container',
      'nutrition=33 必须隔离到存粮 fallback，不能扩张旧野食链');
    execute(state, actor, stored, 1);
    assert.equal(wildDrop.quantity, 1, '隔离归因时眼前野食必须保持未动');
    assert.equal(foodStack.quantity, 2);
  }

  // A remembered but currently invisible granary must not leak its live inventory.
  {
    const { state, actor, center } = createFixture(8105);
    const { container } = placeGranary(state, center, {
      id: 'granary:hidden-memory', dx: 10,
      extraInventory: [{
        id: 'granary:hidden-memory:rope', materialId: Material.Rope, quantity: 2,
        sourceEventIds: ['source:hidden-rope'], sourceLineageKeys: ['craft:hidden-rope'],
      }],
    });
    actor.baselineCapacities.perception = 0;
    actor.knownPlaces.push({
      id: 'known:hidden-granary', materialId: Material.Granary,
      position: { ...container.position }, learnedAtMonth: 0, lastConfirmedAtMonth: 0,
      sourceEventIds: ['memory:hidden-granary'],
    });
    assert.equal(chooseSurvivalReflex(state, actor), null,
      '只有 knownPlaces 记忆、当前视野不可见时，不得读取远处实时库存或向其移动');
    assert.equal(buildContainerOptions(state, actor, cellsInRadius(center, 4)).length, 0,
      '普通 fresh options 也不得用 remembered 位置读取远程 non-edible 实时库存');
  }

  // Ordinary container choices no longer retrieve food, while non-food retrieval remains intact.
  {
    const { state, actor, center } = createFixture(8106);
    const { container } = placeGranary(state, center, {
      id: 'granary:ordinary-options',
      extraInventory: [{
        id: 'granary:ordinary-options:rope', materialId: Material.Rope, quantity: 2,
        sourceEventIds: ['source:stored-rope'], sourceLineageKeys: ['craft:rope'],
      }],
    });
    actor.body.nutrition = 90;
    const options = buildContainerOptions(state, actor, cellsInRadius(center, 8));
    const retrieves = options.filter((option) => option.id.startsWith(`retrieve-container:${container.id}:`));
    assert.equal(retrieves.filter((option) => option.goal.kind === 'inventory-at-least'
      && option.goal.materialId === Material.Food).length, 0, '普通候选不得再为了泛用收益取 edible');
    assert.equal(retrieves.filter((option) => option.goal.kind === 'inventory-at-least'
      && option.goal.materialId === Material.Rope).length, 1, '非 edible 容器取物候选必须保持');
  }

  // A nearer food-only container with no valid deposit must not hide a farther legal non-food option.
  {
    const { state, actor, center } = createFixture(8111);
    actor.body.nutrition = 90;
    const { container: near } = placeGranary(state, center, { id: 'a-near-food-only', dx: 1 });
    const { container: farther } = placeGranary(state, center, {
      id: 'b-farther-non-food', dx: 3,
      extraInventory: [{
        id: 'b-farther-non-food:rope', materialId: Material.Rope, quantity: 2,
        sourceEventIds: ['source:farther-rope'], sourceLineageKeys: ['craft:farther-rope'],
      }],
    });
    farther.inventory = farther.inventory.filter((stack) => stack.materialId !== Material.Food);
    const options = buildContainerOptions(state, actor, cellsInRadius(center, 8));
    assert.equal(options.some((option) => option.id.includes(near.id)), false,
      'food-only 近容器没有普通合法候选时不得被暴露');
    assert.ok(options.length > 0 && options.every((option) => option.id.includes(farther.id)),
      '应继续遍历到稍远、能产生 non-edible 合法候选的容器');
  }

  // Vertical visibility is part of current perception, not just horizontal cell visibility.
  {
    const { state, actor, center } = createFixture(8112);
    actor.baselineCapacities.perception = 0;
    placeGranary(state, center, { id: 'granary:vertical-hidden', dx: 0, z: 6 });
    assert.equal(chooseSurvivalReflex(state, actor), null,
      '水平同格但垂直超出感知半径的库存不得泄漏');
  }

  // Caregivers share the same current-visible/vertical/physical boundary.
  {
    const { state, actor: caregiver, center } = createFixture(8116);
    const dependent = state.people[1];
    delete dependent.diedAtMonth;
    dependent.bornAtMonth = 0;
    dependent.geneticParents = [caregiver.id];
    dependent.position = structuredClone(caregiver.position);
    dependent.body = { health: 70, hydration: 70, nutrition: 20 };
    dependent.inventory = [];
    dependent.conditions = [];
    state.people = [caregiver, dependent];
    caregiver.baselineCapacities.perception = 0;
    const { container: remembered } = placeGranary(state, center, {
      id: 'granary:caregiver-remote-memory', dx: 10,
    });
    caregiver.knownPlaces.push({
      id: 'known:caregiver-remote-granary', materialId: Material.Granary,
      position: { ...remembered.position }, learnedAtMonth: 0, lastConfirmedAtMonth: 0,
      sourceEventIds: ['memory:caregiver-remote-granary'],
    });
    assert.equal(chooseDependentCareReflex(state, caregiver), null,
      '照护者不得从远程 knownPlaces 读取实时库存');
    state.containers = [];
    placeGranary(state, center, { id: 'granary:caregiver-vertical-hidden', dx: 0, z: 6 });
    assert.equal(chooseDependentCareReflex(state, caregiver), null,
      '照护者不得读取垂直视野外库存');
    state.containers = [];
    const { container: ghost } = placeGranary(state, center, { id: 'granary:caregiver-ghost', dx: 1 });
    setVoxel(state.world.grid, ghost.position.x, ghost.position.y, ghost.position.z, Material.Air);
    assert.equal(chooseDependentCareReflex(state, caregiver), null,
      '容器体素消失后，遗留 inventory 状态不得成为照护食源');
  }

  // Recovering adults may use the same physical reserve chain; dependent children do not travel for it.
  {
    const { state, actor, center } = createFixture(8107);
    actor.body.nutrition = 30;
    actor.conditions.push({
      id: 'hibernation:recovering-adult', kind: 'dehydrated-hibernation', stage: 1,
      sinceMonth: 0, sourceEventIds: ['source:hibernation'], hibernationPhase: 'recovering',
      recoveryStartedAtMonth: 0, recoverySourceEventIds: ['source:rehydrate'],
    });
    const { foodStack } = placeGranary(state, center, { id: 'granary:recovering-adult' });
    const retrieve = chooseHibernationRecoveryReflex(state, actor);
    assert.equal(retrieve?.kind, 'transfer', '恢复期成人应能从近身真实存粮取食');
    execute(state, actor, retrieve, 1);
    const ingest = chooseHibernationRecoveryReflex(state, actor);
    assert.equal(ingest?.kind === 'act' ? ingest.operation : undefined, 'ingest');
    execute(state, actor, ingest, 2);
    assert.equal(foodStack.quantity, 2);
  }

  // Full 15-tick orchestration: caregiver interrupts an active project, fetches real food,
  // gives it to a recovering dependent, and the child ingests it without travelling alone.
  {
    const { state, actor: caregiver, center } = createFixture(8113);
    const dependent = state.people[1];
    assert.ok(dependent, '完整月循环需要一名 dependent');
    delete dependent.diedAtMonth;
    dependent.bornAtMonth = 0;
    dependent.geneticParents = [caregiver.id];
    dependent.position = structuredClone(caregiver.position);
    dependent.body = { health: 70, hydration: 70, nutrition: 20 };
    dependent.inventory = [];
    dependent.conditions = [{
      id: 'hibernation:monthly-recovering-dependent', kind: 'dehydrated-hibernation', stage: 1,
      sinceMonth: 0, sourceEventIds: ['source:hibernation'], hibernationPhase: 'recovering',
      recoveryStartedAtMonth: 0, recoverySourceEventIds: ['source:rehydrate'],
    }];
    state.people = [caregiver, dependent];
    const project = instantiateProject({
      id: 'caregiver-active-project', kind: 'production', need: 'production-efficiency',
      desiredFunction: 'efficient-production', summary: '持续制作生产工具',
      ownerId: caregiver.id, beneficiaryIds: [caregiver.id], triggerFactIds: ['source:project-pressure'],
      pressure: 60, createdAtMonth: 0, reviewAtMonth: 120,
    });
    state.projects = [project];
    const parentIntent = {
      id: 'intent:caregiver-active-project', ownerId: caregiver.id, summary: project.summary,
      domain: 'strategic', goal: { kind: 'project-completed', projectId: project.id },
      nextAction: { kind: 'move', toCellId: caregiver.position.cellId, toZ: caregiver.position.z },
      status: 'active', createdAtMonth: 0, lastProgressAtMonth: 0, progress: 0,
      sourceDecisionEventId: 'decision:caregiver-project', projectId: project.id,
      sourceFactIds: ['source:project-pressure'], actionEventIds: [], replanCount: 0,
    };
    state.intents = [parentIntent];
    caregiver.activeIntentId = parentIntent.id;
    const { container } = placeGranary(state, center, {
      id: 'granary:monthly-dependent-chain', dx: 3,
      sourceLineageKeys: ['harvest:monthly-dependent-food'],
    });
    const after = stepSimulation(state, { decide() { return { kind: 'idle', reason: '保持定向夹具' }; } });
    const actions = after.world.past.filter((event) => event.kind === 'action');
    const caregiverWithdraw = actions.find((event) => event.who === caregiver.id
      && event.action.kind === 'transfer'
      && event.action.from.kind === 'container'
      && event.action.from.containerId === container.id
      && event.action.to.kind === 'person'
      && event.action.to.personId === caregiver.id);
    const caregiverGive = actions.find((event) => event.who === caregiver.id
      && event.action.kind === 'transfer'
      && event.action.from.kind === 'person'
      && event.action.to.kind === 'person'
      && event.action.to.personId === dependent.id);
    const childIngest = actions.find((event) => event.who === dependent.id
      && event.action.kind === 'act'
      && event.action.operation === 'ingest');
    assert.ok(caregiverWithdraw && caregiverGive && childIngest,
      `15 ticks 内必须形成仓→照护者→recovering child→摄入完整链：${JSON.stringify(actions.map((event) => event.action))}`);
    assert.equal(actions.some((event) => event.who === dependent.id && event.action.kind === 'move'), false,
      'dependent 自身不得为存粮独行');
    assert.ok(after.intents.some((intent) => intent.interruptionKind === 'dependent-care'
      && intent.returnToIntentId === parentIntent.id
      && intent.returnOutcome === 'resumed'),
    '照护取粮动作必须作为 active project 的 dependent-care child 中断并显式返回');
  }

  // Project-bound edible retrieval remains available before search, while ordinary retrieval stays absent.
  {
    const { state, actor, center } = createFixture(8114);
    actor.body.nutrition = 90;
    const { container } = placeGranary(state, center, {
      id: 'granary:project-raw-meat', dx: 3,
      stackId: 'granary:project-raw-meat:raw',
    });
    container.inventory = [{
      id: 'granary:project-raw-meat:raw', materialId: Material.RawMeat, quantity: 2,
      sourceEventIds: ['source:stored-raw-meat'], sourceLineageKeys: ['hunt:stored-raw-meat'],
    }];
    const ordinary = buildContainerOptions(state, actor, cellsInRadius(center, 8));
    assert.equal(ordinary.some((option) => option.id.startsWith(`retrieve-container:${container.id}:`)), false,
      'RawMeat 属于 edible，普通容器候选不得恢复它');
    const project = instantiateProject({
      id: 'project:prepared-food-from-store', kind: 'production', need: 'production-efficiency',
      desiredFunction: 'prepared-food', summary: '把真实肉食加热为熟食',
      ownerId: actor.id, beneficiaryIds: [actor.id], triggerFactIds: ['source:food-project'],
      pressure: 70, createdAtMonth: 0, reviewAtMonth: 120,
    });
    state.projects = [project];
    let action = recompileProjectNextAction(state, actor, project.id);
    assert.equal(action?.kind, 'move', `项目应先前往当前可见仓储，而不是盲搜：${JSON.stringify(action)}`);
    for (let tick = 1; action?.kind === 'move' && tick <= 8; tick += 1) {
      const fact = execute(state, actor, action, tick);
      assert.ok(fact.status === 'completed' || fact.status === 'progressed', fact.result);
      recordProjectAction(state, project.id, fact);
      action = recompileProjectNextAction(state, actor, project.id);
    }
    assert.equal(action?.kind, 'transfer');
    assert.equal(action?.kind === 'transfer' ? action.from.kind : undefined, 'container');
    const withdraw = execute(state, actor, action, 9);
    recordProjectAction(state, project.id, withdraw);
    setVoxel(state.world.grid, cellX(actor.position.cellId) - 1, cellY(actor.position.cellId), actor.position.z, Material.Fire);
    const work = recompileProjectNextAction(state, actor, project.id);
    assert.equal(work?.kind === 'act' ? work.operation : undefined, 'expose',
      `取得 RawMeat 后项目必须推进到真实加工步骤：${JSON.stringify({ work, position: actor.position, x: cellX(actor.position.cellId), y: cellY(actor.position.cellId), inventory: actor.inventory, project })}`);
  }

  // Project sourcing also rejects remote known-place and vertically invisible live inventories.
  {
    const { state, actor, center } = createFixture(8115);
    actor.baselineCapacities.perception = 0;
    const { container } = placeGranary(state, center, {
      id: 'granary:project-remote-memory', dx: 10,
      stackId: 'granary:project-remote-memory:raw',
    });
    container.inventory = [{
      id: 'granary:project-remote-memory:raw', materialId: Material.RawMeat, quantity: 1,
      sourceEventIds: ['source:remote-raw'], sourceLineageKeys: ['hunt:remote-raw'],
    }];
    actor.knownPlaces.push({
      id: 'known:remote-project-granary', materialId: Material.Granary,
      position: { ...container.position }, learnedAtMonth: 0, lastConfirmedAtMonth: 0,
      sourceEventIds: ['memory:remote-project-granary'],
    });
    const project = instantiateProject({
      id: 'project:remote-store-negative', kind: 'production', need: 'production-efficiency',
      desiredFunction: 'prepared-food', summary: '不可读取远处库存',
      ownerId: actor.id, beneficiaryIds: [actor.id], triggerFactIds: ['source:food-project'],
      pressure: 70, createdAtMonth: 0, reviewAtMonth: 120,
    });
    state.projects = [project];
    const action = recompileProjectNextAction(state, actor, project.id);
    assert.equal(action?.kind === 'transfer' && action.from.kind === 'container', false,
      '远程 knownPlaces 不得成为 project-linked 实时容器取材');
  }

  // If a perceived source disappears during approach, recompilation must not transfer from it.
  {
    const { state, actor, center } = createFixture(8117);
    actor.body.nutrition = 90;
    const { container } = placeGranary(state, center, { id: 'granary:project-invalidated', dx: 3 });
    container.inventory = [{
      id: 'granary:project-invalidated:raw', materialId: Material.RawMeat, quantity: 1,
      sourceEventIds: ['source:invalidated-raw'], sourceLineageKeys: ['hunt:invalidated-raw'],
    }];
    const project = instantiateProject({
      id: 'project:invalidated-store-source', kind: 'production', need: 'production-efficiency',
      desiredFunction: 'prepared-food', summary: '来源失效后重新判断',
      ownerId: actor.id, beneficiaryIds: [actor.id], triggerFactIds: ['source:food-project'],
      pressure: 70, createdAtMonth: 0, reviewAtMonth: 120,
    });
    state.projects = [project];
    const approach = recompileProjectNextAction(state, actor, project.id);
    assert.equal(approach?.kind, 'move');
    setVoxel(state.world.grid, container.position.x, container.position.y, container.position.z, Material.Air);
    const moved = execute(state, actor, approach, 1);
    recordProjectAction(state, project.id, moved);
    const replanned = recompileProjectNextAction(state, actor, project.id);
    assert.equal(replanned?.kind === 'transfer'
      && replanned.from.kind === 'container'
      && replanned.from.containerId === container.id, false,
    '容器体素失效后不得沿旧 stack/container 引用串源取材');
  }

  {
    const { state, actor, center } = createFixture(8108);
    actor.bornAtMonth = 0;
    actor.body.nutrition = 20;
    actor.conditions.push({
      id: 'hibernation:recovering-dependent', kind: 'dehydrated-hibernation', stage: 1,
      sinceMonth: 0, sourceEventIds: ['source:hibernation'], hibernationPhase: 'recovering',
      recoveryStartedAtMonth: 0, recoverySourceEventIds: ['source:rehydrate'],
    });
    placeGranary(state, center, { id: 'granary:dependent-distance', dx: 3 });
    assert.equal(chooseHibernationRecoveryReflex(state, actor), null,
      '恢复期 dependent child 不得为了远处仓储独自移动');
    actor.conditions = [];
    assert.equal(chooseSurvivalReflex(state, actor), null,
      '普通急性反射中的 dependent child 也不得跨距前往仓储');
  }

  // Merging same-material sources preserves an ambiguous provenance spectrum; it is not exact unit identity.
  {
    const { state, actor, center } = createFixture(8109);
    const { container } = placeGranary(state, center, {
      id: 'granary:ambiguous-merge', sourceLineageKeys: ['harvest:stored'],
    });
    const withdrawAction = chooseSurvivalReflex(state, actor);
    const withdraw = execute(state, actor, withdrawAction, 1);
    state.world.drops.push({
      id: 'other-source-food', materialId: Material.Food, quantity: 1,
      cellId: actor.position.cellId, z: actor.position.z, createdAtMonth: 0,
      sourceEventIds: ['source:other-food'], sourceLineageKeys: ['harvest:other'],
    });
    execute(state, actor, {
      kind: 'transfer', materialId: Material.Food, quantity: 1,
      from: { kind: 'ground', cellId: actor.position.cellId, z: actor.position.z },
      to: { kind: 'person', personId: actor.id }, dropId: 'other-source-food',
    }, 2);
    const merged = actor.inventory.find((stack) => stack.materialId === Material.Food);
    assert.ok(merged && merged.quantity === 2, '现有材质合并语义应保留，不发明单位身份');
    const ingestFact = execute(state, actor, {
      kind: 'act', operation: 'ingest',
      targets: [{ kind: 'inventory-stack', personId: actor.id, stackId: merged.id }],
    }, 3);
    assert.ok(lineageIntersects(withdraw.diff.sourceLineageKeys, ingestFact.diff.consumedSourceLineageKeys));
    assert.ok(ingestFact.diff.consumedSourceLineageKeys.includes('harvest:other'));
    assert.ok(ingestFact.diff.consumedSourceLineageKeys.includes(`container:${container.id}:${container.inventory[0]?.id ?? 'granary:ambiguous-merge:food'}`)
      || ingestFact.diff.consumedSourceLineageKeys.includes('harvest:stored'));
    assert.ok(ingestFact.diff.consumedSourceLineageKeys.length > 1,
      '摄入 diff 只能声明合并栈的来源谱有歧义，不能宣称 exact physical unit');
  }

  process.stdout.write('food reserve use tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
