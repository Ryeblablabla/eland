import type { ActionFact, AgreementFact, EnvironmentFact, SimulationState, WorldEvent } from './model';
import { Material } from './material';
import { isAlive, type PersonId, type PersonState } from './person';
import {
  cloneValidatedProjectPressureEvidenceDescriptor,
  rememberedProjectPressureSourceEventIds,
  type ProjectPressureEvidenceDescriptor,
  type RetainedProjectPressureEvidenceDescriptor,
} from './project-pressure-evidence';
import { WORLD_CELL_COUNT } from '../world/grid';

export interface ActionActivityIndex {
  traffic: number[];
  transfer: number[];
  action: number[];
  attention: number[];
}

interface CachedEventIndex {
  indexedLength: number;
  lastIndexedEvent?: WorldEvent;
  byId: Map<string, WorldEvent>;
  actions: ActionFact[];
  actionsByPersonId: Map<PersonId, ActionFact[]>;
  completedActions: ActionFact[];
  completedActionsByPersonId: Map<PersonId, ActionFact[]>;
  completedSupportActionsByActorAndRecipient: Map<PersonId, Map<PersonId, ActionFact[]>>;
  environmentEvents: EnvironmentFact[];
  eraForecastTransitionEvents: EnvironmentFact[];
  eraForecastClimateWeatherEvents: EnvironmentFact[];
  agreementEventsByPersonId: Map<PersonId, AgreementFact[]>;
  completedCommunications: ActionFact[];
  groundedCommunications: ActionFact[];
  groundedOpeningBasisKeys: Set<string>;
  groundedOpeningsByListener: Map<string, ActionFact[]>;
  groundedResponseOpeningIds: Set<string>;
  matureCropHarvests: ActionFact[];
  communicationByRepresentationId: Map<string, ActionFact>;
  completedConstructionActions: ActionFact[];
  activity: ActionActivityIndex;
}

const indexes = new WeakMap<SimulationState['world']['past'], CachedEventIndex>();

interface PlanningEventOverlay {
  events: WorldEvent[];
  byId: Map<string, WorldEvent>;
  indexById: Map<string, number>;
  actions: ActionFact[];
  actionsByPersonId: Map<PersonId, ActionFact[]>;
  completedActions: ActionFact[];
  completedActionsByPersonId: Map<PersonId, ActionFact[]>;
  completedSupportActionsByActorAndRecipient: Map<PersonId, Map<PersonId, ActionFact[]>>;
  environmentEvents: EnvironmentFact[];
  eraForecastTransitionEvents: EnvironmentFact[];
  eraForecastClimateWeatherEvents: EnvironmentFact[];
  agreementEventsByPersonId: Map<PersonId, AgreementFact[]>;
  completedCommunications: ActionFact[];
  groundedCommunications: ActionFact[];
  groundedOpeningBasisKeys: Set<string>;
  groundedOpeningsByListener: Map<string, ActionFact[]>;
  groundedResponseOpeningIds: Set<string>;
  matureCropHarvests: ActionFact[];
  communicationByRepresentationId: Map<string, ActionFact>;
  completedConstructionActions: ActionFact[];
}

const planningOverlays = new WeakMap<SimulationState, PlanningEventOverlay>();
// Some execution paths expose committed facts plus the current-month suffix as
// one temporary history array for legacy direct readers. Index the stable
// committed prefix and merge the suffix through the overlay instead.
const indexedHistoryBases = new WeakMap<WorldEvent[], WorldEvent[]>();

/**
 * A verified cold fact retained outside `SimulationState` for a specific live
 * evidence lease. Absolute ordinals remain infrastructure metadata: planners
 * can resolve the fact or an exact lease, but cannot inspect ledger position.
 */
export interface RetainedColdWorldEventFact {
  absoluteIndex: number;
  eventId: string;
  event: WorldEvent;
  leaseKeys: readonly string[];
}

interface RetainedColdEventIndex {
  byId: Map<string, RetainedColdWorldEventFact>;
  byLeaseKey: Map<string, RetainedColdWorldEventFact[]>;
}

const retainedColdIndexes = new WeakMap<WorldEvent[], RetainedColdEventIndex>();

interface ProjectPressureEvidenceDescriptorIndex {
  byId: Map<string, RetainedProjectPressureEvidenceDescriptor>;
}

/** Body-free project-pressure evidence; deliberately separate from generic cold facts. */
const projectPressureEvidenceDescriptorIndexes =
  new WeakMap<WorldEvent[], ProjectPressureEvidenceDescriptorIndex>();

/** Current social obligations use exact leases rather than a synthetic full history. */
export const GROUNDED_CONVERSATION_RESPONSE_WINDOW_MONTHS = 6;
export const MAX_LIVE_INTENT_ACTION_EVENT_IDS = 4_096;

export function liveAgreementHistoryLeaseKey(agreementId: string): string {
  return `live-agreement:${agreementId}:anchors`;
}

export function liveIntentHistoryLeaseKey(intentId: string): string {
  return `live-intent:${intentId}:anchors`;
}

