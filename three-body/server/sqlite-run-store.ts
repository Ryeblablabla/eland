import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { promisify } from "node:util";
import { deserialize, serialize } from "node:v8";
import { brotliCompress, brotliDecompress, constants as zlibConstants } from "node:zlib";

import { createSimulation, type SimulationState } from "../src/game/eland/simulation";
import { livingPeople } from "../src/game/eland/domain/state-index";
import type { EvolutionPath, EvolutionReport } from "./evolution-artifacts";
import type { NarrativeEnhancementArtifact } from "./narrative-enhancements";
import {
  RunAlreadyExistsError,
  RunNotFoundError,
  RunWriteConflictError,
  type PersistedRun,
  type RunStore,
  type RunSummary,
  type SaveRunOptions,
} from "./run-persistence";
import {
  decodeSegmentedRunState,
  encodeSegmentedRunState,
  markReachableRunStateChunks,
  parseRunStateRoot,
  RUN_STATE_CODECS,
  RUN_STATE_ROOT_CODEC,
  type EncodedRunState,
  type RunStateReachabilityMemo,
  type RunStateRootMetadata,
} from "./run-state-codec";
import {
  ELAND_DATABASE_FILENAME,
  ELAND_DATABASE_SCHEMA_VERSION,
  sqliteUserVersion,
  withSqliteSchemaTransaction,
} from "./sqlite-schema";
import {
  ARTIFACT_EVOLUTION_PATH,
  ARTIFACT_EVOLUTION_REPORT,
  ARTIFACT_NARRATIVE_ENHANCEMENTS,
  SqliteRunOutputArtifactStore,
} from "./sqlite-run-output-artifact-store";

export {
  RunAlreadyExistsError,
  RunNotFoundError,
  RunWriteConflictError,
  type PersistedRun,
  type RunStore,
  type RunSummary,
  type SaveRunOptions,
} from "./run-persistence";
export { ELAND_DATABASE_FILENAME, ELAND_DATABASE_SCHEMA_VERSION } from "./sqlite-schema";

const SQLITE_BUSY_TIMEOUT_MS = 5_000;
export const RUN_CHECKPOINT_RETENTION = 128;
export const RUN_CHECKPOINT_PRUNE_THRESHOLD = RUN_CHECKPOINT_RETENTION * 2;

const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const V8_BROTLI_CODEC = "v8-br-v1";
const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);

interface EncodedChunk {
  hash: string;
  codec: string;
  rawSize: number;
  data: Uint8Array;
}

interface RunRow {
  id: string;
  stateHash: string;
  meta: RunSummary;
}

interface ChunkRow {
  hash: string;
  codec: string;
  rawSize: number;
  data: Uint8Array;
}

export interface SqliteRunStoreOptions {
  readOnly?: boolean;
}

function normalizeId(value?: string): string {
  if (!value) {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    return `run-${stamp}-${randomUUID().slice(0, 8)}`;
  }
  if (!RUN_ID_PATTERN.test(value)) throw new Error("运行 id 仅支持 1-64 位字母、数字、下划线或连字符");
  return value;
}

function summaryFor(
  id: string,
  state: SimulationState,
  authoritativeEventCount: number,
  previous?: RunSummary,
  label?: string,
): RunSummary {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id,
    ...(label?.trim()
      ? { label: label.trim().slice(0, 100) }
      : previous?.label ? { label: previous.label } : {}),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    revision: previous ? previous.revision + 1 : 1,
    elapsedMonths: state.clock.elapsedMonths,
    civilizationNo: state.civilization.number,
    status: state.civilization.status,
    livingAgents: livingPeople(state).length,
    agentCount: state.people.length,
    eventCount: authoritativeEventCount,
    milestoneCount: state.derived.milestones.length,
  };
}

function migrated(input: SimulationState): SimulationState {
  return createSimulation({ state: input }).getState();
}

