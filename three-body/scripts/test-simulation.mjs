import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-monthly-test-'));
const bundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const agreementBundlePath = path.join(temporaryDirectory, 'agreement.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/simulation.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/domain/agreement.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${agreementBundlePath}`,
  ], { stdio: 'pipe' });
  const { buildDecisionContexts, createInitialState, createSimulation, seededFraction, stepSimulation, stepSimulationAsync } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const { advanceAgreementLifecycle, recordAgreementAction } = await import(`${pathToFileURL(agreementBundlePath).href}?test=${Date.now()}`);

  const initial = createInitialState(31, { endpoint: { kind: 'months', value: 180 } });
  assert.equal(initial.schemaVersion, 14);
  assert.deepEqual(initial.clock, { unit: 'month', elapsedMonths: 0, monthsPerYear: 12 });
  assert.equal(initial.world.grid.width, 84);
  assert.equal(initial.world.grid.depth, 52);
  assert.equal(initial.world.grid.levels, 12);
  assert.equal(initial.world.grid.voxels.length, 84 * 52 * 12);
  assert.ok(Array.from({ length: 1_000 }, (_, index) => seededFraction(31, `range:${index}`)).every((value) => value >= 0 && value < 1), '确定性随机采样必须始终位于 [0, 1)');
  assert.ok(initial.people.every((person) => Number.isInteger(person.position.cellId) && person.inventory.length > 0));
  assert.equal('agents' in initial, false, '权威状态不应保留旧 Agent 模型');
  assert.equal('plans' in initial, false, '权威状态不应保留 PlanMode');
  assert.equal('cells' in initial.world.grid, false, '格子不应保留属性包');
  assert.ok(initial.people.every((person) => person.relations.every((relation) => relation.trust === 0 && relation.bond === 0 && relation.sourceEventIds.length === 0)), '开局关系不得包含无事件来源的信任或亲近');

  const agreementState = createInitialState(31, { endpoint: { kind: 'months', value: 24 } });
  const requester = agreementState.people[0];
  const helper = agreementState.people[1];
  const agreementId = 'test-assist-agreement';
  const actionFact = (id, atMonth, who, action) => ({ id, kind: 'action', actionTick: 1, atMonth, orderInMonth: 0, cellId: requester.position.cellId, who, cause: 'intent', action, fromCellId: requester.position.cellId, toCellId: requester.position.cellId, pathSegment: [requester.position.cellId], status: 'completed', result: id, diff: {} });
  const proposal = actionFact('test-proposal', 1, requester.id, { kind: 'communicate', content: { id: agreementId, kind: 'request', summary: '请给我一份食物', proposal: { kind: 'assist', requesterId: requester.id, helperId: helper.id, need: 'food', expiresAtMonth: 3 } }, audience: [helper.id], channel: 'voice' });
  recordAgreementAction(agreementState, proposal);
  agreementState.world.past.push(proposal);
  assert.equal(agreementState.agreements[0]?.status, 'proposed', '结构化求助应创建待回应 Agreement');
  const acceptance = actionFact('test-acceptance', 2, helper.id, { kind: 'communicate', content: { id: 'test-acceptance-content', kind: 'accept', referenceId: agreementId }, audience: [requester.id], channel: 'voice' });
  recordAgreementAction(agreementState, acceptance);
  agreementState.world.past.push(acceptance);
  assert.equal(agreementState.agreements[0]?.status, 'active', '指定回应者接受后 Agreement 才生效');
  assert.equal(requester.relations.find((relation) => relation.personId === helper.id)?.trust, 0, '接受承诺本身不能增加信任');
  const fulfillment = actionFact('test-fulfillment', 3, helper.id, { kind: 'transfer', materialId: 21, quantity: 1, from: { kind: 'person', personId: helper.id }, to: { kind: 'person', personId: requester.id }, authorizationRef: agreementId });
  recordAgreementAction(agreementState, fulfillment);
  assert.equal(agreementState.agreements[0]?.status, 'fulfilled', '真实物质转移应履行求助 Agreement');
  assert.ok((requester.relations.find((relation) => relation.personId === helper.id)?.trust ?? 0) > 0, '履约事实应成为信任来源');

  const witnessedViolenceState = createInitialState(310, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const attacker = witnessedViolenceState.people[0];
  const victim = witnessedViolenceState.people[1];
  const witness = witnessedViolenceState.people[2];
  victim.position.cellId = attacker.position.cellId;
  witness.position.cellId = attacker.position.cellId;
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
    async decideAll() { throw new Error('固定暴力动作不应额外调用模型'); },
    takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
  });
  const violenceFact = afterViolence.world.past.find((event) => event.kind === 'action'
    && event.action.kind === 'act'
    && event.action.operation === 'exert'
    && event.diff.victimId === victim.id);
  assert.ok(violenceFact, '施力伤害应留下带受害者与见证者的真实动作事实');
  for (const observerId of [victim.id, witness.id]) assert.ok(afterViolence.people.find((person) => person.id === observerId)?.memories.some((memory) => memory.sourceEventIds.includes(violenceFact.id)), '受害者与见证者都必须记得同一暴力事件，供后续模型意图使用');

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
  const waterAssistId = 'test-water-assist';
  const waterProposal = { ...actionFact('test-water-proposal', 1, waterRequester.id, { kind: 'communicate', content: { id: waterAssistId, kind: 'request', summary: '请帮助我找水', proposal: { kind: 'assist', requesterId: waterRequester.id, helperId: waterHelper.id, need: 'water', expiresAtMonth: 4 } }, audience: [waterHelper.id], channel: 'voice' }), cellId: waterBank };
  recordAgreementAction(waterAssistState, waterProposal);
  const waterAcceptance = { ...actionFact('test-water-acceptance', 2, waterHelper.id, { kind: 'communicate', content: { id: 'test-water-acceptance-content', kind: 'accept', referenceId: waterAssistId }, audience: [waterRequester.id], channel: 'voice' }), cellId: waterBank };
  recordAgreementAction(waterAssistState, waterAcceptance);
  const helperArrival = { ...actionFact('test-water-helper-arrival', 3, waterHelper.id, { kind: 'move', toCellId: waterBank }), cellId: waterBank, toCellId: waterBank };
  recordAgreementAction(waterAssistState, helperArrival);
  assert.equal(waterAssistState.agreements[0]?.status, 'active', '帮助者独自到达水边还不能算完成求助');
  const requesterDrink = { ...actionFact('test-water-requester-drink', 3, waterRequester.id, { kind: 'act', operation: 'ingest', targets: [] }), cellId: waterBank, diff: { materialId: 7, hydration: 58 } };
  recordAgreementAction(waterAssistState, requesterDrink);
  assert.equal(waterAssistState.agreements[0]?.status, 'fulfilled', '帮助者到场且求助者真实饮水后，水求助才履约');

  const companionState = createInitialState(33, { endpoint: { kind: 'months', value: 36 } });
  const companionA = companionState.people[0];
  const companionB = companionState.people[1];
  companionB.position.cellId = companionA.position.cellId;
  const companionId = 'test-companion-agreement';
  recordAgreementAction(companionState, actionFact('test-companion-proposal', 1, companionA.id, { kind: 'communicate', content: { id: companionId, kind: 'offer', summary: '结伴', proposal: { kind: 'companion', proposerId: companionA.id, partnerId: companionB.id, expiresAtMonth: 4 } }, audience: [companionB.id], channel: 'voice' }));
  recordAgreementAction(companionState, actionFact('test-companion-acceptance', 2, companionB.id, { kind: 'communicate', content: { id: 'test-companion-acceptance-content', kind: 'accept', referenceId: companionId }, audience: [companionA.id], channel: 'voice' }));
  for (let month = 3; month <= 27; month += 1) advanceAgreementLifecycle(companionState, month);
  assert.equal(companionState.agreements[0]?.status, 'fulfilled', '结伴必须由足够月份的实际共处履行');
  assert.ok((companionState.agreements[0]?.coLocatedMonths ?? 0) >= 12);

  const breachState = createInitialState(32, { endpoint: { kind: 'months', value: 24 } });
  const breachRequester = breachState.people[0];
  const breachHelper = breachState.people[1];
  const breachId = 'test-breach-agreement';
  const breachProposal = actionFact('test-breach-proposal', 1, breachRequester.id, { kind: 'communicate', content: { id: breachId, kind: 'request', summary: '请帮助我', proposal: { kind: 'assist', requesterId: breachRequester.id, helperId: breachHelper.id, need: 'food', expiresAtMonth: 3 } }, audience: [breachHelper.id], channel: 'voice' });
  recordAgreementAction(breachState, breachProposal);
  breachState.world.past.push(breachProposal);
  const breachAcceptance = actionFact('test-breach-acceptance', 2, breachHelper.id, { kind: 'communicate', content: { id: 'test-breach-acceptance-content', kind: 'accept', referenceId: breachId }, audience: [breachRequester.id], channel: 'voice' });
  recordAgreementAction(breachState, breachAcceptance);
  breachState.world.past.push(breachAcceptance);
  advanceAgreementLifecycle(breachState, 9);
  assert.equal(breachState.agreements[0]?.status, 'breached', '超过履行期限的有效 Agreement 应明确违约');

  const birthState = createInitialState(312, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const mother = birthState.people.find((person) => person.sex === 'female');
  const father = birthState.people.find((person) => person.sex === 'male');
  assert.ok(mother && father, '出生关系测试需要一名女性和一名男性');
  mother.conditions.push({ id: 'test-due-pregnancy', kind: 'pregnancy', stage: 3, sinceMonth: -8, dueAtMonth: 1, otherPersonId: father.id, sourceEventIds: ['test-conception'] });
  const afterBirth = stepSimulation(birthState, { decide() { return { kind: 'idle', reason: '不干扰出生测试' }; } });
  const child = afterBirth.people.find((person) => person.generation > 0);
  const birthEvent = afterBirth.world.past.find((event) => event.kind === 'environment' && event.diff.bornPersonId === child?.id);
  assert.ok(child && birthEvent, '到期妊娠应产生有来源的出生事实');
  for (const parentId of child.geneticParents) {
    const childToParent = child.relations.find((relation) => relation.personId === parentId);
    const parentToChild = afterBirth.people.find((person) => person.id === parentId)?.relations.find((relation) => relation.personId === child.id);
    assert.equal(childToParent?.bond, 12, '孩子指向亲生父母的亲近应来自出生事实');
    assert.equal(parentToChild?.bond, 12, '亲生父母指向孩子的亲近应与出生事实对称');
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
  assert.ok(carryFact && carriedChild?.position.cellId === caredChildState.people.find((person) => person.id === caregiver.id)?.position.cellId, '父母移动必须真实携带三岁以下孩子并写入动作事实');
  const activeCaregiver = caredChildState.people.find((person) => person.id === caregiver.id);
  activeCaregiver.body = { health: 100, hydration: 100, nutrition: 100 };
  activeCaregiver.inventory.push({ id: 'test-child-food', materialId: 21, quantity: 1, sourceEventIds: [] });
  carriedChild.body.nutrition = 20;
  caredChildState = stepSimulation(caredChildState, { decide() { return { kind: 'idle', reason: '不干扰喂养测试' }; } });
  const feeding = caredChildState.world.past.find((event) => event.kind === 'action' && event.action.kind === 'transfer' && event.action.to.kind === 'person' && event.action.to.personId === child.id);
  assert.ok(feeding && caredChildState.people.find((person) => person.id === child.id)?.body.nutrition > 20, '幼儿营养危险时，父母应转移真实食物，幼儿再通过摄入恢复');
  assert.ok(caredChildState.derived.milestones.some((milestone) => milestone.id === '3'), '携带和真实喂养的事实链应被观察为养育幼儿');

  const agingState = createInitialState(313, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const elder = agingState.people[0];
  elder.bornAtMonth = -elder.lifespanMonths;
  elder.body = { health: 100, hydration: 100, nutrition: 100 };
  const afterBaseline = stepSimulation(agingState, { decide() { return { kind: 'idle', reason: '不干扰衰老测试' }; } });
  assert.equal(afterBaseline.people.find((person) => person.id === elder.id)?.diedAtMonth, undefined, '达到寿命基线月份不能在身体健康时被日期直接杀死');

  let dialogueState = createInitialState(31, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const speaker = dialogueState.people[0];
  const listener = dialogueState.people[1];
  listener.position.cellId = speaker.position.cellId;
  listener.position.previousCellId = speaker.position.cellId;
  const dialogueContext = buildDecisionContexts(dialogueState).find((context) => context.person.id === speaker.id);
  assert.ok(dialogueContext, '测试人物必须拥有决策上下文');
  const collectMaterials = dialogueContext.options.filter((option) => option.id.startsWith('collect:')).map((option) => option.goal.kind === 'inventory-at-least' ? option.goal.materialId : -1);
  assert.equal(new Set(collectMaterials).size, collectMaterials.length, '同一物质只应暴露最近的一项取得机会');
  assert.ok(dialogueContext.options.some((option) => option.requiresFollowUp) && dialogueContext.followUpOptions.length, '普通对话必须同时存在合法的非沟通后续行动');
  assert.ok(dialogueContext.options.filter((option) => option.nextAction.kind === 'communicate').every((option) => option.requiresFollowUp), '每项对话决策都必须绑定后续真实行动');
  dialogueState.decisionBudget.credits = dialogueState.people.length;
  dialogueState.decisionBudget.ledgers = [{ atMonth: 1, livingAgents: 60, candidates: 0, modelContexts: 0, inputTokens: 0, outputTokens: 0, chargedTokens: 0 }];
  dialogueState = await stepSimulationAsync(dialogueState, {
    async decideAll(contexts) {
      return contexts.map((context) => {
        const talk = context.options.find((option) => option.requiresFollowUp);
        const followUp = context.followUpOptions[0];
        return talk && followUp
          ? { kind: 'start', optionId: talk.id, followUpOptionId: followUp.id, utterance: `我准备${followUp.summary}`, reason: '对话后落实行动' }
          : { kind: 'idle', reason: '保持观察' };
      });
    },
    takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
  });
  const dialogueIntent = dialogueState.intents.find((intent) => intent.openingAction?.kind === 'communicate');
  assert.ok(dialogueIntent?.openingActionCompleted, '对话应作为同一意图的开场动作完成');
  const dialogueIntentActions = dialogueState.world.past.filter((event) => event.kind === 'action' && event.intentId === dialogueIntent?.id);
  assert.equal(dialogueIntentActions[0]?.action.kind, 'communicate', '组合意图必须先说出模型生成的话');
  assert.ok(dialogueIntentActions.slice(1).some((event) => event.action.kind !== 'communicate'), '说完以后必须推进同次决策选定的真实行动');
  const dialogueActor = dialogueState.people.find((person) => person.id === dialogueIntent?.ownerId);
  const dialogueAudienceId = dialogueIntent?.openingAction?.kind === 'communicate' ? dialogueIntent.openingAction.audience[0] : undefined;
  const audienceRelation = dialogueState.people.find((person) => person.id === dialogueAudienceId)?.relations.find((relation) => relation.personId === dialogueActor?.id);
  assert.equal(audienceRelation?.trust, 0, '说话本身不能成为信任证据');
  assert.ok((audienceRelation?.bond ?? 0) > 0 && audienceRelation?.sourceEventIds.includes(dialogueIntentActions[0].id), '沟通只应形成带事件来源的熟悉度');
  const dialogueListener = dialogueState.people.find((person) => person.id === dialogueAudienceId);
  assert.ok(dialogueListener?.knowledge.every((fact) => !fact.id.startsWith('claim:')), '没有结构化事实引用的自然语言不得污染知识库');

  let harvestState = createInitialState(34, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const harvester = harvestState.people[0];
  const harvestCell = harvester.position.cellId;
  const harvestX = harvestCell % harvestState.world.grid.width;
  const harvestY = Math.floor(harvestCell / harvestState.world.grid.width);
  let harvestZ = harvestState.world.grid.levels - 1;
  while (harvestZ > 0 && harvestState.world.grid.voxels[harvestZ * harvestState.world.grid.width * harvestState.world.grid.depth + harvestCell] === 0) harvestZ -= 1;
  harvestState.world.grid.voxels[harvestZ * harvestState.world.grid.width * harvestState.world.grid.depth + harvestCell] = 12;
  harvestState.world.drops.push({ id: 'test-competing-food', materialId: 21, cellId: harvestCell, quantity: 3, createdAtMonth: 0, sourceEventIds: [] });
  const harvestContext = buildDecisionContexts(harvestState).find((context) => context.person.id === harvester.id);
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
  const firstHarvestAction = harvestState.world.past.find((event) => event.kind === 'action' && event.intentId === harvestIntent?.id);
  assert.equal(firstHarvestAction?.action.kind, 'act', '指定采收目标必须先执行分离，不能被附近野生食物偷换');
  assert.equal(firstHarvestAction?.diff.sourceMaterialId, 12, '采收事实必须来自目标成熟作物');

  const tentativeTechniqueState = createInitialState(35, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  tentativeTechniqueState.people[0].knowledge.push({ id: 'technique:test', kind: 'technique', summary: '暂定结合经验', confidence: 46, learnedAtMonth: 0, sourceEventIds: ['test-combine'] });
  const testPosition = { x: tentativeTechniqueState.people[0].position.cellId % tentativeTechniqueState.world.grid.width, y: Math.floor(tentativeTechniqueState.people[0].position.cellId / tentativeTechniqueState.world.grid.width), z: 0 };
  tentativeTechniqueState.world.past.push({ ...actionFact('test-combine', 0, tentativeTechniqueState.people[0].id, { kind: 'act', operation: 'combine', targets: [] }), diff: { position: testPosition, outputMaterialId: tentativeTechniqueState.world.grid.voxels[tentativeTechniqueState.people[0].position.cellId] } });
  const tentativeContext = buildDecisionContexts(tentativeTechniqueState).find((context) => context.person.id === tentativeTechniqueState.people[0].id);
  assert.equal(tentativeContext?.options.some((option) => option.id.startsWith('teach:')), false, '一次成功结合还不能直接传授为可靠技术');
  const verifyOption = tentativeContext?.options.find((option) => option.id.startsWith('verify-technique:'));
  assert.ok(verifyOption, '暂定技术应提供使用 attend 核验真实产物的机会');
  const verifyIntentId = 'intent-test-verify-technique';
  tentativeTechniqueState.intents.push({
    id: verifyIntentId, ownerId: tentativeTechniqueState.people[0].id, summary: verifyOption.summary, domain: 'strategic',
    goal: verifyOption.goal, nextAction: verifyOption.nextAction, target: verifyOption.target, status: 'active',
    createdAtMonth: 0, lastProgressAtMonth: 0, progress: 0, sourceDecisionEventId: 'test-verify-decision',
    sourceFactIds: verifyOption.sourceFactIds, actionEventIds: [], replanCount: 0,
  });
  tentativeTechniqueState.people[0].activeIntentId = verifyIntentId;
  tentativeTechniqueState.decisionBudget.credits = 0;
  const verifiedTechniqueState = await stepSimulationAsync(tentativeTechniqueState, {
    async decideAll() { throw new Error('固定活动意图不应额外调用模型'); },
    takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
  });
  assert.ok((verifiedTechniqueState.people[0].knowledge.find((fact) => fact.id === 'technique:test')?.confidence ?? 0) >= 55, '主动观察真实产物后技术才能达到可传播置信度');
  assert.ok(verifiedTechniqueState.derived.milestones.some((milestone) => milestone.id === '59'), '尝试加核验的事实链才能观察为用实验检验猜想');

  const blindTrialState = createInitialState(36, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  blindTrialState.people[0].inventory.push({ id: 'test-seed-stack', materialId: 22, quantity: 1, sourceEventIds: [] });
  const blindOptions = buildDecisionContexts(blindTrialState).find((context) => context.person.id === blindTrialState.people[0].id)?.options.filter((option) => option.id.startsWith('try-combine:')) ?? [];
  assert.ok(blindOptions.length > 0, '未知配方应从眼前物质生成可失败的结合尝试');
  assert.ok(blindOptions.every((option) => !option.summary.includes('作物幼苗') && !option.reason.includes('适宜')), '盲试候选不得泄露隐藏产物或适用规则');

  const craftWith = async (seed, stacks, targets) => {
    const craftState = createInitialState(seed, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
    const crafter = craftState.people[0];
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
      async decideAll() { throw new Error('固定制作意图不应额外调用模型'); },
      takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
    });
  };
  const ropeState = await craftWith(37, [{ id: 'fiber-craft', materialId: 20, quantity: 2, sourceEventIds: [] }], (crafter) => [
    { kind: 'inventory-stack', personId: crafter.id, stackId: 'fiber-craft' },
    { kind: 'inventory-stack', personId: crafter.id, stackId: 'fiber-craft' },
  ]);
  assert.equal(ropeState.people[0].inventory.find((stack) => stack.materialId === 23)?.quantity, 1, '两份私有纤维应由 combine 形成一份私有绳');
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
  assert.ok(toolState.derived.milestones.some((milestone) => milestone.id === '16'), '真实制作出石制工具后才能观察为制造工具');

  let fireState = createInitialState(382, { endpoint: { kind: 'months', value: 4 }, chaosIntensity: 0 });
  const fireMakerId = fireState.people[0].id;
  fireState.people[0].inventory = [
    { id: 'fire-tool', materialId: 24, quantity: 1, sourceEventIds: [] },
    { id: 'fire-fiber', materialId: 20, quantity: 2, sourceEventIds: [] },
  ];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const fireMaker = fireState.people.find((person) => person.id === fireMakerId);
    const fireContext = buildDecisionContexts(fireState).find((context) => context.person.id === fireMakerId);
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
      async decideAll() { throw new Error('固定生火试验不应额外调用模型'); },
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
  assert.ok(fireState.derived.milestones.some((milestone) => milestone.id === '17'), '真实产生火体素后才能观察为掌控火种');
  assert.ok(fireState.derived.milestones.some((milestone) => milestone.id === '59'), '重复生火也应构成实验检验的证据链');

  const firePosition = ignitionFacts.at(-1)?.diff.position;
  assert.ok(firePosition, '生火事实必须保存火体素位置');
  const cook = fireState.people.find((person) => person.id === fireMakerId);
  cook.inventory.push({ id: 'raw-food-for-cooking', materialId: 21, quantity: 1, sourceEventIds: [] });
  const cookContext = buildDecisionContexts(fireState).find((context) => context.person.id === fireMakerId);
  const cookOption = cookContext?.options.find((option) => option.id.startsWith('try-expose:'));
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
    async decideAll() { throw new Error('固定烹饪试验不应额外调用模型'); },
    takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
  });
  assert.equal(fireState.people.find((person) => person.id === fireMakerId)?.inventory.find((stack) => stack.materialId === 25)?.quantity, 1, '食物暴露于火后应转化为私人熟食');
  assert.ok(fireState.derived.milestones.some((milestone) => milestone.id === '18'), '真实 expose 转换出熟食后才能观察为烹饪食物');

  const teachingState = createInitialState(383, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const teacher = teachingState.people[0];
  const learner = teachingState.people[1];
  learner.position.cellId = teacher.position.cellId;
  const taughtTechniqueId = 'technique:combine:22:3:11';
  const canonicalTechniqueSummary = '种子与湿土可结合为作物幼苗';
  teacher.knowledge.push({ id: taughtTechniqueId, kind: 'technique', summary: canonicalTechniqueSummary, confidence: 80, learnedAtMonth: 0, sourceEventIds: ['teacher-trial'] });
  const teachingIntentId = 'intent-test-canonical-teaching';
  teachingState.intents.push({
    id: teachingIntentId, ownerId: teacher.id, summary: '向同伴说明技术', domain: 'social',
    goal: { kind: 'representation-made', representationId: 'test-teaching-claim' },
    nextAction: { kind: 'communicate', content: { id: 'test-teaching-claim', kind: 'claim', factId: taughtTechniqueId, summary: '我这就过去演示一遍，你看着。' }, audience: [learner.id], channel: 'voice' },
    status: 'active', createdAtMonth: 0, lastProgressAtMonth: 0, progress: 0, sourceDecisionEventId: 'decision-test-teaching',
    sourceFactIds: ['teacher-trial'], actionEventIds: [], replanCount: 0,
  });
  teacher.activeIntentId = teachingIntentId;
  teachingState.decisionBudget.credits = 0;
  const taughtState = await stepSimulationAsync(teachingState, {
    async decideAll() { throw new Error('固定技术交流不应额外调用模型'); },
    takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
  });
  const learnedBySpeech = taughtState.people.find((person) => person.id === learner.id)?.knowledge.find((fact) => fact.id === taughtTechniqueId);
  assert.equal(learnedBySpeech?.summary, canonicalTechniqueSummary, '自然语言说法不能覆盖结构化技术事实的规范摘要');
  assert.ok((learnedBySpeech?.confidence ?? 100) < 55, '只听别人讲述不能直接获得可传授的可靠技术');
  assert.deepEqual(learnedBySpeech?.sourceEventIds.length, 1, '听者知识应来源于沟通事件，而不是伪装成亲历教师的实验');

  const repeatedExperimentState = createInitialState(381, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const experimenter = repeatedExperimentState.people[0];
  const techniqueId = 'technique:combine:22:3:11';
  experimenter.knowledge.push({ id: techniqueId, kind: 'technique', summary: '种子与湿土可结合为作物幼苗', confidence: 64, learnedAtMonth: 0, sourceEventIds: ['repeat-trial-1', 'repeat-trial-2'] });
  repeatedExperimentState.world.past.push(
    { ...actionFact('repeat-trial-1', 1, experimenter.id, { kind: 'act', operation: 'combine', targets: [] }), diff: { inputMaterialId: 22, targetMaterialId: 3, outputMaterialId: 11 } },
    { ...actionFact('repeat-trial-2', 2, experimenter.id, { kind: 'act', operation: 'combine', targets: [] }), diff: { inputMaterialId: 22, targetMaterialId: 3, outputMaterialId: 11 } },
  );
  const observedExperimentState = stepSimulation(repeatedExperimentState, { decide() { return { kind: 'idle', reason: '不干扰重复实验观察' }; } });
  assert.ok(observedExperimentState.derived.milestones.some((milestone) => milestone.id === '59'), '同一物质规律被成功复现两次，也应构成实验检验的证据链');

  const responseState = createInitialState(39, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const offerer = responseState.people[0];
  const responder = responseState.people[2];
  const separatedCell = responseState.people.find((person) => person.position.cellId !== offerer.position.cellId)?.position.cellId;
  assert.ok(Number.isInteger(separatedCell), '测试世界应有一个与报价者分开的可达出生格');
  responder.position.cellId = offerer.position.cellId;
  offerer.inventory.push({ id: 'exchange-wood', materialId: 13, quantity: 2, sourceEventIds: [] });
  responder.inventory.push({ id: 'exchange-food', materialId: 21, quantity: 2, sourceEventIds: [] });
  const exchangeId = 'test-required-exchange';
  const exchangeFact = actionFact('test-required-exchange-event', 1, offerer.id, { kind: 'communicate', content: { id: exchangeId, kind: 'offer', summary: '木材换食物', proposal: { kind: 'exchange', offererId: offerer.id, partnerId: responder.id, offererMaterialId: 13, offererQuantity: 1, partnerMaterialId: 21, partnerQuantity: 1, expiresAtMonth: 8 } }, audience: [responder.id], channel: 'voice' });
  recordAgreementAction(responseState, exchangeFact);
  responseState.world.past.push(exchangeFact);
  responder.position.cellId = separatedCell;
  responder.position.previousCellId = separatedCell;
  const responseContext = buildDecisionContexts(responseState).find((context) => context.person.id === responder.id);
  assert.deepEqual(new Set(responseContext?.options.map((option) => option.id.split(':')[0])), new Set(['accept-exchange', 'reject-exchange']), '收到可履行交换后只能先明确接受或拒绝');
  const acceptExchange = responseContext?.options.find((option) => option.id.startsWith('accept-exchange:'));
  assert.equal(acceptExchange?.nextAction.kind, 'move', '提议后分开时，应先连续追上提议者');
  assert.equal(acceptExchange?.completionAction?.kind, 'communicate', '跨月会合后必须保留原本的接受回应');
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
    && event.action.kind === 'communicate'
    && event.action.content.kind === 'accept'
    && event.action.content.referenceId === exchangeId);
  assert.ok(acceptanceFact, '回应者应以同一跨月意图完成移动后真正说出接受');
  assert.equal(respondedState.agreements.find((agreement) => agreement.id === exchangeId)?.status, 'fulfilled', '真正说出接受后，双方应以已有 transfer 原语继续履行交换');
  const exchangeDeliveries = respondedState.world.past.filter((event) => event.kind === 'action'
    && event.action.kind === 'transfer'
    && event.action.authorizationRef === exchangeId);
  assert.deepEqual(new Set(exchangeDeliveries.map((event) => event.who)), new Set([offerer.id, responder.id]), '结构化接受必须自动产生双方各自的真实交付，而不是模型随意搭配后续行动');

  const roadState = createInitialState(40, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const roadWalker = roadState.people[0];
  for (let index = 0; index < 4; index += 1) roadState.world.past.push({
    ...actionFact(`road-formation-${index}`, index + 1, roadWalker.id, { kind: 'move', toCellId: roadWalker.position.cellId }),
    pathSegment: [roadWalker.position.cellId, roadWalker.position.cellId + 1],
    diff: { materialChanges: [{ cellId: 100 + index, from: 2, to: 15 }] },
  });
  const projectedRoad = stepSimulation(roadState, { decide() { return { kind: 'idle', reason: '道路观察测试' }; } });
  const roadMilestone = projectedRoad.derived.milestones.find((milestone) => milestone.id === '42');
  assert.equal(roadMilestone?.observedAtMonth, 4, '道路首次出现时间应取第四个真实压实格形成时，而不是最早一次历史移动');
  assert.deepEqual(roadMilestone?.evidenceEventIds, ['road-formation-0', 'road-formation-1', 'road-formation-2', 'road-formation-3']);

  let shelterState = createInitialState(41, { endpoint: { kind: 'months', value: 10 }, chaosIntensity: 0 });
  const builderId = shelterState.people[0].id;
  shelterState.people[0].inventory = [{ id: 'shelter-wood', materialId: 13, quantity: 4, sourceEventIds: [] }];
  for (let index = 0; index < 4; index += 1) {
    const builder = shelterState.people.find((person) => person.id === builderId);
    const buildContext = buildDecisionContexts(shelterState).find((context) => context.person.id === builderId);
    const buildOption = buildContext?.options.find((option) => option.id.startsWith('build:'));
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
    shelterState = await stepSimulationAsync(shelterState, {
      async decideAll() { throw new Error('固定建造意图不应额外调用模型'); },
      takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
    });
  }
  const completedShelter = shelterState.derived.structures.find((structure) => structure.complete);
  assert.ok(completedShelter && completedShelter.occupiedCells.length >= 3, '反复 combine 木材应横向长成可观察的遮蔽结构，而不是堆成单柱');
  assert.ok(shelterState.derived.milestones.some((milestone) => milestone.id === '20'), '真实连接的多格木板结构才能观察为住所');

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
  legacy.schemaVersion = 13;
  assert.throws(() => createSimulation({ state: legacy }), /不支持继续演化/, '没有 Agreement 聚合的旧存档必须硬切拒绝');

  let calls = 0;
  const batch = {
    async decideAll(contexts) { calls += contexts.length; return contexts.map(() => ({ kind: 'idle', reason: '测试中的合法模型决策' })); },
    takeUsage() { return { inputTokens: 0, outputTokens: 0 }; },
  };
  let budgetState = createInitialState(17, { endpoint: { kind: 'months', value: 24 } });
  for (let index = 0; index < 12; index += 1) budgetState = await stepSimulationAsync(budgetState, batch);
  const personMonths = budgetState.decisionBudget.ledgers.reduce((sum, ledger) => sum + ledger.livingAgents, 0);
  assert.ok(calls <= Math.floor(personMonths / 12), '模型上下文不得超过每 12 人月一个的滚动额度');

  assert.ok(initial.people.every((person) => Array.isArray(person.memories)), '人物应持有固定预算记忆');
  assert.ok(state.world.past.some((event) => event.kind === 'action' && event.cause === 'survival-reflex'), '生存维护应由规则反射产生可审计动作');
  assert.ok(state.people.every((person) => person.memories.length <= 24), '人物记忆必须保持固定上限');
  const lastMonthActions = state.lastStep.filter((event) => event.kind === 'action');
  assert.ok(lastMonthActions.every((event) => event.actionTick >= 1 && event.actionTick <= 15), '原子行动必须归属 1–15 的月内规则刻度');
  assert.ok(state.people.filter((person) => person.bornAtMonth < state.clock.elapsedMonths).every((person) => person.position.tickPath.length === 16), '每位人物每月必须留下月初加 15 刻度的位置轨迹');
  for (const event of state.world.past.filter((fact) => fact.kind === 'action' && fact.action.kind === 'move')) {
    assert.ok(event.pathSegment.length <= 2, '单个行动刻度不允许跨越多个格子');
    if (event.pathSegment.length === 2) {
      const [from, to] = event.pathSegment;
      const distance = Math.abs(from % 84 - to % 84) + Math.abs(Math.floor(from / 84) - Math.floor(to / 84));
      assert.equal(distance, 1, '每个空间路径步必须连接四邻格');
    }
  }
  console.log(`simulation tests passed: schema 14, ${state.people.length} people, ${state.world.past.length} facts, ${state.derived.milestones.length} milestones, ${calls}/${Math.floor(personMonths / 12)} model contexts`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
