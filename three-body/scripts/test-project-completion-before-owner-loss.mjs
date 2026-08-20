import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-project-owner-loss-'));
const bundlePath = path.join(temporaryDirectory, 'project-owner-loss.mjs');

try {
  const testEntry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { projectFunctionSatisfied, recordProjectAction, synchronizeProject } from ${JSON.stringify(path.resolve('src/game/eland/application/project-options.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.resolve('src/game/eland/domain/project.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { cellX, cellY, neighbors4, setVoxel, voxelAt } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=project-owner-loss-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: testEntry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    Material,
    cellX,
    cellY,
    createInitialState,
    executePrimitiveAction,
    instantiateProject,
    neighbors4,
    projectFunctionSatisfied,
    recordProjectAction,
    setVoxel,
    synchronizeProject,
    voxelAt,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  function actionFact(actor, id, operation, diff, atMonth = 29) {
    return {
      id,
      kind: 'action',
      actionTick: 1,
      atMonth,
      orderInMonth: 0,
      cellId: actor.position.cellId,
      who: actor.id,
      cause: 'intent',
      action: { kind: 'act', operation, targets: [] },
      fromCellId: actor.position.cellId,
      toCellId: actor.position.cellId,
      fromZ: actor.position.z,
      toZ: actor.position.z,
      pathSegment: [actor.position.cellId],
      status: 'completed',
      result: '测试耕作进展',
      diff,
    };
  }

  function createProjectFixture(seed, satisfied) {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 29;
    state.world.past = [];
    const owner = state.people[0];
    state.people = [owner];
    const project = instantiateProject({
      id: `owner-loss-cultivation-${seed}`,
      kind: 'production',
      need: 'production-efficiency',
      desiredFunction: 'settled-cultivation',
      summary: '在 owner 丧失前已经形成的固定耕地',
      ownerId: owner.id,
      beneficiaryIds: [owner.id],
      triggerFactIds: [`pressure:${seed}`],
      pressure: 80,
      createdAtMonth: 1,
      reviewAtMonth: 120,
      site: { cellId: owner.position.cellId, z: 0 },
    });
    project.logisticsEpisodes = [{
      id: `logistics:${seed}`,
      kind: 'source',
      actorId: owner.id,
      materialIds: [Material.Seed],
      target: { ...project.site },
      sourceRef: { kind: 'project-requirement', projectId: project.id },
      sourceEventIds: [`pressure:${seed}`],
      createdAt: 20,
      status: 'active',
      actionEventIds: [],
    }];
    project.activeLogisticsEpisodeId = `logistics:${seed}`;
    if (satisfied) {
      const baseX = cellX(owner.position.cellId);
      const baseY = cellY(owner.position.cellId);
      const facts = [0, 1, 2, 3, 4, 5].map((offset) => actionFact(
        owner,
        `plant:${seed}:${offset}`,
        'combine',
        {
          outputMaterialId: Material.CropSprout,
          position: { x: baseX + offset, y: baseY, z: 0 },
        },
      ));
      facts.push(
        actionFact(owner, `harvest:${seed}:0`, 'separate', { sourceMaterialId: Material.CropMature }),
        actionFact(owner, `harvest:${seed}:1`, 'separate', { sourceMaterialId: Material.CropMature }),
      );
      state.world.past.push(...facts);
      project.actionEventIds = facts.map((fact) => fact.id);
    }
    state.projects = [project];
    return { state, owner, project };
  }

  {
    const { state, owner, project } = createProjectFixture(9401, true);
    assert.equal(projectFunctionSatisfied(state, project), true, '夹具必须先形成客观耕作功能');
    owner.diedAtMonth = 30;
    owner.body.health = 0;
    synchronizeProject(state, project, 30);
    assert.equal(project.status, 'completed', '客观功能已经形成时，同月 owner 丧失不得把项目改写为 blocked');
    assert.equal(project.completedAtMonth, 30);
    assert.equal(project.blockedAtMonth, undefined);
    assert.deepEqual(new Set(project.completionEventIds), new Set(project.actionEventIds), '完成证据必须保留全部真实耕作事实');
    assert.equal(project.logisticsEpisodes[0].status, 'fulfilled');
    assert.equal(project.logisticsEpisodes[0].endingReason, 'project-completed');
    assert.equal(project.activeLogisticsEpisodeId, undefined);
  }

  {
    const { state, owner, project } = createProjectFixture(9402, false);
    owner.diedAtMonth = 30;
    owner.body.health = 0;
    synchronizeProject(state, project, 30);
    assert.equal(project.status, 'blocked', '客观功能尚未形成时仍应沿用 owner 丧失终态');
    assert.equal(project.blockedAtMonth, 30);
    assert.equal(project.logisticsEpisodes[0].status, 'exhausted');
    assert.equal(project.logisticsEpisodes[0].endingReason, 'project-blocked');
  }

  {
    const state = createInitialState(9403, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 29;
    state.world.past = [];
    const owner = state.people[0];
    state.people = [owner];
    const project = instantiateProject({
      id: 'portable-completion-provenance',
      kind: 'production',
      need: 'alloy-capability',
      desiredFunction: 'copper-smelting',
      summary: '在本项目中真实冶炼金属铜',
      ownerId: owner.id,
      beneficiaryIds: [owner.id],
      triggerFactIds: ['pressure:portable-completion-provenance'],
      pressure: 80,
      createdAtMonth: 29,
      reviewAtMonth: 48,
      site: { cellId: owner.position.cellId, z: owner.position.z },
    });
    state.projects = [project];
    owner.inventory = [{
      id: 'old-copper-stack',
      materialId: Material.Copper,
      quantity: 1,
      sourceEventIds: ['old-food-preparation-copper'],
    }];

    assert.equal(projectFunctionSatisfied(state, project), false,
      '旧项目产出的便携铜不能让没有自身行动的新冶炼项目即时完成');

    const kilnPosition = neighbors4(owner.position.cellId).map((nearbyCellId) => ({
      cellId: nearbyCellId,
      x: cellX(nearbyCellId),
      y: cellY(nearbyCellId),
      z: owner.position.z,
    })).find((position) => voxelAt(state.world.grid, position.x, position.y, position.z) === Material.Air
      && voxelAt(state.world.grid, position.x, position.y, position.z - 1) !== Material.Air);
    assert.ok(kilnPosition, '测试出生点旁必须存在可接近的高温设施位置');
    setVoxel(state.world.grid, kilnPosition.x, kilnPosition.y, kilnPosition.z, Material.Kiln);
    owner.inventory.push({
      id: 'new-project-copper-charge',
      materialId: Material.CopperCharge,
      quantity: 1,
      sourceEventIds: ['new-project-charge'],
    });
    const smelting = executePrimitiveAction(state, owner, {
      kind: 'act',
      operation: 'expose',
      targets: [
        { kind: 'inventory-stack', personId: owner.id, stackId: 'new-project-copper-charge' },
        { kind: 'voxel', position: kilnPosition },
      ],
    }, 29, 0, { cause: 'intent', actionTick: 1 });
    assert.equal(smelting.status, 'completed', smelting.result);
    assert.equal(smelting.diff.outputMaterialId, Material.Copper, '本项目必须真实产生目标铜');
    assert.deepEqual(owner.inventory.find((stack) => stack.id === 'old-copper-stack')?.sourceEventIds,
      ['old-food-preparation-copper', smelting.id],
      '真实新产物应合入已有铜栈并保留新旧来源');
    assert.equal(state.world.past.some((event) => event.id === smelting.id), false,
      '夹具应覆盖当前行动尚未写入 world.past 的提交时序');
    assert.equal(projectFunctionSatisfied(state, project), false,
      '产物事件尚未归入本项目时仍不能完成');

    recordProjectAction(state, project.id, smelting);
    assert.equal(projectFunctionSatisfied(state, project), true,
      '真实产铜事件归入本项目后才形成便携功能完成证据');
    synchronizeProject(state, project, 29);
    assert.equal(project.status, 'completed');
    assert.deepEqual(project.completionEventIds, [smelting.id],
      '合并进旧铜栈时，完成引用只能保留本项目新事实，不能带入旧来源');
  }

  process.stdout.write('project completion before owner loss tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
