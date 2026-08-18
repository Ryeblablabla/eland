import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-player-narrative-'));
const bundlePath = path.join(temporaryDirectory, 'player-narrative.mjs');
const enhancementBundlePath = path.join(temporaryDirectory, 'narrative-enhancements.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/projection/player-narrative.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/narrative-enhancements.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${enhancementBundlePath}`,
  ], { stdio: 'pipe' });
  const { playerTextForEvent, projectPlayerNarrative } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const { summarizePlayerNarrativeEntries } = await import(`${pathToFileURL(enhancementBundlePath).href}?test=${Date.now()}`);

  const state = {
    branchId: 'main',
    clock: { elapsedMonths: 51 },
    people: [
      { id: 'galileo', name: '伽利略', sex: 'male', knowledge: [] },
      { id: 'freyja', name: '芙蕾雅', sex: 'female', knowledge: [] },
      { id: 'artemis', name: '阿尔忒弥斯', sex: 'female', knowledge: [] },
    ],
    intents: [
      { id: 'observe-plank', summary: '持续观察木板' },
      { id: 'collect-wood', summary: '取得木材' },
    ],
    projects: [],
  };
  const events = [
    {
      id: 'decision-observe', kind: 'decision', atMonth: 51, orderInMonth: 1, cellId: 4,
      who: 'galileo', intentId: 'observe-plank', usedModel: false,
      decision: { kind: 'start', optionId: 'observe', reason: '眼前物质尚未形成可靠认识' },
      result: '决定：持续观察木板',
    },
    {
      id: 'action-observe', kind: 'action', atMonth: 51, orderInMonth: 2, actionTick: 1, cellId: 4,
      who: 'galileo', intentId: 'observe-plank', cause: 'intent', action: { kind: 'attend', target: { kind: 'drop', dropId: 'plank' } },
      fromCellId: 4, toCellId: 4, fromZ: 1, toZ: 1, pathSegment: [], status: 'completed',
      result: '观察并辨认了木板', diff: {},
    },
    {
      id: 'decision-collect', kind: 'decision', atMonth: 51, orderInMonth: 3, cellId: 7,
      who: 'freyja', intentId: 'collect-wood', usedModel: false,
      decision: { kind: 'start', optionId: 'collect', reason: '看见地上的木材' },
      result: '决定：取得木材',
    },
    {
      id: 'action-walk', kind: 'action', atMonth: 51, orderInMonth: 4, actionTick: 1, cellId: 7,
      who: 'freyja', intentId: 'collect-wood', cause: 'intent', action: { kind: 'move', toCellId: 8 },
      fromCellId: 7, toCellId: 8, fromZ: 1, toZ: 1, pathSegment: [8], status: 'completed',
      result: '沿可容身空间到达格 8, 8 的高度 1', diff: {},
    },
    {
      id: 'action-collect', kind: 'action', atMonth: 51, orderInMonth: 5, actionTick: 2, cellId: 8,
      who: 'freyja', intentId: 'collect-wood', cause: 'intent',
      action: { kind: 'transfer', materialId: 13, quantity: 2, from: { kind: 'ground', cellId: 8 }, to: { kind: 'person', personId: 'freyja' } },
      fromCellId: 8, toCellId: 8, fromZ: 1, toZ: 1, pathSegment: [], status: 'completed',
      result: '木材 × 2 改变了持有者', diff: { materialId: 13, quantity: 2, authorized: true },
    },
    {
      id: 'action-eat', kind: 'action', atMonth: 51, orderInMonth: 6, actionTick: 2, cellId: 12,
      who: 'artemis', cause: 'survival-reflex', action: { kind: 'act', operation: 'ingest', targets: [] },
      fromCellId: 12, toCellId: 12, fromZ: 1, toZ: 1, pathSegment: [], status: 'completed',
      result: '摄入了食物', diff: { materialId: 21 },
    },
    {
      id: 'action-talk', kind: 'action', atMonth: 51, orderInMonth: 7, actionTick: 2, cellId: 12,
      who: 'galileo', cause: 'intent',
      action: { kind: 'communicate', audience: ['freyja'], channel: 'voice', content: { id: 'claim-1', kind: 'claim', summary: '我在附近找到了木材。' } },
      fromCellId: 12, toCellId: 12, fromZ: 1, toZ: 1, pathSegment: [], status: 'completed',
      result: '伽利略对芙蕾雅表达：claim', diff: {},
    },
    {
      id: 'action-reproduce-failed', kind: 'action', atMonth: 51, orderInMonth: 8, actionTick: 3, cellId: 12,
      who: 'galileo', cause: 'intent',
      action: { kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: 'freyja' }] },
      fromCellId: 12, toCellId: 12, fromZ: 1, toZ: 1, pathSegment: [], status: 'completed',
      result: '生殖尝试未进入妊娠', diff: { conceived: false },
    },
  ];
  const originalEvents = structuredClone(events);
  const personalText = events.map((event) => playerTextForEvent(state, event)).join('\n');
  const entries = projectPlayerNarrative(state, events, 8);

  assert.match(personalText, /伽利略仔细观察后，认出了木板。/);
  assert.match(personalText, /芙蕾雅捡起了2份木材。/);
  assert.match(personalText, /阿尔忒弥斯吃下了1份食物。/);
  assert.match(personalText, /伽利略对芙蕾雅说：我在附近找到了木材。/);
  assert.match(personalText, /伽利略和芙蕾雅想要个孩子，但芙蕾雅没有怀上。/);
  assert.deepEqual(entries, [], '赶路、搬运、吃饭、普通对话和失败尝试不得进入文明历史');
  assert.deepEqual(events, originalEvents, '玩家叙事只能投影事件，不能改写权威事实');

  const quiet = projectPlayerNarrative(state, [{
    id: 'weather-7', kind: 'environment', change: 'weather', atMonth: 7, orderInMonth: 0, cellId: 0,
    result: '本月天气转为晴朗', diff: { kind: 'clear' },
  }], 4);
  assert.deepEqual(quiet, [], '没有重大事件的月份不应生成文明历史，也不需要调用模型');

  const birth = projectPlayerNarrative(state, [{
    id: 'birth-52', kind: 'environment', change: 'body', atMonth: 52, orderInMonth: 9, cellId: 12,
    who: 'freyja', result: '芙蕾雅生下了艾拉', diff: { bornPersonId: 'aila', bornPersonName: '艾拉' },
  }], 4);
  assert.equal(birth.length, 1);
  assert.equal(birth[0].text, '芙蕾雅生下了艾拉。');

  const eraTransition = projectPlayerNarrative(state, [{
    id: 'era-53', kind: 'environment', change: 'climate', atMonth: 53, orderInMonth: 1, cellId: 0,
    result: '乱纪元开始；本月地表处于寒冷环境',
    diff: { eraTransition: true, epoch: 'chaotic', kind: 'cold', severity: 6 },
  }, {
    id: 'birth-53', kind: 'environment', change: 'body', atMonth: 53, orderInMonth: 2, cellId: 12,
    who: 'freyja', result: '芙蕾雅生下了艾拉', diff: { bornPersonId: 'aila', bornPersonName: '艾拉' },
  }], 1);
  assert.equal(eraTransition.length, 1);
  assert.equal(eraTransition[0].text, '恒纪元结束，乱纪元开始，地表转为寒冷。', '纪元更迭必须优先于同月其他重大事件');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('纪元更迭不应调用模型'); };
  try {
    assert.deepEqual(
      await summarizePlayerNarrativeEntries(state, eraTransition),
      eraTransition,
      '只有纪元更迭时必须直接使用规则文本，不得请求模型',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log('player narrative projection ok');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
