import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-history-retention-v27-'));
const bundlePath = path.join(temporaryDirectory, 'history-retention-projection.mjs');
const operationTechniqueId = 'technique:mechanical-power:water-wheel-shaft-mill-operation';
const authority = { stateHash: 'a'.repeat(64) };

function baseEvent(id, atMonth) {
  return { id, atMonth, orderInMonth: 0, planningTick: 1, orderInTick: 0, cellId: 0 };
}

function environment(id, atMonth) {
  return { ...baseEvent(id, atMonth), kind: 'environment', change: 'condition', result: id, diff: {} };
}

function death(id, atMonth, who) {
  return { ...environment(id, atMonth), change: 'death', who };
}

function decision(id, atMonth, usedModel) {
  return {
    ...baseEvent(id, atMonth), kind: 'decision', who: 'p1',
    decision: { kind: 'fixture', optionId: id, reason: id }, usedModel, result: id,
  };
}

function action(id, atMonth, who, diff, options = {}) {
  return {
    ...baseEvent(id, atMonth), kind: 'action', actionTick: 1, who, cause: 'intent',
    action: options.action ?? { kind: 'act', operation: 'exert', targets: [] },
    fromCellId: 0, toCellId: 0, fromZ: 1, toZ: 1, pathSegment: [],
    status: options.status ?? 'completed', result: id, diff,
  };
}

function millLabor(id, atMonth, who) {
  return action(id, atMonth, who, { sourceMaterialId: 12, facilityMaterialId: 59 }, {
    action: { kind: 'act', operation: 'separate', targets: [] },
  });
}

function mechanicalOperation(id, atMonth, who, mode = 'operate-service', extra = {}) {
  return action(id, atMonth, who, { mechanicalPowerOperation: true, mode, ...extra });
}

function mechanicalTeaching(id, atMonth, who, audienceIds) {
  return action(id, atMonth, who, {
    explicitTeaching: true,
    teachingFactId: operationTechniqueId,
    taughtAudienceIds: audienceIds,
  }, {
    action: {
      kind: 'communicate', channel: 'voice', audience: audienceIds,
      content: { kind: 'claim', id: `teach:${id}`, factId: operationTechniqueId, summary: id },
    },
  });
}

function reproductionAction(id, atMonth, conceived) {
  return action(id, atMonth, 'parent-a', { conceived, femaleId: 'parent-b' }, {
    action: {
      kind: 'act', operation: 'reproduce', authorizationRef: 'agreement-reproduction',
      targets: [{ kind: 'person', personId: 'parent-b' }],
    },
  });
}

function person(id, options = {}) {
  return {
    id, bornAtMonth: 0, ...(options.dead ? { diedAtMonth: 10 } : {}),
    body: { health: options.dead ? 0 : 80, hydration: 80, nutrition: 80 },
    knowledge: options.knowledge ?? [], inventory: options.inventory ?? [],
    memories: [], conditions: [], relations: [], bereavements: [],
    maternalTeachingSourceEventIds: [],
  };
}

const coreEvents = [
  action('water-observation', 1, 'p1', { mechanicalPowerObservation: true }, {
    action: { kind: 'attend', target: { kind: 'voxel', position: { x: 0, y: 0, z: 0 } } },
  }),
  millLabor('p1-mill-1', 1, 'p1'),
  environment('duplicate-demand', 1),
  millLabor('p1-mill-2', 2, 'p1'),
  decision('rule-decision', 2, false),
  action('install-event', 3, 'p1', { mechanicalPowerInstallation: true }),
  millLabor('p1-mill-3', 3, 'p1'),
  action('old-commissioning-fault', 4, 'p1', {
    mechanicalPowerFault: true, faultKind: 'commissioning-misalignment',
  }, { status: 'progressed' }),
  action('old-repair', 4, 'p1', { mechanicalPowerRepair: true }),
  action('fault-diagnosis', 5, 'p2', { mechanicalPowerFaultDiagnosis: true }, {
    action: { kind: 'attend', target: { kind: 'voxel', position: { x: 1, y: 0, z: 1 } } },
  }),
  action('repair-event', 5, 'p2', { mechanicalPowerRepair: true }),
  decision('model-decision', 5, true),
  millLabor('p1-mill-4', 6, 'p1'),
  environment('duplicate-demand', 6),
  mechanicalOperation('project-action', 7, 'p2', 'operate-service', { mechanicalPowerRecovery: true }),
  mechanicalOperation('technique-event', 8, 'p1', 'operate'),
  environment('inventory-source', 8),
  environment('shared-source', 8),
  millLabor('p2-mill-1', 9, 'p2'),
  action('worn-fault', 9, 'p2', { mechanicalPowerFault: true, faultKind: 'worn-drive-shaft' }),
  millLabor('dead-mill', 10, 'dead'),
  mechanicalOperation('old-operation', 10, 'p1'),
  action('mechanical-teaching', 11, 'p1', {
    explicitTeaching: true,
    teachingFactId: operationTechniqueId,
    taughtAudienceIds: ['learner'],
  }, {
    action: {
      kind: 'communicate', channel: 'voice', audience: ['learner'],
      content: { kind: 'claim', id: 'teach:mechanical-operation', factId: operationTechniqueId, summary: 'teach' },
    },
  }),
  mechanicalOperation('learner-operation', 12, 'learner'),
  mechanicalOperation('owner-operation-later', 13, 'p1'),
];
const noiseEvents = Array.from({ length: 4_096 }, (_, index) => environment(`noise-${index}`, 20 + Math.floor(index / 128)));
const events = [...coreEvents, ...noiseEvents, environment('tail', 60)];

