import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { openSqliteRunReader } from './sqlite-run-reader.mjs';

const OBSERVER_VERSION = 'food-reserve-use-chain-audit-v1';
const METHOD_VERSION = 'exact-stored-food-lineage-v1';
const MAX_INGEST_DELAY_MONTHS = 2;

// Pinned to domain/material.ts for this observer version. A future edible
// material requires a new observer version instead of silently changing old
// experiment results.
const EDIBLE_MATERIALS = new Map([
  [21, 'food'],
  [25, 'cooked-food'],
  [29, 'raw-meat'],
  [34, 'herbal-medicine'],
]);

const asArray = (value) => Array.isArray(value) ? value : [];
const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const stringValue = (value) => typeof value === 'string' && value.length > 0 ? value : null;
const finiteValue = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const integerValue = (value) => Number.isInteger(value) ? value : null;
const unique = (values) => [...new Set(values.filter((value) => value !== null && value !== undefined))].sort();
const strings = (value) => unique(asArray(value).map(stringValue).filter(Boolean));
const rounded = (value) => Math.round(value * 100) / 100;
const percentage = (numerator, denominator) => denominator > 0 ? rounded(numerator / denominator * 100) : null;

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

function isEdible(materialId) {
  return EDIBLE_MATERIALS.has(finiteValue(materialId));
}

function completedAction(item) {
  return item.event.kind === 'action' && item.event.status === 'completed';
}

function completedContainerTransfer(item) {
  if (!completedAction(item)) return false;
  const action = asObject(item.event.action);
  return action?.kind === 'transfer'
    && (asObject(action.from)?.kind === 'container' || asObject(action.to)?.kind === 'container');
}

function completedStoredEdibleWithdrawal(item) {
  if (!completedAction(item)) return false;
  const event = item.event;
  const action = asObject(event.action);
  const from = asObject(action?.from);
  const to = asObject(action?.to);
  return action?.kind === 'transfer'
    && from?.kind === 'container'
    && to?.kind === 'person'
    && stringValue(to.personId) === stringValue(event.who)
    && isEdible(action.materialId);
}

function completedEdibleDeposit(item) {
  if (!completedAction(item)) return false;
  const event = item.event;
  const action = asObject(event.action);
  const from = asObject(action?.from);
  const to = asObject(action?.to);
  return action?.kind === 'transfer'
    && from?.kind === 'person'
    && stringValue(from.personId) === stringValue(event.who)
    && to?.kind === 'container'
    && isEdible(action.materialId);
}

function completedInventoryEdibleIngest(item) {
  if (!completedAction(item)) return false;
  const event = item.event;
  const action = asObject(event.action);
  const target = asObject(asArray(action?.targets)[0]);
  const diff = asObject(event.diff) ?? {};
  return action?.kind === 'act'
    && action.operation === 'ingest'
    && target?.kind === 'inventory-stack'
    && stringValue(target.personId) === stringValue(event.who)
    && isEdible(diff.materialId);
}

function completedPersonEdibleTransfer(item) {
  if (!completedAction(item)) return false;
  const event = item.event;
  const action = asObject(event.action);
  const from = asObject(action?.from);
  const to = asObject(action?.to);
  return action?.kind === 'transfer'
    && from?.kind === 'person'
    && to?.kind === 'person'
    && stringValue(from.personId) === stringValue(event.who)
    && stringValue(to.personId) !== stringValue(event.who)
    && isEdible(action.materialId);
}

function sourceContract(diff, prefix = '') {
  const eventField = prefix ? `${prefix}SourceEventIds` : 'sourceEventIds';
  const lineageField = prefix ? `${prefix}SourceLineageKeys` : 'sourceLineageKeys';
  const sourceEventIds = strings(diff[eventField]);
  const sourceLineageKeys = strings(diff[lineageField]);
  return {
    sourceEventIds,
    sourceLineageKeys,
    supported: Object.hasOwn(diff, eventField)
      && Object.hasOwn(diff, lineageField)
      && sourceLineageKeys.length > 0,
  };
}

function isSubset(subset, superset) {
  if (!subset.length) return false;
  const values = new Set(superset);
  return subset.every((value) => values.has(value));
}

function difference(left, right) {
  const rightValues = new Set(right);
  return left.filter((value) => !rightValues.has(value));
}

function withdrawalIngestSourceIncluded(withdrawal, ingest) {
  const withdrawalDiff = asObject(withdrawal.event.diff) ?? {};
  const ingestDiff = asObject(ingest.event.diff) ?? {};
  const withdrawn = sourceContract(withdrawalDiff);
  const consumed = sourceContract(ingestDiff, 'consumed');
  return withdrawn.supported
    && consumed.supported
    && consumed.sourceEventIds.includes(withdrawal.event.id)
    && isSubset(withdrawn.sourceLineageKeys, consumed.sourceLineageKeys);
}

function inboundSameMaterialMerges(withdrawal, ingest, items) {
  const actorId = stringValue(withdrawal.event.who);
  const materialId = finiteValue(asObject(withdrawal.event.action)?.materialId);
  return items.filter((item) => {
    if (!completedAction(item) || item.event.id === withdrawal.event.id) return false;
    const action = asObject(item.event.action);
    const to = asObject(action?.to);
    return action?.kind === 'transfer'
      && to?.kind === 'person'
      && stringValue(to.personId) === actorId
      && finiteValue(action.materialId) === materialId
      && eventOrder(item, withdrawal) > 0
      && eventOrder(item, ingest) < 0;
  });
}

function inboundSameMaterialMergesFor(actorId, materialId, afterItem, beforeItem, items, excludedEventIds = []) {
  const excluded = new Set(excludedEventIds);
  return items.filter((item) => {
    if (!completedAction(item) || excluded.has(item.event.id)) return false;
    const action = asObject(item.event.action);
    const to = asObject(action?.to);
    return action?.kind === 'transfer'
      && to?.kind === 'person'
      && stringValue(to.personId) === actorId
      && finiteValue(action.materialId) === materialId
      && eventOrder(item, afterItem) > 0
      && eventOrder(item, beforeItem) < 0;
  });
}

function withdrawalRelaySourceIncluded(withdrawal, relay) {
  const withdrawn = sourceContract(asObject(withdrawal.event.diff) ?? {});
  const relayed = sourceContract(asObject(relay.event.diff) ?? {});
  return withdrawn.supported
    && relayed.supported
    && relayed.sourceEventIds.includes(withdrawal.event.id)
    && isSubset(withdrawn.sourceLineageKeys, relayed.sourceLineageKeys);
}

function withdrawalRelayAmbiguity(withdrawal, relay, items) {
  const withdrawn = sourceContract(asObject(withdrawal.event.diff) ?? {});
  const relayed = sourceContract(asObject(relay.event.diff) ?? {});
  const actorId = stringValue(withdrawal.event.who);
  const materialId = finiteValue(asObject(withdrawal.event.action)?.materialId);
  const inboundMerges = inboundSameMaterialMergesFor(
    actorId, materialId, withdrawal, relay, items, [withdrawal.event.id],
  );
  const extraSourceEventIds = difference(relayed.sourceEventIds, withdrawn.sourceEventIds);
  const extraSourceLineageKeys = difference(relayed.sourceLineageKeys, withdrawn.sourceLineageKeys);
  const reasons = unique([
    ...(inboundMerges.length ? ['caregiver-intervening-inbound-same-material-merge'] : []),
    ...(extraSourceEventIds.length ? ['relay-source-event-spectrum-has-extra-sources'] : []),
    ...(extraSourceLineageKeys.length ? ['relay-lineage-spectrum-has-extra-sources'] : []),
  ]);
  return { ambiguous: reasons.length > 0, reasons, inboundMerges, extraSourceEventIds, extraSourceLineageKeys };
}

function relayIngestSourceIncluded(relay, ingest) {
  const relayed = sourceContract(asObject(relay.event.diff) ?? {});
  const consumed = sourceContract(asObject(ingest.event.diff) ?? {}, 'consumed');
  return relayed.supported
    && consumed.supported
    && consumed.sourceEventIds.includes(relay.event.id)
    && isSubset(relayed.sourceLineageKeys, consumed.sourceLineageKeys);
}

function relayIngestAmbiguity(relay, ingest, items) {
  const relayed = sourceContract(asObject(relay.event.diff) ?? {});
  const consumed = sourceContract(asObject(ingest.event.diff) ?? {}, 'consumed');
  const action = asObject(relay.event.action) ?? {};
  const childId = stringValue(asObject(action.to)?.personId);
  const materialId = finiteValue(action.materialId);
  const inboundMerges = inboundSameMaterialMergesFor(
    childId, materialId, relay, ingest, items, [relay.event.id],
  );
  const expectedEventIds = unique([...relayed.sourceEventIds, relay.event.id]);
  const extraConsumedSourceEventIds = difference(consumed.sourceEventIds, expectedEventIds);
  const extraConsumedSourceLineageKeys = difference(consumed.sourceLineageKeys, relayed.sourceLineageKeys);
  const reasons = unique([
    ...(inboundMerges.length ? ['dependent-intervening-inbound-same-material-merge'] : []),
    ...(extraConsumedSourceEventIds.length ? ['dependent-consumed-source-event-spectrum-has-extra-sources'] : []),
    ...(extraConsumedSourceLineageKeys.length ? ['dependent-consumed-lineage-spectrum-has-extra-sources'] : []),
  ]);
  return {
    ambiguous: reasons.length > 0,
    reasons,
    inboundMerges,
    extraConsumedSourceEventIds,
    extraConsumedSourceLineageKeys,
  };
}

