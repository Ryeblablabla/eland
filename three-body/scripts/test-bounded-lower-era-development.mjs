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
    `export { calculateCivilizationIndex, calculateCertifiedCivilizationIndexFloor } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/civilization-index.ts'))};`,
    `export { observeFunctionalBuildings, observeMaterialCapabilities } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/era-progression.ts'))};`,
    `export { createInitialState } from ${JSON.stringify(path.join(workspace, 'src/game/eland/application/simulation/state-lifecycle.ts'))};`,
    `export { Material } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/material.ts'))};`,
  ].join('\n'));
  buildSync({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm' });
  const api = await import(`${pathToFileURL(output).href}?v=${Date.now()}`);

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
    { project() {} },
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
    { project() {} },
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

  const iron = capabilitySet({
    iron: {
      successfulBatchCount: 10,
      adoptedActionCount: 28,
      firstSuccessfulMonth: 1,
      lastSuccessfulMonth: 18,
      producerIds: ['smith-a', 'smith-b'],
      productionSiteMaterialIds: [api.Material.Smithy],
      successfulBatchEvidence: [ref('cold-iron-batch', 2)],
      adoptedActionEvidence: [ref('cold-iron-use', 3)],
    },
  });
  const ancientState = api.createInitialState(
    { project() {} },
    81_003,
    { endpoint: { kind: 'months', value: 120 } },
  );
  const ancientBoundary = bind(ancientState, 18, 'd');
  const ancientDerived = derivedBundle(ancientState, ancientBoundary.target, {
    capabilities: iron,
    institutions: [{
      key: 'metalwork-standard:smithy', label: 'metalwork', evidenceEventIds: ['cold-metalwork'], note: '',
    }],
  });
  const ancient = api.materializeBoundedCertifiedCivilizationDevelopment(
    ancientState,
    ancientBoundary.basis,
    ancientBoundary.target,
    ancientDerived.materialization,
    ancientDerived.projection,
  );
  assert.equal(ancient.observation.materialCapabilities.find((item) => item.key === 'iron').stage, 'institutional');
  assert.equal(ancient.observation.currentEra, 'ancient-civilization',
    'institutional iron must directly prove ancient without an agrarian sequence prerequisite');
  assert.equal(ancientState.civilization.stage, '古代文明');

  const full = api.createInitialState(
    { project() {} },
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
