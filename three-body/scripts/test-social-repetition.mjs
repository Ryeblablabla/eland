import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-social-repetition-test-'));
const bundlePath = path.join(temporaryDirectory, 'social-repetition.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { buildDecisionContext } from ${JSON.stringify(path.resolve('src/game/eland/application/action-options.ts'))};
    export { buildDecisionRequestContext } from ${JSON.stringify(path.resolve('src/game/eland/application/model-decision/index.ts'))};
    export { evaluateDecisionOption } from ${JSON.stringify(path.resolve('src/game/eland/application/decision-factor-forest.ts'))};
    export { RulePlanner } from ${JSON.stringify(path.resolve('src/game/eland/application/rule-planner.ts'))};
    export { assessSocialRepetition } from ${JSON.stringify(path.resolve('src/game/eland/domain/social-repetition.ts'))};
    export { recordAgreementAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/agreement.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=social-repetition-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    assessSocialRepetition,
    buildDecisionContext,
    buildDecisionRequestContext,
    createInitialState,
    evaluateDecisionOption,
    Material,
    recordAgreementAction,
    RulePlanner,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const placeWith = (person, other) => {
    person.position.cellId = other.position.cellId;
    person.position.z = other.position.z;
    person.position.previousCellId = other.position.cellId;
    person.position.previousZ = other.position.z;
  };
  const eventAt = (id, atMonth, cellId, who, change = 'resource') => ({
    id, kind: 'environment', change, atMonth, orderInMonth: 0, cellId, who,
    result: id, diff: {},
  });
  const actionFact = (id, atMonth, actor, action, intentId) => ({
    id, kind: 'action', actionTick: 1, planningTick: 1, orderInTick: 0,
    atMonth, orderInMonth: 0, cellId: actor.position.cellId, who: actor.id,
    cause: 'intent', action, intentId,
    fromCellId: actor.position.cellId, toCellId: actor.position.cellId,
    fromZ: actor.position.z, toZ: actor.position.z,
    pathSegment: [actor.position.cellId], status: 'completed', result: id,
    diff: { audience: action.kind === 'communicate' ? [...action.audience] : [] },
  });
  const dialogueMemory = (id, atMonth, otherId, sourceEventId) => ({
    id, kind: 'dialogue', summary: '曾经向同一人提出过同一主题', importance: 72,
    createdAtMonth: atMonth, lastRecalledAtMonth: atMonth,
    personIds: [otherId], sourceEventIds: [sourceEventId],
  });
  const onlyOptionContext = (context, option) => ({
    ...context,
    options: [option],
    followUpOptions: [],
    activeIntent: undefined,
  });

  const state = createInitialState(26082001, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const speaker = state.people[0];
  const listener = state.people[1];
  state.people = [speaker, listener];
  speaker.bornAtMonth = -24 * 12;
  listener.bornAtMonth = -24 * 12;
  speaker.conditions = [];
  listener.conditions = [];
  speaker.body = { health: 100, hydration: 100, nutrition: 100 };
  listener.body = { health: 100, hydration: 100, nutrition: 100 };
  for (const relation of speaker.relations) Object.assign(relation, { trust: 0, bond: 0, fear: 0 });
  for (const relation of listener.relations) Object.assign(relation, { trust: 0, bond: 0, fear: 0 });
  placeWith(listener, speaker);

  const woodSource = eventAt('test-social-repeat-wood-source', 0, speaker.position.cellId, speaker.id);
  const stoneSource = eventAt('test-social-repeat-stone-source', 0, listener.position.cellId, listener.id);
  state.world.past.push(woodSource, stoneSource);
  speaker.inventory = [{ id: 'test-social-repeat-wood', materialId: Material.Wood, quantity: 2, sourceEventIds: [woodSource.id] }];
  listener.inventory = [{ id: 'test-social-repeat-stone', materialId: Material.Stone, quantity: 2, sourceEventIds: [stoneSource.id] }];

  state.clock.elapsedMonths = 1;
  const initialContext = buildDecisionContext(state, speaker);
  const firstOffer = initialContext.options.find((option) => option.id.startsWith('offer-exchange:'));
  assert.ok(firstOffer?.nextAction.kind === 'communicate', '测试前提需要一个可选交换发起');

  const previousAction = structuredClone(firstOffer.nextAction);
  previousAction.content.id = 'test-social-repeat-previous-offer';
  const previousIntentId = 'test-social-repeat-previous-intent';
  state.intents.push({
    id: previousIntentId, ownerId: speaker.id, summary: '先前提出同类交换', domain: 'social',
    goal: { kind: 'representation-made', representationId: previousAction.content.id },
    nextAction: previousAction, target: { kind: 'person', personId: listener.id },
    status: 'completed', createdAtMonth: 1, lastProgressAtMonth: 1, completedAtMonth: 1,
    progress: 1, sourceFactIds: [woodSource.id, stoneSource.id], actionEventIds: [], replanCount: 0,
  });
  const previousEvent = actionFact('test-social-repeat-previous-event', 1, speaker, previousAction, previousIntentId);
  state.world.past.push(previousEvent);
  state.intents[0].actionEventIds.push(previousEvent.id);
  speaker.memories.push(dialogueMemory('test-social-repeat-memory', 1, listener.id, previousEvent.id));
  recordAgreementAction(state, previousEvent);

  const pendingState = structuredClone(state);
  const pendingSpeaker = pendingState.people.find((person) => person.id === speaker.id);
  const pendingListener = pendingState.people.find((person) => person.id === listener.id);
  assert.ok(pendingSpeaker && pendingListener, '未决协议场景必须保留说话双方');
  pendingState.clock.elapsedMonths = 2;
  assert.equal(
    buildDecisionContext(pendingState, pendingSpeaker).options.some((option) => option.id.startsWith('offer-exchange:')),
    false,
    '同一双方仍有未决 outgoing exchange 时不得再生成第二份同义协议',
  );

  const previousRejection = actionFact('test-social-repeat-previous-rejection', 1, listener, {
    kind: 'communicate',
    content: { id: 'test-social-repeat-previous-rejection-content', kind: 'reject', referenceId: previousAction.content.id },
    audience: [speaker.id], channel: 'voice',
  });
  recordAgreementAction(state, previousRejection);
  state.world.past.push(previousRejection);
  speaker.memories.push(dialogueMemory('test-social-repeat-rejection-memory', 1, listener.id, previousRejection.id));

  state.clock.elapsedMonths = 2;
  const repeatedContext = buildDecisionContext(state, speaker);
  const repeatedOffer = repeatedContext.options.find((option) => option.id.startsWith('offer-exchange:'));
  assert.ok(repeatedOffer, '固定两个月过滤应已移除：记得上月同主题后，候选仍须交给人物权衡');

  const repeatedAssessment = assessSocialRepetition(state, speaker, repeatedOffer);
  assert.ok(repeatedAssessment.score <= -82, '没有新证据的同主题发起应承担显著重复成本');
  assert.equal(repeatedAssessment.previousCommunicationEventId, previousEvent.id);
  assert.deepEqual(repeatedAssessment.newEvidenceEventIds, []);
  const repeatedEvaluation = evaluateDecisionOption(repeatedContext, repeatedOffer, { atMonth: 2, planningTick: 1 });
  assert.ok(repeatedEvaluation.votes.some((vote) => vote.tree === 'social-repetition' && vote.score <= -82), '因子林必须显式审计社会重复票');
  const repeatedModelOption = buildDecisionRequestContext(repeatedContext).options.find((option) => option.id === repeatedOffer.id);
  assert.ok(repeatedModelOption?.socialRepetition.score <= -82, '模型上下文必须看到与本地因子林一致的重复成本');
  assert.equal(repeatedModelOption?.socialRepetition.rememberedBefore, true);
  assert.equal(repeatedModelOption?.socialRepetition.hasNewEvidence, false);
  assert.equal(
    new RulePlanner().decideAt(onlyOptionContext(repeatedContext, repeatedOffer), { atMonth: 2, planningTick: 1 }).kind,
    'idle',
    '身体安全且没有新情况时，重复主题不应仅因仍然合法就被再次选择',
  );

  const evidenceState = structuredClone(state);
  const evidenceSpeaker = evidenceState.people.find((person) => person.id === speaker.id);
  assert.ok(evidenceSpeaker, '新证据场景必须保留说话者');
  const newMaterialFact = eventAt('test-social-repeat-new-material-fact', 2, evidenceSpeaker.position.cellId, evidenceSpeaker.id);
  evidenceState.world.past.push(newMaterialFact);
  evidenceSpeaker.inventory[0].sourceEventIds.push(newMaterialFact.id);
  evidenceState.clock.elapsedMonths = 3;
  const evidenceContext = buildDecisionContext(evidenceState, evidenceSpeaker);
  const evidenceOffer = evidenceContext.options.find((option) => option.id.startsWith('offer-exchange:'));
  assert.ok(evidenceOffer, '同一主题出现新事实后仍应存在可选发起');
  const evidenceAssessment = assessSocialRepetition(evidenceState, evidenceSpeaker, evidenceOffer);
  assert.ok(evidenceAssessment.score > 0 && evidenceAssessment.newEvidenceEventIds.includes(newMaterialFact.id), '新事实应抵消旧话题的重复成本并留下来源');
  assert.equal(
    new RulePlanner().decideAt(onlyOptionContext(evidenceContext, evidenceOffer), { atMonth: 3, planningTick: 1 }).kind,
    'start',
    '新事实使同一主题重新有价值时，人物应能再次选择开口',
  );

  const emergencyState = structuredClone(state);
  const emergencySpeaker = emergencyState.people.find((person) => person.id === speaker.id);
  const emergencyListener = emergencyState.people.find((person) => person.id === listener.id);
  assert.ok(emergencySpeaker && emergencyListener, '紧急压力场景必须保留说话双方');
  const previousAssistAction = {
    kind: 'communicate',
    content: {
      id: 'test-social-repeat-previous-water-assist', kind: 'request', summary: '请帮助我找到水',
      proposal: {
        kind: 'assist', requesterId: emergencySpeaker.id, helperId: emergencyListener.id,
        need: 'water', expiresAtMonth: 1,
      },
    },
    audience: [emergencyListener.id], channel: 'voice',
  };
  const previousAssistEvent = actionFact('test-social-repeat-previous-water-assist-event', 1, emergencySpeaker, previousAssistAction);
  emergencyState.world.past.push(previousAssistEvent);
  emergencySpeaker.memories.push(dialogueMemory(
    'test-social-repeat-water-assist-memory',
    1,
    emergencyListener.id,
    previousAssistEvent.id,
  ));
  recordAgreementAction(emergencyState, previousAssistEvent);
  const previousAssistAgreement = emergencyState.agreements.find((candidate) => candidate.id === previousAssistAction.content.id);
  assert.ok(previousAssistAgreement, '旧求助应留下可追溯协议结果');
  previousAssistAgreement.status = 'expired';
  previousAssistAgreement.resolvedAtMonth = 2;
  emergencySpeaker.body.hydration = 5;
  emergencyState.clock.elapsedMonths = 3;
  const emergencyContext = buildDecisionContext(emergencyState, emergencySpeaker);
  const emergencyExchange = emergencyContext.options.find((option) => option.id.startsWith('offer-exchange:'));
  assert.ok(emergencyExchange, '无关主题仍应保持为可权衡候选');
  assert.ok(assessSocialRepetition(emergencyState, emergencySpeaker, emergencyExchange).score <= -82, '缺水不能为无关的重复交换提供紧迫度加成');
  const emergencyOffer = emergencyContext.options.find((option) => option.id.startsWith('request-assist:')
    && option.nextAction.kind === 'communicate'
    && option.nextAction.content.kind === 'request'
    && option.nextAction.content.proposal?.kind === 'assist'
    && option.nextAction.content.proposal.need === 'water');
  assert.ok(emergencyOffer, '真实缺水压力应允许重新形成同受众的求水候选');
  const emergencyAssessment = assessSocialRepetition(emergencyState, emergencySpeaker, emergencyOffer);
  assert.ok(emergencyAssessment.score > 0 && emergencyAssessment.newEvidenceEventIds.length === 0, '显著生存危险应能在没有新话题事实时提高再次开口价值');
  assert.equal(
    new RulePlanner().decideAt(onlyOptionContext(emergencyContext, emergencyOffer), { atMonth: 3, planningTick: 1 }).kind,
    'start',
    '紧急压力足够高时，人物应能重新发起同一主题',
  );

  const listenerContext = buildDecisionContext(pendingState, pendingListener);
  assert.ok(listenerContext.options.length > 0 && listenerContext.options.every((option) => /^(accept|reject)-exchange:/.test(option.id)), '未决交换仍必须把指定回应者限制在协议回应候选');
  const acceptOption = listenerContext.options.find((option) => option.id.startsWith('accept-exchange:'));
  assert.ok(acceptOption, '有履行能力的指定回应者必须保留接受候选');
  assert.equal(assessSocialRepetition(pendingState, pendingListener, acceptOption).score, 0, 'required response 不得承担可选发起的重复成本');
  const requiredModelOption = buildDecisionRequestContext(listenerContext).options.find((option) => option.id === acceptOption.id);
  assert.equal(requiredModelOption?.socialRepetition, undefined, 'required response 不应携带可选社交发起的重复成本字段');
  assert.equal(
    new RulePlanner().decideAt(onlyOptionContext(listenerContext, acceptOption), { atMonth: 2, planningTick: 1 }).kind,
    'start',
    'required response 仍应被规则规划器选择',
  );

  const acceptance = actionFact('test-social-repeat-acceptance', 2, pendingListener, acceptOption.nextAction);
  recordAgreementAction(pendingState, acceptance);
  const agreement = pendingState.agreements.find((candidate) => candidate.id === previousAction.content.id);
  assert.equal(agreement?.status, 'active', '一次合法接受仍应激活原协议');
  const duplicateRejection = actionFact('test-social-repeat-duplicate-rejection', 2, pendingListener, {
    kind: 'communicate',
    content: { id: 'test-social-repeat-duplicate-rejection-content', kind: 'reject', referenceId: previousAction.content.id },
    audience: [pendingSpeaker.id], channel: 'voice',
  });
  recordAgreementAction(pendingState, duplicateRejection);
  assert.equal(agreement?.status, 'active', '协议激活后，同一人不能再用第二次回应改写状态');
  assert.deepEqual(agreement?.acceptedByPersonIds.filter((personId) => personId === pendingListener.id), [pendingListener.id], '同一协议回应者只能被记录一次');
  assert.deepEqual(agreement?.rejectedByPersonIds, [], '重复拒绝不得污染已激活协议');

  console.log('social repetition tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
