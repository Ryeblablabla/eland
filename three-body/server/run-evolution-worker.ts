import { parentPort, workerData } from 'node:worker_threads';

import { checkpointFor, evolvePath, type EvolutionPath } from './evolution-artifacts';
import {
  assertEvolutionIdentity,
  EvolutionIdentityConflictError,
  type EvolutionRunRequest,
} from './evolution-request';
import { HttpError } from './http-error';
import {
  completeLongEvolution,
  executeLongEvolutionFromOwnedState,
} from './run-evolution-executor';
import {
  RunAlreadyExistsError,
  RunNotFoundError,
  RunWriteConflictError,
} from './run-persistence';
import { SqliteRunStore } from './sqlite-run-store';

const RULE_PLANNER_MODEL = 'rule-planner-v1';

interface RunEvolutionWorkerData {
  dataDirectory: string;
  runId: string;
  request: EvolutionRunRequest;
}

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

function serializedWorkerError(error: unknown): SerializedWorkerError {
  const base = {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  };
  if (error instanceof EvolutionIdentityConflictError) {
    return { kind: 'evolution-identity-conflict', ...base };
  }
  if (error instanceof HttpError) return { kind: 'http', status: error.status, ...base };
  if (error instanceof RunNotFoundError) return { kind: 'run-not-found', ...base };
  if (error instanceof RunAlreadyExistsError) return { kind: 'run-already-exists', ...base };
  if (error instanceof RunWriteConflictError) return { kind: 'run-write-conflict', ...base };
  return { kind: 'error', ...base };
}

if (!parentPort) throw new Error('run-evolution-worker 必须在 Worker Thread 中运行');

const input = workerData as RunEvolutionWorkerData;
const store = new SqliteRunStore(input.dataDirectory);

void (async () => {
  try {
    // The run is hydrated exactly once in this bounded Worker. Do not load it
    // again after identity/path bootstrap; the same owned state continues into
    // the simulation controller below.
    const current = await store.load(input.runId);
    const previous = await store.loadEvolutionPath(input.runId);
    const requestedEndMonth = input.request.kind === 'ensure-through'
      ? input.request.requestedEndMonth
      : current.state.clock.elapsedMonths + input.request.months;

    if (input.request.kind === 'ensure-through') {
      assertEvolutionIdentity(current, previous, input.request);
    } else if (current.state.civilization.status === 'ended') {
      throw new HttpError(409, `运行 ${input.runId} 已经结束`);
    }

    if (input.request.kind === 'ensure-through' && previous?.status === 'failed') {
      parentPort.postMessage({ type: 'ready', path: previous } satisfies RunEvolutionWorkerMessage);
      parentPort.postMessage({ type: 'completed' } satisfies RunEvolutionWorkerMessage);
      return;
    }

    if (input.request.kind === 'ensure-through'
      && previous?.status === 'completed'
      && (current.state.civilization.status === 'ended'
        || current.state.clock.elapsedMonths >= requestedEndMonth)) {
      parentPort.postMessage({ type: 'ready', path: previous } satisfies RunEvolutionWorkerMessage);
      parentPort.postMessage({ type: 'completed' } satisfies RunEvolutionWorkerMessage);
      return;
    }

    const fromMonth = previous?.fromMonth
      ?? (input.request.kind === 'ensure-through'
        ? input.request.expected.fromMonth
        : current.state.clock.elapsedMonths);
    const initialPath = evolvePath(current.state, {
      runId: input.runId,
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
    await store.saveEvolutionPath(input.runId, initialPath);

    if (current.state.civilization.status === 'ended'
      || current.state.clock.elapsedMonths >= requestedEndMonth) {
      const completed = await completeLongEvolution(
        store,
        input.runId,
        current.state,
        initialPath,
        requestedEndMonth,
      );
      parentPort.postMessage({ type: 'ready', path: completed } satisfies RunEvolutionWorkerMessage);
      parentPort.postMessage({ type: 'completed' } satisfies RunEvolutionWorkerMessage);
      return;
    }

    parentPort.postMessage({ type: 'ready', path: initialPath } satisfies RunEvolutionWorkerMessage);
    await executeLongEvolutionFromOwnedState(
      store,
      input.runId,
      requestedEndMonth,
      initialPath,
      current.state,
    );
    parentPort.postMessage({ type: 'completed' } satisfies RunEvolutionWorkerMessage);
  } catch (error) {
    parentPort.postMessage({
      type: 'failed',
      error: serializedWorkerError(error),
    } satisfies RunEvolutionWorkerMessage);
  } finally {
    store.close();
  }
})();
