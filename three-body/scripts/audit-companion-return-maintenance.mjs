#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { openSqliteRunReader } from './sqlite-run-reader.mjs';

const AUDIT_VERSION = 'companion-return-maintenance-audit-v1';
const RETURN_OPTION_PREFIX = 'return-shared-living:';
const ESTABLISHED_RETURN_AFTER_AWAY_MONTHS = 3;
const RETURN_EPISODE_JOIN_GAP_MONTHS = 3;
const RETURN_SUCCESS_WINDOW_MONTHS = 3;
const OSCILLATION_WINDOW_MONTHS = 12;
const ROLLING_MOVE_WINDOW_MONTHS = 24;

const asArray = (value) => Array.isArray(value) ? value : [];
const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const stringValue = (value) => typeof value === 'string' && value.length > 0 ? value : null;
const integerValue = (value) => Number.isInteger(value) ? value : null;
const unique = (values) => [...new Set(values.filter(Boolean))].sort();

function usage() {
  process.stderr.write(`Audit companion return maintenance from authoritative SQLite histories.

Usage:
  node scripts/audit-companion-return-maintenance.mjs --prefix RUN_PREFIX [--checkpoints 240,480,720] [--out OUTPUT.json]
  node scripts/audit-companion-return-maintenance.mjs --run-id RUN_ID[,RUN_ID...] [--checkpoints 240,480,720] [--out OUTPUT.json]
`);
}

