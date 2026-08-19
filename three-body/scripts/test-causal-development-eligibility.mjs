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
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export {
      buildProjectOptions,
      projectFunctionSatisfied,
      recompileProjectNextAction,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
    export { buildProjectPressureBasis } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-pressure.ts'))};
    export { buildLocalMaterialEvidence } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/local-material-evidence.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
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
    buildProjectOptions,
    buildLocalMaterialEvidence,
    buildProjectPressureBasis,
    cellId,
    cellX,
    cellY,
    cellsInRadius,
    createInitialState,
    instantiateProject,
    projectFunctionSatisfied,
    recompileProjectNextAction,
    setVoxel,
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
    actor.inventory.push({ id: 'waiting-seed', materialId: Material.Seed, quantity: 1, sourceEventIds: ['source:waiting-seed'] });
    const waitingAction = recompileProjectNextAction(state, actor, project.id);
    assert.equal(waitingAction, null, '地块暂时不可播种或收获时应等待环境变化');
    assert.equal(project.hypothesisCampaign, undefined, '等待生长或湿润不能启动通用材料假说');
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

  process.stdout.write('causal development eligibility tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
