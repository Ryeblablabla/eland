import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectOptionsPath = path.resolve('src/game/eland/application/project-options.ts');
const hypothesisPath = path.resolve('src/game/eland/application/project-hypotheses.ts');
const projectOptionsSource = readFileSync(projectOptionsPath, 'utf8');
const hypothesisSource = readFileSync(hypothesisPath, 'utf8');
assert.ok(!hypothesisSource.includes('interaction-rules'), 'blind renewal candidates must not read authoritative recipes');
assert.ok(!projectOptionsSource.includes('civilizationIndex'), 'renewal commitments must not read the civilization index');
assert.ok(!projectOptionsSource.includes('derived.milestones'), 'renewal commitments must not read milestone gaps');

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-renewal-opportunity-commitment-test-'));
const bundlePath = path.join(temporaryDirectory, 'renewal-opportunity-commitment.mjs');

function failedProject(actor, basis, id = 'failed-food-inquiry') {
  return {
    id,
    kind: 'inquiry',
    need: 'food-preparation',
    desiredFunction: 'prepared-food',
    summary: '把生肉变成更可靠的食物',
    ownerId: actor.id,
    beneficiaryIds: [actor.id],
    triggerFactIds: [],
    pressure: 70,
    createdAtMonth: 1,
    reviewAtMonth: 12,
    status: 'blocked',
    lastProgressAtMonth: 1,
    blockedAtMonth: 13,
    blockedReason: '有限试验已经耗尽',
    inquiryOpportunityBasis: structuredClone(basis),
    terminalInquiryOpportunityBasis: structuredClone(basis),
    missingMaterialIds: [],
    materialDemands: [],
    reservations: [],
    contributorIds: [actor.id],
    actionEventIds: [],
    failureEventIds: [],
    completionEventIds: [],
    progressEvidence: [],
    searchCampaigns: [],
    logisticsEpisodes: [],
    hypothesisCampaign: {
      version: 'project-hypothesis-campaign-v2',
      id: `campaign:${id}`,
      projectId: id,
      actorId: actor.id,
      openedAt: 2,
      budget: 7,
      noResponseBudget: 4,
      responseBudget: 3,
      observedMaterialIds: [...basis.materialIds],
      sourceFactIds: [...basis.sourceFactIds],
      sourceKeys: [...basis.sourceKeys],
      candidates: [],
      attempts: [{ outcome: 'no-response' }],
      status: 'exhausted',
      endedAt: 12,
      endingReason: 'no-response-budget-exhausted',
    },
  };
}

