import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-run-continuation-bundle-'));
const bundlePath = path.join(temporaryDirectory, 'run-continuation-bundle.mjs');

function hash(character) {
  return character.repeat(64);
}

function digest(domain, character) {
  return { kind: 'canonical-digest', domain, hash: hash(character) };
}

function content(codec, character) {
  return { kind: 'content-hash', codec, hash: hash(character) };
}

function fixture(overrides = {}) {
  const authority = {
    runId: 'run-natural-terminal-s185',
    revision: 42,
    stateHash: hash('a'),
    rootSchemaVersion: 3,
    shellHash: hash('b'),
    historyLineageId: '01234567-89ab-cdef-8123-456789abcdef',
    historyHeadHash: hash('c'),
    eventCount: 10,
    tailEventId: 'event-9',
    tailEventContentHash: hash('d'),
    ...overrides.authority,
  };
  return {
    schemaVersion: 1,
    historyMode: 'bounded-hot-tail-plus-cold-pins-v1',
    authority,
    hotEventLimit: 3,
    hotStartIndex: 7,
    coldPins: [
      { absoluteIndex: 5, eventId: 'event-5', leaseKeys: ['retention:z', 'retention:a'] },
      { absoluteIndex: 1, eventId: 'event-1', leaseKeys: ['checkpoint:anchor'] },
    ],
    sidecars: {
      retention: digest('eland-retention-basis-v1', 'e'),
      physical: content('eland-physical-ledger-v2', 'f'),
      derivedObserver: digest('eland-derived-observer-v2', '1'),
      civilizationObserver: digest('eland-civilization-observer-v1', '2'),
      checkpoint: content('eland-checkpoint-sidecar-v1', '3'),
    },
    ...overrides,
    authority,
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

  const mutableInput = fixture();
  const originalEventId = mutableInput.coldPins[0].eventId;
  const encoded = codec.encodeRunContinuationBundle(mutableInput);
  const ownedBytes = Buffer.from(encoded.chunk.data);
  const exposedEncodedBytes = encoded.chunk.data;
  exposedEncodedBytes.fill(0);
  assert.deepEqual(encoded.chunk.data, ownedBytes,
    'encode 输出的可变 Buffer 不得暴露 codec 私有 owned bytes');
  const decoded = codec.decodeRunContinuationBundle(encoded.chunk);
  assert.deepEqual(decoded, encoded.bundle, 'canonical encode/decode 必须无损 roundtrip');
  assert.deepEqual(decoded.coldPins.map((pin) => pin.absoluteIndex), [1, 5]);
  assert.deepEqual(decoded.coldPins[1].leaseKeys, ['retention:a', 'retention:z']);
  assert.equal(decoded.hotStartIndex, 7);
  assert.equal(decoded.authority.eventCount, 10);
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.authority));
  assert.ok(Object.isFrozen(decoded.coldPins));
  assert.ok(Object.isFrozen(decoded.coldPins[0]));
  assert.ok(Object.isFrozen(decoded.coldPins[0].leaseKeys));
  assert.ok(Object.isFrozen(decoded.sidecars.retention));
  assert.ok(Object.isFrozen(encoded.chunk));
  assert.throws(() => { encoded.chunk.hash = hash('0'); }, TypeError);

  const reordered = fixture({
    coldPins: [
      { absoluteIndex: 1, eventId: 'event-1', leaseKeys: ['checkpoint:anchor'] },
      { absoluteIndex: 5, eventId: 'event-5', leaseKeys: ['retention:a', 'retention:z'] },
    ],
  });
  const reorderedEncoded = codec.encodeRunContinuationBundle(reordered);
  assert.equal(reorderedEncoded.chunk.hash, encoded.chunk.hash,
    'pin/lease 输入顺序不得改变 canonical content hash');
  assert.deepEqual(reorderedEncoded.chunk.data, encoded.chunk.data);

  mutableInput.authority.runId = 'mutated-run';
  mutableInput.coldPins[0].eventId = 'mutated-event';
  mutableInput.coldPins[0].leaseKeys[0] = 'mutated-lease';
  mutableInput.sidecars.retention.hash = hash('9');
  assert.deepEqual(encoded.chunk.data, ownedBytes, 'encode 后输入 mutation 不得改写 owned bytes');
  assert.equal(encoded.bundle.authority.runId, 'run-natural-terminal-s185');
  assert.equal(encoded.bundle.coldPins[1].eventId, originalEventId);

  assert.throws(() => { decoded.authority.runId = 'forged'; }, TypeError);
  assert.throws(() => { decoded.coldPins[0].leaseKeys.push('forged'); }, TypeError);
  assert.equal(decoded.authority.runId, 'run-natural-terminal-s185');

  const callerOwnedChunk = cloneChunk(encoded.chunk);
  const isolatedDecoded = codec.decodeRunContinuationBundle(callerOwnedChunk);
  callerOwnedChunk.data.fill(0);
  callerOwnedChunk.hash = hash('0');
  assert.equal(isolatedDecoded.authority.stateHash, hash('a'),
    'decode 后 chunk mutation 不得改写 owned result');

  assert.throws(() => codec.encodeRunContinuationBundle(fixture({
    coldPins: [
      { absoluteIndex: 1, eventId: 'event-1', leaseKeys: ['lease:a'] },
      { absoluteIndex: 1, eventId: 'event-other', leaseKeys: ['lease:b'] },
    ],
  })), /absoluteIndex .*重复/u);
  assert.throws(() => codec.encodeRunContinuationBundle(fixture({
    coldPins: [{ absoluteIndex: 1, eventId: 'event-1', leaseKeys: ['lease:a', 'lease:a'] }],
  })), /leaseKeys 包含重复/u);
  assert.throws(() => codec.encodeRunContinuationBundle(fixture({
    coldPins: [{ absoluteIndex: 1, eventId: 'event-1', leaseKeys: ['   '] }],
  })), /非空字符串/u);
  assert.throws(() => codec.encodeRunContinuationBundle({
    ...fixture(),
    state: { world: { past: [] } },
  }), /字段集合无效/u, '选择性 state/history 字段不得冒充 bounded manifest');

  assert.throws(() => codec.encodeRunContinuationBundle(fixture({
    authority: { stateHash: 'not-a-hash' },
  })), /64 位小写十六进制/u);
  assert.throws(() => codec.encodeRunContinuationBundle(fixture({
    sidecars: { ...fixture().sidecars, checkpoint: content('checkpoint', 'G') },
  })), /64 位小写十六进制/u);

  const emptyAuthority = {
    eventCount: 0,
    historyHeadHash: null,
    tailEventId: null,
    tailEventContentHash: null,
  };
  assert.doesNotThrow(() => codec.encodeRunContinuationBundle(fixture({
    authority: emptyAuthority,
    hotStartIndex: 0,
    coldPins: [],
  })));
  assert.throws(() => codec.encodeRunContinuationBundle(fixture({
    authority: { ...emptyAuthority, historyHeadHash: hash('c') },
    hotStartIndex: 0,
    coldPins: [],
  })), /eventCount.*tail 边界/u);
  assert.throws(() => codec.encodeRunContinuationBundle(fixture({
    authority: { tailEventId: null },
  })), /eventCount.*tail 边界/u);

  assert.throws(() => codec.encodeRunContinuationBundle(fixture({ hotStartIndex: 6 })),
    /hotStartIndex 必须等于/u);
  assert.throws(() => codec.encodeRunContinuationBundle(fixture({
    coldPins: [{ absoluteIndex: 7, eventId: 'event-7', leaseKeys: ['lease:a'] }],
  })), /严格位于 cold 区/u);
  assert.throws(() => codec.encodeRunContinuationBundle(fixture({
    hotEventLimit: codec.MAX_RUN_CONTINUATION_HOT_EVENTS + 1,
    hotStartIndex: 0,
  })), /hotEventLimit 超过硬上限/u);
  assert.throws(() => codec.encodeRunContinuationBundle(fixture({
    coldPins: [{
      absoluteIndex: 1,
      eventId: 'event-1',
      leaseKeys: Array.from(
        { length: codec.MAX_RUN_CONTINUATION_LEASE_KEYS_PER_PIN + 1 },
        (_, index) => `lease:${index}`,
      ),
    }],
  })), /leaseKeys 超过硬上限/u);

  const excessivePins = Array.from(
    { length: codec.MAX_RUN_CONTINUATION_COLD_PINS + 1 },
    (_, absoluteIndex) => ({ absoluteIndex, eventId: `event-${absoluteIndex}`, leaseKeys: ['lease:a'] }),
  );
  assert.throws(() => codec.encodeRunContinuationBundle(fixture({
    authority: { eventCount: excessivePins.length + 1 },
    hotEventLimit: 1,
    hotStartIndex: excessivePins.length,
    coldPins: excessivePins,
  })), /coldPins 超过硬上限/u);

  const wrongHashChunk = cloneChunk(encoded.chunk);
  wrongHashChunk.hash = hash('0');
  assert.throws(() => codec.decodeRunContinuationBundle(wrongHashChunk), /SHA-256 校验失败/u);
  const changedBytesChunk = cloneChunk(encoded.chunk);
  changedBytesChunk.data[0] ^= 0xff;
  assert.throws(() => codec.decodeRunContinuationBundle(changedBytesChunk), /SHA-256 校验失败/u);

  const snapshotSource = cloneChunk(encoded.chunk);
  const snapshot = codec.snapshotRunContinuationBundleChunk(snapshotSource);
  snapshotSource.data.fill(0);
  assert.deepEqual(snapshot.data, ownedBytes, 'snapshot 必须拥有独立字节副本');
  snapshot.data.fill(0);
  assert.deepEqual(snapshot.data, ownedBytes, 'snapshot 输出 mutation 不得改写私有 owned bytes');
  assert.ok(Object.isFrozen(snapshot));

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1_024 * 1_024, `fixture RSS ${rssBytes} 超过 256 MiB`);
  console.log(JSON.stringify({
    result: 'passed',
    codec: codec.RUN_CONTINUATION_BUNDLE_CODEC,
    coldPins: decoded.coldPins.length,
    rssBytes,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
