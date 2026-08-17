import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-visible-world-source-test-'));
const bundlePath = path.join(temporaryDirectory, 'visible-world-source.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export { buildProjectOptions, recordProjectAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export {
      cellId,
      cellX,
      cellY,
      cellsInRadius,
      findStandingPath,
      setVoxel,
      voxelAt,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=visible-world-source-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    buildProjectOptions,
    cellId,
    cellX,
    cellY,
    cellsInRadius,
    createInitialState,
    executePrimitiveAction,
    findStandingPath,
    instantiateProject,
    recordProjectAction,
    setVoxel,
    voxelAt,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  function itemStack(id, materialId, quantity) {
    return { id, materialId, quantity, sourceEventIds: [`source:${id}`] };
  }

  function createFixture(seed) {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
    const actor = state.people[0];
    assert.ok(actor, '定向测试需要至少一名人物');

    const center = cellId(42, 26);
    for (const localCell of cellsInRadius(center, 10)) {
      const x = cellX(localCell);
      const y = cellY(localCell);
      for (let z = 0; z < state.world.grid.levels; z += 1) {
        setVoxel(state.world.grid, x, y, z, z === 0 ? Material.PackedSoil : Material.Air);
      }
    }

    state.clock.elapsedMonths = 0;
    state.projects = [];
    state.records = [];
    state.world.drops = [];
    for (const other of state.people.slice(1)) other.diedAtMonth = 0;

    delete actor.diedAtMonth;
    actor.position = {
      cellId: center,
      z: 1,
      previousCellId: center,
      previousZ: 1,
      lastPath: [],
      tickPath: [center],
    };
    actor.body = { health: 100, hydration: 100, nutrition: 100 };
    actor.conditions = [];
    actor.inventory = [];
    actor.knowledge = [];
    actor.knownPlaces = [];
    actor.memories = [];
    actor.baselineCapacities.perception = 100;
    delete actor.activeIntentId;
    return { state, actor, center };
  }

  function plantTree(state, sourceCellId) {
    const x = cellX(sourceCellId);
    const y = cellY(sourceCellId);
    setVoxel(state.world.grid, x, y, 1, Material.Wood);
    setVoxel(state.world.grid, x, y, 2, Material.Leaves);
    return { x, y, z: 2 };
  }

  function addProject(state, actor, input) {
    const project = instantiateProject({
      id: input.id,
      kind: input.kind,
      need: input.need,
      desiredFunction: input.desiredFunction,
      summary: input.summary,
      ownerId: actor.id,
      beneficiaryIds: [actor.id],
      triggerFactIds: [`pressure:${input.id}`],
      pressure: 80,
      createdAtMonth: 0,
      reviewAtMonth: 120,
      ...(input.targetKnowledgeId ? { targetKnowledgeId: input.targetKnowledgeId } : {}),
    });
    state.projects = [project];
    return project;
  }

  function optionFor(state, actor, project) {
    const options = buildProjectOptions(
      state,
      actor,
      cellsInRadius(actor.position.cellId, 8),
      state.world.drops,
      [],
    );
    const option = options.find((candidate) => candidate.projectId === project.id);
    assert.ok(option, `项目 ${project.id} 应编译出下一步`);
    return option;
  }

  function inventoryQuantity(actor, materialId) {
    return actor.inventory.reduce(
      (sum, stack) => sum + (stack.materialId === materialId ? stack.quantity : 0),
      0,
    );
  }

  {
    const { state, actor, center } = createFixture(9401);
    const sourcePosition = plantTree(state, cellId(cellX(center) + 4, cellY(center)));
    const stoneTool = itemStack('test-source-stone-tool', Material.StoneTool, 1);
    actor.inventory.push(stoneTool);
    const knowledgeId = 'test-durable-knowledge';
    actor.knowledge.push({
      id: knowledgeId,
      kind: 'observation',
      summary: '应保存在实体载体上的定向测试事实',
      confidence: 90,
      learnedAtMonth: 0,
      sourceEventIds: ['source:test-durable-knowledge'],
    });
    const project = addProject(state, actor, {
      id: 'test-visible-wood-source-project',
      kind: 'inquiry',
      need: 'knowledge-preservation',
      desiredFunction: 'durable-record',
      summary: '为可靠知识制作木制记录载体',
      targetKnowledgeId: knowledgeId,
    });

    let option = optionFor(state, actor, project);
    const sourceEpisode = project.logisticsEpisodes.at(-1);
    assert.ok(sourceEpisode?.kind === 'source', '当前缺 Wood 且树木可见可达时必须优先建立 source episode');
    assert.equal(sourceEpisode.sourceRef.kind, 'voxel-source');
    assert.deepEqual(sourceEpisode.sourceRef.position, sourcePosition, 'source episode 必须绑定真实可见树体素');
    assert.equal(sourceEpisode.sourceRef.sourceMaterialId, Material.Leaves, '树冠 Leaves 也是合法 Wood 产出来源');
    assert.deepEqual(sourceEpisode.materialIds, [Material.Wood]);
    assert.deepEqual(
      {
        materialId: sourceEpisode.materialDemand?.materialId,
        requiredQuantity: sourceEpisode.materialDemand?.requiredQuantity,
        availableQuantity: sourceEpisode.materialDemand?.availableQuantity,
        outstandingQuantity: sourceEpisode.materialDemand?.outstandingQuantity,
      },
      {
        materialId: Material.Wood,
        requiredQuantity: 1,
        availableQuantity: 0,
        outstandingQuantity: 1,
      },
      'source episode 必须保留当前 Wood 定量需求',
    );
    assert.equal(project.searchCampaigns.length, 0, '存在合格可见来源时不得先开启盲搜 campaign');
    assert.equal(project.logisticsEpisodes.some((episode) => episode.kind === 'search'), false);
    assert.ok(sourceEpisode.sourcePathLengthAtCreation > 1, '远处来源夹具必须需要多步接近');
    assert.equal(option.nextAction.kind, 'move', '远处树木应先移动到固定工作位');

    const lockedTarget = structuredClone(sourceEpisode.target);
    const lockedSourceRef = structuredClone(sourceEpisode.sourceRef);
    const initialPathLength = findStandingPath(state.world.grid, actor.position, lockedTarget).length;
    assert.ok(initialPathLength > 2, '远处来源的工作位应至少相隔两条边');

    let actionOrder = 0;
    function executeProjectAction(action) {
      const orderInMonth = actionOrder;
      actionOrder += 1;
      const fact = executePrimitiveAction(state, actor, action, 1, orderInMonth, {
        cause: 'intent',
        actionTick: orderInMonth + 1,
      });
      recordProjectAction(state, project.id, fact);
      return fact;
    }

    const firstMove = executeProjectAction(option.nextAction);
    assert.equal(firstMove.status, 'progressed', '单个 planning tick 只能向远处工作位推进一步');
    const afterFirstMovePathLength = findStandingPath(state.world.grid, actor.position, lockedTarget).length;
    assert.ok(afterFirstMovePathLength < initialPathLength, '来源移动必须真实缩短到固定工作位的路径');

    option = optionFor(state, actor, project);
    assert.equal(project.logisticsEpisodes.length, 1, '接近途中不得重建或改换 source episode');
    assert.deepEqual(sourceEpisode.target, lockedTarget, '接近途中必须保持同一工作位');
    assert.deepEqual(sourceEpisode.sourceRef, lockedSourceRef, '接近途中必须保持同一源体素');
    assert.equal(option.nextAction.kind, 'move');
    assert.equal(option.nextAction.toCellId, lockedTarget.cellId);
    assert.equal(option.nextAction.toZ, lockedTarget.z);

    let approachSteps = 1;
    while (option.nextAction.kind === 'move') {
      assert.ok(approachSteps < 10, '固定工作位应在局部路径预算内可达');
      executeProjectAction(option.nextAction);
      approachSteps += 1;
      option = optionFor(state, actor, project);
      assert.deepEqual(sourceEpisode.target, lockedTarget);
      assert.deepEqual(sourceEpisode.sourceRef, lockedSourceRef);
    }

    assert.equal(actor.position.cellId, lockedTarget.cellId);
    assert.equal(actor.position.z, lockedTarget.z);
    assert.equal(option.nextAction.kind, 'act');
    assert.equal(option.nextAction.operation, 'separate');
    assert.deepEqual(option.nextAction.targets, [{ kind: 'voxel', position: sourcePosition }]);

    const separationOrder = actionOrder;
    actionOrder += 1;
    const separationFact = executePrimitiveAction(state, actor, option.nextAction, 1, separationOrder, {
      cause: 'intent',
      actionTick: separationOrder + 1,
    });
    assert.equal(separationFact.status, 'completed', '权威 executor 应合法执行近身树木分离');
    assert.ok(
      separationFact.diff.outputs.some((output) => output.materialId === Material.Wood && output.quantity > 1),
      '权威分离结果必须声明真实 Wood 产量',
    );
    const woodDrop = state.world.drops.find((drop) => drop.materialId === Material.Wood
      && drop.sourceEventIds.includes(separationFact.id));
    const fiberDrop = state.world.drops.find((drop) => drop.materialId === Material.Fiber
      && drop.sourceEventIds.includes(separationFact.id));
    assert.ok(woodDrop && woodDrop.quantity > 1, 'executor 必须在人物工作位生成真实 Wood drop');
    assert.ok(fiberDrop, '树木分离的附带 Fiber 也必须留在权威世界中');
    assert.equal(woodDrop.cellId, actor.position.cellId);
    assert.equal(woodDrop.z, actor.position.z);
    assert.equal(voxelAt(state.world.grid, sourcePosition.x, sourcePosition.y, sourcePosition.z), Material.Air);

    recordProjectAction(state, project.id, separationFact);
    assert.equal(sourceEpisode.status, 'fulfilled');
    assert.equal(sourceEpisode.endingReason, 'material-produced');
    assert.ok(sourceEpisode.actionEventIds.includes(separationFact.id));

    const quantityBeforeTransfer = woodDrop.quantity;
    const transferOption = optionFor(state, actor, project);
    const dropEpisode = project.logisticsEpisodes.at(-1);
    assert.ok(dropEpisode?.kind === 'drop', '分离产出后，同一项目应把真实 Wood drop 编译为 drop episode');
    assert.equal(dropEpisode.sourceRef.kind, 'drop');
    assert.equal(dropEpisode.sourceRef.dropId, woodDrop.id);
    assert.equal(dropEpisode.materialDemand?.outstandingQuantity, 1);
    assert.equal(dropEpisode.requestedQuantity, 1);
    assert.deepEqual(
      {
        kind: transferOption.nextAction.kind,
        materialId: transferOption.nextAction.materialId,
        quantity: transferOption.nextAction.quantity,
        dropId: transferOption.nextAction.dropId,
      },
      {
        kind: 'transfer',
        materialId: Material.Wood,
        quantity: 1,
        dropId: woodDrop.id,
      },
      '后续 transfer 只能取得当前 Wood demand 的 1 份，多余产物必须留在世界',
    );

    const transferFact = executeProjectAction(transferOption.nextAction);
    assert.equal(transferFact.status, 'completed');
    assert.equal(transferFact.diff.quantity, 1);
    assert.equal(inventoryQuantity(actor, Material.Wood), 1);
    assert.equal(woodDrop.quantity, quantityBeforeTransfer - 1, '超出 demand 的 Wood 必须继续留在地面 drop');
  }

  {
    const { state, actor, center } = createFixture(9402);
    const sourcePosition = plantTree(state, cellId(cellX(center) + 4, cellY(center)));
    actor.inventory.push(
      itemStack('test-unrelated-stone-tool', Material.StoneTool, 1),
      itemStack('test-unrelated-raw-meat', Material.RawMeat, 1),
    );
    const project = addProject(state, actor, {
      id: 'test-unrelated-fiber-demand',
      kind: 'inquiry',
      need: 'food-preparation',
      desiredFunction: 'prepared-food',
      summary: '为熟食项目寻找点火纤维',
    });

    const option = optionFor(state, actor, project);
    const episode = project.logisticsEpisodes.at(-1);
    assert.ok(episode?.kind === 'search', '只有 Fiber demand 时应维持有限搜索，而不是调用树木 Wood 来源');
    assert.deepEqual(episode.materialIds, [Material.Fiber]);
    assert.equal(episode.sourceRef.kind, 'project-requirement');
    assert.equal(project.logisticsEpisodes.some((candidate) => candidate.kind === 'source'), false);
    assert.equal(option.nextAction.kind, 'move');
    assert.equal(voxelAt(state.world.grid, sourcePosition.x, sourcePosition.y, sourcePosition.z), Material.Leaves,
      '无关 demand 不得消费或认领眼前树木');
  }

  process.stdout.write('visible world source tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
