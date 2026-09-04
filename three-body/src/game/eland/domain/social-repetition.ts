import type { ActionOption, PrimitiveAction } from './action';
import {
  liveSocialEvidenceForPersonSources,
  worldEventById,
} from './event-index';
import type { DecisionAuthorityState } from './model';
import type { PersonState } from './person';
import { agreementById, agreementByProposalEventId } from './agreement';
import { personById } from './state-index';
import { relationTo } from './relation';
import { relationshipDecisionRenewalAfter } from './relationship-evidence';
import { actionOptionSemantics } from './action-option-semantics';
import {
  liveSocialCommunicationSubjectKey,
  type LiveSocialEvidenceDescriptor,
} from './live-social-evidence';

type SocialOutcome = 'unanswered' | 'supportive' | 'guarded' | 'proposed' | 'accepted' | 'rejected' | 'fulfilled' | 'expired' | 'breached' | 'cancelled';
type SocialRepetitionState = Pick<
  DecisionAuthorityState,
  'agreements' | 'clock' | 'intents' | 'people' | 'projects' | 'world'
>;

function rememberedCommunicationOrder(
  left: LiveSocialEvidenceDescriptor,
  right: LiveSocialEvidenceDescriptor,
): number {
  return right.atMonth - left.atMonth
    || right.planningTick - left.planningTick
    || right.orderInMonth - left.orderInMonth;
}

export interface SocialRepetitionAssessment {
  score: number;
  reasons: string[];
  sourceFactIds: string[];
  subjectKey?: string;
  previousCommunicationEventId?: string;
  newEvidenceEventIds: string[];
  outcome?: SocialOutcome;
}

function communicationAction(option: ActionOption): Extract<PrimitiveAction, { kind: 'talk' }> | undefined {
  if (option.nextAction.kind === 'talk') return option.nextAction;
  return option.completionAction?.kind === 'talk' ? option.completionAction : undefined;
}

function socialSubjectKey(action: Extract<PrimitiveAction, { kind: 'talk' }>): string | null {
  return liveSocialCommunicationSubjectKey(action);
}

function isOptionalInitiation(option: ActionOption, action: Extract<PrimitiveAction, { kind: 'talk' }>): boolean {
  if (option.domain !== 'social'
    || actionOptionSemantics(option).obligation !== 'optional') return false;
  return action.speakerMeaning.kind === 'claim'
    || action.speakerMeaning.kind === 'prediction'
    || action.speakerMeaning.kind === 'request'
    || action.speakerMeaning.kind === 'offer';
}

function rememberedCommunications(
  state: SocialRepetitionState,
  person: PersonState,
): LiveSocialEvidenceDescriptor[] {
  return liveSocialEvidenceForPersonSources(
    state,
    person,
    person.memories.flatMap((memory) => memory.sourceEventIds),
  ).filter((event) => event.action?.completed
    && event.action.actorId === person.id
    && Boolean(event.action.communication))
    .sort(rememberedCommunicationOrder);
}

function actionBasisSourceIds(event: LiveSocialEvidenceDescriptor): string[] {
  return [...(event.action?.communication?.basisSourceEventIds ?? [])];
}

function currentBasisSourceIds(option: ActionOption, action: Extract<PrimitiveAction, { kind: 'talk' }>): string[] {
  const content = action.speakerMeaning;
  const conversationSources = content.kind === 'claim' ? content.conversation?.sourceFactIds ?? [] : [];
  const relationshipSources = (content.kind === 'request' || content.kind === 'offer')
    && (content.proposal?.kind === 'companion' || content.proposal?.kind === 'reproduce')
    ? content.proposal.basis?.sourceFactIds ?? []
    : [];
  return [...new Set([...option.sourceFactIds, ...conversationSources, ...relationshipSources])];
}

function rememberedResponseTo(
  state: SocialRepetitionState,
  person: PersonState,
  openingEventId: string,
): LiveSocialEvidenceDescriptor | undefined {
  return liveSocialEvidenceForPersonSources(
    state,
    person,
    person.memories.flatMap((memory) => memory.sourceEventIds),
  ).filter((event) => event.action?.completed
    && event.action.communication?.groundedConversation?.turn === 'response'
    && event.action.communication.groundedConversation.referenceEventId === openingEventId)
    .sort(rememberedCommunicationOrder)[0];
}

