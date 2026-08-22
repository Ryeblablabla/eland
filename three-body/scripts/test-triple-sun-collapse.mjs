import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-triple-sun-collapse-test-'));
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const adapterBundlePath = path.join(temporaryDirectory, 'adapter.mjs');

try {
  for (const [entry, output] of [
    ['src/game/eland/simulation.ts', simulationBundlePath],
    ['src/game/eland/adapter.ts', adapterBundlePath],
  ]) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
    ], { stdio: 'pipe' });
  }

  const { createSimulation } = await import(`${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`);
  const { ERA_TO_ENV } = await import(`${pathToFileURL(adapterBundlePath).href}?test=${Date.now()}`);

  assert.deepEqual(ERA_TO_ENV.burned, {
    epoch: 'chaotic',
    kind: 'fire',
    severity: 10,
    terminalCatastrophe: 'triple-sun-vaporization',
  }, 'burned 天象必须携带三日凌空终局语义');
  assert.equal(ERA_TO_ENV.extinct.terminalCatastrophe, undefined,
    '其他宇宙终局不能借用三日凌空语义');

  const ordinaryFire = createSimulation({
    seed: 20260815,
    config: { endpoint: { kind: 'months', value: 120 } },
  });
  ordinaryFire.setExternalClimate('chaotic', 'fire', 10);
  const ordinaryFireState = ordinaryFire.stepOwned();
  assert.equal(ordinaryFireState.civilization.status, 'running',
    '没有三日凌空来源的普通烈火强度 10 仍须按身体规则结算');
  assert.ok(ordinaryFireState.people.some((person) => person.diedAtMonth === undefined));
  assert.equal(ordinaryFireState.lastStep.some((event) => (
    event.kind === 'environment' && event.diff.cause === 'triple-sun-vaporization'
  )), false);

  const controller = createSimulation({
    seed: 185,
    config: { endpoint: { kind: 'months', value: 120 } },
  });
  controller.stepOwned();
  const before = controller.getState();
  const livingBefore = before.people.filter((person) => person.diedAtMonth === undefined);
  const activeIntentIds = before.intents
    .filter((intent) => intent.status === 'active' || intent.status === 'suspended')
    .map((intent) => intent.id);
  const dropsBefore = structuredClone(before.world.drops);

  controller.setExternalClimate('chaotic', 'fire', 10, 'triple-sun-vaporization');
  const ended = controller.stepOwned();
  const terminalMonth = before.clock.elapsedMonths + 1;
  const catastrophe = ended.lastStep.find((event) => (
    event.kind === 'environment'
      && event.diff.terminalCatastrophe === 'triple-sun-vaporization'
  ));
  const vaporizationDeaths = ended.lastStep.filter((event) => (
    event.kind === 'environment'
      && event.change === 'death'
      && event.diff.cause === 'triple-sun-vaporization'
  ));

  assert.ok(catastrophe, '权威历史必须保存三日凌空灾变事实');
  assert.equal(catastrophe.planningTick, 1);
  assert.equal(ended.clock.elapsedMonths, terminalMonth);
  assert.equal(ended.civilization.status, 'ended');
  assert.equal(ended.civilization.outcome?.kind, 'destroyed');
  assert.equal(ended.civilization.outcome?.cause, '三日凌空');
  assert.match(ended.civilization.outcome?.summary ?? '', /第一个规划刻度内全部汽化/u);
  assert.equal(vaporizationDeaths.length, livingBefore.length);
  assert.equal(ended.people.filter((person) => person.diedAtMonth === undefined).length, 0,
    '三日凌空结算后不能留下任何存活人物');
  assert.equal(ended.lastStep.some((event) => event.kind === 'action' || event.kind === 'decision'), false,
    '三日凌空月不得在汽化前后提交人物行动或决定');
  assert.equal(ended.lastStep.some((event) => event.kind === 'decision-opportunity'), false,
    '三日凌空月不得再为人物生成决策机会');
  assert.ok(vaporizationDeaths.every((event) => (
    event.planningTick === 1
      && event.diff.vaporized === true
      && event.diff.remainsCreated === false
      && Array.isArray(event.diff.sourceEventIds)
      && event.diff.sourceEventIds.includes(catastrophe.id)
  )));
  assert.deepEqual(ended.world.drops, dropsBefore,
    '汽化后的随身库存不得转化为普通死亡遗物');

  const vaporizedPersonIds = new Set(livingBefore.map((person) => person.id));
  assert.ok(ended.people.filter((person) => vaporizedPersonIds.has(person.id)).every((person) => (
    person.diedAtMonth === terminalMonth && person.body.health === 0 && person.inventory.length === 0
  )));
  assert.equal((ended.world.remains ?? []).some((remains) => vaporizedPersonIds.has(remains.personId)), false,
    '汽化者不能生成遗体');
  assert.ok(ended.intents.filter((intent) => activeIntentIds.includes(intent.id)).every((intent) => (
    intent.status === 'failed' && intent.goalOutcome
  )), '三日凌空仍须结算人物当前及暂停意图的 goalOutcome');

  console.log('triple-sun terminal catastrophe tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
