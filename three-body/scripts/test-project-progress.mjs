import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-project-progress-test-'));
const bundlePath = path.join(temporaryDirectory, 'project-progress.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { buildProjectOptions, recordProjectAction, recompileProjectNextAction, synchronizeProject } from ${JSON.stringify(path.resolve('src/game/eland/application/project-options.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { cellX, cellY, cellsInRadius, findStandingPath, setVoxel, standingPositions, topPosition, WORLD_CELL_COUNT } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=project-progress-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    buildProjectOptions, cellX, cellY, cellsInRadius, createInitialState, executePrimitiveAction, findStandingPath, Material, recordProjectAction,
    recompileProjectNextAction, setVoxel, standingPositions, synchronizeProject, topPosition, WORLD_CELL_COUNT,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(815, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  state.clock.elapsedMonths = 12;
  const actor = state.people[0];
  actor.inventory = [];
  const routeCandidates = Array.from({ length: WORLD_CELL_COUNT }, (_, cellId) => cellId)
    .flatMap((cellId) => standingPositions(state.world.grid, cellId))
    .map((target) => ({ target, path: findStandingPath(state.world.grid, actor.position, target) }));
  const route = routeCandidates
    .filter(({ path: candidate }) => candidate.length >= 2)
    .sort((left, right) => left.path.length - right.path.length)[0];
  assert.ok(route, `测试世界中需要一条相邻边的可达路径：${JSON.stringify({
    actorPosition: actor.position,
    standingAtActor: standingPositions(state.world.grid, actor.position.cellId),
    standingTargets: routeCandidates.length,
    reachableTargets: routeCandidates.filter(({ path: candidate }) => candidate.length > 0).length,
    longestPath: Math.max(0, ...routeCandidates.map(({ path: candidate }) => candidate.length)),
  })}`);

  const project = {
    id: 'test-progress-project', kind: 'construction', need: 'shelter-capacity', desiredFunction: 'weather-shelter',
    summary: '沿固定路径取得建造材料', ownerId: actor.id, beneficiaryIds: [actor.id], triggerFactIds: [], pressure: 60,
    createdAtMonth: 1, reviewAtMonth: 100, status: 'active', lastProgressAtMonth: 1,
    site: { cellId: route.target.cellId, z: route.target.z }, missingMaterialIds: [], reservations: [],
    contributorIds: [actor.id], actionEventIds: [], failureEventIds: [], completionEventIds: [], progressEvidence: [],
    logisticsEpisodes: [{
      id: 'test-search-episode', kind: 'search', actorId: actor.id, materialIds: [13], target: route.target,
      sourceRef: { kind: 'project-requirement', projectId: 'test-progress-project' }, sourceEventIds: [],
      createdAt: 12, status: 'active', actionEventIds: [], actionBudget: 8,
    }],
    activeLogisticsEpisodeId: 'test-search-episode',
  };
  state.projects = [project];
  const moveFact = (id, from, to, status = 'progressed') => ({
    id, kind: 'action', actionTick: 1, atMonth: 13, orderInMonth: 0, cellId: to.cellId,
    who: actor.id, intentId: 'test-intent', cause: 'intent',
    action: { kind: 'move', toCellId: route.target.cellId, toZ: route.target.z },
    fromCellId: from.cellId, toCellId: to.cellId, fromZ: from.z, toZ: to.z,
    pathSegment: [from.cellId, to.cellId], status, result: '测试移动', diff: {},
  });

  const forward = moveFact('test-forward', route.path[0], route.path[1], 'completed');
  recordProjectAction(state, project.id, forward);
  assert.equal(project.progressEvidence.length, 1);
  assert.equal(project.progressEvidence[0].kind, 'logistics-advance');
  assert.ok(project.progressEvidence[0].distanceAfter < project.progressEvidence[0].distanceBefore);
  assert.equal(project.lastProgressAtMonth, 13, '接近固定目标必须刷新项目进展月');
  recordProjectAction(state, project.id, forward);
  assert.equal(project.progressEvidence.length, 1, '同一 action fact 不能重复记进展');

  const episode = project.logisticsEpisodes[0];
  episode.status = 'active';
  delete episode.endedAt;
  delete episode.endingReason;
  project.activeLogisticsEpisodeId = episode.id;
  const backward = moveFact('test-backward', route.path[1], route.path[0]);
  recordProjectAction(state, project.id, backward);
  assert.equal(project.progressEvidence.length, 1, '远离目标的移动不能给项目续命');
  const blocked = moveFact('test-blocked-move', route.path[1], route.path[1], 'blocked');
  recordProjectAction(state, project.id, blocked);
  assert.equal(project.progressEvidence.length, 1, '失败或阻塞移动不能算进展');

  const transfer = {
    id: 'test-transfer', kind: 'action', actionTick: 2, atMonth: 14, orderInMonth: 0,
    cellId: actor.position.cellId, who: actor.id, intentId: 'test-intent', cause: 'intent',
    action: { kind: 'transfer', materialId: 13, quantity: 1, from: { kind: 'ground', cellId: actor.position.cellId, z: actor.position.z }, to: { kind: 'person', personId: actor.id } },
    fromCellId: actor.position.cellId, toCellId: actor.position.cellId, fromZ: actor.position.z, toZ: actor.position.z,
    pathSegment: [actor.position.cellId], status: 'completed', result: '取得材料', diff: {},
  };
  recordProjectAction(state, project.id, transfer);
  assert.equal(project.progressEvidence.at(-1).kind, 'material-contribution');
  assert.equal(project.lastProgressAtMonth, 14);

  const stale = structuredClone(project);
  stale.id = 'test-stagnation-project';
  stale.status = 'active';
  stale.reviewAtMonth = 5;
  stale.lastProgressAtMonth = 10;
  stale.actionEventIds = [];
  stale.failureEventIds = [];
  stale.progressEvidence = [];
  stale.logisticsEpisodes = [];
  delete stale.activeLogisticsEpisodeId;
  state.projects.push(stale);
  synchronizeProject(state, stale, 13);
  assert.equal(stale.status, 'active', '距离真实进展未满四个月时不能误判停滞');
  synchronizeProject(state, stale, 14);
  assert.equal(stale.status, 'blocked');
  assert.equal(stale.blockedAtMonth, 14, '停滞终止必须保存可审计月份');

  const exhaustedHypothesis = (projectId, endedAt) => ({
    version: 'project-hypothesis-campaign-v2',
    id: `hypothesis:${projectId}`,
    projectId,
    actorId: actor.id,
    openedAt: 1,
    budget: 7,
    noResponseBudget: 4,
    responseBudget: 3,
    observedMaterialIds: [],
    sourceFactIds: [],
    sourceKeys: [],
    candidates: [],
    attempts: [],
    status: 'exhausted',
    endedAt,
    endingReason: 'no-response-budget-exhausted',
  });
  const inquiryExhausted = structuredClone(stale);
  inquiryExhausted.id = 'test-explicitly-exhausted-project';
  inquiryExhausted.kind = 'production';
  inquiryExhausted.need = 'coordination-capacity';
  inquiryExhausted.desiredFunction = 'fortified-coordination';
  inquiryExhausted.summary = '已经穷尽有限实体假说';
  inquiryExhausted.status = 'active';
  inquiryExhausted.reviewAtMonth = 100;
  inquiryExhausted.lastProgressAtMonth = 12;
  inquiryExhausted.hypothesisCampaign = exhaustedHypothesis(inquiryExhausted.id, 12);
  state.projects.push(inquiryExhausted);
  state.clock.elapsedMonths = 12;
  assert.equal(recompileProjectNextAction(state, actor, inquiryExhausted.id), null);
  assert.equal(inquiryExhausted.status, 'blocked',
    '当前有限假说已明确穷尽且没有合法等待时，不应继续占用所有者到长期 review');
  assert.equal(inquiryExhausted.blockedAtMonth, 13);

  const progressedAfterOldExhaustion = structuredClone(inquiryExhausted);
  progressedAfterOldExhaustion.id = 'test-progress-after-old-exhaustion';
  progressedAfterOldExhaustion.status = 'active';
  delete progressedAfterOldExhaustion.blockedAtMonth;
  delete progressedAfterOldExhaustion.blockedReason;
  progressedAfterOldExhaustion.lastProgressAtMonth = 12;
  progressedAfterOldExhaustion.hypothesisCampaign = exhaustedHypothesis(
    progressedAfterOldExhaustion.id,
    10,
  );
  state.projects.push(progressedAfterOldExhaustion);
  assert.equal(recompileProjectNextAction(state, actor, progressedAfterOldExhaustion.id), null);
  assert.equal(progressedAfterOldExhaustion.status, 'active',
    '旧假说穷尽后已有更新进展时，历史 terminal campaign 不能误杀当前项目');

  const activeRenewalAfterExhaustion = structuredClone(inquiryExhausted);
  activeRenewalAfterExhaustion.id = 'test-active-renewal-after-exhaustion';
  activeRenewalAfterExhaustion.status = 'active';
  delete activeRenewalAfterExhaustion.blockedAtMonth;
  delete activeRenewalAfterExhaustion.blockedReason;
  activeRenewalAfterExhaustion.need = 'high-heat-capability';
  activeRenewalAfterExhaustion.desiredFunction = 'high-heat-processing';
  activeRenewalAfterExhaustion.hypothesisCampaign = exhaustedHypothesis(
    activeRenewalAfterExhaustion.id,
    12,
  );
  activeRenewalAfterExhaustion.missingMaterialIds = [Material.Clay];
  activeRenewalAfterExhaustion.materialDemands = [{
    materialId: Material.Clay,
    requiredQuantity: 1,
    availableQuantity: 0,
    outstandingQuantity: 1,
    branchKey: 'test-current-clay-demand',
    sourceFactIds: ['new-evidence'],
  }];
  activeRenewalAfterExhaustion.searchCampaigns = [{
    id: 'new-active-search',
    projectId: activeRenewalAfterExhaustion.id,
    ownerId: actor.id,
    actorId: actor.id,
    materialIds: [Material.Clay],
    basisKey: 'new-evidence-basis',
    openedAt: 13,
    anchor: { ...actor.position },
    cellIds: [actor.position.cellId],
    attemptedTargetKeys: [],
    sourceFactIds: ['new-evidence'],
    status: 'active',
  }];
  actor.inventory = [{
    id: 'active-search-stone', materialId: Material.Stone, quantity: 1, sourceEventIds: ['active-search-stone'],
  }];
  state.projects.push(activeRenewalAfterExhaustion);
  recompileProjectNextAction(state, actor, activeRenewalAfterExhaustion.id);
  assert.equal(activeRenewalAfterExhaustion.status, 'active',
    '真实 Clay 缺口已经开启精确匹配的 active search 时，旧 exhausted hypothesis 不能提前阻塞项目');

  const staleActiveSearch = structuredClone(inquiryExhausted);
  staleActiveSearch.id = 'test-stale-active-search-does-not-protect-hypothesis';
  staleActiveSearch.status = 'active';
  delete staleActiveSearch.blockedAtMonth;
  delete staleActiveSearch.blockedReason;
  staleActiveSearch.hypothesisCampaign = exhaustedHypothesis(staleActiveSearch.id, 12);
  staleActiveSearch.missingMaterialIds = [];
  staleActiveSearch.materialDemands = [];
  staleActiveSearch.searchCampaigns = [{
    id: 'stale-active-search',
    projectId: staleActiveSearch.id,
    ownerId: actor.id,
    actorId: actor.id,
    materialIds: [Material.Clay],
    basisKey: 'stale-material-branch',
    openedAt: 10,
    anchor: { ...actor.position },
    cellIds: [actor.position.cellId],
    attemptedTargetKeys: [],
    sourceFactIds: ['old-clay-evidence'],
    status: 'active',
  }];
  state.projects.push(staleActiveSearch);
  assert.equal(recompileProjectNextAction(state, actor, staleActiveSearch.id), null);
  assert.equal(staleActiveSearch.status, 'blocked',
    '当前已经没有物料缺口时，悬空的旧 active search 不得压住已穷尽 hypothesis');

  const staleActiveHypothesis = structuredClone(activeRenewalAfterExhaustion);
  staleActiveHypothesis.id = 'test-stale-active-hypothesis-does-not-protect-search';
  staleActiveHypothesis.status = 'active';
  delete staleActiveHypothesis.blockedAtMonth;
  delete staleActiveHypothesis.blockedReason;
  staleActiveHypothesis.hypothesisCampaign = {
    ...exhaustedHypothesis(staleActiveHypothesis.id, 12),
    status: 'active',
  };
  delete staleActiveHypothesis.hypothesisCampaign.endedAt;
  delete staleActiveHypothesis.hypothesisCampaign.endingReason;
  staleActiveHypothesis.logisticsEpisodes = [];
  delete staleActiveHypothesis.activeLogisticsEpisodeId;
  staleActiveHypothesis.searchCampaigns = [{
    id: 'current-exhausted-clay-search',
    projectId: staleActiveHypothesis.id,
    ownerId: actor.id,
    actorId: actor.id,
    materialIds: [Material.Clay],
    basisKey: `project-search-campaign-v1|project=${staleActiveHypothesis.id}|actor=${actor.id}|materials=${Material.Clay}|plan=none`,
    openedAt: 12,
    anchor: { ...actor.position },
    cellIds: [actor.position.cellId],
    attemptedTargetKeys: [`${actor.position.cellId}:${actor.position.z}`],
    sourceFactIds: ['current-clay-evidence'],
    status: 'exhausted',
    closedAt: 12,
  }];
  state.projects.push(staleActiveHypothesis);
  assert.equal(recompileProjectNextAction(state, actor, staleActiveHypothesis.id), null);
  assert.equal(staleActiveHypothesis.status, 'blocked',
    '当前精确物料分支已穷尽时，旧 active hypothesis 不得反向把项目留到长期 review');

  const cultivationWait = structuredClone(inquiryExhausted);
  cultivationWait.id = 'test-cultivation-growth-wait';
  cultivationWait.kind = 'production';
  cultivationWait.need = 'production-efficiency';
  cultivationWait.desiredFunction = 'settled-cultivation';
  cultivationWait.summary = '等待已经播下的作物自然成熟';
  cultivationWait.status = 'active';
  delete cultivationWait.blockedAtMonth;
  delete cultivationWait.blockedReason;
  cultivationWait.site = { cellId: actor.position.cellId, z: actor.position.z };
  cultivationWait.lastProgressAtMonth = 12;
  cultivationWait.hypothesisCampaign = exhaustedHypothesis(cultivationWait.id, 12);
  cultivationWait.searchCampaigns = [{
    id: 'historical-exhausted-seed-search',
    projectId: cultivationWait.id,
    ownerId: actor.id,
    actorId: actor.id,
    materialIds: [Material.Seed],
    basisKey: 'historical-seed-basis',
    openedAt: 10,
    anchor: { ...actor.position },
    cellIds: [actor.position.cellId],
    attemptedTargetKeys: [`${actor.position.cellId}:${actor.position.z}`],
    sourceFactIds: ['historical-seed-pressure'],
    status: 'exhausted',
    closedAt: 12,
  }];
  actor.inventory = [];
  for (const cellId of cellsInRadius(cultivationWait.site.cellId, 2).slice(0, 6)) {
    const position = topPosition(state.world.grid, cellId);
    setVoxel(state.world.grid, cellX(cellId), cellY(cellId), position.z, Material.CropSprout);
  }
  state.projects.push(cultivationWait);
  assert.equal(recompileProjectNextAction(state, actor, cultivationWait.id), null);
  assert.equal(cultivationWait.status, 'active',
    '第六格已经播种后即使库存 Seed 为 0，历史 Seed 搜索与假说穷尽也不得破坏真实生长等待');

  const exhaustedSeedSearch = structuredClone(cultivationWait);
  exhaustedSeedSearch.id = 'test-cultivation-seed-search-exhausted';
  exhaustedSeedSearch.status = 'active';
  delete exhaustedSeedSearch.blockedAtMonth;
  delete exhaustedSeedSearch.blockedReason;
  exhaustedSeedSearch.hypothesisCampaign = undefined;
  exhaustedSeedSearch.missingMaterialIds = [];
  exhaustedSeedSearch.materialDemands = [];
  exhaustedSeedSearch.searchCampaigns = [{
    id: 'exhausted-seed-search',
    projectId: exhaustedSeedSearch.id,
    ownerId: actor.id,
    actorId: actor.id,
    materialIds: [Material.Seed],
    basisKey: `project-search-campaign-v1|project=${exhaustedSeedSearch.id}|actor=${actor.id}|materials=${Material.Seed}|plan=none`,
    openedAt: 12,
    anchor: { ...actor.position },
    cellIds: [actor.position.cellId],
    attemptedTargetKeys: [`${actor.position.cellId}:${actor.position.z}`],
    sourceFactIds: ['seed-pressure'],
    status: 'exhausted',
    closedAt: 12,
  }];
  actor.inventory = [];
  actor.knownPlaces = actor.knownPlaces.filter((place) => (
    place.materialId !== Material.Seed
    && place.materialId !== Material.BerryBush
    && place.materialId !== Material.CropMature
  ));
  state.world.drops = state.world.drops.filter((drop) => drop.materialId !== Material.Seed);
  for (const cellId of cellsInRadius(actor.position.cellId, 12)) {
    const position = topPosition(state.world.grid, cellId);
    setVoxel(state.world.grid, cellX(cellId), cellY(cellId), position.z, Material.RichSoil);
  }
  state.projects.push(exhaustedSeedSearch);
  assert.equal(recompileProjectNextAction(state, actor, exhaustedSeedSearch.id), null);
  assert.equal(exhaustedSeedSearch.status, 'blocked',
    '耕作项目的种源搜索已经明确穷尽时，不能把无作物状态误当成自然生长等待');

  const finiteState = createInitialState(816, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  finiteState.clock.elapsedMonths = 12;
  finiteState.world.drops = [];
  const finiteActor = finiteState.people[0];
  finiteActor.inventory = [
    { id: 'finite-iron-ore', materialId: Material.IronOre, quantity: 1, sourceEventIds: ['finite-iron-ore'] },
    { id: 'finite-stone', materialId: Material.Stone, quantity: 1, sourceEventIds: ['finite-stone'] },
  ];
  finiteActor.knowledge = [];
  const finiteCandidateProject = {
    id: 'test-finite-candidate-pool-exhaustion',
    kind: 'inquiry',
    need: 'coordination-capacity',
    desiredFunction: 'fortified-coordination',
    summary: '用当前两项实体尝试更坚固的公共结构',
    ownerId: finiteActor.id,
    beneficiaryIds: [finiteActor.id],
    triggerFactIds: [],
    pressure: 62,
    createdAtMonth: 12,
    reviewAtMonth: 100,
    status: 'active',
    lastProgressAtMonth: 12,
    site: { ...finiteActor.position },
    missingMaterialIds: [],
    materialDemands: [],
    reservations: [],
    contributorIds: [finiteActor.id],
    actionEventIds: [],
    failureEventIds: [],
    completionEventIds: [],
    progressEvidence: [],
    logisticsEpisodes: [],
    searchCampaigns: [],
  };
  finiteState.projects = [finiteCandidateProject];
  const onlyFiniteAttempt = recompileProjectNextAction(
    finiteState,
    finiteActor,
    finiteCandidateProject.id,
  );
  assert.equal(onlyFiniteAttempt?.kind, 'act');
  assert.equal(onlyFiniteAttempt?.operation, 'combine');
  assert.equal(finiteCandidateProject.hypothesisCampaign?.candidates.length, 1,
    '只观察到两种各一份的实体时，当前 combine 候选池只有一项');
  const finiteNoResponse = executePrimitiveAction(
    finiteState,
    finiteActor,
    onlyFiniteAttempt,
    13,
    0,
    { cause: 'project', projectId: finiteCandidateProject.id, actionTick: 1 },
  );
  finiteState.world.past.push(finiteNoResponse);
  recordProjectAction(finiteState, finiteCandidateProject.id, finiteNoResponse);
  assert.equal(finiteNoResponse.status, 'blocked');
  assert.equal(finiteCandidateProject.hypothesisCampaign?.attempts.length, 1);
  assert.equal(finiteCandidateProject.hypothesisCampaign?.status, 'active',
    '一次无响应尚未达到数字 budget，但候选池本身已经可被下一次规划证明穷尽');
  const finitePlannerOptions = buildProjectOptions(
    finiteState,
    finiteActor,
    [finiteActor.position.cellId],
    [],
    [],
  );
  assert.equal(finitePlannerOptions.some((option) => option.projectId === finiteCandidateProject.id), false,
    '候选池已穷尽时，规划预览不得暴露一项虚假的项目动作');
  assert.equal(finiteCandidateProject.hypothesisCampaign?.status, 'exhausted');
  assert.equal(finiteCandidateProject.hypothesisCampaign?.endingReason, 'attempt-budget-exhausted');
  assert.ok(finiteCandidateProject.hypothesisCampaign.attempts.length
    < finiteCandidateProject.hypothesisCampaign.noResponseBudget,
  '可感知的有限候选已用尽时，不应为凑数字 budget 继续占用所有者');
  assert.equal(finiteCandidateProject.status, 'blocked',
    '小于数字 budget 的真实有限候选池穷尽后应当立即释放项目');

  process.stdout.write('project progress tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
