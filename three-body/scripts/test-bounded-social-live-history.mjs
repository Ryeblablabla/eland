import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const temp = mkdtempSync(path.join(tmpdir(), 'eland-bounded-social-'));
const entry = path.join(temp, 'entry.ts');
const bundle = path.join(temp, 'bundle.mjs');
const root = path.resolve('src/game/eland');
const conversationPath = path.join(root, 'application/conversation-options.ts');
const socialOptionsPath = path.join(root, 'application/social-options.ts');
const communicationActionsPath = path.join(root, 'domain/actions/communication-actions.ts');
const eventIndexPath = path.join(root, 'domain/event-index.ts');
const socialFactsPath = path.join(root, 'domain/social-facts.ts');
const traitPath = path.join(root, 'domain/trait.ts');
const retentionPath = path.resolve('server/history-retention-projection.ts');
const retentionCodecPath = path.resolve('server/history-retention-codec.ts');

function action(id, atMonth, orderInMonth, who, primitive, diff = {}) {
  return {
    id, kind: 'action', atMonth, orderInMonth, planningTick: 1, orderInTick: orderInMonth,
    cellId: 0, who, cause: 'intent', status: 'completed', result: id,
    action: primitive, diff, fromCellId: 0, toCellId: 0, fromZ: 1, toZ: 1, pathSegment: [0],
  };
}

function environment(id, atMonth, orderInMonth = 0) {
  return { id, kind: 'environment', atMonth, orderInMonth, cellId: 0, change: 'weather', result: id, diff: {} };
}

function conversation(id, atMonth, orderInMonth, speakerId, listenerId, basisKey, turn, referenceEventId) {
  return action(id, atMonth, orderInMonth, speakerId, {
    kind: 'communicate',
    content: {
      id: `representation:${id}`,
      kind: 'claim',
      summary: id,
      conversation: {
        version: 'grounded-conversation-v1', basisKey, topic: 'gratitude', turn,
        speakerId, listenerId, sourceFactIds: ['assist-fulfill-event'],
        ...(referenceEventId ? { referenceEventId, stance: 'supportive' } : {}),
      },
    },
    audience: [listenerId], channel: 'voice',
  });
}

const fulfilledRequest = action('fulfilled-request-event', 8, 0, 'requester', {
  kind: 'communicate', content: {
    id: 'assist-fulfilled', kind: 'request', summary: '请帮我',
    proposal: { kind: 'assist', requesterId: 'requester', helperId: 'helper', need: 'food', expiresAtMonth: 12 },
  }, audience: ['helper'], channel: 'voice',
});
const fulfilledAcceptance = action('fulfilled-accept-event', 9, 0, 'helper', {
  kind: 'communicate', content: { id: 'accept:assist-fulfilled:helper', kind: 'accept', referenceId: 'assist-fulfilled' },
  audience: ['requester'], channel: 'voice',
});
const fulfillment = action('assist-fulfill-event', 10, 0, 'helper', {
  kind: 'transfer', materialId: 10, quantity: 1,
  from: { kind: 'person', personId: 'helper' },
  to: { kind: 'person', personId: 'requester' },
  stackId: 'food-stack', authorizationRef: 'assist-fulfilled',
}, { quantity: 1 });
const activeRequest = action('active-request-event', 14, 0, 'requester', {
  kind: 'communicate', content: {
    id: 'assist-active', kind: 'request', summary: '请带我找水',
    proposal: { kind: 'assist', requesterId: 'requester', helperId: 'helper', need: 'water', expiresAtMonth: 24 },
  }, audience: ['helper'], channel: 'voice',
});
const activeAcceptance = action('active-accept-event', 15, 0, 'helper', {
  kind: 'communicate', content: { id: 'accept:assist-active:helper', kind: 'accept', referenceId: 'assist-active' },
  audience: ['requester'], channel: 'voice',
});
const answeredOpening = conversation('opening-answered', 17, 0, 'helper', 'requester', 'basis-answered', 'opening');
const answeredResponse = conversation('response-answered', 18, 0, 'requester', 'helper', 'basis-answered', 'response', answeredOpening.id);
const pending = conversation('opening-pending', 18, 1, 'helper', 'requester', 'basis-pending', 'opening');
const oldExpired = conversation('opening-expired', 2, 0, 'helper', 'requester', 'basis-expired', 'opening');
const activeRepresentation = action('active-representation-event', 5, 0, 'helper', {
  kind: 'communicate', content: { id: 'active-representation', kind: 'claim', summary: '仍在进行的表达' },
  audience: ['requester'], channel: 'voice',
});
const intentDecision = { id: 'active-intent-decision', kind: 'decision', atMonth: 4, orderInMonth: 0, cellId: 0, who: 'helper', usedModel: false };
const tail = environment('tail', 20, 99);
const events = [
  oldExpired, intentDecision, activeRepresentation,
  fulfilledRequest, fulfilledAcceptance, fulfillment,
  activeRequest, activeAcceptance,
  answeredOpening, answeredResponse, pending, tail,
];

