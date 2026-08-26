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
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-gameplay-shell-stream-'));
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

function rootAndManifest(codec, manifest, schemaVersion = 3) {
  const manifestChunk = storedChunk(codec.RUN_STATE_SHELL_MANIFEST_CODEC, serialize(manifest));
  const metadata = {
    schemaVersion,
    shellHash: manifestChunk.hash,
    historyHeadHash: null,
    lineageId: '00000000-0000-4000-8000-000000003032',
    eventCount: 0,
    tailEventContentHash: null,
  };
  return {
    manifestChunk,
    metadata,
    root: storedChunk(codec.RUN_STATE_ROOT_CODEC, serialize(metadata)),
  };
}

function chunkReader(chunks, replacements = new Map()) {
  return (hash) => {
    if (replacements.has(hash)) return replacements.get(hash);
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
  const addArray = (values) => {
    const chunk = addValue(values);
    return { hash: chunk.hash, itemCount: values.length };
  };

  const metaChunk = addValue({ fixture: 'gameplay-shell-stream', revision: 606 });
  const gridChunk = addValue({ width: 64, depth: 64 });
  const intentsSegment = addArray([
    { id: 'intent-1', status: 'completed' },
    { id: 'intent-2', status: 'blocked' },
    { id: 'intent-3', status: 'active' },
  ]);
  const tilesSegment = addArray([{ x: 0, z: 0 }, { x: 1, z: 0 }]);

  // This block has a correct codec-scoped hash and byte length, but is not a
  // Brotli stream. Gameplay continuation must verify and carry it opaquely.
  const poisonDerived = addChunk(storedChunk(
    codec.RUN_STATE_SHELL_PART_CODEC,
    Buffer.from('not-a-brotli-or-v8-derived-body'),
  ));
  const manifest = {
    schemaVersion: 1,
    fields: [
      { name: 'meta', kind: 'value', hash: metaChunk.hash },
      { name: 'derived', kind: 'value', hash: poisonDerived.hash },
      { name: 'intents', kind: 'array', length: 3, segments: [intentsSegment] },
      { name: 'empty', kind: 'array', length: 0, segments: [] },
    ],
    worldFields: [
      { name: 'grid', kind: 'value', hash: gridChunk.hash },
      { name: 'tiles', kind: 'array', length: 2, segments: [tilesSegment] },
    ],
  };
  const exact = rootAndManifest(codec, manifest);
  addChunk(exact.manifestChunk);
  addChunk(exact.root);

  const fieldVisits = [];
  const valueVisits = [];
  const arrayVisits = [];
  const gameplayReceipt = await codec.streamVerifiedSchema3GameplayShell(
    exact.root,
    chunkReader(chunks),
    {
      visitField(position) {
        assert.equal(Object.isFrozen(position), true);
        fieldVisits.push(`${position.scope}:${position.fieldName}:${position.kind}`);
      },
      visitValue(value, position) {
        assert.equal(Object.isFrozen(position), true);
        valueVisits.push(`${position.scope}:${position.fieldName}`);
        if (position.fieldName === 'meta') assert.equal(value.revision, 606);
        if (position.fieldName === 'grid') assert.equal(value.width, 64);
      },
      visitArraySegment(items, position) {
        assert.equal(Object.isFrozen(items), true);
        assert.equal(Object.isFrozen(position), true);
        assert.equal(items.length, position.itemCount);
        arrayVisits.push(`${position.scope}:${position.fieldName}:${position.itemCount}`);
      },
    },
  );
  codec.assertVerifiedSchema3RunStateShellReceipt(gameplayReceipt, exact.root.hash);
  assert.equal(Object.isFrozen(gameplayReceipt), true);
  assert.deepEqual(fieldVisits, [
    'state:meta:value',
    'state:derived:value',
    'state:intents:array',
    'state:empty:array',
    'world:grid:value',
    'world:tiles:array',
  ]);
  assert.deepEqual(valueVisits, ['state:meta', 'world:grid'],
    'opaque state.derived must never reach visitValue');
  assert.deepEqual(arrayVisits, ['state:intents:3', 'world:tiles:2']);
  assert.equal(gameplayReceipt.valueFieldCount, 3);
  assert.equal(gameplayReceipt.arrayFieldCount, 3);
  assert.equal(gameplayReceipt.arraySegmentCount, 2);
  assert.equal(gameplayReceipt.arrayItemCount, 5);
  assert.equal(gameplayReceipt.opaqueObserverValueFieldCount, 1);
  assert.throws(
    () => codec.assertVerifiedSchema3RunStateShellReceipt(
      { ...gameplayReceipt },
      exact.root.hash,
    ),
    /未经过当前 exact root/u,
    'a structural receipt copy must not retain the module brand',
  );

  let poisonReachedGenericVisitor = false;
  await assert.rejects(
    () => codec.streamVerifiedSchema3RunStateShell(
      exact.root,
      chunkReader(chunks),
      { visitValue(_value, position) {
        if (position.fieldName === 'derived') poisonReachedGenericVisitor = true;
      } },
    ),
    /无法解压/u,
    'generic shell stream must attempt to decode the same poison body',
  );
  assert.equal(poisonReachedGenericVisitor, false);

  const validDerived = addValue({ milestones: [{ key: 'institutional-iron' }] });
  const validManifest = {
    ...manifest,
    fields: manifest.fields.map((field) => field.name === 'derived'
      ? { name: 'derived', kind: 'value', hash: validDerived.hash }
      : field),
  };
  const valid = rootAndManifest(codec, validManifest);
  addChunk(valid.manifestChunk);
  addChunk(valid.root);
  const genericValueVisits = [];
  const genericReceipt = await codec.streamVerifiedSchema3RunStateShell(
    valid.root,
    chunkReader(chunks),
    { visitValue(value, position) {
      genericValueVisits.push(position.fieldName);
      if (position.fieldName === 'derived') {
        assert.equal(value.milestones[0].key, 'institutional-iron');
      }
    } },
  );
  codec.assertVerifiedSchema3RunStateShellReceipt(genericReceipt, valid.root.hash);
  assert.deepEqual(genericValueVisits, ['meta', 'derived', 'grid']);
  assert.equal(genericReceipt.opaqueObserverValueFieldCount, 0);
  assert.equal(genericReceipt.valueFieldCount, 3);

  const corruptedBytes = Buffer.from(poisonDerived.data);
  corruptedBytes[0] ^= 0xff;
  const corruptionCases = [
    {
      label: 'bytes',
      chunk: { ...poisonDerived, data: corruptedBytes },
      error: /SHA-256/u,
    },
    {
      label: 'hash',
      chunk: { ...poisonDerived, hash: '0'.repeat(64) },
      error: /不属于请求引用/u,
    },
    {
      label: 'codec',
      chunk: { ...poisonDerived, codec: `${poisonDerived.codec}-corrupted` },
      error: /不支持的编码/u,
    },
    {
      label: 'length',
      chunk: { ...poisonDerived, rawSize: poisonDerived.rawSize + 1 },
      error: /长度与记录不一致/u,
    },
  ];
  for (const corruption of corruptionCases) {
    let failedReceipt;
    await assert.rejects(
      async () => {
        failedReceipt = await codec.streamVerifiedSchema3GameplayShell(
          exact.root,
          chunkReader(chunks, new Map([[poisonDerived.hash, corruption.chunk]])),
        );
      },
      corruption.error,
      `${corruption.label} corruption must fail closed`,
    );
    assert.equal(failedReceipt, undefined, `${corruption.label} corruption must mint no receipt`);
  }

  for (const schemaVersion of [1, 2]) {
    const legacy = rootAndManifest(codec, manifest, schemaVersion);
    let readCount = 0;
    await assert.rejects(
      () => codec.streamVerifiedSchema3GameplayShell(legacy.root, () => {
        readCount += 1;
        throw new Error('legacy root must fail before reading the shell');
      }),
      /只接受 schemaVersion 3/u,
    );
    assert.equal(readCount, 0);
  }

  const arrayDerivedManifest = {
    ...manifest,
    fields: manifest.fields.map((field) => field.name === 'derived'
      ? { name: 'derived', kind: 'array', length: 0, segments: [] }
      : field),
  };
  const arrayDerived = rootAndManifest(codec, arrayDerivedManifest);
  const arrayDerivedChunks = new Map(chunks);
  arrayDerivedChunks.set(arrayDerived.manifestChunk.hash, arrayDerived.manifestChunk);
  arrayDerivedChunks.set(arrayDerived.root.hash, arrayDerived.root);
  let malformedReceipt;
  await assert.rejects(
    async () => {
      malformedReceipt = await codec.streamVerifiedSchema3GameplayShell(
        arrayDerived.root,
        chunkReader(arrayDerivedChunks),
      );
    },
    /必须精确 opaque carry 一个 state\.derived value/u,
  );
  assert.equal(malformedReceipt, undefined);

  const maxRssBytes = process.resourceUsage().maxRSS * 1_024;
  assert.ok(maxRssBytes < 256 * 1_024 * 1_024,
    `gameplay shell fixture RSS ${maxRssBytes} must remain below 256 MiB`);
  console.log(JSON.stringify({
    ok: true,
    fields: fieldVisits.length,
    valueVisits,
    arrayVisits,
    opaqueObserverValueFieldCount: gameplayReceipt.opaqueObserverValueFieldCount,
    genericOpaqueObserverValueFieldCount: genericReceipt.opaqueObserverValueFieldCount,
    corruptionCases: corruptionCases.map(({ label }) => label),
    maxRssBytes,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
