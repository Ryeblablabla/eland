import path from 'node:path';

import type { CosmosSnapshot, ElandSaveSummary, GameFrame, SkySample } from '../../src/game/societyContract';
import { logPerf, perfElapsed, perfNow } from '../perf';
import {
  SqliteElandStore,
  type ManagedLiveSessionSnapshot,
} from '../sqlite-eland-store';
import type { SessionTimelineChunkResolver } from '../session-snapshot-codec';
import type { ElandSessionRecoverySnapshot } from './recovery';

export const DEFAULT_SESSION_TTL_MS = 60 * 1_000;
export const DEFAULT_SESSION_RECOVERY_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_MAX_SESSIONS = 16;
export const DEFAULT_ACTIVE_STEP_PROTECTION_MS = 30 * 1_000;

export class ElandSessionCapacityError extends Error {
  constructor(readonly maxSessions: number) {
    super(`演化会话已达到上限（${maxSessions}），且现有会话最近仍在推进`);
    this.name = 'ElandSessionCapacityError';
  }
}

export class ElandSessionBusyError extends Error {
  constructor(readonly runId: string, operation: string) {
    super(`运行 ${runId} 正在完成模型对话或权威月份，暂时不能${operation}`);
    this.name = 'ElandSessionBusyError';
  }
}

interface ManagedSession {
  begin(
    civilizationId: number,
    worldSeed: number,
    skySample: SkySample,
    characterIds?: string[],
    cosmosSnapshot?: CosmosSnapshot,
  ): GameFrame;
  latest(): GameFrame | null;
  isBusy(): boolean;
  recoverySnapshot(savedAt?: number): ElandSessionRecoverySnapshot | null;
}

export interface ElandSessionFactory<Session extends ManagedSession> {
  create(
    runId: string,
    initialSkySample: SkySample,
    timelineChunkResolver: SessionTimelineChunkResolver,
  ): Session;
  restore(
    snapshot: ElandSessionRecoverySnapshot,
    runId: string | undefined,
    timelineChunkResolver: SessionTimelineChunkResolver,
  ): Session;
}

export interface ElandSessionManagerOptions {
  ttlMs?: number;
  recoveryTtlMs?: number;
  maxSessions?: number;
  activeStepProtectionMs?: number;
  databaseDir?: string;
  persistence?: SqliteElandStore;
}

interface PersistedSessionIndexEntry {
  civilizationId: number;
  savedAt: number;
  lastStepAt: number;
  leaseId: string;
  creationId: string;
}

interface ActiveSessionEntry<Session> {
  session: Session;
  touchedAt: number;
  lastStepAt: number;
  leaseId: string;
  creationId: string;
}

/** Owns live-session retention, leases and persistence; simulation remains in ElandSession. */
export class ElandSessionManagerCore<Session extends ManagedSession> {
  private readonly sessions = new Map<string, ActiveSessionEntry<Session>>();
  private readonly persistedSessions = new Map<string, PersistedSessionIndexEntry>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly activeStepProtectionMs: number;
  private readonly recoveryTtlMs: number;
  private readonly persistence: SqliteElandStore;
  private readonly timelineChunkResolver: SessionTimelineChunkResolver;
  private closed = false;

  constructor(
    private readonly factory: ElandSessionFactory<Session>,
    options: ElandSessionManagerOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.recoveryTtlMs = options.recoveryTtlMs ?? DEFAULT_SESSION_RECOVERY_TTL_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.activeStepProtectionMs = options.activeStepProtectionMs ?? DEFAULT_ACTIVE_STEP_PROTECTION_MS;
    this.persistence = options.persistence ?? new SqliteElandStore(path.resolve(
      options.databaseDir ?? path.join(process.cwd(), 'data'),
    ));
    this.timelineChunkResolver = this.persistence.resolveTimelineChunk.bind(this.persistence);
    this.scanPersisted();
    const savedCivilizationHighWaterMark = this.persistence.listManualSaves()
      .reduce((maximum, save) => Math.max(maximum, save.civilizationId), 0);
    if (savedCivilizationHighWaterMark > 0) {
      this.persistence.observeCivilizationId(savedCivilizationHighWaterMark);
    }
  }

  private removePersisted(runId: string): void {
    this.persistedSessions.delete(runId);
    this.persistence.deleteLiveSession(runId);
  }

