import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'eland-bounded-civilization-observer-'));

function base(id, atMonth, orderInMonth = 0, cellId = 0) {
  return { id, atMonth, orderInMonth, planningTick: 1, orderInTick: orderInMonth, cellId };
}

function action(id, atMonth, who, primitive, diff = {}, orderInMonth = 0) {
  return {
    ...base(id, atMonth, orderInMonth),
    kind: 'action', actionTick: 1, who, cause: 'intent', action: primitive,
    fromCellId: 0, toCellId: 0, fromZ: 1, toZ: 1, pathSegment: [0],
    status: 'completed', result: id, diff,
  };
}

function environment(id, atMonth, change, diff, orderInMonth = 0) {
  return { ...base(id, atMonth, orderInMonth), kind: 'environment', change, summary: id, diff };
}

function agreement(id, atMonth, change, orderInMonth = 0) {
  return { ...base(id, atMonth, orderInMonth), kind: 'agreement', agreementId: 'agreement-1', change, summary: id, diff: {} };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function observerSnapshot(state) {
  return structuredClone({
    civilizationIndex: state.civilization.civilizationIndex,
    stage: state.civilization.stage,
    development: state.civilization.development,
    gameplayEra: state.civilization.era,
    derived: state.derived,
  });
}

try {
  const entry = path.join(temporaryDirectory, 'entry.ts');
  await writeFile(entry, [
    `export * from ${JSON.stringify(path.join(workspace, 'server/bounded-observer-civilization-materializer.ts'))};`,
    `export * from ${JSON.stringify(path.join(workspace, 'server/observer-civilization-history-projection.ts'))};`,
    `export * from ${JSON.stringify(path.join(workspace, 'server/civilization-history-codec.ts'))};`,
    `export { createInitialState } from ${JSON.stringify(path.join(workspace, 'src/game/eland/application/simulation/state-lifecycle.ts'))};`,
    `export { derivePhysicalStructureIndex, rematerializePhysicalStructureIndex } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/physical-structure-index.ts'))};`,
    `export { Material } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/material.ts'))};`,
  ].join('\n'));
  const output = path.join(temporaryDirectory, 'fixture.mjs');
  await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm' });
  const api = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

  const state = api.createInitialState({ project() {} }, 11939, { endpoint: { kind: 'months', value: 120 } });
  const founding = state.world.past[0];
  const prefix = [
    founding,
    action('process-plank', 0, 'maker', { kind: 'act', operation: 'combine', targets: [] }, {
      outputMaterialId: api.Material.Plank,
    }, 1),
    action('teach-fact', 0, 'maker', {
      kind: 'communicate',
      content: { id: 'claim-1', kind: 'claim', summary: 'sourced technique', factId: 'fact-technique' },
      audience: ['learner'], channel: 'voice',
    }, {}, 2),
  ];
  const suffix = [
    action('directed-transfer', 1, 'maker', {
      kind: 'transfer', materialId: api.Material.Food, quantity: 1,
      from: { kind: 'person', personId: 'maker' },
      to: { kind: 'person', personId: 'learner' },
    }, {}, 0),
    environment('birth-1', 1, 'birth', { bornPersonId: 'child' }, 1),
    environment('death-1', 1, 'death', {}, 2),
    environment('era-1', 2, 'climate', { eraTransition: true, epoch: 'chaotic' }, 0),
    agreement('agreement-fulfilled', 2, 'fulfilled', 1),
  ];
  const events = [...prefix, ...suffix];
  state.clock.elapsedMonths = 2;
  state.world.past = events;
  state.world.historyCursor = {
    version: 1, eventCount: events.length, hotStartIndex: 0, tailEventId: events.at(-1).id,
  };
  state.lastStep = suffix.filter((event) => event.atMonth === 2);
  state.world.physicalStructureIndex = api.derivePhysicalStructureIndex(state);
  state.derived.structures = structuredClone(state.world.physicalStructureIndex.structures);
  state.civilization.civilizationIndex = {
    ...structuredClone(state.civilization.civilizationIndex),
    total: 777,
    calculatedAtMonth: 2,
  };
  state.civilization.stage = '观察器哨兵阶段';
  state.civilization.development = {
    observerVersion: 'material-institution-era-v6',
    currentEra: 'primitive-tribe', historicalPeakEra: 'primitive-tribe', candidateEra: 'primitive-tribe',
    candidateSinceMonth: 2, transitionProgress: 0, satisfiedGateIds: [], missingGateIds: [],
    supportingEventIds: [], materialCapabilities: [], marker: 'preserve-development',
  };
  state.derived.practices = [{
    key: 'non-owned-practice', label: 'preserve', count: 1, agentIds: [], eventIds: [], stability: 1,
  }];
  state.derived.institutions = [{
    key: 'non-owned-institution', label: 'preserve', evidenceEventIds: [], note: 'preserve',
  }];
  state.derived.milestones = [{
    id: 'incomplete-milestone-sentinel', label: 'preserve', evidenceEventIds: [], note: 'preserve',
  }];

  const prefixTarget = {
    stateHash: 'a'.repeat(64), eventCount: prefix.length, tailEventId: prefix.at(-1).id,
  };
  const finalTarget = {
    stateHash: 'b'.repeat(64), eventCount: events.length, tailEventId: events.at(-1).id,
  };
  const fullProjection = api.projectObserverCivilizationHistoryFromFullHistory(events, finalTarget);
  const prefixProjection = api.projectObserverCivilizationHistoryFromFullHistory(prefix, prefixTarget);
  const encodedPrefix = api.encodeObserverCivilizationHistorySidecar(prefixProjection);
  const decodedPrefix = api.decodeObserverCivilizationHistorySidecar(encodedPrefix.chunk, {
    reference: encodedPrefix.reference, boundary: { target: prefixTarget },
  });
  const encodedFull = api.encodeObserverCivilizationHistorySidecar(fullProjection);
  const decodedFull = api.decodeObserverCivilizationHistorySidecar(encodedFull.chunk, {
    reference: encodedFull.reference, boundary: { target: finalTarget },
  });

  const fullBefore = observerSnapshot(state);
  const fullMaterialization = api.materializeDecodedBoundedObserverCivilization(
    state,
    decodedFull,
    finalTarget,
  );
  assert.deepEqual(observerSnapshot(state), fullBefore,
    'incomplete civilization observer must preserve every state field');

  const boundedState = structuredClone(state);
  boundedState.world.past = structuredClone(suffix);
  boundedState.world.historyCursor = {
    version: 1,
    eventCount: events.length,
    hotStartIndex: prefix.length,
    tailEventId: events.at(-1).id,
  };
  boundedState.world.physicalStructureIndex = api.rematerializePhysicalStructureIndex(
    boundedState,
    boundedState.world.physicalStructureIndex,
  );
  boundedState.derived.structures = structuredClone(boundedState.world.physicalStructureIndex.structures);
  const boundedBefore = observerSnapshot(boundedState);
  const suppliedSuffix = structuredClone(suffix);
  const advanced = api.advanceBoundedObserverCivilization(
    boundedState,
    decodedPrefix,
    prefixTarget,
    finalTarget,
    suppliedSuffix,
  );

  assert.deepEqual(advanced.projection, fullProjection,
    'full history and bounded prefix+exact suffix must produce the same cumulative sidecar');
  assert.deepEqual(advanced.materialization, fullMaterialization,
    'full and resumed paths must expose equivalent declared materialization status');
  assert.deepEqual(observerSnapshot(boundedState), boundedBefore,
    'bounded materialization must preserve owned-incomplete and non-owned derived fields');
  assert.deepEqual(advanced.materialization.materializedFields, []);
  assert.deepEqual(advanced.materialization.preservedFields, [
    'civilization.civilizationIndex', 'civilization.stage',
    'civilization.development', 'derived.milestones',
  ]);
  assert.ok(advanced.materialization.fieldStatus.every((item) => item.status === 'incomplete-preserved'));
  assert.equal(advanced.materialization.gameplayEraSchedulePreserved, true);
  assert.equal(advanced.continuationReady, false);
  assert.deepEqual(
    advanced.materialization.projectionGaps,
    api.OBSERVER_CIVILIZATION_HISTORY_CONTINUATION_GAPS,
  );
  assert.equal(advanced.materialization.eventHistory.births, 1);
  assert.equal(advanced.materialization.eventHistory.deaths, 1);
  assert.equal(advanced.materialization.eventHistory.eraTransitions, 1);
  assert.equal(advanced.materialization.eventHistory.agreementOutcomes, 1);

  suppliedSuffix[0].id = 'caller-mutated-after-return';
  assert.equal(advanced.projection.target.tailEventId, finalTarget.tailEventId,
    'caller-owned suffix mutation must not poison the finished projection');

  assert.throws(
    () => api.materializeDecodedBoundedObserverCivilization(boundedState, decodedPrefix, finalTarget),
    /stale projection target/u,
  );

  const targetMismatchState = structuredClone(boundedState);
  const extra = environment('extra-tail', 2, 'resource', {}, 2);
  targetMismatchState.world.past.push(extra);
  targetMismatchState.world.historyCursor.eventCount += 1;
  targetMismatchState.world.historyCursor.tailEventId = extra.id;
  assert.throws(
    () => api.materializeDecodedBoundedObserverCivilization(targetMismatchState, decodedFull, finalTarget),
    /exact target cursor/u,
  );

  const derivedMismatchState = {
    ...boundedState,
    derived: structuredClone(boundedState.derived),
  };
  derivedMismatchState.derived.structures.push({ id: 'forged-structure' });
  assert.throws(
    () => api.materializeDecodedBoundedObserverCivilization(derivedMismatchState, decodedFull, finalTarget),
    /derived structures/u,
  );

  assert.throws(
    () => api.materializeDecodedBoundedObserverCivilization(
      boundedState,
      structuredClone(decodedFull),
      finalTarget,
    ),
    /strict store-selected decoder/u,
    'structurally identical caller objects cannot mint decoded-sidecar authority',
  );
  assert.throws(
    () => api.materializeDecodedBoundedObserverCivilization(
      boundedState,
      encodedFull.sidecar,
      finalTarget,
    ),
    /strict store-selected decoder/u,
    'encoder output is validated data but not store-selected decode authority',
  );

  const mismatchedSuffix = structuredClone(suffix);
  mismatchedSuffix[0].result = 'caller-forged-result';
  assert.throws(
    () => api.advanceBoundedObserverCivilization(
      boundedState,
      decodedPrefix,
      prefixTarget,
      finalTarget,
      mismatchedSuffix,
    ),
    /未绑定到权威热事实/u,
  );

  for (const mutation of ['unknown', 'missing']) {
    const payload = JSON.parse(Buffer.from(encodedFull.chunk.data).toString('utf8'));
    if (mutation === 'unknown') payload.projection.continuationGaps[0] = 'unknown-gap';
    else payload.projection.continuationGaps.pop();
    const bytes = Buffer.from(JSON.stringify(canonical(payload)), 'utf8');
    const hash = api.hashObserverCivilizationHistoryStoredContent(
      api.OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC,
      bytes,
    );
    assert.throws(
      () => api.decodeObserverCivilizationHistorySidecar({
        hash,
        codec: api.OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC,
        rawSize: bytes.byteLength,
        data: bytes,
      }, {
        reference: {
          kind: 'content-hash', codec: api.OBSERVER_CIVILIZATION_HISTORY_SIDECAR_CODEC, hash,
        },
        boundary: { target: finalTarget },
      }),
      /continuationGaps|gap|缺少/u,
      `${mutation} continuation gap must fail closed`,
    );
  }

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1_024 * 1_024,
    'bounded civilization observer fixture RSS must stay below 256 MiB');
  console.log(JSON.stringify({
    result: 'passed',
    prefixEventCount: prefix.length,
    suffixEventCount: suffix.length,
    finalEventCount: events.length,
    exactEventHistory: advanced.materialization.eventHistory,
    materializedFields: advanced.materialization.materializedFields,
    incompleteFields: advanced.materialization.preservedFields,
    projectionGaps: advanced.materialization.projectionGaps.length,
    continuationReady: advanced.continuationReady,
    rssBytes,
  }, null, 2));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
