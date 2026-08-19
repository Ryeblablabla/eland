import { Worker } from 'node:worker_threads';

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

export class ElandWorkerClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private sequence = 0;
  private closed = false;

  constructor() {
    this.startWorker();
  }

  private startWorker(): Worker {
    if (this.closed) throw new Error('文明演化 Worker 已关闭');
    const worker = new Worker(new URL('./eland-worker.mjs', import.meta.url), {
      // 演化过程会产生很多短命对象；约束 Worker 的代际堆可让 GC 更早回收，
      // 同时不挤占 Vite 与 WebGL 页面所在的主进程资源。
      resourceLimits: {
        maxOldGenerationSizeMb: Number(process.env.ELAND_WORKER_OLD_SPACE_MB) || 256,
        maxYoungGenerationSizeMb: Number(process.env.ELAND_WORKER_YOUNG_SPACE_MB) || 16,
      },
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
    if (!this.closed) queueMicrotask(() => {
      if (!this.closed && !this.worker) this.startWorker();
    });
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
