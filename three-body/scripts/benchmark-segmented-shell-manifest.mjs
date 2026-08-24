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
const frozenSourceDirectory = path.resolve(
  process.argv[6]
    ?? 'data/frozen-source-mechanical-service-p0-v10-baseline-20260823/three-body',
);
if (!Number.isSafeInteger(sourceMonth)
  || !Number.isSafeInteger(targetMonth)
  || targetMonth <= sourceMonth) {
  throw new Error('source/target 月份无效');
}

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-shell-manifest-v15-'));
const currentCodecBundle = path.join(temporaryDirectory, 'current-codec.mjs');
const legacyCodecBundle = path.join(temporaryDirectory, 'legacy-codec.mjs');
const simulationBundle = path.join(temporaryDirectory, 'simulation-runtime.mjs');
const database = new DatabaseSync(databasePath, { readOnly: true });

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

function elapsed(startedAt) {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function progress(label) {
  process.stderr.write(`[v15] ${label}\n`);
}

function uniqueSnapshotChunks(snapshot) {
  return new Map([snapshot.root, ...snapshot.parts].map((chunk) => [chunk.hash, chunk]));
}

function referencesByField(codec, snapshot) {
  const manifest = codec.parseRunStateShellManifest(
    snapshot.parts.find((chunk) => chunk.hash === snapshot.metadata.shellHash),
  );
  return new Map([...manifest.fields.map((field) => [field.name, field]),
    ...manifest.worldFields.map((field) => [`world.${field.name}`, field])]);
}

function hashesForField(field) {
  if (!field) return [];
  return field.kind === 'value'
    ? [field.hash]
    : field.segments.map((segment) => segment.hash);
}

function fieldReuse(codec, sourceSnapshot, targetSnapshot) {
  const source = referencesByField(codec, sourceSnapshot);
  const target = referencesByField(codec, targetSnapshot);
  const result = {};
  for (const [name, targetField] of target) {
    const sourceHashes = new Set(hashesForField(source.get(name)));
    const targetHashes = hashesForField(targetField);
    result[name] = {
      kind: targetField.kind,
      targetBlocks: targetHashes.length,
      reusedBlocks: targetHashes.filter((hash) => sourceHashes.has(hash)).length,
      ...(targetField.kind === 'array' ? { targetItems: targetField.length } : {}),
    };
  }
  return result;
}

function sumChunkBytes(hashes, readChunk) {
  return [...hashes].reduce((sum, hash) => sum + readChunk(hash).rawSize, 0);
}

try {
  const esbuild = path.resolve('node_modules/.bin/esbuild');
  execFileSync(esbuild, [
    'server/run-state-codec.ts', '--bundle', '--platform=node', '--format=esm',
    `--outfile=${currentCodecBundle}`,
  ], { stdio: 'pipe' });
  execFileSync(esbuild, [
    path.join(frozenSourceDirectory, 'server/run-state-codec.ts'),
    '--bundle', '--platform=node', '--format=esm', `--outfile=${legacyCodecBundle}`,
  ], { stdio: 'pipe' });
  execFileSync(esbuild, [
    path.join(frozenSourceDirectory, 'src/game/eland/application/simulation/controller.ts'),
    '--bundle', '--platform=node', '--format=esm', `--outfile=${simulationBundle}`,
  ], { stdio: 'pipe' });

  const [codec, legacyCodec, simulation] = await Promise.all([
    import(`${pathToFileURL(currentCodecBundle).href}?v=${Date.now()}`),
    import(`${pathToFileURL(legacyCodecBundle).href}?v=${Date.now()}`),
    import(`${pathToFileURL(simulationBundle).href}?v=${Date.now()}`),
  ]);
  const sourceRoot = checkpointRoot(sourceMonth);
  const targetRoot = checkpointRoot(targetMonth);

  const decodeTimings = {};
  let startedAt = performance.now();
  let legacySource = await legacyCodec.decodeSegmentedRunState(sourceRoot, databaseChunk);
  decodeTimings.legacySourceMs = elapsed(startedAt);
  progress('legacy source decoded');
  startedAt = performance.now();
  let currentSourceLegacy = await codec.decodeSegmentedRunState(sourceRoot, databaseChunk);
  decodeTimings.currentSourceLegacyMs = elapsed(startedAt);
  assert.deepEqual(currentSourceLegacy.state, legacySource.state);
  progress('current legacy-source decode exact');
  currentSourceLegacy = null;
  globalThis.gc?.();
  const sourceEventCount = legacySource.state.world.past.length;
  const seed = legacySource.state.seed;
  const legacySourceShellHash = legacySource.metadata.shellHash;
  startedAt = performance.now();
  const sourceSnapshot = await codec.encodeSegmentedRunState(
    legacySource.state,
    { mode: 'append', previous: legacySource.metadata },
  );
  const sourceEncodeMs = elapsed(startedAt);
  progress('source manifest encoded');
  const generatedChunks = uniqueSnapshotChunks(sourceSnapshot);
  const readGeneratedOrDatabase = (hash) => generatedChunks.get(hash) ?? databaseChunk(hash);
  startedAt = performance.now();
  let segmentedSource = await codec.decodeSegmentedRunState(
    sourceSnapshot.root,
    readGeneratedOrDatabase,
  );
  const sourceDecodeMs = elapsed(startedAt);
  assert.deepEqual(segmentedSource.state, legacySource.state);
  progress('source manifest decode exact');
  legacySource = null;
  globalThis.gc?.();

  startedAt = performance.now();
  let legacyTarget = await legacyCodec.decodeSegmentedRunState(targetRoot, databaseChunk);
  decodeTimings.legacyTargetMs = elapsed(startedAt);
  progress('legacy target decoded');
  startedAt = performance.now();
  let currentTargetLegacy = await codec.decodeSegmentedRunState(targetRoot, databaseChunk);
  decodeTimings.currentTargetLegacyMs = elapsed(startedAt);
  assert.deepEqual(currentTargetLegacy.state, legacyTarget.state);
  progress('current legacy-target decode exact');
  currentTargetLegacy = null;
  globalThis.gc?.();
  const legacyTargetShellHash = legacyTarget.metadata.shellHash;
  const targetEventCount = legacyTarget.state.world.past.length;
  startedAt = performance.now();
  const targetSnapshot = await codec.encodeSegmentedRunState(
    legacyTarget.state,
    { mode: 'append', previous: sourceSnapshot.metadata },
  );
  const targetEncodeMs = elapsed(startedAt);
  progress('target manifest encoded');
  for (const [hash, chunk] of uniqueSnapshotChunks(targetSnapshot)) generatedChunks.set(hash, chunk);

  let replayed = segmentedSource.state;
  segmentedSource = null;
  startedAt = performance.now();
  replayed = simulation.createSimulationFromOwnedState(replayed)
    .stepOwned(targetMonth - sourceMonth);
  const replayMs = elapsed(startedAt);
  assert.deepEqual(replayed, legacyTarget.state);
  assert.deepEqual(
    replayed.world.past.slice(sourceEventCount),
    legacyTarget.state.world.past.slice(sourceEventCount),
  );
  progress('12-month full state and ordered suffix exact');
  replayed = null;
  globalThis.gc?.();

  startedAt = performance.now();
  let segmentedTarget = await codec.decodeSegmentedRunState(
    targetSnapshot.root,
    readGeneratedOrDatabase,
  );
  const targetDecodeMs = elapsed(startedAt);
  assert.deepEqual(segmentedTarget.state, legacyTarget.state);
  assert.ok(segmentedTarget.state.lastStep.every((event) => (
    segmentedTarget.state.world.past.find((candidate) => candidate.id === event.id) === event
  )), 'lastStep 必须重连至 world.past 的相同事件对象');
  progress('target manifest decode exact');
  segmentedTarget = null;
  legacyTarget = null;
  globalThis.gc?.();

  const sourceReachability = codec.markReachableRunStateChunks(
    sourceSnapshot.root,
    readGeneratedOrDatabase,
  ).chunks;
  const targetReachability = codec.markReachableRunStateChunks(
    targetSnapshot.root,
    readGeneratedOrDatabase,
  ).chunks;
  const legacySourceReachability = codec.markReachableRunStateChunks(
    sourceRoot,
    databaseChunk,
  ).chunks;
  const legacyTargetReachability = codec.markReachableRunStateChunks(
    targetRoot,
    databaseChunk,
  ).chunks;
  const union = (left, right) => new Set([...left, ...right]);
  const difference = (left, right) => new Set([...left].filter((hash) => !right.has(hash)));

  const sourceFields = referencesByField(codec, sourceSnapshot);
  const targetFields = referencesByField(codec, targetSnapshot);
  const sourceShellHashes = new Set([
    sourceSnapshot.root.hash,
    sourceSnapshot.metadata.shellHash,
    ...[...sourceFields.values()].flatMap(hashesForField),
  ]);
  const targetShellHashes = new Set([
    targetSnapshot.root.hash,
    targetSnapshot.metadata.shellHash,
    ...[...targetFields.values()].flatMap(hashesForField),
  ]);
  const targetPartReferences = [...targetFields.values()].flatMap(hashesForField);
  const sourcePartHashes = new Set([...sourceFields.values()].flatMap(hashesForField));
  const reusedPartReferences = targetPartReferences.filter((hash) => sourcePartHashes.has(hash));

  const report = {
    schemaVersion: 1,
    runId,
    seed,
    sourceMonth,
    targetMonth,
    exactness: {
      legacyVsCurrentSource: 'deepStrictEqual',
      legacyVsCurrentTarget: 'deepStrictEqual',
      legacyVsManifestSource: 'deepStrictEqual',
      legacyVsManifestTarget: 'deepStrictEqual',
      replayFullState: 'deepStrictEqual',
      replayOrderedSuffix: 'deepStrictEqual',
      replaySuffixEvents: targetEventCount - sourceEventCount,
      lastStepObjectIdentity: 'exact',
    },
    timingsMs: {
      ...decodeTimings,
      manifestSourceEncode: sourceEncodeMs,
      manifestSourceDecode: sourceDecodeMs,
      manifestTargetEncode: targetEncodeMs,
      manifestTargetDecode: targetDecodeMs,
      replay12Months: replayMs,
    },
    reuse: {
      targetPartReferences: targetPartReferences.length,
      reusedPartReferences: reusedPartReferences.length,
      reusedPartReferenceRate: targetPartReferences.length === 0
        ? 0
        : reusedPartReferences.length / targetPartReferences.length,
      targetUniquePartChunks: new Set(targetPartReferences).size,
      reusedUniquePartChunks: new Set(reusedPartReferences).size,
      byField: fieldReuse(codec, sourceSnapshot, targetSnapshot),
    },
    bytes: {
      legacySourceShell: databaseChunk(legacySourceShellHash).rawSize,
      legacyTargetShell: databaseChunk(legacyTargetShellHash).rawSize,
      manifestSourceShellAndRoot: sumChunkBytes(sourceShellHashes, readGeneratedOrDatabase),
      manifestTargetShellAndRoot: sumChunkBytes(targetShellHashes, readGeneratedOrDatabase),
      manifestTargetIncrementalShellAndRoot: sumChunkBytes(
        difference(targetShellHashes, sourceShellHashes),
        readGeneratedOrDatabase,
      ),
      legacyTargetIncrementalReachable: sumChunkBytes(
        difference(legacyTargetReachability, legacySourceReachability),
        databaseChunk,
      ),
      manifestTargetIncrementalReachable: sumChunkBytes(
        difference(targetReachability, sourceReachability),
        readGeneratedOrDatabase,
      ),
      legacyTwoCheckpointProjectedUnique: sumChunkBytes(
        union(legacySourceReachability, legacyTargetReachability),
        databaseChunk,
      ),
      manifestTwoCheckpointProjectedUnique: sumChunkBytes(
        union(sourceReachability, targetReachability),
        readGeneratedOrDatabase,
      ),
    },
    chunkCounts: {
      legacySourceReachable: legacySourceReachability.size,
      legacyTargetReachable: legacyTargetReachability.size,
      manifestSourceReachable: sourceReachability.size,
      manifestTargetReachable: targetReachability.size,
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  database.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
