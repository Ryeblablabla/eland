import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { openSqliteRunReader } from './sqlite-run-reader.mjs';

const OBSERVER_VERSION = 'project-search-campaign-budget-audit-v1';
const SEARCH_CAMPAIGN_ACTION_BUDGET = 16;
const CAMPAIGN_STATUSES = new Set(['active', 'exhausted', 'superseded', 'closed']);
const EPISODE_STATUSES = new Set(['active', 'fulfilled', 'exhausted', 'invalidated']);
const EPISODE_REASONS_BY_STATUS = new Map([
  ['fulfilled', new Set(['search-target-reached', 'project-completed'])],
  ['exhausted', new Set(['search-budget-exhausted', 'project-blocked', 'project-abandoned'])],
  ['invalidated', new Set(['search-target-unreachable'])],
]);

const asArray = (value) => Array.isArray(value) ? value : [];
const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const stringValue = (value) => typeof value === 'string' && value.length > 0 ? value : null;
const finiteValue = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const integerValue = (value) => Number.isInteger(value) ? value : null;
const rounded = (value) => Math.round(value * 100) / 100;
const uniqueStrings = (values) => [...new Set(values.map(stringValue).filter(Boolean))].sort();

function percentage(numerator, denominator) {
  return denominator > 0 ? rounded(numerator / denominator * 100) : null;
}

function countBy(values) {
  return Object.fromEntries([...values.reduce((counts, value) => {
    const key = String(value ?? 'unknown');
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map())].sort(([left], [right]) => left.localeCompare(right)));
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
    max: usable[usable.length - 1],
  };
}

function eventOrder(left, right) {
  return (finiteValue(left.event.atMonth) ?? 0) - (finiteValue(right.event.atMonth) ?? 0)
    || (finiteValue(left.event.orderInMonth) ?? 0) - (finiteValue(right.event.orderInMonth) ?? 0)
    || (finiteValue(left.event.planningTick) ?? 0) - (finiteValue(right.event.planningTick) ?? 0)
    || (finiteValue(left.event.orderInTick) ?? 0) - (finiteValue(right.event.orderInTick) ?? 0)
    || left.index - right.index;
}

function targetFor(episode) {
  const target = asObject(episode.target);
  const cellId = integerValue(target?.cellId);
  const z = integerValue(target?.z);
  return cellId === null || z === null ? null : { cellId, z, key: `${cellId}:${z}` };
}

function projectTerminal(project) {
  if (project.status === 'completed') {
    return { status: 'completed', atMonth: integerValue(project.completedAtMonth) };
  }
  if (project.status === 'blocked') {
    return { status: 'blocked', atMonth: integerValue(project.blockedAtMonth) };
  }
  if (project.status === 'abandoned') {
    return { status: 'abandoned', atMonth: integerValue(project.abandonedAtMonth) };
  }
  return { status: stringValue(project.status) ?? 'unknown', atMonth: null };
}

function eventEvidence(item, matchingEpisodes, linkedEpisodes) {
  const event = item.event;
  const action = asObject(event.action);
  return {
    eventId: stringValue(event.id),
    atMonth: integerValue(event.atMonth),
    orderInMonth: integerValue(event.orderInMonth),
    planningTick: integerValue(event.planningTick),
    orderInTick: integerValue(event.orderInTick),
    who: stringValue(event.who),
    status: stringValue(event.status),
    cause: stringValue(event.cause),
    commandedTarget: {
      cellId: integerValue(action?.toCellId),
      z: integerValue(action?.toZ),
    },
    actualDestination: {
      cellId: integerValue(event.toCellId),
      z: integerValue(event.toZ),
    },
    matchingEpisodeIds: uniqueStrings(matchingEpisodes.map((episode) => episode.id)),
    linkedEpisodeIds: uniqueStrings(linkedEpisodes.map((episode) => episode.id)),
  };
}

function classifyResolvedEvent(item, linkedEpisodes) {
  const event = item.event;
  const action = asObject(event.action);
  const matchingEpisodes = linkedEpisodes.filter((episode) => {
    const target = targetFor(episode);
    return target
      && action?.toCellId === target.cellId
      && action?.toZ === target.z;
  });
  const reasons = [];
  if (event.kind !== 'action') reasons.push('not-action');
  if (event.status !== 'completed' && event.status !== 'progressed') reasons.push('not-completed-or-progressed');
  if (event.cause !== 'intent') reasons.push('not-intent-caused');
  if (action?.kind !== 'move') reasons.push('not-move');
  if (!matchingEpisodes.length) reasons.push('commanded-target-does-not-match-linked-episode');
  return {
    committed: reasons.length === 0,
    evidence: eventEvidence(item, matchingEpisodes, linkedEpisodes),
    reasons,
  };
}

