import type { PersonState } from './person';

export const CHARACTER_AGENDA_VERSION = 'character-agenda-v1' as const;
export const MAX_CHARACTER_AGENDA_ITEMS = 8;
export const MAX_CHARACTER_AGENDA_APPROACHES = 6;
export const MAX_CHARACTER_AGENDA_EVALUATIONS = 8;
const MAX_CHARACTER_AGENDA_FACT_IDS = 24;
const MAX_CHARACTER_AGENDA_INTENT_IDS = 16;
const MAX_CHARACTER_AGENDA_PROJECT_IDS = 8;

export type CharacterAgendaOrigin =
  | 'local-deliberation'
  | 'model-proposal'
  | 'conversation'
  | 'project'
  | 'experienced-outcome';

export type CharacterAgendaStatus =
  | 'incubating'
  | 'active'
  | 'suspended'
  | 'blocked'
  | 'fulfilled'
  | 'abandoned';

/**
 * A proposal may be imaginative, but its current relationship to the physical
 * and social world is classified locally before it becomes an executable
 * Intent. An agenda item is never itself executable.
 */
export type CharacterAgendaApproachDisposition =
  | 'executable-now'
  | 'bounded-experiment'
  | 'observation-needed'
  | 'consent-required'
  | 'missing-affordance'
  | 'waiting-for-evidence'
  | 'contradicted-approach';

export type CharacterAgendaApproachOutcome = 'supported' | 'refuted' | 'blocked' | 'parked';

export interface CharacterAgendaVoxelRef {
  kind: 'voxel';
  position: { x: number; y: number; z: number };
}

/** Opaque local refs only: probes never name a material, output, or recipe. */
export type CharacterAgendaObservationTargetRef =
  | CharacterAgendaVoxelRef
  | { kind: 'drop'; dropId: string }
  | { kind: 'container'; containerId: string }
  | { kind: 'own-inventory-stack'; stackId: string }
  | { kind: 'animal'; animalId: string }
  | { kind: 'remains'; remainsId: string }
  | { kind: 'person'; personId: string };

export type CharacterAgendaProbe =
  | { kind: 'observe'; target: CharacterAgendaObservationTargetRef }
  | { kind: 'combine'; ownStackIds: [string, string] | [string, string, string] }
  | { kind: 'expose'; inputStackId: string; target: CharacterAgendaVoxelRef }
  | { kind: 'exert'; toolStackId: string; inputStackId: string; target: CharacterAgendaVoxelRef };

export interface CharacterAgendaApproachProposal {
  /** Stable semantic identity supplied by a local compiler when possible. */
  basisKey?: string;
  summary: string;
  disposition: CharacterAgendaApproachDisposition;
  /** Optional on raw model output; the local compiler supplies grounded facts. */
  sourceFactIds?: string[];
  /** Optional bounded physical probe; application code revalidates ownership and visibility. */
  probe?: CharacterAgendaProbe;
}

export interface CharacterAgendaProposal {
  /** Stable semantic identity supplied by a local compiler when possible. */
  basisKey?: string;
  aim: string;
  theme: string;
  importance: number;
  horizonMonths: number;
  /** Optional on raw model output; authoritative insertion requires grounding. */
  sourceFactIds?: string[];
  approach: CharacterAgendaApproachProposal;
}

/**
 * A model may change a person's durable subjective direction without claiming
 * that a world action has happened. `create` and `revise` still pass through
 * the local proposal compiler; `pause` and `abandon` only change this person's
 * own agenda state.
 */
export type CharacterAgendaUpdate =
  | { kind: 'create'; proposal: CharacterAgendaProposal }
  | { kind: 'revise'; proposal: CharacterAgendaProposal }
  | { kind: 'pause'; basisKey: string; reason: string }
  | { kind: 'abandon'; basisKey: string; reason: string };

export interface CharacterAgendaApproachEvaluation {
  ordinal: number;
  atMonth: number;
  outcome: CharacterAgendaApproachOutcome;
  /** Facts available when this evaluation was made, used to stop blind retries. */
  basisFactIds: string[];
  /** Replayable result facts. parked may legitimately have none. */
  evidenceFactIds: string[];
  note?: string;
}

export interface CharacterAgendaApproach {
  id: string;
  basisKey: string;
  summary: string;
  disposition: CharacterAgendaApproachDisposition;
  createdAtMonth: number;
  lastConsideredAtMonth: number;
  sourceFactIds: string[];
  probe?: CharacterAgendaProbe;
  /** Executable episodes that tried this means; the approach itself is not an Intent. */
  attemptIntentIds: string[];
  evaluations: CharacterAgendaApproachEvaluation[];
  latestOutcome?: CharacterAgendaApproachOutcome;
}

