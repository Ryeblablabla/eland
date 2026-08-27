import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync } from 'node:zlib';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-water-retention-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');
const dataDirectory = path.join(temporaryDirectory, 'data');
const childEnvironment = { ...process.env, NODE_OPTIONS: '--max-old-space-size=256' };
const sourceStateHash = '1'.repeat(64);
const successorStateHash = '2'.repeat(64);
let store;

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, canonicalJsonValue(value[key])]));
}

function recomputeBasisHash(projection) {
  const { basisHash: _discarded, ...withoutHash } = projection.continuationBasis;
  projection.continuationBasis.basisHash = createHash('sha256')
    .update('eland-history-retention-continuation-v1\0')
    .update(JSON.stringify(withoutHash))
    .digest('hex');
}

function rawSidecar(api, projection) {
  recomputeBasisHash(projection);
  const data = brotliCompressSync(
    Buffer.from(JSON.stringify(canonicalJsonValue(projection)), 'utf8'),
  );
  const codec = api.HISTORY_RETENTION_SIDECAR_CODEC;
  const hash = api.hashHistoryRetentionStoredContent(codec, data);
  return {
    chunk: { hash, codec, rawSize: data.byteLength, data },
    reference: { kind: 'content-hash', codec, hash },
  };
}

function actionFact({ id, atMonth, planningTick, who, cellId, z, action, diff = {} }) {
  return {
    id,
    kind: 'action',
    atMonth,
    orderInMonth: 0,
    planningTick,
    orderInTick: 0,
    cellId,
    who,
    cause: 'water-assistance-retention-fixture',
    action,
    fromCellId: cellId,
    toCellId: cellId,
    fromZ: z,
    toZ: z,
    pathSegment: [cellId],
    status: 'completed',
    result: id,
    diff,
  };
}

function cleanPerson(person, position) {
  person.bornAtMonth = 0;
  person.lifespanMonths = 12_000;
  delete person.diedAtMonth;
  person.position = { ...position, previousCellId: position.cellId, previousZ: position.z };
  person.body = { health: 100, hydration: 100, nutrition: 100 };
  person.conditions = [];
  person.inventory = [];
  person.knowledge = [];
  person.knownPlaces = [];
  person.relations = [];
  person.memories = [];
  person.cognition = {
    version: 'causal-bdi-v1',
    outcomeBeliefs: [],
    goalOutcomeBeliefs: [],
    needResolutionEpisodes: [],
  };
  delete person.bereavements;
  delete person.maternalTeaching;
  return person;
}

function firstWaterPosition(api, grid) {
  for (let z = 0; z < grid.levels; z += 1) {
    for (let y = 0; y < grid.depth; y += 1) {
      for (let x = 0; x < grid.width; x += 1) {
        if (api.voxelAt(grid, x, y, z) === api.Material.Water) {
          return { x, y, z, cellId: y * grid.width + x };
        }
      }
    }
  }
  throw new Error('fixture world 缺少 water voxel');
}

