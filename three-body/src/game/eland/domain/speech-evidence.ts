import type { WorldEvent } from './model';
import { languageBroadcastFromDiff } from './language-perception';
import type { SpeechAct } from './speech-act';

/** External language evidence is usable only when it matches a real utterance. */
export interface SpeechEvidenceLine {
  id: string;
  authority: 'projection-only';
  sourceEventId: string;
  month: number;
  planningTick: number;
  speakerId: string;
  perceivedByPersonIds: string[];
  communicationKind: SpeechAct['kind'];
  speechAct: Pick<SpeechAct, 'kind'>;
  text: string;
  source: 'decision-model' | 'speech-model';
}

export type SpeechHistoryEventLookup = Pick<ReadonlyMap<string, WorldEvent>, 'get'>;

type LanguageEvent = Extract<WorldEvent, { kind: 'action' | 'decision' }>;

function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const remaining = new Set(right);
  return left.every((id) => remaining.delete(id)) && remaining.size === 0;
}

export function isVerifiedModelSpeechLine(
  line: SpeechEvidenceLine,
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
export function verifiedSpeechLinesBySourceEventId<T extends SpeechEvidenceLine>(
  speechLines: readonly T[],
  events: SpeechHistoryEventLookup,
): Map<string, T> {
  const indexed = new Map<string, T>();
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
