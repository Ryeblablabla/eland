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
    export {
      buildProjectPressureBasis,
      createProjectPressureCompilationDiagnostics,
    } from ${JSON.stringify(path.resolve('src/game/eland/application/project-pressure.ts'))};
    export { deriveProjectProposals } from ${JSON.stringify(path.resolve('src/game/eland/application/projects/project-proposals.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=project-pressure-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: testEntry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    buildProjectPressureBasis,
    createInitialState,
    createProjectPressureCompilationDiagnostics,
    deriveProjectProposals,
    Material,
    refreshProjectPressure,
  } = await import(
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

  owner.inventory = [
    { id: 'test-bronze', materialId: Material.Bronze, quantity: 1, sourceEventIds: ['test-bronze-produced'] },
    { id: 'test-tool-wood', materialId: Material.Wood, quantity: 1, sourceEventIds: ['test-tool-wood-gathered'] },
  ];
  const alloyingPressure = buildProjectPressureBasis(state, owner, {
    need: 'alloy-capability', desiredFunction: 'bronze-alloying', beneficiaryIds: [owner.id], createdAtMonth: 15,
  }, 15, visible);
  const toolingPressure = buildProjectPressureBasis(state, owner, {
    need: 'alloy-capability', desiredFunction: 'bronze-tooling', beneficiaryIds: [owner.id], createdAtMonth: 15,
  }, 15, visible);
  assert.ok(alloyingPressure.pressure < 42, '已有青铜应降低继续试铸青铜的压力');
  assert.ok(toolingPressure.pressure >= 42, '已有青铜应成为制作生产工具的正向依据');
  assert.ok(toolingPressure.reasonKeys.includes('bronze-ready-for-tooling'));
  assert.notEqual(toolingPressure.basisKey, alloyingPressure.basisKey, '同一需求下的不同功能项目必须保留不同压力依据');

  const compilationState = createInitialState(815, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  compilationState.clock.elapsedMonths = 12;
  compilationState.world.past = [];
  compilationState.world.animals = [];
  compilationState.projects = [];
  const compilationOwner = compilationState.people[0];
  const compilationOther = compilationState.people[1];
  compilationOwner.inventory = [];
  compilationOwner.memories = [];
  compilationOther.position = structuredClone(compilationOwner.position);
  const compilationVisibleCells = [compilationOwner.position.cellId];
  const compilationVisiblePeople = [compilationOwner, compilationOther];
  const compilationFailureA = huntFact(
    'test-compilation-hunt-failure-a',
    compilationOwner.id,
    10,
    'test-compilation-deer-a',
  );
  compilationState.world.past.push(compilationFailureA);
  const compilationMemory = {
    id: 'memory-compilation-hunt-failures', kind: 'failure', summary: '编译期捕猎失败', importance: 72,
    createdAtMonth: 10, lastRecalledAtMonth: 10, personIds: [],
    sourceEventIds: [compilationFailureA.id],
  };
  compilationOwner.memories.push(compilationMemory);

  const cachedDiagnostics = createProjectPressureCompilationDiagnostics();
  const cachedProposals = deriveProjectProposals(
    compilationState,
    compilationOwner,
    compilationVisibleCells,
    [],
    compilationVisiblePeople,
    { pressureDiagnostics: cachedDiagnostics },
  );
  const directDiagnostics = createProjectPressureCompilationDiagnostics();
  const directProposals = deriveProjectProposals(
    compilationState,
    compilationOwner,
    compilationVisibleCells,
    [],
    compilationVisiblePeople,
    { reuseProjectPressureContext: false, pressureDiagnostics: directDiagnostics },
  );
  assert.equal(
    JSON.stringify(cachedProposals),
    JSON.stringify(directProposals),
    '缓存开关前后提案 options、basis 与排序决策必须逐字相等',
  );
  assert.deepEqual(cachedDiagnostics, {
    rememberedSourceSnapshotBuilds: 1,
    rememberedCandidateResolutions: 1,
    rememberedSelections: 1,
  }, '一次 proposal compilation 只能构建一次 remembered evidence');
  assert.ok(
    directDiagnostics.rememberedSourceSnapshotBuilds > cachedDiagnostics.rememberedSourceSnapshotBuilds
      && directDiagnostics.rememberedCandidateResolutions > cachedDiagnostics.rememberedCandidateResolutions
      && directDiagnostics.rememberedSelections > cachedDiagnostics.rememberedSelections,
    '关闭 compilation cache 后应暴露重复 flatten/resolve/sort，证明默认路径已消除重复工作',
  );

  const compilationFailureB = huntFact(
    'test-compilation-hunt-failure-b',
    compilationOwner.id,
    11,
    'test-compilation-deer-b',
  );
  compilationState.world.past.push(compilationFailureB);
  compilationMemory.sourceEventIds.push(compilationFailureB.id);
  const refreshedDiagnostics = createProjectPressureCompilationDiagnostics();
  const refreshedProposals = deriveProjectProposals(
    compilationState,
    compilationOwner,
    compilationVisibleCells,
    [],
    compilationVisiblePeople,
    { pressureDiagnostics: refreshedDiagnostics },
  );
  const refreshedHunting = refreshedProposals.find((candidate) => candidate.need === 'hunting-safety');
  assert.ok(refreshedHunting, '新增 remembered 捕猎失败后仍应保留 hunting proposal');
  assert.ok(
    refreshedHunting.pressureBasis.sourceFactIds.includes(compilationFailureB.id),
    '同 elapsedMonth 原地修改 sourceEventIds 后，下一次 derive 必须重建并看到新证据',
  );
  assert.deepEqual(refreshedDiagnostics, cachedDiagnostics, '第二次 derive 应拥有全新的单次 compilation context');

  process.stdout.write('project pressure tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