export interface CharacterAgendaItem {
  id: string;
  basisKey: string;
  aim: string;
  theme: string;
  importance: number;
  horizonMonths: number;
  targetAtMonth: number;
  origin: CharacterAgendaOrigin;
  status: CharacterAgendaStatus;
  createdAtMonth: number;
  lastReviewedAtMonth: number;
  sourceFactIds: string[];
  approaches: CharacterAgendaApproach[];
  intentIds: string[];
  projectIds: string[];
  activeIntentId?: string;
  activeApproachId?: string;
}

export interface CharacterAgendaState {
  version: typeof CHARACTER_AGENDA_VERSION;
  items: CharacterAgendaItem[];
}

/** Bounded audit embedded in the authoritative DecisionFact. */
export interface CharacterAgendaDecisionEvidence {
  version: 'character-agenda-decision-v1';
  source: 'model-proposal' | 'local-deliberation';
  outcome: CharacterAgendaUpsertOutcome;
  compilerDisposition:
    | 'accepted-observation'
    | 'accepted-experiment'
    | 'accepted-existing-action'
    | 'deferred-missing-affordance'
    | 'accepted-subjective-transition'
    | 'rejected-authority-claim';
  operation?: CharacterAgendaUpdate['kind'];
  aim: string;
  sourceFactIds: string[];
  agendaItemId?: string;
  approachId?: string;
  approachDisposition?: CharacterAgendaApproachDisposition;
}

export type CharacterAgendaUpsertOutcome =
  | 'created'
  | 'updated'
  | 'duplicate-without-new-evidence'
  | 'capacity-full'
  | 'approach-capacity-full'
  | 'paused'
  | 'abandoned'
  | 'transition-noop'
  | 'agenda-item-not-found'
  | 'invalid-proposal'
  | 'ungrounded-proposal';

export interface CharacterAgendaUpsertResult {
  state: CharacterAgendaState;
  accepted: boolean;
  outcome: CharacterAgendaUpsertOutcome;
  item?: CharacterAgendaItem;
  approach?: CharacterAgendaApproach;
  evictedItemId?: string;
  evictedApproachId?: string;
}

export type CharacterAgendaReconcileOutcome =
  | 'recorded'
  | 'agenda-item-not-found'
  | 'approach-not-found'
  | 'missing-outcome-evidence'
  | 'blind-retry-suppressed';

export interface CharacterAgendaReconcileResult {
  state: CharacterAgendaState;
  accepted: boolean;
  outcome: CharacterAgendaReconcileOutcome;
  item?: CharacterAgendaItem;
  approach?: CharacterAgendaApproach;
}

export type CharacterAgendaBindOutcome =
  | 'bound'
  | 'agenda-item-not-found'
  | 'approach-not-found'
  | 'invalid-intent-id'
  | 'intent-link-capacity-full'
  | 'project-link-capacity-full';

export interface CharacterAgendaBindResult {
  state: CharacterAgendaState;
  accepted: boolean;
  outcome: CharacterAgendaBindOutcome;
  item?: CharacterAgendaItem;
  approach?: CharacterAgendaApproach;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(numeric)));
}

function boundedText(value: unknown, fallback: string, maximumLength = 240): string {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') : '';
  return (text || fallback).slice(0, maximumLength);
}

function uniqueFactIds(values: readonly unknown[] = []): string[] {
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim()))]
    .slice(-MAX_CHARACTER_AGENDA_FACT_IDS);
}

function uniqueIds(values: readonly unknown[], maximum: number): string[] {
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim()))]
    .slice(-maximum);
}

function mergeFactIds(...groups: readonly (readonly unknown[])[]): string[] {
  return uniqueFactIds(groups.flat());
}

function semanticComponent(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .trim()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 160) || 'unspecified';
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function characterAgendaBasisKey(proposal: Pick<CharacterAgendaProposal, 'basisKey' | 'theme' | 'aim'>): string {
  const explicit = typeof proposal.basisKey === 'string' ? proposal.basisKey.trim() : '';
  if (explicit.startsWith('agenda-v1|')) return explicit;
  return explicit
    ? `agenda-v1|${semanticComponent(explicit)}`
    : `agenda-v1|${semanticComponent(proposal.theme)}|${semanticComponent(proposal.aim)}`;
}

export function characterAgendaApproachBasisKey(
  agendaBasisKey: string,
  proposal: Pick<CharacterAgendaApproachProposal, 'basisKey' | 'summary'>,
): string {
  const explicit = typeof proposal.basisKey === 'string' ? proposal.basisKey.trim() : '';
  if (explicit.startsWith(`${agendaBasisKey}|approach|`)) return explicit;
  return `${agendaBasisKey}|approach|${semanticComponent(explicit || proposal.summary)}`;
}

