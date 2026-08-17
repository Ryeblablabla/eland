import { Worker } from 'node:worker_threads';

import type { ElandApiResponse } from './eland-api';

interface WorkerResponse {
  id: number;
  result?: ElandApiResponse;
  error?: string;
}

interface PendingRequest {
  resolve: (value: ElandApiResponse) => void;
  reject: (reason: Error) => void;
}

export class ElandWorkerClient {
  private readonly worker = new Worker(new URL('./eland-worker.mjs', import.meta.url), {
    // 演化过程会产生很多短命对象；约束 Worker 的代际堆可让 GC 更早回收，
    // 同时不挤占 Vite 与 WebGL 页面所在的主进程资源。
    resourceLimits: {
      maxOldGenerationSizeMb: Number(process.env.ELAND_WORKER_OLD_SPACE_MB) || 256,
      maxYoungGenerationSizeMb: Number(process.env.ELAND_WORKER_YOUNG_SPACE_MB) || 16,
    },
  });
  private readonly pending = new Map<number, PendingRequest>();
  private sequence = 0;

  constructor() {
    this.worker.on('message', (message: WorkerResponse) => {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.result) request.resolve(message.result);
      else request.reject(new Error(message.error ?? '文明演化 Worker 返回空结果'));
    });
    this.worker.on('error', (error) => this.rejectAll(error));
    this.worker.on('exit', (code) => {
      if (code !== 0) this.rejectAll(new Error(`文明演化 Worker 异常退出（${code}）`));
    });
  }

  handle(method: string | undefined, url: URL, body: unknown): Promise<ElandApiResponse> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, url: url.toString(), body });
    });
  }

  async close(): Promise<void> {
    await this.worker.terminate();
    this.rejectAll(new Error('文明演化 Worker 已关闭'));
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
