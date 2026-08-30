import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-model-decision-context-'));
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const decisionBundlePath = path.join(temporaryDirectory, 'decision-context.mjs');

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/simulation.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${simulationBundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/application/model-decision/index.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${decisionBundlePath}`,
  ], { stdio: 'pipe' });

  const { buildDecisionContexts, createInitialState, stepSimulation } = await import(
    `${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`
  );
  const { buildCompactDecisionRequestContext, buildDecisionRequestContext } = await import(
    `${pathToFileURL(decisionBundlePath).href}?test=${Date.now()}`
  );

  const samples = [];
  for (const seed of [185, 20260815, 20260816]) {
    let state = createInitialState(seed, { endpoint: { kind: 'months', value: 3 }, chaosIntensity: 0 });
    for (let month = 0; month <= 2 && state.civilization.status === 'running'; month += 1) {
      samples.push(...buildDecisionContexts(state, state.clock.elapsedMonths + 1)
        .filter((context) => context.options.length >= 2));
      if (month < 2) state = stepSimulation(state);
    }
  }
  assert.ok(samples.length > 0, 'matched local histories must produce decision-context samples');

  const fullLengths = [];
  const compactLengths = [];
  const fullOptionCounts = [];
  const compactOptionCounts = [];
  const protectedOptionCounts = [];
  const ordinaryOptionCounts = [];
  const compactFollowUpCounts = [];
  const compactComponentLengths = Object.fromEntries(
    ['person', 'situation', 'recentDialogue', 'cognition', 'commitments', 'options', 'followUpOptions', 'visible']
      .map((key) => [key, []]),
  );
  for (const source of samples) {
    const full = buildDecisionRequestContext(source);
    const compact = buildCompactDecisionRequestContext(full);
    const fullJson = JSON.stringify(full);
    const compactJson = JSON.stringify(compact);
    fullLengths.push(fullJson.length);
    compactLengths.push(compactJson.length);
    fullOptionCounts.push(full.options.length);
    compactOptionCounts.push(compact.options.length);
    compactFollowUpCounts.push(compact.followUpOptions.length);
    for (const [key, lengths] of Object.entries(compactComponentLengths)) {
      lengths.push(JSON.stringify(compact[key]).length);
    }

    assert.equal(compact.schemaVersion, 'decision-context-compact-v1');
    assert.equal(compact.person.id, full.person.id);
    assert.ok(compact.recentDialogue.length <= 4, 'recent dialogue context must stay bounded');
    const compactOptionIds = new Set(compact.options.map((option) => option.id));
    const fullOpenConversationOptions = full.options.filter((option) => (
      option.semantics.conversation?.turn === 'opening'
        && option.semantics.conversation.topic === 'open'
    ));
    assert.ok(fullOpenConversationOptions.every((option) => option.socialRepetition === undefined),
      'open conversation must not expose repetition computed before its actual grounding is selected');
    const compactConversationOpenings = compact.options.filter((option) => (
      option.semantics?.conversation?.turn === 'opening'
    ));
    assert.ok(compactConversationOpenings.every((option) => option.semantics.conversation.topic === 'open'),
      'compact 模型上下文不得继续暴露 failure/discovery/everyday 等预选开场菜单');
    if (fullOpenConversationOptions.length) {
      assert.ok(compactConversationOpenings.length > 0,
        '存在近身听者时 compact 模型上下文应保留真实 open-conversation affordance');
      for (const option of compactConversationOpenings) {
        assert.ok(Array.isArray(option.groundingFacts), 'open conversation 应暴露 request-scoped grounding handles');
        assert.ok(option.groundingFacts.length <= 6, '开放交谈的事实候选必须保持有界');
        assert.ok(option.groundingFacts.every((fact) => /^q[1-9]\d*$/u.test(fact.handle)),
          '模型只能看到本次请求的 grounding handle');
      }
    }
    let protectedCount = 0;
    for (const [index, option] of full.options.entries()) {
      if (option.semantics.obligation === 'required-response'
        || option.semantics.obligation === 'commitment-action'
        || option.characterAgendaItemId
        || option.projectId) {
        protectedCount += 1;
        assert.ok(compactOptionIds.has(`o${index + 1}`),
          'authority, commitment, agenda and project options must survive the ordinary shortlist');
      }
    }
    protectedOptionCounts.push(protectedCount);
    ordinaryOptionCounts.push(compact.options.length - protectedCount);
    for (const option of compact.options) {
      const match = /^o([1-9]\d*)$/u.exec(option.id);
      assert.ok(match, 'compact option must use an original-index handle');
      const sourceOption = full.options[Number(match[1]) - 1];
      assert.ok(sourceOption, 'compact option handle must map to an original option');
      assert.equal(option.summary, sourceOption.summary,
        'shortlist reordering must not remap an option to a different authoritative choice');
      if (!sourceOption.communicatesFactId) continue;
      const knowledgeId = option.communicatesKnowledgeId;
      assert.ok(compact.person.knowledge.some((knowledge) => knowledge.id === knowledgeId),
        'knowledge explicitly communicated by an option must survive compaction');
    }
    for (const option of compact.followUpOptions) {
      const match = /^f([1-9]\d*)$/u.exec(option.id);
      assert.ok(match, 'compact follow-up must use an original-index handle');
      const sourceOption = full.followUpOptions[Number(match[1]) - 1];
      assert.ok(sourceOption, 'compact follow-up handle must map to an original follow-up');
      assert.equal(option.summary, sourceOption.summary,
        'follow-up shortlist reordering must preserve the original authoritative choice');
    }
    assert.doesNotMatch(compactJson, /"sceneFacets"|"styleMatrix"|"sourceEventIds"|"outcomeBeliefs"|"perception":\{/u,
      'compact transport must omit inactive facets and bulky duplicated cognition/perception fields');
  }

  const source = buildDecisionRequestContext(samples[0]);
  assert.ok(source.options[0], 'synthetic shortlist fixture needs one valid option shape');
  const purposes = ['resource', 'resource', 'inquiry', 'care', 'production', 'movement', 'safety', 'other'];
  const syntheticOptions = Array.from({ length: 16 }, (_, index) => {
    const purpose = index < 4 ? 'other' : purposes[(index - 4) % purposes.length];
    const obligation = index === 0 ? 'required-response' : index === 1 ? 'commitment-action' : 'optional';
    const target = index >= 4
      ? index % 3 === 0
        ? { kind: 'person', personId: `synthetic-person-${index}` }
        : index % 3 === 1
          ? { kind: 'drop', dropId: `synthetic-drop-${index}` }
          : { kind: 'container', containerId: `synthetic-container-${index}` }
      : undefined;
    return {
      ...structuredClone(source.options[0]),
      id: `synthetic-option-${String(index).padStart(2, '0')}`,
      summary: `synthetic summary ${index}`,
      reason: `synthetic reason ${index}`,
      target,
      requiresFollowUp: index === 0,
      characterAgendaItemId: index === 2 ? 'synthetic-agenda' : undefined,
      projectId: index === 3 ? 'synthetic-project' : undefined,
      semantics: {
        version: 'action-option-semantics-v1',
        obligation,
        planningChannel: obligation === 'optional' ? 'ordinary' : 'edge',
        purpose,
        minimumLifeStage: 'adult',
        needKinds: [purpose === 'other' ? 'autonomy' : purpose === 'resource' ? 'reserve' : purpose],
      },
    };
  });
  const syntheticFollowUps = Array.from({ length: 8 }, (_, index) => ({
    ...structuredClone(source.followUpOptions[0] ?? source.options[0]),
    id: `synthetic-follow-up-${String(index).padStart(2, '0')}`,
    summary: `synthetic follow-up ${index}`,
    reason: `synthetic follow-up reason ${index}`,
    requiresFollowUp: false,
    target: index % 2
      ? { kind: 'drop', dropId: `synthetic-follow-up-drop-${index}` }
      : { kind: 'container', containerId: `synthetic-follow-up-container-${index}` },
    semantics: {
      version: 'action-option-semantics-v1',
      obligation: 'optional',
      planningChannel: 'ordinary',
      purpose: index % 3 === 0 ? 'resource' : index % 3 === 1 ? 'inquiry' : 'movement',
      minimumLifeStage: 'adult',
      needKinds: ['autonomy'],
    },
    matchesOptionIds: [syntheticOptions[0].id],
  }));
  const appraisalTemplate = source.person.cognition.optionAppraisals[0];
  assert.ok(appraisalTemplate, 'synthetic shortlist fixture needs one appraisal shape');
  const synthetic = structuredClone(source);
  synthetic.options = syntheticOptions;
  synthetic.followUpOptions = syntheticFollowUps;
  synthetic.person.cognition.optionAppraisals = syntheticOptions.map((option, index) => ({
    ...structuredClone(appraisalTemplate),
    optionId: option.id,
    motivation: 100 - index,
    aspiration: 80 - index,
    expectedSuccess: 0.8,
    uncertainty: 0.2,
  }));
  const compactAtMonth = buildCompactDecisionRequestContext(synthetic);
  const protectedHandles = ['o1', 'o2', 'o3', 'o4'];
  for (const handle of protectedHandles) {
    assert.ok(compactAtMonth.options.some((option) => option.id === handle),
      'every required-response, commitment, agenda and project option must be retained');
  }
  const selectedOrdinary = compactAtMonth.options
    .map((option) => Number(/^o([1-9]\d*)$/u.exec(option.id)?.[1]) - 1)
    .filter((index) => index >= 4)
    .map((index) => synthetic.options[index]);
  assert.ok(new Set(selectedOrdinary.map((option) => option.semantics.purpose)).size >= 4,
    'high-appraisal ordinary shortlist must preserve semantic purpose diversity');
  assert.ok(new Set(selectedOrdinary.map((option) => JSON.stringify(option.target))).size >= 4,
    'high-appraisal ordinary shortlist must preserve target diversity');
  assert.ok(compactAtMonth.followUpOptions.some((option) => option.id === 'f1'),
    'a selected conversation opening must retain at least one semantically matching follow-up');

  const nextMonth = structuredClone(synthetic);
  nextMonth.clock.elapsedMonths += 1;
  const compactNextMonth = buildCompactDecisionRequestContext(nextMonth);
  assert.notDeepEqual(
    [...compactAtMonth.options.map((option) => option.id)].sort(),
    [...compactNextMonth.options.map((option) => option.id)].sort(),
    'person-and-month stable exploration slot must rotate instead of freezing one candidate forever',
  );
  assert.notDeepEqual(
    [...compactAtMonth.followUpOptions.map((option) => option.id)].sort(),
    [...compactNextMonth.followUpOptions.map((option) => option.id)].sort(),
    'follow-up exploration slot must also rotate between otherwise equivalent months',
  );

  const fullTotal = fullLengths.reduce((sum, value) => sum + value, 0);
  const compactTotal = compactLengths.reduce((sum, value) => sum + value, 0);
  const ratio = compactTotal / fullTotal;

  console.log(JSON.stringify({
    samples: samples.length,
    fullCharacters: {
      median: percentile(fullLengths, 0.5),
      p90: percentile(fullLengths, 0.9),
      total: fullTotal,
    },
    compactCharacters: {
      median: percentile(compactLengths, 0.5),
      p90: percentile(compactLengths, 0.9),
      total: compactTotal,
    },
    compactComponentCharacters: Object.fromEntries(Object.entries(compactComponentLengths).map(([key, lengths]) => [key, {
      median: percentile(lengths, 0.5),
      p90: percentile(lengths, 0.9),
    }])),
    retainedOptionComposition: {
      allLegal: { median: percentile(fullOptionCounts, 0.5), p90: percentile(fullOptionCounts, 0.9) },
      compact: { median: percentile(compactOptionCounts, 0.5), p90: percentile(compactOptionCounts, 0.9) },
      protected: { median: percentile(protectedOptionCounts, 0.5), p90: percentile(protectedOptionCounts, 0.9) },
      ordinaryDiversePlusExploration: {
        median: percentile(ordinaryOptionCounts, 0.5), p90: percentile(ordinaryOptionCounts, 0.9),
      },
      followUps: { median: percentile(compactFollowUpCounts, 0.5), p90: percentile(compactFollowUpCounts, 0.9) },
    },
    compactToFullRatio: Number(ratio.toFixed(3)),
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
