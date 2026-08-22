import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-cross-project-search-memory-test-'));
const bundlePath = path.join(temporaryDirectory, 'cross-project-search-memory.mjs');

function createProject(id, actor, { pressure = 55, planKnowledgeId } = {}) {
  return {
    id,
    kind: 'inquiry',
    need: 'knowledge-preservation',
    desiredFunction: 'durable-record',
    summary: '寻找可记录材料',
    ownerId: actor.id,
    beneficiaryIds: [actor.id],
    triggerFactIds: [],
    pressure,
    createdAtMonth: 1,
    reviewAtMonth: 100,
    status: 'active',
    lastProgressAtMonth: 1,
    ...(planKnowledgeId ? { planKnowledgeId } : {}),
    missingMaterialIds: [13],
    reservations: [],
    contributorIds: [actor.id],
    actionEventIds: [],
    failureEventIds: [],
    completionEventIds: [],
    logisticsEpisodes: [],
    progressEvidence: [],
    searchCampaigns: [],
  };
}

function destinationKey(destination) {
  return `${destination.target.cellId}:${destination.target.z}`;
}

function searchOnlyBlockedProject(actor, basis, {
  id,
  kind,
  need,
  desiredFunction,
  summary,
  materialId,
  planKnowledgeId,
}) {
  return {
    ...createProject(id, actor, { planKnowledgeId }),
    kind,
    need,
    desiredFunction,
    summary,
    status: 'blocked',
    blockedAtMonth: 12,
    blockedReason: '有限材料搜索已经穷尽',
    inquiryOpportunityBasis: structuredClone(basis),
    terminalInquiryOpportunityBasis: undefined,
    missingMaterialIds: [materialId],
    searchCampaigns: [{
      id: `search-campaign:${id}`,
      projectId: id,
      ownerId: actor.id,
      actorId: actor.id,
      materialIds: [materialId],
      planKnowledgeId,
      basisKey: `test-search|project=${id}|actor=${actor.id}|materials=${materialId}|plan=${planKnowledgeId}`,
      openedAt: 2,
      closedAt: 12,
      anchor: { cellId: actor.position.cellId, z: actor.position.z },
      cellIds: [actor.position.cellId],
      inheritedTargetKeys: [],
      inheritedCampaignIds: [],
      attemptedTargetKeys: [`${actor.position.cellId}:${actor.position.z}`],
      sourceFactIds: [`plan-source:${planKnowledgeId}`],
      status: 'exhausted',
    }],
  };
}

function proposal(actor, {
  id,
  kind,
  need,
  desiredFunction,
  summary,
  pressure = 60,
  createdAtMonth = 20,
}) {
  return {
    id,
    kind,
    need,
    desiredFunction,
    summary,
    ownerId: actor.id,
    beneficiaryIds: [actor.id],
    triggerFactIds: [],
    pressure,
    createdAtMonth,
    reviewAtMonth: createdAtMonth + 12,
  };
}