function auditEpisode(episode, eventMap) {
  const target = targetFor(episode);
  const rawActionIds = asArray(episode.actionEventIds).map(stringValue).filter(Boolean);
  const actionEventIds = uniqueStrings(rawActionIds);
  const status = stringValue(episode.status);
  const createdAt = integerValue(episode.createdAt);
  const endedAt = integerValue(episode.endedAt);
  const endingReason = stringValue(episode.endingReason);
  const reasons = [];
  if (!EPISODE_STATUSES.has(status)) reasons.push('invalid-status');
  if (!target) reasons.push('invalid-locked-target');
  if (status === 'active') {
    if (endedAt !== null) reasons.push('active-has-endedAt');
    if (endingReason !== null) reasons.push('active-has-endingReason');
  } else if (EPISODE_STATUSES.has(status)) {
    if (endedAt === null) reasons.push('terminal-missing-endedAt');
    if (createdAt !== null && endedAt !== null && endedAt < createdAt) reasons.push('endedAt-before-createdAt');
    if (endingReason === null) reasons.push('terminal-missing-endingReason');
    const allowedReasons = EPISODE_REASONS_BY_STATUS.get(status);
    if (endingReason !== null && allowedReasons && !allowedReasons.has(endingReason)) {
      reasons.push('status-endingReason-mismatch');
    }
  }
  const resolvedItems = actionEventIds.map((eventId) => eventMap.get(eventId)).filter(Boolean);
  if (createdAt !== null && resolvedItems.some((item) => (integerValue(item.event.atMonth) ?? -Infinity) < createdAt)) {
    reasons.push('action-before-createdAt');
  }
  if (endedAt !== null && resolvedItems.some((item) => (integerValue(item.event.atMonth) ?? Infinity) > endedAt)) {
    reasons.push('action-after-endedAt');
  }
  return {
    episodeId: stringValue(episode.id),
    searchCampaignId: stringValue(episode.searchCampaignId),
    actorId: stringValue(episode.actorId),
    target,
    createdAt,
    status,
    endedAt,
    endingReason,
    actionBudget: integerValue(episode.actionBudget),
    actionEventIds,
    duplicateActionEventIds: rawActionIds.length - actionEventIds.length,
    terminalMetadataConsistent: reasons.length === 0,
    terminalMetadataReasons: reasons,
  };
}

function expectedBudgetTerminal(sixteenth, episode) {
  const target = targetFor(episode);
  if (!target) return null;
  const actual = sixteenth.actualDestination;
  const reached = actual.cellId === target.cellId && actual.z === target.z;
  return reached
    ? { status: 'fulfilled', endingReason: 'search-target-reached' }
    : { status: 'exhausted', endingReason: 'search-budget-exhausted' };
}

function budgetClosureAudit(campaign, committedMoves, episodes) {
  if (committedMoves.length < SEARCH_CAMPAIGN_ACTION_BUDGET) {
    return {
      status: 'not-applicable',
      consistent: null,
      reasons: [],
      sixteenthCommittedMove: null,
      matchingTerminalEpisodes: [],
    };
  }
  const sixteenth = committedMoves[SEARCH_CAMPAIGN_ACTION_BUDGET - 1];
  const closedAt = integerValue(campaign.closedAt);
  const reasons = [];
  if (campaign.status !== 'exhausted') reasons.push('budget-reached-campaign-not-exhausted');
  if (closedAt !== sixteenth.atMonth) reasons.push('closedAt-does-not-match-sixteenth-move-month');
  const matchingTerminalEpisodes = episodes.filter((episode) => sixteenth.matchingEpisodeIds.includes(episode.episodeId))
    .map((episode) => {
      const expected = expectedBudgetTerminal(sixteenth, episode.source);
      const consistent = expected !== null
        && episode.status === expected.status
        && episode.endingReason === expected.endingReason
        && episode.endedAt === sixteenth.atMonth;
      return {
        episodeId: episode.episodeId,
        expected,
        actual: { status: episode.status, endingReason: episode.endingReason, endedAt: episode.endedAt },
        consistent,
      };
    });
  if (!matchingTerminalEpisodes.some((episode) => episode.consistent)) {
    reasons.push('sixteenth-move-episode-terminal-metadata-mismatch');
  }
  return {
    status: 'supported',
    consistent: reasons.length === 0,
    reasons,
    sixteenthCommittedMove: sixteenth,
    matchingTerminalEpisodes,
  };
}

