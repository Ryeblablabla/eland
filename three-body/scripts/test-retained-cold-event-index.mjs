import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-retained-cold-index-v29-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'entry.mjs');
const stateHash = 'b'.repeat(64);

function baseEvent(id, atMonth) {
  return { id, atMonth, orderInMonth: 0, planningTick: 1, orderInTick: 0, cellId: 0 };
}

function environment(id, atMonth, result = id) {
  return { ...baseEvent(id, atMonth), kind: 'environment', change: 'condition', result, diff: {} };
}

function action(id, atMonth, who, actionValue, diff) {
  return {
    ...baseEvent(id, atMonth), kind: 'action', actionTick: 1, who, cause: 'intent', action: actionValue,
    fromCellId: 0, toCellId: 0, fromZ: 1, toZ: 1, pathSegment: [],
    status: 'completed', result: id, diff,
  };
}

function millLabor(id, atMonth, who = 'p1') {
  return action(id, atMonth, who, { kind: 'act', operation: 'separate', targets: [] }, {
    sourceMaterialId: 12,
    facilityMaterialId: 59,
  });
}

function waterObservation(id, atMonth, who = 'p1') {
  return action(id, atMonth, who, {
    kind: 'attend',
    target: { kind: 'voxel', position: { x: 0, y: 0, z: 0 } },
    waterCurrentSegmentId: 'segment-1',
  }, {
    mechanicalPowerObservation: true,
    waterCurrentSegmentId: 'segment-1',
  });
}

function person() {
  return {
    id: 'p1', bornAtMonth: 0, body: { health: 80, hydration: 80, nutrition: 80 },
    knowledge: [{
      id: 'observation:water-current:segment-1', kind: 'observation', confidence: 70,
      sourceEventIds: ['water-observation', 'cold-duplicate'],
    }],
    inventory: [],
  };
}

function stateWithHistory(events, hotStartIndex) {
  return {
    world: {
      past: events.slice(hotStartIndex),
      historyCursor: {
        version: 1,
        eventCount: events.length,
        hotStartIndex,
        tailEventId: events.at(-1)?.id ?? null,
      },
      mechanicalPower: { version: 'mechanical-power-world-v1', sources: [{ id: 'segment-1' }], networks: [] },
    },
    people: [person()],
    projects: [],
  };
}

