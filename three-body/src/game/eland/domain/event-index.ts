import type {
  ActionFact,
  AgreementFact,
  DecisionAuthorityState,
  EnvironmentFact,
  SimulationState,
  WorldEvent,
} from './model';
import { Material } from './material';
import { isAlive, type PersonId, type PersonState } from './person';
import {
  projectPressureEvidenceDescriptorFromWorldEvent,
  rememberedProjectPressureSourceEventIds,
  type ProjectPressureEvidenceDescriptor,
  type ProjectPressureSourceEventIdSnapshot,
} from './project-pressure-evidence';
import {
  livePersonSocialSourceEventIds,
  liveSocialEvidenceDescriptorFromWorldEvent,
  type LiveSocialEvidenceDescriptor,
} from './live-social-evidence';
import { intentById } from './state-index';
import { hasAgentRememberedGroundedConversationBasis } from './agent-memory';
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
  /** Lazily derived only for immutable committed events; planning overlays are never cached. */
  liveSocialDescriptorsByEvent: WeakMap<WorldEvent, LiveSocialEvidenceDescriptor>;
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

const planningOverlays = new WeakMap<Pick<DecisionAuthorityState, 'world'>, PlanningEventOverlay>();
// Some execution paths expose committed facts plus the current-month suffix as
// one temporary history array for legacy direct readers. Index the stable
// committed prefix and merge the suffix through the overlay instead.
const indexedHistoryBases = new WeakMap<WorldEvent[], WorldEvent[]>();

export const GROUNDED_CONVERSATION_RESPONSE_WINDOW_MONTHS = 6;
export const MAX_LIVE_INTENT_ACTION_EVENT_IDS = 4_096;

type EventReadState = Pick<DecisionAuthorityState, 'intents' | 'people' | 'world'>;

function authoritativeHistoryBase(state: Pick<EventReadState, 'world'>): WorldEvent[] {
  return indexedHistoryBases.get(state.world.past) ?? state.world.past;
}

export interface ProjectPressureEvidenceResolutionSnapshot {
  readonly historyBaseIdentity: readonly WorldEvent[];
  readonly historyBaseLength: number;
  readonly historyBaseTailIdentity?: WorldEvent;
  readonly planningOverlayIdentity?: object;
}

export function snapshotProjectPressureEvidenceResolution(
  state: SimulationState,
): ProjectPressureEvidenceResolutionSnapshot {
  const historyBase = authoritativeHistoryBase(state);
  return Object.freeze({
    historyBaseIdentity: historyBase,
    historyBaseLength: historyBase.length,
    historyBaseTailIdentity: historyBase.at(-1),
    planningOverlayIdentity: planningOverlays.get(state),
  });
}

export function projectPressureEvidenceResolutionSnapshotIsCurrent(
  state: SimulationState,
  snapshot: ProjectPressureEvidenceResolutionSnapshot,
): boolean {
  const historyBase = authoritativeHistoryBase(state);
  return snapshot.historyBaseIdentity === historyBase
    && snapshot.historyBaseLength === historyBase.length
    && snapshot.historyBaseTailIdentity === historyBase.at(-1)
    && snapshot.planningOverlayIdentity === planningOverlays.get(state);
}

function assertCurrentLivingLiveSocialOwner(
  state: Pick<EventReadState, 'people'>,
  person: PersonState,
): PersonState {
  const owner = state.people.find((candidate) => candidate.id === person.id);
  if (owner !== person || !isAlive(owner)) {
    throw new Error('live social descriptor owner 不是当前存活人物');
  }
  return owner;
}

/** Match the historical full-body reader: intent basis is current state, not event payload. */
function liveSocialEvidenceWithCurrentIntentBasis(
  state: Pick<EventReadState, 'intents'>,
  descriptor: LiveSocialEvidenceDescriptor,
): LiveSocialEvidenceDescriptor {
  const communication = descriptor.action?.communication;
  const intentId = descriptor.action?.intentId;
  if (!communication || !intentId) return descriptor;
  const currentIntentSources = intentById(state, intentId)?.sourceFactIds ?? [];
  const basisSourceEventIds = [...new Set([
    ...communication.basisSourceEventIds,
    ...currentIntentSources,
  ])].sort();
  if (basisSourceEventIds.length === communication.basisSourceEventIds.length
    && basisSourceEventIds.every((eventId, index) => (
      eventId === communication.basisSourceEventIds[index]
    ))) return descriptor;
  return Object.freeze({
    ...descriptor,
    action: Object.freeze({
      ...descriptor.action!,
      communication: Object.freeze({
        ...communication,
        basisSourceEventIds: Object.freeze(basisSourceEventIds),
      }),
    }),
  });
}

