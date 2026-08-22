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
const personalityBundlePath = path.join(temporaryDirectory, 'personality.mjs');
const materialBundlePath = path.join(temporaryDirectory, 'material.mjs');
const gridBundlePath = path.join(temporaryDirectory, 'grid.mjs');

try {
  for (const [entry, output] of [
    ['src/game/eland/simulation.ts', simulationBundlePath],
    ['src/game/eland/domain/agreement.ts', agreementBundlePath],
    ['src/game/eland/domain/action-executor.ts', executorBundlePath],
    ['src/game/eland/application/decision-factor-forest.ts', decisionFactorBundlePath],
    ['src/game/eland/domain/monthly-processes.ts', monthlyProcessesBundlePath],
    ['src/game/eland/domain/personality.ts', personalityBundlePath],
    ['src/game/eland/domain/material.ts', materialBundlePath],
    ['src/game/eland/world/grid.ts', gridBundlePath],
  ]) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
    ], { stdio: 'pipe' });
  }

  const { buildDecisionContexts, createInitialState, executeActiveIntent, seededFraction, stepSimulation } = await import(`${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`);
  const { advanceAgreementLifecycle, recordAgreementAction } = await import(`${pathToFileURL(agreementBundlePath).href}?test=${Date.now()}`);
  const { executePrimitiveAction } = await import(`${pathToFileURL(executorBundlePath).href}?test=${Date.now()}`);
  const { evaluateDecisionOption } = await import(`${pathToFileURL(decisionFactorBundlePath).href}?test=${Date.now()}`);
  const { advanceSharedRelationshipExperience } = await import(`${pathToFileURL(monthlyProcessesBundlePath).href}?test=${Date.now()}`);
  const { newbornInitialTrust } = await import(`${pathToFileURL(personalityBundlePath).href}?test=${Date.now()}`);
  const { Material } = await import(`${pathToFileURL(materialBundlePath).href}?test=${Date.now()}`);
  const { cellX, cellY, neighbors4, setVoxel } = await import(`${pathToFileURL(gridBundlePath).href}?test=${Date.now()}`);

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
  const originalSocialPersonality = new Map([female, male].map((person) => [person.id, {
    agreeableness: person.personality.baseline.agreeableness,
    extraversion: person.personality.baseline.extraversion,
    learnedAgreeableness: person.personality.learnedDelta.agreeableness,
    learnedExtraversion: person.personality.learnedDelta.extraversion,
  }]));
  for (const person of [female, male]) {
    person.personality.baseline.agreeableness = 0;
    person.personality.baseline.extraversion = 0;
    person.personality.learnedDelta.agreeableness = 0;
    person.personality.learnedDelta.extraversion = 0;
  }
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

  Object.assign(directedRelation, { trust: 5, bond: 5, sourceEventIds: [founding.id] });
  Object.assign(reciprocalRelation, { trust: 0, bond: 0, sourceEventIds: [] });
  context = buildDecisionContexts(state).find((candidate) => candidate.person.id === female.id);
  const lowRelationshipOffer = context?.options.find((option) => option.id.startsWith('offer-reproduce:'));
  assert.ok(context && lowRelationshipOffer, '只要提议者拥有可追溯关系，低分和非对称关系也不得被系统硬门槛裁掉');
  const lowRelationshipConsent = evaluateDecisionOption(context, lowRelationshipOffer, { atMonth: 0, planningTick: 1 })
    .votes.find((vote) => vote.tree === 'consent');
  Object.assign(directedRelation, { trust: 90, bond: 90 });
  context = buildDecisionContexts(state).find((candidate) => candidate.person.id === female.id);
  const highRelationshipOffer = context?.options.find((option) => option.id.startsWith('offer-reproduce:'));
  const highRelationshipConsent = context && highRelationshipOffer
    ? evaluateDecisionOption(context, highRelationshipOffer, { atMonth: 0, planningTick: 1 }).votes.find((vote) => vote.tree === 'consent')
    : undefined;
  assert.ok(lowRelationshipConsent && highRelationshipConsent && highRelationshipConsent.score > lowRelationshipConsent.score,
    '关系质量应连续改变人物愿不愿提出生殖，而不是充当固定资格线');

  Object.assign(directedRelation, { trust: 55, bond: 55, sourceEventIds: [founding.id] });
  Object.assign(reciprocalRelation, { trust: 55, bond: 55, sourceEventIds: [founding.id] });
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
  assert.equal(fullMonthFacts[0]?.diff.trustDelta, 4, '二十四岁人物的十五个共同活动刻度应形成三点基础信任和一点年轻加成');
  assert.equal(fullMonthFacts[0]?.diff.bondDelta, 3, '年轻加成只作用于信任，不增加羁绊');
  assert.ok(fullMonthFacts[0]?.diff.relationshipDeltas.every((delta) => (
    delta.tickThreshold === 5 && delta.baseDelta === 3 && delta.youthTrustBonus === 1
  )), '关系事实必须保存每个人的性格门槛、基础增量和年龄加成');
  assert.equal(
    fullMonthSharedState.people.find((person) => person.id === female.id).relations.find((relation) => relation.personId === male.id).bond,
    58,
  );
  const personalitySharedState = structuredClone(state);
  const personalityFirst = personalitySharedState.people.find((person) => person.id === female.id);
  const personalitySecond = personalitySharedState.people.find((person) => person.id === male.id);
  personalityFirst.bornAtMonth = -35 * 12;
  personalitySecond.bornAtMonth = -35 * 12;
  personalityFirst.personality.baseline.agreeableness = 100;
  personalityFirst.personality.baseline.extraversion = 100;
  const personalityFacts = advanceSharedRelationshipExperience(
    personalitySharedState,
    sharedActionTicks(0, 3, personalityFirst, personalitySecond),
    0,
  );
  const fastDelta = personalityFacts[0]?.diff.relationshipDeltas.find((delta) => delta.observerId === personalityFirst.id);
  const slowDelta = personalityFacts[0]?.diff.relationshipDeltas.find((delta) => delta.observerId === personalitySecond.id);
  assert.deepEqual(
    { tickThreshold: fastDelta?.tickThreshold, trustDelta: fastDelta?.trustDelta, bondDelta: fastDelta?.bondDelta },
    { tickThreshold: 3, trustDelta: 1, bondDelta: 1 },
    '高社会接近人格应在三个共同活动刻度后形成一份定向关系证据',
  );
  assert.deepEqual(
    { tickThreshold: slowDelta?.tickThreshold, trustDelta: slowDelta?.trustDelta, bondDelta: slowDelta?.bondDelta },
    { tickThreshold: 5, trustDelta: 0, bondDelta: 0 },
    '同一经历对低社会接近人格仍须累积到五个刻度',
  );
  for (let month = 1; month <= 4; month += 1) {
    const sharedActions = sharedActionTicks(month, 5);
    const sharedFacts = advanceSharedRelationshipExperience(state, sharedActions, month);
    state.world.past.push(...sharedActions, ...sharedFacts);
    state.clock.elapsedMonths = month;
  }
  context = buildDecisionContexts(state).find((candidate) => candidate.person.id === female.id);
  assert.equal(directedRelation.trust, 63);
  assert.equal(directedRelation.bond, 59);
  assert.ok(context?.options.some((option) => option.id.startsWith('offer-reproduce:')), '关系 63/59 时仍应允许人物自行评估是否提出生殖');
  const fifthMonthActions = sharedActionTicks(5, 5);
  const fifthMonthFacts = advanceSharedRelationshipExperience(state, fifthMonthActions, 5);
  state.world.past.push(...fifthMonthActions, ...fifthMonthFacts);
  state.clock.elapsedMonths = 5;
  context = buildDecisionContexts(state).find((candidate) => candidate.person.id === female.id);
  assert.equal(directedRelation.trust, 65);
  assert.equal(directedRelation.bond, 60);
  assert.ok(context?.options.some((option) => option.id.startsWith('offer-reproduce:')), `共同活动提高关系后仍应保留人物评估选项；实际选项：${context?.options.map((option) => option.id).join(',')}`);
  reciprocalRelation.trust = 59;
  context = buildDecisionContexts(state).find((candidate) => candidate.person.id === female.id);
  assert.ok(context?.options.some((option) => option.id.startsWith('offer-reproduce:')), '对方的关系分数不应替代提议者的个人判断');
  reciprocalRelation.trust = 60;
  Object.assign(directedRelation, { trust: 60, bond: 60, sourceEventIds: [] });
  context = buildDecisionContexts(state).find((candidate) => candidate.person.id === female.id);
  assert.equal(context?.options.some((option) => option.id.startsWith('offer-reproduce:')), false, '没有真实来源时关系分数仍不得解锁生殖');
  directedRelation.sourceEventIds = [founding.id];
  for (const person of [female, male]) {
    const original = originalSocialPersonality.get(person.id);
    person.personality.baseline.agreeableness = original.agreeableness;
    person.personality.baseline.extraversion = original.extraversion;
    person.personality.learnedDelta.agreeableness = original.learnedAgreeableness;
    person.personality.learnedDelta.extraversion = original.learnedExtraversion;
  }

  const smoothRiskState = structuredClone(state);
  const smoothRiskFemale = smoothRiskState.people.find((person) => person.id === female.id);
  const smoothRiskMale = smoothRiskState.people.find((person) => person.id === male.id);
  smoothRiskFemale.geneticParents = ['shared-parent', 'female-parent'];
  smoothRiskMale.geneticParents = ['shared-parent', 'male-parent'];
  const consentScoreAtConfidence = (confidence) => {
    smoothRiskFemale.knowledge = confidence > 0 ? [{
      id: 'claim:close-kin-offspring-risk', kind: 'claim', summary: '近亲后代更容易体弱或生病',
      confidence, learnedAtMonth: 1, sourceEventIds: ['test-inherited-outcome'],
    }] : [];
    const riskContext = buildDecisionContexts(smoothRiskState).find((candidate) => candidate.person.id === smoothRiskFemale.id);
    const riskOffer = riskContext?.options.find((option) => option.id.startsWith('offer-reproduce:'));
    assert.ok(riskContext && riskOffer, `风险知识置信度 ${confidence} 时，近亲生殖仍应是合法候选`);
    const consent = evaluateDecisionOption(riskContext, riskOffer, { atMonth: 6, planningTick: 1 })
      .votes.find((vote) => vote.tree === 'consent');
    assert.ok(consent, '生殖提议必须经过 consent 因子树');
    return consent.score;
  };
  const noRiskKnowledgeScore = consentScoreAtConfidence(0);
  const tentativeRiskKnowledgeScore = consentScoreAtConfidence(50);
  const confidentRiskKnowledgeScore = consentScoreAtConfidence(100);
  assert.ok(Math.abs((noRiskKnowledgeScore - tentativeRiskKnowledgeScore) - 16.2) < 1e-9,
    '半同胞风险在 50 置信度时应连续形成 16.2 点成本，而不是等待 55 分后跳变');
  assert.ok(Math.abs((noRiskKnowledgeScore - confidentRiskKnowledgeScore) - 32.4) < 1e-9,
    '半同胞风险在满置信度时应形成 32.4 点软成本，不再使用 162 点近似否决');

  const actionFact = (id, atMonth, who, action) => ({
    id, kind: 'action', actionTick: 1, atMonth, orderInMonth: 0,
    cellId: female.position.cellId, who, cause: 'intent', action,
    fromCellId: female.position.cellId, toCellId: female.position.cellId,
    fromZ: female.position.z, toZ: female.position.z, pathSegment: [female.position.cellId],
    status: 'completed', result: id, diff: {},
  });
  const withoutAgreement = executePrimitiveAction(state, female, {
    kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: male.id }],
  }, 1, 0, { cause: 'intent', actionTick: 1 });
  assert.equal(withoutAgreement.status, 'blocked', '人物判断不能绕过双方明确同意；没有有效协议时领域动作必须阻断');
  assert.equal(withoutAgreement.diff.consent, false);
  const blockedIntentState = structuredClone(state);
  const blockedIntentFemale = blockedIntentState.people.find((person) => person.id === female.id);
  const blockedIntentMale = blockedIntentState.people.find((person) => person.id === male.id);
  const blockedReproductionAction = {
    kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: blockedIntentMale.id }],
  };
  const blockedReproductionIntent = {
    id: 'test-blocked-reproduction-intent', ownerId: blockedIntentFemale.id,
    summary: '没有协议的生殖动作不得冒充一次受孕尝试', domain: 'social',
    goal: { kind: 'condition', personId: blockedIntentFemale.id, condition: 'pregnancy', present: true },
    openingAction: structuredClone(blockedReproductionAction), openingActionCompleted: false,
    nextAction: structuredClone(blockedReproductionAction),
    target: { kind: 'person', personId: blockedIntentMale.id }, status: 'active',
    createdAtMonth: 1, lastProgressAtMonth: 1, progress: 0,
    sourceDecisionEventId: 'test-blocked-reproduction-decision', sourceFactIds: [], actionEventIds: [], replanCount: 0,
  };
  blockedIntentState.intents = [blockedReproductionIntent];
  blockedIntentFemale.activeIntentId = blockedReproductionIntent.id;
  const blockedIntentFact = executeActiveIntent(blockedIntentState, blockedIntentFemale, 1, 0, 1, []);
  assert.equal(blockedIntentFact?.status, 'blocked');
  assert.equal(blockedReproductionIntent.goalOutcome?.kind, 'not-evaluated',
    '被同意门槛阻断的动作没有发生，不能作为 conceived=false 的受孕失败经验');

  const responseState = structuredClone(state);
  responseState.clock.elapsedMonths = 6;
  responseState.agreements = [];
  const responseFemale = responseState.people.find((person) => person.id === female.id);
  const responseMale = responseState.people.find((person) => person.id === male.id);
  const responseOfferId = 'test-autonomous-reproduction-response';
  const responseOfferFact = actionFact('test-autonomous-reproduction-offer-fact', 6, responseFemale.id, {
    kind: 'communicate',
    content: {
      id: responseOfferId, kind: 'offer', summary: '是否愿意共同生育后代',
      proposal: { kind: 'reproduce', proposerId: responseFemale.id, partnerId: responseMale.id, expiresAtMonth: 10 },
    },
    audience: [responseMale.id], channel: 'voice',
  });
  responseState.world.past.push(responseOfferFact);
  recordAgreementAction(responseState, responseOfferFact);
  const responseRelation = responseMale.relations.find((relation) => relation.personId === responseFemale.id);
  Object.assign(responseRelation, { trust: 5, bond: 5, fear: 50, sourceEventIds: [founding.id] });
  let responseContext = buildDecisionContexts(responseState, 6).find((candidate) => candidate.person.id === responseMale.id);
  let acceptResponse = responseContext?.options.find((option) => option.id.startsWith('accept-reproduce:'));
  let rejectResponse = responseContext?.options.find((option) => option.id.startsWith('reject-reproduce:'));
  assert.ok(responseContext && acceptResponse && rejectResponse, '身体条件允许时，接受与拒绝都必须交给回应者本人选择');
  assert.ok(
    evaluateDecisionOption(responseContext, rejectResponse, { atMonth: 6, planningTick: 1 }).causalScore
      > evaluateDecisionOption(responseContext, acceptResponse, { atMonth: 6, planningTick: 1 }).causalScore,
    '低信任且高恐惧时，回应者应通过自己的评估倾向拒绝，而不是由系统资格线代答',
  );
  Object.assign(responseRelation, { trust: 90, bond: 90, fear: 0 });
  responseMale.personality.baseline.extraversion = 100;
  responseMale.personality.baseline.agreeableness = 100;
  responseMale.personality.baseline.openness = 100;
  responseMale.personality.baseline.emotionality = 100;
  responseMale.personality.baseline.conscientiousness = 0;
  responseContext = buildDecisionContexts(responseState, 6).find((candidate) => candidate.person.id === responseMale.id);
  acceptResponse = responseContext?.options.find((option) => option.id.startsWith('accept-reproduce:'));
  rejectResponse = responseContext?.options.find((option) => option.id.startsWith('reject-reproduce:'));
  assert.ok(responseContext && acceptResponse && rejectResponse);
  const unreadyHighRelationAccept = evaluateDecisionOption(
    responseContext,
    acceptResponse,
    { atMonth: 6, planningTick: 1 },
  );
  assert.ok(
    evaluateDecisionOption(responseContext, rejectResponse, { atMonth: 6, planningTick: 1 }).causalScore
      > unreadyHighRelationAccept.causalScore,
    '即使关系很好，没有真实生成性需要时也不能仅由 belonging 推动接受生殖',
  );
  responseMale.inventory = [
    { id: 'response-ready-food', materialId: Material.Food, quantity: 8, sourceEventIds: [founding.id] },
    { id: 'response-ready-water', materialId: Material.Water, quantity: 4, sourceEventIds: [founding.id] },
  ];
  responseState.derived.structures = [];
  const responseShelterCenter = responseMale.position.cellId;
  const responseShelterZ = responseMale.position.z;
  const responseAdjacent = neighbors4(responseShelterCenter);
  const responseSpareCell = responseAdjacent[1] ?? responseAdjacent[0];
  const responseSpareNeighbors = neighbors4(responseSpareCell);
  const responseShelterCells = [...new Set([
    responseShelterCenter,
    ...responseAdjacent,
    responseSpareCell,
    ...responseSpareNeighbors,
  ])];
  for (const cell of responseShelterCells) {
    setVoxel(responseState.world.grid, cellX(cell), cellY(cell), responseShelterZ - 1, Material.PackedSoil);
    setVoxel(responseState.world.grid, cellX(cell), cellY(cell), responseShelterZ, Material.Air);
    setVoxel(responseState.world.grid, cellX(cell), cellY(cell), responseShelterZ + 1, Material.Air);
    setVoxel(responseState.world.grid, cellX(cell), cellY(cell), responseShelterZ + 2, Material.Air);
  }
  setVoxel(responseState.world.grid, cellX(responseShelterCenter), cellY(responseShelterCenter), responseShelterZ + 2, Material.Stone);
  setVoxel(responseState.world.grid, cellX(responseSpareCell), cellY(responseSpareCell), responseShelterZ + 2, Material.Stone);
  const responseSpareWalls = responseSpareNeighbors.filter((cell) => cell !== responseShelterCenter);
  for (const wallCell of responseSpareWalls) {
    setVoxel(responseState.world.grid, cellX(wallCell), cellY(wallCell), responseShelterZ, Material.Stone);
  }
  responseState.derived.structures.push({
    id: 'response-family-ready-shelter',
    materialIds: [Material.Stone],
    occupiedCells: [responseShelterCenter, responseSpareCell, ...responseSpareWalls],
    interiorPositions: [
      { cellId: responseShelterCenter, z: responseShelterZ },
      { cellId: responseSpareCell, z: responseShelterZ },
    ],
    complete: true,
    capacity: 2,
    sourceEventIds: [founding.id],
  });
  responseContext = buildDecisionContexts(responseState, 6).find((candidate) => candidate.person.id === responseMale.id);
  acceptResponse = responseContext?.options.find((option) => option.id.startsWith('accept-reproduce:'));
  rejectResponse = responseContext?.options.find((option) => option.id.startsWith('reject-reproduce:'));
  assert.ok(responseContext && acceptResponse && rejectResponse);
  const readyHighRelationAccept = evaluateDecisionOption(
    responseContext,
    acceptResponse,
    { atMonth: 6, planningTick: 1 },
  );
  assert.ok(readyHighRelationAccept.causalScore > unreadyHighRelationAccept.causalScore,
    '真实食水、可见空余住所和照护余量成立后，同一人物接受生殖的倾向必须连续上升');
  assert.ok((readyHighRelationAccept.votes.find((vote) => vote.tree === 'need')?.score ?? 0) > 0,
    '准备充分的接受候选必须由非零 generativity 需要激活，而不是只靠关系分');

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
  const fullTickAttemptState = structuredClone(state);
  fullTickAttemptState.clock.elapsedMonths = 1;
  fullTickAttemptState.world.past = fullTickAttemptState.world.past.filter((event) => event.atMonth <= 1);
  fullTickAttemptState.intents = [];
  for (const [index, actorId] of [female.id, male.id].entries()) {
    const actor = fullTickAttemptState.people.find((person) => person.id === actorId);
    const partnerId = actorId === female.id ? male.id : female.id;
    const intentId = `test-pair-reproduction-intent:${index}`;
    fullTickAttemptState.intents.push({
      id: intentId, ownerId: actorId, summary: '在同一协议窗口内进行一次生殖尝试', domain: 'social',
      goal: { kind: 'condition', personId: female.id, condition: 'pregnancy', present: true },
      nextAction: { kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: partnerId }], authorizationRef: agreementId },
      target: { kind: 'person', personId: partnerId }, status: 'active', createdAtMonth: 1, lastProgressAtMonth: 1,
      progress: 0, sourceDecisionEventId: `test-pair-reproduction-decision:${index}`, agreementId,
      sourceFactIds: [...fullTickAttemptState.agreements[0].sourceEventIds], actionEventIds: [], replanCount: 0,
    });
    actor.activeIntentId = intentId;
  }
  const idlePlanner = { decide: () => ({ kind: 'idle', reason: '保留双方已经编译的生殖意图' }) };
  const afterFullTickAttempt = stepSimulation(fullTickAttemptState, idlePlanner);
  const firstMonthPairActions = afterFullTickAttempt.lastStep.filter((event) => event.kind === 'action'
    && event.atMonth === 2
    && event.action.kind === 'act'
    && event.action.operation === 'reproduce');
  assert.equal(firstMonthPairActions.length, 1,
    '一个真实 stepSimulation 的 15 个规划刻度内，同一人物对只能产生一条 reproduce ActionFact，不能再产生 attemptedThisMonth blocked 动作');
  assert.equal(firstMonthPairActions[0]?.status, 'completed');
  assert.equal(firstMonthPairActions[0]?.diff.conceived, false, '固定夹具必须保留未受孕窗口以验证次月重试');
  const mirrorIntent = afterFullTickAttempt.intents.find((intent) => intent.id.startsWith('test-pair-reproduction-intent:')
    && intent.actionEventIds.length === 0);
  const actingIntent = afterFullTickAttempt.intents.find((intent) => intent.id.startsWith('test-pair-reproduction-intent:')
    && intent.actionEventIds.length === 1);
  assert.equal(actingIntent?.goalOutcome?.kind, 'attempted-unmet',
    '实际执行者的未受孕尝试应结算为动作完成、妊娠目标未达成');
  assert.deepEqual(actingIntent?.goalOutcome?.sourceEventIds, [firstMonthPairActions[0].id]);
  assert.equal(mirrorIntent?.status, 'completed',
    '另一方已编译的同月镜像意图应无动作完成本月评估，而不是因为 pair 已尝试被永久 blocked');
  assert.equal(mirrorIntent?.blockedReason, undefined);
  assert.equal(mirrorIntent?.goalOutcome?.kind, 'attempted-unmet',
    '镜像方也应引用真实尝试结算未达成，而不是留下无来源的 completed');
  assert.ok(mirrorIntent?.goalOutcome?.sourceEventIds.includes(firstMonthPairActions[0].id));
  const retryMonthContext = buildDecisionContexts(afterFullTickAttempt, 3)
    .find((candidate) => candidate.options.some((option) => option.id.startsWith('reproduce:')));
  const nextMonthOption = retryMonthContext?.options.find((option) => option.id.startsWith('reproduce:'));
  assert.ok(retryMonthContext && nextMonthOption, '未受孕后的下一自然月必须重新暴露合法的生殖尝试候选');
  const nextMonthIntentId = 'test-next-month-pair-reproduction-intent';
  afterFullTickAttempt.intents.push({
    id: nextMonthIntentId, ownerId: retryMonthContext.person.id, summary: nextMonthOption.summary,
    domain: nextMonthOption.domain ?? 'social', goal: structuredClone(nextMonthOption.goal),
    nextAction: structuredClone(nextMonthOption.nextAction), target: structuredClone(nextMonthOption.target),
    status: 'active', createdAtMonth: 2, lastProgressAtMonth: 2, progress: 0,
    sourceDecisionEventId: 'test-next-month-pair-reproduction-decision', agreementId,
    sourceFactIds: [...nextMonthOption.sourceFactIds], actionEventIds: [], replanCount: 0,
  });
  retryMonthContext.person.activeIntentId = nextMonthIntentId;
  const afterNextMonthAttempt = stepSimulation(afterFullTickAttempt, idlePlanner);
  const nextMonthPairActions = afterNextMonthAttempt.lastStep.filter((event) => event.kind === 'action'
    && event.atMonth === 3
    && event.action.kind === 'act'
    && event.action.operation === 'reproduce');
  assert.equal(nextMonthPairActions.length, 1, '未受孕后的下一自然月必须能在同一有效窗口内重新进行一次合法尝试');
  assert.equal(nextMonthPairActions[0]?.status, 'completed');

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
  Object.assign(conflictMale.relations.find((relation) => relation.personId === conflictFemale.id), { trust: 5, bond: 10, fear: 70 });
  const conflictContext = buildDecisionContexts(conflictState).find((candidate) => candidate.person.id === conflictMale.id);
  const conflictProceed = conflictContext?.options.find((option) => option.id.startsWith('reproduce:'));
  const conflictWithdraw = conflictContext?.options.find((option) => option.id.startsWith('withdraw-reproduce:'));
  assert.ok(conflictContext && conflictProceed && conflictWithdraw, '关系恶化后系统仍须同时提供继续与撤回，让当事人重新判断');
  assert.ok(
    evaluateDecisionOption(conflictContext, conflictWithdraw, { atMonth: 2, planningTick: 2 }).causalScore
      > evaluateDecisionOption(conflictContext, conflictProceed, { atMonth: 2, planningTick: 2 }).causalScore,
    '伤害、低信任和高恐惧应让受害者倾向撤回，而不是让固定分数线替人物撤回',
  );
  const validAgreementAttemptAfterConflict = executePrimitiveAction(conflictState, conflictMale, {
    kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: conflictFemale.id }], authorizationRef: agreementId,
  }, 2, 1, { cause: 'intent', actionTick: 2 });
  assert.equal(validAgreementAttemptAfterConflict.status, 'completed', '若人物仍明确选择继续，领域层只验证有效双方协议和身体边界，不再追加关系分数否决');

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
  assert.ok(highRelationMale.relations.find((relation) => relation.personId === highRelationFemale.id).trust >= 60, '夹具中的高关系在一次伤害后仍保持较高，可用于检查连续偏好');
  assert.equal(advanceSharedRelationshipExperience(highRelationConflictState, [...sharedActionTicks(2, 5), highRelationAttack], 2).length, 0, '即使关系仍高，发生伤害的双方当月也不获得额外共同活动加成');
  const highRelationConflictContext = buildDecisionContexts(highRelationConflictState).find((candidate) => candidate.person.id === highRelationFemale.id);
  assert.ok(highRelationConflictContext?.options.some((option) => option.id.startsWith('reproduce:')), '伤害后有效协议的继续选项仍由人物自行评估');
  const highRelationAttempt = executePrimitiveAction(highRelationConflictState, highRelationFemale, reproduceAction, 2, 1, { cause: 'intent', actionTick: 2 });
  assert.equal(highRelationAttempt.status, 'completed');

  const attemptStateA = structuredClone(state);
  const attemptStateB = structuredClone(state);
  const attemptA = executePrimitiveAction(attemptStateA, attemptStateA.people.find((person) => person.id === female.id), reproduceAction, 2, 0, { cause: 'intent', actionTick: 1 });
  const attemptB = executePrimitiveAction(attemptStateB, attemptStateB.people.find((person) => person.id === female.id), reproduceAction, 2, 1, { cause: 'intent', actionTick: 2 });
  assert.equal(attemptA.status, 'completed');
  assert.equal(attemptB.status, 'completed');
  assert.equal(attemptA.diff.agreementId, agreementId, '每次生殖尝试必须记录实际授权协议');
  assert.equal(attemptA.diff.relationshipSnapshot.length, 2, '每次尝试必须保留双方当时关系快照，供回放验证个人判断而非分数门禁');
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

  let achievedExecution;
  for (let order = 0; order < 40 && !achievedExecution; order += 1) {
    const candidate = structuredClone(state);
    candidate.clock.elapsedMonths = 1;
    const candidateFemale = candidate.people.find((person) => person.id === female.id);
    const candidateMale = candidate.people.find((person) => person.id === male.id);
    const candidateIntent = {
      id: `test-integrated-conception-intent:${order}`,
      ownerId: candidateFemale.id,
      summary: '验证真实受孕目标结算',
      domain: 'social',
      goal: { kind: 'condition', personId: candidateFemale.id, condition: 'pregnancy', present: true },
      nextAction: { kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: candidateMale.id }], authorizationRef: agreementId },
      target: { kind: 'person', personId: candidateMale.id },
      status: 'active', createdAtMonth: 1, lastProgressAtMonth: 1, progress: 0,
      sourceDecisionEventId: `test-integrated-conception-decision:${order}`,
      agreementId, sourceFactIds: [...candidate.agreements[0].sourceEventIds], actionEventIds: [], replanCount: 0,
    };
    candidate.intents = [candidateIntent];
    candidateFemale.activeIntentId = candidateIntent.id;
    delete candidateMale.activeIntentId;
    const fact = executeActiveIntent(candidate, candidateFemale, 2, order, (order % 15) + 1, []);
    if (fact?.kind === 'action' && fact.diff.conceived === true) achievedExecution = {
      state: candidate,
      fact,
      actorIntent: candidateIntent,
      partner: candidateMale,
    };
  }
  assert.ok(achievedExecution, '固定搜索窗口应找到一个可回放的真实受孕动作');
  assert.equal(achievedExecution.actorIntent.goalOutcome?.kind, 'achieved');
  assert.deepEqual(achievedExecution.actorIntent.goalOutcome?.sourceEventIds, [achievedExecution.fact.id]);
  const fulfilledMirrorIntent = {
    id: 'test-integrated-conception-mirror',
    ownerId: achievedExecution.partner.id,
    summary: '验证 fulfilled 协议的镜像目标结算',
    domain: 'social',
    goal: structuredClone(achievedExecution.actorIntent.goal),
    nextAction: { kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: female.id }], authorizationRef: agreementId },
    target: { kind: 'person', personId: female.id },
    status: 'active', createdAtMonth: 2, lastProgressAtMonth: 2, progress: 0,
    sourceDecisionEventId: 'test-integrated-conception-mirror-decision',
    agreementId, sourceFactIds: [...achievedExecution.state.agreements[0].sourceEventIds], actionEventIds: [], replanCount: 0,
  };
  achievedExecution.state.intents.push(fulfilledMirrorIntent);
  achievedExecution.partner.activeIntentId = fulfilledMirrorIntent.id;
  const mirrorFact = executeActiveIntent(
    achievedExecution.state,
    achievedExecution.partner,
    2,
    41,
    15,
    [achievedExecution.fact],
  );
  assert.equal(mirrorFact, null, 'fulfilled 镜像应从协议终态结算，不再制造第二条生殖动作');
  assert.equal(fulfilledMirrorIntent.goalOutcome?.kind, 'achieved');
  assert.ok(fulfilledMirrorIntent.goalOutcome?.sourceEventIds.includes(achievedExecution.fact.id));

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
  const birthWitness = structuredClone(birthState.people.find((person) => person.id === male.id));
  birthWitness.id = 'birth-local-witness';
  birthWitness.name = '在场照护者';
  birthWitness.geneticParents = [];
  birthWitness.conditions = [];
  birthWitness.relations = [];
  delete birthWitness.activeIntentId;
  birthWitness.position = structuredClone(birthMother.position);
  const lateVisitor = structuredClone(birthWitness);
  lateVisitor.id = 'birth-late-visitor';
  lateVisitor.name = '后来到访者';
  lateVisitor.position.cellId = birthMother.position.cellId === 0 ? 1 : 0;
  lateVisitor.position.previousCellId = lateVisitor.position.cellId;
  birthState.people.push(birthWitness, lateVisitor);
  const expectedInitialTrustPersonIds = birthState.people
    .filter((person) => person.diedAtMonth === undefined
      && person.position.cellId === birthMother.position.cellId
      && person.position.z === birthMother.position.z)
    .map((person) => person.id)
    .sort();
  birthMother.conditions = [{
    id: 'test-birth-pregnancy', kind: 'pregnancy', stage: 3, sinceMonth: 0, dueAtMonth: 1,
    otherPersonId: male.id, sourceEventIds: [],
  }];
  birthState.civilization.externalClimate = { epoch: 'stable', kind: 'temperate', severity: 0 };
  for (const person of birthState.people) person.body = { health: 100, hydration: 100, nutrition: 100 };
  const afterBirth = stepSimulation(birthState, { decide: () => ({ kind: 'idle', reason: '只检查出生关系' }) });
  const child = afterBirth.people.find((person) => person.bornAtMonth === 1);
  assert.ok(child, '到期妊娠应产生新生儿');
  const birthFact = afterBirth.world.past.find((event) => event.kind === 'environment' && event.diff.bornPersonId === child.id);
  assert.ok(birthFact, '出生必须留下可解析的新生儿社会先验来源');
  const postpartum = afterBirth.people.find((person) => person.id === female.id).conditions.find((condition) => condition.kind === 'postpartum-recovery');
  assert.ok(postpartum?.endsAtMonth > afterBirth.clock.elapsedMonths, '分娩后应留下有明确结束月份的产后恢复状态');
  const postpartumContext = buildDecisionContexts(afterBirth).find((candidate) => candidate.person.id === female.id);
  assert.equal(postpartumContext?.options.some((option) => option.id.startsWith('offer-reproduce:')), false, '产后恢复期间不得开始下一次生殖提议');
  assert.ok(child.relations.every((relation) => !relation.sourceEventIds.includes(founding.id)), '新生儿不得继承先民共同抵达来源');
  const expectedInitialTrust = newbornInitialTrust(child);
  assert.ok(expectedInitialTrust >= 3 && expectedInitialTrust <= 9 && expectedInitialTrust < 20, '性格先验必须保持微弱，并低于结伴门槛');
  assert.equal(birthFact.diff.initialSocialTrust, expectedInitialTrust);
  assert.deepEqual(birthFact.diff.initialSocialTrustPersonIds, expectedInitialTrustPersonIds, '出生事实必须精确记录当时存活且同格的信任目标');
  const witnessRelation = child.relations.find((relation) => relation.personId === birthWitness.id);
  assert.equal(witnessRelation?.trust, expectedInitialTrust, '新生儿应按自身性格对出生时真实在场者形成微弱初始信任');
  assert.equal(witnessRelation?.bond, 0, '性格先验不能凭空创造亲密羁绊');
  assert.deepEqual(witnessRelation?.sourceEventIds, [birthFact.id], '初始信任必须只引用真实出生事实');
  const witnessToChild = afterBirth.people.find((person) => person.id === birthWitness.id)
    .relations.find((relation) => relation.personId === child.id);
  assert.equal(witnessToChild?.trust, 0, '初始信任只能从新生儿指向在场者，不能伪造双向关系');
  const lateRelation = child.relations.find((relation) => relation.personId === lateVisitor.id);
  assert.deepEqual(lateRelation, { personId: lateVisitor.id, trust: 0, bond: 0, fear: 0, sourceEventIds: [] }, '出生时不在场的陌生人不能获得初始关系');

  const laterArrivalState = structuredClone(afterBirth);
  const laterChild = laterArrivalState.people.find((person) => person.id === child.id);
  const laterVisitor = laterArrivalState.people.find((person) => person.id === lateVisitor.id);
  laterVisitor.position = structuredClone(laterChild.position);
  const afterLaterArrival = stepSimulation(laterArrivalState, { decide: () => ({ kind: 'idle', reason: '检查后来到场者' }) });
  assert.deepEqual(
    afterLaterArrival.people.find((person) => person.id === child.id).relations.find((relation) => relation.personId === lateVisitor.id),
    { personId: lateVisitor.id, trust: 0, bond: 0, fear: 0, sourceEventIds: [] },
    '陌生人后来同格不会追授出生时人格先验',
  );

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
    let monthTwentyConsentScore;
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
        const monthTwentyOffer = monthTwenty?.options.find((option) => option.id.startsWith('offer-reproduce:'));
        assert.ok(monthTwenty && monthTwentyOffer, `seed ${seed} 有共同经历后应能自行判断是否提出生殖`);
        monthTwentyConsentScore = evaluateDecisionOption(monthTwenty, monthTwentyOffer, { atMonth: month, planningTick: 1 })
          .votes.find((vote) => vote.tree === 'consent')?.score;
      }
    }
    const monthSixty = buildDecisionContexts(relationshipState).find((candidate) => candidate.person.id === first.id);
    const monthSixtyOffer = monthSixty?.options.find((option) => option.id.startsWith('offer-reproduce:'));
    const monthSixtyConsentScore = monthSixty && monthSixtyOffer
      ? evaluateDecisionOption(monthSixty, monthSixtyOffer, { atMonth: 60, planningTick: 1 })
        .votes.find((vote) => vote.tree === 'consent')?.score
      : undefined;
    assert.ok(monthSixtyOffer && monthSixtyConsentScore > monthTwentyConsentScore,
      `seed ${seed} 的长期共同生活应连续提高生殖提议倾向，而不是跨过固定门槛`);
  }

  console.log('reproduction opportunity tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