function buildFixtureState(api) {
  const state = api.createInitialState(20260815, {
    endpoint: { kind: 'months', value: 12_000 },
  });
  const water = firstWaterPosition(api, state.world.grid);
  const standing = { cellId: water.cellId, z: Math.min(water.z + 1, state.world.grid.levels - 1) };
  state.people = state.people.slice(0, 2);
  assert.equal(state.people.length, 2, 'fixture 需要两名人物');
  const [requester, helper] = state.people;
  cleanPerson(requester, standing);
  cleanPerson(helper, standing);
  const agreementId = 'water-assistance-retention-agreement';
  const proposal = {
    kind: 'assist',
    requesterId: requester.id,
    helperId: helper.id,
    need: 'water',
    expiresAtMonth: 900,
  };
  const proposalFact = actionFact({
    id: 'water-retention-proposal', atMonth: 850, planningTick: 0,
    who: requester.id, cellId: standing.cellId, z: standing.z,
    action: {
      kind: 'communicate',
      content: { id: agreementId, kind: 'request', summary: '请求协助取水', proposal },
      audience: [helper.id], channel: 'voice',
    },
    diff: { audience: [helper.id] },
  });
  const responseFact = actionFact({
    id: 'water-retention-response', atMonth: 850, planningTick: 1,
    who: helper.id, cellId: standing.cellId, z: standing.z,
    action: {
      kind: 'communicate',
      content: { id: 'water-retention-response-content', kind: 'accept', referenceId: agreementId },
      audience: [requester.id], channel: 'voice',
    },
    diff: { audience: [requester.id] },
  });
  const helperFacts = [];
  const requesterFacts = [];
  const history = [proposalFact, responseFact];
  let planningTick = 2;
  for (let index = 0; index < 25; index += 1) {
    const helperFact = actionFact({
      id: `water-retention-helper-${String(index).padStart(2, '0')}`,
      atMonth: 851 + Math.floor(index / 3), planningTick,
      who: helper.id, cellId: standing.cellId, z: standing.z,
      action: {
        kind: 'attend',
        target: { kind: 'voxel', position: { x: water.x, y: water.y, z: water.z } },
      },
    });
    planningTick += 1;
    const requesterFact = actionFact({
      id: `water-retention-requester-${String(index).padStart(2, '0')}`,
      atMonth: 851 + Math.floor(index / 3), planningTick,
      who: requester.id, cellId: standing.cellId, z: standing.z,
      action: { kind: 'act', operation: 'ingest', targets: [] },
      diff: { materialId: api.Material.Water, hydration: 12 },
    });
    planningTick += 1;
    helperFacts.push(helperFact);
    requesterFacts.push(requesterFact);
    history.push(helperFact, requesterFact);
  }
  const wrongActor = actionFact({
    id: 'water-retention-wrong-actor', atMonth: 860, planningTick,
    who: requester.id, cellId: standing.cellId, z: standing.z,
    action: {
      kind: 'attend',
      target: { kind: 'voxel', position: { x: water.x, y: water.y, z: water.z } },
    },
  });
  planningTick += 1;
  const wrongMaterial = actionFact({
    id: 'water-retention-wrong-material', atMonth: 860, planningTick,
    who: requester.id, cellId: standing.cellId, z: standing.z,
    action: { kind: 'act', operation: 'ingest', targets: [] },
    diff: { materialId: api.Material.Stone, hydration: 99 },
  });
  planningTick += 1;
  const tail = {
    id: 'water-retention-tail', kind: 'environment', atMonth: 860,
    orderInMonth: 0, planningTick, orderInTick: 0, cellId: standing.cellId,
    change: 'condition', result: 'retention fixture tail', diff: {},
  };
  history.push(wrongActor, wrongMaterial, tail);
  const fulfillmentEventIds = [
    ...helperFacts.map((fact) => fact.id),
    ...requesterFacts.map((fact) => fact.id),
    wrongActor.id,
    wrongMaterial.id,
  ].reverse();
  state.agreements = [{
    id: agreementId,
    proposal,
    proposerId: requester.id,
    responderId: helper.id,
    partyIds: [requester.id, helper.id],
    requiredResponderIds: [helper.id],
    acceptedByPersonIds: [requester.id, helper.id],
    rejectedByPersonIds: [],
    status: 'active',
    proposedAtMonth: 850,
    acceptByMonth: 852,
    acceptedAtMonth: 850,
    dueAtMonth: 900,
    proposalEventId: proposalFact.id,
    responseEventId: responseFact.id,
    fulfillmentEventIds,
    fulfilledByPersonIds: [requester.id, helper.id],
    coLocatedMonths: 0,
    sourceEventIds: [proposalFact.id, responseFact.id, ...fulfillmentEventIds],
  }];
  state.intents = [];
  state.projects = [];
  state.records = [];
  state.collectives = [];
  state.permissions = [];
  state.containers = [];
  state.eraPredictions = [];
  state.world.drops = [];
  state.world.animals = [];
  state.world.remains = [];
  state.world.memorials = [];
  state.world.mechanicalPower = undefined;
  state.world.past = history;
  state.world.historyCursor = {
    version: 1,
    eventCount: history.length,
    hotStartIndex: 0,
    tailEventId: tail.id,
  };
  state.clock.elapsedMonths = 860;
  state.lastStep = history.slice(-2);
  return {
    state,
    agreementId,
    requesterId: requester.id,
    helperId: helper.id,
    water,
    standing,
    helperFacts,
    requesterFacts,
    wrongActor,
    wrongMaterial,
    expectedHelperId: helperFacts.at(-1).id,
    expectedRequesterId: requesterFacts.at(-1).id,
  };
}

