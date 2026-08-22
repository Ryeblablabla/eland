import type {
  ActionOption,
  GroundedConversationRef,
  GroundedConversationTopic,
} from '../domain/action';
import {
  agreementFactsForPerson,
  completedActionFactsForPerson,
  groundedConversationOpeningsForListener,
  hasGroundedConversationOpeningBasis,
  hasGroundedConversationResponse,
  planningOverlayEvents,
  worldEventById,
  worldEventsByIdsInHistoryOrder,
} from '../domain/event-index';
import type { ActionFact, EnvironmentFact, SimulationState, WorldEvent } from '../domain/model';
import { ageMonths, isAlive, isDehydratedHibernating, sameLocation, type PersonState } from '../domain/person';
import { intentsOwnedBy, personById } from '../domain/state-index';
import { cellsInRadius, findStandingPath } from '../world/grid';
import { knowsDeath, remainsById } from '../domain/mortuary';

interface ConversationCandidate {
  topic: GroundedConversationTopic;
  summary: string;
  reason: string;
  sourceFactIds: string[];
  factId?: string;
  priority: number;
}

const TOPIC_LABEL: Record<GroundedConversationTopic, string> = {
  care: '身体与照护',
  hardship: '自己的难处',
  gratitude: '感谢',
  'shared-work': '共同劳动',
  failure: '失败与挫折',
  discovery: '新发现',
  family: '共同养育',
  loss: '死亡与失去',
};

function resolvedSourceIds(state: SimulationState, sourceIds: string[]): string[] {
  return [...new Set(sourceIds)].filter((sourceId) => Boolean(worldEventById(state, sourceId))).sort();
}

function alreadyUsedBasis(state: SimulationState, basisKey: string): boolean {
  return hasGroundedConversationOpeningBasis(state, basisKey);
}

function openingAlreadyAnswered(state: SimulationState, openingEventId: string): boolean {
  return hasGroundedConversationResponse(state, openingEventId);
}

function basisKey(
  person: PersonState,
  other: PersonState,
  candidate: ConversationCandidate,
): string {
  return [
    'grounded-conversation-v1',
    `topic=${candidate.topic}`,
    `speaker=${person.id}`,
    `listener=${other.id}`,
    `sources=${candidate.sourceFactIds.join(',')}`,
  ].join('|');
}

function latestEvent(state: SimulationState, predicate: (event: WorldEvent) => boolean): WorldEvent | undefined {
  const overlay = planningOverlayEvents(state);
  for (let offset = overlay.length - 1; offset >= 0; offset -= 1) {
    const event = overlay[offset];
    if (predicate(event)) return event;
  }
  for (let offset = state.world.past.length - 1; offset >= 0; offset -= 1) {
    const event = state.world.past[offset];
    if (predicate(event)) return event;
  }
  return undefined;
}

function conditionPhrase(person: PersonState): { summary: string; sourceFactIds: string[] } | null {
  const condition = [...person.conditions]
    .filter((item) => item.kind !== 'pregnancy' && item.kind !== 'restrained')
    .sort((left, right) => right.stage - left.stage || right.sinceMonth - left.sinceMonth)[0];
  if (!condition) return null;
  const label = condition.kind === 'cold'
    ? '冷得厉害'
    : condition.kind === 'heat'
      ? '热得难受'
      : condition.kind === 'wound'
        ? '伤口还在疼'
        : condition.kind === 'illness'
          ? '身体一直不舒服'
          : condition.kind === 'aging'
            ? '身体越来越容易疲惫'
            : '缺水后身体还没有缓过来';
  return { summary: label, sourceFactIds: condition.sourceEventIds };
}

