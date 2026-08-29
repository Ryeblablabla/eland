import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const orchestratorPath = path.join(import.meta.dirname, 'run-staged-bounded-terminal-matrix.mjs');
const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'eland-staged-terminal-matrix-fixture-'));

function fakeRunnerSource() {
  return `
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [dataDirectory, runId, seedInput, targetInput, hotLimitInput, stopMode] = process.argv.slice(2);
const tracker = process.env.FAKE_MATRIX_TRACKER;
assert.equal(typeof tracker, 'string');
assert.equal(stopMode, undefined, 'fixture runner must never receive stop-on-modern');
const seed = Number(seedInput);
const targetMonth = Number(targetInput);
const hotEventLimit = Number(hotLimitInput);
appendFileSync(tracker, JSON.stringify({ type: 'runner-start', pid: process.pid, runId, seed, targetMonth }) + '\\n');
try {
  await new Promise((resolve) => setTimeout(resolve, 35));
  mkdirSync(dataDirectory, { recursive: true });
  const statePath = path.join(dataDirectory, 'fake-authority.json');
  const created = !existsSync(statePath);
  const state = created
    ? { runId, seed, month: 0, revision: 0, lineageId: 'fixture-lineage-' + seed, terminalMonth: null, terminalKind: null }
    : JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.runId, runId);
  assert.equal(state.seed, seed);
  const startMonth = state.month;
  const configuredTerminal = process.env.FAKE_TERMINAL_AT
    ? Number(process.env.FAKE_TERMINAL_AT)
    : null;
  if (state.terminalMonth === null && configuredTerminal !== null && targetMonth >= configuredTerminal) {
    state.month = configuredTerminal;
    state.terminalMonth = configuredTerminal;
    state.terminalKind = 'extinction';
  } else if (state.terminalMonth === null) {
    state.month = targetMonth;
  }
  state.revision += 1;
  state.hotEventLimit = hotEventLimit;
  writeFileSync(statePath, JSON.stringify(state));
  process.stderr.write(JSON.stringify({ fakeProgress: true, runId, targetMonth, reachedMonth: state.month }) + '\\n');
  process.stdout.write(JSON.stringify({
    ok: true,
    runId,
    seed,
    created,
    startMonth,
    targetMonth,
    reachedMonth: state.month,
    reachedModernAtMonth: null,
    reachedTerminalAtMonth: state.terminalMonth,
    terminalKind: state.terminalKind,
    stopOnModern: false,
    hotEventLimit,
  }) + '\\n');
} finally {
  appendFileSync(tracker, JSON.stringify({ type: 'runner-end', pid: process.pid, runId, seed, targetMonth }) + '\\n');
}
`;
}

function fakeExtractorSource() {
  return `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [dataDirectory, runId, expectedMonthInput, outputRoot] = process.argv.slice(2);
const expectedMonth = Number(expectedMonthInput);
const state = JSON.parse(readFileSync(path.join(dataDirectory, 'fake-authority.json'), 'utf8'));
assert.equal(state.runId, runId);
assert.equal(state.month, expectedMonth);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const authority = {
  runId,
  revision: state.revision,
  month: state.month,
  stateHash: hash('state:' + runId + ':' + state.month),
  lineageId: state.lineageId,
  eventCount: state.month,
  hotEventLimit: state.hotEventLimit,
  status: state.terminalMonth === null ? 'running' : 'ended',
};
const packHash = hash(JSON.stringify(authority));
const pack = {
  schema: 'fake-bounded-horizon-evidence-v1',
  authority,
  integrity: { algorithm: 'sha256', hash: packHash },
};
const directory = path.join(outputRoot, 'packs', runId);
mkdirSync(directory, { recursive: true });
const packPath = path.join(directory, 'month-' + String(expectedMonth).padStart(5, '0') + '-' + packHash + '.json');
writeFileSync(packPath, JSON.stringify(pack) + '\\n');
process.stdout.write(JSON.stringify({
  ok: true,
  schema: pack.schema,
  runId,
  month: expectedMonth,
  authority,
  packHash,
  packPath,
  preservedChunkCount: 0,
}) + '\\n');
`;
}

