import type { ActionOption, PrimitiveAction } from './action';
import {
  liveSocialEvidenceForPersonSources,
} from './event-index';
import type { DecisionAuthorityState } from './model';
import type { PersonState } from './person';
import { agreementByProposalEventId } from './agreement';
import { personById } from './state-index';
import { actionOptionSemantics } from './action-option-semantics';
import {
  liveSocialCommunicationSubjectKey,
  type LiveSocialEvidenceDescriptor,
} from './live-social-evidence';

type SocialOutcome = 'unanswered' | 'supportive' | 'guarded' | 'proposed' | 'accepted' | 'rejected' | 'fulfilled' | 'expired' | 'breached' | 'cancelled';
type SocialRepetitionState = Pick<
  DecisionAuthorityState,
  'agreements' | 'intents' | 'people' | 'world'
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

function communicationAction(option: ActionOption): Extract<PrimitiveAction, { kind: 'communicate' }> | undefined {
  if (option.nextAction.kind === 'communicate') return option.nextAction;
  return option.completionAction?.kind === 'communicate' ? option.completionAction : undefined;
}

function socialSubjectKey(action: Extract<PrimitiveAction, { kind: 'communicate' }>): string | null {
  return liveSocialCommunicationSubjectKey(action);
}

function isOptionalInitiation(option: ActionOption, action: Extract<PrimitiveAction, { kind: 'communicate' }>): boolean {
  if (option.domain !== 'social'
    || actionOptionSemantics(option).obligation !== 'optional') return false;
  return action.content.kind === 'claim'
    || action.content.kind === 'prediction'
    || action.content.kind === 'request'
    || action.content.kind === 'offer';
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

function currentBasisSourceIds(option: ActionOption, action: Extract<PrimitiveAction, { kind: 'communicate' }>): string[] {
  const content = action.content;
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
  action: Extract<PrimitiveAction, { kind: 'communicate' }>,
): number {
  const content = action.content;
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
  const subject = content.conversation.topic === 'care'
    ? personById(state, content.conversation.listenerId)
    : content.conversation.topic === 'hardship'
      ? person
      : undefined;
  return subject ? acuteBodyUrgency(subject) : 0;
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
