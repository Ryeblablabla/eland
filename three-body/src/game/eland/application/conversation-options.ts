import type {
  ActionOption,
  GroundedConversationRef,
  GroundedConversationTopic,
  SourceOperation,
} from '../domain/action';
import { languageInterpreterIds } from '../domain/language-perception';
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
  worldEventById,
  type RememberedGroundedOpeningBasisCompilationDiagnostics,
  type RememberedGroundedOpeningBasisSnapshot,
} from '../domain/event-index';
import type {
  ActionFact,
  DecisionAuthorityState,
  EnvironmentFact,
  SimulationState,
  WorldEvent,
} from '../domain/model';
import { ageMonths, isAlive, isDehydratedHibernating, type PersonState } from '../domain/person';
import { intentsOwnedBy, personById } from '../domain/state-index';
import { cellX, cellY } from '../world/grid';
import { knowsDeath, remainsById } from '../domain/mortuary';
import { latestSharedProjectBetween } from '../domain/project-participant-index';
import { conversationalRendezvous, positionsCanShareLanguage } from '../domain/social-space';
import { relationTo } from '../domain/relation';
import { agreementsForPerson } from '../domain/agreement';
import { personalityScore } from '../domain/personality';
import { livePersonSocialSourceEventIds, type LiveSocialEvidenceDescriptor } from '../domain/live-social-evidence';
import {
  retrieveAgentMemories,
} from '../domain/agent-memory';

interface ConversationCandidate {
  topic: GroundedConversationTopic;
  summary: string;
  reason: string;
  sourceFactIds: string[];
  factId?: string;
  priority: number;
}

const OPERATION_CONVERSATION_LABEL: Record<SourceOperation, string> = {
  exert: '施力',
  separate: '分离或采收',
  combine: '材料试作',
  expose: '暴露处理',
  ingest: '摄入',
  reproduce: '生殖尝试',
  hunt: '狩猎',
  dehydrate: '进入脱水休眠',
  rehydrate: '协助补水恢复',
  inter: '实体交互',
};

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
    sourceIndexes: 0,
    sourceResolutions: 0,
    sourceResolutionsByPersonAndId: {},
    rendezvousComputations: 0,
    rendezvousComputationsByPair: {},
  };
}

