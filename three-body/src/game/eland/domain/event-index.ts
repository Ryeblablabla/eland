import type { ActionFact, EnvironmentFact, SimulationState, WorldEvent } from './model';

interface CachedEventIndex {
  indexedLength: number;
  byId: Map<string, WorldEvent>;
  actions: ActionFact[];
  completedActions: ActionFact[];
  environmentEvents: EnvironmentFact[];
  completedCommunications: ActionFact[];
  communicationByRepresentationId: Map<string, ActionFact>;
  completedConstructionActions: ActionFact[];
}

const indexes = new WeakMap<SimulationState, CachedEventIndex>();

function indexFor(state: SimulationState): CachedEventIndex {
  let index = indexes.get(state);
  if (!index || index.indexedLength > state.world.past.length) {
    index = {
      indexedLength: 0,
      byId: new Map(),
      actions: [],
      completedActions: [],
      environmentEvents: [],
      completedCommunications: [],
      communicationByRepresentationId: new Map(),
      completedConstructionActions: [],
    };
    indexes.set(state, index);
  }
  for (let offset = index.indexedLength; offset < state.world.past.length; offset += 1) {
    const event = state.world.past[offset];
    index.byId.set(event.id, event);
    if (event.kind === 'environment') index.environmentEvents.push(event);
    if (event.kind !== 'action') continue;
    index.actions.push(event);
    if (event.status !== 'completed') continue;
    index.completedActions.push(event);
    if (event.action.kind === 'communicate') {
      index.completedCommunications.push(event);
      index.communicationByRepresentationId.set(event.action.content.id, event);
    }
    if (event.action.kind === 'act'
      && event.action.operation === 'combine'
      && typeof event.diff.outputMaterialId === 'number'
      && event.diff.position) index.completedConstructionActions.push(event);
  }
  index.indexedLength = state.world.past.length;
  return index;
}

export function worldEventById(state: SimulationState, eventId: string): WorldEvent | undefined {
  return indexFor(state).byId.get(eventId);
}

export function completedCommunications(state: SimulationState): readonly ActionFact[] {
  return indexFor(state).completedCommunications;
}

export function completedActionFacts(state: SimulationState): readonly ActionFact[] {
  return indexFor(state).completedActions;
}

export function actionFacts(state: SimulationState): readonly ActionFact[] {
  return indexFor(state).actions;
}

export function environmentFacts(state: SimulationState): readonly EnvironmentFact[] {
  return indexFor(state).environmentEvents;
}

export function communicationByRepresentationId(state: SimulationState, representationId: string): ActionFact | undefined {
  return indexFor(state).communicationByRepresentationId.get(representationId);
}

export function completedConstructionActions(state: SimulationState): readonly ActionFact[] {
  return indexFor(state).completedConstructionActions;
}
