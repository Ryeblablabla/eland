#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unknown argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
    values[token.slice(2)] = value;
    index += 1;
  }
  return values;
}

async function json(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

async function requestState(baseUrl, runId) {
  const response = await fetch(`${baseUrl.replace(/\/$/u, '')}/api/runs/${runId}/state`);
  if (!response.ok) throw new Error(`GET ${runId}/state failed (${response.status}): ${await response.text()}`);
  return response.json();
}

function samePosition(left, right) {
  return left && right && left.x === right.x && left.y === right.y && left.z === right.z;
}

function summarizeState(coordinate, state) {
  const people = Array.isArray(state.people) ? state.people : [];
  const events = Array.isArray(state.world?.past) ? state.world.past : [];
  const drops = Array.isArray(state.world?.drops) ? state.world.drops : [];
  const remains = Array.isArray(state.world?.remains) ? state.world.remains : [];
  const memorials = Array.isArray(state.world?.memorials) ? state.world.memorials : [];
  const eventById = new Map(events.map((event) => [event.id, event]));
  const deaths = people.filter((person) => Number.isFinite(person.diedAtMonth));
  const deathEvents = events.filter((event) => event.kind === 'environment' && event.change === 'death');
  const completedMortuary = events.filter((event) => event.kind === 'action'
    && event.action?.operation === 'inter' && event.status === 'completed');
  const blockedMortuary = events.filter((event) => event.kind === 'action'
    && event.action?.operation === 'inter' && event.status !== 'completed');
  const phaseCount = Object.fromEntries(['mourn', 'lift', 'prepare-grave', 'place-in-grave', 'cover-grave', 'mark']
    .map((phase) => [phase, completedMortuary.filter((event) => event.diff?.mortuaryPhase === phase).length]));
  const bereavements = people.flatMap((person) => (person.bereavements ?? []).map((bereavement) => ({ person, bereavement })));
  const unsourcedBereavements = bereavements.filter(({ person, bereavement }) => {
    const sourceIds = Array.isArray(bereavement.sourceEventIds) ? bereavement.sourceEventIds : [];
    const remainsState = remains.find((candidate) => candidate.id === bereavement.remainsId);
    const death = eventById.get(bereavement.deathEventId);
    if (!remainsState
      || remainsState.personId !== bereavement.deceasedPersonId
      || remainsState.deathEventId !== bereavement.deathEventId
      || death?.change !== 'death'
      || !sourceIds.includes(bereavement.deathEventId)) return true;
    if (bereavement.learnedBy === 'witness') return !sourceIds.some((eventId) => {
      const source = eventById.get(eventId);
      return source?.diff?.mortuaryPerception === true && source.who === person.id
        && source.diff.remainsId === bereavement.remainsId;
    });
    if (bereavement.learnedBy === 'told') return !sourceIds.some((eventId) => {
      const source = eventById.get(eventId);
      return source?.kind === 'action' && source.action?.kind === 'communicate'
        && Array.isArray(source.diff?.deathNewsPersonIds) && source.diff.deathNewsPersonIds.includes(person.id)
        && Array.isArray(source.diff?.deathNewsSourceEventIds)
        && source.diff.deathNewsSourceEventIds.includes(bereavement.deathEventId);
    });
    return true;
  });
  const remainsPerDeathViolations = deaths.filter((person) => (
    remains.filter((candidate) => candidate.personId === person.id).length !== 1
  ));
  const duplicateRemains = [...new Set(remains.map((candidate) => candidate.personId))]
    .filter((personId) => remains.filter((candidate) => candidate.personId === personId).length > 1);
  const orphanRemains = remains.filter((candidate) => {
    const person = people.find((item) => item.id === candidate.personId);
    const death = eventById.get(candidate.deathEventId);
    return !person || !Number.isFinite(person.diedAtMonth) || death?.change !== 'death';
  });
  const burialClosureViolations = remains.filter((candidate) => candidate.status === 'interred').filter((candidate) => {
    const grave = candidate.grave;
    const death = eventById.get(candidate.deathEventId);
    const excavation = eventById.get(grave?.excavationEventId);
    const placement = eventById.get(grave?.placementEventId);
    const burial = eventById.get(grave?.burialEventId);
    return !grave
      || death?.change !== 'death'
      || excavation?.status !== 'completed'
      || excavation?.diff?.mortuaryPhase !== 'prepare-grave'
      || excavation?.diff?.remainsId !== candidate.id
      || !samePosition(excavation?.diff?.gravePosition, grave.position)
      || placement?.status !== 'completed'
      || placement?.diff?.mortuaryPhase !== 'place-in-grave'
      || placement?.diff?.remainsId !== candidate.id
      || burial?.status !== 'completed'
      || burial?.diff?.mortuaryPhase !== 'cover-grave'
      || burial?.diff?.remainsId !== candidate.id
      || burial?.who !== candidate.interredByPersonId
      || burial?.atMonth !== candidate.interredAtMonth
      || burial?.diff?.excavationEventId !== grave.excavationEventId
      || burial?.diff?.placementEventId !== grave.placementEventId
      || burial?.diff?.coverMaterialStackId !== grave.coverMaterialStackId
      || burial?.diff?.coverMaterialId !== grave.originalMaterialId;
  });
  const memorialClosureViolations = memorials.filter((marker) => {
    const remainsState = remains.find((candidate) => candidate.id === marker.remainsId);
    const markerEvent = events.find((event) => event.kind === 'action'
      && event.status === 'completed'
      && event.diff?.mortuaryPhase === 'mark'
      && event.diff?.memorialId === marker.id);
    return !remainsState
      || remainsState.status !== 'interred'
      || marker.personId !== remainsState.personId
      || markerEvent?.diff?.remainsId !== remainsState.id
      || markerEvent?.diff?.burialEventId !== remainsState.grave?.burialEventId
      || markerEvent?.diff?.markerMaterialId !== marker.materialId
      || !marker.sourceEventIds?.includes(remainsState.deathEventId)
      || !marker.sourceEventIds?.includes(remainsState.grave?.burialEventId)
      || !marker.sourceEventIds?.includes(markerEvent?.id);
  });
  const estateDrops = drops.filter((drop) => typeof drop.estateOfPersonId === 'string');
  const estateCollections = events.filter((event) => event.kind === 'action'
    && event.status === 'completed'
    && event.action?.kind === 'transfer'
    && event.action.from?.kind === 'ground'
    && typeof event.diff?.estateOfPersonId === 'string');
  const estateSourceViolations = estateDrops.filter((drop) => {
    const remainsState = remains.find((candidate) => candidate.personId === drop.estateOfPersonId);
    return !remainsState || !drop.sourceEventIds?.includes(remainsState.deathEventId);
  }).length + estateCollections.filter((event) => {
    const remainsState = remains.find((candidate) => candidate.personId === event.diff.estateOfPersonId);
    return !remainsState || !event.diff.sourceEventIds?.includes(remainsState.deathEventId);
  }).length;
  const careLatencies = remains.flatMap((candidate) => {
    const first = completedMortuary.find((event) => event.diff?.remainsId === candidate.id);
    return first ? [first.atMonth - candidate.createdAtMonth] : [];
  });
  const burialLatencies = remains.flatMap((candidate) => Number.isFinite(candidate.interredAtMonth)
    ? [candidate.interredAtMonth - candidate.createdAtMonth]
    : []);
  const earliestBurial = completedMortuary.find((event) => event.diff?.mortuaryPhase === 'cover-grave');
  return {
    runId: coordinate.runId,
    seed: coordinate.seed,
    years: coordinate.years,
    months: state.clock?.elapsedMonths,
    deaths: deaths.length,
    deathEvents: deathEvents.length,
    remains: remains.length,
    exposedRemains: remains.filter((candidate) => candidate.status === 'exposed').length,
    carriedRemains: remains.filter((candidate) => candidate.status === 'carried').length,
    placedRemains: remains.filter((candidate) => candidate.status === 'placed').length,
    interredRemains: remains.filter((candidate) => candidate.status === 'interred').length,
    memorials: memorials.length,
    estateDrops: estateDrops.length,
    estateCollections: estateCollections.length,
    estateCareCollections: estateCollections.filter((event) => event.diff.estateCare === true
      && event.diff.estateCarePersonId === event.diff.estateOfPersonId).length,
    bereavements: bereavements.length,
    witnessedBereavements: bereavements.filter(({ bereavement }) => bereavement.learnedBy === 'witness').length,
    toldBereavements: bereavements.filter(({ bereavement }) => bereavement.learnedBy === 'told').length,
    completedMortuaryActions: completedMortuary.length,
    blockedMortuaryActions: blockedMortuary.length,
    phaseCount,
    caredForRemains: remains.filter((candidate) => completedMortuary.some((event) => event.diff?.remainsId === candidate.id)).length,
    careActors: new Set(completedMortuary.map((event) => event.who)).size,
    meanFirstCareLatencyMonths: careLatencies.length
      ? Math.round(careLatencies.reduce((sum, value) => sum + value, 0) / careLatencies.length * 100) / 100
      : null,
    meanBurialLatencyMonths: burialLatencies.length
      ? Math.round(burialLatencies.reduce((sum, value) => sum + value, 0) / burialLatencies.length * 100) / 100
      : null,
    violations: {
      remainsPerDeath: remainsPerDeathViolations.length,
      duplicateRemains: duplicateRemains.length,
      orphanRemains: orphanRemains.length,
      unsourcedBereavements: unsourcedBereavements.length,
      burialClosure: burialClosureViolations.length,
      memorialClosure: memorialClosureViolations.length,
      estateSource: estateSourceViolations,
    },
    ...(earliestBurial ? {
      representativeBurial: {
        eventId: earliestBurial.id,
        atMonth: earliestBurial.atMonth,
        who: earliestBurial.who,
        remainsId: earliestBurial.diff.remainsId,
        deathEventId: earliestBurial.diff.deathEventId,
        excavationEventId: earliestBurial.diff.excavationEventId,
        placementEventId: earliestBurial.diff.placementEventId,
      },
    } : {}),
  };
}

function totals(runs) {
  const sum = (field) => runs.reduce((total, run) => total + Number(run[field] ?? 0), 0);
  const phaseCount = Object.fromEntries(['mourn', 'lift', 'prepare-grave', 'place-in-grave', 'cover-grave', 'mark']
    .map((phase) => [phase, runs.reduce((total, run) => total + run.phaseCount[phase], 0)]));
  const violations = Object.fromEntries(Object.keys(runs[0]?.violations ?? {}).map((name) => [
    name,
    runs.reduce((total, run) => total + run.violations[name], 0),
  ]));
  return {
    runs: runs.length,
    deaths: sum('deaths'),
    remains: sum('remains'),
    caredForRemains: sum('caredForRemains'),
    interredRemains: sum('interredRemains'),
    memorials: sum('memorials'),
    bereavements: sum('bereavements'),
    witnessedBereavements: sum('witnessedBereavements'),
    toldBereavements: sum('toldBereavements'),
    estateDrops: sum('estateDrops'),
    estateCollections: sum('estateCollections'),
    estateCareCollections: sum('estateCareCollections'),
    completedMortuaryActions: sum('completedMortuaryActions'),
    blockedMortuaryActions: sum('blockedMortuaryActions'),
    phaseCount,
    violations,
  };
}

const args = parseArgs(process.argv.slice(2));
if (!args.candidate || !args.out) {
  throw new Error('Usage: node scripts/analyze-mortuary-care-experiment.mjs --candidate MATRIX.json --out RESULT.json [--base-url URL]');
}
const matrix = await json(args.candidate);
const baseUrl = args['base-url'] ?? matrix.experiment?.baseUrl;
if (!baseUrl) throw new Error('candidate matrix has no baseUrl; pass --base-url');
const runs = [];
for (const coordinate of matrix.runs) {
  process.stderr.write(`[mortuary-audit] ${coordinate.runId}\n`);
  runs.push(summarizeState(coordinate, await requestState(baseUrl, coordinate.runId)));
}
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  candidateMatrix: resolve(args.candidate),
  baseUrl,
  totals: totals(runs),
  terminalHorizon: {
    years: Math.max(...runs.map((run) => run.years)),
    totals: totals(runs.filter((run) => run.years === Math.max(...runs.map((item) => item.years)))),
  },
  runs,
};
const outputPath = resolve(args.out);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