function person(id) {
  return {
    id, name: id, sex: id === 'helper' ? 'female' : 'male', birthMonth: -360,
    geneticParents: [], diedAtMonth: undefined,
    body: { health: 80, hydration: 70, nutrition: 70 },
    baselineCapacities: { perception: 50, communication: 50, cognition: 50, manipulation: 50, locomotion: 50 },
    traits: [], knowledge: [], inventory: [], conditions: [], bereavements: [],
    relations: id === 'requester' ? [{ personId: 'helper', trust: 8, bond: 3, fear: 0, sourceEventIds: [fulfillment.id] }] : [],
    memories: id === 'requester' ? [{
      id: 'memory-fulfillment', kind: 'episode', summary: 'helper helped', importance: 80,
      createdAtMonth: 10, lastRecalledAtMonth: 20, personIds: ['helper'],
      sourceEventIds: [fulfillment.id, answeredOpening.id, answeredResponse.id, pending.id],
    }] : [],
    position: { cellId: 0, z: 1 },
  };
}

function agreement(id, status, proposal, proposalEventId, responseEventId, extras = {}) {
  return {
    id, status, proposal, proposerId: proposal.requesterId, responderId: proposal.helperId,
    partyIds: [proposal.requesterId, proposal.helperId], requiredResponderIds: [proposal.helperId],
    acceptedByPersonIds: [proposal.requesterId, proposal.helperId], rejectedByPersonIds: [],
    proposedAtMonth: extras.proposedAtMonth ?? 8, acceptByMonth: proposal.expiresAtMonth,
    acceptedAtMonth: extras.acceptedAtMonth ?? 9, dueAtMonth: extras.dueAtMonth ?? 24,
    ...(status === 'fulfilled' ? { resolvedAtMonth: 10 } : {}),
    proposalEventId, responseEventId,
    fulfillmentEventIds: extras.fulfillmentEventIds ?? [],
    fulfilledByPersonIds: extras.fulfilledByPersonIds ?? [],
    coLocatedMonths: 0,
    sourceEventIds: [proposalEventId, responseEventId, ...(extras.fulfillmentEventIds ?? [])],
  };
}

const fulfilledAgreement = agreement('assist-fulfilled', 'fulfilled', {
  kind: 'assist', requesterId: 'requester', helperId: 'helper', need: 'food', expiresAtMonth: 12,
}, fulfilledRequest.id, fulfilledAcceptance.id, {
  fulfillmentEventIds: [fulfillment.id], fulfilledByPersonIds: ['helper'],
});
const activeAgreement = agreement('assist-active', 'active', {
  kind: 'assist', requesterId: 'requester', helperId: 'helper', need: 'water', expiresAtMonth: 24,
}, activeRequest.id, activeAcceptance.id, {
  proposedAtMonth: 14, acceptedAtMonth: 15, dueAtMonth: 24, fulfilledByPersonIds: ['helper'],
});

function emptyGrid() {
  return {
    version: 2, width: 84, depth: 52, levels: 12,
    generator: { version: 'material-world-v2-flat', seed: 1 },
    palette: [], voxels: new Uint16Array(84 * 52 * 12),
  };
}

