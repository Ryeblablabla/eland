import type { ActionOption } from '../domain/action';
import { agreementsForPerson, reproductionAttemptedBetweenInMonth } from '../domain/agreement';
import { hasReproductiveRecoveryCondition } from '../domain/dependent-care';
import type { SimulationState } from '../domain/model';
import { ageMonths, isAlive, sameLocation, type PersonState } from '../domain/person';
import {
  buildRelationshipCausalBasis,
  canOfferRelationshipProposal,
} from '../domain/relationship-evidence';
import { openReproductionOfferFor } from '../domain/social-facts';
import { personById } from '../domain/state-index';
import { hasTrait, reproductiveUpperAgeMonths } from '../domain/trait';
import { defineActionOptionSemantics } from '../domain/action-option-semantics';
import { perceivedKinshipRisk } from './reproductive-risk';

function reproductivePairEligible(first: PersonState, second: PersonState, atMonth: number): boolean {
  if (first.sex === second.sex) return false;
  const female = first.sex === 'female' ? first : second;
  const male = first.sex === 'male' ? first : second;
  if (ageMonths(female, atMonth) < 16 * 12
    || ageMonths(female, atMonth) > reproductiveUpperAgeMonths(female)
    || ageMonths(male, atMonth) < 16 * 12) return false;
  if (hasReproductiveRecoveryCondition(female)) return false;
  return Math.min(
    first.body.health, first.body.hydration, first.body.nutrition,
    second.body.health, second.body.hydration, second.body.nutrition,
  ) >= 55;
}

function succubusPairEligible(actor: PersonState, partner: PersonState, atMonth: number): boolean {
  if (!isAlive(actor) || !isAlive(partner)
    || actor.id === partner.id
    || actor.sex !== 'female'
    || partner.sex !== 'male'
    || !hasTrait(actor, 'succubus')) return false;
  if (ageMonths(actor, atMonth) < 16 * 12 || ageMonths(partner, atMonth) < 16 * 12) return false;
  return !actor.conditions.some((condition) => condition.kind === 'pregnancy');
}