export function livePersonSocialEvidenceLeaseKey(personId: string): string {
  return `gameplay:live-person-social:${encodeURIComponent(personId)}:sources`;
}

export function groundedConversationWindowLeaseKey(listenerId: string, eventMonth: number): string {
  if (!Number.isSafeInteger(eventMonth) || eventMonth < 0) {
    throw new Error('grounded conversation window month 必须是非负安全整数');
  }
  return `gameplay:grounded-conversation:${encodeURIComponent(listenerId)}:month:${eventMonth}`;
}

export function parseGroundedConversationWindowLeaseKey(
  leaseKey: string,
): { listenerId: string; eventMonth: number } | null {
  const match = /^gameplay:grounded-conversation:([^:]+):month:(\d+)$/u.exec(leaseKey);
  if (!match) return null;
  const eventMonth = Number(match[2]);
  if (!Number.isSafeInteger(eventMonth)) return null;
  try {
    const listenerId = decodeURIComponent(match[1]);
    return listenerId.length > 0 ? { listenerId, eventMonth } : null;
  } catch {
    return null;
  }
}

function authoritativeHistoryBase(state: SimulationState): WorldEvent[] {
  return indexedHistoryBases.get(state.world.past) ?? state.world.past;
}

function retainedColdIndexFor(state: SimulationState): RetainedColdEventIndex | undefined {
  return retainedColdIndexes.get(authoritativeHistoryBase(state));
}

/**
 * Install already decoded and ledger-verified cold facts on the stable hot
 * history array. This registry is deliberately process-local and cannot alter
 * serialized state or make a selective retention set look like full history.
 */
export function registerRetainedColdWorldEventFacts(
  state: SimulationState,
  retained: readonly RetainedColdWorldEventFact[],
): void {
  const cursor = state.world.historyCursor;
  if (!cursor
    || cursor.version !== 1
    || !Number.isSafeInteger(cursor.eventCount)
    || cursor.eventCount < 0
    || !Number.isSafeInteger(cursor.hotStartIndex)
    || cursor.hotStartIndex < 0
    || cursor.hotStartIndex > cursor.eventCount) {
    throw new Error('注册冷历史事实前必须具备有效的 history cursor');
  }
  const hotEventCount = cursor.eventCount - cursor.hotStartIndex;
  if (state.world.past.length !== hotEventCount) {
    throw new Error('注册冷历史事实时 world.past 必须恰好是已提交热窗口');
  }
  if (cursor.eventCount === 0
    ? cursor.tailEventId !== null
    : typeof cursor.tailEventId !== 'string'
      || (hotEventCount > 0 && state.world.past.at(-1)?.id !== cursor.tailEventId)) {
    throw new Error('注册冷历史事实时热窗口尾事实与 history cursor 不一致');
  }

  const seenOrdinals = new Set<number>();
  const byId = new Map<string, RetainedColdWorldEventFact>();
  const byLeaseKey = new Map<string, RetainedColdWorldEventFact[]>();
  for (const input of retained) {
    if (!Number.isSafeInteger(input.absoluteIndex)
      || input.absoluteIndex < 0
      || input.absoluteIndex >= cursor.hotStartIndex) {
      throw new Error(`冷历史事实绝对序号 ${input.absoluteIndex} 不在冷区间`);
    }
    if (seenOrdinals.has(input.absoluteIndex)) {
      throw new Error(`冷历史事实绝对序号 ${input.absoluteIndex} 重复`);
    }
    seenOrdinals.add(input.absoluteIndex);
    if (typeof input.eventId !== 'string'
      || input.eventId.length === 0
      || input.event?.id !== input.eventId) {
      throw new Error(`冷历史事实绝对序号 ${input.absoluteIndex} 的事件 ID 不一致`);
    }
    const leaseKeys = [...new Set(input.leaseKeys)];
    if (!leaseKeys.length || leaseKeys.some((leaseKey) => typeof leaseKey !== 'string' || leaseKey.length === 0)) {
      throw new Error(`冷历史事实 ${input.eventId} 缺少有效 lease`);
    }
    const fact: RetainedColdWorldEventFact = {
      absoluteIndex: input.absoluteIndex,
      eventId: input.eventId,
      event: input.event,
      leaseKeys: leaseKeys.sort(),
    };
    const previous = byId.get(fact.eventId);
    if (!previous || previous.absoluteIndex < fact.absoluteIndex) byId.set(fact.eventId, fact);
    for (const leaseKey of fact.leaseKeys) {
      const facts = byLeaseKey.get(leaseKey) ?? [];
      facts.push(fact);
      byLeaseKey.set(leaseKey, facts);
    }
  }
  for (const facts of byLeaseKey.values()) {
    facts.sort((left, right) => left.absoluteIndex - right.absoluteIndex);
  }
  retainedColdIndexes.set(authoritativeHistoryBase(state), { byId, byLeaseKey });
}

