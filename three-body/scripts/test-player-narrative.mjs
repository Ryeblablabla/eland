import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-player-narrative-'));
const bundlePath = path.join(temporaryDirectory, 'player-narrative.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/projection/player-narrative.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  const { projectPlayerNarrative } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = {
    branchId: 'main',
    clock: { elapsedMonths: 51 },
    people: [
      { id: 'galileo', name: '伽利略' },
      { id: 'freyja', name: '芙蕾雅' },
      { id: 'artemis', name: '阿尔忒弥斯' },
    ],
    intents: [
      { id: 'observe-plank', summary: '持续观察木板' },
      { id: 'collect-wood', summary: '取得木材' },
    ],
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
      action: { kind: 'communicate', audience: ['freyja'], channel: 'voice', content: { id: 'claim-1', kind: 'claim', summary: '我在附近找到了木材。\'}\'\'\'\'' } },
      fromCellId: 12, toCellId: 12, fromZ: 1, toZ: 1, pathSegment: [], status: 'completed',
      result: '伽利略对芙蕾雅表达：claim', diff: {},
    },
  ];
  const originalEvents = structuredClone(events);
  const entries = projectPlayerNarrative(state, events, 8);
  const publicText = entries.map((entry) => entry.text).join('\n');

  assert.match(publicText, /伽利略还不熟悉眼前的材料，仔细观察后，认出了木板。/);
  assert.match(publicText, /芙蕾雅看见地上有木材，走过去捡起了2份木材。/);
  assert.match(publicText, /阿尔忒弥斯吃下了1份食物。/);
  assert.match(publicText, /伽利略对芙蕾雅说：我在附近找到了木材。/);
  assert.doesNotMatch(publicText, /第\s*\d|可容身|改变了持有者|摄入|体素|格\s*\d|高度\s*\d/);
  assert.doesNotMatch(publicText, /[}\']{2,}/);
  assert.equal(entries.filter((entry) => entry.intentId === 'collect-wood').length, 1, '同一意图的决定、移动和取物应合成一条玩家叙事');
  assert.deepEqual(events, originalEvents, '玩家叙事只能投影事件，不能改写权威事实');

  const quiet = projectPlayerNarrative(state, [{
    id: 'weather-7', kind: 'environment', change: 'weather', atMonth: 7, orderInMonth: 0, cellId: 0,
    result: '本月天气转为晴朗', diff: { kind: 'clear' },
  }], 4);
  assert.equal(quiet[0].month, 7, '历史复投影的安静月份必须使用来源事件月份');
  console.log('player narrative projection ok');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