function campaignLifecycleAudit(project, campaign, allCampaigns) {
  const status = stringValue(campaign.status);
  const openedAt = integerValue(campaign.openedAt);
  const closedAt = integerValue(campaign.closedAt);
  const projectEnd = projectTerminal(project);
  const reasons = [];
  if (!CAMPAIGN_STATUSES.has(status)) reasons.push('invalid-status');
  if (openedAt === null) reasons.push('missing-openedAt');
  if (status === 'active') {
    if (closedAt !== null) reasons.push('active-has-closedAt');
    if (projectEnd.status !== 'active') reasons.push('active-campaign-on-terminal-project');
  } else if (CAMPAIGN_STATUSES.has(status)) {
    if (closedAt === null) reasons.push('terminal-missing-closedAt');
    if (openedAt !== null && closedAt !== null && closedAt < openedAt) reasons.push('closedAt-before-openedAt');
  }
  if (status === 'closed') {
    if (!['completed', 'blocked', 'abandoned'].includes(projectEnd.status)) {
      reasons.push('closed-campaign-on-nonterminal-project');
    }
    if (projectEnd.atMonth !== null && closedAt !== projectEnd.atMonth) {
      reasons.push('closedAt-does-not-match-project-terminal-month');
    }
  }
  if (status === 'superseded') {
    const successor = allCampaigns.find((candidate) => candidate !== campaign
      && stringValue(candidate.actorId) === stringValue(campaign.actorId)
      && integerValue(candidate.openedAt) === closedAt);
    if (!successor) reasons.push('superseded-campaign-missing-same-actor-successor-at-closedAt');
  }
  const endingReasonPresent = Object.hasOwn(campaign, 'endingReason');
  return {
    status,
    openedAt,
    closedAt,
    projectTerminal: projectEnd,
    statusClosedAtConsistent: reasons.length === 0,
    statusClosedAtReasons: reasons,
    campaignEndingReason: {
      status: endingReasonPresent ? 'present-but-no-versioned-contract' : 'unsupported-by-current-search-campaign-schema',
      value: stringValue(campaign.endingReason),
    },
  };
}

function auditCampaign(project, campaign, projectEpisodes, eventMap, allCampaigns) {
  const campaignId = stringValue(campaign.id);
  const sourceEpisodes = projectEpisodes.filter((episode) => stringValue(episode.searchCampaignId) === campaignId);
  const episodes = sourceEpisodes.map((source) => ({ source, ...auditEpisode(source, eventMap) }));
  const referencesByEventId = new Map();
  for (const episode of sourceEpisodes) {
    for (const eventId of uniqueStrings(asArray(episode.actionEventIds))) {
      const references = referencesByEventId.get(eventId) ?? [];
      references.push(episode);
      referencesByEventId.set(eventId, references);
    }
  }

  const unresolvedActionEventIds = [];
  const rejectedResolvedEvents = [];
  const committedMoves = [];
  for (const [eventId, linkedEpisodes] of referencesByEventId) {
    const item = eventMap.get(eventId);
    if (!item) {
      unresolvedActionEventIds.push(eventId);
      continue;
    }
    const classified = classifyResolvedEvent(item, linkedEpisodes);
    if (classified.committed) committedMoves.push(classified.evidence);
    else rejectedResolvedEvents.push({ ...classified.evidence, rejectionReasons: classified.reasons });
  }
  committedMoves.sort((left, right) => eventOrder(
    { event: left, index: eventMap.get(left.eventId)?.index ?? 0 },
    { event: right, index: eventMap.get(right.eventId)?.index ?? 0 },
  ));
  // eventEvidence uses the same ordering fields as authoritative events; the
  // fallback above only matters for malformed evidence with a missing field.
  committedMoves.sort((left, right) => (left.atMonth ?? 0) - (right.atMonth ?? 0)
    || (left.orderInMonth ?? 0) - (right.orderInMonth ?? 0)
    || (left.planningTick ?? 0) - (right.planningTick ?? 0)
    || (left.orderInTick ?? 0) - (right.orderInTick ?? 0)
    || (eventMap.get(left.eventId)?.index ?? 0) - (eventMap.get(right.eventId)?.index ?? 0));
  rejectedResolvedEvents.sort((left, right) => (left.atMonth ?? 0) - (right.atMonth ?? 0)
    || (left.orderInMonth ?? 0) - (right.orderInMonth ?? 0)
    || (eventMap.get(left.eventId)?.index ?? 0) - (eventMap.get(right.eventId)?.index ?? 0));

  const attemptedTargetKeys = uniqueStrings(asArray(campaign.attemptedTargetKeys));
  const episodeTargetKeys = uniqueStrings(sourceEpisodes.map((episode) => targetFor(episode)?.key));
  const linkedEpisodeIdsInFirstSixteen = uniqueStrings(committedMoves
    .slice(0, SEARCH_CAMPAIGN_ACTION_BUDGET)
    .flatMap((move) => move.matchingEpisodeIds));
  const lifecycle = campaignLifecycleAudit(project, campaign, allCampaigns);
  const budgetClosure = budgetClosureAudit(campaign, committedMoves, episodes);
  const terminalEpisodeInconsistencies = episodes.filter((episode) => !episode.terminalMetadataConsistent).length;
  return {
    campaignId,
    projectId: stringValue(project.id),
    projectStatus: stringValue(project.status),
    ownerId: stringValue(campaign.ownerId),
    actorId: stringValue(campaign.actorId),
    materialIds: asArray(campaign.materialIds).filter(Number.isFinite).sort((a, b) => a - b),
    lifecycle,
    episodeCount: episodes.length,
    attemptedTargetCount: attemptedTargetKeys.length,
    attemptedTargetKeys,
    uniqueEpisodeTargetCount: episodeTargetKeys.length,
    episodeTargetKeys,
    linkedUniqueActionEventIds: referencesByEventId.size,
    committedMoveCount: committedMoves.length,
    committedMoveEventIds: committedMoves.map((move) => move.eventId),
    unresolvedActionEventIds: unresolvedActionEventIds.sort(),
    rejectedResolvedEvents,
    overBudget: committedMoves.length > SEARCH_CAMPAIGN_ACTION_BUDGET,
    seventeenthCommittedMove: committedMoves[SEARCH_CAMPAIGN_ACTION_BUDGET] ?? null,
    committedMovesAfterBudget: committedMoves.slice(SEARCH_CAMPAIGN_ACTION_BUDGET),
    reachedBudget: committedMoves.length >= SEARCH_CAMPAIGN_ACTION_BUDGET,
    reachedBudgetAcrossEpisodes: committedMoves.length >= SEARCH_CAMPAIGN_ACTION_BUDGET
      && linkedEpisodeIdsInFirstSixteen.length >= 2,
    firstSixteenEpisodeIds: linkedEpisodeIdsInFirstSixteen,
    budgetClosure,
    terminalEpisodeInconsistencies,
    episodes: episodes.map(({ source: _source, ...episode }) => episode),
  };
}