/** Exact cold facts for one domain lease; never includes unrelated history. */
export function retainedColdWorldEventsForLease(
  state: SimulationState,
  leaseKey: string,
): readonly WorldEvent[] {
  return retainedColdIndexFor(state)?.byLeaseKey.get(leaseKey)?.map((fact) => fact.event) ?? [];
}

/**
 * Replace the process-local body-free descriptor index after exact-root
 * verification. Descriptors never become generic by-id facts or cold pins.
 */
export function registerProjectPressureEvidenceDescriptors(
  state: SimulationState,
  retained: readonly RetainedProjectPressureEvidenceDescriptor[],
): void {
  const cursor = state.world.historyCursor;
  if (!cursor
    || cursor.version !== 1
    || !Number.isSafeInteger(cursor.eventCount)
    || cursor.eventCount < 0
    || !Number.isSafeInteger(cursor.hotStartIndex)
    || cursor.hotStartIndex < 0
    || cursor.hotStartIndex > cursor.eventCount
    || state.world.past.length !== cursor.eventCount - cursor.hotStartIndex) {
    throw new Error('注册 project-pressure descriptor 前必须具备有效的 bounded history cursor');
  }
  const byId = new Map<string, RetainedProjectPressureEvidenceDescriptor>();
  const ordinals = new Set<number>();
  for (const item of retained) {
    const descriptor = cloneValidatedProjectPressureEvidenceDescriptor(item.descriptor);
    if (!Number.isSafeInteger(item.absoluteIndex)
      || item.absoluteIndex < 0
      || item.absoluteIndex >= cursor.eventCount
      || !descriptor
      || typeof descriptor.eventId !== 'string'
      || descriptor.eventId.length === 0
      || byId.has(descriptor.eventId)
      || ordinals.has(item.absoluteIndex)) {
      throw new Error('project-pressure descriptor identity/ordinal 非法或重复');
    }
    if (item.absoluteIndex >= cursor.hotStartIndex) {
      const hot = state.world.past[item.absoluteIndex - cursor.hotStartIndex];
      if (hot?.id !== descriptor.eventId) {
        throw new Error(`project-pressure hot descriptor ${item.absoluteIndex}/${descriptor.eventId} 与热窗口不一致`);
      }
    }
    ordinals.add(item.absoluteIndex);
    byId.set(descriptor.eventId, Object.freeze({
      absoluteIndex: item.absoluteIndex,
      descriptor,
    }));
  }
  projectPressureEvidenceDescriptorIndexes.set(authoritativeHistoryBase(state), { byId });
}

function projectPressureDescriptorIndexFor(
  state: SimulationState,
): ProjectPressureEvidenceDescriptorIndex | undefined {
  return projectPressureEvidenceDescriptorIndexes.get(authoritativeHistoryBase(state));
}

/**
 * Planner-facing read is intrinsically owner-scoped: callers cannot provide
 * arbitrary IDs, and a detached/foreign PersonState is rejected.
 */
export function projectPressureEvidenceDescriptorsForPerson(
  state: SimulationState,
  person: PersonState,
): readonly ProjectPressureEvidenceDescriptor[] {
  const owner = state.people.find((candidate) => candidate.id === person.id);
  if (owner !== person || !isAlive(owner)) {
    throw new Error('project-pressure descriptor owner 不是当前存活人物');
  }
  const byId = projectPressureDescriptorIndexFor(state)?.byId;
  if (!byId) return [];
  return rememberedProjectPressureSourceEventIds(owner)
    .flatMap((eventId) => {
      const item = byId.get(eventId);
      return item ? [item.descriptor] : [];
    });
}

/** Storage-facing reuse of descriptors still named by the current living shell. */
export function retainedProjectPressureEvidenceForLivingSources(
  state: SimulationState,
): readonly RetainedProjectPressureEvidenceDescriptor[] {
  const byId = projectPressureDescriptorIndexFor(state)?.byId;
  if (!byId) return [];
  const currentIds = new Set(state.people
    .filter(isAlive)
    .flatMap(rememberedProjectPressureSourceEventIds));
  return [...currentIds].flatMap((eventId) => {
    const item = byId.get(eventId);
    return item ? [item] : [];
  }).sort((left, right) => left.absoluteIndex - right.absoluteIndex);
}

/** Resolve one exact ID, but admit cold storage only through the named lease. */
export function worldEventByIdWithRetainedLease(
  state: SimulationState,
  eventId: string,
  leaseKey: string,
): WorldEvent | undefined {
  return planningOverlays.get(state)?.byId.get(eventId)
    ?? indexFor(state).byId.get(eventId)
    ?? retainedColdIndexFor(state)?.byLeaseKey.get(leaseKey)
      ?.find((fact) => fact.eventId === eventId)?.event;
}

/** Canonical committed-event order shared by exact cold leases and the hot suffix. */
export function compareWorldEventsInCanonicalOrder(left: WorldEvent, right: WorldEvent): number {
  return left.atMonth - right.atMonth
    || left.orderInMonth - right.orderInMonth
    || (left.planningTick ?? 0) - (right.planningTick ?? 0)
    || (left.orderInTick ?? 0) - (right.orderInTick ?? 0)
    || left.id.localeCompare(right.id);
}

