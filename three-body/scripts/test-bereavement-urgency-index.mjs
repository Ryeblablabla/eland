import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-bereavement-urgency-index-'));
const bundlePath = path.join(temporaryDirectory, 'bereavement-urgency-index.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/simulation.ts'))};
    export {
      bereavementUrgency,
      invalidateMortuaryPerceptionIndex,
      memorialForRemains,
      remainsById,
      remainsForPerson,
      strongestBereavement,
      strongestBereavementUrgency,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/mortuary.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=bereavement-urgency-index-entry.ts', `--outfile=${bundlePath}`,
  ], {
    input: entry,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = api.createInitialState(20260825, { endpoint: { kind: 'months', value: 24 } });
  const person = state.people[0];
  assert.ok(person, 'fixture requires one founder');
  state.world.remains = [];
  state.world.memorials = [];
  person.bereavements = [];

  const position = { cellId: person.position.cellId, z: person.position.z };
  const remains = (id, status = 'exposed', personId = `deceased:${id}`) => ({
    id,
    personId,
    position: { ...position },
    status,
    createdAtMonth: 1,
    deathEventId: `death:${id}`,
    sourceEventIds: [`death:${id}`],
    ...(status === 'interred' ? { interredAtMonth: 2, interredByPersonId: 'burier' } : {}),
  });
  const memorial = (remainsId, suffix = '') => ({
    id: `memorial:${remainsId}${suffix}`,
    remainsId,
    personId: `deceased:${remainsId}`,
    position: { x: 0, y: 0, z: position.z, cellId: position.cellId },
    materialId: 1,
    inscription: remainsId,
    madeByPersonId: 'marker',
    createdAtMonth: 3,
    sourceEventIds: [`mark:${remainsId}${suffix}`],
  });
  const bereavement = (remainsId, intensity, learnedAtMonth, suffix = '') => ({
    id: `bereavement:${remainsId}${suffix}`,
    remainsId,
    deceasedPersonId: `deceased:${remainsId}`,
    deathEventId: `death:${remainsId}`,
    learnedAtMonth,
    learnedBy: 'witness',
    intensity,
    sourceEventIds: [`death:${remainsId}`],
  });

  const historicalStableCount = 5_000;
  const historicalStable = Array.from({ length: historicalStableCount }, (_, index) => (
    remains(`historical:${index}`, 'interred')
  ));
  state.world.remains.push(...historicalStable);
  state.world.memorials.push(...historicalStable.map((candidate) => memorial(candidate.id)));

  const tieFirstRemains = remains('tie:z-first');
  const tieSecondRemains = remains('tie:a-second');
  const resolvedRemains = remains('resolved', 'interred');
  state.world.remains.push(tieFirstRemains, tieSecondRemains, resolvedRemains);
  state.world.memorials.push(memorial(resolvedRemains.id));
  const tieFirst = bereavement(tieFirstRemains.id, 0.82, 7);
  const tieSecond = bereavement(tieSecondRemains.id, 0.82, 7);
  const resolved = { ...bereavement(resolvedRemains.id, 1, 12), lastMournedAtMonth: 13 };
  person.bereavements.push(tieFirst, tieSecond, resolved);

  const naiveRemainsById = (remainsId) => state.world.remains.find((candidate) => candidate.id === remainsId);
  const naiveRemainsForPerson = (personId) => state.world.remains.find((candidate) => candidate.personId === personId);
  const naiveMemorialForRemains = (remainsId) => state.world.memorials.find((candidate) => candidate.remainsId === remainsId);
  const naiveUrgency = (candidate, atMonth) => {
    const target = naiveRemainsById(candidate.remainsId);
    if (!target) return 0;
    const marker = naiveMemorialForRemains(target.id);
    const openCare = target.status !== 'interred'
      ? 1
      : candidate.lastMournedAtMonth === undefined
        ? 0.5
        : !marker
          ? 0.2
          : 0;
    const age = Math.max(0, atMonth - candidate.learnedAtMonth);
    return Math.max(0, Math.min(1, candidate.intensity * Math.exp(-age / 60) * openCare));
  };
  const naiveStrongest = (atMonth) => person.bereavements.map((candidate) => ({
    bereavement: candidate,
    urgency: naiveUrgency(candidate, atMonth),
  })).sort((left, right) => right.urgency - left.urgency)[0];
  const assertEquivalent = (atMonth, label) => {
    const expected = naiveStrongest(atMonth);
    const actual = api.strongestBereavement(state, person, atMonth);
    assert.equal(actual?.bereavement, expected?.bereavement, `${label}: stable strongest bereavement differs`);
    assert.equal(actual?.urgency, expected?.urgency, `${label}: strongest urgency differs`);
    assert.equal(api.strongestBereavementUrgency(state, person, atMonth), expected?.urgency ?? 0,
      `${label}: numeric urgency wrapper differs`);
    for (const candidate of person.bereavements) {
      assert.equal(api.bereavementUrgency(state, candidate, atMonth), naiveUrgency(candidate, atMonth),
        `${label}: item urgency differs for ${candidate.id}`);
    }
  };

  assertEquivalent(19, 'initial index');
  assert.equal(api.strongestBereavement(state, person, 19)?.bereavement, tieFirst,
    'equal urgency, month, and differing ids must keep the earlier authoritative bereavement entry');

  // Preserve Array.find first-wins behavior even for malformed duplicate ids.
  const duplicateFirst = remains('duplicate', 'exposed', 'duplicate-person');
  const duplicateSecond = remains('duplicate', 'interred', 'duplicate-person');
  const duplicateMarkerFirst = memorial('duplicate', ':first');
  const duplicateMarkerSecond = memorial('duplicate', ':second');
  state.world.remains.push(duplicateFirst, duplicateSecond);
  state.world.memorials.push(duplicateMarkerFirst, duplicateMarkerSecond);
  assert.equal(api.remainsById(state, 'duplicate'), naiveRemainsById('duplicate'));
  assert.equal(api.remainsForPerson(state, 'duplicate-person'), naiveRemainsForPerson('duplicate-person'));
  assert.equal(api.memorialForRemains(state, 'duplicate'), naiveMemorialForRemains('duplicate'));

  // Once built, unrelated historical identifiers must not be revisited by a
  // normal strongest-grief read. The index stores references, not copied facts.
  let historicalIdReads = 0;
  for (const candidate of historicalStable) {
    const id = candidate.id;
    Object.defineProperty(candidate, 'id', {
      configurable: true,
      enumerable: true,
      get() {
        historicalIdReads += 1;
        return id;
      },
    });
  }
  api.strongestBereavement(state, person, 20);
  assert.equal(historicalIdReads, 0, 'an unchanged query must not rescan historical remains ids');

  // Suffix growth is indexed incrementally, while mutable authoritative
  // status and mourning fields are read live rather than cached as urgency.
  const appendedRemains = remains('appended');
  const appendedBereavement = bereavement(appendedRemains.id, 0.99, 20);
  state.world.remains.push(appendedRemains);
  person.bereavements.push(appendedBereavement);
  historicalIdReads = 0;
  api.strongestBereavement(state, person, 20);
  assert.equal(historicalIdReads, 0, 'suffix indexing must not revisit the historical prefix');
  assertEquivalent(20, 'append-only remains');
  appendedRemains.status = 'interred';
  appendedRemains.interredAtMonth = 21;
  appendedBereavement.lastMournedAtMonth = 21;
  assertEquivalent(21, 'live in-place mortuary settlement');
  state.world.memorials.push(memorial(appendedRemains.id));
  historicalIdReads = 0;
  api.strongestBereavement(state, person, 22);
  assert.equal(historicalIdReads, 0, 'a marker suffix must not revisit historical remains ids');
  assertEquivalent(22, 'append-only memorial');

  // Whole-array replacement and same-length tail replacement are detected
  // automatically and take the conservative rebuild path.
  state.world.remains = [...state.world.remains];
  state.world.memorials = [...state.world.memorials];
  historicalIdReads = 0;
  api.strongestBereavement(state, person, 23);
  assert.ok(historicalIdReads > 0, 'whole-array replacement must rebuild the lookup index');
  assertEquivalent(23, 'whole-array replacement');
  const replacedTail = remains('tail-replacement');
  state.world.remains[state.world.remains.length - 1] = replacedTail;
  person.bereavements.push(bereavement(replacedTail.id, 0.97, 24));
  assertEquivalent(24, 'tail replacement');

  // A same-array middle rewrite can leave length and tail unchanged. It is an
  // exceptional non-domain write, so the explicit hook must rebuild before the
  // next read and make the replacement authoritative.
  const middleReplacement = remains('middle-replacement');
  state.world.remains.splice(100, 1, middleReplacement);
  person.bereavements.push(bereavement(middleReplacement.id, 1, 25));
  api.invalidateMortuaryPerceptionIndex(state);
  assertEquivalent(25, 'explicit middle-rewrite invalidation');
  assert.equal(api.remainsById(state, middleReplacement.id), middleReplacement);

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1024 * 1024, 'bereavement urgency fixture RSS must remain below 256 MiB');
  console.log(JSON.stringify({
    result: 'passed',
    historicalStableCount,
    stableTieWinner: tieFirst.id,
    historicalIdReads,
    rssBytes,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
