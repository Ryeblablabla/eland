import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-model-social-authority-'));
const semanticsBundlePath = path.join(temporaryDirectory, 'semantics.mjs');
const plannerBundlePath = path.join(temporaryDirectory, 'planner.mjs');
const backendBundlePath = path.join(temporaryDirectory, 'backend.mjs');
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');

const option = (id, nextAction, extra = {}) => ({
  id,
  summary: id,
  reason: id,
  goal: { kind: 'representation-made', representationId: `${id}:representation` },
  nextAction,
  estimatedDuration: 'one-month',
  estimatedMonths: 1,
  risks: [],
  domain: 'social',
  sourceFactIds: [],
  ...extra,
});

const talk = (speakerMeaning) => ({
  kind: 'talk',
  speakerMeaning,
});

try {
  for (const [entry, outfile] of [
    ['src/game/eland/domain/action-option-semantics.ts', semanticsBundlePath],
    ['src/game/eland/application/rule-planner.ts', plannerBundlePath],
    ['server/backend-decider.ts', backendBundlePath],
    ['src/game/eland/simulation.ts', simulationBundlePath],
  ]) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${outfile}`,
    ], { stdio: 'pipe' });
  }

  const { isModelOwnedVoluntarySocialOption } = await import(
    `${pathToFileURL(semanticsBundlePath).href}?test=${Date.now()}`
  );
  const { withoutModelOwnedVoluntarySocialOptions, withoutOpenConversationOptions } = await import(
    `${pathToFileURL(plannerBundlePath).href}?test=${Date.now()}`
  );
  const { createServerLlmDecider, isLiveModelDecisionContext } = await import(
    `${pathToFileURL(backendBundlePath).href}?test=${Date.now()}`
  );
  const { buildDecisionContexts, createInitialState, startIntent, stepSimulationAsync } = await import(
    `${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`
  );

  const opening = option('conversation-opening', talk({
    id: 'conversation-opening:representation',
    kind: 'claim',
    summary: '提起一段共同经历',
      conversation: {
        version: 'grounded-conversation-v1',
        basisKey: 'shared-event',
        topic: 'shared-work',
        turn: 'opening',
        sourceFactIds: ['shared-event'],
      },
  }));
  const openConversation = {
    ...option('open-conversation', talk({
      id: 'open-conversation:representation',
      kind: 'claim',
      summary: '与对方进行开放交谈',
      conversation: {
        version: 'grounded-conversation-v1',
        basisKey: 'open-conversation-basis',
        topic: 'open',
        turn: 'opening',
        sourceFactIds: ['shared-event'],
      },
    })),
    openConversationGrounding: {
      version: 'open-conversation-grounding-v1',
      fallbackSourceFactIds: ['shared-event'],
      facts: [{ kind: 'relationship', sourceFactId: 'shared-event', summary: '双方已有相识来源' }],
    },
  };
  const optionalReply = option('conversation-response', talk({
    id: 'conversation-response:representation',
    kind: 'claim',
    summary: '决定是否接话',
      conversation: {
        version: 'grounded-conversation-v1',
        basisKey: 'shared-event',
        topic: 'shared-work',
        turn: 'response',
        sourceFactIds: ['shared-event'],
      referenceEventId: 'opening-event',
    },
  }));
  const company = option('request-company', talk({
    id: 'request-company:representation',
    kind: 'request',
    summary: '问对方是否愿意陪伴',
    proposal: {
      kind: 'assist', requesterId: 'person', helperId: 'other', need: 'company', expiresAtMonth: 5,
    },
  }));
  const companion = option('offer-companion', talk({
    id: 'offer-companion:representation',
    kind: 'offer',
    summary: '提议持续共同生活',
    proposal: { kind: 'companion', proposerId: 'person', partnerId: 'other', expiresAtMonth: 6 },
  }));
  const reproduction = option('offer-reproduce', talk({
    id: 'offer-reproduce:representation',
    kind: 'offer',
    summary: '提议共同生育',
    proposal: { kind: 'reproduce', proposerId: 'person', partnerId: 'other', expiresAtMonth: 6 },
  }));
  const collective = option('offer-collective', talk({
    id: 'offer-collective:representation',
    kind: 'offer',
    summary: '提议组成共同体',
    proposal: { kind: 'collective', proposerId: 'person', partnerId: 'other', purposeSummary: '继续合作', expiresAtMonth: 6 },
  }));
  const ordinaryClaim = option('ordinary-claim', talk({
    id: 'ordinary-claim:representation', kind: 'claim', summary: '说出自己的观察',
  }));
  const prediction = option('ordinary-prediction', talk({
    id: 'ordinary-prediction:representation', kind: 'prediction',
    summary: '说出对下个纪元的判断',
    prediction: {
      version: 'era-prediction-v1', predictorId: 'person',
      predictedEpoch: 'chaotic', predictedByMonth: 3, basisFactIds: ['weather-fact'],
    },
  }));
  const projectDiscussion = option('project-knowledge-response', talk({
    id: 'project-knowledge-response:representation',
    kind: 'claim',
    summary: '告诉对方项目所需的做法',
    projectKnowledgeResponse: {
      version: 'project-knowledge-response-v1', requestEventId: 'request-event',
      projectId: 'project-a', requesterId: 'other', responderId: 'person',
      outputMaterialId: 1, sourceFactIds: ['knowledge-fact'],
    },
  }));
  const requiredReply = option('accept-company', talk({
    id: 'accept-company:representation', kind: 'accept', referenceId: 'company-proposal',
  }));
  const waterHelp = option('request-water', talk({
    id: 'request-water:representation',
    kind: 'request',
    summary: '请帮助找水',
    proposal: {
      kind: 'assist', requesterId: 'person', helperId: 'other', need: 'water', expiresAtMonth: 5,
    },
  }));
  const foodHelp = option('request-food', talk({
    id: 'request-food:representation',
    kind: 'request',
    summary: '请帮助取得食物',
    proposal: {
      kind: 'assist', requesterId: 'person', helperId: 'other', need: 'food', expiresAtMonth: 5,
    },
  }));
  const acceptedWaterDelivery = {
    ...option('deliver-accepted-water', {
      kind: 'transfer',
      materialId: 2,
      quantity: 1,
      from: { kind: 'person', personId: 'person' },
      to: { kind: 'person', personId: 'other' },
      authorizationRef: 'accepted-assist-agreement',
    }),
    goal: { kind: 'agreement-fulfilled', agreementId: 'accepted-assist-agreement' },
  };
  const physical = {
    ...option('move-to-water', { kind: 'move', toCellId: 2, toZ: 1 }),
    domain: 'survival',
    goal: { kind: 'at-cell', cellId: 2, z: 1 },
  };

  for (const candidate of [
    opening, openConversation, optionalReply, company, companion, reproduction, collective,
    ordinaryClaim, prediction, projectDiscussion,
  ]) {
    assert.equal(isModelOwnedVoluntarySocialOption(candidate), true, `${candidate.id} 应由模型拥有`);
  }
  for (const candidate of [requiredReply, waterHelp, foodHelp, acceptedWaterDelivery, physical]) {
    assert.equal(isModelOwnedVoluntarySocialOption(candidate), false, `${candidate.id} 必须保留本地规则路径`);
  }

  const context = {
    state: { world: { past: [] }, clock: { elapsedMonths: 0 } },
    person: { id: 'person' },
    visibleCells: [], visiblePeople: [], visibleDrops: [], visibleAnimals: [],
    options: [
      opening, openConversation, optionalReply, company, companion, reproduction, collective,
      ordinaryClaim, prediction, projectDiscussion,
      requiredReply, waterHelp, foodHelp, acceptedWaterDelivery, physical,
    ],
    followUpOptions: [companion, physical],
  };
  const fallbackContext = withoutModelOwnedVoluntarySocialOptions(context);
  assert.deepEqual(fallbackContext.options.map((candidate) => candidate.id), [
    'accept-company', 'request-water', 'request-food', 'deliver-accepted-water', 'move-to-water',
  ], '模型模式的本地 fallback 只能保留必须回应、紧急求生、已接受履约和物理行动');
  assert.deepEqual(fallbackContext.followUpOptions.map((candidate) => candidate.id), ['move-to-water']);
  assert.equal(context.options.length, 15, '过滤不得改写模型看到的完整候选');

  const localContext = withoutOpenConversationOptions(context);
  assert.equal(localContext.options.some((candidate) => candidate.id === openConversation.id), false,
    '纯本地 RulePlanner 必须忽略 open-conversation，避免与旧规则菜单重复竞争');
  assert.equal(localContext.options.some((candidate) => candidate.id === opening.id), true,
    '纯本地 RulePlanner 仍保留旧的有来源话题菜单');

  assert.equal(createServerLlmDecider(undefined).ownsVoluntarySocialChoices, false,
    '没有模型路由时必须保持纯规则模式');
  assert.equal(createServerLlmDecider('configured-endpoint').ownsVoluntarySocialChoices, true,
    '存在真实模型路由时，主观社会分叉归模型所有');

  const founderContext = {
    ...context,
    person: {
      id: 'founder', generation: 0,
      body: { health: 90, hydration: 90, nutrition: 90 },
      conditions: [], memories: [], knowledge: [],
    },
    options: [opening],
  };
  assert.equal(isLiveModelDecisionContext(founderContext, 1), true,
    '先民不应再被一刀切排除在模型主观审议之外');

  const initial = createInitialState(20260830, {
    endpoint: { kind: 'months', value: 2 },
    chaosIntensity: 0,
  });
  const founderCount = initial.people.filter((person) => person.generation === 0).length;
  const requestedBatches = [];
  const failedModelMonth = await stepSimulationAsync(initial, {
    ownsVoluntarySocialChoices: true,
    shouldDecide() { return true; },
    async decideAll(contexts) {
      requestedBatches.push(contexts.map((candidate) => candidate.person.id));
      return contexts.map(() => null);
    },
  });
  assert.equal(requestedBatches[0]?.length, founderCount,
    '每位开局先民应各自获得一次普通模型审议，且不得被记为豁免调用');
  assert.equal(failedModelMonth.decisionBudget.ledgers[0].ordinaryModelContexts, founderCount);
  assert.ok(failedModelMonth.decisionBudget.ledgers[0].exemptModelContexts >= 0);

  const isInventedVoluntarySocialAction = (event) => {
    if (event.kind !== 'action' || event.status !== 'completed' || event.action.kind !== 'talk') return false;
    const content = event.action.speakerMeaning;
    if (content.kind === 'accept' || content.kind === 'reject') return false;
    if ((content.kind === 'request' || content.kind === 'offer')
      && content.proposal?.kind === 'assist'
      && (content.proposal.need === 'water' || content.proposal.need === 'food')) return false;
    return true;
  };
  assert.equal(failedModelMonth.lastStep.some(isInventedVoluntarySocialAction), false,
    '模型返回 null 时，月初 fallback 与第 2–15 刻都不得偷偷发起主观社会行动');
  const foundersWhoActed = new Set(failedModelMonth.lastStep
    .filter((event) => event.kind === 'action')
    .map((event) => event.who));
  assert.ok(initial.people.filter((person) => person.generation === 0)
    .every((person) => foundersWhoActed.has(person.id)),
  '模型返回 null 只取消远程重选；每位无意图先民仍应采用月初预计算的保守本地计划并行动');
  assert.equal(failedModelMonth.lastStep.some((event) => event.kind === 'decision'
    && event.usedModel
    && event.decision.kind === 'idle'), false,
  'null 不是人物选择，不得写成模型作出的 idle DecisionFact');

  const invalidModelMonth = await stepSimulationAsync(createInitialState(20260830, {
    endpoint: { kind: 'months', value: 2 },
    chaosIntensity: 0,
  }), {
    ownsVoluntarySocialChoices: true,
    shouldDecide() { return true; },
    async decideAll(contexts) {
      return contexts.map(() => ({
        kind: 'start',
        optionId: 'not-a-current-world-option',
        reason: 'simulated invalid adapter output',
      }));
    },
  });
  assert.ok(invalidModelMonth.lastStep.some((event) => event.kind === 'action'),
    '模型返回非法候选时仍应执行预计算的本地计划');
  assert.equal(invalidModelMonth.lastStep.some((event) => event.kind === 'decision' && event.usedModel), false,
    '非法模型候选不得伪装成一次成功的模型决定');
  assert.equal(invalidModelMonth.lastStep.some(isInventedVoluntarySocialAction), false,
    '非法模型候选的回退不得替人物制造开放社会选择');

  const continuityState = createInitialState(20260831, {
    endpoint: { kind: 'months', value: 2 },
    chaosIntensity: 0,
  });
  const continuityContext = buildDecisionContexts(continuityState, 1)
    .find((context) => context.options.some((option) => option.nextAction.kind === 'move'));
  const continuityOption = continuityContext?.options.find((option) => option.nextAction.kind === 'move');
  const continuityPerson = continuityContext
    ? continuityState.people.find((person) => person.id === continuityContext.person.id)
    : undefined;
  const carriedIntent = continuityContext && continuityOption && continuityPerson
    ? startIntent(
        continuityState,
        continuityPerson,
        continuityContext,
        continuityOption.id,
        undefined,
        'fixture-existing-intent',
        1,
      )
    : null;
  assert.ok(carriedIntent, '夹具应能建立一个已有真实移动步骤的 active Intent');
  const timeoutMonth = await stepSimulationAsync(continuityState, {
    ownsVoluntarySocialChoices: true,
    shouldDecide() { return true; },
    forceReview(context) { return context.person.id === carriedIntent.ownerId; },
    async decideAll() { throw new Error('simulated model timeout'); },
  });
  const carriedAfterTimeout = timeoutMonth.intents.find((intent) => intent.id === carriedIntent.id);
  assert.ok(carriedAfterTimeout && carriedAfterTimeout.actionEventIds.length > 0,
    '模型超时不得吃掉已有 Intent 的执行月份；已有步骤仍应真实执行');
  assert.equal(timeoutMonth.lastStep.some((event) => event.kind === 'decision'
    && event.usedModel
    && event.decision.kind === 'idle'), false,
  '模型超时不得伪造人物自主 idle');

  const noBudgetState = structuredClone(failedModelMonth);
  noBudgetState.civilization.status = 'running';
  delete noBudgetState.civilization.outcome;
  noBudgetState.civilization.conditions.endpoint = { kind: 'months', value: 3 };
  for (const person of noBudgetState.people) delete person.activeIntentId;
  for (const intent of noBudgetState.intents) {
    if (intent.status === 'active') intent.status = 'abandoned';
  }
  noBudgetState.decisionBudget.credits = 0;
  noBudgetState.decisionBudget.ledgers = noBudgetState.decisionBudget.ledgers.map((ledger) => ({
    ...ledger,
    ordinaryModelContexts: 1_000,
    ordinaryChargedTokens: 1_000 * noBudgetState.decisionBudget.tokensPerContext,
  }));
  let noBudgetMonthOpeningCalls = 0;
  const noBudgetMonth = await stepSimulationAsync(noBudgetState, {
    ownsVoluntarySocialChoices: true,
    shouldDecide() { return true; },
    forceReview() { return true; },
    async decideAll(contexts) {
      noBudgetMonthOpeningCalls += contexts.filter((context) => context.planningTick === 1).length;
      return contexts.map(() => null);
    },
  });
  assert.equal(noBudgetMonthOpeningCalls, 0, '普通模型额度耗尽时不得再发月初远程反思请求');
  assert.ok(noBudgetMonth.lastStep.some((event) => event.kind === 'action'),
    '普通模型额度只限制远程反思，不能让无 Intent 人物失去本地规划与执行');
  assert.equal(noBudgetMonth.lastStep.some(isInventedVoluntarySocialAction), false,
    '额度不足时的本地保守计划不得代替模型发起开放社会行为');

  process.stdout.write('model-owned voluntary social authority tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
