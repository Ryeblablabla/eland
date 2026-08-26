import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-incremental-evolution-path-test-'));
const bundlePath = path.join(temporaryDirectory, 'evolution-artifacts.mjs');

function trackedEvents(events) {
  const indexes = [];
  const proxy = new Proxy(events, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) indexes.push(Number(property));
      return Reflect.get(target, property, receiver);
    },
  });
  return { proxy, indexes };
}

function stateAt(month, events, milestones) {
  return {
    clock: { elapsedMonths: month },
    world: {
      past: events,
      historyCursor: {
        version: 1, eventCount: events.length, hotStartIndex: 0,
        tailEventId: events.at(-1)?.id ?? null,
      },
    },
    people: [
      { id: 'p1', bornAtMonth: 0 },
      { id: 'p2', bornAtMonth: 13 },
    ],
    civilization: {
      stage: '自然群体',
      civilizationIndex: { total: 0, components: {} },
    },
    derived: { milestones },
  };
}

const decision = (id, atMonth, usedModel) => ({ id, kind: 'decision', atMonth, usedModel });
const action = (id, atMonth, who) => ({ id, kind: 'action', atMonth, who });
const birth = (id, atMonth, bornPersonId, who) => ({
  id,
  kind: 'environment',
  atMonth,
  who,
  change: 'birth',
  result: `${bornPersonId} born`,
  diff: { bornPersonId },
});
const death = (id, atMonth, who) => ({
  id,
  kind: 'environment',
  atMonth,
  who,
  change: 'death',
  result: `${who} died`,
  diff: {},
});

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'server/evolution-artifacts.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  const { buildEvolutionFactsReport, checkpointFor, evolvePath } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const firstEvents = [
    decision('decision-rule-1', 1, false),
    decision('decision-model-1', 2, true),
    birth('birth-1', 3, 'p1', 'p2'),
    action('old-evidence', 4, 'p1'),
  ];
  const firstMilestone = {
    id: 'first-capability',
    label: '首个能力',
    note: '已形成首个可回放能力',
    observedAtMonth: 4,
    evidenceEventIds: ['old-evidence'],
  };
  const firstState = stateAt(12, firstEvents, [firstMilestone]);
  const usage = { inputTokens: 0, outputTokens: 0 };
  const firstCheckpoint = checkpointFor(firstState, usage);
  assert.equal(firstCheckpoint.ruleDecisions, 1);
  assert.equal(firstCheckpoint.modelDecisions, 1);
  const firstPath = evolvePath(firstState, {
    runId: 'incremental-path',
    model: 'rule-planner-v1',
    fromMonth: 0,
    requestedEndMonth: 36,
    checkpoint: firstCheckpoint,
    status: 'running',
  });

  const secondEvents = [
    ...firstEvents,
    decision('decision-rule-2', 13, false),
    death('death-1', 14, 'p1'),
    action('new-evidence', 15, 'p2'),
    birth('birth-2', 16, 'p2', 'p1'),
  ];
  const secondMilestone = {
    id: 'second-capability',
    label: '第二个能力',
    note: '新旧事实已形成第二个能力',
    observedAtMonth: 15,
    evidenceEventIds: ['old-evidence', 'new-evidence'],
    participantIds: ['p1'],
    affectedPersonIds: ['p2'],
  };
  const secondState = stateAt(24, secondEvents, [firstMilestone, secondMilestone]);
  const trackedCheckpointEvents = trackedEvents(secondEvents);
  const incrementalCheckpoint = checkpointFor(
    { ...secondState, world: { ...secondState.world, past: trackedCheckpointEvents.proxy } },
    usage,
    firstCheckpoint,
  );
  const fullCheckpoint = checkpointFor(secondState, usage);
  assert.deepEqual(
    {
      ruleDecisions: incrementalCheckpoint.ruleDecisions,
      modelDecisions: incrementalCheckpoint.modelDecisions,
      eventCount: incrementalCheckpoint.eventCount,
    },
    {
      ruleDecisions: fullCheckpoint.ruleDecisions,
      modelDecisions: fullCheckpoint.modelDecisions,
      eventCount: fullCheckpoint.eventCount,
    },
    'incremental decision counts must equal a full replay',
  );
  assert.deepEqual(
    [...new Set(trackedCheckpointEvents.indexes)].sort((left, right) => left - right),
    [4, 5, 6, 7],
    'the second checkpoint must read only events after the previous eventCount',
  );

  const trackedMilestoneEvents = trackedEvents(secondEvents);
  const incrementalPath = evolvePath({ ...secondState, world: { ...secondState.world, past: trackedMilestoneEvents.proxy } }, {
    runId: 'incremental-path',
    model: 'rule-planner-v1',
    fromMonth: 0,
    requestedEndMonth: 36,
    previous: firstPath,
    checkpoint: incrementalCheckpoint,
    status: 'running',
  });
  assert.deepEqual(
    [...new Set(trackedMilestoneEvents.indexes)].sort((left, right) => left - right),
    [4, 5, 6, 7],
    'a newly observed milestone may resolve evidence only from the same event suffix',
  );
  const fullPath = evolvePath(secondState, {
    runId: 'incremental-path',
    model: 'rule-planner-v1',
    fromMonth: 0,
    requestedEndMonth: 36,
    checkpoint: fullCheckpoint,
    status: 'running',
  });
  assert.deepEqual(incrementalPath.turningPoints, fullPath.turningPoints, 'incremental turning points must match a full replay');
  assert.deepEqual(
    incrementalPath.turningPoints.find((point) => point.id === 'milestone:second-capability')?.personIds,
    ['p1', 'p2'],
    'new milestone evidence may resolve both prefix and suffix events without a permanent full event map',
  );

  const replayedSameState = evolvePath(secondState, {
    runId: 'incremental-path',
    model: 'rule-planner-v1',
    fromMonth: 0,
    requestedEndMonth: 36,
    previous: incrementalPath,
    checkpoint: incrementalCheckpoint,
    status: 'running',
  });
  assert.deepEqual(replayedSameState.turningPoints, incrementalPath.turningPoints);
  assert.equal(
    new Set(replayedSameState.turningPoints.map((point) => point.id)).size,
    replayedSameState.turningPoints.length,
    'replaying the same persisted head must not duplicate turning points',
  );

  const thirdEvents = [...secondEvents, decision('decision-model-2', 25, true)];
  const thirdState = stateAt(36, thirdEvents, [firstMilestone, secondMilestone]);
  const trackedTurningEvents = trackedEvents(thirdEvents);
  const thirdCheckpoint = checkpointFor(thirdState, usage, incrementalCheckpoint);
  evolvePath({ ...thirdState, world: { ...thirdState.world, past: trackedTurningEvents.proxy } }, {
    runId: 'incremental-path',
    model: 'rule-planner-v1',
    fromMonth: 0,
    requestedEndMonth: 36,
    previous: incrementalPath,
    checkpoint: thirdCheckpoint,
    status: 'completed',
  });
  assert.deepEqual(
    [...new Set(trackedTurningEvents.indexes)].sort((left, right) => left - right),
    [8],
    'without a new milestone, turning-point evolution must inspect only the event suffix',
  );

  const boundedSecondEvents = trackedEvents(secondEvents.slice(4));
  const boundedSecondState = {
    ...secondState,
    world: {
      ...secondState.world,
      past: boundedSecondEvents.proxy,
      historyCursor: {
        version: 1, eventCount: secondEvents.length, hotStartIndex: 4,
        tailEventId: secondEvents.at(-1).id,
      },
    },
  };
  const boundedCheckpoint = checkpointFor(boundedSecondState, usage, firstCheckpoint);
  assert.deepEqual(
    {
      eventCount: boundedCheckpoint.eventCount,
      ruleDecisions: boundedCheckpoint.ruleDecisions,
      modelDecisions: boundedCheckpoint.modelDecisions,
    },
    {
      eventCount: fullCheckpoint.eventCount,
      ruleDecisions: fullCheckpoint.ruleDecisions,
      modelDecisions: fullCheckpoint.modelDecisions,
    },
    'bounded checkpoint 必须使用绝对 cursor 并从上一绝对 checkpoint 连续累计',
  );
  assert.deepEqual([...new Set(boundedSecondEvents.indexes)].sort((left, right) => left - right), [0, 1, 2, 3],
    'bounded checkpoint 只能读取本地热窗对应的绝对 suffix');
  assert.throws(() => checkpointFor(boundedSecondState, usage), /缺少绝对序号/u,
    '没有前缀累计的 bounded checkpoint 必须 fail closed');
  assert.throws(() => checkpointFor(boundedSecondState, usage, { ...firstCheckpoint, eventCount: 3 }), /缺少绝对序号/u,
    '上一 checkpoint 落在冷前缀时不得从热窗零点重算');
  assert.throws(
    () => buildEvolutionFactsReport(boundedSecondState, incrementalPath),
    /累计报告投影/u,
    'terminal report 尚未有全历史累计时不得把 bounded 热窗伪装成完整事实报告',
  );

  process.stdout.write('incremental evolution path tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
