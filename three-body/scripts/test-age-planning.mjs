import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-age-planning-test-'));
const bundlePath = path.join(temporaryDirectory, 'age-planning.mjs');
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');

try {
  const testEntry = `
    export { optionAllowedForLifeStage } from ${JSON.stringify(path.resolve('src/game/eland/application/age-planning.ts'))};
    export { classifyActionOption } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-option-semantics.ts'))};
    export { lifePlanningStageForAge } from ${JSON.stringify(path.resolve('src/game/eland/domain/life-stage.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export { findStandingPath, neighbors4 } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=age-planning-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: testEntry, stdio: ['pipe', 'pipe', 'pipe'] });
  const { classifyActionOption, executePrimitiveAction, findStandingPath, lifePlanningStageForAge, neighbors4, optionAllowedForLifeStage } = await import(
    `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
  );
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/simulation.ts', '--bundle', '--platform=node', '--format=esm',
    `--outfile=${simulationBundlePath}`,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const { createInitialState, seededFraction, stepSimulation } = await import(
    `${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`
  );

  assert.equal(lifePlanningStageForAge(0), 'dependent-child');
  assert.equal(lifePlanningStageForAge(1 * 12 - 1), 'dependent-child');
  assert.equal(lifePlanningStageForAge(1 * 12), 'learning-child');
  assert.equal(lifePlanningStageForAge(12 * 12), 'adolescent-worker');
  assert.equal(lifePlanningStageForAge(16 * 12), 'adult');

  const option = (id, extra = {}, semanticOverride = {}) => classifyActionOption({
    id, summary: id, reason: id,
    goal: { kind: 'at-cell', cellId: 1 },
    nextAction: { kind: 'move', toCellId: 1 },
    estimatedDuration: 'one-month', sourceFactIds: [], ...extra,
  }, semanticOverride);
  const collect = option('collect:food', {}, {
    purpose: 'resource', minimumLifeStage: 'learning-child', needKinds: ['reserve'],
  });
  const drink = option('drink:1:1:1', { nextAction: { kind: 'act', operation: 'ingest', targets: [] } });
  const gatherWood = option('separate:wood:1', { nextAction: { kind: 'act', operation: 'separate', targets: [] } }, {
    purpose: 'resource', minimumLifeStage: 'learning-child', needKinds: ['reserve', 'capability'],
  });
  const observe = option('attend:stone', { nextAction: { kind: 'attend', target: { kind: 'voxel', position: { x: 1, y: 1, z: 1 } } } });
  const transformation = option('try-combine:seed:soil');
  const projectWork = option('project:kiln:place', { projectId: 'kiln-project' });
  const projectProposal = option('project-proposal', { projectProposal: {} });
  const reproduction = option('offer-reproduce:person-a:person-b', {
    domain: 'social', target: { kind: 'person', personId: 'person-b' },
    goal: { kind: 'representation-made', representationId: 'reproduction-offer' },
    nextAction: {
      kind: 'communicate', channel: 'voice', audience: ['person-b'],
      content: {
        id: 'reproduction-offer', kind: 'offer', summary: '共同生殖提议',
        proposal: { kind: 'reproduce', proposerId: 'person-a', partnerId: 'person-b', expiresAtMonth: 12 },
      },
    },
  });

  assert.equal(optionAllowedForLifeStage('dependent-child', collect), false, '未满 1 岁不发起普通规划');
  assert.equal(optionAllowedForLifeStage('learning-child', collect), true, '1–11 岁可以采集');
  assert.equal(optionAllowedForLifeStage('learning-child', drink), true, '1–11 岁可以自行前往水源取水');
  assert.equal(optionAllowedForLifeStage('learning-child', gatherWood), true, '1–11 岁可以进行拾柴等简单劳动');
  assert.equal(optionAllowedForLifeStage('learning-child', observe), true, '1–11 岁可以观察学习');
  assert.equal(optionAllowedForLifeStage('learning-child', transformation), false, '1–11 岁不独立主持复杂生产');
  assert.equal(optionAllowedForLifeStage('learning-child', projectWork), false, '1–11 岁不参与正式项目');
  assert.equal(optionAllowedForLifeStage('adolescent-worker', projectWork), true, '12–15 岁可以参与既有项目');
  assert.equal(optionAllowedForLifeStage('adolescent-worker', projectProposal), false, '12–15 岁不能发起重大项目');
  assert.equal(optionAllowedForLifeStage('adolescent-worker', reproduction), false, '12–15 岁不能繁衍');
  assert.equal(optionAllowedForLifeStage('adult', projectProposal), true, '16 岁以上拥有完整规划能力');

  const monthlyState = createInitialState(20260815, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const youngFounderIds = new Set(monthlyState.people.map((person) => person.id));
  const reviewedFounderIds = new Set();
  for (const founder of monthlyState.people) founder.bornAtMonth = -10 * 12;
  stepSimulation(monthlyState, {
    decide(context) {
      if (youngFounderIds.has(context.person.id)) {
        reviewedFounderIds.add(context.person.id);
        assert.equal(context.options.some((candidate) => candidate.projectId), false, '真实月度入口不能让 1–11 岁先民绕过项目权限');
      }
      return { kind: 'idle', reason: '只检查年龄候选过滤' };
    },
  });
  assert.deepEqual(reviewedFounderIds, youngFounderIds, '创世 bootstrap 必须且仍会在实际提交的第 1 月让全部先民获得一次决策');

  const forceNaturalDecisionSample = (state, person, atMonth, label) => {
    for (let index = 0; index < 10_000; index += 1) {
      state.branchId = `${label}-${index}`;
      if (seededFraction(state.seed, `decision:${state.branchId}:${atMonth}:${person.id}`) < 0.04) return;
    }
    assert.fail(`无法为${label}构造确定性的月度决策样本`);
  };
  const prepareBoundaryPeople = (state, actor, other) => {
    state.civilization.conditions.endpoint = { kind: 'months', value: 1_000 };
    state.people = [actor, other];
    for (const person of state.people) {
      person.body = { health: 100, hydration: 100, nutrition: 100 };
      person.conditions = [];
      delete person.activeIntentId;
    }
    other.position = structuredClone(actor.position);
  };

  const oneYearState = createInitialState(7101, { endpoint: { kind: 'months', value: 1_000 }, chaosIntensity: 0 });
  oneYearState.clock.elapsedMonths = 11;
  const oneYearChild = oneYearState.people[0];
  const oneYearParent = oneYearState.people[1];
  prepareBoundaryPeople(oneYearState, oneYearChild, oneYearParent);
  oneYearChild.generation = 1;
  oneYearChild.geneticParents = [oneYearParent.id];
  oneYearChild.bornAtMonth = 0;
  oneYearChild.knowledge = [];
  oneYearParent.bornAtMonth = -24 * 12;
  forceNaturalDecisionSample(oneYearState, oneYearChild, 12, 'age-one-boundary');
  let oneYearContextSeen = false;
  const afterOneYearBoundary = stepSimulation(oneYearState, {
    decide(context) {
      if (context.person.id !== oneYearChild.id) return { kind: 'idle', reason: '不干扰一岁边界测试' };
      oneYearContextSeen = true;
      assert.ok(context.options.length > 0, '满 1 岁的提交月必须向 decider 暴露学习儿童候选');
      assert.ok(context.options.every((candidate) => optionAllowedForLifeStage('learning-child', candidate)),
        '满 1 岁提交月的候选必须全部服从 learning-child 权限');
      const observeOption = context.options.find((candidate) => candidate.id.startsWith('attend:'));
      assert.ok(observeOption, '满 1 岁的儿童应能选择一个眼前观察行动');
      return { kind: 'start', optionId: observeOption.id, reason: '验证一岁边界的同月自主行动' };
    },
  });
  assert.equal(oneYearContextSeen, true);
  assert.ok(afterOneYearBoundary.lastStep.some((event) => event.kind === 'action'
    && event.who === oneYearChild.id
    && event.atMonth === 12
    && event.action.kind === 'attend'
    && event.status === 'completed'),
  'decider 在第 12 月看到的 learning-child 行动必须由同样按第 12 月判断的执行刻度真正执行');

  const twelveYearState = createInitialState(7112, { endpoint: { kind: 'months', value: 1_000 }, chaosIntensity: 0 });
  twelveYearState.clock.elapsedMonths = 12 * 12 - 1;
  const twelveYearTeacher = twelveYearState.people[0];
  const twelveYearLearner = twelveYearState.people[1];
  prepareBoundaryPeople(twelveYearState, twelveYearTeacher, twelveYearLearner);
  twelveYearTeacher.generation = 1;
  twelveYearTeacher.bornAtMonth = 0;
  twelveYearLearner.bornAtMonth = -24 * 12;
  const boundaryTechniqueId = 'technique:age-boundary-teaching';
  twelveYearTeacher.knowledge = [{
    id: boundaryTechniqueId, kind: 'technique', summary: '年龄边界教学技术', confidence: 72,
    learnedAtMonth: 100, sourceEventIds: ['age-boundary-technique-source'],
  }];
  twelveYearLearner.knowledge = twelveYearLearner.knowledge.filter((fact) => fact.id !== boundaryTechniqueId);
  forceNaturalDecisionSample(twelveYearState, twelveYearTeacher, 12 * 12, 'age-twelve-boundary');
  let twelveYearContextSeen = false;
  const afterTwelveYearBoundary = stepSimulation(twelveYearState, {
    decide(context) {
      if (context.person.id !== twelveYearTeacher.id) return { kind: 'idle', reason: '不干扰十二岁边界测试' };
      if (twelveYearContextSeen) return { kind: 'idle', reason: '首个边界候选已验证，不重复要求同月教学' };
      twelveYearContextSeen = true;
      assert.ok(context.options.every((candidate) => optionAllowedForLifeStage('adolescent-worker', candidate)),
        '满 12 岁提交月的候选必须全部服从 adolescent-worker 权限');
      const teachOption = context.options.find((candidate) => candidate.id.startsWith(`teach:${12 * 12}:`)
        && candidate.nextAction.kind === 'communicate'
        && candidate.nextAction.content.kind === 'claim'
        && candidate.nextAction.content.factId === boundaryTechniqueId);
      assert.ok(teachOption, '满 12 岁的提交月必须立即出现此前 learning-child 阶段不允许的教学候选');
      return { kind: 'start', optionId: teachOption.id, reason: '验证十二岁边界的同月教学行动' };
    },
  });
  assert.equal(twelveYearContextSeen, true);
  const teachingAction = afterTwelveYearBoundary.lastStep.find((event) => event.kind === 'action'
    && event.who === twelveYearTeacher.id
    && event.atMonth === 12 * 12
    && event.action.kind === 'communicate'
    && event.diff.teachingFactId === boundaryTechniqueId);
  assert.equal(teachingAction?.status, 'completed',
    'decider 在满 12 岁提交月看到的教学候选必须在同月被执行器接受');
  assert.ok(afterTwelveYearBoundary.people.find((person) => person.id === twelveYearLearner.id)?.knowledge
    .some((fact) => fact.id === boundaryTechniqueId && fact.confidence >= 60),
  '真实教学动作必须把可靠技术传给受教者');

  const sixteenYearState = createInitialState(7116, { endpoint: { kind: 'months', value: 1_000 }, chaosIntensity: 0 });
  sixteenYearState.clock.elapsedMonths = 16 * 12 - 1;
  const sixteenYearFemale = sixteenYearState.people.find((person) => person.sex === 'female') ?? sixteenYearState.people[0];
  const sixteenYearMale = sixteenYearState.people.find((person) => person.sex === 'male' && person.id !== sixteenYearFemale.id)
    ?? sixteenYearState.people.find((person) => person.id !== sixteenYearFemale.id);
  assert.ok(sixteenYearMale, '十六岁边界测试需要两名人物');
  sixteenYearFemale.sex = 'female';
  sixteenYearMale.sex = 'male';
  prepareBoundaryPeople(sixteenYearState, sixteenYearFemale, sixteenYearMale);
  sixteenYearFemale.generation = 1;
  sixteenYearMale.generation = 1;
  sixteenYearFemale.bornAtMonth = 0;
  sixteenYearMale.bornAtMonth = 0;
  const sharedExperience = executePrimitiveAction(
    sixteenYearState, sixteenYearFemale,
    { kind: 'attend', target: { kind: 'person', personId: sixteenYearMale.id } },
    16 * 12 - 2, 0, { cause: 'intent', actionTick: 1 },
  );
  assert.equal(sharedExperience.status, 'completed');
  sixteenYearState.world.past.push(sharedExperience);
  Object.assign(sixteenYearFemale.relations.find((relation) => relation.personId === sixteenYearMale.id), {
    trust: 65, bond: 65, sourceEventIds: [sharedExperience.id],
  });
  Object.assign(sixteenYearMale.relations.find((relation) => relation.personId === sixteenYearFemale.id), {
    trust: 65, bond: 65, sourceEventIds: [sharedExperience.id],
  });
  const boundaryReproductionOfferId = 'age-sixteen-reproduction-offer';
  const boundaryReproductionOffer = executePrimitiveAction(sixteenYearState, sixteenYearMale, {
    kind: 'communicate',
    content: {
      id: boundaryReproductionOfferId, kind: 'offer', summary: '是否愿意共同生育后代',
      proposal: {
        kind: 'reproduce', proposerId: sixteenYearMale.id, partnerId: sixteenYearFemale.id,
        expiresAtMonth: 16 * 12 + 4,
      },
    },
    audience: [sixteenYearFemale.id], channel: 'voice',
  }, 16 * 12 - 1, 1, { cause: 'intent', actionTick: 1 });
  assert.equal(boundaryReproductionOffer.status, 'completed');
  sixteenYearState.world.past.push(boundaryReproductionOffer);
  assert.equal(sixteenYearState.agreements.find((agreement) => agreement.id === boundaryReproductionOfferId)?.status, 'proposed');
  let sixteenYearContextSeen = false;
  const afterSixteenYearBoundary = stepSimulation(sixteenYearState, {
    decide(context) {
      if (context.person.id !== sixteenYearFemale.id) return { kind: 'idle', reason: '不干扰十六岁边界测试' };
      if (sixteenYearContextSeen) return { kind: 'idle', reason: '首个边界候选已验证，不重复要求同月接受' };
      sixteenYearContextSeen = true;
      assert.ok(context.options.every((candidate) => optionAllowedForLifeStage('adult', candidate)),
        '满 16 岁提交月的候选必须服从 adult 权限');
      const acceptance = context.options.find((candidate) => candidate.id.startsWith(`accept-reproduce:${boundaryReproductionOfferId}`));
      assert.ok(acceptance, '双方在提交月满 16 岁时，decider 必须立即看到可执行的生殖接受候选');
      return { kind: 'start', optionId: acceptance.id, reason: '验证十六岁边界的同月协议接受与执行' };
    },
  });
  assert.equal(sixteenYearContextSeen, true);
  const sixteenYearReproductionAttempts = afterSixteenYearBoundary.lastStep.filter((event) => event.kind === 'action'
    && event.who === sixteenYearFemale.id
    && event.atMonth === 16 * 12
    && event.action.kind === 'act'
    && event.action.operation === 'reproduce');
  assert.equal(sixteenYearReproductionAttempts.length, 1,
    '一个真实 stepSimulation 的 15 个规划刻度内，同一生殖 pair 最多只能抽样一次');
  assert.equal(sixteenYearReproductionAttempts[0]?.status, 'completed',
    'decider 在满 16 岁提交月看到的生殖候选必须由同样按该月判龄的执行器完成');

  const movementState = createInitialState(20260816, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const parent = movementState.people[0];
  const child = movementState.people[1];
  child.generation = 1;
  child.geneticParents = [parent.id];
  child.position = structuredClone(parent.position);
  const destination = neighbors4(parent.position.cellId)
    .find((cellId) => findStandingPath(movementState.world.grid, parent.position, { cellId }).length > 1);
  assert.ok(Number.isInteger(destination), '年龄移动测试需要相邻的可达地表格');

  child.bornAtMonth = 0;
  const infantState = structuredClone(movementState);
  const infantParent = infantState.people.find((person) => person.id === parent.id);
  const infantChild = infantState.people.find((person) => person.id === child.id);
  const infantMove = executePrimitiveAction(
    infantState, infantParent, { kind: 'move', toCellId: destination }, 11, 0,
    { cause: 'intent', actionTick: 1 },
  );
  assert.ok(infantMove.diff.carriedPersonIds?.includes(child.id), '未满 1 岁的清醒婴儿应被同处亲代携带');
  assert.deepEqual(infantChild.position, infantParent.position, '被携带婴儿应与亲代到达同一位置');

  const autonomousState = structuredClone(movementState);
  const autonomousParent = autonomousState.people.find((person) => person.id === parent.id);
  const autonomousChild = autonomousState.people.find((person) => person.id === child.id);
  const autonomousStart = structuredClone(autonomousChild.position);
  const autonomousMove = executePrimitiveAction(
    autonomousState, autonomousParent, { kind: 'move', toCellId: destination }, 12, 0,
    { cause: 'intent', actionTick: 1 },
  );
  assert.equal(autonomousMove.diff.carriedPersonIds, undefined, '满 1 岁后不再被亲代移动自动携带');
  assert.deepEqual(autonomousChild.position, autonomousStart, '满 1 岁的儿童应保持自己的位置，由本人选择后续行动');

  const sleepingState = structuredClone(movementState);
  const sleepingParent = sleepingState.people.find((person) => person.id === parent.id);
  const sleepingChild = sleepingState.people.find((person) => person.id === child.id);
  sleepingChild.conditions.push({
    id: 'test-sleeping-infant', kind: 'dehydrated-hibernation', stage: 1, sinceMonth: 0, sourceEventIds: [],
  });
  const sleepingStart = structuredClone(sleepingChild.position);
  const sleepingMove = executePrimitiveAction(
    sleepingState, sleepingParent, { kind: 'move', toCellId: destination }, 11, 0,
    { cause: 'intent', actionTick: 1 },
  );
  assert.equal(sleepingMove.diff.carriedPersonIds, undefined, '脱水休眠的婴儿不得随亲代移动');
  assert.deepEqual(sleepingChild.position, sleepingStart, '脱水休眠的婴儿必须保持原位置');

  const sleepingActorMove = executePrimitiveAction(
    sleepingState, sleepingChild, { kind: 'move', toCellId: destination }, 11, 1,
    { cause: 'intent', actionTick: 1 },
  );
  assert.equal(sleepingActorMove.status, 'blocked', '脱水休眠者本人的移动也必须被领域执行器拒绝');

  process.stdout.write('age planning tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