function gratitudeEvent(state: SimulationState, person: PersonState, other: PersonState): WorldEvent | undefined {
  const agreementIds = agreementFactsForPerson(state, person.id)
    .filter((event) => event.change === 'fulfilled' && event.partyIds.includes(other.id))
    .map((event) => event.id);
  const actionIds = completedActionFactsForPerson(state, other.id)
    .filter((event) => event.diff.caredPersonId === person.id
      || (event.action.kind === 'transfer'
        && event.action.to.kind === 'person'
        && event.action.to.personId === person.id))
    .map((event) => event.id);
  return worldEventsByIdsInHistoryOrder(state, [...agreementIds, ...actionIds]).at(-1);
}

function sharedProject(state: SimulationState, person: PersonState, other: PersonState) {
  return [...state.projects].reverse().find((project) => {
    const participantIds = new Set([project.ownerId, ...project.contributorIds]);
    const sources = [...project.completionEventIds, ...project.actionEventIds];
    return participantIds.has(person.id) && participantIds.has(other.id) && sources.length > 0;
  });
}

function birthEventForSharedChild(state: SimulationState, person: PersonState, other: PersonState): EnvironmentFact | undefined {
  const child = state.people.find((candidate) => isAlive(candidate)
    && candidate.geneticParents.includes(person.id)
    && candidate.geneticParents.includes(other.id));
  if (!child) return undefined;
  const birth = latestEvent(state, (event) => event.kind === 'environment'
    && event.change === 'body'
    && event.diff.bornPersonId === child.id);
  return birth?.kind === 'environment' ? birth : undefined;
}

