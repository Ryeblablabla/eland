import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-local-shelter-capacity-test-'));
const bundlePath = path.join(temporaryDirectory, 'local-shelter-capacity.mjs');

try {
  const testEntry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export {
      activeProjectOverlapsLocalProposal,
      deriveProjectProposals,
    } from ${JSON.stringify(path.resolve('src/game/eland/application/projects/project-proposals.ts'))};
    export { executeProtectiveInterruption } from ${JSON.stringify(path.resolve('src/game/eland/application/simulation/intent-execution.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export {
      cellId, cellX, cellY, cellsInRadius, neighbors4, setVoxel,
    } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=local-shelter-capacity-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: testEntry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    Material,
    activeProjectOverlapsLocalProposal,
    cellId,
    cellX,
    cellY,
    cellsInRadius,
    createInitialState,
    deriveProjectProposals,
    executeProtectiveInterruption,
    neighbors4,
    setVoxel,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  function resetPerson(person, position) {
    delete person.diedAtMonth;
    person.position = {
      cellId: position.cellId,
      z: position.z,
      previousCellId: position.cellId,
      previousZ: position.z,
      lastPath: [],
      tickPath: [position.cellId],
    };
    person.body = { health: 100, hydration: 100, nutrition: 100 };
    person.conditions = [];
    person.inventory = [];
    delete person.activeIntentId;
  }

  const state = createInitialState(9498, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const actor = state.people[0];
  const shelteredOther = state.people[1];
  assert.ok(actor && shelteredOther, '局部住所容量测试需要两名人物');
  const center = cellId(42, 26);
  const site = { cellId: center, z: 1 };
  for (const localCell of cellsInRadius(center, 10)) {
    const x = cellX(localCell);
    const y = cellY(localCell);
    for (let z = 0; z < state.world.grid.levels; z += 1) {
      setVoxel(state.world.grid, x, y, z, z === 0 ? Material.PackedSoil : Material.Air);
    }
  }
  setVoxel(state.world.grid, cellX(center), cellY(center), site.z + 2, Material.Stone);
  const wallCell = neighbors4(center)[0];
  setVoxel(state.world.grid, cellX(wallCell), cellY(wallCell), site.z, Material.Stone);
  for (const person of state.people) person.diedAtMonth = 0;
  resetPerson(shelteredOther, site);
  const actorCell = neighbors4(center)[1];
  resetPerson(actor, { cellId: actorCell, z: site.z });
  state.clock.elapsedMonths = 12;
  state.projects = [];
  state.civilization.climate.kind = 'temperate';
  state.civilization.climate.severity = 0;
  state.civilization.weather.kind = 'clear';
  state.civilization.weather.intensity = 0;
  actor.baselineCapacities.perception = 100;

  function shelterProposals(visiblePeople) {
    const visibleCells = cellsInRadius(actor.position.cellId, 8);
    return deriveProjectProposals(state, actor, visibleCells, [], visiblePeople)
      .filter((proposal) => proposal.desiredFunction === 'weather-shelter'
        && !proposal.shelterRequirement);
  }

  const shortageProposals = shelterProposals([shelteredOther]);
  assert.equal(shortageProposals.length, 1,
    '温和天气中，一处已占用的单人住所不能压制眼前露宿者的扩容项目');
  const shortageProposal = shortageProposals[0];
  assert.ok(shortageProposal.pressureBasis.reasonKeys.includes('local-shelter-capacity-shortfall'));
  assert.ok(shortageProposal.pressureBasis.edgeKeys.includes('state:visible-shelter-population:2'));
  assert.ok(shortageProposal.pressureBasis.edgeKeys.includes('state:visible-shelter-capacity:1'));
  assert.ok(shortageProposal.pressureBasis.edgeKeys.includes('state:visible-shelter-shortfall:1'));
  assert.deepEqual(shortageProposal.beneficiaryIds, [actor.id]);

  const visibleCells = cellsInRadius(actor.position.cellId, 8);
  const ordinaryProject = {
    ...structuredClone(shortageProposal),
    status: 'active',
    lastProgressAtMonth: 13,
    missingMaterialIds: [],
    reservations: [],
    contributorIds: [actor.id],
    actionEventIds: [],
    failureEventIds: [],
    completionEventIds: [],
  };
  const adaptationRequirement = {
    exposureKind: 'heat',
    beneficiaryId: actor.id,
    baselineEnclosedSides: 1,
    baselineOpenSides: 3,
    baselineWeatherProtection: 68,
    baselineThermalInsulation: 34,
    minimumEnclosedSides: 3,
    sourceEventIds: ['test-local-heat-source'],
  };
  assert.equal(activeProjectOverlapsLocalProposal(
    state,
    ordinaryProject,
    actor,
    'weather-shelter',
    [actor.id],
    shortageProposal.site,
    adaptationRequirement,
    undefined,
    new Set(visibleCells),
    13,
  ), false, '普通扩容项目不得吞并带来源的同址住所补强项目');
  assert.equal(activeProjectOverlapsLocalProposal(
    state,
    ordinaryProject,
    actor,
    'weather-shelter',
    [actor.id],
    shortageProposal.site,
    undefined,
    undefined,
    new Set(visibleCells),
    13,
  ), true, '同类普通扩容项目仍应在局部重叠时复用');

  const completedProject = {
    ...ordinaryProject,
    status: 'completed',
    completedAtMonth: 13,
    completionEventIds: [],
  };
  state.projects = [completedProject];
  const completedIntent = {
    id: 'intent-test-completed-shelter-project',
    ownerId: actor.id,
    summary: shortageProposal.summary,
    domain: 'strategic',
    goal: { kind: 'project-completed', projectId: completedProject.id },
    nextAction: structuredClone(shortageProposal.site
      ? { kind: 'move', toCellId: shortageProposal.site.cellId, toZ: shortageProposal.site.z }
      : { kind: 'move', toCellId: actor.position.cellId, toZ: actor.position.z }),
    status: 'active',
    createdAtMonth: 13,
    lastProgressAtMonth: 13,
    progress: 0,
    sourceDecisionEventId: 'decision-test-completed-shelter-project',
    projectId: completedProject.id,
    sourceFactIds: [],
    actionEventIds: [],
    replanCount: 0,
  };
  state.intents = [completedIntent];
  actor.activeIntentId = completedIntent.id;
  const reflexTarget = neighbors4(actor.position.cellId)
    .find((candidate) => candidate !== center);
  assert.ok(reflexTarget !== undefined);
  const reflexFact = executeProtectiveInterruption(
    state,
    actor,
    { kind: 'move', toCellId: reflexTarget, toZ: actor.position.z },
    'survival-reflex',
    14,
    1,
    [],
  );
  assert.equal(reflexFact.intentId, undefined,
    '已完成住所项目的旧 intentId 不得污染下一月生存反射');
  assert.equal(completedIntent.status, 'completed');
  assert.equal(completedIntent.goalOutcome?.kind, 'achieved');
  assert.equal(actor.activeIntentId, undefined);

  shelteredOther.diedAtMonth = state.clock.elapsedMonths;
  state.projects = [];
  assert.equal(shelterProposals([]).length, 0,
    '本人看见足够覆盖局部存活人口的空余住所时，不应继续复制住所项目');

  setVoxel(state.world.grid, cellX(center), cellY(center), site.z + 2, Material.Air);
  const noShelterProposals = shelterProposals([]);
  assert.equal(noShelterProposals.length, 1,
    '没有住所的独居者也应在温和天气形成最小住所容量压力');
  assert.ok(noShelterProposals[0].pressureBasis.reasonKeys.includes('local-shelter-capacity-shortfall'));

  process.stdout.write('local shelter capacity tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
