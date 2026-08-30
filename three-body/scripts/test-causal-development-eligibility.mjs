import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-causal-development-test-'));
const bundlePath = path.join(temporaryDirectory, 'causal-development.mjs');

try {
  const entry = `
    export {
      bindIntentProjectTarget,
      createInitialState,
      executeActiveIntent,
      shouldWaitForSameMonthSharedProject,
      startIntent,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export {
      buildProjectOptions,
      ensureProject,
      projectFunctionSatisfied,
      recordProjectAction,
      recompileProjectNextAction,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { buildProjectPressureBasis } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-pressure.ts'))};
    export { buildLocalMaterialEvidence } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/local-material-evidence.ts'))};
    export { evaluateDecisionOption } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/decision-factor-forest.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export { inventoryCombinationForOutput, inventoryCombinationTechniqueId } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/interaction-rules.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export {
      cellId,
      cellX,
      cellY,
      cellsInRadius,
      setVoxel,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=causal-development-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    bindIntentProjectTarget,
    buildProjectOptions,
    buildLocalMaterialEvidence,
    buildProjectPressureBasis,
    cellId,
    cellX,
    cellY,
    cellsInRadius,
    createInitialState,
    ensureProject,
    evaluateDecisionOption,
    executeActiveIntent,
    executePrimitiveAction,
    instantiateProject,
    inventoryCombinationForOutput,
    inventoryCombinationTechniqueId,
    projectFunctionSatisfied,
    recordProjectAction,
    recompileProjectNextAction,
    setVoxel,
    shouldWaitForSameMonthSharedProject,
    startIntent,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  function createFixture(seed) {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
    const actor = state.people[0];
    assert.ok(actor, '定向测试需要至少一名人物');
    const center = cellId(42, 26);
    for (const localCell of cellsInRadius(center, 8)) {
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
    actor.body = { health: 100, hydration: 100, nutrition: 30 };
    actor.conditions = [];
    actor.inventory = [];
    actor.knowledge = [];
    actor.knownPlaces = [];
    actor.memories = [];
    actor.baselineCapacities.perception = 100;
    delete actor.activeIntentId;
    return { state, actor, center };
  }

  function cultivationProject(state, actor, siteCellId, id) {
    const project = instantiateProject({
      id,
      kind: 'production',
      need: 'production-efficiency',
      desiredFunction: 'settled-cultivation',
      summary: '测试固定耕地',
      ownerId: actor.id,
      beneficiaryIds: [actor.id],
      triggerFactIds: [`pressure:${id}`],
      pressure: 80,
      createdAtMonth: 0,
      reviewAtMonth: 120,
      site: { cellId: siteCellId, z: 0 },
    });
    state.projects = [project];
    return project;
  }

  function actionFact(actor, id, operation, diff, targetCellId = actor.position.cellId) {
    const position = { x: cellX(targetCellId), y: cellY(targetCellId), z: 0 };
    return {
      id,
      kind: 'action',
      actionTick: 0,
      atMonth: 1,
      orderInMonth: 0,
      cellId: actor.position.cellId,
      who: actor.id,
      cause: 'intent',
      action: { kind: 'act', operation, targets: [{ kind: 'voxel', position }] },
      fromCellId: actor.position.cellId,
      toCellId: actor.position.cellId,
      fromZ: actor.position.z,
      toZ: actor.position.z,
      pathSegment: [actor.position.cellId],
      status: 'completed',
      result: '测试项目行动',
      diff,
    };
  }

  {
    const { state, actor, center } = createFixture(9601);
    const fieldCell = cellId(cellX(center) + 1, cellY(center));
    setVoxel(state.world.grid, cellX(fieldCell), cellY(fieldCell), 0, Material.WetSoil);
    actor.inventory.push({ id: 'test-seed', materialId: Material.Seed, quantity: 1, sourceEventIds: ['source:test-seed'] });
    const visibleCells = cellsInRadius(center, 8);
    const basis = buildProjectPressureBasis(state, actor, {
      need: 'production-efficiency',
      desiredFunction: 'settled-cultivation',
      beneficiaryIds: [actor.id],
      createdAtMonth: 1,
    }, 1, { visibleCells, visibleDrops: [], visiblePeople: [] });
    assert.ok(basis.edgeKeys.includes('state:visible-population:1'), '本人必须计入局部人口压力');
    assert.ok(basis.reasonKeys.includes('visible-hunger'), '本人的饥饿必须进入发展压力');
    assert.ok(basis.pressure >= 42, '独处人物在真实食物压力下也应能形成耕作动机');

    const options = buildProjectOptions(state, actor, visibleCells, [], []);
    const cultivation = options.find((option) => option.projectProposal?.desiredFunction === 'settled-cultivation');
    assert.ok(cultivation, '耕作资格不能要求附近另有三个人');
    assert.equal(cultivation.projectProposal.site?.cellId, fieldCell, '新耕作项目必须锚定眼前可耕作地点');
    assert.equal(cultivation.nextAction.kind, 'act');
    assert.equal(cultivation.nextAction.kind === 'act' ? cultivation.nextAction.operation : '', 'combine');

    const remoteProject = instantiateProject({
      id: 'test-remote-cultivation-project',
      kind: 'production',
      need: 'production-efficiency',
      desiredFunction: 'settled-cultivation',
      summary: '远处另一块耕地',
      ownerId: 'test-remote-owner',
      beneficiaryIds: ['test-remote-owner'],
      triggerFactIds: ['pressure:test-remote-cultivation-project'],
      pressure: 80,
      createdAtMonth: 0,
      reviewAtMonth: 120,
      site: { cellId: cellId(70, 40), z: 0 },
    });
    state.projects = [remoteProject];
    const withRemoteProject = buildProjectOptions(state, actor, visibleCells, [], []);
    assert.ok(withRemoteProject.some((option) => option.projectProposal?.desiredFunction === 'settled-cultivation'),
      '视野外另一块耕地的活动项目不能成为文明级单例门禁');
  }

  {
    const { state, actor, center } = createFixture(9602);
    const other = structuredClone(actor);
    other.id = 'test-visible-tool-holder';
    other.body.nutrition = 100;
    other.inventory = [{ id: 'other-tool', materialId: Material.WoodTool, quantity: 1, sourceEventIds: ['source:other-tool'] }];
    const view = { visibleCells: cellsInRadius(center, 8), visibleDrops: [], visiblePeople: [other] };
    const cultivation = buildProjectPressureBasis(state, actor, {
      need: 'production-efficiency', desiredFunction: 'settled-cultivation', beneficiaryIds: [actor.id], createdAtMonth: 1,
    }, 1, view);
    const toolMaking = buildProjectPressureBasis(state, actor, {
      need: 'production-efficiency', desiredFunction: 'efficient-production', beneficiaryIds: [actor.id], createdAtMonth: 1,
    }, 1, view);
    assert.ok(cultivation.pressure >= 42, '看见别人拿着工具不能抵消本人的耕作压力');
    assert.equal(toolMaking.pressure, cultivation.pressure, '别人背包里的工具只能提供观察，不能冒充本人可使用的工具');
    assert.ok(toolMaking.reasonKeys.includes('production-tool-absent'), '工具压力必须记录本人仍缺少可使用工具');

    actor.inventory.push({ id: 'own-tool', materialId: Material.WoodTool, quantity: 1, sourceEventIds: ['source:own-tool'] });
    const withOwnTool = buildProjectPressureBasis(state, actor, {
      need: 'production-efficiency', desiredFunction: 'efficient-production', beneficiaryIds: [actor.id], createdAtMonth: 1,
    }, 1, view);
    assert.ok(withOwnTool.pressure < toolMaking.pressure, '本人真正持有工具后才应降低同类工具项目压力');
    assert.ok(withOwnTool.reasonKeys.includes('production-tool-upgrade-needed'),
      '木制工具低于石锄级目标时，压力证据必须明确记录升级缺口');
    assert.ok(withOwnTool.edgeKeys.includes('state:production-tool-upgrade-gap:2'),
      '工具升级压力必须记录当前等级到目标等级的精确差值');
  }

  {
    const { state, actor, center } = createFixture(9606);
    const other = structuredClone(actor);
    other.id = 'test-carried-facility-holder';
    other.inventory = [{ id: 'other-granary', materialId: Material.Granary, quantity: 1, sourceEventIds: ['source:other-granary'] }];
    const visibleCells = cellsInRadius(center, 8);
    const carried = buildLocalMaterialEvidence(state, actor, { visibleCells, visibleDrops: [], visiblePeople: [other] });
    assert.ok(carried.observedMaterialIds.has(Material.Granary), '看见别人携带设施构件仍是有效观察');
    assert.ok(!carried.accessiblePortableMaterialIds.has(Material.Granary), '别人携带的设施构件不属于本人可使用物');
    assert.ok(!carried.placedFacilityMaterialIds.has(Material.Granary), '未落地的设施构件不能冒充已生效设施');

    const facilityCell = cellId(cellX(center) + 1, cellY(center));
    setVoxel(state.world.grid, cellX(facilityCell), cellY(facilityCell), 1, Material.Granary);
    const placed = buildLocalMaterialEvidence(state, actor, { visibleCells, visibleDrops: [], visiblePeople: [other] });
    assert.ok(placed.placedFacilityMaterialIds.has(Material.Granary), '设施落到世界实体位置后才应成为生效证据');
  }

  {
    const { state, actor, center } = createFixture(9607);
    const view = { visibleCells: cellsInRadius(center, 8), visibleDrops: [], visiblePeople: [] };
    const scarce = buildProjectPressureBasis(state, actor, {
      need: 'reserve-security', desiredFunction: 'reserve-storage', beneficiaryIds: [actor.id], createdAtMonth: 1,
    }, 1, view);
    actor.inventory.push({ id: 'surplus-food', materialId: Material.Food, quantity: 7, sourceEventIds: ['source:surplus-food'] });
    const surplus = buildProjectPressureBasis(state, actor, {
      need: 'reserve-security', desiredFunction: 'reserve-storage', beneficiaryIds: [actor.id], createdAtMonth: 1,
    }, 1, view);
    assert.ok(surplus.pressure > scarce.pressure, '谷仓压力应由可储存余粮增强，不能在断粮时反向升高');
    assert.ok(surplus.reasonKeys.includes('visible-storable-surplus'), '余粮必须留下可回放的谷仓动机证据');
  }

  {
    const { state, actor, center } = createFixture(9608);
    const partner = structuredClone(actor);
    partner.id = 'test-joint-partner';
    const view = { visibleCells: cellsInRadius(center, 8), visibleDrops: [], visiblePeople: [partner] };
    const before = buildProjectPressureBasis(state, actor, {
      need: 'coordination-capacity', desiredFunction: 'community-coordination', beneficiaryIds: [actor.id], createdAtMonth: 1,
    }, 1, view);
    state.projects = [0, 1].map((index) => {
      const project = instantiateProject({
        id: `test-joint-project-${index}`,
        kind: 'construction',
        need: 'shelter-capacity',
        desiredFunction: 'weather-shelter',
        summary: '共同完成的测试项目',
        ownerId: actor.id,
        beneficiaryIds: [actor.id, partner.id],
        triggerFactIds: [`pressure:test-joint-project-${index}`],
        pressure: 80,
        createdAtMonth: 0,
        reviewAtMonth: 120,
        site: { cellId: center, z: 1 },
      });
      project.status = 'completed';
      project.contributorIds = [actor.id, partner.id];
      project.completionEventIds = [`completion:test-joint-project-${index}`];
      return project;
    });
    const after = buildProjectPressureBasis(state, actor, {
      need: 'coordination-capacity', desiredFunction: 'community-coordination', beneficiaryIds: [actor.id], createdAtMonth: 1,
    }, 1, view);
    assert.ok(before.pressure < 42, '仅仅旁边有人不应直接形成议事设施资格');
    assert.ok(after.pressure >= 42, '反复共同完成项目后应形成议事场所压力');
    assert.ok(after.reasonKeys.includes('repeated-joint-projects'), '议事压力必须引用真实重复协作证据');
  }

  {
    const { state, actor, center } = createFixture(9609);
    actor.inventory.push(
      { id: 'test-tool-wood', materialId: Material.Wood, quantity: 1, sourceEventIds: ['source:test-tool-wood'] },
      { id: 'test-tool-rope', materialId: Material.Rope, quantity: 1, sourceEventIds: ['source:test-tool-rope'] },
    );
    const visibleCells = cellsInRadius(center, 8);
    const soloOptions = buildProjectOptions(state, actor, visibleCells, [], []);
    assert.ok(soloOptions.some((option) => option.projectProposal?.desiredFunction === 'efficient-production'),
      '本人有压力和材料时，制作工具不能要求旁边先出现更多人');
  }

  {
    const { state, actor, center } = createFixture(9620);
    actor.inventory.push(
      { id: 'accessible-tool-wood', materialId: Material.Wood, quantity: 1, sourceEventIds: ['source:accessible-tool-wood'] },
      { id: 'accessible-tool-rope', materialId: Material.Rope, quantity: 1, sourceEventIds: ['source:accessible-tool-rope'] },
    );
    const other = structuredClone(actor);
    other.id = 'observed-tool-holder';
    other.geneticParents = [];
    other.body.nutrition = 100;
    other.inventory = [{
      id: 'observed-other-tool', materialId: Material.WoodTool, quantity: 1, sourceEventIds: ['source:observed-other-tool'],
    }];
    state.people = [actor, other];
    const visibleCells = cellsInRadius(center, 8);
    const withObservedOtherTool = buildProjectOptions(state, actor, visibleCells, [], [other]);
    assert.ok(withObservedOtherTool.some((option) => option.projectProposal?.desiredFunction === 'efficient-production'),
      '看见别人背包里的生产工具不得冒充本人当前可用能力');

    actor.inventory.push({
      id: 'accessible-own-tool', materialId: Material.WoodTool, quantity: 1, sourceEventIds: ['source:accessible-own-tool'],
    });
    const withOwnTool = buildProjectOptions(state, actor, visibleCells, [], [other]);
    const toolUpgrade = withOwnTool.find((option) => option.projectProposal?.desiredFunction === 'efficient-production');
    assert.ok(toolUpgrade,
      '木制工具只能部分缓解劳动压力，不能阻止人物继续寻找石锄级升级');
    assert.equal(toolUpgrade.projectProposal.productionToolBaselineRank, 1,
      '工具项目 proposal 必须冻结形成项目时本人实际持有的生产工具等级');
    actor.inventory.push({
      id: 'mid-project-bronze-tool', materialId: Material.BronzeTool, quantity: 1,
      sourceEventIds: ['source:mid-project-bronze-tool'],
    });
    const refreshedToolPressure = buildProjectPressureBasis(
      state,
      actor,
      toolUpgrade.projectProposal,
      2,
      { visibleCells, visibleDrops: [], visiblePeople: [other] },
    );
    assert.ok(refreshedToolPressure.edgeKeys.includes('state:production-tool-rank:1'),
      '项目途中拾取高级工具后，压力刷新仍必须使用 proposal 冻结的工具基线');
    actor.inventory = actor.inventory.filter((stack) => stack.id !== 'mid-project-bronze-tool');

    actor.inventory = actor.inventory.filter((stack) => stack.id !== 'accessible-own-tool');
    const visibleToolDrop = {
      id: 'accessible-visible-tool-drop', materialId: Material.WoodTool, quantity: 1,
      cellId: center, z: actor.position.z, createdAtMonth: 0,
      sourceEventIds: ['source:accessible-visible-tool-drop'],
    };
    state.world.drops = [visibleToolDrop];
    const withVisibleToolDrop = buildProjectOptions(state, actor, visibleCells, [visibleToolDrop], []);
    assert.ok(withVisibleToolDrop.some((option) => option.projectProposal?.desiredFunction === 'efficient-production'),
      '可合法拾取的木制工具仍低于石锄级目标，不能伪装成充分能力');

    actor.inventory.push({
      id: 'accessible-own-stone-hoe', materialId: Material.StoneHoe, quantity: 1, sourceEventIds: ['source:accessible-own-stone-hoe'],
    });
    const withAdequateTool = buildProjectOptions(state, actor, visibleCells, [visibleToolDrop], []);
    assert.ok(!withAdequateTool.some((option) => option.projectProposal?.desiredFunction === 'efficient-production'),
      '本人持有达到项目目标等级的石锄后才应抑制重复工具项目');
  }

  {
    const { state, actor, center } = createFixture(9621);
    actor.inventory.push(
      { id: 'granary-surplus-food', materialId: Material.Food, quantity: 10, sourceEventIds: ['source:granary-surplus-food'] },
      { id: 'granary-building-wood', materialId: Material.Wood, quantity: 1, sourceEventIds: ['source:granary-building-wood'] },
    );
    const other = structuredClone(actor);
    other.id = 'carried-granary-holder';
    other.geneticParents = [];
    other.body.nutrition = 100;
    other.inventory = [{
      id: 'carried-granary-component', materialId: Material.Granary, quantity: 1,
      sourceEventIds: ['source:carried-granary-component'],
    }];
    state.people = [actor, other];
    const visibleCells = cellsInRadius(center, 8);
    const withCarriedGranary = buildProjectOptions(state, actor, visibleCells, [], [other]);
    assert.ok(withCarriedGranary.some((option) => option.projectProposal?.desiredFunction === 'reserve-storage'),
      '别人背包里未落地的谷仓构件不得抑制当地储备项目');

    const facilityCell = cellId(cellX(center) + 1, cellY(center));
    setVoxel(state.world.grid, cellX(facilityCell), cellY(facilityCell), actor.position.z, Material.Granary);
    const withPlacedGranary = buildProjectOptions(state, actor, visibleCells, [], [other]);
    assert.ok(!withPlacedGranary.some((option) => option.projectProposal?.desiredFunction === 'reserve-storage'),
      '世界中真正落地的谷仓才应抑制重复储备项目');

    setVoxel(state.world.grid, cellX(facilityCell), cellY(facilityCell), actor.position.z, Material.Air);
    actor.knownPlaces.push({
      id: 'stale-remembered-granary',
      materialId: Material.Granary,
      position: { x: cellX(facilityCell), y: cellY(facilityCell), z: actor.position.z },
      learnedAtMonth: 0,
      lastConfirmedAtMonth: 0,
      sourceEventIds: ['source:stale-remembered-granary'],
    });
    const withStaleGranaryMemory = buildProjectOptions(state, actor, visibleCells, [], [other]);
    assert.ok(withStaleGranaryMemory.some((option) => option.projectProposal?.desiredFunction === 'reserve-storage'),
      '已与当前世界体素不符的过期地点记忆不得冒充落地谷仓');
  }

  {
    const { state, actor, center } = createFixture(9622);
    actor.inventory = [{
      id: 'kiln-pressure-clay', materialId: Material.Clay, quantity: 1, sourceEventIds: ['source:kiln-pressure-clay'],
    }];
    const other = structuredClone(actor);
    other.id = 'carried-kiln-holder';
    other.geneticParents = [];
    other.inventory = [{
      id: 'carried-kiln-component', materialId: Material.Kiln, quantity: 1, sourceEventIds: ['source:carried-kiln-component'],
    }];
    state.people = [actor, other];
    const visibleCells = cellsInRadius(center, 8);
    const view = { visibleCells, visibleDrops: [], visiblePeople: [other] };
    const carried = buildProjectPressureBasis(state, actor, {
      need: 'high-heat-capability', desiredFunction: 'high-heat-processing', beneficiaryIds: [actor.id], createdAtMonth: 1,
    }, 1, view);
    assert.ok(carried.pressure >= 42, '别人携带窑炉构件时本人的高温能力压力仍应成立');
    assert.ok(carried.reasonKeys.includes('high-heat-site-absent'),
      '携带中的设施构件必须记为高温工作地缺失');

    const kilnCell = cellId(cellX(center) + 1, cellY(center));
    setVoxel(state.world.grid, cellX(kilnCell), cellY(kilnCell), actor.position.z, Material.Kiln);
    const placed = buildProjectPressureBasis(state, actor, {
      need: 'high-heat-capability', desiredFunction: 'high-heat-processing', beneficiaryIds: [actor.id], createdAtMonth: 1,
    }, 1, view);
    assert.ok(placed.pressure < carried.pressure, '只有真正落地的窑炉才应降低高温能力压力');
    assert.ok(placed.reasonKeys.includes('high-heat-site-present'),
      '落地窑炉必须留下可回放的工作地存在证据');
  }

  {
    const { state, actor, center } = createFixture(9624);
    actor.inventory.push(
      { id: 'unreachable-tool-wood', materialId: Material.Wood, quantity: 1, sourceEventIds: ['source:unreachable-tool-wood'] },
      { id: 'unreachable-tool-rope', materialId: Material.Rope, quantity: 1, sourceEventIds: ['source:unreachable-tool-rope'] },
    );
    const visibleCells = cellsInRadius(center, 8);
    const unreachableTool = {
      id: 'visible-but-unreachable-bronze-tool', materialId: Material.BronzeTool, quantity: 1,
      cellId: center, z: actor.position.z + 4, createdAtMonth: 0,
      sourceEventIds: ['source:visible-but-unreachable-bronze-tool'],
    };
    const evidence = buildLocalMaterialEvidence(state, actor, {
      visibleCells, visibleDrops: [unreachableTool], visiblePeople: [],
    });
    assert.ok(evidence.observedMaterialIds.has(Material.BronzeTool),
      '可见但不可达的高级工具仍然是本人观察到的实体');
    assert.ok(!evidence.accessiblePortableMaterialIds.has(Material.BronzeTool),
      '没有可达站位的掉落工具不得冒充本人当前可使用能力');
    const options = buildProjectOptions(state, actor, visibleCells, [unreachableTool], []);
    assert.ok(options.some((option) => option.projectProposal?.desiredFunction === 'efficient-production'),
      '不可达高级工具不能压低真实的本地工具升级压力');
  }

  {
    const { state, actor, center } = createFixture(9610);
    actor.inventory.push(
      { id: 'local-tool-wood', materialId: Material.Wood, quantity: 1, sourceEventIds: ['source:local-tool-wood'] },
      { id: 'local-tool-rope', materialId: Material.Rope, quantity: 1, sourceEventIds: ['source:local-tool-rope'] },
    );
    const visibleCells = cellsInRadius(center, 8);
    const withoutRemote = buildProjectOptions(state, actor, visibleCells, [], []);
    assert.ok(withoutRemote.some((option) => option.projectProposal?.desiredFunction === 'efficient-production'),
      '远方对照夹具必须先能形成真实的本地工具项目');
    const remoteSite = cellId(70, 40);
    state.projects = [instantiateProject({
      id: 'unrelated-remote-tool-project',
      kind: 'production',
      need: 'production-efficiency',
      desiredFunction: 'efficient-production',
      summary: '远方陌生人的工具项目',
      ownerId: 'unrelated-remote-owner',
      beneficiaryIds: ['unrelated-remote-owner'],
      triggerFactIds: ['remote-tool-pressure'],
      pressure: 80,
      createdAtMonth: 0,
      reviewAtMonth: 120,
      site: { cellId: remoteSite, z: 1 },
    })];
    const withRemote = buildProjectOptions(state, actor, visibleCells, [], []);
    assert.deepEqual(withRemote, withoutRemote,
      '视野外且无人员、受益者、贡献或请求关联的同功能项目不得改变本地 options');
  }

  {
    const { state, actor, center } = createFixture(9611);
    actor.inventory = [{ id: 'local-building-stone', materialId: Material.Stone, quantity: 2, sourceEventIds: ['source:local-building-stone'] }];
    const visibleProgress = instantiateProject({
      id: 'visible-progress-shelter',
      kind: 'construction',
      need: 'shelter-capacity',
      desiredFunction: 'weather-shelter',
      summary: '眼前已有进展的遮蔽结构',
      ownerId: 'visible-builder',
      beneficiaryIds: ['visible-builder'],
      triggerFactIds: ['visible-progress-fact'],
      pressure: 80,
      createdAtMonth: 0,
      reviewAtMonth: 120,
      site: { cellId: center, z: actor.position.z },
    });
    visibleProgress.actionEventIds = ['visible-progress-fact'];
    state.projects = [visibleProgress];
    const options = buildProjectOptions(state, actor, cellsInRadius(center, 8), [], []);
    assert.equal(options[0]?.projectId, visibleProgress.id,
      '陌生人的 construction 只有在 site 可见且已有真实 action 时才应优先接续');
    assert.equal(options[0]?.projectProposal, undefined,
      '本地可见且已有进展的同功能 construction 不得再复制新项目');
  }

  {
    const { state, actor, center } = createFixture(9612);
    actor.inventory = [{ id: 'known-project-stone', materialId: Material.Stone, quantity: 1, sourceEventIds: ['source:known-project-stone'] }];
    const remoteSite = cellId(70, 40);
    const knownProject = instantiateProject({
      id: 'known-beneficiary-shelter',
      kind: 'construction',
      need: 'shelter-capacity',
      desiredFunction: 'weather-shelter',
      summary: '本人已是受益者的远处遮蔽项目',
      ownerId: 'known-builder',
      beneficiaryIds: [actor.id],
      triggerFactIds: ['known-project-benefit'],
      pressure: 70,
      createdAtMonth: 0,
      reviewAtMonth: 120,
      site: { cellId: remoteSite, z: actor.position.z },
    });
    state.projects = [knownProject];
    const options = buildProjectOptions(state, actor, cellsInRadius(center, 8), [], []);
    assert.equal(options[0]?.projectId, knownProject.id,
      '本人作为 beneficiary 已知的 construction 不要求 site 可见或先有进展，应优先现有项目');
    assert.equal(options[0]?.nextAction.kind, 'move', '远处已知项目应产生返回固定 site 的合法接续行动');
    assert.equal(options[0]?.projectProposal, undefined, '接续已知项目时不得创建新的 project proposal');
  }

  {
    const { state, actor, center } = createFixture(9613);
    actor.inventory = [
      { id: 'kiln-clay', materialId: Material.Clay, quantity: 1, sourceEventIds: ['source:kiln-clay'] },
      { id: 'kiln-stone', materialId: Material.Stone, quantity: 1, sourceEventIds: ['source:kiln-stone'] },
    ];
    const options = buildProjectOptions(state, actor, cellsInRadius(center, 8), [], []);
    const kiln = options.find((option) => option.projectProposal?.desiredFunction === 'high-heat-processing');
    assert.ok(kiln, '固定 construction site 夹具必须形成高温设施项目');
    assert.deepEqual(kiln.projectProposal.site, { cellId: actor.position.cellId, z: actor.position.z },
      '未显式给 site 的 construction 必须在提案时冻结到提案者当前位置');
  }

  {
    const { state, actor, center } = createFixture(9614);
    const roofZ = actor.position.z + 2;
    setVoxel(state.world.grid, cellX(center), cellY(center), roofZ, Material.Stone);
    const wallCell = cellId(cellX(center) + 1, cellY(center));
    setVoxel(state.world.grid, cellX(wallCell), cellY(wallCell), actor.position.z, Material.Stone);
    const exposureEvent = {
      id: 'same-site-adaptation-heat-source',
      kind: 'environment',
      atMonth: 0,
      orderInMonth: 0,
      cellId: center,
      change: 'condition',
      who: actor.id,
      result: `${actor.name}在当前住所内受到炎热伤害`,
      diff: { condition: 'heat', stage: 2 },
    };
    const progressEvent = actionFact(
      { ...actor, id: 'existing-shelter-builder' },
      'same-site-existing-shelter-progress',
      'combine',
      { outputMaterialId: Material.Stone, position: { x: cellX(wallCell), y: cellY(wallCell), z: actor.position.z } },
      wallCell,
    );
    state.world.past.push(exposureEvent, progressEvent);
    actor.conditions = [{
      id: 'same-site-adaptation-heat',
      kind: 'heat',
      stage: 2,
      sinceMonth: 0,
      sourceEventIds: [exposureEvent.id],
    }];
    actor.inventory = [{
      id: 'same-site-adaptation-stone',
      materialId: Material.Stone,
      quantity: 2,
      sourceEventIds: ['source:same-site-adaptation-stone'],
    }];
    const withoutExisting = buildProjectOptions(state, actor, cellsInRadius(center, 8), [], []);
    assert.ok(withoutExisting.some((option) => option.projectProposal?.shelterRequirement),
      '同址去重夹具必须先由真实 environment condition source 形成 shelter adaptation');
    const existing = instantiateProject({
      id: 'same-site-existing-weather-shelter',
      kind: 'construction',
      need: 'shelter-capacity',
      desiredFunction: 'weather-shelter',
      summary: '当前住所已有进展的遮蔽项目',
      ownerId: 'existing-shelter-builder',
      beneficiaryIds: ['existing-shelter-beneficiary'],
      triggerFactIds: [progressEvent.id],
      pressure: 80,
      createdAtMonth: 0,
      reviewAtMonth: 120,
      site: { cellId: center, z: actor.position.z },
    });
    existing.actionEventIds = [progressEvent.id];
    state.projects = [existing];

    const options = buildProjectOptions(state, actor, cellsInRadius(center, 8), [], []);
    assert.equal(options[0]?.projectId, existing.id,
      '真实住所暴露触发适应需求时，同址 active 遮蔽项目必须先被接续');
    assert.equal(options[0]?.projectProposal, undefined,
      '同址 active 遮蔽项目存在时不得另建 shelter adaptation proposal');

    actor.inventory = [];
    const withoutLegalStep = buildProjectOptions(state, actor, cellsInRadius(center, 8), [], []);
    assert.ok(!withoutLegalStep.some((option) => option.projectProposal?.desiredFunction === 'weather-shelter'),
      '局部重叠项目暂时没有合法步骤时，也不得另建重复 shelter adaptation');
  }

  {
    const { state, actor, center } = createFixture(9615);
    const neighbor = structuredClone(actor);
    neighbor.id = 'same-site-second-owner';
    neighbor.inventory = [{
      id: 'same-site-second-owner-stone',
      materialId: Material.Stone,
      quantity: 2,
      sourceEventIds: ['source:same-site-second-owner-stone'],
    }];
    state.people = [actor, neighbor];
    const visibleCells = cellsInRadius(center, 8);
    const firstProposal = {
      id: 'same-site-first-proposal',
      kind: 'construction',
      need: 'shelter-capacity',
      desiredFunction: 'weather-shelter',
      summary: '同一决策刻度先提交的住所项目',
      ownerId: actor.id,
      beneficiaryIds: [actor.id],
      triggerFactIds: ['same-site-first-pressure'],
      pressure: 80,
      createdAtMonth: 1,
      reviewAtMonth: 24,
      site: { cellId: center, z: actor.position.z },
    };
    const secondProposal = {
      id: 'same-site-second-proposal',
      kind: 'construction',
      need: 'shelter-capacity',
      desiredFunction: 'weather-shelter',
      summary: '同一决策刻度后提交的住所项目',
      ownerId: neighbor.id,
      beneficiaryIds: [neighbor.id],
      triggerFactIds: ['same-site-second-pressure'],
      pressure: 80,
      createdAtMonth: 1,
      reviewAtMonth: 24,
      site: { cellId: center, z: neighbor.position.z },
    };
    const first = ensureProject(state, firstProposal, { person: actor, visibleCells, atMonth: 1 });
    const second = ensureProject(state, secondProposal, { person: neighbor, visibleCells, atMonth: 1 });
    assert.equal(second.id, first.id,
      '同一决策刻度预先形成的同址同功能 proposal 必须在提交边界链接先提交项目');
    assert.equal(state.projects.length, 1,
      '同址同功能 proposal 顺序提交后只能保留一个权威 project');
    assert.deepEqual(first.beneficiaryIds, [actor.id, neighbor.id],
      '提交边界合并必须保留两个已被各自 proposal 选择的受益者');
    assert.deepEqual(first.triggerFactIds, ['same-site-first-pressure', 'same-site-second-pressure'],
      '提交边界合并必须保留第二个 proposal 的真实触发事实');
    assert.equal(first.ownerId, actor.id, '合并不能转移既有项目 owner');
    assert.equal(first.pressure, 80, '合并不能用第二个 proposal 覆盖既有项目 pressure');
    assert.deepEqual(first.site, { cellId: center, z: actor.position.z },
      '合并不能用第二个 proposal 改写既有项目 site');
    assert.ok(!first.contributorIds.includes(neighbor.id),
      '只形成 proposal 不能预登记第二人为 contributor');
    const mergedStep = recompileProjectNextAction(state, neighbor, first.id);
    assert.ok(mergedStep,
      '第二个提案者成为显式 beneficiary 后，必须能针对 existing project 重编译合法步骤');
    const mergedFact = executePrimitiveAction(state, neighbor, mergedStep, 1, 1, {
      cause: 'intent',
      actionTick: 1,
    });
    assert.equal(mergedFact.status, 'completed', mergedFact.result);
    state.world.past.push(mergedFact);
    recordProjectAction(state, first.id, mergedFact);
    assert.ok(first.contributorIds.includes(neighbor.id),
      '第二人只有提交真实完成行动后才能成为 contributor');
    const coalescedIntentTarget = bindIntentProjectTarget({
      kind: 'project-completed',
      projectId: 'same-site-second-proposal',
    }, second);
    assert.equal(coalescedIntentTarget.projectId, first.id,
      '合并后的 intent.projectId 必须指向提交边界返回的 existing project');
    assert.equal(coalescedIntentTarget.goal.kind === 'project-completed'
      ? coalescedIntentTarget.goal.projectId
      : undefined, first.id,
      '合并后的 project-completed goal 必须与 intent.projectId 一起重绑定 existing project');
  }

  {
    const { state, actor, center } = createFixture(9616);
    const remoteOwner = structuredClone(actor);
    remoteOwner.id = 'remote-second-owner';
    const remoteSite = cellId(70, 40);
    remoteOwner.position = {
      cellId: remoteSite,
      z: 1,
      previousCellId: remoteSite,
      previousZ: 1,
      lastPath: [],
      tickPath: [remoteSite],
    };
    state.people = [actor, remoteOwner];
    const first = ensureProject(state, {
      id: 'local-first-proposal',
      kind: 'construction',
      need: 'shelter-capacity',
      desiredFunction: 'weather-shelter',
      summary: '本地住所项目',
      ownerId: actor.id,
      beneficiaryIds: [actor.id],
      triggerFactIds: ['local-first-pressure'],
      pressure: 80,
      createdAtMonth: 1,
      reviewAtMonth: 24,
      site: { cellId: center, z: actor.position.z },
    }, { person: actor, visibleCells: cellsInRadius(center, 8), atMonth: 1 });
    const remote = ensureProject(state, {
      id: 'remote-second-proposal',
      kind: 'construction',
      need: 'shelter-capacity',
      desiredFunction: 'weather-shelter',
      summary: '远方无关联住所项目',
      ownerId: remoteOwner.id,
      beneficiaryIds: [remoteOwner.id],
      triggerFactIds: ['remote-second-pressure'],
      pressure: 80,
      createdAtMonth: 1,
      reviewAtMonth: 24,
      site: { cellId: remoteSite, z: remoteOwner.position.z },
    }, { person: remoteOwner, visibleCells: cellsInRadius(remoteSite, 8), atMonth: 1 });
    assert.notEqual(remote.id, first.id,
      '视野外且无受益、贡献或请求关联的远方同功能 proposal 不得在提交边界合并');
    assert.equal(state.projects.length, 2,
      '远方无关联 proposal 必须保留独立 project');
  }

  {
    const { state, actor, center } = createFixture(9617);
    const participant = structuredClone(actor);
    participant.id = 'same-month-shared-project-participant';
    state.people = [actor, participant];
    const project = instantiateProject({
      id: 'same-month-existing-project',
      kind: 'production',
      need: 'alloy-capability',
      desiredFunction: 'copper-smelting',
      summary: '等待 owner 当月既有步骤的共享项目',
      ownerId: actor.id,
      beneficiaryIds: [actor.id],
      triggerFactIds: ['same-month-existing-project-pressure'],
      pressure: 80,
      createdAtMonth: 1,
      reviewAtMonth: 24,
      site: { cellId: center, z: actor.position.z },
    });
    state.projects = [project];
    const proposal = {
      id: 'same-month-coalesced-proposal',
      kind: 'production',
      need: 'alloy-capability',
      desiredFunction: 'copper-smelting',
      summary: '同月形成但应合并的冶炼项目',
      ownerId: participant.id,
      beneficiaryIds: [participant.id],
      triggerFactIds: ['same-month-coalesced-pressure'],
      pressure: 80,
      createdAtMonth: 1,
      reviewAtMonth: 24,
      site: { cellId: center, z: participant.position.z },
    };
    const staleTarget = cellId(cellX(center) - 4, cellY(center));
    const staleNextAction = { kind: 'move', toCellId: staleTarget, toZ: participant.position.z };
    const optionId = 'project:same-month-coalesced-proposal:stale-next-action';
    const intent = startIntent(state, participant, {
      state,
      person: participant,
      visibleCells: cellsInRadius(center, 8),
      visiblePeople: [actor],
      visibleDrops: [],
      visibleAnimals: [],
      options: [{
        id: optionId,
        summary: '提交同址冶炼项目并沿旧路线行动',
        reason: '提交前规划快照仍指向自己的 proposal',
        goal: { kind: 'project-completed', projectId: proposal.id },
        nextAction: staleNextAction,
        estimatedDuration: 'several-months',
        sourceFactIds: [...proposal.triggerFactIds],
        domain: 'strategic',
        projectProposal: proposal,
      }],
      followUpOptions: [],
    }, optionId, undefined, 'same-month-coalesced-decision', 1);
    assert.ok(intent, '提交边界等待回归必须创建 linked intent');
    assert.equal(state.projects.length, 1, '同址同功能 proposal 必须链接 existing project');
    assert.equal(intent.projectId, project.id, 'coalesced intent 必须重绑定 existing project');
    assert.equal(intent.goal.kind === 'project-completed' ? intent.goal.projectId : undefined, project.id,
      'coalesced intent goal 必须与 existing project 保持一致');
    assert.equal(intent.openingAction, undefined,
      'coalesced proposal 的旧 nextAction 不得变成 opening action');
    assert.deepEqual(intent.actionEventIds, [], '提交合并本身不得伪造项目 action');
    assert.ok(project.beneficiaryIds.includes(participant.id),
      'coalesced proposal 的 beneficiary 必须继续并入 existing project');
    assert.ok(project.triggerFactIds.includes('same-month-coalesced-pressure'),
      'coalesced proposal 的 trigger fact 必须继续并入 existing project');
    const positionBeforeWait = structuredClone(participant.position);

    assert.equal(shouldWaitForSameMonthSharedProject(intent, project, participant.id, 1), true,
      '非 owner 的共享项目 intent 在创建月且项目仍 active 时应等待本月既有步骤');
    assert.equal(shouldWaitForSameMonthSharedProject(intent, project, actor.id, 1), false,
      'project owner 无步骤时不得套用共享项目等待语义');
    assert.equal(shouldWaitForSameMonthSharedProject(intent, project, participant.id, 2), false,
      '共享项目等待只允许发生在 intent 创建月');

    const waitResult = executeActiveIntent(state, participant, 1, 1, 1, []);
    assert.equal(waitResult, null, '同月共享项目暂无步骤时不应伪造 action fact');
    assert.equal(intent.status, 'active', '同月等待不得把共享项目 intent 标记 blocked');
    assert.equal(participant.activeIntentId, intent.id, '同月等待必须保留 active intent 供后续 tick 重编译');
    assert.equal(intent.replanCount, 0, '同月等待不是失败重规划');
    assert.deepEqual(participant.position, positionBeforeWait,
      '同月等待不得执行 coalesced proposal 的旧 nextAction 或改变人物位置');
    assert.deepEqual(intent.actionEventIds, [],
      '同月等待 existing project 时不得把旧 proposal 路线记成项目行动');
    assert.match(participant.currentActionText, /等待项目本月已有步骤/,
      '同月等待必须留下明确且非终态的当前动作说明');

    const nextMonthState = structuredClone(state);
    const nextMonthParticipant = nextMonthState.people.find((person) => person.id === participant.id);
    const nextMonthIntent = nextMonthState.intents.find((candidate) => candidate.id === intent.id);
    assert.ok(nextMonthParticipant && nextMonthIntent, '次月阻塞回归必须保留共享项目参与者和 intent');
    executeActiveIntent(nextMonthState, nextMonthParticipant, 2, 1, 1, []);
    assert.equal(nextMonthIntent.status, 'blocked',
      '创建月结束后仍无合法 step 必须回到原有 blocked 语义');
    assert.equal(nextMonthParticipant.activeIntentId, undefined,
      '次月确认无步骤后必须释放 active intent');

    project.status = 'completed';
    project.completedAtMonth = 1;
    executeActiveIntent(state, participant, 1, 2, 2, []);
    assert.equal(intent.status, 'completed',
      '等待期间 linked project 随后完成时，project-completed goal 必须完成 intent');
    assert.equal(participant.activeIntentId, undefined,
      'linked project 完成后必须释放等待中的 active intent');
  }

  {
    const { state, actor, center } = createFixture(9603);
    const fieldCell = cellId(cellX(center) + 2, cellY(center));
    const berryCell = cellId(cellX(center) + 1, cellY(center));
    setVoxel(state.world.grid, cellX(fieldCell), cellY(fieldCell), 0, Material.WetSoil);
    setVoxel(state.world.grid, cellX(berryCell), cellY(berryCell), 1, Material.BerryBush);
    const project = cultivationProject(state, actor, fieldCell, 'test-seed-first-project');
    const nextAction = recompileProjectNextAction(state, actor, project.id);
    assert.equal(nextAction?.kind, 'act', '缺种时应先执行真实取种步骤');
    assert.equal(nextAction?.kind === 'act' ? nextAction.operation : '', 'separate');
    assert.equal(project.logisticsEpisodes.at(-1)?.kind, 'source', '缺种应建立绑定浆果灌木的 source episode');
    assert.equal(project.hypothesisCampaign, undefined, '缺种不能误入无关材料假说');
  }

  {
    const { state, actor, center } = createFixture(9605);
    const project = cultivationProject(state, actor, center, 'test-waiting-field-project');
    actor.bornAtMonth = -20 * 12;
    actor.inventory.push({ id: 'waiting-seed', materialId: Material.Seed, quantity: 1, sourceEventIds: ['source:waiting-seed'] });
    setVoxel(state.world.grid, cellX(center), cellY(center), 0, Material.CropSprout);
    const waitingAction = recompileProjectNextAction(state, actor, project.id);
    assert.equal(waitingAction, null, '作物仍在生长且暂不可收获时应等待环境变化');
    assert.equal(project.hypothesisCampaign, undefined, '等待生长或湿润不能启动通用材料假说');
    const waitingIntent = {
      id: 'test-waiting-field-intent', ownerId: actor.id, summary: '等待固定耕地完成生长', domain: 'strategic',
      goal: { kind: 'project-completed', projectId: project.id },
      nextAction: { kind: 'move', toCellId: center, toZ: actor.position.z },
      status: 'active', createdAtMonth: 1, lastProgressAtMonth: 1, progress: 0.45,
      sourceDecisionEventId: 'test-waiting-field-decision', projectId: project.id,
      sourceFactIds: [...project.triggerFactIds], actionEventIds: [], replanCount: 0,
    };
    state.intents = [waitingIntent];
    actor.activeIntentId = waitingIntent.id;
    const failureMemoryCount = actor.memories.filter((memory) => memory.kind === 'failure').length;
    const waitingFact = executeActiveIntent(state, actor, 1, 0, 1, []);
    assert.equal(waitingFact, null, '真实自然生长等待不得伪造 ActionFact');
    assert.equal(waitingIntent.status, 'suspended', '自然生长等待应让出当前执行焦点而不是把项目判失败');
    assert.equal(waitingIntent.waitingFor, 'world-change', '等待必须保留可审计的外部世界变化原因');
    assert.equal(actor.activeIntentId, undefined, '等待世界变化时人物应能在后续刻度改做其他有用工作');
    assert.equal(waitingIntent.goalOutcome, undefined, '未发生目标尝试时不得写入 0 次达成的目标后验');
    assert.equal(actor.memories.filter((memory) => memory.kind === 'failure').length, failureMemoryCount,
      '合法等待不得制造失败记忆供模型反复围绕假失败提案');
  }

  {
    const { state, actor, center } = createFixture(9604);
    const project = cultivationProject(state, actor, center, 'test-local-completion-project');
    const fieldCells = cellsInRadius(center, 2).slice(0, 6);
    for (const localCell of fieldCells) {
      setVoxel(state.world.grid, cellX(localCell), cellY(localCell), 0, Material.ExhaustedSoil);
    }
    const plantings = fieldCells.map((fieldCell, index) => actionFact(
      actor,
      `test-project-planting-${index}`,
      'combine',
      { outputMaterialId: Material.CropSprout, position: { x: cellX(fieldCell), y: cellY(fieldCell), z: 0 } },
      fieldCell,
    ));
    const unrelatedHarvestA = actionFact(actor, 'test-unrelated-harvest-a', 'separate', { sourceMaterialId: Material.CropMature });
    const unrelatedHarvestB = actionFact(actor, 'test-unrelated-harvest-b', 'separate', { sourceMaterialId: Material.CropMature });
    state.world.past.push(...plantings, unrelatedHarvestA, unrelatedHarvestB);
    project.actionEventIds = plantings.map((event) => event.id);
    assert.equal(projectFunctionSatisfied(state, project), false,
      '别处或别的项目的收获不能替本项目完成耕作循环');
    const projectHarvestA = actionFact(actor, 'test-project-harvest-a', 'separate', { sourceMaterialId: Material.CropMature });
    const projectHarvestB = actionFact(actor, 'test-project-harvest-b', 'separate', { sourceMaterialId: Material.CropMature });
    state.world.past.push(projectHarvestA, projectHarvestB);
    project.actionEventIds.push(projectHarvestA.id, projectHarvestB.id);
    assert.equal(projectFunctionSatisfied(state, project), true,
      '固定地块内的播种和本项目两次真实收获才构成完成证据');
  }

  {
    const { state, actor } = createFixture(9624);
    const project = instantiateProject({
      id: 'test-frozen-tool-baseline-work-step',
      kind: 'production',
      need: 'production-efficiency',
      desiredFunction: 'efficient-production',
      summary: '测试途中取得高级工具后继续原项目',
      ownerId: actor.id,
      beneficiaryIds: [actor.id],
      triggerFactIds: ['pressure:test-frozen-tool-baseline-work-step'],
      pressure: 80,
      productionToolBaselineRank: 1,
      createdAtMonth: 0,
      reviewAtMonth: 120,
    });
    const rule = inventoryCombinationForOutput(Material.StoneHoe);
    assert.ok(rule, '石锄必须有可执行的实体配方');
    const techniqueId = inventoryCombinationTechniqueId(rule);
    actor.inventory = [{
      id: 'test-mid-project-iron-tool', materialId: Material.IronTool, quantity: 1,
      sourceEventIds: ['source:test-mid-project-iron-tool'],
    }, {
      id: 'test-stone-tool-input', materialId: Material.StoneTool, quantity: 1,
      sourceEventIds: ['source:test-stone-tool-input'],
    }, {
      id: 'test-plank-input', materialId: Material.Plank, quantity: 1,
      sourceEventIds: ['source:test-plank-input'],
    }];
    actor.knowledge = [{
      id: techniqueId,
      kind: 'technique',
      summary: '石制工具与木板可制成石锄',
      confidence: 68,
      learnedAtMonth: 0,
      sourceEventIds: ['source:test-stone-hoe-technique'],
    }];
    state.projects = [project];
    const nextAction = recompileProjectNextAction(state, actor, project.id);
    assert.equal(nextAction?.kind, 'act',
      '项目途中取得更高级工具后，冻结基线仍必须允许编译原项目升级成品');
    assert.deepEqual(nextAction?.kind === 'act'
      ? nextAction.targets.filter((target) => target.kind === 'inventory-stack').map((target) => target.stackId).sort()
      : [], ['test-plank-input', 'test-stone-tool-input'],
    '原项目必须继续使用已知石锄配方，不能因当前背包出现铁工具而跳过候选并死锁');
  }

  {
    const { state, actor } = createFixture(9625);
    const project = instantiateProject({
      id: 'test-bronze-tool-verification-project',
      kind: 'production',
      need: 'alloy-capability',
      desiredFunction: 'bronze-tooling',
      summary: '测试青铜工具从样品到可靠技艺',
      ownerId: actor.id,
      beneficiaryIds: [actor.id],
      triggerFactIds: ['pressure:test-bronze-tool-verification'],
      pressure: 80,
      productionToolBaselineRank: 1,
      createdAtMonth: 0,
      reviewAtMonth: 120,
      site: { cellId: actor.position.cellId, z: actor.position.z },
    });
    state.projects = [project];
    const rule = inventoryCombinationForOutput(Material.BronzeTool);
    assert.ok(rule, '青铜工具必须有可执行的实体配方');
    const techniqueId = inventoryCombinationTechniqueId(rule);
    const outputId = 'test-bronze-tool-first-output';
    const toolStackId = 'test-bronze-tool-first-stack';
    const output = actionFact(actor, outputId, 'combine', {
      techniqueId,
      inputMaterialIds: [Material.Bronze, Material.Wood],
      outputMaterialId: Material.BronzeTool,
      outputQuantity: 1,
      outputStackId: toolStackId,
    });
    actor.inventory = [{
      id: toolStackId,
      materialId: Material.BronzeTool,
      quantity: 1,
      sourceEventIds: [outputId],
    }, {
      id: 'test-mid-project-acquired-iron-tool',
      materialId: Material.IronTool,
      quantity: 1,
      sourceEventIds: ['test-mid-project-exchange'],
    }];
    actor.knowledge.push({
      id: techniqueId,
      kind: 'technique',
      summary: '青铜与木材可制成青铜工具',
      confidence: 46,
      learnedAtMonth: 1,
      sourceEventIds: [outputId],
    });
    state.world.past.push(output);
    project.actionEventIds = [outputId];
    assert.equal(projectFunctionSatisfied(state, project), false,
      '第一件偶然样品和46置信度技艺不能让工具项目立即完成');

    const verificationId = 'test-bronze-tool-source-bound-verification';
    state.world.past.push({
      ...actionFact(actor, verificationId, 'attend', {
        factId: techniqueId,
        verifiedTechnique: true,
        verifiedSourceEventId: outputId,
        verifiedMaterialId: Material.BronzeTool,
        verifiedStackId: toolStackId,
      }),
      action: { kind: 'attend', target: { kind: 'inventory-stack', personId: actor.id, stackId: toolStackId } },
    });
    project.actionEventIds.push(verificationId);
    const knowledge = actor.knowledge.find((fact) => fact.id === techniqueId);
    knowledge.confidence = 68;
    knowledge.sourceEventIds.push(verificationId);
    assert.equal(projectFunctionSatisfied(state, project), true,
      '途中交换得到更高级工具不能改写冻结基线；项目原定升级经过源绑定复验后仍应完成');
  }

  {
    const { state, actor, center } = createFixture(9626);
    const partner = structuredClone(actor);
    partner.id = 'test-tool-exchange-partner';
    partner.name = '工具持有者';
    actor.inventory = [{
      id: 'test-current-wood-tool',
      materialId: Material.WoodTool,
      quantity: 1,
      sourceEventIds: ['test-current-wood-tool-source'],
    }, {
      id: 'test-exchange-offer-material',
      materialId: Material.Food,
      quantity: 2,
      sourceEventIds: ['test-exchange-offer-source'],
    }];
    partner.inventory = [{
      id: 'test-requested-bronze-tool',
      materialId: Material.BronzeTool,
      quantity: 2,
      sourceEventIds: ['test-requested-tool-source'],
    }];
    state.people = [actor, partner];
    const labor = actionFact(actor, 'test-tool-exchange-labor', 'separate', {
      sourceMaterialId: Material.Wood,
      outputs: [{ materialId: Material.Plank, quantity: 1 }],
    });
    state.world.past.push(labor);
    const representationId = 'test-tool-upgrade-exchange';
    const option = {
      id: representationId,
      summary: '用食物交换青铜生产工具',
      reason: '本人近期生产劳动显示青铜工具可以节省劳动',
      goal: { kind: 'representation-made', representationId },
      nextAction: {
        kind: 'communicate',
        content: {
          id: representationId,
          kind: 'offer',
          summary: '用食物交换青铜工具',
          proposal: {
            kind: 'exchange',
            offererId: actor.id,
            partnerId: partner.id,
            offererMaterialId: Material.Food,
            offererQuantity: 1,
            partnerMaterialId: Material.BronzeTool,
            partnerQuantity: 1,
            expiresAtMonth: 12,
          },
        },
        audience: [partner.id],
        channel: 'voice',
      },
      target: { kind: 'person', personId: partner.id },
      estimatedDuration: 'one-month',
      sourceFactIds: [labor.id, 'test-exchange-offer-source', 'test-requested-tool-source'],
      domain: 'social',
    };
    const context = {
      state,
      person: actor,
      visibleCells: cellsInRadius(center, 8),
      visiblePeople: [partner],
      visibleDrops: [],
      visibleAnimals: [],
      options: [option],
      followUpOptions: [],
    };
    const need = evaluateDecisionOption(context, option, { atMonth: 1, planningTick: 1 })
      .votes.find((item) => item.tree === 'need');
    assert.ok(need?.score > 0,
      '工具交换必须用 proposal 中请求材料的等级差和本人近期生产劳动形成正向需要票');
    assert.match(need.reasons.join('；'), /交换取得更高效工具/,
      '工具交换评分必须留下可解释的劳动节省因果理由');
  }

  process.stdout.write('causal development eligibility tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
