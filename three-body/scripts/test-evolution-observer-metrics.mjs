import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-observer-metrics-test-'));
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const artifactsBundlePath = path.join(temporaryDirectory, 'evolution-artifacts.mjs');

try {
  for (const [entryPoint, outputPath] of [
    ['src/game/eland/simulation.ts', simulationBundlePath],
    ['server/evolution-artifacts.ts', artifactsBundlePath],
  ]) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entryPoint, '--bundle', '--platform=node', '--format=esm', `--outfile=${outputPath}`,
    ], { stdio: 'pipe' });
  }

  const { createInitialState } = await import(`${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`);
  const { buildEvolutionFactsReport } = await import(`${pathToFileURL(artifactsBundlePath).href}?test=${Date.now()}`);
  const state = createInitialState(91, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const [firstPerson, secondPerson] = state.people;
  assert.ok(firstPerson && secondPerson, 'fixture requires two people');
  state.clock.elapsedMonths = 2;
  state.intents = [
    { id: 'intent-project-a', ownerId: firstPerson.id, projectId: 'project-a' },
    { id: 'intent-project-b', ownerId: secondPerson.id, projectId: 'project-b' },
    { id: 'intent-plain-b', ownerId: secondPerson.id },
  ];

  let orderInMonth = 0;
  const actionFact = ({ id, atMonth, who, intentId, action, status = 'completed', diff = {} }) => ({
    id,
    kind: 'action',
    actionTick: 1,
    atMonth,
    orderInMonth: orderInMonth++,
    cellId: 0,
    who,
    intentId,
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
  const communicate = (content) => ({ kind: 'communicate', content, audience: [], channel: 'voice' });
  const reproduce = { kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: firstPerson.id }] };
  state.world.past = [
    actionFact({ id: 'project-a-1', atMonth: 1, who: firstPerson.id, intentId: 'intent-project-a', action: { kind: 'attend', target: { kind: 'person', personId: secondPerson.id } } }),
    actionFact({ id: 'project-a-2', atMonth: 1, who: firstPerson.id, intentId: 'intent-project-a', action: { kind: 'move', toCellId: 1 }, status: 'blocked' }),
    actionFact({
      id: 'reproduction-offer', atMonth: 1, who: secondPerson.id, intentId: 'intent-project-b',
      action: communicate({ id: 'offer-reproduce-1', kind: 'offer', proposal: { kind: 'reproduce' } }),
    }),
    actionFact({
      id: 'reproduction-acceptance', atMonth: 1, who: secondPerson.id, intentId: 'intent-project-b',
      action: communicate({ id: 'accept-reproduce-1', kind: 'accept', referenceId: 'offer-reproduce-1' }),
    }),
    actionFact({
      id: 'blocked-reproduction-offer', atMonth: 1, who: firstPerson.id, intentId: 'intent-project-a', status: 'blocked',
      action: communicate({ id: 'offer-reproduce-blocked', kind: 'offer', proposal: { kind: 'reproduce' } }),
    }),
    actionFact({
      id: 'non-reproduction-offer', atMonth: 1, who: firstPerson.id, intentId: 'intent-project-a',
      action: communicate({ id: 'offer-companion-1', kind: 'offer', proposal: { kind: 'companion' } }),
    }),
    actionFact({
      id: 'unknown-acceptance', atMonth: 2, who: secondPerson.id, intentId: 'intent-plain-b',
      action: communicate({ id: 'accept-unknown', kind: 'accept', referenceId: 'unknown-offer' }),
    }),
    actionFact({ id: 'reproduction-no-conception', atMonth: 2, who: secondPerson.id, intentId: 'intent-plain-b', action: reproduce, diff: { conceived: false } }),
    actionFact({ id: 'reproduction-blocked', atMonth: 2, who: secondPerson.id, intentId: 'intent-plain-b', action: reproduce, status: 'blocked', diff: { consent: false } }),
    actionFact({ id: 'reproduction-conception', atMonth: 2, who: secondPerson.id, intentId: 'intent-plain-b', action: reproduce, diff: { conceived: true } }),
  ];

  const pathFixture = {
    schemaVersion: 2,
    runId: 'observer-metrics-fixture',
    provider: 'local',
    model: 'rules',
    status: 'completed',
    startedAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    fromMonth: 0,
    requestedEndMonth: 2,
    reachedMonth: 2,
    checkpoints: [],
    turningPoints: [],
  };
  const report = buildEvolutionFactsReport(state, pathFixture);
  assert.equal(report.schemaVersion, 4);
  assert.equal(report.actionPersonMonths, 3, 'multiple actions by one person in one month must count once');
  assert.equal(report.projectActionPersonMonths, 2, 'only person-months linked through an intent projectId count');
  assert.equal(report.projectActionMonthShare, 66.67);
  assert.equal(report.reproductionOffers, 1, 'only completed reproduction offer facts count');
  assert.equal(report.reproductionAcceptances, 1, 'acceptance must reference a completed reproduction offer fact');
  assert.equal(report.reproductionAttempts, 3, 'every submitted reproduce primitive is an attempt, including blocked facts');
  assert.equal(report.reproductionConceptions, 1, 'conception requires diff.conceived === true');

  const stateWithoutIntents = structuredClone(state);
  delete stateWithoutIntents.intents;
  const reportWithoutIntents = buildEvolutionFactsReport(stateWithoutIntents, pathFixture);
  assert.equal(reportWithoutIntents.actionPersonMonths, 3);
  assert.equal(reportWithoutIntents.projectActionPersonMonths, 0);
  assert.equal(reportWithoutIntents.projectActionMonthShare, 0);

  const stateWithoutIntentIds = structuredClone(state);
  for (const event of stateWithoutIntentIds.world.past) delete event.intentId;
  const reportWithoutIntentIds = buildEvolutionFactsReport(stateWithoutIntentIds, pathFixture);
  assert.equal(reportWithoutIntentIds.actionPersonMonths, 0);
  assert.equal(reportWithoutIntentIds.projectActionPersonMonths, 0);
  assert.equal(reportWithoutIntentIds.projectActionMonthShare, null);

  process.stdout.write('evolution observer metric tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
