import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { openSqliteRunReader } from './sqlite-run-reader.mjs';

const OBSERVER_VERSION = 'mechanical-power-chain-audit-v1';
const PLAN_VERSION = 'mechanical-power-plan-v1';
const ACTION_VERSION = 'mechanical-power-action-basis-v1';
const WATER_WHEEL = 64;
const DRIVE_SHAFT = 65;
const MILL = 59;

const asArray = (value) => Array.isArray(value) ? value : [];
const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const stringValue = (value) => typeof value === 'string' && value.length > 0 ? value : null;
const integerValue = (value) => Number.isInteger(value) ? value : null;
const finiteValue = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const rounded = (value) => Math.round(value * 100) / 100;
const uniqueStrings = (values) => [...new Set(values.map(stringValue).filter(Boolean))].sort();

function eventOrder(left, right) {
  return (integerValue(left.event?.atMonth) ?? 0) - (integerValue(right.event?.atMonth) ?? 0)
    || (integerValue(left.event?.orderInMonth) ?? 0) - (integerValue(right.event?.orderInMonth) ?? 0)
    || (integerValue(left.event?.planningTick) ?? 0) - (integerValue(right.event?.planningTick) ?? 0)
    || (integerValue(left.event?.orderInTick) ?? 0) - (integerValue(right.event?.orderInTick) ?? 0)
    || left.index - right.index;
}

function isBefore(left, right) {
  return eventOrder(left, right) < 0;
}

function position(value) {
  const candidate = asObject(value);
  const x = integerValue(candidate?.x);
  const y = integerValue(candidate?.y);
  const z = integerValue(candidate?.z);
  return x === null || y === null || z === null ? null : { x, y, z };
}

function positionKey(value) {
  const parsed = position(value);
  return parsed ? `${parsed.x}:${parsed.y}:${parsed.z}` : null;
}

function countBy(values) {
  return Object.fromEntries([...values.reduce((counts, value) => {
    const key = String(value ?? 'unknown');
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map())].sort(([left], [right]) => left.localeCompare(right)));
}

function percentage(numerator, denominator) {
  return denominator > 0 ? rounded(numerator / denominator * 100) : null;
}

function numericSummary(values) {
  const usable = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!usable.length) return { count: 0, min: null, median: null, mean: null, max: null };
  const middle = Math.floor(usable.length / 2);
  const median = usable.length % 2 ? usable[middle] : (usable[middle - 1] + usable[middle]) / 2;
  return {
    count: usable.length,
    min: usable[0],
    median: rounded(median),
    mean: rounded(usable.reduce((sum, value) => sum + value, 0) / usable.length),
    max: usable.at(-1),
  };
}

function eventSummary(item) {
  if (!item) return null;
  const event = item.event;
  const action = asObject(event.action);
  const basis = asObject(action?.mechanicalPowerBasis);
  const diff = asObject(event.diff) ?? {};
  return {
    eventId: stringValue(event.id),
    atMonth: integerValue(event.atMonth),
    orderInMonth: integerValue(event.orderInMonth),
    planningTick: integerValue(event.planningTick),
    orderInTick: integerValue(event.orderInTick),
    who: stringValue(event.who),
    status: stringValue(event.status),
    actionKind: stringValue(action?.kind),
    actionOperation: stringValue(action?.operation),
    basisMode: stringValue(basis?.mode),
    projectId: stringValue(basis?.projectId) ?? stringValue(diff.projectId),
    planKey: stringValue(basis?.planKey) ?? stringValue(diff.planKey),
    networkId: stringValue(basis?.networkId) ?? stringValue(diff.networkId),
    sourceSegmentId: stringValue(basis?.sourceSegmentId) ?? stringValue(diff.sourceSegmentId),
  };
}

