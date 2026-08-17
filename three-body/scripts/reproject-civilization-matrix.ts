import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  CIVILIZATION_INDEX_FORMULA_VERSION,
  calculateCivilizationIndex,
  civilizationStageFor,
} from '../src/game/eland/domain/civilization-index';
import type {
  CivilizationIndex,
  SimulationState,
} from '../src/game/eland/domain/model';
import { hydrateWorld } from '../src/game/eland/world/grid';

interface MatrixRun {
  runId: string;
  seed: number;
  years: number;
  repeat: number;
  civilizationIndex: number | null;
  civilizationComponents: Record<string, number>;
  [key: string]: unknown;
}

interface MatrixArtifact {
  schemaVersion: number;
  generatedAt: string;
  experiment: {
    prefix: string;
    years: number[];
    [key: string]: unknown;
  };
  aggregates: Array<Record<string, unknown>>;
  runs: MatrixRun[];
  [key: string]: unknown;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function numericSummary(values: number[]): Record<string, number> | null {
  const present = values.filter(Number.isFinite);
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

function componentScores(index: CivilizationIndex): Record<string, number> {
  return Object.fromEntries(Object.entries(index.components).map(([key, component]) => [key, component.score]));
}

async function main(): Promise<void> {
  const [baselineArgument, outputArgument] = process.argv.slice(2);
  if (!baselineArgument || !outputArgument) {
    throw new Error('usage: reproject-civilization-matrix BASELINE_JSON OUTPUT_JSON');
  }
  const baselinePath = resolve(baselineArgument);
  const outputPath = resolve(outputArgument);
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as MatrixArtifact;
  const baselinePrefix = baseline.experiment.prefix;
  const candidatePrefix = `${baselinePrefix.replace(/baseline[^-]*/i, 'candidate')}-projected`;
  const projectedRuns: MatrixRun[] = [];

  for (const run of baseline.runs) {
    const statePath = resolve('data/runs', run.runId, 'state.json');
    const rawState = JSON.parse(await readFile(statePath, 'utf8')) as SimulationState;
    const state = structuredClone(rawState);
    state.world.grid = hydrateWorld(rawState.world.grid);
    const index = calculateCivilizationIndex(state);
    projectedRuns.push({
      ...run,
      runId: run.runId.replace(baselinePrefix, candidatePrefix),
      civilizationIndex: index.total,
      civilizationComponents: componentScores(index),
      civilizationStage: civilizationStageFor(index),
      civilizationEvidence: Object.fromEntries(Object.entries(index.components)
        .map(([key, component]) => [key, component.evidence])),
      sourceRunId: run.runId,
    });
  }

  const aggregates = baseline.aggregates.map((aggregate) => {
    const years = Number(aggregate.years);
    const group = projectedRuns.filter((run) => run.years === years);
    const componentKeys = Object.keys(group[0]?.civilizationComponents ?? {});
    return {
      ...aggregate,
      civilizationIndex: numericSummary(group.map((run) => Number(run.civilizationIndex))),
      civilizationComponents: Object.fromEntries(componentKeys.map((key) => [
        key,
        numericSummary(group.map((run) => Number(run.civilizationComponents[key]))),
      ])),
      civilizationStages: Object.fromEntries([...new Set(group.map((run) => String(run.civilizationStage)))]
        .sort()
        .map((stage) => [stage, group.filter((run) => run.civilizationStage === stage).length])),
    };
  });

  const result: MatrixArtifact = {
    ...baseline,
    generatedAt: new Date().toISOString(),
    experiment: {
      ...baseline.experiment,
      prefix: candidatePrefix,
      baseUrl: 'observer-reprojection',
    },
    metricVersions: { civilizationIndex: CIVILIZATION_INDEX_FORMULA_VERSION },
    reprojectionProvenance: {
      sourceMatrix: baselinePath,
      sourcePrefix: baselinePrefix,
      method: 'Load each freshly rerun endpoint state, hydrate only its saved voxel grid, and recalculate the observer-only civilization index without advancing time or re-deriving observations.',
      behaviorEquivalenceCheck: 'A paired seed=6101, years=10 rerun matched authoritative and derived state histories exactly.',
    },
    aggregates,
    runs: projectedRuns,
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`reprojected ${projectedRuns.length} endpoints to ${outputPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
