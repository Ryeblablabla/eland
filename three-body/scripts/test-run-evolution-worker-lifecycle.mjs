import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-evolution-worker-lifecycle-'));
const serviceBundlePath = path.join(temporaryDirectory, 'run-evolution-service.mjs');
const clientBundlePath = path.join(temporaryDirectory, 'run-evolution-worker-client.mjs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function assertPending(promise, message) {
  let settled = false;
  void promise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await nextTurn();
  assert.equal(settled, false, message);
}

try {
  const esbuild = path.resolve('node_modules/.bin/esbuild');
  for (const [entry, output] of [
    ['server/run-evolution-service.ts', serviceBundlePath],
    ['server/run-evolution-worker-client.ts', clientBundlePath],
  ]) {
    execFileSync(esbuild, [
      entry,
      '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
    ], { stdio: 'pipe' });
  }

  const { enqueueEvolutionWorker, serializeEvolutionWorker } = await import(
    `${pathToFileURL(serviceBundlePath).href}?test=${Date.now()}`
  );
  const {
    runEvolutionWorkerOldSpaceLimitMb,
    waitForEvolutionWorker,
    waitForEvolutionWorkerExit,
  } = await import(`${pathToFileURL(clientBundlePath).href}?test=${Date.now()}`);

  const firstGate = deferred();
  const order = [];
  let active = 0;
  let peakActive = 0;
  const first = serializeEvolutionWorker(async () => {
    order.push('first:start');
    active += 1;
    peakActive = Math.max(peakActive, active);
    await firstGate.promise;
    active -= 1;
    order.push('first:end');
  });
  const second = serializeEvolutionWorker(async () => {
    order.push('second:start');
    active += 1;
    peakActive = Math.max(peakActive, active);
    active -= 1;
    order.push('second:end');
  });
  await nextTurn();
  assert.deepEqual(order, ['first:start'], '后提交的 evolution worker 必须等待 active worker 退出');
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.equal(peakActive, 1, '单进程最多只能有一个 active evolution worker');
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);

  const expectedFailure = new Error('synthetic worker failure');
  const failed = serializeEvolutionWorker(async () => {
    order.push('failed:start');
    throw expectedFailure;
  });
  const afterFailure = serializeEvolutionWorker(async () => {
    order.push('after-failure:start');
  });
  await assert.rejects(failed, (error) => error === expectedFailure);
  await afterFailure;
  assert.deepEqual(order.slice(-2), ['failed:start', 'after-failure:start'], '失败必须释放全局队列');

  await serializeEvolutionWorker(async () => {
    order.push('idle-reuse:start');
  });
  assert.equal(order.at(-1), 'idle-reuse:start', '队列清空后必须可继续使用');

  const queuedFirstReady = deferred();
  const queuedFirstExit = deferred();
  const queuedSecondReady = deferred();
  const queuedSecondExit = deferred();
  const queuedOrder = [];
  const queuedFirst = enqueueEvolutionWorker(() => {
    queuedOrder.push('first:constructed');
    return { ready: queuedFirstReady.promise, completion: queuedFirstExit.promise };
  });
  const queuedSecond = enqueueEvolutionWorker(() => {
    queuedOrder.push('second:constructed');
    return { ready: queuedSecondReady.promise, completion: queuedSecondExit.promise };
  });
  await nextTurn();
  assert.deepEqual(queuedOrder, ['first:constructed']);
  const firstPath = { runId: 'first', requestedEndMonth: 12 };
  queuedFirstReady.resolve(firstPath);
  assert.equal(await queuedFirst.ready, firstPath, 'ready 路径应在 Worker exit 前交给 HTTP 层');
  await assertPending(queuedFirst.completion, 'ready 不能释放全局 Worker 槽位');
  assert.deepEqual(queuedOrder, ['first:constructed']);
  queuedFirstExit.resolve();
  await queuedFirst.completion;
  await nextTurn();
  assert.deepEqual(queuedOrder, ['first:constructed', 'second:constructed']);
  const secondPath = { runId: 'second', requestedEndMonth: 24 };
  queuedSecondReady.resolve(secondPath);
  assert.equal(await queuedSecond.ready, secondPath);
  queuedSecondExit.resolve();
  await queuedSecond.completion;

  const completedWorker = new EventEmitter();
  const completedExecution = waitForEvolutionWorker(completedWorker);
  const completedPath = { runId: 'completed', requestedEndMonth: 36 };
  completedWorker.emit('message', { type: 'ready', path: completedPath });
  assert.equal(await completedExecution.ready, completedPath);
  completedWorker.emit('message', { type: 'completed' });
  await assertPending(completedExecution.completion, 'completed 消息不能在 Worker exit 前释放调度槽');
  completedWorker.emit('exit', 0);
  await completedExecution.completion;

  const failedWorker = new EventEmitter();
  const domainFailure = waitForEvolutionWorker(failedWorker);
  failedWorker.emit('message', {
    type: 'failed',
    error: { kind: 'evolution-identity-conflict', message: 'domain failure' },
  });
  await assert.rejects(domainFailure.ready, (error) => (
    error?.constructor?.name === 'EvolutionIdentityConflictError'
      && error.message === 'domain failure'
  ));
  await assertPending(domainFailure.completion, 'failed 消息也必须等待 Worker exit');
  failedWorker.emit('exit', 0);
  await assert.rejects(domainFailure.completion, (error) => (
    error?.constructor?.name === 'EvolutionIdentityConflictError'
      && error.message === 'domain failure'
  ));

  const httpFailureWorker = new EventEmitter();
  const httpFailure = waitForEvolutionWorker(httpFailureWorker);
  httpFailureWorker.emit('message', {
    type: 'failed',
    error: { kind: 'http', status: 409, message: 'already ended' },
  });
  await assert.rejects(httpFailure.ready, (error) => error?.status === 409 && error.message === 'already ended');
  httpFailureWorker.emit('exit', 0);
  await assert.rejects(httpFailure.completion, (error) => error?.status === 409);

  const readyThenFailedWorker = new EventEmitter();
  const readyThenFailed = waitForEvolutionWorker(readyThenFailedWorker);
  readyThenFailedWorker.emit('message', { type: 'ready', path: completedPath });
  await readyThenFailed.ready;
  readyThenFailedWorker.emit('message', {
    type: 'failed',
    error: { kind: 'error', message: 'post-ready failure' },
  });
  await assertPending(readyThenFailed.completion, 'post-ready failure 仍须等待 exit');
  readyThenFailedWorker.emit('exit', 0);
  await assert.rejects(readyThenFailed.completion, /post-ready failure/u);

  const erroredWorker = new EventEmitter();
  const workerError = new Error('worker thread error');
  const erroredExecution = waitForEvolutionWorker(erroredWorker);
  const erroredReady = assert.rejects(erroredExecution.ready, (error) => error === workerError);
  erroredWorker.emit('error', workerError);
  await erroredReady;
  await assertPending(erroredExecution.completion, 'error 事件必须等 exit 后才释放调度槽');
  erroredWorker.emit('exit', 1);
  await assert.rejects(erroredExecution.completion, (error) => error === workerError);

  const missingResultWorker = new EventEmitter();
  const missingResultExecution = waitForEvolutionWorker(missingResultWorker);
  const missingReady = assert.rejects(missingResultExecution.ready, /异常退出（0）/u);
  missingResultWorker.emit('exit', 0);
  await missingReady;
  await assert.rejects(missingResultExecution.completion, /异常退出（0）/u);

  const nonzeroWorker = new EventEmitter();
  const nonzero = waitForEvolutionWorkerExit(nonzeroWorker);
  nonzeroWorker.emit('message', { type: 'ready', path: completedPath });
  nonzeroWorker.emit('message', { type: 'completed' });
  nonzeroWorker.emit('exit', 2);
  await assert.rejects(nonzero, /异常退出（2）/u);

  const previousLimit = process.env.ELAND_RUN_WORKER_OLD_SPACE_MB;
  try {
    process.env.ELAND_RUN_WORKER_OLD_SPACE_MB = '8192';
    assert.equal(runEvolutionWorkerOldSpaceLimitMb(), 2048, '显式配置也不能突破 2 GiB 上限');
    process.env.ELAND_RUN_WORKER_OLD_SPACE_MB = '2048';
    assert.equal(runEvolutionWorkerOldSpaceLimitMb(), 2048);
    process.env.ELAND_RUN_WORKER_OLD_SPACE_MB = '128';
    assert.equal(runEvolutionWorkerOldSpaceLimitMb(), 512, '过低配置按 Worker 安全下限收敛');
    process.env.ELAND_RUN_WORKER_OLD_SPACE_MB = 'invalid';
    assert.equal(runEvolutionWorkerOldSpaceLimitMb(), 2048, '非法配置回退到 2 GiB 默认值');
  } finally {
    if (previousLimit === undefined) delete process.env.ELAND_RUN_WORKER_OLD_SPACE_MB;
    else process.env.ELAND_RUN_WORKER_OLD_SPACE_MB = previousLimit;
  }

  console.log('run evolution worker lifecycle tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