function mechanicalAction(item) {
  const action = asObject(item.event?.action);
  const basis = asObject(action?.mechanicalPowerBasis);
  return basis?.version === ACTION_VERSION ? { item, action, basis, diff: asObject(item.event.diff) ?? {} } : null;
}

function exactInstallRequirement(plan) {
  return [
    { role: 'converter', materialId: WATER_WHEEL, positionKey: positionKey(plan.wheelPosition) },
    ...asArray(plan.shaftPositions).map((candidate) => ({
      role: 'connector', materialId: DRIVE_SHAFT, positionKey: positionKey(candidate),
    })),
    { role: 'load', materialId: MILL, positionKey: positionKey(plan.loadPosition) },
  ];
}

function classifyProject(project, state, eventMap) {
  const plan = asObject(project.mechanicalPowerPlan);
  const reasons = [];
  const projectId = stringValue(project.id);
  const ownerId = stringValue(project.ownerId);
  const planKey = stringValue(project.mechanicalPowerPlanKey) ?? stringValue(plan?.planKey);
  const sourceSegmentId = stringValue(plan?.sourceSegmentId);
  const networkId = stringValue(project.mechanicalPowerNetworkId);
  if (plan?.version !== PLAN_VERSION) reasons.push('invalid-plan-version');
  if (!projectId || stringValue(plan?.projectId) !== projectId) reasons.push('plan-project-mismatch');
  if (!sourceSegmentId) reasons.push('missing-source-segment');
  if (!planKey) reasons.push('missing-plan-key');
  if (!networkId) reasons.push('missing-network-id');

  const unresolvedActionEventIds = [];
  const projectEvents = [];
  for (const eventId of uniqueStrings(asArray(project.actionEventIds))) {
    const resolved = eventMap.get(eventId);
    if (!resolved) unresolvedActionEventIds.push(eventId);
    else projectEvents.push(resolved);
  }
  projectEvents.sort(eventOrder);
  if (unresolvedActionEventIds.length) reasons.push('unresolved-project-action-events');

  const triggerIds = new Set(asArray(project.triggerFactIds).map(stringValue).filter(Boolean));
  const observations = [...eventMap.values()].filter((item) => {
    const event = item.event;
    const action = asObject(event.action);
    const diff = asObject(event.diff) ?? {};
    return triggerIds.has(event.id)
      && event.kind === 'action'
      && event.status === 'completed'
      && event.who === ownerId
      && action?.kind === 'attend'
      && diff.mechanicalPowerObservation === true
      && stringValue(diff.waterCurrentSegmentId) === sourceSegmentId
      && (finiteValue(diff.availableCapacity) ?? 0) > 0
      && asArray(diff.supportingSegmentIds).includes(sourceSegmentId)
      && asArray(diff.sourceKeys).length > 0
      && position(diff.observedPosition);
  }).sort(eventOrder);
  const observation = observations.at(-1) ?? null;
  if (!observation) reasons.push('missing-owner-source-observation');
  else if ((integerValue(observation.event.atMonth) ?? Infinity) > (integerValue(project.createdAtMonth) ?? -Infinity)) {
    reasons.push('observation-after-project-created');
  }

  const classified = projectEvents.map(mechanicalAction).filter(Boolean);
  const wrongBindings = classified.filter(({ basis }) => stringValue(basis.projectId) !== projectId
    || stringValue(basis.planKey) !== planKey
    || stringValue(basis.networkId) !== networkId
    || stringValue(basis.sourceSegmentId) !== sourceSegmentId);
  if (wrongBindings.length) reasons.push('mechanical-action-binding-mismatch');
  const bound = classified.filter(({ basis }) => stringValue(basis.projectId) === projectId
    && stringValue(basis.planKey) === planKey
    && stringValue(basis.networkId) === networkId
    && stringValue(basis.sourceSegmentId) === sourceSegmentId);

  const installs = bound.filter(({ item, basis, diff }) => item.event.status === 'completed'
    && basis.mode === 'install'
    && diff.mechanicalPowerInstallation === true);
  const requirements = exactInstallRequirement(plan ?? {});
  const installationMatches = requirements.map((requirement) => installs.filter(({ basis, diff }) => (
    stringValue(basis.componentRole) === requirement.role
      && integerValue(basis.componentMaterialId) === requirement.materialId
      && positionKey(basis.componentPosition) === requirement.positionKey
      && stringValue(diff.componentRole) === requirement.role
      && integerValue(diff.componentMaterialId) === requirement.materialId
      && positionKey(diff.componentPosition) === requirement.positionKey
      && asArray(diff.installationSourceEventIds).length > 0
  )));
  if (!requirements.length || requirements.some((requirement) => !requirement.positionKey)) reasons.push('invalid-plan-geometry');
  if (installationMatches.some((matches) => matches.length === 0)) reasons.push('missing-exact-installation');
  if (installationMatches.some((matches) => matches.length > 1)) reasons.push('duplicate-exact-installation');
  const installationEvents = installationMatches.flatMap((matches) => matches.slice(0, 1).map(({ item }) => item)).sort(eventOrder);

  const faults = bound.filter(({ item, basis, diff }) => item.event.status === 'progressed'
    && basis.mode === 'operate'
    && diff.mechanicalPowerFault === true
    && diff.faultKind === 'commissioning-misalignment'
    && diff.componentRole === 'connector'
    && diff.inputPreserved === true
    && integerValue(diff.inputMaterialId) === integerValue(basis.inputMaterialId)
    && stringValue(diff.inputStackId)
    && finiteValue(diff.inputQuantityBefore) !== null
    && finiteValue(diff.inputQuantityBefore) === finiteValue(diff.inputQuantityAfter))
    .sort((left, right) => eventOrder(left.item, right.item));
  const fault = faults[0] ?? null;
  if (!fault) reasons.push('missing-commissioning-fault');
  if (fault && installationEvents.some((install) => !isBefore(install, fault.item))) {
    reasons.push('fault-before-all-installations');
  }

  const faultEventId = fault ? stringValue(fault.diff.faultEventId) ?? stringValue(fault.item.event.id) : null;
  const repairs = bound.filter(({ item, basis, diff }) => item.event.status === 'completed'
    && basis.mode === 'repair'
    && diff.mechanicalPowerRepair === true
    && stringValue(basis.faultEventId) === faultEventId
    && stringValue(diff.faultEventId) === faultEventId
    && integerValue(basis.replacementMaterialId) === DRIVE_SHAFT
    && integerValue(diff.replacementMaterialId) === DRIVE_SHAFT
    && integerValue(diff.toolMaterialId) === integerValue(basis.toolMaterialId)
    && stringValue(diff.replacementStackId)
    && asArray(diff.repairSourceEventIds).length > 0).sort((left, right) => eventOrder(left.item, right.item));
  const repair = repairs.find((candidate) => !fault || isBefore(fault.item, candidate.item)) ?? null;
  if (!repair) reasons.push('missing-source-bound-repair');

  const operations = bound.filter(({ item, basis, diff }) => item.event.status === 'completed'
    && basis.mode === 'operate'
    && diff.mechanicalPowerOperation === true
    && integerValue(diff.outputQuantity) > 0
    && stringValue(diff.inputStackId)
    && asArray(diff.inputSourceEventIds).length > 0
    && stringValue(diff.outputStackId)
    && integerValue(diff.inputMaterialId) === integerValue(basis.inputMaterialId)
    && integerValue(diff.outputMaterialId) === integerValue(basis.outputMaterialId)
    && asArray(diff.supportingSegmentIds).includes(sourceSegmentId)).sort((left, right) => eventOrder(left.item, right.item));
  const postRepairOperation = operations.find((candidate) => repair && isBefore(repair.item, candidate.item)) ?? null;
  if (!postRepairOperation) reasons.push('missing-post-repair-powered-operation');
  if (postRepairOperation && !asArray(postRepairOperation.diff.repairEventIds).includes(repair?.item.event.id)) {
    reasons.push('operation-missing-repair-lineage');
  }

  const completionIds = new Set(asArray(project.completionEventIds).map(stringValue).filter(Boolean));
  if (project.status === 'completed' && (!postRepairOperation || !completionIds.has(postRepairOperation.item.event.id))) {
    reasons.push('completion-without-post-repair-operation');
  }
  if (project.status !== 'completed' && completionIds.size) reasons.push('noncompleted-project-has-completion-evidence');

  const network = asArray(state.world?.mechanicalPower?.networks).find((candidate) => candidate?.id === networkId);
  if (!network) reasons.push('missing-authoritative-network');
  else {
    if (network.planKey !== planKey || network.installationProjectId !== projectId || network.sourceSegmentId !== sourceSegmentId) {
      reasons.push('network-binding-mismatch');
    }
    for (const install of installationEvents) {
      if (!asArray(network.installationEventIds).includes(install.event.id)) reasons.push('network-missing-installation-event');
    }
    if (fault && !asArray(network.faultEventIds).includes(fault.item.event.id)) reasons.push('network-missing-fault-event');
    if (repair && !asArray(network.repairEventIds).includes(repair.item.event.id)) reasons.push('network-missing-repair-event');
    if (postRepairOperation && !asArray(network.operationEventIds).includes(postRepairOperation.item.event.id)) {
      reasons.push('network-missing-operation-event');
    }
    for (const [requirementIndex, requirement] of requirements.entries()) {
      const installEventId = installationEvents[requirementIndex]?.event.id;
      const matching = asArray(network.components).filter((component) => component?.role === requirement.role
        && integerValue(component.materialId) === requirement.materialId
        && positionKey(component.position) === requirement.positionKey
        && component.installationEventId === installEventId);
      if (matching.length !== 1) reasons.push('network-component-provenance-mismatch');
    }
  }

  const strictComplete = project.status === 'completed' && reasons.length === 0;
  return {
    projectId,
    ownerId,
    desiredFunction: stringValue(project.desiredFunction),
    status: stringValue(project.status),
    createdAtMonth: integerValue(project.createdAtMonth),
    completedAtMonth: integerValue(project.completedAtMonth),
    plan: {
      version: stringValue(plan?.version),
      projectId: stringValue(plan?.projectId),
      planKey,
      networkId,
      sourceSegmentId,
      wheelPosition: position(plan?.wheelPosition),
      shaftPositions: asArray(plan?.shaftPositions).map(position),
      loadPosition: position(plan?.loadPosition),
    },
    strictComplete,
    reasons: uniqueStrings(reasons),
    unresolvedActionEventIds,
    observation: eventSummary(observation),
    installations: installationEvents.map(eventSummary),
    fault: eventSummary(fault?.item),
    repair: eventSummary(repair?.item),
    postRepairOperation: eventSummary(postRepairOperation?.item),
    completionEventIds: uniqueStrings(asArray(project.completionEventIds)),
    wrongBindingEvents: wrongBindings.map(({ item }) => eventSummary(item)),
  };
}

