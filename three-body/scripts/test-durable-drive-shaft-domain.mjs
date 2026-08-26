import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-durable-drive-shaft-domain-'));
const bundlePath = path.join(temporaryDirectory, 'durable-drive-shaft-domain.mjs');

try {
  const entry = `
    export { executeMechanicalPowerAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/actions/mechanical-power-actions.ts'))};
    export { appendCommittedEvents } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/history.ts'))};
    export { Material, MATERIAL_PALETTE } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export {
      exposureRuleFor,
      inventoryCombinationFor,
      inventoryCombinationForOutput,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/interaction-rules.ts'))};
    export {
      MECHANICAL_POWER_ACTION_BASIS_VERSION,
      MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT,
      MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
      MECHANICAL_POWER_OPERATION_WEAR,
      MECHANICAL_POWER_PLAN_VERSION,
      MECHANICAL_POWER_STEEL_OPERATION_WEAR,
      MECHANICAL_POWER_WORLD_VERSION,
      createMechanicalPowerNetwork,
      mechanicalDriveShaftSpecification,
      mechanicalPowerNetworkId,
      mechanicalPowerPlanKey,
      recordMechanicalPowerFault,
      recordMechanicalPowerInstallation,
      validateMechanicalPowerTopology,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/mechanical-power.ts'))};
    export {
      WORLD_DEPTH,
      WORLD_LEVELS,
      WORLD_VOXEL_COUNT,
      WORLD_WIDTH,
      cellId,
      setVoxel,
      voxelAt,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=durable-drive-shaft-domain-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    MATERIAL_PALETTE,
    MECHANICAL_POWER_ACTION_BASIS_VERSION,
    MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT,
    MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
    MECHANICAL_POWER_OPERATION_WEAR,
    MECHANICAL_POWER_PLAN_VERSION,
    MECHANICAL_POWER_STEEL_OPERATION_WEAR,
    MECHANICAL_POWER_WORLD_VERSION,
    Material,
    WORLD_DEPTH,
    WORLD_LEVELS,
    WORLD_VOXEL_COUNT,
    WORLD_WIDTH,
    appendCommittedEvents,
    cellId,
    createMechanicalPowerNetwork,
    executeMechanicalPowerAction,
    exposureRuleFor,
    inventoryCombinationFor,
    inventoryCombinationForOutput,
    mechanicalDriveShaftSpecification,
    mechanicalPowerNetworkId,
    mechanicalPowerPlanKey,
    recordMechanicalPowerFault,
    recordMechanicalPowerInstallation,
    setVoxel,
    validateMechanicalPowerTopology,
    voxelAt,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  // Persisted material ids remain stable; the steel chain is appended and
  // consists only of ordinary inventory/exposure rules with physical inputs.
  assert.equal(Material.DriveShaft, 65);
  assert.equal(Material.BrokenDriveShaft, 66);
  assert.equal(Material.SteelCharge, 67);
  assert.equal(Material.Steel, 68);
  assert.equal(Material.SteelDriveShaft, 69);
  assert.equal(inventoryCombinationFor([Material.Charcoal, Material.Iron]).id, 'prepare-steel-charge');
  assert.deepEqual(inventoryCombinationForOutput(Material.SteelCharge), {
    id: 'prepare-steel-charge',
    inputs: [
      { materialId: Material.Iron, quantity: 1 },
      { materialId: Material.Charcoal, quantity: 1 },
    ],
    output: { materialId: Material.SteelCharge, quantity: 1 },
  });
  assert.deepEqual(exposureRuleFor(Material.SteelCharge, Material.Smithy), {
    id: 'refine-steel-charge-in-smithy',
    inputMaterialId: Material.SteelCharge,
    targetMaterialId: Material.Smithy,
    outputMaterialId: Material.Steel,
  });
  assert.equal(exposureRuleFor(Material.SteelCharge, Material.Fire), undefined,
    '炼钢料不能跳过实体 Smithy 高温条件');
  assert.equal(exposureRuleFor(Material.SteelCharge, Material.Foundry), undefined);
  assert.deepEqual(inventoryCombinationFor([Material.Plank, Material.Steel]), {
    id: 'forge-steel-drive-shaft',
    inputs: [
      { materialId: Material.Steel, quantity: 1 },
      { materialId: Material.Plank, quantity: 1 },
    ],
    output: { materialId: Material.SteelDriveShaft, quantity: 1 },
  });

  const makeGrid = () => ({
    version: 2,
    width: WORLD_WIDTH,
    depth: WORLD_DEPTH,
    levels: WORLD_LEVELS,
    generator: { version: 'material-world-v4-regional-geology', seed: 40 },
    palette: MATERIAL_PALETTE,
    voxels: new Uint16Array(WORLD_VOXEL_COUNT),
  });
  const source = {
    id: 'current:test:steel-shaft',
    kind: 'water-current-segment',
    from: { x: 10, y: 10, z: 1 },
    to: { x: 10, y: 11, z: 1 },
    direction: { dx: 0, dy: 1, dz: 0 },
    capacity: 1,
    upstreamSegmentIds: [],
    requiredWaterVoxels: [{ x: 10, y: 10, z: 1 }, { x: 10, y: 11, z: 1 }],
    sourceKeys: ['world-current:test', 'position:10:10:1'],
  };
  const plan = {
    version: MECHANICAL_POWER_PLAN_VERSION,
    projectId: 'install-project',
    sourceSegmentId: source.id,
    wheelPosition: { x: 11, y: 10, z: 1 },
    shaftPositions: [{ x: 12, y: 10, z: 1 }],
    loadPosition: { x: 13, y: 10, z: 1 },
    sourceKeys: [...source.sourceKeys],
  };
  const planKey = mechanicalPowerPlanKey(plan);
  const networkId = mechanicalPowerNetworkId(plan);

  const actionFact = ({ id, atMonth, orderInMonth, action, diff, status = 'completed' }) => ({
    id,
    kind: 'action',
    atMonth,
    orderInMonth,
    actionTick: orderInMonth,
    who: 'maker',
    cause: 'intent',
    action,
    cellId: cellId(12, 9),
    fromCellId: cellId(12, 9),
    toCellId: cellId(12, 9),
    fromZ: 1,
    toZ: 1,
    pathSegment: [],
    status,
    result: id,
    diff,
  });

  function makeRepairState({
    manufactureAtMonth = 11,
    verificationEventId = 'verify-steel-shaft',
  } = {}) {
    const grid = makeGrid();
    setVoxel(grid, source.from.x, source.from.y, source.from.z, Material.Water);
    setVoxel(grid, source.to.x, source.to.y, source.to.z, Material.Water);
    setVoxel(grid, plan.wheelPosition.x, plan.wheelPosition.y, plan.wheelPosition.z, Material.WaterWheel);
    setVoxel(grid, plan.shaftPositions[0].x, plan.shaftPositions[0].y, plan.shaftPositions[0].z, Material.BrokenDriveShaft);
    setVoxel(grid, plan.loadPosition.x, plan.loadPosition.y, plan.loadPosition.z, Material.Mill);

    const network = createMechanicalPowerNetwork(plan);
    recordMechanicalPowerInstallation(network, {
      role: 'converter', materialId: Material.WaterWheel, position: plan.wheelPosition,
      projectId: plan.projectId, installedAtMonth: 2,
      installationEventId: 'install-wheel', sourceEventIds: ['make-wheel', 'verify-wheel'],
    });
    recordMechanicalPowerInstallation(network, {
      role: 'connector', materialId: Material.DriveShaft, position: plan.shaftPositions[0],
      projectId: plan.projectId, installedAtMonth: 2,
      installationEventId: 'install-bronze-shaft', sourceEventIds: ['make-bronze-shaft', 'verify-bronze-shaft'],
    });
    recordMechanicalPowerInstallation(network, {
      role: 'load', materialId: Material.Mill, position: plan.loadPosition,
      projectId: plan.projectId, installedAtMonth: 2,
      installationEventId: 'install-mill', sourceEventIds: ['make-mill', 'verify-mill'],
    });
    network.condition = 40;
    network.operationEventIds = ['loaded-1', 'loaded-2', 'loaded-3'];
    network.serviceLoadedOperationCount = 3;
    network.serviceCycleOperationEventIds = [...network.operationEventIds];
    assert.throws(() => recordMechanicalPowerFault(network, {
      kind: 'worn-drive-shaft',
      componentRole: 'connector',
      componentPosition: { ...plan.shaftPositions[0] },
      atMonth: 10,
      faultEventId: 'fault-with-forged-proof',
      sourceEventIds: ['unrelated-event'],
      proofEventIds: ['unrelated-event'],
      failedComponentMaterialId: Material.DriveShaft,
      failedComponentInstallationEventId: 'install-bronze-shaft',
      serviceLoadedOperationCount: 3,
    }), /有界证明 ID/);
    assert.equal(network.fault, null, '伪造证明必须在变更网络前失败');
    recordMechanicalPowerFault(network, {
      kind: 'worn-drive-shaft',
      componentRole: 'connector',
      componentPosition: { ...plan.shaftPositions[0] },
      atMonth: 10,
      faultEventId: 'fault-bronze-shaft',
      sourceEventIds: ['loaded-1', 'loaded-2', 'loaded-3'],
      failedComponentMaterialId: Material.DriveShaft,
      failedComponentInstallationEventId: 'install-bronze-shaft',
      serviceLoadedOperationCount: 3,
    });

    const fault = actionFact({
      id: 'fault-bronze-shaft', atMonth: 10, orderInMonth: 1,
      action: { kind: 'act', operation: 'exert', targets: [] },
      diff: { mechanicalPowerFault: true, networkId, faultKind: 'worn-drive-shaft' },
    });
    const diagnosis = actionFact({
      id: 'diagnose-bronze-shaft', atMonth: 10, orderInMonth: 2,
      action: {
        kind: 'attend',
        target: { kind: 'voxel', position: { ...plan.shaftPositions[0] } },
        mechanicalPowerFaultObservation: {
          version: 'mechanical-power-fault-observation-v1',
          installationProjectId: plan.projectId,
          planKey,
          networkId,
          faultEventId: fault.id,
        },
      },
      diff: { mechanicalPowerFaultDiagnosis: true, networkId, faultEventId: fault.id },
    });
    const manufacture = actionFact({
      id: 'make-steel-shaft', atMonth: manufactureAtMonth, orderInMonth: 1,
      action: {
        kind: 'act', operation: 'combine',
        targets: [
          { kind: 'inventory-stack', personId: 'maker', stackId: 'steel-input' },
          { kind: 'inventory-stack', personId: 'maker', stackId: 'plank-input' },
        ],
      },
      diff: {
        inputMaterialIds: [Material.Steel, Material.Plank],
        outputMaterialId: Material.SteelDriveShaft,
        outputStackId: 'replacement-steel-shaft',
      },
    });
    const verification = actionFact({
      id: verificationEventId, atMonth: Math.max(11, manufactureAtMonth), orderInMonth: 2,
      action: { kind: 'attend', target: { kind: 'inventory-stack', personId: 'maker', stackId: 'replacement-steel-shaft' } },
      diff: {
        verifiedSourceEventId: manufacture.id,
        verifiedStackId: 'replacement-steel-shaft',
        verifiedMaterialId: Material.SteelDriveShaft,
      },
    });
    const installationProject = {
      id: plan.projectId,
      status: 'completed',
      ownerId: 'maker',
      desiredFunction: 'water-powered-crop-processing',
      mechanicalPowerPlan: structuredClone(plan),
      mechanicalPowerPlanKey: planKey,
      mechanicalPowerNetworkId: networkId,
      triggerFactIds: [],
      actionEventIds: [],
    };
    const maintenanceProject = {
      id: 'reliability-project',
      status: 'active',
      ownerId: 'maker',
      desiredFunction: 'restore-water-powered-crop-processing',
      mechanicalPowerPlan: structuredClone(plan),
      mechanicalPowerPlanKey: planKey,
      mechanicalPowerNetworkId: networkId,
      mechanicalPowerFaultEventId: fault.id,
      triggerFactIds: [diagnosis.id],
      actionEventIds: [manufacture.id, verification.id],
    };
    const person = {
      id: 'maker',
      position: { cellId: cellId(12, 9), z: 1 },
      inventory: [
        { id: 'replacement-steel-shaft', materialId: Material.SteelDriveShaft, quantity: 1, sourceEventIds: [manufacture.id] },
        { id: 'bronze-tool', materialId: Material.BronzeTool, quantity: 1, sourceEventIds: ['make-bronze-tool'] },
        { id: 'seed-reserve', materialId: Material.Seed, quantity: 2, sourceEventIds: ['harvest-seed'] },
        { id: 'food-reserve', materialId: Material.Food, quantity: 4, sourceEventIds: ['stored-food'] },
      ],
      knowledge: [{
        id: `observation:mechanical-power-fault:${networkId}:${fault.id}`,
        kind: 'observation', confidence: 90, learnedAtMonth: 10, sourceEventIds: [diagnosis.id],
      }],
    };
    return {
      state: {
        world: {
          grid,
          past: [fault, diagnosis, manufacture, verification],
          historyCursor: {
            version: 1,
            eventCount: 4,
            hotStartIndex: 0,
            tailEventId: verification.id,
          },
          mechanicalPower: {
            version: MECHANICAL_POWER_WORLD_VERSION,
            sources: [structuredClone(source)],
            networks: [network],
          },
        },
        people: [person],
        projects: [installationProject, maintenanceProject],
      },
      person,
      network,
      fault,
      diagnosis,
      manufacture,
      verification,
      maintenanceProject,
    };
  }

  const repairActionFor = (fixture) => ({
    kind: 'act',
    operation: 'exert',
    toolStackId: 'bronze-tool',
    targets: [
      { kind: 'inventory-stack', personId: 'maker', stackId: 'replacement-steel-shaft' },
      { kind: 'voxel', position: { ...plan.shaftPositions[0] } },
    ],
    mechanicalPowerBasis: {
      version: MECHANICAL_POWER_ACTION_BASIS_VERSION,
      mode: 'repair-service',
      sourceSegmentId: source.id,
      sourceKeys: [...source.sourceKeys],
      installationProjectId: plan.projectId,
      maintenanceProjectId: fixture.maintenanceProject.id,
      planKey,
      networkId,
      faultEventId: fixture.fault.id,
      diagnosisFactId: `observation:mechanical-power-fault:${networkId}:${fixture.fault.id}`,
      replacementMaterialId: Material.SteelDriveShaft,
      replacementManufactureEventId: fixture.manufacture.id,
      replacementVerificationEventId: fixture.verification.id,
      toolMaterialId: Material.BronzeTool,
    },
  });

  const rejectedRepair = (mutateFixture, mutateAction = () => {}) => {
    const fixture = makeRepairState();
    const action = repairActionFor(fixture);
    mutateFixture(fixture);
    mutateAction(action);
    const before = structuredClone(fixture.person.inventory);
    const outcome = executeMechanicalPowerAction(fixture.state, fixture.person, action, 12, 'repair-steel-upgrade');
    assert.equal(outcome.status, 'blocked');
    assert.deepEqual(fixture.person.inventory, before, '非法升级不得消耗替换轴、工具、种子或食物');
    assert.equal(voxelAt(fixture.state.world.grid,
      plan.shaftPositions[0].x, plan.shaftPositions[0].y, plan.shaftPositions[0].z), Material.BrokenDriveShaft);
  };
  rejectedRepair(() => {}, (action) => { action.mechanicalPowerBasis.maintenanceProjectId = 'wrong-project'; });
  rejectedRepair(() => {}, (action) => { action.mechanicalPowerBasis.networkId = 'wrong-network'; });
  rejectedRepair((fixture) => {
    fixture.manufacture.atMonth = 9;
    fixture.verification.atMonth = 9;
  });
  rejectedRepair(() => {}, (action) => { action.mechanicalPowerBasis.replacementVerificationEventId = 'not-verified'; });

  const legal = makeRepairState();
  const seedBeforeRepair = legal.person.inventory.find((stack) => stack.materialId === Material.Seed).quantity;
  const foodBeforeRepair = legal.person.inventory.find((stack) => stack.materialId === Material.Food).quantity;
  const repaired = executeMechanicalPowerAction(
    legal.state, legal.person, repairActionFor(legal), 12, 'repair-steel-upgrade',
  );
  assert.equal(repaired.status, 'completed');
  assert.equal(repaired.diff.shaftMaterialId, Material.SteelDriveShaft);
  assert.equal(repaired.diff.faultShaftMaterialId, Material.DriveShaft);
  assert.equal(repaired.diff.replacementManufactureEventId, legal.manufacture.id);
  assert.equal(repaired.diff.replacementVerificationEventId, legal.verification.id);
  assert.ok(repaired.diff.repairSourceEventIds.includes(legal.fault.id));
  assert.ok(repaired.diff.repairSourceEventIds.includes(legal.manufacture.id));
  assert.ok(repaired.diff.repairSourceEventIds.includes(legal.verification.id));
  assert.equal(repaired.diff.wearApplied, 0);
  assert.equal(repaired.diff.serviceLoadedOperationCountAfter, 0);
  assert.equal(legal.person.inventory.some((stack) => stack.id === 'replacement-steel-shaft'), false,
    '合法升级必须消耗实体替换轴');
  assert.equal(voxelAt(legal.state.world.grid,
    plan.shaftPositions[0].x, plan.shaftPositions[0].y, plan.shaftPositions[0].z), Material.SteelDriveShaft);
  assert.equal(legal.network.components.find((component) => component.role === 'connector').materialId,
    Material.SteelDriveShaft);
  assert.equal(legal.network.components.find((component) => component.role === 'connector').latestRepairEventId,
    'repair-steel-upgrade');
  assert.equal(legal.network.fault, null);
  assert.equal(legal.network.condition, 100);
  assert.equal(legal.network.serviceLoadedOperationCount, 0);
  assert.equal(legal.person.inventory.find((stack) => stack.materialId === Material.Seed).quantity, seedBeforeRepair);
  assert.equal(legal.person.inventory.find((stack) => stack.materialId === Material.Food).quantity, foodBeforeRepair);

  function makeOperationalState(shaftMaterialId) {
    const fixture = makeRepairState();
    const component = fixture.network.components.find((candidate) => candidate.role === 'connector');
    component.materialId = shaftMaterialId;
    component.latestRepairEventId = 'repair-baseline';
    component.latestRepairSourceEventIds = ['replacement-manufacture', 'replacement-verification'];
    fixture.network.fault = null;
    fixture.network.condition = 100;
    fixture.network.serviceLoadedOperationCount = 0;
    fixture.network.serviceCycleOperationEventIds = [];
    fixture.network.repairEventIds = ['repair-baseline'];
    setVoxel(fixture.state.world.grid,
      plan.shaftPositions[0].x, plan.shaftPositions[0].y, plan.shaftPositions[0].z, shaftMaterialId);
    fixture.person.position = { cellId: cellId(13, 9), z: 1 };
    fixture.person.inventory = [
      { id: 'service-seed', materialId: Material.Seed, quantity: 1, sourceEventIds: ['service-seed-source'] },
    ];
    fixture.person.knowledge.push({
      id: MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
      kind: 'technique', confidence: 90, learnedAtMonth: 11, sourceEventIds: ['learn-operation'],
    });
    return fixture;
  }
  const serviceAction = () => ({
    kind: 'act', operation: 'exert',
    targets: [
      { kind: 'inventory-stack', personId: 'maker', stackId: 'service-seed' },
      { kind: 'voxel', position: { ...plan.loadPosition } },
    ],
    mechanicalPowerBasis: {
      version: MECHANICAL_POWER_ACTION_BASIS_VERSION,
      mode: 'operate-service',
      sourceSegmentId: source.id,
      sourceKeys: [...source.sourceKeys],
      installationProjectId: plan.projectId,
      planKey,
      networkId,
      operationKnowledgeId: MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
      inputMaterialId: Material.Seed,
      outputMaterialId: Material.Food,
    },
  });
  const runServiceCycle = (shaftMaterialId, successfulLoadedOperations, idPrefix) => {
    const fixture = makeOperationalState(shaftMaterialId);
    const operations = [];
    for (let ordinal = 1; ordinal <= successfulLoadedOperations; ordinal += 1) {
      if (!fixture.person.inventory.some((stack) => stack.id === 'service-seed')) {
        fixture.person.inventory.push({
          id: 'service-seed', materialId: Material.Seed, quantity: 1,
          sourceEventIds: [`${idPrefix}-seed-${ordinal}`],
        });
      }
      const operation = executeMechanicalPowerAction(
        fixture.state, fixture.person, serviceAction(), 13, `${idPrefix}-loaded-${ordinal}`,
      );
      assert.equal(operation.status, 'completed');
      assert.equal(operation.diff.mechanicalPowerOperation, true);
      assert.equal(operation.diff.serviceLoadedOperationOrdinal, ordinal);
      appendCommittedEvents(fixture.state, [actionFact({
        id: `${idPrefix}-loaded-${ordinal}`,
        atMonth: 13,
        orderInMonth: ordinal,
        action: serviceAction(),
        diff: operation.diff,
        status: operation.status,
      })]);
      operations.push(operation);
    }
    fixture.person.inventory.push({
      id: 'service-seed', materialId: Material.Seed, quantity: 1,
      sourceEventIds: [`${idPrefix}-fault-attempt-seed`],
    });
    const seedBeforeFault = fixture.person.inventory.find((stack) => stack.id === 'service-seed').quantity;
    const fault = executeMechanicalPowerAction(
      fixture.state, fixture.person, serviceAction(), 14, `${idPrefix}-worn-fault`,
    );
    assert.equal(fault.status, 'completed');
    assert.equal(fault.diff.faultKind, 'worn-drive-shaft');
    assert.equal(fault.diff.serviceLoadedOperationCount, successfulLoadedOperations);
    assert.equal(fault.diff.inputPreserved, true);
    appendCommittedEvents(fixture.state, [actionFact({
      id: `${idPrefix}-worn-fault`,
      atMonth: 14,
      orderInMonth: 1,
      action: serviceAction(),
      diff: fault.diff,
      status: fault.status,
    })]);
    assert.equal(fixture.person.inventory.find((stack) => stack.id === 'service-seed').quantity, seedBeforeFault);
    assert.equal(fixture.person.inventory.find((stack) => stack.materialId === Material.Food).quantity,
      successfulLoadedOperations * 3);
    assert.equal(voxelAt(fixture.state.world.grid,
      plan.shaftPositions[0].x, plan.shaftPositions[0].y, plan.shaftPositions[0].z), Material.BrokenDriveShaft);
    assert.ok(fixture.network.serviceCycleOperationEventIds.every((eventId) => (
      fixture.state.world.past.some((event) => event.id === eventId
        && event.kind === 'action'
        && event.diff.mechanicalPowerOperation === true)
    )), '周期计数的每个负载 ID 都必须对应已提交 ActionFact');
    return { fixture, operations, fault };
  };

  const bronzeCycle = runServiceCycle(Material.DriveShaft, 3, 'bronze');
  const steelCycle = runServiceCycle(Material.SteelDriveShaft, 6, 'steel');
  const bronzeOperation = bronzeCycle.operations[0];
  const steelOperation = steelCycle.operations[0];
  assert.equal(bronzeOperation.diff.shaftMaterialId, Material.DriveShaft);
  assert.equal(steelOperation.diff.shaftMaterialId, Material.SteelDriveShaft);
  assert.equal(bronzeOperation.diff.wearApplied, MECHANICAL_POWER_OPERATION_WEAR);
  assert.equal(steelOperation.diff.wearApplied, MECHANICAL_POWER_STEEL_OPERATION_WEAR);
  assert.equal(steelOperation.diff.wearApplied * 2, bronzeOperation.diff.wearApplied);
  assert.equal(bronzeCycle.fixture.network.condition, 40);
  assert.equal(steelCycle.fixture.network.condition, 40);
  assert.equal(bronzeCycle.fixture.network.fault.failedComponentMaterialId, Material.DriveShaft);
  assert.equal(bronzeCycle.fixture.network.fault.serviceLoadedOperationCount, 3);
  assert.equal(steelOperation.diff.shaftInstallationEventId, 'install-bronze-shaft');
  assert.ok(steelOperation.diff.shaftInstallationSourceEventIds.includes('make-bronze-shaft'));
  assert.ok(steelOperation.diff.shaftRepairSourceEventIds.includes('replacement-manufacture'));

  const wornSteel = steelCycle.fixture;
  const wornFault = steelCycle.fault;
  assert.equal(wornFault.diff.shaftMaterialId, Material.SteelDriveShaft);
  assert.equal(wornFault.diff.shaftInstallationEventId, 'install-bronze-shaft');
  assert.equal(wornFault.diff.shaftRepairEventId, 'repair-baseline');
  assert.equal(wornSteel.network.fault.failedComponentMaterialId, Material.SteelDriveShaft);
  assert.equal(wornSteel.network.fault.failedComponentInstallationEventId, 'install-bronze-shaft');
  assert.equal(wornSteel.network.fault.failedComponentRepairEventId, 'repair-baseline');
  assert.equal(wornSteel.network.fault.serviceLoadedOperationCount, 6);
  assert.ok(wornSteel.network.fault.proofEventIds.length <= MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT);
  assert.deepEqual(wornSteel.network.fault.proofEventIds, wornFault.diff.faultProofEventIds);

  for (const shaftMaterialId of [Material.DriveShaft, Material.SteelDriveShaft]) {
    const topology = makeOperationalState(shaftMaterialId);
    assert.deepEqual(validateMechanicalPowerTopology(
      topology.state.world.grid, topology.state.world.mechanicalPower, plan,
    ), { valid: true });
  }
  const invalidTopology = makeOperationalState(Material.SteelDriveShaft);
  setVoxel(invalidTopology.state.world.grid,
    plan.shaftPositions[0].x, plan.shaftPositions[0].y, plan.shaftPositions[0].z, Material.Iron);
  assert.equal(validateMechanicalPowerTopology(
    invalidTopology.state.world.grid, invalidTopology.state.world.mechanicalPower, plan,
  ).reason, 'shaft-material-mismatch');

  assert.equal(mechanicalDriveShaftSpecification(Material.DriveShaft).wearPerLoadedOperation,
    MECHANICAL_POWER_OPERATION_WEAR);
  assert.equal(mechanicalDriveShaftSpecification(Material.SteelDriveShaft).wearPerLoadedOperation,
    MECHANICAL_POWER_STEEL_OPERATION_WEAR);
  assert.equal(mechanicalDriveShaftSpecification(Material.Iron), undefined);

  process.stdout.write('durable drive-shaft domain tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
