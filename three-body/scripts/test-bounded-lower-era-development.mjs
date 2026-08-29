import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-bounded-lower-era-'));

const CAPABILITY_KEYS = ['processed-wood', 'masonry-stone', 'bronze', 'iron'];

function ref(eventId, absoluteIndex = 0, atMonth = 1, who = 'person-a') {
  return { eventId, absoluteIndex, atMonth, who };
}

function emptyCapability(key) {
  return {
    key,
    successfulBatchCount: 0,
    failedBatchCount: 0,
    adoptedActionCount: 0,
    firstSuccessfulMonth: null,
    lastSuccessfulMonth: null,
    producerIds: [],
    productionSiteMaterialIds: [],
    successfulBatchEvidence: [],
    failedBatchEvidence: [],
    adoptedActionEvidence: [],
  };
}

function capabilitySet(overrides = {}) {
  return Object.fromEntries(CAPABILITY_KEYS.map((key) => [
    key,
    { ...emptyCapability(key), ...(overrides[key] ?? {}) },
  ]));
}

function compactIndex(index) {
  const next = structuredClone(index);
  for (const component of Object.values(next.components)) component.evidence = {};
  return next;
}

function hotFact(id, atMonth) {
  return {
    id,
    kind: 'environment',
    atMonth,
    orderInMonth: 0,
    planningTick: 0,
    orderInTick: 0,
    cellId: 0,
    change: 'fixture',
    result: 'bounded lower-era hot-tail sentinel',
    diff: {},
  };
}

