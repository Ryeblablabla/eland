import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-modern-stage-visual-test-'));
const bundlePath = path.join(temporaryDirectory, 'modern-stage-visual.mjs');

try {
  const entry = `
    export {
      civilizationStagePreview,
      settlementVisualStage,
    } from ${JSON.stringify(path.resolve('src/game/voxelKits.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=modern-stage-visual-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const { civilizationStagePreview, settlementVisualStage } = await import(
    `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
  );

  const stage = '现代文明（含信息能力）';
  const first = civilizationStagePreview(stage);
  const second = civilizationStagePreview(stage);
  assert.equal(first.label, '电力与知识站');
  assert.notEqual(first.label, '部落营地', '现代阶段卡片不能退回部落象征');
  assert.ok(first.instances.length > 0, '现代阶段卡片必须有可见的确定性微体素');
  assert.deepEqual(second, first, '相同现代阶段必须稳定重建同一象征预览');

  assert.equal(settlementVisualStage(stage), 'ancient',
    '现代聚落至少沿用成熟古代底座，实际电力设施仍由权威网络单独投影');
  assert.notEqual(settlementVisualStage(stage), 'primitive');
  assert.equal(settlementVisualStage('尚未定义的未来阶段'), 'primitive',
    '未知观察标签仍必须走保守的 primitive 回退');

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1_024 * 1_024,
    `modern stage visual fixture RSS ${rssBytes} must remain below 256 MiB`);
  console.log(JSON.stringify({
    result: 'passed',
    previewLabel: first.label,
    instanceCount: first.instances.length,
    settlementStage: settlementVisualStage(stage),
    unknownStage: settlementVisualStage('尚未定义的未来阶段'),
    rssBytes,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
