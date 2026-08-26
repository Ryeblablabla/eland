import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-run-continuation-schema-'));
const runStoreBundlePath = path.join(temporaryDirectory, 'sqlite-run-store.mjs');
const elandStoreBundlePath = path.join(temporaryDirectory, 'sqlite-eland-store.mjs');

function hash(character) {
  return character.repeat(64);
}

function databaseFile(dataDirectory) {
  return path.join(dataDirectory, 'eland.sqlite3');
}

function inspect(dataDirectory, operation) {
  const database = new DatabaseSync(databaseFile(dataDirectory));
  try {
    database.exec('PRAGMA foreign_keys = ON');
    return operation(database);
  } finally {
    database.close();
  }
}

function userVersion(dataDirectory) {
  return inspect(dataDirectory, (database) => Number(
    database.prepare('PRAGMA user_version').get().user_version,
  ));
}

function createLegacyV2Database(dataDirectory) {
  mkdirSync(dataDirectory, { recursive: true });
  const database = new DatabaseSync(databaseFile(dataDirectory));
  try {
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(`
      CREATE TABLE chunks (
        hash TEXT PRIMARY KEY,
        codec TEXT NOT NULL,
        raw_size INTEGER NOT NULL CHECK (raw_size >= 0),
        data BLOB NOT NULL
      ) STRICT;

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        state_hash TEXT NOT NULL REFERENCES chunks(hash),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        label TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        elapsed_months INTEGER NOT NULL CHECK (elapsed_months >= 0),
        civilization_no INTEGER NOT NULL CHECK (civilization_no >= 1),
        status TEXT NOT NULL,
        living_agents INTEGER NOT NULL CHECK (living_agents >= 0),
        agent_count INTEGER NOT NULL CHECK (agent_count >= 0),
        event_count INTEGER NOT NULL CHECK (event_count >= 0),
        milestone_count INTEGER NOT NULL CHECK (milestone_count >= 0)
      ) STRICT;

      CREATE TABLE run_checkpoints (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        month INTEGER NOT NULL CHECK (month >= 0),
        state_hash TEXT NOT NULL REFERENCES chunks(hash),
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, revision)
      ) STRICT;

      PRAGMA user_version = 2;
    `);
  } finally {
    database.close();
  }
}

function insertChunk(database, chunkHash, codec = 'fixture-v1') {
  database.prepare(`
    INSERT INTO chunks(hash, codec, raw_size, data) VALUES (?, ?, 1, ?)
  `).run(chunkHash, codec, Buffer.from([1]));
}

