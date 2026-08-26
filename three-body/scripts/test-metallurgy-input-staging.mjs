import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-metallurgy-input-staging-'));
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/simulation.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { ensureProject, recompileProjectNextAction } from ${JSON.stringify(path.resolve('src/game/eland/application/project-options.ts'))};
    export { cellX, cellY, neighbors4, setVoxel, voxelAt } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=metallurgy-input-staging-fixture.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const api = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
  const {
    Material,
    cellX,
    cellY,
    createInitialState,
    ensureProject,
    neighbors4,
    recompileProjectNextAction,
    setVoxel,
    voxelAt,
  } = api;

  const state = createInitialState(185, {
    chaosIntensity: 0,
    endpoint: { kind: 'months', value: 120 },
  });
  state.world.past = [];
  const actor = state.people[0];
  state.people = [actor];
  actor.inventory = [{
    id: 'visible-route-wood',
    materialId: Material.Wood,
    quantity: 1,
    sourceEventIds: ['collected-wood'],
  }];

  const kiln = neighbors4(actor.position.cellId).map((cellId) => ({
    cellId,
    x: cellX(cellId),
    y: cellY(cellId),
    z: actor.position.z,
  })).find((position) => (
    voxelAt(state.world.grid, position.x, position.y, position.z) === Material.Air
      && voxelAt(state.world.grid, position.x, position.y, position.z - 1) !== Material.Air
  ));
  assert.ok(kiln, '测试出生点旁必须存在可工作的窑炉位置');
  setVoxel(state.world.grid, kiln.x, kiln.y, kiln.z, Material.Kiln);

  state.world.drops = [{
    id: 'visible-copper-ore',
    materialId: Material.CopperOre,
    cellId: actor.position.cellId,
    z: actor.position.z,
    quantity: 1,
    sourceEventIds: ['saw-visible-copper-ore'],
    createdAtMonth: 0,
  }];
  const project = ensureProject(state, {
    id: 'stage-visible-copper-before-kiln',
    kind: 'production',
    need: 'alloy-capability',
    desiredFunction: 'copper-charge',
    summary: '把眼前铜矿和木炭汇合成铜料',
    ownerId: actor.id,
    beneficiaryIds: [actor.id],
    triggerFactIds: ['saw-visible-copper-ore'],
    pressure: 72,
    createdAtMonth: 1,
    reviewAtMonth: 36,
    site: { cellId: kiln.cellId, z: kiln.z },
  });

  const action = recompileProjectNextAction(state, actor, project.id);
  assert.equal(action?.kind, 'transfer',
    '固定工地项目应先取得人物眼前可见的必要矿料，避免先去窑炉后丢失具体来源');
  assert.equal(action?.kind === 'transfer' ? action.dropId : undefined, 'visible-copper-ore');
  assert.equal(action?.kind === 'transfer' ? action.materialId : undefined, Material.CopperOre);

  process.stdout.write('metallurgy input staging tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
