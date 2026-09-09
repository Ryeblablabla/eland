import type { SpeechActView, SpeechLineView } from '../../societyContract';
import type { SimulationState, WorldEvent } from '../simulation';
import type { RepresentationInput } from '../domain/action';
import { speechActFromRepresentation } from './speech-act';
import { languageBroadcastFromDiff } from '../domain/language-perception';
import { outwardDeclaration } from '../domain/mental-act';
import { worldEventById } from '../domain/event-index';

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

function cleanModelText(value: string): string {
  return value
    .trim()
    .replace(/^(["'“”]+)|(["'“”]+)$/gu, '')
    .replace(/\s+/gu, ' ')
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
  state: SimulationState,
): DecisionEvent | undefined {
  const languageSourceEventId = typeof event.diff.languageSourceEventId === 'string'
    ? event.diff.languageSourceEventId
    : undefined;
  if (!languageSourceEventId) return undefined;
  const decision = decisions.find((candidate) => candidate.id === languageSourceEventId)
    ?? worldEventById(state, languageSourceEventId);
  if (decision?.kind !== 'decision' || !decision.usedModel || decision.who !== event.who
    || decision.atMonth > event.atMonth
    || decision.atMonth === event.atMonth && decision.orderInMonth > event.orderInMonth) return undefined;
  const declaration = outwardDeclaration(decision.decision);
  const wave = languageBroadcastFromDiff(event.diff);
  if (!declaration?.utterance.trim() || !decision.languageBroadcast
    || wave?.sourceEventId !== decision.id
    || wave.text !== decision.languageBroadcast.text
    || wave.text.trim() !== declaration.utterance.trim()) return undefined;
  return decision;
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
 * Project each outward decision language wave or completed rule talk. A model
 * decision already owns its exact text; only rule talk needs expression.
 */
export function projectLiveSpeechDrafts(
  state: SimulationState,
  events: WorldEvent[],
): SpeechLineDraft[] {
  const decisions = events.filter((event): event is DecisionEvent => event.kind === 'decision');
  const decisionByActionId = new Map(events.flatMap((event) => {
    if (event.kind !== 'action' || event.status !== 'completed' || event.action.kind !== 'talk') return [];
    const decision = modelDecisionFor(event, decisions, state);
    return decision ? [[event.id, decision] as const] : [];
  }));
  const decisionLanguageConsumedByAction = new Set([...decisionByActionId.values()].map((decision) => decision.id));
  const usedDecisionIds = new Set<string>();
  return events.flatMap((event): SpeechLineDraft[] => {
    if (event.kind === 'decision' && event.languageBroadcast) {
      if (decisionLanguageConsumedByAction.has(event.id)) return [];
      const speaker = state.people.find((person) => person.id === event.who);
      const declaration = outwardDeclaration(event.decision);
      if (!speaker || !declaration?.utterance.trim()) return [];
      const perceived = event.languageBroadcast.perceivedByPersonIds.flatMap((personId) => {
        const person = state.people.find((candidate) => candidate.id === personId);
        return person ? [{ id: person.id, name: person.name }] : [];
      });
      return [{
        id: `speech:${state.branchId}:${event.id}`,
        authority: 'projection-only',
        sourceEventId: event.id,
        sourceFactIds: [...declaration.sourceEventIds],
        month: event.atMonth,
        planningTick: event.planningTick ?? 0,
        speakerId: speaker.id,
        speakerName: speaker.name,
        perceivedByPersonIds: perceived.map((person) => person.id),
        perceivedByPersonNames: perceived.map((person) => person.name),
        communicationKind: 'talk',
        speechAct: { version: 'speech-act-v1', kind: 'talk' },
        modelText: cleanModelText(declaration.utterance),
      }];
    }
    if (event.kind !== 'action'
      || event.status !== 'completed'
      || event.action.kind !== 'talk') return [];

    const speaker = state.people.find((person) => person.id === event.who);
    if (!speaker) return [];
    const perceived = (languageBroadcastFromDiff(event.diff)?.perceivedByPersonIds ?? []).flatMap((personId) => {
      const person = state.people.find((candidate) => candidate.id === personId);
      return person ? [{ id: person.id, name: person.name }] : [];
    });

    const decision = decisionByActionId.get(event.id);
    if (decision && usedDecisionIds.has(decision.id)) return [];
    if (decision) usedDecisionIds.add(decision.id);
    const declaration = decision ? outwardDeclaration(decision.decision) : undefined;
    const decisionText = declaration?.utterance;
    const conversationSources = event.action.speakerMeaning.kind === 'claim'
      ? event.action.speakerMeaning.conversation?.sourceFactIds ?? []
      : [];
    const expressedFactId = event.action.speakerMeaning.kind === 'claim' ? event.action.speakerMeaning.factId : undefined;
    const expressedFactSources = expressedFactId
      ? speaker.knowledge.find((fact) => fact.id === expressedFactId)?.sourceEventIds ?? []
      : [];
    const replySource = replySourceFor(state, event);

    return [{
      id: `speech:${state.branchId}:${event.id}`,
      authority: 'projection-only',
      sourceEventId: event.id,
      sourceFactIds: [...new Set([
        ...(declaration?.sourceEventIds ?? []),
        ...referencedFactSources(state, event),
        ...expressedFactSources,
        ...conversationSources,
        ...(replySource.sourceEventId ? [replySource.sourceEventId] : []),
      ])],
      month: event.atMonth,
      planningTick: event.planningTick ?? event.actionTick,
      speakerId: speaker.id,
      speakerName: speaker.name,
      perceivedByPersonIds: perceived.map((person) => person.id),
      perceivedByPersonNames: perceived.map((person) => person.name),
      communicationKind: event.action.speakerMeaning.kind,
      speechAct: speechActForAutonomousTurn(event.action.speakerMeaning),
      ...(replySource.sourceEventId ? { replyToSourceEventId: replySource.sourceEventId } : {}),
      ...(replySource.required ? { requiresParentSpeech: true } : {}),
      ...(decisionText && cleanModelText(decisionText) ? { modelText: cleanModelText(decisionText) } : {}),
    }];
  });
}
