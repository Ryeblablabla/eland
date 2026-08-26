import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-natural-electrical-project-'));
const bundlePath = path.join(temporaryDirectory, 'natural-electrical-project.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/simulation.ts'))};
    export { addInventory, executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { appendCommittedEvents } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/history.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export {
      MECHANICAL_POWER_ACTION_BASIS_VERSION,
      MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
      MECHANICAL_POWER_PLAN_VERSION,
      MECHANICAL_POWER_WORLD_VERSION,
      createMechanicalPowerNetwork,
      mechanicalPowerNetworkId,
      mechanicalPowerPlanKey,
      recordMechanicalPowerInstallation,
      recordMechanicalPowerRepair,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/mechanical-power.ts'))};
    export {
      plannedElectricalPowerComponents,
      validateElectricalPowerTopology,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/electrical-power.ts'))};
    export {
      hasReliableElectricalComponentKnowledge,
      remoteWorkPowerTransmissionBasisFor,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/electrical-power-options.ts'))};
    export { deriveProjectProposals } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-proposals.ts'))};
    export { compileProjectStep } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-step-compiler.ts'))};
    export {
      projectCompletionEvidence,
      projectFunctionSatisfied,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-completion.ts'))};
    export {
      recordProjectAction,
      synchronizeProject,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
    export { cellId, cellsInRadius, setVoxel, voxelAt } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=natural-electrical-project-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    MECHANICAL_POWER_ACTION_BASIS_VERSION,
    MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
    MECHANICAL_POWER_PLAN_VERSION,
    MECHANICAL_POWER_WORLD_VERSION,
    Material,
    addInventory,
    appendCommittedEvents,
    cellId,
    cellsInRadius,
    compileProjectStep,
    createInitialState,
    createMechanicalPowerNetwork,
    deriveProjectProposals,
    executePrimitiveAction,
    hasReliableElectricalComponentKnowledge,
    instantiateProject,
    mechanicalPowerNetworkId,
    mechanicalPowerPlanKey,
    plannedElectricalPowerComponents,
    projectCompletionEvidence,
    projectFunctionSatisfied,
    recordMechanicalPowerInstallation,
    recordMechanicalPowerRepair,
    recordProjectAction,
    remoteWorkPowerTransmissionBasisFor,
    setVoxel,
    synchronizeProject,
    validateElectricalPowerTopology,
    voxelAt,
  } = api;

  const state = createInitialState(560051, {
    endpoint: { kind: 'months', value: 240 },
    chaosIntensity: 0,
  });
  const actor = state.people[0];
  actor.inventory = [];
  actor.knowledge = [];
  actor.memories = [];
  actor.baselineCapacities.perception = 100;
  for (const other of state.people.slice(1)) {
    other.position.cellId = cellId(70, 45);
    other.position.z = 1;
  }

  for (let x = 9; x <= 19; x += 1) {
    for (let y = 8; y <= 12; y += 1) {
      setVoxel(state.world.grid, x, y, 0, Material.Stone);
      setVoxel(state.world.grid, x, y, 1, Material.Air);
      setVoxel(state.world.grid, x, y, 2, Material.Air);
    }
  }
  const source = {
    id: 'current:natural-electrical',
    kind: 'water-current-segment',
    from: { x: 10, y: 10, z: 1 },
    to: { x: 10, y: 11, z: 1 },
    direction: { dx: 0, dy: 1, dz: 0 },
    capacity: 1,
    upstreamSegmentIds: [],
    requiredWaterVoxels: [{ x: 10, y: 10, z: 1 }, { x: 10, y: 11, z: 1 }],
    sourceKeys: ['world-current:natural-electrical', 'position:10:10:1'],
  };
  const mechanicalPlan = {
    version: MECHANICAL_POWER_PLAN_VERSION,
    projectId: 'mechanical-installation-natural-electrical',
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
  recordMechanicalPowerRepair(mechanicalNetwork, 'commissioned-repair', [
    'make-steel-shaft',
    'verify-steel-shaft',
  ], {
    componentPosition: { ...mechanicalPlan.shaftPositions[0] },
    replacementMaterialId: Material.SteelDriveShaft,
    manufactureEventId: 'make-steel-shaft',
    verificationEventId: 'verify-steel-shaft',
  });
  state.world.mechanicalPower = {
    version: MECHANICAL_POWER_WORLD_VERSION,
    sources: [source],
    networks: [mechanicalNetwork],
  };
  appendCommittedEvents(state, [{
    id: 'commissioned-repair', kind: 'action', actionTick: 1,
    planningTick: 1, orderInTick: 0, atMonth: 0, orderInMonth: 0,
    cellId: cellId(12, 10), who: actor.id, cause: 'intent',
    action: { kind: 'act', operation: 'exert', targets: [] },
    fromCellId: cellId(12, 10), toCellId: cellId(12, 10),
    fromZ: 1, toZ: 1, pathSegment: [cellId(12, 10)],
    status: 'completed', result: '投产前完成钢制传动轴检修',
    diff: {
      mechanicalPowerRepair: true,
      networkId: mechanicalNetworkId,
      replacementMaterialId: Material.SteelDriveShaft,
      repairSourceEventIds: ['make-steel-shaft', 'verify-steel-shaft'],
      replacementManufactureEventId: 'make-steel-shaft',
      replacementVerificationEventId: 'verify-steel-shaft',
    },
  }]);
  state.projects.push({
    id: mechanicalPlan.projectId,
    kind: 'construction', need: 'mechanical-power-capability',
    desiredFunction: 'water-powered-crop-processing', summary: '已投产水力磨坊',
    ownerId: actor.id, beneficiaryIds: [actor.id], contributorIds: [actor.id],
    triggerFactIds: [], pressure: 80, createdAtMonth: 0, reviewAtMonth: 1,
    status: 'completed', lastProgressAtMonth: 0, completedAtMonth: 0,
    mechanicalPowerPlan: mechanicalPlan,
    mechanicalPowerPlanKey: mechanicalPlanKey,
    mechanicalPowerNetworkId: mechanicalNetworkId,
    missingMaterialIds: [], materialDemands: [], reservations: [],
    actionEventIds: [], failureEventIds: [], completionEventIds: [],
  });
  actor.knowledge.push({
    id: MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
    kind: 'technique', summary: '本人会操作已投产水力磨坊', confidence: 68,
    learnedAtMonth: 0, sourceEventIds: ['commissioned-repair'],
  });
  actor.position = {
    ...actor.position,
    cellId: cellId(13, 9), z: 1, previousCellId: cellId(13, 9), previousZ: 1,
    lastPath: [], tickPath: [cellId(13, 9)],
  };
  const installedProject = state.projects.find((candidate) => candidate.id === mechanicalPlan.projectId);
  assert.equal(installedProject?.status, 'completed');
  assert.equal(installedProject?.desiredFunction, 'water-powered-crop-processing');
  assert.equal(installedProject?.mechanicalPowerPlan?.version, MECHANICAL_POWER_PLAN_VERSION);
  assert.equal(installedProject?.mechanicalPowerPlan?.projectId, installedProject?.id);
  assert.equal(installedProject?.mechanicalPowerPlanKey, mechanicalPowerPlanKey(installedProject.mechanicalPowerPlan));
  assert.equal(installedProject?.mechanicalPowerNetworkId, mechanicalNetworkId);
  assert.equal(installedProject?.mechanicalPowerPlan?.sourceSegmentId, source.id);

  let nextMonth = 1;
  const committed = [];
  const commit = (action, allowed = ['completed']) => {
    const atMonth = nextMonth;
    state.clock.elapsedMonths = atMonth - 1;
    const fact = executePrimitiveAction(state, actor, action, atMonth, 0, {
      cause: 'intent', actionTick: 1,
    });
    assert.ok(allowed.includes(fact.status), fact.result);
    appendCommittedEvents(state, [fact]);
    committed.push(fact);
    nextMonth += 1;
    state.clock.elapsedMonths = atMonth;
    return fact;
  };
  const serviceAction = (seedStackId) => ({
    kind: 'act', operation: 'exert',
    targets: [
      { kind: 'inventory-stack', personId: actor.id, stackId: seedStackId },
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
  });
  const travel = (destinationCellId) => {
    const facts = [];
    for (let attempt = 0; attempt < 12 && actor.position.cellId !== destinationCellId; attempt += 1) {
      facts.push(commit({ kind: 'move', toCellId: destinationCellId, toZ: 1 }, ['completed', 'progressed']));
    }
    assert.equal(actor.position.cellId, destinationCellId);
    return facts;
  };
  const transferStone = () => commit({
    kind: 'transfer', materialId: Material.Stone, quantity: 1,
    from: { kind: 'person', personId: actor.id },
    to: { kind: 'ground', cellId: actor.position.cellId, z: actor.position.z },
    stackId: 'carried-work-stone',
  });

  addInventory(actor, Material.Seed, 1, ['seed-source-1'], 'service-seed-1');
  addInventory(actor, Material.Stone, 2, ['carried-load-source'], 'carried-work-stone');
  const service1 = commit(serviceAction('service-seed-1'));
  const outbound1 = travel(cellId(17, 9));
  const remoteWork1 = transferStone();
  const returnTrip = travel(cellId(13, 9));
  addInventory(actor, Material.Seed, 1, ['seed-source-2'], 'service-seed-2');
  const service2 = commit(serviceAction('service-seed-2'));
  const outbound2 = travel(cellId(17, 9));
  const remoteWork2 = transferStone();
  const routeFacts = [service1, ...outbound1, remoteWork1, ...returnTrip, service2, ...outbound2, remoteWork2];
  actor.memories = routeFacts.map((fact, index) => ({
    id: `memory:remote-work-power:${index}`,
    kind: 'episode', summary: '本人在水力工位与远端固定工位之间搬运往返',
    importance: 88, createdAtMonth: fact.atMonth, lastRecalledAtMonth: fact.atMonth,
    personIds: [], sourceEventIds: [fact.id],
  }));
  const operationKnowledge = actor.knowledge.find((fact) => fact.id === MECHANICAL_POWER_OPERATION_TECHNIQUE_ID);
  operationKnowledge.sourceEventIds = [service1.id, service2.id];
  state.projects[0].actionEventIds = [service1.id, service2.id];

  const visibleCells = cellsInRadius(actor.position.cellId, 8);
  const remoteProposal = (candidateState, candidateActor) => deriveProjectProposals(
    candidateState,
    candidateActor,
    cellsInRadius(candidateActor.position.cellId, 8),
    candidateState.world.drops.filter((drop) => cellsInRadius(candidateActor.position.cellId, 8).includes(drop.cellId)),
    [],
  ).find((candidate) => candidate.desiredFunction === 'remote-work-power-delivery');
  const basis = remoteWorkPowerTransmissionBasisFor(state, actor, state.clock.elapsedMonths + 1);
  assert.ok(basis);
  assert.equal(basis.sourceFactIds.length, 7);
  assert.deepEqual(basis.sourceFactIds, [...basis.sourceFactIds].sort((left, right) => {
    const l = committed.find((fact) => fact.id === left);
    const r = committed.find((fact) => fact.id === right);
    return l.atMonth - r.atMonth;
  }), '压力依据必须保留七条最小证据的时间顺序');

  const noMemoryState = structuredClone(state);
  const noMemoryActor = noMemoryState.people.find((person) => person.id === actor.id);
  noMemoryActor.memories = [];
  assert.equal(remoteProposal(noMemoryState, noMemoryActor), undefined);

  const noBurdenState = structuredClone(state);
  const noBurdenActor = noBurdenState.people.find((person) => person.id === actor.id);
  noBurdenActor.memories = noBurdenActor.memories.filter((memory) => (
    memory.sourceEventIds.every((eventId) => eventId === service1.id || eventId === service2.id)
  ));
  assert.equal(remoteProposal(noBurdenState, noBurdenActor), undefined);

  const forgedState = structuredClone(state);
  const forgedActor = forgedState.people.find((person) => person.id === actor.id);
  const forgedService = structuredClone(service2);
  forgedService.id = 'forged-mechanical-service';
  forgedService.diff.networkId = 'forged-network';
  appendCommittedEvents(forgedState, [forgedService]);
  forgedActor.memories = forgedActor.memories.map((memory) => ({
    ...memory,
    sourceEventIds: memory.sourceEventIds.map((eventId) => eventId === service2.id ? forgedService.id : eventId),
  }));
  forgedActor.knowledge.find((fact) => fact.id === MECHANICAL_POWER_OPERATION_TECHNIQUE_ID).sourceEventIds = [
    service1.id, forgedService.id,
  ];
  assert.equal(remoteProposal(forgedState, forgedActor), undefined);

  const proposal = remoteProposal(state, actor);
  assert.ok(proposal);
  assert.ok(proposal.pressure >= 42);
  assert.equal(proposal.electricalPowerPlan, undefined, '提案阶段不能预知电气拓扑');
  assert.equal(JSON.stringify(proposal).includes('MechanicalDynamo'), false);
  assert.equal(JSON.stringify(proposal).includes('CopperConductor'), false);
  assert.equal(JSON.stringify(proposal).includes('ResistiveLoad'), false);
  const project = instantiateProject(proposal);
  state.projects.push(project);
  actor.inventory = [];
  assert.equal(hasReliableElectricalComponentKnowledge(state, actor), false);

  const commitProjectStep = (step, allowed = ['completed']) => {
    const fact = commit(step.action, allowed);
    recordProjectAction(state, project.id, fact);
    return fact;
  };
  const discover = (leftMaterialId, rightMaterialId, expectedOutputMaterialId, ordinal) => {
    addInventory(actor, leftMaterialId, 1, [`blind-source-${ordinal}-left`], `blind-${ordinal}-left`);
    addInventory(actor, rightMaterialId, 1, [`blind-source-${ordinal}-right`], `blind-${ordinal}-right`);
    const step = compileProjectStep(state, actor, [], project);
    assert.ok(step);
    assert.equal(step.action.kind, 'act');
    assert.equal(step.action.operation, 'combine');
    const candidate = project.hypothesisCampaign.candidates.find((item) => (
      item.key === project.hypothesisCampaign.activeCandidateKey
    ));
    assert.ok(candidate);
    assert.equal(candidate.reasonKeys.includes('project-material-focus'), false,
      '电能项目的未知候选不能得到目标配方奖励');
    assert.deepEqual([...candidate.materialIds].sort((a, b) => a - b),
      [leftMaterialId, rightMaterialId].sort((a, b) => a - b));
    const response = commitProjectStep(step);
    assert.equal(Number(response.diff.outputMaterialId), expectedOutputMaterialId);
    const verification = compileProjectStep(state, actor, [], project);
    assert.ok(verification?.action.kind === 'attend');
    const verified = commitProjectStep(verification);
    assert.equal(verified.diff.verifiedTechnique, true);
    return { response, verified };
  };

  const generatorDiscovery = discover(
    Material.DriveShaft, Material.Copper, Material.MechanicalDynamo, 1,
  );
  assert.equal(hasReliableElectricalComponentKnowledge(state, actor), false);
  const conductorDiscovery = discover(Material.Copper, Material.Rope, Material.CopperConductor, 2);
  const loadDiscovery = discover(Material.Copper, Material.FiredBrick, Material.ResistiveLoad, 3);
  assert.equal(hasReliableElectricalComponentKnowledge(state, actor), true);
  assert.equal(project.hypothesisCampaign.attempts.filter((attempt) => attempt.outcome === 'response').length, 3);
  assert.ok(generatorDiscovery.response && conductorDiscovery.verified && loadDiscovery.verified);

  addInventory(actor, Material.Copper, 2, ['additional-copper'], 'additional-copper');
  addInventory(actor, Material.Rope, 2, ['additional-rope'], 'additional-rope');
  let operateStep;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const step = compileProjectStep(state, actor, [], project);
    assert.ok(step, `实体安装链在第 ${iteration} 步意外停滞`);
    if (step.action.kind === 'act' && step.action.electricalPowerBasis?.mode === 'operate') {
      operateStep = step;
      break;
    }
    commitProjectStep(step, ['completed', 'progressed']);
  }
  assert.ok(operateStep);
  assert.ok(project.electricalPowerPlan);
  const electricalNetwork = state.world.electricalPower?.networks.find((network) => (
    network.id === project.electricalPowerNetworkId
  ));
  assert.ok(electricalNetwork);
  assert.deepEqual(validateElectricalPowerTopology(state.world.grid, electricalNetwork), { valid: true });
  assert.equal(electricalNetwork.components.length, plannedElectricalPowerComponents(project.electricalPowerPlan).length);

  const brokenPosition = project.electricalPowerPlan.conductorPositions[0];
  setVoxel(state.world.grid, brokenPosition.x, brokenPosition.y, brokenPosition.z, Material.Air);
  const conditionBeforeBlockedOperation = mechanicalNetwork.condition;
  const blockedDelivery = commitProjectStep(operateStep, ['blocked']);
  assert.equal(blockedDelivery.diff.topologyReason, 'conductor-material-mismatch');
  assert.equal(projectFunctionSatisfied(state, project), false);
  assert.equal(mechanicalNetwork.condition, conditionBeforeBlockedOperation);
  setVoxel(state.world.grid, brokenPosition.x, brokenPosition.y, brokenPosition.z, Material.CopperConductor);
  assert.equal(voxelAt(state.world.grid, brokenPosition.x, brokenPosition.y, brokenPosition.z), Material.CopperConductor);

  const validOperateStep = compileProjectStep(state, actor, [], project);
  assert.ok(validOperateStep?.action.kind === 'act'
    && validOperateStep.action.electricalPowerBasis?.mode === 'operate');
  const delivery = commitProjectStep(validOperateStep);
  assert.equal(delivery.diff.electricalPowerDelivered, true);
  assert.equal(projectFunctionSatisfied(state, project), true);
  const completionEvidence = projectCompletionEvidence(state, project);
  assert.ok(completionEvidence.includes(delivery.id));
  assert.equal(completionEvidence.includes(blockedDelivery.id), false);
  assert.ok(completionEvidence.length <= 62, '完成证据必须保持固定上限');
  synchronizeProject(state, project, delivery.atMonth);
  assert.equal(project.status, 'completed');

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1024 * 1024, `fixture RSS ${(rssBytes / 1024 / 1024).toFixed(1)} MiB 超限`);
  console.log(JSON.stringify({
    ok: true,
    routeEvidenceCount: basis.sourceFactIds.length,
    blindResponses: project.hypothesisCampaign.attempts.filter((attempt) => attempt.outcome === 'response').length,
    installedComponents: electricalNetwork.components.length,
    deliveredPowerUnits: delivery.diff.powerDeliveredUnits,
    completionEvidenceCount: completionEvidence.length,
    rssBytes,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
