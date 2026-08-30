import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-bounded-water-search-'));
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/simulation.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { compileBoundedWaterSearchMove } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/water-access.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { cellId, cellX, cellY, cellsInRadius, setVoxel } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=bounded-water-search-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    Material,
    cellId,
    cellX,
    cellY,
    cellsInRadius,
    compileBoundedWaterSearchMove,
    createInitialState,
    executePrimitiveAction,
    setVoxel,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(26083042, {
    endpoint: { kind: 'months', value: 24 },
    chaosIntensity: 0,
  });
  const actor = state.people[0];
  assert.ok(actor);
  const center = cellId(42, 26);
  for (const localCell of cellsInRadius(center, 14)) {
    for (let z = 0; z < state.world.grid.levels; z += 1) {
      setVoxel(
        state.world.grid,
        cellX(localCell),
        cellY(localCell),
        z,
        z === 0 ? Material.PackedSoil : Material.Air,
      );
    }
  }
  actor.position = {
    cellId: center,
    z: 1,
    previousCellId: center,
    previousZ: 1,
    lastPath: [center],
    tickPath: [center],
  };
  actor.knownPlaces = [];
  state.clock.elapsedMonths = 0;

  const events = [];
  const requested = [];
  let firstBasis;
  for (let tick = 1; tick <= 80; tick += 1) {
    const visible = cellsInRadius(actor.position.cellId, 6);
    const action = compileBoundedWaterSearchMove(state, actor, actor.id, visible, events);
    if (!action) break;
    firstBasis ??= structuredClone(action.waterSearchBasis);
    assert.equal(action.waterSearchBasis.episodeId, firstBasis.episodeId,
      '移动后的新视野不得重新打开另一轮找水搜索');
    assert.deepEqual(action.waterSearchBasis.candidates, firstBasis.candidates,
      '一次找水搜索的候选区域必须保持冻结');
    requested.push(`${action.toCellId}:${action.toZ}`);
    events.push(executePrimitiveAction(state, actor, action, 1, events.length, {
      cause: 'survival-reflex', actionTick: tick,
    }));
  }

  assert.ok(firstBasis);
  assert.ok(firstBasis.candidates.length > 0 && firstBasis.candidates.length <= 4,
    '搜索只能保存少量初始可见前沿候选');
  assert.ok(requested.length > 0 && requested.length < 80, '搜索必须在有限行动数内耗尽');
  assert.ok(requested.every((target) => firstBasis.candidates
    .some((candidate) => `${candidate.cellId}:${candidate.z}` === target)),
  '所有后续移动都必须指向初始冻结候选');
  assert.equal(
    compileBoundedWaterSearchMove(
      state,
      actor,
      actor.id,
      cellsInRadius(actor.position.cellId, 6),
      events,
    ),
    null,
    '没有新水源证据时，耗尽的搜索不得因位置变化自动重开',
  );

  actor.knownPlaces.push({
    id: 'new-water-report',
    materialId: Material.Water,
    position: { x: 1, y: 1, z: 1 },
    learnedAtMonth: 1,
    lastConfirmedAtMonth: 1,
    sourceEventIds: ['fact:new-water-report'],
  });
  const reopened = compileBoundedWaterSearchMove(
    state,
    actor,
    actor.id,
    cellsInRadius(actor.position.cellId, 6),
    events,
  );
  assert.ok(reopened, '新的本人水源证据可以开启下一轮有限搜索');
  assert.notEqual(reopened.waterSearchBasis.evidenceKey, firstBasis.evidenceKey);

  console.log(JSON.stringify({
    ok: true,
    candidateCount: firstBasis.candidates.length,
    movementActionsBeforeExhaustion: requested.length,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
