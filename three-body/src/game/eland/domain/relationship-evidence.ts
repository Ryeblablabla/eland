import type { RelationshipCausalBasis } from './action';
import type { SimulationState } from './model';
import { ageMonths, type PersonState } from './person';
import {
  liveSocialEvidenceForPersonSources,
  worldEventById,
} from './event-index';
import type { LiveSocialEvidenceDescriptor } from './live-social-evidence';
import {
  REPRODUCTION_REOFFER_MONTHS_AFTER_CONCEPTION,
  REPRODUCTION_REOFFER_MONTHS_AFTER_NO_CONCEPTION,
} from './population-capacity';
import { reproductiveResponsibility } from './dependent-care';
import {
  COMPANION_RELATION_THRESHOLD,
  relationTo,
  relationshipPairKey,
} from './relation';
import { reproductiveUpperAgeMonths } from './trait';
import { agreementsForPerson } from './agreement';
import { intentsOwnedBy } from './state-index';

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
  event: LiveSocialEvidenceDescriptor | undefined,
  proposerId: string,
  partnerId: string,
  includeFounding: boolean,
): boolean {
  if (!event) return false;
  if (event.action) {
    if (!event.action.completed) return false;
    if (event.action.actionKind !== 'communicate') {
      return (event.action.actorId === partnerId
          && event.action.supportRecipientIds.includes(proposerId))
        || (event.action.actorId === proposerId
          && event.action.supportRecipientIds.includes(partnerId));
    }
    const conversation = event.action.communication?.groundedConversation;
    if (!conversation?.basisVerified) return false;
    const participants = new Set([conversation.speakerId, conversation.listenerId]);
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
  state: SimulationState,
  proposer: PersonState,
  partner: PersonState,
  includeFounding = false,
): LiveSocialEvidenceDescriptor[] {
  const relation = relationTo(proposer, partner.id);
  return liveSocialEvidenceForPersonSources(
    state,
    proposer,
    relation?.sourceEventIds ?? [],
  ).filter((event) => qualifiesAsRelationshipEvidence(
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
  state: SimulationState,
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
  state: SimulationState,
  event: LiveSocialEvidenceDescriptor,
  proposer: PersonState,
  partner: PersonState,
): boolean {
  if (event.action) {
    if (!event.action.completed) return false;
    if (event.action.actionKind !== 'communicate') {
      return (event.action.actorId === partner.id
          && event.action.supportRecipientIds.includes(proposer.id))
        || (event.action.actorId === proposer.id
          && event.action.supportRecipientIds.includes(partner.id));
    }
    const conversation = event.action.communication?.groundedConversation;
    if (!conversation?.basisVerified
      || conversation.turn !== 'response'
      || ['open', 'discovery', 'everyday', 'reminiscence', 'playful'].includes(conversation.topic)) return false;
    const participants = new Set([conversation.speakerId, conversation.listenerId]);
    return participants.has(proposer.id) && participants.has(partner.id);
  }
  if (event.agreementFulfilled) return true;
  const childId = event.environment?.change === 'body'
    ? event.environment.bornPersonId
    : undefined;
  if (!childId) return false;
  const child = state.people.find((person) => person.id === childId);
  return Boolean(child
    && child.geneticParents.includes(proposer.id)
    && child.geneticParents.includes(partner.id));
}

function evidenceMonths(events: readonly LiveSocialEvidenceDescriptor[]): Set<number> {
  return new Set(events.map((event) => event.atMonth));
}

function directIntimacyEvidence(
  state: SimulationState,
  proposer: PersonState,
  partner: PersonState,
): LiveSocialEvidenceDescriptor[] {
  return relationshipEvidenceDescriptors(state, proposer, partner)
    .filter((event) => isDirectIntimacyEvidence(state, event, proposer, partner));
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
  const relation = relationTo(person, partner.id);
  const relationshipEvents = relationshipEvidenceDescriptors(state, person, partner)
    .filter((event) => basis.relationshipKeys.includes(event.eventId));
  const intimateEvents = relationshipEvents
    .filter((event) => isDirectIntimacyEvidence(state, event, person, partner));
  return Boolean(relation
    && relation.trust >= COMPANION_RELATION_THRESHOLD
    && relation.bond >= COMPANION_RELATION_THRESHOLD
    && evidenceMonths(relationshipEvents).size >= 2
    && intimateEvents.length > 0);
}

export function hasCultivatedCompanionRelationship(
  state: SimulationState,
  person: PersonState,
  partner: PersonState,
  basis = buildRelationshipCausalBasis(state, person, partner, 'companion'),
): boolean {
  if (basis.kind !== 'companion' || basis.proposerId !== person.id || basis.partnerId !== partner.id) return false;
  const relation = relationTo(person, partner.id);
  const relationshipEvents = relationshipEvidenceDescriptors(state, person, partner)
    .filter((event) => basis.relationshipKeys.includes(event.eventId));
  const intimateEvents = relationshipEvents
    .filter((event) => isDirectIntimacyEvidence(state, event, person, partner));
  return Boolean(relation
    && relation.trust >= COMPANION_RELATION_THRESHOLD
    && relation.bond >= COMPANION_RELATION_THRESHOLD
    && evidenceMonths(relationshipEvents).size >= 2
    && intimateEvents.length > 0);
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
  if (basis.kind === 'companion' && !hasCultivatedCompanionRelationship(state, proposer, partner, basis)) return false;
  if (basis.kind === 'reproduce' && !hasSourcedReproductiveRelationship(state, proposer, partner, basis)) return false;
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