function withdrawalIngestAmbiguity(withdrawal, ingest, items) {
  const withdrawn = sourceContract(asObject(withdrawal.event.diff) ?? {});
  const consumed = sourceContract(asObject(ingest.event.diff) ?? {}, 'consumed');
  const inboundMerges = inboundSameMaterialMerges(withdrawal, ingest, items);
  const extraConsumedSourceEventIds = difference(consumed.sourceEventIds, withdrawn.sourceEventIds);
  const extraConsumedSourceLineageKeys = difference(consumed.sourceLineageKeys, withdrawn.sourceLineageKeys);
  const reasons = unique([
    ...(inboundMerges.length ? ['intervening-inbound-same-material-merge'] : []),
    ...(extraConsumedSourceEventIds.length ? ['consumed-source-event-spectrum-has-extra-sources'] : []),
    ...(extraConsumedSourceLineageKeys.length ? ['consumed-lineage-spectrum-has-extra-sources'] : []),
  ]);
  return {
    ambiguous: reasons.length > 0,
    reasons,
    inboundMerges,
    extraConsumedSourceEventIds,
    extraConsumedSourceLineageKeys,
  };
}

function unambiguousExactWithdrawalIngestLink(withdrawal, ingest, items) {
  return withdrawalIngestSourceIncluded(withdrawal, ingest)
    && !withdrawalIngestAmbiguity(withdrawal, ingest, items).ambiguous;
}

function selfTestAmbiguousMergeClassifier() {
  const withdrawal = {
    index: 0,
    event: {
      id: 'selftest-withdrawal', kind: 'action', status: 'completed', cause: 'survival-reflex',
      who: 'selftest-person', atMonth: 1, orderInMonth: 1,
      action: {
        kind: 'transfer', materialId: 21, quantity: 1, stackId: 'container-food',
        from: { kind: 'container', containerId: 'selftest-container' },
        to: { kind: 'person', personId: 'selftest-person' },
      },
      diff: {
        materialId: 21,
        sourceEventIds: ['selftest-origin', 'selftest-withdrawal'],
        sourceLineageKeys: ['container:selftest-container:container-food', 'harvest:selftest'],
      },
    },
  };
  const merge = {
    index: 1,
    event: {
      id: 'selftest-other-inbound', kind: 'action', status: 'completed', cause: 'intent',
      who: 'selftest-helper', atMonth: 1, orderInMonth: 2,
      action: {
        kind: 'transfer', materialId: 21, quantity: 1, stackId: 'helper-food',
        from: { kind: 'person', personId: 'selftest-helper' },
        to: { kind: 'person', personId: 'selftest-person' },
      },
      diff: { materialId: 21 },
    },
  };
  const cleanIngest = {
    index: 2,
    event: {
      id: 'selftest-clean-ingest', kind: 'action', status: 'completed', cause: 'survival-reflex',
      who: 'selftest-person', atMonth: 1, orderInMonth: 3,
      action: { kind: 'act', operation: 'ingest', targets: [{ kind: 'inventory-stack', personId: 'selftest-person', stackId: 'actor-food' }] },
      diff: {
        materialId: 21,
        consumedStackId: 'actor-food',
        consumedSourceEventIds: ['selftest-origin', 'selftest-withdrawal'],
        consumedSourceLineageKeys: ['container:selftest-container:container-food', 'harvest:selftest'],
      },
    },
  };
  const mergedIngest = {
    ...cleanIngest,
    event: {
      ...cleanIngest.event,
      id: 'selftest-merged-ingest',
      diff: {
        ...cleanIngest.event.diff,
        consumedSourceEventIds: ['selftest-origin', 'selftest-withdrawal', 'selftest-other-inbound'],
        consumedSourceLineageKeys: [
          'container:selftest-container:container-food', 'harvest:selftest', 'inventory:selftest-helper:helper-food',
        ],
      },
    },
  };
  assert.equal(unambiguousExactWithdrawalIngestLink(withdrawal, cleanIngest, [withdrawal, cleanIngest]), true);
  assert.equal(withdrawalIngestSourceIncluded(withdrawal, mergedIngest), true,
    'the old inclusion-only contract must expose the synthetic false positive');
  const ambiguity = withdrawalIngestAmbiguity(withdrawal, mergedIngest, [withdrawal, merge, mergedIngest]);
  assert.equal(ambiguity.ambiguous, true, 'withdraw→other inbound merge→ingest must not remain exact');
  assert.equal(unambiguousExactWithdrawalIngestLink(withdrawal, mergedIngest, [withdrawal, merge, mergedIngest]), false,
    'ambiguous merged ingest must be excluded from the exact numerator');
  assert.deepEqual(ambiguity.inboundMerges.map((item) => item.event.id), ['selftest-other-inbound']);
  assert.ok(ambiguity.extraConsumedSourceLineageKeys.includes('inventory:selftest-helper:helper-food'));

  const caregiverRelay = {
    index: 1,
    event: {
      id: 'selftest-caregiver-relay', kind: 'action', status: 'completed', cause: 'survival-reflex',
      who: 'selftest-person', atMonth: 1, orderInMonth: 2,
      action: {
        kind: 'transfer', materialId: 21, quantity: 1, stackId: 'actor-food',
        from: { kind: 'person', personId: 'selftest-person' },
        to: { kind: 'person', personId: 'selftest-child' },
      },
      diff: {
        materialId: 21,
        sourceEventIds: ['selftest-origin', 'selftest-withdrawal'],
        sourceLineageKeys: ['container:selftest-container:container-food', 'harvest:selftest'],
      },
    },
  };
  const childIngest = {
    index: 2,
    event: {
      id: 'selftest-child-ingest', kind: 'action', status: 'completed', cause: 'survival-reflex',
      who: 'selftest-child', atMonth: 1, orderInMonth: 3,
      action: { kind: 'act', operation: 'ingest', targets: [{ kind: 'inventory-stack', personId: 'selftest-child', stackId: 'child-food' }] },
      diff: {
        materialId: 21,
        consumedStackId: 'child-food',
        consumedSourceEventIds: ['selftest-origin', 'selftest-withdrawal', 'selftest-caregiver-relay'],
        consumedSourceLineageKeys: ['container:selftest-container:container-food', 'harvest:selftest'],
      },
    },
  };
  assert.equal(withdrawalRelaySourceIncluded(withdrawal, caregiverRelay), true,
    'caregiver relay must be proven by an actual person transfer containing the withdrawal source');
  assert.equal(withdrawalRelayAmbiguity(withdrawal, caregiverRelay, [withdrawal, caregiverRelay]).ambiguous, false);
  assert.equal(relayIngestSourceIncluded(caregiverRelay, childIngest), true);
  assert.equal(relayIngestAmbiguity(caregiverRelay, childIngest, [withdrawal, caregiverRelay, childIngest]).ambiguous, false,
    'clean caregiver withdrawal→person relay→child ingest must remain supported');

  const deposit = (id, actorId, lineageKey, orderInMonth) => ({
    index: -orderInMonth,
    event: {
      id, kind: 'action', status: 'completed', cause: 'intent', who: actorId,
      atMonth: 0, orderInMonth,
      action: {
        kind: 'transfer', materialId: 21, quantity: 1, stackId: `${actorId}-food`,
        from: { kind: 'person', personId: actorId },
        to: { kind: 'container', containerId: 'selftest-container' },
      },
      diff: {
        materialId: 21, quantity: 1,
        sourceEventIds: [`source:${id}`, id],
        sourceLineageKeys: [lineageKey],
      },
    },
  });
  const depositA = deposit('selftest-deposit-a', 'depositor-a', 'inventory:depositor-a:food', 1);
  const depositB = deposit('selftest-deposit-b', 'depositor-b', 'inventory:depositor-b:food', 2);
  const cleanDepositWithdrawal = {
    ...withdrawal,
    event: {
      ...withdrawal.event,
      diff: {
        ...withdrawal.event.diff,
        sourceEventIds: ['source:selftest-deposit-a', 'selftest-deposit-a', 'selftest-withdrawal'],
        sourceLineageKeys: ['inventory:depositor-a:food', 'container:selftest-container:container-food'],
      },
    },
  };
  const mergedDepositWithdrawal = {
    ...withdrawal,
    event: {
      ...withdrawal.event,
      diff: {
        ...withdrawal.event.diff,
        sourceEventIds: [
          'source:selftest-deposit-a', 'selftest-deposit-a',
          'source:selftest-deposit-b', 'selftest-deposit-b', 'selftest-withdrawal',
        ],
        sourceLineageKeys: [
          'inventory:depositor-a:food', 'inventory:depositor-b:food',
          'container:selftest-container:container-food',
        ],
      },
    },
  };
  const cleanAttribution = depositAttribution([depositA, depositB], cleanDepositWithdrawal);
  assert.equal(cleanAttribution.status, 'unique', 'one matching deposit is cleanly attributable');
  assert.deepEqual(cleanAttribution.matching.map((item) => item.event.id), ['selftest-deposit-a']);
  const mergedAttribution = depositAttribution([depositA, depositB], mergedDepositWithdrawal);
  assert.equal(mergedAttribution.status, 'ambiguous',
    'deposit A+B merged spectrum must remain ambiguous and be excluded from strict loops');
  assert.deepEqual(mergedAttribution.matching.map((item) => item.event.id),
    ['selftest-deposit-a', 'selftest-deposit-b']);

  const fixtureState = (events, people) => ({
    schemaVersion: 1,
    seed: 1,
    clock: { elapsedMonths: 1 },
    civilization: { status: 'active', outcome: null },
    intents: [],
    people,
    world: { past: events.map((item) => item.event) },
  });
  const caregiverAudit = auditRun(
    { runId: 'selftest-caregiver', seed: 1, years: 1, status: 'ended' },
    { state: fixtureState([withdrawal, caregiverRelay, childIngest], [
      { id: 'selftest-person', bornAtMonth: -240, geneticParents: [], body: { health: 80 } },
      { id: 'selftest-child', bornAtMonth: 0, geneticParents: ['selftest-person'], body: { health: 80 } },
    ]) },
  );
  assert.equal(caregiverAudit.metrics.selfSameSourceIngestWithin2Months.denominator, 0,
    'proven caregiver relay must not contaminate the self denominator');
  assert.equal(caregiverAudit.metrics.caregiverRelaySameSourceIngestWithin2Months.numerator, 1);
  assert.equal(caregiverAudit.metrics.caregiverRelaySameSourceIngestWithin2Months.denominator, 1);
  assert.equal(caregiverAudit.metrics.sameSourceIngestWithin2Months.numerator, 1);

  const mergedDepositIngest = {
    ...cleanIngest,
    event: {
      ...cleanIngest.event,
      id: 'selftest-merged-deposit-ingest',
      diff: {
        ...cleanIngest.event.diff,
        consumedSourceEventIds: [...mergedDepositWithdrawal.event.diff.sourceEventIds],
        consumedSourceLineageKeys: [...mergedDepositWithdrawal.event.diff.sourceLineageKeys],
      },
    },
  };
  const mergedDepositAudit = auditRun(
    { runId: 'selftest-merged-deposits', seed: 1, years: 1, status: 'ended' },
    { state: fixtureState([depositA, depositB, mergedDepositWithdrawal, mergedDepositIngest], [
      { id: 'selftest-person', bornAtMonth: -240, geneticParents: [], body: { health: 80 } },
      { id: 'depositor-a', bornAtMonth: -240, geneticParents: [], body: { health: 80 } },
      { id: 'depositor-b', bornAtMonth: -240, geneticParents: [], body: { health: 80 } },
    ]) },
  );
  assert.equal(mergedDepositAudit.metrics.sameSourceIngestWithin2Months.numerator, 1,
    'merged deposits do not invalidate the later withdrawal→ingest chain itself');
  assert.equal(mergedDepositAudit.metrics.strictDepositSurvivalWithdrawIngestLoops.numerator, 0,
    'multiple deposit sources must be excluded from strict loops');
  assert.equal(mergedDepositAudit.metrics.ambiguousMergedDeposits.knownValue, 1);
}

