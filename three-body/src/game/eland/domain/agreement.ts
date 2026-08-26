import type { PrimitiveAction, SocialProposal } from './action';
import type { ActionFact, AgreementFact, SimulationState, WorldEvent } from './model';
import type { PersonId } from './person';
import { isAlive, sameLocation } from './person';
import { applyRelationEvidence } from './relation';
import { Material, materialHas } from './material';
import { neighbors4, surfaceMaterial, voxelAt } from '../world/grid';
import { REPRODUCTION_CONSENT_WINDOW_MONTHS } from './population-capacity';
import { completedActionFactsForPerson, worldEventById } from './event-index';
import {
  agreementsRequiringLifecycle,
  agreementsRequiringResponseDeadlineSynchronization,
  intentById,
  personById,
} from './state-index';
import {
  companionSharesLivingArea,
  REQUIRED_SHARED_LIVING_MONTHS,
  SHARED_LIVING_RADIUS,
} from './shared-living';
import {
  recordAgreementBreachSocialLearning,
  recordAgreementFulfillmentSocialLearning,
  recordAgreementNoResponseSocialLearning,
  recordAgreementResponseSocialLearning,
} from './social-learning';

export type AgreementStatus = 'proposed' | 'active' | 'fulfilled' | 'rejected' | 'expired' | 'breached' | 'cancelled';

export interface ResponseDeadlineSuspensionFact {
  kind: 'pause' | 'resume';
  responderId: PersonId;
  hibernationConditionId: string;
  atMonth: number;
  /**
   * The first month whose response clock is frozen.  This can predate the
   * observation fact when an older save is restored with an episode already
   * in progress.
   */
  effectiveFromMonth?: number;
  eventId: string;
  sourceEventIds: string[];
}

export interface Agreement {
  id: string;
  proposal: SocialProposal;
  proposerId: PersonId;
  responderId: PersonId;
  partyIds: PersonId[];
  requiredResponderIds: PersonId[];
  acceptedByPersonIds: PersonId[];
  rejectedByPersonIds: PersonId[];
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
  /** Completed reproduce actions made under this bounded consent window. */
  reproductionAttemptEventIds?: string[];
  /** Enforces at most one reproductive probability sample per calendar month. */
  lastReproductionAttemptAtMonth?: number;
  /** Persisted field name kept for save compatibility; now counts months in the shared living area. */
  coLocatedMonths: number;
  /** The companionship stays active after this sourced establishment fact. */
  companionEstablishedAtMonth?: number;
  /** Latest calendar month when every living party was actually inside the agreed living area. */
  lastCompanionCoLocatedAtMonth?: number;
  /** Last cumulative shared-living month already converted into relationship evidence. */
  lastCompanionRelationshipAtCoLocatedMonth?: number;
  sourceEventIds: string[];
  /** Append-only clock facts; the proposal's original acceptByMonth is immutable. */
  responseDeadlineSuspensions?: ResponseDeadlineSuspensionFact[];
}

function responseDeadlineSuspensionState(
  agreement: Agreement,
  responderId: PersonId,
): { extensionMonths: number; openConditionIds: Set<string> } {
  const pausedAtByCondition = new Map<string, number>();
  let extensionMonths = 0;
  for (const fact of agreement.responseDeadlineSuspensions ?? []) {
    if (fact.responderId !== responderId) continue;
    if (fact.kind === 'pause') {
      if (!pausedAtByCondition.has(fact.hibernationConditionId)) {
        pausedAtByCondition.set(
          fact.hibernationConditionId,
          fact.effectiveFromMonth ?? fact.atMonth,
        );
      }
      continue;
    }
    const pausedAtMonth = pausedAtByCondition.get(fact.hibernationConditionId);
    if (pausedAtMonth === undefined) continue;
    extensionMonths += Math.max(0, fact.atMonth - pausedAtMonth);
    pausedAtByCondition.delete(fact.hibernationConditionId);
  }
  return { extensionMonths, openConditionIds: new Set(pausedAtByCondition.keys()) };
}