function finalShell(eventCount = events.length, tailEventId = events[eventCount - 1]?.id ?? null) {
  return {
    clock: { elapsedMonths: 60 },
    world: {
      past: [],
      historyCursor: { version: 1, eventCount, hotStartIndex: eventCount, tailEventId },
      mechanicalPower: {
        version: 'mechanical-power-world-v1',
        sources: [{ id: 'segment-1' }],
        networks: [{
          id: 'network-1',
          faultEventIds: ['old-commissioning-fault', 'worn-fault'],
          repairEventIds: ['old-repair', 'repair-event'],
          operationEventIds: [
            'old-operation', 'project-action', 'technique-event',
            'learner-operation', 'owner-operation-later', 'missing-operation-audit',
          ],
          fault: { faultEventId: 'worn-fault', sourceEventIds: ['project-action'] },
        }],
      },
    },
    people: [
      person('p1', {
        knowledge: [{
          id: 'observation:water-current:segment-1', kind: 'observation', confidence: 70,
          sourceEventIds: ['water-observation', 'shared-source'],
        }, {
          id: operationTechniqueId, kind: 'technique', confidence: 68, sourceEventIds: ['technique-event'],
        }, {
          id: 'observation:water-current:segment-1', kind: 'observation', confidence: 54,
          sourceEventIds: ['low-confidence-source'],
        }, {
          id: 'observation:water-current:missing-segment', kind: 'observation', confidence: 80,
          sourceEventIds: ['invalid-segment-source'],
        }],
        inventory: [
          { id: 'p1-reserved', sourceEventIds: ['inventory-source', 'shared-source'] },
          { id: 'p1-unreserved', sourceEventIds: ['unreserved-source'] },
        ],
      }),
      person('p2', {
        knowledge: [{
          id: 'observation:mechanical-power-fault:network-1:worn-fault', kind: 'observation', confidence: 68,
          sourceEventIds: ['worn-fault', 'fault-diagnosis'],
        }, {
          id: 'observation:mechanical-power-fault:network-1:old-commissioning-fault',
          kind: 'observation', confidence: 80, sourceEventIds: ['old-commissioning-fault'],
        }],
        inventory: [{ id: 'p2-reserved', sourceEventIds: ['inventory-source'] }],
      }),
      person('learner'),
      person('dead', {
        dead: true,
        knowledge: [{
          id: operationTechniqueId, kind: 'technique', confidence: 80, sourceEventIds: ['dead-only-source'],
        }],
      }),
    ],
    projects: [{
      id: 'install-project', ownerId: 'p1', status: 'active',
      desiredFunction: 'water-powered-crop-processing',
      triggerFactIds: ['duplicate-demand', 'shared-source', 'missing-hard-project'],
      actionEventIds: ['install-event'], completionEventIds: [],
      contributorIds: [], beneficiaryIds: [], reservations: [{ stackId: 'p1-reserved' }],
    }, {
      id: 'maintenance-project', ownerId: 'p2', status: 'active',
      desiredFunction: 'restore-water-powered-crop-processing',
      triggerFactIds: ['fault-diagnosis'], actionEventIds: ['repair-event', 'project-action'],
      completionEventIds: [], contributorIds: [], beneficiaryIds: [],
      mechanicalPowerFaultEventId: 'worn-fault', reservations: [{ stackId: 'p2-reserved' }],
    }, {
      id: 'dead-active-project', ownerId: 'dead', status: 'active',
      desiredFunction: 'water-powered-crop-processing', triggerFactIds: ['dead-only-source'],
      actionEventIds: [], completionEventIds: [], contributorIds: [], beneficiaryIds: [], reservations: [],
    }],
  };
}

function minimalShell(ledger, people = [person('p1')]) {
  return {
    clock: { elapsedMonths: ledger.at(-1)?.atMonth ?? 0 },
    world: {
      past: [],
      historyCursor: {
        version: 1,
        eventCount: ledger.length,
        hotStartIndex: ledger.length,
        tailEventId: ledger.at(-1)?.id ?? null,
      },
      mechanicalPower: { version: 'mechanical-power-world-v1', sources: [], networks: [] },
    },
    people,
    projects: [],
    eraPredictions: [],
    agreements: [],
    intents: [],
  };
}

