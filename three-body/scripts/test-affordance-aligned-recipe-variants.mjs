import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-affordance-variants-'));
const bundlePath = path.join(temporaryDirectory, 'affordance-variants.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/simulation.ts'))};
    export { addInventory, executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { appendCommittedEvents } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/history.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export {
      inventoryCombinationFor,
      inventoryCombinationForOutput,
      inventoryCombinationsForOutput,
      inventoryCombinationTechniqueId,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/interaction-rules.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export {
      projectHypothesisCandidateKey,
      refreshProjectHypothesisCampaign,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-hypotheses.ts'))};
    export { hypothesisStep } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-inquiry.ts'))};
    export { mechanicalUnknownOutputQuestionKind } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-step-compiler.ts'))};
    export { recordProjectAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
    export {
      compileKnownOutput,
      knownRecipe,
      knownRecipes,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/steps/known-material-production.ts'))};
    export { hypothesisMetrics } from ${JSON.stringify(path.join(projectRoot, 'server/evolution-artifacts/hypothesis-metrics.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=affordance-variants-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    Material,
    addInventory,
    appendCommittedEvents,
    compileKnownOutput,
    createInitialState,
    executePrimitiveAction,
    hypothesisMetrics,
    hypothesisStep,
    instantiateProject,
    inventoryCombinationFor,
    inventoryCombinationForOutput,
    inventoryCombinationsForOutput,
    inventoryCombinationTechniqueId,
    knownRecipe,
    knownRecipes,
    mechanicalUnknownOutputQuestionKind,
    projectHypothesisCandidateKey,
    recordProjectAction,
    refreshProjectHypothesisCampaign,
  } = api;

  const inputSignature = (rule) => [...rule.inputs]
    .sort((left, right) => left.materialId - right.materialId)
    .map((input) => `${input.materialId}x${input.quantity}`)
    .join('+');
  const signature = (...inputs) => inputs
    .sort((left, right) => left[0] - right[0])
    .map(([materialId, quantity]) => `${materialId}x${quantity}`)
    .join('+');
  const signaturesFor = (outputMaterialId) => new Set(
    inventoryCombinationsForOutput(outputMaterialId).map(inputSignature),
  );

  assert.deepEqual(signaturesFor(Material.WaterWheel), new Set([
    signature([Material.Plank, 1], [Material.Fiber, 1]),
    signature([Material.Wood, 1], [Material.Fiber, 1]),
  ]));
  assert.deepEqual(signaturesFor(Material.DriveShaft), new Set([
    signature([Material.Bronze, 1], [Material.Plank, 1]),
    signature([Material.Copper, 1], [Material.Plank, 1]),
    signature([Material.Iron, 1], [Material.Plank, 1]),
  ]));
  assert.deepEqual(signaturesFor(Material.BeamBalance), new Set([
    signature([Material.Plank, 2], [Material.Rope, 1]),
    signature([Material.Wood, 2], [Material.Rope, 1]),
    signature([Material.Plank, 2], [Material.Fiber, 1]),
    signature([Material.Wood, 2], [Material.Fiber, 1]),
  ]));
  assert.deepEqual(signaturesFor(Material.StandardWeight), new Set([
    signature([Material.Bronze, 1], [Material.Rope, 1]),
    signature([Material.Bronze, 1], [Material.Fiber, 1]),
    signature([Material.Copper, 1], [Material.Fiber, 1]),
    signature([Material.Iron, 1], [Material.Fiber, 1]),
    signature([Material.Iron, 1], [Material.Rope, 1]),
  ]));
  for (const outputMaterialId of [
    Material.WaterWheel,
    Material.DriveShaft,
    Material.BeamBalance,
    Material.StandardWeight,
  ]) {
    for (const rule of inventoryCombinationsForOutput(outputMaterialId)) {
      const exactInputs = rule.inputs.flatMap((input) => Array(input.quantity).fill(input.materialId));
      assert.equal(inventoryCombinationFor(exactInputs)?.id, rule.id,
        `variant ${rule.id} must be the real physical response for its exact inputs`);
    }
  }
  assert.notEqual(inventoryCombinationFor([Material.Wood, Material.Rope])?.output.materialId, Material.WaterWheel);
  assert.notEqual(inventoryCombinationFor([Material.Plank, Material.Rope])?.output.materialId, Material.WaterWheel);
  assert.notEqual(inventoryCombinationFor([Material.Copper, Material.Rope])?.output.materialId, Material.StandardWeight);
  assert.equal(mechanicalUnknownOutputQuestionKind(Material.WaterWheel), 'assemble-flow-driven-rotor');
  assert.equal(mechanicalUnknownOutputQuestionKind(Material.DriveShaft), 'shape-rigid-rotating-connector');
  assert.equal(mechanicalUnknownOutputQuestionKind(Material.Mill), null);

  function freshProject(seed, desiredFunction, need = 'mechanical-power-capability') {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 120 }, chaosIntensity: 0 });
    state.projects = [];
    const actor = state.people[0];
    actor.inventory = [];
    actor.knowledge = [];
    actor.memories = [];
    const project = instantiateProject({
      id: `affordance-project-${seed}`,
      kind: 'inquiry',
      need,
      desiredFunction,
      summary: '解决眼前可触摸构件的功能问题',
      ownerId: actor.id,
      beneficiaryIds: [actor.id],
      triggerFactIds: [],
      pressure: 60,
      createdAtMonth: 0,
      reviewAtMonth: 24,
    });
    state.projects = [project];
    return { state, actor, project };
  }

  function addExactInputs(actor, inputs, prefix) {
    inputs.forEach(([materialId, quantity], index) => {
      addInventory(actor, materialId, quantity, [], `${prefix}-${index}`);
    });
  }

  function runNaturalResponse({ seed, desiredFunction, need, questionKind, inputs, expectedOutput }) {
    const fixture = freshProject(seed, desiredFunction, need);
    addExactInputs(fixture.actor, inputs, `input-${seed}`);
    const request = { operation: 'combine-inventory', questionKind };
    const campaign = refreshProjectHypothesisCampaign(
      fixture.state.seed,
      1,
      fixture.actor,
      fixture.project,
      [],
      request,
    );
    const exactInputs = inputs.flatMap(([materialId, quantity]) => Array(quantity).fill(materialId))
      .sort((left, right) => left - right);
    const coarsePair = [exactInputs[0], exactInputs.at(-1)];
    const key = projectHypothesisCandidateKey(
      'combine-inventory',
      coarsePair,
      undefined,
      exactInputs,
    );
    const candidate = campaign.candidates.find((item) => item.key === key
      && item.questionKind === questionKind);
    assert.ok(candidate, `${questionKind} must naturally include the locally grounded legal variant`);
    assert.equal('expectedOutputMaterialId' in candidate, false);
    const step = hypothesisStep(fixture.state, fixture.actor, [], fixture.project, request);
    assert.ok(step?.action.kind === 'act' && step.action.operation === 'combine');
    const fact = executePrimitiveAction(
      fixture.state,
      fixture.actor,
      step.action,
      1,
      1,
      { cause: 'intent', actionTick: 1 },
    );
    assert.equal(fact.status, 'completed', fact.result);
    assert.equal(fact.diff.outputMaterialId, expectedOutput);
    appendCommittedEvents(fixture.state, [fact]);
    recordProjectAction(fixture.state, fixture.project.id, fact);
    const attempt = fixture.project.hypothesisCampaign.attempts.at(-1);
    assert.equal(attempt?.questionKind, questionKind);
    assert.equal(attempt?.outcome, 'response');
    assert.equal(attempt?.candidateKey, key);
    return { ...fixture, fact, key };
  }

  const rotorResponse = runNaturalResponse({
    seed: 401,
    desiredFunction: 'water-powered-crop-processing',
    questionKind: 'assemble-flow-driven-rotor',
    inputs: [[Material.Wood, 1], [Material.Fiber, 1]],
    expectedOutput: Material.WaterWheel,
  });
  const shaftResponse = runNaturalResponse({
    seed: 402,
    desiredFunction: 'water-powered-crop-processing',
    questionKind: 'shape-rigid-rotating-connector',
    inputs: [[Material.Copper, 1], [Material.Plank, 1]],
    expectedOutput: Material.DriveShaft,
  });
  const balanceResponse = runNaturalResponse({
    seed: 403,
    desiredFunction: 'comparable-mass-measurement',
    need: 'measurement-uncertainty',
    questionKind: 'assemble-balanced-suspension',
    inputs: [[Material.Wood, 2], [Material.Rope, 1]],
    expectedOutput: Material.BeamBalance,
  });
  runNaturalResponse({
    seed: 404,
    desiredFunction: 'comparable-mass-measurement',
    need: 'measurement-uncertainty',
    questionKind: 'shape-repeatable-reference',
    inputs: [[Material.Iron, 1], [Material.Fiber, 1]],
    expectedOutput: Material.StandardWeight,
  });

  const balanceReport = hypothesisMetrics(balanceResponse.state);
  assert.equal(balanceReport.hypothesisAssembleBalancedSuspensionResponses, 1);
  assert.equal(balanceReport.hypothesisActionDiffSignatureMismatches, 0,
    'the real three-slot response must retain the exact candidate, attempt, action, and diff signature');
  const rotorReport = hypothesisMetrics(rotorResponse.state);
  assert.equal(rotorReport.hypothesisAssembleFlowDrivenRotorResponses, 1);
  assert.equal(rotorReport.hypothesisQuestionOperationMismatches, 0);
  assert.equal(rotorReport.hypothesisActionDiffSignatureMismatches, 0);
  const shaftReport = hypothesisMetrics(shaftResponse.state);
  assert.equal(shaftReport.hypothesisShapeRigidRotatingConnectorResponses, 1);
  assert.equal(shaftReport.hypothesisQuestionOperationMismatches, 0);
  assert.equal(shaftReport.hypothesisActionDiffSignatureMismatches, 0);

  function candidatesFor(seed, questionKind, inputs) {
    const fixture = freshProject(seed, 'comparable-mass-measurement', 'measurement-uncertainty');
    addExactInputs(fixture.actor, inputs, `rejected-${seed}`);
    return refreshProjectHypothesisCampaign(
      fixture.state.seed,
      1,
      fixture.actor,
      fixture.project,
      [],
      { operation: 'combine-inventory', questionKind },
    ).candidates.filter((candidate) => candidate.questionKind === questionKind);
  }
  assert.equal(candidatesFor(405, 'assemble-balanced-suspension', [
    [Material.WoodTool, 2], [Material.Rope, 1],
  ]).length, 0, 'tools are not symmetric structural members');
  assert.equal(candidatesFor(406, 'assemble-balanced-suspension', [
    [Material.Spear, 2], [Material.Fiber, 1],
  ]).length, 0, 'weapons are not symmetric structural members');
  assert.equal(candidatesFor(407, 'assemble-balanced-suspension', [
    [Material.Wood, 2], [Material.Hide, 1],
  ]).length, 0, 'heavy hide is not a light suspension connector');
  assert.equal(candidatesFor(408, 'shape-repeatable-reference', [
    [Material.Copper, 1], [Material.Rope, 1],
  ]).length, 0, 'soft copper plus thick rope is not a grounded stable reference variant');

  const knownFixture = freshProject(409, 'water-powered-crop-processing');
  addExactInputs(knownFixture.actor, [[Material.Wood, 1], [Material.Fiber, 1]], 'known-variant');
  const firstWheelRule = inventoryCombinationForOutput(Material.WaterWheel);
  const woodWheelRule = inventoryCombinationsForOutput(Material.WaterWheel).find((rule) => (
    inputSignature(rule) === signature([Material.Wood, 1], [Material.Fiber, 1])
  ));
  assert.ok(firstWheelRule && woodWheelRule && firstWheelRule.id !== woodWheelRule.id);
  for (const [rule, confidence] of [[firstWheelRule, 80], [woodWheelRule, 70]]) {
    knownFixture.actor.knowledge.push({
      id: inventoryCombinationTechniqueId(rule),
      kind: 'technique',
      summary: '已核验的构件经验',
      confidence,
      learnedAtMonth: 0,
      sourceEventIds: [`known-${rule.id}`],
    });
  }
  assert.equal(knownRecipes(knownFixture.actor, Material.WaterWheel).length, 2);
  assert.equal(knownRecipe(knownFixture.actor, Material.WaterWheel)?.rule.id, woodWheelRule.id,
    'selection must consider every reliable variant and prefer the one whose inputs are held');
  const knownStep = compileKnownOutput(
    knownFixture.state,
    knownFixture.actor,
    [],
    Material.WaterWheel,
    '复用本人已经掌握的非首配方',
  );
  assert.ok(knownStep?.action.kind === 'act' && knownStep.action.operation === 'combine');
  const knownFact = executePrimitiveAction(
    knownFixture.state,
    knownFixture.actor,
    knownStep.action,
    1,
    1,
    { cause: 'intent', actionTick: 1 },
  );
  assert.equal(knownFact.status, 'completed', knownFact.result);
  assert.equal(knownFact.diff.outputMaterialId, Material.WaterWheel);
  assert.equal(knownFact.diff.techniqueId, inventoryCombinationTechniqueId(woodWheelRule));

  console.log('affordance-aligned recipe variant tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
