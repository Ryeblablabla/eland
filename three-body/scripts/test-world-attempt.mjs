import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = mkdtempSync(path.join(tmpdir(), 'eland-world-attempt-'));
const originalFetch = globalThis.fetch;
const originalConfig = process.env.THREEBODY_MODEL_CONFIG;
const originalMaxOutput = process.env.MODEL_DECISION_MAX_OUTPUT_TOKENS;
const originalMindThinking = process.env.MODEL_MIND_THINKING;
const originalWorldThinking = process.env.MODEL_WORLD_THINKING;
try {
  const config = path.join(temporary, 'models.json');
  const fixtureEndpoint = {
    protocol: 'ollama-chat', url: 'http://fixture.invalid/api/chat', model: 'fixture', auth: 'none',
    structuredOutput: 'native-json', thinking: false,
  };
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, endpoints: {
    fixture: fixtureEndpoint, 'fixture-thinking': { ...fixtureEndpoint, thinking: true },
  } }));
  process.env.THREEBODY_MODEL_CONFIG = config;
  delete process.env.MODEL_DECISION_MAX_OUTPUT_TOKENS;
  delete process.env.MODEL_MIND_THINKING;
  delete process.env.MODEL_WORLD_THINKING;
  const bundle = path.join(temporary, 'test.mjs');
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts', '--sourcefile=world-attempt-test.ts',
    `--outfile=${bundle}`, '--log-level=error',
  ], { input: `export { createInitialState } from './src/game/eland/simulation';
    export { buildCurrentMonthDecisionContext } from './src/game/eland/application/simulation/tick-planner';
    export { commitDecision, executeActiveIntent } from './src/game/eland/application/simulation/intent-execution';
    export { buildDecisionRequestContext } from './src/game/eland/application/model-decision/decision-context';
    export { buildWorldAttemptRequestContext } from './src/game/eland/application/model-decision/mental-act-context';
    export { buildDecisionModelRequestProtocol, handleDecide, normalizeWorldAttemptModelOutput } from './server/model-decision-gateway';
    export { buildWorldAttemptJsonSchema, buildWorldPlanJsonSchema } from './server/model-decision-json-schema';
    export { createWork } from './src/game/eland/domain/works';
    export { authoredAttemptReturnsToMind } from './src/game/eland/domain/intent';
    export { unreviewedLanguageSources } from './src/game/eland/application/simulation/cognitive-reception';
    export { positionsCanTouch } from './src/game/eland/domain/social-space';
    export { Material } from './src/game/eland/domain/material';
    export { cellId, setVoxel, voxelAt } from './src/game/eland/world/grid';`, stdio: ['pipe', 'pipe', 'pipe'] });
  const api = await import(pathToFileURL(bundle).href);
  const state = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  const actor = state.people[0], partner = state.people[1];
  for (let x = 10; x <= 16; x++) for (let y = 10; y <= 16; y++) for (let z = 0; z < state.world.grid.levels; z++) {
    api.setVoxel(state.world.grid, x, y, z, z === 0 ? api.Material.Stone : api.Material.Air);
  }
  actor.position = { ...actor.position, cellId: api.cellId(12, 12), z: 1 };
  partner.position = { ...partner.position, cellId: api.cellId(14, 12), z: 1 };
  const work = api.createWork({ position: { x: 12, y: 13, z: 1 }, arrangement: 'pile',
    components: [{ materialId: api.Material.Wood, quantity: 2 }], builderId: actor.id,
    atMonth: 0, sourceEventId: 'fixture-assembly', summary: '已有木构件',
    layout: { version: 'work-layout-v1', voxels: [0, 1].map((z) => ({ offset: { x: 0, y: 0, z }, materialId: api.Material.Wood })) },
  });
  state.world.works = [work];
  for (const z of [1, 2]) api.setVoxel(state.world.grid, 12, 13, z, api.Material.Wood);
  const events = [];
  let tick = 1;
  const domainContext = () => api.buildCurrentMonthDecisionContext(state, actor, 1, tick, events);
  let context = domainContext(), request = api.buildDecisionRequestContext(context);
  let protocol = api.buildDecisionModelRequestProtocol(request);
  const workHandle = protocol.handles.visible.find((item) => item.kind === 'work' && item.workId === work.id).handle;
  const partnerHandle = protocol.handles.visible.find((item) => item.kind === 'person' && item.personId === partner.id).handle;
  const words = `${partner.name}，你愿意帮我扶木材吗？`;
  const selectedAttempt = '把已有木构件从上下叠放改为并排，检查改变后的站位';
  const goal = '让自己能够利用已有木材改变站位';
  const input = { intentionChange: { goal, orientation: 'construction', horizon: 'ongoing' },
    declaration: { utterance: words, delivery: 'normal' },
    attempt: { kind: 'creative', description: selectedAttempt } };
  const rearrange = { speechHandoff: true, nativeOperation: { kind: 'assemble', targetHandle: workHandle, inputs: [],
    layout: [0, 1].map((x) => ({ offset: { x, y: 0, z: 0 }, materialKey: 'wood' })) } };
  let replies = [input, { speechIntent: { kind: 'proposal', proposalKind: 'joint-action',
    counterpartHandles: [partnerHandle], terms: { summary: words } } }, rearrange];
  const sent = [];
  // No real HTTP: all provider responses are explicit deterministic fixtures.
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'http://fixture.invalid/api/chat');
    const body = JSON.parse(init.body); sent.push(body);
    assert(replies.length, 'unexpected extra model or WorldPlan invocation');
    return new Response(JSON.stringify({ message: { content: JSON.stringify(replies.shift()) },
      prompt_eval_count: 0, eval_count: 0 }), { status: 200 });
  };
  const result = await api.handleDecide({ contexts: [request] }, 'fixture');
  assert.equal(result.body.providerRequests, 3);
  const contextMessage = (body) => body.messages.find((message) => message.role === 'user' && message.content.trimStart().startsWith('{'));
  const mindContext = JSON.parse(contextMessage(sent[0]).content);
  assert.equal(mindContext.schemaVersion, 'mind-intention-context-v7');
  for (const field of ['actionSpace', 'nativeOperations', 'nativeReferences', 'knownMethods']) assert(!(field in mindContext));
  assert(!JSON.stringify(sent[0].format.$defs.attempt).includes('nativeOperation'));
  const mindGuide = sent[0].messages.find((message) => message.content.startsWith('输出格式说明。')).content;
  const speechGuide = sent[1].messages.find((message) => message.content.startsWith('输出格式说明。')).content;
  assert(!mindGuide.includes('proposalKind') && !mindGuide.includes('speechIntent'), 'Mind is not given the social protocol API');
  assert(mindGuide.length < 2_000 && mindGuide.length < speechGuide.length / 2, 'the ordinary Mind guide stays materially smaller than formal speech compilation');
  assert.equal(sent[0].options.num_predict, 1_200);
  const frozenSpeechContext = JSON.parse(contextMessage(sent[1]).content);
  assert.equal(frozenSpeechContext.frozenUtterance, words);
  assert.equal(frozenSpeechContext.frozenDelivery, 'normal');
  assert(!JSON.stringify(sent[1].format).includes('"utterance"'), 'exact speech schema cannot ask World to rewrite words');
  const worldContext = JSON.parse(contextMessage(sent[2]).content);
  assert(sent.every((body) => body.messages.findIndex((message) => message.content.startsWith('输出格式说明。'))
    < body.messages.indexOf(contextMessage(body))), 'format instructions precede the actual scene, not replace the final task');
  assert.equal(worldContext.schemaVersion, 'world-attempt-context-v1');
  assert.equal(worldContext.declaration.status, 'selected-words');
  assert.equal(worldContext.selectedAttempt, selectedAttempt);
  assert(!('nativeOperations' in worldContext) && !('actionSpace' in worldContext),
    'fresh translation receives the selected attempt and API, not alternative planner choices');
  assert(!JSON.stringify(worldContext).includes(words), 'the independently handled invitation is not a second body task');
  assert.deepEqual(Object.keys(worldContext.current).sort(), ['recentActions']);
  assert(!JSON.stringify(sent[2].format).includes('completionReview'));
  assert(!JSON.stringify(sent[2].format).includes('resumeIntentHandle'));
  const decision = result.body.decisions[0];
  assert.equal(decision.mentalAct.goal, goal);
  assert.equal(decision.mentalAct.utterance, words);
  assert.equal(decision.mentalAct.plan, undefined);
  assert.equal(decision.authoredAttempt.plan, undefined);
  assert.equal(decision.nativeOperation.target.workId, work.id);
  assert(api.authoredAttemptReturnsToMind(decision));
  const origin = api.commitDecision(state, actor, context, decision, true, 1, events, tick++);
  const partnerBefore = structuredClone({ position: partner.position, body: partner.body, inventory: partner.inventory });
  const action = api.executeActiveIntent(state, actor, 1, events.length, tick++, events);
  events.push(action);
  assert.equal(action.status, 'completed', action.result);
  assert.equal(api.voxelAt(state.world.grid, 12, 13, 2), api.Material.Air);
  assert.equal(api.voxelAt(state.world.grid, 13, 13, 1), api.Material.Wood);
  assert.deepEqual({ position: partner.position, body: partner.body, inventory: partner.inventory }, partnerBefore);
  assert.equal(state.world.works[0].components.reduce((sum, part) => sum + part.quantity, 0), 2);
  assert.equal(events.filter((event) => event.kind === 'action' && event.action.kind === 'talk').length, 1);
  assert.equal(state.agreements.length, 1, 'the authored invitation is a real proposal');
  assert(state.agreements.every((agreement) => !agreement.acceptedByPersonIds.includes(partner.id)),
    'asking for assistance does not invent the other person\'s acceptance');

  context = domainContext(); request = api.buildDecisionRequestContext(context);
  protocol = api.buildDecisionModelRequestProtocol(request);
  assert.equal(request.currentIntention.sourceDecisionEventId, origin.id);
  assert(request.recentCompletedWork.some((entry) => entry.recentOutcomes?.some((outcome) => outcome.sourceEventId === action.id)),
    'actual result must reach the next decision');
  replies = [{ attempt: { kind: 'creative', description: '把已有木构件改成我能实际使用的形态' } },
    { uncompiled: { reason: '当前构形描述尚未绑定到具体排布位置' } }];
  const failed = (await api.handleDecide({ contexts: [request] }, 'fixture')).body.decisions[0];
  assert.equal(failed.mentalAct, undefined);
  assert.equal(failed.declaration, undefined);
  assert.equal(failed.authoredAttempt.intentionSourceDecisionEventId, origin.id);
  assert.equal(failed.authoredAttempt.plan, undefined);
  assert(api.authoredAttemptReturnsToMind(failed));
  const beforeKnowledge = actor.knowledge.length, beforeActions = events.filter((event) => event.kind === 'action').length;
  api.commitDecision(state, actor, context, failed, true, 1, events, tick++);
  assert.equal(actor.knowledge.length, beforeKnowledge, 'compiler feedback is not lived knowledge');
  assert.equal(events.filter((event) => event.kind === 'action').length, beforeActions, 'no fabricated failure action or repeated speech');
  const afterFailure = api.buildDecisionRequestContext(domainContext());
  assert.equal(afterFailure.pendingExecutionStep.description, '把已有木构件改成我能实际使用的形态',
    'a retained goal keeps the actual current attempt description with its technical feedback');

  const draft = { goal, nextAttempt: selectedAttempt, utterance: words, delivery: 'normal',
    speechIntent: { kind: 'expression' }, orientation: 'construction', horizon: 'ongoing' };
  assert.equal(api.normalizeWorldAttemptModelOutput(request, draft, { plan: { disposition: 'abandon' } }, protocol), null);
  const noExtraBody = api.normalizeWorldAttemptModelOutput(request, draft, { effects: [] }, protocol);
  assert(noExtraBody && !noExtraBody.nativeOperation && !noExtraBody.executionProbe && !noExtraBody.compilationFailure);
  const open = api.normalizeWorldAttemptModelOutput(request, draft, { effects: [{ kind: 'modify-structure',
    targetHandle: workHandle, layout: [0, 1].map((z) => ({ offset: { x: 0, y: 0, z }, materialKey: 'wood' })) }] }, protocol);
  assert(open?.executionProbe && !open.mentalAct.plan, 'open creation remains available without a World-authored plan');
  const longAttempt = `${'逐段查看并调整实际木构件的位置。'.repeat(20)}最后保留原材料，不把求助当作他人已经答应。`;
  assert(longAttempt.length > 240 && longAttempt.length <= 480);
  const fullRequest = api.normalizeWorldAttemptModelOutput(request, { ...draft, nextAttempt: longAttempt },
    { effects: [{ kind: 'modify-structure', targetHandle: workHandle, arrangement: 'pile' }] }, protocol);
  assert.equal(fullRequest.executionProbe.adjudication.request, longAttempt,
    'the current actor request must not inherit the old plan-step truncation');
  replies = [{ attempt: { kind: 'continue' } }];
  const continued = await api.handleDecide({ contexts: [request] }, 'fixture');
  assert.equal(continued.body.providerRequests, 1, 'fresh continue needs only Mind, with no World compilation');
  assert.equal(continued.body.decisions[0].attention, 'keep-current');
  assert.equal(continued.body.decisions[0].authoredAttempt, undefined);

  // A chosen speaking intention is realizable even without exact words or
  // complete exchange terms. It does not become a physical taking action.
  context = domainContext(); request = api.buildDecisionRequestContext(context);
  const speakingAttempt = `向${partner.name}询问是否愿意交换物资，具体交换数量留待双方讨论。`;
  const spokenWords = `${partner.name}，你愿意交换物资吗？我们可以再商量具体交换什么和数量。`;
  const speechOutput = { declaration: { utterance: spokenWords, delivery: 'normal', speechIntent: {
    kind: 'proposal', proposalKind: 'exchange', counterpartHandles: [partnerHandle], commitment: '讨论交换物资的意愿',
  } } };
  const speechRequestStart = sent.length;
  replies = [{ attempt: { kind: 'speak', description: speakingAttempt } }, speechOutput];
  const speaking = await api.handleDecide({ contexts: [request] }, 'fixture');
  assert.equal(speaking.body.providerRequests, 2);
  assert(sent[speechRequestStart].format.$defs.attempt.oneOf.some((branch) => branch.properties.kind.enum.includes('speak')));
  const speechRequest = sent[speechRequestStart + 1];
  const speechContext = JSON.parse(contextMessage(speechRequest).content);
  assert.equal(speechContext.schemaVersion, 'world-speech-context-v2');
  assert.equal(speechContext.selectedSpeech, speakingAttempt);
  for (const field of ['actionSpace', 'nativeOperations', 'materialCatalog', 'goal', 'plan']) assert(!(field in speechContext));
  assert(!JSON.stringify(speechRequest.format).includes('nativeOperation'));
  assert(!JSON.stringify(speechRequest.format).includes('effects'));
  const speechDecision = speaking.body.decisions[0];
  assert.equal(speechDecision.mentalAct, undefined, 'realizing speech under an existing purpose does not create another goal');
  assert.equal(speechDecision.reason, speakingAttempt, 'the committed decision retains the actor-selected meaning');
  assert.equal(speechDecision.declaration.utterance, spokenWords);
  assert.equal(speechDecision.nativeOperation, undefined);
  assert.equal(speechDecision.executionProbe, undefined);
  const beforeSpeech = structuredClone({ actorInventory: actor.inventory, partnerInventory: partner.inventory,
    activeIntentId: actor.activeIntentId });
  const beforeSpeechEvents = events.length, beforeSpeechAgreements = state.agreements.length;
  const speechFact = api.commitDecision(state, actor, context, speechDecision, true, 1, events, tick++);
  const emittedSpeech = events.slice(beforeSpeechEvents);
  assert.equal(speechFact.languageBroadcast.text, spokenWords);
  assert.deepEqual(emittedSpeech.filter((event) => event.kind === 'action').map((event) => event.action.kind), ['talk']);
  const actualSpeech = emittedSpeech.find((event) => event.kind === 'action');
  assert.equal(actualSpeech.decisionSource.executionDecisionEventId, speechFact.id);
  assert.equal(actualSpeech.diff.languageSourceEventId, speechFact.id);
  assert.deepEqual(api.unreviewedLanguageSources(emittedSpeech, new Map()).get(partner.id), [speechFact.id],
    'the receiver gets one independent response opportunity from the actual wave, not automatic consent');
  assert.equal(state.agreements.length, beforeSpeechAgreements, 'missing exchange terms do not create a default transaction');
  assert.deepEqual({ actorInventory: actor.inventory, partnerInventory: partner.inventory,
    activeIntentId: actor.activeIntentId }, beforeSpeech, 'speech neither steals material nor replaces current body work');
  const partnerContext = api.buildCurrentMonthDecisionContext(state, partner, 1, tick, events);
  const partnerRequest = api.buildDecisionRequestContext(partnerContext);
  assert(partnerRequest.recentDialogue.some((line) => line.sourceEventId === speechFact.id));
  const replyWords = '你想用什么交换？我还没有答应。';
  replies = [{ attempt: { kind: 'continue' }, declaration: {
    utterance: replyWords, delivery: 'normal',
  } }, { speechIntent: { kind: 'request-information' } }];
  const independentReply = await api.handleDecide({ contexts: [partnerRequest] }, 'fixture');
  assert.equal(independentReply.body.providerRequests, 2);
  api.commitDecision(state, partner, partnerContext, independentReply.body.decisions[0], true, 1, events, tick++);
  assert(state.agreements.every((agreement) => !agreement.acceptedByPersonIds.includes(partner.id)));
  // A real received transfer supplies the related memory for a silent
  // appraisal; fixture words alone must not create an experienced gift.
  const giftedStack = partner.inventory.find((stack) => stack.quantity > 0);
  assert(giftedStack);
  const giftContext = api.buildCurrentMonthDecisionContext(state, partner, 1, tick, events);
  api.commitDecision(state, partner, giftContext, { kind: 'idle', reason: '递出本人一份实际持物',
    authoredAttempt: { kind: 'creative' }, nativeOperation: { kind: 'transfer', quantity: 1,
      source: { kind: 'inventory-stack', personId: partner.id, stackId: giftedStack.id },
      destination: { kind: 'person', personId: actor.id } } }, true, 1, events, tick++);
  for (let step = 0; partner.activeIntentId && step < 8; step++) {
    const giftAction = api.executeActiveIntent(state, partner, 1, events.length, tick++, events);
    assert(giftAction);
    events.push(giftAction);
  }
  context = domainContext(); request = api.buildDecisionRequestContext(context);
  const privateProtocol = api.buildDecisionModelRequestProtocol(request);
  const privateMemory = privateProtocol.handles.memories.find((memory) => memory.personIds?.includes(partner.id));
  assert(privateMemory, 'the private appraisal uses a real related memory');
  replies = [{ attempt: { kind: 'continue' }, evidenceMemoryHandles: [privateMemory.handle], relationshipAppraisal: {
    otherPersonHandle: partnerHandle, sourceMemoryHandles: [privateMemory.handle], meanings: ['uncertainty'],
    interpretation: '对方尚未答应，我对她是否愿意参与还不确定',
  } }];
  const privateReflection = await api.handleDecide({ contexts: [request] }, 'fixture');
  assert.equal(privateReflection.body.providerRequests, 1, 'private interpretation never goes to a World author');
  assert.equal(privateReflection.body.decisions[0].declaration.utterance, '');
  assert.equal(privateReflection.body.decisions[0].declaration.relationshipAppraisal.otherPersonId, partner.id);
  assert(privateReflection.body.decisions[0].declaration.sourceEventIds.every((id) => privateMemory.sourceFactIds.includes(id)));
  const beforePrivateReflection = events.length;
  api.commitDecision(state, actor, context, privateReflection.body.decisions[0], true, 1, events, tick++);
  assert.equal(events.slice(beforePrivateReflection).filter((event) => event.kind === 'action').length, 0);
  assert(actor.relationshipEpisodes.some((episode) => episode.otherPersonId === partner.id
    && episode.appraisal.interpretation === '对方尚未答应，我对她是否愿意参与还不确定'));
  context = domainContext(); request = api.buildDecisionRequestContext(context);
  const exactWords = '  我们先说清楚：“各自愿意交换什么？”  ';
  replies = [{ attempt: { kind: 'speak', description: '把本人选好的原话说出来' }, declaration: {
    utterance: exactWords, delivery: 'whisper',
  } }, { speechIntent: { kind: 'expression' } }];
  const exactSpeech = await api.handleDecide({ contexts: [request] }, 'fixture');
  assert.equal(exactSpeech.body.providerRequests, 2, 'World compiles semantics once, never a second utterance');
  assert.equal(exactSpeech.body.decisions[0].declaration.utterance, exactWords);
  assert.equal(exactSpeech.body.decisions[0].declaration.delivery, 'whisper');
  const beforeExactSpeech = events.length;
  api.commitDecision(state, actor, context, exactSpeech.body.decisions[0], true, 1, events, tick++);
  assert.equal(events.slice(beforeExactSpeech).filter((event) => event.kind === 'action' && event.action.kind === 'talk').length, 1);
  assert.equal(events[beforeExactSpeech].languageBroadcast.text, exactWords);

  context = domainContext(); request = api.buildDecisionRequestContext(context);
  const handedSpeech = `大声请求${partner.name}帮忙寻找水源，并询问她是否愿意一起查看附近地面。`;
  const handedWords = `${partner.name}，你愿意帮我一起找水、看看附近地面吗？`;
  const handoffStart = sent.length;
  replies = [{ attempt: { kind: 'creative', description: handedSpeech } }, { speechHandoff: true },
    { declaration: { utterance: handedWords, delivery: 'call', speechIntent: { kind: 'request-information' } } }];
  const handed = await api.handleDecide({ contexts: [request] }, 'fixture');
  assert.equal(handed.body.providerRequests, 3);
  const handoffContext = JSON.parse(contextMessage(sent[handoffStart + 1]).content);
  assert.equal(handoffContext.declaration.status, 'not-selected',
    'a retained goal with old words does not mean this new creative attempt already spoke');
  assert(!('nativeOperations' in handoffContext) && !('actionSpace' in handoffContext));
  assert('boundMethods' in handoffContext);
  assert.equal(JSON.parse(contextMessage(sent[handoffStart + 2]).content).selectedSpeech, handedSpeech,
    'World hands off the unchanged actor sentence, not another compiler-authored paraphrase');
  const handedDecision = handed.body.decisions[0];
  assert.equal(handedDecision.mentalAct, undefined);
  assert.equal(handedDecision.authoredAttempt.intentionSourceDecisionEventId, request.currentIntention.sourceDecisionEventId);
  assert.equal(handedDecision.nativeOperation, undefined);
  assert.equal(handedDecision.executionProbe, undefined);
  assert.equal(handedDecision.declaration.utterance, handedWords);
  const handoffEventStart = events.length;
  const handedFact = api.commitDecision(state, actor, context, handedDecision, true, 1, events, tick++);
  const handedEvents = events.slice(handoffEventStart);
  assert.deepEqual(handedEvents.filter((event) => event.kind === 'action').map((event) => event.action.kind), ['talk']);
  assert.deepEqual(api.unreviewedLanguageSources(handedEvents, new Map()).get(partner.id), [handedFact.id]);
  assert(state.agreements.every((agreement) => !agreement.acceptedByPersonIds.includes(partner.id)));

  context = domainContext(); request = api.buildDecisionRequestContext(context);
  const mixedAttempt = `把已有木构件重新上下叠放，同时询问${partner.name}是否愿意帮忙查看。`;
  const mixedWords = `${partner.name}，我准备重新叠放木构件，你愿意帮忙查看吗？`;
  const mixedPhysical = { effects: [{ kind: 'modify-structure', targetHandle: workHandle,
    layout: [0, 1].map((z) => ({ offset: { x: 0, y: 0, z }, materialKey: 'wood' })) }], speechHandoff: true };
  replies = [{ attempt: { kind: 'creative', description: mixedAttempt } }, mixedPhysical,
    { declaration: { utterance: mixedWords, delivery: 'normal', speechIntent: { kind: 'request-information' } } }];
  const mixed = await api.handleDecide({ contexts: [request] }, 'fixture');
  assert.equal(mixed.body.providerRequests, 3);
  const mixedDecision = mixed.body.decisions[0];
  assert(mixedDecision.executionProbe, 'a speech handoff must not replace the compiled physical part');
  assert.equal(mixedDecision.declaration.utterance, mixedWords);
  assert.equal(mixedDecision.executionProbe.adjudication.request, mixedAttempt);
  const mixedStart = events.length;
  api.commitDecision(state, actor, context, mixedDecision, true, 1, events, tick++);
  const mixedAction = api.executeActiveIntent(state, actor, 1, events.length, tick++, events);
  assert(mixedAction?.action.kind === 'world-interact', mixedAction?.result);
  assert.equal(mixedAction.status, 'completed', mixedAction.result);
  events.push(mixedAction);
  assert.equal(api.voxelAt(state.world.grid, 12, 13, 2), api.Material.Wood);
  assert.equal(api.voxelAt(state.world.grid, 13, 13, 1), api.Material.Air);
  assert.equal(events.slice(mixedStart).filter((event) => event.kind === 'action' && event.action.kind === 'talk').length, 1);
  context = domainContext(); request = api.buildDecisionRequestContext(context);
  replies = [{ attempt: { kind: 'creative', description: mixedAttempt } }, mixedPhysical,
    { uncompiled: { reason: '本次言语表达尚未编译' } }];
  const partial = await api.handleDecide({ contexts: [request] }, 'fixture');
  assert.equal(partial.body.providerRequests, 3);
  assert(partial.body.decisions[0].executionProbe, 'speech failure still retains an already compiled open physical request');
  assert.equal(partial.body.decisions[0].compilationFailure, undefined,
    'a speech-only failure must not activate the physical executor\'s failed-compilation gate');
  assert.equal(partial.body.decisions[0].declaration, undefined);

  // A failed exact-word semantic compilation retains its original choice and
  // the independently compiled physical work, with no guessed expression.
  const unavailableWords = '我准备重排木材；这句话现在还没有说出去。';
  replies = [{ attempt: { kind: 'creative', description: selectedAttempt },
    declaration: { utterance: unavailableWords, delivery: 'call' } },
    { uncompiled: { reason: '本次原话中的语义引用尚未绑定' } },
    { speechHandoff: true, effects: [{ kind: 'modify-structure', targetHandle: workHandle,
      layout: [0, 1].map((x) => ({ offset: { x, y: 0, z: 0 }, materialKey: 'wood' })) }] }];
  const frozenPartial = await api.handleDecide({ contexts: [request] }, 'fixture');
  assert.equal(frozenPartial.body.providerRequests, 3, 'a failed selected utterance cannot trigger a replacement speech handoff');
  const frozenPartialDecision = frozenPartial.body.decisions[0];
  assert(frozenPartialDecision.executionProbe);
  assert.equal(frozenPartialDecision.compilationFailure, undefined);
  assert.equal(frozenPartialDecision.declaration, undefined);
  assert(frozenPartialDecision.reason.includes(unavailableWords));
  assert(frozenPartialDecision.reason.includes('尚未发出'));
  const frozenPartialStart = events.length;
  api.commitDecision(state, actor, context, frozenPartialDecision, true, 1, events, tick++);
  const retainedBody = api.executeActiveIntent(state, actor, 1, events.length, tick++, events);
  assert.equal(retainedBody.action.kind, 'world-interact');
  assert.equal(retainedBody.status, 'completed', retainedBody.result);
  events.push(retainedBody);
  assert.equal(api.voxelAt(state.world.grid, 13, 13, 1), api.Material.Wood);
  assert.equal(events.slice(frozenPartialStart).filter((event) => event.kind === 'action' && event.action.kind === 'talk').length, 0);

  context = domainContext(); request = api.buildDecisionRequestContext(context);
  replies = [{ attempt: { kind: 'creative', description: '尝试调整已有木构件' },
    declaration: { utterance: '我先试着调整这块木材。', delivery: 'normal' } },
    { speechIntent: { kind: 'expression' } }, { uncompiled: { reason: '本次构形还没有具体位置' } }];
  const bodyUnavailable = await api.handleDecide({ contexts: [request] }, 'fixture');
  assert.equal(bodyUnavailable.body.decisions[0].declaration.utterance, '我先试着调整这块木材。');
  assert(bodyUnavailable.body.decisions[0].compilationFailure);
  const wordsDespiteBodyFailure = events.length;
  api.commitDecision(state, actor, context, bodyUnavailable.body.decisions[0], true, 1, events, tick++);
  assert.deepEqual(events.slice(wordsDespiteBodyFailure).filter((event) => event.kind === 'action').map((event) => event.action.kind), ['talk']);

  replies = [{ attempt: { kind: 'continue' } }];
  await api.handleDecide({ contexts: [request] }, 'fixture-thinking');
  assert.equal(sent.at(-1).options.num_predict, 6_000, 'native thinking has room for reasoning and its final structured output');
  process.env.MODEL_DECISION_MAX_OUTPUT_TOKENS = '20000';
  replies = [{ attempt: { kind: 'continue' } }];
  await api.handleDecide({ contexts: [request] }, 'fixture-thinking');
  assert.equal(sent.at(-1).options.num_predict, 16_384, 'explicit output limit is supported up to the declared request ceiling');
  delete process.env.MODEL_DECISION_MAX_OUTPUT_TOKENS;

  // Stage overrides affect the actual provider body and its output allowance,
  // while retaining one endpoint/model and the inherited default when unset.
  const stageReplies = () => [{ attempt: { kind: 'creative', description: '查看当前构件的实际排列' },
    declaration: { utterance: '我看看现在的排列。', delivery: 'normal' } },
    { speechIntent: { kind: 'expression' } }, { effects: [] }];
  process.env.MODEL_MIND_THINKING = 'true';
  process.env.MODEL_WORLD_THINKING = 'false';
  const stageStart = sent.length;
  replies = stageReplies();
  const staged = await api.handleDecide({ contexts: [request] }, 'fixture');
  assert.equal(staged.body.providerRequests, 3);
  assert.deepEqual(sent.slice(stageStart).map((body) => [body.think, body.options.num_predict]),
    [[true, 6_000], [false, 1_200], [false, 1_200]], 'Mind reasons while both exact speech and physical World use the explicit World setting');
  assert(sent.slice(stageStart).every((body) => body.model === 'fixture'));
  delete process.env.MODEL_MIND_THINKING;
  delete process.env.MODEL_WORLD_THINKING;
  const inheritedStart = sent.length;
  replies = stageReplies();
  await api.handleDecide({ contexts: [request] }, 'fixture-thinking');
  assert.deepEqual(sent.slice(inheritedStart).map((body) => [body.think, body.options.num_predict]),
    [[true, 6_000], [true, 6_000], [true, 6_000]], 'unset stages inherit the original endpoint setting');
  process.env.MODEL_MIND_THINKING = 'high';
  replies = [{ attempt: { kind: 'continue' } }];
  await api.handleDecide({ contexts: [request] }, 'fixture');
  assert.deepEqual([sent.at(-1).think, sent.at(-1).options.num_predict], ['high', 6_000]);
  delete process.env.MODEL_MIND_THINKING;

  // A creative compiler can emit an already-satisfied approach prefix. The
  // actual zero-distance result must reach Mind, without claiming the meal.
  const mealState = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  const eater = mealState.people[0], giver = mealState.people[1];
  for (let x = 10; x <= 16; x++) for (let y = 10; y <= 16; y++) for (let z = 0; z < mealState.world.grid.levels; z++) {
    api.setVoxel(mealState.world.grid, x, y, z, z === 0 ? api.Material.Stone : api.Material.Air);
  }
  eater.position = { ...eater.position, cellId: api.cellId(12, 12), z: 1 };
  giver.position = { ...giver.position, cellId: api.cellId(13, 12), z: 1 };
  eater.inventory = [];
  giver.inventory = [{ id: 'meal-held', materialId: api.Material.RawMeat, quantity: 1, quality: 50,
    sourceEventIds: ['fixture-meat'] }];
  const mealEvents = [];
  const mealContext = () => api.buildCurrentMonthDecisionContext(mealState, eater, 1, tick, mealEvents);
  const mealRequest = api.buildDecisionRequestContext(mealContext());
  const mealProtocol = api.buildDecisionModelRequestProtocol(mealRequest);
  const giverHandle = mealProtocol.handles.visible.find((item) => item.kind === 'person' && item.personId === giver.id).handle;
  const mealGoal = '取得食物并进食';
  const mealDecision = api.normalizeWorldAttemptModelOutput(mealRequest,
    { goal: mealGoal, nextAttempt: '走到同伴身边取得肉并进食', utterance: '', delivery: 'normal',
      speechIntent: { kind: 'expression' }, orientation: 'survival', horizon: 'ongoing' },
    { nativeOperation: { kind: 'move', targetHandle: giverHandle, withinDistance: 0 } }, mealProtocol);
  assert(api.authoredAttemptReturnsToMind(mealDecision));
  const mealOrigin = api.commitDecision(mealState, eater, mealContext(), mealDecision, true, 1, mealEvents, tick++);
  const mealIntent = mealState.intents.find((intent) => intent.id === mealOrigin.intentId);
  const beforeMeal = structuredClone({ body: eater.body, inventory: eater.inventory, giverInventory: giver.inventory });
  const alreadyBeside = api.executeActiveIntent(mealState, eater, 1, mealEvents.length, tick++, mealEvents);
  assert(alreadyBeside, 'an already-satisfied approach cannot silently finish without a body receipt');
  mealEvents.push(alreadyBeside);
  assert.equal(alreadyBeside.action.kind, 'move');
  assert.equal(alreadyBeside.status, 'completed');
  assert.equal(alreadyBeside.fromCellId, alreadyBeside.toCellId);
  assert.equal(alreadyBeside.fromZ, alreadyBeside.toZ);
  assert.equal(alreadyBeside.diff.movementCost, 0);
  assert.deepEqual({ body: eater.body, inventory: eater.inventory, giverInventory: giver.inventory }, beforeMeal);
  assert.equal(mealIntent.outcomeReceipts.at(-1).goalProgress, 'none');
  assert.equal(mealIntent.outcomeReceipts.at(-1).attempt.worldChanged, false);
  const afterApproach = api.buildDecisionRequestContext(mealContext());
  assert.equal(afterApproach.currentIntention.mentalAct.goal, mealGoal);
  assert.equal(afterApproach.currentIntention.sourceDecisionEventId, mealOrigin.id);
  assert(afterApproach.recentCompletedWork.some((entry) => entry.recentOutcomes?.some((outcome) =>
    outcome.sourceEventId === alreadyBeside.id)), 'Mind sees the actual no-movement result');

  // The same receipt policy must preserve a real acquisition's move prefix.
  const mealDrop = { id: 'meal-drop', materialId: api.Material.RawMeat, quantity: 1, quality: 50,
    cellId: api.cellId(16, 12), z: 1, sourceEventIds: ['fixture-meat'] };
  mealState.world.drops = [mealDrop];
  const pickupOrigin = api.commitDecision(mealState, eater, mealContext(), {
    kind: 'idle', reason: '取回地上的肉', authoredAttempt: { kind: 'creative' },
    nativeOperation: { kind: 'transfer', source: { kind: 'drop', dropId: mealDrop.id },
      destination: { kind: 'person', personId: eater.id }, materialId: api.Material.RawMeat, quantity: 1 },
  }, true, 1, mealEvents, tick++);
  const pickupIntent = mealState.intents.find((intent) => intent.id === pickupOrigin.intentId);
  const pickupPrefix = api.executeActiveIntent(mealState, eater, 1, mealEvents.length, tick++, mealEvents);
  mealEvents.push(pickupPrefix);
  assert.equal(pickupPrefix.action.kind, 'move');
  assert.equal(eater.activeIntentId, pickupIntent.id, 'reaching a pickup does not complete the transfer');
  assert.equal(eater.inventory.length, 0);
  assert.equal(mealDrop.quantity, 1);
  const pickup = api.executeActiveIntent(mealState, eater, 1, mealEvents.length, tick++, mealEvents);
  assert.equal(pickup.action.kind, 'transfer');
  assert.equal(pickup.status, 'completed', pickup.result);
  assert.equal(eater.inventory.filter((stack) => stack.materialId === api.Material.RawMeat).reduce((sum, stack) => sum + stack.quantity, 0), 1);
  assert.equal(pickupIntent.status, 'completed');

  // Carry one explicitly held stack to the chosen place or moving recipient.
  for (const destinationKind of ['ground', 'person']) {
    const deliveryState = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
    const carrier = deliveryState.people[0], receiver = deliveryState.people[1];
    for (let x = 10; x <= 22; x++) for (let y = 10; y <= 14; y++) for (let z = 0; z < deliveryState.world.grid.levels; z++) {
      api.setVoxel(deliveryState.world.grid, x, y, z, z === 0 ? api.Material.Stone : api.Material.Air);
    }
    carrier.position = { ...carrier.position, cellId: api.cellId(11, 12), z: 1 };
    receiver.position = { ...receiver.position, cellId: api.cellId(20, 12), z: 1 };
    carrier.inventory = [{ id: 'held-delivery', materialId: api.Material.Wood, quantity: 3, sourceEventIds: ['fixture-held-wood'] }];
    receiver.inventory = [];
    deliveryState.world.drops = [];
    const deliveryEvents = [];
    const deliveryContext = () => api.buildCurrentMonthDecisionContext(deliveryState, carrier, 1, tick, deliveryEvents);
    const destination = destinationKind === 'person' ? { kind: 'person', personId: receiver.id }
      : { kind: 'voxel', position: { x: 20, y: 12, z: 1 } };
    const deliveryOrigin = api.commitDecision(deliveryState, carrier, deliveryContext(), {
      kind: 'idle', reason: '把持有的木材带到所选目的地', authoredAttempt: { kind: 'creative' },
      nativeOperation: { kind: 'transfer', source: { kind: 'inventory-stack', personId: carrier.id, stackId: 'held-delivery' },
        destination, quantity: 1 },
    }, true, 1, deliveryEvents, tick++);
    const deliveryIntent = deliveryState.intents.find((intent) => intent.id === deliveryOrigin.intentId);
    assert(deliveryIntent, deliveryOrigin.result);
    const firstMove = api.executeActiveIntent(deliveryState, carrier, 1, deliveryEvents.length, tick++, deliveryEvents);
    deliveryEvents.push(firstMove);
    assert.equal(firstMove.action.kind, 'move');
    assert.equal(carrier.activeIntentId, deliveryIntent.id, 'walking cannot finish the selected delivery');
    assert.equal(carrier.inventory[0].quantity, 3);
    assert.equal(deliveryState.world.drops.length, 0);
    assert.equal(receiver.inventory.length, 0);
    if (destinationKind === 'ground') {
      const lostState = structuredClone(deliveryState), lostCarrier = lostState.people[0];
      lostCarrier.inventory = [{ ...lostCarrier.inventory[0], id: 'different-stack-of-wood' }];
      const unavailable = api.executeActiveIntent(lostState, lostCarrier, 1, deliveryEvents.length, tick, deliveryEvents);
      assert.equal(unavailable, null, 'loss of the named stack is reported before a delivery starts');
      const lostIntent = lostState.intents.find((intent) => intent.id === deliveryIntent.id);
      assert.equal(lostIntent.status, 'blocked');
      assert.match(lostIntent.blockedReason, /尚未交付.*不改用其他库存/);
      assert.equal(lostCarrier.inventory[0].quantity, 3);
      assert.equal(lostState.world.drops.length, 0);
    }
    if (destinationKind === 'person') receiver.position.cellId = api.cellId(21, 12);
    for (let step = 0; carrier.activeIntentId && step < 20; step++) {
      const fact = api.executeActiveIntent(deliveryState, carrier, 1, deliveryEvents.length, tick++, deliveryEvents);
      assert(fact, deliveryIntent.blockedReason);
      deliveryEvents.push(fact);
    }
    assert.equal(deliveryIntent.status, 'completed', deliveryIntent.blockedReason);
    const deliveries = deliveryEvents.filter((fact) => fact.kind === 'action' && fact.action.kind === 'transfer');
    assert.equal(deliveries.length, 1);
    const delivered = deliveries[0];
    assert.equal(delivered.action.stackId, 'held-delivery');
    assert.equal(delivered.action.quantity, 1);
    assert.equal(delivered.diff.quantity, 1);
    assert.equal(carrier.inventory[0].quantity, 2);
    const output = destinationKind === 'person' ? receiver.inventory[0] : deliveryState.world.drops[0];
    assert.equal(output.materialId, api.Material.Wood);
    assert.equal(output.quantity, 1);
    assert(output.sourceEventIds.includes('fixture-held-wood'));
    assert(output.sourceEventIds.includes(delivered.id));
    assert(output.sourceLineageKeys.includes(`inventory:${carrier.id}:held-delivery`));
    if (destinationKind === 'ground') assert.deepEqual({ cellId: output.cellId, z: output.z }, { cellId: api.cellId(20, 12), z: 1 });
    else {
      assert.equal(delivered.action.to.personId, receiver.id);
      assert(api.positionsCanTouch(deliveryState.world.grid, carrier.position, receiver.position),
        'delivery follows the same recipient at their actual position');
    }
  }
  console.log('world attempt: actual rearrangement, separate speech, preserved goal, planless outcome and technical feedback passed (mock responses, zero HTTP)');
} finally {
  globalThis.fetch = originalFetch;
  if (originalConfig === undefined) delete process.env.THREEBODY_MODEL_CONFIG;
  else process.env.THREEBODY_MODEL_CONFIG = originalConfig;
  if (originalMaxOutput === undefined) delete process.env.MODEL_DECISION_MAX_OUTPUT_TOKENS;
  else process.env.MODEL_DECISION_MAX_OUTPUT_TOKENS = originalMaxOutput;
  if (originalMindThinking === undefined) delete process.env.MODEL_MIND_THINKING;
  else process.env.MODEL_MIND_THINKING = originalMindThinking;
  if (originalWorldThinking === undefined) delete process.env.MODEL_WORLD_THINKING;
  else process.env.MODEL_WORLD_THINKING = originalWorldThinking;
  rmSync(temporary, { recursive: true, force: true });
}
