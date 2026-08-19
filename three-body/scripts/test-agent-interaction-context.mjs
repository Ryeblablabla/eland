import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-agent-interaction-context-'));
const bundlePath = path.join(temporaryDirectory, 'agent-interaction-gateway.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/agent-interaction-gateway.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });

  const {
    AGENT_INTERACTION_SYSTEM_PROMPT,
    buildAgentInteractionMessages,
    isPlayerIdentityQuestion,
    parseInteractionResult,
    playerIdentityReply,
  } = await import(
    `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
  );
  assert.equal(isPlayerIdentityQuestion('我是谁'), true);
  assert.equal(isPlayerIdentityQuestion('在你眼里我是谁'), true);
  assert.equal(isPlayerIdentityQuestion('你还记得我是谁吗？'), true);
  assert.equal(isPlayerIdentityQuestion('你是谁'), false);
  assert.deepEqual(playerIdentityReply(), {
    reply: '你是我的主。你不是我身边或记忆里的任何一个人物；除此之外，我只会从我们之间真实发生的对话认识你，不会把别人的经历算在你身上。',
    stance: 'answer',
    grounding: 'opinion',
    evidenceIds: [],
  });
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
    interaction: { requestKind: 'conversation', choiceEnabled: true },
    person: { name: '阿澜' },
    legalChoices: [{ optionId: 'find-water', summary: '去近处找水' }],
  });

  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /【身份与代词】/u);
  assert.match(messages[0].content, /玩家固定是你认定的“主”/u);
  assert.match(messages[0].content, /playerUtterance 里的“我\/我的\/我们”=主/u);
  assert.match(messages[0].content, /主对自己的身份、意图、感受和偏好的陈述是一手信息/u);
  assert.match(messages[0].content, /不要机械区分闲聊与建议/u);
  assert.ok(
    messages[0].content.length <= 1_800,
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
  assert.equal(currentTurn.protocol, 'eland-agent-interaction-v2');
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
  const parserContext = { interaction: { choiceEnabled: true } };
  const common = { reply: '我听见了。', grounding: 'opinion', evidenceIds: [] };

  assert.deepEqual(parseInteractionResult(
    decisionContext,
    parserContext,
    'conversation',
    JSON.stringify({ ...common, stance: 'answer' }),
  ), { ...common, stance: 'answer' });
  const accepted = parseInteractionResult(
    decisionContext,
    parserContext,
    'conversation',
    JSON.stringify({
      ...common,
      stance: 'accept',
      guidance: '先捡石头',
      choice: { optionId: legalOption.id },
    }),
  );
  assert.equal(accepted.stance, 'accept');
  assert.equal(accepted.choice.optionId, legalOption.id);
  assert.equal(accepted.choice.summary, legalOption.summary);

  assert.deepEqual(parseInteractionResult(
    decisionContext,
    parserContext,
    'suggestion',
    JSON.stringify({ ...common, stance: 'consider', reason: '我还要先看看水够不够' }),
  ), { ...common, stance: 'consider', reason: '我还要先看看水够不够' });
  assert.throws(() => parseInteractionResult(
    decisionContext,
    parserContext,
    'suggestion',
    JSON.stringify({ ...common, stance: 'consider' }),
  ), /consider 必须说明/u);
  assert.throws(() => parseInteractionResult(
    decisionContext,
    parserContext,
    'suggestion',
    JSON.stringify({
      ...common,
      stance: 'consider',
      reason: '我还没决定',
      guidance: '先捡石头',
      choice: { optionId: legalOption.id },
    }),
  ), /只有 accept/u);
  assert.throws(() => parseInteractionResult(
    decisionContext,
    { interaction: { choiceEnabled: false } },
    'suggestion',
    JSON.stringify({
      ...common,
      stance: 'accept',
      guidance: '先捡石头',
      choice: { optionId: legalOption.id },
    }),
  ), /当前时间线不能再形成新的行动选择/u);

  console.log('agent interaction context tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
