import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-cultivation-affordance-'));
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/simulation.ts'))};
    export { addInventory, executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { appendCommittedEvents } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/history.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { composeIntentChoice } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/intent.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export { recordProjectAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
    export { projectCultivationPlantingCells, projectFunctionSatisfied } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-completion.ts'))};
    export { projectOption } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-step-compiler.ts'))};
    export { visibleCellsFor } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-perception.ts'))};
    export { settledCultivationProjectStep } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/steps/cultivation.ts'))};
    export { voxelNoResponseFactId } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/interaction-knowledge.ts'))};
    export { buildDecisionRequestContext } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/model-decision/index.ts'))};
    export { cellId, cellX, cellY, cellsInRadius, setVoxel, voxelAt } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=cultivation-affordance-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    addInventory,
    appendCommittedEvents,
    buildDecisionRequestContext,
    cellId,
    cellX,
    cellY,
    cellsInRadius,
    composeIntentChoice,
    createInitialState,
    executePrimitiveAction,
    instantiateProject,
    projectCultivationPlantingCells,
    projectFunctionSatisfied,
    projectOption,
    recordProjectAction,
    setVoxel,
    settledCultivationProjectStep,
    visibleCellsFor,
    voxelNoResponseFactId,
    voxelAt,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const actorCell = cellId(42, 26);
  const localPlantingCells = [actorCell, cellId(40, 26), cellId(42, 24)];
  const localPackedCells = [cellId(41, 26), cellId(43, 26), cellId(42, 27)];

  function flatten(state, centerCellId) {
    for (const currentCellId of cellsInRadius(centerCellId, 2)) {
      const x = cellX(currentCellId);
      const y = cellY(currentCellId);
      for (let z = 0; z < state.world.grid.levels; z += 1) {
        setVoxel(state.world.grid, x, y, z, z === 0 ? Material.Soil : Material.Air);
      }
    }
  }

  function plantingFact(actor, project, currentCellId, ordinal) {
    const id = `fixture-planting:${project.id}:${ordinal}`;
    const position = { x: cellX(currentCellId), y: cellY(currentCellId), z: 0 };
    return {
      id,
      kind: 'action',
      actionTick: 1,
      atMonth: 10,
      orderInMonth: ordinal,
      cellId: currentCellId,
      who: actor.id,
      cause: 'intent',
      action: {
        kind: 'act',
        operation: 'combine',
        targets: [
          { kind: 'inventory-stack', personId: actor.id, stackId: `historical-seed:${ordinal}` },
          { kind: 'voxel', position },
        ],
      },
      fromCellId: currentCellId,
      toCellId: currentCellId,
      fromZ: 1,
      toZ: 1,
      pathSegment: [currentCellId],
      status: 'completed',
      result: 'fixture completed planting',
      diff: {
        techniqueId: `technique:combine:${Material.Seed}:${Material.ExhaustedSoil}:${Material.CropSprout}`,
        inputMaterialId: Material.Seed,
        targetMaterialId: Material.ExhaustedSoil,
        outputMaterialId: Material.CropSprout,
        position,
        sourceEventId: id,
      },
    };
  }

  function commitProjectFact(fixture, fact) {
    appendCommittedEvents(fixture.state, [fact]);
    recordProjectAction(fixture.state, fixture.project.id, fact);
  }

  function makeFixture({
    seed,
    siteCellId = actorCell,
    plantedCellIds = localPlantingCells,
    packedCellIds = localPackedCells,
    withFieldTool = true,
    withDecoyTool = false,
    elevatedPackedCellId,
  }) {
    const state = createInitialState(seed, {
      endpoint: { kind: 'months', value: 120 },
      chaosIntensity: 0,
    });
    state.clock.elapsedMonths = 12;
    const actor = state.people[0];
    state.people = [actor];
    state.projects = [];
    state.intents = [];
    state.world.drops = [];
    actor.position = { cellId: actorCell, z: 1, lastPath: [] };
    actor.inventory = [];
    actor.knowledge = [];
    actor.memories = [];
    delete actor.activeIntentId;
    flatten(state, actorCell);
    if (siteCellId !== actorCell) flatten(state, siteCellId);
    for (const currentCellId of plantedCellIds) {
      setVoxel(state.world.grid, cellX(currentCellId), cellY(currentCellId), 0, Material.ExhaustedSoil);
    }
    for (const currentCellId of packedCellIds) {
      setVoxel(state.world.grid, cellX(currentCellId), cellY(currentCellId), 0, Material.PackedSoil);
    }
    if (elevatedPackedCellId !== undefined) {
      const x = cellX(elevatedPackedCellId);
      const y = cellY(elevatedPackedCellId);
      for (let z = 0; z <= 3; z += 1) setVoxel(state.world.grid, x, y, z, Material.Soil);
      setVoxel(state.world.grid, x, y, 4, Material.PackedSoil);
    }
    addInventory(actor, Material.Seed, 8, [], `fixture-seed:${seed}`);
    if (withDecoyTool) addInventory(actor, Material.StoneTool, 1, [], `fixture-decoy-tool:${seed}`);
    if (withFieldTool) addInventory(actor, Material.StoneHoe, 1, [], `fixture-field-tool:${seed}`);
    const project = instantiateProject({
      id: `fixture-cultivation:${seed}`,
      kind: 'production',
      need: 'production-efficiency',
      desiredFunction: 'settled-cultivation',
      summary: '把眼前的固定地块形成可重复的食物来源',
      ownerId: actor.id,
      beneficiaryIds: [actor.id],
      triggerFactIds: [],
      pressure: 70,
      createdAtMonth: 1,
      reviewAtMonth: 120,
      site: { cellId: siteCellId, z: 0 },
    });
    state.projects = [project];
    for (const [index, currentCellId] of plantedCellIds.entries()) {
      commitProjectFact({ state, actor, project }, plantingFact(actor, project, currentCellId, index));
    }
    return { state, actor, project };
  }

  const positive = makeFixture({ seed: 9101, withDecoyTool: true });
  const duplicateSeed = positive.actor.inventory.find((stack) => stack.materialId === Material.Seed);
  assert.ok(duplicateSeed);
  const duplicatePosition = {
    x: cellX(localPlantingCells[0]),
    y: cellY(localPlantingCells[0]),
    z: 0,
  };
  const plantingCountBeforeDuplicate = projectCultivationPlantingCells(
    positive.state,
    positive.project,
  ).length;
  const duplicatePlantingFact = executePrimitiveAction(
    positive.state,
    positive.actor,
    {
      kind: 'act',
      operation: 'combine',
      targets: [
        { kind: 'inventory-stack', personId: positive.actor.id, stackId: duplicateSeed.id },
        { kind: 'voxel', position: duplicatePosition },
      ],
    },
    13,
    1,
    { cause: 'intent', actionTick: 1 },
  );
  assert.equal(duplicatePlantingFact.status, 'completed', duplicatePlantingFact.result);
  commitProjectFact(positive, duplicatePlantingFact);
  assert.equal(
    projectCultivationPlantingCells(positive.state, positive.project).length,
    plantingCountBeforeDuplicate,
    'planting an already counted project cell must not inflate distinct progress',
  );
  assert.equal(projectFunctionSatisfied(positive.state, positive.project), false);

  const firstGroundStep = settledCultivationProjectStep(
    positive.state,
    positive.actor,
    positive.project,
  );
  assert.ok(firstGroundStep?.action.kind === 'act'
    && firstGroundStep.action.operation === 'exert');
  assert.deepEqual(
    Object.keys(firstGroundStep.action).sort(),
    ['kind', 'operation', 'targets', 'toolStackId'],
    'unknown ground experiment must carry only the physical tool and visible target',
  );
  assert.equal(firstGroundStep.action.targets.length, 1);
  assert.equal(firstGroundStep.action.targets[0].kind, 'voxel');
  const decoyTool = positive.actor.inventory.find((stack) => stack.materialId === Material.StoneTool);
  const fieldTool = positive.actor.inventory.find((stack) => stack.materialId === Material.StoneHoe);
  assert.ok(decoyTool && fieldTool);
  assert.equal(firstGroundStep.action.toolStackId, decoyTool.id,
    'unknown selection must follow generic tool evidence, not the executor allow-list');
  const firstGroundPosition = firstGroundStep.action.targets[0].position;
  const firstGroundCellId = cellId(firstGroundPosition.x, firstGroundPosition.y);
  assert.ok(localPackedCells.includes(firstGroundCellId));

  const unknownOption = projectOption(positive.project, firstGroundStep);
  const unknownIntent = composeIntentChoice([unknownOption], [], unknownOption.id);
  assert.ok(unknownIntent);
  const plannerContext = buildDecisionRequestContext({
    state: positive.state,
    person: positive.actor,
    visibleCells: visibleCellsFor(positive.actor),
    visiblePeople: [],
    visibleDrops: [],
    visibleAnimals: [],
    options: [unknownOption],
    followUpOptions: [],
  });
  const unknownPayload = JSON.stringify({
    step: firstGroundStep,
    intent: unknownIntent,
    plannerOption: plannerContext.options[0],
  });
  assert.doesNotMatch(
    unknownPayload,
    /(?:technique:exert-ground|outputMaterialId|replacementMaterialId|expectedMaterialId|ruleId|贫瘠土)/u,
    'unknown option, intent and planner context must not contain the rule or its answer',
  );

  const noResponseId = voxelNoResponseFactId(
    'exert',
    Material.PackedSoil,
    Material.PackedSoil,
    Material.StoneTool,
  );
  const firstDecoyFailure = executePrimitiveAction(
    positive.state,
    positive.actor,
    firstGroundStep.action,
    13,
    2,
    { cause: 'intent', actionTick: 2 },
  );
  assert.equal(firstDecoyFailure.status, 'blocked');
  assert.equal(firstDecoyFailure.diff.toolMaterialId, Material.StoneTool);
  assert.equal(firstDecoyFailure.diff.inputMaterialId, Material.PackedSoil);
  assert.equal(firstDecoyFailure.diff.targetMaterialId, Material.PackedSoil);
  assert.deepEqual(
    positive.actor.knowledge.find((fact) => fact.id === noResponseId),
    {
      id: noResponseId,
      kind: 'observation',
      summary: '用石制工具向夯土施力时，夯土没有产生物质变化',
      confidence: 46,
      learnedAtMonth: 13,
      sourceEventIds: [firstDecoyFailure.id],
    },
  );
  commitProjectFact(positive, firstDecoyFailure);

  const secondGroundStep = settledCultivationProjectStep(
    positive.state,
    positive.actor,
    positive.project,
  );
  assert.ok(secondGroundStep?.action.kind === 'act'
    && secondGroundStep.action.operation === 'exert');
  assert.equal(secondGroundStep.action.toolStackId, decoyTool.id,
    'one unsupported trial is not yet reliable enough to discard a candidate');
  const secondDecoyFailure = executePrimitiveAction(
    positive.state,
    positive.actor,
    secondGroundStep.action,
    14,
    1,
    { cause: 'intent', actionTick: 1 },
  );
  assert.equal(secondDecoyFailure.status, 'blocked');
  commitProjectFact(positive, secondDecoyFailure);
  const reliableNoResponse = positive.actor.knowledge.find((fact) => fact.id === noResponseId);
  assert.equal(reliableNoResponse?.confidence, 64);
  assert.deepEqual(
    reliableNoResponse?.sourceEventIds,
    [firstDecoyFailure.id, secondDecoyFailure.id],
  );

  const successfulGroundStep = settledCultivationProjectStep(
    positive.state,
    positive.actor,
    positive.project,
  );
  assert.ok(successfulGroundStep?.action.kind === 'act'
    && successfulGroundStep.action.operation === 'exert');
  assert.equal(successfulGroundStep.action.toolStackId, fieldTool.id,
    'reliable exact no-response evidence must make the person try another general tool');
  assert.deepEqual(successfulGroundStep.action.targets, firstGroundStep.action.targets);
  assert.doesNotMatch(
    JSON.stringify(successfulGroundStep),
    /(?:technique:exert-ground|outputMaterialId|replacementMaterialId|expectedMaterialId|ruleId|贫瘠土)/u,
  );
  const toolQuantityBefore = fieldTool.quantity;
  const firstGroundFact = executePrimitiveAction(
    positive.state,
    positive.actor,
    successfulGroundStep.action,
    15,
    1,
    { cause: 'intent', actionTick: 1 },
  );
  assert.equal(firstGroundFact.status, 'completed', firstGroundFact.result);
  assert.equal(firstGroundFact.diff.targetMaterialId, Material.PackedSoil);
  assert.equal(firstGroundFact.diff.outputMaterialId, Material.ExhaustedSoil);
  assert.deepEqual(firstGroundFact.diff.materialChanges, [{
    cellId: firstGroundCellId,
    z: firstGroundPosition.z,
    from: Material.PackedSoil,
    to: Material.ExhaustedSoil,
  }]);
  assert.equal(voxelAt(
    positive.state.world.grid,
    firstGroundPosition.x,
    firstGroundPosition.y,
    firstGroundPosition.z,
  ), Material.ExhaustedSoil);
  assert.equal(fieldTool.quantity, toolQuantityBefore, 'ground work must not consume its tool');
  const learnedGroundTechnique = positive.actor.knowledge.find((fact) => (
    fact.id === firstGroundFact.diff.techniqueId
  ));
  assert.ok(learnedGroundTechnique);
  assert.deepEqual(learnedGroundTechnique.sourceEventIds, [firstGroundFact.id]);
  commitProjectFact(positive, firstGroundFact);

  const plantingStep = settledCultivationProjectStep(
    positive.state,
    positive.actor,
    positive.project,
  );
  assert.ok(plantingStep?.action.kind === 'act'
    && plantingStep.action.operation === 'combine');
  const plantingTarget = plantingStep.action.targets.find((target) => target.kind === 'voxel');
  assert.deepEqual(plantingTarget?.position, firstGroundPosition,
    'the newly available, never-planted cell must outrank old project cells');
  const plantingFactResult = executePrimitiveAction(
    positive.state,
    positive.actor,
    plantingStep.action,
    15,
    2,
    { cause: 'intent', actionTick: 2 },
  );
  assert.equal(plantingFactResult.status, 'completed', plantingFactResult.result);
  commitProjectFact(positive, plantingFactResult);
  assert.equal(projectCultivationPlantingCells(positive.state, positive.project).length, 4);
  assert.ok(projectCultivationPlantingCells(positive.state, positive.project).includes(firstGroundCellId));

  const newlyPlantedCells = [firstGroundCellId];
  let orderInMonth = 3;
  for (const expectedDistinctCount of [5, 6]) {
    const reuseStep = settledCultivationProjectStep(
      positive.state,
      positive.actor,
      positive.project,
    );
    assert.ok(reuseStep?.action.kind === 'act' && reuseStep.action.operation === 'exert');
    assert.match(reuseStep.key, /reuse-ground-practice/u);
    assert.equal(reuseStep.action.toolStackId, fieldTool.id,
      'a sourced successful technique must outrank unknown general tool candidates');
    assert.ok(reuseStep.sourceFactIds.includes(firstGroundFact.id),
      'known reuse must carry the successful authoritative source');
    assert.doesNotMatch(JSON.stringify(reuseStep.action), /outputMaterialId|replacementMaterialId|ruleId/u);
    const reuseTarget = reuseStep.action.targets[0];
    assert.equal(reuseTarget.kind, 'voxel');
    const reuseFact = executePrimitiveAction(
      positive.state,
      positive.actor,
      reuseStep.action,
      15,
      orderInMonth,
      { cause: 'intent', actionTick: orderInMonth },
    );
    orderInMonth += 1;
    assert.equal(reuseFact.status, 'completed', reuseFact.result);
    assert.equal(fieldTool.quantity, toolQuantityBefore);
    commitProjectFact(positive, reuseFact);
    assert.ok(positive.actor.knowledge.find((fact) => fact.id === learnedGroundTechnique.id)
      ?.sourceEventIds.includes(reuseFact.id));

    const nextPlantingStep = settledCultivationProjectStep(
      positive.state,
      positive.actor,
      positive.project,
    );
    assert.ok(nextPlantingStep?.action.kind === 'act'
      && nextPlantingStep.action.operation === 'combine');
    const nextPlantingTarget = nextPlantingStep.action.targets.find((target) => target.kind === 'voxel');
    assert.deepEqual(nextPlantingTarget?.position, reuseTarget.position,
      'each newly conditioned project cell must be planted before another ground trial');
    const nextPlantingFact = executePrimitiveAction(
      positive.state,
      positive.actor,
      nextPlantingStep.action,
      15,
      orderInMonth,
      { cause: 'intent', actionTick: orderInMonth },
    );
    orderInMonth += 1;
    assert.equal(nextPlantingFact.status, 'completed', nextPlantingFact.result);
    commitProjectFact(positive, nextPlantingFact);
    const plantedCellId = cellId(reuseTarget.position.x, reuseTarget.position.y);
    newlyPlantedCells.push(plantedCellId);
    assert.equal(
      projectCultivationPlantingCells(positive.state, positive.project).length,
      expectedDistinctCount,
    );
    assert.equal(projectFunctionSatisfied(positive.state, positive.project), false);
  }
  assert.equal(new Set(newlyPlantedCells).size, 3);
  assert.equal(projectCultivationPlantingCells(positive.state, positive.project).length, 6);
  assert.equal(settledCultivationProjectStep(
    positive.state,
    positive.actor,
    positive.project,
  ), null, 'six distinct project plantings must stop ground conditioning before maturation');

  for (const plantedCellId of newlyPlantedCells.slice(0, 2)) {
    setVoxel(
      positive.state.world.grid,
      cellX(plantedCellId),
      cellY(plantedCellId),
      0,
      Material.CropMature,
    );
  }
  for (let harvestIndex = 0; harvestIndex < 2; harvestIndex += 1) {
    const harvestStep = settledCultivationProjectStep(
      positive.state,
      positive.actor,
      positive.project,
    );
    assert.ok(harvestStep?.action.kind === 'act'
      && harvestStep.action.operation === 'separate');
    const harvestFact = executePrimitiveAction(
      positive.state,
      positive.actor,
      harvestStep.action,
      16,
      harvestIndex + 1,
      { cause: 'intent', actionTick: harvestIndex + 1 },
    );
    assert.equal(harvestFact.status, 'completed', harvestFact.result);
    assert.equal(harvestFact.diff.sourceMaterialId, Material.CropMature);
    commitProjectFact(positive, harvestFact);
    assert.equal(
      projectFunctionSatisfied(positive.state, positive.project),
      harvestIndex === 1,
      'settled cultivation is satisfied only after six distinct plantings and two real harvests',
    );
  }
  assert.equal(positive.project.status, 'completed');

  const noTool = makeFixture({ seed: 9102, withFieldTool: false, withDecoyTool: false });
  assert.equal(settledCultivationProjectStep(noTool.state, noTool.actor, noTool.project), null,
    'without a field tool the project must expose no ground action');

  const remoteSite = cellId(60, 26);
  const remotePlantingCells = [remoteSite, cellId(59, 26), cellId(60, 25)];
  const invisible = makeFixture({
    seed: 9103,
    siteCellId: remoteSite,
    plantedCellIds: remotePlantingCells,
    packedCellIds: [cellId(61, 26)],
  });
  assert.equal(settledCultivationProjectStep(invisible.state, invisible.actor, invisible.project), null,
    'a packed target outside personal visibility must not become a project action');

  const unreachable = makeFixture({
    seed: 9104,
    packedCellIds: [],
    elevatedPackedCellId: cellId(43, 26),
  });
  assert.equal(settledCultivationProjectStep(unreachable.state, unreachable.actor, unreachable.project), null,
    'a visible packed target without a standing path must not become a project action');

  const sixPlantingCells = [
    actorCell,
    cellId(41, 26),
    cellId(42, 25),
    cellId(43, 26),
    cellId(42, 27),
    cellId(40, 26),
  ];
  const enoughDistinctPlots = makeFixture({
    seed: 9105,
    plantedCellIds: sixPlantingCells,
    packedCellIds: [cellId(44, 26)],
  });
  assert.equal(
    projectCultivationPlantingCells(enoughDistinctPlots.state, enoughDistinctPlots.project).length,
    6,
  );
  assert.equal(settledCultivationProjectStep(
    enoughDistinctPlots.state,
    enoughDistinctPlots.actor,
    enoughDistinctPlots.project,
  ), null, 'six distinct completed project plantings must prevent further ground conditioning');
  assert.equal(voxelAt(enoughDistinctPlots.state.world.grid, 44, 26, 0), Material.PackedSoil);

  process.stdout.write('cultivation affordance tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
