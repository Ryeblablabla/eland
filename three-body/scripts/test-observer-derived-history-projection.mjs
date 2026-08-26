import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'eland-observer-derived-history-'));

function base(id, atMonth, cellId = 0) {
  return { id, atMonth, orderInMonth: 0, cellId };
}

function action(id, atMonth, who, primitive, diff = {}, status = 'completed', cellId = 0) {
  return {
    ...base(id, atMonth, cellId),
    kind: 'action',
    actionTick: 1,
    who,
    cause: 'intent',
    action: primitive,
    fromCellId: cellId,
    toCellId: cellId,
    fromZ: 1,
    toZ: 1,
    pathSegment: primitive.kind === 'move' ? [cellId, primitive.toCellId] : [cellId],
    status,
    result: id,
    diff,
  };
}

try {
  const entry = path.join(temporaryDirectory, 'entry.ts');
  await writeFile(entry, `export * from ${JSON.stringify(path.join(workspace, 'server/observer-derived-history-projection.ts'))};\n`);
  const output = path.join(temporaryDirectory, 'projection.mjs');
  await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm' });
  const projection = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);
  const materialSource = await readFile(path.join(workspace, 'src/game/eland/domain/material.ts'), 'utf8');
  const material = Object.fromEntries([...materialSource.matchAll(/^\s{2}(\w+): (\d+),$/gmu)]
    .map((match) => [match[1], Number(match[2])]));

  const cultivation = [];
  for (let index = 0; index < 6; index += 1) {
    cultivation.push(action(
      `plant-${index}`,
      1,
      'farmer',
      { kind: 'act', operation: 'combine', targets: [] },
      { outputMaterialId: material.CropSprout, position: { x: index + 1, y: 1, z: 1 } },
    ));
  }
  cultivation.push(action(
    'harvest-0',
    2,
    'farmer',
    { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position: { x: 1, y: 1, z: 1 } }] },
    { sourceMaterialId: material.CropMature },
  ));
  cultivation.push(action(
    'harvest-1',
    2,
    'farmer-2',
    { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position: { x: 2, y: 1, z: 1 } }] },
    { sourceMaterialId: material.CropMature },
  ));

  const prefix = [
    action('transfer', 0, 'a', {
      kind: 'transfer', materialId: material.Food, quantity: 1,
      from: { kind: 'person', personId: 'a' }, to: { kind: 'container', containerId: 'container:4:4:1' },
    }),
    action('trail', 0, 'a', { kind: 'move', toCellId: 2 }, {
      materialChanges: [{ cellId: 2, to: material.PackedSoil }],
    }, 'progressed', 1),
    action('granary-install', 0, 'builder', { kind: 'act', operation: 'combine', targets: [] }, {
      outputMaterialId: material.Granary, position: { x: 4, y: 4, z: 1 },
    }),
    action('wood-batch', 0, 'builder', { kind: 'act', operation: 'combine', targets: [] }, {
      outputMaterialId: material.Plank,
    }),
    ...cultivation.slice(0, 6),
  ];
  const suffix = [
    ...cultivation.slice(6),
    ...Array.from({ length: 6 }, (_, index) => action(
      `teach-${index}`,
      index + 2,
      index % 2 ? 'teacher-b' : 'teacher-a',
      { kind: 'communicate', content: { id: `lesson-${index}`, kind: 'claim', summary: 'lesson' }, audience: ['learner'], channel: 'voice' },
      { taughtAudienceIds: ['learner'] },
    )),
    action('burial-0', 2, 'a', { kind: 'act', operation: 'inter', targets: [] }, { remainsInterred: true }),
    action('burial-1', 8, 'b', { kind: 'act', operation: 'inter', targets: [] }, { remainsInterred: true }),
    action('burial-2', 14, 'a', { kind: 'act', operation: 'inter', targets: [] }, { remainsInterred: true }),
    action('granary-use', 14, 'keeper', {
      kind: 'transfer', materialId: material.Food, quantity: 1,
      from: { kind: 'person', personId: 'keeper' }, to: { kind: 'container', containerId: 'container:4:4:1' },
    }),
    action('iron-failure', 15, 'smith', { kind: 'act', operation: 'combine', targets: [] }, {
      inputMaterialIds: [material.Iron], outputMaterialId: material.IronTool,
    }, 'blocked'),
    action('iron-batch', 15, 'smith', { kind: 'act', operation: 'combine', targets: [] }, {
      outputMaterialId: material.IronTool, facilityMaterialId: material.Smithy,
    }),
    action('iron-adoption', 16, 'farmer', { kind: 'act', operation: 'separate', targets: [] }, {
      sourceMaterialId: material.CropMature, toolMaterialId: material.IronTool,
    }),
    ...Array.from({ length: 128 }, (_, index) => ({
      ...base(`unrelated-${index}`, 17 + Math.floor(index / 64)),
      kind: 'environment', change: 'weather', result: 'unrelated', diff: {},
    })),
  ].sort((left, right) => left.atMonth - right.atMonth);
  const events = [...prefix, ...suffix];
  const completionEventIds = cultivation.map((event) => event.id);
  const demand = {
    settledCultivationProjects: [{
      projectId: 'cultivation-project',
      completedAtMonth: 2,
      siteCellIds: Array.from({ length: 6 }, (_, index) => 85 + index),
      actionEventIds: completionEventIds,
      completionEventIds,
    }],
    residentialStructures: [{ structureId: 'house', sourceEventIds: ['missing', 'wood-batch'] }],
  };
  const prefixTarget = { stateHash: 'a'.repeat(64), eventCount: prefix.length, tailEventId: prefix.at(-1).id };
  const finalTarget = { stateHash: 'b'.repeat(64), eventCount: events.length, tailEventId: events.at(-1).id };

  const full = projection.projectObserverDerivedHistoryFromFullHistory(events, finalTarget, demand);
  const segmentedFold = projection.beginObserverDerivedHistoryProjection(finalTarget, demand);
  projection.foldVerifiedObserverDerivedHistorySegment(segmentedFold, events.slice(0, 7), 0);
  projection.foldVerifiedObserverDerivedHistorySegment(segmentedFold, events.slice(7), 7);
  assert.deepEqual(projection.finishObserverDerivedHistoryProjection(segmentedFold), full);

  const conservativeFutureEventIds = [...new Set([
    ...completionEventIds,
    'missing',
    'wood-batch',
  ])];
  const prefixProjection = projection.projectObserverDerivedHistoryFromFullHistory(
    prefix,
    prefixTarget,
    { futureEventIds: conservativeFutureEventIds },
  );
  const resumedFold = projection.resumeObserverDerivedHistoryProjection(prefixProjection, finalTarget, demand);
  projection.foldVerifiedObserverDerivedHistorySegment(resumedFold, suffix, prefix.length);
  assert.deepEqual(projection.finishObserverDerivedHistoryProjection(resumedFold), full);
  assert.notEqual(prefixProjection.demandFingerprint, full.demandFingerprint,
    '自然续接允许 observer demand 改变，不依赖完整历史重建');

  const sameCursorDemand = {
    settledCultivationProjects: [{
      projectId: 'prefix-cultivation',
      completedAtMonth: 1,
      siteCellIds: Array.from({ length: 6 }, (_, index) => 85 + index),
      actionEventIds: cultivation.slice(0, 6).map((event) => event.id),
      completionEventIds: cultivation.slice(0, 6).map((event) => event.id),
    }],
    residentialStructures: [{ structureId: 'prefix-house', sourceEventIds: ['wood-batch'] }],
  };
  const sameCursorFold = projection.resumeObserverDerivedHistoryProjection(
    prefixProjection,
    { ...prefixTarget, stateHash: 'c'.repeat(64) },
    sameCursorDemand,
  );
  const sameCursor = projection.finishObserverDerivedHistoryProjection(sameCursorFold);
  assert.equal(sameCursor.regions.residential[0].sourceEvidence?.eventId, 'wood-batch');
  assert.equal(sameCursor.settledCultivationProjects[0].distinctPlantingPositionCount, 6);

  const absentFold = projection.resumeObserverDerivedHistoryProjection(
    prefixProjection,
    { ...prefixTarget, stateHash: '3'.repeat(64) },
    { residentialStructures: [{ structureId: 'verified-absent', sourceEventIds: ['missing'] }] },
  );
  const verifiedAbsent = projection.finishObserverDerivedHistoryProjection(absentFold);
  const missingBasis = verifiedAbsent.demandEventBasis.find((entry) => entry.eventId === 'missing');
  assert.equal(missingBasis?.latestWorldEvidence, null);
  assert.equal(missingBasis?.worldLastWriteResolved, true,
    '从 genesis 扫描过的未命中 future ref 必须保留 verified absent tombstone');
  assert.equal(missingBasis?.latestCultivationAction, null);
  assert.equal(missingBasis?.actionLastWriteResolved, true);

  const unpreparedPrefix = projection.projectObserverDerivedHistoryFromFullHistory(prefix, prefixTarget, {});
  const unknownOldDemand = projection.resumeObserverDerivedHistoryProjection(
    unpreparedPrefix,
    { ...prefixTarget, stateHash: '4'.repeat(64) },
    { residentialStructures: [{ structureId: 'unknown-old', sourceEventIds: ['wood-batch'] }] },
  );
  assert.throws(
    () => projection.finishObserverDerivedHistoryProjection(unknownOldDemand),
    /未解析/u,
    '未预留且 suffix 未覆盖的旧 ID 不得猜测为 absent',
  );

  const suffixDemandFold = projection.resumeObserverDerivedHistoryProjection(
    unpreparedPrefix,
    finalTarget,
    { residentialStructures: [{ structureId: 'suffix-source', sourceEventIds: ['granary-use'] }] },
  );
  projection.foldVerifiedObserverDerivedHistorySegment(suffixDemandFold, suffix, prefix.length);
  const suffixDemand = projection.finishObserverDerivedHistoryProjection(suffixDemandFold);
  assert.equal(suffixDemand.regions.residential[0].sourceEvidence?.eventId, 'granary-use',
    '新增 demand ID 被 suffix 的新事实覆盖后可以安全解析');

  assert.equal(full.practices.transfer.count, 2);
  assert.equal(full.functionalBuildings[0].useCount, 2);
  assert.equal(full.institutions.distributedTeaching.institutionThresholdSatisfied, true);
  assert.equal(full.institutions.repeatedInterment.institutionThresholdSatisfied, true);
  assert.equal(full.materialCapabilities.iron.successfulBatchCount, 1);
  assert.equal(full.materialCapabilities.iron.failedBatchCount, 1);
  assert.equal(full.materialCapabilities.iron.adoptedActionCount, 1);
  assert.equal(full.establishedCultivationWitness?.projectId, 'cultivation-project');
  assert.equal(full.regions.residential[0].firstObservedMonth, 0);
  assert.equal(full.continuationReady, false);
  assert.ok(full.continuationGaps.length > 0);
  assert.throws(() => {
    full.practices.transfer.evidence[0].eventId = 'forged';
  }, TypeError, 'observer derived artifact 必须深冻结');
  const evidenceBasis = full.demandEventBasis.find((entry) => entry.latestWorldEvidence);
  assert.ok(evidenceBasis?.latestWorldEvidence);
  assert.throws(() => {
    evidenceBasis.latestWorldEvidence.eventId = 'forged';
  }, TypeError, 'demand-closure event basis 必须深冻结');
  for (const practice of Object.values(full.practices)) {
    assert.ok(practice.evidence.length <= projection.OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT);
  }

  const duplicateEvents = [
    action('duplicate-plant', 0, 'farmer', { kind: 'act', operation: 'combine', targets: [] }, {
      outputMaterialId: material.CropSprout, position: { x: 1, y: 1, z: 1 },
    }),
    action('duplicate-erased', 0, 'farmer', { kind: 'act', operation: 'combine', targets: [] }, {
      outputMaterialId: material.CropSprout, position: { x: 3, y: 1, z: 1 },
    }),
    action('duplicate-plant', 1, 'farmer', { kind: 'act', operation: 'combine', targets: [] }, {
      outputMaterialId: material.CropSprout, position: { x: 2, y: 1, z: 1 },
    }),
    action('duplicate-harvest', 1, 'farmer', {
      kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position: { x: 2, y: 1, z: 1 } }],
    }, { sourceMaterialId: material.CropMature }),
    { ...base('duplicate-harvest', 2), kind: 'environment', change: 'weather', result: 'later world fact', diff: {} },
    action('duplicate-erased', 2, 'farmer', {
      kind: 'transfer', materialId: material.Food, quantity: 1,
      from: { kind: 'person', personId: 'farmer' }, to: { kind: 'person', personId: 'other' },
    }),
  ];
  const duplicateDemand = {
    settledCultivationProjects: [{
      projectId: 'duplicate-project',
      completedAtMonth: 2,
      siteCellIds: [85, 86, 87],
      actionEventIds: ['duplicate-plant', 'duplicate-harvest', 'duplicate-erased'],
      completionEventIds: ['duplicate-plant', 'duplicate-harvest', 'duplicate-erased'],
    }],
    residentialStructures: [{ structureId: 'duplicate-house', sourceEventIds: ['duplicate-harvest'] }],
  };
  const duplicateProjection = projection.projectObserverDerivedHistoryFromFullHistory(
    duplicateEvents,
    { stateHash: 'd'.repeat(64), eventCount: duplicateEvents.length, tailEventId: duplicateEvents.at(-1).id },
    duplicateDemand,
  );
  const duplicatePrefixTarget = {
    stateHash: '2'.repeat(64),
    eventCount: 2,
    tailEventId: duplicateEvents[1].id,
  };
  const duplicatePrefix = projection.projectObserverDerivedHistoryFromFullHistory(
    duplicateEvents.slice(0, 2),
    duplicatePrefixTarget,
    {},
  );
  const duplicateResume = projection.resumeObserverDerivedHistoryProjection(
    duplicatePrefix,
    { stateHash: 'd'.repeat(64), eventCount: duplicateEvents.length, tailEventId: duplicateEvents.at(-1).id },
    duplicateDemand,
  );
  projection.foldVerifiedObserverDerivedHistorySegment(duplicateResume, duplicateEvents.slice(2), 2);
  assert.deepEqual(projection.finishObserverDerivedHistoryProjection(duplicateResume), duplicateProjection,
    '跨 continuation 边界的 duplicate event.id 仍采用 last-write');
  assert.deepEqual(
    duplicateProjection.settledCultivationProjects[0].plantingWitnesses.map((item) => item.positionKey),
    ['2:1:1'],
    '同 event.id 的 action 采用最后一条，后来不相关 action 会覆盖旧分类',
  );
  assert.equal(duplicateProjection.settledCultivationProjects[0].harvestCountAtPlantedPositions, 1,
    '后来同 id 的 environment 不应抹掉 actionFacts last-write');
  assert.equal(duplicateProjection.regions.residential[0].sourceEvidence?.absoluteIndex, 4,
    'worldEventById demand 采用同 id 的最后一条 world fact');

  const boundedStructures = Array.from(
    { length: projection.OBSERVER_DERIVED_HISTORY_DEMAND_ENTITY_LIMIT },
    (_, index) => ({ structureId: `bounded-${index}`, sourceEventIds: [] }),
  );
  const boundedDemandProjection = projection.projectObserverDerivedHistoryFromFullHistory(
    [],
    { stateHash: 'e'.repeat(64), eventCount: 0, tailEventId: null },
    { residentialStructures: boundedStructures },
  );
  assert.equal(boundedDemandProjection.regions.residential.length, boundedStructures.length,
    '需求实体恰好位于上限时仍可投影');
  assert.throws(
    () => projection.beginObserverDerivedHistoryProjection(
      { stateHash: 'f'.repeat(64), eventCount: 0, tailEventId: null },
      { residentialStructures: [...boundedStructures, { structureId: 'overflow', sourceEventIds: [] }] },
    ),
    /上限/u,
  );

  const oversizedAudience = action(
    'oversized-audience',
    0,
    'teacher',
    { kind: 'communicate', content: { id: 'oversized-lesson', kind: 'claim', summary: 'lesson' }, audience: [], channel: 'voice' },
    { taughtAudienceIds: Array.from({ length: projection.OBSERVER_DERIVED_HISTORY_EVENT_COLLECTION_LIMIT + 1 }, (_, index) => `learner-${index}`) },
  );
  const oversizedFold = projection.beginObserverDerivedHistoryProjection(
    { stateHash: '1'.repeat(64), eventCount: 1, tailEventId: oversizedAudience.id },
  );
  assert.throws(
    () => projection.foldVerifiedObserverDerivedHistorySegment(oversizedFold, [oversizedAudience], 0),
    /taught audience.*上限/u,
  );
  assert.throws(() => projection.finishObserverDerivedHistoryProjection(oversizedFold), /作废/u);

  const unrelatedEventCount = 100_000;
  const unrelatedFold = projection.beginObserverDerivedHistoryProjection(
    {
      stateHash: '5'.repeat(64),
      eventCount: unrelatedEventCount,
      tailEventId: `unrelated-large-${unrelatedEventCount - 1}`,
    },
    { futureEventIds: ['verified-absent-large-history'] },
  );
  const unrelatedBatchSize = 1_000;
  for (let start = 0; start < unrelatedEventCount; start += unrelatedBatchSize) {
    const length = Math.min(unrelatedBatchSize, unrelatedEventCount - start);
    const batch = Array.from({ length }, (_, offset) => {
      const absoluteIndex = start + offset;
      return {
        ...base(`unrelated-large-${absoluteIndex}`, Math.floor(absoluteIndex / unrelatedBatchSize)),
        kind: 'environment',
        change: 'weather',
        result: 'unrelated',
        diff: {},
      };
    });
    projection.foldVerifiedObserverDerivedHistorySegment(unrelatedFold, batch, start);
  }
  const unrelatedProjection = projection.finishObserverDerivedHistoryProjection(unrelatedFold);
  assert.equal(unrelatedProjection.demandEventBasis.length, 1,
    '100k unrelated unique event IDs 不得进入 demand closure basis');
  assert.equal(unrelatedProjection.demandEventBasis[0].latestWorldEvidence, null);
  assert.equal(unrelatedProjection.demandEventBasis[0].worldLastWriteResolved, true);

  const memoryUsage = process.memoryUsage();
  assert.ok(memoryUsage.rss < 256 * 1024 * 1024,
    'derived observer 100k unrelated-event fixture RSS 不得超过 256 MiB');

  const broken = projection.beginObserverDerivedHistoryProjection(finalTarget, demand);
  assert.throws(
    () => projection.foldVerifiedObserverDerivedHistorySegment(broken, events.slice(1, 2), 1),
    /cursor/u,
  );
  assert.throws(() => projection.finishObserverDerivedHistoryProjection(broken), /作废/u);
  console.log(JSON.stringify({
    result: 'passed',
    eventCount: events.length,
    unrelatedEventCount,
    demandEventBasisCount: unrelatedProjection.demandEventBasis.length,
    rssBytes: memoryUsage.rss,
  }, null, 2));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
