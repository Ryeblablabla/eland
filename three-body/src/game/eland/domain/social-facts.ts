import type { ActionFact, SimulationState } from './model';
import type { PersonId } from './person';
import type { RepresentationInput } from './action';
import type { Agreement } from './agreement';

export function completedCommunicationFacts(state: SimulationState): ActionFact[] {
  return state.world.past.filter((event): event is ActionFact => event.kind === 'action' && event.status === 'completed' && event.action.kind === 'communicate');
}

export function communicationById(state: SimulationState, representationId: string): ActionFact | undefined {
  return completedCommunicationFacts(state).find((event) => event.action.kind === 'communicate' && event.action.content.id === representationId);
}

export function acceptanceOf(state: SimulationState, representationId: string, byPersonId?: PersonId): ActionFact | undefined {
  return completedCommunicationFacts(state).find((event) => event.action.kind === 'communicate'
    && event.action.content.kind === 'accept'
    && event.action.content.referenceId === representationId
    && (!byPersonId || event.who === byPersonId));
}

export function rejectionOf(state: SimulationState, representationId: string, byPersonId?: PersonId): ActionFact | undefined {
  return completedCommunicationFacts(state).find((event) => event.action.kind === 'communicate'
    && event.action.content.kind === 'reject'
    && event.action.content.referenceId === representationId
    && (!byPersonId || event.who === byPersonId));
}

function communicationFact(state: SimulationState, eventId: string): ActionFact | undefined {
  const fact = state.world.past.find((event) => event.id === eventId);
  return fact?.kind === 'action' && fact.action.kind === 'communicate' ? fact : undefined;
}

function agreementFacts(state: SimulationState, agreement: Agreement): { proposalFact: ActionFact; responseFact?: ActionFact } | null {
  const proposalFact = communicationFact(state, agreement.proposalEventId);
  if (!proposalFact) return null;
  const responseFact = agreement.responseEventId ? communicationFact(state, agreement.responseEventId) : undefined;
  return { proposalFact, responseFact };
}

export function openReproductionOfferFor(state: SimulationState, personId: PersonId): { fact: ActionFact; content: Extract<RepresentationInput, { kind: 'offer' }> } | null {
  const agreement = [...state.agreements].reverse().find((item) => item.status === 'proposed' && item.proposal.kind === 'reproduce' && item.responderId === personId && item.acceptByMonth >= state.clock.elapsedMonths);
  if (!agreement) return null;
  const facts = agreementFacts(state, agreement);
  if (!facts || facts.proposalFact.action.kind !== 'communicate' || facts.proposalFact.action.content.kind !== 'offer') return null;
  return { fact: facts.proposalFact, content: facts.proposalFact.action.content };
}

export function acceptedReproductionBetween(state: SimulationState, a: PersonId, b: PersonId, atMonth: number): { offer: ActionFact; acceptance: ActionFact } | null {
  const agreement = [...state.agreements].reverse().find((item) => item.status === 'active'
    && item.proposal.kind === 'reproduce'
    && item.partyIds.includes(a) && item.partyIds.includes(b)
    && (item.acceptedAtMonth ?? Number.POSITIVE_INFINITY) <= atMonth);
  if (!agreement) return null;
  const facts = agreementFacts(state, agreement);
  return facts?.responseFact ? { offer: facts.proposalFact, acceptance: facts.responseFact } : null;
}

export function openExchangeOfferFor(state: SimulationState, personId: PersonId): { fact: ActionFact; content: Extract<RepresentationInput, { kind: 'offer' }> } | null {
  const agreement = [...state.agreements].reverse().find((item) => item.status === 'proposed' && item.proposal.kind === 'exchange' && item.responderId === personId && item.acceptByMonth >= state.clock.elapsedMonths);
  if (!agreement) return null;
  const facts = agreementFacts(state, agreement);
  if (!facts || facts.proposalFact.action.kind !== 'communicate' || facts.proposalFact.action.content.kind !== 'offer') return null;
  return { fact: facts.proposalFact, content: facts.proposalFact.action.content };
}

export function acceptedExchangeFor(state: SimulationState, personId: PersonId, atMonth: number): { offer: ActionFact; acceptance: ActionFact; proposal: Extract<NonNullable<Extract<RepresentationInput, { kind: 'offer' }>['proposal']>, { kind: 'exchange' }> } | null {
  const agreement = [...state.agreements].reverse().find((item) => item.status === 'active'
    && item.proposal.kind === 'exchange'
    && item.partyIds.includes(personId)
    && (item.acceptedAtMonth ?? Number.POSITIVE_INFINITY) <= atMonth);
  if (!agreement || agreement.proposal.kind !== 'exchange') return null;
  const facts = agreementFacts(state, agreement);
  return facts?.responseFact ? { offer: facts.proposalFact, acceptance: facts.responseFact, proposal: agreement.proposal } : null;
}

