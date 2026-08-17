#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [outputArgument, ...stateArguments] = process.argv.slice(2);
if (!outputArgument || !stateArguments.length) {
  throw new Error('usage: reproject-capability-milestones OUTPUT_JSON STATE_JSON...');
}

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'eland-capability-reprojection-'));
const observerBundle = path.join(temporaryDirectory, 'observer.mjs');
const civilizationIndexBundle = path.join(temporaryDirectory, 'civilization-index.mjs');
const gridBundle = path.join(temporaryDirectory, 'grid.mjs');

try {
  for (const [entryPoint, outputPath] of [
    ['src/game/eland/projection/capability-milestones.ts', observerBundle],
    ['src/game/eland/domain/civilization-index.ts', civilizationIndexBundle],
    ['src/game/eland/world/grid.ts', gridBundle],
  ]) execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entryPoint, '--bundle', '--platform=node', '--format=esm', `--outfile=${outputPath}`,
  ], { stdio: 'pipe' });
  const {
    CAPABILITY_MILESTONE_DEFINITION_VERSION,
    CAPABILITY_MILESTONE_DEFINITIONS,
    observeCapabilityMilestones,
  } = await import(`${pathToFileURL(observerBundle).href}?reproject=${Date.now()}`);
  const definitionsById = new Map(CAPABILITY_MILESTONE_DEFINITIONS.map((definition) => [definition.id, definition]));
  const { calculateCivilizationIndex } = await import(`${pathToFileURL(civilizationIndexBundle).href}?reproject=${Date.now()}`);
  const { hydrateWorld } = await import(`${pathToFileURL(gridBundle).href}?reproject=${Date.now()}`);

  const runs = [];
  for (const stateArgument of stateArguments) {
    const statePath = path.resolve(stateArgument);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.world.grid = hydrateWorld(state.world.grid);
    const baselineIndex = calculateCivilizationIndex(state);
    const milestones = observeCapabilityMilestones(state);
    const capabilityState = structuredClone(state);
    capabilityState.derived.milestones = milestones;
    const capabilityIndex = calculateCivilizationIndex(capabilityState);
    const eventIds = new Set(state.world.past.map((event) => event.id));
    const unresolvedEvidenceIds = [...new Set(milestones.flatMap((milestone) => milestone.evidenceEventIds)
      .filter((eventId) => !eventIds.has(eventId)))];
    const values = (field) => Object.fromEntries([...new Set(milestones.map((milestone) => milestone[field] ?? 'unknown'))]
      .sort().map((value) => [value, milestones.filter((milestone) => (milestone[field] ?? 'unknown') === value).length]));
    const selected = milestones.filter((milestone) => milestone.valence === 'harmful'
      || milestone.phase === 'collapse' || milestone.phase === 'recovery');
    runs.push({
      runId: path.basename(path.dirname(statePath)),
      statePath,
      seed: state.seed,
      throughMonth: state.clock.elapsedMonths,
      population: state.people.filter((person) => person.diedAtMonth === undefined && person.body.health > 0).length,
      milestoneDefinitionsObserved: milestones.length,
      capabilityCoordinatesObserved: new Set(milestones
        .map((milestone) => milestone.capabilityId)
        .filter((capabilityId) => Number.isInteger(capabilityId))).size,
      worldSpecificMilestonesObserved: milestones.filter((milestone) => definitionsById.get(milestone.id)?.catalogKind === 'world-specific').length,
      civilizationIndex: {
        formulaVersion: capabilityIndex.formulaVersion,
        legacyMilestoneProjection: baselineIndex.total,
        capabilityMilestoneProjection: capabilityIndex.total,
        totalDelta: Math.round((capabilityIndex.total - baselineIndex.total) * 100) / 100,
        legacyHistoryScore: baselineIndex.components.history.score,
        capabilityHistoryScore: capabilityIndex.components.history.score,
        historyDelta: Math.round((capabilityIndex.components.history.score - baselineIndex.components.history.score) * 100) / 100,
        capabilityHistoryEvidence: capabilityIndex.components.history.evidence,
      },
      domains: values('domain'),
      valences: values('valence'),
      phases: values('phase'),
      harmfulOrCollapseOrRecovery: selected.map((milestone) => ({
        id: milestone.id,
        capabilityId: milestone.capabilityId,
        mapLabel: definitionsById.get(milestone.id)?.mapLabel,
        catalogKind: definitionsById.get(milestone.id)?.catalogKind,
        label: milestone.label,
        phase: milestone.phase,
        occurrenceCount: milestone.occurrenceCount,
        observedAtMonth: milestone.observedAtMonth,
        evidenceEventIds: milestone.evidenceEventIds,
      })),
      unresolvedEvidenceIds,
      milestones,
    });
  }

  const catalog = {
    definitions: CAPABILITY_MILESTONE_DEFINITIONS.length,
    strict: CAPABILITY_MILESTONE_DEFINITIONS.filter((definition) => definition.support === 'strict').length,
    guarded: CAPABILITY_MILESTONE_DEFINITIONS.filter((definition) => definition.support === 'guarded').length,
    mapDefinitions: CAPABILITY_MILESTONE_DEFINITIONS.filter((definition) => definition.catalogKind === 'map').length,
    worldSpecificDefinitions: CAPABILITY_MILESTONE_DEFINITIONS.filter((definition) => definition.catalogKind === 'world-specific').length,
    capabilityCoordinates: new Set(CAPABILITY_MILESTONE_DEFINITIONS
      .map((definition) => definition.capabilityId)
      .filter((capabilityId) => Number.isInteger(capabilityId))).size,
  };
  const result = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    observerVersion: CAPABILITY_MILESTONE_DEFINITION_VERSION,
    catalog,
    method: 'Read-only reprojection over saved authoritative state; no simulation step and no state write-back.',
    runs,
  };
  const outputPath = path.resolve(outputArgument);
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ outputPath, catalog, runs: runs.map(({ runId, seed, throughMonth, milestoneDefinitionsObserved, capabilityCoordinatesObserved, worldSpecificMilestonesObserved, civilizationIndex, valences, phases, unresolvedEvidenceIds }) => ({ runId, seed, throughMonth, milestoneDefinitionsObserved, capabilityCoordinatesObserved, worldSpecificMilestonesObserved, civilizationIndex, valences, phases, unresolvedEvidenceIds })) }, null, 2)}\n`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
