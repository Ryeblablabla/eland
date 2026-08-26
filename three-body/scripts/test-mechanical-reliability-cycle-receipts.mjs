import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-reliability-receipts-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'bundle.mjs');
const authority = { stateHash: 'c'.repeat(64) };

function actionFact(id, atMonth, orderInMonth, who, action, diff) {
  return {
    id, kind: 'action', atMonth, orderInMonth, planningTick: 1, orderInTick: orderInMonth,
    actionTick: 1, who, cause: 'intent', action,
    fromCellId: 0, toCellId: 0, fromZ: 1, toZ: 1, pathSegment: [],
    status: 'completed', result: id, diff,
  };
}

try {
  const mechanicalPowerPath = path.resolve('src/game/eland/domain/mechanical-power.ts');
  const materialPath = path.resolve('src/game/eland/domain/material.ts');
  const optionsPath = path.resolve('src/game/eland/application/mechanical-power-options.ts');
  const retentionPath = path.resolve('server/history-retention-projection.ts');
  writeFileSync(entryPath, [
    `export { Material } from ${JSON.stringify(materialPath)};`,
    `export { createMechanicalPowerNetwork, mechanicalPowerPlanKey,`,
    `  recordMechanicalPowerInstallation, recordMechanicalPowerOperation,`,
    `  recordMechanicalPowerFault, recordMechanicalPowerRepair,`,
    `  validatedMechanicalPowerReliabilityCycleReceipts } from ${JSON.stringify(mechanicalPowerPath)};`,
    `export { mechanicalPowerReliabilityBasisForNetwork } from ${JSON.stringify(optionsPath)};`,
    `export { beginHistoryRetentionProjection, foldHistoryRetentionSegment,`,
    `  finishHistoryRetentionProjection } from ${JSON.stringify(retentionPath)};`,
  ].join('\n'));
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entryPath, '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' }, stdio: 'pipe' });
  const subject = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
  const {
    Material,
    createMechanicalPowerNetwork,
    mechanicalPowerPlanKey,
    recordMechanicalPowerInstallation,
    recordMechanicalPowerOperation,
    recordMechanicalPowerFault,
    recordMechanicalPowerRepair,
    validatedMechanicalPowerReliabilityCycleReceipts,
    mechanicalPowerReliabilityBasisForNetwork,
    beginHistoryRetentionProjection,
    foldHistoryRetentionSegment,
    finishHistoryRetentionProjection,
  } = subject;

  const operatorId = 'operator';
  const installationProjectId = 'installation-project';
  const plan = {
    version: 'mechanical-power-plan-v1', projectId: installationProjectId,
    sourceSegmentId: 'stream', wheelPosition: { x: 1, y: 1, z: 1 },
    shaftPositions: [{ x: 2, y: 1, z: 1 }], loadPosition: { x: 3, y: 1, z: 1 },
    sourceKeys: ['stream-source'],
  };
  const planKey = mechanicalPowerPlanKey(plan);
  const network = createMechanicalPowerNetwork(plan);
  recordMechanicalPowerInstallation(network, {
    role: 'connector', materialId: Material.DriveShaft, position: { ...plan.shaftPositions[0] },
    projectId: installationProjectId, installedAtMonth: 1,
    installationEventId: 'install-shaft', sourceEventIds: ['make-shaft', 'verify-shaft'],
  });

  const events = [
    actionFact('make-shaft', 1, 0, operatorId,
      { kind: 'act', operation: 'combine', targets: [] },
      { outputMaterialId: Material.DriveShaft }),
    actionFact('verify-shaft', 1, 1, operatorId,
      { kind: 'attend', target: { kind: 'inventory-stack', personId: operatorId, stackId: 'shaft' } },
      { verifiedSourceEventId: 'make-shaft', verifiedMaterialId: Material.DriveShaft }),
    actionFact('install-shaft', 1, 2, operatorId,
      { kind: 'act', operation: 'exert', targets: [] }, {
        mechanicalPowerInstallation: true, projectId: installationProjectId,
        networkId: network.id, componentRole: 'connector', componentMaterialId: Material.DriveShaft,
        installationSourceEventIds: ['make-shaft', 'verify-shaft'],
      }),
  ];

  function loadedOperation(cycle, ordinal, month) {
    const id = `load-${cycle}-${ordinal}`;
    recordMechanicalPowerOperation(network, id, Material.DriveShaft);
    events.push(actionFact(id, month, ordinal - 1, operatorId,
      { kind: 'act', operation: 'exert', targets: [] }, {
        mechanicalPowerOperation: true, installationProjectId,
        networkId: network.id, shaftMaterialId: Material.DriveShaft,
      }));
    return id;
  }

  function wornFault(cycle, month) {
    const faultEventId = `fault-${cycle}`;
    const faultSourceEventIds = network.serviceCycleOperationEventIds.slice(-3);
    recordMechanicalPowerFault(network, {
      kind: 'worn-drive-shaft', componentRole: 'connector',
      componentPosition: { ...plan.shaftPositions[0] }, atMonth: month,
      faultEventId, sourceEventIds: faultSourceEventIds,
      failedComponentMaterialId: Material.DriveShaft,
      failedComponentInstallationEventId: 'install-shaft',
      ...(network.components[0].latestRepairEventId
        ? { failedComponentRepairEventId: network.components[0].latestRepairEventId } : {}),
      serviceLoadedOperationCount: network.serviceLoadedOperationCount,
    }, operatorId);
    const receipt = network.reliabilityCycleReceipts.at(-1);
    events.push(actionFact(faultEventId, month, 3, operatorId,
      { kind: 'act', operation: 'exert', targets: [] }, {
        mechanicalPowerFault: true, faultKind: 'worn-drive-shaft', faultEventId,
        installationProjectId, networkId: network.id, shaftMaterialId: Material.DriveShaft,
        wearSourceEventIds: [...receipt.faultSourceEventIds],
        shaftInstallationEventId: receipt.shaftInstallationEventId,
        shaftInstallationSourceEventIds: [...receipt.shaftInstallationSourceEventIds],
        ...(receipt.shaftRepairEventId ? { shaftRepairEventId: receipt.shaftRepairEventId } : {}),
        ...(receipt.shaftRepairSourceEventIds.length ? {
          shaftRepairSourceEventIds: [...receipt.shaftRepairSourceEventIds],
        } : {}),
        serviceLoadedOperationCount: receipt.serviceLoadedOperationCount,
        faultProofEventIds: [...network.fault.proofEventIds],
      }));
    const diagnosisId = `diagnosis-${cycle}`;
    events.push(actionFact(diagnosisId, month, 4, operatorId, {
      kind: 'attend', target: { kind: 'voxel', position: { ...plan.shaftPositions[0] } },
      mechanicalPowerFaultObservation: {
        version: 'mechanical-power-fault-observation-v1', installationProjectId,
        planKey, networkId: network.id, faultEventId,
      },
    }, { mechanicalPowerFaultDiagnosis: true, faultEventId }));
    return { faultEventId, diagnosisId };
  }

  function repair(cycle, month, faultEventId) {
    const manufactureEventId = `make-replacement-${cycle}`;
    const verificationEventId = `verify-replacement-${cycle}`;
    const repairEventId = `repair-${cycle}`;
    events.push(
      actionFact(manufactureEventId, month, 0, operatorId,
        { kind: 'act', operation: 'combine', targets: [] },
        { outputMaterialId: Material.DriveShaft }),
      actionFact(verificationEventId, month, 1, operatorId,
        { kind: 'attend', target: { kind: 'inventory-stack', personId: operatorId, stackId: cycle } },
        { verifiedSourceEventId: manufactureEventId, verifiedMaterialId: Material.DriveShaft }),
    );
    const repairSourceEventIds = [faultEventId, manufactureEventId, verificationEventId];
    recordMechanicalPowerRepair(network, repairEventId, repairSourceEventIds, {
      componentPosition: { ...plan.shaftPositions[0] }, replacementMaterialId: Material.DriveShaft,
      manufactureEventId, verificationEventId,
    });
    events.push(actionFact(repairEventId, month, 2, operatorId,
      { kind: 'act', operation: 'exert', targets: [] }, {
        mechanicalPowerRepair: true, networkId: network.id,
        replacementMaterialId: Material.DriveShaft, repairSourceEventIds,
        replacementManufactureEventId: manufactureEventId,
        replacementVerificationEventId: verificationEventId,
      }));
  }

  loadedOperation('one', 1, 2);
  loadedOperation('one', 2, 2);
  loadedOperation('one', 3, 2);
  const first = wornFault('one', 3);
  repair('one', 4, first.faultEventId);
  loadedOperation('two', 1, 5);
  loadedOperation('two', 2, 5);
  loadedOperation('two', 3, 5);
  const second = wornFault('two', 6);

  const person = {
    id: operatorId, bornAtMonth: 0,
    body: { health: 80, hydration: 80, nutrition: 80 }, inventory: [],
    knowledge: [{
      id: `observation:mechanical-power-fault:${network.id}:${first.faultEventId}`,
      kind: 'observation', confidence: 68, sourceEventIds: [first.faultEventId, first.diagnosisId],
    }, {
      id: `observation:mechanical-power-fault:${network.id}:${second.faultEventId}`,
      kind: 'observation', confidence: 68, sourceEventIds: [second.faultEventId, second.diagnosisId],
    }],
  };
  const installationProject = {
    id: installationProjectId, ownerId: operatorId, status: 'completed',
    desiredFunction: 'water-powered-crop-processing', triggerFactIds: [], actionEventIds: [], reservations: [],
    mechanicalPowerPlan: plan, mechanicalPowerPlanKey: planKey, mechanicalPowerNetworkId: network.id,
  };
  const state = {
    clock: { elapsedMonths: 6 }, people: [person], projects: [installationProject],
    intents: [], agreements: [], eraPredictions: [],
    world: {
      past: events,
      historyCursor: { version: 1, eventCount: events.length, hotStartIndex: 0, tailEventId: events.at(-1).id },
      mechanicalPower: { version: 'mechanical-power-world-v1', sources: [], networks: [network] },
    },
  };

  const basis = mechanicalPowerReliabilityBasisForNetwork(state, person, network, installationProject, 7);
  assert.ok(basis, '同一人亲历并诊断的两个精确青铜磨损周期应形成可靠性依据');
  assert.deepEqual(basis.faults.map((fault) => fault.faultEventId), ['fault-one', 'fault-two']);

  const otherPerson = structuredClone(person);
  otherPerson.id = 'other-person';
  assert.equal(
    mechanicalPowerReliabilityBasisForNetwork(state, otherPerson, network, installationProject, 7),
    null,
    '不得借用另一位操作者的周期收据或诊断',
  );
  const oldNetwork = structuredClone(network);
  delete oldNetwork.reliabilityCycleReceipts;
  assert.equal(
    mechanicalPowerReliabilityBasisForNetwork(state, person, oldNetwork, installationProject, 7),
    null,
    '旧 state 没有收据时只能不形成可靠性项目，不能扫描累计 faultEventIds 猜测',
  );
  const forgedNetwork = structuredClone(network);
  forgedNetwork.reliabilityCycleReceipts[1].loadedOperationEventIds[2] = 'forged-load';
  assert.equal(
    mechanicalPowerReliabilityBasisForNetwork(state, person, forgedNetwork, installationProject, 7),
    null,
    '收据里的伪造精确 ID 必须被真实 ActionFact 回查拒绝',
  );
  const crossNetwork = structuredClone(network);
  crossNetwork.reliabilityCycleReceipts[0].networkId = 'another-network';
  assert.equal(validatedMechanicalPowerReliabilityCycleReceipts(crossNetwork), null, '跨网络收据必须拒绝');
  const duplicateReceipt = structuredClone(network);
  duplicateReceipt.reliabilityCycleReceipts[1] = structuredClone(duplicateReceipt.reliabilityCycleReceipts[0]);
  assert.equal(validatedMechanicalPowerReliabilityCycleReceipts(duplicateReceipt), null, '重复 fault receipt 必须拒绝');
  const oversizedReceipt = structuredClone(network);
  oversizedReceipt.reliabilityCycleReceipts[0].loadedOperationEventIds.push('over-limit');
  assert.equal(validatedMechanicalPowerReliabilityCycleReceipts(oversizedReceipt), null, '超界收据不得截断');
  const incompleteReceipt = structuredClone(network);
  delete incompleteReceipt.reliabilityCycleReceipts[0].shaftInstallationSourceEventIds;
  assert.equal(validatedMechanicalPowerReliabilityCycleReceipts(incompleteReceipt), null, '缺字段收据必须拒绝');

  const retentionShell = structuredClone(state);
  retentionShell.world.past = [];
  retentionShell.world.historyCursor = {
    version: 1, eventCount: events.length, hotStartIndex: events.length, tailEventId: events.at(-1).id,
  };
  const fold = beginHistoryRetentionProjection(retentionShell, authority);
  foldHistoryRetentionSegment(fold, events, 0);
  const projection = finishHistoryRetentionProjection(fold);
  const pins = new Map(projection.pins.map((pin) => [pin.eventId, pin]));
  for (const receipt of network.reliabilityCycleReceipts) {
    const base = `mechanical-network:${network.id}:reliability-cycle:${receipt.faultEventId}`;
    for (const eventId of [
      receipt.faultEventId, ...receipt.faultSourceEventIds,
      receipt.shaftInstallationEventId, ...receipt.shaftInstallationSourceEventIds,
      ...(receipt.shaftRepairEventId ? [receipt.shaftRepairEventId] : []),
      ...receipt.shaftRepairSourceEventIds, ...receipt.loadedOperationEventIds,
    ]) assert.ok(pins.get(eventId)?.leaseKeys.includes(`${base}:evidence`), `${eventId} 缺少收据 all lease`);
    const diagnosisId = receipt.faultEventId === first.faultEventId ? first.diagnosisId : second.diagnosisId;
    assert.ok(
      pins.get(diagnosisId)?.leaseKeys.includes(`${base}:diagnosis:${operatorId}`),
      `${diagnosisId} 缺少本人高置信诊断 lease`,
    );
  }
  const badRetentionShell = structuredClone(retentionShell);
  badRetentionShell.world.mechanicalPower.networks[0].reliabilityCycleReceipts[0]
    .faultSourceEventIds.push(badRetentionShell.world.mechanicalPower.networks[0]
      .reliabilityCycleReceipts[0].faultSourceEventIds[0]);
  assert.throws(
    () => beginHistoryRetentionProjection(badRetentionShell, authority),
    /reliability cycle receipts 无效/u,
    'retention 不得把坏收据静默当成完整证据',
  );

  repair('two', 7, second.faultEventId);
  loadedOperation('three', 1, 8);
  loadedOperation('three', 2, 8);
  loadedOperation('three', 3, 8);
  wornFault('three', 9);
  assert.deepEqual(
    network.reliabilityCycleReceipts.map((receipt) => receipt.faultEventId),
    ['fault-two', 'fault-three'],
    '第三次磨损故障必须淘汰最老收据并保持固定两槽',
  );
  assert.equal(network.reliabilityCycleReceipts.length, 2);

  console.log(JSON.stringify({
    passed: true,
    retainedReceiptCount: network.reliabilityCycleReceipts.length,
    pinnedEventCount: projection.pins.length,
    oldestEvicted: !network.reliabilityCycleReceipts.some((receipt) => receipt.faultEventId === first.faultEventId),
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
