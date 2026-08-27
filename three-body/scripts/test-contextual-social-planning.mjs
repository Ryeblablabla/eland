import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-contextual-social-planning-'));
const bundlePath = path.join(temporaryDirectory, 'contextual-social-planning.mjs');

try {
  const entry = `
    export { createInitialState } from ${JSON.stringify(path.resolve('src/game/eland/application/monthly-simulation.ts'))};
    export { buildSocialOptions } from ${JSON.stringify(path.resolve('src/game/eland/application/social-options.ts'))};
    export { recordProjectAction } from ${JSON.stringify(path.resolve('src/game/eland/application/project-options.ts'))};
    export { completeProject } from ${JSON.stringify(path.resolve('src/game/eland/application/projects/project-lifecycle.ts'))};
    export { evaluateCognitiveOption } from ${JSON.stringify(path.resolve('src/game/eland/application/cognition/option-appraisal.ts'))};
    export { rankCognitiveOptionsWithoutForesight } from ${JSON.stringify(path.resolve('src/game/eland/application/cognition/bdi-deliberation.ts'))};
    export {
      appraiseSocialExpectation,
      applyContextualSocialAttention,
      cooperationContextForOption,
    } from ${JSON.stringify(path.resolve('src/game/eland/application/cognition/social-expectation.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
    export { appendCommittedEvents } from ${JSON.stringify(path.resolve('src/game/eland/domain/history.ts'))};
    export { instantiateProject } from ${JSON.stringify(path.resolve('src/game/eland/domain/project.ts'))};
    export { recordAgreementAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/agreement.ts'))};
    export { recordGovernanceAction } from ${JSON.stringify(path.resolve('src/game/eland/domain/governance.ts'))};
    export { deriveObservations } from ${JSON.stringify(path.resolve('src/game/eland/projection/derived-observations.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=contextual-social-planning-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    appraiseSocialExpectation,
    applyContextualSocialAttention,
    appendCommittedEvents,
    buildSocialOptions,
    completeProject,
    cooperationContextForOption,
    createInitialState,
    evaluateCognitiveOption,
    deriveObservations,
    instantiateProject,
    Material,
    rankCognitiveOptionsWithoutForesight,
    recordAgreementAction,
    recordGovernanceAction,
    recordProjectAction,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

  function actionFact(id, atMonth, who, action, diff = {}, status = 'completed') {
    return {
      id,
      kind: 'action',
      atMonth,
      orderInMonth: 0,
      cellId: 0,
      who,
      cause: 'contextual-social-planning-test',
      action,
      fromCellId: 0,
      toCellId: 0,
      fromZ: 1,
      toZ: 1,
      pathSegment: [0],
      status,
      result: id,
      diff,
    };
  }

  function dimension(alpha, beta, atMonth = 20) {
    return {
      alpha, beta,
      positiveObservations: Math.max(0, alpha - 1),
      negativeObservations: Math.max(0, beta - 1),
      lastUpdatedAtMonth: atMonth,
    };
  }

  function belief(targetPersonId, context, alpha, beta) {
    return {
      version: 'social-cooperation-belief-v1',
      basisKey: `belief:${targetPersonId}:${context}`,
      targetPersonId,
      context,
      response: dimension(alpha, beta),
      willingness: dimension(alpha, beta),
      reliability: dimension(alpha, beta),
      receipts: [],
      sourceEventIds: [`source:${targetPersonId}:${context}`],
      lastUpdatedAtMonth: 20,
    };
  }

  function practice(observerId, targetPersonId, support = 'supported', context = 'assist-food') {
    return {
      version: 'coordination-practice-basis-v1',
      basisKey: `practice:${observerId}:${targetPersonId}:${context}`,
      observerId,
      targetPersonId,
      participantIds: [observerId, targetPersonId],
      context,
      formedAtMonth: 10,
      lastUpdatedAtMonth: support === 'supported' ? 18 : 19,
      support,
      successes: [
        { atMonth: 10, receiptIds: ['receipt:one'], sourceEventIds: ['practice:one'] },
        { atMonth: 18, receiptIds: ['receipt:two'], sourceEventIds: ['practice:two'] },
      ],
      recentCounterEvidence: support === 'contested'
        ? [{ atMonth: 19, receiptId: 'receipt:counter', sourceEventIds: ['practice:counter'] }]
        : [],
      sourceFactIds: support === 'contested'
        ? ['practice:one', 'practice:two', 'practice:counter']
        : ['practice:one', 'practice:two'],
    };
  }

  function learningPerson(id, beliefs = [], practices = []) {
    return {
      id,
      cognition: {
        version: 'causal-bdi-v1',
        outcomeBeliefs: [],
        goalOutcomeBeliefs: [],
        needResolutionEpisodes: [],
        socialLearning: {
          version: 'social-learning-v1',
          startedAtMonth: 1,
          beliefs,
          coordinationPractices: practices,
        },
      },
    };
  }

  function socialOption(targetPersonId, opaqueId, input = {}) {
    const proposalKind = input.proposalKind ?? 'assist';
    const proposal = proposalKind === 'exchange'
      ? {
          kind: 'exchange', offererId: 'observer', partnerId: targetPersonId,
          offererMaterialId: Material.Food, offererQuantity: 1,
          partnerMaterialId: Material.Wood, partnerQuantity: 1, expiresAtMonth: 24,
        }
      : proposalKind === 'reproduce'
        ? { kind: 'reproduce', proposerId: 'observer', partnerId: targetPersonId, expiresAtMonth: 24 }
        : { kind: 'assist', requesterId: 'observer', helperId: targetPersonId, need: 'food', expiresAtMonth: 24 };
    const cooperationKind = proposalKind === 'exchange' ? 'exchange' : proposalKind === 'reproduce' ? 'reproduction' : 'assist';
    return {
      id: opaqueId,
      summary: `proposal to ${targetPersonId}`,
      reason: 'fixture',
      goal: { kind: 'representation-made', representationId: `representation:${targetPersonId}:${proposalKind}` },
      nextAction: {
        kind: 'communicate',
        content: { id: `representation:${targetPersonId}:${proposalKind}`, kind: 'request', summary: 'fixture', proposal },
        audience: [targetPersonId], channel: 'voice',
      },
      target: { kind: 'person', personId: targetPersonId },
      estimatedDuration: 'one-month', estimatedMonths: 1,
      risks: [], domain: 'social', sourceFactIds: [],
      semantics: {
        version: 'action-option-semantics-v1',
        obligation: input.obligation ?? 'optional',
        planningChannel: input.obligation && input.obligation !== 'optional' ? 'edge' : 'ordinary',
        purpose: proposalKind === 'reproduce' ? 'reproduction' : 'social-coordination',
        minimumLifeStage: 'adult',
        needKinds: proposalKind === 'reproduce' ? ['generativity'] : ['belonging'],
        ...(input.obligation === 'required-response' ? { edgeTrigger: 'required-response' } : {}),
        ...(input.obligation === 'commitment-action' ? { edgeTrigger: 'commitment-action' } : {}),
        ...(proposalKind === 'reproduce' ? {
          reproduction: { direction: 'proceed', phase: 'proposal', mode: 'mutual' },
        } : {}),
        socialContext: {
          cooperationKind,
          phase: 'proposal',
          counterpartIds: [targetPersonId],
          ...(proposalKind === 'assist' ? { assistNeed: 'food' } : {}),
        },
      },
    };
  }

  const observer = learningPerson('observer', [
    belief('a', 'assist-food', 10, 1),
    belief('b', 'assist-food', 8, 2),
    belief('c', 'assist-food', 1, 9),
    belief('d', 'assist-food', 2, 8),
    belief('a', 'exchange', 1, 10),
    belief('c', 'exchange', 9, 1),
  ]);
  const four = ['a', 'b', 'c', 'd'].map((target) => socialOption(target, `opaque-${target}`));
  const attended20 = applyContextualSocialAttention(observer, four, 20);
  assert.equal(attended20.length, 3, 'four same-context candidates retain top two plus one exploration target');
  assert.ok(attended20.some((option) => option.target.personId === 'a'));
  assert.ok(attended20.some((option) => option.target.personId === 'b'));
  const explored20 = attended20.find((option) => !['a', 'b'].includes(option.target.personId)).target.personId;
  const explored21 = applyContextualSocialAttention(observer, four, 21)
    .find((option) => !['a', 'b'].includes(option.target.personId)).target.personId;
  assert.notEqual(explored20, explored21, 'even a low-expectation candidate rotates into bounded exploration');

  assert.equal(applyContextualSocialAttention(observer, four.slice(0, 2), 20).length, 2,
    'two candidates are both retained');
  const required = socialOption('c', 'opaque-required', { obligation: 'required-response' });
  const commitment = socialOption('d', 'opaque-commitment', { obligation: 'commitment-action' });
  const reproduction = socialOption('d', 'opaque-reproduction', { proposalKind: 'reproduce' });
  const withdrawal = structuredClone(socialOption('c', 'opaque-withdrawal'));
  withdrawal.semantics.socialContext.phase = 'withdrawal';
  const bypassed = applyContextualSocialAttention(observer, [
    ...four, required, commitment, reproduction, withdrawal,
  ], 20);
  assert.ok(bypassed.includes(required)
    && bypassed.includes(commitment)
    && bypassed.includes(reproduction)
    && bypassed.includes(withdrawal),
  'responses, commitments, withdrawals and reproduction bypass optional social attention');

  const assistA = appraiseSocialExpectation(observer, socialOption('a', 'renamable-one'), 20);
  const exchangeA = appraiseSocialExpectation(observer, socialOption('a', 'renamable-two', { proposalKind: 'exchange' }), 20);
  assert.ok(assistA.gate > 1 && exchangeA.gate < 1,
    'posterior evidence stays isolated between cooperation contexts for the same person');
  assert.equal(cooperationContextForOption(socialOption('a', 'anything')), 'assist-food');
  const renamed = four.map((option, index) => ({ ...structuredClone(option), id: `completely-renamed-${index}` }));
  const targets = (options) => options.map((option) => option.target.personId).sort();
  assert.deepEqual(targets(applyContextualSocialAttention(observer, renamed, 20)), targets(attended20),
    'opaque option id changes cannot alter the attention policy');
  assert.equal(appraiseSocialExpectation(observer, renamed[0], 20).gate, assistA.gate,
    'opaque option id changes cannot alter appraisal');

  const appraisalState = createInitialState(26082741, { endpoint: { kind: 'months', value: 24 }, chaosIntensity: 0 });
  const appraisalPerson = appraisalState.people[0];
  appraisalPerson.cognition = structuredClone(observer.cognition);
  const appraised = evaluateCognitiveOption({
    state: appraisalState,
    person: appraisalPerson,
    visibleCells: [appraisalPerson.position.cellId],
    visiblePeople: [], visibleDrops: [], visibleAnimals: [], options: [], followUpOptions: [],
  }, socialOption('a', 'opaque-appraisal'), { atMonth: 20, planningTick: 1 });
  assert.equal(appraised.socialExpectationGate, assistA.gate);
  assert.ok(appraised.factors.some((factor) => factor.kind === 'social-expectation'
    && factor.sourceFactIds.includes('source:a:assist-food')),
  'social expectation remains a separate sourced appraisal factor');

  function prepareInstitutionFixture(support) {
    const state = createInitialState(26082742, { endpoint: { kind: 'months', value: 48 }, chaosIntensity: 0 });
    state.clock.elapsedMonths = 24;
    const [proposer, member] = state.people;
    state.people = [proposer, member];
    proposer.position = structuredClone(member.position);
    proposer.bornAtMonth = member.bornAtMonth = -30 * 12;
    proposer.motiveSensitivity.status = 100;
    member.motiveSensitivity.status = 0;
    proposer.baselineCapacities.cognition = 100;
    member.baselineCapacities.cognition = 0;
    const relation = proposer.relations.find((candidate) => candidate.personId === member.id);
    const reciprocal = member.relations.find((candidate) => candidate.personId === proposer.id);
    Object.assign(relation, { trust: 20, bond: 10, fear: 0 });
    Object.assign(reciprocal, { trust: 20, bond: 10, fear: 0 });
    proposer.inventory = [{ id: 'food:unequal', materialId: Material.Food, quantity: 3, sourceEventIds: [] }];
    member.inventory = [];
    member.body.nutrition = 40;
    proposer.cognition = {
      version: 'causal-bdi-v1', outcomeBeliefs: [], goalOutcomeBeliefs: [], needResolutionEpisodes: [],
      socialLearning: {
        version: 'social-learning-v1', startedAtMonth: 1, beliefs: [],
        coordinationPractices: [practice(proposer.id, member.id, support)],
      },
    };
    return { state, proposer, member };
  }

  const contestedFormation = prepareInstitutionFixture('contested');
  assert.equal(buildSocialOptions(
    contestedFormation.state, contestedFormation.proposer, [contestedFormation.member], 24,
  ).some((option) => {
    const content = (option.completionAction ?? option.nextAction).content;
    return content?.proposal?.kind === 'collective';
  }), false, 'contested practice cannot support collective formation');

  const supportedFormation = prepareInstitutionFixture('supported');
  const formation = buildSocialOptions(
    supportedFormation.state, supportedFormation.proposer, [supportedFormation.member], 24,
  ).find((option) => {
    const action = option.completionAction ?? option.nextAction;
    return action.kind === 'communicate'
      && (action.content.kind === 'offer' || action.content.kind === 'request')
      && action.content.proposal?.kind === 'collective';
  });
  assert.ok(formation, 'two distinct-month successes support a consensual collective proposal');
  assert.ok(formation.sourceFactIds.includes('practice:one') && formation.sourceFactIds.includes('practice:two'));
  assert.equal(supportedFormation.state.collectives.length, 0,
    'a supported practice creates only an offer option, never a collective or rule directly');

  function installCollective(fixture) {
    fixture.state.collectives = [{
      id: 'collective:fixture', purposeSummary: '共同应对物资不均', status: 'active',
      foundedAtMonth: 20, formationAgreementId: 'agreement:formation',
      memberships: [fixture.proposer, fixture.member].map((person) => ({
        id: `membership:${person.id}`, collectiveId: 'collective:fixture', personId: person.id,
        status: 'active', joinedAtMonth: 20, sourceEventIds: ['collective:source'],
      })),
      decisionRules: [], mandates: [], sourceEventIds: ['collective:source'],
    }];
  }
  installCollective(contestedFormation);
  const contestedRules = buildSocialOptions(
    contestedFormation.state, contestedFormation.proposer, [contestedFormation.member], 24,
  ).filter((option) => {
    const action = option.completionAction ?? option.nextAction;
    return action.kind === 'communicate'
      && (action.content.kind === 'offer' || action.content.kind === 'request')
      && action.content.proposal?.kind === 'decision-rule';
  });
  assert.equal(contestedRules.length, 0, 'counterevidence contests the basis and blocks a decision-rule proposal');

  installCollective(supportedFormation);
  const supportedRule = buildSocialOptions(
    supportedFormation.state, supportedFormation.proposer, [supportedFormation.member], 24,
  ).find((option) => {
    const action = option.completionAction ?? option.nextAction;
    return action.kind === 'communicate'
      && (action.content.kind === 'offer' || action.content.kind === 'request')
      && action.content.proposal?.kind === 'decision-rule';
  });
  assert.ok(supportedRule, 'supported local practice plus real material inequality opens a unanimous rule proposal');
  assert.ok(supportedRule.sourceFactIds.includes('practice:one') && supportedRule.sourceFactIds.includes('practice:two'));
  assert.equal(supportedFormation.state.collectives[0].decisionRules.length, 0,
    'proposal generation does not skip unanimous acceptance or instantiate a rule');

  function completedJointDutyProject(state, observer, contributor, id, progressMonth, completedMonth) {
    const trigger = actionFact(`trigger:${id}`, progressMonth - 1, observer.id, {
      kind: 'communicate',
      content: { id: `trigger:${id}`, kind: 'claim', summary: '共同项目需要继续处理' },
      audience: [contributor.id],
      channel: 'voice',
    }, { audience: [contributor.id] });
    const progress = actionFact(`progress:${id}`, progressMonth, contributor.id, {
      kind: 'act', operation: 'exert', targets: [],
    });
    const completion = actionFact(`completion:${id}`, completedMonth, observer.id, {
      kind: 'act', operation: 'exert', targets: [],
    });
    appendCommittedEvents(state, [trigger, progress, completion]);
    const project = instantiateProject({
      id,
      kind: 'production',
      need: 'food-preparation',
      desiredFunction: 'prepared-food',
      summary: '共同加工食物',
      ownerId: observer.id,
      beneficiaryIds: [observer.id, contributor.id],
      triggerFactIds: [trigger.id],
      pressure: 58,
      createdAtMonth: progressMonth - 1,
      reviewAtMonth: completedMonth + 6,
    });
    project.contributorIds = [observer.id, contributor.id];
    project.progressEvidence = [
      { eventId: progress.id, atMonth: progressMonth, kind: 'action-progress', actorId: contributor.id },
      { eventId: progress.id, atMonth: progressMonth, kind: 'material-contribution', actorId: contributor.id },
    ];
    project.actionEventIds = [progress.id];
    state.projects.push(project);
    completeProject(state, project, completedMonth, [completion.id]);
    return project;
  }

  function commitSocialOffer(state, actor, option, atMonth, orderInMonth) {
    const action = option.completionAction ?? option.nextAction;
    assert.equal(action.kind, 'communicate');
    const intentId = `intent:${action.content.id}:${actor.id}`;
    state.intents.push({ id: intentId, ownerId: actor.id, sourceFactIds: [...option.sourceFactIds] });
    const fact = actionFact(`event:${action.content.id}:${actor.id}`, atMonth, actor.id, action, {
      audience: [...action.audience],
    });
    fact.orderInMonth = orderInMonth;
    fact.intentId = intentId;
    appendCommittedEvents(state, [fact]);
    recordAgreementAction(state, fact);
    return action.content.id;
  }

  function acceptGovernanceOffer(state, responder, proposer, referenceId, atMonth, orderInMonth) {
    const fact = actionFact(`accept:${referenceId}:${responder.id}`, atMonth, responder.id, {
      kind: 'communicate',
      content: { id: `accept:${referenceId}:${responder.id}`, kind: 'accept', referenceId },
      audience: [proposer.id],
      channel: 'voice',
    }, { audience: [proposer.id] });
    fact.orderInMonth = orderInMonth;
    appendCommittedEvents(state, [fact]);
    recordAgreementAction(state, fact);
    recordGovernanceAction(state, fact);
  }

  const dutyState = createInitialState(26082743, {
    endpoint: { kind: 'months', value: 60 }, chaosIntensity: 0,
  });
  const [dutyObserver, dutyHolder] = dutyState.people;
  dutyState.people = [dutyObserver, dutyHolder];
  dutyObserver.position = structuredClone(dutyHolder.position);
  dutyObserver.bornAtMonth = dutyHolder.bornAtMonth = -30 * 12;
  completedJointDutyProject(dutyState, dutyObserver, dutyHolder, 'duty-project-1', 6, 7);
  completedJointDutyProject(dutyState, dutyObserver, dutyHolder, 'duty-project-2', 13, 14);
  const collectiveSource = actionFact('collective:duty:source', 17, dutyObserver.id, {
    kind: 'communicate',
    content: { id: 'collective:duty:source', kind: 'claim', summary: '共同体已经形成' },
    audience: [dutyHolder.id], channel: 'voice',
  }, { audience: [dutyHolder.id] });
  appendCommittedEvents(dutyState, [collectiveSource]);
  dutyState.collectives = [{
    id: 'collective:duty', purposeSummary: '延续反复共同劳动', status: 'active',
    foundedAtMonth: 17, formationAgreementId: 'agreement:duty:formation',
    memberships: [dutyObserver, dutyHolder].map((member) => ({
      id: `membership:duty:${member.id}`,
      collectiveId: 'collective:duty',
      personId: member.id,
      status: 'active',
      joinedAtMonth: 17,
      sourceEventIds: [collectiveSource.id],
    })),
    decisionRules: [], mandates: [], sourceEventIds: [collectiveSource.id],
  }];
  dutyState.clock.elapsedMonths = 20;
  const beforeThirdProject = buildSocialOptions(
    dutyState, dutyObserver, [dutyHolder], 20,
  ).filter((option) => {
    const action = option.completionAction ?? option.nextAction;
    return action.kind === 'communicate'
      && (action.content.kind === 'offer' || action.content.kind === 'request')
      && action.content.proposal?.kind === 'decision-rule'
      && action.content.proposal.scope === 'assign-recurring-duty';
  });
  assert.equal(beforeThirdProject.length, 0,
    'two past duty episodes alone do not auto-institutionalize without a third current pressure');

  const thirdTrigger = actionFact('trigger:duty-project-3', 21, dutyHolder.id, {
    kind: 'communicate',
    content: { id: 'trigger:duty-project-3', kind: 'claim', summary: '当前同类项目需要继续处理' },
    audience: [dutyObserver.id], channel: 'voice',
  }, { audience: [dutyObserver.id] });
  const competingTrigger = actionFact('trigger:duty-project-competitor', 21, dutyHolder.id, {
    kind: 'communicate',
    content: { id: 'trigger:duty-project-competitor', kind: 'claim', summary: '另一个现有项目需要处理' },
    audience: [dutyObserver.id], channel: 'voice',
  }, { audience: [dutyObserver.id] });
  competingTrigger.orderInMonth = 1;
  appendCommittedEvents(dutyState, [thirdTrigger, competingTrigger]);
  const thirdProject = instantiateProject({
    id: 'duty-project-3', kind: 'production', need: 'food-preparation',
    desiredFunction: 'prepared-food', summary: '第三次共同加工食物',
    ownerId: dutyHolder.id, beneficiaryIds: [dutyObserver.id, dutyHolder.id],
    triggerFactIds: [thirdTrigger.id], pressure: 52, createdAtMonth: 21, reviewAtMonth: 32,
  });
  thirdProject.contributorIds = [dutyHolder.id];
  const competingProject = instantiateProject({
    id: 'duty-project-competitor', kind: 'production', need: 'production-efficiency',
    desiredFunction: 'efficient-production', summary: '另一个既有生产项目',
    ownerId: dutyHolder.id, beneficiaryIds: [dutyHolder.id],
    triggerFactIds: [competingTrigger.id], pressure: 52, createdAtMonth: 21, reviewAtMonth: 32,
  });
  competingProject.contributorIds = [dutyHolder.id];
  dutyState.projects.push(thirdProject, competingProject);
  dutyState.clock.elapsedMonths = 21;

  const dutyRuleOption = buildSocialOptions(
    dutyState, dutyObserver, [dutyHolder], 21,
  ).find((option) => {
    const action = option.completionAction ?? option.nextAction;
    return action.kind === 'communicate'
      && (action.content.kind === 'offer' || action.content.kind === 'request')
      && action.content.proposal?.kind === 'decision-rule'
      && action.content.proposal.scope === 'assign-recurring-duty';
  });
  assert.ok(dutyRuleOption, 'two real cross-month episodes plus a third active matching project expose one duty rule option');
  assert.ok(dutyRuleOption.sourceFactIds.includes('progress:duty-project-1')
    && dutyRuleOption.sourceFactIds.includes('completion:duty-project-2')
    && dutyRuleOption.sourceFactIds.includes(thirdTrigger.id));
  assert.equal(dutyState.collectives[0].decisionRules.length, 0,
    'option exposure still creates neither a rule nor a mandate');

  const ruleReferenceId = commitSocialOffer(dutyState, dutyObserver, dutyRuleOption, 22, 0);
  assert.equal(dutyState.collectives[0].decisionRules.length, 0,
    'the proposal alone cannot create the duty rule');
  acceptGovernanceOffer(dutyState, dutyHolder, dutyObserver, ruleReferenceId, 22, 1);
  const dutyRule = dutyState.collectives[0].decisionRules.find((rule) => (
    rule.scope === 'assign-recurring-duty'
  ));
  assert.ok(dutyRule, 'all current members explicitly accepting creates the typed duty rule');

  function existingProjectOption(id, project, pressure = 52) {
    return {
      id,
      summary: `推进${project.summary}`,
      reason: 'fixture represents an option already emitted by the legal project compiler',
      goal: { kind: 'project-completed', projectId: project.id },
      nextAction: { kind: 'act', operation: 'exert', targets: [] },
      estimatedDuration: 'one-month', estimatedMonths: 1,
      risks: [], domain: 'strategic', sourceFactIds: [...project.triggerFactIds],
      projectId: project.id, projectPressure: pressure,
      semantics: {
        version: 'action-option-semantics-v1', obligation: 'optional', planningChannel: 'ordinary',
        purpose: 'project', minimumLifeStage: 'adolescent', needKinds: ['commitment', 'capability'],
      },
    };
  }
  const dutyStepOption = existingProjectOption('z-existing-duty-step', thirdProject, 52);
  const competingStepOption = existingProjectOption('a-existing-competing-step', competingProject, 52);
  const priorityContext = {
    state: dutyState,
    person: dutyHolder,
    visibleCells: [dutyHolder.position.cellId],
    visiblePeople: [dutyObserver],
    visibleDrops: [], visibleAnimals: [],
    options: [competingStepOption, dutyStepOption], followUpOptions: [],
  };
  const rankingWithoutMandate = rankCognitiveOptionsWithoutForesight(
    priorityContext, priorityContext.options, { atMonth: 23, planningTick: 1 },
  );
  const repeatedRankingWithoutMandate = rankCognitiveOptionsWithoutForesight(
    priorityContext, priorityContext.options, { atMonth: 23, planningTick: 1 },
  );
  assert.deepEqual(
    rankingWithoutMandate.map(({ option, rankScore }) => [option.id, rankScore]),
    repeatedRankingWithoutMandate.map(({ option, rankScore }) => [option.id, rankScore]),
    'without an active mandate the existing legal option ranking is unchanged',
  );
  assert.equal(rankingWithoutMandate[0].option.id, competingStepOption.id,
    'before authorization the matching duty receives no hidden ordering advantage');

  dutyState.clock.elapsedMonths = 23;
  const dutyMandateOption = buildSocialOptions(
    dutyState, dutyObserver, [dutyHolder], 23,
  ).find((option) => {
    const action = option.completionAction ?? option.nextAction;
    return action.kind === 'communicate'
      && (action.content.kind === 'offer' || action.content.kind === 'request')
      && action.content.proposal?.kind === 'mandate'
      && action.content.proposal.projectId === thirdProject.id;
  });
  assert.ok(dutyMandateOption, 'the holder must have the supported duty and an existing matching project before mandate proposal');
  const mandateReferenceId = commitSocialOffer(dutyState, dutyObserver, dutyMandateOption, 23, 0);
  acceptGovernanceOffer(dutyState, dutyHolder, dutyObserver, mandateReferenceId, 23, 1);
  const dutyMandate = dutyState.collectives[0].mandates.find((mandate) => (
    mandate.scope === 'assign-recurring-duty'
  ));
  assert.ok(dutyMandate && dutyMandate.projectId === thirdProject.id);
  assert.ok(thirdProject.triggerFactIds.includes(`accept:${mandateReferenceId}:${dutyHolder.id}`),
    'acceptance becomes a sourced commitment on the same pre-existing project');

  const rankingWithMandate = rankCognitiveOptionsWithoutForesight(
    priorityContext, priorityContext.options, { atMonth: 23, planningTick: 1 },
  );
  const dutyAppraisal = rankingWithMandate.find(({ option }) => option.id === dutyStepOption.id);
  const competingAppraisal = rankingWithMandate.find(({ option }) => option.id === competingStepOption.id);
  assert.ok(dutyAppraisal.factors.find((factor) => factor.kind === 'commitment')
    ?.sourceFactIds.includes(`accept:${mandateReferenceId}:${dutyHolder.id}`),
  'the mandate raises only the already compiled matching step through a sourced commitment factor');
  assert.equal(competingAppraisal.factors.find((factor) => factor.kind === 'commitment')
    ?.sourceFactIds.includes(`accept:${mandateReferenceId}:${dutyHolder.id}`), false,
  'an unrelated existing project step receives no duty priority');
  assert.ok(dutyAppraisal.rankScore > rankingWithoutMandate
    .find(({ option }) => option.id === dutyStepOption.id).rankScore,
  'the accepted duty materially raises the matching option priority');
  assert.equal(rankingWithMandate[0].option.id, dutyStepOption.id,
    'the sourced mandate reorders, rather than merely relabels, the existing legal matching option');
  assert.equal(priorityContext.options.length, 2,
    'the mandate reorders existing legal options and creates no option or primitive action');
  const noMatchingStep = rankCognitiveOptionsWithoutForesight(
    { ...priorityContext, options: [competingStepOption] },
    [competingStepOption],
    { atMonth: 23, planningTick: 1 },
  )[0];
  assert.equal(noMatchingStep.factors.find((factor) => factor.kind === 'commitment')
    ?.sourceFactIds.includes(`accept:${mandateReferenceId}:${dutyHolder.id}`), false,
  'a mandate cannot make a missing or non-matching project step executable');

  const realProgress = actionFact('progress:duty-project-3:mandated', 24, dutyHolder.id, {
    kind: 'act', operation: 'exert', targets: [],
  });
  appendCommittedEvents(dutyState, [realProgress]);
  recordProjectAction(dutyState, thirdProject.id, realProgress);
  assert.deepEqual(dutyMandate.dutyProgressEventIds, [realProgress.id]);
  assert.equal(dutyMandate.dutyCompletionEventIds.length, 0);
  assert.equal(deriveObservations(dutyState).institutions.some((institution) => (
    institution.key.includes(dutyRule.id)
  )), false, 'progress alone is not a functional institution');

  const unrelatedProgress = actionFact('progress:duty-project-competitor', 24, dutyHolder.id, {
    kind: 'act', operation: 'exert', targets: [],
  });
  unrelatedProgress.orderInMonth = 1;
  appendCommittedEvents(dutyState, [unrelatedProgress]);
  recordProjectAction(dutyState, competingProject.id, unrelatedProgress);
  assert.deepEqual(dutyMandate.dutyProgressEventIds, [realProgress.id],
    'an unrelated project action cannot exercise the duty');

  const realCompletion = actionFact('completion:duty-project-3:mandated', 25, dutyHolder.id, {
    kind: 'act', operation: 'exert', targets: [],
  });
  appendCommittedEvents(dutyState, [realCompletion]);
  completeProject(dutyState, thirdProject, 25, [realCompletion.id]);
  assert.deepEqual(dutyMandate.dutyCompletionEventIds, [realCompletion.id]);
  assert.ok(deriveObservations(dutyState).institutions.some((institution) => (
    institution.key.includes(dutyRule.id)
      && institution.label === '共同体反复项目职责'
  )), 'only real matching progress plus project completion makes the duty a functional institution');

  console.log('contextual social planning: PASS');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
