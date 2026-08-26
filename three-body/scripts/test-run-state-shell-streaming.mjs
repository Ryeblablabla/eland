import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serialize } from 'node:v8';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-shell-stream-'));
const bundlePath = path.join(temporaryDirectory, 'run-state-codec.mjs');
const childEnvironment = { ...process.env, NODE_OPTIONS: '--max-old-space-size=256' };

function storedChunk(codec, data) {
  return Object.freeze({
    hash: createHash('sha256').update(codec).update('\0').update(data).digest('hex'),
    codec,
    rawSize: data.byteLength,
    data: Buffer.from(data),
  });
}

function compressedChunk(codec, value) {
  return storedChunk(codec, brotliCompressSync(serialize(value), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 1 },
  }));
}

function rootAndManifest(codec, manifest) {
  const manifestChunk = storedChunk(codec.RUN_STATE_SHELL_MANIFEST_CODEC, serialize(manifest));
  const metadata = {
    schemaVersion: 3,
    shellHash: manifestChunk.hash,
    historyHeadHash: null,
    lineageId: '00000000-0000-4000-8000-000000003031',
    eventCount: 0,
    tailEventContentHash: null,
  };
  const root = storedChunk(codec.RUN_STATE_ROOT_CODEC, serialize(metadata));
  return { root, manifestChunk, metadata };
}

function chunkReader(chunks, replacement) {
  return (hash) => {
    if (replacement?.has(hash)) return replacement.get(hash);
    const chunk = chunks.get(hash);
    if (!chunk) throw new Error(`fixture missing chunk ${hash}`);
    return chunk;
  };
}

