import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-civilization-codec-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'entry.mjs');
const childEnvironment = { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' };

function base(id, atMonth) {
  return { id, atMonth, orderInMonth: 0, planningTick: 1, orderInTick: 0, cellId: 0 };
}

function environment(id, atMonth, change, diff = {}) {
  return { ...base(id, atMonth), kind: 'environment', change, result: id, diff };
}

function action(id, atMonth, who, primitive, diff = {}) {
  return {
    ...base(id, atMonth),
    kind: 'action',
    actionTick: 1,
    who,
    cause: 'intent',
    action: primitive,
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

function agreement(id, atMonth, change) {
  return {
    ...base(id, atMonth),
    kind: 'agreement',
    agreementId: id,
    change,
    partyIds: ['p1', 'p2'],
    result: id,
  };
}

function cloneChunk(chunk) {
  return { ...chunk, data: Buffer.from(chunk.data) };
}

try {
  writeFileSync(entryPath, [
    `export * from ${JSON.stringify(path.resolve('server/civilization-history-codec.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('server/observer-civilization-history-projection.ts'))};`,
  ].join('\n'));
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { env: childEnvironment, stdio: 'pipe' });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  const events = [
    environment('birth', 0, 'body', { bornPersonId: 'p3' }),
    action('teach', 1, 'p1', {
      kind: 'communicate',
      channel: 'voice',
      audience: ['p2'],
      content: { kind: 'claim', id: 'claim-1', factId: 'technique:fire', text: 'fire' },
    }),
    action(
      'craft',
      1,
      'p1',
      { kind: 'act', operation: 'combine', targets: [] },
      { outputMaterialId: 9 },
    ),
    environment('era-steady', 2, 'climate', { eraTransition: true, epoch: 'stable' }),
    agreement('fulfilled', 2, 'fulfilled'),
    action('request', 3, 'p2', {
      kind: 'communicate',
      channel: 'voice',
      audience: ['p1'],
      content: { kind: 'request', id: 'request-1', need: 'water', text: 'water' },
    }),
    environment('death', 4, 'death', { personId: 'p3' }),
    environment('era-chaotic', 5, 'climate', { eraTransition: true, epoch: 'chaotic' }),
  ];
  const target = {
    stateHash: 'a'.repeat(64),
    eventCount: events.length,
    tailEventId: events.at(-1).id,
  };
  const definitionId = 'world:era-cycle:stable:era-cycle:v2';
  const fold = api.beginObserverCivilizationHistoryProjection(target);
  const evidenceByIndex = new Map();
  api.foldVerifiedObserverCivilizationHistorySegment(fold, events, 0, (_event, evidence) => {
    evidenceByIndex.set(evidence.absoluteIndex, evidence);
  });
  assert.equal(api.recordObserverMilestoneEpisode(fold, {
    definitionId,
    observedAtMonth: 5,
    evidence: [evidenceByIndex.get(3), evidenceByIndex.get(7)],
    participantIds: ['p1', 'p2'],
    affectedPersonIds: ['p3'],
  }), true);
  api.completeObserverMilestoneDefinition(fold, definitionId);
  const projection = api.finishObserverCivilizationHistoryProjection(fold);
  assert.equal(projection.milestoneBasis[0].stageCriteriaSatisfied, true);

  const mutableInput = structuredClone(projection);
  const encoded = api.encodeObserverCivilizationHistorySidecar(mutableInput);
  const originalBytes = Buffer.from(encoded.chunk.data);
  mutableInput.eventHistory.births = 0;
  assert.equal(encoded.sidecar.projection.eventHistory.births, 1, 'encode 必须拥有 projection');
  const boundary = { target };
  const decoded = api.decodeObserverCivilizationHistorySidecar(encoded.chunk, {
    reference: encoded.reference,
    boundary,
  });
  assert.deepEqual(decoded.projection, projection);
  assert.equal(decoded.domain, api.OBSERVER_CIVILIZATION_HISTORY_SIDECAR_DOMAIN);
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.projection));
  assert.ok(Object.isFrozen(decoded.projection.milestoneBasis[0].episodes[0].evidence[0]));

  const exposedBytes = encoded.chunk.data;
  exposedBytes.fill(0);
  assert.deepEqual(encoded.chunk.data, originalBytes, 'encode 不得暴露私有字节');

  assert.throws(
    () => api.decodeObserverCivilizationHistorySidecar(encoded.chunk, {
      reference: { ...encoded.reference, hash: '0'.repeat(64) },
      boundary,
    }),
    /store-selected content reference/u,
  );
  assert.throws(
    () => api.decodeObserverCivilizationHistorySidecar(encoded.chunk, {
      reference: encoded.reference,
      boundary: {
        target: { ...target, stateHash: 'f'.repeat(64) },
      },
    }),
    /store-selected exact target/u,
  );
  assert.throws(
    () => api.decodeObserverCivilizationHistorySidecar(encoded.chunk, {
      reference: {
        kind: 'canonical-digest',
        codec: api.OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC,
        hash: encoded.reference.hash,
      },
      boundary,
    }),
    /content-hash/u,
  );

  const changedBytes = cloneChunk(encoded.chunk);
  changedBytes.data[0] ^= 0xff;
  assert.throws(
    () => api.decodeObserverCivilizationHistorySidecar(changedBytes, {
      reference: encoded.reference,
      boundary,
    }),
    /SHA-256 校验失败/u,
  );

  function sidecarForParsed(parsed) {
    const data = Buffer.from(JSON.stringify(parsed), 'utf8');
    const hash = api.hashObserverCivilizationHistoryStoredContent(
      api.OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC,
      data,
    );
    return {
      chunk: {
        hash,
        codec: api.OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC,
        rawSize: data.byteLength,
        data,
      },
      expectation: {
        reference: {
          kind: 'content-hash',
          codec: api.OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC,
          hash,
        },
        boundary,
      },
    };
  }

  function assertRejectedMutation(mutate, pattern) {
    const parsed = JSON.parse(originalBytes.toString('utf8'));
    mutate(parsed);
    const forged = sidecarForParsed(parsed);
    assert.throws(
      () => api.decodeObserverCivilizationHistorySidecar(
        forged.chunk,
        forged.expectation,
      ),
      pattern,
    );
  }

  assertRejectedMutation(
    (parsed) => { delete parsed.projection.eventHistory.births; },
    /字段集合无效/u,
  );
  assertRejectedMutation(
    (parsed) => { parsed.projection.limits.maxTaughtFactIds += 1; },
    /maxTaughtFactIds/u,
  );
  assertRejectedMutation(
    (parsed) => { parsed.projection.eventHistory.taughtFactIds.push('aaa'); },
    /字典序/u,
  );
  assertRejectedMutation(
    (parsed) => { parsed.projection.eventHistory.births = 0; },
    /birth\/death count/u,
  );
  assertRejectedMutation(
    (parsed) => {
      parsed.projection.milestoneBasis[0].episodes[0].evidence[1].absoluteIndex -= 1;
    },
    /tail identity|absoluteIndex/u,
  );
  assertRejectedMutation(
    (parsed) => { parsed.projection.milestoneBasis[0].distinctEvidenceEvents += 1; },
    /derived milestone counts/u,
  );
  assertRejectedMutation(
    (parsed) => { parsed.projection.milestoneBasis[0].stageCriteriaSatisfied = false; },
    /derived milestone counts/u,
  );
  assertRejectedMutation(
    (parsed) => { parsed.projection.milestoneBasis = []; },
    /缺少完整 basis/u,
  );
  assertRejectedMutation(
    (parsed) => { parsed.projection.continuationGaps.pop(); },
    /缺少当前 fail-closed gap/u,
  );
  assertRejectedMutation(
    (parsed) => { parsed.projection.continuationReady = true; },
    /必须保持 false/u,
  );
  assertRejectedMutation(
    (parsed) => { parsed.domain = 'forged-observer-domain'; },
    /domain 无效/u,
  );

  const prettyBytes = Buffer.from(
    JSON.stringify(JSON.parse(originalBytes.toString('utf8')), null, 2),
    'utf8',
  );
  const prettyHash = api.hashObserverCivilizationHistoryStoredContent(
    api.OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC,
    prettyBytes,
  );
  assert.throws(
    () => api.decodeObserverCivilizationHistorySidecar({
      hash: prettyHash,
      codec: api.OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC,
      rawSize: prettyBytes.byteLength,
      data: prettyBytes,
    }, {
      reference: {
        kind: 'content-hash',
        codec: api.OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC,
        hash: prettyHash,
      },
      boundary,
    }),
    /不是 canonical UTF-8 JSON 编码/u,
  );

  const oversizedBytes = Buffer.alloc(
    api.MAX_OBSERVER_CIVILIZATION_HISTORY_SIDECAR_STORED_BYTES + 1,
  );
  const oversizedHash = api.hashObserverCivilizationHistoryStoredContent(
    api.OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC,
    oversizedBytes,
  );
  assert.throws(
    () => api.decodeObserverCivilizationHistorySidecar({
      hash: oversizedHash,
      codec: api.OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC,
      rawSize: oversizedBytes.byteLength,
      data: oversizedBytes,
    }, {
      reference: {
        kind: 'content-hash',
        codec: api.OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC,
        hash: oversizedHash,
      },
      boundary,
    }),
    /超过硬上限/u,
  );

  const callerOwnedChunk = cloneChunk(encoded.chunk);
  const snapshot = api.snapshotObserverCivilizationHistorySidecarChunk(callerOwnedChunk);
  callerOwnedChunk.data.fill(0);
  assert.deepEqual(snapshot.data, originalBytes);
  const snapshotBytes = snapshot.data;
  snapshotBytes.fill(0);
  assert.deepEqual(snapshot.data, originalBytes);

  const memoryUsage = process.memoryUsage();
  assert.ok(memoryUsage.rss < 256 * 1024 * 1024, 'civilization codec fixture RSS 不得超过 256 MiB');
  console.log(JSON.stringify({
    result: 'passed',
    eventCount: target.eventCount,
    milestoneDefinitionsCovered: projection.completeMilestoneDefinitionIds.length,
    storedBytes: encoded.chunk.rawSize,
    rssBytes: memoryUsage.rss,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
