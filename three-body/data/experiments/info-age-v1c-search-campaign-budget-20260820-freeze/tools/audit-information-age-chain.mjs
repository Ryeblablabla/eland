import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { openSqliteRunReader } from './sqlite-run-reader.mjs';

const OBSERVER_VERSION = 'information-age-chain-audit-v2';
const RELIABLE_CONFIDENCE = 55;
const MATERIAL_KEYS = ['processed-wood', 'masonry-stone', 'bronze', 'iron'];

/*
 * These are causal fact contracts, not unlock conditions. The current state
 * schema has no versioned detector for any of them, so the audit reports them
 * as unsupported instead of guessing from era labels, building names or CI.
 */
const INFORMATION_AGE_GATES = [
  {
    id: 'continuous-electrical-energy',
    label: '连续可调度电能',
    requiredFacts: [
      '可回放的一次能源→转换→输电→负载闭环',
      '负载在多个时间步中实际消耗电能并完成世界内行动',
      '供电中断会产生可观察的失效后果',
    ],
  },
  {
    id: 'controlled-machine-production',
    label: '受控机器生产',
    requiredFacts: [
      '可追溯到材料、工具、能源和操作者的机器生产行动',
      '机器产出的速率或精度显著不同于手工行动',
      '故障、维修与零件替换均是世界内事实',
    ],
  },
  {
    id: 'cross-site-signal-network',
    label: '跨地点信号网络',
    requiredFacts: [
      '发信、编码、传输、收信与解码是不同的可回放事实',
      '信息在不同位置之间无需携带者移动而传达',
      '距离、带宽、延迟、丢包或中继至少一项会改变结果',
    ],
  },
  {
    id: 'replicable-machine-readable-records',
    label: '可复制的机读记录',
    requiredFacts: [
      '记录具有可寻址载体、编码规则和可验证内容',
      '复制产生新载体并保留或可检出内容差异',
      '机器或工具实际读取它并因数据改变行动',
    ],
  },
  {
    id: 'world-internal-algorithm-execution',
    label: '世界内算法执行',
    requiredFacts: [
      '算法以世界内程序或可机械执行指令存在',
      '同一输入可重复得到同一输出或明确的错误',
      '计算结果被人物或设施用于后续决策与行动',
    ],
  },
  {
    id: 'independent-research-replication',
    label: '独立研究复现',
    requiredFacts: [
      '原研究者留下问题、方法、数据和结论记录',
      '独立人员从记录获取方法并重新执行试验',
      '复现结果反过来更新知识置信度或方法',
    ],
  },
  {
    id: 'typed-network-and-standards-institutions',
    label: '网络与标准制度',
    requiredFacts: [
      '标准、网络运维、记录管理或研究协作是由反复实践观察出的明确制度',
      '制度证据引用具体行动与参与者',
      '违反或缺少标准会造成可观察的互操作失败',
    ],
  },
  {
    id: 'social-adoption-and-replacement-resilience',
    label: '社会采用与代际替补',
    requiredFacts: [
      '信息系统被多人、多项目或多地点反复使用而非一次性展示',
      '关键操作者死亡或离开后仍由他人继续运作',
      '新一代实际重复执行所学技术并留下新证据',
    ],
  },
];

const asArray = (value) => Array.isArray(value) ? value : [];
const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const stringValue = (value) => typeof value === 'string' && value.length > 0 ? value : null;
const finiteValue = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const integerValue = (value) => Number.isInteger(value) ? value : null;
const unique = (values) => [...new Set(values)].sort();

function numericSummary(values) {
  const usable = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!usable.length) return { count: 0, min: null, median: null, mean: null, max: null };
  const middle = Math.floor(usable.length / 2);
  const median = usable.length % 2
    ? usable[middle]
    : (usable[middle - 1] + usable[middle]) / 2;
  return {
    count: usable.length,
    min: usable[0],
    median: Math.round(median * 100) / 100,
    mean: Math.round(usable.reduce((sum, value) => sum + value, 0) / usable.length * 100) / 100,
    max: usable[usable.length - 1],
  };
}

