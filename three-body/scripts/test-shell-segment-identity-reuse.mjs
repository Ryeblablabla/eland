import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-shell-identity-reuse-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');

function completedProject(index, ownerId, extra = {}) {
  return {
    id: `completed-project-${index}`,
    kind: 'construction',
    need: 'production-efficiency',
    desiredFunction: 'efficient-production',
    summary: `closed completed project ${index}`,
    ownerId,
    beneficiaryIds: [],
    triggerFactIds: [],
    pressure: 1,
    createdAtMonth: 0,
    reviewAtMonth: 1,
    status: 'completed',
    lastProgressAtMonth: 0,
    missingMaterialIds: [],
    materialDemands: [],
    reservations: [],
    contributorIds: [ownerId],
    actionEventIds: [],
    failureEventIds: [],
    completionEventIds: [],
    completedAtMonth: 0,
    ...extra,
  };
}

function terminalInquiryOpportunityBasis(ownerId, index) {
  return {
    version: 'project-inquiry-opportunity-basis-v1',
    actorId: ownerId,
    desiredFunction: 'efficient-production',
    atMonth: 0,
    materialIds: [],
    techniqueIds: [],
    targetSourceKeys: [],
    verifiedResponseEventIds: [],
    opportunityKeys: [],
    opportunitySources: [],
    sourceFactIds: [],
    sourceKeys: [],
    basisKey: `terminal-basis-${index}`,
    inheritedProjectIds: [],
    renewalKeys: [],
  };
}

function blockedProject(index, ownerId, extra = {}) {
  const project = completedProject(index, ownerId, {
    status: 'blocked',
    blockedAtMonth: 0,
    blockedReason: 'closed bounded inquiry',
    terminalInquiryOpportunityBasis: terminalInquiryOpportunityBasis(ownerId, index),
    ...extra,
  });
  delete project.completedAtMonth;
  return project;
}

function abandonedProject(index, ownerId, extra = {}) {
  const project = completedProject(index, ownerId, {
    status: 'abandoned',
    abandonedAtMonth: 0,
    blockedReason: 'need resolved before completion',
    ...extra,
  });
  delete project.completedAtMonth;
  return project;
}

function closedTerminalProject(index, ownerId, variant) {
  if (variant % 3 === 1) return blockedProject(index, ownerId);
  if (variant % 3 === 2) return abandonedProject(index, ownerId);
  return completedProject(index, ownerId);
}

function addChunks(target, snapshot) {
  for (const chunk of [snapshot.root, ...snapshot.parts]) {
    const existing = target.get(chunk.hash);
    if (existing) {
      assert.equal(existing.codec, chunk.codec);
      assert.equal(existing.rawSize, chunk.rawSize);
      assert.deepEqual(Buffer.from(existing.data), Buffer.from(chunk.data));
    } else {
      target.set(chunk.hash, chunk);
    }
  }
}

function sumStats(target, stats) {
  for (const key of [
    'serializeCalls',
    'serializedRawBytes',
    'compressedOutputBytes',
    'brotliCalls',
    'identityReuseChecks',
    'identityReuseHits',
    'identityReuseMisses',
  ]) target[key] = (target[key] ?? 0) + stats[key];
}

