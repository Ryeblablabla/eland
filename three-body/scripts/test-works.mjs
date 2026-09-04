import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
const { voxelAt } = await import(pathToFileURL(bundle('src/game/eland/world/grid.ts', 'grid.mjs')).href + `?t=${Date.now()}`);
assert.equal(voxelAt(state.world.grid, anchor.x, anchor.y, anchor.z), Material.Wood, '锚点应放置主体材料体素');

// 遮蔽：人物紧邻棚架应被 survivalShelterAt 承认（cover≥55 时）
const cover = works.workShelterCoverAt(state.world, person.position);
console.log(`[works] 人物位置 cover=${cover}`);
if (cover >= works.WORK_SHELTER_COVER_THRESHOLD) {
  const shelter = structure.survivalShelterAt(state, person.position);
  assert.ok(shelter && shelter.weatherProtection >= works.WORK_SHELTER_COVER_THRESHOLD, '棚架应提供生存遮蔽');
  console.log('[works] 生存遮蔽通过');
}

// 加件：modify-structure
state.world.drops.push({ id: 'test-wood2', materialId: Material.Wood, cellId: dropCell, z: person.position.z, quantity: 2, sourceEventIds: [], createdAtMonth: 0 });
const modifyAction = {
  kind: 'world-interact',
  adjudication: {
    version: 'world-adjudicated-interaction-v1',
    request: '再给棚架加两根木料',
    targets: [{ kind: 'drop', dropId: 'test-wood2' }, { kind: 'voxel', position: anchor }],
    status: 'completed',
    result: '棚架更结实了',
    effects: [
      { kind: 'consume', target: { kind: 'drop', dropId: 'test-wood2' }, quantity: 2 },
      { kind: 'modify-structure', target: { kind: 'voxel', position: anchor }, summary: '加厚的斜靠木棚架' },
    ],
  },
};
const fact2 = executePrimitiveAction(state, person, modifyAction, 1, 1, { cause: 'intent', actionTick: 1 });
assert.equal(fact2.status, 'completed', `加件应成功：${fact2.result}`);
state.world.past.push(fact2);
const updated = state.world.works[0];
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
assert.equal(works.recordWorkUsesFromCompletedAction(state.world, useFact).length, 1,
  '执行器单点接线应为显式指向造物的 completed 行为产生回执');
state.clock.elapsedMonths = 2;
const afterUse = civilization.calculateCivilizationIndex(state);
assert.equal(afterUse.components.territory.evidence.usedWorks, 1, '可回放的真实使用应让造物进入文明观察');
assert.equal(afterUse.components.technology.evidence.workUseReceipts, 1, '伪造回执不应被计入');

// 示范除了来源行为，还必须能从该行为的结构化 diff 核对见证者。
const demonstrationFact = executePrimitiveAction(state, partner, useAction, 3, 4, { cause: 'intent', actionTick: 4 });
assert.equal(demonstrationFact.status, 'completed');
demonstrationFact.diff.witnessPersonIds = [person.id];
state.world.past.push(demonstrationFact);
assert.equal(works.recordWorkUsesFromCompletedAction(state.world, demonstrationFact)[0]?.kind, 'demonstration');
state.clock.elapsedMonths = 3;
const adoption = works.observeWorkAdoption(state.world.works[0], state.world.past, 3);
assert.equal(adoption.receipts.length, 2);
assert.deepEqual(new Set(adoption.userIds), new Set([person.id, partner.id]));
assert.deepEqual(adoption.witnessIds, [person.id]);
const afterDemonstration = civilization.calculateCivilizationIndex(state);
assert.equal(afterDemonstration.components.social.evidence.diffusedWorks, 1,
  '第二人使用且有可核对见证时，才构成造物传播证据');
console.log('[works] 使用、示范与文明观察回执通过');

// 体素结构使用也从账本折叠，而不是从 name 或 complete 布尔值推断。
const physicalStructure = {
  id: 'structure:test:open-form',
  name: '任意名称不参与功能判定',
  occupiedCells: [person.position.cellId],
  interiorCells: [person.position.cellId],
  interiorPositions: [{ cellId: person.position.cellId, z: person.position.z }],
  materialIds: [Material.Wood],
  weatherProtection: 60,
  thermalInsulation: 20,
  capacity: 1,
  complete: true,
  sourceEventIds: [fact.id],
};
assert.equal(structure.observePhysicalStructureUseReceipts(physicalStructure, [fact]).length, 0,
  '结构的自身建造事件不是功能使用');
const structureReceipts = structure.observePhysicalStructureUseReceipts(
  physicalStructure,
  [fact, useFact, demonstrationFact],
);
assert.equal(structureReceipts.length, 2);
assert.ok(structureReceipts.some((receipt) => receipt.kind === 'demonstration'
  && receipt.witnessIds.includes(person.id)), '带可核对见证者的结构行为应产生示范回执');
console.log('[works] 通用体素结构使用回执通过');

// 衰减与塌落
state.world.works[0] = { ...updated, condition: 25.5 };
const outcome = works.advanceWorksMonth(state.world, {
  seed: 31, atMonth: 2, weatherKind: 'rain',
  makeDropId: (w, c) => `collapse:${c.materialId}`,
});
assert.equal(outcome.collapsed.length, 1, '低于阈值应塌落');
assert.equal(state.world.works.length, 0, '塌落后实体移除');
assert.ok(state.world.drops.some((d) => d.id === `collapse:${Material.Wood}`), '塌落应回落材料');
assert.equal(voxelAt(state.world.grid, anchor.x, anchor.y, anchor.z), Material.Air, '锚点体素应随塌落清除');
console.log('[works] 衰减塌落通过');

rmSync(temporaryDirectory, { recursive: true, force: true });
console.log('Works 定点自测全部通过');
