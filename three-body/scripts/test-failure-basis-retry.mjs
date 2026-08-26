import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-failure-basis-retry-test-'));
const bundlePath = path.join(temporaryDirectory, 'failure-basis-retry.mjs');

try {
  const entry = `
    export { buildDecisionContext, isCurrentlyBodyBlockedPlacement, isFailureRetryCoolingDown, optionHasCurrentlyBodyBlockedPlacement } from ${JSON.stringify(path.resolve('src/game/eland/application/action-options.ts'))};
    export { refreshProjectHypothesisCampaign } from ${JSON.stringify(path.resolve('src/game/eland/application/project-hypotheses.ts'))};
    export { previewOwnedProjectStep } from ${JSON.stringify(path.resolve('src/game/eland/application/project-options.ts'))};
    export { appendCommittedEvents } from ${JSON.stringify(path.resolve('src/game/eland/domain/history.ts'))};
    export { clearPlanningEventOverlay, inheritPlanningEventOverlay, registerPlanningEventOverlay, worldEventById } from ${JSON.stringify(path.resolve('src/game/eland/domain/event-index.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/simulation.ts'))};
    export { setVoxel } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=failure-basis-retry-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    appendCommittedEvents,
    buildDecisionContext,
    clearPlanningEventOverlay,
    createInitialState,
    inheritPlanningEventOverlay,
    isCurrentlyBodyBlockedPlacement,
    isFailureRetryCoolingDown,
    Material,
    optionHasCurrentlyBodyBlockedPlacement,
    previewOwnedProjectStep,
    refreshProjectHypothesisCampaign,
    registerPlanningEventOverlay,
    setVoxel,
    worldEventById,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const actorId = 'person:actor:with:colons';
  const receiverId = 'person:receiver:a';
  const otherReceiverId = 'person:receiver:b';
  const recordUseBasis = {
    version: 'record-use-basis-v1',
    basisKey: 'record-use:reader:project-a:record-a:technique-a',
    projectId: 'project:a', projectOwnerId: actorId, readerId: actorId, recordAuthorId: 'person:author',
    demand: { kind: 'project-deficit', projectId: 'project:a', deficitSourceIds: ['deficit:old'] },
    recordId: 'record:a', knowledgeId: 'technique:a', codebookId: 'codebook:a', techniqueId: 'technique:a',
    ruleSignature: 'technique:a', projectPressure: 77,
    experimentAction: { kind: 'act', operation: 'combine', targets: [{ kind: 'person', personId: receiverId }] },
    expectedOutputMaterialId: 23, createdAtMonth: 3,
    projectSourceEventIds: ['project-source:old'], recordSourceEventIds: ['record-source:old'],
    codebookSourceEventIds: ['codebook-source:old'], inputSourceEventIds: ['input-source:old'],
    sourceFactIds: ['source:old'],
  };
  const baseOption = {
    id: 'retry-material-transfer', summary: '再次取得木材', reason: '项目仍缺材料',
    goal: { kind: 'inventory-at-least', materialId: 13, quantity: 2, personId: receiverId },
    nextAction: {
      kind: 'transfer', materialId: 13, quantity: 2,
      from: { kind: 'ground', cellId: 7, z: 2 }, to: { kind: 'person', personId: receiverId },
      dropId: 'drop:a',
    },
    target: { kind: 'person', personId: receiverId },
    estimatedDuration: 'one-month', sourceFactIds: ['source:old'],
    projectId: 'project:a', recordUseBasis,
  };
  const historicalIntent = {
    id: 'intent:retry:project:alpha:42', ownerId: actorId, summary: '旧摘要可以与新候选不同', domain: 'strategic',
    goal: structuredClone(baseOption.goal), nextAction: structuredClone(baseOption.nextAction),
    target: structuredClone(baseOption.target), status: 'blocked', createdAtMonth: 4, lastProgressAtMonth: 4,
    progress: 0, sourceDecisionEventId: 'decision:old', projectId: baseOption.projectId,
    recordUseBasis: structuredClone(recordUseBasis), sourceFactIds: ['source:old'], actionEventIds: [], replanCount: 1,
  };
  const prefixes = [
    'memory:intent-opening-failed:',
    'memory:intent-review-due:',
    'memory:intent-blocked:',
    'memory:intent-action-failed:',
  ];
  const failureMemory = (prefix, intent = historicalIntent, createdAtMonth = 10) => ({
    id: `${prefix}${intent.id}:${createdAtMonth}`,
    kind: 'failure', summary: `失败：${baseOption.summary}`, importance: 76,
    createdAtMonth, lastRecalledAtMonth: createdAtMonth, personIds: [receiverId], sourceEventIds: ['failure:event'],
  });
  const fixture = (memory = failureMemory('memory:intent-action-failed:')) => ({
    state: { intents: [historicalIntent] },
    person: { id: actorId, memories: [memory] },
  });
  const cooling = (option, atMonth, setup = fixture()) => isFailureRetryCoolingDown(setup.state, setup.person, option, atMonth);

  for (const prefix of prefixes) {
    const setup = fixture(failureMemory(prefix));
    assert.equal(cooling(baseOption, 11, setup), true, `${prefix} 必须能可靠回查含冒号的历史 intent ID`);
  }
  for (let month = 10; month <= 16; month += 1) {
    assert.equal(cooling(baseOption, month), true, `失败当月及之后六个月应冷却相同语义 basis：${month}`);
  }
  assert.equal(cooling(baseOption, 17), false, '失败后的第七个月必须恢复相同语义候选');

  const withNewSource = { ...structuredClone(baseOption), sourceFactIds: ['source:old', 'source:new-observation'] };
  assert.equal(cooling(withNewSource, 10), true,
    '失败当月的额外普通复议不得把同一语义 basis 因来源集合重建而原样重试');
  assert.equal(cooling(withNewSource, 11), false, '相同 basis 出现新的真实 sourceFactId 时必须立即重开');
  const withFailureEventOnly = { ...structuredClone(baseOption), sourceFactIds: ['source:old', 'failure:event'] };
  assert.equal(cooling(withFailureEventOnly, 11), true,
    '失败动作本身进入候选来源时不算新的世界证据，不能在同月绕过冷却');

  const changedPosition = structuredClone(baseOption);
  changedPosition.nextAction.from.cellId = 8;
  assert.equal(cooling(changedPosition, 10), false, '失败当月若行动位置真实改变仍应视为不同语义 basis');
  assert.equal(cooling(changedPosition, 11), false, '物质位置改变必须形成新的语义 basis');
  const changedQuantity = structuredClone(baseOption);
  changedQuantity.goal.quantity = 3;
  changedQuantity.nextAction.quantity = 3;
  assert.equal(cooling(changedQuantity, 11), false, '目标与行动数量改变必须形成新的语义 basis');
  const changedPerson = structuredClone(baseOption);
  changedPerson.goal.personId = otherReceiverId;
  changedPerson.target.personId = otherReceiverId;
  changedPerson.nextAction.to.personId = otherReceiverId;
  assert.equal(cooling(changedPerson, 11), false, '行动涉及的人物改变必须形成新的语义 basis');
  const changedRoutingMetadataOnly = {
    ...structuredClone(baseOption),
    target: { kind: 'drop', dropId: 'stale-logistics-target' },
  };
  assert.equal(cooling(changedRoutingMetadataOnly, 11), true,
    '项目重编译遗留的顶层路由 target 不得把同一 action/goal 伪装成新尝试');
  const changedProject = { ...structuredClone(baseOption), projectId: 'project:b' };
  assert.equal(cooling(changedProject, 10), true,
    '失败当月不能仅靠切换项目语义再次提交完全相同的物理动作');
  assert.equal(cooling(changedProject, 11), false, '项目 ID 改变必须形成新的语义 basis');
  const changedGoalOnly = {
    ...structuredClone(baseOption),
    goal: { ...structuredClone(baseOption.goal), quantity: 99 },
  };
  assert.equal(cooling(changedGoalOnly, 10), true,
    '失败当月不能仅靠切换目标语义再次提交完全相同的物理动作');
  assert.equal(cooling(changedGoalOnly, 11), false,
    '下一月仍按完整因果 basis 区分真实不同目标');
  const changedRecord = structuredClone(baseOption);
  changedRecord.recordUseBasis.recordId = 'record:b';
  assert.equal(cooling(changedRecord, 11), false, '记录使用 basis 改变必须形成新的语义 basis');

  const authoritativeFailureFact = {
    id: 'action:authoritative-failure:10', kind: 'action', atMonth: 10, orderInMonth: 1,
    planningTick: 1, orderInTick: 1, actionTick: 1, cellId: 7,
    who: actorId, intentId: 'intent:authoritative-failure', cause: 'intent',
    action: structuredClone(baseOption.nextAction),
    fromCellId: 7, toCellId: 7, fromZ: 2, toZ: 2, pathSegment: [],
    status: 'blocked', result: '权威领域规则拒绝了该动作', diff: {},
  };
  const authoritativeFailureIntent = {
    ...structuredClone(historicalIntent), id: 'intent:authoritative-failure',
    // Simulate later project recompilation leaving different routing fields on
    // the intent. Cooldown must still describe the action that actually ran.
    nextAction: { ...structuredClone(baseOption.nextAction), from: { kind: 'ground', cellId: 99, z: 2 } },
    target: { kind: 'drop', dropId: 'stale-after-recompile' },
    status: 'blocked', actionEventIds: [authoritativeFailureFact.id],
    goalOutcome: {
      version: 'intent-goal-outcome-v1', kind: 'attempted-unmet', basisKey: 'failure:basis',
      resolvedAtMonth: 10, sourceEventIds: [authoritativeFailureFact.id],
    },
  };
  const authoritativeSetup = {
    state: {
      intents: [authoritativeFailureIntent],
      world: {
        past: [],
        historyCursor: { version: 1, eventCount: 0, hotStartIndex: 0, tailEventId: null },
      },
    },
    person: { id: actorId, memories: [] },
  };
  registerPlanningEventOverlay(authoritativeSetup.state, [authoritativeFailureFact]);
  const nestedPlanningPreview = { ...authoritativeSetup.state };
  inheritPlanningEventOverlay(authoritativeSetup.state, nestedPlanningPreview);
  assert.equal(
    worldEventById(nestedPlanningPreview, authoritativeFailureFact.id)?.id,
    authoritativeFailureFact.id,
    '嵌套 planning clone 必须继承外层当月 overlay，避免候选预览与提交重编译看见不同事实',
  );
  clearPlanningEventOverlay(nestedPlanningPreview);
  assert.equal(cooling(baseOption, 10, authoritativeSetup), true,
    '即使容量有限的自传记忆已无失败条目，同月 planning overlay 中的权威失败 ActionFact 仍须抑制同一 basis');
  clearPlanningEventOverlay(authoritativeSetup.state);
  appendCommittedEvents(authoritativeSetup.state, [authoritativeFailureFact]);
  assert.equal(cooling(baseOption, 11, authoritativeSetup), true,
    '已提交的权威失败 ActionFact 必须按实际执行动作而非重编译后的 stale intent.nextAction 建立 basis');
  assert.equal(cooling(changedPosition, 11, authoritativeSetup), false,
    '权威失败事实不得误杀语义位置已经改变的动作');
  assert.equal(cooling(baseOption, 17, authoritativeSetup), false,
    '权威失败事实与记忆 fallback 使用相同的六个月有界冷却窗口');

  const attemptIntent = {
    ...structuredClone(historicalIntent), id: 'intent:attempt:with:colons', projectId: undefined, recordUseBasis: undefined,
    goal: { kind: 'knowledge', factId: 'attempt:combine:inputs:10' },
    nextAction: { kind: 'act', operation: 'combine', targets: [{ kind: 'person', personId: receiverId }] },
    target: { kind: 'person', personId: receiverId },
  };
  const attemptOption = {
    ...structuredClone(baseOption), id: 'try-combine:inputs', projectId: undefined, recordUseBasis: undefined,
    goal: { kind: 'knowledge', factId: 'attempt:combine:inputs:11' },
    nextAction: structuredClone(attemptIntent.nextAction), target: structuredClone(attemptIntent.target),
  };
  const attemptSetup = {
    state: { intents: [attemptIntent] },
    person: { id: actorId, memories: [failureMemory('memory:intent-action-failed:', attemptIntent)] },
  };
  assert.equal(cooling(attemptOption, 11, attemptSetup), true,
    '实验 attempt factId 中仅月份变化不能伪装成新的语义尝试');

  const predictionIntent = {
    ...structuredClone(historicalIntent), id: 'intent:prediction:with:colons', projectId: undefined, recordUseBasis: undefined,
    goal: { kind: 'representation-made', representationId: 'predict-era:10:actor' },
    nextAction: {
      kind: 'communicate', audience: [receiverId], channel: 'voice',
      content: { id: 'predict-era:10:actor', kind: 'prediction', summary: '旧预测措辞', prediction: { targetEpoch: 'chaotic', predictedStartMonth: 12, toleranceMonths: 4, expiresAtMonth: 15 } },
    },
    target: { kind: 'person', personId: receiverId },
  };
  const predictionOption = {
    ...structuredClone(baseOption), id: 'predict-era:11:actor', projectId: undefined, recordUseBasis: undefined,
    goal: { kind: 'representation-made', representationId: 'predict-era:11:actor' },
    nextAction: {
      kind: 'communicate', audience: [receiverId], channel: 'voice',
      content: { id: 'predict-era:11:actor', kind: 'prediction', summary: '新预测措辞', prediction: { targetEpoch: 'chaotic', predictedStartMonth: 13, toleranceMonths: 4, expiresAtMonth: 16 } },
    },
    target: { kind: 'person', personId: receiverId },
  };
  const predictionSetup = {
    state: { intents: [predictionIntent] },
    person: { id: actorId, memories: [failureMemory('memory:intent-action-failed:', predictionIntent)] },
  };
  assert.equal(cooling(predictionOption, 11, predictionSetup), true,
    '没有新来源时，预测日期随提交月平移不能绕过同一语义 basis 的冷却');

  const permissionIntent = {
    ...structuredClone(predictionIntent), id: 'intent:permission:with:colons',
    goal: { kind: 'representation-made', representationId: 'offer-permission:10' },
    nextAction: {
      kind: 'communicate', audience: [receiverId], channel: 'voice',
      content: { id: 'offer-permission:10', kind: 'offer', summary: '旧许可措辞', proposal: {
        kind: 'permission', proposerId: actorId, partnerId: receiverId, collectiveId: 'collective:a',
        grantorId: actorId, granteeId: receiverId, materialId: 13, maxQuantityPerTransfer: 1,
        validUntilMonth: 34, expiresAtMonth: 16,
      } },
    },
  };
  const permissionOption = {
    ...structuredClone(predictionOption), id: 'offer-permission:11',
    goal: { kind: 'representation-made', representationId: 'offer-permission:11' },
    nextAction: structuredClone(permissionIntent.nextAction),
  };
  permissionOption.nextAction.content.id = 'offer-permission:11';
  permissionOption.nextAction.content.proposal.validUntilMonth = 35;
  permissionOption.nextAction.content.proposal.expiresAtMonth = 17;
  const permissionSetup = {
    state: { intents: [permissionIntent] },
    person: { id: actorId, memories: [failureMemory('memory:intent-action-failed:', permissionIntent)] },
  };
  assert.equal(cooling(permissionOption, 11, permissionSetup), true,
    '许可窗口随提交月平移不能伪装成新的物质许可语义');

  const freeTextFailure = {
    ...failureMemory('memory:intent-action-failed:'),
    id: 'memory:free-text:failure:10', summary: `这段自由文本恰好包含“${baseOption.summary}”`,
  };
  assert.equal(cooling(baseOption, 11, fixture(freeTextFailure)), false,
    '无法关联历史 intent 的自由文本失败不得按相似摘要误杀候选');
  const differentIntent = { ...structuredClone(historicalIntent), id: 'intent:different:basis', goal: { ...historicalIntent.goal, quantity: 99 } };
  const differentSetup = {
    state: { intents: [differentIntent] },
    person: { id: actorId, memories: [failureMemory('memory:intent-blocked:', differentIntent)] },
  };
  assert.equal(cooling(baseOption, 11, differentSetup), false, '相似摘要但语义 basis 不同不得进入冷却');

  const openingIntent = {
    ...structuredClone(historicalIntent), id: 'intent:opening:with:colons',
    openingAction: structuredClone(baseOption.nextAction),
    nextAction: { kind: 'move', toCellId: 99, toZ: 3 },
    goal: { kind: 'at-cell', cellId: 99 }, target: { kind: 'voxel', position: { x: 9, y: 9, z: 3 } },
  };
  const openingSetup = {
    state: { intents: [openingIntent] },
    person: { id: actorId, memories: [failureMemory('memory:intent-opening-failed:', openingIntent)] },
  };
  assert.equal(cooling(baseOption, 11, openingSetup), true,
    'opening-failed 必须按旧 intent 的 openingAction 匹配候选 nextAction，而不是误用尚未执行的后续动作');

  assert.equal(cooling({ ...structuredClone(baseOption), id: 'accept-exchange:agreement:with:colons' }, 11), false,
    '交换的 required response 必须绕过失败冷却');
  assert.equal(cooling({ ...structuredClone(baseOption), id: 'settle-exchange:agreement:with:colons' }, 11), false,
    '交换履约候选必须绕过失败冷却');

  const placementState = createInitialState(9127, { endpoint: { kind: 'months', value: 12 } });
  const placementActor = placementState.people[0];
  const occupant = placementState.people[1];
  for (const person of placementState.people.slice(2)) person.diedAtMonth = 0;
  placementActor.position = {
    cellId: (occupant.position.cellId + placementState.world.grid.width) % (placementState.world.grid.width * placementState.world.grid.depth),
    z: occupant.position.z,
  };
  placementActor.inventory.push({
    id: 'occupied-placement-wood', materialId: Material.Wood, quantity: 1, sourceEventIds: ['occupied-placement-source'],
  });
  const occupiedPosition = {
    x: occupant.position.cellId % placementState.world.grid.width,
    y: Math.floor(occupant.position.cellId / placementState.world.grid.width),
    z: occupant.position.z,
  };
  setVoxel(placementState.world.grid, occupiedPosition.x, occupiedPosition.y, occupiedPosition.z, Material.Air);
  const occupiedPlacementAction = {
    kind: 'act', operation: 'combine',
    targets: [
      { kind: 'inventory-stack', personId: placementActor.id, stackId: 'occupied-placement-wood' },
      { kind: 'voxel', position: occupiedPosition },
    ],
  };
  assert.equal(
    isCurrentlyBodyBlockedPlacement(placementState, placementActor, occupiedPlacementAction),
    true,
    '当前会产生实心输出且被身体占据的体素不得作为合法放置候选',
  );
  assert.equal(
    optionHasCurrentlyBodyBlockedPlacement(placementState, placementActor, {
      nextAction: { kind: 'move', toCellId: occupant.position.cellId, toZ: occupant.position.z },
      completionAction: occupiedPlacementAction,
    }),
    true,
    '移动后的 completionAction 已知会向身体占位格放入固体时，整条计划当前不得作为可供性',
  );
  const occupiedMechanicalInstall = {
    kind: 'act', operation: 'exert',
    targets: [{ kind: 'voxel', position: occupiedPosition }],
    mechanicalPowerBasis: { mode: 'install', componentPosition: occupiedPosition },
  };
  assert.equal(
    isCurrentlyBodyBlockedPlacement(placementState, placementActor, occupiedMechanicalInstall),
    true,
    '机械项目在移动后才显露的冻结实体安装也必须识别当前身体占位',
  );
  setVoxel(placementState.world.grid, occupiedPosition.x, occupiedPosition.y, occupiedPosition.z, Material.Stone);
  assert.equal(
    isCurrentlyBodyBlockedPlacement(placementState, placementActor, occupiedMechanicalInstall),
    false,
    '冻结安装位已非空气时不能伪装成临时身体等待，仍应交给项目失败与复核语义',
  );
  setVoxel(placementState.world.grid, occupiedPosition.x, occupiedPosition.y, occupiedPosition.z, Material.Air);
  assert.equal(
    isCurrentlyBodyBlockedPlacement(placementState, placementActor, {
      kind: 'act', operation: 'exert',
      targets: [{ kind: 'voxel', position: occupiedPosition }],
      electricalPowerBasis: { mode: 'install', componentPosition: occupiedPosition },
    }),
    true,
    '电力实体安装必须复用同一个当前身体占位边界',
  );
  occupant.diedAtMonth = 0;
  assert.equal(
    isCurrentlyBodyBlockedPlacement(placementState, placementActor, occupiedPlacementAction),
    false,
    '身体离开后同一领域 combine 规则必须重新开放放置候选',
  );
  assert.equal(
    isCurrentlyBodyBlockedPlacement(placementState, placementActor, occupiedMechanicalInstall),
    false,
    '身体离开后冻结机械安装必须重新开放，而不是永久冷却项目',
  );

  const nestedPreviewState = createInitialState(9159, { endpoint: { kind: 'months', value: 24 } });
  nestedPreviewState.clock.elapsedMonths = 10;
  const nestedPreviewActor = nestedPreviewState.people[0];
  nestedPreviewState.people.slice(1).forEach((person) => { person.diedAtMonth = 0; });
  nestedPreviewActor.bornAtMonth = -240;
  nestedPreviewActor.conditions = [];
  nestedPreviewActor.memories = [];
  nestedPreviewActor.knowledge = [];
  nestedPreviewActor.inventory = [{
    id: 'nested-preview-mill', materialId: Material.Mill, quantity: 1,
    sourceEventIds: ['nested-preview-mill-source'],
  }];
  delete nestedPreviewActor.activeIntentId;
  const nestedPreviewWoodDrop = {
    id: 'nested-preview-wood-drop', materialId: Material.Wood, quantity: 2,
    cellId: nestedPreviewActor.position.cellId, z: nestedPreviewActor.position.z,
    createdAtMonth: 10, sourceEventIds: ['nested-preview-wood-source'],
  };
  nestedPreviewState.world.drops = [nestedPreviewWoodDrop];
  nestedPreviewState.intents = [];
  const nestedPreviewProject = {
    id: 'nested-preview-workshop-project', kind: 'production',
    need: 'production-efficiency', desiredFunction: 'workshop-production',
    summary: '试验可固定使用的生产设施', ownerId: nestedPreviewActor.id,
    beneficiaryIds: [nestedPreviewActor.id], triggerFactIds: ['nested-preview-pressure'], pressure: 72,
    createdAtMonth: 10, reviewAtMonth: 100, status: 'active', lastProgressAtMonth: 10,
    missingMaterialIds: [], materialDemands: [], reservations: [], contributorIds: [nestedPreviewActor.id],
    actionEventIds: [], failureEventIds: [], completionEventIds: [], progressEvidence: [],
    searchCampaigns: [], logisticsEpisodes: [],
  };
  nestedPreviewState.projects = [nestedPreviewProject];
  const nestedCampaign = refreshProjectHypothesisCampaign(
    nestedPreviewState.seed,
    11,
    nestedPreviewActor,
    nestedPreviewProject,
    [nestedPreviewWoodDrop],
  );
  const woodMillCandidate = nestedCampaign.candidates.find((candidate) => (
    candidate.operation === 'combine-inventory'
      && candidate.materialIds[0] === Material.Wood
      && candidate.materialIds[1] === Material.Mill
  ));
  assert.ok(woodMillCandidate,
    '手中磨坊与同地木材必须自然形成 13+59 的可观察项目假设');
  nestedCampaign.activeCandidateKey = woodMillCandidate.key;

  const nestedTransferFact = {
    id: 'action:nested-preview-transfer:11', kind: 'action', atMonth: 11, orderInMonth: 1,
    planningTick: 1, orderInTick: 1, actionTick: 1, cellId: nestedPreviewActor.position.cellId,
    who: nestedPreviewActor.id, cause: 'intent',
    action: {
      kind: 'transfer', materialId: Material.Wood, quantity: 1,
      from: {
        kind: 'ground', cellId: nestedPreviewActor.position.cellId, z: nestedPreviewActor.position.z,
      },
      to: { kind: 'person', personId: nestedPreviewActor.id },
      dropId: nestedPreviewWoodDrop.id,
    },
    fromCellId: nestedPreviewActor.position.cellId, toCellId: nestedPreviewActor.position.cellId,
    fromZ: nestedPreviewActor.position.z, toZ: nestedPreviewActor.position.z, pathSegment: [],
    status: 'completed', result: '取得木材', diff: { quantity: 1 },
  };
  nestedPreviewProject.actionEventIds.push(nestedTransferFact.id);
  const staleNestedStep = previewOwnedProjectStep(
    nestedPreviewState,
    nestedPreviewActor,
    nestedPreviewProject.id,
  );
  assert.ok(staleNestedStep?.action.kind === 'transfer' || staleNestedStep?.action.kind === 'move',
    '没有当月 overlay 时，嵌套项目预览的取物事实仍是 stale，应继续转移或移动');

  nestedPreviewActor.inventory.push({
    id: 'nested-preview-wood', materialId: Material.Wood, quantity: 1,
    sourceEventIds: ['nested-preview-wood-source'],
  });
  nestedPreviewWoodDrop.quantity = 1;
  registerPlanningEventOverlay(nestedPreviewState, [nestedTransferFact]);
  const exactNestedStep = previewOwnedProjectStep(
    nestedPreviewState,
    nestedPreviewActor,
    nestedPreviewProject.id,
  );
  assert.deepEqual(exactNestedStep?.action, {
    kind: 'act', operation: 'combine',
    targets: [
      { kind: 'inventory-stack', personId: nestedPreviewActor.id, stackId: 'nested-preview-wood' },
      { kind: 'inventory-stack', personId: nestedPreviewActor.id, stackId: 'nested-preview-mill' },
    ],
  }, '嵌套项目预览必须继承当月取物 overlay，并将同一 13+59 假设精确重编译为 combine');

  const decisionBeforeNestedFailure = buildDecisionContext(nestedPreviewState, nestedPreviewActor, 11);
  const nestedProjectOption = decisionBeforeNestedFailure.options.find((option) => (
    option.projectId === nestedPreviewProject.id
      && option.nextAction.kind === 'act'
      && option.nextAction.operation === 'combine'
      && JSON.stringify(option.nextAction) === JSON.stringify(exactNestedStep.action)
  ));
  assert.ok(nestedProjectOption,
    '在失败事实出现前，决策上下文必须包含 overlay 重编译后的项目 combine 候选');

  const nestedFailureIntentId = 'intent:nested-preview-failure';
  const nestedFailureFact = {
    id: 'action:nested-preview-failure:11', kind: 'action', atMonth: 11, orderInMonth: 2,
    planningTick: 2, orderInTick: 1, actionTick: 2, cellId: nestedPreviewActor.position.cellId,
    who: nestedPreviewActor.id, intentId: nestedFailureIntentId, cause: 'intent',
    action: structuredClone(nestedProjectOption.nextAction),
    fromCellId: nestedPreviewActor.position.cellId, toCellId: nestedPreviewActor.position.cellId,
    fromZ: nestedPreviewActor.position.z, toZ: nestedPreviewActor.position.z, pathSegment: [],
    status: 'blocked', result: '权威领域规则拒绝了该组合', diff: {},
  };
  nestedPreviewState.intents.push({
    id: nestedFailureIntentId, ownerId: nestedPreviewActor.id, summary: nestedProjectOption.summary,
    domain: nestedProjectOption.domain ?? 'strategic', goal: structuredClone(nestedProjectOption.goal),
    nextAction: structuredClone(nestedProjectOption.nextAction),
    ...(nestedProjectOption.target ? { target: structuredClone(nestedProjectOption.target) } : {}),
    status: 'blocked', createdAtMonth: 11, lastProgressAtMonth: 11, progress: 0,
    sourceDecisionEventId: 'decision:nested-preview:11', projectId: nestedPreviewProject.id,
    sourceFactIds: [...nestedProjectOption.sourceFactIds], actionEventIds: [nestedFailureFact.id], replanCount: 0,
    goalOutcome: {
      version: 'intent-goal-outcome-v1', kind: 'attempted-unmet', basisKey: 'nested-preview-failure-basis',
      resolvedAtMonth: 11, sourceEventIds: [nestedFailureFact.id],
    },
  });
  registerPlanningEventOverlay(nestedPreviewState, [nestedTransferFact, nestedFailureFact]);
  const decisionAfterNestedFailure = buildDecisionContext(nestedPreviewState, nestedPreviewActor, 11);
  assert.equal(
    decisionAfterNestedFailure.options.some((option) => option.id === nestedProjectOption.id),
    false,
    '终止 intent 精确引用当月 blocked combine 后，同一嵌套项目候选必须被权威失败冷却过滤',
  );
  clearPlanningEventOverlay(nestedPreviewState);

  const roundTripped = JSON.parse(JSON.stringify({ ...fixture(), option: baseOption }));
  assert.equal(
    isFailureRetryCoolingDown(roundTripped.state, roundTripped.person, roundTripped.option, 11),
    true,
    '结构化失败关联与语义 basis 必须在 JSON roundtrip 后保持一致',
  );

  process.stdout.write('failure basis retry tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
