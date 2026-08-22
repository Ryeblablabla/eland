import type { Intent, SimulationState } from './model';
import type { PersonId, PersonState } from './person';
import type { ProjectState } from './project';

interface AppendOnlyIdIndex<T extends { id: string }> {
  indexedLength: number;
  lastIndexedItem?: T;
  byId: Map<string, T>;
}

interface ProjectIndex extends AppendOnlyIdIndex<ProjectState> {
  byOwnerId: Map<PersonId, ProjectState[]>;
}

interface IntentIndex extends AppendOnlyIdIndex<Intent> {
  byOwnerId: Map<PersonId, Intent[]>;
}

const personIndexes = new WeakMap<SimulationState['people'], AppendOnlyIdIndex<PersonState>>();
const projectIndexes = new WeakMap<SimulationState['projects'], ProjectIndex>();
const intentIndexes = new WeakMap<SimulationState['intents'], IntentIndex>();

function indexInvalid<T extends { id: string }>(items: T[], index: AppendOnlyIdIndex<T>): boolean {
  return index.indexedLength > items.length
    || (index.indexedLength > 0 && items[index.indexedLength - 1] !== index.lastIndexedItem);
}

function personIndex(state: SimulationState): AppendOnlyIdIndex<PersonState> {
  const people = state.people;
  let index = personIndexes.get(people);
  if (!index || indexInvalid(people, index)) {
    index = { indexedLength: 0, byId: new Map() };
    personIndexes.set(people, index);
  }
  for (let offset = index.indexedLength; offset < people.length; offset += 1) {
    const person = people[offset];
    // Preserve Array.find semantics for malformed duplicate ids: first wins.
    if (!index.byId.has(person.id)) index.byId.set(person.id, person);
  }
  index.indexedLength = people.length;
  index.lastIndexedItem = people.at(-1);
  return index;
}

function projectIndex(state: SimulationState): ProjectIndex {
  const projects = state.projects;
  let index = projectIndexes.get(projects);
  if (!index || indexInvalid(projects, index)) {
    index = { indexedLength: 0, byId: new Map(), byOwnerId: new Map() };
    projectIndexes.set(projects, index);
  }
  for (let offset = index.indexedLength; offset < projects.length; offset += 1) {
    const project = projects[offset];
    if (!index.byId.has(project.id)) index.byId.set(project.id, project);
    const owned = index.byOwnerId.get(project.ownerId) ?? [];
    owned.push(project);
    index.byOwnerId.set(project.ownerId, owned);
  }
  index.indexedLength = projects.length;
  index.lastIndexedItem = projects.at(-1);
  return index;
}

function intentIndex(state: SimulationState): IntentIndex {
  const intents = state.intents;
  let index = intentIndexes.get(intents);
  if (!index || indexInvalid(intents, index)) {
    index = { indexedLength: 0, byId: new Map(), byOwnerId: new Map() };
    intentIndexes.set(intents, index);
  }
  for (let offset = index.indexedLength; offset < intents.length; offset += 1) {
    const intent = intents[offset];
    if (!index.byId.has(intent.id)) index.byId.set(intent.id, intent);
    const owned = index.byOwnerId.get(intent.ownerId) ?? [];
    owned.push(intent);
    index.byOwnerId.set(intent.ownerId, owned);
  }
  index.indexedLength = intents.length;
  index.lastIndexedItem = intents.at(-1);
  return index;
}

export function personById(state: SimulationState, personId: PersonId): PersonState | undefined {
  return personIndex(state).byId.get(personId);
}

export function projectById(state: SimulationState, projectId: string): ProjectState | undefined {
  return projectIndex(state).byId.get(projectId);
}

export function projectsOwnedBy(state: SimulationState, ownerId: PersonId): readonly ProjectState[] {
  return projectIndex(state).byOwnerId.get(ownerId) ?? [];
}

export function intentById(state: SimulationState, intentId: string): Intent | undefined {
  return intentIndex(state).byId.get(intentId);
}

export function intentsOwnedBy(state: SimulationState, ownerId: PersonId): readonly Intent[] {
  return intentIndex(state).byOwnerId.get(ownerId) ?? [];
}
