import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-social-learning-persistence-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'bundle.mjs');
const projectionPath = path.resolve('server/history-retention-projection.ts');
const codecPath = path.resolve('server/history-retention-codec.ts');
const eventIndexPath = path.resolve('src/game/eland/domain/event-index.ts');
const hydrationPath = path.resolve(
  'src/game/eland/application/simulation/social-learning-state.ts',
);

function authority(index) {
  return { stateHash: index.toString(16).padStart(64, '0') };
}

function environment(id, atMonth, orderInMonth = 0) {
  return {
    id, kind: 'environment', atMonth, orderInMonth, planningTick: 1, orderInTick: 0,
    cellId: 0, change: 'condition', result: id, diff: {},
  };
}

function dimension(lastUpdatedAtMonth = 2) {
  return {
    alpha: 3, beta: 1, positiveObservations: 2, negativeObservations: 0,
    lastUpdatedAtMonth,
  };
}

function socialLearning(observerId = 'observer', targetId = 'target', sourceIds = ['social-1', 'social-2']) {
  const [first = 'social-1', second = first] = sourceIds;
  const context = 'exchange';
  return {
    version: 'social-learning-v1', startedAtMonth: 1,
    beliefs: [{
      version: 'social-cooperation-belief-v1',
      basisKey: `social-learning-v1|target=${encodeURIComponent(targetId)}|context=${context}`,
      targetPersonId: targetId, context,
      response: dimension(), willingness: dimension(), reliability: dimension(),
      receipts: [{
        version: 'social-learning-receipt-v1', id: 'receipt-1', kind: 'agreement-fulfillment',
        atMonth: 1, reliability: 'positive', sourceEventIds: [first],
      }, {
        version: 'social-learning-receipt-v1', id: 'receipt-2', kind: 'agreement-fulfillment',
        atMonth: 2, reliability: 'positive', sourceEventIds: [second],
      }],
      sourceEventIds: [...new Set(sourceIds)], lastUpdatedAtMonth: 2,
    }],
    coordinationPractices: [{
      version: 'coordination-practice-basis-v1',
      basisKey: `coordination-practice-v1|observer=${encodeURIComponent(observerId)}`
        + `|target=${encodeURIComponent(targetId)}|context=${context}`,
      observerId, targetPersonId: targetId, participantIds: [observerId, targetId], context,
      formedAtMonth: 2, lastUpdatedAtMonth: 2, support: 'supported',
      successes: [{ atMonth: 1, receiptIds: ['receipt-1'], sourceEventIds: [first] }, {
        atMonth: 2, receiptIds: ['receipt-2'], sourceEventIds: [second],
      }],
      recentCounterEvidence: [], sourceFactIds: [...new Set(sourceIds)],
    }],
  };
}

function maximalBoundedSocialLearning(observerId, namespace) {
  let sourceOrdinal = 0;
  const sources = (count) => Array.from(
    { length: count },
    () => `total-social-${namespace}-${sourceOrdinal++}`,
  );
  const contexts = [
    'assist-water', 'assist-food', 'assist-shelter', 'assist-company', 'exchange',
    'shared-living', 'collective-formation', 'collective-membership',
  ];
  const beliefs = Array.from({ length: 24 }, (_, beliefIndex) => {
    const targetPersonId = `total-target-${namespace}-${beliefIndex}`;
    const context = contexts[beliefIndex % contexts.length];
    return {
      version: 'social-cooperation-belief-v1',
      basisKey: `social-learning-v1|target=${encodeURIComponent(targetPersonId)}|context=${context}`,
      targetPersonId, context,
      response: dimension(), willingness: dimension(), reliability: dimension(),
      receipts: Array.from({ length: 8 }, (_, receiptIndex) => ({
        version: 'social-learning-receipt-v1',
        id: `total-receipt-${namespace}-${beliefIndex}-${receiptIndex}`,
        kind: 'agreement-fulfillment', atMonth: 2, reliability: 'positive',
        sourceEventIds: sources(24),
      })),
      sourceEventIds: sources(24), lastUpdatedAtMonth: 2,
    };
  });
  const coordinationPractices = Array.from({ length: 8 }, (_, practiceIndex) => {
    const targetPersonId = beliefs[practiceIndex].targetPersonId;
    const context = beliefs[practiceIndex].context;
    return {
      version: 'coordination-practice-basis-v1',
      basisKey: `coordination-practice-v1|observer=${encodeURIComponent(observerId)}`
        + `|target=${encodeURIComponent(targetPersonId)}|context=${context}`,
      observerId, targetPersonId, participantIds: [observerId, targetPersonId], context,
      formedAtMonth: 2, lastUpdatedAtMonth: 2, support: 'supported',
      successes: Array.from({ length: 8 }, (_, episodeIndex) => ({
        atMonth: episodeIndex + 1,
        receiptIds: [`total-practice-receipt-${namespace}-${practiceIndex}-${episodeIndex}`],
        sourceEventIds: sources(24),
      })),
      recentCounterEvidence: Array.from({ length: 8 }, (_, episodeIndex) => ({
        atMonth: episodeIndex + 1,
        receiptId: `total-counter-${namespace}-${practiceIndex}-${episodeIndex}`,
        sourceEventIds: sources(24),
      })),
      sourceFactIds: sources(24),
    };
  });
  assert.equal(sourceOrdinal, 8_448);
  return {
    version: 'social-learning-v1', startedAtMonth: 1, beliefs, coordinationPractices,
  };
}

