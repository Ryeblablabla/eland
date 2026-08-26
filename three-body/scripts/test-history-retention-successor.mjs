import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-retention-successor-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'bundle.mjs');
const childEnvironment = { ...process.env, NODE_OPTIONS: '--max-old-space-size=256' };
const mechanicalOperationTechniqueId =
  'technique:mechanical-power:water-wheel-shaft-mill-operation';
const electricalOperationTechniqueId =
  'technique:electrical-power:mechanical-dynamo-conductor-resistive-load';
const electricalLoadTechniqueId =
  'technique:electrical-power:resistive-load-response:29:25';

function baseEvent(id, atMonth) {
  return {
    id, atMonth, orderInMonth: 0, planningTick: 1, orderInTick: 0, cellId: 0,
  };
}

function environment(id, atMonth) {
  return {
    ...baseEvent(id, atMonth), kind: 'environment', change: 'condition',
    result: id, diff: {},
  };
}

function decision(id, atMonth, usedModel = false) {
  return {
    ...baseEvent(id, atMonth), kind: 'decision', who: 'fixture-person', usedModel,
    decision: { kind: 'fixture', optionId: id, reason: id }, result: id,
  };
}

function action(id, atMonth, diff = {}) {
  return {
    ...baseEvent(id, atMonth),
    kind: 'action',
    actionTick: 1,
    who: 'fixture-person',
    cause: 'intent',
    action: { kind: 'act', operation: 'exert', targets: [] },
    fromCellId: 0,
    toCellId: 0,
    fromZ: 1,
    toZ: 1,
    pathSegment: [],
    status: 'completed',
    result: id,
    diff,
  };
}

function predictionAction(id, predictionId, atMonth) {
  const prediction = {
    targetEpoch: 'chaotic', predictedStartMonth: atMonth + 4,
    toleranceMonths: 3, expiresAtMonth: atMonth + 7,
  };
  return {
    ...baseEvent(id, atMonth), kind: 'action', actionTick: 1,
    who: 'fixture-person', cause: 'intent',
    action: {
      kind: 'communicate',
      content: { id: predictionId, kind: 'prediction', summary: 'fixture prediction', prediction },
      audience: ['fixture-person'], channel: 'voice',
    },
    fromCellId: 0, toCellId: 0, fromZ: 1, toZ: 1, pathSegment: [],
    status: 'completed', result: id,
    diff: { audience: ['fixture-person'], content: { id: predictionId, kind: 'prediction', summary: 'fixture prediction', prediction } },
  };
}

function predictionWakeAction(id, predictionId, atMonth) {
  return {
    ...action(id, atMonth, {
      rehydrationBasis: 'disputed-pending-prediction',
      hibernationPredictionId: predictionId,
      rehydratedPersonId: 'fixture-person',
    }),
    action: {
      kind: 'act', operation: 'rehydrate',
      targets: [{ kind: 'person', personId: 'fixture-person' }],
    },
  };
}

function agreementCommunication(id, who, content, audience, atMonth) {
  return {
    ...baseEvent(id, atMonth), kind: 'action', actionTick: 1,
    who, cause: 'intent',
    action: { kind: 'communicate', content, audience, channel: 'voice' },
    fromCellId: 0, toCellId: 0, fromZ: 1, toZ: 1, pathSegment: [],
    status: 'completed', result: id,
    diff: { audience, content },
  };
}