function stateShell(past = events) {
  const people = [person('requester'), person('helper')];
  return {
    schemaVersion: 17, seed: 1, branchId: 'social-fixture',
    clock: { elapsedMonths: 20, unit: 'month', monthsPerYear: 12 },
    people,
    agreements: [structuredClone(fulfilledAgreement), structuredClone(activeAgreement)],
    intents: [{
      id: 'live-representation-intent', ownerId: 'helper', status: 'active', domain: 'social',
      summary: '仍在进行的表达', createdAtMonth: 4, lastProgressAtMonth: 5, progress: 0.5,
      goal: { kind: 'representation-made', representationId: 'active-representation' },
      nextAction: activeRepresentation.action, sourceDecisionEventId: intentDecision.id,
      sourceFactIds: [], actionEventIds: [activeRepresentation.id], replanCount: 0,
    }],
    projects: [], eraPredictions: [], records: [], collectives: [], permissions: [], containers: [],
    world: {
      grid: emptyGrid(), drops: [], animals: [], remains: [], memorials: [], traffic: {},
      mechanicalPower: { sources: [], networks: [] }, past: [...past],
      historyCursor: {
        version: 1, eventCount: events.length,
        hotStartIndex: events.length - past.length, tailEventId: tail.id,
      },
    },
  };
}

