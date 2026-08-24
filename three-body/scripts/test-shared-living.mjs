import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-shared-living-test-'));
const bundlePath = path.join(temporaryDirectory, 'shared-living.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { buildDecisionContext } from ${JSON.stringify(path.resolve('src/game/eland/application/action-options.ts'))};
    export { advanceAgreementLifecycle } from ${JSON.stringify(path.resolve('src/game/eland/domain/agreement.ts'))};
    export { advanceSharedRelationshipExperience } from ${JSON.stringify(path.resolve('src/game/eland/domain/monthly-processes.ts'))};
    export { companionLivingAnchor, companionSharesLivingArea } from ${JSON.stringify(path.resolve('src/game/eland/domain/shared-living.ts'))};
    export { cellsInRadius, findStandingPath, standingPositions } from ${JSON.stringify(path.resolve('src/game/eland/world/grid.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=shared-living-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    advanceAgreementLifecycle,
    advanceSharedRelationshipExperience,
    buildDecisionContext,
    cellsInRadius,
    companionLivingAnchor,
    companionSharesLivingArea,
    createInitialState,
    findStandingPath,
    standingPositions,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(20260821, { endpoint: { kind: 'months', value: 36 }, chaosIntensity: 0 });
  const [first, second] = state.people;
  assert.ok(first && second, '测试需要两名人物');
  state.people = [first, second];
  first.conditions = [];
  second.conditions = [];
  first.body = { health: 100, hydration: 100, nutrition: 100 };
  second.body = { health: 100, hydration: 100, nutrition: 100 };
  second.position = structuredClone(first.position);

  const proposal = buildDecisionContext(state, first, 1).options.find((option) => option.id.startsWith('offer-companion:'));
  assert.equal(proposal?.nextAction.kind, 'communicate', '关系证据充足且同地时应能提出结伴');
  assert.deepEqual(proposal.nextAction.content.proposal?.sharedLivingAnchor, {
    version: 'shared-living-anchor-v1',
    cellId: first.position.cellId,
    z: first.position.z,
    radius: 2,
  }, '结伴提议必须保存稳定生活地点，而不是只保存另一个人的 id');

  const anchor = proposal.nextAction.content.proposal.sharedLivingAnchor;
  const nearby = cellsInRadius(anchor.cellId, anchor.radius)
    .filter((cellId) => cellId !== anchor.cellId)
    .flatMap((cellId) => standingPositions(state.world.grid, cellId))
    .find((position) => Math.abs(position.z - anchor.z) <= 1
      && findStandingPath(state.world.grid, first.position, position).length > 0);
  const outside = cellsInRadius(anchor.cellId, anchor.radius + 4)
    .filter((cellId) => !cellsInRadius(anchor.cellId, anchor.radius).includes(cellId))
    .flatMap((cellId) => standingPositions(state.world.grid, cellId))
    .find((position) => Math.abs(position.z - anchor.z) <= 1
      && findStandingPath(state.world.grid, first.position, position).length > 0);
  assert.ok(nearby && outside, '测试地图需要生活区内的独立槽位和区外可达位置');

  second.position = { ...second.position, ...nearby, previousCellId: nearby.cellId, previousZ: nearby.z };
  const agreement = {
    id: 'test-shared-living-agreement',
    proposal: structuredClone(proposal.nextAction.content.proposal),
    proposerId: first.id,
    responderId: second.id,
    partyIds: [first.id, second.id],
    requiredResponderIds: [second.id],
    acceptedByPersonIds: [first.id, second.id],
    rejectedByPersonIds: [],
    status: 'active',
    proposedAtMonth: 1,
    acceptByMonth: 1,
    acceptedAtMonth: 1,
    dueAtMonth: 25,
    proposalEventId: 'test-shared-living-offer',
    responseEventId: 'test-shared-living-acceptance',
    fulfillmentEventIds: [],
    fulfilledByPersonIds: [],
    coLocatedMonths: 0,
    sourceEventIds: ['test-shared-living-offer', 'test-shared-living-acceptance'],
  };
  state.agreements = [agreement];

  assert.notEqual(first.position.cellId, second.position.cellId, '测试双方必须处在不同格');
  assert.equal(companionSharesLivingArea(state, agreement), true, '生活区内不同格应算共同生活');
  assert.deepEqual(companionLivingAnchor(state, agreement), anchor);
  advanceAgreementLifecycle(state, 1);
  assert.equal(agreement.coLocatedMonths, 1, '共同生活月份不再要求身体坐标重合');

  first.position = { ...first.position, ...outside, previousCellId: outside.cellId, previousZ: outside.z };
  agreement.coLocatedMonths = 1;
  agreement.dueAtMonth = 25;
  let options = buildDecisionContext(state, first, 2).options;
  assert.equal(options.some((option) => option.id.startsWith('rejoin-companion:')), false, '不得再追踪伴侣实时位置');
  assert.equal(options.some((option) => option.id.startsWith('meet:')), false, '共同生活区外也不得退回无后续目的的通用会合');
  assert.equal(options.some((option) => option.id.startsWith('return-shared-living:')), false, '约定仍有时间余量时应允许独立行动');

  agreement.coLocatedMonths = 11;
  agreement.dueAtMonth = 2;
  options = buildDecisionContext(state, first, 2).options;
  const returnHome = options.find((option) => option.id.startsWith('return-shared-living:'));
  assert.ok(returnHome?.nextAction.kind === 'move', '只有履约时间余量用尽后才应回到稳定生活地点');
  assert.notEqual(returnHome.target?.kind, 'person', '返家目标不得是另一个人的实时坐标');
  assert.notEqual(
    `${returnHome.nextAction.toCellId}:${returnHome.nextAction.toZ}`,
    `${second.position.cellId}:${second.position.z}`,
    '稳定生活区应为双方分配可达槽位，避免重新堆叠到同一体素',
  );

  first.position = { ...first.position, cellId: anchor.cellId, z: anchor.z };
  second.position = { ...second.position, ...nearby };
  // This regression isolates shared-living spatial evidence from the separate
  // youth trust bonus. Both people are adults at the month being resolved.
  first.bornAtMonth = 2 - 30 * 12;
  second.bornAtMonth = 2 - 30 * 12;
  const firstRelation = first.relations.find((relation) => relation.personId === second.id);
  const trustBefore = firstRelation.trust;
  const sharedDailyActions = Array.from({ length: 5 }, (_, index) => index + 1).flatMap((actionTick) => (
    [first, second].map((actor, orderInTick) => ({
      id: `test-shared-daily-action:${actionTick}:${actor.id}`,
      kind: 'action', actionTick, atMonth: 2, orderInMonth: actionTick * 2 + orderInTick,
      cellId: actor.position.cellId, who: actor.id, cause: 'intent',
      action: { kind: 'attend', target: { kind: 'person', personId: actor.id === first.id ? second.id : first.id } },
      fromCellId: actor.position.cellId, toCellId: actor.position.cellId,
      fromZ: actor.position.z, toZ: actor.position.z,
      pathSegment: [actor.position.cellId], status: 'completed', result: '在共同生活区内各自行动', diff: {},
    }))
  ));
  const sharedDailyFacts = advanceSharedRelationshipExperience(state, sharedDailyActions, 2);
  assert.equal(sharedDailyFacts[0]?.diff.sharedActionTicks, 5, '共同生活区内不同格的双方行动应形成低强度日常经验');
  assert.equal(firstRelation.trust, trustBefore + 1, '不需要坐标重合也能通过共同日常积累关系');

  state.collectives = [{
    id: 'test-independent-collective', purposeSummary: '长期结伴并共同生活', status: 'active',
    foundedAtMonth: 1, formationAgreementId: 'test-formation',
    memberships: [first, second].map((person) => ({
      id: `membership:${person.id}`, collectiveId: 'test-independent-collective', personId: person.id,
      status: 'active', joinedAtMonth: 1, sourceEventIds: ['test-formation'],
    })),
    decisionRules: [], mandates: [], sourceEventIds: ['test-formation'],
  }];
  assert.equal(
    buildDecisionContext(state, first, 2).options.some((option) => option.id.startsWith('rejoin-collective:')),
    false,
    '共同体成员身份本身不得生成持续追人移动',
  );

  console.log('shared living regression passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
