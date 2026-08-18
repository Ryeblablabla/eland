import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-surface-transition-test-'));
const bundlePath = path.join(temporaryDirectory, 'surface-transitions.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    path.resolve('src/game/surfaceTransitions.ts'),
    '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const { shorelinePatches, surfaceTransitionKind, surfaceTransitionPatches } = await import(
    `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
  );

  assert.equal(surfaceTransitionKind('grass'), 'grass');
  assert.equal(surfaceTransitionKind('wet_soil'), 'wet-soil');
  assert.equal(surfaceTransitionKind('rich_soil'), 'rich-soil');
  assert.equal(surfaceTransitionKind('exhausted_soil'), 'exhausted-soil');
  assert.equal(surfaceTransitionKind('crop_mature'), 'cultivated');
  assert.equal(surfaceTransitionKind('sand'), 'sand');
  assert.equal(surfaceTransitionKind('packed_soil'), undefined, '道路应继续使用自己的方向拓扑');

  assert.deepEqual(
    surfaceTransitionPatches('grass', { north: 'grass', east: 'grass' }, 12),
    [],
    '同材质邻格不应生成边界覆盖片',
  );
  assert.deepEqual(
    surfaceTransitionPatches('grass', { northEast: 'soil' }, 12),
    [],
    '只有对角接触时不得跨角建立连接',
  );

  const eastEdge = surfaceTransitionPatches('grass', { east: 'soil' }, 27);
  assert.ok(eastEdge.length > 0, '正交异材质邻格应产生微体素过渡');
  assert.ok(
    eastEdge.every((patch) => patch.source === 'east'
      && (patch.microX === 6 || patch.microX === 7)
      && (patch.depth === 0 || patch.depth === 1)),
    '东侧过渡只能占用靠边的两列，不能污染地块内部',
  );
  assert.ok(
    surfaceTransitionPatches('sand', { west: 'grass' }, 43).length > 0,
    '沙地应与草地复用相同的区域边界规则',
  );

  let supportedCornerCount = 0;
  let blockedCornerCount = 0;
  for (let seed = 0; seed < 128; seed++) {
    supportedCornerCount += surfaceTransitionPatches('grass', {
      north: 'soil', east: 'soil', northEast: 'soil',
    }, seed).filter((patch) => patch.microX >= 6 && patch.microZ <= 1).length;
    blockedCornerCount += surfaceTransitionPatches('grass', {
      north: 'soil', east: 'soil', northEast: 'grass',
    }, seed).filter((patch) => patch.microX >= 6 && patch.microZ <= 1).length;
  }
  assert.ok(
    supportedCornerCount > blockedCornerCount * 1.25,
    '对角同类地块应补实拐角，对角仍属本格时应收住内角',
  );

  assert.deepEqual(
    shorelinePatches({ northEast: true }, 19),
    [],
    '只有对角水格时不得凭空生成湿润岸线',
  );
  const eastShore = shorelinePatches({ east: true }, 31);
  assert.ok(eastShore.length > 0, '同高正交水格应生成湿润岸线');
  assert.ok(
    eastShore.every((patch) => patch.source === 'east'
      && (patch.microX === 6 || patch.microX === 7)),
    '湿润岸线只能占用贴水的两列微体素',
  );
  let supportedShoreCornerCount = 0;
  let blockedShoreCornerCount = 0;
  for (let seed = 0; seed < 128; seed++) {
    supportedShoreCornerCount += shorelinePatches({
      north: true, east: true, northEast: true,
    }, seed).filter((patch) => patch.microX >= 6 && patch.microZ <= 1).length;
    blockedShoreCornerCount += shorelinePatches({
      north: true, east: true, northEast: false,
    }, seed).filter((patch) => patch.microX >= 6 && patch.microZ <= 1).length;
  }
  assert.ok(
    supportedShoreCornerCount > blockedShoreCornerCount * 1.2,
    '连续水角应补实湿岸，内角仍是陆地时应收住湿润范围',
  );

  console.log('surface transition regression passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
