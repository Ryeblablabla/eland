import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-dirt-path-test-'));
const bundlePath = path.join(temporaryDirectory, 'dirt-path.mjs');

try {
  const entry = `
    export { appendDirtPathCell, dirtPathConnections } from ${JSON.stringify(path.resolve('src/game/voxelKits.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=dirt-path-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const { appendDirtPathCell, dirtPathConnections } = await import(
    `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
  );
  const width = 5;
  const height = 5;
  const center = 2 * width + 2;
  const elevation = new Array(width * height).fill(0);
  const directionKeys = (cells, customElevation = elevation) => dirtPathConnections(
    new Set(cells), width, height, customElevation, center,
  ).map(({ dx, dz }) => `${dx},${dz}`);

  assert.deepEqual(directionKeys([center]), [], '孤立道路格不应凭空连接邻格');
  assert.deepEqual(directionKeys([center, center + 1]), ['1,0'], '端头应只朝真实相邻格延伸');
  assert.deepEqual(
    directionKeys([center, center - width, center + 1]),
    ['0,-1', '1,0'],
    '拐角应保留精确的两个方向',
  );
  assert.deepEqual(
    directionKeys([center, center - width, center + 1, center - 1]),
    ['0,-1', '1,0', '-1,0'],
    '丁字路应保留三个分支',
  );
  assert.deepEqual(
    directionKeys([center, center - width, center + 1, center + width, center - 1]),
    ['0,-1', '1,0', '0,1', '-1,0'],
    '十字路应保留四个分支',
  );
  assert.deepEqual(
    directionKeys([center, center - width + 1]),
    ['1,-1'],
    '只有角接触的道路格应产生斜向连接',
  );
  assert.deepEqual(
    directionKeys([center, center - width, center - width + 1]),
    ['0,-1'],
    '已有正交阶梯时不应再叠加对角捷径',
  );

  const steppedElevation = [...elevation];
  steppedElevation[center + 1] = 2;
  assert.deepEqual(
    directionKeys([center, center + 1], steppedElevation),
    [],
    '高度差超过一层的道路格不应在表现层相连',
  );

  const straightDecor = [];
  appendDirtPathCell(straightDecor, 0, 0, 0, [
    { dx: -1, dz: 0 },
    { dx: 1, dz: 0 },
  ], 0.31);
  const straightSurface = straightDecor.filter((instance) => instance.b === 'groundMark');
  assert.ok(straightSurface.length > 0, '直路应生成连续夯土带');
  assert.ok(
    straightSurface.every((instance) => instance.sy <= 0.004
      && instance.sx > 0.12 && instance.sx < 0.14
      && instance.sz > 0.12 && instance.sz < 0.14),
    '土路主体应使用贴地、无阴影的专用材质桶',
  );
  assert.ok(
    straightSurface.some((instance) => Math.abs(instance.x) < 0.07 && Math.abs(instance.z) < 0.07),
    '直路中心必须被连续泥面覆盖，不能回退成中间露草的双轨',
  );

  const diagonalDecor = [];
  appendDirtPathCell(diagonalDecor, 0, 0, 0, [
    { dx: 1, dz: 1 },
    { dx: -1, dz: -1 },
  ], 0.42);
  const diagonalSurface = diagonalDecor.filter((instance) => instance.b === 'groundMark');
  assert.ok(diagonalSurface.length > 0, '斜向道路应生成踩踏面');
  assert.ok(
    diagonalSurface.some((instance) => instance.x > 0.35 && instance.z > 0.35)
      && diagonalSurface.some((instance) => instance.x < -0.35 && instance.z < -0.35),
    '斜向道路应以 8×8 微体素阶梯贯通相对的两个角',
  );

  const cornerDecor = [];
  appendDirtPathCell(cornerDecor, 0, 0, 0, [
    { dx: 0, dz: -1 },
    { dx: 1, dz: 0 },
  ], 0.37);
  const cornerSurface = cornerDecor.filter((instance) => instance.b === 'groundMark');
  assert.ok(
    cornerSurface.some((instance) => instance.z < -0.4)
      && cornerSurface.some((instance) => instance.x > 0.4)
      && cornerSurface.some((instance) => Math.abs(instance.x) < 0.2 && Math.abs(instance.z) < 0.2),
    '拐角应在微体素网格中连续连接两个入口和中心转弯区',
  );

  let pebbleDecor = [];
  for (let sample = 0; sample < 32 && !pebbleDecor.some((instance) => instance.b === 'stone'); sample++) {
    pebbleDecor = [];
    appendDirtPathCell(pebbleDecor, 0, 0, 0, [
      { dx: -1, dz: 0 },
      { dx: 1, dz: 0 },
    ], (sample + 0.5) / 32);
  }
  const pebbles = pebbleDecor.filter((instance) => instance.b === 'stone');
  const pebbleRoad = pebbleDecor.filter((instance) => instance.b === 'groundMark');
  assert.ok(pebbles.length > 0, '确定性样本中应能看见嵌入土路的石子');
  assert.ok(pebbles.every((pebble) => pebbleRoad.some((surface) =>
    Math.hypot(pebble.x - surface.x, pebble.z - surface.z) < 0.12)),
  '石子必须落在已生成的泥面微体素上，而不是旁边草地');

  console.log('dirt path topology regression passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
