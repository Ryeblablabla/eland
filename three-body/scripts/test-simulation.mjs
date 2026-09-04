import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-monthly-test-'));
const bundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const agreementBundlePath = path.join(temporaryDirectory, 'agreement.mjs');
const decisionBundlePath = path.join(temporaryDirectory, 'decision-context.mjs');
const intentBundlePath = path.join(temporaryDirectory, 'intent.mjs');
const historyBundlePath = path.join(temporaryDirectory, 'history.mjs');
const physicalStructureBundlePath = path.join(temporaryDirectory, 'physical-structure-index.mjs');
const memoryBundlePath = path.join(temporaryDirectory, 'memory.mjs');
const waterAccessBundlePath = path.join(temporaryDirectory, 'water-access.mjs');
const constructionBundlePath = path.join(temporaryDirectory, 'construction-options.mjs');
const monthlyProcessesBundlePath = path.join(temporaryDirectory, 'monthly-processes.mjs');
const actionExecutorBundlePath = path.join(temporaryDirectory, 'action-executor.mjs');

const normalizeFixtureLanguage = (rawAction, rawDiff = {}) => {
  const { interpreters: actionInterpreters = [], ...actionWithoutInterpreters } = rawAction;
  const { interpreters: diffInterpreters = [], ...diffWithoutInterpreters } = rawDiff;
  const interpreterIds = [...new Set([...actionInterpreters, ...diffInterpreters])];
  if (actionWithoutInterpreters.kind !== 'talk') {
    return { action: actionWithoutInterpreters, diff: diffWithoutInterpreters };
  }
  return {
    action: actionWithoutInterpreters,
    diff: {
      ...diffWithoutInterpreters,
      listenerInterpretations: interpreterIds.map((listenerId) => ({
        version: 'listener-language-interpretation-v1',
        listenerId,
        sourceRepresentationId: actionWithoutInterpreters.speakerMeaning.id,
        kind: actionWithoutInterpreters.speakerMeaning.kind,
      })),
    },
  };
};

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/simulation.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/domain/agreement.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${agreementBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/application/model-decision/decision-context.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${decisionBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/domain/intent.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${intentBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/domain/history.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${historyBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/domain/physical-structure-index.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${physicalStructureBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/domain/memory.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${memoryBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/domain/water-access.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${waterAccessBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/application/construction-options.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${constructionBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/domain/monthly-processes.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${monthlyProcessesBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/domain/action-executor.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${actionExecutorBundlePath}`,
  ], { stdio: 'pipe' });
  const { buildDecisionContexts, createInitialState, createSimulation, executeActiveIntent, seededFraction, stepSimulation, stepSimulationAsync } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const { advanceAgreementLifecycle, agreementAuthorizesTransfer, recordAgreementAction } = await import(`${pathToFileURL(agreementBundlePath).href}?test=${Date.now()}`);
  const { buildDecisionRequestContext } = await import(`${pathToFileURL(decisionBundlePath).href}?test=${Date.now()}`);
  const { composeIntentChoice } = await import(`${pathToFileURL(intentBundlePath).href}?test=${Date.now()}`);
  const { appendCommittedEvents } = await import(`${pathToFileURL(historyBundlePath).href}?test=${Date.now()}`);
  const { advancePhysicalStructureIndex, copyPhysicalStructures } = await import(`${pathToFileURL(physicalStructureBundlePath).href}?test=${Date.now()}`);
  const { projectMemories } = await import(`${pathToFileURL(memoryBundlePath).href}?test=${Date.now()}`);
  const { findReachableWater } = await import(`${pathToFileURL(waterAccessBundlePath).href}?test=${Date.now()}`);
  const { buildConstructionOptions } = await import(`${pathToFileURL(constructionBundlePath).href}?test=${Date.now()}`);
  const { resolveClimate, resolveWeather } = await import(`${pathToFileURL(monthlyProcessesBundlePath).href}?test=${Date.now()}`);
  const { executePrimitiveAction } = await import(`${pathToFileURL(actionExecutorBundlePath).href}?test=${Date.now()}`);
  const placeWith = (person, other) => {
    person.position.cellId = other.position.cellId;
    person.position.z = other.position.z;
    person.position.previousCellId = other.position.cellId;
    person.position.previousZ = other.position.z;
  };
  const appendFixtureEvents = (state, events) => {
    const previousIndex = state.world.physicalStructureIndex;
    const previousSeal = {
      eventCount: state.world.historyCursor.eventCount,
      tailEventId: state.world.historyCursor.tailEventId,
    };
    appendCommittedEvents(state, events);
    if (previousIndex?.projectionVersion !== 2) return;
    const nextIndex = advancePhysicalStructureIndex(state, previousIndex, events, previousSeal);
    state.world.physicalStructureIndex = nextIndex;
    state.derived = { ...state.derived, structures: copyPhysicalStructures(nextIndex) };
  };
  const surfaceStandingZ = (state, cell) => {
    for (let z = state.world.grid.levels - 1; z >= 0; z -= 1) {
      if (state.world.grid.voxels[z * state.world.grid.width * state.world.grid.depth + cell] !== 0) return Math.min(state.world.grid.levels - 2, z + 1);
    }
    return 1;
  };

  const initial = createInitialState(31, { endpoint: { kind: 'months', value: 180 } });
  assert.equal(initial.schemaVersion, 19);
  assert.equal(initial.people.length, 3, '新文明应固定由 3 位先民开始');
  assert.deepEqual(initial.clock, { unit: 'month', elapsedMonths: 0, monthsPerYear: 12 });
  assert.equal(initial.world.grid.width, 84);
  assert.equal(initial.world.grid.depth, 52);
  assert.equal(initial.world.grid.levels, 12);
  assert.equal(initial.world.grid.voxels.length, 84 * 52 * 12);
  assert.ok(Array.from({ length: 1_000 }, (_, index) => seededFraction(31, `range:${index}`)).every((value) => value >= 0 && value < 1), '确定性随机采样必须始终位于 [0, 1)');
  assert.ok(initial.people.every((person) => Number.isInteger(person.position.cellId) && Number.isInteger(person.position.z) && person.inventory.length > 0));
  assert.ok(initial.people.every((person) => person.geneticLoad === 0), '创始人不应凭空带有遗传负荷');
  assert.ok(initial.world.drops.every((drop) => Number.isInteger(drop.z)), '地面物品必须属于具体高度，不能穿过楼板被拾取');
  assert.equal('agents' in initial, false, '权威状态不应保留旧 Agent 模型');
  assert.equal('plans' in initial, false, '权威状态不应保留 PlanMode');
  assert.equal('cells' in initial.world.grid, false, '格子不应保留属性包');
  assert.deepEqual(initial.records, [], '开局不应凭空存在任何文字记录');
  assert.deepEqual(initial.collectives, [], '开局不应凭空存在任何共同体成员身份');
  assert.deepEqual(initial.permissions, [], '开局不应凭空存在任何物质取用许可');
  assert.deepEqual(initial.containers, [], '开局不应凭空存在任何储藏容器');
  const foundingFact = initial.world.past.find((event) => event.kind === 'environment' && event.change === 'founding');
  assert.deepEqual([...foundingFact.diff.participantIds].sort(), initial.people.map((person) => person.id).sort(), '开局先民的相互熟悉必须来自明确列出参与者的共同抵达事实');
  assert.ok(initial.people.every((person) => person.relations.every((relation) => relation.trust === 10 && relation.bond === 10 && relation.fear === 0 && relation.sourceEventIds.length === 1 && relation.sourceEventIds[0] === foundingFact.id)), '开局先民只有中性且可追溯的相识，不得预装亲密关系');
  const cappedLongRun = createInitialState(311_000, { endpoint: { kind: 'months', value: 99_999 } });
  assert.equal(cappedLongRun.civilization.conditions.endpoint.value, 12_000, '长期演化可持续到全员死亡，但时间硬上限暂定为一千年');

  const externalClimateState = createInitialState(20260822, { endpoint: { kind: 'months', value: 12 } });
  externalClimateState.civilization.externalClimate = { epoch: 'chaotic', kind: 'heat', severity: 7 };
  externalClimateState.civilization.externalEraRegime = {
    sinceMonth: 0, candidateEpoch: null, candidateSinceMonth: 0, candidateConsecutiveMonths: 0,
  };
  const pendingExternalEpochFacts = resolveClimate(externalClimateState, 1);
  assert.equal(externalClimateState.civilization.epoch, 'stable', '单月天象扰动不得立即升级为乱纪元');
  assert.equal(pendingExternalEpochFacts[0]?.diff.eraConfirmationPending, true);
  assert.equal(pendingExternalEpochFacts[0]?.diff.candidateConsecutiveMonths, 1);
  for (let atMonth = 2; atMonth <= 5; atMonth += 1) resolveClimate(externalClimateState, atMonth);
  assert.equal(externalClimateState.civilization.epoch, 'stable', '即使证据连续，当前纪元也必须先完成最短持续期');
  const externalEpochFacts = resolveClimate(externalClimateState, 6);
  assert.equal(externalClimateState.civilization.epoch, 'chaotic');
  assert.equal(externalEpochFacts[0]?.diff.epochChanged, true, '持续天象证据确认后必须提交恒乱纪元转换事实');
  assert.equal(externalEpochFacts[0]?.diff.previousEpoch, 'stable');
  assert.equal(externalEpochFacts[0]?.diff.previousKind, 'temperate');
  assert.equal(externalEpochFacts[0]?.diff.climateKindChanged, true);
  assert.equal(externalEpochFacts[0]?.diff.eraTransition, true);
  externalClimateState.civilization.externalClimate = { epoch: 'chaotic', kind: 'cold', severity: 6 };
  const externalClimateShiftFacts = resolveClimate(externalClimateState, 7);
  assert.equal(externalClimateShiftFacts[0]?.diff.epochChanged, undefined);
  assert.equal(externalClimateShiftFacts[0]?.diff.climateKindChanged, true, '同一乱纪元内的冷热切换必须保留前后态');
  assert.equal(externalClimateShiftFacts[0]?.diff.previousKind, 'heat');

  const weatherTrace = (seed) => {
    const state = {
      seed,
      civilization: {
        epoch: 'stable',
        era: { sequence: 0 },
        climate: { kind: 'temperate' },
        weather: { kind: 'clear', intensity: 1, sinceMonth: 0 },
      },
    };
    const trace = [];
    for (let atMonth = 1; atMonth <= 120; atMonth += 1) {
      const previous = { ...state.civilization.weather };
      const events = resolveWeather(state, atMonth);
      const current = state.civilization.weather;
      if (current.kind !== previous.kind) {
        if (atMonth > 1) assert.ok(atMonth - previous.sinceMonth >= 2, '普通天气过程至少持续两个完整月份');
        assert.equal(current.sinceMonth, atMonth, '新天气过程必须记录真实开始月');
      } else if (atMonth > 1) {
        assert.equal(current.sinceMonth, previous.sinceMonth, '同种天气的强度漂移不得伪造新过程');
      }
      if (current.kind === previous.kind && current.intensity !== previous.intensity) {
        assert.equal(Math.abs(current.intensity - previous.intensity), 1, '持续期内天气强度每月最多变化一级');
      }
      trace.push(...events.map((event) => ({
        atMonth: event.atMonth,
        kind: event.diff.kind,
        intensity: event.diff.intensity,
        episodeStarted: event.diff.episodeStarted,
      })));
    }
    return trace;
  };
  for (const seed of [185, 20260815, 20260816]) {
    const trace = weatherTrace(seed);
    const transitionRate = (trace.length - 1) / 119;
    assert.ok(transitionRate >= 0.12 && transitionRate <= 0.32, `天气状态变化率应保持在更舒缓但仍可感知的区间，实际 ${transitionRate}`);
    assert.deepEqual(trace, weatherTrace(seed), '同一种子的天气过程必须完全可回放');
  }
  const incompatibleWeatherState = {
    seed: 185,
    civilization: {
      epoch: 'chaotic',
      era: { sequence: 1 },
      climate: { kind: 'cold' },
      weather: { kind: 'rain', intensity: 2, sinceMonth: 1 },
    },
  };
  resolveWeather(incompatibleWeatherState, 2);
  assert.notEqual(incompatibleWeatherState.civilization.weather.kind, 'rain', '气候已不兼容时不得强行保留旧天气');
  assert.equal(incompatibleWeatherState.civilization.weather.sinceMonth, 2);

  const stableWeatherCounts = { clear: 0, rain: 0, storm: 0, drought: 0, snow: 0, fog: 0 };
  for (let seed = 1; seed <= 100; seed += 1) {
    const state = {
      seed,
      civilization: {
        epoch: 'stable',
        era: { sequence: 0 },
        climate: { kind: 'temperate' },
        weather: { kind: 'clear', intensity: 1, sinceMonth: 0 },
      },
    };
    for (let atMonth = 1; atMonth <= 120; atMonth += 1) {
      resolveWeather(state, atMonth);
      stableWeatherCounts[state.civilization.weather.kind] += 1;
    }
  }
  const stableWeatherTargetShares = { clear: 0.49, rain: 0.27, storm: 0.07, drought: 0.05, snow: 0, fog: 0.12 };
  for (const [kind, targetShare] of Object.entries(stableWeatherTargetShares)) {
    const observedShare = stableWeatherCounts[kind] / 12_000;
    assert.ok(Math.abs(observedShare - targetShare) <= 0.035, `延续惯性不得改写温和气候下 ${kind} 的长程目标占比，实际 ${observedShare}`);
  }

  const memoryPerson = structuredClone(initial.people[0]);
  memoryPerson.memories = Array.from({ length: 6 }, (_, index) => ({ id: `dialogue-${index}`, kind: 'dialogue', summary: `普通对话 ${index}`, importance: 90 - index, createdAtMonth: index, lastRecalledAtMonth: index, personIds: [], sourceEventIds: [] }));
  memoryPerson.memories.push({ id: 'physical-episode', kind: 'episode', summary: '亲手分离出食物', importance: 38, createdAtMonth: 0, lastRecalledAtMonth: 0, personIds: [], sourceEventIds: ['physical-source'] });
  const projectedMemories = projectMemories(memoryPerson, 6);
  assert.ok(projectedMemories.some((memory) => memory.summary === '亲手分离出食物'), '重复普通对话不得挤掉模型上下文中的真实操作经验');
  assert.ok(projectedMemories.filter((memory) => memory.kind === 'dialogue').length <= 2, '模型上下文只保留少量最相关普通对话，避免对话自我强化');

  const kinshipState = createInitialState(315, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  while (kinshipState.people.length < 5) {
    const source = kinshipState.people[kinshipState.people.length % 3];
    const ordinal = kinshipState.people.length + 1;
    kinshipState.people.push({
      ...structuredClone(source),
      id: `kinship-fixture-${ordinal}`,
      name: `亲属夹具人物 ${ordinal}`,
      geneticParents: [],
      relations: [],
    });
  }
  const [kinshipMother, kinshipFather, kinshipSpeaker, kinshipSister, kinshipChild] = kinshipState.people;
  assert.ok(kinshipMother && kinshipFather && kinshipSpeaker && kinshipSister && kinshipChild, '亲属上下文测试需要至少五名人物');
  kinshipMother.sex = 'female';
  kinshipFather.sex = 'male';
  kinshipSister.sex = 'female';
  kinshipChild.sex = 'male';
  kinshipSpeaker.geneticParents = [kinshipMother.id, kinshipFather.id];
  kinshipSister.geneticParents = [kinshipMother.id, kinshipFather.id];
  kinshipChild.geneticParents = [kinshipSpeaker.id, kinshipSister.id];
  const kinshipContext = buildDecisionContexts(kinshipState).find((context) => context.person.id === kinshipSpeaker.id);
  assert.ok(kinshipContext, '应能为有亲属关系的人物建立决策上下文');
  const projectedKinship = buildDecisionRequestContext(kinshipContext).person.kinship;
  assert.deepEqual(projectedKinship.parents.map(({ id, relation }) => ({ id, relation })), [
    { id: kinshipMother.id, relation: 'mother' },
    { id: kinshipFather.id, relation: 'father' },
  ], '模型上下文必须明确投影双亲身份，不能让模型从描述或记忆猜测');
  assert.deepEqual(projectedKinship.siblings.map(({ id, relation, fullSibling }) => ({ id, relation, fullSibling })), [
    { id: kinshipSister.id, relation: 'sister', fullSibling: true },
  ], '拥有相同双亲的人物必须投影为同父同母的姐妹');
  assert.deepEqual(projectedKinship.children.map(({ id, relation }) => ({ id, relation })), [
    { id: kinshipChild.id, relation: 'son' },
  ], '子女身份必须独立于可衰减的事件记忆稳定投影');

  const feasibleIntentState = createInitialState(316, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const feasibleActor = feasibleIntentState.people.find((person) => person.sex === 'female') ?? feasibleIntentState.people[0];
  const feasiblePartner = feasibleIntentState.people.find((person) => person.sex === 'male' && person.id !== feasibleActor.id)
    ?? feasibleIntentState.people.find((person) => person.id !== feasibleActor.id);
  assert.ok(feasibleActor && feasiblePartner, '可行意图测试需要两名人物');
  feasibleActor.sex = 'female';
  feasiblePartner.sex = 'male';
  feasibleActor.bornAtMonth = -24 * 12;
  feasiblePartner.bornAtMonth = -24 * 12;
  feasibleActor.body = { health: 100, hydration: 100, nutrition: 100 };
  feasiblePartner.body = { health: 100, hydration: 100, nutrition: 100 };
  feasibleActor.conditions = [];
  feasiblePartner.conditions = [];
  placeWith(feasiblePartner, feasibleActor);
  Object.assign(feasibleActor.personality.baseline, { emotionality: 0, extraversion: 0, agreeableness: 0, openness: 0 });
  for (const relation of feasibleActor.relations) Object.assign(relation, { trust: 0, bond: 0, sourceEventIds: [] });
  let feasibleContext = buildDecisionContexts(feasibleIntentState).find((context) => context.person.id === feasibleActor.id);
  assert.ok(!feasibleContext?.options.some((option) => option.id.startsWith('offer-reproduce:')), '只有身体与距离条件、尚未培养关系时不得提出生殖');
  const cultivatedReproductionState = structuredClone(feasibleIntentState);
  const cultivatedReproductionActor = cultivatedReproductionState.people.find((person) => person.id === feasibleActor.id);
  const cultivatedReproductionPartner = cultivatedReproductionState.people.find((person) => person.id === feasiblePartner.id);
  assert.ok(cultivatedReproductionActor && cultivatedReproductionPartner, '关系培养测试需要完整人物对');
  const cultivatedRelationship = cultivatedReproductionActor.relations.find((relation) => relation.personId === cultivatedReproductionPartner.id);
  const cultivatedReciprocalRelationship = cultivatedReproductionPartner.relations.find((relation) => relation.personId === cultivatedReproductionActor.id);
  assert.ok(cultivatedRelationship && cultivatedReciprocalRelationship, '关系培养测试需要双向关系');
  const cultivatedConversationFacts = [0, 1].flatMap((month) => {
    const basisKey = `grounded-conversation-v1|topic=care|speaker=${cultivatedReproductionActor.id}|listener=${cultivatedReproductionPartner.id}|sources=${foundingFact.id}`;
    const openingId = `test-feasible-cultivated-opening-${month}`;
    const responseId = `test-feasible-cultivated-response-${month}`;
    const shell = (id, orderInMonth, who, rawAction) => {
      const { action, diff } = normalizeFixtureLanguage(rawAction, { groundedConversationBasisKey: basisKey });
      return {
        id, kind: 'action', actionTick: 1, atMonth: month, orderInMonth,
        cellId: cultivatedReproductionActor.position.cellId, who, cause: 'intent', action,
        fromCellId: cultivatedReproductionActor.position.cellId, toCellId: cultivatedReproductionActor.position.cellId,
        fromZ: cultivatedReproductionActor.position.z, toZ: cultivatedReproductionActor.position.z,
        pathSegment: [cultivatedReproductionActor.position.cellId], status: 'completed',
        result: '双方完成有来源的生活交流', diff,
      };
    };
    return [
      shell(openingId, 0, cultivatedReproductionActor.id, {
        kind: 'talk', speakerMeaning: { id: openingId, kind: 'claim', summary: '关心对方近况', conversation: {
          version: 'grounded-conversation-v1', basisKey, topic: 'care', turn: 'opening',
          sourceFactIds: [foundingFact.id],
        } }, interpreters: [cultivatedReproductionPartner.id],
      }),
      shell(responseId, 1, cultivatedReproductionPartner.id, {
        kind: 'talk', speakerMeaning: { id: responseId, kind: 'claim', summary: '回应对方的关心', conversation: {
          version: 'grounded-conversation-v1', basisKey, topic: 'care', turn: 'response',
          sourceFactIds: [foundingFact.id], referenceEventId: openingId, stance: 'supportive',
        } }, interpreters: [cultivatedReproductionActor.id],
      }),
    ];
  });
  const cultivatedSharedLifeFact = {
    id: 'test-feasible-cultivated-shared-life-2', kind: 'environment', change: 'relationship',
    atMonth: 2, orderInMonth: 0, cellId: cultivatedReproductionActor.position.cellId,
    result: '第三个月仍有普通共同生活经历',
    diff: { process: 'shared-action-ticks', participantIds: [cultivatedReproductionActor.id, cultivatedReproductionPartner.id], excludedPairKeys: [] },
  };
  const cultivatedSourceIds = [...cultivatedConversationFacts.map((event) => event.id), cultivatedSharedLifeFact.id];
  Object.assign(cultivatedRelationship, { trust: 20, bond: 20, sourceEventIds: cultivatedSourceIds });
  Object.assign(cultivatedReciprocalRelationship, { trust: 0, bond: 0, sourceEventIds: [] });
  appendFixtureEvents(cultivatedReproductionState, [...cultivatedConversationFacts, cultivatedSharedLifeFact]);
  cultivatedReproductionState.clock.elapsedMonths = 2;
  const cultivatedReproductionContext = buildDecisionContexts(cultivatedReproductionState).find((context) => context.person.id === cultivatedReproductionActor.id);
  assert.ok(cultivatedReproductionContext?.options.some((option) => option.id.startsWith('offer-reproduce:')), '提议者达到 20/20 且跨月形成直接照护交流后，应由本人评估是否提出生殖，不要求对方也达到同一分数');
  for (const relation of feasibleActor.relations) Object.assign(relation, { trust: 6, bond: 6, sourceEventIds: [foundingFact.id] });
  feasibleActor.inventory = [
    { id: 'test-feasible-food', materialId: 21, quantity: 3, sourceEventIds: [] },
    { id: 'test-feasible-fiber', materialId: 20, quantity: 1, sourceEventIds: [] },
  ];
  feasibleActor.knowledge.push({ id: 'technique:test-feasible', kind: 'technique', summary: '一项已核验的技术', confidence: 70, learnedAtMonth: 0, sourceEventIds: ['test-feasible-technique-source'] });
  feasiblePartner.inventory = [{ id: 'test-feasible-water', materialId: 7, quantity: 2, sourceEventIds: [] }];
  feasiblePartner.body.nutrition = 30;
  feasiblePartner.conditions.push({ id: 'test-feasible-wound', kind: 'wound', stage: 1, sinceMonth: 0, sourceEventIds: ['test-feasible-wound-source'] });
  feasibleContext = buildDecisionContexts(feasibleIntentState).find((context) => context.person.id === feasibleActor.id);
  for (const prefix of ['share:', 'offer-exchange:', 'care:', 'teach:']) {
    assert.ok(feasibleContext?.options.some((option) => option.id.startsWith(prefix)), `物质与关系前提成立时，${prefix} 不得被性格偏置隐藏`);
  }

  const coercionState = createInitialState(317, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const coercer = coercionState.people[0];
  const coerced = coercionState.people[1];
  coercer.bornAtMonth = -24 * 12;
  coerced.bornAtMonth = -24 * 12;
  placeWith(coerced, coercer);
  coercer.body.nutrition = 12;
  Object.assign(coercer.personality.baseline, { honestyHumility: 0, emotionality: 0, extraversion: 0, agreeableness: 0, conscientiousness: 0, openness: 0 });
  coercer.inventory = [{ id: 'test-feasible-rope', materialId: 23, quantity: 1, sourceEventIds: [] }];
  coerced.body.health = 15;
  coerced.inventory = [{ id: 'test-coerced-food', materialId: 21, quantity: 2, sourceEventIds: [] }];
  const coerciveRelation = coercer.relations.find((relation) => relation.personId === coerced.id);
  coerciveRelation.trust = -20;
  coerciveRelation.fear = 60;
  const coercionContext = buildDecisionContexts(coercionState).find((context) => context.person.id === coercer.id);
  for (const prefix of ['take-without-permission:', 'combine-restraint:', 'exert-person:']) {
    assert.ok(coercionContext?.options.some((option) => option.id.startsWith(prefix)), `压力与事实前提成立时，${prefix} 应交给模型取舍，不得被随机或性格门槛删除`);
  }

  const pressureState = createInitialState(315, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const pressured = pressureState.people[0];
  pressured.conditions.push({ id: 'test-severe-cold', kind: 'cold', stage: 2, sinceMonth: 0, sourceEventIds: ['test-cold-escalation'] });
  appendFixtureEvents(pressureState, [{ id: 'test-cold-escalation', kind: 'environment', atMonth: 0, orderInMonth: 0, cellId: pressured.position.cellId, who: pressured.id, change: 'condition', result: '寒冷加重', diff: { condition: 'cold', stage: 2 } }]);
  const pressureIntentId = 'intent-before-cold-escalation';
  pressureState.intents.push({
    id: pressureIntentId, ownerId: pressured.id, summary: '继续原有远行', domain: 'strategic',
    goal: { kind: 'at-cell', cellId: pressured.position.cellId }, nextAction: { kind: 'move', toCellId: pressured.position.cellId },
    status: 'active', createdAtMonth: 0, lastProgressAtMonth: 0, progress: 0,
    sourceDecisionEventId: 'decision-before-cold-escalation', sourceFactIds: [], actionEventIds: [], replanCount: 0,
  });
  pressured.activeIntentId = pressureIntentId;
  const pressureContext = buildDecisionContexts(pressureState).find((context) => context.person.id === pressured.id);
  assert.ok(pressureContext, '危险暴露测试必须拥有决策上下文');
  const projectedPressure = buildDecisionRequestContext(pressureContext);
  assert.equal(projectedPressure.person.ageMonths, -pressured.bornAtMonth, '模型应看到由出生月份派生的当前年龄');
  assert.equal(projectedPressure.person.sex, pressured.sex, '模型应看到自己的生理性别事实');
  assert.ok(projectedPressure.visiblePeople.every((other) => Number.isInteger(other.ageMonths) && other.sex && Array.isArray(other.conditions)), '可见人物应连同年龄、生理性别和当前状态进入意图判断');
  assert.deepEqual(projectedPressure.activePressures[0], { kind: 'cold', stage: 2, consequences: ['营养消耗加速', '操作与移动能力下降'] }, '模型应看到状态造成的可结算后果，而不是只看到状态名');
  assert.ok(projectedPressure.visibleDrops.every((drop) => Array.isArray(drop.properties)), '地面物质应向模型暴露材料定义中的可观察性质');
  const afterPressure = stepSimulation(pressureState, { decide() { return { kind: 'idle', reason: '已重新评估危险暴露' }; } });
  const pressureOpportunity = afterPressure.world.past.find((event) => event.kind === 'decision-opportunity' && event.atMonth === 1 && event.who === pressured.id);
  assert.ok(pressureOpportunity?.triggered && pressureOpportunity.reasons.some((reason) => reason.includes('危险阶段')), '2–3 级暴露加重必须打断仍在推进的旧意图并触发关键重评估');

  const thermalConflictState = createInitialState(318, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const thermallyExposed = thermalConflictState.people[0];
  thermallyExposed.conditions.push({ id: 'test-prior-cold', kind: 'cold', stage: 3, sinceMonth: 0, sourceEventIds: ['test-prior-cold-source'] });
  thermalConflictState.civilization.externalClimate = { epoch: 'stable', kind: 'heat', severity: 3 };
  thermalConflictState.decisionBudget.credits = 0;
  const afterThermalFlip = stepSimulation(thermalConflictState, { decide() { return { kind: 'idle', reason: '不干扰热暴露切换测试' }; } });
  const thermallySettled = afterThermalFlip.people.find((person) => person.id === thermallyExposed.id);
  assert.equal(thermallySettled?.conditions.some((condition) => condition.kind === 'cold'), false, '明确炎热负荷必须终止原寒冷状态，不能叠加两套相反消耗');
  assert.ok(afterThermalFlip.world.past.some((event) => event.kind === 'environment' && event.who === thermallyExposed.id && event.diff.condition === 'cold' && event.diff.counteredBy === 'heat'), '冷热切换应留下可回放的状态退出事实');
  assert.equal(thermallySettled?.conditions.some((condition) => condition.kind === 'cold') && thermallySettled.conditions.some((condition) => condition.kind === 'heat'), false, '同一人不得同时结算寒冷与炎热压力');

  const agreementState = createInitialState(31, { endpoint: { kind: 'months', value: 24 } });
  const requester = agreementState.people[0];
  const helper = agreementState.people[1];
  const agreementId = 'test-assist-agreement';
  const actionFact = (id, atMonth, who, rawAction) => {
    const { action, diff } = normalizeFixtureLanguage(rawAction);
    return { id, kind: 'action', actionTick: 1, atMonth, orderInMonth: 0, cellId: requester.position.cellId, who, cause: 'intent', action, fromCellId: requester.position.cellId, toCellId: requester.position.cellId, fromZ: requester.position.z, toZ: requester.position.z, pathSegment: [requester.position.cellId], status: 'completed', result: id, diff };
  };
  const proposal = actionFact('test-proposal', 1, requester.id, { kind: 'talk', speakerMeaning: { id: agreementId, kind: 'request', summary: '请给我一份食物', proposal: { kind: 'assist', requesterId: requester.id, helperId: helper.id, need: 'food', expiresAtMonth: 3 } }, interpreters: [helper.id] });
  recordAgreementAction(agreementState, proposal);
  appendFixtureEvents(agreementState, [proposal]);
  assert.equal(agreementState.agreements[0]?.status, 'proposed', '结构化求助应创建待回应 Agreement');
  const trustBeforeAcceptance = requester.relations.find((relation) => relation.personId === helper.id)?.trust;
  const acceptance = actionFact('test-acceptance', 2, helper.id, { kind: 'talk', speakerMeaning: { id: 'test-acceptance-content', kind: 'accept', referenceId: agreementId }, interpreters: [requester.id] });
  recordAgreementAction(agreementState, acceptance);
  appendFixtureEvents(agreementState, [acceptance]);
  assert.equal(agreementState.agreements[0]?.status, 'active', '指定回应者接受后 Agreement 才生效');
  assert.equal(requester.relations.find((relation) => relation.personId === helper.id)?.trust, trustBeforeAcceptance, '接受承诺本身不能增加信任');
  const unrelatedTransfer = { kind: 'transfer', materialId: 13, quantity: 1, from: { kind: 'person', personId: requester.id }, to: { kind: 'person', personId: helper.id }, authorizationRef: agreementId };
  assert.equal(agreementAuthorizesTransfer(agreementState.agreements[0], requester.id, unrelatedTransfer), false, '有效协议不得被当成任意物质转移的通用授权');
  const forgedFulfillment = actionFact('test-forged-fulfillment', 2, requester.id, unrelatedTransfer);
  recordAgreementAction(agreementState, forgedFulfillment);
  assert.deepEqual(agreementState.agreements[0]?.fulfilledByPersonIds, [], '与条款不符的转移不能计入履约');
  const fulfillment = actionFact('test-fulfillment', 3, helper.id, { kind: 'transfer', materialId: 21, quantity: 1, from: { kind: 'person', personId: helper.id }, to: { kind: 'person', personId: requester.id }, authorizationRef: agreementId });
  recordAgreementAction(agreementState, fulfillment);
  assert.equal(agreementState.agreements[0]?.status, 'fulfilled', '真实物质转移应履行求助 Agreement');
  assert.ok((requester.relations.find((relation) => relation.personId === helper.id)?.trust ?? 0) > 0, '履约事实应成为信任来源');

  const socialBasisState = createInitialState(320, { endpoint: { kind: 'months', value: 4 }, chaosIntensity: 0 });
  const socialActor = socialBasisState.people[0];
  const socialPeer = socialBasisState.people[1];
  socialActor.bornAtMonth = -20 * 12;
  socialPeer.bornAtMonth = -20 * 12;
  placeWith(socialPeer, socialActor);
  socialBasisState.clock.elapsedMonths = 1;
  const socialSource = {
    id: 'test-social-cooldown-condition', kind: 'environment', change: 'condition', atMonth: 1,
    orderInMonth: 0, cellId: socialPeer.position.cellId, who: socialPeer.id,
    result: `${socialPeer.name}感到寒冷`, diff: { condition: 'cold', stage: 2 },
  };
  appendFixtureEvents(socialBasisState, [socialSource]);
  socialPeer.conditions.push({
    id: 'test-social-cooldown-cold', kind: 'cold', stage: 2, sinceMonth: 1,
    sourceEventIds: [socialSource.id],
  });
  const firstSocialContext = buildDecisionContexts(socialBasisState).find((context) => context.person.id === socialActor.id);
  const firstTalk = firstSocialContext?.options.find((option) => option.id.startsWith('conversation:')
    && option.nextAction.kind === 'talk'
    && option.target?.kind === 'person'
    && option.target.personId === socialPeer.id);
  assert.ok(firstTalk?.nextAction.kind === 'talk', '社交冷却测试需要一项普通近身交谈');
  const recentSocialTalk = actionFact('test-recent-social-talk', 1, socialActor.id, firstTalk.nextAction);
  appendFixtureEvents(socialBasisState, [recentSocialTalk]);
  socialActor.relations.find((relation) => relation.personId === socialPeer.id)?.sourceEventIds.push(recentSocialTalk.id);
  socialPeer.relations.find((relation) => relation.personId === socialActor.id)?.sourceEventIds.push(recentSocialTalk.id);
  const repeatedBasisContext = buildDecisionContexts(socialBasisState).find((context) => context.person.id === socialActor.id);
  const firstBasisKey = firstTalk.nextAction.speakerMeaning.kind === 'claim'
    ? firstTalk.nextAction.speakerMeaning.conversation?.basisKey
    : undefined;
  assert.equal(repeatedBasisContext?.options.some((option) => option.nextAction.kind === 'talk'
    && option.nextAction.speakerMeaning.kind === 'claim'
    && option.nextAction.speakerMeaning.conversation?.basisKey === firstBasisKey), false, '同一段生活经历没有新事实时不得伪装成新的对话开场');
  assert.ok(repeatedBasisContext?.options.some((option) => option.domain === 'strategic'), '证据绑定的对话结束后仍应保留生产和探索候选');

  const emergencyBudgetState = createInitialState(321, { endpoint: { kind: 'months', value: 4 }, chaosIntensity: 0 });
  const endangered = emergencyBudgetState.people[0];
  endangered.bornAtMonth = -20 * 12;
  endangered.body.hydration = 20;
  emergencyBudgetState.clock.elapsedMonths = 1;
  emergencyBudgetState.decisionBudget.credits = 0;
  const exhaustedEmergencyContexts = Math.floor(emergencyBudgetState.people.length / 3);
  emergencyBudgetState.decisionBudget.ledgers = [{
    atMonth: 1, livingAgents: 0, candidates: 0,
    modelContexts: exhaustedEmergencyContexts,
    ordinaryModelContexts: exhaustedEmergencyContexts,
    exemptModelContexts: 0,
    inputTokens: 0,
    outputTokens: 0,
    chargedTokens: exhaustedEmergencyContexts * emergencyBudgetState.decisionBudget.tokensPerContext,
    ordinaryChargedTokens: exhaustedEmergencyContexts * emergencyBudgetState.decisionBudget.tokensPerContext,
  }];
  const emergencyBatch = [];
  const afterEmergencyBudget = await stepSimulationAsync(emergencyBudgetState, {
    async decideAll(contexts) {
      emergencyBatch.push(...contexts.map((context) => context.person.id));
      return contexts.map(() => ({ kind: 'idle', reason: '危险重评不占普通额度' }));
    },
    takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
  });
  assert.ok(emergencyBatch.includes(endangered.id), '普通额度耗尽时，危险人物仍必须进入模型批次');
  assert.equal(afterEmergencyBudget.decisionBudget.ledgers.at(-1)?.ordinaryModelContexts, 0, '危险重评不得扣普通额度');
  assert.ok((afterEmergencyBudget.decisionBudget.ledgers.at(-1)?.exemptModelContexts ?? 0) >= 1, '危险重评应记入豁免调用审计');

  const fulfillmentBudgetState = createInitialState(322, { endpoint: { kind: 'months', value: 4 }, chaosIntensity: 0 });
  const tradeOfferer = fulfillmentBudgetState.people[0];
  const tradeResponder = fulfillmentBudgetState.people[1];
  tradeOfferer.bornAtMonth = -20 * 12;
  tradeResponder.bornAtMonth = -20 * 12;
  placeWith(tradeResponder, tradeOfferer);
  tradeOfferer.inventory = [{ id: 'budget-trade-wood', materialId: 13, quantity: 2, sourceEventIds: [] }];
  tradeResponder.inventory = [{ id: 'budget-trade-food', materialId: 21, quantity: 2, sourceEventIds: [] }];
  const budgetExchangeId = 'test-budget-exchange';
  const budgetExchangeOffer = actionFact('test-budget-exchange-offer', 1, tradeOfferer.id, { kind: 'talk', speakerMeaning: { id: budgetExchangeId, kind: 'offer', summary: '木材换食物', proposal: { kind: 'exchange', offererId: tradeOfferer.id, partnerId: tradeResponder.id, offererMaterialId: 13, offererQuantity: 1, partnerMaterialId: 21, partnerQuantity: 1, expiresAtMonth: 6 } }, interpreters: [tradeResponder.id] });
  recordAgreementAction(fulfillmentBudgetState, budgetExchangeOffer);
  appendFixtureEvents(fulfillmentBudgetState, [budgetExchangeOffer]);
  const budgetExchangeAcceptance = actionFact('test-budget-exchange-acceptance', 1, tradeResponder.id, { kind: 'talk', speakerMeaning: { id: 'test-budget-exchange-acceptance-content', kind: 'accept', referenceId: budgetExchangeId }, interpreters: [tradeOfferer.id] });
  recordAgreementAction(fulfillmentBudgetState, budgetExchangeAcceptance);
  appendFixtureEvents(fulfillmentBudgetState, [budgetExchangeAcceptance]);
  fulfillmentBudgetState.clock.elapsedMonths = 1;
  fulfillmentBudgetState.decisionBudget.credits = 0;
  const exhaustedFulfillmentContexts = Math.floor(fulfillmentBudgetState.people.length / 3);
  fulfillmentBudgetState.decisionBudget.ledgers = [{
    atMonth: 1, livingAgents: 0, candidates: 0,
    modelContexts: exhaustedFulfillmentContexts,
    ordinaryModelContexts: exhaustedFulfillmentContexts,
    exemptModelContexts: 0,
    inputTokens: 0,
    outputTokens: 0,
    chargedTokens: exhaustedFulfillmentContexts * fulfillmentBudgetState.decisionBudget.tokensPerContext,
    ordinaryChargedTokens: exhaustedFulfillmentContexts * fulfillmentBudgetState.decisionBudget.tokensPerContext,
  }];
  const fulfillmentBatch = [];
  const afterFulfillmentBudget = await stepSimulationAsync(fulfillmentBudgetState, {
    async decideAll(contexts) {
      fulfillmentBatch.push(...contexts.map((context) => context.person.id));
      return contexts.map(() => ({ kind: 'idle', reason: '履约决策不占普通额度' }));
    },
    takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
  });
  assert.ok(fulfillmentBatch.includes(tradeOfferer.id) && fulfillmentBatch.includes(tradeResponder.id), '普通额度耗尽时，交换双方仍应进入履约批次');
  assert.equal(afterFulfillmentBudget.decisionBudget.ledgers.at(-1)?.ordinaryModelContexts, 0, '履约决策不得扣普通额度');
  assert.ok((afterFulfillmentBudget.decisionBudget.ledgers.at(-1)?.exemptModelContexts ?? 0) >= 2, '履约决策应记入豁免调用审计');

  const reproductionAgreementState = createInitialState(319, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const reproductionProposer = reproductionAgreementState.people.find((person) => person.sex === 'female') ?? reproductionAgreementState.people[0];
  const reproductionPartner = reproductionAgreementState.people.find((person) => person.sex === 'male' && person.id !== reproductionProposer.id) ?? reproductionAgreementState.people[1];
  reproductionProposer.sex = 'female';
  reproductionPartner.sex = 'male';
  const reproductionAgreementId = 'test-reproduction-window';
  const reproductionOffer = actionFact('test-reproduction-offer', 1, reproductionProposer.id, { kind: 'talk', speakerMeaning: { id: reproductionAgreementId, kind: 'offer', summary: '共同尝试生殖', proposal: { kind: 'reproduce', proposerId: reproductionProposer.id, partnerId: reproductionPartner.id, expiresAtMonth: 3 } }, interpreters: [reproductionPartner.id] });
  recordAgreementAction(reproductionAgreementState, reproductionOffer);
  const reproductionAcceptance = actionFact('test-reproduction-acceptance', 2, reproductionPartner.id, { kind: 'talk', speakerMeaning: { id: 'test-reproduction-acceptance-content', kind: 'accept', referenceId: reproductionAgreementId }, interpreters: [reproductionProposer.id] });
  recordAgreementAction(reproductionAgreementState, reproductionAcceptance);
  const noConception = { ...actionFact('test-reproduction-no-conception', 2, reproductionPartner.id, { kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: reproductionProposer.id }], authorizationRef: reproductionAgreementId }), diff: { conceived: false } };
  recordAgreementAction(reproductionAgreementState, noConception);
  assert.equal(reproductionAgreementState.agreements[0]?.status, 'active', '未受孕的完成动作只记录窗口进展，不应提前履约');
  assert.deepEqual(reproductionAgreementState.agreements[0]?.reproductionAttemptEventIds, [noConception.id]);
  advanceAgreementLifecycle(reproductionAgreementState, (reproductionAgreementState.agreements[0]?.dueAtMonth ?? 14) + 1);
  assert.equal(reproductionAgreementState.agreements[0]?.status, 'expired', '尝试窗口到期仍未受孕时应结算为过期而非已履约');

  const inheritedRiskState = createInitialState(320, { endpoint: { kind: 'months', value: 3 }, chaosIntensity: 0 });
  inheritedRiskState.civilization.externalClimate = { epoch: 'stable', kind: 'temperate', severity: 0 };
  const inheritedRiskMother = inheritedRiskState.people[0];
  const inheritedRiskFather = inheritedRiskState.people[1];
  inheritedRiskMother.sex = 'female';
  inheritedRiskFather.sex = 'male';
  inheritedRiskMother.bornAtMonth = -30 * 12;
  inheritedRiskFather.bornAtMonth = -18 * 12;
  inheritedRiskFather.geneticParents = [inheritedRiskMother.id, 'earlier-parent'];
  placeWith(inheritedRiskFather, inheritedRiskMother);
  for (const person of inheritedRiskState.people) {
    person.body = { health: 100, hydration: 100, nutrition: 100 };
    person.conditions = [];
  }
  inheritedRiskMother.conditions.push({
    id: 'test-inherited-risk-pregnancy-1', kind: 'pregnancy', stage: 3, sinceMonth: 0, dueAtMonth: 1,
    otherPersonId: inheritedRiskFather.id, sourceEventIds: [],
  });
  const idlePlanner = { decide: () => ({ kind: 'idle', reason: '聚焦检查出生结算' }) };
  const afterFirstRelatedBirth = stepSimulation(inheritedRiskState, idlePlanner);
  const firstRelatedChild = afterFirstRelatedBirth.people.find((person) => person.bornAtMonth === 1);
  assert.ok(firstRelatedChild && firstRelatedChild.geneticLoad >= 0.5, '直系繁衍应允许发生，但后代应获得可追溯的遗传负荷');
  assert.ok(firstRelatedChild.relations.every((relation) => !relation.sourceEventIds.includes('e-0-environment-founding-0')), '新生儿不得继承先民共同抵达的关系来源');
  assert.ok(firstRelatedChild.relations.filter((relation) => !firstRelatedChild.geneticParents.includes(relation.personId)).every((relation) => relation.trust === 0 && relation.bond === 0 && relation.fear === 0 && relation.sourceEventIds.length === 0), '新生儿对非父母人物不得自动获得先民关系加成');
  assert.ok(Object.values(firstRelatedChild.baselineCapacities).every((value, index) => {
    const fields = ['locomotion', 'manipulation', 'perception', 'communication', 'cognition'];
    const field = fields[index];
    return value < Math.round((afterFirstRelatedBirth.people[0].baselineCapacities[field] + afterFirstRelatedBirth.people[1].baselineCapacities[field]) / 2);
  }), '遗传负荷应体现为后代基础能力下降，而不是禁止动作');
  const firstRiskKnowledge = afterFirstRelatedBirth.people[0].knowledge.find((fact) => fact.id === 'claim:close-kin-offspring-risk');
  assert.ok(firstRiskKnowledge && firstRiskKnowledge.confidence < 55, '单次体弱出生只应形成未稳定的风险认识');
  afterFirstRelatedBirth.people[0].conditions.push({
    id: 'test-inherited-risk-pregnancy-2', kind: 'pregnancy', stage: 3, sinceMonth: 1, dueAtMonth: 2,
    otherPersonId: afterFirstRelatedBirth.people[1].id, sourceEventIds: [],
  });
  const afterSecondRelatedBirth = stepSimulation(afterFirstRelatedBirth, idlePlanner);
  const learnedRisk = afterSecondRelatedBirth.people[0].knowledge.find((fact) => fact.id === 'claim:close-kin-offspring-risk');
  assert.ok((learnedRisk?.confidence ?? 0) >= 55, '重复可观察后果应通过记忆累积成能影响规划的风险认识');

  const witnessedViolenceState = createInitialState(310, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const attacker = witnessedViolenceState.people[0];
  const victim = witnessedViolenceState.people[1];
  const witness = witnessedViolenceState.people[2];
  placeWith(victim, attacker);
  placeWith(witness, attacker);
  // Keep the two observers in place for this focused memory assertion. People
  // aged one year or older may legitimately plan and leave before another
  // person's turn in planning tick 1.
  victim.generation = 1;
  witness.generation = 1;
  victim.bornAtMonth = -6;
  witness.bornAtMonth = -6;
  const violenceIntentId = 'intent-test-witnessed-violence';
  witnessedViolenceState.intents.push({
    id: violenceIntentId, ownerId: attacker.id, summary: '对近身人物施力', domain: 'strategic',
    goal: { kind: 'body-at-most', personId: victim.id, field: 'health', value: victim.body.health - 3 },
    nextAction: { kind: 'act', operation: 'exert', targets: [{ kind: 'person', personId: victim.id }] },
    target: { kind: 'person', personId: victim.id }, status: 'active', createdAtMonth: 0, lastProgressAtMonth: 0,
    progress: 0, sourceDecisionEventId: 'decision-test-violence', sourceFactIds: [], actionEventIds: [], replanCount: 0,
  });
  attacker.activeIntentId = violenceIntentId;
  witnessedViolenceState.decisionBudget.credits = 0;
  const afterViolence = await stepSimulationAsync(witnessedViolenceState, {
    async decideAll(contexts) { return contexts.map(() => ({ kind: 'idle', reason: '开局批量不改写已经固定的暴力动作' })); },
    takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
  });
  const violenceFact = afterViolence.world.past.find((event) => event.kind === 'action'
    && event.action.kind === 'act'
    && event.action.operation === 'exert'
    && event.diff.victimId === victim.id);
  assert.ok(violenceFact, '施力伤害应留下带受害者与见证者的真实动作事实');
  for (const observerId of [victim.id, witness.id]) assert.ok(afterViolence.people.find((person) => person.id === observerId)?.memories.some((memory) => memory.sourceEventIds.includes(violenceFact.id)), '受害者与见证者都必须记得同一暴力事件，供后续模型意图使用');

  const witnessedHuntState = createInitialState(321, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const hunter = witnessedHuntState.people[0];
  const huntWitness = witnessedHuntState.people[1];
  const distantPerson = witnessedHuntState.people[2];
  const huntedAnimal = witnessedHuntState.world.animals.find((animal) => animal.speciesId === 'deer');
  assert.ok(huntedAnimal, '动物死亡感知夹具必须有真实动物');
  huntedAnimal.position = { ...huntedAnimal.position, cellId: hunter.position.cellId, z: hunter.position.z };
  huntedAnimal.health = 1;
  const adjacentCell = hunter.position.cellId % witnessedHuntState.world.grid.width < witnessedHuntState.world.grid.width - 1
    ? hunter.position.cellId + 1
    : hunter.position.cellId - 1;
  huntWitness.position = { ...huntWitness.position, cellId: adjacentCell, z: hunter.position.z };
  const hunterX = hunter.position.cellId % witnessedHuntState.world.grid.width;
  const hunterY = Math.floor(hunter.position.cellId / witnessedHuntState.world.grid.width);
  const distantCell = (hunterX < witnessedHuntState.world.grid.width / 2 ? witnessedHuntState.world.grid.width - 1 : 0)
    + (hunterY < witnessedHuntState.world.grid.depth / 2 ? witnessedHuntState.world.grid.depth - 1 : 0) * witnessedHuntState.world.grid.width;
  distantPerson.position = { ...distantPerson.position, cellId: distantCell, z: hunter.position.z };
  hunter.baselineCapacities.perception = 100;
  hunter.baselineCapacities.manipulation = 100;
  hunter.inventory.push({ id: 'test-hunt-tool', materialId: 52, quantity: 1, sourceEventIds: [] });
  const huntAction = {
    kind: 'act', operation: 'hunt', toolStackId: 'test-hunt-tool',
    targets: [{ kind: 'animal', animalId: huntedAnimal.id }],
  };
  let huntOrder = 1;
  while (seededFraction(
    witnessedHuntState.seed,
    `human-hunt:1:${hunter.id}:${huntedAnimal.id}:e-1-action-${hunter.id}-${huntOrder}`,
  ) >= 0.9) huntOrder += 1;
  const huntFact = executePrimitiveAction(witnessedHuntState, hunter, huntAction, 1, huntOrder, {
    cause: 'intent', actionTick: 1,
  });
  appendFixtureEvents(witnessedHuntState, [huntFact]);
  assert.equal(huntFact.diff.killed, true, '定向夹具必须真实杀死动物');
  assert.ok(huntFact.diff.witnessedBy.includes(huntWitness.id), '视野内人物应成为动物死亡事实的见证者');
  assert.equal(huntFact.diff.witnessedBy.includes(distantPerson.id), false, '视野外人物不得凭空知道动物死亡');
  assert.ok(hunter.memories.some((memory) => memory.sourceEventIds.includes(huntFact.id)
    && memory.summary.includes('已经死亡')), '猎人自己的模型记忆必须明确知道目标动物已经死亡');
  assert.ok(huntWitness.memories.some((memory) => memory.sourceEventIds.includes(huntFact.id)
    && memory.summary.includes('亲眼看见')
    && memory.summary.includes('已经死亡')), '视野内见证者必须形成同源的动物死亡经历');
  assert.equal(distantPerson.memories.some((memory) => memory.sourceEventIds.includes(huntFact.id)), false, '视野外人物不得获得动物死亡经历');
  const huntWitnessContext = buildDecisionContexts(witnessedHuntState)
    .find((context) => context.person.id === huntWitness.id);
  assert.ok(huntWitnessContext, '动物死亡见证者应有后续决策上下文');
  assert.ok(buildDecisionRequestContext(huntWitnessContext).person.mindMarkdown.includes('已经死亡'), '下一次人物审议必须能读到亲眼见证的死亡事实，再自行改变关切');

  let restraintState = createInitialState(314, { endpoint: { kind: 'months', value: 3 }, chaosIntensity: 0 });
  const restrainer = restraintState.people[0];
  const restrainedPerson = restraintState.people[1];
  const releaser = restraintState.people[2];
  placeWith(restrainedPerson, restrainer);
  placeWith(releaser, restrainer);
  restrainedPerson.generation = 1;
  releaser.generation = 1;
  restrainedPerson.bornAtMonth = -10 * 12;
  releaser.bornAtMonth = -10 * 12;
  restrainedPerson.body.health = 15;
  restrainer.inventory = [{ id: 'test-restraint-rope', materialId: 23, quantity: 1, sourceEventIds: [] }];
  const restraintIntentId = 'intent-test-restraint';
  restraintState.intents.push({
    id: restraintIntentId, ownerId: restrainer.id, summary: '用绳约束无法抵抗的人', domain: 'strategic',
    goal: { kind: 'condition', personId: restrainedPerson.id, condition: 'restrained', present: true },
    nextAction: { kind: 'act', operation: 'combine', targets: [{ kind: 'inventory-stack', personId: restrainer.id, stackId: 'test-restraint-rope' }, { kind: 'person', personId: restrainedPerson.id }] },
    target: { kind: 'person', personId: restrainedPerson.id }, status: 'active', createdAtMonth: 0, lastProgressAtMonth: 0,
    progress: 0, sourceDecisionEventId: 'decision-test-restraint', sourceFactIds: [], actionEventIds: [], replanCount: 0,
  });
  restrainer.activeIntentId = restraintIntentId;
  restraintState.decisionBudget.credits = 0;
  restraintState = stepSimulation(restraintState, { decide() { return { kind: 'idle', reason: '不干扰拘束测试' }; } });
  const restraintFact = restraintState.world.past.find((event) => event.kind === 'action' && event.diff.restrainedPersonId === restrainedPerson.id && event.diff.conditionId);
  assert.ok(restraintFact && restraintState.people.find((person) => person.id === restrainedPerson.id)?.conditions.some((condition) => condition.kind === 'restrained'), '绳与无法抵抗者结合后应形成可追溯的拘束状态');
  assert.equal(restraintState.people.find((person) => person.id === restrainer.id)?.inventory.some((stack) => stack.materialId === 23), false, '形成拘束必须消耗真实私人绳索');
  for (const observerId of [restrainedPerson.id, releaser.id]) assert.ok(restraintState.people.find((person) => person.id === observerId)?.memories.some((memory) => memory.sourceEventIds.includes(restraintFact.id)), '被拘束者和见证者必须记住同一个强制约束事实');
  const releaseIntentId = 'intent-test-release-restraint';
  restraintState.intents.push({
    id: releaseIntentId, ownerId: releaser.id, summary: '从近身人物身上分离绳', domain: 'strategic',
    goal: { kind: 'condition', personId: restrainedPerson.id, condition: 'restrained', present: false },
    nextAction: { kind: 'act', operation: 'separate', targets: [{ kind: 'person', personId: restrainedPerson.id }] },
    target: { kind: 'person', personId: restrainedPerson.id }, status: 'active', createdAtMonth: 1, lastProgressAtMonth: 1,
    progress: 0, sourceDecisionEventId: 'decision-test-release-restraint', sourceFactIds: [restraintFact.id], actionEventIds: [], replanCount: 0,
  });
  restraintState.people.find((person) => person.id === releaser.id).activeIntentId = releaseIntentId;
  restraintState.decisionBudget.credits = 0;
  restraintState = stepSimulation(restraintState, { decide() { return { kind: 'idle', reason: '不干扰解除测试' }; } });
  assert.equal(restraintState.people.find((person) => person.id === restrainedPerson.id)?.conditions.some((condition) => condition.kind === 'restrained'), false, '近身他人应能用 separate 解除绳索拘束');
  assert.equal(restraintState.people.find((person) => person.id === releaser.id)?.inventory.find((stack) => stack.materialId === 23)?.quantity, 1, '解除拘束应把同一物质重新变为解除者的私人绳索');

  const waterAssistState = createInitialState(311, { endpoint: { kind: 'months', value: 24 } });
  const waterRequester = waterAssistState.people[0];
  const waterHelper = waterAssistState.people[1];
  const surfaceAt = (state, cell) => {
    for (let z = state.world.grid.levels - 1; z >= 0; z -= 1) {
      const materialId = state.world.grid.voxels[z * state.world.grid.width * state.world.grid.depth + cell];
      if (materialId !== 0) return materialId;
    }
    return 0;
  };
  const waterCell = Array.from({ length: waterAssistState.world.grid.width * waterAssistState.world.grid.depth }, (_, cell) => cell).find((cell) => surfaceAt(waterAssistState, cell) === 7);
  const neighbors = (cell, width, depth) => [cell - width, cell - 1, cell + 1, cell + width]
    .filter((candidate) => candidate >= 0 && candidate < width * depth && Math.abs(candidate % width - cell % width) + Math.abs(Math.floor(candidate / width) - Math.floor(cell / width)) === 1);
  const waterBank = waterCell === undefined ? undefined : neighbors(waterCell, waterAssistState.world.grid.width, waterAssistState.world.grid.depth).find((cell) => surfaceAt(waterAssistState, cell) !== 7);
  assert.ok(Number.isInteger(waterBank), '测试世界应存在水边格');
  waterRequester.position.cellId = waterBank;
  waterHelper.position.cellId = waterBank;
  waterRequester.position.z = surfaceStandingZ(waterAssistState, waterBank);
  waterHelper.position.z = waterRequester.position.z;
  const waterAssistId = 'test-water-assist';
  const waterProposal = { ...actionFact('test-water-proposal', 1, waterRequester.id, { kind: 'talk', speakerMeaning: { id: waterAssistId, kind: 'request', summary: '请帮助我找水', proposal: { kind: 'assist', requesterId: waterRequester.id, helperId: waterHelper.id, need: 'water', expiresAtMonth: 4 } }, interpreters: [waterHelper.id] }), cellId: waterBank };
  recordAgreementAction(waterAssistState, waterProposal);
  appendFixtureEvents(waterAssistState, [waterProposal]);
  waterRequester.bornAtMonth = -20 * 12;
  waterHelper.bornAtMonth = -20 * 12;
  waterRequester.body.hydration = 80;
  assert.equal(buildDecisionContexts(waterAssistState).find((context) => context.person.id === waterHelper.id)?.options.some((option) => option.id.startsWith('accept-assist:')), false, '求助者已自行解除缺水时，帮助者不得再接受一项失效需求');
  waterRequester.body.hydration = 20;
  assert.ok(buildDecisionContexts(waterAssistState).find((context) => context.person.id === waterHelper.id)?.options.some((option) => option.id.startsWith('accept-assist:')), '求助者仍然缺水且存在可达水源时，帮助者才能接受');
  const waterAcceptance = { ...actionFact('test-water-acceptance', 2, waterHelper.id, { kind: 'talk', speakerMeaning: { id: 'test-water-acceptance-content', kind: 'accept', referenceId: waterAssistId }, interpreters: [waterRequester.id] }), cellId: waterBank };
  recordAgreementAction(waterAssistState, waterAcceptance);
  appendFixtureEvents(waterAssistState, [waterAcceptance]);
  const helperWaterIntentId = 'intent-test-water-helper';
  const requesterWaterIntentId = 'intent-test-water-requester';
  waterAssistState.intents.push(
    { id: helperWaterIntentId, ownerId: waterHelper.id, agreementId: waterAssistId, status: 'active' },
    { id: requesterWaterIntentId, ownerId: waterRequester.id, agreementId: waterAssistId, status: 'active' },
  );
  const helperArrival = { ...actionFact('test-water-helper-arrival', 3, waterHelper.id, { kind: 'move', toCellId: waterBank }), intentId: helperWaterIntentId, cellId: waterBank, toCellId: waterBank };
  recordAgreementAction(waterAssistState, helperArrival);
  appendFixtureEvents(waterAssistState, [helperArrival]);
  assert.equal(waterAssistState.agreements[0]?.status, 'active', '帮助者独自到达水边还不能算完成求助');
  const requesterDrink = { ...actionFact('test-water-requester-drink', 3, waterRequester.id, { kind: 'act', operation: 'ingest', targets: [] }), intentId: requesterWaterIntentId, cellId: waterBank, diff: { materialId: 7, hydration: 58 } };
  recordAgreementAction(waterAssistState, requesterDrink);
  assert.equal(waterAssistState.agreements[0]?.status, 'fulfilled', '帮助者到场且求助者真实饮水后，水求助才履约');

  const companionState = createInitialState(33, { endpoint: { kind: 'months', value: 36 } });
  const companionA = companionState.people[0];
  const companionB = companionState.people[1];
  placeWith(companionB, companionA);
  const companionId = 'test-companion-agreement';
  const companionProposal = { ...actionFact('test-companion-proposal', 1, companionA.id, { kind: 'talk', speakerMeaning: { id: companionId, kind: 'offer', summary: '结伴', proposal: { kind: 'companion', proposerId: companionA.id, partnerId: companionB.id, expiresAtMonth: 4 } }, interpreters: [companionB.id] }), cellId: companionA.position.cellId, fromCellId: companionA.position.cellId, toCellId: companionA.position.cellId, fromZ: companionA.position.z, toZ: companionA.position.z, pathSegment: [companionA.position.cellId] };
  const companionAcceptance = { ...actionFact('test-companion-acceptance', 2, companionB.id, { kind: 'talk', speakerMeaning: { id: 'test-companion-acceptance-content', kind: 'accept', referenceId: companionId }, interpreters: [companionA.id] }), cellId: companionB.position.cellId, fromCellId: companionB.position.cellId, toCellId: companionB.position.cellId, fromZ: companionB.position.z, toZ: companionB.position.z, pathSegment: [companionB.position.cellId] };
  recordAgreementAction(companionState, companionProposal);
  recordAgreementAction(companionState, companionAcceptance);
  for (let month = 3; month <= 27; month += 1) advanceAgreementLifecycle(companionState, month);
  assert.equal(companionState.agreements[0]?.status, 'active', '完成足够月份的稳定共同生活后，结伴应作为可撤回的持续关系保持生效');
  assert.ok(Number.isInteger(companionState.agreements[0]?.companionEstablishedAtMonth), '结伴建立月份必须由累计共同生活事实确定');
  assert.ok((companionState.agreements[0]?.coLocatedMonths ?? 0) >= 12);

  const breachState = createInitialState(32, { endpoint: { kind: 'months', value: 24 } });
  const breachRequester = breachState.people[0];
  const breachHelper = breachState.people[1];
  const breachId = 'test-breach-agreement';
  const breachProposal = actionFact('test-breach-proposal', 1, breachRequester.id, { kind: 'talk', speakerMeaning: { id: breachId, kind: 'request', summary: '请帮助我', proposal: { kind: 'assist', requesterId: breachRequester.id, helperId: breachHelper.id, need: 'food', expiresAtMonth: 3 } }, interpreters: [breachHelper.id] });
  recordAgreementAction(breachState, breachProposal);
  appendFixtureEvents(breachState, [breachProposal]);
  const breachAcceptance = actionFact('test-breach-acceptance', 2, breachHelper.id, { kind: 'talk', speakerMeaning: { id: 'test-breach-acceptance-content', kind: 'accept', referenceId: breachId }, interpreters: [breachRequester.id] });
  recordAgreementAction(breachState, breachAcceptance);
  appendFixtureEvents(breachState, [breachAcceptance]);
  advanceAgreementLifecycle(breachState, 9);
  assert.equal(breachState.agreements[0]?.status, 'breached', '超过履行期限的有效 Agreement 应明确违约');

  const birthState = createInitialState(312, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const mother = birthState.people.find((person) => person.sex === 'female') ?? birthState.people[0];
  const father = birthState.people.find((person) => person.sex === 'male' && person.id !== mother?.id) ?? birthState.people.find((person) => person.id !== mother?.id);
  assert.ok(mother && father, '出生关系测试需要一名女性和一名男性');
  mother.sex = 'female';
  father.sex = 'male';
  mother.conditions.push({ id: 'test-due-pregnancy', kind: 'pregnancy', stage: 3, sinceMonth: -8, dueAtMonth: 1, otherPersonId: father.id, sourceEventIds: ['test-conception'] });
  const afterBirth = stepSimulation(birthState, { decide() { return { kind: 'idle', reason: '不干扰出生测试' }; } });
  const child = afterBirth.people.find((person) => person.generation > 0);
  const birthEvent = afterBirth.world.past.find((event) => event.kind === 'environment' && event.diff.bornPersonId === child?.id);
  assert.ok(child && birthEvent, '到期妊娠应产生有来源的出生事实');
  for (const parentId of child.geneticParents) {
    const childToParent = child.relations.find((relation) => relation.personId === parentId);
    const parentToChild = afterBirth.people.find((person) => person.id === parentId)?.relations.find((relation) => relation.personId === child.id);
    assert.ok((childToParent?.bond ?? 0) >= 12, '孩子指向亲生父母的亲近应至少包含出生事实提供的初值');
    assert.ok((parentToChild?.bond ?? 0) >= 12, '亲生父母指向孩子的亲近应至少包含出生事实提供的初值');
    assert.ok(childToParent?.sourceEventIds.includes(birthEvent.id) && parentToChild?.sourceEventIds.includes(birthEvent.id));
  }
  const caregiver = afterBirth.people.find((person) => person.id === child.geneticParents[0]);
  const destination = [caregiver.position.cellId - afterBirth.world.grid.width, caregiver.position.cellId - 1, caregiver.position.cellId + 1, caregiver.position.cellId + afterBirth.world.grid.width]
    .find((cell) => cell >= 0 && cell < afterBirth.world.grid.width * afterBirth.world.grid.depth && surfaceAt(afterBirth, cell) !== 0 && surfaceAt(afterBirth, cell) !== 7 && surfaceAt(afterBirth, cell) !== 13 && surfaceAt(afterBirth, cell) !== 14);
  assert.ok(caregiver && Number.isInteger(destination), '出生地附近应有一个可携幼儿移动的地表格');
  const carryIntentId = 'intent-test-carry-child';
  afterBirth.intents.push({
    id: carryIntentId, ownerId: caregiver.id, summary: '带幼儿移动', domain: 'strategic',
    goal: { kind: 'at-cell', cellId: destination }, nextAction: { kind: 'move', toCellId: destination }, status: 'active',
    createdAtMonth: 1, lastProgressAtMonth: 1, progress: 0, sourceDecisionEventId: 'test-carry-decision', sourceFactIds: [birthEvent.id], actionEventIds: [], replanCount: 0,
  });
  caregiver.activeIntentId = carryIntentId;
  let caredChildState = stepSimulation(afterBirth, { decide() { return { kind: 'idle', reason: '不干扰携幼测试' }; } });
  const carriedChild = caredChildState.people.find((person) => person.id === child.id);
  const carryFact = caredChildState.world.past.find((event) => event.kind === 'action' && Array.isArray(event.diff.carriedPersonIds) && event.diff.carriedPersonIds.includes(child.id));
  assert.ok(carryFact && carriedChild?.position.cellId === caredChildState.people.find((person) => person.id === caregiver.id)?.position.cellId, '父母移动必须真实携带未满 1 岁的清醒婴儿并写入动作事实');
  const activeCaregiver = caredChildState.people.find((person) => person.id === caregiver.id);
  activeCaregiver.body = { health: 100, hydration: 100, nutrition: 100 };
  activeCaregiver.inventory.push({ id: 'test-child-food', materialId: 21, quantity: 1, sourceEventIds: [] });
  carriedChild.body.nutrition = 20;
  caredChildState = stepSimulation(caredChildState, { decide() { return { kind: 'idle', reason: '不干扰喂养测试' }; } });
  const feeding = caredChildState.world.past.find((event) => event.kind === 'action' && event.action.kind === 'transfer' && event.action.to.kind === 'person' && event.action.to.personId === child.id);
  assert.ok(feeding && caredChildState.people.find((person) => person.id === child.id)?.body.nutrition > 20, '幼儿营养危险时，父母应转移真实食物，幼儿再通过摄入恢复');
  assert.ok(caredChildState.derived.milestones.some((milestone) => milestone.capabilityId === 3), '携带和真实喂养的事实链应被观察为养育幼儿');
  const hibernationCaregiver = caredChildState.people.find((person) => person.id === caregiver.id);
  const hibernationChild = caredChildState.people.find((person) => person.id === child.id);
  placeWith(hibernationChild, hibernationCaregiver);
  hibernationCaregiver.body = { health: 100, hydration: 100, nutrition: 100 };
  hibernationChild.body = { health: 100, hydration: 100, nutrition: 100 };
  const childHeatExposureId = 'test-dependent-child-heat-exposure';
  hibernationChild.conditions = [{
    id: 'test-dependent-child-heat-condition', kind: 'heat', stage: 3,
    sinceMonth: caredChildState.clock.elapsedMonths, sourceEventIds: [childHeatExposureId],
  }];
  appendFixtureEvents(caredChildState, [{
    id: childHeatExposureId, kind: 'environment', change: 'condition',
    atMonth: caredChildState.clock.elapsedMonths, orderInMonth: caredChildState.world.past.length,
    cellId: hibernationChild.position.cellId, who: hibernationChild.id,
    result: '孩子在严重高温中受到暴露', diff: { condition: 'heat', stage: 3 },
  }]);
  caredChildState.civilization.epoch = 'chaotic';
  caredChildState.civilization.climate = {
    kind: 'heat', severity: 5, sinceMonth: caredChildState.clock.elapsedMonths,
  };
  caredChildState.civilization.externalClimate = { epoch: 'chaotic', kind: 'heat', severity: 5 };
  caredChildState = stepSimulation(caredChildState, { decide() { return { kind: 'idle', reason: '不干扰乱纪元照护测试' }; } });
  const assistedHibernation = caredChildState.world.past.find((event) => event.kind === 'action'
    && event.action.kind === 'act'
    && event.action.operation === 'dehydrate'
    && event.diff.assistedDependentId === child.id);
  assert.ok(assistedHibernation, '严重乱纪元中，亲代应以一条近身行动辅助未满十二岁的同地孩子脱水');
  assert.ok(caredChildState.people.find((person) => person.id === child.id)?.conditions.some((condition) => condition.kind === 'dehydrated-hibernation' && condition.sourceEventIds.includes(assistedHibernation.id)), '受助休眠必须落在孩子身体上并引用亲代行动事实');

  const agingState = createInitialState(313, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const elder = agingState.people[0];
  elder.bornAtMonth = -elder.lifespanMonths;
  elder.body = { health: 100, hydration: 100, nutrition: 100 };
  const afterBaseline = stepSimulation(agingState, { decide() { return { kind: 'idle', reason: '不干扰衰老测试' }; } });
  assert.equal(afterBaseline.people.find((person) => person.id === elder.id)?.diedAtMonth, undefined, '达到寿命基线月份不能在身体健康时被日期直接杀死');

  let dialogueState = createInitialState(31, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const speaker = dialogueState.people[0];
  const listener = dialogueState.people[1];
  placeWith(listener, speaker);
  const dialogueContext = buildDecisionContexts(dialogueState).find((context) => context.person.id === speaker.id);
  assert.ok(dialogueContext, '测试人物必须拥有决策上下文');
  const collectMaterials = dialogueContext.options.filter((option) => option.id.startsWith('collect:')).map((option) => option.goal.kind === 'inventory-at-least' ? option.goal.materialId : -1);
  assert.equal(new Set(collectMaterials).size, collectMaterials.length, '同一物质只应暴露最近的一项取得机会');
  assert.ok(dialogueContext.options.filter((option) => option.nextAction.kind === 'talk')
    .every((option) => !option.requiresFollowUp || (option.nextAction.speakerMeaning.kind === 'claim'
      && option.nextAction.speakerMeaning.conversation?.turn === 'opening')), '结构化提议、预测、教学和回应不能被强行拼接无关物理动作');

  const groundedDialogueState = createInitialState(318, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const groundedSpeaker = groundedDialogueState.people[0];
  const groundedListener = groundedDialogueState.people[1];
  groundedSpeaker.bornAtMonth = -20 * 12;
  groundedListener.generation = 1;
  groundedListener.bornAtMonth = -10 * 12;
  placeWith(groundedListener, groundedSpeaker);
  const groundedFact = { id: 'technique:test-grounded-dialogue', kind: 'technique', summary: '辨认湿土附近水源', confidence: 72, learnedAtMonth: 0, sourceEventIds: ['test-grounded-observation'] };
  groundedSpeaker.knowledge = [groundedFact];
  groundedListener.knowledge = [];
  const groundedContext = buildDecisionContexts(groundedDialogueState, groundedDialogueState.clock.elapsedMonths + 1)
    .find((context) => context.person.id === groundedSpeaker.id);
  const groundedTalk = groundedContext?.options.find((option) => option.id.startsWith('teach:')
    && option.nextAction.kind === 'talk'
    && option.nextAction.speakerMeaning.kind === 'claim'
    && option.nextAction.speakerMeaning.factId === groundedFact.id);
  assert.ok(groundedContext && groundedTalk && !groundedTalk.requiresFollowUp && groundedTalk.sourceFactIds.includes('test-grounded-observation'), '分享认识本身是完整沟通动作，并且必须绑定事实身份与来源');
  const groundedPromptOption = buildDecisionRequestContext(groundedContext).options.find((option) => option.id === groundedTalk.id);
  assert.equal(groundedPromptOption?.talksFactId, groundedFact.id, '模型必须看见本次对话固定绑定的事实身份');
  groundedDialogueState.decisionBudget.credits = groundedDialogueState.people.length;
  groundedDialogueState.decisionBudget.ledgers = [{ atMonth: 1, livingAgents: 60, candidates: 0, modelContexts: 0, inputTokens: 0, outputTokens: 0, chargedTokens: 0 }];
  const groundedAfterTalk = await stepSimulationAsync(groundedDialogueState, {
    async decideAll(contexts) {
      return contexts.map((context) => context.person.id === groundedSpeaker.id
        ? { kind: 'start', optionId: groundedTalk.id, utterance: '我亲眼见过北边湿土附近有水', reason: '把真实所见告诉对方' }
        : { kind: 'idle', reason: '不干扰有来源对话测试' });
    },
    takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
  });
  const heardFact = groundedAfterTalk.people.find((person) => person.id === groundedListener.id)?.knowledge.find((fact) => fact.id === groundedFact.id);
  assert.equal(heardFact?.summary, groundedFact.summary, '自然语言措辞不能覆盖结构化认识的规范摘要');
  assert.ok((heardFact?.confidence ?? 0) >= 55 && heardFact?.sourceEventIds.some((id) => id.includes('action')), '明确教学可以传递可靠技术，但仍必须保留沟通动作来源');
  const groundedAction = groundedAfterTalk.world.past.find((event) => event.kind === 'action'
    && event.who === groundedSpeaker.id
    && event.action.kind === 'talk'
    && event.action.speakerMeaning.kind === 'claim'
    && event.action.speakerMeaning.factId === groundedFact.id);
  assert.equal(groundedAction?.action.kind === 'talk' ? groundedAction.action.speakerMeaning.summary : undefined,
    groundedTalk.nextAction.kind === 'talk' ? groundedTalk.nextAction.speakerMeaning.summary : undefined,
    '模型台词必须与权威沟通摘要分离，不能写回 ActionFact 或后续记忆');
  assert.notEqual(groundedAction?.action.kind === 'talk' ? groundedAction.action.speakerMeaning.summary : undefined,
    '我亲眼见过北边湿土附近有水',
    '模型表层措辞不能取代规则决定的沟通事实');
  const groundedIntent = groundedAfterTalk.intents.find((intent) => intent.ownerId === groundedSpeaker.id
    && intent.nextAction.kind === 'talk'
    && intent.nextAction.speakerMeaning.id === groundedTalk.id);
  assert.equal(groundedIntent?.openingAction, undefined, '事实分享不应伪装成另一个无关目标的开场动作');
  assert.ok(groundedIntent?.actionEventIds.some((eventId) => groundedAfterTalk.world.past.some((event) => event.id === eventId
    && event.kind === 'action' && event.action.kind === 'talk')), '事实分享应留下自己的完整沟通动作');

  let harvestState = createInitialState(34, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const harvester = harvestState.people[0];
  harvester.bornAtMonth = -20 * 12;
  const harvestCell = harvester.position.cellId;
  const harvestX = harvestCell % harvestState.world.grid.width;
  const harvestY = Math.floor(harvestCell / harvestState.world.grid.width);
  let harvestZ = harvestState.world.grid.levels - 1;
  while (harvestZ > 0 && harvestState.world.grid.voxels[harvestZ * harvestState.world.grid.width * harvestState.world.grid.depth + harvestCell] === 0) harvestZ -= 1;
  harvestState.world.grid.voxels[harvestZ * harvestState.world.grid.width * harvestState.world.grid.depth + harvestCell] = 12;
  harvestState.world.drops.push({ id: 'test-competing-food', materialId: 21, cellId: harvestCell, quantity: 3, createdAtMonth: 0, sourceEventIds: [] });
  const harvestContext = buildDecisionContexts(harvestState, harvestState.clock.elapsedMonths + 1)
    .find((context) => context.person.id === harvester.id);
  assert.ok(harvestContext, '采收测试必须拥有决策上下文');
  const harvestOption = harvestContext.options.find((option) => option.id === `harvest:${harvestCell}`);
  assert.ok(harvestOption && harvestOption.target?.kind === 'voxel' && harvestOption.target.position.x === harvestX && harvestOption.target.position.y === harvestY, '成熟作物应产生具体体素目标的采收机会');
  harvestState.decisionBudget.credits = harvestState.people.length;
  harvestState.decisionBudget.ledgers = [{ atMonth: 1, livingAgents: 60, candidates: 0, modelContexts: 0, inputTokens: 0, outputTokens: 0, chargedTokens: 0 }];
  harvestState = await stepSimulationAsync(harvestState, {
    async decideAll(contexts) {
      return contexts.map((context) => context.person.id === harvester.id
        ? { kind: 'start', optionId: harvestOption.id, reason: '采收指定成熟作物' }
        : { kind: 'idle', reason: '不干扰采收测试' });
    },
    takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
  });
  const harvestIntent = harvestState.intents.find((intent) => intent.ownerId === harvester.id && intent.target?.kind === 'voxel');
  assert.ok((harvestIntent?.plannedDurationMonths ?? 0) >= 3 && (harvestIntent?.plannedDurationMonths ?? 99) <= 12, '一次性生产目标仍应保留有界复核估时，但估时不得冒充维护锁');
  assert.equal(harvestIntent?.lifecycle?.completion, 'on-achievement', '采收属于一次性成就，不应从 inventory goal.kind 推断维护语义');
  assert.equal(harvestIntent?.stateGoalUntilMonth, undefined, '新采收意图不得写入 legacy 状态维持期限');
  assert.equal(harvestIntent?.status, 'completed', '真实采收达成库存目标后应当月结算');
  const firstHarvestAction = harvestState.world.past.find((event) => event.kind === 'action' && event.intentId === harvestIntent?.id);
  assert.equal(firstHarvestAction?.action.kind, 'act', '指定采收目标必须先执行分离，不能被附近野生食物偷换');
  assert.equal(firstHarvestAction?.diff.sourceMaterialId, 12, '采收事实必须来自目标成熟作物');

  let survivalHarvestState = createInitialState(341, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const survivalHarvester = survivalHarvestState.people[0];
  survivalHarvester.bornAtMonth = -20 * 12;
  survivalHarvester.inventory = [];
  survivalHarvester.body.nutrition = 20;
  const survivalCell = survivalHarvester.position.cellId;
  let survivalZ = survivalHarvestState.world.grid.levels - 1;
  while (survivalZ > 0 && survivalHarvestState.world.grid.voxels[survivalZ * survivalHarvestState.world.grid.width * survivalHarvestState.world.grid.depth + survivalCell] === 0) survivalZ -= 1;
  survivalHarvestState.world.grid.voxels[survivalZ * survivalHarvestState.world.grid.width * survivalHarvestState.world.grid.depth + survivalCell] = 10;
  survivalHarvestState.world.drops = survivalHarvestState.world.drops.filter((drop) => drop.materialId !== 21);
  survivalHarvestState.decisionBudget.credits = 0;
  survivalHarvestState = stepSimulation(survivalHarvestState, { decide() { return { kind: 'idle', reason: '紧急采食不应依赖模型' }; } });
  const emergencyHarvest = survivalHarvestState.world.past.find((event) => event.kind === 'action'
    && event.who === survivalHarvester.id
    && event.cause === 'survival-reflex'
    && event.action.kind === 'act'
    && event.action.operation === 'separate');
  assert.equal(emergencyHarvest?.diff.sourceMaterialId, 10, '背包无食物且营养危险时，应从眼前结果灌木执行真实分离，而不是等待模型或凭空进食');
  const emergencyFoodActions = survivalHarvestState.world.past.filter((event) => event.kind === 'action' && event.who === survivalHarvester.id && event.cause === 'survival-reflex');
  assert.ok(emergencyFoodActions.some((event) => event.action.kind === 'transfer' && event.diff.materialId === 21 && event.action.to.kind === 'person' && event.action.to.personId === survivalHarvester.id), '分离出的食物必须先通过 transfer 进入本人的私有背包');
  assert.ok(emergencyFoodActions.some((event) => event.action.kind === 'act' && event.action.operation === 'ingest' && event.diff.materialId === 21), '进入私有背包后才可由同一人物摄入，不能直接从观察标签恢复营养');

  let hydrationReflexState = createInitialState(342, { endpoint: { kind: 'months', value: 3 }, chaosIntensity: 0 });
  const thirsty = hydrationReflexState.people[0];
  thirsty.bornAtMonth = -20 * 12;
  thirsty.body.hydration = 50;
  thirsty.body.nutrition = 90;
  const adjacentWaterCell = thirsty.position.cellId % hydrationReflexState.world.grid.width < hydrationReflexState.world.grid.width - 1
    ? thirsty.position.cellId + 1
    : thirsty.position.cellId - 1;
  let waterZ = hydrationReflexState.world.grid.levels - 1;
  while (waterZ > 0 && hydrationReflexState.world.grid.voxels[waterZ * hydrationReflexState.world.grid.width * hydrationReflexState.world.grid.depth + adjacentWaterCell] === 0) waterZ -= 1;
  hydrationReflexState.world.grid.voxels[waterZ * hydrationReflexState.world.grid.width * hydrationReflexState.world.grid.depth + adjacentWaterCell] = 7;
  hydrationReflexState.decisionBudget.credits = 0;
  hydrationReflexState = stepSimulation(hydrationReflexState, { decide() { return { kind: 'idle', reason: '可达饮水不应依赖模型' }; } });
  const timelyDrink = hydrationReflexState.world.past.find((event) => event.kind === 'action'
    && event.who === thirsty.id
    && event.cause === 'survival-reflex'
    && event.action.kind === 'act'
    && event.action.operation === 'ingest'
    && event.diff.materialId === 7);
  assert.ok(timelyDrink, '水分低于维护阈值且水源能在脱水余量内到达时，应立即饮水而不是拖到极度脱水');
  const returningPerson = hydrationReflexState.people.find((person) => person.id === thirsty.id);
  const rememberedWater = returningPerson.knownPlaces.find((place) => place.materialId === 7);
  assert.ok(rememberedWater && rememberedWater.sourceEventIds.includes(timelyDrink.id), '亲自饮用后必须记住有行动来源的水体素位置');
  let remotePosition = null;
  for (let cell = 0; cell < hydrationReflexState.world.grid.width * hydrationReflexState.world.grid.depth; cell += 1) {
    const z = surfaceStandingZ(hydrationReflexState, cell);
    returningPerson.position.cellId = cell;
    returningPerson.position.z = z;
    const access = findReachableWater(hydrationReflexState, returningPerson);
    if (access?.remembered && access.pathLength > 10) {
      remotePosition = { cellId: cell, z, bankPosition: access.bankPosition };
      break;
    }
  }
  assert.ok(remotePosition, '测试世界中应存在离开水源视野但仍与已知岸边连通的位置');
  returningPerson.position = { ...returningPerson.position, cellId: remotePosition.cellId, z: remotePosition.z, previousCellId: remotePosition.cellId, previousZ: remotePosition.z, lastPath: [remotePosition.cellId], tickPath: [remotePosition.cellId] };
  returningPerson.body.hydration = 30;
  hydrationReflexState.decisionBudget.credits = 0;
  hydrationReflexState = stepSimulation(hydrationReflexState, { decide() { return { kind: 'idle', reason: '已知水源返程不应依赖模型' }; } });
  const returnToKnownWater = hydrationReflexState.lastStep.find((event) => event.kind === 'action'
    && event.who === thirsty.id
    && event.cause === 'survival-reflex'
    && event.action.kind === 'move'
    && event.action.toCellId === remotePosition.bankPosition.cellId
    && event.action.toZ === remotePosition.bankPosition.z);
  assert.ok(returnToKnownWater, '水源离开当前视野后，危急生存反射仍应沿有限地点记忆返回，而不是原地失忆');
  const personAfterReturn = hydrationReflexState.people.find((person) => person.id === thirsty.id);
  for (const place of personAfterReturn.knownPlaces.filter((candidate) => candidate.materialId === 7)) {
    const rememberedWaterIndex = place.position.z * hydrationReflexState.world.grid.width * hydrationReflexState.world.grid.depth
      + place.position.y * hydrationReflexState.world.grid.width + place.position.x;
    hydrationReflexState.world.grid.voxels[rememberedWaterIndex] = 0;
  }
  assert.equal(findReachableWater(hydrationReflexState, personAfterReturn, []), null, '记忆地点的物质消失后不得继续把旧坐标当作水源');

  const tentativeTechniqueState = createInitialState(35, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  tentativeTechniqueState.people[0].knowledge.push({ id: 'technique:test', kind: 'technique', summary: '暂定结合经验', confidence: 46, learnedAtMonth: 0, sourceEventIds: ['test-combine'] });
  const testPosition = { x: tentativeTechniqueState.people[0].position.cellId % tentativeTechniqueState.world.grid.width, y: Math.floor(tentativeTechniqueState.people[0].position.cellId / tentativeTechniqueState.world.grid.width), z: 0 };
  appendFixtureEvents(tentativeTechniqueState, [{ ...actionFact('test-combine', 0, tentativeTechniqueState.people[0].id, { kind: 'act', operation: 'combine', targets: [] }), diff: { position: testPosition, outputMaterialId: tentativeTechniqueState.world.grid.voxels[tentativeTechniqueState.people[0].position.cellId] } }]);
  const tentativeContext = buildDecisionContexts(tentativeTechniqueState, tentativeTechniqueState.clock.elapsedMonths + 1)
    .find((context) => context.person.id === tentativeTechniqueState.people[0].id);
  assert.equal(tentativeContext?.options.some((option) => option.id.startsWith('teach:')), false, '一次成功结合还不能直接传授为可靠技术');
  const verifyOption = tentativeContext?.options.find((option) => option.id.startsWith('verify-technique:'));
  assert.ok(verifyOption, '暂定技术应提供使用 attend 核验真实产物的机会');
  const verifyIntentId = 'intent-test-verify-technique';
  tentativeTechniqueState.intents.push({
    id: verifyIntentId, ownerId: tentativeTechniqueState.people[0].id, summary: verifyOption.summary, domain: 'strategic',
    goal: verifyOption.goal, nextAction: verifyOption.nextAction, target: verifyOption.target, status: 'active',
    createdAtMonth: 0, lastProgressAtMonth: 0, progress: 0, sourceDecisionEventId: 'test-verify-decision',
    plannedDurationMonths: 3, stateGoalUntilMonth: 2,
    sourceFactIds: verifyOption.sourceFactIds, actionEventIds: [], replanCount: 0,
  });
  tentativeTechniqueState.people[0].activeIntentId = verifyIntentId;
  tentativeTechniqueState.decisionBudget.credits = 0;
  const verifiedTechniqueState = await stepSimulationAsync(tentativeTechniqueState, {
    async decideAll(contexts) { return contexts.map(() => ({ kind: 'idle', reason: '开局批量不改写固定活动意图' })); },
    takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
  });
  assert.ok((verifiedTechniqueState.people[0].knowledge.find((fact) => fact.id === 'technique:test')?.confidence ?? 0) >= 55, '主动观察真实产物后技术才能达到可传播置信度');
  assert.ok(verifiedTechniqueState.derived.milestones.some((milestone) => milestone.capabilityId === 59), '尝试加核验的事实链才能观察为用实验检验猜想');

  const carriedVerificationState = createInitialState(3501, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const carriedVerifier = carriedVerificationState.people[0];
  carriedVerifier.knowledge.push({
    id: 'technique:expose:21:16:25', kind: 'technique', summary: '让食物暴露于火可得到熟食',
    confidence: 46, learnedAtMonth: 0, sourceEventIds: ['test-expose-with-position-and-stack'],
  });
  carriedVerifier.inventory.push({
    id: 'test-expose-cooked-output', materialId: 25, quantity: 1,
    sourceEventIds: ['test-expose-with-position-and-stack'],
  });
  const misleadingFirePosition = {
    x: carriedVerifier.position.cellId % carriedVerificationState.world.grid.width,
    y: Math.floor(carriedVerifier.position.cellId / carriedVerificationState.world.grid.width),
    z: Math.max(0, carriedVerifier.position.z - 1),
  };
  appendFixtureEvents(carriedVerificationState, [{
    ...actionFact('test-expose-with-position-and-stack', 0, carriedVerifier.id, {
      kind: 'act', operation: 'expose', targets: [],
    }),
    diff: {
      position: misleadingFirePosition,
      outputMaterialId: 25,
      outputStackId: 'test-expose-cooked-output',
    },
  }]);
  const carriedVerificationOption = buildDecisionContexts(carriedVerificationState, 1)
    .find((context) => context.person.id === carriedVerifier.id)?.options
    .find((option) => option.id.startsWith('verify-technique:technique:expose:21:16:25:'));
  assert.equal(carriedVerificationOption?.nextAction.kind, 'attend');
  assert.equal(carriedVerificationOption?.nextAction.target.kind, 'inventory-stack',
    'when an operation records both its working position and a carried output, verification must bind the produced stack');
  assert.deepEqual(carriedVerificationOption?.nextAction.verification, {
    techniqueId: 'technique:expose:21:16:25',
    sourceEventId: 'test-expose-with-position-and-stack',
    expectedMaterialId: 25,
  }, 'verification must carry the exact technique, producing event, and expected output material');
  const carriedVerificationIntent = {
    id: 'intent-test-carried-output-verification', ownerId: carriedVerifier.id,
    summary: carriedVerificationOption.summary, domain: 'strategic',
    goal: carriedVerificationOption.goal, nextAction: carriedVerificationOption.nextAction,
    target: carriedVerificationOption.target, status: 'active', createdAtMonth: 0,
    lastProgressAtMonth: 0, progress: 0, sourceDecisionEventId: 'test-carried-verification-decision',
    sourceFactIds: carriedVerificationOption.sourceFactIds, actionEventIds: [], replanCount: 0,
  };
  carriedVerificationState.intents.push(carriedVerificationIntent);
  carriedVerifier.activeIntentId = carriedVerificationIntent.id;
  const carriedVerificationFact = executeActiveIntent(
    carriedVerificationState,
    carriedVerifier,
    1,
    0,
    1,
    [],
  );
  assert.equal(carriedVerificationFact?.diff.verifiedTechnique, true);
  assert.equal(carriedVerificationIntent.status, 'completed',
    'one successful source-bound output inspection must finish the verification intent');
  assert.ok((carriedVerifier.knowledge.find((fact) => fact.id === 'technique:expose:21:16:25')?.confidence ?? 0) >= 55);

  const repurposedOutputState = createInitialState(3502, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const repurposedVerifier = repurposedOutputState.people[0];
  const tabletTechniqueId = 'technique:exert:24:13:0:27';
  repurposedVerifier.knowledge.push({
    id: tabletTechniqueId, kind: 'technique', summary: '用石制工具加工木材可得到记录板',
    confidence: 46, learnedAtMonth: 0, sourceEventIds: ['test-tablet-output'],
  });
  repurposedVerifier.inventory.push({
    id: 'test-repurposed-tablet-output', materialId: 27, quantity: 1,
    sourceEventIds: ['test-tablet-output'], recordPayloadId: 'test-later-unrelated-record',
  });
  repurposedOutputState.records.push({
    id: 'test-later-unrelated-record', authorId: repurposedOutputState.people[1].id,
    knowledgeId: 'technique:combine-inventory:1x1+13x1:24', codebookId: 'codebook:test-later-unrelated-record',
    kind: 'technique', summary: '石与木材可结合为石制工具', version: 1,
    createdAtMonth: 0, sourceEventIds: ['test-later-record-writing'],
  });
  appendFixtureEvents(repurposedOutputState, [{
    ...actionFact('test-tablet-output', 0, repurposedVerifier.id, {
      kind: 'act', operation: 'exert', targets: [],
    }),
    diff: { outputMaterialId: 27, outputStackId: 'test-repurposed-tablet-output' },
  }]);
  const repurposedVerificationOption = buildDecisionContexts(repurposedOutputState, 1)
    .find((context) => context.person.id === repurposedVerifier.id)?.options
    .find((option) => option.id.startsWith(`verify-technique:${tabletTechniqueId}:`));
  assert.equal(repurposedVerificationOption?.nextAction.kind, 'attend');
  const repurposedVerificationIntent = {
    id: 'intent-test-repurposed-output-verification', ownerId: repurposedVerifier.id,
    summary: repurposedVerificationOption.summary, domain: 'strategic',
    goal: repurposedVerificationOption.goal, nextAction: repurposedVerificationOption.nextAction,
    target: repurposedVerificationOption.target, status: 'active', createdAtMonth: 0,
    lastProgressAtMonth: 0, progress: 0, sourceDecisionEventId: 'test-repurposed-verification-decision',
    sourceFactIds: repurposedVerificationOption.sourceFactIds, actionEventIds: [], replanCount: 0,
  };
  repurposedOutputState.intents.push(repurposedVerificationIntent);
  repurposedVerifier.activeIntentId = repurposedVerificationIntent.id;
  const repurposedVerificationFact = executeActiveIntent(
    repurposedOutputState,
    repurposedVerifier,
    1,
    0,
    1,
    [],
  );
  assert.equal(repurposedVerificationFact?.diff.verifiedTechnique, true,
    'a source-bound physical verification must inspect the produced material even when that same carrier now holds a later record');
  assert.equal(repurposedVerificationFact?.diff.recordPayloadId, undefined,
    'the later record content must not replace the explicitly requested source-bound material verification');
  assert.equal(repurposedVerificationIntent.status, 'completed');

  const blindTrialState = createInitialState(36, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  blindTrialState.people[0].inventory.push({ id: 'test-seed-stack', materialId: 22, quantity: 1, sourceEventIds: [] });
  const blindOptions = buildDecisionContexts(blindTrialState).find((context) => context.person.id === blindTrialState.people[0].id)?.options.filter((option) => option.id.startsWith('try-combine:')) ?? [];
  assert.ok(blindOptions.length > 0, '未知配方应从眼前物质生成可失败的结合尝试');
  assert.ok(blindOptions.every((option) => !option.summary.includes('作物幼苗') && !option.reason.includes('适宜')), '盲试候选不得泄露隐藏产物或适用规则');

  const craftWith = async (seed, stacks, targets) => {
    // Isolate primitive material consequences from other founders' first-month
    // projects and social edges. This fixture is not testing deliberation.
    const craftState = createInitialState(26083044, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
    const crafter = craftState.people[0];
    craftState.people = [crafter];
    crafter.inventory = stacks;
    const intentId = `intent-test-craft-${seed}`;
    craftState.intents.push({
      id: intentId, ownerId: crafter.id, summary: '尝试结合随身物质', domain: 'strategic',
      goal: { kind: 'knowledge', factId: `attempt:${seed}` },
      nextAction: { kind: 'act', operation: 'combine', targets: targets(crafter) }, status: 'active',
      createdAtMonth: 0, lastProgressAtMonth: 0, progress: 0, sourceDecisionEventId: `decision-test-craft-${seed}`,
      sourceFactIds: [], actionEventIds: [], replanCount: 0,
    });
    crafter.activeIntentId = intentId;
    craftState.decisionBudget.credits = 0;
    return stepSimulationAsync(craftState, {
      async decideAll(contexts) { return contexts.map(() => ({ kind: 'idle', reason: '开局批量不改写固定制作意图' })); },
      takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
    });
  };
  const ropeState = await craftWith(37, [{ id: 'fiber-craft', materialId: 20, quantity: 2, sourceEventIds: [] }], (crafter) => [
    { kind: 'inventory-stack', personId: crafter.id, stackId: 'fiber-craft' },
    { kind: 'inventory-stack', personId: crafter.id, stackId: 'fiber-craft' },
  ]);
  const ropeCraftFact = ropeState.world.past.find((event) => event.kind === 'action'
    && event.action.kind === 'act'
    && event.action.operation === 'combine'
    && event.diff.outputMaterialId === 23);
  assert.equal(ropeCraftFact?.diff.outputQuantity, 1, '两份私有纤维应由 combine 形成一份私有绳；绳之后可以继续被真实制作链消耗');
  assert.equal(ropeState.intents.find((intent) => intent.id === 'intent-test-craft-37')?.goalOutcome?.kind, 'not-evaluated',
    'attempt:* 只标识一次有界实验，不得把未创建的合成 knowledge 目标记成真实失败');
  assert.equal(ropeState.people[0].inventory.some((stack) => stack.materialId === 20), false, '制作必须消耗真实输入物质');
  const toolState = await craftWith(38, [
    { id: 'stone-craft', materialId: 1, quantity: 1, sourceEventIds: [] },
    { id: 'wood-craft', materialId: 13, quantity: 1, sourceEventIds: [] },
  ], (crafter) => [
    { kind: 'inventory-stack', personId: crafter.id, stackId: 'stone-craft' },
    { kind: 'inventory-stack', personId: crafter.id, stackId: 'wood-craft' },
  ]);
  assert.equal(toolState.people[0].inventory.find((stack) => stack.materialId === 24)?.quantity, 1, '石与木应形成只属于制作者背包的石制工具');
  assert.ok(toolState.people[0].knowledge.some((fact) => fact.kind === 'technique' && fact.confidence < 55), '一次制作只能形成待核验的个人经验');
  assert.ok(toolState.derived.milestones.some((milestone) => milestone.capabilityId === 16), '真实制作出石制工具后才能观察为制造工具');
  const clothingState = await craftWith(380, [
    { id: 'rope-clothing', materialId: 23, quantity: 1, sourceEventIds: [] },
    { id: 'fiber-clothing', materialId: 20, quantity: 1, sourceEventIds: [] },
  ], (crafter) => [
    { kind: 'inventory-stack', personId: crafter.id, stackId: 'rope-clothing' },
    { kind: 'inventory-stack', personId: crafter.id, stackId: 'fiber-clothing' },
  ]);
  assert.equal(clothingState.people[0].inventory.find((stack) => stack.materialId === 26)?.quantity, 1, '绳与纤维应结合为私人衣物');
  assert.ok(clothingState.derived.milestones.some((milestone) => milestone.capabilityId === 19), '真实制作出隔热衣物后才能观察为制作衣物');

  let fireState = createInitialState(382, { endpoint: { kind: 'months', value: 4 }, chaosIntensity: 0 });
  const initialFireMaker = fireState.people[2];
  fireState.people = [initialFireMaker];
  const fireMakerId = initialFireMaker.id;
  const fireTestPosition = structuredClone(initialFireMaker.position);
  initialFireMaker.bornAtMonth = -20 * 12;
  initialFireMaker.inventory = [
    { id: 'fire-tool', materialId: 24, quantity: 2, sourceEventIds: [] },
    { id: 'fire-fiber', materialId: 20, quantity: 2, sourceEventIds: [] },
  ];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const fireMaker = fireState.people.find((person) => person.id === fireMakerId);
    Object.assign(fireMaker.position, structuredClone(fireTestPosition));
    fireState.agreements = [];
    const fireContext = buildDecisionContexts(fireState, fireState.clock.elapsedMonths + 1)
      .find((context) => context.person.id === fireMakerId);
    const fireOption = fireContext?.options.find((option) => option.id.startsWith(attempt ? 'repeat-exert:' : 'try-exert:'));
    assert.ok(fireMaker && fireOption, '工具、纤维与邻格空气应产生 exert 物质试验机会');
    if (!attempt) assert.ok(!fireOption.summary.includes('火') && !fireOption.reason.includes('火'), '未知施力试验不得向模型泄露火产物');
    const intentId = `intent-test-fire-${attempt}`;
    fireState.intents.push({
      id: intentId, ownerId: fireMakerId, summary: fireOption.summary, domain: 'strategic', goal: fireOption.goal,
      nextAction: fireOption.nextAction, target: fireOption.target, status: 'active', createdAtMonth: fireState.clock.elapsedMonths,
      lastProgressAtMonth: fireState.clock.elapsedMonths, progress: 0, sourceDecisionEventId: `decision-test-fire-${attempt}`,
      sourceFactIds: fireOption.sourceFactIds, actionEventIds: [], replanCount: 0,
    });
    fireMaker.activeIntentId = intentId;
    fireState.decisionBudget.credits = 0;
    fireState = await stepSimulationAsync(fireState, {
      async decideAll(contexts) { return contexts.map(() => ({ kind: 'idle', reason: '开局批量不改写固定生火试验' })); },
      takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
    });
  }
  const ignitionFacts = fireState.world.past.filter((event) => event.kind === 'action'
    && event.action.kind === 'act'
    && event.action.operation === 'exert'
    && event.diff.outputMaterialId === 16);
  const fireTechnique = fireState.people.find((person) => person.id === fireMakerId)?.knowledge.find((fact) => fact.id.startsWith('technique:exert:'));
  assert.equal(ignitionFacts.length, 2, '两次生火必须分别形成真实 exert 动作事实');
  assert.equal(fireState.people.find((person) => person.id === fireMakerId)?.inventory.some((stack) => stack.materialId === 20), false, '每次生火都必须消耗一份私人纤维');
  assert.ok((fireTechnique?.confidence ?? 0) >= 55, '重复生火应把一次暂定经验提升为可靠技术');
  assert.ok(fireState.derived.milestones.some((milestone) => milestone.capabilityId === 17), '真实产生火体素后才能观察为掌控火种');
  assert.ok(fireState.derived.milestones.some((milestone) => milestone.capabilityId === 222), '重复生火应构成跨次试错学习的证据链');

  const firePosition = ignitionFacts.at(-1)?.diff.position;
  assert.ok(firePosition, '生火事实必须保存火体素位置');
  const cook = fireState.people.find((person) => person.id === fireMakerId);
  Object.assign(cook.position, structuredClone(fireTestPosition));
  cook.inventory.push({ id: 'raw-food-for-cooking', materialId: 21, quantity: 1, sourceEventIds: [] });
  const cookContext = buildDecisionContexts(fireState, fireState.clock.elapsedMonths + 1)
    .find((context) => context.person.id === fireMakerId);
  const cookOption = cookContext?.options.find((option) => option.id.startsWith('try-expose:')
    && option.nextAction.kind === 'act'
    && option.nextAction.targets.some((target) => target.kind === 'inventory-stack' && target.stackId === 'raw-food-for-cooking'));
  assert.ok(cookOption, '私有食物邻近火体素时应产生 expose 物质试验机会');
  const cookIntentId = 'intent-test-cooking';
  fireState.intents.push({
    id: cookIntentId, ownerId: fireMakerId, summary: cookOption.summary, domain: 'strategic', goal: cookOption.goal,
    nextAction: cookOption.nextAction, target: cookOption.target, status: 'active', createdAtMonth: fireState.clock.elapsedMonths,
    lastProgressAtMonth: fireState.clock.elapsedMonths, progress: 0, sourceDecisionEventId: 'decision-test-cooking',
    sourceFactIds: cookOption.sourceFactIds, actionEventIds: [], replanCount: 0,
  });
  cook.activeIntentId = cookIntentId;
  fireState.decisionBudget.credits = 0;
  fireState = await stepSimulationAsync(fireState, {
    async decideAll(contexts) { return contexts.map(() => ({ kind: 'idle', reason: '开局批量不改写固定烹饪试验' })); },
    takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
  });
  const cookingFact = fireState.world.past.find((event) => event.kind === 'action'
    && event.who === fireMakerId
    && event.action.kind === 'act'
    && event.action.operation === 'expose'
    && event.diff.outputMaterialId === 25);
  assert.ok(cookingFact?.diff.outputStackId, '食物暴露于火后应先转化为有来源的私人熟食，之后即使被吃掉也不应丢失制作事实');
  assert.ok(fireState.derived.milestones.some((milestone) => milestone.capabilityId === 18), '真实 expose 转换出熟食后才能观察为烹饪食物');

  const teachingState = createInitialState(383, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const teacher = teachingState.people[0];
  const learner = teachingState.people[1];
  placeWith(learner, teacher);
  const taughtTechniqueId = 'technique:combine:22:3:11';
  const canonicalTechniqueSummary = '种子与湿土可结合为作物幼苗';
  teacher.knowledge.push({ id: taughtTechniqueId, kind: 'technique', summary: canonicalTechniqueSummary, confidence: 80, learnedAtMonth: 0, sourceEventIds: ['teacher-trial'] });
  const teachingIntentId = 'intent-test-canonical-teaching';
  teachingState.intents.push({
    id: teachingIntentId, ownerId: teacher.id, summary: '向同伴说明技术', domain: 'social',
    goal: { kind: 'representation-made', representationId: 'test-teaching-claim' },
    nextAction: { kind: 'talk', delivery: 'call', speakerMeaning: { id: 'test-teaching-claim', kind: 'claim', factId: taughtTechniqueId, summary: '我这就过去演示一遍，你看着。' } },
    status: 'active', createdAtMonth: 0, lastProgressAtMonth: 0, progress: 0, sourceDecisionEventId: 'decision-test-teaching',
    sourceFactIds: ['teacher-trial'], actionEventIds: [], replanCount: 0,
  });
  teacher.activeIntentId = teachingIntentId;
  const speechFact = executeActiveIntent(teachingState, teacher, 1, 1, 1, []);
  assert.equal(speechFact?.status, 'completed', '固定技术交流应通过真实 intent 执行');
  const learnedBySpeech = learner.knowledge.find((fact) => fact.id === taughtTechniqueId);
  assert.equal(learnedBySpeech?.summary, canonicalTechniqueSummary, '自然语言说法不能覆盖结构化技术事实的规范摘要');
  assert.ok((learnedBySpeech?.confidence ?? 100) < 55, '只听别人讲述不能直接获得可传授的可靠技术');
  assert.deepEqual(learnedBySpeech?.sourceEventIds.length, 1, '听者知识应来源于沟通事件，而不是伪装成亲历教师的实验');

  let directTeachingState = createInitialState(3831, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const directTeacher = directTeachingState.people[0];
  const directLearner = directTeachingState.people[1];
  directTeacher.bornAtMonth = -20 * 12;
  directLearner.bornAtMonth = -12 * 12;
  placeWith(directLearner, directTeacher);
  directTeacher.knowledge.push({ id: taughtTechniqueId, kind: 'technique', summary: canonicalTechniqueSummary, confidence: 80, learnedAtMonth: 0, sourceEventIds: ['direct-teacher-trial'] });
  const directContext = buildDecisionContexts(directTeachingState, directTeachingState.clock.elapsedMonths + 1)
    .find((context) => context.person.id === directTeacher.id);
  const directTeachOption = directContext?.options.find((option) => option.id.startsWith('teach:')
    && option.target?.kind === 'person'
    && option.target.personId === directLearner.id
    && option.nextAction.kind === 'talk'
    && option.nextAction.speakerMeaning.factId === taughtTechniqueId);
  assert.ok(directTeachOption, '可靠技术持有者应能对同地且达到学习年龄的人直接生成教导选项');
  assert.equal(buildDecisionContexts(directTeachingState).flatMap((context) => context.options).some((option) => option.id.startsWith('request-technique:')
    || option.id.startsWith('demonstrate-technique:')
    || option.id.includes('imitate-technique-')
    || (option.nextAction.kind === 'act' && Boolean(option.nextAction.techniqueDemonstration || option.nextAction.techniqueImitation))), false, '新规划不应再产生示范请求、示范或模仿动作');
  const directTeachingIntentId = 'intent-test-direct-teaching';
  directTeachingState.intents.push({
    id: directTeachingIntentId, ownerId: directTeacher.id, summary: directTeachOption.summary, domain: 'social',
    goal: directTeachOption.goal, nextAction: directTeachOption.nextAction, target: directTeachOption.target,
    status: 'active', createdAtMonth: 0, lastProgressAtMonth: 0, progress: 0,
    sourceDecisionEventId: 'decision-test-direct-teaching', sourceFactIds: directTeachOption.sourceFactIds,
    actionEventIds: [], replanCount: 0,
  });
  directTeacher.activeIntentId = directTeachingIntentId;
  const directTeachingEvent = executeActiveIntent(directTeachingState, directTeacher, 1, 1, 1, []);
  const reliablyTaught = directLearner.knowledge.find((fact) => fact.id === taughtTechniqueId);
  assert.equal(reliablyTaught?.confidence, 60, '一次明确教导应让学习者可靠掌握同一技术');
  assert.ok(directTeachingEvent && reliablyTaught?.sourceEventIds.includes(directTeachingEvent.id), '教导所得知识必须引用真实教导事件');

  const underageTeachingState = createInitialState(3832, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const underageTeacher = underageTeachingState.people[0];
  const underageLearner = underageTeachingState.people[1];
  underageTeacher.bornAtMonth = -20 * 12;
  underageLearner.bornAtMonth = -1 * 12;
  placeWith(underageLearner, underageTeacher);
  underageTeacher.knowledge.push({ id: taughtTechniqueId, kind: 'technique', summary: canonicalTechniqueSummary, confidence: 80, learnedAtMonth: 0, sourceEventIds: ['underage-teacher-trial'] });
  const underageContext = buildDecisionContexts(underageTeachingState).find((context) => context.person.id === underageTeacher.id);
  assert.equal(underageContext?.options.some((option) => option.id.startsWith('teach:')
    && option.target?.kind === 'person'
    && option.target.personId === underageLearner.id), false, '未满六岁的人不能成为可靠技术教导目标');

  let recordState = createInitialState(384, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const authorId = recordState.people[0].id;
  const readerId = recordState.people[1].id;
  for (const person of recordState.people.slice(0, 3)) person.bornAtMonth = -20 * 12;
  placeWith(recordState.people[1], recordState.people[0]);
  placeWith(recordState.people[2], recordState.people[0]);
  recordState.people[0].inventory = [
    { id: 'record-tool', materialId: 24, quantity: 1, sourceEventIds: [] },
    { id: 'record-wood', materialId: 13, quantity: 1, sourceEventIds: [] },
  ];
  recordState.people[0].knowledge.push({ id: 'fact:record-test', kind: 'observation', summary: '北边水岸有可饮用的水', confidence: 78, learnedAtMonth: 0, sourceEventIds: ['test-independent-observation'] });
  const runRecordOption = (state, ownerId, option, label) => {
    const owner = state.people.find((person) => person.id === ownerId);
    assert.ok(owner && option, label);
    const intentId = `intent-${label}-${state.clock.elapsedMonths}`;
    state.intents.push({
      id: intentId, ownerId, summary: option.summary, domain: option.domain ?? 'strategic', goal: option.goal,
      nextAction: option.nextAction, ...(option.completionAction ? { completionAction: option.completionAction } : {}),
      ...(option.target ? { target: option.target } : {}), status: 'active', createdAtMonth: state.clock.elapsedMonths,
      lastProgressAtMonth: state.clock.elapsedMonths, progress: 0, sourceDecisionEventId: `decision-${intentId}`,
      sourceFactIds: option.sourceFactIds, actionEventIds: [], replanCount: 0,
    });
    owner.activeIntentId = intentId;
    state.decisionBudget.credits = 0;
    return stepSimulation(state, { decide() { return { kind: 'idle', reason: '不干扰记录链测试' }; } });
  };

  let miningState = createInitialState(386, { endpoint: { kind: 'months', value: 6 }, chaosIntensity: 0 });
  const minerId = miningState.people[0].id;
  for (const bystander of miningState.people.slice(1)) bystander.diedAtMonth = 0;
  const miner = miningState.people[0];
  miner.bornAtMonth = -20 * 12;
  miner.inventory = [];
  miner.knowledge = [];
  const mineCell = [miner.position.cellId - miningState.world.grid.width, miner.position.cellId - 1, miner.position.cellId + 1, miner.position.cellId + miningState.world.grid.width]
    .find((cell) => cell >= 0 && cell < miningState.world.grid.width * miningState.world.grid.depth
      && Math.abs(cell % miningState.world.grid.width - miner.position.cellId % miningState.world.grid.width)
        + Math.abs(Math.floor(cell / miningState.world.grid.width) - Math.floor(miner.position.cellId / miningState.world.grid.width)) === 1);
  const mineZ = miner.position.z - 1;
  for (let z = mineZ + 1; z < miningState.world.grid.levels; z += 1) miningState.world.grid.voxels[z * miningState.world.grid.width * miningState.world.grid.depth + mineCell] = 0;
  miningState.world.grid.voxels[mineZ * miningState.world.grid.width * miningState.world.grid.depth + mineCell] = 1;
  assert.equal(buildDecisionContexts(miningState).find((context) => context.person.id === minerId)?.options.some((option) => option.id.startsWith('separate-material:split-stone')), false, '没有真实工具时不能获得采石候选');
  miner.inventory.push({ id: 'test-mining-tool', materialId: 24, quantity: 1, sourceEventIds: ['test-tool-source'] });
  const miningOption = buildDecisionContexts(miningState).find((context) => context.person.id === minerId)?.options.find((option) => option.id.startsWith('separate-material:split-stone'));
  assert.ok(miningOption?.target?.kind === 'voxel' && miningOption.nextAction.kind === 'act' && miningOption.nextAction.operation === 'separate', '石制工具与近身石体素应通过既有 separate 原语产生一个最近候选');
  const minedPosition = miningOption.target.position;
  miningState = runRecordOption(miningState, minerId, miningOption, 'mine-real-stone-voxel');
  const minedStone = miningState.people.find((person) => person.id === minerId);
  const minedVoxelIndex = minedPosition.z * miningState.world.grid.width * miningState.world.grid.depth + minedPosition.y * miningState.world.grid.width + minedPosition.x;
  assert.equal(miningState.world.grid.voxels[minedVoxelIndex], 0, '采石必须改变目标体素本身，不能凭空增加背包物品');
  assert.ok(minedStone.inventory.some((stack) => stack.materialId === 1 && stack.quantity >= 1), '分离出的石必须先成为地面掉落，再由 transfer 进入私人背包');
  assert.ok(minedStone.knowledge.some((fact) => fact.id.startsWith('technique:separate:24:1:1') && fact.confidence === 46), '第一次真实采石应留下尚待重复核验的物质技术');
  const secondMineCell = [minedStone.position.cellId - miningState.world.grid.width, minedStone.position.cellId - 1, minedStone.position.cellId + 1, minedStone.position.cellId + miningState.world.grid.width]
    .find((cell) => cell !== mineCell
      && cell >= 0 && cell < miningState.world.grid.width * miningState.world.grid.depth
      && Math.abs(cell % miningState.world.grid.width - minedStone.position.cellId % miningState.world.grid.width)
        + Math.abs(Math.floor(cell / miningState.world.grid.width) - Math.floor(minedStone.position.cellId / miningState.world.grid.width)) === 1);
  const secondMineZ = minedStone.position.z - 1;
  for (let z = secondMineZ + 1; z < miningState.world.grid.levels; z += 1) miningState.world.grid.voxels[z * miningState.world.grid.width * miningState.world.grid.depth + secondMineCell] = 0;
  miningState.world.grid.voxels[secondMineZ * miningState.world.grid.width * miningState.world.grid.depth + secondMineCell] = 1;
  const repeatMiningOption = buildDecisionContexts(miningState).find((context) => context.person.id === minerId)?.options.find((option) => option.id.startsWith('separate-material:split-stone'));
  miningState = runRecordOption(miningState, minerId, repeatMiningOption, 'repeat-real-stone-mining');
  const verifiedMiningTechnique = miningState.people.find((person) => person.id === minerId)?.knowledge.find((fact) => fact.id.startsWith('technique:separate:24:1:1'));
  assert.ok((verifiedMiningTechnique?.confidence ?? 0) >= 55, '同一分离规律被再次真实复现后才成为可靠技术');
  assert.ok(miningState.derived.milestones.some((milestone) => milestone.capabilityId === 222 && verifiedMiningTechnique.sourceEventIds.every((id) => milestone.evidenceEventIds.includes(id))), '试错学习观察器必须承认具有重复物质证据的 separate 技术');

  let containerState = createInitialState(387, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const containerMakerId = containerState.people[0].id;
  for (const bystander of containerState.people.slice(1)) bystander.diedAtMonth = 0;
  const containerMaker = containerState.people[0];
  containerMaker.bornAtMonth = -20 * 12;
  containerMaker.body = { health: 100, hydration: 100, nutrition: 100 };
  containerMaker.inventory = [
    { id: 'test-container-wood', materialId: 13, quantity: 2, sourceEventIds: ['test-container-wood-source'] },
    { id: 'test-container-food', materialId: 21, quantity: 3, sourceEventIds: ['test-container-food-source'] },
  ];
  const shapePlanksOption = buildDecisionContexts(containerState).find((context) => context.person.id === containerMakerId)?.options.find((option) => option.nextAction.kind === 'act'
    && option.nextAction.operation === 'combine'
    && option.nextAction.targets.filter((target) => target.kind === 'inventory-stack' && target.stackId === 'test-container-wood').length === 2);
  containerState = runRecordOption(containerState, containerMakerId, shapePlanksOption, 'shape-planks-from-wood');
  const shapedPlanks = containerState.people.find((person) => person.id === containerMakerId)?.inventory.find((stack) => stack.materialId === 19);
  assert.equal(shapedPlanks?.quantity, 2, '采集到的木材应能经同一 combine 原语形成可继续建造和制作的木板');
  const craftContainerOption = buildDecisionContexts(containerState).find((context) => context.person.id === containerMakerId)?.options.find((option) => option.nextAction.kind === 'act'
    && option.nextAction.operation === 'combine'
    && option.nextAction.targets.filter((target) => target.kind === 'inventory-stack' && target.stackId === shapedPlanks?.id).length === 2);
  containerState = runRecordOption(containerState, containerMakerId, craftContainerOption, 'craft-material-container');
  const carriedContainer = containerState.people.find((person) => person.id === containerMakerId)?.inventory.find((stack) => stack.materialId === 28);
  assert.ok(carriedContainer && !containerState.containers.length, '两块木板应先结合为私人背包中的容器物品，不能直接生成远程仓库');
  const placeContainerOption = buildDecisionContexts(containerState).find((context) => context.person.id === containerMakerId)?.options.find((option) => option.goal.kind === 'voxel-is'
    && option.goal.materialId === 28
    && option.nextAction.kind === 'act'
    && option.nextAction.operation === 'combine'
    && option.nextAction.targets.some((target) => target.kind === 'inventory-stack' && target.stackId === carriedContainer.id));
  assert.ok(placeContainerOption?.goal.kind === 'voxel-is', '容器物品只能通过既有 combine 放进有支撑且未被身体占据的空气体素');
  const containerPosition = placeContainerOption.goal.position;
  containerState = runRecordOption(containerState, containerMakerId, placeContainerOption, 'place-material-container');
  const placedContainer = containerState.containers[0];
  assert.ok(placedContainer && placedContainer.position.x === containerPosition.x && placedContainer.position.y === containerPosition.y && placedContainer.position.z === containerPosition.z, '放置事件必须建立与同一容器体素绑定的内部物品堆');
  const storeOption = buildDecisionContexts(containerState).find((context) => context.person.id === containerMakerId)?.options.find((option) => option.id.startsWith(`store-container:${placedContainer.id}:`) && option.goal.kind === 'container-inventory-at-least' && option.goal.materialId === 21);
  containerState = runRecordOption(containerState, containerMakerId, storeOption, 'store-food-in-container');
  assert.equal(containerState.containers[0].inventory.find((stack) => stack.materialId === 21)?.quantity, 2, '存储必须由 person → container 的真实 transfer 改变持有者');
  assert.equal(containerState.people.find((person) => person.id === containerMakerId)?.inventory.find((stack) => stack.materialId === 21)?.quantity, 1, '存入容器时必须从私人背包扣除相同数量');
  assert.equal(buildDecisionContexts(containerState).find((context) => context.person.id === containerMakerId)?.options.some((option) => (
    option.id.startsWith(`retrieve-container:${placedContainer.id}:`)
      && option.goal.kind === 'inventory-at-least'
      && option.goal.materialId === 21
  )), false, '普通决策不得为了 inventory+1 自造食物取出需求；急性饥饿只能走生存反射');
  containerState.people.find((person) => person.id === containerMakerId)?.inventory.push({
    id: 'test-container-stone', materialId: 24, quantity: 2, sourceEventIds: ['test-container-stone-source'],
  });
  const storeStoneOption = buildDecisionContexts(containerState).find((context) => context.person.id === containerMakerId)?.options.find((option) => (
    option.id.startsWith(`store-container:${placedContainer.id}:`)
      && option.goal.kind === 'container-inventory-at-least'
      && option.goal.materialId === 24
  ));
  containerState = runRecordOption(containerState, containerMakerId, storeStoneOption, 'store-stone-in-container');
  const retrieveOption = buildDecisionContexts(containerState).find((context) => context.person.id === containerMakerId)?.options.find((option) => (
    option.id.startsWith(`retrieve-container:${placedContainer.id}:`)
      && option.goal.kind === 'inventory-at-least'
      && option.goal.materialId === 24
  ));
  containerState = runRecordOption(containerState, containerMakerId, retrieveOption, 'retrieve-stone-from-container');
  assert.equal(containerState.containers[0].inventory.find((stack) => stack.materialId === 24), undefined,
    '普通非食物取出仍必须减少同一内部物品堆');
  assert.equal(containerState.people.find((person) => person.id === containerMakerId)?.inventory.find((stack) => stack.materialId === 24)?.quantity, 2,
    '取出的非食物物质必须重新进入操作者的私人背包');
  const dismantleContainerOption = buildDecisionContexts(containerState).find((context) => context.person.id === containerMakerId)?.options.find((option) => option.id.startsWith('separate-material:recover-container'));
  containerState = runRecordOption(containerState, containerMakerId, dismantleContainerOption, 'dismantle-material-container');
  const containerVoxelIndex = containerPosition.z * containerState.world.grid.width * containerState.world.grid.depth + containerPosition.y * containerState.world.grid.width + containerPosition.x;
  assert.equal(containerState.world.grid.voxels[containerVoxelIndex], 0, '拆解容器必须移除对应体素');
  assert.equal(containerState.containers.length, 0, '容器体素消失后不得保留幽灵内部背包');
  assert.ok(containerState.world.drops.some((drop) => drop.materialId === 21 && drop.quantity >= 1), '拆解有内容物的容器必须让内部物质真实掉落，不能销毁或瞬移');
  assert.ok(containerState.people.find((person) => person.id === containerMakerId)?.inventory.some((stack) => stack.materialId === 28), '容器本体应作为分离产物经掉落和拾取回到私人背包');

  let failedExperimentState = createInitialState(391, { endpoint: { kind: 'months', value: 20 }, chaosIntensity: 0 });
  const experimenterId = failedExperimentState.people[0].id;
  failedExperimentState.people[0].bornAtMonth = -20 * 12;
  failedExperimentState.people[0].inventory = [
    { id: 'failed-trial-wood', materialId: 13, quantity: 2, sourceEventIds: [] },
    { id: 'failed-trial-food', materialId: 21, quantity: 2, sourceEventIds: [] },
  ];
  const failedCombinationOption = () => buildDecisionContexts(failedExperimentState)
    .find((context) => context.person.id === experimenterId)?.options
    .find((option) => option.nextAction.kind === 'act'
      && option.nextAction.operation === 'combine'
      && option.nextAction.targets.some((target) => target.kind === 'inventory-stack' && target.stackId === 'failed-trial-wood')
      && option.nextAction.targets.some((target) => target.kind === 'inventory-stack' && target.stackId === 'failed-trial-food'));
  failedExperimentState = runRecordOption(failedExperimentState, experimenterId, failedCombinationOption(), 'first-failed-material-experiment');
  const negativeFactId = 'observation:no-response:combine-inventory:13+21';
  assert.equal(failedExperimentState.people[0].knowledge.find((fact) => fact.id === negativeFactId)?.confidence, 46, '一次真实失败只应形成暂定的负面观察');
  failedExperimentState.clock.elapsedMonths += 7;
  assert.ok(failedCombinationOption(), '单次失败不足以把一种材料组合认定为无响应');
  failedExperimentState = runRecordOption(failedExperimentState, experimenterId, failedCombinationOption(), 'repeat-failed-material-experiment');
  const negativeFact = failedExperimentState.people[0].knowledge.find((fact) => fact.id === negativeFactId);
  assert.equal(negativeFact?.confidence, 64, '同一人物重复得到相同无响应结果后应提高负面观察置信度');
  assert.equal(negativeFact?.sourceEventIds.length, 2, '负面知识必须保留每次实际尝试的事件来源');
  assert.equal(failedCombinationOption(), undefined, '可靠的负面经验应阻止人物无限重复完全相同的无效组合');
  assert.ok(buildDecisionContexts(failedExperimentState).find((context) => context.person.id === experimenterId)?.options
    .some((option) => option.nextAction.kind === 'act'
      && option.nextAction.operation === 'combine'
      && option.nextAction.targets.filter((target) => target.kind === 'inventory-stack' && target.stackId === 'failed-trial-food').length === 2), '排除一个已证伪组合不能关闭仍可能成功的其他材料实验');

  let recordContext = buildDecisionContexts(recordState).find((context) => context.person.id === authorId);
  const carveOption = recordContext?.options.find((option) => option.id.startsWith('try-exert:') && option.nextAction.kind === 'act'
    && option.nextAction.targets.some((target) => target.kind === 'inventory-stack' && target.stackId === 'record-wood'));
  recordState = runRecordOption(recordState, authorId, carveOption, 'carve-record-tablet');
  assert.equal(recordState.people.find((person) => person.id === authorId)?.inventory.find((stack) => stack.materialId === 27)?.quantity, 1, '石制工具对木材施力应产生私有实体记录板');

  recordContext = buildDecisionContexts(recordState).find((context) => context.person.id === authorId);
  const writeOption = recordContext?.options.find((option) => option.id.startsWith('write-record:'));
  recordState = runRecordOption(recordState, authorId, writeOption, 'write-record');
  const payload = recordState.records[0];
  assert.ok(payload && recordState.people.find((person) => person.id === authorId)?.inventory.some((stack) => stack.recordPayloadId === payload.id), '刻写应把语义载荷绑定到一块可转移的实体木板');
  const ignorant = recordState.people[2];
  ignorant.inventory.push({ id: 'test-unknown-record-carrier', materialId: 27, quantity: 1, sourceEventIds: [payload.id], recordPayloadId: payload.id });
  assert.equal(buildDecisionContexts(recordState).find((context) => context.person.id === ignorant.id)?.options.some((option) => option.id.startsWith('read-record:')), false, '没有共同编码的人不能天然读懂记录');
  ignorant.inventory = ignorant.inventory.filter((stack) => stack.id !== 'test-unknown-record-carrier');

  recordContext = buildDecisionContexts(recordState).find((context) => context.person.id === authorId);
  const teachCodebookOption = recordContext?.options.find((option) => option.id.startsWith('teach:') && option.nextAction.kind === 'talk' && option.nextAction.speakerMeaning.factId === payload.codebookId);
  recordState = runRecordOption(recordState, authorId, teachCodebookOption, 'teach-record-codebook');
  assert.ok(recordState.people.find((person) => person.id === readerId)?.knowledge.some((fact) => fact.id === payload.codebookId && fact.kind === 'codebook' && fact.confidence >= 55), '作者必须先通过沟通与读者建立共同编码');

  recordContext = buildDecisionContexts(recordState).find((context) => context.person.id === authorId);
  assert.equal(recordContext?.options.some((option) => option.id.startsWith(`share-demand-record:${payload.id}:${readerId}:`)), false,
    '只有共同编码而没有读者项目的真实技术缺口时，记录不应被无目的传递；需求绑定的交付与复现由专项回归覆盖');
  assert.ok(recordState.people.find((person) => person.id === authorId)?.inventory.some((stack) => stack.recordPayloadId === payload.id),
    '没有合法交付目标时，实体记录应继续留在作者背包中');

  let collectiveState = createInitialState(385, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  collectiveState.clock.elapsedMonths = 1;
  const founder = collectiveState.people[0];
  const partner = collectiveState.people[1];
  founder.bornAtMonth = -20 * 12;
  partner.bornAtMonth = -20 * 12;
  placeWith(partner, founder);
  founder.personality.baseline.emotionality = 90;
  founder.personality.baseline.extraversion = 90;
  const earlierAssistId = 'test-earlier-fulfilled-assist';
  const earlierRequest = actionFact('test-earlier-assist-request', 0, founder.id, { kind: 'talk', speakerMeaning: { id: earlierAssistId, kind: 'request', summary: '请给我一份食物', proposal: { kind: 'assist', requesterId: founder.id, helperId: partner.id, need: 'food', expiresAtMonth: 1 } }, interpreters: [partner.id] });
  recordAgreementAction(collectiveState, earlierRequest);
  appendFixtureEvents(collectiveState, [earlierRequest]);
  const earlierAcceptance = actionFact('test-earlier-assist-acceptance', 0, partner.id, { kind: 'talk', speakerMeaning: { id: 'test-earlier-assist-acceptance-content', kind: 'accept', referenceId: earlierAssistId }, interpreters: [founder.id] });
  recordAgreementAction(collectiveState, earlierAcceptance);
  appendFixtureEvents(collectiveState, [earlierAcceptance]);
  const earlierFulfillment = actionFact('test-earlier-assist-fulfillment', 0, partner.id, { kind: 'transfer', materialId: 21, quantity: 1, from: { kind: 'person', personId: partner.id }, to: { kind: 'person', personId: founder.id }, authorizationRef: earlierAssistId });
  recordAgreementAction(collectiveState, earlierFulfillment);
  appendFixtureEvents(collectiveState, [earlierFulfillment]);
  const priorAssistId = 'test-prior-fulfilled-assist';
  const priorRequest = actionFact('test-prior-assist-request', 1, founder.id, { kind: 'talk', speakerMeaning: { id: priorAssistId, kind: 'request', summary: '请给我一份食物', proposal: { kind: 'assist', requesterId: founder.id, helperId: partner.id, need: 'food', expiresAtMonth: 2 } }, interpreters: [partner.id] });
  recordAgreementAction(collectiveState, priorRequest);
  appendFixtureEvents(collectiveState, [priorRequest]);
  const priorAcceptance = actionFact('test-prior-assist-acceptance', 1, partner.id, { kind: 'talk', speakerMeaning: { id: 'test-prior-assist-acceptance-content', kind: 'accept', referenceId: priorAssistId }, interpreters: [founder.id] });
  recordAgreementAction(collectiveState, priorAcceptance);
  appendFixtureEvents(collectiveState, [priorAcceptance]);
  const priorFulfillment = actionFact('test-prior-assist-fulfillment', 1, partner.id, { kind: 'transfer', materialId: 21, quantity: 1, from: { kind: 'person', personId: partner.id }, to: { kind: 'person', personId: founder.id }, authorizationRef: priorAssistId });
  recordAgreementAction(collectiveState, priorFulfillment);
  appendFixtureEvents(collectiveState, [priorFulfillment]);
  const collectiveContext = buildDecisionContexts(collectiveState).find((context) => context.person.id === founder.id);
  const collectiveOffer = collectiveContext?.options.find((option) => option.id.startsWith('offer-collective:'));
  assert.ok(collectiveOffer && !collectiveOffer.requiresFollowUp, '共同体提议是完整结构化行动，不能借无关后续动作取得额外目标');
  const collectiveIntentId = 'intent-test-found-collective';
  collectiveState.intents.push({
    id: collectiveIntentId, ownerId: founder.id, summary: collectiveOffer.summary, domain: 'social',
    goal: collectiveOffer.goal, nextAction: collectiveOffer.nextAction,
    ...(collectiveOffer.target ? { target: collectiveOffer.target } : {}),
    status: 'active', createdAtMonth: collectiveState.clock.elapsedMonths,
    lastProgressAtMonth: collectiveState.clock.elapsedMonths, progress: 0,
    sourceDecisionEventId: 'decision-test-found-collective', sourceFactIds: [...collectiveOffer.sourceFactIds], actionEventIds: [], replanCount: 0,
  });
  founder.activeIntentId = collectiveIntentId;
  collectiveState = stepSimulation(collectiveState, { decide() { return { kind: 'idle', reason: '不干扰共同体提议测试' }; } });
  const formationAgreement = collectiveState.agreements.find((agreement) => agreement.proposal.kind === 'collective');
  assert.equal(formationAgreement?.status, 'proposed', '共同体提议必须等待另一人明确接受，不能由发起者单方面成立');
  assert.ok(formationAgreement?.sourceEventIds.includes(priorFulfillment.id), '共同体提议必须保留使它成为选项的既往合作来源');
  const proposalActions = collectiveState.world.past.filter((event) => event.kind === 'action' && event.intentId === collectiveIntentId);
  assert.equal(proposalActions[0]?.action.kind, 'talk', '共同体形成链先发生真实沟通');
  assert.equal(proposalActions.some((event) => event.action.kind !== 'talk'), false, '共同体提议不能夹带语义无关的第二行动');

  const strategicFollowUp = collectiveContext?.followUpOptions.find((option) => option.domain === 'strategic');
  assert.ok(strategicFollowUp, '独立结构化提议测试需要一个会被忽略的无关战略选项');
  const collectiveChoice = composeIntentChoice(collectiveContext.options, collectiveContext.followUpOptions, collectiveOffer.id, strategicFollowUp.id);
  assert.equal(collectiveChoice?.domain, 'social', '即使调用方传入无关 follow-up，独立提议仍必须保持自己的社会语义');
  assert.equal(collectiveChoice?.nextAction.kind, 'talk');

  const collectiveResponseContext = buildDecisionContexts(collectiveState).find((context) => context.person.id === partner.id);
  assert.deepEqual(new Set(collectiveResponseContext?.options.map((option) => option.id.split(':')[0])), new Set(['accept-collective', 'reject-collective']), '收到共同体提议后必须由本人明确接受或拒绝');
  let rejectedCollectiveState = structuredClone(collectiveState);
  rejectedCollectiveState = runRecordOption(rejectedCollectiveState, partner.id, collectiveResponseContext?.options.find((option) => option.id.startsWith('reject-collective:')), 'reject-collective-once');
  placeWith(rejectedCollectiveState.people.find((person) => person.id === partner.id), rejectedCollectiveState.people.find((person) => person.id === founder.id));
  assert.equal(buildDecisionContexts(rejectedCollectiveState).find((context) => context.person.id === founder.id)?.options.some((option) => option.id.startsWith('offer-collective:')), false, '共同体提议被拒后，必须出现新的履约或共同项目证据才能再次提议');
  const acceptCollective = collectiveResponseContext?.options.find((option) => option.id.startsWith('accept-collective:'));
  collectiveState = runRecordOption(collectiveState, partner.id, acceptCollective, 'accept-collective');
  const collective = collectiveState.collectives[0];
  assert.ok(collective && collective.status === 'active' && collective.memberships.filter((membership) => membership.status === 'active').length === 2, '双方接受后应形成具有持续成员身份的共同体领域事实');
  assert.equal(collectiveState.derived.institutions.length, 0, '只有成员身份还不是制度；必须等待共同规则被接受并反复执行');
  assert.equal(collectiveState.derived.milestones.some((milestone) => milestone.capabilityId === 29), false,
    '成立一般共同体不能替代“友谊与联盟”的具体关系语义，该地图坐标应继续 guarded');

  const permissionGrantor = collectiveState.people.find((person) => person.id === founder.id);
  const permissionGrantee = collectiveState.people.find((person) => person.id === partner.id);
  collectiveState.projects = [];
  permissionGrantor.inventory = permissionGrantor.inventory.filter((stack) => stack.materialId !== 21);
  permissionGrantee.inventory = permissionGrantee.inventory.filter((stack) => stack.materialId !== 21);
  permissionGrantor.inventory.push({ id: 'test-permission-food', materialId: 21, quantity: 5, sourceEventIds: ['test-private-food-source'] });
  permissionGrantee.inventory.push({ id: 'test-grantee-food', materialId: 21, quantity: 3, sourceEventIds: ['test-grantee-food-source'] });
  let permissionContext = buildDecisionContexts(collectiveState).find((context) => context.person.id === founder.id);
  const offerPermission = permissionContext?.options.find((option) => option.id.startsWith('offer-permission:')
    && option.nextAction.kind === 'talk'
    && option.nextAction.speakerMeaning.proposal?.kind === 'permission'
    && option.nextAction.speakerMeaning.proposal.materialId === 21);
  collectiveState = runRecordOption(collectiveState, founder.id, offerPermission, 'offer-resource-permission');
  const permissionResponse = buildDecisionContexts(collectiveState).find((context) => context.person.id === partner.id);
  assert.deepEqual(new Set(permissionResponse?.options.map((option) => option.id.split(':')[0])), new Set(['accept-permission', 'reject-permission']), '具体物质取用许可必须由被授权人明确接受或拒绝');
  const acceptPermission = permissionResponse?.options.find((option) => option.id.startsWith('accept-permission:'));
  collectiveState = runRecordOption(collectiveState, partner.id, acceptPermission, 'accept-resource-permission');
  const permission = collectiveState.permissions[0];
  assert.ok(permission?.status === 'active' && permission.grantorId === founder.id && permission.granteeId === partner.id && permission.materialId === 21, '接受后应形成人、物质、数量和有效期均明确的许可事实');
  const usePermissionContext = buildDecisionContexts(collectiveState).find((context) => context.person.id === partner.id);
  const usePermission = usePermissionContext?.options.find((option) => option.id.startsWith(`use-permission:${permission.id}:`));
  assert.ok(usePermission, '许可只有在被授权人存在真实储备缺口且授权人仍有剩余时才可行使');
  assert.equal(usePermission.domain, 'strategic', '行使许可是资源决策，不得继续膨胀为社会履约意图');
  assert.equal(usePermission.semantics.obligation, 'optional', '取用权不是必须履行的承诺');
  assert.equal(usePermission.nextAction.permissionUseBasis?.kind, 'personal-reserve');
  const partnerFoodBefore = collectiveState.people.find((person) => person.id === partner.id).inventory.filter((stack) => stack.materialId === 21).reduce((sum, stack) => sum + stack.quantity, 0);
  collectiveState = runRecordOption(collectiveState, partner.id, usePermission, 'use-resource-permission');
  const permissionUseFact = [...collectiveState.world.past].reverse().find((event) => event.kind === 'action'
    && event.action.kind === 'transfer'
    && event.action.authorizationRef === permission.id);
  assert.equal(permissionUseFact?.status, 'completed', `许可取用应通过执行边界复核：${JSON.stringify({
    result: permissionUseFact?.result,
    atMonth: permissionUseFact?.atMonth,
    who: permissionUseFact?.who,
    action: permissionUseFact?.action,
    permission: collectiveState.permissions.find((candidate) => candidate.id === permission.id),
  })}`);
  assert.equal(collectiveState.people.find((person) => person.id === partner.id)?.inventory.filter((stack) => stack.materialId === 21).reduce((sum, stack) => sum + stack.quantity, 0), partnerFoodBefore + 1, '被授权者仍必须通过真实 transfer 取用一份物质');
  assert.equal(collectiveState.permissions[0]?.useEventIds.length, 1, '许可的每次行使必须留下独立动作证据');
  assert.equal(buildDecisionContexts(collectiveState).find((context) => context.person.id === partner.id)?.options.some((option) => option.id.startsWith(`use-permission:${permission.id}:`)), false,
    '储备缺口已经被填平后，同一许可不能通过“当前库存加一”继续制造目标');
  collectiveState.permissions.push({
    id: 'permission:test-reciprocal-food', collectiveId: collective.id,
    grantorId: partner.id, granteeId: founder.id, materialId: 21,
    maxQuantityPerTransfer: 1, validFromMonth: collectiveState.clock.elapsedMonths,
    validUntilMonth: collectiveState.clock.elapsedMonths + 24, status: 'active',
    proposalAgreementId: 'fixture-reciprocal', sourceEventIds: ['test-reciprocal-source'], useEventIds: [],
  });
  assert.equal(buildDecisionContexts(collectiveState).find((context) => context.person.id === founder.id)?.options.some((option) => option.id.startsWith('use-permission:permission:test-reciprocal-food:')), false,
    '双方储备相等时，互相许可不能产生把同一物资拿回去的反向行动');
  permissionContext = buildDecisionContexts(collectiveState).find((context) => context.person.id === founder.id);
  const revokePermission = permissionContext?.options.find((option) => option.id.startsWith('revoke-permission:'));
  collectiveState = runRecordOption(collectiveState, founder.id, revokePermission, 'revoke-resource-permission');
  assert.equal(collectiveState.permissions[0]?.status, 'revoked', '物质持有者应能通过可追溯沟通撤回未来授权');
  assert.equal(buildDecisionContexts(collectiveState).find((context) => context.person.id === partner.id)?.options.some((option) => option.id.startsWith('use-permission:')), false, '许可撤回后不得继续生成合法取用意图');

  const governingFounder = collectiveState.people.find((person) => person.id === founder.id);
  const governingPartner = collectiveState.people.find((person) => person.id === partner.id);
  governingFounder.body = { health: 100, hydration: 100, nutrition: 100 };
  governingPartner.body = { health: 100, hydration: 100, nutrition: 55 };
  governingFounder.motiveSensitivity.status = 100;
  governingFounder.baselineCapacities.cognition = 100;
  governingPartner.inventory = governingPartner.inventory.filter((stack) => stack.materialId !== 21);
  const governingFood = governingFounder.inventory.find((stack) => stack.materialId === 21);
  if (governingFood) governingFood.quantity = Math.max(2, governingFood.quantity);
  else governingFounder.inventory.push({ id: 'test-governance-food', materialId: 21, quantity: 2, sourceEventIds: ['test-governance-pressure'] });
  placeWith(governingPartner, governingFounder);
  let governanceContext = buildDecisionContexts(collectiveState).find((context) => context.person.id === founder.id);
  const offerDecisionRule = governanceContext?.options.find((option) => option.id.startsWith('offer-decision-rule:')
    && option.nextAction.kind === 'talk'
    && option.nextAction.speakerMeaning.proposal?.kind === 'decision-rule'
    && option.nextAction.speakerMeaning.proposal.materialId === 21);
  collectiveState = runRecordOption(collectiveState, founder.id, offerDecisionRule, 'offer-unanimous-decision-rule');
  const decisionRuleAgreement = collectiveState.agreements.find((agreement) => agreement.proposal.kind === 'decision-rule');
  assert.equal(decisionRuleAgreement?.status, 'proposed', '发起者单方面说出选择规则不能产生共同规则');
  assert.equal(collectiveState.collectives[0]?.decisionRules.length, 0, '没有每位成员明确同意时，共同体不得凭空获得治理规则');
  governanceContext = buildDecisionContexts(collectiveState).find((context) => context.person.id === partner.id);
  assert.deepEqual(new Set(governanceContext?.options.map((option) => option.id.split(':')[0])), new Set(['accept-decision-rule', 'reject-decision-rule']), '规则提议必须交由每名未回应成员本人接受或拒绝');
  collectiveState = runRecordOption(collectiveState, partner.id, governanceContext?.options.find((option) => option.id.startsWith('accept-decision-rule:')), 'accept-unanimous-decision-rule');
  const decisionRule = collectiveState.collectives[0]?.decisionRules[0];
  assert.ok(decisionRule?.status === 'active' && decisionRule.method === 'unanimous' && decisionRule.materialId === 21, '全体同意后才应形成限定物质与授权期限的 DecisionRule');
  assert.ok(collectiveState.derived.milestones.some((milestone) => milestone.capabilityId === 524), '全体逐人接受的共同选择规则应观察为通过协商形成共识');

  governanceContext = buildDecisionContexts(collectiveState).find((context) => context.person.id === founder.id);
  const offerMandate = governanceContext?.options.find((option) => option.id.startsWith('offer-mandate:')
    && option.nextAction.kind === 'talk'
    && option.nextAction.speakerMeaning.proposal?.kind === 'mandate'
    && option.nextAction.speakerMeaning.proposal.holderId === founder.id);
  collectiveState = runRecordOption(collectiveState, founder.id, offerMandate, 'offer-material-coordinator');
  const mandateAgreement = collectiveState.agreements.find((agreement) => agreement.proposal.kind === 'mandate');
  assert.equal(mandateAgreement?.status, 'proposed', '自荐或提名本身不能直接获得共同体授权');
  assert.equal(collectiveState.collectives[0]?.mandates.length, 0, '成员没有按既定规则接受前不得产生协调者');
  governanceContext = buildDecisionContexts(collectiveState).find((context) => context.person.id === partner.id);
  collectiveState = runRecordOption(collectiveState, partner.id, governanceContext?.options.find((option) => option.id.startsWith('accept-mandate:')), 'accept-material-coordinator');
  const mandate = collectiveState.collectives[0]?.mandates[0];
  assert.ok(mandate?.status === 'active' && mandate.holderId === founder.id && mandate.validUntilMonth > collectiveState.clock.elapsedMonths, '成员按共同规则接受后应形成有范围、有期限的 Mandate');

  collectiveState.people.find((person) => person.id === partner.id).inventory.push({ id: 'test-voluntary-contribution', materialId: 21, quantity: 2, sourceEventIds: ['test-voluntary-contribution-source'] });
  governanceContext = buildDecisionContexts(collectiveState).find((context) => context.person.id === partner.id);
  const contribute = governanceContext?.options.find((option) => option.id.startsWith(`contribute-mandate:${mandate.id}:`));
  const holderFoodBefore = collectiveState.people.find((person) => person.id === founder.id).inventory.filter((stack) => stack.materialId === 21).reduce((sum, stack) => sum + stack.quantity, 0);
  collectiveState = runRecordOption(collectiveState, partner.id, contribute, 'voluntary-mandate-contribution');
  assert.equal(collectiveState.people.find((person) => person.id === founder.id)?.inventory.filter((stack) => stack.materialId === 21).reduce((sum, stack) => sum + stack.quantity, 0), holderFoodBefore + 1, '授权不得自动征收；成员仍须以自己的 transfer 自愿交付');
  assert.equal(collectiveState.collectives[0]?.mandates[0]?.contributionEventIds.length, 1, '交给协调者的每份物质必须保留具体人物的行动证据');
  governanceContext = buildDecisionContexts(collectiveState).find((context) => context.person.id === founder.id);
  const distribute = governanceContext?.options.find((option) => option.id.startsWith(`distribute-mandate:${mandate.id}:`) && option.target?.kind === 'person' && option.target.personId === partner.id);
  collectiveState = runRecordOption(collectiveState, founder.id, distribute, 'mandate-material-distribution');
  assert.equal(collectiveState.collectives[0]?.mandates[0]?.distributionEventIds.length, 1, '协调者也必须亲自执行分配，组织不能像超级 Agent 一样移动物质');
  assert.ok(collectiveState.derived.institutions.some((institution) => institution.key.startsWith('collective-coordination:')), '共同规则、授权、交付和分配闭环后才能投影为制度实践');
  assert.ok(collectiveState.derived.milestones.some((milestone) => milestone.capabilityId === 530), '被实际行使的限期协调授权应观察为记录并执行集体决定');
  assert.equal(collectiveState.derived.milestones.some((milestone) => milestone.capabilityId === 61), false,
    '限期授权或任命不能证明发生了“选举领袖”，该地图坐标应继续 guarded');

  const currentFounder = collectiveState.people.find((person) => person.id === founder.id);
  const currentPartner = collectiveState.people.find((person) => person.id === partner.id);
  const candidate = collectiveState.people[2];
  assert.ok(currentFounder && currentPartner && candidate, '第三人入会测试需要两名现有成员和一名候选人');
  candidate.bornAtMonth = -20 * 12;
  placeWith(currentPartner, currentFounder);
  placeWith(candidate, currentFounder);
  const candidateAssistId = 'test-candidate-fulfilled-assist';
  const candidateRequest = actionFact('test-candidate-assist-request', collectiveState.clock.elapsedMonths, founder.id, { kind: 'talk', speakerMeaning: { id: candidateAssistId, kind: 'request', summary: '请给我一份食物', proposal: { kind: 'assist', requesterId: founder.id, helperId: candidate.id, need: 'food', expiresAtMonth: collectiveState.clock.elapsedMonths + 2 } }, interpreters: [candidate.id] });
  recordAgreementAction(collectiveState, candidateRequest);
  appendFixtureEvents(collectiveState, [candidateRequest]);
  const candidateAcceptance = actionFact('test-candidate-assist-acceptance', collectiveState.clock.elapsedMonths, candidate.id, { kind: 'talk', speakerMeaning: { id: 'test-candidate-assist-acceptance-content', kind: 'accept', referenceId: candidateAssistId }, interpreters: [founder.id] });
  recordAgreementAction(collectiveState, candidateAcceptance);
  appendFixtureEvents(collectiveState, [candidateAcceptance]);
  const candidateFulfillment = actionFact('test-candidate-assist-fulfillment', collectiveState.clock.elapsedMonths, candidate.id, { kind: 'transfer', materialId: 21, quantity: 1, from: { kind: 'person', personId: candidate.id }, to: { kind: 'person', personId: founder.id }, authorizationRef: candidateAssistId });
  recordAgreementAction(collectiveState, candidateFulfillment);
  appendFixtureEvents(collectiveState, [candidateFulfillment]);
  collectiveState.clock.elapsedMonths += 1;
  const repeatedCandidateAssistId = 'test-candidate-repeated-fulfilled-assist';
  const repeatedCandidateRequest = actionFact('test-candidate-repeated-assist-request', collectiveState.clock.elapsedMonths, founder.id, { kind: 'talk', speakerMeaning: { id: repeatedCandidateAssistId, kind: 'request', summary: '请再给我一份食物', proposal: { kind: 'assist', requesterId: founder.id, helperId: candidate.id, need: 'food', expiresAtMonth: collectiveState.clock.elapsedMonths + 2 } }, interpreters: [candidate.id] });
  recordAgreementAction(collectiveState, repeatedCandidateRequest);
  appendFixtureEvents(collectiveState, [repeatedCandidateRequest]);
  const repeatedCandidateAcceptance = actionFact('test-candidate-repeated-assist-acceptance', collectiveState.clock.elapsedMonths, candidate.id, { kind: 'talk', speakerMeaning: { id: 'test-candidate-repeated-assist-acceptance-content', kind: 'accept', referenceId: repeatedCandidateAssistId }, interpreters: [founder.id] });
  recordAgreementAction(collectiveState, repeatedCandidateAcceptance);
  appendFixtureEvents(collectiveState, [repeatedCandidateAcceptance]);
  const repeatedCandidateFulfillment = actionFact('test-candidate-repeated-assist-fulfillment', collectiveState.clock.elapsedMonths, candidate.id, { kind: 'transfer', materialId: 21, quantity: 1, from: { kind: 'person', personId: candidate.id }, to: { kind: 'person', personId: founder.id }, authorizationRef: repeatedCandidateAssistId });
  recordAgreementAction(collectiveState, repeatedCandidateFulfillment);
  appendFixtureEvents(collectiveState, [repeatedCandidateFulfillment]);
  const membershipContext = buildDecisionContexts(collectiveState).find((context) => context.person.id === founder.id);
  const offerMembership = membershipContext?.options.find((option) => option.id.startsWith('offer-membership:')
    && option.nextAction.kind === 'talk'
    && option.nextAction.speakerMeaning.proposal?.kind === 'membership'
    && option.nextAction.speakerMeaning.proposal.candidateId === candidate.id);
  assert.ok(offerMembership, `已有共同体应能吸收有跨月重复合作事实的第三人；options=${JSON.stringify(membershipContext?.options.map((option) => option.id))}`);
  collectiveState = runRecordOption(collectiveState, founder.id, offerMembership, 'offer-third-membership');
  const membershipAgreement = collectiveState.agreements.find((agreement) => agreement.proposal.kind === 'membership');
  assert.deepEqual(new Set(membershipAgreement?.requiredResponderIds), new Set([partner.id, candidate.id]), '成员扩张必须同时要求所有既有成员和候选人回应');
  const partnerMembershipResponse = buildDecisionContexts(collectiveState).find((context) => context.person.id === partner.id);
  collectiveState = runRecordOption(collectiveState, partner.id, partnerMembershipResponse?.options.find((option) => option.id.startsWith('accept-membership:')), 'member-accepts-third');
  assert.equal(membershipAgreement?.status, 'proposed', '只有一名现有成员同意时，候选人仍不能被自动加入');
  assert.equal(collective.memberships.some((membership) => membership.personId === candidate.id), false, '候选人亲自同意以前不能产生成员事实');
  const candidateMembershipResponse = buildDecisionContexts(collectiveState).find((context) => context.person.id === candidate.id);
  collectiveState = runRecordOption(collectiveState, candidate.id, candidateMembershipResponse?.options.find((option) => option.id.startsWith('accept-membership:')), 'candidate-accepts-membership');
  assert.equal(collectiveState.agreements.find((agreement) => agreement.id === membershipAgreement?.id)?.status, 'fulfilled', '所有必需回应者同意后，成员扩张协议才算完成');
  assert.equal(collectiveState.collectives[0]?.memberships.find((membership) => membership.personId === candidate.id)?.status, 'active', '候选人的明确接受应产生可退出、可追溯的成员身份');

  const withdrawing = collectiveState.people.find((person) => person.id === founder.id);
  const strainedRelation = withdrawing.relations.find((relation) => relation.personId === partner.id);
  strainedRelation.trust = -20;
  const withdrawalContext = buildDecisionContexts(collectiveState).find((context) => context.person.id === founder.id);
  const withdrawal = withdrawalContext?.options.find((option) => option.id.startsWith('withdraw-collective:'));
  assert.ok(withdrawal, '低信任或恐惧下，成员必须可以通过沟通退出，而不是被共同体标签永久锁定');
  collectiveState = runRecordOption(collectiveState, founder.id, withdrawal, 'withdraw-collective');
  const updatedCollective = collectiveState.collectives.find((candidate) => candidate.id === collective.id);
  assert.equal(updatedCollective?.memberships.find((membership) => membership.personId === founder.id)?.status, 'withdrawn', '退出沟通必须终止本人的持续成员身份');
  assert.equal(updatedCollective?.status, 'active', '三人共同体中一人退出后，剩余两名成员应继续维持共同体');
  assert.equal(updatedCollective?.memberships.filter((membership) => membership.status === 'active').length, 2, '退出只终止本人的成员身份，不应抹除其他成员');

  const repeatedExperimentState = createInitialState(381, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const experimenter = repeatedExperimentState.people[0];
  const techniqueId = 'technique:combine:22:3:11';
  experimenter.knowledge.push({ id: techniqueId, kind: 'technique', summary: '种子与湿土可结合为作物幼苗', confidence: 64, learnedAtMonth: 0, sourceEventIds: ['repeat-trial-1', 'repeat-trial-2'] });
  appendFixtureEvents(repeatedExperimentState, [
    { ...actionFact('repeat-trial-1', 1, experimenter.id, { kind: 'act', operation: 'combine', targets: [] }), diff: { inputMaterialId: 22, targetMaterialId: 3, outputMaterialId: 11 } },
    { ...actionFact('repeat-trial-2', 2, experimenter.id, { kind: 'act', operation: 'combine', targets: [] }), diff: { inputMaterialId: 22, targetMaterialId: 3, outputMaterialId: 11 } },
  ]);
  const observedExperimentState = stepSimulation(repeatedExperimentState, { decide() { return { kind: 'idle', reason: '不干扰重复实验观察' }; } });
  assert.ok(observedExperimentState.derived.milestones.some((milestone) => milestone.capabilityId === 222), '同一物质规律被成功复现两次，应构成试错学习的证据链');

  const responseState = createInitialState(39, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const offerer = responseState.people[0];
  const responder = responseState.people[2];
  responder.bornAtMonth = -20 * 12;
  const separatedPosition = responseState.people.find((person) => {
    const horizontalDistance = Math.abs(person.position.cellId % responseState.world.grid.width
      - offerer.position.cellId % responseState.world.grid.width)
      + Math.abs(Math.floor(person.position.cellId / responseState.world.grid.width)
        - Math.floor(offerer.position.cellId / responseState.world.grid.width));
    return horizontalDistance > 1;
  })?.position;
  const separatedCell = separatedPosition?.cellId;
  assert.ok(Number.isInteger(separatedCell), '测试世界应有一个在普通语音范围外的可达出生格');
  placeWith(responder, offerer);
  offerer.inventory.push({ id: 'exchange-wood', materialId: 13, quantity: 2, sourceEventIds: [] });
  responder.inventory.push({ id: 'exchange-food', materialId: 21, quantity: 2, sourceEventIds: [] });
  const exchangeId = 'test-required-exchange';
  const exchangeFact = actionFact('test-required-exchange-event', 1, offerer.id, { kind: 'talk', speakerMeaning: { id: exchangeId, kind: 'offer', summary: '木材换食物', proposal: { kind: 'exchange', offererId: offerer.id, partnerId: responder.id, offererMaterialId: 13, offererQuantity: 1, partnerMaterialId: 21, partnerQuantity: 1, expiresAtMonth: 8 } }, interpreters: [responder.id] });
  recordAgreementAction(responseState, exchangeFact);
  appendFixtureEvents(responseState, [exchangeFact]);
  responder.position.cellId = separatedCell;
  responder.position.z = separatedPosition.z;
  responder.position.previousCellId = separatedCell;
  responder.position.previousZ = separatedPosition.z;
  const responseContext = buildDecisionContexts(responseState, responseState.clock.elapsedMonths + 1)
    .find((context) => context.person.id === responder.id);
  assert.deepEqual(new Set(responseContext?.options.map((option) => option.id.split(':')[0])), new Set(['accept-exchange', 'reject-exchange']), '收到可履行交换后只能先明确接受或拒绝');
  const acceptExchange = responseContext?.options.find((option) => option.id.startsWith('accept-exchange:'));
  assert.equal(acceptExchange?.nextAction.kind, 'move', '提议后分开时，应先连续追上提议者');
  assert.equal(acceptExchange?.completionAction?.kind, 'talk', '跨月会合后必须保留原本的接受回应');
  assert.equal(Boolean(acceptExchange?.requiresFollowUp), false, '接受结构化协议后应由协议条款编译行动，不能让模型另选无关后续');
  responseState.decisionBudget.credits = 0;
  responseState.decisionBudget.ledgers = [];
  const requiredBatches = [];
  const respondedState = await stepSimulationAsync(responseState, {
    async decideAll(contexts) {
      requiredBatches.push(contexts.map((context) => context.person.id));
      return contexts.map((context) => context.person.id === responder.id
        ? { kind: 'start', optionId: acceptExchange.id, reason: '追上报价者并明确接受' }
        : { kind: 'idle', reason: '不干扰回应测试' });
    },
    takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
  });
  assert.ok(requiredBatches.flat().includes(responder.id), '明确回应不应被普通模型预算挤掉');
  const acceptanceFact = respondedState.world.past.find((event) => event.kind === 'action'
    && event.who === responder.id
    && event.action.kind === 'talk'
    && event.action.speakerMeaning.kind === 'accept'
    && event.action.speakerMeaning.referenceId === exchangeId);
  assert.ok(acceptanceFact, '回应者应以同一跨月意图完成移动后真正说出接受');
  assert.equal(respondedState.agreements.find((agreement) => agreement.id === exchangeId)?.status, 'fulfilled', '真正说出接受后，双方应以已有 transfer 原语继续履行交换');
  const exchangeDeliveries = respondedState.world.past.filter((event) => event.kind === 'action'
    && event.action.kind === 'transfer'
    && event.action.authorizationRef === exchangeId);
  assert.deepEqual(new Set(exchangeDeliveries.map((event) => event.who)), new Set([offerer.id, responder.id]), '结构化接受必须自动产生双方各自的真实交付，而不是模型随意搭配后续行动');

  const roadState = createInitialState(40, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const roadWalker = roadState.people[0];
  for (let index = 0; index < 4; index += 1) {
    appendFixtureEvents(roadState, [{
      ...actionFact(`road-formation-${index}`, index + 1, roadWalker.id, { kind: 'move', toCellId: roadWalker.position.cellId }),
      pathSegment: [roadWalker.position.cellId, roadWalker.position.cellId + 1],
      diff: { materialChanges: [{ cellId: 100 + index, from: 2, to: 15 }] },
    }]);
  }
  const projectedRoad = stepSimulation(roadState, { decide() { return { kind: 'idle', reason: '道路观察测试' }; } });
  const roadMilestone = projectedRoad.derived.milestones.find((milestone) => milestone.capabilityId === 42);
  assert.equal(roadMilestone?.observedAtMonth, 4, '道路首次出现时间应取第四个真实压实格形成时，而不是最早一次历史移动');
  assert.deepEqual(roadMilestone?.evidenceEventIds, ['road-formation-0', 'road-formation-1', 'road-formation-2', 'road-formation-3']);

  let shelterState = createInitialState(41, { endpoint: { kind: 'months', value: 10 }, chaosIntensity: 0 });
  const builderId = shelterState.people[0].id;
  for (const bystander of shelterState.people.slice(1)) bystander.diedAtMonth = 0;
  shelterState.people[0].inventory = [{ id: 'shelter-wood', materialId: 13, quantity: 4, sourceEventIds: [] }];
  for (let index = 0; index < 4; index += 1) {
    const builder = shelterState.people.find((person) => person.id === builderId);
    const buildOptions = buildConstructionOptions(shelterState, builder);
    const buildOption = index === 0
      ? buildOptions[0]
      : index < 3
        ? buildOptions.find((option) => option.summary.includes('上方'))
        : buildOptions.find((option) => option.summary.includes('头顶'));
    assert.ok(builder && buildOption, '持有木材时应能继续扩展身边的木板组件');
    const intentId = `intent-test-shelter-${index}`;
    shelterState.intents.push({
      id: intentId, ownerId: builderId, summary: buildOption.summary, domain: 'strategic', goal: buildOption.goal,
      nextAction: buildOption.nextAction, target: buildOption.target, status: 'active', createdAtMonth: shelterState.clock.elapsedMonths,
      lastProgressAtMonth: shelterState.clock.elapsedMonths, progress: 0, sourceDecisionEventId: `decision-test-shelter-${index}`,
      sourceFactIds: buildOption.sourceFactIds, actionEventIds: [], replanCount: 0,
    });
    builder.activeIntentId = intentId;
    shelterState.decisionBudget.credits = 0;
    shelterState = stepSimulation(shelterState, { decide() { return { kind: 'idle', reason: '不改写固定建造意图' }; } });
  }
  const completedShelter = shelterState.derived.structures.find((structure) => structure.complete);
  assert.ok(completedShelter?.interiorPositions.some((position) => position.cellId === shelterState.people[0].position.cellId && position.z === shelterState.people[0].position.z), '住所必须来自人物当前可进入的双格净空与真实头顶覆盖，而不是相邻木板数量');
  assert.equal(completedShelter?.capacity, completedShelter?.interiorPositions.length, '结构容量必须等于真实可站立内部位置数');
  assert.ok(shelterState.derived.milestones.some((milestone) => milestone.capabilityId === 20), '真实连接的多格木板结构才能观察为住所');
  let shelterUseState = structuredClone(shelterState);
  const shelterUser = shelterUseState.people.find((person) => person.id === builderId);
  shelterUseState.civilization.climate = { kind: 'cold', severity: 3, sinceMonth: shelterUseState.clock.elapsedMonths };
  shelterUseState.civilization.externalClimate = { epoch: 'stable', kind: 'cold', severity: 3 };
  shelterUser.conditions.push({ id: 'test-shelter-cold', kind: 'cold', stage: 2, sinceMonth: shelterUseState.clock.elapsedMonths, sourceEventIds: ['test-shelter-cold-source'] });
  shelterUser.body = { health: 80, hydration: 80, nutrition: 80 };
  const interior = completedShelter.interiorPositions[0];
  const outsideCandidates = [interior.cellId - 1, interior.cellId + 1, interior.cellId - shelterUseState.world.grid.width, interior.cellId + shelterUseState.world.grid.width]
    .filter((cell) => cell >= 0 && cell < shelterUseState.world.grid.width * shelterUseState.world.grid.depth);
  let shelterOption;
  for (const cell of outsideCandidates) {
    const z = surfaceStandingZ(shelterUseState, cell);
    shelterUser.position = { ...shelterUser.position, cellId: cell, z, previousCellId: cell, previousZ: z, lastPath: [cell], tickPath: [cell] };
    shelterOption = buildDecisionContexts(shelterUseState).find((context) => context.person.id === builderId)?.options.find((option) => option.id.startsWith('shelter:'));
    if (shelterOption) break;
  }
  assert.equal(shelterOption?.goal.kind, 'sheltered', '看见或记得可达住所时，冷热压力应产生入住意图，而不是只保留住所里程碑');
  shelterUseState.decisionBudget.credits = 0;
  shelterUseState = stepSimulation(shelterUseState, { decide() { return { kind: 'idle', reason: '二级冷热避险不应依赖模型' }; } });
  const shelterReflex = shelterUseState.lastStep.find((event) => event.kind === 'action'
    && event.who === builderId
    && event.cause === 'survival-reflex'
    && event.action.kind === 'move'
    && event.action.toCellId === interior.cellId
    && event.action.toZ === interior.z);
  const shelteredUser = shelterUseState.people.find((person) => person.id === builderId);
  assert.ok(shelterReflex, '二级冷热状态必须用既有 move 原语进入已知住所，不消耗模型决策');
  assert.ok(shelterUseState.derived.structures.some((structure) => structure.complete && structure.interiorPositions.some((position) => position.cellId === shelteredUser.position.cellId && position.z === shelteredUser.position.z)), '避险移动完成后，人物必须真实站在仍有效的住所内部');
  let plankRecoveryState = structuredClone(shelterState);
  const plankRecoveryOption = buildDecisionContexts(plankRecoveryState).find((context) => context.person.id === builderId)?.options.find((option) => option.id.startsWith('separate-material:recover-plank'));
  assert.ok(plankRecoveryOption?.target?.kind === 'voxel', '近身结构木板应产生一个可拆回的物质候选');
  const recoveredPosition = plankRecoveryOption.target.position;
  plankRecoveryState = runRecordOption(plankRecoveryState, builderId, plankRecoveryOption, 'recover-placed-plank');
  const recoveredVoxelIndex = recoveredPosition.z * plankRecoveryState.world.grid.width * plankRecoveryState.world.grid.depth + recoveredPosition.y * plankRecoveryState.world.grid.width + recoveredPosition.x;
  assert.equal(plankRecoveryState.world.grid.voxels[recoveredVoxelIndex], 0, '拆解必须移除原结构体素，使结构投影不再把旧事件当作现存物质');
  assert.ok(plankRecoveryState.people.find((person) => person.id === builderId)?.inventory.some((stack) => stack.materialId === 19 && stack.quantity >= 1), '拆下的木板必须能回到私人背包并再次用于建造');
  const stoneBuilder = shelterState.people.find((person) => person.id === builderId);
  stoneBuilder.inventory = [{ id: 'shelter-stone', materialId: 1, quantity: 2, sourceEventIds: ['test-collected-stone'] }];
  const stoneBuildOption = buildConstructionOptions(shelterState, stoneBuilder).find((option) => option.goal.kind === 'voxel-is'
    && option.goal.materialId === 1
    && option.nextAction.kind === 'act'
    && option.nextAction.operation === 'combine'
    && option.nextAction.targets.some((target) => target.kind === 'inventory-stack' && target.stackId === 'shelter-stone'));
  assert.ok(stoneBuildOption?.goal.kind === 'voxel-is' && stoneBuildOption.goal.materialId === 1, '标记为固体建造物质的石应从同一 combine 原语产生空间连接选项');
  shelterState = runRecordOption(shelterState, builderId, stoneBuildOption, 'connect-stone-to-space');
  const stonePlacement = shelterState.world.past.find((event) => event.kind === 'action' && event.intentId?.includes('connect-stone-to-space'));
  assert.equal(stonePlacement?.diff.outputMaterialId, 1, '石建造必须消耗私人背包中的真实石并在目标体素放置石物质');
  assert.ok(shelterState.derived.structures.some((structure) => structure.materialIds.includes(1) && structure.sourceEventIds.includes(stonePlacement.id)), '结构投影必须从真实放置事件识别石或混合材料，不能只扫描木板标签');

  let state = createInitialState(31, { endpoint: { kind: 'months', value: 72 }, chaosIntensity: 0 });
  for (let index = 0; index < 72 && state.civilization.status === 'running'; index += 1) state = stepSimulation(state);
  const opportunities = state.world.past.filter((event) => event.kind === 'decision-opportunity');
  assert.ok(opportunities.length >= initial.people.length * 24, '在世人物每月应留下概率账本');
  assert.ok(opportunities.every((event) => event.probability > 0), '每个人每月关键决策概率必须非零');
  assert.ok(state.intents.some((intent) => intent.actionEventIds.length > 1), '长期意图应跨月推进原子动作');
  assert.ok(state.world.past.some((event) => event.kind === 'action' && event.action.kind === 'transfer'), '应真实发生掉落物到私有背包的转移');
  assert.ok(state.world.past.some((event) => event.kind === 'action' && event.action.kind === 'act' && event.action.operation === 'ingest'), '身体储备应通过摄入动作恢复');
  assert.ok(state.world.past.some((event) => event.kind === 'environment' && event.change === 'material'), '无人行动时世界物质也应继续变化');

  const legacy = structuredClone(initial);
  legacy.schemaVersion = 16;
  assert.throws(() => createSimulation({ state: legacy }), /只接受 schemaVersion 19/, '破坏性语言重构后旧存档必须硬切拒绝');

  let calls = 0;
  const budgetBatches = [];
  const batch = {
    async decideAll(contexts) {
      calls += contexts.length;
      budgetBatches.push(contexts.map((context) => context.person.id));
      return contexts.map(() => ({ kind: 'idle', reason: '测试中的合法模型决策' }));
    },
    takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
  };
  let budgetState = createInitialState(17, { endpoint: { kind: 'months', value: 24 } });
  for (let index = 0; index < 12; index += 1) budgetState = await stepSimulationAsync(budgetState, batch);
  const personMonths = budgetState.decisionBudget.ledgers.reduce((sum, ledger) => sum + ledger.livingAgents, 0);
  const ordinaryCalls = budgetState.decisionBudget.ledgers.reduce((sum, ledger) => sum + (ledger.ordinaryModelContexts ?? ledger.modelContexts), 0);
  const exemptCalls = budgetState.decisionBudget.ledgers.reduce((sum, ledger) => sum + (ledger.exemptModelContexts ?? 0), 0);
  const founderCount = budgetState.people.filter((person) => person.generation === 0).length;
  const openingCapacity = Math.floor(founderCount / 3);
  assert.equal(new Set(budgetBatches[0]).size, openingCapacity,
    '先民可以进入模型审议，但必须与普通月份共用每 3 人月一个上下文的容量');
  assert.equal(budgetState.decisionBudget.ledgers[0]?.ordinaryModelContexts, openingCapacity,
    '开局模型审议必须计入普通人月额度');
  assert.equal(budgetState.decisionBudget.ledgers[0]?.exemptModelContexts, 0,
    '开局不得再把全部先民放大成无上限豁免调用');
  assert.ok(ordinaryCalls <= Math.floor(personMonths / 3), '普通模型上下文不得超过每 3 人月一个的滚动额度');
  assert.equal(calls, ordinaryCalls + exemptCalls, '总调用审计应等于普通与豁免调用之和');

  assert.ok(initial.people.every((person) => Array.isArray(person.memories)), '人物应持有固定预算记忆');
  assert.ok(state.world.past.some((event) => event.kind === 'action' && event.cause === 'survival-reflex'), '生存维护应由规则反射产生可审计动作');
  assert.ok(state.people.every((person) => person.memories.length <= 24), '人物记忆必须保持固定上限');
  const lastMonthActions = state.lastStep.filter((event) => event.kind === 'action');
  assert.ok(lastMonthActions.every((event) => event.actionTick >= 1 && event.actionTick <= 15), '原子行动必须归属 1–15 的月内规则刻度');
  assert.ok(state.people.filter((person) => person.bornAtMonth < state.clock.elapsedMonths).every((person) => person.position.tickPath.length === 16), '每位人物每月必须留下月初加 15 刻度的位置轨迹');
  for (const event of state.world.past.filter((fact) => fact.kind === 'action' && fact.action.kind === 'move')) {
    assert.ok(event.pathSegment.length <= 3, '单个行动刻度最多沿连续低成本路面跨越两条边');
    for (let index = 1; index < event.pathSegment.length; index += 1) {
      const from = event.pathSegment[index - 1];
      const to = event.pathSegment[index];
      const distance = Math.abs(from % 84 - to % 84) + Math.abs(Math.floor(from / 84) - Math.floor(to / 84));
      assert.equal(distance, 1, '每个空间路径步必须连接四邻格');
    }
  }
  console.log(`simulation tests passed: schema 17, ${state.people.length} people, ${state.world.past.length} facts, ${state.derived.milestones.length} milestones, ${ordinaryCalls}/${Math.floor(personMonths / 3)} ordinary contexts + ${exemptCalls} exempt`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
