import type { PrimitiveAction, SocialProposal } from './action';
import type { ActionFact, AgreementFact, SimulationState } from './model';
import type { PersonId } from './person';
import { isAlive } from './person';
import { applyRelationEvidence } from './relation';
import { Material, materialHas } from './material';
import { neighbors4, surfaceMaterial, voxelAt } from '../world/grid';

export type AgreementStatus = 'proposed' | 'active' | 'fulfilled' | 'rejected' | 'expired' | 'breached' | 'cancelled';

export interface Agreement {
  id: string;
  proposal: SocialProposal;
  proposerId: PersonId;
  responderId: PersonId;
  partyIds: PersonId[];
  status: AgreementStatus;
  proposedAtMonth: number;
  acceptByMonth: number;
  acceptedAtMonth?: number;
  dueAtMonth?: number;
  resolvedAtMonth?: number;
  proposalEventId: string;
  responseEventId?: string;
  fulfillmentEventIds: string[];
  fulfilledByPersonIds: PersonId[];
  coLocatedMonths: number;
  sourceEventIds: string[];
}

function parties(proposal: SocialProposal): { proposerId: PersonId; responderId: PersonId } {
  if (proposal.kind === 'assist') return { proposerId: proposal.requesterId, responderId: proposal.helperId };
  if (proposal.kind === 'exchange') return { proposerId: proposal.offererId, responderId: proposal.partnerId };
  return { proposerId: proposal.proposerId, responderId: proposal.partnerId };
}

function duration(proposal: SocialProposal): number {
  if (proposal.kind === 'companion') return 24;
  if (proposal.kind === 'collective') return 1;
  if (proposal.kind === 'exchange') return 12;
  if (proposal.kind === 'assist') return 6;
  return 4;
}

export function agreementById(state: SimulationState, id: string): Agreement | undefined {
  return state.agreements.find((agreement) => agreement.id === id);
}

/** An agreement authorizes only the concrete transfer promised by its terms. */
export function agreementAuthorizesTransfer(
  agreement: Agreement | undefined,
  actorId: PersonId,
  action: Extract<PrimitiveAction, { kind: 'transfer' }>,
  actualQuantity = action.quantity,
): boolean {
  if (!agreement || agreement.status !== 'active' || action.from.kind !== 'person' || action.to.kind !== 'person') return false;
  if (action.from.personId !== actorId || actualQuantity <= 0) return false;
  if (agreement.proposal.kind === 'assist') return agreement.proposal.need === 'food'
    && actorId === agreement.proposal.helperId
    && action.to.personId === agreement.proposal.requesterId
    && materialHas(action.materialId, 'edible');
  if (agreement.proposal.kind !== 'exchange') return false;
  const term = actorId === agreement.proposal.offererId
    ? { receiverId: agreement.proposal.partnerId, materialId: agreement.proposal.offererMaterialId, quantity: agreement.proposal.offererQuantity }
    : actorId === agreement.proposal.partnerId
      ? { receiverId: agreement.proposal.offererId, materialId: agreement.proposal.partnerMaterialId, quantity: agreement.proposal.partnerQuantity }
      : undefined;
  return Boolean(term
    && action.to.personId === term.receiverId
    && action.materialId === term.materialId
    && actualQuantity >= term.quantity);
}

