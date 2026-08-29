import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-record-carrier-integrity-'));
const bundlePath = path.join(temporaryDirectory, 'record-carrier-integrity.mjs');

try {
  const entry = `
    export {
      createInitialState,
      executeActiveIntent,
      RulePlanner,
      startInterruptIntent,
    } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { buildDecisionContext } from ${JSON.stringify(path.resolve('src/game/eland/application/action-options.ts'))};
    export { evaluateCognitiveOption } from ${JSON.stringify(path.resolve('src/game/eland/application/cognition/option-appraisal.ts'))};
    export {
      buildDemandBoundRecordUseOptions,
      recompileRecordUseNextAction,
    } from ${JSON.stringify(path.resolve('src/game/eland/application/record-use-options.ts'))};
    export {
      dropStep,
      consumableInventoryQuantity,
      materialDemand,
      nearestDrop,
      nearestRememberedDrop,
    } from ${JSON.stringify(path.resolve('src/game/eland/application/projects/project-material-planning.ts'))};
    export {
      activeEpisodeStep,
      startDropLogisticsEpisode,
    } from ${JSON.stringify(path.resolve('src/game/eland/application/projects/project-logistics.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export {
      inventoryCombinationForOutput,
      inventoryCombinationTechniqueId,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/interaction-rules.ts'))};
    export { appendCommittedEvents } from ${JSON.stringify(path.resolve('src/game/eland/domain/history.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { cellX, cellY } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=record-carrier-integrity-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const simulation = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    Material,
    RulePlanner,
    activeEpisodeStep,
    appendCommittedEvents,
    buildDecisionContext,
    buildDemandBoundRecordUseOptions,
    cellX,
    cellY,
    consumableInventoryQuantity,
    createInitialState,
    dropStep,
    evaluateCognitiveOption,
    executeActiveIntent,
    executePrimitiveAction,
    inventoryCombinationForOutput,
    inventoryCombinationTechniqueId,
    materialDemand,
    nearestDrop,
    nearestRememberedDrop,
    recompileRecordUseNextAction,
    startDropLogisticsEpisode,
    startInterruptIntent,
  } = simulation;

  const state = createInitialState(821, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
  state.clock.elapsedMonths = 12;
  const reader = state.people[0];
  const author = state.people[1];
  reader.bornAtMonth = -20 * 12;
  author.bornAtMonth = -20 * 12;
  author.position = structuredClone(reader.position);
  appendCommittedEvents(state, [
    {
      id: 'carrier-integrity-stone-tool', kind: 'environment', atMonth: 11, orderInMonth: 0,
      cellId: reader.position.cellId, change: 'resource', who: reader.id,
      result: '专项夹具：真实石制工具来源', diff: { materialId: Material.StoneTool },
    },
    {
      id: 'carrier-integrity-wood', kind: 'environment', atMonth: 11, orderInMonth: 1,
      cellId: reader.position.cellId, change: 'resource', who: reader.id,
      result: '专项夹具：真实木材来源', diff: { materialId: Material.Wood },
    },
  ]);
  reader.inventory = [
    { id: 'carrier-reader-stone-tool', materialId: Material.StoneTool, quantity: 1, sourceEventIds: ['carrier-integrity-stone-tool'] },
    { id: 'carrier-reader-wood', materialId: Material.Wood, quantity: 1, sourceEventIds: ['carrier-integrity-wood'] },
  ];
  author.inventory = [];

  const spearRule = inventoryCombinationForOutput(Material.Spear);
  assert.ok(spearRule);
  const techniqueId = inventoryCombinationTechniqueId(spearRule);
  const codebookId = `codebook:carrier-integrity:${techniqueId}`;
  reader.knowledge = [{
    id: codebookId, kind: 'codebook', summary: '能辨认这组刻痕', confidence: 60,
    learnedAtMonth: 10, sourceEventIds: ['carrier-codebook-teaching'],
  }];
  author.knowledge = [{
    id: techniqueId, kind: 'technique', summary: '石制工具与木材可结合成长矛', confidence: 80,
    learnedAtMonth: 7, sourceEventIds: ['carrier-author-experiment'],
  }];
  const record = {
    id: 'record-carrier-integrity-a', authorId: author.id, knowledgeId: techniqueId,
    codebookId, kind: 'technique', summary: '石制工具与木材可结合成长矛',
    version: 1, createdAtMonth: 8, sourceEventIds: ['carrier-record-writing-a'],
  };
  state.records = [record];
  const project = {
    id: 'project-record-carrier-integrity', kind: 'production', need: 'hunting-safety',
    desiredFunction: 'safer-hunting', summary: '降低下一次捕猎受伤风险',
    ownerId: reader.id, beneficiaryIds: [reader.id], triggerFactIds: ['carrier-failed-hunt'],
    pressure: 74, createdAtMonth: 9, reviewAtMonth: 24, status: 'active',
    lastProgressAtMonth: 12, missingMaterialIds: [], materialDemands: [], reservations: [],
    contributorIds: [reader.id], actionEventIds: [], failureEventIds: ['carrier-failed-hunt'],
    completionEventIds: [], progressEvidence: [], searchCampaigns: [], logisticsEpisodes: [],
  };
  state.projects = [project];
  const parent = {
    id: 'intent-record-carrier-parent', ownerId: reader.id, summary: project.summary,
    domain: 'strategic', goal: { kind: 'project-completed', projectId: project.id },
    nextAction: {
      kind: 'act', operation: 'combine', targets: [
        { kind: 'inventory-stack', personId: reader.id, stackId: 'carrier-reader-stone-tool' },
        { kind: 'inventory-stack', personId: reader.id, stackId: 'carrier-reader-wood' },
      ],
    },
    status: 'active', createdAtMonth: 9, lastProgressAtMonth: 12, progress: 0.3,
    sourceDecisionEventId: 'carrier-project-decision', projectId: project.id,
    sourceFactIds: ['carrier-failed-hunt'], actionEventIds: [], replanCount: 0,
  };
  state.intents = [parent];
  reader.activeIntentId = parent.id;
  const firstDrop = {
    id: 'public-record-carrier-a', materialId: Material.WoodTablet,
    cellId: reader.position.cellId, z: reader.position.z, quantity: 1,
    createdAtMonth: 8, sourceEventIds: ['carrier-record-writing-a', 'carrier-record-publication-a'],
    sourceLineageKeys: ['inventory:author:record-carrier-a'], recordPayloadId: record.id,
  };
  state.world.drops = [firstDrop];
  reader.knownPlaces.push({
    id: `known-record-carrier:${firstDrop.id}`,
    materialId: Material.WoodTablet,
    position: { x: cellX(firstDrop.cellId), y: cellY(firstDrop.cellId), z: firstDrop.z },
    learnedAtMonth: 12,
    lastConfirmedAtMonth: 12,
    sourceEventIds: [...firstDrop.sourceEventIds],
  });

  assert.equal(dropStep(reader, firstDrop, '普通项目补齐木制记录板'), null);
  assert.equal(nearestDrop(state, reader, [firstDrop], [Material.WoodTablet]), undefined,
    'visible generic material logistics must not chase a record-bearing carrier');
  assert.equal(nearestRememberedDrop(state, reader, [Material.WoodTablet]), undefined,
    'remembered generic material logistics must not chase a record-bearing carrier');
  const blankTabletDrop = {
    ...structuredClone(firstDrop),
    id: 'blank-wood-tablet-drop',
    sourceEventIds: ['blank-wood-tablet-source'],
  };
  delete blankTabletDrop.recordPayloadId;
  assert.equal(nearestDrop(
    state,
    reader,
    [firstDrop, blankTabletDrop],
    [Material.WoodTablet],
  )?.id, blankTabletDrop.id,
  'generic logistics must still collect a physically identical blank tablet');
  assert.ok(dropStep(reader, blankTabletDrop, '普通项目补齐木制记录板'));

  const [recordUse] = buildDemandBoundRecordUseOptions(state, reader, [firstDrop]);
  assert.ok(recordUse);
  assert.equal(recordUse.recordUseStage, 'acquire');
  assert.equal(recordUse.nextAction.kind, 'transfer');
  assert.equal(recordUse.nextAction.kind === 'transfer' ? recordUse.nextAction.dropId : undefined, firstDrop.id);
  assert.equal(recordUse.projectId, undefined,
    'record use remains an instrumental child and must not become an ordinary project intent');
  assert.equal(recordUse.projectPressure, undefined);
  assert.equal(recordUse.recordUseBasis.projectId, project.id);
  assert.equal(recordUse.recordUseBasis.projectOwnerId, project.ownerId);
  assert.equal(recordUse.recordUseBasis.readerId, reader.id);
  assert.equal(recordUse.recordUseBasis.projectPressure, project.pressure);

  const context = buildDecisionContext(state, reader, 13);
  const contextualRecordUse = context.options.find((option) => option.recordUseBasis?.recordId === record.id);
  assert.ok(contextualRecordUse);
  const appraisal = evaluateCognitiveOption(context, contextualRecordUse, { atMonth: 13, planningTick: 2 });
  assert.ok(appraisal.needAlignments.some((alignment) => alignment.kind === 'commitment'));
  assert.ok(appraisal.needAlignments.some((alignment) => alignment.kind === 'safety'
    && alignment.projectId === project.id));
  assert.ok(appraisal.factors.some((factor) => factor.kind === 'commitment' && factor.value > 0));
  assert.ok(appraisal.continuityGate > 1,
    'cognition must recognize the basis-bound record use as the same active project');
  const stalePressureOption = structuredClone(contextualRecordUse);
  stalePressureOption.recordUseBasis.projectPressure = 1;
  const currentPressureAppraisal = evaluateCognitiveOption(
    context,
    stalePressureOption,
    { atMonth: 13, planningTick: 2 },
  );
  assert.equal(currentPressureAppraisal.needAlignments.find((alignment) => (
    alignment.kind === 'safety' && alignment.projectId === project.id
  ))?.strength, 1,
  'cognition must use the current active project pressure rather than a stale basis snapshot');

  {
    const childState = structuredClone(state);
    const childReader = childState.people.find((person) => person.id === reader.id);
    const childProject = childState.projects.find((candidate) => candidate.id === project.id);
    assert.ok(childReader && childProject);
    const childContext = buildDecisionContext(childState, childReader, 13);
    const childOption = childContext.options.find((option) => option.recordUseBasis?.recordId === record.id);
    assert.ok(childOption);
    const recordOnlyContext = { ...childContext, options: [childOption], followUpOptions: [] };
    const decision = new RulePlanner().decideAt(recordOnlyContext, { atMonth: 13, planningTick: 2 });
    assert.equal(decision.kind, 'revise');
    assert.equal(decision.interruptionKind, 'record-use');
    const child = startInterruptIntent(
      childState,
      childReader,
      recordOnlyContext,
      decision.optionId,
      'record-carrier-child-decision',
      13,
      'record-use',
    );
    assert.ok(child);
    assert.equal(child.projectId, undefined,
      'the real interrupt child must not route acquire/read through recordProjectAction');
    const actionIdsBefore = [...childProject.actionEventIds];
    const progressBefore = structuredClone(childProject.progressEvidence);
    const acquire = executeActiveIntent(childState, childReader, 13, 0, 2);
    assert.equal(acquire?.kind, 'action');
    assert.equal(acquire.diff.recordUseStage, 'acquire');
    appendCommittedEvents(childState, [acquire]);
    const read = executeActiveIntent(childState, childReader, 13, 1, 3);
    assert.equal(read?.kind, 'action');
    assert.equal(read.diff.recordUseStage, 'read');
    appendCommittedEvents(childState, [read]);
    assert.deepEqual(childProject.actionEventIds, actionIdsBefore,
      'record acquire/read must not become ordinary project actions');
    assert.deepEqual(childProject.progressEvidence, progressBefore,
      'record acquire/read must not create ordinary material progress');
  }

  {
    const legacyState = structuredClone(state);
    const legacyReader = legacyState.people.find((person) => person.id === reader.id);
    const legacyProject = legacyState.projects.find((candidate) => candidate.id === project.id);
    const legacyDrop = legacyState.world.drops.find((drop) => drop.id === firstDrop.id);
    assert.ok(legacyReader && legacyProject && legacyDrop);
    const demand = materialDemand(legacyReader, Material.WoodTablet, 1, 'legacy-record-drop');
    const episode = startDropLogisticsEpisode(
      legacyProject,
      legacyReader,
      legacyDrop,
      legacyDrop.sourceEventIds,
      12,
      demand,
    );
    assert.equal(activeEpisodeStep(
      legacyState,
      legacyReader,
      [legacyDrop],
      legacyProject,
      episode,
    ), null);
    assert.equal(episode.status, 'invalidated',
      'an old locked-drop episode must stop when its exact source is a record carrier');
  }

  {
    const countState = structuredClone(state);
    const countReader = countState.people.find((person) => person.id === reader.id);
    const countProject = countState.projects.find((candidate) => candidate.id === project.id);
    const countRecordDrop = countState.world.drops.find((drop) => drop.id === firstDrop.id);
    const countBlankDrop = structuredClone(blankTabletDrop);
    assert.ok(countReader && countProject && countRecordDrop);
    countState.world.drops.push(countBlankDrop);
    const demand = materialDemand(countReader, Material.WoodTablet, 1, 'blank-tablet-demand');
    const episode = startDropLogisticsEpisode(
      countProject,
      countReader,
      countBlankDrop,
      countBlankDrop.sourceEventIds,
      12,
      demand,
    );
    assert.equal(episode.startingQuantity, 0);
    const recordAcquire = executePrimitiveAction(
      countState,
      countReader,
      {
        kind: 'transfer', materialId: Material.WoodTablet, quantity: 1,
        from: { kind: 'ground', cellId: countRecordDrop.cellId, z: countRecordDrop.z },
        to: { kind: 'person', personId: countReader.id }, dropId: countRecordDrop.id,
      },
      13,
      0,
      { cause: 'intent', actionTick: 1 },
    );
    assert.equal(recordAcquire.status, 'completed');
    appendCommittedEvents(countState, [recordAcquire]);
    assert.equal(consumableInventoryQuantity(countReader, Material.WoodTablet), 0,
      'acquiring a record carrier must not increase generic project inventory');
    const blankStep = activeEpisodeStep(
      countState,
      countReader,
      [countBlankDrop],
      countProject,
      episode,
    );
    assert.equal(episode.status, 'active',
      'record acquisition must not prematurely fulfill a blank-tablet logistics episode');
    assert.equal(blankStep?.action.kind, 'transfer');
    const blankAcquire = executePrimitiveAction(
      countState,
      countReader,
      blankStep.action,
      13,
      1,
      { cause: 'intent', actionTick: 2 },
    );
    assert.equal(blankAcquire.status, 'completed');
    appendCommittedEvents(countState, [blankAcquire]);
    assert.equal(consumableInventoryQuantity(countReader, Material.WoodTablet), 1);
    assert.equal(activeEpisodeStep(
      countState,
      countReader,
      [],
      countProject,
      episode,
    ), null);
    assert.equal(episode.status, 'fulfilled', 'the physically identical blank tablet still fulfills normally');
  }

  const secondRecord = {
    ...structuredClone(record),
    id: 'record-carrier-integrity-b',
    createdAtMonth: 9,
    sourceEventIds: ['carrier-record-writing-b'],
  };
  state.records.push(secondRecord);
  const secondDrop = {
    ...structuredClone(firstDrop),
    id: 'public-record-carrier-b',
    sourceEventIds: ['carrier-record-writing-b', 'carrier-record-publication-b'],
    sourceLineageKeys: ['inventory:author:record-carrier-b'],
    recordPayloadId: secondRecord.id,
  };
  state.world.drops.push(secondDrop);
  const transferFrom = (drop, orderInMonth) => executePrimitiveAction(
    state,
    reader,
    {
      kind: 'transfer', materialId: Material.WoodTablet, quantity: 1,
      from: { kind: 'ground', cellId: drop.cellId, z: drop.z },
      to: { kind: 'person', personId: reader.id }, dropId: drop.id,
    },
    13,
    orderInMonth,
    { cause: 'intent', actionTick: orderInMonth + 1 },
  );
  const firstTransfer = transferFrom(firstDrop, 0);
  assert.equal(firstTransfer.status, 'completed');
  appendCommittedEvents(state, [firstTransfer]);
  const postAcquireIntent = {
    ...structuredClone(parent),
    id: 'intent-record-carrier-read',
    goal: structuredClone(recordUse.goal),
    nextAction: structuredClone(recordUse.nextAction),
    projectId: undefined,
    recordUseBasis: structuredClone(recordUse.recordUseBasis),
    recordUseStage: 'read',
  };
  const readAction = recompileRecordUseNextAction(state, reader, postAcquireIntent);
  assert.equal(readAction?.kind, 'attend', 'record use must continue from acquire to the exact held carrier read');
  const secondTransfer = transferFrom(secondDrop, 1);
  assert.equal(secondTransfer.status, 'completed');
  appendCommittedEvents(state, [secondTransfer]);

  const carriers = reader.inventory.filter((stack) => (
    stack.materialId === Material.WoodTablet && stack.recordPayloadId
  ));
  assert.equal(carriers.length, 2);
  assert.equal(new Set(carriers.map((stack) => stack.id)).size, 2);
  const heldOptions = buildDemandBoundRecordUseOptions(state, reader, []);
  for (const [recordId, transfer] of [
    [record.id, firstTransfer],
    [secondRecord.id, secondTransfer],
  ]) {
    const carrier = carriers.find((stack) => stack.recordPayloadId === recordId);
    assert.ok(carrier?.id.includes(transfer.id));
    assert.equal(reader.inventory.find((stack) => stack.id === carrier.id)?.recordPayloadId, recordId);
    const option = heldOptions.find((candidate) => candidate.recordUseBasis?.recordId === recordId);
    assert.ok(option);
    const heldIntent = {
      ...structuredClone(parent),
      id: `intent-read-${recordId}`,
      goal: structuredClone(option.goal),
      nextAction: structuredClone(option.nextAction),
      projectId: undefined,
      recordUseBasis: structuredClone(option.recordUseBasis),
      recordUseStage: 'read',
    };
    const exactRead = recompileRecordUseNextAction(state, reader, heldIntent);
    assert.equal(exactRead?.kind, 'attend');
    assert.equal(exactRead?.kind === 'attend' && exactRead.target.kind === 'inventory-stack'
      ? exactRead.target.stackId
      : undefined, carrier.id,
    'each record must recompile to its own unique physical carrier');
  }

  process.stdout.write('record carrier integrity tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