function crossEpisodeBudgetChain(campaign) {
  if (!campaign.reachedBudgetAcrossEpisodes) return null;
  const episodeById = new Map(campaign.episodes.map((episode) => [episode.episodeId, episode]));
  return {
    runScopedCampaignId: `${campaign.projectId}\u0000${campaign.campaignId}`,
    projectId: campaign.projectId,
    campaignId: campaign.campaignId,
    actorId: campaign.actorId,
    committedMoveCount: campaign.committedMoveCount,
    exactBudgetWithoutAfter16: campaign.committedMoveCount === SEARCH_CAMPAIGN_ACTION_BUDGET,
    budgetClosureConsistent: campaign.budgetClosure.consistent,
    episodeIds: campaign.firstSixteenEpisodeIds,
    episodes: campaign.firstSixteenEpisodeIds.map((episodeId) => {
      const episode = episodeById.get(episodeId);
      return episode ? {
        episodeId,
        target: episode.target,
        createdAt: episode.createdAt,
        status: episode.status,
        endedAt: episode.endedAt,
        endingReason: episode.endingReason,
      } : { episodeId };
    }),
    firstSixteenMoves: campaign.committedMoveEventIds.slice(0, SEARCH_CAMPAIGN_ACTION_BUDGET),
    sixteenthCommittedMove: campaign.budgetClosure.sixteenthCommittedMove,
    movesAfterBudget: campaign.committedMovesAfterBudget,
  };
}