export function exchangeTermFulfilled(state: SimulationState, offerId: string, fromPersonId: PersonId): boolean {
  return state.agreements.find((agreement) => agreement.id === offerId)?.fulfilledByPersonIds.includes(fromPersonId) ?? false;
}

export function openAssistRequestFor(state: SimulationState, personId: PersonId): { fact: ActionFact; content: Extract<RepresentationInput, { kind: 'request' }> } | null {
  const agreement = [...state.agreements].reverse().find((item) => item.status === 'proposed' && item.proposal.kind === 'assist' && item.responderId === personId && item.acceptByMonth >= state.clock.elapsedMonths);
  if (!agreement) return null;
  const facts = agreementFacts(state, agreement);
  if (!facts || facts.proposalFact.action.kind !== 'communicate' || facts.proposalFact.action.content.kind !== 'request') return null;
  return { fact: facts.proposalFact, content: facts.proposalFact.action.content };
}

export function openCompanionOfferFor(state: SimulationState, personId: PersonId): { fact: ActionFact; content: Extract<RepresentationInput, { kind: 'offer' }> } | null {
  const agreement = [...state.agreements].reverse().find((item) => item.status === 'proposed' && item.proposal.kind === 'companion' && item.responderId === personId && item.acceptByMonth >= state.clock.elapsedMonths);
  if (!agreement) return null;
  const facts = agreementFacts(state, agreement);
  if (!facts || facts.proposalFact.action.kind !== 'communicate' || facts.proposalFact.action.content.kind !== 'offer') return null;
  return { fact: facts.proposalFact, content: facts.proposalFact.action.content };
}

export function openCollectiveOfferFor(state: SimulationState, personId: PersonId): { fact: ActionFact; content: Extract<RepresentationInput, { kind: 'offer' }> } | null {
  const agreement = [...state.agreements].reverse().find((item) => item.status === 'proposed' && item.proposal.kind === 'collective' && item.responderId === personId && item.acceptByMonth >= state.clock.elapsedMonths);
  if (!agreement) return null;
  const facts = agreementFacts(state, agreement);
  if (!facts || facts.proposalFact.action.kind !== 'communicate' || facts.proposalFact.action.content.kind !== 'offer') return null;
  return { fact: facts.proposalFact, content: facts.proposalFact.action.content };
}

export function hasOpenAssistRequestBetween(state: SimulationState, requesterId: PersonId, helperId: PersonId): boolean {
  return state.agreements.some((agreement) => agreement.status === 'proposed'
    && agreement.proposal.kind === 'assist'
    && agreement.proposal.requesterId === requesterId
    && agreement.proposal.helperId === helperId
    && agreement.acceptByMonth >= state.clock.elapsedMonths);
}

export function hasOpenCompanionOfferBetween(state: SimulationState, proposerId: PersonId, partnerId: PersonId): boolean {
  return state.agreements.some((agreement) => agreement.status === 'proposed'
    && agreement.proposal.kind === 'companion'
    && agreement.proposal.proposerId === proposerId
    && agreement.proposal.partnerId === partnerId
    && agreement.acceptByMonth >= state.clock.elapsedMonths);
}

export function hasOpenCollectiveOfferBetween(state: SimulationState, proposerId: PersonId, partnerId: PersonId): boolean {
  return state.agreements.some((agreement) => agreement.status === 'proposed'
    && agreement.proposal.kind === 'collective'
    && agreement.proposal.proposerId === proposerId
    && agreement.proposal.partnerId === partnerId
    && agreement.acceptByMonth >= state.clock.elapsedMonths);
}

export function acceptedAssistFor(state: SimulationState, helperId: PersonId, atMonth: number): { request: ActionFact; acceptance: ActionFact; proposal: Extract<NonNullable<Extract<RepresentationInput, { kind: 'request' }>['proposal']>, { kind: 'assist' }> } | null {
  const agreement = [...state.agreements].reverse().find((item) => item.status === 'active'
    && item.proposal.kind === 'assist'
    && item.proposal.helperId === helperId
    && (item.acceptedAtMonth ?? Number.POSITIVE_INFINITY) <= atMonth);
  if (!agreement || agreement.proposal.kind !== 'assist') return null;
  const facts = agreementFacts(state, agreement);
  return facts?.responseFact ? { request: facts.proposalFact, acceptance: facts.responseFact, proposal: agreement.proposal } : null;
}

export function acceptedCompanionBetween(state: SimulationState, a: PersonId, b: PersonId, atMonth: number): { offer: ActionFact; acceptance: ActionFact } | null {
  const agreement = [...state.agreements].reverse().find((item) => item.status === 'active'
    && item.proposal.kind === 'companion'
    && item.partyIds.includes(a) && item.partyIds.includes(b)
    && (item.acceptedAtMonth ?? Number.POSITIVE_INFINITY) <= atMonth);
  if (!agreement) return null;
  const facts = agreementFacts(state, agreement);
  return facts?.responseFact ? { offer: facts.proposalFact, acceptance: facts.responseFact } : null;
}
