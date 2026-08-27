import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-project-leadership-'));
const bundlePath = path.join(temporaryDirectory, 'project-leadership.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export { buildProjectOptions, recordProjectAction, recompileProjectNextAction, synchronizeProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
    export { mechanicalPowerCompletionEvidence } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/mechanical-power-options.ts'))};
    export { projectCompletionEvidence, projectFunctionSatisfied } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-completion.ts'))};
    export { projectContributionStep } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-step-compiler.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { actionOptionSemantics } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-option-semantics.ts'))};
    export { ensureMechanicalPowerNetwork, mechanicalPowerNetworkId, mechanicalPowerPlanKey, recordMechanicalPowerInstallation } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/mechanical-power.ts'))};
    export { inventoryCombinationRules, inventoryCombinationTechniqueId } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/interaction-rules.ts'))};
    export { projectKnowledgeRequestHasAuthoritativeSource, pendingProjectKnowledgeOutput } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project-knowledge-request.ts'))};
    export { inspectProjectMaterialContributionRequest, projectMaterialContributionRequestHasAuthoritativeSource } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project-material-request.ts'))};
    export { projectCurrentLeadId, projectLeadershipVacancy, PROJECT_LEADERSHIP_VACANCY_MONTHS } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project-leadership.ts'))};
    export { inspectProjectLeadership, projectLeadIdAtEvent } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project-leadership.ts'))};
    export { worldEventById } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/event-index.ts'))};
    export { projectsLedBy } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/state-index.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { cellId, cellX, cellY, setVoxel } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
    export { beginHistoryRetentionProjection, finishHistoryRetentionProjection, foldHistoryRetentionSegment } from ${JSON.stringify(path.join(projectRoot, 'server/history-retention-projection.ts'))};
    export { installVerifiedHistoryRetentionEvidence } from ${JSON.stringify(path.join(projectRoot, 'server/retained-history-evidence.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=project-leadership-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    PROJECT_LEADERSHIP_VACANCY_MONTHS,
    actionOptionSemantics,
    beginHistoryRetentionProjection,
    buildProjectOptions,
    cellId,
    cellX,
    cellY,
    createInitialState,
    ensureMechanicalPowerNetwork,
    executePrimitiveAction,
    finishHistoryRetentionProjection,
    foldHistoryRetentionSegment,
    inspectProjectMaterialContributionRequest,
    inspectProjectLeadership,
    installVerifiedHistoryRetentionEvidence,
    instantiateProject,
    inventoryCombinationRules,
    inventoryCombinationTechniqueId,
    mechanicalPowerCompletionEvidence,
    mechanicalPowerNetworkId,
    mechanicalPowerPlanKey,
    pendingProjectKnowledgeOutput,
    projectContributionStep,
    projectCompletionEvidence,
    projectCurrentLeadId,
    projectFunctionSatisfied,
    projectKnowledgeRequestHasAuthoritativeSource,
    projectLeadIdAtEvent,
    projectLeadershipVacancy,
    projectMaterialContributionRequestHasAuthoritativeSource,
    projectsLedBy,
    recordMechanicalPowerInstallation,
    recordProjectAction,
    recompileProjectNextAction,
    setVoxel,
    synchronizeProject,
    worldEventById,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  function resetPerson(person, bornAtMonth = -25 * 12) {
    person.bornAtMonth = bornAtMonth;
    person.diedAtMonth = undefined;
    person.conditions = [];
    person.body = { health: 100, hydration: 100, nutrition: 100 };
    person.inventory = [];
    person.knowledge = [];
    person.memories = [];
    person.knownPlaces = [];
    person.bereavements = [];
    person.relations = [];
    person.maternalTeachingSourceEventIds = [];
    person.geneticParents = [];
  }

  function actionFact(actor, id, atMonth, orderInMonth, action, status, diff, result = '测试项目事实') {
    return {
      id,
      kind: 'action',
      actionTick: orderInMonth,
      atMonth,
      orderInMonth,
      cellId: actor.position.cellId,
      who: actor.id,
      cause: 'intent',
      action,
      fromCellId: actor.position.cellId,
      toCellId: actor.position.cellId,
      fromZ: actor.position.z,
      toZ: actor.position.z,
      pathSegment: [actor.position.cellId],
      status,
      result,
      diff,
    };
  }

  function deathFact(person, id, atMonth, orderInMonth) {
    return {
      id,
      kind: 'environment',
      change: 'death',
      who: person.id,
      atMonth,
      orderInMonth,
      cellId: person.position.cellId,
      result: `${person.name}在夹具中死亡`,
      diff: { personId: person.id, cause: 'test' },
    };
  }

  function rememberDeath(person, deceased, death) {
    person.bereavements = [{
      id: `bereavement:${person.id}:${deceased.id}`,
      remainsId: `remains:${deceased.id}`,
      deceasedPersonId: deceased.id,
      deathEventId: death.id,
      learnedAtMonth: death.atMonth,
      learnedBy: 'witness',
      intensity: 0.5,
      sourceEventIds: [death.id],
    }];
  }

  function addRemains(state, person, death) {
    state.world.remains ??= [];
    state.world.remains.push({
      id: `remains:${person.id}`,
      personId: person.id,
      position: { cellId: person.position.cellId, z: person.position.z },
      status: 'exposed',
      createdAtMonth: death.atMonth,
      deathEventId: death.id,
      sourceEventIds: [death.id],
    });
  }

  function addContribution(state, project, actor, id, atMonth, orderInMonth) {
    const fact = actionFact(
      actor,
      id,
      atMonth,
      orderInMonth,
      { kind: 'act', operation: 'combine', targets: [] },
      'progressed',
      { projectContribution: true },
      '本人在固定工地留下真实进展',
    );
    state.world.past.push(fact);
    project.actionEventIds.push(fact.id);
    if (!project.contributorIds.includes(actor.id)) project.contributorIds.push(actor.id);
    project.progressEvidence.push({
      eventId: fact.id,
      atMonth: fact.atMonth,
      kind: 'action-progress',
      actorId: actor.id,
      target: { ...project.site },
    });
    return fact;
  }

  function createLeadershipFixture(seed, desiredFunction = 'copper-smelting') {
    const state = createInitialState(seed, {
      endpoint: { kind: 'months', value: 240 },
      chaosIntensity: 0,
    });
    state.clock.elapsedMonths = 10;
    state.world.past = [];
    state.lastStep = [];
    state.projects = [];
    const founder = state.people[0];
    const successor = state.people[1];
    const alternate = state.people[2];
    state.people = [founder, successor, alternate];
    for (const person of state.people) resetPerson(person);
    const site = { cellId: founder.position.cellId, z: founder.position.z };
    for (const person of [successor, alternate]) {
      person.position.cellId = site.cellId;
      person.position.z = site.z;
      person.position.previousCellId = site.cellId;
      person.position.previousZ = site.z;
    }
    founder.knowledge.push({
      id: 'founder-private-technique',
      kind: 'technique',
      summary: '只属于发起人的私人知识',
      confidence: 90,
      learnedAtMonth: 1,
      sourceEventIds: ['founder-private-source'],
    });
    founder.inventory.push({
      id: 'founder-private-stack',
      materialId: Material.Copper,
      quantity: 1,
      sourceEventIds: ['founder-private-source'],
    });
    const project = instantiateProject({
      id: `succession-project-${seed}`,
      kind: 'production',
      need: 'alloy-capability',
      desiredFunction,
      summary: '一处仍未完成的固定公共工地',
      ownerId: founder.id,
      beneficiaryIds: [founder.id, successor.id, alternate.id],
      triggerFactIds: [`pressure:${seed}`],
      pressure: 72,
      createdAtMonth: 1,
      reviewAtMonth: 60,
      site,
    });
    project.planKnowledgeId = 'founder-private-technique';
    project.missingMaterialIds = [Material.CopperCharge];
    project.materialDemands = [{ materialId: Material.CopperCharge, quantity: 1 }];
    project.reservations = [{
      personId: founder.id,
      stackId: 'founder-private-stack',
      materialId: Material.Copper,
      quantity: 1,
    }];
    project.knowledgeRequests = [{
      version: 'project-knowledge-request-v1',
      requestEventId: `request:${seed}`,
      projectId: project.id,
      requesterId: founder.id,
      listenerIds: [successor.id],
      outputMaterialId: Material.Copper,
      expiresAtMonth: 20,
      atMonth: 8,
    }];
    project.logisticsEpisodes = [{
      id: `logistics:${seed}`,
      kind: 'source',
      actorId: founder.id,
      materialIds: [Material.CopperCharge],
      target: { ...site },
      sourceRef: { kind: 'project-requirement', projectId: project.id },
      sourceEventIds: [`pressure:${seed}`],
      createdAt: 8,
      status: 'active',
      actionEventIds: [],
    }];
    project.activeLogisticsEpisodeId = `logistics:${seed}`;
    state.projects.push(project);
    const firstContribution = addContribution(state, project, successor, `contribution:${seed}:successor`, 9, 1);
    const alternateContribution = addContribution(state, project, alternate, `contribution:${seed}:alternate`, 9, 2);
    const death = deathFact(founder, `death:${seed}:${founder.id}`, 10, 3);
    state.world.past.push(death);
    addRemains(state, founder, death);
    founder.diedAtMonth = 10;
    founder.body.health = 0;
    return { state, founder, successor, alternate, project, death, firstContribution, alternateContribution };
  }

  function completeLeadershipSuccession(fixture, atMonth = 11) {
    const { state, founder, successor, project, death } = fixture;
    synchronizeProject(state, project, death.atMonth);
    assert.ok(projectLeadershipVacancy(project));
    rememberDeath(successor, founder, death);
    const option = buildProjectOptions(state, successor, [project.site.cellId], [], [])
      .find((candidate) => candidate.id.startsWith('inspect-project-leadership:'));
    assert.equal(option?.nextAction.kind, 'attend');
    const succession = executePrimitiveAction(
      state,
      successor,
      option.nextAction,
      atMonth,
      1,
      { cause: 'intent', actionTick: 1 },
    );
    assert.equal(succession.status, 'completed', succession.result);
    state.world.past.push(succession);
    recordProjectAction(state, project.id, succession);
    assert.equal(projectCurrentLeadId(project), successor.id);
    assert.equal(project.ownerId, founder.id);
    return succession;
  }

  {
    const fixture = createLeadershipFixture(9701);
    const { state, founder, successor, alternate, project, death } = fixture;
    assert.equal(projectsLedBy(state, founder.id).includes(project), true, 'legacy state begins founder-led');
    synchronizeProject(state, project, 10);
    const vacancy = projectLeadershipVacancy(project);
    assert.ok(vacancy, '死亡事实和真实贡献应先形成有界 vacancy，而不是即时换 owner');
    assert.equal(project.ownerId, founder.id, 'ownerId must remain the immutable founder identity');
    assert.equal(projectCurrentLeadId(project), undefined, 'open vacancy has no current lead');
    assert.equal(projectsLedBy(state, founder.id).includes(project), false, 'the cached lead view releases a vacancy');
    assert.equal(project.status, 'active');
    assert.equal(vacancy.deathEventId, death.id);
    assert.equal(vacancy.expiresAtMonth, 10 + PROJECT_LEADERSHIP_VACANCY_MONTHS);
    assert.ok(project.triggerFactIds.includes(death.id), 'death anchor must remain in the project exact source boundary');
    assert.equal(project.planKnowledgeId, undefined, 'founder plan knowledge must not cross the vacancy');
    assert.deepEqual(project.materialDemands, []);
    assert.deepEqual(project.reservations, []);
    assert.deepEqual(project.knowledgeRequests, []);
    assert.equal(project.logisticsEpisodes[0].status, 'invalidated');
    assert.equal(project.logisticsEpisodes[0].endingReason, 'leadership-vacancy');

    assert.equal(buildProjectOptions(state, successor, [project.site.cellId], [], []).some((option) => (
      option.id.startsWith('inspect-project-leadership:')
    )), false, 'a contributor who does not personally know the death gets no hidden succession option');
    rememberDeath(successor, founder, death);
    rememberDeath(alternate, founder, death);
    assert.equal(buildProjectOptions(state, successor, [], [], []).some((option) => (
      option.id.startsWith('inspect-project-leadership:')
    )), false, 'an invisible site cannot be inherited remotely');

    const successorOption = buildProjectOptions(state, successor, [project.site.cellId], [], [])
      .find((option) => option.id.startsWith('inspect-project-leadership:'));
    const alternateOption = buildProjectOptions(state, alternate, [project.site.cellId], [], [])
      .find((option) => option.id.startsWith('inspect-project-leadership:'));
    assert.equal(successorOption?.nextAction.kind, 'attend', 'succession must be a typed on-site inspection');
    assert.equal(alternateOption?.nextAction.kind, 'attend');
    assert.equal(actionOptionSemantics(successorOption).purpose, 'project');
    assert.equal(actionOptionSemantics(successorOption).planningChannel, 'ordinary');

    const successorKnowledgeBefore = structuredClone(successor.knowledge);
    const successorInventoryBefore = structuredClone(successor.inventory);
    const successionFact = executePrimitiveAction(
      state,
      successor,
      successorOption.nextAction,
      11,
      1,
      { cause: 'intent', actionTick: 1 },
    );
    assert.equal(successionFact.status, 'completed', successionFact.result);
    state.world.past.push(successionFact);
    recordProjectAction(state, project.id, successionFact);
    assert.equal(projectCurrentLeadId(project), successor.id);
    assert.equal(projectsLedBy(state, successor.id).includes(project), true, 'the cached lead view follows the append');
    assert.equal(project.ownerId, founder.id, 'successful succession still cannot rewrite founder ownership');
    assert.deepEqual(successor.inventory, successorInventoryBefore, 'succession does not transfer founder inventory');
    assert.equal(successor.knowledge.some((fact) => fact.id === 'founder-private-technique'), false,
      'succession does not copy founder private knowledge');
    assert.equal(successor.knowledge.length, successorKnowledgeBefore.length + 1,
      'the only new knowledge is the successor own on-site inspection');
    assert.deepEqual(project.leadershipTransitions.at(-1).sourceEventIds, [
      death.id,
      fixture.firstContribution.id,
      successionFact.id,
    ]);

    const staleAttempt = executePrimitiveAction(
      state,
      alternate,
      alternateOption.nextAction,
      11,
      2,
      { cause: 'intent', actionTick: 2 },
    );
    assert.equal(staleAttempt.status, 'blocked', 'the first authoritative succession event wins');
    assert.equal(projectCurrentLeadId(project), successor.id);
  }

  {
    const fixture = createLeadershipFixture(9706);
    const { state, founder, successor, alternate, project } = fixture;
    const succession = completeLeadershipSuccession(fixture);
    project.need = 'coordination-capacity';
    project.desiredFunction = 'civic-coordination';
    project.materialDemands = [{
      materialId: Material.CopperCharge,
      requiredQuantity: 1,
      availableQuantity: 0,
      outstandingQuantity: 1,
      branchKey: 'test-successor-material-request',
      sourceFactIds: [succession.id],
    }];
    alternate.inventory.push({
      id: 'successor-request-contributor-stack',
      materialId: Material.CopperCharge,
      quantity: 1,
      sourceEventIds: [fixture.alternateContribution.id],
    });
    const requestAction = {
      kind: 'communicate',
      content: {
        id: `project-material-request:${project.id}:${Material.CopperCharge}`,
        kind: 'request',
        summary: '请把铜料送到固定工地',
        projectMaterialContribution: {
          version: 'project-material-contribution-request-v1',
          projectId: project.id,
          requesterId: successor.id,
          materialId: Material.CopperCharge,
          quantity: 1,
          site: { ...project.site },
          expiresAtMonth: 20,
        },
      },
      audience: [alternate.id],
      channel: 'gesture',
    };
    const requestFact = executePrimitiveAction(
      state,
      successor,
      requestAction,
      12,
      1,
      { cause: 'intent', actionTick: 1 },
    );
    assert.equal(requestFact.status, 'completed', requestFact.result);
    state.world.past.push(requestFact);
    recordProjectAction(state, project.id, requestFact);
    const request = project.materialContributionRequests.at(-1);
    assert.equal(request?.requesterId, successor.id);
    assert.equal(
      projectMaterialContributionRequestHasAuthoritativeSource(state, project, request),
      true,
      'post-transition request is authoritative only for the event-time lead',
    );

    const nonLeadRequest = executePrimitiveAction(
      state,
      alternate,
      {
        ...structuredClone(requestAction),
        content: {
          ...structuredClone(requestAction.content),
          id: `project-material-request:${project.id}:stale`,
          projectMaterialContribution: {
            ...structuredClone(requestAction.content.projectMaterialContribution),
            requesterId: alternate.id,
          },
        },
        audience: [successor.id],
      },
      12,
      2,
      { cause: 'intent', actionTick: 2 },
    );
    assert.equal(nonLeadRequest.status, 'blocked',
      'a non-lead cannot issue a material request under the immutable founder project identity');

    const contributionStep = projectContributionStep(state, alternate, project);
    assert.ok(contributionStep, 'the addressed contributor can act on the successor request');
    assert.equal(contributionStep.action.kind, 'transfer');
    assert.deepEqual(contributionStep.action.to, { kind: 'person', personId: successor.id });
    const deliveryFact = executePrimitiveAction(
      state,
      alternate,
      contributionStep.action,
      12,
      3,
      { cause: 'intent', actionTick: 3 },
    );
    assert.equal(deliveryFact.status, 'completed', deliveryFact.result);
    state.world.past.push(deliveryFact);
    recordProjectAction(state, project.id, deliveryFact);
    assert.equal(successor.inventory.some((stack) => (
      stack.materialId === Material.CopperCharge && stack.sourceEventIds.includes(deliveryFact.id)
    )), true, 'the contribution is delivered to the current lead, not the dead founder');
    assert.equal(
      inspectProjectMaterialContributionRequest(
        state,
        project,
        request,
        12,
        project.materialDemands[0],
      ).status,
      'fulfilled',
    );
    assert.equal(project.ownerId, founder.id, 'material collaboration never rewrites founder identity');
  }

  {
    const fixture = createLeadershipFixture(9707, 'copper-smelting');
    const { state, founder, successor, project, death } = fixture;
    const founderOutput = actionFact(
      founder,
      'founder-portable-copper-output',
      9,
      3,
      { kind: 'act', operation: 'combine', targets: [] },
      'completed',
      { outputMaterialId: Material.Copper, outputStackId: 'founder-portable-copper-stack' },
    );
    state.world.past.splice(state.world.past.indexOf(death), 0, founderOutput);
    project.actionEventIds.push(founderOutput.id);
    completeLeadershipSuccession(fixture);
    successor.inventory.push({
      id: 'old-founder-copper-in-successor-hands',
      materialId: Material.Copper,
      quantity: 1,
      sourceEventIds: [founderOutput.id],
    });
    assert.equal(projectFunctionSatisfied(state, project), false,
      'a founder-era portable output cannot complete the successor project merely by changing hands');

    const successorOutput = actionFact(
      successor,
      'successor-portable-copper-output',
      12,
      1,
      { kind: 'act', operation: 'combine', targets: [] },
      'completed',
      { outputMaterialId: Material.Copper, outputStackId: 'successor-portable-copper-stack' },
    );
    state.world.past.push(successorOutput);
    recordProjectAction(state, project.id, successorOutput);
    successor.inventory.push({
      id: 'successor-portable-copper-stack',
      materialId: Material.Copper,
      quantity: 1,
      sourceEventIds: [successorOutput.id],
    });
    assert.equal(projectFunctionSatisfied(state, project), true,
      'portable metallurgy advances only from the successor own post-transition output');
    assert.equal(project.ownerId, founder.id);
  }

  {
    const fixture = createLeadershipFixture(9708, 'bronze-tooling');
    const { state, founder, successor, project, death } = fixture;
    const bronzeToolRule = inventoryCombinationRules()
      .find((rule) => rule.output.materialId === Material.BronzeTool);
    assert.ok(bronzeToolRule);
    const successorToolTechniqueId = inventoryCombinationTechniqueId(bronzeToolRule);
    const founderTool = actionFact(
      founder,
      'founder-portable-bronze-tool',
      9,
      3,
      { kind: 'act', operation: 'combine', targets: [] },
      'completed',
      {
        outputMaterialId: Material.BronzeTool,
        outputStackId: 'founder-portable-bronze-tool-stack',
        techniqueId: 'founder-private-tool-technique',
      },
    );
    state.world.past.splice(state.world.past.indexOf(death), 0, founderTool);
    project.actionEventIds.push(founderTool.id);
    completeLeadershipSuccession(fixture);
    successor.inventory.push({
      id: 'old-founder-tool-in-successor-hands',
      materialId: Material.BronzeTool,
      quantity: 1,
      sourceEventIds: [founderTool.id],
    });
    assert.equal(projectFunctionSatisfied(state, project), false,
      'founder tool and hidden technique do not become successor completion evidence');

    const successorTool = actionFact(
      successor,
      'successor-portable-bronze-tool',
      12,
      1,
      { kind: 'act', operation: 'combine', targets: [] },
      'completed',
      {
        outputMaterialId: Material.BronzeTool,
        outputStackId: 'successor-portable-bronze-tool-stack',
        techniqueId: successorToolTechniqueId,
      },
    );
    state.world.past.push(successorTool);
    recordProjectAction(state, project.id, successorTool);
    successor.inventory.push({
      id: 'successor-portable-bronze-tool-stack',
      materialId: Material.BronzeTool,
      quantity: 1,
      sourceEventIds: [successorTool.id],
    });
    successor.knowledge.push({
      id: successorToolTechniqueId,
      kind: 'technique',
      summary: '本人复核过的青铜工具制造法',
      confidence: 46,
      learnedAtMonth: 12,
      sourceEventIds: [successorTool.id],
    });
    assert.equal(projectFunctionSatisfied(state, project), false,
      'manufacture without the successor own source-bound verification remains incomplete');
    const verification = executePrimitiveAction(
      state,
      successor,
      {
        kind: 'attend',
        target: {
          kind: 'inventory-stack',
          personId: successor.id,
          stackId: 'successor-portable-bronze-tool-stack',
        },
        verification: {
          techniqueId: successorToolTechniqueId,
          sourceEventId: successorTool.id,
          expectedMaterialId: Material.BronzeTool,
        },
      },
      12,
      2,
      { cause: 'intent', actionTick: 2 },
    );
    assert.equal(verification.status, 'completed', verification.result);
    state.world.past.push(verification);
    recordProjectAction(state, project.id, verification);
    assert.equal(projectFunctionSatisfied(state, project), true,
      'the successor own manufacture plus source-bound verification completes the tool project');
    const completionEvidence = projectCompletionEvidence(state, project);
    assert.equal(completionEvidence.includes(successorTool.id), true);
    assert.equal(completionEvidence.includes(verification.id), true);
    assert.equal(completionEvidence.includes(founderTool.id), false);
    assert.equal(project.ownerId, founder.id);
  }

  {
    const fixture = createLeadershipFixture(9709);
    const { state, successor, project, death, firstContribution } = fixture;
    const succession = completeLeadershipSuccession(fixture);
    project.triggerFactIds = [death.id];
    const postTransitionLeadAction = actionFact(
      successor,
      'post-transition-lead-action',
      11,
      2,
      { kind: 'act', operation: 'exert', targets: [] },
      'completed',
      {},
    );
    state.world.past.push(postTransitionLeadAction);
    project.actionEventIds.push(postTransitionLeadAction.id);
    const fullHistory = [...state.world.past];
    for (let index = 0; index < 12; index += 1) {
      fullHistory.push(actionFact(
        successor,
        `post-succession-hot-padding-${index}`,
        12 + index,
        0,
        { kind: 'act', operation: 'exert', targets: [] },
        'completed',
        {},
      ));
    }
    const hotStartIndex = fullHistory.length - 2;
    state.clock.elapsedMonths = 23;
    state.world.past = fullHistory.slice(hotStartIndex);
    state.world.historyCursor = {
      version: 1,
      eventCount: fullHistory.length,
      hotStartIndex,
      tailEventId: fullHistory.at(-1).id,
    };
    const authority = { stateHash: 'c'.repeat(64) };
    const fold = beginHistoryRetentionProjection(state, authority);
    foldHistoryRetentionSegment(fold, fullHistory, 0);
    const projection = finishHistoryRetentionProjection(fold);
    assert.deepEqual(
      projection.demandGroups.filter((group) => group.blocking).map((group) => ({
        groupKey: group.groupKey,
        unresolvedEventIds: group.unresolvedEventIds,
      })),
      [],
      'bounded leadership fixture must provide every blocking retained source',
    );
    const decodedColdPins = projection.pins
      .filter((pin) => pin.absoluteIndex < hotStartIndex)
      .map((pin) => ({ absoluteIndex: pin.absoluteIndex, event: fullHistory[pin.absoluteIndex] }));
    installVerifiedHistoryRetentionEvidence(state, authority.stateHash, projection, decodedColdPins);
    for (const sourceId of [death.id, firstContribution.id, succession.id]) {
      assert.equal(worldEventById(state, sourceId)?.id, sourceId,
        `bounded restore must resolve cold leadership source ${sourceId}`);
    }
    assert.equal(inspectProjectLeadership(project).status, 'led');
    const coldPostTransitionFact = worldEventById(state, postTransitionLeadAction.id);
    assert.equal(coldPostTransitionFact?.kind, 'action');
    assert.equal(projectLeadIdAtEvent(project, coldPostTransitionFact), successor.id,
      'event-time authority remains derivable after vacancy and succession facts leave the hot window');
    assert.equal(project.ownerId, fixture.founder.id,
      'bounded restoration keeps founder identity separate from reconstructed active authority');
  }

  {
    const { state, project } = createLeadershipFixture(9702);
    synchronizeProject(state, project, 10);
    const vacancy = projectLeadershipVacancy(project);
    assert.ok(vacancy);
    synchronizeProject(state, project, vacancy.expiresAtMonth);
    assert.equal(project.status, 'active', 'the final bounded vacancy month remains open');
    synchronizeProject(state, project, vacancy.expiresAtMonth + 1);
    assert.equal(project.status, 'blocked', 'only expiry without a successor restores the original terminal meaning');
  }

  {
    const { state, project } = createLeadershipFixture(9703, 'durable-record');
    synchronizeProject(state, project, 10);
    assert.equal(project.status, 'blocked', 'private knowledge/body class projects remain non-inheritable in v1');
    assert.equal(project.leadershipTransitions, undefined);
  }

  {
    const { state, project, successor, alternate } = createLeadershipFixture(9705);
    const fakeIds = new Set([
      `contribution:9705:successor`,
      `contribution:9705:alternate`,
    ]);
    state.world.past = state.world.past.filter((event) => !fakeIds.has(event.id));
    project.actionEventIds = project.actionEventIds.filter((eventId) => !fakeIds.has(eventId));
    project.progressEvidence = [];
    project.contributorIds = [project.ownerId, successor.id, alternate.id];
    synchronizeProject(state, project, 10);
    assert.equal(project.status, 'blocked', 'a contributor label without resolvable progress cannot open succession');
    assert.equal(project.leadershipTransitions, undefined);
  }

  {
    const state = createInitialState(9704, {
      endpoint: { kind: 'months', value: 240 },
      chaosIntensity: 0,
    });
    state.clock.elapsedMonths = 1;
    state.world.past = [];
    state.lastStep = [];
    state.projects = [];
    const founder = state.people[0];
    const successor = state.people[1];
    const teacher = state.people[2];
    state.people = [founder, successor, teacher];
    resetPerson(founder);
    resetPerson(successor);
    resetPerson(teacher);

    const source = state.world.mechanicalPower.sources.find((candidate) => candidate.from.y === 12)
      ?? state.world.mechanicalPower.sources[0];
    assert.ok(source, 'fixture requires a generated water-current segment');
    const wheel = { x: source.from.x, y: source.from.y, z: source.from.z + 1 };
    const shaft = { x: wheel.x - 1, y: wheel.y, z: wheel.z };
    const load = { x: wheel.x - 2, y: wheel.y, z: wheel.z };
    const site = { cellId: cellId(load.x - 1, load.y), z: load.z };
    for (const position of [shaft, load, { x: load.x - 1, y: load.y, z: load.z }]) {
      setVoxel(state.world.grid, position.x, position.y, position.z - 1, Material.Stone);
      setVoxel(state.world.grid, position.x, position.y, position.z, Material.Air);
      setVoxel(state.world.grid, position.x, position.y, position.z + 1, Material.Air);
    }
    for (const person of [founder, successor, teacher]) {
      person.position.cellId = site.cellId;
      person.position.z = site.z;
      person.position.previousCellId = site.cellId;
      person.position.previousZ = site.z;
    }

    const projectId = 'mechanical-succession-project';
    const plan = {
      version: 'mechanical-power-plan-v1',
      projectId,
      sourceSegmentId: source.id,
      wheelPosition: wheel,
      shaftPositions: [shaft],
      loadPosition: load,
      sourceKeys: [...source.sourceKeys],
    };
    const founderObservation = executePrimitiveAction(state, founder, {
      kind: 'attend',
      target: { kind: 'voxel', position: { ...source.from } },
      waterCurrentSegmentId: source.id,
    }, 1, 1, { cause: 'intent', actionTick: 1 });
    assert.equal(founderObservation.status, 'completed', founderObservation.result);
    state.world.past.push(founderObservation);
    const project = instantiateProject({
      id: projectId,
      kind: 'production',
      need: 'mechanical-power-capability',
      desiredFunction: 'water-powered-crop-processing',
      summary: '跨负责人继续完成真实机械磨坊',
      ownerId: founder.id,
      beneficiaryIds: [founder.id, successor.id],
      triggerFactIds: [founderObservation.id],
      pressure: 78,
      createdAtMonth: 1,
      reviewAtMonth: 80,
      site,
      mechanicalPowerPlan: structuredClone(plan),
      mechanicalPowerPlanKey: mechanicalPowerPlanKey(plan),
      mechanicalPowerNetworkId: mechanicalPowerNetworkId(plan),
    });
    state.projects.push(project);
    const network = ensureMechanicalPowerNetwork(state.world.mechanicalPower, plan);
    let order = 2;
    const founderInstallationFacts = [];
    for (const component of [
      { role: 'load', materialId: Material.Mill, position: load },
      { role: 'connector', materialId: Material.DriveShaft, position: shaft },
      { role: 'converter', materialId: Material.WaterWheel, position: wheel },
    ]) {
      const stackId = `founder-component-${component.role}`;
      const manufacture = actionFact(
        founder,
        `founder-manufacture-${component.role}`,
        1,
        order++,
        { kind: 'act', operation: 'combine', targets: [] },
        'completed',
        { outputMaterialId: component.materialId, outputStackId: stackId },
      );
      const verification = actionFact(
        founder,
        `founder-verify-${component.role}`,
        1,
        order++,
        { kind: 'attend', target: { kind: 'inventory-stack', personId: founder.id, stackId } },
        'completed',
        {
          verifiedSourceEventId: manufacture.id,
          verifiedStackId: stackId,
          verifiedMaterialId: component.materialId,
        },
      );
      const installation = actionFact(
        founder,
        `founder-install-${component.role}`,
        1,
        order++,
        { kind: 'act', operation: 'exert', targets: [{ kind: 'voxel', position: component.position }] },
        'completed',
        {
          mechanicalPowerInstallation: true,
          projectId,
          networkId: network.id,
          componentRole: component.role,
          componentMaterialId: component.materialId,
        },
      );
      state.world.past.push(manufacture, verification, installation);
      project.actionEventIds.push(manufacture.id, verification.id, installation.id);
      founderInstallationFacts.push(installation);
      recordMechanicalPowerInstallation(network, {
        ...component,
        projectId,
        installedAtMonth: 1,
        installationEventId: installation.id,
        sourceEventIds: [manufacture.id, verification.id, founderObservation.id],
      });
      setVoxel(
        state.world.grid,
        component.position.x,
        component.position.y,
        component.position.z,
        component.materialId,
      );
    }

    const contribution = addContribution(state, project, successor, 'mechanical-successor-contribution', 1, order++);
    setVoxel(state.world.grid, source.from.x, source.from.y, source.from.z, Material.Ice);
    const death = deathFact(founder, 'mechanical-founder-death', 2, 1);
    state.world.past.push(death);
    addRemains(state, founder, death);
    founder.diedAtMonth = 2;
    founder.body.health = 0;
    state.clock.elapsedMonths = 2;
    synchronizeProject(state, project, 2);
    assert.ok(projectLeadershipVacancy(project));
    rememberDeath(successor, founder, death);
    const successionOption = buildProjectOptions(state, successor, [site.cellId], [], [])
      .find((option) => option.id.startsWith('inspect-project-leadership:'));
    assert.equal(successionOption?.nextAction.kind, 'attend');
    const succession = executePrimitiveAction(
      state,
      successor,
      successionOption.nextAction,
      3,
      1,
      { cause: 'intent', actionTick: 1 },
    );
    assert.equal(succession.status, 'completed', succession.result);
    state.world.past.push(succession);
    recordProjectAction(state, project.id, succession);
    assert.equal(projectCurrentLeadId(project), successor.id);
    assert.equal(project.ownerId, founder.id);
    assert.equal(successor.knowledge.some((fact) => fact.id.includes(`water-current:${source.id}`)), false,
      'the founder water observation is not copied during succession');

    const converterIndex = network.components.findIndex((component) => component.role === 'converter');
    assert.notEqual(converterIndex, -1);
    const [temporarilyMissingConverter] = network.components.splice(converterIndex, 1);
    setVoxel(
      state.world.grid,
      temporarilyMissingConverter.position.x,
      temporarilyMissingConverter.position.y,
      temporarilyMissingConverter.position.z,
      Material.Air,
    );
    const unknownOutputMaterialId = pendingProjectKnowledgeOutput(state, project);
    assert.equal(unknownOutputMaterialId, Material.WaterWheel,
      'the successor independently perceives the next unknown component gap');
    const teachingRule = inventoryCombinationRules()
      .find((rule) => rule.output.materialId === unknownOutputMaterialId);
    assert.ok(teachingRule);
    const teachingTechniqueId = inventoryCombinationTechniqueId(teachingRule);
    teacher.knowledge.push({
      id: teachingTechniqueId,
      kind: 'technique',
      summary: '可公开讲授的水轮制造法',
      confidence: 90,
      learnedAtMonth: 1,
      sourceEventIds: [founderObservation.id],
    });
    const knowledgeRequestFact = executePrimitiveAction(
      state,
      successor,
      {
        kind: 'communicate',
        content: {
          id: `project-knowledge-request:${project.id}:${unknownOutputMaterialId}`,
          kind: 'request',
          summary: '询问当前缺失构件的制造办法',
          projectKnowledgeRequest: {
            version: 'project-knowledge-request-v1',
            projectId: project.id,
            requesterId: successor.id,
            outputMaterialId: unknownOutputMaterialId,
            expiresAtMonth: 15,
          },
        },
        audience: [teacher.id],
        channel: 'gesture',
      },
      3,
      2,
      { cause: 'intent', actionTick: 2 },
    );
    assert.equal(knowledgeRequestFact.status, 'completed', knowledgeRequestFact.result);
    state.world.past.push(knowledgeRequestFact);
    recordProjectAction(state, project.id, knowledgeRequestFact);
    const knowledgeRequest = project.knowledgeRequests.at(-1);
    assert.equal(knowledgeRequest?.requesterId, successor.id);
    assert.equal(
      projectKnowledgeRequestHasAuthoritativeSource(state, project, knowledgeRequest),
      true,
      'mechanical unknown-component request is authenticated against the event-time lead',
    );
    const knowledgeResponseFact = executePrimitiveAction(
      state,
      teacher,
      {
        kind: 'communicate',
        content: {
          id: `teach:${teachingTechniqueId}:${successor.id}`,
          kind: 'claim',
          summary: '示范当前缺失构件的制造办法',
          factId: teachingTechniqueId,
          projectKnowledgeResponse: {
            version: 'project-knowledge-response-v1',
            projectId: project.id,
            requestEventId: knowledgeRequest.requestEventId,
            requesterId: successor.id,
            outputMaterialId: unknownOutputMaterialId,
          },
        },
        audience: [successor.id],
        channel: 'gesture',
      },
      3,
      3,
      { cause: 'intent', actionTick: 3 },
    );
    assert.equal(knowledgeResponseFact.status, 'completed', knowledgeResponseFact.result);
    state.world.past.push(knowledgeResponseFact);
    recordProjectAction(state, project.id, knowledgeResponseFact);
    assert.equal(knowledgeRequest.responseEventId, knowledgeResponseFact.id);
    assert.equal(successor.knowledge.some((fact) => (
      fact.id === teachingTechniqueId && fact.confidence >= 55
    )), true, 'the successor learns through its own explicit request, not founder hidden knowledge');
    network.components.splice(converterIndex, 0, temporarilyMissingConverter);
    setVoxel(
      state.world.grid,
      temporarilyMissingConverter.position.x,
      temporarilyMissingConverter.position.y,
      temporarilyMissingConverter.position.z,
      temporarilyMissingConverter.materialId,
    );

    successor.inventory.push(
      { id: 'successor-seed', materialId: Material.Seed, quantity: 2, sourceEventIds: ['seed-source'] },
      { id: 'successor-tool', materialId: Material.BronzeTool, quantity: 1, sourceEventIds: ['tool-source'] },
    );
    state.clock.elapsedMonths = 3;
    let action = recompileProjectNextAction(state, successor, project.id);
    assert.equal(action, null, 'a frozen current leaves the succeeded project in an explicit bounded wait');
    assert.equal(project.status, 'active');
    setVoxel(state.world.grid, source.from.x, source.from.y, source.from.z, Material.Water);
    action = recompileProjectNextAction(state, successor, project.id);
    assert.equal(action?.kind, 'attend', 'installed components survive, but successor must first re-observe the live current');
    assert.equal(action?.waterCurrentSegmentId, source.id);
    const successorObservation = executePrimitiveAction(
      state,
      successor,
      action,
      4,
      1,
      { cause: 'intent', actionTick: 1, intentId: 'successor-mechanical' },
    );
    assert.equal(successorObservation.status, 'completed', successorObservation.result);
    state.world.past.push(successorObservation);
    recordProjectAction(state, project.id, successorObservation);
    assert.ok(project.triggerFactIds.includes(successorObservation.id));

    state.clock.elapsedMonths = 4;
    let executionOrder = 2;
    let fault;
    for (let attempt = 0; attempt < 12 && !fault; attempt += 1) {
      action = recompileProjectNextAction(state, successor, project.id);
      assert.ok(action, 'successor must be able to continue from preserved physical components');
      const fact = executePrimitiveAction(
        state,
        successor,
        action,
        4,
        executionOrder++,
        { cause: 'intent', actionTick: executionOrder, intentId: 'successor-mechanical' },
      );
      assert.notEqual(fact.status, 'blocked', fact.result);
      state.world.past.push(fact);
      recordProjectAction(state, project.id, fact);
      if (fact.diff.mechanicalPowerFault === true) fault = fact;
    }
    assert.equal(fault?.status, 'progressed', 'the successor personally performs the commissioning attempt');
    assert.equal(fault?.who, successor.id);

    const replacementManufacture = actionFact(
      successor,
      'successor-replacement-manufacture',
      5,
      1,
      { kind: 'act', operation: 'combine', targets: [] },
      'completed',
      { outputMaterialId: Material.DriveShaft, outputStackId: 'successor-replacement-shaft' },
    );
    const replacementVerification = actionFact(
      successor,
      'successor-replacement-verify',
      5,
      2,
      {
        kind: 'attend',
        target: { kind: 'inventory-stack', personId: successor.id, stackId: 'successor-replacement-shaft' },
      },
      'completed',
      {
        verifiedSourceEventId: replacementManufacture.id,
        verifiedStackId: 'successor-replacement-shaft',
        verifiedMaterialId: Material.DriveShaft,
      },
    );
    state.world.past.push(replacementManufacture, replacementVerification);
    project.actionEventIds.push(replacementManufacture.id, replacementVerification.id);
    successor.inventory.push({
      id: 'successor-replacement-shaft',
      materialId: Material.DriveShaft,
      quantity: 1,
      sourceEventIds: [replacementManufacture.id],
    });

    state.clock.elapsedMonths = 5;
    let repair;
    executionOrder = 3;
    for (let attempt = 0; attempt < 12 && !repair; attempt += 1) {
      action = recompileProjectNextAction(state, successor, project.id);
      assert.ok(action, 'successor must compile repair from own post-fault manufacture and verification');
      const fact = executePrimitiveAction(
        state,
        successor,
        action,
        6,
        executionOrder++,
        { cause: 'intent', actionTick: executionOrder, intentId: 'successor-mechanical' },
      );
      assert.notEqual(fact.status, 'blocked', fact.result);
      state.world.past.push(fact);
      recordProjectAction(state, project.id, fact);
      if (fact.diff.mechanicalPowerRepair === true) repair = fact;
    }
    assert.equal(repair?.status, 'completed');
    assert.equal(repair?.who, successor.id);

    state.clock.elapsedMonths = 6;
    let operation;
    executionOrder = 1;
    for (let attempt = 0; attempt < 12 && !operation; attempt += 1) {
      action = recompileProjectNextAction(state, successor, project.id);
      assert.ok(action, 'successor must compile the post-repair loaded operation');
      const fact = executePrimitiveAction(
        state,
        successor,
        action,
        7,
        executionOrder++,
        { cause: 'intent', actionTick: executionOrder, intentId: 'successor-mechanical' },
      );
      assert.notEqual(fact.status, 'blocked', fact.result);
      state.world.past.push(fact);
      recordProjectAction(state, project.id, fact);
      if (fact.diff.mechanicalPowerOperation === true) operation = fact;
    }
    assert.equal(operation?.status, 'completed');
    assert.equal(operation?.who, successor.id);
    const evidence = mechanicalPowerCompletionEvidence(state, project);
    assert.ok(founderInstallationFacts.every((fact) => evidence.includes(fact.id)),
      'valid founder-era installed component receipts survive the transition');
    assert.ok(evidence.includes(fault.id) && evidence.includes(repair.id) && evidence.includes(operation.id),
      'post-transition fault, repair and loaded operation must all belong to the successor era');
    synchronizeProject(state, project, 7);
    assert.equal(project.status, 'completed');
    assert.equal(project.ownerId, founder.id);

    const mismatched = structuredClone(state);
    const mismatchedProject = mismatched.projects.find((candidate) => candidate.id === project.id);
    mismatchedProject.status = 'active';
    mismatchedProject.completedAtMonth = undefined;
    mismatchedProject.completionEventIds = [];
    const mismatchedVerification = mismatched.world.past.find((event) => event.id === 'founder-verify-connector');
    mismatchedVerification.who = successor.id;
    assert.deepEqual(mechanicalPowerCompletionEvidence(mismatched, mismatchedProject), [],
      'a component whose manufacture, verification and installation actors differ is never valid provenance');
    assert.equal(project.leadershipTransitions.at(-1).contributionEventId, contribution.id);
  }

  process.stdout.write('project leadership succession tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