function campaignSummary(campaign) {
  return {
    campaignId: campaign.campaignId,
    projectId: campaign.projectId,
    actorId: campaign.actorId,
    lifecycle: {
      status: campaign.lifecycle.status,
      openedAt: campaign.lifecycle.openedAt,
      closedAt: campaign.lifecycle.closedAt,
      statusClosedAtConsistent: campaign.lifecycle.statusClosedAtConsistent,
      statusClosedAtReasons: campaign.lifecycle.statusClosedAtReasons,
      campaignEndingReason: campaign.lifecycle.campaignEndingReason,
    },
    episodeCount: campaign.episodeCount,
    attemptedTargetCount: campaign.attemptedTargetCount,
    uniqueEpisodeTargetCount: campaign.uniqueEpisodeTargetCount,
    linkedUniqueActionEventIds: campaign.linkedUniqueActionEventIds,
    committedMoveCount: campaign.committedMoveCount,
    unresolvedActionEventIds: campaign.unresolvedActionEventIds,
    rejectedResolvedEvents: campaign.rejectedResolvedEvents.map((event) => ({
      eventId: event.eventId,
      rejectionReasons: event.rejectionReasons,
    })),
    overBudget: campaign.overBudget,
    seventeenthCommittedMove: campaign.seventeenthCommittedMove,
    committedMovesAfterBudget: campaign.committedMovesAfterBudget,
    reachedBudget: campaign.reachedBudget,
    reachedBudgetAcrossEpisodes: campaign.reachedBudgetAcrossEpisodes,
    budgetClosure: {
      status: campaign.budgetClosure.status,
      consistent: campaign.budgetClosure.consistent,
      reasons: campaign.budgetClosure.reasons,
    },
    terminalEpisodeInconsistencies: campaign.terminalEpisodeInconsistencies,
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
  const projects = asArray(state.projects);
  const campaigns = [];
  let searchEpisodes = 0;
  let searchEpisodesWithCampaignId = 0;
  let searchEpisodesLinkedToCampaign = 0;
  let duplicateCampaignIds = 0;
  for (const project of projects) {
    const projectCampaigns = asArray(project.searchCampaigns);
    const projectEpisodes = asArray(project.logisticsEpisodes).filter((episode) => episode?.kind === 'search');
    searchEpisodes += projectEpisodes.length;
    searchEpisodesWithCampaignId += projectEpisodes.filter((episode) => stringValue(episode.searchCampaignId)).length;
    const campaignIds = projectCampaigns.map((campaign) => stringValue(campaign.id)).filter(Boolean);
    duplicateCampaignIds += campaignIds.length - new Set(campaignIds).size;
    const campaignIdSet = new Set(campaignIds);
    searchEpisodesLinkedToCampaign += projectEpisodes
      .filter((episode) => campaignIdSet.has(stringValue(episode.searchCampaignId))).length;
    for (const campaign of projectCampaigns) {
      campaigns.push(auditCampaign(project, campaign, projectEpisodes, eventMap, projectCampaigns));
    }
  }

  const linkedUniqueActionEventIds = campaigns.reduce((sum, campaign) => sum + campaign.linkedUniqueActionEventIds, 0);
  const committedMoves = campaigns.reduce((sum, campaign) => sum + campaign.committedMoveCount, 0);
  const unresolvedActionEventIds = campaigns.reduce((sum, campaign) => sum + campaign.unresolvedActionEventIds.length, 0);
  const rejectedResolvedActionEventIds = campaigns.reduce((sum, campaign) => sum + campaign.rejectedResolvedEvents.length, 0);
  const campaignLifecycleInconsistencies = campaigns
    .filter((campaign) => !campaign.lifecycle.statusClosedAtConsistent).length;
  const episodeTerminalInconsistencies = campaigns
    .reduce((sum, campaign) => sum + campaign.terminalEpisodeInconsistencies, 0);
  const budgetClosureInconsistencies = campaigns
    .filter((campaign) => campaign.budgetClosure.status === 'supported' && !campaign.budgetClosure.consistent).length;
  const campaignsOverBudget = campaigns.filter((campaign) => campaign.overBudget).length;
  const committedMovesAfterBudget = campaigns
    .reduce((sum, campaign) => sum + campaign.committedMovesAfterBudget.length, 0);
  const crossEpisodeBudgetChains = campaigns.map(crossEpisodeBudgetChain).filter(Boolean);
  const hardAnomalyCount = duplicateEventIds.length
    + duplicateCampaignIds
    + (searchEpisodes - searchEpisodesLinkedToCampaign)
    + unresolvedActionEventIds
    + campaignLifecycleInconsistencies
    + episodeTerminalInconsistencies
    + budgetClosureInconsistencies
    + campaignsOverBudget
    + committedMovesAfterBudget;

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
    state: {
      elapsedMonths: integerValue(state.clock?.elapsedMonths),
      projectCount: projects.length,
      eventCount: events.length,
      duplicateEventIds: uniqueStrings(duplicateEventIds),
    },
    totals: {
      campaigns: campaigns.length,
      campaignsWithEpisodes: campaigns.filter((campaign) => campaign.episodeCount > 0).length,
      searchEpisodes,
      searchEpisodesWithCampaignId,
      searchEpisodesLinkedToCampaign,
      linkedUniqueActionEventIds,
      committedMoves,
      unresolvedActionEventIds,
      rejectedResolvedActionEventIds,
    },
    coverage: {
      campaignsWithEpisodesPercent: percentage(
        campaigns.filter((campaign) => campaign.episodeCount > 0).length,
        campaigns.length,
      ),
      episodesWithCampaignIdPercent: percentage(searchEpisodesWithCampaignId, searchEpisodes),
      episodesLinkedToCampaignPercent: percentage(searchEpisodesLinkedToCampaign, searchEpisodes),
      linkedEventIdsResolvedPercent: percentage(
        linkedUniqueActionEventIds - unresolvedActionEventIds,
        linkedUniqueActionEventIds,
      ),
      linkedEventIdsCommittedPercent: percentage(committedMoves, linkedUniqueActionEventIds),
      zeroDenominatorPolicy: 'null means unsupported; it is never reported as 100%',
    },
    maxima: {
      committedMovesPerCampaign: campaigns.length ? Math.max(...campaigns.map((campaign) => campaign.committedMoveCount)) : null,
      attemptedTargetsPerCampaign: campaigns.length ? Math.max(...campaigns.map((campaign) => campaign.attemptedTargetCount)) : null,
      episodeTargetsPerCampaign: campaigns.length ? Math.max(...campaigns.map((campaign) => campaign.uniqueEpisodeTargetCount)) : null,
      episodesPerCampaign: campaigns.length ? Math.max(...campaigns.map((campaign) => campaign.episodeCount)) : null,
    },
    budget: {
      limit: SEARCH_CAMPAIGN_ACTION_BUDGET,
      campaignsAtBudget: campaigns.filter((campaign) => campaign.committedMoveCount === SEARCH_CAMPAIGN_ACTION_BUDGET).length,
      campaignsOverBudget,
      campaignsWithSeventeenthMove: campaigns.filter((campaign) => campaign.seventeenthCommittedMove).length,
      committedMovesAfterBudget,
      campaignsReachingBudgetAcrossEpisodes: crossEpisodeBudgetChains.length,
    },
    lifecycle: {
      campaignStatuses: countBy(campaigns.map((campaign) => campaign.lifecycle.status)),
      campaignLifecycleInconsistencies,
      campaignEndingReasonFieldCoverage: {
        numerator: campaigns.filter((campaign) => campaign.lifecycle.campaignEndingReason.value !== null).length,
        denominator: campaigns.length,
        percent: percentage(
          campaigns.filter((campaign) => campaign.lifecycle.campaignEndingReason.value !== null).length,
          campaigns.length,
        ),
        status: 'unsupported-by-current-search-campaign-schema',
      },
      episodeStatuses: countBy(campaigns.flatMap((campaign) => campaign.episodes.map((episode) => episode.status))),
      episodeEndingReasons: countBy(campaigns.flatMap((campaign) => campaign.episodes.map((episode) => episode.endingReason))),
      episodeTerminalInconsistencies,
      budgetClosureInconsistencies,
    },
    hardAnomalyCount,
    crossEpisodeBudgetChains,
    campaigns: campaigns.map(campaignSummary),
  };
}

