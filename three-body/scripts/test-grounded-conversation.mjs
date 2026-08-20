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

try {
  for (const [entry, output] of [
    ['src/game/eland/simulation.ts', simulationBundlePath],
    ['src/game/eland/domain/action-executor.ts', executorBundlePath],
    ['src/game/eland/domain/relationship-evidence.ts', relationshipBundlePath],
    ['src/game/eland/world/grid.ts', gridBundlePath],
  ]) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
    ], { stdio: 'pipe' });
  }

  const { buildDecisionContexts, createInitialState } = await import(`${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`);
  const { executePrimitiveAction } = await import(`${pathToFileURL(executorBundlePath).href}?test=${Date.now()}`);
  const { buildRelationshipCausalBasis } = await import(`${pathToFileURL(relationshipBundlePath).href}?test=${Date.now()}`);
  const { cellsInRadius, findStandingPath, standingPositions } = await import(`${pathToFileURL(gridBundlePath).href}?test=${Date.now()}`);

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

  const state = createInitialState(3901, { endpoint: { kind: 'months', value: 3 }, chaosIntensity: 0 });
  const speaker = state.people[0];
  const listener = state.people[1];
  state.people = [speaker, listener];
  placeWith(listener, speaker);
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
  assert.equal(contexts.find((context) => context.person.id === speaker.id)?.options.some((option) => option.id.startsWith('meet:')), false, '不得生成没有后续行动的通用会合');

  placeWith(listener, speaker);
  contexts = buildDecisionContexts(state);
  const localOpeningOption = contexts.find((context) => context.person.id === speaker.id)?.options.find((option) => (
    option.id.startsWith('conversation:care:')
      && option.target?.kind === 'person'
      && option.target.personId === listener.id
  ));
  assert.equal(localOpeningOption?.nextAction.kind, 'communicate', '已经同地时应直接交谈');

  const speakerBefore = structuredClone(relation(speaker, listener));
  const listenerBefore = structuredClone(relation(listener, speaker));
  const openingEvent = runAction(state, speaker, localOpeningOption.nextAction, 1, 1);
  assert.equal(openingEvent.status, 'completed');
  assert.equal(openingEvent.diff.groundedConversationTurn, 'opening');
  assert.equal(relation(speaker, listener).bond - speakerBefore.bond, 2, '照护开场应增加两点羁绊');
  assert.equal(relation(speaker, listener).trust - speakerBefore.trust, 1, '照护开场应增加一点信任');
  assert.equal(relation(listener, speaker).bond - listenerBefore.bond, 2, '开场关系变化必须双向留下事件来源');

  contexts = buildDecisionContexts(state);
  const responseOption = contexts.find((context) => context.person.id === listener.id)?.options.find((option) => option.id.startsWith('respond-conversation:'));
  assert.ok(responseOption, '被点名者必须获得对原开场的回应选项');
  assert.equal(contexts.find((context) => context.person.id === listener.id)?.options.every((option) => option.id.startsWith('respond-conversation:')), true, '未回应的生活开场应优先于可选规划');
  const responseEvent = runAction(state, listener, responseOption.nextAction, 1, 2);
  assert.equal(responseEvent.status, 'completed');
  assert.equal(responseEvent.diff.groundedConversationReferenceEventId, openingEvent.id);
  assert.equal(relation(speaker, listener).bond - speakerBefore.bond, 4, '完整支持性两轮聊天应累计四点羁绊');
  assert.equal(relation(speaker, listener).trust - speakerBefore.trust, 2, '完整支持性两轮聊天应累计两点信任');
  assert.ok(speaker.memories.some((memory) => memory.sourceEventIds.includes(openingEvent.id)), '说话者应记住自己的生活开场');
  assert.ok(listener.memories.some((memory) => memory.sourceEventIds.includes(responseEvent.id)), '回应者应记住自己的回应');

  const relationshipBasis = buildRelationshipCausalBasis(state, speaker, listener, 'reproduce');
  assert.ok(relationshipBasis.relationshipKeys.includes(openingEvent.id));
  assert.ok(relationshipBasis.relationshipKeys.includes(responseEvent.id), '验证通过的双向生活聊天应成为关系提议的真实依据');
  contexts = buildDecisionContexts(state);
  assert.equal(contexts.find((context) => context.person.id === speaker.id)?.options.some((option) => option.nextAction.kind === 'communicate'
    && option.nextAction.content.kind === 'claim'
    && option.nextAction.content.conversation?.basisKey === openingEvent.diff.groundedConversationBasisKey), false, '同一生活基础不能再次生成开场');

  const duplicateResponseAction = structuredClone(responseOption.nextAction);
  duplicateResponseAction.content.id = 'respond-conversation:duplicate';
  const duplicateResponse = runAction(state, listener, duplicateResponseAction, 1, 3);
  assert.equal(duplicateResponse.status, 'blocked', '同一开场不能重复回应刷关系');

  const forgedAction = structuredClone(localOpeningOption.nextAction);
  forgedAction.content.id = 'conversation:care:forged';
  forgedAction.content.conversation.basisKey = 'grounded-conversation-v1|forged';
  forgedAction.content.conversation.sourceFactIds = ['missing-source-event'];
  const forgedEvent = runAction(state, speaker, forgedAction, 1, 4);
  assert.equal(forgedEvent.status, 'blocked', '无法解析的生活来源必须阻塞');

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
