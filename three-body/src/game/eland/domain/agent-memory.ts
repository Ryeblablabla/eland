import { materialDefinition } from './material';
import type { ActionFact, DecisionFact, SimulationState } from './model';
import type {
  GoalOutcomeBelief,
  MemoryRecord,
  OutcomeBelief,
  PersonState,
} from './person';
import { memoryDurationMultiplier } from './trait';
import {
  languageBroadcastFromDiff,
  languageInterpreterIds,
  languageReceptionFor,
  perceivedLanguageText,
  type LanguageBroadcast,
} from './language-perception';

export const AGENT_MEMORY_STORE_VERSION = 'agent-memory-store-v3' as const;
/** Large person-local archive; prompt projection has its own much smaller token budget. */
export const MAX_AGENT_MEMORY_ITEMS_PER_OWNER = 4_096;
export const MAX_AGENT_MEMORY_SOURCES = 16;

export type AgentMemoryLane =
  | 'episodic'
  | 'semantic'
  | 'social'
  | 'procedural'
  | 'prospective'
  | 'dialogue';

export type AgentMemoryPrecision = 'exact' | 'specific' | 'general' | 'faint';

export interface AgentMemoryItem {
  id: string;
  ownerId: string;
  lane: AgentMemoryLane;
  gist: string;
  precision: AgentMemoryPrecision;
  confidence: number;
  salience: number;
  emotionalValence: number;
  personIds: string[];
  topicKeys: string[];
  sourceEventIds: string[];
  sourceMemoryIds: string[];
  unresolved: boolean;
  firstExperiencedAtMonth: number;
  lastExperiencedAtMonth: number;
  lastRecalledAtMonth: number;
  causalBasisKey?: string;
  causalOutcome?: 'completed' | 'progressed' | 'blocked' | 'failed';
  exactUtterance?: string;
  speechLineId?: string;
  replyToMemoryId?: string;
  dialogueSpeakerId?: string;
  dialoguePerceivedByPersonIds?: string[];
  consolidation?: {
    source: 'local' | 'model';
    sourceItemIds: string[];
    atMonth: number;
  };
}

export interface AgentMemoryStoreState {
  version: typeof AGENT_MEMORY_STORE_VERSION;
  nextOrdinal: number;
  items: AgentMemoryItem[];
}

export interface RecalledMemory {
  id: string;
  lane: AgentMemoryLane;
  gist: string;
  precision: AgentMemoryPrecision;
  confidence: number;
  salience: number;
  emotionalValence: number;
  personIds: string[];
  topicKeys: string[];
  sourceEventIds: string[];
  unresolved: boolean;
  firstExperiencedAtMonth: number;
  lastExperiencedAtMonth: number;
  lastRecalledAtMonth: number;
  causalBasisKey?: string;
  causalOutcome?: AgentMemoryItem['causalOutcome'];
  exactUtterance?: string;
  dialogueSpeakerId?: string;
  dialoguePerceivedByPersonIds?: string[];
}

export interface AgentMemoryQuery {
  atMonth: number;
  personIds?: readonly string[];
  topicKeys?: readonly string[];
  sourceEventIds?: readonly string[];
  textTerms?: readonly string[];
  /** Exclude memories that do not match any supplied person/topic/source/text focus. */
  requireFocusMatch?: boolean;
  actionBasisKey?: string;
  unresolved?: boolean;
  lanes?: readonly AgentMemoryLane[];
  laneLimits?: Partial<Record<AgentMemoryLane, number>>;
  tokenBudget?: number;
  limit?: number;
}

export interface LanguageMemoryInput {
  speechLineId: string;
  sourceEventId: string;
  sourceFactIds: readonly string[];
  atMonth: number;
  speakerId: string;
  perceivedByPersonIds: readonly string[];
  text: string;
  communicationKind: string;
  topic?: string;
  dialogueMove?: string;
  disposition?: 'continue' | 'close' | 'rupture';
  replyToSpeechLineId?: string;
}

export interface PlayerInteractionMemoryInput {
  interactionId: string;
  atMonth: number;
  agentId: string;
  userMessage: string;
  agentReply: string;
}

export interface AgentMemoryCompactionSource {
  handle: string;
  itemId: string;
  lane: AgentMemoryLane;
  gist: string;
  firstExperiencedAtMonth: number;
  lastExperiencedAtMonth: number;
  unresolved: boolean;
}

export interface AgentMemoryCompactionBatch {
  ownerId: string;
  ownerName: string;
  atMonth: number;
  sources: AgentMemoryCompactionSource[];
  existingCapsules: Array<{
    handle: string;
    itemId: string;
    lane: 'semantic' | 'procedural' | 'social';
    summary: string;
    sourceCount: number;
  }>;
}

export interface AgentMemoryCompactionCapsuleInput {
  summary: string;
  lane: 'semantic' | 'procedural' | 'social';
  sourceHandles: string[];
  unresolved: boolean;
}

const hydratedStores = new WeakSet<AgentMemoryStoreState>();

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));
}

function boundedText(value: unknown, maximum = 260): string {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/gu, ' ').slice(0, maximum).trim()
    : '';
}

function uniqueStrings(values: readonly unknown[], maximum = MAX_AGENT_MEMORY_SOURCES): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim()))].slice(-maximum);
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Exact dialogue identity is already encoded in the compact item's bounded
 * ID. Use that fingerprint instead of the human-readable causalBasisKey,
 * which is intentionally shortened during hydration and must not silently
 * turn a still-retained memory into a forgotten one.
 */
export function hasAgentRememberedGroundedConversationBasis(
  state: Pick<SimulationState, 'memoryStore'>,
  ownerId: string,
  basisKey: string,
  counterpartId: string,
): boolean {
  const normalizedBasis = boundedText(basisKey, 1_200);
  if (!normalizedBasis) return false;
  const identityCandidates = [normalizedBasis];
  const parts = normalizedBasis.split('|');
  const speakerIndex = parts.findIndex((part) => part.startsWith('speaker='));
  const listenerIndex = parts.findIndex((part) => part.startsWith('listener='));
  if (speakerIndex >= 0 && listenerIndex >= 0) {
    const reversed = [...parts];
    const speaker = parts[speakerIndex]!.slice('speaker='.length);
    const listener = parts[listenerIndex]!.slice('listener='.length);
    reversed[speakerIndex] = `speaker=${listener}`;
    reversed[listenerIndex] = `listener=${speaker}`;
    identityCandidates.push(reversed.join('|'));
  }
  const itemIds = new Set(identityCandidates.map((identity) => (
    `agent-memory:${ownerId}:conversation-basis:${stableHash(identity)}`
  )));
  return (state.memoryStore?.items ?? []).some((item) => itemIds.has(item.id)
    && item.ownerId === ownerId
    && item.lane === 'dialogue'
    && item.personIds.includes(counterpartId));
}

function normalizePrecision(value: unknown): AgentMemoryPrecision {
  return value === 'exact' || value === 'specific' || value === 'general' || value === 'faint'
    ? value
    : 'specific';
}

function normalizeLane(value: unknown): AgentMemoryLane | null {
  return value === 'episodic'
    || value === 'semantic'
    || value === 'social'
    || value === 'procedural'
    || value === 'prospective'
    || value === 'dialogue'
    ? value
    : null;
}

