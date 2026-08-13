import type { ActionFact, SimulationState } from './model';
import type { PersonId } from './person';
import type { RepresentationInput } from './action';

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

export function openReproductionOfferFor(state: SimulationState, personId: PersonId): { fact: ActionFact; content: Extract<RepresentationInput, { kind: 'offer' }> } | null {
  const atMonth = state.clock.elapsedMonths;
  for (const fact of [...completedCommunicationFacts(state)].reverse()) {
    if (fact.action.kind !== 'communicate' || fact.action.content.kind !== 'offer') continue;
    const content = fact.action.content;
    const proposal = content.proposal;
    if (proposal?.kind !== 'reproduce' || proposal.partnerId !== personId || proposal.expiresAtMonth < atMonth) continue;
    if (acceptanceOf(state, content.id, personId) || rejectionOf(state, content.id, personId)) continue;
    return { fact, content };
  }
  return null;
}

export function acceptedReproductionBetween(state: SimulationState, a: PersonId, b: PersonId, atMonth: number): { offer: ActionFact; acceptance: ActionFact } | null {
  for (const offer of [...completedCommunicationFacts(state)].reverse()) {
    if (offer.action.kind !== 'communicate' || offer.action.content.kind !== 'offer') continue;
    const proposal = offer.action.content.proposal;
    if (proposal?.kind !== 'reproduce' || proposal.expiresAtMonth < atMonth) continue;
    const samePair = (proposal.proposerId === a && proposal.partnerId === b) || (proposal.proposerId === b && proposal.partnerId === a);
    if (!samePair) continue;
    const acceptance = acceptanceOf(state, offer.action.content.id, proposal.partnerId);
    if (acceptance && acceptance.atMonth <= atMonth) return { offer, acceptance };
  }
  return null;
}

export function openExchangeOfferFor(state: SimulationState, personId: PersonId): { fact: ActionFact; content: Extract<RepresentationInput, { kind: 'offer' }> } | null {
  const atMonth = state.clock.elapsedMonths;
  for (const fact of [...completedCommunicationFacts(state)].reverse()) {
    if (fact.action.kind !== 'communicate' || fact.action.content.kind !== 'offer') continue;
    const content = fact.action.content;
    const proposal = content.proposal;
    if (proposal?.kind !== 'exchange' || proposal.partnerId !== personId || proposal.expiresAtMonth < atMonth) continue;
    if (acceptanceOf(state, content.id, personId) || rejectionOf(state, content.id, personId)) continue;
    return { fact, content };
  }
  return null;
}

export function acceptedExchangeFor(state: SimulationState, personId: PersonId, atMonth: number): { offer: ActionFact; acceptance: ActionFact; proposal: Extract<NonNullable<Extract<RepresentationInput, { kind: 'offer' }>['proposal']>, { kind: 'exchange' }> } | null {
  for (const offer of [...completedCommunicationFacts(state)].reverse()) {
    if (offer.action.kind !== 'communicate' || offer.action.content.kind !== 'offer') continue;
    const proposal = offer.action.content.proposal;
    if (proposal?.kind !== 'exchange' || proposal.expiresAtMonth < atMonth || (proposal.offererId !== personId && proposal.partnerId !== personId)) continue;
    const acceptance = acceptanceOf(state, offer.action.content.id, proposal.partnerId);
    if (acceptance) return { offer, acceptance, proposal };
  }
  return null;
}

export function exchangeTermFulfilled(state: SimulationState, offerId: string, fromPersonId: PersonId): boolean {
  return state.world.past.some((event) => event.kind === 'action'
    && event.status === 'completed'
    && event.action.kind === 'transfer'
    && event.action.authorizationRef === offerId
    && event.action.from.kind === 'person'
    && event.action.from.personId === fromPersonId);
}

