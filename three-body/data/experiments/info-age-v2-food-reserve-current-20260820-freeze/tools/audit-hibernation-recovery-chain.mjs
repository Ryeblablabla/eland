import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { openSqliteRunReader } from './sqlite-run-reader.mjs';

const OBSERVER_VERSION = 'hibernation-recovery-chain-audit-v5';
const SAFE_EXIT_MINIMUM_RESERVE = 45;
const SEVERE_HEAT_STAGE = 2;
const ASSISTED_REHYDRATION_AMOUNT = 18;
const METRIC_NAMES = [
  'relevantRecoveryEpisodes',
  'unsupportedAutomaticWakeups',
  'unsafeHibernationExits',
  'unbackedReserveIncreases',
  'incompleteRecoveryRepeatHeatExposures',
  'postWakeSevereHeatDeaths',
  'continuedEpisodeResets',
  'hibernationCostViolations',
  'recoverySocialPreemptions',
  'hibernationProjectStallsOrBlocks',
  'hibernationDeathTerminalizedProjects',
  'hibernationMarkerOrphans',
  'hibernationMarkerMismatches',
  'preRecoveryOrdinaryActions',
  'instantRecoveryIntentChildren',
  'duplicateDehydrateActions',
  'duplicateHibernationSurvivalChildren',
  'stableEpochDehydrateReplays',
  'caregiverAssistedRecoveryViolations',
  'agreementResponseDeadlineViolations',
  'postRecoveryRequiredResponseViolations',
  'strongUnselectedDehydrateCandidateRate',
];

const asArray = (value) => Array.isArray(value) ? value : [];
const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const stringValue = (value) => typeof value === 'string' && value.length > 0 ? value : null;
const finiteValue = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const integerValue = (value) => Number.isInteger(value) ? value : null;
const booleanValue = (value) => typeof value === 'boolean' ? value : null;
const unique = (values) => [...new Set(values.filter((value) => value !== null && value !== undefined))].sort();

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

function firstValue(objects, keys) {
  for (const object of objects) {
    if (!object) continue;
    for (const key of keys) {
      if (Object.hasOwn(object, key) && object[key] !== undefined && object[key] !== null) return object[key];
    }
  }
  return null;
}

function eventPayloads(event) {
  const diff = asObject(event.diff) ?? {};
  return [
    asObject(diff.hibernationRecoveryAudit),
    asObject(diff.hibernationRecovery),
    asObject(diff.recoveryAudit),
    asObject(diff.recovery),
    diff,
  ].filter(Boolean);
}

function normalizedPhase(value) {
  const phase = stringValue(value)?.toLowerCase();
  if (!phase) return null;
  if (['dormant', 'hibernating', 'dehydrated', 'sleeping'].includes(phase)) return 'dormant';
  if (['recovering', 'rehydrating', 'waking'].includes(phase)) return 'recovering';
  if (['exited', 'awake', 'completed', 'none'].includes(phase)) return 'exited';
  return phase;
}

function phaseTransition(event) {
  const payloads = eventPayloads(event);
  const transition = asObject(firstValue(payloads, ['phaseTransition', 'hibernationPhaseTransition']));
  const before = normalizedPhase(firstValue(
    transition ? [transition, ...payloads] : payloads,
    ['from', 'before', 'phaseFrom', 'fromPhase', 'phaseBefore', 'previousPhase', 'hibernationPhaseBefore', 'previousHibernationPhase'],
  ));
  const after = normalizedPhase(firstValue(
    transition ? [transition, ...payloads] : payloads,
    ['to', 'after', 'phaseTo', 'toPhase', 'phaseAfter', 'nextPhase', 'hibernationPhaseAfter', 'hibernationPhase', 'recoveryPhase', 'phase'],
  ));
  return { before, after };
}

function bodySnapshot(event, side) {
  const payloads = eventPayloads(event);
  const before = side === 'before';
  const objectKeys = before
    ? ['bodyBefore', 'beforeBody', 'preBody', 'reserveBefore', 'reservesBefore']
    : ['bodyAfter', 'afterBody', 'postBody', 'reserveAfter', 'reservesAfter'];
  const body = asObject(firstValue(payloads, objectKeys));
  const directKeys = (field) => before
    ? [`${field}Before`, `before${field[0].toUpperCase()}${field.slice(1)}`]
    : [`${field}After`, `after${field[0].toUpperCase()}${field.slice(1)}`];
  const snapshotKeys = (field) => body
    ? [field]
    : [...directKeys(field), ...(before ? [] : [field])];
  const health = finiteValue(firstValue(body ? [body, ...payloads] : payloads, snapshotKeys('health')));
  const hydration = finiteValue(firstValue(body ? [body, ...payloads] : payloads, snapshotKeys('hydration')));
  const nutrition = finiteValue(firstValue(body ? [body, ...payloads] : payloads, snapshotKeys('nutrition')));
  let minimumReserve = finiteValue(firstValue(payloads, before
    ? ['minimumReserveBefore', 'minReserveBefore', 'beforeMinimumReserve']
    : ['minimumReserveAfter', 'minReserveAfter', 'afterMinimumReserve', 'minimumReserve']));
  if (minimumReserve === null && health !== null && hydration !== null && nutrition !== null) {
    minimumReserve = Math.min(health, hydration, nutrition);
  }
  return {
    health,
    hydration,
    nutrition,
    minimumReserve,
    complete: health !== null && hydration !== null && nutrition !== null,
  };
}

function reserveDeltas(event) {
  const payloads = eventPayloads(event);
  const before = bodySnapshot(event, 'before');
  const after = bodySnapshot(event, 'after');
  const physicalRecoveryEffect = booleanValue(firstValue(payloads, [
    'hibernationRecoverySource', 'physicalRecoverySource', 'physicalRecoveryApplied',
  ])) === true;
  const delta = (field) => {
    const direct = finiteValue(firstValue(payloads, [
      `${field}Delta`, `recovery${field[0].toUpperCase()}${field.slice(1)}Delta`,
    ]));
    if (direct !== null) return direct;
    if (physicalRecoveryEffect) {
      const effect = finiteValue(firstValue(payloads, [field]));
      if (effect !== null) return effect;
    }
    return before[field] !== null && after[field] !== null ? after[field] - before[field] : null;
  };
  return { health: delta('health'), hydration: delta('hydration'), nutrition: delta('nutrition'), before, after };
}

function sourceIdsFor(event, includeGeneric = true) {
  const payloads = eventPayloads(event);
  const fields = [
    'recoverySourceEventIds', 'recoveryEvidenceEventIds', 'physicalRecoveryEventIds',
    'reserveSourceEventIds', 'rehydrationSourceEventIds', 'nutritionSourceEventIds',
    'waterSourceEventIds', 'foodSourceEventIds',
  ];
  if (includeGeneric) fields.push('sourceEventIds');
  return unique(payloads.flatMap((payload) => fields.flatMap((field) => asArray(payload[field]).filter(stringValue))));
}

function operationFor(event) {
  const action = asObject(event.action);
  return action?.kind === 'act' ? stringValue(action.operation) : null;
}

function eventPersonId(event, role = 'affected') {
  const payloads = eventPayloads(event);
  const roleKeys = role === 'entry'
    ? ['dehydratedPersonId', 'hibernatingPersonId', 'sleeperId', 'personId']
    : role === 'exit'
      ? ['rehydratedPersonId', 'recoveredPersonId', 'sleeperId', 'personId']
      : ['personId', 'affectedPersonId', 'sleeperId', 'dehydratedPersonId', 'rehydratedPersonId'];
  return stringValue(firstValue(payloads, roleKeys)) ?? stringValue(event.who);
}

function episodeIdFor(event) {
  return stringValue(firstValue(eventPayloads(event), [
    'hibernationEpisodeId', 'recoveryEpisodeId', 'hibernationConditionId', 'episodeId', 'conditionId',
  ]));
}

function hibernationConditionIdFor(event) {
  const payloads = eventPayloads(event);
  const explicit = stringValue(firstValue(payloads, [
    'hibernationConditionId', 'hibernationEpisodeId', 'recoveryEpisodeId',
  ]));
  if (explicit) return explicit;
  const condition = stringValue(firstValue(payloads, ['condition', 'conditionKind']));
  if (condition !== 'dehydrated-hibernation') return null;
  return stringValue(firstValue(payloads, ['conditionId', 'episodeId']));
}

function stringListValue(value) {
  return unique([
    ...asArray(value).map(stringValue),
    ...(stringValue(value) ? [stringValue(value)] : []),
  ]);
}

function hibernationIntentFields(event) {
  const payloads = eventPayloads(event);
  const suspendedIntentId = stringValue(firstValue(payloads, ['suspendedIntentId']));
  const suspendedIntentChainIds = unique(payloads.flatMap((payload) => stringListValue(payload.suspendedIntentChainIds)));
  const restoredIntentId = stringValue(firstValue(payloads, ['restoredIntentId']));
  const failedIntentIds = unique(payloads.flatMap((payload) => stringListValue(payload.hibernationFailedIntentIds)));
  return {
    suspendedIntentId,
    suspendedIntentChainIds,
    restoredIntentId,
    failedIntentIds,
    allReferencedIntentIds: unique([
      suspendedIntentId,
      ...suspendedIntentChainIds,
      restoredIntentId,
      ...failedIntentIds,
    ]),
  };
}

function hasHibernationContinuityContract(event) {
  const payloads = eventPayloads(event);
  const fields = hibernationIntentFields(event);
  const condition = stringValue(firstValue(payloads, ['condition', 'conditionKind']));
  const hasExplicitPhase = payloads.some((payload) => [
    'hibernationPhase', 'hibernationPhaseBefore', 'hibernationPhaseAfter',
  ].some((key) => Object.hasOwn(payload, key)));
  const hasScopedPhaseTransition = condition === 'dehydrated-hibernation'
    && payloads.some((payload) => ['phaseFrom', 'phaseTo'].some((key) => Object.hasOwn(payload, key)));
  return fields.allReferencedIntentIds.length > 0
    || booleanValue(firstValue(payloads, ['hibernationIntentSuspended'])) !== null
    || booleanValue(firstValue(payloads, ['hibernationMonthlySettlement'])) === true
    || hasExplicitPhase
    || hasScopedPhaseTransition;
}

function recoveryCompleteFor(event) {
  return booleanValue(firstValue(eventPayloads(event), [
    'recoveryComplete', 'recoveryCompleted', 'safeRecoveryComplete', 'minimumReserveRestored',
  ]));
}

function classifyHibernationSignal(item) {
  const { event } = item;
  const payloads = eventPayloads(event);
  const diff = asObject(event.diff) ?? {};
  const operation = operationFor(event);
  const phase = phaseTransition(event);
  const condition = stringValue(firstValue(payloads, ['condition', 'conditionKind']));
  const hasCandidateHibernationContract = Boolean(
    asObject(diff.hibernationRecoveryAudit)
      || asObject(diff.hibernationRecovery)
      || ['hibernationPhase', 'hibernationPhaseBefore', 'hibernationPhaseAfter',
        'hibernationEpisodeId', 'hibernationConditionId', 'hibernationEntered',
        'hibernationExited', 'automaticWake'].some((key) => Object.hasOwn(diff, key)),
  );
  const hibernationScoped = condition === 'dehydrated-hibernation'
    || operation === 'dehydrate'
    || operation === 'rehydrate'
    || hasCandidateHibernationContract;
  if (!hibernationScoped) return null;
  const completedAction = event.kind === 'action' && event.status === 'completed';
  const entered = booleanValue(firstValue(payloads, ['entered', 'hibernationEntered'])) === true;
  const exitedFlag = booleanValue(firstValue(payloads, ['exited', 'hibernationExited']));
  const exited = exitedFlag === true;
  const isEntry = (completedAction && operation === 'dehydrate' && entered)
    || (entered && phase.after === 'dormant');
  const explicitRehydrate = completedAction && operation === 'rehydrate'
    && exitedFlag !== false
    && Boolean(stringValue(diff.rehydratedPersonId) ?? stringValue(firstValue(payloads, ['recoveredPersonId'])));
  const fullExit = exited || explicitRehydrate || phase.after === 'exited';
  const explicitlyStartedRecovery = booleanValue(firstValue(payloads, ['recoveryStarted', 'enteredRecovery'])) === true;
  const rehydrateToRecovery = completedAction && operation === 'rehydrate'
    && exitedFlag === false
    && phase.after === 'recovering';
  const recoveryStart = (phase.after === 'recovering' && phase.before !== null)
    || explicitlyStartedRecovery
    || rehydrateToRecovery;
  const resumedDormant = phase.before === 'recovering' && phase.after === 'dormant';
  if (!isEntry && !fullExit && !recoveryStart && !resumedDormant) return null;
  const automatic = fullExit && ((event.kind === 'environment'
    && phase.before !== 'recovering')
    || booleanValue(firstValue(payloads, ['automaticWake', 'automaticExit'])) === true
    || ['automatic', 'ambient'].includes(stringValue(firstValue(payloads, ['wakeMode', 'exitMode', 'source']))));
  const personId = eventPersonId(event, isEntry ? 'entry' : fullExit || recoveryStart ? 'exit' : 'affected');
  if (!personId) return null;
  return {
    item,
    personId,
    condition,
    isEntry,
    fullExit,
    recoveryStart,
    resumedDormant,
    automatic,
    explicitRehydrate,
    phaseBefore: phase.before,
    phaseAfter: phase.after,
    episodeId: episodeIdFor(event),
    recoveryComplete: recoveryCompleteFor(event),
    bodyBefore: bodySnapshot(event, 'before'),
    bodyAfter: bodySnapshot(event, 'after'),
    recoverySourceEventIds: sourceIdsFor(event),
    waterNearby: booleanValue(firstValue(payloads, ['waterNearby'])),
    helperNearby: booleanValue(firstValue(payloads, ['helperNearby'])),
    ambientRecovery: booleanValue(firstValue(payloads, ['ambientRecovery'])),
    wakeSource: stringValue(firstValue(payloads, ['wakeSource', 'recoverySource', 'source', 'exitBasis', 'rehydrationBasis'])),
  };
}

function evidenceRef(item, extra = {}) {
  const { event } = item;
  return {
    eventId: stringValue(event.id) ?? `#${item.index}`,
    atMonth: integerValue(event.atMonth),
    personId: eventPersonId(event),
    kind: stringValue(event.kind),
    change: stringValue(event.change),
    status: stringValue(event.status),
    operation: operationFor(event),
    ...extra,
  };
}