function countBy(values) {
  return Object.fromEntries([...values.reduce((counts, value) => {
    const key = String(value ?? 'unknown');
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map())].sort(([left], [right]) => left.localeCompare(right)));
}

function eventOrder(left, right) {
  return (finiteValue(left.event.atMonth) ?? 0) - (finiteValue(right.event.atMonth) ?? 0)
    || (finiteValue(left.event.orderInMonth) ?? 0) - (finiteValue(right.event.orderInMonth) ?? 0)
    || (finiteValue(left.event.planningTick) ?? 0) - (finiteValue(right.event.planningTick) ?? 0)
    || (finiteValue(left.event.orderInTick) ?? 0) - (finiteValue(right.event.orderInTick) ?? 0)
    || left.index - right.index;
}

function auditDirectTeaching(state, matrixRun) {
  const people = asArray(state.people);
  const events = asArray(state.world?.past);
  const personById = new Map(people.flatMap((person) => stringValue(person.id) ? [[person.id, person]] : []));
  const teachingByChain = new Map();
  const reproductionsByLearnerTechnique = new Map();
  let completedDirectTeachingEvents = 0;

  for (const [index, event] of events.entries()) {
    const action = asObject(event.action);
    const content = asObject(action?.content);
    const diff = asObject(event.diff) ?? {};
    const teacherId = stringValue(event.who);
    const reproducedTechniqueId = stringValue(diff.techniqueId);
    if (event.kind === 'action' && event.status === 'completed' && teacherId && reproducedTechniqueId) {
      const key = `${teacherId}\u0000${reproducedTechniqueId}`;
      const matches = reproductionsByLearnerTechnique.get(key) ?? [];
      matches.push({ event, index });
      reproductionsByLearnerTechnique.set(key, matches);
    }
    const techniqueId = stringValue(diff.teachingFactId) ?? stringValue(content?.factId);
    if (event.kind !== 'action'
      || event.status !== 'completed'
      || action?.kind !== 'communicate'
      || content?.kind !== 'claim'
      || !stringValue(content.id)?.startsWith('teach:')
      || !techniqueId?.startsWith('technique:')
      || !teacherId) continue;
    completedDirectTeachingEvents += 1;
    for (const learnerId of unique(asArray(diff.taughtAudienceIds).filter(stringValue))) {
      const key = `${teacherId}\u0000${learnerId}\u0000${techniqueId}`;
      const previous = teachingByChain.get(key);
      const entry = { key, teacherId, learnerId, techniqueId, event, index };
      if (!previous || eventOrder(entry, previous) < 0) teachingByChain.set(key, entry);
    }
  }
  for (const matches of reproductionsByLearnerTechnique.values()) matches.sort(eventOrder);

  const generationGtZeroChains = [];
  const postTeacherDeathChains = [];
  for (const teaching of teachingByChain.values()) {
    const learner = personById.get(teaching.learnerId);
    if ((integerValue(learner?.generation) ?? 0) <= 0) continue;
    const candidates = reproductionsByLearnerTechnique.get(`${teaching.learnerId}\u0000${teaching.techniqueId}`) ?? [];
    let low = 0;
    let high = candidates.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (eventOrder(candidates[middle], teaching) <= 0) low = middle + 1;
      else high = middle;
    }
    const later = candidates[low];
    if (!later) continue;
    const chain = {
      teacherId: teaching.teacherId,
      learnerId: teaching.learnerId,
      learnerGeneration: learner.generation,
      techniqueId: teaching.techniqueId,
      teachingEventId: stringValue(teaching.event.id),
      reproductionEventId: stringValue(later.event.id),
      teachingAtMonth: integerValue(teaching.event.atMonth),
      reproductionAtMonth: integerValue(later.event.atMonth),
    };
    generationGtZeroChains.push(chain);
    const teacherDeath = integerValue(personById.get(teaching.teacherId)?.diedAtMonth);
    if (teacherDeath !== null && (integerValue(later.event.atMonth) ?? -Infinity) > teacherDeath) {
      postTeacherDeathChains.push({ ...chain, teacherDiedAtMonth: teacherDeath });
    }
  }

  return {
    definition: '完成的直接 technique 教导→同一 generation>0 学习者之后完成 diff.techniqueId 相同的行动',
    completedDirectTeachingEvents,
    uniqueDirectTeachingLearnerChains: teachingByChain.size,
    directTeachingReproductionChains: generationGtZeroChains.length,
    reproductionLearners: unique(generationGtZeroChains.map((chain) => chain.learnerId)).length,
    reproducedTechniques: unique(generationGtZeroChains.map((chain) => chain.techniqueId)).length,
    postTeacherDeathContinuationChains: postTeacherDeathChains.length,
    postTeacherDeathContinuationLearners: unique(postTeacherDeathChains.map((chain) => chain.learnerId)).length,
    postTeacherDeathContinuationTechniques: unique(postTeacherDeathChains.map((chain) => chain.techniqueId)).length,
    evidence: generationGtZeroChains.slice(0, 12),
    postTeacherDeathEvidence: postTeacherDeathChains.slice(0, 12),
    legacyDemoImitationMetric: {
      completeTechniqueLearningChains: finiteValue(matrixRun.completeTechniqueLearningChains),
      source: 'input-matrix',
      semantic: '仅统计需求绑定的 demonstration→imitation 旧链；不包含直接教导链',
    },
  };
}

