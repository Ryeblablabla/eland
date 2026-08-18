import { parentPort } from 'node:worker_threads';

import { handleElandApi, type ElandApiResponse } from './eland-api';
import { elandSessions } from './elandSession';

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
  result?: ElandApiResponse;
  error?: string;
}

if (!parentPort) throw new Error('eland-worker 必须在 Worker Thread 中运行');
const port = parentPort;

port.on('message', (request: WorkerRequest) => {
  if ('control' in request) {
    try {
      port.postMessage({ id: request.id, persistedSessions: elandSessions.persistAll() });
    } catch (error) {
      port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  void handleElandApi(request.method, new URL(request.url), request.body)
    .then((result) => port.postMessage({ id: request.id, result } satisfies WorkerResponse))
    .catch((error: unknown) => port.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResponse));
});
