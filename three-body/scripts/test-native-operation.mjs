import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = mkdtempSync(path.join(tmpdir(), 'eland-native-operation-'));
try {
  const bundle = path.join(temporary, 'native.mjs');
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=native-test.ts', `--outfile=${bundle}`, '--log-level=error',
  ], {
    input: `export { createInitialState, buildDecisionContexts } from './src/game/eland/simulation';
      export { compileNativeOperation, describeNativeOperations } from './src/game/eland/application/native-operation';
      export { applyDecision, executeActiveIntent } from './src/game/eland/application/simulation/intent-execution';
      export { executePrimitiveAction, goalSatisfied } from './src/game/eland/domain/action-executor';
      export { positionsCanTouch } from './src/game/eland/domain/social-space';
      export { buildDecisionRequestContext } from './src/game/eland/application/model-decision/decision-context';
      export { buildDecisionProbeHandleMap } from './src/game/eland/application/model-decision/capability-handles';
      export { deriveWorldTargets } from './src/game/eland/application/model-decision/world-target-derivation';
      export { buildDecisionModelRequestProtocol, sanitizePlanAgentWorldVerdict, normalizeMindPlanModelOutput } from './server/model-decision-gateway';
      export { compileModelNativeOperation, projectNativeOperations, nativeWorldRefForHandle } from './src/game/eland/application/model-decision/native-operation-context';
      export { Material } from './src/game/eland/domain/material';
      export { cellId, setVoxel, voxelAt, isStandingPosition } from './src/game/eland/world/grid';`,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const api = await import(pathToFileURL(bundle).href);
  const state = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  const person = state.people[0];
  for (let x = 10; x <= 16; x += 1) for (let y = 10; y <= 16; y += 1) {
    for (let z = 0; z < state.world.grid.levels; z += 1) {
      api.setVoxel(state.world.grid, x, y, z, z === 0 ? api.Material.Stone : api.Material.Air);
    }
  }
  person.position = { ...person.position, cellId: api.cellId(12, 12), z: 1 };
  person.knowledge = [];
  const baseContext = () => api.buildDecisionContexts(state, 1).find((context) => context.person.id === person.id);
  const emptyContext = () => ({ ...baseContext(), options: [], followUpOptions: [], activeIntent: undefined });
  const mind = { version: 'mental-act-v2', kind: 'pursue', goal: '观察并实际取得眼前的材料',
    strategy: '依照当下实物执行一步，依据结果再继续', horizon: 'ongoing', orientation: 'inquiry',
    utterance: '', delivery: 'normal', assumptions: [], sourceEventIds: [] };
  let order = 1;
  const run = (request) => {
    const context = emptyContext();
    const decision = api.applyDecision(state, person, context, {
      kind: 'idle', reason: mind.goal, mentalAct: structuredClone(mind), nativeOperation: request,
    }, true, 1, order++, order);
    assert(decision.intentId, JSON.stringify(decision.executionCompilation));
    const hasBackground = Object.keys(request.backgroundReferences ?? {}).length
      || (request.kind === 'move' && Object.keys(request.references ?? {}).length);
    assert.equal(decision.executionCompilation.status, hasBackground ? 'compiled-with-feedback' : 'compiled');
    assert.deepEqual(decision.executionCompilation.operation, request, 'successful semantic requests remain in the decision audit');
    const action = api.executeActiveIntent(state, person, 1, order++, order);
    assert(action?.kind === 'action', 'a semantic operation must produce a real top-level ActionFact');
    return { decision, action };
  };
  const moved = run({ kind: 'move', target: { kind: 'voxel', position: { x: 13, y: 12, z: 1 } } });
  assert.equal(moved.action.action.kind, 'move');
  assert.equal(person.position.cellId, api.cellId(13, 12));
  api.setVoxel(state.world.grid, 14, 12, 1, api.Material.BerryBush);
  const bush = { kind: 'voxel', position: { x: 14, y: 12, z: 1 } };
  const observed = run({ kind: 'observe', target: bush });
  assert.equal(observed.action.action.kind, 'attend');
  assert.equal(observed.action.status, 'completed');
  assert(person.knowledge.some((fact) => fact.sourceEventIds.includes(observed.action.id)));
  const separated = run({ kind: 'act', operation: 'separate', targets: [bush] });
  assert.equal(separated.action.action.kind, 'act');
  assert.equal(separated.action.status, 'completed', separated.action.result);
  assert.equal(state.intents.find((intent) => intent.id === separated.decision.intentId).status, 'completed',
    'one explicitly chosen native attempt finishes instead of repeatedly executing separate');
  const harvest = state.world.drops.find((drop) => drop.sourceEventIds.includes(separated.action.id));
  assert(harvest?.quantity > 0, 'separation creates actual material');
  const before = person.inventory.filter((stack) => stack.materialId === harvest.materialId)
    .reduce((total, stack) => total + stack.quantity, 0);
  const taken = run({ kind: 'transfer', source: { kind: 'drop', dropId: harvest.id },
    destination: { kind: 'person', personId: person.id }, quantity: 1 });
  assert.equal(taken.action.action.kind, 'transfer');
  assert.equal(taken.action.status, 'completed', taken.action.result);
  assert.equal(person.inventory.filter((stack) => stack.materialId === harvest.materialId)
    .reduce((total, stack) => total + stack.quantity, 0), before + 1);

  const actualContext = baseContext();
  for (const descriptor of api.describeNativeOperations(actualContext)) {
    const { goal: _readOnlyGoal, ...request } = descriptor.request;
    const compiled = api.compileNativeOperation(actualContext, request, 'roundtrip-existing');
    assert(compiled.ok, JSON.stringify({ request: descriptor.request, problem: compiled.problem }));
    if (request.kind === 'move') {
      assert.equal(compiled.option.nextAction.kind, 'move');
      assert.equal(compiled.option.projectId, undefined);
      assert.equal(compiled.option.projectProposal, undefined);
      assert.equal(compiled.option.recordUseBasis, undefined);
    }
  }

  // A shared fact must not turn an ordinary material operation into the
  // rule planner's still-unselected housing process.
  const templateState = api.createInitialState(17, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const templateActor = templateState.people[0];
  const sharedSourceId = templateState.world.past[0].id;
  templateActor.inventory.push({ id: 'initial-building-sample', materialId: api.Material.Wood, quantity: 1,
    sourceEventIds: [sharedSourceId] });
  const templateContext = api.buildDecisionContexts(templateState, 1).find((entry) => entry.person.id === templateActor.id);
  const housingTemplate = templateContext.options.find((option) => option.projectProposal?.desiredFunction === 'weather-shelter'
    && option.nextAction.kind === 'act');
  assert(housingTemplate, 'the regression uses a real generated housing placement option');
  assert(housingTemplate.sourceFactIds.includes(sharedSourceId));
  const templateOnlyContext = { ...templateContext, options: [housingTemplate], followUpOptions: [] };
  const materialOperation = { kind: 'act', operation: housingTemplate.nextAction.operation,
    targets: structuredClone(housingTemplate.nextAction.targets) };
  const sharedBasis = api.compileNativeOperation(templateOnlyContext,
    { ...materialOperation, references: { sourceEventIds: [sharedSourceId] } }, 'shared-source-is-not-a-project');
  assert.equal(sharedBasis.ok, false);
  assert.equal(sharedBasis.problem.code, 'missing-evidence');
  assert.deepEqual(api.describeNativeOperations(templateOnlyContext), []);
  const plainMaterial = api.compileNativeOperation(templateOnlyContext,
    { ...materialOperation, backgroundReferences: { sourceEventIds: [sharedSourceId] } }, 'actual-material-only');
  assert(plainMaterial.ok);
  assert.equal(plainMaterial.option.projectId, undefined);
  assert.equal(plainMaterial.option.projectProposal, undefined);
  assert.notEqual(plainMaterial.option.goal.kind, 'project-completed');
  assert.equal(templateState.projects.length, 0);
  api.applyDecision(templateState, templateActor, templateContext, { kind: 'start', optionId: housingTemplate.id,
    reason: '本地路径中本人明确选定项目' }, false, 1, 1, 1);
  const continuingProjectContext = api.buildDecisionContexts(templateState, 1).find((entry) => entry.person.id === templateActor.id);
  const continueProject = api.compileNativeOperation(continuingProjectContext,
    { kind: 'project', projectId: housingTemplate.projectProposal.id }, 'continue-actual-project');
  assert(continueProject.ok, JSON.stringify(continueProject.problem));
  assert.equal(continueProject.option.projectId, housingTemplate.projectProposal.id);

  // These fixtures represent three distinct current capabilities sharing one
  // observation atom. Selecting semantics must preserve their full lifecycle
  // and evidence, not flatten each into an unbound attend primitive.
  const target = { kind: 'inventory-stack', personId: person.id, stackId: person.inventory[0].id };
  const base = { summary: '读取记录并继续项目验证', reason: '本人有具体项目与可读来源',
    target, nextAction: { kind: 'attend', target }, estimatedDuration: 'several-months',
    goal: { kind: 'knowledge', factId: 'method-from-record' }, sourceFactIds: ['heard-method-source'],
    completionPolicy: { kind: 'maintain-state', durationMonths: 3 } };
  const project = { ...base, id: 'internal-project-option', projectProposal: {
    id: 'project-proposal-real-site', kind: 'production', need: 'production-efficiency', desiredFunction: 'efficient-production',
    summary: '在选定位置试制工具', ownerId: person.id, beneficiaryIds: [person.id],
    triggerFactIds: ['personal-material-deficit'], pressure: 3, createdAtMonth: 1, reviewAtMonth: 2,
    site: { cellId: api.cellId(14, 12), z: 1 },
    productionToolBaselineRank: 1,
  }, sourceFactIds: ['personal-material-deficit'] };
  const record = { ...base, id: 'internal-record-option', projectId: 'active-craft-project',
    nextAction: { kind: 'attend', target, learning: { sourceEventId: 'heard-method-source', factId: 'method-from-record' } },
    recordUseStage: 'read', recordUseBasis: { version: 'record-use-basis-v3', basisKey: 'record-physical-basis',
      projectId: 'active-craft-project', projectOwnerId: person.id, readerId: person.id, recordAuthorId: person.id,
      demand: { kind: 'project-deficit', projectId: 'active-craft-project', deficitSourceIds: ['personal-material-deficit'] },
      recordId: 'actual-record', recordVersion: 2, codebookId: 'known-writing-convention',
      knowledgeId: 'method-from-record', techniqueId: 'learned-material-method',
      ruleSignature: 'actual-material-response', projectPressure: 3, expectedOutputMaterialId: api.Material.Plank,
      createdAtMonth: 1, projectSourceEventIds: ['personal-material-deficit'], recordSourceEventIds: ['record-inscription-source'],
      codebookSourceEventIds: ['known-writing-source'], inputSourceEventIds: ['actual-input-source'], sourceFactIds: ['heard-method-source'],
      carrierSource: { kind: 'inventory', personId: person.id, stackId: target.stackId },
      acquisitionRequired: false, inputWitnesses: [{ version: 'record-use-input-witness-v1', role: 'input', personId: person.id,
        stackId: target.stackId, materialId: person.inventory[0].materialId, quantity: 1, sourceEventIds: ['actual-input-source'] }],
    } };
  const measured = { ...base, id: 'internal-measurement-option',
    nextAction: { kind: 'attend', target, measurement: { version: 'sourced-mass-measurement-action-v1', mode: 'measure-mass',
      instrument: { personId: person.id, stackId: 'actual-scale', quantity: 1, sourceEventIds: ['actual-scale-source'] },
      subject: { personId: person.id, stackId: target.stackId, quantity: 1, sourceEventIds: ['actual-input-source'] },
      calibrationEventId: 'calibrated-scale-source' } },
    sourceFactIds: ['calibrated-scale-source'], goal: { kind: 'knowledge', factId: 'measured-sample' } };
  const richContext = { ...emptyContext(), state: { ...state, projects: [
    ...state.projects,
    { ...project.projectProposal, status: 'active', contributorIds: [person.id], actionEventIds: [] },
    { ...project.projectProposal, id: 'active-craft-project', status: 'active', contributorIds: [person.id], actionEventIds: [] },
  ] }, options: [project, record, measured] };
  for (const descriptor of api.describeNativeOperations(richContext)) {
    const { goal: _readOnlyGoal, ...request } = descriptor.request;
    assert.match(descriptor.methodKey, /^method_/);
    assert.equal(descriptor.requiresMethod, true);
    const compiled = api.compileNativeOperation(richContext, { ...request, methodKey: descriptor.methodKey }, 'new-runtime-id');
    assert(compiled.ok, JSON.stringify(compiled.problem));
    const expected = richContext.options.find((option) => option.id === compiled.option.id);
    assert.deepEqual(compiled.option, expected, 'every semantic descriptor round-trips the entire capability');
    assert(!JSON.stringify(descriptor).includes(compiled.option.id), 'internal option identity is never shown to the model');
  }
  const sourceOnlyMeasurement = { ...measured, completionPolicy: undefined, estimatedDuration: 'one-month' };
  const otherMeasurement = { ...sourceOnlyMeasurement, id: 'other-calibration', nextAction: { ...measured.nextAction,
    measurement: { ...measured.nextAction.measurement, calibrationEventId: 'different-calibration-source' } } };
  const twoMeasurements = { ...richContext, options: [sourceOnlyMeasurement, otherMeasurement] };
  const measurementMethods = api.describeNativeOperations(twoMeasurements);
  assert.equal(measurementMethods.length, 2, 'equal public atoms cannot collapse distinct calibration bases');
  assert(measurementMethods.every((descriptor) => descriptor.requiresMethod));
  assert.deepEqual(measurementMethods[0].request.references, { sourceEventIds: ['calibrated-scale-source'] });
  assert.notEqual(measurementMethods[0].methodKey, measurementMethods[1].methodKey);
  const renamedMeasurement = api.describeNativeOperations({ ...richContext, options: [{ ...sourceOnlyMeasurement,
    id: 'new-menu-id', summary: '另一种说法', reason: '说明变化', projectPressure: 99 }] })[0];
  assert.equal(renamedMeasurement.methodKey, measurementMethods[0].methodKey,
    'presentation text and local pressure do not rename the same complete method');
  const exactMeasurement = { ...measurementMethods[0].request, methodKey: measurementMethods[0].methodKey,
    references: { sourceEventIds: [] } };
  assert.deepEqual(api.compileNativeOperation(twoMeasurements, exactMeasurement, 'exact-measurement').option,
    sourceOnlyMeasurement, 'the method key preserves the exact calibration even with an empty source list');
  assert.equal(api.compileNativeOperation(twoMeasurements, { ...exactMeasurement, methodKey: 'method_unknown' }, 'missing-method').ok, false);
  assert.equal(api.compileNativeOperation(twoMeasurements, { ...exactMeasurement,
    target: { kind: 'person', personId: person.id } }, 'wrong-method-target').ok, false,
  'a valid method key does not permit substituting its bound object');
  const ordinaryObservation = { ...sourceOnlyMeasurement, id: 'ordinary-with-source', nextAction: { kind: 'attend', target } };
  assert.equal(api.describeNativeOperations({ ...richContext, options: [ordinaryObservation] })[0].requiresMethod, false,
    'source facts alone do not turn an ordinary observation into a special method');
  const generic = api.compileNativeOperation(richContext, { kind: 'observe', target }, 'ordinary-observation');
  assert(generic.ok, 'ordinary observation does not select among unrelated complete processes');
  assert.deepEqual(generic.option.nextAction, { kind: 'attend', target });
  assert.equal(generic.option.recordUseBasis, undefined);
  assert.equal(generic.option.projectProposal, undefined);
  const recording = api.compileNativeOperation(richContext, { kind: 'observe', target,
    references: { recordId: 'actual-record', projectId: 'active-craft-project' } }, 'record-choice');
  assert(recording.ok);
  assert.deepEqual(recording.option.recordUseBasis, record.recordUseBasis);
  const measurement = api.compileNativeOperation(richContext, { kind: 'observe', target,
    instrument: { kind: 'inventory-stack', personId: person.id, stackId: 'actual-scale' },
    references: { sourceEventIds: ['calibrated-scale-source'] } }, 'measurement-choice');
  assert(measurement.ok);
  assert.deepEqual(measurement.option.nextAction.measurement, measured.nextAction.measurement);
  const scopedMeasurement = api.compileNativeOperation(richContext, {
    kind: 'observe', target,
    instrument: { kind: 'inventory-stack', personId: person.id, stackId: 'actual-scale' },
    references: { sourceEventIds: ['calibrated-scale-source'] }, perceptionOnly: true,
  }, 'only-measurement');
  assert(scopedMeasurement.ok, JSON.stringify(scopedMeasurement.problem));
  assert.deepEqual(scopedMeasurement.option.nextAction, measured.nextAction);
  assert.deepEqual(scopedMeasurement.option.sourceFactIds, measured.sourceFactIds);
  assert.equal(scopedMeasurement.option.completionPolicy, undefined);
  assert.equal(scopedMeasurement.option.recordUseBasis, undefined);
  assert.equal(scopedMeasurement.option.projectId, undefined);
  const scopedRecord = api.compileNativeOperation(richContext, { kind: 'observe', target,
    references: { recordId: 'actual-record', projectId: 'active-craft-project' }, perceptionOnly: true }, 'read-only');
  assert(scopedRecord.ok);
  assert.deepEqual(scopedRecord.option.nextAction, record.nextAction);
  assert.equal(scopedRecord.option.recordUseBasis, undefined);
  assert.equal(scopedRecord.option.projectId, undefined);
  const acquireBeforeRead = { ...record, nextAction: { kind: 'transfer', materialId: api.Material.Wood, quantity: 1,
    from: { kind: 'ground', cellId: person.position.cellId, z: person.position.z }, to: { kind: 'person', personId: person.id } },
    completionAction: record.nextAction };
  const scopedPrematureRead = api.compileNativeOperation({ ...richContext, options: [acquireBeforeRead] }, {
    kind: 'observe', target, references: { recordId: 'actual-record', projectId: 'active-craft-project' }, perceptionOnly: true,
  }, 'not-yet-reading');
  assert.equal(scopedPrematureRead.ok, false);
  assert.match(scopedPrematureRead.problem.message, /先执行transfer/);
  const referenceHandles = { actorId: person.id, held: [{ handle: 'held-sample', stackId: target.stackId },
    { handle: 'held-scale', stackId: 'actual-scale' }], visible: [], voxels: [], nativeReferences: [
    { handle: 'basis-source', kind: 'source', id: 'calibrated-scale-source' },
    { handle: 'basis-record', kind: 'record', id: 'actual-record' },
    { handle: 'basis-project', kind: 'project', id: 'active-craft-project' },
  ] };
  const referenceContext = { person: { id: person.id }, nativeOperations: api.describeNativeOperations(richContext) };
  referenceHandles.nativeMethods = api.buildDecisionProbeHandleMap(api.buildDecisionRequestContext(richContext)).nativeMethods;
  const projectOnly = { kind: 'project', projectHandle: 'basis-project' };
  assert.equal(api.compileModelNativeOperation(projectOnly, { ...referenceContext, knownProjects: [] }, referenceHandles), undefined,
    'a stray handle must not introduce an unestablished project into a production request');
  const existingProjectContext = { ...referenceContext, knownProjects: [{ id: 'active-craft-project', status: 'active',
    desiredFunction: 'efficient-production' }] };
  assert.equal(api.compileModelNativeOperation(projectOnly, existingProjectContext, referenceHandles)?.projectId, 'active-craft-project');
  assert.equal(api.compileModelNativeOperation({ kind: 'project', desiredFunction: 'efficient-production' },
    existingProjectContext, referenceHandles), undefined, 'function alone cannot choose a project');
  assert.equal(api.compileModelNativeOperation({ ...projectOnly, desiredFunction: 'weather-shelter' },
    existingProjectContext, referenceHandles), undefined, 'an existing project cannot be changed into another template');
  const projectedMeasurement = api.projectNativeOperations(referenceContext, referenceHandles)
    .find((descriptor) => referenceHandles.nativeMethods.find((method) => method.handle === descriptor.request.methodHandle)
      ?.request.instrument?.stackId === 'actual-scale');
  assert.equal(projectedMeasurement.request.references, undefined);
  assert.equal(projectedMeasurement.request.kind, 'use-method');
  assert.equal(projectedMeasurement.request.executionBasis, undefined);
  const boundMeasurement = api.compileModelNativeOperation(projectedMeasurement.request, referenceContext, referenceHandles);
  assert.deepEqual(boundMeasurement.references, { sourceEventIds: ['calibrated-scale-source'] });
  assert.equal(boundMeasurement.methodKey, referenceContext.nativeOperations.find((descriptor) => descriptor.request.instrument)?.methodKey);
  assert(api.compileNativeOperation(richContext, { ...boundMeasurement, perceptionOnly: true }, 'wire-measurement').ok);
  const backgroundObservation = api.compileModelNativeOperation({ kind: 'observe', targetHandle: 'held-sample',
    backgroundReferences: { projectHandle: 'basis-project', recordHandle: 'basis-record', sourceHandles: ['basis-source'] },
  }, referenceContext, referenceHandles);
  assert.equal(backgroundObservation.references, undefined);
  assert.deepEqual(backgroundObservation.backgroundReferences, { projectId: 'active-craft-project', recordId: 'actual-record',
    sourceEventIds: ['calibrated-scale-source'] });
  const bareBackground = api.compileNativeOperation(richContext, backgroundObservation, 'background-is-not-execution');
  assert(bareBackground.ok);
  assert.deepEqual(bareBackground.option.nextAction, { kind: 'attend', target });
  assert.equal(bareBackground.option.recordUseBasis, undefined);
  assert.deepEqual(bareBackground.option.nativeOperation.backgroundReferences, backgroundObservation.backgroundReferences);
  assert.equal(api.compileModelNativeOperation({ kind: 'observe', targetHandle: 'held-sample',
    backgroundReferences: { recordHandle: 'unknown-record' },
  }, referenceContext, referenceHandles), undefined, 'background still binds only currently known references');

  const diagnosisMind = { ...mind, planFeedback: {
    correction: '原生操作引用尚未确定', adjustment: '明确本次观察的目标与用途', sourceEventIds: [observed.action.id],
  } };
  const knowledgeBeforeCompilation = structuredClone(person.knowledge);
  const unresolved = api.applyDecision(state, person, richContext, {
    kind: 'idle', reason: '我要研究这份材料', nativeOperation: { kind: 'observe', target,
      references: { recordId: 'missing-specific-method' } }, mentalAct: structuredClone(diagnosisMind),
  }, true, 1, order++, order);
  assert.equal(unresolved.intentId, undefined, 'an unavailable explicit method does not create a pretend action or intent');
  assert.equal(unresolved.executionCompilation.status, 'unresolved');
  assert.equal(unresolved.executionCompilation.problem.code, 'missing-evidence');
  assert.deepEqual(unresolved.decision.mentalAct, diagnosisMind, 'full Plan interpretation remains on the authentic decision audit');
  assert(!person.memories.some((memory) => memory.id.startsWith('memory:native-compilation:')),
    'a technical compilation diagnostic must not become an autobiographical episode');
  assert.deepEqual(person.knowledge, knowledgeBeforeCompilation, 'Plan commentary does not grant the person a learned claim');
  assert.match(person.lastDecisionText, /^此前选择的这一步尚未开始/);
  assert.doesNotMatch(person.lastDecisionText, /原生操作|引用|编译/);
  assert.doesNotMatch(person.currentActionText, /原生操作|引用|编译/);

  api.setVoxel(state.world.grid, 16, 14, 1, api.Material.Water);
  const waterMove = run({ kind: 'move', target: { kind: 'voxel', position: { x: 16, y: 14, z: 1 } }, withinDistance: 1 });
  for (let tick = 0; person.activeIntentId && tick < 8; tick += 1) {
    api.executeActiveIntent(state, person, 1, order++, order);
  }
  assert.notEqual(person.position.cellId, api.cellId(16, 14), 'movement to water resolves to a real bank');
  assert.equal(state.intents.find((intent) => intent.id === waterMove.decision.intentId).status, 'completed');
  assert.equal(api.goalSatisfied(state, person, { kind: 'at-cell', cellId: person.position.cellId, z: person.position.z + 2 }), false,
    'horizontal co-location cannot satisfy a different requested standing height');
  const other = state.people[1];
  other.position = { ...other.position, cellId: api.cellId(15, 11), z: 1 };
  const followRequest = { kind: 'move', target: { kind: 'person', personId: other.id }, withinDistance: 1 };
  const follow = api.applyDecision(state, person, emptyContext(), {
    kind: 'idle', reason: '到他身边', mentalAct: structuredClone(mind), nativeOperation: followRequest,
  }, true, 1, order++, order);
  other.position.cellId = api.cellId(16, 11);
  for (let tick = 0; person.activeIntentId && tick < 8; tick += 1) {
    api.executeActiveIntent(state, person, 1, order++, order);
  }
  const followIntent = state.intents.find((intent) => intent.id === follow.intentId);
  assert.equal(followIntent.status, 'completed');
  assert.notEqual(person.position.cellId, other.position.cellId, 'physical rendezvous leaves each body its own voxel');
  assert.deepEqual(followIntent.nativeOperation, followRequest, 'following a moving body retains the requested distance and identity');

  // Real first-month regression: proposed housing project references were
  // attached to moving toward two people and a material pile. An association
  // is not a requirement to execute one precompiled project work step.
  state.world.past.push(observed.action, { ...observed.action, id: 'existing-but-unseen-source', who: other.id });
  other.position = { ...other.position, cellId: api.cellId(11, 10), z: 1 };
  const thirdPerson = state.people[2];
  thirdPerson.position = { ...thirdPerson.position, cellId: api.cellId(15, 10), z: 1 };
  const preparationDrop = { id: 'project-preparation-material', materialId: api.Material.Wood, quantity: 2,
    cellId: api.cellId(15, 14), z: 1, createdAtMonth: 0, sourceEventIds: [] };
  state.world.drops.push(preparationDrop);
  const projectsBeforePreparation = structuredClone(state.projects);
  const preparationReferences = { projectId: 'proposed-housing-project',
    sourceEventIds: [observed.action.id, 'existing-but-unseen-source', 'nonexistent-source'] };
  for (const [target, withinDistance] of [
    [{ kind: 'person', personId: other.id }, 1],
    [{ kind: 'drop', dropId: preparationDrop.id }, 0],
    [{ kind: 'person', personId: thirdPerson.id }, 1],
  ]) {
    person.position = { ...person.position, cellId: api.cellId(13, 12), z: 1 };
    const request = { kind: 'move', target, withinDistance, references: structuredClone(preparationReferences) };
    const preparation = run(request);
    for (let tick = 0; person.activeIntentId && tick < 8; tick += 1) {
      api.executeActiveIntent(state, person, 1, order++, order);
    }
    const preparationIntent = state.intents.find((intent) => intent.id === preparation.decision.intentId);
    assert.equal(preparation.action.action.kind, 'move');
    assert.equal(preparationIntent.status, 'completed');
    assert.equal(preparationIntent.projectId, undefined);
    assert.deepEqual(preparationIntent.nativeOperation.references, preparationReferences, 'the original association remains auditable');
    assert.deepEqual(preparationIntent.sourceFactIds, [observed.action.id], 'only known, existing facts enter execution evidence');
    assert.match(preparation.decision.executionCompilation.problem.message, /^移动已编译/);
  }
  assert.deepEqual(state.projects, projectsBeforePreparation, 'ordinary preparation neither creates nor progresses projects');
  api.setVoxel(state.world.grid, 12, 14, 1, api.Material.Clay);
  const clayTarget = { kind: 'voxel', position: { x: 12, y: 14, z: 1 } };
  const preparationObservation = run({ kind: 'observe', target: clayTarget, backgroundReferences: preparationReferences });
  assert.equal(preparationObservation.action.action.kind, 'attend');
  assert.equal(preparationObservation.action.status, 'completed', preparationObservation.action.result);
  assert.equal(state.intents.find((intent) => intent.id === preparationObservation.decision.intentId).projectId, undefined);
  assert.deepEqual(state.projects, projectsBeforePreparation);
  const unboundRecord = api.compileNativeOperation(emptyContext(), { kind: 'observe', target: clayTarget,
    references: { projectId: preparationReferences.projectId, recordId: 'unbound-special-learning-record' } }, 'unbound-record');
  assert.equal(unboundRecord.ok, false, 'project background does not turn unknown special learning into plain observation');
  assert.equal(unboundRecord.problem.code, 'missing-evidence');
  const unboundProject = api.compileNativeOperation(emptyContext(), { kind: 'project', projectId: preparationReferences.projectId }, 'unbound-project');
  assert.equal(unboundProject.ok, false, 'explicit project work still needs a complete current capability');

  // A move remains a move even when it names knowledge or happens to match
  // the travel prefix of a complete record-learning capability.
  const knowledgeBackground = person.knowledge.find((fact) => fact.sourceEventIds.includes(preparationObservation.action.id));
  assert(knowledgeBackground);
  const coupledMove = { ...record, id: 'record-travel-prefix',
    nextAction: { kind: 'move', toCellId: api.cellId(13, 14), toZ: 1 },
    completionAction: { kind: 'attend', target },
  };
  const coupledContext = { ...emptyContext(), state: richContext.state, options: [coupledMove] };
  const coupledDescriptor = api.describeNativeOperations(coupledContext).find((descriptor) => descriptor.request.kind === 'move');
  assert.equal(coupledDescriptor.requiresMethod, true);
  assert.equal(coupledDescriptor.summary, coupledMove.summary,
    'a complete method beginning with movement must retain the meaning of its whole process');
  const { goal: _coupledGoal, ...moveWithContext } = coupledDescriptor.request;
  const exactPrefix = api.compileNativeOperation(coupledContext, moveWithContext, 'move-only');
  assert(exactPrefix.ok);
  assert.equal(exactPrefix.option.nextAction.kind, 'move');
  assert.equal(exactPrefix.option.projectId, undefined);
  assert.equal(exactPrefix.option.projectProposal, undefined);
  assert.equal(exactPrefix.option.recordUseBasis, undefined);
  assert.equal(exactPrefix.option.completionAction, undefined, 'the travel prefix must not schedule an unchosen learning step');
  assert.equal(exactPrefix.feedback.code, 'context-association');
  assert.match(exactPrefix.feedback.message, /^移动已编译，等待实际执行/);
  const ordinaryMoveDescriptor = api.describeNativeOperations({ ...coupledContext,
    options: [{ ...exactPrefix.option, summary: '不应代替本次移动的泛化说明' }] }).find((descriptor) => descriptor.request.kind === 'move');
  assert.equal(ordinaryMoveDescriptor.requiresMethod, false);
  assert.equal(ordinaryMoveDescriptor.summary, exactPrefix.option.summary,
    'an ordinary move still describes only its actual destination');
  const methodPrefix = api.compileNativeOperation(coupledContext,
    { ...moveWithContext, methodKey: coupledDescriptor.methodKey }, 'whole-travel-method');
  assert(methodPrefix.ok);
  assert.deepEqual(methodPrefix.option, coupledMove, 'explicit method selection retains the full process whose current atom is movement');
  const emptySourceTravel = { ...sourceOnlyMeasurement, sourceFactIds: [],
    nextAction: coupledMove.nextAction, completionAction: measured.nextAction };
  const emptySourceTravelContext = { ...richContext, options: [emptySourceTravel] };
  const emptyTravelDescriptor = api.describeNativeOperations(emptySourceTravelContext).find((descriptor) => descriptor.request.kind === 'move');
  assert.deepEqual(emptyTravelDescriptor.request.references, { sourceEventIds: [] });
  assert.deepEqual(api.compileNativeOperation(emptySourceTravelContext,
    { ...emptyTravelDescriptor.request, methodKey: emptyTravelDescriptor.methodKey }, 'empty-source-method').option,
  emptySourceTravel, 'a real prepared measurement method does not become a bare move because sourceEventIds is empty');
  const knowledgeMove = { ...moveWithContext, references: {
    projectId: preparationReferences.projectId, recordId: record.recordUseBasis.recordId,
    knowledgeId: knowledgeBackground.id, techniqueId: record.recordUseBasis.techniqueId,
    agreementId: 'associated-social-context',
  } };
  const compoundPlan = '拾取黏土并揉捏，搬石块开始构建容器';
  const compoundMind = { ...mind, plan: { version: 'mental-plan-translation-v1', disposition: 'act', steps: [compoundPlan] } };
  const knowledgeBeforeMove = structuredClone(person.knowledge);
  const agreementsBeforeMove = structuredClone(state.agreements);
  const physicalMove = api.applyDecision(state, person, emptyContext(), {
    kind: 'idle', reason: '先靠近已有材料', mentalAct: compoundMind, nativeOperation: knowledgeMove,
  }, true, 1, order++, order);
  assert.equal(physicalMove.executionCompilation.status, 'compiled-with-feedback');
  assert(!person.memories.some((memory) => memory.id.startsWith('memory:native-compilation:')),
    'a successfully compiled preparation step does not create a failure episode');
  assert.doesNotMatch(person.currentActionText, /未绑定|编译|references/);
  const moveIntent = state.intents.find((intent) => intent.id === physicalMove.intentId);
  assert.notEqual(moveIntent.summary, compoundPlan, 'a movement summary cannot claim that its compound Plan was performed');
  assert.match(moveIntent.summary, /到达|靠近/);
  assert.doesNotMatch(moveIntent.summary, /揉捏|构建容器|"kind"|cellId/);
  const actualMove = api.executeActiveIntent(state, person, 1, order++, order);
  assert.equal(actualMove.action.kind, 'move');
  for (let tick = 0; person.activeIntentId && tick < 8; tick += 1) api.executeActiveIntent(state, person, 1, order++, order);
  assert.equal(moveIntent.status, 'completed');
  assert.deepEqual(person.knowledge, knowledgeBeforeMove, 'background references do not grant knowledge');
  assert.deepEqual(state.agreements, agreementsBeforeMove, 'background agreement references do not grant consent');
  assert.deepEqual(state.projects, projectsBeforePreparation, 'background references do not progress a project');
  assert.deepEqual(physicalMove.executionCompilation.operation, knowledgeMove);
  assert.equal(physicalMove.decision.mentalAct.plan.steps[0], compoundPlan, 'the broader Plan remains separately recorded');
  const carried = person.inventory.find((stack) => stack.quantity > 0);
  const distantRecipient = state.people.find((candidate) => candidate.id !== person.id);
  const physicalFailure = api.executePrimitiveAction(state, person, {
    kind: 'transfer', materialId: carried.materialId, quantity: 1, stackId: carried.id,
    from: { kind: 'person', personId: person.id }, to: { kind: 'person', personId: distantRecipient.id },
  }, 1, order++, { cause: 'intent', actionTick: order });
  assert.equal(physicalFailure.status, 'blocked', physicalFailure.result);
  assert(person.memories.some((memory) => memory.kind === 'failure' && memory.sourceEventIds.includes(physicalFailure.id)),
    'a real physical failure still produces its ordinary sourced memory');

  // Grounding regression: "move to this person" used distance 0. Resolve
  // contact with the occupied entity without rewriting its original criterion.
  person.position = { ...person.position, cellId: api.cellId(10, 12), z: 1 };
  api.setVoxel(state.world.grid, 14, 12, 1, api.Material.Air);
  other.position = { ...other.position, cellId: api.cellId(14, 12), z: 1 };
  const zeroPerson = { kind: 'move', target: { kind: 'person', personId: other.id }, withinDistance: 0 };
  const zeroCriterion = { kind: 'near-target', target: zeroPerson.target, maxDistance: 0 };
  const contactMind = { ...mind, plan: { version: 'mental-plan-translation-v1', disposition: 'act', steps: ['走到对方身边'],
    completion: { step: { description: '原始中心条件', conditions: [zeroCriterion] },
      goal: { description: '原始中心条件', conditions: [zeroCriterion] } } } };
  const contactDecision = api.applyDecision(state, person, emptyContext(), {
    kind: 'idle', reason: '走到对方身边', mentalAct: contactMind, nativeOperation: zeroPerson,
  }, true, 1, order++, order);
  assert.equal(contactDecision.executionCompilation.status, 'compiled-with-feedback', contactDecision.executionCompilation.problem?.message);
  assert.equal(contactDecision.executionCompilation.problem.code, 'spatial-translation');
  assert.deepEqual(contactDecision.executionCompilation.operation, zeroPerson);
  assert.notEqual(contactDecision.executionCompilation.compiledAction.toCellId, other.position.cellId);
  const contactAction = api.executeActiveIntent(state, person, 1, order++, order);
  assert.equal(contactAction.action.kind, 'move');
  for (let tick = 0; person.activeIntentId && tick < 8; tick += 1) api.executeActiveIntent(state, person, 1, order++, order);
  const contactIntent = state.intents.find((intent) => intent.id === contactDecision.intentId);
  assert.equal(contactIntent.status, 'completed');
  assert(api.positionsCanTouch(state.world.grid, person.position, other.position));
  assert.notEqual(person.position.cellId, other.position.cellId);
  assert.notEqual(contactAction.diff.planAssessment.goal, 'satisfied', 'contact translation cannot forge satisfaction of the original zero-distance criterion');
  assert.equal(contactIntent.plan.completion.goal.conditions[0].maxDistance, 0);
  const exactOccupiedVoxel = api.compileNativeOperation(emptyContext(), { kind: 'move', withinDistance: 0,
    target: { kind: 'voxel', position: { x: 14, y: 12, z: 1 } } }, 'exact-occupied-voxel');
  assert.equal(exactOccupiedVoxel.ok, false, 'an explicit exact voxel never acquires the entity-contact interpretation');
  assert(exactOccupiedVoxel.problem.message.includes(`${other.name}占据`));
  assert.match(exactOccupiedVoxel.problem.message, /本人已经处于可与其接触的位置/);
  assert.match(exactOccupiedVoxel.problem.message, /移动尚未开始/);
  const hiddenOccupant = api.compileNativeOperation({ ...emptyContext(), visiblePeople: [] }, { kind: 'move', withinDistance: 0,
    target: { kind: 'voxel', position: { x: 14, y: 12, z: 1 } } }, 'unseen-occupant');
  assert.equal(hiddenOccupant.ok, false);
  assert(!hiddenOccupant.problem.message.includes(other.name), 'compiler feedback must not identify an unseen occupant');

  // A real island has no contact route. Visible water and canopy can be
  // described, without claiming a walk happened or exposing the hidden trunk.
  const islandState = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  const islandObserver = islandState.people[0];
  for (let x = 16; x <= 22; x++) for (let y = 14; y <= 18; y++) for (let z = 0; z < islandState.world.grid.levels; z++) {
    api.setVoxel(islandState.world.grid, x, y, z, z < 5 ? api.Material.Stone : api.Material.Air);
  }
  islandObserver.position = { ...islandObserver.position, cellId: api.cellId(20, 16), z: 5 };
  for (const [x, y] of [[17, 16], [18, 15], [18, 17]]) api.setVoxel(islandState.world.grid, x, y, 4, api.Material.Water);
  api.setVoxel(islandState.world.grid, 19, 16, 5, api.Material.Wood);
  api.setVoxel(islandState.world.grid, 19, 16, 6, api.Material.Leaves);
  const islandDrop = { id: 'island-ore', cellId: api.cellId(18, 16), z: 5,
    materialId: api.Material.IronOre, quantity: 2, sourceEventIds: [], createdAtMonth: 0 };
  islandState.world.drops = [islandDrop];
  const islandContext = { ...api.buildDecisionContexts(islandState, 1).find((context) => context.person.id === islandObserver.id),
    visibleCells: [[20, 16], [18, 16], [17, 16], [18, 15], [18, 17], [19, 16]].map(([x, y]) => api.cellId(x, y)),
    visibleDrops: [islandDrop], visiblePeople: [], options: [], followUpOptions: [] };
  for (const withinDistance of [0, 1]) {
    const noRoute = api.compileNativeOperation(islandContext, { kind: 'move',
      target: { kind: 'drop', dropId: islandDrop.id }, withinDistance }, 'visible-island-no-route');
    assert.equal(noRoute.ok, false, 'neither exact entry nor adjacency can cross this blocked ring');
    assert.match(noRoute.problem.message, /目前没有找到满足指定距离/);
    assert.match(noRoute.problem.message, /移动尚未开始/);
    assert.match(noRoute.problem.message, /（18,15,4）为水/);
    assert.match(noRoute.problem.message, /（19,16,6）为树叶/);
    assert(!noRoute.problem.message.includes('木材'), 'a visible canopy does not reveal the hidden trunk');
    const hiddenTerrain = api.compileNativeOperation({ ...islandContext,
      visibleCells: [islandObserver.position.cellId, islandDrop.cellId] }, { kind: 'move',
      target: { kind: 'drop', dropId: islandDrop.id }, withinDistance }, 'unseen-island-ring');
    assert.equal(hiddenTerrain.ok, false);
    assert(!/水|树叶|19,16/.test(hiddenTerrain.problem.message), 'unseen neighboring terrain stays unreported');
  }
  assert.equal(islandDrop.quantity, 2);
  assert.deepEqual({ cellId: islandObserver.position.cellId, z: islandObserver.position.z }, { cellId: api.cellId(20, 16), z: 5 });

  person.position = { ...person.position, cellId: api.cellId(10, 13), z: 1 };
  other.position = { ...other.position, cellId: api.cellId(15, 13), z: 1 };
  preparationDrop.cellId = other.position.cellId;
  const zeroDrop = { kind: 'move', target: { kind: 'drop', dropId: preparationDrop.id }, withinDistance: 0 };
  const dropDecision = api.applyDecision(state, person, emptyContext(), {
    kind: 'idle', reason: '靠近地面材料', mentalAct: structuredClone(mind), nativeOperation: zeroDrop,
  }, true, 1, order++, order);
  assert.equal(dropDecision.executionCompilation.problem.code, 'spatial-translation');
  const dropMove = api.executeActiveIntent(state, person, 1, order++, order);
  assert.equal(dropMove.action.kind, 'move');
  for (let tick = 0; person.activeIntentId && tick < 8; tick += 1) api.executeActiveIntent(state, person, 1, order++, order);
  assert(api.positionsCanTouch(state.world.grid, person.position, preparationDrop));
  assert.notEqual(person.position.cellId, preparationDrop.cellId);
  assert.equal(preparationDrop.quantity, 2, 'approaching an occupied drop neither takes it nor moves its owner');
  assert.equal(other.position.cellId, preparationDrop.cellId);

  person.position = { ...person.position, cellId: api.cellId(10, 10), z: 1 };
  other.position = { ...other.position, cellId: api.cellId(14, 10), z: 1 };
  thirdPerson.position = { ...thirdPerson.position, cellId: api.cellId(16, 10), z: 1 };
  for (const [x, y] of [[13, 10], [15, 10], [14, 9], [14, 11]]) {
    for (let z = 1; z <= 3; z += 1) api.setVoxel(state.world.grid, x, y, z, api.Material.Stone);
  }
  const enclosedContact = api.compileNativeOperation(emptyContext(), zeroPerson, 'enclosed-person');
  assert.equal(enclosedContact.ok, false, 'distance-zero translation cannot create a contact pose through enclosing walls');
  assert.equal(enclosedContact.problem.code, 'missing-evidence');

  const publicState = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  const [observer, holder, distantHolder] = publicState.people;
  for (let x = 10; x <= 16; x += 1) for (let y = 10; y <= 16; y += 1) {
    for (let z = 0; z < publicState.world.grid.levels; z += 1) api.setVoxel(publicState.world.grid, x, y, z,
      z === 0 ? api.Material.Stone : api.Material.Air);
  }
  observer.position = { ...observer.position, cellId: api.cellId(12, 12), z: 1 };
  holder.position = { ...holder.position, cellId: api.cellId(13, 12), z: 1 };
  distantHolder.position = { ...distantHolder.position, cellId: api.cellId(16, 16), z: 1 };
  holder.inventory = [{ id: 'visible-tablet', materialId: api.Material.WoodTablet, quantity: 1,
    recordPayloadId: 'private-payload', sourceEventIds: ['private-inscription'] }];
  publicState.records.push({ id: 'private-payload', authorId: holder.id, knowledgeId: 'private-technique',
    codebookId: 'shared-writing-convention', kind: 'technique', summary: '尚未公开的制造方法',
    version: 1, createdAtMonth: 0, sourceEventIds: ['private-inscription'] });
  observer.knowledge.push({ id: 'shared-writing-convention', kind: 'codebook', summary: '能读懂这种符号',
    confidence: 90, learnedAtMonth: 0, sourceEventIds: [] });
  const publicDrop = { id: 'public-clay-pile', materialId: api.Material.Clay, quantity: 2,
    cellId: api.cellId(14, 12), z: 1, createdAtMonth: 0, sourceEventIds: [] };
  publicState.world.drops.push(publicDrop);
  const localContext = api.buildDecisionContexts(publicState, 1).find((context) => context.person.id === observer.id);
  const requestContext = api.buildDecisionRequestContext(localContext);
  const targetHandles = api.buildDecisionProbeHandleMap(requestContext);
  const holderHandle = targetHandles.visible.find((item) => item.kind === 'person' && item.personId === holder.id).handle;
  const itemHandle = targetHandles.visible.find((item) => item.kind === 'inventory-stack'
    && item.personId === holder.id && item.stackId === 'visible-tablet').handle;
  // A later/hidden inventory entry cannot be pulled into the request by an owner join.
  holder.inventory.push({ id: 'not-exposed-item', materialId: api.Material.Stone, quantity: 3, sourceEventIds: [] });
  targetHandles.visible.push({ handle: 'i-not-exposed', kind: 'inventory-stack', personId: holder.id, stackId: 'not-exposed-item' });
  const holderClosure = api.deriveWorldTargets(requestContext, targetHandles, [holderHandle]);
  assert(holderClosure.allowedHandles.includes(itemHandle));
  assert(!holderClosure.allowedHandles.includes('i-not-exposed'));
  assert(holderClosure.derived.some((edge) => edge.handle === itemHandle && edge.sourceHandle === holderHandle
    && edge.relation === 'visible-possession'));
  assert(!holderClosure.allowedHandles.some((handle) => targetHandles.visible.some((item) => item.handle === handle
    && item.kind === 'inventory-stack' && item.personId === distantHolder.id)));
  const observeHeld = api.compileModelNativeOperation({ kind: 'observe', targetHandle: itemHandle },
    requestContext, targetHandles, [holderHandle]);
  assert.equal(observeHeld.kind, 'observe', 'a selected person can ground observation of their already exposed possession');
  const holdingsBefore = structuredClone(publicState.people.map((person) => person.inventory));
  const observedHeld = api.executePrimitiveAction(publicState, observer, { kind: 'attend', target: observeHeld.target },
    1, 80, { cause: 'intent', actionTick: 1 });
  assert.equal(observedHeld.status, 'completed', observedHeld.result);
  assert.equal(observedHeld.diff.materialId, api.Material.WoodTablet);
  assert.equal(observedHeld.diff.quantity, 1);
  assert.equal(observedHeld.diff.observedPersonId, holder.id);
  assert.equal(observedHeld.diff.recordPayloadId, undefined);
  assert.equal(observedHeld.diff.verifiedTechnique, undefined);
  assert(!observer.knowledge.some((fact) => fact.id === 'private-technique'));
  assert(!observedHeld.result.includes('尚未公开的制造方法'));
  assert.deepEqual(publicState.people.map((person) => person.inventory), holdingsBefore, 'observing a possession does not transfer or consume it');
  holder.inventory[0].quantity = 2;
  const recounted = api.executePrimitiveAction(publicState, observer, { kind: 'attend', target: observeHeld.target },
    1, 81, { cause: 'intent', actionTick: 2 });
  assert.equal(recounted.diff.quantity, 2);
  assert.match(observer.knowledge.find((fact) => fact.id === recounted.diff.factId).summary, /× 2/);
  holder.position.cellId = api.cellId(16, 12);
  const movedAway = api.executePrimitiveAction(publicState, observer, { kind: 'attend', target: observeHeld.target },
    1, 82, { cause: 'intent', actionTick: 3 });
  assert.equal(movedAway.status, 'blocked', 'a stale visible possession cannot be inspected after its holder moves away');
  holder.position.cellId = api.cellId(13, 12);
  holder.inventory = holder.inventory.filter((stack) => stack.id !== 'visible-tablet');
  const disappeared = api.executePrimitiveAction(publicState, observer, { kind: 'attend', target: observeHeld.target },
    1, 83, { cause: 'intent', actionTick: 4 });
  assert.equal(disappeared.status, 'blocked');

  // A character's spoken injury is not a body condition. Inspect live exterior
  // state, then refresh the same observation after real injury and care.
  const bodyState = structuredClone(publicState);
  const [bodyObserver, bodyTarget] = bodyState.people;
  bodyTarget.conditions = [];
  bodyTarget.body.health = 92;
  bodyTarget.knowledge = [{ id: 'private-body-method', kind: 'technique', summary: '尚未说出的私人方法',
    confidence: 70, learnedAtMonth: 0, sourceEventIds: ['private-method-source'] }];
  let bodyOrder = 300;
  const bodyAction = (who, action, month = 1) => {
    const fact = api.executePrimitiveAction(bodyState, who, action, month, ++bodyOrder,
      { cause: 'intent', actionTick: bodyOrder });
    bodyState.world.past.push(fact);
    return fact;
  };
  const inspectBody = (who = bodyObserver, month = 1) => bodyAction(who,
    { kind: 'attend', target: { kind: 'person', personId: bodyTarget.id } }, month);
  const healthyLook = inspectBody();
  assert.equal(healthyLook.status, 'completed', healthyLook.result);
  assert.match(healthyLook.result, /当前未见伤口/);
  assert.equal(healthyLook.diff.bodyObservation.wound, 'not-seen');
  assert.equal(healthyLook.diff.bodyObservation.scope, 'close-exterior');
  assert.equal(healthyLook.diff.health, undefined, 'ordinary looking does not measure health points');
  assert(!healthyLook.result.includes('92') && !healthyLook.result.includes('私人方法'));
  assert(!bodyObserver.knowledge.some((fact) => fact.id === 'private-body-method'));
  const selfLook = inspectBody(bodyTarget);
  assert.equal(selfLook.diff.bodyObservation.scope, 'self');
  assert.equal(selfLook.diff.bodyObservation.wound, 'not-seen');
  bodyObserver.position = { ...bodyTarget.position };
  const injury = bodyAction(bodyObserver, { kind: 'act', operation: 'exert',
    targets: [{ kind: 'person', personId: bodyTarget.id }] });
  assert.equal(injury.status, 'completed', injury.result);
  assert(bodyTarget.conditions.some((condition) => condition.kind === 'wound'));
  bodyObserver.position.cellId = api.cellId(12, 12);
  const injuredLook = inspectBody(bodyObserver, 2);
  assert.equal(injuredLook.diff.bodyObservation.wound, 'seen');
  assert.match(injuredLook.result, /可见.*伤口/);
  assert.equal(injuredLook.diff.factId, healthyLook.diff.factId);
  assert.deepEqual(injuredLook.diff.sourceEventIds, [injuredLook.id], 'looking does not reveal the hidden cause of a wound');
  bodyTarget.position.cellId = api.cellId(16, 12);
  const distantLook = inspectBody(bodyObserver, 2);
  assert.equal(distantLook.status, 'completed', distantLook.result);
  assert.equal(distantLook.diff.bodyObservation.wound, 'unverified');
  assert.equal(distantLook.diff.bodyObservation.visibleSigns, undefined);
  assert.match(distantLook.result, /无法看清.*不能确认有无伤口/);
  bodyTarget.position.cellId = api.cellId(13, 12);
  bodyObserver.position = { ...bodyTarget.position };
  bodyObserver.inventory.push({ id: 'body-care-fiber', materialId: api.Material.Fiber, quantity: 3, sourceEventIds: ['fixture-care-material'] });
  while (bodyTarget.conditions.some((condition) => condition.kind === 'wound')) {
    const care = bodyAction(bodyObserver, { kind: 'act', operation: 'combine', targets: [
      { kind: 'inventory-stack', personId: bodyObserver.id, stackId: 'body-care-fiber' },
      { kind: 'person', personId: bodyTarget.id },
    ] }, 2);
    assert.equal(care.status, 'completed', care.result);
  }
  const recoveredLook = inspectBody(bodyObserver, 3);
  assert.equal(recoveredLook.diff.bodyObservation.wound, 'not-seen');
  const latestBodyKnowledge = bodyObserver.knowledge.find((fact) => fact.id === recoveredLook.diff.factId);
  assert.match(latestBodyKnowledge.summary, /第3月.*当前未见伤口/);
  assert.equal(latestBodyKnowledge.learnedAtMonth, 3);
  assert.deepEqual(latestBodyKnowledge.sourceEventIds, [recoveredLook.id]);
  assert.equal(bodyObserver.knowledge.filter((fact) => fact.id === recoveredLook.diff.factId).length, 1);
  bodyTarget.conditions.push({ id: 'private-illness', kind: 'illness', stage: 2, sinceMonth: 3, sourceEventIds: ['private-illness-source'] });
  const exteriorOnly = inspectBody(bodyObserver, 3);
  assert(!JSON.stringify(exteriorOnly.diff).includes('illness'));
  assert(!/疾病|诊断|健康92/.test(exteriorOnly.result));
  const teaching = bodyAction(bodyTarget, { kind: 'talk', delivery: 'call', speakerMeaning: {
    id: 'body-target-explanation', kind: 'claim', factId: 'private-body-method', summary: '现在把我知道的方法讲出来。',
  } }, 3);
  assert(teaching.diff.languageBroadcast.decodedByPersonIds.includes(bodyObserver.id));
  const studied = bodyAction(bodyObserver, { kind: 'attend', target: { kind: 'person', personId: bodyTarget.id },
    learning: { sourceEventId: teaching.id, factId: 'private-body-method' } }, 3);
  assert.equal(studied.status, 'completed', studied.result);
  assert.equal(studied.diff.learnedFactId, 'private-body-method', 'source-bound teaching keeps its dedicated execution path');
  assert.equal(studied.diff.bodyObservation, undefined);

  const dropHandle = targetHandles.visible.find((item) => item.kind === 'drop' && item.dropId === publicDrop.id).handle;
  const placementClosure = api.deriveWorldTargets(requestContext, targetHandles, [dropHandle]);
  const placementEdge = placementClosure.derived.find((edge) => edge.sourceHandle === dropHandle && edge.relation === 'public-position');
  assert(placementEdge, 'a selected material pile exposes its existing public position as an assemble anchor');
  const anchor = api.nativeWorldRefForHandle(placementEdge.handle, targetHandles);
  assert.deepEqual(anchor, { kind: 'voxel', position: { x: 14, y: 12, z: 1 } });
  assert(targetHandles.voxels.some((voxel) => voxel.handle === placementEdge.handle), 'the closure reuses an already exposed voxel handle');
  assert(placementClosure.derived.some((edge) => edge.sourceHandle === 'self' && edge.relation === 'support-surface'),
    'the actor\'s already exposed supporting surface can be a local construction anchor');
  const noPositions = api.deriveWorldTargets(requestContext, { ...targetHandles, voxels: [] }, [dropHandle]);
  assert(noPositions.unresolvedPositions.some((entry) => entry.sourceHandle === dropHandle && entry.reason === 'position-handle-not-exposed'));

  const ownHeldHandle = targetHandles.held[0].handle;
  const selfTarget = { kind: 'person', personId: observer.id };
  const noCapability = { ...localContext, options: [], followUpOptions: [] };
  const intentsBeforeInvalidShape = publicState.intents.length;
  const invalidCombine = api.compileNativeOperation(noCapability, { kind: 'act', operation: 'combine',
    targets: [selfTarget, selfTarget] }, 'invalid-self-combine');
  assert.equal(invalidCombine.ok, false);
  assert.equal(invalidCombine.problem.code, 'invalid-operation');
  assert.equal(publicState.intents.length, intentsBeforeInvalidShape, 'a parameter error cannot create a placeholder intent or physical failure');
  assert.equal(api.compileModelNativeOperation({ kind: 'act', operation: 'combine', targetHandles: ['self', 'self'] },
    requestContext, targetHandles, ['self']), undefined, 'model parsing rejects bodies substituted for materials');
  const repeatedMaterial = api.compileModelNativeOperation({ kind: 'act', operation: 'combine', targetHandles: [ownHeldHandle, ownHeldHandle] },
    requestContext, targetHandles, [ownHeldHandle]);
  assert(repeatedMaterial);
  assert.equal(repeatedMaterial.targets.length, 2, 'repeating a real stack remains a meaningful request for two units');
  assert(api.compileNativeOperation(noCapability, repeatedMaterial, 'two-real-input-units').ok,
    'parameter typing does not decide whether these materials will react');
  assert(api.compileNativeOperation(noCapability, { kind: 'act', operation: 'combine', targets: [repeatedMaterial.targets[0], selfTarget] }, 'self-care').ok);
  assert(api.compileNativeOperation(noCapability, { kind: 'act', operation: 'separate', targets: [selfTarget] }, 'self-release').ok);
  assert(api.compileNativeOperation(noCapability, { kind: 'act', operation: 'exert',
    targets: [{ kind: 'person', personId: holder.id }] }, 'unarmed-force').ok);
  const ordinaryExert = { kind: 'act', operation: 'exert', targets: [repeatedMaterial.targets[0], anchor] };
  assert.equal(api.compileNativeOperation(noCapability, ordinaryExert, 'missing-hand-tool').ok, false);
  const boundProcess = { id: 'sourced-process-option', summary: '安装真实机械构件', reason: '当前已有完整构件及位置依据',
    goal: { kind: 'project-completed', projectId: 'real-mechanical-project' }, projectId: 'real-mechanical-project',
    nextAction: { ...ordinaryExert, mechanicalPowerBasis: { version: 'mechanical-power-action-basis-v1', mode: 'install',
      projectId: 'real-mechanical-project', componentRole: 'converter', componentMaterialId: api.Material.WaterWheel,
      componentPosition: anchor.position, manufactureEventId: 'real-component-manufacture' } },
    sourceFactIds: ['real-component-manufacture'], estimatedDuration: 'several-months' };
  const processContext = { ...noCapability, state: { ...noCapability.state, projects: [...noCapability.state.projects,
    { id: 'real-mechanical-project', ownerId: observer.id, contributorIds: [observer.id], actionEventIds: ['real-component-manufacture'],
      kind: 'production', desiredFunction: 'water-powered-crop-processing', status: 'active', summary: '安装真实机械构件' },
  ] }, options: [boundProcess] };
  assert.equal(api.compileNativeOperation(processContext, ordinaryExert, 'no-implicit-process').ok, false,
    'sharing the operation and targets does not implicitly choose a mechanical process');
  const boundCompilation = api.compileNativeOperation(processContext, { ...ordinaryExert,
    references: { sourceEventIds: ['real-component-manufacture'] } }, 'bound-exert');
  assert(boundCompilation.ok);
  assert.deepEqual(boundCompilation.option, boundProcess, 'a full native capability keeps its non-hand-tool execution basis');
  const { projectId: _processProject, ...sourceOnlyProcess } = boundProcess;
  const sourceOnlyProcessContext = { ...processContext, options: [sourceOnlyProcess] };
  const mechanicalDescriptor = api.describeNativeOperations(sourceOnlyProcessContext).find((descriptor) => descriptor.request.kind === 'act');
  assert.equal(mechanicalDescriptor.requiresMethod, true);
  assert.deepEqual(mechanicalDescriptor.request.references, { sourceEventIds: ['real-component-manufacture'] });
  const exactMechanical = api.compileNativeOperation(sourceOnlyProcessContext,
    { ...mechanicalDescriptor.request, methodKey: mechanicalDescriptor.methodKey }, 'source-only-mechanical-method');
  assert(exactMechanical.ok);
  assert.deepEqual(exactMechanical.option.nextAction.mechanicalPowerBasis, boundProcess.nextAction.mechanicalPowerBasis);
  const rawExert = { kind: 'act', operation: 'exert', targetHandles: [ownHeldHandle, placementEdge.handle] };
  assert.equal(api.compileModelNativeOperation(rawExert, { ...requestContext, nativeOperations: [] }, targetHandles,
    rawExert.targetHandles), undefined);
  const exposedProcess = { ...requestContext, nativeOperations: api.describeNativeOperations(processContext) };
  assert.equal(api.compileModelNativeOperation(rawExert, exposedProcess, targetHandles, rawExert.targetHandles), undefined,
    'an ordinary exert request cannot implicitly borrow a mechanical process');
  const mechanicalHandles = { ...targetHandles,
    nativeMethods: api.buildDecisionProbeHandleMap(api.buildDecisionRequestContext(sourceOnlyProcessContext)).nativeMethods };
  const mechanicalMethod = mechanicalHandles.nativeMethods.find((method) => method.request.methodKey === mechanicalDescriptor.methodKey);
  assert(mechanicalMethod, 'source-only mechanical metadata must remain selectable as a complete method');
  const boundMechanicalRequest = api.compileModelNativeOperation({ kind: 'use-method', methodHandle: mechanicalMethod.handle },
    exposedProcess, mechanicalHandles, rawExert.targetHandles);
  assert(boundMechanicalRequest);
  assert.equal(boundMechanicalRequest.methodKey, mechanicalDescriptor.methodKey);
  assert.deepEqual(api.compileNativeOperation(sourceOnlyProcessContext, boundMechanicalRequest, 'wire-mechanical-method').option,
    sourceOnlyProcess);

  let diagnostic;
  assert.equal(api.compileModelNativeOperation({ kind: 'observe', targetHandle: ownHeldHandle, instrumentHandle: ownHeldHandle },
    requestContext, targetHandles, [ownHeldHandle], (message) => { diagnostic = message; }), undefined);
  assert.match(diagnostic, /use-method/);
  const foodInstrument = api.compileNativeOperation(noCapability, { kind: 'observe', target: repeatedMaterial.targets[0],
    instrument: repeatedMaterial.targets[0] }, 'food-is-not-instrument');
  assert.equal(foodInstrument.ok, false);
  const nakedSample = api.compileNativeOperation({ ...richContext, options: [measured] }, { kind: 'observe', target }, 'naked-sample');
  assert(nakedSample.ok);
  assert.equal(nakedSample.option.nextAction.instrumentStackId, undefined);
  assert.equal(nakedSample.option.nextAction.measurement, undefined, 'omitting an instrument does not silently select a measurement capability');
  const nakedFact = api.executePrimitiveAction(state, person, nakedSample.option.nextAction, 1, 91, { cause: 'intent', actionTick: 1 });
  assert.equal(nakedFact.status, 'completed', nakedFact.result);
  assert.equal(nakedFact.diff.measurement, undefined);
  const measuredRequest = api.compileModelNativeOperation(projectedMeasurement.request,
    referenceContext, referenceHandles, ['held-sample', 'held-scale']);
  assert.equal(measuredRequest.instrument.stackId, 'actual-scale', 'use-method retains its bound target and real instrument');
  assert.equal(api.compileModelNativeOperation({ ...projectedMeasurement.request, targetHandle: 'held-scale' },
    referenceContext, referenceHandles), undefined, 'use-method cannot override its frozen subject');

  const positionHandles = { ...targetHandles, voxels: [...targetHandles.voxels,
    { handle: 'v-holder-position', position: { x: 13, y: 12, z: 1 } }] };
  diagnostic = undefined;
  assert.equal(api.compileModelNativeOperation({ kind: 'move', targetHandle: 'v-holder-position', withinDistance: 0 },
    requestContext, positionHandles, [holderHandle], (message) => { diagnostic = message; }), undefined);
  assert.match(diagnostic, /派生的定位锚点/);
  const approachHolder = api.compileModelNativeOperation({ kind: 'move', targetHandle: holderHandle, withinDistance: 0 },
    requestContext, positionHandles, [holderHandle]);
  assert.equal(approachHolder.target.kind, 'person');
  const walkingDescriptor = api.projectNativeOperations({ ...requestContext, nativeOperations: [{
    request: approachHolder, summary: '本人走到对方身边', reason: '选定近身交谈位置', sourceEventIds: [],
  }] }, positionHandles)[0];
  assert.equal(walkingDescriptor.request.kind, 'walk-to', 'World describes walking explicitly while the domain remains move');
  assert.deepEqual(api.compileModelNativeOperation(walkingDescriptor.request, requestContext, positionHandles, [holderHandle]),
    approachHolder, 'walk-to and the direct-fixture move alias retain identical target/distance semantics');
  assert.equal(api.compileModelNativeOperation({ kind: 'walk-to', targetHandle: 'v-holder-position', withinDistance: 0 },
    requestContext, positionHandles, [holderHandle]), undefined, 'renaming walking cannot admit a derived placement as its destination');
  const precisePosition = api.compileModelNativeOperation({ kind: 'move', targetHandle: 'v-holder-position', withinDistance: 0 },
    requestContext, positionHandles, [holderHandle, 'v-holder-position']);
  assert.equal(precisePosition.target.kind, 'voxel', 'only an explicitly selected position stays an exact voxel move');

  observer.position = { ...observer.position, cellId: api.cellId(12, 12), z: 1 };
  holder.position = { ...holder.position, cellId: api.cellId(13, 12), z: 1 };
  const proposal = api.executePrimitiveAction(publicState, holder, { kind: 'talk', delivery: 'call', speakerMeaning: {
    id: 'background-cooperation', kind: 'offer', summary: '愿意一起尝试搭个棚子吗？',
    proposal: { kind: 'joint-action', proposerId: holder.id, inviteeIds: [observer.id], summary: '一起尝试搭棚' },
  } }, 1, 100, { cause: 'intent', actionTick: 1 });
  assert.equal(proposal.status, 'completed', proposal.result);
  publicState.world.past.push(proposal);
  const agreement = publicState.agreements.find((agreement) => agreement.id === 'background-cooperation');
  assert.equal(agreement.status, 'proposed');
  const agreementBefore = structuredClone(agreement);
  const preparation = { kind: 'transfer', source: { kind: 'drop', dropId: publicDrop.id },
    destination: { kind: 'person', personId: observer.id }, quantity: 1, materialId: api.Material.Clay,
    backgroundReferences: { agreementId: agreement.id, sourceEventIds: [proposal.id] } };
  const preparationContext = { ...api.buildDecisionContexts(publicState, 1).find((context) => context.person.id === observer.id), options: [], followUpOptions: [] };
  const preparationCompilation = api.compileNativeOperation(preparationContext, preparation, 'joint-background-transfer');
  assert(preparationCompilation.ok, JSON.stringify(preparationCompilation.problem));
  assert.equal(preparationCompilation.option.nextAction.authorizationRef, undefined);
  assert.equal(preparationCompilation.feedback.code, 'context-association');
  const farTaking = api.executePrimitiveAction(publicState, observer, preparationCompilation.option.nextAction, 1, 101,
    { cause: 'intent', actionTick: 2 });
  assert.equal(farTaking.action.kind, 'move', 'a distant selected pickup first executes a real approach');
  assert.equal(farTaking.diff.quantity, undefined, 'approaching cannot report material transferred');
  assert.equal(publicDrop.quantity, 2);
  observer.position.cellId = api.cellId(13, 12);
  const preparedDecision = api.applyDecision(publicState, observer, { ...preparationContext, person: observer }, {
    kind: 'idle', reason: '先独立取回可触及的材料', nativeOperation: preparation, mentalAct: structuredClone(mind),
  }, true, 1, 102, 3);
  assert.deepEqual(preparedDecision.executionCompilation.operation, preparation);
  const preparedIntent = publicState.intents.find((intent) => intent.id === preparedDecision.intentId);
  assert.equal(preparedIntent.agreementId, undefined);
  const actualTaking = api.executeActiveIntent(publicState, observer, 1, 103, 3);
  assert.equal(actualTaking.status, 'completed', actualTaking.result);
  assert.equal(publicDrop.quantity, 1);
  assert.equal(actualTaking.action.authorizationRef, undefined);
  assert.deepEqual(agreement, agreementBefore, 'independent preparation does not accept, authorize or fulfill the proposed joint undertaking');
  // Implementation resources need not have been repeated in Plan's target list.
  const craftState = api.createInitialState(17, { endpoint: { kind: 'months', value: 2 } });
  const craftsperson = craftState.people[0];
  for (let x = 10; x <= 14; x += 1) for (let y = 10; y <= 14; y += 1) {
    for (let z = 0; z < craftState.world.grid.levels; z += 1) api.setVoxel(craftState.world.grid, x, y, z,
      z === 0 ? api.Material.Stone : api.Material.Air);
  }
  craftsperson.position = { ...craftsperson.position, cellId: api.cellId(12, 12), z: 1 };
  craftsperson.inventory = [api.Material.Food, api.Material.Wood, api.Material.IronOre].map((materialId, index) => ({
    id: `craft-input-${index}`, materialId, quantity: 2, sourceEventIds: [],
  }));
  const craftContext = api.buildDecisionContexts(craftState, 1).find((candidate) => candidate.person.id === craftsperson.id);
  const craftRequest = api.buildDecisionRequestContext(craftContext);
  // The fixture explicitly shows these real, supported air positions to World.
  for (const position of [{ x: 13, y: 12, z: 1 }, { x: 12, y: 13, z: 1 }]) {
    craftRequest.visibleVoxels.push({ position, name: '已看见的空位', properties: [], });
  }
  const craftProtocol = api.buildDecisionModelRequestProtocol(craftRequest);
  const thirdInputHandle = craftProtocol.handles.held.find((item) => item.stackId === 'craft-input-2').handle;
  const unusedInputHandle = craftProtocol.handles.held.find((item) => item.stackId === 'craft-input-1').handle;
  const workSiteHandle = craftProtocol.handles.voxels.find((item) => item.position.x === 13 && item.position.y === 12 && item.position.z === 1).handle;
  const unusedSiteHandle = craftProtocol.handles.voxels.find((item) => item.position.x === 12 && item.position.y === 13 && item.position.z === 1).handle;
  const craftStep = { kind: 'physical', description: '把本人持有的一份铁矿石堆放成一件试制物', targetHandles: ['self'] };
  const craftClosure = api.deriveWorldTargets(craftRequest, craftProtocol.handles, craftStep.targetHandles);
  assert(craftClosure.derived.some((edge) => edge.handle === thirdInputHandle && edge.sourceHandle === 'self' && edge.relation === 'actor-possession'));
  assert(craftClosure.derived.some((edge) => edge.handle === workSiteHandle && edge.relation === 'perceived-placement'));
  assert.equal(api.compileModelNativeOperation({ kind: 'move', targetHandle: workSiteHandle }, craftRequest, craftProtocol.handles, ['self']), undefined,
    'a placement candidate does not become an implicitly selected movement destination');
  assert.equal(api.compileModelNativeOperation({ kind: 'move', targetHandle: thirdInputHandle }, craftRequest, craftProtocol.handles, ['self']), undefined,
    'an implicit material remains an input, not a new movement target');
  const inventoryBeforeChoice = structuredClone(craftsperson.inventory);
  const craftResolution = api.sanitizePlanAgentWorldVerdict({ status: 'completed', result: '尝试堆放实料', effects: [
    { kind: 'consume', targetHandle: thirdInputHandle, quantity: 1 },
    { kind: 'assemble', targetHandle: workSiteHandle, arrangement: 'pile', summary: '铁矿石试制物' },
  ] }, craftStep, craftProtocol);
  assert(craftResolution?.probe, 'World can explicitly choose the unlisted third held material and a separately shown site');
  assert.deepEqual(craftsperson.inventory, inventoryBeforeChoice, 'making inputs available never selects or consumes them');
  const normalizedCraft = api.normalizeMindPlanModelOutput(craftRequest, {
    utterance: '我把自己的铁矿石堆在旁边试试。', delivery: 'normal', speechIntent: { kind: 'expression' },
    goal: '用持有的铁矿石做一件试制物', orientation: 'construction', horizon: 'momentary',
  }, { disposition: 'act', steps: [craftStep.description], currentStep: craftStep }, craftProtocol, craftResolution);
  const auditedStep = normalizedCraft.mentalAct.plan.currentStep;
  assert.deepEqual(auditedStep.targets, [{ kind: 'person', personId: craftsperson.id }], 'the original Plan targets remain its actual selections');
  assert(auditedStep.derivedTargets.some((edge) => edge.relation === 'actor-possession' && edge.target.stackId === 'craft-input-2'));
  assert(auditedStep.derivedTargets.some((edge) => edge.relation === 'perceived-placement' && edge.target.position.x === 13));
  assert(!craftResolution.targetDerivations.some((edge) => edge.handle === unusedInputHandle || edge.handle === unusedSiteHandle),
    'unused available materials and sites are not reported as used');
  const crafted = api.executePrimitiveAction(craftState, craftsperson, {
    kind: 'world-interact', adjudication: craftResolution.probe.adjudication,
  }, 1, 200, { cause: 'intent', actionTick: 1 });
  assert.equal(crafted.status, 'completed', crafted.result);
  const builtWork = craftState.world.works.find((work) => work.sourceEventIds.includes(crafted.id));
  assert.deepEqual(builtWork.position, { x: 13, y: 12, z: 1 });
  assert.equal(craftsperson.inventory.find((stack) => stack.id === 'craft-input-2').quantity, 1);
  assert.equal(craftsperson.inventory.find((stack) => stack.id === 'craft-input-1').quantity, 2);
  assert(!api.deriveWorldTargets(requestContext, targetHandles, ['self']).allowedHandles.includes(itemHandle),
    'self does not expand the visible or hidden inventory of another person');
  // A selected quantity is an acquisition, with movement as its prefix. One
  // decision survives multiple body ticks and follows only the same drop ID.
  const pickupState = api.createInitialState(17, { endpoint: { kind: 'months', value: 2 } });
  const picker = pickupState.people[0];
  for (let x = 10; x <= 22; x += 1) for (let y = 10; y <= 14; y += 1) {
    for (let z = 0; z < pickupState.world.grid.levels; z += 1) api.setVoxel(pickupState.world.grid, x, y, z,
      z === 0 ? api.Material.Stone : api.Material.Air);
  }
  picker.position = { ...picker.position, cellId: api.cellId(11, 12), z: 1 };
  picker.inventory = [{ id: 'already-owned-wood', materialId: api.Material.Wood, quantity: 2, sourceEventIds: [] }];
  const pickupDrop = { id: 'selected-twelve-portions', materialId: api.Material.Wood, quantity: 12,
    cellId: api.cellId(17, 12), z: 1, createdAtMonth: 0, sourceEventIds: [] };
  pickupState.world.drops = [pickupDrop];
  const pickupRef = { kind: 'drop', dropId: pickupDrop.id };
  const woodObservation = api.executePrimitiveAction(pickupState, picker, { kind: 'attend', target: pickupRef },
    1, 300, { cause: 'intent', actionTick: 1 });
  assert.equal(woodObservation.status, 'completed', woodObservation.result);
  assert.match(woodObservation.result, /木材共12份/);
  assert.match(woodObservation.result, /每份外观为固体、长条结构/);
  assert.equal(woodObservation.diff.observedDropId, pickupDrop.id);
  assert.deepEqual(woodObservation.diff.position, { x: 17, y: 12, z: 1 });
  assert.equal(woodObservation.diff.perception.loadBand, undefined, 'a look does not invent measured weight');
  assert.equal(pickupDrop.quantity, 12);
  const pickupRequest = { kind: 'transfer', source: pickupRef,
    destination: { kind: 'person', personId: picker.id }, materialId: api.Material.Wood, quantity: 4 };
  const oldInventoryCondition = { kind: 'fact', predicate: { kind: 'inventory-at-least', materialId: api.Material.Wood, quantity: 1 } };
  const pickupMind = { ...mind, goal: '再取四份木材', plan: { version: 'mental-plan-translation-v1', disposition: 'act', steps: ['取四份木材'],
    completion: { step: { description: '持有木材', conditions: [oldInventoryCondition] },
      goal: { description: '持有木材', conditions: [oldInventoryCondition] } } } };
  const pickupContext = () => ({ ...api.buildDecisionContexts(pickupState, 1).find((context) => context.person.id === picker.id),
    options: [], followUpOptions: [] });
  const pickupDecision = api.applyDecision(pickupState, picker, pickupContext(), {
    kind: 'idle', reason: '取所选物资', mentalAct: pickupMind, nativeOperation: pickupRequest,
  }, true, 1, 301, 2);
  const pickupIntent = pickupState.intents.find((intent) => intent.id === pickupDecision.intentId);
  assert.equal(pickupIntent.goal.quantity, 6, 'taking four means four more than the two already owned');
  assert.equal(pickupIntent.completionAction.quantity, 4);
  const pickupFacts = [];
  const firstApproach = api.executeActiveIntent(pickupState, picker, 1, 302, 3);
  assert.equal(firstApproach.action.kind, 'move');
  pickupFacts.push(firstApproach);
  assert.equal(pickupIntent.status, 'active', 'existing same-material inventory cannot satisfy the selected acquisition');
  assert.equal(pickupDrop.quantity, 12, 'the preparation move cannot take anything');
  assert.deepEqual(firstApproach.decisionSource, { executionDecisionEventId: pickupDecision.id,
    intentionDecisionEventId: pickupDecision.id });
  const originalApproachSource = structuredClone(firstApproach.decisionSource);
  const pickupReuse = api.applyDecision(pickupState, picker, { ...pickupContext(),
    currentMonthEvents: [pickupDecision, firstApproach] }, {
    kind: 'idle', reason: '保留目标，继续取这四份木材', nativeOperation: pickupRequest,
    authoredAttempt: { kind: 'native', intentionSourceDecisionEventId: pickupDecision.id },
  }, true, 1, 303, 4);
  assert.equal(pickupReuse.intentId, pickupIntent.id, 'the source regression must actually reuse one Intent');
  assert.equal(pickupIntent.sourceDecisionEventId, pickupReuse.id);
  assert.deepEqual(firstApproach.decisionSource, originalApproachSource, 'reusing the Intent cannot change an earlier ActionFact source');
  pickupDrop.cellId = api.cellId(18, 12);
  for (let tick = 4; picker.activeIntentId && tick < 18; tick += 1) {
    const action = api.executeActiveIntent(pickupState, picker, 1, 300 + tick, tick);
    if (action) pickupFacts.push(action);
  }
  assert.equal(pickupIntent.status, 'completed');
  assert.deepEqual(pickupDecision.executionCompilation.operation, pickupRequest);
  assert(pickupFacts.every((fact) => fact.intentId === pickupIntent.id), 'no new Plan or placeholder intent is needed between approach and transfer');
  const actualPickups = pickupFacts.filter((fact) => fact.action.kind === 'transfer');
  assert.equal(actualPickups.length, 1);
  assert.equal(actualPickups[0].action.quantity, 4, 'the default collection suggestion of three never replaces the request');
  assert.deepEqual(actualPickups[0].decisionSource, { executionDecisionEventId: pickupReuse.id,
    intentionDecisionEventId: pickupDecision.id }, 'the later action records the new operation author and the retained goal origin');
  assert.deepEqual(firstApproach.decisionSource, originalApproachSource);
  assert.equal(actualPickups[0].action.dropId, pickupDrop.id);
  assert.equal(actualPickups[0].action.from.cellId, pickupDrop.cellId, 'the same source is rechecked at its real current position');
  assert.equal(pickupDrop.quantity, 8);
  assert.equal(picker.inventory.reduce((sum, stack) => sum + (stack.materialId === api.Material.Wood ? stack.quantity : 0), 0), 6);
  const updatedWoodObservation = api.executePrimitiveAction(pickupState, picker, { kind: 'attend', target: pickupRef },
    1, 320, { cause: 'intent', actionTick: 20 });
  assert.match(updatedWoodObservation.result, /木材共8份/);
  const observedWood = picker.knowledge.find((fact) => fact.id === woodObservation.diff.factId);
  assert.equal(observedWood.summary, updatedWoodObservation.result);
  assert(observedWood.sourceEventIds.includes(woodObservation.id) && observedWood.sourceEventIds.includes(updatedWoodObservation.id));
  assert.equal(pickupState.world.works?.length ?? 0, 0, 'observing or acquiring wood does not manufacture anything');

  picker.position.cellId = api.cellId(11, 12);
  const lostDecision = api.applyDecision(pickupState, picker, pickupContext(), {
    kind: 'idle', reason: '再取同一份物资', mentalAct: structuredClone(mind), nativeOperation: pickupRequest,
  }, true, 1, 321, 21);
  api.executeActiveIntent(pickupState, picker, 1, 322, 22);
  pickupState.world.drops = [{ ...pickupDrop, id: 'different-pile-at-same-place', quantity: 20 }];
  const inventoryBeforeLoss = structuredClone(picker.inventory);
  const lostAction = api.executeActiveIntent(pickupState, picker, 1, 323, 23);
  assert.equal(lostAction, null, 'a vanished source cannot be substituted with a different pile');
  const lostIntent = pickupState.intents.find((intent) => intent.id === lostDecision.intentId);
  assert.equal(lostIntent.status, 'blocked');
  assert.match(lostIntent.blockedReason, /所选地面物资已经不存在/);
  assert.deepEqual(picker.inventory, inventoryBeforeLoss);
  assert.equal(pickupState.world.drops[0].quantity, 20);

  // The real seed-17 stone pile is visible across terrain without a walking
  // route. Retain the selected request without attempting a remote transfer.
  const unreachableState = api.createInitialState(17, { endpoint: { kind: 'months', value: 2 } });
  const unreachablePicker = unreachableState.people.find((person) => person.id === 'nausicaa');
  unreachablePicker.position = { ...unreachablePicker.position, cellId: 2371, z: 5 };
  const unreachableRequest = { kind: 'transfer', source: { kind: 'drop', dropId: 'stone-2365' },
    destination: { kind: 'person', personId: unreachablePicker.id }, quantity: 3, materialId: api.Material.Stone };
  const unreachableContext = api.buildDecisionContexts(unreachableState, 1).find((context) => context.person.id === unreachablePicker.id);
  const unreachableDecision = api.applyDecision(unreachableState, unreachablePicker,
    { ...unreachableContext, options: [], followUpOptions: [] },
    { kind: 'idle', reason: '取这三份石料', mentalAct: structuredClone(mind), nativeOperation: unreachableRequest }, true, 1, 330, 24);
  assert.deepEqual(unreachableDecision.executionCompilation.operation, unreachableRequest);
  assert.equal(unreachableDecision.executionCompilation.status, 'unresolved');
  assert.match(unreachableDecision.executionCompilation.problem.message, /物资仍在.*可达接触位置/);
  assert.equal(unreachableDecision.intentId, undefined);
  assert.equal(unreachableState.world.drops.find((drop) => drop.id === 'stone-2365').quantity, 3);

  picker.position = { ...picker.position, cellId: api.cellId(11, 12), z: 1 };
  pickupState.world.drops = [pickupDrop];
  const routeLostDecision = api.applyDecision(pickupState, picker, pickupContext(), {
    kind: 'idle', reason: '继续取同一批木材', mentalAct: structuredClone(mind), nativeOperation: pickupRequest,
  }, true, 1, 331, 25);
  assert.equal(api.executeActiveIntent(pickupState, picker, 1, 332, 26).action.kind, 'move');
  pickupDrop.cellId = 2365; pickupDrop.z = 5;
  const inventoryBeforeRouteLoss = structuredClone(picker.inventory);
  assert.equal(api.executeActiveIntent(pickupState, picker, 1, 333, 27), null);
  const routeLostIntent = pickupState.intents.find((intent) => intent.id === routeLostDecision.intentId);
  assert.equal(routeLostIntent.status, 'blocked');
  assert.match(routeLostIntent.blockedReason, /物资仍在.*可达接触位置/);
  assert.deepEqual(routeLostIntent.nativeOperation, pickupRequest);
  assert.equal(routeLostIntent.completionAction.dropId, pickupDrop.id);
  assert.equal(routeLostIntent.completionAction.quantity, 4);
  assert.equal(pickupDrop.quantity, 8);
  assert.deepEqual(picker.inventory, inventoryBeforeRouteLoss);
  const terrainState = api.createInitialState(17, { endpoint: { kind: 'months', value: 2 } });
  const terrainActor = terrainState.people[0];
  for (let x = 10; x <= 18; x += 1) for (let y = 10; y <= 15; y += 1) {
    for (let z = 0; z < terrainState.world.grid.levels; z += 1) api.setVoxel(terrainState.world.grid, x, y, z,
      z === 0 ? api.Material.Stone : api.Material.Air);
  }
  terrainActor.position = { ...terrainActor.position, cellId: api.cellId(12, 12), z: 1 };
  const terrainTarget = { kind: 'voxel', position: { x: 16, y: 12, z: 1 } };
  api.setVoxel(terrainState.world.grid, 16, 12, 1, api.Material.WetSoil);
  const terrainContext = () => ({ ...api.buildDecisionContexts(terrainState, 1).find((context) => context.person.id === terrainActor.id),
    options: [], followUpOptions: [] });
  const terrainRequest = { kind: 'transfer', source: terrainTarget,
    destination: { kind: 'person', personId: terrainActor.id }, materialId: api.Material.WetSoil, quantity: 3 };
  const terrainDecision = api.applyDecision(terrainState, terrainActor, terrainContext(), {
    kind: 'idle', reason: '松取点名的湿土', nativeOperation: terrainRequest, authoredAttempt: { kind: 'native' },
    mentalAct: { ...structuredClone(mind), goal: '取这处湿土' },
  }, true, 1, 1000, 1);
  assert(terrainDecision.intentId);
  const terrainIntent = terrainState.intents.find((intent) => intent.id === terrainDecision.intentId);
  assert.deepEqual(terrainIntent.completionAction.sourceVoxel, terrainTarget.position);
  const terrainFacts = [api.executeActiveIntent(terrainState, terrainActor, 1, 1001, 2)];
  assert.equal(terrainFacts[0].action.kind, 'move');
  assert.equal(terrainFacts[0].diff.quantity, undefined);
  assert.equal(api.voxelAt(terrainState.world.grid, 16, 12, 1), api.Material.WetSoil, 'approach cannot extract remotely');
  assert.equal(terrainActor.inventory.some((stack) => stack.materialId === api.Material.WetSoil), false);
  for (let tick = 3; terrainActor.activeIntentId && tick < 10; tick += 1) {
    const event = api.executeActiveIntent(terrainState, terrainActor, 1, 1000 + tick, tick);
    if (event) terrainFacts.push(event);
  }
  const terrainTaking = terrainFacts.filter((fact) => fact.action.kind === 'transfer');
  assert.equal(terrainTaking.length, 1);
  assert.equal(terrainTaking[0].status, 'completed', terrainTaking[0].result);
  assert.equal(terrainTaking[0].diff.quantity, 1, 'one voxel cannot supply three portions');
  assert.equal(terrainTaking[0].diff.requestedQuantity, 3);
  assert.deepEqual(terrainTaking[0].action.sourceVoxel, terrainTarget.position);
  assert.equal(api.voxelAt(terrainState.world.grid, 16, 12, 1), api.Material.Air);
  assert.equal(terrainActor.inventory.find((stack) => stack.materialId === api.Material.WetSoil).quantity, 1);
  assert.deepEqual(terrainTaking[0].diff.appliedEffects.map(({ kind, materialId, quantity }) => ({ kind, materialId, quantity })), [
    { kind: 'consume', materialId: api.Material.WetSoil, quantity: 1 },
    { kind: 'produce', materialId: api.Material.WetSoil, quantity: 1 },
  ]);
  const stoneRequest = { ...terrainRequest, quantity: 1, materialId: api.Material.Stone,
    source: { kind: 'voxel', position: { x: 16, y: 12, z: 0 } } };
  const stoneCompilation = api.compileNativeOperation(terrainContext(), stoneRequest, 'hard-stone-not-soft-terrain');
  assert(stoneCompilation.ok);
  const terrainInventoryBeforeStone = structuredClone(terrainActor.inventory);
  const stoneTaking = api.executePrimitiveAction(terrainState, terrainActor, stoneCompilation.option.completionAction,
    1, 1010, { cause: 'intent', actionTick: 10 });
  assert.equal(stoneTaking.status, 'blocked');
  assert.equal(stoneTaking.diff.quantity, undefined);
  assert.equal(api.voxelAt(terrainState.world.grid, 16, 12, 0), api.Material.Stone);
  assert.deepEqual(terrainActor.inventory, terrainInventoryBeforeStone);
  api.setVoxel(terrainState.world.grid, 15, 13, 1, api.Material.WetSoil);
  const missingDropTaking = api.executePrimitiveAction(terrainState, terrainActor, { kind: 'transfer', materialId: api.Material.WetSoil,
    quantity: 1, dropId: 'no-drop-here', from: { kind: 'ground', cellId: api.cellId(15, 13), z: 1 },
    to: { kind: 'person', personId: terrainActor.id } }, 1, 1011, { cause: 'intent', actionTick: 11 });
  assert.equal(missingDropTaking.status, 'blocked');
  assert.equal(missingDropTaking.diff.quantity, undefined);
  assert.equal(api.voxelAt(terrainState.world.grid, 15, 13, 1), api.Material.WetSoil, 'a missing Drop must never be reinterpreted as terrain');

  // Optional real regression input: replay the saved actor's exact selection
  // on an isolated copy, never rewrite the original experiment or its history.
  if (process.argv[2]) {
    const checkpointPath = path.resolve(process.argv[2]);
    const originalCheckpoint = readFileSync(checkpointPath, 'utf8');
    const replay = JSON.parse(originalCheckpoint);
    replay.world.grid.voxels = Uint16Array.from({ length: replay.world.grid.width * replay.world.grid.depth * replay.world.grid.levels },
      (_, index) => replay.world.grid.voxels[index] ?? 0);
    const nau = replay.people.find((candidate) => candidate.id === 'nausicaa');
    const originalAction = replay.world.past.filter((event) => event.kind === 'action' && event.who === nau.id
      && event.action.kind === 'transfer' && event.action.from.kind === 'ground'
      && event.action.from.cellId === 2285 && event.action.from.z === 4).at(-1);
    const originalDecision = replay.world.past.find((event) => event.id === originalAction.decisionSource.executionDecisionEventId);
    const operation = structuredClone(originalDecision.executionCompilation.operation);
    assert.deepEqual(operation.source, { kind: 'voxel', position: { x: 17, y: 27, z: 4 } });
    assert.equal(api.voxelAt(replay.world.grid, 17, 27, 4), api.Material.WetSoil);
    const foodBefore = nau.inventory.filter((stack) => stack.materialId === api.Material.Food).reduce((sum, stack) => sum + stack.quantity, 0);
    const compiled = api.compileNativeOperation({ state: replay, person: nau, options: [], followUpOptions: [], decisionMonth: 1 },
      operation, 'isolated-month-one-soft-terrain');
    assert(compiled.ok, JSON.stringify(compiled.problem));
    assert.equal(compiled.option.nextAction.kind, 'transfer');
    assert.deepEqual(compiled.option.nextAction.sourceVoxel, operation.source.position);
    const replayed = api.executePrimitiveAction(replay, nau, compiled.option.nextAction, 1, 9000,
      { cause: 'intent', actionTick: 15, intentId: originalAction.intentId });
    assert.equal(replayed.status, 'completed', replayed.result);
    assert.equal(replayed.diff.quantity, 1);
    assert.equal(api.voxelAt(replay.world.grid, 17, 27, 4), api.Material.Air);
    const soil = nau.inventory.find((stack) => stack.materialId === api.Material.WetSoil);
    assert.equal(soil.quantity, 1);
    assert(soil.sourceEventIds.includes(replayed.id));
    assert(soil.sourceLineageKeys.includes('voxel:17:27:4'));
    assert.equal(replayed.decisionSource.executionDecisionEventId, originalDecision.id);
    assert.equal(nau.inventory.filter((stack) => stack.materialId === api.Material.Food).reduce((sum, stack) => sum + stack.quantity, 0), foodBefore,
      'addressing an owned food stack as destination does not mix soil into food or consume the ration');
    assert.equal(nau.position.cellId, 2285);
    assert.equal(nau.position.z, 4);
    assert(api.isStandingPosition(replay.world.grid, nau.position));
    const landing = replayed.diff.supportSettlements.find((settlement) => settlement.personId === nau.id);
    assert.equal(landing.fallDistance, 1);
    assert.deepEqual(landing.sourceEventIds, [replayed.id]);
    const repeatedTaking = api.executePrimitiveAction(replay, nau, compiled.option.nextAction, 1, 9001,
      { cause: 'intent', actionTick: 15, intentId: originalAction.intentId });
    assert.equal(repeatedTaking.status, 'blocked');
    assert.equal(repeatedTaking.diff.quantity, undefined);
    assert.equal(soil.quantity, 1, 'the original emptied voxel cannot become another portion from a lower surface');
    assert.equal(readFileSync(checkpointPath, 'utf8'), originalCheckpoint);
    console.log(`isolated ${originalAction.id}: original ${originalDecision.id} → WetSoil1 in hand, voxel→Air, grounded z5→z4; original checkpoint unchanged`);
  }
  console.log('native semantics: actual material observation, exact pickup/terrain transfer, full project/record/measurement metadata and sourced feedback passed');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
