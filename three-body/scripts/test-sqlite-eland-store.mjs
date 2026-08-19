import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import { brotliCompressSync } from 'node:zlib';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-sqlite-session-store-test-'));
const bundlePath = path.join(temporaryDirectory, 'sqlite-eland-store.mjs');
const dataDirectory = path.join(temporaryDirectory, 'data');

function recoverySnapshot({
  runId = 'live-run',
  civilizationId = 7,
  savedAt = 1_700_000_000_000,
  month = 3,
  seed = 907,
  checkpointTag = 'shared',
} = {}) {
  const checkpoint = brotliCompressSync(serialize({
    month: 0,
    checkpointTag,
    voxels: new Uint16Array([1, 2, 3]),
  }));
  const storedFrame = { branchId: 'main', elapsedMonths: month };
  return {
    schemaVersion: 1,
    savedAt,
    runId,
    civilizationId,
    latestState: {
      civilization: { stage: 'settlement' },
      clock: { elapsedMonths: month },
    },
    latestFrame: {
      civilizationId,
      branchId: 'main',
      elapsedMonths: month,
      calendar: { label: `第 1 年 ${month + 1} 月` },
      society: {
        world: { generator: { seed } },
        agents: [{ state: 'active' }, { state: 'dead' }],
      },
      civilizationEnd: null,
    },
    branches: new Map([
      ['main', {
        id: 'main',
        forkAtMonth: 0,
        createdAt: '2026-08-20T00:00:00.000Z',
        history: [storedFrame],
        frameByMonth: new Map([[month, storedFrame]]),
        snapshots: new Map([[month, { kind: 'checkpoint', data: checkpoint }]]),
      }],
    ]),
    activeBranchId: 'main',
    forkSequence: 0,
    skySample: { toTime: 1 },
  };
}

function managedLive(session = recoverySnapshot()) {
  return {
    schemaVersion: 1,
    touchedAt: 1_700_000_000_100 + session.latestFrame.elapsedMonths,
    lastStepAt: 1_700_000_000_050 + session.latestFrame.elapsedMonths,
    leaseId: 'lease-a',
    creationId: 'creation-a',
    session,
  };
}

const SESSION_CODECS = [
  'eland-session-manifest-v2',
  'eland-session-shell-v2',
  'eland-session-timeline-chunk-v1',
];

function storedChunkHash(codec, data) {
  return createHash('sha256').update(codec).update('\0').update(data).digest('hex');
}

function sessionChunkCount(database) {
  return Number(database.prepare(`
    SELECT COUNT(*) AS count FROM chunks WHERE codec IN (?, ?, ?)
  `).get(...SESSION_CODECS).count);
}

function unreferencedSessionChunkHashes(database) {
  const chunks = database.prepare(`
    SELECT hash, codec, data FROM chunks WHERE codec IN (?, ?, ?)
  `).all(...SESSION_CODECS);
  const chunksByHash = new Map(chunks.map((row) => [String(row.hash), row]));
  const reachable = new Set();
  const roots = database.prepare(`
    SELECT snapshot_hash FROM manual_saves
    UNION
    SELECT snapshot_hash FROM live_sessions
  `).all();
  for (const { snapshot_hash: rootHashValue } of roots) {
    const rootHash = String(rootHashValue);
    const root = chunksByHash.get(rootHash);
    assert.equal(root?.codec, SESSION_CODECS[0]);
    const manifest = deserialize(Buffer.from(root.data));
    reachable.add(rootHash);
    reachable.add(manifest.shellHash);
    for (const chunkHash of manifest.timelineChunkHashes) reachable.add(chunkHash);
  }
  return chunks
    .map((row) => String(row.hash))
    .filter((hash) => !reachable.has(hash))
    .sort();
}