function activeRenewalProject(actor, basis, id) {
  return {
    id,
    kind: 'inquiry',
    need: 'food-preparation',
    desiredFunction: 'prepared-food',
    summary: '围绕新机会做有限试验',
    ownerId: actor.id,
    beneficiaryIds: [actor.id],
    triggerFactIds: [],
    pressure: 65,
    createdAtMonth: 21,
    reviewAtMonth: 32,
    status: 'active',
    lastProgressAtMonth: 21,
    inquiryOpportunityBasis: structuredClone(basis),
    missingMaterialIds: [],
    materialDemands: [],
    reservations: [],
    contributorIds: [actor.id],
    actionEventIds: [],
    failureEventIds: [],
    completionEventIds: [],
    progressEvidence: [],
    searchCampaigns: [],
    logisticsEpisodes: [],
  };
}

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { buildProjectInquiryOpportunityBasis, buildProjectOptions } from ${JSON.stringify(projectOptionsPath)};
    export { nextProjectHypothesisCandidate } from ${JSON.stringify(hypothesisPath)};
    export { executePrimitiveAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export { inventoryNoResponseFactId } from ${JSON.stringify(path.resolve('src/game/eland/domain/interaction-knowledge.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=renewal-opportunity-commitment-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const simulation = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    Material,
    buildProjectInquiryOpportunityBasis,
    buildProjectOptions,
    createInitialState,
    executePrimitiveAction,
    inventoryNoResponseFactId,
    nextProjectHypothesisCandidate,
  } = simulation;

  const fixture = (seed) => {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 48 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 20;
    state.projects = [];
    state.civilization.climate = { kind: 'temperate', severity: 0, sinceMonth: 0 };
    state.civilization.weather = { kind: 'clear', intensity: 0, sinceMonth: 0 };
    const actor = state.people[0];
    actor.conditions = [];
    actor.knowledge = [];
    actor.inventory = [{
      id: `raw-${seed}`,
      materialId: Material.RawMeat,
      quantity: 1,
      sourceEventIds: [`raw-origin-${seed}`],
    }];
    return { state, actor };
  };
  const preparedFoodOptions = (state, actor, visibleDrops = []) => buildProjectOptions(
    state,
    actor,
    [actor.position.cellId],
    visibleDrops,
    [],
  ).filter((option) => option.projectProposal?.desiredFunction === 'prepared-food');
  const withRenewalKey = (basis, materialId) => ({
    ...structuredClone(basis),
    inheritedProjectIds: ['failed-food-inquiry'],
    renewalKeys: [`material:${materialId}`],
  });

  {
    const { state, actor } = fixture(2701);
    const opening = buildProjectInquiryOpportunityBasis(state, actor, 'prepared-food', [], 1);
    state.projects = [failedProject(actor, opening)];
    const renewalDrop = {
      id: 'exact-renewal-fiber',
      materialId: Material.Fiber,
      cellId: actor.position.cellId,
      z: actor.position.z,
      quantity: 1,
      createdAtMonth: 20,
      sourceEventIds: ['fiber-drop-origin'],
    };
    const basis = buildProjectInquiryOpportunityBasis(state, actor, 'prepared-food', [renewalDrop], 21);
    const source = basis.opportunitySources.find((item) => item.opportunityKey === `material:${Material.Fiber}`);
    assert.ok(source, 'the abstract material opportunity must retain an exact source commitment');
    assert.deepEqual(source.sourceKeys, [`drop:${renewalDrop.id}`]);
    assert.deepEqual(source.sourceFactIds, renewalDrop.sourceEventIds);

    const options = preparedFoodOptions(state, actor, [renewalDrop]);
    assert.equal(options.length, 1, 'a reachable exact renewal source with a compilable first step may create a project');
    assert.deepEqual(options[0].projectProposal.inquiryOpportunityBasis.renewalKeys, [`material:${Material.Fiber}`]);
    assert.equal(options[0].nextAction.kind, 'transfer', 'the opening step must acquire the committed drop before blind work');
    assert.equal(options[0].nextAction.dropId, renewalDrop.id, 'the opening step must stay bound to the exact committed drop');
  }

  {
    const { state, actor } = fixture(2702);
    const opening = buildProjectInquiryOpportunityBasis(state, actor, 'prepared-food', [], 1);
    state.projects = [failedProject(actor, opening)];
    actor.inventory.push({
      id: 'filtered-fiber', materialId: Material.Fiber, quantity: 1, sourceEventIds: ['filtered-fiber-origin'],
    });
    actor.knowledge.push({
      id: inventoryNoResponseFactId([Material.RawMeat, Material.Fiber]),
      kind: 'observation',
      summary: '本人已经重复核验这组材料没有物质响应',
      confidence: 64,
      learnedAtMonth: 20,
      sourceEventIds: ['no-response-a', 'no-response-b'],
    });
    const current = buildProjectInquiryOpportunityBasis(state, actor, 'prepared-food', [], 21);
    assert.ok(current.opportunityKeys.includes(`material:${Material.Fiber}`), 'fixture must contain a genuinely new abstract material opportunity');
    assert.equal(preparedFoodOptions(state, actor).length, 0,
      'a new material must not create a project when every first-step candidate using it is reliably excluded');
  }

  {
    const { state, actor } = fixture(2703);
    actor.inventory.push({
      id: 'committed-fiber', materialId: Material.Fiber, quantity: 1, sourceEventIds: ['committed-fiber-origin'],
    });
    const basis = withRenewalKey(
      buildProjectInquiryOpportunityBasis(state, actor, 'prepared-food', [], 21),
      Material.Fiber,
    );
    actor.inventory = [
      actor.inventory.find((stack) => stack.materialId === Material.RawMeat),
      { id: 'unrelated-fiber', materialId: Material.Fiber, quantity: 1, sourceEventIds: ['unrelated-fiber-origin'] },
    ];
    const project = activeRenewalProject(actor, basis, 'no-lineage-replacement');
    const selected = nextProjectHypothesisCandidate(state.seed, 21, actor, project, [], {
      operation: 'combine-inventory', questionKind: 'connect-manipulator-shapes',
    });
    assert.equal(selected, null, 'a same-material replacement without source lineage must not claim the commitment');
    assert.ok(project.hypothesisCampaign?.candidates.some((candidate) => (
      candidate.materialIds.includes(Material.Fiber)
      && !candidate.reasonKeys.includes('cross-project-renewal-opportunity')
    )), 'fixture must retain an ordinary old candidate that selector deliberately refuses to fall back to');
    assert.equal(project.hypothesisCampaign?.activeCandidateKey, undefined,
      'selector must not activate an old candidate before the first sourced renewal attempt');
  }

  {
    const { state, actor } = fixture(2704);
    const renewalDrop = {
      id: 'picked-renewal-fiber',
      materialId: Material.Fiber,
      cellId: actor.position.cellId,
      z: actor.position.z,
      quantity: 1,
      createdAtMonth: 20,
      sourceEventIds: ['picked-fiber-origin'],
    };
    const basis = withRenewalKey(
      buildProjectInquiryOpportunityBasis(state, actor, 'prepared-food', [renewalDrop], 21),
      Material.Fiber,
    );
    actor.inventory.push({
      id: 'picked-fiber-successor',
      materialId: Material.Fiber,
      quantity: 1,
      sourceEventIds: ['picked-fiber-origin', 'pickup-action-event'],
    });
    const project = activeRenewalProject(actor, basis, 'drop-lineage-successor');
    const selected = nextProjectHypothesisCandidate(state.seed, 22, actor, project, [], {
      operation: 'combine-inventory', questionKind: 'connect-manipulator-shapes',
    });
    assert.ok(selected, 'an inventory successor carrying the exact drop provenance must satisfy the commitment');
    assert.ok(selected.reasonKeys.includes('cross-project-renewal-opportunity'));
    assert.ok(selected.sourceKeys.includes(`inventory:${actor.id}:picked-fiber-successor`),
      'the committed candidate must bind the currently executable lineage successor');
  }

  {
    const { state, actor } = fixture(2705);
    const renewalDrop = {
      id: 'eventless-renewal-fiber',
      materialId: Material.Fiber,
      cellId: actor.position.cellId,
      z: actor.position.z,
      quantity: 1,
      createdAtMonth: 20,
      sourceEventIds: [],
    };
    state.world.drops.push(renewalDrop);
    const basis = withRenewalKey(
      buildProjectInquiryOpportunityBasis(state, actor, 'prepared-food', [renewalDrop], 21),
      Material.Fiber,
    );
    const transfer = executePrimitiveAction(state, actor, {
      kind: 'transfer',
      materialId: Material.Fiber,
      quantity: 1,
      from: { kind: 'ground', cellId: renewalDrop.cellId, z: renewalDrop.z },
      to: { kind: 'person', personId: actor.id },
      dropId: renewalDrop.id,
    }, 21, 0, { cause: 'intent', actionTick: 0 });
    assert.equal(transfer.status, 'completed');
    const successor = actor.inventory.find((stack) => stack.materialId === Material.Fiber);
    assert.ok(successor?.sourceLineageKeys?.includes(`drop:${renewalDrop.id}`),
      'a pickup must preserve exact physical ancestry even when the drop has no event provenance');

    const project = activeRenewalProject(actor, basis, 'eventless-drop-lineage-successor');
    const selected = nextProjectHypothesisCandidate(state.seed, 22, actor, project, [], {
      operation: 'combine-inventory', questionKind: 'connect-manipulator-shapes',
    });
    assert.ok(selected, 'the exact physical successor must remain executable after pickup');
    assert.ok(selected.reasonKeys.includes('cross-project-renewal-opportunity'));
    assert.ok(selected.sourceKeys.includes(`inventory:${actor.id}:${successor.id}`));
    assert.ok(selected.sourceKeys.includes(`drop:${renewalDrop.id}`),
      'candidate evidence must retain the original commitment key for observer replay');
  }

  process.stdout.write('renewal opportunity commitment tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
