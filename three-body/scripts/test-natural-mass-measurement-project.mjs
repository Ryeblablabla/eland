import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-natural-measurement-project-'));
const bundlePath = path.join(temporaryDirectory, 'natural-measurement-project.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/simulation.ts'))};
    export { addInventory, executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { appendCommittedEvents } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/history.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export {
      inventoryCombinationForOutput,
      inventoryCombinationTechniqueId,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/interaction-rules.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export { buildProjectPressureBasis } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-pressure.ts'))};
    export { deriveProjectProposals } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-proposals.ts'))};
    export {
      PROJECT_HYPOTHESIS_ATTEMPT_BUDGET,
      PROJECT_HYPOTHESIS_RESPONSE_BUDGET,
      projectHypothesisCandidateKey,
      refreshProjectHypothesisCampaign,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-hypotheses.ts'))};
    export { hypothesisStep } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-inquiry.ts'))};
    export { compileProjectStep } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-step-compiler.ts'))};
    export { recordProjectAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-options.ts'))};
    export {
      massMeasurementProjectCompletionEvidence,
      measurementUncertaintyBasisFor,
      validateMeasurementUncertaintyBasis,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/measurement-options.ts'))};
    export {
      beginHistoryRetentionProjection,
      finishHistoryRetentionProjection,
      foldHistoryRetentionSegment,
    } from ${JSON.stringify(path.join(projectRoot, 'server/history-retention-projection.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=natural-measurement-project-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const {
    Material,
    PROJECT_HYPOTHESIS_ATTEMPT_BUDGET,
    PROJECT_HYPOTHESIS_RESPONSE_BUDGET,
    addInventory,
    appendCommittedEvents,
    beginHistoryRetentionProjection,
    buildProjectPressureBasis,
    compileProjectStep,
    createInitialState,
    deriveProjectProposals,
    executePrimitiveAction,
    finishHistoryRetentionProjection,
    foldHistoryRetentionSegment,
    hypothesisStep,
    instantiateProject,
    inventoryCombinationForOutput,
    inventoryCombinationTechniqueId,
    massMeasurementProjectCompletionEvidence,
    measurementUncertaintyBasisFor,
    projectHypothesisCandidateKey,
    recordProjectAction,
    refreshProjectHypothesisCampaign,
    validateMeasurementUncertaintyBasis,
  } = api;

  const state = createInitialState(20260827, { endpoint: { kind: 'months', value: 120 }, chaosIntensity: 0 });
  state.projects = [];
  const [actor, other] = state.people;
  actor.inventory = [];
  actor.knowledge = [];
  actor.memories = [];
  other.inventory = [];
  other.memories = [];
  addInventory(actor, Material.Wood, 5, [], 'measurement-fixture-wood');
  addInventory(actor, Material.Stone, 1, [], 'measurement-fixture-stone');
  addInventory(actor, Material.Rope, 2, [], 'measurement-fixture-rope');
  addInventory(actor, Material.Bronze, 1, [], 'measurement-fixture-bronze');

  const execute = (action, atMonth, orderInMonth) => executePrimitiveAction(
    state,
    actor,
    action,
    atMonth,
    orderInMonth,
    { cause: 'intent', actionTick: Math.max(1, Math.min(15, orderInMonth)) },
  );
  const commit = (action, atMonth, orderInMonth) => {
    const fact = execute(action, atMonth, orderInMonth);
    assert.equal(fact.status, 'completed', fact.result);
    appendCommittedEvents(state, [fact]);
    return fact;
  };
  const combine = (stackIds, atMonth, orderInMonth) => commit({
    kind: 'act', operation: 'combine', targets: stackIds.map((stackId) => ({
      kind: 'inventory-stack', personId: actor.id, stackId,
    })),
  }, atMonth, orderInMonth);

  const firstPlank = combine(['measurement-fixture-wood', 'measurement-fixture-wood'], 1, 1);
  const stoneTool = combine(['measurement-fixture-stone', 'measurement-fixture-wood'], 1, 2);
  const secondPlank = combine(['measurement-fixture-wood', 'measurement-fixture-wood'], 2, 1);
  state.clock.elapsedMonths = 2;
  const plankStack = actor.inventory.find((stack) => stack.materialId === Material.Plank);
  const stoneToolStack = actor.inventory.find((stack) => stack.materialId === Material.StoneTool);
  assert.ok(plankStack && stoneToolStack, '跨月制作必须留下两个当前实体栈');
  assert.deepEqual(plankStack.sourceEventIds, [firstPlank.id, secondPlank.id]);

  const uncertainty = measurementUncertaintyBasisFor(state, actor, 3);
  assert.ok(uncertainty, '本人记住三次、跨两月制作且两个实体处于同一粗手感档时应形成比较不确定性');
  assert.equal(uncertainty.productionEventIds.length, 3);
  assert.equal(uncertainty.experiencedMonthCount, 2);
  assert.equal(uncertainty.samples[0].perceivedLoadBand, uncertainty.samples[1].perceivedLoadBand);
  assert.equal(JSON.stringify(uncertainty).includes('exactMass'), false);
  assert.equal(JSON.stringify(uncertainty).includes('milestone'), false);
  assert.equal(validateMeasurementUncertaintyBasis(state, actor, uncertainty, true, 3), true);
  assert.equal(validateMeasurementUncertaintyBasis(state, other, uncertainty, true, 3), false,
    '跨人物不能继承本人的实体与记忆 basis');

  const subject = {
    need: 'measurement-uncertainty',
    desiredFunction: 'comparable-mass-measurement',
    beneficiaryIds: [actor.id],
    createdAtMonth: 3,
    measurementUncertaintyBasis: uncertainty,
  };
  const pressure = buildProjectPressureBasis(state, actor, subject, 3);
  assert.ok(pressure.pressure >= 42, '真实个人不确定性必须跨过通用项目压力阈值');
  const remembered = actor.memories;
  actor.memories = [];
  const durableExperience = measurementUncertaintyBasisFor(state, actor, 3);
  assert.ok(durableExperience,
    '短期情节被淘汰后，本人仍持有的制作技艺应保留同一实体生产经验');
  assert.equal(durableExperience.basisKey, uncertainty.basisKey);
  assert.ok(buildProjectPressureBasis(state, actor, subject, 3).pressure >= 42,
    '本人技艺中的来源仍须通过人物、实体与生产事实复核后形成压力');
  const retainedKnowledge = structuredClone(actor.knowledge);
  const productionIds = new Set([firstPlank.id, stoneTool.id, secondPlank.id]);
  actor.knowledge = actor.knowledge.map((fact) => fact.kind === 'technique' ? {
    ...fact,
    sourceEventIds: fact.sourceEventIds.filter((eventId) => !productionIds.has(eventId)),
  } : fact);
  assert.equal(measurementUncertaintyBasisFor(state, actor, 3), null,
    '短期情节与本人技艺来源都不存在时不能只凭历史 ID 硬造测量需求');
  assert.equal(buildProjectPressureBasis(state, actor, subject, 3).pressure, 0);
  actor.knowledge = retainedKnowledge;
  actor.memories = remembered;

  const proposals = deriveProjectProposals(state, actor, [actor.position.cellId], [], []);
  const proposal = proposals.find((candidate) => candidate.desiredFunction === 'comparable-mass-measurement');
  assert.ok(proposal, '自然项目提案必须来自本地粗感知与个人记忆');
  assert.equal(proposal.measurementUncertaintyBasis.basisKey, uncertainty.basisKey);
  assert.equal(proposal.triggerFactIds.includes(firstPlank.id), true);

  const activeLeaseProject = instantiateProject(proposal);
  const preProjectLedger = [...state.world.past];
  const projectionFor = (projects, ledger) => {
    const shell = structuredClone(state);
    shell.projects = structuredClone(projects);
    shell.world.past = [];
    shell.world.historyCursor = {
      version: 1,
      eventCount: ledger.length,
      hotStartIndex: ledger.length,
      tailEventId: ledger.at(-1)?.id ?? null,
    };
    const fold = beginHistoryRetentionProjection(shell, { stateHash: 'a'.repeat(64) });
    foldHistoryRetentionSegment(fold, ledger, 0);
    return finishHistoryRetentionProjection(fold);
  };
  const activeRetention = projectionFor([activeLeaseProject], preProjectLedger);
  const activeBasisLease = activeRetention.demandGroups.find((group) => (
    group.groupKey === `active-measurement-project:${activeLeaseProject.id}:uncertainty-basis`
  ));
  assert.ok(activeBasisLease?.satisfied, 'active project 必须为全部个人不确定性来源续租');
  assert.deepEqual(new Set(activeBasisLease.resolvedEventIds), new Set(uncertainty.sourceFactIds));

  const project = instantiateProject(proposal);
  state.projects = [project];
  const request = { operation: 'combine-inventory', questionKind: 'assemble-balanced-suspension' };
  assert.equal(actor.knowledge.some((fact) => (
    fact.id === inventoryCombinationTechniqueId(inventoryCombinationForOutput(Material.BeamBalance))
  )), false, '首次装置试验前不得预置天平配方知识');
  const campaign = refreshProjectHypothesisCampaign(
    state.seed,
    3,
    actor,
    project,
    [],
    request,
  );
  assert.equal(campaign.budget, PROJECT_HYPOTHESIS_ATTEMPT_BUDGET);
  assert.equal(campaign.responseBudget, PROJECT_HYPOTHESIS_RESPONSE_BUDGET);
  assert.equal(campaign.budget, 7);
  assert.equal(campaign.responseBudget, 3);
  const tripleKey = projectHypothesisCandidateKey(
    'combine-inventory',
    [Material.Plank, Material.Rope],
    undefined,
    [Material.Plank, Material.Plank, Material.Rope],
  );
  const tripleCandidate = campaign.candidates.find((candidate) => candidate.key === tripleKey);
  assert.ok(tripleCandidate, '有限试验必须能对称地产生三件局部组合，而不是暗读装置配方');
  assert.deepEqual(tripleCandidate.inventoryMaterialIds, [Material.Plank, Material.Plank, Material.Rope]);
  assert.equal(tripleCandidate.reasonKeys.includes('bounded-observable-quantity-variation'), true);
  assert.equal(tripleCandidate.reasonKeys.includes('project-material-focus'), false,
    '装置真实配方不得获得项目目标加分');
  assert.equal(tripleCandidate.reasonKeys.includes('role-symmetric-rigid-members'), true,
    '比较困境只能以可感知的对称刚性构件角色聚焦试验');
  assert.equal('expectedOutputMaterialId' in tripleCandidate, false);

  // Leave only one held plank while another locally visible entity exists.
  // The natural compiler must preserve the exact three-slot quantity instead
  // of treating the candidate as an already satisfied two-material pair.
  plankStack.quantity = 1;
  state.world.drops.push({
    id: 'measurement-visible-second-plank',
    materialId: Material.Plank,
    quantity: 1,
    cellId: actor.position.cellId,
    z: actor.position.z,
    sourceEventIds: [...plankStack.sourceEventIds],
    createdAtMonth: 3,
  });
  const visibleMeasurementDrops = () => state.world.drops.filter((drop) => (
    drop.id === 'measurement-visible-second-plank' && drop.quantity > 0
  ));
  const collectionStep = compileProjectStep(state, actor, visibleMeasurementDrops(), project);
  assert.equal(collectionStep?.action.kind, 'transfer');
  assert.equal(collectionStep?.missingMaterialIds.includes(Material.Plank), true);
  const plankDemand = collectionStep?.materialDemands?.find((demand) => demand.materialId === Material.Plank);
  assert.deepEqual(
    plankDemand && [plankDemand.requiredQuantity, plankDemand.availableQuantity, plankDemand.outstandingQuantity],
    [2, 1, 1],
    '三槽候选必须补一块真实木板，而不是把 Plank+Rope 二元集合当作数量账本',
  );
  const commitProjectFact = (step, orderInMonth) => {
    const fact = execute(step.action, 3, orderInMonth);
    assert.equal(fact.status, 'completed', fact.result);
    appendCommittedEvents(state, [fact]);
    recordProjectAction(state, project.id, fact);
    return { step, fact };
  };
  commitProjectFact(collectionStep, 1);
  const tripleStep = compileProjectStep(state, actor, visibleMeasurementDrops(), project);
  assert.equal(tripleStep?.action.kind, 'act');
  assert.equal(tripleStep?.action.operation, 'combine');
  assert.equal(tripleStep?.action.targets.length, 3,
    '补齐实体后，自然编译必须执行三实体结构试验');
  const balance = commitProjectFact(tripleStep, 2);
  assert.equal(balance.fact.diff.outputMaterialId, Material.BeamBalance,
    '无预置配方的三实体盲试验必须由真实物理规则首次产生天平');
  const balanceRule = inventoryCombinationForOutput(Material.BeamBalance);
  assert.ok(balanceRule);
  const balanceKnowledgeId = inventoryCombinationTechniqueId(balanceRule);
  const tentativeBalanceKnowledge = actor.knowledge.find((fact) => fact.id === balanceKnowledgeId);
  assert.ok(tentativeBalanceKnowledge);
  assert.equal(tentativeBalanceKnowledge.confidence, 46,
    '首次物理响应只能留下待本人观察核验的暂定 technique knowledge');
  assert.equal(tentativeBalanceKnowledge.sourceEventIds.includes(balance.fact.id), true);
  assert.equal(project.hypothesisCampaign.attempts.some((attempt) => (
    attempt.eventId === balance.fact.id
      && attempt.candidateKey === tripleCandidate.key
      && attempt.outcome === 'response'
      && attempt.techniqueId === balanceKnowledgeId
  )), true, '盲试验的真实响应必须回写有限 hypothesis campaign');

  const balanceVerificationStep = compileProjectStep(state, actor, [], project);
  assert.equal(balanceVerificationStep?.key, `verify-response-${balance.fact.id}`,
    '真实响应必须先观察同一来源实体，不能直接把隐藏配方变成可靠知识');
  const balanceVerification = commitProjectFact(balanceVerificationStep, 3);
  assert.equal(balanceVerification.fact.diff.verifiedSourceEventId, balance.fact.id);
  assert.ok(actor.knowledge.find((fact) => fact.id === balanceKnowledgeId)?.confidence >= 55,
    '本人观察真实产物后才把首次发现提升为可靠 technique knowledge');

  project.hypothesisCampaign.activeCandidateKey = tripleCandidate.key;
  const referenceCampaign = refreshProjectHypothesisCampaign(
    state.seed,
    3,
    actor,
    project,
    [],
    { operation: 'combine-inventory', questionKind: 'shape-repeatable-reference' },
  );
  assert.equal(referenceCampaign.activeCandidateKey, undefined,
    '项目问题切换后不得继续执行旧的对称悬挂候选');
  const attemptedCandidateKeys = new Set(referenceCampaign.attempts.map((attempt) => attempt.candidateKey));
  const firstUnpreservedCombineCandidate = referenceCampaign.candidates.find((candidate) => (
    candidate.operation === 'combine-inventory' && !attemptedCandidateKeys.has(candidate.key)
  ));
  assert.equal(firstUnpreservedCombineCandidate?.questionKind, 'shape-repeatable-reference',
    '保留审计候选之后，应先存储当前问题候选，避免被旧问题挤出有界槽位');

  const commitProjectStep = (expectedKeyPrefix, orderInMonth) => {
    const step = compileProjectStep(state, actor, visibleMeasurementDrops(), project);
    assert.ok(step, `项目步骤缺失: ${expectedKeyPrefix}`);
    assert.equal(step.key.startsWith(expectedKeyPrefix), true, step.key);
    return commitProjectFact(step, orderInMonth);
  };

  const reference = commitProjectStep('hypothesis-', 4);
  assert.equal(reference.fact.diff.outputMaterialId, Material.StandardWeight,
    '硬质金属体与柔性标记只能形成可观察功能假设，真实规则仍决定是否产出参考物');
  const referenceRule = inventoryCombinationForOutput(Material.StandardWeight);
  assert.ok(referenceRule);
  const referenceKnowledgeId = inventoryCombinationTechniqueId(referenceRule);
  assert.equal(actor.knowledge.find((fact) => fact.id === referenceKnowledgeId)?.confidence, 46);
  const referenceVerification = commitProjectStep(`verify-response-${reference.fact.id}`, 5);
  assert.equal(referenceVerification.fact.diff.verifiedSourceEventId, reference.fact.id);
  assert.ok(actor.knowledge.find((fact) => fact.id === referenceKnowledgeId)?.confidence >= 55);
  const calibration = commitProjectStep('calibrate-project-mass-instrument-', 6);
  const measurement = commitProjectStep('measure-project-mass-subject-', 7);
  assert.equal(project.status, 'completed');
  assert.equal(measurement.fact.diff.receiptKind, 'mass-measurement');
  assert.equal(measurement.fact.diff.calibrationEventId, calibration.fact.id);
  assert.equal(measurement.fact.diff.interval.upperInclusive - measurement.fact.diff.interval.lowerInclusive, 0.5);
  assert.equal(project.completionEventIds.includes(balance.fact.id), true);
  assert.equal(project.completionEventIds.includes(reference.fact.id), true);
  assert.equal(project.completionEventIds.includes(calibration.fact.id), true);
  assert.equal(project.completionEventIds.includes(measurement.fact.id), true);

  const reversedState = structuredClone(state);
  const reversedCalibration = reversedState.world.past.find((event) => event.id === calibration.fact.id);
  const reversedMeasurement = reversedState.world.past.find((event) => event.id === measurement.fact.id);
  assert.ok(reversedCalibration && reversedMeasurement);
  reversedCalibration.atMonth = reversedMeasurement.atMonth;
  reversedCalibration.orderInMonth = reversedMeasurement.orderInMonth + 1;
  const reversedProject = reversedState.projects.find((candidate) => candidate.id === project.id);
  assert.ok(reversedProject);
  assert.deepEqual(massMeasurementProjectCompletionEvidence(reversedState, reversedProject), [],
    '同月未来校准倒挂在测量之后时，typed receipt 也不能完成项目');

  const completedLedger = [...state.world.past];
  const completedRetention = projectionFor([project], completedLedger);
  const receiptLease = completedRetention.demandGroups.find((group) => (
    group.groupKey === `completed-measurement-project:${project.id}:receipt-chain`
  ));
  assert.ok(receiptLease?.satisfied, '完成后必须保留一条有界社会级测量 receipt 链');
  for (const eventId of [
    firstPlank.id,
    stoneTool.id,
    secondPlank.id,
    balance.fact.id,
    reference.fact.id,
    calibration.fact.id,
    measurement.fact.id,
  ]) assert.equal(receiptLease.resolvedEventIds.includes(eventId), true, `冷历史租约缺少 ${eventId}`);

  console.log(JSON.stringify({
    ok: true,
    pressure: pressure.pressure,
    hypothesisBudget: campaign.budget,
    responseBudget: campaign.responseBudget,
    tripleCandidateKey: tripleCandidate.key,
    completionEvidenceCount: project.completionEventIds.length,
    activeLeaseEvents: activeBasisLease.resolvedEventIds.length,
    completedLeaseEvents: receiptLease.resolvedEventIds.length,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