function insertChunk(database, hash, codec, rawSize, data) {
  database.prepare(`
    INSERT INTO chunks(hash, codec, raw_size, data) VALUES (?, ?, ?, ?)
  `).run(hash, codec, rawSize, data);
}

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/sqlite-eland-store.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });

  const { ElandSaveNotFoundError, SqliteElandStore } = await import(
    `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
  );
  const store = new SqliteElandStore(dataDirectory);
  assert.equal(store.currentCivilizationId(), 0);
  assert.equal(store.allocateCivilizationId(), 1);
  store.observeCivilizationId(10);
  store.observeCivilizationId(4);
  store.observeCivilizationId(Number.NaN);
  assert.equal(store.currentCivilizationId(), 10);
  assert.equal(store.allocateCivilizationId(), 11);

  assert.throws(
    () => store.loadManual('missing'),
    (error) => error instanceof ElandSaveNotFoundError && error.message === '存档 missing 不存在',
  );

  const session = recoverySnapshot();
  const manualMeta = store.saveManual(session, '  我的   文明  ');
  assert.equal(manualMeta.label, '我的 文明');
  assert.equal(manualMeta.livingPeople, 1);
  assert.deepEqual(store.listManualSaves(), [manualMeta]);
  assert.deepEqual(store.loadManual(manualMeta.id), { meta: manualMeta, session });

  const live = managedLive(session);
  const firstLiveSummary = store.saveLiveSession(live);
  assert.equal(firstLiveSummary.runId, 'live-run');
  assert.equal(firstLiveSummary.elapsedMonths, 3);
  assert.deepEqual(store.loadLiveSession('live-run'), live);
  assert.equal(store.loadLiveSession('missing-live'), null);
  assert.deepEqual(store.listLiveSessions(), [firstLiveSummary]);

  const database = new DatabaseSync(store.filePath());
  const chunksAfterFirstLiveSave = sessionChunkCount(database);
  store.saveLiveSession(live);
  const chunksAfterSecondLiveSave = sessionChunkCount(database);
  assert.equal(chunksAfterSecondLiveSave, chunksAfterFirstLiveSave, '相同快照应复用内容块');
  assert.deepEqual(unreferencedSessionChunkHashes(database), []);

  const sessionManifest = database.prepare(`
    SELECT chunks.hash, chunks.codec, chunks.raw_size, chunks.data
    FROM live_sessions JOIN chunks ON chunks.hash = live_sessions.snapshot_hash
    WHERE live_sessions.run_id = ?
  `).get('live-run');
  assert.equal(sessionManifest.codec, 'eland-session-manifest-v2');
  assert.equal(Number(sessionManifest.raw_size), sessionManifest.data.byteLength);
  const manifest = deserialize(Buffer.from(sessionManifest.data));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(typeof manifest.shellHash, 'string');
  assert.equal(manifest.timelineChunkHashes.length, 1);
  assert.equal(
    database.prepare('SELECT codec FROM chunks WHERE hash = ?').get(manifest.shellHash).codec,
    'eland-session-shell-v2',
  );
  assert.equal(
    database.prepare('SELECT codec FROM chunks WHERE hash = ?').get(manifest.timelineChunkHashes[0]).codec,
    'eland-session-timeline-chunk-v1',
  );
  const sharedTimelineHash = manifest.timelineChunkHashes[0];
  const firstLiveRootHash = sessionManifest.hash;

  const firstUpdate = managedLive(recoverySnapshot({
    month: 4,
    savedAt: 1_700_000_000_010,
    checkpointTag: 'replacement-one',
  }));
  store.saveLiveSession(firstUpdate);
  const chunksAfterFirstUpdate = sessionChunkCount(database);
  assert.deepEqual(unreferencedSessionChunkHashes(database), [], 'live upsert 后不应遗留会话孤儿块');
  assert.equal(
    Number(database.prepare('SELECT COUNT(*) AS count FROM chunks WHERE hash = ?')
      .get(firstLiveRootHash).count),
    0,
    '旧 live manifest 应被回收',
  );
  assert.equal(
    Number(database.prepare('SELECT COUNT(*) AS count FROM chunks WHERE hash = ?')
      .get(sharedTimelineHash).count),
    1,
    '仍被手动存档引用的共享时间线块不得删除',
  );
  assert.deepEqual(store.loadManual(manualMeta.id), { meta: manualMeta, session });

  const updatedLive = managedLive(recoverySnapshot({
    month: 5,
    savedAt: 1_700_000_000_020,
    checkpointTag: 'replacement-two',
  }));
  store.saveLiveSession(updatedLive);
  assert.equal(
    sessionChunkCount(database),
    chunksAfterFirstUpdate,
    '连续 live upsert 不应累积会话块',
  );
  assert.deepEqual(unreferencedSessionChunkHashes(database), []);
  assert.deepEqual(store.loadLiveSession('live-run'), updatedLive, '同一运行应原子更新为最新快照');
  database.close();
  store.close();

  const injector = new DatabaseSync(path.join(dataDirectory, 'eland.sqlite3'));
  const orphanTimelineData = Buffer.from('orphan session timeline');
  const orphanTimelineHash = storedChunkHash(SESSION_CODECS[2], orphanTimelineData);
  const orphanShellData = Buffer.from('orphan session shell');
  const orphanShellHash = storedChunkHash(SESSION_CODECS[1], orphanShellData);
  const orphanManifestData = serialize({
    schemaVersion: 1,
    shellHash: orphanShellHash,
    timelineChunkHashes: [orphanTimelineHash],
  });
  const orphanManifestHash = storedChunkHash(SESSION_CODECS[0], orphanManifestData);
  const runRaw = serialize({ kind: 'unreferenced-run-chunk' });
  const runData = brotliCompressSync(runRaw);
  const runHash = createHash('sha256').update(runRaw).digest('hex');
  injector.exec('BEGIN IMMEDIATE');
  try {
    insertChunk(injector, orphanTimelineHash, SESSION_CODECS[2], orphanTimelineData.byteLength, orphanTimelineData);
    insertChunk(injector, orphanShellHash, SESSION_CODECS[1], orphanShellData.byteLength, orphanShellData);
    insertChunk(injector, orphanManifestHash, SESSION_CODECS[0], orphanManifestData.byteLength, orphanManifestData);
    insertChunk(injector, runHash, 'v8-br-v1', runRaw.byteLength, runData);
    injector.exec('COMMIT');
  } catch (error) {
    injector.exec('ROLLBACK');
    throw error;
  }
  assert.deepEqual(
    unreferencedSessionChunkHashes(injector),
    [orphanManifestHash, orphanShellHash, orphanTimelineHash].sort(),
  );
  injector.close();

  const reopened = new SqliteElandStore(dataDirectory);
  assert.equal(reopened.currentCivilizationId(), 11);
  assert.deepEqual(reopened.listManualSaves(), [manualMeta]);
  assert.deepEqual(reopened.loadManual(manualMeta.id), { meta: manualMeta, session });
  assert.deepEqual(reopened.loadLiveSession('live-run'), updatedLive);
  const postStartup = new DatabaseSync(path.join(dataDirectory, 'eland.sqlite3'), { readOnly: true });
  assert.deepEqual(unreferencedSessionChunkHashes(postStartup), [], '构造 store 时应清理既有会话孤儿块');
  for (const hash of [orphanManifestHash, orphanShellHash, orphanTimelineHash]) {
    assert.equal(
      Number(postStartup.prepare('SELECT COUNT(*) AS count FROM chunks WHERE hash = ?').get(hash).count),
      0,
    );
  }
  assert.equal(
    Number(postStartup.prepare('SELECT COUNT(*) AS count FROM chunks WHERE hash = ? AND codec = ?')
      .get(runHash, 'v8-br-v1').count),
    1,
    '会话 GC 绝不能删除 v8-br-v1 运行块',
  );
  postStartup.close();
  assert.equal(reopened.deleteLiveSession('live-run'), true);
  assert.equal(reopened.deleteLiveSession('live-run'), false);
  reopened.close();

  const inspection = new DatabaseSync(path.join(dataDirectory, 'eland.sqlite3'), { readOnly: true });
  assert.equal(inspection.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(Number(inspection.prepare('SELECT COUNT(*) AS count FROM manual_saves').get().count), 1);
  assert.equal(Number(inspection.prepare('SELECT COUNT(*) AS count FROM live_sessions').get().count), 0);
  assert.deepEqual(unreferencedSessionChunkHashes(inspection), []);
  assert.equal(
    Number(inspection.prepare('SELECT COUNT(*) AS count FROM chunks WHERE hash = ? AND codec = ?')
      .get(runHash, 'v8-br-v1').count),
    1,
  );
  assert.equal(
    Number(inspection.prepare('SELECT integer_value FROM campaign_state WHERE key = ?')
      .get('civilization-high-water-mark').integer_value),
    11,
  );
  inspection.close();

  console.log('sqlite ELAND store tests passed (manifest-v2/GC/shared/restart/high-water)');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
