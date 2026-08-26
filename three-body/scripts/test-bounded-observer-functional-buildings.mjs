import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = await mkdtemp(path.join(
  tmpdir(),
  'eland-bounded-observer-functional-buildings-',
));

function base(id, atMonth, cellId = 0, orderInMonth = 0) {
  return {
    id,
    atMonth,
    orderInMonth,
    planningTick: 1,
    orderInTick: orderInMonth,
    cellId,
  };
}

function action(id, atMonth, who, primitive, diff, cellId, orderInMonth = 0) {
  return {
    ...base(id, atMonth, cellId, orderInMonth),
    kind: 'action',
    actionTick: 1,
    who,
    cause: 'intent',
    action: primitive,
    fromCellId: cellId,
    toCellId: cellId,
    fromZ: 1,
    toZ: 1,
    pathSegment: [cellId],
    status: 'completed',
    result: id,
    diff,
  };
}

function addSnapshot(chunks, snapshot) {
  for (const chunk of [snapshot.root, ...snapshot.parts]) {
    const existing = chunks.get(chunk.hash);
    if (existing) assert.deepEqual(existing.data, chunk.data, 'content hash collision');
    else chunks.set(chunk.hash, chunk);
  }
}

function readFrom(chunks) {
  return (hash) => {
    const chunk = chunks.get(hash);
    if (!chunk) throw new Error(`fixture missing chunk ${hash}`);
    return chunk;
  };
}

