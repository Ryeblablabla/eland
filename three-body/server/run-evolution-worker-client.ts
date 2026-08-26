import { Worker } from 'node:worker_threads';

import { loadServerEnvValue } from './env';
import type { EvolutionPath } from './evolution-artifacts';
import {
  EvolutionIdentityConflictError,
  type EvolutionRunRequest,
} from './evolution-request';
import { HttpError } from './http-error';
import {
  RunAlreadyExistsError,
  RunNotFoundError,
  RunWriteConflictError,
} from './run-persistence';

const DEFAULT_RUN_WORKER_OLD_SPACE_MB = 2_048;
const MAX_RUN_WORKER_OLD_SPACE_MB = 2_048;
const MIN_RUN_WORKER_OLD_SPACE_MB = 512;

interface SerializedWorkerError {
  kind: 'evolution-identity-conflict' | 'http' | 'run-not-found'
    | 'run-already-exists' | 'run-write-conflict' | 'error';
  message: string;
  status?: number;
  stack?: string;
}

type RunEvolutionWorkerMessage =
  | { type: 'ready'; path: EvolutionPath }
  | { type: 'completed' }
  | { type: 'failed'; error: SerializedWorkerError };

export interface EvolutionWorkerExecution {
  /** Settles after bootstrap identity checks and initial/terminal path persistence. */
  ready: Promise<EvolutionPath>;
  /** Settles only after the Worker has really exited and released its isolate. */
  completion: Promise<void>;
}

export function runEvolutionWorkerOldSpaceLimitMb(): number {
  const configuredValue = loadServerEnvValue('ELAND_RUN_WORKER_OLD_SPACE_MB');
  if (!configuredValue) return DEFAULT_RUN_WORKER_OLD_SPACE_MB;
  const configured = Number(configuredValue);
  return Number.isFinite(configured)
    ? Math.min(MAX_RUN_WORKER_OLD_SPACE_MB, Math.max(MIN_RUN_WORKER_OLD_SPACE_MB, Math.round(configured)))
    : DEFAULT_RUN_WORKER_OLD_SPACE_MB;
}

/**
 * A completed/failed message describes the domain result, but it does not
 * prove the Worker isolate and its codec cache have been released. Keep the
 * scheduler slot until `exit`, then settle from the final process outcome.
 */
function restoredWorkerError(serialized: SerializedWorkerError): Error {
  let error: Error;
  switch (serialized.kind) {
    case 'evolution-identity-conflict':
      error = new EvolutionIdentityConflictError(serialized.message);
      break;
    case 'http':
      error = new HttpError(serialized.status ?? 500, serialized.message);
      break;
    case 'run-not-found':
      error = new RunNotFoundError(serialized.message);
      break;
    case 'run-already-exists':
      error = new RunAlreadyExistsError(serialized.message);
      break;
    case 'run-write-conflict':
      error = new RunWriteConflictError(serialized.message);
      break;
    default:
      error = new Error(serialized.message);
      break;
  }
  if (serialized.stack) error.stack = serialized.stack;
  return error;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function waitForEvolutionWorker(worker: Worker): EvolutionWorkerExecution {
  const ready = deferred<EvolutionPath>();
  let readyReceived = false;
  const completion = new Promise<void>((resolve, reject) => {
    let result: RunEvolutionWorkerMessage | undefined;
    let workerError: Error | undefined;
    worker.on('message', (message: RunEvolutionWorkerMessage) => {
      if (message.type === 'ready') {
        if (!readyReceived) {
          readyReceived = true;
          ready.resolve(message.path);
        }
        return;
      }
      result = message;
      if (message.type === 'failed' && !readyReceived) {
        ready.reject(restoredWorkerError(message.error));
      }
    });
    worker.once('error', (error) => {
      workerError = error;
      if (!readyReceived) ready.reject(error);
    });
    worker.once('exit', (code) => {
      let outcomeError: Error | undefined;
      if (workerError) {
        outcomeError = workerError;
      } else if (code !== 0 || !result) {
        outcomeError = new Error(`长程演化 Worker 异常退出（${code}）`);
      } else if (result.type === 'failed') {
        outcomeError = restoredWorkerError(result.error);
      } else if (result.type === 'completed') {
        if (!readyReceived) outcomeError = new Error('长程演化 Worker 未返回 ready 路径');
      } else {
        outcomeError = new Error('长程演化 Worker 返回了未知结果');
      }
      if (outcomeError) {
        if (!readyReceived) ready.reject(outcomeError);
        reject(outcomeError);
      } else resolve();
    });
  });
  return { ready: ready.promise, completion };
}

/** Backward-compatible completion-only view used by focused lifecycle callers. */
export function waitForEvolutionWorkerExit(worker: Worker): Promise<void> {
  const execution = waitForEvolutionWorker(worker);
  void execution.ready.catch(() => undefined);
  return execution.completion;
}

export function executeLongEvolutionInWorker(
  dataDirectory: string,
  runId: string,
  request: EvolutionRunRequest,
): EvolutionWorkerExecution {
  const worker = new Worker(new URL('./run-evolution-worker.mjs', import.meta.url), {
    workerData: { dataDirectory, runId, request },
    resourceLimits: {
      maxOldGenerationSizeMb: runEvolutionWorkerOldSpaceLimitMb(),
      maxYoungGenerationSizeMb: 128,
      stackSizeMb: 16,
    },
  });
  return waitForEvolutionWorker(worker);
}
