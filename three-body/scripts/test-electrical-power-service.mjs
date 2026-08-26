import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-electrical-power-service-'));
const bundlePath = path.join(temporaryDirectory, 'electrical-power-service.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/simulation.ts'))};
    export { addInventory, executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { appendCommittedEvents } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/history.ts'))};
    export { Material, materialHas } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export {
      ELECTRICAL_POWER_ACTION_BASIS_VERSION,
      ELECTRICAL_POWER_LOAD_DEMAND,
      ELECTRICAL_POWER_LOAD_TECHNIQUE_PREFIX,
      ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID,
      ELECTRICAL_POWER_PLAN_VERSION,
      createElectricalPowerNetwork,
      electricalPowerNetworkId,
      electricalPowerPlanKey,
      recordElectricalPowerInstallation,
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
    export { buildElectricalPowerServiceOptions } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/electrical-power-service-options.ts'))};
    export { cellId, cellsInRadius, setVoxel } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=electrical-power-service-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    ELECTRICAL_POWER_ACTION_BASIS_VERSION,
    ELECTRICAL_POWER_LOAD_DEMAND,
    ELECTRICAL_POWER_LOAD_TECHNIQUE_PREFIX,
    ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID,
    ELECTRICAL_POWER_PLAN_VERSION,
    MECHANICAL_POWER_ACTION_BASIS_VERSION,
    MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
    MECHANICAL_POWER_PLAN_VERSION,
    MECHANICAL_POWER_WORLD_VERSION,
    Material,
    addInventory,
    appendCommittedEvents,
    buildElectricalPowerServiceOptions,
    cellId,
    cellsInRadius,
    createElectricalPowerNetwork,
    createInitialState,
    createMechanicalPowerNetwork,
    electricalPowerNetworkId,
    electricalPowerPlanKey,
    executePrimitiveAction,
    materialHas,
    mechanicalPowerNetworkId,
    mechanicalPowerPlanKey,
    recordElectricalPowerInstallation,
    recordMechanicalPowerInstallation,
    setVoxel,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(20260826, {
    endpoint: { kind: 'months', value: 120 },
    chaosIntensity: 0,
  });
  const actor = state.people[0];
  actor.inventory = [];
  actor.knowledge = [];
  actor.memories = [];
  actor.baselineCapacities.perception = 100;
  actor.position = {
    ...actor.position,
    cellId: cellId(14, 8),
    z: 1,
    previousCellId: cellId(14, 8),
    previousZ: 1,
    lastPath: [],
    tickPath: [cellId(14, 8)],
  };
  for (const other of state.people.slice(1)) {
    other.position.cellId = cellId(70, 45);
    other.position.z = 1;
  }
  for (let x = 9; x <= 16; x += 1) {
    for (let y = 8; y <= 12; y += 1) {
      setVoxel(state.world.grid, x, y, 0, Material.Stone);
      setVoxel(state.world.grid, x, y, 1, Material.Air);
      setVoxel(state.world.grid, x, y, 2, Material.Air);
    }
  }

  const source = {
    id: 'current:electrical-service',
    kind: 'water-current-segment',
    from: { x: 10, y: 10, z: 1 },
    to: { x: 10, y: 11, z: 1 },
    direction: { dx: 0, dy: 1, dz: 0 },
    capacity: 2,
    upstreamSegmentIds: [],
    requiredWaterVoxels: [{ x: 10, y: 10, z: 1 }, { x: 10, y: 11, z: 1 }],
    sourceKeys: ['world-current:electrical-service', 'position:10:10:1'],
  };
  const mechanicalPlan = {
    version: MECHANICAL_POWER_PLAN_VERSION,
    projectId: 'mechanical-installation-electrical-service',
    sourceSegmentId: source.id,
    wheelPosition: { x: 11, y: 10, z: 1 },
    shaftPositions: [{ x: 12, y: 10, z: 1 }],
    loadPosition: { x: 13, y: 10, z: 1 },
    sourceKeys: [...source.sourceKeys],
  };
  const mechanicalPlanKey = mechanicalPowerPlanKey(mechanicalPlan);
  const mechanicalNetworkId = mechanicalPowerNetworkId(mechanicalPlan);
  const mechanicalNetwork = createMechanicalPowerNetwork(mechanicalPlan);
  setVoxel(state.world.grid, 10, 10, 1, Material.Water);
  setVoxel(state.world.grid, 10, 11, 1, Material.Water);
  setVoxel(state.world.grid, 11, 10, 1, Material.WaterWheel);
  setVoxel(state.world.grid, 12, 10, 1, Material.SteelDriveShaft);
  setVoxel(state.world.grid, 13, 10, 1, Material.Mill);
  recordMechanicalPowerInstallation(mechanicalNetwork, {
    role: 'converter', materialId: Material.WaterWheel, position: mechanicalPlan.wheelPosition,
    projectId: mechanicalPlan.projectId, installedAtMonth: 0,
    installationEventId: 'install-wheel', sourceEventIds: ['make-wheel', 'verify-wheel'],
  });
  recordMechanicalPowerInstallation(mechanicalNetwork, {
    role: 'connector', materialId: Material.SteelDriveShaft, position: mechanicalPlan.shaftPositions[0],
    projectId: mechanicalPlan.projectId, installedAtMonth: 0,
    installationEventId: 'install-shaft', sourceEventIds: ['make-shaft', 'verify-shaft'],
  });
  recordMechanicalPowerInstallation(mechanicalNetwork, {
    role: 'load', materialId: Material.Mill, position: mechanicalPlan.loadPosition,
    projectId: mechanicalPlan.projectId, installedAtMonth: 0,
    installationEventId: 'install-mill', sourceEventIds: ['make-mill', 'verify-mill'],
  });
  mechanicalNetwork.operationCount = 1;
  mechanicalNetwork.serviceLoadedOperationCount = 1;
  mechanicalNetwork.recentOperationEventIds = ['personal-mechanical-service'];
  mechanicalNetwork.serviceCycleOperationEventIds = ['personal-mechanical-service'];
  mechanicalNetwork.sourceEventIds = ['personal-mechanical-service'];
  mechanicalNetwork.condition = 96;
  state.world.mechanicalPower = {
    version: MECHANICAL_POWER_WORLD_VERSION,
    sources: [source],
    networks: [mechanicalNetwork],
  };
  state.projects.push({
    id: mechanicalPlan.projectId,
    kind: 'construction', need: 'mechanical-power-capability',
    desiredFunction: 'water-powered-crop-processing', summary: '已投产水力机械网络',
    ownerId: actor.id, beneficiaryIds: [actor.id], contributorIds: [actor.id],
    triggerFactIds: [], pressure: 80, createdAtMonth: 0, reviewAtMonth: 1,
    status: 'completed', lastProgressAtMonth: 1, completedAtMonth: 1,
    mechanicalPowerPlan: mechanicalPlan,
    mechanicalPowerPlanKey: mechanicalPlanKey,
    mechanicalPowerNetworkId: mechanicalNetworkId,
    missingMaterialIds: [], materialDemands: [], reservations: [],
    actionEventIds: [], failureEventIds: [], completionEventIds: [],
  });

  const mechanicalService = {
    id: 'personal-mechanical-service', kind: 'action', actionTick: 1, planningTick: 1,
    atMonth: 1, orderInMonth: 0, orderInTick: 0, cellId: cellId(13, 9),
    who: actor.id, cause: 'intent',
    action: {
      kind: 'act', operation: 'exert',
      targets: [
        { kind: 'inventory-stack', personId: actor.id, stackId: 'spent-service-seed' },
        { kind: 'voxel', position: { ...mechanicalPlan.loadPosition } },
      ],
      mechanicalPowerBasis: {
        version: MECHANICAL_POWER_ACTION_BASIS_VERSION,
        mode: 'operate-service',
        sourceSegmentId: source.id,
        sourceKeys: [...source.sourceKeys],
        installationProjectId: mechanicalPlan.projectId,
        planKey: mechanicalPlanKey,
        networkId: mechanicalNetworkId,
        operationKnowledgeId: MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
        inputMaterialId: Material.Seed,
        outputMaterialId: Material.Food,
      },
    },
    fromCellId: cellId(13, 9), toCellId: cellId(13, 9), fromZ: 1, toZ: 1,
    pathSegment: [cellId(13, 9)], status: 'completed', result: 'personal mechanical service',
    diff: {
      mechanicalPowerOperation: true,
      mode: 'operate-service',
      installationProjectId: mechanicalPlan.projectId,
      planKey: mechanicalPlanKey,
      networkId: mechanicalNetworkId,
      sourceSegmentId: source.id,
      inputMaterialId: Material.Seed,
      inputStackId: 'spent-service-seed',
      outputMaterialId: Material.Food,
      outputStackId: 'historical-service-food',
      outputQuantity: 3,
      wearApplied: 4,
      serviceLoadedOperationOrdinal: 1,
      operationKnowledgeId: MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
    },
  };
  appendCommittedEvents(state, [mechanicalService]);
  actor.knowledge.push({
    id: MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
    kind: 'technique', summary: '本人做成过水力机械负载服务', confidence: 68,
    learnedAtMonth: 1, sourceEventIds: [mechanicalService.id],
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
  const electricalNetwork = createElectricalPowerNetwork(electricalPlan);
  const electricalComponents = [
    { role: 'source', materialId: Material.MechanicalDynamo, position: electricalPlan.generatorPosition },
    { role: 'conductor', materialId: Material.CopperConductor, position: electricalPlan.conductorPositions[0] },
    { role: 'load', materialId: Material.ResistiveLoad, position: electricalPlan.loadPosition },
  ];
  for (const [index, component] of electricalComponents.entries()) {
    setVoxel(state.world.grid, component.position.x, component.position.y, component.position.z, component.materialId);
    recordElectricalPowerInstallation(electricalNetwork, {
      ...component,
      installedAtMonth: 1,
      installationEventId: `install-electrical-${index}`,
      sourceEventIds: [`make-electrical-${index}`, `verify-electrical-${index}`, mechanicalService.id],
    });
  }
  state.world.electricalPower = {
    version: 'electrical-power-world-v1',
    networks: [electricalNetwork],
    dispatchWindows: [],
  };
  const electricalProject = {
    id: 'completed-electrical-project',
    kind: 'construction', need: 'remote-work-power',
    desiredFunction: 'remote-work-power-delivery', summary: '已完成远端实体电力链',
    ownerId: actor.id, beneficiaryIds: [actor.id], contributorIds: [actor.id],
    triggerFactIds: [mechanicalService.id], pressure: 70, createdAtMonth: 1, reviewAtMonth: 3,
    status: 'completed', lastProgressAtMonth: 2, completedAtMonth: 2,
    electricalPowerPlan: electricalPlan,
    electricalPowerPlanKey: electricalPlanKey,
    electricalPowerNetworkId: electricalNetworkId,
    missingMaterialIds: [], materialDemands: [], reservations: [],
    actionEventIds: [], failureEventIds: [], completionEventIds: [],
  };
  state.projects.push(electricalProject);
  const boundMechanicalProject = state.projects.find((project) => project.id === mechanicalPlan.projectId);
  assert.ok(boundMechanicalProject?.mechanicalPowerPlan);
  assert.equal(boundMechanicalProject.mechanicalPowerPlan.projectId, boundMechanicalProject.id);
  assert.equal(mechanicalPowerPlanKey(boundMechanicalProject.mechanicalPowerPlan), electricalPlan.mechanicalPlanKey);
  assert.equal(boundMechanicalProject.mechanicalPowerPlanKey, electricalPlan.mechanicalPlanKey);
  assert.equal(boundMechanicalProject.mechanicalPowerNetworkId, electricalPlan.mechanicalNetworkId);

  const initialDeliveryAction = {
    kind: 'act', operation: 'exert',
    targets: [{ kind: 'voxel', position: { ...electricalPlan.loadPosition } }],
    electricalPowerBasis: {
      version: ELECTRICAL_POWER_ACTION_BASIS_VERSION,
      mode: 'operate',
      planKey: electricalPlanKey,
      networkId: electricalNetworkId,
      mechanicalServiceEventId: mechanicalService.id,
      requestedPowerUnits: ELECTRICAL_POWER_LOAD_DEMAND,
    },
  };
  const initialDelivery = executePrimitiveAction(state, actor, initialDeliveryAction, 2, 0, {
    cause: 'intent', actionTick: 1,
  });
  assert.equal(initialDelivery.status, 'completed', initialDelivery.result);
  assert.equal(initialDelivery.diff.electricalPowerDelivered, true);
  appendCommittedEvents(state, [initialDelivery]);
  electricalProject.actionEventIds = [initialDelivery.id];
  electricalProject.completionEventIds = [initialDelivery.id];
  assert.equal(actor.knowledge.some((fact) => fact.id === ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID
    && fact.confidence >= 55 && fact.sourceEventIds.includes(initialDelivery.id)), true);
  assert.equal(materialHas(Material.ResistiveLoad, 'hot'), false,
    '电阻负载不能永久获得 hot 标签');

  addInventory(actor, Material.RawMeat, 1, ['hunted-raw-meat'], 'raw-meat-for-electrical-load');
  const readyState = structuredClone(state);
  const readyActor = readyState.people.find((person) => person.id === actor.id);
  const visibleCells = cellsInRadius(actor.position.cellId, 8);
  const options = buildElectricalPowerServiceOptions(state, actor, visibleCells, 3);
  const serviceOption = options.find((option) => option.id.startsWith('operate-completed-electrical-network:'));
  assert.ok(serviceOption, '完成项目后应出现普通电力负载服务 option');
  assert.equal(serviceOption.nextAction.kind, 'act');
  assert.equal(serviceOption.nextAction.electricalPowerBasis?.mode, 'operate-service');
  assert.equal('outputMaterialId' in serviceOption.nextAction.electricalPowerBasis, false,
    '首次局部尝试的 action basis 不得携带隐藏输出');
  assert.equal(serviceOption.summary.includes('熟食'), false,
    '首次局部尝试的 planner 文案不得预知输出');

  const inventoryQuantity = (person, materialId) => person.inventory
    .filter((stack) => stack.materialId === materialId)
    .reduce((sum, stack) => sum + stack.quantity, 0);
  const assertNoMaterialMutation = (candidateState, candidateActor, action, label) => {
    const rawBefore = inventoryQuantity(candidateActor, Material.RawMeat);
    const cookedBefore = inventoryQuantity(candidateActor, Material.CookedFood);
    const mechanicalOperationsBefore = candidateState.world.mechanicalPower.networks[0].operationCount;
    const electricalOperationsBefore = candidateState.world.electricalPower.networks[0].operationCount;
    const fact = executePrimitiveAction(candidateState, candidateActor, action, 3, 0, {
      cause: 'intent', actionTick: 1,
    });
    assert.equal(fact.status, 'blocked', `${label}: ${fact.result}`);
    assert.equal(inventoryQuantity(candidateActor, Material.RawMeat), rawBefore, `${label}: 生肉不得被消费`);
    assert.equal(inventoryQuantity(candidateActor, Material.CookedFood), cookedBefore, `${label}: 不得产出熟食`);
    assert.equal(candidateState.world.mechanicalPower.networks[0].operationCount, mechanicalOperationsBefore,
      `${label}: 不得记机械负载`);
    assert.equal(candidateState.world.electricalPower.networks[0].operationCount, electricalOperationsBefore,
      `${label}: 不得记电力交付`);
  };

  const noElectricalKnowledgeState = structuredClone(readyState);
  const noElectricalKnowledgeActor = noElectricalKnowledgeState.people.find((person) => person.id === actor.id);
  noElectricalKnowledgeActor.knowledge = noElectricalKnowledgeActor.knowledge
    .filter((fact) => fact.id !== ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID);
  assert.equal(buildElectricalPowerServiceOptions(
    noElectricalKnowledgeState,
    noElectricalKnowledgeActor,
    visibleCells,
    3,
  ).length, 0);
  assertNoMaterialMutation(noElectricalKnowledgeState, noElectricalKnowledgeActor, serviceOption.nextAction,
    '无可靠电气知识');

  const noMechanicalServiceState = structuredClone(readyState);
  const noMechanicalServiceActor = noMechanicalServiceState.people.find((person) => person.id === actor.id);
  noMechanicalServiceActor.knowledge = noMechanicalServiceActor.knowledge
    .filter((fact) => fact.id !== MECHANICAL_POWER_OPERATION_TECHNIQUE_ID);
  assert.equal(buildElectricalPowerServiceOptions(
    noMechanicalServiceState,
    noMechanicalServiceActor,
    visibleCells,
    3,
  ).length, 0);
  assertNoMaterialMutation(noMechanicalServiceState, noMechanicalServiceActor, serviceOption.nextAction,
    '无本人机械服务');

  const brokenTopologyState = structuredClone(readyState);
  const brokenTopologyActor = brokenTopologyState.people.find((person) => person.id === actor.id);
  setVoxel(
    brokenTopologyState.world.grid,
    electricalPlan.conductorPositions[0].x,
    electricalPlan.conductorPositions[0].y,
    electricalPlan.conductorPositions[0].z,
    Material.Air,
  );
  assert.equal(buildElectricalPowerServiceOptions(
    brokenTopologyState,
    brokenTopologyActor,
    visibleCells,
    3,
  ).length, 0);
  assertNoMaterialMutation(brokenTopologyState, brokenTopologyActor, serviceOption.nextAction,
    '错误实体拓扑');

  const rawBefore = inventoryQuantity(actor, Material.RawMeat);
  const cookedBefore = inventoryQuantity(actor, Material.CookedFood);
  const service = executePrimitiveAction(state, actor, serviceOption.nextAction, 3, 0, {
    cause: 'intent', actionTick: 1,
  });
  assert.equal(service.status, 'completed', service.result);
  assert.equal(service.diff.electricalPowerUsefulLoad, true);
  assert.equal(service.diff.inputMaterialId, Material.RawMeat);
  assert.equal(service.diff.outputMaterialId, Material.CookedFood);
  assert.equal(inventoryQuantity(actor, Material.RawMeat), rawBefore - 1);
  assert.equal(inventoryQuantity(actor, Material.CookedFood), cookedBefore + 1);
  assert.equal(actor.knowledge.some((fact) => fact.kind === 'technique'
    && fact.id.startsWith(`${ELECTRICAL_POWER_LOAD_TECHNIQUE_PREFIX}:${Material.RawMeat}:`)
    && fact.confidence >= 55
    && fact.sourceEventIds.includes(service.id)), true,
  '成功的真实物理响应必须形成 source-bound 电热技术');
  appendCommittedEvents(state, [service]);
  addInventory(actor, Material.RawMeat, 1, ['second-hunt'], 'second-raw-meat');
  const repeat = buildElectricalPowerServiceOptions(state, actor, visibleCells, 4)
    .find((option) => option.id.includes('second-raw-meat'));
  assert.ok(repeat, '成功经验与新的实体输入应形成普通重复使用 option');
  assert.equal(repeat.goal.kind, 'inventory-at-least');
  assert.equal(repeat.goal.materialId, Material.CookedFood);

  const rssMiB = Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10;
  assert.ok(rssMiB < 256, `fixture RSS ${rssMiB} MiB 超过 256 MiB`);
  console.log(JSON.stringify({
    ok: true,
    rssMiB,
    serviceEventId: service.id,
    inputMaterialId: service.diff.inputMaterialId,
    outputMaterialId: service.diff.outputMaterialId,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
