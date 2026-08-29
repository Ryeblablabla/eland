import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-decision-knowledge-index-'));
const bundlePath = path.join(temporaryDirectory, 'decision-knowledge-index.mjs');

try {
  const entry = `
    export { buildDecisionContext } from ${JSON.stringify(path.resolve('src/game/eland/application/action-options.ts'))};
    export {
      createInitialState,
      stepOwnedSimulation,
    } from ${JSON.stringify(path.resolve('src/game/eland/simulation-runtime.ts'))};
    export {
      invalidateKnowledgeIndex,
      knowledgeFactById,
      withLinearKnowledgeLookupsForDiagnostics,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/state-index.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=decision-knowledge-index-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const knowledgeCount = 600;
  const syntheticFact = (index) => ({
    id: `technique:synthetic:${index}`,
    kind: 'technique',
    summary: `synthetic technique ${index}`,
    confidence: 60,
    learnedAtMonth: 1,
    sourceEventIds: [],
  });
  const decisionFixture = () => {
    const state = api.createInitialState(20260830, {
      characterIds: ['laozi', 'qinshihuang', 'marie-curie', 'ada-lovelace'],
      endpoint: { kind: 'months', value: 240 },
      chaosIntensity: 0,
    });
    state.clock.elapsedMonths = 120;
    state.projects = [];
    state.intents = [];
    state.agreements = [];
    state.records = [];
    state.world.animals = [];
    state.world.drops = [];
    const anchor = state.people[0].position;
    const reads = { count: 0 };
    for (const person of state.people) {
      person.bornAtMonth = -240;
      delete person.diedAtMonth;
      person.body.health = 90;
      person.body.hydration = 90;
      person.body.nutrition = 90;
      person.conditions = [];
      person.inventory = [];
      person.memories = [];
      person.relations = [];
      person.position = {
        ...person.position,
        cellId: anchor.cellId,
        z: anchor.z,
        previousCellId: anchor.cellId,
        previousZ: anchor.z,
        lastPath: [anchor.cellId],
        tickPath: [anchor.cellId],
      };
      const facts = Array.from({ length: knowledgeCount }, (_, index) => syntheticFact(index));
      person.knowledge = new Proxy(facts, {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^(0|[1-9]\d*)$/u.test(property)) reads.count += 1;
          return Reflect.get(target, property, receiver);
        },
      });
    }
    return { state, reads };
  };

  const linearFixture = decisionFixture();
  const linearStartedAt = performance.now();
  const linearContexts = api.withLinearKnowledgeLookupsForDiagnostics(
    linearFixture.state.people,
    () => linearFixture.state.people.map((person) => api.buildDecisionContext(linearFixture.state, person, 121)),
  );
  const linearElapsedMs = performance.now() - linearStartedAt;

  const indexedFixture = decisionFixture();
  const indexedStartedAt = performance.now();
  const indexedContexts = indexedFixture.state.people
    .map((person) => api.buildDecisionContext(indexedFixture.state, person, 121));
  const indexedElapsedMs = performance.now() - indexedStartedAt;
  const linearNumericKnowledgeReads = linearFixture.reads.count;
  const indexedNumericKnowledgeReads = indexedFixture.reads.count;

  assert.equal(JSON.stringify(indexedContexts), JSON.stringify(linearContexts),
    'indexed and direct-scan decision contexts must be byte-identical');
  assert.ok(indexedNumericKnowledgeReads < linearNumericKnowledgeReads * 0.1,
    'exact knowledge index must remove at least 90% of numeric knowledge-array reads');

  const indexedPerson = indexedFixture.state.people[0];
  const appended = { ...syntheticFact(knowledgeCount), id: 'duplicate-fixture', confidence: 20 };
  const laterReliable = { ...appended, confidence: 80 };
  indexedPerson.knowledge.push(appended, laterReliable);
  assert.strictEqual(api.knowledgeFactById(indexedPerson, 'duplicate-fixture'), appended,
    'unqualified lookup preserves first matching Array.find semantics');
  assert.strictEqual(
    api.knowledgeFactById(indexedPerson, 'duplicate-fixture', (fact) => fact.confidence >= 55),
    laterReliable,
    'qualified lookup preserves Array.find semantics across malformed duplicate ids',
  );
  const mutableConfidence = { ...syntheticFact(knowledgeCount + 1), id: 'mutable-confidence', confidence: 20 };
  indexedPerson.knowledge.push(mutableConfidence);
  assert.equal(
    api.knowledgeFactById(indexedPerson, mutableConfidence.id, (fact) => fact.confidence >= 55),
    undefined,
  );
  mutableConfidence.confidence = 80;
  assert.strictEqual(
    api.knowledgeFactById(indexedPerson, mutableConfidence.id, (fact) => fact.confidence >= 55),
    mutableConfidence,
    'cached candidates must re-read live confidence on every qualified lookup',
  );
  const oldArrayFact = api.knowledgeFactById(indexedPerson, 'technique:synthetic:2');
  const replacementFact = { ...syntheticFact(2), summary: 'replacement array fact' };
  indexedPerson.knowledge = indexedPerson.knowledge.map((fact) => (
    fact.id === replacementFact.id ? replacementFact : fact
  ));
  assert.strictEqual(api.knowledgeFactById(indexedPerson, replacementFact.id), replacementFact,
    'whole-array replacement must receive a fresh WeakMap index');
  assert.notStrictEqual(api.knowledgeFactById(indexedPerson, replacementFact.id), oldArrayFact,
    'whole-array replacement must not leak the old candidate ref');
  indexedPerson.knowledge[0] = { ...syntheticFact(0), id: 'middle-replacement' };
  api.invalidateKnowledgeIndex(indexedPerson);
  assert.equal(api.knowledgeFactById(indexedPerson, 'middle-replacement')?.id, 'middle-replacement',
    'exceptional same-array rewrite is visible after explicit invalidation');

  const authoritativeFixture = () => {
    const state = api.createInitialState(20260831, {
      characterIds: ['laozi', 'qinshihuang', 'marie-curie', 'ada-lovelace'],
      endpoint: { kind: 'months', value: 24 },
      chaosIntensity: 0,
    });
    for (const person of state.people) {
      person.knowledge.push(...Array.from({ length: 80 }, (_, index) => syntheticFact(index)));
    }
    return state;
  };
  const linearState = authoritativeFixture();
  const indexedState = authoritativeFixture();
  const linearResult = api.withLinearKnowledgeLookupsForDiagnostics(
    linearState.people,
    () => api.stepOwnedSimulation(linearState),
  );
  const indexedResult = api.stepOwnedSimulation(indexedState);
  assert.deepEqual(indexedResult.lastStep, linearResult.lastStep,
    'cache switch must not change authoritative month events');
  assert.deepEqual(indexedResult, linearResult,
    'cache switch must not change authoritative state');
  const stateHash = (state) => createHash('sha256').update(JSON.stringify(state)).digest('hex');
  const eventHash = (state) => createHash('sha256').update(JSON.stringify(state.lastStep)).digest('hex');
  assert.equal(stateHash(indexedResult), stateHash(linearResult));
  assert.equal(eventHash(indexedResult), eventHash(linearResult));

  console.log(JSON.stringify({
    result: 'passed',
    people: indexedFixture.state.people.length,
    knowledgeCount,
    linearNumericKnowledgeReads,
    indexedNumericKnowledgeReads,
    scanReduction: 1 - indexedNumericKnowledgeReads / linearNumericKnowledgeReads,
    linearElapsedMs,
    indexedElapsedMs,
    stateHash: stateHash(indexedResult),
    eventHash: eventHash(indexedResult),
    optionCounts: indexedContexts.map((context) => context.options.length),
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
