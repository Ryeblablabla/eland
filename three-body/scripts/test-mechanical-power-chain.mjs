import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-mechanical-power-chain-'));
const bundlePath = path.join(temporaryDirectory, 'mechanical-power-chain.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { pendingProjectKnowledgeOutput } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project-knowledge-request.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { inventoryCombinationForOutput, inventoryCombinationTechniqueId } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/interaction-rules.ts'))};
    export { MECHANICAL_POWER_OPERATION_TECHNIQUE_ID, MECHANICAL_POWER_WORN_FAULT_THRESHOLD, mechanicalPowerNetworkId, mechanicalPowerPlanKey } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/mechanical-power.ts'))};
    export { buildProjectPressureBasis } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-pressure.ts'))};
    export { projectFunctionSatisfied, recordProjectAction, recompileProjectNextAction, synchronizeProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
    export { projectSupportsMaterialContribution } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-step-compiler.ts'))};
    export { buildMechanicalPowerServiceOptions, mechanicalPowerMaintenanceMaterialRequirement, mechanicalPowerMaterialRequirement, mechanicalPowerProposalCandidate } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/mechanical-power-options.ts'))};
    export { deriveProjectProposals } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-proposals.ts'))};
    export { buildDecisionContext } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/action-options.ts'))};
    export { planLocallyForTick } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/simulation/tick-planner.ts'))};
    export { executeActiveIntent, startIntent } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/simulation/intent-execution.ts'))};
    export { cellId, cellX, cellY, cellsInRadius, setVoxel, standingPositions, voxelAt } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=mechanical-power-chain-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
    MECHANICAL_POWER_WORN_FAULT_THRESHOLD,
    buildDecisionContext,
    buildMechanicalPowerServiceOptions,
    buildProjectPressureBasis,
    cellId,
    cellX,
    cellY,
    cellsInRadius,
    createInitialState,
    deriveProjectProposals,
    executePrimitiveAction,
    executeActiveIntent,
    instantiateProject,
    inventoryCombinationForOutput,
    inventoryCombinationTechniqueId,
    mechanicalPowerNetworkId,
    mechanicalPowerPlanKey,
    mechanicalPowerMaintenanceMaterialRequirement,
    mechanicalPowerMaterialRequirement,
    mechanicalPowerProposalCandidate,
    pendingProjectKnowledgeOutput,
    planLocallyForTick,
    projectFunctionSatisfied,
    projectSupportsMaterialContribution,
    recordProjectAction,
    recompileProjectNextAction,
    setVoxel,
    standingPositions,
    startIntent,
    synchronizeProject,
    voxelAt,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(20_260_820, { endpoint: { kind: 'months', value: 48 }, chaosIntensity: 0 });
  state.clock.elapsedMonths = 0;
  state.world.past = [];
  state.lastStep = [];
  state.projects = [];
  const actor = state.people[0];
  for (const other of state.people.slice(1)) other.diedAtMonth = 0;
  actor.bornAtMonth = -24 * 12;
  actor.conditions = [];
  actor.body = { health: 100, hydration: 100, nutrition: 100 };
  actor.inventory = [];
  actor.knowledge = [];
  actor.memories = [];
  actor.knownPlaces = [];

  const source = state.world.mechanicalPower.sources.find((candidate) => candidate.from.y === 12
    && candidate.id.endsWith(':0'));
  assert.ok(source, '夹具需要一段当前有效的 lane-0 水流');
  const wheel = { x: source.from.x, y: source.from.y, z: source.from.z + 1 };
  const shaft = { x: wheel.x - 1, y: wheel.y, z: wheel.z };
  const load = { x: wheel.x - 2, y: wheel.y, z: wheel.z };
  for (const position of [shaft, load, { x: shaft.x, y: shaft.y - 1, z: shaft.z }, { x: load.x - 1, y: load.y, z: load.z }]) {
    setVoxel(state.world.grid, position.x, position.y, position.z - 1, Material.Stone);
    setVoxel(state.world.grid, position.x, position.y, position.z, Material.Air);
    setVoxel(state.world.grid, position.x, position.y, position.z + 1, Material.Air);
  }
  actor.position.cellId = cellId(shaft.x, shaft.y);
  actor.position.z = shaft.z;
  actor.position.previousCellId = actor.position.cellId;
  actor.position.previousZ = actor.position.z;

  // Facility evidence belongs to the manipulated crop work target, not to the
  // side from which the worker approaches it. Put the Mill opposite the actor:
  // crop-Mill distance is one while actor-Mill distance is two.
  {
    const laborState = structuredClone(state);
    const laborActor = laborState.people.find((person) => person.id === actor.id);
    const crop = { ...load };
    const mill = { x: load.x - 1, y: load.y, z: load.z };
    setVoxel(laborState.world.grid, crop.x, crop.y, crop.z, Material.CropMature);
    setVoxel(laborState.world.grid, mill.x, mill.y, mill.z - 1, Material.Stone);
    setVoxel(laborState.world.grid, mill.x, mill.y, mill.z, Material.Mill);
    const labor = executePrimitiveAction(laborState, laborActor, {
      kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position: crop }],
    }, 0, 1, { cause: 'intent', actionTick: 1 });
    assert.equal(labor.status, 'completed');
    assert.equal(labor.diff.facilityMaterialId, Material.Mill,
      '成熟作物邻接真实磨坊时，远侧站位不能抹掉磨坊劳动事实');
    assert.equal(labor.diff.outputs.find((item) => item.materialId === Material.Food)?.quantity, 6,
      '真实磨坊接触只保留既有的两份食物增益');

    const noMillState = structuredClone(state);
    const noMillActor = noMillState.people.find((person) => person.id === actor.id);
    setVoxel(noMillState.world.grid, crop.x, crop.y, crop.z, Material.CropMature);
    setVoxel(noMillState.world.grid, mill.x, mill.y, mill.z, Material.Air);
    const manual = executePrimitiveAction(noMillState, noMillActor, {
      kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position: crop }],
    }, 0, 1, { cause: 'intent', actionTick: 1 });
    assert.equal(manual.status, 'completed');
    assert.equal(manual.diff.facilityMaterialId, undefined);
    assert.equal(manual.diff.outputs.find((item) => item.materialId === Material.Food)?.quantity, 4,
      '作物工位没有磨坊时不能产生设施证据或设施增益');
  }

  const millLabor = {
    id: 'test-own-mill-labor', kind: 'action', actionTick: 1, atMonth: 0, orderInMonth: 1,
    cellId: actor.position.cellId, who: actor.id, cause: 'intent',
    action: { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position: { x: load.x, y: load.y, z: load.z } }] },
    fromCellId: actor.position.cellId, toCellId: actor.position.cellId,
    fromZ: actor.position.z, toZ: actor.position.z, pathSegment: [actor.position.cellId],
    status: 'completed', result: '本人曾在手工磨坊处理成熟作物',
    diff: { sourceMaterialId: Material.CropMature, facilityMaterialId: Material.Mill },
  };
  state.world.past.push(millLabor);

  const observeAction = {
    kind: 'attend',
    target: { kind: 'voxel', position: { ...source.from } },
    waterCurrentSegmentId: source.id,
  };
  const observe = executePrimitiveAction(state, actor, observeAction, 0, 2, {
    cause: 'intent', actionTick: 2,
  });
  assert.equal(observe.status, 'completed');
  assert.equal(observe.diff.mechanicalPowerObservation, true);
  assert.ok(observe.diff.supportingSegmentIds.includes(source.id));
  state.world.past.push(observe);

  const visibleCells = cellsInRadius(actor.position.cellId, 8);
  const candidate = mechanicalPowerProposalCandidate(state, actor, visibleCells);
  assert.ok(candidate, '本人磨坊劳动与本人流水观察应形成可见、可达的最小冻结计划');
  assert.equal(candidate.plan.sourceSegmentId, source.id);
  assert.equal(candidate.plan.shaftPositions.length, 1, '自然计划只允许一根传动轴');
  assert.equal(candidate.plan.wheelPosition.z, source.from.z + 1);
  assert.equal(voxelAt(state.world.grid, source.from.x, source.from.y, source.from.z), Material.Water);

  const pressureBasis = buildProjectPressureBasis(state, actor, {
    need: 'mechanical-power-capability', desiredFunction: 'water-powered-crop-processing',
    beneficiaryIds: [actor.id], createdAtMonth: 1,
  }, 1, { visibleCells, visibleDrops: [], visiblePeople: [actor] });
  assert.ok(pressureBasis.pressure >= 42);
  assert.ok(pressureBasis.sourceFactIds.includes(millLabor.id));
  assert.ok(pressureBasis.sourceFactIds.includes(observe.id));

  const proposal = {
    id: candidate.plan.projectId,
    kind: 'production',
    need: 'mechanical-power-capability',
    desiredFunction: 'water-powered-crop-processing',
    summary: '把手工磨坊经验迁移为流水动力磨坊',
    ownerId: actor.id,
    beneficiaryIds: [actor.id],
    triggerFactIds: [millLabor.id, observe.id],
    pressure: pressureBasis.pressure,
    pressureBasis,
    createdAtMonth: 1,
    reviewAtMonth: 36,
    site: { cellId: cellId(candidate.plan.loadPosition.x, candidate.plan.loadPosition.y), z: candidate.plan.loadPosition.z },
    mechanicalPowerPlan: structuredClone(candidate.plan),
    mechanicalPowerPlanKey: mechanicalPowerPlanKey(candidate.plan),
    mechanicalPowerNetworkId: mechanicalPowerNetworkId(candidate.plan),
  };
  proposal.site = {
    cellId: candidate.contributionSite.cellId,
    z: candidate.contributionSite.z,
  };
  assert.equal(projectSupportsMaterialContribution(proposal), true,
    '固定机械项目必须复用精确材料贡献协议');
  assert.notDeepEqual(proposal.site, {
    cellId: cellId(candidate.plan.loadPosition.x, candidate.plan.loadPosition.y),
    z: candidate.plan.loadPosition.z,
  }, '机械项目贡献工位不能被首个 Mill 负载占据');

  // Unknown component knowledge must become a bounded, output-only social
  // request. Only an addressed reliable holder may answer through the existing
  // direct-teaching rule; recipe inputs appear only after that real teaching.
  {
    const learningState = structuredClone(state);
    const learner = learningState.people.find((person) => person.id === actor.id);
    const teacher = learningState.people[1];
    const bystander = learningState.people[2];
    for (const person of [teacher, bystander]) {
      person.diedAtMonth = undefined;
      person.conditions = [];
      person.body = { health: 100, hydration: 100, nutrition: 100 };
      person.bornAtMonth = -20 * 12;
      person.position = structuredClone(learner.position);
      person.inventory = [];
      person.knowledge = [];
    }
    learner.bornAtMonth = -20 * 12;
    learner.inventory = [
      { id: 'learning-wood', materialId: Material.Wood, quantity: 1, sourceEventIds: ['learning-wood-source'] },
      { id: 'learning-rope', materialId: Material.Rope, quantity: 1, sourceEventIds: ['learning-rope-source'] },
    ];
    learner.knowledge = [];
    const millRule = inventoryCombinationForOutput(Material.Mill);
    const woodToolRule = inventoryCombinationForOutput(Material.WoodTool);
    assert.ok(millRule && woodToolRule);
    const millTechniqueId = inventoryCombinationTechniqueId(millRule);
    const woodToolTechniqueId = inventoryCombinationTechniqueId(woodToolRule);
    teacher.knowledge = [
      {
        id: woodToolTechniqueId, kind: 'technique', summary: '已核验木制工具配方', confidence: 100,
        learnedAtMonth: 0, sourceEventIds: ['teacher-wood-tool-source'],
      },
      {
        id: millTechniqueId, kind: 'technique', summary: '已核验磨坊配方', confidence: 80,
        learnedAtMonth: 0, sourceEventIds: ['teacher-mill-source'],
      },
    ];
    const learningProject = instantiateProject(structuredClone(proposal));
    learningState.projects = [learningProject];
    learningState.clock.elapsedMonths = 1;

    const requestAction = recompileProjectNextAction(learningState, learner, learningProject.id);
    assert.equal(requestAction?.kind, 'communicate');
    assert.equal(requestAction?.content.kind, 'request');
    const request = requestAction?.content.kind === 'request'
      ? requestAction.content.projectKnowledgeRequest
      : undefined;
    assert.deepEqual(request && {
      version: request.version,
      projectId: request.projectId,
      requesterId: request.requesterId,
      outputMaterialId: request.outputMaterialId,
    }, {
      version: 'project-knowledge-request-v1',
      projectId: learningProject.id,
      requesterId: learner.id,
      outputMaterialId: Material.Mill,
    });
    assert.deepEqual(Object.keys(request ?? {}).sort(), [
      'expiresAtMonth', 'outputMaterialId', 'projectId', 'requesterId', 'version',
    ], '请求只能暴露本人已知的部件输出，不能携带 techniqueId 或配方输入');
    assert.ok(requestAction.audience.includes(teacher.id));
    assert.ok(requestAction.audience.includes(bystander.id),
      '请求面向实际可达受众，不能按隐藏 knowledge 预筛教师');
    const beforeTeachingRequirement = mechanicalPowerMaterialRequirement(
      learningState, learner, learningProject,
    );
    assert.deepEqual(beforeTeachingRequirement.materialIds, []);
    assert.equal(beforeTeachingRequirement.unknownRecipeOutputMaterialId, Material.Mill);

    const requestFact = executePrimitiveAction(learningState, learner, requestAction, 2, 1, {
      cause: 'intent', projectId: learningProject.id, actionTick: 1,
    });
    learningState.world.past.push(requestFact);
    recordProjectAction(learningState, learningProject.id, requestFact);
    assert.equal(requestFact.status, 'completed');
    assert.deepEqual(learningProject.knowledgeRequests?.[0]?.listenerIds.sort(),
      requestAction.audience.slice().sort());

    const boundedWaitState = structuredClone(learningState);
    const boundedWaitProject = boundedWaitState.projects.find((project) => project.id === learningProject.id);
    const boundedRequest = boundedWaitProject.knowledgeRequests?.[0];
    assert.ok(boundedRequest);
    boundedWaitProject.reviewAtMonth = boundedRequest.atMonth + 1;
    synchronizeProject(boundedWaitState, boundedWaitProject, boundedRequest.expiresAtMonth);
    assert.equal(boundedWaitProject.status, 'active',
      '有 completed ActionFact 来源且仍 open 的项目知识请求必须保持到 inclusive expiry 月');
    synchronizeProject(boundedWaitState, boundedWaitProject, boundedRequest.expiresAtMonth + 1);
    assert.equal(boundedWaitProject.status, 'blocked',
      '请求自然过期后必须立即恢复原 overdue lifecycle closure，不得追加新阶段窗');

    const forgedWaitState = structuredClone(learningState);
    const forgedWaitProject = forgedWaitState.projects.find((project) => project.id === learningProject.id);
    const forgedRequestBasis = forgedWaitProject.knowledgeRequests?.[0];
    assert.ok(forgedRequestBasis);
    forgedWaitProject.reviewAtMonth = forgedRequestBasis.atMonth + 1;
    forgedRequestBasis.requestEventId = 'uncommitted-forged-request';
    forgedWaitProject.actionEventIds.push(forgedRequestBasis.requestEventId);
    synchronizeProject(forgedWaitState, forgedWaitProject, forgedRequestBasis.expiresAtMonth);
    assert.equal(forgedWaitProject.status, 'blocked',
      '只有数组 basis 而没有匹配 completed request ActionFact 时不得延长项目生命周期');

    const forged = executePrimitiveAction(learningState, teacher, {
      kind: 'communicate',
      content: {
        id: `teach:forged:${teacher.id}:${woodToolTechniqueId}:${learner.id}`,
        kind: 'claim',
        summary: '用不匹配的技术冒充磨坊知识回应',
        factId: woodToolTechniqueId,
        projectKnowledgeResponse: {
          version: 'project-knowledge-response-v1',
          projectId: learningProject.id,
          requestEventId: requestFact.id,
          requesterId: learner.id,
          outputMaterialId: Material.Mill,
        },
      },
      audience: [learner.id],
      channel: 'voice',
    }, 2, 2, { cause: 'intent', projectId: learningProject.id, actionTick: 2 });
    assert.equal(forged.status, 'blocked', '不匹配请求输出的技术不能冒充项目知识回应');
    assert.equal(learner.knowledge.some((fact) => fact.id === woodToolTechniqueId), false);

    const forgedVersion = executePrimitiveAction(learningState, teacher, {
      kind: 'communicate',
      content: {
        id: `teach:forged-version:${teacher.id}:${millTechniqueId}:${learner.id}`,
        kind: 'claim',
        summary: '用未知版本冒充项目知识回应',
        factId: millTechniqueId,
        projectKnowledgeResponse: {
          version: 'project-knowledge-response-v0',
          projectId: learningProject.id,
          requestEventId: requestFact.id,
          requesterId: learner.id,
          outputMaterialId: Material.Mill,
        },
      },
      audience: [learner.id],
      channel: 'voice',
    }, 2, 3, { cause: 'intent', actionTick: 3 });
    assert.equal(forgedVersion.status, 'blocked', '未知响应版本必须在领域执行边界被拒绝');
    assert.equal(learningProject.knowledgeRequests?.[0]?.responseEventId, undefined);
    assert.equal(learner.knowledge.some((fact) => fact.id === millTechniqueId), false);

    const olderProject = structuredClone(learningProject);
    olderProject.id = `${learningProject.id}:older-unanswerable`;
    olderProject.ownerId = bystander.id;
    olderProject.beneficiaryIds = [bystander.id];
    olderProject.actionEventIds = [];
    olderProject.contributorIds = [];
    olderProject.knowledgeRequests = [{
      version: 'project-knowledge-request-v1',
      requestEventId: 'older-unanswerable-request',
      projectId: olderProject.id,
      requesterId: bystander.id,
      listenerIds: [teacher.id],
      outputMaterialId: Material.Mill,
      expiresAtMonth: 12,
      atMonth: 1,
    }];
    bystander.position = {
      cellId: bystander.position.cellId === 0 ? 1 : 0,
      z: bystander.position.z,
    };
    learningState.projects.unshift(olderProject);

    const sleepingState = structuredClone(learningState);
    sleepingState.projects = [structuredClone(olderProject)];
    sleepingState.intents = [];
    const sleepingTeacher = sleepingState.people.find((person) => person.id === teacher.id);
    delete sleepingTeacher.activeIntentId;
    let sleepingPlannerCalls = 0;
    planLocallyForTick(
      sleepingState,
      sleepingTeacher,
      2,
      2,
      [],
      { decide: () => { sleepingPlannerCalls += 1; return { kind: 'idle', reason: 'test' }; } },
      new Set([sleepingTeacher.id]),
    );
    assert.equal(sleepingPlannerCalls, 0,
      '只有不可回答请求时，不得在人物已经复核后每个 tick 重建决策');

    const teachingContext = buildDecisionContext(learningState, teacher, 2);
    const teachingOption = teachingContext.options.find((option) => (
      option.nextAction.kind === 'communicate'
        && option.nextAction.content.kind === 'claim'
        && option.nextAction.content.projectKnowledgeResponse?.requestEventId === requestFact.id
    ));
    assert.ok(teachingOption, '较老但当前不可回答的请求不能遮住可回答请求');
    assert.equal(teachingOption.projectId, undefined,
      '教师回应不能借用请求者未传达的项目压力进入认知排序');
    assert.ok(teachingOption.sourceFactIds.includes(requestFact.id));
    assert.ok(teachingOption.sourceFactIds.includes('teacher-mill-source'));
    assert.equal(teachingOption.sourceFactIds.includes(millLabor.id), false);
    assert.equal(teachingOption.sourceFactIds.includes(observe.id), false,
      '教师回应来源不能伪挂请求者私有触发事实');
    assert.equal(teachingOption.nextAction.content.factId, millTechniqueId);
    const teachingIntent = startIntent(
      learningState, teacher, teachingContext, teachingOption.id, undefined,
      'test-project-knowledge-response-decision', 2,
    );
    assert.ok(teachingIntent);
    assert.equal(teachingIntent.projectId, undefined);
    const learningProgressBefore = learningProject.lastProgressAtMonth;
    const teachingFact = executeActiveIntent(learningState, teacher, 2, 4, 4, []);
    assert.ok(teachingFact && teachingFact.kind === 'action');
    learningState.world.past.push(teachingFact);
    assert.ok(learningProject.actionEventIds.includes(teachingFact.id),
      '无 projectId 的教师 intent 必须按已验证响应 diff 自动回填 exact project');
    assert.ok(learningProject.lastProgressAtMonth > learningProgressBefore);
    const olderProgressBefore = olderProject.lastProgressAtMonth;
    recordProjectAction(learningState, olderProject.id, teachingFact);
    assert.equal(olderProject.lastProgressAtMonth, olderProgressBefore,
      '响应事实不能给不匹配的项目记知识进展');
    assert.equal(teachingFact.status, 'completed');
    assert.equal(teachingFact.diff.projectKnowledgeRequestEventId, requestFact.id);
    const learnedMill = learner.knowledge.find((fact) => fact.id === millTechniqueId);
    assert.ok(learnedMill && learnedMill.confidence >= 60);
    assert.ok(learnedMill.sourceEventIds.includes(teachingFact.id));
    const afterTeachingRequirement = mechanicalPowerMaterialRequirement(
      learningState, learner, learningProject,
    );
    assert.deepEqual(afterTeachingRequirement.materialIds.slice().sort((left, right) => left - right),
      [Material.Stone, Material.Plank].sort((left, right) => left - right));
    assert.equal(afterTeachingRequirement.planKnowledgeId, millTechniqueId);
    assert.ok(afterTeachingRequirement.sourceFactIds.includes(teachingFact.id));

    const noProgressState = structuredClone(learningState);
    const noProgressProject = instantiateProject(structuredClone(proposal));
    noProgressState.projects = [noProgressProject];
    synchronizeProject(noProgressState, noProgressProject, noProgressProject.reviewAtMonth + 1);
    assert.equal(noProgressProject.status, 'blocked',
      '没有真实进展的项目必须保持创建时原有的有界复核终点');

    const ordinaryProgressState = structuredClone(learningState);
    const ordinaryProgressProject = instantiateProject(structuredClone(proposal));
    ordinaryProgressState.projects = [ordinaryProgressProject];
    const ordinaryProgressAtMonth = ordinaryProgressProject.reviewAtMonth - 3;
    ordinaryProgressProject.lastProgressAtMonth = ordinaryProgressAtMonth;
    ordinaryProgressProject.progressEvidence = [{
      eventId: 'ordinary-material-progress',
      atMonth: ordinaryProgressAtMonth,
      kind: 'material-contribution',
      actorId: ordinaryProgressProject.ownerId,
    }];
    synchronizeProject(
      ordinaryProgressState,
      ordinaryProgressProject,
      ordinaryProgressProject.reviewAtMonth + 1,
    );
    assert.equal(ordinaryProgressProject.status, 'blocked',
      '普通 material/logistics 进展只能使用原有四月 stale grace，不能重置完整项目窗口');

    const progressBoundedState = structuredClone(learningState);
    const progressBoundedProject = progressBoundedState.projects
      .find((project) => project.id === learningProject.id);
    const reviewWindowMonths = progressBoundedProject.reviewAtMonth - progressBoundedProject.createdAtMonth;
    assert.equal(progressBoundedProject.lastProgressAtMonth, teachingFact.atMonth,
      'exact teaching response 必须先成为权威 project progress，才有资格成为复核锚点');
    synchronizeProject(
      progressBoundedState,
      progressBoundedProject,
      progressBoundedProject.lastProgressAtMonth + reviewWindowMonths,
    );
    assert.equal(progressBoundedProject.status, 'active',
      '改变 owner 可编译计划基础的 exact response 才能开启完整固定阶段窗');
    synchronizeProject(
      progressBoundedState,
      progressBoundedProject,
      progressBoundedProject.lastProgressAtMonth + reviewWindowMonths + 1,
    );
    assert.equal(progressBoundedProject.status, 'blocked',
      '没有再次改变计划基础或提交近期进展时，项目必须在固定阶段窗后的第一个月自然关闭');
    assert.match(progressBoundedProject.blockedReason, /取得新的项目计划基础/,
      '生命周期不能把未被选择的合法 affordance 错写为世界中没有可执行步骤');

    const noRuleInputState = structuredClone(learningState);
    const noRuleInputProject = noRuleInputState.projects.find((project) => project.id === learningProject.id);
    assert.equal(inventoryCombinationForOutput(Material.Stone), undefined,
      '反例输入必须确实没有隐藏的 inventory 制作规则');
    assert.equal(pendingProjectKnowledgeOutput(noRuleInputState, noRuleInputProject), Material.Stone,
      '本人从已知磨坊技术中能命名且缺失的自然输入，也可以提出一次如何取得的询问');
    for (const person of noRuleInputState.people) {
      if (person.id !== learner.id) person.knowledge = [];
    }
    assert.equal(pendingProjectKnowledgeOutput(noRuleInputState, noRuleInputProject), Material.Stone,
      '是否产生询问不能随可见教师知识或隐藏可制造性而改变');
  }

  // A visible holder may contribute only the exact current deficit to the
  // frozen, standable project site. The owner still has to manufacture,
  // verify and install every component through the ordinary mechanical chain.
  {
    const sharedState = structuredClone(state);
    const sharedOwner = sharedState.people.find((person) => person.id === actor.id);
    const sharedHolder = sharedState.people.find((person) => person.id !== actor.id);
    sharedHolder.diedAtMonth = undefined;
    sharedHolder.conditions = [];
    sharedHolder.body = { health: 100, hydration: 100, nutrition: 100 };
    sharedHolder.position = structuredClone(sharedOwner.position);
    sharedOwner.inventory = [
      { id: 'shared-stone', materialId: Material.Stone, quantity: 1, sourceEventIds: ['shared-stone-source'] },
      { id: 'shared-plank', materialId: Material.Plank, quantity: 2, sourceEventIds: ['shared-plank-source'] },
      { id: 'shared-copper', materialId: Material.Copper, quantity: 1, sourceEventIds: ['shared-copper-source'] },
    ];
    sharedHolder.inventory = [
      { id: 'shared-tin', materialId: Material.Tin, quantity: 2, sourceEventIds: ['shared-tin-source'] },
    ];
    sharedOwner.knowledge = [...sharedOwner.knowledge, ...[Material.Mill, Material.DriveShaft, Material.Bronze]
      .map((materialId) => {
        const rule = inventoryCombinationForOutput(materialId);
        assert.ok(rule);
        const techniqueId = inventoryCombinationTechniqueId(rule);
        return {
          id: techniqueId, kind: 'technique', summary: `已核验${materialId}配方`, confidence: 100,
          learnedAtMonth: 0, sourceEventIds: [`shared-known:${techniqueId}`],
        };
      })];
    const sharedProject = instantiateProject(structuredClone(proposal));
    sharedState.projects = [sharedProject];
    sharedState.clock.elapsedMonths = 1;
    let sharedOrder = 0;
    const commitShared = (person, action) => {
      sharedOrder += 1;
      const fact = executePrimitiveAction(sharedState, person, action, 2, sharedOrder, {
        cause: 'project', projectId: sharedProject.id, actionTick: sharedOrder,
      });
      sharedState.world.past.push(fact);
      recordProjectAction(sharedState, sharedProject.id, fact);
      assert.notEqual(fact.status, 'blocked', fact.result);
      return fact;
    };
    let loadInstalled = false;
    for (let step = 0; step < 12 && !loadInstalled; step += 1) {
      const action = recompileProjectNextAction(sharedState, sharedOwner, sharedProject.id);
      assert.ok(action, `协作夹具的负载安装第${step + 1}步必须可编译`);
      const fact = commitShared(sharedOwner, action);
      loadInstalled = fact.diff.mechanicalPowerInstallation === true
        && fact.diff.componentMaterialId === Material.Mill;
    }
    assert.equal(loadInstalled, true, '提出材料请求前必须先真实制造、核验并安装负载');
    const bronzeRule = inventoryCombinationForOutput(Material.Bronze);
    assert.ok(bronzeRule);
    const bronzeKnowledgeId = inventoryCombinationTechniqueId(bronzeRule);
    const currentRequirement = mechanicalPowerMaterialRequirement(
      sharedState, sharedOwner, sharedProject,
    );
    assert.deepEqual(currentRequirement.materialIds, [Material.Tin]);
    assert.equal(currentRequirement.planKnowledgeId, bronzeKnowledgeId,
      '传动轴缺青铜且本人可靠掌握青铜配方时，当前需求身份必须跟随真实中间料计划');
    assert.ok(currentRequirement.sourceFactIds.includes(`shared-known:${bronzeKnowledgeId}`));
    const noBronzeKnowledgeState = structuredClone(sharedState);
    const noBronzeKnowledgeOwner = noBronzeKnowledgeState.people.find((person) => person.id === actor.id);
    noBronzeKnowledgeOwner.knowledge = noBronzeKnowledgeOwner.knowledge
      .filter((fact) => fact.id !== bronzeKnowledgeId);
    const opaqueBronze = mechanicalPowerMaterialRequirement(
      noBronzeKnowledgeState,
      noBronzeKnowledgeOwner,
      noBronzeKnowledgeState.projects[0],
    );
    assert.ok(!opaqueBronze.materialIds.includes(Material.Bronze),
      '本人能从已知传动轴配方命名青铜但不掌握其配方时，不应把青铜当作自然材料搜索');
    assert.ok(!opaqueBronze.materialIds.includes(Material.Tin),
      '本人不可靠掌握青铜配方时不得泄漏铜锡中间料');
    assert.equal(opaqueBronze.unknownRecipeOutputMaterialId, Material.Bronze,
      '一层中间料知识缺口只能暴露本人已知传动轴配方中的青铜输出身份');
    const bronzeKnowledgeRequest = recompileProjectNextAction(
      noBronzeKnowledgeState,
      noBronzeKnowledgeOwner,
      noBronzeKnowledgeState.projects[0].id,
    );
    assert.equal(bronzeKnowledgeRequest?.kind, 'communicate');
    assert.equal(bronzeKnowledgeRequest?.content.projectKnowledgeRequest?.outputMaterialId, Material.Bronze);
    assert.deepEqual(
      Object.keys(bronzeKnowledgeRequest?.content.projectKnowledgeRequest ?? {}).sort(),
      ['expiresAtMonth', 'outputMaterialId', 'projectId', 'requesterId', 'version'],
      '青铜知识请求不能携带铜锡配方输入或 techniqueId',
    );

    const bronzeTeachingState = structuredClone(noBronzeKnowledgeState);
    const bronzeTeachingProject = bronzeTeachingState.projects[0];
    const bronzeLearner = bronzeTeachingState.people.find((person) => person.id === actor.id);
    const bronzeTeacher = bronzeTeachingState.people.find((person) => person.id === sharedHolder.id);
    bronzeLearner.inventory = bronzeLearner.inventory
      .filter((stack) => stack.materialId !== Material.Copper && stack.materialId !== Material.Tin);
    bronzeTeacher.position = structuredClone(bronzeLearner.position);
    bronzeTeacher.knowledge = [{
      id: bronzeKnowledgeId,
      kind: 'technique',
      summary: '已核验青铜配方',
      confidence: 100,
      learnedAtMonth: 0,
      sourceEventIds: ['bronze-teacher-source'],
    }];
    const forgedCopperRequest = executePrimitiveAction(bronzeTeachingState, bronzeLearner, {
      kind: 'communicate',
      content: {
        id: `request:forged-copper:${bronzeLearner.id}`,
        kind: 'request',
        summary: '越过青铜知识直接询问铜',
        projectKnowledgeRequest: {
          version: 'project-knowledge-request-v1',
          projectId: bronzeTeachingProject.id,
          requesterId: bronzeLearner.id,
          outputMaterialId: Material.Copper,
          expiresAtMonth: 14,
        },
      },
      audience: [bronzeTeacher.id],
      channel: 'voice',
    }, 2, 90, { cause: 'project', projectId: bronzeTeachingProject.id, actionTick: 90 });
    assert.equal(forgedCopperRequest.status, 'blocked',
      '领域执行边界必须拒绝越过本人青铜知识缺口的铜请求');

    const bronzeRequestAction = recompileProjectNextAction(
      bronzeTeachingState, bronzeLearner, bronzeTeachingProject.id,
    );
    assert.equal(bronzeRequestAction?.content.projectKnowledgeRequest?.outputMaterialId, Material.Bronze);
    const bronzeRequestFact = executePrimitiveAction(
      bronzeTeachingState, bronzeLearner, bronzeRequestAction, 2, 91,
      { cause: 'project', projectId: bronzeTeachingProject.id, actionTick: 91 },
    );
    bronzeTeachingState.world.past.push(bronzeRequestFact);
    recordProjectAction(bronzeTeachingState, bronzeTeachingProject.id, bronzeRequestFact);
    assert.equal(bronzeRequestFact.status, 'completed');
    const beforeBronzeTeaching = mechanicalPowerMaterialRequirement(
      bronzeTeachingState, bronzeLearner, bronzeTeachingProject,
    );
    assert.equal(beforeBronzeTeaching.unknownRecipeOutputMaterialId, Material.Bronze);
    assert.equal(beforeBronzeTeaching.materialIds.includes(Material.Copper), false);
    assert.equal(beforeBronzeTeaching.materialIds.includes(Material.Tin), false,
      '真实教导前不得出现青铜的铜锡输入');

    const bronzeTeachingContext = buildDecisionContext(bronzeTeachingState, bronzeTeacher, 2);
    const bronzeTeachingOption = bronzeTeachingContext.options.find((option) => (
      option.nextAction.kind === 'communicate'
        && option.nextAction.content.kind === 'claim'
        && option.nextAction.content.projectKnowledgeResponse?.requestEventId === bronzeRequestFact.id
    ));
    assert.ok(bronzeTeachingOption, '被请求且可靠掌握青铜技术的人必须能自然形成直接教导选项');
    assert.equal(bronzeTeachingOption.nextAction.content.factId, bronzeKnowledgeId);
    assert.ok(startIntent(
      bronzeTeachingState,
      bronzeTeacher,
      bronzeTeachingContext,
      bronzeTeachingOption.id,
      undefined,
      'test-bronze-project-knowledge-response',
      2,
    ));
    const bronzeTeachingFact = executeActiveIntent(
      bronzeTeachingState, bronzeTeacher, 2, 92, 92, [],
    );
    assert.ok(bronzeTeachingFact && bronzeTeachingFact.kind === 'action');
    bronzeTeachingState.world.past.push(bronzeTeachingFact);
    assert.equal(bronzeTeachingFact.status, 'completed');
    assert.equal(bronzeTeachingFact.diff.projectKnowledgeRequestEventId, bronzeRequestFact.id);
    const learnedBronze = bronzeLearner.knowledge.find((fact) => fact.id === bronzeKnowledgeId);
    assert.ok(learnedBronze?.sourceEventIds.includes(bronzeTeachingFact.id),
      '青铜知识来源必须经过真实响应事实');
    const afterBronzeTeaching = mechanicalPowerMaterialRequirement(
      bronzeTeachingState, bronzeLearner, bronzeTeachingProject,
    );
    assert.deepEqual(
      afterBronzeTeaching.materialIds.slice().sort((left, right) => left - right),
      [Material.Copper, Material.Tin].sort((left, right) => left - right),
      '只有真实青铜教导后，重编译才首次展开铜锡输入',
    );
    assert.equal(afterBronzeTeaching.planKnowledgeId, bronzeKnowledgeId);
    assert.ok(afterBronzeTeaching.sourceFactIds.includes(bronzeTeachingFact.id));

    const crossOperationState = structuredClone(bronzeTeachingState);
    const crossOperationProject = crossOperationState.projects[0];
    const crossOperationOwner = crossOperationState.people.find((person) => person.id === bronzeLearner.id);
    crossOperationOwner.inventory = crossOperationOwner.inventory
      .filter((stack) => stack.materialId !== Material.Tin && stack.materialId !== Material.TinCharge);
    crossOperationOwner.inventory.push({
      id: 'cross-operation-copper', materialId: Material.Copper, quantity: 1,
      sourceEventIds: ['cross-operation-copper-source'],
    });
    for (const person of crossOperationState.people) person.inventory = person.inventory
      .filter((stack) => stack.materialId !== Material.Tin && stack.materialId !== Material.TinCharge);
    crossOperationState.world.drops = crossOperationState.world.drops
      .filter((drop) => drop.materialId !== Material.Tin && drop.materialId !== Material.TinCharge);
    for (const container of crossOperationState.containers) container.inventory = container.inventory
      .filter((stack) => stack.materialId !== Material.Tin && stack.materialId !== Material.TinCharge);
    const tinExposureTechniqueId = `technique:expose:${Material.TinCharge}:${Material.Kiln}:${Material.Tin}`;
    crossOperationOwner.knowledge.push({
      id: tinExposureTechniqueId,
      kind: 'technique',
      summary: '已核验锡矿炭料在陶窑中得到锡',
      confidence: 60,
      learnedAtMonth: 1,
      sourceEventIds: ['cross-operation-tin-exposure-source'],
    });
    const kilnPosition = {
      x: cellX(crossOperationOwner.position.cellId) + 1,
      y: cellY(crossOperationOwner.position.cellId),
      z: crossOperationOwner.position.z,
    };
    setVoxel(crossOperationState.world.grid, kilnPosition.x, kilnPosition.y, kilnPosition.z - 1, Material.Stone);
    setVoxel(crossOperationState.world.grid, kilnPosition.x, kilnPosition.y, kilnPosition.z, Material.Kiln);
    crossOperationOwner.knownPlaces.push({
      id: `place:${Material.Kiln}:${kilnPosition.x}:${kilnPosition.y}:${kilnPosition.z}`,
      materialId: Material.Kiln,
      position: { ...kilnPosition },
      learnedAtMonth: 1,
      lastConfirmedAtMonth: 1,
      sourceEventIds: ['cross-operation-kiln-source'],
    });
    assert.equal(
      pendingProjectKnowledgeOutput(crossOperationState, crossOperationProject),
      Material.TinCharge,
      '本人可靠掌握 Tin exposure 且真实工位可达时，知识图必须越过 Tin 到首个未知便携输入',
    );
    const tinChargeRequest = recompileProjectNextAction(
      crossOperationState,
      crossOperationOwner,
      crossOperationProject.id,
    );
    assert.equal(tinChargeRequest?.kind, 'communicate');
    assert.equal(tinChargeRequest?.content.projectKnowledgeRequest?.outputMaterialId, Material.TinCharge);
    assert.deepEqual(
      Object.keys(tinChargeRequest?.content.projectKnowledgeRequest ?? {}).sort(),
      ['expiresAtMonth', 'outputMaterialId', 'projectId', 'requesterId', 'version'],
      '跨操作知识请求仍只能暴露本人技术已命名的 output，不能泄漏其未知配方输入',
    );
    const missingKilnState = structuredClone(crossOperationState);
    setVoxel(missingKilnState.world.grid, kilnPosition.x, kilnPosition.y, kilnPosition.z, Material.Air);
    assert.equal(
      pendingProjectKnowledgeOutput(missingKilnState, missingKilnState.projects[0]),
      undefined,
      'exposure 的真实已知工位失效后，不能继续沿该空间上不可执行的技术泄漏上游输入',
    );

    const noShaftKnowledgeState = structuredClone(sharedState);
    const noShaftKnowledgeOwner = noShaftKnowledgeState.people.find((person) => person.id === actor.id);
    const shaftRule = inventoryCombinationForOutput(Material.DriveShaft);
    assert.ok(shaftRule);
    noShaftKnowledgeOwner.knowledge = noShaftKnowledgeOwner.knowledge
      .filter((fact) => fact.id !== inventoryCombinationTechniqueId(shaftRule));
    const opaqueShaft = mechanicalPowerMaterialRequirement(
      noShaftKnowledgeState,
      noShaftKnowledgeOwner,
      noShaftKnowledgeState.projects[0],
    );
    assert.deepEqual(opaqueShaft.materialIds, [],
      '本人不可靠掌握传动轴配方时不得生成隐藏 BOM');
    assert.equal(opaqueShaft.planKnowledgeId, undefined,
      '未知配方不得伪造本人计划知识身份');
    assert.equal(opaqueShaft.unknownRecipeOutputMaterialId, Material.DriveShaft,
      '未知状态只能暴露冻结计划中本人已经能命名的下一部件');
    sharedHolder.position = {
      ...sharedHolder.position,
      cellId: sharedProject.site.cellId,
      z: sharedProject.site.z,
    };
    sharedOwner.position = {
      ...sharedOwner.position,
      ...cellsInRadius(sharedProject.site.cellId, 2)
        .flatMap((candidateCellId) => standingPositions(sharedState.world.grid, candidateCellId))
        .find((position) => position.cellId !== sharedProject.site.cellId),
    };
    sharedHolder.position = structuredClone(sharedOwner.position);
    const request = recompileProjectNextAction(sharedState, sharedOwner, sharedProject.id);
    assert.equal(request?.kind, 'communicate');
    assert.equal(request?.content.projectMaterialContribution?.materialId, Material.Tin);
    assert.equal(request?.content.projectMaterialContribution?.quantity, 1,
      '请求数量不得超过当前传动轴中间料的真实缺口');
    assert.equal(sharedProject.planKnowledgeId, bronzeKnowledgeId,
      '项目必须把当前中间料计划写回搜索与续作身份');
    const requestFact = commitShared(sharedOwner, request);
    sharedHolder.position = {
      ...sharedHolder.position,
      cellId: sharedProject.site.cellId,
      z: sharedProject.site.z,
    };
    const away = cellsInRadius(sharedProject.site.cellId, 2)
      .flatMap((candidateCellId) => standingPositions(sharedState.world.grid, candidateCellId))
      .find((position) => position.cellId !== sharedProject.site.cellId);
    assert.ok(away);
    sharedOwner.position = { ...sharedOwner.position, ...away };
    const contribution = recompileProjectNextAction(sharedState, sharedHolder, sharedProject.id);
    assert.equal(contribution?.kind, 'transfer');
    assert.equal(contribution?.authorizationRef, requestFact.id);
    assert.equal(contribution?.quantity, 1);
    assert.deepEqual(contribution?.to, {
      kind: 'ground', cellId: sharedProject.site.cellId, z: sharedProject.site.z,
    });
    const contributionFact = commitShared(sharedHolder, contribution);
    assert.ok(sharedState.world.drops.some((drop) => drop.materialId === Material.Tin
      && drop.quantity === 1
      && drop.cellId === sharedProject.site.cellId
      && drop.z === sharedProject.site.z
      && drop.sourceEventIds.includes(contributionFact.id)),
    '机械贡献必须留下可由所有者继续取得的真实工地材料');
  }

  // Unknown recipes must enter the generic bounded local hypothesis campaign;
  // the mechanical project must not rank its real BOM as a hidden answer.
  {
    const unknownState = structuredClone(state);
    const unknownActor = unknownState.people.find((person) => person.id === actor.id);
    unknownActor.inventory = [
      { id: 'unknown-stone', materialId: Material.Stone, quantity: 1, sourceEventIds: ['unknown-stone-source'] },
      { id: 'unknown-plank', materialId: Material.Plank, quantity: 3, sourceEventIds: ['unknown-plank-source'] },
      { id: 'unknown-bronze', materialId: Material.Bronze, quantity: 1, sourceEventIds: ['unknown-bronze-source'] },
      { id: 'unknown-fiber', materialId: Material.Fiber, quantity: 1, sourceEventIds: ['unknown-fiber-source'] },
    ];
    const unknownProject = instantiateProject(structuredClone(proposal));
    unknownState.projects = [unknownProject];
    const hypothesis = recompileProjectNextAction(unknownState, unknownActor, unknownProject.id);
    assert.equal(hypothesis?.kind, 'act');
    assert.equal(hypothesis?.operation, 'combine');
    assert.ok((unknownProject.hypothesisCampaign?.candidates.length ?? 0) > 0);
    assert.ok(unknownProject.hypothesisCampaign?.candidates.every((item) => (
      !item.reasonKeys.includes('project-material-focus')
    )), '未知机械配方不得得到机械专属BOM的+100答案加权');
    assert.ok((unknownProject.hypothesisCampaign?.budget ?? 0) <= 7);
  }

  // A person who reliably knows both the shaft and bronze recipes must make
  // the known intermediate alloy instead of searching for Bronze as nature.
  {
    const alloyState = structuredClone(state);
    const alloyActor = alloyState.people.find((person) => person.id === actor.id);
    const alloyProject = instantiateProject(structuredClone(proposal));
    alloyState.projects = [alloyProject];
    alloyState.clock.elapsedMonths = 1;
    alloyActor.inventory = [
      { id: 'alloy-stone', materialId: Material.Stone, quantity: 1, sourceEventIds: ['alloy-stone-source'] },
      { id: 'alloy-plank', materialId: Material.Plank, quantity: 2, sourceEventIds: ['alloy-plank-source'] },
      { id: 'alloy-copper', materialId: Material.Copper, quantity: 1, sourceEventIds: ['alloy-copper-source'] },
      { id: 'alloy-tin', materialId: Material.Tin, quantity: 1, sourceEventIds: ['alloy-tin-source'] },
    ];
    alloyActor.knowledge = [...alloyActor.knowledge, ...[
      Material.Mill, Material.DriveShaft, Material.Bronze,
    ].map((materialId) => {
      const rule = inventoryCombinationForOutput(materialId);
      assert.ok(rule);
      const techniqueId = inventoryCombinationTechniqueId(rule);
      return {
        id: techniqueId, kind: 'technique', summary: `已核验${materialId}配方`, confidence: 100,
        learnedAtMonth: 0, sourceEventIds: [`alloy-known:${techniqueId}`],
      };
    })];
    let alloyOrder = 0;
    const executeAlloyStep = (action) => {
      alloyOrder += 1;
      const fact = executePrimitiveAction(alloyState, alloyActor, action, 2, alloyOrder, {
        intentId: `test-intent:${alloyProject.id}`, cause: 'intent', actionTick: alloyOrder,
      });
      alloyState.world.past.push(fact);
      recordProjectAction(alloyState, alloyProject.id, fact);
      assert.notEqual(fact.status, 'blocked', fact.result);
      return fact;
    };
    let bronzeAction = null;
    for (let step = 0; step < 8 && !bronzeAction; step += 1) {
      const action = recompileProjectNextAction(alloyState, alloyActor, alloyProject.id);
      assert.ok(action, `青铜中间料链第${step + 1}步必须可编译`);
      const materials = action.kind === 'act' && action.operation === 'combine'
        ? action.targets.flatMap((target) => target.kind === 'inventory-stack'
          ? [alloyActor.inventory.find((stack) => stack.id === target.stackId)?.materialId]
          : []).filter(Number.isInteger).sort((left, right) => left - right)
        : [];
      if (materials.join(',') === [Material.Copper, Material.Tin].sort((left, right) => left - right).join(',')) {
        bronzeAction = action;
        break;
      }
      executeAlloyStep(action);
    }
    assert.ok(bronzeAction, '缺青铜但已知合金配方时，应先编译铜+锡的真实结合动作');
    const bronzeFact = executeAlloyStep(bronzeAction);
    assert.equal(bronzeFact.diff.outputMaterialId, Material.Bronze);
    const shaftAction = recompileProjectNextAction(alloyState, alloyActor, alloyProject.id);
    assert.equal(shaftAction?.kind, 'act');
    assert.equal(shaftAction?.operation, 'combine');
    const shaftInputs = shaftAction.targets.flatMap((target) => target.kind === 'inventory-stack'
      ? [alloyActor.inventory.find((stack) => stack.id === target.stackId)?.materialId]
      : []).filter(Number.isInteger).sort((left, right) => left - right);
    assert.deepEqual(shaftInputs, [Material.Bronze, Material.Plank].sort((left, right) => left - right));
  }

  // A direct primitive cannot observe the same horizontal edge from an
  // impossible vertical position.
  {
    const verticalState = structuredClone(state);
    const verticalActor = verticalState.people.find((person) => person.id === actor.id);
    verticalActor.baselineCapacities.perception = 0;
    verticalActor.position.z = verticalState.world.grid.levels - 1;
    const blocked = executePrimitiveAction(verticalState, verticalActor, observeAction, 1, 1, {
      cause: 'intent', actionTick: 1,
    });
    assert.equal(blocked.status, 'blocked');
  }

  const project = instantiateProject(structuredClone(proposal));
  state.projects = [project];
  state.clock.elapsedMonths = 1;
  const componentMaterials = [Material.Mill, Material.WaterWheel, Material.DriveShaft];
  actor.knowledge = [...actor.knowledge, ...componentMaterials.map((materialId) => {
    const rule = inventoryCombinationForOutput(materialId);
    assert.ok(rule);
    const techniqueId = inventoryCombinationTechniqueId(rule);
    return {
      id: techniqueId, kind: 'technique', summary: `已核验${materialId}配方`, confidence: 100,
      learnedAtMonth: 0, sourceEventIds: [`test-known:${techniqueId}`],
    };
  })];
  actor.inventory = [
    { id: 'test-stone', materialId: Material.Stone, quantity: 1, sourceEventIds: ['test-stone-source'] },
    { id: 'test-plank', materialId: Material.Plank, quantity: 4, sourceEventIds: ['test-plank-source'] },
    { id: 'test-bronze', materialId: Material.Bronze, quantity: 2, sourceEventIds: ['test-bronze-source'] },
    { id: 'test-fiber', materialId: Material.Fiber, quantity: 1, sourceEventIds: ['test-fiber-source'] },
    { id: 'test-seed', materialId: Material.Seed, quantity: 1, sourceEventIds: ['test-seed-source'] },
    { id: 'test-bronze-tool', materialId: Material.BronzeTool, quantity: 1, sourceEventIds: ['test-tool-source'] },
  ];
  assert.equal(projectFunctionSatisfied(state, project), false, '旧Mill劳动或被动Mill加成不能直接完成机械项目');

  let order = 0;
  const trace = [];
  const executeAndCommit = (action) => {
    order += 1;
    const fact = executePrimitiveAction(state, actor, action, 2, order, {
      intentId: `test-intent:${project.id}`,
      cause: 'intent',
      actionTick: order,
    });
    state.world.past.push(fact);
    recordProjectAction(state, project.id, fact);
    trace.push(fact);
    return fact;
  };

  let fault = null;
  let repair = null;
  for (let step = 0; step < 40 && !repair; step += 1) {
    const action = recompileProjectNextAction(state, actor, project.id);
    assert.ok(action, `机械正链第${step + 1}步必须可编译`);
    const seedBefore = actor.inventory.find((stack) => stack.materialId === Material.Seed)?.quantity ?? 0;
    const fact = executeAndCommit(action);
    assert.notEqual(fact.status, 'blocked', `${fact.result}: ${JSON.stringify(action)}`);
    if (fact.diff.mechanicalPowerFault) {
      fault = fact;
      const seedAfter = actor.inventory.find((stack) => stack.materialId === Material.Seed)?.quantity ?? 0;
      assert.equal(fact.status, 'progressed', '诊断出commissioning故障应推进持续意图，而不是终止它');
      assert.equal(fact.diff.inputPreserved, true);
      assert.equal(fact.diff.inputQuantityBefore, fact.diff.inputQuantityAfter);
      assert.equal(seedAfter, seedBefore, '首次commissioning故障不得扣除输入');
    }
    if (fact.diff.mechanicalPowerRepair) repair = fact;
  }
  assert.ok(fault, '完整安装后的首次运行必须确定性地产生commissioning故障');
  assert.ok(repair, '故障后必须制造、核验替换轴并使用真实工具修复');
  assert.equal(voxelAt(
    state.world.grid,
    candidate.plan.wheelPosition.x,
    candidate.plan.wheelPosition.y,
    candidate.plan.wheelPosition.z - 1,
  ), Material.Water,
    '安装水轮不得覆盖绑定水端点');

  let finalOperation = recompileProjectNextAction(state, actor, project.id);
  for (let step = 0; step < 4 && finalOperation?.kind === 'move'; step += 1) {
    const movement = executeAndCommit(finalOperation);
    assert.notEqual(movement.status, 'blocked');
    finalOperation = recompileProjectNextAction(state, actor, project.id);
  }
  assert.equal(finalOperation?.kind, 'act');
  assert.equal(finalOperation?.mechanicalPowerBasis?.mode, 'operate');
  const seedQuantity = () => actor.inventory.filter((stack) => stack.materialId === Material.Seed)
    .reduce((sum, stack) => sum + stack.quantity, 0);

  // All rejection paths run against clones and must reject before consuming input.
  const blockedOperation = (mutate) => {
    const blockedState = structuredClone(state);
    const blockedActor = blockedState.people.find((person) => person.id === actor.id);
    const blockedAction = structuredClone(finalOperation);
    mutate(blockedState, blockedActor, blockedAction);
    const before = blockedActor.inventory.filter((stack) => stack.materialId === Material.Seed)
      .reduce((sum, stack) => sum + stack.quantity, 0);
    const fact = executePrimitiveAction(blockedState, blockedActor, blockedAction, 3, 1, {
      intentId: `test-intent:${project.id}`, cause: 'intent', actionTick: 1,
    });
    const after = blockedActor.inventory.filter((stack) => stack.materialId === Material.Seed)
      .reduce((sum, stack) => sum + stack.quantity, 0);
    assert.equal(fact.status, 'blocked');
    assert.equal(after, before, '失流/错绑定/无输入必须在扣物前拒绝');
  };
  blockedOperation((blockedState) => setVoxel(
    blockedState.world.grid, source.from.x, source.from.y, source.from.z, Material.Ice,
  ));
  blockedOperation((_blockedState, _blockedActor, action) => {
    action.mechanicalPowerBasis.sourceSegmentId = 'wrong-source-segment';
  });
  blockedOperation((_blockedState, _blockedActor, action) => {
    action.mechanicalPowerBasis.planKey = 'wrong-plan-key';
  });
  blockedOperation((_blockedState, _blockedActor, action) => {
    const loadTarget = action.targets.find((target) => target.kind === 'voxel');
    loadTarget.position.x += 1;
  });
  blockedOperation((_blockedState, blockedActor) => {
    blockedActor.inventory = blockedActor.inventory.filter((stack) => stack.materialId !== Material.Seed);
  });

  const beforeFinalSeed = seedQuantity();
  const completed = executeAndCommit(finalOperation);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.diff.mechanicalPowerOperation, true);
  assert.ok(completed.diff.repairEventIds.includes(repair.id));
  assert.ok(completed.diff.inputSourceEventIds.includes('test-seed-source'));
  const poweredOutput = actor.inventory.find((stack) => stack.id === completed.diff.outputStackId);
  assert.ok(poweredOutput?.sourceEventIds.includes('test-seed-source'), '动力产物必须继承真实种子来源');
  assert.equal(seedQuantity(), beforeFinalSeed - 1);
  assert.equal(project.status, 'completed');
  assert.ok(project.completionEventIds.includes(completed.id));
  assert.ok(project.completionEventIds.includes(repair.id));
  assert.ok(project.completionEventIds.includes(fault.id));
  assert.equal(projectFunctionSatisfied(state, project), true);
  assert.equal(voxelAt(state.world.grid, candidate.plan.wheelPosition.x, candidate.plan.wheelPosition.y, candidate.plan.wheelPosition.z), Material.WaterWheel);
  assert.equal(voxelAt(state.world.grid, candidate.plan.shaftPositions[0].x, candidate.plan.shaftPositions[0].y, candidate.plan.shaftPositions[0].z), Material.DriveShaft);
  assert.equal(voxelAt(state.world.grid, candidate.plan.loadPosition.x, candidate.plan.loadPosition.y, candidate.plan.loadPosition.z), Material.Mill);
  assert.ok(trace.some((fact) => fact.diff.componentMaterialId === Material.Mill), '新负载必须真实制造、核验并安装');

  // A completed installation becomes a durable local service. Its condition
  // changes only through successful loaded work, then a later attempted load
  // exposes accumulated wear before consuming the input.
  const network = state.world.mechanicalPower.networks.find((item) => item.id === proposal.mechanicalPowerNetworkId);
  assert.ok(network);
  assert.equal(network.condition, 80, '安装项目的最终真实作业应留下可继续使用的健康网络');
  const actorOperationKnowledge = actor.knowledge.find((fact) => fact.id === MECHANICAL_POWER_OPERATION_TECHNIQUE_ID);
  assert.ok(actorOperationKnowledge?.confidence >= 55);
  assert.ok(actorOperationKnowledge.sourceEventIds.includes(completed.id),
    '操作知识必须来自实际有输入有输出的作业，而不是项目或时代标签');

  const learner = state.people[1];
  learner.diedAtMonth = undefined;
  learner.bornAtMonth = -20 * 12;
  learner.conditions = [];
  learner.body = { health: 100, hydration: 100, nutrition: 100 };
  learner.position = structuredClone(actor.position);
  learner.inventory = [{
    id: 'learner-service-seed', materialId: Material.Seed, quantity: 1,
    sourceEventIds: ['learner-service-seed-source'],
  }];
  learner.knowledge = [];
  learner.memories = [];
  learner.knownPlaces = [];
  const localCells = () => cellsInRadius(actor.position.cellId, 8);
  assert.equal(buildMechanicalPowerServiceOptions(state, learner, localCells())
    .some((option) => option.id.startsWith('operate-completed-mechanical-network:')), false,
  '同地可见网络不能让未学习者凭空获得操作候选');

  const teachingContext = buildDecisionContext(state, actor, 3);
  const teaching = teachingContext.options.find((option) => option.nextAction.kind === 'communicate'
    && option.nextAction.content.kind === 'claim'
    && option.nextAction.content.factId === MECHANICAL_POWER_OPERATION_TECHNIQUE_ID
    && option.nextAction.audience.includes(learner.id));
  assert.ok(teaching, '成功操作者应能用既有明确教导链向同地成年人传授操作知识');
  const teachingFact = executePrimitiveAction(state, actor, teaching.nextAction, 3, 1, {
    cause: 'intent', actionTick: 1,
  });
  assert.equal(teachingFact.status, 'completed');
  state.world.past.push(teachingFact);
  const learnedOperation = learner.knowledge.find((fact) => fact.id === MECHANICAL_POWER_OPERATION_TECHNIQUE_ID);
  assert.ok(learnedOperation?.confidence >= 55);
  assert.deepEqual(learnedOperation.sourceEventIds, [teachingFact.id],
    '第二操作者的可靠知识必须以真实教导事件为个人来源');

  const learnerService = buildMechanicalPowerServiceOptions(state, learner, cellsInRadius(learner.position.cellId, 8))
    .find((option) => option.id.startsWith('operate-completed-mechanical-network:'));
  assert.ok(learnerService);
  assert.equal(learnerService.nextAction.kind, 'act');
  const learnerOperation = executePrimitiveAction(state, learner, learnerService.nextAction, 3, 2, {
    cause: 'intent', actionTick: 2,
  });
  assert.equal(learnerOperation.status, 'completed');
  assert.equal(learnerOperation.diff.mechanicalPowerOperation, true);
  assert.equal(learnerOperation.diff.conditionBefore, 80);
  assert.equal(learnerOperation.diff.conditionAfter, 60);
  state.world.past.push(learnerOperation);
  assert.equal(learner.inventory.some((stack) => stack.id === 'learner-service-seed'), false,
    '合法第二操作者应独立消耗自己的真实输入');

  actor.inventory.push({
    id: 'owner-service-seed', materialId: Material.Seed, quantity: 4,
    sourceEventIds: ['owner-service-seed-source'],
  });
  const executeOwnerService = (atMonth, serviceOrder) => {
    const option = buildMechanicalPowerServiceOptions(state, actor, localCells())
      .find((candidateOption) => candidateOption.id.startsWith('operate-completed-mechanical-network:'));
    assert.ok(option, `第${serviceOrder}次持续作业必须有真实候选`);
    assert.equal(option.nextAction.kind, 'act');
    const fact = executePrimitiveAction(state, actor, option.nextAction, atMonth, serviceOrder, {
      cause: 'intent', actionTick: serviceOrder,
    });
    state.world.past.push(fact);
    return fact;
  };
  const secondLoadedUse = executeOwnerService(4, 1);
  assert.equal(secondLoadedUse.diff.conditionBefore, 60);
  assert.equal(secondLoadedUse.diff.conditionAfter, MECHANICAL_POWER_WORN_FAULT_THRESHOLD);
  const seedBeforeWornFault = actor.inventory.find((stack) => stack.id === 'owner-service-seed').quantity;
  const wornFault = executeOwnerService(4, 2);
  assert.equal(wornFault.status, 'completed');
  assert.equal(wornFault.diff.faultKind, 'worn-drive-shaft');
  assert.equal(wornFault.diff.inputPreserved, true);
  assert.equal(actor.inventory.find((stack) => stack.id === 'owner-service-seed').quantity, seedBeforeWornFault,
    '磨损断轴必须发生在吞输入之前');
  assert.deepEqual(wornFault.diff.wearSourceEventIds, network.operationEventIds.slice(-3));
  assert.equal(network.condition, MECHANICAL_POWER_WORN_FAULT_THRESHOLD);
  assert.equal(voxelAt(state.world.grid,
    candidate.plan.shaftPositions[0].x,
    candidate.plan.shaftPositions[0].y,
    candidate.plan.shaftPositions[0].z), Material.BrokenDriveShaft);

  assert.equal(deriveProjectProposals(
    state,
    actor,
    localCells(),
    [],
    [learner],
  ).some((item) => item.desiredFunction === 'restore-water-powered-crop-processing'), false,
  '制造故障的人也必须先亲历检查，故障事实本身不能直接授权维修项目');
  const diagnose = buildMechanicalPowerServiceOptions(state, actor, localCells())
    .find((option) => option.id.startsWith('diagnose-mechanical-fault:'));
  assert.ok(diagnose);
  const farDiagnosisState = structuredClone(state);
  const farActor = farDiagnosisState.people.find((person) => person.id === actor.id);
  farActor.position.cellId = cellId(0, 0);
  const forgedDiagnosis = executePrimitiveAction(
    farDiagnosisState, farActor, diagnose.nextAction, 5, 1, { cause: 'intent', actionTick: 1 },
  );
  assert.equal(forgedDiagnosis.status, 'blocked', '不可见的远程断轴不能被伪造为本人诊断');
  const diagnosis = executePrimitiveAction(state, actor, diagnose.nextAction, 5, 1, {
    cause: 'intent', actionTick: 1,
  });
  assert.equal(diagnosis.status, 'completed');
  assert.equal(diagnosis.diff.mechanicalPowerFaultDiagnosis, true);
  assert.equal(diagnosis.diff.faultEventId, wornFault.id);
  state.world.past.push(diagnosis);

  state.clock.elapsedMonths = 5;
  const maintenanceProposal = deriveProjectProposals(
    state,
    actor,
    localCells(),
    [],
    [learner],
  ).find((item) => item.desiredFunction === 'restore-water-powered-crop-processing');
  assert.ok(maintenanceProposal, '本人诊断与当前实体故障应形成独立、受限的维修项目');
  assert.equal(maintenanceProposal.mechanicalPowerFaultEventId, wornFault.id);
  assert.ok(maintenanceProposal.triggerFactIds.includes(diagnosis.id));
  const maintenanceProject = instantiateProject(maintenanceProposal);
  state.projects.push(maintenanceProject);
  actor.inventory.push(
    { id: 'maintenance-plank', materialId: Material.Plank, quantity: 1, sourceEventIds: ['maintenance-plank-source'] },
    { id: 'maintenance-bronze', materialId: Material.Bronze, quantity: 1, sourceEventIds: ['maintenance-bronze-source'] },
  );
  assert.deepEqual(
    mechanicalPowerMaintenanceMaterialRequirement(state, actor, maintenanceProject).materialIds,
    [],
    '眼前原料充足时维护编译器不应发出虚假的额外需求',
  );

  const maintenanceTrace = [];
  for (let step = 0; step < 16 && maintenanceProject.status === 'active'; step += 1) {
    const action = recompileProjectNextAction(state, actor, maintenanceProject.id);
    assert.ok(action, `维修正链第${step + 1}步必须可编译`);
    const fact = executePrimitiveAction(state, actor, action, 6, step + 1, {
      intentId: `test-intent:${maintenanceProject.id}`,
      projectId: maintenanceProject.id,
      cause: 'intent',
      actionTick: step + 1,
    });
    assert.notEqual(fact.status, 'blocked', `${fact.result}: ${JSON.stringify(action)}`);
    state.world.past.push(fact);
    recordProjectAction(state, maintenanceProject.id, fact);
    maintenanceTrace.push(fact);
  }
  const replacementManufacture = maintenanceTrace.find((fact) => fact.action.kind === 'act'
    && fact.action.operation === 'combine'
    && fact.diff.outputMaterialId === Material.DriveShaft);
  const replacementVerification = maintenanceTrace.find((fact) => fact.action.kind === 'attend'
    && fact.diff.verifiedSourceEventId === replacementManufacture?.id);
  const maintenanceRepair = maintenanceTrace.find((fact) => fact.diff.mechanicalPowerRepair === true);
  const recovery = maintenanceTrace.find((fact) => fact.diff.mechanicalPowerRecovery === true);
  assert.ok(replacementManufacture && replacementVerification && maintenanceRepair && recovery,
    '维修必须包含故障后制造、来源核验、实体修理和带载恢复四项事实');
  assert.ok(replacementManufacture.orderInMonth > wornFault.orderInMonth
    || replacementManufacture.atMonth > wornFault.atMonth);
  assert.ok(maintenanceRepair.diff.repairSourceEventIds.includes(replacementManufacture.id));
  assert.ok(maintenanceRepair.diff.repairSourceEventIds.includes(replacementVerification.id));
  assert.equal(recovery.diff.recoveryRepairEventId, maintenanceRepair.id);
  assert.equal(maintenanceProject.status, 'completed');
  assert.equal(network.fault, null);
  assert.equal(network.condition, 80, '修理复位后还必须经一次真实负载作业，才成为可验收的恢复状态');
  assert.equal(voxelAt(state.world.grid,
    candidate.plan.shaftPositions[0].x,
    candidate.plan.shaftPositions[0].y,
    candidate.plan.shaftPositions[0].z), Material.DriveShaft);

  process.stdout.write('mechanical power chain tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
