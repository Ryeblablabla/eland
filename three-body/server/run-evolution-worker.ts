import { parentPort, workerData } from 'node:worker_threads';

import { executeLongEvolution } from './run-evolution-executor';
import { SqliteRunStore } from './sqlite-run-store';

interface RunEvolutionWorkerData {
  dataDirectory: string;
  runId: string;
  requestedEndMonth: number;
}

type RunEvolutionWorkerMessage =
  | { type: 'completed' }
  | { type: 'failed'; error: string };

if (!parentPort) throw new Error('run-evolution-worker 必须在 Worker Thread 中运行');

const input = workerData as RunEvolutionWorkerData;
const store = new SqliteRunStore(input.dataDirectory);

void (async () => {
  try {
    const initialPath = await store.loadEvolutionPath(input.runId);
    if (!initialPath) throw new Error(`运行 ${input.runId} 缺少演化路径`);
    await executeLongEvolution(store, input.runId, input.requestedEndMonth, initialPath);
    parentPort.postMessage({ type: 'completed' } satisfies RunEvolutionWorkerMessage);
  } catch (error) {
    parentPort.postMessage({
      type: 'failed',
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    } satisfies RunEvolutionWorkerMessage);
  } finally {
    store.close();
  }
})();