export function agreementResponseDeadline(agreement: Agreement, responderId: PersonId): number {
  const suspension = responseDeadlineSuspensionState(agreement, responderId);
  return suspension.openConditionIds.size > 0
    ? Number.POSITIVE_INFINITY
    : agreement.acceptByMonth + suspension.extensionMonths;
}

function parties(proposal: SocialProposal): { proposerId: PersonId; responderId: PersonId; requiredResponderIds: PersonId[] } {
  if (proposal.kind === 'assist') return { proposerId: proposal.requesterId, responderId: proposal.helperId, requiredResponderIds: [proposal.helperId] };
  if (proposal.kind === 'exchange') return { proposerId: proposal.offererId, responderId: proposal.partnerId, requiredResponderIds: [proposal.partnerId] };
  if (proposal.kind === 'membership' || proposal.kind === 'decision-rule' || proposal.kind === 'mandate') return {
    proposerId: proposal.proposerId,
    responderId: proposal.partnerId,
    requiredResponderIds: [...new Set(proposal.requiredApproverIds.filter((id) => id !== proposal.proposerId))],
  };
  return { proposerId: proposal.proposerId, responderId: proposal.partnerId, requiredResponderIds: [proposal.partnerId] };
}

function duration(proposal: SocialProposal): number {
  if (proposal.kind === 'companion') return 24;
  if (proposal.kind === 'collective' || proposal.kind === 'membership' || proposal.kind === 'permission' || proposal.kind === 'decision-rule' || proposal.kind === 'mandate') return 1;
  if (proposal.kind === 'exchange') return 12;
  if (proposal.kind === 'assist') return 6;
  if (proposal.kind === 'reproduce') return REPRODUCTION_CONSENT_WINDOW_MONTHS - 1;
  return 4;
}

export function reproductionAttemptedInMonth(agreement: Agreement, atMonth: number): boolean {
  return agreement.proposal.kind === 'reproduce'
    && agreement.lastReproductionAttemptAtMonth === atMonth;
}

export function reproductionAttemptedBetweenInMonth(
  state: SimulationState,
  a: PersonId,
  b: PersonId,
  atMonth: number,
): boolean {
  const agreementAttempt = agreementsForPerson(state, a).some((agreement) => agreement.proposal.kind === 'reproduce'
    && agreement.partyIds.includes(a)
    && agreement.partyIds.includes(b)
    && reproductionAttemptedInMonth(agreement, atMonth));
  if (agreementAttempt) return true;
  return completedActionFactsForPerson(state, a).some((fact) => fact.atMonth === atMonth
    && fact.action.kind === 'act'
    && fact.action.operation === 'reproduce'
    && fact.action.targets.some((target) => target.kind === 'person' && target.personId === b))
    || completedActionFactsForPerson(state, b).some((fact) => fact.atMonth === atMonth
      && fact.action.kind === 'act'
      && fact.action.operation === 'reproduce'
      && fact.action.targets.some((target) => target.kind === 'person' && target.personId === a));
}

interface AgreementIdIndex {
  indexedLength: number;
  lastIndexedAgreement?: Agreement;
  byId: Map<string, Agreement>;
  byProposalEventId: Map<string, Agreement>;
  byParticipantId: Map<PersonId, Agreement[]>;
}

const agreementIdIndexes = new WeakMap<SimulationState['agreements'], AgreementIdIndex>();