function openingCandidates(state: SimulationState, person: PersonState, other: PersonState): ConversationCandidate[] {
  const candidates: ConversationCandidate[] = [];
  const otherCondition = conditionPhrase(other);
  if (otherCondition) candidates.push({
    topic: 'care',
    summary: `向${other.name}表达对其${otherCondition.summary}的关心，并邀请对方共同寻找缓解办法`,
    reason: `${other.name}眼下有真实的身体不适，关心可以从正在发生的处境开始`,
    sourceFactIds: resolvedSourceIds(state, otherCondition.sourceFactIds),
    priority: 90,
  });

  const ownCondition = conditionPhrase(person);
  if (ownCondition) candidates.push({
    topic: 'hardship',
    summary: `向${other.name}说明自己${ownCondition.summary}，并邀请对方回应当前困境`,
    reason: '本人正在承受有事件来源的身体压力，可以向身边人坦白自己的感受',
    sourceFactIds: resolvedSourceIds(state, ownCondition.sourceFactIds),
    priority: 68,
  });

  const gratitude = gratitudeEvent(state, person, other);
  if (gratitude) candidates.push({
    topic: 'gratitude',
    summary: `感谢${other.name}此前在本人需要帮助时给予物质、照护或履约支持`,
    reason: '对方曾真实给予物质、照护或完成双方约定，感谢有共同经历可追溯',
    sourceFactIds: [gratitude.id],
    priority: 86,
  });

  const project = sharedProject(state, person, other);
  if (project) {
    const sourceFactIds = resolvedSourceIds(state, [
      ...project.completionEventIds,
      ...project.actionEventIds,
    ]).slice(-4);
    candidates.push({
      topic: 'shared-work',
      summary: project.status === 'completed'
        ? `与${other.name}回顾双方已经完成“${project.summary}”的共同劳动`
        : `与${other.name}谈论双方正在推进“${project.summary}”的共同劳动`,
      reason: '双方都在同一项目留下了实际行动，可以谈共同劳动而不是抽象寒暄',
      sourceFactIds,
      priority: 82,
    });
  }

  const failure = [...person.memories]
    .filter((memory) => memory.kind === 'failure' && memory.personIds.includes(other.id))
    .sort((left, right) => right.createdAtMonth - left.createdAtMonth)[0]
    ?? [...person.memories]
      .filter((memory) => memory.kind === 'failure')
      .sort((left, right) => right.createdAtMonth - left.createdAtMonth)[0];
  if (failure) candidates.push({
    topic: 'failure',
    summary: `向${other.name}说明本人记得的失败“${failure.summary}”，并邀请对方一起复盘`,
    reason: '本人记得一次真实失败，可以向身边人表达挫折并寻求理解',
    sourceFactIds: resolvedSourceIds(state, failure.sourceEventIds),
    priority: 62,
  });

  const loss = [...(person.bereavements ?? [])]
    .filter((bereavement) => {
      const remains = remainsById(state, bereavement.remainsId);
      return Boolean(remains && !knowsDeath(other, remains.id) && worldEventById(state, bereavement.deathEventId));
    })
    .sort((left, right) => right.learnedAtMonth - left.learnedAtMonth || right.intensity - left.intensity)[0];
  if (loss) {
    const remains = remainsById(state, loss.remainsId);
    const deceased = remains ? personById(state, remains.personId) : undefined;
    if (deceased) candidates.push({
      topic: 'loss',
      summary: `告诉${other.name}${deceased.name}已经死亡，并谈起自己对这次失去的感受`,
      reason: '本人亲眼见过遗体或从有来源的交谈得知死讯，而对方尚不知道',
      sourceFactIds: [loss.deathEventId],
      priority: 88,
    });
  }

  const discovery = [...person.knowledge]
    .filter((fact) => (fact.kind === 'observation' || fact.kind === 'claim')
      && fact.confidence >= 55
      && !other.knowledge.some((known) => known.id === fact.id && known.confidence >= 55))
    .sort((left, right) => right.learnedAtMonth - left.learnedAtMonth || right.confidence - left.confidence)[0];
  if (discovery) candidates.push({
    topic: 'discovery',
    summary: `向${other.name}分享本人可靠掌握、对方尚未可靠掌握的发现“${discovery.summary}”`,
    reason: '本人有一项可靠且对方尚未可靠掌握的观察，可以把发现变成有回应的交谈',
    sourceFactIds: resolvedSourceIds(state, discovery.sourceEventIds),
    factId: discovery.id,
    priority: 58,
  });

  const birth = birthEventForSharedChild(state, person, other);
  if (birth) {
    const childName = typeof birth.diff.bornPersonName === 'string' ? birth.diff.bornPersonName : '孩子';
    candidates.push({
      topic: 'family',
      summary: `与${other.name}谈论共同养育${childName}的照护责任和双方疲惫`,
      reason: '双方共同养育一个真实出生并仍然活着的孩子，可以谈眼前的家庭生活',
      sourceFactIds: [birth.id],
      priority: 84,
    });
  }

  return candidates
    .filter((candidate) => candidate.sourceFactIds.length > 0)
    .sort((left, right) => right.priority - left.priority || left.topic.localeCompare(right.topic));
}

function openingOption(
  state: SimulationState,
  person: PersonState,
  other: PersonState,
  candidate: ConversationCandidate,
  atMonth: number,
): ActionOption | null {
  const conversationBasisKey = basisKey(person, other, candidate);
  if (alreadyUsedBasis(state, conversationBasisKey)) return null;
  const conversation: GroundedConversationRef = {
    version: 'grounded-conversation-v1',
    basisKey: conversationBasisKey,
    topic: candidate.topic,
    turn: 'opening',
    speakerId: person.id,
    listenerId: other.id,
    sourceFactIds: [...candidate.sourceFactIds],
  };
  const representationId = `conversation:${candidate.topic}:${atMonth}:${person.id}:${other.id}`;
  const conversationAction = {
    kind: 'communicate' as const,
    content: {
      id: representationId,
      kind: 'claim' as const,
      summary: candidate.summary,
      ...(candidate.factId ? { factId: candidate.factId } : {}),
      conversation,
    },
    audience: [other.id],
    channel: 'voice' as const,
  };
  const together = sameLocation(person, other);
  const path = together ? [] : findStandingPath(state.world.grid, person.position, other.position);
  if (!together && !path.length) return null;
  return {
    id: representationId,
    summary: together
      ? `与${other.name}谈${TOPIC_LABEL[candidate.topic]}：${candidate.summary}`
      : `去找${other.name}谈${TOPIC_LABEL[candidate.topic]}：${candidate.summary}`,
    reason: together ? candidate.reason : `${candidate.reason}；靠近后立即开始这次具体交谈`,
    goal: { kind: 'representation-made', representationId },
    nextAction: together
      ? conversationAction
      : { kind: 'move', toCellId: other.position.cellId, toZ: other.position.z },
    ...(!together ? { completionAction: conversationAction } : {}),
    target: { kind: 'person', personId: other.id },
    estimatedDuration: together ? 'one-month' : 'several-months',
    estimatedMonths: together ? 1 : Math.max(1, Math.ceil((path.length - 1) / 15)),
    risks: [],
    domain: 'social',
    sourceFactIds: [...candidate.sourceFactIds],
  };
}

