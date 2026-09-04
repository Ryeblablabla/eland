import type { RelationshipCausalBasis } from './action';
import type { DecisionAuthorityState, SimulationState } from './model';
import { ageMonths, type PersonState } from './person';
import {
  liveSocialEvidenceForPersonSources,
  worldEventById,
} from './event-index';
import type { LiveSocialEvidenceDescriptor } from './live-social-evidence';
import { liveSocialEvidenceDescriptorFromWorldEvent } from './live-social-evidence';
import {
  REPRODUCTION_REOFFER_MONTHS_AFTER_CONCEPTION,
  REPRODUCTION_REOFFER_MONTHS_AFTER_NO_CONCEPTION,
} from './population-capacity';
import { reproductiveResponsibility } from './dependent-care';
import {
  relationTo,
  relationshipEvidenceSourceEventIds,
  relationshipPairKey,
} from './relation';
import { relationshipEpisodeSourceFactIds } from './relationship-episode';
import { reproductiveUpperAgeMonths } from './trait';
import { agreementsForPerson } from './agreement';
import { intentsOwnedBy } from './state-index';
import {
  completedJointProjectRelationshipEvidence,
  fulfilledAgreementRelationshipEvidence,
} from './relationship-outcome-evidence';

type RelationshipEvidenceReadState = Pick<
  DecisionAuthorityState,
  'agreements' | 'intents' | 'people' | 'projects' | 'world'
>;

export type RelationshipProposalKind = RelationshipCausalBasis['kind'];

const COMPANION_REOFFER_MONTHS_AFTER_REJECTION = 6;
const REPRODUCTION_REOFFER_MONTHS_AFTER_SHARED_LIFE = 3;

function femaleAgeBand(person: PersonState, partner: PersonState, atMonth: number): string | null {
  const female = person.sex === 'female' ? person : partner.sex === 'female' ? partner : undefined;
  if (!female) return null;
  const years = ageMonths(female, atMonth) / 12;
  return years < 30
    ? 'under-30'
    : years < 35
      ? '30-34'
      : years < 38
        ? '35-37'
        : years < 41
          ? '38-40'
          : years <= 45
            ? '41-45'
            : years <= reproductiveUpperAgeMonths(female) / 12
              ? '46-67'
              : 'over-limit';
}

function qualifiesAsRelationshipEvidence(
  state: RelationshipEvidenceReadState,
  event: LiveSocialEvidenceDescriptor | undefined,
  proposerId: string,
  partnerId: string,
  includeFounding: boolean,
): boolean {
  if (!event) return false;
  if (event.action) {
    if (!event.action.completed) return false;
    if (fulfilledAgreementRelationshipEvidence(state, event.eventId, proposerId, partnerId)
      || completedJointProjectRelationshipEvidence(state, event.eventId, proposerId, partnerId)) return true;
    if (event.action.actionKind !== 'talk') {
      return (event.action.actorId === partnerId
          && event.action.supportRecipientIds.includes(proposerId))
        || (event.action.actorId === proposerId
          && event.action.supportRecipientIds.includes(partnerId));
    }
    const conversation = event.action.communication?.groundedConversation;
    if (!conversation?.basisVerified) return false;
    const participants = new Set([conversation.speakerId, ...conversation.interpreterIds]);
    return participants.has(proposerId) && participants.has(partnerId);
  }
  if (event.agreementFulfilled) return true;
  if (!event.environment) return false;
  if (event.environment.change === 'founding') return includeFounding
    && event.environment.participantIds.includes(proposerId)
    && event.environment.participantIds.includes(partnerId);
  if (event.environment.change !== 'relationship') return false;
  if (event.environment.excludedPairKeys.includes(
    relationshipPairKey(proposerId, partnerId),
  )) return false;
  return event.environment.participantIds.includes(proposerId)
    && event.environment.participantIds.includes(partnerId);
}

function relationshipEvidenceDescriptors(
  state: RelationshipEvidenceReadState,
  proposer: PersonState,
  partner: PersonState,
  includeFounding = false,
): LiveSocialEvidenceDescriptor[] {
  const relation = relationTo(proposer, partner.id);
  const relationEvidence = liveSocialEvidenceForPersonSources(
    state,
    proposer,
    relationshipEvidenceSourceEventIds(relation),
  );
  // RelationshipEpisode is an observer-owned source lane. Resolve its ids
  // against the authoritative event ledger, then require the same exact-pair
  // causal checks as legacy relation evidence. A free-text appraisal alone
  // can therefore never invent a shared encounter.
  const subjectiveEpisodeEvidence = relationshipEpisodeSourceFactIds(proposer, partner.id)
    .flatMap((eventId) => {
      const event = worldEventById(state, eventId);
      return event ? [liveSocialEvidenceDescriptorFromWorldEvent(event)] : [];
    });
  return [...new Map([...relationEvidence, ...subjectiveEpisodeEvidence]
    .map((event) => [event.eventId, event])).values()]
    .filter((event) => qualifiesAsRelationshipEvidence(
      state,
      event,
      proposer.id,
      partner.id,
      includeFounding,
    ))
    .sort((left, right) => left.atMonth - right.atMonth
      || left.orderInMonth - right.orderInMonth
      || left.eventId.localeCompare(right.eventId));
}