/** Resolve an owner-scoped social source from the full committed history or planning overlay. */
function liveSocialEvidenceForCurrentOwnerSource(
  state: EventReadState,
  owner: PersonState,
  membership: ReadonlySet<string>,
  eventId: string,
): LiveSocialEvidenceDescriptor | undefined {
  if (!membership.has(eventId)) return undefined;
  const overlayEvent = planningOverlays.get(state)?.byId.get(eventId);
  const hotIndex = indexFor(state);
  const committedEvent = overlayEvent ? undefined : hotIndex.byId.get(eventId);
  let descriptor: LiveSocialEvidenceDescriptor | undefined;
  if (overlayEvent) {
    descriptor = liveSocialEvidenceDescriptorFromWorldEvent(overlayEvent);
  } else if (committedEvent) {
    descriptor = hotIndex.liveSocialDescriptorsByEvent.get(committedEvent);
    if (!descriptor) {
      descriptor = liveSocialEvidenceDescriptorFromWorldEvent(committedEvent);
      hotIndex.liveSocialDescriptorsByEvent.set(committedEvent, descriptor);
    }
  }
  return descriptor ? liveSocialEvidenceWithCurrentIntentBasis(state, descriptor) : undefined;
}

export function liveSocialEvidenceForPersonSource(
  state: EventReadState,
  person: PersonState,
  eventId: string,
): LiveSocialEvidenceDescriptor | undefined {
  const owner = assertCurrentLivingLiveSocialOwner(state, person);
  return liveSocialEvidenceForCurrentOwnerSource(
    state,
    owner,
    new Set(livePersonSocialSourceEventIds(owner)),
    eventId,
  );
}

export function compareLiveSocialEvidenceDescriptors(
  left: LiveSocialEvidenceDescriptor,
  right: LiveSocialEvidenceDescriptor,
): number {
  return left.atMonth - right.atMonth
    || left.orderInMonth - right.orderInMonth
    || left.planningTick - right.planningTick
    || left.orderInTick - right.orderInTick
    || left.eventId.localeCompare(right.eventId);
}

export function liveSocialEvidenceForPersonSources(
  state: EventReadState,
  person: PersonState,
  eventIds: Iterable<string>,
): LiveSocialEvidenceDescriptor[] {
  const owner = assertCurrentLivingLiveSocialOwner(state, person);
  const membership = new Set(livePersonSocialSourceEventIds(owner));
  return [...new Set(eventIds)]
    .flatMap((eventId) => (
      liveSocialEvidenceForCurrentOwnerSource(state, owner, membership, eventId) ?? []
    ))
    .sort(compareLiveSocialEvidenceDescriptors);
}

/**
 * Planner-facing read is intrinsically owner-scoped: callers cannot provide
 * arbitrary IDs, and a detached/foreign PersonState is rejected.
 */
function assertCurrentLivingProjectPressureOwner(
  state: SimulationState,
  person: PersonState,
): PersonState {
  const owner = state.people.find((candidate) => candidate.id === person.id);
  if (owner !== person || !isAlive(owner)) {
    throw new Error('project-pressure descriptor owner 不是当前存活人物');
  }
  return owner;
}

export function projectPressureEvidenceDescriptorsForPersonSourceSnapshot(
  state: SimulationState,
  person: PersonState,
  sourceSnapshot: ProjectPressureSourceEventIdSnapshot,
): readonly ProjectPressureEvidenceDescriptor[] {
  const owner = assertCurrentLivingProjectPressureOwner(state, person);
  if (sourceSnapshot.ownerId !== owner.id) {
    throw new Error('project-pressure source snapshot owner 不匹配');
  }
  return worldEventsByIdsInHistoryOrder(state, sourceSnapshot.sourceEventIds)
    .map(projectPressureEvidenceDescriptorFromWorldEvent);
}

export function projectPressureEvidenceDescriptorsForPerson(
  state: SimulationState,
  person: PersonState,
): readonly ProjectPressureEvidenceDescriptor[] {
  const owner = assertCurrentLivingProjectPressureOwner(state, person);
  return projectPressureEvidenceDescriptorsForPersonSourceSnapshot(state, owner, {
    ownerId: owner.id,
    sourceEventIds: rememberedProjectPressureSourceEventIds(owner),
    snapshotKey: '',
  });
}

