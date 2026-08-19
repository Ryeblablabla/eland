import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { deserialize, serialize } from 'node:v8';

import type { ElandSaveSummary } from '../src/game/societyContract';
import type { ElandSessionRecoverySnapshot } from './elandSession';
import {
  decodeSessionSnapshotParts,
  encodeSessionSnapshotParts,
} from './session-snapshot-codec';
import { ELAND_DATABASE_FILENAME, ELAND_DATABASE_SCHEMA_VERSION } from './sqlite-run-store';

const SESSION_MANIFEST_CODEC = 'eland-session-manifest-v2';
const SESSION_SHELL_CODEC = 'eland-session-shell-v2';
const SESSION_TIMELINE_CHUNK_CODEC = 'eland-session-timeline-chunk-v1';
const CAMPAIGN_HIGH_WATER_KEY = 'civilization-high-water-mark';
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

interface StoredSnapshotChunk {
  hash: string;
  codec: string;
  data: Buffer;
}

interface StoredSessionSnapshot {
  root: StoredSnapshotChunk;
  parts: StoredSnapshotChunk[];
}

interface SessionSnapshotManifest {
  schemaVersion: 1;
  shellHash: string;
  timelineChunkHashes: string[];
}

interface SnapshotChunkRow {
  codec: string;
  rawSize: number;
  data: Uint8Array;
}

interface ManualSaveRow {
  snapshotHash: string;
  meta: ElandSaveSummary;
}

interface LiveSessionRow {
  runId: string;
  snapshotHash: string;
  touchedAt: number;
  lastStepAt: number;
  leaseId: string;
  creationId: string;
  savedAt: number;
  civilizationId: number;
  elapsedMonths: number;
  updatedAt: string;
}

interface ElandManualSaveFile {
  schemaVersion: 1;
  meta: ElandSaveSummary;
  session: ElandSessionRecoverySnapshot;
}

export interface ManagedLiveSessionSnapshot {
  schemaVersion: 1;
  touchedAt: number;
  lastStepAt: number;
  leaseId: string;
  creationId?: string;
  session: ElandSessionRecoverySnapshot;
}

export interface LiveSessionSummary {
  runId: string;
  civilizationId: number;
  savedAt: number;
  touchedAt: number;
  lastStepAt: number;
  leaseId: string;
  creationId: string;
  elapsedMonths: number;
  updatedAt: string;
}

export class ElandSaveNotFoundError extends Error {
  constructor(saveId: string) {
    super(`存档 ${saveId} 不存在`);
    this.name = 'ElandSaveNotFoundError';
  }
}

function normalizedLabel(label: string | undefined, snapshot: ElandSessionRecoverySnapshot): string {
  const clean = label?.replace(/\s+/gu, ' ').trim().slice(0, 64);
  return clean || `第 ${snapshot.civilizationId} 号文明 · ${snapshot.latestFrame.calendar.label}`;
}

function validSaveId(saveId: string): boolean {
  return /^save-[0-9a-z-]{12,80}$/u.test(saveId);
}

function isSaveSummary(value: unknown): value is ElandSaveSummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Partial<ElandSaveSummary>;
  return summary.schemaVersion === 1
    && summary.stateSchemaVersion === 17
    && typeof summary.id === 'string'
    && validSaveId(summary.id)
    && typeof summary.label === 'string'
    && typeof summary.createdAt === 'string'
    && typeof summary.updatedAt === 'string'
    && typeof summary.sourceRunId === 'string'
    && Number.isSafeInteger(summary.civilizationId)
    && typeof summary.branchId === 'string'
    && Number.isSafeInteger(summary.elapsedMonths)
    && typeof summary.calendarLabel === 'string'
    && Number.isSafeInteger(summary.worldSeed)
    && Number.isSafeInteger(summary.livingPeople)
    && typeof summary.stage === 'string'
    && typeof summary.ended === 'boolean';
}