function isPhysicalRecoveryAction(event, affectedPersonId) {
  if (event.kind !== 'action' || event.status !== 'completed') return false;
  const operation = operationFor(event);
  if (operation === 'rehydrate') return eventPersonId(event, 'exit') === affectedPersonId;
  if (operation === 'ingest') return stringValue(event.who) === affectedPersonId;
  const payloads = eventPayloads(event);
  return (booleanValue(firstValue(payloads, ['physicalRecoverySource', 'physicalRecoveryApplied'])) === true
    || booleanValue(firstValue(payloads, ['hibernationRecoverySource'])) === true)
    && (eventPersonId(event) === affectedPersonId || stringValue(event.who) === affectedPersonId);
}

function validatedPhysicalSources(sourceIds, affectedPersonId, eventById) {
  const resolved = [];
  const invalid = [];
  for (const sourceId of sourceIds) {
    const source = eventById.get(sourceId)?.event;
    if (source && isPhysicalRecoveryAction(source, affectedPersonId)) resolved.push(sourceId);
    else invalid.push(sourceId);
  }
  return { resolved: unique(resolved), invalid: unique(invalid) };
}

function heatStageFor(event) {
  const payloads = eventPayloads(event);
  const condition = stringValue(firstValue(payloads, ['condition', 'conditionKind']));
  if (event.kind !== 'environment' || event.change !== 'condition' || condition !== 'heat') return null;
  return finiteValue(firstValue(payloads, ['stage', 'conditionStage', 'heatStage']));
}

function thermalDeathEvidence(item, eventById) {
  const { event } = item;
  if (event.kind !== 'environment' || event.change !== 'death') return null;
  const personId = eventPersonId(event);
  if (!personId) return null;
  const payloads = eventPayloads(event);
  const cause = stringValue(firstValue(payloads, ['cause']));
  const sourceEventIds = sourceIdsFor(event);
  const resolvedSources = sourceEventIds.flatMap((sourceEventId) => {
    const source = eventById.get(sourceEventId);
    return source ? [{ sourceEventId, source, heatStage: heatStageFor(source.event) }] : [];
  });
  const severeHeatSources = resolvedSources.filter((source) => (source.heatStage ?? -Infinity) >= SEVERE_HEAT_STAGE
    && eventPersonId(source.source.event) === personId);
  const unresolvedSourceEventIds = sourceEventIds.filter((sourceEventId) => !eventById.has(sourceEventId));
  const classificationSupported = severeHeatSources.length > 0
    || (sourceEventIds.length > 0 && unresolvedSourceEventIds.length === 0);
  return {
    item,
    personId,
    cause,
    sourceEventIds,
    severeHeatSourceEventIds: severeHeatSources.map((source) => source.sourceEventId),
    unresolvedSourceEventIds,
    severeHeat: severeHeatSources.length > 0,
    classificationSupported,
  };
}

function buildEpisodes(signals) {
  const episodes = [];
  const openByPerson = new Map();
  const lastRecoveryByPerson = new Map();
  const reentries = [];
  let serial = 0;

  const createEpisode = (signal, inferred) => {
    const id = signal.episodeId ?? `audit-episode:${signal.personId}:${++serial}`;
    const episode = {
      auditEpisodeId: id,
      recordedEpisodeId: signal.episodeId,
      personId: signal.personId,
      inferredStart: inferred,
      entry: inferred ? null : signal,
      firstSignal: signal,
      transitions: [],
      recoverySignals: [],
      resumedDormantSignals: [],
      phase: signal.phaseAfter ?? (signal.isEntry ? 'dormant' : null),
      closed: false,
      nextEntry: null,
    };
    episodes.push(episode);
    return episode;
  };

  for (const signal of signals) {
    let episode = openByPerson.get(signal.personId);
    if (signal.isEntry) {
      if (episode && !episode.closed) {
        episode.transitions.push(signal);
        reentries.push({ previousEpisode: episode, signal, whileOpen: true });
        if (signal.episodeId && !episode.recordedEpisodeId) episode.recordedEpisodeId = signal.episodeId;
      } else {
        const previous = lastRecoveryByPerson.get(signal.personId) ?? null;
        episode = createEpisode(signal, false);
        openByPerson.set(signal.personId, episode);
        if (previous) {
          previous.nextEntry = signal;
          reentries.push({ previousEpisode: previous, signal, whileOpen: false });
        }
      }
    }
    if (!signal.recoveryStart && !signal.fullExit && !signal.resumedDormant) continue;
    if (!episode || episode.closed) {
      episode = createEpisode(signal, true);
      openByPerson.set(signal.personId, episode);
    }
    if (signal.episodeId && !episode.recordedEpisodeId) episode.recordedEpisodeId = signal.episodeId;
    episode.transitions.push(signal);
    if (signal.recoveryStart || signal.fullExit) {
      episode.recoverySignals.push(signal);
      lastRecoveryByPerson.set(signal.personId, episode);
    }
    if (signal.resumedDormant) {
      episode.resumedDormantSignals.push(signal);
      episode.phase = 'dormant';
    }
    if (signal.recoveryStart) episode.phase = 'recovering';
    if (signal.fullExit) {
      episode.phase = 'exited';
      episode.closed = true;
      openByPerson.delete(signal.personId);
    }
  }
  return { episodes, reentries };
}

function metricResult(value, supportedObservations, unsupportedObservations, options = {}) {
  const supported = Math.max(0, supportedObservations);
  const unsupported = Math.max(0, unsupportedObservations);
  const status = unsupported > 0
    ? supported > 0 ? 'partial' : 'unsupported'
    : 'supported';
  return {
    status,
    value: status === 'unsupported' ? null : value,
    knownValue: value,
    supportedObservations: supported,
    unsupportedObservations: unsupported,
    reasonCodes: unique(options.reasonCodes ?? []),
    evidenceEventIds: unique(options.evidenceEventIds ?? []),
    ...(options.denominator !== undefined ? { denominator: options.denominator } : {}),
    ...(options.categories ? { categories: options.categories } : {}),
    ...(options.note ? { note: options.note } : {}),
  };
}

function explicitlyUnsupportedMetric(reasonCode, note) {
  return {
    status: 'unsupported',
    value: null,
    knownValue: null,
    supportedObservations: 0,
    unsupportedObservations: 1,
    reasonCodes: [reasonCode],
    evidenceEventIds: [],
    denominator: null,
    note,
  };
}

function strictMetricResult(value, supportedObservations, unsupportedObservations, options = {}) {
  const denominator = finiteValue(options.denominator);
  const classifiedObservations = Math.max(0, supportedObservations) + Math.max(0, unsupportedObservations);
  const unclassifiedObservations = denominator === null
    ? 0
    : Math.max(0, denominator - classifiedObservations);
  const noEligibleObservations = denominator !== null
    ? denominator === 0
    : classifiedObservations === 0;
  const reasonCodes = [
    ...(options.reasonCodes ?? []),
    ...(unclassifiedObservations > 0 ? ['eligible-observations-missing-classification'] : []),
    ...(noEligibleObservations ? [options.emptyReasonCode ?? 'no-eligible-observations'] : []),
  ];
  const result = metricResult(
    value,
    supportedObservations,
    Math.max(0, unsupportedObservations) + unclassifiedObservations,
    { ...options, reasonCodes },
  );
  result.coverage = denominator !== null && denominator > 0
    ? Math.round(result.supportedObservations / denominator * 10_000) / 10_000
    : null;
  if (noEligibleObservations) {
    result.status = 'unsupported';
    result.value = null;
  }
  if (result.status === 'unsupported') result.knownValue = null;
  return result;
}

function runMetricCoverageSelfCheck() {
  const emptyCaregiver = strictMetricResult(0, 0, 0, {
    denominator: 0,
    emptyReasonCode: 'no-caregiver-assisted-recovery-observations',
  });
  const fullyKnownStableEpoch = strictMetricResult(0, 2, 0, { denominator: 2 });
  const partialStableEpoch = strictMetricResult(1, 1, 1, { denominator: 2 });
  const unknownPostRecovery = strictMetricResult(0, 0, 2, { denominator: 2 });
  const emptyPostRecovery = strictMetricResult(0, 0, 0, {
    denominator: 0,
    emptyReasonCode: 'no-closed-response-deadline-suspension-windows',
  });
  const checks = [
    [emptyCaregiver.status === 'unsupported'
      && emptyCaregiver.value === null
      && emptyCaregiver.knownValue === null
      && emptyCaregiver.coverage === null
      && emptyCaregiver.reasonCodes.includes('no-caregiver-assisted-recovery-observations'),
    'zero-denominator caregiver metric must be unsupported'],
    [fullyKnownStableEpoch.status === 'supported'
      && fullyKnownStableEpoch.value === 0
      && fullyKnownStableEpoch.coverage === 1,
    'fully covered zero-violation metric must remain supported'],
    [partialStableEpoch.status === 'partial'
      && partialStableEpoch.value === 1
      && partialStableEpoch.coverage === 0.5,
    'mixed known and unknown observations must be partial'],
    [unknownPostRecovery.status === 'unsupported'
      && unknownPostRecovery.value === null
      && unknownPostRecovery.knownValue === null
      && unknownPostRecovery.coverage === 0,
    'all-unknown observations must be unsupported'],
    [emptyPostRecovery.status === 'unsupported'
      && emptyPostRecovery.unsupportedObservations === 0
      && emptyPostRecovery.coverage === null
      && emptyPostRecovery.reasonCodes.includes('no-closed-response-deadline-suspension-windows'),
    'empty post-recovery window set must be unsupported without inventing an unknown observation'],
  ];
  for (const [passed, message] of checks) {
    if (!passed) throw new Error(`metric coverage self-check failed: ${message}`);
  }
}

function completedAct(item, operation) {
  return item.event.kind === 'action'
    && item.event.status === 'completed'
    && operationFor(item.event) === operation;
}

function dehydrateAffectedPersonId(event) {
  if (operationFor(event) !== 'dehydrate') return null;
  return stringValue(asObject(event.diff)?.dehydratedPersonId)
    ?? eventPersonId(event, 'entry');
}

function dehydrateIntentTargetsOwner(intent) {
  const action = asObject(intent?.nextAction);
  if (action?.kind !== 'act' || action.operation !== 'dehydrate') return false;
  return asArray(action.targets).some((target) => asObject(target)?.kind === 'person'
    && stringValue(asObject(target)?.personId) === stringValue(intent.ownerId));
}

function communicationResponseReference(event) {
  if (event.kind !== 'action' || event.status !== 'completed') return null;
  const action = asObject(event.action);
  if (action?.kind !== 'communicate') return null;
  const content = asObject(action.content);
  if (!['accept', 'reject'].includes(stringValue(content?.kind))) return null;
  return stringValue(content?.referenceId);
}

function agreementRecordsResponse(agreement, responseEvent) {
  const action = asObject(responseEvent?.action);
  const content = asObject(action?.content);
  const responderId = stringValue(responseEvent?.who);
  const responseEventId = stringValue(responseEvent?.id);
  if (!responderId || !responseEventId || !asArray(agreement?.sourceEventIds).includes(responseEventId)) return false;
  if (content?.kind === 'accept') return asArray(agreement?.acceptedByPersonIds).includes(responderId);
  if (content?.kind === 'reject') return asArray(agreement?.rejectedByPersonIds).includes(responderId);
  return false;
}

function suspensionEventForFact(eventById, fact) {
  const event = eventById.get(stringValue(fact?.eventId))?.event;
  return event?.kind === 'agreement' ? event : null;
}

function recoveryState(signal) {
  const minimumReserve = signal.bodyAfter.minimumReserve;
  if (signal.recoveryStart && !signal.fullExit) return { status: 'incomplete', minimumReserve };
  if (signal.recoveryComplete === false || (minimumReserve !== null && minimumReserve < SAFE_EXIT_MINIMUM_RESERVE)) {
    return { status: 'incomplete', minimumReserve };
  }
  if (minimumReserve !== null && minimumReserve >= SAFE_EXIT_MINIMUM_RESERVE) {
    return { status: 'safe', minimumReserve };
  }
  return { status: 'unsupported', minimumReserve: null };
}

function firstRecoverySignal(episode) {
  return [...episode.recoverySignals].sort((left, right) => eventOrder(left.item, right.item))[0] ?? null;
}

