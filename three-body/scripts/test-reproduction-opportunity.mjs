import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-reproduction-test-'));
const simulationBundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const agreementBundlePath = path.join(temporaryDirectory, 'agreement.mjs');
const executorBundlePath = path.join(temporaryDirectory, 'action-executor.mjs');

try {
  for (const [entry, output] of [
    ['src/game/eland/simulation.ts', simulationBundlePath],
    ['src/game/eland/domain/agreement.ts', agreementBundlePath],
    ['src/game/eland/domain/action-executor.ts', executorBundlePath],
  ]) {
    execFileSync(path.resolve('node_modules/.bin/esbuild'), [
      entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${output}`,
    ], { stdio: 'pipe' });
  }

  const { buildDecisionContexts, createInitialState, seededFraction, stepSimulation } = await import(`${pathToFileURL(simulationBundlePath).href}?test=${Date.now()}`);
  const { recordAgreementAction } = await import(`${pathToFileURL(agreementBundlePath).href}?test=${Date.now()}`);
  const { executePrimitiveAction } = await import(`${pathToFileURL(executorBundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(319, { endpoint: { kind: 'months', value: 12 }, chaosIntensity: 0 });
  const founding = state.world.past.find((event) => event.kind === 'environment' && event.change === 'founding');
  assert.ok(founding, '开局必须存在先民共同抵达事实');
  assert.deepEqual([...founding.diff.participantIds].sort(), state.people.map((person) => person.id).sort());
  assert.ok(state.people.every((person) => person.relations.every((relation) => (
    relation.trust === 6
    && relation.bond === 6
    && relation.fear === 0
    && relation.sourceEventIds.length === 1
    && relation.sourceEventIds[0] === founding.id
  ))), '先民的熟悉关系必须双向、适中且有来源');

  const female = state.people.find((person) => person.sex === 'female') ?? state.people[0];
  const male = state.people.find((person) => person.sex === 'male' && person.id !== female.id) ?? state.people[1];
  female.sex = 'female';
  male.sex = 'male';
  female.bornAtMonth = -24 * 12;
  male.bornAtMonth = -24 * 12;
  female.body = { health: 100, hydration: 100, nutrition: 100 };
  male.body = { health: 100, hydration: 100, nutrition: 100 };
  female.conditions = [];
  male.conditions = [];
  male.position = structuredClone(female.position);
  state.people = [female, male];

  const directedRelation = female.relations.find((relation) => relation.personId === male.id);
  Object.assign(directedRelation, { trust: 4, bond: 4, sourceEventIds: [founding.id] });
  let context = buildDecisionContexts(state).find((candidate) => candidate.person.id === female.id);
  assert.ok(context?.options.some((option) => option.id.startsWith('offer-reproduce:')), `4/4 且有共同事实时应允许提出生殖；实际选项：${context?.options.map((option) => option.id).join(',')}`);
  directedRelation.trust = 3;
  context = buildDecisionContexts(state).find((candidate) => candidate.person.id === female.id);
  assert.equal(context?.options.some((option) => option.id.startsWith('offer-reproduce:')), false, '低于任一关系门槛时不得提出生殖');
  Object.assign(directedRelation, { trust: 4, bond: 4, sourceEventIds: [] });
  context = buildDecisionContexts(state).find((candidate) => candidate.person.id === female.id);
  assert.equal(context?.options.some((option) => option.id.startsWith('offer-reproduce:')), false, '没有真实来源时关系分数仍不得解锁生殖');
  directedRelation.sourceEventIds = [founding.id];

  const actionFact = (id, atMonth, who, action) => ({
    id, kind: 'action', actionTick: 1, atMonth, orderInMonth: 0,
    cellId: female.position.cellId, who, cause: 'intent', action,
    fromCellId: female.position.cellId, toCellId: female.position.cellId,
    fromZ: female.position.z, toZ: female.position.z, pathSegment: [female.position.cellId],
    status: 'completed', result: id, diff: {},
  });
  const agreementId = 'test-independent-reproduction-attempts';
  recordAgreementAction(state, actionFact('test-reproduction-offer', 1, female.id, {
    kind: 'communicate',
    content: { id: agreementId, kind: 'offer', summary: '共同尝试生殖', proposal: { kind: 'reproduce', proposerId: female.id, partnerId: male.id, expiresAtMonth: 3 } },
    audience: [male.id], channel: 'voice',
  }));
  recordAgreementAction(state, actionFact('test-reproduction-acceptance', 1, male.id, {
    kind: 'communicate',
    content: { id: 'test-reproduction-acceptance-content', kind: 'accept', referenceId: agreementId },
    audience: [female.id], channel: 'voice',
  }));

  const reproduceAction = { kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: male.id }] };
  const attemptStateA = structuredClone(state);
  const attemptStateB = structuredClone(state);
  const attemptA = executePrimitiveAction(attemptStateA, attemptStateA.people.find((person) => person.id === female.id), reproduceAction, 2, 0, { cause: 'intent', actionTick: 1 });
  const attemptB = executePrimitiveAction(attemptStateB, attemptStateB.people.find((person) => person.id === female.id), reproduceAction, 2, 1, { cause: 'intent', actionTick: 2 });
  assert.equal(attemptA.status, 'completed');
  assert.equal(attemptB.status, 'completed');
  assert.equal(attemptA.diff.chance, 0.18, '基础受孕概率公式不应因本轮改动而提高');
  assert.equal(attemptB.diff.chance, 0.18);
  assert.notEqual(attemptA.diff.sampleKey, attemptB.diff.sampleKey, '同月两次真实动作必须拥有不同采样键');
  assert.equal(attemptA.diff.sample, seededFraction(state.seed, attemptA.diff.sampleKey), '样本必须可由事件键确定性重放');
  assert.equal(attemptB.diff.sample, seededFraction(state.seed, attemptB.diff.sampleKey));

  const birthState = structuredClone(state);
  const birthMother = birthState.people.find((person) => person.id === female.id);
  birthMother.conditions = [{
    id: 'test-birth-pregnancy', kind: 'pregnancy', stage: 3, sinceMonth: 0, dueAtMonth: 1,
    otherPersonId: male.id, sourceEventIds: [],
  }];
  birthState.civilization.externalClimate = { epoch: 'stable', kind: 'temperate', severity: 0 };
  for (const person of birthState.people) person.body = { health: 100, hydration: 100, nutrition: 100 };
  const afterBirth = stepSimulation(birthState, { decide: () => ({ kind: 'idle', reason: '只检查出生关系' }) });
  const child = afterBirth.people.find((person) => person.bornAtMonth === 1);
  assert.ok(child, '到期妊娠应产生新生儿');
  assert.ok(child.relations.every((relation) => !relation.sourceEventIds.includes(founding.id)), '新生儿不得继承先民共同抵达来源');
  assert.ok(child.relations.filter((relation) => !child.geneticParents.includes(relation.personId)).every((relation) => relation.trust === 0 && relation.bond === 0 && relation.fear === 0 && relation.sourceEventIds.length === 0), '新生儿对非父母人物不得自动获得先民关系加成');

  console.log('reproduction opportunity tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
