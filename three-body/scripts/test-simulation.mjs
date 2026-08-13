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
    'src/game/eland/simulation.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  const { createInitialState, createSimulation, stepSimulationAsync } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const initial = createInitialState(31, { endpoint: { kind: 'months', value: 180 } });
  assert.equal(initial.schemaVersion, 11);
  assert.deepEqual(initial.clock, { unit: 'month', elapsedMonths: 0, monthsPerYear: 12 });
  assert.equal(initial.world.grid.width, 84);
  assert.equal(initial.world.grid.height, 52);
  assert.equal(initial.world.grid.cells.terrainKind.length, 84 * 52);
  assert.ok(initial.agents.every((agent) => Number.isInteger(agent.position.cellId)));
  assert.equal('space' in initial.world, false, '权威世界不应保留六地点空间层');

  const controller = createSimulation({ seed: 31, config: { endpoint: { kind: 'months', value: 180 }, chaosIntensity: 0 } });
  let state = controller.getState();
  let shelterMonth = null;
  for (let index = 0; index < 60 && state.civilization.status === 'running'; index += 1) {
    state = controller.step();
    if (shelterMonth === null && state.world.structures.some((structure) => structure.effects.accessible)) shelterMonth = state.clock.elapsedMonths;
  }
  const opportunities = state.world.past.filter((event) => event.kind === 'decision-opportunity');
  assert.equal(opportunities.length, state.agents.length * state.clock.elapsedMonths, '每位在世人物每月都应有一次概率账本记录');
  assert.ok(opportunities.every((event) => event.probability > 0), '每个人每月关键决策概率必须非零');
  assert.ok(state.plans.some((plan) => plan.lastProgressAtMonth > plan.createdAtMonth), '长期计划应在后续月份继续推进');
  assert.ok(Math.max(...state.world.grid.traces.traffic) > 1, '只有真实逐格通行才能积累交通痕迹');
  assert.ok(shelterMonth !== null, '基准文明应能从采集推进到多格住所');
  const shelter = state.world.structures.find((structure) => structure.effects.accessible);
  assert.ok(shelter && shelter.componentIds.length === 7 && shelter.occupiedCells.length > 1, '住所必须由七个客观构件跨多格形成');
  const useMonths = new Set((shelter?.useEventIds ?? []).flatMap((eventId) => {
    const event = state.world.past.find((item) => item.id === eventId);
    return event ? [event.atMonth] : [];
  }));
  assert.ok(useMonths.size >= 2, '住所里程碑要求人物在不同月份真实入内休息');
  assert.ok(state.derived.milestones.some((milestone) => milestone.id === '20'));

  const legacy = structuredClone(initial);
  legacy.schemaVersion = 10;
  assert.throws(() => createSimulation({ state: legacy }), /不支持继续演化/, '旧六地点存档必须硬切拒绝');

  let calls = 0;
  const batch = {
    async decideAll(contexts) {
      calls += contexts.length;
      return contexts.map(() => null);
    },
    takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
  };
  let budgetState = createInitialState(17, { endpoint: { kind: 'months', value: 24 } });
  for (let index = 0; index < 12; index += 1) budgetState = await stepSimulationAsync(budgetState, batch);
  const personMonths = budgetState.decisionBudget.ledgers.reduce((sum, ledger) => sum + ledger.livingAgents, 0);
  assert.ok(calls <= Math.floor(personMonths / 12), '模型上下文不得超过每 12 人月一个的滚动额度');
  assert.ok(budgetState.decisionBudget.ledgers.every((ledger) => ledger.modelContexts === 0 || ledger.chargedTokens >= ledger.modelContexts * budgetState.decisionBudget.tokensPerContext));

  console.log(`simulation tests passed: schema 11, shelter month ${shelterMonth}, ${useMonths.size} shelter-use months, ${calls}/${Math.floor(personMonths / 12)} model contexts`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
