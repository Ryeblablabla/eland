import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serialize } from 'node:v8';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-bounded-decode-v26-'));
const codecBundlePath = path.join(temporaryDirectory, 'run-state-codec.mjs');

function event(index, id = `event-${index}`) {
  return {
    id,
    atMonth: 10 + index,
    orderInMonth: index % 15,
    cellId: index % 4,
    kind: 'environment',
    environment: {
      kind: 'bounded-decode-fixture',
      absoluteMarker: index,
    },
  };
}

function stateFixture(events, lastStepIndexes) {
  return {
    month: events.at(-1)?.atMonth ?? 0,
    config: { endpoint: { kind: 'months', value: 12_000 } },
    lastStep: lastStepIndexes.map((index) => events[index]),
    boundedFixture: { fullEventCount: events.length },
    world: {
      past: events,
      weather: 'stable',
      historyCursor: {
        version: 1,
        eventCount: events.length,
        hotStartIndex: 0,
        tailEventId: events.at(-1)?.id ?? null,
      },
    },
  };
}

function chunksFrom(...snapshots) {
  return new Map(snapshots
    .flatMap((snapshot) => [snapshot.root, ...snapshot.parts])
    .map((chunk) => [chunk.hash, chunk]));
}

function readFrom(chunks) {
  return (hash) => {
    const chunk = chunks.get(hash);
    if (!chunk) throw new Error(`fixture 缺少 chunk ${hash}`);
    return chunk;
  };
}