function hypothesisOnlyBlockedConstruction(actor, basis, id) {
  return {
    ...createProject(id, actor),
    kind: 'construction',
    need: 'high-heat-capability',
    desiredFunction: 'high-heat-processing',
    summary: '试验可修建固定窑炉的材料',
    status: 'blocked',
    blockedAtMonth: 12,
    blockedReason: '有限实体假说已经穷尽',
    inquiryOpportunityBasis: structuredClone(basis),
    terminalInquiryOpportunityBasis: structuredClone(basis),
    missingMaterialIds: [],
    searchCampaigns: [],
    hypothesisCampaign: {
      version: 'project-hypothesis-campaign-v2',
      id: `hypothesis:${id}`,
      projectId: id,
      actorId: actor.id,
      openedAt: 2,
      budget: 7,
      noResponseBudget: 4,
      responseBudget: 3,
      observedMaterialIds: [...basis.materialIds],
      sourceFactIds: [...basis.sourceFactIds],
      sourceKeys: [...basis.sourceKeys],
      candidates: [],
      attempts: [{ outcome: 'no-response' }],
      status: 'exhausted',
      endedAt: 12,
      endingReason: 'no-response-budget-exhausted',
    },
  };
}

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export { visibleReachableSearchDestination } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
    export { buildProjectInquiryOpportunityBasis, freezeTerminalInquiryOpportunityBasis, openingStepUsesRenewalCommitment, proposalWithInquiryOpportunityMemory } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-inquiry.ts'))};
    export { exposureRuleFor, exposureTechniqueId } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/interaction-rules.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=cross-project-search-memory-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    Material,
    buildProjectInquiryOpportunityBasis,
    createInitialState,
    exposureRuleFor,
    exposureTechniqueId,
    freezeTerminalInquiryOpportunityBasis,
    openingStepUsesRenewalCommitment,
    proposalWithInquiryOpportunityMemory,
    visibleReachableSearchDestination,
  } = await import(
    `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
  );

  const state = createInitialState(816, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  state.clock.elapsedMonths = 12;
  const actor = state.people[0];
  const originalPosition = structuredClone(actor.position);
  const oldProject = createProject('test-old-search-project', actor);
  state.projects = [oldProject];

  const oldTargetKeys = [];
  for (let index = 0; index < 3; index += 1) {
    const destination = visibleReachableSearchDestination(state, actor, oldProject, [13]);
    assert.ok(destination, '旧项目应能搜索若干个局部 target');
    oldTargetKeys.push(destinationKey(destination));
  }
  assert.equal(new Set(oldTargetKeys).size, oldTargetKeys.length, '旧 campaign 的 target 应互不重复');
  const oldCampaign = oldProject.searchCampaigns[0];
  assert.ok(oldCampaign);

  state.clock.elapsedMonths += 4;
  const inheritedProject = createProject('test-new-search-project', actor, { pressure: 91 });
  state.projects.push(inheritedProject);
  const inheritedDestination = visibleReachableSearchDestination(state, actor, inheritedProject, [13]);
  assert.ok(inheritedDestination, '新项目应继续搜索重叠区域中尚未尝试的 target');
  const inheritedCampaign = inheritedProject.searchCampaigns[0];
  assert.deepEqual(inheritedCampaign.inheritedCampaignIds, [oldCampaign.id], '项目 ID、月份和压力变化不应清除旧 campaign 来源');
  assert.deepEqual(inheritedCampaign.inheritedTargetKeys, [...oldTargetKeys].sort(), '新 campaign 应继承重叠区域的已搜索 target');
  assert.ok(!oldTargetKeys.includes(destinationKey(inheritedDestination)), '新 campaign 不得再返回已继承的 target');

  const changedPlanProject = createProject('test-changed-plan-search-project', actor, {
    planKnowledgeId: 'test-new-plan-edge',
  });
  state.projects.push(changedPlanProject);
  const changedPlanDestination = visibleReachableSearchDestination(state, actor, changedPlanProject, [13]);
  assert.ok(changedPlanDestination, '新的 plan knowledge basis 应仍能开启搜索');
  const changedPlanCampaign = changedPlanProject.searchCampaigns[0];
  assert.deepEqual(changedPlanCampaign.inheritedCampaignIds ?? [], [], '换新 planKnowledgeId 时不应继承旧 campaign');
  assert.deepEqual(changedPlanCampaign.inheritedTargetKeys ?? [], [], '换新 planKnowledgeId 时不应继承旧 target');

  const otherActor = state.people[1];
  assert.ok(otherActor, '定向测试需要第二个 actor');
  otherActor.position = structuredClone(originalPosition);
  otherActor.baselineCapacities.perception = actor.baselineCapacities.perception;
  const otherActorProject = createProject('test-other-actor-search-project', otherActor);
  state.projects.push(otherActorProject);
  const otherActorDestination = visibleReachableSearchDestination(state, otherActor, otherActorProject, [13]);
  assert.ok(otherActorDestination, '另一 actor 在同一区域应能开启自己的搜索');
  const otherActorCampaign = otherActorProject.searchCampaigns[0];
  assert.deepEqual(otherActorCampaign.cellIds, oldCampaign.cellIds, '他人不继承的断言应在同一可见区域下成立');
  assert.deepEqual(otherActorCampaign.inheritedCampaignIds ?? [], [], '另一 actor 不应继承旧 actor 的 campaign');
  assert.deepEqual(otherActorCampaign.inheritedTargetKeys ?? [], [], '另一 actor 不应继承旧 actor 的 target');

  {
    const searchState = createInitialState(817, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
    searchState.clock.elapsedMonths = 12;
    searchState.projects = [];
    const builder = searchState.people[0];
    builder.knowledge = [];
    builder.inventory = [{
      id: 'old-clay-source',
      materialId: Material.Clay,
      quantity: 1,
      sourceEventIds: ['old-clay-origin'],
    }];
    const opening = buildProjectInquiryOpportunityBasis(
      searchState,
      builder,
      'high-heat-processing',
      [],
      1,
    );
    const failedKiln = searchOnlyBlockedProject(builder, opening, {
      id: 'failed-kiln-search',
      kind: 'construction',
      need: 'high-heat-capability',
      desiredFunction: 'high-heat-processing',
      summary: '寻找更多黏土修建固定窑炉',
      materialId: Material.Clay,
      planKnowledgeId: 'legacy-kiln-plan',
    });
    delete failedKiln.terminalInquiryOpportunityBasis;
    freezeTerminalInquiryOpportunityBasis(searchState, builder, failedKiln, 12);
    assert.ok(failedKiln.terminalInquiryOpportunityBasis,
      '没有实体假说的纯材料搜索耗尽项目也必须冻结终局机会依据');
    assert.equal(failedKiln.hypothesisCampaign, undefined,
      'fixture 必须保持 search-only，不能借 hypothesisCampaign 进入记忆');
    searchState.projects = [failedKiln];

    const kilnProposal = proposal(builder, {
      id: 'retry-kiln-search',
      kind: 'construction',
      need: 'high-heat-capability',
      desiredFunction: 'high-heat-processing',
      summary: '寻找更多黏土修建固定窑炉',
      pressure: 99,
    });
    assert.equal(proposalWithInquiryOpportunityMemory(searchState, builder, [], kilnProposal), null,
      'construction 的项目 ID、月份和更高压力都不能重开同一纯搜索失败');

    builder.inventory = [{
      id: 'renamed-old-clay-source',
      materialId: Material.Clay,
      quantity: 1,
      sourceEventIds: ['old-clay-origin', 'inventory-transfer'],
      sourceLineageKeys: [`inventory:${builder.id}:old-clay-source`],
    }];
    assert.equal(proposalWithInquiryOpportunityMemory(searchState, builder, [], kilnProposal), null,
      '同一实体来源经转移或换 stack id 后仍不是新搜索机会');

    builder.inventory.push({
      id: 'new-clay-source',
      materialId: Material.Clay,
      quantity: 1,
      sourceEventIds: ['new-clay-origin'],
    });
    const renewed = proposalWithInquiryOpportunityMemory(searchState, builder, [], kilnProposal);
    assert.ok(renewed, '同 material 的真实新增实体来源应允许数量型物流项目重开');
    assert.ok(renewed.inquiryOpportunityBasis.renewalKeys.some((key) => (
      key === `search-source:${Material.Clay}:inventory:${builder.id}:new-clay-source`
    )), '重开依据必须绑定新增黏土 stack，而不是粗粒度 materialId 或时间');
    const exactRenewalSource = renewed.inquiryOpportunityBasis.opportunitySources.find((source) => (
      source.opportunityKey === `search-source:${Material.Clay}:inventory:${builder.id}:new-clay-source`
    ));
    assert.ok(exactRenewalSource);
    exactRenewalSource.sourceKeys.push(`inventory:${builder.id}:renamed-old-clay-source`);
    const openingStep = (stackId) => ({
      key: `use-${stackId}`,
      summary: '使用黏土',
      reason: '测试 exact renewal commitment',
      action: {
        kind: 'act', operation: 'combine',
        targets: [{ kind: 'inventory-stack', personId: builder.id, stackId }],
      },
      sourceFactIds: [], missingMaterialIds: [], reservations: [],
    });
    assert.equal(openingStepUsesRenewalCommitment(
      searchState,
      builder,
      renewed,
      openingStep('renamed-old-clay-source'),
    ), false, 'search-source 的 lineage 中即使含旧 stack，开场步骤也不能拿旧来源冒充 exact renewal');
    assert.equal(openingStepUsesRenewalCommitment(
      searchState,
      builder,
      renewed,
      openingStep('new-clay-source'),
    ), true, 'search-source 开场步骤必须实际引用 renewal key 编码的新 exact stack');
  }

  {
    const snapshotState = createInitialState(819, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
    snapshotState.clock.elapsedMonths = 12;
    snapshotState.projects = [];
    const seeker = snapshotState.people[0];
    seeker.inventory = [];
    seeker.knowledge = [];
    const omittedOpening = searchOnlyBlockedProject(seeker, undefined, {
      id: 'legacy-search-without-opening-basis',
      kind: 'construction',
      need: 'high-heat-capability',
      desiredFunction: 'high-heat-processing',
      summary: '寻找更多黏土修建固定窑炉',
      materialId: Material.Clay,
      planKnowledgeId: 'legacy-kiln-plan',
    });
    delete omittedOpening.inquiryOpportunityBasis;
    delete omittedOpening.terminalInquiryOpportunityBasis;
    omittedOpening.searchCampaigns[0].sourceFactIds = ['searched-clay-origin'];
    freezeTerminalInquiryOpportunityBasis(snapshotState, seeker, omittedOpening, 12);
    assert.ok(omittedOpening.terminalInquiryOpportunityBasis?.sourceFactIds.includes('searched-clay-origin'),
      'opening basis 缺失时，终局快照仍须保存耗尽 search campaign 携带的来源事实');
    snapshotState.projects = [omittedOpening];
    seeker.inventory = [{
      id: 'reappeared-searched-clay',
      materialId: Material.Clay,
      quantity: 1,
      sourceEventIds: ['searched-clay-origin', 'later-transfer'],
    }];
    const retry = proposal(seeker, {
      id: 'retry-legacy-search',
      kind: 'construction',
      need: 'high-heat-capability',
      desiredFunction: 'high-heat-processing',
      summary: '寻找更多黏土修建固定窑炉',
    });
    assert.equal(proposalWithInquiryOpportunityMemory(snapshotState, seeker, [], retry), null,
      'opening basis 缺失不能让同一已搜索来源在重新出现后伪装成 exact renewal');
  }

  {
    const planState = createInitialState(818, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
    planState.clock.elapsedMonths = 12;
    planState.projects = [];
    const cook = planState.people[0];
    cook.inventory = [];
    cook.knowledge = [];
    const oldRule = exposureRuleFor(Material.Food, Material.Fire);
    const newRule = exposureRuleFor(Material.RawMeat, Material.Fire);
    assert.ok(oldRule && newRule, 'prepared-food fixture 需要两条真实 exposure plan');
    const oldPlanId = exposureTechniqueId(oldRule);
    const newPlanId = exposureTechniqueId(newRule);
    cook.knowledge.push({
      id: oldPlanId,
      kind: 'technique',
      summary: '已核验的熟食方案',
      confidence: 70,
      learnedAtMonth: 1,
      sourceEventIds: ['old-cook-plan'],
    });
    const opening = buildProjectInquiryOpportunityBasis(planState, cook, 'prepared-food', [], 1);
    const failedCooking = searchOnlyBlockedProject(cook, opening, {
      id: 'failed-food-search',
      kind: 'production',
      need: 'food-preparation',
      desiredFunction: 'prepared-food',
      summary: '按已核验方案寻找可烹饪食物',
      materialId: Material.Food,
      planKnowledgeId: oldPlanId,
    });
    delete failedCooking.terminalInquiryOpportunityBasis;
    freezeTerminalInquiryOpportunityBasis(planState, cook, failedCooking, 12);
    planState.projects = [failedCooking];
    const cookingProposal = proposal(cook, {
      id: 'retry-food-search',
      kind: 'production',
      need: 'food-preparation',
      desiredFunction: 'prepared-food',
      summary: '按已核验方案寻找可烹饪食物',
    });
    assert.equal(proposalWithInquiryOpportunityMemory(planState, cook, [], cookingProposal), null,
      '没有新物料来源或新计划时，search-only production 也不得重开');

    cook.knowledge.push({
      id: newPlanId,
      kind: 'technique',
      summary: '新核验的肉类烹饪方案',
      confidence: 70,
      learnedAtMonth: 13,
      sourceEventIds: ['new-cook-plan'],
    });
    const replanned = proposalWithInquiryOpportunityMemory(planState, cook, [], cookingProposal);
    assert.ok(replanned, '本人新获得的可靠且功能相关 plan basis 应允许重开');
    assert.ok(replanned.inquiryOpportunityBasis.renewalKeys.includes(`knowledge:${newPlanId}`),
      '计划重开必须绑定新的可靠 technique，而不是一般知识变化');
  }

  {
    const constructionState = createInitialState(820, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
    constructionState.clock.elapsedMonths = 12;
    constructionState.projects = [];
    const builder = constructionState.people[0];
    builder.knowledge = [];
    builder.inventory = [{
      id: 'hypothesis-old-stone',
      materialId: Material.Stone,
      quantity: 1,
      sourceEventIds: ['hypothesis-old-stone-origin'],
    }];
    const retry = proposal(builder, {
      id: 'retry-hypothesis-kiln',
      kind: 'construction',
      need: 'high-heat-capability',
      desiredFunction: 'high-heat-processing',
      summary: '试验可修建固定窑炉的材料',
      pressure: 99,
    });
    assert.equal(proposalWithInquiryOpportunityMemory(constructionState, builder, [], retry), retry,
      '没有已提交 hypothesis/search 失败时，普通 construction 提案行为必须保持不变');

    const opening = buildProjectInquiryOpportunityBasis(
      constructionState,
      builder,
      'high-heat-processing',
      [],
      1,
    );
    constructionState.projects = [hypothesisOnlyBlockedConstruction(
      builder,
      opening,
      'failed-hypothesis-kiln',
    )];
    assert.equal(proposalWithInquiryOpportunityMemory(constructionState, builder, [], retry), null,
      'construction 的实体假说已经提交并耗尽后，没有新正向机会不得原样重开');

    builder.inventory.push({
      id: 'hypothesis-new-clay',
      materialId: Material.Clay,
      quantity: 1,
      sourceEventIds: ['hypothesis-new-clay-origin'],
    });
    const renewed = proposalWithInquiryOpportunityMemory(constructionState, builder, [], retry);
    assert.ok(renewed, 'construction hypothesis failure 遇到真实新材料机会时可以重开');
    assert.ok(renewed.inquiryOpportunityBasis.renewalKeys.includes(`material:${Material.Clay}`),
      'hypothesis renewal 必须记录新材料类型的正向机会');
    const materialStep = (stackId) => ({
      key: `construction-hypothesis-${stackId}`,
      summary: '使用候选建材',
      reason: '测试 construction hypothesis renewal commitment',
      action: {
        kind: 'act', operation: 'combine',
        targets: [{ kind: 'inventory-stack', personId: builder.id, stackId }],
      },
      sourceFactIds: [], missingMaterialIds: [], reservations: [],
    });
    assert.equal(openingStepUsesRenewalCommitment(
      constructionState,
      builder,
      renewed,
      materialStep('hypothesis-old-stone'),
    ), false, 'construction 重开后的 opening step 不能先使用旧机会');
    assert.equal(openingStepUsesRenewalCommitment(
      constructionState,
      builder,
      renewed,
      materialStep('hypothesis-new-clay'),
    ), true, 'construction 重开后的 opening step 必须实际使用新正向机会');
  }

  process.stdout.write('cross-project search memory tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