function auditRecordUse(state) {
  const intents = asArray(state.intents);
  const people = asArray(state.people);
  const projects = asArray(state.projects);
  const payloads = asArray(state.records);
  const events = asArray(state.world?.past);
  const intentById = new Map(intents.flatMap((item) => stringValue(item.id) ? [[item.id, item]] : []));
  const projectById = new Map(projects.flatMap((item) => stringValue(item.id) ? [[item.id, item]] : []));
  const personById = new Map(people.flatMap((item) => stringValue(item.id) ? [[item.id, item]] : []));
  const payloadById = new Map(payloads.flatMap((item) => stringValue(item.id) ? [[item.id, item]] : []));
  const violations = {
    missingBasisKey: new Set(), unresolvedProject: new Set(), projectMismatch: new Set(),
    readerMismatch: new Set(), techniqueMismatch: new Set(), acquisitionSourceMismatch: new Set(),
    authorMismatch: new Set(), payloadMismatch: new Set(), codebookMismatch: new Set(),
    readUnderstanding: new Set(), readReliability: new Set(), experimentOutput: new Set(),
    experimentConfidence: new Set(), unresolvedProgressEvent: new Set(),
  };
  const markerFields = [
    'recordUseBasisKey', 'recordUseStage', 'recordUseProjectId', 'recordUseRecordId',
    'recordUseKnowledgeId', 'recordUseReaderId', 'recordUseCarrierSourceKind',
    'recordUseCarrierSourceId', 'recordUseAcquisitionRequired',
  ];
  const actions = [];

  for (const [index, event] of events.entries()) {
    if (event.kind !== 'action') continue;
    const diff = asObject(event.diff) ?? {};
    const intent = intentById.get(stringValue(event.intentId));
    const basis = asObject(intent?.recordUseBasis);
    const action = asObject(event.action);
    let stage = ['share', 'acquire', 'read', 'experiment'].includes(diff.recordUseStage)
      ? diff.recordUseStage
      : null;
    if (!stage && basis?.version === 'record-use-basis-v1') {
      if (intent?.recordUseStage === 'share' && action?.kind === 'transfer') stage = 'share';
      if (intent?.recordUseStage === 'read-experiment' && action?.kind === 'attend') stage = 'read';
      if (intent?.recordUseStage === 'read-experiment' && action?.kind === 'act') stage = 'experiment';
    }
    if (!stage && !markerFields.some((field) => Object.hasOwn(diff, field))) continue;

    const id = stringValue(event.id) ?? `#${index}`;
    const basisKey = stringValue(diff.recordUseBasisKey);
    const projectId = stringValue(diff.recordUseProjectId);
    const knowledgeId = stringValue(diff.recordUseKnowledgeId);
    const readerId = stringValue(diff.recordUseReaderId);
    const recordId = stringValue(diff.recordUseRecordId);
    const payload = payloadById.get(recordId);
    const reader = personById.get(readerId);
    if (!basisKey) violations.missingBasisKey.add(id);
    if (!projectId || !projectById.has(projectId)) violations.unresolvedProject.add(projectId ?? `missing:${id}`);
    if ((basis && projectId !== stringValue(basis.projectId))
      || (stringValue(intent?.projectId) && projectId !== intent.projectId)) violations.projectMismatch.add(id);
    if ((basis && readerId !== stringValue(basis.readerId))
      || !reader
      || (['acquire', 'read', 'experiment'].includes(stage) && event.who !== readerId)) {
      violations.readerMismatch.add(id);
    }
    if ((basis && knowledgeId !== stringValue(basis.knowledgeId))
      || (basis && stringValue(diff.recordUseTechniqueId) !== stringValue(basis.techniqueId))) {
      violations.techniqueMismatch.add(id);
    }
    if (!payload
      || payload.kind !== 'technique'
      || stringValue(payload.knowledgeId) !== knowledgeId
      || (basis && stringValue(payload.codebookId) !== stringValue(basis.codebookId))) {
      violations.payloadMismatch.add(id);
    }
    const payloadAuthorId = stringValue(payload?.authorId);
    const basisAuthorId = stringValue(basis?.recordAuthorId);
    if (!readerId || !payloadAuthorId || readerId === payloadAuthorId
      || (basisAuthorId && basisAuthorId !== payloadAuthorId)) violations.authorMismatch.add(id);
    const codebookId = stringValue(basis?.codebookId) ?? stringValue(payload?.codebookId);
    if (!codebookId || !asArray(reader?.knowledge).some((fact) => (
      fact.id === codebookId && fact.kind === 'codebook' && (finiteValue(fact.confidence) ?? -Infinity) >= RELIABLE_CONFIDENCE
    ))) violations.codebookMismatch.add(id);

    const acquisitionRequired = basis?.acquisitionRequired === true;
    if (stage === 'acquire') {
      const carrier = asObject(basis?.carrierSource);
      const from = asObject(action?.from);
      const to = asObject(action?.to);
      if (basis?.version !== 'record-use-basis-v2'
        || !acquisitionRequired
        || carrier?.kind !== 'ground'
        || action?.kind !== 'transfer'
        || from?.kind !== 'ground'
        || to?.kind !== 'person'
        || action.dropId !== carrier.dropId
        || from.cellId !== carrier.cellId
        || from.z !== carrier.z
        || to.personId !== readerId
        || diff.recordUseCarrierSourceKind !== 'ground'
        || diff.recordUseCarrierSourceId !== carrier.dropId
        || diff.recordUseCarrierSourceCellId !== carrier.cellId
        || diff.recordUseCarrierSourceZ !== carrier.z
        || diff.recordUseAcquisitionRequired !== true
        || diff.recordPayloadId !== recordId
        || event.status !== 'completed') violations.acquisitionSourceMismatch.add(id);
    }
    if (stage === 'read' && event.status === 'completed') {
      if (diff.understood !== true) violations.readUnderstanding.add(id);
      if ((finiteValue(diff.recordUseKnowledgeConfidenceAfter) ?? Infinity) > 54) violations.readReliability.add(id);
    }
    if (stage === 'experiment' && event.status === 'completed') {
      const expected = finiteValue(basis?.expectedOutputMaterialId)
        ?? finiteValue(diff.recordUseExpectedOutputMaterialId);
      if (expected === null || diff.outputMaterialId !== expected) violations.experimentOutput.add(id);
      const before = finiteValue(diff.recordUseKnowledgeConfidenceBefore);
      const after = finiteValue(diff.recordUseKnowledgeConfidenceAfter);
      if (before === null || after === null || before >= RELIABLE_CONFIDENCE
        || after - before !== 18 || after < RELIABLE_CONFIDENCE) violations.experimentConfidence.add(id);
    }
    actions.push({ id, event, index, stage, basisKey, projectId, completed: event.status === 'completed', acquisitionRequired });
  }

  actions.sort(eventOrder);
  const passesCommon = (entry) => Boolean(entry.basisKey
    && entry.projectId
    && projectById.has(entry.projectId)
    && !violations.projectMismatch.has(entry.id)
    && !violations.readerMismatch.has(entry.id)
    && !violations.techniqueMismatch.has(entry.id)
    && !violations.authorMismatch.has(entry.id)
    && !violations.payloadMismatch.has(entry.id)
    && !violations.codebookMismatch.has(entry.id));
  const acquired = new Set();
  const read = new Set();
  const validExperimentEvents = new Set();
  let readsWithoutAcquisition = 0;
  let experimentsWithoutRead = 0;
  for (const entry of actions) {
    if (entry.stage === 'acquire' && entry.completed && passesCommon(entry)
      && !violations.acquisitionSourceMismatch.has(entry.id)) acquired.add(entry.basisKey);
    if (entry.stage === 'read' && entry.completed && passesCommon(entry)
      && !violations.readUnderstanding.has(entry.id) && !violations.readReliability.has(entry.id)) {
      if (entry.acquisitionRequired && !acquired.has(entry.basisKey)) readsWithoutAcquisition += 1;
      else read.add(entry.basisKey);
    }
    if (entry.stage === 'experiment') {
      if (!entry.basisKey || !read.has(entry.basisKey)) experimentsWithoutRead += 1;
      else if (entry.completed && passesCommon(entry)
        && !violations.experimentOutput.has(entry.id)
        && !violations.experimentConfidence.has(entry.id)) validExperimentEvents.add(entry.id);
    }
  }

  const actionById = new Map(actions.map((entry) => [entry.id, entry]));
  const relevantProjectIds = new Set(actions.flatMap((entry) => entry.projectId ? [entry.projectId] : []));
  const projectProgressEvents = new Set();
  const completeBases = new Set();
  for (const project of projects) {
    if (!relevantProjectIds.has(project.id)) continue;
    for (const evidence of asArray(project.progressEvidence)) {
      const eventId = stringValue(evidence.eventId);
      const entry = actionById.get(eventId);
      if (!eventId || !entry) {
        if (eventId) violations.unresolvedProgressEvent.add(eventId);
        continue;
      }
      if (entry.stage !== 'experiment') continue;
      if (entry.projectId !== project.id) {
        violations.projectMismatch.add(entry.id);
        continue;
      }
      if (entry.completed) projectProgressEvents.add(entry.id);
      if (entry.completed && validExperimentEvents.has(entry.id) && entry.basisKey) completeBases.add(entry.basisKey);
    }
  }

  return {
    observerSemantics: 'validated acquire→read→experiment→project-progress chain reconstructed from terminal replay facts',
    shares: actions.filter((entry) => entry.stage === 'share').length,
    acquisitions: actions.filter((entry) => entry.stage === 'acquire').length,
    reads: actions.filter((entry) => entry.stage === 'read').length,
    experiments: actions.filter((entry) => entry.stage === 'experiment').length,
    completedExperiments: actions.filter((entry) => entry.stage === 'experiment' && entry.completed).length,
    projectProgresses: projectProgressEvents.size,
    completeChains: completeBases.size,
    uniqueBases: unique(actions.flatMap((entry) => entry.basisKey ? [entry.basisKey] : [])).length,
    readsWithoutAcquisition,
    experimentsWithoutRead,
    violations: Object.fromEntries(Object.entries(violations).map(([key, values]) => [key, values.size])),
  };
}

