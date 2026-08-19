import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-decision-factor-forest-test-'));
const bundlePath = path.join(temporaryDirectory, 'decision-factor-forest.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { buildDecisionContext, recompileNextAction } from ${JSON.stringify(path.resolve('src/game/eland/application/action-options.ts'))};
    export { evaluateDecisionOption } from ${JSON.stringify(path.resolve('src/game/eland/application/decision-factor-forest.ts'))};
    export { RulePlanner } from ${JSON.stringify(path.resolve('src/game/eland/application/rule-planner.ts'))};
    export { composeIntentChoice } from ${JSON.stringify(path.resolve('src/game/eland/domain/intent.ts'))};
    export { optionAllowedForLifeStage } from ${JSON.stringify(path.resolve('src/game/eland/application/age-planning.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { cellX, cellY, neighbors4, setVoxel, voxelAt } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=decision-factor-forest-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    buildDecisionContext,
    composeIntentChoice,
    createInitialState,
    evaluateDecisionOption,
    Material,
    cellX,
    cellY,
    neighbors4,
    optionAllowedForLifeStage,
    recompileNextAction,
    RulePlanner,
    setVoxel,
    voxelAt,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(260616014, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const person = state.people[0];
  person.bornAtMonth = -20 * 12;
  const beforePreview = structuredClone(state);
  const context = buildDecisionContext(state, person);
  assert.deepEqual(state, beforePreview, '候选编译不得打开真实项目搜索、物流或改写任何权威状态');

  const noMotive = {
    id: 'test:no-motive', summary: '原地踏步', reason: '没有压力与来源',
    goal: { kind: 'at-cell', cellId: person.position.cellId },
    nextAction: { kind: 'move', toCellId: person.position.cellId },
    estimatedDuration: 'one-month', sourceFactIds: [],
  };
  const urgentHydration = {
    id: 'test:urgent-hydration', summary: '恢复水分', reason: '本人缺水',
    goal: { kind: 'body-at-least', field: 'hydration', value: 60 },
    nextAction: { kind: 'act', operation: 'ingest', targets: [{ kind: 'voxel', position: { x: 0, y: 0, z: 0 } }] },
    estimatedDuration: 'one-month', sourceFactIds: ['visible-water'],
  };
  person.body.hydration = 20;
  const moment = { atMonth: 1, planningTick: 2 };
  const first = evaluateDecisionOption(context, urgentHydration, moment);
  const second = evaluateDecisionOption(context, urgentHydration, moment);
  assert.deepEqual(first, second, '同种子、同事实、同刻度的因子投票必须完全确定');
  assert.ok(first.votes.some((item) => item.tree === 'need' && item.score > 0));
  assert.ok(first.causalScore > evaluateDecisionOption(context, noMotive, moment).causalScore, '真实身体缺口必须高于无来源空动作');

  const reserveState = createInitialState(814, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const reserveKeeper = reserveState.people[0];
  reserveKeeper.bornAtMonth = -20 * 12;
  reserveKeeper.body.nutrition = 80;
  reserveKeeper.inventory = [{ id: 'surplus-food', materialId: Material.Food, quantity: 2, sourceEventIds: ['gathered-surplus'] }];
  reserveState.world.drops = [];
  const granaryPosition = neighbors4(reserveKeeper.position.cellId).map((cellId) => ({
    cellId,
    x: cellX(cellId),
    y: cellY(cellId),
    z: reserveKeeper.position.z,
  })).find((position) => voxelAt(reserveState.world.grid, position.x, position.y, position.z) === Material.Air
    && voxelAt(reserveState.world.grid, position.x, position.y, position.z - 1) !== Material.Air);
  assert.ok(granaryPosition, '测试人物附近必须存在可放置谷仓的位置');
  setVoxel(reserveState.world.grid, granaryPosition.x, granaryPosition.y, granaryPosition.z, Material.Granary);
  const granary = {
    id: `test-granary:${granaryPosition.x}:${granaryPosition.y}:${granaryPosition.z}`,
    position: { x: granaryPosition.x, y: granaryPosition.y, z: granaryPosition.z },
    inventory: [], createdAtMonth: 0, sourceEventIds: ['built-granary'], capacity: 96,
  };
  reserveState.containers = [granary];
  const reserveContext = buildDecisionContext(reserveState, reserveKeeper);
  const reserveDeposit = reserveContext.options.find((option) => option.id.startsWith(`store-container:${granary.id}:`));
  assert.ok(reserveDeposit, '身体安全且持有两份食物的人应能形成眼前谷仓的余粮候选');
  const recompiledDeposit = recompileNextAction(reserveState, reserveKeeper, {
    id: 'ordinary-store-intent', ownerId: reserveKeeper.id, summary: '存入余粮', domain: 'strategic',
    goal: { kind: 'container-inventory-at-least', containerId: granary.id, materialId: Material.Food, quantity: 20 },
    nextAction: reserveDeposit.nextAction, target: { kind: 'container', containerId: granary.id },
    status: 'active', createdAtMonth: 0, lastProgressAtMonth: 0, progress: 0,
    sourceFactIds: ['gathered-surplus'], actionEventIds: [], replanCount: 0,
  });
  assert.equal(recompiledDeposit?.kind, 'transfer');
  assert.equal(recompiledDeposit?.kind === 'transfer' ? recompiledDeposit.quantity : 0, 1, '普通存粮意图重编译后仍必须保留一份私粮');
  reserveKeeper.inventory[0].quantity = 1;
  assert.equal(recompileNextAction(reserveState, reserveKeeper, {
    id: 'unsafe-store-intent', ownerId: reserveKeeper.id, summary: '存入最后一份', domain: 'strategic',
    goal: { kind: 'container-inventory-at-least', containerId: granary.id, materialId: Material.Food, quantity: 20 },
    nextAction: reserveDeposit.nextAction, target: { kind: 'container', containerId: granary.id },
    status: 'active', createdAtMonth: 0, lastProgressAtMonth: 0, progress: 0,
    sourceFactIds: ['gathered-surplus'], actionEventIds: [], replanCount: 0,
  }), null, '普通存粮意图不得在抵达后拿走最后一份私粮');

  const emptyContext = { ...context, options: [noMotive], followUpOptions: [] };
  const decision = new RulePlanner().decideAt(emptyContext, moment);
  assert.equal(decision.kind, 'idle', '全部因果票不为正时必须显式空闲，随机同分值不能制造动机');

  const opening = {
    id: 'conversation:care:test', summary: '谈论照护', reason: '共同经历',
    goal: { kind: 'near-person', personId: state.people[1].id },
    nextAction: {
      kind: 'communicate', channel: 'voice', audience: [state.people[1].id],
      content: {
        id: 'conversation:care:test', kind: 'claim', summary: '你还好吗',
        conversation: {
          version: 'grounded-conversation-v1', basisKey: 'care:test', topic: 'care', turn: 'opening',
          speakerId: person.id, listenerId: state.people[1].id, sourceFactIds: ['care-source'],
        },
      },
    },
    target: { kind: 'person', personId: state.people[1].id },
    estimatedDuration: 'one-month', sourceFactIds: ['care-source'], requiresFollowUp: true, domain: 'social',
  };
  const unrelated = { ...noMotive, id: 'test:unrelated', sourceFactIds: ['other-source'] };
  assert.equal(composeIntentChoice([opening], [unrelated], opening.id, unrelated.id), null, '对话不能绑定语义无关的最高分动作');
  const groundedFollowUp = { ...unrelated, id: 'test:grounded-follow-up', sourceFactIds: ['care-source'] };
  assert.ok(composeIntentChoice([opening], [groundedFollowUp], opening.id, groundedFollowUp.id), '共享人物、项目或事实来源的后续行动仍可组合');

  const childState = structuredClone(state);
  const child = childState.people[0];
  child.bornAtMonth = childState.clock.elapsedMonths - 8 * 12;
  const childContext = buildDecisionContext(childState, child);
  assert.ok(childContext.options.every((option) => optionAllowedForLifeStage('learning-child', option)), '年龄门禁必须内置在每次候选编译中，而非只在月初执行一次');

  const forecastStateA = createInitialState(260403091, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const forecasterA = forecastStateA.people[0];
  const audienceA = forecastStateA.people[1];
  forecasterA.bornAtMonth = -20 * 12;
  audienceA.bornAtMonth = -20 * 12;
  audienceA.position = structuredClone(forecasterA.position);
  forecasterA.baselineCapacities.cognition = 100;
  forecasterA.baselineCapacities.perception = 100;
  forecastStateA.eraPredictions = [];
  const forecastStateB = structuredClone(forecastStateA);
  forecastStateA.civilization.era.endsAtMonth = 3;
  forecastStateB.civilization.era.endsAtMonth = 300;
  const forecastA = buildDecisionContext(forecastStateA, forecasterA).options.find((option) => option.id.startsWith('predict-era:'));
  const forecasterB = forecastStateB.people.find((candidate) => candidate.id === forecasterA.id);
  const forecastB = buildDecisionContext(forecastStateB, forecasterB).options.find((option) => option.id.startsWith('predict-era:'));
  assert.equal(forecastA?.summary, forecastB?.summary, '纪元预测不得读取调度器尚未发生的结束月份');

  let nearTermForecast = null;
  for (let month = 0; month <= 60 && !nearTermForecast; month += 1) {
    forecastStateA.clock.elapsedMonths = month;
    nearTermForecast = buildDecisionContext(forecastStateA, forecasterA).options.find((option) => option.id.startsWith('predict-era:')) ?? null;
  }
  assert.ok(nearTermForecast, '高认知人物应在历史估计进入六个月窗口后形成近期预言候选');
  const predictedStartMonth = nearTermForecast.nextAction.kind === 'communicate'
    && nearTermForecast.nextAction.content.kind === 'prediction'
    ? nearTermForecast.nextAction.content.prediction.predictedStartMonth
    : Number.POSITIVE_INFINITY;
  assert.ok(
    predictedStartMonth > forecastStateA.clock.elapsedMonths
      && predictedStartMonth <= forecastStateA.clock.elapsedMonths + 6,
    '纪元预言只能指向未来六个月内，不得发布几年后的远期预言',
  );
  for (const seed of [185, 20260815, 20260816]) {
    const seededState = createInitialState(seed, { endpoint: { kind: 'months', value: 72 }, chaosIntensity: 5 });
    const seededForecaster = seededState.people[0];
    const seededAudience = seededState.people[1];
    seededForecaster.bornAtMonth = -20 * 12;
    seededAudience.bornAtMonth = -20 * 12;
    seededAudience.position = structuredClone(seededForecaster.position);
    seededForecaster.baselineCapacities.cognition = 100;
    seededForecaster.baselineCapacities.perception = 100;
    let seededForecast = null;
    for (let month = 0; month <= 60 && !seededForecast; month += 1) {
      seededState.clock.elapsedMonths = month;
      seededForecast = buildDecisionContext(seededState, seededForecaster).options.find((option) => option.id.startsWith('predict-era:')) ?? null;
    }
    assert.ok(seededForecast, `种子 ${seed} 应在估计进入近期窗口后形成预言候选`);
    const seededPredictedMonth = seededForecast.nextAction.kind === 'communicate'
      && seededForecast.nextAction.content.kind === 'prediction'
      ? seededForecast.nextAction.content.prediction.predictedStartMonth
      : Number.POSITIVE_INFINITY;
    assert.ok(seededPredictedMonth <= seededState.clock.elapsedMonths + 6, `种子 ${seed} 不得形成远期预言`);
  }

  console.log('decision factor forest tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
