import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-dead-memory-maintenance-index-'));
const bundlePath = path.join(temporaryDirectory, 'dead-memory-maintenance-index.mjs');

try {
  const entry = `
    export {
      invalidateMemoryMaintenanceIndex,
      invalidatePersonMemoryMaintenance,
      maintainDueMemories,
      maintainMemories,
      remember,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/memory.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=dead-memory-maintenance-index-entry.ts', `--outfile=${bundlePath}`,
  ], {
    input: entry,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const memory = (id, kind, importance, createdAtMonth, expiresAtMonth) => ({
    id,
    kind,
    summary: id,
    importance,
    createdAtMonth,
    lastRecalledAtMonth: createdAtMonth,
    personIds: [],
    sourceEventIds: [`event:${id}`],
    ...(expiresAtMonth === undefined ? {} : { expiresAtMonth }),
  });
  const person = (id, memories, options = {}) => ({
    id,
    traits: options.retentive ? [{
      id: 'retentive', origin: 'founder', inheritedFromPersonIds: [], sourceEventIds: [`trait:${id}`],
    }] : [],
    ...(options.alive ? {} : { diedAtMonth: options.diedAtMonth ?? 0 }),
    body: { health: options.alive ? 100 : 0, hydration: 100, nutrition: 100 },
    memories,
  });

  const historicalStableDeadCount = 10_000;
  const fixturePeople = [
    person('dies-this-run', [
      memory('death-month-episode', 'episode', 24, 0),
      memory('death-month-commitment', 'commitment', 45, 0, 5),
    ], { alive: true }),
    person('ordinary-retention', [
      memory('ordinary-young', 'episode', 16, 0),
      memory('ordinary-old', 'episode', 9, -12),
    ]),
    person('retentive-retention', [
      memory('retentive-young', 'episode', 16, 0),
      memory('retentive-old', 'episode', 9, -12),
    ], { retentive: true }),
    person('summary-source', [
      memory('forgotten-a', 'episode', 1, -30),
      memory('forgotten-b', 'dialogue', 2, -28),
      memory('already-summary', 'summary', 1, -24),
    ]),
    person('expiring-failure', [memory('bounded-failure', 'failure', 8, 0, 3)]),
    person('direct-replacement', []),
    ...Array.from({ length: historicalStableDeadCount }, (_, index) => person(`cold-dead-${index}`, [])),
  ];
  const baseline = { people: structuredClone(fixturePeople) };
  const indexed = { people: structuredClone(fixturePeople) };

  const mutableSnapshot = (state) => state.people
    .filter((candidate) => !candidate.id.startsWith('cold-dead-'))
    .map((candidate) => ({
      id: candidate.id,
      diedAtMonth: candidate.diedAtMonth,
      health: candidate.body.health,
      traits: structuredClone(candidate.traits),
      memories: structuredClone(candidate.memories),
    }));
  const find = (state, id) => {
    const found = state.people.find((candidate) => candidate.id === id);
    assert.ok(found, `missing fixture person ${id}`);
    return found;
  };
  const assertEquivalent = (month) => assert.deepEqual(
    mutableSnapshot(indexed),
    mutableSnapshot(baseline),
    `indexed memory maintenance diverged from the all-person fold at month ${month}`,
  );

  api.maintainMemories(baseline, 1);
  api.maintainDueMemories(indexed, 1);
  assertEquivalent(1);
  assert.ok(find(indexed, 'summary-source').memories.some((candidate) => candidate.kind === 'summary'),
    'old non-summary memories must still create the exact annual summary');

  let coldMemoryReads = 0;
  for (const cold of indexed.people.filter((candidate) => candidate.id.startsWith('cold-dead-'))) {
    let stored = cold.memories;
    Object.defineProperty(cold, 'memories', {
      configurable: true,
      enumerable: true,
      get() {
        coldMemoryReads += 1;
        return stored;
      },
      set(value) {
        stored = value;
      },
    });
  }

  for (let month = 2; month <= 18; month += 1) {
    if (month === 2) {
      for (const state of [baseline, indexed]) {
        const dying = find(state, 'dies-this-run');
        dying.diedAtMonth = month;
        dying.body.health = 0;
      }
    }
    if (month === 4) {
      api.remember(find(baseline, 'dies-this-run'), memory('posthumous-sourced-write', 'episode', 38, month));
      api.remember(find(indexed, 'dies-this-run'), memory('posthumous-sourced-write', 'episode', 38, month));
    }
    if (month === 5) {
      baseline.people.push(person('appended-dead', [memory('appended-old', 'episode', 3, -20)]));
      indexed.people.push(person('appended-dead', [memory('appended-old', 'episode', 3, -20)]));
    }
    if (month === 6) {
      const replacement = [memory('replacement-old', 'episode', 4, -20)];
      find(baseline, 'direct-replacement').memories = structuredClone(replacement);
      const indexedPerson = find(indexed, 'direct-replacement');
      indexedPerson.memories = structuredClone(replacement);
      api.invalidatePersonMemoryMaintenance(indexedPerson);
    }
    if (month === 7) {
      find(baseline, 'direct-replacement').memories[0].importance = 72;
      const indexedPerson = find(indexed, 'direct-replacement');
      indexedPerson.memories[0].importance = 72;
      api.invalidatePersonMemoryMaintenance(indexedPerson);
    }
    if (month === 8) {
      baseline.people = [...baseline.people];
      indexed.people = [...indexed.people];
    }
    if (month === 10) {
      const baselineOffset = baseline.people.findIndex((candidate) => candidate.id === 'ordinary-retention');
      const indexedOffset = indexed.people.findIndex((candidate) => candidate.id === 'ordinary-retention');
      baseline.people.splice(baselineOffset, 1, person('splice-replacement', [memory('splice-old', 'episode', 5, -30)]));
      indexed.people.splice(indexedOffset, 1, person('splice-replacement', [memory('splice-old', 'episode', 5, -30)]));
      api.invalidateMemoryMaintenanceIndex(indexed);
    }
    if (month === 12) {
      const baselinePerson = find(baseline, 'direct-replacement');
      const indexedPerson = find(indexed, 'direct-replacement');
      baselinePerson.traits = [{
        id: 'retentive', origin: 'founder', inheritedFromPersonIds: [], sourceEventIds: ['trait:late-retentive'],
      }];
      indexedPerson.traits = structuredClone(baselinePerson.traits);
      api.invalidatePersonMemoryMaintenance(indexedPerson);
    }

    api.maintainMemories(baseline, month);
    api.maintainDueMemories(indexed, month);
    if (month === 2) assert.equal(coldMemoryReads, 0,
      'an unchanged sequential month must not revisit 10,000 stable historical dead people');
    assertEquivalent(month);
    if (month === 7) {
      assert.equal(find(indexed, 'ordinary-retention').memories.some((candidate) => candidate.id === 'ordinary-young'), false,
        'ordinary retention must forget the young episode on its original schedule');
      assert.equal(find(indexed, 'retentive-retention').memories.some((candidate) => candidate.id === 'retentive-young'), true,
        'retentive duration must preserve the same episode beyond the ordinary cutoff');
    }
  }

  assert.ok(coldMemoryReads > 0,
    'whole-array replacement and explicit exceptional rewrite must take the safe full rebuild path');
  assert.equal(find(indexed, 'dies-this-run').diedAtMonth, 2, 'death-month maintenance must preserve the death fact');
  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1024 * 1024, 'dead-memory maintenance fixture RSS must remain below 256 MiB');
  console.log(JSON.stringify({
    result: 'passed',
    historicalStableDeadCount,
    monthsCompared: 18,
    coldMemoryReads,
    rssBytes,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
