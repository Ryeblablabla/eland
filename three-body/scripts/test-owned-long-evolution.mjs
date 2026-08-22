import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deserialize, serialize } from 'node:v8';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-owned-long-evolution-'));
const controllerBundlePath = path.join(temporaryDirectory, 'controller.mjs');
const lifecycleBundlePath = path.join(temporaryDirectory, 'state-lifecycle.mjs');
const storeBundlePath = path.join(temporaryDirectory, 'sqlite-run-store.mjs');
const serviceBundlePath = path.join(temporaryDirectory, 'run-evolution-service.mjs');
const workerBundlePath = path.join(temporaryDirectory, 'run-evolution-worker.mjs');
const legacyDataDirectory = path.join(temporaryDirectory, 'legacy-data');
const ownedDataDirectory = path.join(temporaryDirectory, 'owned-data');
let legacyStore;
let ownedStore;

function digest(state) {
  return createHash('sha256').update(serialize(state)).digest('hex');
}

function eventOrder(state) {
  return state.world.past.map((event) => ({
    id: event.id,
    kind: event.kind,
    atMonth: event.atMonth,
    orderInMonth: event.orderInMonth,
    planningTick: event.planningTick,
    orderInTick: event.orderInTick,
  }));
}

function assertEquivalent(legacy, owned, label) {
  assert.deepEqual(owned, legacy, `${label}: owned 与 legacy 状态必须深等价`);
  assert.deepEqual(eventOrder(owned), eventOrder(legacy), `${label}: 事实顺序必须一致`);
  assert.deepEqual(
    { seed: owned.seed, branchId: owned.branchId },
    { seed: legacy.seed, branchId: legacy.branchId },
    `${label}: 确定性随机基线必须一致`,
  );
  for (const [name, state] of [['legacy', legacy], ['owned', owned]]) {
    for (const event of state.lastStep) {
      assert.strictEqual(
        state.world.past.find((candidate) => candidate.id === event.id),
        event,
        `${label}: ${name} lastStep 必须回指权威历史事实`,
      );
    }
  }
}

try {
  const esbuild = path.resolve('node_modules/.bin/esbuild');
  execFileSync(esbuild, [
    'src/game/eland/application/simulation/controller.ts',
    '--bundle', '--platform=node', '--format=esm', `--outfile=${controllerBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(esbuild, [
    'src/game/eland/application/simulation/state-lifecycle.ts',
    '--bundle', '--platform=node', '--format=esm', `--outfile=${lifecycleBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(esbuild, [
    'server/sqlite-run-store.ts',
    '--bundle', '--platform=node', '--format=esm', `--outfile=${storeBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(esbuild, [
    'server/run-evolution-worker.ts',
    '--bundle', '--platform=node', '--format=esm', `--outfile=${workerBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(esbuild, [
    'server/run-evolution-service.ts',
    '--bundle', '--platform=node', '--format=esm', `--outfile=${serviceBundlePath}`,
  ], { stdio: 'pipe' });

  const { createSimulation, createSimulationFromOwnedState } = await import(
    `${pathToFileURL(controllerBundlePath).href}?test=${Date.now()}`
  );
  const { createInitialState } = await import(
    `${pathToFileURL(lifecycleBundlePath).href}?test=${Date.now()}`
  );
  const { SqliteRunStore } = await import(
    `${pathToFileURL(storeBundlePath).href}?test=${Date.now()}`
  );
  const { RunEvolutionService } = await import(
    `${pathToFileURL(serviceBundlePath).href}?test=${Date.now()}`
  );

  const fixture = createInitialState(20260815, {
    civilizationNo: 1,
    chaosIntensity: 0,
    climateBias: 'balanced',
    endpoint: { kind: 'months', value: 36 },
  });
  legacyStore = new SqliteRunStore(legacyDataDirectory);
  ownedStore = new SqliteRunStore(ownedDataDirectory);
  const legacyCreated = await legacyStore.create({
    id: 'paired',
    state: structuredClone(fixture),
  });
  const ownedCreated = await ownedStore.create({
    id: 'paired',
    state: structuredClone(fixture),
  });
  assertEquivalent(legacyCreated.state, ownedCreated.state, '创建后');

  const legacyController = createSimulation({ state: legacyCreated.state });
  const ownedInput = ownedCreated.state;
  const ownedController = createSimulationFromOwnedState(ownedInput);
  assert.strictEqual(ownedController.ownedState(), ownedInput, 'owned controller 必须接管原状态引用');

  for (const throughMonth of [12, 24]) {
    const legacyState = legacyController.step(12);
    const ownedState = ownedController.stepOwned(12);
    assert.strictEqual(ownedController.ownedState(), ownedState, 'stepOwned 必须保留 controller 所有权');
    assert.equal(ownedState.clock.elapsedMonths, throughMonth);
    assertEquivalent(legacyState, ownedState, `第 ${throughMonth} 月`);

    if (throughMonth === 12) {
      const roundTrip = (value) => deserialize(serialize(value));
      const rawTail = ownedState.world.past.at(-1);
      const standaloneTail = roundTrip(rawTail);
      const segmentTail = roundTrip([rawTail]).at(-1);
      const boundary = ownedCreated.state.world.past[fixture.world.past.length - 1];
      assert.equal(
        digest(standaloneTail),
        digest(roundTrip(standaloneTail)),
        '单事件 canonicalization 必须幂等',
      );
      assert.equal(
        digest(standaloneTail),
        digest(roundTrip(segmentTail)),
        'raw tail 与 segment roundtrip 后的 canonical 内容必须一致',
      );
      assert.equal(
        digest(boundary),
        digest(roundTrip(boundary)),
        '既有持久化 boundary 必须已经是 canonical 内容',
      );
    }

    const ownedDigestBeforeSave = digest(ownedState);
    await legacyStore.save('paired', legacyState, undefined, { historyMode: 'append' });
    const savedOwned = await ownedStore.save('paired', ownedState, undefined, { historyMode: 'append' });
    assert.strictEqual(savedOwned.state, ownedState, 'SqliteRunStore.save 不得替换 owned 状态引用');
    assert.equal(digest(ownedState), ownedDigestBeforeSave, 'append save 不得修改 owned 状态');

    const [legacyReloaded, ownedReloaded] = await Promise.all([
      legacyStore.load('paired'),
      ownedStore.load('paired'),
    ]);
    assertEquivalent(legacyReloaded.state, ownedReloaded.state, `第 ${throughMonth} 月重载后`);
    assert.deepEqual(ownedReloaded.state, ownedState, 'append save/reload 必须保留全部权威状态');
  }

  const service = new RunEvolutionService(ownedStore);
  await service.evolve('paired', { months: 1 });
  let servicePath;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    servicePath = await ownedStore.loadEvolutionPath('paired');
    if (servicePath?.status !== 'running') break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.equal(servicePath?.status, 'completed', servicePath?.failure ?? 'owned service 必须完成推进');
  assert.equal(servicePath.reachedMonth, 25, 'owned service 不得因同一状态引用误判为未推进');
  assert.equal((await ownedStore.load('paired')).state.clock.elapsedMonths, 25);

  console.log('trusted-owned long evolution parity tests passed');
} finally {
  legacyStore?.close();
  ownedStore?.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