/**
 * Person-local action facts plus one exact cold lease. The lease cannot expose
 * unrelated cold history, and hot/overlay facts take precedence on duplicate IDs.
 */
export function actionFactsForPersonWithRetainedLease(
  state: SimulationState,
  personId: PersonId,
  leaseKey: string,
): ActionFact[] {
  const merged = new Map<string, ActionFact>();
  for (const event of retainedColdWorldEventsForLease(state, leaseKey)) {
    if (event.kind === 'action' && event.who === personId) merged.set(event.id, event);
  }
  for (const event of actionFactsForPerson(state, personId)) merged.set(event.id, event);
  return [...merged.values()].sort(compareWorldEventsInCanonicalOrder);
}

function appendForPerson<T>(index: Map<PersonId, T[]>, personId: PersonId, item: T): void {
  const items = index.get(personId) ?? [];
  items.push(item);
  index.set(personId, items);
}

function appendSupportAction(
  index: Map<PersonId, Map<PersonId, ActionFact[]>>,
  actorId: PersonId,
  recipientId: PersonId,
  event: ActionFact,
): void {
  const byRecipient = index.get(actorId) ?? new Map<PersonId, ActionFact[]>();
  const events = byRecipient.get(recipientId) ?? [];
  events.push(event);
  byRecipient.set(recipientId, events);
  index.set(actorId, byRecipient);
}

function supportRecipientIds(event: ActionFact): PersonId[] {
  const recipientIds = new Set<PersonId>();
  if (typeof event.diff.caredPersonId === 'string') recipientIds.add(event.diff.caredPersonId);
  if (event.action.kind === 'transfer' && event.action.to.kind === 'person') {
    recipientIds.add(event.action.to.personId);
  }
  return [...recipientIds];
}

export function registerPlanningEventOverlay(
  state: SimulationState,
  events: WorldEvent[],
  indexedHistoryBase?: WorldEvent[],
): void {
  if (indexedHistoryBase && indexedHistoryBase !== state.world.past) {
    indexedHistoryBases.set(state.world.past, indexedHistoryBase);
  }
  const overlay: PlanningEventOverlay = {
    events,
    byId: new Map(), indexById: new Map(), actions: [], actionsByPersonId: new Map(),
    completedActions: [], completedActionsByPersonId: new Map(), environmentEvents: [],
    completedSupportActionsByActorAndRecipient: new Map(),
    eraForecastTransitionEvents: [], eraForecastClimateWeatherEvents: [],
    agreementEventsByPersonId: new Map(),
    completedCommunications: [], groundedCommunications: [], groundedOpeningBasisKeys: new Set(),
    groundedOpeningsByListener: new Map(), groundedResponseOpeningIds: new Set(), matureCropHarvests: [],
    communicationByRepresentationId: new Map(), completedConstructionActions: [],
  };
  events.forEach((event, index) => {
    overlay.byId.set(event.id, event);
    overlay.indexById.set(event.id, index);
    if (event.kind === 'environment') {
      overlay.environmentEvents.push(event);
      if (event.change === 'climate' && event.diff.eraTransition === true) {
        overlay.eraForecastTransitionEvents.push(event);
      }
      if (event.change === 'climate' || event.change === 'weather') {
        overlay.eraForecastClimateWeatherEvents.push(event);
      }
    }
    if (event.kind === 'agreement') {
      for (const personId of new Set(event.partyIds)) appendForPerson(overlay.agreementEventsByPersonId, personId, event);
    }
    if (event.kind !== 'action') return;
    overlay.actions.push(event);
    appendForPerson(overlay.actionsByPersonId, event.who, event);
    if (event.status !== 'completed') return;
    overlay.completedActions.push(event);
    appendForPerson(overlay.completedActionsByPersonId, event.who, event);
    for (const recipientId of supportRecipientIds(event)) {
      appendSupportAction(overlay.completedSupportActionsByActorAndRecipient, event.who, recipientId, event);
    }
    if (event.action.kind === 'communicate') {
      overlay.completedCommunications.push(event);
      overlay.communicationByRepresentationId.set(event.action.content.id, event);
      if (event.action.content.kind === 'claim' && event.action.content.conversation) {
        const conversation = event.action.content.conversation;
        overlay.groundedCommunications.push(event);
        if (conversation.turn === 'opening') {
          overlay.groundedOpeningBasisKeys.add(conversation.basisKey);
          const openings = overlay.groundedOpeningsByListener.get(conversation.listenerId) ?? [];
          openings.push(event);
          overlay.groundedOpeningsByListener.set(conversation.listenerId, openings);
        } else if (conversation.referenceEventId) overlay.groundedResponseOpeningIds.add(conversation.referenceEventId);
      }
    }
    if (event.action.kind === 'act' && event.action.operation === 'separate'
      && Number(event.diff.sourceMaterialId) === Material.CropMature) overlay.matureCropHarvests.push(event);
    if (event.action.kind === 'act' && event.action.operation === 'combine'
      && typeof event.diff.outputMaterialId === 'number' && event.diff.position) overlay.completedConstructionActions.push(event);
  });
  planningOverlays.set(state, overlay);
}

