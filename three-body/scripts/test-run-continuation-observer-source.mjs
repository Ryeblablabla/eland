import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(
  tmpdir(),
  'eland-run-continuation-observer-source-',
));
const bundlePath = path.join(temporaryDirectory, 'run-continuation-bundle.mjs');

function hash(character) {
  return character.repeat(64);
}

function fixture(overrides = {}) {
  return {
    schemaVersion: 1,
    historyMode: 'bounded-hot-tail-plus-cold-pins-v1',
    authority: {
      runId: 'observer-source-fixture',
      revision: 12,
      stateHash: hash('a'),
      rootSchemaVersion: 3,
      shellHash: hash('b'),
      historyLineageId: '01234567-89ab-cdef-8123-456789abcdef',
      historyHeadHash: hash('c'),
      eventCount: 4,
      tailEventId: 'event-3',
      tailEventContentHash: hash('d'),
    },
    hotEventLimit: 2,
    hotStartIndex: 2,
    coldPins: [],
    sidecars: {
      retention: {
        kind: 'canonical-digest',
        domain: 'eland-retention-basis-v1',
        hash: hash('e'),
      },
      physical: {
        kind: 'content-hash',
        codec: 'eland-physical-ledger-v2',
        hash: hash('f'),
      },
      derivedObserver: {
        kind: 'canonical-digest',
        domain: 'eland-derived-observer-v2',
        hash: hash('1'),
      },
      civilizationObserver: {
        kind: 'canonical-digest',
        domain: 'eland-civilization-observer-v1',
        hash: hash('2'),
      },
      checkpoint: {
        kind: 'content-hash',
        codec: 'eland-checkpoint-sidecar-v1',
        hash: hash('3'),
      },
    },
    ...overrides,
  };
}

function cloneChunk(chunk) {
  return { ...chunk, data: Buffer.from(chunk.data) };
}

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/run-continuation-bundle.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], {
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' },
    stdio: 'pipe',
  });
  const codec = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  const legacy = codec.encodeRunContinuationBundle(fixture());
  assert.equal(
    Object.hasOwn(legacy.bundle, 'observerMaterializationSource'),
    false,
    '旧 bundle 重编码不得凭空加入 observer source',
  );
  const legacyDecoded = codec.decodeRunContinuationBundle(legacy.chunk);
  assert.equal(Object.hasOwn(legacyDecoded, 'observerMaterializationSource'), false);
  const legacyReencoded = codec.encodeRunContinuationBundle(legacyDecoded);
  assert.equal(legacyReencoded.chunk.hash, legacy.chunk.hash);
  assert.deepEqual(legacyReencoded.chunk.data, legacy.chunk.data);

  const mutableSource = {
    stateHash: hash('4'),
    revision: 13,
    month: 120,
  };
  const current = codec.encodeRunContinuationBundle(fixture({
    observerMaterializationSource: mutableSource,
  }));
  const originalHash = current.chunk.hash;
  const currentDecoded = codec.decodeRunContinuationBundle(current.chunk);
  assert.deepEqual(currentDecoded.observerMaterializationSource, mutableSource);
  assert.ok(Object.isFrozen(currentDecoded.observerMaterializationSource));
  assert.throws(() => {
    currentDecoded.observerMaterializationSource.month = 121;
  }, TypeError);

  mutableSource.stateHash = hash('5');
  mutableSource.revision = 99;
  mutableSource.month = 999;
  assert.deepEqual(current.bundle.observerMaterializationSource, {
    stateHash: hash('4'),
    revision: 13,
    month: 120,
  }, 'encode 必须拥有 caller source 的独立规范化副本');
  assert.equal(current.chunk.hash, originalHash);

  const currentReencoded = codec.encodeRunContinuationBundle(currentDecoded);
  assert.equal(currentReencoded.chunk.hash, originalHash);
  assert.deepEqual(currentReencoded.chunk.data, current.chunk.data);
  assert.notEqual(current.chunk.hash, legacy.chunk.hash,
    '事实根 A 引用必须进入 canonical content hash');

  const changedSource = codec.encodeRunContinuationBundle(fixture({
    observerMaterializationSource: {
      stateHash: hash('4'),
      revision: 13,
      month: 121,
    },
  }));
  assert.notEqual(changedSource.chunk.hash, originalHash,
    'observer source mutation 必须改变 content hash');

  assert.deepEqual(
    codec.normalizeRunContinuationObserverMaterializationSource({
      month: 0,
      revision: 1,
      stateHash: hash('6'),
    }),
    { stateHash: hash('6'), revision: 1, month: 0 },
  );

  assert.throws(() => codec.encodeRunContinuationBundle(fixture({
    observerMaterializationSource: {
      stateHash: 'not-a-sha256',
      revision: 13,
      month: 120,
    },
  })), /64 位小写十六进制/u);
  assert.throws(() => codec.encodeRunContinuationBundle(fixture({
    observerMaterializationSource: {
      stateHash: hash('4'),
      revision: 0,
      month: 120,
    },
  })), /revision.*大于等于 1/u);
  assert.throws(() => codec.encodeRunContinuationBundle(fixture({
    observerMaterializationSource: {
      stateHash: hash('4'),
      revision: 13,
      month: -1,
    },
  })), /month.*大于等于 0/u);
  assert.throws(() => codec.encodeRunContinuationBundle(fixture({
    observerMaterializationSource: {
      stateHash: hash('4'),
      revision: 13,
      month: 120,
      authority: true,
    },
  })), /observerMaterializationSource 字段集合无效/u);
  assert.throws(() => codec.encodeRunContinuationBundle({
    ...fixture(),
    observerMaterializationSource: {
      stateHash: hash('4'),
      revision: 13,
      month: 120,
    },
    observerRootAuthority: hash('7'),
  }), /bundle 字段集合无效/u);

  const forgedChunk = cloneChunk(current.chunk);
  forgedChunk.data[0] ^= 0xff;
  assert.throws(() => codec.decodeRunContinuationBundle(forgedChunk), /SHA-256 校验失败/u);

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1_024 * 1_024, `fixture RSS ${rssBytes} 超过 256 MiB`);
  console.log(JSON.stringify({
    result: 'passed',
    legacyHashStable: legacyReencoded.chunk.hash === legacy.chunk.hash,
    observerSourceHash: originalHash,
    rssBytes,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
