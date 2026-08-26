import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-natural-electrical-maintenance-'));
const bundlePath = path.join(temporaryDirectory, 'natural-electrical-maintenance.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/simulation.ts'))};
    export { addInventory, executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { appendCommittedEvents } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/history.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { inventoryCombinationForOutput, inventoryCombinationTechniqueId } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/interaction-rules.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export {
      ELECTRICAL_POWER_ACTION_BASIS_VERSION,
      ELECTRICAL_POWER_LOAD_DEMAND,
      ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID,
      ELECTRICAL_POWER_PLAN_VERSION,
      createElectricalPowerNetwork,
      electricalPowerNetworkId,
      electricalPowerPlanKey,
      recordElectricalPowerInstallation,
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
    export { buildElectricalPowerServiceOptions } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/electrical-power-service-options.ts'))};
    export {
      buildElectricalPowerMaintenanceOptions,
      electricalPowerMaintenanceCompletionEvidence,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/electrical-power-maintenance-options.ts'))};
    export { deriveProjectProposals } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-proposals.ts'))};
    export { compileProjectStep } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-step-compiler.ts'))};
    export { recordProjectAction, synchronizeProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
    export { cellId, cellsInRadius, setVoxel, voxelAt } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=natural-electrical-maintenance-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    ELECTRICAL_POWER_ACTION_BASIS_VERSION,
    ELECTRICAL_POWER_LOAD_DEMAND,
    ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID,
    ELECTRICAL_POWER_PLAN_VERSION,
    MECHANICAL_POWER_ACTION_BASIS_VERSION,
    MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
    MECHANICAL_POWER_PLAN_VERSION,
    MECHANICAL_POWER_WORLD_VERSION,
    Material,
    addInventory,
    appendCommittedEvents,
    buildElectricalPowerMaintenanceOptions,
    buildElectricalPowerServiceOptions,
    cellId,
    cellsInRadius,
    compileProjectStep,
    createElectricalPowerNetwork,
    createInitialState,
    createMechanicalPowerNetwork,
    deriveProjectProposals,
    electricalPowerMaintenanceCompletionEvidence,
    electricalPowerNetworkId,
    electricalPowerPlanKey,
    executePrimitiveAction,
    instantiateProject,
    inventoryCombinationForOutput,
    inventoryCombinationTechniqueId,
    mechanicalPowerNetworkId,
    mechanicalPowerPlanKey,
    recordElectricalPowerInstallation,
    recordMechanicalPowerInstallation,
    recordProjectAction,
    setVoxel,
    synchronizeProject,
    validateElectricalPowerTopology,
    voxelAt,
  } = api;

  const state = createInitialState(560056, {
    endpoint: { kind: 'months', value: 240 },
    chaosIntensity: 0,
  });
  state.world.past = [];
  state.world.historyCursor = { version: 1, eventCount: 0, hotStartIndex: 0, tailEventId: null };
  state.projects = [];
  const actor = state.people[0];
  actor.inventory = [];
  actor.knowledge = [];
  actor.memories = [];
  actor.baselineCapacities.perception = 100;
  actor.position = {
    ...actor.position,
    cellId: cellId(14, 8), z: 1,
    previousCellId: cellId(14, 8), previousZ: 1,
    lastPath: [], tickPath: [cellId(14, 8)],
  };
  for (const other of state.people.slice(1)) {
    other.position.cellId = cellId(70, 45);
    other.position.z = 1;
  }
  for (let x = 9; x <= 17; x += 1) {
    for (let y = 8; y <= 12; y += 1) {
      setVoxel(state.world.grid, x, y, 0, Material.Stone);
      setVoxel(state.world.grid, x, y, 1, Material.Air);
      setVoxel(state.world.grid, x, y, 2, Material.Air);
    }
  }

  const nextOrder = new Map();
  const commit = (action, atMonth, actionTick = 1, allowed = ['completed']) => {
    const order = nextOrder.get(atMonth) ?? 0;
    nextOrder.set(atMonth, order + 1);
    const fact = executePrimitiveAction(state, actor, action, atMonth, order, {
      cause: 'intent', actionTick,
    });
    assert.ok(allowed.includes(fact.status), fact.result);
    appendCommittedEvents(state, [fact]);
    state.clock.elapsedMonths = Math.max(state.clock.elapsedMonths, atMonth);
    return fact;
  };
  const inventoryQuantity = (person, materialId) => person.inventory
    .filter((stack) => stack.materialId === materialId)
    .reduce((sum, stack) => sum + stack.quantity, 0);

  // Genuine earlier blind response and source-bound verification: the later
  // maintenance project may use this knowledge but does not create it.
  addInventory(actor, Material.Copper, 1, ['visible-copper-source'], 'discovery-copper');
  addInventory(actor, Material.Rope, 1, ['made-rope-source'], 'discovery-rope');
  const recipe = inventoryCombinationForOutput(Material.CopperConductor);
  const conductorTechniqueId = inventoryCombinationTechniqueId(recipe);
  const recipeResponse = commit({
    kind: 'act', operation: 'combine',
    targets: [
      { kind: 'inventory-stack', personId: actor.id, stackId: 'discovery-copper' },
      { kind: 'inventory-stack', personId: actor.id, stackId: 'discovery-rope' },
    ],
  }, 0);
  Object.assign(recipeResponse.diff, {
    projectHypothesisOutcome: 'response',
    projectHypothesisHadReliableKnowledge: false,
  });
  const discoveredConductor = actor.inventory.find((stack) => stack.materialId === Material.CopperConductor);
  assert.ok(discoveredConductor);
  const recipeVerification = commit({
    kind: 'attend',
    target: { kind: 'inventory-stack', personId: actor.id, stackId: discoveredConductor.id },
    verification: {
      techniqueId: conductorTechniqueId,
      sourceEventId: recipeResponse.id,
      expectedMaterialId: Material.CopperConductor,
    },
  }, 0);
  assert.equal(recipeVerification.diff.verifiedTechnique, true);
  assert.equal(actor.knowledge.some((fact) => fact.id === conductorTechniqueId
    && fact.confidence >= 55
    && fact.sourceEventIds.includes(recipeResponse.id)
    && fact.sourceEventIds.includes(recipeVerification.id)), true);
  actor.inventory = actor.inventory.filter((stack) => stack.id !== discoveredConductor.id);

  const source = {
    id: 'current:electrical-maintenance',
    kind: 'water-current-segment',
    from: { x: 10, y: 10, z: 1 },
    to: { x: 10, y: 11, z: 1 },
    direction: { dx: 0, dy: 1, dz: 0 },
    capacity: 1,
    upstreamSegmentIds: [],
    requiredWaterVoxels: [{ x: 10, y: 10, z: 1 }, { x: 10, y: 11, z: 1 }],
    sourceKeys: ['world-current:electrical-maintenance', 'position:10:10:1'],
  };
  const mechanicalPlan = {
    version: MECHANICAL_POWER_PLAN_VERSION,
    projectId: 'mechanical-installation-electrical-maintenance',
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
    installationEventId: 'install-steel-shaft', sourceEventIds: ['make-steel-shaft', 'verify-steel-shaft'],
  });
  recordMechanicalPowerInstallation(mechanicalNetwork, {
    role: 'load', materialId: Material.Mill, position: mechanicalPlan.loadPosition,
    projectId: mechanicalPlan.projectId, installedAtMonth: 0,
    installationEventId: 'install-mill', sourceEventIds: ['make-mill', 'verify-mill'],
  });
  mechanicalNetwork.condition = 100;
  mechanicalNetwork.operationCount = 1;
  mechanicalNetwork.serviceLoadedOperationCount = 1;
  mechanicalNetwork.serviceCycleOperationEventIds = ['personal-mechanical-service'];
  state.world.mechanicalPower = {
    version: MECHANICAL_POWER_WORLD_VERSION,
    sources: [source],
    networks: [mechanicalNetwork],
  };
  const mechanicalProject = {
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
  };
  state.projects.push(mechanicalProject);
  const mechanicalService = {
    id: 'personal-mechanical-service', kind: 'action', actionTick: 1,
    atMonth: 1, orderInMonth: 0, cellId: cellId(13, 9),
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
      wearApplied: 10,
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
  const components = [
    { role: 'source', materialId: Material.MechanicalDynamo, position: electricalPlan.generatorPosition,
      installationEventId: 'install-generator', sourceEventIds: ['make-generator', 'verify-generator'] },
    { role: 'conductor', materialId: Material.CopperConductor, position: electricalPlan.conductorPositions[0],
      installationEventId: 'install-conductor', sourceEventIds: [recipeResponse.id, recipeVerification.id] },
    { role: 'load', materialId: Material.ResistiveLoad, position: electricalPlan.loadPosition,
      installationEventId: 'install-load', sourceEventIds: ['make-load', 'verify-load'] },
  ];
  for (const component of components) {
    setVoxel(state.world.grid, component.position.x, component.position.y, component.position.z, component.materialId);
    recordElectricalPowerInstallation(electricalNetwork, {
      ...component,
      installedAtMonth: 1,
    });
  }
  state.world.electricalPower = {
    version: 'electrical-power-world-v1',
    networks: [electricalNetwork],
    dispatchWindows: [],
  };
  const operationAction = {
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
  const commissioning = commit(operationAction, 2, 1);
  assert.equal(commissioning.diff.electricalPowerDelivered, true);
  assert.equal(actor.knowledge.some((fact) => fact.id === ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID
    && fact.confidence >= 55
    && fact.sourceEventIds.includes(commissioning.id)), true);
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
    actionEventIds: [commissioning.id], failureEventIds: [], completionEventIds: [commissioning.id],
  };
  state.projects.push(electricalProject);
  assert.deepEqual(validateElectricalPowerTopology(state.world.grid, electricalNetwork), { valid: true });

  const visibleCells = cellsInRadius(actor.position.cellId, 8);
  addInventory(actor, Material.RawMeat, 1, ['first-raw-meat'], 'first-raw-meat');
  const firstHeat = buildElectricalPowerServiceOptions(state, actor, visibleCells, 3)
    .find((option) => option.nextAction.kind === 'act'
      && option.nextAction.electricalPowerBasis?.mode === 'operate-service');
  assert.ok(firstHeat, '完成电网应出现普通有用电热服务');
  const usefulBeforeFault = commit(firstHeat.nextAction, 3, 1);
  assert.equal(usefulBeforeFault.diff.electricalPowerUsefulLoad, true);
  assert.equal(usefulBeforeFault.diff.outputMaterialId, Material.CookedFood);

  addInventory(actor, Material.RawMeat, 1, ['fault-raw-meat'], 'fault-raw-meat');
  const overloadAttempt = buildElectricalPowerServiceOptions(state, actor, visibleCells, 3)
    .find((option) => option.nextAction.kind === 'act'
      && option.nextAction.electricalPowerBasis?.mode === 'operate-service');
  assert.ok(overloadAttempt);
  const rawBeforeFault = inventoryQuantity(actor, Material.RawMeat);
  const fault = commit(overloadAttempt.nextAction, 3, 1);
  assert.equal(fault.diff.electricalPowerFault, true);
  assert.equal(fault.diff.electricalPowerDelivered, false);
  assert.equal(inventoryQuantity(actor, Material.RawMeat), rawBeforeFault,
    '过载熔断不得消费服务输入');
  assert.equal(voxelAt(state.world.grid, 13, 9, 1), Material.BrokenCopperConductor);

  const diagnosisOption = buildElectricalPowerMaintenanceOptions(state, actor, visibleCells)
    .find((option) => option.id.includes(fault.id));
  assert.ok(diagnosisOption, '眼前当前 BrokenCopperConductor 应产生 attend 诊断 option');
  const diagnosis = commit(diagnosisOption.nextAction, 3, 2);
  assert.equal(diagnosis.diff.electricalPowerFaultDiagnosis, true);
  assert.equal(diagnosis.diff.faultEventId, fault.id);
  assert.equal(buildElectricalPowerMaintenanceOptions(state, actor, visibleCells).length, 0,
    '同一 current fault 已诊断后不得重复产生诊断 option');

  const proposal = deriveProjectProposals(state, actor, visibleCells, [], [])
    .find((candidate) => candidate.desiredFunction === 'restore-electrical-power-delivery');
  assert.ok(proposal, '本人 source-bound 诊断应形成 equipment-reliability 普通项目');
  assert.equal(proposal.need, 'equipment-reliability');
  assert.deepEqual(proposal.triggerFactIds, [diagnosis.id, fault.id].sort(),
    'pressure basis 只能冻结 fault + diagnosis 的有界来源');
  assert.equal(proposal.summary.includes('铜与绳'), false, '项目不得泄露替换导体配方');

  const stalledState = structuredClone(state);
  const stalledActor = stalledState.people.find((person) => person.id === actor.id);
  stalledActor.knowledge = stalledActor.knowledge.filter((fact) => fact.id !== conductorTechniqueId);
  const stalledProject = instantiateProject(proposal);
  stalledState.projects.push(stalledProject);
  assert.equal(compileProjectStep(stalledState, stalledActor, [], stalledProject), null,
    '不知道导体配方时项目必须允许停滞，不得由 desiredFunction 展开隐藏答案');
  assert.equal(stalledProject.missingMaterialIds.includes(Material.CopperConductor), false);

  const maintenanceProject = instantiateProject(proposal);
  state.projects.push(maintenanceProject);
  addInventory(actor, Material.Copper, 1, ['repair-copper-source'], 'repair-copper');
  addInventory(actor, Material.Rope, 1, ['repair-rope-source'], 'repair-rope');
  addInventory(actor, Material.IronTool, 1, ['repair-tool-source'], 'repair-tool');

  const manufactureStep = compileProjectStep(state, actor, [], maintenanceProject);
  assert.equal(manufactureStep?.action.kind, 'act');
  assert.equal(manufactureStep?.action.operation, 'combine');
  const manufacture = commit(manufactureStep.action, 4, 1);
  assert.equal(manufacture.diff.outputMaterialId, Material.CopperConductor);
  recordProjectAction(state, maintenanceProject.id, manufacture);

  const verificationStep = compileProjectStep(state, actor, [], maintenanceProject);
  assert.equal(verificationStep?.action.kind, 'attend');
  const verification = commit(verificationStep.action, 4, 2);
  assert.equal(verification.diff.verifiedSourceEventId, manufacture.id);
  assert.equal(verification.diff.verifiedMaterialId, Material.CopperConductor);
  recordProjectAction(state, maintenanceProject.id, verification);

  let repairStep = compileProjectStep(state, actor, [], maintenanceProject);
  for (let moves = 0; repairStep?.action.kind === 'move' && moves < 4; moves += 1) {
    const movement = commit(repairStep.action, 4, 3 + moves, ['completed', 'progressed']);
    recordProjectAction(state, maintenanceProject.id, movement);
    repairStep = compileProjectStep(state, actor, [], maintenanceProject);
  }
  assert.equal(repairStep?.action.kind, 'act');
  assert.equal(repairStep?.action.electricalPowerBasis?.mode, 'repair');
  assert.equal(repairStep?.action.electricalPowerBasis?.maintenanceProjectId, maintenanceProject.id);

  const assertRejectedRepairPreservesState = (candidateState, mutateAction, label) => {
    const candidateActor = candidateState.people.find((person) => person.id === actor.id);
    const action = structuredClone(repairStep.action);
    mutateAction(candidateState, candidateActor, action);
    const replacementBefore = inventoryQuantity(candidateActor, Material.CopperConductor);
    const repairCountBefore = candidateState.world.electricalPower.networks[0].repairCount;
    const blocked = executePrimitiveAction(candidateState, candidateActor, action, 5, 90, {
      cause: 'intent', actionTick: 1,
    });
    assert.equal(blocked.status, 'blocked', `${label}: ${blocked.result}`);
    assert.equal(inventoryQuantity(candidateActor, Material.CopperConductor), replacementBefore,
      `${label}: 不得消费替换导体`);
    assert.equal(candidateState.world.electricalPower.networks[0].repairCount, repairCountBefore,
      `${label}: 不得伪造 repair receipt`);
    assert.equal(voxelAt(candidateState.world.grid, 13, 9, 1), Material.BrokenCopperConductor,
      `${label}: 失败时实体故障必须保持`);
  };
  assertRejectedRepairPreservesState(structuredClone(state), (_candidateState, _candidateActor, action) => {
    action.electricalPowerBasis.faultEventId = 'wrong-current-fault';
  }, '错误 fault');
  assertRejectedRepairPreservesState(structuredClone(state), (_candidateState, _candidateActor, action) => {
    action.electricalPowerBasis.manufactureEventId = recipeResponse.id;
    action.electricalPowerBasis.verificationEventId = recipeVerification.id;
  }, '故障前旧制造/核验');
  assertRejectedRepairPreservesState(structuredClone(state), (_candidateState, candidateActor) => {
    candidateActor.inventory = candidateActor.inventory.filter((stack) => stack.id !== 'repair-tool');
  }, '无 IronTool');

  const repair = commit(repairStep.action, 5, 1);
  assert.equal(repair.diff.electricalPowerRepair, true);
  assert.equal(repair.diff.maintenanceProjectId, maintenanceProject.id);
  recordProjectAction(state, maintenanceProject.id, repair);
  synchronizeProject(state, maintenanceProject, 5);
  assert.equal(maintenanceProject.status, 'completed');
  assert.ok(electricalPowerMaintenanceCompletionEvidence(state, maintenanceProject).includes(repair.id));
  assert.equal(electricalNetwork.fault, null);
  assert.equal(voxelAt(state.world.grid, 13, 9, 1), Material.CopperConductor);
  assert.deepEqual(validateElectricalPowerTopology(state.world.grid, electricalNetwork), { valid: true });

  addInventory(actor, Material.RawMeat, 1, ['restored-raw-meat'], 'restored-raw-meat');
  const restoredOption = buildElectricalPowerServiceOptions(
    state,
    actor,
    cellsInRadius(actor.position.cellId, 8),
    6,
  ).find((option) => option.id.startsWith('operate-completed-electrical-network:'));
  assert.ok(restoredOption, '维修项目完成后普通有用电热服务必须重新自然出现');
  const restoredServiceAction = restoredOption.completionAction ?? restoredOption.nextAction;
  assert.equal(restoredServiceAction.kind, 'act');
  assert.equal(restoredServiceAction.electricalPowerBasis.recoveryRepairEventId, repair.id,
    '恢复后普通 service basis 必须显式绑定同网络最近 repair');
  if (restoredOption.nextAction.kind === 'move') {
    commit(restoredOption.nextAction, 6, 1, ['completed', 'progressed']);
  }
  const cookedBeforeRestore = inventoryQuantity(actor, Material.CookedFood);
  const restoredService = commit(restoredServiceAction, 6, 2);
  assert.equal(restoredService.diff.electricalPowerUsefulLoad, true);
  assert.equal(restoredService.diff.outputMaterialId, Material.CookedFood);
  assert.equal(restoredService.diff.recoveryRepairEventId, repair.id);
  assert.ok(restoredService.atMonth > repair.atMonth,
    '恢复有用服务必须发生在 repair 之后，不能作为项目完成条件');
  assert.equal(inventoryQuantity(actor, Material.CookedFood), cookedBeforeRestore + 1);

  const rssMiB = Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10;
  assert.ok(rssMiB < 256, `fixture RSS ${rssMiB} MiB 超过 256 MiB`);
  console.log(JSON.stringify({
    ok: true,
    rssMiB,
    faultEventId: fault.id,
    diagnosisEventId: diagnosis.id,
    maintenanceProjectId: maintenanceProject.id,
    repairEventId: repair.id,
    restoredServiceEventId: restoredService.id,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
