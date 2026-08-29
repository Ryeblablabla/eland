import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-material-source-actionability-'));
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/simulation.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { inventoryCombinationForOutput, inventoryCombinationTechniqueId } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/interaction-rules.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export { cellX, cellY, cellsInRadius, findStandingPath, neighbors4, setVoxel, standingPositions } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/world/grid.ts'))};
    export { compileProjectStep } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-step-compiler.ts'))};
    export {
      localFinishedOutputAccess,
      personCanProvideProjectMaterial,
      visibleProjectMaterialHolders,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/steps/known-material-production.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=material-source-actionability-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    Material,
    cellX,
    cellY,
    cellsInRadius,
    compileProjectStep,
    createInitialState,
    findStandingPath,
    instantiateProject,
    inventoryCombinationForOutput,
    inventoryCombinationTechniqueId,
    localFinishedOutputAccess,
    neighbors4,
    personCanProvideProjectMaterial,
    setVoxel,
    standingPositions,
    visibleProjectMaterialHolders,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const stack = (id, materialId) => ({
    id,
    materialId,
    quantity: 1,
    sourceEventIds: [`source:${id}`],
  });

  function makeFixture({
    hibernating = false,
    restrained = false,
    holderAgeYears = 30,
    holderZOffset = 0,
    withDrop = false,
    dropMaterialId = Material.Bronze,
    ownerHasBrick = true,
    unreachableDestination = false,
    reverseUnrelatedDrops = false,
  }) {
    const state = createInitialState(6117, {
      chaosIntensity: 0,
      endpoint: { kind: 'months', value: 60 },
    });
    state.clock.elapsedMonths = 24;
    state.projects = [];
    state.containers = [];
    const owner = state.people[0];
    const holder = state.people[1];
    state.people = [owner, holder];
    owner.bornAtMonth = -30 * 12;
    holder.bornAtMonth = state.clock.elapsedMonths + 1 - holderAgeYears * 12;
    owner.conditions = [];
    holder.conditions = [
      ...(hibernating ? [{
        id: 'holder-hibernation',
        kind: 'dehydrated-hibernation',
        sinceMonth: 24,
        stage: 1,
        sourceEventIds: ['holder-hibernation-source'],
      }] : []),
      ...(restrained ? [{
        id: 'holder-restraint',
        kind: 'restrained',
        sinceMonth: 24,
        stage: 2,
        sourceEventIds: ['holder-restraint-source'],
      }] : []),
    ];
    owner.body = { health: 100, hydration: 100, nutrition: 100 };
    holder.body = { health: 100, hydration: 100, nutrition: 100 };
    holder.position = structuredClone(owner.position);
    holder.position.z += holderZOffset;
    owner.inventory = ownerHasBrick ? [stack('owner-fired-brick', Material.FiredBrick)] : [];
    holder.inventory = [stack('holder-bronze', Material.Bronze)];
    owner.knowledge = [];
    const smithyRule = inventoryCombinationForOutput(Material.Smithy);
    assert.ok(smithyRule);
    owner.knowledge.push({
      id: inventoryCombinationTechniqueId(smithyRule),
      kind: 'technique',
      summary: '本人已经核验铁匠铺的实体构造经验',
      confidence: 80,
      learnedAtMonth: 20,
      sourceEventIds: ['verified-smithy-technique'],
    });
    const wantedDrop = {
      id: `visible-${dropMaterialId}-drop`,
      materialId: dropMaterialId,
      quantity: 1,
      cellId: owner.position.cellId,
      z: owner.position.z,
      createdAtMonth: 24,
      sourceEventIds: [`visible-${dropMaterialId}-drop-source`],
    };
    const unrelatedDrop = {
      id: 'unrelated-fiber-drop',
      materialId: Material.Fiber,
      quantity: 1,
      cellId: owner.position.cellId,
      z: owner.position.z,
      createdAtMonth: 24,
      sourceEventIds: ['unrelated-fiber-drop-source'],
    };
    state.world.drops = withDrop
      ? (reverseUnrelatedDrops ? [unrelatedDrop, wantedDrop] : [wantedDrop, unrelatedDrop])
      : [unrelatedDrop];
    let projectSite = { cellId: owner.position.cellId, z: owner.position.z };
    if (unreachableDestination) {
      const isolatedSite = cellsInRadius(owner.position.cellId, 3)
        .filter((cellId) => cellId !== owner.position.cellId
          && !neighbors4(cellId).includes(owner.position.cellId))
        .flatMap((cellId) => standingPositions(state.world.grid, cellId))[0];
      assert.ok(isolatedSite, 'fixture requires a second real standing destination');
      for (const wallCellId of neighbors4(isolatedSite.cellId)) {
        for (let z = 0; z < state.world.grid.levels; z += 1) {
          setVoxel(state.world.grid, cellX(wallCellId), cellY(wallCellId), z, Material.Stone);
        }
      }
      assert.ok(standingPositions(state.world.grid, isolatedSite.cellId).some((position) => (
        position.z === isolatedSite.z
      )), 'isolated destination must remain a genuine standing position');
      assert.equal(findStandingPath(state.world.grid, holder.position, isolatedSite).length, 0,
        'fixture destination must be standing but unreachable from the holder');
      projectSite = isolatedSite;
    }
    const project = instantiateProject({
      id: `material-source-${hibernating ? 'sleeping' : restrained ? 'restrained' : 'active'}-${withDrop ? 'drop' : 'no-drop'}-${holderAgeYears}-${holderZOffset}`,
      kind: 'construction',
      need: 'iron-capability',
      desiredFunction: 'iron-workshop',
      summary: '用本人已核验的构造经验建立固定工位',
      ownerId: owner.id,
      beneficiaryIds: [owner.id, holder.id],
      triggerFactIds: ['verified-smithy-technique'],
      pressure: 70,
      createdAtMonth: 24,
      reviewAtMonth: 36,
      site: projectSite,
    });
    state.projects = [project];
    const access = localFinishedOutputAccess(state, owner, Material.Bronze, {
      preferLocalFinishedOutput: true,
      allowVisibleHolder: true,
    });
    const step = compileProjectStep(state, owner, state.world.drops, project);
    return { access, holder, owner, project, state, step, wantedDrop };
  }

  const sleepingWithDrop = makeFixture({ hibernating: true, withDrop: true });
  assert.equal(sleepingWithDrop.access?.kind, 'drop',
    'an alive but hibernating holder must not hide a legal visible drop');
  assert.equal(sleepingWithDrop.step?.action.kind, 'transfer');
  assert.equal(sleepingWithDrop.step?.action.kind === 'transfer'
    ? sleepingWithDrop.step.action.dropId
    : undefined, `visible-${Material.Bronze}-drop`,
  'the existing grounded collection route must acquire the visible drop');

  const sleepingWithReorderedDrops = makeFixture({
    hibernating: true,
    withDrop: true,
    reverseUnrelatedDrops: true,
  });
  assert.equal(sleepingWithReorderedDrops.step?.action.kind, 'transfer');
  assert.equal(sleepingWithReorderedDrops.step?.action.kind === 'transfer'
    ? sleepingWithReorderedDrops.step.action.dropId
    : undefined, `visible-${Material.Bronze}-drop`,
  'unrelated candidate ordering must not change the selected grounded source');

  const activeWithDrop = makeFixture({ hibernating: false, withDrop: true });
  assert.equal(activeWithDrop.access?.kind, 'holder');
  assert.equal(activeWithDrop.step?.action.kind, 'communicate',
    'an actionable visible holder keeps the established contribution path ahead of collection');
  assert.deepEqual(activeWithDrop.step?.action.kind === 'communicate'
    ? activeWithDrop.step.action.audience
    : [], [activeWithDrop.holder.id]);
  assert.equal(activeWithDrop.project.logisticsEpisodes.length, 0,
    'the unchanged handoff path must not open a competing drop episode');

  const activeWithoutDrop = makeFixture({ hibernating: false, withDrop: false });
  assert.equal(activeWithoutDrop.access?.kind, 'holder');
  assert.equal(activeWithoutDrop.step?.action.kind, 'communicate',
    'without a drop, an actionable holder still receives the ordinary request');

  const sleepingWithoutDrop = makeFixture({ hibernating: true, withDrop: false });
  assert.equal(sleepingWithoutDrop.access?.kind, 'holder',
    'the locally witnessed object remains an honest existence fact while its holder sleeps');
  assert.equal(sleepingWithoutDrop.step, null,
    'without an alternative physical source, the project must wait rather than invent search or transport');
  assert.equal(sleepingWithoutDrop.project.logisticsEpisodes.length, 0);

  const learningChildWithDrop = makeFixture({ holderAgeYears: 8, withDrop: true });
  assert.equal(personCanProvideProjectMaterial(
    learningChildWithDrop.state,
    learningChildWithDrop.holder,
  ), false);
  assert.equal(learningChildWithDrop.step?.action.kind, 'transfer',
    'a learning child cannot shadow a legal drop with an adolescent-only project contribution');

  const adolescentWithDrop = makeFixture({ holderAgeYears: 14, withDrop: true });
  assert.equal(personCanProvideProjectMaterial(adolescentWithDrop.state, adolescentWithDrop.holder), true);
  assert.equal(adolescentWithDrop.step?.action.kind, 'communicate',
    'an adolescent with a reachable route meets the contribution option minimum');

  const restrainedWithDrop = makeFixture({ restrained: true, withDrop: true });
  assert.equal(personCanProvideProjectMaterial(
    restrainedWithDrop.state,
    restrainedWithDrop.holder,
  ), false);
  assert.equal(restrainedWithDrop.step?.action.kind, 'transfer',
    'a restrained holder cannot promise transport that the action executor would block');

  const gestureOutOfRange = makeFixture({ holderZOffset: 3, withDrop: true });
  assert.equal(visibleProjectMaterialHolders(
    gestureOutOfRange.state,
    gestureOutOfRange.owner,
    Material.Bronze,
  ).some((candidate) => candidate.id === gestureOutOfRange.holder.id), true,
  'the holder remains inside ordinary visual z range');
  assert.equal(gestureOutOfRange.step?.action.kind, 'transfer',
    'a holder outside the gesture z range cannot shadow a legal drop');

  const gestureOutOfRangeWithoutDrop = makeFixture({ holderZOffset: 3, withDrop: false });
  assert.equal(gestureOutOfRangeWithoutDrop.step?.action.kind, 'move',
    'a holder outside the gesture z range must not turn an unresolved material into waiting');
  assert.equal(gestureOutOfRangeWithoutDrop.project.logisticsEpisodes.at(-1)?.kind, 'search',
    'without a legal handoff route or visible drop, the existing bounded search remains available');

  const outsideVisualRange = makeFixture({ holderZOffset: 10, withDrop: false });
  assert.equal(outsideVisualRange.access, null,
    'same-cell identity alone is not visibility when the holder is outside the ordinary z radius');

  const unreachableWithDrop = makeFixture({ unreachableDestination: true, withDrop: true });
  assert.equal(personCanProvideProjectMaterial(
    unreachableWithDrop.state,
    unreachableWithDrop.holder,
  ), true);
  assert.equal(unreachableWithDrop.step?.action.kind, 'transfer',
    'a holder with no standing path to the project destination cannot shadow a legal drop');

  const unreachableWithoutDrop = makeFixture({ unreachableDestination: true, withDrop: false });
  assert.equal(unreachableWithoutDrop.step?.action.kind, 'move',
    'an unreachable holder must not make the project wait when no grounded drop is visible');
  assert.equal(unreachableWithoutDrop.project.logisticsEpisodes.at(-1)?.kind, 'search',
    'an unreachable holder leaves the ordinary bounded material search intact');

  const inactiveFirstGapWithSecondDrop = makeFixture({
    hibernating: true,
    withDrop: true,
    dropMaterialId: Material.FiredBrick,
    ownerHasBrick: false,
  });
  assert.equal(inactiveFirstGapWithSecondDrop.step?.action.kind, 'transfer');
  assert.equal(inactiveFirstGapWithSecondDrop.step?.action.kind === 'transfer'
    ? inactiveFirstGapWithSecondDrop.step.action.dropId
    : undefined, `visible-${Material.FiredBrick}-drop`,
  'an inactive holder for one missing input must not hide a legal drop for another input');

  const actionableFirstGapWithSecondDrop = makeFixture({
    withDrop: true,
    dropMaterialId: Material.FiredBrick,
    ownerHasBrick: false,
  });
  assert.equal(actionableFirstGapWithSecondDrop.step?.action.kind, 'communicate',
    'across a multi-input deficit, an actionable holder still precedes a sibling drop');
  assert.equal(actionableFirstGapWithSecondDrop.step?.action.kind === 'communicate'
    ? actionableFirstGapWithSecondDrop.step.action.content.projectMaterialContribution?.materialId
    : undefined, Material.Bronze);

  process.stdout.write('material source actionability tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