function relationshipEvidenceIds(
  state: RelationshipEvidenceReadState,
  proposer: PersonState,
  partner: PersonState,
  includeFounding = false,
): string[] {
  return relationshipEvidenceDescriptors(state, proposer, partner, includeFounding)
    .map((event) => event.eventId)
    .sort();
}

/**
 * Resolve only replayable interpersonal experience between this exact pair.
 * Founding familiarity, predictions and unrelated environment facts are
 * deliberately absent, so callers cannot turn a cached relation number into
 * a formal social request without a shared episode.
 */
export function substantiveRelationshipEvidenceIds(
  state: SimulationState,
  person: PersonState,
  other: PersonState,
): string[] {
  return relationshipEvidenceIds(state, person, other);
}

function isDirectIntimacyEvidence(
  state: RelationshipEvidenceReadState,
  event: LiveSocialEvidenceDescriptor,
  proposer: PersonState,
  partner: PersonState,
): boolean {
  if (event.agreementFulfilled
    || fulfilledAgreementRelationshipEvidence(state, event.eventId, proposer.id, partner.id)) return true;
  if (event.action) {
    if (!event.action.completed) return false;
    if (event.action.actionKind !== 'talk') {
      return (event.action.actorId === partner.id
          && event.action.supportRecipientIds.includes(proposer.id))
        || (event.action.actorId === proposer.id
          && event.action.supportRecipientIds.includes(partner.id));
    }
    const conversation = event.action.communication?.groundedConversation;
    if (!conversation?.basisVerified
      || conversation.turn !== 'response'
      || ['open', 'discovery', 'everyday', 'reminiscence', 'playful'].includes(conversation.topic)) return false;
    const participants = new Set([conversation.speakerId, ...conversation.interpreterIds]);
    return participants.has(proposer.id) && participants.has(partner.id);
  }
  const childId = event.environment?.change === 'body'
    ? event.environment.bornPersonId
    : undefined;
  if (!childId) return false;
  const child = state.people.find((person) => person.id === childId);
  return Boolean(child
    && child.geneticParents.includes(proposer.id)
    && child.geneticParents.includes(partner.id));
}

function directIntimacyEvidence(
  state: RelationshipEvidenceReadState,
  proposer: PersonState,
  partner: PersonState,
): LiveSocialEvidenceDescriptor[] {
  return relationshipEvidenceDescriptors(state, proposer, partner)
    .filter((event) => isDirectIntimacyEvidence(state, event, proposer, partner));
}

function occursAfter(
  event: LiveSocialEvidenceDescriptor,
  boundary: NonNullable<ReturnType<typeof worldEventById>>,
): boolean {
  return event.atMonth > boundary.atMonth
    || (event.atMonth === boundary.atMonth
      && (event.orderInMonth > boundary.orderInMonth
        || (event.orderInMonth === boundary.orderInMonth
          && (event.planningTick > (boundary.planningTick ?? 0)
            || (event.planningTick === (boundary.planningTick ?? 0)
              && event.orderInTick > (boundary.orderInTick ?? 0))))));
}

function relationshipRenewalWeight(
  state: RelationshipEvidenceReadState,
  event: LiveSocialEvidenceDescriptor,
  proposer: PersonState,
  partner: PersonState,
): number {
  if (event.agreementFulfilled
    || fulfilledAgreementRelationshipEvidence(state, event.eventId, proposer.id, partner.id)) return 1.5;
  if (event.environment?.change === 'body') return 1.5;
  if (event.environment?.change === 'relationship') return 1;
  if (event.action && event.action.actionKind !== 'talk') return 0.9;
  const conversation = event.action?.communication?.groundedConversation;
  if (event.action?.completed && conversation?.basisVerified) {
    return conversation.turn === 'response' ? 0.35 : 0.15;
  }
  return 0;
}

export interface RelationshipDecisionRenewal {
  strength: number;
  sourceFactIds: string[];
}