try {
  const exportsByPath = new Map([
    [conversationPath, '\nexport { gratitudeEvent as __testGratitudeEvent, pendingOpening as __testPendingOpening };\n'],
    [socialOptionsPath, '\nexport { assistAlreadyPerformedBy as __testAssistAlreadyPerformedBy };\n'],
  ]);
  writeFileSync(entry, [
    `export * from ${JSON.stringify(retentionPath)};`,
    `export { encodeHistoryRetentionSidecar, decodeHistoryRetentionSidecar } from ${JSON.stringify(retentionCodecPath)};`,
    `export { registerRetainedColdWorldEventFacts, groundedConversationWindowLeaseKey, liveAgreementHistoryLeaseKey, liveIntentHistoryLeaseKey, livePersonSocialEvidenceLeaseKey, hasRecentGroundedConversationResponseForListener } from ${JSON.stringify(eventIndexPath)};`,
    `export { communicationById, acceptedAssistFor } from ${JSON.stringify(socialFactsPath)};`,
    `export { executeCommunicate } from ${JSON.stringify(communicationActionsPath)};`,
    `export { maternalFirstTeachingConfidence } from ${JSON.stringify(traitPath)};`,
    `export { __testGratitudeEvent, __testPendingOpening } from ${JSON.stringify(conversationPath)};`,
    `export { __testAssistAlreadyPerformedBy } from ${JSON.stringify(socialOptionsPath)};`,
  ].join('\n'));
  await build({
    entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'esm',
    plugins: [{
      name: 'expose-social-readers',
      setup(buildApi) {
        buildApi.onLoad({ filter: /(?:conversation-options|social-options)\.ts$/ }, (args) => {
          const suffix = exportsByPath.get(path.resolve(args.path));
          if (!suffix) return null;
          return { contents: `${readFileSync(args.path, 'utf8')}${suffix}`, loader: 'ts', resolveDir: path.dirname(args.path) };
        });
      },
    }],
  });
  const api = await import(`${pathToFileURL(bundle).href}?v=${Date.now()}`);

  const shell = stateShell([tail]);
  const fold = api.beginHistoryRetentionProjection(shell, { stateHash: 'a'.repeat(64) });
  api.foldHistoryRetentionSegment(fold, events, 0);
  const projection = api.finishHistoryRetentionProjection(fold);
  assert.equal(projection.demandGroups.some((group) => group.blocking), false);
  const pinFor = (eventId) => projection.pins.find((pin) => pin.eventId === eventId);
  assert.ok(pinFor(fulfillment.id)?.leaseKeys.includes(api.livePersonSocialEvidenceLeaseKey('requester')));
  assert.ok(pinFor(activeRepresentation.id)?.leaseKeys.includes(api.liveIntentHistoryLeaseKey('live-representation-intent')));
  assert.ok(pinFor(pending.id)?.leaseKeys.includes(api.groundedConversationWindowLeaseKey('requester', 18)));
  assert.equal(pinFor(oldExpired.id), undefined, '六个月窗外且无当前来源的旧开场不应被保留');

  const responseSourceState = stateShell();
  responseSourceState.agreements = [];
  responseSourceState.intents = [];
  for (const candidate of responseSourceState.people) {
    candidate.memories = [];
    candidate.relations = [];
    candidate.conditions = [];
  }
  const responseSourceFold = api.beginHistoryRetentionProjection(
    responseSourceState,
    { stateHash: 'c'.repeat(64) },
  );
  api.foldHistoryRetentionSegment(responseSourceFold, events, 0);
  const responseSourceProjection = api.finishHistoryRetentionProjection(responseSourceFold);
  const responseLease = api.groundedConversationResponseSourceLeaseKey('requester', pending.id);
  const responseSourcePin = responseSourceProjection.pins.find((pin) => pin.eventId === fulfillment.id);
  assert.ok(
    responseSourcePin?.leaseKeys.includes(responseLease),
    '尚可回应的 grounded opening 必须租住其嵌套事实来源，即使 condition/memory 已释放',
  );

  const responseDecision = {
    id: 'response-intent-decision', kind: 'decision', atMonth: 21, orderInMonth: 0,
    cellId: 0, who: 'requester', usedModel: false,
  };
  const liveResponseState = structuredClone(responseSourceState);
  liveResponseState.clock.elapsedMonths = 21;
  liveResponseState.world.past = [...events, responseDecision];
  liveResponseState.world.historyCursor = {
    version: 1,
    eventCount: events.length + 1,
    hotStartIndex: 0,
    tailEventId: responseDecision.id,
  };
  const openingConversation = pending.action.content.conversation;
  const responseConversation = {
    ...openingConversation,
    turn: 'response',
    speakerId: 'requester',
    listenerId: 'helper',
    referenceEventId: pending.id,
    stance: 'supportive',
  };
  liveResponseState.intents = [{
    id: 'live-required-response', ownerId: 'requester', status: 'active', domain: 'social',
    summary: '回应仍在窗口内的开场', createdAtMonth: 21, lastProgressAtMonth: 21, progress: 0,
    goal: { kind: 'representation-made', representationId: 'respond-pending' },
    nextAction: {
      kind: 'communicate',
      content: {
        id: 'respond-pending', kind: 'claim', summary: '回应', conversation: responseConversation,
      },
      audience: ['helper'], channel: 'voice',
    },
    sourceDecisionEventId: responseDecision.id,
    sourceFactIds: [pending.id, fulfillment.id],
    actionEventIds: [], replanCount: 0,
  }];
  const liveResponseFold = api.resumeHistoryRetentionProjection(
    responseSourceProjection,
    liveResponseState,
    { stateHash: 'd'.repeat(64) },
  );
  api.foldHistoryRetentionSegment(liveResponseFold, [responseDecision], events.length);
  const liveResponseProjection = api.finishHistoryRetentionProjection(liveResponseFold);
  assert.ok(
    liveResponseProjection.pins.find((pin) => pin.eventId === fulfillment.id)
      ?.leaseKeys.includes(responseLease),
    '跨 checkpoint 新建 required-response intent 时必须继承 opening 的旧来源 ordinal',
  );

  const lateResponseTail = environment('late-response-tail', 26, 0);
  const lateLiveResponseState = structuredClone(liveResponseState);
  lateLiveResponseState.clock.elapsedMonths = 26;
  lateLiveResponseState.world.past = [...events, responseDecision, lateResponseTail];
  lateLiveResponseState.world.historyCursor = {
    version: 1,
    eventCount: events.length + 2,
    hotStartIndex: 0,
    tailEventId: lateResponseTail.id,
  };
  const lateLiveResponseFold = api.resumeHistoryRetentionProjection(
    liveResponseProjection,
    lateLiveResponseState,
    { stateHash: 'e'.repeat(64) },
  );
  api.foldHistoryRetentionSegment(
    lateLiveResponseFold,
    [lateResponseTail],
    events.length + 1,
  );
  const lateLiveResponseProjection = api.finishHistoryRetentionProjection(lateLiveResponseFold);
  assert.ok(
    lateLiveResponseProjection.pins.find((pin) => pin.eventId === fulfillment.id)
      ?.leaseKeys.includes(responseLease),
    'opening 离开六个月窗口后，在途 response intent 仍必须持有嵌套来源',
  );

  const expiredTail = environment('expired-response-tail', 27, 0);
  const expiredResponseState = structuredClone(lateLiveResponseState);
  expiredResponseState.clock.elapsedMonths = 27;
  expiredResponseState.intents = [];
  expiredResponseState.world.past = [
    ...events,
    responseDecision,
    lateResponseTail,
    expiredTail,
  ];
  expiredResponseState.world.historyCursor = {
    version: 1,
    eventCount: events.length + 3,
    hotStartIndex: 0,
    tailEventId: expiredTail.id,
  };
  const expiredResponseFold = api.resumeHistoryRetentionProjection(
    lateLiveResponseProjection,
    expiredResponseState,
    { stateHash: 'f'.repeat(64) },
  );
  api.foldHistoryRetentionSegment(
    expiredResponseFold,
    [expiredTail],
    events.length + 2,
  );
  const expiredResponseProjection = api.finishHistoryRetentionProjection(expiredResponseFold);
  assert.equal(
    expiredResponseProjection.pins.some((pin) => pin.leaseKeys.includes(responseLease)),
    false,
    '回应窗口过期且无在途 response intent 后必须释放嵌套来源租约',
  );

  const full = stateShell();
  const bounded = stateShell([tail]);
  const hotStartIndex = bounded.world.historyCursor.hotStartIndex;
  api.registerRetainedColdWorldEventFacts(bounded, projection.pins
    .filter((pin) => pin.absoluteIndex < hotStartIndex)
    .map((pin) => ({ ...pin, event: events[pin.absoluteIndex] })));

  assert.equal(api.__testGratitudeEvent(full, full.people[0], full.people[1])?.id, fulfillment.id);
  assert.equal(api.__testGratitudeEvent(bounded, bounded.people[0], bounded.people[1])?.id, fulfillment.id,
    'gratitude 必须由当前记忆/关系的精确来源在 full/bounded 中一致解析');
  const fullAccepted = api.acceptedAssistFor(full, 'helper', 20);
  const boundedAccepted = api.acceptedAssistFor(bounded, 'helper', 20);
  assert.deepEqual(
    [fullAccepted?.request.id, fullAccepted?.acceptance.id],
    [boundedAccepted?.request.id, boundedAccepted?.acceptance.id],
    'live agreement proposal/acceptance 必须走同一精确 lease',
  );
  assert.equal(api.__testAssistAlreadyPerformedBy(full, 'assist-active', 'helper'), true);
  assert.equal(api.__testAssistAlreadyPerformedBy(bounded, 'assist-active', 'helper'), true,
    'accepted assist 的 alreadyHelped 必须来自 agreement shell scalar');
  assert.equal(api.__testPendingOpening(full, full.people[0], 20)?.id, pending.id);
  assert.equal(api.__testPendingOpening(bounded, bounded.people[0], 20)?.id, pending.id,
    'pending opening 与 response 去重必须在六个月窗口 full/bounded 一致');
  assert.equal(api.hasRecentGroundedConversationResponseForListener(full, 'requester', answeredOpening.id), true);
  assert.equal(api.hasRecentGroundedConversationResponseForListener(bounded, 'requester', answeredOpening.id), true);
  assert.equal(api.communicationById(full, 'active-representation')?.id, activeRepresentation.id);
  assert.equal(api.communicationById(bounded, 'active-representation')?.id, activeRepresentation.id,
    'active intent representation 必须从 intent action lease 精确恢复');

  const wrongLease = stateShell([tail]);
  const rewrittenPins = projection.pins
    .filter((pin) => pin.absoluteIndex < hotStartIndex)
    .map((pin) => {
      const forbidden = new Set([
        ...([activeRequest.id, activeAcceptance.id].includes(pin.eventId)
          ? [api.liveAgreementHistoryLeaseKey('assist-active')]
          : []),
        ...(pin.eventId === activeRepresentation.id ? [api.liveIntentHistoryLeaseKey('live-representation-intent')] : []),
        ...(pin.eventId === pending.id ? [api.groundedConversationWindowLeaseKey('requester', 18)] : []),
        ...(pin.eventId === fulfillment.id ? [api.livePersonSocialEvidenceLeaseKey('requester')] : []),
      ]);
      const leaseKeys = pin.leaseKeys.filter((leaseKey) => !forbidden.has(leaseKey));
      return { ...pin, event: events[pin.absoluteIndex], leaseKeys: leaseKeys.length ? leaseKeys : ['unrelated:cold-pin'] };
    });
  rewrittenPins.push({
    absoluteIndex: 0, eventId: oldExpired.id, event: oldExpired,
    leaseKeys: [api.groundedConversationWindowLeaseKey('requester', 2)],
  });
  api.registerRetainedColdWorldEventFacts(wrongLease, rewrittenPins);
  assert.equal(api.acceptedAssistFor(wrongLease, 'helper', 20), null,
    'live agreement 缺少自己的精确 lease 时必须 fail-closed');
  assert.equal(api.communicationById(wrongLease, 'active-representation'), undefined,
    '同一事件被任意 cold lease 保留时不得满足 live intent goal');
  assert.equal(api.__testGratitudeEvent(wrongLease, wrongLease.people[0], wrongLease.people[1]), undefined,
    'gratitude 缺少本人 social lease 必须 fail-closed');
  assert.equal(api.__testPendingOpening(wrongLease, wrongLease.people[0], 20), undefined,
    'pending opening 缺少窗口 lease 必须 fail-closed，过期窗口事实也不能补位');

  const rememberedBasis = stateShell([tail]);
  rememberedBasis.people[0].memories[0].sourceEventIds.push('missing-personal-source');
  const missingFold = api.beginHistoryRetentionProjection(rememberedBasis, { stateHash: 'b'.repeat(64) });
  api.foldHistoryRetentionSegment(missingFold, events, 0);
  const missingProjection = api.finishHistoryRetentionProjection(missingFold);
  assert.ok(missingProjection.demandGroups.some((group) => group.blocking
    && group.unresolvedEventIds.includes('missing-personal-source')),
  '当前人物来源缺失必须成为显式阻断 demand');

  const techniqueState = stateShell([tail]);
  techniqueState.projects.push({
    id: 'inquiry-1', status: 'active', kind: 'inquiry', ownerId: 'helper',
    desiredFunction: 'learn-work', triggerFactIds: [], actionEventIds: [], completionEventIds: [],
    reservations: [], techniqueDemonstrationRequests: [{
      version: 'project-technique-demonstration-request-v1', requestEventId: 'old-request',
      projectId: 'inquiry-1', requesterId: 'helper', teacherIds: ['requester'],
      desiredFunction: 'learn-work', expiresAtMonth: 24, atMonth: 19,
    }],
  });
  const repeatedTechnique = await api.executeCommunicate(techniqueState, techniqueState.people[1], {
    kind: 'communicate', content: {
      id: 'request-demo', kind: 'request', summary: '请示范',
      techniqueDemonstration: {
        version: 'project-technique-demonstration-request-v1', projectId: 'inquiry-1',
        requesterId: 'helper', desiredFunction: 'learn-work', expiresAtMonth: 24,
      },
    }, audience: ['requester'], channel: 'gesture',
  }, 20, 'request-demo-event');
  assert.equal(repeatedTechnique.status, 'blocked',
    'technique demonstration duplicate 只需项目当前 request state，无需冷全史');

  const mother = person('mother');
  mother.sex = 'female';
  mother.traits = [{ id: 'matrilineal', origin: 'spontaneous', inheritedFromPersonIds: [], sourceEventIds: [] }];
  const child = person('child');
  child.geneticParents = ['mother'];
  child.traits = [{ id: 'matrilineal', origin: 'inherited', inheritedFromPersonIds: ['mother'], sourceEventIds: [] }];
  const untrackedOldTeaching = action('untracked-old-teaching', 1, 0, 'mother', {
    kind: 'communicate', content: { id: 'teach-old', kind: 'claim', summary: '教导', factId: 'technique:x' },
    audience: ['child'], channel: 'voice',
  }, { explicitTeaching: true, teachingFactId: 'technique:x', taughtAudienceIds: ['child'] });
  const historicalTeachingState = stateShell([untrackedOldTeaching, ...events.slice(1)]);
  historicalTeachingState.people = [mother, child];
  assert.equal(api.maternalFirstTeachingConfidence(historicalTeachingState, mother, child), 72,
    '未写入权威 maternal source scalar 的旧历史不得改变首次教导');
  child.maternalTeachingSourceEventIds = ['already-taught'];
  assert.equal(api.maternalFirstTeachingConfidence(historicalTeachingState, mother, child), 60,
    '权威 maternal source scalar 足以阻止再次获得首次教导加成');

  const encoded = api.encodeHistoryRetentionSidecar(projection);
  const decoded = api.decodeHistoryRetentionSidecar(encoded.chunk, {
    reference: encoded.reference,
    boundary: { authority: projection.authority, target: projection.target },
  });
  assert.deepEqual(decoded.pins, projection.pins, 'social selector 必须通过严格 codec round-trip');

  const memoryUsage = process.memoryUsage();
  assert.ok(memoryUsage.rss < 256 * 1024 * 1024, 'bounded social fixture RSS 不得超过 256 MiB');
  console.log(JSON.stringify({
    result: 'passed', eventCount: events.length, pinCount: projection.pins.length,
    selectiveLeaseCount: projection.continuationBasis.selectiveMatches.length,
    rssBytes: memoryUsage.rss,
  }, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
