import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-retention-intent-snapshot-'));
const entryPath = path.join(temporaryDirectory, 'entry.mjs');
const bundlePath = path.join(temporaryDirectory, 'bundle.mjs');
const authority = { stateHash: 'a'.repeat(64) };

function baseEvent(id, atMonth) {
  return {
    id,
    atMonth,
    orderInMonth: 0,
    planningTick: 1,
    orderInTick: 0,
    cellId: 0,
  };
}

function environment(id, atMonth) {
  return {
    ...baseEvent(id, atMonth),
    kind: 'environment',
    change: 'condition',
    result: id,
    diff: {},
  };
}

function decision(id, atMonth, who) {
  return {
    ...baseEvent(id, atMonth),
    kind: 'decision',
    who,
    decision: { kind: 'fixture', optionId: id, reason: id },
    usedModel: false,
    result: id,
  };
}

function action(id, atMonth, who, actionValue, status = 'completed') {
  return {
    ...baseEvent(id, atMonth),
    kind: 'action',
    actionTick: 1,
    who,
    cause: 'intent',
    action: actionValue,
    fromCellId: 0,
    toCellId: 0,
    fromZ: 1,
    toZ: 1,
    pathSegment: [],
    status,
    result: id,
    diff: {},
  };
}

function person(id) {
  return {
    id,
    bornAtMonth: 0,
    body: { health: 80, hydration: 80, nutrition: 80 },
    memories: [],
    conditions: [],
    relations: [],
    bereavements: [],
    maternalTeachingSourceEventIds: [],
    geneticParents: [],
    inventory: [],
    knowledge: [],
  };
}

function baseIntent(id, ownerId, status, sourceDecisionEventId) {
  return {
    id,
    ownerId,
    summary: id,
    domain: 'strategic',
    goal: { kind: 'condition', personId: ownerId, condition: 'dehydrated', present: false },
    nextAction: { kind: 'act', operation: 'exert', targets: [] },
    status,
    createdAtMonth: 1,
    lastProgressAtMonth: 1,
    progress: 0,
    sourceDecisionEventId,
    sourceFactIds: [],
    actionEventIds: [],
    replanCount: 0,
  };
}

const openingAction = {
  kind: 'communicate',
  channel: 'voice',
  audience: ['p1'],
  content: {
    kind: 'claim',
    id: 'opening-claim',
    factId: 'fixture:opening',
    summary: 'opening',
    conversation: {
      conversationId: 'fixture-conversation',
      turn: 'opening',
      speakerId: 'p2',
      listenerId: 'p1',
      sourceFactIds: ['response-source'],
    },
  },
};

const events = [
  action('opening-event', 1, 'p2', openingAction),
  environment('response-source', 2),
  decision('active-response-decision', 3, 'p1'),
  action('active-response-action', 4, 'p1', { kind: 'act', operation: 'exert', targets: [] }),
  decision('suspended-decision', 5, 'p2'),
  action('terminal-failure-action', 6, 'p1', { kind: 'act', operation: 'exert', targets: [] }, 'failed'),
  decision('reproduction-decision', 7, 'p2'),
  environment('tail', 8),
];

const responseIntent = {
  ...baseIntent('active-response-intent', 'p1', 'active', 'active-response-decision'),
  sourceFactIds: ['response-source'],
  actionEventIds: ['active-response-action'],
  nextAction: {
    kind: 'communicate',
    channel: 'voice',
    audience: ['p2'],
    content: {
      kind: 'claim',
      id: 'response-claim',
      factId: 'fixture:response',
      summary: 'response',
      conversation: {
        conversationId: 'fixture-conversation',
        turn: 'response',
        speakerId: 'p1',
        listenerId: 'p2',
        referenceEventId: 'opening-event',
        sourceFactIds: ['response-source'],
      },
    },
  },
};

const suspendedIntent = baseIntent(
  'suspended-intent',
  'p2',
  'suspended',
  'suspended-decision',
);

const terminalFailureIntent = {
  ...baseIntent('terminal-failure-intent', 'p1', 'failed', 'active-response-decision'),
  actionEventIds: ['terminal-failure-action'],
  goalOutcome: {
    version: 'intent-goal-outcome-v1',
    kind: 'attempted-unmet',
    basisKey: 'fixture-terminal-failure',
    resolvedAtMonth: 10,
    sourceEventIds: ['terminal-failure-action'],
  },
};

const reproductionIntent = {
  ...baseIntent('reproduction-intent', 'p2', 'active', 'reproduction-decision'),
  goal: { kind: 'condition', condition: 'pregnancy', present: true, personId: 'p1' },
  nextAction: {
    kind: 'act',
    operation: 'reproduce',
    targets: [{ kind: 'person', personId: 'p1' }],
  },
};

const ignoredCompletedIntents = Array.from({ length: 128 }, (_, index) => ({
  ...baseIntent(
    `completed-noise-${index}`,
    index % 2 === 0 ? 'p1' : 'p2',
    'completed',
    'active-response-decision',
  ),
  createdAtMonth: index,
}));

