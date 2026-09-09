import { retrieveAgentMemories } from '../../domain/agent-memory';
import { compareWorldEventsInCanonicalOrder, worldEventById } from '../../domain/event-index';
import { languageBroadcastFromDiff, perceivedLanguageText } from '../../domain/language-perception';
import { memoryDurationMultiplier } from '../../domain/trait';
import type { WorldEvent } from '../../domain/model';
import type { DecisionContext } from '../../simulation';
import { verifiedSpeechLinesBySourceEventId } from '../../domain/speech-evidence';
import type { DialogueDisposition, DialogueMove, SpeechLineView } from '../../../societyContract';
import { actionOptionSemantics } from '../../domain/action-option-semantics';

export interface RecentDialogueContextLine {
  month: number;
  planningTick?: number;
  orderInMonth?: number;
  currentInput?: boolean;
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
    for (const personId of actionOptionSemantics(option).socialContext?.counterpartIds ?? []) result.add(personId);
  }
  return result;
}

/** Current-month conversation follows actual wave order. Older dialogue still
 * comes through personal recall; UI rows only fill missing recent storage. */
export function recentDialogueForDecision(
  context: Pick<DecisionContext, 'person' | 'state' | 'options' | 'decisionMonth' | 'planningTick' | 'currentMonthEvents' | 'reconsideration'>,
  committedSpeechLines: readonly SpeechLineView[] = [],
): RecentDialogueContextLine[] {
  const selfId = context.person.id;
  const planningMonth = context.decisionMonth ?? context.state.clock.elapsedMonths + 1;
  const nameById = new Map(context.state.people.map((person) => [person.id, person.name]));
  nameById.set('player', '主');
  const overlay = new Map((context.currentMonthEvents ?? []).map((event) => [event.id, event]));
  const lookup = (id: string): WorldEvent | undefined => overlay.get(id) ?? worldEventById(context.state, id);
  const broadcastFor = (event: WorldEvent | undefined) => event?.kind === 'decision' ? event.languageBroadcast
    : event?.kind === 'action' && event.status === 'completed' && event.action.kind === 'talk'
      ? languageBroadcastFromDiff(event.diff) : undefined;
  const inputSources = new Set((context.reconsideration?.sourceEventIds ?? []).flatMap((id) => {
    const waveId = broadcastFor(lookup(id))?.sourceEventId;
    return waveId ? [id, waveId] : [id];
  }));
  type Entry = { line: RecentDialogueContextLine; source?: WorldEvent };
  const compare = (left: Entry, right: Entry) => left.source && right.source
    ? compareWorldEventsInCanonicalOrder(left.source, right.source)
    : left.line.month - right.line.month
      || (left.line.planningTick ?? 0) - (right.line.planningTick ?? 0)
      || (left.line.orderInMonth ?? 0) - (right.line.orderInMonth ?? 0);
  const sourceTime = (event: WorldEvent | undefined) => ({
    ...(event?.planningTick !== undefined ? { planningTick: event.planningTick }
      : event?.kind === 'action' ? { planningTick: event.actionTick } : {}),
    ...(event?.orderInMonth !== undefined ? { orderInMonth: event.orderInMonth } : {}),
  });
  const current = new Map<string, Entry>();
  const events = new Map<string, WorldEvent>();
  // Committed history is chronological; ordinary next-month planning should
  // not scan the entire civilization just to find its uncommitted dialogue.
  for (let index = context.state.world.past.length - 1; index >= 0; index--) {
    const event = context.state.world.past[index];
    if (event.atMonth < planningMonth) break;
    if (event.atMonth === planningMonth) events.set(event.id, event);
  }
  for (const event of overlay.values()) events.set(event.id, event);
  for (const event of events.values()) {
    const wave = broadcastFor(event);
    if (!wave || (event.kind !== 'decision' && event.kind !== 'action')) continue;
    const source = lookup(wave.sourceEventId) ?? event;
    const tick = source.planningTick ?? (source.kind === 'action' ? source.actionTick : 0);
    if (source.atMonth !== planningMonth || context.planningTick !== undefined && tick > context.planningTick
      || event.who !== selfId && !wave.decodedByPersonIds.includes(selfId)) continue;
    const text = perceivedLanguageText({ broadcast: wave, observerId: selfId, speakerId: event.who, seed: context.state.seed });
    if (!text || current.has(wave.sourceEventId)) continue;
    current.set(wave.sourceEventId, { source, line: {
      month: source.atMonth, ...sourceTime(source), speaker: nameById.get(event.who) ?? '未知人物',
      listeners: wave.decodedByPersonIds.map((id) => nameById.get(id) ?? '未知人物'),
      text, sourceEventId: wave.sourceEventId,
      ...(inputSources.has(wave.sourceEventId) || inputSources.has(event.id) ? { currentInput: true } : {}),
    } });
  }
  const newest = [...current.values()].sort((left, right) => compare(right, left));
  const selected = new Map<string, Entry>();
  const take = (entry: Entry): void => {
    if (selected.size < 4 && !selected.has(entry.line.sourceEventId)) selected.set(entry.line.sourceEventId, entry);
  };
  newest.filter((entry) => entry.line.currentInput).forEach(take);
  newest.forEach(take);
  if (selected.size === 4) return [...selected.values()].sort(compare).map((entry) => entry.line);

  const recalled = retrieveAgentMemories(context.state, context.person, {
    atMonth: planningMonth, personIds: [...decisionCounterpartIds(context)],
    lanes: ['dialogue'], laneLimits: { dialogue: 4 }, limit: 4, tokenBudget: 480,
  }).filter((memory) => memory.exactUtterance && memory.dialogueSpeakerId && memory.lastExperiencedAtMonth < planningMonth);
  for (const memory of recalled) {
    const source = memory.sourceEventIds.map(lookup).find((event) => broadcastFor(event));
    const wave = broadcastFor(source);
    if (memory.dialogueSpeakerId !== selfId && wave && !wave.decodedByPersonIds.includes(selfId)) continue;
    take({ source, line: {
      month: memory.lastExperiencedAtMonth, ...sourceTime(source),
      speaker: nameById.get(memory.dialogueSpeakerId!) ?? '未知人物',
      listeners: (wave?.decodedByPersonIds ?? memory.dialoguePerceivedByPersonIds ?? [])
        .map((id) => nameById.get(id) ?? '未知人物'),
      text: memory.exactUtterance!, sourceEventId: wave?.sourceEventId ?? memory.sourceEventIds[0] ?? memory.id,
    } });
  }
  if (!recalled.length && selected.size < 4 && committedSpeechLines.length) {
    // Match the existing dialogue precision window (four months, modified by
    // the person's memory trait); a UI transcript must not restore faded years.
    const exactWindow = 4 * memoryDurationMultiplier(context.person);
    const candidates = committedSpeechLines.filter((line) => line.month < planningMonth
      && planningMonth - line.month <= exactWindow
      && (line.speakerId === selfId || line.perceivedByPersonIds.includes(selfId)));
    const verified = verifiedSpeechLinesBySourceEventId(candidates, { get: lookup });
    for (const line of [...verified.values()].sort((left, right) => right.month - left.month || right.planningTick - left.planningTick)) {
      const event = lookup(line.sourceEventId);
      const wave = broadcastFor(event);
      if (line.speakerId !== selfId && wave && !wave.decodedByPersonIds.includes(selfId)) continue;
      const source = wave ? lookup(wave.sourceEventId) ?? event : event;
      const text = wave ? perceivedLanguageText({ broadcast: wave, observerId: selfId, speakerId: line.speakerId, seed: context.state.seed })
        : line.text.trim().replace(/\s+/gu, ' ').slice(0, 180);
      if (!text) continue;
      take({ source, line: {
        month: line.month, ...sourceTime(source), speaker: nameById.get(line.speakerId) ?? line.speakerName,
        listeners: (wave?.decodedByPersonIds ?? line.perceivedByPersonIds).map((id) => nameById.get(id) ?? '未知人物'),
        text, sourceEventId: wave?.sourceEventId ?? line.sourceEventId,
        ...(line.dialogueMove ? { move: line.dialogueMove } : {}),
        ...(line.disposition ? { disposition: line.disposition } : {}),
      } });
    }
  }
  return [...selected.values()].sort(compare).map((entry) => entry.line);
}
