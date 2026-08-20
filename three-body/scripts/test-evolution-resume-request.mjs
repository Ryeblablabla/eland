import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-evolution-request-test-'));
const bundlePath = path.join(temporaryDirectory, 'evolution-request.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/evolution-request.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  const {
    assertEvolutionIdentity,
    evolutionExpectedBasisKey,
    EvolutionIdentityConflictError,
    EvolutionRequestValidationError,
    parseEvolutionRunRequest,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  assert.deepEqual(parseEvolutionRunRequest({}), { kind: 'legacy', months: 1 });
  assert.deepEqual(parseEvolutionRunRequest({ months: 3.8 }), { kind: 'legacy', months: 3 });

  const expected = {
    label: 'matrix seed=185 years=1000 repeat=1',
    seed: 185,
    civilizationNo: 1,
    chaosIntensity: 0,
    climateBias: 'balanced',
    endpoint: { kind: 'months', value: 12_000 },
    fromMonth: 0,
  };
  const request = parseEvolutionRunRequest({ requestedEndMonth: 12_000, expected });
  assert.deepEqual(request, { kind: 'ensure-through', requestedEndMonth: 12_000, expected });
  assert.equal(evolutionExpectedBasisKey(request.expected), evolutionExpectedBasisKey({ ...expected }));
  assert.notEqual(evolutionExpectedBasisKey(request.expected), evolutionExpectedBasisKey({ ...expected, label: 'other' }));
  assert.throws(
    () => parseEvolutionRunRequest({ months: 12_000, requestedEndMonth: 12_000, expected }),
    EvolutionRequestValidationError,
  );
  assert.throws(
    () => parseEvolutionRunRequest({ requestedEndMonth: 12_000 }),
    EvolutionRequestValidationError,
  );
  assert.throws(
    () => parseEvolutionRunRequest({
      requestedEndMonth: 12_000,
      expected: { ...expected, endpoint: { kind: 'months', value: 120 } },
    }),
    EvolutionRequestValidationError,
  );

  const state = {
    seed: 185,
    clock: { elapsedMonths: 384 },
    civilization: {
      number: 1,
      status: 'running',
      conditions: {
        civilizationNo: 1,
        chaosIntensity: 0,
        climateBias: 'balanced',
        endpoint: { kind: 'months', value: 12_000 },
      },
    },
  };
  const run = {
    meta: { id: 'matrix-s185-y1000-r1', label: expected.label },
    state,
  };
  const pathValue = {
    runId: run.meta.id,
    fromMonth: 0,
    requestedEndMonth: 12_000,
    reachedMonth: 372,
  };
  assert.doesNotThrow(() => assertEvolutionIdentity(run, pathValue, request));
  assert.throws(
    () => assertEvolutionIdentity(run, { ...pathValue, reachedMonth: 385 }, request),
    EvolutionIdentityConflictError,
    'persisted path may lag state after a crash, but may never lead it',
  );
  assert.throws(
    () => assertEvolutionIdentity({ ...run, meta: { ...run.meta, label: 'other matrix' } }, pathValue, request),
    EvolutionIdentityConflictError,
  );
  assert.throws(
    () => assertEvolutionIdentity({
      ...run,
      state: {
        ...state,
        civilization: {
          ...state.civilization,
          conditions: { ...state.civilization.conditions, civilizationNo: 2 },
        },
      },
    }, pathValue, request),
    EvolutionIdentityConflictError,
  );
  assert.throws(
    () => assertEvolutionIdentity(run, { ...pathValue, requestedEndMonth: 120 }, request),
    EvolutionIdentityConflictError,
  );
  assert.throws(
    () => assertEvolutionIdentity(run, { ...pathValue, fromMonth: 12 }, request),
    EvolutionIdentityConflictError,
  );
  assert.throws(
    () => assertEvolutionIdentity({ ...run, state: { ...state, clock: { elapsedMonths: 12_001 } } }, pathValue, request),
    EvolutionIdentityConflictError,
  );

  process.stdout.write('evolution resume request tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