function exactDepositWithdrawalLink(deposit, withdrawal) {
  const depositDiff = asObject(deposit.event.diff) ?? {};
  const withdrawalDiff = asObject(withdrawal.event.diff) ?? {};
  const deposited = sourceContract(depositDiff);
  const withdrawn = sourceContract(withdrawalDiff);
  return deposited.supported
    && withdrawn.supported
    && withdrawn.sourceEventIds.includes(deposit.event.id)
    && isSubset(deposited.sourceLineageKeys, withdrawn.sourceLineageKeys);
}

function matchingDepositSources(candidates, withdrawal) {
  return candidates.filter((candidate) => exactDepositWithdrawalLink(candidate, withdrawal));
}

function depositAttribution(candidates, withdrawal) {
  const matching = matchingDepositSources(candidates, withdrawal);
  return {
    status: matching.length > 1 ? 'ambiguous' : matching.length === 1 ? 'unique' : 'none',
    matching,
  };
}

function transferEvidence(item, extra = {}) {
  const event = item.event;
  const action = asObject(event.action) ?? {};
  const diff = asObject(event.diff) ?? {};
  const from = asObject(action.from) ?? {};
  const to = asObject(action.to) ?? {};
  const source = sourceContract(diff);
  return {
    eventId: stringValue(event.id),
    actorId: stringValue(event.who),
    intentId: stringValue(event.intentId),
    cause: stringValue(event.cause),
    atMonth: integerValue(event.atMonth),
    orderInMonth: integerValue(event.orderInMonth),
    containerId: stringValue(from.kind === 'container' ? from.containerId : to.containerId),
    stackId: stringValue(action.stackId),
    materialId: finiteValue(action.materialId),
    material: EDIBLE_MATERIALS.get(finiteValue(action.materialId)) ?? null,
    quantity: finiteValue(diff.quantity) ?? finiteValue(action.quantity),
    sourceEventIds: source.sourceEventIds,
    sourceLineageKeys: source.sourceLineageKeys,
    sourceContractSupported: source.supported,
    ...extra,
  };
}

function countMetric(value, supportedObservations, unsupportedObservations, evidence, options = {}) {
  const status = unsupportedObservations > 0
    ? supportedObservations > 0 ? 'partial' : 'unsupported'
    : 'supported';
  return {
    status,
    value: status === 'unsupported' ? null : value,
    knownValue: status === 'unsupported' ? null : value,
    supportedObservations,
    unsupportedObservations,
    reasonCodes: unique(options.reasonCodes ?? []),
    evidenceEventIds: unique(evidence.flatMap((item) => [item.eventId, item.withdrawalEventId, item.ingestEventId, item.depositEventId]).filter(Boolean)),
    evidence,
    ...(options.denominator !== undefined ? { denominator: options.denominator } : {}),
    ...(options.note ? { note: options.note } : {}),
    ...(options.categories ? { categories: options.categories } : {}),
  };
}

function denominatorCountMetric(value, denominator, supportedObservations, unsupportedObservations, evidence, options = {}) {
  if (denominator > 0) {
    return {
      ...countMetric(value, supportedObservations, unsupportedObservations, evidence, { ...options, denominator }),
      coverage: percentage(supportedObservations, denominator),
      coverageUnit: 'percent',
    };
  }
  return {
    status: 'unsupported',
    value: null,
    knownValue: null,
    supportedObservations: 0,
    unsupportedObservations: 0,
    reasonCodes: ['zero-denominator'],
    evidenceEventIds: [],
    evidence: [],
    denominator: 0,
    coverage: null,
    coverageUnit: 'percent',
    note: options.zeroNote ?? '分母为 0；该链式计数 unsupported，不把未发生观察解释为已通过',
  };
}

function rateMetric(numerator, denominator, supportedObservations, unsupportedObservations, evidence, options = {}) {
  if (denominator === 0) {
    return {
      status: 'unsupported',
      value: null,
      numerator: 0,
      denominator: 0,
      rate: null,
      knownRate: null,
      supportedObservations: 0,
      unsupportedObservations: 0,
      coverage: null,
      reasonCodes: ['zero-denominator'],
      evidenceEventIds: [],
      evidence: [],
      unit: 'percent',
      coverageUnit: 'percent',
      note: options.zeroNote ?? '分母为 0；不把未发生观察解释为 100%',
      ...(options.categories ? { categories: options.categories } : {}),
    };
  }
  const status = unsupportedObservations > 0
    ? supportedObservations > 0 ? 'partial' : 'unsupported'
    : 'supported';
  const knownRate = percentage(numerator, supportedObservations);
  const rate = status === 'supported' ? percentage(numerator, denominator) : null;
  return {
    status,
    value: rate,
    numerator,
    denominator,
    rate,
    knownRate,
    supportedObservations,
    unsupportedObservations,
    coverage: percentage(supportedObservations, denominator),
    reasonCodes: unique(options.reasonCodes ?? []),
    evidenceEventIds: unique(evidence.flatMap((item) => [item.eventId, item.withdrawalEventId, item.ingestEventId, item.depositEventId]).filter(Boolean)),
    evidence,
    unit: 'percent',
    coverageUnit: 'percent',
    ...(options.note ? { note: options.note } : {}),
    ...(options.categories ? { categories: options.categories } : {}),
  };
}

function candidateIngestsAfter(withdrawal, ingests) {
  const withdrawalMonth = finiteValue(withdrawal.event.atMonth) ?? 0;
  const materialId = finiteValue(asObject(withdrawal.event.action)?.materialId);
  return ingests.filter((ingest) => stringValue(ingest.event.who) === stringValue(withdrawal.event.who)
    && finiteValue(asObject(ingest.event.diff)?.materialId) === materialId
    && eventOrder(ingest, withdrawal) > 0
    && (finiteValue(ingest.event.atMonth) ?? 0) - withdrawalMonth <= MAX_INGEST_DELAY_MONTHS);
}

function candidateRelaysAfter(withdrawal, relays) {
  const withdrawalMonth = finiteValue(withdrawal.event.atMonth) ?? 0;
  const actorId = stringValue(withdrawal.event.who);
  const materialId = finiteValue(asObject(withdrawal.event.action)?.materialId);
  return relays.filter((relay) => {
    const action = asObject(relay.event.action) ?? {};
    return stringValue(relay.event.who) === actorId
      && stringValue(asObject(action.from)?.personId) === actorId
      && finiteValue(action.materialId) === materialId
      && eventOrder(relay, withdrawal) > 0
      && (finiteValue(relay.event.atMonth) ?? 0) - withdrawalMonth <= MAX_INGEST_DELAY_MONTHS;
  });
}

function candidateRelayIngests(withdrawal, relay, ingests) {
  const withdrawalMonth = finiteValue(withdrawal.event.atMonth) ?? 0;
  const relayAction = asObject(relay.event.action) ?? {};
  const childId = stringValue(asObject(relayAction.to)?.personId);
  const materialId = finiteValue(relayAction.materialId);
  return ingests.filter((ingest) => stringValue(ingest.event.who) === childId
    && finiteValue(asObject(ingest.event.diff)?.materialId) === materialId
    && eventOrder(ingest, relay) > 0
    && (finiteValue(ingest.event.atMonth) ?? 0) - withdrawalMonth <= MAX_INGEST_DELAY_MONTHS);
}

