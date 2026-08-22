import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-requiem-'));
const settlementBundle = path.join(temporaryDirectory, 'settlement.mjs');
const requiemBundle = path.join(temporaryDirectory, 'requiem.mjs');

try {
  for (const [entry, output] of [
    ['src/game/eland/application/civilization-settlement.ts', settlementBundle],
    ['server/civilization-requiem-service.ts', requiemBundle],
  ]) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
    ], { stdio: 'pipe' });
  }

  const { concludeOwnedCivilization } = await import(`${pathToFileURL(settlementBundle).href}?test=${Date.now()}`);
  const {
    createLocalCivilizationRequiem,
    validateCivilizationRequiemGrounding,
  } = await import(`${pathToFileURL(requiemBundle).href}?test=${Date.now()}`);

  const state = {
    branchId: 'root-test-44',
    clock: { elapsedMonths: 27 },
    civilization: { number: 44, status: 'running' },
    people: [
      { id: 'a', name: '武则天', body: { health: 80 }, position: { cellId: 12 } },
      { id: 'b', name: '爱丽丝', body: { health: 62 }, position: { cellId: 12 } },
      { id: 'c', name: '旧人', body: { health: 0 }, diedAtMonth: 20, position: { cellId: 8 } },
    ],
    world: { past: [] },
    lastStep: [],
  };
  const peopleBefore = structuredClone(state.people);
  const events = concludeOwnedCivilization(state);
  assert.equal(state.civilization.status, 'ended');
  assert.deepEqual(state.people, peopleBefore, '手动结算不能改变人物身体或伪造死亡');
  assert.deepEqual(state.civilization.outcome, {
    kind: 'concluded', cause: '观察者主动结算', atMonth: 27,
    summary: '观察者在第 27 月结束了这次演化；当时仍有 2 人存活，所有已发生的历史被原样保留。',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].diff.livingPeople, 2);
  concludeOwnedCivilization(state);
  assert.equal(state.world.past.length, 1, '重复结算必须幂等');

  const facts = {
    civilizationId: 44,
    branchId: 'root-test-44',
    endedAtMonth: 27,
    endingKind: 'concluded',
    cause: '观察者主动结算',
    authoritativeSummary: state.civilization.outcome.summary,
    stage: '早期定居',
    livingPeople: 2,
    totalPeople: 3,
    names: ['武则天', '爱丽丝', '旧人'],
    milestones: ['学会保存食物', '建立公共住所'],
    chronicle: [{ month: 27, text: '第 44 号文明由观察者结算。', sourceEventIds: [events[0].id] }],
  };
  const pastoral = createLocalCivilizationRequiem(facts, 'pastoral-chronicle');
  const refrain = createLocalCivilizationRequiem(facts, 'classic-refrain');
  assert.equal(pastoral.source, 'local-fallback');
  assert.equal(pastoral.lines.length, 16);
  assert.ok(pastoral.lines.some((line) => line.text.includes('仍有2个人')));
  assert.deepEqual(pastoral.sourceEventIds, [events[0].id]);
  assert.notDeepEqual(refrain.lines, pastoral.lines, '内置诗风必须产生不同的演出文本');
  assert.equal(pastoral.schemaVersion, 4);
  assert.equal(pastoral.id, 'requiem-v4:44:root-test-44:27');
  assert.throws(
    () => validateCivilizationRequiemGrounding('他们把历史压缩成二进制文件', facts),
    /系统词/u,
  );
  assert.throws(
    () => validateCivilizationRequiemGrounding('没有墓碑，只有星光', facts),
    /无来源事物/u,
    '否定句也不能偷渡未发生的事物',
  );
  assert.doesNotThrow(
    () => validateCivilizationRequiemGrounding('星光越过他们最后的月份', facts),
    '非事实性的宇宙意象可以保留',
  );

  console.log('civilization settlement and requiem tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