function agendaId(basisKey: string): string {
  return `character-agenda-${stableHash(basisKey)}`;
}

function approachId(basisKey: string): string {
  return `character-approach-${stableHash(basisKey)}`;
}

function isOrigin(value: unknown): value is CharacterAgendaOrigin {
  return value === 'local-deliberation'
    || value === 'model-proposal'
    || value === 'conversation'
    || value === 'project'
    || value === 'experienced-outcome';
}

function isStatus(value: unknown): value is CharacterAgendaStatus {
  return value === 'incubating'
    || value === 'active'
    || value === 'suspended'
    || value === 'blocked'
    || value === 'fulfilled'
    || value === 'abandoned';
}

function isDisposition(value: unknown): value is CharacterAgendaApproachDisposition {
  return value === 'executable-now'
    || value === 'bounded-experiment'
    || value === 'observation-needed'
    || value === 'consent-required'
    || value === 'missing-affordance'
    || value === 'waiting-for-evidence'
    || value === 'contradicted-approach';
}

function isOutcome(value: unknown): value is CharacterAgendaApproachOutcome {
  return value === 'supported' || value === 'refuted' || value === 'blocked' || value === 'parked';
}

function normalizeVoxelRef(value: CharacterAgendaVoxelRef | undefined): CharacterAgendaVoxelRef | undefined {
  if (value?.kind !== 'voxel'
    || !Number.isInteger(value.position?.x)
    || !Number.isInteger(value.position?.y)
    || !Number.isInteger(value.position?.z)) return undefined;
  return {
    kind: 'voxel',
    position: { x: value.position.x, y: value.position.y, z: value.position.z },
  };
}

function normalizeObservationTarget(
  value: CharacterAgendaObservationTargetRef | undefined,
): CharacterAgendaObservationTargetRef | undefined {
  if (!value) return undefined;
  if (value.kind === 'voxel') return normalizeVoxelRef(value);
  if (value.kind === 'drop' && value.dropId?.trim()) return { kind: value.kind, dropId: value.dropId.trim() };
  if (value.kind === 'container' && value.containerId?.trim()) return { kind: value.kind, containerId: value.containerId.trim() };
  if (value.kind === 'own-inventory-stack' && value.stackId?.trim()) return { kind: value.kind, stackId: value.stackId.trim() };
  if (value.kind === 'animal' && value.animalId?.trim()) return { kind: value.kind, animalId: value.animalId.trim() };
  if (value.kind === 'remains' && value.remainsId?.trim()) return { kind: value.kind, remainsId: value.remainsId.trim() };
  if (value.kind === 'person' && value.personId?.trim()) return { kind: value.kind, personId: value.personId.trim() };
  return undefined;
}

function normalizeProbe(value: CharacterAgendaProbe | undefined): CharacterAgendaProbe | undefined {
  if (!value) return undefined;
  if (value.kind === 'observe') {
    const target = normalizeObservationTarget(value.target);
    return target ? { kind: 'observe', target } : undefined;
  }
  if (value.kind === 'combine') {
    const stackIds = uniqueIds(value.ownStackIds ?? [], 3);
    if (stackIds.length < 2) return undefined;
    return stackIds.length === 2
      ? { kind: 'combine', ownStackIds: [stackIds[0], stackIds[1]] }
      : { kind: 'combine', ownStackIds: [stackIds[0], stackIds[1], stackIds[2]] };
  }
  if (value.kind === 'expose') {
    const target = normalizeVoxelRef(value.target);
    return value.inputStackId?.trim() && target
      ? { kind: 'expose', inputStackId: value.inputStackId.trim(), target }
      : undefined;
  }
  if (value.kind === 'exert') {
    const target = normalizeVoxelRef(value.target);
    return value.toolStackId?.trim() && value.inputStackId?.trim() && target
      ? {
          kind: 'exert',
          toolStackId: value.toolStackId.trim(),
          inputStackId: value.inputStackId.trim(),
          target,
        }
      : undefined;
  }
  return undefined;
}

function normalizeEvaluation(
  value: CharacterAgendaApproachEvaluation,
  ordinal: number,
  fallbackMonth: number,
): CharacterAgendaApproachEvaluation | null {
  if (!isOutcome(value?.outcome)) return null;
  return {
    ordinal,
    atMonth: boundedInteger(value.atMonth, fallbackMonth, -120_000, 120_000),
    outcome: value.outcome,
    basisFactIds: uniqueFactIds(value.basisFactIds),
    evidenceFactIds: uniqueFactIds(value.evidenceFactIds),
    ...(typeof value.note === 'string' && value.note.trim()
      ? { note: boundedText(value.note, '', 180) }
      : {}),
  };
}