function rootChunk(codec, metadata) {
  const data = serialize(metadata);
  return {
    codec,
    hash: createHash('sha256').update(codec).update('\0').update(data).digest('hex'),
    rawSize: data.byteLength,
    data,
  };
}

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/run-state-codec.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${codecBundlePath}`,
  ], {
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' },
    stdio: 'pipe',
  });
  const codec = await import(`${pathToFileURL(codecBundlePath).href}?v=${Date.now()}`);
  const segmentOptions = { maxEventsPerSegmentForTests: 2 };

  const shortEvents = Array.from({ length: 7 }, (_, index) => event(index));
  const longEvents = Array.from({ length: 12 }, (_, index) => event(
    index,
    index === 1 || index === 10 ? 'duplicate-id' : `event-${index}`,
  ));
  const shortSnapshot = await codec.encodeSegmentedRunState(
    stateFixture(shortEvents, [0, 1, 5, 6]),
    { mode: 'replace' },
    segmentOptions,
  );
  const longSnapshot = await codec.encodeSegmentedRunState(
    stateFixture(longEvents, [0, 1, 10, 11]),
    { mode: 'replace' },
    segmentOptions,
  );
  const alternateLongState = stateFixture(longEvents, [0, 1, 10, 11]);
  alternateLongState.world.weather = 'alternate-shell';
  const alternateLongSnapshot = await codec.encodeSegmentedRunState(
    alternateLongState,
    { mode: 'replace' },
    segmentOptions,
  );
  const chunks = chunksFrom(shortSnapshot, longSnapshot, alternateLongSnapshot);

  await assert.rejects(
    codec.decodeSegmentedRunStateBounded(
      longSnapshot.root,
      (hash) => hash === longSnapshot.metadata.shellHash
        ? chunks.get(alternateLongSnapshot.metadata.shellHash)
        : readFrom(chunks)(hash),
      { hotEventLimit: 3 },
    ),
    /不属于请求引用/u,
    '自洽的另一 shell chunk 也不得替换 exact root 所引用的 hash',
  );

  const shortDecoded = await codec.decodeSegmentedRunStateBounded(
    shortSnapshot.root,
    readFrom(chunks),
    { hotEventLimit: 3, pinnedEventIndexes: [1] },
  );
  const longDecoded = await codec.decodeSegmentedRunStateBounded(
    longSnapshot.root,
    readFrom(chunks),
    // Unsorted and repeated requests are ordinal pins; index 10 is already hot.
    { hotEventLimit: 3, pinnedEventIndexes: [10, 1, 1] },
  );

  for (const [label, decoded, expectedCount, expectedHotStart] of [
    ['short', shortDecoded, 7, 4],
    ['long', longDecoded, 12, 9],
  ]) {
    assert.equal(decoded.state.world.past.length, 3, `${label}: 尾窗驻留必须有界`);
    assert.equal(decoded.pinnedEvents.length, 1, `${label}: 冷 pin 驻留必须有界`);
    assert.deepEqual(decoded.state.world.historyCursor, {
      version: 1,
      eventCount: expectedCount,
      hotStartIndex: expectedHotStart,
      tailEventId: decoded.state.world.past.at(-1).id,
    }, `${label}: 必须构造绝对 cursor`);
  }

  assert.deepEqual(
    longDecoded.state.world.past.map((fact) => fact.environment.absoluteMarker),
    [9, 10, 11],
    '长历史必须只保留连续尾窗',
  );
  assert.deepEqual(
    longDecoded.pinnedEvents.map(({ absoluteIndex, event: fact }) => ({
      absoluteIndex,
      id: fact.id,
      marker: fact.environment.absoluteMarker,
    })),
    [{ absoluteIndex: 1, id: 'duplicate-id', marker: 1 }],
    '重复 ID 必须按绝对 ordinal 精确保留，热窗 pin 不得重复返回',
  );
  assert.equal(
    longDecoded.state.world.past.some(
      (fact) => fact.id === 'duplicate-id' && fact.environment.absoluteMarker === 10,
    ),
    true,
    '重复 ID 的另一事实必须在尾窗中保持自己的绝对位置和值',
  );

  assert.deepEqual(
    longDecoded.state.lastStep.map((fact) => fact.environment.absoluteMarker),
    [0, 1, 10, 11],
    'lastStep 值必须完整保留',
  );
  assert.strictEqual(
    longDecoded.state.lastStep[1],
    longDecoded.pinnedEvents[0].event,
    '已 pin 的 lastStep 事实必须复用权威对象身份',
  );
  assert.strictEqual(
    longDecoded.state.lastStep[2],
    longDecoded.state.world.past[1],
    '热窗内 lastStep 事实必须复用权威对象身份',
  );
  assert.notStrictEqual(
    longDecoded.state.lastStep[0],
    longEvents[0],
    '未保留的冷 lastStep 仍应来自独立 shell 解码',
  );

  const fullDecoded = await codec.decodeSegmentedRunState(
    longSnapshot.root,
    readFrom(chunks),
  );
  assert.equal(fullDecoded.state.world.past.length, longEvents.length, '完整 decoder 行为不得改变');
  assert.equal(fullDecoded.state.world.historyCursor.hotStartIndex, 0);

  const zeroHotDecoded = await codec.decodeSegmentedRunStateBounded(
    longSnapshot.root,
    readFrom(chunks),
    { hotEventLimit: 0 },
  );
  assert.deepEqual(zeroHotDecoded.state.world.past, [], 'hotEventLimit=0 不得保留尾事件');
  assert.deepEqual(zeroHotDecoded.pinnedEvents, [], '未请求 pin 时不得隐式保留冷事实');
  assert.deepEqual(zeroHotDecoded.state.world.historyCursor, {
    version: 1,
    eventCount: 12,
    hotStartIndex: 12,
    tailEventId: longEvents.at(-1).id,
  }, '零热窗仍必须携带权威绝对 cursor');

  const emptySnapshot = await codec.encodeSegmentedRunState(
    stateFixture([], []),
    { mode: 'replace' },
    segmentOptions,
  );
  const emptyDecoded = await codec.decodeSegmentedRunStateBounded(
    emptySnapshot.root,
    readFrom(chunksFrom(emptySnapshot)),
    { hotEventLimit: 3 },
  );
  assert.deepEqual(emptyDecoded.state.world.past, [], '空历史必须保留空热窗');
  assert.deepEqual(emptyDecoded.pinnedEvents, [], '空历史不得生成 pin');
  assert.deepEqual(emptyDecoded.state.world.historyCursor, {
    version: 1,
    eventCount: 0,
    hotStartIndex: 0,
    tailEventId: null,
  }, '空历史必须构造零值绝对 cursor');

  const badTailRoot = rootChunk(codec.RUN_STATE_ROOT_CODEC, {
    ...longSnapshot.metadata,
    tailEventContentHash: '0'.repeat(64),
  });
  let badTailResult;
  await assert.rejects(async () => {
    badTailResult = await codec.decodeSegmentedRunStateBounded(
      badTailRoot,
      readFrom(chunks),
      { hotEventLimit: 3, pinnedEventIndexes: [1] },
    );
  }, /事件历史与状态根不一致/u, '坏 tail root 必须在整条流后原子拒绝');
  assert.equal(badTailResult, undefined, '坏 root 不得返回部分 state 或 pins');

  const corruptSegmentChunks = new Map(chunks);
  const corruptSource = longSnapshot.parts.find(
    (chunk) => chunk.codec === codec.RUN_STATE_EVENT_SEGMENT_CODEC,
  );
  assert.ok(corruptSource, 'fixture 必须包含事件 segment');
  const corruptData = Buffer.from(corruptSource.data);
  corruptData[0] ^= 0xff;
  corruptSegmentChunks.set(corruptSource.hash, { ...corruptSource, data: corruptData });
  let corruptSegmentResult;
  await assert.rejects(async () => {
    corruptSegmentResult = await codec.decodeSegmentedRunStateBounded(
      longSnapshot.root,
      readFrom(corruptSegmentChunks),
      { hotEventLimit: 3, pinnedEventIndexes: [1] },
    );
  }, /SHA-256 校验失败/u, '坏 segment 必须拒绝整个 bounded restore');
  assert.equal(corruptSegmentResult, undefined, '坏 segment 不得返回部分 state 或 pins');

  const cursorMismatchRoot = rootChunk(codec.RUN_STATE_ROOT_CODEC, {
    ...longSnapshot.metadata,
    eventCount: longSnapshot.metadata.eventCount + 1,
  });
  await assert.rejects(
    codec.decodeSegmentedRunStateBounded(
      cursorMismatchRoot,
      readFrom(chunks),
      { hotEventLimit: 3 },
    ),
    /bounded decode shell history cursor/u,
    'shell 原 cursor 与 root 不一致时必须拒绝',
  );

  const legacyEvents = Array.from({ length: 5 }, (_, index) => event(20 + index));
  const legacyFirstState = stateFixture(legacyEvents.slice(0, 2), [0, 1]);
  delete legacyFirstState.world.historyCursor;
  const legacyFirstSnapshot = await codec.encodeSegmentedRunState(
    legacyFirstState,
    { mode: 'replace' },
    segmentOptions,
  );
  const legacyState = stateFixture(legacyEvents, [3, 4]);
  delete legacyState.world.historyCursor;
  const legacySnapshot = await codec.encodeSegmentedRunState(
    legacyState,
    { mode: 'append', previous: legacyFirstSnapshot.metadata },
    segmentOptions,
  );
  const legacyChunks = chunksFrom(legacyFirstSnapshot, legacySnapshot);
  const legacyDecoded = await codec.decodeSegmentedRunStateBounded(
    legacySnapshot.root,
    readFrom(legacyChunks),
    { hotEventLimit: 2 },
  );
  assert.deepEqual(legacyDecoded.state.world.historyCursor, {
    version: 1,
    eventCount: 5,
    hotStartIndex: 3,
    tailEventId: legacyEvents.at(-1).id,
  }, '无 cursor 的 legacy shell 必须在可信恢复边界补建绝对 cursor');

  const legacyHeadNode = codec.parseRunHistoryNode(
    legacyChunks.get(legacySnapshot.metadata.historyHeadHash),
  );
  const legacyParentNode = codec.parseRunHistoryNode(
    legacyChunks.get(legacyHeadNode.parentHash),
  );
  const badLegacyParentChunk = rootChunk(codec.RUN_HISTORY_NODE_CODEC, {
    ...legacyParentNode,
    startEventIndex: 1,
    totalEventCount: 3,
  });
  const badLegacyHeadChunk = rootChunk(codec.RUN_HISTORY_NODE_CODEC, {
    ...legacyHeadNode,
    parentHash: badLegacyParentChunk.hash,
  });
  const badLegacyRoot = rootChunk(codec.RUN_STATE_ROOT_CODEC, {
    ...legacySnapshot.metadata,
    historyHeadHash: badLegacyHeadChunk.hash,
  });
  const badLegacyChunks = new Map(legacyChunks);
  badLegacyChunks.set(badLegacyParentChunk.hash, badLegacyParentChunk);
  badLegacyChunks.set(badLegacyHeadChunk.hash, badLegacyHeadChunk);
  let badLegacyNodeReads = 0;
  const readBadLegacy = (hash) => {
    const chunk = readFrom(badLegacyChunks)(hash);
    if (chunk.codec === codec.RUN_HISTORY_NODE_CODEC) badLegacyNodeReads += 1;
    return chunk;
  };
  let badLegacyResult;
  await assert.rejects(async () => {
    badLegacyResult = await codec.decodeSegmentedRunStateBounded(
      badLegacyRoot,
      readBadLegacy,
      { hotEventLimit: 2 },
    );
  }, /累计事件数没有严格递减/u, '无 cursor 时仍必须靠完整 node 链拒绝坏累计 eventCount');
  assert.equal(badLegacyResult, undefined, '深层坏 eventCount 不得返回已暂存的尾窗');
  assert.equal(badLegacyNodeReads, 2, '必须先验证 head，再在父 node 的坏 eventCount 处拒绝');

  const identicalFact = event(40, 'identical-event');
  const identicalEvents = [
    { ...identicalFact, environment: { ...identicalFact.environment } },
    event(41),
    event(42),
    event(43),
    { ...identicalFact, environment: { ...identicalFact.environment } },
  ];
  const identicalSnapshot = await codec.encodeSegmentedRunState(
    stateFixture(identicalEvents, [4]),
    { mode: 'replace' },
    segmentOptions,
  );
  const identicalDecoded = await codec.decodeSegmentedRunStateBounded(
    identicalSnapshot.root,
    readFrom(chunksFrom(identicalSnapshot)),
    { hotEventLimit: 0, pinnedEventIndexes: [0] },
  );
  assert.deepEqual(
    identicalDecoded.state.lastStep[0],
    identicalDecoded.pinnedEvents[0].event,
    '完全相同重复事实应保持相同值',
  );
  assert.notStrictEqual(
    identicalDecoded.state.lastStep[0],
    identicalDecoded.pinnedEvents[0].event,
    '只 pin 较早副本时不得把较晚 lastStep 误绑到它的对象身份',
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    shortEventCount: shortSnapshot.metadata.eventCount,
    longEventCount: longSnapshot.metadata.eventCount,
    hotEventCount: longDecoded.state.world.past.length,
    coldPinnedEventCount: longDecoded.pinnedEvents.length,
    duplicatePinMarker: longDecoded.pinnedEvents[0].event.environment.absoluteMarker,
    reverseHistoryNodeReads: badLegacyNodeReads,
    rssBytes: process.memoryUsage().rss,
  })}\n`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