function relayCareBasis(relay, personById, intentById) {
  const event = relay.event;
  const action = asObject(event.action) ?? {};
  const caregiverId = stringValue(event.who);
  const dependentId = stringValue(asObject(action.to)?.personId);
  const dependent = personById.get(dependentId);
  const intent = intentById.get(stringValue(event.intentId));
  const geneticParent = Boolean(caregiverId && asArray(dependent?.geneticParents).includes(caregiverId));
  const dependentCareIntent = intent?.interruptionKind === 'dependent-care';
  return {
    caregiverId,
    dependentId,
    geneticParent,
    dependentCareIntent,
    basis: geneticParent
      ? 'genetic-parent-and-completed-person-transfer'
      : dependentCareIntent
        ? 'dependent-care-intent-and-completed-person-transfer'
        : 'completed-person-transfer-only',
  };
}

function auditAuxiliary(state, matrixRun, items, eventById) {
  const actionItems = items.filter((item) => item.event.kind === 'action');
  const completed = actionItems.filter(completedAction);
  const movementActions = actionItems.filter((item) => asObject(item.event.action)?.kind === 'move'
    && asArray(item.event.pathSegment).length > 1).length;
  const deathItems = items.filter((item) => item.event.kind === 'environment' && item.event.change === 'death');
  const childDeaths = deathItems.filter((item) => {
    const ageMonths = finiteValue(asObject(item.event.diff)?.ageMonths);
    return ageMonths !== null && ageMonths < 12 * 12;
  });
  const exposureDeaths = deathItems.filter((item) => strings(asObject(item.event.diff)?.sourceEventIds).some((sourceId) => {
    const source = eventById.get(sourceId)?.event;
    const condition = asObject(source?.diff)?.condition;
    return source?.kind === 'environment' && (condition === 'cold' || condition === 'heat');
  }));
  const living = asArray(state.people).filter((person) => person.diedAtMonth === undefined && finiteValue(person.body?.health) > 0).length;
  const storageCompletedActions = completed.filter(completedContainerTransfer).length;
  const storageCompletedActionShare = percentage(storageCompletedActions, completed.length);
  const matrixChecks = {
    finalPopulation: { matrix: finiteValue(matrixRun.finalPopulation), state: living },
    deaths: { matrix: finiteValue(matrixRun.deaths), state: deathItems.length },
    childDeaths: { matrix: finiteValue(matrixRun.childDeaths), state: childDeaths.length },
    childExposureDeaths: {
      matrix: finiteValue(matrixRun.childExposureDeaths),
      state: exposureDeaths.filter((item) => {
        const ageMonths = finiteValue(asObject(item.event.diff)?.ageMonths);
        return ageMonths !== null && ageMonths < 12 * 12;
      }).length,
    },
    movementActions: { matrix: finiteValue(matrixRun.movementActions), state: movementActions },
    movementActionShare: { matrix: finiteValue(matrixRun.movementActionShare), state: percentage(movementActions, actionItems.length) },
    throughMonth: { matrix: finiteValue(matrixRun.throughMonth), state: finiteValue(state.clock?.elapsedMonths) },
  };
  for (const check of Object.values(matrixChecks)) {
    check.agrees = check.matrix === null ? null : check.matrix === check.state;
  }
  return {
    throughMonth: finiteValue(state.clock?.elapsedMonths),
    population: {
      living,
      totalHistoricalPeople: asArray(state.people).length,
      initial: finiteValue(matrixRun.initialPopulation),
    },
    deaths: deathItems.length,
    childDeaths: childDeaths.length,
    exposureDeaths: exposureDeaths.length,
    childExposureDeaths: exposureDeaths.filter((item) => {
      const ageMonths = finiteValue(asObject(item.event.diff)?.ageMonths);
      return ageMonths !== null && ageMonths < 12 * 12;
    }).length,
    movementActions,
    movementActionShare: percentage(movementActions, actionItems.length),
    movementActionShareUnit: 'percent-of-all-action-facts',
    completedActions: completed.length,
    storageCompletedActions,
    storageCompletedActionShare,
    storageCompletedActionShareStatus: completed.length ? 'supported' : 'unsupported',
    storageCompletedActionShareUnit: 'percent-of-completed-actions',
    matrixChecks,
  };
}