function state(history, label) {
  const elapsedMonths = history.at(-1)?.atMonth ?? 0;
  return {
    schemaVersion: 17,
    seed: 7,
    branchId: 'fixture-branch',
    label,
    clock: { unit: 'month', elapsedMonths, monthsPerYear: 12 },
    world: {
      past: history,
      historyCursor: {
        version: 1,
        eventCount: history.length,
        hotStartIndex: 0,
        tailEventId: history.at(-1)?.id ?? null,
      },
      mechanicalPower: { version: 'mechanical-power-world-v1', sources: [], networks: [] },
    },
    people: [{
      id: 'fixture-person',
      bornAtMonth: 0,
      body: { health: 80, hydration: 80, nutrition: 80 },
      memories: [],
      conditions: [],
      relations: [],
      bereavements: [],
      maternalTeachingSourceEventIds: [],
      geneticParents: [],
      inventory: [],
      knowledge: [{
        id: mechanicalOperationTechniqueId,
        kind: 'technique',
        confidence: 70,
        sourceEventIds: ['mechanical-service'],
      }, {
        id: electricalOperationTechniqueId,
        kind: 'technique',
        confidence: 70,
        sourceEventIds: ['electrical-operation'],
      }, {
        id: electricalLoadTechniqueId,
        kind: 'technique',
        confidence: 70,
        sourceEventIds: ['electrical-load'],
      }, {
        id: 'fixture-record-technique',
        kind: 'technique',
        confidence: 64,
        sourceEventIds: ['record-experiment'],
      }, {
        id: 'fixture-record-codebook',
        kind: 'codebook',
        confidence: 70,
        sourceEventIds: ['fixture-codebook-source'],
      }],
    }, {
      id: 'fixture-other-author', bornAtMonth: 0,
      body: { health: 80, hydration: 80, nutrition: 80 }, memories: [], conditions: [],
      relations: [], bereavements: [], maternalTeachingSourceEventIds: [], geneticParents: [],
      inventory: [], knowledge: [],
    }, {
      id: 'fixture/a', bornAtMonth: 0,
      body: { health: 80, hydration: 80, nutrition: 80 },
      memories: [{ id: 'fixture-memory-slash', sourceEventIds: ['mechanical-service'] }],
      conditions: [], relations: [], bereavements: [], maternalTeachingSourceEventIds: [],
      geneticParents: [], inventory: [], knowledge: [],
    }, {
      id: 'fixture_a', bornAtMonth: 0,
      body: { health: 80, hydration: 80, nutrition: 80 },
      memories: [{ id: 'fixture-memory-underscore', sourceEventIds: ['mechanical-service'] }],
      conditions: [], relations: [], bereavements: [], maternalTeachingSourceEventIds: [],
      geneticParents: [], inventory: [], knowledge: [],
    }],
    intents: [],
    agreements: [],
    eraPredictions: [],
    projects: [{
      id: 'fixture-record-project', status: 'completed', ownerId: 'fixture-person',
      desiredFunction: 'prepared-food', actionEventIds: ['record-experiment'],
      completionEventIds: ['record-experiment'], beneficiaryIds: [], contributorIds: [],
      triggerFactIds: [], reservations: [],
    }],
    records: [{
      id: 'fixture-record', authorId: 'fixture-other-author',
      knowledgeId: 'fixture-record-technique', codebookId: 'fixture-record-codebook',
      kind: 'technique', summary: 'fixture record', version: 1, createdAtMonth: 0,
      sourceEventIds: ['fixture-record-source'],
    }],
    containers: [],
    collectives: [],
    permissions: [],
  };
}

