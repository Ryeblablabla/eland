import { parentPort } from 'node:worker_threads';

import { handleElandApi } from './eland-api';
import { elandSessions } from './elandSession';
import { logPerf, perfElapsed, perfNow } from './perf';

interface WorkerApiRequest {
  id: number;
  method?: string;
  url: string;
  body: unknown;
}

interface WorkerPersistRequest {
  id: number;
  control: 'persist';
}

type WorkerRequest = WorkerApiRequest | WorkerPersistRequest;

interface WorkerResponse {
  id: number;
  status?: number;
  body?: ArrayBuffer;
  error?: string;
}

if (!parentPort) throw new Error('eland-worker 必须在 Worker Thread 中运行');
const port = parentPort;

port.on('message', (request: WorkerRequest) => {
  if ('control' in request) {
    try {
      const persistedSessions = elandSessions.persistAll();
      elandSessions.close();
      port.postMessage({ id: request.id, persistedSessions });
    } catch (error) {
      port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  void handleElandApi(request.method, new URL(request.url), request.body)
    .then((result) => {
      const startedAt = perfNow();
      const body = new TextEncoder().encode(JSON.stringify(result.body));
      logPerf('worker-response', { encodeMs: perfElapsed(startedAt), bytes: body.byteLength });
      port.postMessage(
        { id: request.id, status: result.status, body: body.buffer } satisfies WorkerResponse,
        [body.buffer],
      );
    })
    .catch((error: unknown) => port.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResponse));
});
