#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { openSqliteRunReader } from './sqlite-run-reader.mjs';

const AUDIT_VERSION = 'generational-social-chain-audit-v2';

const asArray = (value) => Array.isArray(value) ? value : [];
const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const stringValue = (value) => typeof value === 'string' && value.length > 0 ? value : null;
const integerValue = (value) => Number.isInteger(value) ? value : null;
const unique = (values) => [...new Set(values.filter(Boolean))].sort();

function usage() {
  process.stderr.write(`Audit authoritative generational social chains from SQLite.

Usage:
  node scripts/audit-generational-social-chain.mjs --prefix RUN_PREFIX [--checkpoints 240,360,480] [--out OUTPUT.json]
  node scripts/audit-generational-social-chain.mjs --run-id RUN_ID[,RUN_ID...] [--checkpoints 240,360,480] [--out OUTPUT.json]
`);
}

function parseCheckpoints(value) {
  const checkpoints = unique(value.split(',').map((item) => {
    const parsed = Number(item.trim());
    if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid checkpoint month: ${item}`);
    return parsed;
  })).map(Number).sort((left, right) => left - right);
  if (!checkpoints.length) throw new Error('Provide at least one checkpoint month');
  return checkpoints;
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

function pairKey(ids) {
  return unique(ids).join('|');
}

function samePair(left, right) {
  return left.length === 2 && right.length === 2 && pairKey(left) === pairKey(right);
}

function sourceIdsFor(event) {
  const diff = asObject(event?.diff) ?? {};
  return unique([
    ...asArray(event?.sourceEventIds).map(stringValue),
    ...asArray(diff.sourceEventIds).map(stringValue),
  ]);
}

function eventRef(event) {
  if (!event) return null;
  const action = asObject(event.action);
  const content = asObject(action?.content);
  const diff = asObject(event.diff) ?? {};
  return {
    eventId: stringValue(event.id),
    kind: stringValue(event.kind),
    atMonth: integerValue(event.atMonth),
    orderInMonth: integerValue(event.orderInMonth),
    actionTick: integerValue(event.actionTick),
    who: stringValue(event.who),
    status: stringValue(event.status),
    intentId: stringValue(event.intentId),
    actionKind: stringValue(action?.kind),
    operation: stringValue(action?.operation),
    communicationKind: stringValue(content?.kind),
    representationId: stringValue(content?.id),
    referenceId: stringValue(content?.referenceId),
    authorizationRef: stringValue(action?.authorizationRef),
    agreementId: stringValue(event.agreementId) ?? stringValue(diff.agreementId),
    process: stringValue(diff.process),
    conceived: typeof diff.conceived === 'boolean' ? diff.conceived : null,
    dueAtMonth: integerValue(diff.dueAtMonth),
    sourceEventIds: sourceIdsFor(event),
  };
}

function resolvedSources(sourceEventIds, eventById) {
  const ids = unique(sourceEventIds.map(stringValue));
  return {
    sourceEventIds: ids,
    missingSourceEventIds: ids.filter((eventId) => !eventById.has(eventId)),
  };
}

function agreementRef(agreement, eventById, agreementFacts) {
  if (!agreement) return null;
  const proposalEvent = eventById.get(agreement.proposalEventId);
  const responseEvent = agreement.responseEventId ? eventById.get(agreement.responseEventId) : null;
  const fulfillmentEvents = asArray(agreement.fulfillmentEventIds).map((eventId) => eventById.get(eventId)).filter(Boolean);
  const lifecycleFacts = agreementFacts.get(agreement.id) ?? [];
  return {
    agreementId: agreement.id,
    kind: stringValue(agreement.proposal?.kind),
    status: stringValue(agreement.status),
    partyIds: unique(asArray(agreement.partyIds).map(stringValue)),
    proposedAtMonth: integerValue(agreement.proposedAtMonth),
    acceptedAtMonth: integerValue(agreement.acceptedAtMonth),
    dueAtMonth: integerValue(agreement.dueAtMonth),
    resolvedAtMonth: integerValue(agreement.resolvedAtMonth),
    companionEstablishedAtMonth: integerValue(agreement.companionEstablishedAtMonth),
    proposalEvent: eventRef(proposalEvent),
    responseEvent: eventRef(responseEvent),
    fulfillmentEvents: fulfillmentEvents.map(eventRef),
    lifecycleFacts: lifecycleFacts.map(eventRef),
    ...resolvedSources(asArray(agreement.sourceEventIds), eventById),
  };
}

function conceptionParentIds(event) {
  const diff = asObject(event.diff) ?? {};
  const exact = unique([stringValue(diff.femaleId), stringValue(diff.maleId)]);
  if (exact.length === 2) return exact;
  const action = asObject(event.action);
  const targetIds = asArray(action?.targets).flatMap((target) => target?.kind === 'person' && stringValue(target.personId)
    ? [target.personId]
    : []);
  return unique([stringValue(event.who), ...targetIds]);
}

function countByGeneration(people) {
  const counts = new Map();
  for (const person of people) {
    const generation = integerValue(person.generation) ?? 0;
    counts.set(generation, (counts.get(generation) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left - right));
}

function missingCounts(chains) {
  const counts = new Map();
  for (const link of chains.flatMap((chain) => chain.missingLinks)) counts.set(link, (counts.get(link) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function generationOf(personById, personId) {
  return integerValue(personById.get(personId)?.generation) ?? 0;
}

function generationPair(personById, personIds) {
  return personIds
    .filter(Boolean)
    .map((personId) => `g${generationOf(personById, personId)}`)
    .sort()
    .join('|') || 'unknown';
}

function emptyCompanyFunnel() {
  return { proposed: 0, accepted: 0, fulfilled: 0, rejected: 0, cancelled: 0, breached: 0 };
}

function emptyCompanionFunnel() {
  return { proposed: 0, accepted: 0, established: 0, active: 0, cancelled: 0, breached: 0 };
}

function agreementLifecycleMonth(agreement, agreementFacts, changes) {
  const months = (agreementFacts.get(agreement.id) ?? [])
    .filter((event) => changes.includes(event.change))
    .map((event) => integerValue(event.atMonth))
    .filter((month) => month !== null);
  return months.length ? Math.min(...months) : null;
}

function agreementOutcomeMonth(agreement, agreementFacts) {
  return integerValue(agreement.resolvedAtMonth)
    ?? agreementLifecycleMonth(agreement, agreementFacts, ['fulfilled', 'rejected', 'cancelled', 'breached']);
}

function incrementFunnelAtMonth(target, agreement, kind, atMonth, eventById, agreementFacts) {
  const proposedAtMonth = integerValue(agreement.proposedAtMonth);
  if (proposedAtMonth === null || proposedAtMonth > atMonth) return;
  target.proposed += 1;
  const acceptedAtMonth = integerValue(agreement.acceptedAtMonth);
  if (acceptedAtMonth !== null && acceptedAtMonth <= atMonth) target.accepted += 1;
  const outcomeMonth = agreementOutcomeMonth(agreement, agreementFacts);
  const outcomeReached = outcomeMonth !== null && outcomeMonth <= atMonth;
  const terminalReached = ['fulfilled', 'rejected', 'cancelled', 'breached'].includes(agreement.status)
    && outcomeReached;
  if (kind === 'company') {
    const fulfillmentReached = asArray(agreement.fulfillmentEventIds)
      .some((eventId) => (integerValue(eventById.get(eventId)?.atMonth) ?? Number.POSITIVE_INFINITY) <= atMonth)
      || (agreement.status === 'fulfilled' && outcomeReached);
    if (fulfillmentReached) target.fulfilled += 1;
    if (agreement.status === 'rejected' && outcomeReached) target.rejected += 1;
  } else {
    const establishedAtMonth = integerValue(agreement.companionEstablishedAtMonth)
      ?? agreementLifecycleMonth(agreement, agreementFacts, ['fulfilled']);
    if (establishedAtMonth !== null && establishedAtMonth <= atMonth) target.established += 1;
    if (acceptedAtMonth !== null && acceptedAtMonth <= atMonth && !terminalReached) target.active += 1;
  }
  if (agreement.status === 'cancelled' && outcomeReached) target.cancelled += 1;
  if (agreement.status === 'breached' && outcomeReached) target.breached += 1;
}

function socialFunnelAtMonth(state, events, personById, agreementFacts, atMonth) {
  const company = emptyCompanyFunnel();
  const companion = emptyCompanionFunnel();
  const companyByGenerationPair = {};
  const companionByGenerationPair = {};
  const eventById = new Map(events.flatMap((event) => stringValue(event.id) ? [[event.id, event]] : []));
  for (const agreement of asArray(state.agreements)) {
    const isCompany = agreement.proposal?.kind === 'assist' && agreement.proposal.need === 'company';
    const isCompanion = agreement.proposal?.kind === 'companion';
    if (!isCompany && !isCompanion) continue;
    if ((integerValue(agreement.proposedAtMonth) ?? Number.POSITIVE_INFINITY) > atMonth) continue;
    const key = generationPair(personById, unique(asArray(agreement.partyIds).map(stringValue)));
    if (isCompany) {
      companyByGenerationPair[key] ??= emptyCompanyFunnel();
      incrementFunnelAtMonth(company, agreement, 'company', atMonth, eventById, agreementFacts);
      incrementFunnelAtMonth(companyByGenerationPair[key], agreement, 'company', atMonth, eventById, agreementFacts);
      continue;
    }
    companionByGenerationPair[key] ??= emptyCompanionFunnel();
    incrementFunnelAtMonth(companion, agreement, 'companion', atMonth, eventById, agreementFacts);
    incrementFunnelAtMonth(companionByGenerationPair[key], agreement, 'companion', atMonth, eventById, agreementFacts);
  }
  const persistent = events.filter((event) => event.kind === 'environment'
    && event.change === 'relationship'
    && asObject(event.diff)?.process === 'persistent-shared-living'
    && (integerValue(event.atMonth) ?? Number.POSITIVE_INFINITY) <= atMonth);
  const persistentByGenerationPair = {};
  for (const event of persistent) {
    const key = generationPair(personById, unique(asArray(asObject(event.diff)?.participantIds).map(stringValue)));
    persistentByGenerationPair[key] = (persistentByGenerationPair[key] ?? 0) + 1;
  }
  return {
    company: { totals: company, byGenerationPair: companyByGenerationPair },
    companion: { totals: companion, byGenerationPair: companionByGenerationPair },
    persistentSharedLiving: {
      events: persistent.length,
      byGenerationPair: persistentByGenerationPair,
      firstAtMonth: persistent.length ? Math.min(...persistent.map((event) => event.atMonth)) : null,
      lastAtMonth: persistent.length ? Math.max(...persistent.map((event) => event.atMonth)) : null,
    },
  };
}

function socialFunnel(state, events, personById, agreementFacts) {
  return socialFunnelAtMonth(
    state,
    events,
    personById,
    agreementFacts,
    integerValue(state.clock?.elapsedMonths) ?? 0,
  );
}

function positionAfterAction(event) {
  const cellId = integerValue(event?.toCellId) ?? integerValue(event?.cellId);
  const z = integerValue(event?.toZ) ?? integerValue(event?.fromZ);
  return cellId !== null && z !== null ? { cellId, z } : null;
}

function positionBeforeAction(event) {
  const cellId = integerValue(event?.fromCellId) ?? integerValue(event?.cellId);
  const z = integerValue(event?.fromZ) ?? integerValue(event?.toZ);
  return cellId !== null && z !== null ? { cellId, z } : null;
}

function positionAtEvent(person, anchor, actionsByPerson) {
  const actions = actionsByPerson.get(person.id) ?? [];
  let latest = null;
  for (const action of actions) {
    if (eventOrder(action, anchor) > 0) break;
    latest = action;
  }
  if (latest) return positionAfterAction(latest);
  const firstFuture = actions.find((action) => eventOrder(action, anchor) > 0);
  if (firstFuture) return positionBeforeAction(firstFuture);
  const position = asObject(person.position);
  const cellId = integerValue(position?.cellId);
  const z = integerValue(position?.z);
  return cellId !== null && z !== null ? { cellId, z } : null;
}

function samePosition(first, second) {
  return first && second && first.cellId === second.cellId && first.z === second.z;
}

function aliveAtEvent(person, event) {
  const bornAtMonth = integerValue(person.bornAtMonth) ?? Number.NEGATIVE_INFINITY;
  const diedAtMonth = integerValue(person.diedAtMonth);
  return bornAtMonth <= event.atMonth && (diedAtMonth === null || diedAtMonth >= event.atMonth);
}

function socialProposalRoles(agreement) {
  if (agreement.proposal?.kind === 'assist' && agreement.proposal.need === 'company') return {
    kind: 'company',
    proposerId: stringValue(agreement.proposal.requesterId) ?? stringValue(agreement.proposerId),
    targetId: stringValue(agreement.proposal.helperId) ?? stringValue(agreement.responderId),
  };
  if (agreement.proposal?.kind === 'companion') return {
    kind: 'companion',
    proposerId: stringValue(agreement.proposal.proposerId) ?? stringValue(agreement.proposerId),
    targetId: stringValue(agreement.proposal.partnerId) ?? stringValue(agreement.responderId),
  };
  return null;
}

function orderedPersonMetadata(people) {
  const stateIndexById = new Map(people.map((person, index) => [person.id, index]));
  const birthRankById = new Map();
  for (const [generation, generationPeople] of Map.groupBy(
    people,
    (person) => integerValue(person.generation) ?? 0,
  )) {
    generationPeople
      .toSorted((left, right) => (integerValue(left.bornAtMonth) ?? 0) - (integerValue(right.bornAtMonth) ?? 0)
        || (stateIndexById.get(left.id) ?? 0) - (stateIndexById.get(right.id) ?? 0))
      .forEach((person, index) => birthRankById.set(person.id, { generation, rank: index + 1 }));
  }
  const ref = (personId) => {
    const person = people.find((candidate) => candidate.id === personId);
    if (!person) return { personId, missing: true };
    return {
      personId,
      name: person.name ?? null,
      generation: integerValue(person.generation) ?? 0,
      sex: person.sex ?? null,
      bornAtMonth: integerValue(person.bornAtMonth),
      stateInsertionIndex: stateIndexById.get(personId),
      generationBirthRank: birthRankById.get(personId)?.rank ?? null,
    };
  };
  return { stateIndexById, birthRankById, ref };
}

function incrementCount(counts, personId, amount = 1) {
  if (!personId) return;
  counts.set(personId, (counts.get(personId) ?? 0) + amount);
}

function personCountRows(counts, metadata) {
  return [...counts.entries()]
    .map(([personId, count]) => ({ ...metadata.ref(personId), count }))
    .sort((left, right) => (left.stateInsertionIndex ?? Number.POSITIVE_INFINITY)
      - (right.stateInsertionIndex ?? Number.POSITIVE_INFINITY));
}

function buildProposalMoments(state, events, eventById, atMonth) {
  const people = asArray(state.people);
  const metadata = orderedPersonMetadata(people);
  const actionsByPerson = Map.groupBy(
    events.filter((event) => event.kind === 'action' && stringValue(event.who)).sort(eventOrder),
    (event) => event.who,
  );
  return asArray(state.agreements)
    .flatMap((agreement) => {
      const roles = socialProposalRoles(agreement);
      const proposedAtMonth = integerValue(agreement.proposedAtMonth);
      if (!roles || proposedAtMonth === null || proposedAtMonth > atMonth) return [];
      const proposalEvent = eventById.get(agreement.proposalEventId);
      const proposer = people.find((person) => person.id === roles.proposerId);
      if (!proposalEvent || !proposer || !roles.targetId) return [{
        agreementId: agreement.id,
        eventId: stringValue(agreement.proposalEventId),
        atMonth: proposedAtMonth,
        kind: roles.kind,
        proposer: metadata.ref(roles.proposerId),
        target: metadata.ref(roles.targetId),
        reconstructable: false,
        reason: !proposalEvent ? 'proposal-event-missing' : !proposer ? 'proposer-missing' : 'target-missing',
      }];
      const proposerPosition = positionAtEvent(proposer, proposalEvent, actionsByPerson);
      if (!proposerPosition) return [{
        agreementId: agreement.id,
        eventId: proposalEvent.id,
        atMonth: proposalEvent.atMonth,
        kind: roles.kind,
        proposer: metadata.ref(roles.proposerId),
        target: metadata.ref(roles.targetId),
        reconstructable: false,
        reason: 'proposer-position-missing',
      }];
      const localCandidateIds = people
        .filter((person) => person.id !== proposer.id && aliveAtEvent(person, proposalEvent))
        .filter((person) => samePosition(positionAtEvent(person, proposalEvent, actionsByPerson), proposerPosition))
        .map((person) => person.id);
      const targetIndex = localCandidateIds.indexOf(roles.targetId);
      return [{
        agreementId: agreement.id,
        eventId: proposalEvent.id,
        atMonth: proposalEvent.atMonth,
        orderInMonth: integerValue(proposalEvent.orderInMonth),
        kind: roles.kind,
        proposer: metadata.ref(roles.proposerId),
        target: metadata.ref(roles.targetId),
        position: proposerPosition,
        reconstructable: targetIndex >= 0,
        reason: targetIndex >= 0 ? null : 'target-not-in-reconstructed-local-candidates',
        targetCandidateRank: targetIndex >= 0 ? targetIndex + 1 : null,
        targetWithinSliceCap: targetIndex >= 0 ? targetIndex < 3 : null,
        localCandidateCount: localCandidateIds.length,
        includedCandidateIds: localCandidateIds.slice(0, 3),
        excludedCandidateIds: localCandidateIds.slice(3),
      }];
    })
    .sort((left, right) => left.atMonth - right.atMonth
      || (left.orderInMonth ?? 0) - (right.orderInMonth ?? 0)
      || String(left.eventId).localeCompare(String(right.eventId)));
}

function birthOrderSliceAudit(state, events, personById, atMonth) {
  const people = asArray(state.people);
  const metadata = orderedPersonMetadata(people);
  const eventById = new Map(events.flatMap((event) => stringValue(event.id) ? [[event.id, event]] : []));
  const moments = buildProposalMoments(state, events, eventById, atMonth);
  const targetCounts = new Map();
  const includedCounts = new Map();
  const excludedCounts = new Map();
  const targetRankCounts = {};
  for (const moment of moments) {
    incrementCount(targetCounts, moment.target?.personId);
    for (const personId of asArray(moment.includedCandidateIds)) incrementCount(includedCounts, personId);
    for (const personId of asArray(moment.excludedCandidateIds)) incrementCount(excludedCounts, personId);
    if (integerValue(moment.targetCandidateRank) !== null) {
      const key = String(moment.targetCandidateRank);
      targetRankCounts[key] = (targetRankCounts[key] ?? 0) + 1;
    }
  }
  const generationOne = people.filter((person) => generationOf(personById, person.id) === 1
    && (integerValue(person.bornAtMonth) ?? Number.POSITIVE_INFINITY) <= atMonth);
  const generationOneByBirth = generationOne.toSorted((left, right) =>
    (metadata.birthRankById.get(left.id)?.rank ?? 0) - (metadata.birthRankById.get(right.id)?.rank ?? 0));
  const generationOneByInsertion = generationOne.toSorted((left, right) =>
    (metadata.stateIndexById.get(left.id) ?? 0) - (metadata.stateIndexById.get(right.id) ?? 0));
  const insertionMatchesBirthOrder = generationOneByBirth.map((person) => person.id).join('|')
    === generationOneByInsertion.map((person) => person.id).join('|');
  const generationOneRows = generationOneByBirth.map((person) => ({
    ...metadata.ref(person.id),
    targeted: targetCounts.get(person.id) ?? 0,
    includedInFirstThreeAtObservedProposalMoments: includedCounts.get(person.id) ?? 0,
    hardExcludedBySliceAtObservedProposalMoments: excludedCounts.get(person.id) ?? 0,
  }));
  const reconstructed = moments.filter((moment) => moment.reconstructable);
  const crowded = reconstructed.filter((moment) => moment.localCandidateCount > 3);
  const hardExcludedGenerationOneAppearances = generationOneRows.reduce(
    (sum, row) => sum + row.hardExcludedBySliceAtObservedProposalMoments,
    0,
  );
  const laterBornGenerationOneExclusions = generationOneRows
    .filter((row) => (row.generationBirthRank ?? 0) > 3)
    .reduce((sum, row) => sum + row.hardExcludedBySliceAtObservedProposalMoments, 0);
  const summariesByKind = Object.fromEntries(['company', 'companion'].map((kind) => {
    const selected = moments.filter((moment) => moment.kind === kind);
    const selectedReconstructed = selected.filter((moment) => moment.reconstructable);
    return [kind, {
      proposals: selected.length,
      reconstructed: selectedReconstructed.length,
      crowded: selectedReconstructed.filter((moment) => moment.localCandidateCount > 3).length,
      targetBeyondSliceCap: selectedReconstructed.filter((moment) => moment.targetWithinSliceCap === false).length,
      generationPair: Object.fromEntries([...Map.groupBy(selected, (moment) => generationPair(
        personById,
        [moment.proposer?.personId, moment.target?.personId],
      )).entries()].map(([key, values]) => [key, values.length]).sort(([left], [right]) => left.localeCompare(right))),
    }];
  }));
  return {
    atMonth,
    method: {
      candidateOrder: 'Reconstruct each real company/companion proposal location from ordered ActionFacts; enumerate co-located living people in SimulationState.people insertion order; the application inspects only positions 1-3.',
      limitation: 'A beyond-cap appearance proves structural option suppression at that observed moment, but does not assert that the excluded person would have passed every later relationship or body prerequisite.',
    },
    proposals: moments.length,
    reconstructedProposals: reconstructed.length,
    reconstructionFailures: moments.length - reconstructed.length,
    targetCandidateRankCounts: targetRankCounts,
    targetBeyondSliceCap: reconstructed.filter((moment) => moment.targetWithinSliceCap === false).length,
    crowdedProposalMoments: crowded.length,
    byKind: summariesByKind,
    generationOne: {
      people: generationOne.length,
      insertionOrderMatchesBirthOrder: insertionMatchesBirthOrder,
      hardExcludedAppearances: hardExcludedGenerationOneAppearances,
      laterBornRankFourOrGreaterExclusions: laterBornGenerationOneExclusions,
      peopleByBirthOrder: generationOneRows,
    },
    assessment: {
      allReconstructedTargetsWithinFirstThree: reconstructed.length > 0
        && reconstructed.every((moment) => moment.targetWithinSliceCap),
      supportsBirthOrderExclusionAtObservedMoments: insertionMatchesBirthOrder
        && crowded.length > 0
        && hardExcludedGenerationOneAppearances > 0
        && reconstructed.every((moment) => moment.targetWithinSliceCap),
    },
    targetedPeople: personCountRows(targetCounts, metadata),
    includedSlotAppearances: personCountRows(includedCounts, metadata),
    hardExcludedAppearances: personCountRows(excludedCounts, metadata),
    crowdedEvidence: crowded,
    reconstructionFailureEvidence: moments.filter((moment) => !moment.reconstructable),
  };
}

function directedRelation(person, otherId) {
  return asArray(person.relations).find((relation) => relation.personId === otherId) ?? null;
}

function bilateralRelationship(first, second) {
  const firstToSecond = directedRelation(first, second.id);
  const secondToFirst = directedRelation(second, first.id);
  const values = [
    firstToSecond?.trust,
    firstToSecond?.bond,
    secondToFirst?.trust,
    secondToFirst?.bond,
  ];
  const minimum = values.every((value) => typeof value === 'number' && Number.isFinite(value))
    ? Math.min(...values)
    : null;
  return {
    minimumTrustBond: minimum,
    firstToSecond: firstToSecond ? {
      trust: firstToSecond.trust,
      bond: firstToSecond.bond,
      fear: firstToSecond.fear,
      sourceEventIds: unique(asArray(firstToSecond.sourceEventIds).map(stringValue)),
    } : null,
    secondToFirst: secondToFirst ? {
      trust: secondToFirst.trust,
      bond: secondToFirst.bond,
      fear: secondToFirst.fear,
      sourceEventIds: unique(asArray(secondToFirst.sourceEventIds).map(stringValue)),
    } : null,
  };
}

function personSnapshot(person, atMonth) {
  const body = asObject(person.body) ?? {};
  return {
    personId: person.id,
    name: person.name ?? null,
    generation: integerValue(person.generation) ?? 0,
    sex: person.sex ?? null,
    ageMonths: integerValue(atMonth) !== null && integerValue(person.bornAtMonth) !== null
      ? atMonth - person.bornAtMonth
      : null,
    bodyMinimum: [body.health, body.hydration, body.nutrition].every((value) => typeof value === 'number')
      ? Math.min(body.health, body.hydration, body.nutrition)
      : null,
  };
}

function currentlyAlive(person) {
  return integerValue(person.diedAtMonth) === null;
}

function directOrSharedParent(first, second) {
  const firstParents = unique(asArray(first.geneticParents).map(stringValue));
  const secondParents = unique(asArray(second.geneticParents).map(stringValue));
  return firstParents.includes(second.id)
    || secondParents.includes(first.id)
    || firstParents.some((parentId) => secondParents.includes(parentId));
}

function reproductiveBodyEligible(person) {
  const body = asObject(person.body) ?? {};
  return Math.min(body.health ?? -Infinity, body.hydration ?? -Infinity, body.nutrition ?? -Infinity) >= 55
    && !asArray(person.conditions).some((condition) => condition.kind === 'pregnancy' || condition.kind === 'postpartum-recovery');
}

function relationshipFrontier(state, personById) {
  const atMonth = integerValue(state.clock?.elapsedMonths) ?? 0;
  const livingAdults = [...personById.values()].filter((person) => currentlyAlive(person)
    && atMonth - (integerValue(person.bornAtMonth) ?? atMonth) >= 16 * 12);
  const generationOneAdults = livingAdults.filter((person) => (integerValue(person.generation) ?? 0) === 1);
  const adultFrontier = generationOneAdults.map((person) => {
    const candidates = livingAdults
      .filter((other) => other.id !== person.id)
      .map((other) => ({ other, relationship: bilateralRelationship(person, other) }))
      .filter((entry) => entry.relationship.minimumTrustBond !== null)
      .sort((left, right) => right.relationship.minimumTrustBond - left.relationship.minimumTrustBond
        || String(left.other.id).localeCompare(String(right.other.id)));
    const best = candidates[0] ?? null;
    return {
      person: personSnapshot(person, atMonth),
      bestCurrentAdultRelationship: best ? {
        candidate: personSnapshot(best.other, atMonth),
        ...best.relationship,
      } : null,
    };
  });
  const fertileGenerationOneFemales = generationOneAdults.filter((person) => person.sex === 'female'
    && atMonth - (integerValue(person.bornAtMonth) ?? atMonth) <= 45 * 12);
  const fertileFemaleCandidates = fertileGenerationOneFemales.map((female) => {
    const candidates = livingAdults
      .filter((male) => male.sex === 'male' && !directOrSharedParent(female, male))
      .map((male) => ({ male, relationship: bilateralRelationship(female, male) }))
      .filter((entry) => entry.relationship.minimumTrustBond !== null)
      .sort((left, right) => right.relationship.minimumTrustBond - left.relationship.minimumTrustBond
        || String(left.male.id).localeCompare(String(right.male.id)));
    const best = candidates[0] ?? null;
    return {
      female: {
        ...personSnapshot(female, atMonth),
        bodyEligible: reproductiveBodyEligible(female),
      },
      bestUnrelatedCandidate: best ? {
        male: {
          ...personSnapshot(best.male, atMonth),
          bodyEligible: reproductiveBodyEligible(best.male),
        },
        ...best.relationship,
        reachesCompanionThreshold20: best.relationship.minimumTrustBond >= 20,
        hasProposerRelationshipSource: (best.relationship.firstToSecond?.sourceEventIds.length ?? 0) > 0,
        relationshipAtFormerThreshold60: best.relationship.minimumTrustBond >= 60,
      } : null,
    };
  });
  const highestBilateralMinimum = adultFrontier.reduce((maximum, entry) => Math.max(
    maximum,
    entry.bestCurrentAdultRelationship?.minimumTrustBond ?? Number.NEGATIVE_INFINITY,
  ), Number.NEGATIVE_INFINITY);
  return {
    atMonth,
    livingGenerationOneAdults: generationOneAdults.length,
    highestBilateralMinimum: highestBilateralMinimum === Number.NEGATIVE_INFINITY ? null : highestBilateralMinimum,
    adultFrontier,
    fertileGenerationOneFemales: fertileFemaleCandidates.length,
    fertileFemaleCandidates,
  };
}

function auditRun(persisted, requestedCheckpoints = []) {
  const { state, meta } = persisted;
  const people = asArray(state.people);
  const personById = new Map(people.flatMap((person) => stringValue(person.id) ? [[person.id, person]] : []));
  const events = [...asArray(state.world?.past)].sort(eventOrder);
  const eventById = new Map(events.flatMap((event) => stringValue(event.id) ? [[event.id, event]] : []));
  const agreements = asArray(state.agreements);
  const agreementById = new Map(agreements.flatMap((agreement) => stringValue(agreement.id) ? [[agreement.id, agreement]] : []));
  const agreementFacts = Map.groupBy(events.filter((event) => event.kind === 'agreement' && stringValue(event.agreementId)), (event) => event.agreementId);
  const birthsByChild = Map.groupBy(events.filter((event) => event.kind === 'environment'
    && stringValue(asObject(event.diff)?.bornPersonId)), (event) => asObject(event.diff).bornPersonId);
  const conceptions = events.filter((event) => {
    const action = asObject(event.action);
    return event.kind === 'action'
      && event.status === 'completed'
      && action?.kind === 'act'
      && action.operation === 'reproduce'
      && asObject(event.diff)?.conceived === true;
  });
  const companyByPair = Map.groupBy(agreements.filter((agreement) => agreement.proposal?.kind === 'assist'
    && agreement.proposal.need === 'company'), (agreement) => pairKey(asArray(agreement.partyIds)));
  const companionByPair = Map.groupBy(agreements.filter((agreement) => agreement.proposal?.kind === 'companion'), (agreement) => pairKey(asArray(agreement.partyIds)));
  const persistentLivingByPair = Map.groupBy(events.filter((event) => event.kind === 'environment'
    && event.change === 'relationship'
    && asObject(event.diff)?.process === 'persistent-shared-living'), (event) => pairKey(asArray(asObject(event.diff)?.participantIds)));

  const targetPeople = people
    .filter((person) => (integerValue(person.generation) ?? 0) >= 2)
    .sort((left, right) => (integerValue(left.bornAtMonth) ?? 0) - (integerValue(right.bornAtMonth) ?? 0)
      || String(left.id).localeCompare(String(right.id)));
  const chains = targetPeople.map((child) => {
    const missingLinks = [];
    const parentIds = unique(asArray(child.geneticParents).map(stringValue));
    if (parentIds.length !== 2 || parentIds.some((parentId) => !personById.has(parentId))) missingLinks.push('valid-two-parent-state-missing');

    const birthCandidates = birthsByChild.get(child.id) ?? [];
    const birth = birthCandidates.find((event) => event.atMonth === child.bornAtMonth) ?? birthCandidates[0] ?? null;
    if (!birth) missingLinks.push('birth-fact-missing');
    const birthParents = unique(asArray(asObject(birth?.diff)?.parents).map(stringValue));
    if (birth && (!samePair(parentIds, birthParents) || birth.atMonth !== child.bornAtMonth)) missingLinks.push('birth-fact-state-mismatch');

    const pairedConceptions = conceptions.filter((event) => samePair(conceptionParentIds(event), parentIds)
      && (integerValue(event.atMonth) ?? Number.POSITIVE_INFINITY) <= (integerValue(child.bornAtMonth) ?? Number.NEGATIVE_INFINITY));
    const exactConceptions = pairedConceptions.filter((event) => integerValue(asObject(event.diff)?.dueAtMonth) === integerValue(birth?.atMonth));
    const conception = [...(exactConceptions.length ? exactConceptions : pairedConceptions)].sort(eventOrder).at(-1) ?? null;
    const conceptionMatch = exactConceptions.includes(conception) ? 'parents-and-due-month' : conception ? 'parents-only-fallback' : 'none';
    if (!conception) missingLinks.push('conceived-reproduce-action-missing');
    if (conception && conceptionMatch !== 'parents-and-due-month') missingLinks.push('conception-due-month-mismatch');

    const action = asObject(conception?.action);
    const authorizationRef = stringValue(action?.authorizationRef);
    const linkedByFulfillment = conception
      ? agreements.find((agreement) => asArray(agreement.fulfillmentEventIds).includes(conception.id))
      : null;
    const reproductionAgreement = agreementById.get(authorizationRef) ?? linkedByFulfillment ?? null;
    if (conception && !authorizationRef) missingLinks.push('reproduction-authorization-ref-missing');
    if (conception && !reproductionAgreement) missingLinks.push('reproduction-agreement-missing');
    if (reproductionAgreement && reproductionAgreement.proposal?.kind !== 'reproduce') missingLinks.push('reproduction-agreement-kind-mismatch');
    if (reproductionAgreement && !samePair(asArray(reproductionAgreement.partyIds), parentIds)) missingLinks.push('reproduction-agreement-party-mismatch');
    const proposalEvent = reproductionAgreement ? eventById.get(reproductionAgreement.proposalEventId) : null;
    const acceptanceEvent = reproductionAgreement?.responseEventId ? eventById.get(reproductionAgreement.responseEventId) : null;
    if (reproductionAgreement && !proposalEvent) missingLinks.push('reproduction-proposal-event-missing');
    if (reproductionAgreement && !acceptanceEvent) missingLinks.push('reproduction-acceptance-event-missing');
    if (reproductionAgreement && conception && !asArray(reproductionAgreement.fulfillmentEventIds).includes(conception.id)) {
      missingLinks.push('reproduction-fulfillment-link-missing');
    }
    if (reproductionAgreement && conception
      && ((integerValue(reproductionAgreement.acceptedAtMonth) ?? Number.POSITIVE_INFINITY) > conception.atMonth)) {
      missingLinks.push('reproduction-acceptance-after-conception');
    }
    const reproductionSourceResolution = reproductionAgreement
      ? resolvedSources(asArray(reproductionAgreement.sourceEventIds), eventById)
      : { sourceEventIds: [], missingSourceEventIds: [] };
    if (reproductionSourceResolution.missingSourceEventIds.length) missingLinks.push('reproduction-source-event-missing');
    const relationshipBasis = reproductionAgreement?.proposal?.basis?.version === 'relationship-causal-basis-v1'
      ? reproductionAgreement.proposal.basis
      : null;
    if (reproductionAgreement && !relationshipBasis) missingLinks.push('reproduction-relationship-basis-missing');

    const conceptionMonth = integerValue(conception?.atMonth) ?? Number.NEGATIVE_INFINITY;
    const parentPair = pairKey(parentIds);
    const companyFulfillments = (companyByPair.get(parentPair) ?? []).flatMap((agreement) => {
      const fulfillmentEvents = asArray(agreement.fulfillmentEventIds)
        .map((eventId) => eventById.get(eventId))
        .filter((event) => event && event.atMonth <= conceptionMonth);
      return fulfillmentEvents.map((fulfillment) => ({
        agreement: agreementRef(agreement, eventById, agreementFacts),
        fulfillment: eventRef(fulfillment),
      }));
    }).sort((left, right) => eventOrder(eventById.get(left.fulfillment.eventId), eventById.get(right.fulfillment.eventId)));
    const companionEstablishments = (companionByPair.get(parentPair) ?? []).flatMap((agreement) => {
      const lifecycle = (agreementFacts.get(agreement.id) ?? []).find((event) => event.change === 'fulfilled');
      const establishmentMonth = integerValue(agreement.companionEstablishedAtMonth)
        ?? integerValue(lifecycle?.atMonth)
        ?? (agreement.status === 'fulfilled' ? integerValue(agreement.resolvedAtMonth) : null);
      if (establishmentMonth === null || establishmentMonth > conceptionMonth) return [];
      return [{
        agreement: agreementRef(agreement, eventById, agreementFacts),
        establishmentMonth,
        establishmentFact: eventRef(lifecycle),
      }];
    }).sort((left, right) => left.establishmentMonth - right.establishmentMonth);
    const persistentSharedLiving = (persistentLivingByPair.get(parentPair) ?? [])
      .filter((event) => event.atMonth <= conceptionMonth)
      .map(eventRef);

    if (!companyFulfillments.length) missingLinks.push('company-fulfillment-before-conception-missing');
    if (!companionEstablishments.length) missingLinks.push('companion-establishment-before-conception-missing');
    if (!persistentSharedLiving.length) missingLinks.push('persistent-shared-living-before-conception-missing');
    const orderedTriple = companionEstablishments.flatMap((companion) => {
      const company = [...companyFulfillments]
        .reverse()
        .find((entry) => entry.fulfillment.atMonth <= companion.establishmentMonth);
      const persistent = persistentSharedLiving.find((event) => event.atMonth >= companion.establishmentMonth);
      return company && persistent ? [{ company, companion, persistent }] : [];
    })[0] ?? null;
    if (companyFulfillments.length && companionEstablishments.length && !orderedTriple) {
      missingLinks.push('company-companion-order-missing');
    }
    if (companionEstablishments.length && persistentSharedLiving.length && !orderedTriple) {
      missingLinks.push('companion-persistent-living-order-missing');
    }
    const basisEventIds = new Set(unique([
      ...asArray(relationshipBasis?.relationshipKeys).map(stringValue),
      ...asArray(relationshipBasis?.sourceFactIds).map(stringValue),
    ]));
    const socialEventIds = unique([
      ...companyFulfillments.map((entry) => entry.fulfillment.eventId),
      ...companionEstablishments.map((entry) => entry.establishmentFact?.eventId),
      ...persistentSharedLiving.map((event) => event.eventId),
    ]);
    const basisLinkedSocialEventIds = socialEventIds.filter((eventId) => basisEventIds.has(eventId));
    if (relationshipBasis && socialEventIds.length && !basisLinkedSocialEventIds.length) {
      missingLinks.push('social-evidence-not-linked-by-reproduction-basis');
    }
    const socialMissingSources = unique([
      ...companyFulfillments.flatMap((entry) => entry.agreement.missingSourceEventIds),
      ...companionEstablishments.flatMap((entry) => entry.agreement.missingSourceEventIds),
      ...persistentSharedLiving.flatMap((event) => event.sourceEventIds.filter((eventId) => !eventById.has(eventId))),
    ]);
    if (socialMissingSources.length) missingLinks.push('social-source-event-missing');

    const coreMissingLinks = missingLinks.filter((link) => ![
      'company-fulfillment-before-conception-missing',
      'companion-establishment-before-conception-missing',
      'persistent-shared-living-before-conception-missing',
      'company-companion-order-missing',
      'companion-persistent-living-order-missing',
      'social-evidence-not-linked-by-reproduction-basis',
      'social-source-event-missing',
    ].includes(link));
    return {
      child: {
        personId: child.id,
        name: child.name ?? null,
        generation: integerValue(child.generation),
        bornAtMonth: integerValue(child.bornAtMonth),
        diedAtMonth: integerValue(child.diedAtMonth),
        geneticParents: parentIds,
      },
      parents: parentIds.map((personId) => {
        const person = personById.get(personId);
        return {
          personId,
          name: person?.name ?? null,
          generation: integerValue(person?.generation),
          bornAtMonth: integerValue(person?.bornAtMonth),
          diedAtMonth: integerValue(person?.diedAtMonth),
        };
      }),
      birthFact: eventRef(birth),
      conception: {
        match: conceptionMatch,
        fact: eventRef(conception),
        parentIds: conception ? conceptionParentIds(conception) : [],
      },
      reproductionAgreement: reproductionAgreement ? {
        ...agreementRef(reproductionAgreement, eventById, agreementFacts),
        relationshipBasis: relationshipBasis ? {
          basisKey: relationshipBasis.basisKey,
          subjectKey: relationshipBasis.subjectKey,
          proposerId: relationshipBasis.proposerId,
          partnerId: relationshipBasis.partnerId,
          relationshipKeys: unique(asArray(relationshipBasis.relationshipKeys).map(stringValue)),
          bodyKeys: unique(asArray(relationshipBasis.bodyKeys).map(stringValue)),
          sourceFactIds: unique(asArray(relationshipBasis.sourceFactIds).map(stringValue)),
        } : null,
      } : null,
      socialContinuity: {
        companyFulfillments,
        companionEstablishments,
        persistentSharedLiving,
        orderedHypothesisChain: orderedTriple ? {
          companyFulfillmentEventId: orderedTriple.company.fulfillment.eventId,
          companionEstablishmentEventId: orderedTriple.companion.establishmentFact?.eventId ?? null,
          persistentSharedLivingEventId: orderedTriple.persistent.eventId,
        } : null,
        basisLinkedSocialEventIds,
        missingSourceEventIds: socialMissingSources,
      },
      coreReproductionChainComplete: coreMissingLinks.length === 0,
      hypothesisSocialChainComplete: missingLinks.length === 0,
      missingLinks: unique(missingLinks),
    };
  });

  const maxGeneration = people.reduce((maximum, person) => Math.max(maximum, integerValue(person.generation) ?? 0), 0);
  const elapsedMonths = integerValue(state.clock?.elapsedMonths) ?? 0;
  const reachedCheckpoints = requestedCheckpoints.filter((month) => month <= elapsedMonths);
  return {
    runId: meta.id,
    seed: integerValue(state.seed),
    status: meta.status ?? state.civilization?.status ?? null,
    elapsedMonths,
    people: people.length,
    peopleByGeneration: countByGeneration(people),
    maxGeneration,
    targetPeople: chains.length,
    coreCompleteChains: chains.filter((chain) => chain.coreReproductionChainComplete).length,
    hypothesisCompleteChains: chains.filter((chain) => chain.hypothesisSocialChainComplete).length,
    support: maxGeneration < 2
      ? 'no-generation-2'
      : chains.every((chain) => chain.hypothesisSocialChainComplete)
        ? 'supported'
        : chains.every((chain) => chain.coreReproductionChainComplete)
          ? 'core-supported-social-partial'
          : 'partial',
    socialFunnel: socialFunnel(state, events, personById, agreementFacts),
    relationshipFrontier: relationshipFrontier(state, personById),
    birthOrderSliceAudit: birthOrderSliceAudit(state, events, personById, elapsedMonths),
    checkpointAudits: {
      requested: requestedCheckpoints,
      reached: reachedCheckpoints,
      unreached: requestedCheckpoints.filter((month) => month > elapsedMonths),
      stages: reachedCheckpoints.map((month) => ({
        atMonth: month,
        socialFunnel: socialFunnelAtMonth(state, events, personById, agreementFacts, month),
        birthOrderSliceAudit: birthOrderSliceAudit(state, events, personById, month),
      })),
    },
    missingLinkCounts: missingCounts(chains),
    chains,
  };
}

function aggregate(runs) {
  const missing = new Map();
  for (const [link, count] of runs.flatMap((run) => Object.entries(run.missingLinkCounts))) {
    missing.set(link, (missing.get(link) ?? 0) + count);
  }
  return {
    runs: runs.length,
    runsWithGeneration2: runs.filter((run) => run.maxGeneration >= 2).length,
    runsWithGeneration3: runs.filter((run) => run.maxGeneration >= 3).length,
    maxGeneration: runs.reduce((maximum, run) => Math.max(maximum, run.maxGeneration), 0),
    targetPeople: runs.reduce((sum, run) => sum + run.targetPeople, 0),
    coreCompleteChains: runs.reduce((sum, run) => sum + run.coreCompleteChains, 0),
    hypothesisCompleteChains: runs.reduce((sum, run) => sum + run.hypothesisCompleteChains, 0),
    missingLinkCounts: Object.fromEntries([...missing.entries()].sort(([left], [right]) => left.localeCompare(right))),
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
      schemaVersion: 2,
      auditVersion: AUDIT_VERSION,
      generatedAt: new Date().toISOString(),
      source: {
        authority: 'SQLite terminal SimulationState loaded read-only through sqlite-run-reader.mjs; no run is advanced or mutated.',
        dataDirectory: reader.store.dataDirectory(),
        databaseFile: reader.store.filePath(),
        selector: args.prefix ? { prefix: args.prefix } : { runIds },
      },
      method: {
        target: 'Every person with generation >= 2.',
        coreChain: 'person state parents -> exact birth fact -> conceived reproduce ActionFact -> authorized reproduce agreement -> proposal/acceptance/fulfillment source integrity',
        socialChain: 'company assist fulfillment -> companion establishment -> persistent shared-living fact -> reproduction relationship basis',
        sliceBias: 'At observed proposal ActionFacts, reconstruct co-location and preserve SimulationState.people insertion order to audit the localPeople first-three cap; generation-one insertion order is checked against birth order.',
        missingEvidencePolicy: 'Missing or unresolved source facts are reported explicitly and never inferred from generation or observer milestones.',
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
