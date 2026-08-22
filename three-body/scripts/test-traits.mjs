import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-traits-test-'));
const bundles = {
  simulation: path.join(temporaryDirectory, 'simulation.mjs'),
  traits: path.join(temporaryDirectory, 'traits.mjs'),
  monthly: path.join(temporaryDirectory, 'monthly.mjs'),
  executor: path.join(temporaryDirectory, 'executor.mjs'),
};

try {
  for (const [entry, output] of [
    ['src/game/eland/simulation.ts', bundles.simulation],
    ['src/game/eland/domain/trait.ts', bundles.traits],
    ['src/game/eland/domain/monthly-processes.ts', bundles.monthly],
    ['src/game/eland/domain/action-executor.ts', bundles.executor],
  ]) execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
  ], { stdio: 'pipe' });

  const simulation = await import(`${pathToFileURL(bundles.simulation).href}?test=${Date.now()}`);
  const traits = await import(`${pathToFileURL(bundles.traits).href}?test=${Date.now()}`);
  const { advanceBodies, pregnancyLossChance } = await import(`${pathToFileURL(bundles.monthly).href}?test=${Date.now()}`);
  const { executePrimitiveAction } = await import(`${pathToFileURL(bundles.executor).href}?test=${Date.now()}`);

  assert.equal(traits.PERSON_TRAITS.length, 13, '应有十种遗传特质和三种随机异变特质');
  assert.ok(traits.PERSON_TRAITS.every((trait) => Array.from(trait.name).length === 2), '全部特质名都应为两个汉字');
  assert.equal(traits.PERSON_TRAITS.filter((trait) => trait.inheritanceChance > 0).length, 10, '原有十种特质应继续通过遗传产生');
  assert.deepEqual(
    traits.PERSON_TRAITS.filter((trait) => trait.spontaneousChance > 0).map((trait) => trait.id),
    ['succubus', 'twin-bearer', 'gluttonous'],
    '魅魔、双生和饕餮应属于独立的随机异变池',
  );

  const expectedFounderTraits = {
    laozi: ['demi-immortal'],
    pangu: ['demi-immortal', 'iron-boned'],
    nuwa: ['demi-immortal', 'prophet', 'matrilineal'],
    zhugeliang: ['prophet', 'insightful'],
    athena: ['prophet', 'insightful'],
    prometheus: ['prophet', 'heat-born'],
    leonardo: ['artificer', 'insightful'],
    mozi: ['artificer', 'iron-boned'],
    archimedes: ['artificer'],
    cailun: ['artificer'],
    bisheng: ['artificer', 'retentive'],
    xuanzang: ['wayfarer', 'iron-boned'],
    armstrong: ['wayfarer', 'insightful'],
    darwin: ['wayfarer', 'retentive'],
    'sima-qian': ['retentive'],
    heidi: ['cold-born'],
    change: ['cold-born'],
    nausicaa: ['heat-born', 'insightful'],
    tesla: ['prophet', 'artificer'],
    wuzetian: ['matrilineal'],
    cangtianying: ['prophet', 'cold-born', 'matrilineal'],
    zhaotianli: ['heat-born', 'iron-boned', 'matrilineal'],
    zhentianyuan: ['demi-immortal', 'insightful', 'retentive'],
    potianfeng: ['prophet', 'artificer', 'wayfarer'],
  };
  for (const [personId, expected] of Object.entries(expectedFounderTraits)) {
    assert.deepEqual(traits.founderTraitsFor(personId, 'founding').map((trait) => trait.id), expected, `${personId}的固定特质不符`);
  }
  for (const personId of ['cangtianying', 'zhaotianli', 'zhentianyuan', 'potianfeng']) {
    assert.equal(traits.founderTraitsFor(personId, 'founding').length, 3, `${personId}必须拥有三个特质`);
  }

  const traitState = (id) => ({ id, origin: 'founder', inheritedFromPersonIds: [], sourceEventIds: ['test'] });
  const modified = traits.applyTraitCapacityModifiers(
    { locomotion: 50, manipulation: 50, perception: 50, communication: 50, cognition: 50 },
    [traitState('artificer'), traitState('wayfarer'), traitState('insightful')],
  );
  assert.deepEqual(modified, { locomotion: 60, manipulation: 60, perception: 68, communication: 44, cognition: 62 });
  assert.deepEqual(
    traits.applyTraitCapacityModifiers(
      { locomotion: 50, manipulation: 50, perception: 50, communication: 50, cognition: 50 },
      [traitState('gluttonous')],
    ),
    { locomotion: 70, manipulation: 70, perception: 70, communication: 70, cognition: 70 },
    '饕餮应把五项基础能力统一提高 20',
  );
  assert.equal(traits.applyTraitLifespanModifier(800, [traitState('demi-immortal')]), 1200);
  assert.equal(traits.reproductiveUpperAgeMonths({ traits: [traitState('demi-immortal')] }), 810);
  assert.equal(traits.movementMetabolicMultiplier({ traits: [traitState('wayfarer')] }), 0.85);
  assert.equal(traits.nutritionMetabolicMultiplier({ traits: [traitState('gluttonous')] }), 1.5);
  assert.equal(traits.injuryWorseningRiskMultiplier({ traits: [traitState('iron-boned')] }), 0.7);
  assert.equal(traits.injuryRecoveryMultiplier({ traits: [traitState('iron-boned')] }), 1.2);
  assert.equal(traits.memoryCapacityMultiplier({ traits: [traitState('retentive')] }), 1.5);
  assert.equal(traits.memoryDurationMultiplier({ traits: [traitState('retentive')] }), 1.5);
  assert.equal(traits.coldHarmMultiplier({ traits: [traitState('cold-born')] }), 0.6);
  assert.equal(traits.coldHarmMultiplier({ traits: [traitState('heat-born')] }), 1.2);
  assert.equal(traits.heatHarmMultiplier({ traits: [traitState('heat-born')] }), 0.65);
  assert.equal(traits.heatHydrationMultiplier({ traits: [traitState('cold-born')] }), 1.2);

  const mother = { id: 'mother', traits: [traitState('matrilineal'), traitState('artificer'), traitState('cold-born')] };
  const father = { id: 'father', traits: [traitState('artificer'), traitState('heat-born')] };
  const inherited = traits.inheritPersonTraits(73, 'child', mother, father);
  const artificerAttempt = inherited.attempts.find((attempt) => attempt.traitId === 'artificer');
  const matrilinealAttempt = inherited.attempts.find((attempt) => attempt.traitId === 'matrilineal');
  assert.equal(artificerAttempt.chance, 1 - (1 - 0.375) * (1 - 0.25), '母脉应把母亲的其他特质概率提高 1.5 倍后再与父系概率合并');
  assert.equal(matrilinealAttempt.chance, 0.75, '母亲携带母脉时其自身遗传率应为 75%');
  assert.deepEqual(traits.inheritPersonTraits(73, 'child', mother, father), inherited, '遗传必须可回放');
  assert.ok(inherited.traits.length <= 3, '任何人最多三个特质');
  assert.equal(inherited.traits.some((trait) => trait.id === 'cold-born') && inherited.traits.some((trait) => trait.id === 'heat-born'), false, '寒裔与炎裔不得共存');
  const paternalOnly = traits.inheritPersonTraits(73, 'paternal-child', { id: 'plain-mother', traits: [] }, { id: 'line-father', traits: [traitState('matrilineal')] });
  assert.equal(paternalOnly.attempts[0].chance, 0.5, '仅父亲携带母脉时其自身遗传率应为 50%');
  const nonHeritable = traits.inheritPersonTraits(73, 'non-heritable-child', { id: 'mutation-mother', traits: [traitState('gluttonous')] });
  assert.equal(nonHeritable.attempts.some((attempt) => attempt.traitId === 'gluttonous'), false, '随机异变特质不得进入遗传抽样');
  assert.equal(nonHeritable.traits.some((trait) => trait.id === 'gluttonous'), false, '饕餮不能由亲代直接遗传');

  const discoveredSpontaneousTraits = new Set();
  for (const sex of ['female', 'male']) {
    for (let index = 0; index < 5_000; index += 1) {
      const childId = `spontaneous-${sex}-${index}`;
      const spontaneous = traits.spontaneousPersonTraits(73, childId, sex);
      assert.deepEqual(traits.spontaneousPersonTraits(73, childId, sex), spontaneous, '随机异变抽样必须可回放');
      assert.ok(spontaneous.traits.length <= 1, '每个人最多获得一个随机异变特质');
      assert.ok(spontaneous.traits.every((trait) => trait.origin === 'spontaneous' && trait.inheritedFromPersonIds.length === 0));
      if (sex === 'male') assert.equal(spontaneous.traits.some((trait) => trait.id === 'succubus'), false, '魅魔只会在女性出生时随机出现');
      spontaneous.traits.forEach((trait) => discoveredSpontaneousTraits.add(trait.id));
      if (discoveredSpontaneousTraits.size === 3) break;
    }
  }
  assert.deepEqual([...discoveredSpontaneousTraits].sort(), ['gluttonous', 'succubus', 'twin-bearer'], '三种随机异变都应能在无亲代来源时出现');

  const prophetState = simulation.createInitialState(811, {
    characterIds: ['nuwa'], endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0,
  });
  const prophet = prophetState.people.find((person) => person.id === 'nuwa');
  const recipeKnowledge = traits.prophetRecipeKnowledge(0, 'founding');
  assert.equal(recipeKnowledge.length, 47, '先知应覆盖当前全部 47 项规则配方');
  assert.deepEqual(new Set(prophet.knowledge.filter((fact) => fact.kind === 'technique').map((fact) => fact.id)), new Set(recipeKnowledge.map((fact) => fact.id)));
  assert.ok(prophet.knowledge.every((fact) => fact.sourceEventIds.includes('e-0-environment-founding-0')), '先知知识必须有开局事实来源');

  const legacyState = simulation.createInitialState(812, {
    characterIds: ['nuwa'], endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0,
  });
  legacyState.people[0].lifespanMonths = 800;
  legacyState.people[0].baselineCapacities = { locomotion: 50, manipulation: 50, perception: 50, communication: 50, cognition: 50 };
  legacyState.people[0].knowledge = [];
  delete legacyState.people[0].traits;
  const migratedOnce = simulation.restoreSimulationState(legacyState);
  const migratedTwice = simulation.restoreSimulationState(migratedOnce);
  assert.equal(migratedOnce.people[0].lifespanMonths, 1200, '旧状态只在缺少字段时补入半仙寿命效果');
  assert.equal(migratedTwice.people[0].lifespanMonths, 1200, '重复恢复不得重复叠加特质效果');
  assert.equal(migratedOnce.people[0].knowledge.filter((fact) => fact.kind === 'technique').length, 47, '旧先知状态补全后也应掌握全部配方');

  const birthState = simulation.createInitialState(991, {
    characterIds: ['laozi', 'nuwa'], endpoint: { kind: 'months', value: 3 }, chaosIntensity: 0,
  });
  const birthMother = birthState.people.find((person) => person.id === 'nuwa');
  const birthFather = birthState.people.find((person) => person.id === 'laozi');
  birthMother.familyName = '娲';
  birthMother.namingTradition = 'eastern';
  birthFather.familyName = '父姓';
  birthFather.namingTradition = 'western';
  birthMother.body = { health: 100, hydration: 100, nutrition: 100 };
  birthFather.body = { health: 100, hydration: 100, nutrition: 100 };
  birthMother.conditions = [{
    id: 'test-pregnancy', kind: 'pregnancy', stage: 3, sinceMonth: -8, dueAtMonth: 1,
    sourceEventIds: ['test-conception'], otherPersonId: birthFather.id,
  }];
  birthState.people = [birthMother, birthFather];
  const bodyEvents = advanceBodies(birthState, 1);
  birthState.world.past.push(...bodyEvents);
  const child = birthState.people.find((person) => person.id.startsWith('born-'));
  const birthFact = bodyEvents.find((fact) => fact.diff.bornPersonId === child?.id);
  assert.ok(child && birthFact, '到期妊娠应产生带来源的孩子与出生事实');
  assert.equal(child.familyName, '娲', '任一亲代携带母脉时孩子应随母姓');
  assert.equal(child.namingTradition, birthMother.namingTradition, '孩子应采用母亲的命名传统与顺序');
  assert.equal(child.relations.find((relation) => relation.personId === birthMother.id)?.bond, 18, '母子初始羁绊应为 18');
  assert.equal(birthMother.relations.find((relation) => relation.personId === child.id)?.bond, 18, '母亲对孩子的初始羁绊应为 18');
  assert.equal(birthFact.diff.matrilinealBirth, true);
  assert.equal(birthFact.diff.namingParentId, birthMother.id);
  assert.ok(Array.isArray(birthFact.diff.traitInheritanceAttempts), '出生事实应保存完整遗传抽样审计');
  assert.ok(Array.isArray(birthFact.diff.traitSpontaneousAttempts), '出生事实应保存完整随机异变抽样审计');
  assert.ok((child.traits ?? []).every((trait) => trait.sourceEventIds.includes(birthFact.id)), '遗传特质必须引用出生事实');

  const succubusState = simulation.createInitialState(2001, {
    characterIds: ['nuwa', 'laozi'], endpoint: { kind: 'months', value: 3 }, chaosIntensity: 0,
  });
  const succubus = succubusState.people.find((person) => person.sex === 'female');
  const succubusPartner = succubusState.people.find((person) => person.sex === 'male');
  succubus.traits = [traitState('succubus')];
  succubus.bornAtMonth = -60 * 12;
  succubusPartner.bornAtMonth = -24 * 12;
  succubus.body = { health: 40, hydration: 35, nutrition: 30 };
  succubusPartner.body = { health: 40, hydration: 35, nutrition: 30 };
  succubus.conditions = [];
  succubusPartner.conditions = [];
  succubusPartner.position = structuredClone(succubus.position);
  succubus.relations.find((relation) => relation.personId === succubusPartner.id).sourceEventIds = [];
  succubusState.agreements = [];
  const succubusContext = simulation.buildDecisionContexts(succubusState).find((context) => context.person.id === succubus.id);
  assert.ok(succubusContext?.options.some((option) => option.id.startsWith('reproduce:succubus:')), '魅魔应在低身体储备、无关系来源和无协议时仍拥有单方生殖候选');
  const unilateralAttempt = executePrimitiveAction(succubusState, succubus, {
    kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: succubusPartner.id }],
  }, 0, 0, { cause: 'intent', actionTick: 1 });
  assert.equal(unilateralAttempt.status, 'completed', '魅魔的单方生殖动作不得被双方协议门槛阻断');
  assert.equal(unilateralAttempt.diff.authorizationMode, 'succubus-unilateral');
  assert.equal(unilateralAttempt.diff.mutualConsent, false);
  succubus.conditions = [{
    id: 'test-succubus-pregnancy', kind: 'pregnancy', stage: 3, sinceMonth: -8, dueAtMonth: 1,
    sourceEventIds: [unilateralAttempt.id], otherPersonId: succubusPartner.id,
  }];
  succubus.body = { health: 100, hydration: 100, nutrition: 100 };
  const succubusBirthEvents = advanceBodies(succubusState, 1);
  assert.equal(succubusBirthEvents.filter((fact) => typeof fact.diff.bornPersonId === 'string').length, 1);
  assert.equal(succubus.conditions.some((condition) => condition.kind === 'postpartum-recovery'), false, '魅魔分娩后不得进入产后恢复期');
  assert.equal(succubusBirthEvents.find((fact) => fact.diff.bornPersonId)?.diff.postpartumSkippedByTrait, true);

  assert.equal(pregnancyLossChance({ body: { health: 100, hydration: 100, nutrition: 100 } }, false), 0);
  assert.equal(pregnancyLossChance({ body: { health: 10, hydration: 100, nutrition: 9 } }, false), 0.28);
  assert.ok(Math.abs(pregnancyLossChance({ body: { health: 10, hydration: 100, nutrition: 9 } }, true) - 0.435) < 1e-12);
  assert.equal(pregnancyLossChance({ body: { health: 100, hydration: 100, nutrition: 100 } }, true), 0.015);

  const twinState = simulation.createInitialState(2002, {
    characterIds: ['nuwa', 'laozi'], endpoint: { kind: 'months', value: 3 }, chaosIntensity: 0,
  });
  const twinMother = twinState.people.find((person) => person.sex === 'female');
  const twinFather = twinState.people.find((person) => person.sex === 'male');
  twinMother.traits = [traitState('twin-bearer')];
  twinMother.body = { health: 100, hydration: 100, nutrition: 100 };
  twinMother.conditions = [{
    id: 'test-twin-pregnancy', kind: 'pregnancy', stage: 3, sinceMonth: -8, dueAtMonth: 1,
    sourceEventIds: ['test-twin-conception'], otherPersonId: twinFather.id,
  }];
  twinFather.position = structuredClone(twinMother.position);
  const twinPopulationBefore = twinState.people.length;
  const twinBirthEvents = advanceBodies(twinState, 1).filter((fact) => typeof fact.diff.bornPersonId === 'string');
  assert.equal(twinState.people.length, twinPopulationBefore + 2, '双生特质应一次产生两个独立人物');
  assert.equal(twinBirthEvents.length, 2, '双生特质应留下两个独立出生事实');
  assert.equal(new Set(twinBirthEvents.map((fact) => fact.diff.multipleBirthId)).size, 1, '两个出生事实应通过同一多胎事件关联');
  assert.ok(twinBirthEvents.every((fact) => fact.diff.multipleBirthCount === 2 && fact.diff.twinBirth === true));

  const normalMetabolism = simulation.createInitialState(2003, {
    characterIds: ['laozi'], endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0,
  });
  const gluttonMetabolism = structuredClone(normalMetabolism);
  normalMetabolism.people[0].traits = [];
  gluttonMetabolism.people[0].traits = [traitState('gluttonous')];
  const normalNutritionBefore = normalMetabolism.people[0].body.nutrition;
  const gluttonNutritionBefore = gluttonMetabolism.people[0].body.nutrition;
  advanceBodies(normalMetabolism, 1);
  advanceBodies(gluttonMetabolism, 1);
  const normalNutritionCost = normalNutritionBefore - normalMetabolism.people[0].body.nutrition;
  const gluttonNutritionCost = gluttonNutritionBefore - gluttonMetabolism.people[0].body.nutrition;
  assert.ok(Math.abs(gluttonNutritionCost / normalNutritionCost - 1.5) < 1e-9, '饕餮应在统一月度身体结算中多消耗 50% 营养');

  child.bornAtMonth = -10 * 12;
  child.position = structuredClone(birthMother.position);
  child.knowledge = [];
  const twoRecipes = recipeKnowledge.slice(0, 2);
  for (const recipe of twoRecipes) {
    if (!birthMother.knowledge.some((fact) => fact.id === recipe.id)) birthMother.knowledge.push(recipe);
  }
  const teach = (recipe, order) => executePrimitiveAction(birthState, birthMother, {
    kind: 'communicate',
    content: { id: `teach:test:${order}:${recipe.id}`, kind: 'claim', factId: recipe.id, summary: recipe.summary },
    audience: [child.id], channel: 'voice',
  }, 2, order, { cause: 'intent', actionTick: order + 1 });
  const firstTeaching = teach(twoRecipes[0], 0);
  assert.equal(firstTeaching.status, 'completed');
  assert.equal(child.knowledge.find((fact) => fact.id === twoRecipes[0].id)?.confidence, 72, '母亲第一次真实技术教导应达到 72 置信度');
  const secondTeaching = teach(twoRecipes[1], 1);
  assert.equal(child.knowledge.find((fact) => fact.id === twoRecipes[1].id)?.confidence, 60, '母亲之后的普通教导应回到 60 置信度');

  const permanenceState = simulation.createInitialState(1231, {
    characterIds: ['cangtianying', 'zhaotianli'], endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0,
  });
  const before = Object.fromEntries(permanenceState.people.map((person) => [person.id, structuredClone(person.traits)]));
  const after = simulation.stepSimulation(permanenceState);
  for (const person of after.people.filter((candidate) => candidate.generation === 0)) {
    assert.deepEqual(person.traits, before[person.id], '月度推进不得改写既有特质');
  }

  process.stdout.write('trait tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
