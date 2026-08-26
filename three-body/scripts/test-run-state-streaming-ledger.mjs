import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-streaming-ledger-v24-'));
const codecBundlePath = path.join(temporaryDirectory, 'run-state-codec.mjs');
const frozenCodecBundlePath = path.join(temporaryDirectory, 'run-state-codec-v23.mjs');
const frozenRuntimeSourceMapPath = path.resolve(
  'data/frozen-runtime-mechanical-service-p0-v23-compact-id-lookup-memory-safe-candidate-20260825/main.mjs.map',
);

function extractFrozenV23CodecSources() {
  const sourceMap = JSON.parse(readFileSync(frozenRuntimeSourceMapPath, 'utf8'));
  const frozenRoot = path.join(temporaryDirectory, 'frozen-v23');
  const serverDirectory = path.join(frozenRoot, 'server');
  mkdirSync(serverDirectory, { recursive: true });
  for (const sourceName of ['run-state-codec.ts', 'event-history-memory.ts']) {
    const sourceIndex = sourceMap.sources.findIndex(
      (source) => source.endsWith(`/server/${sourceName}`),
    );
    assert.notEqual(sourceIndex, -1, `冻结v23 source map缺少 server/${sourceName}`);
    const sourceContent = sourceMap.sourcesContent[sourceIndex];
    assert.equal(typeof sourceContent, 'string', `冻结v23 source map缺少 ${sourceName} 内容`);
    writeFileSync(path.join(serverDirectory, sourceName), sourceContent);
  }
  return path.join(serverDirectory, 'run-state-codec.ts');
}

function event(id, atMonth, sourceFactIds) {
  return {
    id,
    atMonth,
    orderInMonth: 0,
    cellId: atMonth,
    kind: 'decision',
    who: 1,
    decision: {
      kind: 'streaming-ledger-fixture',
      reason: `reason-${atMonth}`,
      optionId: `option-${atMonth}`,
    },
    usedModel: false,
    evidence: { sourceFactIds: [...sourceFactIds] },
    result: `result-${atMonth}`,
  };
}

function frozenOracleEvent(index) {
  return {
    id: `frozen-oracle-event-${index}`,
    atMonth: 100 + Math.floor(index / 15),
    orderInMonth: index % 15,
    cellId: index % 7,
    kind: 'environment',
    environment: {
      kind: 'streaming-ledger-oracle',
      ordinal: index,
    },
  };
}

function stateFixture(events) {
  const tail = events.at(-1);
  return {
    month: tail?.atMonth ?? 0,
    config: { endpoint: { kind: 'months', value: 12_000 } },
    lastStep: events.slice(-2),
    ledgerFixture: {
      checkpointMonth: tail?.atMonth ?? 0,
      tailSourceFactIds: [...(tail?.evidence?.sourceFactIds ?? [])],
    },
    world: {
      past: events,
      weather: 'stable',
    },
  };
}

function withOnlySuffixInPast(state, suffix) {
  return {
    ...state,
    world: {
      ...state.world,
      past: suffix,
    },
  };
}

function assertEncodedSnapshotsExact(actual, expected, label) {
  assert.equal(actual.root.hash, expected.root.hash, `${label}: root hash必须一致`);
  assert.deepEqual(actual.metadata, expected.metadata, `${label}: root metadata必须一致`);
  assert.deepEqual(
    [actual.root, ...actual.parts].map((chunk) => ({
      codec: chunk.codec,
      hash: chunk.hash,
      rawSize: chunk.rawSize,
      data: Buffer.from(chunk.data),
    })),
    [expected.root, ...expected.parts].map((chunk) => ({
      codec: chunk.codec,
      hash: chunk.hash,
      rawSize: chunk.rawSize,
      data: Buffer.from(chunk.data),
    })),
    `${label}: segment/node/root字节与顺序必须一致`,
  );
}

function chunksFrom(...snapshots) {
  return new Map(snapshots
    .flatMap((snapshot) => [snapshot.root, ...snapshot.parts])
    .map((chunk) => [chunk.hash, chunk]));
}

function readFrom(chunks) {
  return (hash) => {
    const chunk = chunks.get(hash);
    if (!chunk) throw new Error(`缺少fixture chunk ${hash}`);
    return chunk;
  };
}

