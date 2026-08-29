import type {
  ActionOption,
  GroundedConversationRef,
  GroundedConversationTopic,
} from '../domain/action';
import {
  GROUNDED_CONVERSATION_RESPONSE_WINDOW_MONTHS,
  createRememberedGroundedOpeningBasisSnapshot,
  groundedConversationOpeningsForListener,
  hasRecentGroundedConversationResponseForListener,
  hasRememberedGroundedConversationOpeningBasis,
  compareLiveSocialEvidenceDescriptors,
  liveSocialEvidenceForPersonSource,
  liveSocialEvidenceForPersonSources,
  planningOverlayEvents,
  retainedColdWorldEventsForLease,
  worldEventById,
  type RememberedGroundedOpeningBasisCompilationDiagnostics,
  type RememberedGroundedOpeningBasisSnapshot,
} from '../domain/event-index';
import type { ActionFact, EnvironmentFact, SimulationState, WorldEvent } from '../domain/model';
import { ageMonths, isAlive, isDehydratedHibernating, type PersonState } from '../domain/person';
import { intentsOwnedBy, personById } from '../domain/state-index';
import { cellsInRadius } from '../world/grid';
import { knowsDeath, remainsById } from '../domain/mortuary';
import { latestSharedProjectBetween } from '../domain/project-participant-index';
import { conversationalRendezvous, positionsWithinVoiceRange } from '../domain/social-space';
import { relationTo } from '../domain/relation';
import { agreementsForPerson } from '../domain/agreement';
import { livePersonSocialSourceEventIds, type LiveSocialEvidenceDescriptor } from '../domain/live-social-evidence';

interface ConversationCandidate {
  topic: GroundedConversationTopic;
  summary: string;
  reason: string;
  sourceFactIds: string[];
  factId?: string;
  priority: number;
}

export interface GroundedConversationCompilationDiagnostics
  extends RememberedGroundedOpeningBasisCompilationDiagnostics {
  rendezvousComputations: number;
  rendezvousComputationsByPair: Record<string, number>;
}

export interface GroundedConversationCompilationOptions {
  /** Test-only baseline switch; production always reuses one call-local snapshot. */
  reuseRememberedBasisSnapshot?: boolean;
  diagnostics?: GroundedConversationCompilationDiagnostics;
}

export function createGroundedConversationCompilationDiagnostics(): GroundedConversationCompilationDiagnostics {
  return {
    personSourceSnapshots: 0,
    exactLeaseIndexes: 0,
    sourceResolutions: 0,
    sourceResolutionsByPersonAndId: {},
    rendezvousComputations: 0,
    rendezvousComputationsByPair: {},
  };
}

const TOPIC_LABEL: Record<GroundedConversationTopic, string> = {
  everyday: '眼前的日常',
  reminiscence: '一起经历过的小事',
  playful: '轻松的玩笑',
  care: '身体与照护',
  hardship: '自己的难处',
  gratitude: '感谢',
  'shared-work': '共同劳动',
  failure: '失败与挫折',
  discovery: '新发现',
  family: '共同养育',
  loss: '死亡与失去',
};

const LOW_STAKES_TOPICS = ['everyday', 'reminiscence', 'playful'] as const;

function sharedLifeMomentMatches(
  event: LiveSocialEvidenceDescriptor,
  person: PersonState,
  other: PersonState,
): boolean {
  if (event.action) {
    return event.action.completed
      && event.action.actionKind !== 'communicate'
      && event.action.actorId === other.id
      && event.action.supportRecipientIds.includes(person.id);
  }
  if (event.agreementFulfilled) return true;
  if (!event.environment) return false;
  if (event.environment.change !== 'founding' && event.environment.change !== 'relationship') return false;
  const participants = new Set(event.environment.participantIds);
  return participants.has(person.id)
    && participants.has(other.id)
    && !event.environment.excludedPairKeys.includes([person.id, other.id].sort().join('|'));
}

function latestSharedLifeMoment(
  person: PersonState,
  other: PersonState,
  rememberedSources: RememberedGroundedOpeningBasisSnapshot,
): LiveSocialEvidenceDescriptor | undefined {
  return (relationTo(person, other.id)?.sourceEventIds ?? [])
    .flatMap((eventId) => rememberedSources.evidenceForPersonSource(person.id, eventId) ?? [])
    .filter((event) => sharedLifeMomentMatches(event, person, other))
    .sort(compareLiveSocialEvidenceDescriptors)
    .at(-1);
}