try {
  writeFileSync(entryPath, [
    `export * from ${JSON.stringify(path.resolve('server/history-retention-successor.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('server/history-retention-codec.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('server/history-retention-projection.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('server/run-state-codec.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('src/game/eland/domain/electrical-power.ts'))};`,
  ].join('\n'));
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { env: childEnvironment, stdio: 'pipe' });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  const chunks = new Map();
  const store = (snapshot) => {
    for (const chunk of [...snapshot.parts, snapshot.root]) chunks.set(chunk.hash, chunk);
    return snapshot;
  };
  const readChunk = (hash) => {
    const chunk = chunks.get(hash);
    if (!chunk) throw new Error(`fixture missing chunk ${hash}`);
    return chunk;
  };

  const prefix = [
    action('old-world-drop-source', 1),
    action('old-active-logistics-source', 1),
    action('remembered-cognitive-outcome', 1),
    action('remembered-old-offer', 1),
    action('remembered-old-response', 1),
    action('stored-food-container-created', 1),
    action('stored-food-transfer-old', 1),
    action('mechanical-service', 1, { mechanicalPowerOperation: true, mode: 'operate-service' }),
    action('electrical-operation', 1, {
      electricalPowerOperation: true,
      electricalPowerDelivered: true,
    }),
    action('electrical-load', 1, {
      electricalPowerOperation: true,
      electricalPowerDelivered: true,
      electricalPowerUsefulLoad: true,
      electricalNetworkId: 'fixture-electrical-network',
      inputMaterialId: 29,
      outputMaterialId: 25,
      loadTechniqueId: electricalLoadTechniqueId,
    }),
    action('record-experiment', 1, {
      recordUseStage: 'experiment',
      recordUseProjectId: 'fixture-record-project',
      recordUseRecordId: 'fixture-record',
      recordUseKnowledgeId: 'fixture-record-technique',
      recordUseTechniqueId: 'fixture-record-technique',
      recordUseReaderId: 'fixture-person',
      recordUseRecordAuthorId: 'fixture-other-author',
      recordUseExpectedOutputMaterialId: 25,
      recordUseKnowledgeConfidenceBefore: 46,
      recordUseKnowledgeConfidenceAfter: 64,
      outputMaterialId: 25,
    }),
    action('electrical-fault', 1, {
      electricalPowerFault: true,
      electricalNetworkId: 'fixture-electrical-network',
    }),
    environment('prefix-a', 1),
    decision('prefix-tail', 1),
  ];
  const dynamicPredictionId = 'predict-era:2:fixture-person:0';
  const dynamicAgreementId = 'offer-reproduce:2:fixture-person:fixture-other-author';
  const relationshipBasis = {
    version: 'relationship-causal-basis-v1',
    subjectKey: 'relationship:reproduce:fixture-other-author:fixture-person',
    basisKey: 'fixture-dynamic-agreement-basis',
    kind: 'reproduce',
    proposerId: 'fixture-person',
    partnerId: 'fixture-other-author',
    relationshipKeys: ['mechanical-service'],
    bodyKeys: ['family-readiness:visible-food-store:fixture-container:fixture-food-stack:2'],
    sourceFactIds: ['mechanical-service', 'stored-food-transfer-old'],
  };
  const suffix = [
    environment('suffix-a', 2),
    predictionAction('dynamic-prediction-source', dynamicPredictionId, 2),
    predictionWakeAction('dynamic-prediction-wake', dynamicPredictionId, 2),
    agreementCommunication(
      'dynamic-agreement-offer',
      'fixture-person',
      {
        id: dynamicAgreementId,
        kind: 'offer',
        summary: 'fixture family offer',
        proposal: {
          kind: 'reproduce', proposerId: 'fixture-person',
          partnerId: 'fixture-other-author', expiresAtMonth: 6,
          basis: relationshipBasis,
        },
      },
      ['fixture-other-author'],
      2,
    ),
    agreementCommunication(
      'dynamic-agreement-response',
      'fixture-other-author',
      { id: 'accept:fixture-dynamic-agreement', kind: 'accept', referenceId: dynamicAgreementId },
      ['fixture-person'],
      2,
    ),
    decision('suffix-tail', 2, true),
  ];
  const previousState = state(prefix, 'previous');
  const nextState = state([...prefix, ...suffix], 'next');
  for (const candidate of [previousState, nextState]) {
    candidate.people[0].cognition = {
      version: 'causal-bdi-v1',
      outcomeBeliefs: [{
        basisKey: 'fixture-cognitive-outcome', attempts: 1,
        completed: 1, progressed: 0, failed: 0,
        successAlpha: 2, successBeta: 1,
        expectedEffort: 0.2, expectedHarm: 0,
        firstObservedAtMonth: 1, lastUpdatedAtMonth: 1,
        sourceEventIds: ['remembered-cognitive-outcome'],
      }],
      goalOutcomeBeliefs: [],
      needResolutionEpisodes: [],
    };
    candidate.people[0].memories.push({
      id: 'memory:remembered-old-offer',
      sourceEventIds: ['remembered-old-offer'],
    });
    candidate.containers.push({
      id: 'fixture-container',
      position: { x: 0, y: 0, z: 1 },
      createdAtMonth: 1,
      sourceEventIds: ['stored-food-container-created'],
      inventory: [{
        id: 'fixture-food-stack', materialId: 21, quantity: 2,
        sourceEventIds: ['stored-food-transfer-old'],
      }],
    });
    candidate.agreements.push({
      id: 'remembered-resolved-agreement',
      proposal: {
        kind: 'reproduce', proposerId: 'fixture-person',
        partnerId: 'fixture-other-author', expiresAtMonth: 1,
        basis: relationshipBasis,
      },
      proposerId: 'fixture-person', responderId: 'fixture-other-author',
      partyIds: ['fixture-person', 'fixture-other-author'],
      requiredResponderIds: ['fixture-other-author'],
      acceptedByPersonIds: ['fixture-person'], rejectedByPersonIds: ['fixture-other-author'],
      status: 'rejected', proposedAtMonth: 1, acceptByMonth: 1, resolvedAtMonth: 1,
      proposalEventId: 'remembered-old-offer', responseEventId: 'remembered-old-response',
      fulfillmentEventIds: [], fulfilledByPersonIds: [], coLocatedMonths: 0,
      sourceEventIds: ['remembered-old-offer', 'remembered-old-response'],
    });
    candidate.projects.push({
      id: 'fixture-active-logistics-project', kind: 'production',
      need: 'production-efficiency', desiredFunction: 'efficient-production',
      summary: 'fixture active logistics', ownerId: 'fixture-person',
      beneficiaryIds: [], triggerFactIds: [], pressure: 60,
      createdAtMonth: 1, reviewAtMonth: 4,
      status: 'active', lastProgressAtMonth: 1,
      missingMaterialIds: [1], materialDemands: [], reservations: [],
      contributorIds: ['fixture-person'], actionEventIds: [], failureEventIds: [],
      completionEventIds: [],
      activeLogisticsEpisodeId: 'fixture-active-logistics-episode',
      logisticsEpisodes: [{
        id: 'fixture-active-logistics-episode', kind: 'drop', actorId: 'fixture-person',
        materialIds: [1], target: { cellId: 0, z: 1 },
        sourceRef: { kind: 'drop', dropId: 'fixture-world-drop' },
        sourceEventIds: ['old-active-logistics-source'],
        createdAt: 1, status: 'active', actionEventIds: [],
      }],
    });
  }
  nextState.agreements.push({
    id: dynamicAgreementId,
    proposal: {
      kind: 'reproduce', proposerId: 'fixture-person',
      partnerId: 'fixture-other-author', expiresAtMonth: 6,
      basis: relationshipBasis,
    },
    proposerId: 'fixture-person', responderId: 'fixture-other-author',
    partyIds: ['fixture-person', 'fixture-other-author'],
    requiredResponderIds: ['fixture-other-author'],
    acceptedByPersonIds: ['fixture-person', 'fixture-other-author'],
    rejectedByPersonIds: [], status: 'active', proposedAtMonth: 2,
    acceptByMonth: 6, acceptedAtMonth: 2, dueAtMonth: 7,
    proposalEventId: 'dynamic-agreement-offer',
    responseEventId: 'dynamic-agreement-response',
    fulfillmentEventIds: [], fulfilledByPersonIds: [], coLocatedMonths: 0,
    sourceEventIds: [
      'mechanical-service', 'stored-food-transfer-old', 'remembered-old-response',
      'remembered-cognitive-outcome',
      'dynamic-agreement-offer', 'dynamic-agreement-response',
    ],
  });
  nextState.eraPredictions.push({
    id: dynamicPredictionId,
    predictorId: 'fixture-person',
    audienceIds: ['fixture-person'],
    madeAtMonth: 2,
    targetEpoch: 'chaotic',
    predictedStartMonth: 6,
    toleranceMonths: 3,
    expiresAtMonth: 9,
    status: 'pending',
    sourceEventIds: ['dynamic-prediction-source'],
  });
  nextState.projects.push({
    id: 'new-project-reusing-old-knowledge', status: 'active', ownerId: 'fixture-person',
    desiredFunction: 'high-heat-processing', actionEventIds: [], completionEventIds: [],
    beneficiaryIds: [], contributorIds: [], reservations: [],
    triggerFactIds: ['mechanical-service'],
    pressureBasis: {
      version: 'project-pressure-basis-v1', need: 'high-heat-capability',
      observerId: 'fixture-person', atMonth: 2, pressure: 64,
      edgeKeys: ['state:knowledge:mechanical-service'], reasonKeys: ['known-technique'],
      sourceFactIds: ['mechanical-service'], basisKey: 'fixture-pressure-basis',
    },
    inquiryOpportunityBasis: {
      version: 'project-inquiry-opportunity-v1',
      basisKey: 'fixture-material-inquiry',
      sourceFactIds: ['old-world-drop-source'],
    },
  });
  nextState.intents.push({
    id: 'new-intent-reusing-old-knowledge', ownerId: 'fixture-person',
    summary: 'reuse old knowledge', domain: 'strategic',
    goal: { kind: 'project-completed', projectId: 'new-project-reusing-old-knowledge' },
    nextAction: { kind: 'act', operation: 'wait', targets: [] },
    status: 'active', createdAtMonth: 2, lastProgressAtMonth: 2, progress: 0,
    sourceDecisionEventId: 'suffix-tail',
    sourceFactIds: [
      'mechanical-service',
      'remembered-cognitive-outcome',
      'old-active-logistics-source',
    ],
    actionEventIds: [], replanCount: 0,
  });
  for (const candidate of [previousState, nextState]) {
    candidate.world.drops = [{
      id: 'fixture-world-drop', materialId: 1, cellId: 0, z: 1,
      quantity: 2, createdAtMonth: 1,
      sourceEventIds: ['old-world-drop-source'],
    }];
    candidate.world.electricalPower = {
      version: 'electrical-power-world-v1',
      dispatchWindows: [],
      networks: [{
        id: 'fixture-electrical-network',
        plan: { conductorPositions: [] },
        components: [],
        fault: {
          faultEventId: 'electrical-fault',
          sourceEventIds: ['electrical-operation'],
        },
      }],
    };
  }
  const previousRoot = store(await api.encodeSegmentedRunState(
    previousState,
    { mode: 'replace' },
    { maxEventsPerSegmentForTests: 1 },
  ));
  const nextRoot = store(await api.encodeSegmentedRunState(
    nextState,
    { mode: 'append', previous: previousRoot.metadata },
    { maxEventsPerSegmentForTests: 1 },
  ));

  const prefixFold = api.beginHistoryRetentionProjection(
    previousState,
    { stateHash: previousRoot.root.hash },
  );
  api.foldHistoryRetentionSegment(prefixFold, prefix, 0);
  const prefixProjection = api.finishHistoryRetentionProjection(prefixFold);
  const encodedPrefix = api.encodeHistoryRetentionSidecar(prefixProjection);
  const decodedPrefix = api.decodeHistoryRetentionSidecar(encodedPrefix.chunk, {
    reference: encodedPrefix.reference,
    boundary: {
      authority: { stateHash: previousRoot.root.hash },
      target: prefixProjection.target,
    },
  });
  const observerSelectorKeys = new Set(
    decodedPrefix.continuationBasis.selectiveMatches.map((item) => item.leaseKey),
  );
  assert.equal(
    observerSelectorKeys.has(
      'observer:modern-civilization:electrical-useful-load:fixture-electrical-network',
    ),
    true,
  );
  assert.equal(
    observerSelectorKeys.has('observer:modern-civilization:independent-record-experiment'),
    true,
  );
  const rememberedSourceGroup = decodedPrefix.demandGroups.find(
    (group) => group.groupKey === api.LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY,
  );
  assert.ok(rememberedSourceGroup, 'living project-pressure remembered sources 必须提前封存');
  assert.equal(rememberedSourceGroup.requirement, 'audit-only');
  assert.ok(rememberedSourceGroup.resolvedEventIds.includes('mechanical-service'));
  assert.ok(rememberedSourceGroup.unresolvedEventIds.includes('fixture-codebook-source'),
    'record/non-event source ID 可保留为非阻塞审计缺口');
  const futureStoredFoodGroup = decodedPrefix.demandGroups.find(
    (group) => group.groupKey === api.FUTURE_FAMILY_STORED_FOOD_SOURCE_LEASE_KEY,
  );
  assert.ok(futureStoredFoodGroup, '当前容器储粮来源必须在新家庭协议前提前封存');
  assert.equal(futureStoredFoodGroup.requirement, 'audit-only');
  assert.deepEqual(
    futureStoredFoodGroup.resolvedEventIds,
    ['stored-food-container-created', 'stored-food-transfer-old'],
  );
  const futureSocialRepetitionGroup = decodedPrefix.demandGroups.find(
    (group) => group.groupKey === api.FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY,
  );
  assert.ok(futureSocialRepetitionGroup, '被存活人物记住的旧协议结果来源必须提前封存');
  assert.equal(futureSocialRepetitionGroup.requirement, 'audit-only');
  assert.deepEqual(
    futureSocialRepetitionGroup.resolvedEventIds,
    ['remembered-old-offer', 'remembered-old-response'],
  );
  const futureCognitiveAppraisalGroup = decodedPrefix.demandGroups.find(
    (group) => group.groupKey === api.FUTURE_COGNITIVE_APPRAISAL_SOURCE_LEASE_KEY,
  );
  assert.ok(futureCognitiveAppraisalGroup, '存活人物当前认知评估来源必须在新意图前提前封存');
  assert.equal(futureCognitiveAppraisalGroup.requirement, 'index-only');
  assert.deepEqual(
    futureCognitiveAppraisalGroup.resolvedEventIds,
    ['remembered-cognitive-outcome'],
  );
  assert.equal(
    decodedPrefix.pins.some((pin) => (
      pin.leaseKeys.includes(api.FUTURE_COGNITIVE_APPRAISAL_SOURCE_LEASE_KEY)
    )),
    false,
    '认知前置桥只保存 exact continuation identity，不常驻旧事件正文',
  );
  assert.equal(
    decodedPrefix.continuationBasis.directMatches.some(
      (match) => match.eventId === 'remembered-cognitive-outcome',
    ),
    true,
    '认知前置桥仍须保存可提升为 strict demand 的准确序号',
  );
  const futureActiveLogisticsGroup = decodedPrefix.demandGroups.find(
    (group) => group.groupKey === api.FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_LEASE_KEY,
  );
  assert.ok(futureActiveLogisticsGroup, '当前 active logistics 来源必须在下一意图前提前建立索引');
  assert.equal(futureActiveLogisticsGroup.requirement, 'index-only');
  assert.deepEqual(futureActiveLogisticsGroup.resolvedEventIds, ['old-active-logistics-source']);
  assert.equal(
    decodedPrefix.pins.some((pin) => (
      pin.leaseKeys.includes(api.FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_LEASE_KEY)
    )),
    false,
    '活动物流前置桥只保留 exact identity，不常驻旧事件正文',
  );
  assert.equal(
    decodedPrefix.continuationBasis.directMatches.some(
      (match) => match.eventId === 'old-active-logistics-source',
    ),
    true,
    '活动物流前置桥必须保存可提升的准确序号',
  );
  const futureMaterialAffordanceGroup = decodedPrefix.demandGroups.find(
    (group) => group.groupKey === api.FUTURE_MATERIAL_AFFORDANCE_SOURCE_LEASE_KEY,
  );
  assert.ok(futureMaterialAffordanceGroup, '当前世界材料实体来源必须在新项目探究之前提前封存');
  assert.equal(futureMaterialAffordanceGroup.requirement, 'audit-only');
  assert.ok(futureMaterialAffordanceGroup.resolvedEventIds.includes('old-world-drop-source'));

  api.resetHistoryRetentionDemandCollectionCountForTests();
  const advanced = await api.projectHistoryRetentionFromVerifiedSuccessor(
    decodedPrefix,
    previousRoot.root,
    nextState,
    nextRoot.root,
    readChunk,
  );
  assert.deepEqual(
    api.historyRetentionDemandCollectionStatsForTests(),
    { collections: 1 },
    'exact-root successor 必须只收集一次 store-owned shell demand',
  );
  const decodedAdvanced = api.decodeHistoryRetentionSidecar(advanced.encoded.chunk, {
    reference: advanced.encoded.reference,
    boundary: {
      authority: { stateHash: nextRoot.root.hash },
      target: advanced.projection.target,
    },
  });
  api.assertHistoryRetentionProjectionMatchesVerifiedSuccessor(
    advanced,
    nextState,
    decodedAdvanced,
  );
  assert.deepEqual(
    api.historyRetentionDemandCollectionStatsForTests(),
    { collections: 1 },
    'strict-decoded successor 的 publication 复核不得再次扫描 shell demand',
  );
  const oracleFold = api.beginHistoryRetentionProjection(
    nextState,
    { stateHash: nextRoot.root.hash },
  );
  api.foldHistoryRetentionSegment(oracleFold, [...prefix, ...suffix], 0);
  const oracle = api.encodeHistoryRetentionSidecar(
    api.finishHistoryRetentionProjection(oracleFold),
  ).projection;
  assert.deepEqual(advanced.projection, oracle, 'exact-root incremental retention 必须等于 full oracle');
  assert.equal(advanced.suffixEventCount, suffix.length);
  assert.equal(advanced.nextRootHash, nextRoot.root.hash);
  assert.equal(
    advanced.projection.pins.some((pin) => pin.eventId === 'remembered-cognitive-outcome'
      && pin.leaseKeys.includes('live-intent:new-intent-reusing-old-knowledge:anchors')),
    true,
    'index-only cognitive match 被真实意图引用后必须提升为可解码 strict pin',
  );
  assert.equal(
    advanced.projection.pins.some((pin) => pin.eventId === 'old-active-logistics-source'
      && pin.leaseKeys.includes('live-intent:new-intent-reusing-old-knowledge:anchors')),
    true,
    'index-only logistics match 被真实意图引用后必须提升为可解码 strict pin',
  );
  assert.deepEqual(
    advanced.projection.continuationBasis.selectiveMatches.find(
      (item) => item.leaseKey
        === `gameplay:pending-era-prediction:${dynamicPredictionId}:disputed-wake`,
    )?.matches.map((match) => match.eventId),
    ['dynamic-prediction-wake'],
    '新预言必须只从已验证 suffix 承接 disputed-wake 事实',
  );
  const electricalGroups = new Map(
    advanced.projection.demandGroups.map((group) => [group.groupKey, group]),
  );
  const expectedElectricalLeases = [
    api.livingPersonElectricalOperationKnowledgeLeaseKey('fixture-person'),
    api.livingPersonElectricalLoadTechniqueKnowledgeLeaseKey(
      'fixture-person',
      electricalLoadTechniqueId,
    ),
    api.livingPersonElectricalMechanicalServiceLeaseKey('fixture-person'),
    api.currentElectricalNetworkFaultLeaseKey('fixture-electrical-network'),
  ];
  for (const leaseKey of expectedElectricalLeases) {
    const group = electricalGroups.get(leaseKey);
    assert.ok(group, `retention 必须生成 exact electrical lease ${leaseKey}`);
    assert.deepEqual(group.leaseKeys, [leaseKey]);
    assert.equal(group.satisfied, true);
  }
  api.assertVerifiedHistoryRetentionSuccessor(
    advanced,
    nextState,
    previousRoot.root.hash,
    nextRoot.root.hash,
  );

  // Simulate opening a checkpoint written before the logistics index-only
  // group existed: the next exact shell introduces an active episode and a
  // live intent that legitimately reuses one old prefix fact.
  const migrationPreviousState = structuredClone(previousState);
  migrationPreviousState.projects = migrationPreviousState.projects.filter(
    (project) => project.id !== 'fixture-active-logistics-project',
  );
  const migrationNextState = structuredClone(migrationPreviousState);
  migrationNextState.clock.elapsedMonths = 2;
  migrationNextState.world.past = [...prefix, ...suffix];
  migrationNextState.world.historyCursor = {
    version: 1,
    eventCount: migrationNextState.world.past.length,
    hotStartIndex: 0,
    tailEventId: migrationNextState.world.past.at(-1).id,
  };
  migrationNextState.projects.push(structuredClone(
    previousState.projects.find((project) => project.id === 'fixture-active-logistics-project'),
  ));
  migrationNextState.intents.push({
    id: 'legacy-checkpoint-logistics-intent', ownerId: 'fixture-person',
    summary: 'reuse legacy logistics provenance', domain: 'strategic',
    goal: { kind: 'project-completed', projectId: 'fixture-active-logistics-project' },
    nextAction: { kind: 'act', operation: 'wait', targets: [] },
    status: 'active', createdAtMonth: 2, lastProgressAtMonth: 2, progress: 0,
    sourceDecisionEventId: 'suffix-tail',
    sourceFactIds: ['old-active-logistics-source'],
    actionEventIds: [], replanCount: 0,
  });
  const migrationPreviousRoot = store(await api.encodeSegmentedRunState(
    migrationPreviousState,
    { mode: 'replace' },
    { maxEventsPerSegmentForTests: 1 },
  ));
  const migrationNextRoot = store(await api.encodeSegmentedRunState(
    migrationNextState,
    { mode: 'append', previous: migrationPreviousRoot.metadata },
    { maxEventsPerSegmentForTests: 1 },
  ));
  const migrationPrefixFold = api.beginHistoryRetentionProjection(
    migrationPreviousState,
    { stateHash: migrationPreviousRoot.root.hash },
  );
  api.foldHistoryRetentionSegment(migrationPrefixFold, prefix, 0);
  const migrationPrefixProjection = api.finishHistoryRetentionProjection(migrationPrefixFold);
  assert.equal(
    migrationPrefixProjection.demandGroups.some(
      (group) => group.groupKey === api.FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_LEASE_KEY,
    ),
    false,
    'legacy fixture 的 source checkpoint 不应预含新 logistics index group',
  );
  const migrationEncodedPrefix = api.encodeHistoryRetentionSidecar(migrationPrefixProjection);
  const migrationDecodedPrefix = api.decodeHistoryRetentionSidecar(migrationEncodedPrefix.chunk, {
    reference: migrationEncodedPrefix.reference,
    boundary: {
      authority: { stateHash: migrationPreviousRoot.root.hash },
      target: migrationPrefixProjection.target,
    },
  });
  const migrated = await api.projectHistoryRetentionFromVerifiedSuccessor(
    migrationDecodedPrefix,
    migrationPreviousRoot.root,
    migrationNextState,
    migrationNextRoot.root,
    readChunk,
  );
  assert.equal(
    migrated.projection.pins.some((pin) => pin.eventId === 'old-active-logistics-source'
      && pin.leaseKeys.includes('live-intent:legacy-checkpoint-logistics-intent:anchors')),
    true,
    'legacy checkpoint 只能经 exact previous-root scan 将 logistics identity 提升为 strict pin',
  );

  const forgedPredictionState = structuredClone(nextState);
  forgedPredictionState.world.past = [...prefix, ...suffix.map((event) => (
    event.id === 'dynamic-prediction-source'
      ? environment('dynamic-prediction-source', 2)
      : structuredClone(event)
  ))];
  forgedPredictionState.world.historyCursor = {
    version: 1,
    eventCount: forgedPredictionState.world.past.length,
    hotStartIndex: 0,
    tailEventId: forgedPredictionState.world.past.at(-1).id,
  };
  const forgedPredictionRoot = store(await api.encodeSegmentedRunState(
    forgedPredictionState,
    { mode: 'append', previous: previousRoot.metadata },
    { maxEventsPerSegmentForTests: 1 },
  ));
  const decodedPrefixForForgery = api.decodeHistoryRetentionSidecar(encodedPrefix.chunk, {
    reference: encodedPrefix.reference,
    boundary: {
      authority: { stateHash: previousRoot.root.hash },
      target: prefixProjection.target,
    },
  });
  await assert.rejects(
    api.projectHistoryRetentionFromVerifiedSuccessor(
      decodedPrefixForForgery,
      previousRoot.root,
      forgedPredictionState,
      forgedPredictionRoot.root,
      readChunk,
    ),
    /新 pending prediction .* 缺少 suffix 权威创建事实/u,
    '仅在 shell 声称新增 prediction、没有真实创建通信时必须 fail-closed',
  );

  await assert.rejects(
    api.projectHistoryRetentionFromVerifiedSuccessor(
      structuredClone(decodedPrefix),
      previousRoot.root,
      nextState,
      nextRoot.root,
      readChunk,
    ),
    /strict sidecar decoder/u,
  );

  const wrongPreviousState = state(prefix, 'wrong-previous-shell');
  const wrongPreviousRoot = store(await api.encodeSegmentedRunState(
    wrongPreviousState,
    { mode: 'replace' },
  ));
  await assert.rejects(
    api.projectHistoryRetentionFromVerifiedSuccessor(
      decodedPrefix,
      wrongPreviousRoot.root,
      nextState,
      nextRoot.root,
      readChunk,
    ),
    /previous root boundary/u,
  );

  const replacementNext = store(await api.encodeSegmentedRunState(
    nextState,
    { mode: 'replace' },
  ));
  await assert.rejects(
    api.projectHistoryRetentionFromVerifiedSuccessor(
      decodedPrefix,
      previousRoot.root,
      nextState,
      replacementNext.root,
      readChunk,
    ),
    /lineage|previous root/u,
  );

  const mismatchedNextState = structuredClone(nextState);
  mismatchedNextState.world.historyCursor.tailEventId = 'forged-tail';
  await assert.rejects(
    api.projectHistoryRetentionFromVerifiedSuccessor(
      decodedPrefix,
      previousRoot.root,
      mismatchedNextState,
      nextRoot.root,
      readChunk,
    ),
    /history cursor/u,
  );

  assert.throws(
    () => api.assertVerifiedHistoryRetentionSuccessor(
      { ...advanced },
      nextState,
      previousRoot.root.hash,
      nextRoot.root.hash,
    ),
    /不属于指定/u,
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    previousEvents: prefix.length,
    nextEvents: prefix.length + suffix.length,
    pins: advanced.projection.pins.length,
    rssBytes: process.memoryUsage().rss,
  })}\n`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
