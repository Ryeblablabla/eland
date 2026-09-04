import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-bonds-'));
const bundle = (entry, out) => {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${path.join(temporaryDirectory, out)}`,
  ], { cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), stdio: 'inherit' });
  return path.join(temporaryDirectory, out);
};
const sim = await import(pathToFileURL(bundle('src/game/eland/simulation.ts', 'sim.mjs')).href + `?t=${Date.now()}`);
const executor = await import(pathToFileURL(bundle('src/game/eland/domain/action-executor.ts', 'exec.mjs')).href + `?t=${Date.now()}`);
const bonds = await import(pathToFileURL(bundle('src/game/eland/domain/animal-bonds.ts', 'bonds.mjs')).href + `?t=${Date.now()}`);
const { Material } = await import(pathToFileURL(bundle('src/game/eland/domain/material.ts', 'material.mjs')).href + `?t=${Date.now()}`);
const { createInitialState } = sim;
const { executePrimitiveAction } = executor;

const state = createInitialState(31, { endpoint: { kind: 'months', value: 24 } });
const person = state.people[0];
assert.ok(state.world.animals.length, '初始世界应有动物');
const animal = state.world.animals[0];
// 把动物挪到人物身边
animal.position.cellId = person.position.cellId;
animal.position.z = person.position.z;
// 给人物一包食物
person.inventory.push({ id: 'stack-test-food', materialId: Material.Food, quantity: 1, sourceEventIds: [] });

const feedAction = {
  kind: 'world-interact',
  adjudication: {
    version: 'world-adjudicated-interaction-v1',
    request: '蹲下把一份食物放到鹿面前，轻声安抚',
    targets: [{ kind: 'animal', animalId: animal.id }, { kind: 'inventory-stack', personId: person.id, stackId: 'stack-test-food' }],
    status: 'completed',
    result: '鹿迟疑着凑近，低头吃掉了食物',
    effects: [
      { kind: 'consume', target: { kind: 'inventory-stack', personId: person.id, stackId: 'stack-test-food' }, quantity: 1 },
      { kind: 'bond-animal', target: { kind: 'animal', animalId: animal.id }, summary: '喂食并安抚' },
    ],
  },
};
const fact1 = executePrimitiveAction(state, person, feedAction, 1, 0, { cause: 'intent', actionTick: 0 });
assert.equal(fact1.status, 'completed', `喂食应成功：${fact1.result}`);
let trust = bonds.animalBondTrust(state.world, animal.id, person.id);
assert.equal(trust, 14, `喂食应 +14，实际 ${trust}`);
console.log('[bonds] 喂食绑定通过');

// 徒手安抚
const petAction = {
  kind: 'world-interact',
  adjudication: {
    version: 'world-adjudicated-interaction-v1',
    request: '伸手慢慢抚摸鹿的颈侧',
    targets: [{ kind: 'animal', animalId: animal.id }],
    status: 'completed',
    result: '鹿没有躲开',
    effects: [{ kind: 'bond-animal', target: { kind: 'animal', animalId: animal.id }, summary: '轻抚' }],
  },
};
const fact2 = executePrimitiveAction(state, person, petAction, 1, 1, { cause: 'intent', actionTick: 1 });
assert.equal(fact2.status, 'completed');
trust = bonds.animalBondTrust(state.world, animal.id, person.id);
assert.equal(trust, 18, `徒手应再 +4，实际 ${trust}`);
console.log('[bonds] 徒手接触通过');

// 驯熟判定与月度淡化
state.world.animalBonds[0] = { ...state.world.animalBonds[0], trust: 50 };
assert.ok(bonds.animalIsTameToward(state.world, animal.id, person.id), '信任 50 应驯熟');
state.world.animalBonds[0] = { ...state.world.animalBonds[0], lastContactAtMonth: 0 };
bonds.advanceAnimalBondsMonth(state.world, 8);
assert.ok(bonds.animalBondTrust(state.world, animal.id, person.id) < 50, '六个月无接触应淡化');
console.log('[bonds] 驯熟与淡化通过');

rmSync(temporaryDirectory, { recursive: true, force: true });
console.log('动物绑定定点自测全部通过');
