import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-pinch-transition-test-'));
const bundlePath = path.join(temporaryDirectory, 'pinch-transition.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/pinch-transition-gesture.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  const {
    PINCH_TRANSITION_SCALE,
    PinchTransitionGesture,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  assert.equal(PINCH_TRANSITION_SCALE, 1.45, '场景切换阈值应是明确的 45% 缩放');

  const zoomIn = new PinchTransitionGesture('zoom-in');
  zoomIn.pointerDown(1, 0, 0);
  assert.equal(zoomIn.pointerMove(1, 40, 0).triggered, false, '单指拖动不得触发缩放切换');
  assert.equal(zoomIn.consumeTapSuppression(1), false, '单指点击仍应留给点选逻辑');
  zoomIn.pointerDown(2, 140, 0);
  assert.equal(zoomIn.pointerMove(2, 182, 0).triggered, false, '未越过累积阈值不得提前进入人间');
  const zoomInTriggered = zoomIn.pointerMove(2, 245, 0);
  assert.equal(zoomInTriggered.triggered, true, '双指张开 45% 后应触发向内进入');
  assert.equal(zoomInTriggered.progressRatio, 1);
  assert.equal(zoomIn.pointerMove(2, 280, 0).triggered, false, '同一次手势只能触发一次');
  assert.equal(zoomIn.consumeTapSuppression(1), true, '参与双指手势的触点不得误触点选');
  assert.equal(zoomIn.consumeTapSuppression(2), true);
  assert.equal(zoomIn.consumeTapSuppression(2), false);
  zoomIn.pointerUp(2);
  zoomIn.pointerUp(1);

  const reversal = new PinchTransitionGesture('zoom-in');
  reversal.pointerDown(1, 0, 0);
  reversal.pointerDown(2, 100, 0);
  reversal.pointerMove(2, 130, 0);
  const reversed = reversal.pointerMove(2, 110, 0);
  assert.ok(reversed.progress < Math.log(1.11), '反向抖动应回退而不是累计错误方向');
  assert.equal(reversal.pointerMove(2, 143, 0).triggered, false);
  assert.equal(reversal.pointerMove(2, 150, 0).triggered, true);

  const zoomOut = new PinchTransitionGesture('zoom-out');
  zoomOut.pointerDown(10, 0, 0);
  zoomOut.pointerDown(11, 100, 0);
  assert.equal(zoomOut.pointerMove(11, 80, 0).triggered, false);
  assert.equal(zoomOut.pointerMove(11, 68, 0).triggered, true, '双指收拢 45% 后应触发向外返回');

  const cancelled = new PinchTransitionGesture('zoom-in');
  cancelled.pointerDown(20, 0, 0);
  cancelled.pointerDown(21, 100, 0);
  cancelled.pointerMove(21, 130, 0);
  cancelled.pointerCancel(21);
  assert.equal(cancelled.pointerMove(20, 200, 0).triggered, false, 'pointercancel 后不得保留半截手势');
  cancelled.pointerUp(20);
  cancelled.pointerDown(22, 0, 0);
  cancelled.pointerDown(23, 100, 0);
  assert.equal(cancelled.pointerMove(23, 150, 0).triggered, true, '所有触点释放后应允许新手势');

  const crowded = new PinchTransitionGesture('zoom-in');
  crowded.pointerDown(30, 0, 0);
  crowded.pointerDown(31, 100, 0);
  crowded.pointerDown(32, 50, 50);
  crowded.pointerMove(31, 180, 0);
  crowded.pointerUp(32);
  assert.equal(crowded.pointerMove(31, 220, 0).triggered, false, '三指序列不得退化成误触双指切换');

  console.log('pinch transition gesture tests passed (threshold, reversal, cancel, tap suppression)');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
