import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-granary-dedup-test-'));
const bundlePath = path.join(temporaryDirectory, 'granary-dedup.mjs');

try {
  const testEntry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { buildProjectOptions, recompileProjectNextAction } from ${JSON.stringify(path.resolve('src/game/eland/application/project-options.ts'))};
    export { buildDecisionContext, visibleCellsFor } from ${JSON.stringify(path.resolve('src/game/eland/application/action-options.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { cellX, cellY, neighbors4, setVoxel, surfaceStandingPosition, WORLD_CELL_COUNT, WORLD_WIDTH } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=granary-dedup-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: testEntry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    buildProjectOptions,
    buildDecisionContext,
    cellX,
    cellY,
    createInitialState,
    Material,
    neighbors4,
    recompileProjectNextAction,
    setVoxel,
    surfaceStandingPosition,
    visibleCellsFor,
    WORLD_CELL_COUNT,
    WORLD_WIDTH,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const placementFact = (id, who, atMonth, position) => ({
    id, kind: 'action', actionTick: 1, atMonth, orderInMonth: 1,
    cellId: position.x + position.y * WORLD_WIDTH, who, cause: 'intent',
    action: {
      kind: 'act', operation: 'combine',
      targets: [
        { kind: 'inventory-stack', personId: who, stackId: `stack-${who}-granary` },
        { kind: 'voxel', position: { ...position } },
      ],
    },
    fromCellId: position.x + position.y * WORLD_WIDTH,
    toCellId: position.x + position.y * WORLD_WIDTH,
    fromZ: position.z,
    toZ: position.z,
    pathSegment: [position.x + position.y * WORLD_WIDTH],
    status: 'completed', result: '公共谷仓与空气结合为公共谷仓',
    diff: { outputMaterialId: Material.Granary, position: { ...position }, sourceEventId: id },
  });
  const granaryCraftFact = (id, who, atMonth, cellId, z) => ({
    id, kind: 'action', actionTick: 1, atMonth, orderInMonth: 1,
    cellId, who, cause: 'intent',
    action: {
      kind: 'act', operation: 'combine',
      targets: [
        { kind: 'inventory-stack', personId: who, stackId: `stack-${who}-container` },
        { kind: 'inventory-stack', personId: who, stackId: `stack-${who}-plank` },
      ],
    },
    fromCellId: cellId, toCellId: cellId, fromZ: z, toZ: z, pathSegment: [cellId],
    status: 'completed', result: '木制容器与木板结合为公共谷仓',
    diff: { outputMaterialId: Material.Granary, outputQuantity: 1, sourceEventId: id },
  });
  const reserveProject = (id, ownerId, placement, beneficiaryIds, status = 'active') => ({
    id, kind: 'construction', need: 'reserve-security', desiredFunction: 'reserve-storage',
    summary: '建立公共谷仓', ownerId, beneficiaryIds,
    triggerFactIds: [], pressure: 70, createdAtMonth: placement.atMonth,
    reviewAtMonth: placement.atMonth + 24, status,
    lastProgressAtMonth: placement.atMonth, missingMaterialIds: [], reservations: [],
    contributorIds: [ownerId], actionEventIds: [placement.id], failureEventIds: [],
    completionEventIds: status === 'completed' ? [placement.id] : [], logisticsEpisodes: [],
    ...(status === 'completed' ? { completedAtMonth: placement.atMonth } : {}),
  });

  {
    const state = createInitialState(185, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 1;
    state.world.animals = [];
    const owner = state.people[0];
    const placementCell = neighbors4(owner.position.cellId)
      .map((cellId) => surfaceStandingPosition(state.world.grid, cellId))
      .find(Boolean);
    assert.ok(placementCell, '测试人物附近必须有可放置谷仓的承托位置');
    const position = { x: cellX(placementCell.cellId), y: cellY(placementCell.cellId), z: placementCell.z };
    setVoxel(state.world.grid, position.x, position.y, position.z, Material.Granary);
    const placement = placementFact('test-granary-placement', owner.id, 1, position);
    state.world.past = [placement];
    state.containers = [{
      id: 'test-granary', position: { ...position }, inventory: [], capacity: 96,
      createdAtMonth: 1, sourceEventIds: [placement.id],
    }];
    owner.inventory = [
      { id: 'test-food', materialId: Material.Food, quantity: 2, sourceEventIds: ['test-food-source'] },
      { id: 'test-spare-container', materialId: Material.Container, quantity: 1, sourceEventIds: ['test-container-source'] },
      { id: 'test-spare-plank', materialId: Material.Plank, quantity: 1, sourceEventIds: ['test-plank-source'] },
    ];
    state.projects = [reserveProject('test-active-reserve', owner.id, placement, [owner.id])];

    const nextAction = recompileProjectNextAction(state, owner, 'test-active-reserve');
    assert.equal(nextAction?.kind, 'transfer', '谷仓一旦落地，项目下一步必须转为真实入库，不能再造第二个谷仓');
    assert.equal(nextAction?.to.kind, 'container');
    assert.equal(nextAction?.to.containerId, 'test-granary');
  }

  {
    const state = createInitialState(185, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 6;
    state.world.animals = [];
    state.world.drops = [];
    const maker = state.people[0];
    const collaborator = state.people[1];
    const craft = granaryCraftFact('test-shared-granary-craft', maker.id, 7, maker.position.cellId, maker.position.z);
    maker.inventory = [{
      id: `stack-${maker.id}-granary`, materialId: Material.Granary, quantity: 1,
      sourceEventIds: [craft.id],
    }];
    collaborator.inventory = [
      { id: `stack-${collaborator.id}-container`, materialId: Material.Container, quantity: 1, sourceEventIds: ['collaborator-container'] },
      { id: `stack-${collaborator.id}-plank`, materialId: Material.Plank, quantity: 1, sourceEventIds: ['collaborator-plank'] },
    ];
    collaborator.knowledge.push({
      id: `technique:combine-inventory:${Math.min(Material.Container, Material.Plank)}x1+${Math.max(Material.Container, Material.Plank)}x1:${Material.Granary}`,
      kind: 'technique', summary: '把木制容器加固成公共谷仓', confidence: 80,
      learnedAtMonth: 6, sourceEventIds: ['known-granary-technique'],
    });
    const project = reserveProject('test-shared-reserve', maker.id, craft, [maker.id, collaborator.id]);
    project.contributorIds.push(collaborator.id);
    state.projects = [project];
    state.world.past = [craft];

    const makerNext = recompileProjectNextAction(state, maker, project.id);
    assert.equal(makerNext?.kind, 'act', '已经持有项目谷仓的人应先把它落地');
    assert.equal(makerNext?.operation, 'combine');
    const collaboratorNext = recompileProjectNextAction(state, collaborator, project.id);
    assert.equal(collaboratorNext, null, '同月已有协作者制成谷仓后，其他人不能并发再造一个');
  }

  {
    const state = createInitialState(20260815, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 12;
    state.world.animals = [];
    state.world.drops = [];
    const builder = state.people[0];
    const observer = state.people[1];
    const remoteStanding = Array.from({ length: WORLD_CELL_COUNT }, (_, cellId) => (
      surfaceStandingPosition(state.world.grid, cellId)
    )).find((position) => position
      && Math.abs(cellX(position.cellId) - cellX(observer.position.cellId))
        + Math.abs(cellY(position.cellId) - cellY(observer.position.cellId)) > 18);
    assert.ok(remoteStanding, '测试世界必须有视野外的可承托位置');
    const position = { x: cellX(remoteStanding.cellId), y: cellY(remoteStanding.cellId), z: remoteStanding.z };
    setVoxel(state.world.grid, position.x, position.y, position.z, Material.Granary);
    const placement = placementFact('test-completed-granary-placement', builder.id, 6, position);
    state.world.past = [placement];
    const completed = reserveProject('test-completed-reserve', builder.id, placement, [builder.id], 'completed');
    state.projects = [completed];
    observer.inventory = [
      { id: 'observer-food', materialId: Material.Food, quantity: 6, sourceEventIds: ['observer-food-source'] },
      { id: 'observer-container', materialId: Material.Container, quantity: 1, sourceEventIds: ['observer-container-source'] },
      { id: 'observer-plank', materialId: Material.Plank, quantity: 1, sourceEventIds: ['observer-plank-source'] },
    ];
    observer.knownPlaces = [];
    const visibleCells = visibleCellsFor(observer);
    assert.ok(!visibleCells.includes(remoteStanding.cellId), '既有谷仓必须在观察者当前视野外');
    const reserveProposal = () => buildProjectOptions(state, observer, visibleCells, [], [])
      .some((option) => option.projectProposal?.desiredFunction === 'reserve-storage');

    assert.equal(reserveProposal(), true, '与既有项目无关联的人仍可在真实局部缺口下另建谷仓');
    completed.beneficiaryIds.push(observer.id);
    assert.equal(reserveProposal(), false, '已完成公共谷仓的受益人不应再次提出同功能设施');
    setVoxel(state.world.grid, position.x, position.y, position.z, Material.Air);
    assert.equal(reserveProposal(), true, '关联设施已经消失后，旧完成记录不能永久压制重建');
  }

  {
    const state = createInitialState(20260816, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 12;
    state.world.animals = [];
    state.world.drops = [];
    state.projects = [];
    const person = state.people[0];
    person.inventory = [
      { id: 'ordinary-container', materialId: Material.Container, quantity: 1, sourceEventIds: ['ordinary-container-source'] },
      { id: 'ordinary-plank', materialId: Material.Plank, quantity: 1, sourceEventIds: ['ordinary-plank-source'] },
      { id: 'ordinary-fiber', materialId: Material.Fiber, quantity: 2, sourceEventIds: ['ordinary-fiber-source'] },
    ];
    person.knowledge.push(
      {
        id: `technique:combine-inventory:${Math.min(Material.Container, Material.Plank)}x1+${Math.max(Material.Container, Material.Plank)}x1:${Material.Granary}`,
        kind: 'technique', summary: '把木制容器加固成公共谷仓', confidence: 80,
        learnedAtMonth: 6, sourceEventIds: ['known-granary-technique'],
      },
      {
        id: `technique:combine-inventory:${Material.Fiber}x2:${Material.Rope}`,
        kind: 'technique', summary: '把两份纤维编成绳索', confidence: 80,
        learnedAtMonth: 6, sourceEventIds: ['known-rope-technique'],
      },
    );

    const options = buildDecisionContext(state, person, 13).options;
    assert.ok(!options.some((option) => option.id === 'repeat-inventory-combine:ordinary-container:ordinary-plank'),
      '完成需求后，普通局部试验不得反复制作公共设施并堆进背包');
    assert.ok(options.some((option) => option.id === 'repeat-inventory-combine:ordinary-fiber:ordinary-fiber'),
      '非设施物质经验仍可作为普通复现候选');
  }

  process.stdout.write('granary project dedup tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