function normalizedMemoryItem(value: AgentMemoryItem): AgentMemoryItem | null {
  const lane = normalizeLane(value?.lane);
  const id = boundedText(value?.id, 180);
  const ownerId = boundedText(value?.ownerId, 120);
  const gist = boundedText(value?.gist);
  if (!lane || !id || !ownerId || !gist) return null;
  const first = Math.round(Number(value.firstExperiencedAtMonth) || 0);
  const last = Math.max(first, Math.round(Number(value.lastExperiencedAtMonth) || first));
  const exactUtterance = lane === 'dialogue' && normalizePrecision(value.precision) === 'exact'
    ? boundedText(value.exactUtterance, 180)
    : '';
  return {
    id,
    ownerId,
    lane,
    gist,
    precision: normalizePrecision(value.precision),
    confidence: clamp(Number(value.confidence)),
    salience: clamp(Number(value.salience)),
    emotionalValence: clamp(Number(value.emotionalValence), -1, 1),
    personIds: uniqueStrings(value.personIds ?? [], 8).filter((personId) => personId !== ownerId),
    topicKeys: uniqueStrings(value.topicKeys ?? [], 8),
    sourceEventIds: uniqueStrings(value.sourceEventIds ?? []),
    sourceMemoryIds: uniqueStrings(value.sourceMemoryIds ?? [], 24),
    unresolved: value.unresolved === true,
    firstExperiencedAtMonth: first,
    lastExperiencedAtMonth: last,
    lastRecalledAtMonth: Math.max(first, Math.round(Number(value.lastRecalledAtMonth) || last)),
    ...(boundedText(value.causalBasisKey, 240) ? { causalBasisKey: boundedText(value.causalBasisKey, 240) } : {}),
    ...(value.causalOutcome === 'completed'
      || value.causalOutcome === 'progressed'
      || value.causalOutcome === 'blocked'
      || value.causalOutcome === 'failed'
      ? { causalOutcome: value.causalOutcome }
      : {}),
    ...(exactUtterance ? { exactUtterance } : {}),
    ...(boundedText(value.speechLineId, 180) ? { speechLineId: boundedText(value.speechLineId, 180) } : {}),
    ...(boundedText(value.replyToMemoryId, 180) ? { replyToMemoryId: boundedText(value.replyToMemoryId, 180) } : {}),
    ...(boundedText(value.dialogueSpeakerId, 120)
      ? { dialogueSpeakerId: boundedText(value.dialogueSpeakerId, 120) }
      : {}),
    ...(Array.isArray(value.dialoguePerceivedByPersonIds)
      ? { dialoguePerceivedByPersonIds: uniqueStrings(value.dialoguePerceivedByPersonIds, 8) }
      : {}),
    ...(value.consolidation ? {
      consolidation: {
        source: value.consolidation.source === 'model' ? 'model' : 'local',
        sourceItemIds: uniqueStrings(value.consolidation.sourceItemIds ?? [], 24),
        atMonth: Math.round(Number(value.consolidation.atMonth) || last),
      },
    } : {}),
  };
}

function isSolitaryDecisionSelfEcho(item: AgentMemoryItem): boolean {
  return item.lane === 'dialogue'
    && item.ownerId === item.dialogueSpeakerId
    && item.personIds.length === 0
    && (item.dialoguePerceivedByPersonIds?.length ?? 0) === 0
    && (item.speechLineId?.includes('-decision-') === true
      || item.sourceEventIds.some((sourceEventId) => sourceEventId.includes('-decision-')));
}

export function createAgentMemoryStore(): AgentMemoryStoreState {
  const store: AgentMemoryStoreState = { version: AGENT_MEMORY_STORE_VERSION, nextOrdinal: 0, items: [] };
  hydratedStores.add(store);
  return store;
}

export function hydrateAgentMemoryStore(
  input: AgentMemoryStoreState | undefined,
  livingPersonIds: readonly string[] = [],
): AgentMemoryStoreState {
  if (input?.version !== AGENT_MEMORY_STORE_VERSION
    || !Array.isArray(input.items)) return createAgentMemoryStore();
  const validOwners = new Set(livingPersonIds);
  const items = input.items
    .map(normalizedMemoryItem)
    .filter((item): item is AgentMemoryItem => Boolean(item))
    .filter((item) => !isSolitaryDecisionSelfEcho(item))
    .filter((item) => validOwners.size === 0 || validOwners.has(item.ownerId));
  const retainedItems: AgentMemoryItem[] = [];
  for (const ownerId of new Set(items.map((item) => item.ownerId))) {
    retainedItems.push(...items.filter((item) => item.ownerId === ownerId)
      .sort((left, right) => Number(right.unresolved) - Number(left.unresolved)
        || right.salience - left.salience
        || right.lastExperiencedAtMonth - left.lastExperiencedAtMonth
        || left.id.localeCompare(right.id))
      .slice(0, MAX_AGENT_MEMORY_ITEMS_PER_OWNER));
  }
  const store: AgentMemoryStoreState = {
    version: AGENT_MEMORY_STORE_VERSION,
    nextOrdinal: Math.max(0, Math.round(Number(input.nextOrdinal) || 0)),
    items: retainedItems,
  };
  hydratedStores.add(store);
  return store;
}

type MemoryStoreOwner = Pick<SimulationState, 'memoryStore' | 'people'>;

export function ensureAgentMemoryStore(state: MemoryStoreOwner): AgentMemoryStoreState {
  if (state.memoryStore?.version === AGENT_MEMORY_STORE_VERSION
    && Array.isArray(state.memoryStore.items)
    && hydratedStores.has(state.memoryStore)) return state.memoryStore;
  state.memoryStore = hydrateAgentMemoryStore(state.memoryStore, state.people.map((person) => person.id));
  return state.memoryStore;
}

const MIN_MEMORY_COMPACTION_SOURCES = 8;
const MAX_MEMORY_COMPACTION_SOURCES = 24;

/** Select old, not-yet-compacted memories without exposing authoritative ids to the model. */
export function nextAgentMemoryCompactionBatch(
  state: MemoryStoreOwner,
  person: PersonState,
  atMonth: number,
): AgentMemoryCompactionBatch | null {
  const store = ensureAgentMemoryStore(state);
  const alreadyCompacted = new Set(store.items.flatMap((item) => item.consolidation?.sourceItemIds ?? []));
  const candidates = store.items
    .filter((item) => item.ownerId === person.id
      && !item.consolidation
      && !alreadyCompacted.has(item.id)
      && item.lastExperiencedAtMonth <= atMonth - 12)
    .sort((left, right) => left.lastExperiencedAtMonth - right.lastExperiencedAtMonth
      || right.salience - left.salience
      || left.id.localeCompare(right.id))
    .slice(0, MAX_MEMORY_COMPACTION_SOURCES);
  if (candidates.length < MIN_MEMORY_COMPACTION_SOURCES) return null;
  const existingCapsules = store.items
    .filter((item) => item.ownerId === person.id
      && item.consolidation?.source === 'model'
      && (item.lane === 'semantic' || item.lane === 'procedural' || item.lane === 'social'))
    .sort((left, right) => (right.consolidation?.atMonth ?? 0) - (left.consolidation?.atMonth ?? 0)
      || right.lastExperiencedAtMonth - left.lastExperiencedAtMonth
      || left.id.localeCompare(right.id))
    .slice(0, 12)
    .map((item, index) => ({
      handle: `c${index + 1}`,
      itemId: item.id,
      lane: item.lane as 'semantic' | 'procedural' | 'social',
      summary: item.gist,
      sourceCount: item.consolidation?.sourceItemIds.length ?? 0,
    }));
  return {
    ownerId: person.id,
    ownerName: person.name,
    atMonth,
    existingCapsules,
    sources: candidates.map((item, index) => ({
      handle: `r${index + 1}`,
      itemId: item.id,
      lane: item.lane,
      gist: item.gist,
      firstExperiencedAtMonth: item.firstExperiencedAtMonth,
      lastExperiencedAtMonth: item.lastExperiencedAtMonth,
      unresolved: item.unresolved,
    })),
  };
}

/**
 * Replace the model-written retrieval layer with one newly compacted view.
 * Every old capsule must be represented exactly once. A call may consume only
 * part of the new batch; omitted raw sources remain eligible for a later pass.
 */
