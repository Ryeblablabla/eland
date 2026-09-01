import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-evolution-failure-atomicity-'));
const bundlePath = path.join(temporaryDirectory, 'bundle.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/simulation.ts'))};
    export { checkpointFor, evolvePath } from ${JSON.stringify(path.resolve('server/evolution-artifacts.ts'))};
    export { persistLongEvolutionFailure } from ${JSON.stringify(path.resolve('server/run-evolution-executor.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=long-evolution-failure-atomicity-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'inherit', 'inherit'] });
  const {
    checkpointFor,
    createInitialState,
    evolvePath,
    persistLongEvolutionFailure,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const clean = createInitialState(17, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const checkpoint = checkpointFor(clean, { inputTokens: 0, outputTokens: 0 });
  const running = evolvePath(clean, {
    runId: 'failure-atomicity-fixture', provider: 'local', model: 'rule-planner-v1',
    fromMonth: 0, requestedEndMonth: 12, checkpoint, status: 'running',
  });
  let stateSaveCalls = 0;
  const savedPaths = [];
  const store = {
    async load() {
      return { meta: {}, state: structuredClone(clean) };
    },
    async save() {
      stateSaveCalls += 1;
      throw new Error('failure path must never save the controller-owned partial state');
    },
    async saveEvolutionPath(_id, pathValue) {
      savedPaths.push(structuredClone(pathValue));
    },
    async saveEvolutionReport() {
      throw new Error('failure path must not publish a completed report');
    },
  };

  const failed = await persistLongEvolutionFailure(
    store,
    'failure-atomicity-fixture',
    running,
    running,
    12,
    0,
    0,
    new Error('fixture mid-month failure'),
  );
  assert.equal(stateSaveCalls, 0);
  assert.equal(savedPaths.length, 1);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure, 'fixture mid-month failure');
  assert.equal(failed.reachedMonth, 0);
  assert.equal(failed.checkpoints.at(-1)?.month, 0);
  assert.equal(savedPaths[0].reachedMonth, 0,
    'the failure sidecar must be projected from the last store-loaded root, not a partial next month');

  process.stdout.write('long evolution failure atomicity tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