try {
  const entry = path.join(temporaryDirectory, 'entry.ts');
  await writeFile(entry, [
    `export * from ${JSON.stringify(path.join(workspace, 'server/bounded-observer-derived-materializer.ts'))};`,
    `export * from ${JSON.stringify(path.join(workspace, 'server/observer-derived-history-projection.ts'))};`,
    `export * from ${JSON.stringify(path.join(workspace, 'server/observer-derived-history-codec.ts'))};`,
    `export * from ${JSON.stringify(path.join(workspace, 'server/run-state-codec.ts'))};`,
    `export { createInitialState } from ${JSON.stringify(path.join(workspace, 'src/game/eland/application/simulation/state-lifecycle.ts'))};`,
    `export { derivePhysicalStructureIndex } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/physical-structure-index.ts'))};`,
    `export { Material } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/material.ts'))};`,
    `export { cellId, cellX, cellY, setVoxel, topZ, voxelWorldRevision } from ${JSON.stringify(path.join(workspace, 'src/game/eland/world/grid.ts'))};`,
  ].join('\n'));
  const output = path.join(temporaryDirectory, 'fixture.mjs');
  await build({
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
  });
  const api = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

  const state = api.createInitialState(
    { project() {} },
    34_091,
    { endpoint: { kind: 'months', value: 120 } },
  );
  const builderId = state.people[0].id;
  const keeperA = state.people[1].id;
  const keeperB = state.people[2].id;
  const facilityCell = api.cellId(4, 4);
  const facilityZ = api.topZ(state.world.grid, facilityCell) + 1;
  assert.ok(facilityZ > 0 && facilityZ < state.world.grid.levels);
  api.setVoxel(state.world.grid, 4, 4, facilityZ, api.Material.Granary);

  const installations = Array.from({ length: 20 }, (_, index) => action(
    `granary-install-${index}`,
    index,
    builderId,
    { kind: 'act', operation: 'combine', targets: [] },
    {
      outputMaterialId: api.Material.Granary,
      position: { x: 4, y: 4, z: facilityZ },
    },
    facilityCell,
    index === 0 ? 1 : 0,
  ));
  const uses = Array.from({ length: 20 }, (_, index) => action(
    `granary-use-${index}`,
    20 + index,
    index % 2 === 0 ? keeperB : keeperA,
    {
      kind: 'transfer',
      materialId: api.Material.Food,
      quantity: 1,
      from: { kind: 'person', personId: index % 2 === 0 ? keeperB : keeperA },
      to: { kind: 'container', containerId: `container:4:4:${facilityZ}` },
    },
    {},
    facilityCell,
  ));
  const tail = action(
    'hot-tail-only',
    40,
    builderId,
    { kind: 'act', operation: 'separate', targets: [] },
    {},
    facilityCell,
  );
  const events = [state.world.past[0], ...installations, ...uses, tail];
  state.clock.elapsedMonths = 40;
  state.world.past = events;
  state.world.historyCursor = {
    version: 1,
    eventCount: events.length,
    hotStartIndex: 0,
    tailEventId: tail.id,
  };
  state.lastStep = [tail];
  state.world.physicalStructureIndex = api.derivePhysicalStructureIndex(state);

  const snapshot = await api.encodeSegmentedRunState(
    state,
    { mode: 'replace' },
    { maxEventsPerSegmentForTests: 4 },
  );
  assert.equal(snapshot.metadata.schemaVersion, 3, 'fixture must start from a schema3 exact root');
  const chunks = new Map();
  addSnapshot(chunks, snapshot);
  const bounded = await api.decodeSegmentedRunStateGameplayBounded(
    snapshot.root,
    readFrom(chunks),
    {
      hotEventLimit: 1,
      pinnedEventIndexes: [],
      observerAuthority: {
        stateHash: snapshot.root.hash,
        revision: 9,
        month: 40,
        lastMaterializedMilestoneCount: state.derived.milestones.length,
      },
    },
  );
  assert.deepEqual(
    bounded.state.world.past.map(({ id }) => id),
    [tail.id],
    'bounded schema3 shell must not retain facility installation/use history',
  );
  assert.equal(Object.hasOwn(bounded.state.derived, 'functionalBuildings'), false);
  // A decoded grid has a new in-process identity. Production obtains this
  // current-identity value from the verified physical sidecar bootstrap.
  bounded.state.world.physicalStructureIndex.voxelRevision = api.voxelWorldRevision(
    bounded.state.world.grid,
  );

  const demand = {
    settledCultivationProjects: [],
    residentialStructures: [],
    retainedEventIds: [],
    futureEventIds: [],
  };
  const target = {
    stateHash: snapshot.root.hash,
    eventCount: events.length,
    tailEventId: tail.id,
  };
  const projection = api.projectObserverDerivedHistoryFromFullHistory(events, target, demand);
  const encoded = api.encodeObserverDerivedHistorySidecar({ sourceDemand: demand, projection });
  const decoded = api.decodeObserverDerivedHistorySidecar(encoded.chunk, {
    reference: encoded.reference,
    boundary: { target },
  });

  const first = api.materializeDecodedBoundedObserverDerivedSubset(
    bounded.state,
    decoded,
    target,
  );
  const building = bounded.state.derived.functionalBuildings[0];
  assert.ok(building, 'facility projection must be written back into state.derived');
  assert.deepEqual(building, first.functionalBuildings[0]);
  assert.equal(building.active, true);
  assert.equal(
    building.functionSummary,
    '提供 96 单位公共储量，容量是普通木制容器的四倍',
  );
  assert.deepEqual(building.userIds, [keeperA, keeperB].sort());
  assert.equal(building.installationCount, 20);
  assert.equal(building.useCount, 20);
  assert.deepEqual(
    building.installationEventIds,
    installations.slice(0, api.OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT).map(({ id }) => id),
  );
  assert.deepEqual(
    building.useEventIds,
    uses.slice(0, api.OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT).map(({ id }) => id),
  );
  assert.ok(building.installationEventIds.length < building.installationCount);
  assert.ok(building.useEventIds.length < building.useCount);
  assert.equal(
    building.observationVersion,
    api.BOUNDED_OBSERVER_FUNCTIONAL_BUILDING_OBSERVATION_VERSION,
  );
  assert.equal(
    building.evidenceSemantics,
    api.BOUNDED_OBSERVER_FUNCTIONAL_BUILDING_EVIDENCE_SEMANTICS,
  );
  assert.equal(first.continuationReady, false);

  const stable = structuredClone(bounded.state.derived.functionalBuildings);
  bounded.state.derived.functionalBuildings[0].functionSummary = 'poison from prior derived shell';
  bounded.state.derived.functionalBuildings[0].installationEventIds = ['poison-event'];
  const second = api.materializeDecodedBoundedObserverDerivedSubset(
    bounded.state,
    decoded,
    target,
  );
  assert.deepEqual(bounded.state.derived.functionalBuildings, stable,
    'repeat materialization must be deterministic and ignore prior derived output');
  assert.deepEqual(second.functionalBuildings, first.functionalBuildings);
  assert.deepEqual(bounded.state.world.past.map(({ id }) => id), [tail.id],
    'materialization must not fabricate or restore trimmed history');
  const finalBuilding = bounded.state.derived.functionalBuildings[0];

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1_024 * 1_024,
    'bounded functional-building fixture RSS must stay below 256 MiB');
  console.log(JSON.stringify({
    result: 'passed',
    rootSchemaVersion: snapshot.metadata.schemaVersion,
    sourceEventCount: events.length,
    hotEventCount: bounded.state.world.past.length,
    installationCount: finalBuilding.installationCount,
    installationWitnessCount: finalBuilding.installationEventIds.length,
    useCount: finalBuilding.useCount,
    useWitnessCount: finalBuilding.useEventIds.length,
    continuationReady: first.continuationReady,
    rssBytes,
  }, null, 2));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
