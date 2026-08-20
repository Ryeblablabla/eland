#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const HELP = `Run a sequential ELAND evolution experiment matrix.

Usage:
  node run_matrix.mjs [options]

Options:
  --base-url URL          Backend URL (default: http://127.0.0.1:3220)
  --prefix TEXT           Unique run prefix (default: matrix-<timestamp>)
  --seeds CSV             Integer seeds (default: 185,20260815,20260816)
  --years CSV             Positive year horizons (default: 10,30,50,100,1000; 1000 is ELAND's terminal-audit cap)
  --repeats N             Repetitions per seed/horizon (default: 1)
  --civilization-no N     Civilization number (default: 1)
  --chaos-intensity N     Chaos intensity (default: 0)
  --climate-bias TEXT     balanced, cold, or hot (default: balanced)
  --poll-ms N             Progress poll interval (default: 1000)
  --out PATH              Also write the final JSON summary to PATH
  --dry-run               Print the planned matrix without creating runs
  --help                  Show this help

Identical deterministic repeats test replay only; use --repeats > 1 as
independent evidence only when nondeterminism is active.`;

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') values.help = true;
    else if (token === '--dry-run') values.dryRun = true;
    else if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
      values[key] = value;
      index += 1;
    } else throw new Error(`Unknown argument: ${token}`);
  }
  return values;
}

function csvIntegers(raw, label) {
  const values = String(raw).split(',').map((value) => Number(value.trim()));
  if (!values.length || values.some((value) => !Number.isInteger(value))) throw new Error(`${label} must be comma-separated integers`);
  return [...new Set(values)];
}

function positiveInteger(raw, label) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function safePrefix(raw) {
  const value = String(raw).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56);
  if (!value) throw new Error('prefix must contain letters or digits');
  return value;
}

function matrixRunId(prefix, seed, year, repeat) {
  const suffix = `-s${seed}-y${year}-r${repeat}`;
  const prefixLimit = 64 - suffix.length;
  if (prefixLimit < 1) throw new Error(`matrix coordinates are too long for a 64-character run id: ${suffix}`);
  return `${prefix.slice(0, prefixLimit).replace(/-+$/g, '')}${suffix}`;
}

export async function requestResult(baseUrl, path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.text();
  let payload;
  try { payload = body ? JSON.parse(body) : null; } catch { payload = body; }
  return { ok: response.ok, status: response.status, payload };
}

export async function jsonRequest(baseUrl, path, init, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await requestResult(baseUrl, path, init);
      if (!result.ok) throw new Error(`${init?.method ?? 'GET'} ${path} failed (${result.status}): ${typeof result.payload === 'string' ? result.payload : JSON.stringify(result.payload)}`);
      return result.payload;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 500));
    }
  }
  throw lastError;
}

export async function optionalJsonRequest(baseUrl, path) {
  const result = await requestResult(baseUrl, path);
  if (result.status === 404) return null;
  if (!result.ok) throw new Error(`GET ${path} failed (${result.status}): ${typeof result.payload === 'string' ? result.payload : JSON.stringify(result.payload)}`);
  return result.payload;
}

export function evolutionFailure(evolution) {
  return evolution?.failure ?? evolution?.error ?? 'unknown evolution error';
}

export async function claimEvolutionThrough(baseUrl, plan, expected) {
  return jsonRequest(baseUrl, `/api/runs/${plan.runId}/evolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestedEndMonth: plan.months, expected }),
  });
}

export async function ensureEvolutionThrough({ baseUrl, plan, expected, createPayload }) {
  const evolution = await optionalJsonRequest(baseUrl, `/api/runs/${plan.runId}/evolution`);
  if (evolution?.status === 'failed') throw new Error(`${plan.runId} failed: ${evolutionFailure(evolution)}`);
  if (!evolution) {
    const existingRun = await optionalJsonRequest(baseUrl, `/api/runs/${plan.runId}`);
    if (!existingRun) {
      await jsonRequest(baseUrl, '/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createPayload),
      });
    }
  }
  return claimEvolutionThrough(baseUrl, plan, expected);
}