function agreementIdIndex(state: SimulationState): AgreementIdIndex {
  const agreements = state.agreements;
  let index = agreementIdIndexes.get(agreements);
  if (!index
    || index.indexedLength > agreements.length
    || (index.indexedLength > 0 && agreements[index.indexedLength - 1] !== index.lastIndexedAgreement)) {
    index = { indexedLength: 0, byId: new Map(), byProposalEventId: new Map(), byParticipantId: new Map() };
    agreementIdIndexes.set(agreements, index);
  }
  for (let offset = index.indexedLength; offset < agreements.length; offset += 1) {
    const agreement = agreements[offset];
    // Preserve Array.find semantics even for an invalid duplicate id: first wins.
    if (!index.byId.has(agreement.id)) index.byId.set(agreement.id, agreement);
    if (!index.byProposalEventId.has(agreement.proposalEventId)) {
      index.byProposalEventId.set(agreement.proposalEventId, agreement);
    }
    const participantIds = new Set<PersonId>([
      agreement.proposerId,
      agreement.responderId,
      ...(agreement.partyIds ?? []),
      ...(agreement.requiredResponderIds ?? []),
    ].filter((personId): personId is PersonId => typeof personId === 'string'));
    for (const participantId of participantIds) {
      const participantAgreements = index.byParticipantId.get(participantId) ?? [];
      participantAgreements.push(agreement);
      index.byParticipantId.set(participantId, participantAgreements);
    }
  }
  index.indexedLength = agreements.length;
  index.lastIndexedAgreement = agreements.at(-1);
  return index;
}

export function agreementById(state: SimulationState, id: string): Agreement | undefined {
  return agreementIdIndex(state).byId.get(id);
}

export function agreementByProposalEventId(state: SimulationState, eventId: string): Agreement | undefined {
  return agreementIdIndex(state).byProposalEventId.get(eventId);
}

/** Agreement membership is immutable after creation; status fields remain live. */
export function agreementsForPerson(state: SimulationState, personId: PersonId): readonly Agreement[] {
  return agreementIdIndex(state).byParticipantId.get(personId) ?? [];
}

/**
 * Reproduction legality is determined by the authoritative agreement state.
 * Communication events may still be waiting to enter world.past during the
 * current month, so they must not be used as a second authorization gate.
 */
