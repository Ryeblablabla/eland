import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-durable-record-review-wait-'));
const bundlePath = path.join(temporaryDirectory, 'durable-record-review-wait.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export {
      buildProjectOptions,
      recordProjectAction,
      recompileProjectNextAction,
      synchronizeProject,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { exertionRules, exertionTechniqueId } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/interaction-rules.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export { cellId, cellX, cellY, cellsInRadius, setVoxel } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=durable-record-review-wait-test-entry.ts', `--outfile=${bundlePath}`,
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
    exertionRules,
    exertionTechniqueId,
    instantiateProject,
    recordProjectAction,
    recompileProjectNextAction,
    setVoxel,
    synchronizeProject,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  function createFixture(seed, { searchClosedAt = 6 } = {}) {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 5;
    state.world.past = [];
    state.world.drops = [];
    state.projects = [];
    state.intents = [];
    state.records = [];
    const actor = state.people[0];
    assert.ok(actor, '耐久记录复核夹具需要一名人物');
    state.people = [actor];
    actor.bornAtMonth = -24 * 12;
    actor.body = { health: 100, hydration: 100, nutrition: 100 };
    actor.conditions = [];
    actor.knownPlaces = [];
    actor.memories = [];
    actor.baselineCapacities.perception = 100;
    delete actor.activeIntentId;

    const center = cellId(42, 26);
    for (const localCell of cellsInRadius(center, 10)) {
      for (let z = 0; z < state.world.grid.levels; z += 1) {
        setVoxel(
          state.world.grid,
          cellX(localCell),
          cellY(localCell),
          z,
          z === 0 ? Material.PackedSoil : Material.Air,
        );
      }
    }
    actor.position = {
      cellId: center,
      z: 1,
      previousCellId: center,
      previousZ: 1,
      lastPath: [],
      tickPath: [center],
    };

    const carveRule = exertionRules().find((rule) => rule.outputMaterialId === Material.WoodTablet);
    assert.ok(carveRule, '夹具需要权威空白木牍施力规则');
    const carveKnowledgeId = exertionTechniqueId(carveRule);
    const targetKnowledgeId = `technique:test:durable-review:${seed}`;
    actor.inventory = [{
      id: `stone-tool-${seed}`,
      materialId: Material.StoneTool,
      quantity: 1,
      sourceEventIds: [`stone-tool-source-${seed}`],
    }];
    actor.knowledge = [{
      id: carveKnowledgeId,
      kind: 'technique',
      summary: '用石制工具把木材刻成空白木牍',
      confidence: 90,
      learnedAtMonth: 2,
      sourceEventIds: [`carve-source-a-${seed}`, `carve-source-b-${seed}`],
    }, {
      id: targetKnowledgeId,
      kind: 'technique',
      summary: '需要保存的已核验知识',
      confidence: 90,
      learnedAtMonth: 3,
      sourceEventIds: [`target-source-a-${seed}`, `target-source-b-${seed}`],
    }];

    const project = instantiateProject({
      id: `durable-review-${seed}`,
      kind: 'inquiry',
      need: 'knowledge-preservation',
      desiredFunction: 'durable-record',
      summary: '为已核验知识制作耐久记录',
      ownerId: actor.id,
      beneficiaryIds: [actor.id],
      triggerFactIds: [`continuity-pressure-${seed}`],
      pressure: 80,
      createdAtMonth: 6,
      reviewAtMonth: 17,
      site: { cellId: center, z: 1 },
      targetKnowledgeId,
    });
    const branchKey = `known-exertion:${carveRule.id}:${Material.Wood}`;
    project.lastProgressAtMonth = 6;
    project.planKnowledgeId = carveKnowledgeId;
    project.missingMaterialIds = [Material.Wood];
    project.materialDemands = [{
      materialId: Material.Wood,
      requiredQuantity: 1,
      availableQuantity: 0,
      outstandingQuantity: 1,
      branchKey,
      sourceFactIds: [...actor.knowledge[0].sourceEventIds],
    }];
    project.searchCampaigns = [{
      id: `search-${project.id}`,
      projectId: project.id,
      ownerId: actor.id,
      actorId: actor.id,
      materialIds: [Material.Wood],
      planKnowledgeId: carveKnowledgeId,
      basisKey: [
        'project-search-campaign-v2',
        `project=${project.id}`,
        `actor=${actor.id}`,
        `materials=${Material.Wood}`,
        `branches=${Material.Wood}:1:${branchKey}`,
        `plan=${carveKnowledgeId}`,
      ].join('|'),
      openedAt: 6,
      anchor: { cellId: center, z: 1 },
      cellIds: [center],
      attemptedTargetKeys: [`${center}:1`],
      sourceFactIds: [...actor.knowledge[0].sourceEventIds],
      status: 'exhausted',
      closedAt: searchClosedAt,
    }];
    state.projects = [project];
    return { state, actor, project, center };
  }

  function addWoodDrop(fixture, suffix) {
    const drop = {
      id: `wood-drop-${suffix}`,
      materialId: Material.Wood,
      quantity: 1,
      cellId: fixture.actor.position.cellId,
      z: fixture.actor.position.z,
      createdAtMonth: fixture.state.clock.elapsedMonths + 1,
      sourceEventIds: [`wood-drop-source-${suffix}`],
      sourceLineageKeys: [`voxel:wood-drop-${suffix}`],
    };
    fixture.state.world.drops.push(drop);
    return drop;
  }

  {
    const fixture = createFixture(9821);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const options = buildProjectOptions(
        fixture.state,
        fixture.actor,
        cellsInRadius(fixture.center, 8),
        [],
        [],
      );
      assert.equal(options.some((option) => option.projectId === fixture.project.id), false,
        '已耗尽的同 basis 搜索不得伪造下一步项目行动');
      assert.equal(fixture.project.status, 'active',
        '项目创建月的局部搜索耗尽必须等到有界复核，不得同月永久终止');
      assert.equal(fixture.project.searchCampaigns.length, 1,
        '等待复核不得重开或累积相同搜索 campaign');
      assert.equal(fixture.state.intents.length, 0,
        '没有合法项目 option 时不得反复创建无动作 intent');
    }
    assert.equal(recompileProjectNextAction(fixture.state, fixture.actor, fixture.project.id), null);
    assert.equal(fixture.project.status, 'active');
    assert.deepEqual(fixture.project.missingMaterialIds, [Material.Wood],
      '等待复核期间必须保留产生 exhausted search 的精确材料缺口');
    assert.equal(fixture.project.materialDemands[0]?.branchKey,
      `known-exertion:carve-record-tablet:${Material.Wood}`);
  }

  {
    const fixture = createFixture(9822);
    synchronizeProject(fixture.state, fixture.project, fixture.project.reviewAtMonth);
    assert.equal(fixture.project.status, 'active', 'reviewAtMonth 本身仍是可恢复的最后复核月');
    synchronizeProject(fixture.state, fixture.project, fixture.project.reviewAtMonth + 1);
    assert.equal(fixture.project.status, 'blocked',
      '超过复核 deadline、距搜索关闭至少四个月且仍无精确来源时才可终止');
    assert.equal(fixture.project.blockedAtMonth, fixture.project.reviewAtMonth + 1);
  }

  {
    const fixture = createFixture(9823, { searchClosedAt: 16 });
    synchronizeProject(fixture.state, fixture.project, 19);
    assert.equal(fixture.project.status, 'active',
      '即使 review deadline 已过，距真实搜索关闭不足四个月也必须继续保留');
    synchronizeProject(fixture.state, fixture.project, 20);
    assert.equal(fixture.project.status, 'blocked',
      '搜索关闭满四个月且仍没有恢复依据后才可终止');
  }

  {
    const fixture = createFixture(9824);
    fixture.state.clock.elapsedMonths = 8;
    const drop = addWoodDrop(fixture, 'before-review');
    const acquisition = recompileProjectNextAction(fixture.state, fixture.actor, fixture.project.id);
    assert.equal(acquisition?.kind, 'transfer', 'review 前出现精确 Wood 来源时应恢复普通物流');
    assert.equal(acquisition?.kind === 'transfer' ? acquisition.dropId : undefined, drop.id);
    assert.equal(fixture.project.status, 'active');
    assert.equal(fixture.project.searchCampaigns.length, 1, '恢复真实来源不应重开旧盲搜 campaign');

    const acquisitionFact = executePrimitiveAction(
      fixture.state,
      fixture.actor,
      acquisition,
      9,
      0,
      { intentId: `intent-${fixture.project.id}`, cause: 'intent', actionTick: 1 },
    );
    assert.equal(acquisitionFact.status, 'completed', acquisitionFact.result);
    recordProjectAction(fixture.state, fixture.project.id, acquisitionFact);
    fixture.state.world.past.push(acquisitionFact);

    const production = recompileProjectNextAction(fixture.state, fixture.actor, fixture.project.id);
    assert.equal(production?.kind, 'act', '取得 Wood 后同一项目应进入普通空白载体生产');
    assert.equal(production?.kind === 'act' ? production.operation : undefined, 'exert');
    const productionFact = executePrimitiveAction(
      fixture.state,
      fixture.actor,
      production,
      9,
      1,
      { intentId: `intent-${fixture.project.id}`, cause: 'intent', actionTick: 2 },
    );
    assert.equal(productionFact.status, 'completed', productionFact.result);
    recordProjectAction(fixture.state, fixture.project.id, productionFact);
    fixture.state.world.past.push(productionFact);
    assert.ok(fixture.actor.inventory.some((stack) => (
      stack.materialId === Material.WoodTablet
      && stack.quantity > 0
      && stack.recordPayloadId === undefined
    )), '普通项目生产必须真实得到尚未写入的 WoodTablet');
  }

  {
    const fixture = createFixture(9825);
    fixture.state.clock.elapsedMonths = fixture.project.reviewAtMonth;
    addWoodDrop(fixture, 'at-deadline');
    const logisticsCountBefore = fixture.project.logisticsEpisodes.length;
    synchronizeProject(fixture.state, fixture.project, fixture.project.reviewAtMonth + 1);
    assert.equal(fixture.project.status, 'active',
      'deadline 时已有精确可执行来源，synchronize 不得先于普通 compiler 错杀项目');
    assert.equal(fixture.project.logisticsEpisodes.length, logisticsCountBefore,
      'deadline recovery preflight 必须只写 clone，不能锁定权威物流');
    assert.equal(recompileProjectNextAction(fixture.state, fixture.actor, fixture.project.id)?.kind, 'transfer');
  }

  process.stdout.write('durable record review wait tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
