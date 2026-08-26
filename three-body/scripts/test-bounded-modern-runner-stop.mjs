import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-bounded-modern-stop-'));
const dataDirectory = path.join(temporaryDirectory, 'data');
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');
const runnerPath = path.join(workspace, 'scripts/run-bounded-modern-evolution.mjs');
const verifierPath = path.join(workspace, 'scripts/verify-era-boundary-ledger.mjs');
let store;

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

function runRunner(runId, seed, options = {}) {
  const targetMonth = options.targetMonth ?? 24;
  const stopOnModern = options.stopOnModern ?? true;
  const hotLimit = options.hotLimit ?? 2_048;
  const args = [
    runnerPath,
    dataDirectory,
    runId,
    String(seed),
    String(targetMonth),
    String(hotLimit),
    ...(stopOnModern ? ['stop-on-modern'] : []),
  ];
  const child = spawnSync(process.execPath, args, {
    cwd: workspace,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512' },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const stdout = child.stdout.trim();
  assert.ok(stdout, `${runId} runner 没有 JSON stdout: ${child.stderr}`);
  return { child, result: JSON.parse(stdout) };
}

function verifyLedger(runId) {
  const child = spawnSync(process.execPath, [verifierPath, dataDirectory, runId], {
    cwd: workspace,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512' },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const stdout = child.stdout.trim();
  assert.ok(stdout, `${runId} verifier 没有 JSON stdout: ${child.stderr}`);
  return { child, result: JSON.parse(stdout) };
}

try {
  writeFileSync(entryPath, [
    `export { SqliteRunStore } from ${JSON.stringify(path.join(workspace, 'server/sqlite-run-store.ts'))};`,
    `export { createInitialState } from ${JSON.stringify(path.join(workspace, 'src/game/eland/simulation.ts'))};`,
    `export { Material } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/material.ts'))};`,
    `export { createElectricalPowerNetwork, plannedElectricalPowerComponents, recordElectricalPowerInstallation } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/electrical-power.ts'))};`,
    `export { MASS_MEASUREMENT_RESOLUTION, MASS_MEASUREMENT_UNIT, SOURCED_MASS_MEASUREMENT_ACTION_VERSION } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/measurement.ts'))};`,
    `export { derivePhysicalStructureIndex } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/physical-structure-index.ts'))};`,
    `export { observeCivilizationDevelopment, observeModernCivilizationEvidence } from ${JSON.stringify(path.join(workspace, 'src/game/eland/domain/era-progression.ts'))};`,
    `export { setVoxel } from ${JSON.stringify(path.join(workspace, 'src/game/eland/world/grid.ts'))};`,
  ].join('\n'));
  const build = spawnSync(path.join(workspace, 'node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--log-level=error',
    `--outfile=${bundlePath}`,
  ], { cwd: workspace, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  function installModernFacts(state) {
    const [reader, author] = state.people;
    assert.ok(reader && author, '现代见证 fixture 需要至少两名人物');
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
      const id = `modern-electrical-install-${index}`;
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
      return action(id, 1, index + 1, reader.id, {
        kind: 'act', operation: 'combine', targets: [],
      }, {
        outputMaterialId: component.materialId,
        position: component.position,
      });
    });
    const ordinaryOperation = action(
      'modern-electrical-operation-ordinary',
      2,
      1,
      reader.id,
      { kind: 'act', operation: 'exert', targets: [] },
      {
        electricalPowerOperation: true,
        electricalPowerDelivered: true,
        electricalPowerUsefulLoad: false,
        electricalNetworkId: network.id,
      },
    );
    const usefulLoad = action(
      'modern-electrical-operation-useful-load',
      3,
      1,
      reader.id,
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
      version: 'electrical-power-world-v1',
      networks: [network],
      dispatchWindows: [],
    };

    const instrumentUse = {
      personId: reader.id,
      stackId: 'modern-beam-balance-stack',
      quantity: 1,
      sourceEventIds: ['modern-made-beam-balance'],
    };
    const referenceUse = {
      personId: reader.id,
      stackId: 'modern-standard-weight-stack',
      quantity: 1,
      sourceEventIds: ['modern-made-standard-weight'],
    };
    const subjectUse = {
      personId: reader.id,
      stackId: 'modern-measurement-subject-stack',
      quantity: 1,
      sourceEventIds: ['modern-made-measurement-subject'],
    };
    const instrumentReceipt = {
      ...instrumentUse,
      materialId: api.Material.BeamBalance,
      heldQuantity: 1,
    };
    const referenceReceipt = {
      ...referenceUse,
      materialId: api.Material.StandardWeight,
      heldQuantity: 1,
    };
    const subjectReceipt = {
      ...subjectUse,
      materialId: api.Material.Stone,
      heldQuantity: 1,
    };
    const calibration = action('modern-mass-calibration', 4, 1, reader.id, {
      kind: 'attend',
      target: { kind: 'inventory-stack', personId: reader.id, stackId: referenceUse.stackId },
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
      calibrationEventId: 'modern-mass-calibration',
      calibratedByPersonId: reader.id,
      calibratedAtMonth: 4,
      dimension: 'mass',
      unit: api.MASS_MEASUREMENT_UNIT,
      resolution: api.MASS_MEASUREMENT_RESOLUTION,
      instrument: instrumentReceipt,
      reference: referenceReceipt,
    });
    const measurement = action('modern-mass-measurement', 5, 1, reader.id, {
      kind: 'attend',
      target: { kind: 'inventory-stack', personId: reader.id, stackId: subjectUse.stackId },
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
      measurementEventId: 'modern-mass-measurement',
      measuredByPersonId: reader.id,
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
      'modern-independent-record-experiment',
      6,
      1,
      reader.id,
      { kind: 'act', operation: 'combine', targets: [] },
      {
        recordUseStage: 'experiment',
        recordUseProjectId: 'modern-record-use-project',
        recordUseRecordId: 'modern-record-payload',
        recordUseKnowledgeId: 'modern-knowledge-technique',
        recordUseTechniqueId: 'modern-knowledge-technique',
        recordUseReaderId: reader.id,
        recordUseRecordAuthorId: author.id,
        recordUseExpectedOutputMaterialId: api.Material.Spear,
        recordUseKnowledgeConfidenceBefore: 46,
        recordUseKnowledgeConfidenceAfter: 64,
        outputMaterialId: api.Material.Spear,
      },
    );
    reader.knowledge.push({
      id: 'modern-knowledge-technique',
      kind: 'technique',
      confidence: 64,
      sourceEventIds: [recordExperiment.id],
    }, {
      id: 'modern-record-codebook',
      kind: 'codebook',
      confidence: 70,
      sourceEventIds: ['modern-codebook-source'],
    });
    state.records.push({
      id: 'modern-record-payload',
      authorId: author.id,
      knowledgeId: 'modern-knowledge-technique',
      codebookId: 'modern-record-codebook',
      kind: 'technique',
      summary: 'modern fixture technique',
      version: 1,
      createdAtMonth: 1,
      sourceEventIds: ['modern-record-source'],
    });
    state.projects.push({
      id: 'modern-record-use-project',
      kind: 'production',
      need: 'food-preparation',
      status: 'completed',
      ownerId: reader.id,
      desiredFunction: 'prepared-food',
      summary: 'modern record experiment fixture',
      pressure: 50,
      createdAtMonth: 1,
      reviewAtMonth: 7,
      lastProgressAtMonth: 6,
      completedAtMonth: 6,
      actionEventIds: [recordExperiment.id],
      failureEventIds: [],
      completionEventIds: [recordExperiment.id],
      missingMaterialIds: [],
      beneficiaryIds: [],
      contributorIds: [],
      triggerFactIds: [],
      reservations: [],
    }, {
      id: 'modern-comparable-mass-project',
      kind: 'inquiry',
      need: 'measurement-uncertainty',
      status: 'completed',
      desiredFunction: 'comparable-mass-measurement',
      ownerId: reader.id,
      summary: 'modern comparable mass fixture',
      pressure: 50,
      createdAtMonth: 1,
      reviewAtMonth: 6,
      lastProgressAtMonth: 5,
      completedAtMonth: 5,
      actionEventIds: [calibration.id, measurement.id],
      failureEventIds: [],
      completionEventIds: [calibration.id, measurement.id],
      missingMaterialIds: [],
      beneficiaryIds: [],
      contributorIds: [],
      triggerFactIds: [],
      reservations: [],
      measurementUncertaintyBasis: {
        version: 'measurement-uncertainty-basis-v1',
        observerId: reader.id,
        atMonth: 1,
        uncertaintyKind: 'overlapping-felt-load-bands',
        samples: [{
          personId: reader.id,
          stackId: subjectUse.stackId,
          materialId: api.Material.Stone,
          quantity: 1,
          perceivedLoadBand: 'hand-load',
          sourceEventIds: [...subjectUse.sourceEventIds],
          productionEventIds: [...subjectUse.sourceEventIds],
        }, {
          personId: reader.id,
          stackId: 'modern-second-subject',
          materialId: api.Material.Wood,
          quantity: 2,
          perceivedLoadBand: 'hand-load',
          sourceEventIds: ['modern-made-second-subject'],
          productionEventIds: ['modern-made-second-subject'],
        }],
        productionEventIds: ['modern-made-measurement-subject', 'modern-made-second-subject'],
        experiencedMonthCount: 2,
        sourceFactIds: ['modern-mass-comparison-doubt'],
        basisKey: 'modern-measurement-basis',
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
    state.world.historyCursor = {
      version: 1,
      eventCount: state.world.past.length,
      hotStartIndex: 0,
      tailEventId: state.world.past.at(-1)?.id ?? null,
    };
    state.world.physicalStructureIndex = api.derivePhysicalStructureIndex(state);
  }

  async function createModernEvidenceRun(
    runId,
    seed,
    materializeDevelopment,
    endpoint = { kind: 'months', value: 120 },
    hotLimit = 2_048,
    preloadColdHistory = false,
  ) {
    const initialState = api.createInitialState(seed, {
      endpoint,
      chaosIntensity: 0,
    });
    await store.create({ id: runId, state: initialState });
    const persisted = await store.load(runId);
    const state = persisted.state;
    state.clock.elapsedMonths = 11;
    if (preloadColdHistory) {
      const who = state.people[0]?.id;
      assert.ok(who, `${runId} cold-history fixture 缺少人物`);
      for (let index = 0; index < 256; index += 1) {
        state.world.past.push(action(
          `cold-history-filler-${index}`,
          0,
          index + 1,
          who,
          { type: 'move', toCellId: 0 },
          {},
        ));
      }
    }
    installModernFacts(state);
    const evidence = api.observeModernCivilizationEvidence(state);
    assert.equal(evidence.satisfied, true, `${runId} 缺少现代三联见证`);
    if (materializeDevelopment) {
      state.civilization.development = api.observeCivilizationDevelopment(state, 0);
      assert.equal(state.civilization.development.currentEra, 'modern-civilization');
    }
    assert.notEqual(state.civilization.stage, 'modern-civilization');
    await store.save(runId, state);
    await store.bootstrapBoundedEvolutionContinuation(runId, hotLimit);
  }

  store = new api.SqliteRunStore(dataDirectory);
  await createModernEvidenceRun('modern-stop-initial', 93_001, true);
  await createModernEvidenceRun('modern-stop-annual', 93_002, false);
  await createModernEvidenceRun(
    'modern-proof-history',
    93_003,
    false,
    { kind: 'months', value: 120 },
    192,
    true,
  );
  await createModernEvidenceRun(
    'modern-terminal-same-boundary',
    93_004,
    false,
    { kind: 'months', value: 12 },
  );
  store.close();
  store = undefined;

  const initial = runRunner('modern-stop-initial', 93_001);
  assert.equal(initial.child.status, 0, `${initial.child.stderr}\n${initial.child.stdout}`);
  assert.equal(initial.result.ok, true);
  assert.equal(initial.result.startMonth, 11);
  assert.equal(initial.result.reachedMonth, 11);
  assert.equal(initial.result.reachedModernAtMonth, 11);
  assert.equal(initial.result.development.current, 'modern-civilization');
  assert.equal(initial.result.modernEvidence.satisfied, true);
  assert.notEqual(initial.result.stage, 'modern-civilization');

  const annual = runRunner('modern-stop-annual', 93_002);
  assert.equal(annual.child.status, 0, `${annual.child.stderr}\n${annual.child.stdout}`);
  assert.equal(annual.result.ok, true);
  assert.equal(annual.result.startMonth, 11);
  assert.equal(annual.result.reachedMonth, 12);
  assert.equal(annual.result.reachedModernAtMonth, 12);
  assert.equal(annual.result.development.current, 'modern-civilization');
  assert.equal(annual.result.modernEvidence.satisfied, true);
  assert.notEqual(annual.result.stage, 'modern-civilization');

  const proofHistory = runRunner(
    'modern-proof-history',
    93_003,
    { targetMonth: 24, stopOnModern: false, hotLimit: 192 },
  );
  assert.equal(
    proofHistory.child.status,
    0,
    `${proofHistory.child.stderr}\n${proofHistory.child.stdout}`,
  );
  assert.equal(proofHistory.result.ok, true);
  assert.equal(proofHistory.result.reachedMonth, 24);
  assert.equal(proofHistory.result.reachedModernAtMonth, 12);
  const proofLedgerPath = proofHistory.result.eraBoundaryLedger.path;
  const proofLines = readFileSync(proofLedgerPath, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  const transitionLine = proofLines.find((line) => line.type === 'boundary'
    && line.authority.month === 12);
  assert.ok(transitionLine?.proof, '现代 transition 必须写 compact proof pack');
  assert.equal(transitionLine.transition.kind, 'skip');
  assert.deepEqual(transitionLine.transition.skipped, [
    'agrarian-settlement',
    'ancient-civilization',
  ]);
  const transitionProof = JSON.parse(readFileSync(
    path.join(dataDirectory, transitionLine.proof.relativePath),
    'utf8',
  ));
  assert.equal(
    transitionProof.fields.rootA.some((field) => field.fieldName === 'historyCursor'),
    false,
    'cold root A shell 应省略 historyCursor',
  );
  assert.equal(
    transitionProof.fields.rootB.some((field) => field.fieldName === 'historyCursor'),
    false,
    'cold root B shell 应省略 historyCursor',
  );
  assert.equal(
    transitionProof.historyCursorSeals.rootA.evidence,
    'root-metadata+continuation-bundle',
  );
  assert.equal(
    transitionProof.historyCursorSeals.rootB.evidence,
    'root-metadata+continuation-bundle',
  );
  const proofDatabase = new DatabaseSync(
    path.join(dataDirectory, 'eland.sqlite3'),
  );
  try {
    proofDatabase.exec('PRAGMA foreign_keys = ON');
    const deletedCheckpoint = proofDatabase.prepare(
      'DELETE FROM run_checkpoints WHERE run_id = ? AND revision = ?',
    ).run('modern-proof-history', transitionLine.authority.revision);
    assert.equal(Number(deletedCheckpoint.changes), 1, '必须删除 transition exact checkpoint');
    const deletedRoots = proofDatabase.prepare(
      'DELETE FROM chunks WHERE hash IN (?, ?)',
    ).run(transitionLine.authority.stateHash, transitionLine.observer.source.stateHash);
    assert.equal(Number(deletedRoots.changes), 2, '必须删除 transition root A/B 以模拟 checkpoint pruning');
  } finally {
    proofDatabase.close();
  }
  const historicalProof = verifyLedger('modern-proof-history');
  assert.equal(
    historicalProof.child.status,
    0,
    `${historicalProof.child.stderr}\n${historicalProof.child.stdout}`,
  );
  assert.equal(historicalProof.result.ok, true);
  const transitionStrength = historicalProof.result.proofStrength.find(
    (proof) => proof.seq === transitionLine.seq,
  );
  assert.equal(transitionStrength?.strength, 'proof-pack');
  assert.match(transitionStrength?.limitation ?? '', /observer-field-proof/u);

  const modernTerminal = runRunner('modern-terminal-same-boundary', 93_004);
  assert.equal(
    modernTerminal.child.status,
    0,
    `${modernTerminal.child.stderr}\n${modernTerminal.child.stdout}`,
  );
  assert.equal(modernTerminal.result.ok, true);
  assert.equal(modernTerminal.result.reachedMonth, 12);
  assert.equal(modernTerminal.result.reachedModernAtMonth, 12);
  assert.equal(modernTerminal.result.reachedTerminalAtMonth, 12);
  assert.equal(modernTerminal.result.terminalKind, 'months-endpoint');
  const terminalLines = readFileSync(modernTerminal.result.eraBoundaryLedger.path, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  const terminalBoundaries = terminalLines.filter((line) => line.type === 'boundary');
  assert.equal(terminalBoundaries.length, 1, 'modern+terminal 同月只能写一条 boundary');
  assert.equal(terminalBoundaries[0].modern.satisfied, true);
  assert.equal(terminalBoundaries[0].status, 'ended');
  assert.equal(terminalBoundaries[0].survivingModern, false);
  const verifiedTerminal = verifyLedger('modern-terminal-same-boundary');
  assert.equal(
    verifiedTerminal.child.status,
    0,
    `${verifiedTerminal.child.stderr}\n${verifiedTerminal.child.stdout}`,
  );
  assert.equal(verifiedTerminal.result.modernEvidenceVerified, true);
  assert.equal(verifiedTerminal.result.pathSatisfied, true);
  assert.equal(verifiedTerminal.result.strictPathSatisfied, false);
  assert.equal(verifiedTerminal.result.terminal?.month, 12);
  assert.equal(verifiedTerminal.result.survivingModern, false);

  const maxRss = Math.max(
    process.resourceUsage().maxRSS * 1_024,
    initial.result.maxRss,
    annual.result.maxRss,
    proofHistory.result.maxRss,
    historicalProof.result.maxRss,
    modernTerminal.result.maxRss,
    verifiedTerminal.result.maxRss,
  );
  assert.equal(maxRss <= 384 * 1_024 * 1_024, true, `modern ledger fixture RSS ${maxRss} 超过 384MiB`);
  console.log(JSON.stringify({
    ok: true,
    initial: { start: initial.result.startMonth, stopped: initial.result.reachedMonth },
    annual: { start: annual.result.startMonth, stopped: annual.result.reachedMonth },
    transitionProof: {
      month: transitionLine.authority.month,
      strength: transitionStrength.strength,
      oldRootsDeleted: true,
    },
    modernTerminal: {
      month: modernTerminal.result.reachedMonth,
      boundaryLines: terminalBoundaries.length,
      survivingModern: verifiedTerminal.result.survivingModern,
    },
    maxRss,
  }));
} finally {
  store?.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
