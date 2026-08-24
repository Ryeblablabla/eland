import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const workspace = path.resolve('.');
const require = createRequire(path.join(workspace, 'package.json'));
const esbuild = require('esbuild');
const sourceMonth = 3828;
const targetMonth = 3840;
const expectedFullStateSha256 = '1736241470360713cacb8110a13bc0eb305f0681c18e81ecc90c5e2c2323d833';
const expectedSuffixSha256 = 'a27b16e7410f4c12e7ec170205ec0a89409f96f3e043df6ad3e55e65bb45f7e2';
const configurations = [
  {
    side: 'baseline',
    sourceRoot: path.join(
      workspace,
      'data/frozen-source-mechanical-service-p0-v10-baseline-20260823/three-body',
    ),
    databasePath: path.join(
      workspace,
      'data/terminal-mechanical-service-p0-v10-baseline/eland.sqlite3',
    ),
    runId: 'ms-p0-v10-baseline-0823-s20260815-y1000',
  },
  {
    side: 'candidate',
    sourceRoot: path.join(
      workspace,
      'data/frozen-source-mechanical-service-p0-v10-candidate-20260823/three-body',
    ),
    databasePath: path.join(
      workspace,
      'data/terminal-mechanical-service-p0-v10-candidate/eland.sqlite3',
    ),
    runId: 'ms-p0-v10-candidate-0823-s20260815-y1000',
  },
];

function semanticSha(value) {
  const hash = createHash('sha256');
  let buffer = '';
  const append = (token) => {
    buffer += token;
    if (buffer.length >= 1024 * 1024) {
      hash.update(buffer);
      buffer = '';
    }
  };
  const write = (item, inArray = false) => {
    if (item && typeof item === 'object' && typeof item.toJSON === 'function') item = item.toJSON();
    if (item === null) { append('null'); return true; }
    if (typeof item === 'string') { append(JSON.stringify(item)); return true; }
    if (typeof item === 'number') { append(Number.isFinite(item) ? String(item) : 'null'); return true; }
    if (typeof item === 'boolean') { append(item ? 'true' : 'false'); return true; }
    if (Array.isArray(item)) {
      append('[');
      for (let index = 0; index < item.length; index += 1) {
        if (index > 0) append(',');
        write(item[index], true);
      }
      append(']');
      return true;
    }
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
      if (inArray) append('null');
      return inArray;
    }
    append('{');
    let emitted = 0;
    for (const key of Object.keys(item)) {
      const child = item[key];
      if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
      if (emitted > 0) append(',');
      append(JSON.stringify(key));
      append(':');
      write(child, false);
      emitted += 1;
    }
    append('}');
    return true;
  };
  write(value);
  if (buffer) hash.update(buffer);
  return hash.digest('hex');
}

function checkpointHash(database, runId, month) {
  const row = database.prepare(`
    SELECT state_hash FROM run_checkpoints
    WHERE run_id = ? AND month = ?
    ORDER BY revision DESC LIMIT 1
  `).get(runId, month);
  if (!row) throw new Error(`运行 ${runId} 缺少第 ${month} 月 checkpoint`);
  return String(row.state_hash);
}

function chunkReader(database) {
  const statement = database.prepare('SELECT hash, codec, raw_size, data FROM chunks WHERE hash = ?');
  return (hash) => {
    const row = statement.get(hash);
    if (!row) throw new Error(`缺少 chunk ${hash}`);
    return {
      hash: String(row.hash),
      codec: String(row.codec),
      rawSize: Number(row.raw_size),
      data: row.data,
    };
  };
}

const results = [];
for (const configuration of configurations) {
  const directory = mkdtempSync(path.join(tmpdir(), `eland-v15-v16-${configuration.side}-`));
  const bundlePath = path.join(directory, 'combined-api.mjs');
  const database = new DatabaseSync(configuration.databasePath, { readOnly: true });
  try {
    await esbuild.build({
      stdin: {
        contents: `
          export { decodeSegmentedRunState, parseRunStateRoot } from './server/run-state-codec.ts';
          export { stepOwnedSimulation } from './src/game/eland/application/simulation/tick-executor.ts';
        `,
        resolveDir: configuration.sourceRoot,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: bundlePath,
      logLevel: 'silent',
    });
    const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
    const readChunk = chunkReader(database);
    const sourceRootHash = checkpointHash(database, configuration.runId, sourceMonth);
    const targetRootHash = checkpointHash(database, configuration.runId, targetMonth);
    const sourceMetadata = api.parseRunStateRoot(readChunk(sourceRootHash));

    let startedAt = performance.now();
    let expected = (await api.decodeSegmentedRunState(readChunk(targetRootHash), readChunk)).state;
    const expectedDecodeMilliseconds = performance.now() - startedAt;
    const expectedFullSha = semanticSha(expected);
    const expectedSuffixSha = semanticSha(expected.world.past.slice(sourceMetadata.eventCount));
    const expectedEventCount = expected.world.past.length;
    assert.equal(expectedFullSha, expectedFullStateSha256, `${configuration.side} v14 full SHA`);
    assert.equal(expectedSuffixSha, expectedSuffixSha256, `${configuration.side} v14 suffix SHA`);
    expected = undefined;
    globalThis.gc?.();

    startedAt = performance.now();
    let replayed = (await api.decodeSegmentedRunState(readChunk(sourceRootHash), readChunk)).state;
    const sourceDecodeMilliseconds = performance.now() - startedAt;
    startedAt = performance.now();
    for (let month = sourceMonth; month < targetMonth; month += 1) {
      replayed = api.stepOwnedSimulation(replayed);
    }
    const replayMilliseconds = performance.now() - startedAt;
    const replayFullSha = semanticSha(replayed);
    const replaySuffixSha = semanticSha(replayed.world.past.slice(sourceMetadata.eventCount));
    assert.equal(replayFullSha, expectedFullSha, `${configuration.side} combined full SHA`);
    assert.equal(replaySuffixSha, expectedSuffixSha, `${configuration.side} combined suffix SHA`);
    assert.equal(replayed.world.past.length, expectedEventCount, `${configuration.side} event count`);
    results.push({
      side: configuration.side,
      sourceMonth,
      targetMonth,
      sourceEvents: sourceMetadata.eventCount,
      targetEvents: expectedEventCount,
      suffixEvents: expectedEventCount - sourceMetadata.eventCount,
      fullStateSha256: replayFullSha,
      orderedSuffixSha256: replaySuffixSha,
      expectedDecodeMilliseconds,
      sourceDecodeMilliseconds,
      replayMilliseconds,
      result: 'exact',
    });
    replayed = undefined;
    globalThis.gc?.();
    process.stderr.write(`[combined] ${configuration.side} m3828->m3840 full/suffix exact\n`);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