try {
  const eventIndexPath = path.resolve('src/game/eland/domain/event-index.ts');
  const mechanicalOptionsPath = path.resolve('src/game/eland/application/mechanical-power-options.ts');
  writeFileSync(entryPath, [
    `export { clearPlanningEventOverlay, registerPlanningEventOverlay, registerRetainedColdWorldEventFacts, retainedColdWorldEventsForLease, worldEventById, worldEventFacts, worldEventsByIdsInHistoryOrder } from ${JSON.stringify(eventIndexPath)};`,
    `export { mechanicalPowerPressureEvidence, ownMillLaborFacts, personalWaterCurrentObservation } from ${JSON.stringify(mechanicalOptionsPath)};`,
    `export { installVerifiedHistoryRetentionEvidence } from ${JSON.stringify(path.resolve('server/retained-history-evidence.ts'))};`,
    `export { adoptBoundedSimulationState } from ${JSON.stringify(path.resolve('server/bounded-simulation-adoption.ts'))};`,
    `export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/simulation-runtime.ts'))};`,
    `export { beginHistoryRetentionProjection, finishHistoryRetentionProjection, foldHistoryRetentionSegment, historyRetentionDemandFingerprintForShell } from ${JSON.stringify(path.resolve('server/history-retention-projection.ts'))};`,
    `export { encodeSegmentedRunState } from ${JSON.stringify(path.resolve('server/run-state-codec.ts'))};`,
  ].join('\n'));
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entryPath, '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' }, stdio: 'pipe' });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  const history = [
    millLabor('mill-too-old', 0),
    millLabor('mill-old-1', 1),
    waterObservation('water-observation', 2),
    environment('cold-duplicate', 2, 'older duplicate'),
    millLabor('mill-old-2', 3),
    environment('cold-duplicate', 4, 'newer duplicate'),
    environment('shared-id', 5, 'cold loses'),
    environment('unretained-cold', 5),
    millLabor('mill-hot', 6),
    environment('shared-id', 6, 'hot wins'),
    environment('tail', 7),
  ];
  const hotStartIndex = 8;
  const full = stateWithHistory(history, 0);
  const bounded = stateWithHistory(history, hotStartIndex);

  const retained = [
    { absoluteIndex: 1, eventId: history[1].id, event: history[1], leaseKeys: ['living-mill-labor:p1:recent-3'] },
    {
      absoluteIndex: 2,
      eventId: history[2].id,
      event: history[2],
      leaseKeys: ['mechanical-knowledge:p1:observation:water-current:segment-1'],
    },
    { absoluteIndex: 3, eventId: history[3].id, event: history[3], leaseKeys: ['fixture:duplicate'] },
    { absoluteIndex: 4, eventId: history[4].id, event: history[4], leaseKeys: ['living-mill-labor:p1:recent-3'] },
    {
      absoluteIndex: 5,
      eventId: history[5].id,
      event: history[5],
      leaseKeys: ['fixture:duplicate', 'mechanical-knowledge:p1:observation:water-current:segment-1'],
    },
    { absoluteIndex: 6, eventId: history[6].id, event: history[6], leaseKeys: ['fixture:hot-precedence'] },
  ];

  assert.throws(() => api.registerRetainedColdWorldEventFacts(bounded, [
    retained[0], { ...retained[1], absoluteIndex: retained[0].absoluteIndex },
  ]), /绝对序号 1 重复/u);
  assert.throws(() => api.registerRetainedColdWorldEventFacts(bounded, [{
    ...retained[0], absoluteIndex: hotStartIndex,
  }]), /不在冷区间/u);
  assert.throws(() => api.registerRetainedColdWorldEventFacts(bounded, [{
    ...retained[0], eventId: 'wrong-id',
  }]), /事件 ID 不一致/u);
  assert.throws(() => api.registerRetainedColdWorldEventFacts(bounded, [{
    ...retained[0], leaseKeys: [],
  }]), /缺少有效 lease/u);

  const projection = {
    schemaVersion: 1,
    authority: { stateHash },
    target: { eventCount: history.length, tailEventId: history.at(-1).id },
    demandFingerprint: api.historyRetentionDemandFingerprintForShell(bounded),
    millLaborPersonIds: ['p1'],
    pins: [
      ...retained.map(({ absoluteIndex, eventId, leaseKeys }) => ({ absoluteIndex, eventId, leaseKeys })),
      { absoluteIndex: 8, eventId: 'mill-hot', leaseKeys: ['living-mill-labor:p1:recent-3'] },
    ],
    demandGroups: [{
      groupKey: 'mechanical-knowledge:p1:observation:water-current:segment-1',
      requirement: 'all',
      leaseKeys: ['mechanical-knowledge:p1:observation:water-current:segment-1'],
      eventIds: ['water-observation', 'cold-duplicate'],
      resolvedEventIds: ['water-observation', 'cold-duplicate'],
      unresolvedEventIds: [],
      satisfied: true,
      blocking: false,
    }],
    unresolvedDemands: [],
  };
  const decodedColdPins = retained.map(({ absoluteIndex, event }) => ({ absoluteIndex, event }));
  assert.throws(() => api.installVerifiedHistoryRetentionEvidence(bounded, 'c'.repeat(64), projection, decodedColdPins), /authority\/seal/u);
  assert.throws(() => api.installVerifiedHistoryRetentionEvidence(bounded, stateHash, {
    ...projection,
    target: { ...projection.target, eventCount: projection.target.eventCount + 1 },
  }, decodedColdPins), /authority\/seal/u);
  const blockingState = stateWithHistory(history, hotStartIndex);
  blockingState.people[0].knowledge[0].sourceEventIds.push('missing-hard');
  const blockingProjection = {
    ...projection,
    demandFingerprint: api.historyRetentionDemandFingerprintForShell(blockingState),
    demandGroups: [{
      groupKey: 'mechanical-knowledge:p1:observation:water-current:segment-1',
      requirement: 'all',
      leaseKeys: ['mechanical-knowledge:p1:observation:water-current:segment-1'],
      eventIds: ['water-observation', 'cold-duplicate', 'missing-hard'],
      resolvedEventIds: ['water-observation', 'cold-duplicate'],
      unresolvedEventIds: ['missing-hard'],
      satisfied: false,
      blocking: true,
    }],
    unresolvedDemands: [{
      eventId: 'missing-hard',
      leaseKeys: ['mechanical-knowledge:p1:observation:water-current:segment-1'],
      requirement: 'all',
      groupKey: 'mechanical-knowledge:p1:observation:water-current:segment-1',
      blocking: true,
    }],
  };
  assert.throws(() => api.installVerifiedHistoryRetentionEvidence(
    blockingState, stateHash, blockingProjection, decodedColdPins,
  ), /阻断证据组/u);
  assert.throws(() => api.installVerifiedHistoryRetentionEvidence(bounded, stateHash, projection, [
    ...decodedColdPins,
    { absoluteIndex: 7, event: history[7] },
  ]), /未请求的冷 pin 7/u);
  const installed = api.installVerifiedHistoryRetentionEvidence(bounded, stateHash, projection, decodedColdPins);
  assert.equal(installed.length, retained.length);

  const adoptionFullState = api.createInitialState(17);
  adoptionFullState.clock.elapsedMonths = history.at(-1).atMonth;
  adoptionFullState.world.past = [...history];
  adoptionFullState.world.historyCursor = {
      version: 1,
      eventCount: history.length,
      hotStartIndex: 0,
      tailEventId: history.at(-1).id,
  };
  adoptionFullState.world.physicalStructureIndex = {
    calculatedAtMonth: adoptionFullState.clock.elapsedMonths,
    voxelRevision: adoptionFullState.world.physicalStructureIndex.voxelRevision,
    constructionEventCount: 0,
    structures: [],
  };
  adoptionFullState.lastStep = [adoptionFullState.world.past.at(-1)];
  const adoptionSnapshot = await api.encodeSegmentedRunState(
    adoptionFullState, { mode: 'replace' }, { maxEventsPerSegmentForTests: 3 },
  );
  const adoptionChunks = new Map([adoptionSnapshot.root, ...adoptionSnapshot.parts]
    .map((chunk) => [chunk.hash, chunk]));
  const readAdoptionChunk = (hash) => {
    const chunk = adoptionChunks.get(hash);
    if (!chunk) throw new Error(`adoption fixture 缺少 chunk ${hash}`);
    return chunk;
  };
  const adoptionStateHash = adoptionSnapshot.root.hash;
  const encodedFixture = async (state) => {
    const snapshot = await api.encodeSegmentedRunState(
      state, { mode: 'replace' }, { maxEventsPerSegmentForTests: 3 },
    );
    const chunks = new Map([snapshot.root, ...snapshot.parts].map((chunk) => [chunk.hash, chunk]));
    return {
      snapshot,
      readChunk(hash) {
        const chunk = chunks.get(hash);
        if (!chunk) throw new Error(`negative adoption fixture 缺少 chunk ${hash}`);
        return chunk;
      },
    };
  };
  const missingTrafficState = structuredClone(adoptionFullState);
  delete missingTrafficState.world.traffic;
  const missingTrafficFixture = await encodedFixture(missingTrafficState);
  await assert.rejects(
    api.adoptBoundedSimulationState(
      missingTrafficFixture.snapshot.root, missingTrafficFixture.readChunk, { hotEventLimit: 3 },
    ),
    /world.traffic/u,
  );
  const unboundLastStepState = structuredClone(adoptionFullState);
  unboundLastStepState.lastStep = [environment('not-in-ledger-last-step', 7)];
  const unboundLastStepFixture = await encodedFixture(unboundLastStepState);
  await assert.rejects(
    api.adoptBoundedSimulationState(
      unboundLastStepFixture.snapshot.root, unboundLastStepFixture.readChunk, { hotEventLimit: 3 },
    ),
    /lastStep 未绑定/u,
  );
  const receipt = await api.adoptBoundedSimulationState(
    adoptionSnapshot.root, readAdoptionChunk, { hotEventLimit: 3 },
  );
  assert.deepEqual(receipt, {
    kind: 'bounded-simulation-adoption-receipt-v1',
    continuationReady: false,
    stateHash: adoptionStateHash,
    eventCount: history.length,
    hotStartIndex,
  });

  const fullPerson = full.people[0];
  const boundedPerson = bounded.people[0];
  assert.deepEqual(
    api.ownMillLaborFacts(bounded, boundedPerson).map((event) => event.id),
    api.ownMillLaborFacts(full, fullPerson).slice(-3).map((event) => event.id),
    '最近三条机械劳动事实必须在完整历史和 cold pins + hot tail 下等价',
  );
  assert.deepEqual(
    api.mechanicalPowerPressureEvidence(bounded, boundedPerson),
    api.mechanicalPowerPressureEvidence(full, fullPerson),
    '机械压力证据必须在完整历史和有界历史下等价',
  );
  assert.equal(
    api.personalWaterCurrentObservation(bounded, boundedPerson, 'segment-1')?.id,
    api.personalWaterCurrentObservation(full, fullPerson, 'segment-1')?.id,
  );
  assert.equal(api.worldEventById(bounded, 'unretained-cold'), undefined, '未租用冷事实不得泄漏给规则');
  assert.equal(api.worldEventById(bounded, 'cold-duplicate')?.result, 'newer duplicate', '重复 ID 必须选择较晚绝对序号');
  assert.equal(api.worldEventById(bounded, 'shared-id')?.result, 'hot wins', '热窗口必须优先于冷 pin');
  assert.deepEqual(
    api.retainedColdWorldEventsForLease(bounded, 'living-mill-labor:p1:recent-3').map((event) => event.id),
    ['mill-old-1', 'mill-old-2'],
  );
  assert.deepEqual(
    api.worldEventsByIdsInHistoryOrder(bounded, ['tail', 'water-observation']).map((event) => event.id),
    ['water-observation', 'tail'],
  );
  assert.throws(() => api.worldEventFacts(bounded), /不能把热窗口与选择性冷事实冒充完整 replay 历史/u);

  const committedPast = bounded.world.past;
  const overlay = environment('water-observation', 8, 'planning overlay wins');
  bounded.world.past = [...committedPast, overlay];
  api.registerPlanningEventOverlay(bounded, [overlay], committedPast);
  assert.equal(api.worldEventById(bounded, 'water-observation')?.result, 'planning overlay wins');
  assert.equal(api.worldEventById(bounded, 'mill-old-1')?.id, 'mill-old-1', '临时 overlay 下仍须解析稳定 base 的冷 pin');
  api.clearPlanningEventOverlay(bounded);
  bounded.world.past = committedPast;

  const memoryUsage = process.memoryUsage();
  assert.ok(memoryUsage.rss < 256 * 1024 * 1024, 'v29 synthetic fixture RSS 不得超过 256 MiB');
  console.log(JSON.stringify({
    result: 'passed',
    eventCount: history.length,
    hotEventCount: bounded.world.past.length,
    retainedEventCount: retained.length,
    millLaborIds: api.ownMillLaborFacts(bounded, boundedPerson).map((event) => event.id),
    rssBytes: memoryUsage.rss,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