export function clearPlanningEventOverlay(state: SimulationState): void {
  planningOverlays.delete(state);
}

export function planningOverlayEvents(state: SimulationState): readonly WorldEvent[] {
  return planningOverlays.get(state)?.events ?? [];
}

/**
 * Preserve current-month evidence when a planner creates another shallow
 * state view. The overlay is process-local and keyed by state identity, so it
 * cannot follow object spread by itself. Planning clones share the same
 * authoritative history array; only the isolated people/projects slices may
 * differ.
 */
export function inheritPlanningEventOverlay(
  source: SimulationState,
  target: SimulationState,
): void {
  const overlay = planningOverlays.get(source);
  if (!overlay) return;
  if (source.world.past !== target.world.past) {
    throw new Error('planning overlay 只能继承到共享同一权威历史的预览状态');
  }
  planningOverlays.set(target, overlay);
}

/** Exact runtime presence check used by destructive committed-history maintenance. */
export function hasPlanningEventOverlay(state: SimulationState): boolean {
  return planningOverlays.has(state);
}

/**
 * Release hot-only derived structures immediately after an in-place committed
 * history trim. The retained-cold registry deliberately remains keyed by the
 * stable history array and is not touched here.
 */
export function invalidateHotEventIndexAfterCommittedHistoryTrim(
  state: SimulationState,
): void {
  const history = state.world.past;
  const indexedBase = indexedHistoryBases.get(history);
  indexes.delete(history);
  if (indexedBase) indexes.delete(indexedBase);
  indexedHistoryBases.delete(history);
  planningOverlays.delete(state);
}

function withOverlay<T>(state: SimulationState, base: readonly T[], select: (overlay: PlanningEventOverlay) => readonly T[]): readonly T[] {
  const extra = planningOverlays.get(state);
  if (!extra) return base;
  const selected = select(extra);
  return selected.length ? [...base, ...selected] : base;
}

function emptyIndex(): CachedEventIndex {
  return {
    indexedLength: 0,
    byId: new Map(),
    actions: [],
    actionsByPersonId: new Map(),
    completedActions: [],
    completedActionsByPersonId: new Map(),
    completedSupportActionsByActorAndRecipient: new Map(),
    environmentEvents: [],
    eraForecastTransitionEvents: [],
    eraForecastClimateWeatherEvents: [],
    agreementEventsByPersonId: new Map(),
    completedCommunications: [],
    groundedCommunications: [],
    groundedOpeningBasisKeys: new Set(),
    groundedOpeningsByListener: new Map(),
    groundedResponseOpeningIds: new Set(),
    matureCropHarvests: [],
    communicationByRepresentationId: new Map(),
    completedConstructionActions: [],
    activity: {
      traffic: new Array<number>(WORLD_CELL_COUNT).fill(0),
      transfer: new Array<number>(WORLD_CELL_COUNT).fill(0),
      action: new Array<number>(WORLD_CELL_COUNT).fill(0),
      attention: new Array<number>(WORLD_CELL_COUNT).fill(0),
    },
  };
}

function copyActivity(activity: ActionActivityIndex): ActionActivityIndex {
  return {
    traffic: [...activity.traffic],
    transfer: [...activity.transfer],
    action: [...activity.action],
    attention: [...activity.attention],
  };
}

function appendActivity(activity: ActionActivityIndex, event: ActionFact): void {
  if (event.action.kind === 'move') {
    event.pathSegment.forEach((cell) => { activity.traffic[cell] += 1; });
  } else if (event.action.kind === 'transfer') activity.transfer[event.cellId] += 1;
  else if (event.action.kind === 'attend') activity.attention[event.cellId] += 1;
  else activity.action[event.cellId] += 1;
}

