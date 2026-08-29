import type { DatabaseSync, StatementSync } from "node:sqlite";

import type { EvolutionPath, EvolutionReport } from "./evolution-artifacts";
import type { NarrativeEnhancementArtifact } from "./narrative-enhancements";

export const ARTIFACT_EVOLUTION_PATH = "evolution-path";
export const ARTIFACT_EVOLUTION_REPORT = "evolution-report";
export const ARTIFACT_NARRATIVE_ENHANCEMENTS = "narrative-enhancements";

export interface SqliteRunOutputArtifactChunk {
  readonly hash: string;
  readonly codec: string;
  readonly rawSize: number;
  readonly data: Uint8Array;
}

export interface SqliteRunOutputArtifactHost {
  normalizeRunId(id: string): string;
  assertRunExists(id: string): void;
  encodeValue(value: unknown): Promise<SqliteRunOutputArtifactChunk>;
  decodeValue<T>(chunk: SqliteRunOutputArtifactChunk): Promise<T>;
  storeChunk(chunk: SqliteRunOutputArtifactChunk): void;
  transaction<T>(operation: () => T): T;
}

function parseArtifactChunkRow(
  row: Record<string, unknown> | undefined,
): SqliteRunOutputArtifactChunk | null {
  if (!row) return null;
  const data = row.data;
  if (!(data instanceof Uint8Array)) throw new Error("运行数据块不是有效的二进制内容");
  return {
    hash: String(row.hash),
    codec: String(row.codec),
    rawSize: Number(row.raw_size),
    data,
  };
}

/** Stores derived run output artifacts without owning run-state persistence. */
export class SqliteRunOutputArtifactStore {
  private readonly selectArtifactChunk: StatementSync;
  private readonly selectArtifactHash: StatementSync;
  private readonly upsertArtifact: StatementSync;
  private readonly deleteUnreferencedArtifactChunk: StatementSync;

  constructor(
    database: DatabaseSync,
    private readonly artifactCodec: string,
    private readonly host: SqliteRunOutputArtifactHost,
  ) {
    this.selectArtifactChunk = database.prepare(`
      SELECT chunks.hash, chunks.codec, chunks.raw_size, chunks.data
      FROM artifacts
      JOIN chunks ON chunks.hash = artifacts.chunk_hash
      WHERE artifacts.run_id = ? AND artifacts.kind = ?
    `);
    this.selectArtifactHash = database.prepare(`
      SELECT chunk_hash FROM artifacts WHERE run_id = ? AND kind = ?
    `);
    this.upsertArtifact = database.prepare(`
      INSERT INTO artifacts(run_id, kind, chunk_hash, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(run_id, kind) DO UPDATE SET
        chunk_hash = excluded.chunk_hash,
        updated_at = excluded.updated_at
    `);
    this.deleteUnreferencedArtifactChunk = database.prepare(`
      DELETE FROM chunks
      WHERE hash = ? AND codec = ?
        AND NOT EXISTS (SELECT 1 FROM runs WHERE state_hash = chunks.hash)
        AND NOT EXISTS (SELECT 1 FROM run_checkpoints WHERE state_hash = chunks.hash)
        AND NOT EXISTS (SELECT 1 FROM artifacts WHERE chunk_hash = chunks.hash)
    `);
  }

  private async loadArtifact<T>(id: string, kind: string): Promise<T | null> {
    const normalizedId = this.host.normalizeRunId(id);
    const chunk = parseArtifactChunkRow(this.selectArtifactChunk.get(normalizedId, kind));
    return chunk ? this.host.decodeValue<T>(chunk) : null;
  }

  private async saveArtifact(id: string, kind: string, value: unknown): Promise<void> {
    const normalizedId = this.host.normalizeRunId(id);
    this.host.assertRunExists(normalizedId);
    const chunk = await this.host.encodeValue(value);
    this.host.transaction(() => {
      this.host.assertRunExists(normalizedId);
      const previous = this.selectArtifactHash.get(normalizedId, kind);
      const previousHash = previous ? String(previous.chunk_hash) : null;
      this.host.storeChunk(chunk);
      this.upsertArtifact.run(normalizedId, kind, chunk.hash, new Date().toISOString());
      if (previousHash) {
        this.deleteUnreferencedArtifactChunk.run(previousHash, this.artifactCodec);
      }
    });
  }

  loadEvolutionPath(id: string): Promise<EvolutionPath | null> {
    return this.loadArtifact<EvolutionPath>(id, ARTIFACT_EVOLUTION_PATH);
  }

  async saveEvolutionPath(id: string, evolution: EvolutionPath): Promise<void> {
    await this.saveArtifact(id, ARTIFACT_EVOLUTION_PATH, evolution);
  }

  loadEvolutionReport(id: string): Promise<EvolutionReport | null> {
    return this.loadArtifact<EvolutionReport>(id, ARTIFACT_EVOLUTION_REPORT);
  }

  async saveEvolutionReport(id: string, report: EvolutionReport): Promise<void> {
    await this.saveArtifact(id, ARTIFACT_EVOLUTION_REPORT, report);
  }

  loadNarrativeEnhancements(id: string): Promise<NarrativeEnhancementArtifact | null> {
    return this.loadArtifact<NarrativeEnhancementArtifact>(id, ARTIFACT_NARRATIVE_ENHANCEMENTS);
  }

  async saveNarrativeEnhancements(
    id: string,
    artifact: NarrativeEnhancementArtifact,
  ): Promise<void> {
    await this.saveArtifact(id, ARTIFACT_NARRATIVE_ENHANCEMENTS, artifact);
  }
}