export function recordAgreementAction(state: SimulationState, fact: ActionFact): void {
  if (fact.status !== 'completed') return;
  const action = fact.action;
  const waterAssistance = state.agreements.find((agreement) => agreement.status === 'active'
    && agreement.proposal.kind === 'assist'
    && agreement.proposal.need === 'water'
    && agreement.partyIds.includes(fact.who));
  if (waterAssistance?.proposal.kind === 'assist') {
    const proposal = waterAssistance.proposal;
    const helper = state.people.find((candidate) => candidate.id === proposal.helperId && isAlive(candidate));
    const requester = state.people.find((candidate) => candidate.id === proposal.requesterId && isAlive(candidate));
    const helperReachedWater = fact.who === proposal.helperId && (
      (action.kind === 'move' && neighbors4(fact.cellId).some((cell) => surfaceMaterial(state.world.grid, cell) === Material.Water))
      || (action.kind === 'communicate' && action.audience.includes(proposal.requesterId) && neighbors4(fact.cellId).some((cell) => surfaceMaterial(state.world.grid, cell) === Material.Water))
      || (action.kind === 'attend' && action.target.kind === 'voxel' && voxelAt(state.world.grid, action.target.position.x, action.target.position.y, action.target.position.z) === Material.Water)
    );
    const materialId = Number(fact.diff.materialId);
    const requesterDrank = fact.who === proposal.requesterId
      && action.kind === 'act'
      && action.operation === 'ingest'
      && Number.isFinite(materialId)
      && materialHas(materialId, 'drinkable')
      && Number(fact.diff.hydration ?? 0) > 0;
    if (helperReachedWater || requesterDrank) {
      const contributorId = helperReachedWater ? proposal.helperId : proposal.requesterId;
      if (!waterAssistance.fulfilledByPersonIds.includes(contributorId)) waterAssistance.fulfilledByPersonIds.push(contributorId);
      if (!waterAssistance.fulfillmentEventIds.includes(fact.id)) waterAssistance.fulfillmentEventIds.push(fact.id);
      if (!waterAssistance.sourceEventIds.includes(fact.id)) waterAssistance.sourceEventIds.push(fact.id);
      const helperArrival = waterAssistance.fulfillmentEventIds
        .flatMap((eventId) => state.world.past.filter((event) => event.id === eventId && event.kind === 'action'))
        .find((event) => event.kind === 'action' && event.who === proposal.helperId);
      if (helper && requester
        && (helper.position.cellId === requester.position.cellId || helperArrival?.cellId === fact.cellId)
        && waterAssistance.fulfilledByPersonIds.includes(proposal.helperId)
        && waterAssistance.fulfilledByPersonIds.includes(proposal.requesterId)) {
        fulfill(state, waterAssistance, fact);
        return;
      }
    }
  }
  if (action.kind === 'communicate') {
    const content = action.content;
    if ((content.kind === 'request' || content.kind === 'offer') && content.proposal && !agreementById(state, content.id)) {
      const pair = parties(content.proposal);
      const intentSources = fact.intentId
        ? state.intents.find((intent) => intent.id === fact.intentId)?.sourceFactIds ?? []
        : [];
      state.agreements.push({
        id: content.id,
        proposal: structuredClone(content.proposal),
        ...pair,
        partyIds: [pair.proposerId, pair.responderId],
        status: 'proposed',
        proposedAtMonth: fact.atMonth,
        acceptByMonth: content.proposal.expiresAtMonth,
        proposalEventId: fact.id,
        fulfillmentEventIds: [],
        fulfilledByPersonIds: [],
        coLocatedMonths: 0,
        sourceEventIds: [...new Set([...intentSources, fact.id])],
      });
      return;
    }
    if (content.kind !== 'accept' && content.kind !== 'reject') return;
    const agreement = agreementById(state, content.referenceId);
    if (!agreement || agreement.status !== 'proposed' || agreement.responderId !== fact.who || fact.atMonth > agreement.acceptByMonth) return;
    agreement.status = content.kind === 'accept' ? 'active' : 'rejected';
    agreement.responseEventId = fact.id;
    agreement.sourceEventIds.push(fact.id);
    if (content.kind === 'accept') {
      agreement.acceptedAtMonth = fact.atMonth;
      agreement.dueAtMonth = fact.atMonth + duration(agreement.proposal);
    } else agreement.resolvedAtMonth = fact.atMonth;
    return;
  }

  if (action.kind === 'transfer' && action.authorizationRef) {
    const agreement = agreementById(state, action.authorizationRef);
    if (!agreement || !agreementAuthorizesTransfer(agreement, fact.who, action, Number(fact.diff.quantity))) return;
    agreement.fulfillmentEventIds.push(fact.id);
    agreement.sourceEventIds.push(fact.id);
    if (action.from.kind === 'person' && !agreement.fulfilledByPersonIds.includes(action.from.personId)) agreement.fulfilledByPersonIds.push(action.from.personId);
    const fulfilled = agreement.proposal.kind === 'assist'
      ? action.from.kind === 'person' && action.from.personId === agreement.proposal.helperId && action.to.kind === 'person' && action.to.personId === agreement.proposal.requesterId
      : agreement.proposal.kind === 'exchange' && agreement.partyIds.every((personId) => agreement.fulfilledByPersonIds.includes(personId));
    if (fulfilled) fulfill(state, agreement, fact);
    return;
  }

  if (action.kind === 'act' && action.operation === 'reproduce') {
    const target = action.targets.find((item) => item.kind === 'person');
    if (!target || target.kind !== 'person') return;
    const agreement = state.agreements.find((item) => item.status === 'active'
      && item.proposal.kind === 'reproduce'
      && item.partyIds.includes(fact.who)
      && item.partyIds.includes(target.personId));
    if (agreement) fulfill(state, agreement, fact);
    return;
  }

}

