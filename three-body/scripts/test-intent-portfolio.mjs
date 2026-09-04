import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-intent-portfolio-'));
const simulationBundle = path.join(temporaryDirectory, 'simulation.mjs');
const gatewayBundle = path.join(temporaryDirectory, 'gateway.mjs');
const executionBundle = path.join(temporaryDirectory, 'intent-execution.mjs');
const projectionBundle = path.join(temporaryDirectory, 'decision-context.mjs');
const reviewBundle = path.join(temporaryDirectory, 'model-review.mjs');
const esbuild = path.resolve('node_modules/.bin/esbuild');

function bundle(entry, outfile) {
  execFileSync(esbuild, [entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${outfile}`], {
    stdio: 'pipe',
  });
}

try {
  bundle('src/game/eland/simulation.ts', simulationBundle);
  bundle('server/model-decision-gateway.ts', gatewayBundle);
  bundle('src/game/eland/application/simulation/intent-execution.ts', executionBundle);
  bundle('src/game/eland/application/model-decision/decision-context.ts', projectionBundle);
  bundle('src/game/eland/application/simulation/model-review.ts', reviewBundle);

  const simulation = await import(pathToFileURL(simulationBundle).href);
  const gateway = await import(pathToFileURL(gatewayBundle).href);
  const execution = await import(pathToFileURL(executionBundle).href);
  const projection = await import(pathToFileURL(projectionBundle).href);
  const review = await import(pathToFileURL(reviewBundle).href);

  const state = simulation.createInitialState(37_401, {
    endpoint: { kind: 'months', value: 12 },
    chaosIntensity: 0,
  });
  const person = state.people[0];
  const initialContext = simulation.buildDecisionContexts(state, 1)
    .find((context) => context.person.id === person.id);
  assert(initialContext?.options.length, 'portfolio regression needs one executable opening option');

  const seedOption = initialContext.options[0];
  const oldIntent = {
    id: 'intent:old-shelter-thread',
    ownerId: person.id,
    summary: seedOption.summary,
    domain: 'strategic',
    goal: structuredClone(seedOption.goal),
    nextAction: structuredClone(seedOption.nextAction),
    status: 'active',
    createdAtMonth: 1,
    lastProgressAtMonth: 1,
    progress: 0,
    sourceDecisionEventId: 'decision:old-shelter-thread',
    plan: {
      version: 'mental-plan-translation-v1',
      steps: ['取得眼前合适的实料', '把材料真实连接成能遮雨的住所'],
      disposition: 'act',
    },
    sourceFactIds: [...seedOption.sourceFactIds],
    actionEventIds: [],
    replanCount: 0,
  };
  state.intents.push(oldIntent);
  person.activeIntentId = oldIntent.id;

  const replacementOption = initialContext.options.find((option) => option.id !== seedOption.id)
    ?? seedOption;
  const temporaryIntent = execution.startIntent(
    state,
    person,
    initialContext,
    replacementOption.id,
    undefined,
    'decision:change-focus',
    1,
  );
  assert(temporaryIntent, 'changing focus should start the newly chosen executable intent');
  temporaryIntent.plan = {
    version: 'mental-plan-translation-v1',
    steps: ['处理刚转去的事情', '依据实际结果决定后续'],
    disposition: 'act',
  };
  assert.equal(oldIntent.status, 'suspended', 'a real multi-step thread must be suspended instead of erased');
  assert.equal(person.activeIntentId, temporaryIntent.id, 'only the newly selected thread executes now');

  const currentContext = simulation.buildDecisionContexts(state, 1)
    .find((context) => context.person.id === person.id);
  assert(currentContext, 'the person must remain eligible for a model decision');
  const request = projection.buildDecisionRequestContext(currentContext);
  const protocol = gateway.buildDecisionModelRequestProtocol(request, { characterAgendaProposal: false });
  const suspendedWork = protocol.requestContext.current.suspendedWork;
  assert(Array.isArray(suspendedWork) && suspendedWork.length >= 1,
    'Mind and Plan should see every still-open suspended thread as authored work, not a score');
  const oldWork = suspendedWork.find((item) => item.summary === oldIntent.summary);
  assert.match(oldWork?.handle ?? '', /^s\d+$/u, 'the suspended thread needs an opaque resumable handle');
  assert.deepEqual(oldWork.authoredPlan, oldIntent.plan.steps,
    'resumption context should preserve the model-authored multi-step plan');
  assert(protocol.mindContext.current.suspendedWork.some((item) => item.summary === oldIntent.summary),
    'Mind must know that returning to an old thread is possible before it forms that intention');
  assert.equal(protocol.mindContext.current.suspendedWork.some((item) => 'handle' in item), false,
    'Mind forms a direction from remembered work; only Plan receives executable resume handles');

  const decision = gateway.normalizeMindPlanModelOutput(
    request,
    {
      utterance: '我先回去继续搭建那个能遮雨的住所。',
      delivery: 'normal',
      goal: oldIntent.summary,
      orientation: 'construction',
      horizon: 'ongoing',
    },
    {
      steps: ['回到原先留下的住所事务', '沿原计划继续下一步'],
      disposition: 'act',
      resumeIntentHandle: oldWork.handle,
    },
    protocol,
  );
  assert.equal(decision?.kind, 'resume', 'the model should be able to choose a suspended thread directly');
  assert.equal(decision?.intentId, oldIntent.id, 'opaque handle must resolve only to its original intent');
  assert.equal(review.validateModelDecision(currentContext, decision)?.kind, 'resume',
    'the normal model validation boundary must preserve a valid resume decision');

  execution.applyDecision(state, person, currentContext, decision, true, 1, 1, 1);
  assert.equal(person.activeIntentId, oldIntent.id, 'resuming should restore the exact original intent identity');
  assert.equal(oldIntent.status, 'active');
  assert.equal(temporaryIntent.status, 'suspended', 'switching back should preserve the interrupted thread too');

  const intentsBeforeReuse = state.intents.length;
  const reuseContext = simulation.buildDecisionContexts(state, 1)
    .find((context) => context.person.id === person.id);
  const reusedTemporary = execution.startIntent(
    state,
    person,
    reuseContext,
    replacementOption.id,
    undefined,
    'decision:return-to-temporary-thread',
    1,
  );
  assert.equal(reusedTemporary?.id, temporaryIntent.id,
    'selecting the same real thread again must reactivate its identity instead of cloning it');
  assert.equal(state.intents.length, intentsBeforeReuse, 'portfolio reuse must not grow duplicate suspended intents');
  assert.equal(temporaryIntent.lastResumedAtMonth, 1);
  assert.equal(temporaryIntent.suspendedAtMonth, undefined);

  const intentsBeforeActiveReselection = state.intents.length;
  const reselectedActive = execution.startIntent(
    state,
    person,
    reuseContext,
    replacementOption.id,
    undefined,
    'decision:continue-active-thread',
    1,
  );
  assert.equal(reselectedActive?.id, temporaryIntent.id,
    'selecting the currently active thread must continue its identity instead of suspending a duplicate');
  assert.equal(state.intents.length, intentsBeforeActiveReselection,
    'reselecting active work must not grow the portfolio');
  assert.equal(temporaryIntent.status, 'active');

  const suspendContext = simulation.buildDecisionContexts(state, 1)
    .find((context) => context.person.id === person.id);
  execution.applyDecision(state, person, suspendContext, {
    kind: 'suspend', intentId: temporaryIntent.id, reason: '本人决定先搁置',
  }, false, 1, 2, 2);
  assert.equal(temporaryIntent.suspendedAtMonth, 1,
    'an explicit pause must persist its actual suspension month');

  const abandonContext = simulation.buildDecisionContexts(state, 1)
    .find((context) => context.person.id === person.id);
  const abandonRequest = projection.buildDecisionRequestContext(abandonContext);
  const abandonProtocol = gateway.buildDecisionModelRequestProtocol(abandonRequest, {
    characterAgendaProposal: false,
  });
  const oldHandle = abandonProtocol.requestContext.current.suspendedWork
    .find((item) => item.summary === oldIntent.summary)?.handle;
  assert.match(oldHandle ?? '', /^s\d+$/u);
  const abandonDecision = gateway.normalizeMindPlanModelOutput(
    abandonRequest,
    {
      utterance: `我不再保留“${oldIntent.summary}”这件旧事。`,
      delivery: 'normal',
      goal: `不再继续${oldIntent.summary}`,
      orientation: 'rest',
      horizon: 'momentary',
    },
    {
      steps: ['明确结束这项旧事务'],
      disposition: 'abandon',
      abandonIntentHandle: oldHandle,
    },
    abandonProtocol,
  );
  assert.equal(abandonDecision?.kind, 'abandon');
  assert.equal(abandonDecision?.intentId, oldIntent.id);
  assert.equal(review.validateModelDecision(abandonContext, abandonDecision)?.kind, 'abandon');
  execution.applyDecision(state, person, abandonContext, abandonDecision, true, 1, 3, 3);
  assert.equal(oldIntent.status, 'abandoned', 'the model must be able to remove a stale suspended thread directly');

  const waitingIntent = {
    ...structuredClone(temporaryIntent),
    id: 'intent:waiting-for-world-change',
    status: 'suspended',
    waitingFor: 'world-change',
    suspendedAtMonth: 1,
    lastResumedAtMonth: undefined,
  };
  state.intents.push(waitingIntent);
  const waitingContext = simulation.buildDecisionContexts(state, 1)
    .find((context) => context.person.id === person.id);
  const waitingRequest = projection.buildDecisionRequestContext(waitingContext);
  const waitingProtocol = gateway.buildDecisionModelRequestProtocol(waitingRequest, {
    characterAgendaProposal: false,
  });
  const waitingWork = waitingProtocol.requestContext.current.suspendedWork
    .find((item) => item.summary === waitingIntent.summary && item.state);
  assert.match(waitingWork?.handle ?? '', /^s\d+$/u,
    'Plan may identify a waiting thread in order to abandon it');
  const invalidResume = gateway.normalizeMindPlanModelOutput(
    waitingRequest,
    {
      utterance: `我现在就继续${waitingIntent.summary}。`, delivery: 'normal',
      goal: waitingIntent.summary, orientation: 'construction', horizon: 'ongoing',
    },
    {
      steps: ['不等世界变化就重试'], disposition: 'act', resumeIntentHandle: waitingWork.handle,
    },
    waitingProtocol,
  );
  assert.equal(invalidResume, null,
    'waiting-for-world-change must not become executable merely because Plan repeats its handle');

  console.log('[intent-portfolio] 多事务自然挂起、可见与模型恢复通过');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
