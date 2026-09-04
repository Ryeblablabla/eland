import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-fix-d-'));
const bundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const projectDirectory = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

execFileSync(path.resolve('node_modules/.bin/esbuild'), [
  'src/game/eland/simulation.ts', '--bundle', '--format=esm', '--platform=node', `--outfile=${bundlePath}`,
], { cwd: projectDirectory, stdio: 'inherit' });

const sim = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
const executor = await import(`${pathToFileURL(path.join(temporaryDirectory, 'executor.mjs')).href}?test=${Date.now()}`).catch(() => null);

// executePrimitiveAction 不在 simulation.ts 出口时，单独打包 action-executor
let executePrimitiveAction = sim.executePrimitiveAction;
if (!executePrimitiveAction) {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/domain/action-executor.ts', '--bundle', '--format=esm', '--platform=node',
    `--outfile=${path.join(temporaryDirectory, 'executor.mjs')}`,
  ], { cwd: projectDirectory, stdio: 'inherit' });
  ({ executePrimitiveAction } = await import(`${pathToFileURL(path.join(temporaryDirectory, 'executor.mjs')).href}?test=${Date.now()}`));
}
const { createInitialState } = sim;

const state = createInitialState(31, { endpoint: { kind: 'months', value: 24 } });
const person = state.people[0];
const perceptionRadius = 4 + Math.floor(person.baselineCapacities.perception / 25);
const px = person.position.cellId % state.world.grid.width;
const py = Math.floor(person.position.cellId / state.world.grid.width);

// 找一个在感知半径内、但距离 >1 的地面掉落物
const drop = state.world.drops.find((candidate) => {
  if (candidate.quantity < 1) return false;
  const dx = candidate.cellId % state.world.grid.width;
  const dy = Math.floor(candidate.cellId / state.world.grid.width);
  const dist = Math.abs(dx - px) + Math.abs(dy - py);
  return dist > 1 && dist <= perceptionRadius;
});
assert.ok(drop, '需要存在一个感知内但不可及的地面对象');

const action = {
  kind: 'world-interact',
  adjudication: {
    version: 'world-adjudicated-interaction-v1',
    request: '拾起地上的材料',
    expectedResult: '拿到材料',
    targets: [{ kind: 'drop', dropId: drop.id }],
    status: 'completed',
    result: '成功拾起材料',
    effects: [
      { kind: 'consume', target: { kind: 'drop', dropId: drop.id }, quantity: 1 },
      { kind: 'produce', materialId: drop.materialId, quantity: 1, destination: 'inventory' },
    ],
  },
};

const startDist = Math.abs(drop.cellId % state.world.grid.width - px)
  + Math.abs(Math.floor(drop.cellId / state.world.grid.width) - py);
let fact;
for (let tick = 0; tick < 12; tick += 1) {
  fact = executePrimitiveAction(state, person, action, 1, tick, { cause: 'intent', actionTick: tick });
  if (fact.status !== 'progressed') break;
}
assert.ok(fact, '执行应产生事件');

// 第一击应当是接近而非 blocked（只要存在可达路径）
const firstDist = Math.abs(drop.cellId % state.world.grid.width - person.position.cellId % state.world.grid.width)
  + Math.abs(Math.floor(drop.cellId / state.world.grid.width) - Math.floor(person.position.cellId / state.world.grid.width));
assert.notEqual(fact.status, 'blocked', `存在可达路径时不应受阻：${fact.result}`);
if (fact.status === 'completed') {
  const gained = person.inventory.some((stack) => stack.materialId === drop.materialId);
  assert.ok(gained, '抵达后应重试原交互并取得材料');
  console.log(`[fix-D] 接近→重试→取得材料 通过（起点距离 ${startDist}，终点距离 ${firstDist}）`);
} else {
  assert.ok(firstDist < startDist, '接近应缩短与目标的距离');
  console.log(`[fix-D] 接近推进通过（${startDist} → ${firstDist}，结果：${fact.result.slice(0, 40)}）`);
}

// 多地点原子行动必须受阻而不是往返拉锯
const state2 = createInitialState(31, { endpoint: { kind: 'months', value: 24 } });
const person2 = state2.people[0];
const p2x = person2.position.cellId % state2.world.grid.width;
const p2y = Math.floor(person2.position.cellId / state2.world.grid.width);
const p2Radius = 4 + Math.floor(person2.baselineCapacities.perception / 25);
const near = state2.world.drops.filter((candidate) => {
  if (candidate.quantity < 1) return false;
  const dist = Math.abs(candidate.cellId % state2.world.grid.width - p2x)
    + Math.abs(Math.floor(candidate.cellId / state2.world.grid.width) - p2y);
  return dist <= p2Radius;
});
let pair;
for (const a of near) {
  const distA = Math.abs(a.cellId % state2.world.grid.width - p2x)
    + Math.abs(Math.floor(a.cellId / state2.world.grid.width) - p2y);
  if (distA > 1) continue;
  const b = near.find((candidate) => candidate !== a
    && (Math.abs(candidate.cellId % state2.world.grid.width - p2x)
      + Math.abs(Math.floor(candidate.cellId / state2.world.grid.width) - p2y)) > 2);
  if (b) { pair = [a, b]; break; }
}
if (pair) {
  const multiAction = {
    kind: 'world-interact',
    adjudication: {
      version: 'world-adjudicated-interaction-v1',
      request: '取此处的材料并作用于另一处的对象',
      targets: pair.map((site) => ({ kind: 'drop', dropId: site.id })),
      status: 'completed',
      result: '成功',
      effects: [
        { kind: 'consume', target: { kind: 'drop', dropId: pair[0].id }, quantity: 1 },
        { kind: 'consume', target: { kind: 'drop', dropId: pair[1].id }, quantity: 1 },
      ],
    },
  };
  const multiFact = executePrimitiveAction(state2, person2, multiAction, 1, 0, { cause: 'intent', actionTick: 0 });
  assert.equal(multiFact.status, 'blocked', `多地点原子行动必须受阻：${multiFact.result}`);
  assert.ok(multiFact.diff.worldAdjudicatedMultiSite, `应带多地点标记：${JSON.stringify(multiFact.diff)}`);
  console.log('[fix-D] 多地点受阻通过');
} else {
  console.log('[fix-D] 多地点用例跳过（感知内缺少两处对象）');
}

rmSync(temporaryDirectory, { recursive: true, force: true });
console.log('Fix D 定点自测通过');