export function buildReproductionOptions(
  state: SimulationState,
  person: PersonState,
  visiblePeople: PersonState[],
  atMonth: number,
): ActionOption[] {
  const options: ActionOption[] = [];
  const activeReproductionAgreement = [...agreementsForPerson(state, person.id)].reverse().find((agreement) => agreement.status === 'active'
    && agreement.proposal.kind === 'reproduce'
    && agreement.partyIds.includes(person.id)
    && (agreement.acceptedAtMonth ?? Number.POSITIVE_INFINITY) <= atMonth
    && (agreement.dueAtMonth ?? Number.NEGATIVE_INFINITY) >= atMonth);
  const activeReproductionPartnerId = activeReproductionAgreement?.partyIds.find((personId) => personId !== person.id);
  const activeReproductionPartnerCandidate = activeReproductionPartnerId
    ? personById(state, activeReproductionPartnerId)
    : undefined;
  const activeReproductionPartner = activeReproductionPartnerCandidate && isAlive(activeReproductionPartnerCandidate)
    ? activeReproductionPartnerCandidate
    : undefined;
  if (activeReproductionAgreement?.proposal.kind === 'reproduce' && activeReproductionPartner) {
    const together = sameLocation(activeReproductionPartner, person);
    const revokeId = `revoke-reproduce:${activeReproductionAgreement.id}:${person.id}:${atMonth}`;
    const revokeAction = {
      kind: 'communicate' as const,
      content: {
        id: revokeId,
        kind: 'revoke-agreement' as const,
        referenceId: activeReproductionAgreement.id,
        summary: '撤回这一次生殖尝试的同意',
      },
      audience: [activeReproductionPartner.id],
      channel: 'voice' as const,
    };
    options.push({
      id: `withdraw-reproduce:${activeReproductionAgreement.id}`,
      summary: `向${activeReproductionPartner.name}撤回本次生殖同意`,
      reason: '已经接受的单次生殖尝试在实际发生前仍可重新评估并撤回',
      goal: { kind: 'representation-made', representationId: revokeId },
      nextAction: together
        ? revokeAction
        : { kind: 'move', toCellId: activeReproductionPartner.position.cellId, toZ: activeReproductionPartner.position.z },
      ...(!together ? { completionAction: revokeAction } : {}),
      target: { kind: 'person', personId: activeReproductionPartner.id },
      estimatedDuration: together ? 'one-month' : 'several-months',
      sourceFactIds: [...activeReproductionAgreement.sourceEventIds],
      semantics: defineActionOptionSemantics({
        obligation: 'commitment-action',
        planningChannel: 'edge',
        purpose: 'reproduction',
        minimumLifeStage: 'adult',
        needKinds: ['commitment', 'generativity', 'autonomy'],
        reproduction: { direction: 'refuse', phase: 'withdrawal', mode: 'mutual' },
        edgeTrigger: 'commitment-action',
        socialContext: {
          cooperationKind: 'reproduction', phase: 'withdrawal',
          counterpartIds: [activeReproductionPartner.id], referenceId: activeReproductionAgreement.id,
        },
      }),
    });
    if (!reproductionAttemptedBetweenInMonth(state, person.id, activeReproductionPartner.id, atMonth)
      && reproductivePairEligible(person, activeReproductionPartner, atMonth)) {
      const female = person.sex === 'female' ? person : activeReproductionPartner;
      options.push({
        id: `reproduce:${activeReproductionAgreement.id}:${activeReproductionPartner.id}`,
        summary: `与${activeReproductionPartner.name}进行已同意的一次生殖尝试`,
        reason: '双方已形成可追溯的单次授权，且行动前仍可重新评估',
        goal: { kind: 'condition', personId: female.id, condition: 'pregnancy', present: true },
        nextAction: together
          ? { kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: activeReproductionPartner.id }], authorizationRef: activeReproductionAgreement.id }
          : { kind: 'move', toCellId: activeReproductionPartner.position.cellId, toZ: activeReproductionPartner.position.z },
        ...(!together ? { completionAction: { kind: 'act' as const, operation: 'reproduce' as const, targets: [{ kind: 'person' as const, personId: activeReproductionPartner.id }], authorizationRef: activeReproductionAgreement.id } } : {}),
        target: { kind: 'person', personId: activeReproductionPartner.id },
        estimatedDuration: together ? 'one-month' : 'several-months',
        sourceFactIds: [...activeReproductionAgreement.sourceEventIds],
      });
    }
  }

  const incomingOffer = openReproductionOfferFor(state, person.id);
  if (incomingOffer) {
    const proposer = personById(state, incomingOffer.fact.who);
    if (proposer) {
      const responseBasis = buildRelationshipCausalBasis(state, person, proposer, 'reproduce', atMonth);
      const representationId = `accept:${incomingOffer.content.id}:${person.id}`;
      const together = sameLocation(proposer, person);
      const acceptAction = { kind: 'communicate' as const, content: { id: representationId, kind: 'accept' as const, referenceId: incomingOffer.content.id }, audience: [proposer.id], channel: 'voice' as const };
      const perceivedRisk = perceivedKinshipRisk(state, person, proposer);
      const learnedRisk = perceivedRisk.cost > 0;
      const responseSourceFactIds = [...new Set([
        incomingOffer.fact.id,
        ...responseBasis.sourceFactIds,
        ...perceivedRisk.sourceFactIds,
      ])];
      if (reproductivePairEligible(person, proposer, atMonth)) options.push({
        id: `accept-reproduce:${incomingOffer.content.id}`,
        summary: `接受${proposer.name}的共同生殖提议`,
        reason: learnedRisk ? '过去的后代体弱或疾病记忆会进入本人的同意判断' : '本人将依据关系、人格和当前责任自行判断是否接受',
        goal: { kind: 'representation-made', representationId },
        nextAction: together ? acceptAction : { kind: 'move', toCellId: proposer.position.cellId, toZ: proposer.position.z },
        ...(!together ? { completionAction: acceptAction } : {}),
        target: { kind: 'person', personId: proposer.id },
        estimatedDuration: together ? 'one-month' : 'several-months',
        sourceFactIds: responseSourceFactIds,
        relationshipBasis: responseBasis,
        semantics: defineActionOptionSemantics({
          obligation: 'required-response', planningChannel: 'edge',
          purpose: 'reproduction', minimumLifeStage: 'adult',
          needKinds: ['autonomy', 'generativity'], edgeTrigger: 'required-response',
          reproduction: { direction: 'proceed', phase: 'response', mode: 'mutual' },
          socialContext: {
            cooperationKind: 'reproduction', phase: 'response', counterpartIds: [proposer.id],
            referenceId: incomingOffer.content.id,
          },
        }),
      });
      const rejectId = `reject:${incomingOffer.content.id}:${person.id}`;
      const rejectAction = { kind: 'communicate' as const, content: { id: rejectId, kind: 'reject' as const, referenceId: incomingOffer.content.id }, audience: [proposer.id], channel: 'voice' as const };
      options.push({
        id: `reject-reproduce:${incomingOffer.content.id}`,
        summary: '拒绝共同生殖提议',
        reason: learnedRisk
          ? '记忆中已有近亲后代体弱或疾病的可追溯经验'
          : responseBasis.relationshipKeys.length
            ? '本人将依据这段有来源关系和当前责任自行判断是否拒绝'
            : '本人没有自己的共同经历，但仍须明确回应对方的提议',
        goal: { kind: 'representation-made', representationId: rejectId },
        nextAction: together ? rejectAction : { kind: 'move', toCellId: proposer.position.cellId, toZ: proposer.position.z },
        ...(!together ? { completionAction: rejectAction } : {}),
        target: { kind: 'person', personId: proposer.id },
        estimatedDuration: together ? 'one-month' : 'several-months',
        sourceFactIds: responseSourceFactIds,
        relationshipBasis: responseBasis,
        semantics: defineActionOptionSemantics({
          obligation: 'required-response', planningChannel: 'edge',
          purpose: 'reproduction', minimumLifeStage: 'adult',
          needKinds: ['autonomy', 'generativity'], edgeTrigger: 'required-response',
          reproduction: { direction: 'refuse', phase: 'response', mode: 'mutual' },
          socialContext: {
            cooperationKind: 'reproduction', phase: 'response', counterpartIds: [proposer.id],
            referenceId: incomingOffer.content.id,
          },
        }),
      });
    }
  }

  const succubusTrait = person.traits?.find((trait) => trait.id === 'succubus');
  if (succubusTrait) {
    const unilateralCandidates = visiblePeople
      .filter((other) => succubusPairEligible(person, other, atMonth))
      .filter((other) => !reproductionAttemptedBetweenInMonth(state, person.id, other.id, atMonth))
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const reproductivePartner of unilateralCandidates) {
      const together = sameLocation(reproductivePartner, person);
      const reproduceAction = {
        kind: 'act' as const,
        operation: 'reproduce' as const,
        targets: [{ kind: 'person' as const, personId: reproductivePartner.id }],
      };
      options.push({
        id: `reproduce:succubus:${person.id}:${reproductivePartner.id}`,
        summary: `以魅魔特质与${reproductivePartner.name}进行单方生殖尝试`,
        reason: '魅魔特质让本人能够以单方同意越过关系、协议、家庭准备度与身体储备门槛',
        goal: { kind: 'condition', personId: person.id, condition: 'pregnancy', present: true },
        nextAction: together
          ? reproduceAction
          : { kind: 'move', toCellId: reproductivePartner.position.cellId, toZ: reproductivePartner.position.z },
        ...(!together ? { completionAction: reproduceAction } : {}),
        target: { kind: 'person', personId: reproductivePartner.id },
        estimatedDuration: together ? 'one-month' : 'several-months',
        sourceFactIds: [...succubusTrait.sourceEventIds],
      });
    }
  }

  const reproductiveCandidates = visiblePeople.filter((other) => {
    if (activeReproductionAgreement) return false;
    return reproductivePairEligible(person, other, atMonth);
  }).map((other) => ({
    other,
    basis: buildRelationshipCausalBasis(state, person, other, 'reproduce', atMonth),
  })).filter((candidate) => canOfferRelationshipProposal(state, person, candidate.other, candidate.basis))
    .sort((a, b) => a.other.id.localeCompare(b.other.id));
  for (const { other: reproductivePartner, basis } of reproductiveCandidates) {
    const together = sameLocation(reproductivePartner, person);
    if (!incomingOffer) {
      const representationId = `offer-reproduce:${atMonth}:${person.id}:${reproductivePartner.id}`;
      const perceivedRisk = perceivedKinshipRisk(state, person, reproductivePartner);
      options.push({
        id: representationId,
        summary: `向${reproductivePartner.name}提出共同生殖`,
        reason: perceivedRisk.cost > 0
          ? '本人记得这段亲缘可能增加后代风险，是否提议仍由本人权衡'
          : together
            ? '彼此已有可追溯的共同经历，且身体条件允许本人考虑生殖'
            : '彼此已有可追溯的共同经历，对方可见且身体条件允许本人考虑生殖',
        goal: { kind: 'representation-made', representationId },
        nextAction: together ? {
          kind: 'communicate',
          content: { id: representationId, kind: 'offer', summary: '是否愿意共同生育后代', proposal: { kind: 'reproduce', proposerId: person.id, partnerId: reproductivePartner.id, expiresAtMonth: atMonth + 4, basis } },
          audience: [reproductivePartner.id], channel: 'voice',
        } : { kind: 'move', toCellId: reproductivePartner.position.cellId, toZ: reproductivePartner.position.z },
        ...(!together ? { completionAction: {
          kind: 'communicate' as const,
          content: { id: representationId, kind: 'offer' as const, summary: '是否愿意共同生育后代', proposal: { kind: 'reproduce' as const, proposerId: person.id, partnerId: reproductivePartner.id, expiresAtMonth: atMonth + 4, basis } },
          audience: [reproductivePartner.id], channel: 'voice' as const,
        } } : {}),
        target: { kind: 'person', personId: reproductivePartner.id },
        estimatedDuration: together ? 'one-month' : 'several-months',
        sourceFactIds: [...new Set([...basis.sourceFactIds, ...perceivedRisk.sourceFactIds])],
        relationshipBasis: basis,
      });
    }
  }

  return options;
}
