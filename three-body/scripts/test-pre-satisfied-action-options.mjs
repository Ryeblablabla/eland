import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-pre-satisfied-options-'));
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');

try {
  const entry = `
    export { createInitialState, stepSimulationAsync } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/simulation.ts'))};
    export { buildDecisionContext } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/action-options.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=pre-satisfied-action-options-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    Material,
    buildDecisionContext,
    createInitialState,
    stepSimulationAsync,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(26083043, {
    endpoint: { kind: 'months', value: 24 },
    chaosIntensity: 0,
  });
  const actor = state.people[0];
  assert.ok(actor);
  state.people = [actor];
  actor.bornAtMonth = -30 * 12;
  actor.conditions = [];
  actor.memories = [];
  actor.inventory = [
    { id: 'saturated-stone-tool', materialId: Material.StoneTool, quantity: 1, sourceEventIds: [] },
    { id: 'saturated-wood', materialId: Material.Wood, quantity: 1, sourceEventIds: [] },
  ];
  const technique = {
    id: `technique:exert:${Material.StoneTool}:${Material.Wood}:${Material.Air}:${Material.WoodTablet}`,
    kind: 'technique',
    summary: '用石制工具向木材施力，可得到木制记录板',
    confidence: 82,
    learnedAtMonth: 0,
    sourceEventIds: [],
  };
  actor.knowledge = [technique];

  const improvable = buildDecisionContext(state, actor, 1).options.find((option) => (
    option.id.startsWith('repeat-exert:')
      && option.nextAction.kind === 'act'
      && option.nextAction.targets.some((target) => target.kind === 'inventory-stack'
        && target.stackId === 'saturated-wood')
  ));
  assert.ok(improvable, '尚未达到下一置信阈值的亲历技术仍应提供一次真实复验');
  assert.deepEqual(improvable.goal, {
    kind: 'knowledge', factId: technique.id, minConfidence: 100,
  });

  technique.confidence = 100;
  const saturatedContext = buildDecisionContext(state, actor, 1);
  assert.equal(saturatedContext.options.some((option) => option.id === improvable.id), false,
    '已经达到目标置信度的复验不得进入 DecisionContext');
  assert.equal(saturatedContext.followUpOptions.some((option) => option.id === improvable.id), false,
    '已经满足的知识目标也不得作为对话 follow-up 绕过候选门禁');
  assert.equal(saturatedContext.options.some((option) => option.goal.kind === 'knowledge'
    && option.goal.factId === technique.id
    && (option.goal.minConfidence ?? 0) <= technique.confidence), false,
  '候选生成层不得暴露创建前已经满足的知识目标');

  const attemptState = createInitialState(26083044, {
    endpoint: { kind: 'months', value: 2 },
    chaosIntensity: 0,
  });
  const experimenter = attemptState.people[0];
  experimenter.inventory = [{
    id: 'attempt-fiber', materialId: Material.Fiber, quantity: 2, sourceEventIds: [],
  }];
  const attemptIntentId = 'intent-attempt-marker-control';
  attemptState.intents = [{
    id: attemptIntentId,
    ownerId: experimenter.id,
    summary: '尝试结合两份纤维',
    domain: 'strategic',
    goal: { kind: 'knowledge', factId: 'attempt:bounded-combine-control' },
    nextAction: {
      kind: 'act', operation: 'combine', targets: [
        { kind: 'inventory-stack', personId: experimenter.id, stackId: 'attempt-fiber' },
        { kind: 'inventory-stack', personId: experimenter.id, stackId: 'attempt-fiber' },
      ],
    },
    status: 'active',
    createdAtMonth: 0,
    lastProgressAtMonth: 0,
    progress: 0,
    sourceDecisionEventId: 'decision-attempt-marker-control',
    plannedDurationMonths: 3,
    stateGoalUntilMonth: 2,
    sourceFactIds: [],
    actionEventIds: [],
    replanCount: 0,
  }];
  experimenter.activeIntentId = attemptIntentId;
  attemptState.decisionBudget.credits = 0;
  const attempted = await stepSimulationAsync(attemptState, {
    async decideAll(contexts) { return contexts.map(() => ({ kind: 'idle', reason: '不改写固定实验' })); },
    takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
  });
  const attemptAction = attempted.world.past.find((event) => event.kind === 'action'
    && event.intentId === attemptIntentId
    && event.action.kind === 'act'
    && event.action.operation === 'combine');
  assert.ok(attemptAction, JSON.stringify({
    message: '`attempt:*` 有界实验仍必须执行真实原子动作',
    intent: attempted.intents.find((intent) => intent.id === attemptIntentId),
    actorEvents: attempted.world.past.filter((event) => event.who === experimenter.id),
  }, null, 2));

  console.log(JSON.stringify({ ok: true, filteredOptionId: improvable.id }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
