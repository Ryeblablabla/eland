import type { ElandSession } from './elandSession';
import { elandSessions } from './elandSession';
import { advanceAuthoritativeCosmosMonth } from './authoritative-cosmos';

const OBSERVER_LEASE_TTL_MS = 4_000;
const MIN_PLAYBACK_INTERVAL_MS = 500;
const MAX_PLAYBACK_INTERVAL_MS = 20_000;
const BUSY_RETRY_MS = 250;

interface ObserverLease {
  active: boolean;
  expiresAt: number;
  playbackIntervalMs: number;
}

interface RunnerControl {
  status: 'waiting' | 'stepping';
  promise: Promise<void>;
  cancelled: boolean;
  wake?: () => void;
}

export interface LiveObserverRunnerView {
  status: 'paused' | 'waiting' | 'stepping';
  activeObservers: number;
  leaseTtlMs: number;
}

function boundedPlaybackInterval(value: number): number {
  if (!Number.isFinite(value)) return 4_000;
  return Math.min(MAX_PLAYBACK_INTERVAL_MS, Math.max(MIN_PLAYBACK_INTERVAL_MS, Math.round(value)));
}

/**
 * Owns demand for live-session progression. Browser observers only renew a
 * lease; the runner itself chooses and commits months. No lease means no new
 * month and therefore no new model spend.
 */
export class LiveObserverRunner {
  private readonly observers = new Map<string, Map<string, ObserverLease>>();
  private readonly runners = new Map<string, RunnerControl>();

  observe(
    runId: string,
    observerId: string,
    active: boolean,
    playbackIntervalMs: number,
    now = Date.now(),
  ): LiveObserverRunnerView {
    this.sweepRun(runId, now);
    const leases = this.observers.get(runId) ?? new Map<string, ObserverLease>();
    if (active) {
      leases.set(observerId, {
        active: true,
        expiresAt: now + OBSERVER_LEASE_TTL_MS,
        playbackIntervalMs: boundedPlaybackInterval(playbackIntervalMs),
      });
      this.observers.set(runId, leases);
      this.ensureRunner(runId);
    } else {
      leases.delete(observerId);
      if (!leases.size) this.observers.delete(runId);
    }
    return this.view(runId, now);
  }

  async stop(runId: string): Promise<void> {
    this.observers.delete(runId);
    const runner = this.runners.get(runId);
    if (!runner) return;
    runner.cancelled = true;
    runner.wake?.();
    await runner.promise;
    // An observe request already in flight may have renewed the old lease
    // while the current month was finishing. It belongs to the authority that
    // is about to be replaced, so do not let it start the new civilization.
    this.observers.delete(runId);
  }

  view(runId: string, now = Date.now()): LiveObserverRunnerView {
    this.sweepRun(runId, now);
    const activeObservers = this.activeLeases(runId, now).length;
    const runner = this.runners.get(runId);
    return {
      status: runner?.status ?? 'paused',
      activeObservers,
      leaseTtlMs: OBSERVER_LEASE_TTL_MS,
    };
  }

  private sweepRun(runId: string, now: number): void {
    const leases = this.observers.get(runId);
    if (!leases) return;
    for (const [observerId, lease] of leases) {
      if (!lease.active || lease.expiresAt <= now) leases.delete(observerId);
    }
    if (!leases.size) this.observers.delete(runId);
  }

  private activeLeases(runId: string, now = Date.now()): ObserverLease[] {
    this.sweepRun(runId, now);
    return [...(this.observers.get(runId)?.values() ?? [])];
  }

  private requestedInterval(runId: string): number {
    const leases = this.activeLeases(runId);
    return leases.length
      ? Math.min(...leases.map((lease) => lease.playbackIntervalMs))
      : MAX_PLAYBACK_INTERVAL_MS;
  }

  private ensureRunner(runId: string): void {
    if (this.runners.has(runId)) return;
    const control: RunnerControl = {
      status: 'waiting',
      promise: Promise.resolve(),
      cancelled: false,
    };
    control.promise = this.run(runId, control).finally(() => {
      if (this.runners.get(runId) === control) this.runners.delete(runId);
    });
    this.runners.set(runId, control);
  }

  private async run(runId: string, control: RunnerControl): Promise<void> {
    let lastSession: ElandSession | null = null;
    let committedSincePersistence = false;
    try {
      while (!control.cancelled && this.activeLeases(runId).length) {
        const session = elandSessions.get(runId, 'step');
        lastSession = session;
        const previous = session?.latest() ?? null;
        if (!session || !previous || previous.civilizationEnd) return;
        if (!previous.cosmosSnapshot || previous.cosmosSnapshot.pendingCollapse) return;
        if (session.isBusy()) {
          control.status = 'waiting';
          await this.wait(control, BUSY_RETRY_MS);
          continue;
        }

        const intervalMs = this.requestedInterval(runId);
        const startedAt = Date.now();
        const nextCosmos = advanceAuthoritativeCosmosMonth(previous.cosmosSnapshot);
        control.status = 'stepping';
        const frame = await session.step({
          stepId: `observer:${previous.authorityRevision}:${previous.branchId}:${previous.elapsedMonths}`,
          expectedAuthorityRevision: previous.authorityRevision,
          expectedCivilizationId: previous.civilizationId,
          expectedBranchId: previous.branchId,
          expectedElapsedMonths: previous.elapsedMonths,
          skySample: nextCosmos.skySample,
          cosmosSnapshot: nextCosmos.cosmosSnapshot,
        });
        committedSincePersistence = Boolean(frame
          && frame.authorityRevision === previous.authorityRevision
          && frame.branchId === previous.branchId
          && frame.elapsedMonths === previous.elapsedMonths + 1) || committedSincePersistence;
        if (frame && frame.elapsedMonths % 12 === 0) {
          const persistence = elandSessions.persistIfCurrent(runId, session);
          if (persistence.current && persistence.persisted) committedSincePersistence = false;
        }
        control.status = 'waiting';
        if (!frame || frame.civilizationEnd || frame.cosmosSnapshot?.pendingCollapse) return;
        if (control.cancelled) return;
        if (!this.activeLeases(runId).length) return;
        const remainingMs = intervalMs - (Date.now() - startedAt);
        if (remainingMs > 0) await this.wait(control, remainingMs);
      }
    } catch (error) {
      console.warn(`运行 ${runId} 的在线观察推进已暂停：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (committedSincePersistence && lastSession) {
        try {
          elandSessions.persistIfCurrent(runId, lastSession);
        } catch (error) {
          console.warn(`运行 ${runId} 离线前保存失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  private wait(control: RunnerControl, milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        control.wake = undefined;
        resolve();
      }, milliseconds);
      timer.unref?.();
      control.wake = () => {
        clearTimeout(timer);
        control.wake = undefined;
        resolve();
      };
    });
  }
}

export const liveObserverRunner = new LiveObserverRunner();
