import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-decision-recent-dialogue-'));

async function bundledImport(entry, name) {
  const output = path.join(temporaryDirectory, `${name}.mjs`);
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
  ], { stdio: 'pipe' });
  return import(`${pathToFileURL(output).href}?test=${Date.now()}`);
}

function voiceEvent(id, month, planningTick, speakerId, audienceIds) {
  return {
    id, kind: 'action', atMonth: month, orderInMonth: planningTick,
    planningTick, orderInTick: 0, actionTick: planningTick,
    cellId: 1, who: speakerId, cause: 'intent', status: 'completed',
    action: {
      kind: 'communicate', audience: audienceIds, channel: 'voice',
      content: { id: `content:${id}`, kind: 'claim', summary: `事实边界 ${id}` },
    },
    fromCellId: 1, toCellId: 1, fromZ: 1, toZ: 1, pathSegment: [],
    result: `说出了 ${id}`,
    diff: {},
  };
}

function speechLine(event, names, text = `真实台词 ${event.id}`) {
  return {
    id: `speech:${event.id}`,
    authority: 'projection-only',
    sourceEventId: event.id,
    sourceFactIds: [],
    month: event.atMonth,
    planningTick: event.planningTick,
    speakerId: event.who,
    speakerName: names[event.who],
    audienceIds: [...event.action.audience],
    audienceNames: event.action.audience.map((id) => names[id]),
    channel: 'voice',
    communicationKind: 'claim',
    speechAct: { version: 'speech-act-v1', kind: 'claim', subject: event.id },
    text,
    dialogueMove: 'question',
    disposition: 'continue',
    source: 'speech-model',
  };
}

try {
  const { recentDialogueForDecision } = await bundledImport(
    'src/game/eland/application/model-decision/index.ts',
    'decision-context',
  );
  const { collectSpeechLinesThroughMonth } = await bundledImport(
    'src/game/eland/projection/speech-history.ts',
    'speech-history',
  );

  const names = {
    self: '阿尔', counterpart: '贝塔', other: '伽马', strangerA: '德尔塔', strangerB: '艾普西隆',
  };
  const people = Object.entries(names).map(([id, name]) => ({ id, name }));
  const events = [
    voiceEvent('recent-self-other-8', 8, 1, 'self', ['other']),
    voiceEvent('recent-other-self-7', 7, 2, 'other', ['self']),
    voiceEvent('recent-self-other-6a', 6, 3, 'self', ['other']),
    voiceEvent('recent-other-self-6b', 6, 4, 'other', ['self']),
    voiceEvent('counterpart-self-5', 5, 2, 'counterpart', ['self']),
    voiceEvent('old-self-counterpart-4', 4, 1, 'self', ['counterpart']),
    voiceEvent('unrelated-8', 8, 5, 'strangerA', ['strangerB']),
    voiceEvent('planning-month-9', 9, 1, 'counterpart', ['self']),
  ];
  const lines = events.map((event) => speechLine(event, names));
  const forged = {
    ...speechLine(events[0], names, '这条伪造台词不应出现'),
    id: 'speech:forged-audience',
    audienceIds: ['strangerB'],
  };
  const persistedFrames = JSON.parse(JSON.stringify([
    { elapsedMonths: 4, speechLines: lines.filter((line) => line.month <= 4) },
    { elapsedMonths: 8, speechLines: [...lines.filter((line) => line.month > 4 && line.month <= 8), forged] },
    { elapsedMonths: 9, speechLines: lines.filter((line) => line.month === 9) },
  ]));
  const reloadedLines = collectSpeechLinesThroughMonth(persistedFrames, 8);
  const memoryPerson = (id) => ({ id, memories: [], knowledge: [], knownPlaces: [], relations: [] });
  const context = {
    person: memoryPerson('self'),
    state: { clock: { elapsedMonths: 8 }, people, world: { past: events } },
    options: [{
      target: { kind: 'person', personId: 'counterpart' },
      nextAction: { kind: 'move', toCellId: 1 },
    }],
  };
  const planningMonthLine = lines.find((line) => line.sourceEventId === 'planning-month-9');
  assert.ok(planningMonthLine);
  const decisionCandidates = [...reloadedLines, planningMonthLine];
  const recentDialogue = recentDialogueForDecision(context, decisionCandidates);

  assert.equal(recentDialogue.length, 4, 'decision dialogue context must remain bounded to four lines');
  assert.ok(recentDialogue.some((line) => line.sourceEventId === 'counterpart-self-5'),
    'a current option counterpart should retain a slightly older relevant utterance');
  assert.ok(recentDialogue.every((line) => line.speaker === names.self
    || line.listeners.includes(names.self)), 'a person may only see dialogue they spoke or heard');
  assert.ok(!recentDialogue.some((line) => line.sourceEventId === 'unrelated-8'),
    'dialogue between unrelated people must not leak into this decision');
  assert.ok(!recentDialogue.some((line) => line.sourceEventId === 'planning-month-9'),
    'the month currently being planned must not see lines that have not yet been generated');
  assert.ok(!recentDialogue.some((line) => line.text.includes('伪造')),
    'a line whose participants do not match its source ActionFact must be rejected');
  assert.ok(recentDialogue.every((line) => line.move === 'question'
    && line.disposition === 'continue'
    && typeof line.sourceEventId === 'string'), 'audit metadata must survive the compact projection');

  const afterReload = recentDialogueForDecision(context, JSON.parse(JSON.stringify(decisionCandidates)));
  assert.deepEqual(afterReload, recentDialogue,
    'restored committed SpeechLines must produce the same next-month decision context');
  assert.deepEqual(recentDialogueForDecision({ ...context, person: memoryPerson('strangerB') }, reloadedLines)
    .map((line) => line.sourceEventId), ['unrelated-8'],
  'another person should receive only the dialogue they personally heard');

  console.log('decision recent dialogue tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