/** Resolve one remembered source snapshot once from the complete event ledger. */
export function projectPressureEvidenceDescriptorCandidatesForPerson(
  state: SimulationState,
  person: PersonState,
  sourceSnapshot: ProjectPressureSourceEventIdSnapshot,
): readonly ProjectPressureEvidenceDescriptor[] {
  return projectPressureEvidenceDescriptorsForPersonSourceSnapshot(state, person, sourceSnapshot);
}

/** Canonical committed-event order. */
export function compareWorldEventsInCanonicalOrder(left: WorldEvent, right: WorldEvent): number {
  return left.atMonth - right.atMonth
    || left.orderInMonth - right.orderInMonth
    || (left.planningTick ?? 0) - (right.planningTick ?? 0)
    || (left.orderInTick ?? 0) - (right.orderInTick ?? 0)
    || left.id.localeCompare(right.id);
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
    if (event.action.kind === 'talk') {
      overlay.completedCommunications.push(event);
      overlay.communicationByRepresentationId.set(event.action.speakerMeaning.id, event);
      if (event.action.speakerMeaning.kind === 'claim' && event.action.speakerMeaning.conversation) {
        const conversation = event.action.speakerMeaning.conversation;
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

export function planningOverlayEvents(
  state: Pick<DecisionAuthorityState, 'world'>,
): readonly WorldEvent[] {
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

function withOverlay<T>(
  state: Pick<DecisionAuthorityState, 'world'>,
  base: readonly T[],
  select: (overlay: PlanningEventOverlay) => readonly T[],
): readonly T[] {
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
    liveSocialDescriptorsByEvent: new WeakMap(),
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

function indexFor(state: Pick<EventReadState, 'world'>): CachedEventIndex {
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
    if (event.action.kind === 'talk') {
      index.completedCommunications.push(event);
      index.communicationByRepresentationId.set(event.action.speakerMeaning.id, event);
      if (event.action.speakerMeaning.kind === 'claim' && event.action.speakerMeaning.conversation) {
        const conversation = event.action.speakerMeaning.conversation;
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

export function worldEventById(
  state: Pick<EventReadState, 'world'>,
  eventId: string,
): WorldEvent | undefined {
  return planningOverlays.get(state)?.byId.get(eventId)
    ?? indexFor(state).byId.get(eventId);
}

/**
 * Full replay history for observers. The ordinary path returns the authoritative
 * history itself; planning paths append only their small current-tick overlay.
 */
export function worldEventFacts(state: SimulationState): readonly WorldEvent[] {
  if ((state.world.historyCursor?.hotStartIndex ?? 0) > 0) {
    throw new Error('裁剪历史状态不能冒充完整 replay 历史');
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
  return [...new Set(eventIds)]
    .flatMap((eventId) => overlay?.byId.get(eventId)
      ?? index.byId.get(eventId)
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

type CommunicateAction = Extract<ActionFact['action'], { kind: 'talk' }>;
type ClaimRepresentation = Extract<CommunicateAction['speakerMeaning'], { kind: 'claim' }>;
type GroundedConversationActionFact = ActionFact & {
  action: CommunicateAction & {
    speakerMeaning: ClaimRepresentation & {
      conversation: NonNullable<ClaimRepresentation['conversation']>;
    };
  };
};

function isGroundedConversationAction(event: WorldEvent): event is GroundedConversationActionFact {
  return event.kind === 'action'
    && event.status === 'completed'
    && event.action.kind === 'talk'
    && event.action.speakerMeaning.kind === 'claim'
    && Boolean(event.action.speakerMeaning.conversation);
}

function currentRememberedConversationSourceIds(
  state: Pick<DecisionAuthorityState, 'people'>,
  personId: PersonId,
): Set<string> {
  const person = state.people.find((candidate) => candidate.id === personId);
  if (!person) return new Set();
  return new Set([
    ...person.memories.flatMap((memory) => memory.sourceEventIds),
    ...person.relations.flatMap((relation) => relation.sourceEventIds),
  ]);
}

export interface RememberedGroundedOpeningBasisCompilationDiagnostics {
  personSourceSnapshots: number;
  sourceIndexes: number;
  sourceResolutions: number;
  sourceResolutionsByPersonAndId: Record<string, number>;
}

/**
 * A person-scoped, caller-owned view used by one synchronous conversation
 * option compilation. Nothing is registered on the state or history base, so
 * the next compilation observes current memories and overlay again.
 */
export interface RememberedGroundedOpeningBasisSnapshot {
  hasOpeningBasis(
    basisKey: string,
    speakerId: PersonId,
    listenerId: PersonId,
  ): boolean;
  evidenceForPersonSource(
    personId: PersonId,
    eventId: string,
  ): LiveSocialEvidenceDescriptor | undefined;
}

function groundedOpeningIdentity(
  basisKey: string,
  speakerId: PersonId,
  listenerId: PersonId,
): string {
  return JSON.stringify([basisKey, speakerId, listenerId]);
}

/**
 * Resolve each participant's current social sources exactly once from the
 * planning overlay and full committed history.
 */
export function createRememberedGroundedOpeningBasisSnapshot(
  state: SimulationState,
  participants: readonly PersonState[],
  diagnostics?: RememberedGroundedOpeningBasisCompilationDiagnostics,
): RememberedGroundedOpeningBasisSnapshot {
  const participantById = new Map<PersonId, PersonState>();
  for (const participant of participants) {
    if (state.people.find((candidate) => candidate.id === participant.id) !== participant) {
      throw new Error('grounded conversation compilation participant 不是当前 state 人物');
    }
    if (!participantById.has(participant.id)) participantById.set(participant.id, participant);
  }

  const overlay = planningOverlays.get(state);
  const resolvedByPersonId = new Map<PersonId, Map<string, LiveSocialEvidenceDescriptor>>();
  const openingIdentitiesByPersonId = new Map<PersonId, Set<string>>();
  const initializedPersonIds = new Set<PersonId>();
  const ensurePersonSnapshot = (personId: PersonId): boolean => {
    if (!participantById.has(personId)) return false;
    if (initializedPersonIds.has(personId)) return true;
    initializedPersonIds.add(personId);
    if (diagnostics) diagnostics.personSourceSnapshots += 1;
    const owner = participantById.get(personId)!;
    const sourceIds = currentRememberedConversationSourceIds(state, personId);
    if (diagnostics) diagnostics.sourceIndexes += 1;
    const resolvedById = new Map<string, LiveSocialEvidenceDescriptor>();
    const openingIdentities = new Set<string>();
    const evidenceById = new Map(liveSocialEvidenceForPersonSources(
      state,
      owner,
      sourceIds,
    ).map((evidence) => [evidence.eventId, evidence]));
    for (const eventId of sourceIds) {
      if (diagnostics) {
        diagnostics.sourceResolutions += 1;
        const diagnosticKey = JSON.stringify([personId, eventId]);
        diagnostics.sourceResolutionsByPersonAndId[diagnosticKey] =
          (diagnostics.sourceResolutionsByPersonAndId[diagnosticKey] ?? 0) + 1;
      }
      const evidence = evidenceById.get(eventId);
      if (!evidence) continue;
      resolvedById.set(eventId, evidence);
      const conversation = evidence.action?.communication?.groundedConversation;
      if (!evidence.action?.completed || !conversation) continue;
      if (conversation.turn !== 'opening') continue;
      openingIdentities.add(groundedOpeningIdentity(
        conversation.basisKey,
        conversation.speakerId,
        conversation.listenerId,
      ));
    }
    resolvedByPersonId.set(personId, resolvedById);
    openingIdentitiesByPersonId.set(personId, openingIdentities);
    return true;
  };

  return Object.freeze({
    hasOpeningBasis: (basisKey: string, speakerId: PersonId, listenerId: PersonId): boolean => {
      // Current-tick openings suppress duplicates before they are written into
      // either person's memory. This remains intentionally basis-only/global.
      if (overlay?.groundedOpeningBasisKeys.has(basisKey)) return true;
      if (hasAgentRememberedGroundedConversationBasis(state, speakerId, basisKey, listenerId)
        || hasAgentRememberedGroundedConversationBasis(state, listenerId, basisKey, speakerId)) return true;
      const identity = groundedOpeningIdentity(basisKey, speakerId, listenerId);
      for (const personId of new Set([speakerId, listenerId])) {
        if (ensurePersonSnapshot(personId)
          && openingIdentitiesByPersonId.get(personId)?.has(identity)) return true;
      }
      return false;
    },
    evidenceForPersonSource: (
      personId: PersonId,
      eventId: string,
    ): LiveSocialEvidenceDescriptor | undefined => {
      if (!ensurePersonSnapshot(personId)) return undefined;
      return resolvedByPersonId.get(personId)?.get(eventId);
    },
  });
}

/**
 * Hard duplicate prevention follows facts the speaker or listener still
 * carries in memory/relationship state.
 */
export function hasRememberedGroundedConversationOpeningBasis(
  state: DecisionAuthorityState,
  basisKey: string,
  speakerId: PersonId,
  listenerId: PersonId,
): boolean {
  if (planningOverlays.get(state)?.groundedOpeningBasisKeys.has(basisKey)) return true;
  if (hasAgentRememberedGroundedConversationBasis(state, speakerId, basisKey, listenerId)
    || hasAgentRememberedGroundedConversationBasis(state, listenerId, basisKey, speakerId)) return true;
  for (const personId of [speakerId, listenerId]) {
    const person = state.people.find((candidate) => candidate.id === personId && isAlive(candidate));
    if (!person) continue;
    const sources = currentRememberedConversationSourceIds(state, personId);
    for (const evidence of liveSocialEvidenceForPersonSources(state, person, sources)) {
      const conversation = evidence.action?.communication?.groundedConversation;
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
    const conversation = event.action.speakerMeaning.conversation;
    const belongsToListener = conversation?.turn === 'opening'
      ? conversation.listenerId === listenerId
      : event.who === listenerId;
    if (belongsToListener) merged.set(event.id, event);
  };
  for (const event of indexFor(state).groundedCommunications) add(event);
  for (const event of overlayFacts) add(event);
  return [...merged.values()].sort(compareWorldEventsInCanonicalOrder);
}

export function hasRecentGroundedConversationResponseForListener(
  state: SimulationState,
  listenerId: PersonId,
  openingEventId: string,
): boolean {
  return recentGroundedConversationFactsForListener(state, listenerId).some((event) => (
    event.action.kind === 'talk'
      && event.action.speakerMeaning.kind === 'claim'
      && event.action.speakerMeaning.conversation?.turn === 'response'
      && event.action.speakerMeaning.conversation.referenceEventId === openingEventId
  ));
}

export function groundedConversationOpeningsForListener(
  state: SimulationState,
  listenerId: string,
): readonly ActionFact[] {
  return recentGroundedConversationFactsForListener(state, listenerId)
    .filter((event) => event.action.kind === 'talk'
      && event.action.speakerMeaning.kind === 'claim'
      && event.action.speakerMeaning.conversation?.turn === 'opening'
      && event.action.speakerMeaning.conversation.listenerId === listenerId);
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

export function actionFactsForPerson(
  state: Pick<EventReadState, 'world'>,
  personId: PersonId,
): readonly ActionFact[] {
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

export function communicationByRepresentationId(
  state: Pick<DecisionAuthorityState, 'agreements' | 'intents' | 'world'>,
  representationId: string,
): ActionFact | undefined {
  const hot = planningOverlays.get(state)?.communicationByRepresentationId.get(representationId)
    ?? indexFor(state).communicationByRepresentationId.get(representationId);
  if (hot) return hot;

  for (const agreement of state.agreements) {
    if (agreement.status !== 'active' && agreement.status !== 'proposed') continue;
    for (const eventId of [agreement.proposalEventId, agreement.responseEventId]) {
      if (!eventId) continue;
      const event = worldEventById(state, eventId);
      if (event?.kind === 'action'
        && event.status === 'completed'
        && event.action.kind === 'talk'
        && event.action.speakerMeaning.id === representationId) return event;
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
        action?.kind === 'talk' && action.speakerMeaning.id === representationId
      ));
    if (!ownsRepresentation) continue;
    for (const eventId of intent.actionEventIds) {
      const event = worldEventById(state, eventId);
      if (event?.kind === 'action'
        && event.status === 'completed'
        && event.action.kind === 'talk'
        && event.action.speakerMeaning.id === representationId) return event;
    }
  }
  return undefined;
}

export function completedConstructionActions(
  state: Pick<DecisionAuthorityState, 'world'>,
): readonly ActionFact[] {
  return withOverlay(state, indexFor(state).completedConstructionActions, (overlay) => overlay.completedConstructionActions);
}