/**
 * Measure replayable experience after an explicit relationship decision.
 * Evidence changes the weight continuously: no topic unlocks a proposal and
 * no remembered rejection removes a legal candidate. A later fulfilled
 * obligation or shared-life consequence carries more information than one
 * additional conversational turn; same-month evidence is weaker because it
 * belongs to the still-unfolding decision episode.
 */
export function relationshipDecisionRenewalAfter(
  state: RelationshipEvidenceReadState,
  proposer: PersonState,
  partner: PersonState,
  boundaryEventId: string,
): RelationshipDecisionRenewal {
  const boundary = worldEventById(state, boundaryEventId);
  if (!boundary) return { strength: 0, sourceFactIds: [] };
  const evidence = relationshipEvidenceDescriptors(state, proposer, partner)
    .filter((event) => event.eventId !== boundaryEventId && occursAfter(event, boundary));
  let strength = 0;
  const sourceFactIds: string[] = [];
  for (const event of evidence) {
    const weight = relationshipRenewalWeight(state, event, proposer, partner)
      * (event.atMonth === boundary.atMonth ? 0.25 : 1);
    if (weight <= 0) continue;
    strength += weight;
    sourceFactIds.push(event.eventId);
  }
  return {
    strength: Math.min(2.5, strength),
    sourceFactIds: [...new Set(sourceFactIds)],
  };
}

export function buildRelationshipCausalBasis(
  state: SimulationState,
  proposer: PersonState,
  partner: PersonState,
  kind: RelationshipProposalKind,
  atMonth = state.clock.elapsedMonths,
): RelationshipCausalBasis {
  const pair = [proposer.id, partner.id].sort();
  const subjectKey = `relationship:${kind}:${pair[0]}:${pair[1]}`;
  const relationshipKeys = relationshipEvidenceIds(state, proposer, partner);
  const ageBand = kind === 'reproduce' ? femaleAgeBand(proposer, partner, atMonth) : null;
  const responsibility = kind === 'reproduce'
    ? reproductiveResponsibility(state, proposer, atMonth)
    : undefined;
  const bodyKeys = [
    ...(ageBand ? [`female-age:${ageBand}`] : []),
    ...(responsibility?.basisKeys ?? []),
  ];
  const basisKey = [
    'relationship-causal-basis-v1',
    `subject=${subjectKey}`,
    `observer=${proposer.id}`,
    `r=${relationshipKeys.join(',') || 'none'}`,
    `b=${bodyKeys.join(',') || 'none'}`,
  ].join('|');
  return {
    version: 'relationship-causal-basis-v1',
    subjectKey,
    basisKey,
    kind,
    proposerId: proposer.id,
    partnerId: partner.id,
    relationshipKeys,
    bodyKeys,
    sourceFactIds: [...new Set([
      ...relationshipKeys,
      ...(responsibility?.sourceFactIds ?? []),
    ])],
  };
}

export function hasSourcedReproductiveRelationship(
  state: SimulationState,
  person: PersonState,
  partner: PersonState,
  basis = buildRelationshipCausalBasis(state, person, partner, 'reproduce'),
): boolean {
  if (basis.kind !== 'reproduce' || basis.proposerId !== person.id || basis.partnerId !== partner.id) return false;
  return relationshipEvidenceDescriptors(state, person, partner)
    .some((event) => basis.relationshipKeys.includes(event.eventId));
}

/**
 * This names an experienced relationship context, not readiness, affection,
 * consent, or proposal eligibility. Numeric relation projections are never
 * consulted; the person's model may interpret the same sources differently.
 */
export function hasCultivatedCompanionRelationship(
  state: SimulationState,
  person: PersonState,
  partner: PersonState,
  basis = buildRelationshipCausalBasis(state, person, partner, 'companion'),
): boolean {
  if (basis.kind !== 'companion' || basis.proposerId !== person.id || basis.partnerId !== partner.id) return false;
  return relationshipEvidenceDescriptors(state, person, partner)
    .some((event) => basis.relationshipKeys.includes(event.eventId));
}

export function hasNewRelationshipEvidence(
  previous: RelationshipCausalBasis,
  current: RelationshipCausalBasis,
): boolean {
  const previousKeys = new Set([...previous.relationshipKeys, ...previous.bodyKeys]);
  return [...current.relationshipKeys, ...current.bodyKeys].some((key) => !previousKeys.has(key));
}

function hasNewProposalRelevantEvidence(
  state: SimulationState,
  proposer: PersonState,
  partner: PersonState,
  previous: RelationshipCausalBasis,
  current: RelationshipCausalBasis,
): boolean {
  const previousRelationshipKeys = new Set(previous.relationshipKeys);
  const newRelevantRelationship = directIntimacyEvidence(state, proposer, partner)
    .some((event) => current.relationshipKeys.includes(event.eventId)
      && !previousRelationshipKeys.has(event.eventId));
  const previousBodyKeys = new Set(previous.bodyKeys);
  return newRelevantRelationship
    || current.bodyKeys.some((key) => !previousBodyKeys.has(key));
}

