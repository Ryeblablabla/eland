import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync } from 'node:zlib';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-live-social-retention-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'bundle.mjs');
const dataDirectory = path.join(temporaryDirectory, 'data');

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, canonicalJsonValue(value[key])]));
}

function action(id, atMonth, orderInMonth, who, primitive, diff = {}, status = 'completed') {
  return {
    id, kind: 'action', atMonth, orderInMonth, planningTick: 1,
    orderInTick: orderInMonth, actionTick: 1, cellId: 0, who,
    cause: 'intent', status, result: id, action: primitive, diff,
    fromCellId: 0, toCellId: primitive.kind === 'move' ? primitive.toCellId : 0,
    fromZ: 1, toZ: primitive.kind === 'move' ? primitive.toZ : 1,
    pathSegment: primitive.kind === 'move' ? [0, primitive.toCellId] : [0],
  };
}

function environment(id, atMonth, orderInMonth, change, diff = {}) {
  return {
    id, kind: 'environment', atMonth, orderInMonth, planningTick: 0,
    orderInTick: orderInMonth, cellId: 0, change, result: id, diff,
  };
}

function memory(id, kind, atMonth, personIds, sourceEventIds) {
  return {
    id, kind, summary: id, importance: 80, createdAtMonth: atMonth,
    lastRecalledAtMonth: 30, personIds, sourceEventIds,
  };
}

function reviewDueIntent(person, id, reviewAtMonth, actionEventIds, materialId) {
  return {
    id,
    ownerId: person.id,
    summary: `fixture review ${id}`,
    domain: 'strategic',
    goal: {
      kind: 'inventory-at-least', materialId, quantity: 1_000_000, personId: person.id,
    },
    nextAction: { kind: 'attend', target: { kind: 'person', personId: person.id } },
    status: 'active',
    createdAtMonth: reviewAtMonth - 1,
    lastProgressAtMonth: reviewAtMonth - 1,
    progress: 0.5,
    plannedDurationMonths: 1,
    lifecycle: {
      version: 'intent-lifecycle-v1', completion: 'on-achievement', reviewAtMonth,
    },
    sourceDecisionEventId: actionEventIds[0],
    sourceFactIds: [],
    actionEventIds: [...actionEventIds],
    replanCount: 0,
  };
}

function canonicalProjection(api, state, hash = 'a'.repeat(64)) {
  const fold = api.beginHistoryRetentionProjection(state, { stateHash: hash });
  api.foldHistoryRetentionSegment(fold, state.world.past, 0);
  return api.finishHistoryRetentionProjection(fold);
}

function broadGroupFor(projection, personId) {
  const key = `live-person-social:${encodeURIComponent(personId)}:sources`;
  return projection.demandGroups.find((group) => group.groupKey === key);
}

function strictGroupFor(projection, personId, kind) {
  const key = `live-person-social:${encodeURIComponent(personId)}:strict:${kind}`;
  return projection.demandGroups.find((group) => group.groupKey === key);
}

function recomputeBasisHash(projection) {
  const { basisHash: _discarded, ...basisWithoutHash } = projection.continuationBasis;
  projection.continuationBasis.basisHash = createHash('sha256')
    .update('eland-history-retention-continuation-v1\0')
    .update(JSON.stringify(basisWithoutHash))
    .digest('hex');
}

function rawRetentionSidecar(api, projection) {
  recomputeBasisHash(projection);
  const canonical = Buffer.from(JSON.stringify(canonicalJsonValue(projection)), 'utf8');
  const data = brotliCompressSync(canonical);
  const codec = api.HISTORY_RETENTION_SIDECAR_CODEC;
  const hash = api.hashHistoryRetentionStoredContent(codec, data);
  return {
    projection,
    chunk: { hash, codec, rawSize: data.byteLength, data },
    reference: { kind: 'content-hash', codec, hash },
  };
}

function legacyLiveSocialProjection(api, currentProjection) {
  const legacy = structuredClone(currentProjection);
  const strictGroupKeys = new Set(legacy.demandGroups
    .filter((group) => /:strict:(?:electrical-remote-work|measurement-uncertainty)$/u
      .test(group.groupKey))
    .map((group) => group.groupKey));
  const strictLease = /gameplay:live-person-social:[^:]+:strict:/u;
  const broadGroups = legacy.demandGroups.filter((group) => (
    /^live-person-social:[^:]+:sources$/u.test(group.groupKey)
  ));
  assert.ok(broadGroups.length > 0, 'fixture 必须生成 living owner broad groups');
  for (const group of broadGroups) {
    assert.equal(group.requirement, 'index-only');
    group.requirement = 'all';
  }
  legacy.demandGroups = legacy.demandGroups.filter((group) => !strictGroupKeys.has(group.groupKey));
  legacy.unresolvedDemands = legacy.unresolvedDemands
    .filter((item) => !strictGroupKeys.has(item.groupKey))
    .map((item) => /^live-person-social:[^:]+:sources$/u.test(item.groupKey)
      ? { ...item, requirement: 'all' }
      : item);
  const sourceGroups = legacy.continuationBasis.sourceDemand.groups;
  for (const group of sourceGroups) {
    if (/^live-person-social:[^:]+:sources$/u.test(group.groupKey)) group.requirement = 'all';
  }
  legacy.continuationBasis.sourceDemand.groups = sourceGroups
    .filter((group) => !strictGroupKeys.has(group.groupKey));

  const directById = new Map(legacy.continuationBasis.directMatches
    .map((match) => [match.eventId, match]));
  const pinsByOrdinal = new Map();
  for (const pin of legacy.pins) {
    const leaseKeys = pin.leaseKeys.filter((leaseKey) => !strictLease.test(leaseKey));
    if (leaseKeys.length > 0) pinsByOrdinal.set(pin.absoluteIndex, { ...pin, leaseKeys });
  }
  for (const group of broadGroups) {
    for (const eventId of group.resolvedEventIds) {
      const match = directById.get(eventId);
      assert.ok(match, `legacy broad ${eventId} 必须保留 verified ordinal`);
      const pin = pinsByOrdinal.get(match.absoluteIndex) ?? { ...match, leaseKeys: [] };
      pin.leaseKeys = [...new Set([...pin.leaseKeys, ...group.leaseKeys])].sort();
      pinsByOrdinal.set(match.absoluteIndex, pin);
    }
  }
  legacy.pins = [...pinsByOrdinal.values()]
    .sort((left, right) => left.absoluteIndex - right.absoluteIndex);
  return rawRetentionSidecar(api, legacy);
}

