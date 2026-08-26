import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-project-frontier-'));
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/simulation.ts'))};
    export { buildProjectOptions } from ${JSON.stringify(path.resolve('src/game/eland/application/project-options.ts'))};
    export { deriveProjectProposals } from ${JSON.stringify(path.resolve('src/game/eland/application/projects/project-proposals.ts'))};
    export { projectProposalWithFunctionIdentity } from ${JSON.stringify(path.resolve('src/game/eland/application/projects/project-frontier.ts'))};
    export { mechanicalPowerNetworkId, mechanicalPowerPlanKey, MECHANICAL_POWER_PLAN_VERSION } from ${JSON.stringify(path.resolve('src/game/eland/domain/mechanical-power.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { cellX, cellY, neighbors4, setVoxel, voxelAt } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=project-frontier-fixture.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    Material,
    buildProjectOptions,
    cellX,
    cellY,
    createInitialState,
    deriveProjectProposals,
    neighbors4,
    mechanicalPowerNetworkId,
    mechanicalPowerPlanKey,
    MECHANICAL_POWER_PLAN_VERSION,
    projectProposalWithFunctionIdentity,
    setVoxel,
    voxelAt,
  } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

  const state = createInitialState(185, {
    chaosIntensity: 0,
    endpoint: { kind: 'months', value: 240 },
  });
  state.clock.elapsedMonths = 120;
  state.world.past = [];
  const actor = state.people[0];
  state.people = [actor];
  state.projects = [];
  actor.conditions = [];
  actor.knownPlaces = [];
  actor.inventory = [
    { id: 'frontier-copper', materialId: Material.Copper, quantity: 1, sourceEventIds: ['made-copper'] },
    { id: 'frontier-tin', materialId: Material.Tin, quantity: 1, sourceEventIds: ['made-tin'] },
    { id: 'frontier-charcoal', materialId: Material.Charcoal, quantity: 1, sourceEventIds: ['made-charcoal'] },
  ];
  actor.cognition.needResolutionEpisodes = [
    {
      version: 'need-resolution-episode-v1', id: 'completed-copper-charge', projectId: 'old-copper-charge',
      projectNeed: 'alloy-capability', desiredFunction: 'copper-charge', basisKey: 'old-copper-charge',
      observedAtMonth: 80, observationKind: 'completion-action', triggerFactIds: [], outcomeEventIds: [], sourceFactIds: [],
    },
    {
      version: 'need-resolution-episode-v1', id: 'completed-tin-charge', projectId: 'old-tin-charge',
      projectNeed: 'alloy-capability', desiredFunction: 'tin-charge', basisKey: 'old-tin-charge',
      observedAtMonth: 90, observationKind: 'completion-action', triggerFactIds: [], outcomeEventIds: [], sourceFactIds: [],
    },
  ];

  const kiln = neighbors4(actor.position.cellId).map((cellId) => ({
    cellId,
    x: cellX(cellId),
    y: cellY(cellId),
    z: actor.position.z,
  })).find((position) => (
    voxelAt(state.world.grid, position.x, position.y, position.z) === Material.Air
      && voxelAt(state.world.grid, position.x, position.y, position.z - 1) !== Material.Air
  ));
  assert.ok(kiln, 'fixture needs a reachable fixed metallurgy site');
  setVoxel(state.world.grid, kiln.x, kiln.y, kiln.z, Material.Kiln);

  state.world.drops = [
    {
      id: 'frontier-copper-ore', materialId: Material.CopperOre, quantity: 1,
      cellId: actor.position.cellId, z: actor.position.z,
      sourceEventIds: ['saw-copper-ore'], createdAtMonth: 120,
    },
    {
      id: 'frontier-tin-ore', materialId: Material.TinOre, quantity: 1,
      cellId: actor.position.cellId, z: actor.position.z,
      sourceEventIds: ['saw-tin-ore'], createdAtMonth: 120,
    },
  ];
  const visibleCells = [actor.position.cellId, kiln.cellId];
  const rawAlloyProposals = deriveProjectProposals(
    state,
    actor,
    visibleCells,
    state.world.drops,
    [],
  ).filter((proposal) => proposal.need === 'alloy-capability');
  assert.ok(rawAlloyProposals.some((proposal) => proposal.desiredFunction === 'copper-charge'));
  assert.ok(rawAlloyProposals.some((proposal) => proposal.desiredFunction === 'tin-charge'));
  assert.ok(rawAlloyProposals.some((proposal) => proposal.desiredFunction === 'bronze-alloying'));
  const normalizedIds = rawAlloyProposals.map((proposal) => projectProposalWithFunctionIdentity(proposal).id);
  assert.equal(new Set(normalizedIds).size, normalizedIds.length,
    'same-month proposals for one need must gain function-specific identities before acceptance');

  const options = buildProjectOptions(state, actor, visibleCells, state.world.drops, []);
  assert.equal(options.length, 2, 'frontier compilation remains bounded to two executable options');
  assert.equal(options[0].projectProposal?.desiredFunction, 'bronze-alloying',
    'held copper and tin should open the current direct frontier ahead of repeat ore replenishment');
  assert.match(options[0].projectProposal?.id ?? '', /--function-bronze-alloying$/);
  assert.ok(['copper-charge', 'tin-charge'].includes(options[1].projectProposal?.desiredFunction ?? ''),
    'frontier preference must not suppress an otherwise legal replenishment fallback');
  assert.equal(new Set(options.map((option) => option.projectProposal?.id)).size, options.length,
    'accepted project options must not share a project id');

  const coarseMechanicalId = 'project-121-person-1-mechanical-power-capability';
  const mechanicalPlan = {
    version: MECHANICAL_POWER_PLAN_VERSION,
    projectId: coarseMechanicalId,
    sourceSegmentId: 'current-1',
    wheelPosition: { x: 1, y: 1, z: 1 },
    shaftPositions: [{ x: 2, y: 1, z: 1 }],
    loadPosition: { x: 3, y: 1, z: 1 },
    sourceKeys: ['water:1'],
  };
  const normalizedMechanical = projectProposalWithFunctionIdentity({
    id: coarseMechanicalId,
    kind: 'production',
    need: 'mechanical-power-capability',
    desiredFunction: 'water-powered-crop-processing',
    summary: 'mechanical identity fixture',
    ownerId: actor.id,
    beneficiaryIds: [actor.id],
    triggerFactIds: [],
    pressure: 88,
    createdAtMonth: 121,
    reviewAtMonth: 156,
    mechanicalPowerPlan: mechanicalPlan,
    mechanicalPowerPlanKey: mechanicalPowerPlanKey(mechanicalPlan),
    mechanicalPowerNetworkId: mechanicalPowerNetworkId(mechanicalPlan),
  });
  assert.equal(normalizedMechanical.mechanicalPowerPlan?.projectId, normalizedMechanical.id,
    'an installation plan must follow the accepted function-specific project identity');
  assert.equal(normalizedMechanical.mechanicalPowerPlanKey,
    mechanicalPowerPlanKey(normalizedMechanical.mechanicalPowerPlan));
  assert.equal(normalizedMechanical.mechanicalPowerNetworkId,
    mechanicalPowerNetworkId(normalizedMechanical.mechanicalPowerPlan));

  const existingInstallationPlan = {
    ...mechanicalPlan,
    projectId: 'completed-installation-project',
  };
  const normalizedMaintenance = projectProposalWithFunctionIdentity({
    ...normalizedMechanical,
    id: coarseMechanicalId,
    desiredFunction: 'restore-water-powered-crop-processing',
    mechanicalPowerPlan: existingInstallationPlan,
    mechanicalPowerPlanKey: mechanicalPowerPlanKey(existingInstallationPlan),
    mechanicalPowerNetworkId: mechanicalPowerNetworkId(existingInstallationPlan),
  });
  assert.equal(normalizedMaintenance.mechanicalPowerPlan?.projectId, 'completed-installation-project',
    'maintenance must retain the external installation identity');

  process.stdout.write('project frontier tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
