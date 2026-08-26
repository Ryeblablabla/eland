import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-electrical-maintenance-retention-'));
const bundlePath = path.join(temporaryDirectory, 'electrical-maintenance-retention.mjs');

function baseEvent(id, atMonth, orderInMonth) {
  return { id, atMonth, orderInMonth, cellId: 0 };
}

function environment(id, atMonth, orderInMonth) {
  return {
    ...baseEvent(id, atMonth, orderInMonth),
    kind: 'environment', change: 'fixture', result: id, diff: {},
  };
}

function action(id, atMonth, orderInMonth, primitive, diff) {
  return {
    ...baseEvent(id, atMonth, orderInMonth),
    kind: 'action', actionTick: 1, planningTick: 1, orderInTick: orderInMonth,
    who: 'maintainer', cause: 'project', action: primitive,
    fromCellId: 0, toCellId: 0, fromZ: 1, toZ: 1, pathSegment: [0],
    status: 'completed', result: id, diff,
  };
}

try {
  const entry = `
    export * from ${JSON.stringify(path.join(projectRoot, 'server/history-retention-projection.ts'))};
    export { installVerifiedHistoryRetentionEvidence } from ${JSON.stringify(path.join(projectRoot, 'server/retained-history-evidence.ts'))};
    export { worldEventByIdWithRetainedLease } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/event-index.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { inventoryCombinationForOutput, inventoryCombinationTechniqueId } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/interaction-rules.ts'))};
    export { MECHANICAL_POWER_OPERATION_TECHNIQUE_ID } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/mechanical-power.ts'))};
    export {
      activeElectricalMaintenanceProjectLeaseKey,
      activeElectricalMaintenanceReplacementLeaseKey,
      currentElectricalNetworkFaultLeaseKey,
      currentElectricalNetworkRepairLeaseKey,
      electricalPowerFaultObservationFactId,
      livingPersonElectricalComponentTechniqueLeaseKey,
      livingPersonElectricalFaultObservationLeaseKey,
      livingPersonElectricalMechanicalServiceLeaseKey,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/electrical-power.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=electrical-maintenance-retention-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const conductorRule = api.inventoryCombinationForOutput(api.Material.CopperConductor);
  assert.ok(conductorRule, 'fixture 需要真实铜导体配方身份');
  const conductorTechniqueId = api.inventoryCombinationTechniqueId(conductorRule);

  const componentKnowledgeSources = [
    'component-obsolete-0', 'component-obsolete-1',
    ...Array.from({ length: 22 }, (_, index) => `component-context-${index}`),
    'component-response', 'component-verification',
  ];
  assert.equal(componentKnowledgeSources.length, 26);

  const repairProvenanceSources = [
    'repair-obsolete-0', 'repair-obsolete-1',
    ...Array.from({ length: 16 }, (_, index) => `repair-context-${index}`),
    'repair-old-fault', 'repair-old-diagnosis', 'repair-old-manufacture',
    'repair-old-verification', 'mechanical-service', 'repair-tool-source',
    'repair-stack-source', 'repair-plan-source',
  ];
  assert.equal(repairProvenanceSources.length, 26);

  const diagnosisKnowledgeSources = [
    'diagnosis-obsolete-0', 'diagnosis-obsolete-1',
    ...Array.from({ length: 6 }, (_, index) => `diagnosis-context-${index}`),
    'fault-current', 'diagnosis-current',
  ];
  assert.equal(diagnosisKnowledgeSources.length, 10);

  const projectActionIds = Array.from({ length: 18 }, (_, index) => {
    if (index === 10) return 'replacement-manufacture';
    if (index === 12) return 'replacement-verification';
    if (index === 17) return 'replacement-repair';
    return `project-action-${index}`;
  });
  const replacementWindow = projectActionIds.slice(-16);
  const faultSourceIds = [
    'mechanical-service', 'dispatch-source', 'install-conductor', 'repair-prior',
  ];

  const orderedIds = [
    ...componentKnowledgeSources,
    ...repairProvenanceSources,
    'repair-prior',
    ...diagnosisKnowledgeSources.slice(0, -2),
    'dispatch-source', 'install-conductor',
    'fault-current', 'diagnosis-current',
    ...projectActionIds,
    'tail',
  ];
  assert.equal(new Set(orderedIds).size, orderedIds.length, 'fixture event ID 必须唯一');

  const events = orderedIds.map((id, absoluteIndex) => {
    const atMonth = Math.floor(absoluteIndex / 20);
    const orderInMonth = absoluteIndex % 20;
    if (id === 'component-response') return action(id, atMonth, orderInMonth, {
      kind: 'act', operation: 'combine', targets: [],
    }, {
      outputMaterialId: api.Material.CopperConductor,
      outputStackId: 'discovery-conductor',
      techniqueId: conductorTechniqueId,
      projectHypothesisOutcome: 'response',
      projectHypothesisHadReliableKnowledge: false,
    });
    if (id === 'component-verification') return action(id, atMonth, orderInMonth, {
      kind: 'attend',
      target: { kind: 'inventory-stack', personId: 'maintainer', stackId: 'discovery-conductor' },
    }, {
      verifiedTechnique: true,
      verifiedSourceEventId: 'component-response',
      factId: conductorTechniqueId,
      verifiedMaterialId: api.Material.CopperConductor,
    });
    if (id === 'mechanical-service') return action(id, atMonth, orderInMonth, {
      kind: 'act', operation: 'exert', targets: [],
    }, { mechanicalPowerOperation: true, mode: 'operate-service' });
    if (id === 'repair-prior') return action(id, atMonth, orderInMonth, {
      kind: 'act', operation: 'exert', targets: [],
    }, { electricalPowerRepair: true, electricalNetworkId: 'electrical-network-1' });
    if (id === 'fault-current') return action(id, atMonth, orderInMonth, {
      kind: 'act', operation: 'exert', targets: [],
    }, {
      electricalPowerFault: true,
      electricalNetworkId: 'electrical-network-1',
      electricalPlanKey: 'electrical-plan-1',
      faultEventId: id,
    });
    if (id === 'diagnosis-current') return action(id, atMonth, orderInMonth, {
      kind: 'attend',
      target: { kind: 'voxel', position: { x: 2, y: 0, z: 1 } },
      electricalPowerFaultObservation: {
        version: 'electrical-power-fault-observation-v1',
        installationProjectId: 'electrical-installation',
        planKey: 'electrical-plan-1',
        networkId: 'electrical-network-1',
        faultEventId: 'fault-current',
      },
    }, {
      electricalPowerFaultDiagnosis: true,
      electricalNetworkId: 'electrical-network-1',
      faultEventId: 'fault-current',
    });
    if (id === 'replacement-manufacture') return action(id, atMonth, orderInMonth, {
      kind: 'act', operation: 'combine', targets: [],
    }, { outputMaterialId: api.Material.CopperConductor, outputStackId: 'replacement-stack' });
    if (id === 'replacement-verification') return action(id, atMonth, orderInMonth, {
      kind: 'attend',
      target: { kind: 'inventory-stack', personId: 'maintainer', stackId: 'replacement-stack' },
    }, {
      verifiedSourceEventId: 'replacement-manufacture',
      verifiedMaterialId: api.Material.CopperConductor,
    });
    if (id === 'replacement-repair') return action(id, atMonth, orderInMonth, {
      kind: 'act', operation: 'exert', targets: [],
    }, {
      electricalPowerRepair: true,
      maintenanceProjectId: 'maintenance-project',
      replacementManufactureEventId: 'replacement-manufacture',
      replacementVerificationEventId: 'replacement-verification',
    });
    if (projectActionIds.includes(id)) return action(id, atMonth, orderInMonth, {
      kind: 'move', toCellId: 0, toZ: 1,
    }, {});
    return environment(id, atMonth, orderInMonth);
  });

  const conductorPosition = { x: 2, y: 0, z: 1 };
  const currentFaultKnowledgeId = api.electricalPowerFaultObservationFactId(
    'electrical-network-1',
    'fault-current',
  );
  const livingPerson = {
    id: 'maintainer', bornAtMonth: 0, body: { health: 80 },
    geneticParents: [], inventory: [], memories: [], conditions: [], relations: [],
    knowledge: [{
      id: api.MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
      kind: 'technique', confidence: 68, sourceEventIds: ['mechanical-service'],
    }, {
      id: conductorTechniqueId,
      kind: 'technique', confidence: 68, sourceEventIds: componentKnowledgeSources,
    }, {
      id: currentFaultKnowledgeId,
      kind: 'observation', confidence: 68, sourceEventIds: diagnosisKnowledgeSources,
    }],
  };
  const deadPerson = {
    ...structuredClone(livingPerson),
    id: 'dead-maintainer', diedAtMonth: 2, body: { health: 0 },
  };
  const maintenanceBasis = {
    version: 'electrical-power-maintenance-basis-v1',
    observerId: livingPerson.id,
    installationProjectId: 'electrical-installation',
    networkId: 'electrical-network-1',
    planKey: 'electrical-plan-1',
    faultEventId: 'fault-current',
    diagnosisEventId: 'diagnosis-current',
    componentPosition: conductorPosition,
    atMonth: 4,
    sourceFactIds: ['fault-current', 'diagnosis-current'],
    basisKey: 'fixture-basis',
  };
  const project = {
    id: 'maintenance-project', status: 'active', kind: 'construction',
    need: 'equipment-reliability', desiredFunction: 'restore-electrical-power-delivery',
    ownerId: livingPerson.id, beneficiaryIds: [livingPerson.id], contributorIds: [livingPerson.id],
    triggerFactIds: ['fault-current', 'diagnosis-current'], pressure: 72,
    createdAtMonth: 4, reviewAtMonth: 5, lastProgressAtMonth: 4,
    missingMaterialIds: [], reservations: [], failureEventIds: [], completionEventIds: [],
    actionEventIds: projectActionIds,
    electricalPowerMaintenanceBasis: maintenanceBasis,
    electricalPowerPlanKey: 'electrical-plan-1',
    electricalPowerNetworkId: 'electrical-network-1',
  };
  const state = {
    clock: { elapsedMonths: 5 },
    people: [livingPerson, deadPerson],
    projects: [project], eraPredictions: [], agreements: [], intents: [],
    world: {
      past: [events.at(-1)],
      historyCursor: {
        version: 1,
        eventCount: events.length,
        hotStartIndex: events.length - 1,
        tailEventId: events.at(-1).id,
      },
      mechanicalPower: { version: 'mechanical-power-world-v1', sources: [], networks: [] },
      electricalPower: {
        version: 'electrical-power-world-v1',
        networks: [{
          id: 'electrical-network-1',
          planKey: 'electrical-plan-1',
          plan: { conductorPositions: [conductorPosition] },
          components: [{
            role: 'conductor', position: conductorPosition,
            latestRepairEventId: 'repair-prior',
            latestRepairSourceEventIds: repairProvenanceSources,
          }],
          fault: {
            faultEventId: 'fault-current',
            sourceEventIds: faultSourceIds,
          },
        }],
      },
    },
  };

  const authority = { stateHash: 'a'.repeat(64) };
  const fold = api.beginHistoryRetentionProjection(state, authority);
  api.foldHistoryRetentionSegment(fold, events, 0);
  const projection = api.finishHistoryRetentionProjection(fold);
  assert.equal(projection.demandGroups.some((group) => group.blocking), false);

  const idsFor = (leaseKey) => projection.pins
    .filter((pin) => pin.leaseKeys.includes(leaseKey))
    .map((pin) => pin.eventId);
  const ordered = (ids) => events.filter((event) => ids.includes(event.id)).map((event) => event.id);
  const faultLease = api.currentElectricalNetworkFaultLeaseKey('electrical-network-1');
  const repairLease = api.currentElectricalNetworkRepairLeaseKey('electrical-network-1');
  const diagnosisLease = api.livingPersonElectricalFaultObservationLeaseKey(
    livingPerson.id,
    'electrical-network-1',
  );
  const componentLease = api.livingPersonElectricalComponentTechniqueLeaseKey(
    livingPerson.id,
    conductorTechniqueId,
  );
  const projectBasisLease = api.activeElectricalMaintenanceProjectLeaseKey(project.id);
  const replacementLease = api.activeElectricalMaintenanceReplacementLeaseKey(project.id);
  const mechanicalServiceLease = api.livingPersonElectricalMechanicalServiceLeaseKey(livingPerson.id);

  assert.deepEqual(idsFor(faultLease), ordered(['fault-current', ...faultSourceIds]));
  assert.deepEqual(idsFor(repairLease), ordered([
    ...repairProvenanceSources.slice(-24), 'repair-prior',
  ]));
  assert.deepEqual(idsFor(diagnosisLease), ordered(diagnosisKnowledgeSources.slice(-8)));
  assert.deepEqual(idsFor(componentLease), ordered(componentKnowledgeSources.slice(-24)));
  assert.deepEqual(idsFor(projectBasisLease), ordered(maintenanceBasis.sourceFactIds));
  assert.deepEqual(idsFor(replacementLease), ordered(replacementWindow));
  assert.deepEqual(idsFor(mechanicalServiceLease), ['mechanical-service']);
  assert.equal(idsFor(replacementLease).includes(projectActionIds[0]), false);
  assert.equal(idsFor(replacementLease).includes(projectActionIds[1]), false);
  assert.deepEqual(
    idsFor(`active-project:${project.id}:actions`),
    ordered(projectActionIds),
    '通用活动项目租约仍保持其原有的独立有界契约',
  );

  const deadComponentLease = api.livingPersonElectricalComponentTechniqueLeaseKey(
    deadPerson.id,
    conductorTechniqueId,
  );
  const deadDiagnosisLease = api.livingPersonElectricalFaultObservationLeaseKey(
    deadPerson.id,
    'electrical-network-1',
  );
  const deadMechanicalLease = api.livingPersonElectricalMechanicalServiceLeaseKey(deadPerson.id);
  assert.deepEqual(idsFor(deadComponentLease), []);
  assert.deepEqual(idsFor(deadDiagnosisLease), []);
  assert.deepEqual(idsFor(deadMechanicalLease), []);

  const eventById = new Map(events.map((event, absoluteIndex) => [event.id, { event, absoluteIndex }]));
  const decodedColdPins = projection.pins
    .filter((pin) => pin.absoluteIndex < state.world.historyCursor.hotStartIndex)
    .map((pin) => ({ absoluteIndex: pin.absoluteIndex, event: eventById.get(pin.eventId).event }));
  api.installVerifiedHistoryRetentionEvidence(
    state,
    authority.stateHash,
    projection,
    decodedColdPins,
  );
  assert.equal(
    api.worldEventByIdWithRetainedLease(state, 'fault-current', faultLease)?.diff.electricalPowerFault,
    true,
  );
  assert.equal(
    api.worldEventByIdWithRetainedLease(state, 'repair-prior', repairLease)?.diff.electricalPowerRepair,
    true,
  );
  assert.equal(
    api.worldEventByIdWithRetainedLease(state, 'diagnosis-current', diagnosisLease)?.diff.electricalPowerFaultDiagnosis,
    true,
  );
  assert.equal(
    api.worldEventByIdWithRetainedLease(state, 'component-response', componentLease)?.diff.projectHypothesisOutcome,
    'response',
  );
  assert.equal(
    api.worldEventByIdWithRetainedLease(state, 'component-verification', componentLease)?.diff.verifiedTechnique,
    true,
  );
  for (const eventId of ['replacement-manufacture', 'replacement-verification', 'replacement-repair']) {
    assert.ok(api.worldEventByIdWithRetainedLease(state, eventId, replacementLease));
  }
  assert.equal(
    api.worldEventByIdWithRetainedLease(state, 'component-response', faultLease),
    undefined,
    '冷事实不得通过无关租约泄漏',
  );

  const invalid = structuredClone(state);
  invalid.projects[0].electricalPowerMaintenanceBasis.sourceFactIds = [
    'fault-current', 'diagnosis-current', 'observer-stage-fact',
  ];
  assert.throws(
    () => api.beginHistoryRetentionProjection(invalid, { stateHash: 'b'.repeat(64) }),
    /缺少可回放的故障诊断依据/u,
    '维护 basis 不得夹带 observer/stage 事实',
  );

  console.log(JSON.stringify({
    ok: true,
    eventCount: events.length,
    pinCount: projection.pins.length,
    replacementWindow: idsFor(replacementLease).length,
    componentSourceWindow: idsFor(componentLease).length,
    diagnosisSourceWindow: idsFor(diagnosisLease).length,
    rssBytes: process.memoryUsage().rss,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
