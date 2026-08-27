import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync } from 'node:zlib';

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

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, canonicalJsonValue(value[key])]));
}

function legacyMissingProjectPressureSidecar(api, currentProjection) {
  const legacy = structuredClone(currentProjection);
  const leaseKey = api.LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY;
  const current = legacy.demandGroups.filter((group) => group.groupKey === leaseKey);
  assert.equal(current.length, 1);
  assert.equal(current[0].requirement, 'index-only');
  assert.deepEqual(current[0].leaseKeys, [leaseKey]);
  assert.deepEqual(current[0].eventIds, []);
  assert.deepEqual(current[0].resolvedEventIds, []);
  assert.deepEqual(current[0].unresolvedEventIds, []);
  assert.equal(legacy.pins.some((pin) => pin.leaseKeys.includes(leaseKey)), false);
  assert.equal(legacy.unresolvedDemands.some((item) => (
    item.groupKey === leaseKey || item.leaseKeys.includes(leaseKey)
  )), false);
  legacy.demandGroups = legacy.demandGroups.filter((group) => group.groupKey !== leaseKey);
  legacy.continuationBasis.sourceDemand.groups =
    legacy.continuationBasis.sourceDemand.groups.filter((group) => group.groupKey !== leaseKey);
  const { basisHash: _discardedBasisHash, ...basisWithoutHash } = legacy.continuationBasis;
  legacy.continuationBasis.basisHash = createHash('sha256')
    .update('eland-history-retention-continuation-v1\0')
    .update(JSON.stringify(basisWithoutHash))
    .digest('hex');
  const canonical = Buffer.from(JSON.stringify(canonicalJsonValue(legacy)), 'utf8');
  const data = brotliCompressSync(canonical);
  const codec = api.HISTORY_RETENTION_SIDECAR_CODEC;
  const hash = api.hashHistoryRetentionStoredContent(codec, data);
  return {
    projection: legacy,
    chunk: { hash, codec, rawSize: data.byteLength, data },
    reference: { kind: 'content-hash', codec, hash },
  };
}

function legacyAuditFutureSocialSidecar(api, currentProjection) {
  const legacy = structuredClone(currentProjection);
  const leaseKey = api.FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY;
  const group = legacy.demandGroups.find((candidate) => candidate.groupKey === leaseKey);
  const sourceGroup = legacy.continuationBasis.sourceDemand.groups
    .find((candidate) => candidate.groupKey === leaseKey);
  assert.ok(group, 'fixture 必须含 future social-repetition group');
  assert.ok(sourceGroup, 'fixture continuation demand 必须含 future social-repetition group');
  assert.equal(group.requirement, 'index-only');
  assert.equal(sourceGroup.requirement, 'index-only');
  group.requirement = 'audit-only';
  sourceGroup.requirement = 'audit-only';
  legacy.unresolvedDemands = legacy.unresolvedDemands.map((item) => (
    item.groupKey === leaseKey ? { ...item, requirement: 'audit-only' } : item
  ));

  const pinsByOrdinal = new Map(
    legacy.pins.map((pin) => [pin.absoluteIndex, { ...pin, leaseKeys: [...pin.leaseKeys] }]),
  );
  const directMatchById = new Map(
    legacy.continuationBasis.directMatches.map((match) => [match.eventId, match]),
  );
  for (const eventId of group.resolvedEventIds) {
    const match = directMatchById.get(eventId);
    assert.ok(match, `legacy social resolved event ${eventId} 必须有 direct match`);
    const pin = pinsByOrdinal.get(match.absoluteIndex) ?? { ...match, leaseKeys: [] };
    pin.leaseKeys = [...new Set([...pin.leaseKeys, leaseKey])].sort();
    pinsByOrdinal.set(match.absoluteIndex, pin);
  }
  legacy.pins = [...pinsByOrdinal.values()]
    .sort((left, right) => left.absoluteIndex - right.absoluteIndex);
  const { basisHash: _discardedBasisHash, ...basisWithoutHash } = legacy.continuationBasis;
  legacy.continuationBasis.basisHash = createHash('sha256')
    .update('eland-history-retention-continuation-v1\0')
    .update(JSON.stringify(basisWithoutHash))
    .digest('hex');

  const canonical = Buffer.from(JSON.stringify(canonicalJsonValue(legacy)), 'utf8');
  const data = brotliCompressSync(canonical);
  const codec = api.HISTORY_RETENTION_SIDECAR_CODEC;
  const hash = api.hashHistoryRetentionStoredContent(codec, data);
  return {
    projection: legacy,
    chunk: { hash, codec, rawSize: data.byteLength, data },
    reference: { kind: 'content-hash', codec, hash },
  };
}

