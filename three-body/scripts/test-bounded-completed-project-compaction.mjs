import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-completed-project-shell-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');

function addSnapshot(chunks, snapshot) {
  for (const chunk of [snapshot.root, ...snapshot.parts]) chunks.set(chunk.hash, chunk);
}

function readFrom(chunks) {
  return (hash) => {
    const chunk = chunks.get(hash);
    if (!chunk) throw new Error(`missing fixture chunk ${hash}`);
    return chunk;
  };
}

function pressureBasis(ownerId, atMonth, ordinal = 0) {
  return {
    version: 'project-pressure-basis-v1',
    need: 'measurement-uncertainty',
    observerId: ownerId,
    atMonth,
    pressure: 61,
    edgeKeys: [`edge:${ordinal}`],
    reasonKeys: [`reason:${ordinal}`],
    sourceFactIds: [`pressure-fact:${ordinal}`],
    basisKey: `pressure:${ownerId}:${ordinal}`,
  };
}

function searchCampaign(projectId, ownerId, status = 'closed') {
  return {
    id: `search:${projectId}`,
    projectId,
    ownerId,
    actorId: ownerId,
    materialIds: [3, 8],
    planKnowledgeId: 'technique:fixture-plan',
    basisKey: `project-search-campaign-v2|project=${projectId}|actor=${ownerId}|materials=3,8|plan=technique:fixture-plan`,
    openedAt: 0,
    anchor: { cellId: 0, z: 1 },
    cellIds: Array.from({ length: 512 }, (_, index) => index),
    inheritedTargetKeys: ['1:1', '2:1'],
    inheritedCampaignIds: ['search:older-a', 'search:older-b'],
    attemptedTargetKeys: ['3:1', '4:1'],
    sourceFactIds: Array.from({ length: 512 }, (_, index) => `search-source:${index}`),
    status,
    ...(status === 'active' ? {} : { closedAt: 1 }),
  };
}

function hypothesisAttempt({ projectId, ownerId, stack, ordinal, outcome, verified }) {
  return {
    candidateKey: `candidate:${projectId}:${ordinal}`,
    operation: 'combine-inventory',
    questionKind: 'connect-manipulator-shapes',
    materialIds: [stack.materialId, stack.materialId],
    inventoryMaterialIds: [stack.materialId, stack.materialId],
    inputMaterialId: stack.materialId,
    targetMaterialId: stack.materialId,
    inputSourceKey: `inventory:${ownerId}:${stack.id}`,
    inputRoleMaterialId: stack.materialId,
    roleScore: 7,
    inputRoleScore: 7,
    roleReasonKeys: ['fixture-role'],
    eventId: `hypothesis-event:${projectId}:${ordinal}`,
    atMonth: 1,
    ordinal,
    candidateRank: ordinal,
    outcome,
    ...(outcome === 'response' ? {
      outputMaterialId: stack.materialId,
      techniqueId: `technique:fixture-response:${ordinal}`,
      responseRef: { kind: 'inventory-stack', stackId: stack.id, materialId: stack.materialId },
    } : {}),
    ...(verified ? {
      verifiedEventId: `hypothesis-verification:${projectId}:${ordinal}`,
      verifiedAtMonth: 1,
    } : {}),
    sourceFactIds: [`hypothesis-source:${ordinal}`],
    sourceKeys: [`inventory:${ownerId}:${stack.id}`],
  };
}

function hypothesisCampaign(projectId, ownerId, stack, status = 'closed') {
  const verified = hypothesisAttempt({
    projectId, ownerId, stack, ordinal: 1, outcome: 'response', verified: true,
  });
  const unverified = hypothesisAttempt({
    projectId, ownerId, stack, ordinal: 2, outcome: 'response', verified: false,
  });
  const noResponse = hypothesisAttempt({
    projectId, ownerId, stack, ordinal: 3, outcome: 'no-response', verified: false,
  });
  return {
    version: 'project-hypothesis-campaign-v2',
    id: `hypothesis:${projectId}`,
    projectId,
    actorId: ownerId,
    openedAt: 0,
    budget: 12,
    noResponseBudget: 8,
    responseBudget: 4,
    observedMaterialIds: [stack.materialId, 3, 8],
    sourceFactIds: Array.from({ length: 512 }, (_, index) => `hypothesis-source:${index}`),
    sourceKeys: Array.from({ length: 512 }, (_, index) => `hypothesis-key:${index}`),
    candidates: Array.from({ length: 128 }, (_, index) => ({
      key: `candidate:bulk:${index}`,
      operation: 'combine-inventory',
      questionKind: 'connect-manipulator-shapes',
      materialIds: [stack.materialId, stack.materialId],
      roleScore: index,
      roleReasonKeys: [`bulk-role:${index}`],
      observableScore: index,
      seededRank: index,
      reasonKeys: [`bulk-reason:${index}`],
      sourceFactIds: [`bulk-source:${index}`],
      sourceKeys: [`inventory:${ownerId}:${stack.id}`],
    })),
    attempts: [verified, unverified, noResponse],
    status,
    ...(status === 'active'
      ? { activeCandidateKey: 'candidate:bulk:0' }
      : { endedAt: 1, endingReason: 'project-completed' }),
  };
}

