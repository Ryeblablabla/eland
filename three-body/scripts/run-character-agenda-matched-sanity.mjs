import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve('..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-agenda-matched-'));
const baselineRoot = path.join(temporaryDirectory, 'baseline');
const archivePath = path.join(temporaryDirectory, 'baseline.tar');
const baselineBundlePath = path.join(temporaryDirectory, 'baseline.mjs');
const candidateBundlePath = path.join(temporaryDirectory, 'candidate.mjs');
const seeds = [185, 20260815, 20260816];
const months = 120;

function bundle(source, output) {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    source, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
  ], { stdio: 'pipe' });
}

function countBy(values, key) {
  return values.reduce((counts, value) => {
    const label = String(key(value));
    counts[label] = (counts[label] ?? 0) + 1;
    return counts;
  }, {});
}

function summarize(state) {
  const events = state.world.past;
  const actions = events.filter((event) => event.kind === 'action');
  const decisions = events.filter((event) => event.kind === 'decision');
  const agendaItems = state.people.flatMap((person) => person.characterAgenda?.items ?? []);
  const approaches = agendaItems.flatMap((item) => item.approaches);
  return {
    elapsedMonths: state.clock.elapsedMonths,
    civilizationStatus: state.civilization.status,
    outcomeKind: state.civilization.outcome?.kind ?? null,
    livingPeople: state.people.filter((person) => person.diedAtMonth === undefined && person.body.health > 0).length,
    peopleTotal: state.people.length,
    eventCount: events.length,
    decisions: decisions.length,
    idleDecisions: decisions.filter((event) => event.decision.kind === 'idle').length,
    actions: actions.length,
    actionStatuses: countBy(actions, (event) => event.status),
    intents: state.intents.length,
    intentStatuses: countBy(state.intents, (intent) => intent.status),
    projects: state.projects.length,
    projectStatuses: countBy(state.projects, (project) => project.status),
    milestones: state.derived?.milestones?.length ?? 0,
    agenda: {
      items: agendaItems.length,
      statuses: countBy(agendaItems, (item) => item.status),
      itemsLinkedToMultipleIntents: agendaItems.filter((item) => item.intentIds.length > 1).length,
      linkedIntentCount: agendaItems.reduce((sum, item) => sum + item.intentIds.length, 0),
      approaches: approaches.length,
      evaluatedApproaches: approaches.filter((approach) => approach.evaluations.length > 0).length,
      outcomes: countBy(approaches.filter((approach) => approach.latestOutcome), (approach) => approach.latestOutcome),
      aimsRetainedAfterFailedMeans: agendaItems.filter((item) => item.approaches.some((approach) => (
        approach.latestOutcome === 'blocked' || approach.latestOutcome === 'refuted'
      )) && item.status !== 'abandoned').length,
    },
  };
}

function run(simulation, seed) {
  let state = simulation.createInitialState(seed, {
    endpoint: { kind: 'months', value: months },
  });
  while (state.civilization.status === 'running' && state.clock.elapsedMonths < months) {
    state = simulation.stepSimulation(state);
  }
  return summarize(state);
}

try {
  mkdirSync(baselineRoot, { recursive: true });
  writeFileSync(
    archivePath,
    execFileSync('git', ['archive', '--format=tar', 'HEAD:three-body'], {
      cwd: repositoryRoot,
      maxBuffer: 256 * 1024 * 1024,
    }),
  );
  execFileSync('tar', ['-xf', archivePath, '-C', baselineRoot]);
  bundle(path.join(baselineRoot, 'src/game/eland/simulation.ts'), baselineBundlePath);
  bundle('src/game/eland/simulation.ts', candidateBundlePath);
  const nonce = Date.now();
  const baseline = await import(`${pathToFileURL(baselineBundlePath).href}?matched=${nonce}`);
  const candidate = await import(`${pathToFileURL(candidateBundlePath).href}?matched=${nonce}`);
  const startedAt = performance.now();
  const pairs = seeds.map((seed) => ({
    seed,
    baseline: run(baseline, seed),
    candidate: run(candidate, seed),
  }));
  const artifact = {
    experiment: 'character-agenda-matched-local-sanity-v1',
    generatedAt: new Date().toISOString(),
    baseline: 'git HEAD',
    candidate: 'current workspace',
    months,
    seeds,
    runtimeMs: Math.round(performance.now() - startedAt),
    pairs,
  };
  const artifactDirectory = path.resolve('data/experiments');
  mkdirSync(artifactDirectory, { recursive: true });
  const artifactPath = path.join(
    artifactDirectory,
    `character-agenda-matched-${artifact.generatedAt.replace(/[:.]/gu, '-')}.json`,
  );
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ artifactPath, ...artifact }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
