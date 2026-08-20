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
      cognitionStateOf,
      createCognitionState,
      outcomeBeliefFor,
      outcomeBeliefSuccess,
      recordActionOutcomeBelief,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/cognition.ts'))};
    export { evaluateCognitiveOption } from ${JSON.stringify(path.resolve('src/game/eland/application/cognition/option-appraisal.ts'))};
    export {
      assessIntentionPersistence,
      rankCognitiveOptions,
    } from ${JSON.stringify(path.resolve('src/game/eland/application/cognition/bdi-deliberation.ts'))};
    export { validateModelDecision } from ${JSON.stringify(path.resolve('src/game/eland/application/simulation/model-review.ts'))};
    export { cellX, cellY } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=agent-cognition-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    actionFactOutcomeBasisKey,
    assessIntentionPersistence,
    cellX,
    cellY,
    cognitionStateOf,
    createCognitionState,
    createInitialState,
    evaluateCognitiveOption,
    outcomeBeliefFor,
    outcomeBeliefSuccess,
    rankCognitiveOptions,
    recordActionOutcomeBelief,
    validateModelDecision,
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

  // Personal outcome history must alter the same candidate without changing
  // its legality, source facts, world or personality.
  const experiencedBase = createInitialState(26082003, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  experiencedBase.people[0].bornAtMonth = -20 * 12;
  const positiveState = structuredClone(experiencedBase);
  const negativeState = structuredClone(experiencedBase);
  const positivePerson = positiveState.people[0];
  const negativePerson = negativeState.people[0];
  positivePerson.cognition = createCognitionState();
  negativePerson.cognition = createCognitionState();
  const positiveIntent = makeIntent(positivePerson);
  const negativeIntent = makeIntent(negativePerson);
  positiveState.intents = [positiveIntent];
  negativeState.intents = [negativeIntent];
  for (let index = 0; index < 5; index += 1) {
    recordActionOutcomeBelief(positiveState, makeActionFact(positivePerson, positiveIntent, {
      id: `cognition-positive-${index}`,
      atMonth: 6 + index,
    }));
    recordActionOutcomeBelief(negativeState, makeActionFact(negativePerson, negativeIntent, {
      id: `cognition-negative-${index}`,
      atMonth: 6 + index,
      status: 'failed',
      result: '没有形成有效观察',
    }));
  }
  const positiveOption = { ...inquiryOption, goal: structuredClone(positiveIntent.goal), nextAction: structuredClone(positiveIntent.nextAction) };
  const negativeOption = { ...inquiryOption, goal: structuredClone(negativeIntent.goal), nextAction: structuredClone(negativeIntent.nextAction) };
  const positiveAppraisal = evaluateCognitiveOption(makeContext(positiveState, positivePerson, [positiveOption]), positiveOption, moment);
  const negativeAppraisal = evaluateCognitiveOption(makeContext(negativeState, negativePerson, [negativeOption]), negativeOption, moment);
  assert.ok(positiveAppraisal.expectedSuccess > negativeAppraisal.expectedSuccess,
    '个人成功经历应提高同类候选的后验成功预期');
  assert.ok(positiveAppraisal.motivation > negativeAppraisal.motivation,
    '个人经历应进入 appraisal，而不是只生成叙事文本');

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
  assert.match(crisisPersistence.reason, /身体、安全或照护需要/u);

  // A model can only select one of the server-provided local options.
  const localDecision = { kind: 'start', optionId: crisisOption.id, reason: '本地规则选择眼前水源' };
  const illegalModelDecision = { kind: 'start', optionId: 'model-invented-option', reason: '模型虚构候选' };
  assert.equal(validateModelDecision(crisisContext, illegalModelDecision, localDecision), null,
    '外部模型虚构的 optionId 必须被本地复核拒绝');

  console.log('agent cognition causal-BDI checks passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
