import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-bounded-foresight-'));
const bundlePath = path.join(temporaryDirectory, 'fixture.mjs');

try {
  const entry = `export * from ${JSON.stringify(path.join(
    projectRoot,
    'src/game/eland/application/cognition/bounded-foresight.ts',
  ))};`;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=bounded-foresight-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const {
    binaryValueOfInformation,
    evaluateBoundedForesight,
    MAX_LOOKAHEAD_DEPTH,
    MAX_LOOKAHEAD_NODES,
    MAX_LOOKAHEAD_ROOTS,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const node = (key, value, children = []) => ({
    key,
    kind: children.length ? 'known-follow-up' : 'replan',
    value,
    sourceFactIds: [`source:${key}`],
    children,
  });
  const fullTree = (prefix) => node(`${prefix}:root`, 0.1, [
    { ...node(`${prefix}:response`, 0.4, [
      node(`${prefix}:verify-a`, 0.5),
      node(`${prefix}:verify-b`, 0.2),
      node(`${prefix}:zz-ignored-third-child`, 1),
    ]), probability: 0.4 },
    { ...node(`${prefix}:no-response`, -0.1, [
      node(`${prefix}:retry-a`, 0.25),
      node(`${prefix}:retry-b`, 0.1),
    ]), probability: 0.6 },
  ]);
  const roots = [
    { optionId: 'd', baseMotivation: 0.4, node: fullTree('d') },
    { optionId: 'b', baseMotivation: 0.8, node: fullTree('b') },
    { optionId: 'e', baseMotivation: 0.2, node: fullTree('e') },
    { optionId: 'a', baseMotivation: 0.8, node: fullTree('a') },
    { optionId: 'c', baseMotivation: 0.6, node: fullTree('c') },
  ];
  const forward = evaluateBoundedForesight(roots);
  const reversed = evaluateBoundedForesight([...roots].reverse());
  assert.deepEqual(reversed, forward, '输入候选顺序不能改变稳定展开结果');
  assert.equal(forward.rootCount, MAX_LOOKAHEAD_ROOTS);
  assert.ok(forward.expandedNodes <= MAX_LOOKAHEAD_NODES);
  assert.ok(forward.maxDepth <= MAX_LOOKAHEAD_DEPTH);
  assert.equal(forward.budgetCutoff, true, '被截掉的根或分支必须留下预算截止审计');
  assert.deepEqual(forward.roots.map((root) => root.optionId), ['a', 'b', 'c', 'd']);
  assert.equal(JSON.stringify(forward).includes('zz-ignored-third-child'), false,
    '每个节点最多展开两个稳定分支');

  const noDilemma = binaryValueOfInformation({
    liveDilemma: false,
    hasAlternative: true,
    responseProbability: 0.5,
    responseContinuationValue: 0.9,
    noResponseContinuationValue: 0.2,
    bestAlternativeValue: 0.5,
    currentCommitmentValue: 0.4,
    relevance: 1,
    experimentCost: 0,
  });
  assert.equal(noDilemma.value, 0);

  const noChoiceChange = binaryValueOfInformation({
    liveDilemma: true,
    hasAlternative: true,
    responseProbability: 0.5,
    responseContinuationValue: 0.7,
    noResponseContinuationValue: 0.6,
    bestAlternativeValue: 0.5,
    currentCommitmentValue: 0.4,
    relevance: 1,
    experimentCost: 0,
  });
  assert.equal(noChoiceChange.value, 0, '两种观察都不改变下一步时信息价值必须为零');

  const useful = binaryValueOfInformation({
    liveDilemma: true,
    hasAlternative: true,
    responseProbability: 0.5,
    responseContinuationValue: 0.9,
    noResponseContinuationValue: 0.2,
    bestAlternativeValue: 0.5,
    currentCommitmentValue: 0.4,
    relevance: 1,
    experimentCost: 0.02,
  });
  assert.equal(useful.changesNextChoice, true);
  assert.ok(useful.value > 0 && useful.value <= 0.2);

  process.stdout.write('bounded foresight tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
