import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-grounded-conversation-test-'));
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const executorBundlePath = path.join(temporaryDirectory, 'action-executor.mjs');
const relationshipBundlePath = path.join(temporaryDirectory, 'relationship-evidence.mjs');
const gridBundlePath = path.join(temporaryDirectory, 'grid.mjs');
const conversationBundlePath = path.join(temporaryDirectory, 'conversation-options.mjs');
const memoryBundlePath = path.join(temporaryDirectory, 'agent-memory.mjs');

try {
  for (const [entry, output] of [
    ['src/game/eland/simulation.ts', simulationBundlePath],
    ['src/game/eland/domain/action-executor.ts', executorBundlePath],
    ['src/game/eland/domain/relationship-evidence.ts', relationshipBundlePath],
    ['src/game/eland/world/grid.ts', gridBundlePath],
    ['src/game/eland/application/conversation-options.ts', conversationBundlePath],
    ['src/game/eland/domain/agent-memory.ts', memoryBundlePath],
  ]) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
    ], { stdio: 'pipe' });
  }

  const { buildDecisionContexts, createInitialState } = await import(`${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`);
  const { executePrimitiveAction } = await import(`${pathToFileURL(executorBundlePath).href}?test=${Date.now()}`);
  const {
    buildRelationshipCausalBasis,
    canOfferRelationshipProposal,
    hasCultivatedCompanionRelationship,
    hasSourcedReproductiveRelationship,
  } = await import(`${pathToFileURL(relationshipBundlePath).href}?test=${Date.now()}`);
  const { cellsInRadius, findStandingPath, standingPositions } = await import(`${pathToFileURL(gridBundlePath).href}?test=${Date.now()}`);
  const { buildGroundedConversationOptions } = await import(`${pathToFileURL(conversationBundlePath).href}?test=${Date.now()}`);
  const agentMemory = await import(`${pathToFileURL(memoryBundlePath).href}?test=${Date.now()}`);

  const placeWith = (person, other) => {
    person.position.cellId = other.position.cellId;
    person.position.z = other.position.z;
    person.position.previousCellId = other.position.cellId;
    person.position.previousZ = other.position.z;
  };
  const runAction = (state, actor, action, atMonth, orderInMonth) => {
    const fact = executePrimitiveAction(state, actor, action, atMonth, orderInMonth, {
      cause: 'intent', actionTick: orderInMonth + 1,
    });
    state.world.past.push(fact);
    return fact;
  };
  const relation = (person, other) => person.relations.find((entry) => entry.personId === other.id);
  const reserveConversation = (stateValue, action, decisionId, atMonth) => {
    const conversation = action?.content?.conversation;
    assert.ok(conversation?.episodeId, 'grounded conversation option must carry a shared episode id');
    assert.ok(agentMemory.reserveConversationEpisode(stateValue, conversation, decisionId, atMonth));
  };

  const state = createInitialState(3901, { endpoint: { kind: 'months', value: 3 }, chaosIntensity: 0 });
  const speaker = state.people[0];
  const listener = state.people[1];
  state.people = [speaker, listener];
  placeWith(listener, speaker);
  const foundingEvent = state.world.past.find((event) => event.kind === 'environment' && event.change === 'founding');
  const foundingBasis = buildRelationshipCausalBasis(state, speaker, listener, 'reproduce');
  assert.ok(foundingEvent, 'fixture requires the sourced founder cohort event');
  assert.deepEqual(foundingBasis.relationshipKeys, [], '共同抵达只表示相识，不得进入生育关系依据');
  assert.equal(hasSourcedReproductiveRelationship(state, speaker, listener, foundingBasis), false,
    '共同抵达不能单独形成亲密关系资格');
  const conditionEvent = {
    id: 'test-grounded-cold-source', kind: 'environment', change: 'condition', atMonth: 1,
    orderInMonth: 0, cellId: listener.position.cellId, who: listener.id,
    result: `${listener.name}感到寒冷`, diff: { condition: 'cold', stage: 2 },
  };
  state.world.past.push(conditionEvent);
  listener.conditions.push({
    id: 'test-listener-cold', kind: 'cold', stage: 2, sinceMonth: 1,
    sourceEventIds: [conditionEvent.id],
  });
  state.clock.elapsedMonths = 1;

  const visiblePosition = cellsInRadius(speaker.position.cellId, 3)
    .filter((cellId) => cellId !== speaker.position.cellId)
    .flatMap((cellId) => standingPositions(state.world.grid, cellId))
    .find((position) => findStandingPath(state.world.grid, speaker.position, position).length > 0);
  assert.ok(visiblePosition, '测试地图需要一个可见的邻近位置');
  listener.position.cellId = visiblePosition.cellId;
  listener.position.z = visiblePosition.z;

  let contexts = buildDecisionContexts(state);
  const openingOption = contexts.find((context) => context.person.id === speaker.id)?.options.find((option) => (
    option.id.startsWith('conversation:care:')
      && option.target?.kind === 'person'
      && option.target.personId === listener.id
  ));
  assert.ok(openingOption, '真实身体处境应生成有具体正文的生活聊天开场');
  assert.ok(openingOption.summary.includes('不舒服') || openingOption.summary.includes('冷得厉害'), '生活聊天不能退回通用占位句');
  assert.deepEqual(openingOption.sourceFactIds, [conditionEvent.id], '开场必须携带可解析的身体事件');
  assert.equal(openingOption.nextAction.kind, 'move', '可见但不同地的人只能因具体话题而短程靠近');
  assert.equal(openingOption.completionAction?.kind, 'communicate', '靠近必须绑定真实交谈，不能停在无目的会合');
  assert.equal(contexts.find((context) => context.person.id === speaker.id)?.options.some((option) => (
    option.target?.kind === 'person'
      && option.target.personId === listener.id
      && option.nextAction.kind === 'move'
      && ['everyday', 'reminiscence', 'playful'].includes(option.completionAction?.content?.conversation?.topic)
  )), false, '低压力闲聊只能从自然同地发生，不能驱动跨地追逐');
  assert.equal(contexts.find((context) => context.person.id === speaker.id)?.options.some((option) => option.id.startsWith('meet:')), false, '不得生成没有后续行动的通用会合');

  placeWith(listener, speaker);
  speaker.memories.push({
    id: 'memory-specific-founding', kind: 'dialogue', summary: `记得与${listener.name}一同抵达这里`,
    importance: 80, createdAtMonth: 0, lastRecalledAtMonth: 1,
    personIds: [listener.id], sourceEventIds: [foundingEvent.id],
  });
  contexts = buildDecisionContexts(state);
  const openConversationOptions = contexts.find((context) => context.person.id === speaker.id)?.options.filter((option) => (
    option.target?.kind === 'person'
      && option.target.personId === listener.id
      && option.nextAction.kind === 'communicate'
      && option.nextAction.content.kind === 'claim'
      && option.nextAction.content.conversation?.topic === 'open'
  )) ?? [];
  assert.equal(openConversationOptions.length, 1,
    '每位近身听者只能获得一个真实可执行的开放交谈 affordance');
  const openConversationOption = openConversationOptions[0];
  assert.equal(openConversationOption.nextAction.content.summary, `与${listener.name}进行开放交谈`,
    '开放交谈的权威摘要不得预写 failure、discovery 或 everyday 话题');
  assert.ok(openConversationOption.openConversationGrounding?.facts.some((fact) => (
    fact.kind === 'memory'
      && fact.sourceFactId === foundingEvent.id
      && fact.summary === `记得与${listener.name}一同抵达这里`
  )), '同一来源同时属于记忆与关系时，应保留更具体的本人记忆摘要');
  assert.equal(openConversationOption.openConversationGrounding?.facts.some((fact) => (
    fact.kind === 'relationship' && fact.sourceFactId === foundingEvent.id
  )), false, '通用关系摘要不得吞掉同一来源的具体记忆');
  assert.deepEqual(openConversationOption.openConversationGrounding?.fallbackSourceFactIds, [foundingEvent.id],
    '模型未选择 grounding handle 时仍应保留最小相识来源');
  const uncompiledOpenFact = executePrimitiveAction(state, speaker, openConversationOption.nextAction, 1, 90, {
    cause: 'intent', actionTick: 15,
  });
  assert.equal(uncompiledOpenFact.status, 'blocked',
    'generic open option must not execute before a validated decision recompiles its grounding');

  const localOpeningOption = contexts.find((context) => context.person.id === speaker.id)?.options.find((option) => (
    option.id.startsWith('conversation:care:')
      && option.target?.kind === 'person'
      && option.target.personId === listener.id
  ));
  assert.equal(localOpeningOption?.nextAction.kind, 'communicate', '已经同地时应直接交谈');

  const casualOpeningOption = contexts.find((context) => context.person.id === speaker.id)?.options.find((option) => (
    option.target?.kind === 'person'
      && option.target.personId === listener.id
      && option.nextAction.kind === 'communicate'
      && option.nextAction.content.kind === 'claim'
      && ['everyday', 'reminiscence', 'playful'].includes(option.nextAction.content.conversation?.topic)
  ));
  assert.ok(casualOpeningOption, '自然同地且有共同生活来源时应出现无任务目的的闲聊');
  assert.deepEqual(casualOpeningOption.sourceFactIds, [foundingEvent.id], '开局闲聊可以引用共同抵达，但该来源仍只是熟悉感');
  assert.equal(casualOpeningOption.nextAction.content.conversation.topic, 'everyday',
    '仅有共同抵达只能支撑当下日常，不能伪造共同回忆或有趣插曲');
  assert.equal(contexts.find((context) => context.person.id === speaker.id)?.options.some((option) => (
    option.nextAction.kind === 'communicate'
      && option.nextAction.content.kind === 'claim'
      && ['reminiscence', 'playful'].includes(option.nextAction.content.conversation?.topic)
      && option.sourceFactIds.includes(foundingEvent.id)
  )), false, '创世共同抵达不得作为小插曲、玩笑或具体回忆的来源');
  reserveConversation(state, casualOpeningOption.nextAction, 'decision-casual-opening', 1);
  const casualOpeningEvent = runAction(state, speaker, casualOpeningOption.nextAction, 1, 1);
  assert.equal(casualOpeningEvent.status, 'completed');
  contexts = buildDecisionContexts(state);
  const casualResponseOption = contexts.find((context) => context.person.id === listener.id)?.options.find((option) => (
    option.id.startsWith('respond-conversation:')
      && ['everyday', 'reminiscence', 'playful'].includes(option.nextAction.content.conversation?.topic)
  ));
  assert.ok(casualResponseOption, '低压力闲聊可以提供一个可追溯的回应机会');
  assert.equal(casualResponseOption.semantics.obligation, 'optional', '生活对话回应不得成为必须回应');
  assert.equal(casualResponseOption.semantics.edgeTrigger, 'conversation-response', '回应保留为有时限的可选机会');
  assert.equal(casualResponseOption.nextAction.content.conversation.stance, undefined,
    '候选层不得预写 supportive 或 guarded 态度');
  assert.doesNotMatch(casualResponseOption.nextAction.content.summary, /听懂|接受|愿意|支持|戒备/u,
    '回应的语义摘要只标记对话轮次，不替人物决定态度');
  reserveConversation(state, casualResponseOption.nextAction, 'decision-casual-response', 1);
  const casualResponseEvent = runAction(state, listener, casualResponseOption.nextAction, 1, 2);
  assert.equal(casualResponseEvent.status, 'completed');
  assert.ok(agentMemory.closeConversationWithoutResponse(state, speaker.id, 1, 'fixture closes this two-line exchange'));
  const oneMonthBasis = buildRelationshipCausalBasis(state, speaker, listener, 'reproduce');
  assert.equal(oneMonthBasis.relationshipKeys.includes(casualOpeningEvent.id), false);
  assert.equal(oneMonthBasis.relationshipKeys.includes(casualResponseEvent.id), false,
    '低压力闲聊进入对话史，但不应悄悄成为关系分或生育依据');
  assert.equal(hasSourcedReproductiveRelationship(state, speaker, listener, oneMonthBasis), false,
    '共同抵达跨月加一轮日常闲聊仍不是亲密关系');
  const previousElapsedMonth = state.clock.elapsedMonths;
  state.clock.elapsedMonths = 2;
  const nextMonthBasis = buildRelationshipCausalBasis(state, speaker, listener, 'reproduce');
  assert.equal(hasSourcedReproductiveRelationship(state, speaker, listener, nextMonthBasis), false,
    '时间流逝本身不能把普通闲聊变成生育资格');
  state.clock.elapsedMonths = previousElapsedMonth;

  const speakerBefore = structuredClone(relation(speaker, listener));
  const listenerBefore = structuredClone(relation(listener, speaker));
  reserveConversation(state, localOpeningOption.nextAction, 'decision-local-opening', 1);
  const openingEvent = runAction(state, speaker, localOpeningOption.nextAction, 1, 3);
  assert.equal(openingEvent.status, 'completed');
  assert.equal(openingEvent.diff.groundedConversationTurn, 'opening');
  assert.equal(relation(speaker, listener).bond - speakerBefore.bond, 2, '照护开场应增加两点羁绊');
  assert.equal(relation(speaker, listener).trust - speakerBefore.trust, 1, '照护开场应增加一点信任');
  assert.equal(relation(listener, speaker).bond - listenerBefore.bond, 2, '开场关系变化必须双向留下事件来源');

  contexts = buildDecisionContexts(state);
  const responseOption = contexts.find((context) => context.person.id === listener.id)?.options.find((option) => option.id.startsWith('respond-conversation:'));
  assert.ok(responseOption, '被点名者应获得对原开场的可选回应机会');
  assert.equal(responseOption.semantics.obligation, 'optional');
  assert.equal(contexts.find((context) => context.person.id === listener.id)?.options.some((option) => !option.id.startsWith('respond-conversation:')), true,
    '未回应的生活开场不得挤掉人物的其他可执行选择');
  reserveConversation(state, responseOption.nextAction, 'decision-local-response', 1);
  const responseEvent = runAction(state, listener, responseOption.nextAction, 1, 4);
  assert.equal(responseEvent.status, 'completed');
  assert.equal(responseEvent.diff.groundedConversationReferenceEventId, openingEvent.id);
  assert.equal(responseEvent.diff.groundedConversationStance, undefined,
    '候选规则不能把一次已选回应自动宣告为支持或戒备');
  assert.ok(speaker.memories.some((memory) => memory.sourceEventIds.includes(openingEvent.id)), '说话者应记住自己的生活开场');
  assert.ok(listener.memories.some((memory) => memory.sourceEventIds.includes(responseEvent.id)), '回应者应记住自己的回应');

  const relationshipBasis = buildRelationshipCausalBasis(state, speaker, listener, 'reproduce');
  assert.ok(relationshipBasis.relationshipKeys.includes(openingEvent.id));
  assert.equal(relationshipBasis.relationshipKeys.includes(responseEvent.id), false,
    '没有显式态度的中性回应只是说话事实，不得自动成为关系增长依据');
  contexts = buildDecisionContexts(state);
  assert.equal(contexts.find((context) => context.person.id === speaker.id)?.options.some((option) => option.nextAction.kind === 'communicate'
    && option.nextAction.content.kind === 'claim'
    && option.nextAction.content.conversation?.basisKey === openingEvent.diff.groundedConversationBasisKey
    && option.nextAction.content.conversation.turn === 'opening'), false, '同一生活基础不能再次生成开场');
  assert.equal(contexts.find((context) => context.person.id === speaker.id)?.options.some((option) => option.nextAction.kind === 'communicate'
    && option.nextAction.content.kind === 'claim'
    && option.nextAction.content.conversation?.referenceEventId === responseEvent.id), true,
  '上一句没有主动结束时，原说话者可自主决定是否继续');

  const duplicateResponseAction = structuredClone(responseOption.nextAction);
  duplicateResponseAction.content.id = 'respond-conversation:duplicate';
  const duplicateResponse = runAction(state, listener, duplicateResponseAction, 1, 5);
  assert.equal(duplicateResponse.status, 'blocked', '同一开场不能重复回应刷关系');

  const forgedAction = structuredClone(localOpeningOption.nextAction);
  forgedAction.content.id = 'conversation:care:forged';
  forgedAction.content.conversation.basisKey = 'grounded-conversation-v1|forged';
  forgedAction.content.conversation.sourceFactIds = ['missing-source-event'];
  const forgedEvent = runAction(state, speaker, forgedAction, 1, 6);
  assert.equal(forgedEvent.status, 'blocked', '无法解析的生活来源必须阻塞');

  const relationshipState = createInitialState(3903, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const relationshipSpeaker = relationshipState.people[0];
  const relationshipListener = relationshipState.people[1];
  relationshipState.people = [relationshipSpeaker, relationshipListener];
  placeWith(relationshipListener, relationshipSpeaker);
  for (const person of relationshipState.people) {
    person.bornAtMonth = -24 * 12;
    person.conditions = [];
    person.body = { health: 100, hydration: 100, nutrition: 100 };
  }
  const relationBetween = (owner, other) => owner.relations.find((entry) => entry.personId === other.id);
  const addSharedMoment = (month) => {
    const event = {
      id: `test-shared-life-${month}`, kind: 'environment', change: 'relationship',
      atMonth: month, orderInMonth: 0, cellId: relationshipSpeaker.position.cellId,
      result: '双方本月在同地共同生活，形成新的普通经历',
      diff: { process: 'shared-action-ticks', participantIds: [relationshipSpeaker.id, relationshipListener.id], excludedPairKeys: [] },
    };
    relationshipState.world.past.push(event);
    for (const [owner, other] of [[relationshipSpeaker, relationshipListener], [relationshipListener, relationshipSpeaker]]) {
      const directed = relationBetween(owner, other);
      directed.sourceEventIds = [...new Set([...directed.sourceEventIds, event.id])];
      directed.trust += 5;
      directed.bond += 5;
    }
    relationshipState.clock.elapsedMonths = month;
    return event;
  };
  const addDirectCareExchange = (month) => {
    const basisKey = `grounded-conversation-v1|topic=care|speaker=${relationshipSpeaker.id}|listener=${relationshipListener.id}|sources=${foundingEvent.id}`;
    const openingId = `test-direct-care-${month}-opening`;
    const responseId = `test-direct-care-${month}-response`;
    const fact = (id, orderInMonth, who, action) => ({
      id, kind: 'action', actionTick: 1, atMonth: month, orderInMonth,
      cellId: relationshipSpeaker.position.cellId, who, cause: 'intent', action,
      fromCellId: relationshipSpeaker.position.cellId, toCellId: relationshipSpeaker.position.cellId,
      fromZ: relationshipSpeaker.position.z, toZ: relationshipSpeaker.position.z,
      pathSegment: [relationshipSpeaker.position.cellId], status: 'completed',
      result: '完成一次有来源的照护交流', diff: { groundedConversationBasisKey: basisKey },
    });
    const shared = {
      version: 'grounded-conversation-v1', basisKey, topic: 'care',
      speakerId: relationshipSpeaker.id, listenerId: relationshipListener.id,
      sourceFactIds: [foundingEvent.id],
    };
    const opening = fact(openingId, 80, relationshipSpeaker.id, {
      kind: 'communicate', content: { id: openingId, kind: 'claim', summary: '问起真实照护近况', conversation: { ...shared, turn: 'opening' } },
      audience: [relationshipListener.id], channel: 'voice',
    });
    const response = fact(responseId, 81, relationshipListener.id, {
      kind: 'communicate', content: { id: responseId, kind: 'claim', summary: '回应真实照护近况', conversation: {
        ...shared, turn: 'response', speakerId: relationshipListener.id, listenerId: relationshipSpeaker.id,
        referenceEventId: openingId, stance: 'supportive',
      } }, audience: [relationshipSpeaker.id], channel: 'voice',
    });
    relationshipState.world.past.push(opening, response);
    for (const [owner, other] of [[relationshipSpeaker, relationshipListener], [relationshipListener, relationshipSpeaker]]) {
      const directed = relationBetween(owner, other);
      directed.sourceEventIds = [...new Set([...directed.sourceEventIds, openingId, responseId])];
    }
  };
  const completeCasualExchange = (month, startOrder) => {
    relationshipState.clock.elapsedMonths = month;
    const opening = buildDecisionContexts(relationshipState)
      .find((context) => context.person.id === relationshipSpeaker.id)?.options.find((option) => (
        option.nextAction.kind === 'communicate'
          && option.nextAction.content.kind === 'claim'
          && ['everyday', 'reminiscence', 'playful'].includes(option.nextAction.content.conversation?.topic)
    ));
    assert.ok(opening, `month ${month} should expose one naturally co-located casual opening`);
    reserveConversation(relationshipState, opening.nextAction, `decision-casual-open-${month}`, month);
    const openingFact = runAction(relationshipState, relationshipSpeaker, opening.nextAction, month, startOrder);
    const response = buildDecisionContexts(relationshipState)
      .find((context) => context.person.id === relationshipListener.id)?.options.find((option) => option.id.startsWith('respond-conversation:'));
    assert.ok(response, `month ${month} casual opening should expose one optional matching response`);
    assert.equal(response.semantics.obligation, 'optional');
    reserveConversation(relationshipState, response.nextAction, `decision-casual-response-${month}`, month);
    const responseFact = runAction(relationshipState, relationshipListener, response.nextAction, month, startOrder + 1);
    assert.ok(agentMemory.closeConversationWithoutResponse(
      relationshipState,
      relationshipSpeaker.id,
      month,
      'fixture closes this two-line exchange',
    ));
    return [openingFact, responseFact];
  };

  relationshipState.clock.elapsedMonths = 1;
  addSharedMoment(1);
  addDirectCareExchange(1);
  completeCasualExchange(1, 1);
  let companionBasis = buildRelationshipCausalBasis(relationshipState, relationshipSpeaker, relationshipListener, 'companion');
  let reproductionBasis = buildRelationshipCausalBasis(relationshipState, relationshipSpeaker, relationshipListener, 'reproduce');
  assert.equal(hasCultivatedCompanionRelationship(relationshipState, relationshipSpeaker, relationshipListener, companionBasis), false,
    '一月内的一轮闲聊仍不足以从开局熟悉感升级为结伴关系');
  assert.equal(hasSourcedReproductiveRelationship(relationshipState, relationshipSpeaker, relationshipListener, reproductionBasis), false,
    '一个月的共同经历和照护交流仍不足以形成跨月亲密关系');

  addSharedMoment(2);
  completeCasualExchange(2, 1);
  companionBasis = buildRelationshipCausalBasis(relationshipState, relationshipSpeaker, relationshipListener, 'companion');
  reproductionBasis = buildRelationshipCausalBasis(relationshipState, relationshipSpeaker, relationshipListener, 'reproduce');
  assert.equal(hasCultivatedCompanionRelationship(relationshipState, relationshipSpeaker, relationshipListener, companionBasis), true,
    '跨月共同经历达到关系门槛且含直接照护回应后，才形成结伴资格');
  assert.equal(hasSourcedReproductiveRelationship(relationshipState, relationshipSpeaker, relationshipListener, reproductionBasis), true,
    '跨两个自然月、达到关系门槛且含直接照护回应后，人物才可自行考虑生育');
  relationshipState.agreements.push({
    id: 'test-rejected-reproduction',
    proposal: { kind: 'reproduce', proposerId: relationshipSpeaker.id, partnerId: relationshipListener.id, expiresAtMonth: 6, basis: reproductionBasis },
    proposerId: relationshipSpeaker.id, responderId: relationshipListener.id,
    partyIds: [relationshipSpeaker.id, relationshipListener.id], requiredResponderIds: [relationshipListener.id],
    acceptedByPersonIds: [relationshipSpeaker.id], rejectedByPersonIds: [relationshipListener.id],
    status: 'rejected', proposedAtMonth: 2, acceptByMonth: 6, resolvedAtMonth: 2,
    proposalEventId: 'test-rejected-reproduction-offer', responseEventId: 'test-rejected-reproduction-response',
    fulfillmentEventIds: [], fulfilledByPersonIds: [], coLocatedMonths: 0, sourceEventIds: [],
  });
  addSharedMoment(3);
  let afterRenewedRelationship = buildRelationshipCausalBasis(relationshipState, relationshipSpeaker, relationshipListener, 'reproduce');
  assert.equal(canOfferRelationshipProposal(relationshipState, relationshipSpeaker, relationshipListener, afterRenewedRelationship), false,
    '普通共同活动不能单独重开刚被拒绝的生育提议');
  completeCasualExchange(3, 1);
  afterRenewedRelationship = buildRelationshipCausalBasis(relationshipState, relationshipSpeaker, relationshipListener, 'reproduce');
  assert.equal(canOfferRelationshipProposal(relationshipState, relationshipSpeaker, relationshipListener, afterRenewedRelationship), false,
    '普通闲聊可以进入对话史，但不能自动加关系分或把被拒绝的生育提议重新解锁');
  relationshipState.clock.elapsedMonths = 5;
  afterRenewedRelationship = buildRelationshipCausalBasis(relationshipState, relationshipSpeaker, relationshipListener, 'reproduce');
  assert.equal(canOfferRelationshipProposal(relationshipState, relationshipSpeaker, relationshipListener, afterRenewedRelationship), true,
    '拒绝后已有新的真实共同活动时，经过三个月仍可重新评估生育；闲聊事件本身不承担解锁作用');

  const rankingState = createInitialState(3904, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  assert.ok(rankingState.people.length >= 5, '相关性排序需要至少一位说话者和四位可见对象');
  const rankingSpeaker = rankingState.people[0];
  const rankingListeners = rankingState.people.slice(1, 5);
  rankingState.people = [rankingSpeaker, ...rankingListeners];
  rankingState.clock.elapsedMonths = 1;
  for (const person of rankingState.people) {
    person.bornAtMonth = -24 * 12;
    person.conditions = [];
    person.body = { health: 100, hydration: 100, nutrition: 100 };
    if (person.id !== rankingSpeaker.id) placeWith(person, rankingSpeaker);
  }
  const urgentListener = rankingListeners.at(-1);
  const urgentCondition = {
    id: 'test-ranked-listener-condition', kind: 'environment', change: 'condition', atMonth: 1,
    orderInMonth: 0, cellId: urgentListener.position.cellId, who: urgentListener.id,
    result: `${urgentListener.name}受伤`, diff: { condition: 'wound', stage: 2 },
  };
  rankingState.world.past.push(urgentCondition);
  urgentListener.conditions.push({
    id: 'test-ranked-wound', kind: 'wound', stage: 2, sinceMonth: 1,
    sourceEventIds: [urgentCondition.id],
  });
  const groundedTargets = () => [...new Set(
    buildDecisionContexts(rankingState)
      .find((context) => context.person.id === rankingSpeaker.id)?.options
      .filter((option) => option.nextAction.kind === 'communicate'
        && option.nextAction.content.kind === 'claim'
        && option.nextAction.content.conversation?.turn === 'opening')
      .map((option) => option.target?.kind === 'person' ? option.target.personId : '')
      .filter(Boolean),
  )].sort();
  const firstOrderTargets = groundedTargets();
  assert.ok(firstOrderTargets.includes(urgentListener.id),
    '第四位人有真实当前处境时不得被 visiblePeople 的前三个身份截断');
  rankingState.people = [rankingSpeaker, ...[...rankingListeners].reverse()];
  assert.deepEqual(groundedTargets(), firstOrderTargets,
    '相关对象选择应由处境、关系、共同来源与距离决定，不得随人物数组顺序改变');
  rankingState.clock.elapsedMonths = 2;
  const secondMonthTargets = groundedTargets();
  assert.ok(secondMonthTargets.includes(urgentListener.id), '高相关的当前身体处境在轮换时仍应保留');
  assert.notDeepEqual(secondMonthTargets, firstOrderTargets,
    '完全同档的其余共处者应按月稳定轮换，不能永远固定同三个 ID');
  rankingState.people = [rankingSpeaker, ...rankingListeners];
  assert.deepEqual(groundedTargets(), secondMonthTargets,
    '跨月轮换必须保持同月可重放，不受人物数组顺序影响');
  assert.deepEqual(
    [...new Set([...firstOrderTargets, ...secondMonthTargets])].sort(),
    rankingListeners.map((person) => person.id).sort(),
    '相关性容量有界，但同档合法共处者不应永久失去对话机会',
  );

  const failureState = createInitialState(3905, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const failureSpeaker = failureState.people[0];
  const failureListener = failureState.people[1];
  failureState.people = [failureSpeaker, failureListener];
  placeWith(failureListener, failureSpeaker);
  failureState.clock.elapsedMonths = 1;
  for (const person of failureState.people) {
    person.bornAtMonth = -24 * 12;
    person.conditions = [];
    person.body = { health: 100, hydration: 100, nutrition: 100 };
  }
  const blockedConversation = {
    id: 'test-blocked-conversation', kind: 'action', atMonth: 1, orderInMonth: 0, actionTick: 1,
    cellId: failureSpeaker.position.cellId, who: failureSpeaker.id, cause: 'intent',
    action: {
      kind: 'communicate', audience: [failureListener.id], channel: 'voice',
      content: { id: 'test-duplicate-response', kind: 'claim', summary: '重复回应一次已经结束的谈话' },
    },
    fromCellId: failureSpeaker.position.cellId, toCellId: failureSpeaker.position.cellId,
    fromZ: failureSpeaker.position.z, toZ: failureSpeaker.position.z, pathSegment: [],
    status: 'blocked', result: '同一段谈话已经回应过，无法再次回应', diff: {},
  };
  const blockedMove = {
    ...blockedConversation,
    id: 'test-blocked-physical-action', orderInMonth: 1,
    action: { kind: 'move', toCellId: failureSpeaker.position.cellId, toZ: failureSpeaker.position.z + 1 },
    result: '前路被实体挡住，没能到达目标位置',
  };
  failureState.world.past.push(blockedConversation, blockedMove);
  failureSpeaker.memories.push(
    {
      id: 'memory-blocked-conversation', kind: 'failure', summary: '想重复回应谈话但被阻塞',
      importance: 95, createdAtMonth: 1, lastRecalledAtMonth: 1, expiresAtMonth: 7,
      personIds: [failureListener.id], sourceEventIds: [blockedConversation.id],
      causal: {
        basisKey: 'test|blocked-conversation', actionKind: 'communicate', outcome: 'blocked',
        valence: -0.6, consequenceTags: ['blocked'],
      },
    },
    {
      id: 'memory-blocked-move', kind: 'failure', summary: '去取水的路被挡住了',
      importance: 80, createdAtMonth: 1, lastRecalledAtMonth: 1, expiresAtMonth: 7,
      personIds: [], sourceEventIds: [blockedMove.id],
      causal: {
        basisKey: 'test|blocked-move', actionKind: 'move', outcome: 'blocked',
        valence: -0.5, consequenceTags: ['blocked'],
      },
    },
  );
  const failureConversationOptions = buildGroundedConversationOptions(
    failureState,
    failureSpeaker,
    [failureListener],
    1,
  );
  assert.equal(failureConversationOptions.some((option) => (
    option.nextAction.kind === 'communicate'
      && option.nextAction.content.kind === 'claim'
      && option.nextAction.content.conversation?.topic === 'failure'
      && option.sourceFactIds.includes(blockedConversation.id)
  )), false, 'blocked communicate 只是沟通协议失败，不得循环生成一场复盘它的对话');
  assert.equal(failureConversationOptions.some((option) => (
    option.nextAction.kind === 'communicate'
      && option.nextAction.content.kind === 'claim'
      && option.nextAction.content.conversation?.topic === 'failure'
      && option.sourceFactIds.includes(blockedMove.id)
  )), true, '有来源的非沟通行动失败仍可成为人物主动复盘的真实经历');

  const teachingState = createInitialState(3902, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const teacher = teachingState.people[0];
  const learner = teachingState.people[1];
  teachingState.people = [teacher, learner];
  placeWith(learner, teacher);
  learner.bornAtMonth = -12 * 12;
  const techniqueId = 'technique:test-grounded-conversation';
  teacher.knowledge.push({ id: techniqueId, kind: 'technique', summary: '测试技术', confidence: 80, learnedAtMonth: 0, sourceEventIds: [teachingState.world.past[0].id] });
  const teachingRelationBefore = structuredClone(relation(teacher, learner));
  const teachingEvent = runAction(teachingState, teacher, {
    kind: 'communicate', content: { id: `teach:${teacher.id}:${learner.id}:${techniqueId}`, kind: 'claim', factId: techniqueId, summary: '测试技术' },
    audience: [learner.id], channel: 'voice',
  }, 1, 0);
  assert.equal(teachingEvent.status, 'completed');
  assert.equal(relation(teacher, learner).bond, teachingRelationBefore.bond, '明确教学只传知识，不应顺带刷关系');
  const teachingBasis = buildRelationshipCausalBasis(teachingState, teacher, learner, 'reproduce');
  assert.equal(teachingBasis.relationshipKeys.includes(teachingEvent.id), false, '教学不得成为亲密关系的充分证据');

  console.log('grounded conversation tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