function normalizeApproach(
  value: CharacterAgendaApproach,
  agendaBasis: string,
  fallbackMonth: number,
): CharacterAgendaApproach | null {
  const summary = boundedText(value?.summary, '尚未形成具体办法');
  const basisKey = characterAgendaApproachBasisKey(agendaBasis, {
    basisKey: value?.basisKey,
    summary,
  });
  const evaluations = (Array.isArray(value?.evaluations) ? value.evaluations : [])
    .slice(-MAX_CHARACTER_AGENDA_EVALUATIONS)
    .map((evaluation, index) => normalizeEvaluation(evaluation, index + 1, fallbackMonth))
    .filter((evaluation): evaluation is CharacterAgendaApproachEvaluation => evaluation !== null);
  return {
    id: approachId(basisKey),
    basisKey,
    summary,
    disposition: isDisposition(value?.disposition) ? value.disposition : 'waiting-for-evidence',
    createdAtMonth: boundedInteger(value?.createdAtMonth, fallbackMonth, -120_000, 120_000),
    lastConsideredAtMonth: boundedInteger(value?.lastConsideredAtMonth, fallbackMonth, -120_000, 120_000),
    sourceFactIds: uniqueFactIds(value?.sourceFactIds),
    ...(normalizeProbe(value?.probe) ? { probe: normalizeProbe(value.probe)! } : {}),
    attemptIntentIds: uniqueIds(value?.attemptIntentIds ?? [], MAX_CHARACTER_AGENDA_INTENT_IDS),
    evaluations,
    ...(evaluations.length ? { latestOutcome: evaluations.at(-1)!.outcome } : {}),
  };
}

function normalizeItem(value: CharacterAgendaItem, fallbackMonth: number): CharacterAgendaItem | null {
  const aim = boundedText(value?.aim, '尚未说清的长期关切');
  const theme = boundedText(value?.theme, 'personal', 80);
  const basisKey = characterAgendaBasisKey({ basisKey: value?.basisKey, theme, aim });
  const approaches = (Array.isArray(value?.approaches) ? value.approaches : [])
    .map((approach) => normalizeApproach(approach, basisKey, fallbackMonth))
    .filter((approach): approach is CharacterAgendaApproach => approach !== null)
    .filter((approach, index, all) => all.findIndex((candidate) => candidate.basisKey === approach.basisKey) === index)
    .slice(0, MAX_CHARACTER_AGENDA_APPROACHES);
  const createdAtMonth = boundedInteger(value?.createdAtMonth, fallbackMonth, -120_000, 120_000);
  const horizonMonths = boundedInteger(value?.horizonMonths, 12, 1, 240);
  const activeApproachId = approaches.some((approach) => approach.id === value?.activeApproachId)
    ? value.activeApproachId
    : undefined;
  const intentIds = uniqueIds(value?.intentIds ?? [], MAX_CHARACTER_AGENDA_INTENT_IDS);
  const activeIntentId = typeof value?.activeIntentId === 'string' && intentIds.includes(value.activeIntentId)
    ? value.activeIntentId
    : undefined;
  return {
    id: agendaId(basisKey),
    basisKey,
    aim,
    theme,
    importance: boundedInteger(value?.importance, 50, 0, 100),
    horizonMonths,
    targetAtMonth: boundedInteger(value?.targetAtMonth, createdAtMonth + horizonMonths, -120_000, 120_000),
    origin: isOrigin(value?.origin) ? value.origin : 'local-deliberation',
    status: isStatus(value?.status) ? value.status : 'active',
    createdAtMonth,
    lastReviewedAtMonth: boundedInteger(value?.lastReviewedAtMonth, createdAtMonth, -120_000, 120_000),
    sourceFactIds: uniqueFactIds(value?.sourceFactIds),
    approaches,
    intentIds,
    projectIds: uniqueIds(value?.projectIds ?? [], MAX_CHARACTER_AGENDA_PROJECT_IDS),
    ...(activeIntentId ? { activeIntentId } : {}),
    ...(activeApproachId ? { activeApproachId } : {}),
  };
}

export function createCharacterAgendaState(): CharacterAgendaState {
  return { version: CHARACTER_AGENDA_VERSION, items: [] };
}

