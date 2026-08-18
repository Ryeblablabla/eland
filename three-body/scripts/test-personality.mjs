import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-personality-test-'));
const bundlePath = path.join(temporaryDirectory, 'personality.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { buildDecisionContext } from ${JSON.stringify(path.resolve('src/game/eland/application/action-options.ts'))};
    export { evaluateDecisionOption } from ${JSON.stringify(path.resolve('src/game/eland/application/decision-factor-forest.ts'))};
    export { consolidatePersonality, recordPersonalityEvidence } from ${JSON.stringify(path.resolve('src/game/eland/domain/personality.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=personality-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    buildDecisionContext,
    consolidatePersonality,
    createInitialState,
    evaluateDecisionOption,
    recordPersonalityEvidence,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(26081901, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const actor = state.people[0];
  const other = state.people[1];
  actor.bornAtMonth = -24 * 12;
  other.bornAtMonth = -24 * 12;
  other.position = structuredClone(actor.position);
  Object.assign(actor.personality.baseline, {
    honestyHumility: 50,
    emotionality: 50,
    extraversion: 50,
    agreeableness: 50,
    conscientiousness: 50,
    openness: 50,
  });
  const context = buildDecisionContext(state, actor);
  const moment = { atMonth: 1, planningTick: 1 };
  const voteScore = (option, tree) => evaluateDecisionOption(context, option, moment).votes.find((vote) => vote.tree === tree)?.score;
  const compareTrait = (trait, option, tree, direction = 'higher') => {
    actor.personality.baseline[trait] = 80;
    const high = voteScore(option, tree);
    actor.personality.baseline[trait] = 20;
    const low = voteScore(option, tree);
    actor.personality.baseline[trait] = 50;
    if (direction === 'higher') assert.ok(high > low, `${trait} 高值应提高 ${tree} 票`);
    else assert.ok(high < low, `${trait} 高值应降低 ${tree} 票`);
  };

  const care = {
    id: 'test:care', summary: '照护伤者', reason: '眼前人物受伤',
    goal: { kind: 'body-at-least', field: 'health', value: 60 },
    nextAction: { kind: 'act', operation: 'combine', targets: [{ kind: 'person', personId: other.id }] },
    target: { kind: 'person', personId: other.id }, estimatedDuration: 'one-month', sourceFactIds: ['wound-source'],
  };
  other.body.health = 20;
  const social = {
    id: 'test:social', summary: '提出合作', reason: '已有共同经历', domain: 'social',
    goal: { kind: 'representation-made', representationId: 'test:social' },
    nextAction: { kind: 'communicate', content: { id: 'test:social', kind: 'offer', summary: '一起合作' }, audience: [other.id], channel: 'voice' },
    target: { kind: 'person', personId: other.id }, estimatedDuration: 'one-month', sourceFactIds: ['shared-source'],
  };
  const commitment = {
    id: 'test:commitment', summary: '继续项目', reason: '已经承诺',
    goal: { kind: 'project-completed', projectId: 'project-test' },
    nextAction: { kind: 'move', toCellId: actor.position.cellId },
    projectId: 'project-test', projectPressure: 20, estimatedDuration: 'one-month', sourceFactIds: ['project-source'],
  };
  const learning = {
    id: 'test:learning', summary: '观察未知物', reason: '项目存在知识缺口',
    goal: { kind: 'knowledge', factId: 'fact-test', minConfidence: 55 },
    nextAction: { kind: 'attend', target: { kind: 'person', personId: other.id } },
    estimatedDuration: 'one-month', sourceFactIds: ['question-source'],
  };
  const theft = {
    id: 'test:theft', summary: '未经允许取物', reason: '想取得他人物资',
    goal: { kind: 'inventory-at-least', materialId: 21, quantity: 1 },
    nextAction: { kind: 'transfer', materialId: 21, quantity: 1, from: { kind: 'person', personId: other.id }, to: { kind: 'person', personId: actor.id } },
    target: { kind: 'person', personId: other.id }, estimatedDuration: 'one-month', sourceFactIds: ['owned-stack'],
  };

  compareTrait('emotionality', care, 'care');
  compareTrait('extraversion', social, 'relationship');
  compareTrait('agreeableness', social, 'relationship');
  compareTrait('conscientiousness', commitment, 'commitment');
  compareTrait('openness', learning, 'learning');
  compareTrait('honestyHumility', theft, 'harm', 'lower');
  compareTrait('conscientiousness', theft, 'harm', 'lower');

  const fact = (who, month, targetId, suffix, urgent = false) => {
    const person = state.people.find((candidate) => candidate.id === who);
    person.body = urgent ? { health: 100, hydration: 100, nutrition: 10 } : { health: 100, hydration: 100, nutrition: 100 };
    return {
      id: `e-${month}-personality-${suffix}`, kind: 'action', actionTick: 1, atMonth: month, orderInMonth: 0,
      cellId: person.position.cellId, who, cause: 'intent',
      action: { kind: 'transfer', materialId: 21, quantity: 1, from: { kind: 'person', personId: targetId }, to: { kind: 'person', personId: who } },
      fromCellId: person.position.cellId, toCellId: person.position.cellId,
      fromZ: person.position.z, toZ: person.position.z, pathSegment: [person.position.cellId],
      status: 'completed', result: '未经允许取得食物', diff: { authorized: false },
    };
  };

  actor.personality.learnedDelta.honestyHumility = 0;
  for (let month = 1; month <= 3; month += 1) {
    const event = fact(actor.id, month, month === 2 ? state.people[2].id : other.id, `ordinary-${month}`);
    recordPersonalityEvidence(state, event);
    consolidatePersonality(state, month);
    if (month < 3) assert.equal(actor.personality.learnedDelta.honestyHumility, 0, '单次或两次行动不能改变长期人格');
  }
  assert.equal(actor.personality.learnedDelta.honestyHumility, -1, '跨三个月和两种关系情境的高诊断性行为应形成一次慢速变化');
  assert.ok(actor.personality.changes[0]?.sourceEventIds.length === 3, '人格变化必须保留全部来源事件');

  const urgentActor = state.people[3];
  urgentActor.personality.learnedDelta.honestyHumility = 0;
  for (let month = 1; month <= 3; month += 1) {
    const event = fact(urgentActor.id, month, month === 2 ? state.people[4].id : other.id, `urgent-${month}`, true);
    recordPersonalityEvidence(state, event);
    consolidatePersonality(state, month);
  }
  assert.equal(urgentActor.personality.learnedDelta.honestyHumility, 0, '极端饥饿下的三次取物不应被等同为稳定的不诚实人格');

  for (let month = 4; month <= 9; month += 1) {
    const event = fact(actor.id, month, month % 2 ? state.people[2].id : other.id, `cap-${month}`);
    recordPersonalityEvidence(state, event);
    consolidatePersonality(state, month);
  }
  assert.equal(actor.personality.learnedDelta.honestyHumility, -2, '任一人格维度在滚动一年内最多变化两点');

  process.stdout.write('personality tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