function completedProject({ id, owner, partner, stack, activeCampaign = false }) {
  const projectPressure = pressureBasis(owner.id, 0);
  const mechanicalPlan = {
    version: 'mechanical-power-plan-v1',
    projectId: id,
    sourceSegmentId: 'water-current:fixture',
    wheelPosition: { x: 0, y: 0, z: 1 },
    shaftPositions: [{ x: 1, y: 0, z: 1 }],
    loadPosition: { x: 2, y: 0, z: 1 },
    sourceKeys: ['water-current:fixture'],
  };
  const electricalPlan = {
    version: 'electrical-power-plan-v1',
    mechanicalInstallationProjectId: id,
    mechanicalNetworkId: 'mechanical-network:fixture',
    mechanicalPlanKey: 'mechanical-plan:fixture',
    generatorPosition: { x: 0, y: 0, z: 1 },
    conductorPositions: [{ x: 1, y: 0, z: 1 }],
    loadPosition: { x: 2, y: 0, z: 1 },
  };
  return {
    id,
    kind: 'inquiry',
    need: 'measurement-uncertainty',
    desiredFunction: 'comparable-mass-measurement',
    summary: `completed project ${id}`,
    ownerId: owner.id,
    beneficiaryIds: [owner.id, partner.id],
    triggerFactIds: [`trigger:${id}`],
    pressure: 61,
    pressureBasis: projectPressure,
    productionToolBaselineRank: 2,
    createdAtMonth: 0,
    reviewAtMonth: 1,
    site: { cellId: owner.position.cellId, z: owner.position.z },
    targetKnowledgeId: 'knowledge:fixture-target',
    mechanicalPowerPlan: mechanicalPlan,
    mechanicalPowerPlanKey: 'mechanical-plan:fixture',
    mechanicalPowerNetworkId: 'mechanical-network:fixture',
    mechanicalPowerFaultEventId: 'mechanical-fault:fixture',
    mechanicalReliabilityBasis: {
      version: 'mechanical-reliability-basis-v1',
      observerId: owner.id,
      networkId: 'mechanical-network:fixture',
      installationProjectId: id,
      atMonth: 0,
      faults: [],
      sourceFactIds: ['mechanical-reliability:source'],
      basisKey: 'mechanical-reliability:fixture',
    },
    measurementUncertaintyBasis: {
      version: 'measurement-uncertainty-basis-v1',
      observerId: owner.id,
      atMonth: 0,
      uncertaintyKind: 'overlapping-felt-load-bands',
      samples: [0, 1].map((ordinal) => ({
        personId: owner.id,
        stackId: stack.id,
        materialId: stack.materialId,
        quantity: stack.quantity,
        perceivedLoadBand: 'hand-load',
        sourceEventIds: [`measurement-stack:${ordinal}`],
        productionEventIds: [`measurement-production:${ordinal}`],
      })),
      productionEventIds: ['measurement-production:0', 'measurement-production:1'],
      experiencedMonthCount: 2,
      sourceFactIds: ['measurement-stack:0', 'measurement-stack:1'],
      basisKey: 'measurement-uncertainty:fixture',
    },
    remoteWorkPowerBasis: {
      version: 'remote-work-power-transmission-basis-v1',
      observerId: owner.id,
      atMonth: 0,
      mechanicalInstallationProjectId: id,
      mechanicalNetworkId: 'mechanical-network:fixture',
      mechanicalPlanKey: 'mechanical-plan:fixture',
      sourceSegmentId: 'water-current:fixture',
      sourceWorkPosition: { cellId: 0, z: 1 },
      remoteWorkPosition: { cellId: 2, z: 1 },
      mechanicalServiceEventIds: ['mechanical-service:0', 'mechanical-service:1'],
      remoteWorkEventIds: ['remote-work:0', 'remote-work:1'],
      travelEventIds: ['travel:0', 'travel:1', 'travel:2'],
      routeDistance: 2,
      sourceFactIds: ['mechanical-service:0', 'mechanical-service:1', 'remote-work:0'],
      basisKey: 'remote-work:fixture',
    },
    electricalPowerMaintenanceBasis: {
      version: 'electrical-power-maintenance-basis-v1',
      observerId: owner.id,
      installationProjectId: id,
      networkId: 'electrical-network:fixture',
      planKey: 'electrical-plan:fixture',
      faultEventId: 'electrical-fault:fixture',
      diagnosisEventId: 'electrical-diagnosis:fixture',
      componentPosition: { x: 1, y: 0, z: 1 },
      atMonth: 0,
      sourceFactIds: ['electrical-fault:fixture', 'electrical-diagnosis:fixture'],
      basisKey: 'electrical-maintenance:fixture',
    },
    electricalPowerPlan: electricalPlan,
    electricalPowerPlanKey: 'electrical-plan:fixture',
    electricalPowerNetworkId: 'electrical-network:fixture',
    status: 'completed',
    lastProgressAtMonth: 1,
    planKnowledgeId: 'technique:fixture-plan',
    missingMaterialIds: [3, 8],
    materialDemands: Array.from({ length: 256 }, (_, index) => ({
      materialId: 3,
      requiredQuantity: index + 1,
      availableQuantity: 0,
      outstandingQuantity: index + 1,
      branchKey: `material-demand:${index}`,
      sourceFactIds: [`material-demand-source:${index}`],
    })),
    reservations: Array.from({ length: 256 }, (_, index) => ({
      personId: owner.id,
      stackId: `${stack.id}:${index}`,
      materialId: stack.materialId,
      quantity: 1,
    })),
    contributorIds: [owner.id, partner.id],
    actionEventIds: [`action:${id}:0`, `action:${id}:1`],
    failureEventIds: [`failure:${id}:0`],
    completedAtMonth: 1,
    completionEventIds: [`completion:${id}:0`, `completion:${id}:1`],
    blockedReason: 'recovered before completion',
    blockedAtMonth: 0,
    progressEvidence: Array.from({ length: 256 }, (_, index) => ({
      eventId: `progress:${id}:${index}`,
      atMonth: 0,
      kind: 'material-contribution',
      actorId: owner.id,
    })),
    searchCampaigns: [searchCampaign(id, owner.id, activeCampaign ? 'active' : 'closed')],
    hypothesisCampaign: hypothesisCampaign(id, owner.id, stack, activeCampaign ? 'active' : 'closed'),
    techniqueDemonstrationRequests: [{
      version: 'project-technique-demonstration-request-v1',
      requestEventId: `demo-request:${id}`,
      projectId: id,
      requesterId: owner.id,
      teacherIds: [partner.id],
      desiredFunction: 'comparable-mass-measurement',
      expiresAtMonth: 1,
      atMonth: 0,
    }],
    materialContributionRequests: [{
      version: 'project-material-contribution-request-v1',
      requestEventId: `material-request:${id}`,
      projectId: id,
      requesterId: owner.id,
      contributorIds: [partner.id],
      materialId: stack.materialId,
      requestedQuantity: 1,
      site: { cellId: owner.position.cellId, z: owner.position.z },
      expiresAtMonth: 1,
      atMonth: 0,
    }],
    knowledgeRequests: [{
      version: 'project-knowledge-request-v1',
      requestEventId: `knowledge-request:${id}`,
      projectId: id,
      requesterId: owner.id,
      listenerIds: [partner.id],
      outputMaterialId: stack.materialId,
      expiresAtMonth: 1,
      atMonth: 0,
    }],
    techniqueDemonstrations: [{
      version: 'project-technique-demonstration-basis-v1',
      projectId: id,
      desiredFunction: 'comparable-mass-measurement',
      learnerId: owner.id,
      demonstratorId: partner.id,
      requestEventId: `demo-request:${id}`,
      demonstrationEventId: `demo:${id}`,
      techniqueId: 'technique:fixture-plan',
      operation: 'combine',
      inputMaterialIds: [stack.materialId],
      outputMaterialId: stack.materialId,
      sourceKeys: [`inventory:${partner.id}:${stack.id}`],
      sourceFactIds: [`demo:${id}`],
      initialConfidence: 40,
      atMonth: 0,
    }],
    pressureHistory: Array.from({ length: 256 }, (_, index) => pressureBasis(owner.id, 0, index)),
    logisticsEpisodes: Array.from({ length: 256 }, (_, index) => ({
      id: `logistics:${id}:${index}`,
      kind: 'search',
      actorId: owner.id,
      materialIds: [3],
      target: { cellId: index, z: 1 },
      sourceRef: { kind: 'project-requirement', projectId: id },
      searchCampaignId: `search:${id}`,
      sourceEventIds: [`logistics-source:${index}`],
      createdAt: 0,
      status: 'fulfilled',
      actionEventIds: [`logistics-action:${index}`],
      endedAt: 1,
      endingReason: 'project-completed',
    })),
  };
}

