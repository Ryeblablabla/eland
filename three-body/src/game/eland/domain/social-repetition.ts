import type { ActionOption, PrimitiveAction, RepresentationInput } from './action';
import { worldEventById } from './event-index';
import type { ActionFact, SimulationState } from './model';
import type { PersonState } from './person';
import { agreementByProposalEventId } from './agreement';
import { intentById, personById } from './state-index';

const REQUIRED_SOCIAL_RESPONSE = /^(?:(?:accept|reject)-(?:assist|companion|exchange|reproduce|collective|membership|permission|decision-rule|mandate):|respond-conversation:)/;
const FULFILLMENT_OPTION = /^(settle-exchange|fulfill-assist|meet-to-assist|join-water-assist|contribute-mandate|distribute-mandate|use-permission|demonstrate-technique|withdraw-reproduce):/;

type SocialOutcome = 'unanswered' | 'supportive' | 'guarded' | 'proposed' | 'accepted' | 'rejected' | 'fulfilled' | 'expired' | 'breached' | 'cancelled';

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

function proposalSubject(content: Extract<RepresentationInput, { kind: 'request' | 'offer' }>): string | null {
  if (content.kind === 'request' && content.techniqueDemonstration) {
    return `request:technique:${content.techniqueDemonstration.projectId}:${content.techniqueDemonstration.desiredFunction}`;
  }
  if (content.kind === 'request' && content.projectKnowledgeRequest) {
    return `request:project-knowledge:${content.projectKnowledgeRequest.projectId}:${content.projectKnowledgeRequest.outputMaterialId}`;
  }
  if (content.kind === 'request' && content.projectMaterialContribution) {
    const request = content.projectMaterialContribution;
    return `request:project-material:${request.projectId}:${request.materialId}`;
  }
  const proposal = content.proposal;
  if (!proposal) return null;
  if (proposal.kind === 'assist') return `${content.kind}:assist:${proposal.need}`;
  if (proposal.kind === 'membership') return `${content.kind}:membership:${proposal.collectiveId}:${proposal.candidateId}`;
  if (proposal.kind === 'permission') return `${content.kind}:permission:${proposal.collectiveId}:${proposal.materialId}:${proposal.granteeId}`;
  if (proposal.kind === 'decision-rule') return `${content.kind}:decision-rule:${proposal.collectiveId}:${proposal.scope}:${proposal.materialId}`;
  if (proposal.kind === 'mandate') return `${content.kind}:mandate:${proposal.collectiveId}:${proposal.decisionRuleId}:${proposal.holderId}`;
  if (proposal.kind === 'exchange') {
    const materials = [proposal.offererMaterialId, proposal.partnerMaterialId].sort((left, right) => left - right);
    return `${content.kind}:exchange:${materials.join(':')}`;
  }
  return `${content.kind}:${proposal.kind}`;
}

function semanticSubject(action: Extract<PrimitiveAction, { kind: 'communicate' }>): string | null {
  const content = action.content;
  if (content.kind === 'claim') {
    if (content.conversation) return `claim:conversation:${content.conversation.topic}`;
    if (content.factId) return `claim:fact:${content.factId}`;
    return `claim:${content.id.split(':')[0] ?? 'situation'}`;
  }
  if (content.kind === 'prediction') return `prediction:${content.prediction.targetEpoch}`;
  if (content.kind === 'request' || content.kind === 'offer') return proposalSubject(content) ?? `${content.kind}:${content.id.split(':')[0] ?? 'situation'}`;
  return null;
}

function socialSubjectKey(action: Extract<PrimitiveAction, { kind: 'communicate' }>): string | null {
  const subject = semanticSubject(action);
  if (!subject) return null;
  return `${subject}|audience=${[...action.audience].sort().join(',')}`;
}

function isOptionalInitiation(option: ActionOption, action: Extract<PrimitiveAction, { kind: 'communicate' }>): boolean {
  if (option.domain !== 'social'
    || REQUIRED_SOCIAL_RESPONSE.test(option.id)
    || FULFILLMENT_OPTION.test(option.id)) return false;
  return action.content.kind === 'claim'
    || action.content.kind === 'prediction'
    || action.content.kind === 'request'
    || action.content.kind === 'offer';
}

