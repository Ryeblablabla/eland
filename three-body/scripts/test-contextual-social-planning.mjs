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
    export { evaluateCognitiveOption } from ${JSON.stringify(path.resolve('src/game/eland/application/cognition/option-appraisal.ts'))};
    export {
      appraiseSocialExpectation,
      applyContextualSocialAttention,
      cooperationContextForOption,
    } from ${JSON.stringify(path.resolve('src/game/eland/application/cognition/social-expectation.ts'))};
    export { Material } from ${JSON.stringify(path.resolve('src/game/eland/domain/material.ts'))};
  `;
  execFileSync(path.resolve('node_modules/.bin/esbuild'), [
    '--bundle', '--platform=node', '--format=esm', '--loader=ts',
    '--sourcefile=contextual-social-planning-test-entry.ts', `--outfile=${bundlePath}`,
  ], { input: entry, stdio: ['pipe', 'pipe', 'pipe'] });

  const {
    appraiseSocialExpectation,
    applyContextualSocialAttention,
    buildSocialOptions,
    cooperationContextForOption,
    createInitialState,
    evaluateCognitiveOption,
    Material,
  } = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);

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

  console.log('contextual social planning: PASS');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
