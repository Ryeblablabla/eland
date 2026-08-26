import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serialize } from 'node:v8';
import { brotliCompressSync } from 'node:zlib';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-shell-part-cache-v18-'));
const codecBundlePath = path.join(temporaryDirectory, 'run-state-codec.mjs');
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');

function chunkBytes(chunk) {
  return Buffer.isBuffer(chunk.data)
    ? chunk.data
    : Buffer.from(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
}

function assertChunkExact(actual, expected, label) {
  assert.equal(actual.hash, expected.hash, `${label} hash`);
  assert.equal(actual.codec, expected.codec, `${label} codec`);
  assert.equal(actual.rawSize, expected.rawSize, `${label} rawSize`);
  assert.deepEqual(chunkBytes(actual), chunkBytes(expected), `${label} bytes`);
}

function assertSnapshotExact(actual, expected) {
  assertChunkExact(actual.root, expected.root, 'root');
  assert.deepEqual(actual.metadata, expected.metadata, 'root metadata');
  assert.equal(actual.parts.length, expected.parts.length, 'ordered part count');
  for (let index = 0; index < actual.parts.length; index += 1) {
    assertChunkExact(actual.parts[index], expected.parts[index], `ordered part ${index}`);
  }
}

function chunkMap(...snapshots) {
  return new Map(snapshots.flatMap((snapshot) => [snapshot.root, ...snapshot.parts])
    .map((chunk) => [chunk.hash, chunk]));
}

function storedChunk(codec, data) {
  return {
    hash: createHash('sha256').update(codec).update('\0').update(data).digest('hex'),
    codec,
    rawSize: data.byteLength,
    data,
  };
}

function manifestPartHashes(codec, snapshot) {
  const manifestChunk = snapshot.parts.find((part) => part.hash === snapshot.metadata.shellHash);
  assert.ok(manifestChunk, 'snapshot 必须包含 shell manifest');
  const manifest = codec.parseRunStateShellManifest(manifestChunk);
  const hashes = [];
  for (const field of [...manifest.fields, ...manifest.worldFields]) {
    if (field.kind === 'value') hashes.push(field.hash);
    else hashes.push(...field.segments.map((segment) => segment.hash));
  }
  return { manifest, hashes };
}

try {
  const esbuild = path.resolve('node_modules/.bin/esbuild');
  execFileSync(esbuild, [
    'server/run-state-codec.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${codecBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(esbuild, [
    'src/game/eland/simulation.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${simulationBundlePath}`,
  ], { stdio: 'pipe' });

  const codec = await import(`${pathToFileURL(codecBundlePath).href}?v=${Date.now()}`);
  const simulation = await import(`${pathToFileURL(simulationBundlePath).href}?v=${Date.now()}`);
  const state = simulation.createInitialState(18_018, {
    endpoint: { kind: 'months', value: 3_000 },
  });

  codec.configureRunStateShellPartEncodeCacheForTests({
    enabled: true,
    maxEntries: codec.DEFAULT_SHELL_PART_ENCODE_CACHE_MAX_ENTRIES,
    maxBytes: codec.DEFAULT_SHELL_PART_ENCODE_CACHE_MAX_BYTES,
    clear: true,
    resetStatistics: true,
  });
  const cold = await codec.encodeSegmentedRunState(state);
  const coldStats = codec.runStateShellPartEncodeCacheStatsForTests();
  const coldParts = manifestPartHashes(codec, cold);
  assert.equal(coldStats.requests, coldParts.hashes.length, '每个 shell part 必须查询一次 cache');
  assert.equal(coldStats.misses, coldStats.brotliCalls, '只有 miss 才能调用 Brotli');
  assert.equal(coldStats.hits + coldStats.misses, coldStats.requests);

  codec.configureRunStateShellPartEncodeCacheForTests({ resetStatistics: true });
  const warm = await codec.encodeSegmentedRunState(
    state,
    { mode: 'append', previous: cold.metadata },
  );
  const warmStats = codec.runStateShellPartEncodeCacheStatsForTests();
  assert.equal(warmStats.requests, coldParts.hashes.length);
  assert.equal(warmStats.hits, warmStats.requests, '相同状态暖 encode 必须全部命中');
  assert.equal(warmStats.misses, 0);
  assert.equal(warmStats.brotliCalls, 0, '暖 encode 不得调用 Brotli');

  codec.configureRunStateShellPartEncodeCacheForTests({
    enabled: false,
    clear: true,
    resetStatistics: true,
  });
  const disabled = await codec.encodeSegmentedRunState(
    state,
    { mode: 'append', previous: cold.metadata },
  );
  const disabledStats = codec.runStateShellPartEncodeCacheStatsForTests();
  assert.equal(disabledStats.requests, warmStats.requests);
  assert.equal(disabledStats.hits, 0);
  assert.equal(disabledStats.misses, disabledStats.requests);
  assert.equal(disabledStats.brotliCalls, disabledStats.requests);
  assertSnapshotExact(warm, disabled);

  const generated = chunkMap(cold, warm);
  const decoded = await codec.decodeSegmentedRunState(
    warm.root,
    (hash) => {
      const part = generated.get(hash);
      if (!part) throw new Error(`缺少测试 chunk ${hash}`);
      return part;
    },
  );
  assert.deepEqual(decoded.state, state, 'cache encode 后必须完整 decode deepStrictEqual');
  const manifestReachability = codec.markReachableRunStateChunks(
    warm.root,
    (hash) => {
      const part = generated.get(hash);
      if (!part) throw new Error(`缺少 reachability 测试 chunk ${hash}`);
      return part;
    },
  );
  assert.ok(manifestReachability.chunks.has(warm.metadata.shellHash));
  for (const hash of coldParts.hashes) assert.ok(manifestReachability.chunks.has(hash));

  const oldState = structuredClone(state);
  oldState.world.past = [];
  oldState.lastStep = [];
  const { past: _past, ...oldWorld } = oldState.world;
  const oldShell = { ...oldState, world: oldWorld };
  const oldShellChunk = storedChunk(
    codec.RUN_STATE_SHELL_CODEC,
    brotliCompressSync(serialize(oldShell)),
  );
  const oldMetadata = {
    schemaVersion: 2,
    shellHash: oldShellChunk.hash,
    historyHeadHash: null,
    lineageId: '00000000-0000-4000-8000-000000000018',
    eventCount: 0,
    tailEventContentHash: null,
  };
  const oldRootChunk = storedChunk(codec.RUN_STATE_ROOT_CODEC, serialize(oldMetadata));
  const oldChunks = new Map([
    [oldRootChunk.hash, oldRootChunk],
    [oldShellChunk.hash, oldShellChunk],
  ]);
  const oldDecoded = await codec.decodeSegmentedRunState(
    oldRootChunk,
    (hash) => {
      const part = oldChunks.get(hash);
      if (!part) throw new Error(`缺少 old-codec 测试 chunk ${hash}`);
      return part;
    },
  );
  assert.deepEqual(oldDecoded.state, oldState, '旧 shell/root codec 必须继续 deepStrictEqual');
  assert.deepEqual(
    codec.markReachableRunStateChunks(oldRootChunk, (hash) => oldChunks.get(hash)).chunks,
    new Set([oldRootChunk.hash, oldShellChunk.hash]),
    '旧 shell/root reachability 必须保持兼容',
  );

  codec.configureRunStateShellPartEncodeCacheForTests({
    enabled: true,
    maxEntries: codec.DEFAULT_SHELL_PART_ENCODE_CACHE_MAX_ENTRIES,
    maxBytes: codec.DEFAULT_SHELL_PART_ENCODE_CACHE_MAX_BYTES,
    clear: true,
    resetStatistics: true,
  });
  const beforeMutation = await codec.encodeSegmentedRunState(
    state,
    { mode: 'append', previous: cold.metadata },
  );
  const beforePeople = manifestPartHashes(codec, beforeMutation).manifest.fields
    .find((field) => field.name === 'people');
  assert.equal(beforePeople?.kind, 'array');
  const originalHealth = state.people[0].body.health;
  state.people[0].body.health = originalHealth - 1;
  codec.configureRunStateShellPartEncodeCacheForTests({ resetStatistics: true });
  const afterMutation = await codec.encodeSegmentedRunState(
    state,
    { mode: 'append', previous: cold.metadata },
  );
  const mutationStats = codec.runStateShellPartEncodeCacheStatsForTests();
  const afterPeople = manifestPartHashes(codec, afterMutation).manifest.fields
    .find((field) => field.name === 'people');
  assert.equal(afterPeople?.kind, 'array');
  assert.notDeepEqual(
    afterPeople.segments.map((segment) => segment.hash),
    beforePeople.segments.map((segment) => segment.hash),
    '同一 people 对象原地变异后不得误命中旧 part',
  );
  assert.ok(mutationStats.misses >= 1 && mutationStats.brotliCalls >= 1);
  assert.ok(mutationStats.hits >= 1, '未变 part 应继续复用');
  assert.notEqual(afterMutation.metadata.shellHash, beforeMutation.metadata.shellHash);
  state.people[0].body.health = originalHealth;

  codec.configureRunStateShellPartEncodeCacheForTests({
    enabled: true,
    maxEntries: 2,
    maxBytes: codec.DEFAULT_SHELL_PART_ENCODE_CACHE_MAX_BYTES,
    clear: true,
    resetStatistics: true,
  });
  await codec.encodeSegmentedRunState(state, { mode: 'append', previous: cold.metadata });
  const entryEvictionStats = codec.runStateShellPartEncodeCacheStatsForTests();
  assert.ok(entryEvictionStats.evictions > 0, '超过 entry 上限必须逐出');
  assert.ok(entryEvictionStats.entries <= 2 && entryEvictionStats.peakEntries <= 2);
  assert.ok(entryEvictionStats.bytes <= entryEvictionStats.maxBytes);

  codec.configureRunStateShellPartEncodeCacheForTests({
    maxEntries: codec.DEFAULT_SHELL_PART_ENCODE_CACHE_MAX_ENTRIES,
    maxBytes: 1,
    clear: true,
    resetStatistics: true,
  });
  await codec.encodeSegmentedRunState(state, { mode: 'append', previous: cold.metadata });
  const byteBoundStats = codec.runStateShellPartEncodeCacheStatsForTests();
  assert.equal(byteBoundStats.entries, 0);
  assert.equal(byteBoundStats.bytes, 0);
  assert.equal(byteBoundStats.skippedOversize, byteBoundStats.requests);

  const domainValue = { same: ['raw', 1, true] };
  const shellDomainKey = codec.runStateRawV8CacheKeyForTests(
    codec.RUN_STATE_SHELL_PART_CODEC,
    domainValue,
  );
  assert.equal(
    shellDomainKey,
    codec.runStateRawV8CacheKeyForTests(codec.RUN_STATE_SHELL_PART_CODEC, domainValue),
  );
  assert.notEqual(
    shellDomainKey,
    codec.runStateRawV8CacheKeyForTests(codec.RUN_STATE_EVENT_SEGMENT_CODEC, domainValue),
    '相同 raw value 必须按 codec 域隔离',
  );

  console.log(JSON.stringify({
    result: 'passed',
    partReferences: coldParts.hashes.length,
    cold: coldStats,
    warm: warmStats,
    disabled: disabledStats,
    mutation: mutationStats,
    entryEviction: entryEvictionStats,
    byteBound: byteBoundStats,
    byteExact: {
      rootHash: warm.root.hash,
      manifestHash: warm.metadata.shellHash,
      orderedChunks: warm.parts.length + 1,
    },
    codecDomainSeparated: true,
    decodedState: 'deepStrictEqual',
    oldCodecDecode: 'deepStrictEqual',
    manifestAndOldCodecReachability: 'exact',
  }, null, 2));
} finally {
  // Bundled module lifetime ends with this process; restore documents the
  // expected authoritative defaults for anyone importing this script.
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
