import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-mechanical-routing-range-'));
const bundlePath = path.join(temporaryDirectory, 'mechanical-routing-range.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { inventoryCombinationForOutput, inventoryCombinationTechniqueId } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/interaction-rules.ts'))};
    export { ensureMechanicalPowerNetwork, mechanicalPowerNetworkId, mechanicalPowerPlanKey, recordMechanicalPowerInstallation } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/mechanical-power.ts'))};
    export { recordProjectAction, recompileProjectNextAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
    export { cellId, cellsInRadius, setVoxel, standingPositions, voxelAt } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=mechanical-routing-range-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    cellId,
    cellsInRadius,
    createInitialState,
    ensureMechanicalPowerNetwork,
    executePrimitiveAction,
    instantiateProject,
    inventoryCombinationForOutput,
    inventoryCombinationTechniqueId,
    mechanicalPowerNetworkId,
    mechanicalPowerPlanKey,
    recordMechanicalPowerInstallation,
    recordProjectAction,
    recompileProjectNextAction,
    setVoxel,
    standingPositions,
    voxelAt,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(20_260_815, {
    endpoint: { kind: 'months', value: 48 },
    chaosIntensity: 0,
  });
  state.clock.elapsedMonths = 2;
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
  assert.ok(source, '夹具需要一段远离边界的 lane-0 水流');
  const wheel = { x: source.from.x, y: source.from.y, z: source.from.z + 1 };
  const shaft = { x: wheel.x - 1, y: wheel.y, z: wheel.z };
  const load = { x: wheel.x - 2, y: wheel.y, z: wheel.z };
  const wheelWork = { x: wheel.x + 2, y: wheel.y, z: wheel.z };
  const start = { x: wheel.x + 3, y: wheel.y, z: wheel.z };

  const clearColumn = (world, x, y) => {
    for (let z = 0; z < world.levels; z += 1) setVoxel(world, x, y, z, Material.Air);
  };
  const makeStanding = (world, position) => {
    clearColumn(world, position.x, position.y);
    setVoxel(world, position.x, position.y, position.z - 1, Material.Stone);
  };
  const restoreSourceWater = (world) => {
    for (const segment of state.world.mechanicalPower.sources) {
      for (const position of segment.requiredWaterVoxels) {
        setVoxel(world, position.x, position.y, position.z, Material.Water);
      }
    }
  };

  // Only one radius-two work position survives. Every radius-one column is
  // physically unstandable, while the bound water voxels remain real water.
  for (const candidateCellId of cellsInRadius(cellId(wheel.x, wheel.y), 2)) {
    clearColumn(state.world.grid, candidateCellId % state.world.grid.width,
      Math.floor(candidateCellId / state.world.grid.width));
  }
  restoreSourceWater(state.world.grid);
  makeStanding(state.world.grid, wheelWork);
  makeStanding(state.world.grid, start);
  setVoxel(state.world.grid, shaft.x, shaft.y, shaft.z - 1, Material.Stone);
  setVoxel(state.world.grid, shaft.x, shaft.y, shaft.z, Material.DriveShaft);
  setVoxel(state.world.grid, load.x, load.y, load.z - 1, Material.Stone);
  setVoxel(state.world.grid, load.x, load.y, load.z, Material.Mill);
  restoreSourceWater(state.world.grid);

  actor.position.cellId = cellId(start.x, start.y);
  actor.position.z = start.z;
  actor.position.previousCellId = actor.position.cellId;
  actor.position.previousZ = actor.position.z;

  const observation = executePrimitiveAction(state, actor, {
    kind: 'attend',
    target: { kind: 'voxel', position: { ...source.from } },
    waterCurrentSegmentId: source.id,
  }, 1, 1, { cause: 'intent', actionTick: 1 });
  assert.equal(observation.status, 'completed', observation.result);
  state.world.past.push(observation);

  const projectId = 'project-fixture-mechanical-routing-range';
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
    summary: '验证机械构件按各自真实交互距离寻找工位',
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

  let evidenceOrder = 1;
  const componentStacks = new Map();
  for (const materialId of [Material.Mill, Material.DriveShaft]) {
    const stackId = `fixture-stack-${materialId}`;
    const manufacture = {
      id: `fixture-manufacture-${materialId}`,
      kind: 'action',
      actionTick: ++evidenceOrder,
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
      result: '本项目负责人真实制成构件',
      diff: { outputMaterialId: materialId, outputStackId: stackId },
    };
    const verification = {
      ...manufacture,
      id: `fixture-verification-${materialId}`,
      actionTick: ++evidenceOrder,
      orderInMonth: evidenceOrder,
      action: { kind: 'attend', target: { kind: 'inventory-stack', personId: actor.id, stackId } },
      result: '本项目负责人已源绑定核验构件',
      diff: {
        verifiedSourceEventId: manufacture.id,
        verifiedStackId: stackId,
        verifiedMaterialId: materialId,
      },
    };
    state.world.past.push(manufacture, verification);
    project.actionEventIds.push(manufacture.id, verification.id);
    actor.inventory.push({
      id: stackId,
      materialId,
      quantity: 1,
      sourceEventIds: [manufacture.id],
    });
    componentStacks.set(materialId, stackId);
  }

  const wheelRule = inventoryCombinationForOutput(Material.WaterWheel);
  assert.ok(wheelRule, '夹具需要当前真实水轮结合规则');
  const wheelTargets = [];
  for (const input of wheelRule.inputs) {
    const stackId = `fixture-wheel-input-${input.materialId}`;
    actor.inventory.push({
      id: stackId,
      materialId: input.materialId,
      quantity: input.quantity,
      sourceEventIds: [`fixture-wheel-input-source-${input.materialId}`],
    });
    for (let count = 0; count < input.quantity; count += 1) {
      wheelTargets.push({ kind: 'inventory-stack', personId: actor.id, stackId });
    }
  }
  const wheelManufacture = executePrimitiveAction(state, actor, {
    kind: 'act', operation: 'combine', targets: wheelTargets,
  }, 1, ++evidenceOrder, {
    intentId: `fixture-intent:${project.id}`,
    cause: 'intent',
    projectId: project.id,
    actionTick: evidenceOrder,
  });
  assert.equal(wheelManufacture.status, 'completed', wheelManufacture.result);
  assert.equal(wheelManufacture.diff.outputMaterialId, Material.WaterWheel);
  state.world.past.push(wheelManufacture);
  recordProjectAction(state, project.id, wheelManufacture);
  const wheelStackId = wheelManufacture.diff.outputStackId;
  const wheelVerification = executePrimitiveAction(state, actor, {
    kind: 'attend',
    target: { kind: 'inventory-stack', personId: actor.id, stackId: wheelStackId },
    verification: {
      techniqueId: inventoryCombinationTechniqueId(wheelRule),
      sourceEventId: wheelManufacture.id,
      expectedMaterialId: Material.WaterWheel,
    },
  }, 1, ++evidenceOrder, {
    intentId: `fixture-intent:${project.id}`,
    cause: 'intent',
    projectId: project.id,
    actionTick: evidenceOrder,
  });
  assert.equal(wheelVerification.status, 'completed', wheelVerification.result);
  assert.equal(wheelVerification.diff.verifiedSourceEventId, wheelManufacture.id);
  state.world.past.push(wheelVerification);
  recordProjectAction(state, project.id, wheelVerification);
  componentStacks.set(Material.WaterWheel, wheelStackId);

  const network = ensureMechanicalPowerNetwork(state.world.mechanicalPower, plan);
  for (const [role, materialId, position] of [
    ['connector', Material.DriveShaft, shaft],
    ['load', Material.Mill, load],
  ]) {
    recordMechanicalPowerInstallation(network, {
      role,
      materialId,
      position: { ...position },
      projectId,
      installedAtMonth: 1,
      installationEventId: `fixture-installed-${role}`,
      sourceEventIds: [`fixture-manufacture-${materialId}`, `fixture-verification-${materialId}`],
    });
  }

  const radiusOneStanding = cellsInRadius(cellId(wheel.x, wheel.y), 1)
    .filter((candidateCellId) => candidateCellId !== cellId(wheel.x, wheel.y))
    .flatMap((candidateCellId) => standingPositions(state.world.grid, candidateCellId));
  assert.equal(radiusOneStanding.length, 0, '水轮目标半径一内必须没有可容纳身体的工位');

  const move = recompileProjectNextAction(state, actor, project.id);
  assert.deepEqual(move, { kind: 'move', toCellId: cellId(wheelWork.x, wheelWork.y), toZ: wheelWork.z },
    '水轮安装应按 converter 的二格交互范围选出唯一可达工位');
  const movement = executePrimitiveAction(state, actor, move, 2, 1, {
    intentId: `fixture-intent:${project.id}`,
    cause: 'intent',
    projectId: project.id,
    actionTick: 1,
  });
  assert.equal(movement.status, 'completed', movement.result);
  state.world.past.push(movement);
  recordProjectAction(state, project.id, movement);
  assert.equal(actor.position.cellId, cellId(wheelWork.x, wheelWork.y));
  assert.equal(actor.position.z, wheelWork.z);

  const install = recompileProjectNextAction(state, actor, project.id);
  assert.equal(install?.kind, 'act');
  assert.equal(install?.operation, 'exert');
  assert.equal(install?.mechanicalPowerBasis?.mode, 'install');
  assert.equal(install?.mechanicalPowerBasis?.componentRole, 'converter');
  const beforeInstall = structuredClone(state);

  const installed = executePrimitiveAction(state, actor, install, 2, 2, {
    intentId: `fixture-intent:${project.id}`,
    cause: 'intent',
    projectId: project.id,
    actionTick: 2,
  });
  assert.equal(installed.status, 'completed', installed.result);
  assert.equal(installed.diff.mechanicalPowerInstallation, true);
  assert.equal(installed.diff.componentRole, 'converter');
  assert.equal(voxelAt(state.world.grid, wheel.x, wheel.y, wheel.z), Material.WaterWheel);

  const converterTooFarState = structuredClone(beforeInstall);
  const converterTooFarActor = converterTooFarState.people.find((person) => person.id === actor.id);
  converterTooFarActor.position.cellId = cellId(start.x, start.y);
  converterTooFarActor.position.z = start.z;
  const converterTooFar = executePrimitiveAction(converterTooFarState, converterTooFarActor,
    structuredClone(install), 2, 3, { cause: 'intent', projectId: project.id, actionTick: 3 });
  assert.equal(converterTooFar.status, 'blocked', 'converter 在三格距离必须被领域执行器拒绝');
  assert.equal(converterTooFar.result, '机械构件、材料或冻结安装位置不在近身范围');

  const assertNearRangeOnly = (role, materialId, target) => {
    const roleState = structuredClone(beforeInstall);
    const roleActor = roleState.people.find((person) => person.id === actor.id);
    const roleNetwork = roleState.world.mechanicalPower.networks.find((candidate) => candidate.id === project.mechanicalPowerNetworkId);
    roleNetwork.components = roleNetwork.components.filter((component) => component.role !== role);
    setVoxel(roleState.world.grid, target.x, target.y, target.z, Material.Air);
    const workAtTwo = { x: target.x, y: target.y + 2, z: target.z };
    makeStanding(roleState.world.grid, workAtTwo);
    roleActor.position.cellId = cellId(workAtTwo.x, workAtTwo.y);
    roleActor.position.z = workAtTwo.z;
    const roleAction = structuredClone(install);
    roleAction.targets = [
      { kind: 'inventory-stack', personId: roleActor.id, stackId: componentStacks.get(materialId) },
      { kind: 'voxel', position: { ...target } },
    ];
    Object.assign(roleAction.mechanicalPowerBasis, {
      componentRole: role,
      componentMaterialId: materialId,
      componentPosition: { ...target },
    });
    const rejected = executePrimitiveAction(roleState, roleActor, roleAction, 2, 4, {
      cause: 'intent', projectId: project.id, actionTick: 4,
    });
    assert.equal(rejected.status, 'blocked', `${role} 在二格距离仍必须被拒绝`);
    assert.equal(rejected.result, '机械构件、材料或冻结安装位置不在近身范围');
  };
  assertNearRangeOnly('connector', Material.DriveShaft, shaft);
  assertNearRangeOnly('load', Material.Mill, load);

  process.stdout.write('mechanical power routing range fixture passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
