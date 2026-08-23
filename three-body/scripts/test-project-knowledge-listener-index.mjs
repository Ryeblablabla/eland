import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'threebody-project-knowledge-index-'));
const bundlePath = path.join(temporaryDirectory, 'project-knowledge-index.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/monthly-simulation.ts'))};
    export { executePrimitiveAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/action-executor.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { isAlive } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/person.ts'))};
    export {
      inspectProjectKnowledgeRequest,
      openProjectKnowledgeRequestsFor,
      registerProjectKnowledgeRequestListeners,
    } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/project-knowledge-request.ts'))};
  `;
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=project-knowledge-index-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    Material,
    createInitialState,
    executePrimitiveAction,
    inspectProjectKnowledgeRequest,
    isAlive,
    openProjectKnowledgeRequestsFor,
    registerProjectKnowledgeRequestListeners,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(20_260_823, {
    endpoint: { kind: 'months', value: 24 },
    chaosIntensity: 0,
  });
  state.clock.elapsedMonths = 10;
  state.projects = [];
  const [requester, teacherA, teacherB] = state.people;
  for (const person of [requester, teacherA, teacherB]) {
    delete person.diedAtMonth;
    person.bornAtMonth = -20 * 12;
    person.conditions = [];
    person.body = { health: 100, hydration: 100, nutrition: 100 };
    person.knowledge = [];
  }
  teacherA.position = structuredClone(requester.position);
  teacherB.position = structuredClone(requester.position);

  function project(id, status = 'active') {
    return {
      id,
      kind: 'production',
      need: 'mechanical-power-capability',
      desiredFunction: 'water-powered-crop-processing',
      summary: '测试项目知识监听索引',
      ownerId: requester.id,
      beneficiaryIds: [requester.id],
      triggerFactIds: [],
      pressure: 50,
      createdAtMonth: 0,
      reviewAtMonth: 24,
      status,
      lastProgressAtMonth: 0,
      missingMaterialIds: [],
      reservations: [],
      contributorIds: [],
      actionEventIds: [],
      failureEventIds: [],
      completionEventIds: [],
      mechanicalPowerPlan: {
        version: 'mechanical-power-plan-v1',
        projectId: id,
        sourceSegmentId: `test-current:${id}`,
        wheelPosition: { x: 1, y: 1, z: 1 },
        shaftPositions: [{ x: 2, y: 1, z: 1 }],
        loadPosition: { x: 3, y: 1, z: 1 },
        sourceKeys: [`test-current:${id}`],
      },
      knowledgeRequests: [],
    };
  }

  function request(projectId, requestEventId, atMonth, expiresAtMonth, listenerIds, extra = {}) {
    return {
      version: 'project-knowledge-request-v1',
      projectId,
      requestEventId,
      requesterId: requester.id,
      listenerIds,
      outputMaterialId: Material.Mill,
      expiresAtMonth,
      atMonth,
      ...extra,
    };
  }

  function legacyOpenRequestsFor(currentState, teacher, atMonth) {
    return currentState.projects.flatMap((candidateProject) => (
      candidateProject.knowledgeRequests ?? []
    ).flatMap((candidateRequest) => {
      if (!candidateRequest.listenerIds.includes(teacher.id)
        || inspectProjectKnowledgeRequest(
          currentState,
          candidateProject,
          candidateRequest,
          atMonth,
        ) !== 'open') return [];
      const livingRequester = currentState.people.find((person) => (
        person.id === candidateRequest.requesterId && isAlive(person)
      ));
      return livingRequester
        ? [{ project: candidateProject, request: candidateRequest, requester: livingRequester }]
        : [];
    })).sort((left, right) => left.request.atMonth - right.request.atMonth
      || left.request.requestEventId.localeCompare(right.request.requestEventId));
  }

  const ids = (results) => results.map((result) => result.request.requestEventId);
  const assertLegacyExact = (currentState, teacher, atMonth, message) => {
    assert.deepEqual(
      ids(openProjectKnowledgeRequestsFor(currentState, teacher, atMonth)),
      ids(legacyOpenRequestsFor(currentState, teacher, atMonth)),
      message,
    );
  };

  const primary = project('project:primary');
  const openLater = request(primary.id, 'request:b', 4, 20, [teacherA.id]);
  const openEarlier = request(primary.id, 'request:z', 2, 20, [teacherA.id, teacherB.id]);
  const expired = request(primary.id, 'request:expired', 1, 9, [teacherA.id]);
  const answered = request(primary.id, 'request:answered', 3, 20, [teacherA.id], {
    responseEventId: 'response:answered',
  });
  primary.knowledgeRequests.push(openLater, expired, answered, openEarlier);
  const obsoleteProject = project('project:obsolete', 'blocked');
  const obsolete = request(obsoleteProject.id, 'request:obsolete', 0, 20, [teacherA.id]);
  obsoleteProject.knowledgeRequests.push(obsolete);
  state.projects = [primary, obsoleteProject];

  assert.equal(inspectProjectKnowledgeRequest(state, primary, openEarlier, 10), 'open');
  assert.equal(inspectProjectKnowledgeRequest(state, primary, expired, 10), 'expired');
  assert.equal(inspectProjectKnowledgeRequest(state, primary, answered, 10), 'answered');
  assert.equal(inspectProjectKnowledgeRequest(state, obsoleteProject, obsolete, 10), 'obsolete');
  assertLegacyExact(state, teacherA, 10, '初始四种动态状态必须与 flatMap 参考一致');
  assert.deepEqual(ids(openProjectKnowledgeRequestsFor(state, teacherA, 10)), [
    'request:z',
    'request:b',
  ], '候选索引不能改变既有 atMonth + requestEventId 排序');
  assertLegacyExact(state, teacherB, 10, '多 listener 请求必须出现在每个被点名教师的候选中');
  assert.deepEqual(ids(openProjectKnowledgeRequestsFor(state, teacherB, 10)), ['request:z']);

  openEarlier.responseEventId = 'response:dynamic';
  assertLegacyExact(state, teacherA, 10, '动态 response 变化不得依赖重建索引');
  delete openEarlier.responseEventId;
  assertLegacyExact(state, teacherA, 10, '撤销动态 response 后仍须按权威检查器重新开放');
  assertLegacyExact(state, teacherA, 21, 'atMonth 动态过期不得依赖重建索引');
  primary.status = 'blocked';
  assertLegacyExact(state, teacherA, 10, '项目状态动态失效不得依赖重建索引');
  primary.status = 'active';

  const sameMonth = request(primary.id, 'request:a', 2, 20, [teacherA.id, teacherA.id, teacherB.id]);
  primary.knowledgeRequests.push(sameMonth);
  registerProjectKnowledgeRequestListeners(state, primary, sameMonth);
  registerProjectKnowledgeRequestListeners(state, primary, sameMonth);
  assertLegacyExact(state, teacherA, 10, '同月 push 后显式登记必须立即可见且幂等');
  assert.deepEqual(ids(openProjectKnowledgeRequestsFor(state, teacherA, 10)), [
    'request:a',
    'request:z',
    'request:b',
  ], '同月追加仍须保留原最终排序，重复 listener 不能重复返回');

  state.projects = [...state.projects];
  assertLegacyExact(state, teacherA, 10, 'projects 数组整体替换必须按新身份重建');

  const tail = project('project:tail');
  tail.knowledgeRequests.push(request(tail.id, 'request:tail', 5, 20, [teacherA.id]));
  state.projects.push(tail);
  assertLegacyExact(state, teacherA, 10, 'projects 增长后必须重建');
  state.projects.pop();
  assertLegacyExact(state, teacherA, 10, 'projects 缩短后不得返回旧尾项候选');

  state.projects.push(tail);
  assertLegacyExact(state, teacherA, 10, '尾项替换前先建立缓存');
  const replacement = project('project:replacement');
  replacement.knowledgeRequests.push(request(
    replacement.id,
    'request:replacement',
    6,
    20,
    [teacherA.id],
  ));
  state.projects[state.projects.length - 1] = replacement;
  assertLegacyExact(state, teacherA, 10, '同长度尾项目替换必须重建');

  const sameMonthState = structuredClone(state);
  const sameMonthRequester = sameMonthState.people.find((person) => person.id === requester.id);
  const sameMonthTeacher = sameMonthState.people.find((person) => person.id === teacherA.id);
  sameMonthTeacher.position = structuredClone(sameMonthRequester.position);
  const actionProject = project('project:action-push');
  actionProject.ownerId = sameMonthRequester.id;
  actionProject.beneficiaryIds = [sameMonthRequester.id];
  actionProject.mechanicalPowerPlan.projectId = actionProject.id;
  sameMonthState.projects = [actionProject];
  assert.deepEqual(openProjectKnowledgeRequestsFor(sameMonthState, sameMonthTeacher, 10), [],
    '执行前先建立空候选缓存');
  const requestFact = executePrimitiveAction(sameMonthState, sameMonthRequester, {
    kind: 'communicate',
    content: {
      id: 'request:action-push',
      kind: 'request',
      summary: '询问磨坊知识',
      projectKnowledgeRequest: {
        version: 'project-knowledge-request-v1',
        projectId: actionProject.id,
        requesterId: sameMonthRequester.id,
        outputMaterialId: Material.Mill,
        expiresAtMonth: 20,
      },
    },
    audience: [sameMonthTeacher.id],
    channel: 'voice',
  }, 10, 1, { cause: 'project', projectId: actionProject.id, actionTick: 1 });
  assert.equal(requestFact.status, 'completed');
  assert.equal(actionProject.knowledgeRequests.length, 1);
  assertLegacyExact(sameMonthState, sameMonthTeacher, 10,
    'action-executor 同月 push 必须经显式登记立即进入缓存');
  assert.deepEqual(ids(openProjectKnowledgeRequestsFor(sameMonthState, sameMonthTeacher, 10)), [
    requestFact.id,
  ]);

  console.log('project knowledge listener index tests passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
