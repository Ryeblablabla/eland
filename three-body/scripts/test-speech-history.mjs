import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-speech-history-test-'));

async function bundledImport(entry, name) {
  const output = path.join(temporaryDirectory, `${name}.mjs`);
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
  ], { stdio: 'pipe' });
  return import(`${pathToFileURL(output).href}?test=${Date.now()}`);
}

try {
  const speechProjection = await bundledImport(
    'src/game/eland/projection/speech-history.ts',
    'speech-history',
  );
  const { toAgentHistory } = await bundledImport('src/game/eland/adapter.ts', 'adapter');
  const chronicle = await bundledImport(
    'server/eland-session/chronicle-projection.ts',
    'chronicle-projection',
  );
  const { finalizeChronicleEntries } = await bundledImport(
    'server/eland-session/frame-history-projector.ts',
    'frame-history-projector',
  );

  const communication = {
    id: 'event-voice', kind: 'action', atMonth: 2, orderInMonth: 1,
    planningTick: 2, orderInTick: 0, actionTick: 3, cellId: 4,
    who: 'speaker', cause: 'intent', status: 'completed',
    action: {
      kind: 'communicate', audience: ['listener'], channel: 'voice',
      content: {
        id: 'conversation-care', kind: 'claim', summary: '接住这段普通回忆，补上一件自己仍然记得的小事。',
        conversation: {
          version: 'grounded-conversation-v1', basisKey: 'memory:shared-work',
          topic: 'reminiscence', turn: 'opening', speakerId: 'speaker', listenerId: 'listener',
          sourceFactIds: [],
        },
      },
    },
    fromCellId: 4, toCellId: 4, fromZ: 1, toZ: 1, pathSegment: [],
    result: '托尔向婉儿表达：接住这段普通回忆，补上一件自己仍然记得的小事。',
    diff: {},
  };
  const otherAction = {
    ...communication,
    id: 'event-work', orderInMonth: 2, actionTick: 4, planningTick: 4,
    action: { kind: 'move', toCellId: 5 },
    result: '托尔移动到了相邻格位。',
  };
  const eventById = new Map([
    [communication.id, communication],
    [otherAction.id, otherAction],
  ]);
  const validLine = {
    id: 'speech:branch:event-voice', authority: 'projection-only',
    sourceEventId: communication.id, sourceFactIds: [], month: 2, planningTick: 2,
    speakerId: 'speaker', speakerName: '托尔', audienceIds: ['listener'], audienceNames: ['婉儿'],
    channel: 'voice', communicationKind: 'claim',
    speechAct: { version: 'speech-act-v1', kind: 'claim', subject: '共同回忆' },
    text: '你还记得我们第一次找到水的那天吗？',
    dialogueMove: 'question', disposition: 'continue', source: 'speech-model',
  };
  const communicationEntry = {
    id: 'narrative:event-voice', month: 2,
    text: '托尔对婉儿说：接住这段普通回忆，补上一件自己仍然记得的小事。',
    detail: '当面交谈。', tone: 'plain', kind: 'action', importance: 88,
    sourceEventIds: ['event-voice'], actorIds: ['speaker'],
  };
  const projectEntry = {
    ...communicationEntry,
    id: 'narrative:project:well:2',
    text: '托尔和婉儿完成了水井。',
  };
  const mixedEntry = {
    ...communicationEntry,
    id: 'narrative:event-voice',
    text: '多条事实合并成一段记录。',
    sourceEventIds: ['event-voice', 'event-work'],
  };

  const originalEntry = structuredClone(communicationEntry);
  const originalEvent = structuredClone(communication);
  const projected = speechProjection.projectSpeechHistoryEntries(
    [communicationEntry, projectEntry, mixedEntry],
    [validLine],
    eventById,
  );
  assert.equal(projected[0].text, '托尔对婉儿说：“你还记得我们第一次找到水的那天吗？”');
  assert.equal(projected[1].text, projectEntry.text, '项目条目不能被单条台词覆盖');
  assert.equal(projected[2].text, mixedEntry.text, '多来源条目不能被单条台词覆盖');
  assert.deepEqual(communicationEntry, originalEntry, '台词历史投影不得修改原纪事条目');
  assert.deepEqual(communication, originalEvent, '台词历史投影不得修改 ActionFact');
  assert.equal(
    speechProjection.projectSpeechHistoryEntries(
      [communicationEntry],
      [{ ...validLine, text: '这件事我一直记得' }],
      eventById,
    )[0].text,
    '托尔对婉儿说：“这件事我一直记得。”',
    '模型没有提供末尾标点时，应在引号内补全句号',
  );

  for (const invalidLine of [
    { ...validLine, source: 'rule' },
    { ...validLine, text: '   ' },
    { ...validLine, sourceEventId: 'event-work' },
    { ...validLine, audienceIds: ['someone-else'] },
  ]) {
    assert.equal(
      speechProjection.projectSpeechHistoryEntries([communicationEntry], [invalidLine], eventById)[0].text,
      communicationEntry.text,
      '非法、空白或错绑台词必须退回事实投影',
    );
  }
  assert.equal(
    speechProjection.projectSpeechHistoryEntries(
      [communicationEntry],
      [validLine, { ...validLine, id: 'speech:conflict', text: '冲突台词' }],
      eventById,
    )[0].text,
    communicationEntry.text,
    '同一事实出现冲突台词时不得任选一条',
  );

  const rebuilt = chronicle.rebuildChronicleProjection([{
    elapsedMonths: 2,
    entries: [communicationEntry],
    speechLines: [validLine],
  }], eventById);
  assert.equal(
    chronicle.chronicleProjectionEntries(rebuilt)[0].text,
    projected[0].text,
    '从 StoredFrame 重建纪事时必须恢复其中的真实模型台词',
  );
  assert.deepEqual(
    {
      dialogueMove: rebuilt.speechLinesBySourceEventId.get(communication.id)?.dialogueMove,
      disposition: rebuilt.speechLinesBySourceEventId.get(communication.id)?.disposition,
    },
    { dialogueMove: 'question', disposition: 'continue' },
    'StoredFrame 重建必须保留模型自主选择的会话动作与延续意图',
  );

  const state = {
    branchId: 'branch', clock: { elapsedMonths: 2 },
    civilization: { number: 1, status: 'active' },
    world: {
      past: [communication, otherAction], animals: [], drops: [],
      grid: { width: 84, height: 52 },
    },
    people: [
      { id: 'speaker', name: '托尔', inventory: [] },
      { id: 'listener', name: '婉儿', inventory: [] },
    ],
    intents: [], projects: [], containers: [], lastStep: [communication, otherAction],
  };
  const refreshedWithoutModel = finalizeChronicleEntries(
    [communicationEntry], state, eventById, [],
  );
  assert.equal(
    refreshedWithoutModel[0].text,
    '托尔与婉儿谈起了一段共同往事。',
    '旧存档中的伪原话应按当前规则重投影为间接事实',
  );
  const refreshedWithModel = finalizeChronicleEntries(
    [communicationEntry], state, eventById, [validLine],
  );
  assert.equal(refreshedWithModel[0].text, projected[0].text,
    '旧存档重投影后，精确绑定的模型台词应覆盖间接事实文本');

  const historyWithoutModel = toAgentHistory(state, 'speaker', 80);
  assert.equal(historyWithoutModel.events[0].summary, '托尔与婉儿谈起了一段共同往事。');
  const historyWithModel = toAgentHistory(state, 'speaker', 80, [validLine]);
  assert.equal(historyWithModel.events[0].summary, projected[0].text,
    '人物行动历史应显示与文明纪事相同的真实模型台词');

  assert.deepEqual(
    speechProjection.collectSpeechLinesThroughMonth([
      { elapsedMonths: 1, speechLines: [{ ...validLine, id: 'speech:old', month: 1 }] },
      { elapsedMonths: 2, speechLines: [validLine] },
      { elapsedMonths: 3, speechLines: [{ ...validLine, id: 'speech:future', month: 3 }] },
    ], 2).map((line) => line.id),
    ['speech:old', validLine.id],
    '人物历史只能读取当前分支截至请求月份的 StoredFrame 台词',
  );

  console.log('speech history projection tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