/** Hydrates schema-v17 optional state without reconstructing intentions from history. */
export function hydrateCharacterAgendaState(
  input: CharacterAgendaState | undefined,
  atMonth = 0,
): CharacterAgendaState {
  if (input?.version !== CHARACTER_AGENDA_VERSION || !Array.isArray(input.items)) {
    return createCharacterAgendaState();
  }
  const normalized = input.items
    .map((item) => normalizeItem(item, atMonth))
    .filter((item): item is CharacterAgendaItem => item !== null)
    .filter((item, index, all) => all.findIndex((candidate) => candidate.basisKey === item.basisKey) === index);
  const retained = [...normalized]
    .sort((left, right) => {
      const leftOpen = left.status !== 'fulfilled' && left.status !== 'abandoned' && left.status !== 'suspended' ? 1 : 0;
      const rightOpen = right.status !== 'fulfilled' && right.status !== 'abandoned' && right.status !== 'suspended' ? 1 : 0;
      return rightOpen - leftOpen
        || right.importance - left.importance
        || right.lastReviewedAtMonth - left.lastReviewedAtMonth
        || left.id.localeCompare(right.id);
    })
    .slice(0, MAX_CHARACTER_AGENDA_ITEMS);
  const retainedIds = new Set(retained.map((item) => item.id));
  return {
    version: CHARACTER_AGENDA_VERSION,
    items: normalized.filter((item) => retainedIds.has(item.id)),
  };
}

/** Read-only callers receive a normalized copy and never mutate legacy saves. */
export function characterAgendaStateOf(person: Pick<PersonState, 'characterAgenda'>, atMonth = 0): CharacterAgendaState {
  return hydrateCharacterAgendaState(person.characterAgenda, atMonth);
}

/** State hydration owns this one intentional mutation. Deliberation functions below are pure. */
export function ensureCharacterAgendaState(person: Pick<PersonState, 'characterAgenda'>, atMonth = 0): CharacterAgendaState {
  person.characterAgenda = hydrateCharacterAgendaState(person.characterAgenda, atMonth);
  return person.characterAgenda;
}

function createApproach(
  agendaBasis: string,
  proposal: CharacterAgendaApproachProposal,
  sourceFactIds: string[],
  atMonth: number,
): CharacterAgendaApproach {
  const basisKey = characterAgendaApproachBasisKey(agendaBasis, proposal);
  const probe = normalizeProbe(proposal.probe);
  return {
    id: approachId(basisKey),
    basisKey,
    summary: boundedText(proposal.summary, '先观察再决定'),
    disposition: isDisposition(proposal.disposition) ? proposal.disposition : 'waiting-for-evidence',
    createdAtMonth: atMonth,
    lastConsideredAtMonth: atMonth,
    sourceFactIds: mergeFactIds(sourceFactIds, proposal.sourceFactIds ?? []),
    ...(probe ? { probe } : {}),
    attemptIntentIds: [],
    evaluations: [],
  };
}

function initialStatusForDisposition(disposition: CharacterAgendaApproachDisposition): CharacterAgendaStatus {
  if (disposition === 'missing-affordance' || disposition === 'waiting-for-evidence') return 'incubating';
  if (disposition === 'contradicted-approach') return 'blocked';
  return 'active';
}

function evictableAgendaItem(items: CharacterAgendaItem[]): CharacterAgendaItem | undefined {
  return items
    .filter((item) => item.status === 'fulfilled' || item.status === 'abandoned' || item.status === 'suspended')
    .sort((left, right) => left.importance - right.importance
      || left.lastReviewedAtMonth - right.lastReviewedAtMonth
      || left.id.localeCompare(right.id))[0];
}

function evictableApproach(approaches: CharacterAgendaApproach[]): CharacterAgendaApproach | undefined {
  return approaches
    .filter((approach) => approach.latestOutcome === 'refuted' || approach.latestOutcome === 'parked')
    .sort((left, right) => left.lastConsideredAtMonth - right.lastConsideredAtMonth
      || left.id.localeCompare(right.id))[0];
}

function allApproachEvidence(approach: CharacterAgendaApproach): string[] {
  return mergeFactIds(
    approach.sourceFactIds,
    ...approach.evaluations.flatMap((evaluation) => [evaluation.basisFactIds, evaluation.evidenceFactIds]),
  );
}

function resultWithCurrent(
  state: CharacterAgendaState,
  outcome: CharacterAgendaUpsertOutcome,
  accepted: boolean,
  itemId?: string,
  approachIdValue?: string,
  extra: Pick<CharacterAgendaUpsertResult, 'evictedItemId' | 'evictedApproachId'> = {},
): CharacterAgendaUpsertResult {
  const item = itemId ? state.items.find((candidate) => candidate.id === itemId) : undefined;
  const approach = approachIdValue
    ? item?.approaches.find((candidate) => candidate.id === approachIdValue)
    : undefined;
  return { state, accepted, outcome, ...(item ? { item } : {}), ...(approach ? { approach } : {}), ...extra };
}

