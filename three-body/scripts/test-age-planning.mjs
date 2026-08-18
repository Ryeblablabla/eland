import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-age-planning-test-'));
const bundlePath = path.join(temporaryDirectory, 'age-planning.mjs');
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');

try {
  const testEntry = `
    export { optionAllowedForLifeStage } from ${JSON.stringify(path.resolve('src/game/eland/application/age-planning.ts'))};
    export { lifePlanningStageForAge } from ${JSON.stringify(path.resolve('src/game/eland/domain/life-stage.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export { findStandingPath, neighbors4 } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=age-planning-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: testEntry, stdio: ['pipe', 'pipe', 'pipe'] });
  const { executePrimitiveAction, findStandingPath, lifePlanningStageForAge, neighbors4, optionAllowedForLifeStage } = await import(
    `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
  );
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/simulation.ts', '--bundle', '--platform=node', '--format=esm',
    `--outfile=${simulationBundlePath}`,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const { createInitialState, stepSimulation } = await import(
    `${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`
  );

  assert.equal(lifePlanningStageForAge(0), 'dependent-child');
  assert.equal(lifePlanningStageForAge(1 * 12 - 1), 'dependent-child');
  assert.equal(lifePlanningStageForAge(1 * 12), 'learning-child');
  assert.equal(lifePlanningStageForAge(12 * 12), 'adolescent-worker');
  assert.equal(lifePlanningStageForAge(16 * 12), 'adult');

  const option = (id, extra = {}) => ({
    id, summary: id, reason: id,
    goal: { kind: 'at-cell', cellId: 1 },
    nextAction: { kind: 'move', toCellId: 1 },
    estimatedDuration: 'one-month', sourceFactIds: [], ...extra,
  });
  const collect = option('collect:food');
  const drink = option('drink:1:1:1', { nextAction: { kind: 'act', operation: 'ingest', targets: [] } });
  const gatherWood = option('separate:wood:1', { nextAction: { kind: 'act', operation: 'separate', targets: [] } });
  const observe = option('attend:stone', { nextAction: { kind: 'attend', target: { kind: 'voxel', position: { x: 1, y: 1, z: 1 } } } });
  const transformation = option('try-combine:seed:soil');
  const projectWork = option('project:kiln:place', { projectId: 'kiln-project' });
  const projectProposal = option('project-proposal', { projectProposal: {} });
  const reproduction = option('offer-reproduce:person-a:person-b', { domain: 'social' });

  assert.equal(optionAllowedForLifeStage('dependent-child', collect), false, '未满 1 岁不发起普通规划');
  assert.equal(optionAllowedForLifeStage('learning-child', collect), true, '1–11 岁可以采集');
  assert.equal(optionAllowedForLifeStage('learning-child', drink), true, '1–11 岁可以自行前往水源取水');
  assert.equal(optionAllowedForLifeStage('learning-child', gatherWood), true, '1–11 岁可以进行拾柴等简单劳动');
  assert.equal(optionAllowedForLifeStage('learning-child', observe), true, '1–11 岁可以观察学习');
  assert.equal(optionAllowedForLifeStage('learning-child', transformation), false, '1–11 岁不独立主持复杂生产');
  assert.equal(optionAllowedForLifeStage('learning-child', projectWork), false, '1–11 岁不参与正式项目');
  assert.equal(optionAllowedForLifeStage('adolescent-worker', projectWork), true, '12–15 岁可以参与既有项目');
  assert.equal(optionAllowedForLifeStage('adolescent-worker', projectProposal), false, '12–15 岁不能发起重大项目');
  assert.equal(optionAllowedForLifeStage('adolescent-worker', reproduction), false, '12–15 岁不能繁衍');
  assert.equal(optionAllowedForLifeStage('adult', projectProposal), true, '16 岁以上拥有完整规划能力');

  const monthlyState = createInitialState(20260815, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const youngFounderIds = new Set(monthlyState.people.map((person) => person.id));
  for (const founder of monthlyState.people) founder.bornAtMonth = -10 * 12;
  stepSimulation(monthlyState, {
    decide(context) {
      if (youngFounderIds.has(context.person.id)) {
        assert.equal(context.options.some((candidate) => candidate.projectId), false, '真实月度入口不能让 1–11 岁先民绕过项目权限');
      }
      return { kind: 'idle', reason: '只检查年龄候选过滤' };
    },
  });

  const movementState = createInitialState(20260816, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const parent = movementState.people[0];
  const child = movementState.people[1];
  child.generation = 1;
  child.geneticParents = [parent.id];
  child.position = structuredClone(parent.position);
  const destination = neighbors4(parent.position.cellId)
    .find((cellId) => findStandingPath(movementState.world.grid, parent.position, { cellId }).length > 1);
  assert.ok(Number.isInteger(destination), '年龄移动测试需要相邻的可达地表格');

  child.bornAtMonth = 0;
  const infantState = structuredClone(movementState);
  const infantParent = infantState.people.find((person) => person.id === parent.id);
  const infantChild = infantState.people.find((person) => person.id === child.id);
  const infantMove = executePrimitiveAction(
    infantState, infantParent, { kind: 'move', toCellId: destination }, 11, 0,
    { cause: 'intent', actionTick: 1 },
  );
  assert.ok(infantMove.diff.carriedPersonIds?.includes(child.id), '未满 1 岁的清醒婴儿应被同处亲代携带');
  assert.deepEqual(infantChild.position, infantParent.position, '被携带婴儿应与亲代到达同一位置');

  const autonomousState = structuredClone(movementState);
  const autonomousParent = autonomousState.people.find((person) => person.id === parent.id);
  const autonomousChild = autonomousState.people.find((person) => person.id === child.id);
  const autonomousStart = structuredClone(autonomousChild.position);
  const autonomousMove = executePrimitiveAction(
    autonomousState, autonomousParent, { kind: 'move', toCellId: destination }, 12, 0,
    { cause: 'intent', actionTick: 1 },
  );
  assert.equal(autonomousMove.diff.carriedPersonIds, undefined, '满 1 岁后不再被亲代移动自动携带');
  assert.deepEqual(autonomousChild.position, autonomousStart, '满 1 岁的儿童应保持自己的位置，由本人选择后续行动');

  const sleepingState = structuredClone(movementState);
  const sleepingParent = sleepingState.people.find((person) => person.id === parent.id);
  const sleepingChild = sleepingState.people.find((person) => person.id === child.id);
  sleepingChild.conditions.push({
    id: 'test-sleeping-infant', kind: 'dehydrated-hibernation', stage: 1, sinceMonth: 0, sourceEventIds: [],
  });
  const sleepingStart = structuredClone(sleepingChild.position);
  const sleepingMove = executePrimitiveAction(
    sleepingState, sleepingParent, { kind: 'move', toCellId: destination }, 11, 0,
    { cause: 'intent', actionTick: 1 },
  );
  assert.equal(sleepingMove.diff.carriedPersonIds, undefined, '脱水休眠的婴儿不得随亲代移动');
  assert.deepEqual(sleepingChild.position, sleepingStart, '脱水休眠的婴儿必须保持原位置');

  const sleepingActorMove = executePrimitiveAction(
    sleepingState, sleepingChild, { kind: 'move', toCellId: destination }, 11, 1,
    { cause: 'intent', actionTick: 1 },
  );
  assert.equal(sleepingActorMove.status, 'blocked', '脱水休眠者本人的移动也必须被领域执行器拒绝');

  process.stdout.write('age planning tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
