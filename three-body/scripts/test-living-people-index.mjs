import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-living-people-index-'));
const bundlePath = path.join(temporaryDirectory, 'living-people-index.mjs');

try {
  const entry = `
    export {
      invalidatePeopleIndex,
      livingPeople,
      personById,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/state-index.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=living-people-index-entry.ts', `--outfile=${bundlePath}`,
  ], {
    input: entry,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=128' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const person = (id, alive, cellId, z = 1) => ({
    id,
    ...(alive ? {} : { diedAtMonth: 0 }),
    body: { health: alive ? 100 : 0 },
    position: { cellId, z },
  });
  const historicalDeadCount = 10_000;
  const historicalDead = Array.from({ length: historicalDeadCount }, (_, index) => (
    person(`historical-dead-${index}`, false, 10_000 + index)
  ));
  const observer = person('observer', true, 20, 1);
  const visibleFirst = person('visible-first', true, 21, 1);
  const tooHigh = person('too-high', true, 21, 8);
  const visibleSecond = person('visible-second', true, 22, 2);
  const duplicateFirst = person('malformed-duplicate', false, 99, 1);
  const duplicateSecond = person('malformed-duplicate', true, 23, 1);
  const state = {
    people: [
      historicalDead[0],
      observer,
      ...historicalDead.slice(1, 5_000),
      visibleFirst,
      duplicateFirst,
      ...historicalDead.slice(5_000),
      tooHigh,
      duplicateSecond,
      visibleSecond,
    ],
  };

  const naiveLiving = () => state.people.filter((candidate) => (
    candidate.diedAtMonth === undefined && candidate.body.health > 0
  ));
  const visibleCellIds = new Set([20, 21, 22, 23]);
  const naiveVisible = () => naiveLiving().filter((candidate) => candidate.id !== observer.id
    && visibleCellIds.has(candidate.position.cellId)
    && Math.abs(candidate.position.z - observer.position.z) <= 3);
  const indexedVisible = () => api.livingPeople(state).filter((candidate) => candidate.id !== observer.id
    && visibleCellIds.has(candidate.position.cellId)
    && Math.abs(candidate.position.z - observer.position.z) <= 3);
  const assertEquivalent = (label) => {
    assert.deepEqual(api.livingPeople(state), naiveLiving(), `${label}: living refs or order differ`);
    assert.deepEqual(indexedVisible(), naiveVisible(), `${label}: local visibility differs`);
  };

  assertEquivalent('initial build');
  assert.equal(api.personById(state, 'malformed-duplicate'), duplicateFirst,
    'personById must preserve first-wins Array.find semantics for malformed duplicate ids');
  assert.ok(api.livingPeople(state).includes(duplicateSecond),
    'living order is independent of byId first-wins and must retain the later living duplicate ref');

  let historicalDeathReads = 0;
  for (const dead of historicalDead) {
    const diedAtMonth = dead.diedAtMonth;
    Object.defineProperty(dead, 'diedAtMonth', {
      configurable: true,
      enumerable: true,
      get() {
        historicalDeathReads += 1;
        return diedAtMonth;
      },
    });
  }
  api.livingPeople(state);
  api.personById(state, 'visible-second');
  assert.equal(historicalDeathReads, 0,
    'ordinary repeated living/byId reads must not revisit historical dead people');

  const appendedDead = person('appended-dead', false, 24);
  const appendedLiving = person('appended-living', true, 24);
  state.people.push(appendedDead, appendedLiving);
  historicalDeathReads = 0;
  api.livingPeople(state);
  assert.equal(historicalDeathReads, 0, 'append indexing must not revisit the historical prefix');
  assertEquivalent('append-only suffix');

  // A death is removed by the live-ref recheck, without changing the people
  // append cursor. A subsequent append must still be indexed exactly once.
  visibleFirst.diedAtMonth = 2;
  visibleFirst.body.health = 0;
  assertEquivalent('same-month death');
  const afterDeathAppend = person('after-death-append', true, 25);
  state.people.push(afterDeathAppend);
  historicalDeathReads = 0;
  api.livingPeople(state);
  assert.equal(historicalDeathReads, 0, 'death removal must not destroy the append-only boundary');
  assertEquivalent('append after death');

  // Resurrection is not an authoritative transition. Once a dead ref has
  // left the live candidates, an exceptional writer must explicitly rebuild.
  visibleFirst.diedAtMonth = undefined;
  visibleFirst.body.health = 100;
  api.invalidatePeopleIndex(state);
  assertEquivalent('explicit exceptional resurrection');

  // Positions are read live rather than cached in the population sidecar.
  visibleSecond.position = { cellId: 9_999, z: 1 };
  assertEquivalent('live position mutation');

  // Whole-array replacement gets a fresh WeakMap key and conservatively
  // rebuilds all population refs.
  state.people = [...state.people];
  historicalDeathReads = 0;
  api.livingPeople(state);
  assert.ok(historicalDeathReads > 0, 'whole-array replacement must rebuild');
  assertEquivalent('whole-array replacement');

  // Same-length old-tail replacement is detected from the saved append
  // boundary without an explicit hook.
  const tailReplacement = person('tail-replacement', true, 26);
  state.people[state.people.length - 1] = tailReplacement;
  historicalDeathReads = 0;
  api.livingPeople(state);
  assert.ok(historicalDeathReads > 0, 'old-tail replacement must rebuild');
  assertEquivalent('same-length tail replacement');

  // Same-length middle replacement can preserve length and old tail, so its
  // exceptional owner must explicitly discard the sidecar.
  const middleOffset = state.people.findIndex((candidate) => candidate.id === 'historical-dead-400');
  const middleReplacement = person('middle-replacement', true, 27);
  state.people.splice(middleOffset, 1, middleReplacement);
  api.invalidatePeopleIndex(state);
  historicalDeathReads = 0;
  api.livingPeople(state);
  assert.ok(historicalDeathReads > 0, 'explicit middle rewrite invalidation must rebuild');
  assertEquivalent('explicit same-array middle replacement');

  assert.equal(api.personById(state, 'malformed-duplicate'), duplicateFirst,
    'rebuilds must not change malformed duplicate-id first-wins semantics');
  assert.deepEqual(
    api.livingPeople(state).map((candidate) => candidate.id),
    naiveLiving().map((candidate) => candidate.id),
    'rebuilds must retain full authoritative living-array order including duplicate ids',
  );

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 192 * 1024 * 1024, 'living people index fixture RSS must remain below 192 MiB');
  console.log(JSON.stringify({
    result: 'passed',
    historicalDeadCount,
    finalLivingCount: api.livingPeople(state).length,
    historicalDeathReads,
    rssBytes,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