function auditMaterialCapabilities(state) {
  const development = asObject(state.civilization?.development);
  const observations = new Map(asArray(development?.materialCapabilities).flatMap((item) => (
    stringValue(item.key) ? [[item.key, item]] : []
  )));
  return Object.fromEntries(MATERIAL_KEYS.map((key) => {
    const item = observations.get(key);
    return [key, item ? {
      supported: true,
      stage: stringValue(item.stage),
      successfulBatches: asArray(item.successfulBatchEventIds).length,
      failedBatches: asArray(item.failedBatchEventIds).length,
      producers: unique(asArray(item.producerIds).filter(stringValue)).length,
      adoptedActions: asArray(item.adoptedActionEventIds).length,
      productionSiteMaterialIds: unique(asArray(item.productionSiteMaterialIds).filter(Number.isInteger)),
      supportingInstitutionKeys: unique(asArray(item.supportingInstitutionKeys).filter(stringValue)),
    } : {
      supported: Boolean(development), stage: null, successfulBatches: 0, failedBatches: 0,
      producers: 0, adoptedActions: 0, productionSiteMaterialIds: [], supportingInstitutionKeys: [],
    }];
  }));
}

function auditFacilities(state) {
  const source = state.derived?.functionalBuildings;
  const buildings = asArray(source);
  const kinds = unique(buildings.map((item) => stringValue(item.kind)).filter(Boolean));
  return {
    supported: Array.isArray(source),
    total: buildings.length,
    active: buildings.filter((item) => item.active === true).length,
    used: buildings.filter((item) => asArray(item.useEventIds).length > 0).length,
    byKind: Object.fromEntries(kinds.map((kind) => {
      const matching = buildings.filter((item) => item.kind === kind);
      return [kind, {
        count: matching.length,
        active: matching.filter((item) => item.active === true).length,
        used: matching.filter((item) => asArray(item.useEventIds).length > 0).length,
        useEvents: matching.reduce((sum, item) => sum + asArray(item.useEventIds).length, 0),
        users: unique(matching.flatMap((item) => asArray(item.userIds).filter(stringValue))).length,
      }];
    })),
    sample: buildings.slice().sort((left, right) => String(left.id).localeCompare(String(right.id))).slice(0, 12).map((item) => ({
      id: stringValue(item.id), kind: stringValue(item.kind), materialId: integerValue(item.materialId),
      active: item.active === true, useEvents: asArray(item.useEventIds).length,
      users: unique(asArray(item.userIds).filter(stringValue)).length,
      installedAtMonth: integerValue(item.installedAtMonth),
    })),
  };
}

