import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';
import { build } from 'esbuild';

const temp = mkdtempSync(path.join(tmpdir(), 'eland-gameplay-leases-'));
const entry = path.join(temp, 'entry.ts');
const bundle = path.join(temp, 'bundle.mjs');
const serverProjectionPath = path.resolve('server/history-retention-projection.ts');
const retainedEvidencePath = path.resolve('server/retained-history-evidence.ts');
const eventIndexPath = path.resolve('src/game/eland/domain/event-index.ts');
const productionToolPath = path.resolve('src/game/eland/domain/production-tool.ts');
const measurementActionsPath = path.resolve('src/game/eland/domain/actions/measurement-actions.ts');
const retentionCodecPath = path.resolve('server/history-retention-codec.ts');
const climatePath = path.resolve('src/game/eland/domain/monthly/climate.ts');
const conversationPath = path.resolve('src/game/eland/application/conversation-options.ts');
const intentExecutionPath = path.resolve('src/game/eland/application/simulation/intent-execution.ts');

function environment(id, atMonth, orderInMonth = 0, change = 'climate', diff = {}) {
  return { id, kind: 'environment', atMonth, orderInMonth, cellId: 0, change, result: id, diff };
}

function action(id, atMonth, orderInMonth, who, primitive, diff = {}) {
  return {
    id, kind: 'action', atMonth, orderInMonth, cellId: 0,
    actionTick: 1, who, cause: 'intent', status: 'completed', result: id,
    action: primitive, diff, fromCellId: 0, toCellId: 0, fromZ: 1, toZ: 1, pathSegment: [0],
  };
}

function reproduce(id, atMonth, orderInMonth, conceived) {
  return action(
    id,
    atMonth,
    orderInMonth,
    'parent-a',
    {
      kind: 'act', operation: 'reproduce', authorizationRef: 'agreement-1',
      targets: [{ kind: 'person', personId: 'parent-b' }],
    },
    { conceived, femaleId: 'parent-b' },
  );
}

function production(id, atMonth, orderInMonth) {
  return action(id, atMonth, orderInMonth, 'parent-a', {
    kind: 'act', operation: 'separate', targets: [],
  }, { sourceMaterialId: 12, outputs: [{ materialId: 10, quantity: 1 }] });
}

function calibration(id, atMonth, orderInMonth) {
  const instrument = {
    personId: 'parent-a', stackId: 'balance-1', materialId: 70, quantity: 1,
    heldQuantity: 1, sourceEventIds: ['balance-made'],
  };
  const reference = {
    personId: 'parent-a', stackId: 'weight-1', materialId: 71, quantity: 1,
    heldQuantity: 1, sourceEventIds: ['weight-made'],
  };
  return action(id, atMonth, orderInMonth, 'parent-a', {
    kind: 'attend', target: { kind: 'inventory-stack', personId: 'parent-a', stackId: 'weight-1' },
    instrumentStackId: 'balance-1',
    measurement: {
      version: 'sourced-mass-measurement-action-v1', mode: 'calibrate-mass',
      instrument: { personId: 'parent-a', stackId: 'balance-1', quantity: 1, sourceEventIds: ['balance-made'] },
      reference: { personId: 'parent-a', stackId: 'weight-1', quantity: 1, sourceEventIds: ['weight-made'] },
    },
  }, {
    version: 'mass-calibration-receipt-v1', receiptKind: 'mass-calibration',
    calibrationEventId: id, calibratedByPersonId: 'parent-a', calibratedAtMonth: atMonth,
    dimension: 'mass', unit: 'calibrated-reference-load', resolution: 0.5,
    instrument, reference,
  });
}

function person(id, geneticParents = []) {
  return {
    id, name: id, geneticParents, diedAtMonth: undefined,
    body: { health: 80 }, knowledge: [], inventory: id === 'parent-a' ? [{
      id: 'balance-1', materialId: 70, quantity: 1, sourceEventIds: ['balance-made'],
    }, {
      id: 'weight-1', materialId: 71, quantity: 1, sourceEventIds: ['weight-made'],
    }] : [], conditions: [], relations: [], memories: [],
    position: { cellId: 0, z: 1 },
  };
}