function makeScenario(name) {
  const root = path.join(temporaryRoot, name);
  const fakeDirectory = path.join(root, 'fake');
  mkdirSync(fakeDirectory, { recursive: true });
  const runnerPath = path.join(fakeDirectory, 'runner.mjs');
  const extractorPath = path.join(fakeDirectory, 'extractor.mjs');
  writeFileSync(runnerPath, fakeRunnerSource());
  writeFileSync(extractorPath, fakeExtractorSource());
  return {
    root,
    runnerPath,
    extractorPath,
    dataRoot: path.join(root, 'data'),
    evidenceRoot: path.join(root, 'evidence'),
    manifestPath: path.join(root, 'manifest.json'),
    trackerPath: path.join(root, 'runner-events.jsonl'),
  };
}

function invoke(scenario, prefix, extraEnvironment = {}) {
  const child = spawnSync(process.execPath, [
    orchestratorPath,
    '--data-root', scenario.dataRoot,
    '--evidence-root', scenario.evidenceRoot,
    '--manifest', scenario.manifestPath,
    '--prefix', prefix,
    '--seeds', '11,22,33',
    '--hot-limit', '64',
  ], {
    encoding: 'utf8',
    maxBuffer: 64 * 1_024 * 1_024,
    timeout: 120_000,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ELAND_STAGED_MATRIX_RUNNER_FOR_TESTS: scenario.runnerPath,
      ELAND_STAGED_MATRIX_EXTRACTOR_FOR_TESTS: scenario.extractorPath,
      FAKE_MATRIX_TRACKER: scenario.trackerPath,
      ...extraEnvironment,
    },
  });
  assert.notEqual(child.error?.code, 'ETIMEDOUT', 'orchestrator fixture timed out');
  return child;
}

function parseOnlyResult(child) {
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  const lines = child.stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  assert.equal(lines.length, 1, `orchestrator stdout expected one result, got ${lines.length}`);
  return JSON.parse(lines[0]);
}

function readManifest(scenario) {
  return JSON.parse(readFileSync(scenario.manifestPath, 'utf8'));
}