function auditInstitutions(state) {
  const source = state.derived?.institutions;
  const institutions = asArray(source);
  const familyOf = (key) => stringValue(key)?.split(':')[0] ?? 'unknown';
  return {
    supported: Array.isArray(source),
    total: institutions.length,
    byFamily: countBy(institutions.map((item) => familyOf(item.key))),
    observations: institutions.slice().sort((left, right) => String(left.key).localeCompare(String(right.key))).map((item) => ({
      key: stringValue(item.key), label: stringValue(item.label),
      evidenceCount: asArray(item.evidenceEventIds).length,
      evidenceEventIds: asArray(item.evidenceEventIds).filter(stringValue).slice(0, 8),
    })),
  };
}

function auditPopulationAndKnowledge(state, matrixRun) {
  const people = asArray(state.people);
  const alive = people.filter((person) => person.diedAtMonth === undefined && (finiteValue(person.body?.health) ?? 0) > 0);
  const generationValues = unique(people.map((person) => integerValue(person.generation)).filter((value) => value !== null));
  const facts = people.flatMap((person) => asArray(person.knowledge).map((fact) => ({ person, fact })));
  const reliable = facts.filter(({ fact }) => (finiteValue(fact.confidence) ?? -Infinity) >= RELIABLE_CONFIDENCE);
  const reliableTechniques = reliable.filter(({ fact }) => fact.kind === 'technique' && stringValue(fact.id));
  const techniqueHolders = new Map();
  for (const { person, fact } of reliableTechniques) {
    const holders = techniqueHolders.get(fact.id) ?? [];
    holders.push(person);
    techniqueHolders.set(fact.id, holders);
  }
  const crossGenerationTechniques = [...techniqueHolders].filter(([, holders]) => (
    unique(holders.map((person) => integerValue(person.generation)).filter((value) => value !== null)).length >= 2
  ));
  const transmission = auditDirectTeaching(state, matrixRun);
  return {
    population: {
      totalHistoricalPeople: people.length,
      living: alive.length,
      dead: people.length - alive.length,
      generationCount: generationValues.length,
      generations: generationValues,
      historicalByGeneration: Object.fromEntries(generationValues.map((generation) => [generation,
        people.filter((person) => person.generation === generation).length])),
      livingByGeneration: Object.fromEntries(generationValues.map((generation) => [generation,
        alive.filter((person) => person.generation === generation).length])),
    },
    knowledge: {
      factHoldings: facts.length,
      reliableFactHoldings: reliable.length,
      holdingsByKind: countBy(facts.map(({ fact }) => fact.kind)),
      reliableHoldingsByKind: countBy(reliable.map(({ fact }) => fact.kind)),
      uniqueReliableTechniques: techniqueHolders.size,
      reliableTechniquesHeldByMultiplePeople: [...techniqueHolders.values()].filter((holders) => unique(holders.map((person) => person.id)).length >= 2).length,
      crossGenerationReliableTechniques: crossGenerationTechniques.length,
      crossGenerationTechniqueIds: crossGenerationTechniques.map(([id]) => id).sort().slice(0, 24),
      generationGtZeroReliableTechniqueHolders: unique(reliableTechniques.flatMap(({ person }) => person.generation > 0 ? [person.id] : [])).length,
      directTeaching: transmission,
    },
  };
}

