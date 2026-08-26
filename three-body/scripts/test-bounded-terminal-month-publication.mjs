import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-bounded-terminal-month-'));
const dataDirectory = path.join(temporaryDirectory, 'data');
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');
const runnerPath = path.join(workspace, 'scripts/run-bounded-modern-evolution.mjs');
let store;

function runRunner(runId, seed, targetMonth) {
  const child = spawnSync(process.execPath, [
    runnerPath,
    dataDirectory,
    runId,
    String(seed),
    String(targetMonth),
    '2048',
  ], {
    cwd: workspace,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const stdout = child.stdout.trim();
  assert.ok(stdout, `${runId} runner 没有 JSON stdout: ${child.stderr}`);
  return { child, result: JSON.parse(stdout) };
}

try {
  writeFileSync(entryPath, [
    `export { SqliteRunStore } from ${JSON.stringify(path.join(workspace, 'server/sqlite-run-store.ts'))};`,
    `export { createInitialState } from ${JSON.stringify(path.join(workspace, 'src/game/eland/simulation.ts'))};`,
    `export { stepOwnedBoundedObserverBoundaryMonth, stepOwnedBoundedTerminalMonth } from ${JSON.stringify(path.join(workspace, 'server/bounded-observer-boundary-month-controller.ts'))};`,
  ].join('\n'));
  const build = spawnSync(path.join(workspace, 'node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--log-level=error',
    `--outfile=${bundlePath}`,
  ], { cwd: workspace, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
  const overshotEndpoint = api.createInitialState(92_006, {
    endpoint: { kind: 'months', value: 1 }, chaosIntensity: 0,
  });
  overshotEndpoint.clock.elapsedMonths = 1;
  assert.throws(
    () => api.stepOwnedBoundedObserverBoundaryMonth(overshotEndpoint),
    /source 1 已到达 months endpoint 1/u,
  );
  const alreadyExtinctSource = api.createInitialState(92_007, {
    endpoint: { kind: 'months', value: 120 }, chaosIntensity: 0,
  });
  for (const person of alreadyExtinctSource.people) person.body.health = 0;
  assert.throws(
    () => api.stepOwnedBoundedTerminalMonth(alreadyExtinctSource),
    /source 必须仍有活人/u,
  );
  store = new api.SqliteRunStore(dataDirectory);

  async function createRun(runId, seed, endpoint, sourceMonth, extinct) {
    const state = api.createInitialState(seed, { endpoint, chaosIntensity: 0 });
    state.clock.elapsedMonths = sourceMonth;
    if (extinct) {
      for (const person of state.people) {
        person.body.health = 1;
        person.body.hydration = 0;
        person.body.nutrition = 0;
      }
      state.civilization.externalClimate = {
        epoch: 'chaotic',
        kind: 'fire',
        severity: 10,
        terminalCatastrophe: 'triple-sun-vaporization',
      };
    }
    await store.create({ id: runId, state });
    await store.bootstrapBoundedEvolutionContinuation(runId, 2_048);
  }

  await createRun(
    'terminal-nonannual',
    92_001,
    { kind: 'months', value: 120 },
    0,
    true,
  );
  await createRun(
    'terminal-annual',
    92_002,
    { kind: 'months', value: 120 },
    11,
    true,
  );
  await createRun(
    'terminal-endpoint',
    92_003,
    { kind: 'months', value: 12 },
    11,
    false,
  );
  await createRun(
    'terminal-milestones-rejected',
    92_004,
    { kind: 'milestones', value: 999 },
    0,
    false,
  );
  await createRun(
    'terminal-probe-running-rejected',
    92_005,
    { kind: 'months', value: 120 },
    0,
    false,
  );

  await assert.rejects(
    () => store.stageBoundedTerminalMonth('terminal-probe-running-rejected'),
    /terminal probe 重演后文明仍在运行/u,
  );
  const ordinary = await store.publishBoundedNonProjectionMonth(
    await store.stageBoundedNonProjectionMonth('terminal-probe-running-rejected'),
  );
  assert.equal(ordinary.month, 1, '失败的 terminal probe 不得污染普通同源月');
  store.close();
  store = undefined;

  const nonannual = runRunner('terminal-nonannual', 92_001, 10);
  assert.equal(nonannual.child.status, 0, `${nonannual.child.stderr}\n${nonannual.child.stdout}`);
  assert.equal(nonannual.result.ok, true);
  assert.equal(nonannual.result.reachedMonth, 1);
  assert.equal(nonannual.result.reachedTerminalAtMonth, 1);
  assert.equal(nonannual.result.terminalKind, 'extinction');
  assert.equal(nonannual.result.outcome?.kind, 'destroyed');

  const annual = runRunner('terminal-annual', 92_002, 20);
  assert.equal(annual.child.status, 0, `${annual.child.stderr}\n${annual.child.stdout}`);
  assert.equal(annual.result.ok, true);
  assert.equal(annual.result.reachedMonth, 12);
  assert.equal(annual.result.reachedTerminalAtMonth, 12);
  assert.equal(annual.result.terminalKind, 'extinction');
  assert.equal(annual.result.outcome?.kind, 'destroyed');

  const endpoint = runRunner('terminal-endpoint', 92_003, 20);
  assert.equal(endpoint.child.status, 0, `${endpoint.child.stderr}\n${endpoint.child.stdout}`);
  assert.equal(endpoint.result.ok, true);
  assert.equal(endpoint.result.reachedMonth, 12);
  assert.equal(endpoint.result.reachedTerminalAtMonth, 12);
  assert.equal(endpoint.result.terminalKind, 'months-endpoint');
  assert.equal(endpoint.result.outcome?.kind, 'boundary');

  const recovered = runRunner('terminal-nonannual', 92_001, 20);
  assert.equal(recovered.child.status, 0, `${recovered.child.stderr}\n${recovered.child.stdout}`);
  assert.equal(recovered.result.ok, true);
  assert.equal(recovered.result.startMonth, 1);
  assert.equal(recovered.result.reachedMonth, 1);
  assert.equal(recovered.result.reachedTerminalAtMonth, 1);
  assert.equal(recovered.result.terminalKind, 'extinction');

  const milestones = runRunner('terminal-milestones-rejected', 92_004, 1);
  assert.equal(milestones.child.status, 2, milestones.child.stderr);
  assert.equal(milestones.result.ok, false);
  assert.equal(milestones.result.reachedMonth, 0);
  assert.equal(milestones.result.reachedTerminalAtMonth, null);
  assert.equal(milestones.result.terminalKind, null);
  assert.match(milestones.result.stopped?.error ?? '', /拒绝 milestones endpoint/u);

  store = new api.SqliteRunStore(dataDirectory);
  for (const [runId, month, outcomeKind] of [
    ['terminal-nonannual', 1, 'destroyed'],
    ['terminal-annual', 12, 'destroyed'],
    ['terminal-endpoint', 12, 'boundary'],
  ]) {
    const opened = await store.openBoundedEvolutionContinuation(runId);
    assert.equal(opened.meta.elapsedMonths, month);
    assert.equal(opened.meta.status, 'ended');
    assert.equal(opened.state.clock.elapsedMonths, month);
    assert.equal(opened.state.civilization.status, 'ended');
    assert.equal(opened.state.civilization.outcome?.kind, outcomeKind);
    assert.equal(opened.state.civilization.outcome?.atMonth, month);
  }
  for (const [label, stage] of [
    ['ordinary', () => store.stageBoundedNonProjectionMonth('terminal-nonannual')],
    ['scheduled boundary', () => store.stageBoundedObserverBoundaryMonth('terminal-nonannual')],
    ['terminal probe', () => store.stageBoundedTerminalMonth('terminal-nonannual')],
  ]) {
    await assert.rejects(
      stage,
      /不再运行|必须为 running|只接受仍在运行/u,
      `ended run 必须拒绝 ${label} staging`,
    );
  }
  const milestoneSummary = (await store.list())
    .find((summary) => summary.id === 'terminal-milestones-rejected');
  assert.equal(milestoneSummary?.elapsedMonths, 0);
  assert.equal(milestoneSummary?.status, 'running');

  const maxRss = Math.max(
    process.resourceUsage().maxRSS * 1_024,
    nonannual.result.maxRss,
    annual.result.maxRss,
    endpoint.result.maxRss,
    recovered.result.maxRss,
    milestones.result.maxRss,
  );
  console.log(JSON.stringify({
    ok: true,
    terminal: {
      nonannual: { month: nonannual.result.reachedMonth, kind: nonannual.result.terminalKind },
      annual: { month: annual.result.reachedMonth, kind: annual.result.terminalKind },
      endpoint: { month: endpoint.result.reachedMonth, kind: endpoint.result.terminalKind },
      recovered: { startMonth: recovered.result.startMonth, reachedMonth: recovered.result.reachedMonth },
    },
    rejected: [
      'running terminal probe',
      'milestones endpoint',
      'overshot months endpoint source',
      'already extinct source',
      'all three staging APIs after ended publication',
    ],
    maxRss,
  }));
} finally {
  store?.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
