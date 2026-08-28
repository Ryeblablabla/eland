import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-record-retention-reopen-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');
const childEnvironment = { ...process.env, NODE_OPTIONS: '--max-old-space-size=256' };

const RECORD_INPUT_GROUP =
  'observer:modern-civilization:independent-record-experiment:replication-input-sources';
const RECORD_LEASE = 'observer:modern-civilization:independent-record-experiment';

try {
  writeFileSync(entryPath, [
    `export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/simulation.ts'))};`,
    `export { appendCommittedEvents } from ${JSON.stringify(path.resolve('src/game/eland/domain/history.ts'))};`,
    `export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};`,
    `export { isIndependentRecordReplicationReceiptFact } from ${JSON.stringify(path.resolve('src/game/eland/domain/era-progression.ts'))};`,
    `export {
      augmentRetainedColdWorldEventFacts,
      registerRetainedColdWorldEventFacts,
      retainedColdWorldEventsForLease,
      worldEventById,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/event-index.ts'))};`,
    `export {
      beginHistoryRetentionProjection,
      finishHistoryRetentionProjection,
      foldHistoryRetentionSegment,
      historyRetentionDemandFingerprintForShell,
    } from ${JSON.stringify(path.resolve('server/history-retention-projection.ts'))};`,
    `export {
      decodeHistoryRetentionSidecar,
      encodeHistoryRetentionSidecar,
    } from ${JSON.stringify(path.resolve('server/history-retention-codec.ts'))};`,
    `export {
      projectHistoryRetentionFromVerifiedSuccessor,
    } from ${JSON.stringify(path.resolve('server/history-retention-successor.ts'))};`,
    `export {
      decodeBoundedGameplayRunStateWithPhysicalProjection,
    } from ${JSON.stringify(path.resolve('server/physical-structure-ledger-projection.ts'))};`,
    `export {
      adoptStoreDecodedBoundedSimulationState,
    } from ${JSON.stringify(path.resolve('server/bounded-simulation-adoption.ts'))};`,
    `export {
      liveSocialColdMaterializationOrdinals,
      projectPressureColdMaterializationOrdinals,
    } from ${JSON.stringify(path.resolve('server/retained-history-evidence.ts'))};`,
    `export {
      encodeSegmentedRunState,
      materializeVerifiedRunHistoryPinnedEvents,
      parseRunStateRoot,
    } from ${JSON.stringify(path.resolve('server/run-state-codec.ts'))};`,
  ].join('\n'));
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { env: childEnvironment, stdio: 'pipe' });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  const chunks = new Map();
  const retainEncoded = (encoded) => {
    chunks.set(encoded.root.hash, encoded.root);
    for (const part of encoded.parts) chunks.set(part.hash, part);
  };
  const readChunk = (hash) => {
    const chunk = chunks.get(hash);
    if (!chunk) throw new Error(`fixture missing chunk ${hash}`);
    return chunk;
  };
  const decodeRetention = (encoded, root, tailEventId) => (
    api.decodeHistoryRetentionSidecar(encoded.chunk, {
      reference: encoded.reference,
      boundary: {
        authority: { stateHash: root.root.hash },
        target: { eventCount: root.metadata.eventCount, tailEventId },
      },
    })
  );
  const environmentFact = (id, atMonth, orderInMonth, materialId) => ({
    id,
    kind: 'environment',
    atMonth,
    orderInMonth,
    planningTick: 0,
    orderInTick: orderInMonth,
    cellId: 0,
    change: 'resource',
    result: id,
    diff: { materialId },
  });
  const fillerFact = (index) => ({
    id: `retention-reopen-filler-${index}`,
    kind: 'environment',
    atMonth: 2 + index,
    orderInMonth: 0,
    planningTick: 0,
    orderInTick: 0,
    cellId: index,
    change: 'material',
    result: `fixture filler ${index}`,
    diff: { fixtureKind: 'record-retention-reopen', index },
  });

  const stateA = api.createInitialState(
    7_301,
    { endpoint: { kind: 'months', value: 12_000 } },
  );
  const reader = stateA.people[0];
  const author = stateA.people[1];
  assert.ok(reader && author);
  const stoneSource = environmentFact(
    'retention-reopen-stone-source',
    1,
    0,
    api.Material.StoneTool,
  );
  const leasedWoodSource = environmentFact(
    'retention-reopen-leased-wood-source',
    1,
    1,
    api.Material.Wood,
  );
  const unleasedWoodSource = environmentFact(
    'retention-reopen-unleased-wood-source',
    1,
    2,
    api.Material.Wood,
  );
  const fillerFacts = Array.from({ length: 8 }, (_, index) => fillerFact(index));
  const warmGenericSource = fillerFacts[0];
  assert.ok(warmGenericSource);
  api.appendCommittedEvents(stateA, [
    stoneSource,
    leasedWoodSource,
    unleasedWoodSource,
    ...fillerFacts,
  ]);
  stateA.clock.elapsedMonths = 10;
  stateA.eraPredictions.push({
    id: 'retention-reopen-pending-prediction',
    predictorId: reader.id,
    audienceIds: [author.id],
    madeAtMonth: 1,
    targetEpoch: 'chaotic',
    predictedStartMonth: 20,
    toleranceMonths: 2,
    expiresAtMonth: 24,
    status: 'pending',
    sourceEventIds: [stoneSource.id, leasedWoodSource.id, warmGenericSource.id],
  });
  const rootA = await api.encodeSegmentedRunState(stateA, { mode: 'replace' }, {
    maxEventsPerSegmentForTests: 4,
  });
  retainEncoded(rootA);
  const foldA = api.beginHistoryRetentionProjection(
    stateA,
    { stateHash: rootA.root.hash },
  );
  api.foldHistoryRetentionSegment(foldA, stateA.world.past, 0);
  const projectedA = api.finishHistoryRetentionProjection(foldA);
  const encodedA = api.encodeHistoryRetentionSidecar(projectedA);
  const projectionA = decodeRetention(
    encodedA,
    rootA,
    stateA.world.historyCursor.tailEventId,
  );
  const previousPinsById = new Map(projectionA.pins.map((pin) => [pin.eventId, pin]));
  assert.ok(previousPinsById.get(stoneSource.id), 'stone input must have a real prior lease');
  assert.ok(previousPinsById.get(leasedWoodSource.id), 'wood input must have a real prior lease');
  const warmGenericPin = previousPinsById.get(warmGenericSource.id);
  assert.ok(warmGenericPin, 'warm registry control must have a real prior lease');
  assert.equal(previousPinsById.has(unleasedWoodSource.id), false,
    'unreferenced ledger fact must not gain a prior lease');

  function replicationSuccessor(secondSource) {
    const state = structuredClone(stateA);
    const nextReader = state.people.find((person) => person.id === reader.id);
    const nextAuthor = state.people.find((person) => person.id === author.id);
    assert.ok(nextReader && nextAuthor);
    const recordId = `retention-reopen-record-${secondSource.id}`;
    const projectId = `retention-reopen-project-${secondSource.id}`;
    const techniqueId = `retention-reopen-technique-${secondSource.id}`;
    const codebookId = `retention-reopen-codebook-${secondSource.id}`;
    const intentId = `retention-reopen-intent-${secondSource.id}`;
    const basisKey = `retention-reopen-basis-${secondSource.id}`;
    const receiptId = `e-11-action-${nextReader.id}-0`;
    const inputSourceEventIds = [stoneSource.id, secondSource.id].sort();
    const inputWitnesses = [{
      version: 'record-use-input-witness-v1',
      role: 'input',
      personId: nextReader.id,
      stackId: 'retention-reopen-stone-stack',
      materialId: api.Material.StoneTool,
      quantity: 1,
      sourceEventIds: [stoneSource.id],
    }, {
      version: 'record-use-input-witness-v1',
      role: 'input',
      personId: nextReader.id,
      stackId: 'retention-reopen-wood-stack',
      materialId: api.Material.Wood,
      quantity: 1,
      sourceEventIds: [secondSource.id],
    }];
    const goal = {
      kind: 'record-replication-receipt',
      basisKey,
      readerId: nextReader.id,
      projectId,
      recordId,
      recordVersion: 1,
      techniqueId,
      ruleSignature: 'combine:stone-tool+wood->spear',
      expectedOutputMaterialId: api.Material.Spear,
    };
    const basis = {
      version: 'record-use-basis-v3',
      basisKey,
      projectId,
      projectOwnerId: nextReader.id,
      readerId: nextReader.id,
      recordAuthorId: nextAuthor.id,
      demand: { kind: 'project-deficit', projectId, deficitSourceIds: [] },
      recordId,
      knowledgeId: techniqueId,
      codebookId,
      techniqueId,
      ruleSignature: goal.ruleSignature,
      projectPressure: 70,
      expectedOutputMaterialId: api.Material.Spear,
      createdAtMonth: 10,
      projectSourceEventIds: [],
      recordSourceEventIds: [],
      codebookSourceEventIds: [],
      inputSourceEventIds,
      sourceFactIds: [...inputSourceEventIds],
      carrierSource: {
        kind: 'inventory',
        personId: nextReader.id,
        stackId: 'retention-reopen-record-carrier',
      },
      acquisitionRequired: false,
      purpose: 'replicate',
      recordVersion: 1,
      projectRenewalBasisKey: 'retention-reopen-project-opening',
      inputWitnesses,
    };
    const receipt = {
      id: receiptId,
      kind: 'action',
      actionTick: 1,
      atMonth: 11,
      orderInMonth: 0,
      planningTick: 1,
      orderInTick: 0,
      cellId: nextReader.position.cellId,
      who: nextReader.id,
      cause: 'intent',
      intentId,
      action: {
        kind: 'act',
        operation: 'combine',
        targets: [{
          kind: 'inventory-stack',
          personId: nextReader.id,
          stackId: 'retention-reopen-stone-stack',
        }, {
          kind: 'inventory-stack',
          personId: nextReader.id,
          stackId: 'retention-reopen-wood-stack',
        }],
      },
      fromCellId: nextReader.position.cellId,
      toCellId: nextReader.position.cellId,
      fromZ: nextReader.position.z,
      toZ: nextReader.position.z,
      pathSegment: [nextReader.position.cellId],
      status: 'completed',
      result: 'verified fixture replication receipt',
      diff: {
        recordUseReplicationReceipt: true,
        recordUsePurpose: 'replicate',
        recordUseStage: 'replicate',
        recordUseBasisKey: basisKey,
        recordUseReaderId: nextReader.id,
        recordUseProjectId: projectId,
        recordUseRecordId: recordId,
        recordUseRecordVersion: 1,
        recordUseKnowledgeId: techniqueId,
        recordUseTechniqueId: techniqueId,
        recordUseRuleSignature: goal.ruleSignature,
        recordUseRecordAuthorId: nextAuthor.id,
        recordUseExpectedOutputMaterialId: api.Material.Spear,
        recordUseProjectRenewalBasisKey: basis.projectRenewalBasisKey,
        recordUseInputSourceEventIds: [...inputSourceEventIds],
        recordUseInputWitnesses: structuredClone(inputWitnesses),
        inputMaterialIds: [api.Material.StoneTool, api.Material.Wood],
        outputMaterialId: api.Material.Spear,
        techniqueId,
        sourceEventId: receiptId,
      },
    };
    state.records.push({
      id: recordId,
      authorId: nextAuthor.id,
      knowledgeId: techniqueId,
      codebookId,
      kind: 'technique',
      summary: 'fixture technique record',
      version: 1,
      createdAtMonth: 1,
      sourceEventIds: [],
    });
    nextReader.inventory.push({
      id: 'retention-reopen-record-carrier',
      materialId: api.Material.WoodTablet,
      quantity: 1,
      recordPayloadId: recordId,
      sourceEventIds: [],
    });
    nextReader.knowledge.push({
      id: techniqueId,
      kind: 'technique',
      summary: 'reliable replicated technique',
      confidence: 70,
      learnedAtMonth: 11,
      sourceEventIds: [receiptId],
    }, {
      id: codebookId,
      kind: 'codebook',
      summary: 'fixture codebook',
      confidence: 70,
      learnedAtMonth: 1,
      sourceEventIds: [],
    });
    state.projects.push({
      id: projectId,
      status: 'completed',
      desiredFunction: 'safer-hunting',
      ownerId: nextReader.id,
      beneficiaryIds: [nextAuthor.id],
      contributorIds: [nextAuthor.id],
      triggerFactIds: [],
      reservations: [],
      createdAtMonth: 10,
      completedAtMonth: 11,
      actionEventIds: [receiptId],
      completionEventIds: [receiptId],
    });
    state.intents.push({
      id: intentId,
      ownerId: nextReader.id,
      summary: 'replicate another author record',
      domain: 'inquiry',
      goal,
      nextAction: structuredClone(receipt.action),
      status: 'completed',
      createdAtMonth: 10,
      lastProgressAtMonth: 11,
      progress: 1,
      plannedDurationMonths: 1,
      sourceDecisionEventId: receiptId,
      sourceFactIds: [...inputSourceEventIds],
      actionEventIds: [receiptId],
      replanCount: 0,
      recordUseBasis: basis,
      recordUseStage: 'replicate',
      goalOutcome: {
        kind: 'achieved',
        resolvedAtMonth: 11,
        sourceEventIds: [receiptId],
      },
    });
    api.appendCommittedEvents(state, [receipt]);
    state.clock.elapsedMonths = 11;
    state.lastStep = [receipt];
    return { state, receipt, inputSourceEventIds };
  }

  async function encodeSuccessor(fullState) {
    const encoded = await api.encodeSegmentedRunState(
      fullState,
      { mode: 'append', previous: rootA.metadata },
      { maxEventsPerSegmentForTests: 4 },
    );
    retainEncoded(encoded);
    return encoded;
  }

  async function decodeBounded(
    encoded,
    pinnedEventIndexes = [],
    revision = 2,
    month = 11,
  ) {
    return api.decodeBoundedGameplayRunStateWithPhysicalProjection(
      encoded.root,
      readChunk,
      {
        hotEventLimit: 1,
        pinnedEventIndexes,
        observerAuthority: {
          stateHash: encoded.root.hash,
          revision,
          month,
          lastMaterializedMilestoneCount: stateA.derived.milestones.length,
        },
      },
    );
  }

  async function publishAndReopen(
    fixture,
    expectRecordGroup,
    { preinstallWarmRegistry = false } = {},
  ) {
    const encodedB = await encodeSuccessor(fixture.state);
    const unbridged = await decodeBounded(encodedB);
    const unbridgedFold = api.beginHistoryRetentionProjection(
      unbridged.state,
      { stateHash: encodedB.root.hash },
    );
    assert.equal(unbridgedFold.demandGroupsByKey.has(RECORD_INPUT_GROUP), false,
      'a new bounded history-array identity cannot see cold inputs before verified publication bridge');

    const publicationState = (await decodeBounded(encodedB)).state;
    if (preinstallWarmRegistry) {
      const [decodedWarmGenericSource] = api.materializeVerifiedRunHistoryPinnedEvents(
        api.parseRunStateRoot(rootA.root),
        readChunk,
        [warmGenericPin.absoluteIndex],
      );
      assert.equal(decodedWarmGenericSource?.event.id, warmGenericSource.id);
      api.registerRetainedColdWorldEventFacts(publicationState, [{
        absoluteIndex: warmGenericPin.absoluteIndex,
        eventId: warmGenericSource.id,
        event: decodedWarmGenericSource.event,
        leaseKeys: [...warmGenericPin.leaseKeys],
      }]);
      const warmLeaseKey = warmGenericPin.leaseKeys[0];
      assert.ok(warmLeaseKey);
      assert.equal(api.worldEventById(publicationState, warmGenericSource.id)?.id,
        warmGenericSource.id, 'warm generic body must resolve before record bridge');
      assert.ok(api.retainedColdWorldEventsForLease(publicationState, warmLeaseKey)
        .some((event) => event.id === warmGenericSource.id),
      'warm generic lease must resolve before record bridge');
      const augmentedWarmLeaseKey = 'fixture:warm-generic-augmentation';
      api.augmentRetainedColdWorldEventFacts(publicationState, [{
        absoluteIndex: warmGenericPin.absoluteIndex,
        eventId: warmGenericSource.id,
        event: decodedWarmGenericSource.event,
        leaseKeys: [warmLeaseKey, warmLeaseKey, augmentedWarmLeaseKey],
      }]);
      assert.equal(api.retainedColdWorldEventsForLease(publicationState, warmLeaseKey)
        .filter((event) => event.id === warmGenericSource.id).length, 1,
      'same identity merge must deduplicate an existing lease');
      assert.equal(api.retainedColdWorldEventsForLease(publicationState, augmentedWarmLeaseKey)
        .filter((event) => event.id === warmGenericSource.id).length, 1,
      'same identity merge must add one stable new lease');
      assert.throws(() => api.augmentRetainedColdWorldEventFacts(publicationState, [{
        absoluteIndex: warmGenericPin.absoluteIndex,
        eventId: unleasedWoodSource.id,
        event: unleasedWoodSource,
        leaseKeys: ['fixture:conflicting-warm-identity'],
      }]), /identity/u, 'same ordinal with another event ID must fail closed');
    }
    const successor = await api.projectHistoryRetentionFromVerifiedSuccessor(
      projectionA,
      rootA.root,
      publicationState,
      encodedB.root,
      readChunk,
    );
    if (preinstallWarmRegistry) {
      const warmLeaseKey = warmGenericPin.leaseKeys[0];
      assert.equal(api.worldEventById(publicationState, warmGenericSource.id)?.id,
        warmGenericSource.id, 'record bridge must not erase an existing warm generic body');
      assert.ok(api.retainedColdWorldEventsForLease(publicationState, warmLeaseKey)
        .some((event) => event.id === warmGenericSource.id),
      'record bridge must preserve the existing warm generic lease');
      assert.equal(api.retainedColdWorldEventsForLease(
        publicationState,
        'fixture:warm-generic-augmentation',
      ).filter((event) => event.id === warmGenericSource.id).length, 1,
      'record bridge must preserve the augmented warm lease');
    }
    const rootMetadata = api.parseRunStateRoot(encodedB.root);
    const projectionB = api.decodeHistoryRetentionSidecar(successor.encoded.chunk, {
      reference: successor.encoded.reference,
      boundary: {
        authority: { stateHash: encodedB.root.hash },
        target: {
          eventCount: rootMetadata.eventCount,
          tailEventId: publicationState.world.historyCursor.tailEventId,
        },
      },
    });
    assert.equal(
      projectionB.demandGroups.some((group) => group.groupKey === RECORD_INPUT_GROUP),
      expectRecordGroup,
    );
    assert.deepEqual(
      [...projectionB.millLaborPersonIds].sort(),
      [...unbridgedFold.millLaborPersonIds].sort(),
      'record cold visibility bridge must not alter mill-labor selector identity',
    );
    const unbridgedKeys = new Set(unbridgedFold.demandGroupsByKey.keys());
    const publicationKeys = new Set(
      projectionB.continuationBasis.sourceDemand.groups.map((group) => group.groupKey),
    );
    const addedKeys = [...publicationKeys].filter((key) => !unbridgedKeys.has(key)).sort();
    const removedKeys = [...unbridgedKeys].filter((key) => !publicationKeys.has(key)).sort();
    assert.deepEqual(addedKeys, expectRecordGroup ? [RECORD_INPUT_GROUP] : [],
      'verified cold input visibility must have one auditable demand effect');
    assert.deepEqual(removedKeys, [],
      'verified cold input visibility must not remove an unrelated demand group');

    const hotStartIndex = Math.max(0, rootMetadata.eventCount - 1);
    const coldPinIndexes = projectionB.pins
      .filter((pin) => pin.absoluteIndex < hotStartIndex)
      .map((pin) => pin.absoluteIndex);
    const reopened = await decodeBounded(encodedB, coldPinIndexes);
    const projectPressureSources = api.materializeVerifiedRunHistoryPinnedEvents(
      rootMetadata,
      readChunk,
      api.projectPressureColdMaterializationOrdinals(
        reopened.state,
        projectionB,
        reopened.pinnedEvents,
      ),
    );
    const liveSocialSources = api.materializeVerifiedRunHistoryPinnedEvents(
      rootMetadata,
      readChunk,
      api.liveSocialColdMaterializationOrdinals(
        reopened.state,
        projectionB,
        reopened.pinnedEvents,
      ),
    );
    api.adoptStoreDecodedBoundedSimulationState(
      reopened.state,
      encodedB.root.hash,
      projectionB,
      reopened.pinnedEvents,
      projectPressureSources,
      [],
      liveSocialSources,
      [],
      reopened.physicalProjection,
    );
    assert.equal(
      api.historyRetentionDemandFingerprintForShell(reopened.state),
      projectionB.demandFingerprint,
      'strict decode/adopt must reproduce publication demand exactly',
    );
    return { encodedB, projectionB, reopened };
  }

  const valid = replicationSuccessor(leasedWoodSource);
  assert.equal(
    api.isIndependentRecordReplicationReceiptFact(valid.state, valid.receipt),
    true,
    'full authoritative history must validate the crafted receipt',
  );
  const validResult = await publishAndReopen(valid, true, { preinstallWarmRegistry: true });
  const validGroup = validResult.projectionB.demandGroups.find((group) => (
    group.groupKey === RECORD_INPUT_GROUP
  ));
  assert.deepEqual(validGroup?.eventIds, valid.inputSourceEventIds,
    'publication must retain the receipt exact input sources');

  const stateC = structuredClone(valid.state);
  // Synthetic storage-boundary case: retain the already sealed receipt shell
  // while marking every project participant dead. Real death processing may
  // also clear inventory, so this proves selector/reopen compatibility rather
  // than a natural civilization death episode.
  for (const personId of [reader.id, author.id]) {
    const person = stateC.people.find((candidate) => candidate.id === personId);
    assert.ok(person);
    person.diedAtMonth = 12;
    person.body.health = 0;
  }
  const successorFiller = {
    id: 'retention-reopen-successor-filler',
    kind: 'environment',
    atMonth: 12,
    orderInMonth: 0,
    planningTick: 0,
    orderInTick: 0,
    cellId: 0,
    change: 'material',
    result: 'next successor without a new receipt',
    diff: { fixtureKind: 'record-retention-reopen-successor' },
  };
  api.appendCommittedEvents(stateC, [successorFiller]);
  stateC.clock.elapsedMonths = 12;
  stateC.lastStep = [successorFiller];
  const rootC = await api.encodeSegmentedRunState(
    stateC,
    { mode: 'append', previous: validResult.encodedB.metadata },
    { maxEventsPerSegmentForTests: 4 },
  );
  retainEncoded(rootC);
  const publicationC = (await decodeBounded(rootC, [], 3, 12)).state;
  assert.ok(publicationC.intents.some((intent) => intent.id === valid.receipt.intentId),
    'canonical completed replication intent must survive bounded shell pruning after reader death');
  assert.equal(
    api.beginHistoryRetentionProjection(
      publicationC,
      { stateHash: rootC.root.hash },
    ).demandGroupsByKey.has(RECORD_INPUT_GROUP),
    false,
    'without the bridge the next generation would forget its cold receipt and inputs',
  );
  const successorC = await api.projectHistoryRetentionFromVerifiedSuccessor(
    validResult.projectionB,
    validResult.encodedB.root,
    publicationC,
    rootC.root,
    readChunk,
  );
  const projectionC = api.decodeHistoryRetentionSidecar(successorC.encoded.chunk, {
    reference: successorC.encoded.reference,
    boundary: {
      authority: { stateHash: rootC.root.hash },
      target: {
        eventCount: rootC.metadata.eventCount,
        tailEventId: publicationC.world.historyCursor.tailEventId,
      },
    },
  });
  assert.ok(projectionC.demandGroups.some((group) => group.groupKey === RECORD_INPUT_GROUP),
    'a later successor must preserve the already verified cold receipt witness');
  assert.equal(
    projectionC.continuationBasis.directMatches.some((match) => (
      match.eventId === valid.receipt.id
    )),
    false,
    'after every completed-project participant dies, the old receipt must lose ordinary direct membership',
  );
  const modernSelectorC = projectionC.continuationBasis.selectiveMatches.find((item) => (
    item.leaseKey === RECORD_LEASE
  ));
  assert.deepEqual(
    modernSelectorC?.matches.map((match) => match.eventId),
    [valid.receipt.id],
    'the old receipt must survive only through the exact modern-record selector identity',
  );
  const rootCMetadata = api.parseRunStateRoot(rootC.root);
  const reopenedC = await decodeBounded(
    rootC,
    projectionC.pins.filter((pin) => (
      pin.absoluteIndex < Math.max(0, rootCMetadata.eventCount - 1)
    )).map((pin) => pin.absoluteIndex),
    3,
    12,
  );
  const projectPressureSourcesC = api.materializeVerifiedRunHistoryPinnedEvents(
    rootCMetadata,
    readChunk,
    api.projectPressureColdMaterializationOrdinals(
      reopenedC.state,
      projectionC,
      reopenedC.pinnedEvents,
    ),
  );
  const liveSocialSourcesC = api.materializeVerifiedRunHistoryPinnedEvents(
    rootCMetadata,
    readChunk,
    api.liveSocialColdMaterializationOrdinals(
      reopenedC.state,
      projectionC,
      reopenedC.pinnedEvents,
    ),
  );
  api.adoptStoreDecodedBoundedSimulationState(
    reopenedC.state,
    rootC.root.hash,
    projectionC,
    reopenedC.pinnedEvents,
    projectPressureSourcesC,
    [],
    liveSocialSourcesC,
    [],
    reopenedC.physicalProjection,
  );
  assert.equal(
    api.historyRetentionDemandFingerprintForShell(reopenedC.state),
    projectionC.demandFingerprint,
    'the later strict reopen must reproduce the retained record demand',
  );

  const stateD = structuredClone(stateC);
  const fourthGenerationFiller = {
    id: 'retention-reopen-fourth-generation-filler',
    kind: 'environment',
    atMonth: 13,
    orderInMonth: 0,
    planningTick: 0,
    orderInTick: 0,
    cellId: 0,
    change: 'material',
    result: 'selector-only record witness successor',
    diff: { fixtureKind: 'record-retention-reopen-selector-only' },
  };
  api.appendCommittedEvents(stateD, [fourthGenerationFiller]);
  stateD.clock.elapsedMonths = 13;
  stateD.lastStep = [fourthGenerationFiller];
  const rootD = await api.encodeSegmentedRunState(
    stateD,
    { mode: 'append', previous: rootC.metadata },
    { maxEventsPerSegmentForTests: 4 },
  );
  retainEncoded(rootD);
  const publicationD = (await decodeBounded(rootD, [], 4, 13)).state;
  assert.equal(
    api.beginHistoryRetentionProjection(
      publicationD,
      { stateHash: rootD.root.hash },
    ).demandGroupsByKey.has(RECORD_INPUT_GROUP),
    false,
    'a fresh fourth-generation shell cannot see the selector-only cold receipt before the bridge',
  );
  const successorD = await api.projectHistoryRetentionFromVerifiedSuccessor(
    projectionC,
    rootC.root,
    publicationD,
    rootD.root,
    readChunk,
  );
  const projectionD = api.decodeHistoryRetentionSidecar(successorD.encoded.chunk, {
    reference: successorD.encoded.reference,
    boundary: {
      authority: { stateHash: rootD.root.hash },
      target: {
        eventCount: rootD.metadata.eventCount,
        tailEventId: publicationD.world.historyCursor.tailEventId,
      },
    },
  });
  assert.ok(projectionD.demandGroups.some((group) => group.groupKey === RECORD_INPUT_GROUP),
    'the exact modern selector must carry the old receipt into a fourth generation');
  const rootDMetadata = api.parseRunStateRoot(rootD.root);
  const reopenedD = await decodeBounded(
    rootD,
    projectionD.pins.filter((pin) => (
      pin.absoluteIndex < Math.max(0, rootDMetadata.eventCount - 1)
    )).map((pin) => pin.absoluteIndex),
    4,
    13,
  );
  const projectPressureSourcesD = api.materializeVerifiedRunHistoryPinnedEvents(
    rootDMetadata,
    readChunk,
    api.projectPressureColdMaterializationOrdinals(
      reopenedD.state,
      projectionD,
      reopenedD.pinnedEvents,
    ),
  );
  const liveSocialSourcesD = api.materializeVerifiedRunHistoryPinnedEvents(
    rootDMetadata,
    readChunk,
    api.liveSocialColdMaterializationOrdinals(
      reopenedD.state,
      projectionD,
      reopenedD.pinnedEvents,
    ),
  );
  api.adoptStoreDecodedBoundedSimulationState(
    reopenedD.state,
    rootD.root.hash,
    projectionD,
    reopenedD.pinnedEvents,
    projectPressureSourcesD,
    [],
    liveSocialSourcesD,
    [],
    reopenedD.physicalProjection,
  );
  assert.equal(
    api.historyRetentionDemandFingerprintForShell(reopenedD.state),
    projectionD.demandFingerprint,
    'the fourth-generation strict reopen must reproduce selector-carried record demand',
  );

  const forged = replicationSuccessor(leasedWoodSource);
  forged.receipt.diff.outputMaterialId = api.Material.Wood;
  assert.equal(
    api.isIndependentRecordReplicationReceiptFact(forged.state, forged.receipt),
    false,
    'a marker with leased inputs but the wrong physical output is not a receipt',
  );
  const forgedResult = await publishAndReopen(forged, false);
  assert.equal(
    forgedResult.projectionB.pins.some((pin) => (
      pin.leaseKeys.includes(RECORD_LEASE)
    )),
    false,
    'a forged marker must not manufacture an observer record lease',
  );

  const unleased = replicationSuccessor(unleasedWoodSource);
  assert.equal(
    api.isIndependentRecordReplicationReceiptFact(unleased.state, unleased.receipt),
    true,
    'the full ledger control proves the unleased input is otherwise a valid source fact',
  );
  const unleasedResult = await publishAndReopen(unleased, false);
  assert.equal(
    unleasedResult.projectionB.pins.some((pin) => pin.eventId === unleasedWoodSource.id),
    false,
    'an unleased previous-prefix input must not be pulled into the new projection',
  );
  assert.equal(
    api.worldEventById(unleasedResult.reopened.state, unleasedWoodSource.id),
    undefined,
    'strict reopen must not expose an unleased cold body through generic by-id lookup',
  );

  console.log(JSON.stringify({
    result: 'passed',
    previousEventCount: rootA.metadata.eventCount,
    nextEventCount: validResult.encodedB.metadata.eventCount,
    fourthGenerationEventCount: rootD.metadata.eventCount,
    recordInputGroup: validGroup.groupKey,
    recordInputEventIds: validGroup.eventIds,
    millLaborPersonCount: validResult.projectionB.millLaborPersonIds.length,
    warmGenericRegistryPreserved: true,
    forgedReceiptRetained: false,
    unleasedInputRetained: false,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
