import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-fire-surface-height-test-'));
const bundlePath = path.join(temporaryDirectory, 'fire-surface-height.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-executor.ts'))};
    export { toSocietyState } from ${JSON.stringify(path.resolve('src/game/eland/adapter.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { cellX, cellY, neighbors4, setVoxel, topZ, voxelAt } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
    export { featureDepth, featureUnderlayMaterialId } from ${JSON.stringify(path.resolve('src/game/voxelKits.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=fire-surface-height-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    cellX,
    cellY,
    createInitialState,
    executePrimitiveAction,
    featureDepth,
    featureUnderlayMaterialId,
    neighbors4,
    setVoxel,
    toSocietyState,
    topZ,
    voxelAt,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(418, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const fixture = state.people.flatMap((person) => neighbors4(person.position.cellId)
    .filter((cellId) => topZ(state.world.grid, cellId) === person.position.z - 1)
    .map((cellId) => ({ person, cellId })))[0];
  assert.ok(fixture, 'the generated world must expose one adjacent supported surface');

  const { person, cellId } = fixture;
  const targetPosition = { x: cellX(cellId), y: cellY(cellId), z: person.position.z };
  const supportPosition = { ...targetPosition, z: targetPosition.z - 1 };
  const initialTopZ = topZ(state.world.grid, cellId);
  assert.equal(voxelAt(state.world.grid, targetPosition.x, targetPosition.y, targetPosition.z), Material.Air);

  person.inventory.push(
    { id: 'fire-height-stone-tool', materialId: Material.StoneTool, quantity: 1, sourceEventIds: [] },
    { id: 'fire-height-fiber', materialId: Material.Fiber, quantity: 1, sourceEventIds: [] },
  );
  const fact = executePrimitiveAction(state, person, {
    kind: 'act',
    operation: 'exert',
    toolStackId: 'fire-height-stone-tool',
    targets: [
      { kind: 'inventory-stack', personId: person.id, stackId: 'fire-height-fiber' },
      { kind: 'voxel', position: targetPosition },
    ],
  }, 1, 0, { cause: 'intent', actionTick: 1 });

  assert.equal(fact.status, 'completed');
  assert.equal(fact.diff.outputMaterialId, Material.Fire);
  assert.deepEqual(fact.diff.targetPosition, targetPosition);
  assert.deepEqual(fact.diff.position, supportPosition);
  assert.equal(voxelAt(state.world.grid, targetPosition.x, targetPosition.y, targetPosition.z), Material.Air);
  assert.equal(voxelAt(state.world.grid, supportPosition.x, supportPosition.y, supportPosition.z), Material.Fire);
  assert.equal(topZ(state.world.grid, cellId), initialTopZ, 'ignition must not add a terrain layer');
  const burningView = toSocietyState(state);
  assert.equal(featureDepth(burningView.world, cellId), 0,
    'the decor projection must not lower terrain for surface-replacing Fire');
  const fireUnderlayMaterialId = featureUnderlayMaterialId(burningView.world, cellId);
  assert.ok(fireUnderlayMaterialId !== undefined && fireUnderlayMaterialId !== Material.Fire,
    'surface-replacing Fire must retain a non-Fire ground color beneath its decor');

  setVoxel(state.world.grid, supportPosition.x, supportPosition.y, supportPosition.z, Material.Ash);
  assert.equal(topZ(state.world.grid, cellId), initialTopZ, 'ash left by the fire must not raise terrain');

  console.log('fire surface height regression passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