function lowStakesCandidate(
  person: PersonState,
  other: PersonState,
  moment: LiveSocialEvidenceDescriptor,
): ConversationCandidate {
  const ordinal = [...`${moment.eventId}:${person.id}:${other.id}`]
    .reduce((sum, character) => sum + (character.codePointAt(0) ?? 0), 0)
    % LOW_STAKES_TOPICS.length;
  const topic = LOW_STAKES_TOPICS[ordinal]!;
  if (topic === 'reminiscence') return {
    topic,
    summary: `与${other.name}想起此前一起生活或忙碌的一小段经历，问问对方还记得什么`,
    reason: '双方有一段可回放的共同生活经历，可以聊它留下的普通记忆，而不必讨论任务或承诺',
    sourceFactIds: [moment.eventId],
    priority: 52,
  };
  if (topic === 'playful') return {
    topic,
    summary: `拿双方经历过的小插曲开一个不伤人的玩笑，看看${other.name}愿不愿意一起笑一笑`,
    reason: '双方已有共同经历，轻松回应也可以成为生活的一部分，不需要服务于求偶或生产',
    sourceFactIds: [moment.eventId],
    priority: 50,
  };
  return {
    topic,
    summary: `问问${other.name}近来过得怎么样，也聊聊眼前的天气、吃食、休息和周围景象`,
    reason: '双方此刻自然相遇，又有可回放的共同生活来源，可以聊没有任务目的的日常近况',
    sourceFactIds: [moment.eventId],
    priority: 54,
  };
}

function resolvedSourceIds(
  state: SimulationState,
  owner: PersonState,
  sourceIds: string[],
): string[] {
  const owned = new Set(livePersonSocialSourceEventIds(owner));
  const uniqueSourceIds = [...new Set(sourceIds)];
  const resolvedOwned = new Set(liveSocialEvidenceForPersonSources(
    state,
    owner,
    uniqueSourceIds.filter((sourceId) => owned.has(sourceId)),
  ).map((evidence) => evidence.eventId));
  return uniqueSourceIds.filter((sourceId) => owned.has(sourceId)
    ? resolvedOwned.has(sourceId)
    : Boolean(worldEventById(state, sourceId))).sort();
}

function alreadyUsedBasis(
  rememberedSources: RememberedGroundedOpeningBasisSnapshot,
  person: PersonState,
  other: PersonState,
  basisKey: string,
): boolean {
  return rememberedSources.hasOpeningBasis(
    basisKey,
    person.id,
    other.id,
  );
}

function legacyRememberedGroundedOpeningBasisResolution(
  state: SimulationState,
): RememberedGroundedOpeningBasisSnapshot {
  return {
    hasOpeningBasis: (basisKey, speakerId, listenerId) => (
      hasRememberedGroundedConversationOpeningBasis(
        state,
        basisKey,
        speakerId,
        listenerId,
      )
    ),
    evidenceForPersonSource: (personId, eventId) => {
      const person = state.people.find((candidate) => candidate.id === personId && isAlive(candidate));
      return person ? liveSocialEvidenceForPersonSource(state, person, eventId) : undefined;
    },
  };
}

