import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-record-carrier-filter-'));
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/simulation.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project.ts'))};
    export {
      buildProjectInquiryOpportunityBasis,
      hypothesisStep,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/projects/project-inquiry.ts'))};
    export { nextProjectHypothesisCandidate } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/project-hypotheses.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=record-carrier-filter-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    buildProjectInquiryOpportunityBasis,
    createInitialState,
    hypothesisStep,
    instantiateProject,
    nextProjectHypothesisCandidate,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(20260828, {
    endpoint: { kind: 'months', value: 120 },
    chaosIntensity: 0,
  });
  state.clock.elapsedMonths = 20;
  state.projects = [];
  const actor = state.people[0];
  actor.knowledge = [];
  actor.memories = [];
  actor.inventory = [
    {
      id: 'held-plank', materialId: Material.Plank, quantity: 1,
      sourceEventIds: ['made-held-plank'],
    },
    {
      id: 'written-tablet', materialId: Material.WoodTablet, quantity: 1,
      sourceEventIds: ['wrote-tablet'], recordPayloadId: 'record-payload-1',
    },
  ];
  const writtenDrop = {
    id: 'near-written-tablet', materialId: Material.WoodTablet, quantity: 1,
    cellId: actor.position.cellId, z: actor.position.z,
    sourceEventIds: ['published-tablet'], recordPayloadId: 'record-payload-2',
    createdAtMonth: 20,
  };
  const blankDrop = {
    id: 'blank-tablet', materialId: Material.WoodTablet, quantity: 1,
    cellId: actor.position.cellId, z: actor.position.z,
    sourceEventIds: ['made-blank-tablet'], createdAtMonth: 20,
  };
  state.world.drops = [writtenDrop, blankDrop];

  const recordOnlyBasis = buildProjectInquiryOpportunityBasis(
    state,
    actor,
    'workshop-production',
    [writtenDrop],
    21,
  );
  assert.equal(recordOnlyBasis.opportunityKeys.includes(`material:${Material.WoodTablet}`), false,
    '已写记录板不能作为普通消耗性材料重新打开试验机会');
  assert.equal(recordOnlyBasis.opportunitySources.some((source) => (
    source.sourceKeys.includes('inventory:' + actor.id + ':written-tablet')
      || source.sourceKeys.includes('drop:near-written-tablet')
  )), false);

  const blankBasis = buildProjectInquiryOpportunityBasis(
    state,
    actor,
    'workshop-production',
    [writtenDrop, blankDrop],
    21,
  );
  const tabletSources = blankBasis.opportunitySources.filter((source) => (
    source.materialId === Material.WoodTablet
  ));
  assert.equal(tabletSources.length, 1);
  assert.deepEqual(tabletSources[0].sourceKeys, ['drop:blank-tablet']);

  const project = instantiateProject({
    id: 'project-21-record-filter-workshop',
    kind: 'production',
    need: 'production-efficiency',
    desiredFunction: 'workshop-production',
    summary: '用本地实体试验固定工作台结构',
    ownerId: actor.id,
    beneficiaryIds: [actor.id],
    triggerFactIds: ['made-held-plank'],
    pressure: 70,
    createdAtMonth: 21,
    reviewAtMonth: 32,
  });
  state.projects = [project];
  const selected = nextProjectHypothesisCandidate(
    state.seed, 21, actor, project, [writtenDrop, blankDrop],
    { operation: 'combine-inventory', questionKind: 'connect-manipulator-shapes' },
  );
  assert.ok(selected);
  const step = hypothesisStep(state, actor, [writtenDrop, blankDrop], project, {
    operation: 'combine-inventory',
    questionKind: 'connect-manipulator-shapes',
  });
  assert.equal(step?.action.kind, 'transfer');
  assert.equal(step?.action.dropId, blankDrop.id,
    '更近的已写载体必须被忽略，项目只能筹集仍可消耗的空白记录板');
  assert.equal(JSON.stringify(project.hypothesisCampaign).includes('near-written-tablet'), false);
  assert.equal(JSON.stringify(project.hypothesisCampaign).includes('record-payload'), false);

  process.stdout.write('project hypothesis record-carrier filter tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
