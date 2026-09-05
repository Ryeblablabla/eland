import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'eland-emergent-governance-'));
const entryPath = path.join(temporaryDirectory, 'entry.ts');
const bundlePath = path.join(temporaryDirectory, 'bundle.mjs');

try {
  writeFileSync(entryPath, `
    export { createInitialState } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/simulation.ts'))};
    export { buildSocialOptions } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/application/social-options.ts'))};
    export { Material } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/material.ts'))};
    export { recordAgreementAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/agreement.ts'))};
    export { recordGovernanceAction } from ${JSON.stringify(path.join(projectRoot, 'src/game/eland/domain/governance.ts'))};
  `);
  execFileSync(path.join(projectRoot, 'node_modules/.bin/esbuild'), [
    entryPath,
    '--bundle', '--platform=node', '--format=esm', `--outfile=${bundlePath}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const {
    Material,
    buildSocialOptions,
    createInitialState,
    recordAgreementAction,
    recordGovernanceAction,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  const state = createInitialState(20260904, {
    endpoint: { kind: 'months', value: 24 },
    chaosIntensity: 0,
  });
  state.clock.elapsedMonths = 8;
  const members = state.people.slice(0, 3);
  assert.equal(members.length, 3);
  const sharedPosition = { ...members[0].position };
  members.forEach((member, index) => {
    member.position = {
      ...sharedPosition,
      lastPath: [sharedPosition.cellId],
      tickPath: [sharedPosition.cellId],
    };
    member.body.health = 90;
    member.body.hydration = 80;
    member.body.nutrition = index === 2 ? 50 : 80;
    member.inventory = [];
    // These values deliberately make member 0 the former weighted winner.
    member.motiveSensitivity.status = index === 0 ? 100 : 0;
    member.baselineCapacities.cognition = index === 0 ? 100 : 5;
    member.baselineCapacities.communication = index === 0 ? 100 : 5;
  });
  members[0].inventory = [
    { id: 'food-stack', materialId: Material.Food, quantity: 3, sourceEventIds: ['food-source'] },
    { id: 'cooked-stack', materialId: Material.CookedFood, quantity: 3, sourceEventIds: ['cooked-source'] },
  ];

  const collectiveId = 'collective-emergent-governance';
  const memberships = members.map((member) => ({
    id: `membership:${member.id}`,
    collectiveId,
    personId: member.id,
    status: 'active',
    joinedAtMonth: 1,
    sourceEventIds: [`membership-source:${member.id}`],
  }));
  state.collectives = [{
    id: collectiveId,
    purposeSummary: '共同处理实际生存需求',
    status: 'active',
    foundedAtMonth: 1,
    formationAgreementId: 'formation-agreement',
    memberships,
    decisionRules: [],
    mandates: [],
    sourceEventIds: ['collective-source'],
  }];
  members[0].cognition.socialLearning = {
    version: 'social-learning-v1',
    startedAtMonth: 1,
    beliefs: [],
    coordinationPractices: [{
      version: 'coordination-practice-basis-v1',
      basisKey: 'shared-practice',
      observerId: members[0].id,
      targetPersonId: members[1].id,
      participantIds: [members[0].id, members[1].id],
      context: 'joint-project-production',
      formedAtMonth: 2,
      lastUpdatedAtMonth: 6,
      support: 'supported',
      successes: [
        { atMonth: 2, receiptIds: ['practice-receipt-1'], sourceEventIds: ['practice-source-1'] },
        { atMonth: 6, receiptIds: ['practice-receipt-2'], sourceEventIds: ['practice-source-2'] },
      ],
      recentCounterEvidence: [],
      sourceFactIds: ['practice-source-1', 'practice-source-2'],
    }],
  };

  const visibleTo = (person) => members.filter((candidate) => candidate.id !== person.id);
  const ruleOffersFor = (person) => buildSocialOptions(state, person, visibleTo(person), 8)
    .filter((option) => option.nextAction.kind === 'talk'
      && option.nextAction.speakerMeaning.kind === 'offer'
      && option.nextAction.speakerMeaning.proposal?.kind === 'decision-rule'
      && option.nextAction.speakerMeaning.proposal.scope === 'coordinate-material');

  for (const member of members) {
    const offers = ruleOffersFor(member);
    assert.deepEqual(offers.map((option) => {
      const proposal = option.nextAction.speakerMeaning.proposal;
      return `${proposal.materialId}:${proposal.method}`;
    }).sort(), [
      `${Material.Food}:majority-vote`,
      `${Material.Food}:unanimous`,
      `${Material.CookedFood}:majority-vote`,
      `${Material.CookedFood}:unanimous`,
    ], '每个在场成员都应看到每个有真实需求的规则提案，不由地位或人格预选');
    for (const offer of offers) {
      const proposal = offer.nextAction.speakerMeaning.proposal;
      assert.equal(proposal.proposerId, member.id);
      assert.deepEqual(new Set(proposal.requiredApproverIds), new Set(
        members.filter((candidate) => candidate.id !== member.id).map((candidate) => candidate.id),
      ));
      assert.ok(proposal.method === 'unanimous' || proposal.method === 'majority-vote');
      assert.equal(proposal.mandateDurationMonths, 12);
      assert.equal(proposal.expiresAtMonth, 14);
    }
  }

  // Institutions can be proposed before a scripted cooperation milestone or crisis.
  members[0].cognition.socialLearning.coordinationPractices = [];
  members.forEach((member) => { member.body.nutrition = 90; });
  assert.equal(ruleOffersFor(members[1]).length, 4,
    'governance choices remain available without a learned-practice unlock or bodily shortage');
  const autonomyOptions = buildSocialOptions(state, members[1], visibleTo(members[1]), 8);
  assert.ok(autonomyOptions.some((option) => option.id === `withdraw-collective:${collectiveId}`),
    'a member may choose to leave before trust or fear crosses a scripted threshold');

  const collective = state.collectives[0];
  collective.decisionRules = [Material.Food, Material.CookedFood].map((materialId, index) => ({
    id: `material-rule:${materialId}`,
    collectiveId,
    method: index === 0 ? 'majority-vote' : 'unanimous',
    mandateDurationMonths: 12,
    status: 'active',
    acceptedAtMonth: 7,
    proposalAgreementId: `rule-agreement:${materialId}`,
    sourceEventIds: [`rule-source:${materialId}`],
    scope: 'coordinate-material',
    materialId,
  }));

  const mandateOffersFor = (person) => buildSocialOptions(state, person, visibleTo(person), 8)
    .filter((option) => option.nextAction.kind === 'talk'
      && option.nextAction.speakerMeaning.kind === 'offer'
      && option.nextAction.speakerMeaning.proposal?.kind === 'mandate');
  for (const proposer of members) {
    const offers = mandateOffersFor(proposer);
    assert.equal(offers.length, collective.decisionRules.length * members.length,
      '每条现实规则都应为每个有效成员产生独立 holder 方案');
    const candidatePairs = offers.map((option) => {
      const proposal = option.nextAction.speakerMeaning.proposal;
      return `${proposal.decisionRuleId}|${proposal.holderId}`;
    });
    assert.equal(new Set(candidatePairs).size, collective.decisionRules.length * members.length);
    for (const offer of offers) {
      const proposal = offer.nextAction.speakerMeaning.proposal;
      assert.equal(proposal.proposerId, proposer.id);
      assert.ok(members.some((candidate) => candidate.id === proposal.holderId));
      assert.deepEqual(new Set(proposal.requiredApproverIds), new Set(
        members.filter((candidate) => candidate.id !== proposer.id).map((candidate) => candidate.id),
      ));
      assert.equal(proposal.expiresAtMonth, 14);
    }
  }

  const proposer = members[0];
  const responder = members[1];
  const proposedOption = mandateOffersFor(proposer).find((option) => (
    option.nextAction.speakerMeaning.proposal.holderId === members[2].id
      && option.nextAction.speakerMeaning.proposal.decisionRuleId === collective.decisionRules[0].id
  ));
  assert.ok(proposedOption);
  const representation = proposedOption.nextAction.speakerMeaning;
  const proposalFact = {
    id: 'mandate-proposal-fact',
    kind: 'action',
    atMonth: 8,
    orderInMonth: 1,
    actionTick: 1,
    cellId: proposer.position.cellId,
    fromCellId: proposer.position.cellId,
    toCellId: proposer.position.cellId,
    fromZ: proposer.position.z,
    toZ: proposer.position.z,
    pathSegment: [proposer.position.cellId],
    who: proposer.id,
    cause: 'intent',
    status: 'completed',
    action: proposedOption.nextAction,
    result: '已提出限期协调授权',
    diff: {},
  };
  state.world.past.push(proposalFact);
  state.agreements.push({
    id: representation.id,
    proposal: representation.proposal,
    proposerId: proposer.id,
    responderId: responder.id,
    partyIds: [proposer.id, ...representation.proposal.requiredApproverIds],
    requiredResponderIds: [...representation.proposal.requiredApproverIds],
    acceptedByPersonIds: [proposer.id],
    rejectedByPersonIds: [],
    status: 'proposed',
    proposedAtMonth: 8,
    acceptByMonth: 14,
    proposalEventId: proposalFact.id,
    fulfillmentEventIds: [],
    fulfilledByPersonIds: [],
    coLocatedMonths: 0,
    sourceEventIds: [proposalFact.id],
  });
  const responseOptions = buildSocialOptions(state, responder, visibleTo(responder), 8);
  assert.ok(responseOptions.some((option) => option.id === `accept-mandate:${representation.id}`));
  assert.ok(responseOptions.some((option) => option.id === `reject-mandate:${representation.id}`));

  const voteFact = (voter, kind, orderInMonth, referenceId = representation.id) => ({
    id: `mandate-${kind}-vote:${voter.id}`,
    kind: 'action',
    atMonth: 8,
    orderInMonth,
    actionTick: 2,
    cellId: voter.position.cellId,
    fromCellId: voter.position.cellId,
    toCellId: voter.position.cellId,
    fromZ: voter.position.z,
    toZ: voter.position.z,
    pathSegment: [voter.position.cellId],
    who: voter.id,
    cause: 'intent',
    status: 'completed',
    action: {
      kind: 'talk',
      speakerMeaning: {
        id: `ballot:${referenceId}:${voter.id}`,
        kind,
        referenceId,
        summary: kind === 'accept' ? '我支持这项候选授权' : '我反对这项候选授权',
      },
    },
    result: `${voter.name}公开表达了自己的选择`,
    diff: {
      listenerInterpretations: [{
        version: 'listener-language-interpretation-v1',
        listenerId: proposer.id,
        sourceRepresentationId: `ballot:${referenceId}:${voter.id}`,
        kind,
      }],
    },
  });
  const opposition = voteFact(responder, 'reject', 2);
  state.world.past.push(opposition);
  recordAgreementAction(state, opposition);
  const ballot = state.agreements.find((agreement) => agreement.id === representation.id);
  assert.equal(ballot.status, 'proposed',
    '多数表决中一张反对票不能被当作对全体选择的单方否决');

  const support = voteFact(members[2], 'accept', 3);
  state.world.past.push(support);
  recordAgreementAction(state, support);
  assert.equal(ballot.status, 'active', '三人中的两张支持票应形成真实多数');
  recordGovernanceAction(state, support);
  assert.equal(ballot.status, 'fulfilled');
  const electedMandate = collective.mandates.find((mandate) => mandate.proposalAgreementId === ballot.id);
  assert.equal(electedMandate?.holderId, members[2].id,
    '多数票应把模型所提名且经成员表决的候选人变成有限任期协调者');
  assert.deepEqual(new Set(ballot.acceptedByPersonIds), new Set([proposer.id, members[2].id]));
  assert.deepEqual(ballot.rejectedByPersonIds, [responder.id]);

  const changedElectorateId = 'mandate-election:changed-electorate';
  const changedProposal = {
    ...structuredClone(representation.proposal),
    decisionRuleId: collective.decisionRules[1].id,
  };
  state.agreements.push({
    id: changedElectorateId,
    proposal: changedProposal,
    proposerId: proposer.id,
    responderId: responder.id,
    partyIds: [...members.map((member) => member.id)],
    requiredResponderIds: members.slice(1).map((member) => member.id),
    acceptedByPersonIds: [proposer.id],
    rejectedByPersonIds: [],
    status: 'proposed', proposedAtMonth: 8, acceptByMonth: 14,
    proposalEventId: 'changed-electorate-proposal', fulfillmentEventIds: [],
    fulfilledByPersonIds: [], coLocatedMonths: 0, sourceEventIds: ['changed-electorate-proposal'],
  });
  const departingMembership = collective.memberships.find((membership) => membership.personId === members[2].id);
  assert(departingMembership);
  departingMembership.status = 'withdrawn';
  const staleVote = voteFact(responder, 'accept', 4, changedElectorateId);
  recordAgreementAction(state, staleVote);
  assert.equal(state.agreements.find((agreement) => agreement.id === changedElectorateId)?.status, 'cancelled',
    'electorate changes must explicitly cancel an obsolete ballot instead of creating an active agreement that cannot become a rule');

  process.stdout.write('Emergent governance option tests passed\n');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
