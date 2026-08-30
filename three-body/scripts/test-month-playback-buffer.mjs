import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-month-playback-buffer-'));
const bundlePath = path.join(temporaryDirectory, 'month-playback-buffer.mjs');

try {
  buildSync({
    entryPoints: ['src/game/eland/month-playback-buffer.ts'],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
  });
  const {
    createMonthPlaybackTicket,
    inspectPrefetchedMonth,
    nextModelPlaybackBudgetMs,
    prefetchedMonthDelayMs,
    resolveMonthPlaybackDurationMs,
    speechPlaybackBaseDurationMs,
    speechTurnDurationMs,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const base = {
    runId: 'run-1',
    authorityRevision: 'authority-1',
    civilizationId: 7,
    branchId: 'branch-1',
    elapsedMonths: 12,
  };
  const ticket = createMonthPlaybackTicket(4, base, 1_000, 4_000);
  const next = { ...base, elapsedMonths: 13 };

  assert.equal(prefetchedMonthDelayMs(ticket, 2_200), 2_800,
    'a fast response must wait until the visible month finishes');
  assert.equal(prefetchedMonthDelayMs(ticket, 5_800), 0,
    'a slow response must be presented as soon as it arrives');
  assert.equal(inspectPrefetchedMonth(ticket, 4, base, next, true), 'accepted');
  assert.equal(inspectPrefetchedMonth(ticket, 5, base, next, true), 'stale-generation');
  assert.equal(inspectPrefetchedMonth(ticket, 4, { ...base, elapsedMonths: 13 }, next, true), 'stale-visible-head');
  assert.equal(inspectPrefetchedMonth(ticket, 4, base, next, false), 'unacknowledged-sky');
  assert.equal(inspectPrefetchedMonth(ticket, 4, base, { ...next, branchId: 'branch-2' }, true), 'unexpected-next-head');
  assert.equal(inspectPrefetchedMonth(ticket, 4, base, { ...next, elapsedMonths: 14 }, true), 'unexpected-next-head');
  assert.equal(resolveMonthPlaybackDurationMs(4_000, 1, 500), 4_000);
  assert.equal(resolveMonthPlaybackDurationMs(4_000, 10, 500), 500,
    'the highest speed must retain enough frames for a visible transition');
  assert.equal(resolveMonthPlaybackDurationMs(4_000, 10, 500, [], 8_000), 8_000,
    'model throughput is a wall-clock floor, not a visual duration divided by fast-forward');
  assert.equal(nextModelPlaybackBudgetMs(8_000, 9_000), 10_600,
    'a slow model month must raise the following visual budget immediately');
  assert.equal(nextModelPlaybackBudgetMs(10_000, 4_000), 8_970,
    'a fast response should lower the budget gradually rather than reintroduce jitter');
  assert.equal(speechTurnDurationMs('短句'), 1_200);
  assert.equal(speechTurnDurationMs('字'.repeat(100)), 4_000);
  assert.equal(speechPlaybackBaseDurationMs(4_000, ['第一句有一点内容', '第二句也需要时间']), 4_000,
    'short dialogue should fit inside the existing month budget');
  assert.ok(resolveMonthPlaybackDurationMs(4_000, 1, 500, [
    '这是一句需要给玩家留出阅读时间的真实人物台词。',
    '这是紧接着上一句发生的真实回应，也必须拥有自己的播放时段。',
    '第三个人随后说了另一件事，不能因为只显示最后三个人而覆盖前面的轮次。',
  ]) > 4_000, 'several spoken turns should extend rather than overpack one month');

  console.log('month playback buffer tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