function auditRun(matrixRun, persisted) {
  const state = persisted.state;
  const items = asArray(state.world?.past).map((event, index) => ({ event, index })).sort(eventOrder);
  const eventById = new Map(items.flatMap((item) => stringValue(item.event.id) ? [[item.event.id, item]] : []));
  const intentById = new Map(asArray(state.intents).flatMap((intent) => stringValue(intent.id) ? [[intent.id, intent]] : []));
  const personById = new Map(asArray(state.people).flatMap((person) => stringValue(person.id) ? [[person.id, person]] : []));
  const deposits = items.filter(completedEdibleDeposit);
  const ingests = items.filter(completedInventoryEdibleIngest);
  const personRelays = items.filter(completedPersonEdibleTransfer);
  const storedWithdrawals = items.filter(completedStoredEdibleWithdrawal);
  const survivalWithdrawals = storedWithdrawals.filter((item) => item.event.cause === 'survival-reflex');

  const ordinaryEvidence = [];
  const projectLogisticsEvidence = [];
  const unresolvedOrdinaryEvidence = [];
  for (const item of storedWithdrawals.filter((candidate) => candidate.event.cause === 'intent')) {
    const intent = intentById.get(stringValue(item.event.intentId));
    if (!intent) {
      unresolvedOrdinaryEvidence.push(transferEvidence(item, { classification: 'unresolved-intent' }));
    } else if (stringValue(intent.projectId)) {
      projectLogisticsEvidence.push(transferEvidence(item, { classification: 'project-logistics', projectId: intent.projectId }));
    } else {
      ordinaryEvidence.push(transferEvidence(item, { classification: 'ordinary-intent' }));
    }
  }

  const exactMatches = [];
  const ambiguousMergedIngests = [];
  const mismatches = [];
  const supportedNoIngest = [];
  const unsupportedChains = [];
  const caregiverRelayAssignments = [];
  const caregiverRelaySuccesses = [];
  const caregiverRelayAmbiguities = [];
  const caregiverRelayFailures = [];
  const caregiverRelayUnsupported = [];
  const claimedIngestEventIds = new Set();
  const claimedRelayEventIds = new Set();
  // Prefer the most recent eligible withdrawal when merged inventory lineage
  // lets one ingest mention more than one earlier transfer. One consumed unit
  // may close at most one withdrawal observation.
  for (const withdrawal of [...survivalWithdrawals].reverse()) {
    const withdrawalDiff = asObject(withdrawal.event.diff) ?? {};
    const withdrawalSource = sourceContract(withdrawalDiff);
    const candidates = candidateIngestsAfter(withdrawal, ingests)
      .filter((ingest) => !claimedIngestEventIds.has(ingest.event.id));
    const sourceIncludedCandidates = candidates.filter((ingest) => withdrawalIngestSourceIncluded(withdrawal, ingest));
    const relayCandidates = candidateRelaysAfter(withdrawal, personRelays)
      .filter((relay) => !claimedRelayEventIds.has(relay.event.id));
    const sourceIncludedRelays = relayCandidates.filter((relay) => withdrawalRelaySourceIncluded(withdrawal, relay));
    const firstSelfUse = sourceIncludedCandidates[0];
    const firstRelayUse = sourceIncludedRelays[0];
    const useCaregiverRelay = Boolean(firstRelayUse
      && (!firstSelfUse || eventOrder(firstRelayUse, firstSelfUse) < 0));

    if (useCaregiverRelay) {
      const relay = firstRelayUse;
      claimedRelayEventIds.add(relay.event.id);
      const careBasis = relayCareBasis(relay, personById, intentById);
      const relayAmbiguity = withdrawalRelayAmbiguity(withdrawal, relay, items);
      const childCandidates = candidateRelayIngests(withdrawal, relay, ingests)
        .filter((ingest) => !claimedIngestEventIds.has(ingest.event.id));
      const childSourceIncluded = childCandidates.filter((ingest) => relayIngestSourceIncluded(relay, ingest));
      const cleanChildIngest = childSourceIncluded.find((ingest) => !relayIngestAmbiguity(relay, ingest, items).ambiguous);
      const assignment = { withdrawal, relay, careBasis };
      caregiverRelayAssignments.push(assignment);
      if (cleanChildIngest && !relayAmbiguity.ambiguous) {
        claimedIngestEventIds.add(cleanChildIngest.event.id);
        caregiverRelaySuccesses.push({ ...assignment, ingest: cleanChildIngest });
        continue;
      }
      const ambiguousChildIngest = childSourceIncluded[0];
      if (relayAmbiguity.ambiguous || ambiguousChildIngest) {
        if (ambiguousChildIngest) claimedIngestEventIds.add(ambiguousChildIngest.event.id);
        caregiverRelayAmbiguities.push({
          ...assignment,
          ingest: ambiguousChildIngest ?? null,
          relayAmbiguity,
          ingestAmbiguity: ambiguousChildIngest
            ? relayIngestAmbiguity(relay, ambiguousChildIngest, items)
            : null,
        });
        continue;
      }
      const incompleteChildCandidates = childCandidates.filter((ingest) => {
        const diff = asObject(ingest.event.diff) ?? {};
        return !(sourceContract(diff, 'consumed').supported && Boolean(stringValue(diff.consumedStackId)));
      });
      if (!withdrawalSource.supported
        || !sourceContract(asObject(relay.event.diff) ?? {}).supported
        || incompleteChildCandidates.length > 0) {
        caregiverRelayUnsupported.push({
          ...assignment,
          candidates: incompleteChildCandidates,
          reasons: unique([
            ...(!withdrawalSource.supported ? ['withdrawal-missing-source-contract'] : []),
            ...(!sourceContract(asObject(relay.event.diff) ?? {}).supported ? ['relay-missing-source-contract'] : []),
            ...(incompleteChildCandidates.length ? ['dependent-ingest-missing-consumed-source-contract'] : []),
          ]),
        });
      } else {
        caregiverRelayFailures.push({
          ...assignment,
          ingest: childCandidates[0] ?? null,
          reason: childCandidates.length
            ? 'dependent-ingest-source-does-not-contain-relay'
            : 'no-dependent-ingest-within-window',
        });
      }
      continue;
    }

    const exact = sourceIncludedCandidates.find((ingest) => unambiguousExactWithdrawalIngestLink(withdrawal, ingest, items));
    if (exact) {
      exactMatches.push({ withdrawal, ingest: exact });
      claimedIngestEventIds.add(exact.event.id);
      continue;
    }
    const ambiguous = sourceIncludedCandidates[0];
    if (ambiguous) {
      ambiguousMergedIngests.push({
        withdrawal,
        ingest: ambiguous,
        ambiguity: withdrawalIngestAmbiguity(withdrawal, ambiguous, items),
      });
      claimedIngestEventIds.add(ambiguous.event.id);
      continue;
    }
    const incompleteCandidates = candidates.filter((ingest) => {
      const diff = asObject(ingest.event.diff) ?? {};
      return !(sourceContract(diff, 'consumed').supported && Boolean(stringValue(diff.consumedStackId)));
    });
    if (!withdrawalSource.supported || incompleteCandidates.length > 0) {
      unsupportedChains.push({
        withdrawal,
        candidates: incompleteCandidates,
        reasons: unique([
          ...(!withdrawalSource.supported ? ['withdrawal-missing-source-contract'] : []),
          ...(incompleteCandidates.length ? ['candidate-ingest-missing-consumed-source-contract'] : []),
        ]),
      });
    } else if (candidates.length > 0) {
      mismatches.push({ withdrawal, ingest: candidates[0] });
    } else {
      supportedNoIngest.push(withdrawal);
    }
  }
  exactMatches.sort((left, right) => eventOrder(left.withdrawal, right.withdrawal));
  ambiguousMergedIngests.sort((left, right) => eventOrder(left.withdrawal, right.withdrawal));
  mismatches.sort((left, right) => eventOrder(left.withdrawal, right.withdrawal));
  supportedNoIngest.sort(eventOrder);
  unsupportedChains.sort((left, right) => eventOrder(left.withdrawal, right.withdrawal));
  caregiverRelayAssignments.sort((left, right) => eventOrder(left.withdrawal, right.withdrawal));
  caregiverRelaySuccesses.sort((left, right) => eventOrder(left.withdrawal, right.withdrawal));
  caregiverRelayAmbiguities.sort((left, right) => eventOrder(left.withdrawal, right.withdrawal));
  caregiverRelayFailures.sort((left, right) => eventOrder(left.withdrawal, right.withdrawal));
  caregiverRelayUnsupported.sort((left, right) => eventOrder(left.withdrawal, right.withdrawal));

  const exactEvidence = exactMatches.map(({ withdrawal, ingest }) => ({
    chainType: 'self',
    withdrawalEventId: stringValue(withdrawal.event.id),
    ingestEventId: stringValue(ingest.event.id),
    actorId: stringValue(withdrawal.event.who),
    containerId: stringValue(asObject(asObject(withdrawal.event.action)?.from)?.containerId),
    withdrawalStackId: stringValue(asObject(withdrawal.event.action)?.stackId),
    consumedStackId: stringValue(asObject(ingest.event.diff)?.consumedStackId),
    materialId: finiteValue(asObject(withdrawal.event.action)?.materialId),
    withdrawalAtMonth: integerValue(withdrawal.event.atMonth),
    ingestAtMonth: integerValue(ingest.event.atMonth),
    delayMonths: (integerValue(ingest.event.atMonth) ?? 0) - (integerValue(withdrawal.event.atMonth) ?? 0),
    withdrawalSourceEventIds: sourceContract(asObject(withdrawal.event.diff) ?? {}).sourceEventIds,
    withdrawalSourceLineageKeys: sourceContract(asObject(withdrawal.event.diff) ?? {}).sourceLineageKeys,
    consumedSourceEventIds: sourceContract(asObject(ingest.event.diff) ?? {}, 'consumed').sourceEventIds,
    consumedSourceLineageKeys: sourceContract(asObject(ingest.event.diff) ?? {}, 'consumed').sourceLineageKeys,
  }));
  const caregiverRelaySuccessEvidence = caregiverRelaySuccesses.map(({ withdrawal, relay, ingest, careBasis }) => ({
    chainType: 'caregiver-relay',
    withdrawalEventId: stringValue(withdrawal.event.id),
    relayTransferEventId: stringValue(relay.event.id),
    ingestEventId: stringValue(ingest.event.id),
    caregiverId: careBasis.caregiverId,
    dependentId: careBasis.dependentId,
    careBasis: careBasis.basis,
    geneticParent: careBasis.geneticParent,
    dependentCareIntent: careBasis.dependentCareIntent,
    containerId: stringValue(asObject(asObject(withdrawal.event.action)?.from)?.containerId),
    withdrawalStackId: stringValue(asObject(withdrawal.event.action)?.stackId),
    relayStackId: stringValue(asObject(relay.event.action)?.stackId),
    consumedStackId: stringValue(asObject(ingest.event.diff)?.consumedStackId),
    materialId: finiteValue(asObject(withdrawal.event.action)?.materialId),
    withdrawalAtMonth: integerValue(withdrawal.event.atMonth),
    relayAtMonth: integerValue(relay.event.atMonth),
    ingestAtMonth: integerValue(ingest.event.atMonth),
    withdrawalSourceEventIds: sourceContract(asObject(withdrawal.event.diff) ?? {}).sourceEventIds,
    relaySourceEventIds: sourceContract(asObject(relay.event.diff) ?? {}).sourceEventIds,
    consumedSourceEventIds: sourceContract(asObject(ingest.event.diff) ?? {}, 'consumed').sourceEventIds,
    withdrawalSourceLineageKeys: sourceContract(asObject(withdrawal.event.diff) ?? {}).sourceLineageKeys,
    relaySourceLineageKeys: sourceContract(asObject(relay.event.diff) ?? {}).sourceLineageKeys,
    consumedSourceLineageKeys: sourceContract(asObject(ingest.event.diff) ?? {}, 'consumed').sourceLineageKeys,
  }));
  const caregiverRelayAmbiguityEvidence = caregiverRelayAmbiguities.map((item) => ({
    chainType: 'caregiver-relay',
    withdrawalEventId: stringValue(item.withdrawal.event.id),
    relayTransferEventId: stringValue(item.relay.event.id),
    ingestEventId: stringValue(item.ingest?.event.id),
    caregiverId: item.careBasis.caregiverId,
    dependentId: item.careBasis.dependentId,
    careBasis: item.careBasis.basis,
    containerId: stringValue(asObject(asObject(item.withdrawal.event.action)?.from)?.containerId),
    materialId: finiteValue(asObject(item.withdrawal.event.action)?.materialId),
    withdrawalAtMonth: integerValue(item.withdrawal.event.atMonth),
    relayAtMonth: integerValue(item.relay.event.atMonth),
    ingestAtMonth: integerValue(item.ingest?.event.atMonth),
    reasons: unique([
      ...item.relayAmbiguity.reasons,
      ...(item.ingestAmbiguity?.reasons ?? []),
    ]),
    interveningInboundMergeEventIds: unique([
      ...item.relayAmbiguity.inboundMerges.map((merge) => stringValue(merge.event.id)),
      ...(item.ingestAmbiguity?.inboundMerges ?? []).map((merge) => stringValue(merge.event.id)),
    ]),
    relayExtraSourceEventIds: item.relayAmbiguity.extraSourceEventIds,
    relayExtraSourceLineageKeys: item.relayAmbiguity.extraSourceLineageKeys,
    dependentExtraConsumedSourceEventIds: item.ingestAmbiguity?.extraConsumedSourceEventIds ?? [],
    dependentExtraConsumedSourceLineageKeys: item.ingestAmbiguity?.extraConsumedSourceLineageKeys ?? [],
  }));
  const caregiverRelayFailureEvidence = caregiverRelayFailures.map((item) => ({
    chainType: 'caregiver-relay',
    withdrawalEventId: stringValue(item.withdrawal.event.id),
    relayTransferEventId: stringValue(item.relay.event.id),
    ingestEventId: stringValue(item.ingest?.event.id),
    caregiverId: item.careBasis.caregiverId,
    dependentId: item.careBasis.dependentId,
    careBasis: item.careBasis.basis,
    containerId: stringValue(asObject(asObject(item.withdrawal.event.action)?.from)?.containerId),
    materialId: finiteValue(asObject(item.withdrawal.event.action)?.materialId),
    withdrawalAtMonth: integerValue(item.withdrawal.event.atMonth),
    relayAtMonth: integerValue(item.relay.event.atMonth),
    ingestAtMonth: integerValue(item.ingest?.event.atMonth),
    reason: item.reason,
  }));
  const caregiverRelayUnsupportedEvidence = caregiverRelayUnsupported.map((item) => ({
    chainType: 'caregiver-relay',
    withdrawalEventId: stringValue(item.withdrawal.event.id),
    relayTransferEventId: stringValue(item.relay.event.id),
    caregiverId: item.careBasis.caregiverId,
    dependentId: item.careBasis.dependentId,
    careBasis: item.careBasis.basis,
    containerId: stringValue(asObject(asObject(item.withdrawal.event.action)?.from)?.containerId),
    materialId: finiteValue(asObject(item.withdrawal.event.action)?.materialId),
    atMonth: integerValue(item.withdrawal.event.atMonth),
    candidateIngestEventIds: item.candidates.map((candidate) => stringValue(candidate.event.id)).filter(Boolean),
    reasons: item.reasons,
  }));
  const mismatchEvidence = mismatches.map(({ withdrawal, ingest }) => ({
    withdrawalEventId: stringValue(withdrawal.event.id),
    ingestEventId: stringValue(ingest.event.id),
    actorId: stringValue(withdrawal.event.who),
    containerId: stringValue(asObject(asObject(withdrawal.event.action)?.from)?.containerId),
    stackId: stringValue(asObject(withdrawal.event.action)?.stackId),
    materialId: finiteValue(asObject(withdrawal.event.action)?.materialId),
    withdrawalAtMonth: integerValue(withdrawal.event.atMonth),
    ingestAtMonth: integerValue(ingest.event.atMonth),
    reason: 'same-person-material-window-but-source-contract-does-not-contain-withdrawal',
    withdrawalSourceLineageKeys: sourceContract(asObject(withdrawal.event.diff) ?? {}).sourceLineageKeys,
    consumedSourceLineageKeys: sourceContract(asObject(ingest.event.diff) ?? {}, 'consumed').sourceLineageKeys,
  }));
  const ambiguousMergedEvidence = ambiguousMergedIngests.map(({ withdrawal, ingest, ambiguity }) => ({
    withdrawalEventId: stringValue(withdrawal.event.id),
    ingestEventId: stringValue(ingest.event.id),
    actorId: stringValue(withdrawal.event.who),
    containerId: stringValue(asObject(asObject(withdrawal.event.action)?.from)?.containerId),
    withdrawalStackId: stringValue(asObject(withdrawal.event.action)?.stackId),
    consumedStackId: stringValue(asObject(ingest.event.diff)?.consumedStackId),
    materialId: finiteValue(asObject(withdrawal.event.action)?.materialId),
    withdrawalAtMonth: integerValue(withdrawal.event.atMonth),
    ingestAtMonth: integerValue(ingest.event.atMonth),
    reasons: ambiguity.reasons,
    interveningInboundMergeEventIds: ambiguity.inboundMerges.map((item) => stringValue(item.event.id)).filter(Boolean),
    extraConsumedSourceEventIds: ambiguity.extraConsumedSourceEventIds,
    extraConsumedSourceLineageKeys: ambiguity.extraConsumedSourceLineageKeys,
    withdrawalSourceEventIds: sourceContract(asObject(withdrawal.event.diff) ?? {}).sourceEventIds,
    withdrawalSourceLineageKeys: sourceContract(asObject(withdrawal.event.diff) ?? {}).sourceLineageKeys,
    consumedSourceEventIds: sourceContract(asObject(ingest.event.diff) ?? {}, 'consumed').sourceEventIds,
    consumedSourceLineageKeys: sourceContract(asObject(ingest.event.diff) ?? {}, 'consumed').sourceLineageKeys,
  }));
  const unsupportedEvidence = unsupportedChains.map(({ withdrawal, candidates, reasons }) => ({
    withdrawalEventId: stringValue(withdrawal.event.id),
    actorId: stringValue(withdrawal.event.who),
    containerId: stringValue(asObject(asObject(withdrawal.event.action)?.from)?.containerId),
    stackId: stringValue(asObject(withdrawal.event.action)?.stackId),
    materialId: finiteValue(asObject(withdrawal.event.action)?.materialId),
    atMonth: integerValue(withdrawal.event.atMonth),
    candidateIngestEventIds: candidates.map((candidate) => stringValue(candidate.event.id)).filter(Boolean),
    reasons,
  }));

  const strictLoops = [];
  const strictNoDeposit = [];
  const strictUnsupported = [];
  const ambiguousMergedDeposits = [];
  const successfulMatches = [
    ...exactMatches.map((match) => ({ ...match, chainType: 'self', relay: null })),
    ...caregiverRelaySuccesses.map((match) => ({ ...match, chainType: 'caregiver-relay' })),
  ].sort((left, right) => eventOrder(left.withdrawal, right.withdrawal));
  const remainingDepositUnits = new Map(deposits.map((deposit) => [
    deposit.event.id,
    Math.max(0, finiteValue(asObject(deposit.event.diff)?.quantity)
      ?? finiteValue(asObject(deposit.event.action)?.quantity)
      ?? 0),
  ]));
  for (const match of successfulMatches) {
    const withdrawalAction = asObject(match.withdrawal.event.action) ?? {};
    const containerId = stringValue(asObject(withdrawalAction.from)?.containerId);
    const materialId = finiteValue(withdrawalAction.materialId);
    const candidates = deposits.filter((deposit) => {
      const action = asObject(deposit.event.action) ?? {};
      return eventOrder(deposit, match.withdrawal) < 0
        && stringValue(asObject(action.to)?.containerId) === containerId
        && finiteValue(action.materialId) === materialId;
    });
    const attribution = depositAttribution(candidates, match.withdrawal);
    if (attribution.status === 'ambiguous') {
      ambiguousMergedDeposits.push({ ...match, deposits: attribution.matching });
      continue;
    }
    const deposit = [...attribution.matching].reverse().find((candidate) => (
      (remainingDepositUnits.get(candidate.event.id) ?? 0) > 0
    ));
    if (deposit) {
      strictLoops.push({ ...match, deposit });
      remainingDepositUnits.set(deposit.event.id, (remainingDepositUnits.get(deposit.event.id) ?? 0) - 1);
    } else if (candidates.some((candidate) => !sourceContract(asObject(candidate.event.diff) ?? {}).supported)) {
      strictUnsupported.push({ ...match, candidates });
    } else {
      strictNoDeposit.push(match);
    }
  }
  const strictEvidence = strictLoops.map(({ deposit, withdrawal, relay, ingest, chainType }) => ({
    chainType,
    depositEventId: stringValue(deposit.event.id),
    withdrawalEventId: stringValue(withdrawal.event.id),
    relayTransferEventId: stringValue(relay?.event.id),
    ingestEventId: stringValue(ingest.event.id),
    depositActorId: stringValue(deposit.event.who),
    withdrawalActorId: stringValue(withdrawal.event.who),
    containerId: stringValue(asObject(asObject(withdrawal.event.action)?.from)?.containerId),
    depositStackId: stringValue(asObject(deposit.event.action)?.stackId),
    withdrawalStackId: stringValue(asObject(withdrawal.event.action)?.stackId),
    consumedStackId: stringValue(asObject(ingest.event.diff)?.consumedStackId),
    materialId: finiteValue(asObject(withdrawal.event.action)?.materialId),
    depositAtMonth: integerValue(deposit.event.atMonth),
    withdrawalAtMonth: integerValue(withdrawal.event.atMonth),
    ingestAtMonth: integerValue(ingest.event.atMonth),
    depositSourceLineageKeys: sourceContract(asObject(deposit.event.diff) ?? {}).sourceLineageKeys,
    withdrawalSourceLineageKeys: sourceContract(asObject(withdrawal.event.diff) ?? {}).sourceLineageKeys,
    consumedSourceLineageKeys: sourceContract(asObject(ingest.event.diff) ?? {}, 'consumed').sourceLineageKeys,
  }));
  const ambiguousMergedDepositEvidence = ambiguousMergedDeposits.map(({ deposits: matching, withdrawal, relay, ingest, chainType }) => ({
    chainType,
    withdrawalEventId: stringValue(withdrawal.event.id),
    relayTransferEventId: stringValue(relay?.event.id),
    ingestEventId: stringValue(ingest.event.id),
    withdrawalActorId: stringValue(withdrawal.event.who),
    containerId: stringValue(asObject(asObject(withdrawal.event.action)?.from)?.containerId),
    materialId: finiteValue(asObject(withdrawal.event.action)?.materialId),
    withdrawalAtMonth: integerValue(withdrawal.event.atMonth),
    matchingDepositEventIds: matching.map((deposit) => stringValue(deposit.event.id)).filter(Boolean),
    deposits: matching.map((deposit) => ({
      eventId: stringValue(deposit.event.id),
      actorId: stringValue(deposit.event.who),
      stackId: stringValue(asObject(deposit.event.action)?.stackId),
      atMonth: integerValue(deposit.event.atMonth),
      quantity: finiteValue(asObject(deposit.event.diff)?.quantity) ?? finiteValue(asObject(deposit.event.action)?.quantity),
      sourceEventIds: sourceContract(asObject(deposit.event.diff) ?? {}).sourceEventIds,
      sourceLineageKeys: sourceContract(asObject(deposit.event.diff) ?? {}).sourceLineageKeys,
    })),
    withdrawalSourceEventIds: sourceContract(asObject(withdrawal.event.diff) ?? {}).sourceEventIds,
    withdrawalSourceLineageKeys: sourceContract(asObject(withdrawal.event.diff) ?? {}).sourceLineageKeys,
    reason: 'withdrawal-spectrum-contains-multiple-matching-deposit-events',
  }));

  const selfDenominator = survivalWithdrawals.length - caregiverRelayAssignments.length;
  const selfSupported = exactMatches.length + mismatches.length + supportedNoIngest.length;
  const selfUnsupported = unsupportedChains.length + ambiguousMergedIngests.length;
  const caregiverSourceMismatches = caregiverRelayFailures.filter((item) => Boolean(item.ingest));
  const caregiverSupported = caregiverRelaySuccesses.length + caregiverRelayFailures.length;
  const caregiverUnsupported = caregiverRelayAmbiguities.length + caregiverRelayUnsupported.length;
  const chainSupported = selfSupported + caregiverSupported;
  const chainUnsupported = selfUnsupported + caregiverUnsupported;
  const totalSuccesses = exactMatches.length + caregiverRelaySuccesses.length;
  const totalSourceMismatches = mismatches.length + caregiverSourceMismatches.length;
  const totalAmbiguousIngests = ambiguousMergedIngests.length + caregiverRelayAmbiguities.length;
  const allSuccessEvidence = [...exactEvidence, ...caregiverRelaySuccessEvidence];
  const allMismatchEvidence = [...mismatchEvidence, ...caregiverRelayFailureEvidence.filter((item) => Boolean(item.ingestEventId))];
  const allAmbiguousIngestEvidence = [...ambiguousMergedEvidence, ...caregiverRelayAmbiguityEvidence];
  const caregiverWithdrawalIds = new Set(caregiverRelayAssignments.map((item) => item.withdrawal.event.id));
  const classifiedSurvivalWithdrawalEvidence = survivalWithdrawals.map((item) => transferEvidence(item, {
    chainType: caregiverWithdrawalIds.has(item.event.id) ? 'caregiver-relay' : 'self',
  }));
  const allChainReasonCodes = [
    ...unsupportedChains.flatMap((item) => item.reasons),
    ...ambiguousMergedIngests.flatMap((item) => item.ambiguity.reasons),
    ...caregiverRelayUnsupported.flatMap((item) => item.reasons),
    ...caregiverRelayAmbiguities.flatMap((item) => [
      ...item.relayAmbiguity.reasons,
      ...(item.ingestAmbiguity?.reasons ?? []),
    ]),
  ];
  const auxiliary = auditAuxiliary(state, matrixRun, items, eventById);
  const metrics = {
    ordinaryIntentEdibleWithdrawals: countMetric(
      ordinaryEvidence.length,
      ordinaryEvidence.length + projectLogisticsEvidence.length,
      unresolvedOrdinaryEvidence.length,
      ordinaryEvidence,
      {
        denominator: ordinaryEvidence.length + projectLogisticsEvidence.length + unresolvedOrdinaryEvidence.length,
        reasonCodes: unresolvedOrdinaryEvidence.length ? ['intent-not-retained-so-project-classification-unknown'] : [],
        categories: {
          ordinaryIntent: ordinaryEvidence.length,
          excludedProjectLogistics: projectLogisticsEvidence.length,
          unresolvedIntent: unresolvedOrdinaryEvidence.length,
        },
        note: '仅统计 cause=intent、container→同一 actor、且可解析 intent 无 projectId 的 edible transfer；项目物流不混入',
      },
    ),
    survivalStoredFoodWithdrawals: countMetric(
      survivalWithdrawals.length,
      survivalWithdrawals.length,
      0,
      classifiedSurvivalWithdrawalEvidence,
      { note: '完成的 cause=survival-reflex、container→同一 actor 的 edible transfer；按实际后继 person relay 分成 self/caregiver-relay' },
    ),
    sameSourceIngestWithin2Months: rateMetric(
      totalSuccesses,
      survivalWithdrawals.length,
      chainSupported,
      chainUnsupported,
      allSuccessEvidence,
      {
        reasonCodes: allChainReasonCodes,
        categories: {
          selfDenominator,
          selfSuccesses: exactMatches.length,
          caregiverRelayDenominator: caregiverRelayAssignments.length,
          caregiverRelaySuccesses: caregiverRelaySuccesses.length,
          sourceMismatches: totalSourceMismatches,
          noIngestWithinWindow: supportedNoIngest.length
            + caregiverRelayFailures.filter((item) => !item.ingest).length,
          unsupported: unsupportedChains.length + caregiverRelayUnsupported.length,
          ambiguousMergedIngests: totalAmbiguousIngests,
        },
        note: '汇总 self 与 caregiver relay；后者必须有 completed caregiver→dependent person transfer，且 withdrawal→relay→child ingest 两段来源谱均可回放；歧义不进入成功或 mismatch',
        zeroNote: '没有 survival stored-food withdrawal，链成功率 unsupported；不得报告为 100%',
      },
    ),
    selfSameSourceIngestWithin2Months: rateMetric(
      exactMatches.length,
      selfDenominator,
      selfSupported,
      selfUnsupported,
      exactEvidence,
      {
        reasonCodes: [
          ...unsupportedChains.flatMap((item) => item.reasons),
          ...ambiguousMergedIngests.flatMap((item) => item.ambiguity.reasons),
        ],
        categories: {
          successes: exactMatches.length,
          sourceMismatches: mismatches.length,
          noIngestWithinWindow: supportedNoIngest.length,
          ambiguous: ambiguousMergedIngests.length,
          unsupported: unsupportedChains.length,
        },
        note: 'withdrawal actor 本人摄入；已由实际 person relay 证明交给 dependent 的 withdrawal 不混入 self 分母',
        zeroNote: '没有 self stored-food withdrawal，self chain 分母为 0，unsupported',
      },
    ),
    caregiverRelaySameSourceIngestWithin2Months: rateMetric(
      caregiverRelaySuccesses.length,
      caregiverRelayAssignments.length,
      caregiverSupported,
      caregiverUnsupported,
      caregiverRelaySuccessEvidence,
      {
        reasonCodes: [
          ...caregiverRelayUnsupported.flatMap((item) => item.reasons),
          ...caregiverRelayAmbiguities.flatMap((item) => [
            ...item.relayAmbiguity.reasons,
            ...(item.ingestAmbiguity?.reasons ?? []),
          ]),
        ],
        categories: {
          successes: caregiverRelaySuccesses.length,
          sourceMismatches: caregiverSourceMismatches.length,
          noDependentIngestWithinWindow: caregiverRelayFailures.filter((item) => !item.ingest).length,
          ambiguous: caregiverRelayAmbiguities.length,
          unsupported: caregiverRelayUnsupported.length,
          geneticParentTransfers: caregiverRelayAssignments.filter((item) => item.careBasis.geneticParent).length,
          dependentCareIntentTransfers: caregiverRelayAssignments.filter((item) => item.careBasis.dependentCareIntent).length,
          completedPersonTransferOnly: caregiverRelayAssignments.filter((item) => (
            !item.careBasis.geneticParent && !item.careBasis.dependentCareIntent
          )).length,
        },
        note: 'completed caregiver→other-person edible transfer 的 source 谱须包含 withdrawal；优先使用 geneticParents 或 dependent-care intent，缺少二者时仍明确标为 completed-person-transfer-only，绝不凭时间推断 relay',
        zeroNote: '没有由真实 completed person transfer 证明的 caregiver relay withdrawal，relay chain 分母为 0，unsupported',
      },
    ),
    sourceMismatch: denominatorCountMetric(
      totalSourceMismatches,
      survivalWithdrawals.length,
      chainSupported,
      chainUnsupported,
      allMismatchEvidence,
      {
        reasonCodes: allChainReasonCodes,
        note: '仅当同 person/material/时间窗存在完整 consumed provenance、但没有一个 exact source match 时计一次；缺字段不是 mismatch',
        zeroNote: '没有 survival stored-food withdrawal，source mismatch 分母为 0，unsupported',
      },
    ),
    ambiguousMergedIngests: denominatorCountMetric(
      totalAmbiguousIngests,
      survivalWithdrawals.length,
      chainSupported + totalAmbiguousIngests,
      unsupportedChains.length + caregiverRelayUnsupported.length,
      allAmbiguousIngestEvidence,
      {
        reasonCodes: [
          ...unsupportedChains.flatMap((item) => item.reasons),
          ...caregiverRelayUnsupported.flatMap((item) => item.reasons),
        ],
        note: 'self 或 caregiver relay 的来源虽被下游谱包含，但期间另有同材质入栈或下游谱含额外候选来源；单列且不计成功或 sourceMismatch',
        zeroNote: '没有 survival stored-food withdrawal，merged-ingest ambiguity 分母为 0，unsupported',
      },
    ),
    strictDepositSurvivalWithdrawIngestLoops: rateMetric(
      strictLoops.length,
      successfulMatches.length,
      strictLoops.length + strictNoDeposit.length,
      strictUnsupported.length + ambiguousMergedDeposits.length,
      strictEvidence,
      {
        reasonCodes: [
          ...(strictUnsupported.length ? ['candidate-deposit-missing-source-contract'] : []),
          ...(ambiguousMergedDeposits.length ? ['withdrawal-spectrum-contains-multiple-matching-deposit-events'] : []),
        ],
        categories: {
          strictLoops: strictLoops.length,
          exactWithdrawIngestWithoutMatchingDeposit: strictNoDeposit.length,
          unsupportedDepositProvenance: strictUnsupported.length,
          ambiguousMergedDeposits: ambiguousMergedDeposits.length,
        },
        note: '先前唯一 person→同 container/material deposit 的 event id 与非空 lineage 须延续到无歧义 self/relay withdrawal→ingest；withdrawal 谱含多个 matching deposits 时不得任意分配单位',
        zeroNote: '没有 exact survival withdrawal→ingest 链，deposit→withdraw→ingest 严格闭环分母为 0，unsupported',
      },
    ),
    ambiguousMergedDeposits: denominatorCountMetric(
      ambiguousMergedDeposits.length,
      successfulMatches.length,
      strictLoops.length + strictNoDeposit.length + ambiguousMergedDeposits.length,
      strictUnsupported.length,
      ambiguousMergedDepositEvidence,
      {
        reasonCodes: strictUnsupported.length ? ['candidate-deposit-missing-source-contract'] : [],
        note: '无歧义 withdrawal→ingest 已成立，但 withdrawal source 谱同时包含同 container/material 的多个 deposit event/lineage；单列且从 strict loop 排除',
        zeroNote: '没有无歧义 withdrawal→ingest 成功链，merged-deposit ambiguity 分母为 0，unsupported',
      },
    ),
    storageCompletedActionShare: rateMetric(
      auxiliary.storageCompletedActions,
      auxiliary.completedActions,
      auxiliary.completedActions,
      0,
      items.filter(completedContainerTransfer).map((item) => transferEvidence(item)),
      {
        note: '所有完成的 container-involving transfer / 所有完成 action；这是流量护栏，不充当食物因果链证据',
        zeroNote: '没有 completed action，storage action share unsupported',
      },
    ),
  };
  return {
    runId: matrixRun.runId,
    seed: matrixRun.seed ?? state.seed,
    horizonYears: matrixRun.years ?? matrixRun.horizonYears ?? null,
    requestedMonths: matrixRun.requestedMonths ?? matrixRun.months ?? null,
    reachedMonth: finiteValue(state.clock?.elapsedMonths),
    matrixStatus: matrixRun.status ?? null,
    civilizationStatus: state.civilization?.status ?? null,
    outcome: state.civilization?.outcome ?? null,
    schemaVersion: state.schemaVersion ?? null,
    metrics,
    auxiliary,
    evidence: {
      ordinaryIntentEdibleWithdrawals: ordinaryEvidence,
      excludedProjectLogisticsEdibleWithdrawals: projectLogisticsEvidence,
      unresolvedIntentEdibleWithdrawals: unresolvedOrdinaryEvidence,
      survivalStoredFoodWithdrawals: classifiedSurvivalWithdrawalEvidence,
      exactSameSourceIngestWithin2Months: exactEvidence,
      caregiverRelaySameSourceIngestWithin2Months: caregiverRelaySuccessEvidence,
      caregiverRelayAmbiguities: caregiverRelayAmbiguityEvidence,
      caregiverRelayFailures: caregiverRelayFailureEvidence,
      caregiverRelayUnsupported: caregiverRelayUnsupportedEvidence,
      sourceMismatch: allMismatchEvidence,
      ambiguousMergedIngests: allAmbiguousIngestEvidence,
      unsupportedSourceChains: unsupportedEvidence,
      strictDepositSurvivalWithdrawIngestLoops: strictEvidence,
      ambiguousMergedDeposits: ambiguousMergedDepositEvidence,
      strictExactIngestsWithoutMatchingDeposit: strictNoDeposit.map(({ withdrawal, relay, ingest, chainType }) => ({
        chainType,
        withdrawalEventId: stringValue(withdrawal.event.id),
        relayTransferEventId: stringValue(relay?.event.id),
        ingestEventId: stringValue(ingest.event.id),
        actorId: stringValue(withdrawal.event.who),
        containerId: stringValue(asObject(asObject(withdrawal.event.action)?.from)?.containerId),
        materialId: finiteValue(asObject(withdrawal.event.action)?.materialId),
      })),
      strictUnsupportedDeposits: strictUnsupported.map(({ withdrawal, relay, ingest, candidates, chainType }) => ({
        chainType,
        withdrawalEventId: stringValue(withdrawal.event.id),
        relayTransferEventId: stringValue(relay?.event.id),
        ingestEventId: stringValue(ingest.event.id),
        candidateDepositEventIds: candidates.map((candidate) => stringValue(candidate.event.id)).filter(Boolean),
      })),
    },
  };
}

