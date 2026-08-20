import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-durable-record-publication-'));
const bundlePath = path.join(temporaryDirectory, 'durable-record-publication.mjs');

try {
  const entry = `
    export { createInitialState, executeActiveIntent } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export { buildDecisionContext } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/action-options.ts'))};
    export {
      buildProjectOptions,
      ensureProject,
      projectFunctionSatisfied,
      recordProjectAction,
      recompileProjectNextAction,
      synchronizeProject,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { cellId, cellX, cellY, cellsInRadius, setVoxel } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=durable-record-publication-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    buildDecisionContext,
    buildProjectOptions,
    cellId,
    cellX,
    cellY,
    cellsInRadius,
    createInitialState,
    ensureProject,
    executeActiveIntent,
    executePrimitiveAction,
    instantiateProject,
    projectFunctionSatisfied,
    recordProjectAction,
    recompileProjectNextAction,
    setVoxel,
    synchronizeProject,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const knowledgeId = 'technique:test:durable-publication';

  function createFixture(seed, { siteAtOwner = false } = {}) {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 5;
    state.world.past = [];
    state.world.drops = [];
    state.records = [];
    state.projects = [];
    state.intents = [];
    state.containers = [];
    const actor = state.people[0];
    assert.ok(actor, '记录发布夹具需要一名人物');
    state.people = [actor];
    actor.bornAtMonth = -24 * 12;
    const center = cellId(42, 26);
    for (const localCell of cellsInRadius(center, 8)) {
      for (let z = 0; z < state.world.grid.levels; z += 1) {
        setVoxel(state.world.grid, cellX(localCell), cellY(localCell), z, z === 0 ? Material.PackedSoil : Material.Air);
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
    actor.body = { health: 100, hydration: 100, nutrition: 100 };
    actor.conditions = [];
    actor.inventory = [{
      id: `blank-tablet-${seed}`,
      materialId: Material.WoodTablet,
      quantity: 1,
      sourceEventIds: [`tablet-source-${seed}`],
    }];
    actor.knowledge = [{
      id: knowledgeId,
      kind: 'technique',
      summary: '测试用耐久知识',
      confidence: 90,
      learnedAtMonth: 1,
      sourceEventIds: [`knowledge-source-a-${seed}`, `knowledge-source-b-${seed}`],
    }];
    actor.knownPlaces = [];
    actor.memories = [];
    delete actor.activeIntentId;
    const siteCellId = siteAtOwner ? center : cellId(cellX(center) + 1, cellY(center));
    const project = instantiateProject({
      id: `durable-record-${seed}`,
      kind: 'inquiry',
      need: 'knowledge-preservation',
      desiredFunction: 'durable-record',
      summary: '把知识公开留在固定地点',
      ownerId: actor.id,
      beneficiaryIds: [actor.id],
      triggerFactIds: [`continuity-pressure-${seed}`],
      pressure: 80,
      createdAtMonth: 1,
      reviewAtMonth: 120,
      site: { cellId: siteCellId, z: 1 },
      targetKnowledgeId: knowledgeId,
    });
    state.projects = [project];
    return { state, actor, project, center, siteCellId };
  }

  function writeProjectRecord(fixture, orderInMonth = 0) {
    const action = recompileProjectNextAction(fixture.state, fixture.actor, fixture.project.id);
    assert.equal(action?.kind, 'communicate', `项目第一步必须是写入：${JSON.stringify(action)}`);
    const fact = executePrimitiveAction(
      fixture.state,
      fixture.actor,
      action,
      6,
      orderInMonth,
      { intentId: `intent-${fixture.project.id}`, cause: 'intent', actionTick: 1 },
    );
    assert.equal(fact.status, 'completed', fact.result);
    recordProjectAction(fixture.state, fixture.project.id, fact);
    fixture.state.world.past.push(fact);
    const recordPayloadId = fact.diff.recordPayloadId;
    const carrierStackId = fact.diff.carrierStackId;
    assert.equal(typeof recordPayloadId, 'string');
    assert.equal(typeof carrierStackId, 'string');
    return { fact, recordPayloadId, carrierStackId };
  }

  function exactPlacementAction(fixture, written) {
    return {
      kind: 'transfer',
      materialId: Material.WoodTablet,
      quantity: 1,
      from: { kind: 'person', personId: fixture.actor.id },
      to: { kind: 'ground', cellId: fixture.actor.position.cellId, z: fixture.actor.position.z },
      stackId: written.carrierStackId,
    };
  }

  function installStaleSearchEpisode(fixture) {
    const targetCellId = cellId(cellX(fixture.center) + 6, cellY(fixture.center));
    const episode = {
      id: `stale-record-carrier-search-${fixture.project.id}`,
      kind: 'search',
      actorId: fixture.actor.id,
      materialIds: [Material.Fiber],
      target: { cellId: targetCellId, z: 1 },
      sourceRef: { kind: 'project-requirement', projectId: fixture.project.id },
      sourceEventIds: [`stale-logistics-source-${fixture.project.id}`],
      createdAt: 4,
      status: 'active',
      actionEventIds: [],
      actionBudget: 12,
    };
    fixture.project.logisticsEpisodes.push(episode);
    fixture.project.activeLogisticsEpisodeId = episode.id;
    return episode;
  }

  function addStack(fixture, id, materialId, quantity = 1) {
    const stack = { id, materialId, quantity, sourceEventIds: [`source-${id}`] };
    fixture.actor.inventory.push(stack);
    return stack;
  }

  function addWorkshopProject(fixture, suffix, { knownRecipe = false, hypothesis = false } = {}) {
    const project = instantiateProject({
      id: `workshop-${suffix}`,
      kind: 'production',
      need: 'production-efficiency',
      desiredFunction: 'workshop-production',
      summary: '建立不会抹除公共记录的工坊',
      ownerId: fixture.actor.id,
      beneficiaryIds: [fixture.actor.id],
      triggerFactIds: [`workshop-pressure-${suffix}`],
      pressure: 80,
      createdAtMonth: 2,
      reviewAtMonth: 120,
    });
    if (knownRecipe) fixture.actor.knowledge.push({
      id: `technique:combine-inventory:${Material.Plank}x1+${Material.WoodTablet}x1:${Material.Workshop}`,
      kind: 'technique',
      summary: '木板与空白木牍可以组装为工具棚',
      confidence: 90,
      learnedAtMonth: 2,
      sourceEventIds: [`known-workshop-${suffix}`],
    });
    if (hypothesis) {
      const plank = fixture.actor.inventory.find((stack) => stack.materialId === Material.Plank);
      const tablet = fixture.actor.inventory.find((stack) => stack.materialId === Material.WoodTablet);
      assert.ok(plank && tablet);
      const key = `${Material.Plank}+${Material.WoodTablet}`;
      project.hypothesisCampaign = {
        version: 'project-hypothesis-campaign-v2',
        id: `project-hypothesis:${project.id}:${fixture.actor.id}`,
        projectId: project.id,
        actorId: fixture.actor.id,
        openedAt: 6,
        budget: 8,
        noResponseBudget: 4,
        responseBudget: 3,
        observedMaterialIds: [Material.Plank, Material.WoodTablet],
        sourceFactIds: [...plank.sourceEventIds, ...tablet.sourceEventIds],
        sourceKeys: [`inventory:${fixture.actor.id}:${plank.id}`, `inventory:${fixture.actor.id}:${tablet.id}`],
        candidates: [{
          key,
          operation: 'combine-inventory',
          questionKind: 'connect-manipulator-shapes',
          materialIds: [Material.Plank, Material.WoodTablet],
          roleScore: 1,
          observableScore: 1,
          seededRank: 999,
          roleReasonKeys: ['test-natural-19-27'],
          reasonKeys: ['test-natural-19-27'],
          sourceFactIds: [...plank.sourceEventIds, ...tablet.sourceEventIds],
          sourceKeys: [`inventory:${fixture.actor.id}:${plank.id}`, `inventory:${fixture.actor.id}:${tablet.id}`],
        }],
        attempts: [],
        status: 'active',
        activeCandidateKey: key,
      };
    }
    fixture.state.projects.push(project);
    return project;
  }

  function consumptiveInventoryTargetIds(option) {
    const action = option.nextAction;
    if (action.kind !== 'act' || !['combine', 'exert', 'expose'].includes(action.operation)) return [];
    return action.targets.flatMap((target) => target.kind === 'inventory-stack' ? [target.stackId] : []);
  }

  function assertRecordExcludedFromOrdinaryCandidates(context, carrierStackId) {
    assert.equal(context.options.some((option) => consumptiveInventoryTargetIds(option).includes(carrierStackId)), false,
      '通用决策候选不得生成消耗 written carrier 的普通 combine/exert/expose');
    assert.ok(context.followUpOptions.length > 0, 'grounded conversation follow-up 候选池必须非空才能验证过滤');
    assert.equal(context.followUpOptions.some((option) => consumptiveInventoryTargetIds(option).includes(carrierStackId)), false,
      'grounded conversation follow-up 候选池不得含消耗 written carrier 的动作');
  }

  {
    const { state, actor, center } = createFixture(9701, { siteAtOwner: true });
    state.clock.elapsedMonths = 720;
    actor.bornAtMonth = 0;
    state.projects = [];
    const visibleCells = cellsInRadius(center, 8);
    const proposal = buildProjectOptions(state, actor, visibleCells, [], [])
      .find((option) => option.projectProposal?.desiredFunction === 'durable-record')?.projectProposal;
    assert.ok(proposal, '成熟知识与连续性压力必须能形成耐久记录项目');
    assert.deepEqual(proposal.site, { cellId: actor.position.cellId, z: actor.position.z },
      '耐久记录 proposal 必须在形成时固定 owner 所在发布地点');
  }

  {
    const fixture = createFixture(9702);
    const first = recompileProjectNextAction(fixture.state, fixture.actor, fixture.project.id);
    assert.equal(first?.kind, 'communicate');
    const intent = {
      id: 'intent-current-month-record-publication',
      ownerId: fixture.actor.id,
      summary: fixture.project.summary,
      domain: 'strategic',
      goal: { kind: 'project-completed', projectId: fixture.project.id },
      nextAction: first,
      status: 'active',
      createdAtMonth: 6,
      lastProgressAtMonth: 6,
      progress: 0,
      sourceDecisionEventId: 'decision:test-record-publication',
      projectId: fixture.project.id,
      sourceFactIds: [...fixture.project.triggerFactIds],
      actionEventIds: [],
      replanCount: 0,
    };
    fixture.state.intents = [intent];
    fixture.actor.activeIntentId = intent.id;
    const events = [];

    const writeFact = executeActiveIntent(fixture.state, fixture.actor, 6, events.length, 1, events);
    assert.equal(writeFact?.action.kind, 'communicate');
    assert.equal(fixture.project.status, 'active', '写入只形成私人载体，不得立即完成项目');
    assert.equal(fixture.state.world.past.length, 0, '专项链应只依赖本月 earlier events，不偷提交历史');
    events.push(writeFact);
    const staleEpisode = installStaleSearchEpisode(fixture);

    const moveFact = executeActiveIntent(fixture.state, fixture.actor, 6, events.length, 2, events);
    assert.equal(moveFact?.action.kind, 'move', '下一 planning tick 必须看见本月写入并前往固定 site');
    assert.equal(moveFact?.action.kind === 'move' ? moveFact.action.toCellId : -1, fixture.siteCellId,
      '已有合格 written carrier 时只能回固定发布地点，不能恢复旧搜索目标');
    assert.notEqual(moveFact?.action.kind === 'move' ? moveFact.action.toCellId : -1, staleEpisode.target.cellId);
    assert.equal(moveFact?.status, 'completed');
    events.push(moveFact);

    const placementFact = executeActiveIntent(fixture.state, fixture.actor, 6, events.length, 3, events);
    assert.equal(placementFact?.action.kind, 'transfer', '到达固定 site 后必须执行 owner self→ground 投放');
    assert.equal(placementFact?.action.kind === 'transfer' ? placementFact.action.to.kind : '', 'ground');
    assert.equal(placementFact?.status, 'completed');
    assert.equal(fixture.project.status, 'active', '投放事实尚未进入 earlier events 前不得抢先完成');
    events.push(placementFact);

    const afterPublication = executeActiveIntent(fixture.state, fixture.actor, 6, events.length, 4, events);
    assert.equal(afterPublication, null, '下一 planning tick 应由 earlier events 完成项目而非再造动作');
    assert.equal(fixture.project.status, 'completed');
    assert.deepEqual(fixture.project.completionEventIds, [writeFact.id, placementFact.id],
      '项目完成证据只能是项目绑定写入与固定地点投放');
    assert.equal(intent.status, 'completed');
    assert.equal(staleEpisode.status, 'fulfilled', '公开投放完成项目时，旧物流应沿既有生命周期一并关闭');
    assert.equal(staleEpisode.endingReason, 'project-completed');
    assert.equal(fixture.project.activeLogisticsEpisodeId, undefined);
    assert.deepEqual(events.filter((event) => event.action.kind === 'move').map((event) => event.action.toCellId),
      [fixture.siteCellId], '写入后只允许一次返回发布地点的必要移动，不得再离场追逐旧物流');

    fixture.state.world.past.push(...events);
    assert.equal(projectFunctionSatisfied(fixture.state, fixture.project), true);
    const drop = fixture.state.world.drops.find((candidate) => candidate.recordPayloadId === writeFact.diff.recordPayloadId);
    assert.ok(drop && drop.cellId === fixture.siteCellId && drop.z === 1 && drop.quantity === 1);
    assert.ok(drop.sourceEventIds.includes(writeFact.id) && drop.sourceEventIds.includes(placementFact.id),
      '公开载体必须保留写入与投放的物理来源链');
    assert.ok(drop.sourceLineageKeys?.includes(`inventory:${fixture.actor.id}:${writeFact.diff.carrierStackId}`));
  }

  {
    const fixture = createFixture(9703, { siteAtOwner: true });
    writeProjectRecord(fixture);
    assert.equal(projectFunctionSatisfied(fixture.state, fixture.project), false,
      '记录仍在 owner 私人背包时不得完成');
  }

  {
    const fixture = createFixture(9704, { siteAtOwner: true });
    const written = writeProjectRecord(fixture);
    const carrier = fixture.actor.inventory.find((stack) => stack.id === written.carrierStackId);
    fixture.actor.inventory = [];
    fixture.state.containers = [{
      id: 'container:test-private-record',
      position: { x: cellX(fixture.center), y: cellY(fixture.center), z: 1 },
      inventory: [carrier],
      createdAtMonth: 6,
      sourceEventIds: ['container:test-private-record'],
    }];
    assert.equal(projectFunctionSatisfied(fixture.state, fixture.project), false,
      '容器持有不是本版定义的公共发布，不得完成');
  }

  {
    const fixture = createFixture(9705);
    const written = writeProjectRecord(fixture);
    const wrongSitePlacement = executePrimitiveAction(
      fixture.state,
      fixture.actor,
      exactPlacementAction(fixture, written),
      6,
      1,
      { intentId: `intent-${fixture.project.id}`, cause: 'intent', actionTick: 2 },
    );
    assert.equal(wrongSitePlacement.status, 'completed');
    recordProjectAction(fixture.state, fixture.project.id, wrongSitePlacement);
    fixture.state.world.past.push(wrongSitePlacement);
    assert.notEqual(fixture.actor.position.cellId, fixture.siteCellId);
    assert.equal(projectFunctionSatisfied(fixture.state, fixture.project), false,
      '项目归因的投放若不在固定 site 也不得完成');
  }

  {
    const fixture = createFixture(9706, { siteAtOwner: true });
    const written = writeProjectRecord(fixture);
    const carrier = fixture.actor.inventory.find((stack) => stack.id === written.carrierStackId);
    fixture.actor.inventory = [];
    fixture.actor.diedAtMonth = 6;
    fixture.actor.body.health = 0;
    fixture.state.world.drops.push({
      id: 'death-drop-record',
      materialId: Material.WoodTablet,
      cellId: fixture.project.site.cellId,
      z: fixture.project.site.z,
      quantity: 1,
      createdAtMonth: 6,
      sourceEventIds: [...carrier.sourceEventIds],
      sourceLineageKeys: [`inventory:${fixture.actor.id}:${carrier.id}`],
      recordPayloadId: written.recordPayloadId,
    });
    assert.equal(projectFunctionSatisfied(fixture.state, fixture.project), false,
      '死亡遗落没有 owner 项目投放事实，不得冒充公开发布');
  }

  {
    const fixture = createFixture(9707, { siteAtOwner: true });
    const written = writeProjectRecord(fixture);
    const placementFact = executePrimitiveAction(
      fixture.state,
      fixture.actor,
      exactPlacementAction(fixture, written),
      6,
      1,
      { intentId: `intent-${fixture.project.id}`, cause: 'intent', actionTick: 2 },
    );
    assert.equal(placementFact.status, 'completed');
    recordProjectAction(fixture.state, fixture.project.id, placementFact);
    fixture.state.world.past.push(placementFact);
    const drop = fixture.state.world.drops.find((candidate) => candidate.recordPayloadId === written.recordPayloadId);
    drop.sourceEventIds = drop.sourceEventIds.filter((eventId) => eventId !== placementFact.id);
    assert.equal(projectFunctionSatisfied(fixture.state, fixture.project), false,
      '当前 drop 缺少 exact placement 来源时不得仅凭位置和 payload 完成');
  }

  {
    const fixture = createFixture(9708, { siteAtOwner: true });
    const written = writeProjectRecord(fixture);
    const placementFact = executePrimitiveAction(
      fixture.state,
      fixture.actor,
      exactPlacementAction(fixture, written),
      6,
      1,
      { intentId: 'unbound-placement-intent', cause: 'intent', actionTick: 2 },
    );
    assert.equal(placementFact.status, 'completed');
    fixture.state.world.past.push(placementFact);
    assert.equal(projectFunctionSatisfied(fixture.state, fixture.project), false,
      '未进入同一项目 action history 的投放不得完成项目');
  }

  {
    const fixture = createFixture(9709);
    const originalQuantity = fixture.actor.inventory[0].quantity;
    const remote = executePrimitiveAction(fixture.state, fixture.actor, {
      kind: 'transfer',
      materialId: Material.WoodTablet,
      quantity: 1,
      from: { kind: 'person', personId: fixture.actor.id },
      to: { kind: 'ground', cellId: fixture.siteCellId, z: 1 },
      stackId: fixture.actor.inventory[0].id,
    }, 6, 0, { cause: 'intent', actionTick: 1 });
    assert.equal(remote.status, 'blocked', '远程 to-ground 必须在扣物前阻止');
    assert.equal(fixture.actor.inventory[0].quantity, originalQuantity, '阻止远程投放后物质必须守恒');
    assert.equal(fixture.state.world.drops.length, 0);
  }

  {
    const fixture = createFixture(9710, { siteAtOwner: true });
    const first = fixture.project;
    const second = ensureProject(fixture.state, {
      id: 'durable-record-second-target',
      kind: 'inquiry',
      need: 'knowledge-preservation',
      desiredFunction: 'durable-record',
      summary: '保存另一项知识',
      ownerId: fixture.actor.id,
      beneficiaryIds: [fixture.actor.id],
      triggerFactIds: ['continuity-pressure-second'],
      pressure: 80,
      createdAtMonth: 6,
      reviewAtMonth: 120,
      site: { cellId: cellId(cellX(fixture.center) + 1, cellY(fixture.center)), z: 1 },
      targetKnowledgeId: 'technique:test:another-target',
    }, {
      person: fixture.actor,
      visibleCells: cellsInRadius(fixture.center, 8),
      atMonth: 6,
    });
    assert.notEqual(second.id, first.id,
      '不同 durable target/site 不能因为旧 site 可见或 beneficiary 相同而被误合并');
    assert.equal(fixture.state.projects.length, 2);
  }

  {
    const fixture = createFixture(9711, { siteAtOwner: true });
    delete fixture.project.site;
    assert.equal(recompileProjectNextAction(fixture.state, fixture.actor, fixture.project.id), null,
      'legacy active durable 无固定 site 时必须显式不可发布，不能漂移到 owner 当前坐标');
    assert.equal(projectFunctionSatisfied(fixture.state, fixture.project), false);
  }

  {
    const fixture = createFixture(9712, { siteAtOwner: true });
    const written = writeProjectRecord(fixture);
    const staleEpisode = installStaleSearchEpisode(fixture);
    const publication = recompileProjectNextAction(fixture.state, fixture.actor, fixture.project.id);
    assert.equal(publication?.kind, 'transfer', '已在固定 site 时，合格 written carrier 必须直接覆盖旧物流进行投放');
    assert.deepEqual(publication?.kind === 'transfer' ? publication.from : null,
      { kind: 'person', personId: fixture.actor.id });
    assert.deepEqual(publication?.kind === 'transfer' ? publication.to : null,
      { kind: 'ground', cellId: fixture.project.site.cellId, z: fixture.project.site.z });
    assert.equal(publication?.kind === 'transfer' ? publication.stackId : '', written.carrierStackId);
    const placementFact = executePrimitiveAction(
      fixture.state,
      fixture.actor,
      publication,
      6,
      1,
      { intentId: `intent-${fixture.project.id}`, cause: 'intent', actionTick: 2 },
    );
    assert.equal(placementFact.status, 'completed');
    recordProjectAction(fixture.state, fixture.project.id, placementFact);
    fixture.state.world.past.push(placementFact);
    synchronizeProject(fixture.state, fixture.project, 6);
    assert.equal(fixture.project.status, 'completed');
    assert.equal(staleEpisode.status, 'fulfilled');
    assert.equal(staleEpisode.endingReason, 'project-completed');
    assert.equal(fixture.state.world.past.some((event) => event.kind === 'action' && event.action.kind === 'move'), false,
      '人物已经在发布地点时不得产生任何离场 move');
  }

  {
    const fixture = createFixture(9713, { siteAtOwner: true });
    const staleEpisode = installStaleSearchEpisode(fixture);
    const originalStep = recompileProjectNextAction(fixture.state, fixture.actor, fixture.project.id);
    assert.equal(originalStep?.kind, 'move', '没有项目绑定 written carrier 时必须保留原物流优先级');
    assert.equal(originalStep?.kind === 'move' ? originalStep.toCellId : -1, staleEpisode.target.cellId);
    assert.equal(staleEpisode.status, 'active');
  }

  {
    const fixture = createFixture(9714, { siteAtOwner: true });
    const written = writeProjectRecord(fixture);
    const plank = addStack(fixture, 'direct-combine-plank', Material.Plank);
    const recordsBefore = structuredClone(fixture.state.records);
    const blocked = executePrimitiveAction(fixture.state, fixture.actor, {
      kind: 'act',
      operation: 'combine',
      targets: [
        { kind: 'inventory-stack', personId: fixture.actor.id, stackId: plank.id },
        { kind: 'inventory-stack', personId: fixture.actor.id, stackId: written.carrierStackId },
      ],
    }, 6, 1, { cause: 'intent', actionTick: 2 });
    assert.equal(blocked.status, 'blocked', '领域层必须拒绝把已写木牍当作普通 combine 输入');
    assert.match(blocked.result, /承载记录/);
    const carrier = fixture.actor.inventory.find((stack) => stack.id === written.carrierStackId);
    assert.equal(carrier?.quantity, 1);
    assert.equal(carrier?.recordPayloadId, written.recordPayloadId);
    assert.equal(plank.quantity, 1);
    assert.equal(fixture.actor.inventory.some((stack) => stack.materialId === Material.Workshop), false);
    assert.deepEqual(fixture.state.records, recordsBefore, 'blocked combine 不得改写或删除记录事实');

    const read = executePrimitiveAction(fixture.state, fixture.actor, {
      kind: 'attend',
      target: { kind: 'inventory-stack', personId: fixture.actor.id, stackId: written.carrierStackId },
    }, 6, 2, { cause: 'intent', actionTick: 3 });
    assert.equal(read.status, 'completed', '记录保护不得阻止合法阅读');
    assert.equal(read.diff.recordPayloadId, written.recordPayloadId);
  }

  {
    const fixture = createFixture(9715, { siteAtOwner: true });
    const written = writeProjectRecord(fixture);
    addStack(fixture, 'hypothesis-plank-protected-only', Material.Plank);
    const project = addWorkshopProject(fixture, 'hypothesis-protected-only', { hypothesis: true });
    const step = recompileProjectNextAction(fixture.state, fixture.actor, project.id);
    const selectedIds = step?.kind === 'act'
      ? step.targets.flatMap((target) => target.kind === 'inventory-stack' ? [target.stackId] : [])
      : [];
    assert.equal(selectedIds.includes(written.carrierStackId), false,
      '自然 19+27 hypothesis 不得选择唯一的已写木牍');
  }

  {
    const fixture = createFixture(9716, { siteAtOwner: true });
    const written = writeProjectRecord(fixture);
    const plank = addStack(fixture, 'hypothesis-plank-with-blank', Material.Plank);
    const blank = addStack(fixture, 'hypothesis-blank-tablet', Material.WoodTablet);
    const project = addWorkshopProject(fixture, 'hypothesis-with-blank', { hypothesis: true });
    const step = recompileProjectNextAction(fixture.state, fixture.actor, project.id);
    assert.equal(step?.kind, 'act');
    assert.equal(step?.kind === 'act' ? step.operation : '', 'combine');
    const selectedIds = step?.kind === 'act'
      ? step.targets.flatMap((target) => target.kind === 'inventory-stack' ? [target.stackId] : [])
      : [];
    assert.deepEqual(new Set(selectedIds), new Set([plank.id, blank.id]));
    assert.equal(selectedIds.includes(written.carrierStackId), false);
    const fact = executePrimitiveAction(fixture.state, fixture.actor, step, 6, 1, { cause: 'intent', actionTick: 2 });
    assert.equal(fact.status, 'completed');
    assert.equal(fixture.actor.inventory.some((stack) => stack.id === blank.id), false,
      '正常加工只能消耗同材质空白木牍');
    assert.equal(fixture.actor.inventory.find((stack) => stack.id === written.carrierStackId)?.recordPayloadId,
      written.recordPayloadId);
  }

  {
    const protectedOnly = createFixture(9717, { siteAtOwner: true });
    const written = writeProjectRecord(protectedOnly);
    addStack(protectedOnly, 'known-plank-protected-only', Material.Plank);
    const project = addWorkshopProject(protectedOnly, 'known-protected-only', { knownRecipe: true });
    const withoutBlank = recompileProjectNextAction(protectedOnly.state, protectedOnly.actor, project.id);
    const protectedSelections = withoutBlank?.kind === 'act'
      ? withoutBlank.targets.flatMap((target) => target.kind === 'inventory-stack' ? [target.stackId] : [])
      : [];
    assert.equal(protectedSelections.includes(written.carrierStackId), false,
      '已知 inventory recipe 也不得选择记录载体');

    const withBlank = createFixture(9718, { siteAtOwner: true });
    const secondWritten = writeProjectRecord(withBlank);
    const plank = addStack(withBlank, 'known-plank-with-blank', Material.Plank);
    const blank = addStack(withBlank, 'known-blank-tablet', Material.WoodTablet);
    const readyProject = addWorkshopProject(withBlank, 'known-with-blank', { knownRecipe: true });
    const knownStep = recompileProjectNextAction(withBlank.state, withBlank.actor, readyProject.id);
    assert.equal(knownStep?.kind, 'act');
    const selectedIds = knownStep?.kind === 'act'
      ? knownStep.targets.flatMap((target) => target.kind === 'inventory-stack' ? [target.stackId] : [])
      : [];
    assert.deepEqual(new Set(selectedIds), new Set([plank.id, blank.id]));
    assert.equal(selectedIds.includes(secondWritten.carrierStackId), false);
  }

  {
    const fixture = createFixture(9719, { siteAtOwner: true });
    const written = writeProjectRecord(fixture);
    const carrier = fixture.actor.inventory.find((stack) => stack.id === written.carrierStackId);
    const tool = addStack(fixture, 'record-guard-stone-tool', Material.StoneTool);
    carrier.materialId = Material.Fiber;
    const target = { x: cellX(fixture.center) + 1, y: cellY(fixture.center), z: 2 };
    const recordsBefore = structuredClone(fixture.state.records);
    const blocked = executePrimitiveAction(fixture.state, fixture.actor, {
      kind: 'act', operation: 'exert', toolStackId: tool.id,
      targets: [
        { kind: 'inventory-stack', personId: fixture.actor.id, stackId: carrier.id },
        { kind: 'voxel', position: target },
      ],
    }, 6, 1, { cause: 'intent', actionTick: 2 });
    assert.equal(blocked.status, 'blocked', 'exert 也必须保护被消费的记录载体');
    assert.match(blocked.result, /承载记录/);
    assert.equal(carrier.quantity, 1);
    assert.equal(carrier.recordPayloadId, written.recordPayloadId);
    assert.deepEqual(fixture.state.records, recordsBefore);
  }

  {
    const fixture = createFixture(9720, { siteAtOwner: true });
    const written = writeProjectRecord(fixture);
    const carrier = fixture.actor.inventory.find((stack) => stack.id === written.carrierStackId);
    carrier.materialId = Material.Wood;
    const target = { x: cellX(fixture.center) + 1, y: cellY(fixture.center), z: 1 };
    setVoxel(fixture.state.world.grid, target.x, target.y, target.z, Material.Fire);
    const recordsBefore = structuredClone(fixture.state.records);
    const blocked = executePrimitiveAction(fixture.state, fixture.actor, {
      kind: 'act', operation: 'expose',
      targets: [
        { kind: 'inventory-stack', personId: fixture.actor.id, stackId: carrier.id },
        { kind: 'voxel', position: target },
      ],
    }, 6, 1, { cause: 'intent', actionTick: 2 });
    assert.equal(blocked.status, 'blocked', 'expose 也必须保护被消费的记录载体');
    assert.match(blocked.result, /承载记录/);
    assert.equal(carrier.quantity, 1);
    assert.equal(carrier.recordPayloadId, written.recordPayloadId);
    assert.deepEqual(fixture.state.records, recordsBefore);
  }

  {
    const fixture = createFixture(9721, { siteAtOwner: true });
    const written = writeProjectRecord(fixture);
    addStack(fixture, 'ordinary-filter-wood', Material.Wood);
    addStack(fixture, 'ordinary-filter-iron-ore', Material.IronOre);
    const fireCell = cellId(cellX(fixture.center) + 1, cellY(fixture.center));
    setVoxel(fixture.state.world.grid, cellX(fireCell), cellY(fireCell), 1, Material.Fire);
    fixture.actor.knowledge.push({
      id: `technique:expose:${Material.WoodTablet}:${Material.Fire}:${Material.Charcoal}`,
      kind: 'technique',
      summary: '重复测试记录木牍暴露于火焰',
      confidence: 90,
      learnedAtMonth: 2,
      sourceEventIds: ['known-record-exposure'],
    });
    const context = buildDecisionContext(fixture.state, fixture.actor, 6);
    assertRecordExcludedFromOrdinaryCandidates(context, written.carrierStackId);
    assert.equal(context.options.some((option) => option.id.startsWith('try-inventory-combine:')
      && option.id.includes(written.carrierStackId)), false,
      'try-inventory-combine 不得把 written carrier 编入候选');
    assert.equal(context.options.some((option) => option.id.startsWith('repeat-expose:')
      && option.id.includes(written.carrierStackId)), false,
      'repeat-expose 不得把 written carrier 编入候选');
  }

  {
    const fixture = createFixture(9722, { siteAtOwner: true });
    const written = writeProjectRecord(fixture);
    const tool = addStack(fixture, 'ordinary-filter-stone-tool', Material.StoneTool);
    fixture.actor.knowledge.push({
      id: `technique:exert:${tool.materialId}:${Material.WoodTablet}:${Material.Air}:${Material.WoodTablet}`,
      kind: 'technique',
      summary: '重复测试向记录木牍施力',
      confidence: 90,
      learnedAtMonth: 2,
      sourceEventIds: ['known-record-exertion'],
    });
    const context = buildDecisionContext(fixture.state, fixture.actor, 6);
    assertRecordExcludedFromOrdinaryCandidates(context, written.carrierStackId);
    assert.equal(context.options.some((option) => option.id.startsWith('repeat-exert:')
      && option.id.includes(written.carrierStackId)), false,
      'repeat-exert 不得把 written carrier 编入候选');
  }

  {
    const fixture = createFixture(9723, { siteAtOwner: true });
    const written = writeProjectRecord(fixture);
    addStack(fixture, 'ordinary-blank-companion-wood', Material.Wood);
    const blank = addStack(fixture, 'ordinary-blank-tablet', Material.WoodTablet);
    const context = buildDecisionContext(fixture.state, fixture.actor, 6);
    assertRecordExcludedFromOrdinaryCandidates(context, written.carrierStackId);
    const blankTrial = context.options.find((option) => option.id.startsWith('try-inventory-combine:')
      && consumptiveInventoryTargetIds(option).includes(blank.id));
    assert.ok(blankTrial, '同材质空白木牍仍应进入普通 inventory combine 试验');
    assert.equal(consumptiveInventoryTargetIds(blankTrial).includes(written.carrierStackId), false,
      '存在空白木牍时普通试验也只能选择空白载体');
  }

  process.stdout.write('durable record publication tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
