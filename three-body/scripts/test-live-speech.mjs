import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-live-speech-test-'));
const projectionBundlePath = path.join(temporaryDirectory, 'live-speech-projection.mjs');
const serviceBundlePath = path.join(temporaryDirectory, 'live-speech-service.mjs');
const deciderBundlePath = path.join(temporaryDirectory, 'backend-decider.mjs');

try {
  for (const [entry, output] of [
    ['src/game/eland/projection/live-speech.ts', projectionBundlePath],
    ['server/live-speech-service.ts', serviceBundlePath],
    ['server/backend-decider.ts', deciderBundlePath],
  ]) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
    ], { stdio: 'pipe' });
  }

  const { projectLiveSpeechDrafts } = await import(`${pathToFileURL(projectionBundlePath).href}?test=${Date.now()}`);
  const {
    buildSpeechRequestItem,
    deriveRelationalSpeechFrame,
    normalizeSpeechResponse,
    realizeLiveSpeechLines,
    replySpeechLineFor,
    retainDecisionSpeechLines,
    speechLineMatchesAct,
  } = await import(`${pathToFileURL(serviceBundlePath).href}?test=${Date.now()}`);
  const { isLiveModelDecisionContext } = await import(`${pathToFileURL(deciderBundlePath).href}?test=${Date.now()}`);

  const fixedReplyContext = {
    person: {
      id: 'listener',
      generation: 1,
      body: { health: 80, hydration: 80, nutrition: 80 },
      conditions: [],
      memories: [], knowledge: [],
    },
    state: {
      world: { past: [{
        id: 'recent-model-review', kind: 'decision', atMonth: 7, who: 'listener', usedModel: true,
      }] },
    },
    options: [{
      id: 'respond-conversation:opening:listener', requiresFollowUp: false,
      goal: { kind: 'representation-made', representationId: 'response' },
      nextAction: {
        kind: 'communicate', audience: ['opening-speaker'], channel: 'voice',
        content: {
          id: 'response', kind: 'claim', summary: '回应开场',
          conversation: {
            version: 'grounded-conversation-v1', basisKey: 'opening', topic: 'care', turn: 'response',
            speakerId: 'listener', listenerId: 'opening-speaker', sourceFactIds: ['opening'],
            referenceEventId: 'opening',
          },
        },
      },
    }],
    followUpOptions: [],
  };
  assert.equal(isLiveModelDecisionContext(fixedReplyContext, 8), true,
    '普通对话回应是可选的主观社交选择，即使只有一条回应候选也应由模型决定是否接话');
  assert.equal(isLiveModelDecisionContext({
    ...fixedReplyContext,
    options: [
      {
        id: 'accept-assist:proposal', requiresFollowUp: false,
        goal: { kind: 'representation-made', representationId: 'accept-proposal' },
        nextAction: {
          kind: 'communicate', audience: ['proposer'], channel: 'voice',
          content: { id: 'accept-proposal', kind: 'accept', referenceId: 'proposal' },
        },
      },
      {
        id: 'reject-assist:proposal', requiresFollowUp: false,
        goal: { kind: 'representation-made', representationId: 'reject-proposal' },
        nextAction: {
          kind: 'communicate', audience: ['proposer'], channel: 'voice',
          content: { id: 'reject-proposal', kind: 'reject', referenceId: 'proposal' },
        },
      },
    ],
  }, 8), true, '接受与拒绝都合法时仍应让模型参与真实选择');

  const lifecycleReviewContext = {
    ...fixedReplyContext,
    options: [
      {
        id: 'work:first', requiresFollowUp: false,
        goal: { kind: 'location-reached', cellId: 1, z: 1 },
        nextAction: { kind: 'move', toCellId: 1, toZ: 1 },
      },
      {
        id: 'work:second', requiresFollowUp: false,
        goal: { kind: 'location-reached', cellId: 2, z: 1 },
        nextAction: { kind: 'move', toCellId: 2, toZ: 1 },
      },
    ],
    activeIntent: {
      id: 'intent-lifecycle-review',
      lastProgressAtMonth: 8,
      lifecycle: { completion: 'on-achievement', reviewAtMonth: 8 },
      stateGoalUntilMonth: 100,
    },
  };
  assert.equal(isLiveModelDecisionContext(lifecycleReviewContext, 9), true,
    '新 lifecycle.reviewAtMonth 必须触发到期复核，即使 legacy horizon 更晚');
  assert.equal(isLiveModelDecisionContext({
    ...lifecycleReviewContext,
    activeIntent: {
      ...lifecycleReviewContext.activeIntent,
      lifecycle: { completion: 'on-achievement', reviewAtMonth: 100 },
      stateGoalUntilMonth: 8,
    },
  }, 9), false, '存在 lifecycle 时不得让更早的 legacy stateGoalUntilMonth 覆盖它');
  assert.equal(isLiveModelDecisionContext({
    ...lifecycleReviewContext,
    activeIntent: {
      id: 'intent-legacy-review',
      lastProgressAtMonth: 8,
      stateGoalUntilMonth: 8,
    },
  }, 9), true, '没有 lifecycle 的旧意图仍须按 stateGoalUntilMonth 复核');

  const experience = {
    id: 'experience-care', kind: 'environment', change: 'body', atMonth: 7, orderInMonth: 1,
    cellId: 3, who: 'speaker', result: '缺水时，听者把自己的水分给了说话者', diff: { hydration: 18 },
  };
  const modelDecision = {
    id: 'decision-talk', kind: 'decision', atMonth: 8, orderInMonth: 1, cellId: 3,
    who: 'speaker', intentId: 'intent-talk', usedModel: true,
    decision: {
      kind: 'start', optionId: 'talk-about-water', reason: '想感谢亲历过的帮助',
      utterance: '你上次给我的水，我一直记着。',
    },
    result: '决定当面感谢听者',
  };
  const decisionVoice = {
    id: 'voice-decision', kind: 'action', atMonth: 8, orderInMonth: 2, actionTick: 1,
    cellId: 3, who: 'speaker', intentId: 'intent-talk', cause: 'intent',
    action: {
      kind: 'communicate', audience: ['listener'], channel: 'voice',
      content: {
        id: 'claim-water', kind: 'claim', summary: '上次我缺水时，你给了我水，我一直记着。',
        conversation: {
          topic: '上次缺水时得到帮助', turn: 'opening', stance: 'supportive',
          basisKey: 'care-water', sourceFactIds: ['experience-care'],
        },
      },
    },
    fromCellId: 3, toCellId: 3, fromZ: 1, toZ: 1, pathSegment: [],
    status: 'completed', result: '说话者向听者表达感谢', diff: {},
  };
  const ruleVoice = {
    id: 'voice-rule', kind: 'action', atMonth: 8, orderInMonth: 3, actionTick: 2,
    cellId: 3, who: 'speaker', cause: 'intent',
    action: {
      kind: 'communicate', audience: ['listener'], channel: 'voice',
      content: { id: 'claim-rule', kind: 'claim', summary: '地表土壤已经变干。' },
    },
    fromCellId: 3, toCellId: 3, fromZ: 1, toZ: 1, pathSegment: [],
    status: 'completed', result: '说话者陈述规则事实', diff: {},
  };
  const excludedEvents = [
    {
      ...ruleVoice, id: 'voice-blocked', orderInMonth: 4, status: 'blocked',
      action: { ...ruleVoice.action, content: { ...ruleVoice.action.content, id: 'claim-blocked' } },
    },
    {
      ...ruleVoice, id: 'gesture-completed', orderInMonth: 5,
      action: { ...ruleVoice.action, channel: 'gesture', content: { ...ruleVoice.action.content, id: 'claim-gesture' } },
    },
    {
      ...ruleVoice, id: 'record-completed', orderInMonth: 6,
      action: { ...ruleVoice.action, channel: 'record', content: { ...ruleVoice.action.content, id: 'claim-record' } },
    },
    {
      ...ruleVoice, id: 'move-completed', orderInMonth: 7,
      action: { kind: 'move', toCellId: 4 },
    },
  ];
  const events = [modelDecision, decisionVoice, ruleVoice, ...excludedEvents];
  const state = {
    branchId: 'speech-test',
    clock: { elapsedMonths: 8 },
    world: { past: [experience, ...events] },
    civilization: {
      epoch: 'stable',
      climate: { kind: 'temperate', severity: 1 },
      weather: { kind: 'clear', severity: 0 },
    },
    people: [
      {
        id: 'speaker', name: '阿澜', bornAtMonth: -216, sex: 'female',
        activeIntentId: 'intent-talk', currentActionText: '正在泊川身边整理水袋',
        position: { cellId: 3, z: 1 },
        profile: { description: '谨慎、念旧，也愿意把感谢说清楚。' },
        baselineCapacities: { locomotion: 62, manipulation: 58, perception: 61, communication: 47, cognition: 65 },
        body: { health: 74, hydration: 63, nutrition: 59 },
        conditions: [{ id: 'old-thirst', kind: 'cold', stage: 1, sinceMonth: 7, sourceEventIds: ['experience-care'] }],
        personality: {
          baseline: {
            honestyHumility: 71, emotionality: 64, extraversion: 37,
            agreeableness: 72, conscientiousness: 68, openness: 55,
          },
          learnedDelta: {
            honestyHumility: 0, emotionality: 0, extraversion: 0,
            agreeableness: 3, conscientiousness: 0, openness: 0,
          },
          evidence: [], changes: [],
        },
        motiveSensitivity: { control: 44, status: 32 },
        relations: [{ personId: 'listener', trust: 23, bond: 31, fear: 4, sourceEventIds: ['experience-care'] }],
        memories: [
          {
            id: 'current-speech-memory', kind: 'dialogue', summary: 'CURRENT EVENT MUST NOT LEAK',
            importance: 100, createdAtMonth: 8, lastRecalledAtMonth: 8,
            personIds: ['listener'], sourceEventIds: ['voice-decision'],
          },
          {
            id: 'earlier-memory', kind: 'episode', summary: '缺水时，对方曾把水分给我。',
            importance: 90, createdAtMonth: 7, lastRecalledAtMonth: 7,
            personIds: ['listener'], sourceEventIds: ['experience-care'],
          },
        ],
        knowledge: [{
          id: 'known-water', kind: 'observation', summary: '饮水能缓解缺水。',
          confidence: 86, learnedAtMonth: 7, sourceEventIds: ['experience-care'],
        }],
        characterAgenda: {
          version: 'character-agenda-v1',
          items: [{
            id: 'agenda-care', basisKey: 'agenda-v1|care', aim: '不让身边的人再独自挨渴',
            theme: 'care', importance: 82, horizonMonths: 18, targetAtMonth: 26,
            origin: 'model-proposal', status: 'active', createdAtMonth: 7, lastReviewedAtMonth: 8,
            sourceFactIds: ['experience-care'], intentIds: ['intent-talk'], projectIds: [],
            activeIntentId: 'intent-talk', activeApproachId: 'approach-check-water',
            approaches: [{
              id: 'approach-check-water', basisKey: 'agenda-v1|care|approach|check-water',
              summary: '先问清对方现在还剩多少水', disposition: 'missing-affordance',
              createdAtMonth: 7, lastConsideredAtMonth: 8, sourceFactIds: ['experience-care'],
              attemptIntentIds: ['intent-talk'], evaluations: [],
            }],
          }],
        },
      },
      {
        id: 'listener', name: '泊川', currentActionText: '正在查看脚边的容器',
        position: { cellId: 3, z: 1 },
      },
    ],
    intents: [{
      id: 'intent-talk', ownerId: 'speaker', status: 'active', progress: 35,
      summary: '感谢对方上次分水', sourceDecisionEventId: 'decision-talk', sourceFactIds: ['experience-care'],
      characterAgendaItemId: 'agenda-care', characterAgendaApproachId: 'approach-check-water',
    }],
  };

  const originalEvents = structuredClone(events);
  const unrelatedExperience = {
    id: 'experience-unrelated-rabbit', kind: 'environment', change: 'resource', atMonth: 7, orderInMonth: 2,
    cellId: 3, who: 'speaker', result: '在河边捡到一只兔子', diff: { resource: 'rabbit' },
  };
  state.world.past.push(unrelatedExperience);
  state.people[0].memories.push(...Array.from({ length: 7 }, (_, index) => ({
    id: `unrelated-memory-${index}`, kind: 'episode', summary: `在别处做过一件无关的工作 ${index}`,
    importance: 99 - index, createdAtMonth: 6, lastRecalledAtMonth: 6,
    personIds: [], sourceEventIds: [],
  })));
  state.people[0].memories.push({
    id: 'unrelated-sourced-memory', kind: 'episode', summary: '泊川曾在河边递给我一只兔子。',
    importance: 100, createdAtMonth: 7, lastRecalledAtMonth: 7,
    personIds: ['listener'], sourceEventIds: [unrelatedExperience.id],
  });
  state.people[0].knowledge.push({
    id: 'known-unrelated-rabbit', kind: 'observation', summary: '河边出现过兔子。',
    confidence: 99, learnedAtMonth: 7, sourceEventIds: [unrelatedExperience.id],
  }, {
    id: 'known-unmentioned-river-detail', kind: 'observation', summary: '河水流得很急。',
    confidence: 98, learnedAtMonth: 7, sourceEventIds: [unrelatedExperience.id],
  });
  const drafts = projectLiveSpeechDrafts(state, events);

  assert.deepEqual(drafts.map((line) => line.sourceEventId), ['voice-decision', 'voice-rule'], '只投影已完成的当面语音沟通');
  assert.deepEqual(events, originalEvents, '台词投影不能修改权威行动事实');

  const decisionDraft = drafts[0];
  assert.equal(decisionDraft.modelText, modelDecision.decision.utterance, '已用于决策的模型话语应进入待校验投影');
  assert.equal(decisionDraft.speechAct.version, 'speech-act-v1');
  assert.equal(decisionDraft.speechAct.kind, 'claim');
  assert.equal(decisionDraft.speechAct.details.conversation.topic, '上次缺水时得到帮助');
  assert.equal('stance' in decisionDraft.speechAct.details.conversation, false,
    '旧规则预设的 supportive/guarded 不能替模型决定会话动作');
  assert.equal('canonicalText' in decisionDraft, false, '新投影不得再携带可显示的规则原话');
  assert.equal('meaningAnchor' in decisionDraft, false, '新投影不得以隐藏字段继续携带规则原话模板');
  assert.equal(speechLineMatchesAct(decisionDraft, decisionDraft.modelText), true, '合法的决策模型台词可以复用');
  assert.equal(decisionVoice.action.content.summary, '上次我缺水时，你给了我水，我一直记着。', '模型措辞不能覆盖规则原意');

  const ruleDraft = drafts[1];
  assert.equal(ruleDraft.modelText, undefined, '没有模型话语时只保留结构化草稿');
  assert.equal(ruleDraft.speechAct.subject, ruleVoice.action.content.summary, '旧的无结构 claim 摘要只能作为模型语义输入');
  const predictionVoice = {
    ...ruleVoice,
    id: 'voice-prediction',
    action: {
      kind: 'communicate', audience: ['listener'], channel: 'voice',
      content: {
        id: 'predict-era:8:speaker:1', kind: 'prediction',
        summary: '预言第 11 月前后将进入乱纪元',
        prediction: {
          targetEpoch: 'chaotic', predictedStartMonth: 11,
          toleranceMonths: 3, expiresAtMonth: 14,
        },
      },
    },
    result: '阿澜向泊川作出纪元预测',
  };
  const [predictionDraft] = projectLiveSpeechDrafts(state, [predictionVoice]);
  assert.deepEqual(predictionDraft.speechAct, {
    version: 'speech-act-v1', kind: 'prediction',
    details: {
      prediction: {
        targetEpoch: 'chaotic', predictedStartMonth: 11,
        toleranceMonths: 3, expiresAtMonth: 14,
      },
    },
  }, 'prediction SpeechAct 应保留可机器校验的目标纪元与时间，而不是只剩自然语言摘要');
  assert.equal(speechLineMatchesAct(predictionDraft, '我看第十一月前后，乱纪元就会来了。'), true,
    '忠实表达目标纪元和预测月份的自然台词应通过');
  assert.equal(speechLineMatchesAct(predictionDraft, '再过三个月，乱纪元大概会来。'), true,
    '相对于发言月份的等价时间表达也应通过');
  assert.equal(speechLineMatchesAct(predictionDraft, '石头和木头合在一起，倒像能做件趁手的工具。'), false,
    '与权威 prediction 无关的工具文本必须被事实级校验拒绝');
  assert.equal(speechLineMatchesAct(predictionDraft, '第十一月前后会继续是恒纪元。'), false,
    '月份正确但目标纪元相反时不能通过');
  assert.equal(speechLineMatchesAct(predictionDraft, '乱纪元大概要到第十二月。'), false,
    '目标纪元正确但预测月份被改写时不能通过');
  assert.equal(speechLineMatchesAct(predictionDraft, '第十一月不是乱纪元。'), false,
    '提到全部字段但明确否定原预测时不能通过');
  assert.equal(normalizeSpeechResponse({ lines: [{
    sourceEventId: predictionDraft.sourceEventId, dialogueMove: 'reveal', disposition: 'continue',
    text: '石头和木头合在一起，倒像能做件趁手的工具。',
  }] }, [predictionDraft]).size, 0, '真实 speech-model 归一化路径也必须丢弃无关 prediction 台词');
  assert.equal(normalizeSpeechResponse({ lines: [{
    sourceEventId: predictionDraft.sourceEventId, dialogueMove: 'reveal', disposition: 'continue',
    text: '我估计第十一月前后会转入乱纪元。',
  }] }, [predictionDraft]).get(predictionDraft.sourceEventId)?.text,
  '我估计第十一月前后会转入乱纪元。', '真实归一化路径应保留忠实预测台词');
  const retainedDecisionLines = retainDecisionSpeechLines(drafts);
  assert.equal(retainedDecisionLines.length, 1);
  assert.equal(retainedDecisionLines[0].sourceEventId, decisionDraft.sourceEventId);
  assert.equal(retainedDecisionLines[0].text, modelDecision.decision.utterance,
    '决策阶段已选中且通过事实校验的非依赖原话必须逐字保留');
  assert.equal(retainedDecisionLines[0].source, 'decision-model');
  assert.equal(retainedDecisionLines[0].dialogueMove, undefined,
    '观察层 dialogueMove 缺失不能成为重复调用表达模型的理由');
  assert.equal(retainedDecisionLines[0].disposition, undefined,
    '观察层 disposition 缺失不能成为重复调用表达模型的理由');
  await assert.rejects(() => realizeLiveSpeechLines(
    state,
    events,
    [decisionDraft],
    'endpoint-that-must-not-be-resolved',
  ), /模型配置不存在端点/u,
  '有表达模型时，决策阶段的草稿也必须经过带真实上下文的最终表达，不得直接发布');
  assert.deepEqual(retainDecisionSpeechLines([{
    ...predictionDraft,
    modelText: '石头和木头合在一起，倒像能做件趁手的工具。',
  }]), [], '未通过 prediction 结构事实校验的 decision utterance 不能直接发布');

  const requestItem = buildSpeechRequestItem(state, events, decisionDraft);
  assert.ok(requestItem);
  assert.equal(requestItem.speaker.personality.agreeableness, 75, '请求应携带人物的有效人格');
  assert.equal(requestItem.speaker.communicationCapacity, 47, '台词长度应受到人物表达能力约束');
  assert.equal(requestItem.speaker.communication.band, 'ordinary', '台词请求应携带可直接执行的表达能力档位');
  assert.equal(requestItem.speaker.soul.authority, 'derived-personality', 'speech-only 台词应复用只读 Soul 人格锚');
  assert.match(requestItem.speaker.soul.innerVoice, /^我是阿澜。/u);
  assert.equal(requestItem.speaker.soul.sceneFacets.length, 5, 'speech-only 台词应读取可按情境激活的 Soul 侧面');
  assert.deepEqual(requestItem.listeners, [{
    name: '泊川', trust: 23, bond: 31, fear: 4,
    currentAction: '正在查看脚边的容器', sameCell: true,
  }], '请求应携带说话者视角的关系和必要现场');
  assert.deepEqual(requestItem.speaker.activity, {
    currentAction: '正在泊川身边整理水袋',
    activeIntent: { summary: '感谢对方上次分水', progress: 35 },
    activeAgenda: {
      aim: '不让身边的人再独自挨渴', theme: 'care', status: 'active',
      currentApproach: '先问清对方现在还剩多少水',
    },
  }, 'speech-only 应只携带当前行动、活跃意图和一个相关长期关切');
  assert.deepEqual(requestItem.communication.speechAct, decisionDraft.speechAct, '模型只读取结构化话语行为');
  assert.equal(requestItem.communication.proposedText, modelDecision.decision.utterance,
    '较早模型拟过的原话只能作为表达候选，仍需当前模型补全会话动作');
  assert.equal(requestItem.communication.relationalFrame.tone, 'guarded', '低信任关系不应默认写成礼貌亲近');
  assert.equal(requestItem.communication.relationalFrame.intensity, 'low', '普通疏离只应轻度改变口吻');
  assert.equal(requestItem.communication.relationalFrame.hostilityAllowed, false, '低信任本身不构成敌意证据');
  assert.equal('meaningAnchor' in requestItem.communication, false, '请求不得发送规则原话语义锚');
  assert.deepEqual(requestItem.sourcedExperiences, [experience.result], '请求只携带当前话语之前可追溯的亲历事实');
  assert.deepEqual(requestItem.recentMemories[0], {
    kind: 'episode', summary: '缺水时，对方曾把水分给我。', participants: ['泊川'],
  }, '当前听者与话题相关的亲历应压过更高重要性的无关记忆');
  assert.equal(requestItem.recentMemories.some((memory) => memory.summary.includes('无关的工作')), false,
    '没有 sourceEventId 的自由文本记忆不能作为外部事实进入台词请求');
  assert.equal(requestItem.recentMemories.some((memory) => memory.summary.includes('兔子')), false,
    '即使记忆有真实来源且提到当前听者，也不能劫持与该来源无关的台词');
  assert.equal(requestItem.knownFacts.some((fact) => fact.id === 'known-unrelated-rabbit'), false,
    '当前 speech source 与显式 factId 均未授权的知识不能进入台词请求');
  assert.equal(requestItem.recentMemories.some((memory) => memory.summary.includes('CURRENT EVENT')), false, '当前话语生成的记忆不能反向进入同一次请求');
  const explicitFactRequest = buildSpeechRequestItem(state, events, {
    ...ruleDraft,
    sourceFactIds: [],
    speechAct: {
      ...ruleDraft.speechAct,
      details: { ...ruleDraft.speechAct.details, factId: 'known-unrelated-rabbit' },
    },
  });
  assert.equal(explicitFactRequest.knownFacts.some((fact) => fact.id === 'known-unrelated-rabbit'), true,
    'speechAct 明确指定的 factId 仍应携带对应知识，而不是被来源收紧误删');
  assert.equal(explicitFactRequest.knownFacts.some((fact) => fact.id === 'known-unmentioned-river-detail'), false,
    '显式 factId 只授权对应知识，不应顺带开放同一事件上的其他知识');
  const futureKnowledgeState = structuredClone(state);
  futureKnowledgeState.world.past.push({
    id: 'future-discovery', kind: 'environment', change: 'knowledge', atMonth: 8, orderInMonth: 9,
    cellId: 3, who: 'speaker', result: '在本月更晚时才发现火的性质', diff: {},
  });
  futureKnowledgeState.people[0].knowledge.push({
    id: 'future-fire', kind: 'observation', summary: '火会灼伤皮肤。', confidence: 92,
    learnedAtMonth: 8, sourceEventIds: ['future-discovery'],
  });
  const timeBoundRequest = buildSpeechRequestItem(futureKnowledgeState, events, decisionDraft);
  assert.equal(timeBoundRequest.knownFacts.some((fact) => fact.id === 'future-fire'), false,
    '动作之后才获得的同月知识不能倒灌进台词请求');

  const responseEvent = {
    ...ruleVoice,
    id: 'voice-response', atMonth: 9, orderInMonth: 2, actionTick: 2,
    who: 'listener', intentId: 'intent-response',
    action: {
      kind: 'communicate', audience: ['speaker'], channel: 'voice',
      content: {
        id: 'respond-conversation:voice-decision:listener', kind: 'claim',
        summary: '回应这段有来源的共同经历',
        conversation: {
          version: 'grounded-conversation-v1', basisKey: 'care-water', topic: 'care',
          turn: 'response', speakerId: 'listener', listenerId: 'speaker',
          sourceFactIds: ['experience-care'], referenceEventId: 'voice-decision',
        },
      },
    },
    result: '泊川回应阿澜关于上次分水的交谈',
  };
  const responseState = structuredClone(state);
  responseState.clock.elapsedMonths = 9;
  responseState.world.past = [experience, ...events, responseEvent];
  responseState.people[1] = {
    ...structuredClone(responseState.people[0]),
    id: 'listener', name: '泊川', activeIntentId: 'intent-response',
    currentActionText: '坐在阿澜身边检查水袋',
    relations: [{ personId: 'speaker', trust: 61, bond: 57, fear: 0, sourceEventIds: ['experience-care'] }],
    memories: [{
      id: 'memory-opening', kind: 'dialogue', summary: '阿澜提到上次分水的经历',
      importance: 82, createdAtMonth: 8, lastRecalledAtMonth: 8,
      personIds: ['speaker'], sourceEventIds: ['voice-decision'],
    }],
  };
  responseState.intents.push({
    id: 'intent-response', ownerId: 'listener', status: 'active', progress: 10,
    summary: '回应阿澜刚刚说的话', sourceDecisionEventId: 'decision-response',
    sourceFactIds: ['voice-decision'],
  });
  const [responseDraft] = projectLiveSpeechDrafts(responseState, [responseEvent]);
  assert.equal(responseDraft.replyToSourceEventId, 'voice-decision',
    'grounded response 必须保留它引用的 opening ActionFact');
  assert.equal(responseDraft.requiresParentSpeech, true,
    'grounded response 必须声明真实父台词依赖');
  assert.equal(responseDraft.sourceFactIds.includes('voice-decision'), true,
    '父 ActionFact 只能作为已有 source id 加入投影，不能被台词反写为新世界事实');

  const openingSpeechLine = {
    id: 'speech:speech-test:voice-decision', authority: 'projection-only',
    sourceEventId: 'voice-decision', sourceFactIds: ['experience-care'],
    month: 8, planningTick: 1, speakerId: 'speaker', speakerName: '阿澜',
    audienceIds: ['listener'], audienceNames: ['泊川'], channel: 'voice',
    communicationKind: 'claim', speechAct: decisionDraft.speechAct,
    text: '你还记得上回我渴得说不出话，你把水袋塞给我的时候吗？',
    dialogueMove: 'reveal', disposition: 'continue', source: 'speech-model',
  };
  assert.equal(buildSpeechRequestItem(responseState, [responseEvent], responseDraft), null,
    '没有已保存真实父台词时不能为 response 构造模型请求');
  assert.equal(replySpeechLineFor(responseState, responseEvent, responseDraft, [openingSpeechLine])?.id,
    openingSpeechLine.id, '只允许精确匹配且双方互为说话者/听者的真实父台词');
  const responseRequest = buildSpeechRequestItem(
    responseState,
    [responseEvent],
    responseDraft,
    [openingSpeechLine],
  );
  assert.equal(responseRequest.communication.replyTo.text, openingSpeechLine.text,
    'response 模型必须逐字读到 opening 已保存的真实 SpeechLine.text');
  assert.equal(responseRequest.communication.replyTo.speechLineId, openingSpeechLine.id,
    'response 需要保存精确 replyToSpeechLineId，而不是模糊话题引用');
  assert.equal(responseRequest.recentMemories.some((memory) => memory.summary.includes('阿澜提到上次分水')), true,
    '与 exact parent ActionFact 重叠的记忆可以进入回应请求');
  assert.equal(responseRequest.recentMemories.some((memory) => memory.summary.includes('兔子')), false,
    '回应只能接住 exact parent 及其来源，不能被同一听者的另一段记忆带跑');
  assert.deepEqual(retainDecisionSpeechLines([{
    ...responseDraft,
    modelText: '行，我也觉得挺可乐的。',
    dialogueMove: 'acknowledge',
    disposition: 'continue',
  }]), [],
    '没有读过真实 opening 的 decision-time 套话不能作为 response 发布');
  assert.equal(replySpeechLineFor(responseState, responseEvent, responseDraft, [{
    ...openingSpeechLine, audienceIds: ['somebody-else'],
  }]), undefined, '参与者不匹配的历史台词不能被误接成当前会话父句');

  const acceptLine = {
    ...ruleDraft,
    sourceEventId: 'accept-action',
    communicationKind: 'accept',
    speechAct: { version: 'speech-act-v1', kind: 'accept', details: { referenceId: 'proposal' } },
  };
  const rejectLine = {
    ...ruleDraft,
    sourceEventId: 'reject-action',
    communicationKind: 'reject',
    speechAct: { version: 'speech-act-v1', kind: 'reject', details: { referenceId: 'proposal' } },
  };
  const directRequestLine = {
    ...ruleDraft,
    sourceEventId: 'direct-request-action',
    communicationKind: 'request',
    speechAct: { version: 'speech-act-v1', kind: 'request', details: { need: 'stone' } },
  };
  assert.equal(speechLineMatchesAct(directRequestLine, '石头给我。'), true, '短促命令式请求不应被礼貌词校验器丢弃');
  assert.equal(speechLineMatchesAct(directRequestLine, '走。'), true, '不带解释的最短行动请求也应合法');
  assert.equal(speechLineMatchesAct(directRequestLine, '天气已经转晴。'), false, '普通陈述不能伪装成请求');

  const familiarState = structuredClone(state);
  familiarState.people[0].relations[0] = {
    personId: 'listener', trust: 72, bond: 78, fear: 0, sourceEventIds: ['experience-care'],
  };
  const familiarFrame = deriveRelationalSpeechFrame(
    familiarState,
    decisionVoice,
    familiarState.people[0],
    ['listener'],
  );
  assert.equal(familiarFrame.tone, 'familiar', '高信任高羁绊关系应允许省略客套和熟人式短句');
  assert.equal(familiarFrame.intensity, 'low');
  assert.equal(familiarFrame.hostilityAllowed, false);

  const bluntState = structuredClone(state);
  bluntState.people[0].personality.baseline.agreeableness = 30;
  bluntState.people[0].personality.learnedDelta.agreeableness = 0;
  bluntState.people[0].relations[0] = {
    personId: 'listener', trust: 55, bond: 35, fear: 0, sourceEventIds: ['experience-care'],
  };
  const ordinaryLowAgreeablenessFrame = deriveRelationalSpeechFrame(
    bluntState,
    ruleVoice,
    bluntState.people[0],
    ['listener'],
  );
  assert.equal(ordinaryLowAgreeablenessFrame.tone, 'neutral', '低宜人性不应让普通陈述自动变成强硬训斥');
  const directRequestEvent = {
    ...ruleVoice,
    id: 'direct-request-event',
    action: {
      kind: 'communicate', audience: ['listener'], channel: 'voice',
      content: { id: 'direct-request', kind: 'request', summary: '请求对方交出石头' },
    },
    result: '阿澜请求泊川交出石头',
  };
  const bluntFrame = deriveRelationalSpeechFrame(bluntState, directRequestEvent, bluntState.people[0], ['listener']);
  assert.equal(bluntFrame.tone, 'blunt', '低宜人性只在请求或拒绝等边界场景中支持直接口吻');
  assert.equal(bluntFrame.reasonBudget, 'optional', '直接表达可以省略理由，但不应被强制永远没有理由');
  assert.equal(bluntFrame.intensity, 'low', '没有冲突证据的直接表达只能是低强度');
  assert.equal(bluntFrame.hostilityAllowed, false, '低宜人性只能支持直接，不能凭空支持敌意');

  const neutralState = structuredClone(state);
  neutralState.people[0].personality.baseline.agreeableness = 55;
  neutralState.people[0].personality.learnedDelta.agreeableness = 0;
  neutralState.people[0].relations[0] = {
    personId: 'listener', trust: 55, bond: 35, fear: 0, sourceEventIds: ['experience-care'],
  };
  const neutralFrame = deriveRelationalSpeechFrame(neutralState, ruleVoice, neutralState.people[0], ['listener']);
  assert.equal(neutralFrame.tone, 'neutral', '普通人格与普通关系应以自然中性交流为默认');
  assert.equal(neutralFrame.reasonBudget, 'optional');

  const harmEvent = {
    ...ruleVoice,
    id: 'harm-listener-speaker',
    atMonth: 7,
    orderInMonth: 3,
    who: 'listener',
    action: {
      kind: 'act', operation: 'exert', targets: [{ kind: 'person', personId: 'speaker' }],
    },
    result: '泊川对阿澜施力并造成伤害',
    diff: { victimId: 'speaker', damage: 8 },
  };
  const hostileState = structuredClone(state);
  hostileState.world.past = [experience, harmEvent, ...events];
  hostileState.people[0].relations[0] = {
    personId: 'listener', trust: 35, bond: 10, fear: 18, sourceEventIds: [harmEvent.id],
  };
  const hostileFrame = deriveRelationalSpeechFrame(hostileState, decisionVoice, hostileState.people[0], ['listener']);
  assert.equal(hostileFrame.tone, 'confrontational', '真实伤害加低信任可以升级为对抗语气');
  assert.equal(hostileFrame.intensity, 'high', '直接伤害证据可以支持高强度对抗');
  assert.equal(hostileFrame.hostilityAllowed, true);
  assert.deepEqual(hostileFrame.frictionEvidence.map((item) => item.sourceEventId), [harmEvent.id]);

  const reconciledState = structuredClone(hostileState);
  reconciledState.people[0].relations[0] = {
    personId: 'listener', trust: 68, bond: 72, fear: 0, sourceEventIds: [harmEvent.id],
  };
  const reconciledFrame = deriveRelationalSpeechFrame(
    reconciledState,
    ruleVoice,
    reconciledState.people[0],
    ['listener'],
  );
  assert.equal(reconciledFrame.tone, 'familiar', '旧冲突存在但当前关系已缓和时，普通陈述不应继续对抗');
  assert.equal(reconciledFrame.hostilityAllowed, false, '冲突证据只是必要条件，当前姿态未对抗时不得开放敌意');

  const pressureRequestOne = {
    ...ruleVoice,
    id: 'pressure-request-one',
    atMonth: 6,
    orderInMonth: 1,
    who: 'listener',
    action: {
      kind: 'communicate', audience: ['speaker'], channel: 'voice',
      content: { id: 'pressure-proposal-one', kind: 'request', summary: '要求阿澜交出石头' },
    },
    result: '泊川要求阿澜交出石头',
  };
  const pressureReject = {
    ...ruleVoice,
    id: 'pressure-reject',
    atMonth: 6,
    orderInMonth: 2,
    who: 'speaker',
    action: {
      kind: 'communicate', audience: ['listener'], channel: 'voice',
      content: { id: 'pressure-rejection', kind: 'reject', referenceId: 'pressure-proposal-one', summary: '拒绝交出石头' },
    },
    result: '阿澜拒绝交出石头',
  };
  const pressureRequestTwo = {
    ...pressureRequestOne,
    id: 'pressure-request-two',
    atMonth: 7,
    orderInMonth: 1,
    action: {
      ...pressureRequestOne.action,
      content: { id: 'pressure-proposal-two', kind: 'request', summary: '再次要求阿澜交出石头' },
    },
    result: '泊川再次要求阿澜交出石头',
  };
  const pressuredState = structuredClone(state);
  pressuredState.world.past = [experience, pressureRequestOne, pressureReject, pressureRequestTwo, ...events];
  pressuredState.people[0].relations[0] = {
    personId: 'listener', trust: 40, bond: 20, fear: 0, sourceEventIds: [],
  };
  const pressuredFrame = deriveRelationalSpeechFrame(pressuredState, decisionVoice, pressuredState.people[0], ['listener']);
  assert.equal(pressuredFrame.tone, 'confrontational', '拒绝后的重复施压可以支持不耐烦和质问');
  assert.equal(pressuredFrame.intensity, 'medium', '重复施压支持中度对抗，不自动等同直接伤害');
  assert.equal(pressuredFrame.hostilityAllowed, true);
  assert.equal(pressuredFrame.frictionEvidence.filter((item) => item.kind === 'repeated-pressure').length, 2);

  const rejected = normalizeSpeechResponse({ lines: [
    { sourceEventId: 'accept-action', dialogueMove: 'acknowledge', disposition: 'continue', text: '我不同意这件事。' },
    { sourceEventId: 'reject-action', dialogueMove: 'acknowledge', disposition: 'continue', text: '好，我接受你的提议。' },
  ] }, [acceptLine, rejectLine]);
  assert.equal(rejected.size, 0, '改变接受或拒绝立场的模型措辞必须被丢弃');
  assert.deepEqual(retainDecisionSpeechLines([acceptLine, rejectLine]), [], '非法或缺失模型措辞不会回退为规则台词');
  assert.equal(normalizeSpeechResponse({ lines: [
    { sourceEventId: 'reject-action', dialogueMove: 'acknowledge', disposition: 'continue', text: '我不愿意拒绝你，我接受。' },
  ] }, [rejectLine]).size, 0, '含拒绝词但最终表达接受的矛盾台词不能蒙混过关');

  const accepted = normalizeSpeechResponse({ lines: [
    { sourceEventId: 'accept-action', dialogueMove: 'acknowledge', disposition: 'continue', text: '成，就照你说的往下走。' },
    { sourceEventId: 'reject-action', dialogueMove: 'close', disposition: 'close', text: '还是免了，我不打算答应。' },
  ] }, [acceptLine, rejectLine]);
  assert.deepEqual(accepted.get('accept-action'), {
    text: '成，就照你说的往下走。', dialogueMove: 'acknowledge', disposition: 'continue',
  });
  assert.deepEqual(accepted.get('reject-action'), {
    text: '还是免了，我不打算答应。', dialogueMove: 'close', disposition: 'close',
  }, '立场合法的自主会话动作与措辞应一起采用');
  assert.equal(normalizeSpeechResponse({ lines: [
    {
      sourceEventId: ruleDraft.sourceEventId, dialogueMove: 'reveal', disposition: 'continue',
      text: '脚下的泥已经摸不出潮气了。',
    },
  ] }, [ruleDraft]).get(ruleDraft.sourceEventId)?.text, '脚下的泥已经摸不出潮气了。',
  '普通陈述不再因与规则摘要缺少字面重合而被拒绝');
  assert.equal(normalizeSpeechResponse({ lines: [
    { sourceEventId: ruleDraft.sourceEventId, text: '脚下的泥已经摸不出潮气了。' },
  ] }, [ruleDraft]).size, 0, '只返回 text 的旧协议不能再发布为实时台词');
  assert.equal(normalizeSpeechResponse({ lines: [{
    sourceEventId: ruleDraft.sourceEventId, dialogueMove: 'agree-with-everything',
    disposition: 'continue', text: '脚下的泥已经摸不出潮气了。',
  }] }, [ruleDraft]).size, 0, '服务端只接受模型自主选择的有限会话动作协议');

  const inspectionEndpoint = process.env.ELAND_INSPECT_SPEECH_ENDPOINT?.trim();
  if (inspectionEndpoint) {
    const inspected = await realizeLiveSpeechLines(
      responseState,
      [responseEvent],
      [responseDraft],
      inspectionEndpoint,
      [openingSpeechLine],
    );
    console.log(`live speech qualitative sample: ${JSON.stringify(inspected)}`);
  }

  console.log('live speech projection tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
