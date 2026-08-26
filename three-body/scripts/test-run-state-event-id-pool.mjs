import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serialize } from 'node:v8';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-event-id-pool-v23-'));
const codecBundlePath = path.join(temporaryDirectory, 'run-state-codec.mjs');
const memoryBundlePath = path.join(temporaryDirectory, 'event-history-memory.mjs');

function storedChunk(codec, data) {
  return {
    hash: createHash('sha256').update(codec).update('\0').update(data).digest('hex'),
    codec,
    rawSize: data.byteLength,
    data,
  };
}

function compressedChunk(codec, value) {
  return storedChunk(codec, brotliCompressSync(serialize(value), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
  }));
}

function decisionEvent(id, atMonth, sourceFactIds) {
  return {
    id,
    atMonth,
    orderInMonth: 0,
    cellId: 7,
    kind: 'decision',
    who: 1,
    decision: {
      kind: 'synthetic-test-decision',
      reason: 'shared-audit-reason',
      optionId: 'shared-audit-option',
    },
    usedModel: false,
    reproductionEvidence: {
      version: 'family-readiness-v2',
      optionId: 'shared-audit-option',
      direction: 'proceed',
      generativityUrgency: 0.5,
      needActivation: 0.5,
      motivation: 0.5,
      aspiration: 0.5,
      relationshipGate: 1,
      readinessGate: 1,
      sourceFactIds: [...sourceFactIds, 'orphan-source-id'],
      familyReadiness: {
        readiness: 0.5,
        food: 0.5,
        water: 0.5,
        shelter: 0.5,
        careCapacity: 0.5,
        climateSafety: 0.5,
        basisKeys: ['shared-basis-key', 'shared-basis-key'],
        sourceFactIds: [...sourceFactIds, 'orphan-source-id'],
      },
    },
    result: 'synthetic decision result',
  };
}

function shellReferenceFixture(futureId) {
  const sparse = new Array(4);
  sparse[1] = futureId;
  sparse[3] = 'tail';
  return {
    futureId,
    nested: { futureId, values: [futureId, 'other'] },
    map: new Map([
      ['first', futureId],
      [{ objectKey: true }, 'other'],
    ]),
    set: new Set(['prefix', futureId, 'suffix']),
    date: new Date('2026-08-25T00:00:00.000Z'),
    regexp: /event-id-pool/giu,
    typed: new Uint8Array([0, 1, 2, 253, 254, 255]),
    sparse,
  };
}

function stateFixture(events, lastStep = [events.at(-1)]) {
  const futureId = events.at(-1).id;
  return {
    month: 2,
    config: { endpoint: { kind: 'months', value: 12_000 } },
    lastStep,
    shellReferences: shellReferenceFixture(futureId),
    world: {
      past: events,
      shellReferences: shellReferenceFixture(futureId),
    },
  };
}

function snapshotChunks(...snapshots) {
  return new Map(snapshots.flatMap((snapshot) => [snapshot.root, ...snapshot.parts])
    .map((chunk) => [chunk.hash, chunk]));
}

function readFrom(chunks) {
  return (hash) => {
    const chunk = chunks.get(hash);
    if (!chunk) throw new Error(`缺少测试chunk ${hash}`);
    return chunk;
  };
}

function legacySchema2Snapshot(codec, current, state) {
  const { past: _past, ...world } = state.world;
  const shell = { ...state, world };
  const shellChunk = compressedChunk(codec.RUN_STATE_SHELL_CODEC, shell);
  const metadata = {
    ...current.metadata,
    schemaVersion: 2,
    shellHash: shellChunk.hash,
  };
  const root = storedChunk(codec.RUN_STATE_ROOT_CODEC, serialize(metadata));
  return { root, parts: [shellChunk], metadata };
}

function assertContainerSafety(codec, futureId, canonicalEventIds) {
  const objectKey = { key: 'identity-must-survive' };
  const map = new Map([
    ['first', futureId],
    [objectKey, 'tail'],
  ]);
  const set = new Set(['prefix', futureId, 'suffix']);
  const date = new Date('2026-08-25T00:00:00.000Z');
  date.futureId = futureId;
  const regexp = /event-id-pool/giu;
  regexp.futureId = futureId;
  const typed = new Uint8Array([0, 1, 2, 253, 254, 255]);
  typed.futureId = futureId;
  const customPrototype = { kind: 'custom-prototype' };
  const custom = Object.create(customPrototype);
  Object.defineProperty(custom, 'mustNotRead', {
    enumerable: true,
    get() {
      throw new Error('custom prototype object must not be traversed');
    },
  });
  const sparse = new Array(4);
  sparse[1] = futureId;
  sparse[3] = 'tail';
  const nullPrototype = Object.create(null);
  nullPrototype.futureId = futureId;
  const fixture = {
    map,
    set,
    date,
    regexp,
    typed,
    custom,
    sparse,
    nullPrototype,
  };

  codec.canonicalizeEventIdReferencesForTests(
    fixture,
    canonicalEventIds,
  );

  assert.deepEqual([...map.keys()], ['first', objectKey]);
  assert.deepEqual([...map.values()], [futureId, 'tail']);
  assert.deepEqual([...set], ['prefix', futureId, 'suffix']);
  assert.equal(date.toISOString(), '2026-08-25T00:00:00.000Z');
  assert.equal(date.futureId, futureId);
  assert.equal(regexp.source, 'event-id-pool');
  assert.equal(regexp.flags, 'giu');
  assert.equal(regexp.futureId, futureId);
  assert.deepEqual([...typed], [0, 1, 2, 253, 254, 255]);
  assert.equal(typed.futureId, futureId);
  assert.equal(Object.getPrototypeOf(custom), customPrototype);
  assert.equal(0 in sparse, false);
  assert.equal(2 in sparse, false);
  assert.equal(Object.getPrototypeOf(nullPrototype), null);
  assert.equal(nullPrototype.futureId, futureId);
}