function openingAlreadyAnswered(
  state: SimulationState,
  listenerId: string,
  openingEventId: string,
): boolean {
  return hasRecentGroundedConversationResponseForListener(state, listenerId, openingEventId);
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

function latestEvent(
  state: SimulationState,
  predicate: (event: WorldEvent) => boolean,
  retainedCold: readonly WorldEvent[] = [],
): WorldEvent | undefined {
  const overlay = planningOverlayEvents(state);
  for (let offset = overlay.length - 1; offset >= 0; offset -= 1) {
    const event = overlay[offset];
    if (predicate(event)) return event;
  }
  for (let offset = state.world.past.length - 1; offset >= 0; offset -= 1) {
    const event = state.world.past[offset];
    if (predicate(event)) return event;
  }
  for (let offset = retainedCold.length - 1; offset >= 0; offset -= 1) {
    const event = retainedCold[offset];
    if (predicate(event)) return event;
  }
  return undefined;
}

function livingChildBirthLeaseKey(childId: string): string {
  return `gameplay:living-child:${childId}:birth`;
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

function gratitudeEvent(
  state: SimulationState,
  person: PersonState,
  other: PersonState,
  rememberedSources: RememberedGroundedOpeningBasisSnapshot,
): LiveSocialEvidenceDescriptor | undefined {
  const personallyHeldSourceIds = new Set([
    ...person.memories
      .filter((memory) => memory.personIds.includes(other.id))
      .flatMap((memory) => memory.sourceEventIds),
    ...(relationTo(person, other.id)?.sourceEventIds ?? []),
  ]);
  const fulfilledAgreements = agreementsForPerson(state, person.id)
    .filter((agreement) => agreement.status === 'fulfilled'
      && agreement.partyIds.includes(other.id)
      && agreement.fulfilledByPersonIds.includes(other.id));
  return [...personallyHeldSourceIds]
    .flatMap((eventId) => rememberedSources.evidenceForPersonSource(person.id, eventId) ?? [])
    .sort(compareLiveSocialEvidenceDescriptors)
    .filter((event) => {
      if (!event.action?.completed) return false;
      const directSupport = event.action.actorId === other.id
        && event.action.supportRecipientIds.includes(person.id);
      const fulfilledSupport = fulfilledAgreements.some((agreement) => (
        agreement.fulfillmentEventIds.includes(event.eventId)
      ));
      return directSupport || fulfilledSupport;
    })
    .at(-1);
}

function sharedProject(state: SimulationState, person: PersonState, other: PersonState) {
  return latestSharedProjectBetween(state, person.id, other.id);
}

function birthEventForSharedChild(state: SimulationState, person: PersonState, other: PersonState): EnvironmentFact | undefined {
  const child = state.people.find((candidate) => isAlive(candidate)
    && candidate.geneticParents.includes(person.id)
    && candidate.geneticParents.includes(other.id));
  if (!child) return undefined;
  const birth = latestEvent(
    state,
    (event) => event.kind === 'environment'
      && event.change === 'body'
      && event.diff.bornPersonId === child.id,
    retainedColdWorldEventsForLease(state, livingChildBirthLeaseKey(child.id)),
  );
  if (!birth && (state.world.historyCursor?.hotStartIndex ?? 0) > 0) {
    throw new Error(`living child ${child.id} 缺少已验证出生事实`);
  }
  return birth?.kind === 'environment' ? birth : undefined;
}

function openingCandidates(
  state: SimulationState,
  person: PersonState,
  other: PersonState,
  rememberedSources: RememberedGroundedOpeningBasisSnapshot,
): ConversationCandidate[] {
  const candidates: ConversationCandidate[] = [];
  const sharedMoment = latestSharedLifeMoment(person, other, rememberedSources);
  if (sharedMoment) candidates.push(lowStakesCandidate(person, other, sharedMoment));
  const otherCondition = conditionPhrase(other);
  if (otherCondition) candidates.push({
    topic: 'care',
    summary: `向${other.name}表达对其${otherCondition.summary}的关心，并邀请对方共同寻找缓解办法`,
    reason: `${other.name}眼下有真实的身体不适，关心可以从正在发生的处境开始`,
    sourceFactIds: resolvedSourceIds(state, other, otherCondition.sourceFactIds),
    priority: 90,
  });

  const ownCondition = conditionPhrase(person);
  if (ownCondition) candidates.push({
    topic: 'hardship',
    summary: `向${other.name}说明自己${ownCondition.summary}，并邀请对方回应当前困境`,
    reason: '本人正在承受有事件来源的身体压力，可以向身边人坦白自己的感受',
    sourceFactIds: resolvedSourceIds(state, person, ownCondition.sourceFactIds),
    priority: 68,
  });

  const gratitude = gratitudeEvent(state, person, other, rememberedSources);
  if (gratitude) candidates.push({
    topic: 'gratitude',
    summary: `感谢${other.name}此前在本人需要帮助时给予物质、照护或履约支持`,
    reason: '对方曾真实给予物质、照护或完成双方约定，感谢有共同经历可追溯',
    sourceFactIds: [gratitude.eventId],
    priority: 86,
  });

  const project = sharedProject(state, person, other);
  if (project) {
    const sourceFactIds = resolvedSourceIds(state, person, [
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
    sourceFactIds: resolvedSourceIds(state, person, failure.sourceEventIds),
    priority: 62,
  });

  const loss = [...(person.bereavements ?? [])]
    .filter((bereavement) => {
      const remains = remainsById(state, bereavement.remainsId);
      return Boolean(remains
        && !knowsDeath(other, remains.id)
        && liveSocialEvidenceForPersonSource(state, person, bereavement.deathEventId)
          ?.environment?.change === 'death');
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
    sourceFactIds: resolvedSourceIds(state, person, discovery.sourceEventIds),
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
  person: PersonState,
  other: PersonState,
  candidate: ConversationCandidate,
  atMonth: number,
  rememberedSources: RememberedGroundedOpeningBasisSnapshot,
  rendezvousForPair: () => ReturnType<typeof conversationalRendezvous>,
): ActionOption | null {
  const conversationBasisKey = basisKey(person, other, candidate);
  if (alreadyUsedBasis(rememberedSources, person, other, conversationBasisKey)) return null;
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
  const together = positionsWithinVoiceRange(person.position, other.position);
  if (LOW_STAKES_TOPICS.includes(candidate.topic as typeof LOW_STAKES_TOPICS[number])
    && !together) return null;
  const rendezvous = rendezvousForPair();
  if (!rendezvous) return null;
  const path = rendezvous.path;
  return {
    id: representationId,
    summary: together
      ? `与${other.name}谈${TOPIC_LABEL[candidate.topic]}：${candidate.summary}`
      : `去找${other.name}谈${TOPIC_LABEL[candidate.topic]}：${candidate.summary}`,
    reason: together ? candidate.reason : `${candidate.reason}；靠近后立即开始这次具体交谈`,
    goal: { kind: 'representation-made', representationId },
    nextAction: together
      ? conversationAction
      : { kind: 'move', toCellId: rendezvous.position.cellId, toZ: rendezvous.position.z },
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
  if (topic === 'everyday') return '说说自己近来的吃食、休息和心情，也问问对方今天过得怎样';
  if (topic === 'reminiscence') return '接住这段普通回忆，补上一件自己仍然记得的小事';
  if (topic === 'playful') return '听懂这个没有恶意的玩笑，也用一句轻松的话回应对方';
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
    if (atMonth - event.atMonth > GROUNDED_CONVERSATION_RESPONSE_WINDOW_MONTHS
      || event.action.kind !== 'communicate'
      || event.action.content.kind !== 'claim') return false;
    const conversation = event.action.content.conversation;
    return conversation?.turn === 'opening'
      && conversation.listenerId === person.id
      && event.action.audience.includes(person.id)
      && !liveResponses.has(event.id)
      && !openingAlreadyAnswered(state, person.id, event.id);
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
  if (!speaker || (!positionsWithinVoiceRange(person.position, speaker.position)
    && !visiblePeople.some((candidate) => candidate.id === speaker.id))) return null;
  const relation = relationTo(person, speaker.id);
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
  if (positionsWithinVoiceRange(person.position, speaker.position)) return {
    id: representationId,
    summary: `回应${speaker.name}关于${TOPIC_LABEL[openingConversation.topic]}的话：${summary}`,
    reason: '对方刚向自己说了一件有真实生活来源的事，需要给出明确回应',
    goal: { kind: 'representation-made', representationId },
    nextAction: responseAction,
    target: { kind: 'person', personId: speaker.id },
    estimatedDuration: 'one-month', estimatedMonths: 1, risks: [], domain: 'social',
    sourceFactIds: [opening.id, ...openingConversation.sourceFactIds],
  };
  const rendezvous = conversationalRendezvous(state, person, speaker);
  if (!rendezvous) return null;
  const path = rendezvous.path;
  return {
    id: representationId,
    summary: `去找${speaker.name}，回应关于${TOPIC_LABEL[openingConversation.topic]}的话`,
    reason: '对方刚向自己说了一件有真实生活来源的事，靠近后给出明确回应',
    goal: { kind: 'representation-made', representationId },
    nextAction: { kind: 'move', toCellId: rendezvous.position.cellId, toZ: rendezvous.position.z },
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
  compilationOptions: GroundedConversationCompilationOptions = {},
): ActionOption[] {
  const requiredResponse = responseOption(state, person, visiblePeople, atMonth);
  if (requiredResponse) return [requiredResponse];
  const listeners = visiblePeople
    .filter((other) => ageMonths(other, atMonth) >= 12 * 12
      && !isDehydratedHibernating(other))
    .slice(0, 3);
  const diagnostics = compilationOptions.diagnostics;
  const rememberedSources = compilationOptions.reuseRememberedBasisSnapshot === false
    ? legacyRememberedGroundedOpeningBasisResolution(state)
    : createRememberedGroundedOpeningBasisSnapshot(
      state,
      [person, ...listeners],
      diagnostics,
    );
  const rendezvousByListenerId = new Map<string, () => ReturnType<typeof conversationalRendezvous>>();
  const rendezvousFor = (other: PersonState) => {
    let current = rendezvousByListenerId.get(other.id);
    if (current) return current;
    let resolved = false;
    let rendezvous: ReturnType<typeof conversationalRendezvous> = null;
    current = () => {
      if (!resolved) {
        resolved = true;
        if (diagnostics) {
          diagnostics.rendezvousComputations += 1;
          const pairKey = JSON.stringify([person.id, other.id]);
          diagnostics.rendezvousComputationsByPair[pairKey] =
            (diagnostics.rendezvousComputationsByPair[pairKey] ?? 0) + 1;
        }
        rendezvous = conversationalRendezvous(state, person, other);
      }
      return rendezvous;
    };
    rendezvousByListenerId.set(other.id, current);
    return current;
  };
  return listeners
    .flatMap((other) => openingCandidates(state, person, other, rememberedSources)
      .map((candidate) => openingOption(
        person,
        other,
        candidate,
        atMonth,
        rememberedSources,
        rendezvousFor(other),
      ))
      .filter((option): option is ActionOption => Boolean(option)));
}
