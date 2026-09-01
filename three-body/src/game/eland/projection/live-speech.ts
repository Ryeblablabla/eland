import type { SpeechActView, SpeechLineView } from '../../societyContract';
import type { SimulationState, WorldEvent } from '../simulation';
import type { RepresentationInput } from '../domain/action';
import { speechActFromRepresentation } from './speech-act';

type ActionEvent = Extract<WorldEvent, { kind: 'action' }>;
type DecisionEvent = Extract<WorldEvent, { kind: 'decision' }>;

export interface SpeechLineDraft extends Omit<SpeechLineView, 'speechAct' | 'text' | 'source' | 'endpointId' | 'model'> {
  speechAct: SpeechActView;
  modelText?: string;
  /** ActionFact whose already-realized model line must be supplied verbatim. */
  replyToSourceEventId?: string;
  /** True responses are not realizable without the exact visible parent line. */
  requiresParentSpeech?: boolean;
}

function cleanModelText(value: string, max = 120): string {
  return value
    .trim()
    .replace(/^(["'“”]+)|(["'“”]+)$/gu, '')
    .replace(/\s+/gu, ' ')
    .slice(0, max)
    .trim();
}

function speechActForAutonomousTurn(content: RepresentationInput): SpeechActView {
  const speechAct = speechActFromRepresentation(content);
  const conversation = speechAct.details?.conversation;
  if (!conversation || typeof conversation !== 'object' || Array.isArray(conversation)) return speechAct;
  // Legacy grounded-conversation rules precomputed supportive/guarded. That is
  // useful as historical schema data, but it must not decide the model's live
  // conversational move or disposition.
  const { stance: _stance, ...autonomousConversation } = conversation as Record<string, unknown>;
  return {
    ...speechAct,
    details: { ...speechAct.details, conversation: autonomousConversation },
  };
}

function modelDecisionFor(
  event: ActionEvent,
  decisions: DecisionEvent[],
  usedDecisionIds: Set<string>,
  sourceDecisionEventId?: string,
): DecisionEvent | undefined {
  if (!event.intentId || !sourceDecisionEventId) return undefined;
  return [...decisions].reverse().find((decision) => (
    !usedDecisionIds.has(decision.id)
      && decision.id === sourceDecisionEventId
      && decision.intentId === event.intentId
      && decision.orderInMonth <= event.orderInMonth
      && decision.usedModel
      && (decision.decision.kind === 'start' || decision.decision.kind === 'revise')
      && Boolean(decision.decision.utterance?.trim())
  ));
}

function referencedFactSources(state: SimulationState, event: ActionEvent): string[] {
  if (event.action.kind !== 'talk') return [];
  const content = event.action.speakerMeaning;
  if (content.kind !== 'accept' && content.kind !== 'reject' && content.kind !== 'revoke-agreement') return [];
  const referenceId = content.referenceId;
  const referencedAction = [...state.world.past].reverse().find((candidate): candidate is ActionEvent => (
    candidate.kind === 'action'
      && candidate.id !== event.id
      && candidate.action.kind === 'talk'
      && candidate.action.speakerMeaning.id === referenceId
  ));
  if (referencedAction) return [referencedAction.id];
  return state.agreements.find((agreement) => agreement.id === referenceId)?.sourceEventIds ?? [];
}

function precedes(candidate: ActionEvent, event: ActionEvent): boolean {
  return candidate.atMonth < event.atMonth
    || candidate.atMonth === event.atMonth && candidate.orderInMonth < event.orderInMonth;
}

function communicationEventForRepresentation(
  state: SimulationState,
  event: ActionEvent,
  representationId: string | undefined,
): ActionEvent | undefined {
  if (!representationId) return undefined;
  return [...state.world.past].reverse().find((candidate): candidate is ActionEvent => (
    candidate.kind === 'action'
      && candidate.status === 'completed'
      && candidate.action.kind === 'talk'
      && candidate.action.channel === 'voice'
      && candidate.action.speakerMeaning.id === representationId
      && precedes(candidate, event)
  ));
}

function replySourceFor(
  state: SimulationState,
  event: ActionEvent,
): { sourceEventId?: string; required: boolean } {
  if (event.action.kind !== 'talk') return { required: false };
  const content = event.action.speakerMeaning;
  if (content.kind === 'claim' && content.conversation?.turn === 'response') {
    return { sourceEventId: content.conversation.referenceEventId, required: true };
  }
  if (content.kind === 'claim' && content.projectKnowledgeResponse) {
    return { sourceEventId: content.projectKnowledgeResponse.requestEventId, required: true };
  }
  if (content.kind === 'accept' || content.kind === 'reject') {
    return {
      sourceEventId: communicationEventForRepresentation(state, event, content.referenceId)?.id,
      required: true,
    };
  }
  return { required: false };
}

/**
 * Project each completed spoken communication into a model-expression draft.
 * The draft has no rule-authored display text and never mutates the ActionFact.
 */
export function projectLiveSpeechDrafts(
  state: SimulationState,
  events: WorldEvent[],
): SpeechLineDraft[] {
  const decisions = events.filter((event): event is DecisionEvent => event.kind === 'decision');
  const usedDecisionIds = new Set<string>();
  return events.flatMap((event): SpeechLineDraft[] => {
    if (event.kind !== 'action'
      || event.status !== 'completed'
      || event.action.kind !== 'talk'
      || event.action.channel !== 'voice'
      || ((event.diff.understoodByPersonIds as string[] | undefined) ?? []).length === 0) return [];

    const speaker = state.people.find((person) => person.id === event.who);
    if (!speaker) return [];
    const audience = ((event.diff.understoodByPersonIds as string[] | undefined) ?? []).flatMap((personId) => {
      const person = state.people.find((candidate) => candidate.id === personId);
      return person ? [{ id: person.id, name: person.name }] : [];
    });
    if (!audience.length) return [];

    const intent = event.intentId
      ? state.intents.find((candidate) => candidate.id === event.intentId)
      : undefined;
    const decision = modelDecisionFor(event, decisions, usedDecisionIds, intent?.sourceDecisionEventId);
    if (decision) usedDecisionIds.add(decision.id);
    const decisionText = decision
      && (decision.decision.kind === 'start' || decision.decision.kind === 'revise')
      ? decision.decision.utterance
      : undefined;
    const conversationSources = event.action.speakerMeaning.kind === 'claim'
      ? event.action.speakerMeaning.conversation?.sourceFactIds ?? []
      : [];
    const communicatedFactId = event.action.speakerMeaning.kind === 'claim' ? event.action.speakerMeaning.factId : undefined;
    const communicatedFactSources = communicatedFactId
      ? speaker.knowledge.find((fact) => fact.id === communicatedFactId)?.sourceEventIds ?? []
      : [];
    const replySource = replySourceFor(state, event);

    return [{
      id: `speech:${state.branchId}:${event.id}`,
      authority: 'projection-only',
      sourceEventId: event.id,
      sourceFactIds: [...new Set([
        ...referencedFactSources(state, event),
        ...communicatedFactSources,
        ...conversationSources,
        ...(replySource.sourceEventId ? [replySource.sourceEventId] : []),
      ])],
      month: event.atMonth,
      planningTick: event.planningTick ?? event.actionTick,
      speakerId: speaker.id,
      speakerName: speaker.name,
      audienceIds: audience.map((person) => person.id),
      audienceNames: audience.map((person) => person.name),
      channel: 'voice',
      communicationKind: event.action.speakerMeaning.kind,
      speechAct: speechActForAutonomousTurn(event.action.speakerMeaning),
      ...(replySource.sourceEventId ? { replyToSourceEventId: replySource.sourceEventId } : {}),
      ...(replySource.required ? { requiresParentSpeech: true } : {}),
      ...(decisionText && cleanModelText(decisionText) ? { modelText: cleanModelText(decisionText) } : {}),
    }];
  });
}
