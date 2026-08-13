import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-monthly-test-'));
const bundlePath = path.join(temporaryDirectory, 'simulation.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/simulation.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  const { createInitialState, createSimulation, stepSimulationAsync } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const initial = createInitialState(31, { endpoint: { kind: 'months', value: 180 } });
  assert.equal(initial.schemaVersion, 12);
  assert.deepEqual(initial.clock, { unit: 'month', elapsedMonths: 0, monthsPerYear: 12 });
  assert.equal(initial.world.grid.width, 84);
  assert.equal(initial.world.grid.depth, 52);
  assert.equal(initial.world.grid.levels, 12);
  assert.equal(initial.world.grid.voxels.length, 84 * 52 * 12);
  assert.ok(initial.people.every((person) => Number.isInteger(person.position.cellId) && person.inventory.length > 0));
  assert.equal('agents' in initial, false, '权威状态不应保留旧 Agent 模型');
  assert.equal('plans' in initial, false, '权威状态不应保留 PlanMode');
  assert.equal('cells' in initial.world.grid, false, '格子不应保留属性包');

  const controller = createSimulation({ seed: 31, config: { endpoint: { kind: 'months', value: 180 }, chaosIntensity: 0 } });
  let state = controller.getState();
  for (let index = 0; index < 72 && state.civilization.status === 'running'; index += 1) state = controller.step();
  const opportunities = state.world.past.filter((event) => event.kind === 'decision-opportunity');
  assert.ok(opportunities.length >= initial.people.length * 24, '在世人物每月应留下概率账本');
  assert.ok(opportunities.every((event) => event.probability > 0), '每个人每月关键决策概率必须非零');
  assert.ok(state.intents.some((intent) => intent.actionEventIds.length > 1), '长期意图应跨月推进原子动作');
  assert.ok(state.world.past.some((event) => event.kind === 'action' && event.action.kind === 'transfer'), '应真实发生掉落物到私有背包的转移');
  assert.ok(state.world.past.some((event) => event.kind === 'action' && event.action.kind === 'act' && event.action.operation === 'ingest'), '身体储备应通过摄入动作恢复');
  assert.ok(state.world.past.some((event) => event.kind === 'environment' && event.change === 'material'), '无人行动时世界物质也应继续变化');
  assert.ok(state.world.past.some((event) => event.kind === 'action' && event.action.kind === 'communicate' && event.action.content.kind === 'offer' && event.action.content.proposal?.kind === 'reproduce'), '生殖应先产生沟通提议');
  assert.ok(state.world.past.some((event) => event.kind === 'action' && event.action.kind === 'communicate' && event.action.content.kind === 'accept'), '双方同意必须留下接受事实');
  assert.ok(state.world.past.some((event) => event.kind === 'action' && event.action.kind === 'act' && event.action.operation === 'reproduce'), '接受之后才能执行生殖原语');
  assert.ok(state.people.some((person) => person.generation > 0), '妊娠跨月过程应能产生后代');

  const legacy = structuredClone(initial);
  legacy.schemaVersion = 11;
  assert.throws(() => createSimulation({ state: legacy }), /不支持继续演化/, '旧属性格与 PlanMode 存档必须硬切拒绝');

  let calls = 0;
  const batch = {
    async decideAll(contexts) { calls += contexts.length; return contexts.map(() => null); },
    takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
  };
  let budgetState = createInitialState(17, { endpoint: { kind: 'months', value: 24 } });
  for (let index = 0; index < 12; index += 1) budgetState = await stepSimulationAsync(budgetState, batch);
  const personMonths = budgetState.decisionBudget.ledgers.reduce((sum, ledger) => sum + ledger.livingAgents, 0);
  assert.ok(calls <= Math.floor(personMonths / 12), '模型上下文不得超过每 12 人月一个的滚动额度');

  console.log(`simulation tests passed: schema 12, ${state.people.length} people, ${state.world.past.length} facts, ${state.derived.milestones.length} milestones, ${calls}/${Math.floor(personMonths / 12)} model contexts`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
