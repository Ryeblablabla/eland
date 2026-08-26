import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-decision-execution-test-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'decision-execution.mjs');

try {
  writeFileSync(entryPath, `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/simulation.ts'))};
    export {
      applyDecision,
      decisionPlanningChannel,
      executeActiveIntent,
      startIntent,
    } from ${JSON.stringify(path.resolve('src/game/eland/application/simulation/intent-execution.ts'))};
    export { planLocallyForTick } from ${JSON.stringify(path.resolve('src/game/eland/application/simulation/tick-planner.ts'))};
    export {
      createMonthExecution,
      executePlanningTick,
    } from ${JSON.stringify(path.resolve('src/game/eland/application/simulation/month-execution.ts'))};
    export { worldEventById } from ${JSON.stringify(path.resolve('src/game/eland/domain/event-index.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { setVoxel } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `, 'utf8');
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entryPath, '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });

  const {
    applyDecision,
    createMonthExecution,
    createInitialState,
    decisionPlanningChannel,
    executeActiveIntent,
    executePlanningTick,
    Material,
    planLocallyForTick,
    setVoxel,
    startIntent,
    worldEventById,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const makeContext = (state, person, option) => ({
    state,
    person,
    visibleCells: [],
    visiblePeople: [],
    options: [option],
    followUpOptions: [],
  });

  const idleEdgeState = createInitialState(26_082_610, {
    endpoint: { kind: 'months', value: 12 },
    chaosIntensity: 0,
  });
  const idleEdgePerson = idleEdgeState.people[0];
  assert.equal(decisionPlanningChannel(makeContext(idleEdgeState, idleEdgePerson, {
    id: 'respond-conversation:test-opening',
    summary: '回应当前对话',
    reason: '存在真实待回应对话',
    goal: { kind: 'at-cell', cellId: idleEdgePerson.position.cellId },
    nextAction: { kind: 'move', toCellId: idleEdgePerson.position.cellId, toZ: idleEdgePerson.position.z },
    estimatedDuration: 'one-month',
    sourceFactIds: [],
    domain: 'social',
  }), { kind: 'idle', reason: '先完成当前优先义务' }), 'edge', '由 edge 候选唤醒的月初 idle 不得消耗普通额度');

  const achievementState = createInitialState(26_082_601, {
    endpoint: { kind: 'months', value: 12 },
    chaosIntensity: 0,
  });
  const achiever = achievementState.people[0];
  const existingFood = achiever.inventory.find((stack) => stack.materialId === 21)?.quantity ?? 0;
  const achievementOption = {
    id: 'test-one-shot-inventory-achievement',
    summary: '取得一份已有食物',
    reason: '测试一次性成就的结算语义',
    goal: { kind: 'inventory-at-least', materialId: 21, quantity: existingFood },
    nextAction: { kind: 'move', toCellId: achiever.position.cellId, toZ: achiever.position.z },
    estimatedDuration: 'one-month',
    estimatedMonths: 1,
    sourceFactIds: [],
    domain: 'strategic',
  };
  const achievementIntent = startIntent(
    achievementState,
    achiever,
    makeContext(achievementState, achiever, achievementOption),
    achievementOption.id,
    undefined,
    'test-decision-achievement',
    1,
  );
  assert.equal(achievementIntent?.lifecycle?.completion, 'on-achievement', '一次性状态目标必须显式采用达成即结算，而不是按 goal.kind 推断维护期');
  assert.equal(achievementIntent?.stateGoalUntilMonth, undefined, '新的一次性目标不得再写入 legacy 状态维持期限');
  executeActiveIntent(achievementState, achiever, 1, 0, 1, []);
  assert.equal(achievementIntent?.status, 'completed', '已经满足的一次性目标应立即完成');

  const occupiedPlacementState = createInitialState(26_082_611, {
    endpoint: { kind: 'months', value: 12 },
    chaosIntensity: 0,
  });
  const occupiedPlacementActor = occupiedPlacementState.people[0];
  const occupiedPlacementBody = occupiedPlacementState.people[1];
  for (const person of occupiedPlacementState.people.slice(2)) person.diedAtMonth = 0;
  const occupiedX = 10;
  const occupiedY = 10;
  const occupiedZ = 5;
  const occupiedCellId = occupiedX + occupiedY * occupiedPlacementState.world.grid.width;
  occupiedPlacementBody.position = { cellId: occupiedCellId, z: occupiedZ };
  occupiedPlacementActor.position = { cellId: occupiedCellId - 1, z: occupiedZ };
  occupiedPlacementActor.inventory.push({
    id: 'decision-occupied-placement-wood',
    materialId: Material.Wood,
    quantity: 1,
    sourceEventIds: ['decision-occupied-placement-source'],
  });
  setVoxel(occupiedPlacementState.world.grid, occupiedX, occupiedY, occupiedZ, Material.Air);
  const occupiedPlacementIntent = {
    id: 'decision-occupied-placement-intent',
    ownerId: occupiedPlacementActor.id,
    summary: '把木材放入目标体素',
    domain: 'strategic',
    goal: { kind: 'at-cell', cellId: occupiedCellId + 1 },
    nextAction: {
      kind: 'act', operation: 'combine',
      targets: [
        { kind: 'inventory-stack', personId: occupiedPlacementActor.id, stackId: 'decision-occupied-placement-wood' },
        { kind: 'voxel', position: { x: occupiedX, y: occupiedY, z: occupiedZ } },
      ],
    },
    status: 'active',
    createdAtMonth: 1,
    lastProgressAtMonth: 1,
    progress: 0,
    sourceDecisionEventId: 'decision-occupied-placement',
    sourceFactIds: ['decision-occupied-placement-source'],
    actionEventIds: [],
    replanCount: 0,
  };
  occupiedPlacementState.intents.push(occupiedPlacementIntent);
  occupiedPlacementActor.activeIntentId = occupiedPlacementIntent.id;
  assert.equal(
    executeActiveIntent(occupiedPlacementState, occupiedPlacementActor, 1, 0, 1, []),
    null,
    '后续重编译才暴露的固体放置若当前被身体占据，应等待而不是提交 blocked ActionFact',
  );
  assert.equal(occupiedPlacementIntent.status, 'active', '临时身体占位不得终结长期意图');
  assert.deepEqual(occupiedPlacementIntent.actionEventIds, [], '等待身体离开不得伪造失败动作来源');
  assert.match(occupiedPlacementActor.currentActionText, /等待目标体素空出/);
  occupiedPlacementBody.diedAtMonth = 1;
  const resumedPlacement = executeActiveIntent(occupiedPlacementState, occupiedPlacementActor, 1, 0, 2, []);
  assert.equal(resumedPlacement?.kind, 'action', '身体离开后同一 active intent 应在下一 tick 自然恢复动作');
  assert.equal(resumedPlacement?.status, 'completed', '恢复的固体放置仍由领域执行器完成最终重验');

  const maintenanceState = createInitialState(26_082_602, {
    endpoint: { kind: 'months', value: 12 },
    chaosIntensity: 0,
  });
  const maintainer = maintenanceState.people[0];
  const maintenanceOption = {
    id: 'test-explicit-maintenance',
    summary: '在约定地点持续等待',
    reason: '测试只有显式声明的状态才会持续维护',
    goal: { kind: 'at-cell', cellId: maintainer.position.cellId },
    nextAction: { kind: 'move', toCellId: maintainer.position.cellId, toZ: maintainer.position.z },
    estimatedDuration: 'long',
    estimatedMonths: 1,
    completionPolicy: { kind: 'maintain-state', durationMonths: 3 },
    sourceFactIds: [],
    domain: 'strategic',
  };
  const maintenanceIntent = startIntent(
    maintenanceState,
    maintainer,
    makeContext(maintenanceState, maintainer, maintenanceOption),
    maintenanceOption.id,
    undefined,
    'test-decision-maintenance',
    1,
  );
  assert.deepEqual(maintenanceIntent?.lifecycle, {
    version: 'intent-lifecycle-v1',
    completion: 'maintain-state',
    reviewAtMonth: 3,
    maintainUntilMonth: 3,
  }, '显式维护期限必须独立于移动耗时并成为可审计生命周期');
  executeActiveIntent(maintenanceState, maintainer, 1, 0, 1, []);
  assert.equal(maintenanceIntent?.status, 'active', '显式维护目标在期限前应继续保持 active');
  executeActiveIntent(maintenanceState, maintainer, 3, 0, 1, []);
  assert.equal(maintenanceIntent?.status, 'completed', '显式维护目标到期且状态满足后应完成');

  const legacyState = createInitialState(26_082_603, {
    endpoint: { kind: 'months', value: 12 },
    chaosIntensity: 0,
  });
  const legacyPerson = legacyState.people[0];
  const legacyIntent = {
    id: 'legacy-state-goal',
    ownerId: legacyPerson.id,
    summary: '旧存档状态目标',
    domain: 'strategic',
    goal: { kind: 'at-cell', cellId: legacyPerson.position.cellId },
    nextAction: { kind: 'move', toCellId: legacyPerson.position.cellId, toZ: legacyPerson.position.z },
    status: 'active',
    createdAtMonth: 1,
    lastProgressAtMonth: 1,
    progress: 0,
    plannedDurationMonths: 3,
    stateGoalUntilMonth: 3,
    sourceDecisionEventId: 'legacy-decision',
    sourceFactIds: [],
    actionEventIds: [],
    replanCount: 0,
  };
  legacyState.intents.push(legacyIntent);
  legacyPerson.activeIntentId = legacyIntent.id;
  executeActiveIntent(legacyState, legacyPerson, 1, 0, 1, []);
  assert.equal(legacyIntent.status, 'active', '没有 lifecycle 的旧 stateGoal 必须保留原有维护语义');

  const overdueState = createInitialState(26_082_609, {
    endpoint: { kind: 'months', value: 12 },
    chaosIntensity: 0,
  });
  const overduePerson = overdueState.people[0];
  const overdueIntent = {
    ...legacyIntent,
    id: 'overdue-unmet-intent',
    ownerId: overduePerson.id,
    goal: { kind: 'at-cell', cellId: overduePerson.position.cellId === 0 ? 1 : 0 },
    status: 'active',
    lifecycle: { version: 'intent-lifecycle-v1', completion: 'on-achievement', reviewAtMonth: 1 },
    stateGoalUntilMonth: undefined,
  };
  overdueState.intents.push(overdueIntent);
  overduePerson.activeIntentId = overdueIntent.id;
  const replacementFood = overduePerson.inventory.find((stack) => stack.materialId === 21)?.quantity ?? 0;
  const replacementOption = {
    ...achievementOption,
    id: 'replacement-after-overdue-review',
    goal: { kind: 'inventory-at-least', materialId: 21, quantity: replacementFood },
  };
  startIntent(
    overdueState,
    overduePerson,
    makeContext(overdueState, overduePerson, replacementOption),
    replacementOption.id,
    undefined,
    'replacement-decision',
    2,
  );
  assert.equal(overdueIntent.status, 'blocked', '到期未满足的旧意图被替换前必须统一结算为 blocked');
  assert.equal(overdueIntent.goalOutcome?.kind, 'attempted-unmet', '是否存在 challenger 不得改变同一到期失败的学习样本');

  const cadenceState = createInitialState(26_082_604, {
    endpoint: { kind: 'months', value: 12 },
    chaosIntensity: 0,
  });
  const cadencePerson = cadenceState.people[0];
  const terminalIntent = {
    id: 'terminal-ordinary-intent',
    ownerId: cadencePerson.id,
    summary: '已经完成的普通意图',
    domain: 'strategic',
    goal: { kind: 'at-cell', cellId: cadencePerson.position.cellId },
    nextAction: { kind: 'move', toCellId: cadencePerson.position.cellId, toZ: cadencePerson.position.z },
    status: 'completed',
    createdAtMonth: 1,
    lastProgressAtMonth: 1,
    progress: 1,
    sourceDecisionEventId: 'ordinary-decision-1',
    sourceFactIds: [],
    actionEventIds: [],
    replanCount: 0,
  };
  cadenceState.intents.push(terminalIntent);
  const cadenceEvents = [{
    id: 'ordinary-decision-1',
    kind: 'decision',
    atMonth: 1,
    orderInMonth: 0,
    planningTick: 1,
    orderInTick: 0,
    cellId: cadencePerson.position.cellId,
    who: cadencePerson.id,
    decision: { kind: 'start', optionId: 'completed-option', reason: '第一项普通安排' },
    intentId: terminalIntent.id,
    planningChannel: 'ordinary',
    usedModel: false,
    result: '第一项普通安排已经完成',
  }, {
    id: 'same-month-action-source',
    kind: 'action',
    atMonth: 1,
    orderInMonth: 1,
    planningTick: 1,
    orderInTick: 1,
    cellId: cadencePerson.position.cellId,
    who: cadencePerson.id,
    intentId: terminalIntent.id,
    cause: 'intent',
    action: { kind: 'move', toCellId: cadencePerson.position.cellId, toZ: cadencePerson.position.z },
    fromCellId: cadencePerson.position.cellId,
    toCellId: cadencePerson.position.cellId,
    fromZ: cadencePerson.position.z,
    toZ: cadencePerson.position.z,
    pathSegment: [cadencePerson.position.cellId],
    status: 'completed',
    result: '第一项普通安排留下了本月动作事实',
    diff: {},
  }];
  const reviewedPeople = new Set([cadencePerson.id]);
  const cadence = {
    ordinaryDeliberationCounts: new Map([[cadencePerson.id, 1]]),
    ordinaryReplanPermits: new Set([cadencePerson.id]),
  };
  let ordinaryReplanCalls = 0;
  const idlePlanner = {
    decide(context) {
      ordinaryReplanCalls += 1;
      assert.equal(worldEventById(context.state, 'same-month-action-source')?.kind, 'action', '后续 deliberation 必须能解析前一 tick 的普通 ActionFact 来源');
      return { kind: 'idle', reason: '第二次普通 deliberation 已消费，但没有更好的合法行动' };
    },
  };
  planLocallyForTick(cadenceState, cadencePerson, 1, 2, cadenceEvents, idlePlanner, reviewedPeople, cadence);
  planLocallyForTick(cadenceState, cadencePerson, 1, 3, cadenceEvents, idlePlanner, reviewedPeople, cadence);
  assert.equal(ordinaryReplanCalls, 1, '普通根意图真实终结后只允许一次额外 deliberation，idle 也必须消费额度');
  assert.equal(cadence.ordinaryDeliberationCounts.get(cadencePerson.id), 2, '普通 idle 不制造重复事实，但必须进入显式月度额度');
  assert.equal(cadence.ordinaryReplanPermits.has(cadencePerson.id), false, '额外 deliberation 一进入规划器就必须消费 terminal permit');

  const edgeState = createInitialState(26_082_605, {
    endpoint: { kind: 'months', value: 12 },
    chaosIntensity: 0,
  });
  const edgePerson = edgeState.people[0];
  const completedEdgeIntent = {
    ...terminalIntent,
    id: 'terminal-edge-intent',
    ownerId: edgePerson.id,
    sourceDecisionEventId: 'edge-decision-1',
    goal: { kind: 'at-cell', cellId: edgePerson.position.cellId },
    nextAction: { kind: 'move', toCellId: edgePerson.position.cellId, toZ: edgePerson.position.z },
  };
  edgeState.intents.push(completedEdgeIntent);
  const edgeEvents = [{
    id: 'edge-decision-1',
    kind: 'decision',
    atMonth: 1,
    orderInMonth: 0,
    planningTick: 1,
    orderInTick: 0,
    cellId: edgePerson.position.cellId,
    who: edgePerson.id,
    decision: { kind: 'start', optionId: 'required-response-fixture', reason: '先处理边沿回应' },
    intentId: completedEdgeIntent.id,
    planningChannel: 'edge',
    usedModel: false,
    result: '边沿回应已经完成',
  }];
  let ordinaryCallsAfterEdge = 0;
  const edgeCadence = {
    ordinaryDeliberationCounts: new Map(),
    ordinaryReplanPermits: new Set(),
  };
  planLocallyForTick(edgeState, edgePerson, 1, 2, edgeEvents, {
    decide() {
      ordinaryCallsAfterEdge += 1;
      return { kind: 'idle', reason: '边沿任务不占普通 deliberation' };
    },
  }, new Set([edgePerson.id]), edgeCadence);
  assert.equal(ordinaryCallsAfterEdge, 1, '只有 edge 决策的 reviewed 人物仍应拥有本月第一次普通 deliberation');
  assert.equal(edgeCadence.ordinaryDeliberationCounts.get(edgePerson.id), 1, 'edge 后的普通 idle 必须消费第一次普通额度');

  const makePrepared = (state, atMonth, candidates = [], events = []) => ({
    state,
    events,
    contexts: candidates,
    candidates,
    naturallyTriggeredPeople: new Set(),
    livingAgents: state.people.length,
    atMonth,
  });
  const makeExecution = (prepared, decisions, planner) => {
    const execution = createMonthExecution({
      observationProjector: {},
      prepared,
      decisions,
      usage: { inputTokens: 0, outputTokens: 0 },
      attempted: { total: 0, ordinary: 0, exempt: 0 },
      tickPlanner: planner,
    });
    execution.participantIds = [prepared.state.people[0].id];
    return execution;
  };

  const carriedState = createInitialState(26_082_606, {
    endpoint: { kind: 'months', value: 12 },
    chaosIntensity: 0,
  });
  carriedState.clock.elapsedMonths = 3;
  const carriedPerson = carriedState.people[0];
  carriedPerson.body.health = 100;
  carriedPerson.body.hydration = 100;
  carriedPerson.body.nutrition = 100;
  carriedPerson.conditions = [];
  const carriedIntent = {
    id: 'carried-root-intent',
    ownerId: carriedPerson.id,
    summary: '跨月带入且本刻完成的根意图',
    domain: 'strategic',
    goal: { kind: 'at-cell', cellId: carriedPerson.position.cellId },
    nextAction: { kind: 'move', toCellId: carriedPerson.position.cellId, toZ: carriedPerson.position.z },
    status: 'active',
    createdAtMonth: 1,
    lastProgressAtMonth: 1,
    progress: 0.5,
    plannedDurationMonths: 3,
    lifecycle: { version: 'intent-lifecycle-v1', completion: 'on-achievement', reviewAtMonth: 3 },
    sourceDecisionEventId: 'prior-month-decision',
    sourceFactIds: [],
    actionEventIds: [],
    replanCount: 0,
  };
  carriedState.intents.push(carriedIntent);
  carriedPerson.activeIntentId = carriedIntent.id;
  let carriedPlannerCalls = 0;
  const carriedExecution = makeExecution(
    makePrepared(carriedState, 4),
    new Map(),
    { decide() { carriedPlannerCalls += 1; return { kind: 'idle', reason: '完整复核后维持原安排' }; } },
  );
  executePlanningTick(carriedExecution);
  assert.equal(carriedIntent.status, 'completed', '跨月根意图应在真实执行路径中完成');
  assert.equal(carriedExecution.ordinaryReplanPermits.has(carriedPerson.id), true, 'full-review idle 后根意图同 tick 终结也必须产生 permit');
  executePlanningTick(carriedExecution);
  executePlanningTick(carriedExecution);
  assert.equal(carriedPlannerCalls, 2, '真实整月控制流只允许首次普通复核和终态后的额外复核');
  assert.equal(carriedExecution.ordinaryDeliberationCounts.get(carriedPerson.id), 2, '真实整月控制流中 idle 同样消耗普通额度');

  const edgeFlowState = createInitialState(26_082_607, {
    endpoint: { kind: 'months', value: 12 },
    chaosIntensity: 0,
  });
  const edgeFlowPerson = edgeFlowState.people[0];
  edgeFlowPerson.body.health = 100;
  edgeFlowPerson.body.hydration = 100;
  edgeFlowPerson.body.nutrition = 100;
  edgeFlowPerson.conditions = [];
  const edgeFlowContext = makeContext(edgeFlowState, edgeFlowPerson, achievementOption);
  let edgeFlowPlannerCalls = 0;
  const edgeFlowExecution = makeExecution(
    makePrepared(edgeFlowState, 1, [edgeFlowContext]),
    new Map([[edgeFlowPerson.id, {
      decision: {
        kind: 'revise',
        mode: 'interrupt',
        interruptionKind: 'required-response',
        optionId: 'missing-edge-option',
        reason: '只验证 edge 通道不占普通额度',
      },
      usedModel: false,
    }]]),
    { decide() { edgeFlowPlannerCalls += 1; return { kind: 'idle', reason: '第一次普通复核' }; } },
  );
  assert.equal(edgeFlowExecution.ordinaryDeliberationCounts.has(edgeFlowPerson.id), false, '月初 edge 决策不能写入普通额度');
  executePlanningTick(edgeFlowExecution);
  executePlanningTick(edgeFlowExecution);
  assert.equal(edgeFlowPlannerCalls, 1, 'edge-only 月初决策后仍必须进入第一次普通复核');
  assert.equal(edgeFlowExecution.ordinaryDeliberationCounts.get(edgeFlowPerson.id), 1, 'edge-only 流程的普通复核应独立计数');

  const returnState = createInitialState(26_082_608, {
    endpoint: { kind: 'months', value: 12 },
    chaosIntensity: 0,
  });
  const returnPerson = returnState.people[0];
  returnPerson.body.health = 100;
  returnPerson.body.hydration = 100;
  returnPerson.body.nutrition = 100;
  returnPerson.conditions = [];
  const parentIntent = {
    ...carriedIntent,
    id: 'suspended-parent-intent',
    ownerId: returnPerson.id,
    status: 'suspended',
    lifecycle: { version: 'intent-lifecycle-v1', completion: 'on-achievement', reviewAtMonth: 12 },
    goal: { kind: 'body-at-least', field: 'health', value: 100 },
    suspendedByIntentId: 'terminal-child-intent',
  };
  const childIntent = {
    ...carriedIntent,
    id: 'terminal-child-intent',
    ownerId: returnPerson.id,
    status: 'active',
    lifecycle: undefined,
    goal: { kind: 'at-cell', cellId: returnPerson.position.cellId },
    returnToIntentId: parentIntent.id,
    interruptionKind: 'required-response',
  };
  returnState.intents.push(parentIntent, childIntent);
  returnPerson.activeIntentId = childIntent.id;
  const returnExecution = makeExecution(
    makePrepared(returnState, 1),
    new Map(),
    { decide() { throw new Error('child 结束恢复 parent 时不应触发普通重规划'); } },
  );
  executePlanningTick(returnExecution);
  assert.equal(returnPerson.activeIntentId, parentIntent.id, 'child 终结后必须恢复 exact parent');
  assert.equal(parentIntent.status, 'active', '恢复中的 parent 仍是同一条 active intent');
  assert.equal(returnExecution.ordinaryReplanPermits.has(returnPerson.id), false, 'child 终结但 parent 恢复时不得产生根终态 permit');

  console.log('decision execution tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
