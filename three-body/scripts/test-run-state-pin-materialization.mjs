import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-run-pin-materialization-'));
const bundlePath = path.join(temporaryDirectory, 'run-state-codec.mjs');

function event(id, absoluteMarker) {
  return {
    id,
    kind: 'environment',
    atMonth: Math.floor(absoluteMarker / 2),
    orderInMonth: absoluteMarker % 2,
    planningTick: 0,
    orderInTick: absoluteMarker,
    cellId: 0,
    change: 'condition',
    result: `exact body ${absoluteMarker}`,
    diff: { absoluteMarker },
  };
}

function state(history, label) {
  return {
    schemaVersion: 17,
    label,
    clock: { elapsedMonths: history.at(-1)?.atMonth ?? 0 },
    world: { past: history },
  };
}

try {
  execFileSync(path.join(workspace, 'node_modules/.bin/esbuild'), [
    'server/run-state-codec.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], {
    cwd: workspace,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' },
    stdio: 'pipe',
  });
  const codec = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
  const prefix = Array.from({ length: 6 }, (_, index) => (
    event(index === 1 ? 'repeated-id' : `prefix-${index}`, index)
  ));
  const suffix = Array.from({ length: 4 }, (_, offset) => {
    const absoluteIndex = prefix.length + offset;
    return event(absoluteIndex === 8 ? 'repeated-id' : `suffix-${absoluteIndex}`, absoluteIndex);
  });
  const base = await codec.encodeSegmentedRunState(
    state(prefix, 'base'),
    { mode: 'replace' },
    { maxEventsPerSegmentForTests: 2 },
  );
  const successor = await codec.encodeSegmentedRunState(
    state([...prefix, ...suffix], 'successor'),
    { mode: 'append', previous: base.metadata },
    { maxEventsPerSegmentForTests: 2 },
  );
  const chunks = new Map();
  for (const chunk of [...base.parts, base.root, ...successor.parts, successor.root]) {
    chunks.set(chunk.hash, chunk);
  }
  const readsByCodec = new Map();
  const readChunk = (hash) => {
    const chunk = chunks.get(hash);
    if (!chunk) throw new Error(`fixture missing chunk ${hash}`);
    readsByCodec.set(chunk.codec, (readsByCodec.get(chunk.codec) ?? 0) + 1);
    return chunk;
  };

  const pins = codec.materializeVerifiedRunHistoryPinnedEvents(
    successor.metadata,
    readChunk,
    [1, 8],
  );
  assert.deepEqual(pins.map(({ absoluteIndex, event: fact }) => ({
    absoluteIndex,
    id: fact.id,
    marker: fact.diff.absoluteMarker,
  })), [
    { absoluteIndex: 1, id: 'repeated-id', marker: 1 },
    { absoluteIndex: 8, id: 'repeated-id', marker: 8 },
  ], '重复事件 ID 也必须按 exact ordinal 取回各自正文');
  assert.equal(readsByCodec.get(codec.RUN_HISTORY_NODE_CODEC), 2,
    '必须验证 successor 到 genesis 的完整节点序号链');
  assert.equal(readsByCodec.get(codec.RUN_STATE_EVENT_SEGMENT_CODEC), 2,
    '只应解压包含请求序号的两个事件分段');
  assert.ok(pins.every((pin) => Object.isFrozen(pin) && Object.isFrozen(pin.event)),
    '物化事实必须成为 codec-owned immutable artifact');

  assert.throws(
    () => codec.materializeVerifiedRunHistoryPinnedEvents(successor.metadata, readChunk, [8, 1]),
    /严格递增/u,
  );
  assert.throws(
    () => codec.materializeVerifiedRunHistoryPinnedEvents(successor.metadata, readChunk, [1, 1]),
    /严格递增/u,
  );
  assert.throws(
    () => codec.materializeVerifiedRunHistoryPinnedEvents(successor.metadata, readChunk, [10]),
    /超出运行历史范围/u,
  );

  const selectedSegmentHash = codec.parseRunHistoryNode(
    chunks.get(base.metadata.historyHeadHash),
  ).segments[0].hash;
  assert.throws(
    () => codec.materializeVerifiedRunHistoryPinnedEvents(
      successor.metadata,
      (hash) => hash === selectedSegmentHash
        ? chunks.get(successor.metadata.historyHeadHash)
        : readChunk(hash),
      [1],
    ),
    /不属于请求引用/u,
    '请求序号对应的正文块不能被另一个自洽 chunk 替换',
  );

  console.log(JSON.stringify({
    ok: true,
    materializedOrdinals: pins.map((pin) => pin.absoluteIndex),
    verifiedNodeReads: readsByCodec.get(codec.RUN_HISTORY_NODE_CODEC),
    decodedEventSegmentReads: readsByCodec.get(codec.RUN_STATE_EVENT_SEGMENT_CODEC),
    maxRssBytes: process.resourceUsage().maxRSS * 1_024,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
