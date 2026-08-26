import { Worker, type WorkerOptions } from 'node:worker_threads';

import { loadServerEnvValue } from './env';

export interface EncodedElandApiResponse {
  status: number;
  body: ArrayBuffer;
}

interface WorkerResponse {
  id: number;
  status?: number;
  body?: ArrayBuffer;
  error?: string;
  persistedSessions?: number;
}

interface PendingRequest {
  resolve: (value: EncodedElandApiResponse) => void;
  reject: (reason: Error) => void;
}

const DEFAULT_WORKER_OLD_SPACE_MB = 1_536;
const MAX_WORKER_OLD_SPACE_MB = 2_048;
const MIN_WORKER_OLD_SPACE_MB = 16;
const DEFAULT_WORKER_YOUNG_SPACE_MB = 64;
const MAX_WORKER_YOUNG_SPACE_MB = 128;
const MIN_WORKER_YOUNG_SPACE_MB = 4;
const DEFAULT_WORKER_STACK_MB = 8;
const MAX_WORKER_STACK_MB = 16;
const MIN_WORKER_STACK_MB = 4;

function boundedResourceLimitMb(
  envName: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const configured = Number(loadServerEnvValue(envName));
  if (!Number.isFinite(configured) || configured <= 0) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(configured)));
}

export function workerResourceLimits(): NonNullable<WorkerOptions['resourceLimits']> {
  return {
    maxOldGenerationSizeMb: boundedResourceLimitMb(
      'ELAND_WORKER_OLD_SPACE_MB',
      DEFAULT_WORKER_OLD_SPACE_MB,
      MIN_WORKER_OLD_SPACE_MB,
      MAX_WORKER_OLD_SPACE_MB,
    ),
    maxYoungGenerationSizeMb: boundedResourceLimitMb(
      'ELAND_WORKER_YOUNG_SPACE_MB',
      DEFAULT_WORKER_YOUNG_SPACE_MB,
      MIN_WORKER_YOUNG_SPACE_MB,
      MAX_WORKER_YOUNG_SPACE_MB,
    ),
    stackSizeMb: boundedResourceLimitMb(
      'ELAND_WORKER_STACK_MB',
      DEFAULT_WORKER_STACK_MB,
      MIN_WORKER_STACK_MB,
      MAX_WORKER_STACK_MB,
    ),
  };
}

type WorkerFactory = (url: URL, options: WorkerOptions) => Worker;

export class ElandWorkerClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private sequence = 0;
  private closed = false;

  constructor(
    private readonly createWorker: WorkerFactory = (url, options) => new Worker(url, options),
  ) {}

  private startWorker(): Worker {
    if (this.closed) throw new Error('文明演化 Worker 已关闭');
    const worker = this.createWorker(new URL('./eland-worker.mjs', import.meta.url), {
      // 实时恢复、按需历史回放和响应投影需要堆余量，但不能挤占宿主机全部内存。
      resourceLimits: workerResourceLimits(),
    });
    this.worker = worker;
    worker.on('message', (message: WorkerResponse) => {
      if (this.worker !== worker) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.status !== undefined && message.body) {
        request.resolve({ status: message.status, body: message.body });
      }
      else request.reject(new Error(message.error ?? '文明演化 Worker 返回空结果'));
    });
    worker.on('error', (error) => this.failWorker(worker, error));
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      this.failWorker(worker, new Error(`文明演化 Worker 异常退出（${code}）`));
    });
    return worker;
  }

  private failWorker(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.rejectAll(error);
    void worker.terminate().catch(() => undefined);
    // 保持惰性：异常后不在后台形成重启循环，由下一次真实请求按需重建。
  }

  handle(method: string | undefined, url: URL, body: unknown): Promise<EncodedElandApiResponse> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('文明演化 Worker 已关闭'));
        return;
      }
      let worker: Worker;
      try {
        worker = this.worker ?? this.startWorker();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, method, url: url.toString(), body });
      } catch (error) {
        this.pending.delete(id);
        const failure = error instanceof Error ? error : new Error(String(error));
        reject(failure);
        this.failWorker(worker, failure);
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const worker = this.worker;
    if (!worker) {
      this.rejectAll(new Error('文明演化 Worker 已关闭'));
      return;
    }
    const id = ++this.sequence;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        worker.off('message', onMessage);
        resolve();
      }, 4_000);
      const onMessage = (message: WorkerResponse) => {
        if (message.id !== id || message.persistedSessions === undefined && !message.error) return;
        clearTimeout(timeout);
        worker.off('message', onMessage);
        if (message.error) console.warn(`实时演化会话保存失败：${message.error}`);
        resolve();
      };
      worker.on('message', onMessage);
      try {
        worker.postMessage({ id, control: 'persist' });
      } catch {
        clearTimeout(timeout);
        worker.off('message', onMessage);
        resolve();
      }
    });
    await worker.terminate();
    if (this.worker === worker) this.worker = null;
    this.rejectAll(new Error('文明演化 Worker 已关闭'));
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
