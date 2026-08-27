import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-grounded-conversation-cache-'));
const bundlePath = path.join(temporaryDirectory, 'grounded-conversation-cache.mjs');

function actionShell(id, atMonth, orderInMonth, who, action, status = 'completed') {
  return {
    id,
    kind: 'action',
    atMonth,
    orderInMonth,
    planningTick: 1,
    orderInTick: orderInMonth,
    actionTick: 1,
    cellId: 0,
    who,
    cause: 'intent',
    action,
    fromCellId: 0,
    toCellId: 0,
    fromZ: 1,
    toZ: 1,
    pathSegment: [0],
    status,
    result: id,
    diff: {},
  };
}

function conversationEvent({
  id,
  atMonth,
  orderInMonth,
  who,
  speakerId,
  listenerId,
  basisKey,
  status = 'completed',
}) {
  return actionShell(id, atMonth, orderInMonth, who, {
    kind: 'communicate',
    content: {
      id: `representation:${id}`,
      kind: 'claim',
      summary: id,
      conversation: {
        version: 'grounded-conversation-v1',
        basisKey,
        topic: 'care',
        turn: 'opening',
        speakerId,
        listenerId,
        sourceFactIds: [`basis-source:${id}`],
      },
    },
    audience: [listenerId],
    channel: 'voice',
  }, status);
}

function conditionEvent(id, atMonth, orderInMonth, who) {
  return {
    id,
    kind: 'environment',
    change: 'condition',
    atMonth,
    orderInMonth,
    cellId: 0,
    who,
    result: id,
    diff: { condition: 'cold', stage: 2 },
  };
}

function memory(id, sourceEventIds) {
  return {
    id,
    kind: 'dialogue',
    summary: id,
    importance: 60,
    createdAtMonth: 19,
    lastRecalledAtMonth: 19,
    personIds: [],
    sourceEventIds,
  };
}

function openingBasis(topic, speakerId, listenerId, sourceFactIds) {
  return [
    'grounded-conversation-v1',
    `topic=${topic}`,
    `speaker=${speakerId}`,
    `listener=${listenerId}`,
    `sources=${sourceFactIds.join(',')}`,
  ].join('|');
}

function expectedRememberedSourceCount(people) {
  return people.reduce((sum, person) => sum + new Set([
    ...person.memories.flatMap((item) => item.sourceEventIds),
    ...person.relations.flatMap((item) => item.sourceEventIds),
  ]).size, 0);
}

