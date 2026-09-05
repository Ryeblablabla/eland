import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = mkdtempSync(path.join(tmpdir(), 'eland-procedural-knowledge-'));
try {
  const bundle = path.join(temporary, 'test.mjs');
  const entry = `
    export { createInitialState } from './src/game/eland/simulation';
    export { executePrimitiveAction } from './src/game/eland/domain/action-executor';
    export { recordExperiencedProcedure } from './src/game/eland/domain/procedural-knowledge';
    export { Material } from './src/game/eland/domain/material';
    export { cellId, setVoxel } from './src/game/eland/world/grid';
    export { buildKnowledgeLearningOptions } from './src/game/eland/application/record-use-options';
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=procedure-test-entry.ts', `--outfile=${bundle}`, '--log-level=error',
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const { createInitialState, executePrimitiveAction, recordExperiencedProcedure, Material, cellId, setVoxel, buildKnowledgeLearningOptions } = await import(pathToFileURL(bundle).href);
  const state = createInitialState(31, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const [maker, learner, reader] = state.people;
  assert.ok(maker && learner && reader);
  state.clock.elapsedMonths = 1;
  learner.position = structuredClone(maker.position);
  reader.position = structuredClone(maker.position);
  const infant = { ...structuredClone(reader), id: 'infant-observer', name: '婴儿', bornAtMonth: 1, generation: 1, knowledge: [], inventory: [] };
  state.people.push(infant);
  maker.inventory = [{ id: 'practice-wood', materialId: Material.Wood, quantity: 2, sourceEventIds: ['wood-origin'] }];
  let order = 0;
  const perform = (person, action) => {
    const fact = executePrimitiveAction(state, person, action, 1, ++order, { cause: 'intent', actionTick: order });
    state.world.past.push(fact);
    assert.equal(fact.status, 'completed', fact.result);
    return fact;
  };
  const study = (person, sourceEventId, factId) => {
    const option = buildKnowledgeLearningOptions(state, person, [])
      .find((candidate) => candidate.nextAction.learning?.sourceEventId === sourceEventId
        && candidate.nextAction.learning?.factId === factId);
    assert.ok(option, 'ordinary personal learning is available without a project or static recipe');
    return perform(person, option.nextAction);
  };
  const wood = { kind: 'inventory-stack', personId: maker.id, stackId: 'practice-wood' };
  const creation = perform(maker, {
    kind: 'world-interact',
    adjudication: {
      version: 'world-adjudicated-interaction-v1',
      request: '把一块木材削成可以刻写的薄板', targets: [wood], status: 'completed',
      result: '一次实际加工得到薄板',
      effects: [
        { kind: 'consume', target: wood, quantity: 1 },
        { kind: 'produce', materialId: Material.WoodTablet, quantity: 1, destination: 'inventory' },
      ],
    },
  });
  const method = maker.knowledge.find((fact) => fact.id === creation.diff.experiencedProcedureId);
  assert.equal(method?.kind, 'technique', 'the real executor must record an experienced procedure without another tool calling its hook');
  assert.equal(method.procedural.inputs[0].materialId, Material.Wood);
  assert.equal(method.procedural.outputs[0].materialId, Material.WoodTablet);
  assert.equal(method.procedural.experiences[0].eventId, creation.id);
  assert.equal(method.procedural.experiences[0].actorId, maker.id);
  assert.equal('verdict' in method.procedural, false, 'a remembered method is not a cached authority to manufacture future results');
  recordExperiencedProcedure(state, maker, creation);
  assert.equal(method.procedural.experiences.length, 1, 'replaying the same fact must not invent another success');

  const teaching = perform(maker, { kind: 'talk', speakerMeaning: {
    id: 'explain-method', kind: 'claim', factId: method.id, summary: '我刚把木材削成薄板，可以把这个做法讲给你们听。',
  } });
  assert.equal(learner.knowledge.find((fact) => fact.id === method.id), undefined, 'hearing a claim does not directly copy a complete technique');
  assert.equal(infant.knowledge.find((fact) => fact.procedural), undefined, 'a nearby infant does not acquire a full method from decoded sound');
  assert.deepEqual(buildKnowledgeLearningOptions(state, infant, []), []);
  study(learner, teaching.id, method.id);
  const learned = learner.knowledge.find((fact) => fact.id === method.id);
  assert.ok(learned?.procedural, 'the listener voluntarily understands a sourced explanation');
  assert.ok(learned.confidence < 55, 'understanding a method is not personally verifying it');
  assert.ok(learned.procedural.transmissionEventIds.includes(teaching.id));
  assert.equal(learned.procedural.experiences[0].actorId, maker.id,
    'hearing a method must not count as the learner having performed it');
  assert.notEqual(learned.procedural, method.procedural, 'people keep independent copies of learned methods');

  const tablet = maker.inventory.find((stack) => stack.materialId === Material.WoodTablet);
  const inscription = perform(maker, { kind: 'inscribe', carrierStackId: tablet.id, inscriptionMeaning: {
    id: 'write-method', kind: 'claim', factId: method.id, summary: '把削制薄板的做法刻在板上',
  } });
  const record = state.records.find((candidate) => candidate.id === inscription.diff.recordPayloadId);
  assert.deepEqual(record?.procedural, method.procedural, 'the durable carrier preserves operations and evidence, not just a title');
  const signsExplanation = perform(maker, { kind: 'talk', speakerMeaning: {
    id: 'explain-signs', kind: 'claim', factId: record.codebookId, summary: '这些刻痕表示我刚才讲的加工做法。',
  } });
  perform(maker, { kind: 'transfer', materialId: Material.WoodTablet, quantity: 1,
    from: { kind: 'person', personId: maker.id }, to: { kind: 'person', personId: reader.id }, stackId: tablet.id });
  reader.knowledge = reader.knowledge.filter((fact) => fact.id !== method.id);
  const heldRecord = reader.inventory.find((stack) => stack.recordPayloadId === record.id);
  const unknownReading = perform(reader, { kind: 'attend', target: {
    kind: 'inventory-stack', personId: reader.id, stackId: heldRecord.id,
  } });
  assert.equal(unknownReading.diff.understood, false, 'unfamiliar signs are not decoded by observing a carrier');
  assert.equal(reader.knowledge.find((fact) => fact.id === method.id), undefined);
  assert.equal(buildKnowledgeLearningOptions(state, reader, []).some((option) => option.goal.factId === unknownReading.diff.factId), false,
    'one inspection of unchanged unknown signs ends instead of demanding years of observation');
  study(reader, signsExplanation.id, record.codebookId);
  assert.ok(reader.knowledge.find((fact) => fact.id === record.codebookId).confidence < 55);
  assert.ok(buildKnowledgeLearningOptions(state, reader, []).some((option) => option.nextAction.target?.stackId === heldRecord.id),
    'a tentative but explicit symbol interpretation opens ordinary reading below legacy confidence thresholds');
  const reading = perform(reader, { kind: 'attend', target: {
    kind: 'inventory-stack', personId: reader.id, stackId: heldRecord.id,
  } });
  const restored = reader.knowledge.find((fact) => fact.id === method.id);
  assert.deepEqual(restored.procedural.inputs, method.procedural.inputs);
  assert.deepEqual(restored.procedural.outputs, method.procedural.outputs);
  assert.ok(restored.procedural.transmissionEventIds.includes(reading.id));
  maker.inventory.push({ id: 'second-record-blank', materialId: Material.WoodTablet, quantity: 1, sourceEventIds: ['blank-record-fixture'] });
  const signsRecordFact = perform(maker, { kind: 'inscribe', carrierStackId: 'second-record-blank', inscriptionMeaning: {
    id: 'write-sign-convention', kind: 'claim', factId: record.codebookId, summary: '记录我使用的刻写约定',
  } });
  const signsRecord = state.records.find((candidate) => candidate.id === signsRecordFact.diff.recordPayloadId);
  assert.equal(signsRecord.codebookId, record.codebookId, 'writing another subject reuses the same convention');
  assert.equal(signsRecord.kind, 'codebook', 'symbol conventions are durable, teachable content');

  const before = maker.knowledge.filter((fact) => fact.procedural).length;
  perform(maker, { kind: 'world-interact', adjudication: {
    version: 'world-adjudicated-interaction-v1', request: '回想旁人的说法', targets: [], status: 'completed',
    result: '我已经发明了一台机器', effects: [{ kind: 'knowledge', summary: '我猜这块板也许有其他用途' }],
  } });
  assert.equal(maker.knowledge.filter((fact) => fact.procedural).length, before,
    'unexecuted invention prose or a new opinion cannot become a manufacturing method');

  // One continuous construction experience: five existing pieces plus one new
  // piece must be remembered as an improvement, never a one-piece creation.
  for (let x = 8; x <= 15; x++) for (let y = 8; y <= 12; y++) {
    for (let z = 0; z < state.world.grid.levels; z++) setVoxel(state.world.grid, x, y, z, z === 0 ? Material.Stone : Material.Air);
  }
  maker.position = { cellId: cellId(10, 10), z: 1 };
  learner.position = { cellId: cellId(9, 9), z: 1 };
  reader.position = { cellId: cellId(9, 10), z: 1 };
  maker.inventory.push({ id: 'layout-wood', materialId: Material.Wood, quantity: 6, sourceEventIds: ['layout-wood-origin'] });
  const layoutWood = { kind: 'inventory-stack', personId: maker.id, stackId: 'layout-wood' };
  const site = { kind: 'voxel', position: { x: 11, y: 10, z: 1 } };
  const layout = (offsets) => ({ version: 'work-layout-v1', voxels: offsets.map(([x, y, z]) => ({
    offset: { x, y, z }, materialId: Material.Wood,
  })) });
  const originalLayout = layout([[0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 0, 1], [1, 0, 1]]);
  const constructed = perform(maker, { kind: 'world-interact', adjudication: {
    version: 'world-adjudicated-interaction-v1', request: '把五份木料堆排成两层结构', targets: [layoutWood, site],
    status: 'completed', result: '完成五份木料的排布', effects: [
      { kind: 'consume', target: layoutWood, quantity: 5 },
      { kind: 'assemble', target: site, arrangement: 'pile', summary: '两层木料结构', layout: originalLayout },
    ],
  } });
  const constructionMethod = maker.knowledge.find((fact) => fact.id === constructed.diff.experiencedProcedureId);
  const constructionOutput = constructionMethod.procedural.outputs.find((output) => output.kind === 'work');
  assert.equal(constructionOutput.operation, 'create');
  assert.equal(constructionOutput.layout.voxels.length, 5);
  assert.equal(constructionOutput.layoutChange.placed.length, 5);
  const structure = { kind: 'work', workId: constructionMethod.procedural.experiences[0].outputBindings[0].workId };
  const extendedLayout = layout([...originalLayout.voxels.map(({ offset }) => [offset.x, offset.y, offset.z]), [2, 0, 1]]);
  const extended = perform(maker, { kind: 'world-interact', adjudication: {
    version: 'world-adjudicated-interaction-v1', request: '用余下的一份木料补上第二层的空处', targets: [layoutWood, structure],
    status: 'completed', result: '补上一份木料', effects: [
      { kind: 'consume', target: layoutWood, quantity: 1 },
      { kind: 'modify-structure', target: structure, layout: extendedLayout },
    ],
  } });
  const improvement = maker.knowledge.find((fact) => fact.id === extended.diff.experiencedProcedureId);
  const improvementOutput = improvement.procedural.outputs.find((output) => output.kind === 'work');
  const prerequisite = improvement.procedural.contexts.find((context) => context.roleId === improvementOutput.sourceContextRoleId);
  assert.equal(improvement.procedural.inputs[0].quantity, 1);
  assert.equal(improvementOutput.operation, 'modify');
  assert.equal(prerequisite.work.components[0].quantity, 5, 'the five old pieces are a required existing entity, not created from the new input');
  assert.equal(prerequisite.work.layout.voxels.length, 5);
  assert.equal(improvementOutput.components[0].quantity, 6);
  assert.equal(improvementOutput.layout.voxels.length, 6);
  assert.equal(improvementOutput.layoutChange.placed.length, 1);
  assert.equal(improvementOutput.layoutChange.removed.length, 0);
  assert.equal('position' in prerequisite.work, false, 'the reusable precondition describes relative geometry rather than requiring the old location');
  assert.equal(constructionOutput.layout.voxels.length, 5, 'later changes cannot rewrite the recorded original outcome');
  const improvementExplanation = perform(maker, { kind: 'talk', speakerMeaning: {
    id: 'teach-layout-improvement', kind: 'claim', factId: improvement.id, summary: '在已经堆好的五块木料上补上这一块。',
  } });
  study(learner, improvementExplanation.id, improvement.id);
  const heardImprovement = learner.knowledge.find((fact) => fact.id === improvement.id);
  assert.deepEqual(heardImprovement.procedural.contexts, improvement.procedural.contexts);
  assert.deepEqual(heardImprovement.procedural.outputs, improvement.procedural.outputs);

  const rearrangedLayout = layout([...originalLayout.voxels.map(({ offset }) => [offset.x, offset.y, offset.z]), [0, 1, 1]]);
  const rearranged = perform(maker, { kind: 'world-interact', adjudication: {
    version: 'world-adjudicated-interaction-v1', request: '把刚补上的木块移到侧面', targets: [structure],
    status: 'completed', result: '重排已有木料', effects: [
      { kind: 'modify-structure', target: structure, layout: rearrangedLayout },
    ],
  } });
  const rearrangement = maker.knowledge.find((fact) => fact.id === rearranged.diff.experiencedProcedureId);
  assert.deepEqual(rearrangement.procedural.inputs, [], 'rearranging existing material need not consume it again');
  assert.equal(rearrangement.procedural.outputs[0].layoutChange.removed.length, 1);
  assert.equal(rearrangement.procedural.outputs[0].layoutChange.placed.length, 1);
  const unchanged = perform(maker, { kind: 'world-interact', adjudication: {
    version: 'world-adjudicated-interaction-v1', request: '再做一次完全相同的排布', targets: [structure],
    status: 'completed', result: '仍是原来的样子', effects: [
      { kind: 'modify-structure', target: structure, layout: rearrangedLayout },
    ],
  } });
  assert.equal(unchanged.diff.experiencedProcedureId, undefined, 'an unchanged arrangement must not invent a new experienced method');
  process.stdout.write('experienced creation, improvement, relative layouts, teaching and written transmission tests passed\n');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
