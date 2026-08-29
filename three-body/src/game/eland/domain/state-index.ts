import type { DecisionAuthorityState, Intent, SimulationState } from './model';
import { isAlive, type PersonId, type PersonState } from './person';
import type { ProjectState } from './project';

interface AppendOnlyIdIndex<T extends { id: string }> {
  indexedLength: number;
  lastIndexedItem?: T;
  byId: Map<string, T>;
}

interface PersonIndex extends AppendOnlyIdIndex<PersonState> {
  /** Ordered live candidates; health/death is rechecked on every public read. */
  living: PersonState[];
}

interface ProjectIndex extends AppendOnlyIdIndex<ProjectState> {
  byOwnerId: Map<PersonId, ProjectState[]>;
}

interface IntentIndex extends AppendOnlyIdIndex<Intent> {
  byOwnerId: Map<PersonId, Intent[]>;
}

type AgreementState = SimulationState['agreements'][number];

interface ProjectLifecycleIndex {
  itemRefs: ProjectState[];
  signatures: string[];
  candidates: ProjectState[];
}

interface AgreementLifecycleIndex {
  itemRefs: AgreementState[];
  signatures: string[];
  lifecycleCandidates: AgreementState[];
  responseDeadlineCandidates: AgreementState[];
}

const personIndexes = new WeakMap<SimulationState['people'], PersonIndex>();
const projectIndexes = new WeakMap<SimulationState['projects'], ProjectIndex>();
const intentIndexes = new WeakMap<SimulationState['intents'], IntentIndex>();
const projectLifecycleIndexes = new WeakMap<SimulationState['projects'], ProjectLifecycleIndex>();
const agreementLifecycleIndexes = new WeakMap<SimulationState['agreements'], AgreementLifecycleIndex>();

function indexInvalid<T extends { id: string }>(items: T[], index: AppendOnlyIdIndex<T>): boolean {
  return index.indexedLength > items.length
    || (index.indexedLength > 0 && items[index.indexedLength - 1] !== index.lastIndexedItem);
}

function mutableIndexMatches<T>(
  items: T[],
  itemRefs: readonly T[],
  signatures: readonly string[],
  signatureFor: (item: T) => string,
): boolean {
  if (items.length !== itemRefs.length || items.length !== signatures.length) return false;
  for (let offset = 0; offset < items.length; offset += 1) {
    if (items[offset] !== itemRefs[offset] || signatureFor(items[offset]) !== signatures[offset]) return false;
  }
  return true;
}

function projectLifecycleSignature(project: ProjectState): string {
  return [
    project.status,
    project.activeLogisticsEpisodeId ?? '',
    project.terminalInquiryOpportunityBasis ? 'terminal-basis' : '',
    project.hypothesisCampaign?.status ?? '',
    project.hypothesisCampaign?.attempts.length ?? 0,
    project.leadershipTransitions?.length ?? 0,
    ...(project.searchCampaigns ?? []).map((campaign) => campaign.status),
  ].join('|');
}

function terminalProjectNeedsSynchronization(project: ProjectState): boolean {
  if (project.activeLogisticsEpisodeId
    || project.searchCampaigns?.some((campaign) => campaign.status === 'active')
    || project.hypothesisCampaign?.status === 'active') return true;
  return project.status === 'blocked'
    && !project.terminalInquiryOpportunityBasis
    && (Boolean(project.hypothesisCampaign?.attempts.length)
      || Boolean(project.searchCampaigns?.some((campaign) => campaign.status === 'exhausted')));
}

function projectLifecycleIndex(state: SimulationState): ProjectLifecycleIndex {
  const projects = state.projects;
  const existing = projectLifecycleIndexes.get(projects);
  if (existing && mutableIndexMatches(
    projects,
    existing.itemRefs,
    existing.signatures,
    projectLifecycleSignature,
  )) return existing;
  const index: ProjectLifecycleIndex = {
    itemRefs: [...projects],
    signatures: projects.map(projectLifecycleSignature),
    candidates: projects.filter((project) => project.status === 'active'
      || terminalProjectNeedsSynchronization(project)),
  };
  projectLifecycleIndexes.set(projects, index);
  return index;
}

function agreementLifecycleSignature(agreement: AgreementState): string {
  return [
    agreement.status,
    agreement.proposal.kind,
    agreement.responseDeadlineSuspensions?.length ?? 0,
  ].join('|');
}

