import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const workspace = path.resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-modern-achievement-ui-'));
const bundlePath = path.join(temporaryDirectory, 'modern-achievement-ui.cjs');

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function development(overrides = {}) {
  return {
    observerVersion: 'material-institution-era-v7',
    currentEra: 'ancient-civilization',
    historicalPeakEra: 'ancient-civilization',
    candidateEra: 'ancient-civilization',
    candidateSinceMonth: 120,
    transitionProgress: 1,
    satisfiedGateIds: [],
    missingGateIds: [],
    supportingEventIds: [],
    materialCapabilities: [],
    ...overrides,
  };
}

function achievementState(developmentOverrides = {}, { recordExperiment = false } = {}) {
  const readerId = 'person-reader';
  const authorId = 'person-author';
  const recordId = 'record-payload';
  const knowledgeId = 'record-technique';
  const codebookId = 'record-codebook';
  const projectId = 'record-use-project';
  const experiment = {
    id: 'independent-record-experiment',
    kind: 'action',
    actionTick: 1,
    atMonth: 121,
    orderInMonth: 0,
    planningTick: 1,
    orderInTick: 0,
    cellId: 0,
    who: readerId,
    cause: 'intent',
    action: { kind: 'act', operation: 'combine', targets: [] },
    fromCellId: 0,
    toCellId: 0,
    fromZ: 1,
    toZ: 1,
    pathSegment: [0],
    status: 'completed',
    result: '根据他人记录完成独立实验',
    diff: {
      recordUseStage: 'experiment',
      recordUseProjectId: projectId,
      recordUseRecordId: recordId,
      recordUseKnowledgeId: knowledgeId,
      recordUseTechniqueId: knowledgeId,
      recordUseReaderId: readerId,
      recordUseRecordAuthorId: authorId,
      recordUseExpectedOutputMaterialId: 1,
      recordUseKnowledgeConfidenceBefore: 46,
      recordUseKnowledgeConfidenceAfter: 64,
      outputMaterialId: 1,
    },
  };
  return {
    world: { past: recordExperiment ? [experiment] : [] },
    people: recordExperiment ? [{
      id: readerId,
      knowledge: [{
        id: knowledgeId,
        kind: 'technique',
        confidence: 64,
        sourceEventIds: [experiment.id],
      }, {
        id: codebookId,
        kind: 'codebook',
        confidence: 70,
        sourceEventIds: ['codebook-source'],
      }],
    }, {
      id: authorId,
      knowledge: [],
    }] : [],
    projects: recordExperiment ? [{
      id: projectId,
      ownerId: readerId,
      status: 'completed',
      actionEventIds: [experiment.id],
    }] : [],
    records: recordExperiment ? [{
      id: recordId,
      authorId,
      knowledgeId,
      codebookId,
      kind: 'technique',
    }] : [],
    civilization: { development: development(developmentOverrides) },
  };
}

