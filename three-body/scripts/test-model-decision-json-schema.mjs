import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-model-schema-'));
const bundlePath = path.join(temporaryDirectory, 'model-schema.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts', '--sourcefile=mind-schema-test.ts', `--outfile=${bundlePath}`,
  ], { stdio: 'pipe', input: `export * from './server/model-decision-json-schema';
    export { buildModelSchemaGuide, expandModelSchemaGuide } from './server/model-schema-guide';
    export { buildDecisionProbeHandleMap } from './src/game/eland/application/model-decision/capability-handles';
    export { projectNativeOperations, compileModelNativeOperation } from './src/game/eland/application/model-decision/native-operation-context';
    export { compileModelPlanCompletion, sanitizeBoundPlanCompletion, describeModelPlanCompletion } from './src/game/eland/application/model-decision/plan-completion';` });
  const schemaModule = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const protocol = {
    requestContext: {
      person: { id: 'person-1' },
      availableSteps: [
        { handle: 'o1' },
        { handle: 'o2', communicationKind: 'claim' },
      ],
      continuations: [],
    },
    handles: {
      held: [], visible: [], voxels: [], memories: [], agendas: [], groundingFacts: [],
    },
    characterAgendaProposal: false,
  };
  const built = schemaModule.buildMentalActJsonSchema(protocol);
  assert.equal(built.name, 'eland_mental_act_v2');
  const schema = built.schema;
  const variants = schema.oneOf;
  const talk = variants.find((variant) => variant.properties.kind.enum.includes('talk'));
  const wait = variants.find((variant) => variant.properties.kind.enum.includes('wait'));
  assert(talk.required.includes('utterance'));
  assert(talk.required.includes('delivery'));
  assert.deepEqual(talk.properties.delivery.enum, ['whisper', 'normal', 'call']);
  assert(wait.required.includes('utterance'));
  assert(wait.required.includes('delivery'));
  assert.deepEqual(wait.properties.delivery.enum, ['whisper', 'normal', 'call']);
  assert.equal('thoughtLine' in talk.properties, false);
  assert.equal('thoughtLine' in wait.properties, false);

  const builtMind = schemaModule.buildMindIntentionJsonSchema(protocol);
  assert.equal(builtMind.name, 'eland_mind_intention_v4');
  const completeMindSchema = builtMind.schema;
  const mindSchema = completeMindSchema.$defs.intentionChange;
  const validMind = new Ajv({ allErrors: true }).compile(completeMindSchema);
  assert.equal(completeMindSchema.type, 'object');
  assert.equal(completeMindSchema.additionalProperties, false);
  assert.equal(completeMindSchema.oneOf, undefined, 'the explicit current arrangement needs no speaking-required combination branches');
  assert.deepEqual(completeMindSchema.required, ['attempt']);
  assert.equal(completeMindSchema.dependencies, undefined);
  assert.deepEqual(Object.keys(completeMindSchema.properties), ['intentionChange', 'attempt', 'declaration']);
  assert.deepEqual(schemaModule.expandModelSchemaGuide(schemaModule.buildModelSchemaGuide(completeMindSchema)), completeMindSchema,
    'the Ollama reading guide preserves shared definitions and their root JSON pointers');
  assert.equal(validMind({}), false, 'fresh Mind must choose its current arrangement explicitly');
  assert.equal(validMind(null), false);
  assert.equal(validMind({ attention: 'keep-current' }), false, 'old provider wire is not the new production contract');
  const retainedDeclaration = { attempt: { kind: 'continue' }, declaration: {
    utterance: '我听见了，仍按原安排继续。', delivery: 'normal', speechIntent: { kind: 'expression' },
  } };
  assert(validMind(retainedDeclaration), 'new words require no new work goal');
  assert.equal(validMind({ declaration: {} }), false, 'an empty declaration is not silent retention');
  assert.equal(validMind({ ...retainedDeclaration, declaration: { ...retainedDeclaration.declaration, goal: '替换的目标' } }), false);
  const ordinaryMind = {
    intentionChange: { goal: '了解眼前的东西', orientation: 'inquiry', horizon: 'momentary' },
    attempt: { kind: 'creative', description: '看看自己现在的身体和手中物品' },
    declaration: { utterance: '我想看看眼前的东西。', delivery: 'normal', speechIntent: { kind: 'expression' } },
  };
  assert(validMind(ordinaryMind), 'an explicitly changed intention retains the full actor-owned choice');
  assert(validMind({ intentionChange: ordinaryMind.intentionChange, attempt: { kind: 'continue' } }),
    'a person can privately choose a new goal while keeping the current body arrangement');
  assert.equal(validMind({ intentionChange: { goal: 'incomplete goal fields' } }), false);
  assert.deepEqual(Object.keys(completeMindSchema.$defs), ['intentionChange', 'attempt', 'declaration']);
  assert.deepEqual(Object.keys(mindSchema.properties), ['goal', 'orientation', 'horizon']);
  const { attempt: _initialAttempt, ...missingAttempt } = ordinaryMind;
  assert.equal(validMind(missingAttempt), false, 'a new goal does not imply a current body arrangement');
  const { declaration: _newDeclaration, ...missingDeclaration } = ordinaryMind;
  assert(validMind(missingDeclaration), 'a new goal and actual attempt can both be silent');
  for (const delta of [{ attempt: { kind: 'continue' } }, retainedDeclaration, { attempt: ordinaryMind.attempt },
    { ...retainedDeclaration, attempt: ordinaryMind.attempt }, ordinaryMind, missingDeclaration]) {
    assert(validMind(delta), 'intention and speech remain independent of the explicit current arrangement');
  }
  for (const attempt of [ordinaryMind.attempt, { kind: 'continue' }, { kind: 'wait' }]) {
    assert(validMind({ attempt }), 'the actor can choose the next attempt without creating another goal');
    assert(validMind({ ...ordinaryMind, attempt }));
  }
  assert.equal(validMind({ attempt: { kind: 'native', nativeOperation: { kind: 'speech' } } }), false,
    'new words belong to declaration, not a second scheduled native speech');
  assert.equal(validMind({ attempt: { kind: 'native', nativeOperation: { kind: 'observe', targetHandle: 'self' } } }), false,
    'fresh Mind describes its activity without selecting engine operation parameters');
  assert.equal(validMind({ attempt: { kind: 'native', nativeOperation: { kind: 'observe', targetHandle: 'unseen-object' } } }), false);
  assert.equal(validMind({ attempt: { kind: 'creative', description: '' } }), false);
  assert.equal(validMind({ attempt: { ...ordinaryMind.attempt, nativeOperation: { kind: 'observe', targetHandle: 'self' } } }), false,
    'one selected activity cannot also carry an engine operation');
  assert.equal(validMind({ attempt: { kind: 'wait', description: '顺便做另一件事' } }), false);
  assert.equal(JSON.stringify(completeMindSchema.$defs.attempt).includes('nativeOperation'), false,
    'the fresh Mind schema must not embed the engine operation dictionary');
  for (const [field, value] of [['nextAttempt', '另写动作'], ['attemptMode', 'act'], ['attemptTargetHandles', ['self']]]) {
    assert.equal(validMind({ ...ordinaryMind, intentionChange: { ...ordinaryMind.intentionChange, [field]: value } }), false);
  }
  assert.equal(validMind({ ...retainedDeclaration, declaration: { ...retainedDeclaration.declaration, nextAttempt: '新增身体安排' } }), false);
  assert.equal(validMind({ ...ordinaryMind, declaration: { ...ordinaryMind.declaration, utterance: '' } }), false);
  for (const field of ['kind', 'strategy', 'firstStepHandle', 'experiment']) assert.equal(field in mindSchema.properties, false);
  assert(mindSchema.required.includes('orientation'));
  assert(mindSchema.required.includes('horizon'));

  const planSchema = schemaModule.buildModelPlanJsonSchema(protocol).schema;
  assert(planSchema.required.includes('steps'));
  assert(planSchema.required.includes('disposition'));
  assert.equal('maxItems' in planSchema.properties.steps, false, 'Plan must not impose an arbitrary step-count cap');
  assert.equal('firstStepHandle' in planSchema.properties, false);
  assert.equal('experiment' in planSchema.properties, false);
  assert.equal('continuationHandle' in planSchema.properties, false);
  assert.deepEqual(planSchema.properties.disposition.enum, ['act', 'continue', 'pause', 'abandon', 'stay']);
  const physicalStep = planSchema.properties.currentStep;
  assert.equal(physicalStep.additionalProperties, false);
  assert.equal('verdict' in physicalStep.properties, false,
    'Plan may describe an action but must not author its own result');

  const semanticProtocol = {
    requestContext: {
      person: { id: 'person-1' },
      availableSteps: [{ handle: 'o1' }],
      continuations: [],
      knownProjects: [{ ref: 'project1', desiredFunction: 'durable-record' }],
      actionSpace: {
        heldObjects: [{ ref: 'h1', materialKey: 'wood' }, { ref: 'h2' }],
      },
      visible: {
        nearbyObjects: [{ ref: 'd1' }],
        surfaces: [{ ref: 'v1' }],
      },
    },
    handles: {
      held: [{ handle: 'h1' }, { handle: 'h2' }, { handle: 'h-hidden' }],
      visible: [{ handle: 'd1' }, { handle: 'd-hidden' }],
      voxels: [{ handle: 'v1' }, { handle: 'v-hidden' }],
      memories: [], agendas: [], groundingFacts: [],
      nativeReferences: [{ handle: 'project1', kind: 'project', id: 'real-project' }, { handle: 'knowledge1', kind: 'knowledge', id: 'real-knowledge' }],
      speechReferences: [{ handle: 'project1', kind: 'project', id: 'real-project' }],
    },
    characterAgendaProposal: true,
  };
  const semanticSchema = schemaModule.buildMentalActJsonSchema(semanticProtocol).schema;
  const directional = semanticSchema.oneOf.find((variant) => variant.properties.kind.enum.includes('investigate'));
  const experiments = directional.properties.experiment.oneOf;
  const observe = experiments.find((variant) => variant.properties.kind.enum.includes('observe'));
  const combine = experiments.find((variant) => variant.properties.kind.enum.includes('combine'));
  const expose = experiments.find((variant) => variant.properties.kind.enum.includes('expose'));
  const move = experiments.find((variant) => variant.properties.kind.enum.includes('move'));
  assert.deepEqual(observe.properties.targetHandle.enum.sort(), ['d1', 'h1', 'h2', 'v1']);
  assert.deepEqual(combine.properties.stackHandles.items.enum.sort(), ['h1', 'h2']);
  assert.deepEqual(expose.properties.targetHandle.enum, ['v1']);
  assert.deepEqual(move.properties.targetHandle.enum, ['v1']);
  const stagedPlan = schemaModule.buildModelPlanJsonSchema(semanticProtocol).schema;
  const stagedPhysical = stagedPlan.properties.currentStep;
  assert.deepEqual(stagedPhysical.properties.targetHandles.items.enum.sort(),
    ['d1', 'h1', 'h2', 'self', 'v1'], 'the semantic step must use actual entity handles');
  assert.deepEqual(stagedPhysical.properties.projectHandle.enum, ['project1']);
  const entrySchema = schemaModule.buildModelPlanJsonSchema({
    ...semanticProtocol,
    requestContext: { ...semanticProtocol.requestContext, continuations: [{ handle: 'f1' }] },
    handles: { ...semanticProtocol.handles, suspendedIntents: [
      { handle: 's1', resumable: true }, { handle: 's2', resumable: false },
    ] },
  }).schema;
  const validPlan = new Ajv({ allErrors: true }).compile(entrySchema);
  const basePlan = {
    disposition: 'act', steps: ['当前一步'],
    completion: {
      step: { description: '当前一步的结果', conditions: [] },
      goal: { description: '人物目标的结果', conditions: [] },
    },
  };
  const entrances = [
    { currentStep: { kind: 'physical', description: '尝试新的做法', targetHandles: ['self'] } },
    { resumeIntentHandle: 's1' },
  ];
  for (const entrance of entrances) assert(validPlan({ ...basePlan, ...entrance }), JSON.stringify(validPlan.errors));
  const speechStep = { kind: 'speech', description: '说出本人的请求', targetHandles: ['self'] };
  assert.equal(validPlan({ ...basePlan, currentStep: speechStep }), false,
    'the declaration is already committed with the decision and must not be queued again as work');
  assert.equal(validPlan({ ...basePlan, currentStep: { description: '说出本人的请求', targetHandles: ['self'] } }), false,
    'Plan must select the current step semantic channel explicitly');
  assert.equal(validPlan({ ...basePlan, currentStep: { ...speechStep, projectHandle: 'project1' } }), false,
    'speech cannot acquire project execution parameters');
  const continuationPlan = new Ajv().compile(schemaModule.buildModelPlanJsonSchema({
    ...semanticProtocol, requestContext: { ...semanticProtocol.requestContext, current: { planContinuation: {} } },
  }).schema);
  assert.equal(continuationPlan({ ...basePlan, currentStep: speechStep }), false, 'a frozen continuation cannot choose a new speech step');
  assert(continuationPlan({ ...basePlan, ...entrances[0] }));
  assert.equal(validPlan({ ...basePlan, ...entrances[0], ...entrances[1] }), false,
    'act must describe one current step or resume an existing plan');
  assert.equal(validPlan({ ...basePlan, ...entrances[0], firstStepHandle: 'o1' }), false,
    'semantic Plan must not carry a conflicting numeric entry');
  assert.equal(validPlan(basePlan), false);
  for (const disposition of ['continue', 'pause', 'abandon', 'stay']) {
    assert(validPlan({ ...basePlan, disposition }));
    assert.equal(validPlan({ ...basePlan, disposition, ...entrances[0] }), false);
  }
  const socialProtocol = {
    ...semanticProtocol,
    requestContext: { ...semanticProtocol.requestContext,
      visible: { ...semanticProtocol.requestContext.visible, nearbyObjects: [{ ref: 'p1', kind: '人物' }] },
    },
    handles: { ...semanticProtocol.handles, actorId: 'person-1',
      visible: [{ handle: 'p1', kind: 'person', personId: 'person-2' }],
      speechReferences: [{ handle: 'agreement1', kind: 'agreement', id: 'real-agreement' }],
    },
  };
  const socialChecks = {
    step: { description: '对方明确给出了回应', conditions: [{ kind: 'agreement-response-recorded',
      agreementHandle: 'agreement1', personHandle: 'p1', response: 'accepted' }] },
    goal: { description: '约定现在有效', conditions: [{ kind: 'agreement-status', agreementHandle: 'agreement1', status: 'active' }] },
  };
  const validSocialPlan = new Ajv({ allErrors: true }).compile(schemaModule.buildModelPlanJsonSchema(socialProtocol).schema);
  assert(validSocialPlan({ ...basePlan, disposition: 'stay', completion: socialChecks }), JSON.stringify(validSocialPlan.errors));
  const socialContext = { person: { id: 'person-1' }, agreements: [{ id: 'real-agreement' }] };
  const boundChecks = schemaModule.compileModelPlanCompletion(socialChecks, socialContext, socialProtocol.handles);
  assert.deepEqual(boundChecks.step.conditions, [{ kind: 'fact', predicate: { kind: 'agreement-response-recorded',
    agreementId: 'real-agreement', personId: 'person-2', response: 'accepted' } }]);
  assert.deepEqual(boundChecks.goal.conditions, [{ kind: 'fact', predicate: { kind: 'agreement-status', agreementId: 'real-agreement', status: 'active' } }]);
  assert.deepEqual(schemaModule.sanitizeBoundPlanCompletion(boundChecks), boundChecks);
  const rebound = schemaModule.describeModelPlanCompletion(boundChecks, socialContext, socialProtocol.handles);
  assert.equal(rebound.step.conditions[0].personHandle, 'p1');
  assert.equal(rebound.goal.conditions[0].agreementHandle, 'agreement1');
  assert.equal(schemaModule.compileModelPlanCompletion({ ...socialChecks,
    goal: { ...socialChecks.goal, conditions: [{ ...socialChecks.goal.conditions[0], agreementHandle: 'invented-agreement' }] },
  }, socialContext, socialProtocol.handles), undefined, 'a plan cannot invent an agreement reference or another person response');

  const actorFocus = { mode: 'observe', targetHandles: ['h1'], hasExplicitFocus: true, unavailableTargetCount: 0 };
  const observeWorldPlan = new Ajv().compile(schemaModule.buildWorldPlanJsonSchema(semanticProtocol, actorFocus).schema);
  const focusedPlan = { ...basePlan, currentStep: { kind: 'physical', description: '查看手中对象', targetHandles: ['h1'] } };
  assert(observeWorldPlan({ plan: focusedPlan, resolution: { nativeOperation: { kind: 'observe', targetHandle: 'h1' } } }));
  assert(observeWorldPlan({ plan: focusedPlan, resolution: { nativeOperation: { kind: 'walk-to', targetHandle: 'h1' } } }));
  assert.equal(observeWorldPlan({ plan: focusedPlan, resolution: { nativeOperation: { kind: 'transfer', sourceHandle: 'h1', destinationHandle: 'self', quantity: 1 } } }), false);
  assert.equal(observeWorldPlan({ plan: focusedPlan, resolution: { effects: [], status: 'completed', result: '声称观察' } }), false);
  const waitWorldPlan = new Ajv().compile(schemaModule.buildWorldPlanJsonSchema(semanticProtocol, { ...actorFocus, mode: 'wait' }).schema);
  assert(waitWorldPlan({ plan: { ...basePlan, disposition: 'stay' } }));
  assert.equal(waitWorldPlan({ plan: focusedPlan, resolution: { nativeOperation: { kind: 'observe', targetHandle: 'self' } } }), false);
  const openFocus = new Ajv().compile(schemaModule.buildWorldPlanJsonSchema(semanticProtocol, {
    mode: 'act', targetHandles: [], hasExplicitFocus: false, unavailableTargetCount: 0,
  }).schema);
  assert(openFocus({ plan: { ...focusedPlan, currentStep: { ...focusedPlan.currentStep, targetHandles: ['d1'] } },
    resolution: { nativeOperation: { kind: 'observe', targetHandle: 'd1' } } }), 'an unselected focus stays open to actual visible objects and observation preparation');
  assert(validPlan({ ...basePlan, disposition: 'abandon', abandonIntentHandle: 's2' }));
  const combinedSchema = schemaModule.buildWorldPlanJsonSchema({ ...semanticProtocol,
    handles: { ...semanticProtocol.handles, suspendedIntents: [{ handle: 's1', resumable: true }] },
  });
  assert.equal(combinedSchema.name, 'eland_world_plan_v1');
  const validWorldPlan = new Ajv({ allErrors: true }).compile(combinedSchema.schema);
  const combinedPlan = { ...basePlan, ...entrances[0] };
  const combinedNative = { nativeOperation: { kind: 'observe', targetHandle: 'self' } };
  assert(validWorldPlan({ plan: combinedPlan, resolution: combinedNative }), JSON.stringify(validWorldPlan.errors));
  assert(validWorldPlan({ plan: combinedPlan, resolution: { effects: [], status: 'completed', result: '尝试后没有持久变化' } }),
    'the same WorldPlan contract retains open effects');
  assert.equal(validWorldPlan({ plan: combinedPlan }), false, 'a current physical step needs its execution proposal');
  assert.equal(validWorldPlan({ plan: combinedPlan, resolution: { ...combinedNative, effects: [], status: 'completed', result: '冲突入口' } }), false);
  assert(validWorldPlan({ plan: { ...basePlan, resumeIntentHandle: 's1' } }), 'resuming existing work needs no invented resolution');
  for (const disposition of ['continue', 'pause', 'abandon', 'stay']) {
    assert(validWorldPlan({ plan: { ...basePlan, disposition } }), JSON.stringify(validWorldPlan.errors));
    assert.equal(validWorldPlan({ plan: { ...basePlan, disposition }, resolution: combinedNative }), false);
  }
  const validBatch = new Ajv().compile(schemaModule.buildModelPlanBatchJsonSchema([protocol, semanticProtocol]).schema);
  assert(validBatch({ items: [
    { agentHandle: 'a1', value: { ...basePlan, ...entrances[0] } },
    { agentHandle: 'a2', value: { ...basePlan, currentStep: { kind: 'physical', description: '查看物品', targetHandles: ['d1'] } } },
  ] }), 'embedded currentStep references must resolve in each actor schema');
  assert.equal(validBatch({ items: [
    { agentHandle: 'a1', value: { ...basePlan, currentStep: { kind: 'physical', description: '查看物品', targetHandles: ['d1'] } } },
    { agentHandle: 'a2', value: { ...basePlan, ...entrances[0] } },
  ] }), false, "a batch cannot borrow another actor's visible objects");
  const resolutionSchema = schemaModule.buildWorldResolutionJsonSchema(semanticProtocol).schema;
  const nativeSchema = resolutionSchema.oneOf.find((variant) => variant.properties.nativeOperation);
  assert.equal(Object.keys(nativeSchema.properties)[0], 'completionReview');
  assert.equal(nativeSchema.required.includes('completionReview'), false, 'review remains optional and never blocks native compilation');
  const effectSchema = resolutionSchema.oneOf.find((variant) => variant.properties.effects);
  assert.deepEqual(effectSchema.properties.status.enum, ['completed', 'blocked', 'failed']);
  const validWorld = new Ajv().compile(resolutionSchema);
  assert.equal(validWorld({ nativeOperation: { kind: 'project', desiredFunction: 'durable-record' } }), false,
    'a function name must not start a rule-planner project template');
  assert.equal(validWorld({ nativeOperation: { kind: 'project' } }), false,
    'continuing a project requires its actual reference');
  const noKnownProjectWorld = new Ajv().compile(schemaModule.buildWorldResolutionJsonSchema({ ...semanticProtocol,
    requestContext: { ...semanticProtocol.requestContext, knownProjects: [] },
  }).schema);
  assert.equal(noKnownProjectWorld({ nativeOperation: { kind: 'project', projectHandle: 'project1' } }), false);
  assert(noKnownProjectWorld({ nativeOperation: { kind: 'observe', targetHandle: 'd1' } }));
  assert(noKnownProjectWorld({ effects: [], status: 'blocked', result: '尚无实际变化' }),
    'open physical compilation does not require a named project template');
  const speechWorldSchema = schemaModule.buildWorldResolutionJsonSchema(semanticProtocol, { kind: 'speech', targetHandles: ['self'] }).schema;
  const speechWorld = new Ajv().compile(speechWorldSchema);
  assert(speechWorld({ nativeOperation: { kind: 'speech' } }));
  assert.equal(speechWorld({ nativeOperation: { kind: 'transfer', sourceHandle: 'd1', destinationHandle: 'self', quantity: 1 } }), false,
    'World cannot turn the selected speech step into taking an object');
  assert.equal(speechWorld({ effects: [], status: 'completed', result: '物品已转移' }), false,
    'the speech channel must not provide open physical effects');
  const physicalWorld = new Ajv().compile(schemaModule.buildWorldResolutionJsonSchema(semanticProtocol, {
    kind: 'physical', targetHandles: ['h1', 'h2', 'd1', 'v1'],
  }).schema);
  assert.equal(physicalWorld({ nativeOperation: { kind: 'speech' } }), false);
  for (const nativeOperation of [
    { kind: 'approach', targetHandle: 'v1' },
    { kind: 'walk-to', targetHandle: 'v1', withinDistance: 1 },
    { kind: 'observe', targetHandle: 'd1' },
    { kind: 'transfer', sourceHandle: 'd1', destinationHandle: 'self', quantity: 12 },
    { kind: 'act', operation: 'dehydrate', targetHandles: ['self'] },
    { kind: 'inscribe', carrierHandle: 'h1', knowledgeHandle: 'knowledge1' },
    { kind: 'project', projectHandle: 'project1' },
    { kind: 'speech' },
  ]) {
    assert(validWorld({ nativeOperation }), 'native operation remains expressible: ' + JSON.stringify(validWorld.errors));
    if (nativeOperation.kind !== 'speech') assert(physicalWorld({ nativeOperation }), 'the physical channel must retain its existing native capabilities');
  }
  assert.equal(validWorld({ nativeOperation: { kind: 'move', targetHandle: 'v1', withinDistance: 1 } }), false,
    'production World uses walk-to to distinguish actor movement from moving material');
  assert.equal(validWorld({ nativeOperation: { kind: 'approach', targetHandle: 'v1', withinDistance: 0 } }), false,
    'approaching is contact intent, not a request to occupy the object center');
  assert.deepEqual(schemaModule.compileModelNativeOperation({ kind: 'approach', targetHandle: 'v1' }, semanticProtocol.requestContext,
    { ...semanticProtocol.handles, voxels: [{ handle: 'v1', position: { x: 2, y: 3, z: 1 } }] }), {
    kind: 'move', target: { kind: 'voxel', position: { x: 2, y: 3, z: 1 } }, withinDistance: 1,
  });
  assert(validWorld({ effects: [], status: 'completed', result: '没有物理变化' }), 'free effects remain a separate valid path');
  assert(physicalWorld({ effects: [], status: 'completed', result: '没有物理变化' }));
  const completionReview = {
    step: { sufficiency: 'unverified', reason: '当前步骤没有可核验条件' },
    goal: { sufficiency: 'insufficient', reason: '即使到场，整体结果也可能尚未发生' },
  };
  assert(speechWorld({ nativeOperation: { kind: 'speech' }, completionReview }));
  assert.equal(speechWorldSchema.required.includes('completionReview'), false);
  assert(validWorld({ nativeOperation: { kind: 'observe', targetHandle: 'd1' }, completionReview }),
    'an insufficient completion criterion must not forbid a native action');
  assert(validWorld({ effects: [], status: 'completed', result: '没有物理变化', completionReview }),
    'the same independent criterion review is available to the open effects branch');
  assert.equal(validPlan({ ...basePlan, ...entrances[0], completion: {
    ...basePlan.completion, goal: { ...basePlan.completion.goal, meaningReview: completionReview.goal },
  } }), false, 'Plan cannot certify its own criteria through a reviewer-owned field');
  assert.equal(validWorld({ nativeOperation: { kind: 'speech' }, effects: [], status: 'completed', result: '同意了' }), false,
    'native execution must not coexist with an invented effects verdict');
  for (const [field, nativeOperation] of [
    ['containerHandle', { kind: 'transfer', sourceHandle: 'v1', destinationHandle: 'self', quantity: 1, containerHandle: 'h1' }],
    ['toolHandle', { kind: 'act', operation: 'combine', targetHandles: ['h1', 'h2'], toolHandle: 'h1' }],
    ['carrierHandle', { kind: 'inscribe', carrierHandle: 'h1', knowledgeHandle: 'knowledge1' }],
  ]) {
    assert(validWorld({ nativeOperation }), 'a named, held object remains usable for ' + field);
    assert.equal(validWorld({ nativeOperation: { ...nativeOperation, [field]: 'self' } }), false,
      'the actor body cannot stand in for a carried tool, instrument, container or record carrier');
  }
  const roleProtocol = { ...semanticProtocol, requestContext: { ...semanticProtocol.requestContext,
    visible: { ...semanticProtocol.requestContext.visible,
      nearbyObjects: [...semanticProtocol.requestContext.visible.nearbyObjects, { ref: 'p1' }] } },
    handles: { ...semanticProtocol.handles, actorId: 'person-1', visible: [...semanticProtocol.handles.visible,
      { handle: 'p1', kind: 'person', personId: 'person-2' },
      { handle: 'i1', kind: 'inventory-stack', personId: 'person-2', stackId: 'foreign-stack' }] } };
  const roleTargets = ['self', 'h1', 'h2', 'v1', 'p1', 'i1'];
  const validRoles = new Ajv().compile(schemaModule.buildWorldResolutionJsonSchema(roleProtocol, { targetHandles: roleTargets }).schema);
  for (const parameters of [
    { operation: 'combine', targetHandles: ['h1', 'h1'] },
    { operation: 'combine', targetHandles: ['h1', 'v1'] },
    { operation: 'combine', targetHandles: ['h1', 'self'] },
    { operation: 'combine', targetHandles: ['h1', 'p1'] },
    { operation: 'expose', targetHandles: ['h1', 'v1'] },
    { operation: 'reproduce', targetHandles: ['p1'] },
  ]) assert(validRoles({ nativeOperation: { kind: 'act', ...parameters } }), JSON.stringify(validRoles.errors));
  const namedActs = [
    { kind: 'strike-person', personHandle: 'p1' },
    { kind: 'bend-held-material', materialHandle: 'h1' },
    { kind: 'work-material-with-tool', toolHandle: 'h2', surfaceHandle: 'v1', inputHandle: 'h1' },
    { kind: 'work-material-with-tool', toolHandle: 'h2', surfaceHandle: 'v1' },
    { kind: 'separate-terrain', surfaceHandle: 'v1', toolHandle: 'h2' },
    { kind: 'release-restraint', personHandle: 'self' },
  ];
  const namedHandles = { ...roleProtocol.handles, held: [{ handle: 'h1', stackId: 'material-one' }, { handle: 'h2', stackId: 'tool-two' }],
    voxels: [{ handle: 'v1', position: { x: 2, y: 3, z: 1 } }] };
  for (const nativeOperation of namedActs) {
    assert(validRoles({ nativeOperation }), JSON.stringify(validRoles.errors));
    const bound = schemaModule.compileModelNativeOperation(nativeOperation, roleProtocol.requestContext, namedHandles);
    assert(bound?.kind === 'act');
    assert.equal(bound.operation, ['strike-person', 'bend-held-material', 'work-material-with-tool'].includes(nativeOperation.kind) ? 'exert' : 'separate');
    const projectedAct = schemaModule.projectNativeOperations({ person: { id: 'person-1' }, nativeOperations: [{ request: bound,
      summary: '当前动作', reason: '本人选择', sourceEventIds: [] }] }, namedHandles)[0];
    assert.deepEqual(projectedAct.request, nativeOperation, 'named roles round-trip through the unchanged domain action');
  }
  for (const nativeOperation of [
    { kind: 'strike-person', personHandle: 'self' },
    { kind: 'strike-person', personHandle: 'p1', toolHandle: 'h1' },
    { kind: 'bend-held-material', materialHandle: 'p1' },
    { kind: 'work-material-with-tool', toolHandle: 'h2', surfaceHandle: 'v1', inputHandle: 'p1' },
    { kind: 'release-restraint', personHandle: 'v1' },
    { kind: 'act', operation: 'exert', targetHandles: ['p1'] },
    { kind: 'act', operation: 'separate', targetHandles: ['v1'] },
  ]) {
    assert.equal(validRoles({ nativeOperation }), false);
    assert.equal(schemaModule.compileModelNativeOperation(nativeOperation, roleProtocol.requestContext, namedHandles), undefined);
  }
  assert.equal(schemaModule.compileModelNativeOperation({ kind: 'strike-person', personHandle: 'p1' },
    roleProtocol.requestContext, namedHandles, ['h1']), undefined, 'named roles still respect the selected-object scope');
  for (const parameters of [
    { operation: 'combine', targetHandles: ['self', 'self'] },
    { operation: 'combine', targetHandles: ['h1'] },
    { operation: 'combine', targetHandles: ['h1', 'i1'] },
    { operation: 'exert', targetHandles: ['self'] },
    { operation: 'exert', targetHandles: ['v1'] },
    { operation: 'separate', targetHandles: ['h1'] },
    { operation: 'expose', targetHandles: ['self', 'v1'] },
    { operation: 'reproduce', targetHandles: ['self'] },
  ]) assert.equal(validRoles({ nativeOperation: { kind: 'act', ...parameters } }), false, JSON.stringify(parameters));
  const methodHeld = { kind: 'inventory-stack', personId: 'person-1', stackId: 'held-one' };
  const methodSite = { kind: 'voxel', position: { x: 1, y: 1, z: 1 } };
  const sourcedProtocol = { ...roleProtocol, handles: { ...roleProtocol.handles, actorId: 'person-1',
    held: [{ handle: 'h1', stackId: 'held-one' }, { handle: 'h2', stackId: 'held-two' }],
    voxels: [{ handle: 'v1', position: methodSite.position }], nativeMethods: [{ handle: 'method_machine', request: {
      kind: 'act', operation: 'exert', targets: [methodHeld, methodSite], references: { projectId: 'real-project' }, methodKey: 'server-machine',
    } }] } };
  const sourcedExert = new Ajv().compile(schemaModule.buildWorldResolutionJsonSchema(sourcedProtocol, { targetHandles: roleTargets }).schema);
  assert(sourcedExert({ nativeOperation: { kind: 'use-method', methodHandle: 'method_machine' } }),
    'the real tool-free mechanical process is selected by exact method identity');
  assert.equal(sourcedExert({ nativeOperation: { kind: 'act', operation: 'exert', targetHandles: ['h1', 'v1'] } }), false,
    'a bare operation does not silently acquire the complete method');
  assert.equal(sourcedExert({ nativeOperation: { kind: 'act', operation: 'exert', targetHandles: ['v1'] } }), false,
    'the sourced exception does not make every tool-free exertion expressible as a native capability');
  assert.equal(validWorld({ nativeOperation: { kind: 'observe', targetHandle: 'h1', instrumentHandle: 'h1' } }), false,
    'a held food/material handle is not an instrument without a callable measurement descriptor');
  const measuringProtocol = { ...sourcedProtocol, handles: { ...sourcedProtocol.handles, nativeMethods: [{ handle: 'method_measure', request: {
    kind: 'observe', target: methodHeld, instrument: { kind: 'inventory-stack', personId: 'person-1', stackId: 'held-two' },
    references: { sourceEventIds: ['actual-calibration'] }, methodKey: 'server-measurement',
  } }] } };
  const measuringSchema = new Ajv().compile(schemaModule.buildWorldResolutionJsonSchema(measuringProtocol, { targetHandles: ['h1', 'h2', 'v1'] }).schema);
  assert(measuringSchema({ nativeOperation: { kind: 'use-method', methodHandle: 'method_measure' } }));
  assert.equal(measuringSchema({ nativeOperation: { kind: 'observe', targetHandle: 'h1', instrumentHandle: 'h2' } }), false);
  assert(measuringSchema({ nativeOperation: { kind: 'observe', targetHandle: 'h1' } }), 'naked observation remains available separately');
  assert.equal(measuringSchema({ nativeOperation: { kind: 'observe', targetHandle: 'v1', instrumentHandle: 'h2' } }), false,
    'a real instrument does not imply a measurement basis for every target');
  assert.equal(measuringSchema({ nativeOperation: { kind: 'use-method', methodHandle: 'method_unknown' } }), false);
  assert.equal(measuringSchema({ nativeOperation: { kind: 'use-method', methodHandle: 'method_measure', targetHandle: 'v1' } }), false);
  assert(measuringSchema({ nativeOperation: { kind: 'observe', targetHandle: 'h1', backgroundReferences: { knowledgeHandle: 'knowledge1' } } }));
  assert.equal(measuringSchema({ nativeOperation: { kind: 'observe', targetHandle: 'h1', executionBasis: { knowledgeHandle: 'knowledge1' } } }), false);
  const otherPersonMethodProtocol = { ...sourcedProtocol, handles: { ...sourcedProtocol.handles, nativeMethods: [{
    handle: 'method_other_person', request: { kind: 'observe', target: { kind: 'person', personId: 'person-2' },
      references: { knowledgeId: 'real-knowledge' }, methodKey: 'server-other-person' },
  }] } };
  const outsideMethodScope = new Ajv().compile(schemaModule.buildWorldResolutionJsonSchema(otherPersonMethodProtocol, { targetHandles: ['h1'] }).schema);
  assert.equal(outsideMethodScope({ nativeOperation: { kind: 'use-method', methodHandle: 'method_other_person' } }), false,
    'a method cannot import an unrelated person outside the step');
  assert.equal(schemaModule.compileModelNativeOperation({ kind: 'use-method', methodHandle: 'method_other_person' },
    otherPersonMethodProtocol.requestContext, otherPersonMethodProtocol.handles, ['h1']), undefined);
  const rawMethod = { request: measuringProtocol.handles.nativeMethods[0].request, requiresMethod: true,
    methodKey: 'server-measurement', summary: '实际校准测量', reason: '已建立的测量过程', sourceEventIds: ['actual-calibration'] };
  const ordinarySource = { request: { kind: 'observe', target: methodHeld, references: { sourceEventIds: ['shared-observation'] } },
    summary: '看这份持物', reason: '本人可见', sourceEventIds: ['shared-observation'] };
  const methodContext = { person: { id: 'person-1', inventory: [{ stackId: 'held-one' }, { stackId: 'held-two' }], knowledge: [], memories: [] },
    options: [], followUpOptions: [], agreements: [], permissions: [], collectives: [], suspendedIntents: [],
    visiblePeople: [], visibleDrops: [], visibleAnimals: [], visibleContainers: [], nativeOperations: [rawMethod, ordinarySource] };
  const methodHandles = schemaModule.buildDecisionProbeHandleMap(methodContext);
  assert.equal(methodHandles.nativeMethods.length, 1, 'source-only ordinary observations are not promoted to complete methods');
  assert.match(methodHandles.nativeMethods[0].handle, /^method_[a-z0-9]+$/);
  assert(methodHandles.nativeMethods[0].handle.length <= 24);
  const reorderedHandles = schemaModule.buildDecisionProbeHandleMap(JSON.parse(JSON.stringify({ ...methodContext,
    nativeOperations: [...methodContext.nativeOperations].reverse() })));
  assert.deepEqual(reorderedHandles.nativeMethods, methodHandles.nativeMethods, 'method identity survives ordering and reload');
  const methodWire = schemaModule.projectNativeOperations(methodContext, methodHandles).find((item) => item.methodHandle);
  assert.equal(methodWire.request.kind, 'use-method');
  assert.equal(methodWire.methodParameters.executionBasis, undefined);
  assert.deepEqual(schemaModule.compileModelNativeOperation(methodWire.request, methodContext, methodHandles), rawMethod.request,
    'one handle returns all frozen method parameters, goal and references without reconstruction');
  assert.equal(schemaModule.compileModelNativeOperation({ kind: 'observe', targetHandle: methodHandles.held[0].handle,
    executionBasis: { sourceHandles: ['anything'] } }, methodContext, methodHandles), undefined);
  const assemblingProtocol = { ...semanticProtocol,
    requestContext: { ...semanticProtocol.requestContext,
      actionSpace: { operations: [], heldObjects: [{ ref: 'h1', materialKey: 'wet_soil' }] },
      visible: { nearbyObjects: [{ ref: 'w1', kind: '造物' }], surfaces: [{ ref: 'v1' }] },
    },
    handles: { ...semanticProtocol.handles, actorId: 'person-1', held: [{ handle: 'h1', stackId: 'actual-wet-soil' }],
      visible: [{ handle: 'w1', kind: 'work', workId: 'actual-work' }],
      voxels: [{ handle: 'v1', position: { x: 2, y: 3, z: 1 } }] },
  };
  const validAssembly = new Ajv().compile(schemaModule.buildWorldResolutionJsonSchema(assemblingProtocol).schema);
  const assembly = { kind: 'assemble', targetHandle: 'v1', inputs: [{ targetHandle: 'h1', quantity: 1 }],
    arrangement: 'pile', layout: [{ offset: { x: 0, y: 0, z: 0 }, materialKey: 'wet_soil' }] };
  assert(validAssembly({ nativeOperation: assembly }), 'solid WetSoil can be explicitly arranged without a name or facility template');
  const boundAssembly = schemaModule.compileModelNativeOperation(assembly, assemblingProtocol.requestContext, assemblingProtocol.handles);
  assert.equal(boundAssembly.inputs[0].target.stackId, 'actual-wet-soil');
  assert.equal(boundAssembly.layout.voxels[0].materialId, 3);
  assert.equal(boundAssembly.summary, undefined);
  const rearrangement = { kind: 'assemble', targetHandle: 'w1', inputs: [], layout: assembly.layout };
  assert(validAssembly({ nativeOperation: rearrangement }));
  assert.equal(schemaModule.compileModelNativeOperation(rearrangement, assemblingProtocol.requestContext,
    assemblingProtocol.handles).target.workId, 'actual-work');
  assert(validAssembly({ nativeOperation: { kind: 'dismantle-work', workHandle: 'w1' } }));
  assert.equal(schemaModule.compileModelNativeOperation({ kind: 'dismantle-work', workHandle: 'w1' },
    assemblingProtocol.requestContext, assemblingProtocol.handles).targets[0].kind, 'work');
  const toolMethodRequest = { kind: 'act', operation: 'separate', targets: [{ kind: 'work', workId: 'actual-work' }],
    tool: { kind: 'inventory-stack', personId: 'person-1', stackId: 'actual-wet-soil' }, methodKey: 'complete-work-method' };
  const toolMethodView = schemaModule.projectNativeOperations({ person: { id: 'person-1' }, nativeOperations: [{ request: toolMethodRequest,
    summary: '完整拆取方法', reason: '真实额外参数', sourceEventIds: [] }] }, { ...assemblingProtocol.handles,
    nativeMethods: [{ handle: 'method_with_tool', request: toolMethodRequest }] })[0];
  assert.equal(toolMethodView.request.kind, 'use-method');
  assert.equal(toolMethodView.methodParameters.kind, 'method-dismantling');
  assert.equal(toolMethodView.methodParameters.toolHandle, 'h1', 'read-only complete method metadata must not discard a real tool');
  assert.equal(toolMethodView.methodParameters.subjects[0].handle, 'w1');
  assert.equal(validAssembly({ nativeOperation: { ...assembly, inputs: [] } }), false,
    'a new structure needs actual inputs while rearranging an existing one can retain its material');
  assert.equal(schemaModule.compileModelNativeOperation({ ...assembly, inputs: [{ targetHandle: 'w1', quantity: 1 }] },
    assemblingProtocol.requestContext, assemblingProtocol.handles), undefined, 'assembly consumes specified held inputs, not an unselected work');
  const positionedProtocol = { ...roleProtocol,
    targetContext: { person: { id: 'person-1', position: { cellId: 12 + 12 * 84, z: 1 } },
      visiblePeople: [{ id: 'person-2', cellId: 13 + 12 * 84, z: 1 }] },
    handles: { ...roleProtocol.handles, voxels: [...roleProtocol.handles.voxels.map((voxel, index) => ({ ...voxel, position: { x: 10 + index, y: 12, z: 0 } })),
      { handle: 'v-person', position: { x: 13, y: 12, z: 1 } }] } };
  const entityMovement = new Ajv().compile(schemaModule.buildWorldResolutionJsonSchema(positionedProtocol, { targetHandles: ['p1'] }).schema);
  assert(entityMovement({ nativeOperation: { kind: 'walk-to', targetHandle: 'p1', withinDistance: 0 } }));
  assert.equal(entityMovement({ nativeOperation: { kind: 'walk-to', targetHandle: 'v-person', withinDistance: 0 } }), false,
    'a derived position cannot erase the selected moving entity\'s identity');
  assert(entityMovement({ effects: [{ kind: 'assemble', targetHandle: 'v-person', arrangement: 'pile', summary: '在公开锚点堆叠' }],
    status: 'completed', result: '尝试构造' }), 'the same derived voxel remains expressible as a placement anchor');
  const exactMovement = new Ajv().compile(schemaModule.buildWorldResolutionJsonSchema(positionedProtocol, { targetHandles: ['p1', 'v-person'] }).schema);
  assert(exactMovement({ nativeOperation: { kind: 'walk-to', targetHandle: 'v-person', withinDistance: 0 } }),
    'an explicitly selected voxel retains its exact-position meaning');
  const onlySurface = new Ajv().compile(schemaModule.buildWorldResolutionJsonSchema(semanticProtocol, { targetHandles: ['v1'] }).schema);
  assert(onlySurface({ nativeOperation: { kind: 'observe', targetHandle: 'v1' } }),
    'ordinary observation needs no invented instrument');
  assert.equal(onlySurface({ nativeOperation: { kind: 'observe', targetHandle: 'v1', instrumentHandle: 'h1' } }), false,
    'an ordinary held object is not an instrument without its real measurement binding');
  const implementationProtocol = { ...semanticProtocol,
    requestContext: { ...semanticProtocol.requestContext,
      actionSpace: { ...semanticProtocol.requestContext.actionSpace,
        heldObjects: [...semanticProtocol.requestContext.actionSpace.heldObjects, { ref: 'h3', materialKey: 'iron-ore' }] },
      visible: { ...semanticProtocol.requestContext.visible,
        surfaces: [...semanticProtocol.requestContext.visible.surfaces, { ref: 'v-adjacent' }] },
    }, handles: { ...semanticProtocol.handles,
      held: [...semanticProtocol.handles.held, { handle: 'h3', stackId: 'third-actual-item' }],
      voxels: [...semanticProtocol.handles.voxels, { handle: 'v-adjacent', position: { x: 1, y: 0, z: 1 } }],
    } };
  const implementationWorld = new Ajv().compile(schemaModule.buildWorldResolutionJsonSchema(implementationProtocol,
    { kind: 'physical', targetHandles: ['self'] }).schema);
  assert(implementationWorld({ status: 'completed', result: '尝试构造', effects: [
    { kind: 'consume', targetHandle: 'h3', quantity: 1 },
    { kind: 'assemble', targetHandle: 'v-adjacent', arrangement: 'pile', summary: '试制物' },
  ] }), 'World may explicitly choose held inputs and a separately displayed placement');
  assert.equal(implementationWorld({ status: 'completed', result: '尝试构造', effects: [
    { kind: 'assemble', targetHandle: 'v-hidden', arrangement: 'pile', summary: '未展示位置' },
  ] }), false, 'a server map entry not exposed to World is not a placement candidate');
  assert.equal(implementationWorld({ status: 'completed', result: '尝试取材', effects: [
    { kind: 'consume', targetHandle: 'h-hidden', quantity: 1 },
  ] }), false, 'unexposed inventory entries are not silently introduced');
  assert.equal(implementationWorld({ nativeOperation: { kind: 'walk-to', targetHandle: 'v-adjacent' } }), false);
  assert.equal(implementationWorld({ nativeOperation: { kind: 'walk-to', targetHandle: 'h3' } }), false);
  const semanticMind = schemaModule.buildMindIntentionJsonSchema(semanticProtocol).schema.$defs.intentionChange;
  assert.equal('concern' in semanticMind.properties, false,
    'Mind must not manage concern lifecycle state');
  const relationshipMind = schemaModule.buildMindIntentionJsonSchema({
    ...semanticProtocol,
    requestContext: {
      ...semanticProtocol.requestContext,
      visible: {
        ...semanticProtocol.requestContext.visible,
        nearbyObjects: [{ ref: 'p1', kind: '人物' }],
      },
    },
    handles: {
      ...semanticProtocol.handles,
      visible: [{ handle: 'p1', kind: 'person', personId: 'person-2' }],
      memories: [{ handle: 'm1', itemId: 'memory-1', sourceFactIds: ['fact-1'], personIds: ['person-2'] }],
    },
  }).schema.$defs.declaration;
  assert.deepEqual(relationshipMind.properties.relationshipAppraisal.properties.otherPersonHandle.enum, ['p1']);
  assert.equal(relationshipMind.properties.relationshipAppraisal.properties.meanings.maxItems, 4,
    'subjective relationship meaning may be mixed without becoming an unbounded prose channel');
  const jointMindSchema = schemaModule.buildMindIntentionJsonSchema({ ...semanticProtocol, handles: {
    ...semanticProtocol.handles, visible: [{ handle: 'p1', kind: 'person', personId: 'one' }, { handle: 'p2', kind: 'person', personId: 'two' }],
  } }).schema;
  const validJointMind = new Ajv().compile(jointMindSchema);
  const jointMind = { ...ordinaryMind, declaration: { ...ordinaryMind.declaration, speechIntent: {
    kind: 'proposal', proposalKind: 'joint-action', counterpartHandles: ['p1', 'p2'],
  } } };
  assert(validJointMind(jointMind), 'a concrete joint invitation needs no assistance category, duplicate commitment or default deadline');
  assert.equal(validJointMind({ ...jointMind, declaration: { ...jointMind.declaration, speechIntent: { ...jointMind.declaration.speechIntent, terms: { need: 'company' } } } }), false,
    'joint action must not silently become a company-assistance contract');
  console.log('model decision JSON Schema tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
