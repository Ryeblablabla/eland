import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-works-'));
const bundle = (entry, out) => {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${path.join(temporaryDirectory, out)}`,
  ], { cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), stdio: 'inherit' });
  return path.join(temporaryDirectory, out);
};
const sim = await import(pathToFileURL(bundle('src/game/eland/simulation.ts', 'sim.mjs')).href + `?t=${Date.now()}`);
const executor = await import(pathToFileURL(bundle('src/game/eland/domain/action-executor.ts', 'exec.mjs')).href + `?t=${Date.now()}`);
const works = await import(pathToFileURL(bundle('src/game/eland/domain/works.ts', 'works.mjs')).href + `?t=${Date.now()}`);
const structure = await import(pathToFileURL(bundle('src/game/eland/domain/structure.ts', 'structure.mjs')).href + `?t=${Date.now()}`);
const civilization = await import(pathToFileURL(bundle('src/game/eland/domain/civilization-index.ts', 'civilization-index.mjs')).href + `?t=${Date.now()}`);
const { createInitialState } = sim;
const { executePrimitiveAction } = executor;
const { Material } = await import(pathToFileURL(bundle('src/game/eland/domain/material.ts', 'material.mjs')).href + `?t=${Date.now()}`);

const state = createInitialState(31, { endpoint: { kind: 'months', value: 24 } });
const person = state.people[0];
const px = person.position.cellId % state.world.grid.width;
const py = Math.floor(person.position.cellId / state.world.grid.width);

// 在人物脚边放 6 木材 + 1 纤维
const dropCell = person.position.cellId;
state.world.drops.push(
  { id: 'test-wood', materialId: Material.Wood, cellId: dropCell, z: person.position.z, quantity: 6, sourceEventIds: [], createdAtMonth: 0 },
  { id: 'test-fiber', materialId: Material.Fiber, cellId: dropCell, z: person.position.z, quantity: 1, sourceEventIds: [], createdAtMonth: 0 },
);

// 找一个邻格受支撑空位作锚点
const anchor = { x: px + 1, y: py, z: person.position.z };
const action = {
  kind: 'world-interact',
  adjudication: {
    version: 'world-adjudicated-interaction-v1',
    request: '把木材斜靠捆扎成棚架',
    targets: [{ kind: 'drop', dropId: 'test-wood' }, { kind: 'drop', dropId: 'test-fiber' }, { kind: 'voxel', position: anchor }],
    status: 'completed',
    result: '木材被斜靠捆好，一个棚架立了起来',
    effects: [
      { kind: 'consume', target: { kind: 'drop', dropId: 'test-wood' }, quantity: 6 },
      { kind: 'consume', target: { kind: 'drop', dropId: 'test-fiber' }, quantity: 1 },
      { kind: 'assemble', target: { kind: 'voxel', position: anchor }, arrangement: 'support', summary: '斜靠的木棚架' },
    ],
  },
};

const fact = executePrimitiveAction(state, person, action, 1, 0, { cause: 'intent', actionTick: 0 });
assert.equal(fact.status, 'completed', `搭建应成功：${fact.result}`);
state.world.past.push(fact);

const work = state.world.works?.[0];
assert.ok(work, '应生成 Works 实体');
assert.equal(work.arrangement, 'support');
assert.equal(work.condition, 100);
assert.deepEqual(work.components.map((c) => [c.materialId, c.quantity]), [[Material.Wood, 6], [Material.Fiber, 1]]);
assert.ok(work.profile.cover > 0 && work.profile.rigidity > 0, 'profile 应由材料导出');
console.log(`[works] 实体创建通过: cover=${work.profile.cover} rigidity=${work.profile.rigidity} stability=${work.profile.stability}`);

// 锚点体素已真实放置（渲染与体素物理共用）
const { voxelAt, setVoxel } = await import(pathToFileURL(bundle('src/game/eland/world/grid.ts', 'grid.mjs')).href + `?t=${Date.now()}`);
assert.equal(voxelAt(state.world.grid, anchor.x, anchor.y, anchor.z), Material.Wood, '锚点应放置主体材料体素');

// A named frame and abundant material are not a roof over a person's body.
assert.equal(structure.survivalShelterAt(state, person.position), null,
  '单个锚点的材料分数不能代替实际墙顶');

// 加件：modify-structure
state.world.drops.push({ id: 'test-wood2', materialId: Material.Wood, cellId: dropCell, z: person.position.z, quantity: 2, sourceEventIds: [], createdAtMonth: 0 });
const modifyAction = {
  kind: 'world-interact',
  adjudication: {
    version: 'world-adjudicated-interaction-v1',
    request: '再给棚架加两根木料',
    targets: [{ kind: 'drop', dropId: 'test-wood2' }, { kind: 'work', workId: work.id }],
    status: 'completed',
    result: '棚架更结实了',
    effects: [
      { kind: 'consume', target: { kind: 'drop', dropId: 'test-wood2' }, quantity: 2 },
      { kind: 'modify-structure', target: { kind: 'work', workId: work.id }, summary: '加厚的斜靠木棚架' },
    ],
  },
};
const fact2 = executePrimitiveAction(state, person, modifyAction, 1, 1, { cause: 'intent', actionTick: 1 });
assert.equal(fact2.status, 'completed', `加件应成功：${fact2.result}`);
state.world.past.push(fact2);
const updated = state.world.works[0];
assert.equal(updated.id, work.id, '加固继续使用同一造物身份');
assert.deepEqual(updated.position, anchor);
assert.equal(updated.components.find((c) => c.materialId === Material.Wood)?.quantity, 8, '组件应合并');
console.log('[works] 加件通过');

// 协作加件：第二个人在同一造物上加件 → 双向关系证据
const partner = state.people[1];
partner.position.cellId = person.position.cellId;
partner.position.z = person.position.z;
state.world.drops.push({ id: 'test-fiber2', materialId: Material.Fiber, cellId: dropCell, z: person.position.z, quantity: 1, sourceEventIds: [], createdAtMonth: 0 });
const collabAction = {
  kind: 'world-interact',
  adjudication: {
    version: 'world-adjudicated-interaction-v1',
    request: '帮棚架再缠一道纤维',
    targets: [{ kind: 'drop', dropId: 'test-fiber2' }, { kind: 'voxel', position: anchor }],
    status: 'completed',
    result: '棚架缠得更牢了',
    effects: [
      { kind: 'consume', target: { kind: 'drop', dropId: 'test-fiber2' }, quantity: 1 },
      { kind: 'modify-structure', target: { kind: 'voxel', position: anchor }, summary: '双人加固的木棚架' },
    ],
  },
};
const relationMod = await import(pathToFileURL(bundle('src/game/eland/domain/relation.ts', 'relation.mjs')).href + `?t=${Date.now()}`);
const fact3 = executePrimitiveAction(state, partner, collabAction, 1, 2, { cause: 'intent', actionTick: 2 });
assert.equal(fact3.status, 'completed', `协作加件应成功：${fact3.result}`);
state.world.past.push(fact3);
const relAB = relationMod.relationTo(person, partner.id);
const relBA = relationMod.relationTo(partner, person.id);
assert.ok(relAB && relBA, '协作应在两人之间留下双向关系');
assert.ok(state.world.works[0].builderIds.includes(partner.id), '第二建造者应入列');
console.log('[works] 协作关系证据通过');

// 功能承认：造物的名称和建造事件本身不能进入文明观察。
state.clock.elapsedMonths = 1;
const beforeUse = civilization.calculateCivilizationIndex(state);
assert.equal(beforeUse.components.territory.evidence.usedWorks, 0, '未被使用的造物不应成为文明设施');

// 先写入一条无法回放的声称，观察器应该忽略它。
works.recordWorkUse(state.world, {
  workId: state.world.works[0].id,
  kind: 'use',
  functionKey: '文本声称的神奇功能',
  actorId: person.id,
  atMonth: 2,
  sourceEventId: 'missing-event',
  evidencePaths: ['diff.appliedEffects'],
});
assert.equal(works.observeWorkAdoption(state.world.works[0], state.world.past, 2).receipts.length, 0,
  '缺失来源事件的功能声称必须被忽略');

const useAction = {
  kind: 'world-interact',
  adjudication: {
    version: 'world-adjudicated-interaction-v1',
    request: '在棚架下试着避雨，记下身体感受',
    targets: [{ kind: 'voxel', position: anchor }],
    status: 'completed',
    result: '棚架承担了遮蔽用途',
    effects: [{ kind: 'knowledge', summary: '站在棚架旁可减少雨水直接冲刷' }],
  },
};
const useFact = executePrimitiveAction(state, person, useAction, 2, 3, { cause: 'intent', actionTick: 3 });
assert.equal(useFact.status, 'completed', `使用应成功：${useFact.result}`);
state.world.past.push(useFact);
assert.equal(works.observeWorkAdoption(state.world.works[0], state.world.past, 2).receipts.length, 0);

if (process.argv[2]) {
  const observed = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const pillar = observed.world.works.find((candidate) => candidate.id === 'work:e-3-action-liu-rushi-28');
  const materialPickup = observed.world.past.find((event) => event.id === 'e-3-action-liu-rushi-32');
  assert.ok(pillar && materialPickup, 'the supplied r3 history must contain the actual pillar and pickup event');
  assert.ok(pillar.useReceipts.some((receipt) => receipt.sourceEventId === materialPickup.id),
    'the real failure sample retains its original false positive for replay');
  assert.ok(materialPickup.action.adjudication.targets.some((target) => target.kind === 'work' && target.workId === pillar.id));
  assert.ok(materialPickup.diff.appliedEffects.some((effect) => effect.kind === 'produce'));
  assert.equal(works.observeWorkAdoption(pillar, observed.world.past, observed.clock.elapsedMonths).receipts.length, 0,
    'the cached false action receipt must also be excluded when the real history is replayed');
  console.log('[works] 真实r3回放：木柱旁取材的旧假使用回执为0');
}

// Reusing retained components changes actual geometry without consuming them twice.
const pillarLayout = { version: 'work-layout-v1', voxels: [0, 1, 2].map((z) => ({
  offset: { x: 0, y: 0, z }, materialId: Material.Wood,
})) };
const reshape = (layout, order) => executePrimitiveAction(state, person, {
  kind: 'world-interact', adjudication: {
    version: 'world-adjudicated-interaction-v1', request: '把已有木材重新排成实际构件',
    status: 'completed', result: '重新排布已有材料', targets: [{ kind: 'work', workId: work.id }],
    effects: [{ kind: 'modify-structure', target: { kind: 'work', workId: work.id }, layout }],
  },
}, 2, order, { cause: 'intent', actionTick: order });
const pillarFact = reshape(pillarLayout, 4);
assert.equal(pillarFact.status, 'completed', pillarFact.result);
state.world.past.push(pillarFact);
assert.equal(structure.survivalShelterAt(state, person.position), null, '真实立柱仍然没有头顶遮挡');
const roofLayout = { ...pillarLayout, voxels: [...pillarLayout.voxels,
  { offset: { x: -1, y: 0, z: 2 }, materialId: Material.Wood },
] };
const refusedQuantity = state.world.works[0].components.find((part) => part.materialId === Material.Wood).quantity;
const oversized = { version: 'work-layout-v1', voxels: Array.from({ length: refusedQuantity + 1 }, (_, x) => ({
  offset: { x, y: 0, z: 0 }, materialId: Material.Wood,
})) };
const refusedLayout = reshape(oversized, 6);
assert.equal(refusedLayout.status, 'blocked', '布局不能凭空扩出额外木料');
assert.deepEqual(state.world.works[0].layout, pillarLayout);
assert.equal(state.world.works[0].components.find((part) => part.materialId === Material.Wood).quantity, refusedQuantity);
const roofFact = reshape(roofLayout, 5);
assert.equal(roofFact.status, 'completed', roofFact.result);
state.world.past.push(roofFact);
assert.equal(state.world.works[0].id, work.id);
assert.equal(state.world.works[0].components.find((part) => part.materialId === Material.Wood).quantity, 8);
assert.equal(voxelAt(state.world.grid, px, py, person.position.z + 2), Material.Wood);
assert.deepEqual(structure.survivalShelterAt(state, person.position)?.workIds, [work.id]);
console.log('[works] 立柱与真实屋顶可区分，留存材料重排不重复扣除');

// Actual thermal exposure settlement, not prose, proves shelter use.
const monthly = await import(pathToFileURL(bundle('src/game/eland/domain/monthly-processes.ts', 'monthly.mjs')).href);
state.civilization.climate = { kind: 'cold', severity: 4 };
const exposureEvents = monthly.advanceBodies(state, 2);
state.world.past.push(...exposureEvents);
const shelterEvents = exposureEvents.filter((event) => event.diff.shelterUse?.workIds.includes(work.id));
assert.ok(shelterEvents.length >= 2, '两个实际处于遮蔽位置的人应分别留下生理使用事实');
for (const event of shelterEvents) {
  assert.ok(event.diff.shelterUse.coldLoadWithoutShelter > event.diff.shelterUse.coldLoad);
}
state.clock.elapsedMonths = 2;
const adoption = works.observeWorkAdoption(state.world.works[0], state.world.past, 2);
assert.deepEqual(new Set(adoption.userIds), new Set([person.id, partner.id]));
assert.ok(adoption.receipts.every((receipt) => receipt.functionKey === 'thermal-protection'));
assert.deepEqual(adoption.witnessIds, [], '同时获益不能自动捏造彼此示范或见证');
const afterUse = civilization.calculateCivilizationIndex(state);
assert.equal(afterUse.components.territory.evidence.usedWorks, 1);
assert.equal(afterUse.components.social.evidence.diffusedWorks, 1);
console.log('[works] 排除叙述式假使用，实际生理遮蔽回执通过');

// 衰减与塌落
state.world.works[0] = { ...state.world.works[0], condition: 25.5 };
const outcome = works.advanceWorksMonth(state.world, {
  seed: 31, atMonth: 2, weatherKind: 'rain',
  makeDropId: (w, c) => `collapse:${c.materialId}`,
});
assert.equal(outcome.collapsed.length, 1, '低于阈值应塌落');
assert.equal(state.world.works.length, 0, '塌落后实体移除');
assert.ok(state.world.drops.some((d) => d.id === `collapse:${Material.Wood}`), '塌落应回落材料');
assert.equal(voxelAt(state.world.grid, anchor.x, anchor.y, anchor.z), Material.Air, '锚点体素应随塌落清除');
assert.equal(voxelAt(state.world.grid, px, py, person.position.z + 2), Material.Air, '屋顶也应随实体塌落清除');
console.log('[works] 衰减塌落通过');

// Consuming a voxel used to erase its identity before assembly read it,
// producing a composite made from Air. Inputs must survive as real matter.
const source = { kind: 'voxel', position: { x: px, y: py, z: person.position.z + 1 } };
setVoxel(state.world.grid, source.position.x, source.position.y, source.position.z, Material.Wood);
const voxelAssembly = executePrimitiveAction(state, person, {
  kind: 'world-interact',
  adjudication: {
    version: 'world-adjudicated-interaction-v1', request: '取下木构件，拼成新的架子',
    status: 'completed', result: '木构件已成为新架子的组成部分',
    targets: [source, { kind: 'voxel', position: anchor }],
    effects: [
      { kind: 'consume', target: source, quantity: 1 },
      { kind: 'assemble', target: { kind: 'voxel', position: anchor }, arrangement: 'support', summary: '重新拼装的架子' },
    ],
  },
}, 4, 0, { cause: 'intent', actionTick: 0 });
assert.equal(voxelAssembly.status, 'completed', voxelAssembly.result);
assert.deepEqual(state.world.works[0].components, [{ materialId: Material.Wood, quantity: 1 }]);
const expanded = works.modifyWork(state.world.works[0], {
  components: [{ materialId: Material.Wood, quantity: 30 }],
  builderId: person.id, atMonth: 4, sourceEventId: 'later-real-construction',
});
assert.equal(expanded.components[0].quantity, 31, '投入的材料不能被24单位的缓存上限丢掉');
console.log('[works] 体素投入快照与长期材料积累通过');

rmSync(temporaryDirectory, { recursive: true, force: true });
console.log('Works 定点自测全部通过');