export function applyAgentMemoryCompaction(
  state: MemoryStoreOwner,
  batch: AgentMemoryCompactionBatch,
  capsules: readonly AgentMemoryCompactionCapsuleInput[],
): number {
  const store = ensureAgentMemoryStore(state);
  const sourceByHandle = new Map(batch.sources.map((source) => [source.handle, source]));
  const existingByHandle = new Map(batch.existingCapsules.map((capsule) => [capsule.handle, capsule]));
  const itemById = new Map(store.items.map((item) => [item.id, item]));
  const expectedHandles = new Set([...sourceByHandle.keys(), ...existingByHandle.keys()]);
  const usedHandles = new Set<string>();
  const prepared: Array<{
    capsule: AgentMemoryCompactionCapsuleInput;
    sources: AgentMemoryItem[];
  }> = [];
  for (const capsule of capsules.slice(0, 4)) {
    const summary = boundedText(capsule.summary, 360);
    const handles = uniqueStrings(capsule.sourceHandles, 64)
      .filter((handle) => expectedHandles.has(handle));
    if (!summary || handles.length === 0 || handles.some((handle) => usedHandles.has(handle))) return 0;
    const sourceItems = handles.flatMap((handle) => {
      const source = sourceByHandle.get(handle);
      if (source) {
        const item = itemById.get(source.itemId);
        return item && item.ownerId === batch.ownerId ? [item] : [];
      }
      const existing = existingByHandle.get(handle);
      const compacted = existing ? itemById.get(existing.itemId) : undefined;
      if (!compacted || compacted.ownerId !== batch.ownerId
        || compacted.consolidation?.source !== 'model') return [];
      return compacted.consolidation.sourceItemIds.flatMap((itemId) => {
        const item = itemById.get(itemId);
        return item && item.ownerId === batch.ownerId ? [item] : [];
      });
    });
    const sources = [...new Map(sourceItems.map((item) => [item.id, item])).values()];
    if (sources.length === 0) return 0;
    handles.forEach((handle) => usedHandles.add(handle));
    prepared.push({ capsule: { ...capsule, summary }, sources });
  }
  const usedNewSourceCount = batch.sources
    .filter((source) => usedHandles.has(source.handle)).length;
  if (prepared.length === 0
    || usedNewSourceCount < 2
    || batch.existingCapsules.some((capsule) => !usedHandles.has(capsule.handle))) return 0;

  const replacedItemIds = new Set(batch.existingCapsules.map((capsule) => capsule.itemId));
  let nextOrdinal = store.nextOrdinal;
  const compactedItems: AgentMemoryItem[] = prepared.map(({ capsule, sources }) => {
    const sourceItemIds = sources.map((item) => item.id);
    const first = Math.min(...sources.map((item) => item.firstExperiencedAtMonth));
    const last = Math.max(...sources.map((item) => item.lastExperiencedAtMonth));
    const confidence = Math.round(sources.reduce((sum, item) => sum + item.confidence, 0) / sources.length * 0.9);
    const ordinal = nextOrdinal;
    nextOrdinal += 1;
    return {
      id: `agent-memory:${batch.ownerId}:compaction:${ordinal}`,
      ownerId: batch.ownerId,
      lane: capsule.lane,
      gist: capsule.summary,
      precision: 'general',
      confidence: clamp(confidence),
      salience: Math.max(...sources.map((item) => item.salience)),
      emotionalValence: clamp(
        sources.reduce((sum, item) => sum + item.emotionalValence, 0) / sources.length,
        -1,
        1,
      ),
      personIds: uniqueStrings(sources.flatMap((item) => item.personIds), 8),
      topicKeys: uniqueStrings(['memory:compacted', ...sources.flatMap((item) => item.topicKeys)], 8),
      sourceEventIds: uniqueStrings(sources.flatMap((item) => item.sourceEventIds)),
      sourceMemoryIds: uniqueStrings(sources.flatMap((item) => item.sourceMemoryIds), 24),
      unresolved: capsule.unresolved && sources.some((item) => item.unresolved),
      firstExperiencedAtMonth: first,
      lastExperiencedAtMonth: last,
      lastRecalledAtMonth: batch.atMonth,
      consolidation: {
        source: 'model',
        sourceItemIds,
        atMonth: batch.atMonth,
      },
    };
  });
  store.items = [
    ...store.items.filter((item) => !replacedItemIds.has(item.id)),
    ...compactedItems,
  ];
  store.nextOrdinal = nextOrdinal;
  enforceOwnerCapacity(store, batch.ownerId, batch.atMonth);
  return prepared.length;
}

export function agentMemoryStoreOf(state: Pick<SimulationState, 'memoryStore'>): AgentMemoryStoreState {
  return state.memoryStore?.version === AGENT_MEMORY_STORE_VERSION
    ? state.memoryStore
    : createAgentMemoryStore();
}

function memoryLaneForLegacy(memory: MemoryRecord): AgentMemoryLane {
  if (memory.kind === 'dialogue') return 'dialogue';
  if (memory.kind === 'commitment') return 'prospective';
  return 'episodic';
}

function memoryValence(memory: MemoryRecord): number {
  if (memory.causal) return clamp(memory.causal.valence, -1, 1);
  return memory.kind === 'failure' ? -0.65 : memory.kind === 'commitment' ? 0.2 : 0;
}

function topicKeysForLegacy(memory: MemoryRecord): string[] {
  return uniqueStrings([
    `memory:${memory.kind}`,
    ...(memory.causal?.basisKey ? [`action:${memory.causal.basisKey}`] : []),
    ...(memory.causal?.consequenceTags ?? []).map((tag) => `consequence:${tag}`),
  ], 8);
}

function memoryItemForLegacy(person: PersonState, memory: MemoryRecord): AgentMemoryItem {
  return {
    id: `agent-memory:${person.id}:${stableHash(memory.id)}`,
    ownerId: person.id,
    lane: memoryLaneForLegacy(memory),
    gist: boundedText(memory.summary) || '记得发生过一件事',
    precision: memory.kind === 'summary' ? 'general' : 'specific',
    confidence: memory.kind === 'summary' ? 58 : 82,
    salience: clamp(memory.importance),
    emotionalValence: memoryValence(memory),
    personIds: uniqueStrings(memory.personIds, 8),
    topicKeys: topicKeysForLegacy(memory),
    sourceEventIds: uniqueStrings(memory.sourceEventIds),
    sourceMemoryIds: [memory.id],
    unresolved: memory.kind === 'commitment'
      || memory.kind === 'failure'
        && memory.expiresAtMonth !== undefined
        && memory.expiresAtMonth >= memory.createdAtMonth,
    firstExperiencedAtMonth: memory.createdAtMonth,
    lastExperiencedAtMonth: memory.createdAtMonth,
    lastRecalledAtMonth: memory.lastRecalledAtMonth,
    ...(memory.causal?.basisKey ? { causalBasisKey: memory.causal.basisKey } : {}),
    ...(memory.causal?.outcome ? { causalOutcome: memory.causal.outcome } : {}),
  };
}

function legacyMemoryWorthKeeping(memory: MemoryRecord): boolean {
  if (memory.kind === 'dialogue' || memory.kind === 'commitment' || memory.kind === 'failure') return true;
  if (memory.kind === 'summary') return memory.importance >= 55;
  return memory.importance >= 60 || memory.personIds.length > 0;
}

function recentLivedEpisodeWorthRecalling(
  person: PersonState,
  memory: MemoryRecord,
  atMonth: number,
): boolean {
  if (memory.kind !== 'episode') return false;
  if (memory.causal?.basisKey.includes('|move|') || memory.summary.includes('移动到目标位置')) return false;
  return atMonth - memory.createdAtMonth <= 3 * memoryDurationMultiplier(person);
}

function mergeLegacyItem(target: AgentMemoryItem, candidate: AgentMemoryItem): void {
  target.sourceMemoryIds = uniqueStrings([...target.sourceMemoryIds, ...candidate.sourceMemoryIds], 24);
  target.sourceEventIds = uniqueStrings([...target.sourceEventIds, ...candidate.sourceEventIds]);
  target.personIds = uniqueStrings([...target.personIds, ...candidate.personIds], 8);
  target.topicKeys = uniqueStrings([...target.topicKeys, ...candidate.topicKeys], 8);
  target.salience = Math.max(target.salience, candidate.salience);
  target.confidence = Math.max(target.confidence, candidate.confidence);
  target.unresolved ||= candidate.unresolved;
  target.firstExperiencedAtMonth = Math.min(target.firstExperiencedAtMonth, candidate.firstExperiencedAtMonth);
  target.lastExperiencedAtMonth = Math.max(target.lastExperiencedAtMonth, candidate.lastExperiencedAtMonth);
  target.lastRecalledAtMonth = Math.max(target.lastRecalledAtMonth, candidate.lastRecalledAtMonth);
  if (candidate.gist.length > target.gist.length) target.gist = candidate.gist;
  if (!target.causalBasisKey && candidate.causalBasisKey) target.causalBasisKey = candidate.causalBasisKey;
  if (!target.causalOutcome && candidate.causalOutcome) target.causalOutcome = candidate.causalOutcome;
}

function protectedItemIds(store: AgentMemoryStoreState): Set<string> {
  void store;
  return new Set();
}

function retentionScore(item: AgentMemoryItem, atMonth: number): number {
  const age = Math.max(0, atMonth - item.lastExperiencedAtMonth);
  return item.salience
    + item.confidence * 0.25
    + (item.unresolved ? 40 : 0)
    + (item.lane === 'prospective' ? 18 : 0)
    - Math.min(80, age * 0.8);
}