function aggregateRate(metrics) {
  const numerator = metrics.reduce((sum, metric) => sum + (finiteValue(metric.numerator) ?? 0), 0);
  const denominator = metrics.reduce((sum, metric) => sum + (finiteValue(metric.denominator) ?? 0), 0);
  const supportedObservations = metrics.reduce((sum, metric) => sum + (finiteValue(metric.supportedObservations) ?? 0), 0);
  const incomplete = metrics.some((metric) => metric.status === 'partial' || metric.status === 'unsupported');
  return {
    statuses: countBy(metrics.map((metric) => metric.status)),
    numerator,
    denominator,
    rate: denominator > 0 && !incomplete ? percentage(numerator, denominator) : null,
    knownRate: percentage(
      numerator,
      supportedObservations,
    ),
    coverage: percentage(supportedObservations, denominator),
    unit: 'percent',
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
    metrics: {
      ordinaryIntentEdibleWithdrawals: {
        statuses: countBy(matching.map((run) => run.metrics.ordinaryIntentEdibleWithdrawals.status)),
        knownValueSum: matching.reduce((sum, run) => sum + (finiteValue(run.metrics.ordinaryIntentEdibleWithdrawals.knownValue) ?? 0), 0),
      },
      survivalStoredFoodWithdrawals: {
        statuses: countBy(matching.map((run) => run.metrics.survivalStoredFoodWithdrawals.status)),
        valueSum: matching.reduce((sum, run) => sum + (finiteValue(run.metrics.survivalStoredFoodWithdrawals.value) ?? 0), 0),
      },
      sameSourceIngestWithin2Months: aggregateRate(matching.map((run) => run.metrics.sameSourceIngestWithin2Months)),
      selfSameSourceIngestWithin2Months: aggregateRate(matching.map((run) => run.metrics.selfSameSourceIngestWithin2Months)),
      caregiverRelaySameSourceIngestWithin2Months: aggregateRate(matching.map((run) => run.metrics.caregiverRelaySameSourceIngestWithin2Months)),
      sourceMismatch: {
        statuses: countBy(matching.map((run) => run.metrics.sourceMismatch.status)),
        knownValueSum: matching.reduce((sum, run) => sum + (finiteValue(run.metrics.sourceMismatch.knownValue) ?? 0), 0),
      },
      ambiguousMergedIngests: {
        statuses: countBy(matching.map((run) => run.metrics.ambiguousMergedIngests.status)),
        knownValueSum: matching.reduce((sum, run) => sum + (finiteValue(run.metrics.ambiguousMergedIngests.knownValue) ?? 0), 0),
      },
      strictDepositSurvivalWithdrawIngestLoops: aggregateRate(matching.map((run) => run.metrics.strictDepositSurvivalWithdrawIngestLoops)),
      ambiguousMergedDeposits: {
        statuses: countBy(matching.map((run) => run.metrics.ambiguousMergedDeposits.status)),
        knownValueSum: matching.reduce((sum, run) => sum + (finiteValue(run.metrics.ambiguousMergedDeposits.knownValue) ?? 0), 0),
      },
      storageCompletedActionShare: {
        statuses: countBy(matching.map((run) => run.metrics.storageCompletedActionShare.status)),
        runRates: numericSummary(matching.map((run) => run.metrics.storageCompletedActionShare.rate)),
        pooled: aggregateRate(matching.map((run) => run.metrics.storageCompletedActionShare)),
      },
    },
    auxiliary: {
      throughMonth: numericSummary(matching.map((run) => run.auxiliary.throughMonth)),
      livingPopulation: numericSummary(matching.map((run) => run.auxiliary.population.living)),
      deaths: numericSummary(matching.map((run) => run.auxiliary.deaths)),
      childDeaths: numericSummary(matching.map((run) => run.auxiliary.childDeaths)),
      exposureDeaths: numericSummary(matching.map((run) => run.auxiliary.exposureDeaths)),
      childExposureDeaths: numericSummary(matching.map((run) => run.auxiliary.childExposureDeaths)),
      movementActions: numericSummary(matching.map((run) => run.auxiliary.movementActions)),
      movementActionShare: numericSummary(matching.map((run) => run.auxiliary.movementActionShare)),
    },
  }));
}