export async function waitForEvolution({ baseUrl, plan, expected, pollMs, initialEvolution, onProgress }) {
  let evolution = initialEvolution;
  for (;;) {
    onProgress?.(evolution);
    if (evolution.status === 'completed') return evolution;
    if (evolution.status === 'failed') throw new Error(`${plan.runId} failed: ${evolutionFailure(evolution)}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
    evolution = await claimEvolutionThrough(baseUrl, plan, expected);
  }
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function numericSummary(values) {
  const present = values.filter((value) => Number.isFinite(value));
  if (!present.length) return null;
  const mean = present.reduce((sum, value) => sum + value, 0) / present.length;
  return {
    count: present.length,
    min: Math.min(...present),
    median: Math.round(median(present) * 100) / 100,
    mean: Math.round(mean * 100) / 100,
    max: Math.max(...present),
  };
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function projectLogisticsMetrics(state) {
  const episodes = (Array.isArray(state?.projects) ? state.projects : []).flatMap((project) => (
    Array.isArray(project?.logisticsEpisodes)
      ? project.logisticsEpisodes.filter((episode) => episode && typeof episode === 'object' && !Array.isArray(episode))
      : []
  ));
  const actionEventIds = new Set(episodes.flatMap((episode) => (
    Array.isArray(episode.actionEventIds)
      ? episode.actionEventIds.filter((eventId) => typeof eventId === 'string')
      : []
  )));
  const hasValue = (episode, field, value) => (
    typeof episode[field] === 'string' && episode[field].trim().toLowerCase() === value
  );
  return {
    projectLogisticsEpisodes: episodes.length,
    projectLogisticsFulfilled: episodes.filter((episode) => hasValue(episode, 'status', 'fulfilled')).length,
    projectLogisticsExhausted: episodes.filter((episode) => hasValue(episode, 'status', 'exhausted')).length,
    projectSearchEpisodes: episodes.filter((episode) => hasValue(episode, 'kind', 'search')).length,
    projectDropEpisodes: episodes.filter((episode) => hasValue(episode, 'kind', 'drop')).length,
    projectLogisticsActionEvents: actionEventIds.size,
  };
}

const TERMINAL_INTENT_STATUSES = new Set(['completed', 'blocked', 'failed', 'abandoned']);
const LIVE_INTENT_STATUSES = new Set(['active', 'suspended']);

function interruptIntentMetrics(state) {
  const intents = Array.isArray(state?.intents) ? state.intents : [];
  const people = Array.isArray(state?.people) ? state.people : [];
  const eventById = new Map((Array.isArray(state?.world?.past) ? state.world.past : [])
    .map((event) => [event?.id, event]));
  const children = intents.filter((intent) => (
    typeof intent?.returnToIntentId === 'string' && intent.returnToIntentId.length > 0
  ));
  const liveChildParentIds = new Set(children.flatMap((child) => (
    LIVE_INTENT_STATUSES.has(child.status) ? [child.returnToIntentId] : []
  )));
  const validHibernationSuspendedIntentIds = new Set(intents.flatMap((intent) => {
    if (intent?.status !== 'suspended'
      || typeof intent.suspendedForHibernationConditionId !== 'string'
      || intent.suspendedForHibernationConditionId.length === 0) return [];
    const owner = people.find((person) => person?.id === intent.ownerId);
    return Array.isArray(owner?.conditions) && owner.conditions.some((condition) => (
      condition?.kind === 'dehydrated-hibernation'
      && condition.id === intent.suspendedForHibernationConditionId
    )) ? [intent.id] : [];
  }));
  const resolvedLatencies = children.flatMap((child) => (
    Number.isFinite(child.returnResolvedAtMonth) && Number.isFinite(child.createdAtMonth)
      ? [child.returnResolvedAtMonth - child.createdAtMonth]
      : []
  ));
  const unresolvedTerminalChildren = children.filter((child) => (
    TERMINAL_INTENT_STATUSES.has(child.status)
    && (typeof child.returnOutcome !== 'string' || child.returnOutcome.length === 0)
  ));
  const resumedChildren = children.filter((child) => child.returnOutcome === 'resumed'
    && Number.isFinite(child.returnResolvedAtMonth));
  const resumedParentActed = resumedChildren.filter((child) => {
    const parent = intents.find((intent) => intent.id === child.returnToIntentId);
    return parent && Array.isArray(parent.actionEventIds) && parent.actionEventIds.some((eventId) => {
      const event = eventById.get(eventId);
      return event?.kind === 'action' && Number(event.atMonth) >= child.returnResolvedAtMonth;
    });
  });
  const immediateSameProjectReplacements = resumedChildren.filter((child) => {
    const parent = intents.find((intent) => intent.id === child.returnToIntentId);
    if (!parent || typeof parent.projectId !== 'string' || resumedParentActed.includes(child)) return false;
    return parent.status === 'abandoned'
      && parent.lastResumedAtMonth === child.returnResolvedAtMonth
      && intents.some((intent) => intent.id !== parent.id
        && intent.ownerId === parent.ownerId
        && intent.projectId === parent.projectId
        && intent.createdAtMonth === child.returnResolvedAtMonth);
  });

  return {
    interruptedIntentChildren: children.length,
    interruptLifeReviewChildren: children.filter((child) => child.interruptionKind === 'life-review').length,
    interruptRequiredResponseChildren: children.filter((child) => child.interruptionKind === 'required-response').length,
    interruptFulfillmentChildren: children.filter((child) => child.interruptionKind === 'fulfillment').length,
    interruptChildrenCompleted: children.filter((child) => child.status === 'completed').length,
    interruptChildrenBlocked: children.filter((child) => child.status === 'blocked').length,
    interruptChildrenFailed: children.filter((child) => child.status === 'failed').length,
    interruptChildrenAbandoned: children.filter((child) => child.status === 'abandoned').length,
    interruptReturnsResumed: children.filter((child) => child.returnOutcome === 'resumed').length,
    interruptReturnsParentCompleted: children.filter((child) => child.returnOutcome === 'parent-completed').length,
    interruptReturnsParentBlocked: children.filter((child) => child.returnOutcome === 'parent-blocked').length,
    interruptReturnsParentUnavailable: children.filter((child) => child.returnOutcome === 'parent-unavailable').length,
    interruptUnresolvedTerminalChildren: unresolvedTerminalChildren.length,
    interruptChildrenWithProjectId: children.filter((child) => (
      typeof child.projectId === 'string' && child.projectId.length > 0
    )).length,
    interruptReturnLatencyMeanMonths: resolvedLatencies.length
      ? Math.round(resolvedLatencies.reduce((sum, latency) => sum + latency, 0) / resolvedLatencies.length * 100) / 100
      : null,
    interruptReturnLatencyMaxMonths: resolvedLatencies.length ? Math.max(...resolvedLatencies) : null,
    interruptResumedParentsWithSubsequentAction: resumedParentActed.length,
    interruptResumedParentsWithoutSubsequentAction: resumedChildren.length - resumedParentActed.length,
    interruptImmediateSameProjectReplacements: immediateSameProjectReplacements.length,
    orphanSuspendedProjectIntents: intents.filter((intent) => (
      intent?.status === 'suspended'
      && typeof intent.projectId === 'string'
      && intent.projectId.length > 0
      && !liveChildParentIds.has(intent.id)
      && !validHibernationSuspendedIntentIds.has(intent.id)
    )).length,
  };
}

const PROJECT_PRESSURE_METRIC_NAMES = [
  'projectPressureBasisProjects', 'projectPressureBasisCoverage',
  'projectPressureHistoryEntries', 'projectsWithPressureUpdates', 'projectPressureUpdates',
  'projectPressureIncreases', 'projectPressureDecreases', 'projectPressureUnchangedUpdates',
  'projectPressureDuplicateBasisEntries', 'projectPressureUnresolvedSourceFacts',
  'huntingPressureCrossOwnerSources', 'huntingPressureNonThreatAnimalSources',
  'projectPressureChangesWithoutEdgeChange', 'projectPressureObserverMismatches',
  'projectPressureUpdatesThermalSafety', 'projectPressureUpdatesHuntingSafety',
  'projectPressureUpdatesCareCapability', 'projectPressureUpdatesFoodPreparation',
  'projectPressureUpdatesShelterCapacity', 'projectPressureUpdatesKnowledgePreservation',
];

function projectPressureMetrics(state) {
  const projects = Array.isArray(state?.projects) ? state.projects : [];
  const events = Array.isArray(state?.world?.past) ? state.world.past : [];
  const eventById = new Map(events.map((event) => [event?.id, event]));
  const unresolvedSources = new Set();
  const crossOwnerHuntSources = new Set();
  const nonThreatAnimalSources = new Set();
  const updatesByNeed = new Map();
  let basisProjects = 0;
  let historyEntries = 0;
  let projectsWithUpdates = 0;
  let updates = 0;
  let increases = 0;
  let decreases = 0;
  let unchanged = 0;
  let duplicateBasisEntries = 0;
  let changesWithoutEdgeChange = 0;
  let observerMismatches = 0;

  const edgeSignature = (basis) => JSON.stringify({
    need: basis?.need ?? null,
    observerId: basis?.observerId ?? null,
    edges: Array.isArray(basis?.edgeKeys) ? [...basis.edgeKeys].sort() : [],
  });

  const auditSource = (project, sourceId) => {
    const event = eventById.get(sourceId);
    const sourceKey = `${project.id}\u0000${sourceId}`;
    if (!event) unresolvedSources.add(sourceKey);
    if (project.need !== 'hunting-safety' || !event) return;
    if (event.kind === 'action'
      && event.action?.kind === 'act'
      && event.action.operation === 'hunt'
      && event.who !== project.ownerId) crossOwnerHuntSources.add(sourceKey);
    if (event.kind === 'environment'
      && event.change === 'animal'
      && (event.diff?.process !== 'attack-human' || event.diff?.victimId !== project.ownerId)) {
      nonThreatAnimalSources.add(sourceKey);
    }
  };

  for (const project of projects) {
    if (project?.pressureBasis && typeof project.pressureBasis === 'object') basisProjects += 1;
    const history = Array.isArray(project?.pressureHistory)
      ? project.pressureHistory.filter((basis) => basis && typeof basis === 'object')
      : [];
    historyEntries += history.length;
    if (history.length > 1) projectsWithUpdates += 1;
    const seenBasisKeys = new Set();
    for (const [index, basis] of history.entries()) {
      if (basis.observerId !== project.ownerId) observerMismatches += 1;
      if (typeof basis.basisKey === 'string' && basis.basisKey.length) {
        if (seenBasisKeys.has(basis.basisKey)) duplicateBasisEntries += 1;
        else seenBasisKeys.add(basis.basisKey);
      }
      for (const sourceId of Array.isArray(basis.sourceFactIds) ? basis.sourceFactIds : []) {
        auditSource(project, sourceId);
      }
      if (index === 0) continue;
      updates += 1;
      updatesByNeed.set(project.need, (updatesByNeed.get(project.need) ?? 0) + 1);
      const previous = history[index - 1];
      if (Number(basis.pressure) > Number(previous.pressure)) increases += 1;
      else if (Number(basis.pressure) < Number(previous.pressure)) decreases += 1;
      else unchanged += 1;
      if (edgeSignature(basis) === edgeSignature(previous)) changesWithoutEdgeChange += 1;
    }
    for (const sourceId of Array.isArray(project?.triggerFactIds) ? project.triggerFactIds : []) {
      auditSource(project, sourceId);
    }
  }

  return {
    projectPressureBasisProjects: basisProjects,
    projectPressureBasisCoverage: projects.length ? Math.round(basisProjects / projects.length * 10_000) / 100 : 100,
    projectPressureHistoryEntries: historyEntries,
    projectsWithPressureUpdates: projectsWithUpdates,
    projectPressureUpdates: updates,
    projectPressureIncreases: increases,
    projectPressureDecreases: decreases,
    projectPressureUnchangedUpdates: unchanged,
    projectPressureDuplicateBasisEntries: duplicateBasisEntries,
    projectPressureUnresolvedSourceFacts: unresolvedSources.size,
    huntingPressureCrossOwnerSources: crossOwnerHuntSources.size,
    huntingPressureNonThreatAnimalSources: nonThreatAnimalSources.size,
    projectPressureChangesWithoutEdgeChange: changesWithoutEdgeChange,
    projectPressureObserverMismatches: observerMismatches,
    projectPressureUpdatesThermalSafety: updatesByNeed.get('thermal-safety') ?? 0,
    projectPressureUpdatesHuntingSafety: updatesByNeed.get('hunting-safety') ?? 0,
    projectPressureUpdatesCareCapability: updatesByNeed.get('care-capability') ?? 0,
    projectPressureUpdatesFoodPreparation: updatesByNeed.get('food-preparation') ?? 0,
    projectPressureUpdatesShelterCapacity: updatesByNeed.get('shelter-capacity') ?? 0,
    projectPressureUpdatesKnowledgePreservation: updatesByNeed.get('knowledge-preservation') ?? 0,
  };
}

const PROJECT_PROGRESS_METRIC_NAMES = [
  'projectProgressEvidenceCount', 'projectProgressProjects',
  'projectLogisticsAdvanceProgress', 'projectMaterialContributionProgress',
  'projectProgressDuplicateEvents', 'projectProgressUnresolvedEvents',
  'projectProgressActorMismatches', 'projectProgressEpisodeMismatches',
  'projectProgressIntentMismatches', 'projectProgressNonAdvancingLogistics',
  'projectProgressEventsAfterTermination', 'projectStagnationBlocksWithRecentProgress',
  'projectTerminalMonthCoverage', 'projectsBlockedAfterLogisticsProgress',
];

function projectProgressMetrics(state) {
  const projects = Array.isArray(state?.projects) ? state.projects : [];
  const events = Array.isArray(state?.world?.past) ? state.world.past : [];
  const intents = Array.isArray(state?.intents) ? state.intents : [];
  const eventById = new Map(events.map((event) => [event?.id, event]));
  const intentById = new Map(intents.map((intent) => [intent?.id, intent]));
  const unresolved = new Set();
  let evidenceCount = 0;
  let progressProjects = 0;
  let logisticsAdvance = 0;
  let materialContribution = 0;
  let duplicateEvents = 0;
  let actorMismatches = 0;
  let episodeMismatches = 0;
  let intentMismatches = 0;
  let nonAdvancing = 0;
  let afterTermination = 0;
  let recentProgressBlocks = 0;
  let blockedAfterLogistics = 0;
  let terminalProjects = 0;
  let terminalMonths = 0;

  const terminalMonth = (project) => project.status === 'completed'
    ? project.completedAtMonth
    : project.status === 'blocked'
      ? project.blockedAtMonth
      : project.status === 'abandoned' ? project.abandonedAtMonth : undefined;

  for (const project of projects) {
    const evidence = Array.isArray(project?.progressEvidence)
      ? project.progressEvidence.filter((item) => item && typeof item === 'object')
      : [];
    if (evidence.length) progressProjects += 1;
    evidenceCount += evidence.length;
    const seen = new Set();
    const endedAt = terminalMonth(project);
    for (const item of evidence) {
      if (seen.has(item.eventId)) duplicateEvents += 1;
      else seen.add(item.eventId);
      const event = eventById.get(item.eventId);
      if (!event) unresolved.add(`${project.id}\u0000${item.eventId}`);
      else {
        if (event.who !== item.actorId) actorMismatches += 1;
        const intent = typeof event.intentId === 'string' ? intentById.get(event.intentId) : undefined;
        if (intent?.projectId && intent.projectId !== project.id) intentMismatches += 1;
      }
      if (Number.isFinite(endedAt) && Number(item.atMonth) > Number(endedAt)) afterTermination += 1;
      if (item.kind === 'logistics-advance') {
        logisticsAdvance += 1;
        if (!Number.isFinite(item.distanceBefore)
          || !Number.isFinite(item.distanceAfter)
          || Number(item.distanceAfter) >= Number(item.distanceBefore)) nonAdvancing += 1;
        const episode = (Array.isArray(project.logisticsEpisodes) ? project.logisticsEpisodes : [])
          .find((candidate) => candidate?.id === item.episodeId);
        if (!episode || episode.actorId !== item.actorId
          || !Array.isArray(episode.actionEventIds) || !episode.actionEventIds.includes(item.eventId)) episodeMismatches += 1;
      } else if (item.kind === 'material-contribution') materialContribution += 1;
    }
    if (project.status !== 'active') {
      terminalProjects += 1;
      if (Number.isFinite(endedAt)) terminalMonths += 1;
    }
    if (project.status === 'blocked'
      && typeof project.blockedReason === 'string'
      && project.blockedReason.startsWith('复核期内')
      && Number.isFinite(project.blockedAtMonth)
      && Number(project.blockedAtMonth) - Number(project.lastProgressAtMonth) < 4) recentProgressBlocks += 1;
    if (project.status === 'blocked' && evidence.some((item) => item.kind === 'logistics-advance')) blockedAfterLogistics += 1;
  }

  return {
    projectProgressEvidenceCount: evidenceCount,
    projectProgressProjects: progressProjects,
    projectLogisticsAdvanceProgress: logisticsAdvance,
    projectMaterialContributionProgress: materialContribution,
    projectProgressDuplicateEvents: duplicateEvents,
    projectProgressUnresolvedEvents: unresolved.size,
    projectProgressActorMismatches: actorMismatches,
    projectProgressEpisodeMismatches: episodeMismatches,
    projectProgressIntentMismatches: intentMismatches,
    projectProgressNonAdvancingLogistics: nonAdvancing,
    projectProgressEventsAfterTermination: afterTermination,
    projectStagnationBlocksWithRecentProgress: recentProgressBlocks,
    projectTerminalMonthCoverage: terminalProjects ? Math.round(terminalMonths / terminalProjects * 10_000) / 100 : 100,
    projectsBlockedAfterLogisticsProgress: blockedAfterLogistics,
  };
}

const SEARCH_CAMPAIGN_METRIC_NAMES = [
  'projectSearchCampaigns', 'projectsWithSearchCampaigns',
  'searchCampaignActive', 'searchCampaignExhausted', 'searchCampaignSuperseded', 'searchCampaignClosed',
  'searchCampaignAttemptedTargets', 'searchCampaignMaxTargets',
  'searchCampaignEpisodeCoverage', 'searchEpisodesMissingCampaign',
  'searchCampaignRepeatedTargets', 'searchCampaignDuplicateBasis',
  'searchCampaignTargetOutsideArea', 'searchCampaignEpisodeTargetNotAttempted',
  'searchCampaignProjectMismatches', 'searchCampaignOwnerMismatches',
  'searchCampaignActorMismatches', 'searchCampaignMaterialMismatches',
  'searchCampaignUnresolvedSourceFacts',
  'searchCampaignsWithInheritedExperience', 'searchCampaignInheritedCampaigns',
  'searchCampaignInheritedTargets', 'searchCampaignExhaustedOnOpen',
  'searchCampaignCrossProjectRepeatedTargets', 'searchCampaignDuplicateInheritedTargets',
  'searchCampaignInheritedTargetOutsideArea', 'searchCampaignInheritedTargetMissingFromSource',
  'searchCampaignUnresolvedInheritedCampaigns', 'searchCampaignInheritedSameProjectSources',
  'searchCampaignInheritedActorMismatches', 'searchCampaignInheritedMaterialMismatches',
  'searchCampaignInheritedPlanMismatches',
];

const MATERIAL_DEMAND_METRIC_NAMES = [
  'projectDropDemandCoverage', 'dropEpisodesWithMaterialDemand',
  'dropDemandRequestedQuantity', 'dropDemandTransferQuantity',
  'dropDemandNonPositiveOutstanding', 'dropDemandBalanceMismatches',
  'dropDemandStartingQuantityMismatches', 'dropDemandStartingAtOrAboveRequired',
  'dropDemandRequestedExceedsOutstanding', 'dropDemandTransferExceedsRequested',
  'dropDemandMaterialMismatches', 'dropDemandActorMismatches',
  'dropDemandUnresolvedActionEvents',
  'projectSearchDemandCoverage', 'searchEpisodesWithMaterialDemands',
  'searchDemandNonPositiveOutstanding', 'searchDemandBalanceMismatches',
  'preparedFoodFiberDropEpisodes', 'preparedFoodFiberEpisodesStartingAboveZero',
  'preparedFoodMaxFiberStartingQuantity', 'preparedFoodMaxFiberRequestedQuantity',
  'preparedFoodProjectsWithExcessStoneTools', 'preparedFoodExcessStoneTools',
];

function projectMaterialDemandMetrics(state) {
  const projects = Array.isArray(state?.projects) ? state.projects : [];
  const events = Array.isArray(state?.world?.past) ? state.world.past : [];
  const eventById = new Map(events.map((event) => [event?.id, event]));
  let dropEpisodes = 0;
  let dropWithDemand = 0;
  let dropRequested = 0;
  let dropTransferred = 0;
  let nonPositive = 0;
  let balanceMismatches = 0;
  let startingMismatches = 0;
  let startingAtOrAbove = 0;
  let requestedExceeds = 0;
  let transferExceeds = 0;
  let materialMismatches = 0;
  let actorMismatches = 0;
  const unresolved = new Set();
  let searchEpisodes = 0;
  let searchWithDemands = 0;
  let searchNonPositive = 0;
  let searchBalanceMismatches = 0;
  let preparedFiberEpisodes = 0;
  let preparedFiberStartingAboveZero = 0;
  let preparedFiberMaxStarting = 0;
  let preparedFiberMaxRequested = 0;
  let preparedProjectsWithExcessTools = 0;
  let preparedExcessTools = 0;

  for (const project of projects) {
    const preparedFood = project?.desiredFunction === 'prepared-food';
    if (preparedFood) {
      const toolOutputs = (project.actionEventIds ?? []).reduce((count, eventId) => {
        const event = eventById.get(eventId);
        return count + (event?.kind === 'action' && event.status === 'completed' && Number(event.diff?.outputMaterialId) === 24 ? 1 : 0);
      }, 0);
      if (toolOutputs > 1) {
        preparedProjectsWithExcessTools += 1;
        preparedExcessTools += toolOutputs - 1;
      }
    }
    for (const episode of Array.isArray(project?.logisticsEpisodes) ? project.logisticsEpisodes : []) {
      if (episode?.kind === 'search') {
        searchEpisodes += 1;
        const demands = Array.isArray(episode.materialDemands) ? episode.materialDemands : [];
        if (demands.length) searchWithDemands += 1;
        for (const demand of demands) {
          const required = Number(demand?.requiredQuantity);
          const available = Number(demand?.availableQuantity);
          const outstanding = Number(demand?.outstandingQuantity);
          if (!(outstanding > 0)) searchNonPositive += 1;
          if (!Number.isFinite(required) || !Number.isFinite(available) || !Number.isFinite(outstanding)
            || available + outstanding !== required) searchBalanceMismatches += 1;
        }
        continue;
      }
      if (episode?.kind !== 'drop') continue;
      dropEpisodes += 1;
      if (preparedFood && episode.materialIds?.[0] === 20) {
        preparedFiberEpisodes += 1;
        const starting = Number(episode.startingQuantity) || 0;
        if (starting > 0) preparedFiberStartingAboveZero += 1;
        preparedFiberMaxStarting = Math.max(preparedFiberMaxStarting, starting);
        preparedFiberMaxRequested = Math.max(preparedFiberMaxRequested, Number(episode.requestedQuantity) || 0);
      }
      const demand = episode.materialDemand;
      if (!demand || typeof demand !== 'object') continue;
      dropWithDemand += 1;
      const required = Number(demand.requiredQuantity);
      const available = Number(demand.availableQuantity);
      const outstanding = Number(demand.outstandingQuantity);
      const requested = Number(episode.requestedQuantity);
      if (!(outstanding > 0)) nonPositive += 1;
      if (!Number.isFinite(required) || !Number.isFinite(available) || !Number.isFinite(outstanding)
        || available + outstanding !== required) balanceMismatches += 1;
      if (Number(episode.startingQuantity) !== available) startingMismatches += 1;
      if (Number(episode.startingQuantity) >= required) startingAtOrAbove += 1;
      if (!Number.isFinite(requested) || requested <= 0 || requested > outstanding) requestedExceeds += 1;
      else dropRequested += requested;
      if (demand.materialId !== episode.materialIds?.[0]) materialMismatches += 1;
      let transferred = 0;
      for (const eventId of Array.isArray(episode.actionEventIds) ? episode.actionEventIds : []) {
        const event = eventById.get(eventId);
        if (!event) {
          unresolved.add(`${episode.id}\u0000${eventId}`);
          continue;
        }
        if (event?.kind !== 'action' || event.action?.kind !== 'transfer' || event.action?.dropId !== episode.sourceRef?.dropId) continue;
        if (event.who !== episode.actorId) actorMismatches += 1;
        if (event.action.materialId !== demand.materialId) materialMismatches += 1;
        if (event.status === 'completed') transferred += Number(event.action.quantity) || 0;
      }
      dropTransferred += transferred;
      if (Number.isFinite(requested) && transferred > requested) transferExceeds += 1;
    }
  }

  return {
    projectDropDemandCoverage: dropEpisodes ? Math.round(dropWithDemand / dropEpisodes * 10_000) / 100 : 100,
    dropEpisodesWithMaterialDemand: dropWithDemand,
    dropDemandRequestedQuantity: dropRequested,
    dropDemandTransferQuantity: dropTransferred,
    dropDemandNonPositiveOutstanding: nonPositive,
    dropDemandBalanceMismatches: balanceMismatches,
    dropDemandStartingQuantityMismatches: startingMismatches,
    dropDemandStartingAtOrAboveRequired: startingAtOrAbove,
    dropDemandRequestedExceedsOutstanding: requestedExceeds,
    dropDemandTransferExceedsRequested: transferExceeds,
    dropDemandMaterialMismatches: materialMismatches,
    dropDemandActorMismatches: actorMismatches,
    dropDemandUnresolvedActionEvents: unresolved.size,
    projectSearchDemandCoverage: searchEpisodes ? Math.round(searchWithDemands / searchEpisodes * 10_000) / 100 : 100,
    searchEpisodesWithMaterialDemands: searchWithDemands,
    searchDemandNonPositiveOutstanding: searchNonPositive,
    searchDemandBalanceMismatches: searchBalanceMismatches,
    preparedFoodFiberDropEpisodes: preparedFiberEpisodes,
    preparedFoodFiberEpisodesStartingAboveZero: preparedFiberStartingAboveZero,
    preparedFoodMaxFiberStartingQuantity: preparedFiberMaxStarting,
    preparedFoodMaxFiberRequestedQuantity: preparedFiberMaxRequested,
    preparedFoodProjectsWithExcessStoneTools: preparedProjectsWithExcessTools,
    preparedFoodExcessStoneTools: preparedExcessTools,
  };
}

const PROJECT_SOURCE_METRIC_NAMES = [
  'projectWoodSourceEpisodes', 'projectsWithWoodSourceEpisodes',
  'woodSourceDemandCoverage', 'woodSourceFulfilled', 'woodSourceInvalidated', 'woodSourceActive',
  'woodSourceMoveActions', 'woodSourceSeparationActions', 'woodSourceOutputQuantity',
  'woodSourceNonWoodDemands', 'woodSourceDemandBalanceMismatches',
  'woodSourceReferenceMismatches', 'woodSourceSnapshotMismatches',
  'woodSourceProjectMismatches', 'woodSourceActorMismatches',
  'woodSourceTargetMismatches', 'woodSourceOutputMismatches',
  'woodSourceFulfilledWithoutProduction', 'woodSourceProductionStatusMismatches',
  'woodSourceUnresolvedActionEvents', 'woodSourceUnresolvedSourceFacts',
  'projectWoodSearchEpisodes', 'woodSearchSourceSnapshotCoverage',
  'woodSearchVisibleSourceAtOpen', 'woodSourceWastedMoveActions',
];

function projectSourceMetrics(state) {
  const projects = Array.isArray(state?.projects) ? state.projects : [];
  const events = Array.isArray(state?.world?.past) ? state.world.past : [];
  const intents = Array.isArray(state?.intents) ? state.intents : [];
  const eventById = new Map(events.map((event) => [event?.id, event]));
  const intentById = new Map(intents.map((intent) => [intent?.id, intent]));
  const unresolvedActions = new Set();
  const unresolvedSources = new Set();
  let sourceEpisodes = 0;
  let projectsWithSources = 0;
  let withDemand = 0;
  let fulfilled = 0;
  let invalidated = 0;
  let active = 0;
  let moveActions = 0;
  let separationActions = 0;
  let outputQuantity = 0;
  let nonWoodDemands = 0;
  let demandBalanceMismatches = 0;
  let referenceMismatches = 0;
  let snapshotMismatches = 0;
  let projectMismatches = 0;
  let actorMismatches = 0;
  let targetMismatches = 0;
  let outputMismatches = 0;
  let fulfilledWithoutProduction = 0;
  let productionStatusMismatches = 0;
  let woodSearchEpisodes = 0;
  let woodSearchSnapshots = 0;
  let woodSearchVisibleAtOpen = 0;
  let wastedMoves = 0;

  for (const project of projects) {
    const episodes = Array.isArray(project?.logisticsEpisodes) ? project.logisticsEpisodes : [];
    const sources = episodes.filter((episode) => episode?.kind === 'source');
    if (sources.length) projectsWithSources += 1;
    for (const episode of episodes.filter((candidate) => candidate?.kind === 'search'
      && Array.isArray(candidate.materialIds) && candidate.materialIds.includes(13))) {
      woodSearchEpisodes += 1;
      if (Number.isFinite(Number(episode.visibleSourceCountAtCreation))) {
        woodSearchSnapshots += 1;
        if (Number(episode.visibleSourceCountAtCreation) > 0) woodSearchVisibleAtOpen += 1;
      }
    }
    for (const episode of sources) {
      sourceEpisodes += 1;
      if (typeof episode.id !== 'string' || !episode.id.startsWith(`project-logistics:${project.id}:`)) {
        projectMismatches += 1;
      }
      const demand = episode.materialDemand;
      if (demand && typeof demand === 'object') {
        withDemand += 1;
        const required = Number(demand.requiredQuantity);
        const available = Number(demand.availableQuantity);
        const outstanding = Number(demand.outstandingQuantity);
        if (Number(demand.materialId) !== 13 || episode.materialIds?.length !== 1 || Number(episode.materialIds[0]) !== 13) {
          nonWoodDemands += 1;
        }
        if (!(outstanding > 0) || !Number.isFinite(required) || !Number.isFinite(available)
          || !Number.isFinite(outstanding) || available + outstanding !== required) demandBalanceMismatches += 1;
      }
      const source = episode.sourceRef;
      if (source?.kind !== 'voxel-source' || !source.position
        || ![13, 14].includes(Number(source.sourceMaterialId))) referenceMismatches += 1;
      if (Number(episode.visibleSourceCountAtCreation) !== 1
        || !Number.isFinite(Number(episode.sourcePathLengthAtCreation))
        || Number(episode.sourcePathLengthAtCreation) < 0) snapshotMismatches += 1;
      for (const sourceId of Array.isArray(episode.sourceEventIds) ? episode.sourceEventIds : []) {
        if (!eventById.has(sourceId)) unresolvedSources.add(`${episode.id}\u0000${sourceId}`);
      }
      let validProduction = false;
      let episodeMoves = 0;
      for (const eventId of Array.isArray(episode.actionEventIds) ? episode.actionEventIds : []) {
        const event = eventById.get(eventId);
        if (!event) {
          unresolvedActions.add(`${episode.id}\u0000${eventId}`);
          continue;
        }
        if (event.who !== episode.actorId) actorMismatches += 1;
        const intent = typeof event.intentId === 'string' ? intentById.get(event.intentId) : undefined;
        if (intent?.projectId && intent.projectId !== project.id) projectMismatches += 1;
        if (event?.kind !== 'action') continue;
        if (event.action?.kind === 'move') {
          moveActions += 1;
          episodeMoves += 1;
          continue;
        }
        if (event.action?.kind !== 'act' || event.action.operation !== 'separate') continue;
        separationActions += 1;
        const target = event.action.targets?.[0];
        const position = source?.kind === 'voxel-source' ? source.position : undefined;
        const targetMatches = target?.kind === 'voxel' && position
          && target.position?.x === position.x
          && target.position?.y === position.y
          && target.position?.z === position.z;
        if (!targetMatches) targetMismatches += 1;
        const produced = Array.isArray(event.diff?.outputs)
          ? event.diff.outputs.filter((output) => Number(output?.materialId) === 13 && Number(output?.quantity) > 0)
          : [];
        if (event.status === 'completed' && (!targetMatches || !produced.length)) outputMismatches += 1;
        if (event.status === 'completed' && targetMatches && produced.length) {
          validProduction = true;
          outputQuantity += produced.reduce((sum, output) => sum + Number(output.quantity), 0);
        }
      }
      if (episode.status === 'fulfilled' && episode.endingReason === 'material-produced') fulfilled += 1;
      else if (episode.status === 'invalidated') invalidated += 1;
      else if (episode.status === 'active') active += 1;
      if (episode.status === 'fulfilled' && episode.endingReason === 'material-produced' && !validProduction) {
        fulfilledWithoutProduction += 1;
      }
      if (validProduction && (episode.status !== 'fulfilled' || episode.endingReason !== 'material-produced')) {
        productionStatusMismatches += 1;
      }
      if (episode.status === 'invalidated') wastedMoves += episodeMoves;
    }
  }

  return {
    projectWoodSourceEpisodes: sourceEpisodes,
    projectsWithWoodSourceEpisodes: projectsWithSources,
    woodSourceDemandCoverage: sourceEpisodes ? Math.round(withDemand / sourceEpisodes * 10_000) / 100 : 100,
    woodSourceFulfilled: fulfilled,
    woodSourceInvalidated: invalidated,
    woodSourceActive: active,
    woodSourceMoveActions: moveActions,
    woodSourceSeparationActions: separationActions,
    woodSourceOutputQuantity: outputQuantity,
    woodSourceNonWoodDemands: nonWoodDemands,
    woodSourceDemandBalanceMismatches: demandBalanceMismatches,
    woodSourceReferenceMismatches: referenceMismatches,
    woodSourceSnapshotMismatches: snapshotMismatches,
    woodSourceProjectMismatches: projectMismatches,
    woodSourceActorMismatches: actorMismatches,
    woodSourceTargetMismatches: targetMismatches,
    woodSourceOutputMismatches: outputMismatches,
    woodSourceFulfilledWithoutProduction: fulfilledWithoutProduction,
    woodSourceProductionStatusMismatches: productionStatusMismatches,
    woodSourceUnresolvedActionEvents: unresolvedActions.size,
    woodSourceUnresolvedSourceFacts: unresolvedSources.size,
    projectWoodSearchEpisodes: woodSearchEpisodes,
    woodSearchSourceSnapshotCoverage: woodSearchEpisodes ? Math.round(woodSearchSnapshots / woodSearchEpisodes * 10_000) / 100 : 100,
    woodSearchVisibleSourceAtOpen: woodSearchVisibleAtOpen,
    woodSourceWastedMoveActions: wastedMoves,
  };
}

const SHELTER_ADAPTATION_METRIC_NAMES = [
  'shelterAdaptationProjects', 'shelterAdaptationCompleted',
  'shelterAdaptationBlocked', 'shelterAdaptationActive', 'shelterAdaptationAbandoned',
  'shelterAdaptationDependentBeneficiaries',
  'shelterAdaptationRequirements', 'shelterAdaptationRequirementCoverage',
  'shelterAdaptationSourceEvents', 'shelterAdaptationSourcedProjects',
  'shelterAdaptationSourceCoverage', 'shelterAdaptationResolvedSourceCoverage',
  'shelterAdaptationPlacements', 'shelterAdaptationProjectsWithPlacements',
  'shelterAdaptationCompletedWithOutcome', 'shelterAdaptationOutcomeCoverage',
  'shelterAdaptationOutcomeEvidenceCoverage',
  'shelterAdaptationBaselineEnclosedSides', 'shelterAdaptationBaselineOpenSides',
  'shelterAdaptationCompletedEnclosedSides', 'shelterAdaptationCompletedOpenSides',
  'shelterAdaptationEnclosedSideGain', 'shelterAdaptationWeatherProtectionGain',
  'shelterAdaptationThermalInsulationGain', 'shelterAdaptationProtectionImprovements',
  'shelterAdaptationMissingRequirements', 'shelterAdaptationProjectsMissingSources',
  'shelterAdaptationUnresolvedSourceEvents', 'shelterAdaptationNonConditionSourceEvents',
  'shelterAdaptationSourceBeneficiaryMismatches',
  'shelterAdaptationSourceExposureKindMismatches',
  'shelterAdaptationSourceEventsAfterCreation', 'shelterAdaptationSourceSiteMismatches',
  'shelterAdaptationProjectBeneficiaryMismatches',
  'shelterAdaptationInvalidDependentBeneficiaries',
  'shelterAdaptationInvalidBaselinesOrMinimums',
  'shelterAdaptationInvalidOpenSideBaselines',
  'shelterAdaptationMissingSites', 'shelterAdaptationDuplicateActiveOwnerSites',
  'shelterAdaptationCompletedMissingOutcome',
  'shelterAdaptationCompletedBelowMinimumSides',
  'shelterAdaptationCompletedWeatherNotImproved',
  'shelterAdaptationCompletedThermalNotImproved',
  'shelterAdaptationOutcomesOnNonCompletedProjects',
  'shelterAdaptationEntranceSealingProjects',
  'shelterAdaptationCompletedWithoutOpenSide',
  'shelterAdaptationOffsitePlacements', 'shelterAdaptationDirectBodyMutationEvents',
  'shelterAdaptationUnresolvedOutcomeEvidence',
  'shelterAdaptationUnresolvedActionEvents', 'shelterAdaptationActionIntentMismatches',
];

const RECORD_USE_METRIC_NAMES = [
  'recordUseShares', 'recordUseReads', 'recordUseExperiments',
  'recordUseExperimentSuccesses', 'recordUseProjectProgresses',
  'completeRecordUseChains', 'recordUseUniqueBases',
  'recordUseActionsMissingBasisKey', 'recordUseUnresolvedProjects',
  'recordUseReaderMismatches', 'recordUseTechniqueMismatches',
  'recordUseExperimentsWithoutRead', 'recordUseProjectMismatches',
  'recordUseUnresolvedActionEvents', 'recordUseAuthorMismatches',
  'recordUsePayloadMismatches', 'recordUseCodebookMismatches',
  'recordUseReadUnderstandingViolations', 'recordUseReadReliabilityViolations',
  'recordUseExperimentOutputMismatches', 'recordUseExperimentConfidenceMismatches',
];

const HYPOTHESIS_METRIC_NAMES = [
  'hypothesisCampaigns', 'hypothesisCandidates', 'hypothesisAttempts', 'hypothesisResponses',
  'hypothesisNoResponses', 'hypothesisExhaustedCampaigns',
  'hypothesisFirstAttemptResponses', 'hypothesisFirstAttemptNoResponses',
  'hypothesisCombineAttempts', 'hypothesisCombineResponses', 'hypothesisCombineNoResponses',
  'hypothesisExertAttempts', 'hypothesisExertResponses', 'hypothesisExertNoResponses',
  'hypothesisExposeAttempts', 'hypothesisExposeResponses', 'hypothesisExposeNoResponses',
  'hypothesisConnectManipulatorShapesCandidates',
  'hypothesisConnectManipulatorShapesAttempts',
  'hypothesisConnectManipulatorShapesResponses',
  'hypothesisConnectManipulatorShapesNoResponses',
  'hypothesisConnectFlexibleLayersCandidates',
  'hypothesisConnectFlexibleLayersAttempts',
  'hypothesisConnectFlexibleLayersResponses',
  'hypothesisConnectFlexibleLayersNoResponses',
  'hypothesisSeekLocalHeatCandidates', 'hypothesisSeekLocalHeatAttempts',
  'hypothesisSeekLocalHeatResponses', 'hypothesisSeekLocalHeatNoResponses',
  'hypothesisShapePortableSurfaceCandidates', 'hypothesisShapePortableSurfaceAttempts',
  'hypothesisShapePortableSurfaceResponses', 'hypothesisShapePortableSurfaceNoResponses',
  'hypothesisTransformSubjectWithObservedHeatCandidates',
  'hypothesisTransformSubjectWithObservedHeatAttempts',
  'hypothesisTransformSubjectWithObservedHeatResponses',
  'hypothesisTransformSubjectWithObservedHeatNoResponses',
  'hypothesisCandidatesWithRoleBasis', 'hypothesisAttemptsWithRoleBasis',
  'hypothesisCandidateRoleBasisCoverage', 'hypothesisAttemptRoleBasisCoverage',
  'hypothesisCandidatesWithEntityRoleBasis', 'hypothesisAttemptsWithEntityRoleBasis',
  'hypothesisActionDiffsWithEntityRoleBasis',
  'hypothesisCandidateEntityRoleBasisCoverage', 'hypothesisAttemptEntityRoleBasisCoverage',
  'hypothesisActionDiffEntityRoleBasisCoverage',
  'hypothesisCandidatesMissingQuestionKind', 'hypothesisCandidatesMissingRoleBasis',
  'hypothesisAttemptsMissingQuestionKind', 'hypothesisAttemptsMissingRoleBasis',
  'hypothesisCandidateAttemptRoleBasisMismatches', 'hypothesisActionDiffRoleBasisMismatches',
  'hypothesisNonFiniteRoleScores', 'hypothesisQuestionOperationMismatches',
  'hypothesisExertVerifiedResponseToolAttempts', 'hypothesisExertVerifiedResponseInputAttempts',
  'hypothesisExactEntityVerifiedResponseToolAttempts',
  'hypothesisExactEntityVerifiedResponseInputAttempts',
  'hypothesisMaterialOnlyVerifiedResponseAttributionViolations',
  'hypothesisVerifiedResponses', 'hypothesisResponseDrivenTransitions',
  'hypothesisUniquePairs', 'hypothesisUniqueSignatures', 'hypothesisUnresolvedProjects',
  'hypothesisProjectMismatches', 'hypothesisUnresolvedActors',
  'hypothesisActorMismatches', 'hypothesisUnresolvedCampaigns',
  'hypothesisCampaignMismatches', 'hypothesisUnresolvedActionEvents',
  'hypothesisActionMismatches', 'hypothesisOperationMismatches',
  'hypothesisDuplicateProjectPairs', 'hypothesisDuplicateProjectSignatures',
  'hypothesisBudgetExceeds', 'hypothesisTotalBudgetExceeds',
  'hypothesisNoResponseBudgetExceeds', 'hypothesisResponseBudgetExceeds',
  'hypothesisAttemptOrdinalMismatches', 'hypothesisActionDiffPairMismatches',
  'hypothesisActionDiffSignatureMismatches', 'hypothesisActionDiffOutcomeMismatches',
  'hypothesisMissingSourceKeys', 'hypothesisReliableKnowledgeViolations',
];

const INQUIRY_OPPORTUNITY_METRIC_NAMES = [
  'inquiryOpportunityBasisProjects', 'inquiryOpportunityBasisCoverage',
  'inquiryOpportunityFailedProjects', 'inquiryOpportunityTerminalBasisProjects',
  'inquiryOpportunityTerminalBasisCoverage',
  'inquiryOpportunityRenewalProjects', 'inquiryOpportunityRenewalKeys',
  'inquiryOpportunityReopenWithoutRenewalViolations',
  'inquiryOpportunityUnresolvedInheritedProjects',
  'inquiryOpportunityInheritedActorMismatches',
  'inquiryOpportunityInheritedFunctionMismatches',
  'inquiryOpportunityInheritedStatusMismatches',
  'inquiryOpportunityRenewalKeyMismatches',
  'hypothesisReliableNoResponseExcessAttempts',
  'inquiryOpportunityRenewalHypothesisProjects',
  'inquiryOpportunityRenewalHypothesisCandidateCoverage',
  'inquiryOpportunityRenewalHypothesisAttemptProjects',
  'inquiryOpportunityRenewalHypothesisFirstAttemptCoverage',
  'inquiryOpportunitySourceBasisProjects',
  'inquiryOpportunitySourceBasisCoverage',
  'inquiryOpportunityRenewalCommitmentProjects',
  'inquiryOpportunityRenewalCommitmentProjectCoverage',
  'inquiryOpportunityRenewalCommitmentSourceCoverage',
  'inquiryOpportunityUnresolvedSources',
  'inquiryOpportunityRenewalCommitmentActorMismatches',
  'inquiryOpportunityRenewalCommitmentFunctionMismatches',
  'inquiryOpportunityRenewalCommitmentInheritedStatusMismatches',
  'inquiryOpportunityRenewalFirstCandidateExactSourceCoverage',
  'inquiryOpportunityRenewalFirstAttemptExactSourceCoverage',
  'inquiryOpportunityRenewalFallbackBeforeCommitmentViolations',
  'inquiryOpportunityMaterialOnlyCommitmentAttributionViolations',
];

const TECHNIQUE_LEARNING_METRIC_NAMES = [
  'techniqueDemonstrationRequestAttempts', 'techniqueDemonstrationRequests',
  'techniqueDemonstrationUniqueProjectTeachers', 'techniqueDemonstrationDuplicateRequests',
  'techniqueDemonstrationActions', 'techniqueDemonstrationResponses',
  'techniqueDemonstrationBases', 'techniqueDemonstrationSourcedBases',
  'techniqueDemonstrationSourceCoverage', 'techniqueDemonstrationExactSourceCoverage',
  'techniqueDemonstrationTentativeLessons',
  'techniqueDemonstrationDirectReliableViolations',
  'techniqueDemonstrationUnresolvedBases',
  'techniqueDemonstrationUnresolvedRequestEvents',
  'techniqueDemonstrationUnresolvedActionEvents',
  'techniqueDemonstrationRequestPersonMismatches',
  'techniqueDemonstrationRequestProjectMismatches',
  'techniqueDemonstrationRequestFunctionMismatches',
  'techniqueDemonstrationDemonstratorMismatches',
  'techniqueDemonstrationDemonstratorReliabilityMismatches',
  'techniqueDemonstrationLearnerMismatches',
  'techniqueDemonstrationProjectMismatches',
  'techniqueDemonstrationFunctionMismatches',
  'techniqueDemonstrationColocationMismatches',
  'techniqueDemonstrationTechniqueMismatches',
  'techniqueDemonstrationOperationMismatches',
  'techniqueDemonstrationResponseMismatches',
  'techniqueDemonstrationOrderViolations',
  'techniqueDemonstrationSourceMismatches',
  'techniqueDemonstrationExactSourceMismatches',
  'techniqueImitationAttempts', 'techniqueImitationResponses',
  'techniqueImitationExactSourceCoverage', 'techniqueImitationUnresolvedBases',
  'techniqueImitationSourceMismatches', 'techniqueImitationActorMismatches',
  'techniqueImitationProjectMismatches', 'techniqueImitationTechniqueMismatches',
  'techniqueImitationOperationMismatches', 'techniqueImitationResponseMismatches',
  'techniqueImitationOrderViolations', 'techniqueImitationExactSourceMismatches',
  'techniqueDemonstrationReliableLearners',
  'techniqueReliableWithoutOwnImitationViolations',
  'completeTechniqueLearningChains',
  'completeTechniqueLearningProjectProgressChains',
  'completeTechniqueLearningProjectCompletionChains',
  'generationGtZeroCausalReliableLearners', 'unrequestedTechniqueTeaches',
];

const SHELTER_ADAPTATION_BODY_DIFF_KEYS = new Set([
  'health', 'hydration', 'nutrition', 'body', 'conditions',
  'caredPersonId', 'careMaterialId', 'condition', 'conditionId', 'sourceConditionId',
  'fromStage', 'toStage', 'restrainedPersonId', 'releasedPersonId',
  'victimId', 'damage', 'counterDamage',
  'conceived', 'femaleId', 'maleId', 'dueAtMonth',
  'dehydratedPersonId', 'rehydratedPersonId', 'assistedDependentId',
  'bornPersonId', 'diedPersonId',
]);

function shelterAdaptationMetrics(state) {
  const projects = Array.isArray(state?.projects) ? state.projects : [];
  const events = Array.isArray(state?.world?.past) ? state.world.past : [];
  const intents = Array.isArray(state?.intents) ? state.intents : [];
  const people = Array.isArray(state?.people) ? state.people : [];
  const eventById = new Map(events.map((event) => [event?.id, event]));
  const intentById = new Map(intents.map((intent) => [intent?.id, intent]));
  const personById = new Map(people.map((person) => [person?.id, person]));
  const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const adaptations = projects.filter((project) => isRecord(project) && (
    Object.prototype.hasOwnProperty.call(project, 'shelterRequirement')
    || Object.prototype.hasOwnProperty.call(project, 'shelterOutcome')
  ));
  const coverage = (numerator, denominator) => (
    denominator ? Math.round(numerator / denominator * 10_000) / 100 : 100
  );
  const gridWidth = Number(state?.world?.grid?.width);
  const gridDepth = Number(state?.world?.grid?.depth);
  const validSite = (project) => Number.isInteger(project?.site?.cellId)
    && Number(project.site.cellId) >= 0
    && Number.isInteger(project?.site?.z);
  const placementAtSiteSide = (project, target) => {
    if (!validSite(project)
      || target?.kind !== 'voxel'
      || !Number.isInteger(target.position?.x)
      || !Number.isInteger(target.position?.y)
      || !Number.isInteger(target.position?.z)
      || !Number.isInteger(gridWidth) || gridWidth <= 0
      || !Number.isInteger(gridDepth) || gridDepth <= 0
      || target.position.x < 0 || target.position.x >= gridWidth
      || target.position.y < 0 || target.position.y >= gridDepth) return false;
    const siteX = Number(project.site.cellId) % gridWidth;
    const siteY = Math.floor(Number(project.site.cellId) / gridWidth);
    return target.position.z === project.site.z
      && Math.abs(target.position.x - siteX) + Math.abs(target.position.y - siteY) === 1;
  };

  let completed = 0;
  let blocked = 0;
  let active = 0;
  let abandoned = 0;
  let dependentBeneficiaries = 0;
  let requirements = 0;
  let sourcedProjects = 0;
  let sourceEvents = 0;
  let resolvedSourceEvents = 0;
  let placements = 0;
  let projectsWithPlacements = 0;
  let completedWithOutcome = 0;
  let completedOutcomesWithEvidence = 0;
  let baselineEnclosedSides = 0;
  let baselineOpenSides = 0;
  let completedEnclosedSides = 0;
  let completedOpenSides = 0;
  let enclosedSideGain = 0;
  let weatherProtectionGain = 0;
  let thermalInsulationGain = 0;
  let protectionImprovements = 0;
  let missingRequirements = 0;
  let projectsMissingSources = 0;
  let nonConditionSources = 0;
  let sourceBeneficiaryMismatches = 0;
  let sourceExposureMismatches = 0;
  let sourceEventsAfterCreation = 0;
  let sourceSiteMismatches = 0;
  let projectBeneficiaryMismatches = 0;
  let invalidDependentBeneficiaries = 0;
  let invalidBaselinesOrMinimums = 0;
  let invalidOpenSideBaselines = 0;
  let missingSites = 0;
  let completedMissingOutcome = 0;
  let completedBelowMinimumSides = 0;
  let completedWeatherNotImproved = 0;
  let completedThermalNotImproved = 0;
  let outcomesOnNonCompletedProjects = 0;
  let entranceSealingProjects = 0;
  let completedWithoutOpenSide = 0;
  let offsitePlacements = 0;
  let directBodyMutationEvents = 0;
  let actionIntentMismatches = 0;
  const activeOwnerSiteCounts = new Map();
  const unresolvedSources = new Set();
  const unresolvedOutcomeEvidence = new Set();
  const unresolvedActionEvents = new Set();

  for (const [projectIndex, project] of adaptations.entries()) {
    const projectKey = typeof project?.id === 'string' ? project.id : `project-${projectIndex}`;
    const requirement = isRecord(project.shelterRequirement) ? project.shelterRequirement : null;
    const outcome = isRecord(project.shelterOutcome) ? project.shelterOutcome : null;
    if (project.status === 'completed') completed += 1;
    else if (project.status === 'blocked') blocked += 1;
    else if (project.status === 'active') active += 1;
    else if (project.status === 'abandoned') abandoned += 1;

    if (!validSite(project)) missingSites += 1;
    if (project.status === 'active' && validSite(project) && typeof project.ownerId === 'string') {
      const key = `${project.ownerId}\u0000${project.site.cellId}\u0000${project.site.z}`;
      activeOwnerSiteCounts.set(key, (activeOwnerSiteCounts.get(key) ?? 0) + 1);
    }

    if (!requirement) missingRequirements += 1;
    else {
      requirements += 1;
      const baselineSides = requirement.baselineEnclosedSides;
      const baselineOpen = requirement.baselineOpenSides;
      const baselineWeather = requirement.baselineWeatherProtection;
      const baselineThermal = requirement.baselineThermalInsulation;
      const minimumSides = requirement.minimumEnclosedSides;
      if (!Number.isInteger(baselineSides) || baselineSides < 0 || baselineSides >= 3
        || !Number.isFinite(baselineWeather) || baselineWeather < 0 || baselineWeather > 100
        || !Number.isFinite(baselineThermal) || baselineThermal < 0 || baselineThermal > 100
        || !Number.isInteger(minimumSides) || minimumSides !== 3 || minimumSides <= baselineSides) {
        invalidBaselinesOrMinimums += 1;
      }
      if (!Number.isInteger(baselineOpen) || baselineOpen < 1 || baselineOpen > 4
        || (Number.isInteger(baselineSides) && baselineSides + baselineOpen > 4)) {
        invalidOpenSideBaselines += 1;
      }
      if (Number.isFinite(baselineSides)) baselineEnclosedSides += Number(baselineSides);
      if (Number.isFinite(baselineOpen)) baselineOpenSides += Number(baselineOpen);

      const beneficiaryIds = Array.isArray(project.beneficiaryIds)
        ? project.beneficiaryIds.filter((personId) => typeof personId === 'string') : [];
      if (beneficiaryIds.length !== 1 || beneficiaryIds[0] !== requirement.beneficiaryId) {
        projectBeneficiaryMismatches += 1;
      }
      if (typeof requirement.beneficiaryId === 'string'
        && requirement.beneficiaryId !== project.ownerId) {
        dependentBeneficiaries += 1;
        const beneficiary = personById.get(requirement.beneficiaryId);
        const ageAtCreation = Number(project.createdAtMonth) - Number(beneficiary?.bornAtMonth);
        if (!beneficiary
          || !Array.isArray(beneficiary.geneticParents)
          || !beneficiary.geneticParents.includes(project.ownerId)
          || !Number.isFinite(ageAtCreation) || ageAtCreation < 0 || ageAtCreation >= 12 * 12) {
          invalidDependentBeneficiaries += 1;
        }
      }

      const sourceIds = Array.isArray(requirement.sourceEventIds)
        ? requirement.sourceEventIds.filter((eventId) => typeof eventId === 'string' && eventId.length > 0)
        : [];
      sourceEvents += sourceIds.length;
      if (sourceIds.length) sourcedProjects += 1;
      else projectsMissingSources += 1;
      for (const sourceId of sourceIds) {
        const event = eventById.get(sourceId);
        if (!event) {
          unresolvedSources.add(`${projectKey}\u0000${sourceId}`);
          continue;
        }
        resolvedSourceEvents += 1;
        if (event.kind !== 'environment' || event.change !== 'condition') nonConditionSources += 1;
        if (event.who !== requirement.beneficiaryId) sourceBeneficiaryMismatches += 1;
        if (event.diff?.condition !== requirement.exposureKind) sourceExposureMismatches += 1;
        if (Number.isFinite(event.atMonth) && Number.isFinite(project.createdAtMonth)
          && Number(event.atMonth) >= Number(project.createdAtMonth)) sourceEventsAfterCreation += 1;
        if (!validSite(project) || event.cellId !== project.site.cellId) sourceSiteMismatches += 1;
      }
    }

    const projectIntents = intents.filter((intent) => intent?.projectId === project.id);
    const projectIntentIds = new Set(projectIntents.flatMap((intent) => (
      typeof intent?.id === 'string' ? [intent.id] : []
    )));
    const actionEventIds = new Set([
      ...(Array.isArray(project.actionEventIds)
        ? project.actionEventIds.filter((eventId) => typeof eventId === 'string') : []),
      ...(Array.isArray(project.completionEventIds)
        ? project.completionEventIds.filter((eventId) => typeof eventId === 'string') : []),
      ...(Array.isArray(outcome?.evidenceEventIds)
        ? outcome.evidenceEventIds.filter((eventId) => typeof eventId === 'string') : []),
      ...projectIntents.flatMap((intent) => Array.isArray(intent?.actionEventIds)
        ? intent.actionEventIds.filter((eventId) => typeof eventId === 'string') : []),
      ...events.flatMap((event) => event?.kind === 'action' && projectIntentIds.has(event.intentId)
        && typeof event.id === 'string' ? [event.id] : []),
    ]);
    let projectHasPlacement = false;
    const projectPlacementSides = new Set();
    for (const eventId of actionEventIds) {
      const event = eventById.get(eventId);
      if (!event) {
        unresolvedActionEvents.add(`${projectKey}\u0000${eventId}`);
        continue;
      }
      if (event.kind !== 'action') continue;
      const intent = typeof event.intentId === 'string' ? intentById.get(event.intentId) : undefined;
      if (!intent || intent.projectId !== project.id) actionIntentMismatches += 1;
      if (isRecord(event.diff)
        && Object.keys(event.diff).some((key) => SHELTER_ADAPTATION_BODY_DIFF_KEYS.has(key))) {
        directBodyMutationEvents += 1;
      }
      if (event.status !== 'completed'
        || event.action?.kind !== 'act'
        || event.action.operation !== 'combine') continue;
      const voxelTargets = Array.isArray(event.action.targets)
        ? event.action.targets.filter((target) => target?.kind === 'voxel') : [];
      for (const target of voxelTargets) {
        placements += 1;
        projectHasPlacement = true;
        if (!placementAtSiteSide(project, target)) offsitePlacements += 1;
        else projectPlacementSides.add(`${target.position.x}:${target.position.y}`);
      }
    }
    if (projectHasPlacement) projectsWithPlacements += 1;
    if (Number.isInteger(requirement?.baselineOpenSides)
      && projectPlacementSides.size >= requirement.baselineOpenSides) entranceSealingProjects += 1;

    if (outcome && project.status !== 'completed') outcomesOnNonCompletedProjects += 1;
    if (project.status !== 'completed') continue;
    if (!outcome) {
      completedMissingOutcome += 1;
      continue;
    }
    completedWithOutcome += 1;
    const outcomeEvidenceIds = Array.isArray(outcome.evidenceEventIds)
      ? outcome.evidenceEventIds.filter((eventId) => typeof eventId === 'string' && eventId.length > 0)
      : [];
    if (outcomeEvidenceIds.length) completedOutcomesWithEvidence += 1;
    for (const evidenceId of outcomeEvidenceIds) {
      if (!eventById.has(evidenceId)) unresolvedOutcomeEvidence.add(`${projectKey}\u0000${evidenceId}`);
    }
    if (!Number.isFinite(outcome.enclosedSides)
      || !Number.isFinite(requirement?.minimumEnclosedSides)
      || Number(outcome.enclosedSides) < Number(requirement.minimumEnclosedSides)) {
      completedBelowMinimumSides += 1;
    }
    if (Number.isFinite(outcome.enclosedSides)) {
      completedEnclosedSides += Number(outcome.enclosedSides);
      if (Number.isFinite(requirement?.baselineEnclosedSides)) {
        enclosedSideGain += Number(outcome.enclosedSides) - Number(requirement.baselineEnclosedSides);
      }
    }
    if (!Number.isFinite(outcome.openSides) || Number(outcome.openSides) < 1) completedWithoutOpenSide += 1;
    else completedOpenSides += Number(outcome.openSides);
    const weatherComparable = Number.isFinite(outcome.weatherProtection)
      && Number.isFinite(requirement?.baselineWeatherProtection);
    const thermalComparable = Number.isFinite(outcome.thermalInsulation)
      && Number.isFinite(requirement?.baselineThermalInsulation);
    const weatherImprovement = weatherComparable
      ? Number(outcome.weatherProtection) - Number(requirement.baselineWeatherProtection) : Number.NaN;
    const thermalImprovement = thermalComparable
      ? Number(outcome.thermalInsulation) - Number(requirement.baselineThermalInsulation) : Number.NaN;
    const weatherImproved = weatherComparable && weatherImprovement > 0;
    const thermalImproved = thermalComparable && thermalImprovement > 0;
    if (Number.isFinite(weatherImprovement)) weatherProtectionGain += weatherImprovement;
    if (Number.isFinite(thermalImprovement)) thermalInsulationGain += thermalImprovement;
    if (!weatherImproved) completedWeatherNotImproved += 1;
    if (!thermalImproved) completedThermalNotImproved += 1;
    if (weatherImproved && thermalImproved) protectionImprovements += 1;
  }

  const duplicateActiveOwnerSites = [...activeOwnerSiteCounts.values()]
    .reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  return {
    shelterAdaptationProjects: adaptations.length,
    shelterAdaptationCompleted: completed,
    shelterAdaptationBlocked: blocked,
    shelterAdaptationActive: active,
    shelterAdaptationAbandoned: abandoned,
    shelterAdaptationDependentBeneficiaries: dependentBeneficiaries,
    shelterAdaptationRequirements: requirements,
    shelterAdaptationRequirementCoverage: coverage(requirements, adaptations.length),
    shelterAdaptationSourceEvents: sourceEvents,
    shelterAdaptationSourcedProjects: sourcedProjects,
    shelterAdaptationSourceCoverage: coverage(sourcedProjects, adaptations.length),
    shelterAdaptationResolvedSourceCoverage: coverage(resolvedSourceEvents, sourceEvents),
    shelterAdaptationPlacements: placements,
    shelterAdaptationProjectsWithPlacements: projectsWithPlacements,
    shelterAdaptationCompletedWithOutcome: completedWithOutcome,
    shelterAdaptationOutcomeCoverage: coverage(completedWithOutcome, completed),
    shelterAdaptationOutcomeEvidenceCoverage: coverage(completedOutcomesWithEvidence, completedWithOutcome),
    shelterAdaptationBaselineEnclosedSides: baselineEnclosedSides,
    shelterAdaptationBaselineOpenSides: baselineOpenSides,
    shelterAdaptationCompletedEnclosedSides: completedEnclosedSides,
    shelterAdaptationCompletedOpenSides: completedOpenSides,
    shelterAdaptationEnclosedSideGain: enclosedSideGain,
    shelterAdaptationWeatherProtectionGain: weatherProtectionGain,
    shelterAdaptationThermalInsulationGain: thermalInsulationGain,
    shelterAdaptationProtectionImprovements: protectionImprovements,
    shelterAdaptationMissingRequirements: missingRequirements,
    shelterAdaptationProjectsMissingSources: projectsMissingSources,
    shelterAdaptationUnresolvedSourceEvents: unresolvedSources.size,
    shelterAdaptationNonConditionSourceEvents: nonConditionSources,
    shelterAdaptationSourceBeneficiaryMismatches: sourceBeneficiaryMismatches,
    shelterAdaptationSourceExposureKindMismatches: sourceExposureMismatches,
    shelterAdaptationSourceEventsAfterCreation: sourceEventsAfterCreation,
    shelterAdaptationSourceSiteMismatches: sourceSiteMismatches,
    shelterAdaptationProjectBeneficiaryMismatches: projectBeneficiaryMismatches,
    shelterAdaptationInvalidDependentBeneficiaries: invalidDependentBeneficiaries,
    shelterAdaptationInvalidBaselinesOrMinimums: invalidBaselinesOrMinimums,
    shelterAdaptationInvalidOpenSideBaselines: invalidOpenSideBaselines,
    shelterAdaptationMissingSites: missingSites,
    shelterAdaptationDuplicateActiveOwnerSites: duplicateActiveOwnerSites,
    shelterAdaptationCompletedMissingOutcome: completedMissingOutcome,
    shelterAdaptationCompletedBelowMinimumSides: completedBelowMinimumSides,
    shelterAdaptationCompletedWeatherNotImproved: completedWeatherNotImproved,
    shelterAdaptationCompletedThermalNotImproved: completedThermalNotImproved,
    shelterAdaptationOutcomesOnNonCompletedProjects: outcomesOnNonCompletedProjects,
    shelterAdaptationEntranceSealingProjects: entranceSealingProjects,
    shelterAdaptationCompletedWithoutOpenSide: completedWithoutOpenSide,
    shelterAdaptationOffsitePlacements: offsitePlacements,
    shelterAdaptationDirectBodyMutationEvents: directBodyMutationEvents,
    shelterAdaptationUnresolvedOutcomeEvidence: unresolvedOutcomeEvidence.size,
    shelterAdaptationUnresolvedActionEvents: unresolvedActionEvents.size,
    shelterAdaptationActionIntentMismatches: actionIntentMismatches,
  };
}

function searchCampaignPlan(campaign) {
  if (typeof campaign?.planKnowledgeId === 'string') return campaign.planKnowledgeId;
  const match = typeof campaign?.basisKey === 'string' ? campaign.basisKey.match(/(?:^|\|)plan=([^|]+)/) : null;
  return match?.[1] && match[1] !== 'none' ? match[1] : undefined;
}

function sameSearchMaterials(left, right) {
  return JSON.stringify([...(left ?? [])].sort((a, b) => a - b))
    === JSON.stringify([...(right ?? [])].sort((a, b) => a - b));
}

function searchTargetCellId(key) {
  const separator = typeof key === 'string' ? key.indexOf(':') : -1;
  if (separator <= 0) return null;
  const value = Number(key.slice(0, separator));
  return Number.isInteger(value) ? value : null;
}

function searchCampaignMetrics(state) {
  const projects = Array.isArray(state?.projects) ? state.projects : [];
  const events = Array.isArray(state?.world?.past) ? state.world.past : [];
  const eventById = new Map(events.map((event) => [event?.id, event]));
  const campaignRecords = projects.flatMap((project) => (
    Array.isArray(project?.searchCampaigns)
      ? project.searchCampaigns.filter((campaign) => campaign && typeof campaign === 'object')
        .map((campaign) => ({ project, campaign }))
      : []
  ));
  const campaignById = new Map(campaignRecords.map((record) => [record.campaign.id, record]));
  const unresolved = new Set();
  const unresolvedInherited = new Set();
  let campaignCount = 0;
  let projectsWithCampaigns = 0;
  let active = 0;
  let exhausted = 0;
  let superseded = 0;
  let closed = 0;
  let attemptedTargets = 0;
  let maxTargets = 0;
  let repeatedTargets = 0;
  let duplicateBasis = 0;
  let outsideArea = 0;
  let targetNotAttempted = 0;
  let projectMismatches = 0;
  let ownerMismatches = 0;
  let actorMismatches = 0;
  let materialMismatches = 0;
  let searchEpisodes = 0;
  let linkedSearchEpisodes = 0;
  let campaignsWithInheritedExperience = 0;
  let inheritedCampaigns = 0;
  let inheritedTargets = 0;
  let exhaustedOnOpen = 0;
  let crossProjectRepeatedTargets = 0;
  let duplicateInheritedTargets = 0;
  let inheritedTargetOutsideArea = 0;
  let inheritedTargetMissingFromSource = 0;
  let inheritedSameProjectSources = 0;
  let inheritedActorMismatches = 0;
  let inheritedMaterialMismatches = 0;
  let inheritedPlanMismatches = 0;

  for (const project of projects) {
    const campaigns = Array.isArray(project?.searchCampaigns)
      ? project.searchCampaigns.filter((campaign) => campaign && typeof campaign === 'object') : [];
    const episodes = Array.isArray(project?.logisticsEpisodes) ? project.logisticsEpisodes : [];
    const searches = episodes.filter((episode) => episode?.kind === 'search');
    searchEpisodes += searches.length;
    linkedSearchEpisodes += searches.filter((episode) => typeof episode.searchCampaignId === 'string').length;
    if (campaigns.length) projectsWithCampaigns += 1;
    campaignCount += campaigns.length;
    const seenBasis = new Set();
    for (const campaign of campaigns) {
      if (campaign.status === 'active') active += 1;
      else if (campaign.status === 'exhausted') exhausted += 1;
      else if (campaign.status === 'superseded') superseded += 1;
      else if (campaign.status === 'closed') closed += 1;
      if (seenBasis.has(campaign.basisKey)) duplicateBasis += 1;
      else seenBasis.add(campaign.basisKey);
      if (campaign.projectId !== project.id) projectMismatches += 1;
      if (campaign.ownerId !== project.ownerId) ownerMismatches += 1;
      const attempted = Array.isArray(campaign.attemptedTargetKeys) ? campaign.attemptedTargetKeys : [];
      const inherited = Array.isArray(campaign.inheritedTargetKeys) ? campaign.inheritedTargetKeys : [];
      const inheritedIds = Array.isArray(campaign.inheritedCampaignIds) ? campaign.inheritedCampaignIds : [];
      if (inherited.length || inheritedIds.length) campaignsWithInheritedExperience += 1;
      inheritedCampaigns += inheritedIds.length;
      inheritedTargets += inherited.length;
      duplicateInheritedTargets += inherited.length - new Set(inherited).size;
      if (campaign.status === 'exhausted' && attempted.length === 0 && inherited.length > 0) exhaustedOnOpen += 1;
      attemptedTargets += attempted.length;
      maxTargets = Math.max(maxTargets, attempted.length);
      repeatedTargets += attempted.length - new Set(attempted).size;
      for (const sourceId of Array.isArray(campaign.sourceFactIds) ? campaign.sourceFactIds : []) {
        if (!eventById.has(sourceId)) unresolved.add(`${campaign.id}\u0000${sourceId}`);
      }
      const cells = new Set(Array.isArray(campaign.cellIds) ? campaign.cellIds : []);
      for (const key of inherited) {
        const cellId = searchTargetCellId(key);
        if (cellId === null || !cells.has(cellId)) inheritedTargetOutsideArea += 1;
      }
      const inheritedSourceTargets = new Set();
      for (const sourceCampaignId of inheritedIds) {
        const source = campaignById.get(sourceCampaignId);
        if (!source) {
          unresolvedInherited.add(`${campaign.id}\u0000${sourceCampaignId}`);
          continue;
        }
        if (source.project.id === project.id) inheritedSameProjectSources += 1;
        if (source.campaign.actorId !== campaign.actorId) inheritedActorMismatches += 1;
        if (!sameSearchMaterials(source.campaign.materialIds, campaign.materialIds)) inheritedMaterialMismatches += 1;
        if (searchCampaignPlan(source.campaign) !== searchCampaignPlan(campaign)) inheritedPlanMismatches += 1;
        for (const key of [...(source.campaign.inheritedTargetKeys ?? []), ...(source.campaign.attemptedTargetKeys ?? [])]) {
          inheritedSourceTargets.add(key);
        }
      }
      for (const key of inherited) if (!inheritedSourceTargets.has(key)) inheritedTargetMissingFromSource += 1;
      const earlierPersonalTargets = new Set(campaignRecords.flatMap((record) => {
        if (record.project.id === project.id
          || record.campaign.id === campaign.id
          || record.campaign.actorId !== campaign.actorId
          || (record.campaign.openedAt ?? 0) > (campaign.openedAt ?? 0)
          || !sameSearchMaterials(record.campaign.materialIds, campaign.materialIds)
          || searchCampaignPlan(record.campaign) !== searchCampaignPlan(campaign)) return [];
        return [...(record.campaign.inheritedTargetKeys ?? []), ...(record.campaign.attemptedTargetKeys ?? [])];
      }));
      for (const key of attempted) if (earlierPersonalTargets.has(key)) crossProjectRepeatedTargets += 1;
      const attemptedSet = new Set(attempted);
      const materials = JSON.stringify([...(campaign.materialIds ?? [])].sort((a, b) => a - b));
      for (const episode of searches.filter((candidate) => candidate.searchCampaignId === campaign.id)) {
        if (episode.actorId !== campaign.actorId) actorMismatches += 1;
        if (JSON.stringify([...(episode.materialIds ?? [])].sort((a, b) => a - b)) !== materials) materialMismatches += 1;
        if (!cells.has(episode.target?.cellId)) outsideArea += 1;
        const key = `${episode.target?.cellId}:${episode.target?.z}`;
        if (!attemptedSet.has(key)) targetNotAttempted += 1;
      }
    }
  }

  return {
    projectSearchCampaigns: campaignCount,
    projectsWithSearchCampaigns: projectsWithCampaigns,
    searchCampaignActive: active,
    searchCampaignExhausted: exhausted,
    searchCampaignSuperseded: superseded,
    searchCampaignClosed: closed,
    searchCampaignAttemptedTargets: attemptedTargets,
    searchCampaignMaxTargets: maxTargets,
    searchCampaignEpisodeCoverage: searchEpisodes ? Math.round(linkedSearchEpisodes / searchEpisodes * 10_000) / 100 : 100,
    searchEpisodesMissingCampaign: searchEpisodes - linkedSearchEpisodes,
    searchCampaignRepeatedTargets: repeatedTargets,
    searchCampaignDuplicateBasis: duplicateBasis,
    searchCampaignTargetOutsideArea: outsideArea,
    searchCampaignEpisodeTargetNotAttempted: targetNotAttempted,
    searchCampaignProjectMismatches: projectMismatches,
    searchCampaignOwnerMismatches: ownerMismatches,
    searchCampaignActorMismatches: actorMismatches,
    searchCampaignMaterialMismatches: materialMismatches,
    searchCampaignUnresolvedSourceFacts: unresolved.size,
    searchCampaignsWithInheritedExperience: campaignsWithInheritedExperience,
    searchCampaignInheritedCampaigns: inheritedCampaigns,
    searchCampaignInheritedTargets: inheritedTargets,
    searchCampaignExhaustedOnOpen: exhaustedOnOpen,
    searchCampaignCrossProjectRepeatedTargets: crossProjectRepeatedTargets,
    searchCampaignDuplicateInheritedTargets: duplicateInheritedTargets,
    searchCampaignInheritedTargetOutsideArea: inheritedTargetOutsideArea,
    searchCampaignInheritedTargetMissingFromSource: inheritedTargetMissingFromSource,
    searchCampaignUnresolvedInheritedCampaigns: unresolvedInherited.size,
    searchCampaignInheritedSameProjectSources: inheritedSameProjectSources,
    searchCampaignInheritedActorMismatches: inheritedActorMismatches,
    searchCampaignInheritedMaterialMismatches: inheritedMaterialMismatches,
    searchCampaignInheritedPlanMismatches: inheritedPlanMismatches,
  };
}

function observerBehaviorMetrics(state) {
  const events = Array.isArray(state?.world?.past) ? state.world.past : [];
  const projectIntentIds = new Set((Array.isArray(state?.intents) ? state.intents : []).flatMap((intent) => (
    typeof intent?.id === 'string' && typeof intent?.projectId === 'string' && intent.projectId.length > 0
      ? [intent.id]
      : []
  )));
  const actionPersonMonths = new Set();
  const projectActionPersonMonths = new Set();
  const reproductionOfferIds = new Set();
  const reproductionAcceptanceRefs = [];
  const relationshipProposalBasisKeys = new Set();
  const relationshipProposalDirectedCounts = new Map();
  let reproductionOffers = 0;
  let reproductionAttempts = 0;
  let reproductionConceptions = 0;
  let relationshipProposalOffers = 0;
  let relationshipProposalRepeatedBases = 0;
  let relationshipProposalOffersWithoutBasis = 0;
  let lifeReviewDecisions = 0;
  let projectLifeReviewDecisions = 0;
  const lifeReviewPersonMonths = new Set();
  const lifeReviewBasisKeys = new Set();
  let lifeReviewRepeatedBases = 0;
  const interruptions = interruptIntentMetrics(state);
  const pressure = projectPressureMetrics(state);
  const progress = projectProgressMetrics(state);
  const campaigns = searchCampaignMetrics(state);
  const materialDemands = projectMaterialDemandMetrics(state);
  const projectSources = projectSourceMetrics(state);
  const shelterAdaptation = shelterAdaptationMetrics(state);

  for (const event of events) {
    if (event?.kind === 'decision'
      && typeof event.decision?.reason === 'string'
      && event.decision.reason.startsWith('生活复核：')) {
      lifeReviewDecisions += 1;
      if (typeof event.who === 'string' && Number.isFinite(event.atMonth)) {
        lifeReviewPersonMonths.add(`${event.who}\u0000${event.atMonth}`);
      }
      const basisKey = event.decision.lifeReview?.basisKey;
      if (typeof basisKey === 'string' && basisKey.length) {
        if (lifeReviewBasisKeys.has(basisKey)) lifeReviewRepeatedBases += 1;
        else lifeReviewBasisKeys.add(basisKey);
      }
      if (event.decision.kind === 'revise' && projectIntentIds.has(event.decision.intentId)) {
        projectLifeReviewDecisions += 1;
      }
    }
    if (event?.kind !== 'action') continue;
    if (typeof event.intentId === 'string' && event.intentId.length > 0
      && typeof event.who === 'string' && Number.isFinite(event.atMonth)) {
      const personMonth = `${event.who}\u0000${event.atMonth}`;
      actionPersonMonths.add(personMonth);
      if (projectIntentIds.has(event.intentId)) projectActionPersonMonths.add(personMonth);
    }
    if (event.action?.kind === 'act' && event.action.operation === 'reproduce') {
      reproductionAttempts += 1;
      if (event.diff?.conceived === true) reproductionConceptions += 1;
      continue;
    }
    if (event.status !== 'completed' || event.action?.kind !== 'communicate') continue;
    const content = event.action.content;
    if (content?.kind === 'offer'
      && (content.proposal?.kind === 'reproduce' || content.proposal?.kind === 'companion')) {
      relationshipProposalOffers += 1;
      const proposal = content.proposal;
      const directedKey = `${proposal.kind}\u0000${proposal.proposerId}\u0000${proposal.partnerId}`;
      relationshipProposalDirectedCounts.set(directedKey, (relationshipProposalDirectedCounts.get(directedKey) ?? 0) + 1);
      const basisKey = proposal.basis?.basisKey;
      if (typeof basisKey !== 'string' || !basisKey.length) relationshipProposalOffersWithoutBasis += 1;
      else if (relationshipProposalBasisKeys.has(basisKey)) relationshipProposalRepeatedBases += 1;
      else relationshipProposalBasisKeys.add(basisKey);
    }
    if (content?.kind === 'offer' && content.proposal?.kind === 'reproduce') {
      reproductionOffers += 1;
      if (typeof content.id === 'string') reproductionOfferIds.add(content.id);
    } else if (content?.kind === 'accept' && typeof content.referenceId === 'string') {
      reproductionAcceptanceRefs.push(content.referenceId);
    }
  }

  return {
    actionPersonMonths: actionPersonMonths.size,
    projectActionPersonMonths: projectActionPersonMonths.size,
    projectActionMonthShare: actionPersonMonths.size
      ? Math.round(projectActionPersonMonths.size / actionPersonMonths.size * 10_000) / 100
      : null,
    reproductionOffers,
    reproductionAcceptances: reproductionAcceptanceRefs.filter((referenceId) => reproductionOfferIds.has(referenceId)).length,
    reproductionAttempts,
    reproductionConceptions,
    relationshipProposalOffers,
    relationshipProposalUniqueBases: relationshipProposalBasisKeys.size,
    relationshipProposalRepeatedBases,
    relationshipProposalOffersWithoutBasis,
    relationshipProposalRepeatedDirectedPairs: [...relationshipProposalDirectedCounts.values()].filter((count) => count > 1).length,
    relationshipProposalMaxPerDirectedPair: relationshipProposalDirectedCounts.size
      ? Math.max(...relationshipProposalDirectedCounts.values())
      : 0,
    lifeReviewDecisions,
    projectLifeReviewDecisions,
    lifeReviewPersonMonths: lifeReviewPersonMonths.size,
    lifeReviewSameMonthDuplicates: lifeReviewDecisions - lifeReviewPersonMonths.size,
    lifeReviewUniqueBases: lifeReviewBasisKeys.size,
    lifeReviewRepeatedBases,
    ...interruptions,
    ...pressure,
    ...progress,
    ...campaigns,
    ...materialDemands,
    ...projectSources,
    ...shelterAdaptation,
  };
}

function supplementReportFromState(report, state) {
  const events = Array.isArray(state?.world?.past) ? state.world.past : [];
  const eventMap = new Map(events.map((event) => [event.id, event]));
  const childDeaths = events.filter((event) => event.kind === 'environment'
    && event.change === 'death'
    && Number(event.diff?.ageMonths) < 12 * 12);
  const childExposureDeaths = childDeaths.filter((event) => (Array.isArray(event.diff?.sourceEventIds) ? event.diff.sourceEventIds : [])
    .some((sourceId) => {
      const source = eventMap.get(sourceId);
      return source?.kind === 'environment' && (source.diff?.condition === 'cold' || source.diff?.condition === 'heat');
    }));
  const assistedDependentHibernations = events.filter((event) => event.kind === 'action'
    && event.status === 'completed'
    && event.action?.kind === 'act'
    && event.action.operation === 'dehydrate'
    && typeof event.diff?.assistedDependentId === 'string').length;
  const logistics = projectLogisticsMetrics(state);
  const behavior = observerBehaviorMetrics(state);
  return {
    ...report,
    childDeaths: report.childDeaths ?? childDeaths.length,
    childExposureDeaths: report.childExposureDeaths ?? childExposureDeaths.length,
    assistedDependentHibernations: report.assistedDependentHibernations ?? assistedDependentHibernations,
    projectLogisticsEpisodes: report.projectLogisticsEpisodes ?? logistics.projectLogisticsEpisodes,
    projectLogisticsFulfilled: report.projectLogisticsFulfilled ?? logistics.projectLogisticsFulfilled,
    projectLogisticsExhausted: report.projectLogisticsExhausted ?? logistics.projectLogisticsExhausted,
    projectSearchEpisodes: report.projectSearchEpisodes ?? logistics.projectSearchEpisodes,
    projectDropEpisodes: report.projectDropEpisodes ?? logistics.projectDropEpisodes,
    projectLogisticsActionEvents: report.projectLogisticsActionEvents ?? logistics.projectLogisticsActionEvents,
    actionPersonMonths: report.actionPersonMonths ?? behavior.actionPersonMonths,
    projectActionPersonMonths: report.projectActionPersonMonths ?? behavior.projectActionPersonMonths,
    projectActionMonthShare: report.projectActionMonthShare ?? behavior.projectActionMonthShare,
    reproductionOffers: report.reproductionOffers ?? behavior.reproductionOffers,
    reproductionAcceptances: report.reproductionAcceptances ?? behavior.reproductionAcceptances,
    reproductionAttempts: report.reproductionAttempts ?? behavior.reproductionAttempts,
    reproductionConceptions: report.reproductionConceptions ?? behavior.reproductionConceptions,
    relationshipProposalOffers: report.relationshipProposalOffers ?? behavior.relationshipProposalOffers,
    relationshipProposalUniqueBases: report.relationshipProposalUniqueBases ?? behavior.relationshipProposalUniqueBases,
    relationshipProposalRepeatedBases: report.relationshipProposalRepeatedBases ?? behavior.relationshipProposalRepeatedBases,
    relationshipProposalOffersWithoutBasis: report.relationshipProposalOffersWithoutBasis ?? behavior.relationshipProposalOffersWithoutBasis,
    relationshipProposalRepeatedDirectedPairs: report.relationshipProposalRepeatedDirectedPairs ?? behavior.relationshipProposalRepeatedDirectedPairs,
    relationshipProposalMaxPerDirectedPair: report.relationshipProposalMaxPerDirectedPair ?? behavior.relationshipProposalMaxPerDirectedPair,
    lifeReviewDecisions: report.lifeReviewDecisions ?? behavior.lifeReviewDecisions,
    projectLifeReviewDecisions: report.projectLifeReviewDecisions ?? behavior.projectLifeReviewDecisions,
    lifeReviewPersonMonths: report.lifeReviewPersonMonths ?? behavior.lifeReviewPersonMonths,
    lifeReviewSameMonthDuplicates: report.lifeReviewSameMonthDuplicates ?? behavior.lifeReviewSameMonthDuplicates,
    lifeReviewUniqueBases: report.lifeReviewUniqueBases ?? behavior.lifeReviewUniqueBases,
    lifeReviewRepeatedBases: report.lifeReviewRepeatedBases ?? behavior.lifeReviewRepeatedBases,
    interruptedIntentChildren: behavior.interruptedIntentChildren,
    interruptLifeReviewChildren: behavior.interruptLifeReviewChildren,
    interruptRequiredResponseChildren: behavior.interruptRequiredResponseChildren,
    interruptFulfillmentChildren: behavior.interruptFulfillmentChildren,
    interruptChildrenCompleted: behavior.interruptChildrenCompleted,
    interruptChildrenBlocked: behavior.interruptChildrenBlocked,
    interruptChildrenFailed: behavior.interruptChildrenFailed,
    interruptChildrenAbandoned: behavior.interruptChildrenAbandoned,
    interruptReturnsResumed: behavior.interruptReturnsResumed,
    interruptReturnsParentCompleted: behavior.interruptReturnsParentCompleted,
    interruptReturnsParentBlocked: behavior.interruptReturnsParentBlocked,
    interruptReturnsParentUnavailable: behavior.interruptReturnsParentUnavailable,
    interruptUnresolvedTerminalChildren: behavior.interruptUnresolvedTerminalChildren,
    interruptChildrenWithProjectId: behavior.interruptChildrenWithProjectId,
    interruptReturnLatencyMeanMonths: behavior.interruptReturnLatencyMeanMonths,
    interruptReturnLatencyMaxMonths: behavior.interruptReturnLatencyMaxMonths,
    interruptResumedParentsWithSubsequentAction: behavior.interruptResumedParentsWithSubsequentAction,
    interruptResumedParentsWithoutSubsequentAction: behavior.interruptResumedParentsWithoutSubsequentAction,
    interruptImmediateSameProjectReplacements: behavior.interruptImmediateSameProjectReplacements,
    orphanSuspendedProjectIntents: behavior.orphanSuspendedProjectIntents,
    ...Object.fromEntries(PROJECT_PRESSURE_METRIC_NAMES.map((name) => [name, report[name] ?? behavior[name]])),
    ...Object.fromEntries(PROJECT_PROGRESS_METRIC_NAMES.map((name) => [name, report[name] ?? behavior[name]])),
    ...Object.fromEntries(SEARCH_CAMPAIGN_METRIC_NAMES.map((name) => [name, report[name] ?? behavior[name]])),
    ...Object.fromEntries(MATERIAL_DEMAND_METRIC_NAMES.map((name) => [name, report[name] ?? behavior[name]])),
    ...Object.fromEntries(PROJECT_SOURCE_METRIC_NAMES.map((name) => [name, report[name] ?? behavior[name]])),
    ...Object.fromEntries(SHELTER_ADAPTATION_METRIC_NAMES.map((name) => [name, report[name] ?? behavior[name]])),
  };
}

function summarizeReport(plan, report) {
  const correct = Number(report.correctPredictions ?? 0);
  const incorrect = Number(report.incorrectPredictions ?? 0);
  const strategic = Number(report.strategicIntents ?? 0);
  const social = Number(report.socialIntents ?? 0);
  return {
    ...plan,
    status: report.status,
    throughMonth: report.throughMonth,
    endedEarly: Number(report.throughMonth) < plan.months,
    outcomeKind: report.outcome?.kind ?? null,
    initialPopulation: report.initialPopulation,
    finalPopulation: report.finalPopulation,
    births: report.births,
    ...Object.fromEntries(PROJECT_PRESSURE_METRIC_NAMES.map((name) => [name, optionalNumber(report[name])])),
    ...Object.fromEntries(PROJECT_PROGRESS_METRIC_NAMES.map((name) => [name, optionalNumber(report[name])])),
    ...Object.fromEntries(SEARCH_CAMPAIGN_METRIC_NAMES.map((name) => [name, optionalNumber(report[name])])),
    ...Object.fromEntries(MATERIAL_DEMAND_METRIC_NAMES.map((name) => [name, optionalNumber(report[name])])),
    ...Object.fromEntries(PROJECT_SOURCE_METRIC_NAMES.map((name) => [name, optionalNumber(report[name])])),
    ...Object.fromEntries(SHELTER_ADAPTATION_METRIC_NAMES.map((name) => [name, optionalNumber(report[name])])),
    ...Object.fromEntries(RECORD_USE_METRIC_NAMES.map((name) => [name, optionalNumber(report[name])])),
    ...Object.fromEntries(HYPOTHESIS_METRIC_NAMES.map((name) => [name, optionalNumber(report[name])])),
    ...Object.fromEntries(INQUIRY_OPPORTUNITY_METRIC_NAMES.map((name) => [name, optionalNumber(report[name])])),
    ...Object.fromEntries(TECHNIQUE_LEARNING_METRIC_NAMES.map((name) => [name, optionalNumber(report[name])])),
    reproductionOffers: optionalNumber(report.reproductionOffers),
    reproductionAcceptances: optionalNumber(report.reproductionAcceptances),
    reproductionAttempts: optionalNumber(report.reproductionAttempts),
    reproductionConceptions: optionalNumber(report.reproductionConceptions),
    relationshipProposalOffers: optionalNumber(report.relationshipProposalOffers),
    relationshipProposalUniqueBases: optionalNumber(report.relationshipProposalUniqueBases),
    relationshipProposalRepeatedBases: optionalNumber(report.relationshipProposalRepeatedBases),
    relationshipProposalOffersWithoutBasis: optionalNumber(report.relationshipProposalOffersWithoutBasis),
    relationshipProposalRepeatedDirectedPairs: optionalNumber(report.relationshipProposalRepeatedDirectedPairs),
    relationshipProposalMaxPerDirectedPair: optionalNumber(report.relationshipProposalMaxPerDirectedPair),
    lifeReviewDecisions: optionalNumber(report.lifeReviewDecisions),
    projectLifeReviewDecisions: optionalNumber(report.projectLifeReviewDecisions),
    lifeReviewPersonMonths: optionalNumber(report.lifeReviewPersonMonths),
    lifeReviewSameMonthDuplicates: optionalNumber(report.lifeReviewSameMonthDuplicates),
    lifeReviewUniqueBases: optionalNumber(report.lifeReviewUniqueBases),
    lifeReviewRepeatedBases: optionalNumber(report.lifeReviewRepeatedBases),
    interruptedIntentChildren: optionalNumber(report.interruptedIntentChildren),
    interruptLifeReviewChildren: optionalNumber(report.interruptLifeReviewChildren),
    interruptRequiredResponseChildren: optionalNumber(report.interruptRequiredResponseChildren),
    interruptFulfillmentChildren: optionalNumber(report.interruptFulfillmentChildren),
    interruptChildrenCompleted: optionalNumber(report.interruptChildrenCompleted),
    interruptChildrenBlocked: optionalNumber(report.interruptChildrenBlocked),
    interruptChildrenFailed: optionalNumber(report.interruptChildrenFailed),
    interruptChildrenAbandoned: optionalNumber(report.interruptChildrenAbandoned),
    interruptReturnsResumed: optionalNumber(report.interruptReturnsResumed),
    interruptReturnsParentCompleted: optionalNumber(report.interruptReturnsParentCompleted),
    interruptReturnsParentBlocked: optionalNumber(report.interruptReturnsParentBlocked),
    interruptReturnsParentUnavailable: optionalNumber(report.interruptReturnsParentUnavailable),
    interruptUnresolvedTerminalChildren: optionalNumber(report.interruptUnresolvedTerminalChildren),
    interruptChildrenWithProjectId: optionalNumber(report.interruptChildrenWithProjectId),
    interruptReturnLatencyMeanMonths: optionalNumber(report.interruptReturnLatencyMeanMonths),
    interruptReturnLatencyMaxMonths: optionalNumber(report.interruptReturnLatencyMaxMonths),
    interruptResumedParentsWithSubsequentAction: optionalNumber(report.interruptResumedParentsWithSubsequentAction),
    interruptResumedParentsWithoutSubsequentAction: optionalNumber(report.interruptResumedParentsWithoutSubsequentAction),
    interruptImmediateSameProjectReplacements: optionalNumber(report.interruptImmediateSameProjectReplacements),
    orphanSuspendedProjectIntents: optionalNumber(report.orphanSuspendedProjectIntents),
    deaths: report.deaths,
    childDeaths: optionalNumber(report.childDeaths),
    childExposureDeaths: optionalNumber(report.childExposureDeaths),
    civilizationIndex: report.civilizationIndex?.total ?? null,
    civilizationIndexFormulaVersion: report.civilizationIndex?.formulaVersion ?? null,
    civilizationComponents: Object.fromEntries(Object.entries(report.civilizationIndex?.components ?? {}).map(([key, value]) => [key, value.score])),
    completedActions: report.completedActions,
    actionPersonMonths: optionalNumber(report.actionPersonMonths),
    projectActionPersonMonths: optionalNumber(report.projectActionPersonMonths),
    projectActionMonthShare: optionalNumber(report.projectActionMonthShare),
    ruleDecisions: report.ruleDecisions,
    modelDecisions: report.kimiDecisions,
    strategicIntents: strategic,
    socialIntents: social,
    strategicShare: strategic + social ? Math.round(strategic / (strategic + social) * 10_000) / 100 : null,
    communications: optionalNumber(report.communications),
    survivalReflexActions: optionalNumber(report.survivalReflexActions),
    correctPredictions: correct,
    incorrectPredictions: incorrect,
    predictionAccuracy: correct + incorrect ? Math.round(correct / (correct + incorrect) * 10_000) / 100 : null,
    dehydrationHibernations: report.dehydrationHibernations,
    assistedDependentHibernations: optionalNumber(report.assistedDependentHibernations),
    wildlifePopulation: report.wildlifePopulation,
    animalsHunted: report.animalsHunted,
    animalAttacks: report.animalAttacks,
    projectsStarted: optionalNumber(report.projectsStarted),
    projectsCompleted: optionalNumber(report.projectsCompleted),
    projectsBlocked: optionalNumber(report.projectsBlocked),
    projectLogisticsEpisodes: optionalNumber(report.projectLogisticsEpisodes),
    projectLogisticsFulfilled: optionalNumber(report.projectLogisticsFulfilled),
    projectLogisticsExhausted: optionalNumber(report.projectLogisticsExhausted),
    projectSearchEpisodes: optionalNumber(report.projectSearchEpisodes),
    projectDropEpisodes: optionalNumber(report.projectDropEpisodes),
    projectLogisticsActionEvents: optionalNumber(report.projectLogisticsActionEvents),
    jointProjectsCompleted: optionalNumber(report.jointProjectsCompleted),
    productionProjectsCompleted: optionalNumber(report.productionProjectsCompleted),
    constructionProjectsCompleted: optionalNumber(report.constructionProjectsCompleted),
    totalStructures: optionalNumber(report.totalStructures),
    completedStructures: optionalNumber(report.completedStructures),
    constructionPlacements: optionalNumber(report.constructionPlacements),
    containersBuilt: optionalNumber(report.containersBuilt),
    standingContainers: optionalNumber(report.standingContainers),
    containerTransfers: optionalNumber(report.containerTransfers),
    storedUnits: optionalNumber(report.storedUnits),
    movementActions: optionalNumber(report.movementActions),
    movementActionShare: optionalNumber(report.movementActionShare),
    spearsCrafted: optionalNumber(report.spearsCrafted),
    leatherClothingCrafted: optionalNumber(report.leatherClothingCrafted),
    herbalMedicineCrafted: optionalNumber(report.herbalMedicineCrafted),
    cookedFoodProduced: optionalNumber(report.cookedFoodProduced),
    recordsCreated: optionalNumber(report.recordsCreated),
    functionalInstitutions: optionalNumber(report.functionalInstitutions),
    inputTokens: report.inputTokens,
    outputTokens: report.outputTokens,
    milestoneIds: (report.milestones ?? []).map((milestone) => milestone.id),
  };
}

function aggregate(runs, years) {
  return years.map((year) => {
    const group = runs.filter((run) => run.years === year);
    const productionComparable = group.filter((run) => [run.spearsCrafted, run.leatherClothingCrafted, run.herbalMedicineCrafted, run.cookedFoodProduced]
      .every((value) => Number.isFinite(value)));
    const metric = (key) => numericSummary(group.map((run) => run[key] === null || run[key] === undefined ? Number.NaN : Number(run[key])));
    return {
      years: year,
      runs: group.length,
      completed: group.filter((run) => run.status === 'ended').length,
      endedEarly: group.filter((run) => run.endedEarly).length,
      extinctionRate: group.length ? Math.round(group.filter((run) => run.finalPopulation === 0).length / group.length * 10_000) / 100 : 0,
      finalPopulation: metric('finalPopulation'),
      births: metric('births'),
      reproductionOffers: metric('reproductionOffers'),
      reproductionAcceptances: metric('reproductionAcceptances'),
      reproductionAttempts: metric('reproductionAttempts'),
      reproductionConceptions: metric('reproductionConceptions'),
      relationshipProposalOffers: metric('relationshipProposalOffers'),
      relationshipProposalUniqueBases: metric('relationshipProposalUniqueBases'),
      relationshipProposalRepeatedBases: metric('relationshipProposalRepeatedBases'),
      relationshipProposalOffersWithoutBasis: metric('relationshipProposalOffersWithoutBasis'),
      relationshipProposalRepeatedDirectedPairs: metric('relationshipProposalRepeatedDirectedPairs'),
      relationshipProposalMaxPerDirectedPair: metric('relationshipProposalMaxPerDirectedPair'),
      lifeReviewDecisions: metric('lifeReviewDecisions'),
      projectLifeReviewDecisions: metric('projectLifeReviewDecisions'),
      lifeReviewPersonMonths: metric('lifeReviewPersonMonths'),
      lifeReviewSameMonthDuplicates: metric('lifeReviewSameMonthDuplicates'),
      lifeReviewUniqueBases: metric('lifeReviewUniqueBases'),
      lifeReviewRepeatedBases: metric('lifeReviewRepeatedBases'),
      interruptedIntentChildren: metric('interruptedIntentChildren'),
      interruptLifeReviewChildren: metric('interruptLifeReviewChildren'),
      interruptRequiredResponseChildren: metric('interruptRequiredResponseChildren'),
      interruptFulfillmentChildren: metric('interruptFulfillmentChildren'),
      interruptChildrenCompleted: metric('interruptChildrenCompleted'),
      interruptChildrenBlocked: metric('interruptChildrenBlocked'),
      interruptChildrenFailed: metric('interruptChildrenFailed'),
      interruptChildrenAbandoned: metric('interruptChildrenAbandoned'),
      interruptReturnsResumed: metric('interruptReturnsResumed'),
      interruptReturnsParentCompleted: metric('interruptReturnsParentCompleted'),
      interruptReturnsParentBlocked: metric('interruptReturnsParentBlocked'),
      interruptReturnsParentUnavailable: metric('interruptReturnsParentUnavailable'),
      interruptUnresolvedTerminalChildren: metric('interruptUnresolvedTerminalChildren'),
      interruptChildrenWithProjectId: metric('interruptChildrenWithProjectId'),
      interruptReturnLatencyMeanMonths: metric('interruptReturnLatencyMeanMonths'),
      interruptReturnLatencyMaxMonths: metric('interruptReturnLatencyMaxMonths'),
      interruptResumedParentsWithSubsequentAction: metric('interruptResumedParentsWithSubsequentAction'),
      interruptResumedParentsWithoutSubsequentAction: metric('interruptResumedParentsWithoutSubsequentAction'),
      interruptImmediateSameProjectReplacements: metric('interruptImmediateSameProjectReplacements'),
      orphanSuspendedProjectIntents: metric('orphanSuspendedProjectIntents'),
      deaths: metric('deaths'),
      childDeaths: metric('childDeaths'),
      childExposureDeaths: metric('childExposureDeaths'),
      civilizationIndex: metric('civilizationIndex'),
      completedActions: metric('completedActions'),
      actionPersonMonths: metric('actionPersonMonths'),
      projectActionPersonMonths: metric('projectActionPersonMonths'),
      projectActionMonthShare: metric('projectActionMonthShare'),
      ruleDecisions: metric('ruleDecisions'),
      strategicIntents: metric('strategicIntents'),
      socialIntents: metric('socialIntents'),
      strategicShare: metric('strategicShare'),
      communications: metric('communications'),
      survivalReflexActions: metric('survivalReflexActions'),
      projectsStarted: metric('projectsStarted'),
      projectsCompleted: metric('projectsCompleted'),
      projectsBlocked: metric('projectsBlocked'),
      ...Object.fromEntries(PROJECT_PRESSURE_METRIC_NAMES.map((name) => [name, metric(name)])),
      ...Object.fromEntries(PROJECT_PROGRESS_METRIC_NAMES.map((name) => [name, metric(name)])),
      ...Object.fromEntries(SEARCH_CAMPAIGN_METRIC_NAMES.map((name) => [name, metric(name)])),
      ...Object.fromEntries(MATERIAL_DEMAND_METRIC_NAMES.map((name) => [name, metric(name)])),
      ...Object.fromEntries(PROJECT_SOURCE_METRIC_NAMES.map((name) => [name, metric(name)])),
      ...Object.fromEntries(SHELTER_ADAPTATION_METRIC_NAMES.map((name) => [name, metric(name)])),
      ...Object.fromEntries(RECORD_USE_METRIC_NAMES.map((name) => [name, metric(name)])),
      ...Object.fromEntries(HYPOTHESIS_METRIC_NAMES.map((name) => [name, metric(name)])),
      ...Object.fromEntries(INQUIRY_OPPORTUNITY_METRIC_NAMES.map((name) => [name, metric(name)])),
      ...Object.fromEntries(TECHNIQUE_LEARNING_METRIC_NAMES.map((name) => [name, metric(name)])),
      projectLogisticsEpisodes: metric('projectLogisticsEpisodes'),
      projectLogisticsFulfilled: metric('projectLogisticsFulfilled'),
      projectLogisticsExhausted: metric('projectLogisticsExhausted'),
      projectSearchEpisodes: metric('projectSearchEpisodes'),
      projectDropEpisodes: metric('projectDropEpisodes'),
      projectLogisticsActionEvents: metric('projectLogisticsActionEvents'),
      jointProjectsCompleted: metric('jointProjectsCompleted'),
      productionProjectsCompleted: metric('productionProjectsCompleted'),
      constructionProjectsCompleted: metric('constructionProjectsCompleted'),
      totalStructures: metric('totalStructures'),
      completedStructures: metric('completedStructures'),
      constructionPlacements: metric('constructionPlacements'),
      containersBuilt: metric('containersBuilt'),
      standingContainers: metric('standingContainers'),
      containerTransfers: metric('containerTransfers'),
      storedUnits: metric('storedUnits'),
      movementActionShare: metric('movementActionShare'),
      usefulProductionOccurrenceRate: productionComparable.length
        ? Math.round(productionComparable.filter((run) => run.spearsCrafted + run.leatherClothingCrafted + run.herbalMedicineCrafted + run.cookedFoodProduced > 0).length / productionComparable.length * 10_000) / 100
        : null,
      spearsCrafted: metric('spearsCrafted'),
      leatherClothingCrafted: metric('leatherClothingCrafted'),
      herbalMedicineCrafted: metric('herbalMedicineCrafted'),
      cookedFoodProduced: metric('cookedFoodProduced'),
      recordsCreated: metric('recordsCreated'),
      functionalInstitutions: metric('functionalInstitutions'),
      predictionAccuracy: metric('predictionAccuracy'),
      assistedDependentHibernations: metric('assistedDependentHibernations'),
      wildlifePopulation: metric('wildlifePopulation'),
      modelDecisions: metric('modelDecisions'),
    };
  });
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const baseUrl = String(args['base-url'] ?? 'http://127.0.0.1:3220').replace(/\/$/, '');
  const prefix = safePrefix(args.prefix ?? `matrix-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`);
  const seeds = csvIntegers(args.seeds ?? '185,20260815,20260816', 'seeds');
  const years = csvIntegers(args.years ?? '10,30,50,100,1000', 'years');
  if (years.some((year) => year <= 0)) throw new Error('years must be positive');
  const repeats = positiveInteger(args.repeats ?? 1, 'repeats');
  const civilizationNo = positiveInteger(args['civilization-no'] ?? 1, 'civilization-no');
  const requestedChaosIntensity = Number(args['chaos-intensity'] ?? 0);
  if (!Number.isFinite(requestedChaosIntensity) || requestedChaosIntensity < 0 || requestedChaosIntensity > 10) throw new Error('chaos-intensity must be between 0 and 10');
  const chaosIntensity = Math.round(requestedChaosIntensity);
  const climateBias = String(args['climate-bias'] ?? 'balanced');
  if (!['balanced', 'cold', 'hot'].includes(climateBias)) throw new Error('climate-bias must be balanced, cold, or hot');
  const pollMs = positiveInteger(args['poll-ms'] ?? 1000, 'poll-ms');

  const plans = years.flatMap((year) => seeds.flatMap((seed) => Array.from({ length: repeats }, (_, repeatIndex) => ({
    runId: matrixRunId(prefix, seed, year, repeatIndex + 1),
    seed,
    years: year,
    months: year * 12,
    repeat: repeatIndex + 1,
  }))));

  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify({ prefix, baseUrl, seeds, years, repeats, plans }, null, 2)}\n`);
    return;
  }

  await jsonRequest(baseUrl, '/health');
  const runs = [];
  for (const plan of plans) {
    const label = `${prefix} seed=${plan.seed} years=${plan.years} repeat=${plan.repeat}`.slice(0, 100);
    const endpoint = { kind: 'months', value: plan.months };
    const expected = {
      label,
      seed: plan.seed,
      civilizationNo,
      chaosIntensity,
      climateBias,
      endpoint,
      fromMonth: 0,
    };
    const initialEvolution = await ensureEvolutionThrough({
      baseUrl,
      plan,
      expected,
      createPayload: {
        id: plan.runId,
        label,
        seed: plan.seed,
        config: { civilizationNo, chaosIntensity, climateBias, endpoint },
      },
    });
    process.stderr.write(`[matrix] claim ${plan.runId} from ${initialEvolution.reachedMonth}/${plan.months} ${initialEvolution.status}\n`);
    await waitForEvolution({
      baseUrl,
      plan,
      expected,
      pollMs,
      initialEvolution,
      onProgress: (evolution) => {
        process.stderr.write(`[matrix] ${plan.runId} ${evolution.reachedMonth}/${plan.months} ${evolution.status}\n`);
      },
    });
    const report = await jsonRequest(baseUrl, `/api/runs/${plan.runId}/report`);
    const state = await optionalJsonRequest(baseUrl, `/api/runs/${plan.runId}/state`);
    runs.push(summarizeReport(plan, supplementReportFromState(report, state)));
  }

  const civilizationIndexVersions = [...new Set(runs
    .map((run) => run.civilizationIndexFormulaVersion)
    .filter((version) => typeof version === 'string' && version.length > 0))];
  const outputRuns = runs.map(({ civilizationIndexFormulaVersion: _formulaVersion, ...run }) => run);
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    metricVersions: {
      behaviorObserver: 'causal-person-month-v22',
      ...(civilizationIndexVersions.length === 1 ? { civilizationIndex: civilizationIndexVersions[0] } : {}),
    },
    experiment: { prefix, baseUrl, seeds, years, repeats, civilizationNo, chaosIntensity, climateBias },
    aggregates: aggregate(runs, years),
    runs: outputRuns,
  };
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) {
    const outputPath = resolve(String(args.out));
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, output, 'utf8');
    process.stderr.write(`[matrix] wrote ${outputPath}\n`);
  }
  process.stdout.write(output);
}

const directInvocation = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (directInvocation) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
