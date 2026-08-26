import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-crop-processing-anchor-test-'));
const bundlePath = path.join(temporaryDirectory, 'crop-processing-anchor.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export { deriveProjectProposals } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-proposals.ts'))};
    export { compileProjectStep } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-step-compiler.ts'))};
    export { projectCompletionEvidence, projectFunctionSatisfied } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-completion.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { cellId, cellX, cellY, cellsInRadius, setVoxel, voxelAt } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=crop-processing-anchor-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    cellId,
    cellX,
    cellY,
    cellsInRadius,
    compileProjectStep,
    createInitialState,
    deriveProjectProposals,
    executePrimitiveAction,
    instantiateProject,
    projectCompletionEvidence,
    projectFunctionSatisfied,
    setVoxel,
    voxelAt,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  function createFixture(seed) {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
    const actor = state.people[0];
    assert.ok(actor, '定向测试需要至少一名人物');
    const center = cellId(42, 26);
    for (const localCell of cellsInRadius(center, 9)) {
      for (let z = 0; z < state.world.grid.levels; z += 1) {
        setVoxel(state.world.grid, cellX(localCell), cellY(localCell), z, z === 0 ? Material.PackedSoil : Material.Air);
      }
    }
    state.people = [actor];
    state.projects = [];
    state.world.drops = [];
    state.world.past = [];
    actor.position = {
      cellId: center,
      z: 1,
      previousCellId: center,
      previousZ: 1,
      lastPath: [],
      tickPath: [center],
    };
    actor.body = { health: 100, hydration: 100, nutrition: 25 };
    actor.conditions = [];
    actor.inventory = [
      { id: 'test-seed', materialId: Material.Seed, quantity: 1, sourceEventIds: ['source:test-seed'] },
      { id: 'test-stone', materialId: Material.Stone, quantity: 1, sourceEventIds: ['source:test-stone'] },
      { id: 'test-plank', materialId: Material.Plank, quantity: 1, sourceEventIds: ['source:test-plank'] },
    ];
    actor.knowledge = [];
    actor.knownPlaces = [];
    actor.memories = [];
    actor.baselineCapacities.perception = 100;
    delete actor.activeIntentId;
    return { state, actor, center, visibleCells: cellsInRadius(center, 9) };
  }

  function cropProcessingProposal(state, actor, visibleCells) {
    const proposal = deriveProjectProposals(state, actor, visibleCells, [], [])
      .find((candidate) => candidate.desiredFunction === 'crop-processing');
    assert.ok(proposal, '真实食物压力、作物/耕地和可见材料应形成作物加工项目');
    assert.ok(proposal.site, '作物加工建设项目必须冻结实体工地');
    return proposal;
  }

  function commitProjectFact(state, project, fact) {
    state.world.past.push(fact);
    if (!project.actionEventIds.includes(fact.id)) project.actionEventIds.push(fact.id);
  }

  function installProjectMill(state, actor, project, orderStart = 1) {
    actor.inventory = [{
      id: `test-mill-${project.id}`,
      materialId: Material.Mill,
      quantity: 1,
      sourceEventIds: [`source:test-mill:${project.id}`],
    }];
    let order = orderStart;
    let step = compileProjectStep(state, actor, [], project);
    while (step?.action.kind === 'move' && order < orderStart + 16) {
      const movement = executePrimitiveAction(state, actor, step.action, 1, order, {
        intentId: `intent:${project.id}`,
        cause: 'intent',
        actionTick: order,
      });
      commitProjectFact(state, project, movement);
      order += 1;
      step = compileProjectStep(state, actor, [], project);
    }
    assert.equal(step?.action.kind, 'act', `应能把磨坊安装到项目工地：${JSON.stringify(step)}`);
    assert.equal(step?.action.kind === 'act' ? step.action.operation : undefined, 'combine');
    const placement = executePrimitiveAction(state, actor, step.action, 1, order, {
      intentId: `intent:${project.id}`,
      cause: 'intent',
      actionTick: order,
    });
    assert.equal(placement.status, 'completed', placement.result);
    commitProjectFact(state, project, placement);
    return { placement, nextOrder: order + 1 };
  }

  {
    const { state, actor, center, visibleCells } = createFixture(9816);
    const matureCropCell = cellId(cellX(center) + 5, cellY(center));
    setVoxel(state.world.grid, cellX(matureCropCell), cellY(matureCropCell), 0, Material.CropMature);

    const proposal = cropProcessingProposal(state, actor, visibleCells);
    const cropDistance = Math.abs(cellX(proposal.site.cellId) - cellX(matureCropCell))
      + Math.abs(cellY(proposal.site.cellId) - cellY(matureCropCell));
    assert.equal(cropDistance, 1,
      '磨坊工地必须锚定本人当前可感知的成熟作物，并处于真实收获有效半径');
    const sitePosition = {
      x: cellX(proposal.site.cellId),
      y: cellY(proposal.site.cellId),
      z: proposal.site.z,
    };
    assert.equal(voxelAt(state.world.grid, sitePosition.x, sitePosition.y, sitePosition.z), Material.Air,
      '冻结的磨坊位置必须是可落地的空气体素');
    assert.notEqual(voxelAt(state.world.grid, sitePosition.x, sitePosition.y, sitePosition.z - 1), Material.Air,
      '冻结的磨坊位置必须有实体承托');

    const project = instantiateProject(proposal);
    state.projects = [project];
    actor.inventory = [{
      id: 'test-mill', materialId: Material.Mill, quantity: 1, sourceEventIds: ['source:test-mill'],
    }];
    let step = compileProjectStep(state, actor, [], project);
    for (let tick = 1; step?.action.kind === 'move' && tick <= 12; tick += 1) {
      const movement = executePrimitiveAction(state, actor, step.action, 1, tick, {
        cause: 'project', projectId: project.id, actionTick: tick,
      });
      assert.ok(movement.status === 'completed' || movement.status === 'progressed', movement.result);
      step = compileProjectStep(state, actor, [], project);
    }
    assert.equal(step?.action.kind, 'act', `人物应返回冻结工地放置磨坊：${JSON.stringify(step)}`);
    assert.equal(step?.action.kind === 'act' ? step.action.operation : undefined, 'combine');
    const placementTarget = step?.action.kind === 'act'
      ? step.action.targets.find((target) => target.kind === 'voxel')
      : undefined;
    assert.deepEqual(placementTarget, { kind: 'voxel', position: sitePosition },
      '最终磨坊不得随贡献者当前位置漂移，必须落在项目冻结的作物加工工地');
    const placement = executePrimitiveAction(state, actor, step.action, 1, 13, {
      intentId: `intent:${project.id}`, cause: 'intent', actionTick: 13,
    });
    assert.equal(placement.status, 'completed', placement.result);
    assert.equal(placement.diff.outputMaterialId, Material.Mill);
    assert.equal(voxelAt(state.world.grid, sitePosition.x, sitePosition.y, sitePosition.z), Material.Mill);
    commitProjectFact(state, project, placement);
    assert.equal(projectFunctionSatisfied(state, project), false,
      '磨坊载体落地只能进入 commissioning，不能直接完成能力项目');

    step = compileProjectStep(state, actor, [], project);
    for (let tick = 14; step?.action.kind === 'move' && tick <= 20; tick += 1) {
      const movement = executePrimitiveAction(state, actor, step.action, 2, tick, {
        intentId: `intent:${project.id}`, cause: 'intent', actionTick: tick,
      });
      assert.ok(movement.status === 'completed' || movement.status === 'progressed', movement.result);
      commitProjectFact(state, project, movement);
      step = compileProjectStep(state, actor, [], project);
    }
    assert.equal(step?.action.kind, 'act', `commissioning 应编译真实收获动作：${JSON.stringify(step)}`);
    assert.equal(step?.action.kind === 'act' ? step.action.operation : undefined, 'separate');
    const harvest = executePrimitiveAction(state, actor, step.action, 2, 21, {
      intentId: `intent:${project.id}`, cause: 'intent', actionTick: 21,
    });
    assert.equal(harvest.status, 'completed', harvest.result);
    assert.equal(harvest.diff.facilityMaterialId, Material.Mill,
      '绑定工地建成的磨坊必须自然进入成熟作物的真实收获后果');
    assert.ok(harvest.diff.outputs.some((output) => output.materialId === Material.Food && output.quantity >= 6),
      '真实服务 diff 必须显示磨坊带来的正食物增量');
    commitProjectFact(state, project, harvest);
    assert.equal(projectFunctionSatisfied(state, project), true,
      '项目谱系内、服务半径内的真实正功能动作才完成项目');
    assert.deepEqual(projectCompletionEvidence(state, project), [placement.id, harvest.id],
      '完成证据只保留 exact installation → service 因果链');
  }

  {
    const { state, actor, center, visibleCells } = createFixture(9818);
    const matureCropCell = cellId(cellX(center) + 5, cellY(center));
    setVoxel(state.world.grid, cellX(matureCropCell), cellY(matureCropCell), 0, Material.CropMature);
    const project = instantiateProject(cropProcessingProposal(state, actor, visibleCells));
    state.projects = [project];
    installProjectMill(state, actor, project);

    setVoxel(state.world.grid, cellX(matureCropCell), cellY(matureCropCell), 0, Material.ExhaustedSoil);
    const waiting = compileProjectStep(state, actor, [], project);
    assert.equal(waiting, null,
      '安装后目标消失时项目必须等待，不能制造作物或退回制造第二台磨坊');
    assert.ok(project.functionalCommissioning,
      '仍在场的项目安装应保留 commissioning，而不是把等待误判为完成');
    assert.equal(projectFunctionSatisfied(state, project), false,
      '只有载体而没有当前真实服务目标不能完成项目');
  }

  {
    const { state, actor, center, visibleCells } = createFixture(9819);
    const matureCropCell = cellId(cellX(center) + 5, cellY(center));
    setVoxel(state.world.grid, cellX(matureCropCell), cellY(matureCropCell), 0, Material.CropMature);
    const project = instantiateProject(cropProcessingProposal(state, actor, visibleCells));
    state.projects = [project];
    const sitePosition = {
      x: cellX(project.site.cellId),
      y: cellY(project.site.cellId),
      z: project.site.z,
    };
    setVoxel(state.world.grid, sitePosition.x, sitePosition.y, sitePosition.z, Material.Mill);

    const step = compileProjectStep(state, actor, [], project);
    assert.equal(project.functionalCommissioning, undefined,
      '世界里已有的旧磨坊不能成为这个项目的 installation lineage');
    assert.notEqual(step?.action.kind === 'act' ? step.action.operation : undefined, 'separate',
      '没有项目安装事实时不得借旧设施直接编译 commissioning 服务');
    assert.equal(projectFunctionSatisfied(state, project), false);
  }

  {
    const { state, actor, center, visibleCells } = createFixture(9820);
    const matureCropCell = cellId(cellX(center) + 5, cellY(center));
    setVoxel(state.world.grid, cellX(matureCropCell), cellY(matureCropCell), 0, Material.CropMature);
    const project = instantiateProject(cropProcessingProposal(state, actor, visibleCells));
    state.projects = [project];
    const { placement, nextOrder } = installProjectMill(state, actor, project);
    compileProjectStep(state, actor, [], project);
    assert.ok(project.functionalCommissioning, '安装后应进入 commissioning');
    const targetPosition = { x: cellX(matureCropCell), y: cellY(matureCropCell), z: 0 };
    const observation = {
      ...placement,
      id: 'test-observation-is-not-service',
      atMonth: 2,
      orderInMonth: nextOrder,
      action: { kind: 'attend', target: { kind: 'voxel', position: targetPosition } },
      diff: { facilityMaterialId: Material.Mill, outputs: [{ materialId: Material.Food, quantity: 6 }] },
    };
    commitProjectFact(state, project, observation);
    assert.equal(projectFunctionSatisfied(state, project), false,
      '仅观察设施即使携带相似 diff 也不能算真实服务');

    const fakeBaselineDiff = {
      ...placement,
      id: 'test-non-positive-service-diff',
      atMonth: 2,
      orderInMonth: nextOrder + 1,
      action: { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position: targetPosition }] },
      diff: {
        sourceMaterialId: Material.CropMature,
        replacementMaterialId: Material.ExhaustedSoil,
        facilityMaterialId: Material.Mill,
        productionMultiplier: 1,
        outputs: [{ materialId: Material.Food, quantity: 4 }, { materialId: Material.Seed, quantity: 2 }],
      },
    };
    commitProjectFact(state, project, fakeBaselineDiff);
    assert.equal(projectFunctionSatisfied(state, project), false,
      '只声称设施存在、但没有高于无设施基线的伪 diff 不能完成项目');

    const outsiderDiff = {
      ...fakeBaselineDiff,
      id: 'test-outsider-cannot-self-authorize',
      orderInMonth: nextOrder + 2,
      who: 'test-outsider',
      diff: {
        ...fakeBaselineDiff.diff,
        outputs: [{ materialId: Material.Food, quantity: 6 }, { materialId: Material.Seed, quantity: 2 }],
      },
    };
    commitProjectFact(state, project, outsiderDiff);
    assert.equal(projectFunctionSatisfied(state, project), false,
      '非 owner/contributor/beneficiary 不能用一次服务动作给自己追认项目资格');
  }

  {
    const { state, actor, center } = createFixture(9821);
    const project = instantiateProject({
      id: 'test-portable-prepared-food',
      kind: 'production',
      need: 'food-preparation',
      desiredFunction: 'prepared-food',
      summary: '制作可携熟食',
      ownerId: actor.id,
      beneficiaryIds: [actor.id],
      triggerFactIds: ['source:test-hunger'],
      pressure: 80,
      createdAtMonth: 0,
      reviewAtMonth: 12,
    });
    state.projects = [project];
    actor.inventory = [{
      id: 'test-food', materialId: Material.Food, quantity: 1, sourceEventIds: ['source:test-food'],
    }];
    const firePosition = { x: cellX(center) + 1, y: cellY(center), z: 1 };
    setVoxel(state.world.grid, firePosition.x, firePosition.y, firePosition.z, Material.Fire);
    const cooking = executePrimitiveAction(state, actor, {
      kind: 'act',
      operation: 'expose',
      targets: [
        { kind: 'inventory-stack', personId: actor.id, stackId: 'test-food' },
        { kind: 'voxel', position: firePosition },
      ],
    }, 1, 1, { intentId: `intent:${project.id}`, cause: 'intent', actionTick: 1 });
    assert.equal(cooking.status, 'completed', cooking.result);
    commitProjectFact(state, project, cooking);
    assert.equal(projectFunctionSatisfied(state, project), true,
      '无设施的既有便携产物完成路径不能被 commissioning 规则回归');
  }

  {
    const { state, actor, center, visibleCells } = createFixture(9817);
    const cultivationCell = cellId(cellX(center) + 5, cellY(center));
    setVoxel(state.world.grid, cellX(cultivationCell), cellY(cultivationCell), 0, Material.WetSoil);
    state.projects = [instantiateProject({
      id: 'test-active-settled-cultivation',
      kind: 'production',
      need: 'production-efficiency',
      desiredFunction: 'settled-cultivation',
      summary: '仍在营的定居耕地',
      ownerId: 'test-farmer',
      beneficiaryIds: ['test-farmer'],
      triggerFactIds: ['source:test-active-field'],
      pressure: 80,
      createdAtMonth: 0,
      reviewAtMonth: 120,
      site: { cellId: cultivationCell, z: 0 },
    })];

    const proposal = cropProcessingProposal(state, actor, visibleCells);
    const fieldDistance = Math.abs(cellX(proposal.site.cellId) - cellX(cultivationCell))
      + Math.abs(cellY(proposal.site.cellId) - cellY(cultivationCell));
    assert.equal(fieldDistance, 1,
      '尚未成熟时，磨坊也应锚定本人看得见且仍在营的耕作项目工作区，而非人物当前位置');
  }

  console.log('crop processing site anchor tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