export function openAssistRequestFor(state: SimulationState, personId: PersonId): { fact: ActionFact; content: Extract<RepresentationInput, { kind: 'request' }> } | null {
  const atMonth = state.clock.elapsedMonths;
  for (const fact of [...completedCommunicationFacts(state)].reverse()) {
    if (fact.action.kind !== 'communicate' || fact.action.content.kind !== 'request') continue;
    const content = fact.action.content;
    const proposal = content.proposal;
    if (proposal?.kind !== 'assist' || proposal.helperId !== personId || proposal.expiresAtMonth < atMonth) continue;
    if (acceptanceOf(state, content.id, personId) || rejectionOf(state, content.id, personId)) continue;
    return { fact, content };
  }
  return null;
}

export function openCompanionOfferFor(state: SimulationState, personId: PersonId): { fact: ActionFact; content: Extract<RepresentationInput, { kind: 'offer' }> } | null {
  const atMonth = state.clock.elapsedMonths;
  for (const fact of [...completedCommunicationFacts(state)].reverse()) {
    if (fact.action.kind !== 'communicate' || fact.action.content.kind !== 'offer') continue;
    const content = fact.action.content;
    const proposal = content.proposal;
    if (proposal?.kind !== 'companion' || proposal.partnerId !== personId || proposal.expiresAtMonth < atMonth) continue;
    if (acceptanceOf(state, content.id, personId) || rejectionOf(state, content.id, personId)) continue;
    return { fact, content };
  }
  return null;
}

export function hasOpenAssistRequestBetween(state: SimulationState, requesterId: PersonId, helperId: PersonId): boolean {
  const atMonth = state.clock.elapsedMonths;
  return completedCommunicationFacts(state).some((fact) => {
    if (fact.action.kind !== 'communicate' || fact.action.content.kind !== 'request') return false;
    const content = fact.action.content;
    const proposal = content.proposal;
    return proposal?.kind === 'assist'
      && proposal.requesterId === requesterId
      && proposal.helperId === helperId
      && proposal.expiresAtMonth >= atMonth
      && !acceptanceOf(state, content.id, helperId)
      && !rejectionOf(state, content.id, helperId);
  });
}

export function hasOpenCompanionOfferBetween(state: SimulationState, proposerId: PersonId, partnerId: PersonId): boolean {
  const atMonth = state.clock.elapsedMonths;
  return completedCommunicationFacts(state).some((fact) => {
    if (fact.action.kind !== 'communicate' || fact.action.content.kind !== 'offer') return false;
    const content = fact.action.content;
    const proposal = content.proposal;
    return proposal?.kind === 'companion'
      && proposal.proposerId === proposerId
      && proposal.partnerId === partnerId
      && proposal.expiresAtMonth >= atMonth
      && !acceptanceOf(state, content.id, partnerId)
      && !rejectionOf(state, content.id, partnerId);
  });
}

export function acceptedAssistFor(state: SimulationState, helperId: PersonId, atMonth: number): { request: ActionFact; acceptance: ActionFact; proposal: Extract<NonNullable<Extract<RepresentationInput, { kind: 'request' }>['proposal']>, { kind: 'assist' }> } | null {
  for (const request of [...completedCommunicationFacts(state)].reverse()) {
    if (request.action.kind !== 'communicate' || request.action.content.kind !== 'request') continue;
    const proposal = request.action.content.proposal;
    if (proposal?.kind !== 'assist' || proposal.helperId !== helperId || proposal.expiresAtMonth < atMonth) continue;
    const acceptance = acceptanceOf(state, request.action.content.id, helperId);
    if (acceptance) return { request, acceptance, proposal };
  }
  return null;
}

export function acceptedCompanionBetween(state: SimulationState, a: PersonId, b: PersonId, atMonth: number): { offer: ActionFact; acceptance: ActionFact } | null {
  for (const offer of [...completedCommunicationFacts(state)].reverse()) {
    if (offer.action.kind !== 'communicate' || offer.action.content.kind !== 'offer') continue;
    const proposal = offer.action.content.proposal;
    if (proposal?.kind !== 'companion' || proposal.expiresAtMonth < atMonth) continue;
    const samePair = (proposal.proposerId === a && proposal.partnerId === b) || (proposal.proposerId === b && proposal.partnerId === a);
    if (!samePair) continue;
    const acceptance = acceptanceOf(state, offer.action.content.id, proposal.partnerId);
    if (acceptance) return { offer, acceptance };
  }
  return null;
}
