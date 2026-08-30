import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-agent-memory-'));
const simulationBundle = path.join(temporaryDirectory, 'simulation.mjs');
const memoryBundle = path.join(temporaryDirectory, 'agent-memory.mjs');
const executorBundle = path.join(temporaryDirectory, 'action-executor.mjs');

try {
  for (const [entry, output] of [
    ['src/game/eland/simulation.ts', simulationBundle],
    ['src/game/eland/domain/agent-memory.ts', memoryBundle],
    ['src/game/eland/domain/action-executor.ts', executorBundle],
  ]) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
    ], { stdio: 'pipe' });
  }

  const simulation = await import(`${pathToFileURL(simulationBundle).href}?test=${Date.now()}`);
  const memory = await import(`${pathToFileURL(memoryBundle).href}?test=${Date.now()}`);
  const executor = await import(`${pathToFileURL(executorBundle).href}?test=${Date.now()}`);

  const state = simulation.createInitialState(20260830, {
    endpoint: { kind: 'months', value: 120 },
    chaosIntensity: 0,
  });
  const [speaker, listener, third] = state.people;
  listener.position = structuredClone(speaker.position);
  third.position = structuredClone(speaker.position);
  const founding = state.world.past.find((event) => event.kind === 'environment' && event.change === 'founding');
  assert.ok(founding);

  speaker.memories.push({
    id: 'memory-test-failure', kind: 'failure', summary: '我试着处理石块但没有成功', importance: 82,
    createdAtMonth: 1, lastRecalledAtMonth: 1, personIds: [listener.id], sourceEventIds: [founding.id],
    expiresAtMonth: 6,
    causal: {
      basisKey: 'act:exert:test', actionKind: 'act', operation: 'exert', outcome: 'failed',
      valence: -0.8, consequenceTags: ['no-response'],
    },
  });
  memory.maintainAgentMemoryStore(state, 2);
  const recalledFailure = memory.retrieveAgentMemories(state, speaker, {
    atMonth: 2, personIds: [listener.id], actionBasisKey: 'act:exert:test', limit: 4,
  });
  assert.equal(recalledFailure[0]?.causalBasisKey, 'act:exert:test');
  assert.equal(recalledFailure[0]?.unresolved, true);

  const episodeId = 'conversation-episode:test-opening';
  const openingConversation = {
    version: 'grounded-conversation-v1', episodeId, basisKey: 'test-open-basis', topic: 'open', turn: 'opening',
    speakerId: speaker.id, listenerId: listener.id, sourceFactIds: [founding.id], openGroundingCompiled: true,
  };
  assert.ok(memory.reserveConversationEpisode(state, openingConversation, 'decision-open', 2));
  assert.equal(memory.reserveConversationEpisode(state, {
    ...openingConversation,
    episodeId: 'conversation-episode:reverse',
    speakerId: listener.id,
    listenerId: speaker.id,
  }, 'decision-reverse', 2), null, 'same pair cannot reserve parallel reverse opening');
  assert.equal(memory.reserveConversationEpisode(state, {
    ...openingConversation,
    episodeId: 'conversation-episode:third',
    speakerId: third.id,
    listenerId: listener.id,
  }, 'decision-third', 2), null, 'a listener cannot be occupied by two openings');

  const openingAction = {
    kind: 'communicate',
    content: { id: 'open-test', kind: 'claim', summary: '开放交谈', conversation: openingConversation },
    audience: [listener.id],
    channel: 'voice',
  };
  const openingFact = executor.executePrimitiveAction(state, speaker, openingAction, 2, 1, {
    cause: 'intent', actionTick: 1, intentId: 'intent-open',
  });
  assert.equal(openingFact.status, 'completed');
  state.world.past.push(openingFact);
  assert.equal(memory.conversationEpisodeById(state, episodeId)?.status, 'awaiting-response');
  const openingMemoryIds = memory.writeDialogueMemory(state, {
    speechLineId: 'speech-open', sourceActionEventId: openingFact.id, sourceFactIds: [founding.id], atMonth: 2,
    speakerId: speaker.id, audienceIds: [listener.id], text: '你刚才一直盯着那块石头，是不是又没弄成？',
    communicationKind: 'claim', topic: 'open', dialogueMove: 'question', disposition: 'continue',
  });
  assert.equal(openingMemoryIds.length, 2, 'speaker and listener each own one subjective dialogue memory');
  const listenerDialogue = memory.retrieveAgentMemories(state, listener, {
    atMonth: 3, lanes: ['dialogue'], personIds: [speaker.id], limit: 4,
  });
  assert.equal(listenerDialogue[0]?.exactUtterance, '你刚才一直盯着那块石头，是不是又没弄成？');
  assert.equal(listenerDialogue[0]?.unresolved, true);

  const responseConversation = {
    ...openingConversation,
    turn: 'response',
    speakerId: listener.id,
    listenerId: speaker.id,
    referenceEventId: openingFact.id,
  };
  assert.ok(memory.reserveConversationEpisode(state, responseConversation, 'decision-response', 3));
  const responseAction = {
    kind: 'communicate',
    content: { id: 'response-test', kind: 'claim', summary: '回应开放交谈', conversation: responseConversation },
    audience: [speaker.id],
    channel: 'voice',
  };
  const responseFact = executor.executePrimitiveAction(state, listener, responseAction, 3, 2, {
    cause: 'intent', actionTick: 1, intentId: 'intent-response',
  });
  assert.equal(responseFact.status, 'completed');
  state.world.past.push(responseFact);
  memory.writeDialogueMemory(state, {
    speechLineId: 'speech-response', sourceActionEventId: responseFact.id, sourceFactIds: [openingFact.id], atMonth: 3,
    speakerId: listener.id, audienceIds: [speaker.id], text: '没弄成。我以为砸开会有东西，结果还是一块石头。你觉得还要换一块试吗？',
    communicationKind: 'claim', topic: 'open', dialogueMove: 'question', disposition: 'continue',
    replyToSpeechLineId: 'speech-open',
  });
  assert.equal(memory.conversationEpisodeById(state, episodeId)?.status, 'awaiting-response');
  assert.equal(memory.pendingConversationEpisodeForListener(state, speaker.id, 4)?.id, episodeId);

  const thirdConversation = {
    ...responseConversation,
    speakerId: speaker.id,
    listenerId: listener.id,
    referenceEventId: responseFact.id,
  };
  assert.ok(memory.reserveConversationEpisode(state, thirdConversation, 'decision-third-turn', 4));
  const thirdAction = {
    kind: 'communicate',
    content: { id: 'third-turn-test', kind: 'claim', summary: '继续回应', conversation: thirdConversation },
    audience: [listener.id],
    channel: 'voice',
  };
  const thirdFact = executor.executePrimitiveAction(state, speaker, thirdAction, 4, 3, {
    cause: 'intent', actionTick: 1, intentId: 'intent-third-turn',
  });
  assert.equal(thirdFact.status, 'completed');
  state.world.past.push(thirdFact);
  memory.writeDialogueMemory(state, {
    speechLineId: 'speech-third', sourceActionEventId: thirdFact.id, sourceFactIds: [responseFact.id], atMonth: 4,
    speakerId: speaker.id, audienceIds: [listener.id], text: '先换一块试试；还是没反应，就别再耗力气了。',
    communicationKind: 'claim', topic: 'open', dialogueMove: 'close', disposition: 'close',
    replyToSpeechLineId: 'speech-response',
  });
  assert.equal(memory.conversationEpisodeById(state, episodeId)?.status, 'closed');
  const rememberedBySpeaker = memory.retrieveAgentMemories(state, speaker, {
    atMonth: 4, lanes: ['dialogue'], personIds: [listener.id], limit: 4,
  });
  assert.ok(rememberedBySpeaker.some((item) => item.exactUtterance?.includes('还是一块石头')));
  assert.equal(rememberedBySpeaker.find((item) => item.exactUtterance?.includes('刚才一直盯着'))?.unresolved, false);

  const interactionMemoryIds = memory.writePlayerInteractionMemory(state, {
    interactionId: 'agent-conversation:test-1', atMonth: 4, agentId: speaker.id,
    userMessage: '你还想继续试那块石头吗？',
    agentReply: '想，但我会先换个办法。',
  });
  assert.equal(interactionMemoryIds.length, 2);
  const playerDialogue = memory.retrieveAgentMemories(state, speaker, {
    atMonth: 4, lanes: ['dialogue'], limit: 8,
  });
  assert.ok(playerDialogue.some((item) => item.dialogueSpeakerId === 'player'
    && item.exactUtterance === '你还想继续试那块石头吗？'));

  const sourceItems = memory.agentMemoryStoreOf(state).items
    .filter((item) => item.ownerId === speaker.id && item.lane === 'dialogue')
    .slice(0, 2);
  const consolidated = memory.applyModelMemoryConsolidation(state, speaker.id, {
    sourceItemIds: sourceItems.map((item) => item.id),
    gist: '我问起那次失败，对方承认原先的办法没有得到想要的结果。',
    topicKeys: ['失败复盘'], unresolved: false, emotionalValence: -0.2,
  }, 4);
  assert.ok(consolidated);
  assert.equal(consolidated.consolidation.source, 'model');
  assert.equal(memory.applyModelMemoryConsolidation(state, speaker.id, {
    sourceItemIds: ['unknown-memory'], gist: '伪造概括', topicKeys: [], unresolved: false, emotionalValence: 0,
  }, 4), null, 'unknown memory handles fail closed');

  state.clock.elapsedMonths = 80;
  memory.maintainAgentMemoryStore(state, 80);
  const oldDialogue = memory.retrieveAgentMemories(state, listener, {
    atMonth: 80, lanes: ['dialogue'], limit: 8,
  });
  assert.equal(oldDialogue.some((item) => item.exactUtterance), false, 'old dialogue loses verbatim wording');
  assert.ok(oldDialogue.some((item) => item.precision === 'faint' || item.precision === 'general'),
    'old dialogue remains as a lossy gist before complete forgetting');

  process.stdout.write('agent memory store tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
