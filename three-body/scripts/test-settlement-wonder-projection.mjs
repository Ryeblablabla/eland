import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-settlement-wonder-test-'));
const bundlePath = path.join(temporaryDirectory, 'settlement-wonder.mjs');

function material(id, key, facility = false) {
  return { id, key, name: key, color: [100, 100, 100], tags: facility ? ['facility'] : [] };
}

function societyFixture() {
  const width = 84;
  const height = 52;
  const palette = Array.from({ length: 67 }, (_, id) => material(id, `material-${id}`));
  palette[8] = material(8, 'grass');
  palette[54] = material(54, 'council_hearth', true);
  palette[59] = material(59, 'mill', true);
  palette[60] = material(60, 'civic_hall', true);
  palette[63] = material(63, 'keep_core', true);
  return {
    world: {
      width,
      height,
      levels: 12,
      generator: { version: 'test', seed: 75 },
      palette,
      surface: new Array(width * height).fill(8),
      elevation: new Array(width * height).fill(4),
      columns: Array.from({ length: width * height }, () => [8]),
      activity: { traffic: [], transfer: [], action: [], attention: [] },
    },
    agents: [], animals: [], drops: [], containers: [], graves: [], intents: [], regions: [],
    structures: [
      { id: 'house-a', occupiedCells: [10 + 22 * width], interiorCells: [], interiorPositions: [], componentCount: 2, complete: true, effects: { weatherProtection: 1, thermalInsulation: 1, capacity: 2 }, sourceEventIds: [], materialIds: [] },
      { id: 'house-b', occupiedCells: [12 + 23 * width], interiorCells: [], interiorPositions: [], componentCount: 2, complete: true, effects: { weatherProtection: 1, thermalInsulation: 1, capacity: 2 }, sourceEventIds: [], materialIds: [] },
    ],
    observations: {
      civilizationIndex: { formulaVersion: 'test', total: 300, calculatedAtMonth: 100, stage: '古代文明', components: { population: 0, territory: 0, technology: 0, social: 0, history: 0 } },
      practices: [], institutions: [], milestones: [],
    },
  };
}

try {
  const entry = `
    export { settlementWonderProjection } from ${JSON.stringify(path.resolve('src/game/voxelKits.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=settlement-wonder-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const { settlementWonderProjection } = await import(
    `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
  );

  const ungrounded = societyFixture();
  assert.equal(settlementWonderProjection(ungrounded), null,
    '时代标签不能在没有真实设施和制度时生成奇观');

  const millCell = 8 + 23 * ungrounded.world.width;
  ungrounded.world.surface[millCell] = 59;
  ungrounded.observations.institutions.push({
    key: 'land-processing:facility:59:8:23:5', label: '定居作物加工', note: 'test',
  });
  assert.equal(settlementWonderProjection(ungrounded)?.kind, 'windmill');

  const civicCell = 10 + 23 * ungrounded.world.width;
  ungrounded.world.surface[civicCell] = 60;
  ungrounded.observations.institutions.push({
    key: 'coordination-core:facility:60:10:23:5', label: '固定议事与协调场所', note: 'test',
  });
  ungrounded.observations.milestones.push({
    id: 'capability:248:practice:physical-record:v2', label: '保存器物', note: 'test',
  });
  const temple = settlementWonderProjection(ungrounded);
  assert.equal(temple?.kind, 'stepped-temple');
  assert.equal(temple?.anchorCellId, civicCell);
  assert.equal(settlementWonderProjection(ungrounded)?.anchorCellId, civicCell,
    '同一权威状态必须稳定复现同一锚点');

  const keepCell = 11 + 23 * ungrounded.world.width;
  ungrounded.world.surface[keepCell] = 63;
  ungrounded.observations.institutions.push({
    key: 'coordination-core:facility:63:11:23:5', label: '固定议事与协调场所', note: 'test',
  });
  assert.equal(settlementWonderProjection(ungrounded)?.kind, 'castle',
    '真实且制度化的城堡核心应覆盖较低等级地标');

  ungrounded.world.surface[keepCell] = 8;
  assert.equal(settlementWonderProjection(ungrounded)?.kind, 'stepped-temple',
    '历史制度仍在但设施已消失时不能继续显示城堡');

  console.log('settlement wonder projection checks passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
