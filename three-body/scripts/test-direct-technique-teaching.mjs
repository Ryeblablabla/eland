import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-direct-teaching-test-'));
const bundlePath = path.join(temporaryDirectory, 'simulation.mjs');
const executorBundlePath = path.join(temporaryDirectory, 'action-executor.mjs');

try {
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/simulation.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: 'pipe' });
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    'src/game/eland/domain/action-executor.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${executorBundlePath}`,
  ], { stdio: 'pipe' });
  const { buildDecisionContexts, createInitialState } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const { executePrimitiveAction } = await import(`${pathToFileURL(executorBundlePath).href}?test=${Date.now()}`);

  const placeWith = (person, other) => {
    person.position.cellId = other.position.cellId;
    person.position.z = other.position.z;
    person.position.previousCellId = other.position.cellId;
    person.position.previousZ = other.position.z;
  };
  const runAction = (state, actor, action, label) => {
    const event = executePrimitiveAction(state, actor, action, 1, 0, { cause: 'intent', actionTick: 1 });
    state.world.past.push(event);
    assert.equal(event.who, actor.id, label);
    return event;
  };

  const techniqueId = 'technique:combine:22:3:11';
  const techniqueSummary = '种子与湿土可结合为作物幼苗';

  let state = createInitialState(3831, { endpoint: { kind: 'months', value: 3 }, chaosIntensity: 0 });
  const teacher = state.people[0];
  const learner = state.people[1];
  teacher.bornAtMonth = -20 * 12;
  learner.bornAtMonth = -12 * 12;
  placeWith(learner, teacher);
  teacher.knowledge.push({ id: techniqueId, kind: 'technique', summary: techniqueSummary, confidence: 80, learnedAtMonth: 0, sourceEventIds: ['teacher-trial'] });

  const contexts = buildDecisionContexts(state);
  const teachingOption = contexts.find((context) => context.person.id === teacher.id)?.options.find((option) => option.id.startsWith('teach:')
    && option.target?.kind === 'person'
    && option.target.personId === learner.id
    && option.nextAction.kind === 'communicate'
    && option.nextAction.content.factId === techniqueId);
  assert.ok(teachingOption, '可靠知识、同地和学习年龄应产生直接教导选项');
  assert.equal(contexts.flatMap((context) => context.options).some((option) => option.id.startsWith('request-technique:')
    || option.id.startsWith('demonstrate-technique:')
    || option.id.includes('imitate-technique-')
    || (option.nextAction.kind === 'act' && Boolean(option.nextAction.techniqueDemonstration || option.nextAction.techniqueImitation))), false, '新规划不得产生示范或模仿链');

  const teachingEvent = runAction(state, teacher, teachingOption.nextAction, 'direct-teaching');
  const taught = state.people.find((person) => person.id === learner.id)?.knowledge.find((fact) => fact.id === techniqueId);
  assert.equal(teachingEvent.status, 'completed', '合法教导应完成');
  assert.equal(taught?.confidence, 60, '一次明确教导应达到可靠阈值');
  assert.ok(teachingEvent && taught.sourceEventIds.includes(teachingEvent.id), '可靠知识必须引用真实教导事件');

  let casualState = createInitialState(3832, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const casualTeacher = casualState.people[0];
  const casualLearner = casualState.people[1];
  casualTeacher.bornAtMonth = -20 * 12;
  casualLearner.bornAtMonth = -12 * 12;
  placeWith(casualLearner, casualTeacher);
  casualTeacher.knowledge.push({ id: techniqueId, kind: 'technique', summary: techniqueSummary, confidence: 80, learnedAtMonth: 0, sourceEventIds: ['casual-teacher-trial'] });
  const casualEvent = runAction(casualState, casualTeacher, {
    kind: 'communicate',
    content: { id: 'casual-claim', kind: 'claim', factId: techniqueId, summary: techniqueSummary },
    audience: [casualLearner.id],
    channel: 'voice',
  }, 'casual-claim');
  const casualKnowledge = casualState.people.find((person) => person.id === casualLearner.id)?.knowledge.find((fact) => fact.id === techniqueId);
  assert.equal(casualEvent.status, 'completed', '同地普通讲述应完成');
  assert.ok(casualKnowledge && casualKnowledge.confidence < 55, '普通讲述只能留下不可靠技术线索');

  let underageState = createInitialState(3833, { endpoint: { kind: 'months', value: 2 }, chaosIntensity: 0 });
  const underageTeacher = underageState.people[0];
  const underageLearner = underageState.people[1];
  underageTeacher.bornAtMonth = -20 * 12;
  underageLearner.bornAtMonth = -1 * 12;
  placeWith(underageLearner, underageTeacher);
  underageTeacher.knowledge.push({ id: techniqueId, kind: 'technique', summary: techniqueSummary, confidence: 80, learnedAtMonth: 0, sourceEventIds: ['underage-teacher-trial'] });
  const underageContexts = buildDecisionContexts(underageState);
  assert.equal(underageContexts.find((context) => context.person.id === underageTeacher.id)?.options.some((option) => option.id.startsWith('teach:')
    && option.target?.kind === 'person'
    && option.target.personId === underageLearner.id), false, '六岁以下人物不能成为教导目标');
  const underageEvent = runAction(underageState, underageTeacher, {
    kind: 'communicate',
    content: { id: `teach:forged:${techniqueId}`, kind: 'claim', factId: techniqueId, summary: techniqueSummary },
    audience: [underageLearner.id],
    channel: 'voice',
  }, 'forged-underage-teaching');
  assert.equal(underageState.people.find((person) => person.id === underageLearner.id)?.knowledge.some((fact) => fact.id === techniqueId), false, '伪造教导动作也不能把技术灌输给六岁以下人物');
  assert.equal(underageEvent.status, 'blocked', '非法低龄教导必须被阻塞');
  assert.ok(underageEvent.result.includes('年龄'), '非法低龄教导应说明年龄原因');

  console.log('direct technique teaching tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
