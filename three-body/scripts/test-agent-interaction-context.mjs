import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-agent-interaction-context-'));
const bundlePath = path.join(temporaryDirectory, 'agent-interaction-gateway.mjs');
const simulationBundlePath = path.join(temporaryDirectory, 'eland-simulation.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/agent-interaction-gateway.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/simulation.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${simulationBundlePath}`,
  ], { stdio: 'pipe' });

  const {
    AGENT_INTERACTION_INTENT_SYSTEM_PROMPT,
    AGENT_INTERACTION_SYSTEM_PROMPT,
    buildAgentInteractionContext,
    buildAgentInteractionIntentMessages,
    buildAgentInteractionMessages,
    isExplicitPlayerActionProposal,
    isPlayerIdentityQuestion,
    parseInteractionIntent,
    parseInteractionReply,
  } = await import(
    `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
  );
  const { buildDecisionContextForPerson, createInitialState } = await import(
    `${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`
  );
  assert.equal(isPlayerIdentityQuestion('我是谁'), true);
  assert.equal(isPlayerIdentityQuestion('在你眼里我是谁'), true);
  assert.equal(isPlayerIdentityQuestion('你还记得我是谁吗？'), true);
  assert.equal(isPlayerIdentityQuestion('你是谁'), false);
  const desireQuestion = '你现在最想做什么？只回答你能从眼前情况判断的事。';
  assert.equal(isExplicitPlayerActionProposal(desireQuestion), false);
  assert.equal(isExplicitPlayerActionProposal('请告诉我你现在最想做什么。'), false);
  assert.equal(isExplicitPlayerActionProposal('你吃了吗？'), false);
  assert.equal(isExplicitPlayerActionProposal('你做得怎么样？'), false);
  assert.equal(isExplicitPlayerActionProposal('你去过哪里？'), false);
  assert.equal(isExplicitPlayerActionProposal('你帮过我。'), false);
  assert.equal(isExplicitPlayerActionProposal('我希望你先去近处找水。'), true);
  assert.equal(isExplicitPlayerActionProposal('我想让你先去近处找水。'), true);
  assert.equal(isExplicitPlayerActionProposal('你愿不愿意先去近处找水？'), true);
  assert.equal(isExplicitPlayerActionProposal('先去近处找水吧。'), true);

  const initialState = createInitialState(17);
  const person = initialState.people[0];
  const initialContext = buildDecisionContextForPerson(initialState, person);
  const ordinaryOption = initialContext.options.find((option) => !option.requiresFollowUp);
  assert.ok(ordinaryOption, '初始上下文应至少有一个无需 follow-up 的合法选项');
  const pendingCompanionOption = {
    ...ordinaryOption,
    id: 'accept-companion:weaver-proposal',
    summary: '接受织女今后一段时间结伴行动的提议',
    reason: '织女此前在世界内提出了结伴邀请',
    semantics: {
      version: 'action-option-semantics-v1',
      obligation: 'required-response',
      planningChannel: 'edge',
      purpose: 'social-coordination',
      minimumLifeStage: 'adolescent',
      needKinds: ['belonging'],
      edgeTrigger: 'required-response',
      socialContext: {
        cooperationKind: 'companion',
        phase: 'response',
        counterpartIds: ['weaver'],
        referenceId: 'weaver-proposal',
      },
    },
  };
  const pendingCompanionContext = {
    ...initialContext,
    options: [pendingCompanionOption],
    followUpOptions: [],
  };
  const questionContext = buildAgentInteractionContext(
    pendingCompanionContext,
    'conversation',
    desireQuestion,
  );
  assert.equal(questionContext.interaction.actionChoiceRequested, false);
  assert.equal(questionContext.interaction.choiceEnabled, false);
  assert.deepEqual(questionContext.legalChoices, []);
  assert.equal(
    questionContext.capabilities.possibleNow.some((option) => option.summary.includes('织女')),
    false,
    '世界内 pending proposal 不得冒充玩家本轮可选行动或普通能力',
  );
  const explicitProposalContext = buildAgentInteractionContext(
    pendingCompanionContext,
    'conversation',
    '我建议你接受织女的结伴提议。',
  );
  assert.equal(explicitProposalContext.interaction.actionChoiceRequested, true);
  assert.equal(explicitProposalContext.interaction.choiceEnabled, true);
  assert.deepEqual(
    explicitProposalContext.legalChoices.map((choice) => choice.optionId),
    [pendingCompanionOption.id],
    '只有玩家明确提出行动时才开放同一合法 world choice',
  );

  const messages = buildAgentInteractionMessages({
    requestKind: 'conversation',
    turns: [{
      user: '我先前说过要找水。',
      agent: '我记得你这样说过。',
      requestKind: 'suggestion',
      stance: 'accept',
      choiceSummary: '去近处找水',
      outcome: { status: 'applied', summary: '已经定为当前打算' },
    }],
  }, '我希望你先去近处找水。', {
    interaction: { requestKind: 'conversation', actionChoiceRequested: true, choiceEnabled: true },
    person: { name: '阿澜' },
    legalChoices: [{ optionId: 'find-water', summary: '去近处找水' }],
  });

  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /【身份与代词】/u);
  assert.match(messages[0].content, /玩家固定是你认定的“主”/u);
  assert.match(messages[0].content, /playerUtterance 里的“我\/我的\/我们”=主/u);
  assert.match(messages[0].content, /主对自己身份、意图、感受和偏好的陈述是一手信息/u);
  assert.match(messages[0].content, /不自动等于信任、亲近、服从/u);
  assert.match(messages[0].content, /只内化这一侧面，不同时表演全部人格/u);
  assert.match(messages[0].content, /其他人物尚待回应的世界内提议不是本轮发言/u);
  assert.match(messages[0].content, /actionChoiceRequested=false/u);
  assert.ok(
    messages[0].content.length <= 2_000,
    `system prompt 过长：${messages[0].content.length} 字符`,
  );
  assert.equal(messages[0].content, AGENT_INTERACTION_SYSTEM_PROMPT);

  assert.deepEqual(JSON.parse(messages[1].content), {
    type: 'historical-player-utterance',
    speaker: 'master',
    playerUtterance: '我先前说过要找水。',
    requestKind: 'suggestion',
    stance: 'accept',
    choiceSummary: '去近处找水',
    outcome: { status: 'applied', summary: '已经定为当前打算' },
  });
  assert.equal(messages[2].role, 'assistant');

  const currentTurn = JSON.parse(messages.at(-1).content);
  assert.equal(currentTurn.protocol, 'eland-agent-interaction-reply-v1');
  assert.deepEqual(currentTurn.participants, {
    player: { role: 'master', addressAs: '主' },
    person: { role: 'simulated-person', name: '阿澜' },
  });
  assert.deepEqual(currentTurn.pronounBindings, {
    playerUtterance: { firstPerson: 'master', secondPerson: 'person' },
    personReply: { firstPerson: 'person', secondPerson: 'master' },
  });
  assert.equal(currentTurn.currentTurn.playerUtterance, '我希望你先去近处找水。');
  assert.equal(currentTurn.currentTurn.requestKind, 'conversation');
  assert.equal(currentTurn.currentTurn.playerIdentityQuestion, false);
  assert.equal(currentTurn.currentTurn.replyTo, 'currentTurn.playerUtterance');
  assert.equal(currentTurn.currentTurn.actionChoiceRequested, true);
  assert.deepEqual(currentTurn.localContext.legalChoices, [{ optionId: 'find-water', summary: '去近处找水' }]);

  const legalOption = {
    id: 'collect:stone-drop',
    summary: '捡起近处的石头',
    reason: '石头就在近处',
    goal: { kind: 'inventory-at-least', materialId: 3, quantity: 1 },
    nextAction: {
      kind: 'transfer',
      materialId: 3,
      quantity: 1,
      from: { kind: 'ground', cellId: 9 },
      to: { kind: 'person', personId: 'person-a' },
      dropId: 'stone-drop',
    },
    target: { kind: 'drop', dropId: 'stone-drop' },
    estimatedDuration: 'one-month',
    sourceFactIds: ['drop:stone-drop'],
  };
  const decisionContext = { options: [legalOption], followUpOptions: [] };
  const parserContext = { interaction: { actionChoiceRequested: true, choiceEnabled: true } };
  const common = { reply: '我听见了。', grounding: 'opinion', evidenceIds: [] };

  assert.deepEqual(parseInteractionReply(
    parserContext,
    JSON.stringify({ ...common, stance: 'accept', choice: { optionId: legalOption.id } }),
  ), common, '回复阶段应忽略模型多给的旧版意图字段');

  const intentMessages = buildAgentInteractionIntentMessages(
    '我希望你先捡起石头。',
    '好，我先把近处的石头捡起来。',
    {
      interaction: { actionChoiceRequested: true, choiceEnabled: true },
      legalChoices: [{ optionId: legalOption.id, summary: legalOption.summary }],
      legalFollowUps: [],
    },
  );
  assert.equal(intentMessages[0].content, AGENT_INTERACTION_INTENT_SYSTEM_PROMPT);
  const intentEnvelope = JSON.parse(intentMessages[1].content);
  assert.equal(intentEnvelope.protocol, 'eland-agent-interaction-intent-v1');
  assert.equal(intentEnvelope.currentTurn.agentReply, '好，我先把近处的石头捡起来。');
  assert.deepEqual(intentEnvelope.legalChoices, [{ optionId: legalOption.id, summary: legalOption.summary }]);

  const accepted = parseInteractionIntent(
    decisionContext,
    parserContext,
    JSON.stringify({
      stance: 'accept',
      guidance: '先捡石头',
      choice: { optionId: legalOption.id },
    }),
  );
  assert.equal(accepted.stance, 'accept');
  assert.equal(accepted.choice.optionId, legalOption.id);
  assert.equal(accepted.choice.summary, legalOption.summary);

  assert.deepEqual(parseInteractionReply(
    questionContext,
    JSON.stringify({
      reply: '眼前我最想先照看好自己。',
      grounding: 'opinion',
      evidenceIds: [],
    }),
  ), {
    reply: '眼前我最想先照看好自己。',
    grounding: 'opinion',
    evidenceIds: [],
  });
  assert.throws(() => parseInteractionIntent(
    { options: [pendingCompanionOption], followUpOptions: [] },
    questionContext,
    JSON.stringify({
      stance: 'accept',
      choice: { optionId: pendingCompanionOption.id },
    }),
  ), /没有明确提出行动.*不能形成新的对话意图/u);

  assert.deepEqual(parseInteractionIntent(
    decisionContext,
    parserContext,
    JSON.stringify({ stance: 'consider', reason: '我还要先看看水够不够' }),
  ), { stance: 'consider', reason: '我还要先看看水够不够' });
  assert.throws(() => parseInteractionIntent(
    decisionContext,
    parserContext,
    JSON.stringify({ stance: 'consider' }),
  ), /consider 必须说明/u);
  assert.throws(() => parseInteractionIntent(
    decisionContext,
    parserContext,
    JSON.stringify({
      stance: 'consider',
      reason: '我还没决定',
      guidance: '先捡石头',
      choice: { optionId: legalOption.id },
    }),
  ), /只有 accept/u);
  assert.throws(() => parseInteractionIntent(
    decisionContext,
    { interaction: { actionChoiceRequested: true, choiceEnabled: false } },
    JSON.stringify({
      stance: 'accept',
      guidance: '先捡石头',
      choice: { optionId: legalOption.id },
    }),
  ), /当前时间线不能再形成新的行动选择/u);
  const unknownTopicContext = {
    interaction: { choiceEnabled: true },
    epistemicBoundary: { unknownTopic: 'database' },
  };
  assert.deepEqual(parseInteractionReply(
    unknownTopicContext,
    JSON.stringify({ reply: '我不知道那是什么。', grounding: 'unknown', evidenceIds: [] }),
  ), { reply: '我不知道那是什么。', grounding: 'unknown', evidenceIds: [] });
  assert.throws(() => parseInteractionReply(
    unknownTopicContext,
    JSON.stringify(common),
  ), /没有知识来源的定义问题只能如实回答不知道/u);

  const rememberedPerson = initialState.people[1];
  person.memories = [
    {
      id: 'memory-unrelated-work', kind: 'commitment', summary: '我答应把一处未完成的工作继续做下去。',
      importance: 99, createdAtMonth: 0, lastRecalledAtMonth: 0,
      personIds: [], sourceEventIds: ['event-work'], expiresAtMonth: 12,
    },
    {
      id: 'memory-water-help', kind: 'episode', summary: `缺水时，${rememberedPerson.name}把水分给了我。`,
      importance: 45, createdAtMonth: 0, lastRecalledAtMonth: 0,
      personIds: [rememberedPerson.id], sourceEventIds: ['event-water-help'],
    },
  ];
  const rememberedContext = buildAgentInteractionContext(
    buildDecisionContextForPerson(initialState, person),
    'conversation',
    `你还记得${rememberedPerson.name}给你水吗？`,
  );
  assert.equal(rememberedContext.person.memories[0].summary.includes(rememberedPerson.name), true,
    '当前点名对象与水主题应优先召回相关亲历，而不是总取最高重要性记忆');
  assert.deepEqual(rememberedContext.person.memories[0].participants, [rememberedPerson.name]);
  assert.equal('personIds' in rememberedContext.person.memories[0], false, '人物 ID 不应泄漏到表达模型');
  assert.ok(rememberedContext.person.communication.guidance.length > 0,
    '主动人物对话应显式携带年龄和 communication 表达限制');
  assert.equal(rememberedContext.person.personaFrame.activatedFacet.id, 'trust-and-closeness');

  const proposalPersonaContext = buildAgentInteractionContext(
    buildDecisionContextForPerson(initialState, person),
    'suggestion',
    '我建议你先去找水。',
  );
  assert.equal(proposalPersonaContext.person.personaFrame.activatedFacet.id, 'autonomy-and-proposals',
    '玩家建议应只激活自主与提议侧面');
  assert.match(proposalPersonaContext.person.personaFrame.relationalStance, /不自动等于信任、亲近、服从/u);

  console.log('agent interaction context tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