function enforceOwnerCapacity(store: AgentMemoryStoreState, ownerId: string, atMonth: number): void {
  const protectedIds = protectedItemIds(store);
  const ownerItems = store.items.filter((item) => item.ownerId === ownerId);
  if (ownerItems.length <= MAX_AGENT_MEMORY_ITEMS_PER_OWNER) return;
  const keepIds = new Set(ownerItems
    .sort((left, right) => Number(protectedIds.has(right.id)) - Number(protectedIds.has(left.id))
      || retentionScore(right, atMonth) - retentionScore(left, atMonth)
      || right.lastExperiencedAtMonth - left.lastExperiencedAtMonth
      || left.id.localeCompare(right.id))
    .slice(0, MAX_AGENT_MEMORY_ITEMS_PER_OWNER)
    .map((item) => item.id));
  store.items = store.items.filter((item) => item.ownerId !== ownerId || keepIds.has(item.id));
}

function synchronizeLegacyMemories(state: SimulationState, atMonth: number): void {
  const store = ensureAgentMemoryStore(state);
  for (const person of state.people) {
    const consumed = new Set(store.items
      .filter((item) => item.ownerId === person.id)
      .flatMap((item) => item.sourceMemoryIds));
    for (const memory of person.memories) {
      if (consumed.has(memory.id) || !legacyMemoryWorthKeeping(memory)) continue;
      const candidate = memoryItemForLegacy(person, memory);
      const duplicate = store.items.find((item) => item.ownerId === person.id
        && item.lane === candidate.lane
        && !item.exactUtterance
        && item.sourceEventIds.some((sourceId) => candidate.sourceEventIds.includes(sourceId)));
      if (duplicate) mergeLegacyItem(duplicate, candidate);
      else store.items.push(candidate);
      consumed.add(memory.id);
    }
    enforceOwnerCapacity(store, person.id, atMonth);
  }
}

function precisionForAge(item: AgentMemoryItem, person: PersonState | undefined, atMonth: number): AgentMemoryPrecision | null {
  const multiplier = person ? memoryDurationMultiplier(person) : 1;
  const age = Math.max(0, atMonth - item.lastExperiencedAtMonth) / multiplier;
  const exactWindow = item.lane === 'dialogue' ? 4 : 6;
  if (age <= exactWindow) return item.exactUtterance ? 'exact' : 'specific';
  if (age <= 18) return 'specific';
  if (age <= 60) return 'general';
  return 'faint';
}

function blurItem(item: AgentMemoryItem, nextPrecision: AgentMemoryPrecision): void {
  item.precision = nextPrecision;
  if (nextPrecision !== 'exact') delete item.exactUtterance;
  if (nextPrecision === 'general') {
    item.gist = boundedText(`大概记得：${item.gist}`, 220);
    item.confidence = clamp(item.confidence - 8);
  } else if (nextPrecision === 'faint') {
    const compactGist = item.gist.replace(/^(?:大概记得：|模糊记得：)/u, '');
    item.gist = boundedText(`模糊记得：${compactGist}`, 140);
    item.confidence = clamp(item.confidence - 18);
  }
}

export function maintainAgentMemoryStore(state: SimulationState, atMonth: number): void {
  synchronizeLegacyMemories(state, atMonth);
  const store = ensureAgentMemoryStore(state);
  const protectedIds = protectedItemIds(store);
  for (const item of [...store.items]) {
    if (protectedIds.has(item.id)) continue;
    const person = state.people.find((candidate) => candidate.id === item.ownerId);
    const nextPrecision = precisionForAge(item, person, atMonth);
    if (!nextPrecision && !item.unresolved) {
      store.items = store.items.filter((candidate) => candidate.id !== item.id);
      continue;
    }
    if (nextPrecision && nextPrecision !== item.precision) blurItem(item, nextPrecision);
  }
  for (const ownerId of new Set(store.items.map((item) => item.ownerId))) {
    enforceOwnerCapacity(store, ownerId, atMonth);
  }
}

type LanguageMemoryEvent = ActionFact | DecisionFact;

function broadcastForLanguageEvent(event: LanguageMemoryEvent): LanguageBroadcast | undefined {
  return event.kind === 'decision' ? event.languageBroadcast : languageBroadcastFromDiff(event.diff);
}

function languageEventForMemory(state: SimulationState, input: LanguageMemoryInput): LanguageMemoryEvent | undefined {
  const event = state.world.past.find((candidate): candidate is LanguageMemoryEvent => (
    candidate.id === input.sourceEventId && (candidate.kind === 'action' || candidate.kind === 'decision')
  ));
  if (!event || event.who !== input.speakerId) return undefined;
  if (event.kind === 'action' && (event.status !== 'completed' || event.action.kind !== 'talk')) return undefined;
  const broadcast = broadcastForLanguageEvent(event);
  return broadcast
    && input.perceivedByPersonIds.every((personId) => broadcast.perceivedByPersonIds.includes(personId))
    ? event
    : undefined;
}

function languageGist(input: LanguageMemoryInput, ownerId: string, perceivedText: string): string {
  const role = ownerId === input.speakerId ? '自己说过' : '听见';
  return `${role}：“${boundedText(perceivedText, 180)}”`;
}

export function writeLanguageMemory(state: SimulationState, input: LanguageMemoryInput): string[] {
  const event = languageEventForMemory(state, input);
  const text = boundedText(input.text, 180);
  if (!event || !text) return [];
  const broadcast = broadcastForLanguageEvent(event);
  if (!broadcast) return [];
  const groundedBasisKey = event.kind === 'action' && event.action.kind === 'talk'
    && event.action.speakerMeaning.kind === 'claim'
    ? boundedText(event.action.speakerMeaning.conversation?.basisKey, 1_200)
    : '';
  const store = ensureAgentMemoryStore(state);
  const ownerIds = uniqueStrings(
    event.kind === 'decision'
      ? input.perceivedByPersonIds.filter((personId) => personId !== input.speakerId)
      : [input.speakerId, ...input.perceivedByPersonIds],
    Math.max(8, state.people.length + 1),
  );
  const written: string[] = [];
  for (const ownerId of ownerIds) {
    if (!state.people.some((person) => person.id === ownerId)) continue;
    const perceivedText = perceivedLanguageText({
      broadcast: { ...broadcast, text },
      observerId: ownerId,
      speakerId: input.speakerId,
      seed: state.seed,
    });
    if (!perceivedText) continue;
    const reception = languageReceptionFor(broadcast, ownerId);
    const legacyMemoryId = `memory:${input.sourceEventId}:${ownerId}`;
    store.items = store.items.filter((item) => !(item.ownerId === ownerId
      && !item.exactUtterance
      && item.sourceMemoryIds.includes(legacyMemoryId)));
    const id = `agent-memory:${ownerId}:speech:${stableHash(input.speechLineId)}`;
    const existingSpeech = store.items.find((item) => item.id === id);
    if (existingSpeech) {
      if (groundedBasisKey && !existingSpeech.causalBasisKey) existingSpeech.causalBasisKey = groundedBasisKey;
      written.push(id);
      continue;
    }
    const counterpartIds = ownerIds.filter((personId) => personId !== ownerId);
    const replyToMemoryId = input.replyToSpeechLineId
      ? store.items.find((item) => item.ownerId === ownerId && item.speechLineId === input.replyToSpeechLineId)?.id
      : undefined;
    if (replyToMemoryId) {
      const parent = store.items.find((item) => item.id === replyToMemoryId);
      if (parent) parent.unresolved = false;
    }
    const item: AgentMemoryItem = {
      id,
      ownerId,
      lane: 'dialogue',
      gist: languageGist(input, ownerId, perceivedText),
      precision: ownerId === input.speakerId || reception?.decoded
        ? 'exact'
        : (reception?.intelligibility ?? 0) >= 0.45 ? 'specific' : 'faint',
      confidence: ownerId === input.speakerId ? 100 : Math.round(25 + (reception?.intelligibility ?? 0) * 70),
      salience: input.disposition === 'rupture' ? 90 : input.replyToSpeechLineId ? 70 : 64,
      emotionalValence: input.disposition === 'rupture' ? -0.8 : input.disposition === 'close' ? 0 : 0.1,
      personIds: counterpartIds,
      topicKeys: uniqueStrings([
        `dialogue:${boundedText(input.topic, 80) || input.communicationKind}`,
        ...(input.dialogueMove ? [`move:${input.dialogueMove}`] : []),
      ], 8),
      sourceEventIds: uniqueStrings([input.sourceEventId, ...input.sourceFactIds]),
      sourceMemoryIds: [`speech:${input.speechLineId}`, legacyMemoryId],
      unresolved: input.disposition === 'continue',
      firstExperiencedAtMonth: input.atMonth,
      lastExperiencedAtMonth: input.atMonth,
      lastRecalledAtMonth: input.atMonth,
      ...(groundedBasisKey ? { causalBasisKey: groundedBasisKey } : {}),
      exactUtterance: perceivedText,
      speechLineId: input.speechLineId,
      ...(replyToMemoryId ? { replyToMemoryId } : {}),
      dialogueSpeakerId: input.speakerId,
      dialoguePerceivedByPersonIds: [...input.perceivedByPersonIds],
    };
    store.items.push(item);
    written.push(id);
    enforceOwnerCapacity(store, ownerId, input.atMonth);
  }
  return written;
}

