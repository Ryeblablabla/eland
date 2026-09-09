import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// A controlled domain fixture. These choices are supplied by the test and are
// never counted as autonomous invention, adoption, or civilization progress.
const temporary = mkdtempSync(path.join(tmpdir(), 'eland-material-cycle-'));
try {
  const bundle = path.join(temporary, 'cycle.mjs');
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=material-cycle.ts', `--outfile=${bundle}`, '--log-level=error',
  ], {
    input: `export { createInitialState, buildDecisionContexts } from './src/game/eland/simulation';
      export { applyDecision, executeActiveIntent } from './src/game/eland/application/simulation/intent-execution';
      export { executePrimitiveAction } from './src/game/eland/domain/action-executor';
      export { buildDecisionRequestContext } from './src/game/eland/application/model-decision/decision-context';
      export { buildDecisionModelRequestProtocol } from './server/model-decision-gateway';
      export { compileModelNativeOperation, nativeWorldRefHandle } from './src/game/eland/application/model-decision/native-operation-context';
      export { advanceWorksMonth } from './src/game/eland/domain/works';
      export { advanceWorldProcesses } from './src/game/eland/domain/monthly-processes';
      export { seededFraction } from './src/game/eland/world/generator';
      export { Material, materialDefinition } from './src/game/eland/domain/material';
      export { cellId, setVoxel, voxelAt, isStandingPosition } from './src/game/eland/world/grid';`,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const api = await import(pathToFileURL(bundle).href);
  const voxel = (x, y, z) => ({ kind: 'voxel', position: { x, y, z } });

  for (const materialId of [api.Material.Wood, api.Material.WetSoil]) {
    const state = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
    const person = state.people[0];
    const grid = state.world.grid;
    for (let x = 9; x <= 17; x++) for (let y = 9; y <= 17; y++) {
      for (let z = 0; z < grid.levels; z++) api.setVoxel(grid, x, y, z,
        z === 0 ? api.Material.Stone : api.Material.Air);
    }
    person.position = { ...person.position, cellId: api.cellId(12, 12), z: 1 };
    person.inventory = [];
    person.knowledge = [];
    state.world.drops = [];
    let order = 0;
    let atMonth = 1;
    const native = (request) => {
      const context = api.buildDecisionContexts(state, atMonth).find((entry) => entry.person.id === person.id);
      if (request.kind === 'assemble') {
        const view = api.buildDecisionRequestContext(context);
        const protocol = api.buildDecisionModelRequestProtocol(view);
        const handle = (target) => {
          const value = api.nativeWorldRefHandle(target, protocol.handles);
          assert(value, `the actual perception must expose the chosen object/space: ${JSON.stringify(target)}`);
          return value;
        };
        const wire = { kind: 'assemble', targetHandle: handle(request.target),
          inputs: request.inputs.map((input) => ({ targetHandle: handle(input.target), quantity: input.quantity })),
          ...(request.arrangement ? { arrangement: request.arrangement } : {}),
          ...(request.layout ? { layout: request.layout.voxels.map((voxel) => ({
            offset: voxel.offset, materialKey: api.materialDefinition(voxel.materialId).key,
          })) } : {}),
        };
        const parsed = api.compileModelNativeOperation(wire, view, protocol.handles);
        assert.deepEqual(parsed, request, 'model-facing handles preserve exact input quantities, subject and geometry');
        request = parsed;
      }
      const decision = api.applyDecision(state, person, { ...context, options: [], followUpOptions: [], activeIntent: undefined }, {
        kind: 'idle', reason: '执行本次明确选择的材料操作', nativeOperation: request,
        authoredAttempt: { kind: 'native' },
      }, true, atMonth, ++order, order);
      assert(decision.intentId, JSON.stringify(decision.executionCompilation));
      const events = [];
      for (let tick = 0; tick < 12; tick++) {
        const intent = state.intents.find((entry) => entry.id === decision.intentId);
        if (!['active', 'proposed'].includes(intent.status)) break;
        const event = api.executeActiveIntent(state, person, atMonth, ++order, order);
        assert(event, 'an active operation must yield a concrete action');
        events.push(event);
      }
      assert(events.length, 'the native operation was actually executed');
      const intent = state.intents.find((entry) => entry.id === decision.intentId);
      assert.equal(intent.status, 'completed', `${intent.status}: ${events.at(-1).result}`);
      return events.at(-1);
    };
    const held = () => person.inventory.filter((stack) => stack.materialId === materialId)
      .reduce((sum, stack) => sum + stack.quantity, 0);
    const represented = () => held()
      + state.world.drops.filter((drop) => drop.materialId === materialId).reduce((sum, drop) => sum + drop.quantity, 0)
      + (state.world.works ?? []).flatMap((work) => work.components)
        .filter((part) => part.materialId === materialId).reduce((sum, part) => sum + part.quantity, 0);

    if (materialId === api.Material.WetSoil) {
      for (const source of [voxel(13, 12, 1), voxel(12, 13, 1)]) {
        api.setVoxel(grid, source.position.x, source.position.y, source.position.z, materialId);
        const event = native({ kind: 'transfer', source, destination: { kind: 'person', personId: person.id }, quantity: 1 });
        assert.equal(event.diff.terrainExtraction, true);
        assert.equal(api.voxelAt(grid, source.position.x, source.position.y, source.position.z), api.Material.Air);
      }
    } else {
      state.world.drops.push({ id: 'fixture-wood', materialId, quantity: 2,
        cellId: person.position.cellId, z: person.position.z, createdAtMonth: 0,
        sourceEventIds: ['fixture-material-source'] });
      native({ kind: 'transfer', source: { kind: 'drop', dropId: 'fixture-wood' },
        destination: { kind: 'person', personId: person.id }, quantity: 2 });
    }
    assert.equal(held(), 2);
    const stock = person.inventory.find((stack) => stack.materialId === materialId);
    const sourceEvents = [...stock.sourceEventIds];
    const source = { kind: 'inventory-stack', personId: person.id, stackId: stock.id };
    const anchor = voxel(13, 12, 1);
    const layout = (offsets) => ({ version: 'work-layout-v1',
      voxels: offsets.map(([x, y, z]) => ({ offset: { x, y, z }, materialId })) });
    const assembled = native({ kind: 'assemble', target: anchor,
      inputs: [{ target: source, quantity: 2 }], arrangement: 'pile',
      layout: layout([[0, 0, 0], [0, 1, 0]]) });
    assert.equal(assembled.status, 'completed', assembled.result);
    const workId = state.world.works[0].id;
    assert.equal(held(), 0);
    assert.equal(represented(), 2);
    assert(api.isStandingPosition(grid, { cellId: api.cellId(13, 12), z: 2 }));
    const use = native({ kind: 'move', target: voxel(13, 12, 2), withinDistance: 0 });
    assert.equal(person.position.z, 2);
    assert(use.diff.workUseReceipts?.some((receipt) => receipt.workId === workId),
      'actual movement over the placed material must use its physical support');
    native({ kind: 'move', target: voxel(12, 12, 1), withinDistance: 0 });
    const reshaped = native({ kind: 'assemble', target: { kind: 'work', workId },
      inputs: [], layout: layout([[0, 0, 0], [0, 0, 1]]) });
    assert.equal(reshaped.status, 'completed', reshaped.result);
    assert.equal(state.world.works[0].id, workId);
    assert.equal(api.voxelAt(grid, 13, 13, 1), api.Material.Air);
    assert(!api.isStandingPosition(grid, { cellId: api.cellId(13, 12), z: 2 }),
      'changing the layout changes where the body can stand');
    assert(api.isStandingPosition(grid, { cellId: api.cellId(13, 12), z: 3 }));
    assert.equal(represented(), 2, 'rearranging existing components consumes no extra material');

    // A creative translation can contain successive reshapes. The second
    // must clear positions placed by the first, not just the original layout.
    const sequential = api.executePrimitiveAction(state, person, {
      kind: 'world-interact', adjudication: {
        version: 'world-adjudicated-interaction-v1', request: '先平放，再重新叠起现有材料',
        status: 'completed', result: '尝试重排', targets: [{ kind: 'work', workId }],
        effects: [layout([[0, 0, 0], [0, 1, 0]]), layout([[0, 0, 0], [0, 0, 1]])]
          .map((nextLayout) => ({ kind: 'modify-structure', target: { kind: 'work', workId }, layout: nextLayout })),
      },
    }, 1, ++order, { cause: 'intent', actionTick: order });
    state.world.past.push(sequential);
    assert.equal(sequential.status, 'completed', sequential.result);
    assert.equal(api.voxelAt(grid, 13, 13, 1), api.Material.Air, 'intermediate geometry cannot remain as unaccounted matter');
    assert.equal(represented(), 2);

    const recovered = native(materialId === api.Material.WetSoil
      ? { kind: 'transfer', source: voxel(13, 12, 2), destination: { kind: 'person', personId: person.id }, quantity: 1 }
      : { kind: 'act', operation: 'separate', targets: [voxel(13, 12, 2)] });
    assert.equal(recovered.status, 'completed', recovered.result);
    assert.equal(represented(), 2, 'a placed voxel cannot turn into a natural tree harvest');
    assert.equal(state.world.drops.filter((drop) => drop.materialId === api.Material.Fiber).length, 0);
    assert.equal(api.voxelAt(grid, 13, 12, 2), api.Material.Air);
    const remaining = state.world.works.find((work) => work.id === workId);
    assert.equal(remaining.components.reduce((sum, part) => sum + part.quantity, 0), 1);
    assert.equal(remaining.layout.voxels.length, 1);

    native({ kind: 'act', operation: 'separate', targets: [{ kind: 'work', workId }] });
    assert.equal(state.world.works.length, 0);
    assert.equal(api.voxelAt(grid, 13, 12, 1), api.Material.Air);
    const recoveryDrops = state.world.drops.filter((drop) => drop.materialId === materialId && drop.quantity > 0);
    assert.equal(held() + recoveryDrops.reduce((sum, drop) => sum + drop.quantity, 0), 2);
    assert(sourceEvents.every((id) => recoveryDrops.some((drop) => drop.sourceEventIds.includes(id))),
      'recovered material retains its acquisition source');
    for (const drop of recoveryDrops) native({ kind: 'transfer', source: { kind: 'drop', dropId: drop.id },
      destination: { kind: 'person', personId: person.id }, quantity: drop.quantity });
    assert.equal(held(), 2);
    api.advanceWorksMonth(state.world, { seed: 31, atMonth: 2, weatherKind: 'clear',
      makeDropId: (work, component) => `collapse-${work.id}-${component.materialId}` });
    assert.equal(represented(), 2, 'a removed work must not pay out again next month');
    const reusedStock = person.inventory.find((stack) => stack.materialId === materialId);
    native({ kind: 'assemble', target: voxel(12, 13, 1),
      inputs: [{ target: { kind: 'inventory-stack', personId: person.id, stackId: reusedStock.id }, quantity: 2 }],
      arrangement: 'pile', layout: layout([[0, 0, 0], [1, 0, 0]]) });
    const newWork = state.world.works[0];
    assert.notEqual(newWork.id, workId, 'recovered materials form a new entity, not a resurrected old work');
    const reuse = native({ kind: 'move', target: voxel(12, 13, 2), withinDistance: 0 });
    assert(reuse.diff.workUseReceipts?.some((receipt) => receipt.workId === newWork.id));
    assert.equal(represented(), 2);
    if (materialId === api.Material.WetSoil) {
      // Select a deterministic drying precondition in this development
      // fixture, then exercise the real monthly process and real recovery.
      state.civilization.climate = { ...state.civilization.climate, kind: 'heat', severity: 5 };
      state.civilization.weather = { ...state.civilization.weather, kind: 'clear', intensity: 0 };
      const dryMonth = Array.from({ length: 24 }, (_, index) => index + 2).find((month) =>
        api.seededFraction(state.seed, `world-process:${month}:${api.cellId(12, 13)}:${materialId}`) < 5 * 0.045);
      assert(dryMonth);
      atMonth = dryMonth;
      state.clock.elapsedMonths = dryMonth;
      const weatherEvents = api.advanceWorldProcesses(state, dryMonth);
      const drying = weatherEvents.find((event) => event.diff.changes?.some((change) =>
        change.cellId === api.cellId(12, 13) && change.process === 'drying'));
      assert(drying, 'the actual monthly process changes the placed material');
      const changed = state.world.works.find((work) => work.id === newWork.id);
      assert(changed, 'drying retains the physical entity and its identity');
      assert.equal(changed.anchorMaterialId, api.Material.Soil);
      assert(changed.components.some((part) => part.materialId === api.Material.Soil
        && part.sourceEventIds.includes(drying.id)));
      const dismantled = native({ kind: 'act', operation: 'separate', targets: [{ kind: 'work', workId: newWork.id }] });
      assert(dismantled.diff.outputs.some((part) => part.materialId === api.Material.Soil),
        'recovery returns the changed soil, not the originally wet material');
      assert.equal(dismantled.diff.outputs.reduce((sum, part) => sum + part.quantity, 0), 2);
    }
    console.log(`[material-cycle] material ${materialId}: acquire → layout → physical use → reshape → partial/full recovery → reuse`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