async function encodeValue(value: unknown): Promise<EncodedChunk> {
  const raw = serialize(value);
  const data = await compress(raw, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
  });
  return {
    hash: createHash("sha256").update(raw).digest("hex"),
    codec: V8_BROTLI_CODEC,
    rawSize: raw.byteLength,
    data,
  };
}

async function decodeValue<T>(chunk: ChunkRow): Promise<T> {
  if (chunk.codec !== V8_BROTLI_CODEC) throw new Error(`不支持的运行数据编码：${chunk.codec}`);
  const raw = await decompress(Buffer.from(chunk.data));
  if (raw.byteLength !== chunk.rawSize) throw new Error("运行数据解压后的长度与记录不一致");
  const actualHash = createHash("sha256").update(raw).digest("hex");
  if (actualHash !== chunk.hash) throw new Error(`运行数据块 ${chunk.hash} 的 SHA-256 校验失败`);
  return deserialize(raw) as T;
}

function parseRunRow(row: Record<string, unknown> | undefined): RunRow | null {
  if (!row) return null;
  return {
    id: String(row.id),
    stateHash: String(row.state_hash),
    meta: {
      schemaVersion: Number(row.schema_version) as 1,
      id: String(row.id),
      ...(row.label == null ? {} : { label: String(row.label) }),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      revision: Number(row.revision),
      elapsedMonths: Number(row.elapsed_months),
      civilizationNo: Number(row.civilization_no),
      status: String(row.status) as SimulationState["civilization"]["status"],
      livingAgents: Number(row.living_agents),
      agentCount: Number(row.agent_count),
      eventCount: Number(row.event_count),
      milestoneCount: Number(row.milestone_count),
    },
  };
}

function parseChunkRow(row: Record<string, unknown> | undefined): ChunkRow | null {
  if (!row) return null;
  if (!(row.data instanceof Uint8Array)) throw new Error("运行数据块不是有效的二进制内容");
  return {
    hash: String(row.hash),
    codec: String(row.codec),
    rawSize: Number(row.raw_size),
    data: row.data,
  };
}

function runColumnValues(meta: RunSummary): Array<string | number | null> {
  return [
    meta.schemaVersion,
    meta.label ?? null,
    meta.createdAt,
    meta.updatedAt,
    meta.revision,
    meta.elapsedMonths,
    meta.civilizationNo,
    meta.status,
    meta.livingAgents,
    meta.agentCount,
    meta.eventCount,
    meta.milestoneCount,
  ];
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && Buffer.from(left.buffer, left.byteOffset, left.byteLength)
      .equals(Buffer.from(right.buffer, right.byteOffset, right.byteLength));
}

/** SQLite-backed full-state persistence with segmented, content-addressed history. */
export class SqliteRunStore implements RunStore {
  private readonly database: DatabaseSync;
  private readonly databaseFile: string;
  private readonly selectRun: StatementSync;
  private readonly selectChunk: StatementSync;
  private readonly insertChunk: StatementSync;
  private readonly insertRun: StatementSync;
  private readonly updateRun: StatementSync;
  private readonly insertCheckpoint: StatementSync;
  private readonly outputArtifacts: SqliteRunOutputArtifactStore;
  private readonly readOnly: boolean;
  private closed = false;