/**
 * Adds or revises a durable concern while keeping its aim separate from its
 * fallible means. The returned state is detached from the input state.
 */
export function upsertCharacterAgenda(
  input: CharacterAgendaState,
  proposal: CharacterAgendaProposal,
  atMonth: number,
  origin: CharacterAgendaOrigin,
): CharacterAgendaUpsertResult {
  const state = hydrateCharacterAgendaState(structuredClone(input), atMonth);
  const aim = boundedText(proposal?.aim, '');
  const theme = boundedText(proposal?.theme, '', 80);
  const summary = boundedText(proposal?.approach?.summary, '');
  if (!aim || !theme || !summary || !isOrigin(origin) || !isDisposition(proposal?.approach?.disposition)) {
    return resultWithCurrent(state, 'invalid-proposal', false);
  }
  const sourceFactIds = mergeFactIds(proposal.sourceFactIds ?? [], proposal.approach.sourceFactIds ?? []);
  if (sourceFactIds.length === 0) return resultWithCurrent(state, 'ungrounded-proposal', false);

  const basisKey = characterAgendaBasisKey({ basisKey: proposal.basisKey, theme, aim });
  const existing = state.items.find((item) => item.basisKey === basisKey);
  const approachBasis = characterAgendaApproachBasisKey(basisKey, proposal.approach);
  if (!existing) {
    let evictedItemId: string | undefined;
    if (state.items.length >= MAX_CHARACTER_AGENDA_ITEMS) {
      const evictable = evictableAgendaItem(state.items);
      if (!evictable) return resultWithCurrent(state, 'capacity-full', false);
      evictedItemId = evictable.id;
      state.items = state.items.filter((item) => item.id !== evictable.id);
    }
    const horizonMonths = boundedInteger(proposal.horizonMonths, 12, 1, 240);
    const approach = createApproach(basisKey, proposal.approach, sourceFactIds, atMonth);
    const item: CharacterAgendaItem = {
      id: agendaId(basisKey),
      basisKey,
      aim,
      theme,
      importance: boundedInteger(proposal.importance, 50, 0, 100),
      horizonMonths,
      targetAtMonth: atMonth + horizonMonths,
      origin,
      status: initialStatusForDisposition(approach.disposition),
      createdAtMonth: atMonth,
      lastReviewedAtMonth: atMonth,
      sourceFactIds,
      approaches: [approach],
      intentIds: [],
      projectIds: [],
      activeApproachId: approach.disposition === 'executable-now' ? approach.id : undefined,
    };
    state.items.push(item);
    return resultWithCurrent(state, 'created', true, item.id, approach.id, { evictedItemId });
  }

  const existingApproach = existing.approaches.find((approach) => approach.basisKey === approachBasis);
  const previousEvidence = existingApproach ? allApproachEvidence(existingApproach) : existing.sourceFactIds;
  const freshEvidence = sourceFactIds.filter((factId) => !previousEvidence.includes(factId));

  if (existingApproach) {
    if (freshEvidence.length === 0) {
      return resultWithCurrent(state, 'duplicate-without-new-evidence', false, existing.id, existingApproach.id);
    }
    existing.aim = aim;
    existing.theme = theme;
    existing.importance = boundedInteger(proposal.importance, existing.importance, 0, 100);
    existing.horizonMonths = boundedInteger(proposal.horizonMonths, existing.horizonMonths, 1, 240);
    existing.targetAtMonth = Math.max(existing.targetAtMonth, atMonth + existing.horizonMonths);
    existing.lastReviewedAtMonth = atMonth;
    existing.sourceFactIds = mergeFactIds(existing.sourceFactIds, sourceFactIds);
    existingApproach.lastConsideredAtMonth = atMonth;
    existingApproach.sourceFactIds = mergeFactIds(existingApproach.sourceFactIds, sourceFactIds);
    existingApproach.summary = summary;
    existingApproach.disposition = proposal.approach.disposition;
    const probe = normalizeProbe(proposal.approach.probe);
    if (probe) existingApproach.probe = probe;
    else delete existingApproach.probe;
    if (existing.status !== 'fulfilled' && existing.status !== 'abandoned') {
      existing.status = initialStatusForDisposition(existingApproach.disposition);
    }
    if (existingApproach.disposition === 'executable-now') existing.activeApproachId = existingApproach.id;
    return resultWithCurrent(state, 'updated', true, existing.id, existingApproach.id);
  }

  existing.aim = aim;
  existing.theme = theme;
  existing.importance = boundedInteger(proposal.importance, existing.importance, 0, 100);
  existing.horizonMonths = boundedInteger(proposal.horizonMonths, existing.horizonMonths, 1, 240);
  existing.targetAtMonth = Math.max(existing.targetAtMonth, atMonth + existing.horizonMonths);
  existing.lastReviewedAtMonth = atMonth;
  existing.sourceFactIds = mergeFactIds(existing.sourceFactIds, sourceFactIds);
  let evictedApproachId: string | undefined;
  if (existing.approaches.length >= MAX_CHARACTER_AGENDA_APPROACHES) {
    const evictable = evictableApproach(existing.approaches);
    if (!evictable) return resultWithCurrent(state, 'approach-capacity-full', false, existing.id);
    evictedApproachId = evictable.id;
    existing.approaches = existing.approaches.filter((approach) => approach.id !== evictable.id);
  }
  const approach = createApproach(basisKey, proposal.approach, sourceFactIds, atMonth);
  existing.approaches.push(approach);
  if (existing.status !== 'fulfilled' && existing.status !== 'abandoned') {
    existing.status = initialStatusForDisposition(approach.disposition);
  }
  if (approach.disposition === 'executable-now') existing.activeApproachId = approach.id;
  return resultWithCurrent(state, 'updated', true, existing.id, approach.id, { evictedApproachId });
}

