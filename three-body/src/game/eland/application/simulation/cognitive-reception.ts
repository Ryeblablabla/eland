import { languageBroadcastFromDiff } from '../../domain/language-perception';
import type { SimulationState, WorldEvent } from '../../domain/model';
import type { PersonId } from '../../domain/person';

/** Hearing is an input to a mind, not proof of interpretation or agreement. */
export function unreviewedLanguageSources(
  events: readonly WorldEvent[],
  reviewed: ReadonlyMap<PersonId, ReadonlySet<string>>,
): Map<PersonId, string[]> {
  const sources = new Map<PersonId, Set<string>>();
  for (const event of events) {
    const broadcast = event.kind === 'decision' ? event.languageBroadcast
      : event.kind === 'action' ? languageBroadcastFromDiff(event.diff) : undefined;
    if (!broadcast || !('who' in event)) continue;
    // A decision's wave may also be attached to its later talk action. Its
    // source identity prevents those two records from waking a listener twice.
    for (const listenerId of broadcast.decodedByPersonIds) {
      if (listenerId === event.who || reviewed.get(listenerId)?.has(broadcast.sourceEventId)) continue;
      const heard = sources.get(listenerId) ?? new Set<string>();
      heard.add(broadcast.sourceEventId);
      sources.set(listenerId, heard);
    }
  }
  return new Map([...sources].map(([personId, ids]) => [personId, [...ids]]));
}

export function acknowledgeLanguageSources(
  reviewed: Map<PersonId, Set<string>>,
  personId: PersonId,
  sourceEventIds: readonly string[],
): void {
  const previous = reviewed.get(personId) ?? new Set<string>();
  for (const sourceEventId of sourceEventIds) previous.add(sourceEventId);
  reviewed.set(personId, previous);
}

/** Physical encounters offer the informed participant a thought, not a feeling
 * or prescribed response. Only an actually recorded personal memory qualifies. */
export function unreviewedSocialActionSources(
  state: Pick<SimulationState, 'people'>,
  events: readonly WorldEvent[],
  reviewed: ReadonlyMap<PersonId, ReadonlySet<string>>,
): Map<PersonId, string[]> {
  const sources = new Map<PersonId, Set<string>>();
  for (const event of events) {
    if (event.kind !== 'action') continue;
    const effects = event.action.kind === 'world-interact' && Array.isArray(event.diff.appliedEffects)
      ? event.diff.appliedEffects : [];
    const recipients: unknown[] = [];
    if (event.action.kind === 'act' && event.action.operation === 'exert' && typeof event.diff.victimId === 'string') {
      recipients.push(event.diff.victimId, ...(Array.isArray(event.diff.witnessedBy) ? event.diff.witnessedBy : []));
    }
    if (event.action.kind === 'transfer') {
      if (event.action.from.kind === 'person') recipients.push(event.action.from.personId);
      if (event.action.to.kind === 'person') recipients.push(event.action.to.personId);
      if (Array.isArray(event.diff.witnessedBy)) recipients.push(...event.diff.witnessedBy);
    }
    for (const effect of effects) {
      if (effect?.kind === 'modify-structure' && Array.isArray(effect.witnessedBy)) recipients.push(...effect.witnessedBy);
      if (effect?.kind === 'transfer') {
        if (effect.target?.kind === 'inventory-stack') recipients.push(effect.target.personId);
        if (effect.destination?.kind === 'person') recipients.push(effect.destination.personId);
        if (Array.isArray(effect.witnessedBy)) recipients.push(...effect.witnessedBy);
      }
    }
    for (const personId of new Set(recipients)) {
      if (typeof personId !== 'string' || personId === event.who || reviewed.get(personId)?.has(event.id)) continue;
      const observer = state.people.find((person) => person.id === personId);
      if (!observer?.memories.some((memory) => memory.sourceEventIds.includes(event.id) && memory.personIds.includes(event.who))) continue;
      const heard = sources.get(personId) ?? new Set<string>();
      heard.add(event.id); sources.set(personId, heard);
    }
  }
  return new Map([...sources].map(([personId, ids]) => [personId, [...ids]]));
}

export function acknowledgeSocialActionSources(
  reviewed: Map<PersonId, Set<string>>, personId: PersonId, sourceEventIds: readonly string[],
): void {
  acknowledgeLanguageSources(reviewed, personId, sourceEventIds);
}
