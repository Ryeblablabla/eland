import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-society-patch-test-'));
const bundlePath = path.join(temporaryDirectory, 'society-patch.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/society-patch.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  const { applyStepPayload, createStepPayload } = await import(
    `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
  );

  const world = {
    width: 2,
    height: 1,
    levels: 2,
    generator: { version: 'material-world-v1', seed: 7 },
    palette: [{ id: 0, key: 'air', name: '空气', color: [0, 0, 0], tags: ['air'] }],
    surface: [1, 2],
    elevation: [0, 1],
    columns: [[1], [2]],
    biomes: ['plain', 'plain'],
    activity: { traffic: [0, 0], transfer: [0, 0], action: [0, 0], attention: [0, 0] },
  };
  const previous = {
    runId: 'patch-run',
    branchId: 'main',
    civilizationId: 3,
    elapsedMonths: 4,
    calendar: { year: 1, month: 5, label: '第 1 年 5 月' },
    universeTime: 4,
    skySample: { fromTime: 3, toTime: 4, fluxMean: 1, fluxMin: 1, fluxMax: 1, nearestStarDistance: 1, fate: 'stable' },
    society: { world, agents: [{ id: 'a', doing: '等待' }], marker: 'old' },
    civilizationEnd: null,
    entries: [],
    speaker: 'a',
  };
  const current = structuredClone(previous);
  current.elapsedMonths = 5;
  current.calendar = { year: 1, month: 6, label: '第 1 年 6 月' };
  current.universeTime = 5;
  current.skySample = { ...current.skySample, fromTime: 4, toTime: 5 };
  current.society.world.surface[1] = 4;
  current.society.world.elevation[1] = 0;
  current.society.world.columns[1] = [4];
  current.society.world.activity.traffic[0] = 2;
  current.society.agents[0].doing = '行走';
  current.society.marker = 'new';

  const payload = createStepPayload(previous, current);
  assert.equal(payload.kind, 'patch');
  assert.equal(payload.society.world.cells.length, 1);
  assert.deepEqual(applyStepPayload(previous, payload), current);
  assert.deepEqual(previous.society.world.surface, [1, 2], '应用 patch 不得改写上一帧');

  const wrongBase = { ...previous, elapsedMonths: 3 };
  assert.equal(applyStepPayload(wrongBase, payload), null, '基线月份不匹配时必须请求完整 state');

  const incompatible = structuredClone(current);
  incompatible.society.world.generator.seed = 8;
  assert.equal(createStepPayload(previous, incompatible).kind, 'full');

  console.log('society step patch tests passed (roundtrip, COW, fallback)');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
