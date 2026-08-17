import type { ActionFact, SimulationState } from './model';
import type { MemoryRecord, PersonState } from './person';

const MAX_MEMORIES = 24;
const MAX_PROJECTED_MEMORIES = 8;

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

export function remember(person: PersonState, memory: MemoryRecord): void {
  const existing = person.memories.find((item) => item.id === memory.id);
  if (existing) {
    existing.summary = memory.summary;
    existing.importance = Math.max(existing.importance, memory.importance);
    existing.lastRecalledAtMonth = Math.max(existing.lastRecalledAtMonth, memory.lastRecalledAtMonth);
    existing.personIds = [...new Set([...existing.personIds, ...memory.personIds])];
    existing.sourceEventIds = [...new Set([...existing.sourceEventIds, ...memory.sourceEventIds])].slice(-12);
    return;
  }
  person.memories.push(memory);
  person.memories = person.memories
    .sort((a, b) => {
      const aDurable = a.kind === 'commitment' ? 30 : a.kind === 'failure' ? 12 : 0;
      const bDurable = b.kind === 'commitment' ? 30 : b.kind === 'failure' ? 12 : 0;
      return b.importance + bDurable - (a.importance + aDurable) || b.createdAtMonth - a.createdAtMonth;
    })
    .slice(0, MAX_MEMORIES);
}

function score(memory: MemoryRecord, atMonth: number): number {
  const age = Math.max(0, atMonth - memory.createdAtMonth);
  const durable = memory.kind === 'commitment' ? 28 : memory.kind === 'failure' ? 12 : memory.kind === 'summary' ? 10 : 0;
  const activeCommitment = memory.kind === 'commitment' && (memory.expiresAtMonth ?? atMonth) >= atMonth ? 35 : 0;
  return memory.importance + durable + activeCommitment - Math.min(55, age * 1.4);
}

export function maintainMemories(state: SimulationState, atMonth: number): void {
  for (const person of state.people) {
    const retained = person.memories.filter((memory) => memory.kind === 'commitment' && (memory.expiresAtMonth ?? atMonth) >= atMonth);
    const candidates = person.memories
      .filter((memory) => !retained.includes(memory))
      .map((memory) => ({ memory, score: score(memory, atMonth) }))
      .filter(({ memory, score: value }) => value >= 12 || atMonth - memory.createdAtMonth <= 6)
      .sort((a, b) => b.score - a.score || b.memory.createdAtMonth - a.memory.createdAtMonth);
    const forgotten = person.memories.filter((memory) => !retained.includes(memory) && !candidates.some((item) => item.memory === memory));
    const summaries = forgotten.filter((memory) => memory.kind !== 'summary').slice(-6);
    const next = [...retained, ...candidates.map((item) => item.memory)]
      .sort((a, b) => score(b, atMonth) - score(a, atMonth))
      .slice(0, MAX_MEMORIES);
    if (summaries.length && !next.some((memory) => memory.id === `memory-summary-${person.id}-${Math.floor(atMonth / 12)}`)) {
      next.push({
        id: `memory-summary-${person.id}-${Math.floor(atMonth / 12)}`,
        kind: 'summary',
        summary: `较早经历：${summaries.map((memory) => memory.summary).join('；').slice(0, 260)}`,
        importance: clamp(Math.max(...summaries.map((memory) => memory.importance)) - 12),
        createdAtMonth: atMonth,
        lastRecalledAtMonth: atMonth,
        personIds: [...new Set(summaries.flatMap((memory) => memory.personIds))].slice(0, 5),
        sourceEventIds: [...new Set(summaries.flatMap((memory) => memory.sourceEventIds))].slice(-8),
      });
    }
    person.memories = next
      .sort((a, b) => score(b, atMonth) - score(a, atMonth))
      .slice(0, MAX_MEMORIES);
  }
}

