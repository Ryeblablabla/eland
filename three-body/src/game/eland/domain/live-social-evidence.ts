import type { PrimitiveAction, RepresentationInput } from './action';
import type { WorldEvent } from './model';
import { materialDefinition, materialHas } from './material';
import type { PersonId, PersonState, RelationshipEvidenceAnchor } from './person';
import { relationshipEvidenceSourceEventIds } from './relation';
import { languageBroadcastFromDiff } from './language-perception';

export const LIVE_PERSON_SOCIAL_EVENT_ID_LIMIT = 4_096;
export const LIVE_PERSON_SOCIAL_DESCRIPTOR_SOURCE_ID_LIMIT = 4_096;

export type LivePersonSocialStrictEvidenceKind =
  | 'electrical-remote-work'
  | 'measurement-uncertainty';

interface SourceArraySnapshot<T> {
  array: readonly T[];
  length: number;
  first?: T;
  last?: T;
}

interface LivePersonSocialSourceCache {
  stringSources: SourceArraySnapshot<string>[];
  anchorSources: SourceArraySnapshot<RelationshipEvidenceAnchor>[];
  deathEventIds: string[];
  eventIds: string[];
}

const livePersonSocialSourceCaches = new WeakMap<PersonState, LivePersonSocialSourceCache>();
const EMPTY_SOCIAL_SOURCE_IDS: readonly string[] = Object.freeze([]);
const EMPTY_RELATIONSHIP_ANCHORS: readonly RelationshipEvidenceAnchor[] = Object.freeze([]);

function sourceSnapshot<T>(array: readonly T[]): SourceArraySnapshot<T> {
  return { array, length: array.length, first: array[0], last: array.at(-1) };
}

function sameSourceSnapshots<T>(
  previous: readonly SourceArraySnapshot<T>[],
  current: readonly (readonly T[])[],
): boolean {
  return previous.length === current.length && current.every((array, index) => {
    const snapshot = previous[index];
    return snapshot?.array === array
      && snapshot.length === array.length
      && snapshot.first === array[0]
      && snapshot.last === array.at(-1);
  });
}

