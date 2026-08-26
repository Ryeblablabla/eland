import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'eland-derived-observer-codec-'));

function base(id, atMonth, cell = 0) {
  return { id, atMonth, orderInMonth: 0, cellId: cell };
}

function action(id, atMonth, who, primitive, diff = {}, cell = 0) {
  return {
    ...base(id, atMonth, cell),
    kind: 'action',
    actionTick: 1,
    who,
    cause: 'intent',
    action: primitive,
    fromCellId: cell,
    toCellId: cell,
    fromZ: 1,
    toZ: 1,
    pathSegment: primitive.kind === 'move' ? [cell, primitive.toCellId] : [cell],
    status: 'completed',
    result: id,
    diff,
  };
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, canonicalJsonValue(value[key])]));
}

try {
  const entry = path.join(temporaryDirectory, 'entry.ts');
  await writeFile(entry, [
    `export * from ${JSON.stringify(path.join(workspace, 'server/observer-derived-history-codec.ts'))};`,
    `export * from ${JSON.stringify(path.join(workspace, 'server/observer-derived-history-projection.ts'))};`,
    `export { Material } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/material.ts'))};`,
  ].join('\n'));
  const output = path.join(temporaryDirectory, 'codec.mjs');
  await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm' });
  const api = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

  const events = [
    action('transfer', 0, 'carrier', {
      kind: 'transfer',
      materialId: api.Material.Food,
      quantity: 1,
      from: { kind: 'person', personId: 'carrier' },
      to: { kind: 'person', personId: 'builder' },
    }),
    action('granary-install', 0, 'builder', {
      kind: 'act', operation: 'combine', targets: [],
    }, {
      outputMaterialId: api.Material.Granary,
      position: { x: 4, y: 4, z: 1 },
    }),
    action('granary-use', 1, 'keeper', {
      kind: 'transfer',
      materialId: api.Material.Food,
      quantity: 1,
      from: { kind: 'person', personId: 'keeper' },
      to: { kind: 'container', containerId: 'container:4:4:1' },
    }),
    action('plant', 1, 'farmer', {
      kind: 'act', operation: 'combine', targets: [],
    }, {
      outputMaterialId: api.Material.CropSprout,
      position: { x: 1, y: 1, z: 1 },
    }),
    action('harvest', 2, 'farmer', {
      kind: 'act',
      operation: 'separate',
      targets: [{ kind: 'voxel', position: { x: 1, y: 1, z: 1 } }],
    }, { sourceMaterialId: api.Material.CropMature }),
  ];
  const sourceDemand = {
    settledCultivationProjects: [{
      projectId: 'cultivation-project',
      completedAtMonth: 2,
      siteCellIds: [85],
      actionEventIds: ['harvest', 'plant'],
      completionEventIds: ['plant', 'harvest'],
    }],
    residentialStructures: [{
      structureId: 'granary-home',
      sourceEventIds: ['missing', 'granary-install'],
    }],
    retainedEventIds: ['transfer'],
    futureEventIds: ['granary-install', 'harvest', 'missing', 'plant'],
  };
  const target = {
    stateHash: 'a'.repeat(64),
    eventCount: events.length,
    tailEventId: events.at(-1).id,
  };
  const projection = api.projectObserverDerivedHistoryFromFullHistory(
    events,
    target,
    sourceDemand,
  );
  const encoded = api.encodeObserverDerivedHistorySidecar({ sourceDemand, projection });
  const expected = { reference: encoded.reference, boundary: { target } };
  const decoded = api.decodeObserverDerivedHistorySidecar(encoded.chunk, expected);

  assert.deepEqual(decoded.projection, projection);
  assert.deepEqual(decoded.sourceDemand, sourceDemand);
  assert.equal(decoded.projection.continuationReady, false);
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.projection.practices.transfer.evidence[0]));

  const originalBytes = Buffer.from(encoded.chunk.data);
  const exposedCopy = encoded.chunk.data;
  exposedCopy[0] ^= 0xff;
  assert.deepEqual(Buffer.from(encoded.chunk.data), originalBytes, 'chunk getter 必须返回 owned copy');
  const snapshot = api.snapshotObserverDerivedHistorySidecarChunk(encoded.chunk);
  const snapshotCopy = snapshot.data;
  snapshotCopy[0] ^= 0xff;
  assert.deepEqual(Buffer.from(snapshot.data), originalBytes, 'snapshot 也必须拥有独立 bytes');

  function selectedChunkFor(sidecar, bytes = null) {
    const data = bytes ?? Buffer.from(JSON.stringify(canonicalJsonValue(sidecar)), 'utf8');
    const hash = api.hashObserverDerivedHistoryStoredContent(
      api.OBSERVER_DERIVED_HISTORY_SIDECAR_CODEC,
      data,
    );
    return {
      chunk: {
        hash,
        codec: api.OBSERVER_DERIVED_HISTORY_SIDECAR_CODEC,
        rawSize: data.byteLength,
        data,
      },
      expected: {
        reference: {
          kind: 'content-hash',
          codec: api.OBSERVER_DERIVED_HISTORY_SIDECAR_CODEC,
          hash,
        },
        boundary: { target },
      },
    };
  }

  const forged = JSON.parse(originalBytes.toString('utf8'));
  forged.projection.practices.transfer.count += 1;
  const forgedCandidate = selectedChunkFor(forged);
  assert.throws(
    () => api.decodeObserverDerivedHistorySidecar(forgedCandidate.chunk, expected),
    /store-selected content reference/u,
    '调用者能重算 digest 也不能替换 store-selected reference',
  );

  const wrongDemand = JSON.parse(originalBytes.toString('utf8'));
  wrongDemand.sourceDemand.retainedEventIds[0] = 'forged-retained-id';
  const wrongDemandCandidate = selectedChunkFor(wrongDemand);
  assert.throws(
    () => api.decodeObserverDerivedHistorySidecar(
      wrongDemandCandidate.chunk,
      wrongDemandCandidate.expected,
    ),
    /demandFingerprint/u,
  );

  const ready = JSON.parse(originalBytes.toString('utf8'));
  ready.projection.continuationReady = true;
  const readyCandidate = selectedChunkFor(ready);
  assert.throws(
    () => api.decodeObserverDerivedHistorySidecar(readyCandidate.chunk, readyCandidate.expected),
    /continuationReady/u,
  );

  const badEvidence = JSON.parse(originalBytes.toString('utf8'));
  badEvidence.projection.practices.transfer.evidence[0].absoluteIndex = target.eventCount;
  const badEvidenceCandidate = selectedChunkFor(badEvidence);
  assert.throws(
    () => api.decodeObserverDerivedHistorySidecar(
      badEvidenceCandidate.chunk,
      badEvidenceCandidate.expected,
    ),
    /absoluteIndex/u,
  );

  const unknownField = JSON.parse(originalBytes.toString('utf8'));
  unknownField.unexpected = true;
  const unknownFieldCandidate = selectedChunkFor(unknownField);
  assert.throws(
    () => api.decodeObserverDerivedHistorySidecar(
      unknownFieldCandidate.chunk,
      unknownFieldCandidate.expected,
    ),
    /字段集合/u,
  );

  const prettyBytes = Buffer.from(JSON.stringify(JSON.parse(originalBytes.toString('utf8')), null, 2), 'utf8');
  const nonCanonical = selectedChunkFor(null, prettyBytes);
  assert.throws(
    () => api.decodeObserverDerivedHistorySidecar(nonCanonical.chunk, nonCanonical.expected),
    /canonical UTF-8 JSON/u,
  );

  assert.throws(
    () => api.decodeObserverDerivedHistorySidecar(encoded.chunk, {
      reference: encoded.reference,
      boundary: { target: { ...target, stateHash: 'b'.repeat(64) } },
    }),
    /exact target/u,
  );
  assert.throws(
    () => api.snapshotObserverDerivedHistorySidecarChunk({
      hash: 'c'.repeat(64),
      codec: api.OBSERVER_DERIVED_HISTORY_SIDECAR_CODEC,
      rawSize: api.MAX_OBSERVER_DERIVED_HISTORY_SIDECAR_STORED_BYTES + 1,
      data: Buffer.alloc(1),
    }),
    /硬上限/u,
  );

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1_024 * 1_024, 'codec fixture RSS 不得超过 256 MiB');
  console.log(JSON.stringify({
    result: 'passed',
    codec: encoded.reference.codec,
    eventCount: target.eventCount,
    rawSize: encoded.chunk.rawSize,
    rssBytes,
    continuationReady: decoded.projection.continuationReady,
  }, null, 2));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
