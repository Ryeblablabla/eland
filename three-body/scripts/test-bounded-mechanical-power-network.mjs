import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-bounded-mechanical-network-'));
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');

function actionFact(id, who, action, diff) {
  return {
    id,
    kind: 'action',
    atMonth: 20,
    orderInMonth: 1,
    planningTick: 1,
    orderInTick: 1,
    actionTick: 1,
    who,
    cause: 'intent',
    action,
    fromCellId: 0,
    toCellId: 0,
    fromZ: 1,
    toZ: 1,
    pathSegment: [],
    status: 'completed',
    result: id,
    diff,
  };
}

try {
  const entry = [
    `export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};`,
    `export { generateVoxelWorld } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/generator.ts'))};`,
    `export { setVoxel } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};`,
    `export { resolveMechanicalElectricalSourceContext } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/actions/electrical-power-actions.ts'))};`,
    `export {`,
    `  MECHANICAL_POWER_RECENT_EVENT_LIMIT, MECHANICAL_POWER_SOURCE_EVENT_LIMIT,`,
    `  createMechanicalPowerNetwork, mechanicalPowerPlanKey, migrateMechanicalPowerWorldState,`,
    `  recordMechanicalPowerFault, recordMechanicalPowerInstallation,`,
    `  recordMechanicalPowerOperation, recordMechanicalPowerRepair`,
    `} from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/mechanical-power.ts'))};`,
  ].join('\n');
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=bounded-mechanical-network-entry.ts', `--outfile=${bundlePath}`,
  ], {
    input: entry,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=256' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const subject = await import(`${pathToFileURL(bundlePath).href}?fixture=${Date.now()}`);
  const {
    Material,
    MECHANICAL_POWER_RECENT_EVENT_LIMIT,
    MECHANICAL_POWER_SOURCE_EVENT_LIMIT,
    createMechanicalPowerNetwork,
    generateVoxelWorld,
    mechanicalPowerPlanKey,
    migrateMechanicalPowerWorldState,
    recordMechanicalPowerFault,
    recordMechanicalPowerInstallation,
    recordMechanicalPowerOperation,
    recordMechanicalPowerRepair,
    resolveMechanicalElectricalSourceContext,
    setVoxel,
  } = subject;

  const generated = generateVoxelWorld(20_260_826);
  const source = generated.mechanicalPower.sources.find((candidate) => (
    candidate.from.x >= 4
      && candidate.from.x < generated.world.width - 4
      && candidate.from.z + 3 < generated.world.levels
  ));
  assert.ok(source, 'fixture 需要一个四周有空间的真实有向水流源');
  const side = source.from.x >= generated.world.width / 2 ? -1 : 1;
  const installationProjectId = 'mechanical-installation';
  const plan = {
    version: 'mechanical-power-plan-v1',
    projectId: installationProjectId,
    sourceSegmentId: source.id,
    wheelPosition: { x: source.from.x + side, y: source.from.y, z: source.from.z },
    shaftPositions: [{ x: source.from.x + side * 2, y: source.from.y, z: source.from.z }],
    loadPosition: { x: source.from.x + side * 3, y: source.from.y, z: source.from.z },
    sourceKeys: [...source.sourceKeys],
  };
  const network = createMechanicalPowerNetwork(plan);
  const installations = [
    ['converter', Material.WaterWheel, plan.wheelPosition, 'install-wheel'],
    ['connector', Material.DriveShaft, plan.shaftPositions[0], 'install-shaft'],
    ['load', Material.Mill, plan.loadPosition, 'install-load'],
  ];
  for (const [role, materialId, position, installationEventId] of installations) {
    setVoxel(generated.world, position.x, position.y, position.z, materialId);
    recordMechanicalPowerInstallation(network, {
      role,
      materialId,
      position: { ...position },
      projectId: installationProjectId,
      installedAtMonth: 1,
      installationEventId,
      sourceEventIds: [`make-${installationEventId}`, `verify-${installationEventId}`],
    });
  }

  // Simulate a v17 shell written before bounded tails and scalar totals.
  const serviceEventId = 'legacy-operation-0';
  const legacyOperationEventIds = Array.from({ length: 30 }, (_, index) => `legacy-operation-${index}`);
  const legacyFaultEventIds = Array.from({ length: 3 }, (_, index) => `legacy-fault-${index}`);
  const legacyRepairEventIds = Array.from({ length: 3 }, (_, index) => `legacy-repair-${index}`);
  Object.assign(network, {
    operationEventIds: legacyOperationEventIds,
    faultEventIds: legacyFaultEventIds,
    repairEventIds: legacyRepairEventIds,
    sourceEventIds: Array.from({ length: 80 }, (_, index) => `legacy-source-${index}`),
    condition: 80,
    serviceLoadedOperationCount: 1,
  });
  delete network.recentOperationEventIds;
  delete network.recentFaultEventIds;
  delete network.recentRepairEventIds;
  delete network.operationCount;
  delete network.faultCount;
  delete network.repairCount;
  delete network.serviceCycleOperationEventIds;

  const world = {
    version: 'mechanical-power-world-v1',
    sources: generated.mechanicalPower.sources,
    networks: [network],
  };
  migrateMechanicalPowerWorldState(world);
  assert.equal(network.operationCount, legacyOperationEventIds.length);
  assert.equal(network.faultCount, legacyFaultEventIds.length);
  assert.equal(network.repairCount, legacyRepairEventIds.length);
  assert.deepEqual(network.recentOperationEventIds, legacyOperationEventIds.slice(-MECHANICAL_POWER_RECENT_EVENT_LIMIT));
  assert.deepEqual(network.recentFaultEventIds, legacyFaultEventIds);
  assert.deepEqual(network.recentRepairEventIds, legacyRepairEventIds);
  assert.equal(network.sourceEventIds.length, MECHANICAL_POWER_SOURCE_EVENT_LIMIT);
  assert.equal(Object.hasOwn(network, 'operationEventIds'), false, '迁移后不得保留旧 operation membership');
  assert.equal(Object.hasOwn(network, 'faultEventIds'), false, '迁移后不得保留旧 fault membership');
  assert.equal(Object.hasOwn(network, 'repairEventIds'), false, '迁移后不得保留旧 repair membership');

  // The next physical result is identical to the old condition/cycle semantics.
  const conditionBeforeMigration = 80;
  const serviceOrdinalBeforeMigration = 1;
  const next = recordMechanicalPowerOperation(network, 'post-migration-operation', Material.DriveShaft);
  assert.equal(next.wearApplied, 20);
  assert.equal(next.serviceLoadedOperationOrdinal, serviceOrdinalBeforeMigration + 1);
  assert.equal(network.condition, conditionBeforeMigration - next.wearApplied);
  assert.equal(network.operationCount, legacyOperationEventIds.length + 1);

  for (let index = 0; index < 40; index += 1) {
    recordMechanicalPowerOperation(network, `bounded-operation-${index}`, Material.DriveShaft);
  }
  for (let index = 0; index < 20; index += 1) {
    const faultEventId = `bounded-fault-${index}`;
    recordMechanicalPowerFault(network, {
      kind: 'commissioning-misalignment',
      componentRole: 'connector',
      componentPosition: { ...plan.shaftPositions[0] },
      atMonth: 30 + index,
      faultEventId,
      sourceEventIds: [`fault-source-${index}`],
    });
    recordMechanicalPowerRepair(network, `bounded-repair-${index}`, [faultEventId, `repair-source-${index}`]);
  }
  assert.equal(network.operationCount, legacyOperationEventIds.length + 41);
  assert.equal(network.faultCount, legacyFaultEventIds.length + 20);
  assert.equal(network.repairCount, legacyRepairEventIds.length + 20);
  assert.equal(network.recentOperationEventIds.length, MECHANICAL_POWER_RECENT_EVENT_LIMIT);
  assert.equal(network.recentFaultEventIds.length, MECHANICAL_POWER_RECENT_EVENT_LIMIT);
  assert.equal(network.recentRepairEventIds.length, MECHANICAL_POWER_RECENT_EVENT_LIMIT);
  assert.ok(network.sourceEventIds.length <= MECHANICAL_POWER_SOURCE_EVENT_LIMIT);
  assert.equal(network.recentOperationEventIds.includes(serviceEventId), false,
    '旧 service witness 可从 recent tail 淘汰，不能再依赖 membership');

  const operatorId = 'operator';
  const planKey = mechanicalPowerPlanKey(plan);
  const serviceAction = {
    kind: 'act',
    operation: 'exert',
    targets: [
      { kind: 'inventory-stack', personId: operatorId, stackId: 'seed-input' },
      { kind: 'voxel', position: { ...plan.loadPosition } },
    ],
    mechanicalPowerBasis: {
      version: 'mechanical-power-action-basis-v1',
      mode: 'operate',
      sourceSegmentId: source.id,
      sourceKeys: [...source.sourceKeys],
      projectId: installationProjectId,
      planKey,
      networkId: network.id,
      inputMaterialId: Material.Seed,
      outputMaterialId: Material.Food,
    },
  };
  const serviceEvent = actionFact(serviceEventId, operatorId, serviceAction, {
    mechanicalPowerOperation: true,
    mode: 'operate',
    projectId: installationProjectId,
    installationProjectId,
    planKey,
    networkId: network.id,
    sourceSegmentId: source.id,
    inputMaterialId: Material.Seed,
    inputStackId: 'seed-input',
    outputMaterialId: Material.Food,
    outputStackId: 'food-output',
    outputQuantity: 3,
    conditionBefore: 100,
    conditionAfter: 80,
    shaftMaterialId: Material.DriveShaft,
    wearApplied: 20,
    serviceLoadedOperationOrdinal: 1,
    operationKnowledgeId: 'technique:mechanical-power:water-wheel-shaft-mill-operation',
  });
  const person = {
    id: operatorId,
    knowledge: [{
      id: 'technique:mechanical-power:water-wheel-shaft-mill-operation',
      kind: 'technique',
      confidence: 68,
      sourceEventIds: [serviceEventId],
    }],
  };
  const project = {
    id: installationProjectId,
    ownerId: operatorId,
    status: 'completed',
    desiredFunction: 'water-powered-crop-processing',
    actionEventIds: [serviceEventId],
    mechanicalPowerPlan: plan,
    mechanicalPowerPlanKey: planKey,
    mechanicalPowerNetworkId: network.id,
  };
  const electricalPlan = {
    version: 'electrical-power-plan-v1',
    mechanicalInstallationProjectId: installationProjectId,
    mechanicalNetworkId: network.id,
    mechanicalPlanKey: planKey,
    generatorPosition: { ...plan.shaftPositions[0], z: plan.shaftPositions[0].z + 1 },
    conductorPositions: [{ ...plan.shaftPositions[0], z: plan.shaftPositions[0].z + 2 }],
    loadPosition: { ...plan.shaftPositions[0], z: plan.shaftPositions[0].z + 3 },
  };
  const state = {
    projects: [project],
    people: [person],
    world: {
      grid: generated.world,
      mechanicalPower: world,
      past: [serviceEvent],
    },
  };
  const real = resolveMechanicalElectricalSourceContext(
    state, person, electricalPlan, serviceEventId, true,
  );
  assert.equal('blocked' in real, false,
    '真实本人 service ActionFact 即使已离开 recent tail，仍应授权电力来源');

  const forged = structuredClone(state);
  delete forged.world.past[0].action.mechanicalPowerBasis;
  assert.equal('blocked' in resolveMechanicalElectricalSourceContext(
    forged, forged.people[0], electricalPlan, serviceEventId, true,
  ), true, '仅伪造 diff 而没有真实机械 action basis 必须失败');

  const wrongPerson = structuredClone(state);
  wrongPerson.world.past[0].who = 'other-person';
  assert.equal('blocked' in resolveMechanicalElectricalSourceContext(
    wrongPerson, wrongPerson.people[0], electricalPlan, serviceEventId, true,
  ), true, '不得借用另一人的机械 service 事实');

  const wrongNetwork = structuredClone(state);
  wrongNetwork.world.past[0].diff.networkId = 'other-network';
  assert.equal('blocked' in resolveMechanicalElectricalSourceContext(
    wrongNetwork, wrongNetwork.people[0], electricalPlan, serviceEventId, true,
  ), true, 'service 事实的机械网络不一致时必须失败');

  const coldMissing = structuredClone(state);
  coldMissing.world.past = [];
  assert.equal('blocked' in resolveMechanicalElectricalSourceContext(
    coldMissing, coldMissing.people[0], electricalPlan, serviceEventId, true,
  ), true, '知识引用的冷 service 事实未被保留时必须 fail closed');

  console.log(JSON.stringify({
    ok: true,
    operationCount: network.operationCount,
    faultCount: network.faultCount,
    repairCount: network.repairCount,
    recentEventLimit: MECHANICAL_POWER_RECENT_EVENT_LIMIT,
    sourceEventLimit: MECHANICAL_POWER_SOURCE_EVENT_LIMIT,
    serviceAuthorizedWithoutMembership: true,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