function person(id, options = {}) {
  return {
    id, name: id, bornAtMonth: 0, ...(options.dead ? { diedAtMonth: 3 } : {}),
    body: { health: options.dead ? 0 : 80, hydration: 80, nutrition: 80 },
    knowledge: [], inventory: [], conditions: [], relations: [], memories: [],
    bereavements: [], maternalTeachingSourceEventIds: [], position: { cellId: 0, z: 1 },
    cognition: {
      version: 'causal-bdi-v1', outcomeBeliefs: [], goalOutcomeBeliefs: [],
      needResolutionEpisodes: [], ...(options.socialLearning ? { socialLearning: options.socialLearning } : {}),
    },
  };
}

function shell({ ledger, people, elapsedMonths = 4, hotEventCount = 2 }) {
  const hotStartIndex = Math.max(0, ledger.length - hotEventCount);
  return {
    clock: { elapsedMonths }, people, projects: [], eraPredictions: [], agreements: [], intents: [],
    world: {
      past: ledger.slice(hotStartIndex),
      historyCursor: {
        version: 1, eventCount: ledger.length, hotStartIndex,
        tailEventId: ledger.at(-1)?.id ?? null,
      },
      mechanicalPower: { version: 'mechanical-power-world-v1', sources: [], networks: [] },
    },
  };
}

function projectAll(api, candidateShell, ledger, candidateAuthority) {
  const fold = api.beginHistoryRetentionProjection(candidateShell, candidateAuthority);
  api.foldHistoryRetentionSegment(fold, ledger, 0);
  return api.finishHistoryRetentionProjection(fold);
}

function socialGroup(api, projection, observerId = 'observer') {
  const key = api.socialLearningSourceLeaseKey(observerId);
  return projection.demandGroups.find((group) => group.groupKey === key);
}

