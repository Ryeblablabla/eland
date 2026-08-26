import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-retention-codec-'));
const codecPath = path.join(temporaryDirectory, 'history-retention-codec.mjs');
const projectionPath = path.join(temporaryDirectory, 'history-retention-projection.mjs');
const childEnvironment = { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' };
const operationTechniqueId = 'technique:mechanical-power:water-wheel-shaft-mill-operation';

function baseEvent(id, atMonth) {
  return { id, atMonth, orderInMonth: 0, planningTick: 1, orderInTick: 0, cellId: 0 };
}

function environment(id, atMonth, change = 'condition', diff = {}) {
  return { ...baseEvent(id, atMonth), kind: 'environment', change, result: id, diff };
}

function decision(id, atMonth) {
  return {
    ...baseEvent(id, atMonth), kind: 'decision', who: 'parent-a', usedModel: false,
    decision: { kind: 'fixture', optionId: id, reason: id }, result: id,
  };
}

function action(id, atMonth, who, actionValue, diff = {}) {
  return {
    ...baseEvent(id, atMonth), kind: 'action', actionTick: 1, who, cause: 'intent',
    action: actionValue, fromCellId: 0, toCellId: 0, fromZ: 1, toZ: 1,
    pathSegment: [], status: 'completed', result: id, diff,
  };
}

function person(id, extra = {}) {
  return {
    id, bornAtMonth: 0,
    body: { health: 80, hydration: 80, nutrition: 80 },
    memories: [], conditions: [], relations: [], bereavements: [],
    maternalTeachingSourceEventIds: [], geneticParents: [],
    knowledge: [], inventory: [],
    ...extra,
  };
}

function cloneChunk(chunk) {
  return { ...chunk, data: Buffer.from(chunk.data) };
}

try {
  for (const [entry, outfile] of [
    ['server/history-retention-codec.ts', codecPath],
    ['server/history-retention-projection.ts', projectionPath],
  ]) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entry,
      '--bundle',
      '--platform=node',
      '--format=esm',
      `--outfile=${outfile}`,
    ], { env: childEnvironment, stdio: 'pipe' });
  }

  const codec = await import(`${pathToFileURL(codecPath).href}?v=${Date.now()}`);
  const projectionApi = await import(`${pathToFileURL(projectionPath).href}?v=${Date.now()}`);

  const events = [
    decision('reproduction-decision', 1),
    environment('prediction-source', 1),
    environment('child-birth', 1, 'body', { bornPersonId: 'child' }),
    action('reproduction-attempt', 2, 'parent-a', {
      kind: 'act', operation: 'reproduce', authorizationRef: 'agreement-reproduction',
      targets: [{ kind: 'person', personId: 'parent-b' }],
    }, { conceived: true, femaleId: 'parent-b' }),
    action('prediction-wake', 2, 'learner', {
      kind: 'act', operation: 'rehydrate', targets: [],
    }, {
      rehydrationBasis: 'disputed-pending-prediction',
      hibernationPredictionId: 'prediction-1',
      rehydratedPersonId: 'learner',
    }),
    action('mechanical-teaching', 3, 'parent-a', {
      kind: 'communicate', channel: 'voice', audience: ['learner'],
      content: {
        kind: 'claim', id: 'teaching-claim', factId: operationTechniqueId, summary: 'teach',
      },
    }, {
      explicitTeaching: true,
      teachingFactId: operationTechniqueId,
      taughtAudienceIds: ['learner'],
    }),
    action('learner-operation', 3, 'learner', {
      kind: 'act', operation: 'exert', targets: [],
    }, { mechanicalPowerOperation: true, mode: 'operate-service' }),
    action('learner-mill-labor', 4, 'learner', {
      kind: 'act', operation: 'separate', targets: [],
    }, { sourceMaterialId: 12, facilityMaterialId: 59 }),
    environment('tail', 4),
  ];
  const shell = {
    clock: { elapsedMonths: 4 },
    world: {
      past: [],
      historyCursor: {
        version: 1,
        eventCount: events.length,
        hotStartIndex: events.length,
        tailEventId: events.at(-1).id,
      },
      mechanicalPower: { version: 'mechanical-power-world-v1', sources: [], networks: [] },
    },
    people: [
      person('parent-a'),
      person('parent-b'),
      person('learner'),
      person('child', { geneticParents: ['parent-a', 'parent-b'] }),
    ],
    projects: [],
    eraPredictions: [{
      id: 'prediction-1', status: 'pending', sourceEventIds: ['prediction-source'],
    }],
    agreements: [{
      id: 'agreement-reproduction', status: 'active', acceptedAtMonth: 1, dueAtMonth: 4,
      proposalEventId: 'agreement-proposal', sourceEventIds: [],
      proposal: { kind: 'reproduce' },
      reproductionAttemptEventIds: ['reproduction-attempt'],
      lastReproductionAttemptAtMonth: 2,
    }],
    intents: [{
      id: 'intent-reproduction', ownerId: 'parent-a', status: 'active', createdAtMonth: 1,
      agreementId: 'agreement-reproduction', sourceDecisionEventId: 'reproduction-decision',
      sourceFactIds: [], actionEventIds: [], replanCount: 0,
      goal: { kind: 'condition', condition: 'pregnancy', present: true, personId: 'parent-b' },
      nextAction: {
        kind: 'act', operation: 'reproduce', authorizationRef: 'agreement-reproduction',
        targets: [{ kind: 'person', personId: 'parent-b' }],
      },
    }],
  };
  const authority = { stateHash: 'a'.repeat(64) };
  const fold = projectionApi.beginHistoryRetentionProjection(shell, authority);
  projectionApi.foldHistoryRetentionSegment(fold, events, 0);
  const projection = projectionApi.finishHistoryRetentionProjection(fold);
  assert.ok(projection.pins.length >= 2, 'fixture 必须产生多个可验证 pin');
  assert.ok(projection.minimalMechanicalTeachingWitness, 'fixture 必须覆盖机械教学 witness');
  assert.equal(projection.continuationBasis.reproductionAttempts.length, 1);

  const encoded = codec.encodeHistoryRetentionSidecar(projection);
  const originalBytes = Buffer.from(encoded.chunk.data);
  const originalCanonicalBytes = brotliDecompressSync(originalBytes);
  assert.ok(originalBytes.byteLength < originalCanonicalBytes.byteLength,
    'current retention sidecar 应压缩 canonical payload');
  const boundary = { authority: projection.authority, target: projection.target };
  const decoded = codec.decodeHistoryRetentionSidecar(encoded.chunk, {
    reference: encoded.reference,
    boundary,
  });
  assert.deepEqual(decoded, projection);
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.continuationBasis.sourceDemand.reproductionFacts[0]));

  const exposedBytes = encoded.chunk.data;
  exposedBytes.fill(0);
  assert.deepEqual(encoded.chunk.data, originalBytes, 'encode 不得暴露私有字节');

  assert.throws(
    () => codec.decodeHistoryRetentionSidecar(encoded.chunk, {
      reference: { ...encoded.reference, hash: '0'.repeat(64) },
      boundary,
    }),
    /store-selected content reference/u,
  );
  assert.throws(
    () => codec.decodeHistoryRetentionSidecar(encoded.chunk, {
      reference: encoded.reference,
      boundary: {
        authority: { stateHash: 'f'.repeat(64) },
        target: projection.target,
      },
    }),
    /expected authority\/target boundary/u,
  );
  assert.throws(
    () => codec.decodeHistoryRetentionSidecar(encoded.chunk, {
      reference: {
        kind: 'canonical-digest', domain: 'forged', hash: encoded.reference.hash,
      },
      boundary,
    }),
    /字段集合无效|content-hash/u,
  );

  const changedBytes = cloneChunk(encoded.chunk);
  changedBytes.data[0] ^= 0xff;
  assert.throws(
    () => codec.decodeHistoryRetentionSidecar(changedBytes, {
      reference: encoded.reference,
      boundary,
    }),
    /SHA-256 校验失败/u,
  );

  function chunkForParsed(parsed) {
    const data = Buffer.from(JSON.stringify(parsed), 'utf8');
    const hash = codec.hashHistoryRetentionStoredContent(
      codec.HISTORY_RETENTION_SIDECAR_LEGACY_CODEC,
      data,
    );
    return {
      chunk: {
        hash,
        codec: codec.HISTORY_RETENTION_SIDECAR_LEGACY_CODEC,
        rawSize: data.byteLength,
        data,
      },
      reference: {
        kind: 'content-hash', codec: codec.HISTORY_RETENTION_SIDECAR_LEGACY_CODEC, hash,
      },
    };
  }

  const legacyValid = chunkForParsed(JSON.parse(originalCanonicalBytes.toString('utf8')));
  assert.deepEqual(codec.decodeHistoryRetentionSidecar(legacyValid.chunk, {
    reference: legacyValid.reference,
    boundary,
  }), projection, 'legacy JSON sidecar 必须可读并迁移到 current writer');

  const duplicateOrdinal = JSON.parse(originalCanonicalBytes.toString('utf8'));
  duplicateOrdinal.pins[1].absoluteIndex = duplicateOrdinal.pins[0].absoluteIndex;
  const duplicateOrdinalSidecar = chunkForParsed(duplicateOrdinal);
  assert.throws(
    () => codec.decodeHistoryRetentionSidecar(
      duplicateOrdinalSidecar.chunk,
      { reference: duplicateOrdinalSidecar.reference, boundary },
    ),
    /absoluteIndex 重复|未严格递增/u,
  );

  const forgedShape = JSON.parse(originalCanonicalBytes.toString('utf8'));
  delete forgedShape.continuationBasis.sourceDemand.reproductionFacts[0].ownerId;
  const forgedShapeSidecar = chunkForParsed(forgedShape);
  assert.throws(
    () => codec.decodeHistoryRetentionSidecar(
      forgedShapeSidecar.chunk,
      { reference: forgedShapeSidecar.reference, boundary },
    ),
    /字段集合无效/u,
  );

  const staleBasisHash = JSON.parse(originalCanonicalBytes.toString('utf8'));
  staleBasisHash.continuationBasis.summary.ruleDecisions += 1;
  const staleBasisSidecar = chunkForParsed(staleBasisHash);
  assert.throws(
    () => codec.decodeHistoryRetentionSidecar(
      staleBasisSidecar.chunk,
      { reference: staleBasisSidecar.reference, boundary },
    ),
    /summary 与 projection 不一致|basisHash 无效/u,
  );

  const prettyBytes = Buffer.from(
    JSON.stringify(JSON.parse(originalCanonicalBytes.toString('utf8')), null, 2),
    'utf8',
  );
  const prettyHash = codec.hashHistoryRetentionStoredContent(
    codec.HISTORY_RETENTION_SIDECAR_LEGACY_CODEC,
    prettyBytes,
  );
  assert.throws(
    () => codec.decodeHistoryRetentionSidecar({
      hash: prettyHash,
      codec: codec.HISTORY_RETENTION_SIDECAR_LEGACY_CODEC,
      rawSize: prettyBytes.byteLength,
      data: prettyBytes,
    }, {
      reference: {
        kind: 'content-hash', codec: codec.HISTORY_RETENTION_SIDECAR_LEGACY_CODEC, hash: prettyHash,
      },
      boundary,
    }),
    /不是 canonical 编码/u,
  );

  const oversizedBytes = Buffer.alloc(codec.MAX_HISTORY_RETENTION_SIDECAR_STORED_BYTES + 1);
  const oversizedHash = codec.hashHistoryRetentionStoredContent(
    codec.HISTORY_RETENTION_SIDECAR_CODEC,
    oversizedBytes,
  );
  assert.throws(
    () => codec.decodeHistoryRetentionSidecar({
      hash: oversizedHash,
      codec: codec.HISTORY_RETENTION_SIDECAR_CODEC,
      rawSize: oversizedBytes.byteLength,
      data: oversizedBytes,
    }, {
      reference: {
        kind: 'content-hash', codec: codec.HISTORY_RETENTION_SIDECAR_CODEC, hash: oversizedHash,
      },
      boundary,
    }),
    /超过硬上限/u,
  );

  const callerOwnedChunk = cloneChunk(encoded.chunk);
  const snapshot = codec.snapshotHistoryRetentionSidecarChunk(callerOwnedChunk);
  callerOwnedChunk.data.fill(0);
  assert.deepEqual(snapshot.data, originalBytes);
  const snapshotBytes = snapshot.data;
  snapshotBytes.fill(0);
  assert.deepEqual(snapshot.data, originalBytes);

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1_024 * 1_024, `fixture RSS ${rssBytes} 超过 256 MiB`);
  console.log(JSON.stringify({
    result: 'passed',
    codec: codec.HISTORY_RETENTION_SIDECAR_CODEC,
    eventCount: projection.target.eventCount,
    pinCount: projection.pins.length,
    demandGroupCount: projection.demandGroups.length,
    rssBytes,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