function sumField(runs, accessor) {
  return runs.reduce((sum, run) => sum + (accessor(run) ?? 0), 0);
}

function aggregateGroup(horizonYears, runs) {
  const campaigns = sumField(runs, (run) => run.totals.campaigns);
  const campaignsWithEpisodes = sumField(runs, (run) => run.totals.campaignsWithEpisodes);
  const searchEpisodes = sumField(runs, (run) => run.totals.searchEpisodes);
  const linkedEpisodes = sumField(runs, (run) => run.totals.searchEpisodesLinkedToCampaign);
  const linkedEventIds = sumField(runs, (run) => run.totals.linkedUniqueActionEventIds);
  const unresolvedEventIds = sumField(runs, (run) => run.totals.unresolvedActionEventIds);
  const committedMoves = sumField(runs, (run) => run.totals.committedMoves);
  return {
    horizonYears,
    runs: runs.length,
    seeds: uniqueStrings(runs.map((run) => run.seed === null ? null : String(run.seed))),
    matrixStatuses: countBy(runs.map((run) => run.matrixStatus)),
    sqliteStatuses: countBy(runs.map((run) => run.sqliteMeta.status)),
    totals: {
      campaigns,
      campaignsWithEpisodes,
      searchEpisodes,
      searchEpisodesLinkedToCampaign: linkedEpisodes,
      linkedUniqueActionEventIds: linkedEventIds,
      committedMoves,
      unresolvedActionEventIds: unresolvedEventIds,
      rejectedResolvedActionEventIds: sumField(runs, (run) => run.totals.rejectedResolvedActionEventIds),
    },
    coverage: {
      campaignsWithEpisodesPercent: percentage(campaignsWithEpisodes, campaigns),
      episodesLinkedToCampaignPercent: percentage(linkedEpisodes, searchEpisodes),
      linkedEventIdsResolvedPercent: percentage(linkedEventIds - unresolvedEventIds, linkedEventIds),
      linkedEventIdsCommittedPercent: percentage(committedMoves, linkedEventIds),
    },
    maxima: {
      committedMovesPerCampaign: runs.length ? Math.max(...runs.map((run) => run.maxima.committedMovesPerCampaign ?? 0)) : null,
      attemptedTargetsPerCampaign: runs.length ? Math.max(...runs.map((run) => run.maxima.attemptedTargetsPerCampaign ?? 0)) : null,
      episodeTargetsPerCampaign: runs.length ? Math.max(...runs.map((run) => run.maxima.episodeTargetsPerCampaign ?? 0)) : null,
      episodesPerCampaign: runs.length ? Math.max(...runs.map((run) => run.maxima.episodesPerCampaign ?? 0)) : null,
    },
    distributions: {
      campaignsPerRun: numericSummary(runs.map((run) => run.totals.campaigns)),
      committedMovesPerRun: numericSummary(runs.map((run) => run.totals.committedMoves)),
      maximumCommittedMovesPerCampaignPerRun: numericSummary(
        runs.map((run) => run.maxima.committedMovesPerCampaign).filter((value) => value !== null),
      ),
      attemptedTargetsPerCampaignMaxPerRun: numericSummary(
        runs.map((run) => run.maxima.attemptedTargetsPerCampaign).filter((value) => value !== null),
      ),
    },
    budget: {
      limit: SEARCH_CAMPAIGN_ACTION_BUDGET,
      campaignsAtBudget: sumField(runs, (run) => run.budget.campaignsAtBudget),
      campaignsOverBudget: sumField(runs, (run) => run.budget.campaignsOverBudget),
      campaignsWithSeventeenthMove: sumField(runs, (run) => run.budget.campaignsWithSeventeenthMove),
      committedMovesAfterBudget: sumField(runs, (run) => run.budget.committedMovesAfterBudget),
      campaignsReachingBudgetAcrossEpisodes: sumField(
        runs,
        (run) => run.budget.campaignsReachingBudgetAcrossEpisodes,
      ),
      runsWithCrossEpisodeBudgetChain: runs.filter(
        (run) => run.budget.campaignsReachingBudgetAcrossEpisodes > 0,
      ).length,
    },
    lifecycle: {
      campaignStatuses: countBy(runs.flatMap((run) => run.campaigns.map((campaign) => campaign.lifecycle.status))),
      campaignLifecycleInconsistencies: sumField(runs, (run) => run.lifecycle.campaignLifecycleInconsistencies),
      episodeTerminalInconsistencies: sumField(runs, (run) => run.lifecycle.episodeTerminalInconsistencies),
      budgetClosureInconsistencies: sumField(runs, (run) => run.lifecycle.budgetClosureInconsistencies),
      campaignEndingReasonFieldCoverage: {
        numerator: sumField(runs, (run) => run.lifecycle.campaignEndingReasonFieldCoverage.numerator),
        denominator: campaigns,
        percent: percentage(
          sumField(runs, (run) => run.lifecycle.campaignEndingReasonFieldCoverage.numerator),
          campaigns,
        ),
        status: 'unsupported-by-current-search-campaign-schema',
      },
    },
    hardAnomalyCount: sumField(runs, (run) => run.hardAnomalyCount),
  };
}

