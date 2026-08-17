import type { SimulationState } from '../src/game/eland/simulation';
import { loadLlmKey } from './env';
import type { FileRunStore } from './run-store';
import {
  narrativeEnhancementCounts,
  queueNarrativeEnhancements,
  requestKimiNarrativeEnhancement,
  type NarrativeEnhancementArtifact,
  type NarrativeEnhancementFailure,
  type NarrativeEnhancementKind,
  type NarrativeEnhancementTask,
} from './narrative-enhancements';

export interface TriggerNarrativeEnhancementsInput {
  kinds: NarrativeEnhancementKind[];
  maxNewTasks: number;
  retryFailed: boolean;
  dispatch: boolean;
}

export interface TriggerNarrativeEnhancementsResult {
  artifact: NarrativeEnhancementArtifact;
  counts: ReturnType<typeof narrativeEnhancementCounts>;
  processing: boolean;
  providerConfigured: boolean;
}

function sourceStillExists(state: SimulationState, task: NarrativeEnhancementTask): boolean {
  if (state.branchId !== task.sourceBranchId) return false;
  const eventIds = new Set(state.world.past.map((event) => event.id));
  return task.sourceEventIds.length > 0 && task.sourceEventIds.every((eventId) => eventIds.has(eventId));
}

function providerFailure(error: unknown): NarrativeEnhancementFailure {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = `${error instanceof Error ? error.name : ''} ${message}`.toLowerCase();
  const timeout = normalized.includes('timeout') || normalized.includes('aborted');
  const invalid = error instanceof SyntaxError
    || normalized.includes('json')
    || normalized.includes('缺少 text')
    || normalized.includes('没有返回叙事增强文本')
    || normalized.includes('无来源场景')
    || normalized.includes('改写成了年份');
  return {
    code: timeout ? 'timeout' : invalid ? 'invalid-response' : 'provider-error',
    message: message.slice(0, 400),
    retriable: true,
    failedAt: new Date().toISOString(),
  };
}

export class NarrativeEnhancementService {
  private readonly mutationQueues = new Map<string, Promise<unknown>>();
  private readonly jobs = new Map<string, Promise<void>>();

  constructor(private readonly store: FileRunStore) {}

  isProcessing(runId: string): boolean {
    return this.jobs.has(runId);
  }

  async load(runId: string): Promise<NarrativeEnhancementArtifact | null> {
    await this.store.load(runId);
    return this.store.loadNarrativeEnhancements(runId);
  }

  async trigger(runId: string, input: TriggerNarrativeEnhancementsInput): Promise<TriggerNarrativeEnhancementsResult> {
    const alreadyProcessing = this.jobs.has(runId);
    const artifact = await this.serializedMutation(runId, async () => {
      const run = await this.store.load(runId);
      const existing = await this.store.loadNarrativeEnhancements(runId);
      const queued = queueNarrativeEnhancements({
        runId,
        revision: run.meta.revision,
        state: run.state,
        existing,
        kinds: input.kinds,
        maxNewTasks: input.maxNewTasks,
        retryFailed: input.retryFailed,
        recoverRunning: !alreadyProcessing,
      });
      await this.store.saveNarrativeEnhancements(runId, queued);
      return queued;
    });

    const hasQueuedTasks = artifact.tasks.some((task) => task.status === 'queued');
    if (input.dispatch && hasQueuedTasks && !this.jobs.has(runId)) this.startJob(runId);
    return {
      artifact,
      counts: narrativeEnhancementCounts(artifact),
      processing: this.jobs.has(runId),
      providerConfigured: Boolean(loadLlmKey('kimi')),
    };
  }

  private async serializedMutation<T>(runId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueues.get(runId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    this.mutationQueues.set(runId, current);
    try {
      return await current;
    } finally {
      if (this.mutationQueues.get(runId) === current) this.mutationQueues.delete(runId);
    }
  }

  private startJob(runId: string): void {
    const job = this.processQueue(runId);
    this.jobs.set(runId, job);
    void job.finally(() => {
      if (this.jobs.get(runId) === job) this.jobs.delete(runId);
    }).catch((error) => console.error(`运行 ${runId} 的叙事增强任务异常`, error));
  }

  private async takeNextTask(runId: string): Promise<NarrativeEnhancementTask | null> {
    return this.serializedMutation(runId, async () => {
      const artifact = await this.store.loadNarrativeEnhancements(runId);
      if (!artifact) return null;
      const task = artifact.tasks.find((candidate) => candidate.status === 'queued');
      if (!task) return null;
      const now = new Date().toISOString();
      task.status = 'running';
      task.attempts += 1;
      task.startedAt = now;
      task.updatedAt = now;
      delete task.failure;
      artifact.updatedAt = now;
      await this.store.saveNarrativeEnhancements(runId, artifact);
      return structuredClone(task);
    });
  }

  private async mutateTask(runId: string, taskId: string, mutate: (task: NarrativeEnhancementTask, now: string) => void): Promise<void> {
    await this.serializedMutation(runId, async () => {
      const artifact = await this.store.loadNarrativeEnhancements(runId);
      if (!artifact) return;
      const task = artifact.tasks.find((candidate) => candidate.id === taskId);
      if (!task || task.status !== 'running') return;
      const now = new Date().toISOString();
      mutate(task, now);
      task.updatedAt = now;
      artifact.updatedAt = now;
      await this.store.saveNarrativeEnhancements(runId, artifact);
    });
  }

  private async markStale(runId: string, task: NarrativeEnhancementTask): Promise<void> {
    await this.mutateTask(runId, task.id, (current, now) => {
      current.status = 'stale';
      current.failure = {
        code: 'source-stale',
        message: '模型调用前后来源事件不再属于当前分支，结果未采用',
        retriable: false,
        failedAt: now,
      };
    });
  }

  private async markFailed(runId: string, task: NarrativeEnhancementTask, failure: NarrativeEnhancementFailure): Promise<void> {
    await this.mutateTask(runId, task.id, (current) => {
      current.status = 'failed';
      current.failure = failure;
    });
  }

  private async processQueue(runId: string): Promise<void> {
    const apiKey = loadLlmKey('kimi');
    for (;;) {
      const task = await this.takeNextTask(runId);
      if (!task) return;

      const before = await this.store.load(runId);
      if (!sourceStillExists(before.state, task)) {
        await this.markStale(runId, task);
        continue;
      }
      if (!apiKey) {
        await this.markFailed(runId, task, {
          code: 'missing-key',
          message: '服务端未配置 KIMI_API_KEY；权威模拟状态不受影响',
          retriable: true,
          failedAt: new Date().toISOString(),
        });
        continue;
      }

      try {
        const generated = await requestKimiNarrativeEnhancement(apiKey, task);
        const after = await this.store.load(runId);
        if (!sourceStillExists(after.state, task)) {
          await this.markStale(runId, task);
          continue;
        }
        await this.mutateTask(runId, task.id, (current, now) => {
          current.status = 'completed';
          current.completedAt = now;
          current.provider = 'kimi';
          current.model = generated.model;
          current.usage = generated.usage;
          current.result = {
            authority: 'projection-only',
            title: generated.title,
            text: generated.text,
            ...(generated.perspective ? { perspective: generated.perspective } : {}),
            sourceEventIds: [...current.sourceEventIds],
            generatedAt: now,
          };
          delete current.failure;
        });
      } catch (error) {
        await this.markFailed(runId, task, providerFailure(error));
      }
    }
  }
}