function projectAll(api, state, stateHash = sourceStateHash) {
  const fold = api.beginHistoryRetentionProjection(state, { stateHash });
  api.foldHistoryRetentionSegment(fold, state.world.past, 0);
  return api.finishHistoryRetentionProjection(fold);
}

function boundedClone(state, hotEventLimit = 2) {
  const bounded = structuredClone(state);
  const cursor = bounded.world.historyCursor;
  cursor.hotStartIndex = Math.max(0, cursor.eventCount - hotEventLimit);
  bounded.world.past = bounded.world.past.slice(cursor.hotStartIndex);
  return bounded;
}

function decodedColdPins(projection, fullHistory, hotStartIndex) {
  return projection.pins
    .filter((pin) => pin.absoluteIndex < hotStartIndex)
    .map((pin) => ({ absoluteIndex: pin.absoluteIndex, event: fullHistory[pin.absoluteIndex] }));
}

function typedPinIds(projection, helperLeaseKey, requesterLeaseKey) {
  return {
    helper: projection.pins.filter((pin) => pin.leaseKeys.includes(helperLeaseKey))
      .map((pin) => pin.eventId),
    requester: projection.pins.filter((pin) => pin.leaseKeys.includes(requesterLeaseKey))
      .map((pin) => pin.eventId),
  };
}

function legacyAuditProjection(api, current, fixture) {
  const legacy = structuredClone(current);
  const membershipKey = api.waterAssistanceFulfillmentMembershipGroupKey(
    fixture.agreementId,
    fixture.requesterId,
    fixture.helperId,
  );
  const helperLeaseKey = api.waterAssistanceEvidenceLeaseKey(
    fixture.agreementId, fixture.requesterId, fixture.helperId, 'helper',
  );
  const requesterLeaseKey = api.waterAssistanceEvidenceLeaseKey(
    fixture.agreementId, fixture.requesterId, fixture.helperId, 'requester',
  );
  const membership = legacy.demandGroups.find((group) => group.groupKey === membershipKey);
  assert.ok(membership, 'current projection 必须含 water membership');
  const sourceMembership = legacy.continuationBasis.sourceDemand.groups
    .find((group) => group.groupKey === membershipKey);
  assert.ok(sourceMembership);
  const legacyLeaseKey = api.liveAgreementHistoryLeaseKey(fixture.agreementId);
  const supportingKey = `${legacyLeaseKey}:supporting-sources`;
  const support = {
    groupKey: supportingKey,
    requirement: 'audit-only',
    leaseKeys: [legacyLeaseKey],
    eventIds: [...membership.eventIds],
    resolvedEventIds: [...membership.resolvedEventIds],
    unresolvedEventIds: [...membership.unresolvedEventIds],
    satisfied: membership.satisfied,
    blocking: false,
  };
  const sourceSupport = {
    groupKey: supportingKey,
    requirement: 'audit-only',
    leaseKeys: [legacyLeaseKey],
    eventIds: [...sourceMembership.eventIds],
  };
  legacy.demandGroups = legacy.demandGroups
    .filter((group) => group.groupKey !== membershipKey && group.groupKey !== supportingKey)
    .concat(support)
    .sort((left, right) => left.groupKey.localeCompare(right.groupKey));
  legacy.continuationBasis.sourceDemand.groups = legacy.continuationBasis.sourceDemand.groups
    .filter((group) => group.groupKey !== membershipKey && group.groupKey !== supportingKey)
    .concat(sourceSupport)
    .sort((left, right) => left.groupKey.localeCompare(right.groupKey));
  legacy.continuationBasis.selectiveMatches = legacy.continuationBasis.selectiveMatches
    .filter((item) => item.leaseKey !== helperLeaseKey && item.leaseKey !== requesterLeaseKey);
  const directById = new Map(
    legacy.continuationBasis.directMatches.map((match) => [match.eventId, match]),
  );
  const pins = new Map(legacy.pins.map((pin) => [pin.absoluteIndex, {
    ...pin,
    leaseKeys: pin.leaseKeys.filter((leaseKey) => (
      leaseKey !== helperLeaseKey && leaseKey !== requesterLeaseKey
    )),
  }]));
  for (const eventId of support.resolvedEventIds) {
    const match = directById.get(eventId);
    assert.ok(match, `legacy support ${eventId} 必须有 direct match`);
    const pin = pins.get(match.absoluteIndex) ?? { ...match, leaseKeys: [] };
    pin.leaseKeys = [...new Set([...pin.leaseKeys, legacyLeaseKey])].sort();
    pins.set(match.absoluteIndex, pin);
  }
  legacy.pins = [...pins.values()]
    .filter((pin) => pin.leaseKeys.length > 0)
    .sort((left, right) => left.absoluteIndex - right.absoluteIndex);
  return legacy;
}

