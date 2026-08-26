import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-observer-civilization-history-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'entry.mjs');

function base(id, atMonth) {
  return { id, atMonth, orderInMonth: 0, planningTick: 1, orderInTick: 0, cellId: 0 };
}

function environment(id, atMonth, change, diff = {}) {
  return { ...base(id, atMonth), kind: 'environment', change, result: id, diff };
}

function action(id, atMonth, who, primitive, diff = {}) {
  return {
    ...base(id, atMonth), kind: 'action', actionTick: 1, who, cause: 'intent', action: primitive,
    fromCellId: 0, toCellId: 0, fromZ: 1, toZ: 1, pathSegment: [], status: 'completed', result: id, diff,
  };
}

function agreement(id, atMonth, change) {
  return { ...base(id, atMonth), kind: 'agreement', agreementId: id, change, partyIds: ['p1', 'p2'], result: id };
}

try {
  writeFileSync(entryPath, `export * from ${JSON.stringify(path.resolve('server/observer-civilization-history-projection.ts'))};\n`);
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entryPath, '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' }, stdio: 'pipe' });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  const events = [
    environment('birth', 0, 'body', { bornPersonId: 'p3' }),
    action('teach', 1, 'p1', {
      kind: 'communicate', channel: 'voice', audience: ['p2'],
      content: { kind: 'claim', id: 'claim-1', factId: 'technique:fire', text: 'fire' },
    }),
    action('craft', 1, 'p1', { kind: 'act', operation: 'combine', targets: [] }, { outputMaterialId: 9 }),
    environment('era-steady', 2, 'climate', { eraTransition: true, epoch: 'stable' }),
    agreement('fulfilled', 2, 'fulfilled'),
    action('request', 3, 'p2', {
      kind: 'communicate', channel: 'voice', audience: ['p1'],
      content: { kind: 'request', id: 'request-1', need: 'water', text: 'water' },
    }),
    environment('death', 4, 'death', { personId: 'p3' }),
    environment('era-chaotic', 5, 'climate', { eraTransition: true, epoch: 'chaotic' }),
  ];
  const finalTarget = { stateHash: 'a'.repeat(64), eventCount: events.length, tailEventId: events.at(-1).id };
  const full = api.projectObserverCivilizationHistoryFromFullHistory(events, finalTarget);

  const segmentedFold = api.beginObserverCivilizationHistoryProjection(finalTarget);
  api.foldVerifiedObserverCivilizationHistorySegment(segmentedFold, events.slice(0, 3), 0);
  api.foldVerifiedObserverCivilizationHistorySegment(segmentedFold, events.slice(3), 3);
  const segmented = api.finishObserverCivilizationHistoryProjection(segmentedFold);
  assert.deepEqual(segmented.eventHistory, full.eventHistory, 'full 与 verified segments 的事件摘要必须等价');

  const prefixTarget = { stateHash: 'b'.repeat(64), eventCount: 4, tailEventId: events[3].id };
  const prefix = api.projectObserverCivilizationHistoryFromFullHistory(events.slice(0, 4), prefixTarget);
  const resumedFold = api.resumeObserverCivilizationHistoryProjection(prefix, finalTarget);
  api.foldVerifiedObserverCivilizationHistorySegment(resumedFold, events.slice(4), 4);
  const resumed = api.finishObserverCivilizationHistoryProjection(resumedFold);
  assert.deepEqual(resumed.eventHistory, full.eventHistory, 'resume + suffix 必须与 full 等价');

  const coveragePrefixFold = api.beginObserverCivilizationHistoryProjection(prefixTarget);
  api.foldVerifiedObserverCivilizationHistorySegment(coveragePrefixFold, events.slice(0, 4), 0);
  const coverageDefinitionId = 'world:era-cycle:stable:era-cycle:v2';
  api.completeObserverMilestoneDefinition(coveragePrefixFold, coverageDefinitionId);
  const coveragePrefix = api.finishObserverCivilizationHistoryProjection(coveragePrefixFold);
  const coverageResumedFold = api.resumeObserverCivilizationHistoryProjection(coveragePrefix, finalTarget);
  assert.equal(
    coverageResumedFold.completeMilestoneDefinitionIds.size,
    0,
    '扩展 target 后必须 reopen detector coverage，不能沿用 prefix complete',
  );
  assert.throws(
    () => api.completeObserverMilestoneDefinition(coverageResumedFold, coverageDefinitionId),
    /target seal/u,
    'suffix 尚未折叠时不得提前声明完整 detector coverage',
  );
  api.foldVerifiedObserverCivilizationHistorySegment(coverageResumedFold, events.slice(4), 4);
  api.completeObserverMilestoneDefinition(coverageResumedFold, coverageDefinitionId);
  assert.deepEqual(
    api.finishObserverCivilizationHistoryProjection(coverageResumedFold).completeMilestoneDefinitionIds,
    [coverageDefinitionId],
    '扩展 target 的 detector 必须处理 suffix 后重新 complete',
  );
  assert.equal(full.eventHistory.births, 1);
  assert.equal(full.eventHistory.deaths, 1);
  assert.equal(full.eventHistory.agreementOutcomes, 1);
  assert.equal(full.eventHistory.eraTransitions, 2);
  assert.deepEqual(full.eventHistory.taughtFactIds, ['technique:fire']);
  assert.deepEqual(full.eventHistory.realizedProcessKeys, ['combine:9']);
  assert.deepEqual(full.eventHistory.interactionDyadKeys, ['p1|p2']);

  const milestoneFold = api.beginObserverCivilizationHistoryProjection(finalTarget);
  const milestoneEvidence = new Map();
  api.foldVerifiedObserverCivilizationHistorySegment(milestoneFold, events, 0, (_event, evidence) => {
    milestoneEvidence.set(evidence.absoluteIndex, evidence);
  });
  const definitionId = coverageDefinitionId;
  assert.throws(() => api.recordObserverMilestoneEpisode(milestoneFold, {
    definitionId,
    observedAtMonth: 5,
    evidence: [
      { ...milestoneEvidence.get(3) },
      { ...milestoneEvidence.get(7) },
    ],
  }), /verified fold 内部绑定/u, '复制或伪造的 ledger ref 不得冒充 verified evidence');
  assert.equal(api.recordObserverMilestoneEpisode(milestoneFold, {
    definitionId,
    observedAtMonth: 5,
    evidence: [
      milestoneEvidence.get(3),
      milestoneEvidence.get(7),
    ],
  }), true);
  api.completeObserverMilestoneDefinition(milestoneFold, definitionId);
  const milestoneProjection = api.finishObserverCivilizationHistoryProjection(milestoneFold);
  assert.equal(milestoneProjection.milestoneBasis[0].stageCriteriaSatisfied, true);
  assert.deepEqual(milestoneProjection.completeMilestoneDefinitionIds, [definitionId]);
  assert.equal(milestoneProjection.continuationReady, false, 'foundation 不得冒充完整 bounded observer');
  assert.ok(milestoneProjection.continuationGaps.length > 0);
  assert.throws(() => {
    milestoneProjection.milestoneBasis[0].episodes[0].evidence[0].eventId = 'forged';
  }, TypeError, 'projection 必须深冻结');

  const incompleteCoverageFold = api.beginObserverCivilizationHistoryProjection(finalTarget);
  api.foldVerifiedObserverCivilizationHistorySegment(incompleteCoverageFold, events.slice(0, 4), 0);
  assert.throws(
    () => api.completeObserverMilestoneDefinition(incompleteCoverageFold, definitionId),
    /target seal/u,
    '只处理 target prefix 的 adapter 不得标记 complete',
  );

  const milestoneIdLimits = {
    ...api.DEFAULT_OBSERVER_CIVILIZATION_HISTORY_LIMITS,
    maxMilestoneParticipantIdsPerDefinition: 1,
    maxMilestoneAffectedPersonIdsPerDefinition: 1,
  };
  const idLimitFold = api.beginObserverCivilizationHistoryProjection(finalTarget, milestoneIdLimits);
  let idLimitEvidence;
  api.foldVerifiedObserverCivilizationHistorySegment(idLimitFold, events, 0, (_event, evidence) => {
    if (evidence.absoluteIndex === 7) idLimitEvidence = evidence;
  });
  assert.throws(() => api.recordObserverMilestoneEpisode(idLimitFold, {
    definitionId,
    observedAtMonth: 5,
    evidence: [idLimitEvidence],
    participantIds: ['p1', 'p2'],
  }), /participant IDs.*上限/u, 'milestone participant 集合超限必须失败关闭');
  assert.throws(() => api.finishObserverCivilizationHistoryProjection(idLimitFold), /作废/u);

  const affectedLimitFold = api.beginObserverCivilizationHistoryProjection(finalTarget, milestoneIdLimits);
  let affectedLimitEvidence;
  api.foldVerifiedObserverCivilizationHistorySegment(affectedLimitFold, events, 0, (_event, evidence) => {
    if (evidence.absoluteIndex === 7) affectedLimitEvidence = evidence;
  });
  assert.throws(() => api.recordObserverMilestoneEpisode(affectedLimitFold, {
    definitionId,
    observedAtMonth: 5,
    evidence: [affectedLimitEvidence],
    affectedPersonIds: ['p1', 'p2'],
  }), /affected person IDs.*上限/u, 'milestone affected 集合超限必须失败关闭');
  assert.throws(() => api.finishObserverCivilizationHistoryProjection(affectedLimitFold), /作废/u);

  const gapFold = api.beginObserverCivilizationHistoryProjection(finalTarget);
  assert.throws(
    () => api.foldVerifiedObserverCivilizationHistorySegment(gapFold, events.slice(1), 1),
    /重复或跳跃/u,
  );
  const zeroTaughtLimits = { ...api.DEFAULT_OBSERVER_CIVILIZATION_HISTORY_LIMITS, maxTaughtFactIds: 0 };
  const overflowFold = api.beginObserverCivilizationHistoryProjection(finalTarget, zeroTaughtLimits);
  assert.throws(
    () => api.foldVerifiedObserverCivilizationHistorySegment(overflowFold, events, 0),
    /taught fact IDs.*上限/u,
    '容量不足必须失败关闭，不能近似或静默丢历史',
  );

  const memoryUsage = process.memoryUsage();
  assert.ok(memoryUsage.rss < 256 * 1024 * 1024, 'civilization observer synthetic fixture RSS 不得超过 256 MiB');
  console.log(JSON.stringify({
    result: 'passed', eventCount: events.length,
    causalAnchors: full.eventHistory.causalEventAnchorIds.length,
    milestoneDefinitionsCovered: milestoneProjection.completeMilestoneDefinitionIds.length,
    rssBytes: memoryUsage.rss,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
