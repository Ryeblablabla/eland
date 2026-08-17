#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [matrixArgument, outputArgument] = process.argv.slice(2);
if (!matrixArgument || !outputArgument) {
  throw new Error('usage: reproject-evolution-facts-report MATRIX_JSON OUTPUT_JSON');
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function numericSummary(values) {
  const present = values.filter(Number.isFinite);
  if (!present.length) return null;
  return {
    count: present.length,
    min: Math.min(...present),
    median: Math.round(median(present) * 100) / 100,
    mean: Math.round(present.reduce((sum, value) => sum + value, 0) / present.length * 100) / 100,
    max: Math.max(...present),
  };
}

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'eland-evolution-report-reprojection-'));
const bundlePath = path.join(temporaryDirectory, 'evolution-report.mjs');

try {
  const entry = `export { buildEvolutionFactsReport } from ${JSON.stringify(path.resolve('server/evolution-artifacts.ts'))};`;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=evolution-report-reprojection.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const { buildEvolutionFactsReport } = await import(`${pathToFileURL(bundlePath).href}?reproject=${Date.now()}`);

  const matrixPath = path.resolve(matrixArgument);
  const outputPath = path.resolve(outputArgument);
  const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
  const runs = [];
  for (const run of matrix.runs ?? []) {
    const runDirectory = path.resolve('data/runs', run.runId);
    const state = JSON.parse(await readFile(path.join(runDirectory, 'state.json'), 'utf8'));
    const evolution = JSON.parse(await readFile(path.join(runDirectory, 'evolution.json'), 'utf8'));
    const report = buildEvolutionFactsReport(state, evolution);
    runs.push({
      ...run,
      ...report,
      runId: run.runId,
      seed: run.seed,
      years: run.years,
      months: run.months,
      repeat: run.repeat,
      status: run.status,
      endedEarly: run.endedEarly,
      outcomeKind: run.outcomeKind,
    });
  }

  const ignoredNumericFields = new Set(['seed', 'years', 'months', 'repeat']);
  const numericFields = [...new Set(runs.flatMap((run) => Object.entries(run)
    .filter(([name, value]) => !ignoredNumericFields.has(name) && Number.isFinite(value))
    .map(([name]) => name)))];
  const aggregates = [...new Set(runs.map((run) => run.years))].sort((a, b) => a - b).map((years) => {
    const group = runs.filter((run) => run.years === years);
    return {
      years,
      runs: group.length,
      completed: group.filter((run) => run.status === 'ended').length,
      endedEarly: group.filter((run) => run.endedEarly).length,
      extinctionRate: group.length
        ? Math.round(group.filter((run) => run.outcomeKind === 'extinction').length / group.length * 10_000) / 100
        : 0,
      ...Object.fromEntries(numericFields.map((name) => [name, numericSummary(group.map((run) => Number(run[name])))])),
    };
  });

  const result = {
    ...matrix,
    generatedAt: new Date().toISOString(),
    observerReprojection: {
      sourceMatrix: matrixPath,
      method: 'Rebuild the deterministic evolution facts report from saved state and evolution artifacts without advancing the simulation.',
    },
    aggregates,
    runs,
  };
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`reprojected ${runs.length} evolution reports to ${outputPath}\n`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
