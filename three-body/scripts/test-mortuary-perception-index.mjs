import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-mortuary-perception-index-'));
const bundlePath = path.join(temporaryDirectory, 'mortuary-perception-index.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/simulation.ts'))};
    export { invalidateMortuaryPerceptionIndex, synchronizeMortuaryPerceptions } from ${JSON.stringify(path.resolve('src/game/eland/domain/mortuary.ts'))};
    export { WORLD_CELL_COUNT } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=mortuary-perception-index-entry.ts', `--outfile=${bundlePath}`,
  ], {
    input: entry,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=192' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = api.createInitialState(20260825, { endpoint: { kind: 'months', value: 24 } });
  const observer = state.people[0];
  assert.ok(observer, 'fixture requires one founder');
  const livingTemplate = structuredClone(observer);
  observer.memories = [];
  observer.bereavements = [];
  observer.relations = [];
  state.people = [observer];
  state.world.remains = [];
  state.world.memorials = [];
  const localCellId = observer.position.cellId;
  const localZ = observer.position.z;
  const farCellId = localCellId < api.WORLD_CELL_COUNT / 2 ? api.WORLD_CELL_COUNT - 1 : 0;

  const addDeceased = (id, name) => {
    const deceased = structuredClone(livingTemplate);
    deceased.id = id;
    deceased.name = name;
    deceased.diedAtMonth = 1;
    deceased.body.health = 0;
    deceased.memories = [];
    deceased.bereavements = [];
    deceased.relations = [];
    state.people.push(deceased);
    return deceased;
  };
  const addObserver = (id) => {
    const nextObserver = structuredClone(livingTemplate);
    nextObserver.id = id;
    nextObserver.memories = [];
    nextObserver.bereavements = [];
    nextObserver.relations = [];
    nextObserver.position = structuredClone(observer.position);
    state.people.push(nextObserver);
    return nextObserver;
  };
  const remains = (id, personId, cellId, status = 'interred') => ({
    id,
    personId,
    position: { cellId, z: localZ },
    status,
    createdAtMonth: 1,
    deathEventId: `death:${personId}`,
    sourceEventIds: [`death:${personId}`],
    ...(status === 'interred' ? { interredAtMonth: 1, interredByPersonId: 'historical-burial' } : {}),
  });
  const marker = (remainsId) => ({
    id: `memorial:${remainsId}`,
    remainsId,
    personId: remainsId.slice('remains:'.length),
    position: { cellId: farCellId, z: localZ + 1, x: 0, y: 0 },
    materialId: 1,
    inscription: remainsId,
    madeByPersonId: 'historical-marker',
    createdAtMonth: 1,
    sourceEventIds: [`marker:${remainsId}`],
  });

  const promotedDeceased = addDeceased('deceased-promoted', '先入序墓主');
  const movingDeceased = addDeceased('deceased-moving', '移动遗体墓主');
  const appendedDeceased = addDeceased('deceased-appended', '新近亡者');
  const promoted = remains('remains:promoted', promotedDeceased.id, localCellId);
  state.world.remains.push(promoted);

  const historicalStableRemainsCount = 8_000;
  const coldStable = Array.from({ length: historicalStableRemainsCount }, (_, index) => (
    remains(`remains:cold-${index}`, `deceased-cold-${index}`, farCellId)
  ));
  state.world.remains.push(...coldStable);
  state.world.memorials.push(...coldStable.map((candidate) => marker(candidate.id)));

  const moving = remains('remains:moving', movingDeceased.id, farCellId, 'exposed');
  state.world.remains.push(moving);
  assert.deepEqual(api.synchronizeMortuaryPerceptions(state, 1, 0), [],
    'unmarked interment and distant remains must not create global death knowledge');

  let coldStatusReads = 0;
  for (const candidate of coldStable) {
    let currentStatus = candidate.status;
    Object.defineProperty(candidate, 'status', {
      configurable: true,
      enumerable: true,
      get() {
        coldStatusReads += 1;
        return currentStatus;
      },
      set(value) {
        currentStatus = value;
      },
    });
  }

  // Marker creation promotes an old, formerly invisible interment. Open
  // remains are refreshed from their current in-place positions, while a new
  // appended death joins the same original-offset ordering.
  state.world.memorials.push(marker(promoted.id));
  moving.position = { cellId: localCellId, z: localZ };
  const appended = remains('remains:appended', appendedDeceased.id, localCellId, 'exposed');
  state.world.remains.push(appended);
  const learned = api.synchronizeMortuaryPerceptions(state, 2, 7);
  assert.deepEqual(
    learned.map((event) => event.diff.remainsId),
    [promoted.id, moving.id, appended.id],
    'stable, moved-open, and appended remains must retain authoritative array offset order',
  );
  assert.deepEqual(learned.map((event) => event.orderInMonth), [7, 8, 9]);
  assert.deepEqual(learned.map((event) => event.id), [
    'e-2-environment-relationship-7',
    'e-2-environment-relationship-8',
    'e-2-environment-relationship-9',
  ]);
  assert.equal(coldStatusReads, 0,
    'a marker for one grave and one appended death must not revisit every stable historical grave');
  assert.deepEqual(api.synchronizeMortuaryPerceptions(state, 3, 0), [],
    'already learned deaths must not be emitted twice');
  assert.equal(coldStatusReads, 0, 'an unchanged month must not rescan stable distant graves');

  // The last legal in-place status transition removes an unmarked interment
  // from perception, then a later append-only marker promotes it without a
  // scan through the historical stable set.
  moving.status = 'interred';
  moving.interredAtMonth = 4;
  const unmarkedObserver = addObserver('unmarked-observer');
  const unmarkedEvents = api.synchronizeMortuaryPerceptions(state, 4, 0)
    .filter((event) => event.who === unmarkedObserver.id);
  assert.deepEqual(unmarkedEvents.map((event) => event.diff.remainsId), [promoted.id, appended.id]);
  state.world.memorials.push(marker(moving.id));
  const markedObserver = addObserver('marked-observer');
  const markedEvents = api.synchronizeMortuaryPerceptions(state, 5, 0)
    .filter((event) => event.who === markedObserver.id);
  assert.deepEqual(markedEvents.map((event) => event.diff.remainsId), [promoted.id, moving.id, appended.id]);
  assert.equal(coldStatusReads, 0, 'status settlement and later marker promotion must remain suffix-bounded');
  const coldStatusReadsBeforeReplacement = coldStatusReads;

  // A whole-array replacement is a supported ownership boundary and must
  // rebuild automatically rather than reuse offsets from the prior array.
  const replacementObserver = addObserver('replacement-observer');
  state.world.remains = [...state.world.remains];
  const replacementEvents = api.synchronizeMortuaryPerceptions(state, 6, 0)
    .filter((event) => event.who === replacementObserver.id);
  assert.deepEqual(replacementEvents.map((event) => event.diff.remainsId), [promoted.id, moving.id, appended.id]);

  // Same-array splice/sort is exceptional rather than an authoritative domain
  // write. The explicit hook makes that path fail safe and rebuild first-wins
  // offsets before the next local perception.
  const rewrittenDeceased = addDeceased('deceased-rewritten', '改写后亡者');
  const rewritten = remains('remains:rewritten', rewrittenDeceased.id, localCellId, 'exposed');
  state.world.remains.splice(1, 1, rewritten);
  api.invalidateMortuaryPerceptionIndex(state);
  const rewriteObserver = addObserver('rewrite-observer');
  const rewrittenEvents = api.synchronizeMortuaryPerceptions(state, 7, 0)
    .filter((event) => event.who === rewriteObserver.id);
  assert.deepEqual(rewrittenEvents.map((event) => event.diff.remainsId), [
    promoted.id,
    rewritten.id,
    moving.id,
    appended.id,
  ]);

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1024 * 1024, 'mortuary perception fixture RSS must remain below 256 MiB');
  console.log(JSON.stringify({
    result: 'passed',
    historicalStableRemainsCount,
    learnedRemainsIds: learned.map((event) => event.diff.remainsId),
    coldStatusReadsBeforeReplacement,
    rssBytes,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
