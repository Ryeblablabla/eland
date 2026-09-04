import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-fix-r1-'));
const domainBundle = path.join(temporaryDirectory, 'agenda-domain.mjs');
const appBundle = path.join(temporaryDirectory, 'agenda-app.mjs');
const projectDirectory = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

for (const [entry, out] of [
  ['src/game/eland/domain/character-agenda.ts', domainBundle],
  ['src/game/eland/application/character-agenda.ts', appBundle],
]) {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${out}`,
  ], { cwd: projectDirectory, stdio: 'inherit' });
}

const domain = await import(pathToFileURL(domainBundle).href);
const app = await import(pathToFileURL(appBundle).href);

// ---------- Fix B: 近义关切合并 ----------
const empty = () => ({ version: 'character-agenda-v1', items: [] });
const proposal = (aim, summary) => ({
  aim,
  theme: 'survival',
  importance: 60,
  horizonMonths: 24,
  sourceFactIds: ['e-0-founding'],
  approach: {
    summary,
    disposition: 'missing-affordance',
    sourceFactIds: ['e-0-founding'],
  },
});

const first = domain.upsertCharacterAgenda(empty(), proposal('把松散的土石固定起来，避免后续滑落风险', '取得石'), 2, 'model-proposal');
assert.equal(first.accepted, true, '首次关切应被接受');
const second = domain.upsertCharacterAgenda(first.state, proposal('把脚下松散的土石固定起来以应对雾气加重带来的滑落风险', '俯身观察湿土'), 3, 'model-proposal');
assert.equal(second.accepted, true, '近义关切应作为更新被接受');
assert.equal(second.state.items.length, 1, `近义关切应合并为 1 项，实际 ${second.state.items.length}`);
assert.equal(second.state.items[0].approaches.length, 2, '合并后应保留两个不同办法');

// 对照：真正不同的关切不得合并
const different = domain.upsertCharacterAgenda(first.state, proposal('找到稳定的水源以保证饮水', '观察河流'), 4, 'model-proposal');
assert.equal(different.state.items.length, 2, '不同关切应保持独立');

// 对照：短目标换了对象不得合并（取得石 vs 取得食物）
const stoneGoal = domain.upsertCharacterAgenda(empty(), proposal('取得石', '走到石堆'), 2, 'model-proposal');
const foodGoal = domain.upsertCharacterAgenda(stoneGoal.state, proposal('取得食物', '走到果树'), 3, 'model-proposal');
assert.equal(foodGoal.state.items.length, 2, '短目标换对象不得合并');
console.log('[fix-B] 关切近义合并与对照全部通过');

// ---------- Fix C: 未绑定意图完成时回写同义办法 ----------
const concernState = first.state; // 含 aim=固定土石, approach 取得石 missing-affordance
const person = { id: 'joan', characterAgenda: structuredClone(concernState) };
const intent = {
  id: 'intent-x',
  ownerId: 'joan',
  summary: '取得石',
  status: 'completed',
  actionEventIds: ['e-9-action'],
  goalOutcome: { kind: 'achieved', sourceEventIds: ['e-9-action'] },
};
const state = {
  people: [person],
  intents: [intent],
};
const events = [{ id: 'e-9-action', kind: 'action', intentId: 'intent-x', who: 'joan', result: '石 × 1 改变了持有者', diff: {} }];
app.reconcileCharacterAgendasForMonth(state, events, 3);
const approach = person.characterAgenda.items[0].approaches[0];
assert.equal(approach.disposition, 'executable-now', `同义办法完成后应转为 executable-now，实际 ${approach.disposition}`);
assert.equal(approach.latestOutcome, 'supported');
assert.equal(events[0].diff.characterAgendaOutcome, 'supported', '事件应被标注回写结果');
console.log('[fix-C] 未绑定意图的关切回写通过');

// 对照：不同措辞的完成不应误回写
const person2 = { id: 'joan', characterAgenda: structuredClone(concernState) };
const intent2 = { ...intent, id: 'intent-y', summary: '观察并辨认了水', actionEventIds: ['e-10'] };
const state2 = { people: [person2], intents: [intent2] };
const events2 = [{ id: 'e-10', kind: 'action', intentId: 'intent-y', who: 'joan', result: '观察并辨认了水', diff: {} }];
app.reconcileCharacterAgendasForMonth(state2, events2, 3);
assert.equal(person2.characterAgenda.items[0].approaches[0].disposition, 'missing-affordance', '无关完成不得回写');
console.log('[fix-C] 对照通过');

rmSync(temporaryDirectory, { recursive: true, force: true });
console.log('全部定点自测通过');
