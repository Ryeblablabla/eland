import { Worker } from 'node:worker_threads';

import { loadServerEnvValue } from './env';

interface RunEvolutionWorkerMessage {
  type: 'completed' | 'failed';
  error?: string;
}

function workerHeapLimitMb(): number {
  const configured = Number(loadServerEnvValue('ELAND_RUN_WORKER_OLD_SPACE_MB'));
  return Number.isFinite(configured) && configured >= 512
    ? Math.round(configured)
    : 4_096;
}

export function executeLongEvolutionInWorker(
  dataDirectory: string,
  runId: string,
  requestedEndMonth: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./run-evolution-worker.mjs', import.meta.url), {
      workerData: { dataDirectory, runId, requestedEndMonth },
      resourceLimits: {
        maxOldGenerationSizeMb: workerHeapLimitMb(),
        maxYoungGenerationSizeMb: 128,
      },
    });
    let settled = false;
    const finish = (result: { error?: Error } = {}): void => {
      if (settled) return;
      settled = true;
      if (result.error) reject(result.error);
      else resolve();
    };
    worker.once('message', (message: RunEvolutionWorkerMessage) => {
      if (message.type === 'failed') finish({ error: new Error(message.error ?? '长程演化 Worker 失败') });
      else finish();
    });
    worker.once('error', (error) => finish({ error }));
    worker.once('exit', (code) => {
      if (!settled) finish({ error: new Error(`长程演化 Worker 异常退出（${code}）`) });
    });
  });
}