function firstEventAfter(items, target) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (eventOrder(items[middle], target) <= 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstEventAtOrAfter(items, target) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (eventOrder(items[middle], target) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function eventsBetween(items, afterItem, beforeItem) {
  const start = firstEventAfter(items, afterItem);
  const end = beforeItem ? firstEventAtOrAfter(items, beforeItem) : items.length;
  return items.slice(start, end);
}

function expectedHibernationSettlementMonths(entryMonth, exitMonth, terminalMonth) {
  const finalIncludedMonth = exitMonth !== null ? exitMonth - 1 : terminalMonth;
  if (finalIncludedMonth === null || finalIncludedMonth < entryMonth) return [];
  return Array.from(
    { length: finalIncludedMonth - entryMonth + 1 },
    (_, offset) => entryMonth + offset,
  );
}

function auditRun(matrixRun, persisted) {
  const state = persisted.state;
  const indexedEvents = asArray(state.world?.past)
    .map((event, index) => ({ event, index }))
    .sort(eventOrder);
  const eventById = new Map(indexedEvents.flatMap((item) => stringValue(item.event.id) ? [[item.event.id, item]] : []));
  const intentById = new Map(asArray(state.intents).flatMap((intent) => stringValue(intent.id) ? [[intent.id, intent]] : []));
  const projectById = new Map(asArray(state.projects).flatMap((project) => stringValue(project.id) ? [[project.id, project]] : []));
  const personById = new Map(asArray(state.people).flatMap((person) => stringValue(person.id) ? [[person.id, person]] : []));
  const eventsByPerson = new Map();
  for (const item of indexedEvents) {
    for (const personId of unique([eventPersonId(item.event), stringValue(item.event.who)])) {
      const matches = eventsByPerson.get(personId) ?? [];
      matches.push(item);
      eventsByPerson.set(personId, matches);
    }
  }
  const signals = indexedEvents.flatMap((item) => classifyHibernationSignal(item) ?? []).sort((left, right) => eventOrder(left.item, right.item));
  const { episodes, reentries } = buildEpisodes(signals);
  const relevantEpisodes = episodes.filter((episode) => episode.recoverySignals.length > 0);
  const automaticWakeups = signals.filter((signal) => signal.fullExit && signal.automatic);
  const thermalDeaths = indexedEvents.flatMap((item) => thermalDeathEvidence(item, eventById) ?? []);
  const severeHeatEventsByPerson = new Map();
  for (const item of indexedEvents) {
    const stage = heatStageFor(item.event);
    const personId = eventPersonId(item.event);
    if (!personId || stage === null || stage < SEVERE_HEAT_STAGE) continue;
    const matches = severeHeatEventsByPerson.get(personId) ?? [];
    matches.push(item);
    severeHeatEventsByPerson.set(personId, matches);
  }

  const automaticCategories = {
    waterNearby: 0,
    waterAndHelperNearby: 0,
    ambientOnly: 0,
    helperWithoutWater: 0,
    noRecordedTrigger: 0,
    triggerFieldsMissing: 0,
  };
  for (const signal of automaticWakeups) {
    if (signal.waterNearby === true) automaticCategories.waterNearby += 1;
    if (signal.waterNearby === true && signal.helperNearby === true) automaticCategories.waterAndHelperNearby += 1;
    if (signal.waterNearby === false && signal.helperNearby === false && signal.ambientRecovery === true) automaticCategories.ambientOnly += 1;
    if (signal.waterNearby === false && signal.helperNearby === true) automaticCategories.helperWithoutWater += 1;
    if (signal.waterNearby === false && signal.helperNearby === false && signal.ambientRecovery === false) automaticCategories.noRecordedTrigger += 1;
    if ([signal.waterNearby, signal.helperNearby, signal.ambientRecovery].some((value) => value === null)) automaticCategories.triggerFieldsMissing += 1;
  }

  const unsafeExitEvidence = [];
  let safeExitObservations = 0;
  let unsupportedExitObservations = 0;
  const fullExitSignals = signals.filter((signal) => signal.fullExit);
  for (const signal of fullExitSignals) {
    const recovery = recoveryState(signal);
    if (recovery.status === 'unsupported') unsupportedExitObservations += 1;
    else {
      safeExitObservations += 1;
      if (recovery.status === 'incomplete') unsafeExitEvidence.push(evidenceRef(signal.item, {
        minimumReserveAfter: recovery.minimumReserve,
        episodeId: signal.episodeId,
      }));
    }
  }

  const unbackedEvidence = [];
  let backedRecoveryObservations = 0;
  let unsupportedRecoverySourceObservations = 0;
  for (const episode of relevantEpisodes) {
    let episodeSupported = false;
    let episodeUnsupported = false;
    const recoveryStart = firstRecoverySignal(episode);
    const fullExit = episode.recoverySignals.find((signal) => signal.fullExit);
    const supplementalItems = recoveryStart
      ? eventsBetween(eventsByPerson.get(episode.personId) ?? [], recoveryStart.item, fullExit?.item ?? episode.nextEntry?.item ?? null)
        .filter((item) => {
          const payloads = eventPayloads(item.event);
          return booleanValue(firstValue(payloads, ['hibernationRecoverySource'])) === true
            || (booleanValue(firstValue(payloads, ['hibernationMonthlySettlement'])) === true
              && normalizedPhase(firstValue(payloads, ['hibernationPhase'])) === 'recovering');
        })
      : [];
    const observations = [
      ...episode.recoverySignals.map((signal) => ({
        item: signal.item,
        fullExit: signal.fullExit,
        phaseBefore: signal.phaseBefore,
        bodyAfter: signal.bodyAfter,
        recoverySourceEventIds: signal.recoverySourceEventIds,
      })),
      ...supplementalItems.map((item) => ({
        item,
        fullExit: false,
        phaseBefore: phaseTransition(item.event).before,
        bodyAfter: bodySnapshot(item.event, 'after'),
        recoverySourceEventIds: sourceIdsFor(item.event),
      })),
    ].filter((observation, index, all) => all.findIndex((candidate) => candidate.item.index === observation.item.index) === index);
    for (const observation of observations) {
      const deltas = reserveDeltas(observation.item.event);
      const explicitReserveIncrease = finiteValue(firstValue(eventPayloads(observation.item.event), ['reserveIncrease']));
      const positiveFields = [
        ...['hydration', 'nutrition'].filter((field) => (deltas[field] ?? 0) > 0),
        ...(explicitReserveIncrease !== null && explicitReserveIncrease > 0 ? ['reserve'] : []),
      ];
      const physical = validatedPhysicalSources(observation.recoverySourceEventIds, episode.personId, eventById);
      const sameEventPhysical = isPhysicalRecoveryAction(observation.item.event, episode.personId);
      const candidateSafeExit = observation.fullExit
        && observation.phaseBefore === 'recovering'
        && observation.bodyAfter.minimumReserve !== null;
      const hasReserveEvidence = ['health', 'hydration', 'nutrition'].some((field) => deltas[field] !== null)
        || explicitReserveIncrease !== null
        || sameEventPhysical
        || candidateSafeExit;
      if (!hasReserveEvidence) {
        episodeUnsupported = true;
        continue;
      }
      episodeSupported = true;
      const cumulativeRecoveryWithoutSource = candidateSafeExit && physical.resolved.length === 0;
      if ((positiveFields.length || cumulativeRecoveryWithoutSource)
        && !sameEventPhysical
        && physical.resolved.length === 0) {
        unbackedEvidence.push(evidenceRef(observation.item, {
          episodeId: episode.auditEpisodeId,
          positiveReserveFields: positiveFields.length ? positiveFields : ['cumulative-recovery'],
          declaredSourceEventIds: observation.recoverySourceEventIds,
          invalidSourceEventIds: physical.invalid,
        }));
      }
    }
    if (episodeSupported) backedRecoveryObservations += 1;
    if (episodeUnsupported || !episodeSupported) unsupportedRecoverySourceObservations += 1;
  }

  const repeatHeatEvidence = [];
  let repeatHeatSupportedEpisodes = 0;
  let repeatHeatUnsupportedEpisodes = 0;
  for (const episode of relevantEpisodes) {
    const recoverySignal = firstRecoverySignal(episode);
    if (!recoverySignal) continue;
    const stateAtRecovery = recoveryState(recoverySignal);
    if (stateAtRecovery.status === 'unsupported') {
      repeatHeatUnsupportedEpisodes += 1;
      continue;
    }
    repeatHeatSupportedEpisodes += 1;
    if (stateAtRecovery.status !== 'incomplete') continue;
    const safeExit = episode.recoverySignals.find((signal) => signal.fullExit
      && eventOrder(signal.item, recoverySignal.item) > 0);
    const boundary = safeExit?.item ?? episode.nextEntry?.item ?? null;
    const heat = (severeHeatEventsByPerson.get(episode.personId) ?? [])
      .find((item) => eventOrder(item, recoverySignal.item) > 0 && (!boundary || eventOrder(item, boundary) < 0));
    if (heat) repeatHeatEvidence.push({
      personId: episode.personId,
      episodeId: episode.auditEpisodeId,
      recoveryEventId: stringValue(recoverySignal.item.event.id),
      recoveryAtMonth: integerValue(recoverySignal.item.event.atMonth),
      minimumReserveAfter: stateAtRecovery.minimumReserve,
      heatEventId: stringValue(heat.event.id),
      heatAtMonth: integerValue(heat.event.atMonth),
      heatStage: heatStageFor(heat.event),
    });
  }

  const postWakeDeathEvidence = [];
  let postWakeDeathSupportedEpisodes = 0;
  let postWakeDeathUnsupportedEpisodes = 0;
  for (const episode of relevantEpisodes) {
    const recoverySignal = firstRecoverySignal(episode);
    if (!recoverySignal) continue;
    const boundary = episode.nextEntry?.item ?? null;
    const death = thermalDeaths.find((candidate) => candidate.personId === episode.personId
      && eventOrder(candidate.item, recoverySignal.item) > 0
      && (!boundary || eventOrder(candidate.item, boundary) < 0));
    if (!death) {
      postWakeDeathSupportedEpisodes += 1;
      continue;
    }
    if (!death.classificationSupported) {
      postWakeDeathUnsupportedEpisodes += 1;
      continue;
    }
    postWakeDeathSupportedEpisodes += 1;
    if (death.severeHeat) postWakeDeathEvidence.push({
      personId: episode.personId,
      episodeId: episode.auditEpisodeId,
      recoveryEventId: stringValue(recoverySignal.item.event.id),
      recoveryAtMonth: integerValue(recoverySignal.item.event.atMonth),
      deathEventId: stringValue(death.item.event.id),
      deathAtMonth: integerValue(death.item.event.atMonth),
      severeHeatSourceEventIds: death.severeHeatSourceEventIds,
    });
  }

  const resetEvidence = [];
  let resetSupportedEpisodes = 0;
  let resetUnsupportedEpisodes = 0;
  for (const episode of relevantEpisodes) {
    const recoverySignal = firstRecoverySignal(episode);
    if (!recoverySignal) continue;
    const stateAtRecovery = recoveryState(recoverySignal);
    const episodeReentries = reentries.filter((entry) => entry.previousEpisode === episode);
    const resumed = episode.resumedDormantSignals;
    if (stateAtRecovery.status === 'safe' && !resumed.length) {
      resetSupportedEpisodes += 1;
      continue;
    }
    if (stateAtRecovery.status === 'unsupported') {
      resetUnsupportedEpisodes += 1;
      continue;
    }
    const candidates = [
      ...episodeReentries.map((entry) => ({ signal: entry.signal, via: 'dehydrate-entry' })),
      ...resumed.map((signal) => ({ signal, via: 'recovering-to-dormant' })),
    ];
    if (!candidates.length) {
      resetSupportedEpisodes += 1;
      continue;
    }
    for (const candidate of candidates) {
      const safeFullExitBeforeEntry = candidate.via === 'dehydrate-entry'
        && episode.recoverySignals.some((signal) => signal.fullExit
          && recoveryState(signal).status === 'safe'
          && eventOrder(signal.item, candidate.signal.item) < 0);
      if (safeFullExitBeforeEntry) {
        resetSupportedEpisodes += 1;
        continue;
      }
      const priorId = recoverySignal.episodeId ?? episode.recordedEpisodeId;
      const nextId = candidate.signal.episodeId;
      const sameRecordedEpisode = priorId && nextId && priorId === nextId;
      const explicitContinuation = booleanValue(firstValue(eventPayloads(candidate.signal.item.event), [
        'continuedEpisode', 'sameEpisode', 'preservedEpisode',
      ]));
      const entryCostApplied = booleanValue(firstValue(eventPayloads(candidate.signal.item.event), [
        'entryCostApplied', 'hibernationEntryCostApplied',
      ]));
      const entryHydrationCost = finiteValue(firstValue(eventPayloads(candidate.signal.item.event), [
        'entryHydrationCost', 'hibernationEntryHydrationCost',
      ]));
      const violation = candidate.via === 'dehydrate-entry'
        || explicitContinuation === false
        || (priorId && nextId && priorId !== nextId)
        || entryCostApplied === true
        || (entryHydrationCost !== null && entryHydrationCost > 0);
      const provableContinuation = (sameRecordedEpisode || explicitContinuation === true)
        && entryCostApplied !== true
        && (entryHydrationCost === null || entryHydrationCost === 0);
      if (violation) resetEvidence.push(evidenceRef(candidate.signal.item, {
        episodeIdBefore: priorId,
        episodeIdAfter: nextId,
        via: candidate.via,
        entryCostApplied,
        entryHydrationCost,
      }));
      if (violation || provableContinuation) resetSupportedEpisodes += 1;
      else resetUnsupportedEpisodes += 1;
    }
  }

  const costEvidence = [];
  let costSupportedPersonMonths = 0;
  let costUnsupportedPersonMonths = 0;
  let expectedCostPersonMonths = 0;
  let unknownCostCoverageEpisodes = 0;
  for (const episode of relevantEpisodes) {
    const start = episode.entry?.item ?? episode.firstSignal.item;
    const fullExit = episode.recoverySignals.find((signal) => signal.fullExit);
    const end = fullExit?.item ?? episode.nextEntry?.item ?? null;
    const observations = eventsBetween(eventsByPerson.get(episode.personId) ?? [], start, end)
      .flatMap((item) => {
        const payloads = eventPayloads(item.event);
        const applied = booleanValue(firstValue(payloads, [
          'monthlyCostApplied', 'hibernationCostApplied', 'metabolicCostApplied',
        ]));
        const phase = phaseTransition(item.event).after
          ?? normalizedPhase(firstValue(payloads, ['hibernationPhase', 'recoveryPhase', 'phase']));
        const deltas = reserveDeltas(item.event);
        const hydrationCost = finiteValue(firstValue(payloads, ['hydrationCost']));
        const nutritionCost = finiteValue(firstValue(payloads, ['nutritionCost']));
        const healthDelta = finiteValue(firstValue(payloads, ['healthDelta']));
        const explicitCostFact = applied !== null
          || booleanValue(firstValue(payloads, ['hibernationMonthlySettlement', 'hibernationCostObservation'])) === true;
        if (!explicitCostFact || !['dormant', 'recovering'].includes(phase)) return [];
        const complete = applied !== null
          && hydrationCost !== null
          && nutritionCost !== null
          && healthDelta !== null
          && deltas.before.complete
          && deltas.after.complete;
        return [{ item, applied, phase, deltas, hydrationCost, nutritionCost, healthDelta, complete }];
      });
    const entryMonth = integerValue(episode.entry?.item.event.atMonth);
    const exitMonth = integerValue(fullExit?.item.event.atMonth);
    const terminalMonth = integerValue(personById.get(episode.personId)?.diedAtMonth)
      ?? integerValue(state.clock?.elapsedMonths);
    if (entryMonth === null || (exitMonth === null && terminalMonth === null)) {
      unknownCostCoverageEpisodes += 1;
      costUnsupportedPersonMonths += 1;
      continue;
    }
    const expectedMonths = new Set(expectedHibernationSettlementMonths(entryMonth, exitMonth, terminalMonth));
    expectedCostPersonMonths += expectedMonths.size;
    const completeMonths = new Set(observations
      .filter((observation) => observation.complete)
      .map((observation) => integerValue(observation.item.event.atMonth))
      .filter((month) => month !== null && expectedMonths.has(month)));
    costSupportedPersonMonths += completeMonths.size;
    costUnsupportedPersonMonths += Math.max(0, expectedMonths.size - completeMonths.size);
    for (const observation of observations) {
      if (!observation.complete) continue;
      const reserveIncreaseDuringSettlement = observation.deltas.hydration > 0 || observation.deltas.nutrition > 0;
      const dormantWithoutHealthCost = observation.phase === 'dormant' && observation.healthDelta >= 0;
      const violation = observation.applied !== true
        || observation.hydrationCost <= 0
        || observation.nutritionCost <= 0
        || reserveIncreaseDuringSettlement
        || dormantWithoutHealthCost;
      if (violation) costEvidence.push(evidenceRef(observation.item, {
        episodeId: episode.auditEpisodeId,
        phase: observation.phase,
        monthlyCostApplied: observation.applied,
        hydrationCost: observation.hydrationCost,
        nutritionCost: observation.nutritionCost,
        healthDelta: observation.healthDelta,
        deltas: {
          health: observation.deltas.health,
          hydration: observation.deltas.hydration,
          nutrition: observation.deltas.nutrition,
        },
      }));
    }
  }

  const socialPreemptionEvidence = [];
  let socialSupportedWindows = 0;
  let socialUnsupportedEpisodes = 0;
  for (const episode of relevantEpisodes) {
    let recoveryStarts = episode.recoverySignals.filter((signal) => signal.recoveryStart
      && !signal.fullExit
      && (signal.phaseBefore === 'dormant'
        || booleanValue(firstValue(eventPayloads(signal.item.event), ['recoveryStarted', 'enteredRecovery'])) === true));
    if (!recoveryStarts.length) {
      const fallback = episode.recoverySignals.find((signal) => signal.recoveryStart && !signal.fullExit);
      if (fallback
        && fallback.phaseAfter === 'recovering'
        && (fallback.phaseBefore !== null || operationFor(fallback.item.event) === 'rehydrate')) recoveryStarts = [fallback];
    }
    if (!recoveryStarts.length) {
      socialUnsupportedEpisodes += 1;
      continue;
    }
    for (const recoveryStart of recoveryStarts) {
      const recoveryEnd = episode.transitions.find((signal) => eventOrder(signal.item, recoveryStart.item) > 0
        && (signal.fullExit || signal.resumedDormant));
      const actions = eventsBetween(eventsByPerson.get(episode.personId) ?? [], recoveryStart.item, recoveryEnd?.item ?? episode.nextEntry?.item ?? null)
        .filter((item) => item.event.kind === 'action' && item.event.status === 'completed');
      socialSupportedWindows += 1;
      for (const action of actions) {
        const primitiveAction = asObject(action.event.action);
        if (primitiveAction?.kind !== 'communicate') continue;
        const intent = intentById.get(stringValue(action.event.intentId));
        const interruptionKind = stringValue(action.event.interruptionKind)
          ?? stringValue(asObject(action.event.diff)?.interruptionKind)
          ?? stringValue(intent?.interruptionKind);
        const content = asObject(primitiveAction.content);
        socialPreemptionEvidence.push(evidenceRef(action, {
          episodeId: episode.auditEpisodeId,
          recoveryStartedEventId: stringValue(recoveryStart.item.event.id),
          intentId: stringValue(action.event.intentId),
          interruptionKind,
          contentKind: stringValue(content?.kind),
          requiredResponse: interruptionKind === 'required-response',
        }));
      }
    }
  }

  const currentHibernationConditionById = new Map();
  for (const person of asArray(state.people)) {
    for (const condition of asArray(person.conditions)) {
      if (condition?.kind !== 'dehydrated-hibernation' || !stringValue(condition.id)) continue;
      currentHibernationConditionById.set(condition.id, { condition, personId: person.id });
    }
  }
  const deathItemsByPerson = new Map();
  for (const item of indexedEvents) {
    if (item.event.kind !== 'environment' || item.event.change !== 'death') continue;
    const personId = eventPersonId(item.event);
    if (!personId) continue;
    const matches = deathItemsByPerson.get(personId) ?? [];
    matches.push(item);
    deathItemsByPerson.set(personId, matches);
  }

  const continuityEpisodes = episodes.map((episode) => {
    const personEvents = eventsByPerson.get(episode.personId) ?? [];
    const start = episode.entry?.item ?? episode.firstSignal.item;
    const nextEntryItem = episode.nextEntry?.item ?? null;
    const fullExitItem = episode.recoverySignals
      .filter((signal) => signal.fullExit && eventOrder(signal.item, start) >= 0)
      .sort((left, right) => eventOrder(left.item, right.item))[0]?.item ?? null;
    const deathItem = (deathItemsByPerson.get(episode.personId) ?? [])
      .find((item) => eventOrder(item, start) > 0
        && (!nextEntryItem || eventOrder(item, nextEntryItem) < 0)) ?? null;
    const boundary = [
      ...(fullExitItem ? [{ kind: 'safe-exit', item: fullExitItem }] : []),
      ...(deathItem ? [{ kind: 'death', item: deathItem }] : []),
      ...(nextEntryItem ? [{ kind: 'next-entry', item: nextEntryItem }] : []),
    ].sort((left, right) => eventOrder(left.item, right.item))[0] ?? null;
    const strictlyInsideItems = eventsBetween(personEvents, start, boundary?.item ?? null);
    const inclusiveAuditItems = [
      start,
      ...strictlyInsideItems,
      ...(['safe-exit', 'death'].includes(boundary?.kind) ? [boundary.item] : []),
    ].filter((item, index, all) => all.findIndex((candidate) => candidate.index === item.index) === index)
      .sort(eventOrder);
    const terminalConditions = !boundary || boundary.kind === 'death'
      ? [...currentHibernationConditionById.values()].filter((record) => record.personId === episode.personId)
      : [];
    const conditionIds = unique([
      episode.recordedEpisodeId,
      ...episode.transitions.map((signal) => signal.episodeId),
      ...inclusiveAuditItems.map((item) => hibernationConditionIdFor(item.event)),
      ...terminalConditions.map((record) => stringValue(record.condition.id)),
    ]);
    const canonicalConditionId = conditionIds.length === 1 ? conditionIds[0] : null;
    const markerFacts = inclusiveAuditItems.flatMap((item) => {
      const fields = hibernationIntentFields(item.event);
      return fields.allReferencedIntentIds.length || booleanValue(firstValue(eventPayloads(item.event), ['hibernationIntentSuspended'])) !== null
        ? [{ item, conditionId: hibernationConditionIdFor(item.event), ...fields }]
        : [];
    });
    const terminalMarkerIntents = asArray(state.intents).filter((intent) => {
      const conditionId = stringValue(intent.suspendedForHibernationConditionId);
      return conditionId && conditionIds.includes(conditionId);
    });
    const contractSupported = inclusiveAuditItems.some((item) => hasHibernationContinuityContract(item.event))
      || terminalConditions.some((record) => Object.hasOwn(record.condition, 'hibernationPhase'))
      || terminalMarkerIntents.length > 0;
    return {
      episode,
      start,
      boundary,
      strictlyInsideItems,
      inclusiveAuditItems,
      conditionIds,
      canonicalConditionId,
      markerFacts,
      terminalMarkerIntents,
      contractSupported,
      markerAuditSupported: contractSupported && conditionIds.length > 0,
      longitudinalAuditSupported: contractSupported && conditionIds.length === 1 && !episode.inferredStart,
    };
  });
  const continuityByConditionId = new Map();
  for (const auditEpisode of continuityEpisodes) {
    for (const conditionId of auditEpisode.conditionIds) {
      const matching = continuityByConditionId.get(conditionId) ?? [];
      matching.push(auditEpisode);
      continuityByConditionId.set(conditionId, matching);
    }
  }

  const markerOrphanEvidenceByKey = new Map();
  const markerMismatchEvidenceByKey = new Map();
  const recordMarkerIssue = (target, keyParts, evidence) => {
    const key = keyParts.map((part) => part ?? 'unknown').join('|');
    if (!target.has(key)) target.set(key, evidence);
  };
  for (const auditEpisode of continuityEpisodes) {
    if (!auditEpisode.markerAuditSupported) continue;
    const { episode } = auditEpisode;
    if (auditEpisode.conditionIds.length > 1) {
      recordMarkerIssue(markerMismatchEvidenceByKey, [episode.auditEpisodeId, 'multiple-condition-ids'], {
        personId: episode.personId,
        episodeId: episode.auditEpisodeId,
        reason: 'episode-has-multiple-hibernation-condition-ids',
        conditionIds: auditEpisode.conditionIds,
      });
    }
    const suspendedIds = unique(auditEpisode.markerFacts.flatMap((fact) => [
      fact.suspendedIntentId,
      ...fact.suspendedIntentChainIds,
    ]));
    for (const fact of auditEpisode.markerFacts) {
      if (fact.suspendedIntentId
        && fact.suspendedIntentChainIds.length
        && !fact.suspendedIntentChainIds.includes(fact.suspendedIntentId)) {
        recordMarkerIssue(markerMismatchEvidenceByKey, [episode.auditEpisodeId, 'chain-missing-leaf', fact.suspendedIntentId], evidenceRef(fact.item, {
          episodeId: episode.auditEpisodeId,
          conditionId: fact.conditionId,
          intentId: fact.suspendedIntentId,
          reason: 'suspended-intent-not-present-in-suspended-chain',
          suspendedIntentChainIds: fact.suspendedIntentChainIds,
        }));
      }
      if (fact.restoredIntentId && suspendedIds.length && !suspendedIds.includes(fact.restoredIntentId)) {
        recordMarkerIssue(markerMismatchEvidenceByKey, [episode.auditEpisodeId, 'restored-not-suspended', fact.restoredIntentId], evidenceRef(fact.item, {
          episodeId: episode.auditEpisodeId,
          conditionId: fact.conditionId,
          intentId: fact.restoredIntentId,
          reason: 'restored-intent-not-in-observed-suspended-chain',
          observedSuspendedIntentIds: suspendedIds,
        }));
      }
      for (const intentId of fact.allReferencedIntentIds) {
        const intent = intentById.get(intentId);
        if (!intent) {
          recordMarkerIssue(markerOrphanEvidenceByKey, [episode.auditEpisodeId, 'missing-intent', intentId], evidenceRef(fact.item, {
            episodeId: episode.auditEpisodeId,
            conditionId: fact.conditionId,
            intentId,
            reason: 'hibernation-marker-references-missing-intent',
          }));
          continue;
        }
        if (stringValue(intent.ownerId) !== episode.personId) {
          recordMarkerIssue(markerMismatchEvidenceByKey, [episode.auditEpisodeId, 'wrong-owner', intentId], evidenceRef(fact.item, {
            episodeId: episode.auditEpisodeId,
            conditionId: fact.conditionId,
            intentId,
            intentOwnerId: stringValue(intent.ownerId),
            reason: 'hibernation-marker-intent-owner-mismatch',
          }));
        }
      }
    }
  }

  let standaloneMarkerObservations = 0;
  for (const intent of asArray(state.intents)) {
    const conditionId = stringValue(intent.suspendedForHibernationConditionId);
    if (!conditionId) continue;
    const conditionRecord = currentHibernationConditionById.get(conditionId);
    const matchingEpisodes = continuityByConditionId.get(conditionId) ?? [];
    const episodeId = matchingEpisodes[0]?.episode.auditEpisodeId ?? null;
    if (!matchingEpisodes.length) standaloneMarkerObservations += 1;
    if (!conditionRecord) {
      recordMarkerIssue(markerOrphanEvidenceByKey, [episodeId, 'missing-condition', intent.id, conditionId], {
        eventId: null,
        atMonth: integerValue(state.clock?.elapsedMonths),
        personId: stringValue(intent.ownerId),
        episodeId,
        conditionId,
        intentId: stringValue(intent.id),
        reason: 'intent-hibernation-marker-references-missing-current-condition',
      });
    } else {
      if (stringValue(intent.ownerId) !== conditionRecord.personId) {
        recordMarkerIssue(markerMismatchEvidenceByKey, [episodeId, 'condition-owner', intent.id, conditionId], {
          eventId: null,
          atMonth: integerValue(state.clock?.elapsedMonths),
          personId: conditionRecord.personId,
          episodeId,
          conditionId,
          intentId: stringValue(intent.id),
          intentOwnerId: stringValue(intent.ownerId),
          reason: 'intent-marker-and-hibernation-condition-owner-mismatch',
        });
      }
      if (stringValue(intent.status) !== 'suspended') {
        recordMarkerIssue(markerMismatchEvidenceByKey, [episodeId, 'marker-status', intent.id, conditionId], {
          eventId: null,
          atMonth: integerValue(state.clock?.elapsedMonths),
          personId: conditionRecord.personId,
          episodeId,
          conditionId,
          intentId: stringValue(intent.id),
          intentStatus: stringValue(intent.status),
          reason: 'current-hibernation-marker-intent-is-not-suspended',
        });
      }
    }
    for (const [field, referencedId] of [
      ['returnToIntentId', stringValue(intent.returnToIntentId)],
      ['suspendedByIntentId', stringValue(intent.suspendedByIntentId)],
    ]) {
      if (!referencedId || intentById.has(referencedId)) continue;
      recordMarkerIssue(markerOrphanEvidenceByKey, [episodeId, field, intent.id, referencedId], {
        eventId: null,
        atMonth: integerValue(state.clock?.elapsedMonths),
        personId: stringValue(intent.ownerId),
        episodeId,
        conditionId,
        intentId: stringValue(intent.id),
        missingIntentId: referencedId,
        markerField: field,
        reason: 'hibernation-suspended-intent-chain-reference-missing',
      });
    }
  }
  for (const [conditionId, conditionRecord] of currentHibernationConditionById) {
    const matchingEpisodes = continuityByConditionId.get(conditionId) ?? [];
    if (!matchingEpisodes.some((candidate) => candidate.markerAuditSupported)) continue;
    const person = personById.get(conditionRecord.personId);
    const activeIntentId = stringValue(person?.activeIntentId);
    if (!activeIntentId) continue;
    recordMarkerIssue(markerMismatchEvidenceByKey, [matchingEpisodes[0]?.episode.auditEpisodeId, 'active-during-hibernation', activeIntentId], {
      eventId: null,
      atMonth: integerValue(state.clock?.elapsedMonths),
      personId: conditionRecord.personId,
      episodeId: matchingEpisodes[0]?.episode.auditEpisodeId ?? null,
      conditionId,
      intentId: activeIntentId,
      reason: 'person-retains-active-intent-during-hibernation-episode',
    });
  }
  const markerOrphanEvidence = [...markerOrphanEvidenceByKey.values()];
  const markerMismatchEvidence = [...markerMismatchEvidenceByKey.values()];

  const instantRecoveryChildEvidenceByIntent = new Map();
  let instantRecoverySupportedWindows = 0;
  let instantRecoveryUnsupportedWindows = 0;
  let unresolvedRecoveryActionIntentRefs = 0;
  const unresolvedRecoveryWindows = new Set();
  for (const auditEpisode of continuityEpisodes) {
    const recoveryStarts = auditEpisode.episode.recoverySignals
      .filter((signal) => signal.recoveryStart && !signal.fullExit)
      .sort((left, right) => eventOrder(left.item, right.item));
    if (!recoveryStarts.length) {
      if (auditEpisode.episode.recoverySignals.length) instantRecoveryUnsupportedWindows += 1;
      continue;
    }
    for (const recoveryStart of recoveryStarts) {
      const phaseEnd = auditEpisode.episode.transitions.find((signal) => eventOrder(signal.item, recoveryStart.item) > 0
        && (signal.fullExit || signal.resumedDormant));
      const laterBoundary = [
        ...(phaseEnd ? [{ item: phaseEnd.item }] : []),
        ...(auditEpisode.boundary && eventOrder(auditEpisode.boundary.item, recoveryStart.item) > 0
          ? [{ item: auditEpisode.boundary.item }]
          : []),
      ].sort((left, right) => eventOrder(left.item, right.item))[0]?.item ?? null;
      if (!auditEpisode.contractSupported || auditEpisode.conditionIds.length !== 1) {
        instantRecoveryUnsupportedWindows += 1;
        continue;
      }
      instantRecoverySupportedWindows += 1;
      const recoveryWindowKey = `${auditEpisode.episode.auditEpisodeId}|${recoveryStart.item.index}`;
      const recoveryActions = eventsBetween(eventsByPerson.get(auditEpisode.episode.personId) ?? [], recoveryStart.item, laterBoundary)
        .filter((item) => stringValue(item.event.who) === auditEpisode.episode.personId
          && item.event.kind === 'action'
          && stringValue(item.event.cause) === 'survival-reflex');
      for (const action of recoveryActions) {
        const intentId = stringValue(action.event.intentId);
        if (!intentId) continue;
        const intent = intentById.get(intentId);
        if (!intent) {
          unresolvedRecoveryActionIntentRefs += 1;
          unresolvedRecoveryWindows.add(recoveryWindowKey);
          continue;
        }
        const atMonth = integerValue(action.event.atMonth);
        const instantChild = stringValue(action.event.cause) === 'survival-reflex'
          && stringValue(intent.interruptionKind) === 'survival-reflex'
          && stringValue(intent.ownerId) === auditEpisode.episode.personId
          && Boolean(stringValue(intent.returnToIntentId))
          && integerValue(intent.createdAtMonth) === atMonth
          && integerValue(intent.returnResolvedAtMonth) === atMonth;
        if (!instantChild || instantRecoveryChildEvidenceByIntent.has(intentId)) continue;
        instantRecoveryChildEvidenceByIntent.set(intentId, evidenceRef(action, {
          episodeId: auditEpisode.episode.auditEpisodeId,
          conditionId: auditEpisode.canonicalConditionId,
          recoveryStartedEventId: stringValue(recoveryStart.item.event.id),
          intentId,
          returnToIntentId: stringValue(intent.returnToIntentId),
          interruptionKind: stringValue(intent.interruptionKind),
          createdAtMonth: integerValue(intent.createdAtMonth),
          returnResolvedAtMonth: integerValue(intent.returnResolvedAtMonth),
        }));
      }
    }
  }
  const instantRecoveryChildEvidence = [...instantRecoveryChildEvidenceByIntent.values()];
  const instantRecoveryIntentIds = new Set(instantRecoveryChildEvidenceByIntent.keys());
  instantRecoverySupportedWindows = Math.max(0, instantRecoverySupportedWindows - unresolvedRecoveryWindows.size);
  instantRecoveryUnsupportedWindows += unresolvedRecoveryWindows.size;

  const projectBlockEvidenceByKey = new Map();
  const deathTerminalizedProjectEvidenceByKey = new Map();
  const ordinaryActionEvidenceByKey = new Map();
  let continuityLongitudinalSupportedEpisodes = 0;
  let continuityLongitudinalUnsupportedEpisodes = 0;
  for (const auditEpisode of continuityEpisodes) {
    if (!auditEpisode.longitudinalAuditSupported) {
      continuityLongitudinalUnsupportedEpisodes += 1;
      continue;
    }
    continuityLongitudinalSupportedEpisodes += 1;
    const { episode } = auditEpisode;
    const markerIntentIds = unique([
      ...auditEpisode.markerFacts.flatMap((fact) => fact.allReferencedIntentIds),
      ...auditEpisode.terminalMarkerIntents.map((intent) => stringValue(intent.id)),
    ]);
    const projectIds = unique(markerIntentIds.flatMap((intentId) => {
      const intent = intentById.get(intentId);
      return intent && stringValue(intent.ownerId) === episode.personId
        ? [stringValue(intent.projectId)]
        : [];
    }));
    const startMonth = integerValue(auditEpisode.start.event.atMonth);
    const boundaryMonth = integerValue(auditEpisode.boundary?.item.event.atMonth);
    for (const projectId of projectIds) {
      const project = projectById.get(projectId);
      const blockedAtMonth = integerValue(project?.blockedAtMonth);
      if (!project
        || stringValue(project.ownerId) !== episode.personId
        || blockedAtMonth === null
        || startMonth === null) continue;
      const withinStart = blockedAtMonth >= startMonth;
      const withinEnd = auditEpisode.boundary?.kind === 'death'
        ? boundaryMonth !== null && blockedAtMonth <= boundaryMonth
        : boundaryMonth !== null
          ? blockedAtMonth < boundaryMonth
          : blockedAtMonth <= (integerValue(state.clock?.elapsedMonths) ?? blockedAtMonth);
      if (!withinStart || !withinEnd) continue;
      const key = `${episode.auditEpisodeId}|${projectId}`;
      const evidence = {
        eventId: null,
        atMonth: blockedAtMonth,
        personId: episode.personId,
        episodeId: episode.auditEpisodeId,
        conditionId: auditEpisode.canonicalConditionId,
        projectId,
        projectStatus: stringValue(project.status),
        blockedAtMonth,
        blockedReason: stringValue(project.blockedReason),
        markerIntentIds: markerIntentIds.filter((intentId) => intentById.get(intentId)?.projectId === projectId),
        windowStartMonth: startMonth,
        windowEndMonthExclusive: auditEpisode.boundary?.kind === 'death' ? null : boundaryMonth,
        deathMonthInclusive: auditEpisode.boundary?.kind === 'death' ? boundaryMonth : null,
      };
      const terminalizedByOwnerDeath = auditEpisode.boundary?.kind === 'death'
        && boundaryMonth !== null
        && blockedAtMonth === boundaryMonth
        && stringValue(project.blockedReason) === '项目发起者已经无法继续行动';
      const destination = terminalizedByOwnerDeath
        ? deathTerminalizedProjectEvidenceByKey
        : projectBlockEvidenceByKey;
      if (!destination.has(key)) destination.set(key, evidence);
    }

    const completedActions = auditEpisode.strictlyInsideItems
      .filter((item) => item.event.kind === 'action'
        && item.event.status === 'completed'
        && stringValue(item.event.who) === episode.personId);
    for (const action of completedActions) {
      const operation = operationFor(action.event);
      if (operation === 'dehydrate') continue;
      const intentId = stringValue(action.event.intentId);
      if (intentId && instantRecoveryIntentIds.has(intentId)) continue;
      const intent = intentById.get(intentId);
      const primitiveAction = asObject(action.event.action);
      const physicalRecovery = isPhysicalRecoveryAction(action.event, episode.personId);
      const social = primitiveAction?.kind === 'communicate' || stringValue(intent?.domain) === 'social';
      const project = Boolean(stringValue(intent?.projectId));
      const intentLinked = Boolean(intentId);
      if (!intentLinked && !social && !project) continue;
      const eventId = stringValue(action.event.id) ?? `#${action.index}`;
      if (!ordinaryActionEvidenceByKey.has(eventId)) ordinaryActionEvidenceByKey.set(eventId, evidenceRef(action, {
        episodeId: episode.auditEpisodeId,
        conditionId: auditEpisode.canonicalConditionId,
        intentId,
        intentResolved: Boolean(intent),
        intentDomain: stringValue(intent?.domain),
        projectId: stringValue(intent?.projectId),
        interruptionKind: stringValue(intent?.interruptionKind),
        physicalRecovery,
        categories: unique([
          ...(intentLinked ? ['intent'] : []),
          ...(project ? ['project'] : []),
          ...(social ? ['social'] : []),
        ]),
      }));
    }
  }
  const projectBlockEvidence = [...projectBlockEvidenceByKey.values()];
  const deathTerminalizedProjectEvidence = [...deathTerminalizedProjectEvidenceByKey.values()];
  const ordinaryActionEvidence = [...ordinaryActionEvidenceByKey.values()];
  const markerSupportedEpisodes = continuityEpisodes.filter((episode) => episode.markerAuditSupported).length
    + standaloneMarkerObservations;
  const markerIncompleteInferredEpisodes = continuityEpisodes
    .filter((episode) => episode.markerAuditSupported && episode.episode.inferredStart).length;
  const markerUnsupportedEpisodes = continuityEpisodes.filter((episode) => !episode.markerAuditSupported).length
    + markerIncompleteInferredEpisodes;

  const duplicateDehydrateActionEvidence = [];
  const duplicateSurvivalChildEvidence = [];
  let duplicateEntrySupportedEpisodes = 0;
  let duplicateEntryUnsupportedEpisodes = 0;
  for (const auditEpisode of continuityEpisodes) {
    if (!auditEpisode.longitudinalAuditSupported || !auditEpisode.canonicalConditionId) {
      duplicateEntryUnsupportedEpisodes += 1;
      continue;
    }
    duplicateEntrySupportedEpisodes += 1;
    const dehydrateActions = auditEpisode.inclusiveAuditItems
      .filter((item) => completedAct(item, 'dehydrate')
        && dehydrateAffectedPersonId(item.event) === auditEpisode.episode.personId)
      .sort(eventOrder);
    for (const duplicate of dehydrateActions.slice(1)) {
      duplicateDehydrateActionEvidence.push(evidenceRef(duplicate, {
        episodeId: auditEpisode.episode.auditEpisodeId,
        conditionId: auditEpisode.canonicalConditionId,
        firstDehydrateEventId: stringValue(dehydrateActions[0]?.event.id),
        alreadyHibernating: booleanValue(asObject(duplicate.event.diff)?.alreadyHibernating),
        reason: 'completed-dehydrate-repeated-before-episode-exit',
      }));
    }

    const startMonth = integerValue(auditEpisode.start.event.atMonth);
    const boundaryMonth = integerValue(auditEpisode.boundary?.item.event.atMonth);
    if (startMonth === null) {
      duplicateEntrySupportedEpisodes -= 1;
      duplicateEntryUnsupportedEpisodes += 1;
      continue;
    }
    const children = asArray(state.intents).filter((intent) => stringValue(intent.ownerId) === auditEpisode.episode.personId
      && stringValue(intent.interruptionKind) === 'survival-reflex'
      && dehydrateIntentTargetsOwner(intent)
      && integerValue(intent.createdAtMonth) !== null
      && integerValue(intent.createdAtMonth) >= startMonth
      && (boundaryMonth === null || integerValue(intent.createdAtMonth) < boundaryMonth))
      .sort((left, right) => (integerValue(left.createdAtMonth) ?? 0) - (integerValue(right.createdAtMonth) ?? 0)
        || stringValue(left.id)?.localeCompare(stringValue(right.id) ?? '') || 0);
    for (const duplicate of children.slice(1)) {
      duplicateSurvivalChildEvidence.push({
        eventId: stringValue(duplicate.sourceDecisionEventId),
        atMonth: integerValue(duplicate.createdAtMonth),
        personId: auditEpisode.episode.personId,
        episodeId: auditEpisode.episode.auditEpisodeId,
        conditionId: auditEpisode.canonicalConditionId,
        intentId: stringValue(duplicate.id),
        firstIntentId: stringValue(children[0]?.id),
        actionEventIds: stringListValue(duplicate.actionEventIds),
        returnToIntentId: stringValue(duplicate.returnToIntentId),
        reason: 'duplicate-survival-reflex-dehydrate-child-in-one-episode',
      });
    }
  }

  const stableEpochReplayEvidence = [];
  let stableReplaySupportedActions = 0;
  let stableReplayUnsupportedActions = 0;
  for (const item of indexedEvents.filter((candidate) => completedAct(candidate, 'dehydrate'))) {
    const personId = dehydrateAffectedPersonId(item.event);
    if (!personId) {
      stableReplayUnsupportedActions += 1;
      continue;
    }
    const priorExit = [...fullExitSignals]
      .filter((signal) => signal.personId === personId && eventOrder(signal.item, item) < 0)
      .sort((left, right) => eventOrder(right.item, left.item))[0];
    if (!priorExit) continue;
    const priorExitState = recoveryState(priorExit);
    if (priorExitState.status === 'incomplete') continue;
    const epoch = stringValue(asObject(item.event.diff)?.epoch);
    const intentId = stringValue(item.event.intentId);
    const intent = intentId ? intentById.get(intentId) : null;
    const createdAtMonth = integerValue(intent?.createdAtMonth);
    const exitAtMonth = integerValue(priorExit.item.event.atMonth);
    if (priorExitState.status !== 'safe'
      || !['stable', 'chaotic'].includes(epoch)
      || !intent
      || createdAtMonth === null
      || exitAtMonth === null) {
      stableReplayUnsupportedActions += 1;
      continue;
    }
    stableReplaySupportedActions += 1;
    const oldEntryIntent = createdAtMonth <= exitAtMonth;
    if (epoch !== 'stable' || !oldEntryIntent || !dehydrateIntentTargetsOwner(intent)) continue;
    stableEpochReplayEvidence.push(evidenceRef(item, {
      personId,
      priorSafeExitEventId: stringValue(priorExit.item.event.id),
      priorSafeExitAtMonth: exitAtMonth,
      intentId,
      intentCreatedAtMonth: createdAtMonth,
      epoch,
      reason: 'pre-exit-dehydrate-intent-replayed-in-stable-epoch',
    }));
  }

  const assistedRecoveryEvidence = [];
  const unsupportedAssistedRecoveryEvidence = [];
  const assistedRecoveryObservations = [];
  const assistedRecoveryEvents = indexedEvents.filter((item) => completedAct(item, 'rehydrate')
    && stringValue(asObject(item.event.diff)?.assistedDependentId));
  let assistedRecoverySupportedObservations = 0;
  let assistedRecoveryUnsupportedObservations = 0;
  const assistedByPersonMonth = new Map();
  for (const item of assistedRecoveryEvents) {
    const diff = asObject(item.event.diff) ?? {};
    const personId = stringValue(diff.assistedDependentId);
    const helperId = stringValue(diff.assistedByPersonId) ?? stringValue(item.event.who);
    const atMonth = integerValue(item.event.atMonth);
    const conditionId = stringValue(diff.hibernationConditionId);
    const declaredSources = stringListValue(diff.recoverySourceEventIds);
    const explicitAmount = finiteValue(firstValue([diff], [
      'hydrationDelta', 'hydrationGain', 'rehydrationAmount', 'hydrationIncrease',
    ]));
    const key = personId && atMonth !== null ? `${personId}|${atMonth}` : null;
    if (key) {
      const matching = assistedByPersonMonth.get(key) ?? [];
      matching.push(item);
      assistedByPersonMonth.set(key, matching);
    }
    const reasonCodes = [];
    if (!personId || !helperId || atMonth === null || !conditionId) reasonCodes.push('missing-assisted-person-helper-month-or-condition');
    if (booleanValue(diff.hibernationRecoverySource) !== true
      || !stringValue(item.event.id)
      || !declaredSources.includes(stringValue(item.event.id))) reasonCodes.push('assisted-gain-missing-self-bound-source');
    if (normalizedPhase(diff.hibernationPhase) !== 'recovering' || booleanValue(diff.exited) !== false) {
      reasonCodes.push('assisted-gain-not-bound-to-recovering-condition');
    }
    if (explicitAmount === null) {
      assistedRecoveryUnsupportedObservations += 1;
      unsupportedAssistedRecoveryEvidence.push(evidenceRef(item, {
        personId,
        helperId,
        conditionId,
        declaredSourceEventIds: declaredSources,
        reason: 'assisted-rehydrate-diff-missing-explicit-hydration-amount',
      }));
    } else {
      assistedRecoverySupportedObservations += 1;
      if (explicitAmount <= 0) reasonCodes.push('assisted-rehydration-amount-not-positive');
      else if (explicitAmount !== ASSISTED_REHYDRATION_AMOUNT) reasonCodes.push('assisted-rehydration-amount-unexpected');
    }
    if (reasonCodes.length) assistedRecoveryEvidence.push(evidenceRef(item, {
      personId,
      helperId,
      conditionId,
      declaredSourceEventIds: declaredSources,
      explicitHydrationAmount: explicitAmount,
      reasonCodes,
    }));
    assistedRecoveryObservations.push(evidenceRef(item, {
      personId,
      helperId,
      conditionId,
      declaredSourceEventIds: declaredSources,
      explicitHydrationAmount: explicitAmount,
      sourceContractValid: !reasonCodes.includes('assisted-gain-missing-self-bound-source'),
      conditionContractValid: !reasonCodes.includes('missing-assisted-person-helper-month-or-condition')
        && !reasonCodes.includes('assisted-gain-not-bound-to-recovering-condition'),
      amountContractSupported: explicitAmount !== null,
      reasonCodes,
    }));
  }
  for (const items of assistedByPersonMonth.values()) {
    if (items.length <= 1) continue;
    for (const duplicate of items.slice(1)) {
      const diff = asObject(duplicate.event.diff) ?? {};
      assistedRecoveryEvidence.push(evidenceRef(duplicate, {
        personId: stringValue(diff.assistedDependentId),
        helperId: stringValue(diff.assistedByPersonId) ?? stringValue(duplicate.event.who),
        conditionId: stringValue(diff.hibernationConditionId),
        firstAssistanceEventId: stringValue(items[0].event.id),
        reasonCodes: ['more-than-one-caregiver-assisted-rehydrate-per-person-month'],
      }));
    }
  }

  const agreementDeadlineEvidence = [];
  const agreementSuspensionObservations = [];
  const validClosedSuspensions = [];
  let agreementSuspensionSupportedFacts = 0;
  let agreementSuspensionUnsupportedObservations = 0;
  const agreementIdsWithDeadlineEvents = new Set(indexedEvents.flatMap((item) => item.event.kind === 'agreement'
    && ['response-deadline-paused', 'response-deadline-resumed'].includes(stringValue(item.event.change))
    ? [stringValue(item.event.agreementId)]
    : []));
  const agreementsWithExplicitContract = asArray(state.agreements).filter((agreement) => (
    Object.hasOwn(agreement, 'responseDeadlineSuspensions')
    || agreementIdsWithDeadlineEvents.has(stringValue(agreement.id))
  ));
  if (!agreementsWithExplicitContract.length) agreementSuspensionUnsupportedObservations += 1;
  for (const agreement of agreementsWithExplicitContract) {
    const openByKey = new Map();
    let previousAtMonth = Number.NEGATIVE_INFINITY;
    const intervals = [];
    const facts = asArray(agreement.responseDeadlineSuspensions);
    if (!Array.isArray(agreement.responseDeadlineSuspensions)) agreementSuspensionUnsupportedObservations += 1;
    for (let factIndex = 0; factIndex < facts.length; factIndex += 1) {
      const fact = asObject(facts[factIndex]) ?? {};
      const kind = stringValue(fact.kind);
      const responderId = stringValue(fact.responderId);
      const conditionId = stringValue(fact.hibernationConditionId);
      const atMonth = integerValue(fact.atMonth);
      const effectiveFromMonth = integerValue(fact.effectiveFromMonth) ?? atMonth;
      const key = responderId && conditionId ? `${responderId}|${conditionId}` : null;
      const correspondingEvent = suspensionEventForFact(eventById, fact);
      const declaredSources = stringListValue(fact.sourceEventIds);
      const issue = (reason, extra = {}) => agreementDeadlineEvidence.push({
        eventId: stringValue(fact.eventId),
        atMonth,
        agreementId: stringValue(agreement.id),
        responderId,
        conditionId,
        factIndex,
        reason,
        ...extra,
      });
      if (!['pause', 'resume'].includes(kind) || !key || atMonth === null || !stringValue(fact.eventId)) {
        issue('invalid-source', { detail: 'malformed-suspension-fact' });
        agreementSuspensionUnsupportedObservations += 1;
        continue;
      }
      agreementSuspensionSupportedFacts += 1;
      if (atMonth < previousAtMonth) issue('invalid-source', { detail: 'non-append-order-month' });
      previousAtMonth = Math.max(previousAtMonth, atMonth);
      const expectedChange = kind === 'pause' ? 'response-deadline-paused' : 'response-deadline-resumed';
      const immutableEventValid = Boolean(correspondingEvent
        && correspondingEvent.change === expectedChange
        && stringValue(correspondingEvent.agreementId) === stringValue(agreement.id)
        && stringValue(correspondingEvent.responderId) === responderId
        && stringValue(correspondingEvent.hibernationConditionId) === conditionId
        && integerValue(correspondingEvent.atMonth) === atMonth);
      if (!immutableEventValid) {
        issue('invalid-source', { detail: 'missing-or-mismatched-immutable-agreement-event' });
      }
      const resolvedSources = declaredSources.flatMap((sourceId) => eventById.get(sourceId) ?? []);
      if (kind === 'pause') {
        const validEntrySource = resolvedSources.some((source) => completedAct(source, 'dehydrate')
          && dehydrateAffectedPersonId(source.event) === responderId
          && `condition-dehydrated-hibernation-${responderId}-${source.event.atMonth}` === conditionId);
        if (!declaredSources.length || !validEntrySource) issue('invalid-source', {
          detail: 'pause-missing-same-responder-condition-entry-action',
          sourceEventIds: declaredSources,
        });
        const validEffectiveFromMonth = effectiveFromMonth !== null && effectiveFromMonth <= atMonth
          && effectiveFromMonth >= (integerValue(agreement.proposedAtMonth) ?? effectiveFromMonth);
        if (!validEffectiveFromMonth) {
          issue('invalid-source', { detail: 'invalid-effective-from-month', effectiveFromMonth });
        }
        const alreadyOpen = openByKey.get(key);
        const otherOpenForResponder = [...openByKey.entries()]
          .find(([openKey]) => openKey.startsWith(`${responderId}|`));
        if (alreadyOpen || otherOpenForResponder) {
          const firstOpen = alreadyOpen ?? otherOpenForResponder?.[1];
          issue('duplicate-open', { firstPauseEventId: stringValue(firstOpen?.fact?.eventId) });
        } else {
          openByKey.set(key, {
            fact,
            effectiveFromMonth,
            contractValid: immutableEventValid && validEntrySource && validEffectiveFromMonth,
          });
        }
        agreementSuspensionObservations.push({
          eventId: stringValue(fact.eventId),
          atMonth,
          agreementId: stringValue(agreement.id),
          responderId,
          conditionId,
          kind,
          effectiveFromMonth,
          sourceEventIds: declaredSources,
          immutableEventValid,
          causalSourceValid: validEntrySource,
          effectiveFromMonthValid: validEffectiveFromMonth,
        });
      } else {
        const open = openByKey.get(key);
        const validExitSource = resolvedSources.some((source) => source.event.kind === 'environment'
          && source.event.change === 'condition'
          && eventPersonId(source.event) === responderId
          && stringValue(asObject(source.event.diff)?.hibernationConditionId) === conditionId
          && booleanValue(asObject(source.event.diff)?.exited) === true);
        if (!declaredSources.length || !validExitSource) issue('invalid-source', {
          detail: 'resume-missing-same-responder-condition-exit-event',
          sourceEventIds: declaredSources,
        });
        if (!open) {
          issue('invalid-source', { detail: 'resume-without-open-pause' });
        } else {
          intervals.push({
            agreement,
            responderId,
            conditionId,
            pause: open.fact,
            resume: fact,
            effectiveFromMonth: open.effectiveFromMonth,
            contractValid: open.contractValid && immutableEventValid && validExitSource,
          });
          openByKey.delete(key);
        }
        agreementSuspensionObservations.push({
          eventId: stringValue(fact.eventId),
          atMonth,
          agreementId: stringValue(agreement.id),
          responderId,
          conditionId,
          kind,
          sourceEventIds: declaredSources,
          immutableEventValid,
          causalSourceValid: validExitSource,
          pairedPauseEventId: stringValue(open?.fact?.eventId),
        });
      }
    }

    const agreementEvents = indexedEvents.filter((item) => item.event.kind === 'agreement'
      && stringValue(item.event.agreementId) === stringValue(agreement.id));
    for (const expired of agreementEvents.filter((item) => item.event.change === 'expired')) {
      const expiredMonth = integerValue(expired.event.atMonth);
      const enclosing = [...intervals, ...[...openByKey.values()].map((open) => ({
        effectiveFromMonth: open.effectiveFromMonth,
        resume: null,
      }))].find((interval) => expiredMonth !== null
        && interval.effectiveFromMonth <= expiredMonth
        && (!interval.resume || (() => {
          const resumeItem = eventById.get(stringValue(interval.resume.eventId));
          return resumeItem ? eventOrder(expired, resumeItem) < 0 : true;
        })()));
      if (enclosing) agreementDeadlineEvidence.push(evidenceRef(expired, {
        agreementId: stringValue(agreement.id),
        reason: 'expired-during-open',
      }));
    }
    for (const [key, open] of openByKey) {
      const [responderId, conditionId] = key.split('|');
      const responder = personById.get(responderId);
      const stillOpenCondition = asArray(responder?.conditions).some((condition) => stringValue(condition?.id) === conditionId
        && condition?.kind === 'dehydrated-hibernation');
      const death = (deathItemsByPerson.get(responderId) ?? [])[0];
      const validDeathTerminal = Boolean(death && stringValue(agreement.status) === 'cancelled');
      if (!stillOpenCondition && !validDeathTerminal) agreementDeadlineEvidence.push({
        eventId: stringValue(open.fact.eventId),
        atMonth: integerValue(open.fact.atMonth),
        agreementId: stringValue(agreement.id),
        responderId,
        conditionId,
        reason: 'missing-resume',
      });
    }
    for (const interval of intervals) {
      if (interval.contractValid) validClosedSuspensions.push(interval);
      else agreementSuspensionUnsupportedObservations += 1;
    }
    for (const expired of agreementEvents.filter((item) => item.event.change === 'expired')) {
      const expiredMonth = integerValue(expired.event.atMonth);
      const unresolvedResponderIds = asArray(agreement.requiredResponderIds)
        .map(stringValue)
        .filter((responderId) => responderId
          && !asArray(agreement.acceptedByPersonIds).includes(responderId)
          && !asArray(agreement.rejectedByPersonIds).includes(responderId));
      const effectiveDeadlines = unresolvedResponderIds.map((responderId) => (
        (integerValue(agreement.acceptByMonth) ?? 0)
        + intervals.filter((interval) => interval.responderId === responderId).reduce((sum, interval) => sum + Math.max(0,
          (integerValue(interval.resume.atMonth) ?? 0) - (integerValue(interval.effectiveFromMonth) ?? 0)), 0)
      ));
      const firstEffectiveDeadline = effectiveDeadlines.length ? Math.min(...effectiveDeadlines) : null;
      if (expiredMonth !== null && firstEffectiveDeadline !== null && expiredMonth <= firstEffectiveDeadline) agreementDeadlineEvidence.push(evidenceRef(expired, {
        agreementId: stringValue(agreement.id),
        firstEffectiveDeadline,
        reason: 'closed-effective-deadline-not-honored',
      }));
    }
    const partyDeaths = asArray(agreement.partyIds).flatMap((personId) => (
      deathItemsByPerson.get(stringValue(personId)) ?? []
    )).sort(eventOrder);
    const firstPartyDeath = partyDeaths[0];
    const resolvedAtMonth = integerValue(agreement.resolvedAtMonth);
    const agreementStatus = stringValue(agreement.status);
    const resolutionItem = agreementStatus === 'rejected'
      ? eventById.get(stringValue(agreement.responseEventId)) ?? null
      : agreementEvents.find((item) => item.event.change === agreementStatus) ?? null;
    const deathPrecedesUnresolvedResolution = firstPartyDeath && (
      ['proposed', 'active'].includes(agreementStatus)
      || (resolutionItem && eventOrder(firstPartyDeath, resolutionItem) < 0
        && !['cancelled'].includes(agreementStatus))
    );
    if (deathPrecedesUnresolvedResolution) {
      agreementDeadlineEvidence.push(evidenceRef(firstPartyDeath, {
        agreementId: stringValue(agreement.id),
        agreementStatus,
        resolvedAtMonth,
        resolutionEventId: stringValue(resolutionItem?.event.id),
        reason: 'death-did-not-take-cancelled-priority',
      }));
    }
  }

  const postRecoveryResponseEvidence = [];
  const postRecoveryResponseObservations = [];
  let postRecoveryResponseSupportedWindows = 0;
  let postRecoveryResponseUnsupportedWindows = 0;
  for (const interval of validClosedSuspensions) {
    const resumeEvent = eventById.get(stringValue(interval.resume.eventId));
    if (!resumeEvent) {
      postRecoveryResponseUnsupportedWindows += 1;
      continue;
    }
    const nextPause = validClosedSuspensions
      .filter((candidate) => candidate !== interval
        && stringValue(candidate.agreement.id) === stringValue(interval.agreement.id)
        && candidate.responderId === interval.responderId)
      .map((candidate) => eventById.get(stringValue(candidate.pause.eventId)))
      .filter((item) => item && eventOrder(item, resumeEvent) > 0)
      .sort(eventOrder)[0] ?? null;
    const responses = indexedEvents.filter((item) => eventOrder(item, resumeEvent) >= 0
      && (!nextPause || eventOrder(item, nextPause) < 0)
      && stringValue(item.event.who) === interval.responderId
      && communicationResponseReference(item.event) === stringValue(interval.agreement.id));
    if (!responses.length) {
      postRecoveryResponseObservations.push({
        agreementId: stringValue(interval.agreement.id),
        responderId: interval.responderId,
        conditionId: interval.conditionId,
        pauseEventId: stringValue(interval.pause.eventId),
        resumeEventId: stringValue(interval.resume.eventId),
        responseEventIds: [],
        status: 'unsupported',
        reason: 'no-observable-completed-response',
      });
      postRecoveryResponseUnsupportedWindows += 1;
      continue;
    }
    postRecoveryResponseObservations.push({
      agreementId: stringValue(interval.agreement.id),
      responderId: interval.responderId,
      conditionId: interval.conditionId,
      pauseEventId: stringValue(interval.pause.eventId),
      resumeEventId: stringValue(interval.resume.eventId),
      responseEventIds: responses.map((item) => stringValue(item.event.id)),
      responseCount: responses.length,
      status: 'supported',
    });
    postRecoveryResponseSupportedWindows += 1;
    if (!agreementRecordsResponse(interval.agreement, responses[0].event)) {
      postRecoveryResponseEvidence.push(evidenceRef(responses[0], {
        agreementId: stringValue(interval.agreement.id),
        responderId: interval.responderId,
        conditionId: interval.conditionId,
        resumeEventId: stringValue(interval.resume.eventId),
        reason: 'response-not-authoritatively-recorded-by-agreement',
      }));
    }
    for (const duplicate of responses.slice(1)) postRecoveryResponseEvidence.push(evidenceRef(duplicate, {
      agreementId: stringValue(interval.agreement.id),
      responderId: interval.responderId,
      conditionId: interval.conditionId,
      resumeEventId: stringValue(interval.resume.eventId),
      firstResponseEventId: stringValue(responses[0].event.id),
      reason: 'required-response-submitted-more-than-once-after-recovery',
    }));
  }
  const metrics = {
    relevantRecoveryEpisodes: metricResult(relevantEpisodes.length, relevantEpisodes.length, 0, {
      denominator: episodes.length,
      evidenceEventIds: relevantEpisodes.flatMap((episode) => episode.recoverySignals.map((signal) => signal.item.event.id)),
      note: '至少有一条 recovering 或 full-exit 事实的休眠 episode；无 entry 时保留 inferredStart',
    }),
    unsupportedAutomaticWakeups: metricResult(automaticWakeups.length, automaticWakeups.length, 0, {
      denominator: fullExitSignals.length,
      categories: automaticCategories,
      evidenceEventIds: automaticWakeups.map((signal) => signal.item.event.id),
      note: '所有直接 full exit 的环境/automatic 事件均计入；dormant→recovering 不计入',
    }),
    unsafeHibernationExits: metricResult(unsafeExitEvidence.length, safeExitObservations, unsupportedExitObservations, {
      denominator: fullExitSignals.length,
      reasonCodes: unsupportedExitObservations ? ['exit-missing-minimum-reserve-after'] : [],
      evidenceEventIds: unsafeExitEvidence.map((item) => item.eventId),
      note: `只在退出事件明确给出 minimumReserveAfter 时按 <${SAFE_EXIT_MINIMUM_RESERVE} 判定`,
    }),
    unbackedReserveIncreases: metricResult(unbackedEvidence.length, backedRecoveryObservations, unsupportedRecoverySourceObservations, {
      denominator: relevantEpisodes.length,
      reasonCodes: unsupportedRecoverySourceObservations ? ['recovery-missing-body-delta-or-source-contract'] : [],
      evidenceEventIds: unbackedEvidence.map((item) => item.eventId),
    }),
    incompleteRecoveryRepeatHeatExposures: metricResult(repeatHeatEvidence.length, repeatHeatSupportedEpisodes, repeatHeatUnsupportedEpisodes, {
      denominator: relevantEpisodes.length,
      reasonCodes: repeatHeatUnsupportedEpisodes ? ['recovery-state-missing-minimum-reserve-after'] : [],
      evidenceEventIds: repeatHeatEvidence.flatMap((item) => [item.recoveryEventId, item.heatEventId]),
    }),
    postWakeSevereHeatDeaths: metricResult(postWakeDeathEvidence.length, postWakeDeathSupportedEpisodes, postWakeDeathUnsupportedEpisodes, {
      denominator: relevantEpisodes.length,
      reasonCodes: postWakeDeathUnsupportedEpisodes ? ['post-wake-death-missing-resolved-causal-sources'] : [],
      evidenceEventIds: postWakeDeathEvidence.flatMap((item) => [item.recoveryEventId, item.deathEventId, ...item.severeHeatSourceEventIds]),
      note: `死亡 sourceEventIds 必须解析到同一人的 stage>=${SEVERE_HEAT_STAGE} heat condition`,
    }),
    continuedEpisodeResets: metricResult(resetEvidence.length, resetSupportedEpisodes, resetUnsupportedEpisodes, {
      denominator: relevantEpisodes.length,
      reasonCodes: resetUnsupportedEpisodes ? ['missing-recovery-state-or-episode-continuity-id'] : [],
      evidenceEventIds: resetEvidence.map((item) => item.eventId),
    }),
    hibernationCostViolations: metricResult(costEvidence.length, costSupportedPersonMonths, costUnsupportedPersonMonths, {
      denominator: expectedCostPersonMonths || relevantEpisodes.length,
      categories: {
        expectedRelevantPersonMonths: expectedCostPersonMonths,
        supportedRelevantPersonMonths: costSupportedPersonMonths,
        missingRelevantPersonMonths: Math.max(0, expectedCostPersonMonths - costSupportedPersonMonths),
        unknownCoverageEpisodes: unknownCostCoverageEpisodes,
      },
      reasonCodes: costUnsupportedPersonMonths ? ['missing-versioned-monthly-hibernation-cost-facts'] : [],
      evidenceEventIds: costEvidence.map((item) => item.eventId),
    }),
    recoverySocialPreemptions: metricResult(socialPreemptionEvidence.length, socialSupportedWindows, socialUnsupportedEpisodes, {
      denominator: socialSupportedWindows + socialUnsupportedEpisodes,
      categories: {
        supportedRecoveryWindows: socialSupportedWindows,
        unsupportedLegacyEpisodes: socialUnsupportedEpisodes,
        requiredResponseCommunications: socialPreemptionEvidence.filter((item) => item.requiredResponse).length,
        otherCommunications: socialPreemptionEvidence.filter((item) => !item.requiredResponse).length,
        contentKinds: countBy(socialPreemptionEvidence.map((item) => item.contentKind)),
      },
      reasonCodes: socialUnsupportedEpisodes ? ['no-observable-recovering-phase-window'] : [],
      evidenceEventIds: socialPreemptionEvidence.map((item) => item.eventId),
    }),
    hibernationProjectStallsOrBlocks: metricResult(
      projectBlockEvidence.length,
      continuityLongitudinalSupportedEpisodes,
      continuityLongitudinalUnsupportedEpisodes,
      {
        denominator: continuityEpisodes.length,
        categories: {
          projectStatuses: countBy(projectBlockEvidence.map((item) => item.projectStatus)),
          blockedReasons: countBy(projectBlockEvidence.map((item) => item.blockedReason)),
        },
        reasonCodes: continuityLongitudinalUnsupportedEpisodes
          ? ['legacy-or-inferred-episode-missing-hibernation-marker-phase-window']
          : [],
        evidenceEventIds: projectBlockEvidence.map((item) => item.eventId),
        note: '只统计同 owner 的 marker 意图所绑定项目，blockedAtMonth 位于 entry..exit-1；死亡当月因 owner-loss 合法终止单列',
      },
    ),
    hibernationDeathTerminalizedProjects: metricResult(
      deathTerminalizedProjectEvidence.length,
      continuityLongitudinalSupportedEpisodes,
      continuityLongitudinalUnsupportedEpisodes,
      {
        denominator: continuityEpisodes.length,
        categories: {
          projectStatuses: countBy(deathTerminalizedProjectEvidence.map((item) => item.projectStatus)),
          blockedReasons: countBy(deathTerminalizedProjectEvidence.map((item) => item.blockedReason)),
        },
        reasonCodes: continuityLongitudinalUnsupportedEpisodes
          ? ['legacy-or-inferred-episode-missing-hibernation-marker-phase-window']
          : [],
        evidenceEventIds: deathTerminalizedProjectEvidence.map((item) => item.eventId),
        note: '死亡边界当月因项目 owner 已死亡而终止，属于合法终态，不计为休眠假停滞',
      },
    ),
    hibernationMarkerOrphans: metricResult(markerOrphanEvidence.length, markerSupportedEpisodes, markerUnsupportedEpisodes, {
      denominator: continuityEpisodes.length + standaloneMarkerObservations,
      categories: {
        reasons: countBy(markerOrphanEvidence.map((item) => item.reason)),
        standaloneTerminalMarkerObservations: standaloneMarkerObservations,
        incompleteInferredEpisodes: markerIncompleteInferredEpisodes,
      },
      reasonCodes: [
        ...(continuityEpisodes.some((episode) => !episode.markerAuditSupported)
          ? ['legacy-episode-missing-hibernation-intent-marker-contract']
          : []),
        ...(markerIncompleteInferredEpisodes ? ['inferred-episode-missing-entry-boundary'] : []),
      ],
      evidenceEventIds: markerOrphanEvidence.map((item) => item.eventId),
      note: 'orphan 只由缺失 intent/condition/intent-chain 引用证明；历史 marker 已正常清除不计',
    }),
    hibernationMarkerMismatches: metricResult(markerMismatchEvidence.length, markerSupportedEpisodes, markerUnsupportedEpisodes, {
      denominator: continuityEpisodes.length + standaloneMarkerObservations,
      categories: {
        reasons: countBy(markerMismatchEvidence.map((item) => item.reason)),
        incompleteInferredEpisodes: markerIncompleteInferredEpisodes,
      },
      reasonCodes: [
        ...(continuityEpisodes.some((episode) => !episode.markerAuditSupported)
          ? ['legacy-episode-missing-hibernation-intent-marker-contract']
          : []),
        ...(markerIncompleteInferredEpisodes ? ['inferred-episode-missing-entry-boundary'] : []),
      ],
      evidenceEventIds: markerMismatchEvidence.map((item) => item.eventId),
      note: 'mismatch 包含 condition/owner/status/chain/restore 对不上；缺字段本身进入 unsupported，不当作 mismatch',
    }),
    preRecoveryOrdinaryActions: metricResult(
      ordinaryActionEvidence.length,
      continuityLongitudinalSupportedEpisodes,
      continuityLongitudinalUnsupportedEpisodes,
      {
        denominator: continuityEpisodes.length,
        categories: {
          intentActions: ordinaryActionEvidence.filter((item) => item.categories.includes('intent')).length,
          projectActions: ordinaryActionEvidence.filter((item) => item.categories.includes('project')).length,
          socialActions: ordinaryActionEvidence.filter((item) => item.categories.includes('social')).length,
          physicalRecoveryActions: ordinaryActionEvidence.filter((item) => item.physicalRecovery).length,
          unresolvedIntentReferences: ordinaryActionEvidence.filter((item) => item.intentId && !item.intentResolved).length,
          operations: countBy(ordinaryActionEvidence.map((item) => item.operation ?? item.kind)),
        },
        reasonCodes: continuityLongitudinalUnsupportedEpisodes
          ? ['legacy-or-inferred-episode-missing-hibernation-marker-phase-window']
          : [],
        evidenceEventIds: ordinaryActionEvidence.map((item) => item.eventId),
        note: 'entry 后至安全退出/死亡/下一 episode 前的 completed 普通 intent/project/social action；无 intent 的直接恢复 reflex 不计，可证瞬时 recovery child 单列',
      },
    ),
    instantRecoveryIntentChildren: metricResult(
      instantRecoveryChildEvidence.length,
      instantRecoverySupportedWindows,
      instantRecoveryUnsupportedWindows,
      {
        denominator: instantRecoverySupportedWindows + instantRecoveryUnsupportedWindows,
        categories: {
          supportedRecoveryWindows: instantRecoverySupportedWindows,
          unsupportedRecoveryWindows: instantRecoveryUnsupportedWindows,
          unresolvedRecoveryActionIntentRefs,
          statuses: countBy(instantRecoveryChildEvidence.map((item) => item.status)),
          operations: countBy(instantRecoveryChildEvidence.map((item) => item.operation ?? item.kind)),
        },
        reasonCodes: instantRecoveryUnsupportedWindows
          ? ['missing-recovering-phase-or-intent-continuity-contract']
          : [],
        evidenceEventIds: instantRecoveryChildEvidence.map((item) => item.eventId),
        note: '严格要求 recovering 窗口内 survival-reflex action、child returnToIntentId，且 createdAtMonth=returnResolvedAtMonth=action month',
      },
    ),
    duplicateDehydrateActions: strictMetricResult(
      duplicateDehydrateActionEvidence.length,
      duplicateEntrySupportedEpisodes,
      duplicateEntryUnsupportedEpisodes,
      {
        denominator: continuityEpisodes.length,
        reasonCodes: duplicateEntryUnsupportedEpisodes
          ? ['episode-missing-exact-entry-exit-and-condition-contract']
          : [],
        evidenceEventIds: duplicateDehydrateActionEvidence.map((item) => item.eventId),
        note: '同一 person+condition episode 从首个 completed dehydrate 到 exit/death 边界前的第二个及后续 completed dehydrate',
      },
    ),
    duplicateHibernationSurvivalChildren: strictMetricResult(
      duplicateSurvivalChildEvidence.length,
      duplicateEntrySupportedEpisodes,
      duplicateEntryUnsupportedEpisodes,
      {
        denominator: continuityEpisodes.length,
        reasonCodes: duplicateEntryUnsupportedEpisodes
          ? ['episode-missing-exact-entry-exit-and-condition-contract']
          : [],
        evidenceEventIds: duplicateSurvivalChildEvidence.map((item) => item.eventId),
        note: '同一精确 episode 窗口内、同 owner、nextAction=自我 dehydrate 的第二个及后续 survival-reflex child intent',
      },
    ),
    stableEpochDehydrateReplays: strictMetricResult(
      stableEpochReplayEvidence.length,
      stableReplaySupportedActions,
      stableReplayUnsupportedActions,
      {
        denominator: stableReplaySupportedActions + stableReplayUnsupportedActions,
        emptyReasonCode: 'no-post-safe-exit-dehydrate-observations',
        categories: {
          eligiblePostExitDehydrateActions: stableReplaySupportedActions + stableReplayUnsupportedActions,
          fullyObservedActions: stableReplaySupportedActions,
          actionsMissingRequiredFacts: stableReplayUnsupportedActions,
        },
        reasonCodes: stableReplayUnsupportedActions
          ? ['post-exit-dehydrate-missing-safe-exit-state-epoch-intent-or-timestamp']
          : [],
        evidenceEventIds: stableEpochReplayEvidence.flatMap((item) => [item.eventId, item.priorSafeExitEventId]),
        note: '安全退出后 completed dehydrate 明确发生于 stable，且所用 intent 创建时间不晚于该 exit，才算旧进入意图重放',
      },
    ),
    caregiverAssistedRecoveryViolations: strictMetricResult(
      assistedRecoveryEvidence.length,
      assistedRecoverySupportedObservations,
      assistedRecoveryUnsupportedObservations,
      {
        denominator: assistedRecoveryEvents.length,
        emptyReasonCode: 'no-caregiver-assisted-recovery-observations',
        categories: {
          assistedCompletedActions: assistedRecoveryEvents.length,
          duplicatePersonMonths: [...assistedByPersonMonth.values()].filter((items) => items.length > 1).length,
          missingExplicitHydrationAmount: assistedRecoveryUnsupportedObservations,
          reasons: countBy(assistedRecoveryEvidence.flatMap((item) => item.reasonCodes ?? [])),
        },
        reasonCodes: assistedRecoveryUnsupportedObservations
          ? ['assisted-rehydrate-diff-missing-explicit-hydration-amount']
          : [],
        evidenceEventIds: assistedRecoveryEvidence.map((item) => item.eventId),
        note: '每个 recovering dependent person/month 最多一次；source 必须自绑定 completed action，condition/phase 必须明确，增益量缺失则该 observation unsupported',
      },
    ),
    agreementResponseDeadlineViolations: strictMetricResult(
      agreementDeadlineEvidence.length,
      agreementSuspensionSupportedFacts,
      agreementSuspensionUnsupportedObservations,
      {
        denominator: agreementSuspensionSupportedFacts + agreementSuspensionUnsupportedObservations,
        categories: {
          explicitContractAgreements: agreementsWithExplicitContract.length,
          validClosedSuspensions: validClosedSuspensions.length,
          reasons: countBy(agreementDeadlineEvidence.map((item) => item.reason)),
        },
        reasonCodes: agreementSuspensionUnsupportedObservations
          ? ['no-explicit-response-deadline-suspension-contract-or-malformed-fact']
          : [],
        evidenceEventIds: agreementDeadlineEvidence.map((item) => item.eventId),
        note: '最终 append-only facts 必须与不可变 pause/resume 事件及 entry/exit 来源一致；open 不可 expired，closed 使用 acceptBy+冻结月数，死亡优先 cancelled',
      },
    ),
    postRecoveryRequiredResponseViolations: strictMetricResult(
      postRecoveryResponseEvidence.length,
      postRecoveryResponseSupportedWindows,
      postRecoveryResponseUnsupportedWindows,
      {
        denominator: validClosedSuspensions.length,
        emptyReasonCode: 'no-closed-response-deadline-suspension-windows',
        categories: {
          closedSuspensionWindows: validClosedSuspensions.length,
          windowsWithObservableResponse: postRecoveryResponseSupportedWindows,
          windowsWithoutObservableResponse: postRecoveryResponseUnsupportedWindows,
        },
        reasonCodes: postRecoveryResponseUnsupportedWindows
          ? ['closed-suspension-window-has-no-observable-completed-response']
          : [],
        evidenceEventIds: postRecoveryResponseEvidence.map((item) => item.eventId),
        note: '只在 resume 后可解析到 completed accept/reject 时审计唯一性；没有响应事件的窗口为 unsupported，不伪造 0',
      },
    ),
    strongUnselectedDehydrateCandidateRate: explicitlyUnsupportedMetric(
      'decision-history-does-not-persist-ranked-option-basis',
      '终态事件没有每次决策的合法候选全集、强度与未选择原因，无法重投影“强候选存在但未选择”的分子或分母',
    ),
  };

  return {
    runId: matrixRun.runId,
    seed: matrixRun.seed ?? state.seed,
    horizonYears: matrixRun.years ?? matrixRun.horizonYears ?? null,
    requestedMonths: matrixRun.requestedMonths ?? null,
    reachedMonth: finiteValue(state.clock?.elapsedMonths),
    matrixStatus: matrixRun.status ?? null,
    civilizationStatus: state.civilization?.status ?? null,
    outcome: state.civilization?.outcome ?? null,
    schemaVersion: state.schemaVersion ?? null,
    metrics,
    evidence: {
      entries: signals.filter((signal) => signal.isEntry).map((signal) => evidenceRef(signal.item, {
        episodeId: signal.episodeId,
        phaseAfter: signal.phaseAfter,
      })),
      exits: signals.filter((signal) => signal.fullExit || signal.recoveryStart).map((signal) => evidenceRef(signal.item, {
        episodeId: signal.episodeId,
        fullExit: signal.fullExit,
        recoveryStart: signal.recoveryStart,
        automatic: signal.automatic,
        phaseBefore: signal.phaseBefore,
        phaseAfter: signal.phaseAfter,
        minimumReserveAfter: signal.bodyAfter.minimumReserve,
        recoveryComplete: signal.recoveryComplete,
        recoverySourceEventIds: signal.recoverySourceEventIds,
        waterNearby: signal.waterNearby,
        helperNearby: signal.helperNearby,
        ambientRecovery: signal.ambientRecovery,
        wakeSource: signal.wakeSource,
      })),
      reentries: [
        ...reentries.map((entry) => evidenceRef(entry.signal.item, {
          previousEpisodeId: entry.previousEpisode.auditEpisodeId,
          episodeId: entry.signal.episodeId,
          whileOpen: entry.whileOpen,
          phaseBefore: entry.signal.phaseBefore,
          phaseAfter: entry.signal.phaseAfter,
        })),
        ...episodes.flatMap((episode) => episode.resumedDormantSignals.map((signal) => evidenceRef(signal.item, {
          previousEpisodeId: episode.auditEpisodeId,
          episodeId: signal.episodeId,
          whileOpen: true,
          continuedEpisode: booleanValue(firstValue(eventPayloads(signal.item.event), ['continuedEpisode'])),
          phaseBefore: signal.phaseBefore,
          phaseAfter: signal.phaseAfter,
        }))),
      ],
      thermalDeaths: thermalDeaths.filter((death) => death.severeHeat).map((death) => evidenceRef(death.item, {
        cause: death.cause,
        classificationSupported: death.classificationSupported,
        sourceEventIds: death.sourceEventIds,
        severeHeatSourceEventIds: death.severeHeatSourceEventIds,
        unresolvedSourceEventIds: death.unresolvedSourceEventIds,
      })),
      unsupportedDeathClassifications: thermalDeaths.filter((death) => !death.classificationSupported).map((death) => evidenceRef(death.item, {
        cause: death.cause,
        sourceEventIds: death.sourceEventIds,
        unresolvedSourceEventIds: death.unresolvedSourceEventIds,
      })),
      unsafeExits: unsafeExitEvidence,
      unbackedReserveIncreases: unbackedEvidence,
      incompleteRecoveryRepeatHeatExposures: repeatHeatEvidence,
      postWakeSevereHeatDeaths: postWakeDeathEvidence,
      continuedEpisodeResets: resetEvidence,
      hibernationCostViolations: costEvidence,
      recoverySocialPreemptions: socialPreemptionEvidence,
      hibernationProjectStallsOrBlocks: projectBlockEvidence,
      hibernationDeathTerminalizedProjects: deathTerminalizedProjectEvidence,
      hibernationMarkerOrphans: markerOrphanEvidence,
      hibernationMarkerMismatches: markerMismatchEvidence,
      preRecoveryOrdinaryActions: ordinaryActionEvidence,
      instantRecoveryIntentChildren: instantRecoveryChildEvidence,
      duplicateDehydrateActions: duplicateDehydrateActionEvidence,
      duplicateHibernationSurvivalChildren: duplicateSurvivalChildEvidence,
      stableEpochDehydrateReplays: stableEpochReplayEvidence,
      caregiverAssistedRecoveryViolations: assistedRecoveryEvidence,
      unsupportedCaregiverAssistedRecovery: unsupportedAssistedRecoveryEvidence,
      caregiverAssistedRecoveryObservations: assistedRecoveryObservations,
      agreementResponseDeadlineViolations: agreementDeadlineEvidence,
      agreementResponseDeadlineSuspensions: agreementSuspensionObservations,
      postRecoveryRequiredResponseViolations: postRecoveryResponseEvidence,
      postRecoveryRequiredResponseObservations: postRecoveryResponseObservations,
    },
  };
}

function aggregateMetric(runs, metricName) {
  const metrics = runs.map((run) => run.metrics[metricName]);
  const usableValues = metrics.flatMap((metric) => metric.status === 'unsupported' ? [] : [metric.value]);
  const knownValues = metrics.map((metric) => finiteValue(metric.knownValue)).filter((value) => value !== null);
  return {
    statuses: countBy(metrics.map((metric) => metric.status)),
    values: numericSummary(usableValues),
    knownValueSum: knownValues.length ? knownValues.reduce((sum, value) => sum + value, 0) : null,
    supportedObservations: metrics.reduce((sum, metric) => sum + metric.supportedObservations, 0),
    unsupportedObservations: metrics.reduce((sum, metric) => sum + metric.unsupportedObservations, 0),
    denominators: numericSummary(metrics.map((metric) => metric.denominator)),
    coverage: numericSummary(metrics.map((metric) => metric.coverage)),
    reasonCodes: countBy(metrics.flatMap((metric) => metric.reasonCodes)),
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
    reachedMonth: numericSummary(matching.map((run) => run.reachedMonth)),
    evidenceCounts: {
      entries: numericSummary(matching.map((run) => run.evidence.entries.length)),
      exits: numericSummary(matching.map((run) => run.evidence.exits.length)),
      reentries: numericSummary(matching.map((run) => run.evidence.reentries.length)),
      thermalDeaths: numericSummary(matching.map((run) => run.evidence.thermalDeaths.length)),
    },
    metrics: Object.fromEntries(METRIC_NAMES.map((metricName) => [metricName, aggregateMetric(matching, metricName)])),
  }));
}