try {
  const entry = path.join(temporaryDirectory, 'entry.ts');
  const output = path.join(temporaryDirectory, 'fixture.mjs');
  writeFileSync(entry, [
    `export * from ${JSON.stringify(path.join(workspace, 'server/bounded-observer-civilization-materializer.ts'))};`,
    `export * from ${JSON.stringify(path.join(workspace, 'server/bounded-observer-derived-materializer.ts'))};`,
    `export * from ${JSON.stringify(path.join(workspace, 'server/observer-derived-history-projection.ts'))};`,
    `export * from ${JSON.stringify(path.join(workspace, 'server/observer-derived-history-codec.ts'))};`,
    `export { calculateCivilizationIndex, calculateCertifiedCivilizationIndexFloor } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/civilization-index.ts'))};`,
    `export { observeFunctionalBuildings, observeMaterialCapabilities, supportingMaterialCapabilityInstitutionKeys } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/era-progression.ts'))};`,
    `export { observeSimulation } from ${JSON.stringify(path.join(workspace, 'src/game/eland/projection/derived-observations.ts'))};`,
    `export { createInitialState } from ${JSON.stringify(path.join(workspace, 'src/game/eland/application/simulation/state-lifecycle.ts'))};`,
    `export { derivePhysicalStructureIndex } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/physical-structure-index.ts'))};`,
    `export { Material } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/material.ts'))};`,
  ].join('\n'));
  buildSync({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm' });
  const api = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

  const bronzeDutyFunctions = [
    'copper-charge',
    'copper-smelting',
    'tin-charge',
    'tin-smelting',
    'bronze-alloying',
    'bronze-tooling',
    'bronze-workshop',
  ];
  const ironDutyFunctions = [
    'iron-charge',
    'iron-reduction',
    'iron-working',
    'iron-tooling',
    'iron-workshop',
  ];

  function exercisedDutyFixture() {
    const state = api.createInitialState(
      { project() { return { kind: 'deferred', reason: 'bounded development fixture' }; } },
      81_000,
      { endpoint: { kind: 'months', value: 120 } },
    );
    const collectiveId = 'collective:workshop-metalwork-name-must-not-classify';
    const rules = [];
    const mandates = [];
    const addDuty = (desiredFunction, exercise, ruleId) => {
      const projectDuty = {
        version: 'recurring-project-duty-subject-v1',
        projectKind: 'production',
        desiredFunction,
        progressKind: 'action-progress',
      };
      rules.push({
        id: ruleId,
        collectiveId,
        method: 'unanimous',
        mandateDurationMonths: 12,
        status: 'active',
        acceptedAtMonth: 1,
        proposalAgreementId: `agreement:${ruleId}`,
        sourceEventIds: [`rule-source:${ruleId}`],
        scope: 'assign-recurring-duty',
        projectDuty,
      });
      mandates.push({
        id: `mandate:${ruleId}`,
        collectiveId,
        decisionRuleId: ruleId,
        holderId: 'duty-holder',
        validFromMonth: 1,
        validUntilMonth: 24,
        status: 'active',
        proposalAgreementId: `mandate-agreement:${ruleId}`,
        sourceEventIds: [`mandate-source:${ruleId}`],
        contributionEventIds: [],
        distributionEventIds: [],
        scope: 'assign-recurring-duty',
        projectDuty,
        projectId: `project:${ruleId}`,
        dutyProgressEventIds: exercise === 'completion-only' ? [] : [`progress:${ruleId}`],
        dutyCompletionEventIds: exercise === 'progress-only' ? [] : [`completion:${ruleId}`],
      });
    };
    for (const desiredFunction of [...bronzeDutyFunctions, ...ironDutyFunctions]) {
      addDuty(desiredFunction, 'exercised', `rule:${desiredFunction}`);
    }
    addDuty('bronze-tooling', 'progress-only', 'rule:progress-only');
    addDuty('iron-tooling', 'completion-only', 'rule:completion-only');
    addDuty(
      'prepared-food',
      'exercised',
      'rule:unrelated-bronze-workshop-iron-workshop-metalwork-apprentice',
    );
    const coordinateRuleId = 'rule:coordinate-metalwork';
    rules.push({
      id: coordinateRuleId,
      collectiveId,
      method: 'unanimous',
      mandateDurationMonths: 12,
      status: 'active',
      acceptedAtMonth: 1,
      proposalAgreementId: 'agreement:coordinate',
      sourceEventIds: ['rule-source:coordinate'],
      scope: 'coordinate-material',
      materialId: api.Material.Bronze,
    });
    mandates.push({
      id: 'mandate:coordinate',
      collectiveId,
      decisionRuleId: coordinateRuleId,
      holderId: 'duty-holder',
      validFromMonth: 1,
      validUntilMonth: 24,
      status: 'active',
      proposalAgreementId: 'mandate-agreement:coordinate',
      sourceEventIds: ['mandate-source:coordinate'],
      contributionEventIds: ['coordinate-contribution'],
      distributionEventIds: ['coordinate-distribution'],
      scope: 'coordinate-material',
      materialId: api.Material.Bronze,
    });
    state.collectives = [{
      id: collectiveId,
      purposeSummary: 'fixture recurring duties',
      status: 'active',
      foundedAtMonth: 1,
      formationAgreementId: 'agreement:formation',
      memberships: [],
      decisionRules: rules,
      mandates,
      sourceEventIds: ['collective-source'],
    }];
    const fullInstitutions = api.observeSimulation(state, { structures: [] }).institutions;
    const target = {
      stateHash: '9'.repeat(64),
      eventCount: state.world.historyCursor.eventCount,
      tailEventId: state.world.historyCursor.tailEventId,
    };
    const demand = {
      settledCultivationProjects: [],
      residentialStructures: [],
      retainedEventIds: [],
      futureEventIds: [],
    };
    const projection = api.projectObserverDerivedHistoryFromFullHistory(
      state.world.past,
      target,
      demand,
    );
    const encoded = api.encodeObserverDerivedHistorySidecar({ sourceDemand: demand, projection });
    const decoded = api.decodeObserverDerivedHistorySidecar(encoded.chunk, {
      reference: encoded.reference,
      boundary: { target },
    });
    state.world.physicalStructureIndex = api.derivePhysicalStructureIndex(state);
    const bounded = api.materializeDecodedBoundedObserverDerivedSubset(state, decoded, target);
    assert.deepEqual(bounded.institutions, fullInstitutions,
      'the public bounded-derived materializer must emit the exact full observer institution keys');
    return { collectiveId, institutions: bounded.institutions };
  }

  function materialAction(id, atMonth, who, diff, orderInMonth = 0) {
    return {
      id,
      kind: 'action',
      actionTick: 1,
      atMonth,
      orderInMonth,
      planningTick: 1,
      orderInTick: orderInMonth,
      cellId: 0,
      who,
      cause: 'intent',
      action: { kind: 'act', operation: 'exert', targets: [] },
      fromCellId: 0,
      toCellId: 0,
      fromZ: 1,
      toZ: 1,
      pathSegment: [0],
      status: 'completed',
      result: id,
      diff,
    };
  }

  function facility({ id, materialId, useCount, users = ['person-a', 'person-b'] }) {
    return {
      id,
      kind: materialId === api.Material.Granary ? 'storage' : 'core',
      materialId,
      cellId: 0,
      z: 2,
      installedAtMonth: 1,
      installationEventIds: [`cold-install:${id}`],
      useEventIds: [`cold-use-witness:${id}`],
      userIds: users,
      functionSummary: 'fixture',
      active: true,
      observationVersion: 'bounded-functional-building-observation-v1',
      evidenceSemantics: 'bounded-witnesses-with-exact-counts-v1',
      installationCount: 1,
      useCount,
    };
  }

  function derivedBundle(state, target, {
    capabilities,
    facilities = [],
    institutions = [],
    regions = [],
    established = null,
  }) {
    state.derived = {
      ...state.derived,
      practices: [],
      institutions: structuredClone(institutions),
      regions: structuredClone(regions),
      structures: [],
      functionalBuildings: structuredClone(facilities),
    };
    const projection = {
      target: { ...target },
      reducedThrough: { eventCount: target.eventCount, tailEventId: target.tailEventId },
      materialCapabilities: structuredClone(capabilities),
      establishedCultivationWitness: structuredClone(established),
    };
    const materialization = {
      target: { ...target },
      evidenceSemantics: 'bounded-witnesses-with-exact-counts-v1',
      materialCapabilities: structuredClone(capabilities),
      functionalBuildings: structuredClone(facilities),
      institutions: structuredClone(institutions),
      regions: structuredClone(regions),
      structures: [],
    };
    return { projection, materialization };
  }

  function bind(state, month, hashCharacter, previousBasis = null, eventCount = 100) {
    state.clock.elapsedMonths = month;
    const event = hotFact(`hot-tail:${hashCharacter}:${month}`, month);
    state.world.past = [event];
    state.world.historyCursor = {
      version: 1,
      eventCount,
      hotStartIndex: eventCount - 1,
      tailEventId: event.id,
    };
    const source = { stateHash: hashCharacter.repeat(64), revision: Math.floor(month / 12) + 1, month };
    const basis = previousBasis ? {
      ...structuredClone(previousBasis),
      source,
      stage: state.civilization.stage,
      indexSnapshot: compactIndex(state.civilization.civilizationIndex),
    } : {
      version: 2,
      profile: 'bounded-gameplay-hot-observer-v2',
      source,
      milestoneCount: state.derived.milestones.length,
      stage: state.civilization.stage,
      indexSnapshot: compactIndex(state.civilization.civilizationIndex),
      developmentSnapshot: null,
    };
    state.civilization.civilizationIndex = structuredClone(basis.indexSnapshot);
    state.lastMaterializedObserverBasis = structuredClone(basis);
    return {
      basis,
      target: { stateHash: source.stateHash, eventCount, tailEventId: event.id },
    };
  }

  const dutyFixture = exercisedDutyFixture();
  const dutyKeys = dutyFixture.institutions.map((institution) => institution.key);
  assert.equal(dutyKeys.some((key) => key.includes('rule%3Aprogress-only')), false,
    'progress without completion is not an exercised institution');
  assert.equal(dutyKeys.some((key) => key.includes('rule%3Acompletion-only')), false,
    'completion without matching progress is not an exercised institution');
  for (const desiredFunction of bronzeDutyFunctions) {
    assert.ok(dutyKeys.includes([
      'recurring-duty-capability',
      'v1',
      'bronze',
      desiredFunction,
      encodeURIComponent(dutyFixture.collectiveId),
      encodeURIComponent(`rule:${desiredFunction}`),
    ].join(':')), `bronze duty ${desiredFunction} must be classified from the typed subject`);
  }
  for (const desiredFunction of ironDutyFunctions) {
    assert.ok(dutyKeys.includes([
      'recurring-duty-capability',
      'v1',
      'iron',
      desiredFunction,
      encodeURIComponent(dutyFixture.collectiveId),
      encodeURIComponent(`rule:${desiredFunction}`),
    ].join(':')), `iron duty ${desiredFunction} must be classified from the typed subject`);
  }
  const unrelatedDutyKey = dutyKeys.find((key) => key.includes(encodeURIComponent(
    'rule:unrelated-bronze-workshop-iron-workshop-metalwork-apprentice',
  )));
  assert.ok(unrelatedDutyKey?.startsWith('recurring-duty-capability:v1:other:prepared-food:'),
    'an unrelated exercised duty remains an institution but carries an explicit non-capability class');
  assert.deepEqual(api.supportingMaterialCapabilityInstitutionKeys('bronze', [unrelatedDutyKey]), []);
  assert.deepEqual(api.supportingMaterialCapabilityInstitutionKeys('iron', [unrelatedDutyKey]), [],
    'collective and rule ID substrings cannot classify a recurring duty');
  assert.deepEqual(api.supportingMaterialCapabilityInstitutionKeys('bronze', [
    'recurring-duty-capability:v1:bronze-extra:bronze-tooling:collective:rule',
    'recurring-duty-capability:v1:bronze:iron-workshop:collective:rule',
    'recurring-duty-capability:v1:bronze:bronze-tooling:collective:rule:extra',
  ]), [], 'the controlled recurring-duty prefix requires exact complete segments');
  const legacyRecurringDutyKey = [
    'collective-coordination',
    'collective-with-metalwork-name',
    'decision-rule',
    'offer-recurring-duty-rule',
    '12',
    'collective',
    'production',
    'bronze-workshop',
    'action-progress',
    'project-with-apprentice-name',
  ].join(':');
  assert.deepEqual(
    api.supportingMaterialCapabilityInstitutionKeys('bronze', [legacyRecurringDutyKey]),
    [],
    'legacy generic recurring-duty IDs cannot classify metallurgy by embedded text',
  );
  assert.deepEqual(api.supportingMaterialCapabilityInstitutionKeys('iron', [legacyRecurringDutyKey]), []);
  const coordinateKey = dutyKeys.find((key) => key.startsWith('collective-coordination:'));
  assert.ok(coordinateKey);
  assert.deepEqual(api.supportingMaterialCapabilityInstitutionKeys('bronze', [coordinateKey]), [coordinateKey],
    'coordinate-material keeps its existing institution-fragment path');
  assert.deepEqual(
    api.supportingMaterialCapabilityInstitutionKeys('iron', ['metalwork-standard:smithy']),
    ['metalwork-standard:smithy'],
  );
  assert.deepEqual(
    api.supportingMaterialCapabilityInstitutionKeys('bronze', ['apprentice-craft:distributed-teaching']),
    ['apprentice-craft:distributed-teaching'],
    'existing metalwork-standard and apprentice paths remain unchanged',
  );

  const metallurgicalInstitutions = dutyFixture.institutions.filter((institution) => (
    institution.key.includes(':bronze:bronze-tooling:')
      || institution.key.includes(':iron:iron-tooling:')
  ));
  assert.equal(metallurgicalInstitutions.length, 2);
  const metallurgicalCapabilities = capabilitySet({
    bronze: {
      successfulBatchCount: 8,
      adoptedActionCount: 20,
      firstSuccessfulMonth: 1,
      lastSuccessfulMonth: 12,
      producerIds: ['smith-a', 'smith-b'],
      productionSiteMaterialIds: [api.Material.Foundry],
      successfulBatchEvidence: [ref('cold-bronze-batch', 1)],
      adoptedActionEvidence: [ref('cold-bronze-use', 2)],
    },
    iron: {
      successfulBatchCount: 10,
      adoptedActionCount: 28,
      firstSuccessfulMonth: 1,
      lastSuccessfulMonth: 18,
      producerIds: ['smith-a', 'smith-b'],
      productionSiteMaterialIds: [api.Material.Smithy],
      successfulBatchEvidence: [ref('cold-iron-batch', 3)],
      adoptedActionEvidence: [ref('cold-iron-use', 4)],
    },
  });

  const fullMetallurgy = api.createInitialState(
    { project() { return { kind: 'deferred', reason: 'bounded development fixture' }; } },
    81_005,
    { endpoint: { kind: 'months', value: 120 } },
  );
  const bronzeBatches = Array.from({ length: 8 }, (_, index) => materialAction(
    `full-bronze-batch:${index}`,
    index === 7 ? 12 : index + 1,
    index % 2 === 0 ? 'smith-a' : 'smith-b',
    { outputMaterialId: index === 0 ? api.Material.Foundry : api.Material.Bronze },
    index,
  ));
  const bronzeUses = Array.from({ length: 20 }, (_, index) => materialAction(
    `full-bronze-use:${index}`,
    12 + Math.floor(index / 10),
    index % 2 === 0 ? 'smith-a' : 'smith-b',
    { toolMaterialId: api.Material.BronzeTool },
    index,
  ));
  const ironBatches = Array.from({ length: 10 }, (_, index) => materialAction(
    `full-iron-batch:${index}`,
    index === 9 ? 18 : 1 + index * 2,
    index % 2 === 0 ? 'smith-a' : 'smith-b',
    { outputMaterialId: index === 0 ? api.Material.Smithy : api.Material.Iron },
    index,
  ));
  const ironUses = Array.from({ length: 28 }, (_, index) => materialAction(
    `full-iron-use:${index}`,
    18 + Math.floor(index / 14),
    index % 2 === 0 ? 'smith-a' : 'smith-b',
    { toolMaterialId: api.Material.IronTool },
    index,
  ));
  fullMetallurgy.world.past.push(...bronzeBatches, ...bronzeUses, ...ironBatches, ...ironUses);
  fullMetallurgy.world.historyCursor = {
    version: 1,
    eventCount: fullMetallurgy.world.past.length,
    hotStartIndex: 0,
    tailEventId: fullMetallurgy.world.past.at(-1).id,
  };
  fullMetallurgy.clock.elapsedMonths = 30;
  fullMetallurgy.derived.institutions = structuredClone(metallurgicalInstitutions);
  const fullMetallurgicalObservations = api.observeMaterialCapabilities(fullMetallurgy);
  assert.equal(fullMetallurgicalObservations.find((item) => item.key === 'bronze').stage, 'institutional');
  assert.equal(fullMetallurgicalObservations.find((item) => item.key === 'iron').stage, 'institutional');

  const masonry = capabilitySet({
    'masonry-stone': {
      successfulBatchCount: 6,
      adoptedActionCount: 16,
      firstSuccessfulMonth: 1,
      lastSuccessfulMonth: 6,
      producerIds: ['person-a', 'person-b'],
      productionSiteMaterialIds: [api.Material.Cistern],
      successfulBatchEvidence: [ref('cold-masonry-batch', 3)],
      adoptedActionEvidence: [ref('cold-masonry-adoption', 4)],
    },
  });
  const agrarianFacilities = [
    facility({ id: 'facility:granary', materialId: api.Material.Granary, useCount: 4 }),
    facility({ id: 'facility:hearth', materialId: api.Material.CouncilHearth, useCount: 1 }),
  ];
  const agrarianInstitutions = [
    { key: 'reserve-management:fixture', label: 'reserve', evidenceEventIds: ['cold-reserve'], note: '' },
    { key: 'water-maintenance:fixture', label: 'water', evidenceEventIds: ['cold-water'], note: '' },
    { key: 'workshop-practice:fixture', label: 'workshop', evidenceEventIds: ['cold-workshop'], note: '' },
  ];
  const agrarianRegions = [{
    id: 'cultivated', kind: 'cultivated', cells: Array.from({ length: 40 }, (_, index) => index),
    confidence: 1, evidenceEventIds: ['cold-cultivation'], firstObservedMonth: 1,
    lastObservedMonth: 12, label: 'fixture cultivated',
  }];
  const established = {
    projectId: 'settled-cultivation-project',
    plantingEvidence: [ref('cold-planting', 5)],
    harvestEvidence: [ref('cold-harvest', 6)],
  };

  const agrarian = api.createInitialState(
    { project() { return { kind: 'deferred', reason: 'bounded development fixture' }; } },
    81_001,
    { endpoint: { kind: 'months', value: 120 } },
  );
  agrarian.containers = [{
    id: 'fixture-granary', position: { x: 0, y: 0, z: 2 }, createdAtMonth: 1,
    sourceEventIds: ['cold-install:facility:granary'], capacity: 96,
    inventory: [{ id: 'stored-food', materialId: api.Material.Food, quantity: 12, sourceEventIds: ['cold-food'] }],
  }];
  const firstBoundary = bind(agrarian, 12, 'a');
  const firstDerived = derivedBundle(agrarian, firstBoundary.target, {
    capabilities: masonry,
    facilities: agrarianFacilities,
    institutions: agrarianInstitutions,
    regions: agrarianRegions,
    established,
  });
  const first = api.materializeBoundedCertifiedCivilizationDevelopment(
    agrarian,
    firstBoundary.basis,
    firstBoundary.target,
    firstDerived.materialization,
    firstDerived.projection,
  );
  assert.equal(first.civilizationIndexFloor.threshold120, 'proven');
  assert.ok(first.civilizationIndexFloor.total >= 120);
  assert.equal(first.observation.candidateEra, 'agrarian-settlement');
  assert.equal(first.observation.currentEra, 'primitive-tribe');
  assert.equal(first.observation.candidateSinceMonth, 12);
  assert.equal(first.observation.materialCapabilities.find((item) => item.key === 'masonry-stone').stage, 'institutional');
  assert.equal(first.evidenceSemantics, 'exact-counts-with-bounded-witnesses-v1');
  assert.ok(first.observation.supportingEventIds.includes('cold-masonry-batch'),
    '推出 hot window 的 sidecar witness 仍应可审计');
  assert.equal(agrarian.world.past.some((event) => event.id === 'cold-masonry-batch'), false,
    'fixture 必须确认 gate 不是从 hot tail 误算');

  agrarian.civilization.stage = first.nextBasis.stage;
  agrarian.civilization.civilizationIndex = structuredClone(first.nextBasis.indexSnapshot);
  delete agrarian.civilization.development;
  const secondBoundary = bind(agrarian, 24, 'b', first.nextBasis, 200);
  const secondDerived = derivedBundle(agrarian, secondBoundary.target, {
    capabilities: masonry,
    facilities: agrarianFacilities,
    institutions: agrarianInstitutions,
    regions: agrarianRegions,
    established,
  });
  const second = api.materializeBoundedCertifiedCivilizationDevelopment(
    agrarian,
    secondBoundary.basis,
    secondBoundary.target,
    secondDerived.materialization,
    secondDerived.projection,
  );
  assert.equal(second.observation.candidateSinceMonth, 12,
    '序列化/restart 只需 basis snapshot 即可延续 stability');
  assert.equal(second.observation.currentEra, 'agrarian-settlement');
  assert.equal(agrarian.civilization.stage, '农耕定居');

  const unknown = api.createInitialState(
    { project() { return { kind: 'deferred', reason: 'bounded development fixture' }; } },
    81_002,
    { endpoint: { kind: 'months', value: 120 } },
  );
  unknown.people = unknown.people.slice(0, 1);
  unknown.containers = structuredClone(agrarian.containers);
  const unknownFacilities = [
    facility({ id: 'facility:granary:unknown', materialId: api.Material.Granary, useCount: 2, users: ['one'] }),
    facility({ id: 'facility:hearth:unknown', materialId: api.Material.CouncilHearth, useCount: 1, users: ['one'] }),
  ];
  const unknownBoundary = bind(unknown, 12, 'c');
  const unknownDerived = derivedBundle(unknown, unknownBoundary.target, {
    capabilities: masonry,
    facilities: unknownFacilities,
    institutions: [agrarianInstitutions[0]],
    established,
  });
  const unknownResult = api.materializeBoundedCertifiedCivilizationDevelopment(
    unknown,
    unknownBoundary.basis,
    unknownBoundary.target,
    unknownDerived.materialization,
    unknownDerived.projection,
  );
  assert.equal(unknownResult.civilizationIndexFloor.threshold120, 'unknown');
  assert.deepEqual(unknownResult.gateCertainty.unknownGateIds, ['index:120']);
  assert.equal(unknownResult.observation.currentEra, 'primitive-tribe');
  assert.ok(unknownResult.observation.missingGateIds.includes('index:120'));

  const ancientState = api.createInitialState(
    { project() { return { kind: 'deferred', reason: 'bounded development fixture' }; } },
    81_003,
    { endpoint: { kind: 'months', value: 120 } },
  );
  const ancientBoundary = bind(ancientState, 18, 'd');
  const ancientDerived = derivedBundle(ancientState, ancientBoundary.target, {
    capabilities: metallurgicalCapabilities,
    institutions: metallurgicalInstitutions,
  });
  const ancient = api.materializeBoundedCertifiedCivilizationDevelopment(
    ancientState,
    ancientBoundary.basis,
    ancientBoundary.target,
    ancientDerived.materialization,
    ancientDerived.projection,
  );
  for (const key of ['bronze', 'iron']) {
    const fullCapability = fullMetallurgicalObservations.find((item) => item.key === key);
    const boundedCapability = ancient.observation.materialCapabilities.find((item) => item.key === key);
    assert.equal(boundedCapability.stage, fullCapability.stage,
      `${key} recurring-duty classification must have full/bounded stage parity`);
    assert.equal(boundedCapability.stage, 'institutional');
    assert.deepEqual(boundedCapability.supportingInstitutionKeys, fullCapability.supportingInstitutionKeys);
  }
  assert.equal(ancient.observation.currentEra, 'ancient-civilization',
    'institutional metallurgy must directly prove ancient without an agrarian sequence prerequisite');
  assert.equal(ancientState.civilization.stage, '古代文明');

  const full = api.createInitialState(
    { project() { return { kind: 'deferred', reason: 'bounded development fixture' }; } },
    81_004,
    { endpoint: { kind: 'months', value: 120 } },
  );
  full.clock.elapsedMonths = 18;
  full.derived.institutions = structuredClone(agrarianInstitutions);
  full.derived.regions = structuredClone(agrarianRegions);
  full.derived.functionalBuildings = structuredClone(agrarianFacilities).map((item) => ({
    ...item,
    useEventIds: Array.from({ length: item.useCount }, (_, index) => `${item.id}:full-use:${index}`),
  }));
  const fullCapabilities = api.observeMaterialCapabilities(full);
  const fullFloor = api.calculateCertifiedCivilizationIndexFloor(full, {
    materialCapabilities: fullCapabilities,
    facilities: full.derived.functionalBuildings.map((item) => ({
      id: item.id,
      active: item.active,
      useCount: item.useEventIds.length,
      userCount: item.userIds.length,
    })),
  });
  const exactIndex = api.calculateCivilizationIndex(full);
  assert.ok(fullFloor.total <= exactIndex.total,
    `certified floor ${fullFloor.total} must not exceed exact ${exactIndex.total}`);
  assert.equal(fullFloor.calculatedAtMonth, exactIndex.calculatedAtMonth);
  assert.match(fullFloor.formulaVersion, /certified-current-root-lower-bound/u);
  await assert.rejects(async () => api.calculateCertifiedCivilizationIndexFloor(full, {
    materialCapabilities: [...fullCapabilities.slice(0, 3), fullCapabilities[0]],
    facilities: [],
  }), /重复 key|精确覆盖/u);
  await assert.rejects(async () => api.calculateCertifiedCivilizationIndexFloor(full, {
    materialCapabilities: fullCapabilities,
    facilities: [
      { id: 'duplicate', active: true, useCount: 1, userCount: 1 },
      { id: 'duplicate', active: true, useCount: 1, userCount: 1 },
    ],
  }), /不可重复/u);

  const maxRssBytes = process.resourceUsage().maxRSS * 1_024;
  console.log(JSON.stringify({
    ok: true,
    agrarian: { month12: first.observation.currentEra, month24: second.observation.currentEra },
    unknownIndexGate: unknownResult.civilizationIndexFloor,
    directAncient: ancient.observation.currentEra,
    certifiedFloor: fullFloor.total,
    exactIndex: exactIndex.total,
    coldWitnessOutsideHotTail: true,
    maxRssBytes,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
