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
assert.ok(!hypothesisSource.includes('interaction-rules'), 'blind hypotheses must remain independent of authoritative rules');
assert.ok(!projectOptionsSource.includes('civilizationIndex'), 'inquiry opportunity memory must not read the civilization index');
assert.ok(!projectOptionsSource.includes('derived.milestones'), 'inquiry opportunity memory must not read milestone gaps');

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-cross-project-inquiry-memory-test-'));
const bundlePath = path.join(temporaryDirectory, 'cross-project-inquiry-memory.mjs');

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

function activeInquiry(actor, id) {
  return {
    id,
    kind: 'inquiry',
    need: 'food-preparation',
    desiredFunction: 'prepared-food',
    summary: '局部材料试验',
    ownerId: actor.id,
    beneficiaryIds: [actor.id],
    triggerFactIds: [],
    pressure: 60,
    createdAtMonth: 20,
    reviewAtMonth: 40,
    status: 'active',
    lastProgressAtMonth: 20,
    missingMaterialIds: [],
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
    export { nextProjectHypothesisCandidate, refreshProjectHypothesisCampaign } from ${JSON.stringify(hypothesisPath)};
    export { inventoryNoResponseFactId } from ${JSON.stringify(path.resolve('src/game/eland/domain/interaction-knowledge.ts'))};
    export { exertionRuleFor, exertionTechniqueId } from ${JSON.stringify(path.resolve('src/game/eland/domain/interaction-rules.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { cellX, cellY, neighbors4, setVoxel, topPosition } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=cross-project-inquiry-memory-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const simulation = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    Material,
    buildProjectInquiryOpportunityBasis,
    buildProjectOptions,
    cellX,
    cellY,
    createInitialState,
    exertionRuleFor,
    exertionTechniqueId,
    inventoryNoResponseFactId,
    neighbors4,
    nextProjectHypothesisCandidate,
    refreshProjectHypothesisCampaign,
    setVoxel,
    topPosition,
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
      sourceEventIds: [`raw-source-${seed}`],
    }];
    return { state, actor };
  };
  const proposalsFor = (state, actor) => buildProjectOptions(
    state,
    actor,
    [actor.position.cellId],
    [],
    [],
  ).filter((option) => option.projectProposal?.desiredFunction === 'prepared-food');

  {
    const { state, actor } = fixture(2601);
    const opening = buildProjectInquiryOpportunityBasis(state, actor, 'prepared-food', [], 1);
    state.projects = [failedProject(actor, opening)];
    actor.inventory = [{
      id: 'replacement-raw', materialId: Material.RawMeat, quantity: 1, sourceEventIds: ['replacement-source'],
    }];
    const replacement = buildProjectInquiryOpportunityBasis(state, actor, 'prepared-food', [], 21);
    assert.equal(replacement.basisKey, opening.basisKey, 'a same-material replacement is not a new functional opportunity');
    assert.equal(proposalsFor(state, actor).length, 0, 'time and a same-material subject must not reopen an exhausted inquiry');

    actor.inventory.push({ id: 'new-fiber', materialId: Material.Fiber, quantity: 2, sourceEventIds: ['new-fiber-source'] });
    const renewed = proposalsFor(state, actor);
    assert.equal(renewed.length, 1, 'a newly observed material type may justify one renewed inquiry');
    assert.ok(renewed[0].projectProposal.inquiryOpportunityBasis.renewalKeys.includes(`material:${Material.Fiber}`));
    const campaign = renewed[0].projectProposal.initialHypothesisCampaign;
    const active = campaign?.candidates.find((candidate) => candidate.key === campaign.activeCandidateKey);
    assert.ok(active?.reasonKeys.includes('cross-project-renewal-opportunity'), 'the selected renewed candidate must use the new opportunity');
  }

  {
    const { state, actor } = fixture(2602);
    const opening = buildProjectInquiryOpportunityBasis(state, actor, 'prepared-food', [], 1);
    state.projects = [failedProject(actor, opening)];
    const neighbor = neighbors4(actor.position.cellId)[0];
    const surface = topPosition(state.world.grid, neighbor);
    const target = { x: cellX(neighbor), y: cellY(neighbor), z: Math.min(state.world.grid.levels - 1, surface.z + 1) };
    setVoxel(state.world.grid, target.x, target.y, target.z, Material.Fire);
    const withHeat = buildProjectInquiryOpportunityBasis(state, actor, 'prepared-food', [], 21);
    assert.ok(withHeat.renewalKeys.length === 0, 'the raw basis builder itself does not infer prior projects');
    assert.ok(withHeat.opportunityKeys.some((key) => key.startsWith('target:voxel:')), 'a real local heat target is a positive opportunity');
    const renewed = proposalsFor(state, actor);
    assert.equal(renewed.length, 1, 'a new real heat target reopens the inquiry');
    assert.ok(renewed[0].projectProposal.inquiryOpportunityBasis.renewalKeys.some((key) => key.startsWith('target:voxel:')));
  }

  {
    const { state, actor } = fixture(2603);
    const opening = buildProjectInquiryOpportunityBasis(state, actor, 'prepared-food', [], 1);
    state.projects = [failedProject(actor, opening)];
    const heatRule = exertionRuleFor(Material.StoneTool, Material.Fiber, Material.Air);
    assert.ok(heatRule);
    actor.knowledge.push({
      id: exertionTechniqueId(heatRule), kind: 'technique', summary: '本人核验的生火方法', confidence: 70,
      learnedAtMonth: 21, sourceEventIds: ['verified-heat-technique'],
    });
    const learned = buildProjectInquiryOpportunityBasis(state, actor, 'prepared-food', [], 21);
    assert.ok(learned.opportunityKeys.includes(`knowledge:${exertionTechniqueId(heatRule)}`), 'reliable relevant personal knowledge is a new opportunity');

    const other = state.people[1];
    other.conditions = [];
    other.knowledge = [];
    other.inventory = [
      { id: 'other-raw', materialId: Material.RawMeat, quantity: 1, sourceEventIds: ['other-raw-source'] },
      { id: 'other-fiber', materialId: Material.Fiber, quantity: 2, sourceEventIds: ['other-fiber-source'] },
    ];
    assert.equal(proposalsFor(state, other).length, 1, 'another person does not inherit the first actor\'s exhausted inquiry');
  }

  {
    const { state, actor } = fixture(2604);
    actor.inventory = [{ id: 'stone-two', materialId: Material.Stone, quantity: 2, sourceEventIds: ['stone-source'] }];
    const noResponseId = inventoryNoResponseFactId([Material.Stone, Material.Stone]);
    actor.knowledge = [{
      id: noResponseId, kind: 'observation', summary: '一次没有物质响应', confidence: 46,
      learnedAtMonth: 18, sourceEventIds: ['first-no-response'],
    }];
    assert.ok(nextProjectHypothesisCandidate(state.seed, 21, actor, activeInquiry(actor, 'tentative-retry'), []),
      'one tentative no-response may be retested once in a later project');
    actor.knowledge[0].confidence = 64;
    actor.knowledge[0].sourceEventIds.push('confirming-no-response');
    assert.equal(nextProjectHypothesisCandidate(state.seed, 22, actor, activeInquiry(actor, 'reliable-filter'), []), null,
      'a reliable no-response signature must remain filtered across projects');
  }

  {
    const { state, actor } = fixture(2605);
    actor.inventory = [{ id: 'fiber-two', materialId: Material.Fiber, quantity: 2, sourceEventIds: ['fiber-source'] }];
    actor.knowledge = [
      { id: `technique:exert:${Material.StoneTool}:${Material.Fiber}:${Material.Air}:${Material.Fire}`, kind: 'technique', summary: '一次输入方向响应', confidence: 46, learnedAtMonth: 10, sourceEventIds: ['response-a'] },
      { id: `observation:no-response:exert:${Material.Stone}:${Material.Fiber}:${Material.Air}`, kind: 'observation', summary: '两次输入方向无响应', confidence: 64, learnedAtMonth: 11, sourceEventIds: ['no-a', 'no-b'] },
      { id: `observation:no-response:exert:${Material.Leaves}:${Material.Fiber}:${Material.Air}`, kind: 'observation', summary: '一次输入方向无响应', confidence: 46, learnedAtMonth: 12, sourceEventIds: ['no-c'] },
    ];
    const project = activeInquiry(actor, 'zero-score-basis');
    const campaign = refreshProjectHypothesisCampaign(state.seed, 21, actor, project, [], {
      operation: 'combine-inventory', questionKind: 'connect-manipulator-shapes',
    });
    const candidate = campaign.candidates.find((item) => item.key === `${Material.Fiber}+${Material.Fiber}`);
    assert.ok(candidate);
    assert.equal(candidate.roleScore, 0, 'fixture must exercise the aggregate-zero role basis');
    assert.ok(candidate.roleReasonKeys.includes('role-aggregate-no-observed-fit'), 'aggregate zero must retain an explicit no-fit basis');
  }

  process.stdout.write('cross-project inquiry opportunity memory tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
