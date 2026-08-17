import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-logistics-test-'));
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const projectBundlePath = path.join(temporaryDirectory, 'project.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/simulation.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${simulationBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/domain/project.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${projectBundlePath}`,
  ], { stdio: 'pipe' });
  const { buildDecisionContexts, createInitialState, stepSimulation } = await import(`${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`);
  const { instantiateProject } = await import(`${pathToFileURL(projectBundlePath).href}?test=${Date.now()}`);

  const projectFor = (ownerId, id) => ({
    id,
    kind: 'production',
    need: 'thermal-safety',
    desiredFunction: 'insulation',
    summary: '为反复寒冷制作隔热物',
    ownerId,
    beneficiaryIds: [ownerId],
    triggerFactIds: ['test-cold-pressure'],
    pressure: 80,
    createdAtMonth: 0,
    reviewAtMonth: 11,
    status: 'active',
    lastProgressAtMonth: 0,
    missingMaterialIds: [],
    reservations: [],
    contributorIds: [ownerId],
    actionEventIds: [],
    failureEventIds: [],
    completionEventIds: [],
    logisticsEpisodes: [],
  });

  const isolate = (state) => {
    const actor = state.people[0];
    actor.bornAtMonth = -24 * 12;
    actor.body = { health: 100, hydration: 100, nutrition: 100 };
    actor.conditions = [];
    actor.inventory = [{ id: 'test-hide', materialId: 30, quantity: 1, sourceEventIds: ['test-hide-source'] }];
    for (const other of state.people.slice(1)) other.diedAtMonth = 0;
    return actor;
  };

  const searchState = createInitialState(490, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const searcher = isolate(searchState);
  const searchProject = projectFor(searcher.id, 'test-search-project');
  searchState.projects.push(searchProject);
  searchState.world.drops = [];
  const hiddenCell = searcher.position.cellId < searchState.world.grid.width * searchState.world.grid.depth / 2
    ? searchState.world.grid.width * searchState.world.grid.depth - 1
    : 0;
  searchState.world.drops.push({
    id: 'hidden-rope', materialId: 23, quantity: 1, cellId: hiddenCell, z: 1,
    createdAtMonth: 0, sourceEventIds: ['hidden-rope-source'],
  });
  const firstSearchOption = buildDecisionContexts(searchState)
    .find((context) => context.person.id === searcher.id)?.options
    .find((option) => option.projectId === searchProject.id);
  const searchEpisode = searchProject.logisticsEpisodes[0];
  assert.ok(firstSearchOption && searchEpisode?.kind === 'search' && searchEpisode.status === 'active', `缺料项目必须建立持久局部搜索事件：${JSON.stringify({ option: firstSearchOption?.id, episodes: searchProject.logisticsEpisodes })}`);
  assert.ok(searchEpisode.sourceEventIds.includes('test-cold-pressure'), '搜索事件必须引用人物自己的项目压力来源');
  assert.notEqual(searchEpisode.target.cellId, hiddenCell, '局部搜索不得读取视野外真实物资的位置');
  const lockedSearchTarget = structuredClone(searchEpisode.target);
  const secondSearchOption = buildDecisionContexts(searchState)
    .find((context) => context.person.id === searcher.id)?.options
    .find((option) => option.projectId === searchProject.id);
  assert.ok(secondSearchOption, '持续项目应继续暴露已锁定搜索动作');
  assert.deepEqual(searchProject.logisticsEpisodes[0].target, lockedSearchTarget, '重新编译不能逐次更换搜索目标');
  assert.equal(searchProject.logisticsEpisodes.length, 1, '同一未结算目标不能重复创建物流事件');

  const dropState = createInitialState(491, { endpoint: { kind: 'months', value: 3 }, chaosIntensity: 0 });
  const collector = isolate(dropState);
  const dropProject = projectFor(collector.id, 'test-drop-project');
  dropState.projects.push(dropProject);
  dropState.world.drops = [];
  dropState.world.drops.push({
    id: 'visible-rope', materialId: 23, quantity: 1,
    cellId: collector.position.cellId, z: collector.position.z,
    createdAtMonth: 0, sourceEventIds: ['visible-rope-source'],
  });
  const dropOption = buildDecisionContexts(dropState)
    .find((context) => context.person.id === collector.id)?.options
    .find((option) => option.projectId === dropProject.id);
  const dropEpisode = dropProject.logisticsEpisodes[0];
  assert.ok(dropOption && dropEpisode?.kind === 'drop' && dropEpisode.sourceEventIds.includes('visible-rope-source'), '亲眼可见来源必须成为有来源的锁定事件');
  const intentId = 'intent-test-project-logistics';
  dropState.intents.push({
    id: intentId,
    ownerId: collector.id,
    summary: dropOption.summary,
    domain: 'strategic',
    goal: dropOption.goal,
    nextAction: dropOption.nextAction,
    ...(dropOption.target ? { target: dropOption.target } : {}),
    status: 'active',
    createdAtMonth: 0,
    lastProgressAtMonth: 0,
    progress: 0,
    sourceDecisionEventId: 'test-logistics-decision',
    projectId: dropProject.id,
    sourceFactIds: dropOption.sourceFactIds,
    actionEventIds: [],
    replanCount: 0,
  });
  collector.activeIntentId = intentId;
  dropState.decisionBudget.credits = 0;
  const afterCollection = stepSimulation(dropState, { decide() { return { kind: 'idle', reason: '不改写物流测试意图' }; } });
  const settledEpisode = afterCollection.projects.find((project) => project.id === dropProject.id)?.logisticsEpisodes?.find((episode) => episode.id === dropEpisode.id);
  const collectionFact = afterCollection.world.past.find((event) => event.kind === 'action'
    && event.action.kind === 'transfer'
    && event.action.from.kind === 'ground'
    && event.action.dropId === 'visible-rope');
  assert.ok(collectionFact && settledEpisode?.status === 'fulfilled' && settledEpisode.endingReason === 'material-acquired', '真实取得必须结算同一锁定来源事件');
  assert.ok(settledEpisode.actionEventIds.includes(collectionFact.id), '物流事件必须保存执行动作来源');
  const collectedProject = afterCollection.projects.find((project) => project.id === dropProject.id);
  const stillCarried = afterCollection.people.find((person) => person.id === collector.id)?.inventory.some((stack) => stack.materialId === 23);
  assert.ok(stillCarried || collectedProject?.status === 'completed', '取得的材料必须进入本人背包，或随后被同一项目真实加工消耗');

  const proposal = {
    ...projectFor(collector.id, 'test-proposal-project'),
    initialLogisticsEpisode: structuredClone(dropEpisode),
  };
  delete proposal.status;
  delete proposal.lastProgressAtMonth;
  delete proposal.missingMaterialIds;
  delete proposal.reservations;
  delete proposal.contributorIds;
  delete proposal.actionEventIds;
  delete proposal.failureEventIds;
  delete proposal.completionEventIds;
  delete proposal.logisticsEpisodes;
  const acceptedProject = instantiateProject(proposal);
  assert.equal(acceptedProject.activeLogisticsEpisodeId, dropEpisode.id, '提议被接受时必须保留首个锁定目标，不能首月换路');
  assert.equal(acceptedProject.logisticsEpisodes[0]?.id, dropEpisode.id, '提议阶段的来源事件必须进入权威项目状态');

  process.stdout.write('project logistics tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
