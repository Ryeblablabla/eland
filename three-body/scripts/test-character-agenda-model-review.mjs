import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-character-agenda-model-review-'));
const bundlePath = path.join(temporaryDirectory, 'backend-decider.mjs');
const modelReviewBundlePath = path.join(temporaryDirectory, 'model-review.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/backend-decider.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/application/simulation/model-review.ts',
    '--bundle', '--platform=node', '--format=esm', `--outfile=${modelReviewBundlePath}`,
  ], { stdio: 'pipe' });
  const { isLiveModelDecisionContext } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const { decisionBudgetExemption } = await import(`${pathToFileURL(modelReviewBundlePath).href}?test=${Date.now()}`);

  const person = {
    id: 'person-a', generation: 1,
    body: { health: 90, hydration: 90, nutrition: 90 },
    conditions: [], memories: [], knowledge: [], knownPlaces: [], relations: [], traits: [],
    cognition: { outcomeBeliefs: [], goalOutcomeBeliefs: [] },
    characterAgenda: { version: 'character-agenda-v1', items: [] },
  };
  const context = {
    state: { world: { past: [] }, people: [person], clock: { elapsedMonths: 9 } },
    person,
    options: [], followUpOptions: [],
  };
  assert.equal(isLiveModelDecisionContext(context, 10), true,
    'a person without an executable option or durable direction still receives one subjective review opening');

  context.state.world.past.push({
    id: 'decision-a-10', kind: 'decision', atMonth: 10, who: person.id, usedModel: true,
    decision: { kind: 'idle', reason: '尚未形成新方向' },
  });
  assert.equal(isLiveModelDecisionContext(context, 11), false);
  assert.equal(isLiveModelDecisionContext(context, 12), false,
    'a recorded model reflection enforces the per-person cooldown even with zero options');
  assert.equal(isLiveModelDecisionContext(context, 13), true,
    'the review may reopen after the bounded cooldown instead of remaining permanently disabled');

  context.activeIntent = {
    id: 'intent-a', domain: 'strategic', status: 'active', createdAtMonth: 8,
    lastProgressAtMonth: 16, progress: 0.4, sourceFactIds: [],
  };
  context.state.world.past.push({
    id: 'decision-a-13', kind: 'decision', atMonth: 13, who: person.id, usedModel: true,
    decision: { kind: 'idle', reason: '继续手上的事' },
  });
  person.memories.push({
    id: 'memory-new-unresolved', kind: 'failure', summary: '新发生的重要失败', importance: 82,
    createdAtMonth: 14, lastRecalledAtMonth: 14, personIds: [], sourceEventIds: ['fact-memory-new'],
    expiresAtMonth: 20,
  });
  assert.equal(isLiveModelDecisionContext(context, 16), true,
    'a new salient unresolved memory opens a first agenda review even while another Intent remains active');

  person.characterAgenda.items.push({
    id: 'agenda-a', basisKey: 'agenda-v1|a', aim: '继续观察尚未理解的变化', theme: 'inquiry',
    importance: 70, horizonMonths: 18, targetAtMonth: 30, origin: 'model-proposal',
    status: 'incubating', createdAtMonth: 10, lastReviewedAtMonth: 10,
    sourceFactIds: ['fact-old'], approaches: [{
      id: 'approach-a', basisKey: 'agenda-v1|a|approach|wait', summary: '等待新的线索',
      disposition: 'missing-affordance', createdAtMonth: 10, lastConsideredAtMonth: 10,
      sourceFactIds: ['fact-old'], attemptIntentIds: [], evaluations: [],
    }], intentIds: [], projectIds: [],
  });
  person.memories.push({
    id: 'memory-new-agenda', kind: 'failure', summary: '已有关切出现了新证据', importance: 80,
    createdAtMonth: 17, lastRecalledAtMonth: 17, personIds: [], sourceEventIds: ['fact-new'],
    expiresAtMonth: 24,
  });
  context.activeIntent.lastProgressAtMonth = 19;
  assert.equal(isLiveModelDecisionContext(context, 19), true,
    'new person-local evidence reopens a blocked or incubating agenda review after cooldown');

  const founder = {
    ...person,
    id: 'founder-a', generation: 0,
    body: { health: 90, hydration: 90, nutrition: 90 }, conditions: [],
    memories: [{
      id: 'memory-founding', kind: 'episode', summary: '与众人抵达这里', importance: 82,
      createdAtMonth: 0, lastRecalledAtMonth: 0, personIds: [], sourceEventIds: ['fact-founding'],
    }],
    characterAgenda: { version: 'character-agenda-v1', items: [] },
  };
  const founderContext = {
    state: { world: { past: [] }, people: [founder], clock: { elapsedMonths: 0 } },
    person: founder, options: [], followUpOptions: [],
    activeIntent: {
      id: 'intent-founder', domain: 'strategic', status: 'active', createdAtMonth: 0,
      lastProgressAtMonth: 0, progress: 0, sourceFactIds: [],
    },
  };
  assert.equal(isLiveModelDecisionContext(founderContext, 1), false,
    'founding memory must not reopen bootstrap deliberation over an already active valid intent');

  const refutedPerson = {
    ...person,
    id: 'refuted-a', conditions: [], memories: [],
    characterAgenda: { version: 'character-agenda-v1', items: [{
      id: 'agenda-refuted', basisKey: 'agenda-v1|refuted', aim: '找到另一种可行办法', theme: 'inquiry',
      importance: 78, horizonMonths: 18, targetAtMonth: 26, origin: 'model-proposal',
      status: 'blocked', createdAtMonth: 8, lastReviewedAtMonth: 8,
      sourceFactIds: ['fact-attempt'], intentIds: ['intent-refuted'], projectIds: [],
      approaches: [{
        id: 'approach-refuted', basisKey: 'agenda-v1|refuted|approach|first', summary: '先试第一种办法',
        disposition: 'contradicted-approach', createdAtMonth: 8, lastConsideredAtMonth: 8,
        sourceFactIds: ['fact-attempt'], attemptIntentIds: ['intent-refuted'], latestOutcome: 'refuted',
        evaluations: [{
          ordinal: 1, atMonth: 8, outcome: 'refuted', basisFactIds: ['fact-attempt'],
          evidenceFactIds: ['fact-refutation'],
        }],
      }],
    }] },
  };
  const refutedContext = {
    state: {
      world: { past: [{
        id: 'decision-refuted-8', kind: 'decision', atMonth: 8, who: refutedPerson.id, usedModel: true,
        decision: { kind: 'start', optionId: 'probe-first', reason: '先试第一种办法' },
      }] },
      people: [refutedPerson], clock: { elapsedMonths: 10 },
    },
    person: refutedPerson, options: [], followUpOptions: [],
  };
  refutedContext.state.world.past.push({
    id: 'decision-unrelated-10', kind: 'decision', atMonth: 10, who: refutedPerson.id, usedModel: true,
    decision: { kind: 'idle', reason: '只处理了一次无关的日常交谈' },
  });
  assert.equal(decisionBudgetExemption(refutedContext, 10), null,
    'an objective refutation still respects the model-review cooldown');
  assert.equal(decisionBudgetExemption(refutedContext, 11), 'agenda-revision',
    'after cooldown, an unrelated model dialogue cannot postpone the bounded guaranteed revision');

  process.stdout.write('character agenda model review tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