function appendSuccessorEvidence(api, state, fixture, prefix) {
  const cursor = state.world.historyCursor;
  const start = cursor.eventCount;
  const helperFact = actionFact({
    id: `${prefix}-helper`, atMonth: 861, planningTick: 80,
    who: fixture.helperId, cellId: fixture.standing.cellId, z: fixture.standing.z,
    action: {
      kind: 'attend',
      target: {
        kind: 'voxel',
        position: { x: fixture.water.x, y: fixture.water.y, z: fixture.water.z },
      },
    },
  });
  const requesterFact = actionFact({
    id: `${prefix}-requester`, atMonth: 861, planningTick: 81,
    who: fixture.requesterId, cellId: fixture.standing.cellId, z: fixture.standing.z,
    action: { kind: 'act', operation: 'ingest', targets: [] },
    diff: { materialId: api.Material.Water, hydration: 21 },
  });
  state.world.past.push(helperFact, requesterFact);
  cursor.eventCount += 2;
  cursor.tailEventId = requesterFact.id;
  state.clock.elapsedMonths = 861;
  const agreement = state.agreements.find((item) => item.id === fixture.agreementId);
  agreement.fulfillmentEventIds.push(helperFact.id, requesterFact.id);
  agreement.sourceEventIds.push(helperFact.id, requesterFact.id);
  state.lastStep = [helperFact, requesterFact];
  return { start, suffix: [helperFact, requesterFact] };
}

