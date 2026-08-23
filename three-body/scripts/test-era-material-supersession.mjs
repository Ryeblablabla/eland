import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-era-material-test-'));
const bundlePath = path.join(temporaryDirectory, 'era-material.mjs');

try {
  const entry = `
    export {
      ancientMetalworkingCapabilitySatisfied,
      ancientMetalworkingFacilitySatisfied,
      highestSatisfiedDevelopmentEra,
      normalizeDevelopmentEra,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/era-progression.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=era-material-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    Material,
    ancientMetalworkingCapabilitySatisfied,
    ancientMetalworkingFacilitySatisfied,
    highestSatisfiedDevelopmentEra,
    normalizeDevelopmentEra,
  } = await import(
    `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
  );

  const capability = (key, stage) => ({
    key,
    stage,
    successfulBatchEventIds: [],
    failedBatchEventIds: [],
    producerIds: [],
    adoptedActionEventIds: [],
    productionSiteMaterialIds: [],
    supportingInstitutionKeys: [],
  });
  const facility = (materialId, uses) => ({
    materialId,
    active: true,
    useEventIds: Array.from({ length: uses }, (_, index) => `use-${materialId}-${index}`),
  });

  assert.equal(normalizeDevelopmentEra('medieval'), 'ancient-civilization',
    '旧快照中的中世纪观察值必须归并为古代文明');
  assert.equal(normalizeDevelopmentEra('ancient-civilization'), 'ancient-civilization',
    '古代文明观察值不应被兼容归并改变');

  assert.equal(highestSatisfiedDevelopmentEra({
    'agrarian-settlement': [['food:settled-cultivation-cycle', false]],
    'ancient-civilization': [['material:bronze-or-iron:institutional', true]],
  }), 'ancient-civilization', '高阶事实完整闭合时不应被未满足的低阶标签挡住');

  assert.equal(highestSatisfiedDevelopmentEra({
    'agrarian-settlement': [['food:settled-cultivation-cycle', true]],
    'ancient-civilization': [['material:bronze-or-iron:institutional', false]],
  }), 'agrarian-settlement', '高阶事实未闭合时仍只能识别已完成的事实层');

  assert.equal(ancientMetalworkingCapabilitySatisfied([
    capability('bronze', 'institutional'),
    capability('iron', 'hypothesis'),
  ]), true, '制度化青铜仍应满足古代冶金材料门槛');

  assert.equal(ancientMetalworkingCapabilitySatisfied([
    capability('bronze', 'repeatable'),
    capability('iron', 'institutional'),
  ]), true, '制度化铁器应向下替代古代冶金材料门槛');

  assert.equal(ancientMetalworkingCapabilitySatisfied([
    capability('bronze', 'repeatable'),
    capability('iron', 'distributed'),
  ]), false, '两个材料能力都未制度化时不得提前满足门槛');

  assert.equal(ancientMetalworkingFacilitySatisfied([
    capability('bronze', 'institutional'),
    capability('iron', 'hypothesis'),
  ], [facility(Material.Foundry, 3)]), true, '制度化青铜与重复使用铸造场应满足古代冶金设施门槛');

  assert.equal(ancientMetalworkingFacilitySatisfied([
    capability('bronze', 'repeatable'),
    capability('iron', 'institutional'),
  ], [facility(Material.Smithy, 4)]), true, '制度化铁器与重复使用铁匠铺应替代古代铸造路径');

  assert.equal(ancientMetalworkingFacilitySatisfied([
    capability('bronze', 'repeatable'),
    capability('iron', 'institutional'),
  ], [facility(Material.Smithy, 3)]), false, '铁匠铺使用不足时不得提前满足古代冶金设施门槛');

  assert.equal(ancientMetalworkingFacilitySatisfied([
    capability('bronze', 'repeatable'),
    capability('iron', 'distributed'),
  ], [facility(Material.Smithy, 4)]), false, '铁器未制度化时不能仅靠使用铁匠铺越过古代冶金设施门槛');

  assert.equal(ancientMetalworkingFacilitySatisfied([
    capability('bronze', 'repeatable'),
    capability('iron', 'institutional'),
  ], [facility(Material.Foundry, 3)]), false, '制度化铁器不能与铸造场跨路径拼接古代冶金设施证据');

  assert.equal(ancientMetalworkingFacilitySatisfied([
    capability('bronze', 'institutional'),
    capability('iron', 'hypothesis'),
  ], [facility(Material.Smithy, 4)]), false, '制度化青铜不能借铁匠铺替代尚未闭合的铸造路径');

  console.log('era material supersession checks passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
