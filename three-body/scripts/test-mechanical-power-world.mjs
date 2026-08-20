import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-mechanical-power-world-'));
const bundlePath = path.join(temporaryDirectory, 'mechanical-power-world.mjs');

try {
  const entry = `
    export { createInitialState, restoreSimulationState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { inventoryCombinationFor, inventoryCombinationForOutput, inventoryCombinationRules } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/interaction-rules.ts'))};
    export {
      MECHANICAL_POWER_WORLD_VERSION,
      availableWaterCurrentCapacity,
      createMechanicalPowerNetwork,
      emptyMechanicalPowerWorldState,
      ensureMechanicalPowerNetwork,
      mechanicalPowerNetworkId,
      mechanicalPowerPlanKey,
      recordMechanicalPowerFault,
      recordMechanicalPowerInstallation,
      recordMechanicalPowerOperation,
      recordMechanicalPowerRepair,
      resolveWaterCurrentAvailability,
      validateMechanicalPowerTopology,
      waterCurrentAvailabilityFor,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/mechanical-power.ts'))};
    export {
      CURRENT_WORLD_GENERATOR_VERSION,
      generateVoxelWorld,
      mechanicalPowerWorldForSeed,
      riverCourse,
      waterCurrentSegmentsForSeed,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/generator.ts'))};
    export { WORLD_DEPTH, setVoxel, voxelAt } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=mechanical-power-world-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    CURRENT_WORLD_GENERATOR_VERSION,
    MECHANICAL_POWER_WORLD_VERSION,
    Material,
    WORLD_DEPTH,
    availableWaterCurrentCapacity,
    createInitialState,
    createMechanicalPowerNetwork,
    emptyMechanicalPowerWorldState,
    ensureMechanicalPowerNetwork,
    generateVoxelWorld,
    inventoryCombinationFor,
    inventoryCombinationForOutput,
    inventoryCombinationRules,
    mechanicalPowerNetworkId,
    mechanicalPowerPlanKey,
    mechanicalPowerWorldForSeed,
    recordMechanicalPowerFault,
    recordMechanicalPowerInstallation,
    recordMechanicalPowerOperation,
    recordMechanicalPowerRepair,
    resolveWaterCurrentAvailability,
    restoreSimulationState,
    riverCourse,
    setVoxel,
    validateMechanicalPowerTopology,
    voxelAt,
    waterCurrentAvailabilityFor,
    waterCurrentSegmentsForSeed,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const seed = 20_260_820;
  const first = generateVoxelWorld(seed);
  const second = generateVoxelWorld(seed);
  assert.equal(first.world.generator.version, CURRENT_WORLD_GENERATOR_VERSION);
  assert.equal(first.mechanicalPower.version, MECHANICAL_POWER_WORLD_VERSION);
  assert.deepEqual(riverCourse(seed), riverCourse(seed), '河道纯函数必须确定');
  assert.deepEqual(first.mechanicalPower, second.mechanicalPower, '同种子水流源必须确定');
  assert.deepEqual(first.mechanicalPower.sources, waterCurrentSegmentsForSeed(seed));
  assert.deepEqual(first.mechanicalPower, mechanicalPowerWorldForSeed(seed));
  assert.equal(first.mechanicalPower.sources.length, (WORLD_DEPTH - 1) * 2, '两条河道 lane 都应逐行生成有向 edge');
  assert.deepEqual(first.mechanicalPower.networks, [], '新世界不得预设任何已完成机械网络');
  assert.ok(first.mechanicalPower.sources.every((source) => !Object.hasOwn(source, 'active')), '可用性不得持久化为 active');
  for (const source of first.mechanicalPower.sources) {
    assert.equal(source.direction.dy, 1);
    assert.equal(source.direction.dz, 0);
    assert.ok(Math.abs(source.direction.dx) <= 1);
    assert.equal(voxelAt(first.world, source.from.x, source.from.y, source.from.z), Material.Water);
    assert.equal(voxelAt(first.world, source.to.x, source.to.y, source.to.z), Material.Water);
    assert.ok(source.sourceKeys.length >= 4);
  }
  assert.equal(availableWaterCurrentCapacity(first.world, first.mechanicalPower), first.mechanicalPower.sources.length);

  // Merely placing ordinary Water never creates a directed source.
  {
    const ordinaryWorld = structuredClone(first.world);
    setVoxel(ordinaryWorld, 70, 45, 5, Material.Water);
    setVoxel(ordinaryWorld, 70, 46, 5, Material.Water);
    const noSources = emptyMechanicalPowerWorldState();
    assert.deepEqual(resolveWaterCurrentAvailability(ordinaryWorld, noSources), []);
    assert.equal(waterCurrentAvailabilityFor(ordinaryWorld, noSources, 'guessed-from-water').available, false);
    assert.equal(waterCurrentAvailabilityFor(ordinaryWorld, noSources, 'guessed-from-water').reason, 'missing-source');
  }

  // Exact endpoint material is revalidated: freeze blocks, thaw restores.
  {
    const world = structuredClone(first.world);
    const power = structuredClone(first.mechanicalPower);
    const target = power.sources.find((source) => source.id.endsWith(':10:0'));
    assert.ok(target);
    assert.equal(waterCurrentAvailabilityFor(world, power, target.id).available, true);
    setVoxel(world, target.to.x, target.to.y, target.to.z, Material.Ice);
    assert.equal(waterCurrentAvailabilityFor(world, power, target.id).available, false);
    assert.equal(waterCurrentAvailabilityFor(world, power, target.id).reason, 'blocked-water');
    setVoxel(world, target.to.x, target.to.y, target.to.z, Material.Water);
    assert.equal(waterCurrentAvailabilityFor(world, power, target.id).available, true, '融冰恢复 Water 后 edge 应恢复');
  }

  // A downstream Water patch cannot bypass a broken directed upstream chain;
  // the untouched second lane retains its own capacity.
  {
    const world = structuredClone(first.world);
    const power = structuredClone(first.mechanicalPower);
    const upstream = power.sources.find((source) => source.id.endsWith(':8:0'));
    const downstreamLane0 = power.sources.find((source) => source.id.endsWith(':20:0'));
    const downstreamLane1 = power.sources.find((source) => source.id.endsWith(':20:1'));
    assert.ok(upstream && downstreamLane0 && downstreamLane1);
    setVoxel(world, upstream.from.x, upstream.from.y, upstream.from.z, Material.Sand);
    assert.equal(voxelAt(world, downstreamLane0.from.x, downstreamLane0.from.y, downstreamLane0.from.z), Material.Water,
      '下游局部端点仍是 Water，不能据此跳过上游断流');
    assert.equal(waterCurrentAvailabilityFor(world, power, downstreamLane0.id).available, false);
    assert.equal(waterCurrentAvailabilityFor(world, power, downstreamLane0.id).reason, 'upstream-unavailable');
    assert.equal(waterCurrentAvailabilityFor(world, power, downstreamLane1.id).available, true,
      '另一条 lane 未被阻断时应独立保留容量');
    setVoxel(world, upstream.from.x, upstream.from.y, upstream.from.z, Material.Water);
    assert.equal(waterCurrentAvailabilityFor(world, power, downstreamLane0.id).available, true);
  }

  // The installed converter/connector/load must form one exact straight axis.
  {
    const world = structuredClone(first.world);
    const power = structuredClone(first.mechanicalPower);
    const source = power.sources.find((candidate) => candidate.id.endsWith(':12:0'));
    assert.ok(source);
    const side = source.from.x >= 3 ? -1 : 1;
    const plan = {
      version: 'mechanical-power-plan-v1',
      projectId: 'project-water-mill-1',
      sourceSegmentId: source.id,
      wheelPosition: { x: source.from.x + side, y: source.from.y, z: source.from.z },
      shaftPositions: [{ x: source.from.x + side * 2, y: source.from.y, z: source.from.z }],
      loadPosition: { x: source.from.x + side * 3, y: source.from.y, z: source.from.z },
      sourceKeys: [...source.sourceKeys],
    };
    setVoxel(world, plan.wheelPosition.x, plan.wheelPosition.y, plan.wheelPosition.z, Material.WaterWheel);
    setVoxel(world, plan.shaftPositions[0].x, plan.shaftPositions[0].y, plan.shaftPositions[0].z, Material.DriveShaft);
    setVoxel(world, plan.loadPosition.x, plan.loadPosition.y, plan.loadPosition.z, Material.Mill);
    assert.deepEqual(validateMechanicalPowerTopology(world, power, plan), { valid: true });

    const bent = structuredClone(plan);
    bent.loadPosition = { x: bent.shaftPositions[0].x, y: bent.shaftPositions[0].y + 1, z: bent.shaftPositions[0].z };
    setVoxel(world, bent.loadPosition.x, bent.loadPosition.y, bent.loadPosition.z, Material.Mill);
    assert.equal(validateMechanicalPowerTopology(world, power, bent).reason, 'bent-axis');

    const detached = structuredClone(plan);
    detached.wheelPosition.x += side * 4;
    assert.equal(validateMechanicalPowerTopology(world, power, detached).reason, 'wheel-not-adjacent-to-source');

    const noCurrent = { ...plan, sourceSegmentId: 'ordinary-water-is-not-current' };
    assert.equal(validateMechanicalPowerTopology(world, power, noCurrent).reason, 'source-unavailable');

    assert.equal(mechanicalPowerPlanKey(plan), mechanicalPowerPlanKey(structuredClone(plan)));
    assert.equal(mechanicalPowerNetworkId(plan), mechanicalPowerNetworkId(structuredClone(plan)));
    const sameGeometryOtherProject = { ...plan, projectId: 'project-water-mill-2' };
    assert.equal(mechanicalPowerPlanKey(plan), mechanicalPowerPlanKey(sameGeometryOtherProject), 'plan key 应描述源与几何，不混入项目身份');
    assert.notEqual(mechanicalPowerNetworkId(plan), mechanicalPowerNetworkId(sameGeometryOtherProject), '网络身份必须绑定安装项目');
    assert.deepEqual(createMechanicalPowerNetwork(plan), {
      id: mechanicalPowerNetworkId(plan),
      planKey: mechanicalPowerPlanKey(plan),
      installationProjectId: plan.projectId,
      sourceSegmentId: plan.sourceSegmentId,
      components: [],
      installationEventIds: [],
      operationEventIds: [],
      faultEventIds: [],
      repairEventIds: [],
      sourceEventIds: [],
      condition: 100,
      fault: null,
    });

    const mutablePower = emptyMechanicalPowerWorldState([source]);
    const network = ensureMechanicalPowerNetwork(mutablePower, plan);
    assert.equal(ensureMechanicalPowerNetwork(mutablePower, structuredClone(plan)), network, '同一安装计划必须复用网络');
    assert.equal(mutablePower.networks.length, 1);
    const wheelInstallation = {
      role: 'converter', materialId: Material.WaterWheel, position: plan.wheelPosition,
      projectId: plan.projectId, installedAtMonth: 12,
      installationEventId: 'install-wheel-1', sourceEventIds: ['crafted-wheel-1'],
    };
    recordMechanicalPowerInstallation(network, wheelInstallation);
    recordMechanicalPowerInstallation(network, { ...wheelInstallation, sourceEventIds: ['crafted-wheel-1', 'inspection-wheel-1'] });
    assert.equal(network.components.length, 1, '同 role+position 的安装提交必须幂等');
    assert.deepEqual(network.installationEventIds, ['install-wheel-1']);
    assert.ok(network.components[0].sourceEventIds.includes('inspection-wheel-1'));

    const fault = {
      kind: 'commissioning-misalignment', componentRole: 'connector',
      componentPosition: plan.shaftPositions[0], atMonth: 13,
      faultEventId: 'fault-shaft-1', sourceEventIds: ['install-wheel-1'],
    };
    recordMechanicalPowerFault(network, fault);
    recordMechanicalPowerFault(network, fault);
    assert.equal(network.condition, 40);
    assert.equal(network.fault.faultEventId, fault.faultEventId);
    assert.deepEqual(network.faultEventIds, ['fault-shaft-1']);
    recordMechanicalPowerRepair(network, 'repair-shaft-1', ['replacement-shaft-1']);
    recordMechanicalPowerRepair(network, 'repair-shaft-1', ['replacement-shaft-1']);
    assert.equal(network.condition, 100);
    assert.equal(network.fault, null);
    assert.deepEqual(network.repairEventIds, ['repair-shaft-1']);
    recordMechanicalPowerOperation(network, 'operate-mill-1');
    recordMechanicalPowerOperation(network, 'operate-mill-1');
    assert.deepEqual(network.operationEventIds, ['operate-mill-1']);
    assert.ok(network.sourceEventIds.includes('replacement-shaft-1'), '维修来源必须保留在网络 provenance 中');
  }

  // schemaVersion remains 17. A legacy v17 current-generator save is rebuilt
  // from the same seed; a save from an older generator gets no invented flow.
  {
    const current = createInitialState(seed, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
    assert.equal(current.schemaVersion, 17);
    assert.equal(current.world.mechanicalPower.version, MECHANICAL_POWER_WORLD_VERSION);
    assert.equal(current.world.mechanicalPower.sources.length, (WORLD_DEPTH - 1) * 2);

    const legacyCurrent = structuredClone(current);
    delete legacyCurrent.world.mechanicalPower;
    const restoredCurrent = restoreSimulationState(legacyCurrent);
    assert.deepEqual(restoredCurrent.world.mechanicalPower, mechanicalPowerWorldForSeed(seed));

    const legacyOld = structuredClone(current);
    delete legacyOld.world.mechanicalPower;
    legacyOld.world.grid.generator.version = 'material-world-v3-biomes';
    const restoredOld = restoreSimulationState(legacyOld);
    assert.equal(restoredOld.world.mechanicalPower.version, MECHANICAL_POWER_WORLD_VERSION);
    assert.deepEqual(restoredOld.world.mechanicalPower.sources, []);
    assert.deepEqual(restoredOld.world.mechanicalPower.networks, []);

    const inconsistentOld = structuredClone(current);
    inconsistentOld.world.grid.generator.version = 'material-world-v2-flat';
    const restoredInconsistentOld = restoreSimulationState(inconsistentOld);
    assert.deepEqual(restoredInconsistentOld.world.mechanicalPower, current.world.mechanicalPower,
      '显式持久化的合法 v1 机械世界不能因 generator metadata 不同而被 restore 抹掉');
  }

  // IDs append after the existing 0..63 range, BOM multisets are globally unique,
  // and damaged shafts cannot be crafted as an ordinary inventory outcome.
  {
    assert.equal(Material.KeepCore, 63);
    assert.equal(Material.WaterWheel, 64);
    assert.equal(Material.DriveShaft, 65);
    assert.equal(Material.BrokenDriveShaft, 66);
    const multisetKey = (inputs) => inputs
      .map(({ materialId, quantity }) => `${materialId}:${quantity}`)
      .sort()
      .join('|');
    const rules = inventoryCombinationRules();
    const wheelKey = multisetKey([{ materialId: Material.Plank, quantity: 1 }, { materialId: Material.Fiber, quantity: 1 }]);
    const shaftKey = multisetKey([{ materialId: Material.Bronze, quantity: 1 }, { materialId: Material.Plank, quantity: 1 }]);
    assert.equal(rules.filter((rule) => multisetKey(rule.inputs) === wheelKey).length, 1);
    assert.equal(rules.filter((rule) => multisetKey(rule.inputs) === shaftKey).length, 1);
    assert.equal(inventoryCombinationFor([Material.Fiber, Material.Plank]).id, 'assemble-water-wheel');
    assert.equal(inventoryCombinationFor([Material.Plank, Material.Bronze]).id, 'cast-drive-shaft');
    assert.equal(inventoryCombinationForOutput(Material.WaterWheel).output.materialId, Material.WaterWheel);
    assert.equal(inventoryCombinationForOutput(Material.DriveShaft).output.materialId, Material.DriveShaft);
    assert.equal(inventoryCombinationForOutput(Material.BrokenDriveShaft), undefined);
  }

  console.log('机械水动力世界基础专项测试通过');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
