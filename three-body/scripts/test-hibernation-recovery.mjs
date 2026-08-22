import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-hibernation-recovery-test-'));
const bundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const executorBundlePath = path.join(temporaryDirectory, 'action-executor.mjs');
const plannerBundlePath = path.join(temporaryDirectory, 'rule-planner.mjs');
const monthlyProcessesBundlePath = path.join(temporaryDirectory, 'monthly-processes.mjs');
const waterAccessBundlePath = path.join(temporaryDirectory, 'water-access.mjs');
const adapterBundlePath = path.join(temporaryDirectory, 'adapter.mjs');
const agreementBundlePath = path.join(temporaryDirectory, 'agreement.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/simulation.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/domain/action-executor.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${executorBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/application/rule-planner.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${plannerBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/domain/monthly-processes.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${monthlyProcessesBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/domain/water-access.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${waterAccessBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/adapter.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${adapterBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/domain/agreement.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${agreementBundlePath}`,
  ], { stdio: 'pipe' });
  const {
    buildDecisionContexts,
    createInitialState,
    Material,
    stepSimulation,
    stepSimulationAsync,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const { executePrimitiveAction } = await import(`${pathToFileURL(executorBundlePath).href}?test=${Date.now()}`);
  const { RulePlanner } = await import(`${pathToFileURL(plannerBundlePath).href}?test=${Date.now()}`);
  const { advanceBodies, synchronizeHibernationIntentSuspensions } = await import(`${pathToFileURL(monthlyProcessesBundlePath).href}?test=${Date.now()}`);
  const { findReachableWater } = await import(`${pathToFileURL(waterAccessBundlePath).href}?test=${Date.now()}`);
  const { toSocietyState } = await import(`${pathToFileURL(adapterBundlePath).href}?test=${Date.now()}`);
  const {
    advanceAgreementLifecycle,
    agreementResponseDeadline,
    synchronizeAgreementResponseDeadlineSuspensions,
  } = await import(`${pathToFileURL(agreementBundlePath).href}?test=${Date.now()}`);

  function pushExposureFact(state, person, eventId, kind = 'heat', stage = 3, atMonth = state.clock.elapsedMonths) {
    state.world.past.push({
      id: eventId,
      kind: 'environment',
      atMonth,
      orderInMonth: state.world.past.length,
      cellId: person.position.cellId,
      change: 'condition',
      who: person.id,
      result: `${person.name}\u7684${kind === 'heat' ? '\u708e\u70ed' : '\u5bd2\u51b7'}\u66b4\u9732\u52a0\u91cd`,
      diff: { condition: kind, stage },
    });
  }

  function installThreeSidedShelter(state, person) {
    const { width, depth, levels, voxels } = state.world.grid;
    const center = person.position.cellId;
    const x = center % width;
    const y = Math.floor(center / width);
    assert.ok(x > 0 && x < width - 1 && y > 0 && y < depth - 1, '\u4f11\u7720\u5939\u5177\u4eba\u7269\u5fc5\u987b\u4f4d\u4e8e\u975e\u8fb9\u754c\u683c');
    const setVoxel = (cellId, z, materialId) => {
      assert.ok(z >= 0 && z < levels);
      voxels[z * width * depth + cellId] = materialId;
    };
    setVoxel(center, person.position.z + 2, Material.Stone);
    for (const wallCell of [center - 1, center + 1, center - width]) {
      setVoxel(wallCell, person.position.z, Material.Stone);
    }
  }

  const observedEntryBoundaryState = createInitialState(20260815, { endpoint: { kind: 'months', value: 96 }, chaosIntensity: 0 });
  observedEntryBoundaryState.clock.elapsedMonths = 69;
  observedEntryBoundaryState.civilization.epoch = 'chaotic';
  observedEntryBoundaryState.civilization.climate = { kind: 'heat', severity: 8, sinceMonth: 69 };
  observedEntryBoundaryState.civilization.externalClimate = { epoch: 'chaotic', kind: 'heat', severity: 8 };
  observedEntryBoundaryState.people = [observedEntryBoundaryState.people[0]];
  const observedBoundaryPerson = observedEntryBoundaryState.people[0];
  observedBoundaryPerson.conditions = [{
    id: 'test-observed-entry-boundary-heat', kind: 'heat', stage: 3, sinceMonth: 69,
    sourceEventIds: ['test-observed-entry-boundary-exposure'],
  }];
  pushExposureFact(observedEntryBoundaryState, observedBoundaryPerson, 'test-observed-entry-boundary-exposure', 'heat', 3, 69);
  observedBoundaryPerson.body = { health: 57.8, hydration: 62.28, nutrition: 37.99 };
  const observedBoundaryAction = {
    kind: 'act', operation: 'dehydrate', targets: [{ kind: 'person', personId: observedBoundaryPerson.id }],
    hibernationEvidenceEventIds: ['test-observed-entry-boundary-exposure'],
  };
  const rejectedBelowObservedBoundary = executePrimitiveAction(
    observedEntryBoundaryState, observedBoundaryPerson, observedBoundaryAction, 70, 0,
    { cause: 'survival-reflex', actionTick: 1 },
  );
  assert.equal(rejectedBelowObservedBoundary.status, 'blocked', '已发生乱纪元仍不得让 37.99 储备的人进入脱水休眠');
  assert.equal(observedBoundaryPerson.conditions.some((condition) => condition.kind === 'dehydrated-hibernation'), false);
  observedBoundaryPerson.position.cellId += 1;
  observedBoundaryPerson.body.nutrition = 38;
  assert.ok(buildDecisionContexts(observedEntryBoundaryState, 70)[0].options.some((option) => (
    option.nextAction.kind === 'act'
      && option.nextAction.operation === 'dehydrate'
      && option.nextAction.hibernationPredictionId === undefined
  )), '本人仍有当前严重暴露 condition 时，移动后不得因来源事实留在旧格而丢失 observed dehydrate');
  const acceptedAtObservedBoundary = executePrimitiveAction(
    observedEntryBoundaryState, observedBoundaryPerson, observedBoundaryAction, 70, 1,
    { cause: 'survival-reflex', actionTick: 2 },
  );
  assert.equal(acceptedAtObservedBoundary.status, 'completed', '已发生乱纪元的执行器合法边界必须精确包含 38');
  assert.equal(observedBoundaryPerson.conditions.filter((condition) => condition.kind === 'dehydrated-hibernation').length, 1);
  const repeatedObservedEntry = executePrimitiveAction(
    observedEntryBoundaryState, observedBoundaryPerson, observedBoundaryAction, 70, 2,
    { cause: 'survival-reflex', actionTick: 3 },
  );
  assert.equal(repeatedObservedEntry.status, 'completed');
  assert.equal(observedBoundaryPerson.conditions.filter((condition) => condition.kind === 'dehydrated-hibernation').length, 1,
    '重复 dehydrate 只能继续同一个 episode，不能创建第二条 condition');

  const unbackedObservedState = createInitialState(20260816, { endpoint: { kind: 'months', value: 96 }, chaosIntensity: 0 });
  unbackedObservedState.clock.elapsedMonths = 69;
  unbackedObservedState.civilization.epoch = 'chaotic';
  unbackedObservedState.civilization.climate = { kind: 'heat', severity: 8, sinceMonth: 69 };
  unbackedObservedState.civilization.externalClimate = { epoch: 'chaotic', kind: 'heat', severity: 8 };
  const [unbackedPerson, caregiverBypassChild] = unbackedObservedState.people;
  unbackedObservedState.people = [unbackedPerson, caregiverBypassChild];
  unbackedPerson.body = { health: 90, hydration: 90, nutrition: 90 };
  unbackedPerson.conditions = [{
    id: 'test-unbacked-observed-heat', kind: 'heat', stage: 3, sinceMonth: 69,
    sourceEventIds: ['test-missing-observed-exposure'],
  }];
  assert.equal(buildDecisionContexts(unbackedObservedState, 70).find((context) => context.person.id === unbackedPerson.id)
    .options.some((option) => option.nextAction.kind === 'act' && option.nextAction.operation === 'dehydrate'), false,
  '全局强乱纪元与无来源 condition 不能编译 observed dehydrate');
  const rejectedUnbackedObservedEntry = executePrimitiveAction(unbackedObservedState, unbackedPerson, {
    kind: 'act', operation: 'dehydrate', targets: [{ kind: 'person', personId: unbackedPerson.id }],
    hibernationEvidenceEventIds: ['test-missing-observed-exposure'],
  }, 70, 0, { cause: 'intent', actionTick: 1 });
  assert.equal(rejectedUnbackedObservedEntry.status, 'blocked',
    'executor 必须拒绝无法解析为本人严重暴露事实的 observed dehydrate');

  caregiverBypassChild.position = {
    ...unbackedPerson.position,
    lastPath: [unbackedPerson.position.cellId],
    tickPath: [unbackedPerson.position.cellId],
  };
  caregiverBypassChild.geneticParents = [unbackedPerson.id];
  caregiverBypassChild.bornAtMonth = 69 - 6 * 12;
  caregiverBypassChild.body = { health: 90, hydration: 90, nutrition: 90 };
  caregiverBypassChild.conditions = [];
  const rejectedCaregiverBypass = executePrimitiveAction(unbackedObservedState, unbackedPerson, {
    kind: 'act', operation: 'dehydrate', targets: [{ kind: 'person', personId: caregiverBypassChild.id }],
  }, 70, 1, { cause: 'survival-reflex', actionTick: 2 });
  assert.equal(rejectedCaregiverBypass.status, 'blocked',
    '照护者不能只凭全局气候让没有本人严重暴露事实的 dependent 进入休眠');

  const stableObservedState = createInitialState(20260818, { endpoint: { kind: 'months', value: 96 }, chaosIntensity: 0 });
  stableObservedState.clock.elapsedMonths = 69;
  stableObservedState.people = [stableObservedState.people[0]];
  const stableObservedPerson = stableObservedState.people[0];
  stableObservedPerson.body = { health: 90, hydration: 90, nutrition: 90 };
  stableObservedPerson.conditions = [{
    id: 'test-stable-observed-heat', kind: 'heat', stage: 3, sinceMonth: 69,
    sourceEventIds: ['test-stable-observed-exposure'],
  }];
  pushExposureFact(stableObservedState, stableObservedPerson, 'test-stable-observed-exposure', 'heat', 3, 69);
  const rejectedStableObservedEntry = executePrimitiveAction(stableObservedState, stableObservedPerson, {
    kind: 'act', operation: 'dehydrate', targets: [{ kind: 'person', personId: stableObservedPerson.id }],
    hibernationEvidenceEventIds: ['test-stable-observed-exposure'],
  }, 70, 0, { cause: 'intent', actionTick: 1 });
  assert.equal(rejectedStableObservedEntry.status, 'blocked',
    '没有有效 prediction 时，即使保留旧暴露事实也不得在稳定纪元重新进入休眠');

  const predictiveEntryState = createInitialState(20260817, { endpoint: { kind: 'months', value: 96 }, chaosIntensity: 0 });
  predictiveEntryState.clock.elapsedMonths = 69;
  predictiveEntryState.civilization.epoch = 'stable';
  predictiveEntryState.civilization.climate = { kind: 'temperate', severity: 0, sinceMonth: 69 };
  predictiveEntryState.civilization.externalClimate = { epoch: 'stable', kind: 'temperate', severity: 0 };
  predictiveEntryState.people = [predictiveEntryState.people[0]];
  const predictivePerson = predictiveEntryState.people[0];
  predictivePerson.conditions = [];
  predictivePerson.body = { health: 57.8, hydration: 62.28, nutrition: 44.99 };
  predictiveEntryState.eraPredictions = [{
    id: 'test-stable-entry-prediction', predictorId: predictivePerson.id, audienceIds: [], madeAtMonth: 69,
    targetEpoch: 'chaotic', predictedStartMonth: 72, toleranceMonths: 3, expiresAtMonth: 75,
    status: 'pending', sourceEventIds: ['test-stable-entry-prediction-fact'],
  }];
  assert.equal(buildDecisionContexts(predictiveEntryState, 70)[0].options.some((option) => option.nextAction.kind === 'act'
    && option.nextAction.operation === 'dehydrate'), false,
  '稳定纪元中的预测性提前休眠在 45 以下不得编译为候选');
  const rejectedPredictiveEntry = executePrimitiveAction(predictiveEntryState, predictivePerson, {
    kind: 'act', operation: 'dehydrate', targets: [{ kind: 'person', personId: predictivePerson.id }],
    hibernationPredictionId: 'test-stable-entry-prediction',
  }, 70, 0, { cause: 'intent', actionTick: 1 });
  assert.equal(rejectedPredictiveEntry.status, 'blocked', '执行器也必须拒绝 45 以下的预测性提前休眠');
  predictivePerson.body.nutrition = 45;
  assert.ok(buildDecisionContexts(predictiveEntryState, 70)[0].options.some((option) => option.nextAction.kind === 'act'
    && option.nextAction.operation === 'dehydrate'
    && option.nextAction.hibernationPredictionId === 'test-stable-entry-prediction'),
  '稳定纪元的预测性休眠达到 45 后应重新成为合法候选');

  const phaseTransitionState = createInitialState(341, { endpoint: { kind: 'months', value: 8 }, chaosIntensity: 0 });
  phaseTransitionState.people = [phaseTransitionState.people[0]];
  const phaseSleeper = phaseTransitionState.people[0];
  phaseTransitionState.clock.elapsedMonths = 2;
  phaseTransitionState.civilization.era = {
    sequence: 2, kind: 'stable', sinceMonth: 2, endsAtMonth: 8, dominantClimate: 'temperate',
  };
  phaseTransitionState.civilization.epoch = 'stable';
  phaseTransitionState.civilization.externalClimate = { epoch: 'stable', kind: 'temperate', severity: 0 };
  phaseTransitionState.world.drops = [];
  phaseSleeper.inventory = [];
  phaseSleeper.body = { health: 50, hydration: 40, nutrition: 42 };
  phaseSleeper.conditions = [{
    id: 'test-two-phase-hibernation',
    kind: 'dehydrated-hibernation',
    stage: 2,
    sinceMonth: 0,
    sourceEventIds: ['test-original-dehydrate'],
  }];
  for (let index = 0; index < phaseTransitionState.world.grid.voxels.length; index += 1) {
    const material = phaseTransitionState.world.grid.voxels[index];
    if (material === 7 || material === 10 || material === 12 || material === 18) {
      phaseTransitionState.world.grid.voxels[index] = material === 7 || material === 18 ? 1 : 8;
    }
  }
  const beforeSourceFreeRecovery = structuredClone(phaseSleeper.body);
  const afterSourceFreeRecovery = stepSimulation(phaseTransitionState, {
    decide() { return { kind: 'idle', reason: '恒纪元没有真实水和食物，只观察恢复阶段' }; },
  });
  const sourceFreeSleeper = afterSourceFreeRecovery.people[0];
  const sourceFreeEpisode = sourceFreeSleeper.conditions.find((condition) => condition.kind === 'dehydrated-hibernation');
  assert.equal(sourceFreeEpisode?.hibernationPhase, 'recovering', '新恒纪元只能把旧 episode 转入 recovering，不能直接删除');
  assert.equal(toSocietyState(afterSourceFreeRecovery).agents.find((agent) => agent.id === phaseSleeper.id)?.state,
    'active', 'recovering 人物已能执行受限恢复行动，3D 投影不应继续显示休眠姿态');
  assert.ok(sourceFreeSleeper.body.hydration <= beforeSourceFreeRecovery.hydration,
    '没有 ingest 或 rehydrate 行动时不得凭空增加 hydration');
  assert.equal(afterSourceFreeRecovery.world.past.some((event) => event.kind === 'environment'
    && event.diff.condition === 'dehydrated-hibernation'
    && event.diff.exited === true), false, '没有真实恢复来源时不得退出 episode');

  const hydrationBeforeSecondSourceFreeMonth = sourceFreeSleeper.body.hydration;
  const afterSecondSourceFreeMonth = stepSimulation(afterSourceFreeRecovery, {
    decide() { return { kind: 'idle', reason: '恒纪元第二月仍没有真实恢复来源' }; },
  });
  const secondSourceFreeSleeper = afterSecondSourceFreeMonth.people[0];
  assert.equal(secondSourceFreeSleeper.conditions.find((condition) => condition.kind === 'dehydrated-hibernation')?.hibernationPhase,
    'recovering', '恒纪元第二月没有真实来源时仍不得退出 recovering');
  assert.ok(secondSourceFreeSleeper.body.hydration <= hydrationBeforeSecondSourceFreeMonth,
    '恒纪元第二月没有 ingest / rehydrate 时也不得自动补水');

  const repeatChaosState = structuredClone(afterSecondSourceFreeMonth);
  repeatChaosState.civilization.externalClimate = { epoch: 'chaotic', kind: 'heat', severity: 8 };
  const episodeBeforeRepeatChaos = repeatChaosState.people[0].conditions.find((condition) => condition.kind === 'dehydrated-hibernation');
  const bodyBeforeRepeatChaos = structuredClone(repeatChaosState.people[0].body);
  const originalEpisodeSources = [...episodeBeforeRepeatChaos.sourceEventIds];
  const afterRepeatChaos = stepSimulation(repeatChaosState, {
    decide() { return { kind: 'idle', reason: '恢复未完成时新乱纪元再次到来' }; },
  });
  const repeatedSleeper = afterRepeatChaos.people[0];
  const continuedEpisode = repeatedSleeper.conditions.find((condition) => condition.kind === 'dehydrated-hibernation');
  assert.equal(continuedEpisode?.id, episodeBeforeRepeatChaos.id, '新乱纪元必须继续同一个 episode，不能新建第二条 condition');
  assert.equal(continuedEpisode?.sinceMonth, episodeBeforeRepeatChaos.sinceMonth, '继续休眠不得重置 sinceMonth');
  assert.ok(continuedEpisode.stage >= episodeBeforeRepeatChaos.stage, '继续休眠不得重置既有 stage');
  assert.ok(originalEpisodeSources.every((sourceId) => continuedEpisode.sourceEventIds.includes(sourceId)), '继续休眠必须保留原始 episode 来源');
  assert.equal(continuedEpisode?.hibernationPhase, 'dormant', 'recovering 遭遇新乱纪元应回到 dormant');
  assert.equal(toSocietyState(afterRepeatChaos).agents.find((agent) => agent.id === repeatedSleeper.id)?.state,
    'hibernating', '只有 dormant episode 应投影为休眠姿态');
  assert.ok(repeatedSleeper.body.hydration < bodyBeforeRepeatChaos.hydration
    && bodyBeforeRepeatChaos.hydration - repeatedSleeper.body.hydration < 1,
  '继续 episode 只承担本月低代谢消耗，不得再次扣除 8 hydration 入眠成本');
  assert.ok(repeatedSleeper.body.health < bodyBeforeRepeatChaos.health, '继续 dormant 的人物仍承担真实月度健康损耗');
  assert.equal(afterRepeatChaos.lastStep.some((event) => event.kind === 'action'
    && event.who === repeatedSleeper.id
    && event.action.kind === 'act'
    && event.action.operation === 'dehydrate'), false, '继续 episode 不得生成第二条 dehydrate 行动');
  assert.ok(afterRepeatChaos.lastStep.some((event) => event.kind === 'environment'
    && event.diff.continuedEpisode === true
    && event.diff.entryHydrationCost === 0), 'recovering→dormant 必须留下无重复进入成本的阶段事实');
  assert.ok(afterRepeatChaos.lastStep.some((event) => event.kind === 'environment'
    && event.diff.hibernationMonthlySettlement === true
    && event.diff.hibernationPhase === 'dormant'
    && event.diff.monthlyCostApplied === true), '每个 dormant 月必须留下可审计的身体成本事实');

  const sourcedRecoveryState = structuredClone(afterRepeatChaos);
  sourcedRecoveryState.civilization.externalClimate = { epoch: 'stable', kind: 'temperate', severity: 0 };
  const recoveringPerson = sourcedRecoveryState.people[0];
  recoveringPerson.inventory.push({
    id: 'test-recovery-food', materialId: 21, quantity: 1, sourceEventIds: ['test-physical-food'],
  });
  const recoveryWaterCell = recoveringPerson.position.cellId % sourcedRecoveryState.world.grid.width < sourcedRecoveryState.world.grid.width - 1
    ? recoveringPerson.position.cellId + 1
    : recoveringPerson.position.cellId - 1;
  let recoveryWaterZ = sourcedRecoveryState.world.grid.levels - 1;
  while (recoveryWaterZ > 0
    && sourcedRecoveryState.world.grid.voxels[recoveryWaterZ * sourcedRecoveryState.world.grid.width * sourcedRecoveryState.world.grid.depth + recoveryWaterCell] === 0) recoveryWaterZ -= 1;
  sourcedRecoveryState.world.grid.voxels[recoveryWaterZ * sourcedRecoveryState.world.grid.width * sourcedRecoveryState.world.grid.depth + recoveryWaterCell] = 7;
  const recoveryHelper = structuredClone(createInitialState(349, { endpoint: { kind: 'months', value: 8 }, chaosIntensity: 0 }).people[1]);
  recoveryHelper.position = {
    ...recoveringPerson.position,
    lastPath: [recoveringPerson.position.cellId],
    tickPath: [recoveringPerson.position.cellId],
  };
  recoveryHelper.bornAtMonth = sourcedRecoveryState.clock.elapsedMonths;
  recoveryHelper.generation = 1;
  recoveryHelper.activeIntentId = undefined;
  sourcedRecoveryState.people.push(recoveryHelper);
  const pendingSocialIntentId = 'test-pending-social-intent';
  const pendingRepresentationId = 'test-recovery-complete-message';
  sourcedRecoveryState.intents.push({
    id: pendingSocialIntentId,
    ownerId: recoveringPerson.id,
    summary: '恢复后回应同伴',
    domain: 'social',
    goal: { kind: 'representation-made', representationId: pendingRepresentationId },
    nextAction: {
      kind: 'communicate',
      audience: [recoveryHelper.id],
      content: { id: pendingRepresentationId, kind: 'claim', summary: '已经恢复，可以继续回应' },
    },
    status: 'active',
    createdAtMonth: sourcedRecoveryState.clock.elapsedMonths,
    lastProgressAtMonth: sourcedRecoveryState.clock.elapsedMonths,
    progress: 0,
    sourceDecisionEventId: 'test-pending-social-decision',
    sourceFactIds: ['test-pending-social-request'],
    actionEventIds: [],
    replanCount: 0,
  });
  recoveringPerson.activeIntentId = pendingSocialIntentId;

  const intentCountBeforeSourcedRecovery = sourcedRecoveryState.intents.length;
  const duringSourcedRecovery = stepSimulation(sourcedRecoveryState, {
    decide() { return { kind: 'idle', reason: '恢复期不得抢跑社会回应' }; },
  });
  const recoveringAfterSources = duringSourcedRecovery.people.find((person) => person.id === recoveringPerson.id);
  const sourcedEpisode = recoveringAfterSources.conditions.find((condition) => condition.kind === 'dehydrated-hibernation');
  assert.equal(sourcedEpisode?.hibernationPhase, 'recovering', '真实摄入发生的当月仍保持 recovering，统一在下月边界审计退出');
  assert.ok((sourcedEpisode?.recoverySourceEventIds?.length ?? 0) >= 2, '恢复阶段必须记录真实饮水与进食来源');
  assert.ok(Math.min(recoveringAfterSources.body.health, recoveringAfterSources.body.hydration, recoveringAfterSources.body.nutrition) >= 45,
    '真实水和食物应把最低身体储备恢复到安全线');
  assert.equal(duringSourcedRecovery.lastStep.some((event) => event.kind === 'action'
    && event.who === recoveringPerson.id
    && event.action.kind === 'communicate'), false, 'recovering 期间不得执行排队中的社会回应');
  assert.equal(duringSourcedRecovery.lastStep.some((event) => event.kind === 'decision'
    && event.who === recoveringPerson.id), false, 'recovering 人物不得进入普通 decision / applyDecision 链');
  assert.deepEqual(buildDecisionContexts(duringSourcedRecovery)
    .find((context) => context.person.id === recoveringPerson.id)?.options, [], 'recovering 人物的普通规划 options 必须为空');
  const suspendedSocialIntent = duringSourcedRecovery.intents.find((intent) => intent.id === pendingSocialIntentId);
  assert.equal(recoveringAfterSources.activeIntentId, undefined, '恢复期不得把排队中的社会意图继续挂为 active');
  assert.equal(suspendedSocialIntent?.status, 'suspended', '恢复期必须暂停而不是丢弃排队中的社会意图');
  assert.equal(suspendedSocialIntent?.suspendedForHibernationConditionId, sourcedEpisode?.id,
    '排队中的社会意图必须绑定当前连续休眠 episode');
  assert.equal(duringSourcedRecovery.intents.length, intentCountBeforeSourcedRecovery,
    'recovering 的直接生存动作不得创建瞬时 child intent');
  assert.ok(duringSourcedRecovery.lastStep.filter((event) => event.kind === 'action'
    && event.who === recoveringPerson.id).every((event) => event.action.kind === 'move'
      || event.action.kind === 'transfer'
      || (event.action.kind === 'act' && (event.action.operation === 'ingest' || event.action.operation === 'separate'))),
  'recovering 期间只能执行真实取水、取食与必要移动');

  const afterSourcedExit = stepSimulation(duringSourcedRecovery, {
    decide() { return { kind: 'idle', reason: '退出恢复后继续原社会意图' }; },
  });
  const exitedPerson = afterSourcedExit.people.find((person) => person.id === recoveringPerson.id);
  assert.equal(exitedPerson.conditions.some((condition) => condition.kind === 'dehydrated-hibernation'), false,
    '具有真实来源且最低储备达到安全线后才能退出 episode');
  const exitFact = afterSourcedExit.lastStep.find((event) => event.kind === 'environment'
    && event.diff.condition === 'dehydrated-hibernation'
    && event.diff.exited === true
    && event.who === recoveringPerson.id);
  assert.ok(exitFact, '安全退出必须留下绑定当前恢复来源的事实');
  assert.equal(exitFact.diff.restoredIntentId, pendingSocialIntentId, '安全退出必须恢复同一个社会意图 ID');
  assert.ok(exitFact.diff.recoverySourceEventIds.every((sourceId) => duringSourcedRecovery.world.past.some((event) => event.id === sourceId
    && event.kind === 'action'
    && event.status === 'completed'
    && event.action.kind === 'act'
    && (event.action.operation === 'ingest' || event.action.operation === 'rehydrate'))),
  '每个退出来源都必须解析为真实完成的 ingest 或 rehydrate 行动');
  assert.ok(afterSourcedExit.lastStep.some((event) => event.kind === 'action'
    && event.who === recoveringPerson.id
    && event.action.kind === 'communicate'
    && event.action.content.id === pendingRepresentationId), 'episode 退出后原社会意图必须能够继续执行');

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
  const helpedRecoveryEpisode = state.people.find((person) => person.id === sleeper.id)
    ?.conditions.find((condition) => condition.kind === 'dehydrated-hibernation');
  assert.equal(helpedRecoveryEpisode?.hibernationPhase, 'recovering', '真实重新水化行动只能转入 recovering，不能提前删除 episode');
  assert.ok(helpedRecoveryEpisode?.recoverySourceEventIds?.includes(recovery.id), 'rehydrate 行动必须成为当前恢复阶段的真实来源');
  assert.equal(state.world.past.filter((event) => event.kind === 'action'
    && event.who === helper.id
    && event.action.kind === 'act'
    && event.action.operation === 'rehydrate'
    && event.diff.rehydratedPersonId === sleeper.id).length, 1, '同一帮助者同月只能执行一次 rehydrate，不能重复补水');
  assert.ok(
    state.people.find((person) => person.id === sleeper.id)
      .relations.find((relation) => relation.personId === helper.id).sourceEventIds.includes(recovery.id),
    '没有有效预言阻止时，帮助结束休眠应形成双方关系证据',
  );

  const multiHelperState = createInitialState(352, { endpoint: { kind: 'months', value: 4 }, chaosIntensity: 0 });
  multiHelperState.clock.elapsedMonths = 1;
  multiHelperState.civilization.externalClimate = { epoch: 'stable', kind: 'temperate', severity: 0 };
  const [firstHelper, secondHelper, sharedSleeper] = multiHelperState.people;
  multiHelperState.people = [firstHelper, secondHelper, sharedSleeper];
  for (const person of multiHelperState.people) {
    person.position = {
      ...firstHelper.position,
      lastPath: [firstHelper.position.cellId],
      tickPath: [firstHelper.position.cellId],
    };
    person.conditions = [];
    person.activeIntentId = undefined;
  }
  sharedSleeper.body = { health: 80, hydration: 70, nutrition: 80 };
  sharedSleeper.conditions = [{
    id: 'test-multi-helper-hibernation',
    kind: 'dehydrated-hibernation',
    stage: 1,
    sinceMonth: 1,
    sourceEventIds: ['test-multi-helper-dehydrate'],
    hibernationPhase: 'dormant',
  }];
  const multiWaterCell = firstHelper.position.cellId % multiHelperState.world.grid.width < multiHelperState.world.grid.width - 1
    ? firstHelper.position.cellId + 1
    : firstHelper.position.cellId - 1;
  let multiWaterZ = multiHelperState.world.grid.levels - 1;
  while (multiWaterZ > 0
    && multiHelperState.world.grid.voxels[multiWaterZ * multiHelperState.world.grid.width * multiHelperState.world.grid.depth + multiWaterCell] === 0) multiWaterZ -= 1;
  multiHelperState.world.grid.voxels[multiWaterZ * multiHelperState.world.grid.width * multiHelperState.world.grid.depth + multiWaterCell] = 7;
  const multiHelperIds = new Set([firstHelper.id, secondHelper.id]);
  const reviewedHelperIds = [];
  const afterMultiHelperWake = await stepSimulationAsync(multiHelperState, {
    shouldDecide(context) { return multiHelperIds.has(context.person.id); },
    forceReview(context) { return multiHelperIds.has(context.person.id); },
    isBudgetExempt(context) { return multiHelperIds.has(context.person.id); },
    async decideAll(contexts) {
      return contexts.map((context) => {
        reviewedHelperIds.push(context.person.id);
        const option = context.options.find((candidate) => candidate.id.startsWith(`rehydrate:${sharedSleeper.id}:`));
        assert.ok(option, '两个帮助者的同月预编译上下文都必须看到同一 dormant sleeper');
        return { kind: 'start', optionId: option.id, reason: '并发帮助夹具选择同一休眠者' };
      });
    },
  });
  assert.deepEqual(new Set(reviewedHelperIds), multiHelperIds, '两个帮助者都必须在同一月预编译 rehydrate 意图');
  const multiRehydrateFacts = afterMultiHelperWake.lastStep.filter((event) => event.kind === 'action'
    && event.status === 'completed'
    && event.action.kind === 'act'
    && event.action.operation === 'rehydrate'
    && event.diff.rehydratedPersonId === sharedSleeper.id);
  assert.equal(multiRehydrateFacts.length, 1, '两个预编译 helper 中只能有一个真正完成 rehydrate');
  assert.equal(afterMultiHelperWake.lastStep.some((event) => event.kind === 'action'
    && event.action.kind === 'act'
    && event.action.operation === 'rehydrate'
    && event.status === 'blocked'), false, '第二个 helper 应由 phase goal 幂等完成，不应再生成重复 primitive action');
  const multiHelperIntents = afterMultiHelperWake.intents.filter((intent) => multiHelperIds.has(intent.ownerId)
    && intent.createdAtMonth === 2
    && intent.goal.kind === 'condition'
    && intent.goal.personId === sharedSleeper.id
    && intent.goal.phase === 'recovering');
  assert.equal(multiHelperIntents.length, 2, '两个帮助者必须各自保留可审计的同月预编译意图');
  assert.equal(multiHelperIntents.filter((intent) => intent.status === 'completed' && intent.actionEventIds.length === 0).length, 1,
    '后执行的 helper 意图必须在 primitive 前按 recovering goal 直接完成');
  const multiSettlement = afterMultiHelperWake.lastStep.find((event) => event.kind === 'environment'
    && event.who === sharedSleeper.id
    && event.diff.hibernationMonthlySettlement === true);
  assert.ok(multiSettlement, '多帮助者夹具仍必须留下本月恢复身体结算');
  assert.equal(multiSettlement.diff.bodyBefore.hydration, 88, '月度结算前 hydration 只能包含一次 +18 rehydrate');
  assert.ok(Math.abs(multiSettlement.diff.bodyAfter.hydration
    - (multiSettlement.diff.bodyBefore.hydration - multiSettlement.diff.hydrationCost)) < 1e-9,
  '单次 +18 后只能再扣除可审计的本月恢复代谢成本');

  const stalePrimitiveState = structuredClone(afterMultiHelperWake);
  const staleSleeper = stalePrimitiveState.people.find((person) => person.id === sharedSleeper.id);
  const staleHelperIntent = multiHelperIntents.find((intent) => intent.actionEventIds.length === 0);
  const staleHelper = stalePrimitiveState.people.find((person) => person.id === staleHelperIntent.ownerId);
  const bodyBeforeStalePrimitive = structuredClone(staleSleeper.body);
  const sourcesBeforeStalePrimitive = structuredClone(staleSleeper.conditions
    .find((condition) => condition.kind === 'dehydrated-hibernation').recoverySourceEventIds);
  const sleeperRelationsBeforeStalePrimitive = structuredClone(staleSleeper.relations);
  const helperRelationsBeforeStalePrimitive = structuredClone(staleHelper.relations);
  const staleRehydrate = executePrimitiveAction(stalePrimitiveState, staleHelper, {
    kind: 'act', operation: 'rehydrate', targets: [{ kind: 'person', personId: staleSleeper.id }],
  }, stalePrimitiveState.clock.elapsedMonths, 999, { cause: 'intent', actionTick: 15 });
  assert.equal(staleRehydrate.status, 'blocked', '绕过 goal 预检的陈旧 rehydrate primitive 必须在领域执行层阻塞');
  assert.equal(staleRehydrate.diff.duplicateRehydrationBlocked, true, '领域阻塞事实必须明确标记重复重新水化');
  assert.deepEqual(staleSleeper.body, bodyBeforeStalePrimitive, '陈旧 primitive 不得再次改变 sleeper body');
  assert.deepEqual(staleSleeper.conditions.find((condition) => condition.kind === 'dehydrated-hibernation')
    .recoverySourceEventIds, sourcesBeforeStalePrimitive, '陈旧 primitive 不得伪造第二个恢复来源');
  assert.deepEqual(staleSleeper.relations, sleeperRelationsBeforeStalePrimitive, '陈旧 primitive 不得改变 sleeper 关系');
  assert.deepEqual(staleHelper.relations, helperRelationsBeforeStalePrimitive, '陈旧 primitive 不得改变 helper 关系');

  const dependentRecoveryState = createInitialState(353, { endpoint: { kind: 'months', value: 4 }, chaosIntensity: 0 });
  dependentRecoveryState.clock.elapsedMonths = 1;
  dependentRecoveryState.civilization.externalClimate = { epoch: 'stable', kind: 'temperate', severity: 0 };
  const [caregiver, recoveringChild] = dependentRecoveryState.people;
  dependentRecoveryState.people = [caregiver, recoveringChild];
  caregiver.position = { ...caregiver.position, lastPath: [caregiver.position.cellId], tickPath: [caregiver.position.cellId] };
  recoveringChild.position = { ...caregiver.position, lastPath: [caregiver.position.cellId], tickPath: [caregiver.position.cellId] };
  caregiver.body = { health: 90, hydration: 90, nutrition: 90 };
  caregiver.conditions = [];
  caregiver.inventory = [{
    id: 'test-caregiver-carried-food', materialId: 21, quantity: 1, sourceEventIds: ['test-caregiver-food-source'],
  }];
  recoveringChild.bornAtMonth = 1;
  recoveringChild.generation = 1;
  recoveringChild.geneticParents = [caregiver.id];
  recoveringChild.body = { health: 70, hydration: 70, nutrition: 20 };
  recoveringChild.inventory = [];
  recoveringChild.conditions = [{
    id: 'test-dependent-recovery',
    kind: 'dehydrated-hibernation',
    stage: 2,
    sinceMonth: 0,
    sourceEventIds: ['test-dependent-dehydrate'],
    hibernationPhase: 'recovering',
    recoveryStartedAtMonth: 1,
    recoverySourceEventIds: [],
  }];
  dependentRecoveryState.world.drops = [{
    id: 'test-dependent-ground-food', materialId: 21,
    cellId: recoveringChild.position.cellId, z: recoveringChild.position.z,
    quantity: 1, createdAtMonth: 1, sourceEventIds: ['test-ground-food-source'],
  }];
  const dependentWaterCell = caregiver.position.cellId % dependentRecoveryState.world.grid.width < dependentRecoveryState.world.grid.width - 1
    ? caregiver.position.cellId + 1
    : caregiver.position.cellId - 1;
  let dependentWaterZ = dependentRecoveryState.world.grid.levels - 1;
  while (dependentWaterZ > 0
    && dependentRecoveryState.world.grid.voxels[dependentWaterZ * dependentRecoveryState.world.grid.width * dependentRecoveryState.world.grid.depth + dependentWaterCell] === 0) dependentWaterZ -= 1;
  dependentRecoveryState.world.grid.voxels[dependentWaterZ * dependentRecoveryState.world.grid.width * dependentRecoveryState.world.grid.depth + dependentWaterCell] = 7;
  const intentCountBeforeDependentRecovery = dependentRecoveryState.intents.length;
  const afterDependentRecovery = stepSimulation(dependentRecoveryState, {
    decide() { return { kind: 'idle', reason: '只观察恢复期未成年人与照护者的领域反射' }; },
  });
  const childActions = afterDependentRecovery.lastStep.filter((event) => event.kind === 'action'
    && event.who === recoveringChild.id);
  assert.equal(childActions.some((event) => event.action.kind === 'move'), false,
    'recovering dependent child 不得自主移动找水或找食物');
  assert.equal(childActions.some((event) => event.action.kind === 'transfer'), false,
    'recovering dependent child 不得自主拾取地面物资');
  assert.equal(childActions.some((event) => event.action.kind === 'act' && event.action.operation === 'separate'), false,
    'recovering dependent child 不得自主采收植物');
  const caregiverFoodTransfer = afterDependentRecovery.lastStep.find((event) => event.kind === 'action'
    && event.who === caregiver.id
    && event.status === 'completed'
    && event.action.kind === 'transfer'
    && event.action.from.kind === 'person'
    && event.action.to.kind === 'person'
    && event.action.to.personId === recoveringChild.id);
  assert.ok(caregiverFoodTransfer, '照护者必须能把本人携带的食物交给 recovering dependent child');
  const childIngest = childActions.find((event) => event.status === 'completed'
    && event.action.kind === 'act'
    && event.action.operation === 'ingest'
    && event.action.targets.some((target) => target.kind === 'inventory-stack' && target.personId === recoveringChild.id));
  assert.ok(childIngest, 'recovering dependent child 只能摄入已经属于自己库存的食物');
  assert.equal(afterDependentRecovery.world.drops.find((drop) => drop.id === 'test-dependent-ground-food')?.quantity, 1,
    '同地地面食物必须保持未动，证明 child 没有绕过 caregiver 自主拾取');
  assert.equal(afterDependentRecovery.intents.length, intentCountBeforeDependentRecovery,
    'dependent recovering 的 caregiver transfer 与本人 ingest 都不得创建恢复 child intent');
  assert.ok(afterDependentRecovery.people.find((person) => person.id === recoveringChild.id)
    .conditions.find((condition) => condition.kind === 'dehydrated-hibernation')
    ?.recoverySourceEventIds?.includes(childIngest.id), 'child 自己完成的 ingest 必须成为真实恢复来源');

  const dependentWaterRecoveryState = createInitialState(359, { endpoint: { kind: 'months', value: 8 }, chaosIntensity: 0 });
  dependentWaterRecoveryState.clock.elapsedMonths = 1;
  dependentWaterRecoveryState.civilization.era = {
    sequence: 2, kind: 'stable', sinceMonth: 1, endsAtMonth: 8, dominantClimate: 'temperate',
  };
  dependentWaterRecoveryState.civilization.epoch = 'stable';
  dependentWaterRecoveryState.civilization.externalClimate = { epoch: 'stable', kind: 'temperate', severity: 0 };
  const [waterCaregiver, waterRecoveringChild] = dependentWaterRecoveryState.people;
  dependentWaterRecoveryState.people = [waterCaregiver, waterRecoveringChild];
  waterCaregiver.position = {
    ...waterCaregiver.position,
    lastPath: [waterCaregiver.position.cellId],
    tickPath: [waterCaregiver.position.cellId],
  };
  waterRecoveringChild.position = structuredClone(waterCaregiver.position);
  waterCaregiver.body = { health: 90, hydration: 90, nutrition: 90 };
  waterCaregiver.conditions = [];
  waterCaregiver.inventory = [];
  waterRecoveringChild.bornAtMonth = 1;
  waterRecoveringChild.generation = 1;
  waterRecoveringChild.geneticParents = [waterCaregiver.id];
  waterRecoveringChild.body = { health: 70, hydration: 20, nutrition: 70 };
  waterRecoveringChild.conditions = [{
    id: 'test-dependent-water-recovery',
    kind: 'dehydrated-hibernation',
    stage: 2,
    sinceMonth: 0,
    sourceEventIds: ['test-dependent-water-dehydrate'],
    hibernationPhase: 'recovering',
    recoveryStartedAtMonth: 1,
    recoverySourceEventIds: [],
  }];
  waterRecoveringChild.inventory = [];
  dependentWaterRecoveryState.world.drops = [];
  dependentWaterRecoveryState.world.animals = [];
  for (let index = 0; index < dependentWaterRecoveryState.world.grid.voxels.length; index += 1) {
    const material = dependentWaterRecoveryState.world.grid.voxels[index];
    if (material === 7 || material === 18) dependentWaterRecoveryState.world.grid.voxels[index] = 1;
    else if (material === 9 || material === 10 || material === 11 || material === 12) dependentWaterRecoveryState.world.grid.voxels[index] = 8;
  }
  const { width: waterGridWidth, depth: waterGridDepth, levels: waterGridLevels } = dependentWaterRecoveryState.world.grid;
  const waterLayerSize = waterGridWidth * waterGridDepth;
  const caregiverX = waterCaregiver.position.cellId % waterGridWidth;
  const caregiverY = Math.floor(waterCaregiver.position.cellId / waterGridWidth);
  const possibleWaterCells = Array.from({ length: waterGridWidth * waterGridDepth }, (_, cellId) => ({
    cellId,
    distance: Math.abs((cellId % waterGridWidth) - caregiverX)
      + Math.abs(Math.floor(cellId / waterGridWidth) - caregiverY),
  })).filter(({ distance }) => distance >= 3 && distance <= 6)
    .sort((left, right) => left.distance - right.distance || left.cellId - right.cellId);
  let distantWater = null;
  for (const candidate of possibleWaterCells) {
    let surfaceZ = waterGridLevels - 1;
    while (surfaceZ > 0
      && dependentWaterRecoveryState.world.grid.voxels[surfaceZ * waterLayerSize + candidate.cellId] === 0) surfaceZ -= 1;
    const voxelIndex = surfaceZ * waterLayerSize + candidate.cellId;
    const originalMaterial = dependentWaterRecoveryState.world.grid.voxels[voxelIndex];
    if (![1, 2, 3, 4, 5, 6, 8, 15, 17].includes(originalMaterial)) continue;
    dependentWaterRecoveryState.world.grid.voxels[voxelIndex] = 7;
    const reachable = findReachableWater(dependentWaterRecoveryState, waterCaregiver);
    if (reachable && reachable.pathLength >= 3) {
      distantWater = reachable;
      break;
    }
    dependentWaterRecoveryState.world.grid.voxels[voxelIndex] = originalMaterial;
  }
  assert.ok(distantWater?.pathLength >= 3, '远处取水夹具必须有需要照护者连续移动的真实可达水源');
  const intentsBeforeDependentWaterRecovery = dependentWaterRecoveryState.intents.length;
  let dependentWaterRecovery = dependentWaterRecoveryState;
  let sawDependentCarry = false;
  let assistedRecoveryCount = 0;
  let dependentWaterExitFact = null;
  for (let month = 0; month < 5; month += 1) {
    const childAtMonthStart = dependentWaterRecovery.people.find((person) => person.id === waterRecoveringChild.id);
    const recoveringAtMonthStart = childAtMonthStart.conditions.some((condition) => condition.kind === 'dehydrated-hibernation');
    const hydrationAtMonthStart = childAtMonthStart.body.hydration;
    const next = stepSimulation(dependentWaterRecovery, {
      decide() { return { kind: 'idle', reason: '只观察照护者携行并用真实水源帮助 dependent child' }; },
    });
    const childActionsThisMonth = next.lastStep.filter((event) => event.kind === 'action'
      && event.who === waterRecoveringChild.id);
    const exitedAtMonthBoundary = next.lastStep.some((event) => event.kind === 'environment'
      && event.who === waterRecoveringChild.id
      && event.diff.hibernationConditionId === 'test-dependent-water-recovery'
      && event.diff.exited === true);
    if (recoveringAtMonthStart && !exitedAtMonthBoundary) {
      assert.equal(childActionsThisMonth.some((event) => event.action.kind === 'move'
        || event.action.kind === 'transfer'
        || (event.action.kind === 'act' && event.action.operation === 'separate')
        || (event.action.kind === 'act' && event.action.operation === 'ingest'
          && event.action.targets.some((target) => target.kind !== 'inventory-stack'))), false,
      'dependent-child recovering 期间不得自主移动、捡拾、采收或直接饮用地表水');
    }
    const caregiverMoves = next.lastStep.filter((event) => event.kind === 'action'
      && event.who === waterCaregiver.id
      && event.action.kind === 'move');
    sawDependentCarry ||= caregiverMoves.some((event) => event.diff.carriedPersonIds?.includes(waterRecoveringChild.id));
    const assistedThisMonth = next.lastStep.filter((event) => event.kind === 'action'
      && event.who === waterCaregiver.id
      && event.status === 'completed'
      && event.action.kind === 'act'
      && event.action.operation === 'rehydrate'
      && event.diff.assistedDependentId === waterRecoveringChild.id);
    assert.ok(assistedThisMonth.length <= 1, '同一照护者对 recovering dependent 每月最多只能完成一次 rehydrate');
    assistedRecoveryCount += assistedThisMonth.length;
    if (assistedThisMonth[0]) {
      const childAfterAssistance = next.people.find((person) => person.id === waterRecoveringChild.id);
      const episodeAfterAssistance = childAfterAssistance.conditions
        .find((condition) => condition.kind === 'dehydrated-hibernation');
      const settlement = next.lastStep.find((event) => event.kind === 'environment'
        && event.who === waterRecoveringChild.id
        && event.diff.hibernationMonthlySettlement === true);
      assert.equal(episodeAfterAssistance?.hibernationPhase, 'recovering', '照护者补水不得跳过 recovering phase');
      assert.equal(episodeAfterAssistance?.lastRecoveryAssistedAtMonth, next.clock.elapsedMonths,
        '照护者补水必须登记本月去重标记');
      assert.ok(episodeAfterAssistance?.recoverySourceEventIds?.includes(assistedThisMonth[0].id),
        '照护者补水行动必须是真实恢复来源');
      assert.equal(settlement?.diff.bodyBefore.hydration, Math.min(100, hydrationAtMonthStart + 18),
        '月度结算前只能出现一次 +18 的照护补水');
      const staleAssistanceState = structuredClone(next);
      const staleAssistanceCaregiver = staleAssistanceState.people.find((person) => person.id === waterCaregiver.id);
      const staleAssistanceChild = staleAssistanceState.people.find((person) => person.id === waterRecoveringChild.id);
      const staleAssistanceBody = structuredClone(staleAssistanceChild.body);
      const staleAssistanceSources = structuredClone(staleAssistanceChild.conditions
        .find((condition) => condition.kind === 'dehydrated-hibernation').recoverySourceEventIds);
      const duplicateAssistance = executePrimitiveAction(staleAssistanceState, staleAssistanceCaregiver, {
        kind: 'act', operation: 'rehydrate', targets: [{ kind: 'person', personId: staleAssistanceChild.id }],
      }, next.clock.elapsedMonths, 999, { cause: 'survival-reflex', actionTick: 15 });
      assert.equal(duplicateAssistance.status, 'blocked', '同月陈旧 dependent rehydrate primitive 必须在领域层阻塞');
      assert.deepEqual(staleAssistanceChild.body, staleAssistanceBody, '同月第二次照护补水不得改变身体');
      assert.deepEqual(staleAssistanceChild.conditions.find((condition) => condition.kind === 'dehydrated-hibernation')
        .recoverySourceEventIds, staleAssistanceSources, '同月第二次照护补水不得伪造来源');
    }
    dependentWaterExitFact = next.lastStep.find((event) => event.kind === 'environment'
      && event.who === waterRecoveringChild.id
      && event.diff.hibernationConditionId === 'test-dependent-water-recovery'
      && event.diff.exited === true) ?? dependentWaterExitFact;
    dependentWaterRecovery = next;
    if (!next.people.find((person) => person.id === waterRecoveringChild.id)
      .conditions.some((condition) => condition.kind === 'dehydrated-hibernation')) break;
  }
  assert.equal(sawDependentCarry, true, '照护者必须携带 recovering dependent-child 走到可达水边');
  assert.ok(assistedRecoveryCount >= 2, '低水分 dependent-child 需要跨月真实补水，不得一次凭空恢复');
  assert.ok(dependentWaterExitFact, '只有达到安全线且有真实补水来源后 dependent 才能退出 episode');
  assert.equal(dependentWaterRecovery.intents.length, intentsBeforeDependentWaterRecovery,
    '携行与恢复帮助不得额外创建恢复意图');

  const seed15Month70State = createInitialState(20260815, { endpoint: { kind: 'months', value: 120 }, chaosIntensity: 0 });
  seed15Month70State.clock.elapsedMonths = 69;
  seed15Month70State.civilization.era = {
    sequence: 7, kind: 'chaotic', sinceMonth: 67, endsAtMonth: 82, dominantClimate: 'heat',
  };
  seed15Month70State.civilization.epoch = 'chaotic';
  seed15Month70State.civilization.climate = { kind: 'heat', severity: 8, sinceMonth: 67 };
  seed15Month70State.civilization.externalClimate = { epoch: 'chaotic', kind: 'heat', severity: 8 };
  const [seed15Sleeper, seed15Requester] = seed15Month70State.people;
  seed15Month70State.people = [seed15Sleeper, seed15Requester];
  seed15Requester.position = {
    ...seed15Sleeper.position,
    lastPath: [seed15Sleeper.position.cellId],
    tickPath: [seed15Sleeper.position.cellId],
  };
  seed15Sleeper.body = { health: 57.8, hydration: 62.28, nutrition: 38.46 };
  seed15Sleeper.inventory = [];
  seed15Sleeper.conditions = [{
    id: 'test-seed15-month70-severe-heat', kind: 'heat', stage: 3, sinceMonth: 69,
    sourceEventIds: ['test-seed15-month70-heat-exposure'],
  }];
  pushExposureFact(seed15Month70State, seed15Sleeper, 'test-seed15-month70-heat-exposure', 'heat', 3, 69);
  installThreeSidedShelter(seed15Month70State, seed15Sleeper);
  const seed15ProjectId = 'test-seed15-month70-project';
  const seed15ProjectIntentId = 'test-seed15-month70-project-parent';
  const seed15SocialIntentId = 'test-seed15-month70-social-leaf';
  seed15Month70State.projects = [{
    id: seed15ProjectId, kind: 'inquiry', need: 'seed15-month70', desiredFunction: 'seed15-month70',
    summary: '先前正在推进的长期项目', ownerId: seed15Sleeper.id, beneficiaryIds: [seed15Sleeper.id],
    triggerFactIds: ['test-seed15-project-pressure'], pressure: 80, createdAtMonth: 60, reviewAtMonth: 90,
    status: 'active', lastProgressAtMonth: 69, missingMaterialIds: [], materialDemands: [], reservations: [],
    contributorIds: [seed15Sleeper.id], actionEventIds: [], failureEventIds: [], completionEventIds: [],
    progressEvidence: [], searchCampaigns: [], pressureHistory: [], logisticsEpisodes: [],
  }];
  seed15Month70State.intents = [{
    id: seed15ProjectIntentId, ownerId: seed15Sleeper.id, summary: '休眠后仍需返回的项目', domain: 'strategic',
    goal: { kind: 'project-completed', projectId: seed15ProjectId },
    nextAction: { kind: 'attend', target: { kind: 'person', personId: seed15Sleeper.id } },
    status: 'suspended', createdAtMonth: 60, lastProgressAtMonth: 69, progress: 0.4,
    sourceDecisionEventId: 'test-seed15-project-decision', projectId: seed15ProjectId,
    suspendedByIntentId: seed15SocialIntentId, suspendedAtMonth: 69,
    sourceFactIds: ['test-seed15-project-pressure'], actionEventIds: [], replanCount: 0,
  }, {
    id: seed15SocialIntentId, ownerId: seed15Sleeper.id, summary: '项目中途正在进行的普通社会回应', domain: 'social',
    goal: { kind: 'representation-made', representationId: 'test-seed15-social-finish' },
    nextAction: {
      kind: 'communicate', audience: [seed15Requester.id], channel: 'voice',
      content: { id: 'test-seed15-social-finish', kind: 'claim', summary: '恢复后把刚才的话说完' },
    },
    status: 'active', createdAtMonth: 69, lastProgressAtMonth: 69, progress: 0,
    sourceDecisionEventId: 'test-seed15-social-decision', returnToIntentId: seed15ProjectIntentId,
    interruptionKind: 'life-review', sourceFactIds: ['test-seed15-social-source'], actionEventIds: [], replanCount: 0,
  }];
  seed15Sleeper.activeIntentId = seed15SocialIntentId;
  const seed15RequestId = 'test-seed15-month70-required-assist';
  const seed15RequiredRequest = executePrimitiveAction(seed15Month70State, seed15Requester, {
    kind: 'communicate', audience: [seed15Sleeper.id], channel: 'voice',
    content: {
      id: seed15RequestId, kind: 'request', summary: '等危险过去后请回应我',
      proposal: {
        kind: 'assist', requesterId: seed15Requester.id, helperId: seed15Sleeper.id,
        need: 'company', expiresAtMonth: 70,
      },
    },
  }, 69, 0, { cause: 'intent', actionTick: 15 });
  assert.equal(seed15RequiredRequest.status, 'completed');
  seed15Month70State.world.past.push(seed15RequiredRequest);
  const seed15Month70Context = buildDecisionContexts(seed15Month70State, 70)
    .find((context) => context.person.id === seed15Sleeper.id);
  const seed15ObservedDehydrate = seed15Month70Context.options.find((option) => option.nextAction.kind === 'act'
    && option.nextAction.operation === 'dehydrate'
    && option.nextAction.hibernationPredictionId === undefined);
  assert.ok(seed15ObservedDehydrate, 'seed15 m70 的 38.46 最低储备与已感知 stage3 heat 必须编译已发生乱纪元 dehydrate');
  assert.ok(seed15Month70Context.options.some((option) => option.id.startsWith('reject-assist:')
    || option.id.startsWith('accept-assist:')), '夹具必须同时包含 required social response，不能绕开真实冲突');
  const seed15Month70Decision = new RulePlanner().decideAt(seed15Month70Context, { atMonth: 70, planningTick: 1 });
  assert.equal(seed15Month70Decision.kind, 'revise');
  assert.equal(seed15Month70Decision.optionId, seed15ObservedDehydrate.id,
    '已感知 severe heat 的合法 dehydrate 必须先于 required social response');
  assert.equal(seed15Month70Decision.mode, 'interrupt');
  assert.equal(seed15Month70Decision.interruptionKind, 'survival-reflex',
    '紧急进入必须沿现有 survival-reflex interruption/return 边保存项目与社会 leaf');
  const seed15RulePlanner = new RulePlanner();
  const seed15FocusedPlanner = {
    decide(context) {
      return context.person.id === seed15Sleeper.id
        ? seed15RulePlanner.decide(context)
        : { kind: 'idle', reason: '不为期限冻结夹具制造额外社会提议' };
    },
  };

  const afterSeed15EmergencyEntry = stepSimulation(seed15Month70State, seed15FocusedPlanner);
  const seed15Episode = afterSeed15EmergencyEntry.people.find((person) => person.id === seed15Sleeper.id)
    .conditions.filter((condition) => condition.kind === 'dehydrated-hibernation');
  assert.equal(seed15Episode.length, 1, 'seed15 m70 的实际月度链只能建立一个 hibernation episode');
  const seed15EntryActions = afterSeed15EmergencyEntry.lastStep.filter((event) => event.kind === 'action'
    && event.who === seed15Sleeper.id
    && event.action.kind === 'act'
    && event.action.operation === 'dehydrate');
  assert.equal(seed15EntryActions.length, 1,
    'planner 已持有 dehydrate intent 时 failed-shelter reflex 不得在同月再执行一次');
  assert.equal(afterSeed15EmergencyEntry.intents.filter((intent) => intent.ownerId === seed15Sleeper.id
    && intent.createdAtMonth === 70
    && intent.interruptionKind === 'survival-reflex').length, 1,
  '同一休眠进入只能创建一个 survival child，不能叠出可在恒纪元重放的外层 dehydrate child');
  assert.equal(afterSeed15EmergencyEntry.world.past.some((event) => event.kind === 'action'
    && event.who === seed15Sleeper.id
    && event.action.kind === 'communicate'
    && (event.action.content.kind === 'accept' || event.action.content.kind === 'reject')
    && event.action.content.referenceId === seed15RequestId), false,
  '紧急休眠当月不得抢跑 required response');
  const pausedSeed15Agreement = afterSeed15EmergencyEntry.agreements.find((agreement) => agreement.id === seed15RequestId);
  assert.equal(pausedSeed15Agreement?.acceptByMonth, 70,
    '期限冻结必须保留原 proposal 的 acceptByMonth，不得重写历史提议');
  assert.deepEqual(pausedSeed15Agreement?.responseDeadlineSuspensions?.map((fact) => fact.kind), ['pause'],
    '进入 episode 当月必须为尚未回应的本人追加协议期限暂停事实');
  const seed15PauseFact = afterSeed15EmergencyEntry.lastStep.find((event) => event.kind === 'agreement'
    && event.agreementId === seed15RequestId
    && event.change === 'response-deadline-paused');
  assert.equal(seed15PauseFact?.hibernationConditionId, seed15Episode[0].id);
  assert.ok(seed15PauseFact?.sourceEventIds?.includes(seed15EntryActions[0].id),
    'pause fact 必须连回建立同一 episode 的真实 dehydrate action');

  const deadRequiredResponseState = structuredClone(afterSeed15EmergencyEntry);
  const deadRequiredResponder = deadRequiredResponseState.people.find((person) => person.id === seed15Sleeper.id);
  deadRequiredResponder.body.health = 0;
  deadRequiredResponder.diedAtMonth = 70;
  const afterRequiredResponderDeath = stepSimulation(deadRequiredResponseState, {
    decide() { return { kind: 'idle', reason: '验证死亡终止暂停中的 required response' }; },
  });
  assert.equal(afterRequiredResponderDeath.agreements.find((agreement) => agreement.id === seed15RequestId)?.status,
    'cancelled', '暂停期限不能让已死亡响应者的提议保持开放或错误记为过期');

  const seed15RecoveryState = structuredClone(afterSeed15EmergencyEntry);
  seed15RecoveryState.civilization.era = {
    sequence: 8, kind: 'stable', sinceMonth: 71, endsAtMonth: 90, dominantClimate: 'temperate',
  };
  seed15RecoveryState.civilization.epoch = 'stable';
  seed15RecoveryState.civilization.climate = { kind: 'temperate', severity: 0, sinceMonth: 71 };
  seed15RecoveryState.civilization.externalClimate = { epoch: 'stable', kind: 'temperate', severity: 0 };
  const recoveringSeed15Sleeper = seed15RecoveryState.people.find((person) => person.id === seed15Sleeper.id);
  recoveringSeed15Sleeper.body = { health: 90, hydration: 90, nutrition: 90 };
  recoveringSeed15Sleeper.inventory.push({
    id: 'test-seed15-recovery-water', materialId: Material.Water, quantity: 1,
    sourceEventIds: ['test-seed15-recovery-water-source'],
  });
  const afterSeed15RecoverySource = stepSimulation(seed15RecoveryState, seed15FocusedPlanner);
  assert.equal(afterSeed15RecoverySource.people.find((person) => person.id === seed15Sleeper.id)
    .conditions.find((condition) => condition.kind === 'dehydrated-hibernation')?.hibernationPhase, 'recovering');
  const afterSeed15SafeExit = stepSimulation(afterSeed15RecoverySource, seed15FocusedPlanner);
  assert.equal(afterSeed15SafeExit.people.find((person) => person.id === seed15Sleeper.id)
    .conditions.some((condition) => condition.kind === 'dehydrated-hibernation'), false,
  '真实补水达到安全线后必须跨月退出同一 episode');
  assert.equal(afterSeed15SafeExit.lastStep.find((event) => event.kind === 'environment'
    && event.diff.hibernationConditionId === seed15Episode[0].id
    && event.diff.exited === true)?.diff.restoredIntentId, seed15SocialIntentId,
  '只有一个休眠 owner 时，安全退出必须直接恢复进入前的原社会 leaf');
  assert.equal(afterSeed15SafeExit.lastStep.some((event) => event.kind === 'action'
    && event.who === seed15Sleeper.id
    && event.action.kind === 'act'
    && event.action.operation === 'dehydrate'), false,
  '恒纪元退出后不得重放进入时的 dehydrate 动作');
  const resumedSeed15Agreement = afterSeed15SafeExit.agreements.find((agreement) => agreement.id === seed15RequestId);
  assert.deepEqual(resumedSeed15Agreement?.responseDeadlineSuspensions?.map((fact) => fact.kind), ['pause', 'resume'],
    '退出 episode 时必须追加 resume 事实，保留完整冻结区间');
  assert.deepEqual(resumedSeed15Agreement?.responseDeadlineSuspensions?.map((fact) => fact.atMonth), [70, 72],
    '冻结区间必须覆盖 entry 到 safe exit 之间的完整协议时钟');
  const seed15ExitFact = afterSeed15SafeExit.lastStep.find((event) => event.kind === 'environment'
    && event.diff.hibernationConditionId === seed15Episode[0].id
    && event.diff.exited === true);
  const seed15ResumeFact = afterSeed15SafeExit.lastStep.find((event) => event.kind === 'agreement'
    && event.agreementId === seed15RequestId
    && event.change === 'response-deadline-resumed');
  assert.ok(seed15ResumeFact?.sourceEventIds?.includes(seed15ExitFact.id),
    'resume fact 必须连回同一 episode 的安全退出事实');
  assert.notEqual(resumedSeed15Agreement?.status, 'expired',
    '原始 acceptByMonth 已经过期时，休眠冻结后的有效期限仍须覆盖恢复月份');
  assert.equal(afterSeed15SafeExit.world.past.filter((event) => event.kind === 'action'
    && event.who === seed15Sleeper.id
    && event.action.kind === 'communicate'
    && (event.action.content.kind === 'accept' || event.action.content.kind === 'reject')
    && event.action.content.referenceId === seed15RequestId).length, 1,
  '恢复后 required response 必须仍可回答且只能提交一次');

  const legacyDeadlineState = structuredClone(afterSeed15EmergencyEntry);
  legacyDeadlineState.clock.elapsedMonths = 100;
  const legacyDeadlinePerson = legacyDeadlineState.people.find((person) => person.id === seed15Sleeper.id);
  const legacyDeadlineEpisode = legacyDeadlinePerson.conditions.find((condition) => condition.kind === 'dehydrated-hibernation');
  legacyDeadlineEpisode.sinceMonth = 91;
  const legacyDeadlineAgreement = legacyDeadlineState.agreements.find((agreement) => agreement.id === seed15RequestId);
  legacyDeadlineAgreement.proposedAtMonth = 90;
  legacyDeadlineAgreement.acceptByMonth = 92;
  delete legacyDeadlineAgreement.responseDeadlineSuspensions;
  const legacyPauseEvents = synchronizeAgreementResponseDeadlineSuspensions(legacyDeadlineState, 101);
  assert.equal(legacyPauseEvents.length, 1);
  assert.equal(legacyDeadlineAgreement.responseDeadlineSuspensions?.[0]?.atMonth, 101,
    '旧存档的 pause 事实仍必须记录首次观察到 episode 的真实月份');
  assert.equal(legacyDeadlineAgreement.responseDeadlineSuspensions?.[0]?.effectiveFromMonth, 91,
    '旧存档已持续的 episode 必须从真实 sinceMonth 冻结回应时钟');
  assert.equal(agreementResponseDeadline(legacyDeadlineAgreement, seed15Sleeper.id), Number.POSITIVE_INFINITY);
  legacyDeadlinePerson.conditions = legacyDeadlinePerson.conditions.filter((condition) => condition.id !== legacyDeadlineEpisode.id);
  const legacyResumeEvents = synchronizeAgreementResponseDeadlineSuspensions(legacyDeadlineState, 105);
  assert.equal(legacyResumeEvents.length, 1);
  assert.equal(agreementResponseDeadline(legacyDeadlineAgreement, seed15Sleeper.id), 106,
    '恢复旧存档时必须补回升级前已冻结的月份，使醒来当月至少仍可回应');
  assert.equal(advanceAgreementLifecycle(legacyDeadlineState, 105).length, 0);
  assert.equal(legacyDeadlineAgreement.status, 'proposed',
    '旧存档跨过原始 acceptByMonth 后恢复时，不得在醒来当月立刻过期');

  const socialEntryState = createInitialState(354, { endpoint: { kind: 'months', value: 8 }, chaosIntensity: 0 });
  socialEntryState.clock.elapsedMonths = 1;
  socialEntryState.civilization.epoch = 'chaotic';
  socialEntryState.civilization.climate = { kind: 'heat', severity: 8, sinceMonth: 1 };
  socialEntryState.civilization.externalClimate = { epoch: 'chaotic', kind: 'heat', severity: 8 };
  const [socialSleeper, socialListener] = socialEntryState.people;
  socialEntryState.people = [socialSleeper, socialListener];
  socialListener.position = { ...socialSleeper.position, lastPath: [socialSleeper.position.cellId], tickPath: [socialSleeper.position.cellId] };
  socialSleeper.body = { health: 90, hydration: 90, nutrition: 90 };
  socialSleeper.conditions = [{
    id: 'test-social-entry-heat', kind: 'heat', stage: 2, sinceMonth: 1, sourceEventIds: ['test-social-entry-exposure'],
  }];
  pushExposureFact(socialEntryState, socialSleeper, 'test-social-entry-exposure', 'heat', 2, 1);
  const socialEntryIntentId = 'test-social-intent-before-dehydrate';
  const socialEntryRepresentationId = 'test-social-intent-after-recovery-message';
  socialEntryState.intents.push({
    id: socialEntryIntentId,
    ownerId: socialSleeper.id,
    summary: '休眠恢复后继续原社会回应',
    domain: 'social',
    goal: { kind: 'representation-made', representationId: socialEntryRepresentationId },
    nextAction: {
      kind: 'communicate',
      audience: [socialListener.id],
      channel: 'voice',
      content: { id: socialEntryRepresentationId, kind: 'claim', summary: '恢复后继续这项回应' },
    },
    status: 'active',
    createdAtMonth: 1,
    lastProgressAtMonth: 1,
    progress: 0,
    sourceDecisionEventId: 'test-social-entry-decision',
    sourceFactIds: ['test-social-entry-request'],
    actionEventIds: [],
    replanCount: 0,
  });
  socialSleeper.activeIntentId = socialEntryIntentId;
  const socialEntryContext = buildDecisionContexts(socialEntryState, 2)
    .find((context) => context.person.id === socialSleeper.id);
  const socialDehydrateOption = socialEntryContext.options
    .find((option) => option.nextAction.kind === 'act' && option.nextAction.operation === 'dehydrate');
  assert.ok(socialDehydrateOption, '强乱纪元必须为普通 active social intent 编译真实 dehydrate option');
  const planner = new RulePlanner();
  const socialDehydrateDecision = planner.decideAt({
    ...socialEntryContext, options: [socialDehydrateOption], followUpOptions: [],
  }, { atMonth: 2, planningTick: 1 });
  assert.equal(socialDehydrateDecision.kind, 'revise');
  assert.equal(socialDehydrateDecision.mode, 'interrupt', '普通 social intent 选择 dehydrate 时也必须走 survival interruption');
  assert.equal(socialDehydrateDecision.interruptionKind, 'survival-reflex');
  const forcedSocialHibernationPlanner = {
    decide(context) {
      if (context.person.id !== socialSleeper.id) return { kind: 'idle', reason: '不干扰社会意图休眠夹具' };
      const option = context.options.find((candidate) => candidate.nextAction.kind === 'act'
        && candidate.nextAction.operation === 'dehydrate');
      return option
        ? planner.decideAt({ ...context, options: [option], followUpOptions: [] }, {
          atMonth: context.state.clock.elapsedMonths + 1, planningTick: 1,
        })
        : { kind: 'idle', reason: '当前没有脱水休眠机会' };
    },
  };
  const afterSocialEntry = stepSimulation(socialEntryState, forcedSocialHibernationPlanner);
  const socialEpisode = afterSocialEntry.people.find((person) => person.id === socialSleeper.id)
    .conditions.find((condition) => condition.kind === 'dehydrated-hibernation');
  const queuedSocialIntent = afterSocialEntry.intents.find((intent) => intent.id === socialEntryIntentId);
  assert.ok(socialEpisode, '普通 social intent 中断必须执行真实 dehydrate 并建立 episode');
  assert.equal(queuedSocialIntent.status, 'suspended', '进入 episode 后原 social intent 必须暂停，不能被新意图 abandoned');
  assert.equal(queuedSocialIntent.suspendedForHibernationConditionId, socialEpisode.id,
    '原 social intent 必须绑定本月新建的同一 hibernation condition');
  assert.equal(afterSocialEntry.lastStep.some((event) => event.kind === 'decision'
    && event.who === socialSleeper.id
    && event.decision.kind === 'revise'
    && event.decision.mode === 'interrupt'
    && event.decision.interruptionKind === 'survival-reflex'), true,
  '实际规划链必须把 dehydrate 作为 survival interruption 提交');
  const socialEntryEventIds = afterSocialEntry.lastStep.map((event) => event.id);
  assert.equal(new Set(socialEntryEventIds).size, socialEntryEventIds.length,
    'advanceBodies 与 post-body hibernation suspension 合并后的权威事件 ID 必须全部唯一');
  assert.ok(afterSocialEntry.lastStep.some((event) => event.id
    === `e-${afterSocialEntry.clock.elapsedMonths}-environment-hibernation-suspension-${socialSleeper.id}`),
  'post-body suspension 事实必须使用人物级命名空间，不得与身体结算 condition-N 碰撞');

  const socialRecoveryState = structuredClone(afterSocialEntry);
  socialRecoveryState.civilization.era = {
    sequence: socialRecoveryState.civilization.era.sequence + 1,
    kind: 'stable',
    sinceMonth: socialRecoveryState.clock.elapsedMonths + 1,
    endsAtMonth: socialRecoveryState.clock.elapsedMonths + 6,
    dominantClimate: 'temperate',
  };
  socialRecoveryState.civilization.epoch = 'stable';
  socialRecoveryState.civilization.externalClimate = { epoch: 'stable', kind: 'temperate', severity: 0 };
  const socialRecoveryPerson = socialRecoveryState.people.find((person) => person.id === socialSleeper.id);
  const socialRecoveryWaterCell = socialRecoveryPerson.position.cellId % socialRecoveryState.world.grid.width < socialRecoveryState.world.grid.width - 1
    ? socialRecoveryPerson.position.cellId + 1
    : socialRecoveryPerson.position.cellId - 1;
  let socialRecoveryWaterZ = socialRecoveryState.world.grid.levels - 1;
  while (socialRecoveryWaterZ > 0
    && socialRecoveryState.world.grid.voxels[socialRecoveryWaterZ * socialRecoveryState.world.grid.width * socialRecoveryState.world.grid.depth + socialRecoveryWaterCell] === 0) socialRecoveryWaterZ -= 1;
  socialRecoveryState.world.grid.voxels[socialRecoveryWaterZ * socialRecoveryState.world.grid.width * socialRecoveryState.world.grid.depth + socialRecoveryWaterCell] = 7;
  const intentCountBeforeSocialRecovery = socialRecoveryState.intents.length;
  const socialRecoveryWithSource = stepSimulation(socialRecoveryState, forcedSocialHibernationPlanner);
  const socialRecoveryEpisode = socialRecoveryWithSource.people.find((person) => person.id === socialSleeper.id)
    .conditions.find((condition) => condition.kind === 'dehydrated-hibernation');
  assert.equal(socialRecoveryEpisode?.hibernationPhase, 'recovering');
  assert.ok((socialRecoveryEpisode?.recoverySourceEventIds?.length ?? 0) > 0,
    '普通 social intent 的恢复也必须先取得真实水源行动');
  assert.equal(socialRecoveryWithSource.intents.length, intentCountBeforeSocialRecovery,
    '普通 social episode 的 recovering 动作不得增加 intent 数量');
  const afterSocialRecoveryExit = stepSimulation(socialRecoveryWithSource, forcedSocialHibernationPlanner);
  const socialRecoveryExitFact = afterSocialRecoveryExit.lastStep.find((event) => event.kind === 'environment'
    && event.who === socialSleeper.id
    && event.diff.hibernationConditionId === socialEpisode.id
    && event.diff.exited === true);
  assert.equal(socialRecoveryExitFact?.diff.restoredIntentId, socialEntryIntentId,
    '普通 social parent 必须按同一 condition 恢复原 intent ID');
  assert.equal(afterSocialRecoveryExit.intents.find((intent) => intent.id === socialEntryIntentId)?.status, 'completed',
    '原 social intent 恢复后必须完成而不是保持 abandoned');
  assert.ok(afterSocialRecoveryExit.lastStep.some((event) => event.kind === 'action'
    && event.who === socialSleeper.id
    && event.action.kind === 'communicate'
    && event.action.content.id === socialEntryRepresentationId), '恢复后应继续执行原社会回应');

  const terminalLeafExitState = structuredClone(socialRecoveryWithSource);
  const terminalLeafPerson = terminalLeafExitState.people.find((person) => person.id === socialSleeper.id);
  const terminalLeafEpisode = terminalLeafPerson.conditions.find((condition) => condition.kind === 'dehydrated-hibernation');
  const terminalLeaf = terminalLeafExitState.intents.find((intent) => intent.id === socialEntryIntentId);
  const terminalLeafProjectId = 'test-terminal-hibernation-leaf-project';
  const terminalReturnParentId = 'test-terminal-hibernation-return-parent';
  terminalLeaf.projectId = terminalLeafProjectId;
  terminalLeaf.returnToIntentId = terminalReturnParentId;
  terminalLeaf.interruptionKind = 'life-review';
  terminalLeafExitState.projects.push({
    id: terminalLeafProjectId,
    kind: 'inquiry',
    need: 'terminal-leaf-test',
    desiredFunction: 'terminal-leaf-test',
    summary: '休眠期间已经完成的 leaf 项目',
    ownerId: terminalLeafPerson.id,
    beneficiaryIds: [terminalLeafPerson.id],
    triggerFactIds: ['test-terminal-leaf-project-fact'],
    pressure: 1,
    createdAtMonth: 0,
    reviewAtMonth: terminalLeafExitState.clock.elapsedMonths,
    status: 'completed',
    lastProgressAtMonth: terminalLeafExitState.clock.elapsedMonths,
    missingMaterialIds: [],
    materialDemands: [],
    reservations: [],
    contributorIds: [terminalLeafPerson.id],
    actionEventIds: [],
    failureEventIds: [],
    completionEventIds: [],
    progressEvidence: [],
    searchCampaigns: [],
    pressureHistory: [],
    logisticsEpisodes: [],
  });
  terminalLeafExitState.intents.push({
    id: terminalReturnParentId,
    ownerId: terminalLeafPerson.id,
    summary: 'terminal leaf 返回后继续原意图',
    domain: 'social',
    goal: { kind: 'at-cell', cellId: terminalLeafPerson.position.cellId },
    nextAction: { kind: 'move', toCellId: terminalLeafPerson.position.cellId, toZ: terminalLeafPerson.position.z },
    status: 'suspended',
    createdAtMonth: 0,
    lastProgressAtMonth: terminalLeafExitState.clock.elapsedMonths,
    progress: 0,
    plannedDurationMonths: 8,
    stateGoalUntilMonth: terminalLeafExitState.clock.elapsedMonths + 8,
    sourceDecisionEventId: 'test-terminal-return-parent-decision',
    suspendedByIntentId: terminalLeaf.id,
    suspendedAtMonth: terminalLeafExitState.clock.elapsedMonths,
    suspendedForHibernationConditionId: terminalLeafEpisode.id,
    sourceFactIds: ['test-terminal-return-parent-source'],
    actionEventIds: [],
    replanCount: 0,
  });
  const terminalIntentCount = terminalLeafExitState.intents.length;
  const afterTerminalLeafExit = stepSimulation(terminalLeafExitState, forcedSocialHibernationPlanner);
  const terminalLeafAfterExit = afterTerminalLeafExit.intents.find((intent) => intent.id === socialEntryIntentId);
  const terminalReturnParentAfterExit = afterTerminalLeafExit.intents.find((intent) => intent.id === terminalReturnParentId);
  assert.equal(terminalLeafAfterExit.status, 'completed', '安全退出时已 terminal 的 leaf project 必须映射为 completed');
  assert.equal(terminalLeafAfterExit.goalOutcome?.kind, 'achieved',
    '休眠退出旁路映射已完成项目时必须同步结算 Intent 目标结果');
  assert.equal(terminalLeafAfterExit.returnOutcome, 'resumed',
    '建立普通 context 前必须沿原 returnTo 边解析 terminal exact leaf');
  assert.equal(terminalReturnParentAfterExit.status, 'active',
    'terminal exact leaf 解析后必须恢复同一个 ancestor ID，不得留下 suspended orphan');
  assert.equal(terminalReturnParentAfterExit.suspendedByIntentId, undefined);
  assert.equal(afterTerminalLeafExit.people.find((person) => person.id === terminalLeafPerson.id).activeIntentId,
    terminalReturnParentId);
  assert.equal(afterTerminalLeafExit.intents.length, terminalIntentCount,
    '退出前 drain 只解析原 return chain，不得抢先新建普通意图');

  const projectSuspensionState = createInitialState(355, { endpoint: { kind: 'months', value: 20 }, chaosIntensity: 0 });
  projectSuspensionState.clock.elapsedMonths = 1;
  projectSuspensionState.civilization.epoch = 'chaotic';
  projectSuspensionState.civilization.climate = { kind: 'heat', severity: 8, sinceMonth: 1 };
  projectSuspensionState.civilization.externalClimate = { epoch: 'chaotic', kind: 'heat', severity: 8 };
  projectSuspensionState.people = [projectSuspensionState.people[0]];
  const projectOwner = projectSuspensionState.people[0];
  projectOwner.body = { health: 90, hydration: 90, nutrition: 90 };
  projectOwner.inventory = [];
  projectOwner.conditions = [{
    id: 'test-project-entry-heat', kind: 'heat', stage: 2, sinceMonth: 1, sourceEventIds: ['test-project-entry-exposure'],
  }];
  pushExposureFact(projectSuspensionState, projectOwner, 'test-project-entry-exposure', 'heat', 2, 1);
  projectSuspensionState.world.drops = [];
  projectSuspensionState.world.animals = [];
  for (let index = 0; index < projectSuspensionState.world.grid.voxels.length; index += 1) {
    const material = projectSuspensionState.world.grid.voxels[index];
    if (material === 7 || material === 9 || material === 10 || material === 11 || material === 12 || material === 18) {
      projectSuspensionState.world.grid.voxels[index] = material === 7 || material === 18 ? 1 : 8;
    }
  }
  const suspendedProjectId = 'test-hibernation-suspended-project';
  const projectParentIntentId = 'test-hibernation-project-parent';
  const nestedLeafIntentId = 'test-hibernation-existing-interruption-leaf';
  projectSuspensionState.projects.push({
    id: suspendedProjectId,
    kind: 'inquiry',
    need: 'iron-capability',
    desiredFunction: 'iron-tooling',
    summary: '验证休眠不会把长期项目误判为停滞',
    ownerId: projectOwner.id,
    beneficiaryIds: [projectOwner.id],
    triggerFactIds: ['test-project-pressure'],
    pressure: 100,
    createdAtMonth: 0,
    reviewAtMonth: 1,
    status: 'active',
    lastProgressAtMonth: 1,
    missingMaterialIds: [],
    materialDemands: [],
    reservations: [],
    contributorIds: [projectOwner.id],
    actionEventIds: [],
    failureEventIds: [],
    completionEventIds: [],
    progressEvidence: [],
    searchCampaigns: [],
    pressureHistory: [],
    logisticsEpisodes: [],
  });
  projectSuspensionState.intents.push({
    id: projectParentIntentId,
    ownerId: projectOwner.id,
    summary: '休眠后继续同一个长期项目',
    domain: 'strategic',
    goal: { kind: 'at-cell', cellId: projectOwner.position.cellId },
    nextAction: { kind: 'move', toCellId: projectOwner.position.cellId, toZ: projectOwner.position.z },
    status: 'suspended',
    createdAtMonth: 0,
    lastProgressAtMonth: 1,
    progress: 0.2,
    plannedDurationMonths: 20,
    stateGoalUntilMonth: 20,
    sourceDecisionEventId: 'test-project-parent-decision',
    projectId: suspendedProjectId,
    suspendedByIntentId: nestedLeafIntentId,
    suspendedAtMonth: 1,
    sourceFactIds: ['test-project-pressure'],
    actionEventIds: [],
    replanCount: 0,
  });
  projectSuspensionState.intents.push({
    id: nestedLeafIntentId,
    ownerId: projectOwner.id,
    summary: '休眠前已经存在的项目中断 leaf',
    domain: 'social',
    goal: { kind: 'at-cell', cellId: projectOwner.position.cellId },
    nextAction: { kind: 'move', toCellId: projectOwner.position.cellId, toZ: projectOwner.position.z },
    status: 'active',
    createdAtMonth: 1,
    lastProgressAtMonth: 1,
    progress: 0,
    sourceDecisionEventId: 'test-nested-leaf-decision',
    returnToIntentId: projectParentIntentId,
    interruptionKind: 'life-review',
    sourceFactIds: ['test-existing-interruption'],
    actionEventIds: [],
    replanCount: 0,
  });
  projectOwner.activeIntentId = nestedLeafIntentId;
  const projectEntryContext = buildDecisionContexts(projectSuspensionState, 2)
    .find((context) => context.person.id === projectOwner.id);
  const projectDehydrateOption = projectEntryContext.options
    .find((option) => option.nextAction.kind === 'act' && option.nextAction.operation === 'dehydrate');
  assert.ok(projectDehydrateOption, 'active project 的 nested leaf 必须能感知强乱纪元 dehydrate option');
  const projectDehydrateDecision = planner.decideAt({
    ...projectEntryContext, options: [projectDehydrateOption], followUpOptions: [],
  }, { atMonth: 2, planningTick: 1 });
  assert.equal(projectDehydrateDecision.kind, 'revise');
  assert.equal(projectDehydrateDecision.mode, 'interrupt');
  assert.equal(projectDehydrateDecision.interruptionKind, 'survival-reflex',
    'active project 链选择 dehydrate 时必须走现有 survival interruption');
  const forcedProjectHibernationPlanner = {
    decide(context) {
      if (context.person.id !== projectOwner.id) return { kind: 'idle', reason: '不干扰项目休眠夹具' };
      const option = context.options.find((candidate) => candidate.nextAction.kind === 'act'
        && candidate.nextAction.operation === 'dehydrate');
      return option
        ? planner.decideAt({ ...context, options: [option], followUpOptions: [] }, {
          atMonth: context.state.clock.elapsedMonths + 1, planningTick: 1,
        })
        : { kind: 'idle', reason: '当前没有脱水休眠机会' };
    },
  };
  let suspendedProjectState = stepSimulation(projectSuspensionState, forcedProjectHibernationPlanner);
  const projectEpisode = suspendedProjectState.people[0].conditions
    .find((condition) => condition.kind === 'dehydrated-hibernation');
  assert.ok(projectEpisode, '项目中断链必须通过真实 dehydrate 进入 episode');
  const projectParentAfterEntry = suspendedProjectState.intents.find((intent) => intent.id === projectParentIntentId);
  const nestedLeafAfterEntry = suspendedProjectState.intents.find((intent) => intent.id === nestedLeafIntentId);
  assert.equal(projectParentAfterEntry.status, 'suspended');
  assert.equal(projectParentAfterEntry.suspendedByIntentId, nestedLeafIntentId,
    '休眠 marker 不得破坏既有 nested returnTo / suspendedBy 拓扑');
  assert.equal(projectParentAfterEntry.suspendedAtMonth, 1,
    'episode 月度刷新不得覆盖 ancestor 原有的 interruption suspendedAtMonth');
  assert.equal(projectParentAfterEntry.suspendedForHibernationConditionId, projectEpisode.id,
    'project ancestor 必须用 condition marker 参与停滞豁免');
  assert.equal(nestedLeafAfterEntry.status, 'suspended');
  assert.equal(nestedLeafAfterEntry.suspendedForHibernationConditionId, projectEpisode.id);
  assert.equal(suspendedProjectState.projects.find((project) => project.id === suspendedProjectId)?.status, 'active',
    '进入休眠的当月不能把项目误判为 blocked');
  const intentsAfterProjectEntry = suspendedProjectState.intents.length;
  for (let month = 0; month < 5; month += 1) {
    suspendedProjectState = stepSimulation(suspendedProjectState, forcedProjectHibernationPlanner);
    const currentLeaf = suspendedProjectState.intents.find((intent) => intent.id === nestedLeafIntentId);
    const currentParent = suspendedProjectState.intents.find((intent) => intent.id === projectParentIntentId);
    assert.equal(suspendedProjectState.projects.find((project) => project.id === suspendedProjectId)?.status, 'active',
      '超过项目停滞窗口的 dormant 月仍必须保持原项目 active');
    assert.equal(suspendedProjectState.intents.length, intentsAfterProjectEntry,
      '连续 episode 每月只能刷新同一 intent marker，不能创建瞬时 hibernation child');
    assert.equal(currentLeaf.suspendedAtMonth, suspendedProjectState.clock.elapsedMonths,
      '同一 episode 每月只刷新 exact leaf 的 suspension anchor');
    assert.equal(currentParent.suspendedAtMonth, 1,
      '同一 episode 每月不得改写 ancestor 原有 suspension anchor');
    assert.equal(currentParent.suspendedByIntentId, nestedLeafIntentId,
      '长休眠期间必须保持原 nested interruption 拓扑');
  }

  suspendedProjectState.civilization.era = {
    sequence: suspendedProjectState.civilization.era.sequence + 1,
    kind: 'stable',
    sinceMonth: suspendedProjectState.clock.elapsedMonths + 1,
    endsAtMonth: suspendedProjectState.clock.elapsedMonths + 8,
    dominantClimate: 'temperate',
  };
  suspendedProjectState.civilization.epoch = 'stable';
  suspendedProjectState.civilization.externalClimate = { epoch: 'stable', kind: 'temperate', severity: 0 };
  suspendedProjectState = stepSimulation(suspendedProjectState, forcedProjectHibernationPlanner);
  suspendedProjectState = stepSimulation(suspendedProjectState, forcedProjectHibernationPlanner);
  assert.equal(suspendedProjectState.people[0].conditions
    .find((condition) => condition.kind === 'dehydrated-hibernation')?.hibernationPhase, 'recovering',
  '无资源的稳定月份只能进入并保持 recovering');
  assert.equal(suspendedProjectState.projects.find((project) => project.id === suspendedProjectId)?.status, 'active',
    '无资源 recovering 也不得累计为项目停滞');
  assert.equal(suspendedProjectState.intents.length, intentsAfterProjectEntry,
    '无资源 recovering 月不得创建瞬时 child intent');
  const projectRecoveryPerson = suspendedProjectState.people[0];
  const projectRecoveryWaterCell = projectRecoveryPerson.position.cellId % suspendedProjectState.world.grid.width < suspendedProjectState.world.grid.width - 1
    ? projectRecoveryPerson.position.cellId + 1
    : projectRecoveryPerson.position.cellId - 1;
  let projectRecoveryWaterZ = suspendedProjectState.world.grid.levels - 1;
  while (projectRecoveryWaterZ > 0
    && suspendedProjectState.world.grid.voxels[projectRecoveryWaterZ * suspendedProjectState.world.grid.width * suspendedProjectState.world.grid.depth + projectRecoveryWaterCell] === 0) projectRecoveryWaterZ -= 1;
  suspendedProjectState.world.grid.voxels[projectRecoveryWaterZ * suspendedProjectState.world.grid.width * suspendedProjectState.world.grid.depth + projectRecoveryWaterCell] = 7;
  suspendedProjectState = stepSimulation(suspendedProjectState, forcedProjectHibernationPlanner);
  const sourcedProjectEpisode = suspendedProjectState.people[0].conditions
    .find((condition) => condition.kind === 'dehydrated-hibernation');
  assert.ok((sourcedProjectEpisode?.recoverySourceEventIds?.length ?? 0) > 0,
    '项目恢复链必须先取得真实 source-backed ingest');
  assert.equal(suspendedProjectState.intents.length, intentsAfterProjectEntry,
    'source-backed recovering 动作也不得创建瞬时 child intent');
  const afterProjectRecoveryExit = stepSimulation(suspendedProjectState, forcedProjectHibernationPlanner);
  const projectExitFact = afterProjectRecoveryExit.lastStep.find((event) => event.kind === 'environment'
    && event.who === projectOwner.id
    && event.diff.hibernationConditionId === projectEpisode.id
    && event.diff.exited === true);
  assert.equal(projectExitFact?.diff.restoredIntentId, nestedLeafIntentId,
    '退出必须先恢复休眠时 exact active leaf，而不是错误激活 ancestor');
  assert.equal(afterProjectRecoveryExit.intents.find((intent) => intent.id === nestedLeafIntentId)?.status, 'completed',
    'exact leaf 恢复后应沿既有 returnTo 边自然完成');
  assert.equal(afterProjectRecoveryExit.intents.find((intent) => intent.id === projectParentIntentId)?.status, 'active',
    'nested leaf 完成后必须恢复同一个 project parent ID');
  assert.equal(afterProjectRecoveryExit.people[0].activeIntentId, projectParentIntentId);
  assert.equal(afterProjectRecoveryExit.projects.find((project) => project.id === suspendedProjectId)?.status, 'active');
  assert.ok(afterProjectRecoveryExit.intents
    .filter((intent) => intent.ownerId === projectOwner.id)
    .every((intent) => intent.suspendedForHibernationConditionId === undefined),
  'episode 退出后必须清除整条 nested chain 的 condition marker');

  const deathBeforeSyncState = createInitialState(356, { endpoint: { kind: 'months', value: 4 }, chaosIntensity: 0 });
  deathBeforeSyncState.people = [deathBeforeSyncState.people[0]];
  const deathBeforeSyncPerson = deathBeforeSyncState.people[0];
  deathBeforeSyncPerson.body = { health: 0, hydration: 60, nutrition: 60 };
  deathBeforeSyncPerson.conditions = [{
    id: 'test-same-month-entry-before-death',
    kind: 'dehydrated-hibernation',
    stage: 1,
    sinceMonth: 2,
    sourceEventIds: ['test-same-month-dehydrate'],
    hibernationPhase: 'dormant',
  }];
  const deathBeforeSyncParentId = 'test-parent-before-same-month-death';
  const deathBeforeSyncIntentId = 'test-intent-before-same-month-death';
  deathBeforeSyncState.intents.push({
    id: deathBeforeSyncParentId,
    ownerId: deathBeforeSyncPerson.id,
    summary: '同月死亡前已被 active leaf 中断的 parent',
    domain: 'strategic',
    goal: { kind: 'at-cell', cellId: deathBeforeSyncPerson.position.cellId },
    nextAction: { kind: 'move', toCellId: deathBeforeSyncPerson.position.cellId },
    status: 'suspended',
    createdAtMonth: 0,
    lastProgressAtMonth: 0,
    progress: 0,
    sourceDecisionEventId: 'test-parent-before-death-decision',
    suspendedByIntentId: deathBeforeSyncIntentId,
    suspendedAtMonth: 1,
    actionEventIds: [],
    replanCount: 0,
  }, {
    id: deathBeforeSyncIntentId,
    ownerId: deathBeforeSyncPerson.id,
    summary: '死亡结算前仍 active 的意图',
    domain: 'social',
    goal: { kind: 'at-cell', cellId: deathBeforeSyncPerson.position.cellId },
    nextAction: { kind: 'move', toCellId: deathBeforeSyncPerson.position.cellId },
    status: 'active',
    createdAtMonth: 1,
    lastProgressAtMonth: 1,
    progress: 0,
    sourceDecisionEventId: 'test-before-death-decision',
    returnToIntentId: deathBeforeSyncParentId,
    interruptionKind: 'life-review',
    actionEventIds: [],
    replanCount: 0,
  });
  deathBeforeSyncPerson.activeIntentId = deathBeforeSyncIntentId;
  const deathSettlementFacts = advanceBodies(deathBeforeSyncState, 2);
  assert.ok(deathSettlementFacts.some((event) => event.change === 'death' && event.who === deathBeforeSyncPerson.id),
    '夹具必须先完成真实死亡结算');
  const postDeathSuspensionFacts = synchronizeHibernationIntentSuspensions(deathBeforeSyncState, 2);
  const intentAfterDeathBeforeSync = deathBeforeSyncState.intents.find((intent) => intent.id === deathBeforeSyncIntentId);
  const parentAfterDeathBeforeSync = deathBeforeSyncState.intents.find((intent) => intent.id === deathBeforeSyncParentId);
  assert.equal(postDeathSuspensionFacts.length, 0, 'post-body hibernation sync 必须跳过当月已死亡人物');
  assert.equal(intentAfterDeathBeforeSync.status, 'failed', '死亡结算必须先把原 active intent 置为 failed');
  assert.equal(intentAfterDeathBeforeSync.goalOutcome?.kind, 'not-evaluated',
    '死亡前没有实际行动样本时，active intent 必须结算为未评估而不是污染目标失败后验');
  assert.ok(intentAfterDeathBeforeSync.goalOutcome?.sourceEventIds.some((eventId) => eventId.includes('-environment-death-')),
    '死亡旁路的 goalOutcome 必须引用真实死亡事实');
  assert.equal(intentAfterDeathBeforeSync.suspendedForHibernationConditionId, undefined,
    '当月死亡不得留下 hibernation-suspended orphan intent');
  assert.equal(intentAfterDeathBeforeSync.returnOutcome, 'parent-unavailable',
    '当月死亡必须终结 active leaf 的 return 边');
  assert.equal(parentAfterDeathBeforeSync.status, 'failed', '当月死亡必须同时终结尚未加 marker 的 suspended ancestor');
  assert.equal(parentAfterDeathBeforeSync.goalOutcome?.kind, 'not-evaluated',
    '死亡时没有行动样本的 suspended ancestor 也必须显式结算为未评估');
  assert.equal(parentAfterDeathBeforeSync.suspendedByIntentId, undefined,
    '当月死亡不得留下指向已死亡 leaf 的 suspendedBy orphan');
  assert.equal(deathBeforeSyncPerson.activeIntentId, undefined);

  const ordinaryInterruptedDeathState = createInitialState(359, { endpoint: { kind: 'months', value: 4 }, chaosIntensity: 0 });
  ordinaryInterruptedDeathState.people = [ordinaryInterruptedDeathState.people[0]];
  const ordinaryInterruptedDeathPerson = ordinaryInterruptedDeathState.people[0];
  ordinaryInterruptedDeathPerson.body = { health: 0, hydration: 60, nutrition: 60 };
  ordinaryInterruptedDeathPerson.conditions = [];
  const ordinaryInterruptedParentId = 'test-ordinary-interrupted-parent-before-death';
  const ordinaryInterruptedChildId = 'test-ordinary-interruption-child-before-death';
  ordinaryInterruptedDeathState.intents.push({
    id: ordinaryInterruptedParentId,
    ownerId: ordinaryInterruptedDeathPerson.id,
    summary: '普通中断期间暂停的 parent',
    domain: 'strategic',
    goal: { kind: 'at-cell', cellId: ordinaryInterruptedDeathPerson.position.cellId },
    nextAction: { kind: 'move', toCellId: ordinaryInterruptedDeathPerson.position.cellId },
    status: 'suspended',
    createdAtMonth: 0,
    lastProgressAtMonth: 0,
    progress: 0,
    sourceDecisionEventId: 'test-ordinary-interrupted-parent-decision',
    suspendedByIntentId: ordinaryInterruptedChildId,
    suspendedAtMonth: 1,
    actionEventIds: [],
    replanCount: 0,
  }, {
    id: ordinaryInterruptedChildId,
    ownerId: ordinaryInterruptedDeathPerson.id,
    summary: '普通 required-response 中断 child',
    domain: 'social',
    goal: { kind: 'at-cell', cellId: ordinaryInterruptedDeathPerson.position.cellId },
    nextAction: { kind: 'move', toCellId: ordinaryInterruptedDeathPerson.position.cellId },
    status: 'active',
    createdAtMonth: 1,
    lastProgressAtMonth: 1,
    progress: 0,
    sourceDecisionEventId: 'test-ordinary-interruption-child-decision',
    returnToIntentId: ordinaryInterruptedParentId,
    interruptionKind: 'required-response',
    actionEventIds: [],
    replanCount: 0,
  });
  ordinaryInterruptedDeathPerson.activeIntentId = ordinaryInterruptedChildId;
  const ordinaryInterruptedDeathFacts = advanceBodies(ordinaryInterruptedDeathState, 2);
  const ordinaryInterruptedChild = ordinaryInterruptedDeathState.intents
    .find((intent) => intent.id === ordinaryInterruptedChildId);
  const ordinaryInterruptedParent = ordinaryInterruptedDeathState.intents
    .find((intent) => intent.id === ordinaryInterruptedParentId);
  assert.ok(ordinaryInterruptedDeathFacts.some((event) => event.change === 'death'),
    '普通中断夹具必须完成真实死亡结算');
  assert.equal(ordinaryInterruptedChild.status, 'failed');
  assert.equal(ordinaryInterruptedChild.goalOutcome?.kind, 'not-evaluated');
  assert.equal(ordinaryInterruptedChild.returnOutcome, 'parent-unavailable',
    '普通中断 child 死亡也必须显式终结 return 边');
  assert.equal(ordinaryInterruptedChild.returnResolvedAtMonth, 2);
  assert.equal(ordinaryInterruptedParent.status, 'failed',
    'owner 死亡必须终结所有普通 suspended parent，而不只处理休眠链');
  assert.equal(ordinaryInterruptedParent.goalOutcome?.kind, 'not-evaluated');
  assert.equal(ordinaryInterruptedParent.suspendedByIntentId, undefined,
    '普通中断 parent 不得留下指向死亡 child 的孤儿边');
  assert.equal(ordinaryInterruptedDeathPerson.activeIntentId, undefined);

  const deathDuringSuspensionState = createInitialState(357, { endpoint: { kind: 'months', value: 4 }, chaosIntensity: 0 });
  deathDuringSuspensionState.people = [deathDuringSuspensionState.people[0]];
  const deathDuringSuspensionPerson = deathDuringSuspensionState.people[0];
  deathDuringSuspensionPerson.body = { health: 0, hydration: 20, nutrition: 20 };
  deathDuringSuspensionPerson.conditions = [{
    id: 'test-death-during-suspended-episode',
    kind: 'dehydrated-hibernation',
    stage: 3,
    sinceMonth: 0,
    sourceEventIds: ['test-old-dehydrate'],
    hibernationPhase: 'dormant',
  }];
  const deathDuringSuspensionIntentId = 'test-already-suspended-intent-before-death';
  deathDuringSuspensionState.intents.push({
    id: deathDuringSuspensionIntentId,
    ownerId: deathDuringSuspensionPerson.id,
    summary: '休眠中死亡前已经暂停的意图',
    domain: 'strategic',
    goal: { kind: 'at-cell', cellId: deathDuringSuspensionPerson.position.cellId },
    nextAction: { kind: 'move', toCellId: deathDuringSuspensionPerson.position.cellId },
    status: 'suspended',
    createdAtMonth: 0,
    lastProgressAtMonth: 0,
    progress: 0,
    sourceDecisionEventId: 'test-old-intent-decision',
    suspendedAtMonth: 1,
    suspendedForHibernationConditionId: 'test-death-during-suspended-episode',
    actionEventIds: [],
    replanCount: 0,
  });
  const deathDuringSuspensionFacts = advanceBodies(deathDuringSuspensionState, 2);
  const failedSuspendedIntent = deathDuringSuspensionState.intents
    .find((intent) => intent.id === deathDuringSuspensionIntentId);
  assert.equal(failedSuspendedIntent.status, 'failed', 'episode 中死亡必须把已暂停意图终结为 failed');
  assert.equal(failedSuspendedIntent.goalOutcome?.kind, 'not-evaluated',
    '休眠中死亡且没有行动样本时必须留下未评估的目标结果');
  assert.equal(failedSuspendedIntent.suspendedForHibernationConditionId, undefined,
    'episode 中死亡必须清除 condition marker，不能留下 suspended orphan');
  assert.ok(deathDuringSuspensionFacts.some((event) => event.change === 'death'
    && event.diff.hibernationFailedIntentIds?.includes(deathDuringSuspensionIntentId)),
  '死亡事实必须记录被终结的 hibernation intent ID');

  const postExitDeathState = createInitialState(358, { endpoint: { kind: 'months', value: 4 }, chaosIntensity: 0 });
  postExitDeathState.people = [postExitDeathState.people[0]];
  const postExitDeathPerson = postExitDeathState.people[0];
  postExitDeathPerson.body = { health: 0, hydration: 60, nutrition: 60 };
  postExitDeathPerson.conditions = [];
  const postExitAncestorId = 'test-post-exit-death-ancestor';
  const postExitLeafId = 'test-post-exit-death-leaf';
  postExitDeathState.intents.push({
    id: postExitAncestorId,
    ownerId: postExitDeathPerson.id,
    summary: '安全退出时仍等待 leaf 返回的 ancestor',
    domain: 'strategic',
    goal: { kind: 'at-cell', cellId: postExitDeathPerson.position.cellId },
    nextAction: { kind: 'move', toCellId: postExitDeathPerson.position.cellId },
    status: 'suspended',
    createdAtMonth: 0,
    lastProgressAtMonth: 0,
    lastResumedAtMonth: 2,
    lastHibernationResumedAtMonth: 2,
    progress: 0,
    sourceDecisionEventId: 'test-post-exit-ancestor-decision',
    suspendedByIntentId: postExitLeafId,
    suspendedAtMonth: 0,
    actionEventIds: [],
    replanCount: 0,
  }, {
    id: postExitLeafId,
    ownerId: postExitDeathPerson.id,
    summary: '安全退出后刚恢复但尚未返回的 exact leaf',
    domain: 'social',
    goal: { kind: 'at-cell', cellId: postExitDeathPerson.position.cellId + 1 },
    nextAction: { kind: 'move', toCellId: postExitDeathPerson.position.cellId + 1 },
    status: 'active',
    createdAtMonth: 1,
    lastProgressAtMonth: 1,
    lastResumedAtMonth: 2,
    lastHibernationResumedAtMonth: 2,
    progress: 0,
    sourceDecisionEventId: 'test-post-exit-leaf-decision',
    returnToIntentId: postExitAncestorId,
    interruptionKind: 'life-review',
    actionEventIds: [],
    replanCount: 0,
  });
  postExitDeathPerson.activeIntentId = postExitLeafId;
  const postExitDeathFacts = advanceBodies(postExitDeathState, 2);
  const postExitFailedLeaf = postExitDeathState.intents.find((intent) => intent.id === postExitLeafId);
  const postExitFailedAncestor = postExitDeathState.intents.find((intent) => intent.id === postExitAncestorId);
  assert.equal(postExitFailedLeaf.status, 'failed', '安全退出同月死亡必须终结刚恢复的 exact leaf');
  assert.equal(postExitFailedLeaf.returnOutcome, 'parent-unavailable');
  assert.equal(postExitFailedAncestor.status, 'failed', '安全退出同月死亡必须沿 returnTo 终结同月恢复的 ancestor');
  assert.equal(postExitFailedAncestor.suspendedByIntentId, undefined,
    '安全退出同月死亡不得留下已清 marker 的 suspended ancestor orphan');
  assert.ok(postExitDeathFacts.some((event) => event.change === 'death'
    && event.diff.hibernationFailedIntentIds?.includes(postExitLeafId)
    && event.diff.hibernationFailedIntentIds?.includes(postExitAncestorId)),
  '同月退出死亡事实必须列出 exact leaf 与 ancestor 的终结 ID');

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

  const afterStableRecovery = stepSimulation(afterFullHibernation, {
    decide() { return { kind: 'idle', reason: '等待新恒纪元提供苏醒条件' }; },
  });
  assert.equal(afterStableRecovery.civilization.status, 'running', '跨纪元进入恢复阶段后文明应继续运行');
  assert.ok(afterStableRecovery.people.every((person) => person.conditions.some((condition) => condition.kind === 'dehydrated-hibernation'
    && condition.hibernationPhase === 'recovering')),
  '新恒纪元只能把全体旧 episode 转入 recovering，不能在同一月自动退出');
  assert.equal(afterStableRecovery.world.past.some((event) => event.kind === 'environment'
    && event.diff.condition === 'dehydrated-hibernation'
    && event.diff.exited === true), false,
  '刚进入恢复阶段时不得产生无来源退出事实');

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