function runnerEvents(scenario) {
  return readFileSync(scenario.trackerPath, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function maxConcurrentRunners(events) {
  let active = 0;
  let maximum = 0;
  for (const event of events) {
    if (event.type === 'runner-start') {
      active += 1;
      maximum = Math.max(maximum, active);
    } else if (event.type === 'runner-end') {
      active -= 1;
      assert.equal(active >= 0, true, 'runner event order underflow');
    }
  }
  assert.equal(active, 0, 'runner event log has an unclosed child');
  return maximum;
}

function runnerStarts(events) {
  return events.filter((event) => event.type === 'runner-start');
}

function testTwoPhaseResumeAndSerialExecution() {
  const scenario = makeScenario('normal-resume');
  const first = parseOnlyResult(invoke(scenario, 'fixture-normal', {
    ELAND_STAGED_MATRIX_MAX_COMPLETED_STAGES_FOR_TESTS: '2',
  }));
  assert.equal(first.completed, false);
  assert.equal(first.pausedForTest, true);
  assert.equal(first.completedStageCount, 2);
  const afterFirst = readManifest(scenario);
  assert.deepEqual(afterFirst.runs[0].stages.slice(0, 2).map((stage) => stage.state), ['completed', 'completed']);
  assert.equal(afterFirst.runs[0].stages[2].state, 'pending');
  assert.equal(afterFirst.runs[0].stages[0].runner.runId, afterFirst.runs[0].runId);
  assert.equal(afterFirst.runs[0].stages[1].runner.runId, afterFirst.runs[0].runId);

  const resumed = parseOnlyResult(invoke(scenario, 'fixture-normal'));
  assert.equal(resumed.completed, true);
  assert.equal(resumed.completedStageCount, 15);
  const manifest = readManifest(scenario);
  assert.equal(manifest.status, 'completed');
  for (const run of manifest.runs) {
    assert.equal(new Set(run.stages.map((stage) => stage.runner.runId)).size, 1, 'one seed must keep one run id');
    assert.equal(run.stages.every((stage) => stage.horizonEvidence.status === 'present'), true);
    assert.deepEqual(run.stages.map((stage) => stage.runner.startMonth), [0, 120, 360, 600, 1_200]);
    assert.deepEqual(run.stages.map((stage) => stage.runner.reachedMonth), [120, 360, 600, 1_200, 12_000]);
    assert.equal(run.stages.every((stage) => stage.horizonEvidence.authority.lineageId === run.lineageId), true);
  }
  const events = runnerEvents(scenario);
  assert.equal(maxConcurrentRunners(events), 1, 'runner children must be strictly serial');
  const starts = runnerStarts(events);
  assert.equal(starts.length, 15, 'resume must not rerun the two completed stages');
  for (const runId of manifest.runs.map((run) => run.runId)) {
    assert.deepEqual(
      starts.filter((event) => event.runId === runId).map((event) => event.targetMonth),
      [120, 360, 600, 1_200, 12_000],
    );
  }
  return { completedStages: resumed.completedStageCount, maxConcurrent: maxConcurrentRunners(events) };
}

function testEarlyTerminalMissingHorizons() {
  const scenario = makeScenario('early-terminal');
  const result = parseOnlyResult(invoke(scenario, 'fixture-early', { FAKE_TERMINAL_AT: '200' }));
  assert.equal(result.completed, true);
  assert.equal(result.missingHorizonCount, 12);
  const manifest = readManifest(scenario);
  for (const run of manifest.runs) {
    assert.equal(run.terminal.month, 200);
    assert.equal(run.terminal.evidence.month, 200);
    assert.equal(run.stages[0].horizonEvidence.status, 'present');
    assert.equal(run.stages[0].horizonEvidence.month, 120);
    assert.equal(run.stages[1].horizonEvidence.status, 'missing');
    assert.equal(run.stages[1].horizonEvidence.reason, 'early-ended');
    assert.equal(run.stages[1].horizonEvidence.disposition, 'terminal-before-horizon');
    assert.equal(run.stages[1].horizonEvidence.terminalMonth, 200);
    assert.equal(run.stages[1].terminalEvidence.month, 200);
    for (const stage of run.stages.slice(2)) {
      assert.equal(stage.horizonEvidence.status, 'missing');
      assert.equal(stage.horizonEvidence.requestedMonth, stage.horizonMonth);
      assert.equal(stage.horizonEvidence.terminalEvidence.month, 200);
      assert.equal('runner' in stage, false, 'post-terminal missing horizon must not invoke runner');
    }
    const packNames = readdirSync(path.join(scenario.evidenceRoot, 'packs', run.runId)).sort();
    assert.equal(packNames.length, 2, 'terminal pack must be extracted exactly once in addition to month 120');
    assert.equal(packNames.some((name) => name.startsWith('month-00120-')), true);
    assert.equal(packNames.some((name) => name.startsWith('month-00200-')), true);
    assert.equal(packNames.some((name) => name.startsWith('month-00360-')), false, 'terminal pack must not impersonate horizon 360');
  }
  const starts = runnerStarts(runnerEvents(scenario));
  assert.equal(starts.length, 6);
  assert.equal(maxConcurrentRunners(runnerEvents(scenario)), 1);
  return { missingHorizons: result.missingHorizonCount, runnerCalls: starts.length };
}

function testFingerprintDriftRefusal() {
  const scenario = makeScenario('fingerprint-drift');
  const first = parseOnlyResult(invoke(scenario, 'fixture-drift', {
    ELAND_STAGED_MATRIX_MAX_COMPLETED_STAGES_FOR_TESTS: '1',
  }));
  assert.equal(first.completedStageCount, 1);
  const callsBefore = runnerStarts(runnerEvents(scenario)).length;
  appendFileSync(scenario.runnerPath, '\n// deliberate fixture fingerprint drift\n');
  const refused = invoke(scenario, 'fixture-drift');
  assert.notEqual(refused.status, 0, 'changed runner fingerprint must be rejected');
  assert.match(refused.stderr, /source seal fingerprint.*漂移/u);
  assert.equal(runnerStarts(runnerEvents(scenario)).length, callsBefore, 'drift refusal must happen before another runner');
  const manifest = readManifest(scenario);
  assert.equal(manifest.status, 'running');
  assert.equal(manifest.runs[0].stages[0].state, 'completed');
  assert.equal(manifest.runs[0].stages[1].state, 'pending');
  return { runnerCallsBeforeRefusal: callsBefore, refusedExit: refused.status };
}

try {
  const normal = testTwoPhaseResumeAndSerialExecution();
  const earlyTerminal = testEarlyTerminalMissingHorizons();
  const fingerprintDrift = testFingerprintDriftRefusal();
  process.stdout.write(`${JSON.stringify({ ok: true, normal, earlyTerminal, fingerprintDrift })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
