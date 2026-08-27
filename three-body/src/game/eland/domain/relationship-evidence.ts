import type { RelationshipCausalBasis } from './action';
import type { SimulationState } from './model';
import { ageMonths, type PersonState } from './person';
import {
  liveSocialEvidenceForPersonSource,
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
): boolean {
  if (!event) return false;
  if (event.action) {
    if (!event.action.completed) return false;
    if (event.action.actionKind !== 'communicate') return true;
    const conversation = event.action.communication?.groundedConversation;
    if (!conversation?.basisVerified) return false;
    const participants = new Set([conversation.speakerId, conversation.listenerId]);
    return participants.has(proposerId) && participants.has(partnerId);
  }
  if (event.agreementFulfilled) return true;
  if (!event.environment) return false;
  if (event.environment.change === 'prediction') return true;
  if (event.environment.change === 'relationship'
    && event.environment.excludedPairKeys.includes(
      relationshipPairKey(proposerId, partnerId),
    )) return false;
  return event.environment.participantIds.includes(proposerId)
    && event.environment.participantIds.includes(partnerId);
}

function relationshipEvidenceIds(
  state: SimulationState,
  proposer: PersonState,
  partner: PersonState,
): string[] {
  const relation = relationTo(proposer, partner.id);
  return liveSocialEvidenceForPersonSources(
    state,
    proposer,
    relation?.sourceEventIds ?? [],
  ).filter((event) => qualifiesAsRelationshipEvidence(
      event,
      proposer.id,
      partner.id,
    ))
    .map((event) => event.eventId)
    .sort();
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

/** A person may consider reproduction only with someone in their sourced relationship history. */
export function hasSourcedReproductiveRelationship(
  state: SimulationState,
  person: PersonState,
  partner: PersonState,
  basis = buildRelationshipCausalBasis(state, person, partner, 'reproduce'),
): boolean {
  if (basis.kind !== 'reproduce' || basis.proposerId !== person.id || basis.partnerId !== partner.id) return false;
  return basis.relationshipKeys.length > 0;
}

export function hasCultivatedCompanionRelationship(
  state: SimulationState,
  person: PersonState,
  partner: PersonState,
  basis = buildRelationshipCausalBasis(state, person, partner, 'companion'),
): boolean {
  if (basis.kind !== 'companion' || basis.proposerId !== person.id || basis.partnerId !== partner.id) return false;
  const relation = relationTo(person, partner.id);
  return Boolean(relation
    && relation.trust >= COMPANION_RELATION_THRESHOLD
    && relation.bond >= COMPANION_RELATION_THRESHOLD
    && basis.relationshipKeys.length > 0);
}

export function hasNewRelationshipEvidence(
  previous: RelationshipCausalBasis,
  current: RelationshipCausalBasis,
): boolean {
  const previousKeys = new Set([...previous.relationshipKeys, ...previous.bodyKeys]);
  return [...current.relationshipKeys, ...current.bodyKeys].some((key) => !previousKeys.has(key));
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
  if (current.relationshipKeys.some((eventId) => (
    liveSocialEvidenceForPersonSource(state, proposer, eventId)?.atMonth
      ?? Number.NEGATIVE_INFINITY
  ) > cutoff)) return true;
  const previousAgeBand = kind === 'reproduce' ? femaleAgeBand(proposer, partner, proposedAtMonth) : null;
  return Boolean(previousAgeBand && current.bodyKeys.some((key) => key !== `female-age:${previousAgeBand}`));
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
    if (previous.status === 'expired') return state.clock.elapsedMonths - previous.resolvedAtMonth >= REPRODUCTION_REOFFER_MONTHS_AFTER_NO_CONCEPTION;
  }
  const previousBasis = previous.proposal.kind === 'companion' || previous.proposal.kind === 'reproduce'
    ? previous.proposal.basis
    : undefined;
  return previousBasis
    ? hasNewRelationshipEvidence(previousBasis, basis)
    : legacyBasisHasNewEvidence(
      state,
      proposer,
      partner,
      basis.kind,
      basis,
      previous.proposedAtMonth,
      previous.resolvedAtMonth,
    );
}