  private scanPersisted(): void {
    for (const summary of this.persistence.listLiveSessions()) {
      // 过期会话可以清理，但它曾经领取过的文明号仍然不能被复用。
      this.persistence.observeCivilizationId(summary.civilizationId);
      if (Date.now() - summary.savedAt > this.recoveryTtlMs) {
        this.removePersisted(summary.runId);
        continue;
      }
      this.persistedSessions.set(summary.runId, {
        civilizationId: summary.civilizationId,
        savedAt: summary.savedAt,
        lastStepAt: summary.lastStepAt,
        leaseId: summary.leaseId,
        creationId: summary.creationId,
      });
    }
  }

  private restorePersistedRun(runId: string): Session | null {
    try {
      const snapshot = this.persistence.loadLiveSession(runId);
      if (!snapshot) return null;
      if (snapshot.schemaVersion !== 1 || snapshot.session.runId !== runId) {
        this.removePersisted(runId);
        return null;
      }
      this.persistence.observeCivilizationId(snapshot.session.civilizationId);
      if (Date.now() - snapshot.session.savedAt > this.recoveryTtlMs) {
        this.removePersisted(runId);
        return null;
      }
      this.persistedSessions.set(runId, {
        civilizationId: snapshot.session.civilizationId,
        savedAt: snapshot.session.savedAt,
        lastStepAt: snapshot.lastStepAt,
        leaseId: snapshot.leaseId,
        creationId: snapshot.creationId ?? '',
      });
      const session = this.factory.restore(
        snapshot.session,
        undefined,
        this.timelineChunkResolver,
      );
      this.sessions.set(runId, {
        session,
        touchedAt: Date.now(),
        lastStepAt: snapshot.lastStepAt,
        leaseId: snapshot.leaseId,
        creationId: snapshot.creationId ?? '',
      });
      return session;
    } catch (error) {
      console.warn(`实时演化会话 ${runId} 恢复失败：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private persistEntry(runId: string, entry: ActiveSessionEntry<Session>, now = Date.now()): boolean {
    const session = entry.session.recoverySnapshot(now);
    if (!session) return false;
    const snapshot: ManagedLiveSessionSnapshot = {
      schemaVersion: 1,
      touchedAt: entry.touchedAt,
      lastStepAt: entry.lastStepAt,
      leaseId: entry.leaseId,
      creationId: entry.creationId,
      session,
    };
    const persistenceStartedAt = perfNow();
    this.persistence.saveLiveSession(snapshot);
    this.persistedSessions.set(runId, {
      civilizationId: session.civilizationId,
      savedAt: session.savedAt,
      lastStepAt: entry.lastStepAt,
      leaseId: entry.leaseId,
      creationId: entry.creationId,
    });
    logPerf('live-persist', {
      runId,
      month: session.latestFrame.elapsedMonths,
      persistenceMs: perfElapsed(persistenceStartedAt),
    });
    return true;
  }

  persistAll(now = Date.now()): number {
    this.sweep(now);
    let persisted = 0;
    for (const [runId, entry] of this.sessions) {
      if (this.persistEntry(runId, entry, now)) persisted += 1;
    }
    return persisted;
  }

  persist(runId: string, now = Date.now()): boolean {
    const entry = this.sessions.get(runId);
    return entry ? this.persistEntry(runId, entry, now) : false;
  }

  persistIfCurrent(
    runId: string,
    expectedSession: Session,
    now = Date.now(),
  ): { current: boolean; persisted: boolean } {
    const entry = this.sessions.get(runId);
    if (!entry || entry.session !== expectedSession) return { current: false, persisted: false };
    entry.touchedAt = now;
    return { current: true, persisted: this.persistEntry(runId, entry, now) };
  }

  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [runId, entry] of this.sessions) {
      if (now - entry.touchedAt <= this.ttlMs || entry.session.isBusy()) continue;
      this.persistEntry(runId, entry, now);
      this.sessions.delete(runId);
      removed += 1;
    }
    return removed;
  }

  private evictLeastRecentlyUsed(now: number): boolean {
    if (this.sessions.size < this.maxSessions) return true;
    const oldest = [...this.sessions.entries()]
      .filter(([, entry]) => !entry.session.isBusy() && now - entry.lastStepAt > this.activeStepProtectionMs)
      .sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
    if (!oldest) return false;
    this.persistEntry(oldest[0], oldest[1], now);
    this.sessions.delete(oldest[0]);
    return true;
  }

  begin(
    runId: string,
    creationId: string,
    worldSeed: number,
    skySample: SkySample,
    characterIds?: string[],
    leaseId = '',
    cosmosSnapshot?: CosmosSnapshot,
  ): GameFrame {
    const now = Date.now();
    this.sweep(now);
    if (!this.sessions.has(runId)) {
      const persisted = this.persistedSessions.get(runId);
      if (persisted && persisted.creationId !== creationId) this.removePersisted(runId);
      else this.restorePersistedRun(runId);
    }
    const existing = this.sessions.get(runId);
    if (existing?.creationId === creationId) {
      existing.touchedAt = now;
      if (leaseId) existing.leaseId = leaseId;
      const frame = existing.session.latest();
      if (frame) return frame;
    }
    if (existing?.session.isBusy()) throw new ElandSessionBusyError(runId, '重新创建文明');
    if (!this.sessions.has(runId) && !this.evictLeastRecentlyUsed(now)) {
      throw new ElandSessionCapacityError(this.maxSessions);
    }
    this.removePersisted(runId);
    const civilizationId = this.persistence.allocateCivilizationId();
    const session = this.factory.create(runId, skySample, this.timelineChunkResolver);
    const frame = session.begin(civilizationId, worldSeed, skySample, characterIds, cosmosSnapshot);
    this.sessions.set(runId, { session, touchedAt: now, lastStepAt: 0, leaseId, creationId });
    return frame;
  }

  listSaves(): ElandSaveSummary[] {
    return this.persistence.listManualSaves();
  }

  save(runId: string, label?: string): ElandSaveSummary | null {
    const session = this.get(runId);
    if (session?.isBusy()) throw new ElandSessionBusyError(runId, '保存未完成的化身月份');
    const snapshot = session?.recoverySnapshot();
    return snapshot?.cosmosSnapshot ? this.persistence.saveManual(snapshot, label) : null;
  }

  loadSave(runId: string, saveId: string, leaseId = ''): { meta: ElandSaveSummary; session: Session; frame: GameFrame } {
    const now = Date.now();
    this.sweep(now);
    const existing = this.sessions.get(runId);
    if (existing?.session.isBusy()) throw new ElandSessionBusyError(runId, '载入存档');
    if (!this.sessions.has(runId) && !this.evictLeastRecentlyUsed(now)) {
      throw new ElandSessionCapacityError(this.maxSessions);
    }
    const loaded = this.persistence.loadManual(saveId);
    const session = this.factory.restore(loaded.session, runId, this.timelineChunkResolver);
    const frame = session.latest();
    if (!frame) throw new Error(`存档 ${saveId} 没有可恢复的文明帧`);
    this.persistence.observeCivilizationId(frame.civilizationId);
    this.removePersisted(runId);
    this.sessions.set(runId, { session, touchedAt: now, lastStepAt: now, leaseId, creationId: '' });
    return { meta: loaded.meta, session, frame };
  }

  get(runId: string, activity: 'read' | 'step' = 'read'): Session | null {
    const now = Date.now();
    this.sweep(now);
    let entry = this.sessions.get(runId);
    if (!entry) {
      const restored = this.restorePersistedRun(runId);
      if (!restored) return null;
      entry = this.sessions.get(runId);
    }
    if (!entry) return null;
    entry.touchedAt = now;
    if (activity === 'step') entry.lastStepAt = now;
    return entry.session;
  }

  end(runId: string, leaseId = ''): boolean {
    const entry = this.sessions.get(runId);
    if (!entry) {
      const persisted = this.persistedSessions.get(runId);
      if (!persisted || (leaseId && persisted.leaseId && persisted.leaseId !== leaseId)) return false;
      this.removePersisted(runId);
      return true;
    }
    if (leaseId && entry.leaseId && entry.leaseId !== leaseId) return false;
    if (entry.session.isBusy()) throw new ElandSessionBusyError(runId, '结束会话');
    const deleted = this.sessions.delete(runId);
    if (deleted) this.removePersisted(runId);
    return deleted;
  }

  size(): number {
    this.sweep();
    return this.sessions.size;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.persistence.close();
  }
}
