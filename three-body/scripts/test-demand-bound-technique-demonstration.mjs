import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-demand-bound-technique-demonstration-test-'));
const bundlePath = path.join(temporaryDirectory, 'demand-bound-technique-demonstration.mjs');

try {
  const entry = `
    export { buildDecisionContext } from ${JSON.stringify(path.resolve('src/game/eland/application/action-options.ts'))};
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { recordProjectAction } from ${JSON.stringify(path.resolve('src/game/eland/application/project-options.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export { buildEvolutionFactsReport } from ${JSON.stringify(path.resolve('server/evolution-artifacts.ts'))};
    export { exertionRuleFor, exertionTechniqueId, exertionTechniqueSummary } from ${JSON.stringify(path.resolve('src/game/eland/domain/interaction-rules.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { cellX, cellY, neighbors4, setVoxel, voxelAt } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=demand-bound-technique-demonstration-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const simulation = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    Material,
    buildDecisionContext,
    buildEvolutionFactsReport,
    cellX,
    cellY,
    createInitialState,
    executePrimitiveAction,
    exertionRuleFor,
    exertionTechniqueId,
    exertionTechniqueSummary,
    neighbors4,
    recordProjectAction,
    setVoxel,
    voxelAt,
  } = simulation;

  const ignitionRule = exertionRuleFor(Material.StoneTool, Material.Fiber, Material.Air);
  assert.ok(ignitionRule, 'the directed fixture requires the real friction-ignition rule');
  const ignitionTechniqueId = exertionTechniqueId(ignitionRule);

  function makeProject(learner, id) {
    return {
      id,
      kind: 'inquiry',
      need: 'food-preparation',
      desiredFunction: 'prepared-food',
      summary: '把生肉变成更可靠的食物',
      ownerId: learner.id,
      beneficiaryIds: [learner.id],
      triggerFactIds: [`food-pressure:${id}`],
      pressure: 74,
      createdAtMonth: 7,
      reviewAtMonth: 24,
      status: 'active',
      lastProgressAtMonth: 12,
      missingMaterialIds: [],
      materialDemands: [],
      reservations: [],
      contributorIds: [learner.id],
      actionEventIds: [],
      failureEventIds: [],
      completionEventIds: [],
      progressEvidence: [],
      searchCampaigns: [],
      logisticsEpisodes: [],
      techniqueDemonstrations: [],
      hypothesisCampaign: {
        version: 'project-hypothesis-campaign-v2',
        id: `campaign:${id}`,
        projectId: id,
        actorId: learner.id,
        openedAt: 8,
        budget: 7,
        noResponseBudget: 4,
        responseBudget: 3,
        observedMaterialIds: [Material.RawMeat, Material.StoneTool, Material.Fiber],
        sourceFactIds: [`food-pressure:${id}`],
        sourceKeys: [
          `inventory:${learner.id}:learner-raw-meat`,
          `inventory:${learner.id}:learner-stone-tool`,
          `inventory:${learner.id}:learner-fiber`,
        ],
        candidates: [],
        attempts: [],
        status: 'active',
      },
    };
  }

  function makeFixture(seed) {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 12;
    state.world.past = [];
    state.world.drops = [];
    state.lastStep = [];
    state.intents = [];
    state.projects = [];
    state.civilization.climate = { kind: 'temperate', severity: 0, sinceMonth: 0 };
    state.civilization.weather = { kind: 'clear', intensity: 0, sinceMonth: 0 };

    const learner = state.people[0];
    const demonstrator = state.people[1];
    const bystander = state.people[2];
    bystander.id = 'aaa-bystander';
    bystander.name = '旁观者';
    bystander.position = structuredClone(learner.position);
    bystander.conditions = [];
    bystander.body = { health: 90, hydration: 90, nutrition: 90 };
    bystander.knowledge = [];
    bystander.inventory = [];
    state.people = [learner, bystander, demonstrator];
    learner.conditions = [];
    demonstrator.conditions = [];
    learner.body = { health: 90, hydration: 90, nutrition: 90 };
    demonstrator.body = { health: 90, hydration: 90, nutrition: 90 };
    demonstrator.position = structuredClone(learner.position);
    learner.knowledge = [];
    demonstrator.knowledge = [{
      id: ignitionTechniqueId,
      kind: 'technique',
      summary: exertionTechniqueSummary(ignitionRule),
      confidence: 72,
      learnedAtMonth: 5,
      sourceEventIds: ['demonstrator-own-verified-ignition'],
    }];
    learner.inventory = [
      {
        id: 'learner-raw-meat', materialId: Material.RawMeat, quantity: 1,
        sourceEventIds: ['learner-raw-meat-origin'],
      },
      {
        id: 'learner-stone-tool', materialId: Material.StoneTool, quantity: 1,
        sourceEventIds: ['learner-stone-tool-origin'],
      },
      {
        id: 'learner-fiber', materialId: Material.Fiber, quantity: 1,
        sourceEventIds: ['learner-fiber-origin'],
      },
    ];
    demonstrator.inventory = [
      {
        id: 'demonstrator-stone-tool', materialId: Material.StoneTool, quantity: 1,
        sourceEventIds: ['demonstrator-stone-tool-origin'],
      },
      {
        id: 'demonstrator-fiber', materialId: Material.Fiber, quantity: 1,
        sourceEventIds: ['demonstrator-fiber-origin'],
      },
    ];

    const adjacentCells = neighbors4(learner.position.cellId).slice(0, 2);
    assert.equal(adjacentCells.length, 2, 'the directed fixture needs two adjacent targets');
    assert.ok(learner.position.z > 0, 'the directed fixture needs a supporting voxel below each target');
    const airTargets = adjacentCells.map((targetCell) => {
      const position = { x: cellX(targetCell), y: cellY(targetCell), z: learner.position.z };
      setVoxel(state.world.grid, position.x, position.y, position.z - 1, Material.Stone);
      setVoxel(state.world.grid, position.x, position.y, position.z, Material.Air);
      return position;
    });

    const project = makeProject(learner, `prepared-food-inquiry-${seed}`);
    const intent = {
      id: `intent:${project.id}`,
      ownerId: learner.id,
      summary: project.summary,
      domain: 'strategic',
      goal: { kind: 'project-completed', projectId: project.id },
      nextAction: {
        kind: 'attend',
        target: { kind: 'inventory-stack', personId: learner.id, stackId: 'learner-raw-meat' },
      },
      status: 'active',
      createdAtMonth: 7,
      lastProgressAtMonth: 12,
      progress: 0.2,
      sourceDecisionEventId: `decision:${project.id}`,
      projectId: project.id,
      sourceFactIds: [...project.triggerFactIds],
      actionEventIds: [],
      replanCount: 0,
    };
    state.projects = [project];
    state.intents = [intent];
    learner.activeIntentId = intent.id;
    delete demonstrator.activeIntentId;
    return { state, learner, demonstrator, bystander, project, intent, airTargets, orderInMonth: 0 };
  }

  function techniqueRequestOptions(fixture) {
    return buildDecisionContext(fixture.state, fixture.learner).options.filter((option) => {
      const action = option.nextAction;
      return action.kind === 'communicate'
        && action.content.kind === 'request'
        && action.content.techniqueDemonstration?.projectId === fixture.project.id
        && action.content.techniqueDemonstration.requesterId === fixture.learner.id
        && action.audience.includes(fixture.demonstrator.id);
    });
  }

  function techniqueDemonstrationOptions(fixture) {
    return buildDecisionContext(fixture.state, fixture.demonstrator).options.filter((option) => {
      const action = option.nextAction;
      return action.kind === 'act'
        && action.techniqueDemonstration?.projectId === fixture.project.id
        && action.techniqueDemonstration.learnerId === fixture.learner.id;
    });
  }

  function techniqueImitationOptions(fixture) {
    return buildDecisionContext(fixture.state, fixture.learner).options.filter((option) => {
      const action = option.nextAction;
      return action.kind === 'act'
        && action.techniqueImitation?.projectId === fixture.project.id
        && action.techniqueImitation.techniqueId === ignitionTechniqueId;
    });
  }

  function executeAndRecord(fixture, actor, action) {
    const orderInMonth = fixture.orderInMonth;
    fixture.orderInMonth += 1;
    const fact = executePrimitiveAction(
      fixture.state,
      actor,
      action,
      13,
      orderInMonth,
      { cause: 'intent', actionTick: orderInMonth + 1 },
    );
    fixture.state.world.past.push(fact);
    recordProjectAction(fixture.state, fixture.project.id, fact);
    return fact;
  }

  function campaignLimits(project) {
    const campaign = project.hypothesisCampaign;
    return {
      budget: campaign?.budget,
      noResponseBudget: campaign?.noResponseBudget,
      responseBudget: campaign?.responseBudget,
    };
  }

  {
    const fixture = makeFixture(2801);
    const limitsBefore = campaignLimits(fixture.project);
    const requestOptions = techniqueRequestOptions(fixture);
    assert.equal(requestOptions.length, 1, 'one active inquiry may request one local person for a matching demonstration');
    const requestAction = requestOptions[0].nextAction;
    assert.equal(requestAction.kind, 'communicate');
    assert.equal(requestAction.content.kind, 'request');
    assert.equal(requestAction.channel, 'gesture');
    assert.deepEqual(requestAction.content.techniqueDemonstration, {
      projectId: fixture.project.id,
      desiredFunction: 'prepared-food',
      requesterId: fixture.learner.id,
      expiresAtMonth: requestAction.content.techniqueDemonstration.expiresAtMonth,
    });
    assert.ok(requestAction.content.techniqueDemonstration.expiresAtMonth >= 13);
    assert.equal(
      requestOptions[0].id,
      `request-technique:${fixture.project.id}:${fixture.learner.id}:${fixture.bystander.id}`,
      'the option identity should remain anchored to the stable first unasked local person instead of the whole audience set',
    );
    assert.deepEqual(
      [...requestAction.audience].sort(),
      [fixture.bystander.id, fixture.demonstrator.id].sort(),
      'one request should reach every currently colocated person who has not yet been asked for this project',
    );

    const requestFact = executeAndRecord(fixture, fixture.learner, requestAction);
    assert.equal(requestFact.status, 'completed');
    assert.equal(
      fixture.learner.knowledge.some((fact) => fact.id === ignitionTechniqueId),
      false,
      'a request alone must not copy the teacher technique',
    );
    assert.equal(fixture.project.techniqueDemonstrations.length, 0);
    assert.equal(
      techniqueRequestOptions(fixture).length,
      0,
      'the same project must not compile a duplicate unanswered request to the same person',
    );

    const demonstrationOptions = techniqueDemonstrationOptions(fixture);
    assert.equal(demonstrationOptions.length, 1, 'the reliable addressee with real inputs may demonstrate');
    const demonstrationAction = demonstrationOptions[0].nextAction;
    assert.equal(demonstrationAction.kind, 'act');
    assert.equal(demonstrationAction.operation, 'exert');
    assert.deepEqual(demonstrationAction.techniqueDemonstration, {
      requestEventId: requestFact.id,
      projectId: fixture.project.id,
      learnerId: fixture.learner.id,
      techniqueId: ignitionTechniqueId,
    });
    assert.equal(demonstrationAction.toolStackId, 'demonstrator-stone-tool');
    assert.ok(demonstrationAction.targets.some((target) => (
      target.kind === 'inventory-stack'
      && target.personId === fixture.demonstrator.id
      && target.stackId === 'demonstrator-fiber'
    )), 'the demonstration must bind the demonstrator\'s own input stack');
    const demonstratedPosition = demonstrationAction.targets.find((target) => target.kind === 'voxel')?.position;
    assert.ok(demonstratedPosition);
    assert.equal(voxelAt(
      fixture.state.world.grid,
      demonstratedPosition.x,
      demonstratedPosition.y,
      demonstratedPosition.z,
    ), Material.Air);

    const demonstrationFact = executeAndRecord(fixture, fixture.demonstrator, demonstrationAction);
    assert.equal(demonstrationFact.status, 'completed');
    assert.equal(demonstrationFact.diff.outputMaterialId, Material.Fire);
    assert.equal(demonstrationFact.diff.techniqueLearningStage, 'demonstration');
    assert.equal(demonstrationFact.diff.techniqueId, ignitionTechniqueId);
    assert.equal(demonstrationFact.diff.techniqueProjectId, fixture.project.id);
    assert.equal(demonstrationFact.diff.techniqueLearnerId, fixture.learner.id);
    assert.equal(demonstrationFact.diff.techniqueRequestEventId, requestFact.id);
    assert.equal(demonstrationFact.diff.techniqueDemonstratorId, fixture.demonstrator.id);
    assert.ok(Array.isArray(demonstrationFact.diff.techniqueSourceKeys));
    assert.ok(demonstrationFact.diff.techniqueSourceKeys.includes(
      `inventory:${fixture.demonstrator.id}:demonstrator-stone-tool`,
    ));
    assert.ok(demonstrationFact.diff.techniqueSourceKeys.includes(
      `inventory:${fixture.demonstrator.id}:demonstrator-fiber`,
    ));
    assert.deepEqual(demonstrationFact.diff.position, {
      x: demonstratedPosition.x,
      y: demonstratedPosition.y,
      z: demonstratedPosition.z - 1,
    }, 'friction ignition must place Fire on the supporting surface');
    assert.equal(voxelAt(
      fixture.state.world.grid,
      demonstratedPosition.x,
      demonstratedPosition.y,
      demonstratedPosition.z,
    ), Material.Air, 'the authoritative demonstration must not fill the air above the surface');
    assert.equal(voxelAt(
      fixture.state.world.grid,
      demonstrationFact.diff.position.x,
      demonstrationFact.diff.position.y,
      demonstrationFact.diff.position.z,
    ), Material.Fire, 'the authoritative demonstration must create a real Fire voxel on the surface');

    const tentative = fixture.learner.knowledge.find((fact) => fact.id === ignitionTechniqueId);
    assert.ok(tentative, 'a successful witnessed demonstration should create tentative learner knowledge');
    assert.equal(tentative.kind, 'technique');
    assert.ok(tentative.confidence < 55, 'one demonstration must remain below the reliable threshold');
    assert.ok(tentative.sourceEventIds.includes(demonstrationFact.id));
    assert.equal(fixture.project.techniqueDemonstrations.length, 1);
    const basis = fixture.project.techniqueDemonstrations[0];
    assert.equal(basis.requestEventId, requestFact.id);
    assert.equal(basis.demonstrationEventId, demonstrationFact.id);
    assert.equal(basis.demonstratorId, fixture.demonstrator.id);
    assert.equal(basis.learnerId, fixture.learner.id);
    assert.equal(basis.techniqueId, ignitionTechniqueId);
    assert.equal(basis.initialConfidence, tentative.confidence);
    assert.ok(basis.initialConfidence < 55);
    assert.deepEqual(basis.sourceKeys, demonstrationFact.diff.techniqueSourceKeys);

    const imitationOptions = techniqueImitationOptions(fixture);
    assert.equal(imitationOptions.length, 1, 'the tentative learner with own entities may imitate the exact demonstration');
    const imitationAction = imitationOptions[0].nextAction;
    assert.equal(imitationAction.kind, 'act');
    assert.equal(imitationAction.operation, 'exert');
    assert.deepEqual(imitationAction.techniqueImitation, {
      projectId: fixture.project.id,
      demonstrationEventId: demonstrationFact.id,
      techniqueId: ignitionTechniqueId,
    });
    assert.equal(imitationAction.toolStackId, 'learner-stone-tool');
    assert.ok(imitationAction.targets.some((target) => (
      target.kind === 'inventory-stack'
      && target.personId === fixture.learner.id
      && target.stackId === 'learner-fiber'
    )), 'imitation must bind the learner\'s own current input stack');
    assert.equal(imitationAction.targets.some((target) => (
      target.kind === 'inventory-stack' && target.personId === fixture.demonstrator.id
    )), false, 'imitation cannot borrow a demonstrator entity reference');

    const imitationFact = executeAndRecord(fixture, fixture.learner, imitationAction);
    assert.equal(imitationFact.status, 'completed');
    assert.equal(imitationFact.diff.outputMaterialId, Material.Fire);
    assert.equal(imitationFact.diff.techniqueLearningStage, 'imitation');
    assert.equal(imitationFact.diff.techniqueId, ignitionTechniqueId);
    assert.equal(imitationFact.diff.techniqueProjectId, fixture.project.id);
    assert.equal(imitationFact.diff.techniqueLearnerId, fixture.learner.id);
    assert.equal(imitationFact.diff.techniqueDemonstrationEventId, demonstrationFact.id);
    assert.ok(Array.isArray(imitationFact.diff.techniqueImitationSourceKeys));
    assert.ok(imitationFact.diff.techniqueImitationSourceKeys.includes(
      `inventory:${fixture.learner.id}:learner-stone-tool`,
    ));
    assert.ok(imitationFact.diff.techniqueImitationSourceKeys.includes(
      `inventory:${fixture.learner.id}:learner-fiber`,
    ));
    assert.equal(
      imitationFact.diff.techniqueImitationSourceKeys.some((key) => key.includes(fixture.demonstrator.id)),
      false,
      'imitation source lineage must not contain a demonstrator-owned entity key',
    );
    const reliable = fixture.learner.knowledge.find((fact) => fact.id === ignitionTechniqueId);
    assert.ok((reliable?.confidence ?? 0) >= 55, 'only the learner\'s successful imitation may cross reliability');
    assert.ok(reliable.sourceEventIds.includes(imitationFact.id));
    assert.ok(fixture.project.actionEventIds.includes(requestFact.id));
    assert.ok(fixture.project.actionEventIds.includes(demonstrationFact.id));
    assert.ok(fixture.project.actionEventIds.includes(imitationFact.id));
    assert.deepEqual(campaignLimits(fixture.project), limitsBefore,
      'request, demonstration and imitation must not increase or reset blind hypothesis budgets');
    const report = buildEvolutionFactsReport(fixture.state, {
      schemaVersion: 2,
      runId: 'directed-technique-broadcast-observer',
      provider: 'local',
      model: 'rules',
      status: 'completed',
      startedAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
      fromMonth: 0,
      requestedEndMonth: 13,
      reachedMonth: 13,
      checkpoints: [],
      turningPoints: [],
    });
    assert.equal(report.techniqueDemonstrationRequestPersonMismatches, 0,
      'a source-valid multi-person local broadcast must not be audited as a person mismatch');
    assert.equal(report.techniqueDemonstrationUniqueProjectTeachers, 2,
      'the observer must count each reached project/teacher pair in a broadcast');
    assert.equal(report.techniqueDemonstrationDemonstratorMismatches, 0,
      'the responding demonstrator may be any actual member of the request audience');
  }

  {
    const fixture = makeFixture(2802);
    fixture.state.projects = [];
    fixture.state.intents = [];
    delete fixture.learner.activeIntentId;
    assert.equal(techniqueRequestOptions(fixture).length, 0,
      'a local expert must not trigger technique teaching without an active learner project');
    const legacyTechniqueTeach = buildDecisionContext(fixture.state, fixture.demonstrator).options.filter((option) => (
      option.id.startsWith('teach:')
      && option.nextAction.kind === 'communicate'
      && option.nextAction.content.kind === 'claim'
      && option.nextAction.content.factId === ignitionTechniqueId
    ));
    assert.equal(legacyTechniqueTeach.length, 0,
      'ordinary projectless technique teach options must be removed while codebook teaching remains separate');
  }

  {
    const fixture = makeFixture(2803);
    const requestAction = techniqueRequestOptions(fixture)[0]?.nextAction;
    assert.ok(requestAction);
    const requestFact = executeAndRecord(fixture, fixture.learner, requestAction);
    assert.equal(requestFact.status, 'completed');
    fixture.demonstrator.position.cellId = fixture.state.world.grid.width * fixture.state.world.grid.depth - 1;
    assert.equal(techniqueDemonstrationOptions(fixture).length, 0,
      'an answered request cannot compile a demonstration after the teacher leaves the learner\'s visible range');
    assert.equal(fixture.project.techniqueDemonstrations.length, 0);
  }

  {
    const fixture = makeFixture(2807);
    const adjacentCell = neighbors4(fixture.learner.position.cellId)[0];
    fixture.demonstrator.position.cellId = adjacentCell;
    fixture.demonstrator.position.z = fixture.learner.position.z;
    const localTargetCell = neighbors4(adjacentCell)
      .find((cellId) => cellId !== fixture.learner.position.cellId);
    assert.ok(localTargetCell !== undefined);
    const localTarget = { x: cellX(localTargetCell), y: cellY(localTargetCell), z: fixture.demonstrator.position.z };
    setVoxel(fixture.state.world.grid, localTarget.x, localTarget.y, localTarget.z - 1, Material.Stone);
    setVoxel(fixture.state.world.grid, localTarget.x, localTarget.y, localTarget.z, Material.Air);
    const requestAction = techniqueRequestOptions(fixture)[0]?.nextAction;
    assert.ok(requestAction, 'a visible reliable holder should receive a project-bound gesture request');
    const requestFact = executeAndRecord(fixture, fixture.learner, requestAction);
    assert.equal(requestFact.status, 'completed');
    const options = techniqueDemonstrationOptions(fixture);
    assert.equal(options.length, 1,
      'a reliable holder on an adjacent visible cell may perform a local physical demonstration');
    const demonstrationFact = executeAndRecord(fixture, fixture.demonstrator, options[0].nextAction);
    assert.equal(demonstrationFact.status, 'completed');
    const report = buildEvolutionFactsReport(fixture.state, {
      schemaVersion: 2, runId: 'visible-technique-demonstration', provider: 'local', model: 'rules',
      status: 'completed', startedAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z',
      fromMonth: 0, requestedEndMonth: 13, reachedMonth: 13, checkpoints: [], turningPoints: [],
    });
    assert.equal(report.techniqueDemonstrationColocationMismatches, 0,
      'the observer should accept a demonstration inside the learner\'s current perception range');
  }

  {
    const fixture = makeFixture(2808);
    fixture.learner.inventory = fixture.learner.inventory.filter((stack) => stack.id !== 'learner-fiber');
    fixture.state.world.drops.push({
      id: 'learner-imitation-fiber-drop',
      materialId: Material.Fiber,
      cellId: fixture.learner.position.cellId,
      z: fixture.learner.position.z,
      quantity: 3,
      createdAtMonth: 12,
      sourceEventIds: [],
    });
    const limitsBefore = campaignLimits(fixture.project);
    const requestAction = techniqueRequestOptions(fixture)[0]?.nextAction;
    assert.ok(requestAction);
    const requestFact = executeAndRecord(fixture, fixture.learner, requestAction);
    assert.equal(requestFact.status, 'completed');
    const demonstrationAction = techniqueDemonstrationOptions(fixture)[0]?.nextAction;
    assert.ok(demonstrationAction);
    const demonstrationFact = executeAndRecord(fixture, fixture.demonstrator, demonstrationAction);
    assert.equal(demonstrationFact.status, 'completed');

    const context = buildDecisionContext(fixture.state, fixture.learner);
    assert.equal(context.options.some((option) => option.nextAction.kind === 'act'
      && option.nextAction.techniqueImitation), false,
    'imitation cannot compile before the learner owns the demonstrated input');
    const collect = context.options.find((option) => option.projectId === fixture.project.id
      && option.nextAction.kind === 'transfer'
      && option.nextAction.materialId === Material.Fiber);
    assert.ok(collect, 'the pending demonstration should compile an exact one-unit input logistics step');
    assert.equal(collect.nextAction.quantity, 1);
    assert.equal(context.options.some((option) => option.projectId === fixture.project.id
      && option.nextAction.kind === 'act'
      && !option.nextAction.techniqueImitation), false,
    'a pending demonstration must not fall back to an unrelated hypothesis action');
    const collectFact = executeAndRecord(fixture, fixture.learner, collect.nextAction);
    assert.equal(collectFact.status, 'completed');
    assert.equal(techniqueImitationOptions(fixture).length, 1,
      'after acquiring the exact deficit, the same demonstration basis should compile imitation');
    assert.deepEqual(campaignLimits(fixture.project), limitsBefore,
      'demonstration-bound logistics must not restore or consume blind hypothesis budget');
  }

  {
    const fixture = makeFixture(2804);
    fixture.demonstrator.knowledge.find((fact) => fact.id === ignitionTechniqueId).confidence = 54;
    const requestAction = techniqueRequestOptions(fixture)[0]?.nextAction;
    assert.ok(requestAction, 'the learner request should express a functional deficit without reading hidden expertise');
    const requestFact = executeAndRecord(fixture, fixture.learner, requestAction);
    assert.equal(requestFact.status, 'completed');
    assert.equal(techniqueDemonstrationOptions(fixture).length, 0,
      'a tentative teacher cannot demonstrate as a reliable technique holder');
    assert.equal(fixture.project.techniqueDemonstrations.length, 0);
  }

  {
    const fixture = makeFixture(2805);
    const requestAction = techniqueRequestOptions(fixture)[0]?.nextAction;
    assert.ok(requestAction);
    const requestFact = executeAndRecord(fixture, fixture.learner, requestAction);
    assert.equal(requestFact.status, 'completed');
    fixture.demonstrator.inventory = fixture.demonstrator.inventory.filter((stack) => stack.id !== 'demonstrator-fiber');
    assert.equal(techniqueDemonstrationOptions(fixture).length, 0,
      'reliable knowledge without the teacher\'s exact current input cannot compile a demonstration');
    assert.equal(fixture.project.techniqueDemonstrations.length, 0);
  }

  {
    const fixture = makeFixture(2806);
    const claimFact = executeAndRecord(fixture, fixture.demonstrator, {
      kind: 'communicate',
      content: {
        id: `ordinary-claim:${ignitionTechniqueId}`,
        kind: 'claim',
        summary: exertionTechniqueSummary(ignitionRule),
        factId: ignitionTechniqueId,
      },
      audience: [fixture.learner.id],
      channel: 'voice',
    });
    assert.equal(claimFact.status, 'completed');
    const hearsay = fixture.learner.knowledge.find((fact) => fact.id === ignitionTechniqueId);
    assert.ok(hearsay);
    assert.ok(hearsay.confidence < 55, 'an ordinary claim may create only a tentative clue');
    assert.equal(fixture.project.techniqueDemonstrations.length, 0,
      'a claim without request and physical response must not create demonstration basis');
    assert.equal(techniqueImitationOptions(fixture).length, 0,
      'tentative hearsay without demonstration basis must not compile the imitation fast path');
  }

  process.stdout.write('demand-bound technique demonstration tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