function assertSaveFile(value: unknown, expectedSaveId?: string): ElandManualSaveFile {
  if (!value || typeof value !== 'object') throw new Error('手动存档内容无效');
  const file = value as Partial<ElandManualSaveFile>;
  if (file.schemaVersion !== 1 || !isSaveSummary(file.meta) || !file.session) {
    throw new Error(`存档 ${expectedSaveId ?? ''} 的版本或内容不受支持`.replace('  ', ' '));
  }
  if (expectedSaveId && file.meta.id !== expectedSaveId) {
    throw new Error(`存档 ${expectedSaveId} 的索引与内容不一致`);
  }
  if (file.meta.civilizationId !== file.session.civilizationId) {
    throw new Error(`存档 ${file.meta.id} 的文明编号不一致`);
  }
  return file as ElandManualSaveFile;
}

function assertManagedLiveSnapshot(value: unknown, expectedRunId?: string): ManagedLiveSessionSnapshot {
  if (!value || typeof value !== 'object') throw new Error('实时会话快照内容无效');
  const snapshot = value as Partial<ManagedLiveSessionSnapshot>;
  const session = snapshot.session;
  if (snapshot.schemaVersion !== 1
    || !Number.isFinite(snapshot.touchedAt)
    || !Number.isFinite(snapshot.lastStepAt)
    || typeof snapshot.leaseId !== 'string'
    || (snapshot.creationId !== undefined && typeof snapshot.creationId !== 'string')
    || !session
    || session.schemaVersion !== 1
    || typeof session.runId !== 'string'
    || !Number.isSafeInteger(session.civilizationId)
    || !Number.isFinite(session.savedAt)) {
    throw new Error(`实时会话 ${expectedRunId ?? ''} 的版本或内容不受支持`.replace('  ', ' '));
  }
  if (expectedRunId && session.runId !== expectedRunId) {
    throw new Error(`实时会话 ${expectedRunId} 的运行标识与快照不一致`);
  }
  return snapshot as ManagedLiveSessionSnapshot;
}

function storedChunk(codec: string, data: Buffer): StoredSnapshotChunk {
  return {
    hash: storedChunkHash(codec, data),
    codec,
    data,
  };
}

function storedChunkHash(codec: string, data: Uint8Array): string {
  return createHash('sha256').update(codec).update('\0').update(data).digest('hex');
}

function encodeStoredSession(value: unknown): StoredSessionSnapshot {
  const encoded = encodeSessionSnapshotParts(value);
  const shell = storedChunk(SESSION_SHELL_CODEC, encoded.compressedShell);
  const timeline = encoded.chunks.map((chunk) => storedChunk(SESSION_TIMELINE_CHUNK_CODEC, chunk));
  const manifest: SessionSnapshotManifest = {
    schemaVersion: 1,
    shellHash: shell.hash,
    timelineChunkHashes: timeline.map((chunk) => chunk.hash),
  };
  const root = storedChunk(SESSION_MANIFEST_CODEC, serialize(manifest));
  return { root, parts: [shell, ...timeline] };
}

function parseSessionManifest(data: Buffer): SessionSnapshotManifest {
  const parsed = deserialize(data) as Partial<SessionSnapshotManifest>;
  if (parsed.schemaVersion !== 1
    || typeof parsed.shellHash !== 'string'
    || !Array.isArray(parsed.timelineChunkHashes)
    || !parsed.timelineChunkHashes.every((hash) => typeof hash === 'string')) {
    throw new Error('会话快照 manifest 内容无效');
  }
  return parsed as SessionSnapshotManifest;
}

function parseManualRow(row: Record<string, unknown> | undefined): ManualSaveRow | null {
  if (!row) return null;
  return {
    snapshotHash: String(row.snapshot_hash),
    meta: {
      schemaVersion: Number(row.schema_version) as 1,
      stateSchemaVersion: Number(row.state_schema_version) as 17,
      id: String(row.id),
      label: String(row.label),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      sourceRunId: String(row.source_run_id),
      civilizationId: Number(row.civilization_id),
      branchId: String(row.branch_id),
      elapsedMonths: Number(row.elapsed_months),
      calendarLabel: String(row.calendar_label),
      worldSeed: Number(row.world_seed),
      livingPeople: Number(row.living_people),
      stage: String(row.stage) as ElandSaveSummary['stage'],
      ended: Number(row.ended) !== 0,
    },
  };
}

