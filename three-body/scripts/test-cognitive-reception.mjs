import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = mkdtempSync(path.join(tmpdir(), 'eland-cognitive-reception-'));
try {
  const bundle = path.join(temporary, 'test.mjs');
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=cognitive-reception-test.ts', `--outfile=${bundle}`, '--log-level=error',
  ], { input: `export { createInitialState, stepSimulationAsync, buildDecisionContexts } from './src/game/eland/simulation';
    export { executePrimitiveAction } from './src/game/eland/domain/action-executor';
    export { applyDecision, commitDecision, executeActiveIntent } from './src/game/eland/application/simulation/intent-execution';
    export { rememberDecisionLanguage } from './src/game/eland/domain/agent-memory';
    export { perceivedLanguageText } from './src/game/eland/domain/language-perception';
    export { recentDialogueForDecision } from './src/game/eland/application/model-decision/recent-dialogue';
    export { buildDecisionRequestContext } from './src/game/eland/application/model-decision/decision-context';
    export { buildDecisionModelRequestProtocol } from './server/model-decision-gateway';
    export { Material } from './src/game/eland/domain/material';
    export { cellX, cellY, surfaceStandingPosition } from './src/game/eland/world/grid';
    export { unreviewedLanguageSources, acknowledgeLanguageSources } from './src/game/eland/application/simulation/cognitive-reception';`,
    stdio: ['pipe', 'pipe', 'pipe'] });
  const api = await import(pathToFileURL(bundle).href);
  const broadcast = { version: 'language-broadcast-v2', sourceEventId: 'one-wave', text: '可听见的一句话',
    decodedByPersonIds: ['listener'], perceivedByPersonIds: ['listener'], receptions: [] };
  const sameWaveEvents = [
    { id: 'one-wave', kind: 'decision', who: 'speaker', languageBroadcast: broadcast },
    { id: 'later-talk', kind: 'action', who: 'speaker', diff: { languageBroadcast: broadcast } },
  ];
  const reviewed = new Map();
  assert.deepEqual(api.unreviewedLanguageSources(sameWaveEvents, reviewed).get('listener'), ['one-wave']);
  api.acknowledgeLanguageSources(reviewed, 'listener', ['one-wave']);
  assert.equal(api.unreviewedLanguageSources(sameWaveEvents, reviewed).size, 0,
    'the same outward wave cannot become a second input when its talk action is committed');
  assert.equal(api.unreviewedLanguageSources([{ ...sameWaveEvents[0], languageBroadcast: {
    ...broadcast, decodedByPersonIds: [], perceivedByPersonIds: ['listener'],
  } }], new Map()).size, 0, 'detection alone does not establish receipt of a readable message');

  const state = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  const [speaker, listener, bystander] = state.people;
  for (const person of state.people) person.position = structuredClone(speaker.position);
  const calls = new Map();
  const consumedByPerson = new Map();
  const order = [];
  const mind = (text, plan) => ({
    version: 'mental-act-v2', kind: 'talk', utterance: text, delivery: 'call',
    speechIntent: { kind: 'expression' }, goal: '由本人判断是否继续交流', strategy: '依据刚发生的事情决定',
    assumptions: [], sourceEventIds: [], ...(plan ? { plan } : {}),
  });
  const result = await api.stepSimulationAsync(state, {
    ownsVoluntarySocialChoices: true,
    async decideAll(contexts) {
      return contexts.map((context) => {
        const id = context.person.id;
        const count = (calls.get(id) ?? 0) + 1;
        calls.set(id, count);
        if (context.reconsideration?.reason === 'heard-language') {
          order.push(`mind:${id}`);
          const seen = consumedByPerson.get(id) ?? new Set();
          for (const source of context.reconsideration.sourceEventIds) {
            assert(!seen.has(source), 'a reception must be offered once even if the person chooses silence');
            seen.add(source);
          }
          consumedByPerson.set(id, seen);
        }
        if (count === 1 && id === listener.id) {
          const target = { kind: 'person', personId: id };
          return { kind: 'idle', reason: '先完成本人选定的观察', mentalAct: mind('', {
            version: 'mental-plan-translation-v1', disposition: 'act', steps: ['观察', '按结果继续'],
            completion: { step: { description: '观察结果', conditions: [] }, goal: { description: '后续选择', conditions: [] } },
          }), executionProbe: { kind: 'world-interaction', adjudication: {
            version: 'world-adjudicated-interaction-v1', request: '观察手中物品', result: '本人记录一次观察',
            targets: [target], status: 'completed', effects: [{ kind: 'knowledge', summary: '本人注意到手中物品仍在' }],
          } } };
        }
        if (id === bystander.id || count > 3) return { kind: 'idle', reason: '本人选择不再回应，继续原有事情' };
        return { kind: 'idle', reason: '本人决定交流', mentalAct: mind(`${context.person.name}的第${count}次自愿表达`) };
      });
    },
    async continuePlans(contexts) {
      return contexts.map((context) => {
        order.push(`plan:${context.person.id}`);
        return { kind: 'idle', reason: '这一计划先保留', mentalAct: mind('', {
          version: 'mental-plan-translation-v1', disposition: 'stay', steps: ['保留已经发生的结果'],
        }) };
      });
    },
  });
  assert((calls.get(speaker.id) ?? 0) > 2 && (calls.get(listener.id) ?? 0) > 2,
    'new exchanges within one month must not be suppressed by a two-Mind quota');
  assert.equal(order.find((item) => item.endsWith(listener.id)), `mind:${listener.id}`,
    'a just-received message must not disappear behind continuation of the listener\'s completed step');
  assert.equal(result.agreements.length, 0, 'a chance to hear and think does not establish agreement');
  const receiptDecisions = result.world.past.filter((event) => event.kind === 'decision' && event.reconsideration?.reason === 'heard-language');
  assert(receiptDecisions.length > 2);
  assert(receiptDecisions.every((event) => event.reconsideration.sourceEventIds.length));
  assert((calls.get(bystander.id) ?? 0) < 15, 'choosing silence must not reopen a source every tick');

  const deferredScenario = async (mode) => {
    const initial = api.createInitialState(31, { endpoint: { kind: 'months', value: 3 } });
    const [firstSpeaker, worker, secondSpeaker] = initial.people;
    for (const person of initial.people) {
      person.position = structuredClone(firstSpeaker.position);
      person.body = { health: 100, hydration: 100, nutrition: 100 };
      person.conditions = [];
      // Supply both months of this cognition fixture: elapsed-time meals
      // must not consume the observation target before the last-tick plan.
      person.inventory.find((stack) => stack.materialId === api.Material.Food).quantity = 12;
    }
    worker.knowledge = [];
    const originalWords = `我先查看自己的食物，再继续准备-${mode}`;
    const activePlan = { version: 'mental-plan-translation-v1', disposition: 'act', steps: ['查看食物', '根据结果查看地面'],
      completion: { step: { description: '当前观察', conditions: [] }, goal: { description: '继续准备', conditions: [] } } };
    const workerMind = { ...mind(originalWords, activePlan), kind: 'pursue', horizon: 'ongoing', goal: '先观察再继续原有准备' };
    const seenCalls = new Map();
    const schedulingOrder = [];
    const continuedSources = [];
    const speechCounts = new Map();
    let changed = false;
    let openingDecisionMade = false;
    const keep = { kind: 'idle', attention: 'keep-current', reason: '听到了，仍按刚才的安排继续',
      ...(mode === 'keep' ? { declaration: { utterance: '我听到了，仍继续手头的准备。', delivery: 'normal',
        speechIntent: { kind: 'expression' }, sourceEventIds: [] } } : {}) };
    const nextPlan = async (contexts) => contexts.map((context) => {
      if (context.person.id !== worker.id) return { kind: 'idle', reason: '保持已有选择' };
      schedulingOrder.push(`plan:${context.planningTick}`);
      continuedSources.push({ month: context.decisionMonth, sourceIntentId: context.continuingPlan.sourceIntentId,
        origin: context.continuingPlan.sourceDecisionEventId, receipts: context.continuingPlan.outcomeReceipts });
      if (continuedSources.length > 1) return { kind: 'idle', reason: '这次准备先停在这里', mentalAct: {
        ...context.continuingPlan.mentalAct, plan: { ...activePlan, disposition: 'stay' },
      } };
      const position = context.person.position;
      return { kind: 'idle', reason: '沿原目标执行下一次观察', mentalAct: {
        ...context.continuingPlan.mentalAct, plan: structuredClone(activePlan),
      }, nativeOperation: { kind: 'observe', target: { kind: 'voxel', position: {
        x: api.cellX(position.cellId), y: api.cellY(position.cellId), z: position.z - 1,
      } } } };
    });
    const afterFirstMonth = await api.stepSimulationAsync(initial, {
      ownsVoluntarySocialChoices: true,
      async decideAll(contexts) {
        return contexts.map((context) => {
          const id = context.person.id;
          seenCalls.set(id, (seenCalls.get(id) ?? 0) + 1);
          if (id !== worker.id) {
            const ordinal = (speechCounts.get(id) ?? 0) + 1;
            speechCounts.set(id, ordinal);
            return { kind: 'idle', reason: '本人继续交换刚想到的新消息', mentalAct: mind(`${context.person.name}的新消息-${mode}-${ordinal}`) };
          }
          if (!openingDecisionMade && (mode !== 'month-end' || context.planningTick === 15)) {
            openingDecisionMade = true;
            return { kind: 'idle', reason: '先完成一个短观察', mentalAct: structuredClone(workerMind),
              nativeOperation: { kind: 'observe', target: { kind: 'inventory-stack', personId: worker.id, stackId: worker.inventory[0].id } } };
          }
          if (context.reconsideration?.reason === 'heard-language') {
            schedulingOrder.push(`mind:${context.planningTick}`);
            if (mode === 'replace' && !changed) {
              changed = true;
              return { kind: 'idle', reason: '听后决定换个目标，暂不继续准备', mentalAct: {
                ...mind('', { ...activePlan, disposition: 'stay' }), kind: 'wait', goal: '改为等待同伴，结束原准备',
              } };
            }
          }
          return structuredClone(keep);
        });
      },
      continuePlans: nextPlan,
    });
    assert((speechCounts.get(firstSpeaker.id) ?? 0) > 3 && (speechCounts.get(secondSpeaker.id) ?? 0) > 3,
      'other people keep introducing new speech throughout this month');
    const original = afterFirstMonth.world.past.find((event) => event.kind === 'decision'
      && event.who === worker.id && event.decision.mentalAct?.utterance === originalWords);
    assert(original?.intentId);
    const firstAction = afterFirstMonth.world.past.find((event) => event.kind === 'action' && event.intentId === original.intentId);
    assert.equal(firstAction?.status, 'completed', 'the worker really completed the short first atom');
    assert.equal(afterFirstMonth.intents.find((intent) => intent.id === original.intentId).status, 'completed');
    if (mode === 'replace') {
      assert.equal(continuedSources.length, 0, 'a new Mind goal removes the old pending continuation');
      return;
    }
    if (mode === 'keep') {
      assert(afterFirstMonth.world.past.some((event) => event.kind === 'decision' && event.who === worker.id
        && event.decision.declaration?.utterance && !event.decision.mentalAct));
      assert(continuedSources.length > 0, 'a completed atom must still reach Plan after Mind keeps its goal');
      assert.equal(continuedSources[0].sourceIntentId, original.intentId);
      assert(continuedSources[0].receipts.some((receipt) => receipt.actionEventId === firstAction.id));
      const firstPlan = schedulingOrder.find((entry) => entry.startsWith('plan:'));
      assert(firstPlan);
      const plannedTick = firstPlan.split(':')[1];
      assert(schedulingOrder.indexOf(`mind:${plannedTick}`) < schedulingOrder.indexOf(firstPlan),
        'keep-current resumes Plan immediately after that hearing turn, even while others keep speaking');
      assert(afterFirstMonth.world.past.some((event) => event.kind === 'action' && event.who === worker.id
        && event.intentId !== original.intentId && event.action.kind === 'attend' && event.action.target.kind === 'voxel'));
    } else {
      assert.equal(firstAction.actionTick, 15);
      assert.equal(continuedSources.length, 0, 'the month ended before the last tick outcome could reach Plan');
    }
    const sourcesBeforeSecondMonth = continuedSources.length;
    const afterSecondMonth = await api.stepSimulationAsync(afterFirstMonth, {
      ownsVoluntarySocialChoices: true,
      async decideAll(contexts) { return contexts.map(() => structuredClone(keep)); },
      continuePlans: nextPlan,
    });
    if (mode === 'month-end') {
      assert(continuedSources.length > sourcesBeforeSecondMonth, 'next month reconstructs the undelivered result from its original Intent');
      assert.equal(continuedSources[0].sourceIntentId, original.intentId);
      assert.equal(continuedSources[0].origin, original.id);
      assert.equal(continuedSources[0].month, 2);
    } else assert.equal(continuedSources.length, sourcesBeforeSecondMonth, 'an explicitly stopped or consumed Plan is not restarted next month');
    const originalWaves = afterSecondMonth.world.past.flatMap((event) => {
      const wave = event.kind === 'decision' ? event.languageBroadcast : event.kind === 'action' ? event.diff.languageBroadcast : undefined;
      return wave?.text === originalWords ? [wave.sourceEventId] : [];
    });
    assert.equal(new Set(originalWaves).size, 1, 'silent continuation never repeats the original Mind utterance');
  };
  await deferredScenario('keep');
  await deferredScenario('replace');
  await deferredScenario('month-end');

  const pendingState = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  const [requester, responder] = pendingState.people;
  responder.position = structuredClone(requester.position);
  const invitation = api.executePrimitiveAction(pendingState, requester, {
    kind: 'talk', delivery: 'call', speakerMeaning: {
      id: 'pending-company-request', kind: 'request', summary: '愿意在这里陪我待一会儿吗？',
      proposal: { kind: 'assist', requesterId: requester.id, helperId: responder.id,
        need: 'company', expiresAtMonth: 5 },
    },
  }, 1, 0, { cause: 'intent', actionTick: 1 });
  assert.equal(invitation.status, 'completed');
  pendingState.world.past.push(invitation);
  assert(pendingState.agreements.some((agreement) => agreement.status === 'proposed'));
  const responseContext = api.buildDecisionContexts(pendingState, 1).find((context) => context.person.id === responder.id);
  assert(responseContext.options.some((option) => (option.completionAction ?? option.nextAction).speakerMeaning?.kind === 'accept'),
    'an unanswered proposal must still offer the independent choice to accept');
  const ordinaryAction = responseContext.options.find((option) => ['move', 'transfer'].includes(option.nextAction.kind));
  assert(ordinaryAction, 'an unanswered proposal must not erase otherwise available physical actions');
  const physicalResult = api.executePrimitiveAction(pendingState, responder, ordinaryAction.nextAction, 1, 1,
    { cause: 'intent', actionTick: 2 });
  assert.notEqual(physicalResult.status, 'blocked', physicalResult.result);
  assert(pendingState.agreements.every((agreement) => agreement.status === 'proposed'),
    'doing something else neither accepts nor rejects the pending proposal');

  const nativeState = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  const [firstVoice, secondVoice, unheard] = nativeState.people;
  secondVoice.position = structuredClone(firstVoice.position);
  unheard.position = api.surfaceStandingPosition(nativeState.world.grid, nativeState.world.grid.width * nativeState.world.grid.depth - 1);
  assert(unheard.position, 'the distant witness has a real standing position');
  const voiceEvents = [];
  const decisionsWithWaves = [];
  for (const [index, text] of ['你看到木头了吗？', '看到了，就在附近。', '那石头在哪里？', '石头也在旁边。'].entries()) {
    const actor = index % 2 === 0 ? firstVoice : secondVoice;
    const context = { ...api.buildDecisionContexts(nativeState, 1).find((context) => context.person.id === actor.id),
      planningTick: index + 1, currentMonthEvents: [...voiceEvents] };
    const chosen = { kind: 'idle', reason: '本人决定发言', nativeOperation: { kind: 'speech' }, mentalAct: {
      ...mind(text), speechIntent: { kind: index % 2 === 0 ? 'request-information' : 'expression' },
    } };
    const eventStart = voiceEvents.length;
    const decision = api.commitDecision(nativeState, actor, context, chosen, true, 1, voiceEvents, index + 1);
    decisionsWithWaves.push(decision);
    const action = voiceEvents[eventStart + 1];
    assert.equal(api.executeActiveIntent(nativeState, actor, 1, voiceEvents.length, index + 1, voiceEvents), null,
      'a committed speech intent is terminal and cannot emit a second talk');
    assert.equal(action.cause, 'decision-language');
    assert.deepEqual(nativeState.intents.find((intent) => intent.id === decision.intentId).actionEventIds, [action.id]);
    assert.equal(action?.action.kind, 'talk');
    assert.equal(action.status, 'completed');
    assert.equal(action.action.speakerMeaning.conversation, undefined, 'this is native speech without the old conversation wrapper');
    assert.equal(action.diff.languageBroadcast.sourceEventId, decision.id, 'talk reuses the Decision wave');
    nativeState.world.past.push(decision, action);
  }
  const firstWave = decisionsWithWaves[0];
  assert(firstWave.languageBroadcast.decodedByPersonIds.includes(secondVoice.id), 'the near listener really decoded the opening');
  assert(!firstWave.languageBroadcast.perceivedByPersonIds.includes(unheard.id), 'the distant witness did not hear it');
  const memories = nativeState.memoryStore.items.filter((memory) => memory.ownerId === secondVoice.id
    && memory.sourceEventIds.includes(firstWave.id) && memory.lane === 'dialogue');
  assert.equal(memories.length, 1, 'native speech saves an exact sourced dialogue memory without a UI speech-line store');
  assert(memories[0].exactUtterance);
  api.rememberDecisionLanguage(nativeState, firstWave);
  assert.equal(nativeState.memoryStore.items.filter((memory) => memory.ownerId === secondVoice.id
    && memory.sourceEventIds.includes(firstWave.id) && memory.lane === 'dialogue').length, 1,
  'recording an existing wave does not duplicate its personal memory');
  const listenerContext = { ...api.buildDecisionContexts(nativeState, 1).find((context) => context.person.id === secondVoice.id),
    planningTick: 5, currentMonthEvents: [...voiceEvents].reverse(),
    reconsideration: { reason: 'heard-language', sourceEventIds: [voiceEvents.find((event) => event.kind === 'action'
      && event.diff.languageBroadcast.sourceEventId === decisionsWithWaves[2].id).id] } };
  const expected = decisionsWithWaves.filter((decision) => decision.who === secondVoice.id
    || decision.languageBroadcast.decodedByPersonIds.includes(secondVoice.id));
  const dialogue = api.recentDialogueForDecision(listenerContext);
  assert.deepEqual(dialogue.map((line) => line.sourceEventId), expected.map((decision) => decision.id),
    'same-month speech is chronological, includes self, and deduplicates later talk copies');
  for (const [index, decision] of expected.entries()) {
    assert.equal(dialogue[index].speaker, nativeState.people.find((person) => person.id === decision.who).name);
    assert.equal(dialogue[index].text, api.perceivedLanguageText({ broadcast: decision.languageBroadcast,
      observerId: secondVoice.id, speakerId: decision.who, seed: nativeState.seed }));
  }
  const projectedDialogue = api.buildDecisionModelRequestProtocol(api.buildDecisionRequestContext(listenerContext)).mindContext.recentDialogue;
  assert.deepEqual(projectedDialogue.map((line) => line.sourceEventId), expected.map((decision) => decision.id),
    'the actual Mind projection must retain the selected dialogue rather than truncate away the latest turns');
  assert(projectedDialogue.some((line) => line.sourceEventId === decisionsWithWaves[2].id && line.currentInput));
  const unheardContext = { ...api.buildDecisionContexts(nativeState, 1).find((context) => context.person.id === unheard.id),
    planningTick: 5, currentMonthEvents: voiceEvents };
  assert.equal(api.recentDialogueForDecision(unheardContext).length, 0, 'unheard dialogue never enters the bystander context');

  const missingMemory = structuredClone(nativeState);
  missingMemory.memoryStore.items = [];
  const sourceTalk = voiceEvents.find((event) => event.kind === 'action' && event.diff.languageBroadcast.sourceEventId === firstWave.id);
  const committedLine = { id: 'legacy-ui-line', authority: 'projection-only', source: 'decision-model',
    sourceEventId: sourceTalk.id, month: 1, planningTick: sourceTalk.planningTick ?? sourceTalk.actionTick,
    speakerId: firstVoice.id, speakerName: firstVoice.name, perceivedByPersonIds: firstWave.languageBroadcast.perceivedByPersonIds,
    perceivedByPersonNames: [], communicationKind: sourceTalk.action.speakerMeaning.kind,
    speechAct: { kind: sourceTalk.action.speakerMeaning.kind }, text: firstWave.languageBroadcast.text };
  const legacyContext = { ...listenerContext, state: missingMemory,
    person: missingMemory.people.find((person) => person.id === secondVoice.id), decisionMonth: 2, currentMonthEvents: [] };
  assert.equal(api.recentDialogueForDecision(legacyContext, [committedLine])[0]?.sourceEventId, firstWave.id,
    'a verified recent external line remains a fallback for missing personal storage');
  assert.equal(api.recentDialogueForDecision({ ...legacyContext, decisionMonth: 100 }, [committedLine]).length, 0,
    'the external store must not restore faded dialogue from the distant past');
  const declarationState = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  const [declarer, invitee, absent] = declarationState.people;
  invitee.position = structuredClone(declarer.position);
  absent.position = api.surfaceStandingPosition(declarationState.world.grid,
    declarationState.world.grid.width * declarationState.world.grid.depth - 1);
  const declaredEvents = [];
  const declarationContext = (person, tick) => ({ ...api.buildDecisionContexts(declarationState, 1)
    .find((context) => context.person.id === person.id), decisionMonth: 1, planningTick: tick,
    currentMonthEvents: declaredEvents });
  const declaredWords = '你愿意和我一起把木头搬到那边吗？我先看一下脚下。';
  const jointMind = { ...mind(declaredWords), speechIntent: { kind: 'proposal', proposalKind: 'joint-action',
    counterpartIds: [invitee.id], proposal: { kind: 'joint-action', proposerId: declarer.id,
      inviteeIds: [invitee.id], summary: declaredWords } } };
  const bodyChoice = (person, mentalAct) => ({ kind: 'idle', reason: '本人查看当前身体',
    nativeOperation: { kind: 'observe', target: { kind: 'person', personId: person.id } }, mentalAct });
  const beforeHistory = declarationState.world.past.length;
  const declaration = api.commitDecision(declarationState, declarer, declarationContext(declarer, 1),
    bodyChoice(declarer, jointMind), true, 1, declaredEvents, 1);
  assert.equal(declarationState.world.past.length, beforeHistory, 'application commit appends the supplied event stream, never private world history');
  assert.deepEqual(declaredEvents.map((event) => event.kind), ['decision', 'action']);
  const declaredTalk = declaredEvents[1];
  assert.equal(declaredTalk.action.kind, 'talk');
  assert.equal(declaredTalk.intentId, undefined, 'the declaration does not claim authorization from the body intent');
  assert.equal(declaredTalk.diff.languageBroadcast, declaration.languageBroadcast);
  const pendingInvitation = declarationState.agreements.find((agreement) => agreement.proposal.kind === 'joint-action');
  assert(pendingInvitation, 'the declared proposal exists before the first body action can execute or be interrupted');
  assert.equal(pendingInvitation.proposalEventId, declaredTalk.id);
  assert.deepEqual(pendingInvitation.acceptedByPersonIds, [declarer.id]);
  assert(!pendingInvitation.knownToPersonIds.includes(absent.id));
  const selectedBodyId = declarer.activeIntentId;
  assert.equal(declarationState.intents.find((intent) => intent.id === selectedBodyId).nextAction.kind, 'attend');
  api.commitDecision(declarationState, declarer, declarationContext(declarer, 2),
    { kind: 'idle', reason: '保留原安排', attention: 'keep-current' }, true, 1, declaredEvents, 2);
  assert.equal(declaredEvents.filter((event) => event.kind === 'action').length, 1);
  assert.equal(declarer.activeIntentId, selectedBodyId);
  const unchangedBody = structuredClone(declarationState.intents.find((intent) => intent.id === selectedBodyId));
  const agendaBeforeDeclaration = structuredClone(declarer.characterAgenda);
  const retainedWords = '我听见了，仍先查看脚下。';
  const retainedFact = api.commitDecision(declarationState, declarer, declarationContext(declarer, 2),
    { kind: 'idle', reason: '保留原安排并说新话', attention: 'keep-current', declaration: {
      utterance: retainedWords, delivery: 'normal', speechIntent: { kind: 'expression' }, sourceEventIds: [declaration.id],
    } }, true, 1, declaredEvents, 2);
  assert.equal(retainedFact.decision.mentalAct, undefined);
  assert.equal(retainedFact.intentId, undefined);
  assert.equal(declaredEvents.at(-1).diff.languageSourceEventId, retainedFact.id);
  assert.deepEqual(declarationState.intents.find((intent) => intent.id === selectedBodyId), unchangedBody,
    'new words cannot replace, complete, or append work to the retained body intent');
  assert.deepEqual(declarer.characterAgenda, agendaBeforeDeclaration);
  assert(declarationState.memoryStore.items.some((entry) => entry.ownerId === invitee.id
    && entry.sourceEventIds.includes(retainedFact.id) && entry.exactUtterance === retainedWords));
  api.commitDecision(declarationState, declarer, declarationContext(declarer, 3),
    { ...bodyChoice(declarer, mind('我改为查看脚下地面。')), nativeOperation: { kind: 'observe',
      target: { kind: 'voxel', position: { x: api.cellX(declarer.position.cellId),
        y: api.cellY(declarer.position.cellId), z: declarer.position.z - 1 } } } }, true, 1, declaredEvents, 3);
  assert.notEqual(declarer.activeIntentId, selectedBodyId);
  assert.equal(pendingInvitation.status, 'proposed', 'changing the body arrangement cannot revoke words already spoken');
  const intentCountBeforeReply = declarationState.intents.length;
  api.commitDecision(declarationState, invitee, declarationContext(invitee, 4), {
    kind: 'idle', reason: '保持安排并接受邀请', attention: 'keep-current', declaration: {
      utterance: '我愿意一起搬木头。', delivery: 'normal', sourceEventIds: [declaredTalk.id],
      speechIntent: { kind: 'accept', referenceId: pendingInvitation.id },
    } },
  true, 1, declaredEvents, 4);
  assert.equal(pendingInvitation.status, 'active', "only the invitee's own later declaration accepts the proposal");
  assert.deepEqual(new Set(pendingInvitation.acceptedByPersonIds), new Set([declarer.id, invitee.id]));
  assert(declarer.activeIntentId, 'the existing body intent remains executable');
  assert.equal(invitee.activeIntentId, undefined);
  assert.equal(declarationState.intents.length, intentCountBeforeReply, 'replying without a body plan creates no placeholder goal or intent');
  const speechCount = declaredEvents.filter((event) => event.kind === 'action').length;
  const bodyFact = api.executeActiveIntent(declarationState, declarer, 1, declaredEvents.length, 5, declaredEvents);
  assert.equal(bodyFact.action.kind, 'attend');
  assert.equal(declaredEvents.filter((event) => event.kind === 'action').length, speechCount,
    'executing the body plan does not replay its earlier declaration');
  const spokenPlanState = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  for (const person of spokenPlanState.people) {
    person.body = { health: 100, hydration: 100, nutrition: 100 };
    person.conditions = [];
  }
  const speakingId = spokenPlanState.people[0].id;
  let selectedSpeech = false;
  const translatedSpeechOrigins = [];
  const spokenPlan = { version: 'mental-plan-translation-v1', disposition: 'act',
    steps: ['把我的问题说出来', '根据结果决定下一步'],
    completion: { step: { description: '实际发言', conditions: [] }, goal: { description: '根据结果继续', conditions: [] } } };
  const spokenPlanResult = await api.stepSimulationAsync(spokenPlanState, {
    ownsVoluntarySocialChoices: true,
    async decideAll(contexts) { return contexts.map((context) => {
      if (context.person.id !== speakingId || selectedSpeech) return { kind: 'idle', attention: 'keep-current', reason: '继续原安排' };
      selectedSpeech = true;
      return { kind: 'idle', reason: '本人先表达问题', nativeOperation: { kind: 'speech' },
        mentalAct: mind('我想知道附近有什么材料。', spokenPlan) };
    }); },
    async continuePlans(contexts) { return contexts.map((context) => {
      translatedSpeechOrigins.push(context.continuingPlan.sourceDecisionEventId);
      assert(context.continuingPlan.outcomeReceipts.some((receipt) => receipt.execution === 'performed'));
      return { kind: 'idle', reason: '已经说完，这一计划先停在这里', mentalAct: {
        ...context.continuingPlan.mentalAct, plan: { ...spokenPlan, disposition: 'stay' },
      } };
    }); },
  });
  const spokenFacts = spokenPlanResult.world.past.filter((event) => event.kind === 'action'
    && event.who === speakingId && event.cause === 'decision-language');
  assert.equal(spokenFacts.length, 1);
  assert.deepEqual(translatedSpeechOrigins, [spokenFacts[0].diff.languageSourceEventId],
    'a speech intent completed during decision commit receives same-month Plan continuation, without another Mind wave');
  console.log('Cognitive reception: sourced same-month reconsideration, independent silence and no duplicate wave passed.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
