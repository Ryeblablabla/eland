import type { SocialProposal } from './action';
import type { ActionFact, SimulationState } from './model';
import type { PersonId } from './person';
import { isAlive } from './person';
import { agreementById, type Agreement } from './agreement';
import type { DecisionRule, Mandate } from './governance';
import { livingPeople, personById } from './state-index';

export type MembershipStatus = 'active' | 'withdrawn' | 'ended';

export interface MembershipFact {
  id: string;
  collectiveId: string;
  personId: PersonId;
  status: MembershipStatus;
  joinedAtMonth: number;
  endedAtMonth?: number;
  sourceEventIds: string[];
}

export interface CollectiveState {
  id: string;
  purposeSummary: string;
  status: 'active' | 'dormant' | 'dissolved';
  foundedAtMonth: number;
  formationAgreementId: string;
  memberships: MembershipFact[];
  decisionRules: DecisionRule[];
  mandates: Mandate[];
  sourceEventIds: string[];
}

function membership(collectiveId: string, personId: PersonId, atMonth: number, sourceEventIds: string[]): MembershipFact {
  return {
    id: `membership:${collectiveId}:${personId}:${atMonth}`,
    collectiveId,
    personId,
    status: 'active',
    joinedAtMonth: atMonth,
    sourceEventIds: [...sourceEventIds],
  };
}

function proposalOf<T extends SocialProposal['kind']>(state: SimulationState, referenceId: string, kind: T): (Agreement & { proposal: Extract<SocialProposal, { kind: T }> }) | undefined {
  const agreement = agreementById(state, referenceId);
  return agreement?.status === 'active' && agreement.proposal.kind === kind
    ? agreement as Agreement & { proposal: Extract<SocialProposal, { kind: T }> }
    : undefined;
}

export function activeMembership(collective: CollectiveState, personId: PersonId): MembershipFact | undefined {
  return collective.memberships.find((item) => item.personId === personId && item.status === 'active');
}

export function activeCollectivesFor(state: SimulationState, personId: PersonId): CollectiveState[] {
  return state.collectives.filter((collective) => collective.status !== 'dissolved' && activeMembership(collective, personId));
}

export function activeMemberIds(state: SimulationState, collective: CollectiveState): PersonId[] {
  const livingIds = new Set(livingPeople(state).map((person) => person.id));
  return collective.memberships
    .filter((item) => item.status === 'active' && livingIds.has(item.personId))
    .map((item) => item.personId);
}

function updateStatus(state: SimulationState, collective: CollectiveState): void {
  const count = activeMemberIds(state, collective).length;
  collective.status = count >= 2 ? 'active' : count === 1 ? 'dormant' : 'dissolved';
}

/** Communication creates normative membership facts; the collective never acts by itself. */
export function recordCollectiveAction(state: SimulationState, fact: ActionFact): void {
  if (fact.status !== 'completed' || fact.action.kind !== 'communicate') return;
  const content = fact.action.content;
  if (content.kind === 'accept') {
    const formation = proposalOf(state, content.referenceId, 'collective');
    if (formation?.proposal.kind === 'collective') {
      const id = `collective:${formation.id}`;
      if (state.collectives.some((collective) => collective.id === id)) return;
      const sourceEventIds = [...new Set([...formation.sourceEventIds, fact.id])];
      state.collectives.push({
        id,
        purposeSummary: formation.proposal.purposeSummary,
        status: 'active',
        foundedAtMonth: fact.atMonth,
        formationAgreementId: formation.id,
        memberships: formation.partyIds.map((personId) => membership(id, personId, fact.atMonth, sourceEventIds)),
        decisionRules: [],
        mandates: [],
        sourceEventIds,
      });
      formation.status = 'fulfilled';
      formation.resolvedAtMonth = fact.atMonth;
      formation.fulfillmentEventIds = [...new Set([...formation.fulfillmentEventIds, fact.id])];
      formation.fulfilledByPersonIds = [...formation.partyIds];
      return;
    }
    const admission = proposalOf(state, content.referenceId, 'membership');
    if (admission?.proposal.kind === 'membership') {
      const proposal = admission.proposal;
      const collective = state.collectives.find((candidate) => candidate.id === proposal.collectiveId);
      const currentMemberIds = collective ? activeMemberIds(state, collective) : [];
      const expectedApprovers = new Set([...currentMemberIds.filter((id) => id !== proposal.proposerId), proposal.candidateId]);
      const proposedApprovers = new Set(proposal.requiredApproverIds);
      const candidate = livingPeople(state).find((person) => person.id === proposal.candidateId);
      const valid = Boolean(collective
        && collective.status !== 'dissolved'
        && activeMembership(collective, proposal.proposerId)
        && !activeMembership(collective, proposal.candidateId)
        && candidate
        && expectedApprovers.size === proposedApprovers.size
        && [...expectedApprovers].every((id) => proposedApprovers.has(id))
        && [...expectedApprovers].every((id) => admission.acceptedByPersonIds.includes(id)));
      if (!valid || !collective) return;
      const sourceEventIds = [...new Set([...admission.sourceEventIds, fact.id])];
      collective.memberships.push(membership(collective.id, proposal.candidateId, fact.atMonth, sourceEventIds));
      collective.sourceEventIds = [...new Set([...collective.sourceEventIds, ...sourceEventIds])];
      updateStatus(state, collective);
      admission.status = 'fulfilled';
      admission.resolvedAtMonth = fact.atMonth;
      admission.fulfillmentEventIds = [...new Set([...admission.fulfillmentEventIds, fact.id])];
      admission.fulfilledByPersonIds = [...admission.partyIds];
      return;
    }
  }
  if (content.kind !== 'withdraw') return;
  const collective = state.collectives.find((candidate) => candidate.id === content.collectiveId);
  const current = collective && activeMembership(collective, fact.who);
  if (!collective || !current) return;
  current.status = 'withdrawn';
  current.endedAtMonth = fact.atMonth;
  current.sourceEventIds = [...new Set([...current.sourceEventIds, fact.id])];
  collective.sourceEventIds = [...new Set([...collective.sourceEventIds, fact.id])];
  updateStatus(state, collective);
}

/** Death ends participation but does not erase the historical membership. */
export function advanceCollectiveLifecycle(state: SimulationState, atMonth: number): void {
  for (const collective of state.collectives) {
    for (const item of collective.memberships.filter((candidate) => candidate.status === 'active')) {
      const person = personById(state, item.personId);
      if (person && isAlive(person)) continue;
      item.status = 'ended';
      item.endedAtMonth = atMonth;
      const death = [...state.world.past].reverse().find((event) => event.kind === 'environment' && event.change === 'death' && event.who === item.personId);
      if (death) item.sourceEventIds = [...new Set([...item.sourceEventIds, death.id])];
    }
    updateStatus(state, collective);
  }
}
