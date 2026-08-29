import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'eland-bounded-observer-materializer-'));

function base(id, atMonth, cellId = 0, orderInMonth = 0) {
  return { id, atMonth, orderInMonth, planningTick: 1, orderInTick: orderInMonth, cellId };
}

function action(id, atMonth, who, primitive, diff = {}, status = 'completed', cellId = 0, order = 0) {
  return {
    ...base(id, atMonth, cellId, order),
    kind: 'action', actionTick: 1, who, cause: 'intent', action: primitive,
    fromCellId: cellId, toCellId: cellId, fromZ: 1, toZ: 1,
    pathSegment: primitive.kind === 'move' ? [cellId, primitive.toCellId] : [cellId],
    status, result: id, diff,
  };
}

function emptyDemand() {
  return {
    settledCultivationProjects: [], residentialStructures: [], retainedEventIds: [], futureEventIds: [],
  };
}

function sortedObservation(value) {
  return structuredClone(value);
}

try {
  const entry = path.join(temporaryDirectory, 'entry.ts');
  await writeFile(entry, [
    `export * from ${JSON.stringify(path.join(workspace, 'server/bounded-observer-derived-materializer.ts'))};`,
    `export * from ${JSON.stringify(path.join(workspace, 'server/observer-derived-history-projection.ts'))};`,
    `export * from ${JSON.stringify(path.join(workspace, 'server/observer-derived-history-codec.ts'))};`,
    `export { createInitialState } from ${JSON.stringify(path.join(workspace, 'src/game/eland/application/simulation/state-lifecycle.ts'))};`,
    `export { derivePhysicalStructureIndex } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/physical-structure-index.ts'))};`,
    `export { observeSimulation } from ${JSON.stringify(path.join(workspace, 'src/game/eland/projection/derived-observations.ts'))};`,
    `export { Material } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/material.ts'))};`,
    `export { cellId, cellX, cellY, setVoxel, topZ } from ${JSON.stringify(path.join(workspace, 'src/game/eland/world/grid.ts'))};`,
  ].join('\n'));
  const output = path.join(temporaryDirectory, 'fixture.mjs');
  await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm' });
  const api = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

  const state = api.createInitialState({
    project() { return { kind: 'deferred', reason: 'bounded observer fixture' }; },
  }, 9182, { endpoint: { kind: 'months', value: 120 } });
  const founding = state.world.past[0];
  const trailCell = api.cellId(2, 2);
  const cropCell = api.cellId(3, 2);
  const facilityCell = api.cellId(4, 4);
  const trailZ = api.topZ(state.world.grid, trailCell);
  const cropZ = api.topZ(state.world.grid, cropCell);
  const facilityZ = api.topZ(state.world.grid, facilityCell) + 1;
  assert.ok(trailZ >= 0 && cropZ >= 0 && facilityZ > 0 && facilityZ < state.world.grid.levels);
  api.setVoxel(state.world.grid, api.cellX(trailCell), api.cellY(trailCell), trailZ, api.Material.PackedSoil);
  api.setVoxel(state.world.grid, api.cellX(cropCell), api.cellY(cropCell), cropZ, api.Material.CropSprout);
  api.setVoxel(state.world.grid, 4, 4, facilityZ, api.Material.Granary);

  const prefix = [
    founding,
    action('trail', 0, 'traveller', { kind: 'move', toCellId: trailCell }, {
      materialChanges: [{ cellId: trailCell, to: api.Material.PackedSoil }],
    }, 'progressed', api.cellId(1, 2), 1),
    action('granary-install', 0, 'builder', { kind: 'act', operation: 'combine', targets: [] }, {
      outputMaterialId: api.Material.Granary, position: { x: 4, y: 4, z: facilityZ },
    }, 'completed', facilityCell, 2),
    action('plant', 0, 'farmer', { kind: 'act', operation: 'combine', targets: [] }, {
      outputMaterialId: api.Material.CropSprout,
      position: { x: api.cellX(cropCell), y: api.cellY(cropCell), z: cropZ },
    }, 'completed', cropCell, 3),
  ];
  const suffix = [
    ...Array.from({ length: 4 }, (_, index) => action(
      `granary-use-${index}`,
      1,
      index % 2 ? 'keeper-b' : 'keeper-a',
      {
        kind: 'transfer', materialId: api.Material.Food, quantity: 1,
        from: { kind: 'person', personId: index % 2 ? 'keeper-b' : 'keeper-a' },
        to: { kind: 'container', containerId: `container:4:4:${facilityZ}` },
      },
      {}, 'completed', facilityCell, index,
    )),
    ...Array.from({ length: 6 }, (_, index) => action(
      `teach-${index}`,
      2 + index,
      index % 2 ? 'teacher-b' : 'teacher-a',
      {
        kind: 'communicate',
        content: { id: `lesson-${index}`, kind: 'claim', summary: 'lesson' },
        audience: ['learner'], channel: 'voice',
      },
      { taughtAudienceIds: ['learner'] }, 'completed', facilityCell, index,
    )),
    action('burial-1', 1, 'keeper-a', { kind: 'act', operation: 'inter', targets: [] }, { remainsInterred: true }),
    action('harvest', 2, 'farmer', {
      kind: 'act', operation: 'separate',
      targets: [{ kind: 'voxel', position: { x: api.cellX(cropCell), y: api.cellY(cropCell), z: cropZ } }],
    }, { sourceMaterialId: api.Material.CropMature }),
    action('burial-2', 7, 'keeper-b', { kind: 'act', operation: 'inter', targets: [] }, { remainsInterred: true }),
    action('burial-3', 13, 'keeper-a', { kind: 'act', operation: 'inter', targets: [] }, { remainsInterred: true }),
    action('iron-batch', 13, 'smith', { kind: 'act', operation: 'combine', targets: [] }, {
      outputMaterialId: api.Material.IronTool, facilityMaterialId: api.Material.Smithy,
    }),
  ].sort((left, right) => left.atMonth - right.atMonth || left.orderInMonth - right.orderInMonth);
  const events = [...prefix, ...suffix];
  state.clock.elapsedMonths = 13;
  state.world.past = events;
  state.world.historyCursor = {
    version: 1, eventCount: events.length, hotStartIndex: 0, tailEventId: events.at(-1).id,
  };
  state.lastStep = suffix.filter((event) => event.atMonth === 13);
  state.world.physicalStructureIndex = api.derivePhysicalStructureIndex(state);
  const physical = state.world.physicalStructureIndex;
  assert.equal(physical.structures.filter((item) => item.complete).length, 0,
    'fixture keeps residential demand empty while still exercising placeable facility provenance');

  const demand = emptyDemand();
  const prefixTarget = {
    stateHash: 'a'.repeat(64), eventCount: prefix.length, tailEventId: prefix.at(-1).id,
  };
  const finalTarget = {
    stateHash: 'b'.repeat(64), eventCount: events.length, tailEventId: events.at(-1).id,
  };
  const fullProjection = api.projectObserverDerivedHistoryFromFullHistory(events, finalTarget, demand);
  const prefixProjection = api.projectObserverDerivedHistoryFromFullHistory(prefix, prefixTarget, demand);
  const encodedPrefix = api.encodeObserverDerivedHistorySidecar({ sourceDemand: demand, projection: prefixProjection });
  const decodedPrefix = api.decodeObserverDerivedHistorySidecar(encodedPrefix.chunk, {
    reference: encodedPrefix.reference, boundary: { target: prefixTarget },
  });

  const fullObservations = api.observeSimulation(state, physical);
  const sentinelMilestones = [{ id: 'civilization-sidecar-owned', label: 'sentinel', evidenceEventIds: [], note: 'keep' }];
  const sentinelDevelopment = { marker: 'leave civilization observer untouched' };
  const boundedState = {
    ...state,
    world: {
      ...state.world,
      past: suffix,
      historyCursor: {
        version: 1, eventCount: events.length, hotStartIndex: prefix.length, tailEventId: events.at(-1).id,
      },
      physicalStructureIndex: physical,
    },
    civilization: { ...state.civilization, development: sentinelDevelopment },
    derived: { ...state.derived, milestones: sentinelMilestones },
  };
  const suppliedSuffix = structuredClone(suffix);
  const advanced = api.advanceBoundedObserverDerivedSubset(
    boundedState,
    decodedPrefix,
    prefixTarget,
    finalTarget,
    suppliedSuffix,
    demand,
  );

  assert.deepEqual(advanced.projection, fullProjection,
    'full history and bounded prefix+authoritative suffix must produce the same cumulative projection');
  assert.deepEqual(sortedObservation(boundedState.derived.practices), sortedObservation(fullObservations.practices));
  assert.deepEqual(sortedObservation(boundedState.derived.institutions), sortedObservation(fullObservations.institutions));
  assert.deepEqual(sortedObservation(boundedState.derived.regions), sortedObservation(fullObservations.regions));
  assert.deepEqual(boundedState.derived.structures, fullObservations.structures ?? physical.structures);
  assert.deepEqual(boundedState.derived.milestones, sentinelMilestones,
    'subset adapter must leave civilization-sidecar milestones untouched');
  assert.strictEqual(boundedState.civilization.development, sentinelDevelopment,
    'subset adapter must leave era/development observer untouched');
  assert.equal(advanced.materialization.functionalBuildings.find((item) => item.kind === 'storage')?.useCount, 4);
  assert.equal(advanced.materialization.materialCapabilities.iron.successfulBatchCount, 1);
  assert.equal(advanced.continuationReady, false);
  assert.deepEqual(advanced.materialization.projectionGaps, api.OBSERVER_DERIVED_HISTORY_CONTINUATION_GAPS);

  const stableFirstEvidence = advanced.projection.practices.storage.evidence[0]?.eventId;
  suppliedSuffix[0].id = 'caller-mutated-after-return';
  assert.equal(advanced.projection.practices.storage.evidence[0]?.eventId, stableFirstEvidence,
    'caller-owned suffix mutation must not poison the finished projection');

  const encodedFinal = api.encodeObserverDerivedHistorySidecar({
    sourceDemand: advanced.sidecar.sourceDemand,
    projection: advanced.projection,
  });
  const decodedFinal = api.decodeObserverDerivedHistorySidecar(encodedFinal.chunk, {
    reference: encodedFinal.reference, boundary: { target: finalTarget },
  });
  assert.throws(
    () => api.materializeDecodedBoundedObserverDerivedSubset(boundedState, decodedPrefix, finalTarget),
    /stale projection target/u,
  );

  const physicalMismatchState = {
    ...boundedState,
    derived: { ...boundedState.derived },
    world: {
      ...boundedState.world,
      physicalStructureIndex: {
        ...boundedState.world.physicalStructureIndex,
        appliedHistoryEventCount: finalTarget.eventCount - 1,
      },
    },
  };
  assert.throws(
    () => api.materializeDecodedBoundedObserverDerivedSubset(physicalMismatchState, decodedFinal, finalTarget),
    /physical topology/u,
  );

  api.setVoxel(boundedState.world.grid, 4, 4, facilityZ, api.Material.Air);
  assert.throws(
    () => api.materializeDecodedBoundedObserverDerivedSubset(boundedState, decodedFinal, finalTarget),
    /current grid\/target|physical topology/u,
    'grid mutation after the physical seal must fail closed',
  );

  const forgedGapPayload = JSON.parse(Buffer.from(encodedFinal.chunk.data).toString('utf8'));
  forgedGapPayload.projection.continuationGaps[0] = 'unknown-gap';
  const canonical = (value) => Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value;
  const forgedBytes = Buffer.from(JSON.stringify(canonical(forgedGapPayload)), 'utf8');
  const forgedHash = api.hashObserverDerivedHistoryStoredContent(
    api.OBSERVER_DERIVED_HISTORY_SIDECAR_CODEC,
    forgedBytes,
  );
  assert.throws(() => api.decodeObserverDerivedHistorySidecar({
    hash: forgedHash,
    codec: api.OBSERVER_DERIVED_HISTORY_SIDECAR_CODEC,
    rawSize: forgedBytes.byteLength,
    data: forgedBytes,
  }, {
    reference: { kind: 'content-hash', codec: api.OBSERVER_DERIVED_HISTORY_SIDECAR_CODEC, hash: forgedHash },
    boundary: { target: finalTarget },
  }), /gap|未知或顺序/u, 'unknown declared projection gaps must fail closed');

  assert.throws(
    () => api.materializeDecodedBoundedObserverDerivedSubset(
      physicalMismatchState,
      structuredClone(decodedFinal),
      finalTarget,
    ),
    /strict store-selected decoder/u,
    'structurally identical caller objects cannot mint decoded-sidecar authority',
  );

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1_024 * 1_024, 'bounded observer materializer fixture RSS must stay below 256 MiB');
  console.log(JSON.stringify({
    result: 'passed',
    prefixEventCount: prefix.length,
    suffixEventCount: suffix.length,
    finalEventCount: events.length,
    practices: advanced.materialization.practices.length,
    institutions: advanced.materialization.institutions.length,
    regions: advanced.materialization.regions.length,
    functionalBuildings: advanced.materialization.functionalBuildings.length,
    projectionGaps: advanced.materialization.projectionGaps.length,
    continuationReady: advanced.continuationReady,
    rssBytes,
  }, null, 2));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