function manualColumnValues(meta: ElandSaveSummary): Array<string | number> {
  return [
    meta.schemaVersion,
    meta.stateSchemaVersion,
    meta.label,
    meta.createdAt,
    meta.updatedAt,
    meta.sourceRunId,
    meta.civilizationId,
    meta.branchId,
    meta.elapsedMonths,
    meta.calendarLabel,
    meta.worldSeed,
    meta.livingPeople,
    meta.stage,
    meta.ended ? 1 : 0,
  ];
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && Buffer.from(left.buffer, left.byteOffset, left.byteLength)
      .equals(Buffer.from(right.buffer, right.byteOffset, right.byteLength));
}

function parseLiveRow(row: Record<string, unknown> | undefined): LiveSessionRow | null {
  if (!row) return null;
  return {
    runId: String(row.run_id),
    snapshotHash: String(row.snapshot_hash),
    touchedAt: Number(row.touched_at),
    lastStepAt: Number(row.last_step_at),
    leaseId: String(row.lease_id),
    creationId: String(row.creation_id),
    savedAt: Number(row.saved_at),
    civilizationId: Number(row.civilization_id),
    elapsedMonths: Number(row.elapsed_months),
    updatedAt: String(row.updated_at),
  };
}

function liveSummary(row: LiveSessionRow): LiveSessionSummary {
  return {
    runId: row.runId,
    civilizationId: row.civilizationId,
    savedAt: row.savedAt,
    touchedAt: row.touchedAt,
    lastStepAt: row.lastStepAt,
    leaseId: row.leaseId,
    creationId: row.creationId,
    elapsedMonths: row.elapsedMonths,
    updatedAt: row.updatedAt,
  };
}

/**
 * Unified SQLite persistence for manual saves, recoverable live sessions, and
 * the civilization-number high-water mark. Run states use the same database
 * and `chunks` content-addressed blob pool through SqliteRunStore.
 */
export class SqliteElandStore {
  private readonly database: DatabaseSync;
  private readonly databaseFile: string;
  private readonly selectChunk: StatementSync;
  private readonly insertChunk: StatementSync;
  private readonly selectManual: StatementSync;
  private readonly insertManual: StatementSync;
  private readonly selectLive: StatementSync;
  private readonly upsertLive: StatementSync;
  private readonly deleteLiveStatement: StatementSync;
  private closed = false;

