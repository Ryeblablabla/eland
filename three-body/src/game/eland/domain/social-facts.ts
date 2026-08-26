import type { ActionFact, SimulationState } from './model';
import type { PersonId } from './person';
import type { RepresentationInput } from './action';
import {
  activeReproductionAgreementBetween,
  agreementById,
  agreementResponseDeadline,
  agreementsForPerson,
  type Agreement,
} from './agreement';
import {
  communicationByRepresentationId,
  completedActionFactsForPerson,
  completedCommunications,
  liveAgreementHistoryLeaseKey,
  worldEventByIdWithRetainedLease,
} from './event-index';

export function completedCommunicationFacts(state: SimulationState): ActionFact[] {
  if ((state.world.historyCursor?.hotStartIndex ?? 0) > 0) {
    throw new Error('有界历史状态不能把热窗口冒充完整 communication history');
  }
  return [...completedCommunications(state)];
}

export function communicationById(state: SimulationState, representationId: string): ActionFact | undefined {
  return communicationByRepresentationId(state, representationId);
}

export function acceptanceOf(state: SimulationState, representationId: string, byPersonId?: PersonId): ActionFact | undefined {
  const visible = (byPersonId ? completedActionFactsForPerson(state, byPersonId) : completedCommunications(state))
    .find((event) => event.action.kind === 'communicate'
      && event.action.content.kind === 'accept'
      && event.action.content.referenceId === representationId
      && (!byPersonId || event.who === byPersonId));
  if (visible) return visible;
  const agreement = agreementById(state, representationId);
  if (agreement && (agreement.status === 'active' || agreement.status === 'proposed')) {
    const fact = agreement.responseEventId
      ? communicationFact(state, agreement.responseEventId, agreement.id)
      : undefined;
    return fact?.action.kind === 'communicate'
      && fact.action.content.kind === 'accept'
      && fact.action.content.referenceId === representationId
      && (!byPersonId || fact.who === byPersonId)
      ? fact
      : undefined;
  }
  return undefined;
}

export function rejectionOf(state: SimulationState, representationId: string, byPersonId?: PersonId): ActionFact | undefined {
  const visible = (byPersonId ? completedActionFactsForPerson(state, byPersonId) : completedCommunications(state))
    .find((event) => event.action.kind === 'communicate'
      && event.action.content.kind === 'reject'
      && event.action.content.referenceId === representationId
      && (!byPersonId || event.who === byPersonId));
  if (visible) return visible;
  const agreement = agreementById(state, representationId);
  if (agreement?.status === 'proposed') {
    const fact = agreement.responseEventId
      ? communicationFact(state, agreement.responseEventId, agreement.id)
      : undefined;
    return fact?.action.kind === 'communicate'
      && fact.action.content.kind === 'reject'
      && fact.action.content.referenceId === representationId
      && (!byPersonId || fact.who === byPersonId)
      ? fact
      : undefined;
  }
  return undefined;
}

function communicationFact(
  state: SimulationState,
  eventId: string,
  agreementId: string,
): ActionFact | undefined {
  const fact = worldEventByIdWithRetainedLease(
    state,
    eventId,
    liveAgreementHistoryLeaseKey(agreementId),
  );
  return fact?.kind === 'action' && fact.action.kind === 'communicate' ? fact : undefined;
}

function agreementFacts(state: SimulationState, agreement: Agreement): { proposalFact: ActionFact; responseFact?: ActionFact } | null {
  const proposalFact = communicationFact(state, agreement.proposalEventId, agreement.id);
  if (!proposalFact) return null;
  const responseFact = agreement.responseEventId
    ? communicationFact(state, agreement.responseEventId, agreement.id)
    : undefined;
  return { proposalFact, responseFact };
}

