import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = mkdtempSync(path.join(tmpdir(), 'eland-plan-arrival-'));
try {
  const bundle = path.join(temporary, 'arrival.mjs');
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=arrival-test.ts', `--outfile=${bundle}`, '--log-level=error',
  ], {
    input: `export { createInitialState, stepSimulationAsync } from './src/game/eland/simulation';
      export { executePrimitiveAction } from './src/game/eland/domain/action-executor';
      export { assessIntentPlan, capturePlanAttempt, attachPlanAttemptReceipt, planPreflightOutcomeKey } from './src/game/eland/application/simulation/plan-progress';
      export { executeActiveIntent } from './src/game/eland/application/simulation/intent-execution';
      export { createWork } from './src/game/eland/domain/works';
      export { Material } from './src/game/eland/domain/material';
      export { cellId, cellX, cellY, setVoxel } from './src/game/eland/world/grid';`,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const api = await import(pathToFileURL(bundle).href);
  const state = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  const person = state.people[0];
  const counterpart = state.people[1];
  // A flat test patch makes occupied-person approach distance independent of terrain.
  for (let x = 10; x <= 16; x += 1) for (let y = 10; y <= 16; y += 1) {
    for (let z = 0; z < state.world.grid.levels; z += 1) {
      api.setVoxel(state.world.grid, x, y, z, z === 0 ? api.Material.Stone : api.Material.Air);
    }
  }
  person.position = { ...person.position, cellId: api.cellId(12, 12), z: 1 };
  counterpart.position = { ...counterpart.position, cellId: api.cellId(14, 12), z: 1 };
  const target = { kind: 'person', personId: counterpart.id };
  const move = {
    kind: 'world-interact', adjudication: {
      version: 'world-adjudicated-interaction-v1', request: '靠近对方', result: '移动尝试',
      targets: [target], status: 'completed', effects: [{ kind: 'move-self', target, withinDistance: 1 }],
    },
  };
  const makeIntent = (conditions) => ({
    id: 'arrival-plan', ownerId: person.id, summary: '到达后取得材料', domain: 'strategic',
    status: 'active', createdAtMonth: 1, lastProgressAtMonth: 1, progress: 0,
    sourceDecisionEventId: 'chosen-plan', planSourceDecisionEventId: 'chosen-plan',
    goal: { kind: 'inventory-at-least', materialId: api.Material.Wood, quantity: 1 },
    nextAction: move, sourceFactIds: [], actionEventIds: [], replanCount: 0,
    plan: { version: 'mental-plan-translation-v1', disposition: 'act', steps: ['到达', '取材'],
      completion: {
        step: { description: '达到当前条件', conditions: structuredClone(conditions) },
        goal: { description: '达到整体条件', conditions: structuredClone(conditions) },
      },
    },
  });
  const perform = (intent, action, order) => {
    const assessmentBefore = api.assessIntentPlan(state, person, intent);
    const before = api.capturePlanAttempt(state, person, action, intent);
    const fact = api.executePrimitiveAction(state, person, action, 1, order, { cause: 'intent', actionTick: order });
    const receipt = {
      version: 'intent-outcome-receipt-v1', atMonth: 1, actionEventId: fact.id,
      execution: fact.status === 'progressed' ? 'progressed' : 'performed',
      goalProgress: 'none', evidence: 'none', sourceEventIds: [fact.id],
    };
    api.attachPlanAttemptReceipt(state, person, intent, fact, receipt, before, assessmentBefore);
    return { fact, receipt };
  };
  const approaching = makeIntent([{ kind: 'near-target', target, maxDistance: 1 }]);
  const approach = perform(approaching, move, 1);
  assert.equal(approach.fact.status, 'progressed', approach.fact.result);
  assert.equal(Math.abs(api.cellX(person.position.cellId) - 14) + Math.abs(api.cellY(person.position.cellId) - 12), 1,
    'a plan requiring one-cell proximity must not stop at the default two-cell reach');
  assert.notEqual(person.position.cellId, counterpart.position.cellId, 'approach cannot occupy another person');
  assert.equal(approach.receipt.planAssessment.step, 'satisfied');

  const drop = { id: 'arrival-wood', materialId: api.Material.Wood, quantity: 1,
    cellId: person.position.cellId, z: 1, createdAtMonth: 0, sourceEventIds: [] };
  state.world.drops.push(drop);
  const dropTarget = { kind: 'drop', dropId: drop.id };
  const inventory = { kind: 'fact', predicate: { kind: 'inventory-at-least', materialId: api.Material.Wood, quantity: 1 } };
  person.inventory = person.inventory.filter((stack) => stack.materialId !== api.Material.Wood);
  const gathering = makeIntent([{ kind: 'reached-target', target: dropTarget, maxDistance: 1 }, inventory]);
  const collect = { kind: 'world-interact', adjudication: {
    version: 'world-adjudicated-interaction-v1', request: '拿起木材', result: '取材尝试',
    targets: [dropTarget], status: 'completed', effects: [
      { kind: 'consume', target: dropTarget, quantity: 1 },
      { kind: 'produce', materialId: api.Material.Wood, quantity: 1, destination: 'inventory' },
    ],
  } };
  const collected = perform(gathering, collect, 2);
  assert.equal(collected.fact.status, 'completed', collected.fact.result);
  assert.equal(drop.quantity, 0);
  assert.equal(collected.receipt.planAssessment.goal, 'satisfied',
    'acquiring a drop must retain the witnessed arrival from before its consumption');
  assert.equal(gathering.planMilestones.length, 1, 'step and goal share the same factual arrival receipt');
  assert.equal(gathering.planMilestones[0].sourceEventId, collected.fact.id);
  const currentProximity = makeIntent([{ kind: 'near-target', target: dropTarget, maxDistance: 1 }, inventory]);
  currentProximity.planMilestones = structuredClone(gathering.planMilestones);
  assert.equal(api.assessIntentPlan(state, person, currentProximity).goal, 'unmet',
    'near-target remains a present-tense check even when an arrival receipt exists');
  const freshChoice = makeIntent(gathering.plan.completion.goal.conditions);
  assert.equal(api.assessIntentPlan(state, person, freshChoice).goal, 'unmet',
    'a separately chosen plan cannot inherit arrival from an earlier plan');
  const continuation = makeIntent(gathering.plan.completion.goal.conditions);
  continuation.planMilestones = structuredClone(gathering.planMilestones);
  assert.equal(api.assessIntentPlan(state, person, continuation).goal, 'satisfied');
  person.inventory = person.inventory.filter((stack) => stack.materialId !== api.Material.Wood);
  assert.equal(api.assessIntentPlan(state, person, continuation).goal, 'unmet',
    'arrival receipts must not make inventory or other current predicates permanently satisfied');

  const work = api.createWork({ position: { x: 13, y: 13, z: 1 }, arrangement: 'support',
    components: [{ materialId: api.Material.Wood, quantity: 2 }], summary: '可检查的构件',
    builderId: person.id, atMonth: 1, sourceEventId: 'built-work',
    layout: { version: 'work-layout-v1', voxels: [
      { offset: { x: 0, y: 0, z: 0 }, materialId: api.Material.Wood },
      { offset: { x: 0, y: 0, z: 1 }, materialId: api.Material.Wood },
    ] },
  });
  state.world.works = [work];
  api.setVoxel(state.world.grid, 13, 13, 1, api.Material.Wood);
  api.setVoxel(state.world.grid, 13, 13, 2, api.Material.Wood);
  const workTarget = { kind: 'work', workId: work.id };
  const inspect = { kind: 'attend', target: workTarget };
  const construction = makeIntent([{ kind: 'work-state', target: workTarget }]);
  assert.equal(api.assessIntentPlan(state, person, construction).goal, 'satisfied');
  const intact = api.capturePlanAttempt(state, person, inspect);
  api.setVoxel(state.world.grid, 13, 13, 2, api.Material.Air);
  assert.notEqual(api.capturePlanAttempt(state, person, inspect).premiseKey, intact.premiseKey,
    'a removed non-anchor layout voxel changes the physical premises');
  api.setVoxel(state.world.grid, 13, 13, 1, api.Material.Air);
  assert.equal(api.assessIntentPlan(state, person, construction).goal, 'unmet',
    'a destroyed work must not remain completed because it was satisfied before');

  // Real r2 regression: near-target was true before consume+assemble, so the
  // entire selected operation vanished without one ActionFact.
  person.position = { ...person.position, cellId: api.cellId(12, 12), z: 1 };
  person.inventory.push({ id: 'preflight-wood', materialId: api.Material.Wood, quantity: 3, sourceEventIds: [] });
  const executeBuild = (anchor, proxyGoal, order) => {
    const site = { kind: 'voxel', position: anchor };
    const near = { kind: 'near-target', target: site, maxDistance: 1 };
    const plannedBuild = makeIntent([near]);
    plannedBuild.id = `real-build-${order}`;
    plannedBuild.goal = { kind: 'knowledge', factId: `unattempted:${order}` };
    plannedBuild.plan.completion.goal.conditions = proxyGoal ? [near]
      : [{ kind: 'work-state', target: { kind: 'produced-work' } }];
    plannedBuild.nextAction = { kind: 'world-interact', adjudication: {
      version: 'world-adjudicated-interaction-v1', request: '把木材立在选定位置', result: '搭建尝试',
      targets: [{ kind: 'inventory-stack', personId: person.id, stackId: 'preflight-wood' }, site],
      status: 'completed', effects: [
        { kind: 'consume', target: { kind: 'inventory-stack', personId: person.id, stackId: 'preflight-wood' }, quantity: 1 },
        { kind: 'assemble', target: site, arrangement: 'support', summary: '实际构件' },
      ],
    } };
    state.intents.push(plannedBuild);
    person.activeIntentId = plannedBuild.id;
    const fact = api.executeActiveIntent(state, person, 1, order, order);
    assert(fact?.kind === 'action', 'satisfied proximity must not swallow the selected assemble');
    assert.equal(fact.status, 'completed', fact.result);
    assert.equal(plannedBuild.actionEventIds.length, 1);
    assert.equal(plannedBuild.planPreflight, undefined);
    assert(fact.diff.appliedEffects.some((effect) => effect.kind === 'assemble'));
  };
  executeBuild({ x: 13, y: 12, z: 1 }, false, 3);
  executeBuild({ x: 12, y: 13, z: 1 }, true, 4);

  const spareDrop = { ...drop, id: 'already-held-drop', quantity: 1, cellId: person.position.cellId };
  state.world.drops.push(spareDrop);
  const alreadyHeldKeys = new Set();
  for (let index = 0; index < 2; index += 1) {
    const selected = makeIntent([inventory]);
    selected.id = `already-held-${index}`;
    selected.sourceDecisionEventId = `translation-${index}`;
    selected.goal = { kind: 'knowledge', factId: `unattempted-collection-${index}` };
    selected.plan.completion.goal.conditions = [{ kind: 'work-state', target: { kind: 'produced-work' } }];
    selected.nextAction = structuredClone(collect);
    selected.nextAction.adjudication.targets = [{ kind: 'drop', dropId: spareDrop.id }];
    selected.nextAction.adjudication.effects[0].target = { kind: 'drop', dropId: spareDrop.id };
    state.intents.push(selected);
    person.activeIntentId = selected.id;
    assert.equal(api.executeActiveIntent(state, person, 1, 5 + index, 5 + index), null);
    assert.equal(selected.planPreflight.reason, 'step-already-satisfied');
    assert.equal(selected.actionEventIds.length, 0, 'preflight evidence must not pretend that collection occurred');
    assert.match(selected.planPreflight.summary, /没有执行/);
    alreadyHeldKeys.add(api.planPreflightOutcomeKey(selected));
  }
  assert.equal(spareDrop.quantity, 1, 'already-held material should not be collected again');
  assert.equal(alreadyHeldKeys.size, 1, 'equivalent skipped outcomes must not trigger repeated Plan calls under new intent ids');

  const monthState = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
  const monthPerson = monthState.people[0];
  monthPerson.inventory.push({ id: 'month-held-wood', materialId: api.Material.Wood, quantity: 3, sourceEventIds: [] });
  monthState.world.drops.push({ ...drop, id: 'month-spare-drop', quantity: 1,
    cellId: monthPerson.position.cellId, z: monthPerson.position.z });
  const monthTarget = { kind: 'drop', dropId: 'month-spare-drop' };
  const monthAction = structuredClone(collect);
  monthAction.adjudication.targets = [monthTarget];
  monthAction.adjudication.effects[0].target = monthTarget;
  const monthPlan = {
    version: 'mental-plan-translation-v1', disposition: 'act', steps: ['备齐木材', '搭建构件'],
    completion: { step: { description: '已有木材', conditions: [inventory] },
      goal: { description: '形成构件', conditions: [{ kind: 'work-state', target: { kind: 'produced-work' } }] } },
  };
  const selectedCollection = () => ({ kind: 'idle', reason: '继续当前取材计划',
    mentalAct: { version: 'mental-act-v2', kind: 'pursue', delivery: 'normal', utterance: '',
      goal: '把材料做成构件', orientation: 'construction', horizon: 'ongoing', strategy: '备料后动手',
      assumptions: [], sourceEventIds: [], plan: structuredClone(monthPlan) },
    executionProbe: { kind: 'world-interaction', adjudication: structuredClone(monthAction.adjudication) },
  });
  let continuationCount = 0;
  const simulatedMonth = await api.stepSimulationAsync(monthState, {
    ownsVoluntarySocialChoices: true,
    async decideAll(contexts) {
      return contexts.map((context) => context.person.id === monthPerson.id
        ? selectedCollection() : { kind: 'idle', reason: '本测试未选择行动' });
    },
    async continuePlans(contexts) {
      return contexts.map((context) => {
        if (context.person.id !== monthPerson.id) return null;
        continuationCount += 1;
        assert.equal(context.continuingPlan.preflightReceipt.reason, 'step-already-satisfied');
        return selectedCollection();
      });
    },
  });
  assert.equal(continuationCount, 1, 'one factual preflight may request translation once, not every tick');
  assert(simulatedMonth.intents.filter((intent) => intent.ownerId === monthPerson.id && intent.planPreflight).length >= 2,
    'the repeated translation was actually installed and checked before deduplication');

  for (const reason of ['柳如是占据构件位置，当前无法放置', '布局需要2份石材，实际只有1份']) {
    const blockedIntent = makeIntent([{ kind: 'work-state', target: { kind: 'produced-work' } }]);
    const before = api.capturePlanAttempt(state, person, collect, blockedIntent);
    const blocked = { id: `blocked:${reason}`, atMonth: 1, action: collect, status: 'blocked', result: reason, diff: {} };
    const receipt = { version: 'intent-outcome-receipt-v1', atMonth: 1, actionEventId: blocked.id,
      execution: 'failed', goalProgress: 'none', evidence: 'none', sourceEventIds: [blocked.id] };
    api.attachPlanAttemptReceipt(state, person, blockedIntent, blocked, receipt, before, api.assessIntentPlan(state, person, blockedIntent));
    assert.equal(blocked.result, reason, 'plan feedback must retain the executor\'s causal failure detail');
  }
  // Losing sight of a parent does not physically prevent a child from walking.
  person.bornAtMonth = -60;
  person.geneticParents = ['absent-parent'];
  person.position = { ...person.position, cellId: api.cellId(12, 12), z: 1 };
  const childMove = makeIntent([]);
  childMove.id = 'child-seeks-other-caregiver';
  delete childMove.plan;
  childMove.goal = { kind: 'inventory-at-least', materialId: api.Material.Stone, quantity: 999 };
  childMove.nextAction = { kind: 'move', toCellId: api.cellId(12, 11), toZ: 1 };
  state.intents.push(childMove);
  person.activeIntentId = childMove.id;
  const childMovement = api.executeActiveIntent(state, person, 1, 20, 20);
  assert.ok(childMovement, 'no visible biological parent must not erase an otherwise executable movement');
  assert.equal(person.position.cellId, api.cellId(12, 11), childMovement.result);

  console.log('Plan execution: arrival milestones, live predicates, real build after proximity, explicit deduplicated preflight, causal failure feedback passed.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
