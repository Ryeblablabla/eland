import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-wildlife-threat-response-'));
const bundlePath = path.join(temporaryDirectory, 'wildlife-threat-response.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { shelterGeometryAt } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/structure.ts'))};
    export {
      compileWildlifeThreatResponse,
      shouldRemainShelteredFromWildlifeThreat,
      visibleWildlifeThreats,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/wildlife-threat.ts'))};
    export { cellId, cellX, cellY, cellsInRadius, neighbors4, setVoxel } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=wildlife-threat-response-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    cellId,
    cellX,
    cellY,
    cellsInRadius,
    compileWildlifeThreatResponse,
    createInitialState,
    executePrimitiveAction,
    neighbors4,
    setVoxel,
    shelterGeometryAt,
    shouldRemainShelteredFromWildlifeThreat,
    visibleWildlifeThreats,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  function flatten(state, center, radius = 10) {
    for (const localCell of cellsInRadius(center, radius)) {
      const x = cellX(localCell);
      const y = cellY(localCell);
      for (let z = 0; z < state.world.grid.levels; z += 1) {
        setVoxel(state.world.grid, x, y, z, z === 0 ? Material.PackedSoil : Material.Air);
      }
    }
  }

  function placePerson(person, cell, z = 1) {
    person.position = {
      ...person.position,
      cellId: cell,
      z,
      previousCellId: cell,
      previousZ: z,
      lastPath: [cell],
      tickPath: [cell],
    };
    person.conditions = [];
    person.body = { health: 90, hydration: 90, nutrition: 90 };
  }

  function wolf(id, cell, atMonth, targetPersonId) {
    return {
      id,
      speciesId: 'wolf',
      sex: 'male',
      bornAtMonth: 0,
      lifespanMonths: 180,
      geneticParents: [],
      position: { cellId: cell, z: 1, previousCellId: cell, previousZ: 1 },
      health: 80,
      hunger: 96,
      lastAteAtMonth: 0,
      ecology: {
        version: 'local-threat-ecology-v1',
        packId: `pack:${id}`,
        territory: { anchorCellId: cell, radius: 18 },
        currentBehavior: {
          atMonth,
          mode: 'pursue-human',
          targetCellId: cell,
          targetPersonId,
        },
      },
    };
  }

  function fixture(seed = 20_260_901) {
    const state = createInitialState(seed, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 12;
    state.world.past = [];
    state.world.drops = [];
    state.world.animals = [];
    state.derived.structures = [];
    state.intents = [];
    state.projects = [];
    const actor = state.people[0];
    const center = cellId(42, 26);
    flatten(state, center);
    placePerson(actor, center);
    actor.baselineCapacities.perception = 100;
    actor.inventory = [];
    for (const other of state.people.slice(1)) other.diedAtMonth = 0;
    return { state, actor, center, atMonth: 13 };
  }

  // A currently visible pursuing wolf produces one exact, increasing flee step.
  {
    const { state, actor, center, atMonth } = fixture();
    const wolfCell = center + 2;
    state.world.animals = [wolf('wolf-visible', wolfCell, atMonth, actor.id)];
    const threats = visibleWildlifeThreats(state, actor, atMonth);
    assert.deepEqual(threats.map((item) => item.animalId), ['wolf-visible']);
    const response = compileWildlifeThreatResponse(state, actor, atMonth);
    assert.ok(response);
    assert.equal(response.basis.response, 'flee-step');
    const before = Math.abs(cellX(center) - cellX(wolfCell)) + Math.abs(cellY(center) - cellY(wolfCell));
    const fact = executePrimitiveAction(state, actor, {
      kind: 'move',
      toCellId: response.toCellId,
      toZ: response.toZ,
      wildlifeThreatBasis: response.basis,
    }, atMonth, 0, { cause: 'survival-reflex', actionTick: 1 });
    assert.equal(fact.status, 'completed');
    assert.equal(fact.diff.wildlifeThreatResponse, true);
    assert.equal(fact.diff.wildlifeThreatResponseKind, 'flee-step');
    assert.ok(Number(fact.diff.wildlifeThreatDistanceAfter) > Number(fact.diff.wildlifeThreatDistanceBefore));
    const after = Math.abs(cellX(actor.position.cellId) - cellX(wolfCell)) + Math.abs(cellY(actor.position.cellId) - cellY(wolfCell));
    assert.ok(after > before);
  }

  // An old compiled response cannot move after the observed animal changes position.
  {
    const { state, actor, center, atMonth } = fixture(20_260_902);
    state.world.animals = [wolf('wolf-stale', center + 2, atMonth, actor.id)];
    const response = compileWildlifeThreatResponse(state, actor, atMonth);
    assert.ok(response);
    state.world.animals[0].position.cellId = center + 3;
    const fact = executePrimitiveAction(state, actor, {
      kind: 'move', toCellId: response.toCellId, toZ: response.toZ, wildlifeThreatBasis: response.basis,
    }, atMonth, 0, { cause: 'survival-reflex', actionTick: 1 });
    assert.equal(fact.status, 'blocked');
    assert.equal(fact.diff.wildlifeThreatResponseInvalidated, true);
    assert.equal(actor.position.cellId, center);
  }

  // A parent responds when the visible wolf is pursuing a co-located dependent;
  // the existing movement primitive carries that child along the exact step.
  {
    const { state, actor, center, atMonth } = fixture(20_260_903);
    const child = state.people[1];
    child.diedAtMonth = undefined;
    child.body.health = 90;
    child.geneticParents = [actor.id];
    child.bornAtMonth = atMonth - 6;
    placePerson(child, center);
    state.world.animals = [wolf('wolf-child-target', center + 2, atMonth, child.id)];
    assert.equal(compileWildlifeThreatResponse(state, child, atMonth), null,
      '同格且可行动的亲代负责携行，受抚养儿童不再独立逃跑');
    const response = compileWildlifeThreatResponse(state, actor, atMonth);
    assert.ok(response);
    assert.ok(response.basis.protectedPersonIds.includes(child.id));
    const fact = executePrimitiveAction(state, actor, {
      kind: 'move', toCellId: response.toCellId, toZ: response.toZ, wildlifeThreatBasis: response.basis,
    }, atMonth, 0, { cause: 'survival-reflex', actionTick: 1 });
    assert.equal(fact.status, 'completed');
    assert.deepEqual(fact.diff.carriedPersonIds, [child.id]);
    assert.equal(child.position.cellId, actor.position.cellId);
    assert.equal(child.position.z, actor.position.z);
  }

  // A nearby physical shelter is chosen before open-ground flight, remains
  // protective, and a destroyed roof invalidates the precompiled step.
  {
    const { state, actor, center, atMonth } = fixture(20_260_904);
    const shelterCell = neighbors4(center)[0];
    const shelterPosition = { cellId: shelterCell, z: 1 };
    setVoxel(state.world.grid, cellX(shelterCell), cellY(shelterCell), 3, Material.Stone);
    const wallCell = neighbors4(shelterCell).find((cell) => cell !== center);
    setVoxel(state.world.grid, cellX(wallCell), cellY(wallCell), 1, Material.Stone);
    assert.ok(shelterGeometryAt(state.world.grid, shelterPosition));
    state.derived.structures = [{
      id: 'test-wildlife-shelter',
      name: '测试住所',
      occupiedCells: [shelterCell, wallCell],
      interiorCells: [shelterCell],
      interiorPositions: [shelterPosition],
      materialIds: [Material.Stone],
      weatherProtection: 50,
      thermalInsulation: 50,
      capacity: 1,
      complete: true,
      sourceEventIds: [],
    }];
    state.world.animals = [wolf('wolf-shelter', center + 2, atMonth, actor.id)];
    const response = compileWildlifeThreatResponse(state, actor, atMonth);
    assert.ok(response);
    assert.equal(response.basis.response, 'shelter-step');
    assert.equal(response.toCellId, shelterCell);
    const fact = executePrimitiveAction(state, actor, {
      kind: 'move', toCellId: response.toCellId, toZ: response.toZ, wildlifeThreatBasis: response.basis,
    }, atMonth, 0, { cause: 'survival-reflex', actionTick: 1 });
    assert.equal(fact.status, 'completed');
    assert.ok(shelterGeometryAt(state.world.grid, actor.position));
    assert.equal(shouldRemainShelteredFromWildlifeThreat(state, actor, atMonth), true);

    const stale = fixture(20_260_905);
    const staleShelterCell = neighbors4(stale.center)[0];
    const stalePosition = { cellId: staleShelterCell, z: 1 };
    setVoxel(stale.state.world.grid, cellX(staleShelterCell), cellY(staleShelterCell), 3, Material.Stone);
    const staleWall = neighbors4(staleShelterCell).find((cell) => cell !== stale.center);
    setVoxel(stale.state.world.grid, cellX(staleWall), cellY(staleWall), 1, Material.Stone);
    stale.state.derived.structures = [{
      id: 'stale-shelter', name: '失效住所', occupiedCells: [staleShelterCell, staleWall],
      interiorCells: [staleShelterCell], interiorPositions: [stalePosition], materialIds: [Material.Stone],
      weatherProtection: 50, thermalInsulation: 50, capacity: 1, complete: true, sourceEventIds: [],
    }];
    stale.state.world.animals = [wolf('wolf-stale-shelter', stale.center + 2, stale.atMonth, stale.actor.id)];
    const staleResponse = compileWildlifeThreatResponse(stale.state, stale.actor, stale.atMonth);
    assert.equal(staleResponse?.basis.response, 'shelter-step');
    setVoxel(stale.state.world.grid, cellX(staleShelterCell), cellY(staleShelterCell), 3, Material.Air);
    const blocked = executePrimitiveAction(stale.state, stale.actor, {
      kind: 'move', toCellId: staleResponse.toCellId, toZ: staleResponse.toZ, wildlifeThreatBasis: staleResponse.basis,
    }, stale.atMonth, 0, { cause: 'survival-reflex', actionTick: 1 });
    assert.equal(blocked.status, 'blocked');
    assert.equal(stale.actor.position.cellId, stale.center);
  }

  // Non-aggressive or non-visible animals do not manufacture an emergency.
  {
    const { state, actor, center, atMonth } = fixture(20_260_906);
    const distantWolf = wolf('wolf-distant', center + 20, atMonth, actor.id);
    const deer = { ...wolf('deer-near', center + 1, atMonth, actor.id), speciesId: 'deer' };
    state.world.animals = [distantWolf, deer];
    assert.deepEqual(visibleWildlifeThreats(state, actor, atMonth), []);
    assert.equal(compileWildlifeThreatResponse(state, actor, atMonth), null);
  }

  console.log('wildlife threat response tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
