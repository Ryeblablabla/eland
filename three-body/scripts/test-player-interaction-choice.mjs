import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-player-interaction-'));
const bundlePath = path.join(temporaryDirectory, 'player-interaction-choice.mjs');
const backendBundlePath = path.join(temporaryDirectory, 'backend-decider.mjs');

function physicalOption(id = 'collect:stone-drop') {
  return {
    id,
    summary: '捡起近处的石头',
    reason: '石头就在近处',
    goal: { kind: 'inventory-at-least', materialId: 3, quantity: 1 },
    nextAction: {
      kind: 'transfer',
      materialId: 3,
      quantity: 1,
      from: { kind: 'ground', cellId: 9 },
      to: { kind: 'person', personId: 'person-a' },
      dropId: 'stone-drop',
    },
    target: { kind: 'drop', dropId: 'stone-drop' },
    estimatedDuration: 'one-month',
    sourceFactIds: ['drop:stone-drop'],
  };
}

function conversationOption(month) {
  const id = `conversation:care:${month}:person-a:person-b`;
  return {
    id,
    summary: '与泊川谈彼此最近的身体状况',
    reason: '双方刚经历过一次照料',
    goal: { kind: 'representation-made', representationId: id },
    nextAction: {
      kind: 'communicate',
      content: {
        id,
        kind: 'claim',
        summary: '问问泊川现在是否好些了',
        conversation: {
          version: 'grounded-conversation-v1',
          basisKey: 'care:person-a:person-b:event-1',
          topic: 'care',
          turn: 'opening',
          speakerId: 'person-a',
          listenerId: 'person-b',
          sourceFactIds: ['event-1'],
        },
      },
      audience: ['person-b'],
      channel: 'voice',
    },
    target: { kind: 'person', personId: 'person-b' },
    estimatedDuration: 'one-month',
    sourceFactIds: ['event-1'],
    domain: 'social',
  };
}

function context(options) {
  return { options, followUpOptions: [] };
}

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/application/player-interaction-choice.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/backend-decider.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${backendBundlePath}`,
  ], { stdio: 'pipe' });

  const { validatePlayerInteractionChoice } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const { decisionFromPlayerInteraction } = await import(`${pathToFileURL(backendBundlePath).href}?test=${Date.now()}`);

  const initial = validatePlayerInteractionChoice(context([conversationOption(10)]), {
    optionId: 'conversation:care:10:person-a:person-b',
  });
  assert.equal(initial.ok, true);

  const nextMonth = validatePlayerInteractionChoice(context([conversationOption(11)]), {
    optionId: initial.optionId,
    choiceKey: initial.choiceKey,
  });
  assert.equal(nextMonth.ok, true, '仅月份戳变化时应按稳定语义重新绑定');
  assert.equal(nextMonth.optionId, 'conversation:care:11:person-a:person-b');

  const requiredResponse = {
    ...physicalOption('accept-assist:request-1'),
    summary: '回应泊川的求助',
  };
  const deferred = validatePlayerInteractionChoice(context([
    physicalOption(),
    requiredResponse,
  ]), {
    optionId: 'collect:stone-drop',
  });
  assert.deepEqual(deferred, { ok: false, failure: 'required-response-first' });

  const disappeared = validatePlayerInteractionChoice(context([]), {
    optionId: initial.optionId,
    choiceKey: initial.choiceKey,
  });
  assert.deepEqual(disappeared, { ok: false, failure: 'option-unavailable' });

  const physical = validatePlayerInteractionChoice(context([physicalOption()]), {
    optionId: 'collect:stone-drop',
  });
  assert.equal(physical.ok, true);
  const sameIdDifferentMeaning = physicalOption();
  sameIdDifferentMeaning.nextAction = {
    ...sameIdDifferentMeaning.nextAction,
    materialId: 2,
  };
  const changedMeaning = validatePlayerInteractionChoice(context([sameIdDifferentMeaning]), {
    optionId: physical.optionId,
    choiceKey: physical.choiceKey,
  });
  assert.deepEqual(
    changedMeaning,
    { ok: false, failure: 'option-unavailable' },
    '同一个临时 ID 的语义发生变化时不能冒充原选择',
  );
  const direct = decisionFromPlayerInteraction({
    ...context([physicalOption()]),
    person: { id: 'person-a' },
  }, {
    id: 'conversation-turn-1',
    agentId: 'person-a',
    sourceMonth: 10,
    playerMessage: '去捡那块石头吧',
    stance: 'accept',
    guidance: '先把近处的石头捡起来',
    choice: {
      optionId: physical.optionId,
      summary: physical.summary,
      choiceKey: physical.choiceKey,
      reason: '石头就在眼前，我愿意先试试',
    },
  });
  assert.equal(direct.attempt.status, 'ready');
  assert.deepEqual(direct.decision, {
    kind: 'start',
    optionId: 'collect:stone-drop',
    reason: '石头就在眼前，我愿意先试试',
    sourceInteractionId: 'conversation-turn-1',
  });

  console.log('player interaction choice tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
