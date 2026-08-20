import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-society-projection-cache-test-'));
const bundlePath = path.join(temporaryDirectory, 'society-projection-cache.mjs');

function naiveActivity(state, cellCount) {
  const result = {
    traffic: new Array(cellCount).fill(0),
    transfer: new Array(cellCount).fill(0),
    action: new Array(cellCount).fill(0),
    attention: new Array(cellCount).fill(0),
  };
  for (const event of state.world.past) {
    if (event.kind !== 'action') continue;
    if (event.action.kind === 'move') {
      for (const cell of event.pathSegment) result.traffic[cell] += 1;
    } else if (event.action.kind === 'transfer') result.transfer[event.cellId] += 1;
    else if (event.action.kind === 'attend') result.attention[event.cellId] += 1;
    else result.action[event.cellId] += 1;
  }
  return result;
}

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { toSocietyState } from ${JSON.stringify(path.resolve('src/game/eland/adapter.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export {
      WORLD_CELL_COUNT, cellX, cellY, columnMaterials, setVoxel, surfaceMaterial, topZ,
    } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=society-projection-cache-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    WORLD_CELL_COUNT,
    cellX,
    cellY,
    columnMaterials,
    createInitialState,
    setVoxel,
    surfaceMaterial,
    toSocietyState,
    topZ,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(741, { endpoint: { kind: 'months', value: 3 }, chaosIntensity: 0 });
  const first = toSocietyState(state);
  const unchanged = toSocietyState(state);

  assert.strictEqual(unchanged.world.surface, first.world.surface,
    'unchanged voxel worlds must reuse the projected surface array');
  assert.strictEqual(unchanged.world.elevation, first.world.elevation,
    'unchanged voxel worlds must reuse the projected elevation array');
  assert.strictEqual(unchanged.world.columns, first.world.columns,
    'unchanged voxel worlds must reuse the projected columns array');
  assert.strictEqual(unchanged.world.palette, first.world.palette,
    'the static palette projection must be cached');
  assert.strictEqual(unchanged.world.biomes, first.world.biomes,
    'the deterministic biome projection must be cached');
  assert.strictEqual(unchanged.world.activity.traffic, first.world.activity.traffic,
    'unchanged history must reuse its persistent activity arrays');
  assert.deepEqual(first.world.activity, naiveActivity(state, WORLD_CELL_COUNT));

  const changedCell = state.people[0]?.position.cellId ?? 0;
  const previousTop = topZ(state.world.grid, changedCell);
  assert.ok(previousTop >= 0);
  const oldSurface = first.world.surface[changedCell];
  const oldElevation = first.world.elevation[changedCell];
  const oldColumn = [...first.world.columns[changedCell]];
  setVoxel(state.world.grid, cellX(changedCell), cellY(changedCell), previousTop, Material.Air);

  const changed = toSocietyState(state);
  assert.notStrictEqual(changed.world.surface, first.world.surface);
  assert.notStrictEqual(changed.world.elevation, first.world.elevation);
  assert.notStrictEqual(changed.world.columns, first.world.columns);
  assert.notStrictEqual(changed.world.columns[changedCell], first.world.columns[changedCell],
    'a changed column must receive a fresh nested array');
  const unchangedCell = (changedCell + 1) % WORLD_CELL_COUNT;
  assert.strictEqual(changed.world.columns[unchangedCell], first.world.columns[unchangedCell],
    'an unchanged column may safely share its immutable nested array');
  assert.equal(changed.world.surface[changedCell], surfaceMaterial(state.world.grid, changedCell));
  assert.equal(changed.world.elevation[changedCell], topZ(state.world.grid, changedCell));
  assert.deepEqual(changed.world.columns[changedCell], columnMaterials(state.world.grid, changedCell));
  assert.equal(first.world.surface[changedCell], oldSurface,
    'voxel invalidation must not rewrite an older frame surface');
  assert.equal(first.world.elevation[changedCell], oldElevation,
    'voxel invalidation must not rewrite an older frame elevation');
  assert.deepEqual(first.world.columns[changedCell], oldColumn,
    'voxel invalidation must not rewrite an older frame column');
  assert.strictEqual(changed.world.palette, first.world.palette);
  assert.strictEqual(changed.world.biomes, first.world.biomes);

  const person = state.people[0];
  const fromCell = person.position.cellId;
  const toCell = (fromCell + 1) % WORLD_CELL_COUNT;
  state.world.past.push({
    id: 'projection-cache-activity-action',
    kind: 'action',
    atMonth: state.clock.elapsedMonths,
    orderInMonth: 999,
    planningTick: 1,
    orderInTick: 999,
    actionTick: 1,
    who: person.id,
    cause: 'intent',
    action: { kind: 'move', toCellId: toCell },
    fromCellId: fromCell,
    toCellId: toCell,
    fromZ: person.position.z,
    toZ: person.position.z,
    pathSegment: [fromCell, toCell],
    status: 'completed',
    result: 'projection cache activity fixture',
    diff: {},
  });
  const withAction = toSocietyState(state);
  assert.deepEqual(withAction.world.activity, naiveActivity(state, WORLD_CELL_COUNT));
  assert.notStrictEqual(withAction.world.activity.traffic, changed.world.activity.traffic,
    'new action history must create a new activity snapshot');
  assert.equal(changed.world.activity.traffic[fromCell], first.world.activity.traffic[fromCell],
    'incremental activity must not mutate an older frame');

  state.world.past.push({
    id: 'projection-cache-environment-only',
    kind: 'environment',
    atMonth: state.clock.elapsedMonths,
    orderInMonth: 1_000,
    planningTick: 0,
    orderInTick: 1_000,
    cellId: fromCell,
    change: 'weather',
    result: 'projection cache non-action fixture',
    diff: {},
  });
  const environmentOnly = toSocietyState(state);
  assert.strictEqual(environmentOnly.world.activity.traffic, withAction.world.activity.traffic,
    'non-action history must advance the cursor without copying activity layers');
  assert.deepEqual(environmentOnly.world.activity, naiveActivity(state, WORLD_CELL_COUNT));

  const originalLastPath = [...withAction.agents[0].lastPath];
  person.position.lastPath.push(toCell);
  toSocietyState(state);
  assert.deepEqual(withAction.agents[0].lastPath, originalLastPath,
    'later authoritative movement must not mutate an older agent projection');

  const intentFixture = {
    ownerId: person.id,
    summary: 'projection intent fixture',
    domain: 'strategic',
    goal: { kind: 'at-cell', personId: person.id, cellId: person.position.cellId },
    nextAction: { kind: 'move', toCellId: person.position.cellId },
    createdAtMonth: state.clock.elapsedMonths,
    lastProgressAtMonth: state.clock.elapsedMonths,
    progress: 0,
    sourceDecisionEventId: 'projection-intent-decision',
    actionEventIds: [],
    replanCount: 0,
  };
  state.intents.push(
    { ...intentFixture, id: 'projection-intent-active', status: 'active' },
    { ...intentFixture, id: 'projection-intent-suspended', status: 'suspended' },
    { ...intentFixture, id: 'projection-intent-completed', status: 'completed' },
  );
  person.activeIntentId = 'projection-intent-active';
  const intentView = toSocietyState(state);
  assert.deepEqual(intentView.intents.map((intent) => intent.id), ['projection-intent-active'],
    'the UI projection must contain active intents only, never terminal or suspended history');

  console.log('society projection cache regression passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