function outcomeFor(
  state: SocialRepetitionState,
  person: PersonState,
  event: LiveSocialEvidenceDescriptor,
): { outcome: SocialOutcome; sourceFactIds: string[] } {
  const agreement = agreementByProposalEventId(state, event.eventId);
  if (agreement) {
    const outcome = agreement.status === 'proposed'
      ? 'proposed'
      : agreement.status === 'active'
        ? 'accepted'
        : agreement.status;
    return { outcome, sourceFactIds: [...agreement.sourceEventIds] };
  }
  if (event.action?.communication?.groundedConversation?.turn === 'opening') {
    const response = rememberedResponseTo(state, person, event.eventId);
    const stance = response?.action?.communication?.groundedConversation?.stance;
    if (response) return {
      outcome: stance === 'guarded' ? 'guarded' : 'supportive',
      sourceFactIds: [response.eventId],
    };
  }
  return { outcome: 'unanswered', sourceFactIds: [] };
}

function acuteBodyUrgency(person: PersonState): number {
  const bodyPressure = Math.max(
    Math.max(0, 30 - person.body.hydration) * 5,
    Math.max(0, 30 - person.body.nutrition) * 5,
    Math.max(0, 25 - person.body.health) * 5,
  );
  const acuteCondition = person.conditions.some((condition) => condition.stage >= 3
    && (condition.kind === 'cold' || condition.kind === 'heat' || condition.kind === 'wound' || condition.kind === 'illness'))
    ? 36
    : 0;
  return Math.min(120, bodyPressure + acuteCondition);
}

function survivalUrgency(
  state: SocialRepetitionState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'talk' }>,
): number {
  const content = action.speakerMeaning;
  if ((content.kind === 'request' || content.kind === 'offer') && content.proposal?.kind === 'assist') {
    const proposal = content.proposal;
    const requester = personById(state, proposal.requesterId);
    if (!requester) return 0;
    if (proposal.need === 'water') return Math.min(120, Math.max(0, 30 - requester.body.hydration) * 5);
    if (proposal.need === 'food') return Math.min(120, Math.max(0, 30 - requester.body.nutrition) * 5);
    if (proposal.need === 'shelter') {
      const exposed = requester.conditions.some((condition) => condition.stage >= 3
        && (condition.kind === 'cold' || condition.kind === 'heat'));
      return exposed ? Math.min(120, 72 + Math.max(0, 25 - requester.body.health) * 5) : 0;
    }
    return 0;
  }
  if (content.kind !== 'claim' || !content.conversation) return 0;
  const subject = content.conversation.topic === 'hardship'
      ? person
      : undefined;
  return subject ? acuteBodyUrgency(subject) : 0;
}

function recentRelationshipBoundaryCost(
  state: SocialRepetitionState,
  person: PersonState,
  option: ActionOption,
): SocialRepetitionAssessment | null {
  const basis = option.relationshipBasis;
  if (!basis || actionOptionSemantics(option).socialContext?.phase !== 'proposal') return null;
  const partner = personById(state, basis.partnerId);
  const relation = partner ? relationTo(person, partner.id) : undefined;
  if (!partner || !relation) return null;
  const boundary = [...(relation.evidenceLedger?.decisionBoundaries ?? [])]
    .sort((left, right) => right.atMonth - left.atMonth || right.eventId.localeCompare(left.eventId))
    .flatMap((anchor) => {
      const event = worldEventById(state, anchor.eventId);
      if (event?.kind !== 'action'
        || event.action.kind !== 'talk'
        || event.action.speakerMeaning.kind !== 'reject') return [];
      const agreement = agreementById(state, event.action.speakerMeaning.referenceId);
      if (!agreement
        || agreement.proposal.kind !== basis.kind
        || !agreement.partyIds.includes(person.id)
        || !agreement.partyIds.includes(partner.id)) return [];
      return [{ anchor, event }];
    })[0];
  if (!boundary) return null;
  const age = Math.max(0, state.clock.elapsedMonths - boundary.anchor.atMonth);
  const ownDecision = boundary.event.who === person.id;
  const renewal = relationshipDecisionRenewalAfter(
    state,
    person,
    partner,
    boundary.event.id,
  );
  const score = (ownDecision ? -120 : -102)
    * Math.exp(-age / 12 - renewal.strength * 1.5);
  return {
    score,
    reasons: [ownDecision
      ? '本人刚明确拒绝过同一人物的同类关系选择；反向开口与本人仍记得的决定相冲突，但这只是会衰减的预期成本'
      : '对方刚明确拒绝过同类关系选择；再次开口的预期显著降低，但候选仍保留并可被后续关系收益超过'],
    sourceFactIds: [boundary.event.id, ...renewal.sourceFactIds],
    subjectKey: basis.subjectKey,
    previousCommunicationEventId: boundary.event.id,
    newEvidenceEventIds: renewal.sourceFactIds,
    outcome: 'rejected',
  };
}