async function main() {
  const [matrixArgument, outputArgument] = process.argv.slice(2);
  if (matrixArgument === '--self-test') {
    runMetricCoverageSelfCheck();
    process.stdout.write(`${OBSERVER_VERSION} metric coverage self-check passed\n`);
    return;
  }
  if (!matrixArgument) {
    throw new Error('usage: node scripts/audit-hibernation-recovery-chain.mjs <matrix.json> [output.json] | --self-test');
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
      authority: 'SQLite terminal SimulationState loaded read-only through sqlite-run-reader.mjs; no run is advanced',
      episodeDefinition: 'dehydrate entry followed by recovering/full-exit facts, linked per person and explicit episode/condition id when present',
      safeExitThreshold: SAFE_EXIT_MINIMUM_RESERVE,
      severeHeatStage: SEVERE_HEAT_STAGE,
      automaticWakeDefinition: 'full exit emitted by environment or explicitly marked automatic; dormant→recovering alone is not a wake exit',
      physicalRecoveryDefinition: 'completed ingest/rehydrate action, or an explicitly marked physical recovery action, resolved through source event ids',
      monthlyCostCoverageDefinition: 'entry month through exitMonth-1; without exit, entry month through death/terminal month, because action ticks precede advanceBodies while safe phase exit precedes it',
      recoverySocialPreemptionDefinition: 'any completed communicate action by the recovering person before safe exit or return to dormant; interruptionKind is classification only',
      intentProjectContinuityObserverVersion: 'hibernation-intent-project-continuity-v1',
      intentProjectWindowDefinition: 'entry inclusive through safe-exit/next-entry month exclusive; death month inclusive; project blocks require same-owner marker intent and project blockedAtMonth in that window',
      instantRecoveryIntentChildDefinition: 'survival-reflex action in a recovering phase whose intent has returnToIntentId and was created and return-resolved in the action month',
      duplicateEntryDefinition: 'within one exact person+hibernation-condition episode, every completed dehydrate or self-dehydrate survival child after the first is a duplicate',
      stableEpochReplayDefinition: 'a completed stable-epoch dehydrate after a safe exit whose resolved intent was created no later than that exit',
      caregiverAssistedRecoveryDefinition: `at most one completed assisted rehydrate per affected person/month, with self-bound source id, explicit hydration amount=${ASSISTED_REHYDRATION_AMOUNT}, and recovering condition id/phase`,
      agreementResponseDeadlineDefinition: 'append-only per responder+condition pause/resume facts backed by immutable agreement events and entry/exit sources; open clocks cannot expire, closed clocks extend the immutable acceptByMonth, and death resolves cancelled first',
      postRecoveryRequiredResponseDefinition: 'only closed suspension windows with an observable completed accept/reject are eligible; the response must occur once',
      metricCoverageDefinition: 'supportedObservations / denominator for strict metrics; denominator=0 is unsupported, mixed known/unknown observations are partial, and all-unknown observations are unsupported',
      strongUnselectedCandidateDefinition: 'unsupported because terminal decision facts do not retain the full ranked legal-option basis or unselected candidates',
      unsupportedPolicy: 'missing body snapshots, phase windows, episode ids, source ids, monthly cost facts, or v1 hibernation intent markers produce null/unsupported rather than zero',
      compatibility: {
        legacy: 'condition=dehydrated-hibernation with entered/exited and waterNearby/helperNearby/ambientRecovery; continuity metrics remain unsupported when marker/phase fields are absent',
        candidate: 'top-level diff or nested hibernationRecoveryAudit/hibernationRecovery/recoveryAudit/recovery phase, source, body-before/after, episode, suspended/restored/failed intent and terminal intent marker fields',
      },
    },
    aggregates: aggregateRuns(runs),
    runs,
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, serialized, 'utf8');
  else process.stdout.write(serialized);
}

await main();