export function projectMemories(person: PersonState, atMonth: number): Array<Pick<MemoryRecord, 'kind' | 'summary' | 'importance' | 'personIds'>> {
  const ranked = person.memories
    .filter((memory) => memory.kind !== 'commitment' || (memory.expiresAtMonth ?? atMonth) >= atMonth)
    .sort((a, b) => score(b, atMonth) - score(a, atMonth) || b.createdAtMonth - a.createdAtMonth);
  let dialogueCount = 0;
  return ranked
    .filter((memory) => memory.kind !== 'dialogue' || dialogueCount++ < 2)
    .slice(0, MAX_PROJECTED_MEMORIES)
    .map(({ kind, summary, importance, personIds }) => ({ kind, summary, importance, personIds }));
}

export function rememberAction(state: SimulationState, fact: ActionFact): void {
  const actor = state.people.find((person) => person.id === fact.who);
  if (!actor) return;
  const others = fact.action.kind === 'communicate'
    ? state.people.filter((person) => fact.action.kind === 'communicate' && fact.action.audience.includes(person.id))
    : [];
  const failed = fact.status === 'blocked' || fact.status === 'failed';
  const groundedCommunication = fact.action.kind === 'communicate'
    && fact.action.content.kind === 'claim'
    && Boolean(fact.action.content.conversation);
  const structuredCommunication = fact.action.kind === 'communicate'
    && (['request', 'offer', 'accept'].includes(fact.action.content.kind)
      || (fact.action.content.kind === 'claim' && Boolean(fact.action.content.factId)));
  remember(actor, {
    id: `memory:${fact.id}:${actor.id}`,
    kind: failed ? 'failure' : fact.action.kind === 'communicate' && ['request', 'offer', 'accept'].includes(fact.action.content.kind) ? 'commitment' : fact.action.kind === 'communicate' ? 'dialogue' : 'episode',
    summary: fact.result,
    importance: failed ? 72 : groundedCommunication ? 62 : structuredCommunication ? 64 : fact.action.kind === 'communicate' ? 42 : 38,
    createdAtMonth: fact.atMonth,
    lastRecalledAtMonth: fact.atMonth,
    personIds: others.map((person) => person.id),
    sourceEventIds: [fact.id],
    ...(fact.action.kind === 'communicate' && (fact.action.content.kind === 'request' || fact.action.content.kind === 'offer')
      ? { expiresAtMonth: fact.action.content.proposal?.expiresAtMonth ?? fact.atMonth + 6 }
      : {}),
  });
  if (fact.action.kind === 'act' && fact.action.operation === 'exert' && typeof fact.diff.victimId === 'string') {
    const victimId = fact.diff.victimId;
    const observerIds = Array.isArray(fact.diff.witnessedBy) ? fact.diff.witnessedBy.filter((id): id is string => typeof id === 'string') : [];
    for (const observerId of new Set([victimId, ...observerIds])) {
      const observer = state.people.find((person) => person.id === observerId);
      if (!observer || observer.id === actor.id) continue;
      const victim = state.people.find((person) => person.id === victimId);
      remember(observer, {
        id: `memory:${fact.id}:${observer.id}`,
        kind: 'episode',
        summary: observer.id === victimId
          ? `${actor.name}对自己施力并造成了${Number(fact.diff.damage) || 0}点伤害`
          : `亲眼看见${actor.name}对${victim?.name ?? '另一人'}施力并造成伤害`,
        importance: observer.id === victimId ? 96 : 78,
        createdAtMonth: fact.atMonth,
        lastRecalledAtMonth: fact.atMonth,
        personIds: [...new Set([actor.id, victimId])],
        sourceEventIds: [fact.id],
      });
    }
  }
  const personTransfer = fact.action.kind === 'transfer' && fact.action.from.kind === 'person' ? fact.action : undefined;
  if (personTransfer) {
    const transfer = personTransfer;
    const transferFrom = transfer.from;
    const transferTo = transfer.to;
    if (transferFrom.kind !== 'person') return;
    const sourceOwnerId = transferFrom.personId;
    const sourceOwner = state.people.find((person) => person.id === sourceOwnerId);
    const receiverId = transferTo.kind === 'person' ? transferTo.personId : undefined;
    const receiver = receiverId ? state.people.find((person) => person.id === receiverId) : undefined;
    const unauthorized = fact.diff.authorized === false;
    const observerIds = Array.isArray(fact.diff.witnessedBy) ? fact.diff.witnessedBy.filter((id): id is string => typeof id === 'string') : [];
    const participantIds = unauthorized ? [sourceOwner?.id, receiver?.id, ...observerIds] : [receiver?.id];
    for (const observerId of new Set(participantIds.filter((id): id is string => Boolean(id)))) {
      const observer = state.people.find((person) => person.id === observerId);
      if (!observer || observer.id === actor.id) continue;
      remember(observer, {
        id: `memory:${fact.id}:${observer.id}`,
        kind: 'episode',
        summary: unauthorized
          ? `${actor.name}未经允许试图从${sourceOwner?.name ?? '他人'}处取得物质：${fact.result}`
          : `${actor.name}把物质转交给自己：${fact.result}`,
        importance: unauthorized ? (observer.id === sourceOwner?.id ? 94 : 76) : 72,
        createdAtMonth: fact.atMonth,
        lastRecalledAtMonth: fact.atMonth,
        personIds: [...new Set([actor.id, ...(sourceOwner ? [sourceOwner.id] : []), ...(receiver ? [receiver.id] : [])])],
        sourceEventIds: [fact.id],
      });
    }
  }
  if (fact.action.kind === 'act' && typeof fact.diff.caredPersonId === 'string') {
    const cared = state.people.find((person) => person.id === fact.diff.caredPersonId);
    if (cared && cared.id !== actor.id) remember(cared, {
      id: `memory:${fact.id}:${cared.id}`,
      kind: 'episode',
      summary: `${actor.name}使用具体材料照护了自己的伤病`,
      importance: 84,
      createdAtMonth: fact.atMonth,
      lastRecalledAtMonth: fact.atMonth,
      personIds: [actor.id],
      sourceEventIds: [fact.id],
    });
  }
  if (fact.action.kind === 'act' && typeof fact.diff.restrainedPersonId === 'string' && typeof fact.diff.conditionId === 'string') {
    const restrainedId = fact.diff.restrainedPersonId;
    const observerIds = Array.isArray(fact.diff.witnessedBy) ? fact.diff.witnessedBy.filter((id): id is string => typeof id === 'string') : [];
    for (const observerId of new Set([restrainedId, ...observerIds])) {
      const observer = state.people.find((person) => person.id === observerId);
      if (!observer || observer.id === actor.id) continue;
      const restrained = state.people.find((person) => person.id === restrainedId);
      remember(observer, {
        id: `memory:${fact.id}:${observer.id}`, kind: 'episode',
        summary: observer.id === restrainedId ? `${actor.name}用绳拘束了我` : `亲眼看见${actor.name}用绳拘束${restrained?.name ?? '另一人'}`,
        importance: observer.id === restrainedId ? 98 : 82,
        createdAtMonth: fact.atMonth, lastRecalledAtMonth: fact.atMonth,
        personIds: [...new Set([actor.id, restrainedId])], sourceEventIds: [fact.id],
      });
    }
  }
  if (fact.action.kind !== 'communicate') return;
  const content = fact.action.content;
  const commitment = content.kind === 'request' || content.kind === 'offer' || content.kind === 'accept';
  for (const listener of others) {
    remember(listener, {
      id: `memory:${fact.id}:${listener.id}`,
      kind: commitment ? 'commitment' : 'dialogue',
      summary: fact.result,
      importance: commitment ? 82 : content.kind === 'claim' && content.factId ? 66 : 40,
      createdAtMonth: fact.atMonth,
      lastRecalledAtMonth: fact.atMonth,
      personIds: [actor.id],
      sourceEventIds: [fact.id],
      ...(content.kind === 'request' || content.kind === 'offer' ? { expiresAtMonth: content.proposal?.expiresAtMonth ?? fact.atMonth + 6 } : {}),
    });
  }
}
