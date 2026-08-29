import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-kinship-risk-test-'));
const bundlePath = path.join(temporaryDirectory, 'decision-factor-forest.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { evaluateDecisionOption } from ${JSON.stringify(path.resolve('src/game/eland/application/decision-factor-forest.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=kinship-risk-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const { createInitialState, evaluateDecisionOption } = await import(
    `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
  );

  const state = createInitialState(17, {
    endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0,
  });
  const person = state.people.find((candidate) => candidate.sex === 'female') ?? state.people[0];
  const other = state.people.find((candidate) => candidate.sex === 'male' && candidate.id !== person.id)
    ?? state.people.find((candidate) => candidate.id !== person.id);
  assert.ok(person && other);
  person.sex = 'female';
  other.sex = 'male';
  person.bornAtMonth = -24 * 12;
  other.bornAtMonth = -24 * 12;
  person.geneticParents = ['shared-parent', 'parent-a'];
  other.geneticParents = ['shared-parent', 'parent-b'];
  person.geneticLoad = 0;
  other.geneticLoad = 0;
  person.body = { health: 100, hydration: 100, nutrition: 100 };
  other.body = { health: 100, hydration: 100, nutrition: 100 };
  person.conditions = [];
  other.conditions = [];
  person.inventory = [];
  other.inventory = [];
  person.memories = [];
  other.memories = [];
  person.relations = [{ personId: other.id, trust: 60, bond: 60, fear: 0, sourceEventIds: ['relationship-source'] }];
  other.relations = [{ personId: person.id, trust: 60, bond: 60, fear: 0, sourceEventIds: ['relationship-source'] }];
  state.people = [person, other];
  state.clock.elapsedMonths = 5;
  state.agreements = [];
  const context = {
    state, person, visiblePeople: [other], visibleAnimals: [], visibleCells: [], visibleDrops: [],
    options: [], followUpOptions: [],
  };
  const option = {
    id: `accept-reproduce:test-offer:${person.id}`,
    summary: '接受共同生殖提议', reason: '由本人权衡关系、人格、责任与已知风险',
    goal: { kind: 'representation-made', representationId: `accept:test-offer:${person.id}` },
    nextAction: {
      kind: 'communicate', channel: 'voice', audience: ['person-b'],
      content: {
        id: `accept:test-offer:${person.id}`, kind: 'accept', referenceId: 'test-offer',
      },
    },
    target: { kind: 'person', personId: other.id },
    estimatedDuration: 'one-month', sourceFactIds: ['relationship-source'], domain: 'social',
    semantics: {
      version: 'action-option-semantics-v1',
      obligation: 'required-response', planningChannel: 'edge',
      purpose: 'reproduction', minimumLifeStage: 'adult',
      needKinds: ['autonomy', 'generativity'], edgeTrigger: 'required-response',
      reproduction: { direction: 'proceed', phase: 'response', mode: 'mutual' },
      socialContext: {
        cooperationKind: 'reproduction', phase: 'response',
        counterpartIds: [other.id], referenceId: 'test-offer',
      },
    },
  };
  const consentAtConfidence = (confidence) => {
    person.knowledge = confidence > 0 ? [{
      id: 'claim:close-kin-offspring-risk', kind: 'claim', summary: '近亲后代风险较高',
      confidence, learnedAtMonth: 1, sourceEventIds: ['inherited-outcome-source'],
    }] : [];
    const consent = evaluateDecisionOption(context, option, { atMonth: 6, planningTick: 1 })
      .votes.find((candidate) => candidate.tree === 'consent');
    assert.ok(consent);
    return consent;
  };

  const none = consentAtConfidence(0);
  const tentative = consentAtConfidence(50);
  const confident = consentAtConfidence(100);
  const tentativeCost = none.score - tentative.score;
  const confidentCost = none.score - confident.score;
  assert.ok(Math.abs(tentativeCost - 16.2) < 1e-9,
    `半同胞风险在 50 置信度时应连续形成 16.2 点成本，实际 ${tentativeCost}`);
  assert.ok(Math.abs(confidentCost - 32.4) < 1e-9,
    `半同胞风险在满置信度时应形成 32.4 点软成本，实际 ${confidentCost}`);
  assert.ok(tentative.sourceFactIds.includes('inherited-outcome-source'),
    '亲缘风险投票必须保留风险认识的来源事件');
  assert.match(tentative.reasons.join('；'), /置信度 50/);

  console.log('kinship risk decision tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