export function activeReproductionAgreementBetween(
  state: SimulationState,
  a: PersonId,
  b: PersonId,
  atMonth: number,
  agreementId?: string,
): Agreement | undefined {
  return [...agreementsForPerson(state, a)].reverse().find((agreement) => agreement.status === 'active'
    && (!agreementId || agreement.id === agreementId)
    && agreement.proposal.kind === 'reproduce'
    && agreement.partyIds.includes(a)
    && agreement.partyIds.includes(b)
    && (agreement.acceptedAtMonth ?? Number.POSITIVE_INFINITY) <= atMonth
    && (agreement.dueAtMonth ?? Number.NEGATIVE_INFINITY) >= atMonth);
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
  const waterAssistance = agreementsForPerson(state, fact.who).find((agreement) => agreement.status === 'active'
    && agreement.proposal.kind === 'assist'
    && agreement.proposal.need === 'water'
    && agreement.partyIds.includes(fact.who));
  if (waterAssistance?.proposal.kind === 'assist') {
    const proposal = waterAssistance.proposal;
    const helperCandidate = personById(state, proposal.helperId);
    const requesterCandidate = personById(state, proposal.requesterId);
    const helper = helperCandidate && isAlive(helperCandidate) ? helperCandidate : undefined;
    const requester = requesterCandidate && isAlive(requesterCandidate) ? requesterCandidate : undefined;
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
        .flatMap((eventId) => {
          const event = worldEventById(state, eventId);
          return event?.kind === 'action' ? [event] : [];
        })
        .find((event) => event.who === proposal.helperId);
      if (helper && requester
        && (sameLocation(helper, requester) || (helperArrival?.cellId === fact.cellId && helperArrival.toZ === requester.position.z))
        && waterAssistance.fulfilledByPersonIds.includes(proposal.helperId)
        && waterAssistance.fulfilledByPersonIds.includes(proposal.requesterId)) {
        fulfill(state, waterAssistance, fact);
        return;
      }
    }
  }
  const sourceIntent = fact.intentId ? intentById(state, fact.intentId) : undefined;
  const companyAssistance = sourceIntent?.agreementId
    ? agreementById(state, sourceIntent.agreementId)
    : undefined;
  const companyProposal = companyAssistance?.proposal.kind === 'assist'
    && companyAssistance.proposal.need === 'company'
    ? companyAssistance.proposal
    : undefined;
  if (companyAssistance?.status === 'active'
    && companyProposal
    && fact.who === companyProposal.helperId
    && action.kind === 'attend'
    && action.target.kind === 'person'
    && action.target.personId === companyProposal.requesterId) {
    const helperCandidate = personById(state, companyProposal.helperId);
    const requesterCandidate = personById(state, companyProposal.requesterId);
    const helper = helperCandidate && isAlive(helperCandidate) ? helperCandidate : undefined;
    const requester = requesterCandidate && isAlive(requesterCandidate) ? requesterCandidate : undefined;
    if (helper && requester && sameLocation(helper, requester)) {
      fulfill(state, companyAssistance, fact);
      return;
    }
  }
  if (action.kind === 'communicate') {
    const content = action.content;
    if ((content.kind === 'request' || content.kind === 'offer') && content.proposal && !agreementById(state, content.id)) {
      const pair = parties(content.proposal);
      const reachedAudienceIds = Array.isArray(fact.diff.audience)
        ? fact.diff.audience.filter((id): id is PersonId => typeof id === 'string')
        : [];
      if ((content.proposal.kind === 'membership' || content.proposal.kind === 'decision-rule' || content.proposal.kind === 'mandate')
        && !pair.requiredResponderIds.every((id) => reachedAudienceIds.includes(id))) return;
      const intentSources = fact.intentId ? intentById(state, fact.intentId)?.sourceFactIds ?? [] : [];
      const relationshipBasisSources = (content.proposal.kind === 'companion' || content.proposal.kind === 'reproduce')
        ? content.proposal.basis?.sourceFactIds ?? []
        : [];
      const proposal = structuredClone(content.proposal);
      if (proposal.kind === 'companion') proposal.sharedLivingAnchor = {
        version: 'shared-living-anchor-v1',
        cellId: fact.toCellId,
        z: fact.toZ,
        radius: SHARED_LIVING_RADIUS,
      };
      state.agreements.push({
        id: content.id,
        proposal,
        ...pair,
        partyIds: [...new Set([pair.proposerId, ...pair.requiredResponderIds])],
        requiredResponderIds: [...pair.requiredResponderIds],
        acceptedByPersonIds: [pair.proposerId],
        rejectedByPersonIds: [],
        status: 'proposed',
        proposedAtMonth: fact.atMonth,
        acceptByMonth: content.proposal.expiresAtMonth,
        proposalEventId: fact.id,
        fulfillmentEventIds: [],
        fulfilledByPersonIds: [],
        coLocatedMonths: 0,
        sourceEventIds: [...new Set([...relationshipBasisSources, ...intentSources, fact.id])],
      });
      return;
    }
    if (content.kind === 'revoke-agreement') {
      const agreement = agreementById(state, content.referenceId);
      if (!agreement
        || agreement.status !== 'active'
        || (agreement.proposal.kind !== 'reproduce'
          && agreement.proposal.kind !== 'companion'
          && !(agreement.proposal.kind === 'assist' && agreement.proposal.need === 'company'))
        || !agreement.partyIds.includes(fact.who)) return;
      agreement.status = 'cancelled';
      agreement.resolvedAtMonth = fact.atMonth;
      agreement.responseEventId = fact.id;
      agreement.sourceEventIds = [...new Set([...agreement.sourceEventIds, fact.id])];
      return;
    }
    if (content.kind !== 'accept' && content.kind !== 'reject') return;
    const agreement = agreementById(state, content.referenceId);
    if (!agreement || agreement.status !== 'proposed'
      || !agreement.requiredResponderIds.includes(fact.who)
      || agreement.acceptedByPersonIds.includes(fact.who)
      || agreement.rejectedByPersonIds.includes(fact.who)
      || fact.atMonth > agreementResponseDeadline(agreement, fact.who)) return;
    agreement.responseEventId = fact.id;
    agreement.sourceEventIds = [...new Set([...agreement.sourceEventIds, fact.id])];
    if (content.kind === 'accept') {
      agreement.acceptedByPersonIds.push(fact.who);
      if (agreement.requiredResponderIds.every((id) => agreement.acceptedByPersonIds.includes(id))) {
        agreement.status = 'active';
        agreement.acceptedAtMonth = fact.atMonth;
        agreement.dueAtMonth = fact.atMonth + duration(agreement.proposal);
      }
    } else {
      agreement.rejectedByPersonIds.push(fact.who);
      agreement.status = 'rejected';
      agreement.resolvedAtMonth = fact.atMonth;
    }
    recordAgreementResponseSocialLearning(
      state,
      agreement,
      fact.who,
      content.kind === 'accept' ? 'accepted' : 'rejected',
      fact.atMonth,
      [fact.id],
    );
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
    const candidate = action.authorizationRef ? agreementById(state, action.authorizationRef) : undefined;
    const agreement = candidate?.status === 'active'
      && candidate.proposal.kind === 'reproduce'
      && candidate.partyIds.includes(fact.who)
      && candidate.partyIds.includes(target.personId)
      ? candidate
      : undefined;
    if (agreement) {
      agreement.reproductionAttemptEventIds = [...new Set([
        ...(agreement.reproductionAttemptEventIds ?? []),
        fact.id,
      ])];
      agreement.lastReproductionAttemptAtMonth = fact.atMonth;
      agreement.sourceEventIds = [...new Set([...agreement.sourceEventIds, fact.id])];
      // The agreement is a bounded, revocable attempt window. A completed but
      // unsuccessful action records progress without claiming that the shared
      // reproductive outcome was fulfilled.
      if (fact.diff.conceived === true) fulfill(state, agreement, fact);
    }
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
    const person = personById(state, personId);
    const otherId = agreement.partyIds.find((candidate) => candidate !== personId);
    if (person && otherId) applyRelationEvidence(person, otherId, fact.id, { trust, bond: 3 });
  }
  recordAgreementFulfillmentSocialLearning(
    state,
    agreement,
    fact.atMonth,
    [...agreement.fulfillmentEventIds],
  );
}

