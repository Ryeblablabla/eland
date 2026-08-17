#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const [baselineArg, candidateArg, outputArg] = process.argv.slice(2);
if (!baselineArg || !candidateArg || !outputArg) {
  throw new Error('usage: verify-observer-equivalence BASELINE_STATE CANDIDATE_STATE OUTPUT_JSON');
}

const [baseline, candidate] = await Promise.all([
  readFile(resolve(baselineArg), 'utf8').then(JSON.parse),
  readFile(resolve(candidateArg), 'utf8').then(JSON.parse),
]);

const authoritativeView = (state) => {
  const { civilizationIndex: _index, stage: _stage, ...civilization } = state.civilization;
  return {
    schemaVersion: state.schemaVersion,
    seed: state.seed,
    clock: state.clock,
    people: state.people,
    world: state.world,
    projects: state.projects,
    agreements: state.agreements,
    records: state.records,
    collectives: state.collectives,
    permissions: state.permissions,
    containers: state.containers,
    eraPredictions: state.eraPredictions,
    intents: state.intents,
    derived: state.derived,
    civilization,
  };
};

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const baselineView = authoritativeView(baseline);
const candidateView = authoritativeView(candidate);
const baselineHash = digest(baselineView);
const candidateHash = digest(candidateView);
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  baselineState: resolve(baselineArg),
  candidateState: resolve(candidateArg),
  ignoredObserverFields: ['civilization.civilizationIndex', 'civilization.stage'],
  equal: baselineHash === candidateHash,
  baselineHash,
  candidateHash,
  counts: {
    events: baseline.world?.past?.length ?? 0,
    people: baseline.people?.length ?? 0,
    projects: baseline.projects?.length ?? 0,
    agreements: baseline.agreements?.length ?? 0,
    records: baseline.records?.length ?? 0,
  },
};

const outputPath = resolve(outputArg);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.equal) process.exitCode = 1;
