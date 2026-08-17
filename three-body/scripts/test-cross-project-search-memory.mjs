import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-cross-project-search-memory-test-'));
const bundlePath = path.join(temporaryDirectory, 'cross-project-search-memory.mjs');

function createProject(id, actor, { pressure = 55, planKnowledgeId } = {}) {
  return {
    id,
    kind: 'inquiry',
    need: 'knowledge-preservation',
    desiredFunction: 'durable-record',
    summary: '寻找可记录材料',
    ownerId: actor.id,
    beneficiaryIds: [actor.id],
    triggerFactIds: [],
    pressure,
    createdAtMonth: 1,
    reviewAtMonth: 100,
    status: 'active',
    lastProgressAtMonth: 1,
    ...(planKnowledgeId ? { planKnowledgeId } : {}),
    missingMaterialIds: [13],
    reservations: [],
    contributorIds: [actor.id],
    actionEventIds: [],
    failureEventIds: [],
    completionEventIds: [],
    logisticsEpisodes: [],
    progressEvidence: [],
    searchCampaigns: [],
  };
}

function destinationKey(destination) {
  return `${destination.target.cellId}:${destination.target.z}`;
}

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export { visibleReachableSearchDestination } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=cross-project-search-memory-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const { createInitialState, visibleReachableSearchDestination } = await import(
    `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
  );

  const state = createInitialState(816, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  state.clock.elapsedMonths = 12;
  const actor = state.people[0];
  const originalPosition = structuredClone(actor.position);
  const oldProject = createProject('test-old-search-project', actor);
  state.projects = [oldProject];

  const oldTargetKeys = [];
  for (let index = 0; index < 3; index += 1) {
    const destination = visibleReachableSearchDestination(state, actor, oldProject, [13]);
    assert.ok(destination, '旧项目应能搜索若干个局部 target');
    oldTargetKeys.push(destinationKey(destination));
  }
  assert.equal(new Set(oldTargetKeys).size, oldTargetKeys.length, '旧 campaign 的 target 应互不重复');
  const oldCampaign = oldProject.searchCampaigns[0];
  assert.ok(oldCampaign);

  state.clock.elapsedMonths += 4;
  const inheritedProject = createProject('test-new-search-project', actor, { pressure: 91 });
  state.projects.push(inheritedProject);
  const inheritedDestination = visibleReachableSearchDestination(state, actor, inheritedProject, [13]);
  assert.ok(inheritedDestination, '新项目应继续搜索重叠区域中尚未尝试的 target');
  const inheritedCampaign = inheritedProject.searchCampaigns[0];
  assert.deepEqual(inheritedCampaign.inheritedCampaignIds, [oldCampaign.id], '项目 ID、月份和压力变化不应清除旧 campaign 来源');
  assert.deepEqual(inheritedCampaign.inheritedTargetKeys, [...oldTargetKeys].sort(), '新 campaign 应继承重叠区域的已搜索 target');
  assert.ok(!oldTargetKeys.includes(destinationKey(inheritedDestination)), '新 campaign 不得再返回已继承的 target');

  const changedPlanProject = createProject('test-changed-plan-search-project', actor, {
    planKnowledgeId: 'test-new-plan-edge',
  });
  state.projects.push(changedPlanProject);
  const changedPlanDestination = visibleReachableSearchDestination(state, actor, changedPlanProject, [13]);
  assert.ok(changedPlanDestination, '新的 plan knowledge basis 应仍能开启搜索');
  const changedPlanCampaign = changedPlanProject.searchCampaigns[0];
  assert.deepEqual(changedPlanCampaign.inheritedCampaignIds ?? [], [], '换新 planKnowledgeId 时不应继承旧 campaign');
  assert.deepEqual(changedPlanCampaign.inheritedTargetKeys ?? [], [], '换新 planKnowledgeId 时不应继承旧 target');

  const otherActor = state.people[1];
  assert.ok(otherActor, '定向测试需要第二个 actor');
  otherActor.position = structuredClone(originalPosition);
  otherActor.baselineCapacities.perception = actor.baselineCapacities.perception;
  const otherActorProject = createProject('test-other-actor-search-project', otherActor);
  state.projects.push(otherActorProject);
  const otherActorDestination = visibleReachableSearchDestination(state, otherActor, otherActorProject, [13]);
  assert.ok(otherActorDestination, '另一 actor 在同一区域应能开启自己的搜索');
  const otherActorCampaign = otherActorProject.searchCampaigns[0];
  assert.deepEqual(otherActorCampaign.cellIds, oldCampaign.cellIds, '他人不继承的断言应在同一可见区域下成立');
  assert.deepEqual(otherActorCampaign.inheritedCampaignIds ?? [], [], '另一 actor 不应继承旧 actor 的 campaign');
  assert.deepEqual(otherActorCampaign.inheritedTargetKeys ?? [], [], '另一 actor 不应继承旧 actor 的 target');

  process.stdout.write('cross-project search memory tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
