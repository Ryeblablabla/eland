import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-player-embodiment-test-'));
const embodimentBundlePath = path.join(temporaryDirectory, 'player-embodiment.mjs');
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const intentExecutionBundlePath = path.join(temporaryDirectory, 'intent-execution.mjs');
const monthlyProcessesBundlePath = path.join(temporaryDirectory, 'monthly-processes.mjs');
const mortuaryBundlePath = path.join(temporaryDirectory, 'mortuary.mjs');

function chooseProjectedOption(embodiment, state, person, atMonth, option) {
  const resolution = embodiment.resolvePlayerEmbodimentCommand(state, person, atMonth, {
    kind: 'choose-option',
    optionId: option.optionId,
    choiceKey: option.choiceKey,
  });
  assert.ok(resolution.ok && resolution.control.kind === 'decision',
    `投影候选 ${option.optionId} 必须重新解析为普通领域决定`);
  return resolution;
}

function executeProjectedDecision(intentExecution, state, person, atMonth, resolution) {
  const events = [];
  const decisionFact = intentExecution.applyDecision(
    state,
    person,
    resolution.control.context,
    resolution.control.decision,
    resolution.control.usedModel ?? false,
    atMonth,
    events.length,
    1,
  );
  events.push(decisionFact);
  const actionFact = intentExecution.executeActiveIntent(
    state,
    person,
    atMonth,
    events.length,
    1,
    events,
  );
  if (actionFact) events.push(actionFact);
  return { decisionFact, actionFact, events };
}