function auditRecords(state, matrixRun) {
  const payloads = asArray(state.records);
  const carriers = [];
  for (const person of asArray(state.people)) {
    for (const stack of asArray(person.inventory)) if (stringValue(stack.recordPayloadId)) {
      carriers.push({ payloadId: stack.recordPayloadId, holderKind: 'person', holderId: person.id });
    }
  }
  for (const drop of asArray(state.world?.drops)) if (stringValue(drop.recordPayloadId)) {
    carriers.push({ payloadId: drop.recordPayloadId, holderKind: 'ground', holderId: drop.id });
  }
  for (const container of asArray(state.containers)) {
    for (const stack of asArray(container.inventory)) if (stringValue(stack.recordPayloadId)) {
      carriers.push({ payloadId: stack.recordPayloadId, holderKind: 'container', holderId: container.id });
    }
  }
  const elapsed = finiteValue(state.clock?.elapsedMonths) ?? 0;
  const payloadsWithCarrier = new Set(carriers.map((carrier) => carrier.payloadId));
  const durablePayloads = payloads.filter((payload) => (
    payloadsWithCarrier.has(payload.id) && elapsed - (finiteValue(payload.createdAtMonth) ?? elapsed) >= 12
  ));
  const events = asArray(state.world?.past);
  const writes = events.filter((event) => event.kind === 'action'
    && event.status === 'completed'
    && event.action?.kind === 'communicate'
    && event.action?.channel === 'record'
    && stringValue(event.diff?.recordPayloadId));
  const explicitReads = events.filter((event) => event.kind === 'action'
    && event.status === 'completed'
    && event.action?.kind === 'attend'
    && stringValue(event.diff?.recordPayloadId)
    && event.diff?.understood === true);
  const chain = auditRecordUse(state);
  return {
    payloads: payloads.length,
    payloadsWithCurrentCarrier: payloadsWithCarrier.size,
    currentCarriers: carriers.length,
    carriersByHolderKind: countBy(carriers.map((carrier) => carrier.holderKind)),
    publicGroundCarriers: carriers.filter((carrier) => carrier.holderKind === 'ground').length,
    durablePayloadsAtLeastTwelveMonths: durablePayloads.length,
    completedRecordWrites: writes.length,
    completedUnderstoodReads: explicitReads.length,
    recordUseChain: chain,
    matrixMetricComparison: {
      completeRecordUseChains: finiteValue(matrixRun.completeRecordUseChains),
      terminalAuditCompleteChains: chain.completeChains,
      agrees: finiteValue(matrixRun.completeRecordUseChains) === null
        ? null
        : matrixRun.completeRecordUseChains === chain.completeChains,
    },
  };
}