function auditRun(matrixRun, persisted) {
  const state = persisted.state;
  const events = asArray(state.world?.past);
  const eventMap = new Map();
  const duplicateEventIds = [];
  for (const [index, event] of events.entries()) {
    const id = stringValue(event?.id);
    if (!id) continue;
    if (eventMap.has(id)) duplicateEventIds.push(id);
    else eventMap.set(id, { event, index });
  }
  const projects = asArray(state.projects)
    .filter((project) => asObject(project.mechanicalPowerPlan)?.version === PLAN_VERSION)
    .map((project) => classifyProject(project, state, eventMap));
  const completed = projects.filter((project) => project.status === 'completed');
  const strict = projects.filter((project) => project.strictComplete);
  const projectsWithAnomalies = projects.filter((project) => project.reasons.length > 0);
  const unsupported = projects.length === 0;
  return {
    runId: stringValue(matrixRun.runId),
    seed: integerValue(matrixRun.seed),
    horizonYears: integerValue(matrixRun.years),
    repeat: integerValue(matrixRun.repeat),
    matrixStatus: stringValue(matrixRun.status),
    matrixThroughMonth: integerValue(matrixRun.throughMonth) ?? integerValue(matrixRun.months),
    sqliteMeta: {
      revision: integerValue(persisted.meta?.revision),
      elapsedMonths: integerValue(persisted.meta?.elapsedMonths),
      status: stringValue(persisted.meta?.status),
      eventCount: integerValue(persisted.meta?.eventCount),
    },
    support: unsupported ? 'unsupported' : projectsWithAnomalies.length ? 'partial' : 'supported',
    metrics: {
      projects: projects.length,
      completedProjects: completed.length,
      strictCompleteChains: strict.length,
      completedWithoutStrictChain: completed.filter((project) => !project.strictComplete).length,
      strictCompletionRate: completed.length ? rounded(strict.length / completed.length) : null,
      projectsWithAnomalies: projectsWithAnomalies.length,
      unresolvedActionEventIds: projects.reduce((sum, project) => sum + project.unresolvedActionEventIds.length, 0),
      duplicateWorldEventIds: uniqueStrings(duplicateEventIds).length,
    },
    anomalyReasons: countBy(projects.flatMap((project) => project.reasons)),
    projects,
  };
}

