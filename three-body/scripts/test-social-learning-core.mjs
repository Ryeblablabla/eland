import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-social-learning-core-'));
const bundlePath = path.join(temporaryDirectory, 'social-learning-core.mjs');

try {
  const entry = `
    export { advanceAgreementLifecycle, recordAgreementAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/agreement.ts'))};
    export { completeProject } from ${JSON.stringify(path.resolve('src/game/eland/application/projects/project-lifecycle.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.resolve('src/game/eland/domain/project.ts'))};
    export { recordGovernanceAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/governance.ts'))};
    export { appendCommittedEvents } from ${JSON.stringify(path.resolve('src/game/eland/domain/history.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export {
      coordinationPracticeBasisFor,
      recordSocialLearningEvidence,
      socialCooperationBeliefFor,
      socialDimensionExpectation,
      socialLearningStateOf,
    } from ${JSON.stringify(path.resolve('src/game/eland/domain/social-learning.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=social-learning-core-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    advanceAgreementLifecycle,
    appendCommittedEvents,
    completeProject,
    coordinationPracticeBasisFor,
    instantiateProject,
    Material,
    recordAgreementAction,
    recordGovernanceAction,
    recordSocialLearningEvidence,
    socialCooperationBeliefFor,
    socialDimensionExpectation,
    socialLearningStateOf,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  function actionFact(id, atMonth, who, action, diff = {}) {
    return {
      id,
      kind: 'action',
      atMonth,
      orderInMonth: 0,
      cellId: 0,
      who,
      cause: 'social-learning-core-test',
      action,
      fromCellId: 0,
      toCellId: 0,
      fromZ: 1,
      toZ: 1,
      pathSegment: [0],
      status: 'completed',
      result: id,
      diff,
    };
  }

  function person(id, name) {
    return {
      id,
      name,
      bornAtMonth: 0,
      lifespanMonths: 1_200,
      body: { health: 100, hydration: 100, nutrition: 100 },
      conditions: [],
      traits: [],
      inventory: [],
      knowledge: [],
      knownPlaces: [],
      relations: [],
      memories: [],
      cognition: {
        version: 'causal-bdi-v1',
        outcomeBeliefs: [],
        goalOutcomeBeliefs: [],
        needResolutionEpisodes: [],
      },
    };
  }

  function simulationState(people) {
    return {
      schemaVersion: 17,
      seed: 20260827,
      branchId: 'social-learning-core-test',
      clock: { unit: 'month', elapsedMonths: 0, monthsPerYear: 12 },
      world: {
        grid: {},
        drops: [],
        animals: [],
        past: [],
        historyCursor: { version: 1, eventCount: 0, hotStartIndex: 0, tailEventId: null },
      },
      people,
      intents: [],
      agreements: [],
      records: [],
      collectives: [],
      permissions: [],
      containers: [],
      eraPredictions: [],
      projects: [],
    };
  }

  function agreement(id, proposal, proposerId, responderId, status = 'proposed', atMonth = 1) {
    return {
      id,
      proposal,
      proposerId,
      responderId,
      partyIds: [proposerId, responderId],
      requiredResponderIds: [responderId],
      acceptedByPersonIds: status === 'proposed' ? [proposerId] : [proposerId, responderId],
      rejectedByPersonIds: [],
      status,
      proposedAtMonth: atMonth,
      acceptByMonth: atMonth + 2,
      ...(status === 'active' ? { acceptedAtMonth: atMonth, dueAtMonth: atMonth + 6 } : {}),
      proposalEventId: `proposal:${id}`,
      fulfillmentEventIds: [],
      fulfilledByPersonIds: [],
      coLocatedMonths: 0,
      sourceEventIds: [`proposal:${id}`],
    };
  }

  const requester = person('requester', '请求者');
  const helper = person('helper', '帮助者');
  const third = person('third', '第三人');
  const state = simulationState([requester, helper, third]);
  for (const person of state.people) {
    person.conditions = [];
    person.body = { health: 100, hydration: 100, nutrition: 100 };
    assert.equal(socialLearningStateOf(person), undefined, 'legacy-compatible cognition starts with no inferred social history');
    assert.equal(person.cognition?.socialLearning, undefined, 'a read must not mutate or backfill legacy cognition');
  }

  const accepted = agreement('assist-accepted-1', {
    kind: 'assist', requesterId: requester.id, helperId: helper.id, need: 'food', expiresAtMonth: 4,
  }, requester.id, helper.id);
  state.agreements.push(accepted);
  const acceptance = actionFact('accept:assist-1', 2, helper.id, {
    kind: 'communicate',
    content: { id: 'accept:assist-1', kind: 'accept', referenceId: accepted.id },
    audience: [requester.id],
    channel: 'voice',
  }, { audience: [requester.id] });
  recordAgreementAction(state, acceptance);
  recordAgreementAction(state, acceptance);
  const acceptedBelief = socialCooperationBeliefFor(requester, helper.id, 'assist-food');
  assert.ok(acceptedBelief, 'a direct response creates one typed target belief');
  assert.equal(acceptedBelief.receipts.length, 1, 'the same response fact is idempotent');
  assert.ok(socialDimensionExpectation(acceptedBelief, 'response', 2) > 0.5);
  assert.ok(socialDimensionExpectation(acceptedBelief, 'willingness', 2) > 0.5);
  assert.equal(socialDimensionExpectation(acceptedBelief, 'reliability', 2), 0.5,
    'acceptance is willingness evidence, not fulfillment evidence');

  const firstFulfillment = actionFact('fulfill:assist-1', 3, helper.id, {
    kind: 'transfer',
    materialId: Material.Food,
    quantity: 1,
    from: { kind: 'person', personId: helper.id },
    to: { kind: 'person', personId: requester.id },
    authorizationRef: accepted.id,
  }, { materialId: Material.Food, quantity: 1 });
  recordAgreementAction(state, firstFulfillment);
  assert.equal(accepted.status, 'fulfilled');
  assert.equal(acceptedBelief.reliability.positiveObservations, 1,
    'only real transfer fulfillment improves reliability');
  assert.equal(coordinationPracticeBasisFor(requester, helper.id, 'assist-food'), undefined,
    'one success cannot become a practice');

  const acceptedAgain = agreement('assist-accepted-2', {
    kind: 'assist', requesterId: requester.id, helperId: helper.id, need: 'food', expiresAtMonth: 11,
  }, requester.id, helper.id, 'active', 9);
  state.agreements.push(acceptedAgain);
  recordAgreementAction(state, actionFact('fulfill:assist-2', 10, helper.id, {
    kind: 'transfer',
    materialId: Material.Food,
    quantity: 1,
    from: { kind: 'person', personId: helper.id },
    to: { kind: 'person', personId: requester.id },
    authorizationRef: acceptedAgain.id,
  }, { materialId: Material.Food, quantity: 1 }));
  const practice = coordinationPracticeBasisFor(requester, helper.id, 'assist-food');
  assert.ok(practice, 'two direct successes in distinct months form a person-local practice basis');
  assert.deepEqual(practice.successes.map((success) => success.atMonth), [3, 10]);
  assert.deepEqual(practice.participantIds, [requester.id, helper.id]);
  assert.equal(practice.support, 'supported');
  assert.ok(practice.sourceFactIds.includes('fulfill:assist-1') && practice.sourceFactIds.includes('fulfill:assist-2'));

  const waterRequester = person('water-requester', '饮水请求者');
  const waterHelper = person('water-helper', '寻水帮助者');
  waterRequester.position = { cellId: 4, z: 2, previousCellId: 4, previousZ: 2 };
  waterHelper.position = { cellId: 3, z: 1, previousCellId: 3, previousZ: 1 };
  const waterState = simulationState([waterRequester, waterHelper]);
  waterState.world.grid = {
    version: 2,
    width: 84,
    depth: 52,
    levels: 12,
    generator: { version: 'material-world-v1', seed: waterState.seed },
    palette: [],
    voxels: new Uint16Array(84 * 52 * 12),
  };
  waterState.world.grid.voxels[0] = Material.Water;
  const waterAgreement = agreement('assist-water-long-fulfillment', {
    kind: 'assist', requesterId: waterRequester.id, helperId: waterHelper.id,
    need: 'water', expiresAtMonth: 862,
  }, waterRequester.id, waterHelper.id, 'active', 860);
  waterState.agreements.push(waterAgreement);

  const interleavedWaterFacts = Array.from({ length: 25 }, (_, index) => {
    const helperEvidence = index % 2 === 0;
    const fact = helperEvidence
      ? actionFact(`water-helper:${index}`, 861, waterHelper.id, {
        kind: 'move', to: { cellId: 1, z: 1 },
      })
      : actionFact(`water-requester:${index}`, 861, waterRequester.id, {
        kind: 'act', operation: 'ingest', targets: [],
      }, { materialId: Material.Water, hydration: 12 });
    fact.orderInMonth = 0;
    fact.planningTick = index;
    fact.orderInTick = 25 - index;
    fact.cellId = helperEvidence ? 1 : 2;
    fact.fromCellId = fact.cellId;
    fact.toCellId = fact.cellId;
    if (!helperEvidence) {
      fact.fromZ = 2;
      fact.toZ = 2;
    }
    return fact;
  });
  for (const fact of interleavedWaterFacts) {
    appendCommittedEvents(waterState, [fact]);
    recordAgreementAction(waterState, fact);
  }
  assert.equal(waterAgreement.status, 'active', '双方尚未在同一水源汇合时应继续积累真实履约事实');
  assert.equal(waterAgreement.fulfillmentEventIds.length, 25);
  waterAgreement.fulfillmentEventIds.reverse();
  waterRequester.position = { cellId: 4, z: 1, previousCellId: 4, previousZ: 2 };

  const finalRequesterDrink = actionFact('water-requester:final', 861, waterRequester.id, {
    kind: 'act', operation: 'ingest', targets: [],
  }, { materialId: Material.Water, hydration: 18 });
  finalRequesterDrink.orderInMonth = 0;
  finalRequesterDrink.planningTick = 30;
  finalRequesterDrink.orderInTick = 0;
  finalRequesterDrink.cellId = 1;
  finalRequesterDrink.fromCellId = 1;
  finalRequesterDrink.toCellId = 1;
  appendCommittedEvents(waterState, [finalRequesterDrink]);
  recordAgreementAction(waterState, finalRequesterDrink);

  const waterBelief = socialCooperationBeliefFor(waterRequester, waterHelper.id, 'assist-water');
  assert.equal(waterAgreement.status, 'fulfilled');
  assert.ok(waterBelief);
  assert.equal(waterBelief.reliability.positiveObservations, 1,
    '多 tick 的同一次水协助履约只能形成一个可靠性观测');
  assert.equal(waterBelief.receipts.length, 1);
  assert.deepEqual(
    waterBelief.receipts[0].sourceEventIds,
    ['water-helper:24', finalRequesterDrink.id],
    '乱序累积源必须按完整权威顺序各选最后一个 helper 到水与 requester 饮水事实',
  );
  assert.ok(waterBelief.receipts[0].sourceEventIds.length <= 2);
  recordAgreementAction(waterState, finalRequesterDrink);
  assert.equal(waterBelief.reliability.positiveObservations, 1, '重复处理结算事实不得追加第二次观测');

  const partialWaterAgreement = agreement('assist-water-partial-retention', {
    kind: 'assist', requesterId: waterRequester.id, helperId: waterHelper.id,
    need: 'water', expiresAtMonth: 863,
  }, waterRequester.id, waterHelper.id, 'active', 861);
  partialWaterAgreement.fulfilledByPersonIds = [waterHelper.id, waterRequester.id];
  partialWaterAgreement.fulfillmentEventIds = ['water-helper:not-retained'];
  waterState.agreements.push(partialWaterAgreement);
  waterHelper.position = { cellId: 4, z: 1, previousCellId: 3, previousZ: 1 };
  const retainedRequesterDrink = actionFact('water-requester:retained-only', 862, waterRequester.id, {
    kind: 'act', operation: 'ingest', targets: [],
  }, { materialId: Material.Water, hydration: 16 });
  appendCommittedEvents(waterState, [retainedRequesterDrink]);
  recordAgreementAction(waterState, retainedRequesterDrink);
  assert.deepEqual(
    waterBelief.receipts.find((receipt) => receipt.id.includes(partialWaterAgreement.id))?.sourceEventIds,
    [retainedRequesterDrink.id],
    '一类事实未保留时只能留下另一类已验证锚点，不能补造 helper 来源',
  );

  const unverifiedWaterAgreement = agreement('assist-water-unverified', {
    kind: 'assist', requesterId: waterRequester.id, helperId: waterHelper.id,
    need: 'water', expiresAtMonth: 864,
  }, waterRequester.id, waterHelper.id, 'active', 862);
  unverifiedWaterAgreement.fulfilledByPersonIds = [waterHelper.id, waterRequester.id];
  unverifiedWaterAgreement.fulfillmentEventIds = ['water-helper:missing', 'water-requester:missing'];
  waterState.agreements.push(unverifiedWaterAgreement);
  const uncommittedRequesterDrink = actionFact('water-requester:uncommitted', 863, waterRequester.id, {
    kind: 'act', operation: 'ingest', targets: [],
  }, { materialId: Material.Water, hydration: 14 });
  const waterReceiptCountBeforeUnverified = waterBelief.receipts.length;
  assert.throws(
    () => recordAgreementAction(waterState, uncommittedRequesterDrink),
    /缺少可验证的履约事实/u,
    '两类来源都无法从权威历史解析时必须继续 fail-closed',
  );
  assert.equal(unverifiedWaterAgreement.status, 'active');
  assert.equal(waterBelief.receipts.length, waterReceiptCountBeforeUnverified);

  const rejected = agreement('assist-rejected', {
    kind: 'assist', requesterId: requester.id, helperId: helper.id, need: 'food', expiresAtMonth: 13,
  }, requester.id, helper.id, 'proposed', 11);
  state.agreements.push(rejected);
  const reliabilityBeforeRejection = acceptedBelief.reliability.negativeObservations;
  recordAgreementAction(state, actionFact('reject:assist', 12, helper.id, {
    kind: 'communicate',
    content: { id: 'reject:assist', kind: 'reject', referenceId: rejected.id },
    audience: [requester.id],
    channel: 'voice',
  }, { audience: [requester.id] }));
  assert.equal(acceptedBelief.willingness.negativeObservations, 1, 'rejection lowers willingness');
  assert.equal(acceptedBelief.reliability.negativeObservations, reliabilityBeforeRejection,
    'rejection must not lower reliability');
  assert.equal(practice.support, 'supported', 'rejection is not counterevidence against fulfilled work');

  const unanswered = agreement('assist-unanswered', {
    kind: 'assist', requesterId: requester.id, helperId: helper.id, need: 'food', expiresAtMonth: 15,
  }, requester.id, helper.id, 'proposed', 13);
  unanswered.acceptByMonth = 15;
  state.agreements.push(unanswered);
  const willingnessBeforeSilence = acceptedBelief.willingness.negativeObservations;
  const reliabilityBeforeSilence = acceptedBelief.reliability.negativeObservations;
  const expiryFacts = advanceAgreementLifecycle(state, 16);
  assert.equal(unanswered.status, 'expired');
  assert.ok(expiryFacts.some((fact) => fact.agreementId === unanswered.id && fact.change === 'expired'));
  assert.equal(acceptedBelief.response.negativeObservations, 1, 'silence lowers response probability');
  assert.equal(acceptedBelief.willingness.negativeObservations, willingnessBeforeSilence,
    'silence says nothing about willingness');
  assert.equal(acceptedBelief.reliability.negativeObservations, reliabilityBeforeSilence,
    'silence says nothing about reliability');

  const breached = agreement('assist-breached', {
    kind: 'assist', requesterId: requester.id, helperId: helper.id, need: 'food', expiresAtMonth: 18,
  }, requester.id, helper.id, 'active', 17);
  breached.dueAtMonth = 18;
  state.agreements.push(breached);
  advanceAgreementLifecycle(state, 19);
  assert.equal(breached.status, 'breached');
  assert.equal(acceptedBelief.reliability.negativeObservations, reliabilityBeforeSilence + 1,
    'an accepted agreement with a real breach is reliability counterevidence');
  assert.equal(practice.support, 'contested');
  assert.ok(practice.recentCounterEvidence.some((counter) => counter.sourceEventIds.includes(`e-19-agreement-breached-${breached.id}`)));

  const reproduction = agreement('reproduction-rejected', {
    kind: 'reproduce', proposerId: requester.id, partnerId: helper.id, expiresAtMonth: 22,
  }, requester.id, helper.id, 'proposed', 20);
  state.agreements.push(reproduction);
  const beliefCountBeforeReproduction = socialLearningStateOf(requester).beliefs.length;
  recordAgreementAction(state, actionFact('reject:reproduction', 21, helper.id, {
    kind: 'communicate',
    content: { id: 'reject:reproduction', kind: 'reject', referenceId: reproduction.id },
    audience: [requester.id],
    channel: 'voice',
  }, { audience: [requester.id] }));
  assert.equal(socialLearningStateOf(requester).beliefs.length, beliefCountBeforeReproduction,
    'reproduction rejection is never converted into cooperation reputation');

  function jointProject(id, completedAtMonth, evidenceCount = 1) {
    const project = instantiateProject({
      id,
      kind: 'production',
      need: 'food-preparation',
      desiredFunction: 'prepared-food',
      summary: '共同加工食物',
      ownerId: requester.id,
      beneficiaryIds: [requester.id, helper.id],
      triggerFactIds: [`trigger:${id}`],
      pressure: 60,
      createdAtMonth: completedAtMonth - 3,
      reviewAtMonth: completedAtMonth + 6,
    });
    project.contributorIds = [requester.id, third.id];
    const progressEvents = Array.from({ length: evidenceCount }, (_, index) => ({
      ...actionFact(`progress:${id}:${third.id}:${index}`, completedAtMonth - 1, third.id, {
        kind: 'act', operation: 'wait', targets: [],
      }),
      orderInMonth: index,
    }));
    const completionEvents = Array.from({ length: evidenceCount }, (_, index) => ({
      ...actionFact(`complete:${id}:${index}`, completedAtMonth, requester.id, {
        kind: 'act', operation: 'wait', targets: [],
      }),
      orderInMonth: index,
    }));
    appendCommittedEvents(state, [...progressEvents, ...completionEvents]);
    project.progressEvidence = progressEvents.map((event) => ({
      eventId: event.id,
      atMonth: event.atMonth,
      kind: 'material-contribution',
      actorId: third.id,
    })).reverse();
    project.actionEventIds = project.progressEvidence.map((evidence) => evidence.eventId);
    completeProject(
      state,
      project,
      completedAtMonth,
      completionEvents.map((event) => event.id).reverse(),
    );
    return project;
  }
  let highVolumeJointProject;
  assert.doesNotThrow(() => {
    highVolumeJointProject = jointProject('joint-project-1', 30, 32);
  }, '一个完成的共同项目不应因 progress/completion tick 数超过24而无法形成单次学习');
  const projectBelief = socialCooperationBeliefFor(requester, third.id, 'joint-project-production');
  assert.equal(projectBelief?.reliability.positiveObservations, 1,
    'a contributor needs real project progress plus completion before reliability changes');
  const highVolumeReceipt = projectBelief?.receipts.find((receipt) => (
    receipt.id === 'joint-project:joint-project-1:requester:third'
  ));
  assert.deepEqual(highVolumeReceipt?.sourceEventIds, [
    'progress:joint-project-1:third:31',
    'complete:joint-project-1:31',
  ], '共同项目的单次 success episode 只引用该贡献者末尾进度和项目末尾完成锚点');
  assert.ok((highVolumeReceipt?.sourceEventIds.length ?? 0) <= 2,
    '共同项目 receipt 必须保持至多两个真实权威来源');
  assert.equal(projectBelief?.reliability.positiveObservations, 1,
    '32个进度 tick 仍只能让 reliability 增加一次');
  jointProject('joint-project-2', 36);
  assert.ok(coordinationPracticeBasisFor(requester, third.id, 'joint-project-production'),
    'two completed progress-backed joint projects can form a practice basis');

  const collectiveId = 'collective:social-learning';
  const mandateId = 'mandate:social-learning';
  state.collectives = [{
    id: collectiveId,
    purposeSummary: '协调木材',
    status: 'active',
    foundedAtMonth: 40,
    formationAgreementId: 'formation:social-learning',
    memberships: [requester, helper, third].map((person) => ({
      id: `membership:${person.id}`,
      collectiveId,
      personId: person.id,
      status: 'active',
      joinedAtMonth: 40,
      sourceEventIds: [`membership-source:${person.id}`],
    })),
    decisionRules: [],
    mandates: [{
      id: mandateId,
      collectiveId,
      decisionRuleId: 'decision-rule:social-learning',
      holderId: requester.id,
      scope: 'coordinate-material',
      materialId: Material.Wood,
      validFromMonth: 40,
      validUntilMonth: 90,
      status: 'active',
      proposalAgreementId: 'mandate-proposal:social-learning',
      sourceEventIds: ['mandate-source:social-learning'],
      contributionEventIds: [],
      distributionEventIds: [],
    }, {
      id: 'mandate:legacy-social-learning',
      collectiveId,
      decisionRuleId: 'decision-rule:legacy-social-learning',
      holderId: requester.id,
      scope: 'coordinate-material',
      materialId: Material.Wood,
      validFromMonth: 1,
      validUntilMonth: 90,
      status: 'active',
      proposalAgreementId: 'mandate-proposal:legacy-social-learning',
      sourceEventIds: ['legacy-mandate-source'],
      contributionEventIds: ['legacy-contribution-before-schema'],
      distributionEventIds: ['legacy-distribution-before-schema'],
    }],
    sourceEventIds: ['collective-source:social-learning'],
  }];
  const mandate = state.collectives[0].mandates[0];
  const legacyMandate = state.collectives[0].mandates[1];

  recordGovernanceAction(state, actionFact('legacy-first-new-distribution', 45, requester.id, {
    kind: 'transfer',
    materialId: Material.Wood,
    quantity: 1,
    from: { kind: 'person', personId: requester.id },
    to: { kind: 'person', personId: third.id },
    authorizationRef: legacyMandate.id,
  }, { materialId: Material.Wood, quantity: 1 }));
  assert.equal(legacyMandate.coordinationContributionCursor, 1);
  assert.equal(legacyMandate.coordinationClosures?.length ?? 0, 0,
    'legacy mandate activity establishes a cursor and is not backfilled into social learning');
  assert.equal(socialCooperationBeliefFor(third, requester.id, 'mandate-resource-coordination'), undefined);

  function mandateCycle(suffix, contributionMonth, distributionMonth) {
    const positiveBeforeContribution = socialCooperationBeliefFor(
      requester,
      helper.id,
      'mandate-resource-coordination',
    )?.reliability.positiveObservations ?? 0;
    const contribution = actionFact(`mandate-contribution:${suffix}`, contributionMonth, helper.id, {
      kind: 'transfer',
      materialId: Material.Wood,
      quantity: 1,
      from: { kind: 'person', personId: helper.id },
      to: { kind: 'person', personId: requester.id },
      authorizationRef: mandateId,
    }, { materialId: Material.Wood, quantity: 1 });
    recordGovernanceAction(state, contribution);
    appendCommittedEvents(state, [contribution]);
    assert.equal(socialCooperationBeliefFor(
      requester,
      helper.id,
      'mandate-resource-coordination',
    )?.reliability.positiveObservations ?? 0, positiveBeforeContribution,
      'a contribution alone does not close coordination or change reliability');
    const distribution = actionFact(`mandate-distribution:${suffix}`, distributionMonth, requester.id, {
      kind: 'transfer',
      materialId: Material.Wood,
      quantity: 1,
      from: { kind: 'person', personId: requester.id },
      to: { kind: 'person', personId: third.id },
      authorizationRef: mandateId,
    }, { materialId: Material.Wood, quantity: 1 });
    recordGovernanceAction(state, distribution);
    appendCommittedEvents(state, [distribution]);
  }

  mandateCycle('1', 50, 51);
  assert.equal(mandate.coordinationClosures?.length, 1, 'contribution followed by distribution creates one exact closure');
  assert.equal(socialCooperationBeliefFor(requester, helper.id, 'mandate-resource-coordination')?.reliability.positiveObservations, 1);
  assert.equal(socialCooperationBeliefFor(third, requester.id, 'mandate-resource-coordination')?.reliability.positiveObservations, 1);
  mandateCycle('2', 60, 61);
  assert.equal(mandate.coordinationClosures?.length, 2);
  assert.ok(coordinationPracticeBasisFor(requester, helper.id, 'mandate-resource-coordination'));
  assert.ok(coordinationPracticeBasisFor(third, requester.id, 'mandate-resource-coordination'));

  const capacityPerson = person('capacity-person', '容量测试者');
  assert.equal(capacityPerson.cognition?.socialLearning, undefined);
  for (let index = 0; index < 30; index += 1) {
    recordSocialLearningEvidence(capacityPerson, `capacity-target-${index}`, 'exchange', {
      receiptId: `capacity-belief-${index}`,
      kind: 'agreement-fulfillment',
      atMonth: index,
      sourceEventIds: [`capacity-source-${index}`],
      reliability: 'positive',
    });
  }
  assert.equal(socialLearningStateOf(capacityPerson).beliefs.length, 24, 'belief capacity is hard bounded');
  const retained = socialCooperationBeliefFor(capacityPerson, 'capacity-target-29', 'exchange');
  assert.ok(retained);
  for (let index = 0; index < 30; index += 1) {
    recordSocialLearningEvidence(capacityPerson, 'capacity-target-29', 'exchange', {
      receiptId: `capacity-receipt-${index}`,
      kind: 'agreement-fulfillment',
      atMonth: 40 + index,
      sourceEventIds: [`capacity-receipt-source-${index}`],
      reliability: index % 2 === 0 ? 'positive' : 'negative',
    });
  }
  assert.equal(retained.receipts.length, 8, 'each belief retains at most eight receipts');
  assert.equal(retained.sourceEventIds.length, 24, 'each belief retains at most twenty-four sources');
  const stateBeforeOversizedReceipt = structuredClone(capacityPerson.cognition.socialLearning);
  assert.throws(
    () => recordSocialLearningEvidence(capacityPerson, 'capacity-target-29', 'exchange', {
      receiptId: 'capacity-oversized-receipt',
      kind: 'agreement-fulfillment',
      atMonth: 70,
      sourceEventIds: Array.from({ length: 25 }, (_, index) => `capacity-oversized-source-${index}`),
      reliability: 'positive',
    }),
    /sourceEventIds 超出上限 24/u,
    'an oversized unique source set must fail before mutating social learning state',
  );
  assert.deepEqual(
    capacityPerson.cognition.socialLearning,
    stateBeforeOversizedReceipt,
    'oversized evidence must not be truncated into a receipt or mutate any posterior',
  );
  const currentExpectation = socialDimensionExpectation(retained, 'reliability', 69);
  const staleExpectation = socialDimensionExpectation(retained, 'reliability', 69 + 720);
  assert.ok(Math.abs(staleExpectation - 0.5) < Math.abs(currentExpectation - 0.5),
    'old evidence decays toward the weak prior instead of becoming permanent reputation');

  console.log(JSON.stringify({
    status: 'passed',
    agreementBelief: {
      response: acceptedBelief.response,
      willingness: acceptedBelief.willingness,
      reliability: acceptedBelief.reliability,
    },
    practice: {
      formedAtMonth: practice.formedAtMonth,
      support: practice.support,
      successMonths: practice.successes.map((success) => success.atMonth),
      counterEvidence: practice.recentCounterEvidence.length,
    },
    mandateClosures: mandate.coordinationClosures?.length ?? 0,
    capacity: {
      beliefs: socialLearningStateOf(capacityPerson).beliefs.length,
      receipts: retained.receipts.length,
      sources: retained.sourceEventIds.length,
    },
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
