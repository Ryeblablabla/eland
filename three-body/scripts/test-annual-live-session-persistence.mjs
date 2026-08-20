import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-annual-live-persistence-test-'));
const bundlePath = path.join(temporaryDirectory, 'annual-live-persistence.mjs');
let elandSessions;

function society() {
  return {
    world: {
      width: 1,
      height: 1,
      levels: 1,
      generator: { version: 'test', seed: 1 },
      surface: [0],
      elevation: [0],
      columns: [[]],
      palette: [],
      activity: { traffic: [0], transfer: [0], action: [0], attention: [0] },
    },
    agents: [],
  };
}

function frame(month) {
  return {
    runId: 'annual-live-persistence',
    authorityRevision: 'authority-1',
    branchId: 'branch-1',
    civilizationId: 1,
    elapsedMonths: month,
    calendar: { year: Math.floor(month / 12), month: month % 12, label: `month ${month}` },
    universeTime: month,
    skySample: { fromTime: month, toTime: month, fluxMean: 1, fluxMin: 1, fluxMax: 1, nearestStarDistance: 1, fate: 'stable' },
    society: society(),
    civilizationEnd: null,
    entries: [],
    speaker: null,
  };
}

try {
  process.env.THREEBODY_DATA_DIR = path.join(temporaryDirectory, 'data');
  process.env.THREEBODY_ENV_FILE = path.join(temporaryDirectory, 'missing.env');
  const entry = `
    export { handleElandApi } from ${JSON.stringify(path.resolve('server/eland-api.ts'))};
    export { elandSessions } from ${JSON.stringify(path.resolve('server/elandSession.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=annual-live-persistence-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const bundled = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const { handleElandApi } = bundled;
  elandSessions = bundled.elandSessions;

  let current = frame(10);
  let next = current;
  const fakeSession = {
    latest: () => current,
    step: async () => {
      current = next;
      return current;
    },
  };
  elandSessions.get = () => fakeSession;

  const persistenceCalls = [];
  elandSessions.persistIfCurrent = (runId, session) => {
    persistenceCalls.push({ runId, session });
    return { current: true, persisted: true };
  };
  const step = () => handleElandApi(
    'POST',
    new URL('http://localhost/api/eland/step'),
    { runId: 'annual-live-persistence' },
  );

  next = frame(11);
  assert.equal((await step()).status, 200);
  assert.equal(persistenceCalls.length, 0, 'month 11 must not persist synchronously');

  next = frame(12);
  assert.equal((await step()).status, 200);
  assert.equal(persistenceCalls.length, 1, 'a newly committed month 12 must persist once');
  assert.equal(persistenceCalls[0].runId, 'annual-live-persistence');
  assert.equal(persistenceCalls[0].session, fakeSession);

  next = current;
  assert.equal((await step()).status, 200);
  assert.equal(persistenceCalls.length, 1, 'a repeated month 12 acknowledgement must not persist again');

  current = frame(35);
  next = frame(36);
  let releaseConcurrentSteps;
  const concurrentGate = new Promise((resolve) => { releaseConcurrentSteps = resolve; });
  fakeSession.step = async () => {
    await concurrentGate;
    current = next;
    return current;
  };
  const concurrentFirst = step();
  const concurrentDuplicate = step();
  releaseConcurrentSteps();
  assert.deepEqual((await Promise.all([concurrentFirst, concurrentDuplicate])).map((response) => response.status), [200, 200]);
  assert.equal(persistenceCalls.length, 2, 'concurrent acknowledgements of one annual month must persist once');

  fakeSession.step = async () => {
    current = next;
    return current;
  };

  current = frame(23);
  next = frame(24);
  let failedPersistenceCalls = 0;
  elandSessions.persistIfCurrent = () => {
    failedPersistenceCalls += 1;
    throw new Error('simulated sqlite failure');
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => { warnings.push(String(message)); };
  let failedPersistenceResponse;
  try {
    failedPersistenceResponse = await step();
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(failedPersistenceResponse.status, 200,
    'persistence failure must not turn an already committed month into HTTP 500');
  assert.equal(failedPersistenceResponse.body.frame.elapsedMonths, 24);
  assert.match(warnings.join('\n'), /annual-live-persistence.*24.*simulated sqlite failure/u,
    'persistence failure warning must identify the run, month and cause');
  assert.equal(failedPersistenceCalls, 1);

  let retryCalls = 0;
  elandSessions.persistIfCurrent = () => {
    retryCalls += 1;
    return { current: true, persisted: true };
  };
  next = current;
  assert.equal((await step()).status, 200);
  assert.equal(retryCalls, 1, 'same-month acknowledgement must retry one failed annual persistence');
  assert.equal((await step()).status, 200);
  assert.equal(retryCalls, 1, 'successful same-month retry must not write again');

  console.log('annual live-session persistence regression passed');
} finally {
  elandSessions?.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
