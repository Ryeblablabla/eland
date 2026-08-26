import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'eland-bounded-modern-materializer-'));

function action(id, atMonth, orderInMonth, who, primitive, diff) {
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
    action: primitive,
    fromCellId: 0,
    toCellId: 0,
    fromZ: 2,
    toZ: 2,
    pathSegment: [0],
    status: 'completed',
    result: id,
    diff,
  };
}

try {
  const entry = path.join(temporaryDirectory, 'entry.ts');
  await writeFile(entry, [
    `export * from ${JSON.stringify(path.join(workspace, 'server/bounded-observer-civilization-materializer.ts'))};`,
    `export { createInitialState } from ${JSON.stringify(path.join(workspace, 'src/game/eland/application/simulation/state-lifecycle.ts'))};`,
    `export { Material } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/material.ts'))};`,
    `export { createElectricalPowerNetwork, plannedElectricalPowerComponents, recordElectricalPowerInstallation } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/electrical-power.ts'))};`,
    `export { MASS_MEASUREMENT_RESOLUTION, MASS_MEASUREMENT_UNIT, SOURCED_MASS_MEASUREMENT_ACTION_VERSION } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/measurement.ts'))};`,
    `export { setVoxel } from ${JSON.stringify(path.join(workspace, 'src/game/eland/world/grid.ts'))};`,
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
  const readerId = 'person-reader';
  const authorId = 'person-author';

  function compactIndexEvidence(state) {
    for (const component of Object.values(state.civilization.civilizationIndex.components)) {
      component.evidence = {};
    }
  }

  function installModernFacts(state) {
    const plan = {
      version: 'electrical-power-plan-v1',
      mechanicalInstallationProjectId: 'mechanical-project',
      mechanicalNetworkId: 'mechanical-network',
      mechanicalPlanKey: 'mechanical-plan',
      generatorPosition: { x: 1, y: 1, z: 2 },
      conductorPositions: [{ x: 2, y: 1, z: 2 }],
      loadPosition: { x: 3, y: 1, z: 2 },
    };
    const network = api.createElectricalPowerNetwork(plan);
    const installationFacts = api.plannedElectricalPowerComponents(plan).map((component, index) => {
      const id = `electrical-install-${index}`;
      api.setVoxel(
        state.world.grid,
        component.position.x,
        component.position.y,
        component.position.z,
        component.materialId,
      );
      api.recordElectricalPowerInstallation(network, {
        ...component,
        installedAtMonth: 1,
        installationEventId: id,
        sourceEventIds: [`source-${id}`],
      });
      return action(id, 1, index + 1, readerId, {
        kind: 'act', operation: 'combine', targets: [],
      }, {
        outputMaterialId: component.materialId,
        position: component.position,
      });
    });
    const ordinaryOperation = action(
      'electrical-operation-ordinary',
      2,
      1,
      readerId,
      { kind: 'act', operation: 'exert', targets: [] },
      {
        electricalPowerOperation: true,
        electricalPowerDelivered: true,
        electricalPowerUsefulLoad: false,
        electricalNetworkId: network.id,
      },
    );
    const usefulLoad = action(
      'electrical-operation-useful-load',
      3,
      1,
      readerId,
      { kind: 'act', operation: 'exert', targets: [] },
      {
        electricalPowerOperation: true,
        electricalPowerDelivered: true,
        electricalPowerUsefulLoad: true,
        electricalNetworkId: network.id,
      },
    );
    network.operationCount = 2;
    network.recentOperationEventIds = [ordinaryOperation.id, usefulLoad.id];
    state.world.electricalPower = {
      version: 'electrical-power-world-v1', networks: [network], dispatchWindows: [],
    };

    const instrumentUse = {
      personId: readerId,
      stackId: 'beam-balance-stack',
      quantity: 1,
      sourceEventIds: ['made-beam-balance'],
    };
    const referenceUse = {
      personId: readerId,
      stackId: 'standard-weight-stack',
      quantity: 1,
      sourceEventIds: ['made-standard-weight'],
    };
    const subjectUse = {
      personId: readerId,
      stackId: 'measurement-subject-stack',
      quantity: 1,
      sourceEventIds: ['made-measurement-subject'],
    };
    const instrumentReceipt = {
      ...instrumentUse, materialId: api.Material.BeamBalance, heldQuantity: 1,
    };
    const referenceReceipt = {
      ...referenceUse, materialId: api.Material.StandardWeight, heldQuantity: 1,
    };
    const subjectReceipt = {
      ...subjectUse, materialId: api.Material.Stone, heldQuantity: 1,
    };
    const calibration = action('mass-calibration', 4, 1, readerId, {
      kind: 'attend',
      target: { kind: 'inventory-stack', personId: readerId, stackId: referenceUse.stackId },
      instrumentStackId: instrumentUse.stackId,
      measurement: {
        version: api.SOURCED_MASS_MEASUREMENT_ACTION_VERSION,
        mode: 'calibrate-mass',
        instrument: instrumentUse,
        reference: referenceUse,
      },
    }, {
      version: 'mass-calibration-receipt-v1',
      receiptKind: 'mass-calibration',
      calibrationEventId: 'mass-calibration',
      calibratedByPersonId: readerId,
      calibratedAtMonth: 4,
      dimension: 'mass',
      unit: api.MASS_MEASUREMENT_UNIT,
      resolution: api.MASS_MEASUREMENT_RESOLUTION,
      instrument: instrumentReceipt,
      reference: referenceReceipt,
    });
    const measurement = action('mass-measurement', 5, 1, readerId, {
      kind: 'attend',
      target: { kind: 'inventory-stack', personId: readerId, stackId: subjectUse.stackId },
      instrumentStackId: instrumentUse.stackId,
      measurement: {
        version: api.SOURCED_MASS_MEASUREMENT_ACTION_VERSION,
        mode: 'measure-mass',
        instrument: instrumentUse,
        subject: subjectUse,
        calibrationEventId: calibration.id,
      },
    }, {
      version: 'mass-measurement-receipt-v1',
      receiptKind: 'mass-measurement',
      measurementEventId: 'mass-measurement',
      measuredByPersonId: readerId,
      measuredAtMonth: 5,
      dimension: 'mass',
      unit: api.MASS_MEASUREMENT_UNIT,
      resolution: api.MASS_MEASUREMENT_RESOLUTION,
      interval: { lowerInclusive: 1, upperInclusive: 1.5 },
      instrument: instrumentReceipt,
      subject: subjectReceipt,
      reference: referenceReceipt,
      calibrationEventId: calibration.id,
    });
    const recordExperiment = action(
      'independent-record-experiment',
      6,
      1,
      readerId,
      { kind: 'act', operation: 'combine', targets: [] },
      {
        recordUseStage: 'experiment',
        recordUseProjectId: 'record-use-project',
        recordUseRecordId: 'record-payload',
        recordUseKnowledgeId: 'knowledge-technique',
        recordUseTechniqueId: 'knowledge-technique',
        recordUseReaderId: readerId,
        recordUseRecordAuthorId: authorId,
        recordUseExpectedOutputMaterialId: api.Material.Spear,
        recordUseKnowledgeConfidenceBefore: 46,
        recordUseKnowledgeConfidenceAfter: 64,
        outputMaterialId: api.Material.Spear,
      },
    );
    state.people.push({
      id: readerId,
      knowledge: [{
        id: 'knowledge-technique', kind: 'technique', confidence: 64,
        sourceEventIds: [recordExperiment.id],
      }, {
        id: 'record-codebook', kind: 'codebook', confidence: 70,
        sourceEventIds: ['codebook-source'],
      }],
    }, { id: authorId, knowledge: [] });
    state.records.push({
      id: 'record-payload', authorId, knowledgeId: 'knowledge-technique',
      codebookId: 'record-codebook', kind: 'technique', summary: 'fixture technique',
      version: 1, createdAtMonth: 1, sourceEventIds: ['record-source'],
    });
    state.projects.push({
      id: 'record-use-project', status: 'completed', ownerId: readerId,
      desiredFunction: 'prepared-food', actionEventIds: [recordExperiment.id],
      completionEventIds: [recordExperiment.id], beneficiaryIds: [], contributorIds: [],
      triggerFactIds: [], reservations: [],
    });
    state.projects.push({
      id: 'comparable-mass-project',
      status: 'completed',
      desiredFunction: 'comparable-mass-measurement',
      ownerId: readerId,
      completedAtMonth: 5,
      actionEventIds: [calibration.id, measurement.id],
      completionEventIds: [calibration.id, measurement.id],
      measurementUncertaintyBasis: {
        version: 'measurement-uncertainty-basis-v1',
        observerId: readerId,
        atMonth: 1,
        uncertaintyKind: 'overlapping-felt-load-bands',
        samples: [
          {
            personId: readerId,
            stackId: subjectUse.stackId,
            materialId: api.Material.Stone,
            quantity: 1,
            perceivedLoadBand: 'hand-load',
            sourceEventIds: [...subjectUse.sourceEventIds],
            productionEventIds: [...subjectUse.sourceEventIds],
          },
          {
            personId: readerId,
            stackId: 'second-subject',
            materialId: api.Material.Wood,
            quantity: 2,
            perceivedLoadBand: 'hand-load',
            sourceEventIds: ['made-second-subject'],
            productionEventIds: ['made-second-subject'],
          },
        ],
        productionEventIds: ['made-measurement-subject', 'made-second-subject'],
        experiencedMonthCount: 2,
        sourceFactIds: ['mass-comparison-doubt'],
        basisKey: 'measurement-basis',
      },
    });
    state.world.past.push(
      ...installationFacts,
      ordinaryOperation,
      usefulLoad,
      calibration,
      measurement,
      recordExperiment,
    );
  }

  function freshState({ modernFacts = true } = {}) {
    const state = api.createInitialState(
      { project() {} },
      71,
      { endpoint: { kind: 'months', value: 1_000 } },
    );
    state.clock.elapsedMonths = 100;
    state.civilization.stage = '原始部落';
    delete state.civilization.development;
    compactIndexEvidence(state);
    state.civilization.civilizationIndex.calculatedAtMonth = 100;
    state.derived.milestones = [{
      id: 'milestone-byte-sentinel',
      label: 'must remain byte-identical',
      evidenceEventIds: ['sentinel-evidence'],
    }];
    if (modernFacts) installModernFacts(state);
    state.world.historyCursor = {
      version: 1,
      eventCount: state.world.past.length,
      hotStartIndex: 0,
      tailEventId: state.world.past.at(-1)?.id ?? null,
    };
    return state;
  }

  function bindV2Basis(state, hashCharacter, developmentSnapshot) {
    const stateHash = hashCharacter.repeat(64);
    const basis = {
      version: 2,
      profile: 'bounded-gameplay-hot-observer-v2',
      source: { stateHash, revision: 1, month: state.clock.elapsedMonths },
      milestoneCount: state.derived.milestones.length,
      stage: state.civilization.stage,
      indexSnapshot: structuredClone(state.civilization.civilizationIndex),
      developmentSnapshot: developmentSnapshot === null
        ? null
        : {
          observerVersion: developmentSnapshot.observerVersion,
          currentEra: developmentSnapshot.currentEra,
          historicalPeakEra: developmentSnapshot.historicalPeakEra,
          candidateEra: developmentSnapshot.candidateEra,
          candidateSinceMonth: developmentSnapshot.candidateSinceMonth,
        },
    };
    state.lastMaterializedObserverBasis = structuredClone(basis);
    return {
      basis,
      target: {
        stateHash,
        eventCount: state.world.historyCursor.eventCount,
        tailEventId: state.world.historyCursor.tailEventId,
      },
    };
  }

  function bindV1Basis(state, hashCharacter) {
    const stateHash = hashCharacter.repeat(64);
    const basis = {
      version: 1,
      profile: 'bounded-gameplay-hot-observer-v1',
      source: { stateHash, revision: 1, month: state.clock.elapsedMonths },
      milestoneCount: state.derived.milestones.length,
      stage: state.civilization.stage,
      indexSnapshot: structuredClone(state.civilization.civilizationIndex),
    };
    state.lastMaterializedObserverBasis = structuredClone(basis);
    return {
      basis,
      target: {
        stateHash,
        eventCount: state.world.historyCursor.eventCount,
        tailEventId: state.world.historyCursor.tailEventId,
      },
    };
  }

  const primitiveSnapshot = (candidateSinceMonth = 100) => ({
    observerVersion: 'material-institution-era-v7',
    currentEra: 'primitive-tribe',
    historicalPeakEra: 'primitive-tribe',
    candidateEra: 'modern-civilization',
    candidateSinceMonth,
  });

  const progression = freshState();
  const indexReference = progression.civilization.civilizationIndex;
  const milestoneReference = progression.derived.milestones;
  const indexBytes = Buffer.from(JSON.stringify(indexReference), 'utf8');
  const milestoneBytes = Buffer.from(JSON.stringify(milestoneReference), 'utf8');
  const firstBoundary = bindV2Basis(progression, 'a', {
    ...primitiveSnapshot(100), candidateEra: 'primitive-tribe',
  });
  const first = api.materializeBoundedModernCivilizationDevelopment(
    progression,
    firstBoundary.basis,
    firstBoundary.target,
  );
  assert.equal(first.observation.candidateEra, 'modern-civilization',
    '原始部落可以直接成为现代候选，不需要低阶 observer 前置');
  assert.equal(first.observation.currentEra, 'modern-civilization',
    '三项事实闭合后应在本次权威观察直接晋升');
  assert.equal(first.observation.candidateSinceMonth, 100);
  assert.equal(first.observation.transitionProgress, 1);
  assert.equal(progression.civilization.stage, '现代文明（含信息能力）');
  assert.deepEqual(first.observation.missingGateIds, []);
  assert.deepEqual(first.observation.materialCapabilities, [],
    '窄现代物化器不得伪造材料能力');
  assert.deepEqual(first.materializedFields, [
    'civilization.stage', 'civilization.development',
  ]);
  assert.deepEqual(first.preservedFields, [
    'civilization.civilizationIndex', 'derived.milestones',
  ]);
  assert.equal(first.continuationReady, false);
  assert.strictEqual(progression.civilization.civilizationIndex, indexReference);
  assert.strictEqual(progression.derived.milestones, milestoneReference);
  assert.deepEqual(Buffer.from(JSON.stringify(indexReference), 'utf8'), indexBytes);
  assert.deepEqual(Buffer.from(JSON.stringify(milestoneReference), 'utf8'), milestoneBytes);

  assert.equal(first.observation.historicalPeakEra, 'modern-civilization');
  assert.deepEqual(progression.lastMaterializedObserverBasis, first.nextBasis);

  const ancientWithoutFacts = freshState({ modernFacts: false });
  ancientWithoutFacts.civilization.stage = '古代文明';
  const ancientBoundary = bindV2Basis(ancientWithoutFacts, 'd', {
    observerVersion: 'material-institution-era-v6',
    currentEra: 'ancient-civilization',
    historicalPeakEra: 'ancient-civilization',
    candidateEra: 'ancient-civilization',
    candidateSinceMonth: 80,
  });
  const ancient = api.materializeBoundedModernCivilizationDevelopment(
    ancientWithoutFacts,
    ancientBoundary.basis,
    ancientBoundary.target,
  );
  assert.equal(ancient.observation.currentEra, 'ancient-civilization');
  assert.equal(ancientWithoutFacts.civilization.stage, '古代文明',
    'bounded 现代证据不全不得让已有低阶 stage 回退');
  assert.deepEqual(ancient.observation.missingGateIds, [
    'power:complete-network-useful-load',
    'measurement:calibrated-comparable-mass',
    'record:independent-experiment-reuse',
  ]);

  const achievedWithoutFacts = freshState({ modernFacts: false });
  achievedWithoutFacts.civilization.stage = '现代文明（含信息能力）';
  const achievedBoundary = bindV2Basis(achievedWithoutFacts, 'e', {
    observerVersion: 'material-institution-era-v7',
    currentEra: 'modern-civilization',
    historicalPeakEra: 'modern-civilization',
    candidateEra: 'modern-civilization',
    candidateSinceMonth: 80,
  });
  const retainedAchievement = api.materializeBoundedModernCivilizationDevelopment(
    achievedWithoutFacts,
    achievedBoundary.basis,
    achievedBoundary.target,
  );
  assert.equal(retainedAchievement.observation.currentEra, 'modern-civilization');
  assert.equal(achievedWithoutFacts.civilization.stage, '现代文明（含信息能力）');
  assert.equal(retainedAchievement.observation.missingGateIds.length, 3,
    '能力损失应显示为 missing gates，但不撤销最高成就');

  const historicalOnly = freshState({ modernFacts: false });
  historicalOnly.civilization.stage = '古代文明';
  const historicalBoundary = bindV2Basis(historicalOnly, '6', {
    observerVersion: 'material-institution-era-v7',
    currentEra: 'ancient-civilization',
    historicalPeakEra: 'modern-civilization',
    candidateEra: 'ancient-civilization',
    candidateSinceMonth: 90,
  });
  const historical = api.materializeBoundedModernCivilizationDevelopment(
    historicalOnly, historicalBoundary.basis, historicalBoundary.target,
  );
  assert.equal(historical.observation.currentEra, 'ancient-civilization',
    '历史曾达成现代不得在当前证据缺失时被重新晋级');
  assert.equal(historical.observation.historicalPeakEra, 'modern-civilization');

  const legacy = freshState();
  const legacyFirstBoundary = bindV1Basis(legacy, 'f');
  const legacyFirst = api.materializeBoundedModernCivilizationDevelopment(
    legacy,
    legacyFirstBoundary.basis,
    legacyFirstBoundary.target,
  );
  assert.equal(legacyFirst.observation.currentEra, 'modern-civilization');
  assert.equal(legacyFirst.observation.candidateSinceMonth, 100);
  legacy.clock.elapsedMonths = 106;
  legacy.civilization.stage = '原始部落';
  delete legacy.civilization.development;
  const legacyLaterBoundary = bindV1Basis(legacy, '1');
  const legacyLater = api.materializeBoundedModernCivilizationDevelopment(
    legacy,
    legacyLaterBoundary.basis,
    legacyLaterBoundary.target,
  );
  assert.equal(legacyLater.observation.currentEra, 'modern-civilization');
  assert.equal(legacyLater.observation.candidateSinceMonth, 106,
    'v1 basis 在本次事实闭合时直接提交，不继承虚构历史');

  const nullHistory = freshState();
  nullHistory.clock.elapsedMonths = 106;
  const nullHistoryBoundary = bindV2Basis(nullHistory, '4', null);
  const nullHistoryObservation = api.materializeBoundedModernCivilizationDevelopment(
    nullHistory,
    nullHistoryBoundary.basis,
    nullHistoryBoundary.target,
  );
  assert.equal(nullHistoryObservation.observation.currentEra, 'modern-civilization');
  assert.equal(nullHistoryObservation.observation.candidateSinceMonth, 106,
    'v2 null development snapshot 在本次事实闭合时直接提交');

  const medieval = freshState({ modernFacts: false });
  medieval.civilization.stage = '中世纪';
  const medievalBoundary = bindV1Basis(medieval, '7');
  const normalizedMedieval = api.materializeBoundedModernCivilizationDevelopment(
    medieval, medievalBoundary.basis, medievalBoundary.target,
  );
  assert.equal(normalizedMedieval.observation.currentEra, 'ancient-civilization');
  assert.equal(medieval.civilization.stage, '古代文明', '旧中世纪显示名必须归并为古代文明');

  const mismatch = freshState();
  const mismatchBoundary = bindV2Basis(mismatch, '2', primitiveSnapshot());
  assert.throws(
    () => api.materializeBoundedModernCivilizationDevelopment(
      mismatch,
      mismatchBoundary.basis,
      { ...mismatchBoundary.target, stateHash: '3'.repeat(64) },
    ),
    /basis source.*exact target hash/u,
  );
  const wrongMonth = structuredClone(mismatchBoundary.basis);
  wrongMonth.source.month = 101;
  mismatch.lastMaterializedObserverBasis = structuredClone(wrongMonth);
  assert.throws(
    () => api.materializeBoundedModernCivilizationDevelopment(
      mismatch, wrongMonth, { ...mismatchBoundary.target, stateHash: wrongMonth.source.stateHash },
    ),
    /source month/u,
  );
  mismatch.lastMaterializedObserverBasis = structuredClone(mismatchBoundary.basis);
  mismatch.civilization.stage = '古代文明';
  assert.throws(
    () => api.materializeBoundedModernCivilizationDevelopment(
      mismatch, mismatchBoundary.basis, mismatchBoundary.target,
    ),
    /basis stage/u,
  );
  mismatch.civilization.stage = mismatchBoundary.basis.stage;
  mismatch.civilization.civilizationIndex.total += 1;
  assert.throws(
    () => api.materializeBoundedModernCivilizationDevelopment(
      mismatch, mismatchBoundary.basis, mismatchBoundary.target,
    ),
    /basis index snapshot/u,
  );

  const futureCandidate = freshState();
  const futureBoundary = bindV2Basis(futureCandidate, '5', primitiveSnapshot(101));
  assert.throws(
    () => api.materializeBoundedModernCivilizationDevelopment(
      futureCandidate, futureBoundary.basis, futureBoundary.target,
    ),
    /candidateSinceMonth 来自未来月份/u,
  );

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1_024 * 1_024,
    'bounded modern materializer fixture RSS must stay below 256 MiB');
  console.log(JSON.stringify({
    result: 'passed',
    firstCandidateSinceMonth: first.observation.candidateSinceMonth,
    immediateEra: first.observation.currentEra,
    retainedModernAfterMissingFacts: retainedAchievement.observation.currentEra,
    legacyRestartMonth: legacyLater.observation.candidateSinceMonth,
    nullSnapshotRestartMonth: nullHistoryObservation.observation.candidateSinceMonth,
    continuationReady: first.continuationReady,
    rssBytes,
  }, null, 2));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
