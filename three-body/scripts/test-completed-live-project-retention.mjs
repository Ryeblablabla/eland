import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-completed-live-project-retention-'));
const bundlePath = path.join(temporaryDirectory, 'completed-live-project-retention.mjs');
const childEnvironment = { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' };

function action(id, atMonth, orderInMonth, who, diff = {}) {
  return {
    id,
    atMonth,
    orderInMonth,
    planningTick: 1,
    orderInTick: orderInMonth,
    cellId: 0,
    kind: 'action',
    actionTick: 1,
    who,
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

function completedProject({
  id,
  ownerId,
  beneficiaryIds = [],
  contributorIds = [],
  actionEventIds = [],
  completionEventIds = [],
}) {
  return {
    id,
    kind: 'construction',
    need: 'shelter-capacity',
    desiredFunction: 'weather-shelter',
    summary: id,
    ownerId,
    beneficiaryIds,
    triggerFactIds: [],
    pressure: 50,
    createdAtMonth: 1,
    reviewAtMonth: 2,
    status: 'completed',
    lastProgressAtMonth: 2,
    missingMaterialIds: [],
    reservations: [],
    contributorIds,
    actionEventIds,
    failureEventIds: [],
    completedAtMonth: 2,
    completionEventIds,
  };
}

function conversationFor(option) {
  const selected = option.nextAction?.kind === 'communicate'
    ? option.nextAction
    : option.completionAction;
  return selected?.kind === 'communicate'
    && selected.content?.kind === 'claim'
    ? selected.content.conversation
    : undefined;
}

try {
  const entry = [
    `export * from ${JSON.stringify(path.resolve('server/history-retention-projection.ts'))};`,
    `export { installVerifiedHistoryRetentionEvidence } from ${JSON.stringify(path.resolve('server/retained-history-evidence.ts'))};`,
    `export { buildGroundedConversationOptions } from ${JSON.stringify(path.resolve('src/game/eland/application/conversation-options.ts'))};`,
    `export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/simulation-runtime.ts'))};`,
  ].join('\n');
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--loader=ts',
    '--sourcefile=completed-live-project-retention-entry.ts',
    `--outfile=${bundlePath}`,
  ], { input: entry, env: childEnvironment, stdio: ['pipe', 'pipe', 'pipe'] });

  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
  const state = api.createInitialState(20260828, {
    characterIds: ['laozi', 'qinshihuang', 'marie-curie', 'ada-lovelace'],
    endpoint: { kind: 'months', value: 24 },
  });
  assert.equal(state.people.length, 4, 'fixture 需要两个存活者和两个死者');
  const [livingA, livingB, deadA, deadB] = state.people;
  for (const person of state.people) {
    person.bornAtMonth = -240;
    person.position = {
      ...person.position,
      cellId: livingA.position.cellId,
      z: livingA.position.z,
      previousCellId: livingA.position.cellId,
      previousZ: livingA.position.z,
      lastPath: [livingA.position.cellId],
      tickPath: [livingA.position.cellId],
    };
    person.conditions = [];
    person.inventory = [];
    person.knowledge = [];
    person.knownPlaces = [];
    person.memories = [];
    person.relations = [];
    person.bereavements = [];
    person.maternalTeachingSourceEventIds = [];
    person.geneticParents = [];
    delete person.diedAtMonth;
    person.body.health = 80;
  }
  for (const person of [deadA, deadB]) {
    person.diedAtMonth = 1;
    person.body.health = 0;
  }
  state.clock.elapsedMonths = 2;
  state.intents = [];
  state.agreements = [];
  state.eraPredictions = [];
  state.lastStep = [];
  state.world.mechanicalPower = {
    version: 'mechanical-power-world-v1',
    sources: [],
    networks: [],
  };
  delete state.world.electricalPower;

  const history = [
    action('placement-cold', 1, 0, livingA.id, {
      outputMaterialId: 1,
      position: { x: 0, y: 0, z: 0 },
    }),
    action('dead-only-completion', 1, 1, deadA.id),
    action('shared-old-action', 1, 2, livingA.id),
    action('shared-old-completion', 1, 3, livingB.id),
    action('shared-z', 1, 4, livingA.id),
    action('shared-b', 1, 5, livingB.id),
    action('shared-a', 1, 6, livingA.id),
    action('shared-e', 1, 7, livingB.id),
    action('shared-c', 1, 8, livingA.id),
    action('shared-d', 2, 0, livingB.id),
    action('beneficiary-hot-completion', 2, 1, deadA.id),
    action('tail-hot', 2, 2, livingA.id),
  ];
  const hotStartIndex = 9;
  state.world.past = history.slice(hotStartIndex);
  state.world.historyCursor = {
    version: 1,
    eventCount: history.length,
    hotStartIndex,
    tailEventId: history.at(-1).id,
  };

  const placement = completedProject({
    id: 'placement-project',
    ownerId: livingA.id,
    beneficiaryIds: [livingA.id],
    completionEventIds: ['placement-cold'],
  });
  const olderShared = completedProject({
    id: 'older-shared-project',
    ownerId: livingA.id,
    beneficiaryIds: [livingA.id, livingB.id],
    contributorIds: [livingB.id],
    actionEventIds: ['shared-old-action'],
    completionEventIds: ['shared-old-completion'],
  });
  const latestShared = completedProject({
    id: 'latest-shared-project',
    ownerId: livingA.id,
    beneficiaryIds: [livingA.id, livingB.id],
    contributorIds: [livingB.id],
    actionEventIds: ['shared-z', 'shared-a', 'shared-e', 'shared-c'],
    completionEventIds: ['shared-b', 'shared-d'],
  });
  const emptyNewerShared = completedProject({
    id: 'empty-newer-shared-project',
    ownerId: livingA.id,
    beneficiaryIds: [livingA.id, livingB.id],
    contributorIds: [livingB.id],
  });
  const livingBeneficiary = completedProject({
    id: 'living-beneficiary-project',
    ownerId: deadA.id,
    beneficiaryIds: [livingB.id],
    completionEventIds: ['beneficiary-hot-completion'],
  });
  const deadOnly = completedProject({
    id: 'dead-only-project',
    ownerId: deadA.id,
    beneficiaryIds: [deadA.id],
    contributorIds: [deadB.id],
    completionEventIds: ['dead-only-completion'],
  });
  state.projects = [
    placement,
    olderShared,
    latestShared,
    emptyNewerShared,
    livingBeneficiary,
    deadOnly,
  ];

  const authority = { stateHash: 'a'.repeat(64) };
  const fold = api.beginHistoryRetentionProjection(state, authority);
  api.foldHistoryRetentionSegment(fold, history, 0);
  const projection = api.finishHistoryRetentionProjection(fold);
  assert.equal(projection.demandFingerprint, projection.continuationBasis.sourceDemandFingerprint,
    '新需求必须进入 source seal fingerprint');

  const groups = new Map(projection.demandGroups.map((group) => [group.groupKey, group]));
  const placementLease = api.completedLiveProjectCompletionLeaseKey(placement.id);
  assert.deepEqual(groups.get(placementLease)?.eventIds, ['placement-cold']);
  assert.equal(groups.get(placementLease)?.requirement, 'all');
  assert.equal(groups.get(placementLease)?.satisfied, true);
  assert.ok(projection.pins.some((pin) => (
    pin.eventId === 'placement-cold'
      && pin.absoluteIndex < hotStartIndex
      && pin.leaseKeys.includes(placementLease)
  )), '冷区 placement completion 必须保留');

  const beneficiaryLease = api.completedLiveProjectCompletionLeaseKey(livingBeneficiary.id);
  assert.equal(groups.get(beneficiaryLease)?.satisfied, true,
    '存活 beneficiary 必须让完工来源续租');
  assert.ok(projection.pins.some((pin) => (
    pin.eventId === 'beneficiary-hot-completion'
      && pin.absoluteIndex >= hotStartIndex
      && pin.leaseKeys.includes(beneficiaryLease)
  )), '当前 hot ref 也必须在同一需求密封中校验');

  const latestSharedLease = api.livingSharedProjectActionLeaseKey(
    livingA.id,
    livingB.id,
    latestShared.id,
  );
  assert.deepEqual(
    groups.get(latestSharedLease)?.eventIds,
    ['shared-a', 'shared-c', 'shared-e', 'shared-z'],
    '只应为 latestSharedProjectBetween 选中项目续租 action 来源',
  );
  assert.equal(
    projection.demandGroups.some((group) => group.groupKey.includes(encodeURIComponent(olderShared.id))
      && group.groupKey.endsWith(':action-events')),
    false,
    '旧共同项目的 action 不得冒充当前 shared-work 来源',
  );
  assert.equal(projection.pins.some((pin) => pin.eventId === 'shared-old-action'), false);
  assert.equal(projection.pins.some((pin) => pin.eventId === 'dead-only-completion'), false,
    '无存活 owner/beneficiary/contributor 的项目不得占用保留集');

  const capState = structuredClone(state);
  capState.projects = [completedProject({
    id: 'shared-source-cap-project',
    ownerId: livingA.id,
    beneficiaryIds: [livingA.id, livingB.id],
    contributorIds: [livingB.id],
    actionEventIds: Array.from(
      { length: api.HISTORY_RETENTION_MAX_COMPLETED_PROJECT_SOURCE_EVENT_IDS + 1 },
      (_, index) => `over-cap-action-${index}`,
    ),
    completionEventIds: ['tail-hot'],
  })];
  assert.throws(
    () => api.beginHistoryRetentionProjection(capState, { stateHash: 'b'.repeat(64) }),
    /completed shared project shared-source-cap-project action events.*4096/u,
    '无法有界精确重建 shared-work 来源时必须 fail closed，不得截断猜测',
  );

  const decodedColdPins = projection.pins
    .filter((pin) => pin.absoluteIndex < hotStartIndex)
    .map((pin) => ({ absoluteIndex: pin.absoluteIndex, event: history[pin.absoluteIndex] }));
  api.installVerifiedHistoryRetentionEvidence(
    state,
    authority.stateHash,
    projection,
    decodedColdPins,
  );
  const sharedWork = api.buildGroundedConversationOptions(
    state,
    livingA,
    [livingB],
    state.clock.elapsedMonths,
  ).find((option) => conversationFor(option)?.topic === 'shared-work');
  assert.ok(sharedWork, '安装 cold pins 后必须仍能产生可交互的 shared-work 对话');
  assert.deepEqual(
    conversationFor(sharedWork).sourceFactIds,
    ['shared-c', 'shared-d', 'shared-e', 'shared-z'],
    '冷/热来源合并后 resolved sort + last-4 必须与完整历史一致',
  );

  process.stdout.write('completed live-project retention tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
