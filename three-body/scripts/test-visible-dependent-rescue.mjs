import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-visible-dependent-rescue-test-'));
const bundlePath = path.join(temporaryDirectory, 'simulation.mjs');

function neighborAtSameStandingHeight(state, person) {
  const { width, depth, levels, voxels } = state.world.grid;
  const x = person.position.cellId % width;
  const y = Math.floor(person.position.cellId / width);
  const candidates = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
  return candidates.flatMap(([candidateX, candidateY]) => {
    if (candidateX < 0 || candidateY < 0 || candidateX >= width || candidateY >= depth) return [];
    const cellId = candidateY * width + candidateX;
    const feetIndex = person.position.z * width * depth + cellId;
    const headIndex = (person.position.z + 1) * width * depth + cellId;
    const supportIndex = (person.position.z - 1) * width * depth + cellId;
    if (person.position.z <= 0 || person.position.z + 1 >= levels) return [];
    return voxels[feetIndex] === 0 && voxels[headIndex] === 0 && voxels[supportIndex] !== 0
      ? [cellId]
      : [];
  })[0];
}

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/simulation.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  const { createInitialState, stepSimulation } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(20260819, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  state.clock.elapsedMonths = 60;
  state.civilization.externalClimate = { epoch: 'chaotic', kind: 'heat', severity: 5 };
  const [caregiver, dependent] = state.people;
  assert.ok(caregiver && dependent, 'fixture requires a caregiver and a dependent');
  const neighborCell = neighborAtSameStandingHeight(state, caregiver);
  assert.ok(Number.isInteger(neighborCell), 'fixture requires a reachable neighboring standing cell');

  dependent.bornAtMonth = 0;
  dependent.geneticParents = [caregiver.id];
  dependent.position = {
    cellId: neighborCell,
    z: caregiver.position.z,
    previousCellId: neighborCell,
    previousZ: caregiver.position.z,
    lastPath: [neighborCell],
    tickPath: [neighborCell],
  };
  caregiver.body = { health: 100, hydration: 100, nutrition: 100 };
  dependent.body = { health: 100, hydration: 100, nutrition: 100 };
  caregiver.conditions = [];
  dependent.conditions = [];

  const weakDependentState = structuredClone(state);
  const weakCaregiver = weakDependentState.people.find((person) => person.id === caregiver.id);
  const weakDependent = weakDependentState.people.find((person) => person.id === dependent.id);
  weakDependent.body.health = 44;
  weakDependent.conditions = [{
    id: 'test-visible-dependent-heat', kind: 'heat', stage: 3, sinceMonth: 60, sourceEventIds: [],
  }];
  const weakEvolved = stepSimulation(weakDependentState, {
    decide() { return { kind: 'idle', reason: '只观察没有可执行近身帮助时是否追逐' }; },
  });
  assert.equal(weakEvolved.world.past.filter((event) => event.kind === 'action'
    && event.who === weakCaregiver.id
    && event.action.kind === 'move'
    && event.action.toCellId === neighborCell).length, 0,
  '年龄较大的孩子已不适合安全休眠且没有可转移食物时，亲代不得在孩子与住所之间逐刻追逐');

  const evolved = stepSimulation(state, {
    decide() { return { kind: 'idle', reason: '只观察灾害中的可见亲子会合' }; },
  });
  const approach = evolved.world.past.find((event) => event.kind === 'action'
    && event.who === caregiver.id
    && event.action.kind === 'move'
    && event.action.toCellId === neighborCell);
  const protection = evolved.world.past.find((event) => event.kind === 'action'
    && event.who === caregiver.id
    && event.action.kind === 'act'
    && event.action.operation === 'dehydrate'
    && event.diff.assistedDependentId === dependent.id);

  assert.ok(approach, '亲代应先向视野内但未近身的受抚养者移动');
  assert.ok(protection, '会合后应通过真实近身行动辅助受抚养者休眠');
  assert.ok(protection.orderInMonth > approach.orderInMonth, '保护行动必须发生在会合行动之后');
  assert.ok(evolved.people.find((person) => person.id === dependent.id)?.conditions
    .some((condition) => condition.kind === 'dehydrated-hibernation' && condition.sourceEventIds.includes(protection.id)),
  '受助休眠必须写入孩子身体并引用近身行动事实');

  console.log('visible dependent rescue regression passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