try {
  execFileSync(path.join(workspace, 'node_modules/.bin/esbuild'), [
    path.join(workspace, 'server/run-state-codec.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { cwd: workspace, env: childEnvironment, stdio: 'pipe' });
  const codec = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  const chunks = new Map();
  const addChunk = (chunk) => {
    const existing = chunks.get(chunk.hash);
    if (existing) assert.deepEqual(existing.data, chunk.data, 'content hash collision');
    else chunks.set(chunk.hash, chunk);
    return chunk;
  };
  const addValue = (value) => addChunk(compressedChunk(codec.RUN_STATE_SHELL_PART_CODEC, value));
  const makeLargeArrayField = (name, segmentCount, payloadCharacter) => {
    const references = [];
    let logicalPayloadBytes = 0;
    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
      const start = segmentIndex * codec.MAX_SHELL_ARRAY_ITEMS_PER_SEGMENT;
      const values = Array.from(
        { length: codec.MAX_SHELL_ARRAY_ITEMS_PER_SEGMENT },
        (_, offset) => {
          const ordinal = start + offset;
          const prefix = `${name}:${ordinal}:`;
          const payload = prefix + payloadCharacter.repeat(512 - prefix.length);
          logicalPayloadBytes += Buffer.byteLength(payload);
          return { ordinal, payload };
        },
      );
      const chunk = addChunk(compressedChunk(codec.RUN_STATE_SHELL_PART_CODEC, values));
      references.push({ hash: chunk.hash, itemCount: values.length });
    }
    return {
      reference: {
        name,
        kind: 'array',
        length: segmentCount * codec.MAX_SHELL_ARRAY_ITEMS_PER_SEGMENT,
        segments: references,
      },
      logicalPayloadBytes,
    };
  };

  const metaChunk = addValue({ fixture: 'schema3-shell-stream', version: 1 });
  const gridChunk = addValue({ width: 64, depth: 64, levels: 16 });
  const alpha = makeLargeArrayField('alpha', 320, 'a');
  const beta = makeLargeArrayField('beta', 192, 'b');
  const dropSegments = [];
  for (let segmentIndex = 0; segmentIndex < 3; segmentIndex += 1) {
    const values = Array.from({ length: 64 }, (_, offset) => ({
      ordinal: segmentIndex * 64 + offset,
      kind: 'drop',
    }));
    const chunk = addChunk(compressedChunk(codec.RUN_STATE_SHELL_PART_CODEC, values));
    dropSegments.push({ hash: chunk.hash, itemCount: values.length });
  }
  const manifest = {
    schemaVersion: 1,
    fields: [
      { name: 'meta', kind: 'value', hash: metaChunk.hash },
      alpha.reference,
      { name: 'empty', kind: 'array', length: 0, segments: [] },
      beta.reference,
    ],
    worldFields: [
      { name: 'grid', kind: 'value', hash: gridChunk.hash },
      { name: 'drops', kind: 'array', length: 192, segments: dropSegments },
    ],
  };
  const exact = rootAndManifest(codec, manifest);
  addChunk(exact.manifestChunk);
  addChunk(exact.root);

  const fieldOrder = [];
  const nextOrdinalByField = new Map();
  let observedLogicalPayloadBytes = 0;
  let maxSegmentItems = 0;
  let arrayCallbackCount = 0;
  const receipt = await codec.streamVerifiedSchema3RunStateShell(
    exact.root,
    chunkReader(chunks),
    {
      visitField(position) {
        assert.equal(Object.isFrozen(position), true);
        fieldOrder.push(`${position.absoluteFieldIndex}:${position.scope}:${position.fieldName}:${position.kind}`);
        if (position.kind === 'array') {
          nextOrdinalByField.set(`${position.scope}:${position.fieldName}`, 0);
        }
      },
      visitValue(value, position) {
        assert.equal(Object.isFrozen(position), true);
        assert.equal(Array.isArray(value), false);
        if (position.fieldName === 'meta') assert.equal(value.fixture, 'schema3-shell-stream');
        if (position.fieldName === 'grid') assert.equal(value.levels, 16);
      },
      async visitArraySegment(items, position) {
        assert.equal(Object.isFrozen(position), true);
        assert.equal(Object.isFrozen(items), true);
        assert.equal(items.length, position.itemCount);
        assert.ok(items.length <= codec.MAX_SHELL_ARRAY_ITEMS_PER_SEGMENT);
        maxSegmentItems = Math.max(maxSegmentItems, items.length);
        arrayCallbackCount += 1;
        const key = `${position.scope}:${position.fieldName}`;
        const expectedStart = nextOrdinalByField.get(key);
        assert.equal(position.startItemIndex, expectedStart);
        for (let offset = 0; offset < items.length; offset += 1) {
          assert.equal(items[offset].ordinal, expectedStart + offset);
          if (typeof items[offset].payload === 'string') {
            observedLogicalPayloadBytes += Buffer.byteLength(items[offset].payload);
          }
        }
        nextOrdinalByField.set(key, expectedStart + items.length);
        if (arrayCallbackCount % 64 === 0) await new Promise(setImmediate);
      },
    },
  );
  codec.assertVerifiedSchema3RunStateShellReceipt(receipt, exact.root.hash);
  assert.deepEqual(fieldOrder, [
    '0:state:meta:value',
    '1:state:alpha:array',
    '2:state:empty:array',
    '3:state:beta:array',
    '4:world:grid:value',
    '5:world:drops:array',
  ]);
  assert.equal(receipt.manifestHash, exact.manifestChunk.hash);
  assert.equal(receipt.stateFieldCount, 4);
  assert.equal(receipt.worldFieldCount, 2);
  assert.equal(receipt.valueFieldCount, 2);
  assert.equal(receipt.arrayFieldCount, 4);
  assert.equal(receipt.arraySegmentCount, 515);
  assert.equal(receipt.arrayItemCount, alpha.reference.length + beta.reference.length + 192);
  assert.equal(maxSegmentItems, codec.MAX_SHELL_ARRAY_ITEMS_PER_SEGMENT);
  assert.equal(observedLogicalPayloadBytes, alpha.logicalPayloadBytes + beta.logicalPayloadBytes);
  assert.ok(observedLogicalPayloadBytes >= 16 * 1_024 * 1_024,
    'fixture logical arrays must be much larger than one decoded segment');
  assert.throws(
    () => codec.assertVerifiedSchema3RunStateShellReceipt({ ...receipt }, exact.root.hash),
    /未经过当前 exact root/u,
  );

  let schema2ReadCount = 0;
  const schema2Root = storedChunk(codec.RUN_STATE_ROOT_CODEC, serialize({
    ...exact.metadata,
    schemaVersion: 2,
  }));
  await assert.rejects(
    () => codec.streamVerifiedSchema3RunStateShell(schema2Root, () => {
      schema2ReadCount += 1;
      throw new Error('schema2 must fail before reading its shell');
    }),
    /只接受 schemaVersion 3/u,
  );
  assert.equal(schema2ReadCount, 0);

  const renamedManifest = {
    ...manifest,
    fields: manifest.fields.map((field, index) => index === 0
      ? { ...field, name: 'renamed-meta' }
      : field),
  };
  const renamedBytes = serialize(renamedManifest);
  const manifestHashForgery = {
    hash: exact.manifestChunk.hash,
    codec: codec.RUN_STATE_SHELL_MANIFEST_CODEC,
    rawSize: renamedBytes.byteLength,
    data: renamedBytes,
  };
  await assert.rejects(
    () => codec.streamVerifiedSchema3RunStateShell(
      exact.root,
      chunkReader(chunks, new Map([[exact.manifestChunk.hash, manifestHashForgery]])),
    ),
    /SHA-256/u,
  );

  const firstAlpha = alpha.reference.segments[0];
  const wrongCountManifest = {
    schemaVersion: 1,
    fields: [{
      name: 'wrong-count',
      kind: 'array',
      length: 63,
      segments: [{ hash: firstAlpha.hash, itemCount: 63 }],
    }],
    worldFields: [],
  };
  const wrongCount = rootAndManifest(codec, wrongCountManifest);
  const wrongCountChunks = new Map(chunks);
  wrongCountChunks.set(wrongCount.manifestChunk.hash, wrongCount.manifestChunk);
  wrongCountChunks.set(wrongCount.root.hash, wrongCount.root);
  await assert.rejects(
    () => codec.streamVerifiedSchema3RunStateShell(
      wrongCount.root,
      chunkReader(wrongCountChunks),
    ),
    /itemCount 与 manifest 不一致/u,
  );

  const lastBetaHash = beta.reference.segments.at(-1).hash;
  const originalLastBeta = chunks.get(lastBetaHash);
  const corruptedData = Buffer.from(originalLastBeta.data);
  corruptedData[0] ^= 0xff;
  const corruptedLastBeta = { ...originalLastBeta, data: corruptedData };
  let callbacksBeforeLateCorruption = 0;
  let corruptedReceipt;
  await assert.rejects(
    async () => {
      corruptedReceipt = await codec.streamVerifiedSchema3RunStateShell(
        exact.root,
        chunkReader(chunks, new Map([[lastBetaHash, corruptedLastBeta]])),
        { visitArraySegment() { callbacksBeforeLateCorruption += 1; } },
      );
    },
    /SHA-256/u,
  );
  assert.ok(callbacksBeforeLateCorruption > 0,
    'late corruption should demonstrate that callbacks are staging-only');
  assert.equal(corruptedReceipt, undefined, 'failed full stream must mint no receipt');

  const maxRssBytes = process.resourceUsage().maxRSS * 1_024;
  assert.ok(maxRssBytes < 256 * 1_024 * 1_024,
    `streaming fixture RSS ${maxRssBytes} must remain below 256 MiB`);
  console.log(JSON.stringify({
    ok: true,
    fields: receipt.stateFieldCount + receipt.worldFieldCount,
    arraySegments: receipt.arraySegmentCount,
    arrayItems: receipt.arrayItemCount,
    logicalPayloadBytes: observedLogicalPayloadBytes,
    maxSegmentItems,
    maxRssBytes,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