function aggregateGroup(horizonYears, runs) {
  const total = (selector) => runs.reduce((sum, run) => sum + selector(run), 0);
  const projects = total((run) => run.metrics.projects);
  const completed = total((run) => run.metrics.completedProjects);
  const strict = total((run) => run.metrics.strictCompleteChains);
  return {
    horizonYears,
    runs: runs.length,
    seeds: uniqueStrings(runs.map((run) => run.seed === null ? null : String(run.seed))),
    support: projects === 0 ? 'unsupported' : runs.some((run) => run.support !== 'supported') ? 'partial' : 'supported',
    matrixStatuses: countBy(runs.map((run) => run.matrixStatus)),
    totals: {
      projects,
      completedProjects: completed,
      strictCompleteChains: strict,
      completedWithoutStrictChain: total((run) => run.metrics.completedWithoutStrictChain),
      projectsWithAnomalies: total((run) => run.metrics.projectsWithAnomalies),
      unresolvedActionEventIds: total((run) => run.metrics.unresolvedActionEventIds),
      duplicateWorldEventIds: total((run) => run.metrics.duplicateWorldEventIds),
    },
    strictCompletionRate: completed ? rounded(strict / completed) : null,
    naturalOccurrenceCoverage: percentage(runs.filter((run) => run.metrics.projects > 0).length, runs.length),
    distributions: {
      projectsPerRun: numericSummary(runs.map((run) => run.metrics.projects)),
      strictChainsPerRun: numericSummary(runs.map((run) => run.metrics.strictCompleteChains)),
    },
    anomalyReasons: countBy(runs.flatMap((run) => run.projects.flatMap((project) => project.reasons))),
  };
}

