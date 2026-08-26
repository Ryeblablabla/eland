import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const hypothesisPath = path.resolve('src/game/eland/application/project-hypotheses.ts');
const questionPath = path.resolve('src/game/eland/application/project-material-questions.ts');
const perceptionPath = path.resolve('src/game/eland/domain/material-perception.ts');
const hypothesisSource = readFileSync(hypothesisPath, 'utf8');
const questionSource = readFileSync(questionPath, 'utf8');

assert.ok(!hypothesisSource.includes('projectMaterialFocus'));
assert.ok(!hypothesisSource.includes('candidateMatchesProjectFocus'));
assert.ok(!hypothesisSource.includes('project-material-focus'));
assert.ok(!hypothesisSource.includes('interaction-rules'));
assert.ok(!/\bMaterial\./.test(hypothesisSource), 'hypothesis ranking must not name exact materials');
assert.ok(!/seededRank\s*:\s*[^,\n]+\+\s*100/.test(hypothesisSource));
assert.ok(!/materialId|ruleId|outputMaterial|expectedOutput/i.test(questionSource),
  'functional questions must only contain roles and perceptible traits');

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-material-reasoning-'));
const bundlePath = path.join(temporaryDirectory, 'material-reasoning.mjs');

try {
  const entry = `
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { perceiveMaterial } from ${JSON.stringify(perceptionPath)};
    export { materialQuestionFor } from ${JSON.stringify(questionPath)};
    export {
      PROJECT_HYPOTHESIS_ATTEMPT_BUDGET,
      PROJECT_HYPOTHESIS_NO_RESPONSE_BUDGET,
      PROJECT_HYPOTHESIS_RESPONSE_BUDGET,
      nextProjectHypothesisCandidate,
      refreshProjectHypothesisCampaign,
    } from ${JSON.stringify(hypothesisPath)};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=recipe-agnostic-material-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    Material,
    PROJECT_HYPOTHESIS_ATTEMPT_BUDGET,
    PROJECT_HYPOTHESIS_NO_RESPONSE_BUDGET,
    PROJECT_HYPOTHESIS_RESPONSE_BUDGET,
    materialQuestionFor,
    nextProjectHypothesisCandidate,
    perceiveMaterial,
    refreshProjectHypothesisCampaign,
  } = api;

  assert.equal(PROJECT_HYPOTHESIS_ATTEMPT_BUDGET, 7);
  assert.equal(PROJECT_HYPOTHESIS_NO_RESPONSE_BUDGET, 4);
  assert.equal(PROJECT_HYPOTHESIS_RESPONSE_BUDGET, 3);
  const visibleSteel = perceiveMaterial(Material.Steel, 'visible');
  assert.equal(visibleSteel.appearance, 'metallic');
  assert.equal(visibleSteel.loadBand, undefined);
  assert.equal(visibleSteel.rigidity, undefined);
  const heldSteel = perceiveMaterial(Material.Steel, 'held');
  assert.ok(heldSteel.loadBand);
  assert.ok(heldSteel.rigidity);

  for (const desiredFunction of [
    'efficient-production',
    'bronze-alloying',
    'iron-reduction',
    'water-powered-crop-processing',
  ]) {
    const question = materialQuestionFor(desiredFunction, 'combine-inventory');
    const serialized = JSON.stringify(question);
    assert.ok(!/materialId|ruleId|output/i.test(serialized));
  }

  const person = (id, materials) => ({
    id,
    inventory: materials.map(([materialId, quantity], index) => ({
      id: `stack-${id}-${index}`,
      materialId,
      quantity,
      sourceEventIds: [`source-${id}-${index}`],
    })),
    knowledge: [],
  });
  const project = (id, desiredFunction) => ({
    id,
    desiredFunction,
    triggerFactIds: [`pressure-${id}`],
    actionEventIds: [],
  });
  const campaign = (seed, actor, currentProject, questionKind, visibleDrops = []) => (
    refreshProjectHypothesisCampaign(
      seed,
      1,
      actor,
      currentProject,
      visibleDrops,
      { operation: 'combine-inventory', questionKind },
    )
  );

  {
    const actor = person('novel-rigid', [[Material.FiredBrick, 2], [Material.Steel, 2]]);
    const currentProject = project('novel-rigid-project', 'water-powered-crop-processing');
    const result = campaign(41, actor, currentProject, 'shape-rigid-rotating-connector');
    const candidate = result.candidates.find((item) => item.materialIds.includes(Material.FiredBrick)
      && item.materialIds.includes(Material.Steel));
    assert.ok(candidate, 'new materials with the same perceptual roles must enter without an allow-list edit');
    assert.ok(candidate.sourceKeys.includes(`inventory:${actor.id}:stack-${actor.id}-0`));
    assert.ok(candidate.sourceKeys.includes(`inventory:${actor.id}:stack-${actor.id}-1`));
    assert.ok(candidate.rankBasis);
  }

  {
    const actor = person('novel-flow', [[Material.FiredBrick, 2], [Material.Hide, 2]]);
    const currentProject = project('novel-flow-project', 'water-powered-crop-processing');
    const result = campaign(42, actor, currentProject, 'assemble-flow-driven-rotor');
    assert.ok(result.candidates.some((item) => item.materialIds.includes(Material.FiredBrick)
      && item.materialIds.includes(Material.Hide)),
    'structural-member plus flexible-sheet traits must qualify without Fiber/Wood identity checks');
  }

  {
    const actor = person('learned', [[Material.Wood, 2], [Material.Plank, 2], [Material.Fiber, 3]]);
    actor.knowledge.push({
      id: `technique:combine-inventory:${Material.Wood}x1+${Material.Fiber}x1:${Material.WaterWheel}`,
      kind: 'technique',
      summary: '从他人演示中获得的暂定输入经验',
      confidence: 54,
      learnedAtMonth: 0,
      sourceEventIds: ['transmitted-demonstration'],
    });
    const result = campaign(
      44,
      actor,
      project('learned-project', 'water-powered-crop-processing'),
      'assemble-flow-driven-rotor',
    );
    const learned = result.candidates.find((item) => item.materialIds.includes(Material.Wood)
      && item.materialIds.includes(Material.Fiber));
    const merelyPlausible = result.candidates.find((item) => item.materialIds.includes(Material.Plank)
      && item.materialIds.includes(Material.Fiber));
    assert.ok(learned?.rankBasis && merelyPlausible?.rankBasis);
    assert.ok(learned.rankBasis.learnedEvidence > merelyPlausible.rankBasis.learnedEvidence);
    assert.ok(result.candidates.indexOf(learned) < result.candidates.indexOf(merelyPlausible),
      'personal or transmitted input evidence must outrank optional trait preference');
    assert.ok(learned.sourceFactIds.includes('transmitted-demonstration'));
  }

  {
    const actor = person('no-response', [[Material.Wood, 2], [Material.Plank, 2], [Material.Fiber, 3]]);
    actor.knowledge.push({
      id: `observation:no-response:combine-inventory:${[Material.Wood, Material.Fiber].sort((a, b) => a - b).join('+')}`,
      kind: 'observation',
      summary: '同一对实体反复没有响应',
      confidence: 64,
      learnedAtMonth: 0,
      sourceEventIds: ['no-response-one', 'no-response-two'],
    });
    const currentProject = project('no-response-project', 'water-powered-crop-processing');
    const selected = nextProjectHypothesisCandidate(
      45,
      1,
      actor,
      currentProject,
      [],
      { operation: 'combine-inventory', questionKind: 'assemble-flow-driven-rotor' },
    );
    assert.ok(selected);
    assert.ok(!(selected.materialIds.includes(Material.Wood) && selected.materialIds.includes(Material.Fiber)),
      'reliable exact no-response evidence must suppress that exact retry');
  }

  {
    const actor = person('verified', [[Material.FiredBrick, 2], [Material.Steel, 2], [Material.Iron, 2]]);
    const steelStack = actor.inventory.find((stack) => stack.materialId === Material.Steel);
    const currentProject = project('verified-project', 'water-powered-crop-processing');
    currentProject.hypothesisCampaign = {
      version: 'project-hypothesis-campaign-v2',
      id: 'verified-campaign',
      projectId: currentProject.id,
      actorId: actor.id,
      openedAt: 0,
      budget: 7,
      noResponseBudget: 4,
      responseBudget: 3,
      observedMaterialIds: [],
      sourceFactIds: [],
      sourceKeys: [],
      candidates: [],
      attempts: [{
        candidateKey: 'older-response',
        outcome: 'response',
        eventId: 'response-event',
        verifiedEventId: 'verification-event',
        outputMaterialId: Material.Steel,
        responseRef: { kind: 'inventory-stack', stackId: steelStack.id, materialId: Material.Steel },
      }],
      status: 'active',
    };
    const result = campaign(46, actor, currentProject, 'shape-rigid-rotating-connector');
    const steel = result.candidates.find((item) => item.materialIds.includes(Material.FiredBrick)
      && item.materialIds.includes(Material.Steel));
    const iron = result.candidates.find((item) => item.materialIds.includes(Material.FiredBrick)
      && item.materialIds.includes(Material.Iron));
    assert.ok(steel?.rankBasis && iron?.rankBasis);
    assert.ok(steel.rankBasis.learnedEvidence > iron.rankBasis.learnedEvidence);
    assert.ok(steel.sourceFactIds.includes('response-event'));
    assert.ok(steel.sourceFactIds.includes('verification-event'));
  }

  {
    const heldActor = person('held', [[Material.FiredBrick, 2], [Material.Steel, 2]]);
    const heldResult = campaign(
      43,
      heldActor,
      project('held-project', 'water-powered-crop-processing'),
      'shape-rigid-rotating-connector',
    );
    const held = heldResult.candidates.find((item) => item.materialIds.includes(Material.FiredBrick)
      && item.materialIds.includes(Material.Steel));
    const visibleActor = person('visible', []);
    const drops = [
      { id: 'brick-drop', materialId: Material.FiredBrick, quantity: 2, sourceEventIds: ['brick-seen'] },
      { id: 'steel-drop', materialId: Material.Steel, quantity: 2, sourceEventIds: ['steel-seen'] },
    ];
    const visibleResult = campaign(
      43,
      visibleActor,
      project('visible-project', 'water-powered-crop-processing'),
      'shape-rigid-rotating-connector',
      drops,
    );
    const visible = visibleResult.candidates.find((item) => item.materialIds.includes(Material.FiredBrick)
      && item.materialIds.includes(Material.Steel));
    assert.ok(held?.rankBasis && visible?.rankBasis);
    assert.equal(visible.rankBasis.requiredRoleFit, held.rankBasis.requiredRoleFit,
      'visible form and appearance may establish the same visual role');
    assert.ok(visible.rankBasis.optionalTraitFit < held.rankBasis.optionalTraitFit,
      'unheld visible entities must not receive load or hand-feel preference');
    assert.ok(visible.sourceKeys.includes('drop:brick-drop'));
    assert.ok(visible.sourceKeys.includes('drop:steel-drop'));
  }

  {
    const materials = [
      [Material.Wood, 4],
      [Material.Plank, 4],
      [Material.FiredBrick, 4],
      [Material.Fiber, 4],
      [Material.Hide, 4],
    ];
    const first = campaign(71, person('replay', materials), project('replay-project', 'efficient-production'),
      'connect-manipulator-shapes').candidates;
    const replay = campaign(71, person('replay', materials), project('replay-project', 'efficient-production'),
      'connect-manipulator-shapes').candidates;
    assert.deepEqual(replay.map((item) => item.key), first.map((item) => item.key));
    const other = campaign(72, person('replay', materials), project('replay-project', 'efficient-production'),
      'connect-manipulator-shapes').candidates;
    const causal = (candidate) => {
      const { seedTieBreak, ...basis } = candidate.rankBasis;
      return basis;
    };
    const byKey = new Map(other.map((item, index) => [item.key, { item, index }]));
    for (let leftIndex = 0; leftIndex < first.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < first.length; rightIndex += 1) {
        const left = byKey.get(first[leftIndex].key);
        const right = byKey.get(first[rightIndex].key);
        if (!left || !right || left.index < right.index) continue;
        assert.deepEqual(causal(left.item), causal(right.item),
          'a seed may only reverse candidates in the same causal rank tier');
      }
    }
  }

  process.stdout.write('recipe-agnostic material reasoning tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