function responseMeaning(topic: GroundedConversationTopic, guarded: boolean): string {
  if (guarded) return '已听见开场，但因当前恐惧和低信任保持戒备并暂缓深入回应';
  if (topic === 'care') return '接受对方的关心，并愿意共同寻找缓解身体不适的办法';
  if (topic === 'hardship') return '愿意倾听对方当前的困境，并共同考虑下一步';
  if (topic === 'gratitude') return '回应对方的感谢，并确认此前的帮助不构成债务';
  if (topic === 'shared-work') return '回应双方共同劳动的经历，并确认协作带来的陪伴感';
  if (topic === 'failure') return '接纳对方对失败的复盘请求，并愿意共同寻找遗漏环节';
  if (topic === 'discovery') return '愿意继续了解对方的新发现及其可能用途';
  if (topic === 'loss') return '听见并确认这次死亡，愿意陪对方谈论失去';
  return '回应共同养育话题，并愿意在照护孩子和彼此疲惫时互相支持';
}

function liveResponseOpeningIds(state: SimulationState, person: PersonState): Set<string> {
  const liveResponseOpeningIds = new Set<string>();
  for (const intent of intentsOwnedBy(state, person.id)) {
    if (intent.status !== 'active' && intent.status !== 'suspended') continue;
    for (const action of [intent.nextAction, intent.completionAction]) {
      if (action?.kind !== 'communicate'
        || action.content.kind !== 'claim'
        || action.content.conversation?.turn !== 'response'
        || !action.content.conversation.referenceEventId) continue;
      liveResponseOpeningIds.add(action.content.conversation.referenceEventId);
    }
  }
  return liveResponseOpeningIds;
}

function pendingOpening(state: SimulationState, person: PersonState, atMonth: number): ActionFact | undefined {
  const liveResponses = liveResponseOpeningIds(state, person);
  return [...groundedConversationOpeningsForListener(state, person.id)].reverse().find((event) => {
    if (atMonth - event.atMonth > 6
      || event.action.kind !== 'communicate'
      || event.action.content.kind !== 'claim') return false;
    const conversation = event.action.content.conversation;
    return conversation?.turn === 'opening'
      && conversation.listenerId === person.id
      && event.action.audience.includes(person.id)
      && !liveResponses.has(event.id)
      && !openingAlreadyAnswered(state, event.id);
  });
}

