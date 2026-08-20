import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { openSqliteRunReader } from './sqlite-run-reader.mjs';

const OBSERVER_VERSION = 'local-threat-ecology-audit-v1';
const THREAT_BASIS_VERSION = 'visible-wildlife-threat-v1';
const PACK_CUE_LIFETIME_MONTHS = 3;
const PACK_SHARE_RADIUS = 3;

const asArray = (value) => Array.isArray(value) ? value : [];
const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const stringValue = (value) => typeof value === 'string' && value.length ? value : null;
const integerValue = (value) => Number.isInteger(value) ? value : null;
const finiteValue = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const rounded = (value) => Math.round(value * 10_000) / 10_000;

function countBy(values) {
  return Object.fromEntries([...values.reduce((counts, value) => {
    const key = String(value ?? 'unknown');
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map())].sort(([left], [right]) => left.localeCompare(right)));
}

function metric(numerator, denominator, unknown = 0) {
  if (denominator === 0) return {
    numerator: 0, denominator: 0, value: null, knownValue: null, coverage: null, status: 'unsupported',
  };
  const known = Math.max(0, denominator - unknown);
  return {
    numerator,
    denominator,
    value: unknown ? null : rounded(numerator / denominator),
    knownValue: known ? rounded(numerator / known) : null,
    coverage: rounded(known / denominator),
    status: unknown === 0 ? 'supported' : known ? 'partial' : 'unsupported',
  };
}

function cellDistance(width, first, second) {
  if (!Number.isInteger(width) || !Number.isInteger(first) || !Number.isInteger(second)) return null;
  return Math.abs(first % width - second % width) + Math.abs(Math.floor(first / width) - Math.floor(second / width));
}

function eventSummary(event) {
  const diff = asObject(event.diff) ?? {};
  return {
    eventId: stringValue(event.id),
    atMonth: integerValue(event.atMonth),
    orderInMonth: integerValue(event.orderInMonth),
    who: stringValue(event.who),
    animalId: stringValue(diff.animalId),
    process: stringValue(diff.process),
    victimId: stringValue(diff.victimId) ?? stringValue(diff.targetPersonId),
  };
}

function eventOrder(left, right) {
  return (integerValue(left.atMonth) ?? 0) - (integerValue(right.atMonth) ?? 0)
    || (integerValue(left.orderInMonth) ?? 0) - (integerValue(right.orderInMonth) ?? 0)
    || String(left.id).localeCompare(String(right.id));
}

function localPerceptionReasons(event) {
  const diff = asObject(event.diff) ?? {};
  const perception = asObject(diff.perception);
  const process = stringValue(diff.process);
  const reasons = [];
  const cueBased = perception?.basis === 'pack-last-seen-cue';
  if (!cueBased && perception?.reachableOnly !== true) reasons.push('not-reachable-only');
  if (process === 'pursuit-human') {
    const target = stringValue(diff.targetPersonId);
    const perceived = asArray(perception?.perceivedPersonIds).map(stringValue).filter(Boolean);
    const cueMonth = integerValue(perception?.sourceCueObservedAtMonth);
    const atMonth = integerValue(event.atMonth);
    if (!target) reasons.push('missing-target-person');
    if (!perceived.includes(target) && cueMonth === null) reasons.push('target-neither-perceived-nor-cued');
    if (cueBased && perception?.currentTargetReachable !== 'unknown') reasons.push('cue-pretends-current-target-reachable');
    if (cueMonth !== null && atMonth !== null && (cueMonth > atMonth || atMonth - cueMonth > PACK_CUE_LIFETIME_MONTHS)) {
      reasons.push('expired-or-future-cue');
    }
  }
  if (process === 'hunt-prey') {
    const target = stringValue(diff.targetAnimalId);
    const perceived = asArray(perception?.perceivedPreyIds).map(stringValue).filter(Boolean);
    if (!target || !perceived.includes(target)) reasons.push('prey-not-in-local-perception');
  }
  if (process === 'flee-threat'
    && asArray(perception?.perceivedThreatAnimalIds).length === 0
    && asArray(perception?.perceivedPersonIds).length === 0) reasons.push('flee-without-perceived-threat');
  return reasons;
}

function territoryReasons(state, event) {
  const diff = asObject(event.diff) ?? {};
  const territory = asObject(diff.territory);
  if (!territory) return [];
  const anchor = integerValue(territory.anchorCellId);
  const radius = finiteValue(territory.radius);
  const destination = integerValue(diff.destinationCellId);
  const target = integerValue(diff.plannedTargetCellId);
  const width = integerValue(state.world?.grid?.width);
  const reasons = [];
  if (territory.enforced !== true || anchor === null || radius === null) reasons.push('malformed-territory-basis');
  const destinationDistance = cellDistance(width, anchor, destination);
  if (destinationDistance !== null && radius !== null && destinationDistance > radius) reasons.push('destination-outside-territory');
  if (stringValue(diff.process) === 'pursuit-human') {
    const targetDistance = cellDistance(width, anchor, target);
    if (targetDistance !== null && radius !== null && targetDistance > radius) reasons.push('pursuit-target-outside-territory');
  }
  return reasons;
}

function packShareReasons(state, event) {
  const diff = asObject(event.diff) ?? {};
  const receiver = stringValue(diff.receiverAnimalId) ?? stringValue(diff.animalId);
  const source = stringValue(diff.sourceAnimalId);
  const observed = integerValue(diff.observedAtMonth);
  const expires = integerValue(diff.expiresAtMonth);
  const shareRadius = finiteValue(diff.shareRadius);
  const animals = new Map(asArray(state.world?.animals).map((animal) => [animal.id, animal]));
  const receiverPack = asObject(animals.get(receiver)?.ecology)?.packId;
  const sourcePack = asObject(animals.get(source)?.ecology)?.packId;
  const reasons = [];
  if (!receiver || !source || receiver === source) reasons.push('invalid-share-parties');
  if (!stringValue(diff.packId) || (receiverPack && sourcePack && receiverPack !== sourcePack)) reasons.push('cross-pack-share');
  if (observed === null || expires === null || expires - observed !== PACK_CUE_LIFETIME_MONTHS) reasons.push('cue-lifetime-mismatch');
  if (shareRadius !== PACK_SHARE_RADIUS) reasons.push('share-radius-mismatch');
  if (diff.renewedBySharing !== false) reasons.push('sharing-renewed-cue');
  return reasons;
}

function responseReasons(event) {
  const action = asObject(event.action) ?? {};
  const basis = asObject(action.wildlifeThreatBasis);
  const diff = asObject(event.diff) ?? {};
  const reasons = [];
  if (basis?.version !== THREAT_BASIS_VERSION) reasons.push('missing-versioned-threat-basis');
  if (stringValue(basis?.personId) !== stringValue(event.who)) reasons.push('basis-person-mismatch');
  if (integerValue(basis?.observedAtMonth) !== integerValue(event.atMonth)) reasons.push('basis-month-mismatch');
  if (integerValue(action.toCellId) !== integerValue(asObject(basis?.destination)?.cellId)
    || integerValue(action.toZ) !== integerValue(asObject(basis?.destination)?.z)) reasons.push('basis-destination-mismatch');
  if (asArray(basis?.threats).length === 0 || asArray(basis?.threats).length > 8) reasons.push('invalid-local-threat-set');
  if (event.status === 'completed' && diff.wildlifeThreatResponseInvalidated === true) reasons.push('invalidated-response-completed');
  if (event.status === 'completed' && basis?.response === 'flee-step'
    && !((finiteValue(diff.wildlifeThreatDistanceAfter) ?? -Infinity) > (finiteValue(diff.wildlifeThreatDistanceBefore) ?? Infinity))) {
    reasons.push('flee-did-not-increase-distance');
  }
  if (event.status === 'completed' && basis?.response === 'shelter-step' && !stringValue(diff.wildlifeThreatShelterStructureId)) {
    reasons.push('shelter-step-without-structure');
  }
  return reasons;
}

function auditRun(matrixRun, persisted) {
  const state = persisted.state;
  const events = asArray(state.world?.past).sort(eventOrder);
  const duplicateIds = [...events.reduce((counts, event) => {
    counts.set(event.id, (counts.get(event.id) ?? 0) + 1);
    return counts;
  }, new Map()).entries()].filter(([, count]) => count > 1).map(([id]) => id);
  const animal = events.filter((event) => event.kind === 'environment' && event.change === 'animal');
  const byProcess = (process) => animal.filter((event) => asObject(event.diff)?.process === process);
  const pursuits = byProcess('pursuit-human');
  const hunts = byProcess('hunt-prey');
  const animalFlees = byProcess('flee-threat');
  const contacts = byProcess('pursuit-contact');
  const attacks = byProcess('attack-human');
  const shares = byProcess('share-pack-last-seen-cue');
  const responses = events.filter((event) => event.kind === 'action' && asObject(event.diff)?.wildlifeThreatResponse === true);

  const perceptionViolations = [...pursuits, ...hunts, ...animalFlees].flatMap((event) => localPerceptionReasons(event)
    .map((reason) => ({ reason, ...eventSummary(event) })));
  const territoryViolations = [...pursuits, ...hunts].flatMap((event) => territoryReasons(state, event)
    .map((reason) => ({ reason, ...eventSummary(event) })));
  const packShareViolations = shares.flatMap((event) => packShareReasons(state, event)
    .map((reason) => ({ reason, ...eventSummary(event) })));
  const responseViolations = responses.flatMap((event) => responseReasons(event)
    .map((reason) => ({ reason, ...eventSummary(event) })));

  const contactKeys = new Set(contacts.map((event) => {
    const diff = asObject(event.diff) ?? {};
    return `${event.atMonth}:${diff.animalId}:${diff.targetPersonId}`;
  }));
  const sameMonthChaseAttacks = attacks.filter((event) => {
    const diff = asObject(event.diff) ?? {};
    return diff.monthOpeningCoLocated !== true
      || contactKeys.has(`${event.atMonth}:${diff.animalId}:${diff.victimId}`);
  }).map(eventSummary);
  const targetSelectionViolations = attacks.filter((event) => {
    const diff = asObject(event.diff) ?? {};
    const selection = asObject(diff.targetSelection);
    return stringValue(selection?.selectedPersonId) !== stringValue(diff.victimId)
      || !String(selection?.order ?? '').includes('wound-desc')
      || !String(selection?.order ?? '').includes('visible-defense-asc');
  }).map(eventSummary);

  const contactResponse = contacts.map((contact) => {
    const diff = asObject(contact.diff) ?? {};
    const matching = responses.find((response) => response.atMonth === contact.atMonth
      && response.who === diff.targetPersonId
      && asArray(asObject(response.diff)?.wildlifeThreatAnimalIds).includes(diff.animalId)
      && response.status === 'completed');
    return { contact: eventSummary(contact), response: matching ? eventSummary(matching) : null };
  });
  const completedContactResponses = contactResponse.filter((item) => item.response).length;

  return {
    runId: matrixRun.runId,
    seed: matrixRun.seed ?? state.seed ?? null,
    horizonYears: matrixRun.years ?? (matrixRun.months ? matrixRun.months / 12 : null),
    reachedMonth: state.clock?.elapsedMonths ?? null,
    matrixStatus: matrixRun.status ?? null,
    support: [...perceptionViolations, ...territoryViolations, ...packShareViolations, ...responseViolations,
      ...sameMonthChaseAttacks, ...targetSelectionViolations].length || duplicateIds.length ? 'partial' : 'supported',
    metrics: {
      pursuits: pursuits.length,
      preyHunts: hunts.length,
      animalFlees: animalFlees.length,
      packCueShares: shares.length,
      pursuitContacts: contacts.length,
      humanAttacks: attacks.length,
      wolfAttacks: attacks.filter((event) => asObject(event.diff)?.animalSpeciesId === 'wolf').length,
      boarDefensiveAttacks: attacks.filter((event) => asObject(event.diff)?.behavior === 'defensive-charge').length,
      wildlifeResponses: responses.length,
      completedWildlifeResponses: responses.filter((event) => event.status === 'completed').length,
      invalidatedWildlifeResponses: responses.filter((event) => asObject(event.diff)?.wildlifeThreatResponseInvalidated === true).length,
      contactResponseRate: metric(completedContactResponses, contacts.length),
      localPerceptionViolations: perceptionViolations.length,
      territoryViolations: territoryViolations.length,
      packShareViolations: packShareViolations.length,
      sameMonthChaseAttacks: sameMonthChaseAttacks.length,
      targetSelectionViolations: targetSelectionViolations.length,
      responseContractViolations: responseViolations.length,
      duplicateWorldEventIds: duplicateIds.length,
    },
    evidence: {
      perceptionViolations,
      territoryViolations,
      packShareViolations,
      sameMonthChaseAttacks,
      targetSelectionViolations,
      responseViolations,
      duplicateEventIds: duplicateIds,
      contactResponse,
      samplePursuits: pursuits.slice(0, 12).map(eventSummary),
      sampleAttacks: attacks.slice(0, 12).map(eventSummary),
      sampleResponses: responses.slice(0, 12).map(eventSummary),
    },
  };
}

function aggregate(runs) {
  const total = (field) => runs.reduce((sum, run) => sum + run.metrics[field], 0);
  const contacts = total('pursuitContacts');
  const contactResponses = runs.reduce((sum, run) => sum + run.metrics.contactResponseRate.numerator, 0);
  return {
    runs: runs.length,
    support: runs.some((run) => run.support !== 'supported') ? 'partial' : 'supported',
    statuses: countBy(runs.map((run) => run.matrixStatus)),
    totals: Object.fromEntries([
      'pursuits', 'preyHunts', 'animalFlees', 'packCueShares', 'pursuitContacts', 'humanAttacks',
      'wolfAttacks', 'boarDefensiveAttacks', 'wildlifeResponses', 'completedWildlifeResponses',
      'invalidatedWildlifeResponses', 'localPerceptionViolations', 'territoryViolations', 'packShareViolations',
      'sameMonthChaseAttacks', 'targetSelectionViolations', 'responseContractViolations', 'duplicateWorldEventIds',
    ].map((field) => [field, total(field)])),
    contactResponseRate: metric(contactResponses, contacts),
  };
}

async function main() {
  const [matrixArgument, outputArgument] = process.argv.slice(2);
  if (!matrixArgument) throw new Error('usage: node scripts/audit-local-threat-ecology.mjs <matrix.json> [output.json]');
  const matrixPath = path.resolve(matrixArgument);
  const outputPath = outputArgument ? path.resolve(outputArgument) : null;
  const matrixText = await readFile(matrixPath, 'utf8');
  const matrix = JSON.parse(matrixText);
  if (!Array.isArray(matrix.runs)) throw new Error(`matrix has no runs array: ${matrixPath}`);
  const reader = await openSqliteRunReader();
  const runs = [];
  try {
    for (const matrixRun of matrix.runs) runs.push(auditRun(matrixRun, await reader.store.load(matrixRun.runId)));
  } finally {
    await reader.close();
  }
  const horizons = [...Map.groupBy(runs, (run) => run.horizonYears).entries()]
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([horizonYears, values]) => ({ horizonYears, ...aggregate(values) }));
  const result = {
    schemaVersion: 1,
    observerVersion: OBSERVER_VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      matrixPath,
      matrixSha256: createHash('sha256').update(matrixText).digest('hex'),
      experiment: matrix.experiment ?? null,
      runCount: matrix.runs.length,
    },
    method: {
      authority: 'SQLite terminal SimulationState loaded read-only; the observer never advances a run.',
      localThreatContract: 'month-opening reachable perception -> frozen stable target -> bounded movement -> contact-only warning or later month-opening attack',
      packContract: 'same-pack direct-source cue within radius 3; sharing never renews the original observed/expiry month and cannot multi-hop',
      responseContract: 'reader-local versioned threat basis -> one exact adjacent flee/shelter/hold move -> executor revalidation before mutation',
      zeroDenominatorPolicy: 'No natural contact is unsupported, never a vacuous 100% response rate.',
    },
    aggregate: aggregate(runs),
    horizons,
    runs,
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, serialized, 'utf8');
  else process.stdout.write(serialized);
}

await main();
