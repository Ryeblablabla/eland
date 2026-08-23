import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-agent-cognition-test-'));
const bundlePath = path.join(temporaryDirectory, 'agent-cognition.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export {
      actionFactOutcomeBasisKey,
      causalMemoryTraceForAction,
      cognitionStateOf,
      createCognitionState,
      goalOutcomeBeliefFor,
      goalOutcomeBeliefSuccess,
      outcomeBeliefFor,
      outcomeBeliefSuccess,
      recordActionOutcomeBelief,
      recordIntentGoalOutcome,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/cognition.ts'))};
    export { evaluateCognitiveOption } from ${JSON.stringify(path.resolve('src/game/eland/application/cognition/option-appraisal.ts'))};
    export { assessFamilyReadiness } from ${JSON.stringify(path.resolve('src/game/eland/application/cognition/family-readiness.ts'))};
    export { applyDecision } from ${JSON.stringify(path.resolve('src/game/eland/application/simulation/intent-execution.ts'))};
    export { findReachableShelter } from ${JSON.stringify(path.resolve('src/game/eland/domain/shelter-access.ts'))};
    export { deriveNeedAgenda } from ${JSON.stringify(path.resolve('src/game/eland/application/cognition/need-agenda.ts'))};
    export { completeProject } from ${JSON.stringify(path.resolve('src/game/eland/application/projects/project-lifecycle.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.resolve('src/game/eland/domain/project.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export {
      assessIntentionPersistence,
      rankCognitiveOptions,
    } from ${JSON.stringify(path.resolve('src/game/eland/application/cognition/bdi-deliberation.ts'))};
    export { validateModelDecision } from ${JSON.stringify(path.resolve('src/game/eland/application/simulation/model-review.ts'))};
    export { cellX, cellY, neighbors4, setVoxel, voxelWorldRevision } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=agent-cognition-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    actionFactOutcomeBasisKey,
    applyDecision,
    assessFamilyReadiness,
    assessIntentionPersistence,
    causalMemoryTraceForAction,
    cellX,
    cellY,
    cognitionStateOf,
    createCognitionState,
    createInitialState,
    completeProject,
    deriveNeedAgenda,
    evaluateCognitiveOption,
    findReachableShelter,
    goalOutcomeBeliefFor,
    goalOutcomeBeliefSuccess,
    instantiateProject,
    Material,
    neighbors4,
    outcomeBeliefFor,
    outcomeBeliefSuccess,
    rankCognitiveOptions,
    recordActionOutcomeBelief,
    recordIntentGoalOutcome,
    setVoxel,
    validateModelDecision,
    voxelWorldRevision,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const moment = { atMonth: 12, planningTick: 4 };

  function makeContext(state, person, options, activeIntent, visiblePeople = []) {
    return {
      state,
      person,
      visibleCells: [person.position.cellId],
      visiblePeople,
      visibleDrops: [],
      visibleAnimals: [],
      options,
      followUpOptions: [],
      ...(activeIntent ? { activeIntent } : {}),
    };
  }

  function rebaseSyntheticPhysicalIndex(state) {
    if (state.world.physicalStructureIndex) {
      state.world.physicalStructureIndex.voxelRevision = voxelWorldRevision(state.world.grid);
    }
  }

  function makeIntent(person, overrides = {}) {
    return {
      id: 'cognition-test-intent',
      ownerId: person.id,
      summary: '验证个人结果学习',
      domain: 'strategic',
      goal: { kind: 'knowledge', factId: 'cognition-test-observation' },
      nextAction: {
        kind: 'attend',
        target: {
          kind: 'voxel',
          position: {
            x: cellX(person.position.cellId),
            y: cellY(person.position.cellId),
            z: person.position.z,
          },
        },
      },
      status: 'active',
      createdAtMonth: 10,
      lastProgressAtMonth: 11,
      progress: 0.25,
      sourceFactIds: ['cognition-test-observation'],
      actionEventIds: [],
      replanCount: 0,
      ...overrides,
    };
  }

  function makeActionFact(person, intent, overrides = {}) {
    return {
      id: 'cognition-action-fact',
      kind: 'action',
      atMonth: moment.atMonth,
      orderInMonth: 1,
      planningTick: moment.planningTick,
      orderInTick: 1,
      cellId: person.position.cellId,
      actionTick: moment.planningTick,
      who: person.id,
      intentId: intent.id,
      cause: 'intent',
      action: structuredClone(intent.nextAction),
      fromCellId: person.position.cellId,
      toCellId: person.position.cellId,
      fromZ: person.position.z,
      toZ: person.position.z,
      pathSegment: [person.position.cellId],
      status: 'completed',
      result: '形成了可回放的亲历结果',
      diff: {},
      ...overrides,
    };
  }

  // Personal reserve needs keep food and water deficits separate. A person
  // carrying abundant food but no portable water must not treat more food as
  // the answer to either the water reserve gap or low hydration.
  const reserveState = createInitialState(26082007, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const reservePerson = reserveState.people[0];
  reservePerson.inventory = [{
    id: 'reserve-surplus-food',
    materialId: Material.Food,
    quantity: 100,
    sourceEventIds: ['reserve-surplus-food-source'],
  }];
  reservePerson.body = { health: 90, hydration: 42, nutrition: 90 };
  const surplusFoodOption = {
    id: 'reserve-test-more-food',
    summary: '继续取得食物',
    reason: '测试食物不能替代饮水缺口',
    goal: { kind: 'inventory-at-least', materialId: Material.Food, quantity: 102 },
    nextAction: { kind: 'move', toCellId: reservePerson.position.cellId },
    estimatedDuration: 'one-month',
    sourceFactIds: [],
  };
  const portableWaterOption = {
    id: 'reserve-test-water',
    summary: '取得可携带饮水',
    reason: '测试饮水候选匹配饮水缺口',
    goal: { kind: 'inventory-at-least', materialId: Material.Water, quantity: 1 },
    nextAction: { kind: 'move', toCellId: reservePerson.position.cellId },
    estimatedDuration: 'one-month',
    sourceFactIds: [],
  };
  const reserveContext = makeContext(reserveState, reservePerson, [surplusFoodOption, portableWaterOption]);
  const reserveAgenda = deriveNeedAgenda(reserveContext, moment.atMonth);
  assert.equal(reserveAgenda.some((need) => need.kind === 'reserve' && need.resource === 'food'), false,
    '一百份随身食物必须关闭个人食物储备缺口');
  assert.ok(reserveAgenda.some((need) => need.kind === 'reserve' && need.resource === 'water'),
    '没有可携带饮水时必须保留独立的饮水储备缺口');
  const surplusFoodAppraisal = evaluateCognitiveOption(reserveContext, surplusFoodOption, moment, reserveAgenda);
  const portableWaterAppraisal = evaluateCognitiveOption(reserveContext, portableWaterOption, moment, reserveAgenda);
  assert.equal(surplusFoodAppraisal.addressedNeeds.some((need) => need.kind === 'reserve'), false,
    '食物候选不得认领饮水储备需要');
  assert.equal(surplusFoodAppraisal.needAlignments.some((alignment) => alignment.kind === 'homeostasis'), false,
    '低水分不得给食物候选添加身体恢复对齐');
  assert.ok(portableWaterAppraisal.addressedNeeds.some((need) => need.kind === 'reserve' && need.resource === 'water'),
    '饮水候选必须精确认领饮水储备需要');
  assert.ok(portableWaterAppraisal.needActivation > surplusFoodAppraisal.needActivation,
    '高粮缺水时饮水候选的需要激活必须高于继续取食');

  const reserveStorageOption = {
    id: 'reserve-test-storage-project',
    summary: '建立公共食物储备设施',
    reason: '测试项目压力只能由同一项目候选认领',
    goal: { kind: 'project-completed', projectId: 'reserve-test-storage-project' },
    nextAction: { kind: 'move', toCellId: reservePerson.position.cellId },
    estimatedDuration: 'long',
    sourceFactIds: ['reserve-storage-pressure-source'],
    projectProposal: {
      id: 'reserve-test-storage-project',
      kind: 'construction',
      need: 'reserve-security',
      desiredFunction: 'reserve-storage',
      summary: '建立公共食物储备设施',
      ownerId: reservePerson.id,
      beneficiaryIds: [reservePerson.id],
      triggerFactIds: ['reserve-storage-pressure-source'],
      pressure: 90,
      createdAtMonth: moment.atMonth,
      reviewAtMonth: moment.atMonth + 23,
    },
    projectPressure: 90,
  };
  const scopedReserveContext = makeContext(
    reserveState,
    reservePerson,
    [surplusFoodOption, portableWaterOption, reserveStorageOption],
  );
  const scopedReserveAgenda = deriveNeedAgenda(scopedReserveContext, moment.atMonth);
  const scopedFoodAppraisal = evaluateCognitiveOption(
    scopedReserveContext,
    surplusFoodOption,
    moment,
    scopedReserveAgenda,
  );
  const storageAppraisal = evaluateCognitiveOption(
    scopedReserveContext,
    reserveStorageOption,
    moment,
    scopedReserveAgenda,
  );
  assert.equal(scopedFoodAppraisal.addressedNeeds.some((need) => need.projectId === reserveStorageOption.projectProposal.id), false,
    '普通采食候选不得冒领公共储备项目压力');
  assert.ok(storageAppraisal.addressedNeeds.some((need) => need.projectId === reserveStorageOption.projectProposal.id),
    '只有同一项目候选可以认领项目来源的储备压力');

  const sourcedConversationOption = {
    id: 'conversation:source-without-need',
    summary: '复述一个有来源但当前没有对应需要的事实',
    reason: '测试来源只证明候选有依据，不能凭空制造欲望',
    goal: { kind: 'representation-made', representationId: 'source-without-need' },
    nextAction: {
      kind: 'communicate',
      content: { id: 'source-without-need', kind: 'claim', summary: '我记得这件事' },
      audience: [], channel: 'voice',
    },
    estimatedDuration: 'one-month',
    sourceFactIds: ['e-0-environment-founding-0'],
    domain: 'social',
  };
  const sourceOnlyContext = makeContext(reserveState, reservePerson, [sourcedConversationOption]);
  const sourceOnlyAppraisal = evaluateCognitiveOption(sourceOnlyContext, sourcedConversationOption, moment);
  assert.equal(sourceOnlyAppraisal.needActivation, 0,
    '一个来源事实只能证明候选有依据，不能在没有归属、照护、探索或承诺需要时制造通用动机');
  assert.equal(sourceOnlyAppraisal.motivation, 0,
    '没有对应需要的有来源聊天不得仅凭 sourceFactIds 越过行动阈值');

  const mixedBodyState = structuredClone(reserveState);
  const mixedBodyPerson = mixedBodyState.people[0];
  mixedBodyPerson.body = { health: 90, hydration: 10, nutrition: 54 };
  const mixedBodyContext = makeContext(mixedBodyState, mixedBodyPerson, [surplusFoodOption, portableWaterOption]);
  const mixedBodyAgenda = deriveNeedAgenda(mixedBodyContext, moment.atMonth);
  const mixedFoodAppraisal = evaluateCognitiveOption(mixedBodyContext, surplusFoodOption, moment, mixedBodyAgenda);
  const mixedWaterAppraisal = evaluateCognitiveOption(mixedBodyContext, portableWaterOption, moment, mixedBodyAgenda);
  assert.equal(mixedFoodAppraisal.needAlignments.some((alignment) => alignment.kind === 'homeostasis'), false,
    '已有大量可摄入食物时，继续采食不得认领营养或更严重的缺水压力');
  assert.ok(mixedWaterAppraisal.addressedNeeds.some((need) => need.kind === 'homeostasis' && need.bodyField === 'hydration'),
    '缺水候选必须只认领 hydration 身体缺口');
  assert.ok(mixedWaterAppraisal.needActivation > mixedFoodAppraisal.needActivation,
    '严重缺水与轻微低营养并存且食物充足时，取水必须压过继续采食');

  // A Beta posterior must move in the direction of replayable outcomes, while
  // semantically different goal bases remain isolated from one another.
  const beliefState = createInitialState(26082001, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const learner = beliefState.people[0];
  learner.cognition = createCognitionState();
  const observationIntent = makeIntent(learner);
  const shelterIntent = makeIntent(learner, {
    id: 'cognition-test-shelter-intent',
    summary: '寻找庇护',
    goal: { kind: 'sheltered' },
  });
  beliefState.intents = [observationIntent, shelterIntent];

  const firstSuccess = makeActionFact(learner, observationIntent, { id: 'cognition-success-1' });
  const observationBasis = actionFactOutcomeBasisKey(beliefState, firstSuccess);
  recordActionOutcomeBelief(beliefState, firstSuccess);
  const successBelief = outcomeBeliefFor(learner, observationBasis);
  assert.ok(successBelief, '成功行动应建立个人 OutcomeBelief');
  assert.equal(successBelief.attempts, 1);
  assert.equal(successBelief.completed, 1);
  assert.ok(outcomeBeliefSuccess(successBelief) > 0.5, '成功事实应把后验成功率推高到先验以上');
  const successPosterior = outcomeBeliefSuccess(successBelief);

  const isolatedFailure = makeActionFact(learner, shelterIntent, {
    id: 'cognition-failure-isolated',
    status: 'failed',
    result: '相同行动形式没有完成另一类目标',
  });
  const shelterBasis = actionFactOutcomeBasisKey(beliefState, isolatedFailure);
  assert.notEqual(shelterBasis, observationBasis, '同一动作形式服务不同目标时必须使用不同学习 basis');
  recordActionOutcomeBelief(beliefState, isolatedFailure);
  assert.equal(outcomeBeliefSuccess(outcomeBeliefFor(learner, observationBasis)), successPosterior,
    '另一目标的失败不得污染原目标的成功后验');
  assert.ok(outcomeBeliefSuccess(outcomeBeliefFor(learner, shelterBasis)) < 0.5,
    '失败事实应把对应 basis 的后验成功率压到先验以下');

  const sameBasisFailure = makeActionFact(learner, observationIntent, {
    id: 'cognition-failure-same-basis',
    status: 'failed',
    result: '相似观察后来失败',
  });
  recordActionOutcomeBelief(beliefState, sameBasisFailure);
  const revisedObservationBelief = outcomeBeliefFor(learner, observationBasis);
  assert.equal(revisedObservationBelief.attempts, 2);
  assert.equal(revisedObservationBelief.failed, 1);
  assert.ok(outcomeBeliefSuccess(revisedObservationBelief) < successPosterior,
    '同 basis 的失败应下修此前的成功预期');
  assert.equal(cognitionStateOf(learner).outcomeBeliefs.length, 2,
    '夹具只应形成两个语义学习 basis');

  const noDisplacementIntent = makeIntent(learner, {
    id: 'cognition-test-no-displacement-intent',
    summary: '原地移动记账',
    goal: { kind: 'at-cell', cellId: learner.position.cellId },
    nextAction: { kind: 'move', toCellId: learner.position.cellId, toZ: learner.position.z },
  });
  beliefState.intents.push(noDisplacementIntent);
  const noDisplacementFact = makeActionFact(learner, noDisplacementIntent, {
    id: 'cognition-no-displacement-bookkeeping',
    status: 'completed',
    result: '行动记账完成但人物没有离开原位置',
    fromCellId: learner.position.cellId,
    toCellId: learner.position.cellId,
    fromZ: learner.position.z,
    toZ: learner.position.z,
    pathSegment: [learner.position.cellId],
  });
  const noDisplacementBasis = actionFactOutcomeBasisKey(beliefState, noDisplacementFact);
  const beliefCountBeforeNoDisplacement = cognitionStateOf(learner).outcomeBeliefs.length;
  recordActionOutcomeBelief(beliefState, noDisplacementFact);
  assert.equal(cognitionStateOf(learner).outcomeBeliefs.length, beliefCountBeforeNoDisplacement,
    '同格同高度 move 只是 bookkeeping，不得创建或增加 OutcomeBelief');
  assert.equal(outcomeBeliefFor(learner, noDisplacementBasis), undefined,
    '无位移 move 的对应 basis 不得进入个人学习集合');

  // The cognition layer receives an already legal/local candidate. Holding
  // that candidate and world facts constant isolates personality modulation.
  const personalityBase = createInitialState(26082002, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const inquiryPerson = personalityBase.people[0];
  inquiryPerson.bornAtMonth = -20 * 12;
  inquiryPerson.cognition = createCognitionState();
  const inquiryIntent = makeIntent(inquiryPerson);
  const inquiryOption = {
    id: 'cognition-test:inspect-local-voxel',
    summary: '检查眼前材料的性质',
    reason: '一个当前可见的异常留下了具体未知点',
    goal: structuredClone(inquiryIntent.goal),
    nextAction: structuredClone(inquiryIntent.nextAction),
    estimatedDuration: 'one-month',
    estimatedMonths: 1,
    sourceFactIds: ['cognition-test-observation'],
  };

  const highOpennessState = structuredClone(personalityBase);
  const lowOpennessState = structuredClone(personalityBase);
  const highOpenness = highOpennessState.people[0];
  const lowOpenness = lowOpennessState.people[0];
  highOpenness.personality.baseline.openness = 90;
  lowOpenness.personality.baseline.openness = 10;
  const highContext = makeContext(highOpennessState, highOpenness, [inquiryOption]);
  const lowContext = makeContext(lowOpennessState, lowOpenness, [inquiryOption]);
  const highAppraisal = evaluateCognitiveOption(highContext, inquiryOption, moment);
  const lowAppraisal = evaluateCognitiveOption(lowContext, inquiryOption, moment);
  assert.ok(highAppraisal.personalityGate > lowAppraisal.personalityGate,
    '开放性更高的人应对同一有来源观察形成更强人格门控');
  assert.ok(highAppraisal.motivation > lowAppraisal.motivation,
    '相同候选和世界事实下，人格差异应改变认知 appraisal');
  assert.ok(rankCognitiveOptions(highContext, [inquiryOption], moment)[0].rankScore
    > rankCognitiveOptions(lowContext, [inquiryOption], moment)[0].rankScore,
  '认知排序分值应保留人格造成的差异，而不是退化为固定规则树');

  // Goal outcome history must alter the same candidate without conflating it
  // with whether the underlying atomic action executed legally.
  const experiencedBase = createInitialState(26082003, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  experiencedBase.people[0].bornAtMonth = -20 * 12;
  const positiveState = structuredClone(experiencedBase);
  const negativeState = structuredClone(experiencedBase);
  const positivePerson = positiveState.people[0];
  const negativePerson = negativeState.people[0];
  positivePerson.cognition = createCognitionState();
  negativePerson.cognition = createCognitionState();
  positiveState.intents = [];
  negativeState.intents = [];
  for (let index = 0; index < 5; index += 1) {
    const positiveIntent = makeIntent(positivePerson, { id: `cognition-positive-intent-${index}` });
    const negativeIntent = makeIntent(negativePerson, { id: `cognition-negative-intent-${index}` });
    positiveState.intents.push(positiveIntent);
    negativeState.intents.push(negativeIntent);
    const positiveFact = makeActionFact(positivePerson, positiveIntent, {
      id: `cognition-positive-${index}`,
      atMonth: 6 + index,
    });
    const negativeFact = makeActionFact(negativePerson, negativeIntent, {
      id: `cognition-negative-${index}`,
      atMonth: 6 + index,
      status: 'failed',
      result: '没有形成有效观察',
    });
    recordActionOutcomeBelief(positiveState, positiveFact);
    recordActionOutcomeBelief(negativeState, negativeFact);
    recordIntentGoalOutcome(positiveState, positiveIntent, 'achieved', 6 + index, [positiveFact.id], positiveFact.action);
    recordIntentGoalOutcome(negativeState, negativeIntent, 'attempted-unmet', 6 + index, [negativeFact.id], negativeFact.action);
  }
  const positiveOption = { ...inquiryOption };
  const negativeOption = { ...inquiryOption };
  const positiveAppraisal = evaluateCognitiveOption(makeContext(positiveState, positivePerson, [positiveOption]), positiveOption, moment);
  const negativeAppraisal = evaluateCognitiveOption(makeContext(negativeState, negativePerson, [negativeOption]), negativeOption, moment);
  assert.ok(positiveAppraisal.expectedSuccess > negativeAppraisal.expectedSuccess,
    '个人成功经历应提高同类候选的后验成功预期');
  assert.ok(positiveAppraisal.motivation > negativeAppraisal.motivation,
    '个人经历应进入 appraisal，而不是只生成叙事文本');

  // A legal reproduction process and achievement of the pregnancy goal are
  // separate evidence. Non-conception stays action-completed but lowers the
  // goal posterior and must not become a positive causal memory.
  const reproductionState = createInitialState(26082004, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const reproductionActor = reproductionState.people[0];
  const reproductionPartner = reproductionState.people[1];
  const female = reproductionActor.sex === 'female' ? reproductionActor : reproductionPartner;
  const reproductionIntent = makeIntent(reproductionActor, {
    id: 'cognition-reproduction-no-conception-intent',
    domain: 'social',
    goal: { kind: 'condition', personId: female.id, condition: 'pregnancy', present: true },
    nextAction: {
      kind: 'act',
      operation: 'reproduce',
      targets: [{ kind: 'person', personId: reproductionPartner.id }],
      authorizationRef: 'agreement-cognition-reproduction',
    },
    target: { kind: 'person', personId: reproductionPartner.id },
  });
  reproductionState.intents = [reproductionIntent];
  const noConceptionFact = makeActionFact(reproductionActor, reproductionIntent, {
    id: 'cognition-reproduction-no-conception-fact',
    diff: { conceived: false },
  });
  const reproductionBasis = actionFactOutcomeBasisKey(reproductionState, noConceptionFact);
  recordActionOutcomeBelief(reproductionState, noConceptionFact);
  recordIntentGoalOutcome(
    reproductionState,
    reproductionIntent,
    'attempted-unmet',
    moment.atMonth,
    [noConceptionFact.id],
    noConceptionFact.action,
  );
  assert.ok(outcomeBeliefSuccess(outcomeBeliefFor(reproductionActor, reproductionBasis)) > 0.5,
    '未受孕仍应证明该原子生殖过程合法完成');
  assert.ok(goalOutcomeBeliefSuccess(goalOutcomeBeliefFor(reproductionActor, reproductionBasis)) < 0.5,
    '未受孕必须下修妊娠目标的达成后验');
  const noConceptionTrace = causalMemoryTraceForAction(reproductionState, noConceptionFact);
  assert.equal(noConceptionTrace.valence, 0, '未受孕不应成为妊娠目标的正向记忆');
  assert.ok(noConceptionTrace.consequenceTags.includes('goal-unmet'));
  const reproductionOption = {
    id: `reproduce:agreement-cognition-reproduction:${reproductionPartner.id}`,
    summary: '进行一次已同意的生殖尝试',
    reason: '测试目标结果与动作结果分离',
    goal: structuredClone(reproductionIntent.goal),
    nextAction: structuredClone(reproductionIntent.nextAction),
    target: structuredClone(reproductionIntent.target),
    estimatedDuration: 'one-month',
    sourceFactIds: [noConceptionFact.id],
    domain: 'social',
  };
  const reproductionAppraisal = evaluateCognitiveOption(
    makeContext(reproductionState, reproductionActor, [reproductionOption], undefined, [reproductionPartner]),
    reproductionOption,
    moment,
  );
  assert.ok(reproductionAppraisal.expectedSuccess < 0.5,
    'BDI appraisal 应读取妊娠目标后验，而不是动作 completed 后验');

  // Project completion creates a sourced, person-local need-resolution
  // episode. It relieves a matching proposal briefly, but cannot masquerade
  // as food, water, shelter, or a direct reproduction reward.
  const readinessState = createInitialState(26082006, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  readinessState.clock.elapsedMonths = moment.atMonth;
  readinessState.containers = [];
  const readyPerson = readinessState.people[0];
  const uninvolvedPerson = readinessState.people[1];
  readyPerson.bornAtMonth = -28 * 12;
  readyPerson.knownPlaces = [];
  readyPerson.cognition = createCognitionState();
  uninvolvedPerson.cognition = createCognitionState();
  readyPerson.inventory = [
    { id: 'ready-food', materialId: Material.Food, quantity: 8, sourceEventIds: ['ready-food-source'] },
    { id: 'ready-water', materialId: Material.Water, quantity: 4, sourceEventIds: ['ready-water-source'] },
  ];
  const projectTriggerId = readinessState.world.past[0]?.id ?? 'founding-source';
  const cultivationProject = instantiateProject({
    id: 'project-cognition-settled-cultivation',
    kind: 'production',
    need: 'reserve-security',
    desiredFunction: 'settled-cultivation',
    summary: '建立可持续耕作地',
    ownerId: readyPerson.id,
    beneficiaryIds: [readyPerson.id, uninvolvedPerson.id],
    triggerFactIds: [projectTriggerId],
    pressure: 72,
    createdAtMonth: 6,
    reviewAtMonth: 18,
  });
  const cultivationIntent = makeIntent(readyPerson, {
    id: 'cognition-cultivation-completion-intent',
    goal: { kind: 'project-completed', projectId: cultivationProject.id },
  });
  readinessState.intents.push(cultivationIntent);
  const cultivationFact = makeActionFact(readyPerson, cultivationIntent, {
    id: 'cognition-cultivation-completion-fact',
    atMonth: moment.atMonth,
  });
  readinessState.world.past.push(cultivationFact);
  cultivationProject.actionEventIds.push(cultivationFact.id);
  cultivationProject.progressEvidence?.push({
    eventId: cultivationFact.id,
    atMonth: moment.atMonth,
    kind: 'material-contribution',
    actorId: readyPerson.id,
  });
  readinessState.projects = [cultivationProject];
  completeProject(readinessState, cultivationProject, moment.atMonth, [cultivationFact.id]);
  const resolutionEpisode = readyPerson.cognition.needResolutionEpisodes[0];
  assert.equal(resolutionEpisode?.projectId, cultivationProject.id,
    '亲自造成最后功能事实的人应获得项目需要缓解记录');
  assert.deepEqual(resolutionEpisode?.outcomeEventIds, [cultivationFact.id]);
  assert.equal(uninvolvedPerson.cognition.needResolutionEpisodes.length, 0,
    '远处 beneficiary 不得被广播项目满意事实');

  const proposalOption = {
    id: 'cognition-project-proposal-repeat-cultivation',
    summary: '再次建立同类耕作地',
    reason: '测试刚完成项目对同类新建压力的短期缓解',
    goal: { kind: 'project-completed', projectId: 'proposal-placeholder' },
    nextAction: structuredClone(cultivationIntent.nextAction),
    estimatedDuration: 'long',
    sourceFactIds: [projectTriggerId],
    projectProposal: {
      id: 'proposal-repeat-cultivation',
      kind: 'production',
      need: 'reserve-security',
      desiredFunction: 'settled-cultivation',
      summary: '再次建立同类耕作地',
      ownerId: readyPerson.id,
      beneficiaryIds: [readyPerson.id],
      triggerFactIds: [projectTriggerId],
      pressure: 72,
      createdAtMonth: moment.atMonth,
      reviewAtMonth: moment.atMonth + 12,
    },
    projectPressure: 72,
  };
  const resolutionContext = makeContext(readinessState, readyPerson, [proposalOption]);
  const withoutResolutionState = structuredClone(readinessState);
  const withoutResolutionPerson = withoutResolutionState.people.find((person) => person.id === readyPerson.id);
  withoutResolutionPerson.cognition.needResolutionEpisodes = [];
  const noResolutionContext = makeContext(withoutResolutionState, withoutResolutionPerson, [proposalOption]);
  const relievedReserveNeed = deriveNeedAgenda(resolutionContext, moment.atMonth).find((need) => need.kind === 'reserve');
  const unrelievedReserveNeed = deriveNeedAgenda(noResolutionContext, moment.atMonth).find((need) => need.kind === 'reserve');
  assert.ok(relievedReserveNeed.urgency < unrelievedReserveNeed.urgency,
    '近期亲手完成的同 need+function 项目应短期压低同类新建压力');
  assert.ok(relievedReserveNeed.sourceFactIds.includes(cultivationFact.id),
    '项目缓解必须保留真实完成事实来源');

  const readyContext = makeContext(readinessState, readyPerson, [reproductionOption], undefined, [uninvolvedPerson]);
  const readinessWithEpisode = assessFamilyReadiness(readyContext, moment.atMonth);
  const readinessWithoutEpisode = assessFamilyReadiness(noResolutionContext, moment.atMonth);
  assert.equal(readinessWithEpisode.readiness, readinessWithoutEpisode.readiness,
    '项目完成记录本身不得凭空增加食水住所准备度');
  assert.ok(readinessWithEpisode.sourceFactIds.includes(cultivationFact.id),
    '项目完成只作为家庭判断的可追溯信心来源');

  const lowReadinessState = structuredClone(readinessState);
  const lowReadinessPerson = lowReadinessState.people.find((person) => person.id === readyPerson.id);
  const lowReadinessPartner = lowReadinessState.people.find((person) => person.id === uninvolvedPerson.id);
  lowReadinessState.containers = [];
  lowReadinessPerson.inventory = [];
  lowReadinessPerson.knownPlaces = [];
  lowReadinessPerson.conditions.push({
    id: 'low-readiness-cold', kind: 'cold', stage: 2, sinceMonth: moment.atMonth,
    sourceEventIds: ['low-readiness-cold-source'],
  });
  const dependent = structuredClone(lowReadinessState.people[2]);
  dependent.id = 'low-readiness-dependent';
  dependent.name = '需要照护的孩子';
  dependent.bornAtMonth = moment.atMonth - 12;
  dependent.geneticParents = [lowReadinessPerson.id];
  dependent.position = structuredClone(lowReadinessPerson.position);
  dependent.body = { health: 42, hydration: 40, nutrition: 40 };
  delete dependent.diedAtMonth;
  lowReadinessState.people.push(dependent);
  const readyReproductionOption = {
    ...reproductionOption,
    target: { kind: 'person', personId: uninvolvedPerson.id },
    nextAction: {
      ...reproductionOption.nextAction,
      targets: [{ kind: 'person', personId: uninvolvedPerson.id }],
    },
  };
  const lowReproductionOption = structuredClone(readyReproductionOption);
  const highFamilyContext = makeContext(readinessState, readyPerson, [readyReproductionOption], undefined, [uninvolvedPerson]);
  const lowFamilyContext = {
    ...makeContext(lowReadinessState, lowReadinessPerson, [lowReproductionOption], undefined, [lowReadinessPartner]),
    visibleCells: [],
  };
  const highFamily = assessFamilyReadiness(highFamilyContext, moment.atMonth);
  const lowFamily = assessFamilyReadiness(lowFamilyContext, moment.atMonth);
  assert.equal(highFamily.shelter, 0,
    '夹具没有真实住所，食水储备不得被误认成遮蔽能力');
  assert.ok(highFamily.readiness < 0.25,
    '即使有食水，没有可达住所也不得形成高家庭准备度');
  assert.ok(highFamily.readiness > lowFamily.readiness,
    '本地食水、照护余量和身体安全应真实提高家庭准备度');
  const highFamilyAppraisal = evaluateCognitiveOption(highFamilyContext, readyReproductionOption, moment);
  const lowFamilyAppraisal = evaluateCognitiveOption(lowFamilyContext, lowReproductionOption, moment);
  assert.ok(highFamilyAppraisal.readinessGate > lowFamilyAppraisal.readinessGate,
    '高准备度应提高正向生殖候选门控，低准备度不应被项目完成记录强推');
  const highGenerativity = deriveNeedAgenda(highFamilyContext, moment.atMonth)
    .find((need) => need.kind === 'generativity');
  const lowGenerativity = deriveNeedAgenda(lowFamilyContext, moment.atMonth)
    .find((need) => need.kind === 'generativity');
  assert.ok(highGenerativity && lowGenerativity,
    '可追溯关系应产生非零的家庭形成考虑，不能要求先把全部物质条件解决才出现动机');
  assert.ok(highGenerativity.urgency > lowGenerativity.urgency,
    '家庭准备度仍应连续调节生成性需要强弱');
  assert.ok(highGenerativity.sourceFactIds.includes(noConceptionFact.id),
    '生成性需要必须保留正向生殖候选自身的关系或协议来源');
  assert.equal(highFamilyAppraisal.familyReadiness?.readiness, highFamily.readiness,
    'BDI 审计必须暴露组成生殖判断的原始家庭准备度');
  const belongingOnlyState = structuredClone(readinessState);
  const belongingOnlyPerson = belongingOnlyState.people.find((person) => person.id === readyPerson.id);
  const belongingOnlyPartner = belongingOnlyState.people.find((person) => person.id === uninvolvedPerson.id);
  belongingOnlyPerson.relations = [{
    personId: belongingOnlyPartner.id,
    trust: 90,
    bond: 90,
    fear: 0,
    sourceEventIds: [cultivationFact.id],
  }];
  const belongingOnlyOffer = {
    id: `offer-reproduce:${moment.atMonth}:${belongingOnlyPerson.id}:${belongingOnlyPartner.id}`,
    summary: '在没有住所余量时提出共同生殖',
    reason: '测试归属需要不能绕过生成性需要',
    goal: { kind: 'representation-made', representationId: 'belonging-only-reproduction-offer' },
    nextAction: {
      kind: 'communicate',
      content: {
        id: 'belonging-only-reproduction-offer',
        kind: 'offer',
        proposal: { kind: 'reproduce' },
      },
      audience: [belongingOnlyPartner.id],
      channel: 'voice',
    },
    target: { kind: 'person', personId: belongingOnlyPartner.id },
    estimatedDuration: 'one-month',
    sourceFactIds: [cultivationFact.id],
  };
  const belongingOnlyContext = makeContext(
    belongingOnlyState,
    belongingOnlyPerson,
    [belongingOnlyOffer],
    undefined,
    [belongingOnlyPartner],
  );
  const belongingOnlyAgenda = deriveNeedAgenda(belongingOnlyContext, moment.atMonth);
  assert.ok(belongingOnlyAgenda.some((need) => need.kind === 'belonging'),
    '夹具必须存在强关系带来的归属需要');
  assert.ok(belongingOnlyAgenda.some((need) => need.kind === 'generativity'),
    '强关系可以让人物在住所尚未完全解决时开始考虑家庭形成');
  const belongingOnlyAppraisal = evaluateCognitiveOption(belongingOnlyContext, belongingOnlyOffer, moment);
  assert.ok(belongingOnlyAppraisal.needActivation > 0,
    '正向生殖仍只能由 generativity 激活，但有来源关系不再被物质准备度抹成零');
  assert.equal(belongingOnlyAppraisal.addressedNeeds.some((need) => need.kind === 'belonging'), false,
    '生殖解释不得把未参与激活的 belonging 伪装成当前驱动需要');
  assert.equal(belongingOnlyAppraisal.generativityUrgency,
    belongingOnlyAgenda.find((need) => need.kind === 'generativity')?.urgency,
    '生殖判断必须记录实际参与激活的生成性需要强度');

  const committedBelongingState = structuredClone(belongingOnlyState);
  const sociallyCommittedPerson = committedBelongingState.people.find((person) => person.id === belongingOnlyPerson.id);
  const committedReproductionPartner = committedBelongingState.people.find((person) => person.id === belongingOnlyPartner.id);
  const companion = committedBelongingState.people[2];
  companion.position = structuredClone(sociallyCommittedPerson.position);
  sociallyCommittedPerson.relations.push({
    personId: companion.id,
    trust: 45,
    bond: 35,
    fear: 0,
    sourceEventIds: [cultivationFact.id],
  });
  committedBelongingState.agreements.push({
    id: 'cognition-established-companion-agreement',
    proposal: {
      kind: 'companion',
      proposerId: sociallyCommittedPerson.id,
      partnerId: companion.id,
      expiresAtMonth: moment.atMonth + 6,
      sharedLivingAnchor: {
        version: 'shared-living-anchor-v1',
        cellId: sociallyCommittedPerson.position.cellId,
        z: sociallyCommittedPerson.position.z,
        radius: 2,
      },
    },
    proposerId: sociallyCommittedPerson.id,
    responderId: companion.id,
    partyIds: [sociallyCommittedPerson.id, companion.id],
    requiredResponderIds: [companion.id],
    acceptedByPersonIds: [companion.id],
    rejectedByPersonIds: [],
    fulfilledByPersonIds: [sociallyCommittedPerson.id, companion.id],
    fulfillmentEventIds: [cultivationFact.id],
    proposedAtMonth: moment.atMonth - 15,
    acceptByMonth: moment.atMonth - 14,
    acceptedAtMonth: moment.atMonth - 14,
    dueAtMonth: moment.atMonth + 10,
    coLocatedMonths: 12,
    companionEstablishedAtMonth: moment.atMonth - 2,
    lastCompanionCoLocatedAtMonth: moment.atMonth,
    status: 'active',
    proposalEventId: cultivationFact.id,
    sourceEventIds: [cultivationFact.id],
  });
  const committedContext = makeContext(
    committedBelongingState,
    sociallyCommittedPerson,
    [structuredClone(belongingOnlyOffer)],
    undefined,
    [committedReproductionPartner, companion],
  );
  const committedAgenda = deriveNeedAgenda(committedContext, moment.atMonth);
  const unmetBelonging = committedAgenda.find((need) => need.kind === 'belonging');
  const committedGenerativity = committedAgenda.find((need) => need.kind === 'generativity');
  assert.ok(committedGenerativity,
    '已有共同生活关系不能抹去另一段真实关系产生的家庭形成考虑');
  assert.ok(unmetBelonging && unmetBelonging.urgency < committedGenerativity.urgency,
    '真实建立且当月共同生活的关系应缓解归属缺口，不能继续让新增结伴长期压过生成性需要');
  assert.ok(unmetBelonging.sourceFactIds.includes(cultivationFact.id),
    '归属满足若仍留下未满足部分，必须保留共同生活承诺的事实来源');

  const shelteredState = structuredClone(readinessState);
  shelteredState.derived.structures = [];
  const shelteredPerson = shelteredState.people.find((person) => person.id === readyPerson.id);
  const shelteredPartner = shelteredState.people.find((person) => person.id === uninvolvedPerson.id);
  const center = shelteredPerson.position.cellId;
  const z = shelteredPerson.position.z;
  const adjacent = neighbors4(center);
  const spareCell = adjacent[1] ?? adjacent[0];
  const spareNeighbors = neighbors4(spareCell);
  const shelterCells = [...new Set([center, ...adjacent, spareCell, ...spareNeighbors])];
  for (const cell of shelterCells) {
    setVoxel(shelteredState.world.grid, cellX(cell), cellY(cell), z - 1, Material.PackedSoil);
    setVoxel(shelteredState.world.grid, cellX(cell), cellY(cell), z, Material.Air);
    setVoxel(shelteredState.world.grid, cellX(cell), cellY(cell), z + 1, Material.Air);
    setVoxel(shelteredState.world.grid, cellX(cell), cellY(cell), z + 2, Material.Air);
  }
  setVoxel(shelteredState.world.grid, cellX(center), cellY(center), z + 2, Material.Stone);
  setVoxel(shelteredState.world.grid, cellX(spareCell), cellY(spareCell), z + 2, Material.Stone);
  const spareWalls = spareNeighbors.filter((cell) => cell !== center);
  for (const wallCell of spareWalls) {
    setVoxel(shelteredState.world.grid, cellX(wallCell), cellY(wallCell), z, Material.Stone);
  }
  shelteredPartner.position = structuredClone(shelteredPerson.position);
  shelteredState.derived.structures.push({
    id: 'family-readiness-real-shelter',
    materialIds: [Material.Stone],
    occupiedCells: [center, spareCell, ...spareWalls],
    interiorPositions: [structuredClone(shelteredPerson.position), { cellId: spareCell, z }],
    complete: true,
    capacity: 2,
    sourceEventIds: [cultivationFact.id],
  });
  shelteredState.world.physicalStructureIndex = {
    calculatedAtMonth: shelteredState.clock.elapsedMonths,
    voxelRevision: voxelWorldRevision(shelteredState.world.grid),
    constructionEventCount: shelteredState.world.physicalStructureIndex.constructionEventCount,
    structures: structuredClone(shelteredState.derived.structures),
  };
  const shelteredContext = makeContext(
    shelteredState,
    shelteredPerson,
    [structuredClone(readyReproductionOption)],
    undefined,
    [shelteredPartner],
  );
  shelteredContext.visibleCells = [center, spareCell];
  const shelteredFamily = assessFamilyReadiness(shelteredContext, moment.atMonth);
  assert.ok(shelteredFamily.shelter > 0.9,
    '真实可达、仍有空位且具备分层冷热防护的住所才应提供高家庭住所准备度');
  assert.ok(shelteredFamily.readiness > highFamily.readiness);
  assert.ok(deriveNeedAgenda(shelteredContext, moment.atMonth).some((need) => need.kind === 'generativity'),
    '食水、照护余量与空余住所同时成立时应进一步增强生成性需要');
  const shelteredAppraisal = evaluateCognitiveOption(shelteredContext, shelteredContext.options[0], moment);
  assert.ok(shelteredAppraisal.motivation > highFamilyAppraisal.motivation
    && shelteredAppraisal.motivation > lowFamilyAppraisal.motivation,
    '真实家庭准备度差异应进入 BDI motivation');
  const boundedAuditState = structuredClone(shelteredState);
  rebaseSyntheticPhysicalIndex(boundedAuditState);
  const boundedAuditPerson = boundedAuditState.people.find((person) => person.id === shelteredPerson.id);
  const boundedAuditPartner = boundedAuditState.people.find((person) => person.id === shelteredPartner.id);
  const fullAuditSources = Array.from({ length: 96 }, (_, index) => `family-readiness-audit-source-${index}`);
  boundedAuditState.world.physicalStructureIndex.structures[0].sourceEventIds = fullAuditSources;
  const boundedAuditContext = makeContext(
    boundedAuditState,
    boundedAuditPerson,
    [structuredClone(shelteredContext.options[0])],
    undefined,
    [boundedAuditPartner],
  );
  boundedAuditContext.visibleCells = [...shelteredContext.visibleCells];
  const fullAuditAppraisal = evaluateCognitiveOption(boundedAuditContext, boundedAuditContext.options[0], moment);
  assert.ok(fullAuditAppraisal.familyReadiness.sourceFactIds.length > 32,
    '测试夹具必须形成超过事件审计上限的完整家庭准备度来源');
  const reproductionDecisionFact = applyDecision(
    boundedAuditState,
    boundedAuditPerson,
    boundedAuditContext,
    { kind: 'start', optionId: boundedAuditContext.options[0].id, reason: '检查生殖决策证据有界化' },
    false,
    moment.atMonth,
    boundedAuditState.world.past.length,
    moment.planningTick,
  );
  assert.equal(reproductionDecisionFact.reproductionEvidence.familyReadiness.sourceFactCount,
    fullAuditAppraisal.familyReadiness.sourceFactIds.length,
    '有界事件审计仍须记录完整来源数量');
  assert.equal(reproductionDecisionFact.reproductionEvidence.familyReadiness.sourceFactIds.length, 32,
    '单条生殖决策不得再次嵌入无界家庭准备度来源');
  assert.ok(reproductionDecisionFact.reproductionEvidence.familyReadiness.sourceFactIds
    .every((sourceId) => fullAuditAppraisal.familyReadiness.sourceFactIds.includes(sourceId)),
  '有界审计样本必须全部来自当时真实 appraisal 来源');
  const rememberedShelterState = structuredClone(shelteredState);
  rebaseSyntheticPhysicalIndex(rememberedShelterState);
  const rememberedShelterPerson = rememberedShelterState.people.find((person) => person.id === shelteredPerson.id);
  const rememberedShelterPartner = rememberedShelterState.people.find((person) => person.id === shelteredPartner.id);
  const rememberedStructure = rememberedShelterState.derived.structures
    .find((structure) => structure.id === 'family-readiness-real-shelter');
  const outsideCell = adjacent.find((cell) => cell !== spareCell && !rememberedStructure.occupiedCells.includes(cell));
  assert.ok(outsideCell !== undefined, '夹具需要一个住所外的可站立位置');
  rememberedShelterPerson.position = { cellId: outsideCell, z };
  rememberedShelterPartner.position = { cellId: outsideCell, z };
  const rememberedShelterContext = makeContext(
    rememberedShelterState,
    rememberedShelterPerson,
    [structuredClone(readyReproductionOption)],
    undefined,
    [rememberedShelterPartner],
  );
  rememberedShelterContext.visibleCells = [outsideCell];
  const rememberedAccess = findReachableShelter(
    rememberedShelterState,
    rememberedShelterPerson,
    rememberedShelterContext.visibleCells,
  );
  assert.equal(rememberedAccess?.remembered, true,
    '夹具必须只通过本人有来源的地点/建造记忆找到当前不可见住所');
  const rememberedFamily = assessFamilyReadiness(rememberedShelterContext, moment.atMonth);
  assert.equal(rememberedFamily.shelter, 0,
    '当前不可见的记忆住所不能用全局实时拓扑伪证仍有空余家庭位置');
  assert.ok(rememberedFamily.reasons.some((reason) => reason.includes('当前看不见其空余位置')),
    '人物可以记得住所存在，但家庭判断必须解释为什么尚未确认当前容量');
  const livingRemoteChildState = structuredClone(shelteredState);
  rebaseSyntheticPhysicalIndex(livingRemoteChildState);
  const livingRemoteParent = livingRemoteChildState.people.find((person) => person.id === shelteredPerson.id);
  const livingRemotePartner = livingRemoteChildState.people.find((person) => person.id === shelteredPartner.id);
  const livingRemoteChild = structuredClone(livingRemoteChildState.people[2]);
  livingRemoteChild.id = 'family-readiness-remote-child';
  livingRemoteChild.name = '远处幼儿';
  livingRemoteChild.bornAtMonth = moment.atMonth - 24;
  livingRemoteChild.geneticParents = [livingRemoteParent.id];
  livingRemoteChild.position = { cellId: outsideCell, z };
  livingRemoteChild.body = { health: 80, hydration: 80, nutrition: 80 };
  delete livingRemoteChild.diedAtMonth;
  livingRemoteChildState.people.push(livingRemoteChild);
  const livingRemoteContext = makeContext(
    livingRemoteChildState,
    livingRemoteParent,
    [structuredClone(readyReproductionOption)],
    undefined,
    [livingRemotePartner],
  );
  livingRemoteContext.visibleCells = [center, spareCell];
  const livingRemoteFamily = assessFamilyReadiness(livingRemoteContext, moment.atMonth);
  const unknownRemoteDeathState = structuredClone(livingRemoteChildState);
  rebaseSyntheticPhysicalIndex(unknownRemoteDeathState);
  const unknownRemoteParent = unknownRemoteDeathState.people.find((person) => person.id === livingRemoteParent.id);
  const unknownRemotePartner = unknownRemoteDeathState.people.find((person) => person.id === livingRemotePartner.id);
  const unknownRemoteChild = unknownRemoteDeathState.people.find((person) => person.id === livingRemoteChild.id);
  unknownRemoteChild.diedAtMonth = moment.atMonth - 1;
  unknownRemoteChild.body.health = 0;
  const unknownRemoteContext = makeContext(
    unknownRemoteDeathState,
    unknownRemoteParent,
    [structuredClone(readyReproductionOption)],
    undefined,
    [unknownRemotePartner],
  );
  unknownRemoteContext.visibleCells = [center, spareCell];
  const unknownRemoteFamily = assessFamilyReadiness(unknownRemoteContext, moment.atMonth);
  assert.equal(unknownRemoteFamily.careCapacity, livingRemoteFamily.careCapacity,
    '异地子女客观死亡但父母尚未知情时，照护责任不得通过全局状态瞬间消失');
  const knownRemoteDeathState = structuredClone(unknownRemoteDeathState);
  rebaseSyntheticPhysicalIndex(knownRemoteDeathState);
  const knownRemoteParent = knownRemoteDeathState.people.find((person) => person.id === livingRemoteParent.id);
  const knownRemotePartner = knownRemoteDeathState.people.find((person) => person.id === livingRemotePartner.id);
  const remoteDeathFactId = 'family-readiness-known-remote-child-death';
  knownRemoteDeathState.world.past.push({
    id: remoteDeathFactId,
    kind: 'environment',
    atMonth: moment.atMonth - 1,
    orderInMonth: 0,
    cellId: outsideCell,
    change: 'death',
    result: '远处幼儿死亡',
    diff: { personId: livingRemoteChild.id },
  });
  knownRemoteParent.bereavements = [{
    id: `bereavement:${knownRemoteParent.id}:remains:${livingRemoteChild.id}`,
    remainsId: `remains:${livingRemoteChild.id}`,
    deceasedPersonId: livingRemoteChild.id,
    deathEventId: remoteDeathFactId,
    learnedAtMonth: moment.atMonth,
    learnedBy: 'told',
    intensity: 0.9,
    sourceEventIds: [remoteDeathFactId],
  }];
  const knownRemoteContext = makeContext(
    knownRemoteDeathState,
    knownRemoteParent,
    [structuredClone(readyReproductionOption)],
    undefined,
    [knownRemotePartner],
  );
  knownRemoteContext.visibleCells = [center, spareCell];
  const knownRemoteFamily = assessFamilyReadiness(knownRemoteContext, moment.atMonth);
  assert.ok(knownRemoteFamily.careCapacity > unknownRemoteFamily.careCapacity,
    '父母有来源地得知子女死亡后，照护责任才可释放');
  assert.ok(knownRemoteFamily.sourceFactIds.includes(remoteDeathFactId),
    '责任释放必须引用本人实际获知的死亡事实');
  const crowdedState = structuredClone(shelteredState);
  rebaseSyntheticPhysicalIndex(crowdedState);
  const crowdedPerson = crowdedState.people.find((person) => person.id === shelteredPerson.id);
  const crowdedPartner = crowdedState.people.find((person) => person.id === shelteredPartner.id);
  const visibleOccupant = structuredClone(crowdedState.people[2]);
  visibleOccupant.id = 'family-readiness-visible-occupant';
  visibleOccupant.position = { cellId: spareCell, z };
  delete visibleOccupant.diedAtMonth;
  crowdedState.people.push(visibleOccupant);
  const crowdedContext = makeContext(
    crowdedState,
    crowdedPerson,
    [structuredClone(readyReproductionOption)],
    undefined,
    [crowdedPartner, visibleOccupant],
  );
  crowdedContext.visibleCells = [center, spareCell];
  assert.equal(assessFamilyReadiness(crowdedContext, moment.atMonth).shelter, 0,
    '看得见的住户已经占满真实内部位置时，住所存在也不能冒充新增家庭容量');

  // Structured episodic memory is target-sensitive for interpersonal acts:
  // the same candidate is encouraged by a positive episode with this person,
  // discouraged by a negative one, and unaffected by somebody else's episode.
  const socialBase = createInitialState(26082005, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const socialActor = socialBase.people[0];
  const socialTarget = socialBase.people[1];
  assert.ok(socialTarget, '社会记忆夹具需要一个当前可见的目标人物');
  socialActor.bornAtMonth = -20 * 12;
  socialTarget.bornAtMonth = -20 * 12;
  socialActor.memories = [];
  socialActor.relations = [{
    personId: socialTarget.id,
    trust: 18,
    bond: 18,
    fear: 0,
    sourceEventIds: ['social-target-relation'],
  }];
  const socialOption = {
    id: 'cognition-test:share-observation',
    summary: '向眼前的人分享一次观察',
    reason: '双方都能感知到同一个局部事实',
    goal: { kind: 'representation-made', representationId: 'cognition-test-social-claim' },
    nextAction: {
      kind: 'communicate',
      content: {
        id: 'cognition-test-social-claim',
        kind: 'claim',
        summary: '眼前材料的表面已经发生变化',
        factId: 'visible-shared-change',
      },
      audience: [socialTarget.id],
      channel: 'voice',
    },
    target: { kind: 'person', personId: socialTarget.id },
    estimatedDuration: 'one-month',
    estimatedMonths: 1,
    sourceFactIds: ['visible-shared-change', 'social-target-relation'],
    domain: 'social',
  };
  const socialMoment = { atMonth: 18, planningTick: 6 };
  const neutralSocialContext = makeContext(socialBase, socialActor, [socialOption], undefined, [socialTarget]);
  const neutralSocialAppraisal = evaluateCognitiveOption(neutralSocialContext, socialOption, socialMoment);
  assert.equal(neutralSocialAppraisal.memoryGate, 1, '没有相似亲历时记忆门应保持中性');

  function socialEpisode(id, personId, valence, outcome) {
    return {
      id,
      kind: outcome === 'failed' ? 'failure' : 'episode',
      summary: outcome === 'failed' ? '与某人分享相似观察时遭遇负面后果' : '与某人分享相似观察后形成了有效交流',
      importance: 90,
      createdAtMonth: 17,
      lastRecalledAtMonth: 17,
      personIds: [personId],
      sourceEventIds: [`${id}:source`],
      causal: {
        basisKey: neutralSocialAppraisal.basisKey,
        actionKind: 'communicate',
        operation: 'claim',
        goalKind: 'representation-made',
        outcome,
        valence,
        consequenceTags: ['social', outcome],
      },
    };
  }

  const positiveMemoryState = structuredClone(socialBase);
  const negativeMemoryState = structuredClone(socialBase);
  const unrelatedMemoryState = structuredClone(socialBase);
  const positiveMemoryActor = positiveMemoryState.people[0];
  const negativeMemoryActor = negativeMemoryState.people[0];
  const unrelatedMemoryActor = unrelatedMemoryState.people[0];
  positiveMemoryActor.memories = [socialEpisode('positive-target-episode', socialTarget.id, 0.9, 'completed')];
  negativeMemoryActor.memories = [socialEpisode('negative-target-episode', socialTarget.id, -0.9, 'failed')];
  const unrelatedPersonId = socialBase.people[2]?.id ?? 'cognition-test-unrelated-person';
  unrelatedMemoryActor.memories = [socialEpisode('positive-unrelated-episode', unrelatedPersonId, 0.9, 'completed')];

  const positiveMemoryAppraisal = evaluateCognitiveOption(
    makeContext(positiveMemoryState, positiveMemoryActor, [socialOption], undefined, [positiveMemoryState.people[1]]),
    socialOption,
    socialMoment,
  );
  const negativeMemoryAppraisal = evaluateCognitiveOption(
    makeContext(negativeMemoryState, negativeMemoryActor, [socialOption], undefined, [negativeMemoryState.people[1]]),
    socialOption,
    socialMoment,
  );
  const unrelatedMemoryAppraisal = evaluateCognitiveOption(
    makeContext(unrelatedMemoryState, unrelatedMemoryActor, [socialOption], undefined, [unrelatedMemoryState.people[1]]),
    socialOption,
    socialMoment,
  );
  assert.ok(positiveMemoryAppraisal.memoryGate > neutralSocialAppraisal.memoryGate,
    '与当前目标人物的正向 causal episode 应提高 memoryGate');
  assert.ok(positiveMemoryAppraisal.motivation > neutralSocialAppraisal.motivation,
    '正向目标人物记忆应实际提高同一社会候选的 motivation');
  assert.ok(negativeMemoryAppraisal.memoryGate < neutralSocialAppraisal.memoryGate,
    '与当前目标人物的负向 causal episode 应降低 memoryGate');
  assert.ok(negativeMemoryAppraisal.motivation < neutralSocialAppraisal.motivation,
    '负向目标人物记忆应实际降低同一社会候选的 motivation');
  assert.equal(unrelatedMemoryAppraisal.memoryGate, neutralSocialAppraisal.memoryGate,
    '与另一人物的 causal episode 不得污染当前目标人物的记忆门');
  assert.equal(unrelatedMemoryAppraisal.motivation, neutralSocialAppraisal.motivation,
    '与另一人物的经历不得改变当前社会候选的 motivation');

  // Intention inertia keeps a fresh commitment in the absence of a challenger,
  // but an acute, sourced survival need may replace it.
  const persistenceState = createInitialState(26082004, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const committedPerson = persistenceState.people[0];
  committedPerson.bornAtMonth = -20 * 12;
  committedPerson.personality.baseline.conscientiousness = 90;
  const activeIntent = makeIntent(committedPerson, {
    id: 'cognition-test-active-commitment',
    goal: { kind: 'at-cell', cellId: committedPerson.position.cellId + 1 },
    nextAction: { kind: 'move', toCellId: committedPerson.position.cellId + 1 },
    lastProgressAtMonth: moment.atMonth,
    progress: 0.55,
  });
  persistenceState.intents = [activeIntent];
  committedPerson.activeIntentId = activeIntent.id;
  const quietContext = makeContext(persistenceState, committedPerson, [], activeIntent);
  const quietPersistence = assessIntentionPersistence(quietContext, activeIntent, undefined, moment);
  assert.equal(quietPersistence.keep, true, '没有竞争需要时，新近取得进展的意图应持续');
  assert.match(quietPersistence.reason, /维持投入/u);

  committedPerson.body.hydration = 1;
  const crisisOption = {
    id: 'cognition-test:urgent-hydration',
    summary: '立即恢复水分',
    reason: '本人已严重缺水且眼前存在可用来源',
    goal: { kind: 'body-at-least', field: 'hydration', value: 60 },
    nextAction: {
      kind: 'act',
      operation: 'ingest',
      targets: [{
        kind: 'voxel',
        position: {
          x: cellX(committedPerson.position.cellId),
          y: cellY(committedPerson.position.cellId),
          z: committedPerson.position.z,
        },
      }],
    },
    estimatedDuration: 'one-month',
    estimatedMonths: 1,
    sourceFactIds: ['visible-drinkable-source'],
  };
  const crisisContext = makeContext(persistenceState, committedPerson, [crisisOption], activeIntent);
  const crisisAppraisal = evaluateCognitiveOption(crisisContext, crisisOption, moment);
  const crisisPersistence = assessIntentionPersistence(crisisContext, activeIntent, crisisAppraisal, moment);
  assert.equal(crisisPersistence.keep, false, '跨过阈值的急性身体需要应能打断普通长期意图');
  assert.ok(crisisPersistence.acuteNeed >= 0.7);
  assert.match(crisisPersistence.reason, /身体、安全、照护/u);

  // A model can only select one of the server-provided local options.
  const localDecision = { kind: 'start', optionId: crisisOption.id, reason: '本地规则选择眼前水源' };
  const illegalModelDecision = { kind: 'start', optionId: 'model-invented-option', reason: '模型虚构候选' };
  assert.equal(validateModelDecision(crisisContext, illegalModelDecision, localDecision), null,
    '外部模型虚构的 optionId 必须被本地复核拒绝');

  console.log('agent cognition causal-BDI checks passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