function responseOptionForOpening(
  state: SimulationState,
  person: PersonState,
  visiblePeople: PersonState[],
  opening: ActionFact,
): ActionOption | null {
  if (!opening || opening.action.kind !== 'communicate' || opening.action.content.kind !== 'claim') return null;
  const openingConversation = opening.action.content.conversation;
  if (!openingConversation) return null;
  const speakerCandidate = personById(state, openingConversation.speakerId);
  const speaker = speakerCandidate && isAlive(speakerCandidate) ? speakerCandidate : undefined;
  if (!speaker || (!sameLocation(person, speaker) && !visiblePeople.some((candidate) => candidate.id === speaker.id))) return null;
  const relation = person.relations.find((candidate) => candidate.personId === speaker.id);
  const guarded = (relation?.fear ?? 0) >= 35 && (relation?.trust ?? 0) < 8;
  const summary = responseMeaning(openingConversation.topic, guarded);
  const conversation: GroundedConversationRef = {
    ...openingConversation,
    turn: 'response',
    speakerId: person.id,
    listenerId: speaker.id,
    referenceEventId: opening.id,
    stance: guarded ? 'guarded' : 'supportive',
  };
  const representationId = `respond-conversation:${opening.id}:${person.id}`;
  const responseAction = {
    kind: 'communicate' as const,
    content: { id: representationId, kind: 'claim' as const, summary, conversation },
    audience: [speaker.id],
    channel: 'voice' as const,
  };
  if (sameLocation(person, speaker)) return {
    id: representationId,
    summary: `回应${speaker.name}关于${TOPIC_LABEL[openingConversation.topic]}的话：${summary}`,
    reason: '对方刚向自己说了一件有真实生活来源的事，需要给出明确回应',
    goal: { kind: 'representation-made', representationId },
    nextAction: responseAction,
    target: { kind: 'person', personId: speaker.id },
    estimatedDuration: 'one-month', estimatedMonths: 1, risks: [], domain: 'social',
    sourceFactIds: [opening.id, ...openingConversation.sourceFactIds],
  };
  const path = findStandingPath(state.world.grid, person.position, speaker.position);
  if (!path.length) return null;
  return {
    id: representationId,
    summary: `去找${speaker.name}，回应关于${TOPIC_LABEL[openingConversation.topic]}的话`,
    reason: '对方刚向自己说了一件有真实生活来源的事，靠近后给出明确回应',
    goal: { kind: 'representation-made', representationId },
    nextAction: { kind: 'move', toCellId: speaker.position.cellId, toZ: speaker.position.z },
    completionAction: responseAction,
    target: { kind: 'person', personId: speaker.id },
    estimatedDuration: 'several-months', estimatedMonths: Math.max(1, Math.ceil((path.length - 1) / 15)),
    risks: [], domain: 'social', sourceFactIds: [opening.id, ...openingConversation.sourceFactIds],
  };
}

function responseOption(
  state: SimulationState,
  person: PersonState,
  visiblePeople: PersonState[],
  atMonth: number,
): ActionOption | null {
  const opening = pendingOpening(state, person, atMonth);
  return opening ? responseOptionForOpening(state, person, visiblePeople, opening) : null;
}

export function hasGroundedConversationResponseOpportunity(
  state: SimulationState,
  person: PersonState,
  atMonth = state.clock.elapsedMonths,
): boolean {
  const radius = 4 + Math.floor(person.baselineCapacities.perception / 25);
  const visible = new Set(cellsInRadius(person.position.cellId, radius));
  const visiblePeople = state.people.filter((candidate) => candidate.id !== person.id
    && isAlive(candidate)
    && visible.has(candidate.position.cellId)
    && Math.abs(candidate.position.z - person.position.z) <= radius);
  return Boolean(responseOption(state, person, visiblePeople, atMonth));
}

export function buildGroundedConversationOptions(
  state: SimulationState,
  person: PersonState,
  visiblePeople: PersonState[],
  atMonth = state.clock.elapsedMonths,
): ActionOption[] {
  const requiredResponse = responseOption(state, person, visiblePeople, atMonth);
  if (requiredResponse) return [requiredResponse];
  return visiblePeople
    .filter((other) => ageMonths(other, atMonth) >= 12 * 12
      && !isDehydratedHibernating(other))
    .slice(0, 3)
    .flatMap((other) => openingCandidates(state, person, other)
      .map((candidate) => openingOption(state, person, other, candidate, atMonth))
      .filter((option): option is ActionOption => Boolean(option)));
}