function parseCheckpoints(value) {
  const result = unique(value.split(',').map((item) => {
    const parsed = Number(item.trim());
    if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid checkpoint month: ${item}`);
    return String(parsed);
  })).map(Number).sort((left, right) => left - right);
  if (!result.length) throw new Error('Provide at least one checkpoint month');
  return result;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if (!argument.startsWith('--')) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    index += 1;
    if (argument === '--prefix') parsed.prefix = value;
    else if (argument === '--run-id') parsed.runIds = value.split(',').map((item) => item.trim()).filter(Boolean);
    else if (argument === '--checkpoints') parsed.checkpoints = parseCheckpoints(value);
    else if (argument === '--out') parsed.outputPath = path.resolve(value);
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (Boolean(parsed.prefix) === Boolean(parsed.runIds?.length)) {
    throw new Error('Provide exactly one of --prefix or --run-id');
  }
  return parsed;
}

function eventOrder(left, right) {
  return (integerValue(left.atMonth) ?? 0) - (integerValue(right.atMonth) ?? 0)
    || (integerValue(left.orderInMonth) ?? 0) - (integerValue(right.orderInMonth) ?? 0)
    || (integerValue(left.actionTick) ?? 0) - (integerValue(right.actionTick) ?? 0)
    || String(left.id).localeCompare(String(right.id));
}

function ratio(numerator, denominator) {
  return {
    numerator,
    denominator,
    ratio: denominator > 0 ? numerator / denominator : null,
    percent: denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(3)) : null,
  };
}

function actionRef(event) {
  if (!event) return null;
  return {
    eventId: stringValue(event.id),
    atMonth: integerValue(event.atMonth),
    orderInMonth: integerValue(event.orderInMonth),
    actionTick: integerValue(event.actionTick),
    who: stringValue(event.who),
    intentId: stringValue(event.intentId),
    cause: stringValue(event.cause),
    actionKind: stringValue(event.action?.kind),
    status: stringValue(event.status),
    from: positionBeforeAction(event),
    to: positionAfterAction(event),
  };
}

function decisionRef(event) {
  if (!event) return null;
  return {
    eventId: stringValue(event.id),
    atMonth: integerValue(event.atMonth),
    orderInMonth: integerValue(event.orderInMonth),
    planningTick: integerValue(event.planningTick),
    who: stringValue(event.who),
    decisionKind: stringValue(event.decision?.kind),
    optionId: stringValue(event.decision?.optionId),
    intentId: stringValue(event.intentId),
    usedModel: typeof event.usedModel === 'boolean' ? event.usedModel : null,
  };
}

function intentRef(intent) {
  if (!intent) return null;
  return {
    intentId: stringValue(intent.id),
    ownerId: stringValue(intent.ownerId),
    summary: stringValue(intent.summary),
    status: stringValue(intent.status),
    createdAtMonth: integerValue(intent.createdAtMonth),
    lastProgressAtMonth: integerValue(intent.lastProgressAtMonth),
    sourceDecisionEventId: stringValue(intent.sourceDecisionEventId),
    actionEventIds: unique(asArray(intent.actionEventIds).map(stringValue)),
  };
}

function validAnchor(value) {
  return value?.version === 'shared-living-anchor-v1'
    && integerValue(value.cellId) !== null
    && integerValue(value.z) !== null
    && integerValue(value.radius) !== null
    && value.radius >= 1
    && value.radius <= 4;
}

function anchorForAgreement(agreement, eventById) {
  if (validAnchor(agreement?.proposal?.sharedLivingAnchor)) {
    const source = agreement.proposal.sharedLivingAnchor;
    return { version: 'shared-living-anchor-v1', cellId: source.cellId, z: source.z, radius: source.radius };
  }
  const proposalEvent = eventById.get(stringValue(agreement?.proposalEventId));
  const cellId = integerValue(proposalEvent?.toCellId);
  const z = integerValue(proposalEvent?.toZ);
  return cellId !== null && z !== null
    ? { version: 'shared-living-anchor-v1', cellId, z, radius: 2 }
    : null;
}

function anchorKey(anchor) {
  return anchor ? `${anchor.cellId}:${anchor.z}:r${anchor.radius}` : null;
}

function positionAfterAction(event) {
  const cellId = integerValue(event?.toCellId) ?? integerValue(event?.cellId);
  const z = integerValue(event?.toZ);
  return cellId !== null && z !== null ? { cellId, z } : null;
}

function positionBeforeAction(event) {
  const cellId = integerValue(event?.fromCellId) ?? integerValue(event?.cellId);
  const z = integerValue(event?.fromZ);
  return cellId !== null && z !== null ? { cellId, z } : null;
}

function personPositionAtMonthEnd(index, personId, atMonth) {
  const actions = index.actionsByPerson.get(personId) ?? [];
  let latest = null;
  for (const event of actions) {
    if ((integerValue(event.atMonth) ?? Number.POSITIVE_INFINITY) > atMonth) break;
    latest = event;
  }
  if (latest) return positionAfterAction(latest);
  const firstFuture = actions.find((event) => (integerValue(event.atMonth) ?? Number.NEGATIVE_INFINITY) > atMonth);
  if (firstFuture) return positionBeforeAction(firstFuture);
  const terminal = asObject(index.personById.get(personId)?.position);
  const cellId = integerValue(terminal?.cellId);
  const z = integerValue(terminal?.z);
  return cellId !== null && z !== null ? { cellId, z } : null;
}

function personAliveAtMonth(person, atMonth) {
  const bornAtMonth = integerValue(person?.bornAtMonth) ?? Number.NEGATIVE_INFINITY;
  const diedAtMonth = integerValue(person?.diedAtMonth);
  return bornAtMonth <= atMonth && (diedAtMonth === null || diedAtMonth > atMonth);
}

function positionWithinAnchor(index, position, anchor) {
  if (!position || !anchor) return false;
  const width = integerValue(index.state.world?.grid?.width) ?? 84;
  const x = position.cellId % width;
  const y = Math.floor(position.cellId / width);
  const anchorX = anchor.cellId % width;
  const anchorY = Math.floor(anchor.cellId / width);
  return Math.abs(x - anchorX) + Math.abs(y - anchorY) <= anchor.radius
    && Math.abs(position.z - anchor.z) <= 1;
}

function partiesCoLocatedAtMonth(index, agreement, anchor, atMonth) {
  const partyIds = unique(asArray(agreement?.partyIds).map(stringValue));
  if (partyIds.length < 2) return false;
  return partyIds.every((personId) => {
    const person = index.personById.get(personId);
    return personAliveAtMonth(person, atMonth)
      && positionWithinAnchor(index, personPositionAtMonthEnd(index, personId, atMonth), anchor);
  });
}

function coLocatedMonths(index, agreement, anchor, fromMonth, throughMonth) {
  if (!agreement || !anchor || throughMonth < fromMonth) return [];
  const cacheKey = `${agreement.id}|${anchorKey(anchor)}|${fromMonth}|${throughMonth}`;
  const cached = index.coLocationCache.get(cacheKey);
  if (cached) return [...cached];
  const months = [];
  for (let month = Math.max(0, fromMonth); month <= throughMonth; month += 1) {
    if (partiesCoLocatedAtMonth(index, agreement, anchor, month)) months.push(month);
  }
  index.coLocationCache.set(cacheKey, months);
  return [...months];
}

function resolveReturnAgreement(index, decision) {
  const optionId = stringValue(decision?.decision?.optionId);
  const personId = stringValue(decision?.who);
  if (!optionId || !personId || !optionId.startsWith(RETURN_OPTION_PREFIX)) return null;
  const exact = index.companionAgreements.find((agreement) => (
    optionId === `${RETURN_OPTION_PREFIX}${agreement.id}:${personId}`
  ));
  if (exact) return exact;
  const suffix = `:${personId}`;
  const encodedAgreementId = optionId.endsWith(suffix)
    ? optionId.slice(RETURN_OPTION_PREFIX.length, -suffix.length)
    : null;
  return encodedAgreementId ? index.agreementById.get(encodedAgreementId) ?? null : null;
}

function resolveReturnIntent(index, decision) {
  const decisionId = stringValue(decision.id);
  const decisionIntentId = stringValue(decision.intentId);
  const candidates = unique([
    decisionIntentId,
    ...asArray(index.intentsBySourceDecision.get(decisionId)).map((intent) => stringValue(intent.id)),
  ]).map((intentId) => index.intentById.get(intentId)).filter(Boolean);
  const exact = candidates.find((intent) => intent.id === decisionIntentId
    && intent.sourceDecisionEventId === decisionId);
  return exact ?? candidates.find((intent) => intent.sourceDecisionEventId === decisionId)
    ?? candidates.find((intent) => intent.id === decisionIntentId)
    ?? null;
}

function returnEdges(index, throughMonth) {
  return index.returnDecisions
    .filter((decision) => (integerValue(decision.atMonth) ?? Number.POSITIVE_INFINITY) <= throughMonth)
    .map((decision) => {
      const agreement = resolveReturnAgreement(index, decision);
      const anchor = anchorForAgreement(agreement, index.eventById);
      const intent = resolveReturnIntent(index, decision);
      const actionEventIds = unique(asArray(intent?.actionEventIds).map(stringValue));
      const missingActionEventIds = actionEventIds.filter((eventId) => !index.eventById.has(eventId));
      const actionIdSet = new Set(actionEventIds);
      const actionCandidates = unique([
        ...actionEventIds,
        ...asArray(index.actionsByIntent.get(stringValue(intent?.id))).map((event) => stringValue(event.id)),
      ]).map((eventId) => index.eventById.get(eventId)).filter((event) => event?.kind === 'action'
        && (integerValue(event.atMonth) ?? Number.POSITIVE_INFINITY) <= throughMonth);
      const moveEdges = actionCandidates
        .filter((event) => event.action?.kind === 'move')
        .sort(eventOrder)
        .map((event) => {
          const linkedByIntentActionEventIds = actionIdSet.has(event.id);
          const linkedByActionIntentId = event.intentId === intent?.id;
          const completedIntentMove = event.status === 'completed' && event.cause === 'intent';
          return {
            ...actionRef(event),
            linkedByIntentActionEventIds,
            linkedByActionIntentId,
            completedIntentMove,
            strictReturnMove: linkedByIntentActionEventIds && linkedByActionIntentId && completedIntentMove,
          };
        });
      const decisionId = stringValue(decision.id);
      const companionEstablishedAtMonth = integerValue(agreement?.companionEstablishedAtMonth);
      return {
        decision: decisionRef(decision),
        agreementId: stringValue(agreement?.id),
        agreementResolved: Boolean(agreement),
        companionEstablishedAtMonth,
        establishedMaintenanceAtDecision: companionEstablishedAtMonth !== null
          && companionEstablishedAtMonth <= decision.atMonth,
        partyIds: unique(asArray(agreement?.partyIds).map(stringValue)),
        anchor,
        anchorKey: anchorKey(anchor),
        intent: intentRef(intent),
        decisionIntentMatches: Boolean(intent && decision.intentId === intent.id),
        sourceDecisionMatches: Boolean(intent && intent.sourceDecisionEventId === decisionId),
        missingActionEventIds,
        moveEdges,
        strictMoveEventIds: moveEdges.filter((edge) => edge.strictReturnMove).map((edge) => edge.eventId),
      };
    });
}

function episodeSuccess(index, agreement, anchor, startMonth, throughMonth) {
  const observationEndMonth = startMonth + RETURN_SUCCESS_WINDOW_MONTHS;
  const observedThroughMonth = Math.min(observationEndMonth, throughMonth);
  const jointEntryMonths = coLocatedMonths(index, agreement, anchor, startMonth, observedThroughMonth);
  return {
    success: jointEntryMonths.length > 0 ? true : throughMonth >= observationEndMonth ? false : null,
    firstJointEntryAtMonth: jointEntryMonths[0] ?? null,
    jointEntryMonths,
    window: {
      fromMonth: startMonth,
      throughMonth: observationEndMonth,
      observedThroughMonth,
      censoredByRunEnd: throughMonth < observationEndMonth,
    },
  };
}

function collapseReturnEpisodes(index, edges, throughMonth) {
  const buckets = new Map();
  for (const edge of edges.filter((candidate) => candidate.agreementId && candidate.anchorKey)) {
    const key = `${edge.decision.who}|${edge.agreementId}|${edge.anchorKey}`;
    const list = buckets.get(key) ?? [];
    list.push(edge);
    buckets.set(key, list);
  }
  const episodes = [];
  for (const bucket of buckets.values()) {
    bucket.sort((left, right) => left.decision.atMonth - right.decision.atMonth
      || String(left.decision.eventId).localeCompare(String(right.decision.eventId)));
    let current = null;
    for (const edge of bucket) {
      const evidenceMonths = [
        edge.decision.atMonth,
        ...edge.moveEdges.map((move) => move.atMonth),
      ].filter((month) => month !== null);
      const edgeEndMonth = evidenceMonths.length ? Math.max(...evidenceMonths) : edge.decision.atMonth;
      if (!current || edge.decision.atMonth > current.endMonth + RETURN_EPISODE_JOIN_GAP_MONTHS) {
        if (current) episodes.push(current);
        current = {
          personId: edge.decision.who,
          agreementId: edge.agreementId,
          partyIds: edge.partyIds,
          anchor: edge.anchor,
          anchorKey: edge.anchorKey,
          startMonth: edge.decision.atMonth,
          endMonth: edgeEndMonth,
          decisionEventIds: [edge.decision.eventId],
          intentIds: edge.intent?.intentId ? [edge.intent.intentId] : [],
          strictMoveEventIds: [...edge.strictMoveEventIds],
          establishedMaintenanceFlags: [edge.establishedMaintenanceAtDecision],
        };
      } else {
        current.endMonth = Math.max(current.endMonth, edgeEndMonth);
        current.decisionEventIds.push(edge.decision.eventId);
        if (edge.intent?.intentId) current.intentIds.push(edge.intent.intentId);
        current.strictMoveEventIds.push(...edge.strictMoveEventIds);
        current.establishedMaintenanceFlags.push(edge.establishedMaintenanceAtDecision);
      }
    }
    if (current) episodes.push(current);
  }
  return episodes
    .sort((left, right) => left.startMonth - right.startMonth
      || left.personId.localeCompare(right.personId)
      || left.agreementId.localeCompare(right.agreementId))
    .map((episode, indexInResult) => {
      const agreement = index.agreementById.get(episode.agreementId);
      return {
        episodeId: `return-episode-${indexInResult + 1}`,
        ...episode,
        decisionEventIds: unique(episode.decisionEventIds),
        intentIds: unique(episode.intentIds),
        strictMoveEventIds: unique(episode.strictMoveEventIds),
        returnPhase: episode.establishedMaintenanceFlags.every(Boolean)
          ? 'established-maintenance'
          : episode.establishedMaintenanceFlags.some(Boolean)
            ? 'mixed'
            : 'pre-establishment',
        establishedMaintenanceFlags: undefined,
        successWithinThreeMonths: episodeSuccess(
          index,
          agreement,
          episode.anchor,
          episode.startMonth,
          throughMonth,
        ),
      };
    });
}

function anchorsGeometricallyCompatible(index, first, second) {
  if (!first || !second) return false;
  const width = integerValue(index.state.world?.grid?.width) ?? 84;
  const firstX = first.cellId % width;
  const firstY = Math.floor(first.cellId / width);
  const secondX = second.cellId % width;
  const secondY = Math.floor(second.cellId / width);
  return Math.abs(firstX - secondX) + Math.abs(firstY - secondY) <= first.radius + second.radius
    && Math.abs(first.z - second.z) <= 2;
}

function transitionRefresh(index, fromEpisode, toEpisode) {
  const agreement = index.agreementById.get(fromEpisode.agreementId);
  const throughMonth = toEpisode.startMonth - 1;
  const refreshMonths = coLocatedMonths(
    index,
    agreement,
    fromEpisode.anchor,
    fromEpisode.startMonth,
    throughMonth,
  );
  return {
    fromEpisodeId: fromEpisode.episodeId,
    toEpisodeId: toEpisode.episodeId,
    fromAgreementId: fromEpisode.agreementId,
    fromAnchorKey: fromEpisode.anchorKey,
    switchedAtMonth: toEpisode.startMonth,
    refreshMonths,
    refreshedBeforeSwitch: refreshMonths.length > 0,
  };
}

function oscillationPatterns(index, episodes) {
  const byPerson = new Map();
  for (const episode of episodes) {
    const list = byPerson.get(episode.personId) ?? [];
    list.push(episode);
    byPerson.set(episode.personId, list);
  }
  const patterns = [];
  const inspect = (personId, sequence, labels) => {
    const spanMonths = sequence.at(-1).startMonth - sequence[0].startMonth;
    if (spanMonths > OSCILLATION_WINDOW_MONTHS) return;
    const anchors = sequence.map((episode) => episode.anchorKey);
    const matches = labels.every((label, position) => anchors[position] === anchors[labels.indexOf(label)])
      && new Set(anchors).size === 2;
    if (!matches) return;
    const firstA = sequence[0];
    const firstB = sequence.find((episode) => episode.anchorKey !== firstA.anchorKey);
    if (!firstB || anchorsGeometricallyCompatible(index, firstA.anchor, firstB.anchor)) return;
    const transitions = sequence.slice(0, -1).map((episode, position) => transitionRefresh(index, episode, sequence[position + 1]));
    if (transitions.some((transition) => transition.refreshedBeforeSwitch)) return;
    patterns.push({
      pattern: labels.join(''),
      personId,
      startMonth: sequence[0].startMonth,
      endMonth: sequence.at(-1).startMonth,
      spanMonths,
      episodeIds: sequence.map((episode) => episode.episodeId),
      agreementIds: sequence.map((episode) => episode.agreementId),
      anchorKeys: anchors,
      incompatibleAnchorKeys: [firstA.anchorKey, firstB.anchorKey],
      transitions,
    });
  };
  for (const [personId, personEpisodes] of byPerson) {
    personEpisodes.sort((left, right) => left.startMonth - right.startMonth || left.episodeId.localeCompare(right.episodeId));
    for (let indexInPerson = 0; indexInPerson + 2 < personEpisodes.length; indexInPerson += 1) {
      inspect(personId, personEpisodes.slice(indexInPerson, indexInPerson + 3), ['A', 'B', 'A']);
    }
    for (let indexInPerson = 0; indexInPerson + 3 < personEpisodes.length; indexInPerson += 1) {
      inspect(personId, personEpisodes.slice(indexInPerson, indexInPerson + 4), ['A', 'B', 'A', 'B']);
    }
  }
  return patterns;
}

function completedIntentMoves(index, throughMonth) {
  return index.events.filter((event) => event.kind === 'action'
    && event.action?.kind === 'move'
    && event.status === 'completed'
    && event.cause === 'intent'
    && stringValue(event.intentId)
    && (integerValue(event.atMonth) ?? Number.POSITIVE_INFINITY) <= throughMonth);
}

function rollingMoveShares(index, throughMonth, strictReturnMoveIds) {
  const completedMoves = completedIntentMoves(index, throughMonth);
  const byPerson = new Map();
  for (const event of completedMoves) {
    const list = byPerson.get(event.who) ?? [];
    list.push(event);
    byPerson.set(event.who, list);
  }
  const people = [...byPerson].map(([personId, moves]) => {
    const total = moves.length;
    const totalReturns = moves.filter((move) => strictReturnMoveIds.has(move.id)).length;
    let maximum = { fromMonth: null, throughMonth: null, ...ratio(0, 0) };
    const firstMonth = moves.reduce((minimum, event) => Math.min(minimum, event.atMonth), throughMonth);
    for (let endMonth = firstMonth; endMonth <= throughMonth; endMonth += 1) {
      const startMonth = Math.max(0, endMonth - ROLLING_MOVE_WINDOW_MONTHS + 1);
      const windowMoves = moves.filter((move) => move.atMonth >= startMonth && move.atMonth <= endMonth);
      if (!windowMoves.length) continue;
      const windowReturns = windowMoves.filter((move) => strictReturnMoveIds.has(move.id)).length;
      const candidate = { fromMonth: startMonth, throughMonth: endMonth, ...ratio(windowReturns, windowMoves.length) };
      if ((candidate.ratio ?? -1) > (maximum.ratio ?? -1)
        || (candidate.ratio === maximum.ratio && candidate.numerator > maximum.numerator)
        || (candidate.ratio === maximum.ratio && candidate.numerator === maximum.numerator
          && candidate.denominator > maximum.denominator)) maximum = candidate;
    }
    return {
      personId,
      allTime: ratio(totalReturns, total),
      rolling24MonthMaximum: maximum,
    };
  }).sort((left, right) => (right.rolling24MonthMaximum.ratio ?? -1) - (left.rolling24MonthMaximum.ratio ?? -1)
    || right.rolling24MonthMaximum.numerator - left.rolling24MonthMaximum.numerator
    || left.personId.localeCompare(right.personId));
  return {
    global: ratio(strictReturnMoveIds.size, completedMoves.length),
    personRolling24MonthMaximum: people,
    highestPersonRolling24Month: people[0] ?? null,
  };
}

function companionActiveAtMonth(agreement, atMonth) {
  if (agreement?.proposal?.kind !== 'companion') return false;
  const establishedAtMonth = integerValue(agreement.companionEstablishedAtMonth);
  const acceptedAtMonth = integerValue(agreement.acceptedAtMonth);
  if (establishedAtMonth === null || establishedAtMonth > atMonth) return false;
  if (acceptedAtMonth !== null && acceptedAtMonth > atMonth) return false;
  const resolvedAtMonth = integerValue(agreement.resolvedAtMonth);
  if (['cancelled', 'breached', 'expired', 'rejected'].includes(agreement.status)
    && (resolvedAtMonth === null || resolvedAtMonth <= atMonth)) return false;
  if (agreement.status === 'fulfilled') return true;
  return agreement.status === 'active' || resolvedAtMonth === null || resolvedAtMonth > atMonth;
}

function anchorVolume(index, anchor) {
  const width = integerValue(index.state.world?.grid?.width) ?? 84;
  const depth = integerValue(index.state.world?.grid?.depth) ?? 52;
  const levels = integerValue(index.state.world?.grid?.levels) ?? 12;
  const anchorX = anchor.cellId % width;
  const anchorY = Math.floor(anchor.cellId / width);
  const positions = [];
  for (let y = Math.max(0, anchorY - anchor.radius); y <= Math.min(depth - 1, anchorY + anchor.radius); y += 1) {
    for (let x = Math.max(0, anchorX - anchor.radius); x <= Math.min(width - 1, anchorX + anchor.radius); x += 1) {
      if (Math.abs(x - anchorX) + Math.abs(y - anchorY) > anchor.radius) continue;
      for (let z = Math.max(0, anchor.z - 1); z <= Math.min(levels - 1, anchor.z + 1); z += 1) {
        positions.push({ cellId: y * width + x, z });
      }
    }
  }
  return positions;
}

function bitCount(value) {
  let remaining = value;
  let count = 0;
  while (remaining > 0n) {
    count += Number(remaining & 1n);
    remaining >>= 1n;
  }
  return count;
}

function minimumCompatibleSites(index, anchors) {
  if (!anchors.length) return { exact: true, count: 0, sites: [], method: 'exact geometric anchor-volume set cover' };
  if (anchors.length > 20) return {
    exact: false,
    count: null,
    sites: [],
    method: 'not covered above 20 distinct due anchors',
    reason: `Exact set cover intentionally bounded; observed ${anchors.length} distinct due anchors.`,
  };
  const positionMasks = new Map();
  anchors.forEach((entry, anchorIndex) => {
    for (const position of anchorVolume(index, entry.anchor)) {
      const key = `${position.cellId}:${position.z}`;
      const current = positionMasks.get(key) ?? { ...position, mask: 0n };
      current.mask |= 1n << BigInt(anchorIndex);
      positionMasks.set(key, current);
    }
  });
  const candidates = [...positionMasks.values()]
    .sort((left, right) => bitCount(right.mask) - bitCount(left.mask) || left.cellId - right.cellId || left.z - right.z)
    .filter((candidate, position, all) => !all.some((other, otherPosition) => otherPosition < position
      && (candidate.mask | other.mask) === other.mask));
  const targetMask = (1n << BigInt(anchors.length)) - 1n;
  let best = null;
  const memo = new Map();
  const search = (covered, chosen) => {
    if (covered === targetMask) {
      if (!best || chosen.length < best.length) best = [...chosen];
      return;
    }
    if (best && chosen.length >= best.length) return;
    const memoBest = memo.get(covered);
    if (memoBest !== undefined && memoBest <= chosen.length) return;
    memo.set(covered, chosen.length);
    let selectedBit = null;
    let selectedCandidates = null;
    for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex += 1) {
      const bit = 1n << BigInt(anchorIndex);
      if ((covered & bit) !== 0n) continue;
      const options = candidates.filter((candidate) => (candidate.mask & bit) !== 0n && (candidate.mask | covered) !== covered);
      if (!selectedCandidates || options.length < selectedCandidates.length) {
        selectedBit = bit;
        selectedCandidates = options;
      }
    }
    if (!selectedBit || !selectedCandidates?.length) return;
    for (const candidate of selectedCandidates) search(covered | candidate.mask, [...chosen, candidate]);
  };
  search(0n, []);
  return {
    exact: true,
    count: best?.length ?? null,
    sites: asArray(best).map((site) => ({
      cellId: site.cellId,
      z: site.z,
      coversAnchorKeys: anchors
        .filter((_, anchorIndex) => (site.mask & (1n << BigInt(anchorIndex))) !== 0n)
        .map((entry) => entry.anchorKey),
    })),
    method: 'exact geometric anchor-volume set cover; terrain standing validity and reachability are not asserted',
  };
}

function dueEstablishedAnchors(index, atMonth) {
  const dueByPerson = new Map();
  for (const agreement of index.companionAgreements.filter((candidate) => companionActiveAtMonth(candidate, atMonth))) {
    const anchor = anchorForAgreement(agreement, index.eventById);
    if (!anchor) continue;
    const establishedAtMonth = integerValue(agreement.companionEstablishedAtMonth);
    const colocated = coLocatedMonths(index, agreement, anchor, establishedAtMonth, atMonth);
    const lastCoLocatedAtMonth = colocated.at(-1) ?? establishedAtMonth;
    for (const personId of unique(asArray(agreement.partyIds).map(stringValue))) {
      const person = index.personById.get(personId);
      if (!personAliveAtMonth(person, atMonth)) continue;
      const position = personPositionAtMonthEnd(index, personId, atMonth);
      if (positionWithinAnchor(index, position, anchor)) continue;
      if (atMonth - lastCoLocatedAtMonth < ESTABLISHED_RETURN_AFTER_AWAY_MONTHS) continue;
      const list = dueByPerson.get(personId) ?? [];
      list.push({
        agreementId: agreement.id,
        partnerIds: unique(asArray(agreement.partyIds).map(stringValue)).filter((candidate) => candidate !== personId),
        anchor,
        anchorKey: anchorKey(anchor),
        establishedAtMonth,
        reconstructedLastCoLocatedAtMonth: lastCoLocatedAtMonth,
        awayMonths: atMonth - lastCoLocatedAtMonth,
      });
      dueByPerson.set(personId, list);
    }
  }
  const people = [...dueByPerson].map(([personId, agreements]) => {
    const distinct = new Map();
    for (const entry of agreements) {
      const current = distinct.get(entry.anchorKey) ?? {
        anchorKey: entry.anchorKey,
        anchor: entry.anchor,
        agreementIds: [],
        partnerIds: [],
      };
      current.agreementIds.push(entry.agreementId);
      current.partnerIds.push(...entry.partnerIds);
      distinct.set(entry.anchorKey, current);
    }
    const distinctAnchors = [...distinct.values()].map((entry) => ({
      ...entry,
      agreementIds: unique(entry.agreementIds),
      partnerIds: unique(entry.partnerIds),
    })).sort((left, right) => left.anchorKey.localeCompare(right.anchorKey));
    return {
      personId,
      dueAgreementCount: agreements.length,
      distinctDueAnchorCount: distinctAnchors.length,
      dueAgreements: agreements.sort((left, right) => left.agreementId.localeCompare(right.agreementId)),
      distinctDueAnchors: distinctAnchors,
      minimumCompatibleSites: minimumCompatibleSites(index, distinctAnchors),
    };
  }).sort((left, right) => right.distinctDueAnchorCount - left.distinctDueAnchorCount
    || left.personId.localeCompare(right.personId));
  return {
    atMonth,
    peopleWithDueEstablishedAnchors: people.length,
    people,
  };
}

function summarizeAtMonth(index, atMonth, includeEdges) {
  const edges = returnEdges(index, atMonth);
  const strictReturnMoveIds = new Set(edges.flatMap((edge) => edge.strictMoveEventIds));
  const strictEstablishedMaintenanceReturnMoveIds = new Set(edges
    .filter((edge) => edge.establishedMaintenanceAtDecision)
    .flatMap((edge) => edge.strictMoveEventIds));
  const episodes = collapseReturnEpisodes(index, edges, atMonth);
  const oscillations = oscillationPatterns(index, episodes);
  const episodeById = new Map(episodes.map((episode) => [episode.episodeId, episode]));
  const establishedMaintenanceOscillations = oscillations.filter((pattern) => pattern.episodeIds
    .every((episodeId) => episodeById.get(episodeId)?.returnPhase === 'established-maintenance'));
  const moveShares = rollingMoveShares(index, atMonth, strictReturnMoveIds);
  const successes = episodes.map((episode) => episode.successWithinThreeMonths.success);
  return {
    atMonth,
    returnDecisions: edges.length,
    establishedMaintenanceReturnDecisions: edges.filter((edge) => edge.establishedMaintenanceAtDecision).length,
    resolvedReturnIntents: new Set(edges.map((edge) => edge.intent?.intentId).filter(Boolean)).size,
    strictActualReturnMoves: strictReturnMoveIds.size,
    strictEstablishedMaintenanceReturnMoves: strictEstablishedMaintenanceReturnMoveIds.size,
    unresolvedDecisionToIntentEdges: edges.filter((edge) => !edge.decisionIntentMatches || !edge.sourceDecisionMatches).length,
    unresolvedIntentToActionEdges: edges.filter((edge) => edge.missingActionEventIds.length > 0
      || edge.moveEdges.some((move) => !move.linkedByIntentActionEventIds || !move.linkedByActionIntentId)).length,
    moveShares,
    establishedMaintenanceCompletedIntentMoveShare: ratio(
      strictEstablishedMaintenanceReturnMoveIds.size,
      moveShares.global.denominator,
    ),
    returnEpisodes: {
      count: episodes.length,
      establishedMaintenanceCount: episodes.filter((episode) => episode.returnPhase === 'established-maintenance').length,
      succeededWithinThreeMonths: successes.filter((value) => value === true).length,
      failedAfterFullThreeMonthWindow: successes.filter((value) => value === false).length,
      censoredAtSliceEnd: successes.filter((value) => value === null).length,
      episodes,
    },
    incompatibleAnchorOscillation: {
      aba: oscillations.filter((item) => item.pattern === 'ABA').length,
      abab: oscillations.filter((item) => item.pattern === 'ABAB').length,
      establishedMaintenanceAba: establishedMaintenanceOscillations.filter((item) => item.pattern === 'ABA').length,
      establishedMaintenanceAbab: establishedMaintenanceOscillations.filter((item) => item.pattern === 'ABAB').length,
      patterns: oscillations,
    },
    activeEstablishedDueAnchors: dueEstablishedAnchors(index, atMonth),
    ...(includeEdges ? { returnEdges: edges } : {}),
  };
}

function buildIndex(persisted) {
  const { state } = persisted;
  const events = [...asArray(state.world?.past)].sort(eventOrder);
  const eventById = new Map(events.flatMap((event) => stringValue(event.id) ? [[event.id, event]] : []));
  const intents = asArray(state.intents);
  const intentById = new Map(intents.flatMap((intent) => stringValue(intent.id) ? [[intent.id, intent]] : []));
  const intentsBySourceDecision = new Map();
  for (const intent of intents) {
    const sourceDecisionEventId = stringValue(intent.sourceDecisionEventId);
    if (!sourceDecisionEventId) continue;
    const list = intentsBySourceDecision.get(sourceDecisionEventId) ?? [];
    list.push(intent);
    intentsBySourceDecision.set(sourceDecisionEventId, list);
  }
  const actionsByIntent = new Map();
  const actionsByPerson = new Map();
  for (const event of events.filter((candidate) => candidate.kind === 'action')) {
    const intentId = stringValue(event.intentId);
    if (intentId) {
      const byIntent = actionsByIntent.get(intentId) ?? [];
      byIntent.push(event);
      actionsByIntent.set(intentId, byIntent);
    }
    const personId = stringValue(event.who);
    if (personId) {
      const byPerson = actionsByPerson.get(personId) ?? [];
      byPerson.push(event);
      actionsByPerson.set(personId, byPerson);
    }
  }
  const agreements = asArray(state.agreements);
  return {
    persisted,
    state,
    events,
    eventById,
    intentById,
    intentsBySourceDecision,
    actionsByIntent,
    actionsByPerson,
    personById: new Map(asArray(state.people).flatMap((person) => stringValue(person.id) ? [[person.id, person]] : [])),
    agreementById: new Map(agreements.flatMap((agreement) => stringValue(agreement.id) ? [[agreement.id, agreement]] : [])),
    companionAgreements: agreements.filter((agreement) => agreement.proposal?.kind === 'companion'),
    returnDecisions: events.filter((event) => event.kind === 'decision'
      && stringValue(event.decision?.optionId)?.startsWith(RETURN_OPTION_PREFIX)),
    coLocationCache: new Map(),
  };
}

function auditRun(persisted, requestedCheckpoints) {
  const index = buildIndex(persisted);
  const elapsedMonths = integerValue(index.state.clock?.elapsedMonths) ?? persisted.meta.elapsedMonths ?? 0;
  const reached = requestedCheckpoints.filter((month) => month <= elapsedMonths);
  return {
    runId: persisted.meta.id,
    seed: integerValue(index.state.seed),
    status: persisted.meta.status ?? index.state.civilization?.status ?? null,
    elapsedMonths,
    terminal: summarizeAtMonth(index, elapsedMonths, true),
    checkpoints: {
      requested: requestedCheckpoints,
      reached,
      unreached: requestedCheckpoints.filter((month) => month > elapsedMonths),
      slices: reached.map((month) => summarizeAtMonth(index, month, false)),
    },
  };
}

function aggregate(runs) {
  const terminalSlices = runs.map((run) => run.terminal);
  const numerator = terminalSlices.reduce((sum, slice) => sum + slice.moveShares.global.numerator, 0);
  const denominator = terminalSlices.reduce((sum, slice) => sum + slice.moveShares.global.denominator, 0);
  const rollingCandidates = runs.flatMap((run) => run.terminal.moveShares.personRolling24MonthMaximum
    .map((entry) => ({ runId: run.runId, ...entry })));
  rollingCandidates.sort((left, right) => (right.rolling24MonthMaximum.ratio ?? -1)
    - (left.rolling24MonthMaximum.ratio ?? -1)
    || right.rolling24MonthMaximum.numerator - left.rolling24MonthMaximum.numerator
    || left.runId.localeCompare(right.runId)
    || left.personId.localeCompare(right.personId));
  return {
    runs: runs.length,
    returnDecisions: terminalSlices.reduce((sum, slice) => sum + slice.returnDecisions, 0),
    establishedMaintenanceReturnDecisions: terminalSlices.reduce((sum, slice) => sum
      + slice.establishedMaintenanceReturnDecisions, 0),
    resolvedReturnIntents: terminalSlices.reduce((sum, slice) => sum + slice.resolvedReturnIntents, 0),
    strictActualReturnMoves: numerator,
    strictEstablishedMaintenanceReturnMoves: terminalSlices.reduce((sum, slice) => sum
      + slice.strictEstablishedMaintenanceReturnMoves, 0),
    completedIntentMoveShare: ratio(numerator, denominator),
    establishedMaintenanceCompletedIntentMoveShare: ratio(
      terminalSlices.reduce((sum, slice) => sum + slice.strictEstablishedMaintenanceReturnMoves, 0),
      denominator,
    ),
    highestPersonRolling24Month: rollingCandidates[0] ?? null,
    returnEpisodes: terminalSlices.reduce((sum, slice) => sum + slice.returnEpisodes.count, 0),
    successfulReturnEpisodes: terminalSlices.reduce((sum, slice) => sum + slice.returnEpisodes.succeededWithinThreeMonths, 0),
    abaWithoutRefresh: terminalSlices.reduce((sum, slice) => sum + slice.incompatibleAnchorOscillation.aba, 0),
    ababWithoutRefresh: terminalSlices.reduce((sum, slice) => sum + slice.incompatibleAnchorOscillation.abab, 0),
    establishedMaintenanceAbaWithoutRefresh: terminalSlices.reduce((sum, slice) => sum
      + slice.incompatibleAnchorOscillation.establishedMaintenanceAba, 0),
    establishedMaintenanceAbabWithoutRefresh: terminalSlices.reduce((sum, slice) => sum
      + slice.incompatibleAnchorOscillation.establishedMaintenanceAbab, 0),
    peopleWithMultipleDistinctDueAnchors: terminalSlices.reduce((sum, slice) => sum
      + slice.activeEstablishedDueAnchors.people.filter((person) => person.distinctDueAnchorCount > 1).length, 0),
  };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage();
    throw error;
  }
  if (args.help) {
    usage();
    return;
  }
  const reader = await openSqliteRunReader();
  try {
    const metadata = await reader.store.list();
    const runIds = args.prefix
      ? metadata.filter((meta) => meta.id.startsWith(args.prefix)).map((meta) => meta.id).sort()
      : unique(args.runIds);
    if (!runIds.length) throw new Error(`No runs matched ${args.prefix ? `prefix ${args.prefix}` : 'the supplied run IDs'}`);
    const runs = [];
    for (const runId of runIds) runs.push(auditRun(await reader.store.load(runId), args.checkpoints ?? []));
    const result = {
      schemaVersion: 1,
      auditVersion: AUDIT_VERSION,
      generatedAt: new Date().toISOString(),
      source: {
        authority: 'SQLite terminal SimulationState and append-only world.past loaded read-only through sqlite-run-reader.mjs; no run is advanced or mutated.',
        dataDirectory: reader.store.dataDirectory(),
        databaseFile: reader.store.filePath(),
        selector: args.prefix ? { prefix: args.prefix } : { runIds },
      },
      method: {
        returnEdge: 'decision.decision.optionId return-shared-living prefix -> decision.intentId plus intent.sourceDecisionEventId -> intent.actionEventIds plus action.intentId -> completed intent move.',
        returnEpisode: `Same person, agreement and fixed anchor are collapsed while the next return decision begins no more than ${RETURN_EPISODE_JOIN_GAP_MONTHS} months after prior evidence.`,
        success: `Both living agreement parties must be inside the fixed anchor at the same reconstructed calendar-month end, from the return decision month through +${RETURN_SUCCESS_WINDOW_MONTHS}; incomplete windows are censored, not failed.`,
        positions: 'Historical month-end positions use the last authoritative ActionFact at or before that month; before a first action, its from-position is used; a never-acting person falls back to terminal position.',
        moveShare: `Strict return completed moves divided by all completed cause=intent move ActionFacts; per-person maximum uses inclusive rolling ${ROLLING_MOVE_WINDOW_MONTHS}-month windows.`,
        oscillation: `Consecutive incompatible-anchor ABA/ABAB return episodes spanning <=${OSCILLATION_WINDOW_MONTHS} months, with no reconstructed joint anchor occupancy before any switch.`,
        dueAnchors: `At each slice, active established companionships are reconstructed from lifecycle months and month-end positions; return is due after ${ESTABLISHED_RETURN_AFTER_AWAY_MONTHS} months since reconstructed joint occupancy.`,
        minimumCompatibleSites: 'Exact geometric set cover over fixed-anchor Manhattan volumes for up to 20 distinct due anchors; it does not assert that the selected voxel is a valid standing site or reachable on terminal terrain.',
        checkpoints: 'Checkpoint outputs are month-bounded slices of the terminal authoritative append-only history and reconstructed agreement lifecycle, not independent checkpoint state blobs.',
      },
      aggregate: aggregate(runs),
      runs,
    };
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    if (args.outputPath) await writeFile(args.outputPath, serialized, 'utf8');
    else process.stdout.write(serialized);
  } finally {
    await reader.close();
  }
}

await main();
