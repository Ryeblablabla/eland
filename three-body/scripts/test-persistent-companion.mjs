import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-persistent-companion-test-'));
const bundlePath = path.join(temporaryDirectory, 'persistent-companion.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { advanceAgreementLifecycle, recordAgreementAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/agreement.ts'))};
    export { advanceSharedRelationshipExperience } from ${JSON.stringify(path.resolve('src/game/eland/domain/monthly-processes.ts'))};
    export { companionReturnRequired, positionWithinLivingArea, sharedLivingReturnTarget } from ${JSON.stringify(path.resolve('src/game/eland/domain/shared-living.ts'))};
    export { compileAgreementContinuations } from ${JSON.stringify(path.resolve('src/game/eland/application/agreement-continuation.ts'))};
    export { executeActiveIntent, installAgreementContinuation } from ${JSON.stringify(path.resolve('src/game/eland/application/simulation/intent-execution.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=persistent-companion-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    advanceAgreementLifecycle,
    advanceSharedRelationshipExperience,
    companionReturnRequired,
    compileAgreementContinuations,
    createInitialState,
    executeActiveIntent,
    installAgreementContinuation,
    positionWithinLivingArea,
    recordAgreementAction,
    sharedLivingReturnTarget,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  const state = createInitialState(20260821, { endpoint: { kind: 'months', value: 60 }, chaosIntensity: 0 });
  const [first, second] = state.people;
  assert.ok(first && second, '测试需要两名人物');
  state.people = [first, second];
  first.conditions = [];
  second.conditions = [];
  first.body = { health: 100, hydration: 100, nutrition: 100 };
  second.body = { health: 100, hydration: 100, nutrition: 100 };
  second.position = structuredClone(first.position);
  const firstRelation = first.relations.find((relation) => relation.personId === second.id);
  const secondRelation = second.relations.find((relation) => relation.personId === first.id);
  assert.ok(firstRelation && secondRelation, '测试双方需要双向关系缓存');
  Object.assign(firstRelation, { trust: 20, bond: 20 });
  Object.assign(secondRelation, { trust: 20, bond: 20 });

  const companion = {
    id: 'test-persistent-companion',
    proposal: {
      kind: 'companion', proposerId: first.id, partnerId: second.id, expiresAtMonth: 6,
      sharedLivingAnchor: {
        version: 'shared-living-anchor-v1', cellId: first.position.cellId, z: first.position.z, radius: 2,
      },
    },
    proposerId: first.id,
    responderId: second.id,
    partyIds: [first.id, second.id],
    requiredResponderIds: [second.id],
    acceptedByPersonIds: [first.id, second.id],
    rejectedByPersonIds: [],
    status: 'active',
    proposedAtMonth: 0,
    acceptByMonth: 6,
    acceptedAtMonth: 0,
    dueAtMonth: 24,
    proposalEventId: 'test-companion-offer',
    responseEventId: 'test-companion-accept',
    fulfillmentEventIds: [],
    fulfilledByPersonIds: [],
    coLocatedMonths: 11,
    sourceEventIds: ['test-companion-offer', 'test-companion-accept'],
  };
  state.agreements = [companion];

  const establishmentFacts = advanceAgreementLifecycle(state, 12);
  assert.equal(companion.coLocatedMonths, 12, '第十二个真实共同生活月必须被累计');
  assert.equal(companion.status, 'active', '结伴建立后必须保持持续、可撤回，而不是完成后消失');
  assert.equal(companion.companionEstablishedAtMonth, 12, '真实共同生活十二个月后应立即建立持续关系');
  assert.equal(companion.lastCompanionCoLocatedAtMonth, 12, '建立月份必须同时记录最近一次真实同区日历月');
  assert.equal(establishmentFacts.length, 1, '建立关系必须留下唯一可回放协议事实');
  assert.equal(establishmentFacts[0].change, 'fulfilled');
  assert.ok(companion.fulfillmentEventIds.includes(establishmentFacts[0].id));
  assert.deepEqual([...companion.fulfilledByPersonIds].sort(), [first.id, second.id].sort());
  assert.equal(firstRelation.trust, 23, '首次履约应产生适度且有来源的信任增长');
  assert.equal(firstRelation.bond, 25, '首次履约应产生适度且有来源的亲近增长');
  assert.ok(firstRelation.sourceEventIds.includes(establishmentFacts[0].id));
  const legacyEstablishedCompanion = structuredClone(companion);
  delete legacyEstablishedCompanion.lastCompanionCoLocatedAtMonth;
  assert.equal(companionReturnRequired(legacyEstablishedCompanion, 14), false, '旧存档缺少新字段时仍应保留两个月独立行动窗口');
  assert.equal(companionReturnRequired(legacyEstablishedCompanion, 15), true, '旧存档应以真实建立月作为可迁移的最近同区下界');

  for (let month = 13; month <= 15; month += 1) {
    const lifecycleFacts = advanceAgreementLifecycle(state, month);
    assert.equal(lifecycleFacts.length, 0, '持续关系不应每月重复生成建立事实');
    const relationshipFacts = advanceSharedRelationshipExperience(state, [], month);
    if (month < 15) assert.equal(relationshipFacts.length, 0, '不足三个新增共同生活月不应提前增加关系');
    else {
      assert.equal(relationshipFacts.length, 1, '三个新增共同生活月应形成一次可回放关系事实');
      assert.equal(relationshipFacts[0].diff.process, 'persistent-shared-living');
      assert.equal(relationshipFacts[0].diff.sharedLivingMonths, 15);
      assert.equal(relationshipFacts[0].diff.trustDelta, 1);
      assert.equal(relationshipFacts[0].diff.bondDelta, 1);
      assert.equal(firstRelation.trust, 24);
      assert.equal(firstRelation.bond, 26);
    }
  }

  const sharedLivingMonthsBeforeAbsence = companion.coLocatedMonths;
  second.position = { ...second.position, cellId: second.position.cellId + 20 };
  advanceAgreementLifecycle(state, 16);
  assert.equal(companion.coLocatedMonths, sharedLivingMonthsBeforeAbsence, '一方离开约定区域时不得虚增共同生活月份');
  assert.equal(advanceSharedRelationshipExperience(state, [], 16).length, 0, '分居月份不得生成持续共同生活关系证据');
  assert.equal(companionReturnRequired(companion, 16), false, '离家一个月不应触发维护返回');
  advanceAgreementLifecycle(state, 17);
  assert.equal(companionReturnRequired(companion, 17), false, '连续离家两个月仍应允许独立工作和旅行');
  advanceAgreementLifecycle(state, 18);
  assert.equal(companionReturnRequired(companion, 18), true, '连续离家三个日历月后应触发维护返回');
  const returnTarget = sharedLivingReturnTarget(state, companion, second);
  assert.ok(returnTarget, '维护返回必须有可达的固定生活区目标');
  assert.equal(
    positionWithinLivingArea(returnTarget, companion.proposal.sharedLivingAnchor),
    true,
    '维护返回目标必须仍是提议时固定的生活区，而不是伴侣实时位置',
  );

  second.position = structuredClone(first.position);
  advanceAgreementLifecycle(state, 19);
  assert.equal(companion.lastCompanionCoLocatedAtMonth, 19, '双方重新同区后必须刷新最近共同生活月');
  assert.equal(companionReturnRequired(companion, 19), false, '真实同区后离家计时应立即清零');
  assert.equal(advanceSharedRelationshipExperience(state, [], 19).length, 0, '重聚一个月不得越过三月关系证据间隔');

  const revokeCompanionFact = {
    id: 'test-revoke-persistent-companion', kind: 'action', actionTick: 1, atMonth: 20, orderInMonth: 0,
    cellId: first.position.cellId, who: first.id, cause: 'intent',
    action: {
      kind: 'communicate',
      content: { id: 'test-revoke-persistent-companion-content', kind: 'revoke-agreement', referenceId: companion.id, summary: '我结束共同生活关系' },
      audience: [second.id], channel: 'voice',
    },
    fromCellId: first.position.cellId, toCellId: first.position.cellId,
    fromZ: first.position.z, toZ: first.position.z, pathSegment: [first.position.cellId],
    status: 'completed', result: '明确撤回共同生活约定', diff: {},
  };
  recordAgreementAction(state, revokeCompanionFact);
  assert.equal(companion.status, 'cancelled', '任一方明确表达后应能撤回持续结伴');
  assert.ok(companion.sourceEventIds.includes(revokeCompanionFact.id));

  const company = {
    id: 'test-company-assist',
    proposal: { kind: 'assist', requesterId: first.id, helperId: second.id, need: 'company', expiresAtMonth: 24 },
    proposerId: first.id,
    responderId: second.id,
    partyIds: [first.id, second.id],
    requiredResponderIds: [second.id],
    acceptedByPersonIds: [first.id, second.id],
    rejectedByPersonIds: [],
    status: 'active', proposedAtMonth: 21, acceptByMonth: 27, acceptedAtMonth: 21, dueAtMonth: 27,
    proposalEventId: 'test-company-request', responseEventId: 'test-company-accept',
    fulfillmentEventIds: [], fulfilledByPersonIds: [], coLocatedMonths: 0,
    sourceEventIds: ['test-company-request', 'test-company-accept'],
  };
  state.agreements.push(company);
  const trustBeforeCompany = firstRelation.trust;
  const bondBeforeCompany = firstRelation.bond;
  const companyContinuation = compileAgreementContinuations(state, company.id, 21);
  assert.equal(companyContinuation.length, 1, '同地的 active company 请求应编译出一个 helper 履约 continuation');
  assert.equal(companyContinuation[0].goal.kind, 'agreement-fulfilled', '履约目标不得使用已预先满足的 near-person');
  const acceptingIntent = {
    id: 'test-company-accepting-intent', ownerId: first.id, summary: '接受陪伴请求', domain: 'social',
    goal: { kind: 'representation-made', representationId: 'test-company-accept' },
    nextAction: { kind: 'attend', target: { kind: 'person', personId: second.id } },
    status: 'completed', createdAtMonth: 21, lastProgressAtMonth: 21, progress: 1,
    sourceDecisionEventId: 'test-company-decision', sourceFactIds: [...company.sourceEventIds],
    actionEventIds: [], replanCount: 0,
  };
  const companyIntent = installAgreementContinuation(state, acceptingIntent, companyContinuation[0], 21);
  assert.ok(companyIntent && second.activeIntentId === companyIntent.id, 'company continuation 应安装为 helper 的协议履约 intent');
  const companyFact = executeActiveIntent(state, second, 21, 1, 2);
  assert.equal(companyFact?.kind, 'action');
  assert.equal(companyFact?.action.kind, 'attend', '协议履约必须实际执行 attend，而不能因同地预判直接完成');
  assert.equal(companyFact?.status, 'completed');
  assert.equal(companyFact?.intentId, companyIntent.id);
  assert.equal(company.status, 'fulfilled', '同地、协议归属明确的陪伴行动应完成 company 请求');
  assert.deepEqual(company.fulfillmentEventIds, [companyFact?.id]);
  assert.equal(companyIntent.status, 'completed', 'agreement-fulfilled 应在同一 tick 收口履约 intent');
  assert.equal(firstRelation.trust, trustBeforeCompany + 8, '陪伴履约关系增长必须来自实际 action fact');
  assert.equal(firstRelation.bond, bondBeforeCompany + 3);
  assert.ok(firstRelation.sourceEventIds.includes(companyFact.id));

  const revocableCompany = structuredClone(company);
  revocableCompany.id = 'test-revocable-company-assist';
  revocableCompany.status = 'active';
  revocableCompany.resolvedAtMonth = undefined;
  revocableCompany.fulfillmentEventIds = [];
  revocableCompany.sourceEventIds = ['test-revocable-company-request', 'test-revocable-company-accept'];
  state.agreements.push(revocableCompany);
  const revokeCompanyFact = structuredClone(revokeCompanionFact);
  revokeCompanyFact.id = 'test-revoke-company-assist';
  revokeCompanyFact.atMonth = 22;
  revokeCompanyFact.who = second.id;
  revokeCompanyFact.action.content.id = 'test-revoke-company-assist-content';
  revokeCompanyFact.action.content.referenceId = revocableCompany.id;
  revokeCompanyFact.action.content.summary = '我撤回陪伴承诺';
  recordAgreementAction(state, revokeCompanyFact);
  assert.equal(revocableCompany.status, 'cancelled', 'active company 请求应允许参与者明确撤回');
  assert.ok(revocableCompany.sourceEventIds.includes(revokeCompanyFact.id));

  console.log('persistent companion regression passed');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
