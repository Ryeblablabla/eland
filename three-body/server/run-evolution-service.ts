import type { EvolutionPath } from './evolution-artifacts';
import {
  evolutionExpectedBasisKey,
  parseEvolutionRunRequest,
  type EvolutionRunRequest,
} from './evolution-request';
import { HttpError } from './http-error';
import {
  executeLongEvolutionInWorker,
  type EvolutionWorkerExecution,
} from './run-evolution-worker-client';
import type { SqliteRunStore } from './sqlite-run-store';

// One server process owns one shell-part cache in the API isolate and one in
// each evolution Worker isolate. Serializing Workers keeps their combined
// cache residency bounded to two codec isolates (currently at most 256 MiB),
// instead of growing with the number of runs submitted concurrently.
let evolutionWorkerQueue: Promise<unknown> = Promise.resolve();

export async function serializeEvolutionWorker<T>(task: () => Promise<T>): Promise<T> {
  const current = evolutionWorkerQueue.catch(() => undefined).then(task);
  evolutionWorkerQueue = current;
  try {
    return await current;
  } finally {
    if (evolutionWorkerQueue === current) evolutionWorkerQueue = Promise.resolve();
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * Queues Worker construction globally while exposing bootstrap readiness.
 * Completion remains chained through the real Worker exit, so the next Worker
 * cannot start while the current isolate or codec cache is still resident.
 */
export function enqueueEvolutionWorker(
  task: () => EvolutionWorkerExecution,
): EvolutionWorkerExecution {
  const ready = deferred<EvolutionPath>();
  const completion = serializeEvolutionWorker(async () => {
    let execution: EvolutionWorkerExecution;
    try {
      execution = task();
    } catch (error) {
      ready.reject(error);
      throw error;
    }
    void execution.ready.then(ready.resolve, ready.reject);
    try {
      await execution.completion;
    } catch (error) {
      // Constructor/exit failures may happen before a ready message. The
      // deferred is idempotent, so this is also safe after a ready rejection.
      ready.reject(error);
      throw error;
    }
  });
  return { ready: ready.promise, completion };
}

interface EvolutionJob {
  token: symbol;
  requestedEndMonth?: number;
  ensureBasisKey?: string;
  ready: Promise<EvolutionPath>;
  promise?: Promise<void>;
}

/**
 * Owns long-run scheduling, per-run serialization, checkpoint cadence, and
 * deterministic report publication. HTTP parsing and response formatting stay
 * in the composition layer.
 */
export class RunEvolutionService {
  private readonly runQueues = new Map<string, Promise<unknown>>();
  private readonly evolutionJobs = new Map<string, EvolutionJob>();

  constructor(private readonly store: SqliteRunStore) {}

  async serializeRun<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.runQueues.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.runQueues.set(id, current);
    try {
      return await current;
    } finally {
      if (this.runQueues.get(id) === current) this.runQueues.delete(id);
    }
  }

  async evolve(id: string, bodyValue: unknown): Promise<EvolutionPath> {
    const request = parseEvolutionRunRequest(bodyValue);
    const active = this.evolutionJobs.get(id);
    if (active) return this.acknowledgeActiveEvolution(id, request, active);

    const job = {
      token: Symbol(id),
      ...(request.kind === 'ensure-through' ? {
        requestedEndMonth: request.requestedEndMonth,
        ensureBasisKey: evolutionExpectedBasisKey(request.expected),
      } : {}),
    } as EvolutionJob;
    this.evolutionJobs.set(id, job);
    job.ready = Promise.resolve().then(() => this.initializeEvolutionJob(id, request, job));
    try {
      return await job.ready;
    } catch (error) {
      // Once a Worker has been scheduled, keep the active-job identity until
      // its real exit. Otherwise a pre-ready failure could admit a second large
      // Worker while the first isolate is still being released.
      if (!job.promise) this.releaseEvolutionJob(id, job);
      throw error;
    }
  }

  private releaseEvolutionJob(id: string, job: EvolutionJob): void {
    if (this.evolutionJobs.get(id)?.token === job.token) this.evolutionJobs.delete(id);
  }

  private observeEvolutionJob(id: string, job: EvolutionJob, promise: Promise<void>): void {
    void promise.then(
      () => this.releaseEvolutionJob(id, job),
      (error) => {
        this.releaseEvolutionJob(id, job);
        console.error(`运行 ${id} 的后台演化任务异常`, error);
      },
    );
  }

  private async initializeEvolutionJob(
    id: string,
    request: EvolutionRunRequest,
    job: EvolutionJob,
  ): Promise<EvolutionPath> {
    const ready = deferred<EvolutionPath>();
    const promise = this.serializeRun(id, async () => {
      const queued = enqueueEvolutionWorker(
        () => executeLongEvolutionInWorker(
          this.store.dataDirectory(),
          id,
          request,
        ),
      );
      void queued.ready.then((path) => {
        job.requestedEndMonth = path.requestedEndMonth;
        ready.resolve(path);
      }, ready.reject);
      try {
        await queued.completion;
      } catch (error) {
        ready.reject(error);
        throw error;
      }
    }).then(() => undefined);
    job.promise = promise;
    this.observeEvolutionJob(id, job, promise);
    return ready.promise;
  }

  private async acknowledgeActiveEvolution(
    id: string,
    request: EvolutionRunRequest,
    active: EvolutionJob,
  ): Promise<EvolutionPath> {
    if (request.kind === 'legacy') throw new HttpError(409, `运行 ${id} 正在演化`);
    if (active.requestedEndMonth !== request.requestedEndMonth) {
      throw new HttpError(409, `运行 ${id} 正在演化到第 ${active.requestedEndMonth ?? '?'} 月`);
    }
    if (active.ensureBasisKey !== evolutionExpectedBasisKey(request.expected)) {
      throw new HttpError(409, `运行 ${id} 正在使用不同的身份基线`);
    }
    const ready = await active.ready;
    const path = await this.store.loadEvolutionPath(id);
    return path ?? ready;
  }
}