try {
  const esbuild = path.resolve('node_modules/.bin/esbuild');
  const frozenCodecEntry = extractFrozenV23CodecSources();
  for (const [entry, output] of [
    [frozenCodecEntry, frozenCodecBundlePath],
    ['server/run-state-codec.ts', codecBundlePath],
  ]) {
    execFileSync(esbuild, [
      entry,
      '--bundle',
      '--platform=node',
      '--format=esm',
      `--outfile=${output}`,
    ], {
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' },
      stdio: 'pipe',
    });
  }

  const nonce = Date.now();
  const frozenV23Codec = await import(
    `${pathToFileURL(frozenCodecBundlePath).href}?v=${nonce}`
  );
  const codec = await import(`${pathToFileURL(codecBundlePath).href}?v=${nonce}`);
  const segmentOptions = { maxEventsPerSegmentForTests: 2 };
  const ids = {
    early: 'event-early',
    second: 'event-second',
    duplicate: 'event-duplicate',
    middle: 'event-middle',
    fourth: 'event-fourth',
    future: 'event-future',
    late: 'event-late',
    penultimate: 'event-penultimate',
    tail: 'event-tail',
    unresolved: 'event-never-resolved',
  };
  const events = [
    event(ids.early, 1, [ids.future, ids.early, ids.unresolved]),
    event(ids.second, 2, [ids.early]),
    event(ids.duplicate, 3, [ids.duplicate]),
    event(ids.middle, 4, [ids.early, ids.future]),
    event(ids.fourth, 5, [ids.middle]),
    event(ids.future, 6, [ids.early, ids.future]),
    event(ids.duplicate, 7, [ids.duplicate, ids.unresolved]),
    event(ids.late, 8, [ids.tail]),
    event(ids.penultimate, 9, [ids.late, ids.penultimate]),
    event(ids.tail, 10, [ids.penultimate, ids.early]),
  ];

  // The first immutable checkpoint already has two logical segments.
  const firstEvents = events.slice(0, 3);
  const firstState = stateFixture(firstEvents);

  // A frozen v23 runtime is the compatibility oracle. It creates both the
  // previous root and its production-sized append; v24 then appends the same
  // state from the exact v23 metadata without regenerating the lineage.
  const frozenPrevious = await frozenV23Codec.encodeSegmentedRunState(firstState);
  const frozenOracleSuffix = Array.from(
    { length: 2_051 },
    (_, index) => frozenOracleEvent(index),
  );
  const oracleFinalState = stateFixture([...firstEvents, ...frozenOracleSuffix]);
  const frozenAppend = await frozenV23Codec.encodeSegmentedRunState(
    oracleFinalState,
    { mode: 'append', previous: frozenPrevious.metadata },
  );
  const currentAppendFromFrozenPrevious = await codec.encodeSegmentedRunState(
    oracleFinalState,
    { mode: 'append', previous: frozenPrevious.metadata },
  );
  assertEncodedSnapshotsExact(
    currentAppendFromFrozenPrevious,
    frozenAppend,
    'frozen v23 production append oracle',
  );
  const frozenAppendNode = frozenV23Codec.parseRunHistoryNode(
    frozenAppend.parts.find((chunk) => chunk.codec === frozenV23Codec.RUN_HISTORY_NODE_CODEC),
  );
  assert.deepEqual(
    frozenAppendNode.segments.map((segment) => segment.eventCount),
    [2_048, 3],
    '冻结v23 oracle必须实际跨越权威2048事件分段边界',
  );

  const first = await codec.encodeSegmentedRunState(
    firstState,
    { mode: 'replace' },
    segmentOptions,
  );
  const firstCursor = codec.runHistoryCursorFromRootMetadata(first.metadata);
  assert.deepEqual(firstCursor, {
    lineageId: first.metadata.lineageId,
    historyHeadHash: first.metadata.historyHeadHash,
    eventCount: 3,
    tailEventContentHash: first.metadata.tailEventContentHash,
  });

  const emptySuffix = await codec.encodeRunHistorySuffix(
    firstCursor,
    [],
    segmentOptions,
  );
  assert.deepEqual(emptySuffix.cursor, firstCursor, '空suffix必须原样保留cursor');
  assert.deepEqual(emptySuffix.parts, [], '空suffix不得产生ledger chunk');
  const emptySuffixRoot = await codec.encodeSegmentedRunStateFromHistorySuffix(
    withOnlySuffixInPast(firstState, []),
    firstCursor,
    [],
    segmentOptions,
  );
  assert.equal(emptySuffixRoot.root.hash, first.root.hash, '空suffix与相同shell必须复用原root hash');
  assert.equal(
    emptySuffixRoot.parts.some((chunk) => chunk.codec === codec.RUN_STATE_EVENT_SEGMENT_CODEC
      || chunk.codec === codec.RUN_HISTORY_NODE_CODEC),
    false,
    '空suffix完整编码不得产生历史segment或node',
  );

  const freshEmpty = await codec.encodeSegmentedRunState(
    stateFixture([]),
    { mode: 'replace' },
    segmentOptions,
  );
  const freshEmptyCursor = codec.runHistoryCursorFromRootMetadata(freshEmpty.metadata);
  assert.deepEqual(
    {
      historyHeadHash: freshEmptyCursor.historyHeadHash,
      eventCount: freshEmptyCursor.eventCount,
      tailEventContentHash: freshEmptyCursor.tailEventContentHash,
    },
    { historyHeadHash: null, eventCount: 0, tailEventContentHash: null },
    'fresh empty history必须形成规范空cursor',
  );
  let freshEmptyVisitorCalls = 0;
  assert.deepEqual(
    await codec.streamVerifiedRunHistorySegments(
      freshEmpty.metadata,
      readFrom(chunksFrom(freshEmpty)),
      () => { freshEmptyVisitorCalls += 1; },
    ),
    freshEmptyCursor,
    'fresh empty history必须可完成整链验证',
  );
  assert.equal(freshEmptyVisitorCalls, 0, 'fresh empty history不得调用segment visitor');

  // Append from the first checkpoint through both public paths. The suffix
  // path's state intentionally does not contain the three-event cold prefix.
  const secondSuffix = events.slice(3, 7);
  const secondState = stateFixture(events.slice(0, 7));
  const secondFull = await codec.encodeSegmentedRunState(
    secondState,
    { mode: 'append', previous: first.metadata },
    segmentOptions,
  );
  const secondFromSuffix = await codec.encodeSegmentedRunStateFromHistorySuffix(
    withOnlySuffixInPast(secondState, secondSuffix),
    firstCursor,
    secondSuffix,
    segmentOptions,
  );
  assertEncodedSnapshotsExact(secondFromSuffix, secondFull, 'first checkpoint append');

  const pureSecondHistory = await codec.encodeRunHistorySuffix(
    firstCursor,
    secondSuffix,
    segmentOptions,
  );
  assert.deepEqual(
    pureSecondHistory.parts.map(({ codec: chunkCodec, hash }) => ({ codec: chunkCodec, hash })),
    secondFull.parts
      .filter((chunk) => chunk.codec === codec.RUN_STATE_EVENT_SEGMENT_CODEC
        || chunk.codec === codec.RUN_HISTORY_NODE_CODEC)
      .map(({ codec: chunkCodec, hash }) => ({ codec: chunkCodec, hash })),
    '纯cursor+suffix原语必须产生完全相同的segment/node hash',
  );

  // A second checkpoint makes the final history cross two earlier immutable
  // node boundaries and six small event segments in authoritative order.
  const finalSuffix = events.slice(7);
  const finalState = stateFixture(events);
  const secondCursor = codec.runHistoryCursorFromRootMetadata(secondFull.metadata);
  const finalFull = await codec.encodeSegmentedRunState(
    finalState,
    { mode: 'append', previous: secondFull.metadata },
    segmentOptions,
  );
  const finalFromSuffix = await codec.encodeSegmentedRunStateFromHistorySuffix(
    withOnlySuffixInPast(finalState, finalSuffix),
    secondCursor,
    finalSuffix,
    segmentOptions,
  );
  assertEncodedSnapshotsExact(finalFromSuffix, finalFull, 'second checkpoint append');

  const chunks = chunksFrom(first, secondFull, finalFull);
  const readChunk = readFrom(chunks);
  const finalNode = codec.parseRunHistoryNode(readChunk(finalFull.metadata.historyHeadHash));
  const secondNode = codec.parseRunHistoryNode(readChunk(finalNode.parentHash));
  const firstNode = codec.parseRunHistoryNode(readChunk(secondNode.parentHash));
  assert.deepEqual(
    [firstNode.startEventIndex, secondNode.startEventIndex, finalNode.startEventIndex],
    [0, 3, 7],
    '历史节点必须保留两个较早checkpoint边界',
  );

  const schemaRoots = [
    ['schema2', { ...finalFull.metadata, schemaVersion: 2 }],
    ['schema3', finalFull.metadata],
  ];
  const streamedSummaries = {};
  for (const [label, root] of schemaRoots) {
    const visited = [];
    const starts = [];
    const segmentSizes = [];
    let activeVisitors = 0;
    let maxActiveVisitors = 0;
    const cursor = await codec.streamVerifiedRunHistorySegments(
      root,
      readChunk,
      async (segment, position) => {
        activeVisitors += 1;
        maxActiveVisitors = Math.max(maxActiveVisitors, activeVisitors);
        starts.push(position.startEventIndex);
        segmentSizes.push(segment.length);
        visited.push(...structuredClone(segment));
        await Promise.resolve();
        activeVisitors -= 1;
      },
    );
    assert.deepEqual(cursor, codec.runHistoryCursorFromRootMetadata(root));
    assert.equal(maxActiveVisitors, 1, `${label}: segment visitor不得重叠`);
    assert.deepEqual(starts, [0, 2, 3, 5, 7, 9], `${label}: segment必须按权威顺序出现`);
    assert.deepEqual(segmentSizes, [2, 1, 2, 2, 2, 1], `${label}: 必须实际读取六个小segment`);
    assert.deepEqual(visited, events, `${label}: streaming history不得改写任何事实`);
    assert.deepEqual(
      visited.map((item) => item.evidence.sourceFactIds),
      events.map((item) => item.evidence.sourceFactIds),
      `${label}: forward/reverse/self/unresolved source ID必须原样保留`,
    );
    assert.equal(
      visited.filter((item) => item.id === ids.duplicate).length,
      2,
      `${label}: 跨segment duplicate event.id不得去重`,
    );
    streamedSummaries[label] = { starts, segmentSizes, maxActiveVisitors };
  }

  await assert.rejects(
    codec.streamVerifiedRunHistorySegments(
      { ...finalFull.metadata, eventCount: finalFull.metadata.eventCount + 1 },
      readChunk,
      () => {},
    ),
    /累计事件数不连续|事件历史与状态根不一致/u,
    'streaming API必须校验root eventCount',
  );
  const badTailStaging = [];
  const badTailCommitted = [];
  await assert.rejects(
    (async () => {
      await codec.streamVerifiedRunHistorySegments(
        { ...finalFull.metadata, tailEventContentHash: '0'.repeat(64) },
        readChunk,
        (segment) => { badTailStaging.push(structuredClone(segment)); },
      );
      badTailCommitted.push(...badTailStaging.flat());
    })(),
    /事件历史与状态根不一致/u,
    'streaming API必须校验tail hash',
  );
  assert.equal(
    badTailStaging.length,
    6,
    '坏tail只能在全部segment callback暂存后被整链校验发现',
  );
  assert.deepEqual(
    badTailCommitted,
    [],
    '坏tail Promise拒绝时调用方不得commit暂存结果',
  );

  let rejectingVisitorCalls = 0;
  let rejectingVisitorSegmentReads = 0;
  const readForRejectingVisitor = (hash) => {
    const chunk = readChunk(hash);
    if (chunk.codec === codec.RUN_STATE_EVENT_SEGMENT_CODEC) {
      rejectingVisitorSegmentReads += 1;
    }
    return chunk;
  };
  await assert.rejects(
    codec.streamVerifiedRunHistorySegments(
      finalFull.metadata,
      readForRejectingVisitor,
      async () => {
        rejectingVisitorCalls += 1;
        await Promise.resolve();
        throw new Error('fixture visitor rejected');
      },
    ),
    /fixture visitor rejected/u,
    'visitor reject必须向调用方传播',
  );
  assert.equal(rejectingVisitorCalls, 1, 'visitor reject后不得调用后续segment visitor');
  assert.equal(rejectingVisitorSegmentReads, 1, 'visitor reject后不得读取后续segment');
  assert.throws(
    () => codec.runHistoryCursorFromRootMetadata({ ...finalFull.metadata, schemaVersion: 1 }),
    /必须先升级/u,
    'schema1不得派生可追加cursor',
  );

  const memoryUsage = process.memoryUsage();
  assert.ok(memoryUsage.rss < 256 * 1024 * 1024, '小型streaming fixture不得越过256MiB RSS');
  console.log(JSON.stringify({
    result: 'passed',
    cursor: codec.runHistoryCursorFromRootMetadata(finalFull.metadata),
    checkpoints: [0, 3, 7],
    logicalSegments: 6,
    frozenV23Oracle: '2051-event suffix crosses 2048; segment/node/root bytes and hashes exact',
    oldFullAppendVsSuffixOnly: 'segment/node/root bytes and hashes exact',
    emptyHistoryAndSuffix: 'canonical and chunk-free',
    sourceReferences: 'forward/reverse/self/unresolved unchanged',
    duplicateEventIds: 'preserved across segments',
    schema2AndSchema3: streamedSummaries,
    rootValidation: 'eventCount and tail hash checked before commit',
    rejectingVisitor: 'one segment read; no later segment decoded',
    rssBytes: memoryUsage.rss,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
