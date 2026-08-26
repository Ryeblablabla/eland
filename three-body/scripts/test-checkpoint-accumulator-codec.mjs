import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-checkpoint-accumulator-'));
const accumulatorPath = path.join(temporaryDirectory, 'checkpoint-accumulator.mjs');
const stateCodecPath = path.join(temporaryDirectory, 'run-state-codec.mjs');
const artifactsPath = path.join(temporaryDirectory, 'evolution-artifacts.mjs');
const childEnvironment = { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' };

function environmentEvent(absoluteIndex, atMonth) {
  return {
    id: `event-${absoluteIndex}`,
    atMonth,
    orderInMonth: absoluteIndex,
    cellId: absoluteIndex,
    kind: 'environment',
    change: 'material',
    result: `environment ${absoluteIndex}`,
    diff: { absoluteIndex },
  };
}

function decisionEvent(absoluteIndex, atMonth, usedModel) {
  return {
    id: `event-${absoluteIndex}`,
    atMonth,
    orderInMonth: absoluteIndex,
    cellId: absoluteIndex,
    kind: 'decision',
    who: `person-${absoluteIndex % 2}`,
    usedModel,
    result: `decision ${absoluteIndex}`,
    diff: { absoluteIndex },
  };
}

function stateAt({ month, events, hotStartIndex = 0, stage = '自然群体' }) {
  const eventCount = hotStartIndex + events.length;
  return {
    schemaVersion: 17,
    seed: 4701,
    branchId: 'root-4701-fixture',
    clock: { unit: 'month', elapsedMonths: month, monthsPerYear: 12 },
    world: {
      past: events,
      historyCursor: {
        version: 1,
        eventCount,
        hotStartIndex,
        tailEventId: events.at(-1)?.id ?? null,
      },
    },
    people: [
      { id: 'person-0', bornAtMonth: 0 },
      { id: 'person-1', bornAtMonth: 0, diedAtMonth: month >= 2 ? 2 : undefined },
    ],
    civilization: {
      stage,
      civilizationIndex: { total: month, components: { fixture: month } },
    },
    derived: {
      milestones: month >= 2
        ? [{ id: 'fixture-milestone', label: 'fixture', note: 'fixture', evidenceEventIds: [] }]
        : [],
    },
  };
}

function addEncodedChunks(chunks, encoded) {
  for (const chunk of [encoded.root, ...encoded.parts]) {
    chunks.set(chunk.hash, { ...chunk, data: Buffer.from(chunk.data) });
  }
}

function boundaryFor(state, encoded, revision) {
  return {
    runId: 'checkpoint-accumulator-fixture',
    revision,
    month: state.clock.elapsedMonths,
    stateHash: encoded.root.hash,
    rootSchemaVersion: encoded.metadata.schemaVersion,
    shellHash: encoded.metadata.shellHash,
    historyLineageId: encoded.metadata.lineageId,
    historyHeadHash: encoded.metadata.historyHeadHash,
    eventCount: encoded.metadata.eventCount,
    tailEventId: state.world.historyCursor.tailEventId,
    tailEventContentHash: encoded.metadata.tailEventContentHash,
  };
}

function cloneChunk(chunk) {
  return { ...chunk, data: Buffer.from(chunk.data) };
}

try {
  for (const [entry, outfile] of [
    ['server/checkpoint-accumulator.ts', accumulatorPath],
    ['server/run-state-codec.ts', stateCodecPath],
    ['server/evolution-artifacts.ts', artifactsPath],
  ]) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entry,
      '--bundle',
      '--platform=node',
      '--format=esm',
      `--outfile=${outfile}`,
    ], { env: childEnvironment, stdio: 'pipe' });
  }

  const accumulatorCodec = await import(
    `${pathToFileURL(accumulatorPath).href}?v=${Date.now()}`
  );
  const stateCodec = await import(`${pathToFileURL(stateCodecPath).href}?v=${Date.now()}`);
  const artifacts = await import(`${pathToFileURL(artifactsPath).href}?v=${Date.now()}`);

  const prefixEvents = [
    environmentEvent(0, 1),
    decisionEvent(1, 1, false),
    decisionEvent(2, 1, true),
  ];
  const prefixState = stateAt({ month: 1, events: prefixEvents });
  const prefixEncoded = await stateCodec.encodeSegmentedRunState(
    prefixState,
    { mode: 'replace' },
    { maxEventsPerSegmentForTests: 2 },
  );
  const chunks = new Map();
  addEncodedChunks(chunks, prefixEncoded);
  const readChunk = (hash) => {
    const chunk = chunks.get(hash);
    if (!chunk) throw new Error(`missing fixture chunk ${hash}`);
    return cloneChunk(chunk);
  };
  const prefixBoundary = boundaryFor(prefixState, prefixEncoded, 1);
  const prefixAccumulator = await accumulatorCodec.projectCheckpointAccumulatorFromVerifiedRunRoot(
    prefixState,
    prefixEncoded.root,
    readChunk,
    prefixBoundary,
  );
  assert.deepEqual(prefixAccumulator.decisions, { ruleDecisions: 1, modelDecisions: 1 });
  const usage = { inputTokens: 17, outputTokens: 23 };
  assert.deepEqual(
    accumulatorCodec.checkpointForVerifiedAccumulator(prefixState, usage, prefixAccumulator),
    artifacts.checkpointFor(prefixState, usage),
    'genesis verified fold 必须与 checkpointFor 全历史扫描严格等价',
  );

  const prefixSidecar = accumulatorCodec.encodeCheckpointAccumulator(prefixAccumulator);
  const originalBytes = Buffer.from(prefixSidecar.chunk.data);
  const exposedBytes = prefixSidecar.chunk.data;
  exposedBytes.fill(0);
  assert.deepEqual(prefixSidecar.chunk.data, originalBytes,
    'encode 不得暴露 codec 私有字节');
  const decodedPrefix = accumulatorCodec.decodeCheckpointAccumulator(prefixSidecar.chunk, {
    reference: prefixSidecar.reference,
    boundary: prefixBoundary,
  });
  assert.deepEqual(decodedPrefix, prefixAccumulator);
  assert.ok(Object.isFrozen(decodedPrefix));
  assert.ok(Object.isFrozen(decodedPrefix.boundary));
  assert.ok(Object.isFrozen(decodedPrefix.decisions));

  const suffixEvents = [
    decisionEvent(3, 2, false),
    environmentEvent(4, 2),
    decisionEvent(5, 2, true),
  ];
  const boundedTargetState = stateAt({
    month: 2,
    events: suffixEvents,
    hotStartIndex: prefixEvents.length,
    stage: '定居聚落',
  });
  const targetEncoded = await stateCodec.encodeSegmentedRunStateFromHistorySuffix(
    boundedTargetState,
    stateCodec.runHistoryCursorFromRootMetadata(prefixEncoded.metadata),
    suffixEvents,
    { maxEventsPerSegmentForTests: 2 },
  );
  addEncodedChunks(chunks, targetEncoded);
  const targetBoundary = boundaryFor(boundedTargetState, targetEncoded, 2);
  const targetAccumulator = await accumulatorCodec.projectCheckpointAccumulatorFromVerifiedSuccessor(
    decodedPrefix,
    prefixEncoded.root,
    boundedTargetState,
    targetEncoded.root,
    readChunk,
    targetBoundary,
  );
  assert.deepEqual(targetAccumulator.decisions, { ruleDecisions: 2, modelDecisions: 2 });

  const fullTargetState = stateAt({
    month: 2,
    events: [...prefixEvents, ...suffixEvents],
    stage: '定居聚落',
  });
  assert.deepEqual(
    accumulatorCodec.checkpointForVerifiedAccumulator(
      boundedTargetState,
      usage,
      targetAccumulator,
    ),
    artifacts.checkpointFor(fullTargetState, usage),
    '可信 prefix accumulator + exact absolute suffix 必须等价于完整历史扫描',
  );

  const fold = accumulatorCodec.reduceCheckpointDecisionSegmentForTests(
    accumulatorCodec.emptyCheckpointDecisionFoldForTests(),
    prefixEvents,
    0,
  );
  assert.throws(
    () => accumulatorCodec.reduceCheckpointDecisionSegmentForTests(fold, suffixEvents, 2),
    /suffix 重复/u,
  );
  assert.throws(
    () => accumulatorCodec.reduceCheckpointDecisionSegmentForTests(fold, suffixEvents, 4),
    /suffix 缺口/u,
  );
  assert.throws(
    () => accumulatorCodec.reduceCheckpointDecisionSegmentForTests(
      fold,
      [{ ...decisionEvent(3, 2, false), usedModel: 'false' }],
      3,
    ),
    /usedModel 必须是布尔值/u,
  );

  const wrongReference = {
    ...prefixSidecar.reference,
    hash: '0'.repeat(64),
  };
  assert.throws(
    () => accumulatorCodec.decodeCheckpointAccumulator(prefixSidecar.chunk, {
      reference: wrongReference,
      boundary: prefixBoundary,
    }),
    /store-selected content reference/u,
  );
  assert.throws(
    () => accumulatorCodec.decodeCheckpointAccumulator(prefixSidecar.chunk, {
      reference: prefixSidecar.reference,
      boundary: { ...prefixBoundary, stateHash: 'f'.repeat(64) },
    }),
    /expected boundary 不一致/u,
  );
  assert.throws(
    () => accumulatorCodec.decodeCheckpointAccumulator(prefixSidecar.chunk, {
      reference: { kind: 'canonical-digest', domain: 'forged', hash: prefixSidecar.chunk.hash },
      boundary: prefixBoundary,
    }),
    /字段集合无效|content-hash/u,
  );

  const changedBytes = cloneChunk(prefixSidecar.chunk);
  changedBytes.data[0] ^= 0xff;
  assert.throws(
    () => accumulatorCodec.decodeCheckpointAccumulator(changedBytes, {
      reference: prefixSidecar.reference,
      boundary: prefixBoundary,
    }),
    /SHA-256 校验失败/u,
  );

  const parsed = JSON.parse(originalBytes.toString('utf8'));
  const nonCanonicalBytes = Buffer.from(JSON.stringify(parsed, null, 2), 'utf8');
  const nonCanonicalHash = accumulatorCodec.hashCheckpointAccumulatorStoredContent(
    accumulatorCodec.CHECKPOINT_ACCUMULATOR_CODEC,
    nonCanonicalBytes,
  );
  assert.throws(
    () => accumulatorCodec.decodeCheckpointAccumulator({
      hash: nonCanonicalHash,
      codec: accumulatorCodec.CHECKPOINT_ACCUMULATOR_CODEC,
      rawSize: nonCanonicalBytes.byteLength,
      data: nonCanonicalBytes,
    }, {
      reference: {
        kind: 'content-hash',
        codec: accumulatorCodec.CHECKPOINT_ACCUMULATOR_CODEC,
        hash: nonCanonicalHash,
      },
      boundary: prefixBoundary,
    }),
    /不是 canonical 编码/u,
  );
  assert.throws(
    () => accumulatorCodec.encodeCheckpointAccumulator(structuredClone(prefixAccumulator)),
    /未经外部权威边界验证/u,
    '公共形状不得伪造可发布 accumulator',
  );

  const callerOwnedChunk = cloneChunk(prefixSidecar.chunk);
  const snapshot = accumulatorCodec.snapshotCheckpointAccumulatorChunk(callerOwnedChunk);
  callerOwnedChunk.data.fill(0);
  assert.deepEqual(snapshot.data, originalBytes);
  const snapshotBytes = snapshot.data;
  snapshotBytes.fill(0);
  assert.deepEqual(snapshot.data, originalBytes);

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1_024 * 1_024, `fixture RSS ${rssBytes} 超过 256 MiB`);
  console.log(JSON.stringify({
    result: 'passed',
    codec: accumulatorCodec.CHECKPOINT_ACCUMULATOR_CODEC,
    prefixEventCount: prefixAccumulator.boundary.eventCount,
    targetEventCount: targetAccumulator.boundary.eventCount,
    ruleDecisions: targetAccumulator.decisions.ruleDecisions,
    modelDecisions: targetAccumulator.decisions.modelDecisions,
    rssBytes,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
