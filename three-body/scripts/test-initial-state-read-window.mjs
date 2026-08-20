import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-initial-state-window-test-'));
const bundlePath = path.join(temporaryDirectory, 'initial-state-window.mjs');
let elandSessions;

try {
  process.env.THREEBODY_DATA_DIR = path.join(temporaryDirectory, 'data');
  process.env.THREEBODY_ENV_FILE = path.join(temporaryDirectory, 'missing.env');
  const entry = `
    export { handleElandApi } from ${JSON.stringify(path.resolve('server/eland-api.ts'))};
    export { elandSessions } from ${JSON.stringify(path.resolve('server/elandSession.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=initial-state-window-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const bundled = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const { handleElandApi } = bundled;
  elandSessions = bundled.elandSessions;

  const history = Array.from({ length: 300 }, (_, index) => ({
    id: `history-${index}`,
    month: index,
    text: `history ${index}`,
    detail: '',
    tone: 'plain',
    kind: 'action',
    importance: 1,
    sourceEventIds: [],
    actorIds: [],
  }));
  const civilizationIndexHistory = Array.from({ length: 2_505 }, (_, index) => ({
    formulaVersion: 'test-v1',
    total: index,
    calculatedAtMonth: index,
    stage: 'test',
  }));
  const frame = { runId: 'read-window', elapsedMonths: 300 };
  const fakeSession = {
    model: () => 'local',
    latest: () => frame,
    chronicle: () => history,
    civilizationIndexHistory: () => civilizationIndexHistory,
  };

  elandSessions.get = () => fakeSession;
  const stateResponse = await handleElandApi(
    'GET',
    new URL('http://localhost/api/eland/state?runId=read-window'),
    undefined,
  );
  assert.equal(stateResponse.status, 200);
  assert.equal(stateResponse.body.history.length, 240, 'state should return only the recent history window');
  assert.equal(stateResponse.body.history[0].id, 'history-60');
  assert.equal(stateResponse.body.historyTotalCount, 300,
    'state must preserve the authoritative history total after truncation');
  assert.equal(stateResponse.body.civilizationIndexHistory.length, 2_400,
    'state should cap the civilization index trend window');
  assert.equal(stateResponse.body.civilizationIndexHistory[0].calculatedAtMonth, 105);

  elandSessions.loadSave = () => ({
    meta: { id: 'save-read-window' },
    frame,
    session: fakeSession,
  });
  const loadResponse = await handleElandApi(
    'POST',
    new URL('http://localhost/api/eland/load'),
    { runId: 'read-window', leaseId: 'lease', saveId: 'save-read-window' },
  );
  assert.equal(loadResponse.status, 200);
  assert.equal(loadResponse.body.history.length, 240, 'load should return only the recent history window');
  assert.equal(loadResponse.body.historyTotalCount, 300,
    'load must preserve the authoritative history total after truncation');
  assert.equal(loadResponse.body.civilizationIndexHistory.length, 2_400,
    'load should cap the civilization index trend window');

  console.log('initial state read window regression passed');
} finally {
  elandSessions?.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
