import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sourcePath = path.resolve('src/game/eland/application/project-hypotheses.ts');
const source = readFileSync(sourcePath, 'utf8');
assert.ok(!source.includes('interaction-rules'), 'unknown hypothesis generation must not import the authoritative interaction rule table');
assert.ok(!source.includes('inventoryCombinationFor'), 'unknown hypothesis generation must not query successful combinations or outputs');
assert.ok(!/Material\.(Stone|Wood|Fiber|Hide|Rope|Leaves)/.test(source), 'unknown hypothesis generation must not hard-code successful material pairs');

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-fallible-hypothesis-test-'));
const bundlePath = path.join(temporaryDirectory, 'fallible-hypothesis.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export { inventoryCombinationForOutput, inventoryCombinationTechniqueId } from ${JSON.stringify(path.resolve('src/game/eland/domain/interaction-rules.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { inventoryNoResponseFactId } from ${JSON.stringify(path.resolve('src/game/eland/domain/interaction-knowledge.ts'))};
    export { recordProjectAction, recompileProjectNextAction, synchronizeProject } from ${JSON.stringify(path.resolve('src/game/eland/application/project-options.ts'))};
    export { nextProjectHypothesisCandidate, refreshProjectHypothesisCampaign } from ${JSON.stringify(sourcePath)};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=fallible-material-hypothesis-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const simulation = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    Material,
    createInitialState,
    executePrimitiveAction,
    inventoryCombinationForOutput,
    inventoryCombinationTechniqueId,
    inventoryNoResponseFactId,
    nextProjectHypothesisCandidate,
    recordProjectAction,
    recompileProjectNextAction,
    refreshProjectHypothesisCampaign,
    synchronizeProject,
  } = simulation;

  const makeProject = (actor, id = 'fallible-project', desiredFunction = 'safer-hunting') => ({
    id, kind: 'inquiry', need: desiredFunction === 'healing' ? 'care-capability' : 'hunting-safety',
    desiredFunction, summary: '解决一个真实的局部功能困境', ownerId: actor.id,
    beneficiaryIds: [actor.id], triggerFactIds: ['local-pressure'], pressure: 70,
    createdAtMonth: 1, reviewAtMonth: 100, status: 'active', lastProgressAtMonth: 1,
    missingMaterialIds: [], materialDemands: [], reservations: [], contributorIds: [actor.id],
    actionEventIds: [], failureEventIds: [], completionEventIds: [], progressEvidence: [],
    searchCampaigns: [], logisticsEpisodes: [],
  });

  const groundedInventory = (actor) => [
    [Material.Stone, 8], [Material.Wood, 8], [Material.Fiber, 8], [Material.Leaves, 8], [Material.Hide, 8],
  ].map(([materialId, quantity]) => ({
    id: `grounded-${actor.id}-${materialId}`, materialId, quantity,
    sourceEventIds: [`observed-${actor.id}-${materialId}`],
  }));

  {
    const firstKeys = new Set();
    for (let seed = 1; seed <= 80; seed += 1) {
      const state = createInitialState(seed, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
      state.clock.elapsedMonths = 6;
      const actor = state.people[0];
      actor.inventory = groundedInventory(actor);
      const project = makeProject(actor, 'rank-project');
      const first = nextProjectHypothesisCandidate(seed, 7, actor, project, []);
      assert.ok(first);
      firstKeys.add(first.key);
      const replayProject = makeProject(actor, 'rank-project');
      assert.equal(nextProjectHypothesisCandidate(seed, 7, actor, replayProject, [])?.key, first.key,
        'same local state, project and seed must replay the same first hypothesis');
    }
    assert.ok(firstKeys.size >= 2, 'replayable perturbation should create more than one plausible first hypothesis across seeds');
    assert.ok([...firstKeys].some((key) => key !== `${Material.Stone}+${Material.Wood}`),
      'the correct stone-and-wood pair must not always be first');
  }

  {
    const state = createInitialState(922, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 6;
    const actor = state.people[0];
    actor.inventory = [{
      id: 'only-stone', materialId: Material.Stone, quantity: 2, sourceEventIds: ['held-stone'],
    }];
    const project = makeProject(actor, 'grounding-project');
    const campaign = refreshProjectHypothesisCampaign(state.seed, 7, actor, project, []);
    assert.ok(campaign.candidates.every((candidate) => candidate.materialIds.every((id) => id === Material.Stone)),
      'materials that exist globally but were never touched or seen must not enter candidates');
    assert.ok(campaign.candidates.every((candidate) => candidate.sourceKeys.includes('inventory:' + actor.id + ':only-stone')));
  }

  {
    const state = createInitialState(923, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 6;
    const actor = state.people[0];
    actor.inventory = [Material.Soil, Material.WetSoil, Material.Sand, Material.Water, Material.Grass]
      .map((materialId) => ({
        id: `nonreactive-${actor.id}-${materialId}`, materialId, quantity: 8,
        sourceEventIds: [`observed-${actor.id}-${materialId}`],
      }));
    actor.conditions.push({
      id: 'persistent-test-wound', kind: 'wound', stage: 2, sinceMonth: 4,
      sourceEventIds: ['persistent-test-wound-source'],
    });
    const project = makeProject(actor, 'budget-project', 'healing');
    state.projects = [project];
    const seen = new Set();
    for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
      const candidate = nextProjectHypothesisCandidate(state.seed, 7 + ordinal, actor, project, []);
      assert.ok(candidate, `attempt ${ordinal} should have a grounded candidate`);
      assert.ok(!seen.has(candidate.key), 'a project must not repeat the same pair');
      seen.add(candidate.key);
      const refs = candidate.materialIds.map((materialId, index) => {
        const stack = actor.inventory.find((item) => item.materialId === materialId);
        assert.ok(stack);
        return { kind: 'inventory-stack', personId: actor.id, stackId: stack.id };
      });
      const fact = executePrimitiveAction(
        state, actor, { kind: 'act', operation: 'combine', targets: refs },
        7 + ordinal, ordinal, { cause: 'intent', actionTick: ordinal },
      );
      recordProjectAction(state, project.id, fact);
      assert.equal(fact.diff.projectHypothesisAttemptOrdinal, ordinal);
      assert.equal(fact.diff.projectHypothesisHadReliableKnowledge, false);
      assert.deepEqual(fact.diff.projectHypothesisMaterialIds, candidate.materialIds);
    }
    assert.equal(project.hypothesisCampaign.attempts.length, 4);
    assert.equal(project.hypothesisCampaign.status, 'exhausted');
    assert.equal(project.hypothesisCampaign.endingReason, 'no-response-budget-exhausted');
    assert.equal(nextProjectHypothesisCandidate(state.seed, 20, actor, project, []), null,
      'pure time and replanning must not reset an exhausted campaign');
    assert.equal(new Set(project.hypothesisCampaign.attempts.map((attempt) => attempt.candidateKey)).size, 4);
    assert.ok(project.hypothesisCampaign.attempts.some((attempt) => attempt.outcome === 'no-response'));
    const persisted = JSON.parse(JSON.stringify(project.hypothesisCampaign));
    assert.deepEqual(JSON.parse(JSON.stringify(project)).hypothesisCampaign, persisted,
      'campaign candidates, attempts and budget must survive state JSON persistence');
    project.status = 'blocked';
    synchronizeProject(state, project, 21);
    assert.equal(project.hypothesisCampaign.status, 'exhausted',
      'closing a project must not overwrite the stronger attempt-budget exhaustion state');
    assert.equal(project.hypothesisCampaign.endingReason, 'no-response-budget-exhausted');
  }

  {
    const state = createInitialState(926, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 6;
    const actor = state.people[0];
    actor.inventory = [
      { id: 'split-fiber-a', materialId: Material.Fiber, quantity: 1, sourceEventIds: ['fiber-a'] },
      { id: 'split-fiber-b', materialId: Material.Fiber, quantity: 1, sourceEventIds: ['fiber-b'] },
    ];
    const project = makeProject(actor, 'split-stack-project', 'insulation');
    project.need = 'thermal-safety';
    state.projects = [project];
    const action = recompileProjectNextAction(state, actor, project.id);
    assert.equal(action?.kind, 'act');
    assert.equal(action?.operation, 'combine');
    assert.deepEqual(action?.targets.map((target) => target.kind === 'inventory-stack' ? target.stackId : ''), [
      'split-fiber-a', 'split-fiber-b',
    ], 'same-material hypotheses must use two one-unit stacks when no single stack has quantity two');
  }

  {
    const state = createInitialState(927, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 6;
    const actor = state.people[0];
    actor.conditions.push({
      id: 'memory-test-wound', kind: 'wound', stage: 2, sinceMonth: 4,
      sourceEventIds: ['memory-test-wound-source'],
    });
    actor.inventory = [
      { id: 'memory-stone', materialId: Material.Stone, quantity: 1, sourceEventIds: ['memory-stone-source'] },
      { id: 'memory-leaves', materialId: Material.Leaves, quantity: 1, sourceEventIds: ['memory-leaves-source'] },
    ];
    const attemptInProject = (id, month) => {
      const project = makeProject(actor, id, 'healing');
      state.projects.push(project);
      const candidate = nextProjectHypothesisCandidate(state.seed, month, actor, project, []);
      assert.ok(candidate);
      assert.equal(candidate.key, `${Material.Stone}+${Material.Leaves}`);
      const fact = executePrimitiveAction(state, actor, {
        kind: 'act', operation: 'combine', targets: [
          { kind: 'inventory-stack', personId: actor.id, stackId: 'memory-stone' },
          { kind: 'inventory-stack', personId: actor.id, stackId: 'memory-leaves' },
        ],
      }, month, 0, { cause: 'intent', actionTick: 1 });
      assert.equal(fact.status, 'blocked');
      recordProjectAction(state, project.id, fact);
      return project;
    };
    const firstProject = attemptInProject('memory-project-a', 7);
    assert.equal(firstProject.hypothesisCampaign.attempts.length, 1);
    assert.equal(actor.knowledge.find((fact) => fact.id === inventoryNoResponseFactId([Material.Stone, Material.Leaves]))?.confidence, 46);
    const secondProject = attemptInProject('memory-project-b', 8);
    assert.equal(secondProject.hypothesisCampaign.attempts.length, 1,
      'tentative no-response may be independently checked by a later project');
    assert.equal(actor.knowledge.find((fact) => fact.id === inventoryNoResponseFactId([Material.Stone, Material.Leaves]))?.confidence, 64);
    const thirdProject = makeProject(actor, 'memory-project-c', 'healing');
    state.projects.push(thirdProject);
    assert.equal(nextProjectHypothesisCandidate(state.seed, 9, actor, thirdProject, []), null,
      'reliable cross-project no-response knowledge must suppress the pair');
    assert.equal(thirdProject.hypothesisCampaign.attempts.length, 0,
      'inherited no-response knowledge must not fabricate a project attempt');
  }

  {
    const state = createInitialState(924, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 6;
    const actor = state.people[0];
    actor.inventory = groundedInventory(actor);
    const project = makeProject(actor, 'known-no-response-project', 'healing');
    const first = nextProjectHypothesisCandidate(state.seed, 7, actor, project, []);
    assert.ok(first);
    actor.knowledge.push({
      id: inventoryNoResponseFactId([...first.materialIds]), kind: 'observation', summary: '此前已反复没有反应',
      confidence: 64, learnedAtMonth: 5, sourceEventIds: ['older-failure-a', 'older-failure-b'],
    });
    project.hypothesisCampaign.activeCandidateKey = first.key;
    const next = nextProjectHypothesisCandidate(state.seed, 7, actor, project, []);
    assert.ok(next);
    assert.notEqual(next.key, first.key, 'reliable personal no-response knowledge must suppress that pair without consuming project budget');
    assert.equal(project.hypothesisCampaign.attempts.length, 0);
  }

  {
    const state = createInitialState(925, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 6;
    const actor = state.people[0];
    actor.inventory = [
      { id: 'known-raw', materialId: Material.RawMeat, quantity: 1, sourceEventIds: ['raw-meat'] },
      { id: 'known-stone', materialId: Material.Stone, quantity: 1, sourceEventIds: ['stone'] },
      { id: 'known-wood', materialId: Material.Wood, quantity: 1, sourceEventIds: ['wood'] },
    ];
    const stoneToolRule = inventoryCombinationForOutput(Material.StoneTool);
    assert.ok(stoneToolRule);
    const techniqueId = inventoryCombinationTechniqueId(stoneToolRule);
    actor.knowledge = [{
      id: techniqueId, kind: 'technique', summary: '已核验的石制工具方法', confidence: 72,
      learnedAtMonth: 5, sourceEventIds: ['verified-technique'],
    }];
    const project = {
      ...makeProject(actor, 'known-project', 'prepared-food'),
      kind: 'inquiry', need: 'food-preparation',
    };
    state.projects = [project];
    const action = recompileProjectNextAction(state, actor, project.id);
    assert.equal(action?.kind, 'act');
    assert.equal(action?.operation, 'combine');
    assert.equal(project.planKnowledgeId, techniqueId);
    assert.equal(project.hypothesisCampaign, undefined,
      'reliable technique knowledge should compile directly without opening a blind campaign');
  }

  process.stdout.write('fallible material hypothesis tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