export function openReproductionOfferFor(state: SimulationState, personId: PersonId): { fact: ActionFact; content: Extract<RepresentationInput, { kind: 'offer' }> } | null {
  const agreement = [...agreementsForPerson(state, personId)].reverse().find((item) => item.status === 'proposed' && item.proposal.kind === 'reproduce' && item.responderId === personId && agreementResponseDeadline(item, personId) >= state.clock.elapsedMonths);
  if (!agreement) return null;
  const facts = agreementFacts(state, agreement);
  if (!facts || facts.proposalFact.action.kind !== 'communicate' || facts.proposalFact.action.content.kind !== 'offer') return null;
  return { fact: facts.proposalFact, content: facts.proposalFact.action.content };
}

export function acceptedReproductionBetween(state: SimulationState, a: PersonId, b: PersonId, atMonth: number): { offer: ActionFact; acceptance: ActionFact } | null {
  const agreement = activeReproductionAgreementBetween(state, a, b, atMonth);
  if (!agreement) return null;
  const facts = agreementFacts(state, agreement);
  return facts?.responseFact ? { offer: facts.proposalFact, acceptance: facts.responseFact } : null;
}

export function openExchangeOfferFor(state: SimulationState, personId: PersonId): { fact: ActionFact; content: Extract<RepresentationInput, { kind: 'offer' }> } | null {
  const agreement = [...agreementsForPerson(state, personId)].reverse().find((item) => item.status === 'proposed' && item.proposal.kind === 'exchange' && item.responderId === personId && agreementResponseDeadline(item, personId) >= state.clock.elapsedMonths);
  if (!agreement) return null;
  const facts = agreementFacts(state, agreement);
  if (!facts || facts.proposalFact.action.kind !== 'communicate' || facts.proposalFact.action.content.kind !== 'offer') return null;
  return { fact: facts.proposalFact, content: facts.proposalFact.action.content };
}

export function acceptedExchangeFor(state: SimulationState, personId: PersonId, atMonth: number): { offer: ActionFact; acceptance: ActionFact; proposal: Extract<NonNullable<Extract<RepresentationInput, { kind: 'offer' }>['proposal']>, { kind: 'exchange' }> } | null {
  const agreement = [...agreementsForPerson(state, personId)].reverse().find((item) => item.status === 'active'
    && item.proposal.kind === 'exchange'
    && item.partyIds.includes(personId)
    && (item.acceptedAtMonth ?? Number.POSITIVE_INFINITY) <= atMonth);
  if (!agreement || agreement.proposal.kind !== 'exchange') return null;
  const facts = agreementFacts(state, agreement);
  return facts?.responseFact ? { offer: facts.proposalFact, acceptance: facts.responseFact, proposal: agreement.proposal } : null;
}

export function exchangeTermFulfilled(state: SimulationState, offerId: string, fromPersonId: PersonId): boolean {
  return agreementById(state, offerId)?.fulfilledByPersonIds.includes(fromPersonId) ?? false;
}

export function openAssistRequestFor(state: SimulationState, personId: PersonId): { fact: ActionFact; content: Extract<RepresentationInput, { kind: 'request' }> } | null {
  const agreement = [...agreementsForPerson(state, personId)].reverse().find((item) => item.status === 'proposed' && item.proposal.kind === 'assist' && item.responderId === personId && agreementResponseDeadline(item, personId) >= state.clock.elapsedMonths);
  if (!agreement) return null;
  const facts = agreementFacts(state, agreement);
  if (!facts || facts.proposalFact.action.kind !== 'communicate' || facts.proposalFact.action.content.kind !== 'request') return null;
  return { fact: facts.proposalFact, content: facts.proposalFact.action.content };
}

export function openCompanionOfferFor(state: SimulationState, personId: PersonId): { fact: ActionFact; content: Extract<RepresentationInput, { kind: 'offer' }> } | null {
  const agreement = [...agreementsForPerson(state, personId)].reverse().find((item) => item.status === 'proposed' && item.proposal.kind === 'companion' && item.responderId === personId && agreementResponseDeadline(item, personId) >= state.clock.elapsedMonths);
  if (!agreement) return null;
  const facts = agreementFacts(state, agreement);
  if (!facts || facts.proposalFact.action.kind !== 'communicate' || facts.proposalFact.action.content.kind !== 'offer') return null;
  return { fact: facts.proposalFact, content: facts.proposalFact.action.content };
}

