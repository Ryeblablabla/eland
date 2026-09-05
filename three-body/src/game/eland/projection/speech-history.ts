import type { WorldEvent } from '../domain/model';
import type { NarrativeEntryView, SpeechLineView } from '../../societyContract';
import {
  isVerifiedModelSpeechLine,
  verifiedSpeechLinesBySourceEventId,
  type SpeechHistoryEventLookup,
} from '../domain/speech-evidence';

export { verifiedSpeechLinesBySourceEventId, type SpeechHistoryEventLookup } from '../domain/speech-evidence';

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
