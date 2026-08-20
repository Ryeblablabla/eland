import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serialize } from 'node:v8';
import { brotliCompressSync } from 'node:zlib';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-session-parts-codec-test-'));
const codecBundlePath = path.join(temporaryDirectory, 'session-snapshot-codec.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/session-snapshot-codec.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${codecBundlePath}`,
  ], { stdio: 'pipe' });

  const {
    createSessionTimelineChunkReference,
    decodeSessionSnapshotParts,
    encodeSessionSnapshotParts,
    isSessionTimelineChunkReference,
    replaceSessionTimelineChunksWithReferences,
    resolveSessionTimelineChunk,
  } = await import(
    `${pathToFileURL(codecBundlePath).href}?test=${Date.now()}`
  );
  const checkpointData = brotliCompressSync(serialize({ month: 0, people: ['a', 'b'] }));
  const deltaData = brotliCompressSync(serialize({ month: 1, voxelIndices: new Uint32Array([4, 9]) }));
  const session = {
    schemaVersion: 1,
    savedAt: 1_700_000_000_000,
    runId: 'codec-run',
    civilizationId: 42,
    latestState: {
      civilization: { stage: 'settlement' },
      sample: new Uint16Array([3, 5, 8]),
      buffer: Buffer.from([11, 13, 17]),
    },
    latestFrame: { authorityRevision: 'authority-codec', branchId: 'main', elapsedMonths: 1 },
    branches: new Map([
      ['main', {
        id: 'main',
        frameByMonth: new Map([[1, { authorityRevision: 'authority-codec', elapsedMonths: 1 }]]),
        snapshots: new Map([
          [0, { kind: 'checkpoint', data: checkpointData }],
          [1, { kind: 'delta', data: deltaData }],
        ]),
      }],
    ]),
    activeBranchId: 'main',
  };
  const managed = {
    schemaVersion: 1,
    touchedAt: 11,
    lastStepAt: 12,
    leaseId: 'lease',
    session,
  };

  const parts = encodeSessionSnapshotParts(managed);
  assert.equal(parts.chunks.length, 2, 'checkpoint 与 delta 应独立存储');
  assert.deepEqual(parts.chunks, [checkpointData, deltaData], '已压缩时间线块不得再次编码');
  assert.deepEqual(decodeSessionSnapshotParts(parts), managed, 'parts 应完整还原原生 V8 类型');
  assert.ok(
    Buffer.isBuffer(session.branches.get('main').snapshots.get(0).data),
    '编码不得修改输入会话',
  );

  const hashes = ['a'.repeat(64), 'b'.repeat(64)];
  const lazyManaged = decodeSessionSnapshotParts({
    compressedShell: parts.compressedShell,
    chunks: hashes.map(createSessionTimelineChunkReference),
  });
  const lazyCheckpoint = lazyManaged.session.branches.get('main').snapshots.get(0).data;
  assert.ok(isSessionTimelineChunkReference(lazyCheckpoint), 'shell index 应映射成 hash 引用');
  assert.equal(
    resolveSessionTimelineChunk(lazyCheckpoint, (reference) => {
      assert.equal(reference.__elandSessionChunkV2, hashes[0]);
      return checkpointData;
    }),
    checkpointData,
    '按需 resolver 应只解析被访问的数据块',
  );

  replaceSessionTimelineChunksWithReferences(managed, hashes);
  assert.ok(
    isSessionTimelineChunkReference(session.branches.get('main').snapshots.get(0).data),
    '落库成功后应能原位释放活动分支 Buffer',
  );
  const mixedDelta = Buffer.from(deltaData);
  session.branches.get('main').snapshots.set(2, { kind: 'delta', data: mixedDelta });
  const mixedParts = encodeSessionSnapshotParts(managed);
  assert.ok(isSessionTimelineChunkReference(mixedParts.chunks[0]), '旧引用应直接复用');
  assert.equal(mixedParts.chunks[2], mixedDelta, '新 Buffer 应保留给 store hash/insert');
  assert.throws(
    () => decodeSessionSnapshotParts({ compressedShell: parts.compressedShell, chunks: [] }),
    /不存在的数据块/u,
    '缺失的 SQLite 时间线块必须被拒绝',
  );

  console.log('session snapshot parts codec tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
