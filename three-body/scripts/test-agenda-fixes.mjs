import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-fix-r1-'));
const domainBundle = path.join(temporaryDirectory, 'agenda-domain.mjs');
const appBundle = path.join(temporaryDirectory, 'agenda-app.mjs');
const needBundle = path.join(temporaryDirectory, 'need-agenda.mjs');
const reviewBundle = path.join(temporaryDirectory, 'model-review.mjs');
const projectDirectory = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

for (const [entry, out] of [
  ['src/game/eland/domain/character-agenda.ts', domainBundle],
  ['src/game/eland/application/character-agenda.ts', appBundle],
  ['src/game/eland/application/cognition/need-agenda.ts', needBundle],
  ['src/game/eland/application/simulation/model-review.ts', reviewBundle],
]) {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entry, '--bundle', '--format=esm', '--platform=node', `--outfile=${out}`,
  ], { cwd: projectDirectory, stdio: 'inherit' });
}

const domain = await import(pathToFileURL(domainBundle).href);
const app = await import(pathToFileURL(appBundle).href);
const needAgenda = await import(pathToFileURL(needBundle).href);
const modelReview = await import(pathToFileURL(reviewBundle).href);

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
assert.equal(second.state.items[0].targetAtMonth, first.state.items[0].targetAtMonth, '近义重述不得滚动延后原始目标月份');

const longRevision = proposal('把松散的土石固定起来，避免后续滑落风险', '取得石');
longRevision.basisKey = first.item.basisKey;
longRevision.approach.basisKey = first.approach.basisKey;
longRevision.horizonMonths = 120;
longRevision.sourceFactIds = ['e-12-new-evidence'];
longRevision.approach.sourceFactIds = ['e-12-new-evidence'];
const revised = domain.upsertCharacterAgenda(second.state, longRevision, 12, 'model-proposal');
assert.equal(revised.accepted, true, '有新证据的同一关切应可复核');
assert.equal(revised.state.items[0].targetAtMonth, first.state.items[0].targetAtMonth, '复核和更长的新措辞不得续期');

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

// ---------- Fix D: 一次观察只产生待解释证据并退出工作注意力 ----------
const observed = domain.upsertCharacterAgenda(empty(), {
  aim: '弄清同伴是否愿意共同搭建遮雨处',
  theme: 'social-coordination',
  importance: 73,
  horizonMonths: 18,
  sourceFactIds: ['e-7-meeting'],
  approach: {
    summary: '观察同伴此刻的反应',
    disposition: 'observation-needed',
    sourceFactIds: ['e-7-meeting'],
    probe: { kind: 'observe', target: { kind: 'person', personId: 'bob' } },
  },
}, 7, 'model-proposal');
assert.equal(observed.accepted, true);
const observationIntent = {
  id: 'intent-observe-bob',
  ownerId: 'joan',
  summary: '观察同伴此刻的反应',
  status: 'completed',
  createdAtMonth: 8,
  lastProgressAtMonth: 8,
  actionEventIds: ['e-8-observe'],
  goalOutcome: { kind: 'achieved', sourceEventIds: ['e-8-observe'] },
  characterAgendaItemId: observed.item.id,
  characterAgendaApproachId: observed.approach.id,
};
const boundObservation = domain.bindCharacterAgendaIntent(
  observed.state,
  observed.item.id,
  observed.approach.id,
  observationIntent.id,
);
assert.equal(boundObservation.accepted, true);
const observer = { id: 'joan', characterAgenda: structuredClone(boundObservation.state) };
const observationState = { people: [observer], intents: [observationIntent] };
const observationEvent = {
  id: 'e-8-observe',
  kind: 'action',
  intentId: observationIntent.id,
  who: 'joan',
  status: 'completed',
  action: { kind: 'attend', target: { kind: 'person', personId: 'bob' } },
  result: 'Joan看见了Bob当下的实际反应',
  diff: {},
};
const observationEvents = [observationEvent];
app.reconcileCharacterAgendasForMonth(observationState, observationEvents, 8);
const waitingItem = observer.characterAgenda.items[0];
const waitingApproach = waitingItem.approaches[0];
assert.equal(waitingApproach.latestOutcome, 'parked', '观察完成不能被写成办法已获支持');
assert.equal(waitingApproach.disposition, 'waiting-for-evidence', '一次观察后应等待新证据或人物解释');
assert.equal(waitingItem.status, 'incubating', '等待证据的关切应退出活跃执行态');
assert.equal(waitingItem.activeIntentId, undefined, '完成的观察不能继续占据执行槽');
assert.equal(needAgenda.characterAgendaItemIsActionable(waitingItem), false, '等待证据的关切不能继续占工作注意力');
assert.equal(needAgenda.characterAgendaNeedUrgency(waitingItem), 0.73, '关切强度只来自人物声明的重要性');
assert.equal(needAgenda.characterAgendaNeedUrgency({ ...waitingItem, createdAtMonth: -1000 }), 0.73, '时间流逝不得给关切增压');
console.log('[fix-D] 普通观察完成后等待证据并退出工作注意力');

// ---------- Fix E: 世界结果只触发一次事件驱动复核 ----------
const decisionBeforeObservation = {
  id: 'e-8-decision', kind: 'decision', who: 'joan', usedModel: true, atMonth: 8,
};
const reviewContext = {
  activeIntent: undefined,
  person: observer,
  state: { world: { past: [decisionBeforeObservation, observationEvents[0]] } },
};
assert.equal(modelReview.characterAgendaRevisionDue(reviewContext, 9), true, '模型决策之后出现的观察结果应触发一次解释');
reviewContext.state.world.past.push({
  id: 'e-9-review', kind: 'decision', who: 'joan', usedModel: true, atMonth: 9,
});
assert.equal(modelReview.characterAgendaRevisionDue(reviewContext, 10), false, '结果被后续模型决策看过后不应重复触发');
assert.equal(modelReview.characterAgendaRevisionDue(reviewContext, 100), false, '等待更久也不能重新制造复核压力');
console.log('[fix-E] 关切复核由新世界事实触发且只消费一次');

rmSync(temporaryDirectory, { recursive: true, force: true });
console.log('全部定点自测通过');
