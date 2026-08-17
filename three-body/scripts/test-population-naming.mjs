import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-population-naming-test-'));
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const profilesBundlePath = path.join(temporaryDirectory, 'character-profiles.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/simulation.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${simulationBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/character-profiles.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${profilesBundlePath}`,
  ], { stdio: 'pipe' });

  const { createInitialState, stepSimulation } = await import(`${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`);
  const { CHARACTER_PROFILES } = await import(`${pathToFileURL(profilesBundlePath).href}?test=${Date.now()}`);

  assert.equal(CHARACTER_PROFILES.filter((profile) => profile.sex === 'female').length, 50);
  assert.equal(CHARACTER_PROFILES.filter((profile) => profile.sex === 'male').length, 51);

  const founders = createInitialState(31, {
    endpoint: { kind: 'months', value: 2 },
    characterIds: ['kongzi', 'wuzetian', 'newton', 'marie-curie', 'thor', 'athena', 'zhaotianli'],
  });
  assert.deepEqual(Object.fromEntries(founders.people.map((person) => [person.id, person.sex])), {
    kongzi: 'male', wuzetian: 'female', newton: 'male', 'marie-curie': 'female',
    thor: 'male', athena: 'female', zhaotianli: 'female',
  });
  const foundersFromAnotherSeed = createInitialState(9_031, {
    endpoint: { kind: 'months', value: 2 },
    characterIds: ['kongzi', 'wuzetian', 'newton', 'marie-curie', 'thor', 'athena', 'zhaotianli'],
  });
  assert.deepEqual(
    Object.fromEntries(foundersFromAnotherSeed.people.map((person) => [person.id, person.sex])),
    Object.fromEntries(founders.people.map((person) => [person.id, person.sex])),
    '先民的真实性别不能随世界种子改变',
  );

  const deliver = (seed, characterIds, motherId, fatherId) => {
    const state = createInitialState(seed, {
      endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0, characterIds,
    });
    state.civilization.externalClimate = { epoch: 'stable', kind: 'temperate', severity: 0 };
    for (const person of state.people) {
      person.body = { health: 100, hydration: 100, nutrition: 100 };
      person.conditions = [];
    }
    const mother = state.people.find((person) => person.id === motherId);
    const father = state.people.find((person) => person.id === fatherId);
    assert.ok(mother && father);
    mother.conditions.push({
      id: `test-pregnancy-${seed}`, kind: 'pregnancy', stage: 3, sinceMonth: -8, dueAtMonth: 1,
      otherPersonId: father.id, sourceEventIds: [`test-conception-${seed}`],
    });
    const afterBirth = stepSimulation(state, { decide() { return { kind: 'idle', reason: '聚焦验证出生姓名' }; } });
    const child = afterBirth.people.find((person) => person.generation > 0);
    const birthEvent = afterBirth.world.past.find((event) => event.kind === 'environment' && event.diff.bornPersonId === child?.id);
    assert.ok(child && birthEvent);
    assert.equal(child.familyName, father.familyName);
    assert.equal(birthEvent.diff.bornPersonName, child.name);
    assert.ok(!child.name.startsWith('新生儿'));
    return child;
  };

  const easternChild = deliver(312, ['kongzi', 'wuzetian'], 'wuzetian', 'kongzi');
  assert.equal(easternChild.namingTradition, 'eastern');
  assert.match(easternChild.name, /^孔.+/);

  const westernChild = deliver(1_312, ['newton', 'marie-curie'], 'marie-curie', 'newton');
  assert.equal(westernChild.namingTradition, 'western');
  assert.match(westernChild.name, /^[^·]+·牛顿$/);

  const replayedEasternChild = deliver(312, ['kongzi', 'wuzetian'], 'wuzetian', 'kongzi');
  assert.equal(replayedEasternChild.name, easternChild.name, '同一种子与出生事实必须生成同一个姓名');
  const anotherEasternChild = deliver(313, ['kongzi', 'wuzetian'], 'wuzetian', 'kongzi');
  assert.notEqual(anotherEasternChild.name, easternChild.name, '不同世界种子应能生成不同的随机名');

  console.log(`population naming passed: ${easternChild.name}, ${westernChild.name}`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
