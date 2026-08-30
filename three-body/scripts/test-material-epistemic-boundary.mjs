import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-material-epistemic-boundary-'));
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/simulation.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { inventoryCombinationsForOutput, inventoryCombinationTechniqueId } from ${JSON.stringify(path.resolve('src/game/eland/domain/interaction-rules.ts'))};
    export { ensureProject } from ${JSON.stringify(path.resolve('src/game/eland/application/project-options.ts'))};
    export { compileProjectStep } from ${JSON.stringify(path.resolve('src/game/eland/application/projects/project-step-compiler.ts'))};
    export { projectMaterialPlanProvenance } from ${JSON.stringify(path.resolve('src/game/eland/application/projects/project-material-provenance.ts'))};
    export { buildDecisionRequestContext } from ${JSON.stringify(path.resolve('src/game/eland/application/model-decision/index.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=material-epistemic-boundary-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    Material,
    buildDecisionRequestContext,
    compileProjectStep,
    createInitialState,
    ensureProject,
    inventoryCombinationTechniqueId,
    inventoryCombinationsForOutput,
    projectMaterialPlanProvenance,
  } = api;

  function makeFixture(withVerifiedKnowledge) {
    const state = createInitialState(9121, { chaosIntensity: 0, endpoint: { kind: 'months', value: 24 } });
    const actor = state.people[0];
    state.people = [actor];
    actor.inventory = [];
    state.world.drops = [{
      id: 'local-visible-sample',
      materialId: Material.Steel,
      quantity: 1,
      cellId: actor.position.cellId,
      z: actor.position.z,
      createdAtMonth: 0,
      sourceEventIds: ['local-material-observation'],
    }];
    const project = ensureProject(state, {
      id: withVerifiedKnowledge ? 'known-kiln-project' : 'unknown-kiln-project',
      kind: 'production',
      need: 'high-heat-capability',
      desiredFunction: 'high-heat-processing',
      summary: '寻找能稳定提供高温的实体办法',
      ownerId: actor.id,
      beneficiaryIds: [actor.id],
      triggerFactIds: ['high-heat-pressure'],
      pressure: 72,
      createdAtMonth: 1,
      reviewAtMonth: 24,
    });
    if (withVerifiedKnowledge) {
      const kilnRule = inventoryCombinationsForOutput(Material.Kiln)[0];
      assert.ok(kilnRule, 'fixture requires the authoritative kiln rule');
      actor.knowledge.push({
        id: inventoryCombinationTechniqueId(kilnRule),
        kind: 'technique',
        summary: '本人已核验黏土与石料可结合成窑炉',
        confidence: 72,
        learnedAtMonth: 0,
        sourceEventIds: ['verified-kiln-technique-fact'],
      });
    }
    const intent = {
      id: `intent:${project.id}`,
      ownerId: actor.id,
      summary: project.summary,
      domain: 'strategic',
      projectId: project.id,
      goal: { kind: 'project-completed', projectId: project.id },
      nextAction: { kind: 'move', toCellId: actor.position.cellId, toZ: actor.position.z },
      status: 'active',
      createdAtMonth: 0,
      lastProgressAtMonth: 0,
      progress: 0,
      sourceDecisionEventId: `decision:${project.id}`,
      sourceFactIds: [],
      actionEventIds: [],
      replanCount: 0,
    };
    state.intents.push(intent);
    actor.activeIntentId = intent.id;
    compileProjectStep(state, actor, state.world.drops, project);
    const context = {
      state,
      person: actor,
      visibleCells: [actor.position.cellId],
      visiblePeople: [],
      visibleDrops: state.world.drops,
      visibleAnimals: [],
      options: [],
      followUpOptions: [],
      activeIntent: intent,
    };
    return { state, actor, project, projected: buildDecisionRequestContext(context) };
  }

  const unknown = makeFixture(false);
  assert.equal(projectMaterialPlanProvenance(unknown.state, unknown.actor, unknown.project), null);
  assert.deepEqual(unknown.project.missingMaterialIds, [],
    'desiredFunction alone must not compile an exact BOM');
  assert.equal(unknown.projected.activeProject.materialPlan.status, 'unresolved');
  const unknownProjectJson = JSON.stringify(unknown.projected.activeProject);
  assert.doesNotMatch(unknownProjectJson, /missingMaterials|desiredFunction|materialId/u,
    'unknown project context must expose neither exact demand nor functional identifier');
  assert.doesNotMatch(JSON.stringify(unknown.projected.visibleDrops), /\b(?:building|facility|smeltable|tool|fuel)\b/u,
    'model-visible material profiles must not contain raw functional tags');
  assert.ok(unknown.projected.visibleDrops[0].properties.includes('metallic'));

  const known = makeFixture(true);
  const provenance = projectMaterialPlanProvenance(known.state, known.actor, known.project);
  assert.equal(provenance?.kind, 'verified-technique');
  assert.ok(provenance?.knowledgeId);
  assert.deepEqual(new Set(known.project.missingMaterialIds), new Set([Material.Clay, Material.Stone]),
    'the same project may recover its exact demand after verified knowledge is present');
  assert.equal(known.projected.activeProject.materialPlan.status, 'verified');
  assert.deepEqual(
    new Set(known.projected.activeProject.materialPlan.missingMaterials.map((item) => item.name)),
    new Set(['黏土', '石']),
  );

  process.stdout.write('material epistemic boundary tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
