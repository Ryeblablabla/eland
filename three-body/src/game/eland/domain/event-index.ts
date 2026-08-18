import type { ActionFact, EnvironmentFact, SimulationState, WorldEvent } from './model';
import { Material } from './material';

interface CachedEventIndex {
  indexedLength: number;
  byId: Map<string, WorldEvent>;
  ordinalById: Map<string, number>;
  actions: ActionFact[];
  completedActions: ActionFact[];
  environmentEvents: EnvironmentFact[];
  completedCommunications: ActionFact[];
  groundedCommunications: ActionFact[];
  groundedOpeningBasisKeys: Set<string>;
  groundedOpeningsByListener: Map<string, ActionFact[]>;
  groundedResponseOpeningIds: Set<string>;
  matureCropHarvests: ActionFact[];
  communicationByRepresentationId: Map<string, ActionFact>;
  completedConstructionActions: ActionFact[];
}

const indexes = new WeakMap<SimulationState['world']['past'], CachedEventIndex>();

interface PlanningEventOverlay {
  events: WorldEvent[];
  byId: Map<string, WorldEvent>;
  indexById: Map<string, number>;
  actions: ActionFact[];
  completedActions: ActionFact[];
  environmentEvents: EnvironmentFact[];
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

export function registerPlanningEventOverlay(state: SimulationState, events: WorldEvent[]): void {
  const overlay: PlanningEventOverlay = {
    events,
    byId: new Map(), indexById: new Map(), actions: [], completedActions: [], environmentEvents: [],
    completedCommunications: [], groundedCommunications: [], groundedOpeningBasisKeys: new Set(),
    groundedOpeningsByListener: new Map(), groundedResponseOpeningIds: new Set(), matureCropHarvests: [],
    communicationByRepresentationId: new Map(), completedConstructionActions: [],
  };
  events.forEach((event, index) => {
    overlay.byId.set(event.id, event);
    overlay.indexById.set(event.id, index);
    if (event.kind === 'environment') overlay.environmentEvents.push(event);
    if (event.kind !== 'action') return;
    overlay.actions.push(event);
    if (event.status !== 'completed') return;
    overlay.completedActions.push(event);
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
    ordinalById: new Map(),
    actions: [],
    completedActions: [],
    environmentEvents: [],
    completedCommunications: [],
    groundedCommunications: [],
    groundedOpeningBasisKeys: new Set(),
    groundedOpeningsByListener: new Map(),
    groundedResponseOpeningIds: new Set(),
    matureCropHarvests: [],
    communicationByRepresentationId: new Map(),
    completedConstructionActions: [],
  };
}

function indexFor(state: SimulationState): CachedEventIndex {
  const history = state.world.past;
  let index = indexes.get(history);
  if (!index || index.indexedLength > state.world.past.length) {
    index = emptyIndex();
    indexes.set(history, index);
  }
  for (let offset = index.indexedLength; offset < history.length; offset += 1) {
    const event = history[offset];
    index.byId.set(event.id, event);
    index.ordinalById.set(event.id, offset);
    if (event.kind === 'environment') index.environmentEvents.push(event);
    if (event.kind !== 'action') continue;
    index.actions.push(event);
    if (event.status !== 'completed') continue;
    index.completedActions.push(event);
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
  return index;
}

export function primeEventIndex(state: SimulationState): void {
  indexFor(state);
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
    .flatMap((eventId) => {
      const overlayEvent = overlay?.byId.get(eventId);
      const overlayIndex = overlay?.indexById.get(eventId);
      const event = overlayEvent ?? index.byId.get(eventId);
      const ordinal = overlayEvent && overlayIndex !== undefined ? state.world.past.length + overlayIndex : index.ordinalById.get(eventId);
      return event && ordinal !== undefined ? [{ event, ordinal }] : [];
    })
    .sort((left, right) => left.ordinal - right.ordinal)
    .map(({ event }) => event);
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

export function actionFacts(state: SimulationState): readonly ActionFact[] {
  return withOverlay(state, indexFor(state).actions, (overlay) => overlay.actions);
}

export function environmentFacts(state: SimulationState): readonly EnvironmentFact[] {
  return withOverlay(state, indexFor(state).environmentEvents, (overlay) => overlay.environmentEvents);
}

export function communicationByRepresentationId(state: SimulationState, representationId: string): ActionFact | undefined {
  return planningOverlays.get(state)?.communicationByRepresentationId.get(representationId)
    ?? indexFor(state).communicationByRepresentationId.get(representationId);
}

export function completedConstructionActions(state: SimulationState): readonly ActionFact[] {
  return withOverlay(state, indexFor(state).completedConstructionActions, (overlay) => overlay.completedConstructionActions);
}
