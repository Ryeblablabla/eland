import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-electrical-power-foundation-'));
const bundlePath = path.join(temporaryDirectory, 'electrical-power-foundation.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/simulation.ts'))};
    export { addInventory, executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { appendCommittedEvents } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/history.ts'))};
    export { Material, MATERIAL_PALETTE, materialHas } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export {
      inventoryCombinationFor,
      inventoryCombinationForOutput,
      inventoryCombinationTechniqueId,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/interaction-rules.ts'))};
    export {
      ELECTRICAL_POWER_ACTION_BASIS_VERSION,
      ELECTRICAL_POWER_LOAD_DEMAND,
      ELECTRICAL_POWER_PLAN_VERSION,
      ELECTRICAL_POWER_RECENT_EVENT_LIMIT,
      ELECTRICAL_POWER_WORLD_VERSION,
      electricalPowerNetworkId,
      electricalPowerPlanKey,
      validateElectricalPowerTopology,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/electrical-power.ts'))};
    export {
      MECHANICAL_POWER_ACTION_BASIS_VERSION,
      MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
      MECHANICAL_POWER_PLAN_VERSION,
      MECHANICAL_POWER_WORLD_VERSION,
      createMechanicalPowerNetwork,
      mechanicalPowerNetworkId,
      mechanicalPowerPlanKey,
      recordMechanicalPowerInstallation,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/mechanical-power.ts'))};
    export { cellId, setVoxel, voxelAt } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=electrical-power-foundation-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    ELECTRICAL_POWER_ACTION_BASIS_VERSION,
    ELECTRICAL_POWER_LOAD_DEMAND,
    ELECTRICAL_POWER_PLAN_VERSION,
    ELECTRICAL_POWER_RECENT_EVENT_LIMIT,
    ELECTRICAL_POWER_WORLD_VERSION,
    MATERIAL_PALETTE,
    MECHANICAL_POWER_ACTION_BASIS_VERSION,
    MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
    MECHANICAL_POWER_PLAN_VERSION,
    MECHANICAL_POWER_WORLD_VERSION,
    Material,
    addInventory,
    appendCommittedEvents,
    cellId,
    createInitialState,
    createMechanicalPowerNetwork,
    electricalPowerNetworkId,
    electricalPowerPlanKey,
    executePrimitiveAction,
    inventoryCombinationFor,
    inventoryCombinationForOutput,
    inventoryCombinationTechniqueId,
    materialHas,
    mechanicalPowerNetworkId,
    mechanicalPowerPlanKey,
    recordMechanicalPowerInstallation,
    setVoxel,
    validateElectricalPowerTopology,
    voxelAt,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  assert.equal(Material.StandardWeight, 71);
  assert.equal(Material.MechanicalDynamo, 72);
  assert.equal(Material.CopperConductor, 73);
  assert.equal(Material.ResistiveLoad, 74);
  assert.equal(Material.BrokenCopperConductor, 75);
  assert.equal(MATERIAL_PALETTE.at(-1).id, Material.BrokenCopperConductor);
  assert.equal(materialHas(Material.MechanicalDynamo, 'electrical-source'), true);
  assert.equal(materialHas(Material.CopperConductor, 'electrical-conductor'), true);
  assert.equal(materialHas(Material.ResistiveLoad, 'electrical-load'), true);
  assert.equal(materialHas(Material.BrokenCopperConductor, 'electrical-conductor'), false);
  assert.deepEqual(inventoryCombinationFor([Material.DriveShaft, Material.Copper]), {
    id: 'assemble-mechanical-dynamo',
    inputs: [
      { materialId: Material.DriveShaft, quantity: 1 },
      { materialId: Material.Copper, quantity: 1 },
    ],
    output: { materialId: Material.MechanicalDynamo, quantity: 1 },
  });
  assert.equal(inventoryCombinationFor([Material.Copper, Material.Rope]).id, 'insulate-copper-conductor');
  assert.equal(inventoryCombinationFor([Material.Copper, Material.FiredBrick]).id, 'assemble-resistive-load');
  assert.equal(inventoryCombinationForOutput(Material.BrokenCopperConductor), undefined,
    '熔断导体不能由普通配方直接制造');

  const state = createInitialState(20260825, {
    endpoint: { kind: 'months', value: 120 },
    chaosIntensity: 0,
  });
  const actor = state.people[0];
  actor.inventory = [];
  actor.knowledge = [];
  for (const other of state.people.slice(1)) other.position = { cellId: cellId(70, 45), z: 1 };

  const source = {
    id: 'current:electrical-foundation',
    kind: 'water-current-segment',
    from: { x: 10, y: 10, z: 1 },
    to: { x: 10, y: 11, z: 1 },
    direction: { dx: 0, dy: 1, dz: 0 },
    capacity: 1,
    upstreamSegmentIds: [],
    requiredWaterVoxels: [{ x: 10, y: 10, z: 1 }, { x: 10, y: 11, z: 1 }],
    sourceKeys: ['world-current:electrical-foundation', 'position:10:10:1'],
  };
  const mechanicalPlan = {
    version: MECHANICAL_POWER_PLAN_VERSION,
    projectId: 'mechanical-installation',
    sourceSegmentId: source.id,
    wheelPosition: { x: 11, y: 10, z: 1 },
    shaftPositions: [{ x: 12, y: 10, z: 1 }],
    loadPosition: { x: 13, y: 10, z: 1 },
    sourceKeys: [...source.sourceKeys],
  };
  const mechanicalPlanKey = mechanicalPowerPlanKey(mechanicalPlan);
  const mechanicalNetworkId = mechanicalPowerNetworkId(mechanicalPlan);
  const mechanicalNetwork = createMechanicalPowerNetwork(mechanicalPlan);

  setVoxel(state.world.grid, source.from.x, source.from.y, source.from.z, Material.Water);
  setVoxel(state.world.grid, source.to.x, source.to.y, source.to.z, Material.Water);
  setVoxel(state.world.grid, mechanicalPlan.wheelPosition.x, mechanicalPlan.wheelPosition.y,
    mechanicalPlan.wheelPosition.z, Material.WaterWheel);
  setVoxel(state.world.grid, mechanicalPlan.shaftPositions[0].x, mechanicalPlan.shaftPositions[0].y,
    mechanicalPlan.shaftPositions[0].z, Material.DriveShaft);
  setVoxel(state.world.grid, mechanicalPlan.loadPosition.x, mechanicalPlan.loadPosition.y,
    mechanicalPlan.loadPosition.z, Material.Mill);
  recordMechanicalPowerInstallation(mechanicalNetwork, {
    role: 'converter', materialId: Material.WaterWheel, position: mechanicalPlan.wheelPosition,
    projectId: mechanicalPlan.projectId, installedAtMonth: 1,
    installationEventId: 'install-water-wheel', sourceEventIds: ['make-water-wheel', 'verify-water-wheel'],
  });
  recordMechanicalPowerInstallation(mechanicalNetwork, {
    role: 'connector', materialId: Material.DriveShaft, position: mechanicalPlan.shaftPositions[0],
    projectId: mechanicalPlan.projectId, installedAtMonth: 1,
    installationEventId: 'install-drive-shaft', sourceEventIds: ['make-drive-shaft', 'verify-drive-shaft'],
  });
  recordMechanicalPowerInstallation(mechanicalNetwork, {
    role: 'load', materialId: Material.Mill, position: mechanicalPlan.loadPosition,
    projectId: mechanicalPlan.projectId, installedAtMonth: 1,
    installationEventId: 'install-mill', sourceEventIds: ['make-mill', 'verify-mill'],
  });
  mechanicalNetwork.repairEventIds = ['repair-commissioning'];
  mechanicalNetwork.operationEventIds = ['mechanical-service'];
  mechanicalNetwork.serviceCycleOperationEventIds = ['mechanical-service'];
  mechanicalNetwork.serviceLoadedOperationCount = 1;
  mechanicalNetwork.condition = 80;
  mechanicalNetwork.sourceEventIds.push('repair-commissioning', 'mechanical-service');
  state.world.mechanicalPower = {
    version: MECHANICAL_POWER_WORLD_VERSION,
    sources: [source],
    networks: [mechanicalNetwork],
  };
  state.projects.push({
    id: mechanicalPlan.projectId,
    ownerId: actor.id,
    desiredFunction: 'water-powered-crop-processing',
    status: 'completed',
    mechanicalPowerPlan: mechanicalPlan,
    mechanicalPowerPlanKey: mechanicalPlanKey,
    mechanicalPowerNetworkId: mechanicalNetworkId,
    actionEventIds: ['mechanical-service'],
  });

  const mechanicalService = {
    id: 'mechanical-service', kind: 'action', actionTick: 1,
    atMonth: 1, orderInMonth: 1, cellId: cellId(13, 9),
    who: actor.id, cause: 'intent',
    action: {
      kind: 'act', operation: 'exert', targets: [
        { kind: 'inventory-stack', personId: actor.id, stackId: 'mechanical-service-seed' },
        { kind: 'voxel', position: { ...mechanicalPlan.loadPosition } },
      ],
      mechanicalPowerBasis: {
        version: MECHANICAL_POWER_ACTION_BASIS_VERSION,
        mode: 'operate-service',
        installationProjectId: mechanicalPlan.projectId,
        planKey: mechanicalPlanKey,
        networkId: mechanicalNetworkId,
        sourceSegmentId: source.id,
        sourceKeys: [...source.sourceKeys],
        operationKnowledgeId: MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
        inputMaterialId: Material.Seed,
        outputMaterialId: Material.Food,
      },
    },
    fromCellId: cellId(13, 9), toCellId: cellId(13, 9),
    fromZ: 1, toZ: 1, pathSegment: [cellId(13, 9)],
    status: 'completed', result: 'mechanical service',
    diff: {
      mechanicalPowerOperation: true,
      installationProjectId: mechanicalPlan.projectId,
      planKey: mechanicalPlanKey,
      networkId: mechanicalNetworkId,
      sourceSegmentId: source.id,
      inputMaterialId: Material.Seed,
      outputMaterialId: Material.Food,
      shaftMaterialId: Material.DriveShaft,
      inputStackId: 'mechanical-service-seed',
      outputStackId: 'mechanical-service-food',
      outputQuantity: 1,
      wearApplied: 1,
      serviceLoadedOperationOrdinal: 1,
      operationKnowledgeId: MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
      mode: 'operate-service',
    },
  };
  appendCommittedEvents(state, [mechanicalService]);
  actor.knowledge.push({
    id: MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
    kind: 'technique',
    summary: '已亲自完成机械负载服务',
    confidence: 68,
    learnedAtMonth: 1,
    sourceEventIds: [mechanicalService.id],
  });

  const electricalPlan = {
    version: ELECTRICAL_POWER_PLAN_VERSION,
    mechanicalInstallationProjectId: mechanicalPlan.projectId,
    mechanicalNetworkId,
    mechanicalPlanKey,
    generatorPosition: { x: 12, y: 9, z: 1 },
    conductorPositions: [{ x: 13, y: 9, z: 1 }],
    loadPosition: { x: 14, y: 9, z: 1 },
  };
  const electricalPlanKey = electricalPowerPlanKey(electricalPlan);
  const electricalNetworkId = electricalPowerNetworkId(electricalPlan);
  for (const position of [
    electricalPlan.generatorPosition,
    ...electricalPlan.conductorPositions,
    electricalPlan.loadPosition,
    { x: 11, y: 9, z: 1 },
    { x: 13, y: 8, z: 1 },
    { x: 14, y: 8, z: 1 },
  ]) {
    setVoxel(state.world.grid, position.x, position.y, 0, Material.Stone);
    setVoxel(state.world.grid, position.x, position.y, position.z, Material.Air);
  }

  addInventory(actor, Material.DriveShaft, 1, ['prior-shaft'], 'prior-shaft');
  addInventory(actor, Material.Copper, 3, ['raw-copper'], 'raw-copper');
  addInventory(actor, Material.Rope, 1, ['raw-rope'], 'raw-rope');
  addInventory(actor, Material.FiredBrick, 1, ['raw-brick'], 'raw-brick');

  const execute = (action, atMonth, orderInMonth, actionTick = orderInMonth) => executePrimitiveAction(
    state,
    actor,
    action,
    atMonth,
    orderInMonth,
    { cause: 'intent', actionTick },
  );
  const commit = (action, atMonth, orderInMonth, actionTick = orderInMonth) => {
    const fact = execute(action, atMonth, orderInMonth, actionTick);
    assert.equal(fact.status, 'completed', fact.result);
    appendCommittedEvents(state, [fact]);
    return fact;
  };
  const manufacture = (targets, atMonth, orderInMonth) => commit({
    kind: 'act', operation: 'combine', targets: targets.map((stackId) => ({
      kind: 'inventory-stack', personId: actor.id, stackId,
    })),
  }, atMonth, orderInMonth);

  const generatorManufacture = manufacture(['prior-shaft', 'raw-copper'], 2, 1);
  const conductorManufacture = manufacture(['raw-copper', 'raw-rope'], 2, 2);
  const loadManufacture = manufacture(['raw-copper', 'raw-brick'], 2, 3);
  const generatorStack = actor.inventory.find((stack) => stack.materialId === Material.MechanicalDynamo);
  const conductorStack = actor.inventory.find((stack) => stack.materialId === Material.CopperConductor);
  const loadStack = actor.inventory.find((stack) => stack.materialId === Material.ResistiveLoad);
  assert.ok(generatorStack && conductorStack && loadStack);
  assert.equal(generatorStack.quantity, 1);
  assert.equal(conductorStack.quantity, 1);
  assert.equal(loadStack.quantity, 1);
  assert.equal(actor.inventory.some((stack) => ['prior-shaft', 'raw-copper', 'raw-rope', 'raw-brick']
    .includes(stack.id)), false, '三条配方必须真实耗尽各自输入，不能取得设施红利');

  const verify = (manufactureFact, stack, orderInMonth, atMonth = 2) => {
    const rule = inventoryCombinationForOutput(stack.materialId);
    return commit({
      kind: 'attend',
      target: { kind: 'inventory-stack', personId: actor.id, stackId: stack.id },
      verification: {
        techniqueId: inventoryCombinationTechniqueId(rule),
        sourceEventId: manufactureFact.id,
        expectedMaterialId: stack.materialId,
      },
    }, atMonth, orderInMonth);
  };
  const generatorVerification = verify(generatorManufacture, generatorStack, 4);
  const conductorVerification = verify(conductorManufacture, conductorStack, 5);
  const loadVerification = verify(loadManufacture, loadStack, 6);

  const install = (role, materialId, position, stack, manufactureFact, verificationFact, actorPosition, orderInMonth) => {
    actor.position = { cellId: cellId(actorPosition.x, actorPosition.y), z: actorPosition.z };
    return commit({
      kind: 'act', operation: 'exert',
      targets: [
        { kind: 'inventory-stack', personId: actor.id, stackId: stack.id },
        { kind: 'voxel', position: { ...position } },
      ],
      electricalPowerBasis: {
        version: ELECTRICAL_POWER_ACTION_BASIS_VERSION,
        mode: 'install',
        plan: electricalPlan,
        planKey: electricalPlanKey,
        networkId: electricalNetworkId,
        mechanicalServiceEventId: mechanicalService.id,
        componentRole: role,
        componentMaterialId: materialId,
        componentPosition: { ...position },
        manufactureEventId: manufactureFact.id,
        verificationEventId: verificationFact.id,
      },
    }, 3, orderInMonth);
  };
  install('source', Material.MechanicalDynamo, electricalPlan.generatorPosition,
    generatorStack, generatorManufacture, generatorVerification, { x: 11, y: 9, z: 1 }, 1);
  install('conductor', Material.CopperConductor, electricalPlan.conductorPositions[0],
    conductorStack, conductorManufacture, conductorVerification, { x: 13, y: 8, z: 1 }, 2);
  install('load', Material.ResistiveLoad, electricalPlan.loadPosition,
    loadStack, loadManufacture, loadVerification, { x: 14, y: 8, z: 1 }, 3);

  assert.equal(state.world.electricalPower.version, ELECTRICAL_POWER_WORLD_VERSION);
  const electricalNetwork = state.world.electricalPower.networks[0];
  assert.deepEqual(validateElectricalPowerTopology(state.world.grid, electricalNetwork), { valid: true });
  const malformedLedger = structuredClone(electricalNetwork);
  malformedLedger.components.find((component) => component.role === 'conductor').materialId = Material.Copper;
  assert.equal(validateElectricalPowerTopology(state.world.grid, malformedLedger).reason, 'conductor-material-mismatch',
    '正确 voxel 不能替伪造的构件材料账本洗白');

  actor.position = { cellId: cellId(14, 8), z: 1 };
  const operationAction = (mechanicalServiceEventId = mechanicalService.id) => ({
    kind: 'act', operation: 'exert',
    targets: [{ kind: 'voxel', position: { ...electricalPlan.loadPosition } }],
    electricalPowerBasis: {
      version: ELECTRICAL_POWER_ACTION_BASIS_VERSION,
      mode: 'operate',
      planKey: electricalPlanKey,
      networkId: electricalNetworkId,
      mechanicalServiceEventId,
      requestedPowerUnits: ELECTRICAL_POWER_LOAD_DEMAND,
    },
  });
  const conditionBeforeForgery = mechanicalNetwork.condition;
  const forgedService = execute(operationAction('unresolved-mechanical-service'), 4, 1, 1);
  assert.equal(forgedService.status, 'blocked');
  assert.equal(mechanicalNetwork.condition, conditionBeforeForgery);
  assert.equal(electricalNetwork.operationCount, 0);

  const firstDelivery = commit(operationAction(), 4, 2, 1);
  assert.equal(firstDelivery.diff.electricalPowerDelivered, true);
  assert.equal(firstDelivery.diff.powerDeliveredUnits, 1);
  assert.equal(firstDelivery.diff.mechanicalPowerOperation, true);
  assert.equal(electricalNetwork.operationCount, 1);
  assert.equal(mechanicalNetwork.condition, 60, '真实发电负载必须计入机械轴磨损');
  assert.equal(state.world.electricalPower.dispatchWindows[0].usedPowerUnits, 1);

  const inventoryBeforeOverload = JSON.stringify(actor.inventory);
  const mechanicalOperationsBeforeOverload = [...mechanicalNetwork.recentOperationEventIds];
  const overload = commit(operationAction(), 4, 3, 1);
  assert.equal(overload.diff.electricalPowerFault, true);
  assert.equal(overload.diff.powerDeliveredUnits, 0);
  assert.equal(overload.diff.availablePowerUnits, 0);
  assert.equal(JSON.stringify(actor.inventory), inventoryBeforeOverload);
  assert.deepEqual(mechanicalNetwork.recentOperationEventIds, mechanicalOperationsBeforeOverload,
    '过载熔断前不得冒充一次成功机械负载');
  assert.equal(mechanicalNetwork.condition, 60, '过载失败不得重复施加机械磨损');
  assert.equal(electricalNetwork.operationCount, 1, '过载失败不得冒充成功供电');
  assert.equal(voxelAt(state.world.grid, 13, 9, 1), Material.BrokenCopperConductor);

  const brokenSnapshot = JSON.stringify({
    inventory: actor.inventory,
    electrical: state.world.electricalPower,
    mechanicalCondition: mechanicalNetwork.condition,
  });
  const blockedOpenCircuit = execute(operationAction(), 4, 4, 2);
  assert.equal(blockedOpenCircuit.status, 'blocked');
  assert.equal(JSON.stringify({
    inventory: actor.inventory,
    electrical: state.world.electricalPower,
    mechanicalCondition: mechanicalNetwork.condition,
  }), brokenSnapshot, '断路拒绝不得消耗、产出或改写网络');

  addInventory(actor, Material.Copper, 1, ['repair-copper'], 'repair-copper');
  addInventory(actor, Material.Rope, 1, ['repair-rope'], 'repair-rope');
  addInventory(actor, Material.IronTool, 1, ['repair-tool-source'], 'repair-tool');
  const replacementManufacture = manufacture(['repair-copper', 'repair-rope'], 4, 5);
  const replacementStack = actor.inventory.find((stack) => stack.materialId === Material.CopperConductor);
  assert.ok(replacementStack);
  const replacementVerification = verify(replacementManufacture, replacementStack, 6, 4);
  actor.position = { cellId: cellId(13, 8), z: 1 };
  const repair = commit({
    kind: 'act', operation: 'exert', toolStackId: 'repair-tool',
    targets: [
      { kind: 'inventory-stack', personId: actor.id, stackId: replacementStack.id },
      { kind: 'voxel', position: { ...electricalPlan.conductorPositions[0] } },
    ],
    electricalPowerBasis: {
      version: ELECTRICAL_POWER_ACTION_BASIS_VERSION,
      mode: 'repair',
      planKey: electricalPlanKey,
      networkId: electricalNetworkId,
      mechanicalServiceEventId: mechanicalService.id,
      faultEventId: overload.id,
      replacementMaterialId: Material.CopperConductor,
      toolMaterialId: Material.IronTool,
      manufactureEventId: replacementManufacture.id,
      verificationEventId: replacementVerification.id,
    },
  }, 4, 7, 2);
  assert.equal(repair.diff.electricalPowerRepair, true);
  assert.equal(electricalNetwork.fault, null);
  assert.equal(electricalNetwork.repairCount, 1);
  assert.equal(voxelAt(state.world.grid, 13, 9, 1), Material.CopperConductor);
  assert.deepEqual(validateElectricalPowerTopology(state.world.grid, electricalNetwork), { valid: true });

  const staleWindowState = structuredClone(state);
  const staleWindowActor = staleWindowState.people.find((person) => person.id === actor.id);
  staleWindowActor.position = { cellId: cellId(14, 8), z: 1 };
  staleWindowState.world.mechanicalPower.sources[0].capacity = 0.5;
  const firstRequestInNextTick = executePrimitiveAction(
    staleWindowState,
    staleWindowActor,
    operationAction(),
    4,
    8,
    { cause: 'intent', actionTick: 2 },
  );
  assert.equal(firstRequestInNextTick.status, 'completed');
  assert.equal(firstRequestInNextTick.diff.electricalPowerFault, true);
  assert.deepEqual(firstRequestInNextTick.diff.dispatchSourceEventIds, [],
    '本刻度首个过载不得把上一 planning tick 的调度事件混入故障来源');
  assert.equal(firstRequestInNextTick.diff.dispatchSourceEventIds.includes(firstDelivery.id), false);

  actor.position = { cellId: cellId(14, 8), z: 1 };
  setVoxel(state.world.grid, 13, 9, 1, Material.Air);
  const operationsBeforeDisconnect = electricalNetwork.operationCount;
  const disconnected = execute(operationAction(), 5, 1, 2);
  assert.equal(disconnected.status, 'blocked');
  assert.equal(disconnected.diff.topologyReason, 'conductor-material-mismatch');
  assert.equal(electricalNetwork.operationCount, operationsBeforeDisconnect);
  assert.equal(mechanicalNetwork.condition, 60);
  setVoxel(state.world.grid, 13, 9, 1, Material.CopperConductor);

  const secondDelivery = commit(operationAction(), 5, 2, 2);
  assert.equal(secondDelivery.diff.electricalPowerDelivered, true);
  assert.equal(electricalNetwork.operationCount, 2);
  assert.equal(mechanicalNetwork.condition, 40);
  const operationsBeforeMechanicalFault = electricalNetwork.operationCount;
  const mechanicalWearFault = commit(operationAction(), 5, 3, 3);
  assert.equal(mechanicalWearFault.diff.mechanicalPowerFault, true);
  assert.equal(mechanicalWearFault.diff.electricalPowerDelivered, false);
  assert.equal(mechanicalWearFault.diff.powerDeliveredUnits, 0);
  assert.equal(electricalNetwork.operationCount, operationsBeforeMechanicalFault);
  assert.equal(mechanicalNetwork.condition, 40);
  assert.equal(voxelAt(state.world.grid, 12, 10, 1), Material.BrokenDriveShaft);

  assert.ok(electricalNetwork.recentOperationEventIds.length <= ELECTRICAL_POWER_RECENT_EVENT_LIMIT);
  assert.ok(electricalNetwork.recentFaultEventIds.length <= ELECTRICAL_POWER_RECENT_EVENT_LIMIT);
  assert.ok(electricalNetwork.recentRepairEventIds.length <= ELECTRICAL_POWER_RECENT_EVENT_LIMIT);
  assert.ok(electricalNetwork.sourceEventIds.length <= 24);
  assert.ok(state.world.electricalPower.dispatchWindows.length <= 1,
    '调度状态只能保留当前 planning tick 的机械源窗口');

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1024 * 1024, `fixture RSS ${(rssBytes / 1024 / 1024).toFixed(1)} MiB 超限`);
  console.log(JSON.stringify({
    ok: true,
    materialRange: [Material.MechanicalDynamo, Material.BrokenCopperConductor],
    deliveredOperations: electricalNetwork.operationCount,
    electricalFaults: electricalNetwork.faultCount,
    electricalRepairs: electricalNetwork.repairCount,
    mechanicalFault: mechanicalNetwork.fault?.kind ?? null,
    rssBytes,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