function reproductionShell(ledger, attemptEventIds) {
  const shell = minimalShell(ledger, [person('parent-a'), person('parent-b')]);
  const attempts = attemptEventIds.map((eventId) => {
    const event = ledger.find((candidate) => candidate.id === eventId);
    if (!event) throw new Error(`fixture 缺少 reproduction attempt ${eventId}`);
    return event;
  });
  shell.agreements = [{
    id: 'agreement-reproduction', status: 'active', acceptedAtMonth: 1, dueAtMonth: 4,
    proposal: { kind: 'reproduce' },
    proposalEventId: 'reproduction-decision', sourceEventIds: ['reproduction-decision'],
    reproductionAttemptEventIds: [...attemptEventIds],
    ...(attempts.length ? { lastReproductionAttemptAtMonth: attempts.at(-1).atMonth } : {}),
  }];
  shell.intents = [{
    id: 'intent-reproduction', ownerId: 'parent-a', status: 'active', createdAtMonth: 1,
    agreementId: 'agreement-reproduction', sourceDecisionEventId: 'reproduction-decision',
    sourceFactIds: [], actionEventIds: [],
    goal: { kind: 'condition', condition: 'pregnancy', present: true, personId: 'parent-b' },
    nextAction: {
      kind: 'act', operation: 'reproduce', authorizationRef: 'agreement-reproduction',
      targets: [{ kind: 'person', personId: 'parent-b' }],
    },
  }];
  return shell;
}

function residency(fold) {
  return {
    directMatches: fold.directMatchesByEventId.size,
    millRingEntries: [...fold.millLaborRingsByPersonId.values()].reduce((sum, ring) => sum + ring.length, 0),
    pendingTeachings: fold.pendingMechanicalTeachingByAudienceId.size,
    witnessedAudiences: fold.witnessedMechanicalAudienceIds.size,
  };
}

function completeProjection(projection, shell) {
  const fold = projection.beginHistoryRetentionProjection(shell, authority);
  assert.strictEqual(projection.foldHistoryRetentionSegment(fold, coreEvents, 0), fold, 'fold 应原位 staging');
  const beforeNoise = residency(fold);
  let absoluteIndex = coreEvents.length;
  for (let offset = 0; offset < noiseEvents.length; offset += 256) {
    const segment = noiseEvents.slice(offset, offset + 256);
    projection.foldHistoryRetentionSegment(fold, segment, absoluteIndex);
    absoluteIndex += segment.length;
    assert.deepEqual(residency(fold), beforeNoise, '未命中冷 segment 不得扩大 projection 驻留表');
  }
  projection.foldHistoryRetentionSegment(fold, events.slice(-1), absoluteIndex);
  return fold;
}

function projectPrefix(projection, shell, prefix, checkpointAuthority) {
  const fold = projection.beginHistoryRetentionProjection(shell, checkpointAuthority);
  projection.foldHistoryRetentionSegment(fold, prefix, 0);
  return projection.finishHistoryRetentionProjection(fold);
}