const shell = {
  clock: { elapsedMonths: 12 },
  world: {
    past: [],
    historyCursor: {
      version: 1,
      eventCount: events.length,
      hotStartIndex: events.length,
      tailEventId: events.at(-1).id,
    },
  },
  people: [person('p1'), person('p2')],
  intents: [
    responseIntent,
    suspendedIntent,
    terminalFailureIntent,
    reproductionIntent,
    ...ignoredCompletedIntents,
  ],
  agreements: [],
  eraPredictions: [],
  projects: [],
  records: [],
  containers: [],
  collectives: [],
  permissions: [],
};

function finishProjection(api, begin) {
  const fold = begin(shell, authority);
  api.foldHistoryRetentionSegment(fold, events, 0);
  return api.finishHistoryRetentionProjection(fold);
}

try {
  writeFileSync(entryPath, [
    `export * from ${JSON.stringify(path.resolve('server/history-retention-projection.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('server/history-retention-codec.ts'))};`,
  ].join('\n'));
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], {
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=256' },
    stdio: 'pipe',
  });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  api.resetHistoryRetentionIntentTraversalStatsForTests();
  const optimized = finishProjection(api, api.beginHistoryRetentionProjection);
  assert.deepEqual(api.historyRetentionIntentTraversalStatsForTests(), {
    fullTraversals: 1,
    snapshotClassifications: 1,
    referenceCollections: 0,
  }, 'optimized collectDemand 必须只分类并整表遍历 intents 一次');

  api.resetHistoryRetentionIntentTraversalStatsForTests();
  const reference = finishProjection(
    api,
    api.beginHistoryRetentionProjectionWithReferenceIntentTraversalForTests,
  );
  assert.deepEqual(api.historyRetentionIntentTraversalStatsForTests(), {
    fullTraversals: 4,
    snapshotClassifications: 0,
    referenceCollections: 1,
  }, 'reference oracle 必须保留改动前四次 intents 整表扫描');

  assert.deepEqual(
    optimized.continuationBasis.sourceDemand,
    reference.continuationBasis.sourceDemand,
    'snapshot/reference canonical continuation demand 必须逐字一致',
  );
  assert.equal(optimized.demandFingerprint, reference.demandFingerprint);
  assert.deepEqual(optimized.demandGroups, reference.demandGroups);
  assert.deepEqual(optimized.pins, reference.pins);
  assert.deepEqual(optimized, reference, 'snapshot/reference projection 必须完全一致');

  const groundedLease = api.groundedConversationResponseSourceLeaseKey('p1', 'opening-event');
  assert.deepEqual(
    optimized.demandGroups.find((group) => group.groupKey === groundedLease),
    {
      groupKey: groundedLease,
      requirement: 'all',
      leaseKeys: [groundedLease],
      eventIds: ['opening-event', 'response-source'],
      resolvedEventIds: ['opening-event', 'response-source'],
      unresolvedEventIds: [],
      satisfied: true,
      blocking: false,
    },
    'grounded-response 分类必须保持规范 eventIds 顺序和 lease 语义',
  );
  assert.ok(optimized.demandGroups.some((group) => (
    group.groupKey === 'live-intent:active-response-intent:anchors'
    && group.eventIds.join(',') === 'active-response-action,active-response-decision'
  )), 'active intent 必须保留 exact live core');
  assert.ok(optimized.demandGroups.some((group) => (
    group.groupKey === 'live-intent:suspended-intent:anchors'
    && group.eventIds.join(',') === 'suspended-decision'
  )), 'suspended intent 必须保留 exact live core');
  assert.ok(optimized.demandGroups.some((group) => (
    group.groupKey === api.recentTerminalFailureActionLeaseKey('p1')
    && group.eventIds.join(',') === 'terminal-failure-action'
  )), '近六个月 terminal failure 必须保留 action/outcome 交集');
  assert.ok(optimized.demandGroups.some((group) => (
    group.groupKey === 'active-reproduction-intent:reproduction-intent:facts'
    && group.eventIds.join(',') === 'reproduction-decision'
  )), 'reproduction selector 必须保留 source decision anchor');

  const optimizedEncoded = api.encodeHistoryRetentionSidecar(optimized);
  const referenceEncoded = api.encodeHistoryRetentionSidecar(reference);
  assert.equal(
    optimizedEncoded.reference.hash,
    referenceEncoded.reference.hash,
    'snapshot/reference projection 编码 hash 必须一致',
  );
  assert.deepEqual(
    optimizedEncoded.chunk.data,
    referenceEncoded.chunk.data,
    'snapshot/reference canonical sidecar bytes 必须一致',
  );

  const addedIntent = baseIntent(
    'next-collect-active-intent',
    'p1',
    'active',
    'active-response-decision',
  );
  shell.intents.push(addedIntent);
  api.resetHistoryRetentionIntentTraversalStatsForTests();
  const nextFold = api.beginHistoryRetentionProjection(shell, authority);
  assert.ok(
    nextFold.demandGroupsByKey.has('live-intent:next-collect-active-intent:anchors'),
    '下一次 collectDemand 必须观察新 intent，局部快照不得跨调用复用',
  );
  assert.deepEqual(api.historyRetentionIntentTraversalStatsForTests(), {
    fullTraversals: 1,
    snapshotClassifications: 1,
    referenceCollections: 0,
  });
  shell.intents.pop();

  console.log('retention demand intent snapshot tests passed (full intent traversals: 4 -> 1)');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
