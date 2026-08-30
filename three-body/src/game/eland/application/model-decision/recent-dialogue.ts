import { retrieveAgentMemories } from '../../domain/agent-memory';
import { worldEventById } from '../../domain/event-index';
import type { DecisionContext } from '../../simulation';
import { verifiedSpeechLinesBySourceEventId } from '../../projection/speech-history';
import type { DialogueDisposition, DialogueMove, SpeechLineView } from '../../../societyContract';

export interface RecentDialogueContextLine {
  month: number;
  speaker: string;
  listeners: string[];
  text: string;
  move?: DialogueMove;
  disposition?: DialogueDisposition;
  sourceEventId: string;
}

export function decisionCounterpartIds(context: Pick<DecisionContext, 'options'>): Set<string> {
  const result = new Set<string>();
  for (const option of context.options) {
    if (option.target?.kind === 'person') result.add(option.target.personId);
    for (const action of [option.nextAction, option.completionAction]) {
      if (action?.kind !== 'communicate') continue;
      for (const personId of action.audience) result.add(personId);
    }
  }
  return result;
}

/**
 * Projects only unambiguous persisted lines bound to completed voice events.
 * A two-month counterpart boost keeps current social choices relevant without
 * allowing old dialogue to crowd out everything the person heard recently.
 */
export function recentDialogueForDecision(
  context: Pick<DecisionContext, 'person' | 'state' | 'options'>,
  committedSpeechLines: readonly SpeechLineView[] = [],
): RecentDialogueContextLine[] {
  const selfId = context.person.id;
  const planningMonth = context.state.clock.elapsedMonths + 1;
  const nameById = new Map(context.state.people.map((person) => [person.id, person.name]));
  nameById.set('player', '主');
  const recalled = retrieveAgentMemories(context.state, context.person, {
    atMonth: planningMonth,
    personIds: [...decisionCounterpartIds(context)],
    lanes: ['dialogue'],
    laneLimits: { dialogue: 4 },
    limit: 4,
    tokenBudget: 480,
  }).filter((memory) => memory.exactUtterance && memory.dialogueSpeakerId);
  if (recalled.length) return recalled.map((memory) => ({
    month: memory.lastExperiencedAtMonth,
    speaker: nameById.get(memory.dialogueSpeakerId!) ?? '未知人物',
    listeners: (memory.dialogueAudienceIds ?? []).slice(0, 4)
      .map((personId) => nameById.get(personId) ?? '未知人物'),
    text: memory.exactUtterance!,
    sourceEventId: memory.sourceEventIds[0] ?? memory.id,
  }));
  if (!committedSpeechLines.length) return [];
  const personallyObservedCandidates = committedSpeechLines.filter((line) => (
    line.month < planningMonth
    && (line.speakerId === selfId || line.audienceIds.includes(selfId))
  ));
  const verified = verifiedSpeechLinesBySourceEventId(personallyObservedCandidates, {
    get: (eventId) => worldEventById(context.state, eventId),
  });
  const counterpartIds = decisionCounterpartIds(context);
  return [...verified.values()]
    .map((line) => ({
      line,
      counterpartRelevant: [line.speakerId, ...line.audienceIds]
        .some((personId) => personId !== selfId && counterpartIds.has(personId)),
    }))
    .sort((left, right) => (
      right.line.month + (right.counterpartRelevant ? 2 : 0)
      - (left.line.month + (left.counterpartRelevant ? 2 : 0))
      || right.line.month - left.line.month
      || right.line.planningTick - left.line.planningTick
      || left.line.sourceEventId.localeCompare(right.line.sourceEventId)
    ))
    .slice(0, 4)
    .map(({ line }) => ({
      month: line.month,
      speaker: (nameById.get(line.speakerId) ?? line.speakerName).trim().slice(0, 80),
      listeners: line.audienceIds.slice(0, 4).map((personId, index) => (
        nameById.get(personId) ?? line.audienceNames[index] ?? '未知人物'
      ).trim().slice(0, 80)),
      text: line.text.trim().replace(/\s+/gu, ' ').slice(0, 180),
      ...(line.dialogueMove ? { move: line.dialogueMove } : {}),
      ...(line.disposition ? { disposition: line.disposition } : {}),
      sourceEventId: line.sourceEventId,
    }));
}