function aggregateRuns(runs) {
  const grouped = new Map();
  for (const run of runs) {
    const key = run.horizonYears ?? 'unknown';
    const values = grouped.get(key) ?? [];
    values.push(run);
    grouped.set(key, values);
  }
  return {
    overall: aggregateGroup('all', runs),
    horizons: [...grouped.entries()].sort(([left], [right]) => Number(left) - Number(right))
      .map(([horizon, values]) => aggregateGroup(horizon, values)),
  };
}

function selfTest() {
  const projectId = 'project-mechanical';
  const planKey = 'plan-key';
  const networkId = 'network-id';
  const sourceSegmentId = 'current-1';
  const basis = (mode, extra = {}) => ({
    version: ACTION_VERSION, mode, projectId, planKey, networkId, sourceSegmentId, sourceKeys: ['source'], ...extra,
  });
  const events = [
    { id: 'observe', kind: 'action', status: 'completed', who: 'owner', atMonth: 1, orderInMonth: 1,
      action: { kind: 'attend', waterCurrentSegmentId: sourceSegmentId },
      diff: { mechanicalPowerObservation: true, waterCurrentSegmentId: sourceSegmentId, availableCapacity: 1,
        supportingSegmentIds: [sourceSegmentId], sourceKeys: ['source'], observedPosition: { x: 0, y: 1, z: 5 } } },
    ...[
      ['wheel', 'converter', WATER_WHEEL, { x: 1, y: 1, z: 5 }],
      ['shaft', 'connector', DRIVE_SHAFT, { x: 2, y: 1, z: 5 }],
      ['mill', 'load', MILL, { x: 3, y: 1, z: 5 }],
    ].map(([id, role, materialId, componentPosition], index) => ({
      id: `install-${id}`, kind: 'action', status: 'completed', who: 'owner', atMonth: 2, orderInMonth: index + 1,
      action: { kind: 'act', operation: 'combine', mechanicalPowerBasis: basis('install', { componentRole: role, componentMaterialId: materialId, componentPosition }) },
      diff: { mechanicalPowerInstallation: true, componentRole: role, componentMaterialId: materialId, componentPosition,
        installationSourceEventIds: [`make-${id}`] },
    })),
    { id: 'fault', kind: 'action', status: 'progressed', who: 'owner', atMonth: 3, orderInMonth: 1,
      action: { kind: 'act', operation: 'exert', mechanicalPowerBasis: basis('operate', { inputMaterialId: 14, outputMaterialId: 25 }) },
      diff: { mechanicalPowerFault: true, faultKind: 'commissioning-misalignment', faultEventId: 'fault',
        componentRole: 'connector', inputPreserved: true, inputMaterialId: 14, inputStackId: 'input',
        inputQuantityBefore: 1, inputQuantityAfter: 1 } },
    { id: 'repair', kind: 'action', status: 'completed', who: 'owner', atMonth: 3, orderInMonth: 2,
      action: { kind: 'act', operation: 'exert', mechanicalPowerBasis: basis('repair', { faultEventId: 'fault', replacementMaterialId: DRIVE_SHAFT, toolMaterialId: 46 }) },
      diff: { mechanicalPowerRepair: true, faultEventId: 'fault', replacementMaterialId: DRIVE_SHAFT,
        replacementStackId: 'replacement', toolMaterialId: 46, repairSourceEventIds: ['make-replacement'] } },
    { id: 'operate', kind: 'action', status: 'completed', who: 'owner', atMonth: 3, orderInMonth: 3,
      action: { kind: 'act', operation: 'exert', mechanicalPowerBasis: basis('operate', { inputMaterialId: 14, outputMaterialId: 25 }) },
      diff: { mechanicalPowerOperation: true, inputMaterialId: 14, inputStackId: 'input',
        inputSourceEventIds: ['seed-source'], outputMaterialId: 25, outputStackId: 'output', outputQuantity: 2,
        repairEventIds: ['repair'], supportingSegmentIds: [sourceSegmentId] } },
  ];
  const project = {
    id: projectId, ownerId: 'owner', desiredFunction: 'water-powered-milling', status: 'completed', createdAtMonth: 2, completedAtMonth: 3,
    triggerFactIds: ['observe'], actionEventIds: events.slice(1).map((event) => event.id), completionEventIds: ['operate'],
    mechanicalPowerPlanKey: planKey, mechanicalPowerNetworkId: networkId,
    mechanicalPowerPlan: { version: PLAN_VERSION, projectId, sourceSegmentId, wheelPosition: { x: 1, y: 1, z: 5 }, shaftPositions: [{ x: 2, y: 1, z: 5 }], loadPosition: { x: 3, y: 1, z: 5 } },
  };
  const network = { id: networkId, planKey, installationProjectId: projectId, sourceSegmentId,
    components: [
      { role: 'converter', materialId: WATER_WHEEL, position: { x: 1, y: 1, z: 5 }, installationEventId: 'install-wheel' },
      { role: 'connector', materialId: DRIVE_SHAFT, position: { x: 2, y: 1, z: 5 }, installationEventId: 'install-shaft' },
      { role: 'load', materialId: MILL, position: { x: 3, y: 1, z: 5 }, installationEventId: 'install-mill' },
    ],
    installationEventIds: ['install-wheel', 'install-shaft', 'install-mill'], faultEventIds: ['fault'], repairEventIds: ['repair'], operationEventIds: ['operate'] };
  const eventMap = new Map(events.map((event, index) => [event.id, { event, index }]));
  const clean = classifyProject(project, { world: { mechanicalPower: { networks: [network] } } }, eventMap);
  assert.equal(clean.strictComplete, true);
  assert.deepEqual(clean.reasons, []);
  const invalid = classifyProject({ ...project, completionEventIds: ['fault'] }, { world: { mechanicalPower: { networks: [network] } } }, eventMap);
  assert.equal(invalid.strictComplete, false);
  assert.ok(invalid.reasons.includes('completion-without-post-repair-operation'));
}