  constructor(private readonly rootDir: string, options: SqliteRunStoreOptions = {}) {
    this.readOnly = options.readOnly === true;
    if (!this.readOnly) mkdirSync(rootDir, { recursive: true });
    this.databaseFile = path.join(rootDir, ELAND_DATABASE_FILENAME);
    this.database = new DatabaseSync(this.databaseFile, { readOnly: this.readOnly });
    this.database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    const currentSchemaVersion = sqliteUserVersion(this.database);
    if (currentSchemaVersion > ELAND_DATABASE_SCHEMA_VERSION) {
      this.database.close();
      throw new Error(`SQLite 数据库版本 ${currentSchemaVersion} 高于当前支持的 ${ELAND_DATABASE_SCHEMA_VERSION}`);
    }
    if (this.readOnly && currentSchemaVersion !== ELAND_DATABASE_SCHEMA_VERSION) {
      this.database.close();
      throw new Error(`只读 SQLite 数据库版本 ${currentSchemaVersion} 不受支持`);
    }
    if (!this.readOnly) {
      this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec("PRAGMA foreign_keys = ON");
      this.database.exec("PRAGMA synchronous = NORMAL");
      withSqliteSchemaTransaction(this.database, (lockedSchemaVersion) => {
        if (lockedSchemaVersion > ELAND_DATABASE_SCHEMA_VERSION) {
          throw new Error(`SQLite 数据库版本 ${lockedSchemaVersion} 高于当前支持的 ${ELAND_DATABASE_SCHEMA_VERSION}`);
        }
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS chunks (
            hash TEXT PRIMARY KEY,
            codec TEXT NOT NULL,
            raw_size INTEGER NOT NULL CHECK (raw_size >= 0),
            data BLOB NOT NULL
          ) STRICT;

          CREATE TABLE IF NOT EXISTS runs (
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

          CREATE INDEX IF NOT EXISTS runs_by_state_hash ON runs(state_hash);

          CREATE TABLE IF NOT EXISTS run_checkpoints (
            run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL CHECK (revision >= 1),
            month INTEGER NOT NULL CHECK (month >= 0),
            state_hash TEXT NOT NULL REFERENCES chunks(hash),
            created_at TEXT NOT NULL,
            PRIMARY KEY (run_id, revision)
          ) STRICT;

          CREATE INDEX IF NOT EXISTS run_checkpoints_by_month
            ON run_checkpoints(run_id, month, revision);
          CREATE INDEX IF NOT EXISTS run_checkpoints_by_state_hash
            ON run_checkpoints(state_hash);

          CREATE TABLE IF NOT EXISTS artifacts (
            run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK (kind IN (
              '${ARTIFACT_EVOLUTION_PATH}',
              '${ARTIFACT_EVOLUTION_REPORT}',
              '${ARTIFACT_NARRATIVE_ENHANCEMENTS}'
            )),
            chunk_hash TEXT NOT NULL REFERENCES chunks(hash),
            updated_at TEXT NOT NULL,
            PRIMARY KEY (run_id, kind)
          ) STRICT;

          CREATE INDEX IF NOT EXISTS artifacts_by_chunk_hash ON artifacts(chunk_hash);
        `);
        if (lockedSchemaVersion < ELAND_DATABASE_SCHEMA_VERSION) {
          this.database.exec(`PRAGMA user_version = ${ELAND_DATABASE_SCHEMA_VERSION}`);
        }
      });
    }

    this.selectRun = this.database.prepare(`
      SELECT id, state_hash, schema_version, label, created_at, updated_at,
             revision, elapsed_months, civilization_no, status, living_agents,
             agent_count, event_count, milestone_count
      FROM runs WHERE id = ?
    `);
    this.selectChunk = this.database.prepare(`
      SELECT hash, codec, raw_size, data FROM chunks WHERE hash = ?
    `);
    this.insertChunk = this.database.prepare(`
      INSERT OR IGNORE INTO chunks(hash, codec, raw_size, data) VALUES (?, ?, ?, ?)
    `);
    this.insertRun = this.database.prepare(`
      INSERT INTO runs(
        id, state_hash, schema_version, label, created_at, updated_at, revision,
        elapsed_months, civilization_no, status, living_agents, agent_count,
        event_count, milestone_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateRun = this.database.prepare(`
      UPDATE runs
      SET state_hash = ?, schema_version = ?, label = ?, created_at = ?, updated_at = ?,
          revision = ?, elapsed_months = ?, civilization_no = ?, status = ?,
          living_agents = ?, agent_count = ?, event_count = ?, milestone_count = ?
      WHERE id = ? AND revision = ? AND state_hash = ?
    `);
    this.insertCheckpoint = this.database.prepare(`
      INSERT INTO run_checkpoints(run_id, revision, month, state_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.outputArtifacts = new SqliteRunOutputArtifactStore(
      this.database,
      V8_BROTLI_CODEC,
      {
        normalizeRunId: normalizeId,
        assertRunExists: (id) => { this.assertRunExists(id); },
        encodeValue,
        decodeValue,
        storeChunk: (chunk) => this.storeChunk(chunk),
        transaction: (operation) => this.transaction(operation),
      },
    );
  }

  dataDirectory(): string { return this.rootDir; }
  filePath(): string { return this.databaseFile; }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private runRow(id: string): RunRow | null {
    return parseRunRow(this.selectRun.get(normalizeId(id)));
  }

  private chunkRow(hash: string): ChunkRow {
    const chunk = parseChunkRow(this.selectChunk.get(hash));
    if (!chunk) throw new Error(`运行数据块 ${hash} 不存在`);
    return chunk;
  }

  private transaction<T>(operation: () => T): T {
    if (this.readOnly) throw new Error("只读 SQLite 运行存储不能写入");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
  }

  private storeChunk(chunk: EncodedChunk): void {
    const result = this.insertChunk.run(chunk.hash, chunk.codec, chunk.rawSize, chunk.data);
    if (Number(result.changes) > 0) return;
    const existing = this.chunkRow(chunk.hash);
    if (existing.codec !== chunk.codec
      || existing.rawSize !== chunk.rawSize
      || !sameBytes(existing.data, chunk.data)) {
      throw new Error(`运行数据块 ${chunk.hash} 命中已有哈希，但编码、长度或内容不一致`);
    }
  }

  private assertRunExists(id: string): RunRow {
    const row = this.runRow(id);
    if (!row) throw new RunNotFoundError(`运行 ${id} 不存在`);
    return row;
  }

  private async decodeRunState(hash: string): Promise<{
    state: SimulationState;
    metadata?: RunStateRootMetadata;
  }> {
    const root = this.chunkRow(hash);
    if (root.codec === V8_BROTLI_CODEC) return { state: await decodeValue<SimulationState>(root) };
    if (root.codec === RUN_STATE_ROOT_CODEC) {
      const decoded = await decodeSegmentedRunState(root, (chunkHash) => this.chunkRow(chunkHash));
      return { state: decoded.state, metadata: decoded.metadata };
    }
    throw new Error(`不支持的运行状态根编码：${root.codec}`);
  }

  private runStateRootMetadata(hash: string): RunStateRootMetadata | null {
    const root = this.chunkRow(hash);
    if (root.codec === V8_BROTLI_CODEC) return null;
    if (root.codec === RUN_STATE_ROOT_CODEC) return parseRunStateRoot(root);
    throw new Error(`不支持的运行状态根编码：${root.codec}`);
  }

  private storeRunState(snapshot: EncodedRunState): void {
    for (const part of snapshot.parts) this.storeChunk(part);
    this.storeChunk(snapshot.root);
  }

  private pruneRunCheckpoints(id: string): boolean {
    const checkpointCount = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM run_checkpoints AS checkpoint
      JOIN chunks AS state_root ON state_root.hash = checkpoint.state_hash
      WHERE checkpoint.run_id = ? AND state_root.codec = ?
    `).get(id, RUN_STATE_ROOT_CODEC);
    if (Number(checkpointCount?.count ?? 0) <= RUN_CHECKPOINT_PRUNE_THRESHOLD) return false;

    const result = this.database.prepare(`
      DELETE FROM run_checkpoints
      WHERE run_id = ?
        AND state_hash IN (SELECT hash FROM chunks WHERE codec = ?)
        AND revision NOT IN (
          SELECT checkpoint.revision
          FROM run_checkpoints AS checkpoint
          JOIN chunks AS state_root ON state_root.hash = checkpoint.state_hash
          WHERE checkpoint.run_id = ? AND state_root.codec = ?
          ORDER BY checkpoint.revision DESC
          LIMIT ?
        )
    `).run(id, RUN_STATE_ROOT_CODEC, id, RUN_STATE_ROOT_CODEC, RUN_CHECKPOINT_RETENTION);
    return Number(result.changes) > 0;
  }

  private collectUnreferencedRunStateChunks(): void {
    const codecSet = new Set<string>(RUN_STATE_CODECS);
    const placeholders = RUN_STATE_CODECS.map(() => "?").join(", ");
    const memo: RunStateReachabilityMemo = {
      chunks: new Set<string>(),
      historyNodes: new Set<string>(),
    };
    const stateRoots = this.database.prepare(`
      SELECT state_hash AS hash FROM runs
      UNION
      SELECT state_hash AS hash FROM run_checkpoints
    `).all();
    for (const row of stateRoots) {
      const hash = String(row.hash);
      const chunk = this.chunkRow(hash);
      if (chunk.codec === RUN_STATE_ROOT_CODEC) {
        markReachableRunStateChunks(chunk, (childHash) => this.chunkRow(childHash), memo);
      } else if (chunk.codec !== V8_BROTLI_CODEC) {
        throw new Error(`运行状态根 ${hash} 使用了不支持的编码 ${chunk.codec}`);
      }
    }
    for (const row of this.database.prepare("SELECT chunk_hash AS hash FROM artifacts").all()) {
      const hash = String(row.hash);
      const chunk = this.chunkRow(hash);
      if (chunk.codec === RUN_STATE_ROOT_CODEC) {
        markReachableRunStateChunks(chunk, (childHash) => this.chunkRow(childHash), memo);
      } else if (codecSet.has(chunk.codec)) {
        memo.chunks.add(hash);
      }
    }
    const deleteChunk = this.database.prepare(`
      DELETE FROM chunks WHERE hash = ? AND codec IN (${placeholders})
    `);
    for (const row of this.database.prepare(`
      SELECT hash FROM chunks WHERE codec IN (${placeholders})
    `).all(...RUN_STATE_CODECS)) {
      const hash = String(row.hash);
      if (!memo.chunks.has(hash)) deleteChunk.run(hash, ...RUN_STATE_CODECS);
    }
  }

  async list(): Promise<RunSummary[]> {
    return this.database.prepare(`
      SELECT id, state_hash, schema_version, label, created_at, updated_at,
             revision, elapsed_months, civilization_no, status, living_agents,
             agent_count, event_count, milestone_count
      FROM runs ORDER BY updated_at DESC, id ASC
    `).all().map((row) => parseRunRow(row)!.meta);
  }

  async load(id: string): Promise<PersistedRun> {
    const normalizedId = normalizeId(id);
    const row = this.runRow(normalizedId);
    if (!row) throw new RunNotFoundError(`运行 ${normalizedId} 不存在`);
    const stored = await this.decodeRunState(row.stateHash);
    const state = stored.metadata ? stored.state : migrated(stored.state);
    if (stored.metadata && !state.world.historyCursor) {
      state.world.historyCursor = {
        version: 1,
        eventCount: stored.metadata.eventCount,
        hotStartIndex: 0,
        tailEventId: state.world.past.at(-1)?.id ?? null,
      };
    }
    return { meta: row.meta, state };
  }

  async create(input: { id?: string; label?: string; state: SimulationState }): Promise<PersistedRun> {
    const id = normalizeId(input.id);
    if (this.runRow(id)) throw new RunAlreadyExistsError(`运行 ${id} 已存在`);
    const state = migrated(input.state);
    const snapshot = await encodeSegmentedRunState(state);
    const meta = summaryFor(id, state, snapshot.metadata.eventCount, undefined, input.label);
    this.transaction(() => {
      if (this.runRow(id)) throw new RunAlreadyExistsError(`运行 ${id} 已存在`);
      this.storeRunState(snapshot);
      this.insertRun.run(id, snapshot.root.hash, ...runColumnValues(meta));
      this.insertCheckpoint.run(id, meta.revision, meta.elapsedMonths, snapshot.root.hash, meta.updatedAt);
    });
    return { meta, state };
  }

  async save(
    id: string,
    stateInput: SimulationState,
    label?: string,
    options: SaveRunOptions = {},
  ): Promise<PersistedRun> {
    const normalizedId = normalizeId(id);
    const encodedAgainst = this.assertRunExists(normalizedId);
    const hasExpectedRevision = options.expectedRevision !== undefined;
    const hasExpectedStateHash = options.expectedStateHash !== undefined;
    if (hasExpectedRevision !== hasExpectedStateHash) {
      throw new Error("expectedRevision 与 expectedStateHash 必须同时提供");
    }
    if (hasExpectedRevision
      && (options.expectedRevision !== encodedAgainst.meta.revision
        || options.expectedStateHash !== encodedAgainst.stateHash)) {
      throw new RunWriteConflictError(
        `运行 ${normalizedId} 写入基线已过期：期望 revision ${options.expectedRevision} / ${options.expectedStateHash}，`
        + `当前为 revision ${encodedAgainst.meta.revision} / ${encodedAgainst.stateHash}`,
      );
    }
    if (Number((stateInput as { schemaVersion?: number }).schemaVersion) !== 19) {
      throw new Error("保存的运行状态必须是 schemaVersion 19");
    }
    const previousMetadata = this.runStateRootMetadata(encodedAgainst.stateHash);
    const snapshot = await encodeSegmentedRunState(
      stateInput,
      previousMetadata && previousMetadata.schemaVersion >= 2 && options.historyMode !== "replace"
        ? { mode: "append", previous: previousMetadata }
        : { mode: "replace" },
    );
    const next = summaryFor(
      encodedAgainst.id,
      stateInput,
      snapshot.metadata.eventCount,
      encodedAgainst.meta,
      label,
    );
    const meta = this.transaction(() => {
      this.storeRunState(snapshot);
      const update = this.updateRun.run(
        snapshot.root.hash,
        ...runColumnValues(next),
        encodedAgainst.id,
        encodedAgainst.meta.revision,
        encodedAgainst.stateHash,
      );
      if (Number(update.changes) !== 1) {
        const current = this.runRow(normalizedId);
        throw new RunWriteConflictError(
          `运行 ${normalizedId} 在编码期间已更新：期望 revision ${encodedAgainst.meta.revision}`
          + ` / ${encodedAgainst.stateHash}，当前为 ${current
            ? `revision ${current.meta.revision} / ${current.stateHash}` : "不存在"}`,
        );
      }
      this.insertCheckpoint.run(
        encodedAgainst.id,
        next.revision,
        next.elapsedMonths,
        snapshot.root.hash,
        next.updatedAt,
      );
      if (this.pruneRunCheckpoints(encodedAgainst.id)) this.collectUnreferencedRunStateChunks();
      return next;
    });
    return { meta, state: stateInput };
  }

  async loadEvolutionPath(id: string): Promise<EvolutionPath | null> {
    return this.outputArtifacts.loadEvolutionPath(id);
  }

  async saveEvolutionPath(id: string, evolution: EvolutionPath): Promise<void> {
    await this.outputArtifacts.saveEvolutionPath(id, evolution);
  }

  async loadEvolutionReport(id: string): Promise<EvolutionReport | null> {
    return this.outputArtifacts.loadEvolutionReport(id);
  }

  async saveEvolutionReport(id: string, report: EvolutionReport): Promise<void> {
    await this.outputArtifacts.saveEvolutionReport(id, report);
  }

  async loadNarrativeEnhancements(id: string): Promise<NarrativeEnhancementArtifact | null> {
    return this.outputArtifacts.loadNarrativeEnhancements(id);
  }

  async saveNarrativeEnhancements(id: string, artifact: NarrativeEnhancementArtifact): Promise<void> {
    await this.outputArtifacts.saveNarrativeEnhancements(id, artifact);
  }
}

export { SqliteRunStore as SQLiteRunStore };