try {
  const esbuild = path.resolve('node_modules/.bin/esbuild');
  execFileSync(esbuild, [
    'src/game/eland/application/player-embodiment.ts',
    '--bundle', '--platform=node', '--format=esm', `--outfile=${embodimentBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(esbuild, [
    'src/game/eland/simulation.ts',
    '--bundle', '--platform=node', '--format=esm', `--outfile=${simulationBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(esbuild, [
    'src/game/eland/application/simulation/intent-execution.ts',
    '--bundle', '--platform=node', '--format=esm', `--outfile=${intentExecutionBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(esbuild, [
    'src/game/eland/domain/monthly-processes.ts',
    '--bundle', '--platform=node', '--format=esm', `--outfile=${monthlyProcessesBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(esbuild, [
    'src/game/eland/domain/mortuary.ts',
    '--bundle', '--platform=node', '--format=esm', `--outfile=${mortuaryBundlePath}`,
  ], { stdio: 'pipe' });

  const embodiment = await import(`${pathToFileURL(embodimentBundlePath).href}?test=${Date.now()}`);
  const simulation = await import(`${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`);
  const intentExecution = await import(`${pathToFileURL(intentExecutionBundlePath).href}?test=${Date.now()}`);
  const monthlyProcesses = await import(`${pathToFileURL(monthlyProcessesBundlePath).href}?test=${Date.now()}`);
  const mortuary = await import(`${pathToFileURL(mortuaryBundlePath).href}?test=${Date.now()}`);
  const state = simulation.createInitialState(3, { endpoint: { kind: 'months', value: 24 } });
  const person = state.people.find((candidate) => candidate.id === 'copernicus');
  assert.ok(person, 'seed 3 应保留用于定向测试的哥白尼人物');

  const beforeProjection = structuredClone(state);
  const first = embodiment.buildPlayerEmbodimentOptions(state, person, 1);
  const second = embodiment.buildPlayerEmbodimentOptions(state, person, 1);
  assert.deepEqual(state, beforeProjection, '化身候选投影不得改写权威模拟状态');
  assert.deepEqual(first, second, '同一权威状态的化身候选及 choiceKey 必须确定');

  const wait = first.find((option) => option.source === 'wait');
  assert.ok(wait && wait.category === 'wait' && wait.tickCost === 1, '候选必须包含显式等待一刻');
  const waitResolution = embodiment.resolvePlayerEmbodimentCommand(state, person, 1, { kind: 'wait' });
  assert.ok(waitResolution.ok && waitResolution.control.kind === 'wait', '等待命令应解析为 wait 控制');

  const moves = first.filter((option) => option.source === 'primitive-action' && option.category === 'move');
  assert.ok(moves.length > 0 && moves.length <= 4, '移动候选只能来自至多四个相邻站立位置');
  for (const move of moves) {
    assert.equal(move.target?.kind, 'standing-position');
    const target = move.target;
    const width = state.world.grid.width;
    const distance = Math.abs(target.cellId % width - person.position.cellId % width)
      + Math.abs(Math.floor(target.cellId / width) - Math.floor(person.position.cellId / width));
    assert.equal(distance, 1, '每个化身移动候选必须只跨一条四邻边');
  }
  const move = moves[0];
  const moveResolution = embodiment.resolvePlayerEmbodimentCommand(state, person, 1, {
    kind: 'choose-option',
    optionId: move.optionId,
    choiceKey: move.choiceKey,
  });
  assert.ok(moveResolution.ok && moveResolution.control.kind === 'direct-action');
  assert.deepEqual(moveResolution.control.action, {
    kind: 'move',
    toCellId: move.target.cellId,
    toZ: move.target.z,
  }, '客户端只能取回投影过的相邻移动，不能提交原始位置写入');
  assert.deepEqual(
    embodiment.resolvePlayerEmbodimentCommand(state, person, 1, {
      kind: 'choose-option',
      optionId: move.optionId,
      choiceKey: `${move.choiceKey}:tampered`,
    }),
    { ok: false, failure: 'option-unavailable' },
    '伪造的移动 choiceKey 不得产生 TickActorControl',
  );

  const context = simulation.buildDecisionContextForPerson(state, person, 1);
  const construction = first.find((option) => option.source === 'decision' && option.category === 'build');
  assert.ok(construction, '真实 DecisionContext 中的建造项目候选必须投影给有限化身');
  assert.ok(context.options.some((option) => option.id === construction.optionId
    && option.projectProposal?.kind === 'construction'), '建造视图必须来自真实项目候选而非前端蓝图');
  const constructionResolution = embodiment.resolvePlayerEmbodimentCommand(state, person, 1, {
    kind: 'choose-option',
    optionId: construction.optionId,
    choiceKey: construction.choiceKey,
  });
  assert.ok(constructionResolution.ok && constructionResolution.control.kind === 'decision');
  assert.equal(constructionResolution.control.decision.kind, 'start');
  assert.equal(constructionResolution.control.decision.optionId, construction.optionId);

  const remappedConstruction = embodiment.resolvePlayerEmbodimentCommand(state, person, 1, {
    kind: 'choose-option',
    optionId: 'stale-month-stamped-option',
    choiceKey: construction.choiceKey,
  });
  assert.ok(remappedConstruction.ok && remappedConstruction.control.kind === 'decision');
  assert.equal(remappedConstruction.remappedOptionId, construction.optionId,
    '唯一匹配的稳定语义选择应重配到当前真实 optionId');

  const continuationState = simulation.createInitialState(3, { endpoint: { kind: 'months', value: 24 } });
  const continuationPerson = continuationState.people.find((candidate) => candidate.id === person.id);
  const continuationContext = simulation.buildDecisionContextForPerson(continuationState, continuationPerson, 1);
  const continuationProject = continuationContext.options.find((option) => option.id === construction.optionId);
  assert.ok(continuationProject, '定向夹具中的同一个建造项目候选必须仍然可编译');
  const activeIntent = simulation.startIntent(
    continuationState,
    continuationPerson,
    continuationContext,
    continuationProject.id,
    undefined,
    'test-player-embodiment-decision',
    1,
  );
  assert.ok(activeIntent && continuationPerson.activeIntentId === activeIntent.id,
    '定向夹具应安装一项由真实候选产生的当前意图');
  const continuedOptions = embodiment.buildPlayerEmbodimentOptions(continuationState, continuationPerson, 1);
  const continuation = continuedOptions.find((option) => option.source === 'continue-intent');
  assert.ok(continuation && continuation.label.includes('继续：'), '已有意图必须投影为显式继续候选');
  const continuationResolution = embodiment.resolvePlayerEmbodimentCommand(continuationState, continuationPerson, 1, {
    kind: 'choose-option',
    optionId: continuation.optionId,
    choiceKey: continuation.choiceKey,
  });
  assert.ok(continuationResolution.ok && continuationResolution.control.kind === 'continue-intent');

  const animalTarget = first.find((option) => option.target?.kind === 'animal');
  assert.ok(animalTarget, '真实动物观察或捕猎候选必须投影 animal target');
  const projectedAnimal = state.world.animals.find((animal) => animal.id === animalTarget.target.animalId);
  assert.ok(projectedAnimal, 'animal target 必须引用权威世界中的真实动物');
  assert.deepEqual(animalTarget.target, {
    kind: 'animal',
    animalId: projectedAnimal.id,
    cellId: projectedAnimal.position.cellId,
    z: projectedAnimal.position.z,
  }, '动物交互目标的位置只能来自权威动物状态');

  const socialState = simulation.createInitialState(3, { endpoint: { kind: 'months', value: 24 } });
  const socialActor = socialState.people.find((candidate) => candidate.id === person.id);
  const socialOptions = embodiment.buildPlayerEmbodimentOptions(socialState, socialActor, 1);
  const socialOffer = socialOptions.find((option) => option.optionId.startsWith('offer-companion:')
    && option.target?.kind === 'person');
  assert.ok(socialOffer, '定向夹具必须提供一个指向真实人物的结伴邀请');
  const socialTarget = socialState.people.find((candidate) => candidate.id === socialOffer.target.personId);
  assert.ok(socialTarget, 'person target 必须引用权威人物');
  const agreementCountBefore = socialState.agreements.length;
  const socialResolution = chooseProjectedOption(embodiment, socialState, socialActor, 1, socialOffer);
  const socialExecution = executeProjectedDecision(intentExecution, socialState, socialActor, 1, socialResolution);
  assert.ok(socialExecution.actionFact?.kind === 'action'
    && socialExecution.actionFact.status === 'completed'
    && socialExecution.actionFact.action.kind === 'communicate',
    'person target 决策必须通过普通意图执行器提交真实沟通事实');
  assert.ok(socialExecution.actionFact.action.audience.includes(socialTarget.id),
    '沟通事实的真实受众必须与投影 person target 一致');
  assert.equal(socialState.agreements.length, agreementCountBefore + 1,
    '玩家发出的结伴邀请必须改变权威 agreement 状态');
  const proposedAgreement = socialState.agreements.find((agreement) => agreement.proposerId === socialActor.id
    && agreement.partyIds.includes(socialTarget.id)
    && agreement.status === 'proposed');
  assert.ok(proposedAgreement, '结伴邀请必须生成等待对方回应的权威协议');
  socialState.world.past.push(...socialExecution.events);
  const targetResponses = embodiment.buildPlayerEmbodimentOptions(socialState, socialTarget, 1);
  assert.ok(targetResponses.some((option) => option.optionId === `accept-companion:${proposedAgreement.id}`
    && option.primary
    && option.target?.kind === 'person'
    && option.target.personId === socialActor.id),
    '玩家沟通后，对方的下一份权威候选必须出现指回玩家的必需接受响应');
  assert.ok(targetResponses.some((option) => option.optionId === `reject-companion:${proposedAgreement.id}`
    && option.primary
    && option.target?.kind === 'person'
    && option.target.personId === socialActor.id),
    '同一请求必须保留对方真实拒绝的行为分支');

  const materialState = simulation.createInitialState(3, { endpoint: { kind: 'months', value: 24 } });
  const materialActor = materialState.people.find((candidate) => candidate.id === 'liu-rushi');
  assert.ok(materialActor, 'seed 3 必须保留与开局木材掉落同位的柳如是');
  const materialOptions = embodiment.buildPlayerEmbodimentOptions(materialState, materialActor, 1);
  const collectDrop = materialOptions.find((option) => option.optionId === 'collect:starter-13-2371'
    && option.target?.kind === 'drop');
  assert.ok(collectDrop, '真实掉落物取得候选必须投影 drop target');
  const materialDrop = materialState.world.drops.find((drop) => drop.id === collectDrop.target.dropId);
  assert.ok(materialDrop && materialDrop.quantity > 0, 'drop target 必须引用仍有数量的权威掉落物');
  const dropQuantityBefore = materialDrop.quantity;
  const carriedQuantityBefore = materialActor.inventory
    .filter((stack) => stack.materialId === materialDrop.materialId)
    .reduce((sum, stack) => sum + stack.quantity, 0);
  const materialResolution = chooseProjectedOption(embodiment, materialState, materialActor, 1, collectDrop);
  const materialExecution = executeProjectedDecision(intentExecution, materialState, materialActor, 1, materialResolution);
  assert.ok(materialExecution.actionFact?.kind === 'action'
    && materialExecution.actionFact.status === 'completed'
    && materialExecution.actionFact.action.kind === 'transfer',
    'drop target 决策必须通过普通意图执行器提交真实物质转移事实');
  const remainingDropQuantity = materialState.world.drops.find((drop) => drop.id === materialDrop.id)?.quantity ?? 0;
  const carriedQuantityAfter = materialActor.inventory
    .filter((stack) => stack.materialId === materialDrop.materialId)
    .reduce((sum, stack) => sum + stack.quantity, 0);
  assert.ok(remainingDropQuantity < dropQuantityBefore,
    '真实掉落物数量必须因玩家选择而减少');
  assert.ok(carriedQuantityAfter > carriedQuantityBefore,
    '玩家背包中的对应真实物质必须因同一转移事实而增加');

  const remainsState = simulation.createInitialState(88421, {
    endpoint: { kind: 'months', value: 24 },
    chaosIntensity: 0,
  });
  const deceased = remainsState.people[0];
  const carer = remainsState.people[1];
  remainsState.people = [deceased, carer];
  carer.position = structuredClone(deceased.position);
  carer.bornAtMonth = -30 * 12;
  carer.body = { health: 100, hydration: 100, nutrition: 100 };
  deceased.body = { health: 1, hydration: 0, nutrition: 0 };
  const deathEvents = monthlyProcesses.advanceBodies(remainsState, 1);
  remainsState.world.past.push(...deathEvents);
  remainsState.clock.elapsedMonths = 1;
  const perceptionEvents = mortuary.synchronizeMortuaryPerceptions(remainsState, 1, deathEvents.length);
  remainsState.world.past.push(...perceptionEvents);
  const remains = remainsState.world.remains.find((candidate) => candidate.personId === deceased.id);
  assert.ok(remains, '真实身体结算必须为 remains target 夹具生成权威遗体');
  const remainsTarget = embodiment.buildPlayerEmbodimentOptions(remainsState, carer, 2)
    .find((option) => option.target?.kind === 'remains' && option.target.remainsId === remains.id);
  assert.ok(remainsTarget, '知情且可达的照料者必须获得真实遗体交互候选');
  assert.deepEqual(remainsTarget.target, {
    kind: 'remains',
    remainsId: remains.id,
    cellId: remains.position.cellId,
    z: remains.position.z,
  }, '遗体交互目标的位置只能来自权威遗体状态');

  const unavailableState = structuredClone(state);
  const unavailablePerson = unavailableState.people.find((candidate) => candidate.id === person.id);
  unavailablePerson.diedAtMonth = 1;
  assert.deepEqual(embodiment.buildPlayerEmbodimentOptions(unavailableState, unavailablePerson, 1), []);
  assert.deepEqual(
    embodiment.resolvePlayerEmbodimentCommand(unavailableState, unavailablePerson, 1, { kind: 'wait' }),
    { ok: false, failure: 'person-unavailable' },
  );

  console.log(`player embodiment tests passed: ${first.length} options, ${moves.length} adjacent moves, person/drop/animal/remains targets executed or projected`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