/** Persist the one outward language wave produced by a model decision. */
export function rememberDecisionLanguage(state: SimulationState, fact: DecisionFact): string[] {
  const broadcast = fact.languageBroadcast;
  const mentalAct = 'mentalAct' in fact.decision ? fact.decision.mentalAct : undefined;
  if (!broadcast || !mentalAct?.utterance.trim()) return [];
  const store = ensureAgentMemoryStore(state);
  const ownerIds = uniqueStrings(
    broadcast.perceivedByPersonIds.filter((personId) => personId !== fact.who),
    Math.max(8, state.people.length + 1),
  );
  const written: string[] = [];
  for (const ownerId of ownerIds) {
    const owner = state.people.find((person) => person.id === ownerId);
    if (!owner) continue;
    const perceivedText = perceivedLanguageText({
      broadcast,
      observerId: ownerId,
      speakerId: fact.who,
      seed: state.seed,
    });
    if (!perceivedText) continue;
    const reception = languageReceptionFor(broadcast, ownerId);
    const speechLineId = `speech:${state.branchId}:${fact.id}`;
    const id = `agent-memory:${ownerId}:speech:${stableHash(speechLineId)}`;
    if (store.items.some((item) => item.id === id)) {
      written.push(id);
      continue;
    }
    store.items.push({
      id,
      ownerId,
      lane: 'dialogue',
      gist: ownerId === fact.who
        ? `自己说过：“${boundedText(perceivedText, 180)}”`
        : `听见${state.people.find((person) => person.id === fact.who)?.name ?? '某人'}：“${boundedText(perceivedText, 180)}”`,
      precision: ownerId === fact.who || reception?.decoded
        ? 'exact'
        : (reception?.intelligibility ?? 0) >= 0.45 ? 'specific' : 'faint',
      confidence: ownerId === fact.who ? 100 : Math.round(25 + (reception?.intelligibility ?? 0) * 70),
      salience: ownerId === fact.who ? 58 : 52,
      emotionalValence: 0,
      personIds: ownerId === fact.who ? broadcast.perceivedByPersonIds : [fact.who],
      topicKeys: ['language:decision', `mental-act:${mentalAct.kind}`],
      sourceEventIds: [fact.id],
      sourceMemoryIds: [`speech:${fact.id}:${ownerId}`],
      unresolved: false,
      firstExperiencedAtMonth: fact.atMonth,
      lastExperiencedAtMonth: fact.atMonth,
      lastRecalledAtMonth: fact.atMonth,
      exactUtterance: perceivedText,
      speechLineId,
      dialogueSpeakerId: fact.who,
      dialoguePerceivedByPersonIds: [...broadcast.perceivedByPersonIds],
    });
    written.push(id);
    enforceOwnerCapacity(store, ownerId, fact.atMonth);
  }
  return written;
}

/**
 * Rule-driven evolution has no rendered speech-line pass, but a completed
 * grounded conversation must still enter the same bounded subjective memory
 * used by live sessions. This compact item remembers only who discussed which
 * sourced basis; it neither pins relation history nor forbids later retelling
 * after ordinary memory decay removes the item.
 */
export function rememberGroundedConversationBasis(
  state: SimulationState,
  event: ActionFact,
): string[] {
  if (event.status !== 'completed'
    || event.action.kind !== 'talk'
    || event.action.speakerMeaning.kind !== 'claim'
    || !event.action.speakerMeaning.conversation) return [];
  const conversation = event.action.speakerMeaning.conversation;
  const basisKey = boundedText(conversation.basisKey, 1_200);
  if (!basisKey) return [];
  const understoodBy = languageInterpreterIds(event.diff, event.action.speakerMeaning.id);
  const store = ensureAgentMemoryStore(state);
  const ownerIds = uniqueStrings([
    event.who,
    ...understoodBy,
  ], Math.max(2, state.people.length + 1));
  const written: string[] = [];
  for (const ownerId of ownerIds) {
    if (!state.people.some((person) => person.id === ownerId)) continue;
    const counterpartIds = ownerId === event.who
      ? understoodBy
      : [event.who];
    const id = `agent-memory:${ownerId}:conversation-basis:${stableHash(basisKey)}`;
    const sourceEventIds = uniqueStrings([event.id, ...conversation.sourceFactIds]);
    const existing = store.items.find((item) => item.id === id && item.ownerId === ownerId);
    if (existing) {
      existing.gist = boundedText(event.action.speakerMeaning.summary) || existing.gist;
      existing.confidence = Math.max(existing.confidence, 82);
      existing.salience = Math.max(existing.salience, 62);
      existing.personIds = uniqueStrings([...existing.personIds, ...counterpartIds], 8);
      existing.topicKeys = uniqueStrings([
        ...existing.topicKeys,
        `dialogue:${conversation.topic}`,
      ], 8);
      existing.sourceEventIds = uniqueStrings([...existing.sourceEventIds, ...sourceEventIds]);
      existing.sourceMemoryIds = uniqueStrings([
        ...existing.sourceMemoryIds,
        `memory:${event.id}:${ownerId}`,
      ], 24);
      existing.lastExperiencedAtMonth = Math.max(existing.lastExperiencedAtMonth, event.atMonth);
      existing.lastRecalledAtMonth = Math.max(existing.lastRecalledAtMonth, event.atMonth);
      existing.unresolved = false;
      written.push(id);
      continue;
    }
    store.items.push({
      id,
      ownerId,
      lane: 'dialogue',
      gist: boundedText(event.action.speakerMeaning.summary) || '记得一次有来源的交谈',
      precision: 'specific',
      confidence: 82,
      salience: 62,
      emotionalValence: 0.1,
      personIds: counterpartIds,
      topicKeys: [`dialogue:${conversation.topic}`],
      sourceEventIds,
      sourceMemoryIds: [`memory:${event.id}:${ownerId}`],
      unresolved: false,
      firstExperiencedAtMonth: event.atMonth,
      lastExperiencedAtMonth: event.atMonth,
      lastRecalledAtMonth: event.atMonth,
      causalBasisKey: basisKey,
      dialogueSpeakerId: event.who,
      dialoguePerceivedByPersonIds: [...understoodBy],
    });
    written.push(id);
    enforceOwnerCapacity(store, ownerId, event.atMonth);
  }
  return written;
}

/**
 * A persisted player thread is a source for the person's subjective memory,
 * but never a WorldEvent. Keep it source-bound through sourceMemoryIds and do
 * not manufacture sourceEventIds, knowledge, relation or action outcomes.
 */
export function writePlayerInteractionMemory(
  state: SimulationState,
  input: PlayerInteractionMemoryInput,
): string[] {
  const agent = state.people.find((person) => person.id === input.agentId);
  const interactionId = boundedText(input.interactionId, 180);
  const userMessage = boundedText(input.userMessage, 4_000);
  const agentReply = boundedText(input.agentReply, 4_000);
  if (!agent || !interactionId || !userMessage || !agentReply) return [];
  const store = ensureAgentMemoryStore(state);
  const exchanges = [
    {
      role: 'player',
      gist: `主对我说：“${userMessage}”`,
      text: userMessage,
      speakerId: 'player',
      perceivedByPersonIds: [agent.id],
      salience: 70,
    },
    {
      role: 'agent',
      gist: `我回答主：“${agentReply}”`,
      text: agentReply,
      speakerId: agent.id,
      perceivedByPersonIds: ['player'],
      salience: 66,
    },
  ] as const;
  const written: string[] = [];
  for (const exchange of exchanges) {
    const id = `agent-memory:${agent.id}:interaction:${stableHash(`${interactionId}:${exchange.role}`)}`;
    if (store.items.some((item) => item.id === id)) {
      written.push(id);
      continue;
    }
    store.items.push({
      id,
      ownerId: agent.id,
      lane: 'dialogue',
      gist: boundedText(exchange.gist),
      precision: 'exact',
      confidence: 100,
      salience: exchange.salience,
      emotionalValence: 0.1,
      personIds: [],
      topicKeys: ['dialogue:player-interaction'],
      sourceEventIds: [],
      sourceMemoryIds: [`agent-interaction:${interactionId}:${exchange.role}`],
      unresolved: false,
      firstExperiencedAtMonth: input.atMonth,
      lastExperiencedAtMonth: input.atMonth,
      lastRecalledAtMonth: input.atMonth,
      exactUtterance: boundedText(exchange.text, 180),
      dialogueSpeakerId: exchange.speakerId,
      dialoguePerceivedByPersonIds: [...exchange.perceivedByPersonIds],
    });
    written.push(id);
  }
  enforceOwnerCapacity(store, agent.id, input.atMonth);
  return written;
}