async function main() {
  selfTest();
  if (process.argv[2] === '--self-test') {
    process.stdout.write('mechanical-power-chain audit self-test passed\n');
    return;
  }
  const [matrixArgument, outputArgument] = process.argv.slice(2);
  if (!matrixArgument) throw new Error('usage: node scripts/audit-mechanical-power-chain.mjs <matrix.json> [output.json]');
  const matrixPath = path.resolve(matrixArgument);
  const outputPath = outputArgument ? path.resolve(outputArgument) : null;
  const matrixText = await readFile(matrixPath, 'utf8');
  const matrix = JSON.parse(matrixText);
  if (!Array.isArray(matrix.runs)) throw new Error(`matrix has no runs array: ${matrixPath}`);
  const reader = await openSqliteRunReader();
  const runs = [];
  try {
    for (const matrixRun of matrix.runs) {
      const runId = stringValue(matrixRun.runId);
      if (!runId) throw new Error('matrix run is missing runId');
      runs.push(auditRun(matrixRun, await reader.store.load(runId)));
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
      matrixSha256: createHash('sha256').update(matrixText).digest('hex'),
      experiment: matrix.experiment ?? null,
      matrixSchemaVersion: matrix.schemaVersion ?? null,
      matrixGeneratedAt: matrix.generatedAt ?? null,
      runCount: matrix.runs.length,
    },
    method: {
      authority: 'SQLite terminal SimulationState loaded read-only; the observer never advances a run.',
      strictChain: 'owner source-bound current observation -> exact project installations -> failed commissioning operation preserving input -> source-bound replacement repair -> completed post-repair powered operation -> project completion evidence',
      noProxyPolicy: 'Nearby Mill bonuses, material names, era/index labels and terminal network presence cannot substitute for versioned project-bound action facts.',
      sourceAvailabilityPolicy: 'The action executor is authoritative at commit; observer requires the completed operation to persist the exact source segment among supportingSegmentIds.',
      zeroDenominatorPolicy: 'No mechanical project is unsupported, never a vacuous 100% success.',
      embeddedSelfTest: 'Locks one strict clean chain and rejects completion evidence that points to the commissioning fault.',
    },
    aggregates: aggregateRuns(runs),
    runs,
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, serialized, 'utf8');
  else process.stdout.write(serialized);
}

await main();
