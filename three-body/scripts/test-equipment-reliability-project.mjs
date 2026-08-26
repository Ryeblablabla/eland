import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-equipment-reliability-'));
const bundlePath = path.join(temporaryDirectory, 'equipment-reliability.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export {
      mechanicalPowerMaintenanceCompletionEvidence,
      mechanicalPowerReliabilityMaterialRequirement,
      validateMechanicalReliabilityBasis,
    } from ${JSON.stringify(path.resolve('src/game/eland/application/mechanical-power-options.ts'))};
    export { buildProjectPressureBasis } from ${JSON.stringify(path.resolve('src/game/eland/application/project-pressure.ts'))};
    export {
      PROJECT_HYPOTHESIS_RESPONSE_BUDGET,
      refreshProjectHypothesisCampaign,
    } from ${JSON.stringify(path.resolve('src/game/eland/application/project-hypotheses.ts'))};
    export { appendCommittedEvents } from ${JSON.stringify(path.resolve('src/game/eland/domain/history.ts'))};
    export {
      MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
      MECHANICAL_POWER_PLAN_VERSION,
      MECHANICAL_POWER_WORLD_VERSION,
      createMechanicalPowerNetwork,
      mechanicalPowerNetworkId,
      mechanicalPowerPlanKey,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/mechanical-power.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { pendingProjectKnowledgeGap } from ${JSON.stringify(path.resolve('src/game/eland/domain/project-knowledge-request.ts'))};
    export { cellId, setVoxel } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=equipment-reliability-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
    MECHANICAL_POWER_PLAN_VERSION,
    MECHANICAL_POWER_WORLD_VERSION,
    Material,
    PROJECT_HYPOTHESIS_RESPONSE_BUDGET,
    appendCommittedEvents,
    buildProjectPressureBasis,
    cellId,
    createInitialState,
    createMechanicalPowerNetwork,
    mechanicalPowerMaintenanceCompletionEvidence,
    mechanicalPowerNetworkId,
    mechanicalPowerPlanKey,
    mechanicalPowerReliabilityMaterialRequirement,
    pendingProjectKnowledgeGap,
    refreshProjectHypothesisCampaign,
    setVoxel,
    validateMechanicalReliabilityBasis,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(4401, { endpoint: { kind: 'months', value: 240 }, chaosIntensity: 0 });
  state.clock.elapsedMonths = 10;
  state.world.past = [];
  state.world.historyCursor = { version: 1, eventCount: 0, hotStartIndex: 0, tailEventId: null };
  state.projects = [];
  const owner = state.people[0];
  const other = state.people[1];
  owner.inventory = [];
  owner.knowledge = [];

  const source = {
    id: 'current:reliability-fixture', kind: 'water-current-segment',
    from: { x: 20, y: 20, z: 1 }, to: { x: 20, y: 21, z: 1 },
    direction: { dx: 0, dy: 1, dz: 0 }, capacity: 1, upstreamSegmentIds: [],
    requiredWaterVoxels: [{ x: 20, y: 20, z: 1 }, { x: 20, y: 21, z: 1 }],
    sourceKeys: ['world-current:reliability-fixture'],
  };
  const plan = {
    version: MECHANICAL_POWER_PLAN_VERSION,
    projectId: 'fixture-installation-project', sourceSegmentId: source.id,
    wheelPosition: { x: 21, y: 20, z: 1 },
    shaftPositions: [{ x: 22, y: 20, z: 1 }],
    loadPosition: { x: 23, y: 20, z: 1 }, sourceKeys: [...source.sourceKeys],
  };
  const planKey = mechanicalPowerPlanKey(plan);
  const networkId = mechanicalPowerNetworkId(plan);
  const shaftPosition = plan.shaftPositions[0];
  const actionFact = (id, atMonth, orderInMonth, action, diff) => ({
    id, kind: 'action', actionTick: orderInMonth, atMonth, orderInMonth,
    cellId: cellId(22, 19), who: owner.id, cause: 'intent', action,
    fromCellId: cellId(22, 19), toCellId: cellId(22, 19),
    fromZ: 1, toZ: 1, pathSegment: [], status: 'completed', result: id, diff,
  });
  const attendFault = (id, faultEventId, atMonth) => actionFact(id, atMonth, 2, {
    kind: 'attend', target: { kind: 'voxel', position: { ...shaftPosition } },
    mechanicalPowerFaultObservation: {
      version: 'mechanical-power-fault-observation-v1', installationProjectId: plan.projectId,
      planKey, networkId, faultEventId,
    },
  }, { mechanicalPowerFaultDiagnosis: true, networkId, faultEventId });
  const loaded = (id, atMonth) => actionFact(id, atMonth, 1, {
    kind: 'act', operation: 'exert', targets: [],
  }, { mechanicalPowerOperation: true, networkId, shaftMaterialId: Material.DriveShaft });

  const installManufacture = actionFact('fixture-shaft-manufacture', 0, 1, {
    kind: 'act', operation: 'combine', targets: [],
  }, { outputMaterialId: Material.DriveShaft, outputStackId: 'fixture-installed-shaft' });
  const installVerification = actionFact('fixture-shaft-verification', 0, 2, {
    kind: 'attend', target: { kind: 'inventory-stack', personId: owner.id, stackId: 'fixture-installed-shaft' },
  }, {
    verifiedSourceEventId: installManufacture.id, verifiedStackId: 'fixture-installed-shaft',
    verifiedMaterialId: Material.DriveShaft,
  });
  const installSourceIds = [installManufacture.id, installVerification.id];
  const installation = actionFact('fixture-shaft-installation', 1, 1, {
    kind: 'act', operation: 'exert', targets: [],
  }, {
    mechanicalPowerInstallation: true, networkId, componentRole: 'connector',
    componentMaterialId: Material.DriveShaft, installationSourceEventIds: installSourceIds,
  });
  const firstLoads = [loaded('fixture-bronze-load-1', 2), loaded('fixture-bronze-load-2', 3), loaded('fixture-bronze-load-3', 4)];
  const firstFault = actionFact('fixture-worn-fault-1', 5, 1, {
    kind: 'act', operation: 'exert', targets: [],
  }, {
    mechanicalPowerFault: true, faultKind: 'worn-drive-shaft', networkId,
    componentPosition: { ...shaftPosition }, shaftMaterialId: Material.DriveShaft,
    shaftInstallationEventId: installation.id, shaftInstallationSourceEventIds: installSourceIds,
    serviceLoadedOperationCount: 3, faultProofEventIds: firstLoads.map((event) => event.id),
  });
  const firstDiagnosis = attendFault('fixture-worn-diagnosis-1', firstFault.id, 5);
  const bronzeManufacture = actionFact('fixture-bronze-shaft-2', 6, 1, {
    kind: 'act', operation: 'combine', targets: [],
  }, { outputMaterialId: Material.DriveShaft, outputStackId: 'fixture-bronze-shaft-2-stack' });
  const bronzeVerification = actionFact('fixture-bronze-shaft-2-verification', 6, 2, {
    kind: 'attend', target: { kind: 'inventory-stack', personId: owner.id, stackId: 'fixture-bronze-shaft-2-stack' },
  }, {
    verifiedSourceEventId: bronzeManufacture.id, verifiedStackId: 'fixture-bronze-shaft-2-stack',
    verifiedMaterialId: Material.DriveShaft,
  });
  const bronzeRepairSourceIds = [firstFault.id, bronzeManufacture.id, bronzeVerification.id];
  const bronzeRepair = actionFact('fixture-bronze-repair-1', 6, 3, {
    kind: 'act', operation: 'exert', targets: [],
  }, {
    mechanicalPowerRepair: true, networkId, faultEventId: firstFault.id,
    replacementMaterialId: Material.DriveShaft,
    replacementManufactureEventId: bronzeManufacture.id,
    replacementVerificationEventId: bronzeVerification.id,
    repairSourceEventIds: bronzeRepairSourceIds,
  });
  const secondLoads = [loaded('fixture-bronze-load-4', 7), loaded('fixture-bronze-load-5', 8), loaded('fixture-bronze-load-6', 9)];
  const secondFault = actionFact('fixture-worn-fault-2', 10, 1, {
    kind: 'act', operation: 'exert', targets: [],
  }, {
    mechanicalPowerFault: true, faultKind: 'worn-drive-shaft', networkId,
    componentPosition: { ...shaftPosition }, shaftMaterialId: Material.DriveShaft,
    shaftInstallationEventId: installation.id, shaftInstallationSourceEventIds: installSourceIds,
    shaftRepairEventId: bronzeRepair.id, shaftRepairSourceEventIds: bronzeRepairSourceIds,
    serviceLoadedOperationCount: 3, faultProofEventIds: secondLoads.map((event) => event.id),
  });
  const secondDiagnosis = attendFault('fixture-worn-diagnosis-2', secondFault.id, 10);
  appendCommittedEvents(state, [
    installManufacture, installVerification, installation,
    ...firstLoads, firstFault, firstDiagnosis, bronzeManufacture, bronzeVerification, bronzeRepair,
    ...secondLoads, secondFault, secondDiagnosis,
  ]);

  owner.knowledge.push(
    {
      id: MECHANICAL_POWER_OPERATION_TECHNIQUE_ID, kind: 'technique', summary: '负载作业',
      confidence: 90, learnedAtMonth: 2, sourceEventIds: [firstLoads[0].id],
    },
    ...[[firstFault, firstDiagnosis], [secondFault, secondDiagnosis]].map(([fault, diagnosis]) => ({
      id: `observation:mechanical-power-fault:${networkId}:${fault.id}`,
      kind: 'observation', summary: '本人诊断的轴故障', confidence: 90,
      learnedAtMonth: diagnosis.atMonth, sourceEventIds: [diagnosis.id],
    })),
  );

  const network = createMechanicalPowerNetwork(plan);
  network.components = [{
    role: 'connector', materialId: Material.DriveShaft, position: { ...shaftPosition },
    projectId: plan.projectId, installedAtMonth: 1,
    installationEventId: installation.id, sourceEventIds: [...installSourceIds],
    latestRepairEventId: bronzeRepair.id, latestRepairSourceEventIds: [...bronzeRepairSourceIds],
  }];
  network.operationEventIds = [...firstLoads, ...secondLoads].map((event) => event.id);
  network.faultEventIds = [firstFault.id, secondFault.id];
  network.repairEventIds = [bronzeRepair.id];
  network.condition = 40;
  network.serviceLoadedOperationCount = 3;
  network.serviceCycleOperationEventIds = secondLoads.map((event) => event.id);
  network.fault = {
    kind: 'worn-drive-shaft', componentRole: 'connector', componentPosition: { ...shaftPosition },
    atMonth: secondFault.atMonth, faultEventId: secondFault.id,
    sourceEventIds: secondLoads.map((event) => event.id),
    failedComponentMaterialId: Material.DriveShaft,
    failedComponentInstallationEventId: installation.id,
    failedComponentRepairEventId: bronzeRepair.id,
    serviceLoadedOperationCount: 3, proofEventIds: secondLoads.map((event) => event.id),
  };
  state.world.mechanicalPower = {
    version: MECHANICAL_POWER_WORLD_VERSION, sources: [source], networks: [network],
  };
  setVoxel(state.world.grid, source.from.x, source.from.y, source.from.z, Material.Water);
  setVoxel(state.world.grid, source.to.x, source.to.y, source.to.z, Material.Water);
  setVoxel(state.world.grid, plan.wheelPosition.x, plan.wheelPosition.y, plan.wheelPosition.z, Material.WaterWheel);
  setVoxel(state.world.grid, shaftPosition.x, shaftPosition.y, shaftPosition.z, Material.BrokenDriveShaft);
  setVoxel(state.world.grid, plan.loadPosition.x, plan.loadPosition.y, plan.loadPosition.z, Material.Mill);

  const installationProject = {
    id: plan.projectId, kind: 'production', need: 'mechanical-power-capability',
    desiredFunction: 'water-powered-crop-processing', summary: '既有水力网络', ownerId: owner.id,
    beneficiaryIds: [owner.id], triggerFactIds: [], pressure: 80, createdAtMonth: 1, reviewAtMonth: 2,
    status: 'completed', completedAtMonth: 2, lastProgressAtMonth: 2,
    missingMaterialIds: [], reservations: [], contributorIds: [owner.id], actionEventIds: [],
    failureEventIds: [], completionEventIds: [], logisticsEpisodes: [],
    mechanicalPowerPlan: structuredClone(plan), mechanicalPowerPlanKey: planKey, mechanicalPowerNetworkId: networkId,
  };
  state.projects = [installationProject];

  const faultBasis = (fault, diagnosis, loads, repair) => ({
    faultEventId: fault.id, diagnosisEventId: diagnosis.id, shaftMaterialId: Material.DriveShaft,
    shaftInstallationEventId: installation.id, shaftInstallationSourceEventIds: [...installSourceIds],
    ...(repair ? { shaftRepairEventId: repair.id } : {}),
    shaftRepairSourceEventIds: repair ? [...bronzeRepairSourceIds] : [],
    serviceLoadedOperationCount: 3, loadedOperationEventIds: loads.map((event) => event.id),
  });
  const faults = [
    faultBasis(firstFault, firstDiagnosis, firstLoads),
    faultBasis(secondFault, secondDiagnosis, secondLoads, bronzeRepair),
  ];
  const sourceFactIds = [...new Set(faults.flatMap((fault) => [
    fault.faultEventId, fault.diagnosisEventId, fault.shaftInstallationEventId,
    ...fault.shaftInstallationSourceEventIds,
    ...(fault.shaftRepairEventId ? [fault.shaftRepairEventId] : []),
    ...fault.shaftRepairSourceEventIds, ...fault.loadedOperationEventIds,
  ]))];
  const reliabilityBasis = {
    version: 'mechanical-reliability-basis-v1', observerId: owner.id, networkId,
    installationProjectId: installationProject.id, atMonth: 11, faults, sourceFactIds,
    basisKey: `mechanical-reliability-basis-v1|observer=${owner.id}|network=${networkId}|faults=${faults.map((fault) => fault.faultEventId).join(',')}`,
  };
  const pressureSubject = {
    need: 'equipment-reliability', desiredFunction: 'durable-power-transmission',
    beneficiaryIds: [owner.id], createdAtMonth: 11, mechanicalReliabilityBasis: reliabilityBasis,
  };
  const pressure = buildProjectPressureBasis(state, owner, pressureSubject, 11);
  assert.ok(pressure.pressure >= 42, '同一人物亲历并诊断同网两次不同磨损故障后才形成可靠性压力');
  assert.equal(buildProjectPressureBasis(state, owner, {
    ...pressureSubject,
    mechanicalReliabilityBasis: { ...reliabilityBasis, faults: [faults[1]] },
  }, 11).pressure, 0, '单次故障不能冒充反复服役故障');
  assert.equal(buildProjectPressureBasis(state, owner, {
    ...pressureSubject,
    mechanicalReliabilityBasis: { ...reliabilityBasis, faults: [faults[1], structuredClone(faults[1])] },
  }, 11).pressure, 0, '重复同一 action id 不能冒充两次故障');
  assert.equal(validateMechanicalReliabilityBasis(state, other, reliabilityBasis), false, '跨人物 basis 必须拒绝');
  assert.equal(validateMechanicalReliabilityBasis(state, owner, {
    ...reliabilityBasis, networkId: 'another-network',
  }), false, '跨网络 basis 必须拒绝');
  const forged = structuredClone(reliabilityBasis);
  forged.faults[0].loadedOperationEventIds = ['forged-loaded-operation'];
  assert.equal(validateMechanicalReliabilityBasis(state, owner, forged), false, '伪造负载来源必须拒绝');
  // This pre-proposal basis reaches into the previous repair cycle. Hot-history
  // trimming must remain disabled until those bounded ids have a network receipt
  // or an explicit retention lease; pinning only the current fault is insufficient.
  assert.ok(reliabilityBasis.sourceFactIds.includes(firstFault.id)
    && reliabilityBasis.sourceFactIds.includes(firstDiagnosis.id)
    && reliabilityBasis.sourceFactIds.includes(firstLoads[0].id));

  const reliabilityProject = {
    id: 'fixture-reliability-project', kind: 'inquiry', need: 'equipment-reliability',
    desiredFunction: 'durable-power-transmission', summary: '反复断轴后的材料可靠性试验', ownerId: owner.id,
    beneficiaryIds: [owner.id], triggerFactIds: [...pressure.sourceFactIds], pressure: pressure.pressure,
    pressureBasis: pressure, pressureHistory: [structuredClone(pressure)],
    createdAtMonth: 11, reviewAtMonth: 46, status: 'active', lastProgressAtMonth: 11,
    missingMaterialIds: [], materialDemands: [], reservations: [], contributorIds: [owner.id],
    actionEventIds: [], failureEventIds: [], completionEventIds: [], progressEvidence: [],
    searchCampaigns: [], logisticsEpisodes: [], mechanicalPowerPlan: structuredClone(plan),
    mechanicalPowerPlanKey: planKey, mechanicalPowerNetworkId: networkId,
    mechanicalPowerFaultEventId: secondFault.id, mechanicalReliabilityBasis: structuredClone(reliabilityBasis),
  };
  state.projects.push(reliabilityProject);
  assert.equal(pendingProjectKnowledgeGap(state, reliabilityProject), undefined,
    '未知耐久答案不能通过 project knowledge request 泄露');
  assert.deepEqual(mechanicalPowerReliabilityMaterialRequirement(state, owner, reliabilityProject).materialIds, [],
    '未知钢配方时项目不能请求 Steel、SteelCharge、SteelDriveShaft 或预置正确原料');
  owner.inventory = [Material.Iron, Material.Charcoal, Material.Plank].map((materialId) => ({
    id: `fixture-held-${materialId}`, materialId, quantity: 2, sourceEventIds: [`fixture-held-source-${materialId}`],
  }));
  const campaign = refreshProjectHypothesisCampaign(state.seed, 11, owner, reliabilityProject, [], {
    operation: 'combine-inventory', questionKind: 'connect-manipulator-shapes',
  });
  assert.equal(campaign.responseBudget, PROJECT_HYPOTHESIS_RESPONSE_BUDGET);
  assert.ok(campaign.candidates.length > 1);
  assert.ok(campaign.candidates.every((candidate) => !candidate.reasonKeys.includes('project-material-focus')),
    '未知可靠性试验不得获得隐藏正确配方 bonus');

  const manufacture = actionFact('fixture-steel-shaft-manufacture', 11, 1, {
    kind: 'act', operation: 'combine', targets: [],
  }, { outputMaterialId: Material.SteelDriveShaft, outputStackId: 'fixture-steel-shaft' });
  const verification = actionFact('fixture-steel-shaft-verification', 11, 2, {
    kind: 'attend', target: { kind: 'inventory-stack', personId: owner.id, stackId: 'fixture-steel-shaft' },
  }, {
    verifiedSourceEventId: manufacture.id, verifiedStackId: 'fixture-steel-shaft',
    verifiedMaterialId: Material.SteelDriveShaft,
  });
  const steelRepair = actionFact('fixture-steel-upgrade-repair', 12, 1, {
    kind: 'act', operation: 'exert', targets: [],
  }, {
    mechanicalPowerRepair: true, networkId, faultEventId: secondFault.id,
    replacementMaterialId: Material.SteelDriveShaft,
    replacementManufactureEventId: manufacture.id,
    replacementVerificationEventId: verification.id,
    repairSourceEventIds: [secondFault.id, manufacture.id, verification.id],
  });
  const recovery = (ordinal) => actionFact(`fixture-steel-loaded-${ordinal}`, 12 + ordinal, 1, {
    kind: 'act', operation: 'exert', targets: [],
  }, {
    mechanicalPowerOperation: true, mechanicalPowerRecovery: true, networkId,
    recoveryRepairEventId: steelRepair.id, shaftMaterialId: Material.SteelDriveShaft,
    shaftRepairEventId: steelRepair.id, wearApplied: 10, serviceLoadedOperationOrdinal: ordinal,
  });
  const recoveries = [1, 2, 3, 4].map(recovery);
  appendCommittedEvents(state, [manufacture, verification, steelRepair, ...recoveries.slice(0, 3)]);
  reliabilityProject.actionEventIds = [manufacture.id, verification.id, steelRepair.id, ...recoveries.slice(0, 3).map((event) => event.id)];
  network.fault = null;
  network.condition = 70;
  network.repairEventIds.push(steelRepair.id);
  network.operationEventIds.push(...recoveries.slice(0, 3).map((event) => event.id));
  network.components[0].materialId = Material.SteelDriveShaft;
  network.components[0].latestRepairEventId = steelRepair.id;
  network.components[0].latestRepairSourceEventIds = [manufacture.id, verification.id, secondFault.id];
  setVoxel(state.world.grid, shaftPosition.x, shaftPosition.y, shaftPosition.z, Material.SteelDriveShaft);
  assert.deepEqual(mechanicalPowerMaintenanceCompletionEvidence(state, reliabilityProject), [],
    '钢轴维修后三次带载仍不比既有青铜三次服役更长');
  steelRepair.diff.replacementMaterialId = Material.DriveShaft;
  assert.deepEqual(mechanicalPowerMaintenanceCompletionEvidence(state, reliabilityProject), [],
    '伪装成钢轴升级的普通青铜维修不得完成可靠性项目');
  steelRepair.diff.replacementMaterialId = Material.SteelDriveShaft;
  appendCommittedEvents(state, [recoveries[3]]);
  reliabilityProject.actionEventIds.push(recoveries[3].id);
  network.operationEventIds.push(recoveries[3].id);
  network.condition = 60;
  const completion = mechanicalPowerMaintenanceCompletionEvidence(state, reliabilityProject);
  assert.ok(completion.includes(steelRepair.id) && completion.includes(recoveries[3].id),
    '完成必须包含真实钢轴升级维修和规定的第四次带载动作');

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1024 * 1024, `fixture RSS ${rssBytes} 超过 256 MiB`);
  process.stdout.write(`${JSON.stringify({ result: 'passed', rssBytes })}\n`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