type AgentMemoryReadState = Pick<SimulationState, 'memoryStore' | 'people' | 'clock' | 'projects'>;

function relationGist(state: AgentMemoryReadState, personId: string, trust: number, bond: number, fear: number): string {
  const name = state.people.find((candidate) => candidate.id === personId)?.name ?? '某个人';
  const tone = fear >= 40 ? '对其保持戒惧'
    : trust >= 55 && bond >= 45 ? '把对方视为亲近且可信的人'
      : trust >= 30 ? '大体愿意相信对方'
        : bond >= 30 ? '对对方感到熟悉'
          : '只知道彼此有过来往';
  return `对${name}的印象：${tone}`;
}

function materialNameInCognitiveKey(key: string): string | undefined {
  const materialId = /material-(\d+)/u.exec(key)?.[1];
  return materialId === undefined ? undefined : materialDefinition(Number(materialId)).name;
}

function actionExperienceLabel(basisKey: string): string {
  const actionKey = basisKey.split('|')[1] ?? '';
  if (actionKey === 'move') return '移动到目标位置';
  if (actionKey.startsWith('transfer:')) {
    const materialName = materialNameInCognitiveKey(actionKey) ?? '物品';
    return actionKey.includes('->person') ? `把${materialName}交给他人或自己` : `搬运${materialName}`;
  }
  if (actionKey.startsWith('attend:')) return '观察眼前的具体对象';
  if (actionKey.startsWith('talk:')) {
    const topic = actionKey.split(':')[1] ?? '';
    const label = topic.startsWith('proposal-') ? '提出具体约定'
      : topic === 'request' ? '提出请求'
        : topic === 'offer' ? '提出帮助或交换'
          : topic === 'accept' ? '回应并接受约定'
            : topic === 'reject' ? '回应并拒绝约定'
              : topic === 'withdraw' ? '撤回约定'
                : '进行有来源的交谈';
    return label;
  }
  if (actionKey.startsWith('act:')) {
    const operation = actionKey.split(':')[1] ?? '';
    return operation === 'combine' ? '结合随身材料'
      : operation === 'separate' ? '从物质中分离可用部分'
        : operation === 'expose' ? '让随身材料接触眼前环境'
          : operation === 'exert' ? '用力或工具处理眼前对象'
            : operation === 'ingest' ? '食用或饮用随身物质'
              : operation === 'hunt' ? '捕猎眼前动物'
                : operation === 'reproduce' ? '完成一次双方同意的生殖尝试'
                  : operation === 'dehydrate' ? '进入脱水休眠'
                    : operation === 'rehydrate' ? '帮助结束脱水休眠'
                      : operation === 'inter' ? '安葬遗体'
                        : '执行一项具体行动';
  }
  return '执行同类具体行动';
}

function goalExperienceLabel(basisKey: string): string {
  const goalKey = basisKey.split('|').find((part) => part.startsWith('goal='))?.slice('goal='.length) ?? 'none';
  if (goalKey === 'project-completed') return '完成持续项目';
  if (goalKey.startsWith('inventory-at-least:') || goalKey.startsWith('container-inventory-at-least:')) {
    return `取得足够的${materialNameInCognitiveKey(goalKey) ?? '物资'}`;
  }
  if (goalKey.startsWith('voxel-is:')) return `形成${materialNameInCognitiveKey(goalKey) ?? '目标'}实体`;
  if (goalKey === 'at-cell') return '到达目标地点';
  if (goalKey === 'sheltered') return '进入真实遮蔽';
  if (goalKey === 'knowledge') return '确认一项具体观察或知识';
  if (goalKey === 'near-person') return '到达目标人物身边';
  if (goalKey.startsWith('body-at-least:hydration')) return '恢复水分';
  if (goalKey.startsWith('body-at-least:nutrition')) return '恢复营养';
  if (goalKey.startsWith('body-at-least:health')) return '恢复健康';
  if (goalKey.startsWith('condition:pregnancy:present')) return '形成妊娠';
  if (goalKey.startsWith('condition:')) return '改变一项具体身体状态';
  if (goalKey === 'agreement-fulfilled' || goalKey === 'agreement-contribution-recorded') return '履行具体约定';
  if (goalKey === 'death-mourned') return '完成哀悼';
  if (goalKey === 'remains-interred') return '完成安葬';
  if (goalKey === 'memorial-marked') return '留下纪念标记';
  if (goalKey === 'representation-made') return '完成一次具体表达';
  return '达到这项行动的具体目标';
}

function outcomeMemory(person: PersonState, belief: OutcomeBelief): RecalledMemory {
  const success = belief.attempts > 0 ? (belief.completed + belief.progressed * 0.5) / belief.attempts : 0.5;
  return {
    id: `procedural:${person.id}:${belief.basisKey}`,
    lane: 'procedural',
    gist: `关于“${actionExperienceLabel(belief.basisKey)}”的亲身经验：尝试${belief.attempts}次，其中完成${belief.completed}次、有进展${belief.progressed}次、受阻${belief.blocked}次、失败${belief.failed}次`,
    precision: 'general',
    confidence: clamp(40 + belief.attempts * 8),
    salience: clamp(35 + belief.attempts * 5),
    emotionalValence: clamp(success * 2 - 1, -1, 1),
    personIds: [],
    topicKeys: [`action:${belief.basisKey}`],
    sourceEventIds: uniqueStrings(belief.sourceEventIds),
    unresolved: false,
    firstExperiencedAtMonth: belief.lastUpdatedAtMonth,
    lastExperiencedAtMonth: belief.lastUpdatedAtMonth,
    lastRecalledAtMonth: belief.lastUpdatedAtMonth,
    causalBasisKey: belief.basisKey,
  };
}

function goalOutcomeMemory(person: PersonState, belief: GoalOutcomeBelief): RecalledMemory {
  const success = belief.attempts > 0 ? belief.achieved / belief.attempts : 0.5;
  return {
    id: `goal-outcome:${person.id}:${belief.basisKey}`,
    lane: 'procedural',
    gist: `以“${goalExperienceLabel(belief.basisKey)}”为目标${belief.attempts}次，其中达成${belief.achieved}次、尝试后未达成${belief.attemptedUnmet}次`,
    precision: 'general',
    confidence: clamp(40 + belief.attempts * 8),
    salience: clamp(40 + belief.attempts * 6),
    emotionalValence: clamp(success * 2 - 1, -1, 1),
    personIds: [],
    topicKeys: [`goal:${belief.basisKey}`],
    sourceEventIds: uniqueStrings(belief.sourceEventIds),
    unresolved: belief.attemptedUnmet > 0 && belief.achieved === 0,
    firstExperiencedAtMonth: belief.lastUpdatedAtMonth,
    lastExperiencedAtMonth: belief.lastUpdatedAtMonth,
    lastRecalledAtMonth: belief.lastUpdatedAtMonth,
    causalBasisKey: belief.basisKey,
  };
}

function proceduralMemories(person: PersonState): RecalledMemory[] {
  const actionByBasis = new Map((person.cognition?.outcomeBeliefs ?? [])
    .map((belief) => [belief.basisKey, outcomeMemory(person, belief)] as const));
  const goalByBasis = new Map((person.cognition?.goalOutcomeBeliefs ?? [])
    .map((belief) => [belief.basisKey, goalOutcomeMemory(person, belief)] as const));
  return [...new Set([...actionByBasis.keys(), ...goalByBasis.keys()])].map((basisKey) => {
    const action = actionByBasis.get(basisKey);
    const goal = goalByBasis.get(basisKey);
    if (!action) return goal!;
    if (!goal) return action;
    return {
      ...action,
      id: `procedural:${person.id}:combined:${basisKey}`,
      gist: `${action.gist}；${goal.gist}`,
      confidence: Math.max(action.confidence, goal.confidence),
      salience: Math.max(action.salience, goal.salience),
      emotionalValence: clamp((action.emotionalValence + goal.emotionalValence) / 2, -1, 1),
      sourceEventIds: uniqueStrings([...action.sourceEventIds, ...goal.sourceEventIds]),
      unresolved: goal.unresolved,
      firstExperiencedAtMonth: Math.min(action.firstExperiencedAtMonth, goal.firstExperiencedAtMonth),
      lastExperiencedAtMonth: Math.max(action.lastExperiencedAtMonth, goal.lastExperiencedAtMonth),
      lastRecalledAtMonth: Math.max(action.lastRecalledAtMonth, goal.lastRecalledAtMonth),
    };
  });
}

