import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = mkdtempSync(path.join(tmpdir(), 'eland-project-delivery-use-'));
try {
  const bundle = path.join(temporary, 'test.mjs');
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=delivery-use-test.ts', `--outfile=${bundle}`, '--log-level=error',
  ], {
    input: `export { createInitialState } from './src/game/eland/simulation';
      export { executePrimitiveAction } from './src/game/eland/domain/action-executor';
      export { activeProjectMaterialDeliveryRequest, perceivedProjectMaterialDelivery } from './src/game/eland/domain/project-material-request';
      export { Material } from './src/game/eland/domain/material';
      export { cellId, setVoxel } from './src/game/eland/world/grid';`,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const api = await import(pathToFileURL(bundle).href);
  const meta = (order) => ({ cause: 'intent', actionTick: order });
  const fixture = () => {
    const state = api.createInitialState(31, { endpoint: { kind: 'months', value: 2 } });
    const [actor, requester, contributor] = state.people;
    for (let x = 8; x <= 18; x += 1) for (let y = 8; y <= 18; y += 1) {
      for (let z = 0; z < state.world.grid.levels; z += 1) api.setVoxel(state.world.grid, x, y, z, z === 0 ? api.Material.Stone : api.Material.Air);
    }
    for (const person of state.people) {
      person.inventory = []; person.memories = []; person.knowledge = []; person.conditions = [];
      person.position = { ...person.position, cellId: api.cellId(10, 10), z: 1 };
    }
    requester.position.cellId = api.cellId(17, 17);
    const source = { cellId: api.cellId(10, 10), z: 1 };
    const request = {
      version: 'project-material-contribution-request-v1', requestEventId: 'request:material',
      projectId: 'project:shelter', requesterId: requester.id, contributorIds: [contributor.id],
      materialId: api.Material.Wood, requestedQuantity: 8, site: source, expiresAtMonth: 5, atMonth: 1,
    };
    const requestAction = {
      id: request.requestEventId, kind: 'action', who: requester.id, atMonth: 1, orderInMonth: 0, actionTick: 0,
      status: 'completed', result: '请求把木材交付到工地', cellId: requester.position.cellId,
      action: { kind: 'talk', speakerMeaning: { kind: 'request', id: 'request:representation', summary: '请求木材',
        projectMaterialContribution: { ...request, quantity: 8 } } },
      diff: { listenerInterpretations: [{ version: 'listener-language-interpretation-v1',
        listenerId: contributor.id, sourceRepresentationId: 'request:representation', kind: 'request' }] },
    };
    state.world.past.push(requestAction);
    state.projects.push({
      id: request.projectId, ownerId: requester.id, kind: 'shelter', summary: '共同遮蔽处', status: 'active',
      site: source, createdAtMonth: 1, lastProgressAtMonth: 1, triggerFactIds: [], beneficiaryIds: [requester.id],
      reservations: [], contributorIds: [contributor.id], actionEventIds: [requestAction.id], failureEventIds: [], completionEventIds: [],
      missingMaterialIds: [api.Material.Wood], materialDemands: [{ materialId: api.Material.Wood, requiredQuantity: 8 }],
      materialContributionRequests: [request],
    });
    contributor.inventory.push({ id: 'stack:donation', materialId: api.Material.Wood, quantity: 4, sourceEventIds: [] });
    const donated = api.executePrimitiveAction(state, contributor, {
      kind: 'transfer', materialId: api.Material.Wood, quantity: 4, stackId: 'stack:donation', authorizationRef: requestAction.id,
      from: { kind: 'person', personId: contributor.id }, to: { kind: 'ground', ...source },
    }, 1, 1, meta(1));
    assert.equal(donated.status, 'completed', donated.result);
    state.world.past.push(donated);
    const drop = state.world.drops.find((candidate) => candidate.projectMaterialDelivery?.requestEventId === requestAction.id);
    assert(drop, 'real request-bound delivery creates provenance');
    assert(api.activeProjectMaterialDeliveryRequest(state, drop, 1));
    const sleeper = structuredClone(contributor);
    sleeper.id = 'witness:asleep'; sleeper.name = '休眠者'; sleeper.memories = [];
    sleeper.conditions = [{ id: 'hibernation', kind: 'dehydrated-hibernation', stage: 1, phase: 'dormant', sourceEventIds: [] }];
    state.people.push(sleeper);
    return { state, actor, requester, contributor, sleeper, drop, request, donated };
  };
  const takeAction = ({ actor, drop }) => ({
    kind: 'transfer', materialId: drop.materialId, quantity: 1, dropId: drop.id,
    from: { kind: 'ground', cellId: drop.cellId, z: drop.z }, to: { kind: 'person', personId: actor.id },
  });
  const memoriesFor = (person, eventId) => person.memories.filter((memory) => memory.sourceEventIds.includes(eventId));

  const taking = fixture();
  assert.equal(api.perceivedProjectMaterialDelivery(taking.state, taking.actor, taking.drop, 1), undefined,
    'an observer who never heard the request cannot read hidden delivery metadata');
  assert.equal(api.perceivedProjectMaterialDelivery(taking.state, taking.contributor, taking.drop, 1).requester, taking.requester.name);
  const relationships = JSON.stringify(taking.state.people.map((person) => person.relations));
  const taken = api.executePrimitiveAction(taking.state, taking.actor, takeAction(taking), 1, 2, meta(2));
  assert.equal(taken.status, 'completed', taken.result);
  assert.equal(taken.diff.authorized, false, 'reservation is recorded as a norm, never a physical lock');
  assert.equal(taking.drop.quantity, 3);
  assert.equal(taken.diff.projectMaterialDeliveryUses[0].delivery.requestEventId, taking.request.requestEventId);
  assert(taking.actor.inventory.some((stack) => stack.quantity === 1 && stack.sourceEventIds.includes(taking.donated.id)));
  assert(memoriesFor(taking.contributor, taken.id).some((memory) => memory.summary.includes('原本')),
    'a present contributor knows both the action and original request');
  assert(!memoriesFor(taking.actor, taken.id).some((memory) => memory.summary.includes(taking.requester.name)),
    'the taking actor does not learn a hidden claimant from system metadata');
  assert.equal(memoriesFor(taking.requester, taken.id).length, 0, 'distant requester gets no telepathic memory');
  assert.equal(memoriesFor(taking.sleeper, taken.id).length, 0, 'a dormant bystander does not witness the taking');
  assert.equal(JSON.stringify(taking.state.people.map((person) => person.relations)), relationships,
    'the event does not manufacture anybody\'s judgement or relationship reaction');

  for (const operation of ['consume', 'relocate']) {
    const current = fixture();
    const target = { kind: 'drop', dropId: current.drop.id };
    const destination = { kind: 'voxel', position: { x: 11, y: 10, z: 1 } };
    const fact = api.executePrimitiveAction(current.state, current.actor, {
      kind: 'world-interact', adjudication: { version: 'world-adjudicated-interaction-v1',
        request: '使用眼前木材', result: '执行材料操作', status: 'completed', targets: [target, ...(operation === 'relocate' ? [destination] : [])],
        effects: [{ kind: operation, target, quantity: 1, ...(operation === 'relocate' ? { destination } : {}) }],
      },
    }, 1, 2, meta(2));
    assert.equal(fact.status, 'completed', fact.result);
    const receipt = fact.diff.appliedEffects.find((effect) => effect.kind === operation).projectMaterialDeliveryUses[0];
    assert.equal(receipt.authorized, false);
    assert.equal(receipt.operation, operation);
    assert.equal(receipt.delivery.requestEventId, current.request.requestEventId);
    assert.equal(current.drop.quantity, 3);
    assert(memoriesFor(current.contributor, fact.id).some((memory) => memory.summary.includes('原本')));
    assert.equal(memoriesFor(current.requester, fact.id).length, 0);
    if (operation === 'relocate') {
      const moved = current.state.world.drops.find((drop) => drop.id === fact.diff.appliedEffects[0].dropId);
      assert.deepEqual(moved.projectMaterialDelivery, current.drop.projectMaterialDelivery,
        'moving the delivery cannot erase its source commitment');
      assert(moved.sourceEventIds.includes(current.donated.id));
    }
  }

  const failedExperiment = fixture();
  const failedTarget = { kind: 'drop', dropId: failedExperiment.drop.id };
  const failed = api.executePrimitiveAction(failedExperiment.state, failedExperiment.actor, {
    kind: 'world-interact', adjudication: { version: 'world-adjudicated-interaction-v1',
      request: '投入木料试做', result: '材料已消耗但试做失败', status: 'failed', targets: [failedTarget],
      effects: [{ kind: 'consume', target: failedTarget, quantity: 1 }],
    },
  }, 1, 2, meta(2));
  assert.equal(failed.status, 'failed');
  assert.equal(failedExperiment.drop.quantity, 3);
  assert(memoriesFor(failedExperiment.contributor, failed.id).some((memory) => memory.summary.includes('消耗')),
    'failure after consuming material must retain the use that actually occurred');

  const expired = fixture();
  const collected = api.executePrimitiveAction(expired.state, expired.actor, takeAction(expired), 6, 2, meta(2));
  assert.equal(collected.status, 'completed', collected.result);
  assert.equal(collected.diff.projectMaterialDeliveryUses[0].active, false);
  assert.equal(collected.diff.authorized, true, 'expired request still has history but no active reservation');
  assert.equal(collected.diff.projectMaterialDeliveryUses[0].delivery.requestEventId, expired.request.requestEventId);

  const far = fixture();
  far.actor.position.cellId = api.cellId(15, 15);
  const rejected = api.executePrimitiveAction(far.state, far.actor, takeAction(far), 1, 2, meta(2));
  assert.equal(rejected.status, 'blocked', rejected.result);
  assert.equal(far.drop.quantity, 4);
  assert.equal(rejected.diff.projectMaterialDeliveryUses, undefined);
  assert.equal(memoriesFor(far.contributor, rejected.id).length, 0,
    'preparation for a physically blocked action is not an observed taking');
  console.log('project delivery use: native transfer, world consumption and relocation share factual provenance without a social lock');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