function aggregateRuns(runs) {
  const byHorizon = new Map();
  for (const run of runs) {
    const key = run.horizonYears ?? 'unknown';
    const matching = byHorizon.get(key) ?? [];
    matching.push(run);
    byHorizon.set(key, matching);
  }
  const horizons = [...byHorizon].sort(([left], [right]) => {
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left).localeCompare(String(right));
  }).map(([horizonYears, matching]) => aggregateGroup(horizonYears, matching));
  return { overall: aggregateGroup('all', runs), horizons };
}

function selfTest() {
  const events = [];
  for (let ordinal = 1; ordinal <= 16; ordinal += 1) {
    const firstEpisode = ordinal <= 10;
    events.push({
      id: `move-${ordinal}`,
      kind: 'action',
      status: 'progressed',
      cause: 'intent',
      who: 'actor',
      atMonth: firstEpisode ? 3 : 4,
      orderInMonth: ordinal,
      action: { kind: 'move', toCellId: firstEpisode ? 100 : 200, toZ: 5 },
      toCellId: firstEpisode ? 99 : 199,
      toZ: 5,
    });
  }
  events.push({
    id: 'survival-move', kind: 'action', status: 'progressed', cause: 'survival-reflex', atMonth: 4,
    orderInMonth: 17, action: { kind: 'move', toCellId: 200, toZ: 5 }, toCellId: 199, toZ: 5,
  });
  events.push({
    id: 'wrong-target', kind: 'action', status: 'progressed', cause: 'intent', atMonth: 4,
    orderInMonth: 18, action: { kind: 'move', toCellId: 201, toZ: 5 }, toCellId: 200, toZ: 5,
  });
  const eventMap = new Map(events.map((event, index) => [event.id, { event, index }]));
  const campaign = {
    id: 'campaign', status: 'exhausted', openedAt: 3, closedAt: 4, actorId: 'actor', ownerId: 'owner',
    attemptedTargetKeys: ['100:5', '200:5'], materialIds: [1],
  };
  const project = { id: 'project', status: 'active' };
  const episodes = [
    {
      id: 'episode-1', kind: 'search', searchCampaignId: 'campaign', actorId: 'actor',
      target: { cellId: 100, z: 5 }, createdAt: 3, status: 'fulfilled', endedAt: 3,
      endingReason: 'search-target-reached', actionEventIds: events.slice(0, 10).map((event) => event.id),
    },
    {
      id: 'episode-2', kind: 'search', searchCampaignId: 'campaign', actorId: 'actor',
      target: { cellId: 200, z: 5 }, createdAt: 4, status: 'exhausted', endedAt: 4,
      endingReason: 'search-budget-exhausted',
      actionEventIds: [
        ...events.slice(10, 16).map((event) => event.id),
        'move-10', 'survival-move', 'wrong-target', 'unresolved',
      ],
    },
  ];
  const audited = auditCampaign(project, campaign, episodes, eventMap, [campaign]);
  assert.equal(audited.committedMoveCount, 16);
  assert.equal(audited.linkedUniqueActionEventIds, 19);
  assert.deepEqual(audited.unresolvedActionEventIds, ['unresolved']);
  assert.equal(audited.rejectedResolvedEvents.length, 2);
  assert.equal(audited.reachedBudgetAcrossEpisodes, true);
  assert.equal(audited.overBudget, false);
  assert.equal(audited.seventeenthCommittedMove, null);
  assert.equal(audited.budgetClosure.consistent, true);
  assert.deepEqual(audited.firstSixteenEpisodeIds, ['episode-1', 'episode-2']);

  const event17 = {
    id: 'move-17', kind: 'action', status: 'progressed', cause: 'intent', who: 'actor', atMonth: 5,
    orderInMonth: 1, action: { kind: 'move', toCellId: 200, toZ: 5 }, toCellId: 199, toZ: 5,
  };
  eventMap.set(event17.id, { event: event17, index: events.length });
  episodes[1].actionEventIds.push(event17.id);
  episodes[1].endedAt = 5;
  const over = auditCampaign(project, campaign, episodes, eventMap, [campaign]);
  assert.equal(over.committedMoveCount, 17);
  assert.equal(over.overBudget, true);
  assert.equal(over.seventeenthCommittedMove.eventId, 'move-17');
  assert.equal(over.committedMovesAfterBudget.length, 1);
}

