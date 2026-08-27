import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-capability-replication-'));
const bundlePath = path.join(temporaryDirectory, 'capability-replication.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export { buildDecisionContext } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/action-options.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { appendCommittedEvents } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/history.ts'))};
    export {
      inventoryCombinationsForOutput,
      inventoryCombinationTechniqueId,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/interaction-rules.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export {
      projectCompletionEvidence,
      projectFunctionSatisfied,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-completion.ts'))};
    export { deriveProjectProposals } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-proposals.ts'))};
    export { capabilityReplicationBasisFor } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/capability-replication.ts'))};
    export { compileProjectStep } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-step-compiler.ts'))};
    export { recordProjectAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
    export { cellId, cellX, cellY, cellsInRadius, setVoxel } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=capability-replication-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    Material,
    appendCommittedEvents,
    buildDecisionContext,
    capabilityReplicationBasisFor,
    cellId,
    cellX,
    cellY,
    cellsInRadius,
    compileProjectStep,
    createInitialState,
    deriveProjectProposals,
    executePrimitiveAction,
    instantiateProject,
    inventoryCombinationTechniqueId,
    inventoryCombinationsForOutput,
    projectCompletionEvidence,
    projectFunctionSatisfied,
    recordProjectAction,
    setVoxel,
  } = api;

  const elapsedMonth = 10;
  const projectMonth = elapsedMonth + 1;
  const center = cellId(38, 28);

  function stack(id, materialId, quantity = 1, sourceEventIds = [`source:${id}`]) {
    return { id, materialId, quantity, sourceEventIds };
  }

  function placeLivingPerson(person) {
    delete person.diedAtMonth;
    person.bornAtMonth = -30 * 12;
    person.position = {
      ...person.position,
      cellId: center,
      z: 1,
      previousCellId: center,
      previousZ: 1,
      lastPath: [],
      tickPath: [center],
    };
    person.body = { health: 100, hydration: 100, nutrition: 100 };
    person.conditions = [];
    person.inventory = [];
    person.knowledge = [];
    person.knownPlaces = [];
    person.memories = [];
    delete person.activeIntentId;
  }

  function flatten(state) {
    for (const localCell of cellsInRadius(center, 8)) {
      const x = cellX(localCell);
      const y = cellY(localCell);
      for (let z = 0; z < state.world.grid.levels; z += 1) {
        setVoxel(state.world.grid, x, y, z, z === 0 ? Material.PackedSoil : Material.Air);
      }
    }
    setVoxel(state.world.grid, cellX(center) + 1, cellY(center), 1, Material.Stone);
  }

  function actionFact(id, who, atMonth, orderInMonth, action, diff) {
    return {
      id,
      kind: 'action',
      actionTick: orderInMonth,
      atMonth,
      orderInMonth,
      cellId: center,
      who,
      cause: 'intent',
      action,
      fromCellId: center,
      toCellId: center,
      fromZ: 1,
      toZ: 1,
      pathSegment: [center],
      status: 'completed',
      result: id,
      diff,
    };
  }

  function fixture(seed, outputMaterialId) {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 48 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = elapsedMonth;
    state.world.past = [];
    state.world.historyCursor = { version: 1, eventCount: 0, hotStartIndex: 0, tailEventId: null };
    state.world.drops = [];
    state.world.animals = [];
    state.projects = [];
    state.intents = [];
    state.agreements = [];
    state.permissions = [];
    state.collectives = [];
    state.containers = [];
    state.records = [];
    state.eraPredictions = [];
    state.lastStep = [];
    state.civilization.epoch = 'stable';
    state.civilization.climate = { kind: 'temperate', severity: 0, sinceMonth: 0 };
    state.civilization.weather = { kind: 'clear', intensity: 0, sinceMonth: 0 };
    flatten(state);
    for (const person of state.people) person.diedAtMonth = 0;
    const learner = state.people[0];
    const teacher = state.people[1];
    const hiddenProducer = state.people[2];
    assert.ok(learner && teacher && hiddenProducer);
    placeLivingPerson(learner);
    placeLivingPerson(teacher);

    const recipe = inventoryCombinationsForOutput(outputMaterialId)[0];
    assert.ok(recipe, `fixture requires a real recipe for ${outputMaterialId}`);
    const techniqueId = inventoryCombinationTechniqueId(recipe);
    const sampleProduction = actionFact(
      `fact:visible-tool-sample:${outputMaterialId}`,
      hiddenProducer.id,
      9,
      1,
      { kind: 'act', operation: 'combine', targets: [] },
      { outputMaterialId, outputStackId: `visible-tool:${outputMaterialId}`, techniqueId },
    );
    const recentLabor = actionFact(
      `fact:recent-own-labor:${outputMaterialId}`,
      learner.id,
      10,
      1,
      { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position: { x: cellX(center) + 1, y: cellY(center), z: 1 } }] },
      { sourceMaterialId: Material.Stone, outputs: [{ materialId: Material.Stone, quantity: 1 }] },
    );
    appendCommittedEvents(state, [sampleProduction, recentLabor]);
    learner.inventory = [stack('baseline-wood-tool', Material.WoodTool)];
    for (const input of recipe.inputs) {
      learner.inventory.push(stack(`input:${outputMaterialId}:${input.materialId}`, input.materialId, input.quantity));
    }
    teacher.inventory = [stack(`visible-tool:${outputMaterialId}`, outputMaterialId, 1, [sampleProduction.id])];
    teacher.knowledge = [{
      id: techniqueId,
      kind: 'technique',
      summary: `可靠制作 ${outputMaterialId}`,
      confidence: 90,
      learnedAtMonth: 9,
      sourceEventIds: [sampleProduction.id],
    }];
    const visibleCells = cellsInRadius(center, 6);
    return {
      state,
      learner,
      teacher,
      hiddenProducer,
      recipe,
      techniqueId,
      sampleProduction,
      recentLabor,
      visibleCells,
      view: { visibleCells, visibleDrops: [], visiblePeople: [teacher] },
    };
  }

  function appendProjectFact(fixtureState, project, person, action, orderInMonth) {
    const fact = executePrimitiveAction(
      fixtureState,
      person,
      action,
      projectMonth,
      orderInMonth,
      { cause: 'project', actionTick: orderInMonth },
    );
    appendCommittedEvents(fixtureState, [fact]);
    recordProjectAction(fixtureState, project.id, fact);
    assert.equal(fact.status, 'completed', fact.result);
    return fact;
  }

  for (const [index, outputMaterialId] of [Material.StoneTool, Material.BronzeTool].entries()) {
    const current = fixture(77_100 + index, outputMaterialId);
    const observerBasis = capabilityReplicationBasisFor(
      current.state,
      current.learner,
      current.view,
      projectMonth,
    );
    assert.ok(observerBasis, `${outputMaterialId} should use the same visible-scarcity basis`);
    assert.equal('visibleProducerIds' in observerBasis, false,
      'a visible entity must not disclose its maker identity to the planner');
    assert.equal('productionEventId' in observerBasis.exemplar, false);
    assert.deepEqual(observerBasis.sourceFactIds, [current.recentLabor.id]);
    assert.equal(JSON.stringify(observerBasis).includes(current.sampleProduction.id), false,
      'resolvable entity provenance remains world data, not person knowledge');
    assert.equal(JSON.stringify(observerBasis).includes(current.techniqueId), false,
      'seeing a finished tool must not expose its hidden technique');

    current.teacher.inventory[0].sourceEventIds = [];
    assert.deepEqual(
      capabilityReplicationBasisFor(current.state, current.learner, current.view, projectMonth),
      observerBasis,
      'a visible tool with no lineage remains perceptible evidence of capability',
    );
    current.teacher.inventory[0].sourceEventIds = ['hidden:unresolvable-lineage'];
    assert.deepEqual(
      capabilityReplicationBasisFor(current.state, current.learner, current.view, projectMonth),
      observerBasis,
      'unresolvable hidden lineage cannot suppress or enrich the visible basis',
    );

    const beforeObserver = structuredClone(observerBasis);
    const oldStage = current.state.civilization.stage;
    const oldIndex = structuredClone(current.state.civilization.civilizationIndex);
    current.state.civilization.stage = 'information-fixture-only';
    current.state.civilization.civilizationIndex.total = 999;
    current.state.civilization.civilizationIndex.calculatedAtMonth = 999;
    assert.deepEqual(
      capabilityReplicationBasisFor(current.state, current.learner, current.view, projectMonth),
      beforeObserver,
      'observer era/index changes cannot change a person-local capability basis',
    );
    current.state.civilization.stage = oldStage;
    current.state.civilization.civilizationIndex = oldIndex;

    const proposal = deriveProjectProposals(
      current.state,
      current.learner,
      current.visibleCells,
      [],
      [current.teacher],
    ).find((candidate) => candidate.capabilityReplicationBasis?.outputMaterialId === outputMaterialId);
    assert.ok(proposal, `visible scarce tool ${outputMaterialId} should form one generic project`);
    assert.equal(proposal.need, 'production-efficiency');
    assert.equal(proposal.desiredFunction, 'efficient-production');
    assert.equal(proposal.targetKnowledgeId, undefined, 'seeing an output cannot reveal a technique id');
    assert.deepEqual(proposal.triggerFactIds, [current.recentLabor.id]);
    assert.equal(proposal.triggerFactIds.includes(current.sampleProduction.id), false);
    assert.equal(JSON.stringify(proposal).includes(current.techniqueId), false);
    assert.equal(JSON.stringify(proposal).includes('hidden:unresolvable-lineage'), false);
    assert.ok(proposal.pressure >= 42);
    const project = instantiateProject(proposal);
    current.state.projects.push(project);

    const requestStep = compileProjectStep(current.state, current.learner, [], project);
    assert.equal(requestStep?.action.kind, 'communicate');
    assert.equal(requestStep?.action.content.kind, 'request');
    const requestPayload = requestStep?.action.kind === 'communicate'
      && requestStep.action.content.kind === 'request'
      ? requestStep.action.content.projectKnowledgeRequest
      : undefined;
    assert.ok(requestPayload);
    assert.equal(requestPayload.outputMaterialId, outputMaterialId);
    assert.deepEqual(Object.keys(requestPayload).sort(), [
      'expiresAtMonth', 'outputMaterialId', 'projectId', 'requesterId', 'version',
    ]);
    assert.equal(project.planKnowledgeId, undefined);
    assert.deepEqual(project.materialDemands, []);

    const requestFact = appendProjectFact(current.state, project, current.learner, requestStep.action, 1);
    assert.equal(compileProjectStep(current.state, current.learner, [], project), null,
      'an open output-only request waits without inventing a BOM');
    assert.equal(project.planKnowledgeId, undefined);
    assert.deepEqual(project.materialDemands, []);

    const teaching = buildDecisionContext(current.state, current.teacher, projectMonth).options.find((option) => (
      option.nextAction.kind === 'communicate'
        && option.nextAction.content.kind === 'claim'
        && option.nextAction.content.projectKnowledgeResponse?.requestEventId === requestFact.id
    ));
    assert.ok(teaching, 'the visible holder is not presumed to be the maker; only their own reliable knowledge opens a response');
    assert.notEqual(current.sampleProduction.who, current.teacher.id,
      'the responding teacher must be selected from personal knowledge, not hidden entity provenance');
    const responseFact = appendProjectFact(current.state, project, current.teacher, teaching.nextAction, 2);
    assert.equal(responseFact.diff.projectKnowledgeOutputMaterialId, outputMaterialId);
    assert.ok(current.learner.knowledge.some((fact) => fact.id === current.techniqueId
      && fact.confidence >= 55
      && fact.sourceEventIds.includes(responseFact.id)));

    const makeStep = compileProjectStep(current.state, current.learner, [], project);
    assert.equal(project.planKnowledgeId, current.techniqueId,
      'only the real response may let compilation select the exact known plan');
    assert.equal(makeStep?.action.kind, 'act');
    assert.equal(makeStep?.action.operation, 'combine');
    const makeFact = appendProjectFact(current.state, project, current.learner, makeStep.action, 3);
    assert.equal(makeFact.diff.outputMaterialId, outputMaterialId);
    assert.equal(project.status, 'active', 'manufacturing the tool is not project completion');
    assert.equal(projectFunctionSatisfied(current.state, project), false);

    const useStep = compileProjectStep(current.state, current.learner, [], project);
    assert.equal(useStep?.action.kind, 'act');
    assert.equal(useStep?.action.operation, 'separate');
    assert.equal(useStep?.action.toolStackId, makeFact.diff.outputStackId);
    const useFact = appendProjectFact(current.state, project, current.learner, useStep.action, 4);
    assert.equal(useFact.diff.toolStackId, makeFact.diff.outputStackId);
    assert.equal(useFact.diff.toolMaterialId, outputMaterialId);
    assert.ok(Number(useFact.diff.productionMultiplier) > 1);
    assert.ok(Array.isArray(useFact.diff.outputs) && useFact.diff.outputs.some((output) => output.quantity > 0));
    assert.equal(project.status, 'completed');
    assert.deepEqual(projectCompletionEvidence(current.state, project), [responseFact.id, makeFact.id, useFact.id]);
    assert.deepEqual(
      [...new Set([current.sampleProduction.who, makeFact.who])].sort(),
      [current.hiddenProducer.id, current.learner.id].sort(),
      'the second producer is a consequence of the learner actually making the tool',
    );
  }

  {
    const collectible = fixture(77_201, Material.BronzeTool);
    collectible.state.world.drops.push({
      id: 'collectible-bronze-tool',
      materialId: Material.BronzeTool,
      quantity: 1,
      cellId: center,
      z: 1,
      createdAtMonth: 10,
      sourceEventIds: [],
    });
    const view = {
      ...collectible.view,
      visibleDrops: collectible.state.world.drops,
    };
    assert.equal(capabilityReplicationBasisFor(collectible.state, collectible.learner, view, projectMonth), undefined,
      'a reachable ground upgrade belongs to ordinary adoption, not replication');
  }

  {
    const tradeable = fixture(77_202, Material.BronzeTool);
    tradeable.teacher.inventory[0].quantity = 2;
    tradeable.learner.inventory.push(stack('barter-spare', Material.Fiber, 2));
    assert.equal(capabilityReplicationBasisFor(
      tradeable.state,
      tradeable.learner,
      tradeable.view,
      projectMonth,
    ), undefined, 'a holder who can keep a real same-rank spare belongs to the shared trade path');
    const trade = buildDecisionContext(tradeable.state, tradeable.learner, projectMonth).options
      .find((option) => option.id.startsWith('offer-tool-upgrade:'));
    assert.ok(trade, 'replication suppression must preserve the ordinary trade option');
  }

  console.log('capability replication project tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
