import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-unified-decision-language-'));
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const intentBundlePath = path.join(temporaryDirectory, 'intent-execution.mjs');
const speechBundlePath = path.join(temporaryDirectory, 'live-speech.mjs');
const speechServiceBundlePath = path.join(temporaryDirectory, 'live-speech-service.mjs');

const mentalAct = (kind, utterance, delivery = 'normal') => ({
  version: 'mental-act-v2',
  kind,
  utterance,
  delivery,
  goal: '验证统一语言',
  strategy: '执行当前一步',
  assumptions: [],
  sourceEventIds: [],
});

try {
  for (const [entryPoint, outputPath] of [
    ['src/game/eland/simulation.ts', simulationBundlePath],
    ['src/game/eland/application/simulation/intent-execution.ts', intentBundlePath],
    ['src/game/eland/projection/live-speech.ts', speechBundlePath],
    ['server/live-speech-service.ts', speechServiceBundlePath],
  ]) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entryPoint, '--bundle', '--platform=node', '--format=esm', `--outfile=${outputPath}`,
    ], { stdio: 'pipe' });
  }

  const simulation = await import(`${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`);
  const intentExecution = await import(`${pathToFileURL(intentBundlePath).href}?test=${Date.now()}`);
  const speechProjection = await import(`${pathToFileURL(speechBundlePath).href}?test=${Date.now()}`);
  const speechService = await import(`${pathToFileURL(speechServiceBundlePath).href}?test=${Date.now()}`);

  const talkState = simulation.createInitialState(9017, {
    endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0,
  });
  const talkContext = simulation.buildDecisionContexts(talkState, 1)
    .find((candidate) => candidate.options.some((option) => option.nextAction.kind === 'talk'));
  assert(talkContext, 'fixture must expose a social talk option');
  const talkOption = talkContext.options.find((option) => option.nextAction.kind === 'talk');
  assert(talkOption);
  const utterance = '这一次决定就是我发出的唯一一句话。';
  const decisionFact = intentExecution.applyDecision(
    talkState,
    talkContext.person,
    talkContext,
    {
      kind: 'start', optionId: talkOption.id, reason: '验证',
      mentalAct: mentalAct('talk', utterance, 'call'),
    },
    true,
    1,
    0,
    1,
  );
  const actionFact = intentExecution.executeActiveIntent(
    talkState, talkContext.person, 1, 1, 1, [decisionFact],
  );
  assert.equal(actionFact?.kind, 'action');
  assert.equal(actionFact?.action.kind, 'talk');
  assert.equal(decisionFact.languageBroadcast?.text, utterance);
  assert.equal(actionFact.diff.languageSourceEventId, decisionFact.id,
    'social talk must reuse the DecisionFact language wave');
  assert.deepEqual(actionFact.diff.languageBroadcast, decisionFact.languageBroadcast);
  const talkLines = speechProjection.projectLiveSpeechDrafts(talkState, [decisionFact, actionFact]);
  assert.equal(talkLines.length, 1, 'a model talk decision must not render thought plus speech');
  assert.equal(talkLines[0].sourceEventId, actionFact.id);
  assert.equal(talkLines[0].modelText, utterance);
  assert.equal('mode' in talkLines[0], false);
  assert.equal(speechService.retainDecisionSpeechLines(talkLines)[0]?.text, utterance,
    'the expression layer must not paraphrase a language wave after propagation');
  const realizedTalk = await speechService.realizeLiveSpeechLines(
    talkState, [decisionFact, actionFact], talkLines,
  );
  assert.equal(realizedTalk.providerRequests, 0);
  assert.equal(realizedTalk.lines[0]?.text, utterance);

  const physicalState = simulation.createInitialState(9018, {
    endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0,
  });
  const physicalContext = simulation.buildDecisionContexts(physicalState, 1)
    .find((candidate) => candidate.options.some((option) => option.nextAction.kind !== 'talk'));
  assert(physicalContext, 'fixture must expose a physical option');
  const physicalOption = physicalContext.options.find((option) => option.nextAction.kind !== 'talk');
  assert(physicalOption);
  const physicalUtterance = `${'我要先把眼前这件事想清楚，'.repeat(10)}然后再动手。`;
  assert(physicalUtterance.length > 120 && physicalUtterance.length <= 180,
    'fixture must cross the former speech truncation boundary');
  const physicalDecision = intentExecution.applyDecision(
    physicalState,
    physicalContext.person,
    physicalContext,
    {
      kind: 'start', optionId: physicalOption.id, reason: '验证',
      mentalAct: mentalAct('pursue', physicalUtterance),
    },
    true,
    1,
    0,
    1,
  );
  assert.equal(physicalState.memoryStore.items.some((item) => (
    item.ownerId === physicalContext.person.id
      && item.topicKeys.includes('language:decision')
      && item.sourceEventIds.includes(physicalDecision.id)
  )), false, 'a speaker must not remember their own non-talk MentalAct again as dialogue');
  const physicalLines = speechProjection.projectLiveSpeechDrafts(physicalState, [physicalDecision]);
  assert.equal(physicalLines.length, 1, 'every model decision emits one spoken language line');
  assert.equal(physicalLines[0].sourceEventId, physicalDecision.id);
  assert.equal(physicalLines[0].communicationKind, 'talk');
  assert.equal(physicalLines[0].modelText, physicalUtterance);
  assert.equal(speechService.retainDecisionSpeechLines(physicalLines)[0]?.text, physicalUtterance);
  const realizedPhysical = await speechService.realizeLiveSpeechLines(
    physicalState, [physicalDecision], physicalLines,
  );
  assert.equal(realizedPhysical.providerRequests, 0);
  assert.equal(realizedPhysical.lines[0]?.text, physicalUtterance);

  console.log('unified decision language tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