async function main() {
  selfTest();
  const [matrixArgument, outputArgument] = process.argv.slice(2);
  if (!matrixArgument) {
    throw new Error('usage: node scripts/audit-project-search-campaign-budget.mjs <matrix.json> [output.json]');
  }
  const matrixPath = path.resolve(matrixArgument);
  const outputPath = outputArgument ? path.resolve(outputArgument) : null;
  const matrixText = await readFile(matrixPath, 'utf8');
  const matrix = JSON.parse(matrixText);
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
      matrixSha256: createHash('sha256').update(matrixText).digest('hex'),
      experiment: matrix.experiment ?? null,
      matrixSchemaVersion: matrix.schemaVersion ?? null,
      matrixGeneratedAt: matrix.generatedAt ?? null,
      runCount: matrix.runs.length,
    },
    method: {
      authority: 'SQLite terminal SimulationState loaded read-only through sqlite-run-reader.mjs; no run is advanced',
      budget: SEARCH_CAMPAIGN_ACTION_BUDGET,
      committedMoveDefinition: 'Within one project searchCampaignId, take the unique union of every linked search episode actionEventIds. Count only IDs resolving to status=completed|progressed, kind=action, cause=intent, action.kind=move, and action.toCellId/action.toZ equal to at least one linked episode locked target.',
      unresolvedPolicy: 'Unresolved actionEventIds are reported separately and never counted as committed moves.',
      afterBudgetDefinition: 'The seventeenth and all later committed moves in authoritative event order; each is a hard budget violation.',
      targetDefinition: 'attemptedTargetKeys are campaign facts; episode targets are the unique locked cellId:z pairs. Both maxima are reported without treating one as the other.',
      lifecycleDefinition: 'Campaign status/closedAt and episode status/endedAt/endingReason are checked separately. Current ProjectSearchCampaign has no endingReason contract, so campaign endingReason remains explicitly unsupported rather than inferred.',
      exactBudgetClosure: 'At the sixteenth committed move, campaign must be exhausted with closedAt in that month. Its matching episode must end in that month as fulfilled/search-target-reached when the actual destination reaches the lock, otherwise exhausted/search-budget-exhausted.',
      embeddedSelfTest: 'Locks a clean 10+6 cross-episode budget chain, excludes duplicate IDs, survival-reflex, wrong-target and unresolved evidence, and detects an injected seventeenth move.',
      zeroDenominatorPolicy: 'Coverage is null when its denominator is zero; absence is unsupported, never 100%.',
    },
    aggregates: aggregateRuns(runs),
    runs,
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, serialized, 'utf8');
  else process.stdout.write(serialized);
}

await main();