function resumeAcrossSuffix(projection, previous, shell, checkpointAuthority, ledger, segmentSize = ledger.length) {
  const fold = projection.resumeHistoryRetentionProjection(previous, shell, checkpointAuthority);
  let absoluteIndex = previous.target.eventCount;
  while (absoluteIndex < ledger.length) {
    const segment = ledger.slice(absoluteIndex, Math.min(ledger.length, absoluteIndex + segmentSize));
    projection.foldHistoryRetentionSegment(fold, segment, absoluteIndex);
    absoluteIndex += segment.length;
  }
  return projection.finishHistoryRetentionProjection(fold);
}

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/history-retention-projection.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' }, stdio: 'pipe' });
  const projection = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
  const shell = finalShell();
  const shellBefore = structuredClone(shell);

  const invalidSourceShell = structuredClone(shell);
  invalidSourceShell.people[0].knowledge[0].sourceEventIds.push('');
  assert.throws(() => projection.beginHistoryRetentionProjection(invalidSourceShell, authority), /空 source event ID/u);
  assert.throws(() => projection.beginHistoryRetentionProjection(shell, { stateHash: 'bad' }), /权威 stateHash/u);

  const oversizedProjectActionShell = minimalShell([environment('oversized-project-tail', 1)]);
  oversizedProjectActionShell.projects = [{
    id: 'oversized-active-project', ownerId: 'p1', status: 'active',
    desiredFunction: 'water-powered-crop-processing', triggerFactIds: [], reservations: [],
    completionEventIds: [], contributorIds: [], beneficiaryIds: [],
    actionEventIds: Array.from(
      { length: projection.HISTORY_RETENTION_MAX_ACTIVE_PROJECT_ACTION_EVENT_IDS + 1 },
      (_, index) => `oversized-project-action-${index}`,
    ),
  }];
  assert.throws(
    () => projection.beginHistoryRetentionProjection(oversizedProjectActionShell, authority),
    /actions 超出有界续接上限/u,
    'active project actionEventIds 必须精确有界且不得静默截断',
  );

  const receiptLedger = [
    environment('receipt-shaft-manufacture', 1),
    environment('receipt-shaft-verification', 1),
    environment('receipt-shaft-installation', 1),
    environment('receipt-load-one-a', 2),
    environment('receipt-load-one-b', 2),
    environment('receipt-fault-one', 3),
    environment('receipt-diagnosis-one', 3),
    environment('receipt-repair-manufacture', 4),
    environment('receipt-repair-verification', 4),
    environment('receipt-repair-one', 4),
    environment('receipt-load-two-a', 5),
    environment('receipt-load-two-b', 5),
    environment('receipt-fault-two', 6),
    environment('receipt-diagnosis-two', 6),
  ];
  const receiptShell = minimalShell(receiptLedger, [person('receipt-operator', {
    knowledge: [{
      id: 'observation:mechanical-power-fault:receipt-network:receipt-fault-one',
      kind: 'observation', confidence: 68,
      sourceEventIds: ['receipt-fault-one', 'receipt-diagnosis-one'],
    }, {
      id: 'observation:mechanical-power-fault:receipt-network:receipt-fault-two',
      kind: 'observation', confidence: 68,
      sourceEventIds: ['receipt-fault-two', 'receipt-diagnosis-two'],
    }],
  })]);
  receiptShell.world.mechanicalPower.networks = [{
    id: 'receipt-network', installationProjectId: 'receipt-installation-project',
    reliabilityCycleReceipts: [{
      version: 'mechanical-power-reliability-cycle-receipt-v1',
      installationProjectId: 'receipt-installation-project', networkId: 'receipt-network',
      operatorId: 'receipt-operator', shaftMaterialId: 65,
      faultEventId: 'receipt-fault-one',
      faultSourceEventIds: ['receipt-load-one-a', 'receipt-load-one-b'],
      shaftInstallationEventId: 'receipt-shaft-installation',
      shaftInstallationSourceEventIds: ['receipt-shaft-manufacture', 'receipt-shaft-verification'],
      shaftRepairSourceEventIds: [], serviceLoadedOperationCount: 2,
      loadedOperationEventIds: ['receipt-load-one-a', 'receipt-load-one-b'],
    }, {
      version: 'mechanical-power-reliability-cycle-receipt-v1',
      installationProjectId: 'receipt-installation-project', networkId: 'receipt-network',
      operatorId: 'receipt-operator', shaftMaterialId: 65,
      faultEventId: 'receipt-fault-two',
      faultSourceEventIds: ['receipt-load-two-a', 'receipt-load-two-b'],
      shaftInstallationEventId: 'receipt-shaft-installation',
      shaftInstallationSourceEventIds: ['receipt-shaft-manufacture', 'receipt-shaft-verification'],
      shaftRepairEventId: 'receipt-repair-one',
      shaftRepairSourceEventIds: [
        'receipt-repair-manufacture', 'receipt-repair-verification', 'receipt-fault-one',
      ],
      serviceLoadedOperationCount: 2,
      loadedOperationEventIds: ['receipt-load-two-a', 'receipt-load-two-b'],
    }],
    operationEventIds: [], faultEventIds: [], repairEventIds: [], sourceEventIds: [],
    components: [], installationEventIds: [], condition: 40, fault: null,
  }];
  const receiptFold = projection.beginHistoryRetentionProjection(receiptShell, authority);
  projection.foldHistoryRetentionSegment(receiptFold, receiptLedger, 0);
  const receiptProjection = projection.finishHistoryRetentionProjection(receiptFold);
  const receiptPins = new Map(receiptProjection.pins.map((pin) => [pin.eventId, pin]));
  for (const cycle of ['one', 'two']) {
    const evidenceLease = `mechanical-network:receipt-network:reliability-cycle:receipt-fault-${cycle}:evidence`;
    for (const eventId of receiptShell.world.mechanicalPower.networks[0]
      .reliabilityCycleReceipts[cycle === 'one' ? 0 : 1]
      .loadedOperationEventIds) {
      assert.ok(receiptPins.get(eventId)?.leaseKeys.includes(evidenceLease), `${eventId} 必须由周期收据保留`);
    }
    const diagnosisLease = `${evidenceLease.replace(/:evidence$/u, '')}:diagnosis:receipt-operator`;
    assert.ok(
      receiptPins.get(`receipt-diagnosis-${cycle}`)?.leaseKeys.includes(diagnosisLease),
      `receipt-diagnosis-${cycle} 必须由本人高置信诊断保留`,
    );
  }
  for (const eventId of [
    'receipt-fault-one', 'receipt-fault-two', 'receipt-shaft-installation',
    'receipt-shaft-manufacture', 'receipt-shaft-verification', 'receipt-repair-one',
    'receipt-repair-manufacture', 'receipt-repair-verification',
  ]) assert.ok(receiptPins.has(eventId), `${eventId} 必须由两周期收据完整 pin`);

  const missingReceiptField = structuredClone(receiptShell);
  delete missingReceiptField.world.mechanicalPower.networks[0].reliabilityCycleReceipts[0]
    .loadedOperationEventIds;
  assert.throws(
    () => projection.beginHistoryRetentionProjection(missingReceiptField, authority),
    /reliability cycle receipts 无效/u,
  );
  const oversizedReceipt = structuredClone(receiptShell);
  oversizedReceipt.world.mechanicalPower.networks[0].reliabilityCycleReceipts[0]
    .loadedOperationEventIds.push('receipt-load-over-limit-a', 'receipt-load-over-limit-b');
  assert.throws(
    () => projection.beginHistoryRetentionProjection(oversizedReceipt, authority),
    /reliability cycle receipts 无效/u,
  );
  const duplicateReceiptSource = structuredClone(receiptShell);
  duplicateReceiptSource.world.mechanicalPower.networks[0].reliabilityCycleReceipts[0]
    .faultSourceEventIds.push('receipt-load-one-a');
  assert.throws(
    () => projection.beginHistoryRetentionProjection(duplicateReceiptSource, authority),
    /reliability cycle receipts 无效/u,
  );
  const duplicateReceipt = structuredClone(receiptShell);
  duplicateReceipt.world.mechanicalPower.networks[0].reliabilityCycleReceipts[1]
    = structuredClone(duplicateReceipt.world.mechanicalPower.networks[0].reliabilityCycleReceipts[0]);
  assert.throws(
    () => projection.beginHistoryRetentionProjection(duplicateReceipt, authority),
    /reliability cycle receipts 无效/u,
  );

  const reliabilityLedger = [
    environment('reliability-fault-one', 1),
    environment('reliability-diagnosis-one', 1),
    environment('reliability-fault-two', 2),
    environment('reliability-diagnosis-two', 2),
  ];
  const reliabilityShell = minimalShell(reliabilityLedger);
  reliabilityShell.projects = [{
    id: 'active-reliability-project', ownerId: 'p1', status: 'active',
    need: 'equipment-reliability', desiredFunction: 'durable-power-transmission',
    triggerFactIds: ['reliability-fault-two'], actionEventIds: [], completionEventIds: [],
    contributorIds: [], beneficiaryIds: [], reservations: [],
    mechanicalPowerFaultEventId: 'reliability-fault-two',
    mechanicalReliabilityBasis: {
      version: 'mechanical-reliability-basis-v1',
      sourceFactIds: [
        'reliability-fault-one',
        'reliability-diagnosis-one',
        'reliability-fault-two',
        'reliability-diagnosis-two',
      ],
    },
  }];
  const reliabilityFold = projection.beginHistoryRetentionProjection(reliabilityShell, authority);
  projection.foldHistoryRetentionSegment(reliabilityFold, reliabilityLedger, 0);
  const reliabilityProjection = projection.finishHistoryRetentionProjection(reliabilityFold);
  const reliabilityPins = new Map(reliabilityProjection.pins.map((pin) => [pin.eventId, pin]));
  for (const event of reliabilityLedger) {
    assert.ok(
      reliabilityPins.get(event.id)?.leaseKeys.includes(
        'active-mechanical-project:active-reliability-project:reliability-basis',
      ),
      `active reliability project 必须保留 ${event.id}`,
    );
  }
  const missingReliabilityBasis = structuredClone(reliabilityShell);
  delete missingReliabilityBasis.projects[0].mechanicalReliabilityBasis;
  assert.throws(
    () => projection.beginHistoryRetentionProjection(missingReliabilityBasis, authority),
    /缺少可续接的机械可靠性依据/u,
    'active reliability project 缺失冻结依据时必须 fail closed',
  );

  const boundedWakeEvents = [
    environment('bounded-wake-source', 1),
    ...Array.from(
      { length: projection.HISTORY_RETENTION_MAX_PENDING_PREDICTION_WAKE_MATCHES + 1 },
      (_, index) => action(`bounded-wake-${index}`, 2 + index, 'p1', {
        rehydrationBasis: 'disputed-pending-prediction',
        hibernationPredictionId: 'bounded-prediction',
        rehydratedPersonId: 'p1',
      }, { action: { kind: 'act', operation: 'rehydrate', targets: [] } }),
    ),
  ];
  const boundedWakeShell = minimalShell(boundedWakeEvents);
  boundedWakeShell.eraPredictions = [{
    id: 'bounded-prediction', status: 'pending', sourceEventIds: ['bounded-wake-source'],
  }];
  const boundedWakeFold = projection.beginHistoryRetentionProjection(boundedWakeShell, authority);
  assert.throws(
    () => projection.foldHistoryRetentionSegment(boundedWakeFold, boundedWakeEvents, 0),
    /selective all-match.*超出有界上限/u,
    'pending wake all-match 超界必须失败，不得丢弃早期 match',
  );
  assert.equal(boundedWakeFold.status, 'discarded');

  const badContinuity = projection.beginHistoryRetentionProjection(shell, authority);
  projection.foldHistoryRetentionSegment(badContinuity, coreEvents.slice(0, 5), 0);
  assert.throws(() => projection.foldHistoryRetentionSegment(badContinuity, coreEvents.slice(5, 8), 6), /重复或跳跃/u);
  assert.equal(badContinuity.status, 'discarded');
  assert.equal(badContinuity.directMatchesByEventId.size, 0, '失败 fold 必须清空 staged matches');

  const complete = completeProjection(projection, shell);
  const result = projection.finishHistoryRetentionProjection(complete);
  assert.strictEqual(projection.finishHistoryRetentionProjection(complete), result, 'finish 必须幂等');
  const repeated = projection.finishHistoryRetentionProjection(completeProjection(projection, shell));
  assert.deepEqual(repeated, result, '同 shell/ledger projection 必须确定');
  assert.deepEqual(shell, shellBefore, 'projection 不得修改 SimulationState shell');

  const teachingCheckpointCount = coreEvents.findIndex((event) => event.id === 'mechanical-teaching') + 1;
  const checkpointOneAuthority = { stateHash: 'b'.repeat(64) };
  const checkpointTwoAuthority = { stateHash: 'c'.repeat(64) };
  const checkpointOneShell = finalShell(teachingCheckpointCount);
  const checkpointTwoShell = finalShell(coreEvents.length);
  const checkpointOneFull = projectPrefix(
    projection,
    checkpointOneShell,
    events.slice(0, teachingCheckpointCount),
    checkpointOneAuthority,
  );
  assert.equal(checkpointOneFull.continuationReady, false, '动态 demand closure 尚有显式 gap，不得冒充全局 continuation-ready');
  assert.ok(
    checkpointOneFull.continuationGaps.some((gap) => gap.code === 'unsealed-exact-root-lineage'),
    'basis 自证 hash 不得代替 exact-root closed wrapper 的 brand/lineage 验证',
  );
  assert.equal(checkpointOneFull.continuationBasis.pendingMechanicalTeachings[0].eventId, 'mechanical-teaching');
  const checkpointTwoResumed = resumeAcrossSuffix(
    projection,
    checkpointOneFull,
    checkpointTwoShell,
    checkpointTwoAuthority,
    events.slice(0, coreEvents.length),
  );
  const checkpointTwoFull = projectPrefix(
    projection,
    checkpointTwoShell,
    events.slice(0, coreEvents.length),
    checkpointTwoAuthority,
  );
  assert.deepEqual(checkpointTwoResumed, checkpointTwoFull, 'checkpoint 1→2 resume 必须等于 genesis full projection');
  const finalResumed = resumeAcrossSuffix(
    projection,
    checkpointTwoResumed,
    shell,
    authority,
    events,
    256,
  );
  assert.deepEqual(finalResumed, result, 'checkpoint 2→final resume 必须等于 genesis full projection');

  const deathJoinLedger = [
    mechanicalTeaching('death-join-teaching', 1, 'teacher', ['learner']),
    mechanicalOperation('death-join-operation', 2, 'learner'),
    death('death-join-death', 3, 'learner'),
  ];
  const deathJoinCheckpointShell = minimalShell(
    deathJoinLedger.slice(0, 1),
    [person('teacher'), person('learner')],
  );
  const deathJoinFinalShell = minimalShell(
    deathJoinLedger,
    [person('teacher'), person('learner', { dead: true })],
  );
  const deathJoinCheckpoint = projectPrefix(
    projection,
    deathJoinCheckpointShell,
    deathJoinLedger.slice(0, 1),
    { stateHash: 'd'.repeat(64) },
  );
  const deathJoinResumed = resumeAcrossSuffix(
    projection,
    deathJoinCheckpoint,
    deathJoinFinalShell,
    { stateHash: 'e'.repeat(64) },
    deathJoinLedger,
  );
  const deathJoinFull = projectPrefix(
    projection,
    deathJoinFinalShell,
    deathJoinLedger,
    { stateHash: 'e'.repeat(64) },
  );
  assert.deepEqual(deathJoinResumed, deathJoinFull, '受众在 suffix 操作后死亡不得丢失 teaching→operation join');
  assert.equal(deathJoinResumed.summary.mechanicalP0.independentTaughtOperatorWitnesses, 1);
  assert.deepEqual(deathJoinResumed.continuationBasis.pendingMechanicalTeachings, [], '下一 basis 才按最终存活状态裁剪 pending');
  assert.deepEqual(deathJoinResumed.continuationBasis.witnessedMechanicalAudienceIds, [], '死亡受众不应永久驻留下一 basis');

  const repeatedWitnessLedger = [
    mechanicalTeaching('repeated-witness-teaching-1', 1, 'teacher', ['learner']),
    mechanicalOperation('repeated-witness-operation-1', 2, 'learner'),
    mechanicalTeaching('repeated-witness-teaching-2', 3, 'teacher', ['learner']),
    mechanicalOperation('repeated-witness-operation-2', 4, 'learner'),
    death('repeated-witness-death', 5, 'learner'),
  ];
  const repeatedWitnessCheckpointShell = minimalShell(
    repeatedWitnessLedger.slice(0, 2),
    [person('teacher'), person('learner')],
  );
  const repeatedWitnessFinalShell = minimalShell(
    repeatedWitnessLedger,
    [person('teacher'), person('learner', { dead: true })],
  );
  const repeatedWitnessCheckpoint = projectPrefix(
    projection,
    repeatedWitnessCheckpointShell,
    repeatedWitnessLedger.slice(0, 2),
    { stateHash: 'f'.repeat(64) },
  );
  const repeatedWitnessResumed = resumeAcrossSuffix(
    projection,
    repeatedWitnessCheckpoint,
    repeatedWitnessFinalShell,
    { stateHash: '1'.repeat(64) },
    repeatedWitnessLedger,
  );
  const repeatedWitnessFull = projectPrefix(
    projection,
    repeatedWitnessFinalShell,
    repeatedWitnessLedger,
    { stateHash: '1'.repeat(64) },
  );
  assert.deepEqual(repeatedWitnessResumed, repeatedWitnessFull, '已 witnessed 受众不得因最终死亡被重复计数');
  assert.equal(repeatedWitnessResumed.summary.mechanicalP0.independentTaughtOperatorWitnesses, 1);

  const millRolloverLedger = [
    millLabor('rollover-mill-1', 1, 'p1'),
    millLabor('rollover-mill-2', 2, 'p1'),
    millLabor('rollover-mill-3', 3, 'p1'),
    millLabor('rollover-mill-4', 4, 'p1'),
  ];
  const millRolloverCheckpoint = projectPrefix(
    projection,
    minimalShell(millRolloverLedger.slice(0, 2)),
    millRolloverLedger.slice(0, 2),
    { stateHash: '2'.repeat(64) },
  );
  const millRolloverFinalShell = minimalShell(millRolloverLedger);
  const millRolloverResumed = resumeAcrossSuffix(
    projection,
    millRolloverCheckpoint,
    millRolloverFinalShell,
    { stateHash: '3'.repeat(64) },
    millRolloverLedger,
  );
  const millRolloverFull = projectPrefix(
    projection,
    millRolloverFinalShell,
    millRolloverLedger,
    { stateHash: '3'.repeat(64) },
  );
  assert.deepEqual(millRolloverResumed, millRolloverFull, 'recent-3 ring 的 checkpoint 2 + suffix 2 rollover 必须等于 full');
  assert.deepEqual(
    millRolloverResumed.pins
      .filter((pin) => pin.leaseKeys.includes('living-mill-labor:p1:recent-3'))
      .map((pin) => pin.eventId),
    ['rollover-mill-2', 'rollover-mill-3', 'rollover-mill-4'],
  );

  const unrestrictedReproductionPrefix = [
    decision('reproduction-decision', 1, false),
    reproductionAction('old-unrestricted-conception', 1, true),
  ];
  const unrestrictedReproductionCheckpoint = projectPrefix(
    projection,
    reproductionShell(unrestrictedReproductionPrefix, []),
    unrestrictedReproductionPrefix,
    { stateHash: '4'.repeat(64) },
  );
  const firstAttemptLedger = [
    ...unrestrictedReproductionPrefix,
    reproductionAction('first-restricted-attempt', 2, false),
  ];
  assert.throws(
    () => projection.resumeHistoryRetentionProjection(
      unrestrictedReproductionCheckpoint,
      reproductionShell(firstAttemptLedger, ['first-restricted-attempt']),
      { stateHash: '5'.repeat(64) },
    ),
    /mutated-reproduction-selector.*attempt ID/u,
    '空 attempt selector 变为非空时不得沿用旧 latest conception',
  );

  const oneAttemptPrefix = [
    decision('reproduction-decision', 1, false),
    reproductionAction('bounded-attempt-1', 1, false),
  ];
  const oneAttemptCheckpoint = projectPrefix(
    projection,
    reproductionShell(oneAttemptPrefix, ['bounded-attempt-1']),
    oneAttemptPrefix,
    { stateHash: '6'.repeat(64) },
  );
  const addedAttemptLedger = [
    ...oneAttemptPrefix,
    reproductionAction('bounded-attempt-2', 2, false),
  ];
  assert.throws(
    () => projection.resumeHistoryRetentionProjection(
      oneAttemptCheckpoint,
      reproductionShell(addedAttemptLedger, ['bounded-attempt-1', 'bounded-attempt-2']),
      { stateHash: '7'.repeat(64) },
    ),
    /mutated-reproduction-selector.*attempt ID/u,
    '既有 attempt selector 新增任何 ID 均必须 fail-closed',
  );

  const missingBasis = structuredClone(checkpointOneFull);
  delete missingBasis.continuationBasis;
  assert.throws(
    () => projection.resumeHistoryRetentionProjection(missingBasis, checkpointTwoShell, checkpointTwoAuthority),
    /缺少 continuation basis/u,
  );
  const wrongCheckpointSeal = structuredClone(checkpointOneFull);
  wrongCheckpointSeal.target.tailEventId = 'wrong-checkpoint-tail';
  assert.throws(
    () => projection.resumeHistoryRetentionProjection(wrongCheckpointSeal, checkpointTwoShell, checkpointTwoAuthority),
    /stateHash\/seal/u,
  );
  assert.throws(
    () => projection.resumeHistoryRetentionProjection(
      checkpointOneFull,
      finalShell(teachingCheckpointCount, 'wrong-successor-tail'),
      checkpointTwoAuthority,
    ),
    /不是 checkpoint 的绝对后继/u,
  );

  const pinById = new Map(result.pins.map((pin) => [pin.eventId, pin]));
  assert.equal(pinById.get('duplicate-demand').absoluteIndex, 13, 'direct duplicate ID 必须 latest ordinal wins');
  assert.ok(!result.pins.some((pin) => pin.absoluteIndex === 2));
  assert.deepEqual(result.pins.filter((pin) => pin.leaseKeys.includes('living-mill-labor:p1:recent-3'))
    .map((pin) => pin.absoluteIndex), [3, 6, 12]);
  assert.ok(pinById.get('old-commissioning-fault')?.leaseKeys
    .includes(projection.LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY),
  '仍被活人知识记住的旧 fault 必须供未来项目压力复用');
  assert.ok(!pinById.has('old-repair'), '旧 repair ledger 不得永久 pin');
  assert.ok(!pinById.has('old-operation'), 'network 只审计最近三条 operation ID');
  assert.ok(pinById.get('learner-operation').leaseKeys
    .includes('mechanical-teaching-operation-witness:learner:operation'));
  assert.ok(!pinById.has('owner-operation-later'), '无当前租约的旧机械操作不应永久 pin');
  for (const rememberedId of ['unreserved-source', 'low-confidence-source', 'invalid-segment-source']) {
    assert.ok(!pinById.has(rememberedId));
    const unresolvedRemembered = result.unresolvedDemands.find((item) => (
      item.eventId === rememberedId
      && item.groupKey === projection.LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY
    ));
    assert.equal(unresolvedRemembered?.blocking, false,
      `不是历史事件的 remembered source 只能形成非阻塞审计缺口：${rememberedId}`);
  }
  assert.ok(!pinById.has('dead-only-source'));
  assert.ok(pinById.get('worn-fault').leaseKeys.includes('active-mechanical-project:maintenance-project:maintenance-fault'));

  const waterGroup = result.demandGroups.find((group) => group.groupKey.startsWith('mechanical-knowledge:p1:observation:water-current'));
  assert.equal(waterGroup.requirement, 'all');
  assert.equal(waterGroup.satisfied, true);
  const missingHard = result.unresolvedDemands.find((item) => item.eventId === 'missing-hard-project');
  assert.deepEqual({ requirement: missingHard.requirement, blocking: missingHard.blocking }, { requirement: 'all', blocking: true });
  assert.ok(!result.unresolvedDemands.some((item) => item.eventId === 'missing-operation-audit'),
    '旧 cumulative operation 审计需求不应继续增长 sidecar');

  assert.deepEqual(result.minimalMechanicalTeachingWitness, {
    audienceId: 'learner', teachingAbsoluteIndex: 22, teachingEventId: 'mechanical-teaching',
    operationAbsoluteIndex: 23, operationEventId: 'learner-operation',
  });
  assert.ok(pinById.get('mechanical-teaching').leaseKeys.includes('mechanical-teaching-operation-witness:learner:teaching'));
  assert.ok(pinById.get('learner-operation').leaseKeys.includes('mechanical-teaching-operation-witness:learner:operation'));
  assert.equal(result.summary.mechanicalTeachingOperationAchieved, true);
  assert.equal(result.summary.mechanicalP0.completedExplicitMechanicalTeachings, 1);
  assert.equal(result.summary.mechanicalP0.independentTaughtOperatorWitnesses, 1);
  assert.equal(result.summary.mechanicalP0.loadedOperations, 5);
  assert.equal(result.summary.ruleDecisions, 1);
  assert.equal(result.summary.modelDecisions, 1);
  assert.deepEqual(result.summary.reducedThrough, result.target);
  assert.deepEqual(result.authority, authority);
  assert.match(result.demandFingerprint, /^[a-f0-9]{64}$/u);
  assert.match(result.continuationBasis.basisHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(result.millLaborPersonIds, ['learner', 'p1', 'p2']);
  assert.ok(result.pins.every((pin) => Object.keys(pin).sort().join(',') === 'absoluteIndex,eventId,leaseKeys'));

  const memoryUsage = process.memoryUsage();
  assert.ok(memoryUsage.rss < 256 * 1024 * 1024, 'v27 synthetic fixture RSS 不得超过 256 MiB');
  console.log(JSON.stringify({
    result: 'passed', eventCount: result.target.eventCount, pinCount: result.pins.length,
    unresolved: result.unresolvedDemands, witness: result.minimalMechanicalTeachingWitness,
    summary: result.summary, rssBytes: memoryUsage.rss,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
