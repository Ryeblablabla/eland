import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-modern-era-test-'));
const bundlePath = path.join(temporaryDirectory, 'modern-era.mjs');

try {
  const testEntry = `
    export {
      DEVELOPMENT_ERA_LABELS,
      DEVELOPMENT_OBSERVER_VERSION,
      MODERN_ELECTRICAL_USEFUL_LOAD_LEASE_KEY,
      MODERN_RECORD_EXPERIMENT_LEASE_KEY,
      modernElectricalOperationLeaseKey,
      modernElectricalUsefulLoadLeaseKey,
      modernCompletedMeasurementReceiptLeaseKey,
      observeCivilizationDevelopment,
      observeModernCivilizationEvidence,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/era-progression.ts'))};
    export { registerRetainedColdWorldEventFacts }
      from ${JSON.stringify(path.resolve('src/game/eland/domain/event-index.ts'))};
    export {
      beginHistoryRetentionProjection,
      finishHistoryRetentionProjection,
      foldHistoryRetentionSegment,
    } from ${JSON.stringify(path.resolve('server/history-retention-projection.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export {
      createElectricalPowerNetwork,
      plannedElectricalPowerComponents,
      recordElectricalPowerInstallation,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/electrical-power.ts'))};
    export {
      MASS_MEASUREMENT_RESOLUTION,
      MASS_MEASUREMENT_UNIT,
      SOURCED_MASS_MEASUREMENT_ACTION_VERSION,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/measurement.ts'))};
    export {
      WORLD_CELL_COUNT,
      WORLD_DEPTH,
      WORLD_LEVELS,
      WORLD_VOXEL_COUNT,
      WORLD_WIDTH,
      cellId,
      setVoxel,
    } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=modern-era-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: testEntry, stdio: ['pipe', 'pipe', 'pipe'] });
  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    DEVELOPMENT_ERA_LABELS,
    DEVELOPMENT_OBSERVER_VERSION,
    MASS_MEASUREMENT_RESOLUTION,
    MASS_MEASUREMENT_UNIT,
    Material,
    MODERN_ELECTRICAL_USEFUL_LOAD_LEASE_KEY,
    MODERN_RECORD_EXPERIMENT_LEASE_KEY,
    SOURCED_MASS_MEASUREMENT_ACTION_VERSION,
    WORLD_CELL_COUNT,
    WORLD_DEPTH,
    WORLD_LEVELS,
    WORLD_VOXEL_COUNT,
    WORLD_WIDTH,
    beginHistoryRetentionProjection,
    cellId,
    createElectricalPowerNetwork,
    finishHistoryRetentionProjection,
    foldHistoryRetentionSegment,
    modernCompletedMeasurementReceiptLeaseKey,
    modernElectricalOperationLeaseKey,
    modernElectricalUsefulLoadLeaseKey,
    observeCivilizationDevelopment,
    observeModernCivilizationEvidence,
    plannedElectricalPowerComponents,
    recordElectricalPowerInstallation,
    registerRetainedColdWorldEventFacts,
    setVoxel,
  } = api;

  const readerId = 'person-reader';
  const authorId = 'person-author';
  const actionFact = (id, atMonth, action, diff, who = readerId) => ({
    id,
    kind: 'action',
    actionTick: 1,
    atMonth,
    orderInMonth: 0,
    planningTick: 1,
    orderInTick: 0,
    cellId: cellId(1, 1),
    who,
    cause: 'intent',
    action,
    fromCellId: cellId(1, 1),
    toCellId: cellId(1, 1),
    fromZ: 2,
    toZ: 2,
    pathSegment: [cellId(1, 1)],
    status: 'completed',
    result: id,
    diff,
  });

  const materialSourceFact = (id, atMonth, orderInMonth, materialId) => ({
    id,
    kind: 'environment',
    atMonth,
    orderInMonth,
    cellId: cellId(1, 1),
    who: readerId,
    change: 'resource',
    result: id,
    diff: { materialId },
  });

  function modernState() {
    const grid = {
      version: 2,
      width: WORLD_WIDTH,
      depth: WORLD_DEPTH,
      levels: WORLD_LEVELS,
      generator: { version: 'material-world-v4-regional-geology', seed: 7 },
      palette: [],
      voxels: new Uint16Array(WORLD_VOXEL_COUNT),
    };
    const plan = {
      version: 'electrical-power-plan-v1',
      mechanicalInstallationProjectId: 'mechanical-project',
      mechanicalNetworkId: 'mechanical-network',
      mechanicalPlanKey: 'mechanical-plan',
      generatorPosition: { x: 1, y: 1, z: 2 },
      conductorPositions: [{ x: 2, y: 1, z: 2 }],
      loadPosition: { x: 3, y: 1, z: 2 },
    };
    const network = createElectricalPowerNetwork(plan);
    const installationFacts = plannedElectricalPowerComponents(plan).map((component, index) => {
      const id = `electrical-install-${index}`;
      setVoxel(grid, component.position.x, component.position.y, component.position.z, component.materialId);
      recordElectricalPowerInstallation(network, {
        ...component,
        installedAtMonth: 1,
        installationEventId: id,
        sourceEventIds: [`source-${id}`],
      });
      return actionFact(id, 1, { kind: 'act', operation: 'combine', targets: [] }, {
        outputMaterialId: component.materialId,
        position: component.position,
      });
    });
    const ordinaryOperation = actionFact(
      'electrical-operation-ordinary',
      2,
      { kind: 'act', operation: 'exert', targets: [] },
      {
        electricalPowerOperation: true,
        electricalPowerDelivered: true,
        electricalPowerUsefulLoad: false,
        electricalNetworkId: network.id,
      },
    );
    const usefulLoad = actionFact(
      'electrical-operation-useful-load',
      3,
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
      ...instrumentUse,
      materialId: Material.BeamBalance,
      heldQuantity: 1,
    };
    const referenceReceipt = {
      ...referenceUse,
      materialId: Material.StandardWeight,
      heldQuantity: 1,
    };
    const subjectReceipt = {
      ...subjectUse,
      materialId: Material.Stone,
      heldQuantity: 1,
    };
    const calibration = actionFact('mass-calibration', 4, {
      kind: 'attend',
      target: { kind: 'inventory-stack', personId: readerId, stackId: referenceUse.stackId },
      instrumentStackId: instrumentUse.stackId,
      measurement: {
        version: SOURCED_MASS_MEASUREMENT_ACTION_VERSION,
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
      unit: MASS_MEASUREMENT_UNIT,
      resolution: MASS_MEASUREMENT_RESOLUTION,
      instrument: instrumentReceipt,
      reference: referenceReceipt,
    });
    const measurement = actionFact('mass-measurement', 5, {
      kind: 'attend',
      target: { kind: 'inventory-stack', personId: readerId, stackId: subjectUse.stackId },
      instrumentStackId: instrumentUse.stackId,
      measurement: {
        version: SOURCED_MASS_MEASUREMENT_ACTION_VERSION,
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
      unit: MASS_MEASUREMENT_UNIT,
      resolution: MASS_MEASUREMENT_RESOLUTION,
      interval: { lowerInclusive: 1, upperInclusive: 1.5 },
      instrument: instrumentReceipt,
      subject: subjectReceipt,
      reference: referenceReceipt,
      calibrationEventId: calibration.id,
    });
    const measurementProject = {
      id: 'comparable-mass-project',
      status: 'completed',
      desiredFunction: 'comparable-mass-measurement',
      ownerId: readerId,
      beneficiaryIds: [],
      contributorIds: [],
      triggerFactIds: [],
      reservations: [],
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
            materialId: Material.Stone,
            quantity: 1,
            perceivedLoadBand: 'hand-load',
            sourceEventIds: [...subjectUse.sourceEventIds],
            productionEventIds: [...subjectUse.sourceEventIds],
          },
          {
            personId: readerId,
            stackId: 'second-subject',
            materialId: Material.Wood,
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
    };
    const recordExperiment = actionFact(
      'independent-record-experiment',
      6,
      { kind: 'act', operation: 'combine', targets: [] },
      {
        recordUseStage: 'experiment',
        recordUseProjectId: 'record-use-project',
        recordUseRecordId: 'record-payload',
        recordUseKnowledgeId: 'knowledge-technique',
        recordUseTechniqueId: 'knowledge-technique',
        recordUseReaderId: readerId,
        recordUseRecordAuthorId: authorId,
        recordUseExpectedOutputMaterialId: Material.Spear,
        recordUseKnowledgeConfidenceBefore: 46,
        recordUseKnowledgeConfidenceAfter: 64,
        outputMaterialId: Material.Spear,
      },
    );
    const past = [
      ...installationFacts,
      ordinaryOperation,
      usefulLoad,
      calibration,
      measurement,
      recordExperiment,
    ];
    return {
      schemaVersion: 17,
      seed: 7,
      branchId: 'modern-era-test',
      clock: { unit: 'month', elapsedMonths: 100, monthsPerYear: 12 },
      world: {
        grid,
        drops: [],
        animals: [],
        remains: [],
        memorials: [],
        past,
        electricalPower: { version: 'electrical-power-world-v1', networks: [network], dispatchWindows: [] },
      },
      people: [{
        id: readerId,
        bornAtMonth: 0,
        body: { health: 80, hydration: 80, nutrition: 80 },
        memories: [], conditions: [], relations: [], bereavements: [],
        maternalTeachingSourceEventIds: [], geneticParents: [], inventory: [],
        knowledge: [{
          id: 'knowledge-technique', kind: 'technique', confidence: 64,
          sourceEventIds: [recordExperiment.id],
        }, {
          id: 'record-codebook', kind: 'codebook', confidence: 70,
          sourceEventIds: ['codebook-source'],
        }],
      }, {
        id: authorId, bornAtMonth: 0,
        body: { health: 80, hydration: 80, nutrition: 80 },
        memories: [], conditions: [], relations: [], bereavements: [],
        maternalTeachingSourceEventIds: [], geneticParents: [], inventory: [], knowledge: [],
      }],
      intents: [],
      agreements: [],
      records: [{
        id: 'record-payload', authorId, knowledgeId: 'knowledge-technique',
        codebookId: 'record-codebook', kind: 'technique', summary: 'fixture technique',
        version: 1, createdAtMonth: 1, sourceEventIds: ['record-source'],
      }],
      collectives: [],
      permissions: [],
      containers: [],
      eraPredictions: [],
      projects: [measurementProject, {
        id: 'record-use-project', status: 'completed', ownerId: readerId,
        desiredFunction: 'prepared-food', actionEventIds: [recordExperiment.id],
        completionEventIds: [recordExperiment.id], beneficiaryIds: [], contributorIds: [],
        triggerFactIds: [], reservations: [],
      }],
      civilization: {
        number: 1,
        status: 'running',
        stage: 'primitive-tribe',
        epoch: 'stable',
        era: {},
        climate: { kind: 'temperate', severity: 0, sinceMonth: 0 },
        weather: { kind: 'clear', intensity: 0, sinceMonth: 0 },
        conditions: { civilizationNo: 1, climateBias: 'balanced', chaosIntensity: 0, endpoint: { kind: 'months', value: 1000 } },
        civilizationIndex: { total: 0, calculatedAtMonth: 100, components: {} },
      },
      decisionBudget: { credits: 0, tokensPerContext: 0, ledgers: [] },
      derived: { practices: [], institutions: [], milestones: [], regions: [], structures: [] },
      lastStep: [],
    };
  }

  function makeRecordProjectSuccessor(state, vacancyAtMonth, successionAtMonth) {
    const project = state.projects.find((candidate) => candidate.id === 'record-use-project');
    assert.ok(project);
    const projectSite = { cellId: cellId(1, 1), z: 2 };
    const vacancyId = `record-project-vacancy:${vacancyAtMonth}`;
    const deathEventId = `record-project-founder-death:${vacancyAtMonth}`;
    const successionEventId = `record-project-succession:${successionAtMonth}`;
    const contributionEventId = `record-project-contribution:${successionAtMonth}`;
    project.ownerId = authorId;
    project.site = projectSite;
    project.leadershipTransitions = [{
      version: 'project-leadership-v1',
      id: vacancyId,
      kind: 'vacancy',
      projectId: project.id,
      predecessorId: authorId,
      deathEventId,
      expiresAtMonth: vacancyAtMonth + 120,
      atMonth: vacancyAtMonth,
      orderInMonth: 0,
      planningTick: 0,
      orderInTick: 0,
      sourceEventIds: [deathEventId],
    }, {
      version: 'project-leadership-v1',
      id: successionEventId,
      kind: 'succession',
      projectId: project.id,
      predecessorId: authorId,
      successorId: readerId,
      vacancyTransitionId: vacancyId,
      deathEventId,
      contributionEventId,
      successionEventId,
      site: { ...projectSite },
      atMonth: successionAtMonth,
      orderInMonth: 0,
      planningTick: 0,
      orderInTick: 0,
      sourceEventIds: [deathEventId, contributionEventId, successionEventId],
    }];
  }

  function replicationModernState() {
    const state = modernState();
    const reader = state.people.find((person) => person.id === readerId);
    const record = state.records.find((candidate) => candidate.id === 'record-payload');
    const project = state.projects.find((candidate) => candidate.id === 'record-use-project');
    assert.ok(reader && record && project);

    const intentId = 'record-replication-intent';
    const basisKey = 'record-replication-basis';
    const ruleSignature = 'combine:stone-tool+wood->spear';
    const projectRenewalBasisKey = 'project-opening:safer-hunting';
    const stoneSource = materialSourceFact(
      'replication-stone-tool-source', 6, 0, Material.StoneTool,
    );
    const woodSource = materialSourceFact('replication-wood-source', 6, 1, Material.Wood);
    const inputSourceEventIds = [stoneSource.id, woodSource.id].sort();
    const inputWitnesses = [{
      version: 'record-use-input-witness-v1',
      role: 'input',
      personId: readerId,
      stackId: 'replication-stone-tool-stack',
      materialId: Material.StoneTool,
      quantity: 1,
      sourceEventIds: [stoneSource.id],
    }, {
      version: 'record-use-input-witness-v1',
      role: 'input',
      personId: readerId,
      stackId: 'replication-wood-stack',
      materialId: Material.Wood,
      quantity: 1,
      sourceEventIds: [woodSource.id],
    }];
    const goal = {
      kind: 'record-replication-receipt',
      basisKey,
      readerId,
      projectId: project.id,
      recordId: record.id,
      recordVersion: record.version,
      techniqueId: record.knowledgeId,
      ruleSignature,
      expectedOutputMaterialId: Material.Spear,
    };
    const basis = {
      version: 'record-use-basis-v3',
      basisKey,
      projectId: project.id,
      projectOwnerId: readerId,
      readerId,
      recordAuthorId: authorId,
      demand: { kind: 'project-deficit', projectId: project.id, deficitSourceIds: [] },
      recordId: record.id,
      knowledgeId: record.knowledgeId,
      codebookId: record.codebookId,
      techniqueId: record.knowledgeId,
      ruleSignature,
      projectPressure: 70,
      expectedOutputMaterialId: Material.Spear,
      createdAtMonth: 6,
      projectSourceEventIds: [],
      recordSourceEventIds: [],
      codebookSourceEventIds: [],
      inputSourceEventIds,
      sourceFactIds: [...inputSourceEventIds],
      carrierSource: {
        kind: 'inventory', personId: readerId, stackId: 'replication-record-carrier',
      },
      acquisitionRequired: false,
      purpose: 'replicate',
      recordVersion: record.version,
      projectRenewalBasisKey,
      inputWitnesses,
    };
    const receipt = actionFact(
      'independent-record-replication',
      7,
      {
        kind: 'act', operation: 'combine',
        targets: [{
          kind: 'inventory-stack', personId: readerId, stackId: 'replication-stone-tool-stack',
        }, {
          kind: 'inventory-stack', personId: readerId, stackId: 'replication-wood-stack',
        }],
      },
      {
        recordUseReplicationReceipt: true,
        recordUsePurpose: 'replicate',
        recordUseStage: 'replicate',
        recordUseBasisKey: basisKey,
        recordUseReaderId: readerId,
        recordUseProjectId: project.id,
        recordUseRecordId: record.id,
        recordUseRecordVersion: record.version,
        recordUseKnowledgeId: record.knowledgeId,
        recordUseTechniqueId: record.knowledgeId,
        recordUseRuleSignature: ruleSignature,
        recordUseRecordAuthorId: authorId,
        recordUseExpectedOutputMaterialId: Material.Spear,
        recordUseProjectRenewalBasisKey: projectRenewalBasisKey,
        recordUseInputSourceEventIds: [...inputSourceEventIds],
        recordUseInputWitnesses: structuredClone(inputWitnesses),
        inputMaterialIds: [Material.StoneTool, Material.Wood],
        outputMaterialId: Material.Spear,
        techniqueId: record.knowledgeId,
        sourceEventId: 'independent-record-replication',
      },
    );
    receipt.intentId = intentId;
    state.world.past = state.world.past.filter((event) => (
      event.id !== 'independent-record-experiment'
    ));
    state.world.past.push(stoneSource, woodSource, receipt);
    reader.inventory.push({
      id: 'replication-record-carrier',
      materialId: Material.WoodTablet,
      quantity: 1,
      recordPayloadId: record.id,
      sourceEventIds: ['record-source'],
    });
    reader.knowledge.find((knowledge) => knowledge.id === record.knowledgeId).sourceEventIds = [
      receipt.id,
    ];
    project.actionEventIds = [receipt.id];
    project.completionEventIds = [receipt.id];
    state.intents = [{
      id: intentId,
      ownerId: readerId,
      summary: '按他人记录独立复制技术产物',
      domain: 'inquiry',
      goal,
      nextAction: structuredClone(receipt.action),
      status: 'completed',
      createdAtMonth: 6,
      lastProgressAtMonth: 7,
      progress: 1,
      plannedDurationMonths: 1,
      sourceDecisionEventId: 'record-replication-decision',
      sourceFactIds: [...inputSourceEventIds],
      actionEventIds: [receipt.id],
      replanCount: 0,
      recordUseBasis: basis,
      recordUseStage: 'replicate',
      goalOutcome: {
        kind: 'achieved', resolvedAtMonth: 7, sourceEventIds: [receipt.id],
      },
    }];
    return { state, receipt, stoneSource, woodSource, intentId };
  }

  assert.equal(DEVELOPMENT_OBSERVER_VERSION, 'material-institution-era-v7');
  assert.equal(DEVELOPMENT_ERA_LABELS['modern-civilization'], '现代文明（含信息能力）');

  const complete = modernState();
  const completeEvidence = observeModernCivilizationEvidence(complete);
  assert.equal(completeEvidence.satisfied, true, '三束现代事实各一次即应满足低门槛');
  assert.equal(completeEvidence.independentRecordExperiment?.readerId, readerId,
    '原项目负责人亲自完成的记录实验仍须被观察');
  assert.deepEqual(
    {
      projectId: completeEvidence.independentRecordExperiment?.projectId,
      recordId: completeEvidence.independentRecordExperiment?.recordId,
      knowledgeId: completeEvidence.independentRecordExperiment?.knowledgeId,
    },
    { projectId: 'record-use-project', recordId: 'record-payload', knowledgeId: 'knowledge-technique' },
    '记录实验见证必须保存项目、记录与知识 ID',
  );
  for (const eventId of ['electrical-operation-useful-load', 'mass-calibration', 'mass-measurement', 'independent-record-experiment']) {
    assert.ok(completeEvidence.supportingEventIds.includes(eventId), `supportingEventIds 缺少 ${eventId}`);
  }
  const retentionFold = beginHistoryRetentionProjection(complete, { stateHash: 'a'.repeat(64) });
  foldHistoryRetentionSegment(retentionFold, complete.world.past, 0);
  const retention = finishHistoryRetentionProjection(retentionFold);
  const modernPins = new Map(retention.pins.map((pin) => [pin.eventId, pin.leaseKeys]));
  const electricalLeaseKey = modernElectricalUsefulLoadLeaseKey(
    completeEvidence.electricalPower.networkId,
  );
  const electricalOperationLeaseKey = modernElectricalOperationLeaseKey(
    completeEvidence.electricalPower.networkId,
  );
  assert.ok(modernPins.get('electrical-operation-useful-load')
    ?.includes(electricalLeaseKey));
  assert.ok(modernPins.get('electrical-operation-useful-load')
    ?.includes(electricalOperationLeaseKey));
  assert.ok(modernPins.get('electrical-operation-ordinary')
    ?.includes(electricalOperationLeaseKey));
  assert.ok(modernPins.get('independent-record-experiment')
    ?.includes(MODERN_RECORD_EXPERIMENT_LEASE_KEY));
  const projectedMeasurementLease = modernCompletedMeasurementReceiptLeaseKey('comparable-mass-project');
  assert.ok(modernPins.get('mass-calibration')?.includes(projectedMeasurementLease));
  assert.ok(modernPins.get('mass-measurement')?.includes(projectedMeasurementLease));

  const twoRecordWitnesses = modernState();
  const firstRecordWitness = twoRecordWitnesses.world.past
    .find((event) => event.id === 'independent-record-experiment');
  assert.ok(firstRecordWitness);
  const laterRecordWitness = structuredClone(firstRecordWitness);
  laterRecordWitness.id = 'independent-record-experiment-later';
  laterRecordWitness.atMonth = 7;
  laterRecordWitness.diff.sourceEventId = laterRecordWitness.id;
  twoRecordWitnesses.world.past.push(laterRecordWitness);
  twoRecordWitnesses.projects.find((project) => project.id === 'record-use-project')
    .actionEventIds.push(laterRecordWitness.id);
  twoRecordWitnesses.people.find((person) => person.id === readerId).knowledge
    .find((knowledge) => knowledge.id === 'knowledge-technique').sourceEventIds.push(
      laterRecordWitness.id,
    );
  assert.equal(
    observeModernCivilizationEvidence(twoRecordWitnesses).independentRecordExperiment?.eventId,
    firstRecordWitness.id,
    '多个有效记录事实只选择 canonical history 中第一个见证',
  );
  const twoRecordFold = beginHistoryRetentionProjection(
    twoRecordWitnesses,
    { stateHash: 'c'.repeat(64) },
  );
  foldHistoryRetentionSegment(twoRecordFold, twoRecordWitnesses.world.past, 0);
  const twoRecordPins = new Map(
    finishHistoryRetentionProjection(twoRecordFold).pins.map((pin) => [pin.eventId, pin.leaseKeys]),
  );
  assert.ok(twoRecordPins.get(firstRecordWitness.id)?.includes(MODERN_RECORD_EXPERIMENT_LEASE_KEY));
  assert.equal(
    twoRecordPins.get(laterRecordWitness.id)?.includes(MODERN_RECORD_EXPERIMENT_LEASE_KEY) ?? false,
    false,
    'retention 不得把第二个更晚记录见证扩大为另一条永久 modern lease',
  );

  const cold = modernState();
  const ordinaryOperation = cold.world.past.find((event) => event.id === 'electrical-operation-ordinary');
  const usefulLoad = cold.world.past.find((event) => event.id === 'electrical-operation-useful-load');
  const calibration = cold.world.past.find((event) => event.id === 'mass-calibration');
  const measurement = cold.world.past.find((event) => event.id === 'mass-measurement');
  const recordExperiment = cold.world.past.find((event) => event.id === 'independent-record-experiment');
  assert.ok(ordinaryOperation && usefulLoad && calibration && measurement && recordExperiment);
  const tail = actionFact(
    'unrelated-hot-tail',
    100,
    { kind: 'act', operation: 'wait', targets: [] },
    {},
  );
  cold.world.past = [tail];
  cold.world.historyCursor = {
    version: 1,
    eventCount: 101,
    hotStartIndex: 100,
    tailEventId: tail.id,
  };
  const measurementLeaseKey = modernCompletedMeasurementReceiptLeaseKey('comparable-mass-project');
  registerRetainedColdWorldEventFacts(cold, [
    {
      absoluteIndex: 9,
      eventId: ordinaryOperation.id,
      event: ordinaryOperation,
      leaseKeys: [electricalOperationLeaseKey],
    },
    {
      absoluteIndex: 10,
      eventId: usefulLoad.id,
      event: usefulLoad,
      leaseKeys: [electricalLeaseKey, electricalOperationLeaseKey],
    },
    {
      absoluteIndex: 11,
      eventId: calibration.id,
      event: calibration,
      leaseKeys: [measurementLeaseKey],
    },
    {
      absoluteIndex: 12,
      eventId: measurement.id,
      event: measurement,
      leaseKeys: [measurementLeaseKey],
    },
    {
      absoluteIndex: 13,
      eventId: recordExperiment.id,
      event: recordExperiment,
      leaseKeys: [MODERN_RECORD_EXPERIMENT_LEASE_KEY],
    },
  ]);
  assert.equal(
    observeModernCivilizationEvidence(cold).satisfied,
    true,
    '三束现代事实移入有界冷见证后仍必须可观察',
  );

  const replicated = replicationModernState();
  const replicatedEvidence = observeModernCivilizationEvidence(replicated.state);
  assert.equal(replicatedEvidence.satisfied, true,
    '可靠读者按他人记录真实复制产物，应成为同一独立记录复用闭环');
  assert.equal(replicatedEvidence.independentRecordExperiment?.eventId, replicated.receipt.id);
  assert.deepEqual({
    projectId: replicatedEvidence.independentRecordExperiment?.projectId,
    recordId: replicatedEvidence.independentRecordExperiment?.recordId,
    knowledgeId: replicatedEvidence.independentRecordExperiment?.knowledgeId,
    readerId: replicatedEvidence.independentRecordExperiment?.readerId,
    recordAuthorId: replicatedEvidence.independentRecordExperiment?.recordAuthorId,
  }, {
    projectId: 'record-use-project',
    recordId: 'record-payload',
    knowledgeId: 'knowledge-technique',
    readerId,
    recordAuthorId: authorId,
  });

  const replicationRetentionFold = beginHistoryRetentionProjection(
    replicated.state,
    { stateHash: 'b'.repeat(64) },
  );
  foldHistoryRetentionSegment(replicationRetentionFold, replicated.state.world.past, 0);
  const replicationRetention = finishHistoryRetentionProjection(replicationRetentionFold);
  const replicationPins = new Map(replicationRetention.pins.map((pin) => [pin.eventId, pin.leaseKeys]));
  for (const eventId of [
    replicated.receipt.id,
    replicated.stoneSource.id,
    replicated.woodSource.id,
  ]) {
    assert.ok(replicationPins.get(eventId)?.includes(MODERN_RECORD_EXPERIMENT_LEASE_KEY),
      `复制闭环必须精确保留见证及其真实输入来源 ${eventId}`);
  }

  const replicatedCold = replicationModernState();
  const replicatedColdReader = replicatedCold.state.people.find((person) => person.id === readerId);
  assert.ok(replicatedColdReader);
  replicatedColdReader.diedAtMonth = 8;
  replicatedColdReader.body.health = 0;
  const replicatedColdEvidenceBefore = observeModernCivilizationEvidence(replicatedCold.state);
  const replicatedColdFacts = [
    replicatedCold.state.world.past.find((event) => event.id === 'electrical-operation-ordinary'),
    replicatedCold.state.world.past.find((event) => event.id === 'electrical-operation-useful-load'),
    replicatedCold.state.world.past.find((event) => event.id === 'mass-calibration'),
    replicatedCold.state.world.past.find((event) => event.id === 'mass-measurement'),
    replicatedCold.stoneSource,
    replicatedCold.woodSource,
    replicatedCold.receipt,
  ];
  assert.ok(replicatedColdFacts.every(Boolean));
  const replicatedColdTail = actionFact(
    'replication-unrelated-hot-tail', 100, { kind: 'act', operation: 'wait', targets: [] }, {},
  );
  replicatedCold.state.world.past = [replicatedColdTail];
  replicatedCold.state.world.historyCursor = {
    version: 1,
    eventCount: 108,
    hotStartIndex: 107,
    tailEventId: replicatedColdTail.id,
  };
  registerRetainedColdWorldEventFacts(replicatedCold.state, replicatedColdFacts.map((event, index) => ({
    absoluteIndex: 20 + index,
    eventId: event.id,
    event,
    leaseKeys: index < 2
      ? index === 0
        ? [electricalOperationLeaseKey]
        : [electricalLeaseKey, electricalOperationLeaseKey]
      : index < 4
        ? [measurementLeaseKey]
        : [MODERN_RECORD_EXPERIMENT_LEASE_KEY],
  })));
  const replicatedColdEvidenceAfter = observeModernCivilizationEvidence(replicatedCold.state);
  assert.equal(replicatedColdEvidenceAfter.satisfied, true,
    '复制收据与输入来源移入冷租约后仍须通过完整 verifier');
  assert.equal(
    replicatedColdEvidenceAfter.independentRecordExperiment?.eventId,
    replicatedColdEvidenceBefore.independentRecordExperiment?.eventId,
    'full 与 bounded/cold 必须选择同一 canonical 记录见证',
  );

  const readOnlyReplication = replicationModernState();
  readOnlyReplication.receipt.diff.recordUseReplicationReceipt = undefined;
  readOnlyReplication.receipt.diff.recordUseStage = 'read';
  assert.equal(observeModernCivilizationEvidence(readOnlyReplication.state).independentRecordExperiment, null,
    '只阅读记录不能冒充独立复制实验');

  const forgedReplication = replicationModernState();
  forgedReplication.state.intents = [];
  assert.equal(observeModernCivilizationEvidence(forgedReplication.state).independentRecordExperiment, null,
    '只有布尔 receipt、没有匹配的完成 intent 时必须 fail-closed');

  const wrongBasisReplication = replicationModernState();
  wrongBasisReplication.state.intents[0].goal.basisKey = 'forged-observer-basis';
  assert.equal(observeModernCivilizationEvidence(wrongBasisReplication.state).independentRecordExperiment, null,
    'receipt 与 intent/basis 不一致时必须 fail-closed');

  const wrongInputReplication = replicationModernState();
  wrongInputReplication.receipt.diff.inputMaterialIds = [Material.Wood, Material.StoneTool];
  assert.equal(observeModernCivilizationEvidence(wrongInputReplication.state).independentRecordExperiment, null,
    'receipt 声称的输入与实际动作 witness 顺序不一致时必须 fail-closed');

  const missingPower = modernState();
  missingPower.world.electricalPower.networks = [];
  const missingPowerEvidence = observeModernCivilizationEvidence(missingPower);
  assert.equal(missingPowerEvidence.electricalPower, null);
  assert.ok(missingPowerEvidence.comparableMeasurement && missingPowerEvidence.independentRecordExperiment);
  assert.equal(missingPowerEvidence.satisfied, false);

  const missingMeasurement = modernState();
  missingMeasurement.projects = missingMeasurement.projects
    .filter((project) => project.id !== 'comparable-mass-project');
  const missingMeasurementEvidence = observeModernCivilizationEvidence(missingMeasurement);
  assert.equal(missingMeasurementEvidence.comparableMeasurement, null);
  assert.ok(missingMeasurementEvidence.electricalPower && missingMeasurementEvidence.independentRecordExperiment);
  assert.equal(missingMeasurementEvidence.satisfied, false);

  const missingRecord = modernState();
  missingRecord.world.past = missingRecord.world.past.filter((event) => event.id !== 'independent-record-experiment');
  const missingRecordEvidence = observeModernCivilizationEvidence(missingRecord);
  assert.equal(missingRecordEvidence.independentRecordExperiment, null);
  assert.ok(missingRecordEvidence.electricalPower && missingRecordEvidence.comparableMeasurement);
  assert.equal(missingRecordEvidence.satisfied, false);

  const successorLedRecord = modernState();
  makeRecordProjectSuccessor(successorLedRecord, 4, 5);
  assert.equal(
    observeModernCivilizationEvidence(successorLedRecord).independentRecordExperiment?.readerId,
    readerId,
    '项目合法接任者在接任后的记录实验应满足同一观察条件',
  );

  const nonLeadRecord = modernState();
  nonLeadRecord.projects.find((project) => project.id === 'record-use-project').ownerId = authorId;
  assert.equal(observeModernCivilizationEvidence(nonLeadRecord).independentRecordExperiment, null,
    '不是项目事件时点负责人的读者不得借项目实验满足记录门槛');

  const futureSuccessorRecord = modernState();
  makeRecordProjectSuccessor(futureSuccessorRecord, 7, 8);
  assert.equal(observeModernCivilizationEvidence(futureSuccessorRecord).independentRecordExperiment, null,
    '实验发生后才接任项目不能追溯改写当时的项目负责人');

  const sameAuthor = modernState();
  const sameAuthorFact = sameAuthor.world.past.find((event) => event.id === 'independent-record-experiment');
  sameAuthorFact.diff.recordUseRecordAuthorId = readerId;
  assert.equal(observeModernCivilizationEvidence(sameAuthor).independentRecordExperiment, null,
    '同一人自写自验不是独立记录复用');

  const ordinaryEnergized = modernState();
  const purportedUsefulLoad = ordinaryEnergized.world.past
    .find((event) => event.id === 'electrical-operation-useful-load');
  purportedUsefulLoad.diff.electricalPowerUsefulLoad = false;
  purportedUsefulLoad.diff.electricalPowerDelivered = true;
  assert.equal(observeModernCivilizationEvidence(ordinaryEnergized).electricalPower, null,
    '普通通电不能冒充实际有用负载');

  const oneOperationOnly = modernState();
  oneOperationOnly.world.past = oneOperationOnly.world.past
    .filter((event) => event.id !== 'electrical-operation-ordinary');
  oneOperationOnly.world.electricalPower.networks[0].operationCount = 1;
  oneOperationOnly.world.electricalPower.networks[0].recentOperationEventIds = [
    'electrical-operation-useful-load',
  ];
  assert.ok(observeModernCivilizationEvidence(oneOperationOnly).electricalPower,
    '完整电网首次完成真实有用负载后即可形成可见成就，不再等待无新交互的重复运行');

  const semanticRecordLearning = modernState();
  const semanticRecordFact = semanticRecordLearning.world.past
    .find((event) => event.id === 'independent-record-experiment');
  semanticRecordFact.diff.recordUseKnowledgeConfidenceBefore = 50;
  semanticRecordFact.diff.recordUseKnowledgeConfidenceAfter = 56;
  assert.ok(observeModernCivilizationEvidence(semanticRecordLearning).independentRecordExperiment,
    '记录成就应核验实验让知识从不可靠变为可靠，不应耦合内部固定学习步长');

  const stillTentativeRecordLearning = modernState();
  const stillTentativeRecordFact = stillTentativeRecordLearning.world.past
    .find((event) => event.id === 'independent-record-experiment');
  stillTentativeRecordFact.diff.recordUseKnowledgeConfidenceBefore = 50;
  stillTentativeRecordFact.diff.recordUseKnowledgeConfidenceAfter = 54;
  assert.equal(observeModernCivilizationEvidence(stillTentativeRecordLearning).independentRecordExperiment, null,
    '实验后仍未达到可靠阈值时不得形成记录复用成就');

  const missingRecordEntity = modernState();
  missingRecordEntity.records = missingRecordEntity.records
    .filter((record) => record.id !== 'record-payload');
  assert.equal(observeModernCivilizationEvidence(missingRecordEntity).independentRecordExperiment, null,
    '实验事件引用的记录实体不存在时必须 fail-closed');

  const institutionalIron = modernState();
  institutionalIron.world.electricalPower.networks = [];
  institutionalIron.projects = [];
  institutionalIron.records = [];
  institutionalIron.clock.elapsedMonths = 30;
  institutionalIron.derived.institutions = [{
    key: 'craft:metalwork-apprentice',
    evidenceEventIds: ['iron-production-0'],
  }];
  const ironBatches = Array.from({ length: 10 }, (_, index) => actionFact(
    `iron-production-${index}`,
    1 + index * 2,
    { kind: 'act', operation: 'combine', targets: [] },
    { outputMaterialId: index === 0 ? Material.Smithy : Material.Iron },
    index % 2 === 0 ? readerId : authorId,
  ));
  const ironAdoption = Array.from({ length: 28 }, (_, index) => actionFact(
    `iron-tool-use-${index}`,
    20 + Math.floor(index / 15),
    { kind: 'act', operation: 'separate', targets: [] },
    { toolMaterialId: Material.IronTool },
    index % 2 === 0 ? readerId : authorId,
  ));
  institutionalIron.world.past = [...ironBatches, ...ironAdoption];
  const ancientObservation = observeCivilizationDevelopment(institutionalIron, 0);
  assert.equal(ancientObservation.candidateEra, 'ancient-civilization');
  assert.equal(ancientObservation.currentEra, 'ancient-civilization',
    '制度化铁器本身应立即成为古代文明成就，不再等待低阶时代、指数、记录或额外年份');
  assert.deepEqual(ancientObservation.missingGateIds, []);

  const progression = modernState();
  progression.civilization.civilizationIndex.total = 0;
  const firstObservation = observeCivilizationDevelopment(progression, 0);
  assert.equal(firstObservation.candidateEra, 'modern-civilization',
    '现代最高事实束必须能越过未满足的低阶观察束');
  assert.equal(firstObservation.currentEra, 'modern-civilization',
    '三项可回放事实闭合后应在本次权威观察直接晋升');
  assert.equal(firstObservation.candidateSinceMonth, 100);
  assert.deepEqual(firstObservation.missingGateIds, [], '现代门槛不得包含文明指数、人口或年代');
  assert.equal(firstObservation.historicalPeakEra, 'modern-civilization');

  progression.civilization.development = firstObservation;
  progression.clock.elapsedMonths = 101;
  progression.world.electricalPower.networks = [];
  const afterCapabilityLoss = observeCivilizationDevelopment(progression, 0);
  assert.notEqual(afterCapabilityLoss.currentEra, 'modern-civilization');
  assert.equal(afterCapabilityLoss.historicalPeakEra, 'modern-civilization', '历史峰值不得随当前能力回落');

  const rssBytes = process.memoryUsage().rss;
  console.log(JSON.stringify({
    ok: true,
    observerVersion: DEVELOPMENT_OBSERVER_VERSION,
    currentEra: firstObservation.currentEra,
    historicalPeakEra: afterCapabilityLoss.historicalPeakEra,
    rssBytes,
    rssMiB: Math.round((rssBytes / 1024 / 1024) * 10) / 10,
    worldCells: WORLD_CELL_COUNT,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