function indexFor(state: SimulationState): CachedEventIndex {
  const history = indexedHistoryBases.get(state.world.past) ?? state.world.past;
  let index = indexes.get(history);
  if (!index
    || index.indexedLength > history.length
    || (index.indexedLength > 0 && history[index.indexedLength - 1] !== index.lastIndexedEvent)) {
    index = emptyIndex();
    indexes.set(history, index);
  }
  let activityCopied = false;
  for (let offset = index.indexedLength; offset < history.length; offset += 1) {
    const event = history[offset];
    index.byId.set(event.id, event);
    if (event.kind === 'environment') {
      index.environmentEvents.push(event);
      if (event.change === 'climate' && event.diff.eraTransition === true) {
        index.eraForecastTransitionEvents.push(event);
      }
      if (event.change === 'climate' || event.change === 'weather') {
        index.eraForecastClimateWeatherEvents.push(event);
      }
    }
    if (event.kind === 'agreement') {
      for (const personId of new Set(event.partyIds)) appendForPerson(index.agreementEventsByPersonId, personId, event);
    }
    if (event.kind !== 'action') continue;
    if (!activityCopied) {
      // The previous arrays may already belong to an emitted UI frame. Copy
      // once before consuming the newly appended action facts so later months
      // cannot mutate an older projection.
      index.activity = copyActivity(index.activity);
      activityCopied = true;
    }
    appendActivity(index.activity, event);
    index.actions.push(event);
    appendForPerson(index.actionsByPersonId, event.who, event);
    if (event.status !== 'completed') continue;
    index.completedActions.push(event);
    appendForPerson(index.completedActionsByPersonId, event.who, event);
    for (const recipientId of supportRecipientIds(event)) {
      appendSupportAction(index.completedSupportActionsByActorAndRecipient, event.who, recipientId, event);
    }
    if (event.action.kind === 'communicate') {
      index.completedCommunications.push(event);
      index.communicationByRepresentationId.set(event.action.content.id, event);
      if (event.action.content.kind === 'claim' && event.action.content.conversation) {
        const conversation = event.action.content.conversation;
        index.groundedCommunications.push(event);
        if (conversation.turn === 'opening') {
          index.groundedOpeningBasisKeys.add(conversation.basisKey);
          const openings = index.groundedOpeningsByListener.get(conversation.listenerId) ?? [];
          openings.push(event);
          index.groundedOpeningsByListener.set(conversation.listenerId, openings);
        }
        else if (conversation.referenceEventId) index.groundedResponseOpeningIds.add(conversation.referenceEventId);
      }
    }
    if (event.action.kind === 'act'
      && event.action.operation === 'separate'
      && Number(event.diff.sourceMaterialId) === Material.CropMature) index.matureCropHarvests.push(event);
    if (event.action.kind === 'act'
      && event.action.operation === 'combine'
      && typeof event.diff.outputMaterialId === 'number'
      && event.diff.position) index.completedConstructionActions.push(event);
  }
  index.indexedLength = history.length;
  index.lastIndexedEvent = history.at(-1);
  return index;
}

export function primeEventIndex(state: SimulationState): void {
  indexFor(state);
}

/**
 * Append-only activity projection shared with the UI adapter. The returned
 * arrays are persistent snapshots: the index copies them before applying the
 * next batch of action facts.
 */
export function actionActivityIndex(state: SimulationState): ActionActivityIndex {
  return indexFor(state).activity;
}

export function worldEventById(state: SimulationState, eventId: string): WorldEvent | undefined {
  return planningOverlays.get(state)?.byId.get(eventId)
    ?? indexFor(state).byId.get(eventId)
    ?? retainedColdIndexFor(state)?.byId.get(eventId)?.event;
}

/**
 * Full replay history for observers. The ordinary path returns the authoritative
 * history itself; planning paths append only their small current-tick overlay.
 */
export function worldEventFacts(state: SimulationState): readonly WorldEvent[] {
  if ((state.world.historyCursor?.hotStartIndex ?? 0) > 0) {
    throw new Error('有界历史状态不能把热窗口与选择性冷事实冒充完整 replay 历史');
  }
  const indexedHistoryBase = indexedHistoryBases.get(state.world.past);
  const history = indexedHistoryBase ?? state.world.past;
  indexFor(state);
  // Execution already exposes committed facts plus the current-month suffix in
  // this temporary array. Reuse it instead of concatenating the full history.
  if (indexedHistoryBase) return state.world.past;
  return withOverlay(state, history, (overlay) => overlay.events);
}

export function worldEventsByIdsInHistoryOrder(
  state: SimulationState,
  eventIds: Iterable<string>,
): WorldEvent[] {
  const index = indexFor(state);
  const overlay = planningOverlays.get(state);
  const retained = retainedColdIndexFor(state);
  return [...new Set(eventIds)]
    .flatMap((eventId) => overlay?.byId.get(eventId)
      ?? index.byId.get(eventId)
      ?? retained?.byId.get(eventId)?.event
      ?? [])
    .sort((left, right) => left.atMonth - right.atMonth
      || left.orderInMonth - right.orderInMonth
      || (left.planningTick ?? 0) - (right.planningTick ?? 0)
      || (left.orderInTick ?? 0) - (right.orderInTick ?? 0)
      || left.id.localeCompare(right.id));
}

export function completedCommunications(state: SimulationState): readonly ActionFact[] {
  return withOverlay(state, indexFor(state).completedCommunications, (overlay) => overlay.completedCommunications);
}

export function groundedCommunicationFacts(state: SimulationState): readonly ActionFact[] {
  return withOverlay(state, indexFor(state).groundedCommunications, (overlay) => overlay.groundedCommunications);
}

export function hasGroundedConversationOpeningBasis(state: SimulationState, basisKey: string): boolean {
  return Boolean(planningOverlays.get(state)?.groundedOpeningBasisKeys.has(basisKey)) || indexFor(state).groundedOpeningBasisKeys.has(basisKey);
}

