import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-hibernation-recovery-test-'));
const bundlePath = path.join(temporaryDirectory, 'simulation.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/simulation.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  const { buildDecisionContexts, createInitialState, stepSimulation } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  let state = createInitialState(342, { endpoint: { kind: 'months', value: 3 }, chaosIntensity: 0 });
  state.clock.elapsedMonths = 1;
  state.civilization.externalClimate = { epoch: 'stable', kind: 'temperate', severity: 0 };
  const [helper, sleeper] = state.people;
  assert.ok(helper && sleeper, 'fixture requires an awake helper and a sleeper');
  sleeper.position = { ...helper.position, lastPath: [helper.position.cellId], tickPath: [helper.position.cellId] };
  sleeper.conditions.push({
    id: 'test-same-era-hibernation',
    kind: 'dehydrated-hibernation',
    stage: 1,
    sinceMonth: 1,
    sourceEventIds: ['test-same-era-dehydrate'],
  });

  const metabolicState = structuredClone(state);
  const metabolicSleeper = metabolicState.people.find((person) => person.id === sleeper.id);
  const bodyBeforeHibernationMonth = structuredClone(metabolicSleeper.body);
  const afterHibernationMonth = stepSimulation(metabolicState, {
    decide() { return { kind: 'idle', reason: '只观察休眠身体结算' }; },
  });
  const bodyAfterHibernationMonth = afterHibernationMonth.people.find((person) => person.id === sleeper.id).body;
  assert.ok(bodyAfterHibernationMonth.health < bodyBeforeHibernationMonth.health, '脱水休眠每月仍应损耗健康');
  assert.ok(bodyAfterHibernationMonth.hydration < bodyBeforeHibernationMonth.hydration, '脱水休眠每月仍应消耗水分');
  assert.ok(bodyAfterHibernationMonth.nutrition < bodyBeforeHibernationMonth.nutrition, '脱水休眠每月仍应消耗营养');

  const contextWithoutWater = buildDecisionContexts(state).find((context) => context.person.id === helper.id);
  assert.equal(
    contextWithoutWater?.options.some((option) => option.id.startsWith(`rehydrate:${sleeper.id}:`)),
    false,
    '附近没有真实可饮用物质时，不得只因环境稳定而生成重新水化行动',
  );

  const waterCell = helper.position.cellId % state.world.grid.width < state.world.grid.width - 1
    ? helper.position.cellId + 1
    : helper.position.cellId - 1;
  let waterZ = state.world.grid.levels - 1;
  while (waterZ > 0 && state.world.grid.voxels[waterZ * state.world.grid.width * state.world.grid.depth + waterCell] === 0) waterZ -= 1;
  state.world.grid.voxels[waterZ * state.world.grid.width * state.world.grid.depth + waterCell] = 7;

  const pendingPredictionState = structuredClone(state);
  const pendingHelper = pendingPredictionState.people.find((person) => person.id === helper.id);
  const pendingSleeper = pendingPredictionState.people.find((person) => person.id === sleeper.id);
  pendingSleeper.conditions = [{
    id: 'test-prediction-hibernation',
    kind: 'dehydrated-hibernation',
    stage: 1,
    sinceMonth: 1,
    sourceEventIds: ['test-prediction-dehydrate'],
    triggerPredictionId: 'test-near-chaos-prediction',
  }];
  pendingPredictionState.eraPredictions = [{
    id: 'test-near-chaos-prediction',
    predictorId: pendingSleeper.id,
    audienceIds: [pendingHelper.id],
    madeAtMonth: 1,
    targetEpoch: 'chaotic',
    predictedStartMonth: 3,
    toleranceMonths: 3,
    expiresAtMonth: 6,
    status: 'pending',
    sourceEventIds: ['test-prediction-fact'],
  }];
  const helperRelationToPredictor = pendingHelper.relations.find((relation) => relation.personId === pendingSleeper.id);
  helperRelationToPredictor.trust = 22;
  const trustedContext = buildDecisionContexts(pendingPredictionState).find((context) => context.person.id === pendingHelper.id);
  assert.equal(
    trustedContext?.options.some((option) => option.id.startsWith(`rehydrate:${pendingSleeper.id}:`)),
    false,
    '认可同一项待验证预言的帮助者不得提前打断休眠',
  );

  helperRelationToPredictor.trust = 0;
  const disputedContext = buildDecisionContexts(pendingPredictionState).find((context) => context.person.id === pendingHelper.id);
  assert.ok(
    disputedContext?.options.some((option) => option.id.startsWith(`rehydrate:${pendingSleeper.id}:`)),
    '不认可预言的帮助者可以作出一次有争议的提前唤醒，并承担后续关系结果',
  );
  const sleeperRelationToHelper = pendingSleeper.relations.find((relation) => relation.personId === pendingHelper.id);
  sleeperRelationToHelper.trust = 20;
  sleeperRelationToHelper.bond = 10;
  const disputedWakeState = stepSimulation(pendingPredictionState, {
    decide(context) {
      if (context.person.id === pendingHelper.id) {
        const option = context.options.find((candidate) => candidate.id.startsWith(`rehydrate:${pendingSleeper.id}:`));
        if (option) return { kind: 'start', optionId: option.id, reason: '不认可预言，提前唤醒' };
      }
      return { kind: 'idle', reason: '只观察有争议的唤醒' };
    },
  });
  const disputedWake = disputedWakeState.world.past.find((event) => event.kind === 'action'
    && event.who === pendingHelper.id
    && event.action.kind === 'act'
    && event.action.operation === 'rehydrate'
    && event.diff.rehydrationBasis === 'disputed-pending-prediction');
  assert.ok(disputedWake, '有争议的提前唤醒必须留下绑定预言的行动事实');
  assert.equal(
    disputedWakeState.people.find((person) => person.id === pendingSleeper.id)
      .relations.find((relation) => relation.personId === pendingHelper.id).sourceEventIds.includes(disputedWake.id),
    false,
    '预言仍待验证时，争议唤醒事实不得用事后全知提前进入关系证据',
  );

  const repeatBlockedState = structuredClone(disputedWakeState);
  const repeatSleeper = repeatBlockedState.people.find((person) => person.id === pendingSleeper.id);
  repeatSleeper.conditions = [{
    id: 'test-repeated-prediction-hibernation',
    kind: 'dehydrated-hibernation',
    stage: 1,
    sinceMonth: repeatBlockedState.clock.elapsedMonths,
    sourceEventIds: ['test-repeat-dehydrate'],
    triggerPredictionId: 'test-near-chaos-prediction',
    wakeDisputeEventIds: [disputedWake.id],
  }];
  const repeatContext = buildDecisionContexts(repeatBlockedState).find((context) => context.person.id === pendingHelper.id);
  assert.equal(
    repeatContext?.options.some((option) => option.id.startsWith(`rehydrate:${pendingSleeper.id}:`)),
    false,
    '同一预言上的有争议唤醒已经发生后，没有新证据不得再次尝试',
  );

  const correctPredictionState = structuredClone(disputedWakeState);
  delete correctPredictionState.civilization.externalClimate;
  correctPredictionState.civilization.era.endsAtMonth = correctPredictionState.clock.elapsedMonths;
  const beforeCorrectOutcomeTrust = correctPredictionState.people.find((person) => person.id === pendingSleeper.id)
    .relations.find((relation) => relation.personId === pendingHelper.id).trust;
  const afterCorrectPrediction = stepSimulation(correctPredictionState, {
    decide() { return { kind: 'idle', reason: '等待预言结算' }; },
  });
  const afterCorrectOutcomeTrust = afterCorrectPrediction.people.find((person) => person.id === pendingSleeper.id)
    .relations.find((relation) => relation.personId === pendingHelper.id).trust;
  assert.ok(afterCorrectOutcomeTrust < beforeCorrectOutcomeTrust, '乱纪元随后到来时，休眠者应降低对错误唤醒者的信任');

  const incorrectPredictionState = structuredClone(disputedWakeState);
  const incorrectPrediction = incorrectPredictionState.eraPredictions.find((prediction) => prediction.id === 'test-near-chaos-prediction');
  incorrectPrediction.predictedStartMonth = incorrectPredictionState.clock.elapsedMonths;
  incorrectPrediction.toleranceMonths = 0;
  incorrectPrediction.expiresAtMonth = incorrectPredictionState.clock.elapsedMonths;
  const beforeIncorrectOutcomeTrust = incorrectPredictionState.people.find((person) => person.id === pendingSleeper.id)
    .relations.find((relation) => relation.personId === pendingHelper.id).trust;
  const afterIncorrectPrediction = stepSimulation(incorrectPredictionState, {
    decide() { return { kind: 'idle', reason: '等待预言过期' }; },
  });
  const afterIncorrectOutcomeTrust = afterIncorrectPrediction.people.find((person) => person.id === pendingSleeper.id)
    .relations.find((relation) => relation.personId === pendingHelper.id).trust;
  assert.ok(afterIncorrectOutcomeTrust > beforeIncorrectOutcomeTrust, '预言平稳过期时，休眠者应提高对正确唤醒者的信任');

  const helperContext = buildDecisionContexts(state).find((context) => context.person.id === helper.id);
  const recoveryOption = helperContext?.options.find((option) => option.id.startsWith(`rehydrate:${sleeper.id}:`));
  assert.ok(recoveryOption, '同一恒纪元内只要同地且附近有真实可饮用物质，就应生成重新水化行动');
  const chaoticState = structuredClone(state);
  chaoticState.civilization.epoch = 'chaotic';
  const chaoticContext = buildDecisionContexts(chaoticState).find((context) => context.person.id === helper.id);
  assert.equal(
    chaoticContext?.options.some((option) => option.id.startsWith(`rehydrate:${sleeper.id}:`)),
    false,
    '乱纪元仍在持续时，不应仅因附近有水就主动唤醒休眠者',
  );

  state = stepSimulation(state, {
    decide(context) {
      if (context.person.id === helper.id) {
        const option = context.options.find((candidate) => candidate.id.startsWith(`rehydrate:${sleeper.id}:`));
        if (option) return { kind: 'start', optionId: option.id, reason: '用身边真实水源唤醒同地休眠者' };
      }
      return { kind: 'idle', reason: '不干扰重新水化回归测试' };
    },
  });

  const recovery = state.world.past.find((event) => event.kind === 'action'
    && event.who === helper.id
    && event.action.kind === 'act'
    && event.action.operation === 'rehydrate'
    && event.diff.rehydratedPersonId === sleeper.id);
  assert.ok(recovery, '清醒者应在没有跨纪元的情况下执行真实 rehydrate 行动');
  assert.equal(state.civilization.era.sequence, 0, '测试期间不得通过纪元切换绕过恢复资格');
  assert.equal(state.people.find((person) => person.id === sleeper.id)?.conditions.some((condition) => condition.kind === 'dehydrated-hibernation'), false, '真实重新水化行动应移除休眠状态');
  assert.ok(
    state.people.find((person) => person.id === sleeper.id)
      .relations.find((relation) => relation.personId === helper.id).sourceEventIds.includes(recovery.id),
    '没有有效预言阻止时，帮助结束休眠应形成双方关系证据',
  );

  const partialHibernationState = createInitialState(343, { endpoint: { kind: 'months', value: 3 }, chaosIntensity: 0 });
  partialHibernationState.civilization.externalClimate = { epoch: 'chaotic', kind: 'heat', severity: 5 };
  partialHibernationState.people.slice(0, -1).forEach((person) => person.conditions.push({
    id: `test-partial-hibernation-${person.id}`,
    kind: 'dehydrated-hibernation',
    stage: 1,
    sinceMonth: 0,
    sourceEventIds: ['test-partial-hibernation'],
  }));
  const afterPartialHibernation = stepSimulation(partialHibernationState, {
    decide() { return { kind: 'idle', reason: '验证仍有清醒者时文明继续' }; },
  });
  assert.equal(afterPartialHibernation.civilization.status, 'running', '仍有清醒者时不得结束文明');
  assert.ok(afterPartialHibernation.people.some((person) => person.conditions.some((condition) => condition.kind === 'dehydrated-hibernation'))
    && afterPartialHibernation.people.some((person) => !person.conditions.some((condition) => condition.kind === 'dehydrated-hibernation')),
  '部分休眠夹具在结算后必须仍同时包含休眠者和清醒者');

  const fullHibernationState = createInitialState(344, { endpoint: { kind: 'months', value: 6 }, chaosIntensity: 0 });
  fullHibernationState.civilization.era = {
    sequence: 1, kind: 'chaotic', sinceMonth: 0, endsAtMonth: 1, dominantClimate: 'heat',
  };
  fullHibernationState.civilization.epoch = 'chaotic';
  fullHibernationState.civilization.climate = { kind: 'heat', severity: 5, sinceMonth: 0 };
  delete fullHibernationState.civilization.externalClimate;
  fullHibernationState.people.forEach((person) => person.conditions.push({
    id: `test-full-hibernation-${person.id}`,
    kind: 'dehydrated-hibernation',
    stage: 1,
    sinceMonth: 0,
    sourceEventIds: ['test-full-hibernation'],
  }));
  const fullHibernationBodies = fullHibernationState.people.map((person) => structuredClone(person.body));
  const afterFullHibernation = stepSimulation(fullHibernationState, {
    decide() { return { kind: 'idle', reason: '验证全员休眠时继续推进乱纪元' }; },
  });
  assert.equal(afterFullHibernation.civilization.status, 'running', '全员脱水休眠应保持为可继续演化的休眠态');
  assert.equal(afterFullHibernation.clock.elapsedMonths, 1, '全员休眠时月份仍须推进');
  assert.ok(afterFullHibernation.people.every((person, index) => person.body.health < fullHibernationBodies[index].health
    && person.conditions.some((condition) => condition.kind === 'dehydrated-hibernation')),
  '全员休眠期间仍须结算真实低代谢身体损耗');

  let afterStableRecovery = stepSimulation(afterFullHibernation, {
    decide() { return { kind: 'idle', reason: '等待新恒纪元提供苏醒条件' }; },
  });
  if (afterStableRecovery.people.some((person) => person.conditions.some((condition) => condition.kind === 'dehydrated-hibernation'))) {
    afterStableRecovery = stepSimulation(afterStableRecovery, {
      decide() { return { kind: 'idle', reason: '等待恒纪元环境恢复可利用水分' }; },
    });
  }
  assert.equal(afterStableRecovery.civilization.status, 'running', '跨纪元苏醒后文明应继续运行');
  assert.ok(afterStableRecovery.people.every((person) => !person.conditions.some((condition) => condition.kind === 'dehydrated-hibernation')),
    '新恒纪元应通过既有身体规则使全体休眠者恢复水分苏醒');
  assert.ok(afterStableRecovery.world.past.some((event) => event.kind === 'environment'
    && event.diff.condition === 'dehydrated-hibernation'
    && event.diff.exited === true),
  '跨纪元苏醒必须留下环境恢复事实');

  const doomedHibernationState = structuredClone(fullHibernationState);
  doomedHibernationState.civilization.status = 'running';
  delete doomedHibernationState.civilization.outcome;
  doomedHibernationState.people.forEach((person) => { person.body.health = 0; });
  const afterDormantDeaths = stepSimulation(doomedHibernationState, {
    decide() { return { kind: 'idle', reason: '验证休眠不阻止真实死亡终局' }; },
  });
  assert.equal(afterDormantDeaths.civilization.status, 'ended', '全体休眠者身体耗尽时仍应结束文明');
  assert.equal(afterDormantDeaths.civilization.outcome?.kind, 'destroyed');

  const boundaryHibernationState = structuredClone(fullHibernationState);
  boundaryHibernationState.civilization.conditions.endpoint = { kind: 'months', value: 1 };
  const afterDormantBoundary = stepSimulation(boundaryHibernationState, {
    decide() { return { kind: 'idle', reason: '验证休眠不绕过实验边界' }; },
  });
  assert.equal(afterDormantBoundary.civilization.status, 'ended', '全员休眠仍须遵守月份边界');
  assert.equal(afterDormantBoundary.civilization.outcome?.kind, 'boundary');

  console.log('hibernation recovery regression passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
