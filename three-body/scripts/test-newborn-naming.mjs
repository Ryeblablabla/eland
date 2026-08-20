import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-newborn-naming-'));
const namingBundlePath = path.join(temporaryDirectory, 'naming.mjs');
const serviceBundlePath = path.join(temporaryDirectory, 'newborn-naming-service.mjs');

try {
  for (const [entry, output] of [
    ['src/game/eland/naming.ts', namingBundlePath],
    ['server/newborn-naming-service.ts', serviceBundlePath],
  ]) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
    ], { stdio: 'pipe' });
  }

  const { acceptProposedNewbornGivenName } = await import(`${pathToFileURL(namingBundlePath).href}?test=${Date.now()}`);
  const {
    applyNewbornNameProposals,
    buildNewbornNamingContexts,
    normalizeNewbornNameProposals,
  } = await import(`${pathToFileURL(serviceBundlePath).href}?test=${Date.now()}`);

  assert.deepEqual(
    acceptProposedNewbornGivenName('望舒', { familyName: '王', namingTradition: 'eastern' }, []),
    { familyName: '王', namingTradition: 'eastern', givenName: '望舒', name: '王望舒' },
  );
  assert.equal(acceptProposedNewbornGivenName('王望舒', { familyName: '王', namingTradition: 'eastern' }, []), null,
    '模型不得把完整姓名冒充 givenName');
  assert.equal(acceptProposedNewbornGivenName('望舒', { familyName: '王', namingTradition: 'eastern' }, ['王望舒']), null,
    '模型候选不得制造重名');
  assert.equal(acceptProposedNewbornGivenName('安·宁', { familyName: '王', namingTradition: 'eastern' }, []), null,
    '模型候选不得携带标点');

  const personality = {
    baseline: {
      honestyHumility: 62, emotionality: 57, extraversion: 44,
      agreeableness: 68, conscientiousness: 71, openness: 59,
    },
    learnedDelta: {
      honestyHumility: 0, emotionality: 0, extraversion: 0,
      agreeableness: 0, conscientiousness: 0, openness: 0,
    },
    evidence: [], changes: [],
  };
  const parent = (id, name, memorySummary) => ({
    id, name, personality: structuredClone(personality), motiveSensitivity: { control: 48, status: 42 },
    memories: [{
      id: `memory-${id}`, kind: 'episode', summary: memorySummary, importance: 72,
      createdAtMonth: 19, lastRecalledAtMonth: 19, personIds: [], sourceEventIds: [`source-${id}`],
    }],
  });
  const birth = {
    id: 'e-20-environment-body-4', kind: 'environment', change: 'body', atMonth: 20,
    orderInMonth: 4, planningTick: 0, orderInTick: 4, cellId: 3, who: 'mother',
    result: '林青生下了林知夏，进入产后恢复期',
    diff: {
      bornPersonId: 'child', bornPersonName: '林知夏', sex: 'female',
      familyName: '林', namingTradition: 'eastern', parents: ['mother', 'father'],
    },
  };
  const state = {
    civilization: {
      epoch: 'chaotic', climate: { kind: 'cold', severity: 4 }, weather: { kind: 'snow', severity: 3 },
    },
    people: [
      parent('mother', '林青', '一家人在严寒中守住了住所'),
      parent('father', '林川', '曾在混乱天气后重新找到家人'),
      {
        id: 'child', name: '林知夏', bornAtMonth: 20, sex: 'female',
        geneticParents: ['mother', 'father'], memories: [],
      },
    ],
  };
  state.people[0].memories.push({
    id: 'memory-birth', kind: 'episode', summary: '林知夏出生时体质偏弱', importance: 76,
    createdAtMonth: 20, lastRecalledAtMonth: 20, personIds: ['child'], sourceEventIds: [birth.id],
  });

  const contexts = buildNewbornNamingContexts(state, [birth]);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].parents.length, 2);
  assert.match(contexts[0].parents[0].innerVoice, /^我是林青/u);
  assert.equal(contexts[0].circumstances.climate.kind, 'cold');

  const proposals = normalizeNewbornNameProposals({ names: [
    { childId: 'child', givenName: '归宁', reason: '记得严寒之后一家重新相聚' },
    { childId: 'child', givenName: '重复', reason: '同一孩子不能重复提名' },
    { childId: 'unknown-child', givenName: '越界', reason: '不存在的孩子' },
  ] }, contexts);
  assert.deepEqual(proposals, [{ childId: 'child', givenName: '归宁', reason: '记得严寒之后一家重新相聚' }]);

  const applied = applyNewbornNameProposals(state, [birth], proposals, {
    endpointId: 'naming-test', protocol: 'openai-chat', model: 'test-model',
    inputTokens: 120, outputTokens: 18,
  });
  assert.deepEqual(applied.rejectedChildIds, []);
  assert.equal(applied.renamed[0].name, '林归宁');
  assert.equal(state.people[2].name, '林归宁');
  assert.match(birth.result, /林归宁/u);
  assert.equal(birth.diff.bornPersonName, '林归宁');
  assert.equal(birth.diff.fallbackPersonName, '林知夏');
  assert.equal(birth.diff.namingSource, 'validated-model-proposal-v1');
  assert.equal(birth.diff.namingEndpointId, 'naming-test');
  assert.match(state.people[0].memories.at(-1).summary, /林归宁/u,
    '同一出生事实产生的当月记忆也应使用最终姓名');
  assert.deepEqual(buildNewbornNamingContexts(state, [birth]), [],
    '已接受的模型姓名不得在回放或重复提交时再次请求');

  console.log('newborn naming tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
