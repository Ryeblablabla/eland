import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-intent-identity-'));
const bundlePath = path.join(temporaryDirectory, 'intent-identity.mjs');

try {
  const entry = `
    import {
      adoptSimulationState as adoptApplicationState,
      createInitialState as createApplicationState,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/simulation/state-lifecycle.ts'))};
    export {
      installAgreementContinuation,
      startIntent,
      startInterruptIntent,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/simulation/intent-execution.ts'))};
    const projector = { project() { return { kind: 'deferred', reason: 'identity fixture owns no observer materialization' }; } };
    export const createInitialState = (seed, config) => createApplicationState(projector, seed, config);
    export const adoptSimulationState = (state) => adoptApplicationState(projector, state);
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=intent-identity-test-entry.ts', `--outfile=${bundlePath}`,
  ], {
    input: entry,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=256' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const state = api.createInitialState(82_601, {
    endpoint: { kind: 'months', value: 24 },
    chaosIntensity: 0,
  });
  assert.deepEqual(state.identityCounters, { intentOrdinal: 0 });

  const owner = state.people[0];
  const agreementOwner = state.people[1];
  assert.ok(owner && agreementOwner, 'fixture requires two living founders');
  const atCellOption = (person, id) => ({
    id,
    summary: `保持在${person.position.cellId}`,
    reason: 'identity fixture',
    goal: { kind: 'at-cell', cellId: person.position.cellId },
    nextAction: { kind: 'move', toCellId: person.position.cellId, toZ: person.position.z },
    estimatedDuration: 'one-month',
    sourceFactIds: [],
    domain: 'strategic',
  });
  const contextFor = (person, option) => ({
    state,
    person,
    visibleCells: [person.position.cellId],
    visiblePeople: [],
    visibleDrops: [],
    visibleAnimals: [],
    visibleRemains: [],
    options: [option],
    followUpOptions: [],
  });

  const firstOption = atCellOption(owner, 'fixture:first');
  const firstIntent = api.startIntent(
    state,
    owner,
    contextFor(owner, firstOption),
    firstOption.id,
    undefined,
    'decision:first',
    0,
  );
  assert.equal(firstIntent?.id, `intent-0-${owner.id}-0`, 'uncompacted first intent keeps its historical ID text');
  assert.equal(state.identityCounters.intentOrdinal, 1);

  const terminalIntent = (ordinal) => ({
    id: `intent-12-${owner.id}-${ordinal}`,
    ownerId: owner.id,
    summary: `legacy terminal ${ordinal}`,
    domain: 'strategic',
    goal: { kind: 'at-cell', cellId: owner.position.cellId },
    nextAction: { kind: 'move', toCellId: owner.position.cellId, toZ: owner.position.z },
    status: 'completed',
    createdAtMonth: 12,
    lastProgressAtMonth: 12,
    progress: 1,
    sourceDecisionEventId: `decision:legacy:${ordinal}`,
    sourceFactIds: [],
    actionEventIds: [],
    replanCount: 0,
  });
  const originalIntents = Array.from({ length: 5 }, (_, ordinal) => terminalIntent(ordinal));
  state.intents = originalIntents;
  delete owner.activeIntentId;
  delete state.identityCounters;

  api.adoptSimulationState(state);
  assert.equal(state.identityCounters.intentOrdinal, originalIntents.length, 'old state derives the next ordinal from full intent count');
  state.identityCounters.intentOrdinal = -7;
  api.adoptSimulationState(state);
  assert.equal(state.identityCounters.intentOrdinal, originalIntents.length, 'negative counter is repaired');
  state.identityCounters.intentOrdinal = 2;
  api.adoptSimulationState(state);
  assert.equal(state.identityCounters.intentOrdinal, originalIntents.length, 'counter cannot trail retained intents');
  state.identityCounters.intentOrdinal = 1.5;
  api.adoptSimulationState(state);
  assert.equal(state.identityCounters.intentOrdinal, originalIntents.length, 'non-integer counter is repaired');
  state.identityCounters.intentOrdinal = '9';
  api.adoptSimulationState(state);
  assert.equal(state.identityCounters.intentOrdinal, originalIntents.length, 'non-number counter is repaired instead of coerced');

  const originalIds = new Set(originalIntents.map((intent) => intent.id));
  state.intents = [originalIntents.at(-1)];
  const ordinaryOption = atCellOption(owner, 'fixture:ordinary-after-compaction');
  const ordinary = api.startIntent(
    state,
    owner,
    contextFor(owner, ordinaryOption),
    ordinaryOption.id,
    undefined,
    'decision:ordinary-after-compaction',
    12,
  );
  assert.equal(ordinary?.id, `intent-12-${owner.id}-5`);
  assert.ok(!originalIds.has(ordinary.id), 'compacting terminal intents does not recycle an old ID');
  assert.equal(state.identityCounters.intentOrdinal, 6);

  const interruptOption = atCellOption(owner, 'fixture:interrupt');
  const interrupted = api.startInterruptIntent(
    state,
    owner,
    contextFor(owner, interruptOption),
    interruptOption.id,
    'decision:interrupt',
    12,
    'survival-reflex',
  );
  assert.equal(interrupted?.id, `intent-12-${owner.id}-interrupt-6`);
  assert.equal(state.identityCounters.intentOrdinal, 7);

  const continuation = {
    agreementId: 'agreement:fixture',
    personId: agreementOwner.id,
    summary: '履行测试承诺',
    goal: { kind: 'at-cell', cellId: agreementOwner.position.cellId },
    nextAction: {
      kind: 'move',
      toCellId: agreementOwner.position.cellId,
      toZ: agreementOwner.position.z,
    },
    sourceFactIds: ['agreement:fixture:accepted'],
  };
  const agreementIntent = api.installAgreementContinuation(state, interrupted, continuation, 12);
  assert.equal(agreementIntent?.id, `intent-12-${agreementOwner.id}-agreement-7`);
  assert.equal(state.identityCounters.intentOrdinal, 8);

  const intentCountBeforeReuse = state.intents.length;
  const reused = api.installAgreementContinuation(state, agreementIntent, {
    ...continuation,
    summary: '继续履行同一测试承诺',
  }, 13);
  assert.equal(reused, agreementIntent, 'continuing the current agreement intent reuses its identity');
  assert.equal(state.intents.length, intentCountBeforeReuse);
  assert.equal(state.identityCounters.intentOrdinal, 8, 'agreement continuation consumes an ordinal only for a real new intent');

  const retainedIds = state.intents.map((intent) => intent.id);
  assert.equal(new Set(retainedIds).size, retainedIds.length, 'all retained intent IDs stay unique');
  console.log(JSON.stringify({
    ok: true,
    originalIntentCount: originalIntents.length,
    compactIntentCount: 1,
    allocatedIds: [ordinary.id, interrupted.id, agreementIntent.id],
    nextIntentOrdinal: state.identityCounters.intentOrdinal,
    rssBytes: process.memoryUsage().rss,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
