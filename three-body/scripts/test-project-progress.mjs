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
    export { recordProjectAction, synchronizeProject } from ${JSON.stringify(path.resolve('src/game/eland/application/project-options.ts'))};
    export { findStandingPath, standingPositions, WORLD_CELL_COUNT } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=project-progress-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    createInitialState, findStandingPath, recordProjectAction, standingPositions, synchronizeProject, WORLD_CELL_COUNT,
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

  process.stdout.write('project progress tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
