import type { ActionFact, AgreementFact, EnvironmentFact, SimulationState, WorldEvent } from './model';
import { Material } from './material';
import type { PersonId } from './person';
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
  return planningOverlays.get(state)?.byId.get(eventId) ?? indexFor(state).byId.get(eventId);
}

export function worldEventsByIdsInHistoryOrder(
  state: SimulationState,
  eventIds: Iterable<string>,
): WorldEvent[] {
  const index = indexFor(state);
  const overlay = planningOverlays.get(state);
  return [...new Set(eventIds)]
    .flatMap((eventId) => overlay?.byId.get(eventId) ?? index.byId.get(eventId) ?? [])
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

export function hasGroundedConversationResponse(state: SimulationState, openingEventId: string): boolean {
  return Boolean(planningOverlays.get(state)?.groundedResponseOpeningIds.has(openingEventId)) || indexFor(state).groundedResponseOpeningIds.has(openingEventId);
}

export function groundedConversationOpeningsForListener(
  state: SimulationState,
  listenerId: string,
): readonly ActionFact[] {
  const base = indexFor(state).groundedOpeningsByListener.get(listenerId) ?? [];
  const extra = planningOverlays.get(state)?.groundedOpeningsByListener.get(listenerId) ?? [];
  return extra.length ? [...base, ...extra] : base;
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
  return planningOverlays.get(state)?.communicationByRepresentationId.get(representationId)
    ?? indexFor(state).communicationByRepresentationId.get(representationId);
}

export function completedConstructionActions(state: SimulationState): readonly ActionFact[] {
  return withOverlay(state, indexFor(state).completedConstructionActions, (overlay) => overlay.completedConstructionActions);
}
