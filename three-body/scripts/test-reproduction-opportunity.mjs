import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-reproduction-test-'));
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const agreementBundlePath = path.join(temporaryDirectory, 'agreement.mjs');
const executorBundlePath = path.join(temporaryDirectory, 'action-executor.mjs');
const decisionFactorBundlePath = path.join(temporaryDirectory, 'decision-factor-forest.mjs');
const monthlyProcessesBundlePath = path.join(temporaryDirectory, 'monthly-processes.mjs');

try {
  for (const [entry, output] of [
    ['src/game/eland/simulation.ts', simulationBundlePath],
    ['src/game/eland/domain/agreement.ts', agreementBundlePath],
    ['src/game/eland/domain/action-executor.ts', executorBundlePath],
    ['src/game/eland/application/decision-factor-forest.ts', decisionFactorBundlePath],
    ['src/game/eland/domain/monthly-processes.ts', monthlyProcessesBundlePath],
  ]) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
    ], { stdio: 'pipe' });
  }

  const { buildDecisionContexts, createInitialState, seededFraction, stepSimulation } = await import(`${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`);
  const { advanceAgreementLifecycle, recordAgreementAction } = await import(`${pathToFileURL(agreementBundlePath).href}?test=${Date.now()}`);
  const { executePrimitiveAction } = await import(`${pathToFileURL(executorBundlePath).href}?test=${Date.now()}`);
  const { evaluateDecisionOption } = await import(`${pathToFileURL(decisionFactorBundlePath).href}?test=${Date.now()}`);
  const { advanceSharedRelationshipExperience } = await import(`${pathToFileURL(monthlyProcessesBundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(319, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const founding = state.world.past.find((event) => event.kind === 'environment' && event.change === 'founding');
  assert.ok(founding, '开局必须存在先民共同抵达事实');
  assert.deepEqual([...founding.diff.participantIds].sort(), state.people.map((person) => person.id).sort());
  assert.ok(state.people.every((person) => person.relations.every((relation) => (
    relation.trust === 55
    && relation.bond === 55
    && relation.fear === 0
    && relation.sourceEventIds.length === 1
    && relation.sourceEventIds[0] === founding.id
  ))), '先民的初始关系必须双向为 55 且有来源');

  const female = state.people.find((person) => person.sex === 'female') ?? state.people[0];
  const male = state.people.find((person) => person.sex === 'male' && person.id !== female.id) ?? state.people[1];
  female.sex = 'female';
  male.sex = 'male';
  female.bornAtMonth = -24 * 12;
  male.bornAtMonth = -24 * 12;
  female.body = { health: 100, hydration: 100, nutrition: 100 };
  male.body = { health: 100, hydration: 100, nutrition: 100 };
  female.conditions = [];
  male.conditions = [];
  male.position = structuredClone(female.position);
  state.people = [female, male];

  const directedRelation = female.relations.find((relation) => relation.personId === male.id);
  const reciprocalRelation = male.relations.find((relation) => relation.personId === female.id);
  Object.assign(directedRelation, { trust: 19, bond: 19, sourceEventIds: [founding.id] });
  Object.assign(reciprocalRelation, { trust: 19, bond: 19, sourceEventIds: [founding.id] });
  let context = buildDecisionContexts(state).find((candidate) => candidate.person.id === female.id);
  assert.equal(context?.options.some((option) => option.id.startsWith('offer-companion:')), false, '关系 19/19 时不得提出结伴');
  Object.assign(directedRelation, { trust: 20, bond: 20 });
  Object.assign(reciprocalRelation, { trust: 20, bond: 20 });
  context = buildDecisionContexts(state).find((candidate) => candidate.person.id === female.id);
  assert.ok(context?.options.some((option) => option.id.startsWith('offer-companion:')), '关系 20/20 且有共同事实时应允许提出结伴');

  Object.assign(directedRelation, { trust: 55, bond: 55, sourceEventIds: [founding.id] });
  Object.assign(reciprocalRelation, { trust: 55, bond: 55, sourceEventIds: [founding.id] });
  context = buildDecisionContexts(state).find((candidate) => candidate.person.id === female.id);
  assert.equal(context?.options.some((option) => option.id.startsWith('offer-reproduce:')), false, '先民初始关系 55 不应立即解锁生殖');
  const sharedActionTicks = (atMonth, tickCount, first = female, second = male) => Array.from({ length: tickCount }, (_, index) => index + 1)
    .flatMap((actionTick) => [first, second].map((actor, actorIndex) => ({
      id: `test-shared-action-${atMonth}-${actionTick}-${actor.id}`,
      kind: 'action', actionTick, atMonth, orderInMonth: actionTick * 2 + actorIndex,
      cellId: first.position.cellId, who: actor.id, cause: 'intent',
      action: { kind: 'attend', target: { kind: 'person', personId: actor.id === first.id ? second.id : first.id } },
      fromCellId: first.position.cellId, toCellId: first.position.cellId,
      fromZ: first.position.z, toZ: first.position.z, pathSegment: [first.position.cellId],
      status: 'completed', result: '共同活动', diff: {},
    })));
  assert.equal(advanceSharedRelationshipExperience(state, sharedActionTicks(0, 4), 0).length, 0, '同月不足五个共同活动刻度不得增加关系');
  const fullMonthSharedState = structuredClone(state);
  const fullMonthFacts = advanceSharedRelationshipExperience(fullMonthSharedState, sharedActionTicks(0, 15), 0);
  assert.equal(fullMonthFacts[0]?.diff.trustDelta, 3, '同月十五个共同活动刻度应按每五刻度累计三次关系增长');
  assert.equal(
    fullMonthSharedState.people.find((person) => person.id === female.id).relations.find((relation) => relation.personId === male.id).bond,
    58,
  );
  for (let month = 1; month <= 4; month += 1) {
    const sharedActions = sharedActionTicks(month, 5);
    const sharedFacts = advanceSharedRelationshipExperience(state, sharedActions, month);
    state.world.past.push(...sharedActions, ...sharedFacts);
    state.clock.elapsedMonths = month;
  }
  context = buildDecisionContexts(state).find((candidate) => candidate.person.id === female.id);
  assert.equal(directedRelation.trust, 59);
  assert.equal(directedRelation.bond, 59);
  assert.equal(context?.options.some((option) => option.id.startsWith('offer-reproduce:')), false, '四个月每月五个共同活动刻度后的 59/59 仍不得提出生殖');
  const fifthMonthActions = sharedActionTicks(5, 5);
  const fifthMonthFacts = advanceSharedRelationshipExperience(state, fifthMonthActions, 5);
  state.world.past.push(...fifthMonthActions, ...fifthMonthFacts);
  state.clock.elapsedMonths = 5;
  context = buildDecisionContexts(state).find((candidate) => candidate.person.id === female.id);
  assert.equal(directedRelation.trust, 60);
  assert.equal(directedRelation.bond, 60);
  assert.ok(context?.options.some((option) => option.id.startsWith('offer-reproduce:')), `五个月每月五个共同活动刻度达到双方 60/60 后应允许提出生殖；实际选项：${context?.options.map((option) => option.id).join(',')}`);
  reciprocalRelation.trust = 59;
  context = buildDecisionContexts(state).find((candidate) => candidate.person.id === female.id);
  assert.equal(context?.options.some((option) => option.id.startsWith('offer-reproduce:')), false, '任一方低于生殖门槛时都不得提出生殖');
  reciprocalRelation.trust = 60;
  Object.assign(directedRelation, { trust: 60, bond: 60, sourceEventIds: [] });
  context = buildDecisionContexts(state).find((candidate) => candidate.person.id === female.id);
  assert.equal(context?.options.some((option) => option.id.startsWith('offer-reproduce:')), false, '没有真实来源时关系分数仍不得解锁生殖');
  directedRelation.sourceEventIds = [founding.id];

  const actionFact = (id, atMonth, who, action) => ({
    id, kind: 'action', actionTick: 1, atMonth, orderInMonth: 0,
    cellId: female.position.cellId, who, cause: 'intent', action,
    fromCellId: female.position.cellId, toCellId: female.position.cellId,
    fromZ: female.position.z, toZ: female.position.z, pathSegment: [female.position.cellId],
    status: 'completed', result: id, diff: {},
  });
  const agreementId = 'test-independent-reproduction-attempts';
  recordAgreementAction(state, actionFact('test-reproduction-offer', 1, female.id, {
    kind: 'communicate',
    content: { id: agreementId, kind: 'offer', summary: '共同尝试生殖', proposal: { kind: 'reproduce', proposerId: female.id, partnerId: male.id, expiresAtMonth: 3 } },
    audience: [male.id], channel: 'voice',
  }));
  recordAgreementAction(state, actionFact('test-reproduction-acceptance', 1, male.id, {
    kind: 'communicate',
    content: { id: 'test-reproduction-acceptance-content', kind: 'accept', referenceId: agreementId },
    audience: [female.id], channel: 'voice',
  }));

  const reproduceAction = { kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: male.id }], authorizationRef: agreementId };
  const conflictState = structuredClone(state);
  conflictState.clock.elapsedMonths = 2;
  const conflictFemale = conflictState.people.find((person) => person.id === female.id);
  const conflictMale = conflictState.people.find((person) => person.id === male.id);
  const attack = executePrimitiveAction(
    conflictState,
    conflictFemale,
    { kind: 'act', operation: 'exert', targets: [{ kind: 'person', personId: conflictMale.id }] },
    2,
    0,
    { cause: 'intent', actionTick: 1 },
  );
  assert.equal(attack.status, 'completed');
  assert.equal(advanceSharedRelationshipExperience(conflictState, [...sharedActionTicks(2, 5), attack], 2).length, 0, '发生直接伤害的双方当月不得获得共同活动关系加成');
  const conflictContext = buildDecisionContexts(conflictState).find((candidate) => candidate.person.id === conflictFemale.id);
  assert.equal(conflictContext?.options.some((option) => option.id.startsWith('reproduce:')), false, '伤害使任一方关系跌破 60 后不得继续执行生殖');
  assert.ok(conflictContext?.options.some((option) => option.id.startsWith('withdraw-reproduce:')), '关系跌破门槛后仍应保留撤回同意选项');
  const blockedAfterAttack = executePrimitiveAction(conflictState, conflictFemale, reproduceAction, 2, 1, { cause: 'intent', actionTick: 2 });
  assert.equal(blockedAfterAttack.status, 'blocked', '刚发生伤害后不能凭旧协议直接生殖');
  assert.equal(blockedAfterAttack.diff.relationshipReady, false);

  const highRelationConflictState = structuredClone(state);
  highRelationConflictState.clock.elapsedMonths = 2;
  const highRelationFemale = highRelationConflictState.people.find((person) => person.id === female.id);
  const highRelationMale = highRelationConflictState.people.find((person) => person.id === male.id);
  Object.assign(highRelationFemale.relations.find((relation) => relation.personId === highRelationMale.id), { trust: 100, bond: 100 });
  Object.assign(highRelationMale.relations.find((relation) => relation.personId === highRelationFemale.id), { trust: 100, bond: 100 });
  const highRelationAttack = executePrimitiveAction(
    highRelationConflictState,
    highRelationFemale,
    { kind: 'act', operation: 'exert', targets: [{ kind: 'person', personId: highRelationMale.id }] },
    2,
    0,
    { cause: 'intent', actionTick: 1 },
  );
  assert.ok(highRelationMale.relations.find((relation) => relation.personId === highRelationFemale.id).trust >= 60, '高关系承受一次伤害后仍可保持在生殖门槛以上');
  assert.equal(advanceSharedRelationshipExperience(highRelationConflictState, [...sharedActionTicks(2, 5), highRelationAttack], 2).length, 0, '即使关系仍高，发生伤害的双方当月也不获得额外共同活动加成');
  const highRelationConflictContext = buildDecisionContexts(highRelationConflictState).find((candidate) => candidate.person.id === highRelationFemale.id);
  assert.ok(highRelationConflictContext?.options.some((option) => option.id.startsWith('reproduce:')), '伤害后双方关系仍在 60 以上时，旧生殖协议仍可执行');
  const highRelationAttempt = executePrimitiveAction(highRelationConflictState, highRelationFemale, reproduceAction, 2, 1, { cause: 'intent', actionTick: 2 });
  assert.equal(highRelationAttempt.status, 'completed');

  const attemptStateA = structuredClone(state);
  const attemptStateB = structuredClone(state);
  const attemptA = executePrimitiveAction(attemptStateA, attemptStateA.people.find((person) => person.id === female.id), reproduceAction, 2, 0, { cause: 'intent', actionTick: 1 });
  const attemptB = executePrimitiveAction(attemptStateB, attemptStateB.people.find((person) => person.id === female.id), reproduceAction, 2, 1, { cause: 'intent', actionTick: 2 });
  assert.equal(attemptA.status, 'completed');
  assert.equal(attemptB.status, 'completed');
  assert.equal(attemptA.diff.chance, 0.28, '承载上限以下、身体状态良好时应使用提高后的基础受孕概率');
  assert.equal(attemptB.diff.chance, 0.28);
  assert.notEqual(attemptA.diff.sampleKey, attemptB.diff.sampleKey, '同月两次真实动作必须拥有不同采样键');
  assert.equal(attemptA.diff.sample, seededFraction(state.seed, attemptA.diff.sampleKey), '样本必须可由事件键确定性重放');
  assert.equal(attemptB.diff.sample, seededFraction(state.seed, attemptB.diff.sampleKey));
  assert.equal(attemptA.diff.conceived, false, '该固定样本用于检查未受孕后的窗口延续');
  assert.equal(attemptStateA.agreements[0].status, 'active', '未受孕只记录一次尝试，不应提前结算整个有界窗口');
  assert.deepEqual(attemptStateA.agreements[0].reproductionAttemptEventIds, [attemptA.id]);
  assert.equal(attemptStateA.agreements[0].lastReproductionAttemptAtMonth, 2);
  const repeatedAttempt = executePrimitiveAction(attemptStateA, attemptStateA.people.find((person) => person.id === female.id), reproduceAction, 2, 2, { cause: 'intent', actionTick: 3 });
  assert.equal(repeatedAttempt.status, 'blocked', '同一窗口在同一自然月不得支持第二次概率抽样');
  assert.equal(repeatedAttempt.diff.attemptedThisMonth, true);
  const reciprocalAgreementId = 'test-reciprocal-reproduction-window';
  recordAgreementAction(attemptStateA, actionFact('test-reciprocal-reproduction-offer', 2, male.id, {
    kind: 'communicate',
    content: { id: reciprocalAgreementId, kind: 'offer', summary: '反向提出共同尝试', proposal: { kind: 'reproduce', proposerId: male.id, partnerId: female.id, expiresAtMonth: 4 } },
    audience: [female.id], channel: 'voice',
  }));
  recordAgreementAction(attemptStateA, actionFact('test-reciprocal-reproduction-acceptance', 2, female.id, {
    kind: 'communicate',
    content: { id: 'test-reciprocal-reproduction-acceptance-content', kind: 'accept', referenceId: reciprocalAgreementId },
    audience: [male.id], channel: 'voice',
  }));
  const reciprocalAttempt = executePrimitiveAction(attemptStateA, attemptStateA.people.find((person) => person.id === male.id), {
    kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: female.id }], authorizationRef: reciprocalAgreementId,
  }, 2, 3, { cause: 'intent', actionTick: 4 });
  assert.equal(reciprocalAttempt.status, 'blocked', '互为提议者的重叠窗口也不能让同一对人物在同月重复抽样');
  assert.equal(reciprocalAttempt.diff.attemptedThisMonth, true);
  assert.deepEqual(attemptStateA.agreements.find((agreement) => agreement.id === reciprocalAgreementId).reproductionAttemptEventIds, undefined,
    '失败的第二次动作不得被错误记到另一个协议实体');
  attemptStateA.clock.elapsedMonths = 3;
  const nextMonthContext = buildDecisionContexts(attemptStateA).find((candidate) => candidate.person.id === female.id);
  assert.ok(nextMonthContext?.options.some((option) => option.id.startsWith('reproduce:')), '未受孕后的下一自然月应允许双方重新评估并继续同一窗口');

  const boundedWindowState = structuredClone(state);
  const boundedAgreement = boundedWindowState.agreements[0];
  for (const month of [1, 2, 3, 4]) recordAgreementAction(boundedWindowState, {
    ...actionFact(`test-window-no-conception-${month}`, month, female.id, reproduceAction),
    diff: { conceived: false },
  });
  assert.equal(boundedAgreement.status, 'active', '四个自然月内的未受孕尝试都只形成窗口进展');
  assert.equal(boundedAgreement.reproductionAttemptEventIds.length, 4);
  advanceAgreementLifecycle(boundedWindowState, 5);
  assert.equal(boundedAgreement.status, 'expired', '四个月窗口没有受孕时应明确过期');

  const conceptionState = structuredClone(state);
  const conceptionFact = {
    ...actionFact('test-window-conception', 2, female.id, reproduceAction),
    diff: { conceived: true },
  };
  recordAgreementAction(conceptionState, conceptionFact);
  assert.equal(conceptionState.agreements[0].status, 'fulfilled', '窗口内真实受孕应立即履行并结束协议');
  assert.deepEqual(conceptionState.agreements[0].fulfillmentEventIds, [conceptionFact.id]);

  state.agreements[0].status = 'expired';
  state.agreements[0].resolvedAtMonth = 5;
  state.clock.elapsedMonths = 10;
  context = buildDecisionContexts(state).find((candidate) => candidate.person.id === female.id);
  assert.equal(context?.options.some((option) => option.id.startsWith('offer-reproduce:')), false, '未受孕窗口到期后仍必须经过冷却期才能再次提议');
  state.clock.elapsedMonths = 11;
  context = buildDecisionContexts(state).find((candidate) => candidate.person.id === female.id);
  assert.ok(context?.options.some((option) => option.id.startsWith('offer-reproduce:')), '未受孕窗口到期六个月后可重新评估，不必等待偶然的新共同事件');

  const responsibilityState = structuredClone(state);
  responsibilityState.clock.elapsedMonths = 2;
  responsibilityState.agreements[0].status = 'active';
  responsibilityState.agreements[0].acceptedAtMonth = 1;
  responsibilityState.agreements[0].dueAtMonth = 5;
  responsibilityState.agreements[0].resolvedAtMonth = undefined;
  const infant = structuredClone(male);
  infant.id = 'test-dependent-infant';
  infant.name = '幼儿';
  infant.bornAtMonth = 1;
  infant.geneticParents = [female.id, male.id];
  infant.generation = 1;
  infant.conditions = [];
  infant.relations = [];
  infant.body = { health: 100, hydration: 100, nutrition: 100 };
  responsibilityState.people.push(infant);
  responsibilityState.people.find((person) => person.id === female.id).relations.push({
    personId: infant.id, trust: 0, bond: 12, fear: 0, sourceEventIds: [founding.id],
  });
  const responsibilityContext = buildDecisionContexts(responsibilityState).find((candidate) => candidate.person.id === female.id);
  const proceed = responsibilityContext?.options.find((option) => option.id.startsWith('reproduce:'));
  const withdraw = responsibilityContext?.options.find((option) => option.id.startsWith('withdraw-reproduce:'));
  assert.ok(proceed && withdraw, '有效尝试窗口必须同时提供继续与撤回两个合法选项');
  const moment = { atMonth: 2, planningTick: 1 };
  assert.ok(
    evaluateDecisionOption(responsibilityContext, withdraw, moment).causalScore
      > evaluateDecisionOption(responsibilityContext, proceed, moment).causalScore,
    '亲生婴幼儿的现有照护负担应让撤回优先于继续尝试',
  );
  const revoked = executePrimitiveAction(
    responsibilityState,
    responsibilityState.people.find((person) => person.id === female.id),
    withdraw.nextAction,
    2,
    3,
    { cause: 'intent', actionTick: 4 },
  );
  assert.equal(revoked.status, 'completed');
  assert.equal(responsibilityState.agreements[0].status, 'cancelled', '任一参与者的撤回应结束尚未完成的尝试窗口');

  const capacityState = structuredClone(state);
  capacityState.clock.elapsedMonths = 2;
  capacityState.agreements[0].status = 'active';
  capacityState.agreements[0].acceptedAtMonth = 1;
  capacityState.agreements[0].dueAtMonth = 13;
  capacityState.agreements[0].resolvedAtMonth = undefined;
  while (capacityState.people.length < 51) {
    const clone = structuredClone(male);
    clone.id = `capacity-person-${capacityState.people.length}`;
    clone.conditions = [];
    capacityState.people.push(clone);
  }
  const capacityAttempt = executePrimitiveAction(capacityState, capacityState.people.find((person) => person.id === female.id), reproduceAction, 2, 2, { cause: 'intent', actionTick: 3 });
  assert.equal(capacityAttempt.status, 'completed');
  assert.equal(capacityAttempt.diff.livingPopulation, 51);
  assert.equal(capacityAttempt.diff.capacityFactor, 0, '超过约 50 人的软承载上限后不得再开始新的妊娠');
  assert.equal(capacityAttempt.diff.conceived, false);

  const birthState = structuredClone(state);
  birthState.clock.elapsedMonths = 0;
  const birthMother = birthState.people.find((person) => person.id === female.id);
  birthMother.conditions = [{
    id: 'test-birth-pregnancy', kind: 'pregnancy', stage: 3, sinceMonth: 0, dueAtMonth: 1,
    otherPersonId: male.id, sourceEventIds: [],
  }];
  birthState.civilization.externalClimate = { epoch: 'stable', kind: 'temperate', severity: 0 };
  for (const person of birthState.people) person.body = { health: 100, hydration: 100, nutrition: 100 };
  const afterBirth = stepSimulation(birthState, { decide: () => ({ kind: 'idle', reason: '只检查出生关系' }) });
  const child = afterBirth.people.find((person) => person.bornAtMonth === 1);
  assert.ok(child, '到期妊娠应产生新生儿');
  const postpartum = afterBirth.people.find((person) => person.id === female.id).conditions.find((condition) => condition.kind === 'postpartum-recovery');
  assert.ok(postpartum?.endsAtMonth > afterBirth.clock.elapsedMonths, '分娩后应留下有明确结束月份的产后恢复状态');
  const postpartumContext = buildDecisionContexts(afterBirth).find((candidate) => candidate.person.id === female.id);
  assert.equal(postpartumContext?.options.some((option) => option.id.startsWith('offer-reproduce:')), false, '产后恢复期间不得开始下一次生殖提议');
  assert.ok(child.relations.every((relation) => !relation.sourceEventIds.includes(founding.id)), '新生儿不得继承先民共同抵达来源');
  assert.ok(child.relations.filter((relation) => !child.geneticParents.includes(relation.personId)).every((relation) => relation.trust === 0 && relation.bond === 0 && relation.fear === 0 && relation.sourceEventIds.length === 0), '新生儿对非父母人物不得自动获得先民关系加成');

  const attachmentState = structuredClone(afterBirth);
  const attachedChild = attachmentState.people.find((person) => person.id === child.id);
  attachedChild.body.hydration = 18;
  const afterAttachmentReflex = stepSimulation(attachmentState, { decide: () => ({ kind: 'idle', reason: '检查幼儿跟随亲代' }) });
  assert.equal(afterAttachmentReflex.world.past.some((event) => event.kind === 'action'
    && event.atMonth === afterAttachmentReflex.clock.elapsedMonths
    && event.who === child.id
    && event.action.kind === 'move'), false, '未满 1 岁的婴儿不能先于同处亲代独自移动');
  const attachedAfterStep = afterAttachmentReflex.people.find((person) => person.id === child.id);
  assert.ok(attachedAfterStep && afterAttachmentReflex.people.some((person) => child.geneticParents.includes(person.id)
    && person.diedAtMonth === undefined
    && person.position.cellId === attachedAfterStep.position.cellId
    && person.position.z === attachedAfterStep.position.z), '幼儿应与至少一名存活亲代保持同处');

  const separatedState = structuredClone(afterBirth);
  const separatedChild = separatedState.people.find((person) => person.id === child.id);
  separatedChild.body.hydration = 18;
  for (const parent of separatedState.people.filter((person) => child.geneticParents.includes(person.id))) {
    parent.position.cellId = parent.position.cellId === 0 ? 1 : 0;
  }
  const separatedStart = { cellId: separatedChild.position.cellId, z: separatedChild.position.z };
  const afterSeparatedReflex = stepSimulation(separatedState, { decide: () => ({ kind: 'idle', reason: '检查幼儿完全依赖亲代' }) });
  const separatedAfterStep = afterSeparatedReflex.people.find((person) => person.id === child.id);
  assert.deepEqual(
    { cellId: separatedAfterStep.position.cellId, z: separatedAfterStep.position.z },
    separatedStart,
    '未满 1 岁的婴儿即使与亲代暂时分离，也不能独自迁移寻找资源',
  );

  for (const seed of [185, 20260815, 20260816]) {
    const relationshipState = createInitialState(seed, { endpoint: { kind: 'months', value: 72 }, chaosIntensity: 0 });
    const first = relationshipState.people.find((person) => person.sex === 'female') ?? relationshipState.people[0];
    const second = relationshipState.people.find((person) => person.sex === 'male' && person.id !== first.id) ?? relationshipState.people[1];
    first.sex = 'female';
    second.sex = 'male';
    first.bornAtMonth = -24 * 12;
    second.bornAtMonth = -24 * 12;
    second.position = structuredClone(first.position);
    relationshipState.people = [first, second];
    const firstRelation = first.relations.find((relation) => relation.personId === second.id);
    const secondRelation = second.relations.find((relation) => relation.personId === first.id);
    Object.assign(firstRelation, { trust: 0, bond: 0, fear: 0, sourceEventIds: [] });
    Object.assign(secondRelation, { trust: 0, bond: 0, fear: 0, sourceEventIds: [] });
    for (let month = 1; month <= 60; month += 1) {
      const sharedActions = sharedActionTicks(month, 5, first, second);
      const facts = advanceSharedRelationshipExperience(relationshipState, sharedActions, month);
      relationshipState.world.past.push(...sharedActions, ...facts);
      relationshipState.clock.elapsedMonths = month;
      if (month === 20) {
        const monthTwenty = buildDecisionContexts(relationshipState).find((candidate) => candidate.person.id === first.id);
        assert.ok(
          monthTwenty?.options.some((option) => option.id.startsWith('offer-companion:')),
          `seed ${seed} 从零共同生活 20 个月应达到结伴门槛（当前 ${firstRelation.trust}/${firstRelation.bond}，关系事实 ${firstRelation.sourceEventIds.length} 条）`,
        );
        assert.equal(monthTwenty?.options.some((option) => option.id.startsWith('offer-reproduce:')), false, `seed ${seed} 在关系 20 时仍不应生殖`);
      }
    }
    const monthSixty = buildDecisionContexts(relationshipState).find((candidate) => candidate.person.id === first.id);
    assert.ok(monthSixty?.options.some((option) => option.id.startsWith('offer-reproduce:')), `seed ${seed} 从零共同生活 60 个月应达到生殖门槛`);
  }

  console.log('reproduction opportunity tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
