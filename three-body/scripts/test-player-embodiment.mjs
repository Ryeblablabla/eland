import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-player-embodiment-test-'));
const embodimentBundlePath = path.join(temporaryDirectory, 'player-embodiment.mjs');
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');

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

  const embodiment = await import(`${pathToFileURL(embodimentBundlePath).href}?test=${Date.now()}`);
  const simulation = await import(`${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`);
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

  const unavailableState = structuredClone(state);
  const unavailablePerson = unavailableState.people.find((candidate) => candidate.id === person.id);
  unavailablePerson.diedAtMonth = 1;
  assert.deepEqual(embodiment.buildPlayerEmbodimentOptions(unavailableState, unavailablePerson, 1), []);
  assert.deepEqual(
    embodiment.resolvePlayerEmbodimentCommand(unavailableState, unavailablePerson, 1, { kind: 'wait' }),
    { ok: false, failure: 'person-unavailable' },
  );

  console.log(`player embodiment tests passed: ${first.length} options, ${moves.length} adjacent moves`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
