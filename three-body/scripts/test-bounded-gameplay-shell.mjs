import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-bounded-gameplay-shell-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');
const childEnvironment = { ...process.env, NODE_OPTIONS: '--max-old-space-size=256' };

function readFrom(chunks, replacements = new Map()) {
  return (hash) => {
    if (replacements.has(hash)) return replacements.get(hash);
    const chunk = chunks.get(hash);
    if (!chunk) throw new Error(`fixture missing chunk ${hash}`);
    return chunk;
  };
}

function addSnapshot(chunks, snapshot) {
  for (const chunk of [snapshot.root, ...snapshot.parts]) {
    const existing = chunks.get(chunk.hash);
    if (existing) assert.deepEqual(existing.data, chunk.data, 'content hash collision');
    else chunks.set(chunk.hash, chunk);
  }
}

function intent({
  id,
  ownerId,
  status = 'completed',
  sourceDecisionEventId = `decision:${id}`,
  ...extras
}) {
  return {
    id,
    ownerId,
    summary: id,
    domain: 'strategic',
    goal: { kind: 'at-cell', cellId: 0 },
    nextAction: { kind: 'move', toCellId: 0 },
    status,
    createdAtMonth: 1,
    lastProgressAtMonth: 2,
    progress: status === 'completed' ? 1 : 0,
    sourceDecisionEventId,
    sourceFactIds: [],
    actionEventIds: [],
    replanCount: 0,
    ...extras,
  };
}

function agreement({ id, status, firstId, secondId, kind = 'assist', ...extras }) {
  const proposal = kind === 'companion'
    ? {
      kind: 'companion',
      proposerId: firstId,
      partnerId: secondId,
      expiresAtMonth: 12,
    }
    : {
      kind: 'assist',
      requesterId: firstId,
      helperId: secondId,
      need: 'food',
      expiresAtMonth: 12,
    };
  return {
    id,
    proposal,
    proposerId: firstId,
    responderId: secondId,
    partyIds: [firstId, secondId],
    requiredResponderIds: [secondId],
    acceptedByPersonIds: [],
    rejectedByPersonIds: [],
    status,
    proposedAtMonth: 1,
    acceptByMonth: 12,
    proposalEventId: `proposal:${id}`,
    fulfillmentEventIds: [],
    fulfilledByPersonIds: [],
    coLocatedMonths: 0,
    sourceEventIds: [`proposal:${id}`],
    ...extras,
  };
}

function project({
  id,
  status,
  ownerId,
  beneficiaryIds = [],
  desiredFunction = 'efficient-production',
  ...extras
}) {
  return {
    id,
    kind: 'construction',
    need: desiredFunction === 'durable-power-transmission'
      ? 'remote-work-power'
      : 'production-efficiency',
    desiredFunction,
    summary: id,
    ownerId,
    beneficiaryIds,
    triggerFactIds: [`trigger:${id}`],
    pressure: 1,
    createdAtMonth: 1,
    reviewAtMonth: 12,
    status,
    lastProgressAtMonth: 2,
    missingMaterialIds: [],
    materialDemands: [],
    reservations: [],
    contributorIds: [ownerId],
    actionEventIds: [],
    failureEventIds: [],
    completionEventIds: status === 'completed' ? [`completion:${id}`] : [],
    ...(status === 'completed' ? { completedAtMonth: 2 } : {}),
    ...(status === 'blocked' ? { blockedAtMonth: 2, blockedReason: 'fixture' } : {}),
    ...(status === 'abandoned' ? { abandonedAtMonth: 2 } : {}),
    ...extras,
  };
}

function environmentEvent(index) {
  return {
    id: `gameplay-shell-event-${index}`,
    kind: 'environment',
    atMonth: index,
    orderInMonth: index,
    cellId: 0,
    change: 'material',
    result: `bounded gameplay shell fact ${index}`,
    diff: { fixture: 'bounded-gameplay-shell', index },
  };
}

function componentEvidenceIsEmpty(index) {
  return Object.values(index.components)
    .every((component) => Object.keys(component.evidence).length === 0);
}

