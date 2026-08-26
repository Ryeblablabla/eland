import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-mechanical-flow-recovery-'));
const bundlePath = path.join(temporaryDirectory, 'mechanical-flow-recovery.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { mechanicalPowerNetworkId, mechanicalPowerPlanKey, waterCurrentAvailabilityFor } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/mechanical-power.ts'))};
    export { recordProjectAction, recompileProjectNextAction, synchronizeProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
    export { cellId, setVoxel, voxelAt } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=mechanical-flow-recovery-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    cellId,
    createInitialState,
    executePrimitiveAction,
    instantiateProject,
    mechanicalPowerNetworkId,
    mechanicalPowerPlanKey,
    recordProjectAction,
    recompileProjectNextAction,
    setVoxel,
    synchronizeProject,
    voxelAt,
    waterCurrentAvailabilityFor,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(20_260_815, {
    endpoint: { kind: 'months', value: 48 },
    chaosIntensity: 0,
  });
  state.clock.elapsedMonths = 1;
  state.world.past = [];
  state.lastStep = [];
  state.projects = [];
  const actor = state.people[0];
  for (const other of state.people.slice(1)) other.diedAtMonth = 0;
  actor.bornAtMonth = -20 * 12;
  actor.conditions = [];
  actor.body = { health: 100, hydration: 100, nutrition: 100 };
  actor.inventory = [];
  actor.knowledge = [];
  actor.memories = [];
  actor.knownPlaces = [];

  const source = state.world.mechanicalPower.sources.find((candidate) => (
    candidate.from.y === 12 && candidate.id.endsWith(':0')
  ));
  assert.ok(source, 'fixture requires the same naturally generated lane-0 current used by the mechanical chain');
  const wheel = { x: source.from.x, y: source.from.y, z: source.from.z + 1 };
  const shaft = { x: wheel.x - 1, y: wheel.y, z: wheel.z };
  const load = { x: wheel.x - 2, y: wheel.y, z: wheel.z };
  for (const position of [shaft, load]) {
    setVoxel(state.world.grid, position.x, position.y, position.z - 1, Material.Stone);
    setVoxel(state.world.grid, position.x, position.y, position.z, Material.Air);
    setVoxel(state.world.grid, position.x, position.y, position.z + 1, Material.Air);
  }
  actor.position.cellId = cellId(shaft.x, shaft.y);
  actor.position.z = shaft.z;
  actor.position.previousCellId = actor.position.cellId;
  actor.position.previousZ = actor.position.z;

  const observation = executePrimitiveAction(state, actor, {
    kind: 'attend',
    target: { kind: 'voxel', position: { ...source.from } },
    waterCurrentSegmentId: source.id,
  }, 1, 1, { cause: 'intent', actionTick: 1 });
  assert.equal(observation.status, 'completed', observation.result);
  state.world.past.push(observation);

  const wheelWorkPosition = [
    { x: wheel.x, y: wheel.y - 1, z: wheel.z },
    { x: wheel.x + 1, y: wheel.y, z: wheel.z },
    { x: wheel.x, y: wheel.y + 1, z: wheel.z },
    { x: wheel.x - 1, y: wheel.y, z: wheel.z },
  ].find((position) => position.x !== shaft.x || position.y !== shaft.y);
  assert.ok(wheelWorkPosition, 'fixture requires one adjacent work platform');
  const wheelWorkSupportMaterial = voxelAt(
    state.world.grid,
    wheelWorkPosition.x,
    wheelWorkPosition.y,
    wheelWorkPosition.z - 1,
  );
  setVoxel(
    state.world.grid,
    wheelWorkPosition.x,
    wheelWorkPosition.y,
    wheelWorkPosition.z - 1,
    Material.Stone,
  );
  setVoxel(state.world.grid, wheelWorkPosition.x, wheelWorkPosition.y, wheelWorkPosition.z, Material.Air);
  setVoxel(state.world.grid, wheelWorkPosition.x, wheelWorkPosition.y, wheelWorkPosition.z + 1, Material.Air);
  const loadWorkPosition = { x: load.x - 1, y: load.y, z: load.z };
  const loadWorkSupportMaterial = voxelAt(
    state.world.grid,
    loadWorkPosition.x,
    loadWorkPosition.y,
    loadWorkPosition.z - 1,
  );
  setVoxel(
    state.world.grid,
    loadWorkPosition.x,
    loadWorkPosition.y,
    loadWorkPosition.z - 1,
    Material.Stone,
  );
  setVoxel(state.world.grid, loadWorkPosition.x, loadWorkPosition.y, loadWorkPosition.z, Material.Air);
  setVoxel(state.world.grid, loadWorkPosition.x, loadWorkPosition.y, loadWorkPosition.z + 1, Material.Air);

  const projectId = 'project-test-transient-current';
  const plan = {
    version: 'mechanical-power-plan-v1',
    projectId,
    sourceSegmentId: source.id,
    wheelPosition: wheel,
    shaftPositions: [shaft],
    loadPosition: load,
    sourceKeys: [...source.sourceKeys],
  };
  const project = instantiateProject({
    id: projectId,
    kind: 'production',
    need: 'mechanical-power-capability',
    desiredFunction: 'water-powered-crop-processing',
    summary: '测试短期失流下的冻结机械计划',
    ownerId: actor.id,
    beneficiaryIds: [actor.id],
    triggerFactIds: [observation.id],
    pressure: 60,
    createdAtMonth: 1,
    reviewAtMonth: 40,
    site: { cellId: cellId(load.x, load.y), z: load.z },
    mechanicalPowerPlan: structuredClone(plan),
    mechanicalPowerPlanKey: mechanicalPowerPlanKey(plan),
    mechanicalPowerNetworkId: mechanicalPowerNetworkId(plan),
  });
  state.projects.push(project);

  const componentStacks = [
    { materialId: Material.Mill, stackId: 'fixture-mill' },
    { materialId: Material.DriveShaft, stackId: 'fixture-shaft' },
    { materialId: Material.WaterWheel, stackId: 'fixture-wheel' },
  ];
  let evidenceOrder = 1;
  for (const { materialId, stackId } of componentStacks) {
    const manufactureId = `fixture-manufacture-${materialId}`;
    const verificationId = `fixture-verification-${materialId}`;
    const manufacture = {
      id: manufactureId,
      kind: 'action',
      actionTick: evidenceOrder,
      atMonth: 1,
      orderInMonth: evidenceOrder,
      cellId: actor.position.cellId,
      who: actor.id,
      cause: 'intent',
      action: { kind: 'act', operation: 'combine', targets: [] },
      fromCellId: actor.position.cellId,
      toCellId: actor.position.cellId,
      fromZ: actor.position.z,
      toZ: actor.position.z,
      pathSegment: [actor.position.cellId],
      status: 'completed',
      result: '夹具中本人已制成构件',
      diff: { outputMaterialId: materialId, outputStackId: stackId },
    };
    evidenceOrder += 1;
    const verification = {
      ...manufacture,
      id: verificationId,
      actionTick: evidenceOrder,
      orderInMonth: evidenceOrder,
      action: {
        kind: 'attend',
        target: { kind: 'inventory-stack', personId: actor.id, stackId },
      },
      result: '夹具中本人已绑定核验该构件',
      diff: {
        verifiedSourceEventId: manufactureId,
        verifiedStackId: stackId,
        verifiedMaterialId: materialId,
      },
    };
    evidenceOrder += 1;
    state.world.past.push(manufacture, verification);
    project.actionEventIds.push(manufacture.id, verification.id);
    actor.inventory.push({
      id: stackId,
      materialId,
      quantity: 1,
      sourceEventIds: [manufactureId],
    });
  }
  actor.inventory.push(
    { id: 'fixture-seed', materialId: Material.Seed, quantity: 1, sourceEventIds: ['fixture-seed-source'] },
    { id: 'fixture-tool', materialId: Material.BronzeTool, quantity: 1, sourceEventIds: ['fixture-tool-source'] },
  );

  let actionOrder = 10;
  const commit = (action, atMonth = 2) => {
    actionOrder += 1;
    const fact = executePrimitiveAction(state, actor, action, atMonth, actionOrder, {
      intentId: `fixture-intent:${project.id}`,
      cause: 'intent',
      projectId: project.id,
      actionTick: actionOrder,
    });
    state.world.past.push(fact);
    recordProjectAction(state, project.id, fact);
    return fact;
  };

  const installNextComponent = (temporaryMaterial, expectedRole) => {
    setVoxel(state.world.grid, source.from.x, source.from.y, source.from.z, temporaryMaterial);
    assert.equal(
      waterCurrentAvailabilityFor(state.world.grid, state.world.mechanicalPower, source.id).available,
      false,
    );
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const action = recompileProjectNextAction(state, actor, project.id);
      assert.ok(action, `${expectedRole} must remain compilable while current water is temporarily absent: ${JSON.stringify({
        status: project.status,
        blockedReason: project.blockedReason,
        inventory: actor.inventory.map((stack) => [stack.id, stack.materialId, stack.quantity]),
        components: state.world.mechanicalPower.networks.find((network) => (
          network.id === project.mechanicalPowerNetworkId
        ))?.components.map((component) => component.role),
        position: actor.position,
      })}`);
      const fact = commit(action);
      assert.notEqual(fact.status, 'blocked', fact.result);
      if (fact.diff.mechanicalPowerInstallation === true) {
        assert.equal(fact.diff.componentRole, expectedRole);
        return fact;
      }
    }
    assert.fail(`${expectedRole} installation did not complete within the bounded fixture path`);
  };

  const loadInstall = installNextComponent(Material.Sand, 'load');
  assert.equal(loadInstall.status, 'completed', 'a dry source must not invalidate exact load installation');
  setVoxel(state.world.grid, source.from.x, source.from.y, source.from.z, Material.Water);
  const shaftInstall = installNextComponent(Material.Ice, 'connector');
  assert.equal(shaftInstall.status, 'completed', 'a frozen source must not invalidate exact shaft installation');
  const wheelInstall = installNextComponent(Material.Ice, 'converter');
  assert.equal(wheelInstall.status, 'completed', 'a frozen source must not invalidate exact wheel installation');

  actor.position.cellId = cellId(loadWorkPosition.x, loadWorkPosition.y);
  actor.position.z = loadWorkPosition.z;
  actor.position.previousCellId = actor.position.cellId;
  actor.position.previousZ = actor.position.z;
  const frozenOperateAction = recompileProjectNextAction(state, actor, project.id);
  assert.equal(frozenOperateAction?.kind, 'act', JSON.stringify({
    status: project.status,
    blockedReason: project.blockedReason,
    position: actor.position,
    load,
    current: waterCurrentAvailabilityFor(state.world.grid, state.world.mechanicalPower, source.id),
  }));
  assert.equal(frozenOperateAction?.mechanicalPowerBasis?.mode, 'operate');
  const seedBefore = actor.inventory.find((stack) => stack.id === 'fixture-seed').quantity;
  const frozenAttempt = commit(frozenOperateAction);
  assert.equal(frozenAttempt.status, 'blocked');
  assert.equal(frozenAttempt.diff.mechanicalPowerCurrentUnavailable, true);
  assert.equal(frozenAttempt.diff.currentAvailabilityReason, 'blocked-water');
  assert.equal(actor.inventory.find((stack) => stack.id === 'fixture-seed').quantity, seedBefore,
    'strict operate must reject before consuming its real input');

  project.reviewAtMonth = project.createdAtMonth + 1;
  state.clock.elapsedMonths = 20;
  synchronizeProject(state, project, 20);
  assert.equal(project.status, 'active',
    'an exact blocked operate fact must keep this mechanical project alive across temporary current loss');
  assert.equal(recompileProjectNextAction(state, actor, project.id), null,
    'the compiler must wait instead of emitting the same doomed operate action every planning tick');
  assert.equal(project.status, 'active');

  setVoxel(state.world.grid, source.from.x, source.from.y, source.from.z, Material.Water);
  setVoxel(
    state.world.grid,
    wheelWorkPosition.x,
    wheelWorkPosition.y,
    wheelWorkPosition.z - 1,
    wheelWorkSupportMaterial,
  );
  setVoxel(
    state.world.grid,
    loadWorkPosition.x,
    loadWorkPosition.y,
    loadWorkPosition.z - 1,
    loadWorkSupportMaterial,
  );
  actor.position.cellId = cellId(loadWorkPosition.x, loadWorkPosition.y);
  actor.position.z = loadWorkPosition.z;
  actor.position.previousCellId = actor.position.cellId;
  actor.position.previousZ = actor.position.z;
  assert.equal(
    waterCurrentAvailabilityFor(state.world.grid, state.world.mechanicalPower, source.id).available,
    true,
  );
  const recoveredAction = recompileProjectNextAction(state, actor, project.id);
  assert.equal(project.status, 'active', 'recovery synchronization must not close the project before recompilation');
  assert.equal(recoveredAction?.kind, 'act');
  assert.equal(recoveredAction?.mechanicalPowerBasis?.mode, 'operate');
  const recoveredAttempt = executePrimitiveAction(state, actor, recoveredAction, 21, 1, {
    intentId: `fixture-intent:${project.id}`,
    cause: 'intent',
    projectId: project.id,
    actionTick: 1,
  });
  assert.equal(recoveredAttempt.status, 'progressed',
    'restored live flow must reach strict commissioning instead of the current-unavailable gate');
  assert.equal(recoveredAttempt.diff.mechanicalPowerFault, true,
    'the existing deterministic commissioning check remains authoritative after thaw');
  assert.equal(recoveredAttempt.diff.mechanicalPowerCurrentUnavailable, undefined);

  console.log(JSON.stringify({
    ok: true,
    installedWithoutLiveFlow: [
      loadInstall.diff.componentRole,
      shaftInstall.diff.componentRole,
      wheelInstall.diff.componentRole,
    ],
    frozenOperateStatus: frozenAttempt.status,
    waitStatus: project.status,
    thawedCommissioningStatus: recoveredAttempt.status,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