export function openCollectiveOfferFor(state: SimulationState, personId: PersonId): { fact: ActionFact; content: Extract<RepresentationInput, { kind: 'offer' }> } | null {
  const agreement = [...agreementsForPerson(state, personId)].reverse().find((item) => item.status === 'proposed' && item.proposal.kind === 'collective' && item.responderId === personId && agreementResponseDeadline(item, personId) >= state.clock.elapsedMonths);
  if (!agreement) return null;
  const facts = agreementFacts(state, agreement);
  if (!facts || facts.proposalFact.action.kind !== 'communicate' || facts.proposalFact.action.content.kind !== 'offer') return null;
  return { fact: facts.proposalFact, content: facts.proposalFact.action.content };
}

export function openPermissionOfferFor(state: SimulationState, personId: PersonId): { fact: ActionFact; content: Extract<RepresentationInput, { kind: 'offer' }> } | null {
  const agreement = [...agreementsForPerson(state, personId)].reverse().find((item) => item.status === 'proposed' && item.proposal.kind === 'permission' && item.responderId === personId && agreementResponseDeadline(item, personId) >= state.clock.elapsedMonths);
  if (!agreement) return null;
  const facts = agreementFacts(state, agreement);
  if (!facts || facts.proposalFact.action.kind !== 'communicate' || facts.proposalFact.action.content.kind !== 'offer') return null;
  return { fact: facts.proposalFact, content: facts.proposalFact.action.content };
}

export function openMembershipOfferFor(state: SimulationState, personId: PersonId): { fact: ActionFact; content: Extract<RepresentationInput, { kind: 'offer' }> } | null {
  const agreement = [...agreementsForPerson(state, personId)].reverse().find((item) => item.status === 'proposed'
    && item.proposal.kind === 'membership'
    && item.requiredResponderIds.includes(personId)
    && !item.acceptedByPersonIds.includes(personId)
    && !item.rejectedByPersonIds.includes(personId)
    && agreementResponseDeadline(item, personId) >= state.clock.elapsedMonths);
  if (!agreement) return null;
  const facts = agreementFacts(state, agreement);
  if (!facts || facts.proposalFact.action.kind !== 'communicate' || facts.proposalFact.action.content.kind !== 'offer') return null;
  return { fact: facts.proposalFact, content: facts.proposalFact.action.content };
}

function openMultiMemberProposalFor(
  state: SimulationState,
  personId: PersonId,
  kind: 'decision-rule' | 'mandate',
): { fact: ActionFact; content: Extract<RepresentationInput, { kind: 'offer' }> } | null {
  const agreement = [...agreementsForPerson(state, personId)].reverse().find((item) => item.status === 'proposed'
    && item.proposal.kind === kind
    && item.requiredResponderIds.includes(personId)
    && !item.acceptedByPersonIds.includes(personId)
    && !item.rejectedByPersonIds.includes(personId)
    && agreementResponseDeadline(item, personId) >= state.clock.elapsedMonths);
  if (!agreement) return null;
  const facts = agreementFacts(state, agreement);
  if (!facts || facts.proposalFact.action.kind !== 'communicate' || facts.proposalFact.action.content.kind !== 'offer') return null;
  return { fact: facts.proposalFact, content: facts.proposalFact.action.content };
}

export function openDecisionRuleOfferFor(state: SimulationState, personId: PersonId) {
  return openMultiMemberProposalFor(state, personId, 'decision-rule');
}

export function openMandateOfferFor(state: SimulationState, personId: PersonId) {
  return openMultiMemberProposalFor(state, personId, 'mandate');
}

export function hasOpenAssistRequestBetween(state: SimulationState, requesterId: PersonId, helperId: PersonId): boolean {
  return agreementsForPerson(state, requesterId).some((agreement) => agreement.status === 'proposed'
    && agreement.proposal.kind === 'assist'
    && agreement.proposal.requesterId === requesterId
    && agreement.proposal.helperId === helperId
    && agreementResponseDeadline(agreement, helperId) >= state.clock.elapsedMonths);
}