type CommunicateAction = Extract<ActionFact['action'], { kind: 'communicate' }>;
type ClaimRepresentation = Extract<CommunicateAction['content'], { kind: 'claim' }>;
type GroundedConversationActionFact = ActionFact & {
  action: CommunicateAction & {
    content: ClaimRepresentation & {
      conversation: NonNullable<ClaimRepresentation['conversation']>;
    };
  };
};

function isGroundedConversationAction(event: WorldEvent): event is GroundedConversationActionFact {
  return event.kind === 'action'
    && event.status === 'completed'
    && event.action.kind === 'communicate'
    && event.action.content.kind === 'claim'
    && Boolean(event.action.content.conversation);
}

function currentPersonalSocialSourceIds(
  state: SimulationState,
  personId: PersonId,
): Set<string> {
  const person = state.people.find((candidate) => candidate.id === personId);
  if (!person) return new Set();
  return new Set([
    ...person.memories.flatMap((memory) => memory.sourceEventIds),
    ...person.relations.flatMap((relation) => relation.sourceEventIds),
  ]);
}

/**
 * Hard duplicate prevention follows facts the speaker or listener still
 * carries in memory/relationship state. Forgotten, obligation-free ancient
 * dialogue is deliberately not reconstructed from arbitrary cold pins.
 */
export function hasRememberedGroundedConversationOpeningBasis(
  state: SimulationState,
  basisKey: string,
  speakerId: PersonId,
  listenerId: PersonId,
): boolean {
  if (planningOverlays.get(state)?.groundedOpeningBasisKeys.has(basisKey)) return true;
  for (const personId of [speakerId, listenerId]) {
    const leaseKey = livePersonSocialEvidenceLeaseKey(personId);
    for (const eventId of currentPersonalSocialSourceIds(state, personId)) {
      const event = worldEventByIdWithRetainedLease(state, eventId, leaseKey);
      if (!event || !isGroundedConversationAction(event)) continue;
      const conversation = event.action.content.conversation;
      if (conversation?.turn === 'opening'
        && conversation.basisKey === basisKey
        && conversation.speakerId === speakerId
        && conversation.listenerId === listenerId) return true;
    }
  }
  return false;
}

export function hasGroundedConversationResponse(state: SimulationState, openingEventId: string): boolean {
  return Boolean(planningOverlays.get(state)?.groundedResponseOpeningIds.has(openingEventId)) || indexFor(state).groundedResponseOpeningIds.has(openingEventId);
}

function recentGroundedConversationFactsForListener(
  state: SimulationState,
  listenerId: PersonId,
): ActionFact[] {
  const overlayFacts = planningOverlays.get(state)?.groundedCommunications ?? [];
  const currentMonth = Math.max(
    state.clock.elapsedMonths,
    ...overlayFacts.map((event) => event.atMonth),
  );
  const earliestMonth = Math.max(0, currentMonth - GROUNDED_CONVERSATION_RESPONSE_WINDOW_MONTHS);
  const merged = new Map<string, ActionFact>();
  const add = (event: WorldEvent) => {
    if (!isGroundedConversationAction(event)
      || event.atMonth < earliestMonth
      || event.atMonth > currentMonth) return;
    const conversation = event.action.content.conversation;
    const belongsToListener = conversation?.turn === 'opening'
      ? conversation.listenerId === listenerId
      : event.who === listenerId;
    if (belongsToListener) merged.set(event.id, event);
  };
  for (const event of indexFor(state).groundedCommunications) add(event);
  for (const event of overlayFacts) add(event);
  for (let eventMonth = earliestMonth;
    eventMonth <= Math.min(currentMonth, state.clock.elapsedMonths);
    eventMonth += 1) {
    for (const event of retainedColdWorldEventsForLease(
      state,
      groundedConversationWindowLeaseKey(listenerId, eventMonth),
    )) add(event);
  }
  return [...merged.values()].sort(compareWorldEventsInCanonicalOrder);
}

export function hasRecentGroundedConversationResponseForListener(
  state: SimulationState,
  listenerId: PersonId,
  openingEventId: string,
): boolean {
  return recentGroundedConversationFactsForListener(state, listenerId).some((event) => (
    event.action.kind === 'communicate'
      && event.action.content.kind === 'claim'
      && event.action.content.conversation?.turn === 'response'
      && event.action.content.conversation.referenceEventId === openingEventId
  ));
}

export function groundedConversationOpeningsForListener(
  state: SimulationState,
  listenerId: string,
): readonly ActionFact[] {
  return recentGroundedConversationFactsForListener(state, listenerId)
    .filter((event) => event.action.kind === 'communicate'
      && event.action.content.kind === 'claim'
      && event.action.content.conversation?.turn === 'opening'
      && event.action.content.conversation.listenerId === listenerId);
}

export function matureCropHarvestActions(state: SimulationState): readonly ActionFact[] {
  return withOverlay(state, indexFor(state).matureCropHarvests, (overlay) => overlay.matureCropHarvests);
}