  constructor(private readonly rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
    this.databaseFile = path.join(rootDir, ELAND_DATABASE_FILENAME);
    this.database = new DatabaseSync(this.databaseFile);
    this.database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    const currentSchemaVersion = Number(
      this.database.prepare('PRAGMA user_version').get()?.user_version ?? 0,
    );
    if (currentSchemaVersion > ELAND_DATABASE_SCHEMA_VERSION) {
      this.database.close();
      throw new Error(
        `SQLite 数据库版本 ${currentSchemaVersion} 高于当前支持的 ${ELAND_DATABASE_SCHEMA_VERSION}`,
      );
    }
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec('PRAGMA synchronous = NORMAL');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        hash TEXT PRIMARY KEY,
        codec TEXT NOT NULL,
        raw_size INTEGER NOT NULL CHECK (raw_size >= 0),
        data BLOB NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS manual_saves (
        id TEXT PRIMARY KEY,
        snapshot_hash TEXT NOT NULL REFERENCES chunks(hash),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        state_schema_version INTEGER NOT NULL CHECK (state_schema_version = 17),
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        civilization_id INTEGER NOT NULL CHECK (civilization_id >= 1),
        branch_id TEXT NOT NULL,
        elapsed_months INTEGER NOT NULL CHECK (elapsed_months >= 0),
        calendar_label TEXT NOT NULL,
        world_seed INTEGER NOT NULL,
        living_people INTEGER NOT NULL CHECK (living_people >= 0),
        stage TEXT NOT NULL,
        ended INTEGER NOT NULL CHECK (ended IN (0, 1))
      ) STRICT;

      CREATE INDEX IF NOT EXISTS manual_saves_by_updated_at
        ON manual_saves(updated_at DESC, id ASC);

      CREATE TABLE IF NOT EXISTS live_sessions (
        run_id TEXT PRIMARY KEY,
        snapshot_hash TEXT NOT NULL REFERENCES chunks(hash),
        touched_at INTEGER NOT NULL,
        last_step_at INTEGER NOT NULL,
        lease_id TEXT NOT NULL,
        creation_id TEXT NOT NULL,
        saved_at INTEGER NOT NULL,
        civilization_id INTEGER NOT NULL CHECK (civilization_id >= 1),
        elapsed_months INTEGER NOT NULL CHECK (elapsed_months >= 0),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS live_sessions_by_touched_at
        ON live_sessions(touched_at DESC, run_id ASC);

      CREATE TABLE IF NOT EXISTS campaign_state (
        key TEXT PRIMARY KEY,
        integer_value INTEGER NOT NULL CHECK (integer_value >= 0),
        updated_at TEXT NOT NULL
      ) STRICT;

      INSERT OR IGNORE INTO campaign_state(key, integer_value, updated_at)
      VALUES ('${CAMPAIGN_HIGH_WATER_KEY}', 0, '1970-01-01T00:00:00.000Z');
    `);
    if (currentSchemaVersion < ELAND_DATABASE_SCHEMA_VERSION) {
      this.database.exec(`PRAGMA user_version = ${ELAND_DATABASE_SCHEMA_VERSION}`);
    }

    this.selectChunk = this.database.prepare(`
      SELECT codec, raw_size, data FROM chunks WHERE hash = ?
    `);
    this.insertChunk = this.database.prepare(`
      INSERT OR IGNORE INTO chunks(hash, codec, raw_size, data) VALUES (?, ?, ?, ?)
    `);
    this.selectManual = this.database.prepare(`
      SELECT id, snapshot_hash, schema_version, state_schema_version, label,
             created_at, updated_at, source_run_id, civilization_id, branch_id,
             elapsed_months, calendar_label, world_seed, living_people, stage, ended
      FROM manual_saves WHERE id = ?
    `);
    this.insertManual = this.database.prepare(`
      INSERT INTO manual_saves(
        id, snapshot_hash, schema_version, state_schema_version, label, created_at,
        updated_at, source_run_id, civilization_id, branch_id, elapsed_months,
        calendar_label, world_seed, living_people, stage, ended
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.selectLive = this.database.prepare(`
      SELECT run_id, snapshot_hash, touched_at, last_step_at, lease_id, creation_id,
             saved_at, civilization_id, elapsed_months, updated_at
      FROM live_sessions WHERE run_id = ?
    `);
    this.upsertLive = this.database.prepare(`
      INSERT INTO live_sessions(
        run_id, snapshot_hash, touched_at, last_step_at, lease_id, creation_id,
        saved_at, civilization_id, elapsed_months, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        snapshot_hash = excluded.snapshot_hash,
        touched_at = excluded.touched_at,
        last_step_at = excluded.last_step_at,
        lease_id = excluded.lease_id,
        creation_id = excluded.creation_id,
        saved_at = excluded.saved_at,
        civilization_id = excluded.civilization_id,
        elapsed_months = excluded.elapsed_months,
        updated_at = excluded.updated_at
    `);
    this.deleteLiveStatement = this.database.prepare('DELETE FROM live_sessions WHERE run_id = ?');
    this.transaction(() => this.collectUnreferencedSessionChunks());
  }

  dataDirectory(): string {
    return this.rootDir;
  }

  filePath(): string {
    return this.databaseFile;
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // SQLite may already have rolled back; preserve the original error.
      }
      throw error;
    }
  }

