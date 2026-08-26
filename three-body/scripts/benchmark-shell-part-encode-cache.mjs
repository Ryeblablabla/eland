import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const databasePath = path.resolve(
  process.argv[2] ?? 'data/terminal-mechanical-service-p0-v10-baseline/eland.sqlite3',
);
const runId = process.argv[3] ?? 'ms-p0-v10-baseline-0823-s20260815-y1000';
const sourceMonth = Number(process.argv[4] ?? 3816);
const targetMonth = Number(process.argv[5] ?? 3828);
if (!Number.isSafeInteger(sourceMonth)
  || !Number.isSafeInteger(targetMonth)
  || targetMonth <= sourceMonth) {
  throw new Error('source/target 月份无效');
}

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-shell-part-cache-v18-bench-'));
const codecBundlePath = path.join(temporaryDirectory, 'run-state-codec.mjs');
const database = new DatabaseSync(databasePath, { readOnly: true });

function progress(message) {
  process.stderr.write(`[v18] ${message}\n`);
}

function databaseChunk(hash) {
  const row = database.prepare(`
    SELECT hash, codec, raw_size, data FROM chunks WHERE hash = ?
  `).get(hash);
  if (!row) throw new Error(`缺少数据库 chunk ${hash}`);
  return {
    hash: String(row.hash),
    codec: String(row.codec),
    rawSize: Number(row.raw_size),
    data: row.data,
  };
}

function checkpointRoot(month) {
  const row = database.prepare(`
    SELECT state_hash
    FROM run_checkpoints
    WHERE run_id = ? AND month = ?
    ORDER BY revision DESC
    LIMIT 1
  `).get(runId, month);
  if (!row) throw new Error(`运行 ${runId} 缺少第 ${month} 月 checkpoint`);
  return databaseChunk(String(row.state_hash));
}