async function main() {
  selfTestAmbiguousMergeClassifier();
  const [matrixArgument, outputArgument] = process.argv.slice(2);
  if (!matrixArgument) {
    throw new Error('usage: node scripts/audit-food-reserve-use-chain.mjs <matrix.json> [output.json]');
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
    methodVersion: METHOD_VERSION,
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
      edibleMaterialContract: Object.fromEntries(EDIBLE_MATERIALS),
      ordinaryIntentDefinition: 'completed edible container→same actor transfer with cause=intent and a resolved intent without projectId; project logistics are separately reported and excluded',
      survivalWithdrawalDefinition: 'completed edible container→same actor transfer with cause=survival-reflex',
      exactIngestDefinition: `self: same actor/material inventory ingest; caregiver relay: completed caregiver→dependent person transfer then dependent ingest. Both finish within ${MAX_INGEST_DELAY_MONTHS} months and every hop must contain the upstream event id and non-empty lineage without merged-source ambiguity`,
      caregiverRelayDefinition: 'a completed person→person edible transfer by the withdrawal actor whose source spectrum contains the withdrawal; geneticParents and dependent-care intent are reported when available, otherwise the chain is explicitly completed-person-transfer-only and is never inferred from timing alone',
      sourceMismatchDefinition: 'a complete self ingest or caregiver relay child ingest exists but its source does not contain the required upstream hop; missing provenance and merged ambiguity are excluded from mismatch',
      mergedIngestAmbiguityDefinition: 'an inclusion-linked self/relay hop is ambiguous when another same-material inbound transfer occurs between hops, or downstream provenance contains sources outside the upstream spectrum; ambiguity is excluded from success and mismatch',
      strictLoopDefinition: 'one uniquely attributable person→container edible deposit precedes an unambiguous self/relay withdrawal→ingest; if withdrawal provenance contains multiple matching deposit events, no unit is assigned and the observation is ambiguousMergedDeposits',
      storageShareDefinition: 'completed action facts involving a container divided by all completed action facts; project logistics remain included only in this flow guardrail',
      childDefinition: 'death diff.ageMonths < 144, matching evolution-artifacts.ts',
      exposureDeathDefinition: 'death diff.sourceEventIds resolves to an environment cold/heat condition event',
      unsupportedPolicy: 'zero chain denominator is unsupported; missing v2 source/consumed lineage makes the affected observation partial or unsupported and never a successful or failed zero',
      embeddedSelfTest: 'locks clean self and caregiver withdrawal→person relay→child ingest, rejects withdrawal→other same-material merge→ingest, and distinguishes one-deposit attribution from depositA+depositB merged-spectrum ambiguity',
      compatibility: {
        legacyV1: 'withdrawal counts and auxiliary facts remain observable; exact ingest and strict-loop metrics are partial/unsupported when transfer or ingest provenance fields are absent',
        candidateV2: 'transfer diff.sourceEventIds/sourceLineageKeys plus ingest diff.consumedStackId/consumedSourceEventIds/consumedSourceLineageKeys',
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