try {
  const conversationPath = path.resolve('src/game/eland/application/conversation-options.ts');
  const socialOptionsPath = path.resolve('src/game/eland/application/social-options.ts');
  const electricalPath = path.resolve('src/game/eland/application/electrical-power-options.ts');
  writeFileSync(entryPath, [
    `export * from ${JSON.stringify(path.resolve('server/sqlite-run-store.ts'))};`,
    `export { stepOwnedBoundedNonProjectionMonth } from ${JSON.stringify(path.resolve('server/bounded-nonprojection-month-controller.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('server/bounded-observer-boundary-month-controller.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('server/history-retention-projection.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('server/history-retention-successor.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('server/history-retention-codec.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('server/run-state-codec.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('server/run-continuation-bundle.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('src/game/eland/domain/event-index.ts'))};`,
    `export * from ${JSON.stringify(path.resolve('src/game/eland/domain/live-social-evidence.ts'))};`,
    `export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/simulation.ts'))};`,
    `export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};`,
    `export { instantiateProject } from ${JSON.stringify(path.resolve('src/game/eland/domain/project.ts'))};`,
    `export { buildRelationshipCausalBasis } from ${JSON.stringify(path.resolve('src/game/eland/domain/relationship-evidence.ts'))};`,
    `export { assessSocialRepetition } from ${JSON.stringify(path.resolve('src/game/eland/domain/social-repetition.ts'))};`,
    `export { personRemembersProjectMaterialDeliveryRestriction } from ${JSON.stringify(path.resolve('src/game/eland/domain/project-material-request.ts'))};`,
    `export { measurementUncertaintyBasisFor } from ${JSON.stringify(path.resolve('src/game/eland/application/measurement-options.ts'))};`,
    `export { __testGratitudeEvent, __testOpeningCandidates } from ${JSON.stringify(conversationPath)};`,
    `export { __testCanRequestCompanyWithCurrentBasis } from ${JSON.stringify(socialOptionsPath)};`,
    `export { __testRemoteWorkEvidence } from ${JSON.stringify(electricalPath)};`,
  ].join('\n'));
  const injected = new Map([
    [conversationPath, `
export { gratitudeEvent as __testGratitudeEvent, openingCandidates as __testOpeningCandidates };
`],
    [socialOptionsPath, `
export { canRequestCompanyWithCurrentBasis as __testCanRequestCompanyWithCurrentBasis };
`],
    [electricalPath, `
export function __testRemoteWorkEvidence(state: SimulationState, person: PersonState) {
  return rememberedActionFacts(state, person)
    .filter((fact) => movedFact(fact)
      || validRemoteWorkFact(fact)
      || fact.action.kind === 'act' && fact.diff.mechanicalPowerOperation === true)
    .map((fact) => ({
      id: fact.id, status: fact.status, action: fact.action, diff: fact.diff,
      atMonth: fact.atMonth, orderInMonth: fact.orderInMonth,
      planningTick: fact.planningTick ?? 0, orderInTick: fact.orderInTick ?? 0,
    }));
}
`],
  ]);
  // Rebuild with source-only test exports. Keeping them outside runtime files
  // prevents a fixture seam from becoming gameplay API.
  const { build } = await import('esbuild');
  await build({
    entryPoints: [entryPath], outfile: bundlePath, bundle: true, platform: 'node', format: 'esm',
    plugins: [{
      name: 'live-social-test-seams',
      setup(buildApi) {
        buildApi.onLoad({ filter: /(?:conversation-options|social-options|electrical-power-options)\.ts$/ }, (args) => {
          const suffix = injected.get(path.resolve(args.path));
          if (!suffix) return null;
          return {
            contents: `${readFileSync(args.path, 'utf8')}\n${suffix}`,
            loader: 'ts', resolveDir: path.dirname(args.path),
          };
        });
      },
    }],
  });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  const state = api.createInitialState(881_301, {
    endpoint: { kind: 'months', value: 12_000 },
  });
  state.clock.elapsedMonths = 30;
  state.projects = [];
  state.agreements = [];
  state.intents = [];
  const [observer, partner] = state.people;
  assert.ok(observer && partner);
  for (const person of state.people) {
    person.memories = [];
    person.conditions = [];
    person.relations = [];
    person.bereavements = [];
    person.maternalTeachingSourceEventIds = [];
  }
  observer.position.cellId = 0;
  observer.position.z = 1;
  partner.position.cellId = 0;
  partner.position.z = 1;

  const relationEvents = Array.from({ length: 26 }, (_, index) => environment(
    `relation-${index + 1}`,
    4 + Math.floor(index / 10),
    index,
    'relationship',
    { participantIds: [observer.id, partner.id], excludedPairKeys: [] },
  ));
  const companyProposal = action('company-proposal', 2, 0, observer.id, {
    kind: 'communicate', channel: 'voice', audience: [partner.id],
    content: {
      id: 'company-proposal-representation', kind: 'request', summary: '陪伴',
      proposal: {
        kind: 'assist', requesterId: observer.id, helperId: partner.id,
        need: 'company', expiresAtMonth: 3,
      },
    },
  });
  const supportEarly = action('support-early', 7, 0, partner.id, {
    kind: 'transfer', materialId: api.Material.Wood, quantity: 1,
    from: { kind: 'person', personId: partner.id },
    to: { kind: 'person', personId: observer.id }, stackId: 'partner-wood',
  }, { quantity: 1 });
  const supportLatest = action('support-latest', 8, 0, partner.id, {
    kind: 'transfer', materialId: api.Material.Clay, quantity: 1,
    from: { kind: 'person', personId: partner.id },
    to: { kind: 'person', personId: observer.id }, stackId: 'partner-clay',
  }, { quantity: 1 });
  const observerCondition = environment('observer-condition', 9, 0, 'condition', {
    personId: observer.id, conditionKind: 'wound', stage: 1,
  });
  const partnerCondition = environment('partner-condition', 9, 1, 'condition', {
    personId: partner.id, conditionKind: 'cold', stage: 1,
  });
  const projectRequest = action('project-request', 9, 2, partner.id, {
    kind: 'communicate', channel: 'voice', audience: [observer.id],
    content: {
      id: 'project-request-representation', kind: 'request', summary: '交付木材',
      projectMaterialContribution: {
        version: 'project-material-contribution-request-v1',
        projectId: 'fixture-project', requesterId: partner.id,
        materialId: api.Material.Wood, quantity: 5,
        site: { cellId: 0, z: 1 }, expiresAtMonth: 60,
      },
    },
  });
  const blockedDelivery = action('blocked-delivery', 10, 0, observer.id, {
    kind: 'transfer', materialId: api.Material.Wood, quantity: 1,
    from: { kind: 'ground', cellId: 0, z: 1 },
    to: { kind: 'person', personId: observer.id },
    dropId: 'restricted-drop',
  }, {
    projectMaterialDeliveryRestricted: true,
    projectId: 'fixture-project', requestEventId: projectRequest.id,
  }, 'blocked');
  const previousConversation = action('previous-conversation', 11, 0, observer.id, {
    kind: 'communicate', channel: 'voice', audience: [partner.id],
    content: {
      id: 'previous-conversation-representation', kind: 'claim', summary: '我的伤还在疼',
      conversation: {
        version: 'grounded-conversation-v1', basisKey: 'condition-basis',
        topic: 'hardship', turn: 'opening', speakerId: observer.id,
        listenerId: partner.id, sourceFactIds: [observerCondition.id],
      },
    },
  }, { groundedConversationBasisKey: 'condition-basis' });
  const woodOne = action('wood-production-1', 12, 0, observer.id, {
    kind: 'act', operation: 'combine', targets: [],
  }, { outputMaterialId: api.Material.Wood, quantity: 1 });
  const woodTwo = action('wood-production-2', 13, 0, observer.id, {
    kind: 'act', operation: 'combine', targets: [],
  }, { outputMaterialId: api.Material.Wood, quantity: 1 });
  const clayOne = action('clay-production-1', 13, 1, observer.id, {
    kind: 'act', operation: 'combine', targets: [],
  }, { outputMaterialId: api.Material.Clay, quantity: 1 });
  const mechanicalService = action('mechanical-service', 14, 0, observer.id, {
    kind: 'act', operation: 'exert', targets: [],
    mechanicalPowerBasis: {
      version: 'mechanical-power-action-basis-v1', mode: 'operate-service',
      sourceSegmentId: 'fixture-source', sourceKeys: [],
      installationProjectId: 'fixture-mechanical-project', planKey: 'fixture-plan',
      networkId: 'fixture-network', operationKnowledgeId: 'fixture-operation',
      inputMaterialId: api.Material.Seed, outputMaterialId: api.Material.Food,
    },
  }, { mechanicalPowerOperation: true });
  const unrelatedMechanicalWork = action('unrelated-mechanical-work', 14, 1, observer.id, {
    kind: 'act', operation: 'exert', targets: [],
    mechanicalPowerBasis: {
      version: 'mechanical-power-action-basis-v1', mode: 'install',
      sourceSegmentId: 'fixture-source', sourceKeys: [],
      installationProjectId: 'fixture-mechanical-project', planKey: 'fixture-plan',
      networkId: 'fixture-network', operationKnowledgeId: 'fixture-operation',
      inputMaterialId: api.Material.Wood, outputMaterialId: api.Material.Stone,
    },
  }, {});
  const travel = action('remote-travel', 15, 0, observer.id, {
    kind: 'move', toCellId: 1, toZ: 1,
  });
  const remoteWork = action('remote-work', 16, 0, observer.id, {
    kind: 'transfer', materialId: api.Material.Stone, quantity: 1,
    from: { kind: 'person', personId: observer.id },
    to: { kind: 'ground', cellId: 1, z: 1 }, stackId: 'remote-stone',
  }, { quantity: 1 });
  const crossOwnerAttend = action('cross-owner-attend', 18, 0, partner.id, {
    kind: 'attend', target: { kind: 'person', personId: observer.id },
  });
  const teaching = environment('maternal-teaching-state-only', 17, 0, 'body', {
    personId: observer.id,
  });
  const fillerEvents = Array.from({ length: 320 }, (_, index) => environment(
    `live-social-filler-${index}`,
    29,
    index,
    'weather',
    { filler: index },
  ));
  const tail = environment('live-social-tail', 30, 0, 'weather', { fixture: true });
  const customEvents = [
    companyProposal, ...relationEvents, supportEarly, supportLatest,
    observerCondition, partnerCondition, projectRequest, blockedDelivery,
    previousConversation, woodOne, woodTwo, clayOne, mechanicalService,
    unrelatedMechanicalWork,
    travel, remoteWork, teaching, crossOwnerAttend, ...fillerEvents, tail,
  ];
  const historyStart = state.world.past.length;
  state.world.past.push(...customEvents);
  state.world.historyCursor = {
    version: 1, eventCount: state.world.past.length, hotStartIndex: 0, tailEventId: tail.id,
  };
  state.lastStep = [tail];

  observer.conditions = [{
    id: 'observer-wound', kind: 'wound', stage: 1, sinceMonth: 9,
    sourceEventIds: [observerCondition.id],
  }];
  partner.conditions = [{
    id: 'partner-cold', kind: 'cold', stage: 1, sinceMonth: 9,
    sourceEventIds: [partnerCondition.id],
  }];
  observer.relations = [{
    personId: partner.id, trust: 8, bond: 4, fear: 0,
    sourceEventIds: relationEvents.slice(0, 25).map((event) => event.id),
  }];
  partner.relations = [{
    personId: observer.id, trust: 7, bond: 3, fear: 0,
    sourceEventIds: [relationEvents[0].id],
  }];
  observer.memories = [
    memory('support-memory', 'episode', 8, [partner.id], [supportEarly.id, supportLatest.id]),
    memory('condition-memory', 'episode', 9, [partner.id], [observerCondition.id]),
    memory('blocked-memory', 'failure', 10, [partner.id], [blockedDelivery.id]),
    memory('conversation-memory', 'episode', 11, [partner.id], [previousConversation.id]),
    memory('measurement-memory', 'episode', 13, [], [woodOne.id, woodTwo.id, clayOne.id]),
    memory('remote-memory', 'episode', 16, [], [
      mechanicalService.id, unrelatedMechanicalWork.id, travel.id, remoteWork.id,
    ]),
    memory('cross-owner-source-memory', 'episode', 18, [partner.id], [crossOwnerAttend.id]),
  ];
  observer.maternalTeachingSourceEventIds = [teaching.id];
  observer.inventory = [
    { id: 'measurement-wood', materialId: api.Material.Wood, quantity: 2,
      sourceEventIds: [woodOne.id, woodTwo.id] },
    { id: 'measurement-clay', materialId: api.Material.Clay, quantity: 2,
      sourceEventIds: [clayOne.id] },
  ];
  partner.inventory = partner.inventory.filter((stack) => stack.materialId !== api.Material.Wood);

  state.agreements.push({
    id: 'expired-company',
    proposal: {
      kind: 'assist', requesterId: observer.id, helperId: partner.id,
      need: 'company', expiresAtMonth: 3,
    },
    proposerId: observer.id, responderId: partner.id,
    partyIds: [observer.id, partner.id], requiredResponderIds: [partner.id],
    acceptedByPersonIds: [observer.id], rejectedByPersonIds: [], status: 'expired',
    proposedAtMonth: 2, acceptByMonth: 3, resolvedAtMonth: 3,
    proposalEventId: companyProposal.id, fulfillmentEventIds: [],
    fulfilledByPersonIds: [], coLocatedMonths: 0, sourceEventIds: [companyProposal.id],
  });
  const project = api.instantiateProject({
    id: 'fixture-project', kind: 'production', need: 'food-preparation',
    desiredFunction: 'prepared-food', summary: 'fixture material request',
    ownerId: partner.id, beneficiaryIds: [partner.id], triggerFactIds: [],
    pressure: 50, createdAtMonth: 9, reviewAtMonth: 60,
    site: { cellId: 0, z: 1 },
  });
  project.materialDemands = [{
    materialId: api.Material.Wood, requiredQuantity: 5, availableQuantity: 0,
    outstandingQuantity: 5, branchKey: 'fixture-wood', sourceFactIds: [projectRequest.id],
  }];
  project.materialContributionRequests = [{
    version: 'project-material-contribution-request-v1', requestEventId: projectRequest.id,
    projectId: project.id, requesterId: partner.id, contributorIds: [observer.id],
    materialId: api.Material.Wood, requestedQuantity: 5,
    site: { cellId: 0, z: 1 }, expiresAtMonth: 60, atMonth: 9,
  }];
  project.actionEventIds = [projectRequest.id];
  state.projects.push(project);
  const restrictedDrop = {
    id: 'restricted-drop', materialId: api.Material.Wood, cellId: 0, z: 1,
    quantity: 2, createdAtMonth: 9, sourceEventIds: [projectRequest.id],
    projectMaterialDelivery: {
      version: 'project-material-delivery-v1', projectId: project.id,
      requestEventId: projectRequest.id, requesterId: partner.id, expiresAtMonth: 60,
    },
  };
  state.world.drops.push(restrictedDrop);

  const duplicateOption = {
    id: 'fixture-duplicate', summary: '再次谈伤痛', reason: 'fixture',
    goal: { kind: 'representation-made', representationId: 'duplicate-hardship' },
    nextAction: {
      kind: 'communicate', channel: 'voice', audience: [partner.id],
      content: {
        id: 'duplicate-hardship', kind: 'claim', summary: '我的伤还在疼',
        conversation: {
          version: 'grounded-conversation-v1', basisKey: 'condition-basis',
          topic: 'hardship', turn: 'opening', speakerId: observer.id,
          listenerId: partner.id, sourceFactIds: [observerCondition.id],
        },
      },
    },
    estimatedDuration: 'one-month', sourceFactIds: [observerCondition.id], domain: 'social',
    semantics: {
      version: 'action-option-semantics-v1', obligation: 'optional',
      planningChannel: 'ordinary', purpose: 'conversation', minimumLifeStage: 'adult',
      needKinds: ['belonging'], conversation: { turn: 'opening', topic: 'hardship' },
      socialContext: {
        cooperationKind: 'conversation', phase: 'opening',
        counterpartIds: [partner.id], conversationTopic: 'hardship',
      },
    },
  };

  function consumerSnapshot(candidate) {
    const currentObserver = candidate.people.find((person) => person.id === observer.id);
    const currentPartner = candidate.people.find((person) => person.id === partner.id);
    const remembered = api.createRememberedGroundedOpeningBasisSnapshot(
      candidate,
      [currentObserver, currentPartner],
    );
    const gratitude = api.__testGratitudeEvent(
      candidate, currentObserver, currentPartner, remembered,
    );
    const openings = api.__testOpeningCandidates(
      candidate, currentObserver, currentPartner, remembered,
    ).map((item) => ({ topic: item.topic, sourceFactIds: item.sourceFactIds }));
    return {
      gratitude: gratitude ? { eventId: gratitude.eventId, atMonth: gratitude.atMonth } : null,
      openings,
      relationship: api.buildRelationshipCausalBasis(
        candidate, currentObserver, currentPartner, 'companion', 30,
      ),
      reoffer: api.__testCanRequestCompanyWithCurrentBasis(
        candidate,
        currentObserver.id,
        currentPartner.id,
        currentObserver.relations[0].sourceEventIds,
        30,
      ),
      repetition: api.assessSocialRepetition(candidate, currentObserver, duplicateOption),
      blocked: api.personRemembersProjectMaterialDeliveryRestriction(
        candidate, currentObserver.id,
        candidate.world.drops.find((drop) => drop.id === restrictedDrop.id),
        30,
      ),
      electrical: api.__testRemoteWorkEvidence(candidate, currentObserver),
      measurement: api.measurementUncertaintyBasisFor(candidate, currentObserver, 31),
    };
  }

  const fullSnapshot = consumerSnapshot(state);
  assert.equal(fullSnapshot.gratitude?.eventId, supportLatest.id);
  assert.equal(fullSnapshot.reoffer, true);
  assert.equal(fullSnapshot.blocked, true);
  assert.equal(fullSnapshot.repetition.previousCommunicationEventId, previousConversation.id);
  assert.ok(fullSnapshot.measurement, 'fixture 必须形成真实 measurement uncertainty basis');
  assert.ok(fullSnapshot.electrical.some((item) => item.id === mechanicalService.id));
  assert.equal(fullSnapshot.electrical.some((item) => item.id === unrelatedMechanicalWork.id), false);

  const currentProjection = canonicalProjection(api, state);
  const observerBroad = broadGroupFor(currentProjection, observer.id);
  assert.equal(observerBroad.requirement, 'index-only');
  assert.deepEqual(
    observerBroad.eventIds,
    api.livePersonSocialSourceEventIds(observer),
    'broad membership 必须完整且不做 top-N',
  );
  const broadLease = api.livePersonSocialEvidenceLeaseKey(observer.id);
  assert.equal(currentProjection.pins.some((pin) => pin.leaseKeys.includes(broadLease)), false);
  const electricalGroup = strictGroupFor(currentProjection, observer.id, 'electrical-remote-work');
  const measurementGroup = strictGroupFor(currentProjection, observer.id, 'measurement-uncertainty');
  assert.ok(electricalGroup.eventIds.includes(mechanicalService.id));
  assert.equal(electricalGroup.eventIds.includes(unrelatedMechanicalWork.id), false,
    '仅携带 mechanicalPowerBasis 的 install/repair 动作不得获得 electrical strict body lease');
  assert.deepEqual(measurementGroup.eventIds, [clayOne.id, woodOne.id, woodTwo.id].sort());
  assert.ok(currentProjection.pins.every((pin) => (
    !pin.leaseKeys.some((leaseKey) => leaseKey === broadLease)
  )));
  assert.ok(currentProjection.pins.some((pin) => pin.leaseKeys.includes(
    api.livePersonSocialStrictEvidenceLeaseKey(observer.id, 'electrical-remote-work'),
  )));
  assert.equal(
    currentProjection.pins.find((pin) => pin.eventId === teaching.id),
    undefined,
    'maternal teaching state identity 不得反向 pin body',
  );

  const withoutCondition = structuredClone(state);
  withoutCondition.people.find((person) => person.id === observer.id).conditions = [];
  withoutCondition.people.find((person) => person.id === observer.id).memories =
    withoutCondition.people.find((person) => person.id === observer.id).memories
      .filter((item) => item.id !== 'condition-memory');
  assert.equal(broadGroupFor(canonicalProjection(api, withoutCondition), observer.id)
    .eventIds.includes(observerCondition.id), false, 'condition 清除必须退租');

  const forgottenSupport = structuredClone(state);
  forgottenSupport.people.find((person) => person.id === observer.id).memories =
    forgottenSupport.people.find((person) => person.id === observer.id).memories
      .filter((item) => item.id !== 'support-memory');
  const forgottenIds = broadGroupFor(canonicalProjection(api, forgottenSupport), observer.id)
    .eventIds;
  assert.equal(forgottenIds.includes(supportEarly.id), false);
  assert.equal(forgottenIds.includes(supportLatest.id), false,
    '普通记忆遗忘必须精确释放 broad membership');

  const relationReplacement = structuredClone(state);
  relationReplacement.people.find((person) => person.id === observer.id).relations[0].sourceEventIds = [
    ...relationEvents.slice(1, 25).map((event) => event.id), relationEvents[25].id,
  ];
  const replacedIds = broadGroupFor(canonicalProjection(api, relationReplacement), observer.id).eventIds;
  assert.equal(replacedIds.includes(relationEvents[0].id), false);
  assert.equal(replacedIds.includes(relationEvents[25].id), true);

  const sharedReleasedByOne = structuredClone(state);
  sharedReleasedByOne.people.find((person) => person.id === observer.id).relations = [];
  const sharedOnce = canonicalProjection(api, sharedReleasedByOne);
  assert.ok(sharedOnce.continuationBasis.directMatches.some((match) => (
    match.eventId === relationEvents[0].id
  )), '共享 source 必须由最后一个 owner 继续保留 identity');
  const sharedReleasedByAll = structuredClone(sharedReleasedByOne);
  sharedReleasedByAll.people.find((person) => person.id === partner.id).relations = [];
  const sharedGone = canonicalProjection(api, sharedReleasedByAll);
  assert.equal(sharedGone.continuationBasis.directMatches.some((match) => (
    match.eventId === relationEvents[0].id
  )), false, '最后 owner 释放后 shared identity 必须消失');

  const deadOwner = structuredClone(state);
  const deadObserver = deadOwner.people.find((person) => person.id === observer.id);
  deadObserver.diedAtMonth = 30;
  deadObserver.body.health = 0;
  const deadProjection = canonicalProjection(api, deadOwner);
  assert.equal(broadGroupFor(deadProjection, observer.id), undefined);
  assert.equal(deadProjection.pins.some((pin) => pin.leaseKeys.some((leaseKey) => (
    leaseKey.includes(`live-person-social:${encodeURIComponent(observer.id)}`)
  ))), false, '人物死亡必须同时释放 broad 与 strict leases');

  const overflowPerson = structuredClone(observer);
  overflowPerson.memories = [memory(
    'overflow', 'episode', 1, [],
    Array.from({ length: 4_097 }, (_, index) => `overflow-${index}`),
  )];
  overflowPerson.conditions = [];
  overflowPerson.relations = [];
  overflowPerson.maternalTeachingSourceEventIds = [];
  assert.throws(() => api.livePersonSocialSourceEventIds(overflowPerson), /4096/u);

  const store = new api.SqliteRunStore(dataDirectory);
  const created = await store.create({ id: 'live-social-layering', state });
  await store.bootstrapBoundedEvolutionContinuation(created.meta.id, 256);
  const database = store.database;
  const readChunk = (hash) => {
    const row = database.prepare(
      'SELECT hash, codec, raw_size, data FROM chunks WHERE hash = ?',
    ).get(hash);
    if (!row) throw new Error(`missing fixture chunk ${hash}`);
    return {
      hash: String(row.hash), codec: String(row.codec),
      rawSize: Number(row.raw_size), data: Buffer.from(row.data),
    };
  };
  const readPersistedRetention = (runId) => {
    const row = database.prepare(
      'SELECT state_hash, bundle_hash FROM run_continuations WHERE run_id = ?',
    ).get(runId);
    assert.ok(row, `run ${runId} 必须有 bounded continuation`);
    const bundle = api.decodeRunContinuationBundle(readChunk(String(row.bundle_hash)));
    const reference = bundle.sidecars.retention;
    const projection = api.decodeHistoryRetentionSidecar(
      readChunk(reference.hash),
      {
        reference,
        boundary: {
          authority: { stateHash: String(row.state_hash) },
          target: {
            eventCount: bundle.authority.eventCount,
            tailEventId: bundle.authority.tailEventId,
          },
        },
      },
    );
    return { row, bundle, projection };
  };
  const insertChunk = (chunk) => database.prepare(
    'INSERT OR IGNORE INTO chunks(hash, codec, raw_size, data) VALUES (?, ?, ?, ?)',
  ).run(chunk.hash, chunk.codec, chunk.rawSize, chunk.data);
  const continuationRow = database.prepare(
    'SELECT state_hash, bundle_hash FROM run_continuations WHERE run_id = ?',
  ).get(created.meta.id);
  const currentBundle = api.decodeRunContinuationBundle(
    readChunk(String(continuationRow.bundle_hash)),
  );
  const retentionReference = currentBundle.sidecars.retention;
  const retainedProjection = api.decodeHistoryRetentionSidecar(
    readChunk(retentionReference.hash),
    {
      reference: retentionReference,
      boundary: {
        authority: { stateHash: String(continuationRow.state_hash) },
        target: {
          eventCount: currentBundle.authority.eventCount,
          tailEventId: currentBundle.authority.tailEventId,
        },
      },
    },
  );
  const legacyRetention = legacyLiveSocialProjection(api, retainedProjection);
  insertChunk(legacyRetention.chunk);
  const legacyColdPins = legacyRetention.projection.pins
    .filter((pin) => pin.absoluteIndex < currentBundle.hotStartIndex)
    .map((pin) => ({
      absoluteIndex: pin.absoluteIndex, eventId: pin.eventId,
      leaseKeys: [...pin.leaseKeys],
    }));
  const legacyBundle = api.encodeRunContinuationBundle({
    ...currentBundle,
    coldPins: legacyColdPins,
    sidecars: { ...currentBundle.sidecars, retention: legacyRetention.reference },
  });
  insertChunk(legacyBundle.chunk);
  database.prepare('UPDATE run_continuations SET bundle_hash = ? WHERE run_id = ?')
    .run(legacyBundle.chunk.hash, created.meta.id);

  const opened = await store.openBoundedEvolutionContinuation(created.meta.id);
  assert.deepEqual(consumerSnapshot(opened.state), fullSnapshot,
    'full 与 legacy-migrated bounded consumers 必须逐字一致');
  assert.deepEqual(api.retainedColdWorldEventsForLease(opened.state, broadLease), [],
    'legacy broad body 不得泄漏进 generic cold index');
  assert.equal(api.worldEventById(opened.state, observerCondition.id), undefined,
    'descriptor-only condition body 不得被 generic worldEventById 读取');
  assert.equal(api.liveSocialEvidenceForPersonSource(
    opened.state,
    opened.state.people.find((person) => person.id === partner.id),
    observerCondition.id,
  ), undefined, 'foreign owner 不得读取另一个 owner descriptor');
  assert.ok(api.retainedColdWorldEventsForLease(
    opened.state,
    api.livePersonSocialStrictEvidenceLeaseKey(observer.id, 'electrical-remote-work'),
  ).some((event) => event.id === mechanicalService.id));

  const isolatedClone = structuredClone(opened.state);
  assert.equal(api.liveSocialEvidenceForPersonSource(
    isolatedClone,
    isolatedClone.people.find((person) => person.id === observer.id),
    observerCondition.id,
  ), undefined, 'descriptor registry 不得跨 authoritative history base');
  const conditionDescriptor = api.liveSocialEvidenceForPersonSource(
    opened.state,
    opened.state.people.find((person) => person.id === observer.id),
    observerCondition.id,
  );
  const conditionMatch = legacyRetention.projection.continuationBasis.directMatches
    .find((match) => match.eventId === observerCondition.id);
  assert.ok(conditionDescriptor && conditionMatch);
  assert.throws(() => api.registerLiveSocialEvidenceDescriptors(
    isolatedClone,
    [{
      ownerId: observer.id,
      absoluteIndex: conditionMatch.absoluteIndex + 1,
      descriptor: conditionDescriptor,
    }],
    [conditionMatch],
  ), /ordinal|identity/u, '错误 ordinal 必须 fail-closed');

  const wrongAuthority = structuredClone(legacyRetention.projection);
  wrongAuthority.authority.stateHash = 'f'.repeat(64);
  const wrongAuthoritySidecar = rawRetentionSidecar(api, wrongAuthority);
  insertChunk(wrongAuthoritySidecar.chunk);
  const wrongAuthorityBundle = api.encodeRunContinuationBundle({
    ...currentBundle,
    coldPins: legacyColdPins,
    sidecars: { ...currentBundle.sidecars, retention: wrongAuthoritySidecar.reference },
  });
  insertChunk(wrongAuthorityBundle.chunk);
  database.prepare('UPDATE run_continuations SET bundle_hash = ? WHERE run_id = ?')
    .run(wrongAuthorityBundle.chunk.hash, created.meta.id);
  await assert.rejects(
    store.openBoundedEvolutionContinuation(created.meta.id),
    /stateHash|target|authority/u,
    '错误 root authority 不得安装 descriptor registry',
  );
  database.prepare('UPDATE run_continuations SET bundle_hash = ? WHERE run_id = ?')
    .run(legacyBundle.chunk.hash, created.meta.id);

  const staged = await store.stageBoundedNonProjectionMonth(created.meta.id);
  const published = await store.publishBoundedNonProjectionMonth(staged);
  assert.equal(published.persisted, true);
  const nextContinuation = database.prepare(
    'SELECT state_hash, bundle_hash FROM run_continuations WHERE run_id = ?',
  ).get(created.meta.id);
  const nextBundle = api.decodeRunContinuationBundle(readChunk(String(nextContinuation.bundle_hash)));
  const nextRetentionReference = nextBundle.sidecars.retention;
  const nextRetention = api.decodeHistoryRetentionSidecar(
    readChunk(nextRetentionReference.hash),
    {
      reference: nextRetentionReference,
      boundary: {
        authority: { stateHash: String(nextContinuation.state_hash) },
        target: {
          eventCount: nextBundle.authority.eventCount,
          tailEventId: nextBundle.authority.tailEventId,
        },
      },
    },
  );
  assert.ok(nextRetention.demandGroups
    .filter((group) => /^live-person-social:[^:]+:sources$/u.test(group.groupKey))
    .every((group) => group.requirement === 'index-only'),
  'legacy open 的下一 successor 必须只写规范 index-only broad');
  assert.ok(nextRetention.demandGroups
    .filter((group) => /:strict:/u.test(group.groupKey))
    .every((group) => group.requirement === 'all'),
  '下一 successor 必须规范写 strict all 子组');
  const warmStage = await store.stageBoundedNonProjectionMonth(created.meta.id);
  assert.equal(store.ownsBoundedNonProjectionMonthStagingReceipt(warmStage), true,
    'COMMIT 后 warm successor 必须用 next root 重建 registry 并可继续一步');

  const ordinaryState = structuredClone(state);
  const ordinaryObserver = ordinaryState.people.find((person) => person.id === observer.id);
  const ordinaryOldMove = action('ordinary-new-memory-old-move', 18, 1, observer.id, {
    kind: 'move', toCellId: 2, toZ: 1,
  });
  const ordinaryOldAttend = action('ordinary-new-memory-old-attend', 18, 2, observer.id, {
    kind: 'attend', target: { kind: 'person', personId: partner.id },
  });
  const ordinaryInsertAt = ordinaryState.world.past
    .findIndex((event) => event.id === fillerEvents[0].id);
  assert.ok(ordinaryObserver && ordinaryInsertAt > 0);
  ordinaryState.world.past.splice(
    ordinaryInsertAt,
    0,
    ordinaryOldMove,
    ordinaryOldAttend,
  );
  const ordinaryHotEventIds = new Set([...electricalGroup.eventIds, tail.id]);
  const ordinaryHotEvents = ordinaryState.world.past
    .filter((event) => ordinaryHotEventIds.has(event.id));
  ordinaryState.world.past = [
    ...ordinaryState.world.past.filter((event) => !ordinaryHotEventIds.has(event.id)),
    ...ordinaryHotEvents,
  ];
  for (let index = 0; index < ordinaryHotEvents.length; index += 1) {
    ordinaryHotEvents[index].atMonth = 30;
    ordinaryHotEvents[index].orderInMonth = index;
    ordinaryHotEvents[index].orderInTick = index;
  }
  ordinaryState.world.historyCursor = {
    version: 1,
    eventCount: ordinaryState.world.past.length,
    hotStartIndex: 0,
    tailEventId: tail.id,
  };
  ordinaryState.lastStep = [ordinaryHotEvents.at(-1)];
  const ordinaryIntent = reviewDueIntent(
    ordinaryObserver,
    'ordinary-new-membership-review',
    30,
    [ordinaryOldMove.id, ordinaryOldAttend.id],
    api.Material.Wood,
  );
  ordinaryState.intents = [ordinaryIntent];
  ordinaryObserver.activeIntentId = ordinaryIntent.id;
  const ordinaryProbe = api.stepOwnedBoundedNonProjectionMonth(structuredClone(ordinaryState));
  const ordinaryExpected = canonicalProjection(api, ordinaryProbe, 'c'.repeat(64));
  const ordinaryElectricalExpected = strictGroupFor(
    ordinaryExpected,
    observer.id,
    'electrical-remote-work',
  );
  for (const eventId of [ordinaryOldMove.id, ordinaryOldAttend.id]) {
    assert.ok(ordinaryElectricalExpected.eventIds.includes(eventId),
      `真实 terminal memory 必须令 ${eventId} 进入 full strict selector`);
  }
  const ordinaryCreated = await store.create({
    id: 'live-social-ordinary-new-cold-membership',
    state: ordinaryState,
  });
  await store.bootstrapBoundedEvolutionContinuation(ordinaryCreated.meta.id, 256);
  const ordinaryBefore = readPersistedRetention(ordinaryCreated.meta.id);
  assert.deepEqual(
    ordinaryBefore.projection.demandGroups
      .filter((group) => group.blocking)
      .map((group) => ({ key: group.groupKey, unresolved: group.unresolvedEventIds })),
    [],
    'ordinary source continuation 不得带阻断 retention demand',
  );
  assert.ok(strictGroupFor(
    ordinaryBefore.projection,
    observer.id,
    'electrical-remote-work',
  ), 'ordinary source projection 必须已有当前 owner 的规范 strict group');
  for (const eventId of [ordinaryOldMove.id, ordinaryOldAttend.id]) {
    assert.equal(broadGroupFor(ordinaryBefore.projection, observer.id)
      .eventIds.includes(eventId), false, `source live-social membership 尚未引用 ${eventId}`);
    const activeIntentMatch = ordinaryBefore.projection.continuationBasis.directMatches
      .find((match) => match.eventId === eventId);
    assert.ok(activeIntentMatch
      && activeIntentMatch.absoluteIndex < ordinaryBefore.bundle.hotStartIndex,
    `active intent 只应为 ${eventId} 保留 verified cold identity，不应预建 owner descriptor`);
  }
  const ordinaryStage = await store.stageBoundedNonProjectionMonth(ordinaryCreated.meta.id);
  const ordinaryPublication = await store.publishBoundedNonProjectionMonth(ordinaryStage);
  assert.equal(ordinaryPublication.persisted, true);
  const ordinaryAfter = readPersistedRetention(ordinaryCreated.meta.id);
  const ordinaryElectricalAfter = strictGroupFor(
    ordinaryAfter.projection,
    observer.id,
    'electrical-remote-work',
  );
  assert.deepEqual(
    ordinaryElectricalAfter.eventIds,
    ordinaryElectricalExpected.eventIds,
    '普通 successor 新 terminal memory 的 persisted strict 必须与 full state 逐字一致',
  );
  assert.equal(ordinaryAfter.projection.pins.some((pin) => pin.leaseKeys.includes(
    api.livePersonSocialEvidenceLeaseKey(observer.id),
  )), false, '普通 successor broad membership 仍不得获得 body pin');
  const ordinaryContinueStore = new api.SqliteRunStore(dataDirectory);
  const ordinaryNextStage = await ordinaryContinueStore.stageBoundedNonProjectionMonth(
    ordinaryCreated.meta.id,
  );
  assert.equal(ordinaryContinueStore.ownsBoundedNonProjectionMonthStagingReceipt(
    ordinaryNextStage,
  ), true, '普通 successor 必须能从 cold continuation 续下一月');
  ordinaryContinueStore.close();
  const ordinaryColdStore = new api.SqliteRunStore(dataDirectory);
  const ordinaryColdOpened = await ordinaryColdStore.openBoundedEvolutionContinuation(
    ordinaryCreated.meta.id,
  );
  assert.deepEqual(
    api.retainedColdWorldEventsForLease(
      ordinaryColdOpened.state,
      api.livePersonSocialStrictEvidenceLeaseKey(observer.id, 'electrical-remote-work'),
    ).map((event) => event.id).filter((eventId) => (
      eventId === ordinaryOldMove.id || eventId === ordinaryOldAttend.id
    )).sort(),
    [ordinaryOldAttend.id, ordinaryOldMove.id].sort(),
    '普通 successor cold open 必须精确恢复首次引用的旧 move/attend strict bodies',
  );
  ordinaryColdStore.close();

  // Directly exercise the verified-prefix seam with a shell transition that
  // first introduces an old event and a persistent non-event source. The
  // ordinary/annual cases above cover real SQLite publication and cold open;
  // this case isolates the identity handoff before the fold is persisted.
  const prefixSourceState = structuredClone(state);
  const prefixSourceObserver = prefixSourceState.people
    .find((person) => person.id === observer.id);
  const prefixDeceased = prefixSourceState.people.find((person) => (
    person.id !== observer.id && person.id !== partner.id
  ));
  assert.ok(prefixDeceased);
  prefixDeceased.diedAtMonth = 29;
  prefixDeceased.body.health = 0;
  const prefixHotTailDeath = {
    ...environment(
      'prefix-hot-tail-death',
      29,
      320,
      'death',
      { personId: prefixDeceased.id },
    ),
    who: prefixDeceased.id,
  };
  const prefixFirstDemandAttend = action(
    'prefix-first-any-demand-attend',
    18,
    3,
    observer.id,
    { kind: 'attend', target: { kind: 'person', personId: partner.id } },
  );
  const prefixLegacyUnresolvedAttend = action(
    'prefix-legacy-unresolved-attend',
    18,
    4,
    partner.id,
    { kind: 'attend', target: { kind: 'person', personId: observer.id } },
  );
  const prefixInsertAt = prefixSourceState.world.past
    .findIndex((event) => event.id === fillerEvents[0].id);
  assert.ok(prefixSourceObserver && prefixInsertAt > 0);
  prefixSourceState.world.past.splice(
    prefixInsertAt,
    0,
    prefixFirstDemandAttend,
    prefixLegacyUnresolvedAttend,
  );
  const prefixTailIndex = prefixSourceState.world.past
    .findIndex((event) => event.id === tail.id);
  assert.ok(prefixTailIndex > prefixInsertAt);
  prefixSourceState.world.past.splice(prefixTailIndex, 0, prefixHotTailDeath);
  prefixSourceObserver.memories.push(memory(
    'prefix-legacy-unresolved-owner-memory',
    'episode',
    18,
    [partner.id],
    [prefixLegacyUnresolvedAttend.id],
  ));
  prefixSourceState.world.historyCursor = {
    version: 1,
    eventCount: prefixSourceState.world.past.length,
    hotStartIndex: 0,
    tailEventId: tail.id,
  };
  prefixSourceState.lastStep = [prefixSourceState.world.past.at(-1)];
  const prefixChunks = new Map();
  const keepPrefixSnapshot = (snapshot) => {
    for (const chunk of [...snapshot.parts, snapshot.root]) {
      prefixChunks.set(chunk.hash, chunk);
    }
    return snapshot;
  };
  const readPrefixChunk = (hash) => {
    const chunk = prefixChunks.get(hash);
    if (!chunk) throw new Error(`missing prefix fixture chunk ${hash}`);
    return chunk;
  };
  const prefixSourceRoot = keepPrefixSnapshot(await api.encodeSegmentedRunState(
    prefixSourceState,
    { mode: 'replace' },
    { maxEventsPerSegmentForTests: 32 },
  ));
  const canonicalPrefixSource = canonicalProjection(
    api,
    prefixSourceState,
    prefixSourceRoot.root.hash,
  );
  assert.equal(canonicalPrefixSource.continuationBasis.directMatches.some(
    (match) => match.eventId === prefixFirstDemandAttend.id,
  ), false, '旧冷 attend 在 source shell 中不得已属于任何 demand/directMatch');
  assert.equal(canonicalPrefixSource.continuationBasis.directMatches.some(
    (match) => match.eventId === prefixHotTailDeath.id,
  ), false, 'previous root 的未引用 death 不得预建 live-social identity');

  // Model an older index-only sidecar which carried membership but never
  // proved that its raw prefix was searched. The current decoder accepts this
  // nonblocking shape, and the successor must search the exact root again.
  const unresolvedPrefixSource = structuredClone(canonicalPrefixSource);
  const unresolvedPrefixBroad = broadGroupFor(unresolvedPrefixSource, observer.id);
  assert.ok(unresolvedPrefixBroad.resolvedEventIds.includes(prefixLegacyUnresolvedAttend.id));
  const unresolvedPrefixGroups = unresolvedPrefixSource.demandGroups.filter((group) => (
    group.eventIds.includes(prefixLegacyUnresolvedAttend.id)
  ));
  assert.ok(unresolvedPrefixGroups.length >= 1
    && unresolvedPrefixGroups.every((group) => group.requirement === 'index-only'));
  for (const group of unresolvedPrefixGroups) {
    group.resolvedEventIds = group.resolvedEventIds
      .filter((eventId) => eventId !== prefixLegacyUnresolvedAttend.id);
    group.unresolvedEventIds = [...new Set([
      ...group.unresolvedEventIds,
      prefixLegacyUnresolvedAttend.id,
    ])].sort();
    group.satisfied = false;
    group.blocking = false;
  }
  unresolvedPrefixSource.continuationBasis.directMatches =
    unresolvedPrefixSource.continuationBasis.directMatches.filter(
      (match) => match.eventId !== prefixLegacyUnresolvedAttend.id,
    );
  unresolvedPrefixSource.unresolvedDemands.push(...unresolvedPrefixGroups.map((group) => ({
    eventId: prefixLegacyUnresolvedAttend.id,
    leaseKeys: [...group.leaseKeys],
    requirement: 'index-only',
    groupKey: group.groupKey,
    blocking: false,
  })));
  unresolvedPrefixSource.unresolvedDemands.sort((left, right) => (
    left.groupKey.localeCompare(right.groupKey)
      || left.eventId.localeCompare(right.eventId)
  ));
  const unresolvedPrefixSidecar = rawRetentionSidecar(api, unresolvedPrefixSource);
  const decodedPrefixSource = api.decodeHistoryRetentionSidecar(
    unresolvedPrefixSidecar.chunk,
    {
      reference: unresolvedPrefixSidecar.reference,
      boundary: {
        authority: { stateHash: prefixSourceRoot.root.hash },
        target: canonicalPrefixSource.target,
      },
    },
  );
  assert.equal(decodedPrefixSource.continuationBasis.directMatches.some(
    (match) => match.eventId === prefixLegacyUnresolvedAttend.id,
  ), false, 'legacy unresolved membership 不得伪造 directMatch');

  const prefixNextFullState = structuredClone(prefixSourceState);
  const prefixNextObserver = prefixNextFullState.people
    .find((person) => person.id === observer.id);
  const prefixNextPartner = prefixNextFullState.people
    .find((person) => person.id === partner.id);
  const persistentNonEventId = 'record-payload:persistent-live-social-non-event';
  prefixNextObserver.memories.push(memory(
    'prefix-first-demand-memory',
    'episode',
    31,
    [partner.id],
    [prefixFirstDemandAttend.id, persistentNonEventId],
  ));
  prefixNextObserver.memories.push(memory(
    'prefix-hot-tail-death-first-reference',
    'episode',
    31,
    [prefixDeceased.id],
    [prefixHotTailDeath.id],
  ));
  prefixNextPartner.memories.push(memory(
    'prefix-cross-owner-new-memory',
    'episode',
    31,
    [observer.id],
    [prefixLegacyUnresolvedAttend.id],
  ));
  const prefixSuffix = environment(
    'prefix-first-demand-suffix',
    31,
    0,
    'weather',
    { fixture: 'verified-prefix-live-social' },
  );
  prefixNextFullState.clock.elapsedMonths = 31;
  prefixNextFullState.world.past.push(prefixSuffix);
  prefixNextFullState.world.historyCursor = {
    version: 1,
    eventCount: prefixNextFullState.world.past.length,
    hotStartIndex: 0,
    tailEventId: prefixSuffix.id,
  };
  prefixNextFullState.lastStep = [prefixSuffix];
  const prefixNextRoot = keepPrefixSnapshot(await api.encodeSegmentedRunState(
    prefixNextFullState,
    { mode: 'append', previous: prefixSourceRoot.metadata },
    { maxEventsPerSegmentForTests: 32 },
  ));
  const prefixNextBoundedState = structuredClone(prefixNextFullState);
  const prefixHotTailStart = prefixNextBoundedState.world.past.findIndex((event) => (
    event.id === prefixHotTailDeath.id
  ));
  assert.ok(prefixHotTailStart >= 0
    && prefixHotTailStart < prefixSourceRoot.metadata.eventCount);
  prefixNextBoundedState.world.past = prefixNextBoundedState.world.past
    .slice(prefixHotTailStart);
  prefixNextBoundedState.world.historyCursor = {
    version: 1,
    eventCount: prefixNextRoot.metadata.eventCount,
    hotStartIndex: prefixHotTailStart,
    tailEventId: prefixSuffix.id,
  };
  prefixNextBoundedState.lastStep = [prefixNextBoundedState.world.past.at(-1)];
  const prefixExpected = canonicalProjection(
    api,
    prefixNextFullState,
    prefixNextRoot.root.hash,
  );
  const prefixSuccessor = await api.projectHistoryRetentionFromVerifiedSuccessor(
    decodedPrefixSource,
    prefixSourceRoot.root,
    prefixNextBoundedState,
    prefixNextRoot.root,
    readPrefixChunk,
  );
  const persistedPrefixProjection = api.decodeHistoryRetentionSidecar(
    prefixSuccessor.encoded.chunk,
    {
      reference: prefixSuccessor.encoded.reference,
      boundary: {
        authority: { stateHash: prefixNextRoot.root.hash },
        target: prefixExpected.target,
      },
    },
  );
  assert.deepEqual(
    strictGroupFor(
      persistedPrefixProjection,
      observer.id,
      'electrical-remote-work',
    ).eventIds,
    strictGroupFor(prefixExpected, observer.id, 'electrical-remote-work').eventIds,
    '首次任何 demand 的旧冷 eligible attend 必须 seed 到 persisted strict/full',
  );
  assert.deepEqual(
    strictGroupFor(
      persistedPrefixProjection,
      partner.id,
      'electrical-remote-work',
    ).eventIds,
    strictGroupFor(prefixExpected, partner.id, 'electrical-remote-work').eventIds,
    '旧 sidecar unresolved 真实 prefix ID 必须经 exact scan 迁移',
  );
  const persistedPrefixBroad = broadGroupFor(persistedPrefixProjection, observer.id);
  assert.ok(persistedPrefixBroad.resolvedEventIds.includes(prefixHotTailDeath.id),
    'next suffix 首次引用的 previous-root hot death 必须解析进 owner broad membership');
  const prefixDeathMatch = persistedPrefixProjection.continuationBasis.directMatches
    .find((match) => match.eventId === prefixHotTailDeath.id);
  assert.ok(prefixDeathMatch
    && prefixDeathMatch.absoluteIndex < prefixSourceRoot.metadata.eventCount,
  'previous-root hot death 必须经 exact prefix bridge 保留 verified ordinal');
  assert.equal(persistedPrefixProjection.pins.some((pin) => (
    pin.eventId === prefixHotTailDeath.id
      && pin.leaseKeys.includes(api.livePersonSocialEvidenceLeaseKey(observer.id))
  )), false, 'live-social broad previous-hot identity 不得获得 body pin');
  const prefixBoundedObserver = prefixNextBoundedState.people
    .find((person) => person.id === observer.id);
  const prefixBoundedPartner = prefixNextBoundedState.people
    .find((person) => person.id === partner.id);
  assert.ok(prefixBoundedObserver && prefixBoundedPartner);
  assert.ok(api.liveSocialEvidenceForPersonSource(
    prefixNextBoundedState,
    prefixBoundedObserver,
    prefixHotTailDeath.id,
  ), 'owner 必须能读取自己首次引用的 previous-hot death descriptor');
  assert.equal(api.liveSocialEvidenceForPersonSource(
    prefixNextBoundedState,
    prefixBoundedPartner,
    prefixHotTailDeath.id,
  ), undefined, 'foreign owner 不得读取 previous-hot death descriptor');
  assert.ok(persistedPrefixBroad.unresolvedEventIds.includes(persistentNonEventId));
  assert.equal(persistedPrefixBroad.blocking, false);
  assert.equal([...persistedPrefixProjection.demandGroups]
    .filter((group) => /:strict:/u.test(group.groupKey))
    .some((group) => group.eventIds.includes(persistentNonEventId)), false,
  'exact previous-root searched-no-match 的非事件 ID 只能保留为 broad unresolved');
  const prefixColdMatches = persistedPrefixProjection.continuationBasis.directMatches
    .filter((match) => match.eventId === prefixFirstDemandAttend.id
      || match.eventId === prefixLegacyUnresolvedAttend.id)
    .sort((left, right) => left.absoluteIndex - right.absoluteIndex);
  assert.equal(prefixColdMatches.length, 2);
  assert.ok(prefixColdMatches.every((match) => (
    match.absoluteIndex < prefixNextBoundedState.world.historyCursor.hotStartIndex
  )));
  assert.deepEqual(
    api.materializeVerifiedRunHistoryPinnedEvents(
      prefixNextRoot.metadata,
      readPrefixChunk,
      prefixColdMatches.map((match) => match.absoluteIndex),
    ).map((item) => item.event.id).sort(),
    [prefixFirstDemandAttend.id, prefixLegacyUnresolvedAttend.id].sort(),
    'persisted prefix identities 必须能从 exact next root 冷物化',
  );

  const prefixSecondFullState = structuredClone(prefixNextFullState);
  const prefixSecondSuffix = environment(
    'prefix-persistent-non-event-suffix',
    32,
    0,
    'weather',
    { fixture: 'persistent-non-event-rescan' },
  );
  prefixSecondFullState.clock.elapsedMonths = 32;
  prefixSecondFullState.world.past.push(prefixSecondSuffix);
  prefixSecondFullState.world.historyCursor = {
    version: 1,
    eventCount: prefixSecondFullState.world.past.length,
    hotStartIndex: 0,
    tailEventId: prefixSecondSuffix.id,
  };
  prefixSecondFullState.lastStep = [prefixSecondSuffix];
  const prefixSecondRoot = keepPrefixSnapshot(await api.encodeSegmentedRunState(
    prefixSecondFullState,
    { mode: 'append', previous: prefixNextRoot.metadata },
    { maxEventsPerSegmentForTests: 32 },
  ));
  const prefixSecondBoundedState = structuredClone(prefixSecondFullState);
  prefixSecondBoundedState.world.past = [prefixSecondBoundedState.world.past.at(-1)];
  prefixSecondBoundedState.world.historyCursor = {
    version: 1,
    eventCount: prefixSecondRoot.metadata.eventCount,
    hotStartIndex: prefixNextRoot.metadata.eventCount,
    tailEventId: prefixSecondSuffix.id,
  };
  prefixSecondBoundedState.lastStep = [prefixSecondBoundedState.world.past[0]];
  const prefixSecondSuccessor = await api.projectHistoryRetentionFromVerifiedSuccessor(
    persistedPrefixProjection,
    prefixNextRoot.root,
    prefixSecondBoundedState,
    prefixSecondRoot.root,
    readPrefixChunk,
  );
  const prefixSecondBroad = broadGroupFor(prefixSecondSuccessor.projection, observer.id);
  assert.ok(prefixSecondBroad.unresolvedEventIds.includes(persistentNonEventId));
  assert.equal(prefixSecondBroad.blocking, false);
  assert.equal(prefixSecondSuccessor.projection.continuationBasis.directMatches.some(
    (match) => match.eventId === persistentNonEventId,
  ), false, 'persistent non-event ID 再续一月仍不得伪造 directMatch');

  const annualState = structuredClone(state);
  annualState.clock.elapsedMonths = 35;
  const annualHotEventIds = new Set([...electricalGroup.eventIds, tail.id]);
  const annualHotEvents = annualState.world.past
    .filter((event) => annualHotEventIds.has(event.id));
  annualState.world.past = [
    ...annualState.world.past.filter((event) => !annualHotEventIds.has(event.id)),
    ...annualHotEvents,
  ];
  for (let index = 0; index < annualHotEvents.length; index += 1) {
    annualHotEvents[index].atMonth = 35;
    annualHotEvents[index].orderInMonth = index;
    annualHotEvents[index].orderInTick = index;
  }
  annualState.world.historyCursor = {
    version: 1,
    eventCount: annualState.world.past.length,
    hotStartIndex: 0,
    tailEventId: tail.id,
  };
  annualState.lastStep = [annualHotEvents.at(-1)];
  const annualPartner = annualState.people.find((person) => person.id === partner.id);
  assert.ok(annualPartner);
  const annualCrossOwnerIntent = reviewDueIntent(
    annualPartner,
    'annual-cross-owner-review',
    35,
    [crossOwnerAttend.id],
    api.Material.Wood,
  );
  annualState.intents = [annualCrossOwnerIntent];
  annualPartner.activeIntentId = annualCrossOwnerIntent.id;
  const annualProbe = api.stepOwnedBoundedObserverBoundaryMonth(structuredClone(annualState));
  const annualSuffixEventCount = annualProbe.state.world.historyCursor.eventCount
    - annualState.world.historyCursor.eventCount;
  assert.ok(annualSuffixEventCount > annualHotEvents.length,
    'fixture 的真实年度事实月必须把 source strict tail 推出 hot window');
  const annualExpected = canonicalProjection(api, annualProbe.state, 'b'.repeat(64));
  const annualElectricalExpected = strictGroupFor(
    annualExpected,
    observer.id,
    'electrical-remote-work',
  );
  const annualMeasurementExpected = strictGroupFor(
    annualExpected,
    observer.id,
    'measurement-uncertainty',
  );
  const annualPartnerElectricalExpected = strictGroupFor(
    annualExpected,
    partner.id,
    'electrical-remote-work',
  );
  assert.ok(annualPartnerElectricalExpected.eventIds.includes(crossOwnerAttend.id),
    '年度 root A 必须让新 owner 的 terminal memory 选择旧冷 attend');
  const annualCreated = await store.create({ id: 'live-social-annual-boundary', state: annualState });
  await store.bootstrapBoundedEvolutionContinuation(
    annualCreated.meta.id,
    annualSuffixEventCount,
  );
  const annualBefore = readPersistedRetention(annualCreated.meta.id);
  const annualElectricalBefore = strictGroupFor(
    annualBefore.projection,
    observer.id,
    'electrical-remote-work',
  );
  const annualMeasurementBefore = strictGroupFor(
    annualBefore.projection,
    observer.id,
    'measurement-uncertainty',
  );
  assert.equal(
    strictGroupFor(
      annualBefore.projection,
      partner.id,
      'electrical-remote-work',
    )?.eventIds.includes(crossOwnerAttend.id) ?? false,
    false,
    '年度 source shell 中新 owner 尚未引用跨 owner 冷事实',
  );
  const crossOwnerBeforeMatch = annualBefore.projection.continuationBasis.directMatches
    .find((candidate) => candidate.eventId === crossOwnerAttend.id);
  assert.ok(crossOwnerBeforeMatch
    && crossOwnerBeforeMatch.absoluteIndex < annualBefore.bundle.hotStartIndex,
  '跨 owner source 必须已有 verified cold identity 且仅由旧 owner broad membership 保存');
  assert.ok(annualElectricalBefore.eventIds.includes(travel.id));
  assert.ok(annualElectricalBefore.eventIds.includes(remoteWork.id));
  assert.ok(annualElectricalBefore.resolvedEventIds.includes(travel.id));
  assert.ok(annualElectricalBefore.resolvedEventIds.includes(remoteWork.id));
  for (const eventId of [travel.id, remoteWork.id]) {
    const match = annualBefore.projection.continuationBasis.directMatches
      .find((candidate) => candidate.eventId === eventId);
    assert.ok(match && match.absoluteIndex >= annualBefore.bundle.hotStartIndex,
      `fixture 必须让 completed intent ${eventId} 在年度边界前仍处于 hot window`);
  }

  const annualStaged = await store.stageBoundedObserverBoundaryMonth(annualCreated.meta.id);
  const annualPublished = await store.publishBoundedObserverBoundaryMonth(annualStaged);
  assert.equal(annualPublished.persisted, true);
  assert.equal(annualPublished.month, 36);
  const annualAfter = readPersistedRetention(annualCreated.meta.id);
  const annualElectricalAfter = strictGroupFor(
    annualAfter.projection,
    observer.id,
    'electrical-remote-work',
  );
  const annualMeasurementAfter = strictGroupFor(
    annualAfter.projection,
    observer.id,
    'measurement-uncertainty',
  );
  const annualPartnerElectricalAfter = strictGroupFor(
    annualAfter.projection,
    partner.id,
    'electrical-remote-work',
  );
  assert.deepEqual(
    annualElectricalAfter.eventIds,
    annualElectricalExpected.eventIds,
    '年度 fact root A full 与 persisted root B electrical strict IDs 必须逐字一致',
  );
  assert.deepEqual(
    annualMeasurementAfter.eventIds,
    annualMeasurementExpected.eventIds,
    '年度 fact root A full 与 persisted root B measurement strict IDs 必须逐字一致',
  );
  assert.deepEqual(
    annualPartnerElectricalAfter.eventIds,
    annualPartnerElectricalExpected.eventIds,
    '年度新 owner 跨 owner descriptor 的 fact root A 与 persisted root B 必须逐字一致',
  );
  assert.equal(annualAfter.projection.pins.some((pin) => pin.leaseKeys.some((leaseKey) => (
    /^gameplay:live-person-social:[^:]+:sources$/u.test(leaseKey)
  ))), false, '年度 successor 所有 broad membership 仍必须是 0 body pin');
  for (const eventId of [travel.id, remoteWork.id]) {
    const match = annualAfter.projection.continuationBasis.directMatches
      .find((candidate) => candidate.eventId === eventId);
    const pin = annualAfter.projection.pins
      .find((candidate) => candidate.eventId === eventId);
    assert.ok(match && match.absoluteIndex < annualAfter.bundle.hotStartIndex);
    assert.ok(pin?.leaseKeys.includes(
      api.livePersonSocialStrictEvidenceLeaseKey(observer.id, 'electrical-remote-work'),
    ), `年度 successor 必须精确 pin cold strict ${eventId}`);
  }
  const annualCrossOwnerPin = annualAfter.projection.pins
    .find((candidate) => candidate.eventId === crossOwnerAttend.id);
  assert.ok(annualCrossOwnerPin?.leaseKeys.includes(
    api.livePersonSocialStrictEvidenceLeaseKey(partner.id, 'electrical-remote-work'),
  ), '年度 successor 必须按新 owner 精确 pin 跨 owner cold strict body');

  store.close();
  const coldStore = new api.SqliteRunStore(dataDirectory);
  const annualColdOpened = await coldStore.openBoundedEvolutionContinuation(
    annualCreated.meta.id,
  );
  const coldObserver = annualColdOpened.state.people
    .find((person) => person.id === observer.id);
  const coldPartner = annualColdOpened.state.people
    .find((person) => person.id === partner.id);
  assert.ok(coldObserver && coldPartner);
  assert.deepEqual(
    api.retainedColdWorldEventsForLease(
      annualColdOpened.state,
      api.livePersonSocialStrictEvidenceLeaseKey(observer.id, 'electrical-remote-work'),
    ).map((event) => event.id).filter((eventId) => (
      eventId === travel.id || eventId === remoteWork.id
    )).sort(),
    [travel.id, remoteWork.id].sort(),
    '真实 cold reopen 必须恢复 completed move/transfer strict bodies',
  );
  assert.deepEqual(
    api.retainedColdWorldEventsForLease(
      annualColdOpened.state,
      api.livePersonSocialStrictEvidenceLeaseKey(partner.id, 'electrical-remote-work'),
    ).map((event) => event.id).filter((eventId) => eventId === crossOwnerAttend.id),
    [crossOwnerAttend.id],
    '年度 cold reopen 必须按新 owner 恢复跨 owner verified cold source',
  );
  assert.deepEqual(
    api.retainedColdWorldEventsForLease(
      annualColdOpened.state,
      api.livePersonSocialEvidenceLeaseKey(observer.id),
    ),
    [],
    '真实 cold reopen 不得恢复 broad bodies',
  );
  assert.ok(api.liveSocialEvidenceForPersonSource(
    annualColdOpened.state,
    coldObserver,
    observerCondition.id,
  ), '真实 cold reopen 必须恢复 owner-scoped body-free descriptor');
  const coldRememberedDescriptors = api.liveSocialEvidenceForPersonSources(
    annualColdOpened.state,
    coldObserver,
    coldObserver.memories.flatMap((item) => item.sourceEventIds),
  );
  assert.deepEqual(
    api.selectLivePersonSocialStrictEvidenceEventIds(
      coldObserver.id,
      coldRememberedDescriptors,
    )['electrical-remote-work'],
    annualElectricalExpected.eventIds,
    '真实 cold reopen 的 electrical selector 必须与 full fact root A 逐字一致',
  );
  assert.deepEqual(
    api.selectLivePersonSocialStrictEvidenceEventIds(
      coldObserver.id,
      [],
      api.measurementUncertaintyRawSourceEventIds(coldObserver),
    )['measurement-uncertainty'],
    annualMeasurementExpected.eventIds,
    '真实 cold reopen 的 measurement selector 必须与 full fact root A 逐字一致',
  );
  coldStore.close();
  console.log(JSON.stringify({
    result: 'passed',
    fullEventCount: state.world.past.length,
    customEventCount: state.world.past.length - historyStart,
    broadMembershipCount: observerBroad.eventIds.length,
    electricalStrictCount: electricalGroup.eventIds.length,
    measurementStrictCount: measurementGroup.eventIds.length,
    legacyColdPinCount: legacyColdPins.length,
    successorMonth: published.month,
    observerBoundaryMonth: annualPublished.month,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
