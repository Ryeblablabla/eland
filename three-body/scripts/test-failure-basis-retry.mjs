import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-failure-basis-retry-test-'));
const bundlePath = path.join(temporaryDirectory, 'failure-basis-retry.mjs');

try {
  const entry = `
    export { isFailureRetryCoolingDown } from ${JSON.stringify(path.resolve('src/game/eland/application/action-options.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=failure-basis-retry-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
  const { isFailureRetryCoolingDown } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const actorId = 'person:actor:with:colons';
  const receiverId = 'person:receiver:a';
  const otherReceiverId = 'person:receiver:b';
  const recordUseBasis = {
    version: 'record-use-basis-v1',
    basisKey: 'record-use:reader:project-a:record-a:technique-a',
    projectId: 'project:a', projectOwnerId: actorId, readerId: actorId, recordAuthorId: 'person:author',
    demand: { kind: 'project-deficit', projectId: 'project:a', deficitSourceIds: ['deficit:old'] },
    recordId: 'record:a', knowledgeId: 'technique:a', codebookId: 'codebook:a', techniqueId: 'technique:a',
    ruleSignature: 'technique:a', projectPressure: 77,
    experimentAction: { kind: 'act', operation: 'combine', targets: [{ kind: 'person', personId: receiverId }] },
    expectedOutputMaterialId: 23, createdAtMonth: 3,
    projectSourceEventIds: ['project-source:old'], recordSourceEventIds: ['record-source:old'],
    codebookSourceEventIds: ['codebook-source:old'], inputSourceEventIds: ['input-source:old'],
    sourceFactIds: ['source:old'],
  };
  const baseOption = {
    id: 'retry-material-transfer', summary: '再次取得木材', reason: '项目仍缺材料',
    goal: { kind: 'inventory-at-least', materialId: 13, quantity: 2, personId: receiverId },
    nextAction: {
      kind: 'transfer', materialId: 13, quantity: 2,
      from: { kind: 'ground', cellId: 7, z: 2 }, to: { kind: 'person', personId: receiverId },
      dropId: 'drop:a',
    },
    target: { kind: 'person', personId: receiverId },
    estimatedDuration: 'one-month', sourceFactIds: ['source:old'],
    projectId: 'project:a', recordUseBasis,
  };
  const historicalIntent = {
    id: 'intent:retry:project:alpha:42', ownerId: actorId, summary: '旧摘要可以与新候选不同', domain: 'strategic',
    goal: structuredClone(baseOption.goal), nextAction: structuredClone(baseOption.nextAction),
    target: structuredClone(baseOption.target), status: 'blocked', createdAtMonth: 4, lastProgressAtMonth: 4,
    progress: 0, sourceDecisionEventId: 'decision:old', projectId: baseOption.projectId,
    recordUseBasis: structuredClone(recordUseBasis), sourceFactIds: ['source:old'], actionEventIds: [], replanCount: 1,
  };
  const prefixes = [
    'memory:intent-opening-failed:',
    'memory:intent-review-due:',
    'memory:intent-blocked:',
    'memory:intent-action-failed:',
  ];
  const failureMemory = (prefix, intent = historicalIntent, createdAtMonth = 10) => ({
    id: `${prefix}${intent.id}:${createdAtMonth}`,
    kind: 'failure', summary: `失败：${baseOption.summary}`, importance: 76,
    createdAtMonth, lastRecalledAtMonth: createdAtMonth, personIds: [receiverId], sourceEventIds: ['failure:event'],
  });
  const fixture = (memory = failureMemory('memory:intent-action-failed:')) => ({
    state: { intents: [historicalIntent] },
    person: { id: actorId, memories: [memory] },
  });
  const cooling = (option, atMonth, setup = fixture()) => isFailureRetryCoolingDown(setup.state, setup.person, option, atMonth);

  for (const prefix of prefixes) {
    const setup = fixture(failureMemory(prefix));
    assert.equal(cooling(baseOption, 11, setup), true, `${prefix} 必须能可靠回查含冒号的历史 intent ID`);
  }
  for (let month = 10; month <= 16; month += 1) {
    assert.equal(cooling(baseOption, month), true, `失败当月及之后六个月应冷却相同语义 basis：${month}`);
  }
  assert.equal(cooling(baseOption, 17), false, '失败后的第七个月必须恢复相同语义候选');

  const withNewSource = { ...structuredClone(baseOption), sourceFactIds: ['source:old', 'source:new-observation'] };
  assert.equal(cooling(withNewSource, 11), false, '相同 basis 出现新的真实 sourceFactId 时必须立即重开');
  const withFailureEventOnly = { ...structuredClone(baseOption), sourceFactIds: ['source:old', 'failure:event'] };
  assert.equal(cooling(withFailureEventOnly, 11), true,
    '失败动作本身进入候选来源时不算新的世界证据，不能在同月绕过冷却');

  const changedPosition = structuredClone(baseOption);
  changedPosition.nextAction.from.cellId = 8;
  assert.equal(cooling(changedPosition, 11), false, '物质位置改变必须形成新的语义 basis');
  const changedQuantity = structuredClone(baseOption);
  changedQuantity.goal.quantity = 3;
  changedQuantity.nextAction.quantity = 3;
  assert.equal(cooling(changedQuantity, 11), false, '目标与行动数量改变必须形成新的语义 basis');
  const changedPerson = structuredClone(baseOption);
  changedPerson.goal.personId = otherReceiverId;
  changedPerson.target.personId = otherReceiverId;
  changedPerson.nextAction.to.personId = otherReceiverId;
  assert.equal(cooling(changedPerson, 11), false, '行动涉及的人物改变必须形成新的语义 basis');
  const changedProject = { ...structuredClone(baseOption), projectId: 'project:b' };
  assert.equal(cooling(changedProject, 11), false, '项目 ID 改变必须形成新的语义 basis');
  const changedRecord = structuredClone(baseOption);
  changedRecord.recordUseBasis.recordId = 'record:b';
  assert.equal(cooling(changedRecord, 11), false, '记录使用 basis 改变必须形成新的语义 basis');

  const attemptIntent = {
    ...structuredClone(historicalIntent), id: 'intent:attempt:with:colons', projectId: undefined, recordUseBasis: undefined,
    goal: { kind: 'knowledge', factId: 'attempt:combine:inputs:10' },
    nextAction: { kind: 'act', operation: 'combine', targets: [{ kind: 'person', personId: receiverId }] },
    target: { kind: 'person', personId: receiverId },
  };
  const attemptOption = {
    ...structuredClone(baseOption), id: 'try-combine:inputs', projectId: undefined, recordUseBasis: undefined,
    goal: { kind: 'knowledge', factId: 'attempt:combine:inputs:11' },
    nextAction: structuredClone(attemptIntent.nextAction), target: structuredClone(attemptIntent.target),
  };
  const attemptSetup = {
    state: { intents: [attemptIntent] },
    person: { id: actorId, memories: [failureMemory('memory:intent-action-failed:', attemptIntent)] },
  };
  assert.equal(cooling(attemptOption, 11, attemptSetup), true,
    '实验 attempt factId 中仅月份变化不能伪装成新的语义尝试');

  const predictionIntent = {
    ...structuredClone(historicalIntent), id: 'intent:prediction:with:colons', projectId: undefined, recordUseBasis: undefined,
    goal: { kind: 'representation-made', representationId: 'predict-era:10:actor' },
    nextAction: {
      kind: 'communicate', audience: [receiverId], channel: 'voice',
      content: { id: 'predict-era:10:actor', kind: 'prediction', summary: '旧预测措辞', prediction: { targetEpoch: 'chaotic', predictedStartMonth: 12, toleranceMonths: 4, expiresAtMonth: 15 } },
    },
    target: { kind: 'person', personId: receiverId },
  };
  const predictionOption = {
    ...structuredClone(baseOption), id: 'predict-era:11:actor', projectId: undefined, recordUseBasis: undefined,
    goal: { kind: 'representation-made', representationId: 'predict-era:11:actor' },
    nextAction: {
      kind: 'communicate', audience: [receiverId], channel: 'voice',
      content: { id: 'predict-era:11:actor', kind: 'prediction', summary: '新预测措辞', prediction: { targetEpoch: 'chaotic', predictedStartMonth: 13, toleranceMonths: 4, expiresAtMonth: 16 } },
    },
    target: { kind: 'person', personId: receiverId },
  };
  const predictionSetup = {
    state: { intents: [predictionIntent] },
    person: { id: actorId, memories: [failureMemory('memory:intent-action-failed:', predictionIntent)] },
  };
  assert.equal(cooling(predictionOption, 11, predictionSetup), true,
    '没有新来源时，预测日期随提交月平移不能绕过同一语义 basis 的冷却');

  const permissionIntent = {
    ...structuredClone(predictionIntent), id: 'intent:permission:with:colons',
    goal: { kind: 'representation-made', representationId: 'offer-permission:10' },
    nextAction: {
      kind: 'communicate', audience: [receiverId], channel: 'voice',
      content: { id: 'offer-permission:10', kind: 'offer', summary: '旧许可措辞', proposal: {
        kind: 'permission', proposerId: actorId, partnerId: receiverId, collectiveId: 'collective:a',
        grantorId: actorId, granteeId: receiverId, materialId: 13, maxQuantityPerTransfer: 1,
        validUntilMonth: 34, expiresAtMonth: 16,
      } },
    },
  };
  const permissionOption = {
    ...structuredClone(predictionOption), id: 'offer-permission:11',
    goal: { kind: 'representation-made', representationId: 'offer-permission:11' },
    nextAction: structuredClone(permissionIntent.nextAction),
  };
  permissionOption.nextAction.content.id = 'offer-permission:11';
  permissionOption.nextAction.content.proposal.validUntilMonth = 35;
  permissionOption.nextAction.content.proposal.expiresAtMonth = 17;
  const permissionSetup = {
    state: { intents: [permissionIntent] },
    person: { id: actorId, memories: [failureMemory('memory:intent-action-failed:', permissionIntent)] },
  };
  assert.equal(cooling(permissionOption, 11, permissionSetup), true,
    '许可窗口随提交月平移不能伪装成新的物质许可语义');

  const freeTextFailure = {
    ...failureMemory('memory:intent-action-failed:'),
    id: 'memory:free-text:failure:10', summary: `这段自由文本恰好包含“${baseOption.summary}”`,
  };
  assert.equal(cooling(baseOption, 11, fixture(freeTextFailure)), false,
    '无法关联历史 intent 的自由文本失败不得按相似摘要误杀候选');
  const differentIntent = { ...structuredClone(historicalIntent), id: 'intent:different:basis', goal: { ...historicalIntent.goal, quantity: 99 } };
  const differentSetup = {
    state: { intents: [differentIntent] },
    person: { id: actorId, memories: [failureMemory('memory:intent-blocked:', differentIntent)] },
  };
  assert.equal(cooling(baseOption, 11, differentSetup), false, '相似摘要但语义 basis 不同不得进入冷却');

  const openingIntent = {
    ...structuredClone(historicalIntent), id: 'intent:opening:with:colons',
    openingAction: structuredClone(baseOption.nextAction),
    nextAction: { kind: 'move', toCellId: 99, toZ: 3 },
    goal: { kind: 'at-cell', cellId: 99 }, target: { kind: 'voxel', position: { x: 9, y: 9, z: 3 } },
  };
  const openingSetup = {
    state: { intents: [openingIntent] },
    person: { id: actorId, memories: [failureMemory('memory:intent-opening-failed:', openingIntent)] },
  };
  assert.equal(cooling(baseOption, 11, openingSetup), true,
    'opening-failed 必须按旧 intent 的 openingAction 匹配候选 nextAction，而不是误用尚未执行的后续动作');

  assert.equal(cooling({ ...structuredClone(baseOption), id: 'accept-exchange:agreement:with:colons' }, 11), false,
    '交换的 required response 必须绕过失败冷却');
  assert.equal(cooling({ ...structuredClone(baseOption), id: 'settle-exchange:agreement:with:colons' }, 11), false,
    '交换履约候选必须绕过失败冷却');

  const roundTripped = JSON.parse(JSON.stringify({ ...fixture(), option: baseOption }));
  assert.equal(
    isFailureRetryCoolingDown(roundTripped.state, roundTripped.person, roundTripped.option, 11),
    true,
    '结构化失败关联与语义 basis 必须在 JSON roundtrip 后保持一致',
  );

  process.stdout.write('failure basis retry tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