const TOPIC_LABEL: Record<GroundedConversationTopic, string> = {
  open: '开放交谈',
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
const MAX_GROUNDED_CONVERSATION_LISTENERS = 3;

function sharedLifeMomentMatches(
  event: LiveSocialEvidenceDescriptor,
  person: PersonState,
  other: PersonState,
): boolean {
  if (event.action) {
    return event.action.completed
      && event.action.actionKind !== 'talk'
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
  other: PersonState,
  moment: LiveSocialEvidenceDescriptor,
): ConversationCandidate {
  const concreteSharedEpisode = Boolean(moment.action?.completed || moment.agreementFulfilled);
  if (concreteSharedEpisode) return {
    topic: 'reminiscence',
    summary: `与${other.name}谈论来源事实所记录的共同经历`,
    reason: '双方之间存在一项可回放的具体行动或履约经历；是否谈起以及如何评价仍由人物决定',
    sourceFactIds: [moment.eventId],
    priority: 52,
  };
  return {
    topic: 'everyday',
    summary: `与${other.name}围绕当前共处和近况开始日常交流`,
    reason: '双方只有共同抵达或普通共处来源；它只证明彼此熟悉，不能冒充一段具体回忆或有趣插曲',
    sourceFactIds: [moment.eventId],
    priority: 54,
  };
}

interface ListenerRelevance {
  person: PersonState;
  currentCondition: number;
  withinVoiceRange: number;
  sharedProject: number;
  sharedSourceCount: number;
  affinity: number;
  distance: number;
}

function listenerRelevance(
  state: SimulationState,
  person: PersonState,
  other: PersonState,
): ListenerRelevance {
  const relation = relationTo(person, other.id);
  const condition = conditionPhrase(other);
  return {
    person: other,
    currentCondition: condition
      && resolvedSourceIds(state, other, condition.sourceFactIds).length > 0 ? 1 : 0,
    withinVoiceRange: positionsCanShareLanguage(person.position, other.position) ? 1 : 0,
    sharedProject: latestSharedProjectBetween(state, person.id, other.id) ? 1 : 0,
    sharedSourceCount: resolvedSourceIds(state, person, relation?.sourceEventIds ?? []).length,
    affinity: (relation?.trust ?? 0) + (relation?.bond ?? 0) - (relation?.fear ?? 0),
    distance: Math.abs(cellX(person.position.cellId) - cellX(other.position.cellId))
      + Math.abs(cellY(person.position.cellId) - cellY(other.position.cellId))
      + Math.abs(person.position.z - other.position.z),
  };
}

function compareListenerRelevanceTier(left: ListenerRelevance, right: ListenerRelevance): number {
  return right.currentCondition - left.currentCondition
    || right.withinVoiceRange - left.withinVoiceRange
    || right.sharedProject - left.sharedProject
    || right.sharedSourceCount - left.sharedSourceCount
    || right.affinity - left.affinity
    || left.distance - right.distance;
}

function stableRotationBase(personId: string): number {
  return [...personId].reduce(
    (total, character, index) => total + (character.codePointAt(0) ?? 0) * (index + 1),
    0,
  );
}

function rotateListenerTies(
  candidates: ListenerRelevance[],
  speakerId: string,
  atMonth: number,
): ListenerRelevance[] {
  const ranked = [...candidates].sort((left, right) => (
    compareListenerRelevanceTier(left, right)
      || left.person.id.localeCompare(right.person.id)
  ));
  const rotated: ListenerRelevance[] = [];
  for (let start = 0; start < ranked.length;) {
    let end = start + 1;
    while (end < ranked.length
      && compareListenerRelevanceTier(ranked[start]!, ranked[end]!) === 0) end += 1;
    const tier = ranked.slice(start, end);
    const offset = tier.length > 1
      ? (stableRotationBase(speakerId) + Math.max(0, atMonth)) % tier.length
      : 0;
    rotated.push(...tier.slice(offset), ...tier.slice(0, offset));
    start = end;
  }
  return rotated;
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

function groundedFailureSources(
  state: SimulationState,
  owner: PersonState,
  memory: PersonState['memories'][number],
): string[] {
  const sourceFactIds = resolvedSourceIds(state, owner, memory.sourceEventIds);
  if (!sourceFactIds.length) return [];
  const causalCommunicationFailure = memory.causal?.actionKind === 'talk'
    && (memory.causal.outcome === 'blocked' || memory.causal.outcome === 'failed');
  const includesBlockedCommunication = sourceFactIds.some((sourceId) => {
    const source = worldEventById(state, sourceId);
    return source?.kind === 'action'
      && source.action.kind === 'talk'
      && (source.status === 'blocked' || source.status === 'failed');
  });
  // A failed attempt to start or answer a conversation is protocol noise, not
  // a life episode worth offering as the subject of yet another conversation.
  if (causalCommunicationFailure || includesBlockedCommunication) return [];
  // A completed opening may share an Intent with later physical work. Keep
  // the concrete physical facts as the failure basis, but never quote that
  // opening back into a new failure conversation.
  return sourceFactIds.filter((sourceId) => {
    const source = worldEventById(state, sourceId);
    return source?.kind !== 'action' || source.action.kind !== 'talk';
  });
}

function groundedFailureSubject(
  state: SimulationState,
  sourceFactIds: string[],
  fallback: string,
): string {
  const action = sourceFactIds
    .map((sourceId) => worldEventById(state, sourceId))
    .filter((source): source is ActionFact => source?.kind === 'action'
      && source.action.kind !== 'talk')
    .sort((left, right) => left.atMonth - right.atMonth
      || left.orderInMonth - right.orderInMonth)
    .at(-1);
  if (!action) return fallback;
  let actionLabel: string;
  switch (action.action.kind) {
    case 'move': actionLabel = '移动'; break;
    case 'transfer': actionLabel = '物资转移'; break;
    case 'attend': actionLabel = '观察'; break;
    case 'world-interact': actionLabel = '开放世界交互'; break;
    case 'act': actionLabel = OPERATION_CONVERSATION_LABEL[action.action.operation]; break;
    case 'talk': return fallback;
    case 'inscribe': actionLabel = '刻写记录'; break;
  }
  return action.status === 'blocked' || action.status === 'failed'
    ? `一次${actionLabel}没有完成：${action.result}`
    : `一次${actionLabel}完成后原目标仍未满足：${action.result}`;
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
  );
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
  if (sharedMoment) candidates.push(lowStakesCandidate(other, sharedMoment));
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

  const failures = [...person.memories]
    .filter((memory) => memory.kind === 'failure')
    .map((memory) => ({ memory, sourceFactIds: groundedFailureSources(state, person, memory) }))
    .filter((candidate) => candidate.sourceFactIds.length > 0)
    .sort((left, right) => right.memory.createdAtMonth - left.memory.createdAtMonth);
  const failure = failures.find((candidate) => candidate.memory.personIds.includes(other.id))
    ?? failures[0];
  if (failure) candidates.push({
    topic: 'failure',
    summary: `向${other.name}说明本人记得的失败“${groundedFailureSubject(
      state,
      failure.sourceFactIds,
      failure.memory.summary,
    )}”，并邀请对方一起复盘`,
    reason: '本人记得一次真实失败，可以向身边人表达挫折并寻求理解',
    sourceFactIds: failure.sourceFactIds,
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
      // A generic attention receipt proves only that somebody looked at a
      // target. It contains no communicable finding and must not be promoted
      // into a discovery merely to create something for people to say.
      && !fact.id.startsWith('target:')
      && fact.summary.trim() !== '持续观察了一个对象'
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
    sourceFactIds: [...candidate.sourceFactIds],
  };
  const representationId = `conversation:${candidate.topic}:${atMonth}:${person.id}:${other.id}`;
  const conversationAction = {
    kind: 'talk' as const,
    speakerMeaning: {
      id: representationId,
      kind: 'claim' as const,
      summary: candidate.summary,
      ...(candidate.factId ? { factId: candidate.factId } : {}),
      conversation,
    },
  };
  const together = positionsCanShareLanguage(person.position, other.position);
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

function openConversationGrounding(
  state: SimulationState,
  person: PersonState,
  other: PersonState,
): NonNullable<ActionOption['openConversationGrounding']> {
  const usedOpenSourceIds = rememberedOpenConversationSourceIds(state, person, other);
  const relationshipSources = resolvedSourceIds(
    state,
    person,
    relationTo(person, other.id)?.sourceEventIds ?? [],
  ).filter((sourceFactId) => !usedOpenSourceIds.has(sourceFactId)
    && !isGroundedConversationActionSource(state, sourceFactId));
  const facts: NonNullable<ActionOption['openConversationGrounding']>['facts'] = [];
  const seen = new Set<string>();
  const kindCounts = { memory: 0, knowledge: 0, relationship: 0 };
  const kindLimits = { memory: 6, knowledge: 6, relationship: 4 };
  const add = (
    kind: 'memory' | 'knowledge' | 'relationship',
    sourceFactId: string,
    summary: string,
    extra: { memoryKind?: string; knowledgeId?: string } = {},
  ) => {
    if (!sourceFactId
      || usedOpenSourceIds.has(sourceFactId)
      || isGroundedConversationActionSource(state, sourceFactId)
      || seen.has(sourceFactId)
      || kindCounts[kind] >= kindLimits[kind]) return;
    seen.add(sourceFactId);
    kindCounts[kind] += 1;
    facts.push({ kind, sourceFactId, summary, ...extra });
  };
  const recalled = retrieveAgentMemories(state, person, {
    atMonth: state.clock.elapsedMonths + 1,
    personIds: [other.id],
    unresolved: true,
    laneLimits: { episodic: 3, semantic: 3, social: 2, procedural: 1, prospective: 2, dialogue: 3 },
    limit: 12,
    tokenBudget: 1_000,
  });
  for (const memory of recalled) {
    const kind = memory.lane === 'semantic'
      ? 'knowledge' as const
      : memory.lane === 'social'
        ? 'relationship' as const
        : 'memory' as const;
    const knowledgeId = memory.topicKeys.find((topic) => topic.startsWith('knowledge-id:'))?.slice('knowledge-id:'.length);
    for (const sourceFactId of resolvedSourceIds(state, person, memory.sourceEventIds).slice(-1)) {
      add(kind, sourceFactId, memory.exactUtterance ?? memory.gist, {
        ...(kind === 'memory' ? { memoryKind: memory.lane } : {}),
        ...(kind === 'knowledge' && knowledgeId ? { knowledgeId } : {}),
      });
    }
  }
  // Prefer the person's concrete recollection or knowledge when the same
  // replayable event also anchors a relationship. Relationship evidence is a
  // safe subjective-presence fallback, not a generic summary that should hide
  // what the person actually remembers.
  for (const sourceFactId of relationshipSources.slice(-4)) {
    add('relationship', sourceFactId, `与${other.name}已有可回放的相识或共同经历来源`);
  }
  return {
    version: 'open-conversation-grounding-v1',
    fallbackSourceFactIds: relationshipSources.slice(-1),
    facts,
  };
}

function isGroundedConversationActionSource(state: DecisionAuthorityState, eventId: string): boolean {
  const event = worldEventById(state, eventId);
  return Boolean(event?.kind === 'action'
    && event.action.kind === 'talk'
    && event.action.speakerMeaning.kind === 'claim'
    && event.action.speakerMeaning.conversation);
}

function rememberedOpenConversationSourceIds(
  state: DecisionAuthorityState,
  person: PersonState,
  other: PersonState,
): Set<string> {
  const remembered = (state.memoryStore?.items ?? [])
    .filter((item) => item.ownerId === person.id
      && item.lane === 'dialogue'
      && item.personIds.includes(other.id)
      && item.topicKeys.includes('dialogue:open'))
    .flatMap((item) => item.sourceEventIds)
    .filter((eventId) => !isGroundedConversationActionSource(state, eventId));
  return new Set(remembered);
}

function openConversationBasisKey(
  speakerId: string,
  socialBasisPersonId: string,
  sourceFactIds: readonly string[],
): string {
  return [
    'grounded-conversation-v1',
    'topic=open',
    `speaker=${speakerId}`,
    `social-basis-person=${socialBasisPersonId}`,
    `sources=${[...sourceFactIds].sort().join(',')}`,
  ].join('|');
}

function openConversationOption(
  state: SimulationState,
  person: PersonState,
  other: PersonState,
  atMonth: number,
): ActionOption | null {
  const id = `conversation:open:${atMonth}:${person.id}:${other.id}`;
  const grounding = openConversationGrounding(state, person, other);
  // An empty model selection is only executable when the server already owns
  // a replayable shared-history anchor. Do not advertise a candidate that can
  // fail merely because the model speaks subjectively and selects no facts.
  if (!grounding.fallbackSourceFactIds.length) return null;
  const conversation: GroundedConversationRef = {
    version: 'grounded-conversation-v1',
    basisKey: '',
    topic: 'open',
    turn: 'opening',
    sourceFactIds: [...grounding.fallbackSourceFactIds],
  };
  conversation.basisKey = openConversationBasisKey(person.id, other.id, conversation.sourceFactIds);
  return {
    id,
    summary: `与${other.name}进行开放交谈`,
    reason: '眼前这个人唤起了可回放经历；是否开口以及附近谁能听清，由人物与传播结果共同决定',
    goal: { kind: 'representation-made', representationId: id },
    nextAction: {
      kind: 'talk',
      speakerMeaning: { id, kind: 'claim', summary: `与${other.name}进行开放交谈`, conversation },
    },
    target: { kind: 'person', personId: other.id },
    estimatedDuration: 'one-month',
    estimatedMonths: 1,
    risks: [],
    domain: 'social',
    sourceFactIds: [...grounding.fallbackSourceFactIds],
    openConversationGrounding: grounding,
  };
}

/** Rebind a model-selected open utterance to only the request-authorized facts. */
export function compileOpenConversationOption(
  state: DecisionAuthorityState,
  person: PersonState,
  option: ActionOption,
  selectedSourceFactIds: readonly string[] = [],
): ActionOption | null {
  const grounding = option.openConversationGrounding;
  const action = option.completionAction ?? option.nextAction;
  if (!grounding
    || action.kind !== 'talk'
    || action.speakerMeaning.kind !== 'claim'
    || action.speakerMeaning.conversation?.topic !== 'open'
    || action.speakerMeaning.conversation.turn !== 'opening') return null;
  const conversation = action.speakerMeaning.conversation;
  const socialBasisPersonId = option.target?.kind === 'person' ? option.target.personId : undefined;
  if (!socialBasisPersonId) return null;
  const requested = [...new Set(selectedSourceFactIds)];
  const allowed = new Set(grounding.facts.map((fact) => fact.sourceFactId));
  if (requested.length > 3 || requested.some((sourceFactId) => !allowed.has(sourceFactId))) return null;
  const sourceFactIds = requested.length
    ? requested
    : [...grounding.fallbackSourceFactIds];
  if (!sourceFactIds.length) return null;
  const listener = personById(state, socialBasisPersonId);
  if (!listener) return null;
  const usedOpenSourceIds = rememberedOpenConversationSourceIds(state, person, listener);
  if (sourceFactIds.every((sourceFactId) => usedOpenSourceIds.has(sourceFactId))) return null;
  const compiledConversation: GroundedConversationRef = {
    ...conversation,
    basisKey: openConversationBasisKey(person.id, socialBasisPersonId, sourceFactIds),
    sourceFactIds,
    openGroundingCompiled: true,
  };
  if (hasRememberedGroundedConversationOpeningBasis(
    state,
    compiledConversation.basisKey,
    person.id,
    socialBasisPersonId,
  )) return null;
  const compiledAction = {
    ...action,
    speakerMeaning: { ...action.speakerMeaning, conversation: compiledConversation },
  };
  return {
    ...option,
    sourceFactIds,
    ...(option.completionAction
      ? { completionAction: compiledAction }
      : { nextAction: compiledAction }),
  };
}

function liveResponseOpeningIds(state: SimulationState, person: PersonState): Set<string> {
  const liveResponseOpeningIds = new Set<string>();
  for (const intent of intentsOwnedBy(state, person.id)) {
    if (intent.status !== 'active' && intent.status !== 'suspended') continue;
    for (const action of [intent.nextAction, intent.completionAction]) {
      if (action?.kind !== 'talk'
        || action.speakerMeaning.kind !== 'claim'
        || action.speakerMeaning.conversation?.turn !== 'response'
        || !action.speakerMeaning.conversation.referenceEventId) continue;
      liveResponseOpeningIds.add(action.speakerMeaning.conversation.referenceEventId);
    }
  }
  return liveResponseOpeningIds;
}

function pendingOpening(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
): { opening: ActionFact } | undefined {
  const liveResponses = liveResponseOpeningIds(state, person);
  const opening = [...groundedConversationOpeningsForListener(state, person.id)].reverse().find((event) => {
    if (atMonth - event.atMonth > GROUNDED_CONVERSATION_RESPONSE_WINDOW_MONTHS
      || event.action.kind !== 'talk'
      || event.action.speakerMeaning.kind !== 'claim') return false;
    const conversation = event.action.speakerMeaning.conversation;
    return conversation?.turn === 'opening'
      && languageInterpreterIds(event.diff, event.action.speakerMeaning.id).includes(person.id)
      && !liveResponses.has(event.id)
      && !openingAlreadyAnswered(state, person.id, event.id);
  });
  return opening ? { opening } : undefined;
}

function responseOptionForOpening(
  state: SimulationState,
  person: PersonState,
  opening: ActionFact,
): ActionOption | null {
  if (!opening || opening.action.kind !== 'talk' || opening.action.speakerMeaning.kind !== 'claim') return null;
  const openingConversation = opening.action.speakerMeaning.conversation;
  if (!openingConversation) return null;
  const speakerCandidate = personById(state, opening.who);
  const speaker = speakerCandidate && isAlive(speakerCandidate) ? speakerCandidate : undefined;
  if (!speaker || !positionsCanShareLanguage(person.position, speaker.position)) return null;
  const acknowledgementByTopic: Record<GroundedConversationTopic, string> = {
    open: `回应${speaker.name}：我听见了你基于共同经历说的这些事`,
    everyday: `回应${speaker.name}：我听见了你谈起的眼前日常`,
    reminiscence: `回应${speaker.name}：我也记得这段共同经历`,
    playful: `回应${speaker.name}：我听懂了你说的这件趣事`,
    care: `回应${speaker.name}的关切：我听见了，也会留意眼前的身体处境`,
    hardship: `回应${speaker.name}：我听见了你正在承受的困难`,
    gratitude: `回应${speaker.name}：我接受这份基于真实帮助的感谢`,
    'shared-work': `回应${speaker.name}：我记得我们共同完成的这段劳动`,
    failure: `回应${speaker.name}：这次失败已有明确来源，应保留结果而不是空转重复`,
    discovery: `回应${speaker.name}：我已经听到这项发现，并记住它的事实来源`,
    family: `回应${speaker.name}：我听见了共同照护中的责任和疲惫`,
    loss: `回应${speaker.name}：我听见了这次真实的失去`,
  };
  const questionByTopic: Partial<Record<GroundedConversationTopic, string>> = {
    failure: `回应${speaker.name}：这次失败是否只排除了当时的材料与条件，还是还有别的证据？`,
    discovery: `回应${speaker.name}：这项发现是在什么可观察条件下成立的，哪些部分还没有确认？`,
  };
  const answerByTopic: Partial<Record<GroundedConversationTopic, string>> = {
    failure: `回应${speaker.name}的问题：目前只能确认原材料和当时条件下的失败，不能把结论扩大到没有试过的办法`,
    discovery: `回应${speaker.name}的问题：目前可靠的只有原来那组观察来源，其他条件仍需要重新验证`,
  };
  const curiosity = (person.baselineCapacities.cognition + personalityScore(person, 'openness')) / 2;
  const asksGroundedQuestion = openingConversation.turn === 'opening'
    && questionByTopic[openingConversation.topic]
    && curiosity >= 58;
  const answersQuestion = openingConversation.turn === 'response'
    && openingConversation.move === 'question'
    && answerByTopic[openingConversation.topic];
  const move = asksGroundedQuestion ? 'question' as const : 'acknowledge' as const;
  const summary = answersQuestion
    ? answerByTopic[openingConversation.topic]!
    : asksGroundedQuestion
      ? questionByTopic[openingConversation.topic]!
      : acknowledgementByTopic[openingConversation.topic];
  const { stance: _priorStance, move: _priorMove, ...sharedConversation } = openingConversation;
  const conversation: GroundedConversationRef = {
    ...sharedConversation,
    turn: 'response',
    referenceEventId: opening.id,
    move,
  };
  const representationId = `respond-conversation:${opening.id}:${person.id}`;
  const responseAction = {
    kind: 'talk' as const,
    speakerMeaning: { id: representationId, kind: 'claim' as const, summary, conversation },
  };
  return {
    id: representationId,
    summary,
    reason: asksGroundedQuestion
      ? '对方提出了有来源的失败或发现；本人认知与开放性使尚未确认的边界成为一个真实问题，但仍可选择把注意力留给其他事情'
      : answersQuestion
        ? '对方围绕原事实提出了具体问题；本人只能回答现有来源真正支持的范围，不能补造结论'
        : '对方刚向自己发起有来源的交流；人物可以确认听见，也可以把注意力留给其他事情',
    goal: { kind: 'representation-made', representationId },
    nextAction: responseAction,
    target: { kind: 'person', personId: speaker.id },
    estimatedDuration: 'one-month', estimatedMonths: 1, risks: [], domain: 'social',
    sourceFactIds: [opening.id, ...openingConversation.sourceFactIds],
  };
}

function responseOption(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
): ActionOption | null {
  const opening = pendingOpening(state, person, atMonth);
  return opening ? responseOptionForOpening(state, person, opening.opening) : null;
}

export function hasGroundedConversationResponseOpportunity(
  state: SimulationState,
  person: PersonState,
  atMonth = state.clock.elapsedMonths,
): boolean {
  return Boolean(responseOption(state, person, atMonth));
}

export function buildGroundedConversationOptions(
  state: SimulationState,
  person: PersonState,
  visiblePeople: PersonState[],
  atMonth = state.clock.elapsedMonths,
  compilationOptions: GroundedConversationCompilationOptions = {},
): ActionOption[] {
  const optionalResponse = responseOption(state, person, atMonth);
  const listeners = visiblePeople
    .filter((other) => ageMonths(other, atMonth) >= 12 * 12
      && !isDehydratedHibernating(other))
    .map((other) => listenerRelevance(state, person, other));
  const relevantListeners = rotateListenerTies(listeners, person.id, atMonth)
    .slice(0, MAX_GROUNDED_CONVERSATION_LISTENERS)
    .map((candidate) => candidate.person);
  const diagnostics = compilationOptions.diagnostics;
  const rememberedSources = compilationOptions.reuseRememberedBasisSnapshot === false
    ? legacyRememberedGroundedOpeningBasisResolution(state)
    : createRememberedGroundedOpeningBasisSnapshot(
      state,
      [person, ...relevantListeners],
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
  const openings = relevantListeners
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
  const openConversations = relevantListeners
    .map((other) => openConversationOption(state, person, other, atMonth))
    .filter((option): option is ActionOption => Boolean(option));
  return optionalResponse
    ? [optionalResponse, ...openConversations, ...openings]
    : [...openConversations, ...openings];
}
