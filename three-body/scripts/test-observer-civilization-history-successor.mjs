import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = await mkdtemp(
  path.join(tmpdir(), 'eland-civilization-successor-'),
);

function base(id, atMonth, orderInMonth = 0) {
  return {
    id,
    atMonth,
    orderInMonth,
    planningTick: 1,
    orderInTick: orderInMonth,
    cellId: 0,
  };
}

function environment(id, atMonth, change, diff = {}, orderInMonth = 0) {
  return {
    ...base(id, atMonth, orderInMonth),
    kind: 'environment',
    change,
    result: id,
    diff,
  };
}

function action(id, atMonth, who, primitive, diff = {}, orderInMonth = 0) {
  return {
    ...base(id, atMonth, orderInMonth),
    kind: 'action',
    actionTick: 1,
    who,
    cause: 'intent',
    action: primitive,
    fromCellId: 0,
    toCellId: 0,
    fromZ: 1,
    toZ: 1,
    pathSegment: [],
    status: 'completed',
    result: id,
    diff,
  };
}

function agreement(id, atMonth, change, orderInMonth = 0) {
  return {
    ...base(id, atMonth, orderInMonth),
    kind: 'agreement',
    agreementId: 'fixture-agreement',
    change,
    result: id,
    diff: {},
  };
}

function appendCommitted(state, events) {
  state.world.past.push(...events);
  state.world.historyCursor.eventCount += events.length;
  state.world.historyCursor.tailEventId = events.at(-1)?.id
    ?? state.world.historyCursor.tailEventId;
  state.lastStep = structuredClone(events);
  state.clock.elapsedMonths = Math.max(
    state.clock.elapsedMonths,
    ...events.map((event) => event.atMonth),
  );
}

function fourObserverFields(state) {
  return structuredClone({
    civilizationIndex: state.civilization.civilizationIndex,
    stage: state.civilization.stage,
    development: state.civilization.development,
    milestones: state.derived.milestones,
  });
}