export function completedActionFacts(state: SimulationState): readonly ActionFact[] {
  return withOverlay(state, indexFor(state).completedActions, (overlay) => overlay.completedActions);
}

export function completedActionFactsForPerson(state: SimulationState, personId: PersonId): readonly ActionFact[] {
  const base = indexFor(state).completedActionsByPersonId.get(personId) ?? [];
  const extra = planningOverlays.get(state)?.completedActionsByPersonId.get(personId) ?? [];
  return extra.length ? [...base, ...extra] : base;
}

export function completedSupportActionFactsBetween(
  state: SimulationState,
  actorId: PersonId,
  recipientId: PersonId,
): readonly ActionFact[] {
  const base = indexFor(state).completedSupportActionsByActorAndRecipient.get(actorId)?.get(recipientId) ?? [];
  return withOverlay(state, base,
    (overlay) => overlay.completedSupportActionsByActorAndRecipient.get(actorId)?.get(recipientId) ?? []);
}

export function actionFacts(state: SimulationState): readonly ActionFact[] {
  return withOverlay(state, indexFor(state).actions, (overlay) => overlay.actions);
}

export function actionFactsForPerson(state: SimulationState, personId: PersonId): readonly ActionFact[] {
  const base = indexFor(state).actionsByPersonId.get(personId) ?? [];
  const extra = planningOverlays.get(state)?.actionsByPersonId.get(personId) ?? [];
  return extra.length ? [...base, ...extra] : base;
}

export function agreementFactsForPerson(state: SimulationState, personId: PersonId): readonly AgreementFact[] {
  const base = indexFor(state).agreementEventsByPersonId.get(personId) ?? [];
  const extra = planningOverlays.get(state)?.agreementEventsByPersonId.get(personId) ?? [];
  return extra.length ? [...base, ...extra] : base;
}

export function environmentFacts(state: SimulationState): readonly EnvironmentFact[] {
  return withOverlay(state, indexFor(state).environmentEvents, (overlay) => overlay.environmentEvents);
}

export function eraForecastTransitionFacts(state: SimulationState): EnvironmentFact[] {
  const base = indexFor(state).eraForecastTransitionEvents;
  return [...withOverlay(state, base, (overlay) => overlay.eraForecastTransitionEvents)];
}

export function recentEraForecastEnvironmentFacts(
  state: SimulationState,
  limit: number,
): EnvironmentFact[] {
  if (limit <= 0) return [];
  const base = indexFor(state).eraForecastClimateWeatherEvents;
  const extra = planningOverlays.get(state)?.eraForecastClimateWeatherEvents ?? [];
  const recentExtra = extra.length > limit ? extra.slice(-limit) : extra;
  const remaining = limit - recentExtra.length;
  return [...(remaining > 0 ? base.slice(-remaining) : []), ...recentExtra];
}

export function communicationByRepresentationId(state: SimulationState, representationId: string): ActionFact | undefined {
  const hot = planningOverlays.get(state)?.communicationByRepresentationId.get(representationId)
    ?? indexFor(state).communicationByRepresentationId.get(representationId);
  if (hot) return hot;

  for (const agreement of state.agreements) {
    if (agreement.status !== 'active' && agreement.status !== 'proposed') continue;
    const leaseKey = liveAgreementHistoryLeaseKey(agreement.id);
    for (const eventId of [agreement.proposalEventId, agreement.responseEventId]) {
      if (!eventId) continue;
      const event = worldEventByIdWithRetainedLease(state, eventId, leaseKey);
      if (event?.kind === 'action'
        && event.status === 'completed'
        && event.action.kind === 'communicate'
        && event.action.content.id === representationId) return event;
    }
  }

  for (const intent of state.intents) {
    if (intent.status !== 'active' && intent.status !== 'suspended') continue;
    if (!Array.isArray(intent.actionEventIds)
      || intent.actionEventIds.length > MAX_LIVE_INTENT_ACTION_EVENT_IDS) {
      throw new Error(`live intent ${intent.id} actionEventIds 超出有界续接上限`);
    }
    const ownsRepresentation = intent.goal.kind === 'representation-made'
      && intent.goal.representationId === representationId
      || [intent.openingAction, intent.nextAction, intent.completionAction].some((action) => (
        action?.kind === 'communicate' && action.content.id === representationId
      ));
    if (!ownsRepresentation) continue;
    const leaseKey = liveIntentHistoryLeaseKey(intent.id);
    for (const eventId of intent.actionEventIds) {
      const event = worldEventByIdWithRetainedLease(state, eventId, leaseKey);
      if (event?.kind === 'action'
        && event.status === 'completed'
        && event.action.kind === 'communicate'
        && event.action.content.id === representationId) return event;
    }
  }
  return undefined;
}

export function completedConstructionActions(state: SimulationState): readonly ActionFact[] {
  return withOverlay(state, indexFor(state).completedConstructionActions, (overlay) => overlay.completedConstructionActions);
}
