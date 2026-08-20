import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-tool-adoption-'));
const bundlePath = path.join(temporaryDirectory, 'tool-adoption.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export { buildDecisionContext, recompileNextAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/action-options.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export { projectFunctionSatisfied } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
    export {
      bestHuntingToolStack,
      bestProductionToolStack,
      huntingToolBonus,
      productionToolMultiplier,
      productionToolRank,
      recentPersonalProductionLaborEvents,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/production-tool.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { cellId, cellX, cellY, cellsInRadius, setVoxel } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=tool-adoption-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    bestHuntingToolStack,
    bestProductionToolStack,
    buildDecisionContext,
    cellId,
    cellX,
    cellY,
    cellsInRadius,
    createInitialState,
    executePrimitiveAction,
    instantiateProject,
    huntingToolBonus,
    productionToolMultiplier,
    productionToolRank,
    projectFunctionSatisfied,
    recentPersonalProductionLaborEvents,
    recompileNextAction,
    setVoxel,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const atMonth = 20;
  const center = cellId(42, 26);

  function stack(id, materialId, quantity = 1, extra = {}) {
    return { id, materialId, quantity, sourceEventIds: [`source:${id}`], ...extra };
  }

  function placePerson(person, targetCell = center, z = 1) {
    delete person.diedAtMonth;
    person.bornAtMonth = -30 * 12;
    person.position = {
      ...person.position,
      cellId: targetCell,
      z,
      previousCellId: targetCell,
      previousZ: z,
      lastPath: [],
      tickPath: [targetCell],
    };
    person.body = { health: 100, hydration: 100, nutrition: 100 };
    person.conditions = [];
    person.inventory = [];
    person.knowledge = [];
    person.knownPlaces = [];
    person.memories = [];
    delete person.activeIntentId;
  }

  function flatten(state, anchor = center, radius = 10) {
    for (const localCell of cellsInRadius(anchor, radius)) {
      const x = cellX(localCell);
      const y = cellY(localCell);
      for (let z = 0; z < state.world.grid.levels; z += 1) {
        setVoxel(state.world.grid, x, y, z, z === 0 ? Material.PackedSoil : Material.Air);
      }
    }
  }

  function fixture(seed) {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 48 }, chaosIntensity: 0 });
    const animalTemplate = structuredClone(state.world.animals.find((animal) => animal.speciesId === 'wolf')
      ?? state.world.animals[0]);
    state.clock.elapsedMonths = atMonth;
    state.world.past = [];
    state.world.drops = [];
    state.world.animals = [];
    state.lastStep = [];
    state.intents = [];
    state.agreements = [];
    state.permissions = [];
    state.collectives = [];
    state.containers = [];
    state.records = [];
    state.eraPredictions = [];
    state.projects = [];
    state.civilization.epoch = 'stable';
    state.civilization.climate = { kind: 'temperate', severity: 0, sinceMonth: 0 };
    state.civilization.weather = { kind: 'clear', intensity: 0, sinceMonth: 0 };
    flatten(state);
    for (const person of state.people) person.diedAtMonth = 0;
    const actor = state.people[0];
    const partner = state.people[1];
    assert.ok(actor && partner, '定向夹具需要至少两名人物');
    placePerson(actor);
    placePerson(partner);
    return { state, actor, partner, animalTemplate };
  }

  function laborFact(actor, month = atMonth - 1, id = `labor:${actor.id}:${month}`) {
    return {
      id,
      kind: 'action',
      actionTick: 1,
      atMonth: month,
      orderInMonth: 1,
      cellId: actor.position.cellId,
      who: actor.id,
      cause: 'intent',
      action: {
        kind: 'act',
        operation: 'separate',
        targets: [{ kind: 'voxel', position: { x: cellX(actor.position.cellId), y: cellY(actor.position.cellId), z: 0 } }],
      },
      fromCellId: actor.position.cellId,
      toCellId: actor.position.cellId,
      fromZ: actor.position.z,
      toZ: actor.position.z,
      pathSegment: [actor.position.cellId],
      status: 'completed',
      result: '本人完成了一次有真实产出的分离劳动',
      diff: {
        sourceMaterialId: Material.CropMature,
        outputs: [{ materialId: Material.Food, quantity: 4 }],
      },
    };
  }

  function intentFromOption(option, ownerId) {
    return {
      id: `intent:${option.id}`,
      ownerId,
      summary: option.summary,
      domain: option.domain ?? 'strategic',
      goal: structuredClone(option.goal),
      nextAction: structuredClone(option.nextAction),
      ...(option.target ? { target: structuredClone(option.target) } : {}),
      status: 'active',
      createdAtMonth: atMonth,
      lastProgressAtMonth: atMonth,
      progress: 0,
      sourceDecisionEventId: `decision:${option.id}`,
      sourceFactIds: [...option.sourceFactIds],
      actionEventIds: [],
      replanCount: 0,
    };
  }

  {
    const { state, actor, partner } = fixture(20_260_820);
    actor.inventory = [
      stack('spear', Material.Spear),
      stack('wood-tool', Material.WoodTool),
      stack('stone-tool', Material.StoneTool),
      stack('stone-hoe', Material.StoneHoe),
      stack('bronze-tool', Material.BronzeTool),
      stack('iron-tool', Material.IronTool),
    ];
    assert.deepEqual([
      productionToolRank(Material.Spear),
      productionToolRank(Material.WoodTool),
      productionToolRank(Material.BoneTool),
      productionToolRank(Material.StoneTool),
      productionToolRank(Material.StoneHoe),
      productionToolRank(Material.BronzeTool),
      productionToolRank(Material.IronTool),
    ], [0, 1, 1, 2, 3, 4, 5], '长矛不再冒充通用生产工具，生产等级严格单调');
    assert.deepEqual([
      productionToolMultiplier(Material.WoodTool),
      productionToolMultiplier(Material.BoneTool),
      productionToolMultiplier(Material.StoneTool),
      productionToolMultiplier(Material.StoneHoe),
      productionToolMultiplier(Material.BronzeTool),
      productionToolMultiplier(Material.IronTool),
    ], [1.4, 1.4, 1.7, 1.9, 2.5, 3.1]);
    assert.equal(bestProductionToolStack(actor)?.id, 'iron-tool');
    assert.deepEqual([
      huntingToolBonus(Material.Spear),
      huntingToolBonus(Material.BronzeTool),
      huntingToolBonus(Material.IronTool),
    ], [0.3, 0.38, 0.48]);
    assert.equal(bestHuntingToolStack(actor)?.id, 'iron-tool',
      '捕猎工具必须按真实 bonus 选择，而不是固定优先长矛');

    state.world.past.push(
      laborFact(actor),
      laborFact(partner, atMonth - 1, 'other-person-labor'),
      laborFact(actor, atMonth - 13, 'stale-own-labor'),
      laborFact(actor, atMonth + 1, 'future-own-labor'),
    );
    assert.deepEqual(recentPersonalProductionLaborEvents(state, actor.id, atMonth).map((event) => event.id), [
      `labor:${actor.id}:${atMonth - 1}`,
    ], '近期劳动证据只读取本人、过去十二个月内的真实完成事实');
  }

  function harvest(sourceMaterialId, toolMaterialId, seed) {
    const { state, actor } = fixture(seed);
    const target = { x: cellX(center) + 1, y: cellY(center), z: 1 };
    setVoxel(state.world.grid, target.x, target.y, target.z, sourceMaterialId);
    if (toolMaterialId !== undefined) actor.inventory = [stack(`tool:${toolMaterialId}`, toolMaterialId)];
    return executePrimitiveAction(state, actor, {
      kind: 'act',
      operation: 'separate',
      targets: [{ kind: 'voxel', position: target }],
      ...(toolMaterialId !== undefined ? { toolStackId: `tool:${toolMaterialId}` } : {}),
    }, atMonth, 1, { cause: 'intent', actionTick: 1 });
  }

  function outputQuantity(event, materialId) {
    return event.diff.outputs.find((output) => output.materialId === materialId)?.quantity ?? 0;
  }

  {
    const handCrop = harvest(Material.CropMature, undefined, 831);
    const spearCrop = harvest(Material.CropMature, Material.Spear, 832);
    const woodCrop = harvest(Material.CropMature, Material.WoodTool, 833);
    const bronzeCrop = harvest(Material.CropMature, Material.BronzeTool, 834);
    const ironCrop = harvest(Material.CropMature, Material.IronTool, 835);
    assert.equal(handCrop.status, 'completed');
    assert.equal(spearCrop.diff.productionMultiplier, 1);
    assert.equal(spearCrop.diff.toolMaterialId, undefined, '长矛不能为作物生产提供通用倍率');
    assert.deepEqual([
      outputQuantity(handCrop, Material.Food),
      outputQuantity(woodCrop, Material.Food),
      outputQuantity(bronzeCrop, Material.Food),
      outputQuantity(ironCrop, Material.Food),
    ], [4, 5, 10, 12], '木、青铜、铁工具对成熟作物形成可见且单调的产量跃升');

    const handBerry = harvest(Material.BerryBush, undefined, 836);
    const bronzeBerry = harvest(Material.BerryBush, Material.BronzeTool, 837);
    const ironBerry = harvest(Material.BerryBush, Material.IronTool, 838);
    assert.deepEqual([
      [outputQuantity(handBerry, Material.Food), outputQuantity(handBerry, Material.Seed)],
      [outputQuantity(bronzeBerry, Material.Food), outputQuantity(bronzeBerry, Material.Seed)],
      [outputQuantity(ironBerry, Material.Food), outputQuantity(ironBerry, Material.Seed)],
    ], [[3, 1], [7, 2], [9, 3]], '浆果采集同样使用统一生产倍率');
  }

  function huntWithTool(toolMaterialId, seed) {
    const { state, actor, animalTemplate } = fixture(seed);
    assert.ok(animalTemplate, '定向捕猎夹具需要一只动物');
    const animal = structuredClone(animalTemplate);
    delete animal.diedAtMonth;
    animal.health = 100;
    animal.position = {
      cellId: actor.position.cellId,
      z: actor.position.z,
      previousCellId: actor.position.cellId,
      previousZ: actor.position.z,
    };
    state.world.animals = [animal];
    actor.inventory = [stack(`hunt-tool:${toolMaterialId}`, toolMaterialId)];
    return executePrimitiveAction(state, actor, {
      kind: 'act', operation: 'hunt', targets: [{ kind: 'animal', animalId: animal.id }],
      toolStackId: `hunt-tool:${toolMaterialId}`,
    }, atMonth, 1, { cause: 'intent', actionTick: 1 });
  }

  {
    const bronzeHunt = huntWithTool(Material.BronzeTool, 839);
    const ironHunt = huntWithTool(Material.IronTool, 840);
    assert.ok(['progressed', 'completed'].includes(bronzeHunt.status));
    assert.ok(['progressed', 'completed'].includes(ironHunt.status));
    assert.deepEqual([
      bronzeHunt.diff.toolMaterialId,
      bronzeHunt.diff.toolStackId,
      bronzeHunt.diff.toolBonus,
    ], [Material.BronzeTool, `hunt-tool:${Material.BronzeTool}`, 0.38]);
    assert.deepEqual([
      ironHunt.diff.toolMaterialId,
      ironHunt.diff.toolStackId,
      ironHunt.diff.toolBonus,
    ], [Material.IronTool, `hunt-tool:${Material.IronTool}`, 0.48],
    '青铜/铁工具的捕猎效用必须写入 progressed 或 completed 事实');
  }

  {
    const { state, actor, animalTemplate } = fixture(8401);
    assert.ok(animalTemplate);
    const animal = structuredClone(animalTemplate);
    delete animal.diedAtMonth;
    animal.health = 100;
    animal.position = {
      cellId: actor.position.cellId,
      z: actor.position.z,
      previousCellId: actor.position.cellId,
      previousZ: actor.position.z,
    };
    state.world.animals = [animal];
    actor.inventory = [
      stack('hunt-spear', Material.Spear),
      stack('hunt-bronze', Material.BronzeTool),
      stack('hunt-iron', Material.IronTool),
    ];
    const immediate = buildDecisionContext(state, actor, atMonth).options.find((option) => option.id === `hunt:${animal.id}`);
    assert.equal(immediate?.nextAction.kind, 'act');
    assert.equal(immediate?.nextAction.toolStackId, 'hunt-iron', '初始近身捕猎应选择最高真实 bonus 工具');

    const targetCell = cellId(cellX(center) + 2, cellY(center));
    animal.position = {
      cellId: targetCell,
      z: 1,
      previousCellId: targetCell,
      previousZ: 1,
    };
    const travelingOption = buildDecisionContext(state, actor, atMonth).options.find((option) => option.id === `hunt:${animal.id}`);
    assert.equal(travelingOption?.nextAction.kind, 'move');
    const intent = intentFromOption(travelingOption, actor.id);
    placePerson(actor, targetCell, 1);
    actor.inventory = [
      stack('hunt-spear', Material.Spear),
      stack('hunt-bronze', Material.BronzeTool),
      stack('hunt-iron', Material.IronTool),
    ];
    const recompiled = recompileNextAction(state, actor, intent, atMonth);
    assert.equal(recompiled?.kind, 'act');
    assert.equal(recompiled?.operation, 'hunt');
    assert.equal(recompiled?.toolStackId, 'hunt-iron',
      '移动后捕猎重编译必须与初始选择使用同一 bonus 排序');
  }

  {
    const { state, actor } = fixture(841);
    actor.inventory = [stack('spear', Material.Spear), stack('iron', Material.IronTool)];
    const treeCell = cellId(cellX(center) + 3, cellY(center));
    setVoxel(state.world.grid, cellX(treeCell), cellY(treeCell), 1, Material.Wood);
    const option = buildDecisionContext(state, actor, atMonth).options.find((candidate) => candidate.id === `separate:wood:${treeCell}`);
    assert.equal(option?.nextAction.kind, 'move', '树木目标应先产生移动步骤');
    const intent = intentFromOption(option, actor.id);
    placePerson(actor, option.nextAction.toCellId, 1);
    actor.inventory = [stack('spear', Material.Spear), stack('iron', Material.IronTool)];
    const recompiled = recompileNextAction(state, actor, intent, atMonth);
    assert.equal(recompiled?.kind, 'act');
    assert.equal(recompiled?.operation, 'separate');
    assert.equal(recompiled?.toolStackId, 'iron', '到达树木后重编译仍附带当前最佳生产工具');
  }

  {
    const { state, actor } = fixture(842);
    actor.inventory = [stack('spear', Material.Spear), stack('iron', Material.IronTool)];
    const cropCell = cellId(cellX(center) + 3, cellY(center));
    setVoxel(state.world.grid, cellX(cropCell), cellY(cropCell), 1, Material.CropMature);
    const option = buildDecisionContext(state, actor, atMonth).options.find((candidate) => candidate.id === `harvest:${cropCell}`);
    assert.equal(option?.nextAction.kind, 'move', '成熟作物目标应先产生移动步骤');
    const intent = intentFromOption(option, actor.id);
    placePerson(actor, cropCell, 2);
    actor.inventory = [stack('spear', Material.Spear), stack('iron', Material.IronTool)];
    const recompiled = recompileNextAction(state, actor, intent, atMonth);
    assert.equal(recompiled?.kind, 'act');
    assert.equal(recompiled?.operation, 'separate');
    assert.equal(recompiled?.toolStackId, 'iron', '到达成熟作物后重编译仍附带当前最佳生产工具');
  }

  {
    const { state, actor } = fixture(851);
    actor.inventory = [stack('wood-tool', Material.WoodTool)];
    const exactCell = cellId(cellX(center) + 3, cellY(center));
    const exactDrop = {
      id: 'better-tool-exact', materialId: Material.IronTool, quantity: 1,
      cellId: exactCell, z: 1, createdAtMonth: atMonth, sourceEventIds: ['made:iron-tool'],
    };
    state.world.drops = [exactDrop];
    assert.equal(buildDecisionContext(state, actor, atMonth).options.some((option) => option.id === `adopt-production-tool:${exactDrop.id}`), false,
      '没有本人近期生产劳动时，不产生明确工具升级候选');
    const labor = laborFact(actor);
    state.world.past.push(labor);
    const upgrade = buildDecisionContext(state, actor, atMonth).options.find((option) => option.id === `adopt-production-tool:${exactDrop.id}`);
    assert.ok(upgrade, '本人近期生产劳动与可见可达的更优地面工具应形成明确升级候选');
    assert.deepEqual(upgrade.target, { kind: 'drop', dropId: exactDrop.id });
    assert.ok(upgrade.sourceFactIds.includes(labor.id));
    const intent = intentFromOption(upgrade, actor.id);
    const decoyCell = cellId(cellX(center) + 1, cellY(center));
    state.world.drops.push({
      ...exactDrop,
      id: 'better-tool-decoy',
      cellId: decoyCell,
      sourceEventIds: ['made:decoy-tool'],
    });
    const traveling = recompileNextAction(state, actor, intent, atMonth);
    assert.equal(traveling?.kind, 'move');
    assert.equal(traveling?.toCellId, exactCell, '持续 intent 不应改追更近的同材质掉落物');
    placePerson(actor, exactCell, 1);
    actor.inventory = [stack('wood-tool', Material.WoodTool)];
    const pickup = recompileNextAction(state, actor, intent, atMonth);
    assert.equal(pickup?.kind, 'transfer');
    assert.equal(pickup?.dropId, exactDrop.id, '取得动作必须绑定最初看见的 exact drop');
    state.world.drops = state.world.drops.filter((drop) => drop.id !== exactDrop.id);
    assert.equal(recompileNextAction(state, actor, intent, atMonth), null,
      '锁定掉落物消失后应重新规划，不能静默切换到替代掉落物');
  }

  {
    const noLabor = fixture(860);
    noLabor.actor.inventory = [stack('wood-tool', Material.WoodTool), stack('barter-fiber', Material.Fiber, 2)];
    noLabor.partner.inventory = [stack('two-bronze-tools', Material.BronzeTool, 2)];
    const noLaborContext = buildDecisionContext(noLabor.state, noLabor.actor, atMonth);
    assert.equal(noLaborContext.options.some((option) => option.nextAction.kind === 'communicate'
      && option.nextAction.content.proposal?.kind === 'exchange'
      && option.nextAction.content.proposal.partnerMaterialId === Material.BronzeTool), false,
    '即使对方有两件高级工具，请求者没有近期本人劳动证据也不能绕过专用门禁');

    const { state, actor, partner } = fixture(861);
    actor.inventory = [stack('wood-tool', Material.WoodTool), stack('barter-fiber', Material.Fiber, 2)];
    partner.inventory = [stack('sole-bronze-tool', Material.BronzeTool)];
    state.world.past.push(laborFact(actor));
    let context = buildDecisionContext(state, actor, atMonth);
    assert.equal(context.options.some((option) => option.id.startsWith('offer-tool-upgrade:')), false,
      '对方只有唯一高级生产工具且无备份时，不提出交换');
    assert.equal(context.options.some((option) => option.nextAction.kind === 'transfer'
      && option.nextAction.from.kind === 'person'
      && option.nextAction.from.personId === partner.id), false,
    '升级候选绝不能直接取得他人私有背包物');

    partner.inventory.push(stack('spear-backup', Material.Spear));
    context = buildDecisionContext(state, actor, atMonth);
    assert.equal(context.options.some((option) => option.id.startsWith('offer-tool-upgrade:')), false,
      '长矛不是生产工具备份');
    partner.inventory.push(stack('wood-tool-backup', Material.WoodTool));
    context = buildDecisionContext(state, actor, atMonth);
    assert.equal(context.options.some((option) => option.id.startsWith('offer-tool-upgrade:')), false,
      '唯一青铜工具加低级木工具仍会降低持有者最高能力，不能交易');
    partner.inventory.push(stack('bronze-tool-backup', Material.BronzeTool));
    context = buildDecisionContext(state, actor, atMonth);
    const offer = context.options.find((option) => option.id.startsWith('offer-tool-upgrade:'));
    assert.equal(offer?.nextAction.kind, 'communicate', '持有者保留同级青铜备份时，才产生自愿交换报价');
    assert.equal(offer?.nextAction.content.proposal?.kind, 'exchange');
    assert.equal(offer?.nextAction.content.proposal?.offererMaterialId, Material.Fiber);
    assert.equal(offer?.nextAction.content.proposal?.offererQuantity, 1);
    assert.equal(offer?.nextAction.content.proposal?.partnerMaterialId, Material.BronzeTool);

    actor.inventory.find((item) => item.id === 'barter-fiber').quantity = 1;
    context = buildDecisionContext(state, actor, atMonth);
    assert.equal(context.options.some((option) => option.id.startsWith('offer-tool-upgrade:')), false,
      '请求者不能用唯一一份实体物质交换工具');
  }

  {
    const { state, actor } = fixture(871);
    const outputEventId = 'project-bronze-tool-output';
    const techniqueId = 'technique:test:bronze-tool';
    const outputStack = stack('project-bronze-tool', Material.BronzeTool, 1, { sourceEventIds: [outputEventId] });
    actor.inventory = [outputStack];
    actor.knowledge = [{
      id: techniqueId,
      kind: 'technique',
      summary: '把青铜加工为生产工具',
      confidence: 46,
      learnedAtMonth: atMonth,
      sourceEventIds: [outputEventId],
    }];
    const manufacture = {
      id: outputEventId,
      kind: 'action',
      actionTick: 1,
      atMonth,
      orderInMonth: 1,
      cellId: actor.position.cellId,
      who: actor.id,
      cause: 'intent',
      action: { kind: 'act', operation: 'combine', targets: [] },
      fromCellId: actor.position.cellId,
      toCellId: actor.position.cellId,
      fromZ: actor.position.z,
      toZ: actor.position.z,
      pathSegment: [actor.position.cellId],
      status: 'completed',
      result: '首次制成青铜生产工具',
      diff: { outputMaterialId: Material.BronzeTool, outputStackId: outputStack.id, techniqueId },
    };
    state.world.past.push(manufacture);
    const project = instantiateProject({
      id: 'project:test-bronze-tool',
      kind: 'production',
      need: 'alloy-capability',
      desiredFunction: 'bronze-tooling',
      summary: '制造并核验青铜生产工具',
      ownerId: actor.id,
      beneficiaryIds: [actor.id],
      triggerFactIds: [],
      pressure: 60,
      createdAtMonth: atMonth,
      reviewAtMonth: atMonth + 12,
    });
    project.actionEventIds.push(outputEventId);
    assert.equal(projectFunctionSatisfied(state, project), false,
      '首件工具与置信度46的初步技艺不能提前完成工具项目');
    const verification = executePrimitiveAction(state, actor, {
      kind: 'attend',
      target: { kind: 'inventory-stack', personId: actor.id, stackId: outputStack.id },
      verification: { techniqueId, sourceEventId: outputEventId, expectedMaterialId: Material.BronzeTool },
    }, atMonth, 2, { cause: 'intent', actionTick: 2 });
    assert.equal(verification.status, 'completed');
    assert.equal(verification.diff.verifiedTechnique, true);
    assert.ok(actor.knowledge.find((fact) => fact.id === techniqueId).confidence >= 55);
    assert.equal(projectFunctionSatisfied(state, project), true,
      '对首件产物进行 source-bound 核验并形成可靠技艺后，工具项目才完成');
  }

  console.log('tool adoption regression passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
