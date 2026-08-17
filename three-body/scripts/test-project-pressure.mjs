import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-project-pressure-test-'));
const bundlePath = path.join(temporaryDirectory, 'project-pressure.mjs');

try {
  const testEntry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { refreshProjectPressure } from ${JSON.stringify(path.resolve('src/game/eland/application/project-options.ts'))};
    export { buildProjectPressureBasis } from ${JSON.stringify(path.resolve('src/game/eland/application/project-pressure.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=project-pressure-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: testEntry, stdio: ['pipe', 'pipe', 'pipe'] });
  const { buildProjectPressureBasis, createInitialState, refreshProjectPressure } = await import(
    `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
  );

  const state = createInitialState(814, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  state.clock.elapsedMonths = 12;
  state.world.past = [];
  state.world.animals = [];
  const owner = state.people[0];
  const other = state.people[1];
  owner.inventory = [];
  owner.memories = [];
  other.position = structuredClone(owner.position);
  const visible = {
    visibleCells: [owner.position.cellId],
    visibleDrops: [],
    visiblePeople: [owner, other],
  };
  const huntFact = (id, who, atMonth, animalId) => ({
    id, kind: 'action', actionTick: 0, atMonth, orderInMonth: 0,
    cellId: owner.position.cellId, who, cause: 'intent',
    action: { kind: 'act', operation: 'hunt', targets: [{ kind: 'animal', animalId }] },
    fromCellId: owner.position.cellId, toCellId: owner.position.cellId,
    fromZ: owner.position.z, toZ: owner.position.z, pathSegment: [owner.position.cellId],
    status: 'failed', result: '没有猎获动物', diff: { animalId, killed: false },
  });
  const ownFailure = huntFact('test-own-hunt-failure', owner.id, 10, 'test-deer-a');
  const otherFailure = huntFact('test-other-hunt-failure', other.id, 10, 'test-deer-b');
  state.world.past.push(ownFailure, otherFailure);
  owner.memories.push({
    id: 'memory-own-hunt-failure', kind: 'failure', summary: '自己的捕猎失败', importance: 72,
    createdAtMonth: 10, lastRecalledAtMonth: 10, personIds: [], sourceEventIds: [ownFailure.id, otherFailure.id],
  });

  const subject = { need: 'hunting-safety', beneficiaryIds: [owner.id], createdAtMonth: 13 };
  const initial = buildProjectPressureBasis(state, owner, subject, 13, visible);
  assert.ok(initial.reasonKeys.includes('own-hunt-failure'));
  assert.ok(initial.sourceFactIds.includes(ownFailure.id), '本人的失败必须成为压力来源');
  assert.ok(!initial.sourceFactIds.includes(otherFailure.id), '即使听说或身处同一猎场，他人的失败也不能冒充本人经验');
  const oneMonthLater = buildProjectPressureBasis(state, owner, subject, 14, visible);
  assert.equal(oneMonthLater.basisKey, initial.basisKey, '单纯过月不能产生新的压力边沿');
  assert.equal(oneMonthLater.pressure, initial.pressure);

  const animal = (id, speciesId) => ({
    id, speciesId, sex: 'female', bornAtMonth: 0, lifespanMonths: 120, geneticParents: [],
    position: {
      cellId: owner.position.cellId, z: owner.position.z,
      previousCellId: owner.position.cellId, previousZ: owner.position.z,
    },
    health: 100, hunger: 20, lastAteAtMonth: 12,
  });
  state.world.animals = [animal('visible-deer', 'deer')];
  const withDeer = buildProjectPressureBasis(state, owner, subject, 14, visible);
  assert.equal(withDeer.basisKey, initial.basisKey, '普通草食动物不能制造猛兽压力');
  state.world.animals = [animal('visible-wolf', 'wolf')];
  const withWolf = buildProjectPressureBasis(state, owner, subject, 14, visible);
  assert.ok(withWolf.reasonKeys.includes('visible-aggressive-animal'));
  assert.notEqual(withWolf.basisKey, initial.basisKey, '当前可见且存活的攻击性动物必须形成新边沿');

  const secondFailure = huntFact('test-own-hunt-failure-2', owner.id, 11, 'test-boar-a');
  state.world.past.push(secondFailure);
  owner.memories.push({
    id: 'memory-own-hunt-failure-2', kind: 'failure', summary: '再次捕猎失败', importance: 72,
    createdAtMonth: 11, lastRecalledAtMonth: 11, personIds: [], sourceEventIds: [secondFailure.id],
  });
  const afterSecondFailure = buildProjectPressureBasis(state, owner, subject, 14, visible);
  assert.ok(afterSecondFailure.pressure > withWolf.pressure, '新增的本人失败边沿必须提高无长矛时的压力');

  const project = {
    id: 'test-pressure-project', kind: 'production', need: 'hunting-safety', desiredFunction: 'safer-hunting',
    summary: '降低捕猎风险', ownerId: owner.id, beneficiaryIds: [owner.id],
    triggerFactIds: [...initial.sourceFactIds], pressure: initial.pressure, pressureBasis: structuredClone(initial),
    pressureHistory: [structuredClone(initial)], createdAtMonth: 13, reviewAtMonth: 24,
    status: 'active', lastProgressAtMonth: 13, missingMaterialIds: [], reservations: [], contributorIds: [owner.id],
    actionEventIds: [], failureEventIds: [], completionEventIds: [], logisticsEpisodes: [],
  };
  state.projects = [project];
  state.world.animals = [];
  state.world.past = [ownFailure, otherFailure];
  owner.memories = owner.memories.slice(0, 1);
  refreshProjectPressure(state, project, 14);
  assert.equal(project.pressureHistory.length, 1, '相同 basis 不能重复写入压力历史');
  state.world.past.push(secondFailure);
  owner.memories.push({
    id: 'memory-own-hunt-failure-2b', kind: 'failure', summary: '再次捕猎失败', importance: 72,
    createdAtMonth: 11, lastRecalledAtMonth: 11, personIds: [], sourceEventIds: [secondFailure.id],
  });
  refreshProjectPressure(state, project, 14);
  assert.equal(project.pressureHistory.length, 2, '真实的新边沿必须留下恰好一次压力更新');
  const duplicateFailure = huntFact('test-own-hunt-failure-duplicate', owner.id, 11, 'test-boar-a');
  state.world.past.push(duplicateFailure);
  owner.memories.push({
    id: 'memory-own-hunt-failure-duplicate', kind: 'failure', summary: '同一次失败的另一条来源', importance: 72,
    createdAtMonth: 11, lastRecalledAtMonth: 11, personIds: [], sourceEventIds: [duplicateFailure.id],
  });
  refreshProjectPressure(state, project, 14);
  assert.equal(project.pressureHistory.length, 2, '来源变化但离散状态边沿相同，不能伪造压力更新');
  refreshProjectPressure(state, project, 15);
  assert.equal(project.pressureHistory.length, 2, '重复同步和纯过月都不能追加历史');

  owner.bornAtMonth = 13 - (50 * 12 - 1);
  const knowledgeSubject = { need: 'knowledge-preservation', beneficiaryIds: [owner.id], createdAtMonth: 13 };
  const beforeFifty = buildProjectPressureBasis(state, owner, knowledgeSubject, 13, visible);
  const atFifty = buildProjectPressureBasis(state, owner, knowledgeSubject, 14, visible);
  assert.notEqual(beforeFifty.basisKey, atFifty.basisKey, '只有跨越年龄分段时才应形成年龄边沿');
  const afterFifty = buildProjectPressureBasis(state, owner, knowledgeSubject, 15, visible);
  assert.equal(afterFifty.basisKey, atFifty.basisKey, '同一年龄分段内逐月变老不能改变 basis');

  const needs = [
    'thermal-safety', 'hunting-safety', 'care-capability',
    'food-preparation', 'shelter-capacity', 'knowledge-preservation',
  ];
  for (const need of needs) {
    const basis = buildProjectPressureBasis(state, owner, { need, beneficiaryIds: [owner.id], createdAtMonth: 15 }, 15, visible);
    assert.equal(basis.version, 'project-pressure-basis-v1');
    assert.equal(basis.observerId, owner.id);
    assert.equal(basis.need, need);
  }

  process.stdout.write('project pressure tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
