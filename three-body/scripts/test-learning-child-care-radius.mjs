import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-learning-child-radius-test-'));
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');

try {
  const entry = `
    export { buildDecisionContexts, createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/simulation.ts'))};
    export { ordinaryLearningChildActionAllowed } from ${JSON.stringify(path.resolve('src/game/eland/application/age-planning.ts'))};
    export { chooseSurvivalReflex } from ${JSON.stringify(path.resolve('src/game/eland/domain/survival-reflex.ts'))};
    export { cellX, cellY, cellsInRadius, findStandingPath, standingPositions } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts', '--sourcefile=learning-child-radius-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    buildDecisionContexts,
    cellX,
    cellY,
    cellsInRadius,
    chooseSurvivalReflex,
    createInitialState,
    findStandingPath,
    ordinaryLearningChildActionAllowed,
    standingPositions,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(20260819, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  state.clock.elapsedMonths = 60;
  const parent = state.people[0];
  const child = state.people[1];
  state.people = [parent, child];
  child.bornAtMonth = 24;
  child.geneticParents = [parent.id];
  child.conditions = [];
  child.body = { health: 100, hydration: 100, nutrition: 100 };
  parent.conditions = [];
  parent.body = { health: 100, hydration: 100, nutrition: 100 };

  const radius = 4 + Math.floor(child.baselineCapacities.perception / 25);
  const parentCells = new Set(cellsInRadius(parent.position.cellId, radius));
  const childStanding = cellsInRadius(parent.position.cellId, radius)
    .flatMap((cellId) => standingPositions(state.world.grid, cellId))
    .filter((position) => findStandingPath(state.world.grid, parent.position, position).length > 0)
    .sort((left, right) => {
      const leftDistance = Math.abs(cellX(left.cellId) - cellX(parent.position.cellId)) + Math.abs(cellY(left.cellId) - cellY(parent.position.cellId));
      const rightDistance = Math.abs(cellX(right.cellId) - cellX(parent.position.cellId)) + Math.abs(cellY(right.cellId) - cellY(parent.position.cellId));
      return rightDistance - leftDistance || left.cellId - right.cellId;
    })[0];
  assert.ok(childStanding, 'fixture requires a reachable child position near the parent');
  child.position = {
    cellId: childStanding.cellId, z: childStanding.z,
    previousCellId: childStanding.cellId, previousZ: childStanding.z,
    lastPath: [childStanding.cellId], tickPath: [childStanding.cellId],
  };

  const outsideTarget = cellsInRadius(child.position.cellId, radius)
    .filter((cellId) => !parentCells.has(cellId))
    .flatMap((cellId) => standingPositions(state.world.grid, cellId))
    .filter((position) => findStandingPath(state.world.grid, child.position, position).length > 0)
    .sort((a, b) => a.cellId - b.cellId)[0];
  assert.ok(outsideTarget, 'fixture requires a locally visible target outside the parent care radius');

  state.world.drops.push({
    id: 'test-outside-stone', materialId: 1, quantity: 1,
    cellId: outsideTarget.cellId, z: outsideTarget.z, createdAtMonth: 60, sourceEventIds: [],
  });
  let context = buildDecisionContexts(state).find((candidate) => candidate.person.id === child.id);
  assert.equal(context?.options.some((option) => option.id === 'collect:test-outside-stone'), false,
    '孩子不得把视野内但位于亲代照护半径外的掉落物编译为普通远行');
  assert.equal(ordinaryLearningChildActionAllowed(state, child, { kind: 'move', toCellId: outsideTarget.cellId, toZ: outsideTarget.z }), false,
    '已存在的普通移动意图也不得继续越出照护半径');

  state.world.drops.push({
    id: 'test-stationary-stone', materialId: 1, quantity: 1,
    cellId: child.position.cellId, z: child.position.z, createdAtMonth: 60, sourceEventIds: [],
  });
  context = buildDecisionContexts(state).find((candidate) => candidate.person.id === child.id);
  assert.ok(context?.options.some((option) => option.id === 'collect:test-stationary-stone'),
    '照护半径不能禁止孩子在当前位置完成简单拾取');
  assert.equal(ordinaryLearningChildActionAllowed(state, child, { kind: 'move', toCellId: parent.position.cellId, toZ: parent.position.z }), true,
    '孩子仍可自主走回当前可见亲代身边');

  child.body.hydration = 20;
  const caregiverRendezvous = chooseSurvivalReflex(state, child);
  assert.deepEqual(caregiverRendezvous, { kind: 'move', toCellId: parent.position.cellId, toZ: parent.position.z, caregiverRef: parent.id },
    '身体储备偏低的学龄幼童应先走向当前可见亲代，而不是独自启动远行搜索');

  const caregiverCell = parent.position.cellId;
  child.position = {
    cellId: childStanding.cellId,
    z: childStanding.z,
    previousCellId: caregiverCell,
    previousZ: parent.position.z,
    lastPath: [childStanding.cellId, caregiverCell, childStanding.cellId],
    tickPath: [childStanding.cellId, caregiverCell, childStanding.cellId],
  };
  const postRendezvousReflex = chooseSurvivalReflex(state, child);
  assert.notEqual(postRendezvousReflex?.kind === 'move' ? postRendezvousReflex.caregiverRef : undefined, parent.id,
    '本月已经真实抵达同一亲代后，局部生存反射不得逐刻返回该位置并形成 A-B-A 振荡');

  parent.position.cellId = outsideTarget.cellId;
  const farParentCell = cellsInRadius(outsideTarget.cellId, radius * 3).find((cellId) => !cellsInRadius(child.position.cellId, radius).includes(cellId));
  if (farParentCell !== undefined) parent.position.cellId = farParentCell;
  assert.equal(ordinaryLearningChildActionAllowed(state, child, { kind: 'move', toCellId: outsideTarget.cellId, toZ: outsideTarget.z }), false,
    '没有可见亲代时不得用普通任务继续远行');
  assert.equal(ordinaryLearningChildActionAllowed(state, child, { kind: 'attend', target: { kind: 'person', personId: child.id } }), true,
    '没有可见亲代时仍允许原地动作；急性生存反射位于本过滤器之外');
  const noRemoteRendezvous = chooseSurvivalReflex(state, child);
  assert.notEqual(noRemoteRendezvous?.kind === 'move' ? noRemoteRendezvous.toCellId : undefined, parent.position.cellId,
    '幼童会合不得读取视野外亲代的当前位置');

  console.log('learning child care radius regression passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
