import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-lower-era-store-'));
const dataDirectory = path.join(temporaryDirectory, 'data');
let store;

function action(id, atMonth, orderInMonth, who, cellId, primitive, diff) {
  return {
    id,
    kind: 'action',
    actionTick: 1,
    atMonth,
    orderInMonth,
    planningTick: 1,
    orderInTick: orderInMonth,
    cellId,
    who,
    cause: 'intent',
    action: primitive,
    fromCellId: cellId,
    toCellId: cellId,
    fromZ: 5,
    toZ: 5,
    pathSegment: [cellId],
    status: 'completed',
    result: id,
    diff,
  };
}

try {
  const entry = path.join(temporaryDirectory, 'entry.ts');
  const output = path.join(temporaryDirectory, 'fixture.mjs');
  writeFileSync(entry, [
    `export { SqliteRunStore } from ${JSON.stringify(path.join(workspace, 'server/sqlite-run-store.ts'))};`,
    `export { createInitialState } from ${JSON.stringify(path.join(workspace, 'src/game/eland/simulation.ts'))};`,
    `export { Material } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/material.ts'))};`,
    `export { cellId, setVoxel } from ${JSON.stringify(path.join(workspace, 'src/game/eland/world/grid.ts'))};`,
  ].join('\n'));
  buildSync({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm' });
  const api = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);
  const state = api.createInitialState(82_701, {
    endpoint: { kind: 'months', value: 120 },
    chaosIntensity: 0,
  });
  const [firstPerson, secondPerson] = state.people;
  assert.ok(firstPerson && secondPerson, 'fixture requires two initial people');
  const events = [...state.world.past];
  const orderByMonth = new Map();
  const pushAction = (id, atMonth, who, cell, primitive, diff) => {
    const order = orderByMonth.get(atMonth) ?? 0;
    orderByMonth.set(atMonth, order + 1);
    const event = action(id, atMonth, order, who, cell, primitive, diff);
    events.push(event);
    return event;
  };

  const granaryPosition = { x: 4, y: 4, z: 5 };
  const hearthPosition = { x: 6, y: 4, z: 5 };
  const granaryCell = api.cellId(granaryPosition.x, granaryPosition.y);
  const hearthCell = api.cellId(hearthPosition.x, hearthPosition.y);
  const granaryId = `container:${granaryPosition.x}:${granaryPosition.y}:${granaryPosition.z}`;
  api.setVoxel(state.world.grid, granaryPosition.x, granaryPosition.y, granaryPosition.z, api.Material.Granary);
  api.setVoxel(state.world.grid, hearthPosition.x, hearthPosition.y, hearthPosition.z, api.Material.CouncilHearth);
  const granaryInstall = pushAction(
    'cold-granary-install', 1, firstPerson.id, granaryCell,
    { kind: 'act', operation: 'combine', targets: [] },
    { outputMaterialId: api.Material.Granary, position: granaryPosition },
  );
  pushAction(
    'cold-hearth-install', 1, secondPerson.id, hearthCell,
    { kind: 'act', operation: 'combine', targets: [] },
    { outputMaterialId: api.Material.CouncilHearth, position: hearthPosition },
  );

  for (let index = 0; index < 16; index += 1) {
    const who = index % 2 === 0 ? firstPerson.id : secondPerson.id;
    const atMonth = 1 + (index % 6);
    pushAction(
      `cold-masonry-${index}`, atMonth, who, firstPerson.position.cellId,
      { kind: 'act', operation: 'combine', targets: [] },
      {
        outputMaterialId: api.Material.StoneTool,
        toolMaterialId: api.Material.StoneTool,
        facilityMaterialId: api.Material.Cistern,
      },
    );
  }

  for (let index = 0; index < 4; index += 1) {
    const who = index % 2 === 0 ? firstPerson.id : secondPerson.id;
    pushAction(
      `cold-granary-use-${index}`, 7 + index, who, granaryCell,
      {
        kind: 'transfer',
        from: { kind: 'person', personId: who, stackId: `fixture-food-${index}` },
        to: { kind: 'container', containerId: granaryId },
        materialId: api.Material.Food,
        quantity: 1,
      },
      {},
    );
  }
  pushAction(
    'cold-hearth-use', 10, firstPerson.id, hearthCell,
    {
      kind: 'communicate',
      audience: [secondPerson.id],
      content: { kind: 'claim', text: 'fixture coordination' },
    },
    {},
  );

  const cultivationCenter = api.cellId(20, 20);
  const positions = [
    { x: 20, y: 20, z: 4 },
    { x: 21, y: 20, z: 4 },
    { x: 19, y: 20, z: 4 },
    { x: 20, y: 21, z: 4 },
    { x: 20, y: 19, z: 4 },
    { x: 21, y: 21, z: 4 },
  ];
  const cultivationFacts = [];
  positions.forEach((position, index) => {
    cultivationFacts.push(pushAction(
      `cold-plant-${index}`, 2 + index, firstPerson.id,
      api.cellId(position.x, position.y),
      { kind: 'act', operation: 'combine', targets: [] },
      { outputMaterialId: api.Material.CropSprout, position },
    ));
  });
  positions.slice(0, 2).forEach((position, index) => {
    cultivationFacts.push(pushAction(
      `cold-harvest-${index}`, 9 + index, firstPerson.id,
      api.cellId(position.x, position.y),
      { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position }] },
      {
        sourceMaterialId: api.Material.CropMature,
        outputs: [{ materialId: api.Material.Food, quantity: 2 }],
      },
    ));
  });
  state.projects.push({
    id: 'cold-settled-cultivation',
    kind: 'production',
    need: 'production-efficiency',
    desiredFunction: 'settled-cultivation',
    summary: 'cold exact cultivation fixture',
    ownerId: firstPerson.id,
    beneficiaryIds: [firstPerson.id],
    triggerFactIds: ['fixture-food-pressure'],
    pressure: 80,
    createdAtMonth: 1,
    reviewAtMonth: 24,
    site: { cellId: cultivationCenter, z: 5 },
    status: 'completed',
    lastProgressAtMonth: 10,
    missingMaterialIds: [],
    materialDemands: [],
    reservations: [],
    contributorIds: [firstPerson.id],
    actionEventIds: cultivationFacts.map((event) => event.id),
    failureEventIds: [],
    completionEventIds: cultivationFacts.map((event) => event.id),
    completedAtMonth: 10,
    progressEvidence: [],
    searchCampaigns: [],
    logisticsEpisodes: [],
  });
  state.containers = [{
    id: granaryId,
    position: granaryPosition,
    inventory: [{
      id: 'fixture-stored-food',
      materialId: api.Material.Food,
      quantity: 96,
      sourceEventIds: ['fixture-food-source'],
    }],
    capacity: 96,
    createdAtMonth: 1,
    sourceEventIds: [granaryInstall.id],
  }];

  for (let index = 0; index < 160; index += 1) {
    events.push({
      id: `hot-fixture-padding-${index}`,
      kind: 'environment',
      atMonth: 11,
      orderInMonth: index,
      planningTick: 0,
      orderInTick: index,
      cellId: 0,
      change: 'fixture',
      result: 'bounded hot-tail fixture padding',
      diff: {},
    });
  }
  const sentinel = {
    id: 'hot-month-11-sentinel',
    kind: 'environment',
    atMonth: 11,
    orderInMonth: 160,
    planningTick: 0,
    orderInTick: 160,
    cellId: 0,
    change: 'fixture',
    result: 'hot source sentinel',
    diff: {},
  };
  events.push(sentinel);
  events.sort((left, right) => left.atMonth - right.atMonth
    || left.orderInMonth - right.orderInMonth
    || left.id.localeCompare(right.id));
  state.clock.elapsedMonths = 11;
  state.world.past = events;
  state.world.historyCursor = {
    version: 1,
    eventCount: events.length,
    hotStartIndex: 0,
    tailEventId: events.at(-1).id,
  };
  state.lastStep = [sentinel];

  store = new api.SqliteRunStore(dataDirectory);
  await store.create({ id: 'fresh-lower-era', state });
  await store.bootstrapBoundedEvolutionContinuation('fresh-lower-era', 128);
  const source = await store.openBoundedEvolutionContinuation('fresh-lower-era');
  assert.equal(source.meta.elapsedMonths, 11);
  assert.ok(source.state.world.past.length <= 128);
  assert.equal(source.state.world.past.some((event) => event.id === 'cold-masonry-0'), false,
    'masonry evidence must already be outside the hot tail before first boundary');

  const month12 = await store.publishBoundedObserverBoundaryMonth(
    await store.stageBoundedObserverBoundaryMonth('fresh-lower-era'),
  );
  assert.equal(month12.month, 12);
  assert.equal(month12.stage, '原始部落');
  let opened = await store.openBoundedEvolutionContinuation('fresh-lower-era');
  assert.equal(
    opened.state.civilization.civilizationIndex.formulaVersion,
    'open-material-institution-v1-certified-current-root-lower-bound-v1',
  );
  assert.ok(opened.state.civilization.civilizationIndex.total >= 120);
  const month12IndexFloor = opened.state.civilization.civilizationIndex.total;
  assert.equal(opened.state.lastMaterializedObserverBasis.developmentSnapshot.candidateEra, 'agrarian-settlement');
  assert.equal(opened.state.lastMaterializedObserverBasis.developmentSnapshot.candidateSinceMonth, 11);

  store.close();
  store = new api.SqliteRunStore(dataDirectory);
  for (let month = 13; month <= 23; month += 1) {
    const published = await store.publishBoundedNonProjectionMonth(
      await store.stageBoundedNonProjectionMonth('fresh-lower-era'),
    );
    assert.equal(published.month, month);
  }
  const month24 = await store.publishBoundedObserverBoundaryMonth(
    await store.stageBoundedObserverBoundaryMonth('fresh-lower-era'),
  );
  assert.equal(month24.month, 24);
  assert.equal(month24.stage, '农耕定居');
  opened = await store.openBoundedEvolutionContinuation('fresh-lower-era');
  assert.equal(opened.state.civilization.stage, '农耕定居');
  assert.equal(opened.state.lastMaterializedObserverBasis.developmentSnapshot.currentEra, 'agrarian-settlement');
  assert.equal(opened.state.lastMaterializedObserverBasis.developmentSnapshot.candidateSinceMonth, 11);
  assert.equal(opened.state.world.past.some((event) => event.id === 'cold-masonry-0'), false);

  const maxRssBytes = process.resourceUsage().maxRSS * 1_024;
  console.log(JSON.stringify({
    ok: true,
    month12: {
      stage: month12.stage,
      candidate: 'agrarian-settlement',
      indexFloor: month12IndexFloor,
    },
    month24: { stage: month24.stage, currentEra: 'agrarian-settlement' },
    coldEvidenceOutsideHotTail: true,
    restartBetweenBoundaries: true,
    maxRssBytes,
  }));
} finally {
  store?.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
