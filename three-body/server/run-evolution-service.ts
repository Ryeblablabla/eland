import { createSimulation, type SimulationState } from '../src/game/eland/simulation';
import { buildEvolutionFactsReport, checkpointFor, evolvePath, type EvolutionPath } from './evolution-artifacts';
import {
  assertEvolutionIdentity,
  evolutionExpectedBasisKey,
  parseEvolutionRunRequest,
  type EvolutionRunRequest,
} from './evolution-request';
import { HttpError } from './http-error';
import { logPerf, perfElapsed, perfNow } from './perf';
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

  private async completeEvolution(
    id: string,
    state: SimulationState,
    previous: EvolutionPath,
    requestedEndMonth: number,
  ): Promise<EvolutionPath> {
    const running = evolvePath(state, {
      runId: id,
      provider: 'local',
      model: previous.model,
      fromMonth: previous.fromMonth,
      requestedEndMonth,
      previous,
      checkpoint: checkpointFor(state, {
        inputTokens: previous.checkpoints.at(-1)?.inputTokens ?? 0,
        outputTokens: previous.checkpoints.at(-1)?.outputTokens ?? 0,
      }, previous.checkpoints.at(-1)),
      status: 'running',
    });
    const report = buildEvolutionFactsReport(state, running);
    await this.store.saveEvolutionReport(id, report);
    const completed = evolvePath(state, {
      runId: id,
      provider: 'local',
      model: running.model,
      fromMonth: running.fromMonth,
      requestedEndMonth,
      previous: running,
      status: 'completed',
    });
    await this.store.saveEvolutionPath(id, completed);
    return completed;
  }

  private async executeLongEvolution(
    id: string,
    requestedEndMonth: number,
    initialPath: EvolutionPath,
  ): Promise<void> {
    const current = await this.store.load(id);
    const controller = createSimulation({ state: current.state });
    let persisted = current.state;
    let path = initialPath;
    const inputTokens = path.checkpoints.at(-1)?.inputTokens ?? 0;
    const outputTokens = path.checkpoints.at(-1)?.outputTokens ?? 0;
    try {
      while (persisted.clock.elapsedMonths < requestedEndMonth && persisted.civilization.status === 'running') {
        const batchMonths = Math.min(12, requestedEndMonth - persisted.clock.elapsedMonths);
        const batchStartedAt = perfNow();
        const simulationStartedAt = perfNow();
        const state = controller.step(batchMonths);
        const simulationMs = perfElapsed(simulationStartedAt);
        if (state.clock.elapsedMonths <= persisted.clock.elapsedMonths && state.civilization.status === 'running') {
          throw new Error(`演化未向前推进：仍在第 ${state.clock.elapsedMonths} 月`);
        }
        persisted = state;
        const persistenceStartedAt = perfNow();
        persisted = (await this.store.save(id, persisted, undefined, { historyMode: 'append' })).state;
        path = evolvePath(persisted, {
          runId: id,
          provider: 'local',
          model: RULE_PLANNER_MODEL,
          fromMonth: initialPath.fromMonth,
          requestedEndMonth,
          previous: path,
          checkpoint: checkpointFor(persisted, { inputTokens, outputTokens }, path.checkpoints.at(-1)),
          status: 'running',
        });
        await this.store.saveEvolutionPath(id, path);
        logPerf('long-evolution-batch', {
          runId: id,
          throughMonth: persisted.clock.elapsedMonths,
          batchMonths,
          people: persisted.people.length,
          totalEvents: persisted.world.past.length,
          simulationMs,
          persistenceMs: perfElapsed(persistenceStartedAt),
          totalMs: perfElapsed(batchStartedAt),
        });
      }
      await this.completeEvolution(id, persisted, path, requestedEndMonth);
    } catch (error) {
      persisted = (await this.store.save(id, persisted, undefined, { historyMode: 'append' })).state;
      path = evolvePath(persisted, {
        runId: id,
        provider: 'local',
        model: path.model,
        fromMonth: initialPath.fromMonth,
        requestedEndMonth,
        previous: path,
        checkpoint: checkpointFor(persisted, { inputTokens, outputTokens }, path.checkpoints.at(-1)),
        status: 'failed',
        failure: error instanceof Error ? error.message : String(error),
      });
      await this.store.saveEvolutionPath(id, path);
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
        const completed = await this.completeEvolution(id, current.state, initial, requestedEndMonth);
        this.releaseEvolutionJob(id, job);
        return completed;
      }

      const promise = this.serializeRun(id, () => this.executeLongEvolution(id, requestedEndMonth, initial)).then(() => undefined);
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