try {
  writeFileSync(entryPath, [
    `export * from ${JSON.stringify(path.resolve('server/run-state-codec.ts'))};`,
    `export { SqliteRunStore } from ${JSON.stringify(path.resolve('server/sqlite-run-store.ts'))};`,
    `export { stepOwnedBoundedNonProjectionMonth } from ${JSON.stringify(path.resolve('server/bounded-nonprojection-month-controller.ts'))};`,
    `export { createInitialState, createSimulation } from ${JSON.stringify(path.resolve('src/game/eland/simulation.ts'))};`,
  ].join('\n'));
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
  const codec = api;
  const simulation = api;
  const fixedHistory = Object.freeze({
    lineageId: '00000000-0000-4000-8000-000000000091',
    historyHeadHash: null,
    eventCount: 0,
    tailEventContentHash: null,
  });

  // The eligibility gate accepts only terminal projects with no remaining
  // monthly synchronization path. In particular, a blocked project needs its
  // frozen inquiry basis; merely having a terminal-looking status is not enough.
  const predicateState = simulation.createInitialState(91_001, {
    endpoint: { kind: 'months', value: 12_000 },
  });
  const ownerId = predicateState.people[0].id;
  const clean = completedProject('clean', ownerId, {
    logisticsEpisodes: [{ status: 'fulfilled' }],
    searchCampaigns: [{ status: 'closed' }],
    hypothesisCampaign: { status: 'closed' },
  });
  const closedBlocked = blockedProject('closed-blocked', ownerId, {
    logisticsEpisodes: [{ status: 'exhausted' }],
    searchCampaigns: [{ status: 'exhausted' }],
    hypothesisCampaign: { status: 'exhausted' },
  });
  const closedAbandoned = abandonedProject('closed-abandoned', ownerId, {
    logisticsEpisodes: [{ status: 'invalidated' }],
    searchCampaigns: [{ status: 'closed' }],
    hypothesisCampaign: { status: 'closed' },
  });
  const staleCompatibilityId = completedProject('stale-id', ownerId, {
    activeLogisticsEpisodeId: undefined,
  });
  const activeLogistics = completedProject('active-logistics', ownerId, {
    logisticsEpisodes: [{ status: 'active' }],
  });
  const activeSearch = completedProject('active-search', ownerId, {
    searchCampaigns: [{ status: 'active' }],
  });
  const activeHypothesis = completedProject('active-hypothesis', ownerId, {
    hypothesisCampaign: { status: 'active' },
  });
  const continuableBlocked = {
    ...completedProject('continuable-blocked', ownerId),
    status: 'blocked',
    searchCampaigns: [{ status: 'exhausted' }],
  };
  const blockedWithActiveWork = blockedProject('blocked-active-work', ownerId, {
    searchCampaigns: [{ status: 'active' }],
  });
  const abandonedWithActiveWork = abandonedProject('abandoned-active-work', ownerId, {
    hypothesisCampaign: { status: 'active' },
  });
  const active = { ...completedProject('active', ownerId), status: 'active' };
  const proposed = { ...completedProject('proposed', ownerId), status: 'proposed' };
  const nonPlain = completedProject('non-plain', ownerId, { compatibilityScratch: new Map() });
  predicateState.projects = [
    clean,
    closedBlocked,
    closedAbandoned,
    staleCompatibilityId,
    activeLogistics,
    activeSearch,
    activeHypothesis,
    continuableBlocked,
    blockedWithActiveWork,
    abandonedWithActiveWork,
    active,
    proposed,
    nonPlain,
  ];
  assert.equal(codec.stabilizeCompletedProjectsForRunStateShellReuse(predicateState), 3);
  for (const project of predicateState.projects.slice(0, 3)) assert.ok(Object.isFrozen(project));
  assert.ok(Object.isFrozen(predicateState.projects[0].logisticsEpisodes));
  assert.ok(Object.isFrozen(predicateState.projects[1].terminalInquiryOpportunityBasis));
  for (const project of predicateState.projects.slice(3)) assert.equal(Object.isFrozen(project), false);
  assert.throws(() => {
    predicateState.projects[0].summary = 'illegal post-completion mutation';
  }, TypeError, 'future writes to a stabilized completed archive must fail loudly');

  // A real 12-month rule advance proves that the three closed terminal forms
  // have no legitimate writer and that freezing changes no decisions/events.
  const frozenController = simulation.createSimulation({
    seed: 91_002,
    config: { endpoint: { kind: 'months', value: 12_000 }, chaosIntensity: 0 },
  });
  const controlController = simulation.createSimulation({
    seed: 91_002,
    config: { endpoint: { kind: 'months', value: 12_000 }, chaosIntensity: 0 },
  });
  const ruleOwnerId = frozenController.ownedState().people[0].id;
  const ruleProjects = Array.from(
    { length: 30 },
    (_, index) => closedTerminalProject(`rule-${index}`, ruleOwnerId, index),
  );
  frozenController.ownedState().projects.push(...structuredClone(ruleProjects));
  controlController.ownedState().projects.push(...structuredClone(ruleProjects));
  assert.equal(
    codec.stabilizeCompletedProjectsForRunStateShellReuse(frozenController.ownedState()),
    30,
  );
  frozenController.stepOwned(12);
  controlController.stepOwned(12);
  assert.deepEqual(
    frozenController.ownedState(),
    controlController.ownedState(),
    'freezing after completion must preserve 12 months of decisions/events/state',
  );

  // Exercise the real bounded warm-successor path. The hot-history shell copy
  // must not strand stabilization on a temporary object; month two has to see
  // the exact project identities published by month one.
  const storeDirectory = path.join(temporaryDirectory, 'store-data');
  const storeController = simulation.createSimulation({
    seed: 91_003,
    config: { endpoint: { kind: 'months', value: 12_000 }, chaosIntensity: 0 },
  });
  storeController.stepOwned(1);
  const storeState = storeController.ownedState();
  const storeOwnerId = storeState.people[0].id;
  storeState.projects.push(...Array.from(
    { length: 30 },
    (_, index) => closedTerminalProject(`store-${index}`, storeOwnerId, index),
  ));
  let store = new api.SqliteRunStore(storeDirectory);
  await store.create({ id: 'shell-reuse-store-probe', state: storeState });
  await store.bootstrapBoundedEvolutionContinuation('shell-reuse-store-probe', 2_048);
  store.close();
  store = new api.SqliteRunStore(storeDirectory);
  const publicOpened = await store.openBoundedEvolutionContinuation('shell-reuse-store-probe');
  const publicProject = publicOpened.state.projects.find((project) => (
    project.id === 'completed-project-store-0'
  ));
  assert.ok(publicProject && !Object.isFrozen(publicProject));
  const publicProjectArray = publicOpened.state.projects;
  const publicStepped = api.stepOwnedBoundedNonProjectionMonth(publicOpened.state);
  const publicStage = await store.stageBoundedEvolutionSuccessor(
    publicOpened.continuationToken,
    publicStepped,
  );
  assert.ok(store.ownsBoundedEvolutionSuccessorStagingReceipt(publicStage));
  assert.equal(publicStepped.projects, publicProjectArray, 'public staging must not replace projects');
  assert.equal(
    publicStepped.projects.find((project) => project.id === publicProject.id),
    publicProject,
    'public staging must not replace closed terminal project objects',
  );
  assert.equal(Object.isFrozen(publicProject), false, 'public staging must not freeze caller state');
  store.close();
  store = new api.SqliteRunStore(storeDirectory);
  codec.configureRunStateShellPartEncodeCacheForTests({
    enabled: false,
    clear: true,
    resetStatistics: true,
  });
  codec.configureRunStateShellSegmentIdentityReuseForTests({
    enabled: true,
    resetStatistics: true,
  });
  const firstStage = await store.stageBoundedNonProjectionMonth('shell-reuse-store-probe');
  await store.publishBoundedNonProjectionMonth(firstStage);
  const firstStoreMonth = codec.runStateShellPartEncodeCacheStatsForTests();
  codec.configureRunStateShellSegmentIdentityReuseForTests({ resetStatistics: true });
  const secondStage = await store.stageBoundedNonProjectionMonth('shell-reuse-store-probe');
  await store.publishBoundedNonProjectionMonth(secondStage);
  const secondStoreMonth = codec.runStateShellPartEncodeCacheStatsForTests();
  assert.equal(firstStoreMonth.identityReuseHits, 0, 'cold store month must encode once');
  assert.ok(
    secondStoreMonth.identityReuseHits >= 30,
    'warm store month must retain exact frozen project identities across publication',
  );
  store.close();

  async function twelveLowChangeMonths(projectCount) {
    const state = simulation.createInitialState(92_000 + projectCount, {
      endpoint: { kind: 'months', value: 12_000 },
    });
    state.world.past = [];
    delete state.world.historyCursor;
    const projectOwnerId = state.people[0].id;
    state.projects = Array.from(
      { length: projectCount },
      (_, index) => closedTerminalProject(`${projectCount}-${index}`, projectOwnerId, index),
    );
    const enabledAuthority = Object.freeze({ variant: `enabled-${projectCount}` });
    const disabledAuthority = Object.freeze({ variant: `disabled-${projectCount}` });
    codec.configureRunStateShellPartEncodeCacheForTests({
      enabled: false,
      clear: true,
      resetStatistics: true,
    });
    const enabledCold = await codec.encodeSegmentedRunStateFromHistorySuffix(
      state,
      fixedHistory,
      [],
      { shellReuse: { authority: enabledAuthority } },
    );
    const coldStats = codec.runStateShellPartEncodeCacheStatsForTests();
    const disabledCold = await codec.encodeSegmentedRunStateFromHistorySuffix(
      state,
      fixedHistory,
      [],
      { shellReuse: { authority: disabledAuthority } },
    );
    assert.equal(enabledCold.root.hash, disabledCold.root.hash);
    assert.equal(enabledCold.metadata.shellHash, disabledCold.metadata.shellHash);
    assert.equal(enabledCold.shellReuseIdentity.reusableCompletedProjectSegments, projectCount);

    const chunks = new Map();
    addChunks(chunks, enabledCold);
    let enabledPrevious = enabledCold;
    let disabledPrevious = disabledCold;
    const enabled = {};
    const disabled = {};
    for (let month = 1; month <= 12; month += 1) {
      state.clock.elapsedMonths = month;
      codec.configureRunStateShellSegmentIdentityReuseForTests({
        enabled: true,
        resetStatistics: true,
      });
      const nextEnabled = await codec.encodeSegmentedRunStateFromHistorySuffix(
        state,
        fixedHistory,
        [],
        {
          shellReuse: {
            authority: enabledAuthority,
            previousRoot: enabledPrevious.root,
            previousIdentity: enabledPrevious.shellReuseIdentity,
          },
        },
      );
      sumStats(enabled, codec.runStateShellPartEncodeCacheStatsForTests());
      addChunks(chunks, nextEnabled);

      codec.configureRunStateShellSegmentIdentityReuseForTests({
        enabled: false,
        resetStatistics: true,
      });
      const nextDisabled = await codec.encodeSegmentedRunStateFromHistorySuffix(
        state,
        fixedHistory,
        [],
        {
          shellReuse: {
            authority: disabledAuthority,
            previousRoot: disabledPrevious.root,
            previousIdentity: disabledPrevious.shellReuseIdentity,
          },
        },
      );
      sumStats(disabled, codec.runStateShellPartEncodeCacheStatsForTests());
      assert.equal(nextEnabled.root.hash, nextDisabled.root.hash, `month ${month} root hash`);
      assert.equal(
        nextEnabled.metadata.shellHash,
        nextDisabled.metadata.shellHash,
        `month ${month} shell hash`,
      );
      assert.equal(nextEnabled.metadata.historyHeadHash, nextDisabled.metadata.historyHeadHash);
      enabledPrevious = nextEnabled;
      disabledPrevious = nextDisabled;
    }
    assert.equal(enabled.identityReuseHits, projectCount * 12);
    assert.equal(enabled.identityReuseMisses, 0);
    assert.equal(disabled.identityReuseMisses, projectCount * 12);
    assert.equal(disabled.serializeCalls - enabled.serializeCalls, projectCount * 12);
    assert.equal(disabled.brotliCalls - enabled.brotliCalls, projectCount * 12);
    assert.ok(disabled.serializedRawBytes > enabled.serializedRawBytes);

    const decoded = await codec.decodeSegmentedRunState(
      enabledPrevious.root,
      (hash) => {
        const chunk = chunks.get(hash);
        if (!chunk) throw new Error(`missing accumulated chunk ${hash}`);
        return chunk;
      },
    );
    assert.deepEqual(decoded.state, state, 'cold decode from reused segments must restore exact state');
    assert.equal(Object.isFrozen(decoded.state.projects[0]), false, 'storage freeze is process-local');
    await assert.rejects(codec.encodeSegmentedRunStateFromHistorySuffix(
      state,
      fixedHistory,
      [],
      {
        shellReuse: {
          authority: Object.freeze({ wrong: true }),
          previousRoot: enabledPrevious.root,
          previousIdentity: enabledPrevious.shellReuseIdentity,
        },
      },
    ), /run\/exact previous root\/manifest/u);
    return { projectCount, cold: coldStats, enabled, disabled };
  }

  async function terminalIdentityGuardProbe() {
    const state = simulation.createInitialState(92_901, {
      endpoint: { kind: 'months', value: 12_000 },
    });
    state.world.past = [];
    delete state.world.historyCursor;
    const projectOwnerId = state.people[0].id;
    state.projects = [
      completedProject('guard-completed', projectOwnerId),
      blockedProject('guard-blocked', projectOwnerId),
      abandonedProject('guard-abandoned', projectOwnerId),
      { ...completedProject('guard-active', projectOwnerId), status: 'active' },
      {
        ...completedProject('guard-continuable-blocked', projectOwnerId),
        status: 'blocked',
        searchCampaigns: [{ status: 'exhausted' }],
      },
      blockedProject('guard-blocked-active', projectOwnerId, {
        logisticsEpisodes: [{ status: 'active' }],
      }),
      abandonedProject('guard-abandoned-active', projectOwnerId, {
        hypothesisCampaign: { status: 'active' },
      }),
      { ...completedProject('guard-proposed', projectOwnerId), status: 'proposed' },
    ];
    const authority = Object.freeze({ variant: 'terminal-identity-guards' });
    codec.configureRunStateShellPartEncodeCacheForTests({
      enabled: false,
      clear: true,
      resetStatistics: true,
    });
    codec.configureRunStateShellSegmentIdentityReuseForTests({
      enabled: true,
      resetStatistics: true,
    });
    const cold = await codec.encodeSegmentedRunStateFromHistorySuffix(
      state,
      fixedHistory,
      [],
      { shellReuse: { authority } },
    );
    assert.equal(
      cold.shellReuseIdentity.reusableCompletedProjectSegments,
      3,
      'only completed, closed blocked, and closed abandoned are reusable',
    );

    state.projects[0] = {
      ...structuredClone(state.projects[0]),
      summary: 'changed completed project object',
    };
    state.projects[1] = {
      ...structuredClone(state.projects[1]),
      searchCampaigns: [{ status: 'active' }],
    };
    state.clock.elapsedMonths = 1;
    codec.configureRunStateShellSegmentIdentityReuseForTests({
      enabled: true,
      resetStatistics: true,
    });
    const enabled = await codec.encodeSegmentedRunStateFromHistorySuffix(
      state,
      fixedHistory,
      [],
      {
        shellReuse: {
          authority,
          previousRoot: cold.root,
          previousIdentity: cold.shellReuseIdentity,
        },
      },
    );
    const enabledStats = codec.runStateShellPartEncodeCacheStatsForTests();
    assert.equal(enabledStats.identityReuseHits, 1, 'unchanged frozen abandoned project must hit');
    assert.equal(enabledStats.identityReuseMisses, 1, 'replaced completed object must miss by identity');
    assert.equal(
      enabled.shellReuseIdentity.reusableCompletedProjectSegments,
      2,
      'blocked project with newly active internal work must not be captured',
    );

    codec.configureRunStateShellSegmentIdentityReuseForTests({
      enabled: false,
      resetStatistics: true,
    });
    const disabled = await codec.encodeSegmentedRunStateFromHistorySuffix(
      state,
      fixedHistory,
      [],
      {
        shellReuse: {
          authority,
          previousRoot: cold.root,
          previousIdentity: cold.shellReuseIdentity,
        },
      },
    );
    const disabledStats = codec.runStateShellPartEncodeCacheStatsForTests();
    assert.equal(enabled.root.hash, disabled.root.hash, 'identity reuse must not change root hash');
    assert.equal(
      enabled.metadata.shellHash,
      disabled.metadata.shellHash,
      'identity reuse must not change shell manifest hash',
    );
    assert.equal(
      disabledStats.serializeCalls - enabledStats.serializeCalls,
      1,
      'only the unchanged frozen terminal project may skip serialization',
    );
    await assert.rejects(codec.encodeSegmentedRunStateFromHistorySuffix(
      state,
      fixedHistory,
      [],
      {
        shellReuse: {
          authority,
          previousRoot: cold.root,
          previousIdentity: enabled.shellReuseIdentity,
        },
      },
    ), /run\/exact previous root\/manifest/u, 'wrong previous root must be rejected');
    await assert.rejects(codec.encodeSegmentedRunStateFromHistorySuffix(
      state,
      fixedHistory,
      [],
      {
        shellReuse: {
          authority: Object.freeze({ wrong: true }),
          previousRoot: enabled.root,
          previousIdentity: enabled.shellReuseIdentity,
        },
      },
    ), /run\/exact previous root\/manifest/u, 'wrong authority must be rejected');
    return { enabled: enabledStats, disabled: disabledStats };
  }

  const scale30 = await twelveLowChangeMonths(30);
  const scale300 = await twelveLowChangeMonths(300);
  const terminalGuards = await terminalIdentityGuardProbe();
  assert.equal(
    scale300.disabled.serializeCalls - scale300.enabled.serializeCalls,
    10 * (scale30.disabled.serializeCalls - scale30.enabled.serializeCalls),
    'saved work must scale only with unchanged project count',
  );

  console.log(JSON.stringify({
    result: 'passed',
    realRuleMonths: 12,
    ruleProjectCount: 30,
    boundedStoreWarmIdentityHits: secondStoreMonth.identityReuseHits,
    scales: [scale30, scale300],
    terminalGuards,
    threeThousandProjection: {
      projectSegments: 3_000,
      months: 12,
      avoidedSerializeHashBrotliCalls: 36_000,
      basis: 'exact per-project identity hit count proven linearly at 30 and 300',
    },
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