function informationAgeGateAudit(state) {
  return INFORMATION_AGE_GATES.map((gate, index) => ({
    order: index + 1,
    id: gate.id,
    label: gate.label,
    supported: false,
    satisfied: false,
    status: 'unsupported',
    reasonCode: 'no-versioned-fact-detector',
    reason: `schema ${state.schemaVersion ?? 'unknown'} 没有该门槛的结构化领域事实与版本化观察器；不从名称、时代或文明指数推断`,
    requiredFacts: gate.requiredFacts,
    evidenceEventIds: [],
  }));
}

function auditDevelopment(state) {
  const development = asObject(state.civilization?.development);
  return {
    supported: Boolean(development),
    observerVersion: stringValue(development?.observerVersion),
    currentEra: stringValue(development?.currentEra),
    historicalPeakEra: stringValue(development?.historicalPeakEra),
    candidateEra: stringValue(development?.candidateEra),
    candidateSinceMonth: integerValue(development?.candidateSinceMonth),
    transitionProgress: finiteValue(development?.transitionProgress),
    satisfiedGates: asArray(development?.satisfiedGateIds).filter(stringValue),
    missingGates: asArray(development?.missingGateIds).filter(stringValue),
    supportingEventIds: asArray(development?.supportingEventIds).filter(stringValue),
    displayStageOnly: stringValue(state.civilization?.stage),
    displayStageIsNotUsedAsEvidence: true,
  };
}

function auditRun(matrixRun, persisted) {
  const state = persisted.state;
  const development = auditDevelopment(state);
  const gates = informationAgeGateAudit(state);
  const populationAndKnowledge = auditPopulationAndKnowledge(state, matrixRun);
  return {
    runId: matrixRun.runId,
    seed: matrixRun.seed ?? state.seed,
    horizonYears: matrixRun.years ?? null,
    requestedMonths: matrixRun.requestedMonths ?? matrixRun.months ?? null,
    reachedMonth: finiteValue(state.clock?.elapsedMonths),
    matrixStatus: matrixRun.status ?? null,
    civilizationStatus: state.civilization?.status ?? null,
    outcome: state.civilization?.outcome ?? null,
    schemaVersion: state.schemaVersion ?? null,
    currentEra: development.currentEra,
    historicalPeakEra: development.historicalPeakEra,
    candidateEra: development.candidateEra,
    missingGates: development.missingGates,
    developmentMissingGates: development.missingGates,
    development,
    materialCapabilities: auditMaterialCapabilities(state),
    facilities: auditFacilities(state),
    institutions: auditInstitutions(state),
    ...populationAndKnowledge,
    records: auditRecords(state, matrixRun),
    informationAgeGates: gates,
    firstMissingGate: gates.find((gate) => gate.status !== 'satisfied')?.id ?? null,
    informationAgeStatus: gates.every((gate) => gate.status === 'satisfied') ? 'satisfied' : 'unsupported',
  };
}