function agreementFact(agreement: Agreement, atMonth: number, orderInMonth: number, change: AgreementFact['change'], result: string): AgreementFact {
  return {
    id: `e-${atMonth}-agreement-${change}-${agreement.id}`,
    kind: 'agreement', atMonth, orderInMonth, cellId: 0,
    agreementId: agreement.id, change, partyIds: [...agreement.partyIds], result,
  };
}

function appendResponseDeadlineSuspensionFact(
  agreement: Agreement,
  responderId: PersonId,
  hibernationConditionId: string,
  kind: ResponseDeadlineSuspensionFact['kind'],
  atMonth: number,
  orderInMonth: number,
  cellId: number,
  sourceEventIds: string[],
  effectiveFromMonth?: number,
): AgreementFact {
  const change = kind === 'pause' ? 'response-deadline-paused' : 'response-deadline-resumed';
  const eventId = `e-${atMonth}-agreement-${change}-${agreement.id}-${responderId}-${hibernationConditionId}`;
  agreement.responseDeadlineSuspensions ??= [];
  agreement.responseDeadlineSuspensions.push({
    kind,
    responderId,
    hibernationConditionId,
    atMonth,
    effectiveFromMonth,
    eventId,
    sourceEventIds: [...new Set(sourceEventIds)],
  });
  agreement.sourceEventIds = [...new Set([...agreement.sourceEventIds, eventId])];
  return {
    id: eventId,
    kind: 'agreement',
    atMonth,
    orderInMonth,
    cellId,
    agreementId: agreement.id,
    change,
    partyIds: [...agreement.partyIds],
    responderId,
    hibernationConditionId,
    effectiveFromMonth,
    sourceEventIds: [...new Set(sourceEventIds)],
    result: kind === 'pause'
      ? '一名必要响应者因脱水休眠暂停了自己的回应期限'
      : '一名必要响应者结束脱水休眠，自己的回应期限从冻结处继续',
  };
}