function agreementLifecycleIndex(state: SimulationState): AgreementLifecycleIndex {
  const agreements = state.agreements;
  const existing = agreementLifecycleIndexes.get(agreements);
  if (existing && mutableIndexMatches(
    agreements,
    existing.itemRefs,
    existing.signatures,
    agreementLifecycleSignature,
  )) return existing;
  const index: AgreementLifecycleIndex = {
    itemRefs: [...agreements],
    signatures: agreements.map(agreementLifecycleSignature),
    lifecycleCandidates: agreements.filter((agreement) => agreement.status === 'proposed'
      || agreement.status === 'active'
      || (agreement.status === 'fulfilled' && agreement.proposal.kind === 'companion')),
    responseDeadlineCandidates: agreements.filter((agreement) => agreement.status === 'proposed'
      || Boolean(agreement.responseDeadlineSuspensions?.length)),
  };
  agreementLifecycleIndexes.set(agreements, index);
  return index;
}

function personIndex(state: Pick<DecisionAuthorityState, 'people'>): PersonIndex {
  const people = state.people;
  let index = personIndexes.get(people);
  if (!index || indexInvalid(people, index)) {
    index = { indexedLength: 0, byId: new Map(), living: [] };
    personIndexes.set(people, index);
  }
  for (let offset = index.indexedLength; offset < people.length; offset += 1) {
    const person = people[offset];
    // Preserve Array.find semantics for malformed duplicate ids: first wins.
    if (!index.byId.has(person.id)) index.byId.set(person.id, person);
    if (isAlive(person)) index.living.push(person);
  }
  index.indexedLength = people.length;
  index.lastIndexedItem = people.at(-1);
  return index;
}

/**
 * Discard the runtime-only people sidecar after a same-array middle rewrite.
 * Ordinary death is noticed by the O(L) live-ref recheck. Once a dead person
 * has been removed, an exceptional resurrection must call this hook because
 * no authoritative rule normally makes historical dead people live again.
 * Whole-array replacement, truncation, and old-tail replacement rebuild
 * automatically; no position or visibility result is cached here.
 */
export function invalidatePeopleIndex(state: SimulationState): void {
  personIndexes.delete(state.people);
}

function projectIndex(state: Pick<DecisionAuthorityState, 'projects'>): ProjectIndex {
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

function intentIndex(state: Pick<DecisionAuthorityState, 'intents'>): IntentIndex {
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

export function personById(
  state: Pick<DecisionAuthorityState, 'people'>,
  personId: PersonId,
): PersonState | undefined {
  return personIndex(state).byId.get(personId);
}

/**
 * Living people in authoritative array order. The candidate list contains at
 * most refs previously observed alive, while every call rechecks current body
 * and death fields so a death becomes visible within the same month.
 */
export function livingPeople(state: SimulationState): readonly PersonState[] {
  const index = personIndex(state);
  index.living = index.living.filter(isAlive);
  return index.living;
}

export function projectById(
  state: Pick<DecisionAuthorityState, 'projects'>,
  projectId: string,
): ProjectState | undefined {
  return projectIndex(state).byId.get(projectId);
}

export function projectsOwnedBy(state: SimulationState, ownerId: PersonId): readonly ProjectState[] {
  return projectIndex(state).byOwnerId.get(ownerId) ?? [];
}

export function intentById(
  state: Pick<DecisionAuthorityState, 'intents'>,
  intentId: string,
): Intent | undefined {
  return intentIndex(state).byId.get(intentId);
}

export function intentsOwnedBy(
  state: Pick<DecisionAuthorityState, 'intents'>,
  ownerId: PersonId,
): readonly Intent[] {
  return intentIndex(state).byOwnerId.get(ownerId) ?? [];
}

/** Ordered conservative superset; synchronizeProject remains authoritative. */
export function projectsRequiringMonthlySynchronization(state: SimulationState): readonly ProjectState[] {
  return projectLifecycleIndex(state).candidates;
}

/** Ordered conservative superset; advanceAgreementLifecycle rechecks live status. */
export function agreementsRequiringLifecycle(state: SimulationState): readonly AgreementState[] {
  return agreementLifecycleIndex(state).lifecycleCandidates;
}

/** Ordered conservative superset; suspension open/closed state is still recomputed dynamically. */
export function agreementsRequiringResponseDeadlineSynchronization(
  state: SimulationState,
): readonly AgreementState[] {
  return agreementLifecycleIndex(state).responseDeadlineCandidates;
}