/**
 * Repetition is an expected-value cost, not a monthly action cap. The person
 * can only compare communications retained in their own memory. A materially
 * new local basis, or acute danger directly relevant to an assist, care, or
 * hardship subject, can make speaking again worthwhile. Required responses
 * and fulfillment never enter this vote.
 */
export function assessSocialRepetition(
  state: SocialRepetitionState,
  person: PersonState,
  option: ActionOption,
): SocialRepetitionAssessment {
  const action = communicationAction(option);
  if (!action || !isOptionalInitiation(option, action)) {
    return { score: 0, reasons: [], sourceFactIds: [], newEvidenceEventIds: [] };
  }
  const subjectKey = socialSubjectKey(action);
  if (!subjectKey) return { score: 0, reasons: [], sourceFactIds: [], newEvidenceEventIds: [] };
  const relationshipBoundary = recentRelationshipBoundaryCost(state, person, option);
  if (relationshipBoundary) return relationshipBoundary;
  const previous = rememberedCommunications(state, person)
    .find((event) => event.action?.communication?.subjectKey === subjectKey);
  const currentSources = currentBasisSourceIds(option, action);
  if (!previous) {
    return {
      score: 0,
      reasons: ['本人记忆中没有向这组听者发起过同一主题'],
      sourceFactIds: currentSources,
      subjectKey,
      newEvidenceEventIds: currentSources,
    };
  }
  const previousSources = new Set(actionBasisSourceIds(previous));
  const newEvidenceEventIds = currentSources.filter((eventId) => !previousSources.has(eventId));
  const outcome = outcomeFor(state, person, previous);
  if (newEvidenceEventIds.length > 0) {
    const evidenceValue = Math.min(16, newEvidenceEventIds.length * 4);
    return {
      score: evidenceValue,
      reasons: ['同一主题出现了本人可追溯的新情况，可以重新判断是否开口'],
      sourceFactIds: [...new Set([previous.eventId, ...newEvidenceEventIds, ...outcome.sourceFactIds])],
      subjectKey,
      previousCommunicationEventId: previous.eventId,
      newEvidenceEventIds,
      outcome: outcome.outcome,
    };
  }
  const urgency = survivalUrgency(state, person, action);
  const outcomeCost = outcome.outcome === 'rejected' || outcome.outcome === 'guarded' || outcome.outcome === 'breached'
    ? -102
    : outcome.outcome === 'proposed' || outcome.outcome === 'unanswered'
      ? -92
      : -82;
  return {
    score: outcomeCost + urgency,
    reasons: [
      `本人记得刚向同一组听者谈过同一主题，且没有新的事实依据（上次结果：${outcome.outcome}）`,
      ...(urgency > 0 ? ['这项求助或生活话题直接涉及的显著生存危险提高了再次开口的价值'] : []),
    ],
    sourceFactIds: [...new Set([previous.eventId, ...outcome.sourceFactIds])],
    subjectKey,
    previousCommunicationEventId: previous.eventId,
    newEvidenceEventIds: [],
    outcome: outcome.outcome,
  };
}