function memoryUsage() {
  const usage = process.memoryUsage();
  return Object.fromEntries(Object.entries(usage).map(([key, value]) => [key, Number(value)]));
}

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
  assert.equal(actual.parts.length, expected.parts.length, 'ordered chunk count');
  for (let index = 0; index < actual.parts.length; index += 1) {
    assertChunkExact(actual.parts[index], expected.parts[index], `ordered chunk ${index}`);
  }
}

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/run-state-codec.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${codecBundlePath}`,
  ], { stdio: 'pipe' });
  const codec = await import(`${pathToFileURL(codecBundlePath).href}?v=${Date.now()}`);
  const sourceRoot = checkpointRoot(sourceMonth);
  const targetRoot = checkpointRoot(targetMonth);
  const processStartMemory = memoryUsage();

  codec.configureRunStateShellPartEncodeCacheForTests({
    enabled: true,
    maxEntries: codec.DEFAULT_SHELL_PART_ENCODE_CACHE_MAX_ENTRIES,
    maxBytes: codec.DEFAULT_SHELL_PART_ENCODE_CACHE_MAX_BYTES,
    clear: true,
    resetStatistics: true,
  });
  let sourceDecoded = await codec.decodeSegmentedRunState(sourceRoot, databaseChunk);
  progress(`decoded cold source m${sourceMonth}`);
  globalThis.gc?.();
  const coldBeforeMemory = memoryUsage();
  let sourceSnapshot = await codec.encodeSegmentedRunState(
    sourceDecoded.state,
    { mode: 'append', previous: sourceDecoded.metadata },
  );
  const coldStats = codec.runStateShellPartEncodeCacheStatsForTests();
  const sourceMetadata = sourceSnapshot.metadata;
  const coldAfterMemory = memoryUsage();
  progress(`encoded cold source: ${coldStats.requests} refs, ${coldStats.brotliCalls} Brotli`);
  sourceDecoded = null;
  sourceSnapshot = null;
  globalThis.gc?.();
  const cacheResidentAfterSourceGc = memoryUsage();

  let targetDecoded = await codec.decodeSegmentedRunState(targetRoot, databaseChunk);
  progress(`decoded warm target m${targetMonth}`);
  globalThis.gc?.();
  const warmBeforeMemory = memoryUsage();
  codec.configureRunStateShellPartEncodeCacheForTests({ resetStatistics: true });
  let warmSnapshot = await codec.encodeSegmentedRunState(
    targetDecoded.state,
    { mode: 'append', previous: sourceMetadata },
  );
  const warmStats = codec.runStateShellPartEncodeCacheStatsForTests();
  const warmAfterMemory = memoryUsage();
  progress(`encoded warm target: ${warmStats.hits} hits, ${warmStats.brotliCalls} Brotli`);

  codec.configureRunStateShellPartEncodeCacheForTests({
    enabled: false,
    clear: true,
    resetStatistics: true,
  });
  globalThis.gc?.();
  const disabledBeforeMemory = memoryUsage();
  let disabledSnapshot = await codec.encodeSegmentedRunState(
    targetDecoded.state,
    { mode: 'append', previous: sourceMetadata },
  );
  const disabledStats = codec.runStateShellPartEncodeCacheStatsForTests();
  const disabledAfterMemory = memoryUsage();
  progress(`encoded disabled target: ${disabledStats.brotliCalls} Brotli`);

  assert.ok(warmStats.requests >= 1_500, '实态 shell part refs 必须至少1500');
  assert.equal(warmStats.hits + warmStats.misses, warmStats.requests);
  assert.equal(warmStats.misses, warmStats.brotliCalls);
  assert.equal(disabledStats.requests, warmStats.requests);
  assert.equal(disabledStats.hits, 0);
  assert.equal(disabledStats.brotliCalls, disabledStats.requests);
  assertSnapshotExact(warmSnapshot, disabledSnapshot);
  const wallReductionRate = 1
    - (warmStats.lastShellEncodeMilliseconds / disabledStats.lastShellEncodeMilliseconds);
  assert.ok(
    wallReductionRate >= 0.5,
    `暖 shell encode wall 仅下降 ${(wallReductionRate * 100).toFixed(2)}%，未达到50%门槛`,
  );
  assert.ok(warmStats.peakEntries <= warmStats.maxEntries);
  assert.ok(warmStats.peakBytes <= warmStats.maxBytes);

  const report = {
    schemaVersion: 1,
    result: 'accepted-performance-gate',
    database: databasePath,
    runId,
    sourceMonth,
    targetMonth,
    sourceRootHash: sourceRoot.hash,
    targetRootHash: targetRoot.hash,
    cold: coldStats,
    warm: warmStats,
    disabled: disabledStats,
    performance: {
      warmShellEncodeMilliseconds: warmStats.lastShellEncodeMilliseconds,
      disabledShellEncodeMilliseconds: disabledStats.lastShellEncodeMilliseconds,
      wallReductionRate,
      threshold: 0.5,
    },
    exactness: {
      orderedPartsManifestRoot: 'byte-for-byte',
      rootHash: warmSnapshot.root.hash,
      manifestHash: warmSnapshot.metadata.shellHash,
      orderedChunks: warmSnapshot.parts.length + 1,
    },
    memoryBytes: {
      processStart: processStartMemory,
      coldBefore: coldBeforeMemory,
      coldAfter: coldAfterMemory,
      cacheResidentAfterSourceGc,
      warmBefore: warmBeforeMemory,
      warmAfter: warmAfterMemory,
      disabledBefore: disabledBeforeMemory,
      disabledAfter: disabledAfterMemory,
      boundedCompressedCachePeak: warmStats.peakBytes,
      configuredCompressedCacheLimit: warmStats.maxBytes,
    },
  };

  targetDecoded = null;
  warmSnapshot = null;
  disabledSnapshot = null;
  console.log(JSON.stringify(report, null, 2));
} finally {
  database.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
