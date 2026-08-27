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
    export { executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { actionOptionSemantics } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-option-semantics.ts'))};
    export { ensureMechanicalPowerNetwork, mechanicalPowerNetworkId, mechanicalPowerPlanKey, recordMechanicalPowerInstallation } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/mechanical-power.ts'))};
    export { projectCurrentLeadId, projectLeadershipVacancy, PROJECT_LEADERSHIP_VACANCY_MONTHS } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project-leadership.ts'))};
    export { projectsLedBy } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/state-index.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { cellId, cellX, cellY, setVoxel } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=project-leadership-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    PROJECT_LEADERSHIP_VACANCY_MONTHS,
    actionOptionSemantics,
    buildProjectOptions,
    cellId,
    cellX,
    cellY,
    createInitialState,
    ensureMechanicalPowerNetwork,
    executePrimitiveAction,
    instantiateProject,
    mechanicalPowerCompletionEvidence,
    mechanicalPowerNetworkId,
    mechanicalPowerPlanKey,
    projectCurrentLeadId,
    projectLeadershipVacancy,
    projectsLedBy,
    recordMechanicalPowerInstallation,
    recordProjectAction,
    recompileProjectNextAction,
    setVoxel,
    synchronizeProject,
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
    state.people = [founder, successor];
    resetPerson(founder);
    resetPerson(successor);

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
    for (const person of [founder, successor]) {
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
