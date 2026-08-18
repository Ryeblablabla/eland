import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const hypothesisSourcePath = path.resolve('src/game/eland/application/project-hypotheses.ts');
const projectOptionsPath = path.resolve('src/game/eland/application/project-options.ts');
const hypothesisSource = readFileSync(hypothesisSourcePath, 'utf8');

assert.ok(
  !hypothesisSource.includes('interaction-rules'),
  'unknown hypothesis generation must not import the authoritative interaction rule table',
);
assert.ok(
  !/\b(?:inventoryCombinationRules|inventoryCombinationFor|inventoryCombinationForOutput|exertionRuleFor|exposureRuleFor)\b/.test(hypothesisSource),
  'unknown hypothesis generation must not query authoritative interaction outcomes indirectly',
);
assert.ok(
  !/\bMaterial\.(?:Stone|Wood|Fiber|Fire)\b/.test(hypothesisSource),
  'unknown hypothesis generation must not hard-code the successful Stone/Wood/Fiber/Fire chain',
);

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-response-driven-inquiry-test-'));
const bundlePath = path.join(temporaryDirectory, 'response-driven-inquiry.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export { inventoryCombinationFor } from ${JSON.stringify(path.resolve('src/game/eland/domain/interaction-rules.ts'))};
    export { inventoryNoResponseFactId, voxelNoResponseFactId } from ${JSON.stringify(path.resolve('src/game/eland/domain/interaction-knowledge.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { cellX, cellY, neighbors4, setVoxel, voxelAt } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
    export * as projectHypotheses from ${JSON.stringify(hypothesisSourcePath)};
    export * as projectOptions from ${JSON.stringify(projectOptionsPath)};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=response-driven-inquiry-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const simulation = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    Material,
    cellX,
    cellY,
    createInitialState,
    executePrimitiveAction,
    inventoryCombinationFor,
    inventoryNoResponseFactId,
    neighbors4,
    projectHypotheses,
    projectOptions,
    setVoxel,
    voxelAt,
    voxelNoResponseFactId,
  } = simulation;

  function requiredExport(namespace, name, moduleName) {
    const value = namespace[name];
    assert.equal(typeof value, 'function', `${moduleName} must export ${name} for the v23 directed test`);
    return value;
  }

  /*
   * Keep the concurrent implementation seam here. The expected v23 API keeps
   * the v22 positional arguments and optionally accepts state last so exert-air
   * candidates can be grounded in a real adjacent voxel.
   */
  const api = {
    refreshCampaign(
      state,
      actor,
      project,
      atMonth = state.clock.elapsedMonths + 1,
      visibleDrops = [],
      request = { operation: 'combine-inventory' },
    ) {
      return requiredExport(
        projectHypotheses,
        'refreshProjectHypothesisCampaign',
        'project-hypotheses',
      )(state.seed, atMonth, actor, project, visibleDrops, request);
    },
    nextCandidate(
      state,
      actor,
      project,
      atMonth = state.clock.elapsedMonths + 1,
      visibleDrops = [],
      request = { operation: 'combine-inventory' },
    ) {
      return requiredExport(
        projectHypotheses,
        'nextProjectHypothesisCandidate',
        'project-hypotheses',
      )(state.seed, atMonth, actor, project, visibleDrops, request);
    },
    recompile(state, actor, project) {
      return requiredExport(
        projectOptions,
        'recompileProjectNextAction',
        'project-options',
      )(state, actor, project.id);
    },
    record(state, project, fact) {
      return requiredExport(
        projectOptions,
        'recordProjectAction',
        'project-options',
      )(state, project.id, fact);
    },
  };

  const canonicalPair = (materialIds) => [...materialIds].sort((left, right) => left - right);
  const samePair = (left, right) => {
    const canonicalLeft = canonicalPair(left);
    const canonicalRight = canonicalPair(right);
    return canonicalLeft[0] === canonicalRight[0] && canonicalLeft[1] === canonicalRight[1];
  };

  function makeProject(actor, id, desiredFunction = 'durable-record') {
    return {
      id,
      kind: 'inquiry',
      need: desiredFunction === 'prepared-food' ? 'food-preparation' : 'knowledge-preservation',
      desiredFunction,
      summary: '用眼前实体回应一个真实的局部困境',
      ownerId: actor.id,
      beneficiaryIds: [actor.id],
      triggerFactIds: ['local-response-driven-pressure'],
      pressure: 72,
      createdAtMonth: 1,
      reviewAtMonth: 100,
      status: 'active',
      lastProgressAtMonth: 1,
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

  function setHeldMaterials(actor, entries) {
    actor.inventory = entries.map(([materialId, quantity]) => ({
      id: `held-${actor.id}-${materialId}`,
      materialId,
      quantity,
      sourceEventIds: [`observed-${actor.id}-${materialId}`],
    }));
  }

  function makeFixture(seed, id, desiredFunction, entries) {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 6;
    state.world.drops = [];
    const actor = state.people[0];
    actor.knowledge = [];
    setHeldMaterials(actor, entries);
    const project = makeProject(actor, id, desiredFunction);
    state.projects = [project];
    return { state, actor, project, orderInMonth: 0 };
  }

  function assertV23Budgets(campaign) {
    assert.equal(campaign.version, 'project-hypothesis-campaign-v2');
    assert.equal(campaign.noResponseBudget, 4, 'a campaign has at most four no-response attempts');
    assert.equal(campaign.responseBudget, 3, 'a campaign has at most three response stages');
    assert.equal(campaign.budget, 7, 'a campaign has at most seven total attempts');
    assert.ok(Number.isFinite(campaign.noResponseBudget));
    assert.ok(Number.isFinite(campaign.responseBudget));
    assert.ok(Number.isFinite(campaign.budget));
  }

  function candidateForPair(fixture, materialIds, id) {
    const previousInventory = fixture.actor.inventory;
    const quantities = new Map();
    for (const materialId of materialIds) quantities.set(materialId, (quantities.get(materialId) ?? 0) + 1);
    setHeldMaterials(fixture.actor, [...quantities]);
    const probe = makeProject(fixture.actor, `candidate-probe-${id}`, 'durable-record');
    const campaign = api.refreshCampaign(fixture.state, fixture.actor, probe);
    const candidate = campaign.candidates.find((item) => item.operation === 'combine-inventory'
      && samePair(item.materialIds, materialIds));
    fixture.actor.inventory = previousInventory;
    assert.ok(candidate, `the locally held pair ${materialIds.join('+')} must have a combine-inventory candidate`);
    return structuredClone(candidate);
  }

  function installCampaign(fixture, candidates, overrides = {}) {
    delete fixture.project.hypothesisCampaign;
    const campaign = api.refreshCampaign(fixture.state, fixture.actor, fixture.project);
    assertV23Budgets(campaign);
    campaign.candidates = structuredClone(candidates);
    campaign.attempts = [];
    campaign.status = 'active';
    campaign.budget = overrides.budget ?? campaign.budget;
    campaign.noResponseBudget = overrides.noResponseBudget ?? campaign.noResponseBudget;
    campaign.responseBudget = overrides.responseBudget ?? campaign.responseBudget;
    delete campaign.activeCandidateKey;
    delete campaign.endedAt;
    delete campaign.endingReason;
    return campaign;
  }

  function stackRefsForPair(actor, materialIds) {
    const used = new Map();
    return materialIds.map((materialId) => {
      const stack = actor.inventory.find((item) => item.materialId === materialId && item.quantity > 0);
      assert.ok(stack, `actor must hold material ${materialId}`);
      const requested = (used.get(stack.id) ?? 0) + 1;
      used.set(stack.id, requested);
      assert.ok(stack.quantity >= requested, `stack ${stack.id} must cover repeated material units`);
      return { kind: 'inventory-stack', personId: actor.id, stackId: stack.id };
    });
  }

  function executeAndRecord(fixture, action, expectedStatus) {
    const orderInMonth = fixture.orderInMonth;
    fixture.orderInMonth += 1;
    const fact = executePrimitiveAction(
      fixture.state,
      fixture.actor,
      action,
      7,
      orderInMonth,
      { cause: 'intent', actionTick: orderInMonth + 1 },
    );
    assert.equal(fact.status, expectedStatus);
    fixture.state.world.past.push(fact);
    api.record(fixture.state, fixture.project, fact);
    return fact;
  }

  function activateAndCombine(fixture, candidate, expectedStatus) {
    fixture.project.hypothesisCampaign.activeCandidateKey = candidate.key;
    return executeAndRecord(fixture, {
      kind: 'act',
      operation: 'combine',
      targets: stackRefsForPair(fixture.actor, candidate.materialIds),
    }, expectedStatus);
  }

  const responsePairs = [
    [Material.Stone, Material.Wood],
    [Material.Fiber, Material.Fiber],
    [Material.Leaves, Material.Fiber],
  ];
  const noResponsePairs = [
    [Material.Stone, Material.Fiber],
    [Material.Wood, Material.Fiber],
    [Material.Stone, Material.Leaves],
    [Material.Wood, Material.Leaves],
    [Material.Stone, Material.Hide],
    [Material.Wood, Material.Hide],
    [Material.Fiber, Material.Hide],
  ];
  for (const pair of responsePairs) assert.ok(inventoryCombinationFor(pair), `${pair.join('+')} is a response oracle only in the test`);
  for (const pair of noResponsePairs) assert.equal(inventoryCombinationFor(pair), undefined, `${pair.join('+')} is a no-response oracle only in the test`);

  const budgetInventory = [
    [Material.Stone, 20],
    [Material.Wood, 20],
    [Material.Fiber, 20],
    [Material.Leaves, 20],
    [Material.Hide, 20],
  ];

  {
    const fixture = makeFixture(2301, 'no-response-budget-project', 'durable-record', budgetInventory);
    const candidates = noResponsePairs.slice(0, 5).map((pair, index) => candidateForPair(fixture, pair, `no-response-${index}`));
    const campaign = installCampaign(fixture, candidates);
    for (const candidate of candidates.slice(0, 4)) activateAndCombine(fixture, candidate, 'blocked');
    assert.equal(campaign.attempts.length, 4);
    assert.equal(campaign.attempts.filter((attempt) => attempt.outcome === 'no-response').length, 4);
    assert.equal(campaign.status, 'exhausted');
    assert.equal(campaign.endingReason, 'no-response-budget-exhausted');
    const attemptsAtExhaustion = campaign.attempts.length;
    activateAndCombine(fixture, candidates[4], 'blocked');
    assert.equal(campaign.attempts.length, attemptsAtExhaustion, 'an exhausted no-response budget cannot accept another attempt');
  }

  {
    const fixture = makeFixture(2302, 'response-budget-project', 'durable-record', budgetInventory);
    const candidates = responsePairs.map((pair, index) => candidateForPair(fixture, pair, `response-${index}`));
    const campaign = installCampaign(fixture, candidates);
    for (const candidate of candidates) {
      const fact = activateAndCombine(fixture, candidate, 'completed');
      assert.ok(Number.isInteger(fact.diff.outputMaterialId), 'only an executor-produced material response counts');
      assert.ok(fixture.actor.inventory.some((stack) => stack.id === fact.diff.outputStackId
        && stack.sourceEventIds.includes(fact.id)), 'each counted response must leave a sourced output entity');
    }
    assert.equal(campaign.attempts.length, 3);
    assert.equal(campaign.attempts.filter((attempt) => attempt.outcome === 'response').length, 3);
    assert.equal(campaign.status, 'exhausted');
    assert.equal(campaign.endingReason, 'response-stage-budget-exhausted');
  }

  {
    const fixture = makeFixture(2303, 'total-budget-project', 'durable-record', budgetInventory);
    const candidates = noResponsePairs.map((pair, index) => candidateForPair(fixture, pair, `total-${index}`));
    const campaign = installCampaign(fixture, candidates, { noResponseBudget: 99, responseBudget: 99 });
    for (const candidate of candidates) activateAndCombine(fixture, candidate, 'blocked');
    assert.equal(campaign.attempts.length, 7);
    assert.equal(campaign.status, 'exhausted');
    assert.equal(campaign.endingReason, 'total-attempt-budget-exhausted');
  }

  function prepareAdjacentAir(fixture) {
    const occupied = new Set(fixture.state.people
      .filter((person) => person.id !== fixture.actor.id)
      .map((person) => person.position.cellId));
    const neighbors = neighbors4(fixture.actor.position.cellId);
    const targetCell = neighbors.find((cellId) => !occupied.has(cellId)) ?? neighbors[0];
    assert.notEqual(targetCell, undefined, 'fixture needs one adjacent cell');
    for (const person of fixture.state.people.filter((candidate) => candidate.id !== fixture.actor.id
      && candidate.position.cellId === targetCell)) {
      person.position.cellId = fixture.actor.position.cellId;
      person.position.z = fixture.actor.position.z;
    }
    const position = { x: cellX(targetCell), y: cellY(targetCell), z: fixture.actor.position.z };
    setVoxel(fixture.state.world.grid, position.x, position.y, position.z - 1, Material.Stone);
    setVoxel(fixture.state.world.grid, position.x, position.y, position.z, Material.Air);
    return position;
  }

  function assertUnknownCandidate(candidate) {
    for (const forbidden of ['outputMaterialId', 'expectedOutputMaterialId', 'ruleId', 'techniqueId']) {
      assert.equal(Object.hasOwn(candidate, forbidden), false, `unknown candidate must not contain ${forbidden}`);
    }
  }

  function makeVerifiedCombineFixture(seed, id) {
    const fixture = makeFixture(seed, id, 'prepared-food', [
      [Material.Stone, 1],
      [Material.Wood, 1],
      [Material.Fiber, 2],
      [Material.RawMeat, 1],
    ]);
    const airPosition = prepareAdjacentAir(fixture);
    const campaign = api.refreshCampaign(fixture.state, fixture.actor, fixture.project);
    assertV23Budgets(campaign);
    const combineCandidate = campaign.candidates.find((candidate) => candidate.operation === 'combine-inventory'
      && samePair(candidate.materialIds, [Material.Stone, Material.Wood]));
    assert.ok(combineCandidate, 'held Stone and Wood must permit an unknown combine candidate');
    assertUnknownCandidate(combineCandidate);
    campaign.activeCandidateKey = combineCandidate.key;

    const combineAction = api.recompile(fixture.state, fixture.actor, fixture.project);
    assert.equal(combineAction?.kind, 'act');
    assert.equal(combineAction?.operation, 'combine');
    const combineFact = executeAndRecord(fixture, combineAction, 'completed');
    assert.equal(combineFact.diff.outputMaterialId, Material.StoneTool);
    const outputStack = fixture.actor.inventory.find((stack) => stack.id === combineFact.diff.outputStackId);
    assert.ok(outputStack, 'the combine response must exist as a real held output stack');

    const responseAttempt = campaign.attempts.find((attempt) => attempt.eventId === combineFact.id);
    assert.ok(responseAttempt);
    assert.equal(responseAttempt.outcome, 'response');
    assert.equal(responseAttempt.verifiedEventId, undefined, 'a material response is not verified merely because it happened');

    api.refreshCampaign(fixture.state, fixture.actor, fixture.project);
    assert.equal(
      campaign.candidates.some((candidate) => candidate.operation !== 'combine-inventory'
        && candidate.materialIds.includes(combineFact.diff.outputMaterialId)),
      false,
      'the unverified output must not open a new operation stage',
    );

    const verifyAction = api.recompile(fixture.state, fixture.actor, fixture.project);
    assert.equal(verifyAction?.kind, 'attend', 'the actual response must be attended before another blind stage');
    assert.deepEqual(verifyAction?.target, {
      kind: 'inventory-stack',
      personId: fixture.actor.id,
      stackId: outputStack.id,
    });
    const verifyFact = executeAndRecord(fixture, verifyAction, 'completed');
    assert.equal(verifyFact.diff.verifiedTechnique, true);
    assert.equal(responseAttempt.verifiedEventId, verifyFact.id);
    assert.equal(responseAttempt.verifiedAtMonth, verifyFact.atMonth);

    api.refreshCampaign(
      fixture.state,
      fixture.actor,
      fixture.project,
      fixture.state.clock.elapsedMonths + 1,
      [],
      {
        operation: 'exert-air',
        targetMaterialId: Material.Air,
        targetSourceKeys: [`voxel:${airPosition.x}:${airPosition.y}:${airPosition.z}:${Material.Air}`],
      },
    );
    return { ...fixture, campaign, combineFact, verifyFact, responseAttempt, outputStack, airPosition };
  }

  {
    const fixture = makeVerifiedCombineFixture(2310, 'verified-response-project');
    const exertCandidate = fixture.campaign.candidates.find((candidate) => candidate.operation === 'exert-air'
      && candidate.toolMaterialId === fixture.combineFact.diff.outputMaterialId
      && candidate.inputMaterialId === Material.Fiber
      && candidate.targetMaterialId === Material.Air);
    assert.ok(exertCandidate, 'attend verification must make a response-derived exert-air candidate possible');
    assert.ok(exertCandidate.materialIds.includes(fixture.combineFact.diff.outputMaterialId));
    assert.ok(exertCandidate.sourceFactIds.includes(fixture.combineFact.id), 'the next stage must retain the real response provenance');
    assertUnknownCandidate(exertCandidate);
    fixture.campaign.activeCandidateKey = exertCandidate.key;

    const exertAction = api.recompile(fixture.state, fixture.actor, fixture.project);
    assert.equal(exertAction?.kind, 'act');
    assert.equal(exertAction?.operation, 'exert');
    const tool = fixture.actor.inventory.find((stack) => stack.id === exertAction?.toolStackId);
    assert.ok(tool, 'exert must reference a currently held tool stack');
    assert.equal(tool.materialId, exertCandidate.toolMaterialId);
    const inputRef = exertAction.targets.find((target) => target.kind === 'inventory-stack');
    const targetRef = exertAction.targets.find((target) => target.kind === 'voxel');
    assert.ok(inputRef && inputRef.personId === fixture.actor.id, 'exert input must be held by the acting person');
    const input = fixture.actor.inventory.find((stack) => stack.id === inputRef.stackId);
    assert.ok(input);
    assert.equal(input.materialId, exertCandidate.inputMaterialId);
    assert.ok(targetRef, 'exert-air must reference a real voxel');
    assert.equal(voxelAt(
      fixture.state.world.grid,
      targetRef.position.x,
      targetRef.position.y,
      targetRef.position.z,
    ), Material.Air);
    const horizontalDistance = Math.abs(cellX(fixture.actor.position.cellId) - targetRef.position.x)
      + Math.abs(cellY(fixture.actor.position.cellId) - targetRef.position.y);
    assert.equal(horizontalDistance, 1, 'exert-air target must be in an adjacent column');
    assert.equal(targetRef.position.z, fixture.actor.position.z);

    assert.equal(
      voxelAt(fixture.state.world.grid, targetRef.position.x, targetRef.position.y, targetRef.position.z),
      Material.Air,
      'candidate generation and planning must not create Fire',
    );
    const exertFact = executeAndRecord(fixture, exertAction, 'completed');
    assert.equal(exertFact.diff.outputMaterialId, Material.Fire);
    assert.equal(exertFact.diff.sourceEventId, exertFact.id);
    assert.deepEqual(exertFact.diff.position, {
      x: targetRef.position.x,
      y: targetRef.position.y,
      z: targetRef.position.z - 1,
    }, 'friction ignition must place Fire on the supporting surface');
    assert.equal(
      voxelAt(fixture.state.world.grid, targetRef.position.x, targetRef.position.y, targetRef.position.z),
      Material.Air,
      'the selected Air voxel must remain empty so the fire cannot raise terrain',
    );
    assert.equal(
      voxelAt(
        fixture.state.world.grid,
        exertFact.diff.position.x,
        exertFact.diff.position.y,
        exertFact.diff.position.z,
      ),
      Material.Fire,
      'only the authoritative executor may replace the supporting surface with real Fire',
    );

    const fireAttempt = fixture.campaign.attempts.find((attempt) => attempt.eventId === exertFact.id);
    assert.ok(fireAttempt && !fireAttempt.verifiedEventId);
    const verifyFireAction = api.recompile(fixture.state, fixture.actor, fixture.project);
    assert.equal(verifyFireAction?.kind, 'attend');
    assert.equal(verifyFireAction?.verification?.sourceEventId, exertFact.id,
      'the fire verification must bind to the exact exert response');
    const verifyFireFact = executeAndRecord(fixture, verifyFireAction, 'completed');
    assert.equal(verifyFireFact.diff.verifiedSourceEventId, exertFact.id);
    assert.equal(fireAttempt.verifiedEventId, verifyFireFact.id);

    const exposeAction = api.recompile(fixture.state, fixture.actor, fixture.project);
    assert.equal(exposeAction?.kind, 'act');
    assert.equal(exposeAction?.operation, 'expose');
    const exposedInputRef = exposeAction.targets.find((target) => target.kind === 'inventory-stack');
    assert.ok(exposedInputRef);
    assert.equal(
      fixture.actor.inventory.find((stack) => stack.id === exposedInputRef.stackId)?.materialId,
      Material.RawMeat,
      'the food pressure and held edible subject may prioritize raw food without consulting an exposure rule',
    );
    const exposeFact = executeAndRecord(fixture, exposeAction, 'completed');
    assert.equal(exposeFact.diff.outputMaterialId, Material.CookedFood);
    assert.ok(fixture.actor.inventory.some((stack) => stack.id === exposeFact.diff.outputStackId
      && stack.materialId === Material.CookedFood
      && stack.sourceEventIds.includes(exposeFact.id)));
    assert.equal(fixture.campaign.attempts.length, 3);
    assert.equal(fixture.campaign.status, 'exhausted');
    assert.equal(fixture.campaign.endingReason, 'response-stage-budget-exhausted');
  }

  {
    const fixture = makeFixture(2311, 'durable-record-chain-project', 'durable-record', [
      [Material.Stone, 1],
      [Material.Wood, 2],
    ]);
    const airPosition = prepareAdjacentAir(fixture);
    fixture.project.targetKnowledgeId = 'claim:preserve-local-experience';
    fixture.actor.knowledge.push({
      id: fixture.project.targetKnowledgeId,
      kind: 'claim',
      summary: '这段有来源的经验值得保存',
      confidence: 72,
      learnedAtMonth: 5,
      sourceEventIds: ['local-experience-source'],
    });
    const campaign = api.refreshCampaign(fixture.state, fixture.actor, fixture.project);
    const toolCandidate = campaign.candidates.find((candidate) => candidate.operation === 'combine-inventory'
      && samePair(candidate.materialIds, [Material.Stone, Material.Wood]));
    assert.ok(toolCandidate);
    campaign.activeCandidateKey = toolCandidate.key;
    const combineAction = api.recompile(fixture.state, fixture.actor, fixture.project);
    const combineFact = executeAndRecord(fixture, combineAction, 'completed');
    assert.equal(combineFact.diff.outputMaterialId, Material.StoneTool);
    const verifyToolAction = api.recompile(fixture.state, fixture.actor, fixture.project);
    assert.equal(verifyToolAction?.kind, 'attend');
    executeAndRecord(fixture, verifyToolAction, 'completed');

    api.refreshCampaign(
      fixture.state,
      fixture.actor,
      fixture.project,
      fixture.state.clock.elapsedMonths + 1,
      [],
      {
        operation: 'exert-air',
        targetMaterialId: Material.Air,
        targetSourceKeys: [`voxel:${airPosition.x}:${airPosition.y}:${airPosition.z}:${Material.Air}`],
      },
    );
    const tabletCandidate = campaign.candidates.find((candidate) => candidate.operation === 'exert-air'
      && candidate.toolMaterialId === Material.StoneTool
      && candidate.inputMaterialId === Material.Wood
      && candidate.targetMaterialId === Material.Air);
    assert.ok(tabletCandidate);
    assertUnknownCandidate(tabletCandidate);
    campaign.activeCandidateKey = tabletCandidate.key;
    const carveAction = api.recompile(fixture.state, fixture.actor, fixture.project);
    assert.equal(carveAction?.kind, 'act');
    assert.equal(carveAction?.operation, 'exert');
    const carveFact = executeAndRecord(fixture, carveAction, 'completed');
    assert.equal(carveFact.diff.outputMaterialId, Material.WoodTablet);

    const verifyTabletAction = api.recompile(fixture.state, fixture.actor, fixture.project);
    assert.equal(verifyTabletAction?.kind, 'attend', 'the new carrier cannot be written before exact response verification');
    assert.equal(verifyTabletAction?.verification?.sourceEventId, carveFact.id);
    executeAndRecord(fixture, verifyTabletAction, 'completed');
    const writeAction = api.recompile(fixture.state, fixture.actor, fixture.project);
    assert.equal(writeAction?.kind, 'communicate');
    assert.equal(writeAction?.channel, 'record');
    const writeFact = executeAndRecord(fixture, writeAction, 'completed');
    assert.ok(fixture.state.records.some((record) => record.sourceEventIds.includes(writeFact.id)
      && record.knowledgeId === fixture.project.targetKnowledgeId));
  }

  {
    const fixture = makeFixture(2320, 'no-response-memory-a', 'durable-record', [
      [Material.Stone, 1],
      [Material.Fiber, 1],
    ]);
    const candidate = candidateForPair(fixture, [Material.Stone, Material.Fiber], 'memory');

    for (const suffix of ['a', 'b']) {
      fixture.project = makeProject(fixture.actor, `no-response-memory-${suffix}`, 'durable-record');
      fixture.state.projects = [fixture.project];
      const campaign = installCampaign(fixture, [candidate]);
      activateAndCombine(fixture, campaign.candidates[0], 'blocked');
    }

    const noResponseId = inventoryNoResponseFactId([Material.Stone, Material.Fiber]);
    assert.ok(
      (fixture.actor.knowledge.find((fact) => fact.id === noResponseId)?.confidence ?? 0) >= 55,
      'two real no-response events must form reliable personal suppression knowledge',
    );

    fixture.project = makeProject(fixture.actor, 'no-response-memory-c', 'durable-record');
    fixture.state.projects = [fixture.project];
    const campaign = installCampaign(fixture, [candidate]);
    campaign.activeCandidateKey = candidate.key;
    const persistedBefore = structuredClone({
      project: fixture.project,
      knowledge: fixture.actor.knowledge,
    });
    const restored = JSON.parse(JSON.stringify(persistedBefore));
    assert.deepEqual(restored, persistedBefore, 'campaign budgets, attempts, active stage and knowledge must survive JSON persistence');
    fixture.project = restored.project;
    fixture.actor.knowledge = restored.knowledge;
    fixture.state.projects = [fixture.project];

    assert.equal(api.nextCandidate(fixture.state, fixture.actor, fixture.project), null,
      'reliable personal no-response knowledge must suppress the same operation signature after restore');
    assert.equal(fixture.project.hypothesisCampaign.attempts.length, 0,
      'suppression must not fabricate a new project attempt');

    const exertNoResponseId = voxelNoResponseFactId('exert', Material.Fiber, Material.Air, Material.StoneTool);
    assert.notEqual(exertNoResponseId, noResponseId, 'no-response memory must remain operation-signature specific');
  }

  process.stdout.write('response-driven inquiry stage tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
