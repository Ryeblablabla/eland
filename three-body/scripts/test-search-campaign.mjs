import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-search-campaign-test-'));
const bundlePath = path.join(temporaryDirectory, 'search-campaign.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { visibleReachableSearchDestination } from ${JSON.stringify(path.resolve('src/game/eland/application/project-options.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.resolve('src/game/eland/domain/project.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=search-campaign-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const { createInitialState, instantiateProject, visibleReachableSearchDestination } = await import(
    `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
  );

  const state = createInitialState(816, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  state.clock.elapsedMonths = 12;
  const actor = state.people[0];
  const originalPosition = structuredClone(actor.position);
  const project = {
    id: 'test-search-campaign-project', kind: 'inquiry', need: 'knowledge-preservation', desiredFunction: 'durable-record',
    summary: '寻找可记录材料', ownerId: actor.id, beneficiaryIds: [actor.id], triggerFactIds: [], pressure: 55,
    createdAtMonth: 1, reviewAtMonth: 100, status: 'active', lastProgressAtMonth: 1,
    missingMaterialIds: [13], reservations: [], contributorIds: [actor.id], actionEventIds: [], failureEventIds: [],
    completionEventIds: [], logisticsEpisodes: [], progressEvidence: [], searchCampaigns: [],
  };
  state.projects = [project];

  const first = visibleReachableSearchDestination(state, actor, project, [13]);
  assert.ok(first, '局部区域存在候选时应开启第一次搜索');
  assert.equal(project.searchCampaigns.length, 1);
  const campaign = project.searchCampaigns[0];
  const frozenCells = [...campaign.cellIds];
  assert.ok(campaign.cellIds.includes(first.target.cellId));
  assert.deepEqual(campaign.attemptedTargetKeys, [`${first.target.cellId}:${first.target.z}`]);

  const targets = [`${first.target.cellId}:${first.target.z}`];
  for (let index = 0; index < 10_000; index += 1) {
    const destination = visibleReachableSearchDestination(state, actor, project, [13]);
    if (!destination) break;
    assert.ok(campaign.cellIds.includes(destination.target.cellId), '搜索目标不能越出开启时的固定区域');
    targets.push(`${destination.target.cellId}:${destination.target.z}`);
  }
  assert.equal(new Set(targets).size, targets.length, '同一 campaign 的 standing target 只能尝试一次');
  assert.equal(campaign.status, 'exhausted', '固定区域遍历完毕后 campaign 必须耗尽');
  const countAfterExhaustion = project.searchCampaigns.length;
  state.clock.elapsedMonths += 1;
  assert.equal(visibleReachableSearchDestination(state, actor, project, [13]), null, '纯过月不能重开已耗尽 campaign');
  assert.equal(project.searchCampaigns.length, countAfterExhaustion);

  const outside = state.people.find((person) => !campaign.cellIds.includes(person.position.cellId));
  if (outside) actor.position = structuredClone(outside.position);
  assert.equal(visibleReachableSearchDestination(state, actor, project, [13]), null, '移动到新视野不能拖动已耗尽搜索地平线');
  assert.deepEqual(campaign.cellIds, frozenCells, 'campaign 的候选区域必须保持冻结');

  actor.position = originalPosition;
  project.planKnowledgeId = 'test-new-plan-edge';
  const reopened = visibleReachableSearchDestination(state, actor, project, [13]);
  assert.ok(reopened, '新的 plan knowledge edge 可以开启新 campaign');
  assert.equal(project.searchCampaigns.length, countAfterExhaustion + 1);
  assert.equal(project.searchCampaigns.at(-1).openedAt, 14);

  const accepted = instantiateProject({
    id: 'test-proposal-with-campaign', kind: 'inquiry', need: 'knowledge-preservation', desiredFunction: 'durable-record',
    summary: '保留初始搜索区域', ownerId: actor.id, beneficiaryIds: [actor.id], triggerFactIds: [], pressure: 55,
    createdAtMonth: 14, reviewAtMonth: 25,
    initialSearchCampaign: structuredClone(project.searchCampaigns.at(-1)),
    initialLogisticsEpisode: {
      id: 'test-initial-search-episode', kind: 'search', actorId: actor.id, materialIds: [13],
      target: reopened.target, sourceRef: { kind: 'project-requirement', projectId: 'test-proposal-with-campaign' },
      searchCampaignId: project.searchCampaigns.at(-1).id, sourceEventIds: [], createdAt: 14,
      status: 'active', actionEventIds: [], actionBudget: 8,
    },
  });
  assert.equal(accepted.searchCampaigns.length, 1, '提议被接受时必须保留首个 campaign');
  assert.equal(accepted.logisticsEpisodes[0].searchCampaignId, accepted.searchCampaigns[0].id);

  process.stdout.write('search campaign tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