try {
  const entry = path.join(temporaryDirectory, 'entry.ts');
  await writeFile(entry, [
    `export * from ${JSON.stringify(path.join(workspace, 'server/observer-civilization-history-successor.ts'))};`,
    `export * from ${JSON.stringify(path.join(workspace, 'server/observer-civilization-history-projection.ts'))};`,
    `export * from ${JSON.stringify(path.join(workspace, 'server/civilization-history-codec.ts'))};`,
    `export { encodeSegmentedRunState, decodeSegmentedRunStateBounded } from ${JSON.stringify(path.join(workspace, 'server/run-state-codec.ts'))};`,
    `export { createInitialState } from ${JSON.stringify(path.join(workspace, 'src/game/eland/simulation.ts'))};`,
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

  const prefixState = api.createInitialState(22_817, {
    endpoint: { kind: 'months', value: 120 },
  });
  const actor = prefixState.people[0].id;
  const listener = prefixState.people[1].id;
  const prefixSuffix = [
    action('civilization-prefix-teach', 1, actor, {
      kind: 'communicate',
      channel: 'voice',
      audience: [listener],
      content: {
        id: 'civilization-prefix-claim',
        kind: 'claim',
        factId: 'fixture:fire-practice',
        text: '共享用火经验',
      },
    }, {}, 0),
    action('civilization-prefix-process', 1, actor, {
      kind: 'act', operation: 'combine', targets: [],
    }, { outputMaterialId: 9 }, 1),
  ];
  appendCommitted(prefixState, prefixSuffix);

  const chunks = new Map();
  const retain = (encoded) => {
    for (const chunk of [...encoded.parts, encoded.root]) chunks.set(chunk.hash, chunk);
    return encoded;
  };
  const readChunk = (hash) => {
    const chunk = chunks.get(hash);
    if (!chunk) throw new Error(`fixture missing chunk ${hash}`);
    return chunk;
  };

  const prefixEncoded = retain(await api.encodeSegmentedRunState(
    prefixState,
    { mode: 'replace' },
    { maxEventsPerSegmentForTests: 2 },
  ));
  assert.ok(prefixEncoded.metadata.schemaVersion === 2
    || prefixEncoded.metadata.schemaVersion === 3);

  const nextFullState = structuredClone(prefixState);
  const exactSuffix = [
    environment('civilization-successor-birth', 2, 'birth', {
      bornPersonId: 'fixture-child',
    }, 0),
    agreement('civilization-successor-agreement', 2, 'fulfilled', 1),
    environment('civilization-successor-era', 2, 'climate', {
      eraTransition: true,
      epoch: 'chaotic',
    }, 2),
  ];
  appendCommitted(nextFullState, exactSuffix);
  nextFullState.civilization.civilizationIndex = {
    ...structuredClone(nextFullState.civilization.civilizationIndex),
    total: 731,
    calculatedAtMonth: 2,
  };
  nextFullState.civilization.stage = 'successor-preserved-stage';
  nextFullState.civilization.development = {
    observerVersion: 'material-institution-era-v6',
    currentEra: 'ancient-civilization',
    historicalPeakEra: 'ancient-civilization',
    candidateEra: 'ancient-civilization',
    candidateSinceMonth: 2,
    transitionProgress: 0.75,
    satisfiedGateIds: ['fixture-gate'],
    missingGateIds: [],
    supportingEventIds: [],
    materialCapabilities: [],
    fixtureMarker: 'must-survive-successor-fold',
  };
  nextFullState.derived.milestones = [{
    id: 'fixture-preserved-milestone',
    label: 'must survive successor fold',
    evidenceEventIds: [],
  }];

  const nextEncoded = retain(await api.encodeSegmentedRunState(
    nextFullState,
    { mode: 'append', previous: prefixEncoded.metadata },
    { maxEventsPerSegmentForTests: 2 },
  ));
  assert.ok(nextEncoded.metadata.schemaVersion === 2
    || nextEncoded.metadata.schemaVersion === 3);

  const bounded = await api.decodeSegmentedRunStateBounded(
    nextEncoded.root,
    readChunk,
    { hotEventLimit: exactSuffix.length },
  );
  assert.equal(bounded.state.world.historyCursor.hotStartIndex, prefixState.world.past.length);
  assert.deepEqual(
    bounded.state.world.past.map((event) => event.id),
    exactSuffix.map((event) => event.id),
    'fixture next state 必须只保留 exact hot suffix',
  );

  const prefixTarget = {
    stateHash: prefixEncoded.root.hash,
    eventCount: prefixEncoded.metadata.eventCount,
    tailEventId: prefixState.world.historyCursor.tailEventId,
  };
  const nextTarget = {
    stateHash: nextEncoded.root.hash,
    eventCount: nextEncoded.metadata.eventCount,
    tailEventId: nextFullState.world.historyCursor.tailEventId,
  };
  const prefixProjection = api.projectObserverCivilizationHistoryFromFullHistory(
    prefixState.world.past,
    prefixTarget,
  );
  const encodedPrefixSidecar = api.encodeObserverCivilizationHistorySidecar(prefixProjection);
  const decodedPrefixSidecar = api.decodeObserverCivilizationHistorySidecar(
    encodedPrefixSidecar.chunk,
    {
      reference: encodedPrefixSidecar.reference,
      boundary: { target: prefixTarget },
    },
  );
  const fullOracle = api.projectObserverCivilizationHistoryFromFullHistory(
    nextFullState.world.past,
    nextTarget,
  );

  const ownedFieldsBefore = fourObserverFields(bounded.state);
  const successor = await api.projectObserverCivilizationHistoryFromVerifiedSuccessor({
    previous: decodedPrefixSidecar,
    previousRevision: 41,
    previousRootChunk: prefixEncoded.root,
    nextRevision: 42,
    nextRootChunk: nextEncoded.root,
    nextState: bounded.state,
    readChunk,
  });

  api.assertVerifiedObserverCivilizationHistorySuccessor(successor);
  assert.deepEqual(
    successor.encoded.sidecar.projection,
    fullOracle,
    'exact-root incremental fold 必须等于 full-history projection oracle',
  );
  assert.deepEqual(fourObserverFields(bounded.state), ownedFieldsBefore,
    'successor fold 不得改写四个 observer-owned shell 字段');
  assert.equal(successor.suffixEventCount, exactSuffix.length);
  assert.equal(successor.persisted, false);
  assert.equal(successor.continuationReady, false);
  assert.deepEqual(
    successor.encoded.sidecar.projection.continuationGaps,
    api.OBSERVER_CIVILIZATION_HISTORY_CONTINUATION_GAPS,
  );

  await assert.rejects(
    api.projectObserverCivilizationHistoryFromVerifiedSuccessor({
      previous: structuredClone(decodedPrefixSidecar),
      previousRevision: 41,
      previousRootChunk: prefixEncoded.root,
      nextRevision: 42,
      nextRootChunk: nextEncoded.root,
      nextState: bounded.state,
      readChunk,
    }),
    /strict store-selected decoder/u,
    '结构相同的 caller previous 不得伪造 strict-decoded provenance',
  );

  await assert.rejects(
    api.projectObserverCivilizationHistoryFromVerifiedSuccessor({
      previous: decodedPrefixSidecar,
      previousRevision: 41,
      previousRootChunk: nextEncoded.root,
      nextRevision: 42,
      nextRootChunk: nextEncoded.root,
      nextState: bounded.state,
      readChunk,
    }),
    /previous sidecar target.*previous root/u,
    '错 previous root 必须在 streaming 前 fail closed',
  );

  await assert.rejects(
    api.projectObserverCivilizationHistoryFromVerifiedSuccessor({
      previous: decodedPrefixSidecar,
      previousRevision: 42,
      previousRootChunk: prefixEncoded.root,
      nextRevision: 42,
      nextRootChunk: nextEncoded.root,
      nextState: bounded.state,
      readChunk,
    }),
    /revision 必须严格推进/u,
  );
  assert.throws(
    () => api.assertVerifiedObserverCivilizationHistorySuccessor(
      structuredClone(successor),
    ),
    /module-verified exact-root fold/u,
    '结构复制不得伪造 module-verified successor provenance',
  );

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1_024 * 1_024,
    'civilization successor fixture RSS 必须低于 256 MiB');
  console.log(JSON.stringify({
    result: 'passed',
    previousRevision: successor.previousRevision,
    nextRevision: successor.nextRevision,
    prefixEventCount: prefixTarget.eventCount,
    suffixEventCount: successor.suffixEventCount,
    nextEventCount: successor.nextTarget.eventCount,
    births: successor.encoded.sidecar.projection.eventHistory.births,
    agreementOutcomes: successor.encoded.sidecar.projection.eventHistory.agreementOutcomes,
    eraTransitions: successor.encoded.sidecar.projection.eventHistory.eraTransitions,
    continuationReady: successor.continuationReady,
    projectionGaps: successor.encoded.sidecar.projection.continuationGaps.length,
    rssBytes,
  }, null, 2));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
