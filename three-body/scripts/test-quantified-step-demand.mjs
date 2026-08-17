import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-quantified-step-demand-test-'));
const bundlePath = path.join(temporaryDirectory, 'quantified-step-demand.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export { buildProjectOptions } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export {
      inventoryCombinationForOutput,
      inventoryCombinationTechniqueId,
      exertionRuleFor,
      exertionTechniqueId,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/interaction-rules.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=quantified-step-demand-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    buildProjectOptions,
    createInitialState,
    instantiateProject,
    inventoryCombinationForOutput,
    inventoryCombinationTechniqueId,
    exertionRuleFor,
    exertionTechniqueId,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  function createFixture(seed) {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
    const actor = state.people[0];
    assert.ok(actor, '定向测试需要至少一名人物');
    state.projects = [];
    state.world.drops = [];
    actor.body = { health: 100, hydration: 100, nutrition: 100 };
    actor.conditions = [];
    actor.inventory = [];
    actor.knowledge = [];
    actor.knownPlaces = [];
    actor.memories = [];
    delete actor.activeIntentId;
    return { state, actor };
  }

  function itemStack(id, materialId, quantity, sourceEventIds = [`source:${id}`]) {
    return { id, materialId, quantity, sourceEventIds };
  }

  function groundDrop(actor, id, materialId, quantity) {
    return {
      id,
      materialId,
      quantity,
      cellId: actor.position.cellId,
      z: actor.position.z,
      createdAtMonth: 0,
      sourceEventIds: [`source:${id}`],
    };
  }

  function addKnownRecipe(actor, outputMaterialId) {
    const rule = inventoryCombinationForOutput(outputMaterialId);
    assert.ok(rule, `测试材料 ${outputMaterialId} 应有可知的合成配方`);
    const knowledgeId = inventoryCombinationTechniqueId(rule);
    actor.knowledge.push({
      id: knowledgeId,
      kind: 'technique',
      summary: `测试已知配方 ${rule.id}`,
      confidence: 100,
      learnedAtMonth: 0,
      sourceEventIds: [`source:${knowledgeId}`],
    });
    return rule;
  }

  function addKnownIgnition(actor) {
    const rule = exertionRuleFor(Material.StoneTool, Material.Fiber, Material.Air);
    assert.ok(rule, '测试世界应存在石制工具向纤维施力的点火规则');
    const knowledgeId = exertionTechniqueId(rule);
    actor.knowledge.push({
      id: knowledgeId,
      kind: 'technique',
      summary: '测试已核验点火经验',
      confidence: 100,
      learnedAtMonth: 0,
      sourceEventIds: [`source:${knowledgeId}`],
    });
  }

  function addProject(state, actor, {
    id,
    kind,
    need,
    desiredFunction,
    summary,
  }) {
    const project = instantiateProject({
      id,
      kind,
      need,
      desiredFunction,
      summary,
      ownerId: actor.id,
      beneficiaryIds: [actor.id],
      triggerFactIds: [`pressure:${id}`],
      pressure: 80,
      createdAtMonth: 0,
      reviewAtMonth: 120,
    });
    state.projects = [project];
    return project;
  }

  function projectOption(state, actor, project) {
    const options = buildProjectOptions(
      state,
      actor,
      [actor.position.cellId],
      state.world.drops,
      [],
    );
    const option = options.find((candidate) => candidate.projectId === project.id);
    assert.ok(option, `项目 ${project.id} 应编译出下一步`);
    return option;
  }

  function assertKnownRopeDeficit(existingFiber, expectedOutstanding) {
    const { state, actor } = createFixture(9200 + existingFiber);
    actor.inventory.push(itemStack('test-hide', Material.Hide, 1));
    if (existingFiber > 0) {
      actor.inventory.push(itemStack('test-existing-fiber', Material.Fiber, existingFiber));
    }
    addKnownRecipe(actor, Material.LeatherClothing);
    addKnownRecipe(actor, Material.Rope);

    const fiberDrop = groundDrop(actor, 'test-large-fiber-drop', Material.Fiber, 9);
    state.world.drops.push(fiberDrop);
    const project = addProject(state, actor, {
      id: `test-rope-deficit-${existingFiber}`,
      kind: 'production',
      need: 'thermal-safety',
      desiredFunction: 'insulation',
      summary: '按已知绳配方补齐隔热物材料',
    });

    const option = projectOption(state, actor, project);
    const episode = project.logisticsEpisodes.at(-1);
    assert.ok(episode?.kind === 'drop', '可见 Fiber 应建立 drop logistics episode');
    assert.deepEqual(
      {
        materialId: episode.materialDemand?.materialId,
        requiredQuantity: episode.materialDemand?.requiredQuantity,
        availableQuantity: episode.materialDemand?.availableQuantity,
        outstandingQuantity: episode.materialDemand?.outstandingQuantity,
      },
      {
        materialId: Material.Fiber,
        requiredQuantity: 2,
        availableQuantity: existingFiber,
        outstandingQuantity: expectedOutstanding,
      },
      'Fiber×2→Rope 应保留准确的库存与缺口数量',
    );
    assert.equal(episode.requestedQuantity, expectedOutstanding, 'drop episode 只能请求当前缺口');
    assert.equal(option.nextAction.kind, 'transfer', '同格可见 drop 应直接生成 transfer');
    assert.equal(option.nextAction.materialId, Material.Fiber);
    assert.equal(option.nextAction.quantity, expectedOutstanding);
    assert.ok(
      option.nextAction.quantity <= episode.materialDemand.outstandingQuantity,
      'drop transfer 不得超过 outstandingQuantity，即使地面堆更大',
    );
  }

  assertKnownRopeDeficit(0, 2);
  assertKnownRopeDeficit(1, 1);

  {
    const { state, actor } = createFixture(9301);
    const stoneTool = itemStack('test-stone-tool', Material.StoneTool, 1);
    const rawMeat = itemStack('test-raw-meat', Material.RawMeat, 1);
    actor.inventory.push(stoneTool, rawMeat);
    addKnownIgnition(actor);

    const fiberDrop = groundDrop(actor, 'test-cooking-fiber', Material.Fiber, 8);
    state.world.drops.push(
      groundDrop(actor, 'test-distractor-stone', Material.Stone, 8),
      groundDrop(actor, 'test-distractor-wood', Material.Wood, 8),
      fiberDrop,
    );
    const project = addProject(state, actor, {
      id: 'test-prepared-food-fiber-demand',
      kind: 'inquiry',
      need: 'food-preparation',
      desiredFunction: 'prepared-food',
      summary: '把生肉变成熟食',
    });

    const collectFiber = projectOption(state, actor, project);
    const episode = project.logisticsEpisodes.at(-1);
    assert.ok(episode?.kind === 'drop', '熟食项目应为 Fiber 建立 drop episode');
    assert.deepEqual(episode.materialIds, [Material.Fiber], '已有 StoneTool 时只能需求 Fiber，不能再需求 Stone/Wood');
    assert.deepEqual(
      {
        materialId: episode.materialDemand?.materialId,
        requiredQuantity: episode.materialDemand?.requiredQuantity,
        availableQuantity: episode.materialDemand?.availableQuantity,
        outstandingQuantity: episode.materialDemand?.outstandingQuantity,
        requestedQuantity: episode.requestedQuantity,
      },
      {
        materialId: Material.Fiber,
        requiredQuantity: 1,
        availableQuantity: 0,
        outstandingQuantity: 1,
        requestedQuantity: 1,
      },
      'StoneTool+raw 且无 Fiber 时应只形成 Fiber×1 缺口',
    );
    assert.deepEqual(
      {
        kind: collectFiber.nextAction.kind,
        materialId: collectFiber.nextAction.materialId,
        quantity: collectFiber.nextAction.quantity,
        dropId: collectFiber.nextAction.dropId,
      },
      {
        kind: 'transfer',
        materialId: Material.Fiber,
        quantity: 1,
        dropId: fiberDrop.id,
      },
      '熟食项目必须从 Fiber drop 只搬 1 份，忽略同格 Stone/Wood',
    );

    fiberDrop.quantity -= 1;
    actor.inventory.push(itemStack('test-acquired-fiber', Material.Fiber, 1, ['action:test-acquired-fiber']));
    const afterAcquisition = projectOption(state, actor, project);

    assert.equal(episode.status, 'fulfilled', '拿到请求的 1 份 Fiber 后应结算原 drop episode');
    assert.equal(episode.endingReason, 'material-acquired');
    assert.equal(project.logisticsEpisodes.length, 1, '拿到 Fiber 后不应再创建 Fiber/Stone/Wood 搬运 episode');
    assert.equal(afterAcquisition.nextAction.kind, 'act', '拿到 Fiber 后应进入实际加工步骤');
    assert.equal(afterAcquisition.nextAction.operation, 'exert', '下一步应使用已有 StoneTool 与 Fiber 尝试点火');
    assert.equal(afterAcquisition.nextAction.toolStackId, stoneTool.id, '下一步必须复用已有 StoneTool');
    assert.ok(
      afterAcquisition.nextAction.targets.some((target) => target.kind === 'inventory-stack'
        && target.stackId === 'test-acquired-fiber'),
      '点火步骤应使用刚取得的 Fiber',
    );
  }

  process.stdout.write('quantified step demand tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