function withoutProjectPressureSources(input) {
  const stateWithoutSources = structuredClone(input);
  for (const person of stateWithoutSources.people) {
    person.memories = person.memories.map((memory) => ({ ...memory, sourceEventIds: [] }));
    person.conditions = person.conditions.map((condition) => ({
      ...condition,
      sourceEventIds: [],
    }));
    person.knowledge = person.knowledge.map((fact) => ({ ...fact, sourceEventIds: [] }));
    person.inventory = person.inventory.map((stack) => ({ ...stack, sourceEventIds: [] }));
  }
  return stateWithoutSources;
}

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

function personalHuntFailure(id, atMonth, animalId, orderInMonth = 0) {
  return {
    ...action(id, atMonth, { animalId, killed: false }),
    orderInMonth,
    status: 'failed',
    action: { kind: 'act', operation: 'hunt', targets: [] },
  };
}

function personalDehydration(id, atMonth) {
  return {
    ...action(id, atMonth),
    action: { kind: 'act', operation: 'dehydrate', targets: [] },
  };
}

function animalAttack(id, atMonth, victimId) {
  return {
    ...baseEvent(id, atMonth), kind: 'environment', change: 'animal', result: id,
    diff: { process: 'attack-human', victimId },
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
    `export * from ${JSON.stringify(path.resolve('server/retained-history-evidence.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('server/run-state-codec.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('src/game/eland/domain/electrical-power.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('src/game/eland/domain/event-index.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('src/game/eland/domain/project-pressure-evidence.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('src/game/eland/application/project-pressure.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('src/game/eland/world/generator.ts'))};`,
  ].join('\n'));
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { env: childEnvironment, stdio: 'pipe' });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  const huntEvidence = [
    personalHuntFailure('hunt-1', 1, 'animal-1'),
    personalHuntFailure('hunt-2', 2, 'animal-2'),
    personalHuntFailure('hunt-3-old', 3, 'animal-3', 0),
    personalHuntFailure('hunt-3-new', 3, 'animal-3', 1),
    personalHuntFailure('hunt-4', 4, 'animal-4'),
  ];
  const attackEvidence = [
    animalAttack('attack-1', 5, 'fixture-person'),
    animalAttack('attack-2', 6, 'fixture-person'),
    animalAttack('attack-3', 7, 'fixture-person'),
  ];
  const dehydrationEvidence = Array.from(
    { length: 6 },
    (_, index) => personalDehydration(`dehydrate-${index}`, 8 + index),
  );
  const developmentEvidence = Array.from(
    { length: 26 },
    (_, index) => environment(`development-${index}`, 20 + index),
  );
  const unrelatedEvidence = Array.from(
    { length: 40 },
    (_, index) => decision(`unrelated-${index}`, 50 + index),
  );
  const rememberedEvidence = [
    ...huntEvidence,
    ...attackEvidence,
    ...dehydrationEvidence,
    ...developmentEvidence,
    ...unrelatedEvidence,
  ];
  const descriptors = rememberedEvidence.map(
    api.projectPressureEvidenceDescriptorFromWorldEvent,
  );
  const selected = api.selectProjectPressureEvidenceDescriptors(
    [...descriptors].reverse(),
    'fixture-person',
    100,
  );
  assert.deepEqual(selected.huntFailures.map((item) => item.eventId), [
    'hunt-2', 'hunt-3-new', 'hunt-4',
  ], 'hunt failure 必须按 canonical order 取最后三个 distinct month+animal edge');
  assert.deepEqual(selected.animalAttacks.map((item) => item.eventId), ['attack-2', 'attack-3']);
  assert.deepEqual(
    selected.dehydrations.map((item) => item.eventId),
    ['dehydrate-1', 'dehydrate-2', 'dehydrate-3', 'dehydrate-4', 'dehydrate-5'],
  );
  assert.deepEqual(
    selected.developmentProvenance.map((item) => item.eventId),
    Array.from({ length: 24 }, (_, index) => `development-${index + 2}`),
  );
  const attackDescriptor = api.projectPressureEvidenceDescriptorFromWorldEvent(attackEvidence[0]);
  const dehydrationDescriptor = api.projectPressureEvidenceDescriptorFromWorldEvent(
    dehydrationEvidence[0],
  );
  assert.equal(attackDescriptor.attackVictimId, 'fixture-person');
  assert.equal(attackDescriptor.developmentEligible, true, 'attack 与 development flag 必须重叠');
  assert.equal(dehydrationDescriptor.dehydrateOwnerId, 'fixture-person');
  assert.equal(dehydrationDescriptor.developmentEligible, true,
    'completed dehydrate 与 development flag 必须重叠');

  const fourDistinctHunts = [
    personalHuntFailure('backfill-1', 101, 'a'),
    personalHuntFailure('backfill-2', 102, 'b'),
    personalHuntFailure('backfill-3', 103, 'c'),
    personalHuntFailure('backfill-4', 104, 'd'),
  ].map(api.projectPressureEvidenceDescriptorFromWorldEvent);
  assert.deepEqual(api.selectProjectPressureEvidenceDescriptors(
    fourDistinctHunts,
    'fixture-person',
    104,
  ).huntFailures.map((item) => item.eventId), ['backfill-2', 'backfill-3', 'backfill-4']);
  assert.deepEqual(api.selectProjectPressureEvidenceDescriptors(
    fourDistinctHunts.slice(0, 3),
    'fixture-person',
    104,
  ).huntFailures.map((item) => item.eventId), ['backfill-1', 'backfill-2', 'backfill-3'],
  '当前 source 删除第4条后，第1条必须回填，不能依赖旧 top-N body');

  const fullHistory = [...rememberedEvidence];
  const boundedEvidenceState = state(fullHistory, 'bounded-project-pressure-descriptors');
  const rememberedIds = rememberedEvidence.map((event) => event.id);
  boundedEvidenceState.people[0].knowledge = [];
  boundedEvidenceState.people[0].memories = [{ id: 'pressure-memory', sourceEventIds: rememberedIds }];
  const hotStartIndex = fullHistory.length - 2;
  boundedEvidenceState.world.past = fullHistory.slice(hotStartIndex);
  boundedEvidenceState.world.historyCursor.hotStartIndex = hotStartIndex;
  api.registerProjectPressureEvidenceDescriptors(
    boundedEvidenceState,
    fullHistory.map((event, absoluteIndex) => ({
      absoluteIndex,
      descriptor: api.projectPressureEvidenceDescriptorFromWorldEvent(event),
    })),
  );
  const boundedDescriptors = api.projectPressureEvidenceDescriptorsForPerson(
    boundedEvidenceState,
    boundedEvidenceState.people[0],
  );
  assert.deepEqual(
    api.selectProjectPressureEvidenceDescriptors(
      boundedDescriptors,
      'fixture-person',
      100,
    ),
    api.selectProjectPressureEvidenceDescriptors(descriptors, 'fixture-person', 100),
    'full history 与 owner-scoped body-free bounded descriptor 必须选择相同 evidence',
  );
  assert.deepEqual(api.projectPressureEvidenceDescriptorsForPerson(
    boundedEvidenceState,
    boundedEvidenceState.people[1],
  ), [], '人物 B 不得借人物 A 当前 source IDs 读取 descriptor');
  assert.throws(
    () => api.projectPressureEvidenceDescriptorsForPerson(
      boundedEvidenceState,
      { ...boundedEvidenceState.people[0] },
    ),
    /owner 不是当前存活人物/u,
    'detached/foreign owner 不得读取另一人物 descriptor',
  );
  assert.throws(
    () => api.registerProjectPressureEvidenceDescriptors(boundedEvidenceState, [{
      absoluteIndex: hotStartIndex,
      descriptor: api.projectPressureEvidenceDescriptorFromWorldEvent(fullHistory[hotStartIndex + 1]),
    }]),
    /hot descriptor|identity\/ordinal/u,
    '错误 ordinal/eventId 必须拒绝',
  );

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

  const rememberedAgreementId = 'offer-reproduce:1:fixture-person:fixture-other-author';
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
  const prefix = [
    action('old-world-drop-source', 1),
    action('old-active-logistics-source', 1),
    action('remembered-cognitive-outcome', 1),
    agreementCommunication(
      'remembered-old-offer',
      'fixture-person',
      {
        id: rememberedAgreementId,
        kind: 'offer',
        summary: 'fixture remembered family offer',
        proposal: {
          kind: 'reproduce', proposerId: 'fixture-person',
          partnerId: 'fixture-other-author', expiresAtMonth: 1,
          basis: relationshipBasis,
        },
      },
      ['fixture-other-author'],
      1,
    ),
    agreementCommunication(
      'remembered-old-response',
      'fixture-other-author',
      { id: 'reject:fixture-remembered-agreement', kind: 'reject', referenceId: rememberedAgreementId },
      ['fixture-person'],
      1,
    ),
    action('remembered-old-outcome', 1),
    action('social-repetition-bridge-only-prefix', 1),
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
    action('project-pressure-bridge-only-prefix', 1),
    environment('prefix-a', 1),
    decision('prefix-tail', 1),
  ];
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
    }, {
      id: 'memory:remembered-old-response',
      sourceEventIds: ['remembered-old-response'],
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
      sourceEventIds: [
        'remembered-old-offer',
        'remembered-old-response',
        'remembered-old-outcome',
      ],
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
  nextState.agreements.find((agreement) => (
    agreement.id === 'remembered-resolved-agreement'
  )).sourceEventIds.push('social-repetition-bridge-only-prefix');
  nextState.people[0].memories.push({
    id: 'new-memory-of-old-prefix-pressure-source',
    sourceEventIds: ['project-pressure-bridge-only-prefix'],
  });
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
    acceptByMonth: 6, acceptedAtMonth: 2, dueAtMonth: 5,
    proposalEventId: 'dynamic-agreement-offer',
    responseEventId: 'dynamic-agreement-response',
    fulfillmentEventIds: [], fulfilledByPersonIds: [], coLocatedMonths: 0,
    sourceEventIds: [
      'mechanical-service', 'stored-food-transfer-old', 'remembered-old-response',
      'remembered-cognitive-outcome',
      'dynamic-agreement-offer', 'dynamic-agreement-response',
    ],
  });
  previousState.intents.push({
    id: 'intent-promoted-to-reproduction', ownerId: 'fixture-person',
    summary: 'wait before accepted family agreement', domain: 'social',
    goal: { kind: 'at-cell', cellId: 0, z: 1 },
    nextAction: { kind: 'act', operation: 'wait', targets: [] },
    status: 'active', createdAtMonth: 1, lastProgressAtMonth: 1, progress: 0,
    sourceDecisionEventId: 'prefix-tail', sourceFactIds: [], actionEventIds: [], replanCount: 0,
  });
  nextState.intents.push({
    id: 'intent-promoted-to-reproduction', ownerId: 'fixture-person',
    summary: 'continue after accepted family agreement', domain: 'social',
    goal: {
      kind: 'condition', personId: 'fixture-other-author', condition: 'pregnancy', present: true,
    },
    nextAction: {
      kind: 'act', operation: 'reproduce', authorizationRef: dynamicAgreementId,
      targets: [{ kind: 'person', personId: 'fixture-other-author' }],
    },
    status: 'active', createdAtMonth: 1, lastProgressAtMonth: 2, progress: 0,
    sourceDecisionEventId: 'prefix-tail', sourceFactIds: [], actionEventIds: [], replanCount: 0,
    agreementId: dynamicAgreementId, reproductionAttemptEventIdsAtStart: [],
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
      'social-repetition-bridge-only-prefix',
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
  const legacySocialSidecar = legacyAuditFutureSocialSidecar(api, prefixProjection);
  assert.throws(
    () => api.encodeHistoryRetentionSidecar(legacySocialSidecar.projection),
    /future social-repetition source selector/u,
    '新 encoder 不得再次发布 future social-repetition audit bodies',
  );
  assert.equal(
    api.historyRetentionDemandFingerprint(
      legacySocialSidecar.projection.continuationBasis.sourceDemand,
    ),
    prefixProjection.demandFingerprint,
    'future social storage refinement 必须保持 legacy domain-demand fingerprint',
  );
  const decodedLegacySocial = api.decodeHistoryRetentionSidecar(
    legacySocialSidecar.chunk,
    {
      reference: legacySocialSidecar.reference,
      boundary: {
        authority: { stateHash: previousRoot.root.hash },
        target: prefixProjection.target,
      },
    },
  );
  api.assertHistoryRetentionProjectionMatchesShell(previousState, decodedLegacySocial);
  const socialLegacyHotStartIndex = prefix.length - 2;
  const socialLegacyBoundedState = structuredClone(previousState);
  socialLegacyBoundedState.world.past = prefix.slice(socialLegacyHotStartIndex);
  socialLegacyBoundedState.world.historyCursor.hotStartIndex = socialLegacyHotStartIndex;
  const socialLegacyColdPins = decodedLegacySocial.pins
    .filter((pin) => pin.absoluteIndex < socialLegacyHotStartIndex)
    .map((pin) => ({ absoluteIndex: pin.absoluteIndex, event: prefix[pin.absoluteIndex] }));
  api.installVerifiedHistoryRetentionEvidence(
    socialLegacyBoundedState,
    previousRoot.root.hash,
    decodedLegacySocial,
    socialLegacyColdPins,
  );
  assert.deepEqual(
    api.retainedColdWorldEventsForLease(
      socialLegacyBoundedState,
      api.FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY,
    ),
    [],
    'legacy future-social audit body 不得进入通用 gameplay cold index',
  );
  assert.equal(
    api.worldEventById(socialLegacyBoundedState, 'remembered-old-outcome'),
    undefined,
    '仅由 future-social legacy lease 保留的 outcome 正文不得泄漏给人物',
  );
  const legacyPrefixProjection = structuredClone(prefixProjection);
  const legacyGlobalGroup = legacyPrefixProjection.demandGroups.find(
    (group) => group.groupKey === api.LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY,
  );
  legacyGlobalGroup.requirement = 'audit-only';
  legacyPrefixProjection.unresolvedDemands = legacyPrefixProjection.unresolvedDemands
    .map((item) => item.groupKey === api.LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY
      ? { ...item, requirement: 'audit-only' }
      : item);
  const legacySourceGlobalGroup = legacyPrefixProjection.continuationBasis.sourceDemand.groups
    .find((group) => group.groupKey === api.LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY);
  legacySourceGlobalGroup.requirement = 'audit-only';
  const legacyPinsByOrdinal = new Map(
    legacyPrefixProjection.pins.map((pin) => [pin.absoluteIndex, { ...pin }]),
  );
  const directMatchById = new Map(
    legacyPrefixProjection.continuationBasis.directMatches
      .map((match) => [match.eventId, match]),
  );
  for (const eventId of legacyGlobalGroup.resolvedEventIds) {
    const match = directMatchById.get(eventId);
    assert.ok(match, `legacy global resolved event ${eventId} 必须有 direct match`);
    const pin = legacyPinsByOrdinal.get(match.absoluteIndex) ?? {
      ...match,
      leaseKeys: [],
    };
    pin.leaseKeys = [...new Set([
      ...pin.leaseKeys,
      api.LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY,
    ])].sort();
    legacyPinsByOrdinal.set(match.absoluteIndex, pin);
  }
  legacyPrefixProjection.pins = [...legacyPinsByOrdinal.values()]
    .sort((left, right) => left.absoluteIndex - right.absoluteIndex);
  const { basisHash: _discardedBasisHash, ...legacyBasisWithoutHash } =
    legacyPrefixProjection.continuationBasis;
  legacyPrefixProjection.continuationBasis.basisHash = createHash('sha256')
    .update('eland-history-retention-continuation-v1\0')
    .update(JSON.stringify(legacyBasisWithoutHash))
    .digest('hex');
  assert.equal(
    api.historyRetentionDemandFingerprint(
      legacyPrefixProjection.continuationBasis.sourceDemand,
    ),
    prefixProjection.demandFingerprint,
    'index-only storage refinement 必须保持 legacy domain-demand fingerprint',
  );
  const encodedLegacyPrefix = api.encodeHistoryRetentionSidecar(legacyPrefixProjection);
  const decodedLegacyPrefix = api.decodeHistoryRetentionSidecar(encodedLegacyPrefix.chunk, {
    reference: encodedLegacyPrefix.reference,
    boundary: {
      authority: { stateHash: previousRoot.root.hash },
      target: legacyPrefixProjection.target,
    },
  });
  api.assertHistoryRetentionProjectionMatchesShell(previousState, decodedLegacyPrefix);
  const legacyHotStartIndex = prefix.length - 2;
  const legacyBoundedState = structuredClone(previousState);
  legacyBoundedState.world.past = prefix.slice(legacyHotStartIndex);
  legacyBoundedState.world.historyCursor.hotStartIndex = legacyHotStartIndex;
  const legacyDecodedColdPins = decodedLegacyPrefix.pins
    .filter((pin) => pin.absoluteIndex < legacyHotStartIndex)
    .map((pin) => ({ absoluteIndex: pin.absoluteIndex, event: prefix[pin.absoluteIndex] }));
  api.installVerifiedHistoryRetentionEvidence(
    legacyBoundedState,
    previousRoot.root.hash,
    decodedLegacyPrefix,
    legacyDecodedColdPins,
  );
  assert.deepEqual(
    api.retainedColdWorldEventsForLease(
      legacyBoundedState,
      api.LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY,
    ),
    [],
    'legacy broad audit body 必须转 descriptor，不能保留 project-pressure generic cold lease',
  );
  assert.ok(api.projectPressureEvidenceDescriptorsForPerson(
    legacyBoundedState,
    legacyBoundedState.people[0],
  ).some((descriptor) => descriptor.eventId === 'mechanical-service'),
  'legacy cold-open 必须为当前 owner 安装 body-free descriptor');

  const emptyLegacyPreviousState = withoutProjectPressureSources(previousState);
  const emptyLegacyNextState = structuredClone(emptyLegacyPreviousState);
  emptyLegacyNextState.clock.elapsedMonths = 2;
  emptyLegacyNextState.world.past = [...prefix, ...suffix];
  emptyLegacyNextState.world.historyCursor = {
    version: 1,
    eventCount: emptyLegacyNextState.world.past.length,
    hotStartIndex: 0,
    tailEventId: emptyLegacyNextState.world.past.at(-1).id,
  };
  emptyLegacyNextState.lastStep = [...suffix];
  const emptyLegacyPreviousRoot = store(await api.encodeSegmentedRunState(
    emptyLegacyPreviousState,
    { mode: 'replace' },
    { maxEventsPerSegmentForTests: 1 },
  ));
  const emptyLegacyNextRoot = store(await api.encodeSegmentedRunState(
    emptyLegacyNextState,
    { mode: 'append', previous: emptyLegacyPreviousRoot.metadata },
    { maxEventsPerSegmentForTests: 1 },
  ));
  const emptyLegacyFold = api.beginHistoryRetentionProjection(
    emptyLegacyPreviousState,
    { stateHash: emptyLegacyPreviousRoot.root.hash },
  );
  api.foldHistoryRetentionSegment(emptyLegacyFold, prefix, 0);
  const emptyCurrentProjection = api.finishHistoryRetentionProjection(emptyLegacyFold);
  const missingLegacySidecar = legacyMissingProjectPressureSidecar(
    api,
    emptyCurrentProjection,
  );
  assert.throws(
    () => api.encodeHistoryRetentionSidecar(missingLegacySidecar.projection),
    /project-pressure global group/u,
    '新 encoder 不得再次发布 missing project-pressure group',
  );
  const decodedMissingLegacy = api.decodeHistoryRetentionSidecar(
    missingLegacySidecar.chunk,
    {
      reference: missingLegacySidecar.reference,
      boundary: {
        authority: { stateHash: emptyLegacyPreviousRoot.root.hash },
        target: emptyCurrentProjection.target,
      },
    },
  );
  api.assertHistoryRetentionProjectionMatchesShell(
    emptyLegacyPreviousState,
    decodedMissingLegacy,
  );
  const emptyMigrated = await api.projectHistoryRetentionFromVerifiedSuccessor(
    decodedMissingLegacy,
    emptyLegacyPreviousRoot.root,
    emptyLegacyNextState,
    emptyLegacyNextRoot.root,
    readChunk,
  );
  const emptyMigratedGroup = emptyMigrated.projection.demandGroups.find(
    (group) => group.groupKey === api.LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY,
  );
  assert.ok(emptyMigratedGroup, 'legacy missing group 的下一 successor 必须写回 canonical empty group');
  assert.equal(emptyMigratedGroup.requirement, 'index-only');
  assert.deepEqual(emptyMigratedGroup.leaseKeys, [
    api.LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY,
  ]);
  assert.deepEqual(emptyMigratedGroup.eventIds, []);
  api.encodeHistoryRetentionSidecar(emptyMigrated.projection);

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
  assert.equal(rememberedSourceGroup.requirement, 'index-only');
  assert.ok(rememberedSourceGroup.resolvedEventIds.includes('mechanical-service'));
  assert.ok(rememberedSourceGroup.unresolvedEventIds.includes('fixture-codebook-source'),
    'record/non-event source ID 可保留为非阻塞 identity 缺口');
  assert.equal(
    decodedPrefix.continuationBasis.directMatches.some(
      (match) => match.eventId === 'project-pressure-bridge-only-prefix',
    ),
    false,
    '独立 bridge 事件在 previous shell 没有任何 demand，不能被其他 selector 提前解析',
  );
  assert.equal(
    decodedPrefix.pins.some((pin) => (
      pin.leaseKeys.includes(api.LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY)
    )),
    false,
    'project-pressure broad identity 不应常驻旧事件正文',
  );
  assert.equal(decodedPrefix.demandGroups.filter((group) => (
    group.groupKey.startsWith('gameplay:live-person-project-pressure:')
  )).length, 1, 'project-pressure 只能有唯一 broad group');
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
  assert.ok(futureSocialRepetitionGroup, '被存活人物记住的旧协议结果来源必须提前建立身份索引');
  assert.equal(futureSocialRepetitionGroup.requirement, 'index-only');
  assert.deepEqual(
    futureSocialRepetitionGroup.resolvedEventIds,
    ['remembered-old-offer', 'remembered-old-response', 'remembered-old-outcome'],
  );
  assert.equal(
    decodedPrefix.pins.some((pin) => (
      pin.leaseKeys.includes(api.FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY)
    )),
    false,
    'future social-repetition 只保存 exact identity，不常驻协议结果正文',
  );
  assert.equal(
    decodedPrefix.pins.some((pin) => pin.eventId === 'remembered-old-outcome'),
    false,
    '不在人物记忆中的 outcome-only 正文不得因重复判断被 pin',
  );
  assert.deepEqual(
    futureSocialRepetitionGroup.resolvedEventIds.map((eventId) => (
      decodedPrefix.continuationBasis.directMatches.find((match) => match.eventId === eventId)
    )),
    futureSocialRepetitionGroup.resolvedEventIds.map((eventId) => ({
      absoluteIndex: prefix.findIndex((event) => event.id === eventId),
      eventId,
    })),
    'future social-repetition index 必须保存每个真实来源的准确 ordinal/id',
  );
  assert.equal(
    decodedPrefix.continuationBasis.directMatches.some(
      (match) => match.eventId === 'social-repetition-bridge-only-prefix',
    ),
    false,
    '尚未进入协议结果 selector 的 prefix 事实不得被提前解析',
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
  const bridgedPressureGroup = advanced.projection.demandGroups.find((group) => (
    group.groupKey === api.LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY
  ));
  assert.ok(
    bridgedPressureGroup?.resolvedEventIds.includes('project-pressure-bridge-only-prefix'),
    'next living owner 新记忆引用旧 prefix 事实时，PP broad bridge 必须解析该成员',
  );
  assert.deepEqual(
    advanced.projection.continuationBasis.directMatches.find(
      (match) => match.eventId === 'project-pressure-bridge-only-prefix',
    ),
    {
      absoluteIndex: prefix.findIndex(
        (event) => event.id === 'project-pressure-bridge-only-prefix',
      ),
      eventId: 'project-pressure-bridge-only-prefix',
    },
    'verified prefix bridge 必须保存独立事件的精确 ordinal/id',
  );
  const bridgedSocialRepetitionGroup = advanced.projection.demandGroups.find((group) => (
    group.groupKey === api.FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY
  ));
  assert.ok(
    bridgedSocialRepetitionGroup?.resolvedEventIds.includes(
      'social-repetition-bridge-only-prefix',
    ),
    '新协议结果成员必须从 exact verified prefix 恢复 identity',
  );
  assert.deepEqual(
    advanced.projection.continuationBasis.directMatches.find(
      (match) => match.eventId === 'social-repetition-bridge-only-prefix',
    ),
    {
      absoluteIndex: prefix.findIndex(
        (event) => event.id === 'social-repetition-bridge-only-prefix',
      ),
      eventId: 'social-repetition-bridge-only-prefix',
    },
    'future social verified-prefix bridge 必须保存准确 ordinal/id',
  );
  assert.equal(
    advanced.projection.pins.some((pin) => (
      pin.leaseKeys.includes(api.FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY)
    )),
    false,
    'future social-repetition successor 必须保持零 cold pin lease',
  );
  assert.equal(
    advanced.projection.pins.some((pin) => (
      pin.eventId === 'social-repetition-bridge-only-prefix'
        && pin.leaseKeys.includes('live-intent:new-intent-reusing-old-knowledge:anchors')
    )),
    true,
    'index identity 被真实 live intent 引用后必须提升为该 intent 的精确 pin',
  );
  const missingSocialPrefixState = structuredClone(nextState);
  const missingSocialAgreement = missingSocialPrefixState.agreements.find((agreement) => (
    agreement.id === 'remembered-resolved-agreement'
  ));
  missingSocialAgreement.sourceEventIds = missingSocialAgreement.sourceEventIds.map((eventId) => (
    eventId === 'social-repetition-bridge-only-prefix'
      ? 'missing-social-repetition-prefix-source'
      : eventId
  ));
  const missingSocialIntent = missingSocialPrefixState.intents.find((intent) => (
    intent.id === 'new-intent-reusing-old-knowledge'
  ));
  missingSocialIntent.sourceFactIds = missingSocialIntent.sourceFactIds.map((eventId) => (
    eventId === 'social-repetition-bridge-only-prefix'
      ? 'missing-social-repetition-prefix-source'
      : eventId
  ));
  const missingSocialPrefixRoot = store(await api.encodeSegmentedRunState(
    missingSocialPrefixState,
    { mode: 'append', previous: previousRoot.metadata },
    { maxEventsPerSegmentForTests: 1 },
  ));
  await assert.rejects(
    api.projectHistoryRetentionFromVerifiedSuccessor(
      decodedPrefix,
      previousRoot.root,
      missingSocialPrefixState,
      missingSocialPrefixRoot.root,
      readChunk,
    ),
    /新 demand missing-social-repetition-prefix-source 无法由 suffix 解析/u,
    'prefix 中不存在的 social outcome ID 不能被 bridge 伪装成已验证 identity',
  );
  const forgottenSocialState = structuredClone(nextState);
  forgottenSocialState.people[0].memories = forgottenSocialState.people[0].memories.filter(
    (memory) => !memory.sourceEventIds.includes('remembered-old-offer'),
  );
  forgottenSocialState.intents = forgottenSocialState.intents.filter(
    (intent) => intent.id !== 'new-intent-reusing-old-knowledge',
  );
  const forgottenFold = api.beginHistoryRetentionProjection(
    forgottenSocialState,
    { stateHash: nextRoot.root.hash },
  );
  api.foldHistoryRetentionSegment(forgottenFold, [...prefix, ...suffix], 0);
  const forgottenProjection = api.finishHistoryRetentionProjection(forgottenFold);
  assert.equal(
    forgottenProjection.demandGroups.some((group) => (
      group.groupKey === api.FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY
    )),
    false,
    '忘记 proposal 后，即使仍记得 response，future social-repetition 整组也必须退租',
  );
  assert.equal(
    forgottenProjection.continuationBasis.directMatches.some((match) => (
      match.eventId === 'remembered-old-outcome'
        || match.eventId === 'social-repetition-bridge-only-prefix'
    )),
    false,
    '退租且无 live intent 后不得残留 outcome identity',
  );
  const migratedSocialRetention = await api.projectHistoryRetentionFromVerifiedSuccessor(
    decodedLegacySocial,
    previousRoot.root,
    nextState,
    nextRoot.root,
    readChunk,
  );
  assert.deepEqual(
    migratedSocialRetention.projection,
    oracle,
    '旧 exact audit future-social sidecar 必须一次迁移为 index-only successor',
  );
  const migratedPressureRetention = await api.projectHistoryRetentionFromVerifiedSuccessor(
    decodedLegacyPrefix,
    previousRoot.root,
    nextState,
    nextRoot.root,
    readChunk,
  );
  assert.deepEqual(
    migratedPressureRetention.projection,
    oracle,
    '旧 global audit-only project-pressure sidecar 必须一次迁移为 index-only successor',
  );
  assert.equal(
    migratedPressureRetention.projection.demandGroups.find((group) => (
      group.groupKey === api.LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY
    ))?.requirement,
    'index-only',
  );
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
  const promotedReproductionDecisionPin = advanced.projection.pins.find(
    (pin) => pin.eventId === 'prefix-tail',
  );
  assert.equal(promotedReproductionDecisionPin?.absoluteIndex, prefix.length - 1);
  assert.deepEqual([
    'live-intent:intent-promoted-to-reproduction:anchors',
    'gameplay:reproduction-intent:intent-promoted-to-reproduction:attempt',
    'gameplay:reproduction-intent:intent-promoted-to-reproduction:conception',
  ].filter((leaseKey) => promotedReproductionDecisionPin?.leaseKeys.includes(leaseKey)), [
    'live-intent:intent-promoted-to-reproduction:anchors',
    'gameplay:reproduction-intent:intent-promoted-to-reproduction:attempt',
    'gameplay:reproduction-intent:intent-promoted-to-reproduction:conception',
  ], '同一 live intent 晋升 reproduction selector 时应复用已严格验证的 prefix decision ordinal');
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

  const missingPreviousLiveState = structuredClone(previousState);
  missingPreviousLiveState.intents = missingPreviousLiveState.intents.filter(
    (intent) => intent.id !== 'intent-promoted-to-reproduction',
  );
  const missingPreviousLiveRoot = store(await api.encodeSegmentedRunState(
    missingPreviousLiveState,
    { mode: 'replace' },
    { maxEventsPerSegmentForTests: 1 },
  ));
  const missingPreviousLiveFold = api.beginHistoryRetentionProjection(
    missingPreviousLiveState,
    { stateHash: missingPreviousLiveRoot.root.hash },
  );
  api.foldHistoryRetentionSegment(missingPreviousLiveFold, prefix, 0);
  const missingPreviousLiveProjection = api.finishHistoryRetentionProjection(
    missingPreviousLiveFold,
  );
  const missingPreviousLiveEncoded = api.encodeHistoryRetentionSidecar(
    missingPreviousLiveProjection,
  );
  const missingPreviousLiveDecoded = api.decodeHistoryRetentionSidecar(
    missingPreviousLiveEncoded.chunk,
    {
      reference: missingPreviousLiveEncoded.reference,
      boundary: {
        authority: { stateHash: missingPreviousLiveRoot.root.hash },
        target: missingPreviousLiveProjection.target,
      },
    },
  );
  const missingPreviousLiveNextRoot = store(await api.encodeSegmentedRunState(
    nextState,
    { mode: 'append', previous: missingPreviousLiveRoot.metadata },
    { maxEventsPerSegmentForTests: 1 },
  ));
  await assert.rejects(
    api.projectHistoryRetentionFromVerifiedSuccessor(
      missingPreviousLiveDecoded,
      missingPreviousLiveRoot.root,
      nextState,
      missingPreviousLiveNextRoot.root,
      readChunk,
    ),
    /prefix-tail.*(?:suffix|不在 suffix)|新 demand prefix-tail/u,
    '没有 previous strict live core 时，其他 selector 的同 ID prefix match 不得冒充晋升依据',
  );

  const changedAnchorNextState = structuredClone(nextState);
  changedAnchorNextState.intents.find(
    (intent) => intent.id === 'intent-promoted-to-reproduction',
  ).sourceDecisionEventId = 'prefix-a';
  const changedAnchorNextRoot = store(await api.encodeSegmentedRunState(
    changedAnchorNextState,
    { mode: 'append', previous: previousRoot.metadata },
    { maxEventsPerSegmentForTests: 1 },
  ));
  await assert.rejects(
    api.projectHistoryRetentionFromVerifiedSuccessor(
      decodedPrefix,
      previousRoot.root,
      changedAnchorNextState,
      changedAnchorNextRoot.root,
      readChunk,
    ),
    /新 demand prefix-a|reproduction anchor prefix-a/u,
    '同 intent 改用未被 previous strict live core 证明的 prefix anchor 仍须 suffix-only',
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
  const migratedLogisticsSupport = migrated.projection.demandGroups.find(
    (group) => group.groupKey
      === 'live-intent:legacy-checkpoint-logistics-intent:anchors:supporting-sources',
  );
  assert.equal(migratedLogisticsSupport?.requirement, 'audit-only');
  assert.equal(migratedLogisticsSupport?.blocking, false,
    'legacy logistics provenance 作为 supporting source 缺失时不得重新升级为 strict blocker');

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
