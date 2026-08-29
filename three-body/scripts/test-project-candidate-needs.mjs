import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-project-candidate-needs-test-'));
const bundlePath = path.join(temporaryDirectory, 'project-candidate-needs.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { deriveNeedAgenda } from ${JSON.stringify(path.resolve('src/game/eland/application/cognition/need-agenda.ts'))};
    export { evaluateCognitiveOption } from ${JSON.stringify(path.resolve('src/game/eland/application/cognition/option-appraisal.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.resolve('src/game/eland/domain/project.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
  `;
  execFileSync(
    process.env.ELAND_ESBUILD ?? path.resolve('node_modules/.bin/esbuild'),
    [
      '--bundle', '--platform=node', '--format=esm', '--loader=ts',
      '--sourcefile=project-candidate-needs-test-entry.ts', `--outfile=${bundlePath}`,
    ],
    { input: entry, stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const {
    createInitialState,
    deriveNeedAgenda,
    evaluateCognitiveOption,
    instantiateProject,
    Material,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const atMonth = 24;
  const moment = { atMonth, planningTick: 7 };
  const state = createInitialState(26082901, {
    endpoint: { kind: 'months', value: 36 },
    chaosIntensity: 0,
  });
  const person = state.people[0];
  person.body = { health: 90, hydration: 90, nutrition: 90 };
  person.inventory = [
    { id: 'candidate-food', materialId: Material.Food, quantity: 8, sourceEventIds: [] },
    { id: 'candidate-water', materialId: Material.Water, quantity: 8, sourceEventIds: [] },
  ];

  function projectOption({
    id,
    kind = 'production',
    need,
    desiredFunction,
    pressure,
    sourceFactIds,
    beneficiaryIds,
    targetKnowledgeId,
  }) {
    const projectProposal = {
      id,
      kind,
      need,
      desiredFunction,
      summary: `推进 ${id}`,
      ownerId: person.id,
      beneficiaryIds,
      triggerFactIds: [...sourceFactIds],
      pressure,
      createdAtMonth: atMonth,
      reviewAtMonth: atMonth + 12,
      ...(targetKnowledgeId ? { targetKnowledgeId } : {}),
    };
    return {
      id: `project:${id}:executable-opening-step`,
      summary: projectProposal.summary,
      reason: '一个已由项目编译器证明可执行的局部步骤',
      goal: { kind: 'project-completed', projectId: id },
      nextAction: { kind: 'move', toCellId: person.position.cellId, toZ: person.position.z },
      estimatedDuration: 'long',
      sourceFactIds: [...sourceFactIds],
      domain: 'strategic',
      projectId: id,
      projectProposal,
      projectPressure: pressure,
    };
  }

  function contextFor(options) {
    return {
      state,
      person,
      visibleCells: [person.position.cellId],
      visiblePeople: [],
      visibleDrops: [],
      visibleAnimals: [],
      options,
      followUpOptions: [],
    };
  }

  const pressure100 = projectOption({
    id: 'project-pressure-100',
    need: 'production-efficiency',
    desiredFunction: 'efficient-production',
    pressure: 100,
    sourceFactIds: ['fact-pressure-100'],
    beneficiaryIds: [person.id],
  });
  state.projects.push(instantiateProject(pressure100.projectProposal));
  delete pressure100.projectProposal;
  const pressure88 = projectOption({
    id: 'project-pressure-88',
    need: 'mechanical-power-capability',
    desiredFunction: 'water-powered-crop-processing',
    pressure: 88,
    sourceFactIds: ['fact-pressure-88'],
    beneficiaryIds: [person.id, state.people[1].id],
  });
  const pairedContext = contextFor([pressure100, pressure88]);
  const pairedAgenda = deriveNeedAgenda(pairedContext, atMonth);
  const need100 = pairedAgenda.find((need) => need.projectId === pressure100.projectId);
  const need88 = pairedAgenda.find((need) => need.projectId === pressure88.projectId);

  assert.ok(need100, '压力 100 的可执行项目 continuation 必须形成自己的 scoped need');
  assert.ok(need88, '压力 88 的第二个可执行 project-start 也必须形成自己的 scoped need');
  assert.equal(need100.urgency, 100 / (100 + 45), '高压候选必须使用自己的 pressure');
  assert.equal(need88.urgency, 88 / (88 + 45), '低压候选必须使用自己的 pressure');
  assert.deepEqual(need100.sourceFactIds, ['fact-pressure-100'], '高压候选不得借用低压来源');
  assert.deepEqual(need88.sourceFactIds, ['fact-pressure-88'], '低压候选不得借用高压来源');

  const appraisal88 = evaluateCognitiveOption(pairedContext, pressure88, moment, pairedAgenda);
  assert.ok(appraisal88.addressedNeeds.some((need) => need.projectId === pressure88.projectId),
    '第二候选必须精确认领自己的 project-scoped need');
  assert.ok(appraisal88.needActivation > 0,
    '第二候选必须进入真实 BDI 竞争，但测试不要求它胜出');
  assert.equal(appraisal88.addressedNeeds.some((need) => need.projectId === pressure100.projectId), false,
    '第二候选不得认领第一候选的 need');

  const durableRecord = projectOption({
    id: 'project-durable-record',
    kind: 'inquiry',
    need: 'knowledge-preservation',
    desiredFunction: 'durable-record',
    pressure: 76,
    sourceFactIds: ['fact-durable-knowledge', 'fact-memory-disruption'],
    beneficiaryIds: [person.id, state.people[1].id],
    targetKnowledgeId: 'technique-durable-knowledge',
  });
  const durableContext = contextFor([durableRecord]);
  const durableAgenda = deriveNeedAgenda(durableContext, atMonth);
  const durableNeed = durableAgenda.find((need) => need.projectId === durableRecord.projectId);
  assert.equal(durableNeed?.kind, 'inquiry',
    'knowledge-preservation 项目的 scoped need 必须与 appraisal 的 inquiry 映射一致');
  assert.deepEqual(durableNeed?.sourceFactIds, ['fact-durable-knowledge', 'fact-memory-disruption'],
    'durable-record need 必须只携带候选自身来源');
  const durableAppraisal = evaluateCognitiveOption(durableContext, durableRecord, moment, durableAgenda);
  assert.ok(durableAppraisal.addressedNeeds.some((need) => (
    need.projectId === durableRecord.projectId && need.kind === 'inquiry'
  )), 'durable-record 候选必须精确认领自己的 inquiry need');
  assert.ok(durableAppraisal.needActivation > 0,
    'durable-record 候选必须进入真实 BDI 竞争');

  const singleAgenda = deriveNeedAgenda(contextFor([pressure88]), atMonth);
  const singleScopedNeeds = singleAgenda.filter((need) => need.projectId);
  assert.equal(singleScopedNeeds.length, 1, '单项目候选仍只产生一个 scoped need');
  assert.equal(singleScopedNeeds[0].projectId, pressure88.projectId);
  assert.equal(singleScopedNeeds[0].urgency, 88 / (88 + 45));
  assert.deepEqual(singleScopedNeeds[0].sourceFactIds, ['fact-pressure-88']);

  const duplicateOption = {
    ...structuredClone(pressure88),
    id: `${pressure88.id}:duplicate`,
    sourceFactIds: ['fact-duplicate-must-not-create-another-need'],
  };
  const deduplicatedAgenda = deriveNeedAgenda(contextFor([pressure88, duplicateOption]), atMonth);
  assert.equal(deduplicatedAgenda.filter((need) => need.projectId === pressure88.projectId).length, 1,
    '同一 projectId 的多个可执行步骤不得复制项目 need');
  assert.deepEqual(
    deduplicatedAgenda.find((need) => need.projectId === pressure88.projectId)?.sourceFactIds,
    ['fact-pressure-88'],
    '去重必须保留稳定排序中的首个候选 basis',
  );

  const noProjectOption = {
    id: 'ordinary-non-project-option',
    summary: '留在当前位置观察',
    reason: '普通非项目候选',
    goal: { kind: 'at-cell', cellId: person.position.cellId },
    nextAction: { kind: 'move', toCellId: person.position.cellId, toZ: person.position.z },
    estimatedDuration: 'one-month',
    sourceFactIds: ['ordinary-source'],
  };
  const noProjectAgenda = deriveNeedAgenda(contextFor([noProjectOption]), atMonth);
  assert.equal(noProjectAgenda.some((need) => need.projectId), false,
    '没有项目候选时不得凭空产生 project-scoped need');

  console.log('project candidate scoped need tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
