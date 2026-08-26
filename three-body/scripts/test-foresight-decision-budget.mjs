import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-foresight-decision-budget-'));
const bundlePath = path.join(temporaryDirectory, 'foresight-decision-budget.mjs');

try {
  const entry = `
    export { RulePlanner } from ${JSON.stringify(path.resolve('src/game/eland/application/rule-planner.ts'))};
    export { applyDecision } from ${JSON.stringify(path.resolve('src/game/eland/application/simulation/intent-execution.ts'))};
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/simulation.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=foresight-decision-budget-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const { RulePlanner, applyDecision, createInitialState } = await import(
    `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
  );

  const moment = { atMonth: 1, planningTick: 1 };
  const semantics = (purpose, needKinds, obligation = 'optional') => ({
    version: 'action-option-semantics-v1',
    obligation,
    planningChannel: obligation === 'optional' ? 'ordinary' : 'edge',
    purpose,
    minimumLifeStage: obligation === 'optional' ? 'learning-child' : 'adolescent',
    needKinds,
    ...(obligation === 'optional' ? {} : {
      edgeTrigger: obligation === 'required-response' ? 'required-response' : 'commitment-action',
      socialContext: {
        cooperationKind: 'assist',
        phase: obligation === 'required-response' ? 'response' : 'fulfillment',
        counterpartIds: ['fixture-counterpart'],
        referenceId: 'fixture-obligation',
      },
    }),
  });
  const option = (id, person, goal, semantic = semantics('other', [])) => ({
    id,
    summary: id,
    reason: '有界前瞻决策夹具',
    goal,
    nextAction: { kind: 'move', toCellId: person.position.cellId, toZ: person.position.z },
    estimatedDuration: 'one-month',
    sourceFactIds: [],
    semantics: semantic,
    domain: semantic.obligation === 'optional' ? 'strategic' : 'social',
  });
  const stateAndPerson = (seed) => {
    const state = createInitialState(seed, {
      endpoint: { kind: 'months', value: 12 },
      chaosIntensity: 0,
    });
    const person = state.people[0];
    person.body.health = 100;
    person.body.hydration = 12;
    person.body.nutrition = 20;
    person.conditions = [];
    return { state, person };
  };
  const contextFor = (state, person, options, followUpOptions = []) => ({
    state,
    person,
    visibleCells: [],
    visiblePeople: [],
    visibleDrops: [],
    visibleAnimals: [],
    options,
    followUpOptions,
  });

  const planner = new RulePlanner();
  const normal = stateAndPerson(26_082_731);
  const normalOptions = [
    option('opaque-water-recovery', normal.person, {
      kind: 'body-at-least', field: 'hydration', value: 60,
    }, semantics('homeostasis', ['homeostasis'])),
    option('opaque-food-recovery', normal.person, {
      kind: 'body-at-least', field: 'nutrition', value: 60,
    }, semantics('homeostasis', ['homeostasis'])),
    option('opaque-known-place', normal.person, {
      kind: 'at-cell', cellId: normal.person.position.cellId,
    }, semantics('movement', [])),
    option('opaque-question', normal.person, {
      kind: 'knowledge', factId: 'fixture-question', personId: normal.person.id,
    }, semantics('inquiry', ['inquiry'])),
    option('opaque-capability', normal.person, {
      kind: 'knowledge', factId: 'fixture-capability', personId: normal.person.id,
    }, semantics('inquiry', ['capability'])),
  ];
  const normalContext = contextFor(normal.state, normal.person, normalOptions);
  const normalDecision = planner.decideAt(normalContext, moment);
  assert.ok(normalDecision.kind === 'start' || normalDecision.kind === 'revise');
  const selected = normalOptions.find((candidate) => candidate.id === normalDecision.optionId);
  assert.ok(selected, 'the fixture must retain the selected legal option');
  assert.equal(Object.getOwnPropertySymbols(normalDecision).length, 1,
    'a normal rule decision carries exactly one non-enumerable selection-time deliberation');
  assert.equal(JSON.stringify(normalDecision).includes('bounded-foresight'), false,
    'the transient deliberation must not enter the persisted decision payload');

  // Revalidation may rebuild or narrow a context. The audit must still report
  // the exact selection-time tree rather than expanding the narrowed list a
  // second time inside applyDecision.
  normalContext.options = [selected];
  const normalFact = applyDecision(
    normal.state,
    normal.person,
    normalContext,
    normalDecision,
    false,
    moment.atMonth,
    0,
    moment.planningTick,
  );
  assert.equal(normalFact.foresightEvidence?.rootCount, 4,
    'RulePlanner -> applyDecision must reuse the original four-root deliberation');
  assert.ok((normalFact.foresightEvidence?.expandedNodes ?? 25) <= 24,
    'the complete person decision may expand at most 24 nodes');
  assert.ok((normalFact.foresightEvidence?.maxDepth ?? 4) <= 3);
  assert.ok((normalFact.foresightEvidence?.valueOfInformation ?? 1) <= 0.2);
  assert.ok(Math.abs(normalFact.foresightEvidence?.adjustment ?? 1) <= 0.12,
    'foresight plus information may move motivation by at most 0.12');
  assert.equal(Object.getOwnPropertySymbols(normalDecision).length, 0,
    'applyDecision consumes the transient handoff before recording history');

  for (const [obligation, seed] of [
    ['required-response', 26_082_732],
    ['commitment-action', 26_082_733],
  ]) {
    const forced = stateAndPerson(seed);
    const forcedOption = option(
      `opaque-${obligation}`,
      forced.person,
      { kind: 'at-cell', cellId: forced.person.position.cellId },
      semantics('social-coordination', ['commitment'], obligation),
    );
    const alternative = option(
      `opaque-optional-${obligation}`,
      forced.person,
      { kind: 'body-at-least', field: 'hydration', value: 60 },
      semantics('homeostasis', ['homeostasis']),
    );
    const forcedContext = contextFor(forced.state, forced.person, [alternative, forcedOption]);
    const forcedDecision = planner.decideAt(forcedContext, moment);
    assert.equal(forcedDecision.kind, 'start');
    assert.equal(forcedDecision.optionId, forcedOption.id);
    assert.equal(Object.getOwnPropertySymbols(forcedDecision).length, 0,
      `${obligation} ranking must not open or carry a foresight tree`);
    const forcedFact = applyDecision(
      forced.state,
      forced.person,
      forcedContext,
      forcedDecision,
      false,
      moment.atMonth,
      0,
      moment.planningTick,
      'edge',
    );
    assert.equal(forcedFact.foresightEvidence, undefined,
      `${obligation} execution must not expand a zero-adjustment foresight tree`);
  }

  process.stdout.write('foresight decision budget tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
