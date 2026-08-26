import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-terminal-failure-retention-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'bundle.mjs');
const projectionPath = path.resolve('server/history-retention-projection.ts');
const codecPath = path.resolve('server/history-retention-codec.ts');
const eventIndexPath = path.resolve('src/game/eland/domain/event-index.ts');

function authority(index) {
  return { stateHash: index.toString(16).padStart(64, '0') };
}

function environment(id, atMonth, orderInMonth = 0) {
  return {
    id, kind: 'environment', atMonth, orderInMonth, planningTick: 1, orderInTick: 0,
    cellId: 0, change: 'condition', result: id, diff: {},
  };
}

function failedAction(id, atMonth, intentId, ownerId = 'owner') {
  return {
    id, kind: 'action', atMonth, orderInMonth: 0, planningTick: 1, orderInTick: 0,
    cellId: 0, actionTick: 1, who: ownerId, intentId, cause: 'intent', status: 'failed',
    result: 'fixture failure', action: { kind: 'act', operation: 'exert', targets: [] },
    diff: {}, fromCellId: 0, toCellId: 0, fromZ: 1, toZ: 1, pathSegment: [],
  };
}

function person(id = 'owner') {
  return {
    id, name: id, body: { health: 80, hydration: 80, nutrition: 80 },
    knowledge: [], inventory: [], conditions: [], relations: [], memories: [],
    bereavements: [], maternalTeachingSourceEventIds: [], position: { cellId: 0, z: 1 },
  };
}

function terminalIntent({
  id = 'intent-failed', ownerId = 'owner', failureEventId = 'failure-action', resolvedAtMonth = 10,
  actionEventIds = [failureEventId, 'action-only'],
  outcomeSourceEventIds = [failureEventId, 'outcome-only'],
} = {}) {
  return {
    id, ownerId, summary: id, domain: 'strategic', status: 'failed', createdAtMonth: 10,
    lastProgressAtMonth: 10, progress: 0, replanCount: 0,
    sourceDecisionEventId: `decision:${id}`, sourceFactIds: [`source:${id}`], actionEventIds,
    goal: { kind: 'condition', personId: ownerId, condition: 'sheltered', present: true },
    nextAction: { kind: 'act', operation: 'exert', targets: [] },
    goalOutcome: {
      version: 'intent-goal-outcome-v1', kind: 'attempted-unmet', basisKey: `basis:${id}`,
      resolvedAtMonth, sourceEventIds: outcomeSourceEventIds,
    },
  };
}

