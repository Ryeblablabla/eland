import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-mortuary-care-test-'));
const bundles = Object.fromEntries([
  ['simulation', 'src/game/eland/simulation.ts'],
  ['executor', 'src/game/eland/domain/action-executor.ts'],
  ['bodies', 'src/game/eland/domain/monthly-processes.ts'],
  ['mortuary', 'src/game/eland/domain/mortuary.ts'],
  ['options', 'src/game/eland/application/action-options.ts'],
  ['milestones', 'src/game/eland/projection/capability-milestones.ts'],
  ['material', 'src/game/eland/domain/material.ts'],
  ['grid', 'src/game/eland/world/grid.ts'],
].map(([key, entry]) => [key, { entry, output: path.join(temporaryDirectory, `${key}.mjs`) }]));

try {
  for (const { entry, output } of Object.values(bundles)) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
    ], { stdio: 'pipe' });
  }
  const load = async (key) => import(`${pathToFileURL(bundles[key].output).href}?test=${Date.now()}`);
  const { createInitialState } = await load('simulation');
  const { executePrimitiveAction } = await load('executor');
  const { advanceBodies } = await load('bodies');
  const { synchronizeMortuaryPerceptions } = await load('mortuary');
  const { buildDecisionContext } = await load('options');
  const { observeCapabilityMilestones } = await load('milestones');
  const { Material } = await load('material');
  const { cellX, cellY, cellsInRadius, neighbors4, setVoxel, standingPositions } = await load('grid');

  const state = createInitialState(88421, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const deceased = state.people[0];
  const carer = state.people[1];
  const remote = state.people[2];
  state.people = [deceased, carer, remote];
  const placeWith = (person, other) => {
    person.position.cellId = other.position.cellId;
    person.position.z = other.position.z;
    person.position.previousCellId = other.position.cellId;
    person.position.previousZ = other.position.z;
    person.position.lastPath = [other.position.cellId];
    person.position.tickPath = [other.position.cellId];
  };
  placeWith(carer, deceased);
  carer.bornAtMonth = -30 * 12;
  remote.bornAtMonth = -30 * 12;
  carer.body = { health: 100, hydration: 100, nutrition: 100 };
  remote.body = { health: 100, hydration: 100, nutrition: 100 };
  const localVisible = new Set(cellsInRadius(deceased.position.cellId, 12));
  const remotePosition = Array.from({ length: state.world.grid.width * state.world.grid.depth }, (_, cellId) => cellId)
    .filter((cellId) => !localVisible.has(cellId))
    .flatMap((cellId) => standingPositions(state.world.grid, cellId))
    .find(Boolean);
  assert.ok(remotePosition, '测试世界需要一个不在死亡感知范围内的站立位置');
  remote.position.cellId = remotePosition.cellId;
  remote.position.z = remotePosition.z;
  remote.position.previousCellId = remotePosition.cellId;
  remote.position.previousZ = remotePosition.z;

  deceased.inventory = [{
    id: 'test-estate-stack', materialId: Material.Wood, quantity: 2,
    sourceEventIds: [state.world.past[0].id], sourceLineageKeys: ['test-estate-source'],
  }];
  deceased.body = { health: 0, hydration: 0, nutrition: 0 };
  const deathEvents = advanceBodies(state, 1);
  const death = deathEvents.find((event) => event.change === 'death' && event.diff.personId === deceased.id);
  assert.ok(death, '身体结算必须产生真实死亡事实');
  state.world.past.push(...deathEvents);
  state.clock.elapsedMonths = 1;
  const remains = state.world.remains.find((candidate) => candidate.personId === deceased.id);
  assert.ok(remains, '每次人类死亡必须生成唯一遗体');
  assert.equal(state.world.remains.filter((candidate) => candidate.personId === deceased.id).length, 1);
  assert.equal(remains.deathEventId, death.id);
  const estate = state.world.drops.find((drop) => drop.estateOfPersonId === deceased.id);
  assert.ok(estate, '私人背包应成为带死者身份的遗物掉落');
  assert.ok(estate.sourceEventIds.includes(death.id));

  const perceptionEvents = synchronizeMortuaryPerceptions(state, 1, deathEvents.length);
  state.world.past.push(...perceptionEvents);
  assert.ok(carer.bereavements.some((item) => item.remainsId === remains.id), '局部见证者应形成有来源悲恸');
  assert.equal((remote.bereavements ?? []).length, 0, '不可见且未获知死讯的人不能凭空悲恸');
  assert.ok(carer.memories.some((memory) => memory.sourceEventIds.includes(death.id)), '见证者应保存死亡记忆');

  const isolatedState = structuredClone(state);
  const isolatedCarer = isolatedState.people.find((person) => person.id === carer.id);
  const nearbyStanding = cellsInRadius(remains.position.cellId, 5)
    .filter((cellId) => cellId !== remains.position.cellId)
    .flatMap((cellId) => standingPositions(isolatedState.world.grid, cellId))
    .find(Boolean);
  assert.ok(nearbyStanding, '测试世界需要一个看得见遗体的邻近站位');
  isolatedCarer.position.cellId = nearbyStanding.cellId;
  isolatedCarer.position.z = nearbyStanding.z;
  for (const neighbor of neighbors4(nearbyStanding.cellId)) {
    for (let z = 0; z < isolatedState.world.grid.levels; z += 1) {
      setVoxel(isolatedState.world.grid, cellX(neighbor), cellY(neighbor), z, Material.Stone);
    }
  }
  const isolatedContext = buildDecisionContext(isolatedState, isolatedCarer, 2);
  assert.equal(isolatedContext.options.some((option) => option.id === `mourn:${remains.id}`), false,
    '看得见但不可达时不能直接编译远程悼念动作');
  assert.equal(isolatedContext.options.some((option) => option.id === `inter-remains:${remains.id}`), false,
    '看得见但不可达时不能直接编译远程搬运动作');

  let context = buildDecisionContext(state, carer, 2);
  assert.ok(context.options.some((option) => option.id === `mourn:${remains.id}`), '有来源悲恸应产生悼念候选');
  assert.ok(context.options.some((option) => option.id === `inter-remains:${remains.id}`), '可见遗体应产生物理安葬候选');
  assert.ok(context.options.some((option) => option.id === `estate:${estate.id}`), '知情者应把遗物识别为收拢对象');

  let order = 0;
  const run = (actor, action, atMonth = 2) => {
    const fact = executePrimitiveAction(state, actor, action, atMonth, order++, {
      cause: 'intent', actionTick: order,
    });
    state.world.past.push(fact);
    return fact;
  };
  const estateOption = context.options.find((option) => option.id === `estate:${estate.id}`);
  const estateFact = run(carer, estateOption.nextAction);
  assert.equal(estateFact.status, 'completed');
  assert.equal(estateFact.diff.estateCare, true);
  assert.equal(estateFact.diff.estateCarePersonId, deceased.id);
  assert.ok(estateFact.diff.sourceEventIds.includes(death.id));
  const mourn = context.options.find((option) => option.id === `mourn:${remains.id}`);
  assert.equal(run(carer, mourn.nextAction).status, 'completed');
  assert.equal(carer.bereavements.find((item) => item.remainsId === remains.id).lastMournedAtMonth, 2);

  const expectedPhases = ['lift', 'prepare-grave', 'place-in-grave', 'cover-grave'];
  const burialFacts = [];
  for (const expectedPhase of expectedPhases) {
    let option;
    for (let travelStep = 0; travelStep < 20; travelStep++) {
      context = buildDecisionContext(state, carer, 2);
      option = context.options.find((candidate) => candidate.id === `inter-remains:${remains.id}`);
      assert.ok(option, `安葬链应继续前往 ${expectedPhase}`);
      if (option.nextAction.kind !== 'move') break;
      assert.notEqual(run(carer, option.nextAction).status, 'blocked', '搬运遗体前往墓地的路径必须连续可达');
    }
    assert.ok(option, `安葬链应继续提供 ${expectedPhase}`);
    assert.equal(option.nextAction.kind, 'act');
    assert.equal(option.nextAction.mortuaryPhase, expectedPhase);
    const fact = run(carer, option.nextAction);
    assert.equal(fact.status, 'completed', `${expectedPhase} 必须完成真实状态变化`);
    burialFacts.push(fact);
  }
  assert.equal(remains.status, 'interred');
  const cover = burialFacts.at(-1);
  assert.equal(cover.diff.remainsInterred, true);
  assert.ok(cover.diff.sourceEventIds.includes(death.id));
  assert.ok(cover.diff.excavationEventId, '覆土必须引用挖墓事实');
  assert.ok(cover.diff.placementEventId, '覆土必须引用放置遗体事实');

  carer.inventory.push({
    id: 'test-blank-tablet', materialId: Material.WoodTablet, quantity: 1,
    sourceEventIds: Array.from({ length: 24 }, (_, index) => `test-tablet-source-${index}`),
  });
  carer.inventory.push({ id: 'test-stone-tool', materialId: Material.StoneTool, quantity: 1, sourceEventIds: [state.world.past[0].id] });
  context = buildDecisionContext(state, carer, 3);
  const markerOption = context.options.find((option) => option.id === `mark-memorial:${remains.id}`);
  assert.ok(markerOption, '安葬后持有空白木板与工具时才应出现墓记候选');
  const markerFact = run(carer, markerOption.nextAction, 3);
  assert.equal(markerFact.status, 'completed');
  assert.equal(state.world.memorials.length, 1);
  assert.equal(carer.inventory.some((stack) => stack.id === 'test-blank-tablet'), false, '墓记必须消耗真实木板');
  assert.ok(state.world.memorials[0].sourceEventIds.includes(death.id));
  assert.ok(state.world.memorials[0].sourceEventIds.includes(cover.id));
  assert.ok(state.world.memorials[0].sourceEventIds.includes(markerFact.id), '墓记来源预算必须始终保留死亡、安葬和创建锚点');
  assert.ok(observeCapabilityMilestones(state).some((milestone) => milestone.id.startsWith('capability:10:')),
    '死亡、安葬和物质墓记来源闭合后，观察器才应识别安葬纪念能力');

  const graveCell = remains.position.cellId;
  assert.notEqual(remote.position.cellId, graveCell);
  placeWith(carer, remote);
  context = buildDecisionContext(state, carer, 4);
  const lossOption = context.options.find((option) => option.id.startsWith('conversation:loss:')
    && option.target?.kind === 'person' && option.target.personId === remote.id);
  assert.ok(lossOption, '知情者应能通过有源生活对话传递死讯');
  assert.equal(lossOption.nextAction.kind, 'communicate');
  const newsFact = run(carer, lossOption.nextAction, 4);
  assert.equal(newsFact.status, 'completed');
  assert.ok(remote.bereavements.some((item) => item.remainsId === remains.id && item.learnedBy === 'told'));
  assert.ok(newsFact.diff.deathNewsPersonIds.includes(remote.id));

  console.log('mortuary care tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
