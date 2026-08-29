import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(projectRoot, '..');
const catalogPath = path.join(projectRoot, 'src/game/voxel-assets/catalog.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-voxel-assets-'));
const bundlePath = path.join(temporaryDirectory, 'voxel-assets.mjs');

try {
  assert.equal(catalog.schemaVersion, 1);
  assert.deepEqual(catalog.units, { microPerCell: 8, worldCellHeight: 0.3 });
  assert.deepEqual(Object.keys(catalog.assets), ['rabbit', 'boar', 'wolf']);

  for (const [key, asset] of Object.entries(catalog.assets)) {
    assert.equal(asset.status, 'live', `${key} should declare its production status in the catalog`);
    assert.equal(new Set(asset.parts.map((part) => part.id)).size, asset.parts.length,
      `${key} part ids should be unique`);
    for (const part of asset.parts) {
      assert.ok(asset.palette[part.color], `${key}/${part.id} should reference a catalog color`);
      assert.match(asset.palette[part.color], /^#[0-9a-f]{6}$/i);
      assert.equal(part.position.length, 3);
      assert.equal(part.size.length, 3);
      assert.ok(part.size.every((dimension) => dimension > 0), `${key}/${part.id} should have positive size`);
    }
  }

  const entry = `
    export {
      MICRO_PER_CELL,
      VOXEL_ASSET_KEYS,
      WORLD_CELL_HEIGHT,
      resolveVoxelAssetParts,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/voxel-assets/catalog.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=voxel-asset-catalog-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    MICRO_PER_CELL,
    VOXEL_ASSET_KEYS,
    WORLD_CELL_HEIGHT,
    resolveVoxelAssetParts,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  assert.equal(MICRO_PER_CELL, 8);
  assert.equal(WORLD_CELL_HEIGHT, 0.3);
  assert.deepEqual(VOXEL_ASSET_KEYS, ['rabbit', 'boar', 'wolf']);
  assert.equal(resolveVoxelAssetParts('rabbit').length, 15);
  assert.equal(resolveVoxelAssetParts('wolf').length, 17);
  assert.equal(resolveVoxelAssetParts('boar', { sex: 'male', ageBand: 'adult' }).length, 21);
  assert.equal(resolveVoxelAssetParts('boar', { sex: 'male', ageBand: 'elder' }).length, 21);
  assert.equal(resolveVoxelAssetParts('boar', { sex: 'female', ageBand: 'adult' }).length, 19);
  assert.equal(resolveVoxelAssetParts('boar', { sex: 'male', ageBand: 'juvenile' }).length, 19);
  assert.equal(resolveVoxelAssetParts('boar', { sex: 'male', ageBand: 'adult' }, 0.5)[0].color, 0x4a3a2c,
    'the midpoint production variation should retain the catalog base color');

  const generatedSource = readFileSync(path.join(repoRoot, 'knowledge-base/voxel-assets-data.js'), 'utf8');
  const generatedJson = generatedSource
    .replace(/^\/\/ Generated[^\n]*\nexport const VOXEL_ASSET_CATALOG = /, '')
    .replace(/;\n$/, '');
  assert.deepEqual(JSON.parse(generatedJson), catalog,
    'the knowledge-base module should be generated directly from the canonical catalog');

  const productionSource = readFileSync(path.join(projectRoot, 'src/game/voxelKits.ts'), 'utf8');
  assert.match(productionSource, /resolveVoxelAssetParts\(key, context, r\)/);
  assert.doesNotMatch(productionSource, /function kit(?:Rabbit|Boar|Wolf)\b/,
    'production animal geometry should not be duplicated outside the catalog');

  const knowledgeBaseSource = readFileSync(path.join(repoRoot, 'knowledge-base/codex.html'), 'utf8');
  assert.match(knowledgeBaseSource, /VOXEL_ASSET_CATALOG/);
  assert.match(knowledgeBaseSource, /status:'prototype'.*medievalroad|medievalroad'.*status:'prototype'/s);
  assert.doesNotMatch(
    knowledgeBaseSource.match(/const LIVE_ASSET_KEYS = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? '',
    /'rabbit'|'boar'|'wolf'|'medievalroad'/,
    'catalog animals and the medieval road should not inherit status from the legacy live set',
  );

  console.log('voxel asset catalog regression passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