export function hasOpenExchangeOfferBetween(state: SimulationState, offererId: PersonId, partnerId: PersonId): boolean {
  return agreementsForPerson(state, offererId).some((agreement) => agreement.status === 'proposed'
    && agreement.proposal.kind === 'exchange'
    && agreement.proposal.offererId === offererId
    && agreement.proposal.partnerId === partnerId
    && agreementResponseDeadline(agreement, partnerId) >= state.clock.elapsedMonths);
}

export function hasOpenCompanionOfferBetween(state: SimulationState, proposerId: PersonId, partnerId: PersonId): boolean {
  return agreementsForPerson(state, proposerId).some((agreement) => agreement.status === 'proposed'
    && agreement.proposal.kind === 'companion'
    && agreement.proposal.proposerId === proposerId
    && agreement.proposal.partnerId === partnerId
    && agreementResponseDeadline(agreement, partnerId) >= state.clock.elapsedMonths);
}

export function hasOpenReproductionOfferBetween(state: SimulationState, proposerId: PersonId, partnerId: PersonId): boolean {
  return agreementsForPerson(state, proposerId).some((agreement) => agreement.status === 'proposed'
    && agreement.proposal.kind === 'reproduce'
    && agreement.proposal.proposerId === proposerId
    && agreement.proposal.partnerId === partnerId
    && agreementResponseDeadline(agreement, partnerId) >= state.clock.elapsedMonths);
}

export function hasOpenCollectiveOfferBetween(state: SimulationState, proposerId: PersonId, partnerId: PersonId): boolean {
  return agreementsForPerson(state, proposerId).some((agreement) => agreement.status === 'proposed'
    && agreement.proposal.kind === 'collective'
    && agreement.proposal.proposerId === proposerId
    && agreement.proposal.partnerId === partnerId
    && agreementResponseDeadline(agreement, partnerId) >= state.clock.elapsedMonths);
}

export function hasOpenMembershipOfferFor(state: SimulationState, collectiveId: string, candidateId: PersonId): boolean {
  return agreementsForPerson(state, candidateId).some((agreement) => agreement.status === 'proposed'
    && agreement.proposal.kind === 'membership'
    && agreement.proposal.collectiveId === collectiveId
    && agreement.proposal.candidateId === candidateId
    && agreementResponseDeadline(agreement, candidateId) >= state.clock.elapsedMonths);
}

export function acceptedAssistFor(state: SimulationState, helperId: PersonId, atMonth: number): { request: ActionFact; acceptance: ActionFact; proposal: Extract<NonNullable<Extract<RepresentationInput, { kind: 'request' }>['proposal']>, { kind: 'assist' }> } | null {
  const agreement = [...agreementsForPerson(state, helperId)].reverse().find((item) => item.status === 'active'
    && item.proposal.kind === 'assist'
    && item.proposal.helperId === helperId
    && (item.acceptedAtMonth ?? Number.POSITIVE_INFINITY) <= atMonth);
  if (!agreement || agreement.proposal.kind !== 'assist') return null;
  const facts = agreementFacts(state, agreement);
  return facts?.responseFact ? { request: facts.proposalFact, acceptance: facts.responseFact, proposal: agreement.proposal } : null;
}

export function acceptedCompanionBetween(state: SimulationState, a: PersonId, b: PersonId, atMonth: number): { offer: ActionFact; acceptance: ActionFact } | null {
  const agreement = [...agreementsForPerson(state, a)].reverse().find((item) => item.status === 'active'
    && item.proposal.kind === 'companion'
    && item.partyIds.includes(a) && item.partyIds.includes(b)
    && (item.acceptedAtMonth ?? Number.POSITIVE_INFINITY) <= atMonth);
  if (!agreement) return null;
  const facts = agreementFacts(state, agreement);
  return facts?.responseFact ? { offer: facts.proposalFact, acceptance: facts.responseFact } : null;
}