function stateShell(events, past = events) {
  const attempts = events.filter((event) => event.id.startsWith('reproduction-attempt'));
  const people = [person('parent-a'), person('parent-b'), person('child-1', ['parent-a', 'parent-b'])];
  return {
    clock: { elapsedMonths: 5 },
    people,
    projects: [{
      id: 'project-live', status: 'active', desiredFunction: 'remote-work-power-delivery',
      ownerId: 'parent-a', triggerFactIds: ['project-trigger'], actionEventIds: ['project-action'],
      completionEventIds: ['project-completion-anchor'], reservations: [],
      contributorIds: [], beneficiaryIds: [],
      pressureBasis: { sourceFactIds: ['project-pressure-source'] },
      remoteWorkPowerBasis: { sourceFactIds: ['project-remote-source'] },
    }],
    eraPredictions: [{
      id: 'prediction-1', predictorId: 'parent-a', audienceIds: ['parent-b'], madeAtMonth: 1,
      targetEpoch: 'chaotic', predictedStartMonth: 7, toleranceMonths: 1, expiresAtMonth: 8,
      status: 'pending', sourceEventIds: ['prediction-source'],
    }],
    agreements: [{
      id: 'agreement-1', status: 'active', proposedAtMonth: 1, acceptedAtMonth: 2, dueAtMonth: 5,
      resolvedAtMonth: 5,
      proposal: {
        kind: 'reproduce', proposerId: 'parent-a', partnerId: 'parent-b', expiresAtMonth: 2,
      },
      proposerId: 'parent-a', responderId: 'parent-b', partyIds: ['parent-a', 'parent-b'],
      proposalEventId: 'agreement-proposal', responseEventId: 'agreement-response',
      sourceEventIds: ['agreement-proposal', 'agreement-response', 'agreement-source-old'],
      reproductionAttemptEventIds: attempts.map((event) => event.id),
      lastReproductionAttemptAtMonth: attempts.at(-1)?.atMonth,
    }],
    intents: [{
      id: 'intent-1', ownerId: 'parent-a', status: 'active', createdAtMonth: 1,
      sourceDecisionEventId: 'intent-decision', agreementId: 'agreement-1',
      sourceFactIds: ['intent-source-old'], actionEventIds: [],
      goal: { kind: 'condition', personId: 'parent-b', condition: 'pregnancy', present: true },
      nextAction: {
        kind: 'act', operation: 'reproduce', authorizationRef: 'agreement-1',
        targets: [{ kind: 'person', personId: 'parent-b' }],
      },
    }, {
      id: 'intent-demand-tier', ownerId: 'parent-a', status: 'active', createdAtMonth: 1,
      sourceDecisionEventId: 'intent-tier-decision',
      sourceFactIds: ['intent-tier-support-old'],
      actionEventIds: ['intent-tier-action-old'],
      goal: { kind: 'at-cell', cellId: 0, z: 1 },
      nextAction: { kind: 'act', operation: 'wait', targets: [] },
    }],
    world: {
      past: [...past],
      historyCursor: {
        version: 1,
        eventCount: events.length,
        hotStartIndex: events.length - past.length,
        tailEventId: events.at(-1).id,
      },
      mechanicalPower: { sources: [], networks: [] },
    },
  };
}