/**
 * Reconcile per-responder protocol clocks with authoritative hibernation
 * episodes. Calling this at both month boundaries and month end captures
 * legacy/open episodes as well as entries created during a planning tick.
 */
export function synchronizeAgreementResponseDeadlineSuspensions(
  state: SimulationState,
  atMonth: number,
  orderOffset = 0,
  sourceEvents: readonly WorldEvent[] = [],
): AgreementFact[] {
  const events: AgreementFact[] = [];
  for (const agreement of agreementsRequiringResponseDeadlineSynchronization(state)) {
    for (const responderId of agreement.requiredResponderIds) {
      const responder = personById(state, responderId);
      if (!responder || !isAlive(responder)) continue;
      const activeEpisodes = responder.conditions.filter((condition) => condition.kind === 'dehydrated-hibernation');
      const activeEpisodeIds = new Set(activeEpisodes.map((condition) => condition.id));
      const suspension = responseDeadlineSuspensionState(agreement, responderId);
      for (const openConditionId of suspension.openConditionIds) {
        if (activeEpisodeIds.has(openConditionId)) continue;
        const exitSourceEventIds = sourceEvents.flatMap((event) => event.kind === 'environment'
          && event.who === responderId
          && event.diff.hibernationConditionId === openConditionId
          && event.diff.exited === true
          ? [event.id]
          : []);
        const pauseSources = [...(agreement.responseDeadlineSuspensions ?? [])]
          .reverse()
          .find((fact) => fact.kind === 'pause'
            && fact.responderId === responderId
            && fact.hibernationConditionId === openConditionId)
          ?.sourceEventIds ?? [];
        events.push(appendResponseDeadlineSuspensionFact(
          agreement,
          responderId,
          openConditionId,
          'resume',
          atMonth,
          orderOffset + events.length,
          responder.position.cellId,
          exitSourceEventIds.length ? exitSourceEventIds : pauseSources,
        ));
      }
      const unresolved = agreement.status === 'proposed'
        && !agreement.acceptedByPersonIds.includes(responderId)
        && !agreement.rejectedByPersonIds.includes(responderId);
      if (!unresolved) continue;
      for (const episode of activeEpisodes) {
        if (suspension.openConditionIds.has(episode.id)) continue;
        events.push(appendResponseDeadlineSuspensionFact(
          agreement,
          responderId,
          episode.id,
          'pause',
          atMonth,
          orderOffset + events.length,
          responder.position.cellId,
          episode.sourceEventIds,
          Math.max(agreement.proposedAtMonth, episode.sinceMonth),
        ));
      }
    }
  }
  return events;
}

