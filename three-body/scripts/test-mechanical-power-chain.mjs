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
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { inventoryCombinationForOutput, inventoryCombinationTechniqueId } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/interaction-rules.ts'))};
    export { mechanicalPowerNetworkId, mechanicalPowerPlanKey } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/mechanical-power.ts'))};
    export { buildProjectPressureBasis } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-pressure.ts'))};
    export { projectFunctionSatisfied, recordProjectAction, recompileProjectNextAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
    export { mechanicalPowerProposalCandidate } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/mechanical-power-options.ts'))};
    export { cellId, cellsInRadius, setVoxel, voxelAt } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=mechanical-power-chain-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    buildProjectPressureBasis,
    cellId,
    cellsInRadius,
    createInitialState,
    executePrimitiveAction,
    instantiateProject,
    inventoryCombinationForOutput,
    inventoryCombinationTechniqueId,
    mechanicalPowerNetworkId,
    mechanicalPowerPlanKey,
    mechanicalPowerProposalCandidate,
    projectFunctionSatisfied,
    recordProjectAction,
    recompileProjectNextAction,
    setVoxel,
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

  process.stdout.write('mechanical power chain tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
