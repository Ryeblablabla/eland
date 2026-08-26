import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-option-semantics-test-'));
const bundlePath = path.join(temporaryDirectory, 'action-option-semantics.mjs');

try {
  const entry = `
    export {
      actionOptionSemantics,
      assertClassifiedActionOption,
      classifyActionOption,
      defineActionOptionSemantics,
      inferActionOptionSemantics,
      validateActionOptionSemantics,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/action-option-semantics.ts'))};
    export { optionAllowedForLifeStage } from ${JSON.stringify(path.resolve('src/game/eland/application/age-planning.ts'))};
    export { isFulfillmentOption, isRequiredSocialOption } from ${JSON.stringify(path.resolve('src/game/eland/application/rule-planner.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=action-option-semantics-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    assertClassifiedActionOption,
    classifyActionOption,
    defineActionOptionSemantics,
    isFulfillmentOption,
    isRequiredSocialOption,
    optionAllowedForLifeStage,
    validateActionOptionSemantics,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const ordinary = {
    summary: '取得眼前物质', reason: '当前可见',
    goal: { kind: 'inventory-at-least', materialId: 2, quantity: 1 },
    nextAction: { kind: 'transfer', materialId: 2, quantity: 1, from: { kind: 'ground', cellId: 3 }, to: { kind: 'person', personId: 'p1' } },
    estimatedDuration: 'one-month', sourceFactIds: [],
  };
  const first = classifyActionOption({ id: 'collect:readable-route', ...ordinary });
  const renamed = classifyActionOption({ id: 'opaque-7f4c', ...ordinary });
  assert.deepEqual(first.semantics, renamed.semantics,
    'changing only the option id must not change planner semantics');
  assert.equal(optionAllowedForLifeStage('learning-child', first), optionAllowedForLifeStage('learning-child', renamed));
  assert.equal(isRequiredSocialOption(first), isRequiredSocialOption(renamed));
  assert.equal(isFulfillmentOption(first), isFulfillmentOption(renamed));

  const requiredPayload = {
    summary: '回应请求', reason: '需要明确回应',
    goal: { kind: 'representation-made', representationId: 'reply-1' },
    nextAction: { kind: 'move', toCellId: 9 },
    completionAction: {
      kind: 'communicate', content: { id: 'reply-1', kind: 'accept', referenceId: 'proposal-1' },
      audience: ['p2'], channel: 'voice',
    },
    target: { kind: 'person', personId: 'p2' },
    estimatedDuration: 'several-months', sourceFactIds: ['proposal-event'], domain: 'social',
  };
  const requiredReadable = classifyActionOption({ id: 'accept-assist:proposal-1', ...requiredPayload });
  const requiredOpaque = classifyActionOption({ id: 'opaque-response', ...requiredPayload });
  assert.deepEqual(requiredReadable.semantics, requiredOpaque.semantics);
  assert.equal(requiredOpaque.semantics.obligation, 'required-response');
  assert.equal(requiredOpaque.semantics.planningChannel, 'edge');
  assert.equal(requiredOpaque.semantics.socialContext.referenceId, 'proposal-1');
  assert.equal(isRequiredSocialOption(requiredOpaque), true);

  const mutualReproduction = classifyActionOption({
    id: 'opaque-mutual-attempt', summary: '一次双方授权的生殖尝试', reason: '已有授权',
    goal: { kind: 'condition', personId: 'p1', condition: 'pregnancy', present: true },
    nextAction: { kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: 'p2' }], authorizationRef: 'agreement-1' },
    target: { kind: 'person', personId: 'p2' }, estimatedDuration: 'one-month', sourceFactIds: ['agreement-1'],
  });
  assert.equal(mutualReproduction.semantics.obligation, 'commitment-action');
  assert.equal(mutualReproduction.semantics.reproduction.direction, 'proceed');
  assert.equal(mutualReproduction.semantics.reproduction.mode, 'mutual');
  assert.equal(mutualReproduction.semantics.socialContext.cooperationKind, 'reproduction');

  const unilateralReproduction = classifyActionOption({
    ...mutualReproduction,
    id: 'opaque-unilateral-attempt',
    semantics: undefined,
    nextAction: { kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: 'p2' }] },
  });
  assert.equal(unilateralReproduction.semantics.obligation, 'commitment-action',
    'all executable reproduce actions retain the canonical commitment-action priority');
  assert.equal(unilateralReproduction.semantics.reproduction.mode, 'unilateral-trait');

  const demonstration = classifyActionOption({
    id: 'opaque-demonstration', summary: '示范技术', reason: '收到有来源请求',
    goal: { kind: 'technique-demonstrated', projectId: 'project-1', requestEventId: 'request-1' },
    nextAction: {
      kind: 'act', operation: 'combine', targets: [],
      techniqueDemonstration: { requestEventId: 'request-1', projectId: 'project-1', learnerId: 'p2', techniqueId: 'technique-1' },
    },
    estimatedDuration: 'one-month', sourceFactIds: ['request-1'], domain: 'social',
  });
  assert.equal(demonstration.semantics.obligation, 'optional');
  assert.equal(demonstration.semantics.planningChannel, 'edge');
  assert.equal(demonstration.semantics.edgeTrigger, 'technique-demonstration');
  assert.equal(demonstration.semantics.socialContext.projectId, 'project-1');

  const knowledgeResponse = classifyActionOption({
    id: 'opaque-knowledge-response', summary: '回应项目知识请求', reason: '本人掌握该技术',
    goal: { kind: 'knowledge', factId: 'technique-1', personId: 'p2' },
    nextAction: {
      kind: 'communicate',
      content: {
        id: 'claim-1', kind: 'claim', summary: '说明做法',
        projectKnowledgeResponse: {
          version: 'project-knowledge-response-v1', projectId: 'project-1', requestEventId: 'request-2', requesterId: 'p2', outputMaterialId: 8,
        },
      },
      audience: ['p2'], channel: 'voice',
    },
    estimatedDuration: 'one-month', sourceFactIds: ['request-2'], domain: 'social',
  });
  assert.equal(knowledgeResponse.semantics.obligation, 'optional');
  assert.equal(knowledgeResponse.semantics.edgeTrigger, 'project-knowledge-response');
  assert.equal(knowledgeResponse.semantics.socialContext.projectKind, 'knowledge-response');
  assert.equal(knowledgeResponse.semantics.socialContext.materialId, 8);

  const returnSharedLiving = {
    ...ordinary,
    id: 'opaque-return',
    semantics: defineActionOptionSemantics({
      obligation: 'commitment-action', planningChannel: 'edge', purpose: 'social-coordination',
      minimumLifeStage: 'adolescent', needKinds: ['commitment', 'belonging'], edgeTrigger: 'commitment-action',
      socialContext: { cooperationKind: 'companion', phase: 'continuation', counterpartIds: ['p2'], referenceId: 'companion-1' },
    }),
  };
  assert.equal(isFulfillmentOption(returnSharedLiving), true);

  assert.throws(() => assertClassifiedActionOption({ id: 'unclassified', ...ordinary }),
    /without typed semantics/u, 'the production boundary must fail closed on unclassified options');
  assert.throws(() => validateActionOptionSemantics({
    version: 'action-option-semantics-v1', obligation: 'required-response', planningChannel: 'ordinary',
    purpose: 'social-coordination', minimumLifeStage: 'adolescent', needKinds: [],
  }), /Required response must use edge planning/u);
  assert.throws(() => validateActionOptionSemantics(null), /must be an object/u,
    'the runtime validator must start from unknown rather than trust a TypeScript shape');
  assert.throws(() => validateActionOptionSemantics({ version: 'action-option-semantics-v1' }),
    /Invalid option obligation/u, 'a version tag alone is not valid semantics');
  assert.throws(() => validateActionOptionSemantics({
    version: 'action-option-semantics-v1', obligation: 'optional', planningChannel: 'ordinary',
    purpose: 'other', minimumLifeStage: 'adolescent', needKinds: 'inquiry',
  }), /needKinds must be a string array/u);
  assert.throws(() => validateActionOptionSemantics({
    version: 'action-option-semantics-v1', obligation: 'optional', planningChannel: 'ordinary',
    purpose: 'other', minimumLifeStage: 'adolescent', needKinds: [],
    socialContext: { cooperationKind: 'assist', phase: 'proposal', counterpartIds: ['p2', 3] },
  }), /counterpartIds must be a string array/u);
  assert.throws(() => validateActionOptionSemantics({
    version: 'action-option-semantics-v1', obligation: 'optional', planningChannel: 'ordinary',
    purpose: 'reproduction', minimumLifeStage: 'adult', needKinds: ['generativity'],
    reproduction: { direction: 'proceed', phase: 'proposal' },
  }), /Invalid reproduction mode/u, 'nested required enum fields must be checked');

  const guardedFiles = [
    'src/game/eland/application/action-options.ts',
    'src/game/eland/application/age-planning.ts',
    'src/game/eland/application/rule-planner.ts',
    'src/game/eland/application/cognition/need-agenda.ts',
    'src/game/eland/application/cognition/option-appraisal.ts',
    'src/game/eland/application/simulation/tick-planner.ts',
    'src/game/eland/application/simulation/intent-execution.ts',
    'src/game/eland/application/simulation/model-review.ts',
    'src/game/eland/domain/intent.ts',
    'src/game/eland/domain/social-repetition.ts',
    'server/model-decision-gateway.ts',
  ];
  for (const file of guardedFiles) {
    const source = readFileSync(path.resolve(file), 'utf8');
    assert.doesNotMatch(source, /\b(?:option|item|selected|candidate)\.id\.(?:startsWith|endsWith|includes|match)\s*\(/u,
      `${file} must not route planner meaning through option id text`);
    assert.doesNotMatch(source, /\b(?:REQUIRED_RESPONSE|REQUIRED_SOCIAL_RESPONSE|FULFILLMENT(?:_OPTION)?)\s*=\s*\//u,
      `${file} must not restore option-id routing regexes`);
  }
  const lifecycleSource = readFileSync(path.resolve('src/game/eland/application/simulation/state-lifecycle.ts'), 'utf8');
  assert.match(lifecycleSource, /LEGACY_REQUIRED_SOCIAL_OPTION/u,
    'the explicitly named persisted-state compatibility seam remains allowed');

  console.log('typed action option semantics test passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