/**
 * A completed project needs one consolidated autobiographical summary, not
 * merely a list of low-level moves, transfers, and material operations. The
 * project and its frozen NeedResolutionEpisode already provide the
 * authoritative bridge; this projection makes that existing evidence
 * recallable as stable self-knowledge.
 */
function resolvedNeedMemories(
  state: AgentMemoryReadState,
  person: PersonState,
): RecalledMemory[] {
  const projects = new Map(state.projects.map((project) => [project.id, project] as const));
  return (person.cognition?.needResolutionEpisodes ?? []).flatMap((episode): RecalledMemory[] => {
    const project = projects.get(episode.projectId);
    if (!project || project.status !== 'completed') return [];
    const sourceEventIds = uniqueStrings(
      episode.sourceFactIds.length ? episode.sourceFactIds : episode.outcomeEventIds,
    );
    if (!sourceEventIds.length) return [];
    const age = Math.max(0, state.clock.elapsedMonths - episode.observedAtMonth)
      / memoryDurationMultiplier(person);
    const precision: AgentMemoryPrecision = age <= 18 ? 'specific' : age <= 60 ? 'general' : 'faint';
    const prefix = precision === 'faint' ? '模糊记得自己曾完成过' : '记得自己完成过';
    const participantIds = uniqueStrings([
      project.ownerId,
      ...project.contributorIds,
      ...project.beneficiaryIds,
    ], 8).filter((personId) => personId !== person.id);
    const evidenceSalience = Math.round(Math.log2(sourceEventIds.length + 1) * 6);
    return [{
      id: `resolved-need:${person.id}:${episode.id}`,
      lane: 'semantic',
      gist: `${prefix}：${boundedText(project.summary, 180)}`,
      precision,
      confidence: precision === 'specific' ? 90 : precision === 'general' ? 80 : 66,
      salience: clamp(62 + evidenceSalience),
      emotionalValence: 0,
      personIds: participantIds,
      topicKeys: uniqueStrings([
        'experience:need-resolution',
        'project:completed',
        `project:${project.id}`,
        `need:${episode.projectNeed}`,
        `function:${episode.desiredFunction}`,
      ], 8),
      sourceEventIds,
      unresolved: false,
      firstExperiencedAtMonth: episode.observedAtMonth,
      lastExperiencedAtMonth: episode.observedAtMonth,
      lastRecalledAtMonth: episode.observedAtMonth,
      causalBasisKey: episode.basisKey,
      causalOutcome: 'completed',
    }];
  });
}

function dynamicMemories(state: AgentMemoryReadState, person: PersonState): RecalledMemory[] {
  const storedLegacyIds = new Set(agentMemoryStoreOf(state).items
    .filter((item) => item.ownerId === person.id)
    .flatMap((item) => item.sourceMemoryIds));
  const legacy = person.memories
    .filter((memory) => !storedLegacyIds.has(memory.id)
      && (legacyMemoryWorthKeeping(memory)
        || recentLivedEpisodeWorthRecalling(person, memory, state.clock.elapsedMonths)))
    .map((memory) => memoryItemForLegacy(person, memory));
  const semantic = [
    ...person.knowledge.map((fact): RecalledMemory => ({
      id: `semantic:${person.id}:${fact.id}`,
      lane: 'semantic',
      gist: fact.summary,
      precision: fact.confidence >= 70 ? 'specific' : 'general',
      confidence: clamp(fact.confidence),
      salience: clamp(30 + fact.confidence * 0.55),
      emotionalValence: 0,
      personIds: [],
      topicKeys: [`knowledge:${fact.kind}`, `knowledge-id:${fact.id}`],
      sourceEventIds: uniqueStrings(fact.sourceEventIds),
      unresolved: fact.confidence < 55,
      firstExperiencedAtMonth: fact.learnedAtMonth,
      lastExperiencedAtMonth: fact.learnedAtMonth,
      lastRecalledAtMonth: fact.learnedAtMonth,
    })),
    ...person.knownPlaces.map((place): RecalledMemory => ({
      id: `place:${person.id}:${place.id}`,
      lane: 'semantic',
      gist: `记得${materialDefinition(place.materialId).name}曾在一个已知地点出现`,
      precision: 'specific',
      confidence: clamp(82 - Math.max(0, state.clock.elapsedMonths - place.lastConfirmedAtMonth)),
      salience: 48,
      emotionalValence: 0,
      personIds: [],
      topicKeys: [`place:material:${place.materialId}`],
      sourceEventIds: uniqueStrings(place.sourceEventIds),
      unresolved: false,
      firstExperiencedAtMonth: place.learnedAtMonth,
      lastExperiencedAtMonth: place.lastConfirmedAtMonth,
      lastRecalledAtMonth: place.lastConfirmedAtMonth,
    })),
  ];
  const social = person.relations.filter((relation) => relation.sourceEventIds.length > 0
    && Math.max(relation.trust, relation.bond, relation.fear) >= 25).map((relation): RecalledMemory => ({
    id: `social:${person.id}:${relation.personId}`,
    lane: 'social',
    gist: relationGist(state, relation.personId, relation.trust, relation.bond, relation.fear),
    precision: 'general',
    confidence: clamp(45 + Math.max(relation.trust, relation.bond, relation.fear) * 0.5),
    salience: clamp(35 + Math.max(relation.trust, relation.bond, relation.fear) * 0.6),
    emotionalValence: clamp((relation.trust + relation.bond - relation.fear * 1.5) / 200, -1, 1),
    personIds: [relation.personId],
    topicKeys: ['social:relationship'],
    sourceEventIds: uniqueStrings(relation.sourceEventIds),
    unresolved: relation.fear >= 40,
    firstExperiencedAtMonth: 0,
    lastExperiencedAtMonth: state.clock.elapsedMonths,
    lastRecalledAtMonth: state.clock.elapsedMonths,
  }));
  const procedural = proceduralMemories(person);
  const resolvedNeeds = resolvedNeedMemories(state, person);
  const prospective = (person.characterAgenda?.items ?? []).map((agenda): RecalledMemory => ({
    id: `prospective:${person.id}:${agenda.id}`,
    lane: 'prospective',
    gist: `仍在意：${agenda.aim}`,
    precision: 'specific',
    confidence: 100,
    salience: clamp(agenda.importance),
    emotionalValence: agenda.status === 'blocked' ? -0.5 : 0.2,
    personIds: [],
    topicKeys: [`agenda:${agenda.theme}`, `agenda-id:${agenda.id}`],
    sourceEventIds: uniqueStrings(agenda.sourceFactIds),
    unresolved: agenda.status !== 'fulfilled' && agenda.status !== 'abandoned',
    firstExperiencedAtMonth: agenda.createdAtMonth,
    lastExperiencedAtMonth: agenda.lastReviewedAtMonth,
    lastRecalledAtMonth: agenda.lastReviewedAtMonth,
  }));
  return [...legacy, ...semantic, ...social, ...procedural, ...resolvedNeeds, ...prospective];
}

function personalityRecallBias(person: PersonState, memory: RecalledMemory): number {
  const score = (trait: keyof PersonState['personality']['baseline']) => Math.max(0, Math.min(100,
    person.personality.baseline[trait] + person.personality.learnedDelta[trait]));
  const learned = person.personality.learnedDelta;
  const negative = Math.max(0, -memory.emotionalValence);
  const positive = Math.max(0, memory.emotionalValence);
  const social = memory.lane === 'social' || memory.lane === 'dialogue';
  const commitment = memory.lane === 'prospective'
    || memory.topicKeys.some((topic) => /commit|agenda|agreement|promise|project/u.test(topic));
  const inquiry = memory.lane === 'semantic' || memory.lane === 'procedural' && memory.unresolved;
  const practicedSuccess = memory.lane === 'procedural' && positive >= 0.25;
  const stableBias = negative * (score('emotionality') - 50) * 0.12
    + (social ? (score('extraversion') + score('agreeableness') - 100) * 0.06 : 0)
    + (commitment ? (score('conscientiousness') - 50) * 0.14 : 0)
    + (inquiry ? (score('openness') - 50) * 0.12 : 0)
    + (practicedSuccess ? (score('conscientiousness') + score('openness') - 100) * 0.05 : 0);
  // Sourced learned deltas get a small additional effect so repeated life
  // experience can visibly change recall order without erasing salience,
  // recency, participant, topic, or causal-basis matches.
  const adaptiveBias = negative * learned.emotionality * 0.3
    + (social ? (learned.extraversion + learned.agreeableness) * 0.18 : 0)
    + (commitment ? learned.conscientiousness * 0.32 : 0)
    + (inquiry ? learned.openness * 0.28 : 0)
    + (practicedSuccess ? (learned.conscientiousness + learned.openness) * 0.12 : 0);
  return Math.max(-18, Math.min(18, stableBias + adaptiveBias));
}

