import type { WorldEvent } from '../simulation';
import type { NarrativeEntryView, SpeechLineView } from '../../societyContract';
import { languageBroadcastFromDiff } from '../domain/language-perception';

export type SpeechHistoryEventLookup = Pick<ReadonlyMap<string, WorldEvent>, 'get'>;

type LanguageEvent = Extract<WorldEvent, { kind: 'action' | 'decision' }>;

function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const remaining = new Set(right);
  return left.every((id) => remaining.delete(id)) && remaining.size === 0;
}

function isVerifiedModelSpeechLine(
  line: SpeechLineView,
  event: WorldEvent | undefined,
): event is LanguageEvent {
  if (!event
    || (line.source !== 'decision-model' && line.source !== 'speech-model')
    || line.authority !== 'projection-only'
    || !line.text.trim()
    || line.sourceEventId !== event.id
    || line.month !== event.atMonth
    || line.speakerId !== ('who' in event ? event.who : undefined)) return false;
  if (event.kind === 'decision') {
    const mentalAct = 'mentalAct' in event.decision ? event.decision.mentalAct : undefined;
    return line.source === 'decision-model'
      && line.planningTick === (event.planningTick ?? 0)
      && line.communicationKind === 'talk'
      && line.speechAct.kind === 'talk'
      && line.text.trim() === mentalAct?.utterance.trim()
      && sameIds(line.perceivedByPersonIds, event.languageBroadcast?.perceivedByPersonIds ?? []);
  }
  if (event.kind !== 'action') return false;
  return event.status === 'completed'
    && event.action.kind === 'talk'
    && line.planningTick === (event.planningTick ?? event.actionTick)
    && sameIds(line.perceivedByPersonIds, languageBroadcastFromDiff(event.diff)?.perceivedByPersonIds ?? [])
    && line.communicationKind === event.action.speakerMeaning.kind
    && line.speechAct?.kind === event.action.speakerMeaning.kind;
}

/**
 * Index only unambiguous, already validated model utterances. Conflicting
 * projection lines for one ActionFact are ignored instead of choosing one.
 */
export function verifiedSpeechLinesBySourceEventId(
  speechLines: readonly SpeechLineView[],
  events: SpeechHistoryEventLookup,
): Map<string, SpeechLineView> {
  const indexed = new Map<string, SpeechLineView>();
  const ambiguous = new Set<string>();
  for (const line of speechLines) {
    const event = events.get(line.sourceEventId);
    if (!isVerifiedModelSpeechLine(line, event) || ambiguous.has(line.sourceEventId)) continue;
    const existing = indexed.get(line.sourceEventId);
    if (!existing) {
      indexed.set(line.sourceEventId, line);
      continue;
    }
    if (existing.id === line.id && existing.text.trim() === line.text.trim()) continue;
    indexed.delete(line.sourceEventId);
    ambiguous.add(line.sourceEventId);
  }
  return indexed;
}

export function speechHistoryTextForEvent(
  event: WorldEvent,
  speechLinesBySourceEventId: ReadonlyMap<string, SpeechLineView>,
): string | null {
  const line = speechLinesBySourceEventId.get(event.id);
  if (!line || !isVerifiedModelSpeechLine(line, event)) return null;
  const speaker = line.speakerName.trim();
  const perceivedBy = line.perceivedByPersonNames.map((name) => name.trim()).filter(Boolean).join('、');
  if (!speaker) return null;
  const utterance = line.text.trim();
  const punctuated = /[。！？!?…]$/u.test(utterance) ? utterance : `${utterance}。`;
  return `${speaker}说：“${punctuated}”${perceivedBy ? `，被${perceivedBy}感知` : ''}`;
}

/** Only an exact, single-source communication entry may display a quotation. */
export function projectSpeechHistoryEntry(
  entry: NarrativeEntryView,
  speechLinesBySourceEventId: ReadonlyMap<string, SpeechLineView>,
  events: SpeechHistoryEventLookup,
): NarrativeEntryView {
  if ((entry.kind !== 'action' && entry.kind !== 'decision') || entry.sourceEventIds.length !== 1) return entry;
  const sourceEventId = entry.sourceEventIds[0];
  if (entry.id !== `narrative:${sourceEventId}`) return entry;
  const event = events.get(sourceEventId);
  if (!event || (event.kind === 'action' ? event.action.kind !== 'talk' : event.kind !== 'decision')) return entry;
  const text = speechHistoryTextForEvent(event, speechLinesBySourceEventId);
  return text ? { ...entry, text } : entry;
}

export function projectSpeechHistoryEntries(
  entries: readonly NarrativeEntryView[],
  speechLines: readonly SpeechLineView[],
  events: SpeechHistoryEventLookup,
): NarrativeEntryView[] {
  const indexed = verifiedSpeechLinesBySourceEventId(speechLines, events);
  return entries.map((entry) => projectSpeechHistoryEntry(entry, indexed, events));
}

export function collectSpeechLinesThroughMonth(
  frames: ReadonlyArray<{ elapsedMonths?: number; speechLines?: SpeechLineView[] }>,
  throughMonth: number,
): SpeechLineView[] {
  return frames.flatMap((frame) => (
    (frame.elapsedMonths ?? Number.NEGATIVE_INFINITY) <= throughMonth
      ? frame.speechLines ?? []
      : []
  ));
}
