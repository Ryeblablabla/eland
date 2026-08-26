import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-run-successor-'));
const bundlePath = path.join(temporaryDirectory, 'run-state-codec.mjs');

function event(id, atMonth, detail = id) {
  return {
    id,
    kind: 'environment',
    atMonth,
    orderInMonth: 0,
    planningTick: 1,
    orderInTick: 0,
    cellId: 0,
    change: 'condition',
    result: detail,
    diff: { detail },
  };
}

function state(history, checkpointLabel) {
  return {
    schemaVersion: 17,
    checkpointLabel,
    clock: { elapsedMonths: history.at(-1)?.atMonth ?? 0 },
    world: { past: history },
  };
}

function mutableChunk(chunk) {
  return { ...chunk, data: Buffer.from(chunk.data) };
}

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/run-state-codec.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], {
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' },
    stdio: 'pipe',
  });
  const codec = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
  const chunks = new Map();
  const store = (snapshot) => {
    for (const chunk of [...snapshot.parts, snapshot.root]) chunks.set(chunk.hash, chunk);
    return snapshot;
  };
  const readChunk = (hash) => {
    const chunk = chunks.get(hash);
    if (!chunk) throw new Error(`fixture missing chunk ${hash}`);
    return chunk;
  };
  const append = async (previous, fullHistory, checkpointLabel) => store(
    await codec.encodeSegmentedRunState(
      state(fullHistory, checkpointLabel),
      { mode: 'append', previous: previous.metadata },
      { maxEventsPerSegmentForTests: 2 },
    ),
  );

  const prefix = Array.from({ length: 4_096 }, (_, index) => (
    event(`prefix-${index}`, Math.floor(index / 64), `prefix-${index}`)
  ));
  const base = store(await codec.encodeSegmentedRunState(
    state(prefix, 'base'),
    { mode: 'replace' },
  ));
  const firstSuffix = [
    event('suffix-a-1', 70),
    event('suffix-a-2', 70),
    event('suffix-a-3', 71),
  ];
  const firstHistory = [...prefix, ...firstSuffix];
  const first = await append(base, firstHistory, 'first');
  const secondSuffix = [
    event('suffix-b-1', 72),
    event('suffix-b-2', 72),
    event('suffix-b-3', 73),
  ];
  const secondHistory = [...firstHistory, ...secondSuffix];
  const second = await append(first, secondHistory, 'second');

  const baseHead = codec.parseRunHistoryNode(readChunk(base.metadata.historyHeadHash));
  const prefixSegmentHashes = new Set(baseHead.segments.map((reference) => reference.hash));
  let prefixSegmentReads = 0;
  const visited = [];
  const positions = [];
  const legal = await codec.streamVerifiedRunHistorySuccessorSegments(
    base.root,
    second.root,
    (hash) => {
      if (prefixSegmentHashes.has(hash)) prefixSegmentReads += 1;
      return readChunk(hash);
    },
    (events, position) => {
      visited.push(...events);
      positions.push({ ...position, count: events.length });
    },
  );
  assert.deepEqual(
    visited.map((item) => item.id),
    [...firstSuffix, ...secondSuffix].map((item) => item.id),
    '多 node successor 必须只按权威顺序流出完整 suffix',
  );
  assert.deepEqual(
    positions.map(({ startEventIndex, count }) => ({ startEventIndex, count })),
    [
      { startEventIndex: prefix.length, count: 2 },
      { startEventIndex: prefix.length + 2, count: 1 },
      { startEventIndex: prefix.length + 3, count: 2 },
      { startEventIndex: prefix.length + 5, count: 1 },
    ],
  );
  assert.equal(prefixSegmentReads, 0, 'successor stream 不得重读 previous root 的历史事件段');
  assert.equal(legal.suffixEventCount, firstSuffix.length + secondSuffix.length);
  assert.equal(legal.previousRootHash, base.root.hash);
  assert.equal(legal.nextRootHash, second.root.hash);
  assert.ok(Object.isFrozen(legal) && Object.isFrozen(legal.previous) && Object.isFrozen(legal.next));
  assert.equal(codec.MAX_VERIFIED_RUN_HISTORY_SUCCESSOR_NODES, 4_096);
  assert.equal(codec.MAX_VERIFIED_RUN_HISTORY_SUCCESSOR_SEGMENT_REFERENCES, 16_384);

  let frozenVisitedEvent;
  const immutableReceipt = await codec.streamVerifiedRunHistorySuccessorSegments(
    base.root,
    first.root,
    readChunk,
    (events) => {
      assert.ok(Object.isFrozen(events), 'visitor 收到的 segment 数组必须冻结');
      assert.ok(Object.isFrozen(events[0]) && Object.isFrozen(events[0].diff), 'event 与 nested diff 必须递归冻结');
      frozenVisitedEvent ??= events[0];
      const originalDetail = events[0].diff.detail;
      assert.throws(() => {
        events[0].diff.detail = 'visitor-tamper';
      }, TypeError, 'visitor 不得改写 nested diff');
      assert.equal(events[0].diff.detail, originalDetail);
    },
  );
  assert.equal(immutableReceipt.previousRootHash, base.root.hash);
  assert.equal(immutableReceipt.nextRootHash, first.root.hash);
  assert.equal(frozenVisitedEvent.diff.detail, firstSuffix[0].diff.detail, 'visitor mutation 失败后事实内容不得漂移');

  let idempotentVisits = 0;
  const idempotent = await codec.streamVerifiedRunHistorySuccessorSegments(
    second.root,
    second.root,
    readChunk,
    () => { idempotentVisits += 1; },
  );
  assert.equal(idempotent.suffixEventCount, 0);
  assert.equal(idempotentVisits, 0, '相同 exact root 必须是零 visitor 的幂等 successor');

  const firstHead = codec.parseRunHistoryNode(readChunk(first.metadata.historyHeadHash));
  assert.equal(firstHead.segments.length, 2, 'staging fixture 需要至少两个 suffix segment');
  const lateSegmentHash = firstHead.segments[1].hash;
  const corruptLateSegment = mutableChunk(readChunk(lateSegmentHash));
  corruptLateSegment.data[0] ^= 0xff;
  const stablePublishedAccumulator = Object.freeze(['previous-published-value']);
  let publishedAccumulator = stablePublishedAccumulator;
  let stagedEventCount = 0;
  const stageThenPublish = async (segmentReader, failSecondVisitor = false) => {
    const staged = [];
    let visitorCount = 0;
    const receipt = await codec.streamVerifiedRunHistorySuccessorSegments(
      base.root,
      first.root,
      segmentReader,
      (events) => {
        visitorCount += 1;
        staged.push(...events.map((item) => item.id));
        stagedEventCount = staged.length;
        if (failSecondVisitor && visitorCount === 2) throw new Error('fixture late visitor failed');
      },
    );
    publishedAccumulator = Object.freeze(staged);
    return receipt;
  };
  await assert.rejects(
    stageThenPublish((hash) => (hash === lateSegmentHash ? corruptLateSegment : readChunk(hash))),
    /SHA-256/u,
    '后段损坏时 successor stream 不得返回成功 receipt',
  );
  assert.equal(stagedEventCount, 2, '后段损坏前首段必须已经进入私有 staging');
  assert.strictEqual(publishedAccumulator, stablePublishedAccumulator, '后段损坏不得 swap published accumulator');
  stagedEventCount = 0;
  await assert.rejects(
    stageThenPublish(readChunk, true),
    /fixture late visitor failed/u,
    '后段 visitor 失败时 successor stream 不得返回成功 receipt',
  );
  assert.equal(stagedEventCount, 3, '失败 visitor 的段也只能停留在私有 staging');
  assert.strictEqual(publishedAccumulator, stablePublishedAccumulator, 'visitor 失败不得 swap published accumulator');

  const commonTail = event('branch-common-tail', 75, 'identical-tail-content');
  const branchAHistory = [...prefix, event('branch-a', 74), commonTail];
  const branchBHistory = [...prefix, event('branch-b', 74), commonTail];
  const branchA = await append(base, branchAHistory, 'branch-a');
  const branchB = await append(base, branchBHistory, 'branch-b');
  assert.equal(branchA.metadata.lineageId, branchB.metadata.lineageId);
  assert.equal(branchA.metadata.eventCount, branchB.metadata.eventCount);
  assert.equal(branchA.metadata.tailEventContentHash, branchB.metadata.tailEventContentHash);
  assert.notEqual(branchA.metadata.historyHeadHash, branchB.metadata.historyHeadHash);
  await assert.rejects(
    codec.streamVerifiedRunHistorySuccessorSegments(branchA.root, branchB.root, readChunk, () => {}),
    /零事件 suffix/u,
    '相同 lineage/count/tail 的 alternate head 不得冒充幂等 successor',
  );

  const branchBNextHistory = [...branchBHistory, event('branch-b-next', 76)];
  const branchBNext = await append(branchB, branchBNextHistory, 'branch-b-next');
  await assert.rejects(
    codec.streamVerifiedRunHistorySuccessorSegments(branchA.root, branchBNext.root, readChunk, () => {}),
    /未精确到达 previous root/u,
    'new chain 在 previous count 指向 alternate parent 时必须拒绝',
  );

  const crossingHistory = [
    ...prefix,
    event('crossing-1', 74),
    event('crossing-2', 75),
    event('crossing-3', 76),
    event('crossing-4', 77),
  ];
  const crossing = await append(base, crossingHistory, 'crossing');
  await assert.rejects(
    codec.streamVerifiedRunHistorySuccessorSegments(branchA.root, crossing.root, readChunk, () => {}),
    /跨过 previous root/u,
    '一个 node 的 start 早于 previous count 时不得切开 node 伪造 successor',
  );

  await assert.rejects(
    codec.streamVerifiedRunHistorySuccessorSegments(
      base.root,
      first.root,
      (hash) => (hash === first.metadata.historyHeadHash
        ? readChunk(branchA.metadata.historyHeadHash)
        : readChunk(hash)),
      () => {},
    ),
    /不属于请求引用/u,
    'readChunk(A) 返回自洽 chunk B 必须拒绝',
  );

  const corruptHead = mutableChunk(readChunk(first.metadata.historyHeadHash));
  corruptHead.data[0] ^= 0xff;
  await assert.rejects(
    codec.streamVerifiedRunHistorySuccessorSegments(
      base.root,
      first.root,
      (hash) => (hash === first.metadata.historyHeadHash ? corruptHead : readChunk(hash)),
      () => {},
    ),
    /SHA-256/u,
    '引用 hash 相同但内容损坏的 node 必须拒绝',
  );

  const mutablePreviousRoot = mutableChunk(base.root);
  const mutableNextRoot = mutableChunk(second.root);
  let mutatedRoots = false;
  const mutationSafe = await codec.streamVerifiedRunHistorySuccessorSegments(
    mutablePreviousRoot,
    mutableNextRoot,
    readChunk,
    async () => {
      if (!mutatedRoots) {
        mutatedRoots = true;
        mutablePreviousRoot.hash = 'f'.repeat(64);
        mutablePreviousRoot.data.fill(0);
        mutableNextRoot.codec = 'mutated-after-await';
        mutableNextRoot.data.fill(0);
        await Promise.resolve();
      }
    },
  );
  assert.equal(mutationSafe.previousRootHash, base.root.hash);
  assert.equal(mutationSafe.nextRootHash, second.root.hash);
  assert.equal(mutationSafe.suffixEventCount, firstSuffix.length + secondSuffix.length);

  const replacement = store(await codec.encodeSegmentedRunState(
    state(secondHistory, 'replacement-lineage'),
    { mode: 'replace' },
  ));
  assert.notEqual(replacement.metadata.lineageId, base.metadata.lineageId);
  await assert.rejects(
    codec.streamVerifiedRunHistorySuccessorSegments(base.root, replacement.root, readChunk, () => {}),
    /lineage/u,
    'replace lineage 不得续接旧 basis',
  );

  const shellOnly = store(await codec.encodeSegmentedRunStateFromHistorySuffix(
    state([], 'shell-only-rewrite'),
    codec.runHistoryCursorFromRootMetadata(branchA.metadata),
    [],
  ));
  assert.notEqual(shellOnly.root.hash, branchA.root.hash);
  assert.equal(shellOnly.metadata.historyHeadHash, branchA.metadata.historyHeadHash);
  assert.equal(shellOnly.metadata.eventCount, branchA.metadata.eventCount);
  await assert.rejects(
    codec.streamVerifiedRunHistorySuccessorSegments(branchA.root, shellOnly.root, readChunk, () => {}),
    /零事件 suffix/u,
    '不同 exact root 的 shell-only rewrite 不得作为零 suffix successor',
  );

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1024 * 1024, 'successor stream fixture RSS 不得超过 256 MiB');
  console.log(JSON.stringify({
    result: 'passed',
    prefixEventCount: prefix.length,
    suffixEventCount: legal.suffixEventCount,
    suffixSegmentCount: positions.length,
    rssBytes,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
