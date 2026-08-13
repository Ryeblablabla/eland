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
  const { buildDecisionContexts, createInitialState, createSimulation, stepSimulation, stepSimulationAsync } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const initial = createInitialState(31, { endpoint: { kind: 'months', value: 180 } });
  assert.equal(initial.schemaVersion, 13);
  assert.deepEqual(initial.clock, { unit: 'month', elapsedMonths: 0, monthsPerYear: 12 });
  assert.equal(initial.world.grid.width, 84);
  assert.equal(initial.world.grid.depth, 52);
  assert.equal(initial.world.grid.levels, 12);
  assert.equal(initial.world.grid.voxels.length, 84 * 52 * 12);
  assert.ok(initial.people.every((person) => Number.isInteger(person.position.cellId) && person.inventory.length > 0));
  assert.equal('agents' in initial, false, '权威状态不应保留旧 Agent 模型');
  assert.equal('plans' in initial, false, '权威状态不应保留 PlanMode');
  assert.equal('cells' in initial.world.grid, false, '格子不应保留属性包');

  let dialogueState = createInitialState(31, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const speaker = dialogueState.people[0];
  const listener = dialogueState.people[1];
  listener.position.cellId = speaker.position.cellId;
  listener.position.previousCellId = speaker.position.cellId;
  const dialogueContext = buildDecisionContexts(dialogueState).find((context) => context.person.id === speaker.id);
  assert.ok(dialogueContext, '测试人物必须拥有决策上下文');
  assert.ok(dialogueContext.options.some((option) => option.requiresFollowUp) && dialogueContext.followUpOptions.length, '普通对话必须同时存在合法的非沟通后续行动');
  assert.ok(dialogueContext.options.filter((option) => option.nextAction.kind === 'communicate').every((option) => option.requiresFollowUp), '每项对话决策都必须绑定后续真实行动');
  dialogueState.decisionBudget.credits = dialogueState.people.length;
  dialogueState.decisionBudget.ledgers = [{ atMonth: 1, livingAgents: 60, candidates: 0, modelContexts: 0, inputTokens: 0, outputTokens: 0, chargedTokens: 0 }];
  dialogueState = await stepSimulationAsync(dialogueState, {
    async decideAll(contexts) {
      return contexts.map((context) => {
        const talk = context.options.find((option) => option.requiresFollowUp);
        const followUp = context.followUpOptions[0];
        return talk && followUp
          ? { kind: 'start', optionId: talk.id, followUpOptionId: followUp.id, utterance: `我准备${followUp.summary}`, reason: '对话后落实行动' }
          : { kind: 'idle', reason: '保持观察' };
      });
    },
    takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
  });
  const dialogueIntent = dialogueState.intents.find((intent) => intent.openingAction?.kind === 'communicate');
  assert.ok(dialogueIntent?.openingActionCompleted, '对话应作为同一意图的开场动作完成');
  const dialogueIntentActions = dialogueState.world.past.filter((event) => event.kind === 'action' && event.intentId === dialogueIntent?.id);
  assert.equal(dialogueIntentActions[0]?.action.kind, 'communicate', '组合意图必须先说出模型生成的话');
  assert.ok(dialogueIntentActions.slice(1).some((event) => event.action.kind !== 'communicate'), '说完以后必须推进同次决策选定的真实行动');

  let state = createInitialState(31, { endpoint: { kind: 'months', value: 180 }, chaosIntensity: 0 });
  for (let index = 0; index < 72 && state.civilization.status === 'running'; index += 1) state = stepSimulation(state);
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
  legacy.schemaVersion = 12;
  assert.throws(() => createSimulation({ state: legacy }), /不支持继续演化/, '旧属性格与 PlanMode 存档必须硬切拒绝');

  let calls = 0;
  const batch = {
    async decideAll(contexts) { calls += contexts.length; return contexts.map(() => ({ kind: 'idle', reason: '测试中的合法模型决策' })); },
    takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
  };
  let budgetState = createInitialState(17, { endpoint: { kind: 'months', value: 24 } });
  for (let index = 0; index < 12; index += 1) budgetState = await stepSimulationAsync(budgetState, batch);
  const personMonths = budgetState.decisionBudget.ledgers.reduce((sum, ledger) => sum + ledger.livingAgents, 0);
  assert.ok(calls <= Math.floor(personMonths / 12), '模型上下文不得超过每 12 人月一个的滚动额度');

  assert.ok(initial.people.every((person) => Array.isArray(person.memories)), '人物应持有固定预算记忆');
  assert.ok(state.world.past.some((event) => event.kind === 'action' && event.cause === 'survival-reflex'), '生存维护应由规则反射产生可审计动作');
  assert.ok(state.people.every((person) => person.memories.length <= 24), '人物记忆必须保持固定上限');
  const lastMonthActions = state.lastStep.filter((event) => event.kind === 'action');
  assert.ok(lastMonthActions.every((event) => event.actionTick >= 1 && event.actionTick <= 15), '原子行动必须归属 1–15 的月内规则刻度');
  assert.ok(state.people.filter((person) => person.bornAtMonth < state.clock.elapsedMonths).every((person) => person.position.tickPath.length === 16), '每位人物每月必须留下月初加 15 刻度的位置轨迹');
  for (const event of state.world.past.filter((fact) => fact.kind === 'action' && fact.action.kind === 'move')) {
    assert.ok(event.pathSegment.length <= 2, '单个行动刻度不允许跨越多个格子');
    if (event.pathSegment.length === 2) {
      const [from, to] = event.pathSegment;
      const distance = Math.abs(from % 84 - to % 84) + Math.abs(Math.floor(from / 84) - Math.floor(to / 84));
      assert.equal(distance, 1, '每个空间路径步必须连接四邻格');
    }
  }
  console.log(`simulation tests passed: schema 13, ${state.people.length} people, ${state.world.past.length} facts, ${state.derived.milestones.length} milestones, ${calls}/${Math.floor(personMonths / 12)} model contexts`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