try {
  writeFileSync(entryPath, [
    `export { SqliteRunStore } from ${JSON.stringify(path.join(workspace, 'server/sqlite-run-store.ts'))};`,
    `export { createInitialState } from ${JSON.stringify(path.join(workspace, 'src/game/eland/simulation-runtime.ts'))};`,
    `export { Material } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/material.ts'))};`,
    `export { voxelAt } from ${JSON.stringify(path.join(workspace, 'src/game/eland/world/grid.ts'))};`,
    `export { beginHistoryRetentionProjection, foldHistoryRetentionSegment, finishHistoryRetentionProjection, resumeHistoryRetentionProjection } from ${JSON.stringify(path.join(workspace, 'server/history-retention-projection.ts'))};`,
    `export { installVerifiedHistoryRetentionEvidence } from ${JSON.stringify(path.join(workspace, 'server/retained-history-evidence.ts'))};`,
    `export { decodeRunContinuationBundle } from ${JSON.stringify(path.join(workspace, 'server/run-continuation-bundle.ts'))};`,
    `export { decodeHistoryRetentionSidecar, encodeHistoryRetentionSidecar, hashHistoryRetentionStoredContent, HISTORY_RETENTION_SIDECAR_CODEC } from ${JSON.stringify(path.join(workspace, 'server/history-retention-codec.ts'))};`,
    `export { liveAgreementHistoryLeaseKey, retainedColdWorldEventsForLease, waterAssistanceEvidenceLeaseKey, waterAssistanceFulfillmentMembershipGroupKey, worldEventById, worldEventByIdWithRetainedLease } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/event-index.ts'))};`,
    `export { livePersonSocialStrictEvidenceLeaseKey } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/live-social-evidence.ts'))};`,
    `export { recordAgreementAction, verifiedWaterAssistanceEvidenceAnchors } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/agreement.ts'))};`,
    `export { socialCooperationBeliefFor } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/social-learning.ts'))};`,
  ].join('\n'));
  execFileSync(path.join(workspace, 'node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { cwd: workspace, env: childEnvironment, stdio: 'pipe' });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
  const fixture = buildFixtureState(api);
  const fullHistory = fixture.state.world.past;
  const projection = projectAll(api, fixture.state);
  api.encodeHistoryRetentionSidecar(projection);

  const helperLeaseKey = api.waterAssistanceEvidenceLeaseKey(
    fixture.agreementId, fixture.requesterId, fixture.helperId, 'helper',
  );
  const requesterLeaseKey = api.waterAssistanceEvidenceLeaseKey(
    fixture.agreementId, fixture.requesterId, fixture.helperId, 'requester',
  );
  const membershipKey = api.waterAssistanceFulfillmentMembershipGroupKey(
    fixture.agreementId, fixture.requesterId, fixture.helperId,
  );
  const membership = projection.demandGroups.find((group) => group.groupKey === membershipKey);
  assert.ok(membership);
  assert.equal(membership.requirement, 'index-only');
  assert.equal(membership.eventIds.length, 52, '完整 membership 不得被 top-N 截断');
  assert.deepEqual(membership.leaseKeys, [helperLeaseKey, requesterLeaseKey].sort());
  assert.deepEqual(typedPinIds(projection, helperLeaseKey, requesterLeaseKey), {
    helper: [fixture.expectedHelperId],
    requester: [fixture.expectedRequesterId],
  });
  assert.equal(projection.pins.some((pin) => (
    membership.eventIds.includes(pin.eventId)
      && ![fixture.expectedHelperId, fixture.expectedRequesterId].includes(pin.eventId)
  )), false, 'broad fulfillment membership 不得 pin 早期或错误正文');

  const emptyMembershipState = structuredClone(fixture.state);
  emptyMembershipState.agreements[0].fulfillmentEventIds = [];
  emptyMembershipState.agreements[0].fulfilledByPersonIds = [];
  emptyMembershipState.agreements[0].sourceEventIds = [
    emptyMembershipState.agreements[0].proposalEventId,
    emptyMembershipState.agreements[0].responseEventId,
  ];
  const emptyMembershipProjection = projectAll(api, emptyMembershipState);
  assert.deepEqual(emptyMembershipProjection.demandGroups
    .find((group) => group.groupKey === membershipKey)?.eventIds, [],
  '刚激活的取水协议必须显式写出空 index-only membership');
  api.encodeHistoryRetentionSidecar(emptyMembershipProjection);

  const fullEvidence = api.verifiedWaterAssistanceEvidenceAnchors(
    fixture.state,
    fixture.state.agreements[0],
    fixture.state.agreements[0].proposal,
  );
  assert.deepEqual(fullEvidence.sourceEventIds, [
    fixture.expectedHelperId,
    fixture.expectedRequesterId,
  ]);

  const bounded = boundedClone(fixture.state);
  const coldPins = decodedColdPins(projection, fullHistory, bounded.world.historyCursor.hotStartIndex);
  api.installVerifiedHistoryRetentionEvidence(bounded, sourceStateHash, projection, coldPins);
  const boundedEvidence = api.verifiedWaterAssistanceEvidenceAnchors(
    bounded, bounded.agreements[0], bounded.agreements[0].proposal,
  );
  assert.deepEqual(boundedEvidence.sourceEventIds, fullEvidence.sourceEventIds,
    'full/bounded 必须选择相同 typed anchors');
  assert.deepEqual(api.retainedColdWorldEventsForLease(bounded, helperLeaseKey)
    .map((event) => event.id), [fixture.expectedHelperId]);
  assert.deepEqual(api.retainedColdWorldEventsForLease(bounded, requesterLeaseKey)
    .map((event) => event.id), [fixture.expectedRequesterId]);
  assert.equal(api.worldEventByIdWithRetainedLease(
    bounded,
    fixture.expectedHelperId,
    'fixture:unrelated-lease',
  ), undefined, 'typed cold anchor 不得由无关 lease 解析');
  assert.throws(
    () => api.installVerifiedHistoryRetentionEvidence(
      bounded, 'f'.repeat(64), projection, coldPins,
    ),
    /authority\/seal/u,
    '错误 root 必须拒绝',
  );
  const wrongOrdinalPins = coldPins.map((item) => ({ ...item }));
  const helperPinIndex = wrongOrdinalPins.findIndex((item) => (
    item.event.id === fixture.expectedHelperId
  ));
  assert.notEqual(helperPinIndex, -1);
  wrongOrdinalPins[helperPinIndex] = {
    ...wrongOrdinalPins[helperPinIndex],
    event: fixture.wrongActor,
  };
  assert.throws(
    () => api.installVerifiedHistoryRetentionEvidence(
      boundedClone(fixture.state), sourceStateHash, projection, wrongOrdinalPins,
    ),
    /未被准确解码/u,
    '错误 ordinal/body join 必须拒绝',
  );

  const legacyProjection = legacyAuditProjection(api, projection, fixture);
  const legacyStored = rawSidecar(api, legacyProjection);
  const decodedLegacy = api.decodeHistoryRetentionSidecar(
    legacyStored.chunk,
    {
      reference: legacyStored.reference,
      boundary: { authority: { stateHash: sourceStateHash }, target: projection.target },
    },
  );
  const legacyBounded = boundedClone(fixture.state, 1);
  const legacyColdPins = decodedColdPins(
    decodedLegacy,
    fullHistory,
    legacyBounded.world.historyCursor.hotStartIndex,
  );
  api.installVerifiedHistoryRetentionEvidence(
    legacyBounded, sourceStateHash, decodedLegacy, legacyColdPins,
  );
  assert.deepEqual(api.verifiedWaterAssistanceEvidenceAnchors(
    legacyBounded,
    legacyBounded.agreements[0],
    legacyBounded.agreements[0].proposal,
  ).sourceEventIds, fullEvidence.sourceEventIds,
  'legacy audit bodies 只能经 exact root/ordinal 与 strict predicate 迁移为两条 typed anchors');
  assert.equal(api.retainedColdWorldEventsForLease(legacyBounded, helperLeaseKey).length, 1);
  assert.equal(api.retainedColdWorldEventsForLease(legacyBounded, requesterLeaseKey).length, 1);
  const legacyLiveLeaseKey = api.liveAgreementHistoryLeaseKey(fixture.agreementId);
  assert.deepEqual(api.retainedColdWorldEventsForLease(legacyBounded, legacyLiveLeaseKey)
    .map((event) => event.id), [
    legacyBounded.agreements[0].proposalEventId,
    legacyBounded.agreements[0].responseEventId,
  ], 'legacy live-agreement lease 只能保留 proposal/response core');
  const legacyVisibleFulfillmentIds = legacyBounded.agreements[0].fulfillmentEventIds
    .filter((eventId) => api.worldEventById(legacyBounded, eventId) !== undefined)
    .sort();
  assert.deepEqual(legacyVisibleFulfillmentIds, [
    fixture.expectedHelperId,
    fixture.expectedRequesterId,
  ].sort(), '无共享 lease 时 legacy migration 最多注册两条 typed 正文');
  const unselectedLegacyFulfillmentId = fixture.helperFacts[0].id;
  assert.equal(api.worldEventById(legacyBounded, unselectedLegacyFulfillmentId), undefined);
  assert.equal(api.worldEventByIdWithRetainedLease(
    legacyBounded,
    unselectedLegacyFulfillmentId,
    legacyLiveLeaseKey,
  ), undefined, '未选中的旧 fulfillment 不得由 generic 或 legacy agreement lease 解析');

  const sharedFixture = buildFixtureState(api);
  const sharedFulfillmentId = sharedFixture.helperFacts[0].id;
  sharedFixture.helperFacts[0].cause = 'intent';
  const sharedHelper = sharedFixture.state.people.find((person) => (
    person.id === sharedFixture.helperId
  ));
  sharedHelper.memories.push({
    id: 'water-retention-shared-memory',
    kind: 'episode',
    summary: '记得较早一次到达水边',
    importance: 60,
    createdAtMonth: 851,
    lastRecalledAtMonth: 860,
    personIds: [sharedFixture.requesterId],
    sourceEventIds: [sharedFulfillmentId],
  });
  const sharedProjection = projectAll(api, sharedFixture.state);
  const sharedLegacyProjection = legacyAuditProjection(
    api,
    sharedProjection,
    sharedFixture,
  );
  const sharedLegacyStored = rawSidecar(api, sharedLegacyProjection);
  const decodedSharedLegacy = api.decodeHistoryRetentionSidecar(
    sharedLegacyStored.chunk,
    {
      reference: sharedLegacyStored.reference,
      boundary: { authority: { stateHash: sourceStateHash }, target: sharedProjection.target },
    },
  );
  const sharedLegacyBounded = boundedClone(sharedFixture.state, 1);
  api.installVerifiedHistoryRetentionEvidence(
    sharedLegacyBounded,
    sourceStateHash,
    decodedSharedLegacy,
    decodedColdPins(
      decodedSharedLegacy,
      sharedFixture.state.world.past,
      sharedLegacyBounded.world.historyCursor.hotStartIndex,
    ),
  );
  const sharedSocialLeaseKey = api.livePersonSocialStrictEvidenceLeaseKey(
    sharedFixture.helperId,
    'electrical-remote-work',
  );
  assert.equal(api.worldEventById(sharedLegacyBounded, sharedFulfillmentId)?.id,
    sharedFulfillmentId,
    '与其他真实 lease 共享的旧 fulfillment body 不得被整体删除');
  assert.equal(api.worldEventByIdWithRetainedLease(
    sharedLegacyBounded,
    sharedFulfillmentId,
    sharedSocialLeaseKey,
  )?.id, sharedFulfillmentId);
  assert.equal(api.worldEventByIdWithRetainedLease(
    sharedLegacyBounded,
    sharedFulfillmentId,
    api.liveAgreementHistoryLeaseKey(sharedFixture.agreementId),
  ), undefined, '共享 body 也不得重新获得 legacy agreement lease');

  const legacySuccessor = appendSuccessorEvidence(
    api, legacyBounded, fixture, 'legacy-water-successor',
  );
  const legacyFold = api.resumeHistoryRetentionProjection(
    decodedLegacy,
    legacyBounded,
    { stateHash: successorStateHash },
  );
  api.foldHistoryRetentionSegment(legacyFold, legacySuccessor.suffix, legacySuccessor.start);
  const legacyNext = api.finishHistoryRetentionProjection(legacyFold);
  assert.deepEqual(typedPinIds(legacyNext, helperLeaseKey, requesterLeaseKey), {
    helper: ['legacy-water-successor-helper'],
    requester: ['legacy-water-successor-requester'],
  }, 'legacy warm successor 必须写出规范 typed group 并由新 suffix 替换 anchors');
  api.encodeHistoryRetentionSidecar(legacyNext);

  store = new api.SqliteRunStore(dataDirectory);
  const created = await store.create({ id: 'water-assistance-retention', state: fixture.state });
  await store.bootstrapBoundedEvolutionContinuation(created.meta.id, 2);
  store.close();
  store = new api.SqliteRunStore(dataDirectory);
  const opened = await store.openBoundedEvolutionContinuation(created.meta.id);
  assert.equal(opened.state.world.past.length, 2, '真实 SQLite cold open 只应载入 hot tail');
  assert.deepEqual(api.verifiedWaterAssistanceEvidenceAnchors(
    opened.state,
    opened.state.agreements[0],
    opened.state.agreements[0].proposal,
  ).sourceEventIds, fullEvidence.sourceEventIds,
  '真实 SQLite cold open 必须重建相同 typed anchors');

  const continuation = store.database.prepare(`
    SELECT bundle_hash FROM run_continuations WHERE run_id = ?
  `).get(created.meta.id);
  function readChunk(hash) {
    const row = store.database.prepare(`
      SELECT hash, codec, raw_size, data FROM chunks WHERE hash = ?
    `).get(hash);
    assert.ok(row, `SQLite chunk ${hash} 必须存在`);
    return {
      hash: String(row.hash),
      codec: String(row.codec),
      rawSize: Number(row.raw_size),
      data: Buffer.from(row.data),
    };
  }
  const bundle = api.decodeRunContinuationBundle(readChunk(String(continuation.bundle_hash)));
  const sqliteProjection = api.decodeHistoryRetentionSidecar(
    readChunk(bundle.sidecars.retention.hash),
    {
      reference: bundle.sidecars.retention,
      boundary: {
        authority: { stateHash: bundle.authority.stateHash },
        target: {
          eventCount: bundle.authority.eventCount,
          tailEventId: bundle.authority.tailEventId,
        },
      },
    },
  );
  const sqliteSuccessor = appendSuccessorEvidence(
    api, opened.state, fixture, 'sqlite-water-successor',
  );
  const sqliteFold = api.resumeHistoryRetentionProjection(
    sqliteProjection,
    opened.state,
    { stateHash: '3'.repeat(64) },
  );
  api.foldHistoryRetentionSegment(sqliteFold, sqliteSuccessor.suffix, sqliteSuccessor.start);
  const sqliteNext = api.finishHistoryRetentionProjection(sqliteFold);
  assert.deepEqual(typedPinIds(sqliteNext, helperLeaseKey, requesterLeaseKey), {
    helper: ['sqlite-water-successor-helper'],
    requester: ['sqlite-water-successor-requester'],
  }, 'decoded SQLite warm successor 必须稳定替换两条 selector');
  api.encodeHistoryRetentionSidecar(sqliteNext);

  const fulfillmentState = boundedClone(fixture.state);
  api.installVerifiedHistoryRetentionEvidence(
    fulfillmentState,
    sourceStateHash,
    projection,
    decodedColdPins(projection, fullHistory, fulfillmentState.world.historyCursor.hotStartIndex),
  );
  const finalDrink = actionFact({
    id: 'water-retention-final-drink', atMonth: 861, planningTick: 90,
    who: fixture.requesterId, cellId: fixture.standing.cellId, z: fixture.standing.z,
    action: { kind: 'act', operation: 'ingest', targets: [] },
    diff: { materialId: api.Material.Water, hydration: 25 },
  });
  api.recordAgreementAction(fulfillmentState, finalDrink);
  const fulfilled = fulfillmentState.agreements[0];
  assert.equal(fulfilled.status, 'fulfilled');
  const belief = api.socialCooperationBeliefFor(
    fulfillmentState.people.find((person) => person.id === fixture.requesterId),
    fixture.helperId,
    'assist-water',
  );
  assert.ok(belief);
  assert.equal(belief.reliability.positiveObservations, 1);
  assert.equal(belief.receipts.length, 1);
  assert.deepEqual(belief.receipts[0].sourceEventIds, [
    fixture.expectedHelperId,
    finalDrink.id,
  ]);
  assert.ok(belief.receipts[0].sourceEventIds.length <= 2);
  api.recordAgreementAction(fulfillmentState, finalDrink);
  assert.equal(belief.reliability.positiveObservations, 1,
    '同一完成协议不得重复增加社会学习观测');

  console.log('water assistance typed retention fixture passed');
} finally {
  store?.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