function insertContinuation(database, overrides = {}) {
  const row = {
    runId: 'legacy-v2-run',
    revision: 1,
    stateHash: hash('a'),
    rootSchemaVersion: 3,
    shellHash: hash('b'),
    historyLineageId: '01234567-89ab-cdef-8123-456789abcdef',
    historyHeadHash: hash('c'),
    eventCount: 10,
    tailEventId: 'event-9',
    tailEventContentHash: hash('e'),
    hotEventLimit: 3,
    bundleSchemaVersion: 1,
    bundleHash: hash('d'),
    updatedAt: '2026-08-25T00:00:00.000Z',
    ...overrides,
  };
  database.prepare(`
    INSERT INTO run_continuations(
      run_id, revision, state_hash, root_schema_version, shell_hash,
      history_lineage_id, history_head_hash, event_count, tail_event_id,
      tail_event_content_hash, hot_event_limit, bundle_schema_version,
      bundle_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.runId,
    row.revision,
    row.stateHash,
    row.rootSchemaVersion,
    row.shellHash,
    row.historyLineageId,
    row.historyHeadHash,
    row.eventCount,
    row.tailEventId,
    row.tailEventContentHash,
    row.hotEventLimit,
    row.bundleSchemaVersion,
    row.bundleHash,
    row.updatedAt,
  );
}

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/sqlite-run-store.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${runStoreBundlePath}`,
  ], {
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' },
    stdio: 'pipe',
  });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/sqlite-eland-store.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${elandStoreBundlePath}`,
  ], {
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' },
    stdio: 'pipe',
  });

  const { SqliteRunStore } = await import(
    `${pathToFileURL(runStoreBundlePath).href}?v=${Date.now()}`
  );
  const { SqliteElandStore } = await import(
    `${pathToFileURL(elandStoreBundlePath).href}?v=${Date.now()}`
  );

  const elandFirstDirectory = path.join(temporaryDirectory, 'eland-first');
  const elandFirst = new SqliteElandStore(elandFirstDirectory);
  try {
    assert.equal(userVersion(elandFirstDirectory), 2,
      'ElandStore-first 只能建立自己的 v2 基础表');
    assert.equal(inspect(elandFirstDirectory, (database) => Number(database.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_schema
      WHERE type = 'table' AND name = 'run_continuations'
    `).get().count)), 0, 'ElandStore 不得先创建或宣称拥有 v3 continuation schema');
  } finally {
    elandFirst.close();
  }
  const runAfterEland = new SqliteRunStore(elandFirstDirectory);
  try {
    assert.equal(userVersion(elandFirstDirectory), 3,
      'RunStore 必须在完整创建 continuation schema 后升到 v3');
  } finally {
    runAfterEland.close();
  }

  const runFirstDirectory = path.join(temporaryDirectory, 'run-first');
  const runFirst = new SqliteRunStore(runFirstDirectory);
  try {
    assert.equal(userVersion(runFirstDirectory), 3, 'RunStore-first 应直接完整初始化 v3');
  } finally {
    runFirst.close();
  }
  const elandAfterRun = new SqliteElandStore(runFirstDirectory);
  try {
    assert.equal(userVersion(runFirstDirectory), 3, 'ElandStore 不得把 v3 降回 v2');
  } finally {
    elandAfterRun.close();
  }

  const legacyV2Directory = path.join(temporaryDirectory, 'legacy-v2');
  createLegacyV2Database(legacyV2Directory);
  const migrated = new SqliteRunStore(legacyV2Directory);
  try {
    assert.equal(userVersion(legacyV2Directory), 3, '已有 v2 必须由 RunStore 完整升级到 v3');
  } finally {
    migrated.close();
  }

  inspect(legacyV2Directory, (database) => {
    const exactCheckpointIndex = database.prepare(`
      SELECT name, "unique" AS is_unique FROM pragma_index_list('run_checkpoints')
      WHERE name = 'run_checkpoints_exact'
    `).get();
    assert.equal(exactCheckpointIndex?.name, 'run_checkpoints_exact');
    assert.equal(Number(exactCheckpointIndex?.is_unique), 1);
    const continuationTable = database.prepare(`
      SELECT sql FROM sqlite_schema
      WHERE type = 'table' AND name = 'run_continuations'
    `).get();
    assert.match(String(continuationTable?.sql), /\) STRICT$/u);

    for (const [chunkHash, codec] of [
      [hash('a'), 'eland-run-state-root-v1'],
      [hash('b'), 'eland-run-state-shell-v1'],
      [hash('c'), 'eland-run-history-node-v1'],
      [hash('d'), 'eland-run-continuation-v1'],
    ]) insertChunk(database, chunkHash, codec);

    database.prepare(`
      INSERT INTO runs(
        id, state_hash, schema_version, label, created_at, updated_at, revision,
        elapsed_months, civilization_no, status, living_agents, agent_count,
        event_count, milestone_count
      ) VALUES (?, ?, 1, NULL, ?, ?, 1, 0, 1, 'running', 1, 1, 10, 0)
    `).run(
      'legacy-v2-run',
      hash('a'),
      '2026-08-25T00:00:00.000Z',
      '2026-08-25T00:00:00.000Z',
    );
    database.prepare(`
      INSERT INTO run_checkpoints(run_id, revision, month, state_hash, created_at)
      VALUES (?, 1, 0, ?, ?)
    `).run('legacy-v2-run', hash('a'), '2026-08-25T00:00:00.000Z');

    assert.throws(
      () => insertContinuation(database, { revision: 2 }),
      /FOREIGN KEY constraint failed/u,
      'continuation 必须引用同一 run/revision/state_hash exact checkpoint',
    );
    assert.throws(
      () => insertContinuation(database, {
        eventCount: 0,
        tailEventId: null,
        tailEventContentHash: null,
      }),
      /CHECK constraint failed/u,
      '空历史必须同时清空 head、tail ID 与 tail content hash',
    );
    assert.throws(
      () => insertContinuation(database, { bundleHash: hash('f') }),
      /FOREIGN KEY constraint failed/u,
      'continuation bundle 必须引用已存在的 chunk',
    );

    assert.doesNotThrow(() => insertContinuation(database));
    assert.equal(Number(database.prepare(`
      SELECT COUNT(*) AS count FROM run_continuations
    `).get().count), 1);
    const bundleIndex = database.prepare(`
      SELECT name FROM pragma_index_list('run_continuations')
      WHERE name = 'run_continuations_by_bundle_hash'
    `).get();
    assert.equal(bundleIndex?.name, 'run_continuations_by_bundle_hash');
  });

  console.log(JSON.stringify({ result: 'passed', schemaVersion: 3 }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