function hasNewSharedLifeEvidence(
  state: SimulationState,
  proposer: PersonState,
  partner: PersonState,
  previous: RelationshipCausalBasis,
  current: RelationshipCausalBasis,
): boolean {
  const previousRelationshipKeys = new Set(previous.relationshipKeys);
  return relationshipEvidenceDescriptors(state, proposer, partner)
    .some((event) => event.environment?.change === 'relationship'
      && current.relationshipKeys.includes(event.eventId)
      && !previousRelationshipKeys.has(event.eventId));
}

function legacyBasisHasNewEvidence(
  state: SimulationState,
  proposer: PersonState,
  partner: PersonState,
  kind: RelationshipProposalKind,
  current: RelationshipCausalBasis,
  proposedAtMonth: number,
  resolvedAtMonth?: number,
): boolean {
  const cutoff = resolvedAtMonth ?? proposedAtMonth;
  if (directIntimacyEvidence(state, proposer, partner).some((event) => (
    current.relationshipKeys.includes(event.eventId) && event.atMonth > cutoff
  ))) return true;
  return kind === 'reproduce' && current.bodyKeys.some((key) => !key.startsWith('female-age:'));
}

export function canOfferRelationshipProposal(
  state: SimulationState,
  proposer: PersonState,
  partner: PersonState,
  basis: RelationshipCausalBasis,
): boolean {
  if (basis.proposerId !== proposer.id || basis.partnerId !== partner.id) return false;
  // Suitability is subjective. This domain check only prevents duplicate or
  // stale proposal episodes; trust, bond, fear, and the number/type of shared
  // experiences never unlock or forbid the possibility of asking.
  const inFlight = intentsOwnedBy(state, proposer.id).some((intent) => intent.ownerId === proposer.id
    && (intent.status === 'active' || intent.status === 'suspended')
    && intent.relationshipBasis?.subjectKey === basis.subjectKey
    && intent.relationshipBasis.partnerId === partner.id);
  if (inFlight) return false;
  const previous = [...agreementsForPerson(state, proposer.id)].reverse().find((agreement) => agreement.proposal.kind === basis.kind
    && agreement.proposerId === proposer.id
    && agreement.responderId === partner.id);
  if (!previous) return true;
  if (previous.status === 'proposed' || previous.status === 'active') return false;
  const previousBasis = previous.proposal.kind === 'companion' || previous.proposal.kind === 'reproduce'
    ? previous.proposal.basis
    : undefined;
  const hasRelevantRenewal = previousBasis
    ? hasNewProposalRelevantEvidence(state, proposer, partner, previousBasis, basis)
    : legacyBasisHasNewEvidence(
      state,
      proposer,
      partner,
      basis.kind,
      basis,
      previous.proposedAtMonth,
      previous.resolvedAtMonth,
    );
  if (basis.kind === 'reproduce' && typeof previous.resolvedAtMonth === 'number') {
    if (previous.status === 'fulfilled') {
      const conceived = previous.fulfillmentEventIds.some((eventId) => {
        const event = worldEventById(state, eventId);
        return event?.kind === 'action'
          && event.action.kind === 'act'
          && event.action.operation === 'reproduce'
          && event.diff.conceived === true;
      });
      const cooldown = conceived
        ? REPRODUCTION_REOFFER_MONTHS_AFTER_CONCEPTION
        : REPRODUCTION_REOFFER_MONTHS_AFTER_NO_CONCEPTION;
      return state.clock.elapsedMonths - previous.resolvedAtMonth >= cooldown;
    }
    if (previous.status === 'expired') {
      return state.clock.elapsedMonths - previous.resolvedAtMonth >= REPRODUCTION_REOFFER_MONTHS_AFTER_NO_CONCEPTION;
    }
  }
  if ((previous.status === 'rejected' || previous.status === 'cancelled')
    && typeof previous.resolvedAtMonth === 'number') {
    if (basis.kind === 'reproduce') {
      return hasRelevantRenewal
        || (state.clock.elapsedMonths - previous.resolvedAtMonth >= REPRODUCTION_REOFFER_MONTHS_AFTER_SHARED_LIFE
          && hasNewSharedLifeEvidence(state, proposer, partner, previousBasis ?? basis, basis));
    }
    return state.clock.elapsedMonths - previous.resolvedAtMonth >= COMPANION_REOFFER_MONTHS_AFTER_REJECTION
      && hasRelevantRenewal;
  }
  return hasRelevantRenewal;
}
