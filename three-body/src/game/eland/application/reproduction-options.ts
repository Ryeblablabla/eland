import type { ActionOption } from '../domain/action';
import {
  agreementsForPerson,
  reproductionAttemptedBetweenInMonth,
} from '../domain/agreement';
import { hasReproductiveRecoveryCondition } from '../domain/dependent-care';
import type { SimulationState } from '../domain/model';
import { ageMonths, isAlive, sameLocation, type PersonState } from '../domain/person';
import {
  buildRelationshipCausalBasis,
  canOfferRelationshipProposal,
} from '../domain/relationship-evidence';
import { openReproductionOfferFor } from '../domain/social-facts';
import { personById } from '../domain/state-index';
import { reproductiveUpperAgeMonths } from '../domain/trait';
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

/**
 * A formal proposal needs two living adults with a biologically possible
 * pairing. Temporary reserves, pregnancy, and recovery belong to execution:
 * people may still discuss the future while their bodies are not ready now.
 */
function reproductiveProposalPairEligible(first: PersonState, second: PersonState, atMonth: number): boolean {
  if (!isAlive(first) || !isAlive(second) || first.id === second.id || first.sex === second.sex) return false;
  const female = first.sex === 'female' ? first : second;
  const male = first.sex === 'male' ? first : second;
  return ageMonths(female, atMonth) >= 16 * 12
    && ageMonths(female, atMonth) <= reproductiveUpperAgeMonths(female)
    && ageMonths(male, atMonth) >= 16 * 12;
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
      kind: 'talk' as const,
      speakerMeaning: {
        id: revokeId,
        kind: 'revoke-agreement' as const,
        referenceId: activeReproductionAgreement.id,
        summary: '撤回这一次生殖尝试的同意',
      },
    };
    options.push({
      id: `withdraw-reproduce:${activeReproductionAgreement.id}`,
      summary: `向${activeReproductionPartner.name}撤回生殖尝试窗口的同意`,
      reason: '已经接受的多月生殖尝试窗口仍可依据身体、关系或家庭准备变化重新评估并撤回',
      goal: { kind: 'representation-made', representationId: revokeId },
      nextAction: together
        ? revokeAction
        : { kind: 'move', toCellId: activeReproductionPartner.position.cellId, toZ: activeReproductionPartner.position.z },
      ...(!together ? { completionAction: revokeAction } : {}),
      target: { kind: 'person', personId: activeReproductionPartner.id },
      estimatedDuration: together ? 'one-month' : 'several-months',
      sourceFactIds: [...activeReproductionAgreement.sourceEventIds],
      semantics: defineActionOptionSemantics({
        obligation: 'optional',
        planningChannel: 'ordinary',
        purpose: 'reproduction',
        minimumLifeStage: 'adult',
        needKinds: ['commitment', 'generativity', 'autonomy'],
        reproduction: { direction: 'refuse', phase: 'withdrawal', mode: 'mutual' },
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
      const acceptAction = { kind: 'talk' as const, speakerMeaning: { id: representationId, kind: 'accept' as const, referenceId: incomingOffer.content.id } };
      const perceivedRisk = perceivedKinshipRisk(state, person, proposer);
      const learnedRisk = perceivedRisk.cost > 0;
      const responseSourceFactIds = [...new Set([
        incomingOffer.fact.id,
        ...responseBasis.sourceFactIds,
        ...perceivedRisk.sourceFactIds,
      ])];
      const bodiesReadyNow = reproductivePairEligible(person, proposer, atMonth);
      options.push({
        id: `accept-reproduce:${incomingOffer.content.id}`,
        summary: `接受${proposer.name}的共同生殖提议`,
        reason: learnedRisk
          ? '过去的后代体弱或疾病记忆会进入本人的同意判断'
          : bodiesReadyNow
            ? '本人将依据有来源经历、人格和当前责任自行判断是否接受'
            : '同意只形成可撤回的共同尝试窗口；当前身体不适合执行，但不替本人决定是否谈论未来',
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
      const rejectAction = { kind: 'talk' as const, speakerMeaning: { id: rejectId, kind: 'reject' as const, referenceId: incomingOffer.content.id } };
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

  const reproductiveCandidates = visiblePeople.filter((other) => {
    if (activeReproductionAgreement) return false;
    return reproductiveProposalPairEligible(person, other, atMonth);
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
          : basis.relationshipKeys.length > 0
            ? '本人可依据彼此有来源的共同经历自行决定是否提出，对方仍可拒绝'
            : '提出只开启双方讨论，不预设亲密关系、接受或实际生殖结果',
        goal: { kind: 'representation-made', representationId },
        nextAction: together ? {
          kind: 'talk',
          speakerMeaning: { id: representationId, kind: 'offer', summary: '是否愿意共同生育后代', proposal: { kind: 'reproduce', proposerId: person.id, partnerId: reproductivePartner.id, expiresAtMonth: atMonth + 4, basis } },
        } : { kind: 'move', toCellId: reproductivePartner.position.cellId, toZ: reproductivePartner.position.z },
        ...(!together ? { completionAction: {
          kind: 'talk' as const,
          speakerMeaning: { id: representationId, kind: 'offer' as const, summary: '是否愿意共同生育后代', proposal: { kind: 'reproduce' as const, proposerId: person.id, partnerId: reproductivePartner.id, expiresAtMonth: atMonth + 4, basis } },
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
