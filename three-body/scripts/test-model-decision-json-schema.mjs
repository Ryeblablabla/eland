import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-model-schema-'));
const bundlePath = path.join(temporaryDirectory, 'model-schema.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/model-decision-json-schema.ts',
    '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  const schemaModule = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const protocol = {
    requestContext: {
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

  const mindSchema = schemaModule.buildMindIntentionJsonSchema(protocol).schema;
  assert.equal('kind' in mindSchema.properties, false, 'Mind must only form intention content');
  assert.equal(mindSchema.required.includes('kind'), false, 'Mind must not choose an execution state');
  assert.equal('strategy' in mindSchema.properties, false, 'Mind must not produce a plan');
  assert.equal('firstStepHandle' in mindSchema.properties, false, 'Mind must not select an executable step');
  assert.equal('experiment' in mindSchema.properties, false, 'Mind must not translate its intention into an experiment');
  assert(mindSchema.required.includes('orientation'), 'Mind must classify its direction before Plan sees actions');
  assert(mindSchema.required.includes('horizon'), 'Mind must decide whether its goal is momentary or ongoing');

  const planSchema = schemaModule.buildModelPlanJsonSchema(protocol).schema;
  assert(planSchema.required.includes('steps'));
  assert(planSchema.required.includes('disposition'));
  assert.equal('maxItems' in planSchema.properties.steps, false, 'Plan must not impose an arbitrary step-count cap');
  assert.deepEqual(planSchema.properties.firstStepHandle.enum, ['o1', 'o2']);
  assert.deepEqual(planSchema.properties.disposition.enum, ['act', 'continue', 'pause', 'abandon', 'stay']);
  assert.equal(planSchema.properties.worldAction.additionalProperties, false);
  assert.equal('verdict' in planSchema.properties.worldAction.properties, false,
    'Plan may describe an action but must not author its own result');

  const semanticProtocol = {
    requestContext: {
      availableSteps: [{ handle: 'o1' }],
      continuations: [],
      actionSpace: {
        heldObjects: [{ ref: 'h1' }, { ref: 'h2' }],
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
  const stagedExperiments = stagedPlan.properties.experiment.oneOf;
  const stagedObserve = stagedExperiments.find((variant) => variant.properties.kind.enum.includes('observe'));
  assert.deepEqual(stagedObserve.properties.targetHandle.enum.sort(), ['d1', 'h1', 'h2', 'v1']);
  assert.deepEqual(stagedPlan.properties.worldAction.properties.targetHandles.items.enum.sort(),
    ['d1', 'h1', 'h2', 'self', 'v1'],
    'free-form actions must bind only to currently exposed world objects');
  const resolutionSchema = schemaModule.buildWorldResolutionJsonSchema(semanticProtocol).schema;
  assert.deepEqual(resolutionSchema.properties.status.enum, ['completed', 'blocked', 'failed']);
  const semanticMind = schemaModule.buildMindIntentionJsonSchema(semanticProtocol).schema;
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
  }).schema;
  assert.deepEqual(relationshipMind.properties.relationshipAppraisal.properties.otherPersonHandle.enum, ['p1']);
  assert.equal(relationshipMind.properties.relationshipAppraisal.properties.meanings.maxItems, 4,
    'subjective relationship meaning may be mixed without becoming an unbounded prose channel');
  console.log('model decision JSON Schema tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
