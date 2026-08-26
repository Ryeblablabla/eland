import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-shared-observer-index-'));
const bundlePath = path.join(temporaryDirectory, 'observer-entry.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--sourcefile=observer-entry.ts', `--outfile=${bundlePath}`,
  ], {
    input: `
      export { createInitialState } from './src/game/eland/simulation.ts';
      export {
        actionFacts,
        clearPlanningEventOverlay,
        completedActionFacts,
        environmentFacts,
        registerPlanningEventOverlay,
        worldEventById,
        worldEventFacts,
      } from './src/game/eland/domain/event-index.ts';
      export { calculateCivilizationIndex } from './src/game/eland/domain/civilization-index.ts';
      export { observeCapabilityMilestones } from './src/game/eland/projection/capability-milestones.ts';
      export { observeSimulation } from './src/game/eland/projection/derived-observations.ts';
    `,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const observer = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const state = observer.createInitialState(77121, {
    endpoint: { kind: 'months', value: 12 },
    chaosIntensity: 0,
  });
  const [actor, listener] = state.people;
  assert.ok(actor && listener);
  state.clock.elapsedMonths = 8;
  state.derived.structures = [];
  state.derived.milestones = [];

  const actionFact = ({ id, atMonth, orderInMonth, who, status = 'completed', action, diff = {} }) => ({
    id,
    kind: 'action',
    atMonth,
    orderInMonth,
    planningTick: 1,
    orderInTick: orderInMonth,
    actionTick: 1,
    cellId: 0,
    who,
    cause: 'intent',
    action,
    fromCellId: 0,
    toCellId: 0,
    fromZ: 1,
    toZ: 1,
    pathSegment: [0],
    status,
    result: id,
    diff,
  });
  const environmentFact = ({ id, atMonth, orderInMonth, change, diff = {} }) => ({
    id,
    kind: 'environment',
    atMonth,
    orderInMonth,
    change,
    diff,
  });
  const attend = { kind: 'attend', target: { kind: 'cell', cellId: 0 } };
  const communicate = (contentId) => ({
    kind: 'communicate',
    audience: [listener.id],
    channel: 'speech',
    content: { id: contentId, kind: 'claim', text: contentId, factId: contentId },
  });

  const duplicateBaseAction = actionFact({
    id: 'duplicate-id', atMonth: 2, orderInMonth: 0, who: actor.id, status: 'failed', action: attend,
  });
  const duplicateBaseEnvironment = environmentFact({
    id: 'duplicate-id', atMonth: 3, orderInMonth: 0, change: 'weather', diff: { weather: 'rain' },
  });
  const baseCommunication = actionFact({
    id: 'base-communication', atMonth: 4, orderInMonth: 0, who: actor.id, action: communicate('base-claim'),
  });
  state.world.past.push(duplicateBaseAction, duplicateBaseEnvironment, baseCommunication);
  const committedPast = state.world.past;

  assert.strictEqual(observer.worldEventFacts(state), committedPast,
    'ordinary full-history reads must reuse the authoritative array');
  assert.strictEqual(observer.actionFacts(state), observer.actionFacts(state),
    'ordinary action reads must reuse the cached action array');
  assert.strictEqual(observer.completedActionFacts(state), observer.completedActionFacts(state),
    'ordinary completed-action reads must reuse the cached completed array');
  assert.strictEqual(observer.environmentFacts(state), observer.environmentFacts(state),
    'ordinary environment reads must reuse the cached environment array');
  assert.strictEqual(observer.worldEventById(state, 'duplicate-id'), duplicateBaseEnvironment,
    'base duplicate IDs must retain last-write lookup semantics');

  const duplicateOverlayAction = actionFact({
    id: 'duplicate-id', atMonth: 5, orderInMonth: 0, who: actor.id, action: communicate('overlay-first'),
  });
  const duplicateOverlayEnvironment = environmentFact({
    id: 'duplicate-id', atMonth: 6, orderInMonth: 0, change: 'climate', diff: { eraTransition: true, epoch: 'stable' },
  });
  const overlayCommunication = actionFact({
    id: 'overlay-communication', atMonth: 7, orderInMonth: 0, who: actor.id, action: communicate('overlay-claim'),
  });
  const overlay = [duplicateOverlayAction, duplicateOverlayEnvironment, overlayCommunication];
  const combinedPast = [...committedPast, ...overlay];
  const combinedState = {
    ...state,
    world: { ...state.world, past: combinedPast },
  };

  observer.registerPlanningEventOverlay(state, overlay);
  try {
    assert.deepEqual(observer.worldEventFacts(state), combinedPast,
      'planning history must preserve committed-then-overlay ordering');
    assert.deepEqual(observer.actionFacts(state), combinedPast.filter((event) => event.kind === 'action'));
    assert.deepEqual(observer.completedActionFacts(state), combinedPast
      .filter((event) => event.kind === 'action' && event.status === 'completed'));
    assert.deepEqual(observer.environmentFacts(state), combinedPast.filter((event) => event.kind === 'environment'));
    assert.strictEqual(observer.worldEventById(state, 'duplicate-id'), duplicateOverlayEnvironment,
      'overlay duplicate IDs must retain global last-write lookup semantics');

    assert.deepEqual(
      observer.observeCapabilityMilestones(state, []),
      observer.observeCapabilityMilestones(combinedState, []),
      'capability projection must match a legacy combined history under a planning overlay',
    );
    assert.deepEqual(
      observer.calculateCivilizationIndex(state),
      observer.calculateCivilizationIndex(combinedState),
      'civilization projection must match a legacy combined history under a planning overlay',
    );
    assert.deepEqual(
      observer.observeSimulation(state, { structures: [] }),
      observer.observeSimulation(combinedState, { structures: [] }),
      'full derived projection must match a legacy combined history under a planning overlay',
    );
  } finally {
    observer.clearPlanningEventOverlay(state);
  }

  state.world.past = combinedPast;
  observer.registerPlanningEventOverlay(state, overlay, committedPast);
  try {
    assert.deepEqual(observer.worldEventFacts(state), combinedPast,
      'temporary combined histories must index the committed base and append the overlay exactly once');
    assert.equal(observer.worldEventFacts(state).length, combinedPast.length,
      'temporary combined histories must not double-count current-month events');
    assert.strictEqual(observer.worldEventById(state, 'duplicate-id'), duplicateOverlayEnvironment);
  } finally {
    observer.clearPlanningEventOverlay(state);
    state.world.past = committedPast;
  }

  console.log(JSON.stringify({
    ok: true,
    committedEvents: committedPast.length,
    overlayEvents: overlay.length,
    combinedEvents: combinedPast.length,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
