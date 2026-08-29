import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-mechanical-site-conflict-'));
const bundlePath = path.join(temporaryDirectory, 'mechanical-site-conflict.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export { appendProjectLeadershipVacancy, projectCurrentLeadId } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project-leadership.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { ensureMechanicalPowerNetwork, mechanicalPowerNetworkId, mechanicalPowerPlanKey, recordMechanicalPowerInstallation } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/mechanical-power.ts'))};
    export { mechanicalPowerProjectStep } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/mechanical-power-options.ts'))};
    export { recordProjectAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
    export { cellId, cellsInRadius, setVoxel, voxelAt } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=mechanical-site-conflict-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    appendProjectLeadershipVacancy,
    cellId,
    createInitialState,
    ensureMechanicalPowerNetwork,
    executePrimitiveAction,
    instantiateProject,
    mechanicalPowerNetworkId,
    mechanicalPowerPlanKey,
    mechanicalPowerProjectStep,
    projectCurrentLeadId,
    recordMechanicalPowerInstallation,
    recordProjectAction,
    setVoxel,
    voxelAt,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  function actionFact({ id, actor, action, diff, order, atMonth = 2 }) {
    return {
      id,
      kind: 'action',
      actionTick: order,
      atMonth,
      orderInMonth: order,
      cellId: actor.position.cellId,
      who: actor.id,
      cause: 'project',
      action,
      fromCellId: actor.position.cellId,
      toCellId: actor.position.cellId,
      fromZ: actor.position.z,
      toZ: actor.position.z,
      pathSegment: [actor.position.cellId],
      status: 'completed',
      result: '夹具中的真实项目构件事实',
      diff,
    };
  }

  function createFixture(label) {
    const state = createInitialState(20_260_815, {
      endpoint: { kind: 'months', value: 48 },
      chaosIntensity: 0,
    });
    state.clock.elapsedMonths = 2;
    state.world.past = [];
    state.lastStep = [];
    state.projects = [];
    const actor = state.people[0];
    for (const other of state.people.slice(1)) other.diedAtMonth = 0;
    actor.bornAtMonth = -20 * 12;
    actor.conditions = [];
    actor.body = { health: 100, hydration: 100, nutrition: 100 };
    actor.inventory = [];
    actor.knowledge = [];
    actor.memories = [];
    actor.knownPlaces = [];

    const source = state.world.mechanicalPower.sources.find((candidate) => (
      candidate.from.y === 12 && candidate.id.endsWith(':0')
    ));
    assert.ok(source, '夹具需要一段远离边界的真实水流');
    const wheel = { x: source.from.x, y: source.from.y, z: source.from.z + 1 };
    const shaft = { x: wheel.x - 1, y: wheel.y, z: wheel.z };
    const load = { x: wheel.x - 2, y: wheel.y, z: wheel.z };

    // Keep a small locally visible work floor around both the old and at least
    // one alternative axis. Restore generated current water after preparing it.
    for (let x = wheel.x - 4; x <= wheel.x + 4; x += 1) {
      for (let y = wheel.y - 3; y <= wheel.y + 3; y += 1) {
        if (x < 0 || x >= state.world.grid.width || y < 0 || y >= state.world.grid.depth) continue;
        setVoxel(state.world.grid, x, y, wheel.z - 1, Material.Stone);
        setVoxel(state.world.grid, x, y, wheel.z, Material.Air);
        setVoxel(state.world.grid, x, y, wheel.z + 1, Material.Air);
      }
    }
    for (const segment of state.world.mechanicalPower.sources) {
      for (const position of segment.requiredWaterVoxels) {
        setVoxel(state.world.grid, position.x, position.y, position.z, Material.Water);
      }
    }
    actor.position.cellId = cellId(load.x, load.y - 1);
    actor.position.z = load.z;
    actor.position.previousCellId = actor.position.cellId;
    actor.position.previousZ = actor.position.z;

    const observation = executePrimitiveAction(state, actor, {
      kind: 'attend',
      target: { kind: 'voxel', position: { ...source.from } },
      waterCurrentSegmentId: source.id,
    }, 1, 1, { cause: 'intent', actionTick: 1 });
    assert.equal(observation.status, 'completed', observation.result);
    state.world.past.push(observation);

    const projectId = `project-fixture-mechanical-site-conflict-${label}`;
    const plan = {
      version: 'mechanical-power-plan-v1',
      projectId,
      sourceSegmentId: source.id,
      wheelPosition: wheel,
      shaftPositions: [shaft],
      loadPosition: load,
      sourceKeys: [...source.sourceKeys],
    };
    const project = instantiateProject({
      id: projectId,
      kind: 'production',
      need: 'mechanical-power-capability',
      desiredFunction: 'water-powered-crop-processing',
      summary: '从真实安装冲突中改址的机械动力项目',
      ownerId: actor.id,
      beneficiaryIds: [actor.id],
      triggerFactIds: [observation.id],
      pressure: 60,
      createdAtMonth: 1,
      reviewAtMonth: 40,
      site: { cellId: actor.position.cellId, z: actor.position.z },
      mechanicalPowerPlan: structuredClone(plan),
      mechanicalPowerPlanKey: mechanicalPowerPlanKey(plan),
      mechanicalPowerNetworkId: mechanicalPowerNetworkId(plan),
    });
    state.projects.push(project);

    const stackId = `fixture-mill-${label}`;
    const manufacture = actionFact({
      id: `fixture-manufacture-${label}`,
      actor,
      action: { kind: 'act', operation: 'combine', targets: [] },
      diff: { outputMaterialId: Material.Mill, outputStackId: stackId },
      order: 1,
    });
    const verification = actionFact({
      id: `fixture-verification-${label}`,
      actor,
      action: {
        kind: 'attend',
        target: { kind: 'inventory-stack', personId: actor.id, stackId },
      },
      diff: {
        verifiedSourceEventId: manufacture.id,
        verifiedStackId: stackId,
        verifiedMaterialId: Material.Mill,
      },
      order: 2,
    });
    state.world.past.push(manufacture, verification);
    project.actionEventIds.push(manufacture.id, verification.id);
    actor.inventory.push({
      id: stackId,
      materialId: Material.Mill,
      quantity: 1,
      sourceEventIds: [manufacture.id],
    });
    setVoxel(state.world.grid, load.x, load.y, load.z, Material.Workshop);
    return { state, actor, project, plan, source, stackId, observation, label };
  }

  function commitProjectAction(fixture, action, month, order) {
    const fact = executePrimitiveAction(
      fixture.state,
      fixture.actor,
      action,
      month,
      order,
      { cause: 'project', projectId: fixture.project.id, actionTick: order },
    );
    fixture.state.world.past.push(fact);
    recordProjectAction(fixture.state, fixture.project.id, fact);
    return fact;
  }

  function commitInitialConflict(fixture) {
    const step = mechanicalPowerProjectStep(fixture.state, fixture.actor, fixture.project);
    assert.equal(step?.action.kind, 'act');
    assert.equal(step?.action.mechanicalPowerBasis?.mode, 'install');
    assert.equal(step?.action.mechanicalPowerBasis?.planKey, mechanicalPowerPlanKey(fixture.plan));
    const fact = commitProjectAction(fixture, step.action, 3, 1);
    assert.equal(fact.status, 'blocked');
    assert.equal(fact.diff.mechanicalPowerSiteConflict, true);
    assert.equal(fact.diff.projectId, fixture.project.id);
    assert.equal(fact.diff.planKey, mechanicalPowerPlanKey(fixture.plan));
    assert.equal(fact.diff.componentRole, 'load');
    assert.deepEqual(fact.diff.componentPosition, fixture.plan.loadPosition);
    assert.equal(fact.diff.observedMaterialId, Material.Workshop);
    assert.deepEqual(fact.diff.conflictSourceEventIds, [
      `fixture-manufacture-${fixture.label}`,
      `fixture-verification-${fixture.label}`,
      fixture.observation.id,
    ]);
    assert.equal(fixture.project.status, 'active', `冲突后项目不应直接终结：${fixture.project.blockedReason ?? ''}`);
    return fact;
  }

  // Main causal counterexample: a legal workshop occupies the frozen load
  // position after the component was made. The failed install becomes exact
  // evidence, then one explicit revision keeps the component and same project.
  {
    const fixture = createFixture('revises');
    const originalPlanKey = mechanicalPowerPlanKey(fixture.plan);
    const conflict = commitInitialConflict(fixture);
    let revisionFact;
    for (let order = 2; order <= 6 && !revisionFact; order += 1) {
      const step = mechanicalPowerProjectStep(fixture.state, fixture.actor, fixture.project);
      assert.ok(step, '局部存在合法替代工地时必须形成改址步骤');
      if (step.action.kind === 'act') {
        assert.equal(step.action.mechanicalPowerBasis?.mode, 'revise-site',
          '冲突后不得再次生成原位置安装动作');
        assert.equal(step.action.mechanicalPowerBasis.planKey, originalPlanKey);
      }
      const fact = commitProjectAction(fixture, step.action, 3, order);
      assert.notEqual(fact.status, 'blocked', fact.result);
      if (fact.diff.mechanicalPowerPlanRevision === true) revisionFact = fact;
    }
    assert.ok(revisionFact, '改址必须由一条可审计的权威动作完成');
    assert.equal(revisionFact.diff.conflictEventId, conflict.id);
    assert.equal(revisionFact.diff.priorPlanKey, originalPlanKey);
    assert.notEqual(fixture.project.mechanicalPowerPlanKey, originalPlanKey);
    assert.equal(fixture.project.mechanicalPowerPlan.projectId, fixture.project.id);
    assert.equal(fixture.project.actionEventIds.includes(conflict.id), true);
    const preserved = fixture.actor.inventory.find((stack) => stack.id === fixture.stackId);
    assert.ok(preserved && preserved.quantity === 1
      && preserved.sourceEventIds.includes(`fixture-manufacture-revises`),
    '同一项目已制造并核验的负载构件必须在改址后保留');
    assert.equal(voxelAt(
      fixture.state.world.grid,
      fixture.plan.loadPosition.x,
      fixture.plan.loadPosition.y,
      fixture.plan.loadPosition.z,
    ), Material.Workshop, '改址不能覆盖造成冲突的真实设施');

    let installedFact;
    for (let order = 7; order <= 12 && !installedFact; order += 1) {
      const step = mechanicalPowerProjectStep(fixture.state, fixture.actor, fixture.project);
      assert.ok(step, '改址后必须继续同一项目的普通安装链');
      if (step.action.kind === 'act') {
        assert.equal(step.action.mechanicalPowerBasis?.mode, 'install');
        assert.notEqual(step.action.mechanicalPowerBasis.planKey, originalPlanKey,
          '旧冲突位置不得出现 exact retry');
      }
      const fact = commitProjectAction(fixture, step.action, 3, order);
      assert.notEqual(fact.status, 'blocked', fact.result);
      if (fact.diff.mechanicalPowerInstallation === true) installedFact = fact;
    }
    assert.ok(installedFact, '保留的真实负载构件必须能安装到显式修订后的工地');
    assert.equal(installedFact.diff.componentRole, 'load');
  }

  // Once any component is physically installed, changing all geometry would
  // detach it from its immutable network receipt. Preserve the conflict and
  // stop instead of silently rewriting a partial installation.
  {
    const fixture = createFixture('partial');
    const network = ensureMechanicalPowerNetwork(fixture.state.world.mechanicalPower, fixture.plan);
    const shaft = fixture.plan.shaftPositions[0];
    setVoxel(fixture.state.world.grid, shaft.x, shaft.y, shaft.z, Material.DriveShaft);
    recordMechanicalPowerInstallation(network, {
      role: 'connector',
      materialId: Material.DriveShaft,
      position: { ...shaft },
      projectId: fixture.project.id,
      installedAtMonth: 2,
      installationEventId: 'fixture-preinstalled-shaft',
      sourceEventIds: ['fixture-preinstalled-shaft-source'],
    });
    const conflict = commitInitialConflict(fixture);
    assert.equal(mechanicalPowerProjectStep(fixture.state, fixture.actor, fixture.project), null,
      '部分安装后不得静默改写整条网络几何');
    assert.equal(fixture.project.mechanicalPowerPlanKey, mechanicalPowerPlanKey(fixture.plan));
    assert.ok(fixture.project.actionEventIds.includes(conflict.id));
  }

  // A real conflict belongs to the lead who encountered it at that event's
  // coordinate. A later legitimate lead may learn from it, but only after the
  // successor personally re-observes the current and works at the old site.
  {
    const fixture = createFixture('succession');
    const founder = fixture.actor;
    const successor = fixture.state.people[1];
    const nonLeader = fixture.state.people[2];
    for (const person of [successor, nonLeader]) {
      person.diedAtMonth = undefined;
      person.bornAtMonth = -20 * 12;
      person.conditions = [];
      person.body = { health: 100, hydration: 100, nutrition: 100 };
      person.inventory = [];
      person.knowledge = [];
      person.memories = [];
      person.knownPlaces = [];
      person.position = structuredClone(founder.position);
    }
    const conflict = commitInitialConflict(fixture);
    const contribution = actionFact({
      id: 'fixture-successor-prior-contribution',
      actor: successor,
      action: { kind: 'act', operation: 'combine', targets: [] },
      diff: { projectContribution: true },
      order: 2,
      atMonth: 3,
    });
    fixture.state.world.past.push(contribution);
    fixture.project.actionEventIds.push(contribution.id);
    fixture.project.contributorIds.push(successor.id);
    fixture.project.progressEvidence.push({
      eventId: contribution.id,
      atMonth: contribution.atMonth,
      kind: 'action-progress',
      actorId: successor.id,
      target: { ...fixture.project.site },
    });
    const death = {
      id: 'fixture-mechanical-founder-death',
      kind: 'environment',
      change: 'death',
      who: founder.id,
      atMonth: 4,
      orderInMonth: 1,
      cellId: founder.position.cellId,
      result: '原负责人在真实冲突后死亡',
      diff: { personId: founder.id, cause: 'fixture' },
    };
    fixture.state.world.past.push(death);
    founder.diedAtMonth = 4;
    founder.body.health = 0;
    const vacancy = appendProjectLeadershipVacancy(fixture.project, death);
    assert.ok(vacancy);
    const successionBasis = {
      version: 'project-leadership-v1',
      projectId: fixture.project.id,
      predecessorId: founder.id,
      successorId: successor.id,
      vacancyTransitionId: vacancy.id,
      deathEventId: death.id,
      deathKnowledgeSourceEventIds: [death.id],
      contributionEventId: contribution.id,
      site: { ...fixture.project.site },
      sourceFactIds: [death.id, contribution.id],
    };
    const successionFact = actionFact({
      id: 'fixture-mechanical-successor-inspection',
      actor: successor,
      action: {
        kind: 'attend',
        target: {
          kind: 'voxel',
          position: {
            x: fixture.project.site.cellId % fixture.state.world.grid.width,
            y: Math.floor(fixture.project.site.cellId / fixture.state.world.grid.width),
            z: Math.max(0, fixture.project.site.z - 1),
          },
        },
        projectLeadershipSuccession: successionBasis,
      },
      diff: {
        projectLeadershipSuccession: true,
        projectLeadershipProjectId: fixture.project.id,
        projectLeadershipVacancyTransitionId: vacancy.id,
      },
      order: 2,
      atMonth: 4,
    });
    fixture.state.world.past.push(successionFact);
    recordProjectAction(fixture.state, fixture.project.id, successionFact);
    assert.equal(projectCurrentLeadId(fixture.project), successor.id);
    assert.equal(fixture.project.ownerId, founder.id, '发起人身份保持不可变，当前领导权来自 succession');
    assert.equal(mechanicalPowerProjectStep(
      fixture.state, nonLeader, fixture.project,
    ), null, '非当前负责人不能利用旧冲突改址');

    const beforeObservation = mechanicalPowerProjectStep(
      fixture.state, successor, fixture.project,
    );
    assert.equal(beforeObservation?.action.kind, 'attend');
    assert.equal(beforeObservation?.action.waterCurrentSegmentId, fixture.source.id,
      '继任者没有本人现场观察时只能先观察，不能直接消费旧负责人私人知识');
    const successorObservation = executePrimitiveAction(
      fixture.state,
      successor,
      beforeObservation.action,
      5,
      1,
      { cause: 'project', projectId: fixture.project.id, actionTick: 1 },
    );
    assert.equal(successorObservation.status, 'completed', successorObservation.result);
    fixture.state.world.past.push(successorObservation);
    recordProjectAction(fixture.state, fixture.project.id, successorObservation);
    assert.ok(fixture.project.triggerFactIds.includes(successorObservation.id));

    const revisionStep = mechanicalPowerProjectStep(fixture.state, successor, fixture.project);
    assert.equal(revisionStep?.action.kind, 'act');
    assert.equal(revisionStep?.action.mechanicalPowerBasis?.mode, 'revise-site');
    const originalSite = structuredClone(fixture.project.site);
    const revision = executePrimitiveAction(
      fixture.state,
      successor,
      revisionStep.action,
      5,
      2,
      { cause: 'project', projectId: fixture.project.id, actionTick: 2 },
    );
    assert.equal(revision.status, 'completed', revision.result);
    assert.equal(revision.who, successor.id);
    assert.equal(revision.diff.conflictEventId, conflict.id);
    fixture.state.world.past.push(revision);
    recordProjectAction(fixture.state, fixture.project.id, revision);
    assert.equal(projectCurrentLeadId(fixture.project), successor.id,
      '改址不能破坏既有合法 succession 账本');
    assert.deepEqual(fixture.project.site, originalSite,
      '项目公共工地身份保持冻结；新安装工位由 revision diff 单独审计');
  }

  // If every locally visible current-adjacent site is physically occupied,
  // the source-bound failure remains but no fabricated/global alternative is
  // offered and the exact install is not retried.
  {
    const fixture = createFixture('no-alternative');
    const conflict = commitInitialConflict(fixture);
    for (const water of fixture.source.requiredWaterVoxels) {
      const wheel = { x: water.x, y: water.y, z: water.z + 1 };
      setVoxel(fixture.state.world.grid, wheel.x, wheel.y, wheel.z, Material.Workshop);
    }
    assert.equal(mechanicalPowerProjectStep(fixture.state, fixture.actor, fixture.project), null,
      '没有局部合法候选时必须停止精确重试');
    assert.ok(fixture.project.actionEventIds.includes(conflict.id));
    assert.equal(fixture.project.mechanicalPowerPlanKey, mechanicalPowerPlanKey(fixture.plan));
  }

  console.log('mechanical site conflict revision fixture passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
