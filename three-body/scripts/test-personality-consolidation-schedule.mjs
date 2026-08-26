import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-personality-consolidation-schedule-'));
const bundlePath = path.join(temporaryDirectory, 'personality-consolidation-schedule.mjs');

try {
  const entry = `
    export {
      consolidateDuePersonalities,
      consolidatePersonality,
      invalidatePersonalityConsolidationIndex,
      invalidatePersonPersonalityConsolidation,
      recordPersonalityEvidence,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/personality.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=personality-consolidation-schedule-entry.ts', `--outfile=${bundlePath}`,
  ], {
    input: entry,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const zeroVector = () => ({
    honestyHumility: 0,
    emotionality: 0,
    extraversion: 0,
    agreeableness: 0,
    conscientiousness: 0,
    openness: 0,
  });
  const personality = (evidence = [], changes = []) => ({
    baseline: {
      honestyHumility: 50,
      emotionality: 50,
      extraversion: 50,
      agreeableness: 50,
      conscientiousness: 50,
      openness: 50,
    },
    learnedDelta: zeroVector(),
    evidence,
    changes,
  });
  const person = (id, personalityState = personality(), alive = false) => ({
    id,
    ...(alive ? {} : { diedAtMonth: 0 }),
    body: { health: alive ? 100 : 0, hydration: 100, nutrition: 100 },
    personality: personalityState,
  });
  const evidence = (id, trait, direction, strength, contextKey, atMonth) => ({
    id,
    trait,
    direction,
    strength,
    contextKey,
    atMonth,
    sourceEventIds: [`source:${id}`],
  });
  const change = (id, trait, delta, atMonth) => ({
    id,
    trait,
    delta,
    atMonth,
    evidenceIds: [`evidence:${id}`],
    sourceEventIds: [`source:${id}`],
  });
  const qualifying = (prefix, trait, direction, months) => months.map((atMonth, index) => evidence(
    `${prefix}:${index}`,
    trait,
    direction,
    50,
    `${prefix}:context:${index % 2}`,
    atMonth,
  ));

  const rollingRelease = person('rolling-release', personality(
    qualifying('rolling', 'openness', 1, [-1, 0, 1]),
    [
      change('rolling-old', 'openness', 1, -10),
      change('rolling-new', 'openness', 1, 0),
    ],
  ));
  const expiryBalance = person('expiry-balance', personality([
    evidence('positive-old', 'agreeableness', 1, 50, 'positive:old', -35),
    evidence('positive-a', 'agreeableness', 1, 50, 'positive:a', -2),
    evidence('positive-b', 'agreeableness', 1, 50, 'positive:b', -1),
    evidence('negative-a', 'agreeableness', -1, 45, 'negative:a', -3),
    evidence('negative-b', 'agreeableness', -1, 45, 'negative:b', -2),
    evidence('negative-c', 'agreeableness', -1, 45, 'negative:a', -1),
  ]));
  const dirtyDead = person('dirty-dead');
  const directRewrite = person('direct-rewrite');
  const living = person('living', personality(), true);
  const historicalStableDeadCount = 4_000;
  const historicalStableDead = Array.from({ length: historicalStableDeadCount }, (_, index) => (
    person(`cold-dead-${index}`)
  ));
  const fixturePeople = [
    rollingRelease,
    expiryBalance,
    dirtyDead,
    directRewrite,
    living,
    ...historicalStableDead,
  ];
  const baseline = { people: structuredClone(fixturePeople), intents: [], projects: [] };
  const indexed = { people: structuredClone(fixturePeople), intents: [], projects: [] };

  const find = (state, id) => {
    const found = state.people.find((candidate) => candidate.id === id);
    assert.ok(found, `missing fixture person ${id}`);
    return found;
  };
  const mutableSnapshot = (state) => state.people
    .filter((candidate) => !candidate.id.startsWith('cold-dead-'))
    .map((candidate) => ({ id: candidate.id, personality: structuredClone(candidate.personality) }));
  const assertEquivalent = (month) => assert.deepEqual(
    mutableSnapshot(indexed),
    mutableSnapshot(baseline),
    `due personality consolidation diverged from the all-person fold at month ${month}`,
  );
  const conversationFact = (personId, month) => ({
    id: `action:dead-evidence:${personId}:${month}`,
    kind: 'action',
    atMonth: month,
    orderInMonth: 0,
    actionTick: 1,
    planningTick: 1,
    orderInTick: 0,
    who: personId,
    cellId: 0,
    cause: 'intent',
    status: 'completed',
    action: {
      kind: 'communicate',
      channel: 'speech',
      audience: [month % 2 ? 'audience-a' : 'audience-b'],
      content: { kind: 'claim', text: `dead evidence ${month}` },
    },
    fromCellId: 0,
    toCellId: 0,
    fromZ: 1,
    toZ: 1,
    pathSegment: [0],
    result: `dead evidence ${month}`,
    diff: {},
  });

  let coldPersonalityReads = 0;
  for (let month = 1; month <= 24; month += 1) {
    if (month >= 4 && month <= 7) {
      const fact = conversationFact('dirty-dead', month);
      api.recordPersonalityEvidence(baseline, fact);
      api.recordPersonalityEvidence(indexed, fact);
    }
    if (month === 10) {
      const replacementEvidence = qualifying('direct', 'conscientiousness', 1, [8, 9, 10]);
      find(baseline, 'direct-rewrite').personality.evidence = structuredClone(replacementEvidence);
      const indexedPerson = find(indexed, 'direct-rewrite');
      indexedPerson.personality.evidence = structuredClone(replacementEvidence);
      api.invalidatePersonPersonalityConsolidation(indexedPerson);
    }
    if (month === 12) {
      baseline.people.push(person('appended-dead', personality(qualifying('appended', 'emotionality', 1, [10, 11, 12]))));
      indexed.people.push(person('appended-dead', personality(qualifying('appended', 'emotionality', 1, [10, 11, 12]))));
    }
    if (month === 15) {
      baseline.people = [...baseline.people];
      indexed.people = [...indexed.people];
      coldPersonalityReads = 0;
    }
    if (month === 18) {
      const baselineOffset = baseline.people.findIndex((candidate) => candidate.id === 'cold-dead-100');
      const indexedOffset = indexed.people.findIndex((candidate) => candidate.id === 'cold-dead-100');
      baseline.people.splice(baselineOffset, 1, person(
        'middle-replacement',
        personality(qualifying('middle', 'honestyHumility', -1, [16, 17, 18])),
      ));
      indexed.people.splice(indexedOffset, 1, person(
        'middle-replacement',
        personality(qualifying('middle', 'honestyHumility', -1, [16, 17, 18])),
      ));
      api.invalidatePersonalityConsolidationIndex(indexed);
      coldPersonalityReads = 0;
    }
    if (month === 20) {
      baseline.people[baseline.people.length - 1] = person(
        'tail-replacement',
        personality(qualifying('tail', 'extraversion', 1, [18, 19, 20])),
      );
      indexed.people[indexed.people.length - 1] = person(
        'tail-replacement',
        personality(qualifying('tail', 'extraversion', 1, [18, 19, 20])),
      );
      coldPersonalityReads = 0;
    }

    api.consolidatePersonality(baseline, month);
    api.consolidateDuePersonalities(indexed, month);
    assertEquivalent(month);

    if (month === 1) {
      for (const cold of indexed.people.filter((candidate) => candidate.id.startsWith('cold-dead-'))) {
        let current = cold.personality;
        Object.defineProperty(cold, 'personality', {
          configurable: true,
          enumerable: true,
          get() {
            coldPersonalityReads += 1;
            return current;
          },
          set(value) {
            current = value;
          },
        });
      }
    }
    if (month === 14) assert.equal(coldPersonalityReads, 0,
      'ordinary sequential months must not revisit stable historical dead personalities');
    if (month === 15) assert.ok(coldPersonalityReads > 0,
      'whole people-array replacement must conservatively rebuild the schedule');
    if (month === 17) coldPersonalityReads = 0;
    if (month === 18) assert.ok(coldPersonalityReads > 0,
      'explicit same-array middle rewrite invalidation must conservatively rebuild');
    if (month === 19) coldPersonalityReads = 0;
    if (month === 20) assert.ok(coldPersonalityReads > 0,
      'same-length tail replacement must be detected without an explicit hook');
  }

  assert.equal(find(indexed, 'rolling-release').personality.changes.at(-1)?.atMonth, 2,
    'a dead person must consolidate when the rolling 12-month limit releases');
  assert.equal(find(indexed, 'expiry-balance').personality.changes.at(-1)?.atMonth, 2,
    'a dead person must consolidate when old opposing evidence leaves the 36-month window');
  assert.equal(find(indexed, 'dirty-dead').personality.changes.at(-1)?.atMonth, 7,
    'a sourced write must dirty and reconsider a previously unscheduled dead person');
  assert.equal(find(indexed, 'direct-rewrite').personality.changes.at(-1)?.atMonth, 10);
  assert.equal(find(indexed, 'middle-replacement').personality.changes.at(-1)?.atMonth, 18);
  assert.equal(find(indexed, 'tail-replacement').personality.changes.at(-1)?.atMonth, 20);

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1024 * 1024, 'personality schedule fixture RSS must remain below 256 MiB');
  console.log(JSON.stringify({
    result: 'passed',
    historicalStableDeadCount,
    comparedMonths: 24,
    coldPersonalityReads,
    rssBytes,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