/**
 * Applies a purely subjective lifecycle choice. This never completes an
 * intent, creates an action result, or changes the world. Application code may
 * separately suspend an executable episode that was explicitly bound to the
 * transitioned agenda.
 */
export function transitionCharacterAgenda(
  input: CharacterAgendaState,
  basisKey: string,
  transition: 'pause' | 'abandon',
  atMonth: number,
  sourceFactIds: readonly string[],
): CharacterAgendaUpsertResult {
  const state = hydrateCharacterAgendaState(structuredClone(input), atMonth);
  const normalizedBasisKey = typeof basisKey === 'string' ? basisKey.trim() : '';
  const item = state.items.find((candidate) => candidate.basisKey === normalizedBasisKey);
  if (!item) return resultWithCurrent(state, 'agenda-item-not-found', false);
  const targetStatus: CharacterAgendaStatus = transition === 'pause' ? 'suspended' : 'abandoned';
  if (item.status === targetStatus || item.status === 'fulfilled' || item.status === 'abandoned') {
    return resultWithCurrent(state, 'transition-noop', false, item.id);
  }
  item.status = targetStatus;
  item.lastReviewedAtMonth = boundedInteger(atMonth, item.lastReviewedAtMonth, -120_000, 120_000);
  item.sourceFactIds = mergeFactIds(item.sourceFactIds, sourceFactIds);
  delete item.activeIntentId;
  delete item.activeApproachId;
  return resultWithCurrent(
    state,
    transition === 'pause' ? 'paused' : 'abandoned',
    true,
    item.id,
  );
}

export function canReconsiderCharacterAgendaApproach(
  approach: CharacterAgendaApproach,
  availableFactIds: readonly string[] = [],
): boolean {
  if (approach.evaluations.length === 0) return true;
  const previouslyConsidered = mergeFactIds(
    ...approach.evaluations.flatMap((evaluation) => [evaluation.basisFactIds, evaluation.evidenceFactIds]),
  );
  return mergeFactIds(approach.sourceFactIds, availableFactIds)
    .some((factId) => !previouslyConsidered.includes(factId));
}

/** Links a durable aim to one locally validated executable episode. */
export function bindCharacterAgendaIntent(
  input: CharacterAgendaState,
  agendaItemId: string,
  approachIdValue: string,
  intentId: string,
  projectId?: string,
): CharacterAgendaBindResult {
  const state = hydrateCharacterAgendaState(structuredClone(input));
  const item = state.items.find((candidate) => candidate.id === agendaItemId);
  if (!item) return { state, accepted: false, outcome: 'agenda-item-not-found' };
  const approach = item.approaches.find((candidate) => candidate.id === approachIdValue);
  if (!approach) return { state, accepted: false, outcome: 'approach-not-found', item };
  const normalizedIntentId = typeof intentId === 'string' ? intentId.trim() : '';
  if (!normalizedIntentId) return { state, accepted: false, outcome: 'invalid-intent-id', item, approach };
  const normalizedProjectId = typeof projectId === 'string' ? projectId.trim() : '';
  if (!item.intentIds.includes(normalizedIntentId) && item.intentIds.length >= MAX_CHARACTER_AGENDA_INTENT_IDS) {
    return { state, accepted: false, outcome: 'intent-link-capacity-full', item, approach };
  }
  if (!approach.attemptIntentIds.includes(normalizedIntentId)
    && approach.attemptIntentIds.length >= MAX_CHARACTER_AGENDA_INTENT_IDS) {
    return { state, accepted: false, outcome: 'intent-link-capacity-full', item, approach };
  }
  if (normalizedProjectId
    && !item.projectIds.includes(normalizedProjectId)
    && item.projectIds.length >= MAX_CHARACTER_AGENDA_PROJECT_IDS) {
    return { state, accepted: false, outcome: 'project-link-capacity-full', item, approach };
  }
  item.intentIds = uniqueIds([...item.intentIds, normalizedIntentId], MAX_CHARACTER_AGENDA_INTENT_IDS);
  approach.attemptIntentIds = uniqueIds(
    [...approach.attemptIntentIds, normalizedIntentId],
    MAX_CHARACTER_AGENDA_INTENT_IDS,
  );
  if (normalizedProjectId) {
    item.projectIds = uniqueIds([...item.projectIds, normalizedProjectId], MAX_CHARACTER_AGENDA_PROJECT_IDS);
  }
  item.activeIntentId = normalizedIntentId;
  item.activeApproachId = approach.id;
  item.status = 'active';
  return { state, accepted: true, outcome: 'bound', item, approach };
}