function livingPeople(state) {
  return state.people.filter((person) => person.diedAtMonth === undefined && person.body.health > 0);
}

try {
  writeFileSync(entryPath, [
    `export * from ${JSON.stringify(path.join(workspace, 'server/run-state-codec.ts'))};`,
    `export * from ${JSON.stringify(path.join(workspace, 'server/bounded-gameplay-shell.ts'))};`,
    `export { createSimulation, stepOwnedSimulation } from ${JSON.stringify(path.join(workspace, 'src/game/eland/simulation.ts'))};`,
  ].join('\n'));
  execFileSync(path.join(workspace, 'node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { cwd: workspace, stdio: 'pipe' });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  const state = api.createSimulation({
    seed: 20_260_826,
    config: {
      endpoint: { kind: 'months', value: 1_200 },
      chaosIntensity: 0,
      characterIds: ['galileo', 'freyja', 'newton'],
    },
  }).getState();
  assert.equal(state.clock.elapsedMonths, 0);
  assert.ok(state.people.length >= 2);
  state.clock.elapsedMonths = 1;
  const [owner, partner] = state.people;
  const stack = owner.inventory[0];
  assert.ok(stack, 'fixture owner needs one tangible inventory stack');

  const archived = completedProject({ id: 'project:archive-rich', owner, partner, stack });
  const second = completedProject({ id: 'project:archive-second', owner: partner, partner: owner, stack });
  const contradictory = completedProject({
    id: 'project:completed-active-campaign', owner, partner, stack, activeCampaign: true,
  });
  state.projects.push(archived, second, contradictory);
  const sourceProjectIds = state.projects.map((project) => project.id);

  const compact = api.compactCompletedProjectForGameplayShell(archived);
  const compactAgain = api.compactCompletedProjectForGameplayShell(compact);
  assert.deepEqual(compactAgain, compact, 'completed project compaction must be idempotent');
  assert.deepEqual(state.projects.map((project) => project.id), sourceProjectIds,
    'compaction must not mutate the source project array or its order');
  assert.ok(archived.materialDemands.length > 0, 'source project must remain exact');
  assert.deepEqual(compact.reservations, []);
  assert.deepEqual(compact.missingMaterialIds, []);
  for (const field of [
    'materialDemands',
    'progressEvidence',
    'techniqueDemonstrationRequests',
    'materialContributionRequests',
    'knowledgeRequests',
    'pressureHistory',
    'logisticsEpisodes',
  ]) assert.equal(Object.hasOwn(compact, field), false, `${field} must leave the cold archive`);

  for (const field of [
    'id', 'kind', 'need', 'desiredFunction', 'summary', 'ownerId', 'beneficiaryIds',
    'triggerFactIds', 'contributorIds', 'status', 'createdAtMonth', 'reviewAtMonth',
    'lastProgressAtMonth', 'completedAtMonth', 'blockedAtMonth', 'site', 'actionEventIds',
    'completionEventIds', 'failureEventIds', 'measurementUncertaintyBasis',
    'remoteWorkPowerBasis', 'mechanicalPowerPlan', 'mechanicalPowerPlanKey',
    'mechanicalPowerNetworkId', 'mechanicalReliabilityBasis', 'electricalPowerPlan',
    'electricalPowerPlanKey', 'electricalPowerNetworkId', 'electricalPowerMaintenanceBasis',
    'techniqueDemonstrations',
  ]) assert.deepEqual(compact[field], archived[field], `${field} contract must remain exact`);

  assert.deepEqual(compact.searchCampaigns, [{
    id: `search:${archived.id}`,
    projectId: archived.id,
    ownerId: owner.id,
    actorId: owner.id,
    materialIds: [3, 8],
    planKnowledgeId: 'technique:fixture-plan',
    basisKey: `project-search-campaign-v2|project=${archived.id}|actor=${owner.id}|materials=3,8|plan=technique:fixture-plan`,
    inheritedTargetKeys: ['1:1', '2:1'],
    inheritedCampaignIds: ['search:older-a', 'search:older-b'],
    attemptedTargetKeys: ['3:1', '4:1'],
    status: 'closed',
  }], 'search archive must retain only cross-project inheritance facts');
  assert.deepEqual(compact.hypothesisCampaign.candidates, []);
  assert.deepEqual(compact.hypothesisCampaign.observedMaterialIds, []);
  assert.deepEqual(compact.hypothesisCampaign.sourceFactIds, []);
  assert.deepEqual(compact.hypothesisCampaign.sourceKeys, []);
  assert.equal(compact.hypothesisCampaign.attempts.length, 1,
    'only verified response attempts may remain in a completed hypothesis archive');
  assert.equal(compact.hypothesisCampaign.attempts[0].verifiedEventId,
    `hypothesis-verification:${archived.id}:1`);
  assert.strictEqual(api.compactCompletedProjectForGameplayShell(contradictory), contradictory,
    'completed projects with active campaigns must remain exact for synchronization');
  assert.ok(JSON.stringify(compact).length < JSON.stringify(archived).length * 0.2,
    'fixture must demonstrate material cold-payload reduction');

  const exactForStep = structuredClone(state);
  const compactForStep = structuredClone(state);
  compactForStep.projects = compactForStep.projects.map(
    (project) => api.compactCompletedProjectForGameplayShell(project),
  );
  const priorIntentCount = state.intents.length;
  const priorProjectCount = state.projects.length;
  const exactAfter = api.stepOwnedSimulation(exactForStep);
  const compactAfter = api.stepOwnedSimulation(compactForStep);
  assert.equal(exactAfter.clock.elapsedMonths, 2, 'equivalence month must be non-annual');
  assert.deepEqual(compactAfter.lastStep, exactAfter.lastStep,
    'same non-observer month must commit the same exact events');
  assert.deepEqual(livingPeople(compactAfter), livingPeople(exactAfter),
    'completed archives must not change living gameplay state');
  assert.deepEqual(compactAfter.world, exactAfter.world,
    'completed archives must not change authoritative world state');
  assert.deepEqual(compactAfter.intents.slice(priorIntentCount), exactAfter.intents.slice(priorIntentCount),
    'new intent behavior must remain exact');
  assert.deepEqual(compactAfter.projects.slice(priorProjectCount), exactAfter.projects.slice(priorProjectCount),
    'new project behavior must remain exact');
  assert.ok(exactAfter.intents.length > priorIntentCount || exactAfter.projects.length > priorProjectCount,
    'fixture must exercise at least one new intent/project decision');

  const snapshot = await api.encodeSegmentedRunState(
    state,
    { mode: 'replace' },
    { maxEventsPerSegmentForTests: 2 },
  );
  const chunks = new Map();
  addSnapshot(chunks, snapshot);
  const decoded = await api.decodeSegmentedRunStateGameplayBounded(
    snapshot.root,
    readFrom(chunks),
    {
      hotEventLimit: 4,
      pinnedEventIndexes: [],
      observerAuthority: {
        stateHash: snapshot.root.hash,
        revision: 7,
        month: 1,
        lastMaterializedMilestoneCount: state.derived.milestones.length,
      },
    },
  );
  const decodedIds = decoded.state.projects.map((project) => project.id);
  assert.deepEqual(
    decodedIds.filter((id) => [archived.id, second.id, contradictory.id].includes(id)),
    [archived.id, second.id, contradictory.id],
    'streaming compaction must retain completed projects in source order',
  );
  const streamedArchive = decoded.state.projects.find((project) => project.id === archived.id);
  const streamedContradiction = decoded.state.projects.find((project) => project.id === contradictory.id);
  assert.ok(streamedArchive && streamedContradiction);
  assert.deepEqual(streamedArchive, compact,
    'streamed project branch must use the same canonical completed archive');
  assert.ok(streamedContradiction.materialDemands.length > 0
    && streamedContradiction.searchCampaigns.some((campaign) => campaign.status === 'active'),
  'streaming must preserve an active-campaign contradiction instead of silently compacting it');

  const maxRssBytes = process.resourceUsage().maxRSS * 1_024;
  assert.ok(maxRssBytes < 256 * 1_024 * 1_024,
    `completed project compaction fixture RSS ${maxRssBytes} must remain below 256 MiB`);
  console.log(JSON.stringify({
    ok: true,
    sourceBytes: JSON.stringify(archived).length,
    compactBytes: JSON.stringify(compact).length,
    retainedVerifiedResponses: compact.hypothesisCampaign.attempts.length,
    newIntentCount: exactAfter.intents.length - priorIntentCount,
    newProjectCount: exactAfter.projects.length - priorProjectCount,
    maxRssBytes,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