function aggregateRuns(runs) {
  const horizons = new Map();
  for (const run of runs) {
    const key = run.horizonYears ?? 'unknown';
    const matching = horizons.get(key) ?? [];
    matching.push(run);
    horizons.set(key, matching);
  }
  return [...horizons].sort(([left], [right]) => {
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left).localeCompare(String(right));
  }).map(([horizonYears, matching]) => ({
    horizonYears,
    runs: matching.length,
    matrixStatuses: countBy(matching.map((run) => run.matrixStatus)),
    civilizationStatuses: countBy(matching.map((run) => run.civilizationStatus)),
    currentEras: countBy(matching.map((run) => run.currentEra)),
    historicalPeakEras: countBy(matching.map((run) => run.historicalPeakEra)),
    candidateEras: countBy(matching.map((run) => run.candidateEra)),
    firstMissingGates: countBy(matching.map((run) => run.firstMissingGate)),
    developmentMissingGates: countBy(matching.flatMap((run) => run.developmentMissingGates)),
    informationAgeStatuses: countBy(matching.map((run) => run.informationAgeStatus)),
    materialCapabilityStages: Object.fromEntries(MATERIAL_KEYS.map((key) => [key,
      countBy(matching.map((run) => run.materialCapabilities[key].stage ?? 'unobserved'))])),
    reachedMonth: numericSummary(matching.map((run) => run.reachedMonth)),
    population: {
      living: numericSummary(matching.map((run) => run.population.living)),
      totalHistoricalPeople: numericSummary(matching.map((run) => run.population.totalHistoricalPeople)),
      generationCount: numericSummary(matching.map((run) => run.population.generationCount)),
    },
    knowledge: {
      uniqueReliableTechniques: numericSummary(matching.map((run) => run.knowledge.uniqueReliableTechniques)),
      crossGenerationReliableTechniques: numericSummary(matching.map((run) => run.knowledge.crossGenerationReliableTechniques)),
      directTeachingReproductionChains: numericSummary(matching.map((run) => run.knowledge.directTeaching.directTeachingReproductionChains)),
      postTeacherDeathContinuationChains: numericSummary(matching.map((run) => run.knowledge.directTeaching.postTeacherDeathContinuationChains)),
      legacyDemoImitationChains: numericSummary(matching.map((run) => run.knowledge.directTeaching.legacyDemoImitationMetric.completeTechniqueLearningChains)),
    },
    records: {
      payloads: numericSummary(matching.map((run) => run.records.payloads)),
      currentCarriers: numericSummary(matching.map((run) => run.records.currentCarriers)),
      durablePayloads: numericSummary(matching.map((run) => run.records.durablePayloadsAtLeastTwelveMonths)),
      completeRecordUseChains: numericSummary(matching.map((run) => run.records.recordUseChain.completeChains)),
    },
    facilities: numericSummary(matching.map((run) => run.facilities.total)),
    institutions: numericSummary(matching.map((run) => run.institutions.total)),
  }));
}

async function main() {
  const [matrixArgument, outputArgument] = process.argv.slice(2);
  if (!matrixArgument) {
    throw new Error('usage: node scripts/audit-information-age-chain.mjs <matrix.json> [output.json]');
  }
  const matrixPath = path.resolve(matrixArgument);
  const outputPath = outputArgument ? path.resolve(outputArgument) : null;
  const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
  if (!Array.isArray(matrix.runs)) throw new Error(`matrix has no runs array: ${matrixPath}`);

  const reader = await openSqliteRunReader();
  let runs;
  try {
    runs = [];
    for (const matrixRun of matrix.runs) {
      const runId = stringValue(matrixRun.runId);
      if (!runId) throw new Error('matrix run is missing runId');
      const persisted = await reader.store.load(runId);
      runs.push(auditRun(matrixRun, persisted));
    }
  } finally {
    await reader.close();
  }

  const result = {
    schemaVersion: 1,
    observerVersion: OBSERVER_VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      matrixPath,
      experiment: matrix.experiment ?? null,
      matrixSchemaVersion: matrix.schemaVersion ?? null,
      matrixGeneratedAt: matrix.generatedAt ?? null,
      runCount: matrix.runs.length,
    },
    method: {
      authority: 'SQLite terminal SimulationState loaded read-only through sqlite-run-reader.mjs',
      prohibition: '不从文明指数、时代名、设施名或制度名猜测信息时代能力',
      unsupportedPolicy: '当 schema 缺少结构化事实契约和版本化观察器时，门槛一律 false/unsupported',
    },
    informationAgeDefinition: INFORMATION_AGE_GATES.map((gate, index) => ({ order: index + 1, ...gate })),
    aggregates: aggregateRuns(runs),
    runs,
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, serialized, 'utf8');
  else process.stdout.write(serialized);
}

await main();
