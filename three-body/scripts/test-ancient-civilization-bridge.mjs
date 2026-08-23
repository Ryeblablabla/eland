import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-ancient-bridge-test-'));
const bundlePath = path.join(temporaryDirectory, 'ancient-bridge.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { buildDecisionContexts } from ${JSON.stringify(path.resolve('src/game/eland/simulation.ts'))};
    export { buildLocalMaterialEvidence } from ${JSON.stringify(path.resolve('src/game/eland/application/local-material-evidence.ts'))};
    export { deriveProjectProposals } from ${JSON.stringify(path.resolve('src/game/eland/application/projects/project-proposals.ts'))};
    export { visibleCellsFor } from ${JSON.stringify(path.resolve('src/game/eland/application/projects/project-perception.ts'))};
    export { fixedFacilityWorkplace, knownFacilitySite } from ${JSON.stringify(path.resolve('src/game/eland/application/projects/project-workplace.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.resolve('src/game/eland/domain/project.ts'))};
    export { recordProjectAction, recompileProjectNextAction } from ${JSON.stringify(path.resolve('src/game/eland/application/project-options.ts'))};
    export { projectContributionStep } from ${JSON.stringify(path.resolve('src/game/eland/application/projects/project-step-compiler.ts'))};
    export { addDrop, executePrimitiveAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export { maintainMemories, rememberAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/memory.ts'))};
    export { inspectProjectMaterialContributionRequest } from ${JSON.stringify(path.resolve('src/game/eland/domain/project-material-request.ts'))};
    export { exposureRuleFor, exposureTechniqueId, inventoryCombinationForOutput, inventoryCombinationTechniqueId } from ${JSON.stringify(path.resolve('src/game/eland/domain/interaction-rules.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { cellX, cellY, neighbors4, setVoxel, standingPositions, voxelAt } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=ancient-bridge-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const simulation = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    Material,
    addDrop,
    buildDecisionContexts,
    buildLocalMaterialEvidence,
    cellX,
    cellY,
    createInitialState,
    deriveProjectProposals,
    executePrimitiveAction,
    exposureRuleFor,
    exposureTechniqueId,
    fixedFacilityWorkplace,
    instantiateProject,
    inspectProjectMaterialContributionRequest,
    inventoryCombinationForOutput,
    inventoryCombinationTechniqueId,
    knownFacilitySite,
    maintainMemories,
    neighbors4,
    projectContributionStep,
    rememberAction,
    recordProjectAction,
    recompileProjectNextAction,
    setVoxel,
    standingPositions,
    visibleCellsFor,
    voxelAt,
  } = simulation;

  const placeWith = (person, other) => {
    person.position.cellId = other.position.cellId;
    person.position.z = other.position.z;
    person.position.previousCellId = other.position.cellId;
    person.position.previousZ = other.position.z;
  };
  const stack = (id, materialId, quantity = 1) => ({
    id, materialId, quantity, sourceEventIds: [`source:${id}`],
  });
  const laborFact = (person, atMonth, id) => ({
    id,
    kind: 'action',
    actionTick: 0,
    atMonth,
    orderInMonth: 0,
    cellId: person.position.cellId,
    who: person.id,
    cause: 'intent',
    action: { kind: 'act', operation: 'separate', targets: [] },
    fromCellId: person.position.cellId,
    toCellId: person.position.cellId,
    fromZ: person.position.z,
    toZ: person.position.z,
    pathSegment: [person.position.cellId],
    status: 'completed',
    result: '完成了一次真实生产劳动',
    diff: { sourceMaterialId: Material.Wood, outputs: [{ materialId: Material.Wood, quantity: 2 }] },
  });

  const brickState = [9211, 9212, 9213]
    .map((seed) => createInitialState(seed, { endpoint: { kind: 'months', value: 60 }, chaosIntensity: 0 }))
    .find((state) => state.people.length >= 7);
  assert.ok(brickState, '定向场景需要至少七名局部可见人物形成高温生产压力');
  brickState.clock.elapsedMonths = 24;
  brickState.projects = [];
  const brickOwner = brickState.people[0];
  for (const person of brickState.people) placeWith(person, brickOwner);
  const brickKilnCell = neighbors4(brickOwner.position.cellId)[0];
  setVoxel(
    brickState.world.grid,
    cellX(brickKilnCell),
    cellY(brickKilnCell),
    brickOwner.position.z,
    Material.Kiln,
  );
  const kilnSite = knownFacilitySite(brickState, brickOwner, [Material.Kiln]);
  const kilnWorkplace = kilnSite
    ? fixedFacilityWorkplace(brickState, brickOwner, kilnSite, [Material.Kiln])
    : null;
  assert.ok(kilnSite && kilnWorkplace);
  brickOwner.position.cellId = kilnWorkplace.workingPosition.cellId;
  brickOwner.position.z = kilnWorkplace.workingPosition.z;
  for (const person of brickState.people.slice(1)) placeWith(person, brickOwner);
  brickOwner.inventory = [stack('brick-clay', Material.Clay)];
  const brickProposal = deriveProjectProposals(
    brickState,
    brickOwner,
    visibleCellsFor(brickOwner),
    [],
    brickState.people,
  ).find((proposal) => proposal.desiredFunction === 'brick-firing');
  assert.ok(brickProposal, '本人持有黏土并看见可达窑炉时应能提出烧砖项目');
  assert.deepEqual(brickProposal.site, kilnSite, '烧砖项目必须冻结真实高温设施位置');
  const brickProject = instantiateProject(brickProposal);
  brickState.projects.push(brickProject);
  const brickAction = recompileProjectNextAction(brickState, brickOwner, brickProject.id);
  assert.equal(brickAction?.kind, 'act');
  assert.equal(brickAction?.operation, 'expose', '未知烧砖配方应先尝试黏土与眼前高温设施的接触实验');
  assert.ok(brickAction?.targets.some((target) => target.kind === 'inventory-stack'
    && target.stackId === 'brick-clay'));
  assert.ok(brickAction?.targets.some((target) => target.kind === 'voxel'
    && target.position.x === cellX(brickKilnCell)
    && target.position.y === cellY(brickKilnCell)));
  const brickEvent = executePrimitiveAction(
    brickState,
    brickOwner,
    brickAction,
    25,
    0,
    { cause: 'project', projectId: brickProject.id, actionTick: 1 },
  );
  brickState.world.past.push(brickEvent);
  recordProjectAction(brickState, brickProject.id, brickEvent);
  assert.equal(brickEvent.status, 'completed');
  assert.equal(brickEvent.diff.outputMaterialId, Material.FiredBrick,
    '产物仍必须由黏土接触窑炉的权威物质规则产生');

  const knownIntermediateState = createInitialState(9206, { endpoint: { kind: 'months', value: 60 }, chaosIntensity: 0 });
  knownIntermediateState.clock.elapsedMonths = 24;
  knownIntermediateState.projects = [];
  const knownIntermediateOwner = knownIntermediateState.people[0];
  const knownIntermediateHolder = knownIntermediateState.people[1];
  for (const person of knownIntermediateState.people) placeWith(person, knownIntermediateOwner);
  knownIntermediateOwner.inventory = [
    stack('known-copper', Material.Copper),
    stack('known-owner-fired-brick', Material.FiredBrick),
  ];
  knownIntermediateHolder.inventory = [
    stack('known-tin', Material.Tin),
    stack('known-bronze-tool', Material.BronzeTool),
    stack('known-iron-ore', Material.IronOre),
  ];
  const bronzeRule = inventoryCombinationForOutput(Material.Bronze);
  assert.ok(bronzeRule);
  const bronzeTechniqueId = inventoryCombinationTechniqueId(bronzeRule);
  knownIntermediateOwner.knowledge = knownIntermediateOwner.knowledge
    .filter((fact) => fact.id !== bronzeTechniqueId);
  const proposeKnownIntermediateWorkshop = () => deriveProjectProposals(
    knownIntermediateState,
    knownIntermediateOwner,
    visibleCellsFor(knownIntermediateOwner),
    [],
    knownIntermediateState.people,
  ).find((proposal) => proposal.desiredFunction === 'iron-workshop');
  const unknownIntermediateProposal = proposeKnownIntermediateWorkshop();
  assert.ok(unknownIntermediateProposal);
  const unknownIntermediateProject = instantiateProject(unknownIntermediateProposal);
  knownIntermediateState.projects.push(unknownIntermediateProject);
  recompileProjectNextAction(knownIntermediateState, knownIntermediateOwner, unknownIntermediateProject.id);
  assert.ok(unknownIntermediateProject.materialDemands.some((demand) => demand.materialId === Material.Bronze),
    '没有可靠配方知识时，铁匠铺项目仍只能把青铜本身作为缺口');
  assert.equal(unknownIntermediateProject.materialDemands.some((demand) => demand.materialId === Material.Tin), false,
    '人物不得因为时代目标或隐藏配方而预知锡是青铜输入');
  knownIntermediateState.projects = [];
  knownIntermediateOwner.knowledge.push({
    id: bronzeTechniqueId,
    kind: 'technique',
    summary: '铜与锡可结合为青铜',
    confidence: 70,
    learnedAtMonth: 20,
    sourceEventIds: ['directed-fixture:bronze-made', 'directed-fixture:bronze-verified'],
  });
  const knownIntermediateProposal = proposeKnownIntermediateWorkshop();
  assert.ok(knownIntermediateProposal);
  const knownIntermediateProject = instantiateProject(knownIntermediateProposal);
  knownIntermediateState.projects.push(knownIntermediateProject);
  const tinRequest = recompileProjectNextAction(
    knownIntermediateState,
    knownIntermediateOwner,
    knownIntermediateProject.id,
  );
  assert.equal(tinRequest?.kind, 'communicate');
  assert.equal(tinRequest?.content.projectMaterialContribution?.materialId, Material.Tin,
    '本人可靠掌握青铜配方且持有铜时，项目只能把实际缺少的锡变成贡献请求');
  assert.equal(knownIntermediateProject.materialDemands.some((demand) => demand.materialId === Material.Bronze), false,
    '可靠已知配方已把加工品缺口展开后，不应继续搜索不存在的青铜物件');
  const tinRequestEvent = executePrimitiveAction(
    knownIntermediateState,
    knownIntermediateOwner,
    tinRequest,
    25,
    0,
    { cause: 'project', projectId: knownIntermediateProject.id, actionTick: 1 },
  );
  knownIntermediateState.world.past.push(tinRequestEvent);
  recordProjectAction(knownIntermediateState, knownIntermediateProject.id, tinRequestEvent);
  const tinContribution = recompileProjectNextAction(
    knownIntermediateState,
    knownIntermediateHolder,
    knownIntermediateProject.id,
  );
  assert.equal(tinContribution?.kind, 'transfer');
  assert.equal(tinContribution?.materialId, Material.Tin);
  const tinContributionEvent = executePrimitiveAction(
    knownIntermediateState,
    knownIntermediateHolder,
    tinContribution,
    25,
    1,
    { cause: 'project', projectId: knownIntermediateProject.id, actionTick: 2 },
  );
  knownIntermediateState.world.past.push(tinContributionEvent);
  recordProjectAction(knownIntermediateState, knownIntermediateProject.id, tinContributionEvent);
  assert.equal(tinContributionEvent.status, 'completed');
  const bronzeAssembly = recompileProjectNextAction(
    knownIntermediateState,
    knownIntermediateOwner,
    knownIntermediateProject.id,
  );
  assert.equal(bronzeAssembly?.kind, 'act');
  assert.equal(bronzeAssembly?.operation, 'combine');
  assert.equal(knownIntermediateProject.planKnowledgeId, bronzeTechniqueId,
    '青铜中间件只能引用本人已有的可靠配方知识');
  const bronzeAssemblyEvent = executePrimitiveAction(
    knownIntermediateState,
    knownIntermediateOwner,
    bronzeAssembly,
    25,
    2,
    { cause: 'project', projectId: knownIntermediateProject.id, actionTick: 3 },
  );
  knownIntermediateState.world.past.push(bronzeAssemblyEvent);
  recordProjectAction(knownIntermediateState, knownIntermediateProject.id, bronzeAssemblyEvent);
  assert.equal(bronzeAssemblyEvent.status, 'completed');
  assert.equal(bronzeAssemblyEvent.diff.outputMaterialId, Material.Bronze,
    '青铜仍必须由真实铜锡输入和权威 combine 规则产生');

  {
    const processState = createInitialState(9206, { endpoint: { kind: 'months', value: 60 }, chaosIntensity: 0 });
    processState.clock.elapsedMonths = 24;
    processState.projects = [];
    const processOwner = processState.people[0];
    const processWitness = processState.people[1];
    for (const person of processState.people) placeWith(person, processOwner);
    const processKilnCell = neighbors4(processOwner.position.cellId)[0];
    setVoxel(
      processState.world.grid,
      cellX(processKilnCell),
      cellY(processKilnCell),
      processOwner.position.z,
      Material.Kiln,
    );
    const processKilnSite = knownFacilitySite(processState, processOwner, [Material.Kiln]);
    const processKilnWorkplace = processKilnSite
      ? fixedFacilityWorkplace(processState, processOwner, processKilnSite, [Material.Kiln])
      : null;
    assert.ok(processKilnSite && processKilnWorkplace);
    processOwner.position.cellId = processKilnWorkplace.workingPosition.cellId;
    processOwner.position.z = processKilnWorkplace.workingPosition.z;
    for (const person of processState.people.slice(1)) placeWith(person, processOwner);
    processOwner.inventory = [
      stack('process-copper', Material.Copper),
      stack('process-tin-ore', Material.TinOre),
      stack('process-charcoal', Material.Charcoal),
      stack('process-clay', Material.Clay),
    ];
    processWitness.inventory = [
      stack('process-visible-bronze-tool', Material.BronzeTool),
      stack('process-visible-iron-ore', Material.IronOre),
      stack('process-visible-fired-brick', Material.FiredBrick),
    ];
    const processBronzeRule = inventoryCombinationForOutput(Material.Bronze);
    const processTinChargeRule = inventoryCombinationForOutput(Material.TinCharge);
    const processTinExposureRule = exposureRuleFor(Material.TinCharge, Material.Kiln);
    const processBrickExposureRule = exposureRuleFor(Material.Clay, Material.Kiln);
    assert.ok(processBronzeRule && processTinChargeRule && processTinExposureRule && processBrickExposureRule);
    const processKnowledge = [
      {
        id: inventoryCombinationTechniqueId(processBronzeRule),
        summary: '已核验铜锡合金经验',
        source: 'process-known-bronze',
      },
      {
        id: inventoryCombinationTechniqueId(processTinChargeRule),
        summary: '已核验锡矿炭料经验',
        source: 'process-known-tin-charge',
      },
      {
        id: exposureTechniqueId(processTinExposureRule),
        summary: '已核验锡矿炭料窑炉暴露经验',
        source: 'process-known-tin-exposure',
      },
      {
        id: exposureTechniqueId(processBrickExposureRule),
        summary: '已核验黏土烧制耐火砖经验',
        source: 'process-known-fired-brick-exposure',
      },
    ];
    processOwner.knowledge = processKnowledge.map((fact) => ({
      id: fact.id,
      kind: 'technique',
      summary: fact.summary,
      confidence: 70,
      learnedAtMonth: 20,
      sourceEventIds: [fact.source],
    }));

    const processProposal = deriveProjectProposals(
      processState,
      processOwner,
      visibleCellsFor(processOwner),
      [],
      processState.people,
    ).find((proposal) => proposal.desiredFunction === 'iron-workshop');
    assert.ok(processProposal, '已看见铁矿压力、青铜工具与耐火砖时应能提出铁匠铺项目');

    const noFacilityState = structuredClone(processState);
    setVoxel(
      noFacilityState.world.grid,
      cellX(processKilnCell),
      cellY(processKilnCell),
      processOwner.position.z,
      Material.Air,
    );
    const noFacilityOwner = noFacilityState.people.find((person) => person.id === processOwner.id);
    const noFacilityWitness = noFacilityState.people.find((person) => person.id === processWitness.id);
    assert.ok(noFacilityOwner && noFacilityWitness);
    const noFacilityProposal = deriveProjectProposals(
      noFacilityState,
      noFacilityOwner,
      visibleCellsFor(noFacilityOwner),
      [],
      noFacilityState.people,
    ).find((proposal) => proposal.desiredFunction === 'iron-workshop');
    assert.ok(noFacilityProposal);
    noFacilityWitness.inventory = noFacilityWitness.inventory
      .filter((item) => item.materialId !== Material.FiredBrick);
    const noFacilityProject = instantiateProject(noFacilityProposal);
    noFacilityState.projects.push(noFacilityProject);
    recompileProjectNextAction(noFacilityState, noFacilityOwner, noFacilityProject.id);
    assert.ok(noFacilityProject.materialDemands.some((demand) => demand.materialId === Material.Tin),
      '可靠 exposure 技术没有本人已知且当前可达的工位时，不能把成品锡缺口展开为隐藏输入');
    assert.equal(noFacilityProject.materialDemands.some((demand) => demand.materialId === Material.TinOre), false);
    assert.ok(noFacilityProject.materialDemands.some((demand) => demand.materialId === Material.FiredBrick),
      '可靠烧砖技术没有本人已知且当前可达的工位时，耐火砖仍是直接缺口');
    assert.equal(noFacilityProject.materialDemands.some((demand) => demand.materialId === Material.Clay), false);

    const directFinishedState = structuredClone(processState);
    const directFinishedOwner = directFinishedState.people.find((person) => person.id === processOwner.id);
    assert.ok(directFinishedOwner);
    directFinishedOwner.inventory = [stack('process-ready-bronze-direct-finished', Material.Bronze)];
    const directFinishedProject = instantiateProject(processProposal);
    directFinishedState.projects.push(directFinishedProject);
    const directFinishedAction = recompileProjectNextAction(
      directFinishedState,
      directFinishedOwner,
      directFinishedProject.id,
    );
    assert.equal(directFinishedAction?.kind, 'communicate');
    assert.equal(
      directFinishedAction?.content.projectMaterialContribution?.materialId,
      Material.FiredBrick,
      '眼前持料者已有真实成品时，项目必须先复用既有贡献物流',
    );
    assert.ok(directFinishedProject.materialDemands.some((demand) => demand.materialId === Material.FiredBrick
      && demand.branchKey === `known-direct-output:holder:${Material.FiredBrick}`));
    assert.equal(directFinishedProject.materialDemands.some((demand) => demand.materialId === Material.Clay), false);

    const siblingFinishedState = structuredClone(processState);
    const siblingFinishedOwner = siblingFinishedState.people.find((person) => person.id === processOwner.id);
    const siblingFinishedWitness = siblingFinishedState.people.find((person) => person.id === processWitness.id);
    const siblingFinishedCopperHolder = siblingFinishedState.people[2];
    assert.ok(siblingFinishedOwner && siblingFinishedWitness && siblingFinishedCopperHolder);
    siblingFinishedOwner.inventory = [];
    siblingFinishedCopperHolder.inventory = [stack('process-visible-copper-sibling', Material.Copper)];
    const siblingFinishedProject = instantiateProject(processProposal);
    siblingFinishedState.projects.push(siblingFinishedProject);
    const siblingFinishedAction = recompileProjectNextAction(
      siblingFinishedState,
      siblingFinishedOwner,
      siblingFinishedProject.id,
    );
    assert.equal(siblingFinishedAction?.kind, 'communicate');
    assert.equal(
      siblingFinishedAction?.content.projectMaterialContribution?.materialId,
      Material.FiredBrick,
      '兄弟 Bronze 分支即使已有 Copper 前体，也必须先取得眼前的直接根成品 FiredBrick',
    );
    assert.ok(siblingFinishedProject.materialDemands.some((demand) => demand.materialId === Material.FiredBrick
      && demand.branchKey === `known-direct-output:holder:${Material.FiredBrick}`));
    assert.ok(siblingFinishedProject.materialDemands.some((demand) => demand.materialId === Material.Copper
      && demand.branchKey === `known-direct-output:holder:${Material.Copper}`),
    '本轮物流优先级不能删除完整 AND requirement 中的 Bronze 前体与来源');
    assert.equal(siblingFinishedProject.materialDemands.some((demand) => demand.materialId === Material.Clay), false);

    const noClayState = structuredClone(processState);
    const noClayOwner = noClayState.people.find((person) => person.id === processOwner.id);
    const noClayWitness = noClayState.people.find((person) => person.id === processWitness.id);
    assert.ok(noClayOwner && noClayWitness);
    noClayOwner.inventory = [stack('process-ready-bronze', Material.Bronze)];
    noClayWitness.inventory = noClayWitness.inventory
      .filter((item) => item.materialId !== Material.FiredBrick);
    const noClayProject = instantiateProject(processProposal);
    noClayState.projects.push(noClayProject);
    recompileProjectNextAction(noClayState, noClayOwner, noClayProject.id);
    assert.ok(noClayProject.materialDemands.some((demand) => demand.materialId === Material.Clay
      && demand.branchKey.startsWith('known-exposure-requirement:')),
    '可靠烧砖技术与真实可达窑炉同时存在时，耐火砖缺口必须展开为带工艺分支的黏土缺口');
    assert.equal(noClayProject.materialDemands.some((demand) => demand.materialId === Material.FiredBrick), false);

    const noBrickKnowledgeState = structuredClone(processState);
    const noBrickKnowledgeOwner = noBrickKnowledgeState.people.find((person) => person.id === processOwner.id);
    const noBrickKnowledgeWitness = noBrickKnowledgeState.people.find((person) => person.id === processWitness.id);
    assert.ok(noBrickKnowledgeOwner && noBrickKnowledgeWitness);
    noBrickKnowledgeOwner.inventory = [stack('process-ready-bronze-no-brick-knowledge', Material.Bronze)];
    noBrickKnowledgeWitness.inventory = noBrickKnowledgeWitness.inventory
      .filter((item) => item.materialId !== Material.FiredBrick);
    noBrickKnowledgeOwner.knowledge = noBrickKnowledgeOwner.knowledge
      .filter((fact) => fact.id !== exposureTechniqueId(processBrickExposureRule));
    const noBrickKnowledgeProject = instantiateProject(processProposal);
    noBrickKnowledgeState.projects.push(noBrickKnowledgeProject);
    recompileProjectNextAction(noBrickKnowledgeState, noBrickKnowledgeOwner, noBrickKnowledgeProject.id);
    assert.ok(noBrickKnowledgeProject.materialDemands.some((demand) => demand.materialId === Material.FiredBrick));
    assert.equal(noBrickKnowledgeProject.materialDemands.some((demand) => demand.materialId === Material.Clay), false,
      '窑炉存在但本人没有可靠烧砖技术时，不得从耐火砖推断黏土');

    processWitness.inventory = processWitness.inventory
      .filter((item) => item.materialId !== Material.FiredBrick);

    const processProject = instantiateProject(processProposal);
    processState.projects.push(processProject);
    let processOrder = 0;
    const executeProcessStep = (action) => {
      processOrder += 1;
      const fact = executePrimitiveAction(
        processState,
        processOwner,
        action,
        25,
        processOrder,
        { cause: 'project', projectId: processProject.id, actionTick: processOrder },
      );
      processState.world.past.push(fact);
      recordProjectAction(processState, processProject.id, fact);
      assert.equal(fact.status, 'completed', fact.result);
      return fact;
    };
    const expectedOutputs = [
      Material.TinCharge,
      Material.Tin,
      Material.Bronze,
      Material.FiredBrick,
      Material.Smithy,
    ];
    const processFacts = [];
    for (const expectedOutput of expectedOutputs) {
      const action = recompileProjectNextAction(processState, processOwner, processProject.id);
      assert.ok(action, `已知生产图必须继续编译到 ${expectedOutput}`);
      if (expectedOutput === Material.TinCharge) assert.equal(
        processProject.materialDemands.some((demand) => (
          demand.materialId === Material.TinCharge || demand.materialId === Material.Tin
        )),
        false,
        '本人已掌握完整工艺且持有原料时，可当场制作的中间件不是外部物资缺口',
      );
      const fact = executeProcessStep(action);
      assert.equal(fact.diff.outputMaterialId, expectedOutput,
        '已知生产图只能按真实 TinCharge → Tin → Bronze → FiredBrick → Smithy 顺序产生权威产物');
      processFacts.push(fact);
    }
    const tinStack = processOwner.inventory.find((item) => item.materialId === Material.Tin);
    assert.equal(tinStack, undefined, '锡已经作为后续青铜的真实输入被消耗，不能复制残留');
    assert.ok(processOwner.inventory.some((item) => item.materialId === Material.Smithy),
      '末级产物仍是待放置的真实 Smithy 背包实体，不由项目状态凭空完成');
    assert.ok(processFacts.every((fact) => fact.id && fact.status === 'completed'));
  }

  const civicState = createInitialState(9201, { endpoint: { kind: 'months', value: 60 }, chaosIntensity: 0 });
  civicState.clock.elapsedMonths = 24;
  civicState.projects = [];
  const civicOwner = civicState.people[0];
  const civicHolder = civicState.people[1];
  for (const person of civicState.people) placeWith(person, civicOwner);
  civicOwner.inventory = [stack('civic-bronze', Material.Bronze)];
  civicHolder.inventory = [
    stack('civic-brick', Material.FiredBrick),
    stack('civic-tablet', Material.WoodTablet),
  ];
  const civicVisibleCells = visibleCellsFor(civicOwner);
  const civicProposal = deriveProjectProposals(
    civicState,
    civicOwner,
    civicVisibleCells,
    [],
    civicState.people,
  ).find((proposal) => proposal.desiredFunction === 'civic-coordination');
  assert.ok(civicProposal, '看见青铜与可贡献的砖、木牍时应能发起公共厅堂项目');
  assert.equal(civicOwner.inventory.some((item) => item.materialId === Material.FiredBrick), false,
    '公共厅堂发起者不应被要求预先独占砖料');
  assert.equal(civicOwner.inventory.some((item) => item.materialId === Material.WoodTablet), false,
    '公共厅堂发起者不应被要求预先独占木牍');

  const civicProject = instantiateProject(civicProposal);
  civicState.projects.push(civicProject);
  const requestAction = recompileProjectNextAction(civicState, civicOwner, civicProject.id);
  assert.equal(requestAction?.kind, 'communicate', '公共厅堂缺料时应形成真实贡献请求');
  assert.equal(requestAction?.content.projectMaterialContribution?.projectId, civicProject.id);
  const requestEvent = executePrimitiveAction(
    civicState,
    civicOwner,
    requestAction,
    civicState.clock.elapsedMonths + 1,
    0,
    { cause: 'project', projectId: civicProject.id, actionTick: 1 },
  );
  civicState.world.past.push(requestEvent);
  assert.equal(requestEvent.status, 'completed', '有可见持料者时贡献请求应合法完成');
  const contributionAction = recompileProjectNextAction(civicState, civicHolder, civicProject.id);
  assert.equal(contributionAction?.kind, 'transfer', '收到请求的持料者应能把材料交给项目所有者');
  assert.equal(contributionAction?.authorizationRef, requestEvent.id, '材料交接必须引用真实请求事件');
  const ordinaryCoordinationProject = structuredClone(civicProject);
  ordinaryCoordinationProject.desiredFunction = 'community-coordination';
  assert.equal(projectContributionStep(civicState, civicHolder, ordinaryCoordinationProject), null,
    '材料贡献通道只能扩展到公共厅堂，不能改写所有普通协调项目的候选集');

  const ironWorkshopState = createInitialState(9206, { endpoint: { kind: 'months', value: 60 }, chaosIntensity: 0 });
  ironWorkshopState.clock.elapsedMonths = 24;
  ironWorkshopState.projects = [];
  const ironWorkshopOwner = ironWorkshopState.people[0];
  const ironWorkshopHolder = ironWorkshopState.people[1];
  for (const person of ironWorkshopState.people) placeWith(person, ironWorkshopOwner);
  ironWorkshopOwner.inventory = [];
  ironWorkshopHolder.inventory = [
    stack('visible-bronze', Material.Bronze),
    stack('visible-fired-brick', Material.FiredBrick),
    stack('visible-iron-ore', Material.IronOre),
  ];
  const ironWorkshopProposal = deriveProjectProposals(
    ironWorkshopState,
    ironWorkshopOwner,
    visibleCellsFor(ironWorkshopOwner),
    [],
    ironWorkshopState.people,
  ).find((proposal) => proposal.desiredFunction === 'iron-workshop');
  assert.ok(ironWorkshopProposal,
    '人物观察到青铜经验、耐火砖和铁料压力后，应能在未独占末级原料时提出铁匠铺项目');
  assert.equal(ironWorkshopOwner.inventory.length, 0, '铁匠铺提案不应要求发起者预先独占青铜和耐火砖');
  const ironWorkshopProject = instantiateProject(ironWorkshopProposal);
  ironWorkshopState.projects.push(ironWorkshopProject);
  const ironWorkshopRequest = recompileProjectNextAction(
    ironWorkshopState,
    ironWorkshopOwner,
    ironWorkshopProject.id,
  );
  assert.equal(ironWorkshopRequest?.kind, 'communicate',
    '铁匠铺 construction 的缺料应在尚无 Smithy 时走固定项目地点贡献请求');
  assert.ok([Material.Bronze, Material.FiredBrick].includes(
    ironWorkshopRequest?.content.projectMaterialContribution?.materialId,
  ));
  const ironWorkshopRequestEvent = executePrimitiveAction(
    ironWorkshopState,
    ironWorkshopOwner,
    ironWorkshopRequest,
    25,
    0,
    { cause: 'project', projectId: ironWorkshopProject.id, actionTick: 1 },
  );
  ironWorkshopState.world.past.push(ironWorkshopRequestEvent);
  assert.equal(ironWorkshopRequestEvent.status, 'completed');
  recordProjectAction(ironWorkshopState, ironWorkshopProject.id, ironWorkshopRequestEvent);
  const workshopSite = ironWorkshopProject.site;
  assert.ok(workshopSite);
  const awayFromWorkshop = visibleCellsFor(ironWorkshopOwner)
    .filter((cellId) => cellId !== workshopSite.cellId)
    .flatMap((cellId) => standingPositions(ironWorkshopState.world.grid, cellId))
    .find((position) => position.cellId !== workshopSite.cellId
      || position.z !== workshopSite.z);
  assert.ok(awayFromWorkshop);
  ironWorkshopOwner.position.cellId = awayFromWorkshop.cellId;
  ironWorkshopOwner.position.z = awayFromWorkshop.z;
  const ironWorkshopContribution = recompileProjectNextAction(
    ironWorkshopState,
    ironWorkshopHolder,
    ironWorkshopProject.id,
  );
  assert.equal(ironWorkshopContribution?.kind, 'transfer',
    '收到铁匠铺缺料请求的可见持料者应能向 construction 项目固定地点真实交付');
  assert.equal(ironWorkshopContribution?.authorizationRef, ironWorkshopRequestEvent.id);
  assert.equal(ironWorkshopContribution?.to.kind, 'ground',
    '所有者不在场时，贡献者应把材料真实留在固定工地而不是追逐人物');
  let ironWorkshopOrder = 1;
  const firstWorkshopContributionEvent = executePrimitiveAction(
    ironWorkshopState,
    ironWorkshopHolder,
    ironWorkshopContribution,
    25,
    ironWorkshopOrder,
    { cause: 'project', projectId: ironWorkshopProject.id, actionTick: 2 },
  );
  ironWorkshopOrder += 1;
  ironWorkshopState.world.past.push(firstWorkshopContributionEvent);
  recordProjectAction(ironWorkshopState, ironWorkshopProject.id, firstWorkshopContributionEvent);
  assert.equal(firstWorkshopContributionEvent.status, 'completed');
  assert.ok(ironWorkshopState.world.drops.some((drop) => (
    drop.materialId === ironWorkshopContribution.materialId
    && drop.cellId === workshopSite.cellId
    && drop.z === workshopSite.z
    && drop.sourceEventIds.includes(firstWorkshopContributionEvent.id)
  )), '贡献完成但所有者不在场时，材料必须保留为工地上可拾取的实体');
  const boundWorkshopDrop = ironWorkshopState.world.drops.find((drop) => (
    drop.sourceEventIds.includes(firstWorkshopContributionEvent.id)
  ));
  assert.deepEqual(boundWorkshopDrop?.projectMaterialDelivery, {
    version: 'project-material-delivery-v1',
    projectId: ironWorkshopProject.id,
    requestEventId: ironWorkshopRequestEvent.id,
    requesterId: ironWorkshopOwner.id,
    expiresAtMonth: ironWorkshopRequest.content.projectMaterialContribution.expiresAtMonth,
  }, '授权落地的材料必须保存 request、project、requester 与有效期');

  const learnedRestrictionState = structuredClone(ironWorkshopState);
  const learnedIntruder = learnedRestrictionState.people[2];
  const learnedBoundDrop = learnedRestrictionState.world.drops.find((drop) => drop.id === boundWorkshopDrop.id);
  assert.ok(learnedIntruder && learnedBoundDrop?.projectMaterialDelivery);
  const learnedExpiryMonth = learnedBoundDrop.projectMaterialDelivery.expiresAtMonth;
  learnedRestrictionState.clock.elapsedMonths = learnedExpiryMonth - 1;
  learnedIntruder.position.cellId = learnedBoundDrop.cellId;
  learnedIntruder.position.z = learnedBoundDrop.z;
  const beforeLearningContext = buildDecisionContexts(learnedRestrictionState, learnedExpiryMonth)
    .find((context) => context.person.id === learnedIntruder.id);
  assert.ok(beforeLearningContext?.visibleDrops.some((drop) => drop.id === learnedBoundDrop.id));
  assert.ok(beforeLearningContext?.options.some((option) => option.target?.kind === 'drop'
    && option.target.dropId === learnedBoundDrop.id),
  '不知道交付资格的无关人物仍可从可见事实形成第一次真实领取尝试');
  learnedIntruder.memories = Array.from({ length: 24 }, (_, index) => ({
    id: `memory:test-capacity:${index}`,
    kind: 'commitment',
    summary: `既有约定 ${index}`,
    importance: 64,
    createdAtMonth: index,
    lastRecalledAtMonth: index,
    personIds: [],
    sourceEventIds: [],
  }));
  const learnedBlockedPickup = executePrimitiveAction(
    learnedRestrictionState,
    learnedIntruder,
    {
      kind: 'transfer',
      materialId: learnedBoundDrop.materialId,
      quantity: 1,
      from: { kind: 'ground', cellId: learnedBoundDrop.cellId, z: learnedBoundDrop.z },
      to: { kind: 'person', personId: learnedIntruder.id },
      dropId: learnedBoundDrop.id,
    },
    learnedExpiryMonth,
    2,
    { cause: 'intent', intentId: 'intent-test-project-delivery-restriction', actionTick: 3 },
  );
  assert.equal(learnedBlockedPickup.diff.projectMaterialDeliveryRestricted, true);
  learnedRestrictionState.world.past.push(learnedBlockedPickup);
  rememberAction(learnedRestrictionState, learnedBlockedPickup);
  assert.equal(learnedIntruder.memories.find((memory) => memory.sourceEventIds.includes(learnedBlockedPickup.id))?.expiresAtMonth,
    learnedExpiryMonth,
  '受限领取失败记忆只需稳定保留到当前请求绑定的到期月');
  maintainMemories(learnedRestrictionState, learnedExpiryMonth);
  assert.ok(learnedIntruder.memories.some((memory) => memory.sourceEventIds.includes(learnedBlockedPickup.id)),
    '即使记忆已满，绑定仍有效时的月度维护也必须保留本人刚学到的领取失败');
  const afterLearningContext = buildDecisionContexts(learnedRestrictionState, learnedExpiryMonth)
    .find((context) => context.person.id === learnedIntruder.id);
  assert.ok(afterLearningContext?.visibleDrops.some((drop) => drop.id === learnedBoundDrop.id),
    '失败记忆不能删除仍然可见的地面事实');
  assert.equal(afterLearningContext?.options.some((option) => option.target?.kind === 'drop'
    && option.target.dropId === learnedBoundDrop.id), false,
  '同一绑定未变化时，本人不应在已知失败后再次锁定同一领取候选');
  const learnedEvidence = buildLocalMaterialEvidence(learnedRestrictionState, learnedIntruder, {
    visibleCells: afterLearningContext.visibleCells,
    visibleDrops: afterLearningContext.visibleDrops,
    visiblePeople: afterLearningContext.visiblePeople,
  });
  assert.ok(learnedEvidence.observedMaterialIds.has(learnedBoundDrop.materialId));
  assert.equal(learnedEvidence.accessiblePortableMaterialIds.has(learnedBoundDrop.materialId), false,
    '亲自失败后仍可观察该物料，但不能再把同一绑定物当成可取得证据');
  learnedRestrictionState.clock.elapsedMonths = learnedExpiryMonth;
  maintainMemories(learnedRestrictionState, learnedExpiryMonth + 1);
  const afterReleaseContext = buildDecisionContexts(learnedRestrictionState, learnedExpiryMonth + 1)
    .find((context) => context.person.id === learnedIntruder.id);
  assert.ok(afterReleaseContext?.options.some((option) => option.target?.kind === 'drop'
    && option.target.dropId === learnedBoundDrop.id),
  '绑定到期次月，旧失败记忆不能阻止已经恢复公共语义的地面物');

  const guardedDeliveryState = structuredClone(ironWorkshopState);
  const guardedIntruder = guardedDeliveryState.people[2];
  const guardedBoundDrop = guardedDeliveryState.world.drops.find((drop) => drop.id === boundWorkshopDrop.id);
  assert.ok(guardedIntruder && guardedBoundDrop);
  guardedIntruder.position.cellId = guardedBoundDrop.cellId;
  guardedIntruder.position.z = guardedBoundDrop.z;
  const ordinaryDrop = addDrop(
    guardedDeliveryState,
    guardedBoundDrop.materialId,
    1,
    guardedBoundDrop.cellId,
    25,
    ['ordinary-public-source'],
    'ordinary-public',
    undefined,
    guardedBoundDrop.z,
  );
  assert.notEqual(ordinaryDrop.id, guardedBoundDrop.id,
    '同地同材的普通资源不能与 request-bound 交付物合并后继承错误资格');
  const guardedExpiryMonth = guardedBoundDrop.projectMaterialDelivery.expiresAtMonth;
  const intruderContext = buildDecisionContexts(guardedDeliveryState, guardedExpiryMonth)
    .find((context) => context.person.id === guardedIntruder.id);
  assert.ok(intruderContext?.visibleDrops.some((drop) => drop.id === ordinaryDrop.id));
  assert.equal(intruderContext?.visibleDrops.some((drop) => drop.id === guardedBoundDrop.id), true,
    'request-bound 交付物仍是可感知的地面事实，领取资格只能在真实转移时校验');
  const blockedCompetingPickup = executePrimitiveAction(
    guardedDeliveryState,
    guardedIntruder,
    {
      kind: 'transfer',
      materialId: guardedBoundDrop.materialId,
      quantity: 1,
      from: { kind: 'ground', cellId: guardedBoundDrop.cellId, z: guardedBoundDrop.z },
      to: { kind: 'person', personId: guardedIntruder.id },
      dropId: guardedBoundDrop.id,
    },
    guardedExpiryMonth,
    2,
    { cause: 'project', actionTick: 3 },
  );
  assert.equal(blockedCompetingPickup.status, 'blocked');
  assert.equal(blockedCompetingPickup.diff.projectMaterialDeliveryRestricted, true);
  const ordinaryPickup = executePrimitiveAction(
    guardedDeliveryState,
    guardedIntruder,
    {
      kind: 'transfer',
      materialId: ordinaryDrop.materialId,
      quantity: 1,
      from: { kind: 'ground', cellId: ordinaryDrop.cellId, z: ordinaryDrop.z },
      to: { kind: 'person', personId: guardedIntruder.id },
      dropId: ordinaryDrop.id,
    },
    25,
    3,
    { cause: 'project', actionTick: 4 },
  );
  assert.equal(ordinaryPickup.status, 'completed', '普通公共 drop 仍须保持原有可取得语义');

  const expiredDeliveryState = structuredClone(ironWorkshopState);
  const expiredIntruder = expiredDeliveryState.people[2];
  const expiredDrop = expiredDeliveryState.world.drops.find((drop) => drop.id === boundWorkshopDrop.id);
  assert.ok(expiredIntruder && expiredDrop);
  expiredIntruder.position.cellId = expiredDrop.cellId;
  expiredIntruder.position.z = expiredDrop.z;
  const expiredPickup = executePrimitiveAction(
    expiredDeliveryState,
    expiredIntruder,
    {
      kind: 'transfer',
      materialId: expiredDrop.materialId,
      quantity: 1,
      from: { kind: 'ground', cellId: expiredDrop.cellId, z: expiredDrop.z },
      to: { kind: 'person', personId: expiredIntruder.id },
      dropId: expiredDrop.id,
    },
    expiredDrop.projectMaterialDelivery.expiresAtMonth + 1,
    2,
    { cause: 'project', actionTick: 3 },
  );
  assert.equal(expiredPickup.status, 'completed', '请求过期后交付物必须重新成为公共资源');

  let returnForContribution = recompileProjectNextAction(
    ironWorkshopState,
    ironWorkshopOwner,
    ironWorkshopProject.id,
  );
  assert.deepEqual(returnForContribution, {
    kind: 'move', toCellId: workshopSite.cellId, toZ: workshopSite.z,
  }, 'fulfilled 的落地交付仍应让 construction owner 返回固定项目工地查收');
  for (let step = 0; step < 12
    && (ironWorkshopOwner.position.cellId !== workshopSite.cellId
      || ironWorkshopOwner.position.z !== workshopSite.z); step += 1) {
    assert.equal(returnForContribution?.kind, 'move');
    const returnEvent = executePrimitiveAction(
      ironWorkshopState,
      ironWorkshopOwner,
      returnForContribution,
      25,
      ironWorkshopOrder,
      { cause: 'project', projectId: ironWorkshopProject.id, actionTick: ironWorkshopOrder + 1 },
    );
    ironWorkshopOrder += 1;
    ironWorkshopState.world.past.push(returnEvent);
    recordProjectAction(ironWorkshopState, ironWorkshopProject.id, returnEvent);
    assert.notEqual(returnEvent.status, 'blocked');
    if (ironWorkshopOwner.position.cellId !== workshopSite.cellId
      || ironWorkshopOwner.position.z !== workshopSite.z) {
      returnForContribution = recompileProjectNextAction(
        ironWorkshopState,
        ironWorkshopOwner,
        ironWorkshopProject.id,
      );
    }
  }
  assert.equal(ironWorkshopOwner.position.cellId, workshopSite.cellId);
  assert.equal(ironWorkshopOwner.position.z, workshopSite.z);
  const collectWorkshopContribution = recompileProjectNextAction(
    ironWorkshopState,
    ironWorkshopOwner,
    ironWorkshopProject.id,
  );
  assert.equal(collectWorkshopContribution?.kind, 'transfer');
  assert.equal(collectWorkshopContribution?.from.kind, 'ground',
    '所有者返场后必须通过真实拾取取得贡献材料，不能只靠请求 fulfilled 加入背包');
  assert.equal(collectWorkshopContribution?.materialId, ironWorkshopContribution.materialId);
  const collectWorkshopContributionEvent = executePrimitiveAction(
    ironWorkshopState,
    ironWorkshopOwner,
    collectWorkshopContribution,
    25,
    ironWorkshopOrder,
    { cause: 'project', projectId: ironWorkshopProject.id, actionTick: ironWorkshopOrder + 1 },
  );
  ironWorkshopOrder += 1;
  ironWorkshopState.world.past.push(collectWorkshopContributionEvent);
  recordProjectAction(ironWorkshopState, ironWorkshopProject.id, collectWorkshopContributionEvent);
  assert.equal(collectWorkshopContributionEvent.status, 'completed');

  const secondWorkshopRequest = recompileProjectNextAction(
    ironWorkshopState,
    ironWorkshopOwner,
    ironWorkshopProject.id,
  );
  assert.equal(secondWorkshopRequest?.kind, 'communicate', '第一份材料交付后应请求另一项真实缺料');
  assert.notEqual(
    secondWorkshopRequest?.content.projectMaterialContribution?.materialId,
    ironWorkshopRequest?.content.projectMaterialContribution?.materialId,
  );
  const secondWorkshopRequestEvent = executePrimitiveAction(
    ironWorkshopState,
    ironWorkshopOwner,
    secondWorkshopRequest,
    25,
    ironWorkshopOrder,
    { cause: 'project', projectId: ironWorkshopProject.id, actionTick: ironWorkshopOrder + 1 },
  );
  ironWorkshopOrder += 1;
  ironWorkshopState.world.past.push(secondWorkshopRequestEvent);
  recordProjectAction(ironWorkshopState, ironWorkshopProject.id, secondWorkshopRequestEvent);
  assert.equal(secondWorkshopRequestEvent.status, 'completed');
  const secondWorkshopContribution = recompileProjectNextAction(
    ironWorkshopState,
    ironWorkshopHolder,
    ironWorkshopProject.id,
  );
  assert.equal(secondWorkshopContribution?.kind, 'transfer');
  const secondWorkshopContributionEvent = executePrimitiveAction(
    ironWorkshopState,
    ironWorkshopHolder,
    secondWorkshopContribution,
    25,
    ironWorkshopOrder,
    { cause: 'project', projectId: ironWorkshopProject.id, actionTick: ironWorkshopOrder + 1 },
  );
  ironWorkshopOrder += 1;
  ironWorkshopState.world.past.push(secondWorkshopContributionEvent);
  recordProjectAction(ironWorkshopState, ironWorkshopProject.id, secondWorkshopContributionEvent);
  assert.equal(secondWorkshopContributionEvent.status, 'completed');

  const smithyAssembly = recompileProjectNextAction(
    ironWorkshopState,
    ironWorkshopOwner,
    ironWorkshopProject.id,
  );
  assert.equal(smithyAssembly?.kind, 'act');
  assert.equal(smithyAssembly?.operation, 'combine', '两项贡献实际到手后，应通过有限实体假说组装 Smithy');
  const smithyAssemblyEvent = executePrimitiveAction(
    ironWorkshopState,
    ironWorkshopOwner,
    smithyAssembly,
    25,
    ironWorkshopOrder,
    { cause: 'project', projectId: ironWorkshopProject.id, actionTick: ironWorkshopOrder + 1 },
  );
  ironWorkshopOrder += 1;
  ironWorkshopState.world.past.push(smithyAssemblyEvent);
  recordProjectAction(ironWorkshopState, ironWorkshopProject.id, smithyAssemblyEvent);
  assert.equal(smithyAssemblyEvent.status, 'completed');
  assert.equal(smithyAssemblyEvent.diff.outputMaterialId, Material.Smithy);
  assert.equal(ironWorkshopProject.status, 'active', 'Smithy 构件尚未落地时项目不能提前完成');

  const smithyVerification = recompileProjectNextAction(
    ironWorkshopState,
    ironWorkshopOwner,
    ironWorkshopProject.id,
  );
  assert.equal(smithyVerification?.kind, 'attend', '首次 Smithy 组装响应必须先核验真实构件');
  const smithyVerificationEvent = executePrimitiveAction(
    ironWorkshopState,
    ironWorkshopOwner,
    smithyVerification,
    25,
    ironWorkshopOrder,
    { cause: 'project', projectId: ironWorkshopProject.id, actionTick: ironWorkshopOrder + 1 },
  );
  ironWorkshopOrder += 1;
  ironWorkshopState.world.past.push(smithyVerificationEvent);
  recordProjectAction(ironWorkshopState, ironWorkshopProject.id, smithyVerificationEvent);
  assert.equal(smithyVerificationEvent.status, 'completed');
  const smithyPlacement = recompileProjectNextAction(
    ironWorkshopState,
    ironWorkshopOwner,
    ironWorkshopProject.id,
  );
  assert.equal(smithyPlacement?.kind, 'act');
  assert.equal(smithyPlacement?.operation, 'combine', '核验后的 Smithy 构件仍须实体落地');
  assert.ok(smithyPlacement?.targets.some((target) => target.kind === 'voxel'));
  const smithyPlacementEvent = executePrimitiveAction(
    ironWorkshopState,
    ironWorkshopOwner,
    smithyPlacement,
    25,
    ironWorkshopOrder,
    { cause: 'project', projectId: ironWorkshopProject.id, actionTick: ironWorkshopOrder + 1 },
  );
  ironWorkshopOrder += 1;
  ironWorkshopState.world.past.push(smithyPlacementEvent);
  recordProjectAction(ironWorkshopState, ironWorkshopProject.id, smithyPlacementEvent);
  assert.equal(smithyPlacementEvent.status, 'completed');
  assert.equal(smithyPlacementEvent.diff.outputMaterialId, Material.Smithy);
  assert.equal(ironWorkshopProject.status, 'completed',
    '贡献请求、两次交付、组装、核验和落地必须闭合为可回放的 Smithy 项目');

  const ironContributionState = createInitialState(9209, { endpoint: { kind: 'months', value: 60 }, chaosIntensity: 0 });
  ironContributionState.clock.elapsedMonths = 24;
  ironContributionState.projects = [];
  const ironContributionOwner = ironContributionState.people[0];
  const ironContributionHolder = ironContributionState.people[1];
  ironContributionState.people = [ironContributionOwner, ironContributionHolder];
  const contributionSmithyCell = neighbors4(ironContributionOwner.position.cellId)[0];
  setVoxel(
    ironContributionState.world.grid,
    cellX(contributionSmithyCell),
    cellY(contributionSmithyCell),
    ironContributionOwner.position.z,
    Material.Smithy,
  );
  const contributionSmithySite = knownFacilitySite(
    ironContributionState,
    ironContributionOwner,
    [Material.Smithy],
  );
  const contributionSmithyWorkplace = contributionSmithySite
    ? fixedFacilityWorkplace(
      ironContributionState,
      ironContributionOwner,
      contributionSmithySite,
      [Material.Smithy],
    )
    : null;
  assert.ok(contributionSmithySite && contributionSmithyWorkplace);
  ironContributionOwner.position.cellId = contributionSmithyWorkplace.workingPosition.cellId;
  ironContributionOwner.position.z = contributionSmithyWorkplace.workingPosition.z;
  placeWith(ironContributionHolder, ironContributionOwner);
  ironContributionOwner.inventory = [];
  ironContributionHolder.inventory = [stack('contributed-iron-charge', Material.IronCharge)];
  const ironContributionProject = instantiateProject({
    id: 'test-iron-reduction-contribution',
    kind: 'production',
    need: 'iron-capability',
    desiredFunction: 'iron-reduction',
    summary: '在固定铁匠铺还原铁料',
    ownerId: ironContributionOwner.id,
    beneficiaryIds: [ironContributionOwner.id, ironContributionHolder.id],
    triggerFactIds: ['observed-contributed-iron-charge'],
    pressure: 70,
    createdAtMonth: 25,
    reviewAtMonth: 60,
    site: contributionSmithySite,
  });
  ironContributionState.projects.push(ironContributionProject);
  const ironReductionRequest = recompileProjectNextAction(
    ironContributionState,
    ironContributionOwner,
    ironContributionProject.id,
  );
  assert.equal(ironReductionRequest?.kind, 'communicate');
  const ironReductionRequestEvent = executePrimitiveAction(
    ironContributionState,
    ironContributionOwner,
    ironReductionRequest,
    25,
    0,
    { cause: 'project', projectId: ironContributionProject.id, actionTick: 1 },
  );
  ironContributionState.world.past.push(ironReductionRequestEvent);
  assert.equal(ironReductionRequestEvent.status, 'completed');
  const ironReductionContribution = recompileProjectNextAction(
    ironContributionState,
    ironContributionHolder,
    ironContributionProject.id,
  );
  assert.equal(ironReductionContribution?.kind, 'transfer',
    '铁器生产贡献必须把真实材料送到项目锚定的 Smithy 工位');
  assert.equal(ironReductionContribution?.authorizationRef, ironReductionRequestEvent.id);

  const writtenCarrierState = createInitialState(9208, { endpoint: { kind: 'months', value: 60 }, chaosIntensity: 0 });
  writtenCarrierState.clock.elapsedMonths = 24;
  writtenCarrierState.projects = [];
  const writtenCarrierOwner = writtenCarrierState.people[0];
  const writtenCarrierHolder = writtenCarrierState.people[1];
  for (const person of writtenCarrierState.people) placeWith(person, writtenCarrierOwner);
  writtenCarrierOwner.inventory = [
    stack('written-test-bronze', Material.Bronze),
    stack('written-test-brick', Material.FiredBrick),
    stack('written-test-wood', Material.Wood),
    stack('written-test-tool', Material.StoneTool),
  ];
  writtenCarrierHolder.inventory = [{
    ...stack('already-written-tablet', Material.WoodTablet),
    recordPayloadId: 'record:already-used',
  }];
  const writtenCarrierProposal = deriveProjectProposals(
    writtenCarrierState,
    writtenCarrierOwner,
    visibleCellsFor(writtenCarrierOwner),
    [],
    writtenCarrierState.people,
  ).find((proposal) => proposal.desiredFunction === 'civic-coordination');
  assert.ok(writtenCarrierProposal);
  const writtenCarrierProject = instantiateProject(writtenCarrierProposal);
  writtenCarrierState.projects.push(writtenCarrierProject);
  const writtenCarrierAction = recompileProjectNextAction(
    writtenCarrierState,
    writtenCarrierOwner,
    writtenCarrierProject.id,
  );
  assert.equal(writtenCarrierAction?.kind, 'act');
  assert.equal(writtenCarrierAction?.operation, 'exert',
    '附近只有已写木牍时，公共厅堂应制作新的空白载体，不能请求并消费记录实体');
  assert.ok(writtenCarrierAction?.targets.some((target) => target.kind === 'inventory-stack'
    && target.stackId === 'written-test-wood'));

  const blankCarrierState = createInitialState(9210, { endpoint: { kind: 'months', value: 60 }, chaosIntensity: 0 });
  blankCarrierState.clock.elapsedMonths = 24;
  blankCarrierState.projects = [];
  const blankCarrierOwner = blankCarrierState.people[0];
  const blankCarrierHolder = blankCarrierState.people[1];
  for (const person of blankCarrierState.people) placeWith(person, blankCarrierOwner);
  blankCarrierOwner.inventory = [
    stack('blank-request-bronze', Material.Bronze),
    stack('blank-request-brick', Material.FiredBrick),
    {
      ...stack('owner-written-tablet', Material.WoodTablet),
      recordPayloadId: 'record:owner-preserved',
    },
  ];
  blankCarrierHolder.inventory = [stack('holder-blank-tablet', Material.WoodTablet)];
  const blankCarrierProposal = deriveProjectProposals(
    blankCarrierState,
    blankCarrierOwner,
    visibleCellsFor(blankCarrierOwner),
    [],
    blankCarrierState.people,
  ).find((proposal) => proposal.desiredFunction === 'civic-coordination');
  assert.ok(blankCarrierProposal);
  const blankCarrierProject = instantiateProject(blankCarrierProposal);
  blankCarrierState.projects.push(blankCarrierProject);
  const blankCarrierRequest = recompileProjectNextAction(
    blankCarrierState,
    blankCarrierOwner,
    blankCarrierProject.id,
  );
  assert.equal(blankCarrierRequest?.kind, 'communicate');
  assert.equal(blankCarrierRequest?.content.projectMaterialContribution?.materialId, Material.WoodTablet,
    '所有者的已写木牍不能填平 civic 空白载体缺口');
  const blankCarrierRequestEvent = executePrimitiveAction(
    blankCarrierState,
    blankCarrierOwner,
    blankCarrierRequest,
    25,
    0,
    { cause: 'project', projectId: blankCarrierProject.id, actionTick: 1 },
  );
  blankCarrierState.world.past.push(blankCarrierRequestEvent);
  recordProjectAction(blankCarrierState, blankCarrierProject.id, blankCarrierRequestEvent);
  assert.equal(blankCarrierRequestEvent.status, 'completed');
  const blankRequestBasis = blankCarrierProject.materialContributionRequests?.[0];
  const blankDemand = blankCarrierProject.materialDemands?.find((demand) => (
    demand.materialId === Material.WoodTablet
  ));
  assert.ok(blankRequestBasis && blankDemand);
  assert.equal(inspectProjectMaterialContributionRequest(
    blankCarrierState,
    blankCarrierProject,
    blankRequestBasis,
    25,
    blankDemand,
  ).status, 'open', '域层请求检查也必须排除所有者的已写木牍');
  const blankCarrierContribution = recompileProjectNextAction(
    blankCarrierState,
    blankCarrierHolder,
    blankCarrierProject.id,
  );
  assert.equal(blankCarrierContribution?.kind, 'transfer');
  assert.equal(blankCarrierContribution?.stackId, 'holder-blank-tablet');
  const blankCarrierContributionEvent = executePrimitiveAction(
    blankCarrierState,
    blankCarrierHolder,
    blankCarrierContribution,
    25,
    1,
    { cause: 'project', projectId: blankCarrierProject.id, actionTick: 2 },
  );
  blankCarrierState.world.past.push(blankCarrierContributionEvent);
  recordProjectAction(blankCarrierState, blankCarrierProject.id, blankCarrierContributionEvent);
  assert.equal(blankCarrierContributionEvent.status, 'completed');
  const fulfilledBlankRequest = inspectProjectMaterialContributionRequest(
    blankCarrierState,
    blankCarrierProject,
    blankRequestBasis,
    25,
    blankDemand,
  );
  assert.equal(fulfilledBlankRequest.status, 'fulfilled');
  assert.equal(fulfilledBlankRequest.contributedQuantity, 1);
  assert.ok(blankCarrierOwner.inventory.some((item) => item.id === 'owner-written-tablet'
    && item.recordPayloadId === 'record:owner-preserved'),
  '真实交付空白木牍后，所有者原有的已写记录必须保留');

  const workplaceState = createInitialState(9202, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const worker = workplaceState.people[0];
  const adjacent = neighbors4(worker.position.cellId);
  assert.ok(adjacent.length >= 2, '测试世界需要至少两个相邻格');
  const kilnCell = adjacent[0];
  const foundryCell = adjacent[1];
  setVoxel(workplaceState.world.grid, cellX(kilnCell), cellY(kilnCell), worker.position.z, Material.Kiln);
  setVoxel(workplaceState.world.grid, cellX(foundryCell), cellY(foundryCell), worker.position.z, Material.Foundry);
  const metallurgySite = knownFacilitySite(workplaceState, worker);
  assert.ok(metallurgySite, '可见高温设施应形成固定冶金工位');
  assert.equal(
    voxelAt(workplaceState.world.grid, cellX(metallurgySite.cellId), cellY(metallurgySite.cellId), metallurgySite.z),
    Material.Foundry,
    '铸造场建成后，后续冶金项目应优先返回铸造场而不是旧陶窑',
  );
  const foundryWorkplace = fixedFacilityWorkplace(workplaceState, worker, metallurgySite);
  assert.ok(foundryWorkplace, '选中的铸造场必须存在可抵达工位');
  worker.position.cellId = foundryWorkplace.workingPosition.cellId;
  worker.position.z = foundryWorkplace.workingPosition.z;
  worker.position.previousCellId = worker.position.cellId;
  worker.position.previousZ = worker.position.z;
  worker.inventory = [
    stack('foundry-bronze', Material.Bronze),
    stack('foundry-wood', Material.Wood),
  ];
  const foundryTechniqueId = `technique:combine-inventory:${Material.Wood}x1+${Material.Bronze}x1:${Material.BronzeTool}`;
  worker.knowledge = [{
    id: foundryTechniqueId,
    kind: 'technique',
    summary: '青铜与木材可结合为青铜生产工具',
    confidence: 68,
    learnedAtMonth: 1,
    sourceEventIds: ['foundry-technique-source'],
  }];
  const foundryProject = instantiateProject({
    id: 'test-foundry-production',
    kind: 'production',
    need: 'alloy-capability',
    desiredFunction: 'bronze-tooling',
    summary: '让铸造场承接青铜工具生产',
    ownerId: worker.id,
    beneficiaryIds: [worker.id],
    triggerFactIds: ['foundry-demand-source'],
    pressure: 80,
    productionToolBaselineRank: 1,
    createdAtMonth: 1,
    reviewAtMonth: 24,
    site: metallurgySite,
  });
  workplaceState.projects = [foundryProject];
  const foundryAction = recompileProjectNextAction(workplaceState, worker, foundryProject.id);
  assert.equal(foundryAction?.kind, 'act', '到达铸造场且持有材料时应编译出真实生产行动');
  const foundryEvent = executePrimitiveAction(
    workplaceState,
    worker,
    foundryAction,
    2,
    0,
    { cause: 'project', projectId: foundryProject.id, actionTick: 1 },
  );
  assert.equal(foundryEvent.status, 'completed');
  assert.equal(foundryEvent.diff.facilityMaterialId, Material.Foundry,
    '青铜工具生产事件必须把铸造场记录为实际承接设施');
  assert.equal(foundryEvent.diff.outputQuantity, 2,
    '铸造场承接生产时应兑现实体批量加成');

  const ironChainState = createInitialState(9207, { endpoint: { kind: 'months', value: 60 }, chaosIntensity: 0 });
  ironChainState.clock.elapsedMonths = 24;
  ironChainState.projects = [];
  ironChainState.world.past = [];
  const ironWorker = ironChainState.people[0];
  ironChainState.people = [ironWorker];
  const smithyCell = neighbors4(ironWorker.position.cellId)[0];
  setVoxel(
    ironChainState.world.grid,
    cellX(smithyCell),
    cellY(smithyCell),
    ironWorker.position.z,
    Material.Smithy,
  );
  const smithySite = knownFacilitySite(ironChainState, ironWorker, [Material.Smithy]);
  assert.ok(smithySite, '可见铁匠铺必须形成铁器链的固定工位锚点');
  const smithyWorkplace = fixedFacilityWorkplace(ironChainState, ironWorker, smithySite, [Material.Smithy]);
  assert.ok(smithyWorkplace, '铁匠铺必须有可抵达的合法施作位置');
  ironWorker.position.cellId = smithyWorkplace.workingPosition.cellId;
  ironWorker.position.z = smithyWorkplace.workingPosition.z;
  ironWorker.position.previousCellId = ironWorker.position.cellId;
  ironWorker.position.previousZ = ironWorker.position.z;
  ironWorker.inventory = [
    stack('chain-iron-ore', Material.IronOre),
    stack('chain-charcoal', Material.Charcoal, 3),
    stack('chain-wood', Material.Wood),
  ];

  const commitIronProjectAction = (project, action, atMonth, expectCompleted = true) => {
    const event = executePrimitiveAction(
      ironChainState,
      ironWorker,
      action,
      atMonth,
      0,
      { cause: 'project', projectId: project.id, actionTick: 1 },
    );
    ironChainState.world.past.push(event);
    recordProjectAction(ironChainState, project.id, event);
    ironChainState.clock.elapsedMonths = atMonth;
    assert.equal(event.status, 'completed', event.result);
    assert.equal(project.status, expectCompleted ? 'completed' : 'active',
      `${project.desiredFunction} 的结算状态必须符合实体输出与核验门槛`);
    return event;
  };
  const proposeIronFunction = (desiredFunction) => {
    const proposal = deriveProjectProposals(
      ironChainState,
      ironWorker,
      visibleCellsFor(ironWorker),
      [],
      [ironWorker],
    ).find((candidate) => candidate.desiredFunction === desiredFunction);
    assert.ok(proposal, `已观察前置和固定 Smithy 时应提出 ${desiredFunction}`);
    assert.deepEqual(proposal.site, smithySite, `${desiredFunction} 必须锚定真实 Smithy`);
    const project = instantiateProject(proposal);
    ironChainState.projects.push(project);
    return project;
  };

  const chargeProject = proposeIronFunction('iron-charge');
  const chargeAction = recompileProjectNextAction(ironChainState, ironWorker, chargeProject.id);
  assert.equal(chargeAction?.kind, 'act');
  assert.equal(chargeAction?.operation, 'combine', '铁料配比应由项目假说编译成真实背包结合，而非直接授予产物');
  const chargeEvent = commitIronProjectAction(chargeProject, chargeAction, 25);
  assert.equal(chargeEvent.diff.outputMaterialId, Material.IronCharge);

  const reductionProject = proposeIronFunction('iron-reduction');
  const reductionAction = recompileProjectNextAction(ironChainState, ironWorker, reductionProject.id);
  assert.equal(reductionAction?.kind, 'act', JSON.stringify({
    reductionAction,
    inventory: ironWorker.inventory,
    project: reductionProject,
    smithySite,
    personPosition: ironWorker.position,
  }));
  assert.equal(reductionAction?.operation, 'expose',
    'iron-reduction 必须把随身 IronCharge 暴露给项目锚定的 Smithy');
  assert.deepEqual(reductionAction?.targets[1], {
    kind: 'voxel', position: smithyWorkplace.target.position,
  });
  const reductionEvent = commitIronProjectAction(reductionProject, reductionAction, 26);
  assert.equal(reductionEvent.diff.outputMaterialId, Material.IronBloom);
  assert.equal(reductionEvent.diff.targetMaterialId, Material.Smithy);

  const workingProject = proposeIronFunction('iron-working');
  const workingAction = recompileProjectNextAction(ironChainState, ironWorker, workingProject.id);
  assert.equal(workingAction?.kind, 'act');
  assert.equal(workingAction?.operation, 'combine');
  const workingEvent = commitIronProjectAction(workingProject, workingAction, 27);
  assert.equal(workingEvent.diff.outputMaterialId, Material.Iron);

  const toolingProject = proposeIronFunction('iron-tooling');
  const toolingAction = recompileProjectNextAction(ironChainState, ironWorker, toolingProject.id);
  assert.equal(toolingAction?.kind, 'act');
  assert.equal(toolingAction?.operation, 'combine');
  const toolingEvent = commitIronProjectAction(toolingProject, toolingAction, 28, false);
  assert.equal(toolingEvent.diff.outputMaterialId, Material.IronTool);
  assert.equal(toolingEvent.diff.facilityMaterialId, Material.Smithy,
    '铁制工具的真实生产事件必须记录承接它的 Smithy');
  const toolingVerification = recompileProjectNextAction(ironChainState, ironWorker, toolingProject.id);
  assert.equal(toolingVerification?.kind, 'attend', '铁制工具样品必须经过来源绑定的核验才能结算能力项目');
  const verificationEvent = executePrimitiveAction(
    ironChainState,
    ironWorker,
    toolingVerification,
    29,
    0,
    { cause: 'project', projectId: toolingProject.id, actionTick: 1 },
  );
  ironChainState.world.past.push(verificationEvent);
  recordProjectAction(ironChainState, toolingProject.id, verificationEvent);
  assert.equal(verificationEvent.status, 'completed');
  assert.equal(toolingProject.status, 'completed', '核验铁器制作经验后应完成工具能力项目');

  const adoptionState = createInitialState(9203, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
  adoptionState.clock.elapsedMonths = 12;
  const requester = adoptionState.people[0];
  const holder = adoptionState.people[1];
  requester.bornAtMonth = -20 * 12;
  holder.bornAtMonth = -20 * 12;
  placeWith(holder, requester);
  requester.inventory = [stack('requester-goods', Material.Food, 2)];
  holder.inventory = [
    stack('holder-bronze-tool', Material.BronzeTool),
    stack('holder-backup-tool', Material.StoneTool),
  ];
  const requesterLabor = laborFact(requester, 12, 'requester-recent-production');
  adoptionState.world.past.push(requesterLabor);
  const requesterContext = buildDecisionContexts(adoptionState)
    .find((context) => context.person.id === requester.id);
  const upgradeOffer = requesterContext?.options.find((option) => option.id.startsWith('offer-tool-upgrade:'));
  assert.ok(upgradeOffer, '近期劳动者应能向保有备用工具的人提出高阶工具交换');
  assert.ok(upgradeOffer.sourceFactIds.includes(requesterLabor.id), '工具采用动机必须引用本人真实劳动');

  const legacyTradeState = createInitialState(9205, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
  legacyTradeState.clock.elapsedMonths = 12;
  const legacyRequester = legacyTradeState.people[0];
  const legacyHolder = legacyTradeState.people[1];
  legacyRequester.bornAtMonth = -20 * 12;
  legacyHolder.bornAtMonth = -20 * 12;
  placeWith(legacyHolder, legacyRequester);
  legacyRequester.inventory = [stack('legacy-requester-goods', Material.Food, 2)];
  legacyHolder.inventory = [
    stack('legacy-holder-wood-tool', Material.WoodTool),
    stack('legacy-holder-stone-tool', Material.StoneTool),
  ];
  legacyTradeState.world.past.push(laborFact(legacyRequester, 12, 'legacy-requester-production'));
  const legacyContext = buildDecisionContexts(legacyTradeState)
    .find((context) => context.person.id === legacyRequester.id);
  assert.ok(legacyContext?.options.some((option) => option.id.includes('legacy-holder-wood-tool')),
    '新增青铜单件交换不能覆盖“有更高阶备用工具时交换低阶单件工具”的既有路径');

  const teachingState = createInitialState(9204, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
  teachingState.clock.elapsedMonths = 12;
  const teacher = teachingState.people[0];
  const learner = teachingState.people[1];
  teacher.bornAtMonth = -20 * 12;
  learner.bornAtMonth = -16 * 12;
  placeWith(learner, teacher);
  const bronzeToolTechniqueId = `technique:combine-inventory:${Material.Wood}x1+${Material.Bronze}x1:${Material.BronzeTool}`;
  teacher.knowledge = [
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `codebook:test-${index}`,
      kind: 'codebook',
      summary: `高置信记录 ${index}`,
      confidence: 100,
      learnedAtMonth: 1,
      sourceEventIds: [`record:${index}`],
    })),
    {
      id: bronzeToolTechniqueId,
      kind: 'technique',
      summary: '青铜与木材可结合为青铜生产工具',
      confidence: 68,
      learnedAtMonth: 2,
      sourceEventIds: ['bronze-tool-made', 'bronze-tool-verified'],
    },
  ];
  const learnerLabor = laborFact(learner, 12, 'learner-recent-production');
  teachingState.world.past.push(learnerLabor);
  const teacherContext = buildDecisionContexts(teachingState)
    .find((context) => context.person.id === teacher.id);
  const toolTeaching = teacherContext?.options.find((option) => option.id.includes(bronzeToolTechniqueId));
  assert.ok(toolTeaching, '生产者眼前的高阶工具制作技术不应被普通高置信知识挤出教导候选');
  assert.ok(toolTeaching.sourceFactIds.includes(learnerLabor.id), '优先教导必须引用学习者近期真实劳动');

  process.stdout.write('ancient civilization bridge tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