try {
  const esbuild = path.resolve('node_modules/.bin/esbuild');
  const lowHeapEnvironment = {
    ...process.env,
    NODE_OPTIONS: '--max-old-space-size=192',
  };
  for (const [entry, output] of [
    ['server/run-state-codec.ts', codecBundlePath],
    ['server/event-history-memory.ts', memoryBundlePath],
  ]) {
    execFileSync(esbuild, [
      entry,
      '--bundle',
      '--platform=node',
      '--format=esm',
      `--outfile=${output}`,
    ], { env: lowHeapEnvironment, stdio: 'pipe' });
  }

  const nonce = Date.now();
  const codec = await import(`${pathToFileURL(codecBundlePath).href}?v=${nonce}`);
  const memory = await import(`${pathToFileURL(memoryBundlePath).href}?v=${nonce}`);
  const earlyId = 'event-early-segment';
  const futureId = 'event-future-segment';
  const middleId = 'event-middle-segment';
  const earlyEvent = decisionEvent(earlyId, 1, [futureId, futureId]);
  const futureEvent = decisionEvent(futureId, 2, [earlyId, futureId]);
  const middleEvent = decisionEvent(middleId, 3, [earlyId, futureId]);
  const duplicateFutureEvent = decisionEvent(futureId, 4, [earlyId, 'orphan-source-id']);

  // Exercise the real segmented ordering: the first segment names an event ID
  // which cannot be known until the second segment has been decoded.
  const auditPool = new Map();
  const eventIdPool = new Map();
  const firstSegment = [structuredClone(earlyEvent)];
  const secondSegment = [
    structuredClone(futureEvent),
    structuredClone(middleEvent),
    structuredClone(duplicateFutureEvent),
  ];
  memory.internEventHistoryAuditStrings(firstSegment, auditPool, eventIdPool);
  assert.equal(eventIdPool.has(earlyId), true, 'event.id必须直接进入唯一ID pool');
  assert.equal(eventIdPool.has(futureId), true, '未来引用必须在第一次出现时直接进入ID pool');
  assert.equal(eventIdPool.has('orphan-source-id'), true, '未解析引用也必须保持单池规范值');
  assert.equal(auditPool.has(futureId), false, 'ID引用不得进入audit pool');
  memory.internEventHistoryAuditStrings(secondSegment, auditPool, eventIdPool);
  assert.equal(eventIdPool.size, 4, '唯一ID pool包含三个已见ID及一个未解析引用');
  assert.equal(auditPool.has(futureId), false, '重复event ID不得进入audit pool');
  const pooledEvents = [...firstSegment, ...secondSegment];
  for (const eventId of eventIdPool.keys()) {
    assert.equal(auditPool.has(eventId), false, `audit pool不得重复保留 ${eventId}`);
  }
  assert.deepEqual(
    pooledEvents[0].reproductionEvidence.sourceFactIds,
    [futureId, futureId, 'orphan-source-id'],
  );
  assert.deepEqual(
    pooledEvents[0].reproductionEvidence.familyReadiness.basisKeys,
    ['shared-basis-key', 'shared-basis-key'],
  );
  assert.equal(auditPool.has('shared-audit-reason'), true);
  assert.equal(auditPool.has('shared-audit-option'), true);
  assert.equal(auditPool.has('shared-basis-key'), true);
  assert.equal(auditPool.has('orphan-source-id'), false);

  const compactSource = new Map(eventIdPool);
  const compactEventIds = codec.compactCanonicalEventIdLookupForTests(compactSource);
  assert.equal(compactSource.size, 0, 'compact数组构造后必须立即释放canonical Map');
  assert.deepEqual(
    compactEventIds.values,
    [...eventIdPool.values()].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
    'compact数组必须只保留排序canonical值指针',
  );
  for (const [eventId, canonical] of eventIdPool) {
    assert.equal(
      codec.canonicalEventIdFromCompactLookupForTests(compactEventIds, eventId),
      canonical,
      `compact lookup必须精确解析 ${eventId}`,
    );
  }
  assert.equal(
    codec.canonicalEventIdFromCompactLookupForTests(compactEventIds, 'missing-event-id'),
    undefined,
    '不存在的event ID必须返回undefined',
  );

  const firstState = stateFixture([earlyEvent]);
  const firstSnapshot = await codec.encodeSegmentedRunState(firstState);
  const finalState = stateFixture(
    [earlyEvent, futureEvent, middleEvent, duplicateFutureEvent],
    [earlyEvent, middleEvent, duplicateFutureEvent],
  );
  const schema3Snapshot = await codec.encodeSegmentedRunState(
    finalState,
    { mode: 'append', previous: firstSnapshot.metadata },
  );
  const chunks = snapshotChunks(firstSnapshot, schema3Snapshot);
  const schema3Manifest = codec.parseRunStateShellManifest(
    chunks.get(schema3Snapshot.metadata.shellHash),
  );
  assert.ok(schema3Manifest.fields.some((field) => field.name === 'shellReferences'));
  assert.ok(schema3Manifest.worldFields.some((field) => field.name === 'shellReferences'));

  const schema2Snapshot = legacySchema2Snapshot(codec, schema3Snapshot, finalState);
  chunks.set(schema2Snapshot.root.hash, schema2Snapshot.root);
  for (const part of schema2Snapshot.parts) chunks.set(part.hash, part);

  const decoded = {};
  for (const [label, snapshot] of [
    ['schema2', schema2Snapshot],
    ['schema3', schema3Snapshot],
  ]) {
    let beforeShellDecode;
    let afterShellValidation;
    const canonical = await codec.decodeSegmentedRunState(
      snapshot.root,
      readFrom(chunks),
      {
        onBeforeShellDecodeForTests: (temporaryPools) => { beforeShellDecode = temporaryPools; },
        onAfterShellValidationForTests: (temporaryPools) => { afterShellValidation = temporaryPools; },
      },
    );
    const disabled = await codec.decodeSegmentedRunState(
      snapshot.root,
      readFrom(chunks),
      { canonicalizeEventIdReferences: false },
    );
    assert.ok(beforeShellDecode.releasedAuditStringCount > 0, `${label} fixture必须实际建立audit pool`);
    assert.equal(beforeShellDecode.auditStringCount, 0, `${label} shell decode前必须释放audit pool`);
    assert.equal(beforeShellDecode.canonicalEventIdCount, 0, `${label} shell decode前必须释放canonical Map`);
    assert.ok(beforeShellDecode.compactCanonicalEventIdCount > 0, `${label} shell decode前必须保留compact ID指针数组`);
    assert.equal(afterShellValidation.compactCanonicalEventIdCount, 0, `${label} shell校验后必须释放compact ID指针数组`);
    assert.deepEqual(canonical.state, finalState, `${label} default必须值完全一致`);
    assert.deepEqual(disabled.state, finalState, `${label} disabled必须值完全一致`);
    assert.deepEqual(canonical.state, disabled.state, `${label} option必须deepStrictEqual`);
    assert.equal(
      canonical.state.lastStep[0], canonical.state.world.past[0],
      `${label} lastStep第一个ID必须复用历史匹配事件`,
    );
    assert.equal(
      canonical.state.lastStep[1], canonical.state.world.past[2],
      `${label} lastStep交错ID必须复用历史匹配事件`,
    );
    assert.equal(
      canonical.state.lastStep[2], canonical.state.world.past[3],
      `${label} duplicate event.id 的lastStep必须复用历史中最后一个匹配事件`,
    );
    assert.equal(0 in canonical.state.shellReferences.sparse, false);
    assert.equal(2 in canonical.state.shellReferences.sparse, false);
    decoded[label] = {
      rootHash: snapshot.root.hash,
      rootSchemaVersion: snapshot.metadata.schemaVersion,
      beforeShellDecode,
    };
  }

  assertContainerSafety(codec, futureId, new Map([[futureId, futureId]]));
  assertContainerSafety(codec, futureId, compactEventIds);
  const memoryUsage = process.memoryUsage();
  assert.ok(memoryUsage.rss < 512 * 1024 * 1024, '小型fixture不得越过512MiB RSS守护');
  console.log(JSON.stringify({
    result: 'passed',
    eventIdPoolEntries: eventIdPool.size,
    auditPoolEntries: auditPool.size,
    auditPoolContainsEventIds: false,
    sourceReferences: 'forward/backward/self/unresolved canonicalized-single-pass',
    duplicateEventIdLastStep: 'last-match-object-identity-exact',
    repeatedAuditStrings: 'preserved-and-pooled',
    earlyAuditPoolRelease: 'after-tail-verification-before-shell-decode',
    canonicalMapRelease: 'after-tail-verification-before-shell-decode',
    compactLookupRelease: 'after-shell-validation-before-lastStep-map',
    compactLookup: 'sorted-string-pointer-array-with-binary-search',
    schema2AndSchema3: decoded,
    defaultVsDisabled: 'deepStrictEqual',
    lastStepObjectIdentity: 'exact',
    containerSafety: 'Map/Set/Date/RegExp/typed/sparse/null/custom prototype exact',
    rssBytes: memoryUsage.rss,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