interface PreparedMemoryFocus {
  people: Set<string>;
  topics: Set<string>;
  sources: Set<string>;
  textTerms: string[];
}

function prepareMemoryFocus(query: AgentMemoryQuery): PreparedMemoryFocus {
  return {
    people: new Set(query.personIds ?? []),
    topics: new Set(query.topicKeys ?? []),
    sources: new Set(query.sourceEventIds ?? []),
    textTerms: [...new Set((query.textTerms ?? [])
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean))],
  };
}

function queryFocusScore(memory: RecalledMemory, focus: PreparedMemoryFocus): number {
  const personMatch = focus.people.size
    && memory.personIds.some((personId) => focus.people.has(personId)) ? 70 : 0;
  const topicMatch = focus.topics.size
    && memory.topicKeys.some((topic) => focus.topics.has(topic)) ? 55 : 0;
  const sourceMatch = focus.sources.size
    && memory.sourceEventIds.some((sourceId) => focus.sources.has(sourceId)) ? 100 : 0;
  const text = `${memory.gist}\n${memory.topicKeys.join('\n')}\n${memory.causalBasisKey ?? ''}`.toLowerCase();
  const textMatchCount = focus.textTerms.filter((term) => text.includes(term)).length;
  const textMatch = textMatchCount > 0 ? Math.min(80, 44 + (textMatchCount - 1) * 12) : 0;
  return personMatch + topicMatch + sourceMatch + textMatch;
}

function matchesQueryFocus(memory: RecalledMemory, focus: PreparedMemoryFocus): boolean {
  const text = `${memory.gist}\n${memory.topicKeys.join('\n')}\n${memory.causalBasisKey ?? ''}`.toLowerCase();
  return memory.personIds.some((personId) => focus.people.has(personId))
    || memory.topicKeys.some((topic) => focus.topics.has(topic))
    || focus.textTerms.some((term) => text.includes(term));
}

function queryScore(
  memory: RecalledMemory,
  query: AgentMemoryQuery,
  person: PersonState,
  focus: PreparedMemoryFocus,
): number {
  const age = Math.max(0, query.atMonth - memory.lastExperiencedAtMonth);
  const basisMatch = query.actionBasisKey && memory.causalBasisKey === query.actionBasisKey ? 85 : 0;
  const unresolvedMatch = query.unresolved === true && memory.unresolved ? 45 : 0;
  return queryFocusScore(memory, focus) + basisMatch + unresolvedMatch
    + memory.salience * 0.7 + memory.confidence * 0.25
    + (memory.unresolved ? 18 : 0)
    + personalityRecallBias(person, memory)
    - Math.min(70, age * 0.9);
}

function asRecalled(item: AgentMemoryItem): RecalledMemory {
  return {
    id: item.id,
    lane: item.lane,
    gist: item.gist,
    precision: item.precision,
    confidence: item.confidence,
    salience: item.salience,
    emotionalValence: item.emotionalValence,
    personIds: [...item.personIds],
    topicKeys: [...item.topicKeys],
    sourceEventIds: [...item.sourceEventIds],
    unresolved: item.unresolved,
    firstExperiencedAtMonth: item.firstExperiencedAtMonth,
    lastExperiencedAtMonth: item.lastExperiencedAtMonth,
    lastRecalledAtMonth: item.lastRecalledAtMonth,
    ...(item.causalBasisKey ? { causalBasisKey: item.causalBasisKey } : {}),
    ...(item.causalOutcome ? { causalOutcome: item.causalOutcome } : {}),
    ...(item.exactUtterance ? { exactUtterance: item.exactUtterance } : {}),
    ...(item.dialogueSpeakerId ? { dialogueSpeakerId: item.dialogueSpeakerId } : {}),
    ...(item.dialoguePerceivedByPersonIds ? { dialoguePerceivedByPersonIds: [...item.dialoguePerceivedByPersonIds] } : {}),
  };
}

function personVisibleMemory(person: PersonState, memory: RecalledMemory): RecalledMemory | null {
  // Persisted v17 states may already contain planner-only failures written by
  // older code. No source means there is no lived episode to project, even
  // though the backing record remains readable for schema compatibility.
  if (memory.lane === 'episodic' && !memory.sourceEventIds.length) return null;
  if (memory.lane !== 'episodic') return memory;
  const noResponseKnowledge = person.knowledge.find((fact) => (
    fact.id.startsWith('observation:no-response:')
      && fact.sourceEventIds.some((sourceId) => memory.sourceEventIds.includes(sourceId))
  ));
  return noResponseKnowledge
    ? { ...memory, gist: `亲自${noResponseKnowledge.summary}` }
    : memory;
}

export function retrieveAgentMemories(
  state: AgentMemoryReadState,
  person: PersonState,
  query: AgentMemoryQuery,
): RecalledMemory[] {
  const laneFilter = query.lanes?.length ? new Set(query.lanes) : null;
  const focus = prepareMemoryFocus(query);
  const all = [
    ...agentMemoryStoreOf(state).items.filter((item) => item.ownerId === person.id).map(asRecalled),
    ...dynamicMemories(state, person),
  ].map((memory) => personVisibleMemory(person, memory))
    .filter((memory): memory is RecalledMemory => Boolean(memory))
    .filter((memory) => !laneFilter || laneFilter.has(memory.lane))
    .filter((memory) => !query.requireFocusMatch || matchesQueryFocus(memory, focus));
  const scoreCache = new WeakMap<RecalledMemory, number>();
  const score = (memory: RecalledMemory): number => {
    const cached = scoreCache.get(memory);
    if (cached !== undefined) return cached;
    const value = queryScore(memory, query, person, focus);
    scoreCache.set(memory, value);
    return value;
  };
  const unique = new Map<string, RecalledMemory>();
  for (const memory of all) {
    // One replayable event may have both an old Action memory and an old
    // Intent-wrapper memory. They are one experienced fact, not two episodes.
    const key = memory.lane === 'episodic' && memory.sourceEventIds.length
      ? `episodic:${[...memory.sourceEventIds].sort().join('|')}`
      : memory.id;
    const existing = unique.get(key);
    if (!existing || score(memory) > score(existing)) unique.set(key, memory);
  }
  const sorted = [...unique.values()].sort((left, right) => score(right) - score(left)
    || right.lastExperiencedAtMonth - left.lastExperiencedAtMonth
    || left.id.localeCompare(right.id));
  const laneCounts = new Map<AgentMemoryLane, number>();
  const result: RecalledMemory[] = [];
  const maximum = Math.max(1, Math.min(64, Math.round(query.limit ?? 10)));
  const budget = Math.max(120, Math.min(8_000, Math.round(query.tokenBudget ?? 1_200)));
  let used = 0;
  for (const memory of sorted) {
    const laneLimit = query.laneLimits?.[memory.lane] ?? 4;
    if ((laneCounts.get(memory.lane) ?? 0) >= laneLimit) continue;
    const cost = Math.max(12, Math.ceil((memory.exactUtterance ?? memory.gist).length / 2));
    if (result.length > 0 && used + cost > budget) continue;
    result.push(memory);
    used += cost;
    laneCounts.set(memory.lane, (laneCounts.get(memory.lane) ?? 0) + 1);
    if (result.length >= maximum) break;
  }
  return result;
}

export function agendaMemorySignals(
  state: AgentMemoryReadState,
  person: PersonState,
  atMonth: number,
): RecalledMemory[] {
  return retrieveAgentMemories(state, person, {
    atMonth,
    unresolved: true,
    lanes: ['episodic', 'prospective', 'dialogue'],
    laneLimits: { episodic: 3, prospective: 3, dialogue: 2 },
    limit: 6,
    tokenBudget: 900,
  }).filter((memory) => memory.unresolved && memory.salience >= 58);
}