function shell({ ledger, elapsedMonths, intents = [], people = [person()], hotEventCount = 2 }) {
  const hotStartIndex = Math.max(0, ledger.length - hotEventCount);
  return {
    clock: { elapsedMonths }, people, projects: [], eraPredictions: [], agreements: [], intents,
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

function failureGroup(api, projection, ownerId = 'owner') {
  const groupKey = api.recentTerminalFailureActionLeaseKey(ownerId);
  return projection.demandGroups.find((group) => group.groupKey === groupKey);
}

function assertColdFailureResolves(api, projection, boundedShell, ledger, failureEventId) {
  const hotStartIndex = boundedShell.world.historyCursor.hotStartIndex;
  api.registerRetainedColdWorldEventFacts(
    boundedShell,
    projection.pins.filter((pin) => pin.absoluteIndex < hotStartIndex).map((pin) => ({
      absoluteIndex: pin.absoluteIndex,
      eventId: pin.eventId,
      event: ledger[pin.absoluteIndex],
      leaseKeys: pin.leaseKeys,
    })),
  );
  assert.equal(
    api.worldEventById(boundedShell, failureEventId)?.id,
    failureEventId,
    '专属 exact lease 必须让已推出 hot window 的 failure ActionFact 可解析',
  );
}

try {
  writeFileSync(entryPath, [
    `export * from ${JSON.stringify(projectionPath)};`,
    `export * from ${JSON.stringify(codecPath)};`,
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

  const failure = failedAction('failure-action', 10, 'intent-failed');
  const ledger = [
    failure,
    ...Array.from({ length: 32 }, (_, index) => environment(`noise-${index}`, 10, index + 1)),
  ];
  const intent = terminalIntent();
  let currentShell = shell({ ledger, elapsedMonths: 10, intents: [intent] });
  let projection = projectAll(api, currentShell, ledger, authority(1));
  const groupKey = api.recentTerminalFailureActionLeaseKey('owner');

  assert.deepEqual(
    failureGroup(api, projection)?.eventIds,
    ['failure-action'],
    'lease 只能包含 actionEventIds 与 goalOutcome.sourceEventIds 的精确交集',
  );
  assert.equal(failureGroup(api, projection)?.requirement, 'all');
  assert.deepEqual(failureGroup(api, projection)?.leaseKeys, [groupKey]);
  assertColdFailureResolves(api, projection, currentShell, ledger, failure.id);

  const encoded = api.encodeHistoryRetentionSidecar(projection);
  const decoded = api.decodeHistoryRetentionSidecar(encoded.chunk, {
    reference: encoded.reference,
    boundary: { authority: projection.authority, target: projection.target },
  });
  assert.deepEqual(failureGroup(api, decoded)?.eventIds, ['failure-action']);

  for (let age = 1; age <= 6; age += 1) {
    currentShell = shell({ ledger, elapsedMonths: 10 + age, intents: [intent] });
    const fold = api.resumeHistoryRetentionProjection(
      projection,
      currentShell,
      authority(age + 1),
    );
    projection = api.finishHistoryRetentionProjection(fold);
    assert.deepEqual(failureGroup(api, projection)?.eventIds, ['failure-action']);
    assertColdFailureResolves(api, projection, currentShell, ledger, failure.id);
  }

  const sameMonthWithoutFailureLease = projectAll(
    api,
    shell({ ledger, elapsedMonths: 16, intents: [] }),
    ledger,
    authority(20),
  );
  assert.equal(
    projection.demandFingerprint,
    sameMonthWithoutFailureLease.demandFingerprint,
    'storage-only failure lease 不得漂移兼容 fingerprint',
  );

  const monthSevenShell = shell({ ledger, elapsedMonths: 17, intents: [intent] });
  const monthSevenFold = api.resumeHistoryRetentionProjection(
    projection,
    monthSevenShell,
    authority(21),
  );
  const monthSeven = api.finishHistoryRetentionProjection(monthSevenFold);
  assert.equal(failureGroup(api, monthSeven), undefined, 'resolvedAtMonth + 7 必须释放 lease');
  assert.equal(
    monthSeven.pins.some((pin) => pin.eventId === failure.id),
    false,
    'month 7 不得继续 pin failure ActionFact',
  );
  assert.equal(
    api.worldEventById(monthSevenShell, failure.id),
    undefined,
    'lease 释放且事实已冷出 hot window 后不得凭空解析',
  );

  const baseLedger = Array.from({ length: 4 }, (_, index) => environment(`suffix-base-${index}`, 9, index));
  const baseShell = shell({ ledger: baseLedger, elapsedMonths: 9, intents: [] });
  const baseProjection = projectAll(api, baseShell, baseLedger, authority(30));
  const suffixFailure = failedAction('suffix-failure', 10, 'suffix-intent');
  const suffixLedger = [...baseLedger, suffixFailure];
  const suffixIntent = terminalIntent({
    id: 'suffix-intent', failureEventId: suffixFailure.id,
    actionEventIds: [suffixFailure.id], outcomeSourceEventIds: [suffixFailure.id],
  });
  const suffixShell = shell({ ledger: suffixLedger, elapsedMonths: 10, intents: [suffixIntent] });
  const suffixFold = api.resumeHistoryRetentionProjection(
    baseProjection,
    suffixShell,
    authority(31),
  );
  api.foldHistoryRetentionSegment(suffixFold, [suffixFailure], baseLedger.length);
  const suffixProjection = api.finishHistoryRetentionProjection(suffixFold);
  assert.deepEqual(
    failureGroup(api, suffixProjection)?.eventIds,
    ['suffix-failure'],
    '当次 verified suffix 内的新 terminal failure 必须建立 exact lease',
  );

  const legacy = structuredClone(decoded);
  legacy.demandGroups = legacy.demandGroups.filter((group) => group.groupKey !== groupKey);
  legacy.unresolvedDemands = legacy.unresolvedDemands.filter((item) => item.groupKey !== groupKey);
  legacy.pins = legacy.pins.flatMap((pin) => {
    if (pin.eventId !== failure.id) return [pin];
    const leaseKeys = pin.leaseKeys.filter((leaseKey) => leaseKey !== groupKey);
    return leaseKeys.length > 0 ? [{ ...pin, leaseKeys }] : [];
  });
  legacy.continuationBasis.sourceDemand.groups =
    legacy.continuationBasis.sourceDemand.groups.filter((group) => group.groupKey !== groupKey);
  legacy.continuationBasis.directMatches = legacy.continuationBasis.directMatches
    .filter((match) => match.eventId !== failure.id);
  const { basisHash: _legacyBasisHash, ...legacyBasisWithoutHash } = legacy.continuationBasis;
  legacy.continuationBasis.basisHash =
    api.__testHistoryRetentionContinuationBasisHash(legacyBasisWithoutHash);
  assert.equal(
    api.historyRetentionDemandFingerprint(legacy.continuationBasis.sourceDemand),
    legacy.demandFingerprint,
    '旧 sidecar 缺少 storage-only group 时 fingerprint 仍须兼容',
  );
  const migrationFold = api.resumeHistoryRetentionProjection(
    legacy,
    shell({ ledger, elapsedMonths: 10, intents: [intent] }),
    authority(40),
  );
  assert.deepEqual(
    api.unresolvedVerifiedPrefixRecentTerminalFailureActionEventIds(migrationFold),
    [failure.id],
    '旧 sidecar 只允许从 exact verified prefix 迁移专属 failure ID',
  );
  api.seedVerifiedPrefixRecentTerminalFailureActionMatches(
    migrationFold,
    legacy.target.eventCount,
    [{ absoluteIndex: 0, eventId: failure.id }],
  );
  const migrated = api.finishHistoryRetentionProjection(migrationFold);
  assert.deepEqual(failureGroup(api, migrated)?.eventIds, [failure.id]);

  const oversizedIntents = Array.from(
    { length: api.HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_PER_PERSON + 1 },
    (_, index) => terminalIntent({
      id: `oversized-${index}`,
      failureEventId: `oversized-failure-${index}`,
      actionEventIds: [`oversized-failure-${index}`],
      outcomeSourceEventIds: [`oversized-failure-${index}`],
    }),
  );
  assert.throws(
    () => api.beginHistoryRetentionProjection(
      shell({ ledger: [environment('oversized-tail', 10)], elapsedMonths: 10, intents: oversizedIntents }),
      authority(50),
    ),
    /owner owner action facts 超出有界上限/u,
    'per-person lease 上限必须 fail-closed，不能截断',
  );

  const totalBoundOwnerCount = 65;
  const totalBoundEventsPerOwner = 253;
  const totalBoundPeople = Array.from(
    { length: totalBoundOwnerCount },
    (_, index) => person(`total-owner-${index}`),
  );
  const totalBoundIntents = totalBoundPeople.flatMap((owner, ownerIndex) => Array.from(
    { length: totalBoundEventsPerOwner },
    (_, eventIndex) => terminalIntent({
      id: `total-${ownerIndex}-${eventIndex}`,
      ownerId: owner.id,
      failureEventId: `total-failure-${ownerIndex}-${eventIndex}`,
      actionEventIds: [`total-failure-${ownerIndex}-${eventIndex}`],
      outcomeSourceEventIds: [`total-failure-${ownerIndex}-${eventIndex}`],
    }),
  ));
  assert.ok(
    totalBoundIntents.length > api.HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_TOTAL,
  );
  assert.throws(
    () => api.beginHistoryRetentionProjection(
      shell({
        ledger: [environment('total-oversized-tail', 10)], elapsedMonths: 10,
        intents: totalBoundIntents, people: totalBoundPeople,
      }),
      authority(51),
    ),
    /action leases 超出有界上限/u,
    'total lease membership 上限必须 fail-closed，不能靠跨人物重复放大 sidecar',
  );

  const memoryUsage = process.memoryUsage();
  console.log(JSON.stringify({
    result: 'passed',
    windowMonths: api.HISTORY_RETENTION_RECENT_TERMINAL_FAILURE_WINDOW_MONTHS,
    coldFailureAbsoluteIndex: 0,
    hotStartIndex: currentShell.world.historyCursor.hotStartIndex,
    suffixLeaseEventIds: failureGroup(api, suffixProjection)?.eventIds ?? [],
    rssBytes: memoryUsage.rss,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