try {
  const entry = `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { ModernCivilizationAchievement }
      from ${JSON.stringify(path.join(workspace, 'src/components/ImmersiveInterface.tsx'))};
    export { toModernCivilizationAchievementView }
      from ${JSON.stringify(path.join(workspace, 'src/game/eland/adapter.ts'))};
    export function renderAchievement(achievement) {
      return renderToStaticMarkup(React.createElement(ModernCivilizationAchievement, { achievement }));
    }
  `;
  execFileSync(path.join(workspace, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=cjs', '--loader=tsx', '--loader:.css=empty',
    `--tsconfig=${path.join(workspace, 'tsconfig.app.json')}`,
    '--sourcefile=modern-achievement-ui-test-entry.tsx', `--outfile=${bundlePath}`,
  ], { cwd: workspace, input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const { renderAchievement, toModernCivilizationAchievementView } = createRequire(import.meta.url)(bundlePath);

  const emptyView = toModernCivilizationAchievementView(achievementState());
  assert.deepEqual(emptyView, {
    status: 'candidate',
    observedFactCount: 0,
    requiredFactCount: 3,
    progress: 0,
    facts: [
      { key: 'stable-electricity', label: '有用供电', observed: false },
      { key: 'reviewable-measurement', label: '可复核测量', observed: false },
      { key: 'independent-record-use', label: '他人读取并使用记录', observed: false },
    ],
  }, '尚未形成现代事实时也应稳定显示0/3，而不是隐藏成就');
  assert.match(renderAchievement(emptyView), /aria-valuenow="0"/);

  const partialView = toModernCivilizationAchievementView(achievementState({
    currentEra: 'ancient-civilization',
    historicalPeakEra: 'ancient-civilization',
    candidateEra: 'ancient-civilization',
    satisfiedGateIds: ['material:bronze-or-iron:institutional'],
    missingGateIds: ['facility:civic-hall-used'],
  }, { recordExperiment: true }));
  assert.deepEqual(partialView, {
    status: 'candidate',
    observedFactCount: 1,
    requiredFactCount: 3,
    progress: 1 / 3,
    facts: [
      { key: 'stable-electricity', label: '有用供电', observed: false },
      { key: 'reviewable-measurement', label: '可复核测量', observed: false },
      { key: 'independent-record-use', label: '他人读取并使用记录', observed: true },
    ],
  }, '古代阶段的当前目标 gate 不包含现代事实时，权威事件仍应立即显示1/3');
  assert.match(renderAchievement(partialView), /aria-valuenow="1"/);

  const candidateState = deepFreeze(achievementState({
    candidateEra: 'modern-civilization',
    candidateSinceMonth: 123,
    transitionProgress: 0.5,
    supportingEventIds: ['independent-record-experiment'],
  }, { recordExperiment: true }));
  const authorityBefore = structuredClone(candidateState);
  const candidateView = toModernCivilizationAchievementView(candidateState);
  assert.deepEqual(candidateState, authorityBefore,
    '读模型映射不得修改权威状态');
  assert.deepEqual(candidateView, {
    status: 'candidate',
    observedFactCount: 1,
    requiredFactCount: 3,
    progress: 1 / 3,
    facts: [
      { key: 'stable-electricity', label: '有用供电', observed: false },
      { key: 'reviewable-measurement', label: '可复核测量', observed: false },
      { key: 'independent-record-use', label: '他人读取并使用记录', observed: true },
    ],
  });

  const candidateHtml = renderAchievement(candidateView);
  assert.match(candidateHtml, /<details class="civilization-index__achievement">/);
  assert.match(candidateHtml, /<summary aria-label="展开现代文明成就，现代事实已汇合">/);
  assert.match(candidateHtml, /这不是待办清单/);
  assert.match(candidateHtml, /有用供电/);
  assert.match(candidateHtml, /可复核测量/);
  assert.match(candidateHtml, /他人读取并使用记录/);
  assert.match(candidateHtml, /role="progressbar"/);
  assert.match(candidateHtml, /aria-valuenow="1"/);
  assert.doesNotMatch(candidateHtml, /<button/,
    '成就反馈不得添加强制 planner 的按钮');

  const historicalState = deepFreeze(achievementState({
    historicalPeakEra: 'modern-civilization',
    transitionProgress: 0,
    missingGateIds: [
      'power:complete-network-useful-load',
      'measurement:calibrated-comparable-mass',
      'record:independent-experiment-reuse',
    ],
  }));
  const historicalBefore = structuredClone(historicalState);
  const historicalView = toModernCivilizationAchievementView(historicalState);
  assert.deepEqual(historicalState, historicalBefore);
  assert.equal(historicalView.status, 'historical-achievement');
  assert.equal(historicalView.observedFactCount, 3);
  assert.ok(historicalView.facts.every((fact) => fact.observed),
    '权威历史峰值已确认过三项成就事实');
  assert.match(renderAchievement(historicalView), /历史最高成就/);

  const currentView = toModernCivilizationAchievementView(achievementState({
    currentEra: 'modern-civilization',
    historicalPeakEra: 'modern-civilization',
    candidateEra: 'modern-civilization',
    transitionProgress: 1,
  }));
  assert.equal(currentView.status, 'achieved');
  assert.equal(currentView.observedFactCount, 3);
  assert.match(renderAchievement(currentView), /现代文明已达成/);

  const css = readFileSync(path.join(workspace, 'src/components/ImmersiveInterface.css'), 'utf8');
  assert.match(css, /civilization-index__achievement > summary:focus-visible/,
    '原生 summary 还需要可见的键盘焦点');

  const rssBytes = process.memoryUsage().rss;
  assert.ok(rssBytes < 256 * 1_024 * 1_024,
    `modern achievement UI fixture RSS ${rssBytes} must remain below 256 MiB`);
  console.log(JSON.stringify({
    result: 'passed',
    candidateStatus: candidateView.status,
    observedFactCount: candidateView.observedFactCount,
    factLabels: candidateView.facts.map((fact) => fact.label),
    historicalStatus: historicalView.status,
    currentStatus: currentView.status,
    rssBytes,
  }));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