try {
  writeFileSync(entryPath, [
    `export * from ${JSON.stringify(path.join(workspace, 'server/run-state-codec.ts'))};`,
    `export * from ${JSON.stringify(path.join(workspace, 'server/bounded-gameplay-shell.ts'))};`,
    `export { createSimulation } from ${JSON.stringify(path.join(workspace, 'src/game/eland/simulation.ts'))};`,
  ].join('\n'));
  execFileSync(path.join(workspace, 'node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { cwd: workspace, env: childEnvironment, stdio: 'pipe' });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  const state = api.createSimulation({
    seed: 83_017,
    config: {
      endpoint: { kind: 'months', value: 1_200 },
      chaosIntensity: 0,
      characterIds: ['galileo', 'freyja', 'newton', 'darwin', 'marie-curie'],
    },
  }).getState();
  assert.ok(state.people.length >= 5, 'fixture requires at least five founders');
  state.clock.elapsedMonths = 24;

  const [livingA, livingB, deadA, deadB, deadC] = state.people;
  for (const person of state.people.slice(2)) {
    person.diedAtMonth = 20;
    person.body.health = 0;
    delete person.activeIntentId;
  }
  const memoryFactId = 'living-memory-intent-fact';
  livingA.memories.push({
    id: 'living-memory-reference',
    kind: 'episode',
    summary: 'remembered terminal intent evidence',
    importance: 80,
    createdAtMonth: 3,
    lastRecalledAtMonth: 24,
    personIds: [deadA.id],
    sourceEventIds: [memoryFactId],
  });
  livingB.activeIntentId = 'intent-person-active-ref';

  const coreIntents = [
    intent({ id: 'intent-active', ownerId: deadA.id, status: 'active' }),
    intent({
      id: 'intent-return-parent',
      ownerId: deadA.id,
      status: 'suspended',
      suspendedByIntentId: 'intent-return-child',
      suspendedAtMonth: 3,
    }),
    intent({
      id: 'intent-return-child',
      ownerId: deadB.id,
      status: 'completed',
      returnToIntentId: 'intent-return-parent',
    }),
    intent({ id: 'intent-living-terminal', ownerId: livingA.id, status: 'blocked' }),
    intent({
      id: 'intent-memory-terminal',
      ownerId: deadB.id,
      status: 'completed',
      sourceDecisionEventId: memoryFactId,
      projectId: 'project-referenced',
      agreementId: 'agreement-referenced',
    }),
    intent({ id: 'intent-person-active-ref', ownerId: deadC.id, status: 'failed' }),
    intent({
      id: 'intent-record-replication-achieved',
      ownerId: deadC.id,
      status: 'completed',
      goal: {
        kind: 'record-replication-receipt',
        basisKey: 'bounded-record-replication-basis',
        readerId: deadC.id,
        projectId: 'project-completed-b',
        recordId: 'bounded-record',
        recordVersion: 1,
        techniqueId: 'bounded-technique',
        ruleSignature: 'bounded-rule',
        expectedOutputMaterialId: 1,
      },
      actionEventIds: [`e-2-action-${deadC.id}-3`],
      goalOutcome: {
        kind: 'achieved',
        resolvedAtMonth: 2,
        sourceEventIds: [`e-2-action-${deadC.id}-3`],
      },
    }),
    intent({
      id: 'intent-record-replication-later',
      ownerId: deadC.id,
      status: 'completed',
      goal: {
        kind: 'record-replication-receipt',
        basisKey: 'bounded-record-replication-basis-later',
        readerId: deadC.id,
        projectId: 'project-completed-b',
        recordId: 'bounded-record-later',
        recordVersion: 1,
        techniqueId: 'bounded-technique-later',
        ruleSignature: 'bounded-rule-later',
        expectedOutputMaterialId: 1,
      },
      actionEventIds: [`e-3-action-${deadC.id}-1`],
      goalOutcome: {
        kind: 'achieved',
        resolvedAtMonth: 3,
        sourceEventIds: [`e-3-action-${deadC.id}-1`],
      },
    }),
    intent({ id: 'intent-dead-unrelated', ownerId: deadA.id, status: 'completed' }),
    intent({ id: 'intent-dead-blocked-unrelated', ownerId: deadB.id, status: 'blocked' }),
  ];
  const intentFiller = Array.from({ length: 70 }, (_, index) => intent({
    id: `intent-dead-filler-${index}`,
    ownerId: index % 2 === 0 ? deadA.id : deadB.id,
    status: index % 3 === 0 ? 'abandoned' : 'completed',
  }));
  state.intents = [...coreIntents, ...intentFiller];
  state.identityCounters = { intentOrdinal: 2 };

  const coreAgreements = [
    agreement({
      id: 'agreement-active', status: 'active', firstId: deadA.id, secondId: deadB.id,
    }),
    agreement({
      id: 'agreement-proposed', status: 'proposed', firstId: deadA.id, secondId: deadB.id,
    }),
    agreement({
      id: 'agreement-companion', status: 'fulfilled', firstId: deadA.id, secondId: deadB.id,
      kind: 'companion', resolvedAtMonth: 8,
    }),
    agreement({
      id: 'agreement-suspension', status: 'expired', firstId: deadA.id, secondId: deadB.id,
      resolvedAtMonth: 8,
      responseDeadlineSuspensions: [{
        kind: 'pause', responderId: deadB.id, hibernationConditionId: 'condition-1',
        atMonth: 4, eventId: 'pause:agreement-suspension', sourceEventIds: [],
      }],
    }),
    agreement({
      id: 'agreement-living-touch', status: 'expired', firstId: livingA.id, secondId: deadA.id,
      resolvedAtMonth: 8,
    }),
    agreement({
      id: 'agreement-referenced', status: 'rejected', firstId: deadA.id, secondId: deadB.id,
      resolvedAtMonth: 8,
    }),
    agreement({
      id: 'agreement-dead-unrelated', status: 'expired', firstId: deadA.id, secondId: deadB.id,
      resolvedAtMonth: 8,
    }),
  ];
  const agreementFiller = Array.from({ length: 70 }, (_, index) => agreement({
    id: `agreement-dead-filler-${index}`,
    status: index % 2 === 0 ? 'expired' : 'cancelled',
    firstId: deadA.id,
    secondId: deadB.id,
    resolvedAtMonth: 8,
  }));
  state.agreements = [...coreAgreements, ...agreementFiller];

  const syncProject = project({
    id: 'project-sync-needed',
    status: 'blocked',
    ownerId: deadA.id,
    searchCampaigns: [{
      id: 'search:project-sync-needed',
      projectId: 'project-sync-needed',
      ownerId: deadA.id,
      actorId: deadA.id,
      materialIds: [],
      attemptedTargetKeys: [],
      sourceFactIds: [],
      status: 'exhausted',
      closedAt: 2,
    }],
  });
  const coreProjects = [
    project({ id: 'project-active', status: 'active', ownerId: deadA.id }),
    project({ id: 'project-completed-a', status: 'completed', ownerId: deadA.id }),
    project({ id: 'project-completed-b', status: 'completed', ownerId: deadB.id }),
    syncProject,
    project({
      id: 'project-living-touch', status: 'blocked', ownerId: deadA.id,
      beneficiaryIds: [livingA.id], terminalInquiryOpportunityBasis: { fixture: 'already-synchronized' },
    }),
    project({
      id: 'project-referenced', status: 'blocked', ownerId: deadB.id,
      terminalInquiryOpportunityBasis: { fixture: 'already-synchronized' },
    }),
    project({
      id: 'project-power-anchor', status: 'abandoned', ownerId: deadC.id,
      desiredFunction: 'durable-power-transmission',
    }),
    project({
      id: 'project-dead-blocked-unrelated', status: 'blocked', ownerId: deadA.id,
      terminalInquiryOpportunityBasis: { fixture: 'already-synchronized' },
    }),
    project({ id: 'project-dead-abandoned-unrelated', status: 'abandoned', ownerId: deadB.id }),
  ];
  const projectFiller = Array.from({ length: 70 }, (_, index) => project({
    id: `project-dead-filler-${index}`,
    status: index % 2 === 0 ? 'blocked' : 'abandoned',
    ownerId: index % 2 === 0 ? deadA.id : deadB.id,
    ...(index % 2 === 0
      ? { terminalInquiryOpportunityBasis: { fixture: 'already-synchronized' } }
      : {}),
  }));
  state.projects = [...coreProjects, ...projectFiller];

  const events = [state.world.past[0], ...Array.from({ length: 6 }, (_, index) => (
    environmentEvent(index + 1)
  ))];
  state.world.past = events;
  state.world.historyCursor = {
    version: 1,
    eventCount: events.length,
    hotStartIndex: 0,
    tailEventId: events.at(-1).id,
  };
  state.lastStep = [events[1], events.at(-1)];

  state.civilization.stage = '古代文明 fixture';
  state.civilization.development = {
    observerVersion: 'material-institution-era-v7',
    currentEra: 'ancient-civilization',
    historicalPeakEra: 'ancient-civilization',
    candidateEra: 'ancient-civilization',
    candidateSinceMonth: 12,
    transitionProgress: 1,
    satisfiedGateIds: [],
    missingGateIds: [],
    supportingEventIds: Array.from({ length: 64 }, (_, index) => `observer-evidence-${index}`),
    materialCapabilities: [],
  };
  for (const [key, component] of Object.entries(
    state.civilization.civilizationIndex.components,
  )) {
    component.evidence = { [`exact-${key}`]: 1 };
  }
  state.derived = {
    practices: [{ id: 'exact-practice', evidenceEventIds: ['observer-evidence-1'] }],
    institutions: [{ id: 'exact-institution', evidenceEventIds: ['observer-evidence-2'] }],
    milestones: Array.from({ length: 3 }, (_, index) => ({
      id: `exact-milestone-${index}`,
      evidenceEventIds: [`observer-evidence-${index}`],
    })),
    regions: [{ id: 'exact-region', evidenceEventIds: ['observer-evidence-3'] }],
    structures: [{ id: 'exact-structure', evidenceEventIds: ['observer-evidence-4'] }],
    functionalBuildings: [{ id: 'exact-building', evidenceEventIds: ['observer-evidence-5'] }],
  };

  const originalPersonIds = state.people.map((person) => person.id);
  const exactIntentCount = state.intents.length;
  const exactMilestoneCount = state.derived.milestones.length;
  const exactSnapshot = await api.encodeSegmentedRunState(
    state,
    { mode: 'replace' },
    { maxEventsPerSegmentForTests: 2 },
  );
  const chunks = new Map();
  addSnapshot(chunks, exactSnapshot);
  const exactAuthority = {
    stateHash: exactSnapshot.root.hash,
    revision: 42,
    month: 24,
    lastMaterializedMilestoneCount: exactMilestoneCount,
  };

  const first = await api.decodeSegmentedRunStateGameplayBounded(
    exactSnapshot.root,
    readFrom(chunks),
    {
      hotEventLimit: 2,
      pinnedEventIndexes: [1],
      observerAuthority: exactAuthority,
    },
  );

  assert.deepEqual(first.state.people.map((person) => person.id), originalPersonIds,
    'all people must remain in source order');
  assert.equal(first.gameplayShell.sourceArrayLengths['state.people'], state.people.length);
  assert.equal(first.gameplayShell.retainedArrayLengths['state.people'], state.people.length);

  const expectedIntentIds = [
    'intent-active',
    'intent-return-parent',
    'intent-return-child',
    'intent-living-terminal',
    'intent-memory-terminal',
    'intent-person-active-ref',
    'intent-record-replication-achieved',
  ];
  assert.deepEqual(first.state.intents.map(({ id }) => id), expectedIntentIds,
    'live closure plus only the first canonical dead-reader replication witness remain in manifest order');
  assert.equal(first.state.intents.some(({ id }) => id === 'intent-record-replication-later'), false,
    'a later achieved replication must not grow the bounded terminal intent closure');
  assert.equal(first.gameplayShell.sourceArrayLengths['state.intents'], exactIntentCount);
  assert.equal(first.gameplayShell.retainedArrayLengths['state.intents'], expectedIntentIds.length);
  assert.equal(first.state.identityCounters.intentOrdinal, exactIntentCount,
    'intent ordinal must use the pre-compaction manifest field length');

  const expectedAgreementIds = [
    'agreement-active',
    'agreement-proposed',
    'agreement-companion',
    'agreement-suspension',
    'agreement-living-touch',
    'agreement-referenced',
  ];
  assert.deepEqual(first.state.agreements.map(({ id }) => id), expectedAgreementIds,
    'agreement lifecycle/living/reference closure must remain in source order');

  const expectedProjectIds = [
    'project-active',
    'project-completed-a',
    'project-completed-b',
    'project-sync-needed',
    'project-living-touch',
    'project-referenced',
    'project-power-anchor',
  ];
  assert.deepEqual(first.state.projects.map(({ id }) => id), expectedProjectIds,
    'project lifecycle/completion/reference/power closure must remain in source order');

  assert.deepEqual(first.state.world.past.map(({ id }) => id), events.slice(-2).map(({ id }) => id));
  assert.deepEqual(first.state.world.historyCursor, {
    version: 1,
    eventCount: events.length,
    hotStartIndex: events.length - 2,
    tailEventId: events.at(-1).id,
  });
  assert.deepEqual(first.pinnedEvents.map(({ absoluteIndex, event }) => ({
    absoluteIndex,
    id: event.id,
  })), [{ absoluteIndex: 1, id: events[1].id }]);
  assert.strictEqual(first.state.lastStep[0], first.pinnedEvents[0].event,
    'cold lastStep event must rebind to the verified pin');
  assert.strictEqual(first.state.lastStep[1], first.state.world.past.at(-1),
    'hot lastStep event must rebind to the verified hot tail');

  assert.equal(Object.hasOwn(first.state.civilization, 'development'), false);
  assert.equal(componentEvidenceIsEmpty(first.state.civilization.civilizationIndex), true);
  assert.deepEqual(first.state.derived, {
    practices: [], institutions: [], milestones: [], regions: [], structures: [],
  });
  assert.deepEqual(first.state.lastMaterializedObserverBasis.source, {
    stateHash: exactSnapshot.root.hash,
    revision: 42,
    month: 24,
  });
  assert.equal(first.state.lastMaterializedObserverBasis.milestoneCount, exactMilestoneCount);
  assert.equal(first.state.lastMaterializedObserverBasis.stage, state.civilization.stage);
  assert.deepEqual(first.state.lastMaterializedObserverBasis.developmentSnapshot, {
    observerVersion: state.civilization.development.observerVersion,
    currentEra: state.civilization.development.currentEra,
    historicalPeakEra: state.civilization.development.historicalPeakEra,
    candidateEra: state.civilization.development.candidateEra,
    candidateSinceMonth: state.civilization.development.candidateSinceMonth,
  });
  assert.equal(api.materializedObserverMilestoneCount(first.state), exactMilestoneCount);

  const compactSnapshot = await api.encodeSegmentedRunStateFromHistorySuffix(
    first.state,
    api.runHistoryCursorFromRootMetadata(exactSnapshot.metadata),
    [],
    { maxEventsPerSegmentForTests: 2 },
  );
  addSnapshot(chunks, compactSnapshot);
  assert.notEqual(compactSnapshot.root.hash, exactSnapshot.root.hash,
    'compacted shell must create a distinct exact root');
  const second = await api.decodeSegmentedRunStateGameplayBounded(
    compactSnapshot.root,
    readFrom(chunks),
    {
      hotEventLimit: 2,
      pinnedEventIndexes: [1],
      observerAuthority: {
        stateHash: compactSnapshot.root.hash,
        revision: 43,
        month: 24,
        lastMaterializedMilestoneCount: exactMilestoneCount,
      },
    },
  );
  assert.deepEqual(second.state.lastMaterializedObserverBasis,
    first.state.lastMaterializedObserverBasis,
    'reopening a compact root must preserve the exact last-materialized observer basis');
  assert.equal(second.state.identityCounters.intentOrdinal, exactIntentCount,
    'reopening a compact root must not lower the intent high-water mark');
  assert.equal(second.gameplayShell.sourceArrayLengths['state.intents'], expectedIntentIds.length);
  assert.deepEqual(second.state.intents.map(({ id }) => id), expectedIntentIds);
  assert.deepEqual(second.state.world.past.map(({ id }) => id), events.slice(-2).map(({ id }) => id));
  assert.deepEqual(second.pinnedEvents.map(({ absoluteIndex }) => absoluteIndex), [1]);
  assert.equal(api.materializedObserverMilestoneCount(second.state), exactMilestoneCount);

  const eventSegments = exactSnapshot.parts.filter(
    (chunk) => chunk.codec === api.RUN_STATE_EVENT_SEGMENT_CODEC,
  );
  assert.ok(eventSegments.length >= 3, 'fixture must have a later cold event segment to corrupt');
  const lateFailureSource = eventSegments[0];
  const corruptedBytes = Buffer.from(lateFailureSource.data);
  corruptedBytes[0] ^= 0xff;
  const corruptReader = readFrom(chunks, new Map([[
    lateFailureSource.hash,
    { ...lateFailureSource, data: corruptedBytes },
  ]]));
  let corruptResult;
  await assert.rejects(async () => {
    corruptResult = await api.decodeSegmentedRunStateGameplayBounded(
      exactSnapshot.root,
      corruptReader,
      {
        hotEventLimit: 2,
        pinnedEventIndexes: [1],
        observerAuthority: exactAuthority,
      },
    );
  }, /SHA-256/u, 'a late corrupt history segment must reject the staged gameplay shell');
  assert.equal(corruptResult, undefined,
    'no partial state, pins, or gameplay shell receipt may escape a later ledger failure');

  const maxRssBytes = process.resourceUsage().maxRSS * 1_024;
  assert.ok(maxRssBytes < 256 * 1_024 * 1_024,
    `bounded gameplay shell fixture RSS ${maxRssBytes} must remain below 256 MiB`);
  console.log(JSON.stringify({
    ok: true,
    source: {
      people: state.people.length,
      intents: exactIntentCount,
      agreements: state.agreements.length,
      projects: state.projects.length,
    },
    retained: {
      people: first.state.people.length,
      intents: first.state.intents.length,
      agreements: first.state.agreements.length,
      projects: first.state.projects.length,
    },
    hotEventCount: first.state.world.past.length,
    coldPinCount: first.pinnedEvents.length,
    milestoneCount: api.materializedObserverMilestoneCount(first.state),
    compactRootReopened: true,
    maxRssBytes,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
