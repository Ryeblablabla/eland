import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-four-era-test-'));
const bundlePath = path.join(temporaryDirectory, 'four-era.mjs');

try {
  const testEntry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { calculateCivilizationIndex } from ${JSON.stringify(path.resolve('src/game/eland/domain/civilization-index.ts'))};
    export { observeCivilizationDevelopment, observeFunctionalBuildings } from ${JSON.stringify(path.resolve('src/game/eland/domain/era-progression.ts'))};
    export { containerById, containerIdAt, GRANARY_CAPACITY } from ${JSON.stringify(path.resolve('src/game/eland/domain/container.ts'))};
    export { findReachableWater } from ${JSON.stringify(path.resolve('src/game/eland/domain/water-access.ts'))};
    export { buildContainerOptions } from ${JSON.stringify(path.resolve('src/game/eland/application/container-options.ts'))};
    export { buildProjectOptions, ensureProject, recompileProjectNextAction, recordProjectAction } from ${JSON.stringify(path.resolve('src/game/eland/application/project-options.ts'))};
    export { cellX, cellY, neighbors4, setVoxel, voxelAt } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=four-era-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: testEntry, stdio: ['pipe', 'pipe', 'pipe'] });
  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    Material, buildContainerOptions, buildProjectOptions, calculateCivilizationIndex, cellX, cellY, containerById, containerIdAt,
    createInitialState, executePrimitiveAction, findReachableWater, GRANARY_CAPACITY,
    neighbors4, observeCivilizationDevelopment, observeFunctionalBuildings, setVoxel, voxelAt,
    ensureProject, recompileProjectNextAction, recordProjectAction,
  } = api;

  const geology = createInitialState(20260816, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const geologyIds = new Set(geology.world.drops.map((drop) => drop.materialId));
  assert.ok(geologyIds.has(Material.Clay), '世界必须实际生成黏土');
  assert.ok(geologyIds.has(Material.CopperOre), '世界必须实际生成铜矿');
  assert.ok(geologyIds.has(Material.TinOre), '世界必须实际生成锡矿');
  assert.ok(geologyIds.has(Material.IronOre), '世界必须实际生成铁矿');
  const spawnCell = geology.people[0].position.cellId;
  const distanceFromSpawn = (cellId) => Math.abs(cellX(cellId) - cellX(spawnCell))
    + Math.abs(cellY(cellId) - cellY(spawnCell));
  assert.ok(geology.world.drops.filter((drop) => drop.materialId === Material.CopperOre
    && distanceFromSpawn(drop.cellId) >= 7 && distanceFromSpawn(drop.cellId) <= 16).length >= 3,
  '初始大区应保证至少三处可探索铜矿点');
  assert.ok(geology.world.drops.filter((drop) => drop.materialId === Material.TinOre
    && distanceFromSpawn(drop.cellId) >= 12 && distanceFromSpawn(drop.cellId) <= 24).length >= 2,
  '邻近外圈应保证至少两处更稀少的锡矿点');

  const state = createInitialState(814, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  state.world.past = [];
  const actor = state.people[0];
  state.people = [actor];
  const supportedNeighbor = neighbors4(actor.position.cellId).map((cellId) => ({
    cellId,
    x: cellX(cellId),
    y: cellY(cellId),
    z: actor.position.z,
  })).find((position) => voxelAt(state.world.grid, position.x, position.y, position.z) === Material.Air
    && voxelAt(state.world.grid, position.x, position.y, position.z - 1) !== Material.Air
    && !state.people.some((person) => person.position.cellId === position.cellId));
  assert.ok(supportedNeighbor, '测试出生点旁必须存在可放置位置');

  actor.inventory = [{ id: 'container-stack', materialId: Material.Container, quantity: 1, sourceEventIds: ['made-container'] }];
  const placement = executePrimitiveAction(state, actor, {
    kind: 'act', operation: 'combine', targets: [
      { kind: 'inventory-stack', personId: actor.id, stackId: 'container-stack' },
      { kind: 'voxel', position: supportedNeighbor },
    ],
  }, 1, 0, { cause: 'intent', actionTick: 1 });
  assert.equal(placement.status, 'completed', placement.result);
  state.world.past.push(placement);
  const granaryId = containerIdAt(supportedNeighbor);
  const woodenContainer = containerById(state, granaryId);
  assert.ok(woodenContainer, '放置后的木制容器必须进入容器状态');
  woodenContainer.inventory.push({ id: 'stored-food', materialId: Material.Food, quantity: 5, sourceEventIds: ['stored-food'] });
  actor.inventory = [{ id: 'upgrade-plank', materialId: Material.Plank, quantity: 1, sourceEventIds: ['upgrade-plank'] }];
  const upgrade = executePrimitiveAction(state, actor, {
    kind: 'act', operation: 'combine', targets: [
      { kind: 'inventory-stack', personId: actor.id, stackId: 'upgrade-plank' },
      { kind: 'voxel', position: supportedNeighbor },
    ],
  }, 2, 0, { cause: 'intent', actionTick: 1 });
  assert.equal(upgrade.status, 'completed', upgrade.result);
  const granary = containerById(state, granaryId);
  assert.equal(granary?.capacity, GRANARY_CAPACITY, '公共谷仓必须拥有 96 单位容量');
  assert.equal(granary?.inventory[0]?.quantity, 5, '容器改造成谷仓时必须保留原有储物');
  actor.body.nutrition = 80;
  actor.inventory = [{ id: 'single-food', materialId: Material.Food, quantity: 1, sourceEventIds: ['single-food'] }];
  const granaryCellId = supportedNeighbor.x + supportedNeighbor.y * state.world.grid.width;
  const storeFood = buildContainerOptions(state, actor, [granaryCellId])
    .find((option) => option.id.startsWith('store-container:'));
  assert.equal(storeFood?.nextAction.kind, 'transfer', '谷仓必须允许把单份盈余食物存入公共储备');
  assert.equal(storeFood?.nextAction.kind === 'transfer' ? storeFood.nextAction.quantity : 0, 1);

  setVoxel(state.world.grid, supportedNeighbor.x, supportedNeighbor.y, supportedNeighbor.z, Material.Workshop);
  actor.inventory = [{ id: 'wood-stack', materialId: Material.Wood, quantity: 2, sourceEventIds: ['wood'] }];
  const workshopProduction = executePrimitiveAction(state, actor, {
    kind: 'act', operation: 'combine', targets: [
      { kind: 'inventory-stack', personId: actor.id, stackId: 'wood-stack' },
      { kind: 'inventory-stack', personId: actor.id, stackId: 'wood-stack' },
    ],
  }, 2, 0, { cause: 'intent', actionTick: 1 });
  assert.equal(workshopProduction.status, 'completed');
  assert.equal(workshopProduction.diff.outputQuantity, 3, '工坊附近制作应比基础配方多产出一份');
  assert.equal(workshopProduction.diff.facilityMaterialId, Material.Workshop);

  setVoxel(state.world.grid, supportedNeighbor.x, supportedNeighbor.y, supportedNeighbor.z, Material.Cistern);
  actor.body.hydration = 10;
  const water = findReachableWater(state, actor, [supportedNeighbor.cellId]);
  assert.deepEqual(water?.waterPosition, { x: supportedNeighbor.x, y: supportedNeighbor.y, z: supportedNeighbor.z }, '蓄水池必须进入真实寻水路径');
  const drink = executePrimitiveAction(state, actor, {
    kind: 'act', operation: 'ingest', targets: [{ kind: 'voxel', position: supportedNeighbor }],
  }, 3, 0, { cause: 'survival-reflex', actionTick: 1 });
  assert.equal(drink.status, 'completed');
  assert.ok(actor.body.hydration > 10, '从蓄水池饮用必须恢复水分');

  setVoxel(state.world.grid, supportedNeighbor.x, supportedNeighbor.y, supportedNeighbor.z, Material.Kiln);
  actor.inventory = [{ id: 'kiln-wood', materialId: Material.Wood, quantity: 1, sourceEventIds: ['kiln-wood'] }];
  const kilnCharcoal = executePrimitiveAction(state, actor, {
    kind: 'act', operation: 'expose', targets: [
      { kind: 'inventory-stack', personId: actor.id, stackId: 'kiln-wood' },
      { kind: 'voxel', position: supportedNeighbor },
    ],
  }, 4, 0, { cause: 'intent', actionTick: 1 });
  assert.equal(kilnCharcoal.status, 'completed');
  assert.equal(kilnCharcoal.diff.outputMaterialId, Material.Charcoal, '固定窑炉必须能把项目木料转化为冶炼所需木炭');
  actor.inventory = [{ id: 'copper-charge', materialId: Material.CopperCharge, quantity: 1, sourceEventIds: ['charge'] }];
  const smelt = executePrimitiveAction(state, actor, {
    kind: 'act', operation: 'expose', targets: [
      { kind: 'inventory-stack', personId: actor.id, stackId: 'copper-charge' },
      { kind: 'voxel', position: supportedNeighbor },
    ],
  }, 4, 0, { cause: 'intent', actionTick: 1 });
  assert.equal(smelt.status, 'completed');
  assert.equal(smelt.diff.outputMaterialId, Material.Copper, '窑炉必须真实完成铜料冶炼');
  assert.equal(smelt.diff.facilityMaterialId, Material.Kiln);

  actor.inventory = [
    { id: 'copper', materialId: Material.Copper, quantity: 1, sourceEventIds: ['copper'] },
    { id: 'tin', materialId: Material.Tin, quantity: 1, sourceEventIds: ['tin'] },
  ];
  const bronze = executePrimitiveAction(state, actor, {
    kind: 'act', operation: 'combine', targets: actor.inventory.map((stack) => (
      { kind: 'inventory-stack', personId: actor.id, stackId: stack.id }
    )),
  }, 5, 0, { cause: 'intent', actionTick: 1 });
  assert.equal(bronze.status, 'completed');
  assert.equal(bronze.diff.outputMaterialId, Material.Bronze, '铜与锡必须经过实体配方形成青铜');

  setVoxel(state.world.grid, supportedNeighbor.x, supportedNeighbor.y, supportedNeighbor.z, Material.Smithy);
  actor.inventory = [{ id: 'iron-charge', materialId: Material.IronCharge, quantity: 1, sourceEventIds: ['iron-charge'] }];
  const reduction = executePrimitiveAction(state, actor, {
    kind: 'act', operation: 'expose', targets: [
      { kind: 'inventory-stack', personId: actor.id, stackId: 'iron-charge' },
      { kind: 'voxel', position: supportedNeighbor },
    ],
  }, 6, 0, { cause: 'intent', actionTick: 1 });
  assert.equal(reduction.status, 'completed');
  assert.equal(reduction.diff.outputMaterialId, Material.IronBloom, '铁矿炭料必须先在铁匠铺还原为海绵铁');
  actor.inventory = [
    { id: 'iron-bloom', materialId: Material.IronBloom, quantity: 1, sourceEventIds: ['iron-bloom'] },
    { id: 'charcoal', materialId: Material.Charcoal, quantity: 1, sourceEventIds: ['charcoal'] },
  ];
  const wroughtIron = executePrimitiveAction(state, actor, {
    kind: 'act', operation: 'combine', targets: actor.inventory.map((stack) => (
      { kind: 'inventory-stack', personId: actor.id, stackId: stack.id }
    )),
  }, 7, 0, { cause: 'intent', actionTick: 1 });
  assert.equal(wroughtIron.status, 'completed');
  assert.equal(wroughtIron.diff.outputMaterialId, Material.Iron, '海绵铁必须与木炭继续锻炼成铁');

  const coordinationState = createInitialState(815, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  coordinationState.world.past = [];
  coordinationState.world.drops = coordinationState.world.drops.filter((drop) => ![
    Material.CopperOre, Material.Charcoal, Material.Wood,
  ].includes(drop.materialId));
  const owner = coordinationState.people[0];
  const contributor = coordinationState.people[1];
  coordinationState.people = [owner, contributor];
  contributor.position = structuredClone(owner.position);
  const coordinationKiln = neighbors4(owner.position.cellId).map((cellId) => ({
    cellId, x: cellX(cellId), y: cellY(cellId), z: owner.position.z,
  })).find((position) => voxelAt(coordinationState.world.grid, position.x, position.y, position.z) === Material.Air
    && voxelAt(coordinationState.world.grid, position.x, position.y, position.z - 1) !== Material.Air);
  assert.ok(coordinationKiln, '协作测试需要相邻窑炉位置');
  setVoxel(coordinationState.world.grid, coordinationKiln.x, coordinationKiln.y, coordinationKiln.z, Material.Kiln);
  owner.inventory = [];
  contributor.inventory = [{ id: 'shared-copper-ore', materialId: Material.CopperOre, quantity: 3, sourceEventIds: ['observed-copper'] }];
  const sharedProject = ensureProject(coordinationState, {
    id: 'shared-copper-charge-project', kind: 'production', need: 'alloy-capability', desiredFunction: 'copper-charge',
    summary: '在固定窑炉汇合铜矿与木炭', ownerId: owner.id, beneficiaryIds: [owner.id, contributor.id],
    triggerFactIds: ['observed-copper'], pressure: 80, createdAtMonth: 1, reviewAtMonth: 36,
    site: { cellId: coordinationKiln.cellId, z: coordinationKiln.z },
  });
  let requestAction = recompileProjectNextAction(coordinationState, owner, sharedProject.id);
  for (let tick = 1; requestAction?.kind === 'move' && tick <= 8; tick += 1) {
    const moveFact = executePrimitiveAction(coordinationState, owner, requestAction, 1, tick, { cause: 'intent', actionTick: tick });
    assert.ok(moveFact.status === 'completed' || moveFact.status === 'progressed', moveFact.result);
    coordinationState.world.past.push(moveFact);
    recordProjectAction(coordinationState, sharedProject.id, moveFact);
    requestAction = recompileProjectNextAction(coordinationState, owner, sharedProject.id);
  }
  assert.equal(requestAction?.kind, 'communicate', `项目所有者应对附近持料者提出有来源的贡献请求：${JSON.stringify(requestAction)}`);
  assert.equal(requestAction?.kind === 'communicate'
    ? requestAction.content.kind === 'request' && requestAction.content.projectMaterialContribution?.materialId
    : undefined, Material.CopperOre);
  const requestFact = executePrimitiveAction(coordinationState, owner, requestAction, 1, 0, { cause: 'intent', actionTick: 1 });
  assert.equal(requestFact.status, 'completed', requestFact.result);
  coordinationState.world.past.push(requestFact);
  recordProjectAction(coordinationState, sharedProject.id, requestFact);
  assert.equal(sharedProject.materialContributionRequests?.[0]?.contributorIds[0], contributor.id);
  ensureProject(coordinationState, {
    id: 'contributor-own-inquiry', kind: 'inquiry', need: 'knowledge-continuity', desiredFunction: 'durable-record',
    summary: '记录自己的观察', ownerId: contributor.id, beneficiaryIds: [contributor.id],
    triggerFactIds: ['own-observation'], pressure: 52, createdAtMonth: 1, reviewAtMonth: 12,
  });
  const contribution = buildProjectOptions(
    coordinationState,
    contributor,
    [owner.position.cellId, coordinationKiln.cellId],
    [],
    [owner],
  ).find((option) => option.projectId === sharedProject.id);
  assert.ok(contribution, '收到的项目材料请求不能被持料者自己的未完项目遮蔽');
  let contributionAction = contribution?.nextAction;
  for (let tick = 9; contributionAction?.kind === 'move' && tick <= 20; tick += 1) {
    const moveFact = executePrimitiveAction(coordinationState, contributor, contributionAction, 1, tick, { cause: 'intent', actionTick: tick });
    assert.ok(moveFact.status === 'completed' || moveFact.status === 'progressed', moveFact.result);
    coordinationState.world.past.push(moveFact);
    recordProjectAction(coordinationState, sharedProject.id, moveFact);
    contributionAction = recompileProjectNextAction(coordinationState, contributor, sharedProject.id);
  }
  assert.equal(contributionAction?.kind, 'transfer', '收到请求的持料者应在固定工地交接项目材料');
  const contributionFact = executePrimitiveAction(coordinationState, contributor, contributionAction, 1, 20, { cause: 'intent', actionTick: 20 });
  assert.equal(contributionFact.status, 'completed', contributionFact.result);
  coordinationState.world.past.push(contributionFact);
  recordProjectAction(coordinationState, sharedProject.id, contributionFact);
  assert.equal(owner.inventory.find((stack) => stack.materialId === Material.CopperOre)?.quantity, 1);
  assert.ok(sharedProject.contributorIds.includes(contributor.id), '真实材料交接必须把持料者记为项目贡献者');
  assert.equal(sharedProject.materialContributionRequests?.[0]?.contributedQuantity, 1);
  assert.equal(recompileProjectNextAction(coordinationState, contributor, sharedProject.id), null,
    '同月完成请求数量后必须立即停止重复交付');

  const mineralState = createInitialState(816, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const observer = mineralState.people[0];
  const listener = mineralState.people[1];
  mineralState.people = [observer, listener];
  const mineralDrop = mineralState.world.drops.find((drop) => drop.materialId === Material.CopperOre);
  assert.ok(mineralDrop);
  observer.position.cellId = mineralDrop.cellId;
  observer.position.z = mineralDrop.z;
  listener.position = structuredClone(observer.position);
  const observeMineral = executePrimitiveAction(mineralState, observer, {
    kind: 'transfer', materialId: Material.CopperOre, quantity: 1,
    from: { kind: 'ground', cellId: mineralDrop.cellId, z: mineralDrop.z },
    to: { kind: 'person', personId: observer.id }, dropId: mineralDrop.id,
  }, 1, 0, { cause: 'intent', actionTick: 1 });
  assert.equal(observeMineral.status, 'completed');
  mineralState.world.past.push(observeMineral);
  const mineralKnowledge = observer.knowledge.find((fact) => fact.id.startsWith('observation:mineral-deposit:'));
  assert.ok(mineralKnowledge, '取得矿石必须形成带坐标的矿源观察');
  assert.ok(observer.knownPlaces.some((place) => place.materialId === Material.CopperOre));
  const shareMineral = executePrimitiveAction(mineralState, observer, {
    kind: 'communicate',
    content: { id: 'share-mineral-place', kind: 'claim', summary: mineralKnowledge.summary, factId: mineralKnowledge.id },
    audience: [listener.id], channel: 'voice',
  }, 1, 1, { cause: 'intent', actionTick: 2 });
  assert.equal(shareMineral.status, 'completed', shareMineral.result);
  assert.ok(listener.knownPlaces.some((place) => place.materialId === Material.CopperOre
    && place.position.x === cellX(mineralDrop.cellId)
    && place.position.y === cellY(mineralDrop.cellId)), '真实沟通必须把矿点位置传播给听者');

  const facilityState = createInitialState(99, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const facilityActor = facilityState.people[0];
  const facilityPosition = { x: cellX(facilityActor.position.cellId), y: cellY(facilityActor.position.cellId), z: facilityActor.position.z + 1 };
  setVoxel(facilityState.world.grid, facilityPosition.x, facilityPosition.y, facilityPosition.z, Material.CouncilHearth);
  facilityState.world.past.push({
    id: 'install-core', kind: 'action', actionTick: 1, atMonth: 1, orderInMonth: 0,
    cellId: facilityActor.position.cellId, who: facilityActor.id, cause: 'intent',
    action: { kind: 'act', operation: 'combine', targets: [] },
    fromCellId: facilityActor.position.cellId, toCellId: facilityActor.position.cellId,
    fromZ: facilityActor.position.z, toZ: facilityActor.position.z, pathSegment: [facilityActor.position.cellId],
    status: 'completed', result: '设置议事火塘',
    diff: { outputMaterialId: Material.CouncilHearth, position: facilityPosition },
  });
  assert.equal(observeFunctionalBuildings(facilityState)[0]?.materialId, Material.CouncilHearth);

  const expanded = createInitialState(100, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const founder = expanded.people[0];
  expanded.people = Array.from({ length: 24 }, (_, index) => ({
    ...structuredClone(founder), id: `population-${index}`, name: `测试人口${index}`,
  }));
  const openIndex = calculateCivilizationIndex(expanded);
  assert.ok(openIndex.total > 100, '文明指数必须是开放式累计值，不能封顶 100');
  assert.equal(openIndex.formulaVersion, 'open-material-institution-v1');
  const development = observeCivilizationDevelopment(expanded, openIndex.total);
  assert.equal(development.currentEra, 'primitive-tribe', '人口和指数本身不能跳过材料、建筑与制度门槛');
  assert.ok(development.missingGateIds.includes('material:masonry-stone:distributed'));

  const replenishment = createInitialState(817, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const metalworker = replenishment.people[0];
  replenishment.people = [metalworker];
  const kilnPosition = neighbors4(metalworker.position.cellId).map((cellId) => ({
    cellId, x: cellX(cellId), y: cellY(cellId), z: metalworker.position.z,
  })).find((position) => voxelAt(replenishment.world.grid, position.x, position.y, position.z) === Material.Air
    && voxelAt(replenishment.world.grid, position.x, position.y, position.z - 1) !== Material.Air);
  assert.ok(kilnPosition, '补产测试需要人物眼前存在可工作的固定窑炉位置');
  setVoxel(replenishment.world.grid, kilnPosition.x, kilnPosition.y, kilnPosition.z, Material.Kiln);
  const completedCharge = ensureProject(replenishment, {
    id: 'historical-copper-charge', kind: 'production', need: 'alloy-capability', desiredFunction: 'copper-charge',
    summary: '历史上完成过一批铜矿炭料', ownerId: metalworker.id, beneficiaryIds: [metalworker.id],
    triggerFactIds: [], pressure: 64, createdAtMonth: 1, reviewAtMonth: 36,
    site: { cellId: kilnPosition.cellId, z: kilnPosition.z },
  });
  completedCharge.status = 'completed';
  completedCharge.completedAtMonth = 1;
  metalworker.knownPlaces.push({
    id: 'remembered-copper-source', materialId: Material.CopperOre,
    position: { x: cellX(metalworker.position.cellId), y: cellY(metalworker.position.cellId), z: metalworker.position.z },
    learnedAtMonth: 1, lastConfirmedAtMonth: 1, sourceEventIds: ['observed-copper-ore'],
  });
  metalworker.inventory = [
    { id: 'replenish-copper-ore', materialId: Material.CopperOre, quantity: 1, sourceEventIds: ['observed-copper-ore'] },
    { id: 'replenish-charcoal', materialId: Material.Charcoal, quantity: 1, sourceEventIds: ['made-charcoal'] },
    { id: 'remaining-copper-charge', materialId: Material.CopperCharge, quantity: 1, sourceEventIds: ['historical-charge'] },
  ];
  const visibleReplenishmentCells = [metalworker.position.cellId, kilnPosition.cellId];
  const stockedOptions = buildProjectOptions(replenishment, metalworker, visibleReplenishmentCells, [], []);
  assert.ok(!stockedOptions.some((option) => option.projectProposal?.desiredFunction === 'copper-charge'),
    '上一批铜料仍在眼前时，不应只因历史上完成过冶炼就重复开同一补产项目');
  metalworker.inventory = metalworker.inventory.filter((stack) => stack.materialId !== Material.CopperCharge);
  const sharedInFlightCharge = ensureProject(replenishment, {
    id: 'shared-in-flight-copper-charge', kind: 'production', need: 'alloy-capability', desiredFunction: 'copper-charge',
    summary: '另一处固定工地正在补产铜料', ownerId: 'remote-metalworker', beneficiaryIds: [metalworker.id],
    triggerFactIds: [], pressure: 64, createdAtMonth: 2, reviewAtMonth: 37,
    site: { cellId: metalworker.position.cellId, z: metalworker.position.z },
  });
  const inFlightOptions = buildProjectOptions(replenishment, metalworker, visibleReplenishmentCells, [], []);
  assert.ok(!inFlightOptions.some((option) => option.projectProposal?.desiredFunction === 'copper-charge'),
    '已有同功能补产项目在制时，小人口共同体不应在另一座窑炉并发复制供应链');
  sharedInFlightCharge.status = 'blocked';
  const replenishmentOptions = buildProjectOptions(replenishment, metalworker, visibleReplenishmentCells, [], []);
  assert.ok(replenishmentOptions.some((option) => option.projectProposal?.desiredFunction === 'copper-charge'),
    '上一批铜料被下游消耗后，只要原料和固定工地仍可观察，就应允许创建新的补产项目');

  process.stdout.write('four-era evolution tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
