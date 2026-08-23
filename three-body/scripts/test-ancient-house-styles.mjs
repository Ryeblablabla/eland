import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-ancient-house-style-test-'));
const bundlePath = path.join(temporaryDirectory, 'ancient-house-style.mjs');

try {
  const entry = `
    export {
      ancientHouseVisualStyle,
      settlementVisualStage,
    } from ${JSON.stringify(path.resolve('src/game/voxelKits.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=ancient-house-style-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const { ancientHouseVisualStyle, settlementVisualStage } = await import(
    `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
  );

  assert.equal(settlementVisualStage('古代文明'), 'ancient');
  assert.equal(settlementVisualStage('中世纪'), 'ancient', '旧阶段标签也必须归并到古代装饰层');

  const worldSeed = 20260823;
  const first = ancientHouseVisualStyle(77, worldSeed);
  assert.equal(ancientHouseVisualStyle(77, worldSeed), first, '同一住所和世界种子必须稳定复现风格');

  const observedStyles = new Set(Array.from(
    { length: 256 },
    (_, structureCellId) => ancientHouseVisualStyle(structureCellId, worldSeed),
  ));
  assert.deepEqual([...observedStyles].sort(), ['chinese', 'western-medieval'],
    '古代住宅装饰必须同时能生成中国古建与西方中世纪风格');

  console.log('ancient house style checks passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
