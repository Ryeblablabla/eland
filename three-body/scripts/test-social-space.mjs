import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-social-space-test-'));

try {
  const entries = {
    simulation: 'src/game/eland/simulation.ts',
    executor: 'src/game/eland/domain/action-executor.ts',
    socialSpace: 'src/game/eland/domain/social-space.ts',
    needAgenda: 'src/game/eland/application/cognition/need-agenda.ts',
    grid: 'src/game/eland/world/grid.ts',
  };
  const modules = {};
  for (const [name, entry] of Object.entries(entries)) {
    const output = path.join(temporaryDirectory, `${name}.mjs`);
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
    ], { stdio: 'pipe' });
    modules[name] = await import(`${pathToFileURL(output).href}?test=${Date.now()}`);
  }

  const { buildDecisionContexts, createInitialState } = modules.simulation;
  const { executePrimitiveAction } = modules.executor;
  const {
    conversationalRendezvous,
    positionsWithinVoiceRange,
    standingOccupancy,
  } = modules.socialSpace;
  const { deriveNeedAgenda } = modules.needAgenda;
  const { cellsInRadius, findStandingPath, standingPositions } = modules.grid;

  const setPosition = (person, position) => {
    person.position.cellId = position.cellId;
    person.position.z = position.z;
    person.position.previousCellId = position.cellId;
    person.position.previousZ = position.z;
  };
  const reachablePosition = (state, person, radius, predicate) => cellsInRadius(person.position.cellId, radius)
    .flatMap((cellId) => standingPositions(state.world.grid, cellId))
    .find((position) => predicate(position)
      && findStandingPath(state.world.grid, person.position, position).length > 0);

  const speechState = createInitialState(4201, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const teacher = speechState.people[0];
  const learner = speechState.people[1];
  speechState.people = [teacher, learner];
  teacher.bornAtMonth = -20 * 12;
  learner.bornAtMonth = -12 * 12;
  const adjacent = reachablePosition(speechState, teacher, 1, (position) => position.cellId !== teacher.position.cellId
    && Math.abs(position.z - teacher.position.z) <= 1);
  assert.ok(adjacent, '测试地图需要一个可达相邻站位');
  setPosition(learner, adjacent);
  assert.equal(positionsWithinVoiceRange(teacher.position, learner.position), true);

  const techniqueId = 'technique:test-adjacent-teaching';
  teacher.knowledge.push({
    id: techniqueId,
    kind: 'technique',
    summary: '相邻位置教学测试',
    confidence: 80,
    learnedAtMonth: 0,
    sourceEventIds: [speechState.world.past[0].id],
  });
  const teacherContext = buildDecisionContexts(speechState)
    .find((context) => context.person.id === teacher.id);
  const teaching = teacherContext?.options.find((option) => option.id.startsWith('teach:')
    && option.target?.kind === 'person'
    && option.target.personId === learner.id
    && option.nextAction.kind === 'communicate'
    && option.nextAction.content.factId === techniqueId);
  assert.ok(teaching, '相邻但不同格的人应能直接获得明确教学选项');
  const teachingEvent = executePrimitiveAction(speechState, teacher, teaching.nextAction, 1, 0, {
    cause: 'intent', actionTick: 1,
  });
  assert.equal(teachingEvent.status, 'completed', '相邻教学应完成');
  assert.ok(learner.knowledge.some((fact) => fact.id === techniqueId && fact.confidence >= 55));

  const transferable = teacher.inventory[0] ?? {
    id: 'test-transfer-stack', materialId: 3, quantity: 1, sourceEventIds: [speechState.world.past[0].id],
  };
  if (!teacher.inventory.includes(transferable)) teacher.inventory.push(transferable);
  const transferEvent = executePrimitiveAction(speechState, teacher, {
    kind: 'transfer',
    materialId: transferable.materialId,
    quantity: 1,
    from: { kind: 'person', personId: teacher.id },
    to: { kind: 'person', personId: learner.id },
    stackId: transferable.id,
  }, 1, 1, { cause: 'intent', actionTick: 2 });
  assert.equal(transferEvent.status, 'blocked', '相邻说得上话不代表可以隔格交付物品');
  assert.match(transferEvent.result, /近身范围/);

  const exchangeState = createInitialState(4205, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const offerer = exchangeState.people[0];
  const partner = exchangeState.people[1];
  exchangeState.people = [offerer, partner];
  offerer.bornAtMonth = -20 * 12;
  partner.bornAtMonth = -20 * 12;
  const exchangeAdjacent = reachablePosition(exchangeState, offerer, 1, (position) => position.cellId !== offerer.position.cellId
    && Math.abs(position.z - offerer.position.z) <= 1);
  assert.ok(exchangeAdjacent);
  setPosition(partner, exchangeAdjacent);
  offerer.inventory.push({ id: 'exchange-offer-stack', materialId: 3, quantity: 1, sourceEventIds: [exchangeState.world.past[0].id] });
  partner.inventory.push({ id: 'exchange-partner-stack', materialId: 11, quantity: 1, sourceEventIds: [exchangeState.world.past[0].id] });
  const offerId = `offer-exchange:test:${offerer.id}:${partner.id}`;
  const offerEvent = executePrimitiveAction(exchangeState, offerer, {
    kind: 'communicate',
    content: {
      id: offerId,
      kind: 'offer',
      summary: '提出相邻交换测试',
      proposal: {
        kind: 'exchange', offererId: offerer.id, partnerId: partner.id,
        offererMaterialId: 3, offererQuantity: 1,
        partnerMaterialId: 11, partnerQuantity: 1,
        expiresAtMonth: 6,
      },
    },
    audience: [partner.id],
    channel: 'voice',
  }, 1, 0, { cause: 'intent', actionTick: 1 });
  exchangeState.world.past.push(offerEvent);
  assert.equal(offerEvent.status, 'completed', '相邻位置应能提出交换');
  const exchangeResponse = buildDecisionContexts(exchangeState)
    .find((context) => context.person.id === partner.id)?.options
    .find((option) => option.id.startsWith('accept-exchange:'));
  assert.ok(exchangeResponse, '相邻位置应产生交换接受选项');
  assert.equal(exchangeResponse.nextAction.kind, 'communicate', '相邻位置接受交换不应先挤到同一格');
  const acceptanceEvent = executePrimitiveAction(exchangeState, partner, exchangeResponse.nextAction, 1, 1, {
    cause: 'intent', actionTick: 2,
  });
  assert.equal(acceptanceEvent.status, 'completed', '相邻位置应能接受交换');

  const rendezvousState = createInitialState(4202, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const mover = rendezvousState.people[0];
  const listener = rendezvousState.people[1];
  rendezvousState.people = [mover, listener];
  const distant = reachablePosition(rendezvousState, mover, 4, (position) => {
    const pathLength = findStandingPath(rendezvousState.world.grid, mover.position, position).length;
    return pathLength >= 4;
  });
  assert.ok(distant, '测试地图需要一个较远可见站位');
  setPosition(listener, distant);
  const rendezvous = conversationalRendezvous(rendezvousState, mover, listener);
  assert.ok(rendezvous, '远处交谈应能找到会合站位');
  assert.equal(positionsWithinVoiceRange(rendezvous.position, listener.position), true);
  assert.notDeepEqual(rendezvous.position, { cellId: listener.position.cellId, z: listener.position.z }, '有空邻位时不应挤进听者的精确站位');
  assert.equal(rendezvous.occupancy, 0, '会合应优先选择空闲邻位');

  const crowdedState = createInitialState(4203, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const crowdedPeople = crowdedState.people.slice(0, 4);
  crowdedState.people = crowdedPeople;
  for (const person of crowdedPeople) {
    person.bornAtMonth = -20 * 12;
    setPosition(person, crowdedPeople[0].position);
  }
  const crowdedContext = buildDecisionContexts(crowdedState)
    .find((context) => context.person.id === crowdedPeople[0].id);
  const relief = crowdedContext?.options.find((option) => option.id.startsWith('relieve-crowding:'));
  assert.ok(relief && relief.nextAction.kind === 'move', '四人同格应产生自愿疏散选项');
  assert.ok(standingOccupancy(crowdedState, {
    cellId: relief.nextAction.toCellId,
    z: relief.nextAction.toZ,
  }, crowdedPeople[0].id) < 4, '疏散目标必须比当前站位更空');
  const needs = deriveNeedAgenda(crowdedContext, crowdedState.clock.elapsedMonths);
  assert.ok(needs.some((need) => need.kind === 'spatial-comfort' && need.urgency > 0), '拥挤必须成为柔性需要而非强制位移');

  const uncrowdedState = createInitialState(4204, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  uncrowdedState.people = uncrowdedState.people.slice(0, 2);
  for (const person of uncrowdedState.people) {
    person.bornAtMonth = -20 * 12;
    setPosition(person, uncrowdedState.people[0].position);
  }
  const uncrowdedContext = buildDecisionContexts(uncrowdedState)
    .find((context) => context.person.id === uncrowdedState.people[0].id);
  assert.equal(uncrowdedContext?.options.some((option) => option.id.startsWith('relieve-crowding:')), false, '两人同格不应产生拥挤疏散');
  assert.equal(deriveNeedAgenda(uncrowdedContext, 0).some((need) => need.kind === 'spatial-comfort'), false);

  console.log('social space tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
