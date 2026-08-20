import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-kinship-risk-test-'));
const bundlePath = path.join(temporaryDirectory, 'decision-factor-forest.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/application/decision-factor-forest.ts',
    '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  const { evaluateDecisionOption } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const personality = () => ({
    baseline: {
      honestyHumility: 50, emotionality: 50, extraversion: 50,
      agreeableness: 50, conscientiousness: 50, openness: 50,
    },
    learnedDelta: {
      honestyHumility: 0, emotionality: 0, extraversion: 0,
      agreeableness: 0, conscientiousness: 0, openness: 0,
    },
    evidence: [], changes: [],
  });
  const person = {
    id: 'person-a', name: '甲', sex: 'female', bornAtMonth: -24 * 12,
    geneticParents: ['shared-parent', 'parent-a'], geneticLoad: 0,
    body: { health: 100, hydration: 100, nutrition: 100 },
    conditions: [], inventory: [], knowledge: [], memories: [],
    relations: [{ personId: 'person-b', trust: 60, bond: 60, fear: 0, sourceEventIds: ['relationship-source'] }],
    personality: personality(),
  };
  const other = {
    id: 'person-b', name: '乙', sex: 'male', bornAtMonth: -24 * 12,
    geneticParents: ['shared-parent', 'parent-b'], geneticLoad: 0,
    body: { health: 100, hydration: 100, nutrition: 100 },
    conditions: [], inventory: [], knowledge: [], memories: [],
    relations: [{ personId: 'person-a', trust: 60, bond: 60, fear: 0, sourceEventIds: ['relationship-source'] }],
    personality: personality(),
  };
  const state = {
    seed: 17, branchId: 'main', clock: { elapsedMonths: 5 },
    people: [person, other], agreements: [], world: { past: [] },
  };
  const context = {
    state, person, visiblePeople: [other], visibleAnimals: [], visibleCells: [], visibleDrops: [],
    options: [], followUpOptions: [],
  };
  const option = {
    id: 'offer-reproduce:6:person-a:person-b',
    summary: '提出共同生殖', reason: '关系与身体条件允许',
    goal: { kind: 'representation-made', representationId: 'offer-reproduce:6:person-a:person-b' },
    nextAction: {
      kind: 'communicate', channel: 'voice', audience: ['person-b'],
      content: {
        id: 'offer-reproduce:6:person-a:person-b', kind: 'offer', summary: '是否愿意共同生育后代',
        proposal: { kind: 'reproduce', proposerId: 'person-a', partnerId: 'person-b', expiresAtMonth: 10 },
      },
    },
    target: { kind: 'person', personId: 'person-b' },
    estimatedDuration: 'one-month', sourceFactIds: ['relationship-source'], domain: 'social',
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
  assert.ok(Math.abs((none.score - tentative.score) - 16.2) < 1e-9,
    '半同胞风险在 50 置信度时应连续形成 16.2 点成本');
  assert.ok(Math.abs((none.score - confident.score) - 32.4) < 1e-9,
    '半同胞风险在满置信度时应形成 32.4 点软成本');
  assert.ok(tentative.sourceFactIds.includes('inherited-outcome-source'),
    '亲缘风险投票必须保留风险认识的来源事件');
  assert.match(tentative.reasons.join('；'), /置信度 50/);

  console.log('kinship risk decision tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