  private storeChunk(chunk: StoredSnapshotChunk): void {
    const result = this.insertChunk.run(chunk.hash, chunk.codec, chunk.data.byteLength, chunk.data);
    if (Number(result.changes) > 0) return;
    const row = this.selectChunk.get(chunk.hash);
    if (!row) throw new Error(`会话快照数据块 ${chunk.hash} 在去重后不存在`);
    const storedData = row.data;
    if (!(storedData instanceof Uint8Array)
      || String(row.codec) !== chunk.codec
      || Number(row.raw_size) !== chunk.data.byteLength
      || !sameBytes(storedData, chunk.data)) {
      throw new Error(`会话快照数据块 ${chunk.hash} 命中已有哈希，但编码、长度或内容不一致`);
    }
  }

  private storeSessionSnapshot(snapshot: StoredSessionSnapshot): void {
    for (const part of snapshot.parts) this.storeChunk(part);
    this.storeChunk(snapshot.root);
  }

  private loadChunk(hash: string): StoredSnapshotChunk {
    const row = this.selectChunk.get(hash);
    if (!row) throw new Error(`会话快照数据块 ${hash} 不存在`);
    const chunk: SnapshotChunkRow = {
      codec: String(row.codec),
      rawSize: Number(row.raw_size),
      data: row.data as Uint8Array,
    };
    if (chunk.rawSize !== chunk.data.byteLength) {
      throw new Error(`会话快照数据块 ${hash} 的长度与记录不一致`);
    }
    const data = Buffer.isBuffer(chunk.data)
      ? chunk.data
      : Buffer.from(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
    const actualHash = storedChunkHash(chunk.codec, data);
    if (actualHash !== hash) throw new Error(`会话快照数据块 ${hash} 的 SHA-256 校验失败`);
    return { hash, codec: chunk.codec, data };
  }

  private loadSessionSnapshot<T>(hash: string): T {
    const root = this.loadChunk(hash);
    if (root.codec !== SESSION_MANIFEST_CODEC) {
      throw new Error(`会话快照根数据块 ${hash} 使用了不支持的编码 ${root.codec}`);
    }
    const manifest = parseSessionManifest(root.data);
    const shell = this.loadChunk(manifest.shellHash);
    if (shell.codec !== SESSION_SHELL_CODEC) {
      throw new Error(`会话快照 shell ${manifest.shellHash} 使用了不支持的编码 ${shell.codec}`);
    }
    const chunks = manifest.timelineChunkHashes.map((chunkHash) => {
      const chunk = this.loadChunk(chunkHash);
      if (chunk.codec !== SESSION_TIMELINE_CHUNK_CODEC) {
        throw new Error(`会话快照时间线数据块 ${chunkHash} 使用了不支持的编码 ${chunk.codec}`);
      }
      return chunk.data;
    });
    return decodeSessionSnapshotParts<T>({ compressedShell: shell.data, chunks });
  }

  private collectUnreferencedSessionChunks(): void {
    const sessionChunks = new Map<string, string>();
    for (const row of this.database.prepare(`
      SELECT hash, codec
      FROM chunks
      WHERE codec IN (?, ?, ?)
    `).all(SESSION_MANIFEST_CODEC, SESSION_SHELL_CODEC, SESSION_TIMELINE_CHUNK_CODEC)) {
      sessionChunks.set(String(row.hash), String(row.codec));
    }

    const reachable = new Set<string>();
    const roots = this.database.prepare(`
      SELECT snapshot_hash FROM manual_saves
      UNION
      SELECT snapshot_hash FROM live_sessions
    `).all();
    for (const row of roots) {
      const rootHash = String(row.snapshot_hash);
      const rootCodec = sessionChunks.get(rootHash);
      if (rootCodec !== SESSION_MANIFEST_CODEC) {
        throw new Error(
          `会话快照根数据块 ${rootHash} 不存在或使用了不支持的编码 ${rootCodec ?? 'unknown'}`,
        );
      }
      const manifest = parseSessionManifest(this.loadChunk(rootHash).data);
      const shellCodec = sessionChunks.get(manifest.shellHash);
      if (shellCodec !== SESSION_SHELL_CODEC) {
        throw new Error(
          `会话快照 shell ${manifest.shellHash} 不存在或使用了不支持的编码 ${shellCodec ?? 'unknown'}`,
        );
      }
      reachable.add(rootHash);
      reachable.add(manifest.shellHash);
      for (const chunkHash of manifest.timelineChunkHashes) {
        const chunkCodec = sessionChunks.get(chunkHash);
        if (chunkCodec !== SESSION_TIMELINE_CHUNK_CODEC) {
          throw new Error(
            `会话快照时间线数据块 ${chunkHash} 不存在或使用了不支持的编码 ${chunkCodec ?? 'unknown'}`,
          );
        }
        reachable.add(chunkHash);
      }
    }

    const deleteChunk = this.database.prepare(`
      DELETE FROM chunks
      WHERE hash = ? AND codec IN (?, ?, ?)
    `);
    for (const hash of sessionChunks.keys()) {
      if (!reachable.has(hash)) {
        deleteChunk.run(
          hash,
          SESSION_MANIFEST_CODEC,
          SESSION_SHELL_CODEC,
          SESSION_TIMELINE_CHUNK_CODEC,
        );
      }
    }
  }

  listManualSaves(): ElandSaveSummary[] {
    return this.database.prepare(`
      SELECT id, snapshot_hash, schema_version, state_schema_version, label,
             created_at, updated_at, source_run_id, civilization_id, branch_id,
             elapsed_months, calendar_label, world_seed, living_people, stage, ended
      FROM manual_saves ORDER BY updated_at DESC, id ASC
    `).all().flatMap((row) => {
      const parsed = parseManualRow(row);
      return parsed && isSaveSummary(parsed.meta) ? [parsed.meta] : [];
    });
  }

  saveManual(snapshot: ElandSessionRecoverySnapshot, label?: string): ElandSaveSummary {
    const now = new Date().toISOString();
    const saveId = `save-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const frame = snapshot.latestFrame;
    const meta: ElandSaveSummary = {
      schemaVersion: 1,
      stateSchemaVersion: 17,
      id: saveId,
      label: normalizedLabel(label, snapshot),
      createdAt: now,
      updatedAt: now,
      sourceRunId: snapshot.runId,
      civilizationId: snapshot.civilizationId,
      branchId: frame.branchId,
      elapsedMonths: frame.elapsedMonths,
      calendarLabel: frame.calendar.label,
      worldSeed: frame.society.world.generator.seed,
      livingPeople: frame.society.agents.filter((agent) => agent.state !== 'dead').length,
      stage: snapshot.latestState.civilization.stage,
      ended: frame.civilizationEnd !== null,
    };
    this.insertManualFile({ schemaVersion: 1, meta, session: snapshot });
    return meta;
  }

  loadManual(saveId: string): { meta: ElandSaveSummary; session: ElandSessionRecoverySnapshot } {
    if (!validSaveId(saveId)) throw new ElandSaveNotFoundError(saveId);
    const row = parseManualRow(this.selectManual.get(saveId));
    if (!row) throw new ElandSaveNotFoundError(saveId);
    const file = assertSaveFile(this.loadSessionSnapshot(row.snapshotHash), saveId);
    if (!isSaveSummary(row.meta) || !isDeepStrictEqual(row.meta, file.meta)) {
      throw new Error(`存档 ${saveId} 的索引与内容不一致`);
    }
    return { meta: file.meta, session: file.session };
  }

  private insertManualFile(file: ElandManualSaveFile): void {
    const snapshot = encodeStoredSession(file);
    this.transaction(() => {
      const existing = parseManualRow(this.selectManual.get(file.meta.id));
      if (existing) throw new Error(`存档 ${file.meta.id} 已存在`);
      this.storeSessionSnapshot(snapshot);
      this.insertManual.run(
        file.meta.id,
        snapshot.root.hash,
        ...manualColumnValues(file.meta),
      );
      this.collectUnreferencedSessionChunks();
    });
  }

  listLiveSessions(): LiveSessionSummary[] {
    return this.database.prepare(`
      SELECT run_id, snapshot_hash, touched_at, last_step_at, lease_id, creation_id,
             saved_at, civilization_id, elapsed_months, updated_at
      FROM live_sessions
      ORDER BY touched_at DESC, run_id ASC
    `).all().map((row) => liveSummary(parseLiveRow(row)!));
  }

  loadLiveSession(runId: string): ManagedLiveSessionSnapshot | null {
    const row = parseLiveRow(this.selectLive.get(runId));
    if (!row) return null;
    const snapshot = assertManagedLiveSnapshot(this.loadSessionSnapshot(row.snapshotHash), runId);
    if (snapshot.touchedAt !== row.touchedAt
      || snapshot.lastStepAt !== row.lastStepAt
      || snapshot.leaseId !== row.leaseId
      || (snapshot.creationId ?? '') !== row.creationId
      || snapshot.session.savedAt !== row.savedAt
      || snapshot.session.civilizationId !== row.civilizationId
      || snapshot.session.latestFrame.elapsedMonths !== row.elapsedMonths) {
      throw new Error(`实时会话 ${runId} 的索引与内容不一致`);
    }
    return snapshot;
  }

  saveLiveSession(snapshotInput: ManagedLiveSessionSnapshot): LiveSessionSummary {
    const snapshot = assertManagedLiveSnapshot(snapshotInput);
    const stored = encodeStoredSession(snapshot);
    const row = this.liveRow(snapshot, stored.root.hash);
    this.transaction(() => {
      this.storeSessionSnapshot(stored);
      this.upsertLive.run(
        row.runId, row.snapshotHash, row.touchedAt, row.lastStepAt, row.leaseId,
        row.creationId, row.savedAt, row.civilizationId, row.elapsedMonths, row.updatedAt,
      );
      this.collectUnreferencedSessionChunks();
    });
    return liveSummary(row);
  }

  deleteLiveSession(runId: string): boolean {
    return this.transaction(() => {
      const deleted = Number(this.deleteLiveStatement.run(runId).changes) > 0;
      if (deleted) this.collectUnreferencedSessionChunks();
      return deleted;
    });
  }

  currentCivilizationId(): number {
    const row = this.database.prepare(`
      SELECT integer_value FROM campaign_state WHERE key = ?
    `).get(CAMPAIGN_HIGH_WATER_KEY);
    if (!row) throw new Error('文明编号高水位记录不存在');
    return Number(row.integer_value);
  }

  allocateCivilizationId(): number {
    return this.transaction(() => {
      const current = this.currentCivilizationId();
      if (current >= Number.MAX_SAFE_INTEGER) throw new Error('文明编号已经达到可安全表示的上限');
      const next = current + 1;
      this.database.prepare(`
        UPDATE campaign_state SET integer_value = ?, updated_at = ? WHERE key = ?
      `).run(next, new Date().toISOString(), CAMPAIGN_HIGH_WATER_KEY);
      return next;
    });
  }

  observeCivilizationId(civilizationId: number): void {
    if (!Number.isSafeInteger(civilizationId) || civilizationId < 1) return;
    this.transaction(() => {
      if (civilizationId <= this.currentCivilizationId()) return;
      this.database.prepare(`
        UPDATE campaign_state SET integer_value = ?, updated_at = ? WHERE key = ?
      `).run(civilizationId, new Date().toISOString(), CAMPAIGN_HIGH_WATER_KEY);
    });
  }

  private liveRow(snapshot: ManagedLiveSessionSnapshot, snapshotHash: string): LiveSessionRow {
    return {
      runId: snapshot.session.runId,
      snapshotHash,
      touchedAt: snapshot.touchedAt,
      lastStepAt: snapshot.lastStepAt,
      leaseId: snapshot.leaseId,
      creationId: snapshot.creationId ?? '',
      savedAt: snapshot.session.savedAt,
      civilizationId: snapshot.session.civilizationId,
      elapsedMonths: snapshot.session.latestFrame.elapsedMonths,
      updatedAt: new Date().toISOString(),
    };
  }
}
