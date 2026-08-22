import { checkpointFor, evolvePath, type EvolutionPath } from './evolution-artifacts';
import {
  assertEvolutionIdentity,
  evolutionExpectedBasisKey,
  parseEvolutionRunRequest,
  type EvolutionRunRequest,
} from './evolution-request';
import { HttpError } from './http-error';
import { completeLongEvolution } from './run-evolution-executor';
import { executeLongEvolutionInWorker } from './run-evolution-worker-client';
import type { SqliteRunStore } from './sqlite-run-store';

const RULE_PLANNER_MODEL = 'rule-planner-v1';

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
      this.releaseEvolutionJob(id, job);
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
    return this.serializeRun(id, async () => {
      const current = await this.store.load(id);
      const previous = await this.store.loadEvolutionPath(id);
      const requestedEndMonth = request.kind === 'ensure-through'
        ? request.requestedEndMonth
        : current.state.clock.elapsedMonths + request.months;
      job.requestedEndMonth = requestedEndMonth;
      if (request.kind === 'ensure-through') assertEvolutionIdentity(current, previous, request);
      else if (current.state.civilization.status === 'ended') throw new HttpError(409, `运行 ${id} 已经结束`);

      if (request.kind === 'ensure-through' && previous?.status === 'failed') {
        this.releaseEvolutionJob(id, job);
        return previous;
      }

      if (request.kind === 'ensure-through'
        && previous?.status === 'completed'
        && (current.state.civilization.status === 'ended' || current.state.clock.elapsedMonths >= requestedEndMonth)) {
        this.releaseEvolutionJob(id, job);
        return previous;
      }

      const fromMonth = previous?.fromMonth
        ?? (request.kind === 'ensure-through' ? request.expected.fromMonth : current.state.clock.elapsedMonths);
      const initial = evolvePath(current.state, {
        runId: id,
        provider: 'local',
        model: previous?.model ?? RULE_PLANNER_MODEL,
        fromMonth,
        requestedEndMonth,
        ...(previous ? { previous } : {}),
        checkpoint: checkpointFor(current.state, {
          inputTokens: previous?.checkpoints.at(-1)?.inputTokens ?? 0,
          outputTokens: previous?.checkpoints.at(-1)?.outputTokens ?? 0,
        }, previous?.checkpoints.at(-1)),
        status: 'running',
      });
      await this.store.saveEvolutionPath(id, initial);

      if (current.state.civilization.status === 'ended' || current.state.clock.elapsedMonths >= requestedEndMonth) {
        const completed = await completeLongEvolution(this.store, id, current.state, initial, requestedEndMonth);
        this.releaseEvolutionJob(id, job);
        return completed;
      }

      const promise = this.serializeRun(id, () => executeLongEvolutionInWorker(
        this.store.dataDirectory(),
        id,
        requestedEndMonth,
      )).then(() => undefined);
      job.promise = promise;
      this.observeEvolutionJob(id, job, promise);
      return initial;
    });
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
