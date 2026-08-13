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

export function openReproductionOfferFor(state: SimulationState, personId: PersonId): { fact: ActionFact; content: Extract<RepresentationInput, { kind: 'offer' }> } | null {
  const atMonth = state.clock.elapsedMonths;
  for (const fact of [...completedCommunicationFacts(state)].reverse()) {
    if (fact.action.kind !== 'communicate' || fact.action.content.kind !== 'offer') continue;
    const content = fact.action.content;
    const proposal = content.proposal;
    if (proposal?.kind !== 'reproduce' || proposal.partnerId !== personId || proposal.expiresAtMonth < atMonth) continue;
    if (acceptanceOf(state, content.id, personId)) continue;
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