function currentSocialSourceArrays(person: PersonState): {
  stringSources: readonly (readonly string[])[];
  anchorSources: readonly (readonly RelationshipEvidenceAnchor[])[];
  deathEventIds: string[];
} {
  const stringSources: (readonly string[])[] = [
    ...person.memories.map((memory) => memory.sourceEventIds),
    ...person.conditions.map((condition) => condition.sourceEventIds),
    ...person.relations.map((relation) => relation.sourceEventIds),
    ...(person.bereavements ?? []).map((bereavement) => bereavement.sourceEventIds),
    person.maternalTeachingSourceEventIds ?? EMPTY_SOCIAL_SOURCE_IDS,
  ];
  const anchorSources = person.relations.flatMap((relation) => {
    const ledger = relation.evidenceLedger?.version === 'relationship-evidence-ledger-v1'
      ? relation.evidenceLedger
      : undefined;
    return ledger ? [
      ledger.substantive,
      ledger.directIntimacy,
      ledger.sharedLife,
      ledger.decisionBoundaries ?? EMPTY_RELATIONSHIP_ANCHORS,
    ] : [];
  });
  return {
    stringSources,
    anchorSources,
    deathEventIds: (person.bereavements ?? []).map((bereavement) => bereavement.deathEventId),
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Source lists use append-or-replace mutation in the authoritative engine.
 * Cache validation therefore compares every lane identity plus its boundary
 * elements; append, replacement, reordering and the current push-based
 * condition updates all invalidate without hashing thousands of IDs. The
 * cache is disposable and never serialized or used as domain authority.
 */
export function livePersonSocialSourceEventIds(person: PersonState): string[] {
  const current = currentSocialSourceArrays(person);
  const cached = livePersonSocialSourceCaches.get(person);
  if (cached
    && sameSourceSnapshots(cached.stringSources, current.stringSources)
    && sameSourceSnapshots(cached.anchorSources, current.anchorSources)
    && sameStrings(cached.deathEventIds, current.deathEventIds)) return cached.eventIds;
  const values = [
    ...person.memories.flatMap((memory) => memory.sourceEventIds),
    ...person.conditions.flatMap((condition) => condition.sourceEventIds),
    ...person.relations.flatMap((relation) => relationshipEvidenceSourceEventIds(relation)),
    ...(person.bereavements ?? []).flatMap((bereavement) => [
      bereavement.deathEventId,
      ...bereavement.sourceEventIds,
    ]),
    ...(person.maternalTeachingSourceEventIds ?? []),
  ];
  if (values.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new Error(`living person ${person.id} social sources 含空事件 ID`);
  }
  const eventIds = [...new Set(values)].sort();
  if (eventIds.length > LIVE_PERSON_SOCIAL_EVENT_ID_LIMIT) {
    throw new Error(
      `living person ${person.id} social source IDs 超出有界续接上限 ${LIVE_PERSON_SOCIAL_EVENT_ID_LIMIT}`,
    );
  }
  livePersonSocialSourceCaches.set(person, {
    stringSources: current.stringSources.map(sourceSnapshot),
    anchorSources: current.anchorSources.map(sourceSnapshot),
    deathEventIds: current.deathEventIds,
    eventIds,
  });
  return eventIds;
}

/**
 * Exact raw bodies read while testing current inventory stacks for a possible
 * measurement-uncertainty basis. Memory/knowledge only contributes identity
 * membership; the reader dereferences the current stack provenance itself.
 */
export function measurementUncertaintyRawSourceEventIds(person: PersonState): string[] {
  const values = person.inventory.flatMap((stack) => {
    if (stack.quantity <= 0
      || stack.recordPayloadId
      || stack.sourceEventIds.length === 0
      || stack.sourceEventIds.length > 24
      || new Set(stack.sourceEventIds).size !== stack.sourceEventIds.length) return [];
    const definition = materialDefinition(stack.materialId);
    if (definition.phase !== 'solid'
      || !(definition.mass > 0)
      || materialHas(stack.materialId, 'instrument')
      || materialHas(stack.materialId, 'mass-reference')) return [];
    return stack.sourceEventIds;
  });
  if (values.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new Error(`living person ${person.id} measurement source 含空事件 ID`);
  }
  const eventIds = [...new Set(values)].sort();
  if (eventIds.length > LIVE_PERSON_SOCIAL_EVENT_ID_LIMIT) {
    throw new Error(
      `living person ${person.id} measurement raw sources 超出 ${LIVE_PERSON_SOCIAL_EVENT_ID_LIMIT} 条上限`,
    );
  }
  return eventIds;
}

function proposalSubject(content: Extract<RepresentationInput, { kind: 'request' | 'offer' }>): string | null {
  if (content.kind === 'request' && content.techniqueDemonstration) {
    return `request:technique:${content.techniqueDemonstration.projectId}:${content.techniqueDemonstration.desiredFunction}`;
  }
  if (content.kind === 'request' && content.projectKnowledgeRequest) {
    return `request:project-knowledge:${content.projectKnowledgeRequest.projectId}:${content.projectKnowledgeRequest.outputMaterialId}`;
  }
  if (content.kind === 'request' && content.projectMaterialContribution) {
    const request = content.projectMaterialContribution;
    return `request:project-material:${request.projectId}:${request.materialId}`;
  }
  const proposal = content.proposal;
  if (!proposal) return null;
  if (proposal.kind === 'assist') return `${content.kind}:assist:${proposal.need}`;
  if (proposal.kind === 'membership') return `${content.kind}:membership:${proposal.collectiveId}:${proposal.candidateId}`;
  if (proposal.kind === 'permission') return `${content.kind}:permission:${proposal.collectiveId}:${proposal.materialId}:${proposal.granteeId}`;
  if (proposal.kind === 'decision-rule') return proposal.scope === 'coordinate-material'
    ? `${content.kind}:decision-rule:${proposal.collectiveId}:${proposal.scope}:${proposal.materialId}`
    : `${content.kind}:decision-rule:${proposal.collectiveId}:${proposal.scope}:${proposal.projectDuty.projectKind}:${proposal.projectDuty.desiredFunction}:${proposal.projectDuty.progressKind}`;
  if (proposal.kind === 'mandate') return `${content.kind}:mandate:${proposal.collectiveId}:${proposal.decisionRuleId}:${proposal.holderId}:${proposal.projectId ?? 'material'}`;
  if (proposal.kind === 'exchange') {
    const materials = [proposal.offererMaterialId, proposal.partnerMaterialId]
      .sort((left, right) => left - right);
    return `${content.kind}:exchange:${materials.join(':')}`;
  }
  return `${content.kind}:${proposal.kind}`;
}

function semanticSubject(action: Extract<PrimitiveAction, { kind: 'talk' }>): string | null {
  const content = action.speakerMeaning;
  if (content.kind === 'claim') {
    if (content.conversation) return `claim:conversation:${content.conversation.topic}`;
    if (content.factId) return `claim:fact:${content.factId}`;
    return `claim:${content.id.split(':')[0] ?? 'situation'}`;
  }
  if (content.kind === 'prediction') return `prediction:${content.prediction.targetEpoch}`;
  if (content.kind === 'request' || content.kind === 'offer') {
    return proposalSubject(content) ?? `${content.kind}:${content.id.split(':')[0] ?? 'situation'}`;
  }
  return null;
}

export function liveSocialCommunicationSubjectKey(
  action: Extract<PrimitiveAction, { kind: 'talk' }>,
): string | null {
  return semanticSubject(action);
}

export interface LiveSocialGroundedConversationDescriptor {
  basisKey: string;
  topic: string;
  turn: 'opening' | 'response';
  speakerId: PersonId;
  listenerId: PersonId;
  sourceFactIds: readonly string[];
  referenceEventId?: string;
  stance?: 'supportive' | 'guarded';
  basisVerified: boolean;
}

export interface LiveSocialCommunicationDescriptor {
  perceivedByPersonIds: readonly PersonId[];
  understoodByPersonIds: readonly PersonId[];
  subjectKey?: string;
  basisSourceEventIds: readonly string[];
  groundedConversation?: LiveSocialGroundedConversationDescriptor;
}

export interface LiveSocialEvidenceDescriptor {
  eventId: string;
  atMonth: number;
  orderInMonth: number;
  planningTick: number;
  orderInTick: number;
  action?: {
    actorId: PersonId;
    intentId?: string;
    status: string;
    actionKind: PrimitiveAction['kind'];
    completed: boolean;
    communication?: LiveSocialCommunicationDescriptor;
    supportRecipientIds: readonly PersonId[];
    blockedDelivery?: {
      dropId: string;
      projectId: string;
      requestEventId: string;
    };
  };
  agreementFulfilled: boolean;
  electricalRemoteWorkEligible: boolean;
  measurementUncertaintyEligible: boolean;
  environment?: {
    change: string;
    participantIds: readonly PersonId[];
    excludedPairKeys: readonly string[];
    bornPersonId?: PersonId;
  };
}

function canonicalStringIds(values: unknown, label: string): string[] {
  if (!Array.isArray(values)
    || values.length > LIVE_PERSON_SOCIAL_DESCRIPTOR_SOURCE_ID_LIMIT
    || values.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new Error(`${label} 无效或超界`);
  }
  return [...new Set(values as string[])].sort();
}

function actionStaticBasisSourceIds(event: Extract<WorldEvent, { kind: 'action' }>): string[] {
  if (event.action.kind !== 'talk') return [];
  const content = event.action.speakerMeaning;
  const conversationSources = content.kind === 'claim'
    ? content.conversation?.sourceFactIds ?? []
    : [];
  const relationshipSources = (content.kind === 'request' || content.kind === 'offer')
    && (content.proposal?.kind === 'companion' || content.proposal?.kind === 'reproduce')
    ? content.proposal.basis?.sourceFactIds ?? []
    : [];
  const assertedSources = Array.isArray(event.diff.assertedFactSourceEventIds)
    ? event.diff.assertedFactSourceEventIds.filter(
      (eventId): eventId is string => typeof eventId === 'string' && eventId.length > 0,
    )
    : [];
  return canonicalStringIds(
    [...conversationSources, ...relationshipSources, ...assertedSources],
    `live social communication ${event.id} basis sources`,
  );
}

export function liveSocialEvidenceDescriptorFromWorldEvent(
  event: WorldEvent,
): LiveSocialEvidenceDescriptor {
  const action = event.kind === 'action' ? event : undefined;
  const communication = action?.action.kind === 'talk'
    ? action.action
    : undefined;
  const content = communication?.speakerMeaning;
  const conversation = content?.kind === 'claim' ? content.conversation : undefined;
  const languageBroadcast = action ? languageBroadcastFromDiff(action.diff) : undefined;
  const supportRecipientIds = action ? [
    ...(typeof action.diff.caredPersonId === 'string' ? [action.diff.caredPersonId] : []),
    ...(action.action.kind === 'transfer'
      && action.action.to.kind === 'person' ? [action.action.to.personId] : []),
  ] : [];
  const blockedDelivery = action
    && action.status === 'blocked'
    && action.action.kind === 'transfer'
    && action.action.from.kind === 'ground'
    && typeof action.action.dropId === 'string'
    && action.diff.projectMaterialDeliveryRestricted === true
    && typeof action.diff.projectId === 'string'
    && typeof action.diff.requestEventId === 'string'
    ? {
        dropId: action.action.dropId,
        projectId: action.diff.projectId,
        requestEventId: action.diff.requestEventId,
      }
    : undefined;
  const participantIds = event.kind === 'environment'
    && (event.change === 'founding' || event.change === 'relationship')
    && Array.isArray(event.diff.participantIds)
    ? event.diff.participantIds.filter(
      (personId): personId is PersonId => typeof personId === 'string' && personId.length > 0,
    )
    : [];
  const excludedPairKeys = event.kind === 'environment'
    && event.change === 'relationship'
    && Array.isArray(event.diff.excludedPairKeys)
    ? event.diff.excludedPairKeys.filter(
      (key): key is string => typeof key === 'string' && key.length > 0,
    )
    : [];
  return Object.freeze({
    eventId: event.id,
    atMonth: event.atMonth,
    orderInMonth: event.orderInMonth,
    planningTick: event.planningTick ?? 0,
    orderInTick: event.orderInTick ?? 0,
    ...(action ? {
      action: Object.freeze({
        actorId: action.who,
        ...(action.intentId ? { intentId: action.intentId } : {}),
        status: action.status,
        actionKind: action.action.kind,
        completed: action.status === 'completed',
        ...(communication ? {
          communication: Object.freeze({
            perceivedByPersonIds: Object.freeze([...(languageBroadcast?.perceivedByPersonIds ?? [])].sort()),
            understoodByPersonIds: Object.freeze([...(languageBroadcast?.understoodByPersonIds ?? [])].sort()),
            ...(liveSocialCommunicationSubjectKey(communication)
              ? { subjectKey: liveSocialCommunicationSubjectKey(communication)! } : {}),
            basisSourceEventIds: Object.freeze(actionStaticBasisSourceIds(action)),
            ...(conversation ? {
              groundedConversation: Object.freeze({
                basisKey: conversation.basisKey,
                topic: conversation.topic,
                turn: conversation.turn,
                speakerId: conversation.speakerId,
                listenerId: conversation.listenerId,
                sourceFactIds: Object.freeze(canonicalStringIds(
                  conversation.sourceFactIds,
                  `live social conversation ${event.id} sources`,
                )),
                ...(conversation.referenceEventId
                  ? { referenceEventId: conversation.referenceEventId } : {}),
                ...(conversation.stance ? { stance: conversation.stance } : {}),
                basisVerified: action.diff.groundedConversationBasisKey === conversation.basisKey,
              }),
            } : {}),
          }),
        } : {}),
        supportRecipientIds: Object.freeze([...new Set(supportRecipientIds)].sort()),
        ...(blockedDelivery ? { blockedDelivery: Object.freeze(blockedDelivery) } : {}),
      }),
    } : {}),
    agreementFulfilled: event.kind === 'agreement' && event.change === 'fulfilled',
    electricalRemoteWorkEligible: remoteWorkCandidate(event, action?.who ?? ''),
    measurementUncertaintyEligible: measurementUncertaintyCandidate(event, action?.who ?? ''),
    ...(event.kind === 'environment' ? {
      environment: Object.freeze({
        change: event.change,
        participantIds: Object.freeze([...new Set(participantIds)].sort()),
        excludedPairKeys: Object.freeze([...new Set(excludedPairKeys)].sort()),
        ...(event.change === 'body' && typeof event.diff.bornPersonId === 'string'
          ? { bornPersonId: event.diff.bornPersonId } : {}),
      }),
    } : {}),
  });
}

function remoteWorkCandidate(event: WorldEvent, ownerId: PersonId): boolean {
  if (event.kind !== 'action' || event.who !== ownerId) return false;
  if (event.action.kind === 'move') {
    return (event.status === 'completed' || event.status === 'progressed')
      && (event.fromCellId !== event.toCellId || event.fromZ !== event.toZ);
  }
  if (event.status === 'completed'
    && event.action.kind === 'act'
    && event.diff.mechanicalPowerOperation === true) {
    return true;
  }
  if (event.status !== 'completed' || event.cause !== 'intent'
    || event.action.kind === 'talk') return false;
  if (event.action.kind === 'act') {
    if (event.action.mechanicalPowerBasis || event.action.electricalPowerBasis) return false;
    return event.action.operation !== 'ingest' && event.action.operation !== 'dehydrate';
  }
  return event.action.kind === 'transfer' || event.action.kind === 'attend';
}

function measurementUncertaintyCandidate(event: WorldEvent, ownerId: PersonId): boolean {
  return event.kind === 'action'
    && event.who === ownerId
    && event.status === 'completed'
    && event.action.kind === 'act'
    && (event.action.operation === 'combine'
      || event.action.operation === 'exert'
      || event.action.operation === 'expose');
}

/** Shared full/bounded classification over real ActionFact bodies. */
export function selectLivePersonSocialStrictEvidenceEventIds(
  ownerId: PersonId,
  candidates: Iterable<WorldEvent | LiveSocialEvidenceDescriptor>,
  measurementSourceEventIds: Iterable<string> = [],
): Readonly<Record<LivePersonSocialStrictEvidenceKind, readonly string[]>> {
  const byId = new Map<string, WorldEvent | LiveSocialEvidenceDescriptor>();
  for (const event of candidates) {
    const eventId = 'eventId' in event ? event.eventId : event.id;
    if (!byId.has(eventId)) byId.set(eventId, event);
  }
  const ordered = [...byId.values()].sort((left, right) => left.atMonth - right.atMonth
    || left.orderInMonth - right.orderInMonth
    || (left.planningTick ?? 0) - (right.planningTick ?? 0)
    || (left.orderInTick ?? 0) - (right.orderInTick ?? 0)
    || ('eventId' in left ? left.eventId : left.id)
      .localeCompare('eventId' in right ? right.eventId : right.id));
  const electricalRemoteWork = ordered.filter((event) => 'eventId' in event
    ? event.action?.actorId === ownerId && event.electricalRemoteWorkEligible
    : remoteWorkCandidate(event, ownerId))
    .map((event) => 'eventId' in event ? event.eventId : event.id);
  const measurementUncertainty = [...new Set(measurementSourceEventIds)];
  if (measurementUncertainty.some((eventId) => typeof eventId !== 'string' || eventId.length === 0)) {
    throw new Error(`living person ${ownerId} measurement strict selector 含空事件 ID`);
  }
  measurementUncertainty.sort();
  for (const [kind, eventIds] of [
    ['electrical-remote-work', electricalRemoteWork],
    ['measurement-uncertainty', measurementUncertainty],
  ] as const) {
    if (eventIds.length > LIVE_PERSON_SOCIAL_EVENT_ID_LIMIT) {
      throw new Error(
        `living person ${ownerId} ${kind} strict social evidence 超出 ${LIVE_PERSON_SOCIAL_EVENT_ID_LIMIT} 条上限`,
      );
    }
  }
  return Object.freeze({
    'electrical-remote-work': Object.freeze(electricalRemoteWork),
    'measurement-uncertainty': Object.freeze(measurementUncertainty),
  });
}