try {
  const entry = `
    export {
      buildGroundedConversationOptions,
      createGroundedConversationCompilationDiagnostics,
    } from ${JSON.stringify(path.resolve('src/game/eland/application/conversation-options.ts'))};
    export {
      createRememberedGroundedOpeningBasisSnapshot,
      hasRememberedGroundedConversationOpeningBasis,
      livePersonSocialEvidenceLeaseKey,
      registerPlanningEventOverlay,
      registerRetainedColdWorldEventFacts,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/event-index.ts'))};
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/simulation-runtime.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--loader=ts',
    '--sourcefile=grounded-conversation-cache-entry.ts',
    `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const state = api.createInitialState(20260828, {
    characterIds: ['laozi', 'qinshihuang', 'marie-curie', 'ada-lovelace'],
    endpoint: { kind: 'months', value: 24 },
    chaosIntensity: 0,
  });
  assert.equal(state.people.length, 4);
  const [speaker, listenerA, listenerB, listenerC] = state.people;
  state.clock.elapsedMonths = 20;
  state.projects = [];
  state.agreements = [];
  state.intents = [];
  for (const person of state.people) {
    person.bornAtMonth = -240;
    delete person.diedAtMonth;
    person.body.health = 90;
    person.conditions = [];
    person.inventory = [];
    person.knowledge = [];
    person.knownPlaces = [];
    person.memories = [];
    person.relations = [];
    person.bereavements = [];
    person.geneticParents = [];
    person.position = {
      ...person.position,
      cellId: speaker.position.cellId,
      z: speaker.position.z,
      previousCellId: speaker.position.cellId,
      previousZ: speaker.position.z,
      lastPath: [speaker.position.cellId],
      tickPath: [speaker.position.cellId],
    };
  }

  const conditionSources = [listenerA, listenerB, listenerC]
    .map((listener, index) => conditionEvent(`condition-source-${index + 1}`, 19, index, listener.id));
  for (let index = 0; index < 3; index += 1) {
    const listener = [listenerA, listenerB, listenerC][index];
    listener.conditions.push({
      id: `condition-${index + 1}`,
      kind: 'cold',
      stage: 2,
      sinceMonth: 19,
      sourceEventIds: [conditionSources[index].id],
    });
  }
  const careBasisA = openingBasis('care', speaker.id, listenerA.id, [conditionSources[0].id]);
  const careBasisB = openingBasis('care', speaker.id, listenerB.id, [conditionSources[1].id]);
  const careBasisC = openingBasis('care', speaker.id, listenerC.id, [conditionSources[2].id]);
  const discoveryBasisA = openingBasis('discovery', speaker.id, listenerA.id, [conditionSources[0].id]);

  const basis = {
    foreign: 'matrix:foreign-lease',
    wrongPair: 'matrix:wrong-pair',
    blocked: 'matrix:blocked',
    firstCold: 'matrix:first-cold',
    secondCold: 'matrix:second-cold',
    shadowCold: 'matrix:shadow-cold',
    shadowHot: 'matrix:shadow-hot',
    overlayShadowHot: 'matrix:overlay-shadow-hot',
    overlayShadow: 'matrix:overlay-shadow',
    overlayOnly: 'matrix:overlay-only',
  };
  const coldEntries = [
    {
      event: conversationEvent({
        id: 'cold-listener-b-care', atMonth: 16, orderInMonth: 0, who: speaker.id,
        speakerId: speaker.id, listenerId: listenerB.id, basisKey: careBasisB,
      }),
      leaseKeys: [api.livePersonSocialEvidenceLeaseKey(listenerB.id)],
    },
    {
      event: conversationEvent({
        id: 'foreign-opening', atMonth: 16, orderInMonth: 1, who: speaker.id,
        speakerId: speaker.id, listenerId: listenerA.id, basisKey: basis.foreign,
      }),
      leaseKeys: [api.livePersonSocialEvidenceLeaseKey('foreign-owner')],
    },
    {
      event: conversationEvent({
        id: 'wrong-pair-opening', atMonth: 16, orderInMonth: 2, who: listenerA.id,
        speakerId: listenerA.id, listenerId: speaker.id, basisKey: basis.wrongPair,
      }),
      leaseKeys: [api.livePersonSocialEvidenceLeaseKey(speaker.id)],
    },
    {
      event: conversationEvent({
        id: 'blocked-opening', atMonth: 16, orderInMonth: 3, who: speaker.id,
        speakerId: speaker.id, listenerId: listenerA.id, basisKey: basis.blocked, status: 'blocked',
      }),
      leaseKeys: [api.livePersonSocialEvidenceLeaseKey(speaker.id)],
    },
    {
      event: conversationEvent({
        id: 'cold-first-wins', atMonth: 16, orderInMonth: 4, who: speaker.id,
        speakerId: speaker.id, listenerId: listenerA.id, basisKey: basis.firstCold,
      }),
      leaseKeys: [api.livePersonSocialEvidenceLeaseKey(speaker.id)],
    },
    {
      event: conversationEvent({
        id: 'cold-first-wins', atMonth: 16, orderInMonth: 5, who: speaker.id,
        speakerId: speaker.id, listenerId: listenerA.id, basisKey: basis.secondCold,
      }),
      leaseKeys: [api.livePersonSocialEvidenceLeaseKey(speaker.id)],
    },
    {
      event: conversationEvent({
        id: 'hot-cold-shadow', atMonth: 16, orderInMonth: 6, who: speaker.id,
        speakerId: speaker.id, listenerId: listenerA.id, basisKey: basis.shadowCold,
      }),
      leaseKeys: [api.livePersonSocialEvidenceLeaseKey(speaker.id)],
    },
  ];
  const hotCareA = conversationEvent({
    id: 'hot-listener-a-care', atMonth: 18, orderInMonth: 3, who: speaker.id,
    speakerId: speaker.id, listenerId: listenerA.id, basisKey: careBasisA,
  });
  const hotShadow = conversationEvent({
    id: 'hot-cold-shadow', atMonth: 18, orderInMonth: 4, who: speaker.id,
    speakerId: speaker.id, listenerId: listenerA.id, basisKey: basis.shadowHot,
  });
  const hotOverlayShadow = conversationEvent({
    id: 'overlay-shadow-id', atMonth: 18, orderInMonth: 5, who: speaker.id,
    speakerId: speaker.id, listenerId: listenerA.id, basisKey: basis.overlayShadowHot,
  });
  const hotEvents = [...conditionSources, hotCareA, hotShadow, hotOverlayShadow];
  state.world.past = hotEvents;
  state.world.historyCursor = {
    version: 1,
    eventCount: coldEntries.length + hotEvents.length,
    hotStartIndex: coldEntries.length,
    tailEventId: hotEvents.at(-1).id,
  };
  api.registerRetainedColdWorldEventFacts(state, coldEntries.map((entry, absoluteIndex) => ({
    absoluteIndex,
    eventId: entry.event.id,
    event: entry.event,
    leaseKeys: entry.leaseKeys,
  })));

  const overlayOnly = conversationEvent({
    id: 'overlay-only-opening', atMonth: 20, orderInMonth: 0, who: speaker.id,
    speakerId: speaker.id, listenerId: listenerA.id, basisKey: basis.overlayOnly,
  });
  const overlayShadow = conversationEvent({
    id: hotOverlayShadow.id, atMonth: 20, orderInMonth: 1, who: speaker.id,
    speakerId: speaker.id, listenerId: listenerA.id, basisKey: basis.overlayShadow,
  });
  const baseOverlay = [overlayOnly, overlayShadow];
  api.registerPlanningEventOverlay(state, baseOverlay);

  speaker.memories = [memory('speaker-social-sources', [
    hotCareA.id,
    'foreign-opening',
    'wrong-pair-opening',
    'blocked-opening',
    'cold-first-wins',
    hotShadow.id,
    hotOverlayShadow.id,
  ])];
  speaker.relations = [{
    personId: listenerA.id,
    trust: 10,
    bond: 10,
    fear: 0,
    sourceEventIds: ['foreign-opening', 'foreign-opening'],
  }];
  listenerB.memories = [memory('listener-b-social-sources', ['cold-listener-b-care'])];
  speaker.knowledge = [{
    id: 'knowledge:shared-observation',
    kind: 'observation',
    summary: '可靠的新观察',
    confidence: 80,
    learnedAtMonth: 19,
    sourceEventIds: [conditionSources[0].id],
  }];
  for (const listener of [listenerB, listenerC]) {
    listener.knowledge = [{
      ...speaker.knowledge[0],
      learnedAtMonth: 20,
      sourceEventIds: [conditionSources[0].id],
    }];
  }

  const directDiagnostics = api.createGroundedConversationCompilationDiagnostics();
  const snapshot = api.createRememberedGroundedOpeningBasisSnapshot(
    state,
    state.people,
    directDiagnostics,
  );
  const matrix = [
    [careBasisA, speaker.id, listenerA.id, true],
    [careBasisB, speaker.id, listenerB.id, true],
    [basis.overlayOnly, speaker.id, listenerC.id, true],
    [basis.foreign, speaker.id, listenerA.id, false],
    [basis.wrongPair, speaker.id, listenerA.id, false],
    [basis.wrongPair, listenerA.id, speaker.id, true],
    [basis.blocked, speaker.id, listenerA.id, false],
    [basis.firstCold, speaker.id, listenerA.id, true],
    [basis.secondCold, speaker.id, listenerA.id, false],
    [basis.shadowHot, speaker.id, listenerA.id, true],
    [basis.shadowCold, speaker.id, listenerA.id, false],
    [basis.overlayShadow, speaker.id, listenerA.id, true],
    [basis.overlayShadowHot, speaker.id, listenerA.id, false],
    ['matrix:missing', speaker.id, listenerA.id, false],
    ['matrix:missing-listener-c', listenerC.id, speaker.id, false],
  ];
  for (const [basisKey, speakerId, listenerId, expected] of matrix) {
    const legacy = api.hasRememberedGroundedConversationOpeningBasis(
      state,
      basisKey,
      speakerId,
      listenerId,
    );
    const cached = snapshot.hasOpeningBasis(basisKey, speakerId, listenerId);
    assert.equal(legacy, expected, `legacy matrix mismatch: ${basisKey}`);
    assert.equal(cached, legacy, `snapshot matrix mismatch: ${basisKey}`);
  }
  assert.equal(snapshot.eventForPersonSource(speaker.id, 'foreign-opening'), undefined,
    'foreign exact lease must not leak through the generic retained by-id registry');
  assert.equal(snapshot.eventForPersonSource('foreign-owner', 'foreign-opening'), undefined,
    'a person outside this compilation may not query its lease');
  assert.equal(directDiagnostics.personSourceSnapshots, 4);
  assert.equal(directDiagnostics.exactLeaseIndexes, 4);
  assert.equal(directDiagnostics.sourceResolutions, expectedRememberedSourceCount(state.people));
  assert.equal(
    Object.keys(directDiagnostics.sourceResolutionsByPersonAndId).length,
    directDiagnostics.sourceResolutions,
  );
  assert.ok(Object.values(directDiagnostics.sourceResolutionsByPersonAndId).every((count) => count === 1),
    'each person/source pair must be resolved exactly once');

  const visiblePeople = [listenerA, listenerB, listenerC];
  const cachedDiagnostics = api.createGroundedConversationCompilationDiagnostics();
  const cachedOptions = api.buildGroundedConversationOptions(
    state,
    speaker,
    visiblePeople,
    state.clock.elapsedMonths,
    { diagnostics: cachedDiagnostics },
  );
  const legacyDiagnostics = api.createGroundedConversationCompilationDiagnostics();
  const legacyOptions = api.buildGroundedConversationOptions(
    state,
    speaker,
    visiblePeople,
    state.clock.elapsedMonths,
    { reuseRememberedBasisSnapshot: false, diagnostics: legacyDiagnostics },
  );
  assert.equal(JSON.stringify(cachedOptions), JSON.stringify(legacyOptions),
    'snapshot on/off must preserve options, order, actions, sources and estimates byte-for-byte');
  assert.deepEqual(
    cachedOptions.map((option) => [option.target.personId, option.nextAction.content.conversation.topic]),
    [[listenerA.id, 'discovery'], [listenerC.id, 'care']],
    'the first listener should skip duplicate care before routing; the second is fully duplicate');
  assert.ok(cachedDiagnostics.personSourceSnapshots <= 4);
  assert.equal(cachedDiagnostics.exactLeaseIndexes, cachedDiagnostics.personSourceSnapshots);
  assert.equal(cachedDiagnostics.rendezvousComputations, 2);
  assert.equal(cachedDiagnostics.rendezvousComputationsByPair[JSON.stringify([speaker.id, listenerA.id])], 1);
  assert.equal(cachedDiagnostics.rendezvousComputationsByPair[JSON.stringify([speaker.id, listenerB.id])] ?? 0, 0);
  assert.equal(cachedDiagnostics.rendezvousComputationsByPair[JSON.stringify([speaker.id, listenerC.id])], 1);
  assert.ok(Object.values(cachedDiagnostics.sourceResolutionsByPersonAndId).every((count) => count === 1));

  speaker.memories[0].sourceEventIds = speaker.memories[0].sourceEventIds
    .filter((eventId) => eventId !== hotCareA.id);
  const overlayCareC = conversationEvent({
    id: 'overlay-listener-c-care', atMonth: 20, orderInMonth: 2, who: speaker.id,
    speakerId: speaker.id, listenerId: listenerC.id, basisKey: careBasisC,
  });
  api.registerPlanningEventOverlay(state, [...baseOverlay, overlayCareC]);
  const rebuiltDiagnostics = api.createGroundedConversationCompilationDiagnostics();
  const rebuilt = api.buildGroundedConversationOptions(
    state,
    speaker,
    visiblePeople,
    state.clock.elapsedMonths,
    { diagnostics: rebuiltDiagnostics },
  );
  const rebuiltLegacy = api.buildGroundedConversationOptions(
    state,
    speaker,
    visiblePeople,
    state.clock.elapsedMonths,
    { reuseRememberedBasisSnapshot: false },
  );
  assert.equal(JSON.stringify(rebuilt), JSON.stringify(rebuiltLegacy));
  assert.notEqual(JSON.stringify(rebuilt), JSON.stringify(cachedOptions),
    'a second build must not reuse the first build snapshot after memory/overlay changes');
  assert.deepEqual(
    rebuilt.map((option) => [option.target.personId, option.nextAction.content.conversation.topic]),
    [[listenerA.id, 'care'], [listenerA.id, 'discovery']],
  );
  assert.ok(rebuiltDiagnostics.personSourceSnapshots <= 4);
  assert.equal(rebuiltDiagnostics.rendezvousComputations, 1,
    'multiple nonduplicate topics for one pair must share one rendezvous result');

  const overlayCareA = conversationEvent({
    id: 'overlay-listener-a-care', atMonth: 20, orderInMonth: 3, who: speaker.id,
    speakerId: speaker.id, listenerId: listenerA.id, basisKey: careBasisA,
  });
  const overlayDiscoveryA = conversationEvent({
    id: 'overlay-listener-a-discovery', atMonth: 20, orderInMonth: 4, who: speaker.id,
    speakerId: speaker.id, listenerId: listenerA.id, basisKey: discoveryBasisA,
  });
  api.registerPlanningEventOverlay(state, [
    ...baseOverlay,
    overlayCareC,
    overlayCareA,
    overlayDiscoveryA,
  ]);
  const allDuplicateDiagnostics = api.createGroundedConversationCompilationDiagnostics();
  const allDuplicate = api.buildGroundedConversationOptions(
    state,
    speaker,
    visiblePeople,
    state.clock.elapsedMonths,
    { diagnostics: allDuplicateDiagnostics },
  );
  assert.deepEqual(allDuplicate, []);
  assert.equal(allDuplicateDiagnostics.rendezvousComputations, 0,
    'an all-duplicate compilation must perform no path search');
  assert.ok(allDuplicateDiagnostics.personSourceSnapshots <= 4);
  assert.ok(allDuplicateDiagnostics.rendezvousComputations <= 3);

  process.stdout.write('grounded conversation compile cache tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