export function advanceAgreementLifecycle(state: SimulationState, atMonth: number, orderOffset = 0): AgreementFact[] {
  const events: AgreementFact[] = [];
  for (const agreement of agreementsRequiringLifecycle(state)) {
    // Older saves ended a successfully established companionship.  Recover it
    // as the same ongoing, revocable relationship instead of forcing a fresh
    // proposal with no new causal basis.
    if (agreement.status === 'fulfilled' && agreement.proposal.kind === 'companion') {
      agreement.status = 'active';
      agreement.companionEstablishedAtMonth ??= agreement.resolvedAtMonth ?? agreement.dueAtMonth ?? atMonth;
      agreement.lastCompanionCoLocatedAtMonth ??= agreement.companionEstablishedAtMonth;
      agreement.lastCompanionRelationshipAtCoLocatedMonth ??= agreement.coLocatedMonths ?? REQUIRED_SHARED_LIVING_MONTHS;
      delete agreement.resolvedAtMonth;
    }
    if (agreement.status !== 'proposed' && agreement.status !== 'active') continue;
    const livingParties = agreement.partyIds.every((id) => {
      const person = personById(state, id);
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
    if (agreement.status === 'proposed') {
      const unresolvedResponderIds = agreement.requiredResponderIds.filter((responderId) => (
        !agreement.acceptedByPersonIds.includes(responderId)
        && !agreement.rejectedByPersonIds.includes(responderId)
      ));
      const expiredResponderIds = unresolvedResponderIds.filter((responderId) => (
        atMonth > agreementResponseDeadline(agreement, responderId)
      ));
      if (expiredResponderIds.length === 0) continue;
      agreement.status = 'expired';
      agreement.resolvedAtMonth = atMonth;
      const fact = agreementFact(agreement, atMonth, orderOffset + events.length, 'expired', '一项未被回应的提议已经过期');
      agreement.sourceEventIds.push(fact.id);
      for (const responderId of expiredResponderIds) {
        recordAgreementNoResponseSocialLearning(state, agreement, responderId, atMonth, [fact.id]);
      }
      events.push(fact);
      continue;
    }
    if (agreement.proposal.kind === 'companion') {
      if (agreement.companionEstablishedAtMonth !== undefined) {
        // Establishment itself required real shared living, so it is the oldest
        // safe migration value for active saves created before this field.
        agreement.lastCompanionCoLocatedAtMonth ??= agreement.companionEstablishedAtMonth;
      }
      if (companionSharesLivingArea(state, agreement)) {
        agreement.coLocatedMonths = (agreement.coLocatedMonths ?? 0) + 1;
        agreement.lastCompanionCoLocatedAtMonth = atMonth;
      }
    }
    if (agreement.proposal.kind === 'companion'
      && agreement.companionEstablishedAtMonth === undefined
      && agreement.coLocatedMonths >= REQUIRED_SHARED_LIVING_MONTHS) {
      agreement.companionEstablishedAtMonth = atMonth;
      agreement.lastCompanionRelationshipAtCoLocatedMonth = agreement.coLocatedMonths;
      const fact = agreementFact(
        agreement,
        atMonth,
        orderOffset + events.length,
        'fulfilled',
        `双方在稳定共同生活区域内累计生活了 ${agreement.coLocatedMonths} 个月，建立了可持续且可撤回的共同生活关系`,
      );
      agreement.fulfillmentEventIds = [...new Set([...agreement.fulfillmentEventIds, fact.id])];
      agreement.fulfilledByPersonIds = [...new Set([...agreement.fulfilledByPersonIds, ...agreement.partyIds])];
      agreement.sourceEventIds = [...new Set([...agreement.sourceEventIds, fact.id])];
      for (const personId of agreement.partyIds) {
        const person = personById(state, personId);
        const otherId = agreement.partyIds.find((candidate) => candidate !== personId);
        if (person && otherId) applyRelationEvidence(person, otherId, fact.id, { trust: 3, bond: 5 });
      }
      recordAgreementFulfillmentSocialLearning(state, agreement, atMonth, [fact.id]);
      events.push(fact);
      continue;
    }
    // An established companionship is not a 24-month job that completes and
    // disappears.  Its parties may work independently and explicitly revoke
    // it; continued relationship growth is settled from later shared-living
    // or joint-action facts.
    if (agreement.proposal.kind === 'companion' && agreement.companionEstablishedAtMonth !== undefined) continue;
    if ((agreement.dueAtMonth ?? Number.POSITIVE_INFINITY) >= atMonth) continue;
    if (agreement.proposal.kind === 'reproduce') {
      agreement.status = 'expired';
      agreement.resolvedAtMonth = atMonth;
      const attempts = agreement.reproductionAttemptEventIds?.length ?? 0;
      const fact = agreementFact(agreement, atMonth, orderOffset + events.length, 'expired', `双方同意的生殖尝试窗口结束，${attempts > 0 ? `期间完成了 ${attempts} 次尝试但没有受孕` : '期间没有完成尝试'}`);
      agreement.sourceEventIds.push(fact.id);
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
      const creditor = personById(state, creditorId);
      for (const debtorId of debtors) if (creditor) applyRelationEvidence(creditor, debtorId, fact.id, { trust: -10, bond: -3 });
    }
    recordAgreementBreachSocialLearning(state, agreement, atMonth, [fact.id]);
    events.push(fact);
  }
  return events;
}