try {
  const readerTestExports = new Map([
    [serverProjectionPath, '\nexport { historyRetentionContinuationBasisHash as __testHistoryRetentionContinuationBasisHash };\n'],
    [climatePath, '\nexport { disputedWakeFactsForPendingPrediction as __testDisputedWakeFactsForPendingPrediction };\n'],
    [conversationPath, '\nexport { birthEventForSharedChild as __testBirthEventForSharedChild };\n'],
    [intentExecutionPath, '\nexport { reproductionAttemptFactForIntent as __testReproductionAttemptFactForIntent, reproductionConceptionFactForIntent as __testReproductionConceptionFactForIntent };\n'],
  ]);
  writeFileSync(entry, [
    `export * from ${JSON.stringify(serverProjectionPath)};`,
    `export { installVerifiedHistoryRetentionEvidence } from ${JSON.stringify(retainedEvidencePath)};`,
    `export { registerRetainedColdWorldEventFacts, worldEventById, MAX_LIVE_INTENT_ACTION_EVENT_IDS } from ${JSON.stringify(eventIndexPath)};`,
    `export { recentPersonalProductionLaborEvents } from ${JSON.stringify(productionToolPath)};`,
    `export { latestPersonalCalibrationFor } from ${JSON.stringify(measurementActionsPath)};`,
    `export { encodeHistoryRetentionSidecar, decodeHistoryRetentionSidecar, hashHistoryRetentionStoredContent, HISTORY_RETENTION_SIDECAR_CODEC, HISTORY_RETENTION_SIDECAR_LEGACY_CODEC } from ${JSON.stringify(retentionCodecPath)};`,
    `export { __testDisputedWakeFactsForPendingPrediction } from ${JSON.stringify(climatePath)};`,
    `export { __testBirthEventForSharedChild } from ${JSON.stringify(conversationPath)};`,
    `export { startIntent, __testReproductionAttemptFactForIntent, __testReproductionConceptionFactForIntent } from ${JSON.stringify(intentExecutionPath)};`,
  ].join('\n'));
  await build({
    entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'esm',
    plugins: [{
      name: 'expose-bounded-gameplay-readers',
      setup(buildApi) {
        buildApi.onLoad({ filter: /(?:history-retention-projection|climate|conversation-options|intent-execution)\.ts$/ }, (args) => {
          const suffix = readerTestExports.get(path.resolve(args.path));
          if (!suffix) return null;
          return {
            contents: `${readFileSync(args.path, 'utf8')}${suffix}`,
            loader: 'ts',
            resolveDir: path.dirname(args.path),
          };
        });
      },
    }],
  });
  const api = await import(`${pathToFileURL(bundle).href}?v=${Date.now()}`);

  const disputedWakes = Array.from({ length: 24 }, (_, index) => action(
    `disputed-wake-${index}`,
    2,
    index,
    'parent-a',
    { kind: 'act', operation: 'rehydrate', targets: [{ kind: 'person', personId: 'parent-b' }] },
    {
      rehydrationBasis: 'disputed-pending-prediction', hibernationPredictionId: 'prediction-1',
      rehydratedPersonId: 'parent-b',
    },
  ));
  const attempts = [
    reproduce('reproduction-attempt-1', 2, 30, false),
    reproduce('reproduction-attempt-later-1', 3, 1, false),
    reproduce('reproduction-attempt-later-2', 4, 0, false),
    reproduce('reproduction-attempt-conceived', 5, 0, true),
  ];
  const events = [
    environment('agreement-source-old', 0, 0),
    environment('agreement-proposal', 0, 1),
    environment('agreement-response', 0, 2),
    environment('intent-source-old', 0, 3),
    environment('intent-tier-support-old', 0, 4),
    environment('project-trigger', 0, 5),
    environment('project-pressure-source', 0, 6),
    environment('project-remote-source', 0, 7),
    environment('balance-made', 0, 8),
    environment('weight-made', 0, 9),
    environment('prediction-source', 1, 0),
    { id: 'intent-decision', kind: 'decision', atMonth: 1, orderInMonth: 1, cellId: 0, who: 'parent-a', usedModel: false },
    { id: 'intent-tier-decision', kind: 'decision', atMonth: 1, orderInMonth: 2, cellId: 0, who: 'parent-a', usedModel: false },
    action('intent-tier-action-old', 1, 3, 'parent-a', {
      kind: 'act', operation: 'wait', targets: [],
    }),
    production('production-old', 1, 4),
    ...disputedWakes,
    calibration('calibration-old', 2, 24),
    attempts[0],
    environment('child-birth', 3, 0, 'body', { bornPersonId: 'child-1', bornPersonName: 'Child' }),
    attempts[1], attempts[2],
    production('production-latest', 4, 2),
    calibration('calibration-latest', 4, 3),
    environment('project-action', 4, 4),
    environment('project-completion-anchor', 4, 5),
    attempts[3],
    environment('tail', 5, 99),
  ];
  const shell = stateShell(events, [events.at(-1)]);
  const fold = api.beginHistoryRetentionProjection(shell, { stateHash: 'a'.repeat(64) });
  api.foldHistoryRetentionSegment(fold, events, 0);
  const projection = api.finishHistoryRetentionProjection(fold);

  const reproductionOption = {
    id: 'reproduce:agreement-1:parent-b',
    summary: '在当前同意窗口内共同尝试形成下一代',
    reason: '双方已有可撤回的尝试约定',
    domain: 'social',
    goal: { kind: 'condition', personId: 'parent-b', condition: 'pregnancy', present: true },
    nextAction: { kind: 'move', toCellId: 0, toZ: 1 },
    completionAction: {
      kind: 'act', operation: 'reproduce', authorizationRef: 'agreement-1',
      targets: [{ kind: 'person', personId: 'parent-b' }],
    },
    estimatedDuration: 'one-month',
    sourceFactIds: ['agreement-proposal'],
  };
  const suffixDecision = {
    id: 'new-reproduction-intent-decision', kind: 'decision', atMonth: 6,
    orderInMonth: 0, planningTick: 1, orderInTick: 0, cellId: 0,
    who: 'parent-a', decision: { kind: 'start', optionId: reproductionOption.id, reason: 'test' },
    usedModel: false, result: 'test',
  };
  const successorEvents = [...events, suffixDecision];
  const successorShell = stateShell(successorEvents, [suffixDecision]);
  successorShell.clock.elapsedMonths = 6;
  successorShell.intents[0].status = 'completed';
  successorShell.agreements[0].acceptedAtMonth = 3;
  successorShell.agreements[0].dueAtMonth = 6;
  successorShell.agreements[0].reproductionAttemptEventIds = attempts.slice(1).map((event) => event.id);
  successorShell.agreements[0].lastReproductionAttemptAtMonth = 5;
  const newIntent = api.startIntent(
    successorShell,
    successorShell.people[0],
    { options: [reproductionOption], followUpOptions: [] },
    reproductionOption.id,
    undefined,
    suffixDecision.id,
    6,
  );
  assert.ok(newIntent, 'active reproduction agreement 应能形成新 intent');
  suffixDecision.intentId = newIntent.id;
  assert.deepEqual(
    newIntent.reproductionAttemptEventIdsAtStart,
    attempts.slice(1).map((event) => event.id),
    '新 intent 必须冻结绑定时已经存在的 agreement attempts，而不是把它们冒充为本 intent 的尝试',
  );

  const missingBaselineShell = structuredClone(successorShell);
  delete missingBaselineShell.intents.find((intent) => intent.id === newIntent.id)
    .reproductionAttemptEventIdsAtStart;
  const missingBaselineFold = api.resumeHistoryRetentionProjection(
    projection,
    missingBaselineShell,
    { stateHash: '0'.repeat(64) },
  );
  api.foldHistoryRetentionSegment(missingBaselineFold, [suffixDecision], events.length);
  assert.throws(
    () => api.finishHistoryRetentionProjection(missingBaselineFold),
    /缺少 agreement attempt 权威事实/u,
    '没有绑定基线时应精确复现：新 intent 错误索取 prefix attempt',
  );

  const successorFold = api.resumeHistoryRetentionProjection(
    projection,
    successorShell,
    { stateHash: '7'.repeat(64) },
  );
  api.foldHistoryRetentionSegment(successorFold, [suffixDecision], events.length);
  assert.doesNotThrow(
    () => api.finishHistoryRetentionProjection(successorFold),
    '有绑定基线的新 intent 不应要求创建前的 agreement attempt 出现在 suffix',
  );

  const idsFor = (lease) => projection.pins
    .filter((pin) => pin.leaseKeys.includes(lease))
    .map((pin) => pin.eventId);
  assert.deepEqual(idsFor('gameplay:pending-era-prediction:prediction-1:disputed-wake'), [
    'prediction-source', ...disputedWakes.map((event) => event.id),
  ], 'disputed wake 保留 all-match 权威顺序');
  assert.deepEqual(idsFor('gameplay:living-child:child-1:birth'), ['child-birth']);
  assert.deepEqual(idsFor('gameplay:reproduction-intent:intent-1:attempt'), [
    'intent-decision', attempts.at(-1).id,
  ], 'active intent 只保留 reverse-find 所需的最新 attempt body');
  assert.deepEqual(idsFor('gameplay:reproduction-intent:intent-1:conception'), [
    'intent-decision', attempts.at(-1).id,
  ]);
  assert.deepEqual(idsFor('gameplay:recent-personal-production:witness:parent-a'), [
    'production-latest',
  ], '每个存活人物只租约窗口内最新生产见证');
  assert.deepEqual(idsFor('gameplay:personal-mass-calibration:parent-a:balance-1'), [
    'balance-made', 'calibration-latest',
  ], '当前仪器来源与最新本人校准共享精确租约');
  assert.deepEqual(idsFor('live-agreement:agreement-1:anchors'), [
    'agreement-source-old', 'agreement-proposal', 'agreement-response',
  ], 'live agreement 保留 proposal/response/source anchors');
  assert.deepEqual(idsFor('live-intent:intent-1:anchors'), [
    'intent-source-old', 'intent-decision',
  ]);
  const tierCoreGroup = projection.demandGroups.find(
    (group) => group.groupKey === 'live-intent:intent-demand-tier:anchors',
  );
  const tierSupportGroup = projection.demandGroups.find(
    (group) => group.groupKey
      === 'live-intent:intent-demand-tier:anchors:supporting-sources',
  );
  assert.ok(tierCoreGroup && tierSupportGroup, 'live intent 必须拆分 executable core 与 supporting sources');
  assert.equal(tierCoreGroup.requirement, 'all');
  assert.deepEqual(tierCoreGroup.eventIds, ['intent-tier-action-old', 'intent-tier-decision']);
  assert.equal(tierSupportGroup.requirement, 'audit-only');
  assert.deepEqual(tierSupportGroup.eventIds, ['intent-tier-support-old']);
  const disguisedSplit = structuredClone(projection);
  const disguisedCore = disguisedSplit.demandGroups.find(
    (group) => group.groupKey === tierCoreGroup.groupKey,
  );
  const disguisedSupport = disguisedSplit.demandGroups.find(
    (group) => group.groupKey === tierSupportGroup.groupKey,
  );
  disguisedCore.eventIds = ['intent-tier-action-old', 'intent-tier-support-old'];
  disguisedCore.resolvedEventIds = ['intent-tier-support-old', 'intent-tier-action-old'];
  disguisedSupport.eventIds = ['intent-tier-decision'];
  disguisedSupport.resolvedEventIds = ['intent-tier-decision'];
  assert.throws(
    () => api.assertHistoryRetentionProjectionMatchesShell(shell, disguisedSplit),
    /core\/support 分区不一致/u,
    '新 split sidecar 不得把 Decision/Action 伪装进 audit-only supporting sources',
  );
  for (const eventId of [
    'project-trigger', 'project-pressure-source', 'project-remote-source',
    'project-action', 'project-completion-anchor',
  ]) assert.ok(projection.pins.some((pin) => pin.eventId === eventId
    && pin.leaseKeys.some((lease) => lease.startsWith('active-project:project-live:'))));

  const oversized = structuredClone(shell);
  oversized.agreements[0].reproductionAttemptEventIds.push('fifth-attempt');
  assert.throws(
    () => api.beginHistoryRetentionProjection(oversized, { stateHash: 'b'.repeat(64) }),
    /超出 4 个月 consent window/u,
  );

  const maximumIntentCore = structuredClone(shell);
  maximumIntentCore.intents.find((intent) => intent.id === 'intent-demand-tier').actionEventIds =
    Array.from({ length: api.MAX_LIVE_INTENT_ACTION_EVENT_IDS }, (_, index) => (
      `intent-boundary-action-${index}`
    ));
  assert.doesNotThrow(
    () => api.beginHistoryRetentionProjection(maximumIntentCore, { stateHash: '2'.repeat(64) }),
    '4096 action IDs 加 mandatory decision 必须落在明确的 live-intent core 上限内',
  );

  const sameMonthEvents = events.map((event) => event.id === attempts[1].id ? { ...event, atMonth: 2 } : event);
  const sameMonthFold = api.beginHistoryRetentionProjection(
    stateShell(sameMonthEvents, [sameMonthEvents.at(-1)]),
    { stateHash: 'c'.repeat(64) },
  );
  assert.throws(() => api.foldHistoryRetentionSegment(sameMonthFold, sameMonthEvents, 0), /多次 attempt/u);

  const missingAttemptEvents = events.map((event) => event.id === attempts[1].id
    ? environment('not-an-agreement-attempt', event.atMonth, event.orderInMonth) : event);
  const missingAttemptFold = api.beginHistoryRetentionProjection(shell, { stateHash: '1'.repeat(64) });
  api.foldHistoryRetentionSegment(missingAttemptFold, missingAttemptEvents, 0);
  assert.throws(
    () => api.finishHistoryRetentionProjection(missingAttemptFold),
    /缺少 agreement attempt 权威事实/u,
  );

  function completedProjectionFor(candidateEvents, stateHash) {
    const candidateShell = stateShell(candidateEvents, [candidateEvents.at(-1)]);
    const candidateFold = api.beginHistoryRetentionProjection(candidateShell, { stateHash });
    api.foldHistoryRetentionSegment(candidateFold, candidateEvents, 0);
    return { candidateShell, result: api.finishHistoryRetentionProjection(candidateFold) };
  }

  function legacyCombinedIntentProjectionFor(candidateProjection) {
    const legacy = structuredClone(candidateProjection);
    const coreKey = 'live-intent:intent-demand-tier:anchors';
    const supportKey = `${coreKey}:supporting-sources`;
    const core = legacy.demandGroups.find((group) => group.groupKey === coreKey);
    const support = legacy.demandGroups.find((group) => group.groupKey === supportKey);
    assert.ok(core && support, 'legacy fixture 需要当前 split intent groups');
    const eventIds = [...new Set([...core.eventIds, ...support.eventIds])].sort();
    const resolvedSet = new Set([...core.resolvedEventIds, ...support.resolvedEventIds]);
    const directOrdinals = new Map(legacy.continuationBasis.directMatches
      .map((match) => [match.eventId, match.absoluteIndex]));
    const resolvedEventIds = eventIds.filter((eventId) => resolvedSet.has(eventId))
      .sort((left, right) => directOrdinals.get(left) - directOrdinals.get(right));
    const unresolvedEventIds = eventIds.filter((eventId) => !resolvedSet.has(eventId));
    legacy.demandGroups = legacy.demandGroups
      .filter((group) => group.groupKey !== coreKey && group.groupKey !== supportKey)
      .concat({
        groupKey: coreKey,
        requirement: 'all',
        leaseKeys: [coreKey],
        eventIds,
        resolvedEventIds,
        unresolvedEventIds,
        satisfied: unresolvedEventIds.length === 0,
        blocking: unresolvedEventIds.length > 0,
      })
      .sort((left, right) => left.groupKey.localeCompare(right.groupKey));
    legacy.unresolvedDemands = legacy.unresolvedDemands
      .map((demand) => demand.groupKey === supportKey ? {
        ...demand,
        groupKey: coreKey,
        requirement: 'all',
        blocking: true,
      } : demand)
      .sort((left, right) => left.groupKey.localeCompare(right.groupKey)
        || left.eventId.localeCompare(right.eventId));

    const sourceCore = legacy.continuationBasis.sourceDemand.groups.find(
      (group) => group.groupKey === coreKey,
    );
    const sourceSupport = legacy.continuationBasis.sourceDemand.groups.find(
      (group) => group.groupKey === supportKey,
    );
    assert.ok(sourceCore && sourceSupport);
    legacy.continuationBasis.sourceDemand.groups = legacy.continuationBasis.sourceDemand.groups
      .filter((group) => group.groupKey !== coreKey && group.groupKey !== supportKey)
      .concat({
        groupKey: coreKey,
        requirement: 'all',
        leaseKeys: [coreKey],
        eventIds: [...new Set([...sourceCore.eventIds, ...sourceSupport.eventIds])].sort(),
      })
      .sort((left, right) => left.groupKey.localeCompare(right.groupKey));
    assert.equal(
      api.historyRetentionDemandFingerprint(legacy.continuationBasis.sourceDemand),
      legacy.demandFingerprint,
      'live intent split 必须保持旧 combined demand fingerprint',
    );
    const { basisHash: _basisHash, ...basisWithoutHash } = legacy.continuationBasis;
    legacy.continuationBasis.basisHash =
      api.__testHistoryRetentionContinuationBasisHash(basisWithoutHash);
    return legacy;
  }

  function decodedColdPinsFor(candidateEvents, candidateShell, candidateProjection) {
    return candidateProjection.pins
      .filter((pin) => pin.absoluteIndex < candidateShell.world.historyCursor.hotStartIndex)
      .map((pin) => ({ ...pin, event: candidateEvents[pin.absoluteIndex] }));
  }

  const missingPrediction = events.map((event) => event.id === 'prediction-source'
    ? environment('not-prediction-source', event.atMonth, event.orderInMonth) : event);
  const missingPredictionProjection = completedProjectionFor(missingPrediction, 'd'.repeat(64));
  assert.throws(() => api.installVerifiedHistoryRetentionEvidence(
    missingPredictionProjection.candidateShell,
    'd'.repeat(64),
    missingPredictionProjection.result,
    [],
  ), /阻断证据组/u, 'pending prediction source anchor 缺失必须 fail-closed');

  const missingDecision = events.map((event) => event.id === 'intent-decision'
    ? environment('not-intent-decision', event.atMonth, event.orderInMonth) : event);
  const missingDecisionProjection = completedProjectionFor(missingDecision, 'e'.repeat(64));
  assert.throws(() => api.installVerifiedHistoryRetentionEvidence(
    missingDecisionProjection.candidateShell,
    'e'.repeat(64),
    missingDecisionProjection.result,
    [],
  ), /阻断证据组/u, 'reproduction decision anchor 缺失必须 fail-closed');

  const missingAgreementSource = events.map((event) => event.id === 'agreement-source-old'
    ? environment('not-agreement-source', event.atMonth, event.orderInMonth) : event);
  const missingAgreementProjection = completedProjectionFor(missingAgreementSource, '9'.repeat(64));
  const missingAgreementSupportGroup = missingAgreementProjection.result.demandGroups.find(
    (group) => group.groupKey === 'live-agreement:agreement-1:anchors:supporting-sources',
  );
  assert.ok(missingAgreementSupportGroup, 'live agreement supporting sources 必须单独投影');
  assert.equal(missingAgreementSupportGroup.requirement, 'audit-only');
  assert.deepEqual(missingAgreementSupportGroup.unresolvedEventIds, ['agreement-source-old']);
  assert.equal(missingAgreementSupportGroup.blocking, false,
    '协议支持 provenance 缺口不得伪装成 proposal/response 核心缺口');
  assert.equal(missingAgreementProjection.result.demandGroups.some((group) => group.blocking), false);

  const missingIntentSupport = events.map((event) => event.id === 'intent-tier-support-old'
    ? environment('not-intent-tier-support', event.atMonth, event.orderInMonth) : event);
  const missingIntentSupportProjection = completedProjectionFor(
    missingIntentSupport,
    '6'.repeat(64),
  );
  const missingIntentCoreGroup = missingIntentSupportProjection.result.demandGroups.find(
    (group) => group.groupKey === 'live-intent:intent-demand-tier:anchors',
  );
  const missingIntentSupportGroup = missingIntentSupportProjection.result.demandGroups.find(
    (group) => group.groupKey
      === 'live-intent:intent-demand-tier:anchors:supporting-sources',
  );
  assert.ok(missingIntentCoreGroup && missingIntentSupportGroup);
  assert.equal(missingIntentCoreGroup.satisfied, true);
  assert.deepEqual(missingIntentCoreGroup.resolvedEventIds, [
    'intent-tier-decision', 'intent-tier-action-old',
  ]);
  assert.equal(missingIntentSupportGroup.requirement, 'audit-only');
  assert.deepEqual(missingIntentSupportGroup.unresolvedEventIds, ['intent-tier-support-old']);
  assert.equal(missingIntentSupportGroup.blocking, false,
    'intent supporting provenance 缺口不得升级为 executable core blocker');

  const legacyIntentProjection = legacyCombinedIntentProjectionFor(
    missingIntentSupportProjection.result,
  );
  assert.deepEqual(
    legacyIntentProjection.demandGroups.filter((group) => group.blocking)
      .map((group) => group.groupKey),
    ['live-intent:intent-demand-tier:anchors'],
    '旧 combined sidecar 只能留下 supporting provenance promotion blocker',
  );
  assert.doesNotThrow(() => api.installVerifiedHistoryRetentionEvidence(
    missingIntentSupportProjection.candidateShell,
    '6'.repeat(64),
    legacyIntentProjection,
    decodedColdPinsFor(
      missingIntentSupport,
      missingIntentSupportProjection.candidateShell,
      legacyIntentProjection,
    ),
  ), '旧 combined live-intent sidecar 的 supporting-only blocker 应通过严格迁移 seam');

  const suffixAfterLegacy = environment('suffix-after-legacy-intent', 6, 0);
  const successorIntentEvents = [...missingIntentSupport, suffixAfterLegacy];
  const successorIntentShell = stateShell(successorIntentEvents, [suffixAfterLegacy]);
  successorIntentShell.clock.elapsedMonths = 6;
  const successorIntentFold = api.resumeHistoryRetentionProjection(
    legacyIntentProjection,
    successorIntentShell,
    { stateHash: '5'.repeat(64) },
  );
  api.foldHistoryRetentionSegment(
    successorIntentFold,
    [suffixAfterLegacy],
    missingIntentSupport.length,
  );
  const successorIntentProjection = api.finishHistoryRetentionProjection(successorIntentFold);
  const successorIntentSupportGroup = successorIntentProjection.demandGroups.find(
    (group) => group.groupKey
      === 'live-intent:intent-demand-tier:anchors:supporting-sources',
  );
  assert.ok(successorIntentSupportGroup);
  assert.equal(successorIntentSupportGroup.blocking, false);
  assert.deepEqual(successorIntentSupportGroup.unresolvedEventIds, ['intent-tier-support-old']);
  assert.equal(successorIntentProjection.demandGroups.some((group) => group.blocking), false);
  const encodedIntentSuccessor = api.encodeHistoryRetentionSidecar(successorIntentProjection);
  assert.doesNotThrow(() => api.decodeHistoryRetentionSidecar(encodedIntentSuccessor.chunk, {
    reference: encodedIntentSuccessor.reference,
    boundary: {
      authority: successorIntentProjection.authority,
      target: successorIntentProjection.target,
    },
  }), '旧 combined sidecar 的下一 suffix 必须发布为严格可解码 split sidecar');

  for (const missingCoreId of ['intent-tier-decision', 'intent-tier-action-old']) {
    const missingCoreEvents = events.map((event) => event.id === missingCoreId
      ? environment(`not-${missingCoreId}`, event.atMonth, event.orderInMonth) : event);
    const missingCoreProjection = completedProjectionFor(
      missingCoreEvents,
      (missingCoreId === 'intent-tier-decision' ? '4' : '3').repeat(64),
    );
    const legacyMissingCore = legacyCombinedIntentProjectionFor(missingCoreProjection.result);
    assert.throws(() => api.installVerifiedHistoryRetentionEvidence(
      missingCoreProjection.candidateShell,
      missingCoreProjection.result.authority.stateHash,
      legacyMissingCore,
      decodedColdPinsFor(
        missingCoreEvents,
        missingCoreProjection.candidateShell,
        legacyMissingCore,
      ),
    ), /阻断证据组/u, `旧 combined seam 不得放行缺失 executable core ${missingCoreId}`);
  }

  const legacyAgreementProjection = structuredClone(missingAgreementProjection.result);
  const legacyCoreGroup = legacyAgreementProjection.demandGroups.find(
    (group) => group.groupKey === 'live-agreement:agreement-1:anchors',
  );
  const legacySupportGroup = legacyAgreementProjection.demandGroups.find(
    (group) => group.groupKey === 'live-agreement:agreement-1:anchors:supporting-sources',
  );
  assert.ok(legacyCoreGroup && legacySupportGroup);
  legacyAgreementProjection.demandGroups = legacyAgreementProjection.demandGroups
    .filter((group) => group !== legacyCoreGroup && group !== legacySupportGroup)
    .concat({
      groupKey: legacyCoreGroup.groupKey,
      requirement: 'all',
      leaseKeys: [...legacyCoreGroup.leaseKeys],
      eventIds: [...new Set([...legacyCoreGroup.eventIds, ...legacySupportGroup.eventIds])].sort(),
      resolvedEventIds: [...new Set([
        ...legacyCoreGroup.resolvedEventIds,
        ...legacySupportGroup.resolvedEventIds,
      ])].sort(),
      unresolvedEventIds: [...legacySupportGroup.unresolvedEventIds],
      satisfied: false,
      blocking: true,
    })
    .sort((left, right) => left.groupKey.localeCompare(right.groupKey));
  legacyAgreementProjection.unresolvedDemands = legacyAgreementProjection.unresolvedDemands
    .map((demand) => demand.groupKey === legacySupportGroup.groupKey ? {
      ...demand,
      groupKey: legacyCoreGroup.groupKey,
      requirement: 'all',
      blocking: true,
    } : demand)
    .sort((left, right) => left.groupKey.localeCompare(right.groupKey)
      || left.eventId.localeCompare(right.eventId));
  const legacyDecodedPins = legacyAgreementProjection.pins
    .filter((pin) => pin.absoluteIndex < missingAgreementProjection.candidateShell.world.historyCursor.hotStartIndex)
    .map((pin) => ({
      ...pin,
      event: missingAgreementSource[pin.absoluteIndex],
    }));
  assert.doesNotThrow(() => api.installVerifiedHistoryRetentionEvidence(
    missingAgreementProjection.candidateShell,
    '9'.repeat(64),
    legacyAgreementProjection,
    legacyDecodedPins,
  ), '旧 sidecar 的 supporting-only blocker 应在核心已验证时原地迁移');

  const missingAgreementProposal = events.map((event) => event.id === 'agreement-proposal'
    ? environment('not-agreement-proposal', event.atMonth, event.orderInMonth) : event);
  const missingAgreementCoreProjection = completedProjectionFor(missingAgreementProposal, '8'.repeat(64));
  assert.throws(() => api.installVerifiedHistoryRetentionEvidence(
    missingAgreementCoreProjection.candidateShell,
    '8'.repeat(64),
    missingAgreementCoreProjection.result,
    [],
  ), /阻断证据组/u, 'live agreement 的 proposal/response 核心 anchor 缺失必须 fail-closed');

  const missingBirth = events.map((event) => event.id === 'child-birth'
    ? environment('not-a-birth', event.atMonth, event.orderInMonth) : event);
  const missingBirthFold = api.beginHistoryRetentionProjection(
    stateShell(missingBirth, [missingBirth.at(-1)]),
    { stateHash: 'f'.repeat(64) },
  );
  api.foldHistoryRetentionSegment(missingBirthFold, missingBirth, 0);
  assert.throws(() => api.finishHistoryRetentionProjection(missingBirthFold), /缺少权威出生事实/u);

  const fullReaderState = stateShell(events);
  const boundedReaderState = stateShell(events, [events.at(-1)]);
  const hotStartIndex = boundedReaderState.world.historyCursor.hotStartIndex;
  api.registerRetainedColdWorldEventFacts(
    boundedReaderState,
    projection.pins.filter((pin) => pin.absoluteIndex < hotStartIndex).map((pin) => ({
      absoluteIndex: pin.absoluteIndex,
      eventId: pin.eventId,
      event: events[pin.absoluteIndex],
      leaseKeys: pin.leaseKeys,
    })),
  );

  assert.deepEqual(
    api.__testDisputedWakeFactsForPendingPrediction(fullReaderState, fullReaderState.eraPredictions[0]).map((event) => event.id),
    api.__testDisputedWakeFactsForPendingPrediction(boundedReaderState, boundedReaderState.eraPredictions[0]).map((event) => event.id),
    'prediction gameplay reader 的 full/bounded 顺序必须一致',
  );
  assert.equal(
    api.__testBirthEventForSharedChild(fullReaderState, fullReaderState.people[0], fullReaderState.people[1])?.id,
    api.__testBirthEventForSharedChild(boundedReaderState, boundedReaderState.people[0], boundedReaderState.people[1])?.id,
    'family conversation gameplay reader 的 full/bounded latest birth 必须一致',
  );
  assert.deepEqual(
    {
      attempt: api.__testReproductionAttemptFactForIntent(
        fullReaderState, fullReaderState.intents[0], 5,
      )?.id,
      conception: api.__testReproductionConceptionFactForIntent(
        fullReaderState, fullReaderState.intents[0],
      )?.id,
    },
    {
      attempt: api.__testReproductionAttemptFactForIntent(
        boundedReaderState, boundedReaderState.intents[0], 5,
      )?.id,
      conception: api.__testReproductionConceptionFactForIntent(
        boundedReaderState, boundedReaderState.intents[0],
      )?.id,
    },
    'reproduction gameplay reader 的 full/bounded reverse-find 必须一致',
  );
  assert.deepEqual(
    api.recentPersonalProductionLaborEvents(fullReaderState, 'parent-a', 5).map((event) => event.id),
    api.recentPersonalProductionLaborEvents(boundedReaderState, 'parent-a', 5).map((event) => event.id),
    'production witness reader 的 full/bounded latest 必须一致',
  );
  const instrumentReceipt = {
    personId: 'parent-a', stackId: 'balance-1', materialId: 70, quantity: 1,
    heldQuantity: 1, sourceEventIds: ['balance-made'],
  };
  assert.equal(
    api.latestPersonalCalibrationFor(fullReaderState, 'parent-a', instrumentReceipt)?.id,
    api.latestPersonalCalibrationFor(boundedReaderState, 'parent-a', instrumentReceipt)?.id,
    'calibration reader 的 full/bounded canonical latest 必须一致',
  );
  assert.equal(api.latestPersonalCalibrationFor(boundedReaderState, 'parent-a', instrumentReceipt)?.id,
    'calibration-latest');

  for (const eventId of [
    'agreement-source-old', 'agreement-proposal', 'agreement-response',
    'intent-source-old', 'project-trigger', 'project-pressure-source', 'project-remote-source',
    'weight-made',
  ]) assert.equal(api.worldEventById?.(boundedReaderState, eventId)?.id, eventId);

  const encoded = api.encodeHistoryRetentionSidecar(projection);
  const boundary = { authority: projection.authority, target: projection.target };
  const decoded = api.decodeHistoryRetentionSidecar(encoded.chunk, {
    reference: encoded.reference, boundary,
  });
  assert.deepEqual(decoded.pins, projection.pins, '新增 selector 必须通过严格 codec round-trip');
  const forged = JSON.parse(brotliDecompressSync(Buffer.from(encoded.chunk.data)).toString('utf8'));
  const calibrationSelector = forged.continuationBasis.selectiveMatches
    .find((item) => item.leaseKey === 'gameplay:personal-mass-calibration:parent-a:balance-1');
  calibrationSelector.leaseKey = 'gameplay:personal-mass-calibration:forged:stack';
  const forgedData = Buffer.from(JSON.stringify(forged), 'utf8');
  const forgedHash = api.hashHistoryRetentionStoredContent(
    api.HISTORY_RETENTION_SIDECAR_LEGACY_CODEC,
    forgedData,
  );
  assert.throws(() => api.decodeHistoryRetentionSidecar({
    hash: forgedHash, codec: api.HISTORY_RETENTION_SIDECAR_LEGACY_CODEC,
    rawSize: forgedData.byteLength, data: forgedData,
  }, {
    reference: {
      kind: 'content-hash', codec: api.HISTORY_RETENTION_SIDECAR_LEGACY_CODEC, hash: forgedHash,
    },
    boundary,
  }), /非 source selector|basisHash/u, 'codec 不得放行任意 gameplay selector');

  const memoryUsage = process.memoryUsage();
  assert.ok(memoryUsage.rss < 256 * 1024 * 1024,
    'bounded gameplay fact lease fixture RSS 不得超过 256 MiB');
  console.log(JSON.stringify({
    result: 'passed',
    eventCount: events.length,
    pinCount: projection.pins.length,
    rssBytes: memoryUsage.rss,
  }, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