function fulfill(state: SimulationState, agreement: Agreement, fact: ActionFact): void {
  agreement.status = 'fulfilled';
  agreement.resolvedAtMonth = fact.atMonth;
  if (!agreement.fulfillmentEventIds.includes(fact.id)) agreement.fulfillmentEventIds.push(fact.id);
  if (!agreement.sourceEventIds.includes(fact.id)) agreement.sourceEventIds.push(fact.id);
  const trust = agreement.proposal.kind === 'assist' ? 8 : agreement.proposal.kind === 'exchange' ? 5 : 2;
  for (const personId of agreement.partyIds) {
    const person = state.people.find((candidate) => candidate.id === personId);
    const otherId = agreement.partyIds.find((candidate) => candidate !== personId);
    if (person && otherId) applyRelationEvidence(person, otherId, fact.id, { trust, bond: 3 });
  }
}

function agreementFact(agreement: Agreement, atMonth: number, orderInMonth: number, change: AgreementFact['change'], result: string): AgreementFact {
  return {
    id: `e-${atMonth}-agreement-${change}-${agreement.id}`,
    kind: 'agreement', atMonth, orderInMonth, cellId: 0,
    agreementId: agreement.id, change, partyIds: [...agreement.partyIds], result,
  };
}

export function advanceAgreementLifecycle(state: SimulationState, atMonth: number, orderOffset = 0): AgreementFact[] {
  const events: AgreementFact[] = [];
  for (const agreement of state.agreements) {
    if (agreement.status === 'proposed' && atMonth > agreement.acceptByMonth) {
      agreement.status = 'expired';
      agreement.resolvedAtMonth = atMonth;
      const fact = agreementFact(agreement, atMonth, orderOffset + events.length, 'expired', '一项未被回应的提议已经过期');
      agreement.sourceEventIds.push(fact.id);
      events.push(fact);
      continue;
    }
    if (agreement.status !== 'active') continue;
    const livingParties = agreement.partyIds.every((id) => {
      const person = state.people.find((candidate) => candidate.id === id);
      return person ? isAlive(person) : false;
    });
    if (!livingParties) {
      agreement.status = 'cancelled';
      agreement.resolvedAtMonth = atMonth;
      const fact = agreementFact(agreement, atMonth, orderOffset + events.length, 'cancelled', '一项约定因参与者死亡而失去可履行性');
      agreement.sourceEventIds.push(fact.id);
      events.push(fact);
      continue;
    }
    if (agreement.proposal.kind === 'companion') {
      const [first, second] = agreement.partyIds.map((id) => state.people.find((candidate) => candidate.id === id));
      if (first && second && first.position.cellId === second.position.cellId) agreement.coLocatedMonths = (agreement.coLocatedMonths ?? 0) + 1;
    }
    if ((agreement.dueAtMonth ?? Number.POSITIVE_INFINITY) >= atMonth) continue;
    if (agreement.proposal.kind === 'companion' && agreement.coLocatedMonths >= 12) {
      agreement.status = 'fulfilled';
      agreement.resolvedAtMonth = atMonth;
      const fact = agreementFact(agreement, atMonth, orderOffset + events.length, 'fulfilled', `双方在约定期内共同停留了 ${agreement.coLocatedMonths} 个月`);
      agreement.sourceEventIds.push(fact.id);
      for (const personId of agreement.partyIds) {
        const person = state.people.find((candidate) => candidate.id === personId);
        const otherId = agreement.partyIds.find((candidate) => candidate !== personId);
        if (person && otherId) applyRelationEvidence(person, otherId, fact.id, { trust: 3, bond: 5 });
      }
      events.push(fact);
      continue;
    }
    agreement.status = 'breached';
    agreement.resolvedAtMonth = atMonth;
    const fact = agreementFact(agreement, atMonth, orderOffset + events.length, 'breached', '一项已接受的约定超过期限仍未履行');
    agreement.sourceEventIds.push(fact.id);
    const debtors = agreement.proposal.kind === 'assist'
      ? [agreement.proposal.helperId]
      : agreement.proposal.kind === 'exchange'
        ? agreement.partyIds.filter((id) => !agreement.fulfilledByPersonIds.includes(id))
        : agreement.partyIds;
    for (const creditorId of agreement.partyIds.filter((id) => !debtors.includes(id))) {
      const creditor = state.people.find((candidate) => candidate.id === creditorId);
      for (const debtorId of debtors) if (creditor) applyRelationEvidence(creditor, debtorId, fact.id, { trust: -10, bond: -3 });
    }
    events.push(fact);
  }
  return events;
}
