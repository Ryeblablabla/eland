import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-observer-boundary-month-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');
const childEnvironment = { ...process.env, NODE_OPTIONS: '--max-old-space-size=256' };
const basisField = 'lastMaterializedObserverBasis';

function observerSnapshot(state) {
  const { structures: _structures, ...derivedWithoutStructures } = state.derived;
  return structuredClone({
    civilizationIndex: state.civilization.civilizationIndex,
    stage: state.civilization.stage,
    development: state.civilization.development,
    derivedWithoutStructures,
    hasBasis: Object.prototype.hasOwnProperty.call(state, basisField),
    basis: state[basisField],
  });
}

try {
  writeFileSync(entryPath, [
    `export * from ${JSON.stringify(path.join(workspace, 'server/bounded-observer-boundary-month-controller.ts'))};`,
    `export { createInitialState } from ${JSON.stringify(path.join(workspace, 'src/game/eland/simulation.ts'))};`,
  ].join('\n'));
  execFileSync(path.join(workspace, 'node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { cwd: workspace, env: childEnvironment, stdio: 'pipe' });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  const annual = api.createInitialState(26_082_601, {
    endpoint: { kind: 'months', value: 120 },
    chaosIntensity: 0,
  });
  annual.clock.elapsedMonths = 11;
  annual.derived.structures = [{
    id: 'legacy-materialized-observer-structure',
    name: 'legacy observer only',
    occupiedCells: [0],
    interiorCells: [],
    interiorPositions: [],
    materialIds: [],
    weatherProtection: 0,
    thermalInsulation: 0,
    capacity: 0,
    complete: false,
    sourceEventIds: [],
  }];
  annual[basisField] = {
    fixture: 'exact observer basis must survive the private fact month',
    sourceMonth: 11,
  };
  const annualIdentity = annual;
  const annualObserverBefore = observerSnapshot(annual);
  const annualDerivedBefore = structuredClone(annual.derived);
  const annualResult = api.stepOwnedBoundedObserverBoundaryMonth(annual);
  assert.equal(annualResult.state, annualIdentity, 'controller 必须返回同一个 store-owned state');
  assert.deepEqual(annualResult.receipt, {
    sourceMonth: 11,
    targetMonth: 12,
    kind: 'annual',
    projectCallCount: 1,
  });
  assert.equal(annualResult.state.clock.elapsedMonths, 12);
  assert.equal(annualResult.state.civilization.status, 'running');
  assert.equal(annualResult.state.civilization.outcome, undefined);
  assert.deepEqual(
    observerSnapshot(annualResult.state),
    annualObserverBefore,
    '年度私有事实月只记录 full projector 调用，不得运行或改写 observer',
  );
  assert.deepEqual(
    annualResult.state.derived,
    annualDerivedBefore,
    '月末物理索引刷新不得吞掉 legacy/非空 observer structures 镜像',
  );

  const endpoint = api.createInitialState(26_082_602, {
    endpoint: { kind: 'months', value: 1 },
    chaosIntensity: 0,
  });
  const endpointObserverBefore = observerSnapshot(endpoint);
  const endpointResult = api.stepOwnedBoundedObserverBoundaryMonth(endpoint);
  assert.deepEqual(endpointResult.receipt, {
    sourceMonth: 0,
    targetMonth: 1,
    kind: 'months-endpoint',
    projectCallCount: 1,
  });
  assert.equal(endpointResult.state.civilization.status, 'ended');
  assert.equal(endpointResult.state.civilization.outcome?.kind, 'boundary');
  assert.equal(endpointResult.state.civilization.outcome?.atMonth, 1);
  assert.deepEqual(observerSnapshot(endpointResult.state), endpointObserverBefore);

  const extinction = api.createInitialState(26_082_603, {
    endpoint: { kind: 'months', value: 1 },
    chaosIntensity: 0,
  });
  // The source is still alive. Metabolic deterioration makes the extinction a
  // fact of this exact rule month rather than a delayed bad-source repair.
  for (const person of extinction.people) {
    person.body.health = 1;
    person.body.hydration = 0;
    person.body.nutrition = 0;
  }
  extinction.civilization.externalClimate = {
    epoch: 'chaotic',
    kind: 'fire',
    severity: 10,
    terminalCatastrophe: 'triple-sun-vaporization',
  };
  const extinctionObserverBefore = observerSnapshot(extinction);
  const extinctionResult = api.stepOwnedBoundedObserverBoundaryMonth(extinction);
  assert.equal(
    extinctionResult.receipt.kind,
    'extinction',
    '同月既灭绝又到 endpoint 时，灭绝必须优先分类',
  );
  assert.equal(extinctionResult.state.civilization.status, 'ended');
  assert.equal(extinctionResult.state.civilization.outcome?.kind, 'destroyed');
  assert.deepEqual(observerSnapshot(extinctionResult.state), extinctionObserverBefore);

  const nonBoundary = api.createInitialState(26_082_604, {
    endpoint: { kind: 'months', value: 120 },
    chaosIntensity: 0,
  });
  assert.throws(
    () => api.stepOwnedBoundedObserverBoundaryMonth(nonBoundary),
    /既非年度边界.*未到达 months endpoint/u,
  );
  assert.equal(nonBoundary.clock.elapsedMonths, 0, '非边界拒绝必须发生在规则推进前');
  assert.equal(nonBoundary.civilization.status, 'running');

  const milestoneEndpoint = api.createInitialState(26_082_605, {
    endpoint: { kind: 'milestones', value: 1 },
    chaosIntensity: 0,
  });
  assert.throws(
    () => api.stepOwnedBoundedObserverBoundaryMonth(milestoneEndpoint),
    /拒绝 milestones endpoint/u,
  );
  assert.equal(milestoneEndpoint.clock.elapsedMonths, 0);
  assert.equal(milestoneEndpoint.civilization.status, 'running');

  const memoryUsage = process.memoryUsage();
  assert.ok(memoryUsage.rss < 256 * 1024 * 1024, 'boundary month fixture RSS 不得超过 256 MiB');
  console.log(JSON.stringify({
    result: 'passed',
    annual: annualResult.receipt,
    endpoint: endpointResult.receipt,
    extinction: extinctionResult.receipt,
    rssBytes: memoryUsage.rss,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