function dispositionAfter(
  current: CharacterAgendaApproachDisposition,
  outcome: CharacterAgendaApproachOutcome,
): CharacterAgendaApproachDisposition {
  if (outcome === 'supported') return 'executable-now';
  if (outcome === 'refuted') return 'contradicted-approach';
  if (outcome === 'parked') {
    return current === 'consent-required' || current === 'missing-affordance'
      ? current
      : 'waiting-for-evidence';
  }
  return current === 'consent-required' || current === 'missing-affordance'
    ? current
    : 'waiting-for-evidence';
}

/** Records a real result. Time alone cannot make the same failed means retryable. */
export function reconcileCharacterAgendaApproach(
  input: CharacterAgendaState,
  agendaItemId: string,
  approachIdValue: string,
  outcome: CharacterAgendaApproachOutcome,
  evidenceFactIds: readonly string[],
  atMonth: number,
  note?: string,
): CharacterAgendaReconcileResult {
  const state = hydrateCharacterAgendaState(structuredClone(input), atMonth);
  const item = state.items.find((candidate) => candidate.id === agendaItemId);
  if (!item) return { state, accepted: false, outcome: 'agenda-item-not-found' };
  const approach = item.approaches.find((candidate) => candidate.id === approachIdValue);
  if (!approach) return { state, accepted: false, outcome: 'approach-not-found', item };
  const evidence = uniqueFactIds(evidenceFactIds);
  if (outcome !== 'parked' && evidence.length === 0) {
    return { state, accepted: false, outcome: 'missing-outcome-evidence', item, approach };
  }
  // Result facts are consequences of this evaluation, not permission to start
  // it. A later retry needs a newly grounded source fact added by deliberation.
  if (!canReconsiderCharacterAgendaApproach(approach)) {
    approach.disposition = dispositionAfter(approach.disposition, approach.latestOutcome ?? 'parked');
    delete item.activeIntentId;
    if (item.activeApproachId === approach.id) delete item.activeApproachId;
    return { state, accepted: false, outcome: 'blind-retry-suppressed', item, approach };
  }
  const basisFactIds = [...approach.sourceFactIds];
  approach.evaluations.push({
    ordinal: approach.evaluations.length + 1,
    atMonth: boundedInteger(atMonth, item.lastReviewedAtMonth, -120_000, 120_000),
    outcome,
    basisFactIds,
    evidenceFactIds: evidence,
    ...(typeof note === 'string' && note.trim() ? { note: boundedText(note, '', 180) } : {}),
  });
  approach.evaluations = approach.evaluations.slice(-MAX_CHARACTER_AGENDA_EVALUATIONS)
    .map((evaluation, index) => ({ ...evaluation, ordinal: index + 1 }));
  approach.latestOutcome = outcome;
  approach.lastConsideredAtMonth = atMonth;
  approach.disposition = dispositionAfter(approach.disposition, outcome);
  item.lastReviewedAtMonth = atMonth;
  item.sourceFactIds = mergeFactIds(item.sourceFactIds, evidence);
  delete item.activeIntentId;
  item.activeApproachId = outcome === 'supported' ? approach.id : undefined;
  if (item.status !== 'fulfilled' && item.status !== 'abandoned') {
    if (outcome === 'supported') item.status = 'active';
    else if (item.approaches.every((candidate) => candidate.latestOutcome === 'refuted')) item.status = 'blocked';
    else item.status = 'incubating';
  }
  return { state, accepted: true, outcome: 'recorded', item, approach };
}