try {
  writeFileSync(entryPath, [
    `export * from ${JSON.stringify(projectionPath)};`,
    `export * from ${JSON.stringify(codecPath)};`,
    `export * from ${JSON.stringify(hydrationPath)};`,
    `export { registerRetainedColdWorldEventFacts, worldEventById } from ${JSON.stringify(eventIndexPath)};`,
  ].join('\n'));
  await build({
    entryPoints: [entryPath], outfile: bundlePath, bundle: true, platform: 'node', format: 'esm',
    plugins: [{
      name: 'expose-retention-basis-hash',
      setup(buildApi) {
        buildApi.onLoad({ filter: /history-retention-projection\.ts$/ }, (args) => {
          if (path.resolve(args.path) !== projectionPath) return null;
          return {
            contents: `${readFileSync(args.path, 'utf8')}\nexport { historyRetentionContinuationBasisHash as __testHistoryRetentionContinuationBasisHash };\n`,
            loader: 'ts', resolveDir: path.dirname(args.path),
          };
        });
      },
    }],
  });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  const observer = person('observer');
  const target = person('target');
  assert.equal(
    api.cloneValidatedSocialLearningState(observer, [observer, target], 4),
    undefined,
    'legacy missing socialLearning must remain an empty prior without history backfill',
  );

  const originalSocialLearning = socialLearning();
  observer.cognition.socialLearning = originalSocialLearning;
  const copied = api.cloneValidatedSocialLearningState(observer, [observer, target], 4);
  assert.ok(copied);
  assert.notEqual(copied, originalSocialLearning);
  assert.notEqual(copied.beliefs[0], originalSocialLearning.beliefs[0]);
  assert.notEqual(copied.beliefs[0].response, originalSocialLearning.beliefs[0].response);
  assert.notEqual(copied.beliefs[0].receipts, originalSocialLearning.beliefs[0].receipts);
  assert.notEqual(copied.coordinationPractices[0].successes, originalSocialLearning.coordinationPractices[0].successes);
  copied.beliefs[0].response.alpha = 99;
  copied.beliefs[0].receipts[0].sourceEventIds.push('copy-only');
  copied.coordinationPractices[0].successes[0].sourceEventIds.push('copy-practice-only');
  assert.equal(originalSocialLearning.beliefs[0].response.alpha, 3);
  assert.deepEqual(originalSocialLearning.beliefs[0].receipts[0].sourceEventIds, ['social-1']);
  assert.deepEqual(originalSocialLearning.coordinationPractices[0].successes[0].sourceEventIds, ['social-1']);

  const tooManyBeliefs = structuredClone(originalSocialLearning);
  tooManyBeliefs.beliefs = Array.from({ length: 25 }, (_, index) => ({
    ...structuredClone(originalSocialLearning.beliefs[0]),
    basisKey: `social-learning-v1|target=target-${index}|context=exchange`,
    targetPersonId: `target-${index}`,
  }));
  const oversizedObserver = person('observer', { socialLearning: tooManyBeliefs });
  const oversizedPeople = [
    oversizedObserver,
    ...Array.from({ length: 25 }, (_, index) => person(`target-${index}`)),
  ];
  assert.throws(
    () => api.cloneValidatedSocialLearningState(oversizedObserver, oversizedPeople, 4),
    /beliefs 超出上限 24/u,
    'hydration must reject rather than truncate oversized social beliefs',
  );

  const sourceEvents = [environment('social-1', 1), environment('social-2', 2)];
  const noise = Array.from({ length: 32 }, (_, index) => environment(`noise-${index}`, 3, index));
  const ledger = [...sourceEvents, ...noise, environment('tail', 4)];
  const retainedObserver = person('observer', { socialLearning: originalSocialLearning });
  const retainedTarget = person('target');
  const boundedShell = shell({ ledger, people: [retainedObserver, retainedTarget] });
  const projection = projectAll(api, boundedShell, ledger, authority(1));
  const group = socialGroup(api, projection);
  assert.equal(group?.requirement, 'all');
  assert.deepEqual(group?.eventIds, ['social-1', 'social-2']);
  assert.deepEqual(group?.leaseKeys, [api.socialLearningSourceLeaseKey('observer')]);
  const coldPins = projection.pins.filter((pin) => (
    pin.absoluteIndex < boundedShell.world.historyCursor.hotStartIndex
  ));
  api.registerRetainedColdWorldEventFacts(
    boundedShell,
    coldPins.map((pin) => ({
      absoluteIndex: pin.absoluteIndex, eventId: pin.eventId,
      event: ledger[pin.absoluteIndex], leaseKeys: pin.leaseKeys,
    })),
  );
  assert.equal(api.worldEventById(boundedShell, 'social-1')?.id, 'social-1');
  assert.equal(api.worldEventById(boundedShell, 'social-2')?.id, 'social-2');

  const encoded = api.encodeHistoryRetentionSidecar(projection);
  const decoded = api.decodeHistoryRetentionSidecar(encoded.chunk, {
    reference: encoded.reference,
    boundary: { authority: projection.authority, target: projection.target },
  });
  assert.deepEqual(socialGroup(api, decoded)?.eventIds, ['social-1', 'social-2']);

  const noSocialShell = shell({
    ledger, people: [person('observer'), person('target')],
  });
  const noSocialProjection = projectAll(api, noSocialShell, ledger, authority(2));
  assert.equal(
    projection.demandFingerprint,
    noSocialProjection.demandFingerprint,
    'storage-only social-learning leases must not change the compatibility fingerprint',
  );
  assert.equal(socialGroup(api, noSocialProjection), undefined);
  assert.equal(noSocialProjection.pins.some((pin) => pin.eventId === 'social-1'), false);
  assert.equal(api.worldEventById(noSocialShell, 'social-1'), undefined);

  const deadShell = shell({
    ledger,
    people: [person('observer', { dead: true, socialLearning: originalSocialLearning }), person('target')],
  });
  const deadProjection = projectAll(api, deadShell, ledger, authority(3));
  assert.equal(socialGroup(api, deadProjection), undefined, 'dead observers must release social-learning leases');

  const baseLedger = [environment('base-0', 0), environment('base-tail', 0, 1)];
  const baseShell = shell({ ledger: baseLedger, people: [person('observer'), person('target')], elapsedMonths: 0 });
  const baseProjection = projectAll(api, baseShell, baseLedger, authority(4));
  const suffixEvent = environment('suffix-social', 1);
  const suffixLedger = [...baseLedger, suffixEvent];
  const suffixSocialLearning = socialLearning('observer', 'target', ['suffix-social', 'suffix-social']);
  suffixSocialLearning.startedAtMonth = 1;
  suffixSocialLearning.beliefs[0].receipts[0].atMonth = 1;
  suffixSocialLearning.beliefs[0].receipts[1].atMonth = 1;
  suffixSocialLearning.beliefs[0].lastUpdatedAtMonth = 1;
  suffixSocialLearning.beliefs[0].response.lastUpdatedAtMonth = 1;
  suffixSocialLearning.beliefs[0].willingness.lastUpdatedAtMonth = 1;
  suffixSocialLearning.beliefs[0].reliability.lastUpdatedAtMonth = 1;
  suffixSocialLearning.coordinationPractices = [];
  const suffixShell = shell({
    ledger: suffixLedger,
    elapsedMonths: 1,
    people: [person('observer', { socialLearning: suffixSocialLearning }), person('target')],
  });
  const suffixFold = api.resumeHistoryRetentionProjection(baseProjection, suffixShell, authority(5));
  api.foldHistoryRetentionSegment(suffixFold, [suffixEvent], baseLedger.length);
  const suffixProjection = api.finishHistoryRetentionProjection(suffixFold);
  assert.deepEqual(socialGroup(api, suffixProjection)?.eventIds, ['suffix-social']);

  const legacy = structuredClone(decoded);
  const groupKey = api.socialLearningSourceLeaseKey('observer');
  legacy.demandGroups = legacy.demandGroups.filter((candidate) => candidate.groupKey !== groupKey);
  legacy.unresolvedDemands = legacy.unresolvedDemands.filter((candidate) => candidate.groupKey !== groupKey);
  legacy.pins = legacy.pins.flatMap((pin) => {
    const leaseKeys = pin.leaseKeys.filter((leaseKey) => leaseKey !== groupKey);
    return leaseKeys.length > 0 ? [{ ...pin, leaseKeys }] : [];
  });
  legacy.continuationBasis.sourceDemand.groups = legacy.continuationBasis.sourceDemand.groups
    .filter((candidate) => candidate.groupKey !== groupKey);
  legacy.continuationBasis.directMatches = legacy.continuationBasis.directMatches
    .filter((match) => match.eventId !== 'social-1' && match.eventId !== 'social-2');
  const { basisHash: _basisHash, ...basisWithoutHash } = legacy.continuationBasis;
  legacy.continuationBasis.basisHash = api.__testHistoryRetentionContinuationBasisHash(basisWithoutHash);
  const migrationFold = api.resumeHistoryRetentionProjection(
    legacy,
    shell({ ledger, people: [retainedObserver, retainedTarget] }),
    authority(6),
  );
  assert.deepEqual(
    api.unresolvedVerifiedPrefixSocialLearningSourceEventIds(migrationFold),
    ['social-1', 'social-2'],
  );
  api.seedVerifiedPrefixSocialLearningSourceMatches(
    migrationFold,
    legacy.target.eventCount,
    [{ absoluteIndex: 0, eventId: 'social-1' }, { absoluteIndex: 1, eventId: 'social-2' }],
  );
  assert.deepEqual(socialGroup(api, api.finishHistoryRetentionProjection(migrationFold))?.eventIds, [
    'social-1', 'social-2',
  ]);

  const oversizedSourceIds = Array.from(
    { length: api.HISTORY_RETENTION_MAX_SOCIAL_LEARNING_EVENT_IDS_PER_PERSON + 1 },
    (_, index) => `oversized-social-${index}`,
  );
  const rawOversizedSocial = socialLearning('observer', 'target', ['placeholder', 'placeholder']);
  rawOversizedSocial.beliefs[0].sourceEventIds = oversizedSourceIds;
  assert.throws(
    () => api.beginHistoryRetentionProjection(
      shell({
        ledger: [environment('oversized-tail', 4)],
        people: [person('observer', { socialLearning: rawOversizedSocial }), person('target')],
      }),
      authority(7),
    ),
    /social learning belief sources 无效或超界/u,
    'nested person-local source bounds must reject rather than truncate',
  );

  const totalPeople = [];
  for (let personIndex = 0; personIndex < 4; personIndex += 1) {
    const observerId = `total-observer-${personIndex}`;
    const totalSocial = maximalBoundedSocialLearning(observerId, personIndex);
    totalPeople.push(person(observerId, { socialLearning: totalSocial }));
    for (const belief of totalSocial.beliefs) totalPeople.push(person(belief.targetPersonId));
  }
  assert.throws(
    () => api.beginHistoryRetentionProjection(
      shell({ ledger: [environment('total-tail', 4)], people: totalPeople }),
      authority(8),
    ),
    /social learning source memberships 超出有界总上限/u,
    'total source membership bound must reject rather than truncate',
  );

  const memoryUsage = process.memoryUsage();
  console.log(JSON.stringify({
    result: 'passed',
    coldSourceAbsoluteIndexes: [0, 1],
    hotStartIndex: boundedShell.world.historyCursor.hotStartIndex,
    suffixLeaseEventIds: socialGroup(api, suffixProjection)?.eventIds ?? [],
    rssBytes: memoryUsage.rss,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