function rememberedCommunications(state: SimulationState, person: PersonState): ActionFact[] {
  const seen = new Set<string>();
  return person.memories
    .flatMap((memory) => memory.sourceEventIds)
    .flatMap((eventId) => {
      if (seen.has(eventId)) return [];
      seen.add(eventId);
      const event = worldEventById(state, eventId);
      return event?.kind === 'action'
        && event.status === 'completed'
        && event.who === person.id
        && event.action.kind === 'communicate'
        ? [event]
        : [];
    })
    .sort((left, right) => right.atMonth - left.atMonth
      || (right.planningTick ?? 0) - (left.planningTick ?? 0)
      || right.orderInMonth - left.orderInMonth);
}

function actionBasisSourceIds(state: SimulationState, event: ActionFact): string[] {
  if (event.action.kind !== 'communicate') return [];
  const content = event.action.content;
  const conversationSources = content.kind === 'claim' ? content.conversation?.sourceFactIds ?? [] : [];
  const relationshipSources = (content.kind === 'request' || content.kind === 'offer')
    && (content.proposal?.kind === 'companion' || content.proposal?.kind === 'reproduce')
    ? content.proposal.basis?.sourceFactIds ?? []
    : [];
  const assertedSources = Array.isArray(event.diff.assertedFactSourceEventIds)
    ? event.diff.assertedFactSourceEventIds.filter((eventId): eventId is string => typeof eventId === 'string')
    : [];
  const intentSources = event.intentId
    ? intentById(state, event.intentId)?.sourceFactIds ?? []
    : [];
  return [...new Set([...conversationSources, ...relationshipSources, ...assertedSources, ...intentSources])];
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
  state: SimulationState,
  person: PersonState,
  openingEventId: string,
): ActionFact | undefined {
  const seen = new Set<string>();
  return person.memories
    .flatMap((memory) => memory.sourceEventIds)
    .flatMap((eventId) => {
      if (seen.has(eventId)) return [];
      seen.add(eventId);
      const event = worldEventById(state, eventId);
      return event?.kind === 'action'
        && event.status === 'completed'
        && event.action.kind === 'communicate'
        && event.action.content.kind === 'claim'
        && event.action.content.conversation?.turn === 'response'
        && event.action.content.conversation.referenceEventId === openingEventId
        ? [event]
        : [];
    })
    .sort((left, right) => right.atMonth - left.atMonth
      || (right.planningTick ?? 0) - (left.planningTick ?? 0)
      || right.orderInMonth - left.orderInMonth)[0];
}

function outcomeFor(state: SimulationState, person: PersonState, event: ActionFact): { outcome: SocialOutcome; sourceFactIds: string[] } {
  const agreement = agreementByProposalEventId(state, event.id);
  if (agreement) {
    const outcome = agreement.status === 'proposed'
      ? 'proposed'
      : agreement.status === 'active'
        ? 'accepted'
        : agreement.status;
    return { outcome, sourceFactIds: [...agreement.sourceEventIds] };
  }
  if (event.action.kind === 'communicate'
    && event.action.content.kind === 'claim'
    && event.action.content.conversation?.turn === 'opening') {
    const response = rememberedResponseTo(state, person, event.id);
    const stance = response?.action.kind === 'communicate'
      && response.action.content.kind === 'claim'
      ? response.action.content.conversation?.stance
      : undefined;
    if (response) return { outcome: stance === 'guarded' ? 'guarded' : 'supportive', sourceFactIds: [response.id] };
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
  state: SimulationState,
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
  state: SimulationState,
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
    .find((event) => event.action.kind === 'communicate' && socialSubjectKey(event.action) === subjectKey);
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
  const previousSources = new Set(actionBasisSourceIds(state, previous));
  const newEvidenceEventIds = currentSources.filter((eventId) => !previousSources.has(eventId));
  const outcome = outcomeFor(state, person, previous);
  if (newEvidenceEventIds.length > 0) {
    return {
      score: Math.min(16, newEvidenceEventIds.length * 4),
      reasons: ['同一主题出现了本人可追溯的新情况，可以重新判断是否开口'],
      sourceFactIds: [...new Set([previous.id, ...newEvidenceEventIds, ...outcome.sourceFactIds])],
      subjectKey,
      previousCommunicationEventId: previous.id,
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
    sourceFactIds: [...new Set([previous.id, ...outcome.sourceFactIds])],
    subjectKey,
    previousCommunicationEventId: previous.id,
    newEvidenceEventIds: [],
    outcome: outcome.outcome,
  };
}
