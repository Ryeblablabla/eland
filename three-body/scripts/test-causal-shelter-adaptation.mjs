import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-causal-shelter-adaptation-test-'));
const bundlePath = path.join(temporaryDirectory, 'causal-shelter-adaptation.mjs');

try {
  const entry = `
    export { createInitialState, createSimulation } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export {
      buildProjectOptions,
      ensureProject,
      projectFunctionSatisfied,
      recordProjectAction,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export {
      chooseFailedShelterHibernationReflex,
      chooseSurvivalReflex,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/survival-reflex.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { shelterGeometryAt, shelterHeatRelief } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/structure.ts'))};
    export { worldEventById } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/event-index.ts'))};
    export {
      cellId,
      cellX,
      cellY,
      cellsInRadius,
      neighbors4,
      setVoxel,
      voxelAt,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=causal-shelter-adaptation-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    buildProjectOptions,
    cellId,
    cellX,
    cellY,
    cellsInRadius,
    chooseFailedShelterHibernationReflex,
    chooseSurvivalReflex,
    createInitialState,
    createSimulation,
    ensureProject,
    executePrimitiveAction,
    neighbors4,
    projectFunctionSatisfied,
    recordProjectAction,
    setVoxel,
    shelterGeometryAt,
    shelterHeatRelief,
    voxelAt,
    worldEventById,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  function itemStack(id, materialId, quantity) {
    return { id, materialId, quantity, sourceEventIds: [`source:${id}`] };
  }

  function resetPerson(person, position) {
    delete person.diedAtMonth;
    person.position = {
      cellId: position.cellId,
      z: position.z,
      previousCellId: position.cellId,
      previousZ: position.z,
      lastPath: [],
      tickPath: [position.cellId],
    };
    person.body = { health: 100, hydration: 100, nutrition: 100 };
    person.conditions = [];
    person.inventory = [];
    person.knowledge = [];
    person.knownPlaces = [];
    person.memories = [];
    delete person.activeIntentId;
  }

  function createFixture(seed) {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
    const actor = state.people[0];
    assert.ok(actor, '定向测试需要至少一名人物');
    const center = cellId(42, 26);
    const site = { cellId: center, z: 1 };

    for (const localCell of cellsInRadius(center, 10)) {
      const x = cellX(localCell);
      const y = cellY(localCell);
      for (let z = 0; z < state.world.grid.levels; z += 1) {
        setVoxel(state.world.grid, x, y, z, z === 0 ? Material.PackedSoil : Material.Air);
      }
    }
    setVoxel(state.world.grid, cellX(center), cellY(center), site.z + 2, Material.Stone);
    const initialWallCell = neighbors4(center)[0];
    setVoxel(state.world.grid, cellX(initialWallCell), cellY(initialWallCell), site.z, Material.Stone);

    state.clock.elapsedMonths = 12;
    state.projects = [];
    state.intents = [];
    state.records = [];
    state.world.drops = [];
    state.world.past = [];
    state.derived.structures = [];
    state.civilization.climate.kind = 'temperate';
    state.civilization.climate.severity = 0;
    state.civilization.weather.kind = 'clear';
    state.civilization.weather.intensity = 0;
    for (const person of state.people) person.diedAtMonth = 0;
    resetPerson(actor, site);
    actor.baselineCapacities.perception = 100;

    const shelter = shelterGeometryAt(state.world.grid, site);
    assert.ok(shelter, '夹具必须形成真实可用住所');
    assert.equal(shelter.enclosedSides, 1, '夹具初始住所必须只有一面侧墙');
    assert.equal(shelter.openSides, 3);
    return { state, actor, center, site, initialWallCell, shelter };
  }

  function addHeatExposure(state, beneficiary, eventId, { source = true, stage = 2 } = {}) {
    if (source) {
      state.world.past.push({
        id: eventId,
        kind: 'environment',
        atMonth: 11,
        orderInMonth: state.world.past.length,
        cellId: beneficiary.position.cellId,
        change: 'condition',
        who: beneficiary.id,
        result: `${beneficiary.name}进入炎热状态`,
        diff: { condition: 'heat', stage },
      });
    }
    beneficiary.conditions.push({
      id: `condition-heat-${beneficiary.id}`,
      kind: 'heat',
      stage,
      sinceMonth: 11,
      sourceEventIds: source ? [eventId] : [],
    });
  }

  function maximizeShelter(state, center, site) {
    for (const wallCell of neighbors4(center).slice(1, 3)) {
      setVoxel(state.world.grid, cellX(wallCell), cellY(wallCell), site.z, Material.Stone);
    }
    const shelter = shelterGeometryAt(state.world.grid, site);
    assert.ok(shelter, '最大化夹具必须仍保留一个可通行入口');
    assert.equal(shelter.enclosedSides, 3);
    assert.equal(shelter.openSides, 1);
    return shelter;
  }

  function makeFailedShelterEmergency(state, actor) {
    state.civilization.era = {
      sequence: 1, kind: 'chaotic', sinceMonth: 12, endsAtMonth: 100, dominantClimate: 'heat',
    };
    state.civilization.epoch = 'chaotic';
    state.civilization.climate = { kind: 'heat', severity: 5, sinceMonth: 12 };
    state.civilization.externalClimate = { epoch: 'chaotic', kind: 'heat', severity: 5 };
    actor.body = { health: 86, hydration: 74, nutrition: 71 };
    addHeatExposure(state, actor, 'test-maxed-shelter-heat-event', { stage: 2 });
  }

  function optionsFor(state, actor, visiblePeople = []) {
    return buildProjectOptions(
      state,
      actor,
      cellsInRadius(actor.position.cellId, 8),
      state.world.drops,
      visiblePeople,
    );
  }

  function adaptationOptions(state, actor, visiblePeople = []) {
    return optionsFor(state, actor, visiblePeople)
      .filter((option) => Boolean(option.projectProposal?.shelterRequirement));
  }

  {
    const { state, actor, center, site, initialWallCell, shelter: baselineShelter } = createFixture(9501);
    actor.inventory.push(itemStack('test-adaptation-stone', Material.Stone, 2));
    const heatEventId = 'test-resolvable-self-heat-event';
    addHeatExposure(state, actor, heatEventId);

    const proposalOptions = adaptationOptions(state, actor);
    assert.equal(proposalOptions.length, 1, '本人在真实住所内有带来源 heat condition 时应派生一个适应项目');
    const proposalOption = proposalOptions[0];
    const proposal = proposalOption.projectProposal;
    assert.ok(proposal?.shelterRequirement);
    assert.equal(proposal.kind, 'construction');
    assert.equal(proposal.desiredFunction, 'weather-shelter');
    assert.deepEqual(
      { cellId: proposal.site?.cellId, z: proposal.site?.z },
      site,
      '适应项目必须固定在受伤时的同一住所位置',
    );
    assert.deepEqual(proposal.beneficiaryIds, [actor.id]);
    assert.deepEqual(proposal.shelterRequirement, {
      exposureKind: 'heat',
      beneficiaryId: actor.id,
      baselineEnclosedSides: 1,
      baselineOpenSides: 3,
      baselineWeatherProtection: baselineShelter.weatherProtection,
      baselineThermalInsulation: baselineShelter.thermalInsulation,
      minimumEnclosedSides: 3,
      sourceEventIds: [heatEventId],
    });
    const resolvedHeatEvent = worldEventById(state, heatEventId);
    assert.ok(resolvedHeatEvent?.kind === 'environment' && resolvedHeatEvent.change === 'condition');
    assert.equal(resolvedHeatEvent.who, actor.id);
    assert.equal(resolvedHeatEvent.diff.condition, 'heat');
    assert.ok(resolvedHeatEvent.atMonth < proposal.createdAtMonth, '暴露来源事件必须早于项目形成');
    assert.ok(proposal.triggerFactIds.includes(heatEventId), '项目压力来源必须保留可解析 heat 事件');

    const project = ensureProject(state, proposal);
    assert.equal(project.status, 'active');
    assert.equal(projectFunctionSatisfied(state, project), false,
      '已有屋顶和一面墙只满足基础住所，不能立即满足适应项目');

    const bodyBeforeConstruction = structuredClone(actor.body);
    const heatBeforeConstruction = structuredClone(actor.conditions.find((condition) => condition.kind === 'heat'));
    const reliefs = [shelterHeatRelief(baselineShelter)];
    const placementCells = [];
    let actionOrder = 0;

    function executeNextPlacement(expectedSides) {
      const option = optionsFor(state, actor).find((candidate) => candidate.projectId === project.id);
      assert.ok(option, `围护达到 ${expectedSides - 1} 面时必须可编译下一次同址补墙`);
      assert.equal(option.nextAction.kind, 'act');
      assert.equal(option.nextAction.operation, 'combine');
      const target = option.nextAction.targets.find((candidate) => candidate.kind === 'voxel');
      assert.ok(target, '补墙动作必须指向真实体素');
      const targetCell = cellId(target.position.x, target.position.y);
      assert.ok(neighbors4(center).includes(targetCell), '补墙目标必须是原住所的开放侧面');
      assert.notEqual(targetCell, initialWallCell, '补墙不得重复写入已有侧墙');
      assert.equal(target.position.z, site.z);
      assert.equal(voxelAt(state.world.grid, target.position.x, target.position.y, target.position.z), Material.Air);
      placementCells.push(targetCell);

      const fact = executePrimitiveAction(state, actor, option.nextAction, 13, actionOrder, {
        cause: 'intent',
        actionTick: actionOrder + 1,
      });
      actionOrder += 1;
      assert.equal(fact.status, 'completed', '真实建材放置必须由权威 executor 完成');
      assert.equal(fact.diff.outputMaterialId, Material.Stone);
      assert.deepEqual(fact.diff.position, target.position);
      recordProjectAction(state, project.id, fact);

      const shelter = shelterGeometryAt(state.world.grid, site);
      assert.ok(shelter);
      assert.equal(shelter.enclosedSides, expectedSides);
      reliefs.push(shelterHeatRelief(shelter));
      assert.deepEqual(actor.body, bodyBeforeConstruction, '项目和建造动作不得直接修改身体数值');
      assert.deepEqual(
        actor.conditions.find((condition) => condition.kind === 'heat'),
        heatBeforeConstruction,
        '项目只能改变结构，不能直接移除或改写 heat condition',
      );
      return { fact, shelter };
    }

    const afterFirstWall = executeNextPlacement(2);
    assert.equal(project.status, 'active', '围护从一面增至两面后项目仍不得提前完成');
    assert.equal(projectFunctionSatisfied(state, project), false);

    const afterSecondWall = executeNextPlacement(3);
    assert.notEqual(placementCells[0], placementCells[1], '两次放置必须填补不同的开放侧墙');
    assert.equal(project.status, 'completed', '第三面真实围护形成后项目才可完成');
    assert.equal(projectFunctionSatisfied(state, project), true);
    assert.ok(project.completionEventIds.includes(afterSecondWall.fact.id));
    assert.ok(afterFirstWall.shelter.weatherProtection > baselineShelter.weatherProtection);
    assert.ok(afterSecondWall.shelter.weatherProtection > afterFirstWall.shelter.weatherProtection);
    assert.ok(afterSecondWall.shelter.thermalInsulation > afterFirstWall.shelter.thermalInsulation);
    assert.ok(reliefs[0] < reliefs[1] && reliefs[1] < reliefs[2],
      `heat relief 必须随真实围护几何逐步增加：${JSON.stringify(reliefs)}`);
    assert.deepEqual(actor.body, bodyBeforeConstruction);
  }

  {
    const { state, actor, site, shelter } = createFixture(9502);
    const child = state.people[1];
    assert.ok(child, '子女来源测试需要第二名人物');
    resetPerson(child, site);
    child.bornAtMonth = state.clock.elapsedMonths - 5 * 12;
    child.geneticParents = [actor.id];
    actor.inventory.push(itemStack('test-child-adaptation-stone', Material.Stone, 2));
    const childHeatEventId = 'test-resolvable-child-heat-event';
    addHeatExposure(state, child, childHeatEventId, { stage: 3 });

    const childOptions = adaptationOptions(state, actor, [child]);
    assert.equal(childOptions.length, 1, '可见遗传未成年子女在住所内受热时应触发亲代适应项目');
    const proposal = childOptions[0].projectProposal;
    assert.ok(proposal?.shelterRequirement);
    assert.deepEqual({ cellId: proposal.site?.cellId, z: proposal.site?.z }, site);
    assert.deepEqual(proposal.beneficiaryIds, [child.id]);
    assert.equal(proposal.shelterRequirement.beneficiaryId, child.id);
    assert.equal(proposal.shelterRequirement.exposureKind, 'heat');
    assert.equal(proposal.shelterRequirement.baselineEnclosedSides, shelter.enclosedSides);
    assert.deepEqual(proposal.shelterRequirement.sourceEventIds, [childHeatEventId]);
    const resolvedChildEvent = worldEventById(state, childHeatEventId);
    assert.equal(resolvedChildEvent?.who, child.id);
    assert.equal(resolvedChildEvent?.diff.condition, 'heat');
  }

  {
    const { state, actor } = createFixture(9506);
    actor.inventory.push(itemStack('test-owned-loop-adaptation-stone', Material.Stone, 2));
    addHeatExposure(state, actor, 'test-owned-loop-heat-event', { stage: 3 });

    const evolved = createSimulation({ state }).step(1);
    const adaptations = evolved.projects.filter((project) => project.shelterRequirement);
    assert.equal(adaptations.length, 1,
      '后端无模型快速演化也必须让住所内受害者先形成适应项目，不能被“留在住所”控制流短路');
    assert.equal(adaptations[0].ownerId, actor.id);
    assert.equal(adaptations[0].shelterRequirement.beneficiaryId, actor.id);
    assert.ok(evolved.world.past.some((event) => event.kind === 'decision'
      && event.who === actor.id
      && event.atMonth === 13),
    '本地规则规划应留下真实决策事实');
  }

  {
    const { state, actor, center } = createFixture(9507);
    addHeatExposure(state, actor, 'test-logistics-heat-event', { stage: 3 });
    const dropCell = cellId(cellX(center) + 1, cellY(center) + 1);
    state.world.drops.push({
      id: 'test-adaptation-remote-stone', materialId: Material.Stone, quantity: 2,
      cellId: dropCell, z: actor.position.z, createdAtMonth: 12,
      sourceEventIds: ['test-adaptation-remote-stone-source'],
    });

    const evolved = createSimulation({ state }).step(1);
    const adaptation = evolved.projects.find((project) => project.shelterRequirement);
    assert.ok(adaptation, '住所适应应能从可见地面材料建立持久物流');
    assert.equal(adaptation.status, 'completed',
      '已有适应项目取材时，泛化的回住所/静止反射不得把真实物流永久短路');
    const projectEvents = evolved.world.past.filter((event) => event.kind === 'action'
      && adaptation.actionEventIds.includes(event.id));
    assert.ok(projectEvents.some((event) => event.action.kind === 'move'), '适应项目必须真实往返取材');
    assert.ok(projectEvents.some((event) => event.action.kind === 'transfer'), '适应项目必须真实取得材料');
    assert.equal(projectEvents.filter((event) => event.action.kind === 'act'
      && event.action.operation === 'combine' && event.status === 'completed').length, 2,
    '远处取得的两个材料必须分别形成两次权威围护放置');
  }

  {
    const { state, actor, site } = createFixture(9508);
    actor.inventory.push(itemStack('test-invalidated-adaptation-stone', Material.Stone, 2));
    addHeatExposure(state, actor, 'test-invalidated-geometry-heat-event', { stage: 3 });
    const proposalOption = adaptationOptions(state, actor)[0];
    assert.ok(proposalOption?.projectProposal?.shelterRequirement);
    const project = ensureProject(state, proposalOption.projectProposal);

    // Simulate another construction changing the occupied voxel before this
    // project recompiles. The original shelter can no longer be resolved.
    setVoxel(state.world.grid, cellX(site.cellId), cellY(site.cellId), site.z, Material.Stone);
    assert.equal(shelterGeometryAt(state.world.grid, site), null);
    assert.equal(
      optionsFor(state, actor).some((option) => option.projectId === project.id),
      false,
      '原址住所几何失效后，适应项目不得退化成普通蓝图并在旧墙上叠放上层体素',
    );
  }

  {
    const { state, actor, center, site, initialWallCell } = createFixture(9509);
    actor.inventory.push(itemStack('test-preserve-entrance-stone', Material.Stone, 2));
    addHeatExposure(state, actor, 'test-preserve-entrance-heat-event', { stage: 3 });
    const proposalOption = adaptationOptions(state, actor)[0];
    assert.ok(proposalOption?.projectProposal?.shelterRequirement);
    const project = ensureProject(state, proposalOption.projectProposal);

    const formerlyOpen = neighbors4(center).filter((cell) => cell !== initialWallCell);
    for (const blockedCell of formerlyOpen.slice(0, 2)) {
      setVoxel(state.world.grid, cellX(blockedCell), cellY(blockedCell), site.z - 1, Material.Water);
    }
    const oneEntranceShelter = shelterGeometryAt(state.world.grid, site);
    assert.ok(oneEntranceShelter);
    assert.equal(oneEntranceShelter.openSides, 1, '定向地形应只剩一个身体可通过的入口');
    assert.equal(
      optionsFor(state, actor).some((option) => option.projectId === project.id),
      false,
      '适应项目不得把唯一可通行入口封死；没有安全侧墙位置时应等待新方案',
    );
    const entranceCell = formerlyOpen[2];
    assert.equal(voxelAt(state.world.grid, cellX(entranceCell), cellY(entranceCell), site.z), Material.Air);
  }

  {
    const { state, actor } = createFixture(9503);
    actor.inventory.push(itemStack('test-no-exposure-stone', Material.Stone, 2));
    assert.equal(adaptationOptions(state, actor).length, 0,
      '没有 cold/heat 暴露时不得仅凭已有住所派生适应项目');
  }

  {
    const { state, actor } = createFixture(9504);
    actor.inventory.push(itemStack('test-unsourced-exposure-stone', Material.Stone, 2));
    addHeatExposure(state, actor, 'unused-heat-event', { source: false });
    assert.equal(adaptationOptions(state, actor).length, 0,
      'heat condition 没有来源事件时不得派生适应项目');
  }

  {
    const { state, actor, site } = createFixture(9505);
    const unrelatedMinor = state.people[1];
    assert.ok(unrelatedMinor, '非遗传他人测试需要第二名人物');
    resetPerson(unrelatedMinor, site);
    unrelatedMinor.bornAtMonth = state.clock.elapsedMonths - 5 * 12;
    unrelatedMinor.geneticParents = [];
    actor.inventory.push(itemStack('test-unrelated-minor-stone', Material.Stone, 2));
    const unrelatedHeatEventId = 'test-unrelated-minor-heat-event';
    addHeatExposure(state, unrelatedMinor, unrelatedHeatEventId);

    assert.equal(adaptationOptions(state, actor, [unrelatedMinor]).length, 0,
      '即使可见、未成年且来源完整，非遗传他人的暴露也不得触发该人物的适应项目');
  }

  {
    const { state, actor, center, site } = createFixture(9510);
    maximizeShelter(state, center, site);
    makeFailedShelterEmergency(state, actor);
    const positionBefore = structuredClone(actor.position);
    const hydrationBefore = actor.body.hydration;
    const reflex = chooseFailedShelterHibernationReflex(state, actor);
    assert.deepEqual(reflex, {
      kind: 'act', operation: 'dehydrate', targets: [{ kind: 'person', personId: actor.id }],
      hibernationEvidenceEventIds: ['test-maxed-shelter-heat-event'],
    }, '三面住所内有同址来源的二级暴露时应只编译本人脱水动作');
    const fact = executePrimitiveAction(state, actor, reflex, 13, 0, {
      cause: 'survival-reflex', actionTick: 1,
    });
    assert.equal(fact.status, 'completed');
    assert.equal(fact.action.kind, 'act');
    assert.equal(fact.action.operation, 'dehydrate');
    assert.equal(fact.diff.dehydratedPersonId, actor.id);
    assert.deepEqual(fact.diff.hibernationEvidenceEventIds, ['test-maxed-shelter-heat-event']);
    assert.deepEqual(actor.position, positionBefore, '窄反射不得通过移动逃离失效住所');
    assert.equal(actor.body.hydration, hydrationBefore - 8, '脱水仍须经过 executor 扣减真实水分');
    const hibernation = actor.conditions.find((condition) => condition.kind === 'dehydrated-hibernation');
    assert.ok(hibernation);
    assert.ok(hibernation.sourceEventIds.includes('test-maxed-shelter-heat-event'));
    assert.ok(hibernation.sourceEventIds.includes(fact.id), '休眠 condition 必须同时连接暴露事实和动作事实');
  }

  {
    const { state, actor, center, site } = createFixture(9511);
    maximizeShelter(state, center, site);
    makeFailedShelterEmergency(state, actor);
    actor.inventory.push(itemStack('test-pre-hibernation-food', Material.Food, 1));
    actor.body.nutrition = 50;
    const preparation = chooseSurvivalReflex(state, actor);
    assert.equal(preparation?.kind, 'act');
    assert.equal(preparation?.operation, 'ingest', '住所内有随身食物时应先原地进食再休眠');
    actor.body.nutrition = 70;
    const preparedReflex = chooseSurvivalReflex(state, actor);
    assert.equal(preparedReflex?.kind, 'act');
    assert.equal(preparedReflex?.operation, 'dehydrate');
  }

  for (const [label, mutate] of [
    ['只有两面墙', (state, actor, center, site) => {
      setVoxel(state.world.grid, cellX(neighbors4(center)[2]), cellY(neighbors4(center)[2]), site.z, Material.Air);
    }],
    ['一级暴露', (_state, actor) => { actor.conditions.find((condition) => condition.kind === 'heat').stage = 1; }],
    ['无来源暴露', (_state, actor) => { actor.conditions.find((condition) => condition.kind === 'heat').sourceEventIds = []; }],
    ['来源地点不符', (state) => { state.world.past[0].cellId += 1; }],
    ['恒纪元', (state) => { state.civilization.epoch = 'stable'; state.civilization.externalClimate.epoch = 'stable'; }],
    ['气候强度不足', (state) => { state.civilization.climate.severity = 3; state.civilization.externalClimate.severity = 3; }],
    ['身体储备不足', (_state, actor) => { actor.body.health = 44; }],
    ['妊娠禁忌', (_state, actor) => { actor.conditions.push({ id: 'test-pregnancy', kind: 'pregnancy', stage: 1, sinceMonth: 12, sourceEventIds: [] }); }],
    ['重病禁忌', (_state, actor) => { actor.conditions.push({ id: 'test-illness', kind: 'illness', stage: 2, sinceMonth: 12, sourceEventIds: [] }); }],
    ['完全依赖年龄', (state, actor) => { actor.bornAtMonth = state.clock.elapsedMonths - 6; }],
  ]) {
    const { state, actor, center, site } = createFixture(9600 + label.length);
    maximizeShelter(state, center, site);
    makeFailedShelterEmergency(state, actor);
    mutate(state, actor, center, site);
    assert.equal(chooseFailedShelterHibernationReflex(state, actor), null, `${label}不得触发失效住所脱水反射`);
  }

  {
    const { state, actor, center, site } = createFixture(9512);
    maximizeShelter(state, center, site);
    makeFailedShelterEmergency(state, actor);
    const healthBefore = actor.body.health;
    const evolved = createSimulation({ state }).step(1);
    const sleeper = evolved.people.find((person) => person.id === actor.id);
    assert.ok(sleeper?.conditions.some((condition) => condition.kind === 'dehydrated-hibernation'));
    assert.equal(evolved.clock.elapsedMonths, 13);
    assert.equal(evolved.civilization.status, 'running', `窄反射后仍有休眠活人时文明必须继续：${JSON.stringify(evolved.civilization.outcome)}`);
    assert.ok(sleeper.body.health < healthBefore, '进入休眠的同月仍须结算真实低代谢健康成本');
    assert.ok(evolved.world.past.some((event) => event.kind === 'action'
      && event.who === actor.id
      && event.action.kind === 'act'
      && event.action.operation === 'dehydrate'
      && event.cause === 'survival-reflex'
      && event.diff.hibernationEvidenceEventIds?.includes('test-maxed-shelter-heat-event')),
    '后端月循环必须留下有暴露来源的窄反射动作事实');

    delete evolved.civilization.externalClimate;
    evolved.civilization.era.endsAtMonth = evolved.clock.elapsedMonths;
    let recovered = createSimulation({ state: evolved }).step(1);
    if (recovered.people.find((person) => person.id === actor.id)?.conditions.some((condition) => condition.kind === 'dehydrated-hibernation')) {
      recovered = createSimulation({ state: recovered }).step(1);
    }
    const awake = recovered.people.find((person) => person.id === actor.id);
    assert.ok(awake && !awake.conditions.some((condition) => condition.kind === 'dehydrated-hibernation'),
      '下一恒纪元应沿 v23 的既有环境恢复链苏醒');
    assert.ok(recovered.world.past.some((event) => event.kind === 'environment'
      && event.who === actor.id
      && event.diff.condition === 'dehydrated-hibernation'
      && event.diff.exited === true));
  }

  process.stdout.write('causal shelter adaptation tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
