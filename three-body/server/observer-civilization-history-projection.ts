import type { WorldEvent } from '../src/game/eland/domain/model';
import {
  CAPABILITY_MILESTONE_DEFINITIONS,
  CAPABILITY_MILESTONE_DEFINITION_VERSION,
  type CapabilityMilestoneDefinition,
} from '../src/game/eland/projection/capability-milestones';

/**
 * Server-only bounded accumulator foundation.
 *
 * This module observes verified facts but is never installed in SimulationState
 * and is never readable by planners. It deliberately does not claim that the
 * existing full-history milestone detectors can continue from this projection:
 * detector-specific cross-event joins and non-monotonic shell gates still need
 * explicit adapters before bounded continuation may be enabled.
 */

export interface ObserverCivilizationHistoryTarget {
  stateHash: string;
  eventCount: number;
  tailEventId: string | null;
}

export interface ObserverCivilizationHistoryLimits {
  maxTaughtFactIds: number;
  maxRealizedProcessKeys: number;
  maxInteractionDyadKeys: number;
  maxInteractionKinds: number;
  maxCausalEventAnchorIds: number;
  maxTurningCategories: number;
  maxMilestoneParticipantIdsPerDefinition: number;
  maxMilestoneAffectedPersonIdsPerDefinition: number;
}

export const DEFAULT_OBSERVER_CIVILIZATION_HISTORY_LIMITS: Readonly<ObserverCivilizationHistoryLimits> = Object.freeze({
  maxTaughtFactIds: 4_096,
  maxRealizedProcessKeys: 2_048,
  maxInteractionDyadKeys: 65_536,
  maxInteractionKinds: 512,
  maxCausalEventAnchorIds: 65_536,
  maxTurningCategories: 256,
  maxMilestoneParticipantIdsPerDefinition: 4_096,
  maxMilestoneAffectedPersonIdsPerDefinition: 4_096,
});

export interface ObserverCivilizationEventHistory {
  births: number;
  deaths: number;
  agreementOutcomes: number;
  eraTransitions: number;
  taughtFactIds: readonly string[];
  realizedProcessKeys: readonly string[];
  interactionDyadKeys: readonly string[];
  interactionKinds: readonly string[];
  causalEventAnchorIds: readonly string[];
  turningCategories: readonly string[];
}

export interface ObserverCivilizationEvidenceRef {
  absoluteIndex: number;
  eventId: string;
  atMonth: number;
  who?: string;
}

export interface ObserverMilestoneEpisodeCandidate {
  definitionId: string;
  observedAtMonth: number;
  evidence: readonly ObserverCivilizationEvidenceRef[];
  participantIds?: readonly string[];
  affectedPersonIds?: readonly string[];
}

export interface ObserverMilestoneEpisodeBasis {
  observedAtMonth: number;
  evidence: readonly ObserverCivilizationEvidenceRef[];
  participantIds: readonly string[];
  affectedPersonIds: readonly string[];
}

export interface ObserverMilestoneDefinitionBasis {
  definitionId: string;
  definitionVersion: typeof CAPABILITY_MILESTONE_DEFINITION_VERSION;
  lastCandidateOrder: Readonly<{ observedAtMonth: number; evidenceOrderKey: string }> | null;
  episodes: readonly ObserverMilestoneEpisodeBasis[];
  distinctEvidenceEvents: number;
  distinctEvidenceMonths: number;
  distinctParticipants: number;
  stageCriteriaSatisfied: boolean;
}

export interface ObserverCivilizationHistoryProjection {
  schemaVersion: 1;
  target: Readonly<ObserverCivilizationHistoryTarget>;
  limits: Readonly<ObserverCivilizationHistoryLimits>;
  eventHistory: Readonly<ObserverCivilizationEventHistory>;
  milestoneDefinitionVersion: typeof CAPABILITY_MILESTONE_DEFINITION_VERSION;
  milestoneBasis: readonly ObserverMilestoneDefinitionBasis[];
  /** Definitions whose adapters processed every fact through this target. */
  completeMilestoneDefinitionIds: readonly string[];
  /** Remains false until every detector and shell gate has a bounded adapter. */
  continuationReady: false;
  continuationGaps: readonly string[];
}

interface MutableMilestoneBasis {
  definition: CapabilityMilestoneDefinition;
  lastCandidateOrder: { observedAtMonth: number; evidenceOrderKey: string } | null;
  episodes: ObserverMilestoneEpisodeBasis[];
  evidenceEventIds: Set<string>;
  signatures: Set<string>;
  participantIds: Set<string>;
  affectedPersonIds: Set<string>;
}

export interface ObserverCivilizationHistoryFold {
  status: 'open' | 'discarded' | 'finished';
  target: ObserverCivilizationHistoryTarget;
  limits: ObserverCivilizationHistoryLimits;
  appliedEventCount: number;
  appliedTailEventId: string | null;
  births: number;
  deaths: number;
  agreementOutcomes: number;
  eraTransitions: number;
  taughtFactIds: Set<string>;
  realizedProcessKeys: Set<string>;
  interactionDyadKeys: Set<string>;
  interactionKinds: Set<string>;
  causalEventAnchorIds: Set<string>;
  turningCategories: Set<string>;
  milestoneBasisByDefinitionId: Map<string, MutableMilestoneBasis>;
  completeMilestoneDefinitionIds: Set<string>;
  finishedResult?: ObserverCivilizationHistoryProjection;
}

const STATE_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_REPLAYABLE_EVIDENCE_EVENTS = 64;
const REALIZED_OPERATIONS = new Set(['combine', 'separate', 'exert', 'expose', 'hunt']);
const DIRECTED_COMMUNICATION_KINDS = new Set(['request', 'offer', 'accept', 'reject', 'revoke-agreement']);
const STRICT_DEFINITIONS = CAPABILITY_MILESTONE_DEFINITIONS.filter((definition) => definition.support === 'strict');
const STRICT_DEFINITION_BY_ID = new Map(STRICT_DEFINITIONS.map((definition) => [definition.id, definition]));
const VERIFIED_EVIDENCE_OWNER = new WeakMap<ObserverCivilizationEvidenceRef, ObserverCivilizationHistoryFold>();
export const OBSERVER_CIVILIZATION_HISTORY_CONTINUATION_GAPS = Object.freeze([
  'milestone detector adapters have not populated complete coverage',
  'non-monotonic milestone shell gates and episode retraction are not implemented',
  'current-shell milestone and completed-project causal anchors are not merged into event history yet',
  'the accumulator is not yet branded by an exact run-root stream or persisted for CAS resume',
]);

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label}必须是非负安全整数`);
}

function assertTarget(target: ObserverCivilizationHistoryTarget): void {
  if (!target || !STATE_HASH_PATTERN.test(target.stateHash)) throw new Error('observer civilization target stateHash 无效');
  assertNonNegativeSafeInteger(target.eventCount, 'observer civilization target eventCount');
  if (target.eventCount === 0 ? target.tailEventId !== null : typeof target.tailEventId !== 'string' || target.tailEventId.length === 0) {
    throw new Error('observer civilization target tailEventId 无效');
  }
}

function normalizedLimits(input: ObserverCivilizationHistoryLimits = DEFAULT_OBSERVER_CIVILIZATION_HISTORY_LIMITS): ObserverCivilizationHistoryLimits {
  const limits = { ...DEFAULT_OBSERVER_CIVILIZATION_HISTORY_LIMITS, ...input };
  for (const [key, value] of Object.entries(limits)) assertNonNegativeSafeInteger(value, `observer civilization limit ${key}`);
  return limits;
}

function pairKey(first: string, second: string): string {
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function addBounded(set: Set<string>, value: string, limit: number, label: string): void {
  if (set.has(value)) return;
  if (set.size >= limit) throw new Error(`observer civilization ${label} 超过显式上限 ${limit}`);
  set.add(value);
}

function verifiedEvidenceReference(
  fold: ObserverCivilizationHistoryFold,
  event: WorldEvent,
  absoluteIndex: number,
): ObserverCivilizationEvidenceRef {
  const reference: ObserverCivilizationEvidenceRef = Object.freeze({
    absoluteIndex,
    eventId: event.id,
    atMonth: event.atMonth,
    ...('who' in event && typeof event.who === 'string' ? { who: event.who } : {}),
  });
  VERIFIED_EVIDENCE_OWNER.set(reference, fold);
  return reference;
}

function boundedEpisodeIds(
  values: readonly string[] | undefined,
  existing: Set<string>,
  limit: number,
  label: string,
): string[] {
  const result = new Set<string>();
  let newValueCount = 0;
  for (const value of values ?? []) {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`observer milestone ${label} 包含无效 ID`);
    if (result.has(value)) continue;
    result.add(value);
    if (existing.has(value)) continue;
    if (existing.size + newValueCount >= limit) {
      throw new Error(`observer milestone ${label} 超过显式上限 ${limit}`);
    }
    newValueCount += 1;
  }
  return [...result].sort();
}

function increment(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) throw new Error(`observer civilization ${label} 溢出`);
  return value + 1;
}

function foldCivilizationEvent(fold: ObserverCivilizationHistoryFold, event: WorldEvent): void {
  if (event.kind === 'action' && event.status === 'completed') {
    if (event.action.kind === 'communicate') {
      const audience = event.action.audience.filter((personId) => personId !== event.who);
      if (event.action.content.kind === 'claim' && event.action.content.factId && event.action.audience.length > 0) {
        addBounded(fold.taughtFactIds, event.action.content.factId, fold.limits.maxTaughtFactIds, 'taught fact IDs');
      }
      if (audience.length > 0) {
        addBounded(
          fold.interactionKinds,
          `communicate:${event.action.content.kind}`,
          fold.limits.maxInteractionKinds,
          'interaction kinds',
        );
      }
      const directed = event.action.audience.length === 1 || DIRECTED_COMMUNICATION_KINDS.has(event.action.content.kind);
      if (directed) for (const personId of audience) {
        addBounded(fold.interactionDyadKeys, pairKey(event.who, personId), fold.limits.maxInteractionDyadKeys, 'interaction dyads');
      }
    } else if (event.action.kind === 'transfer') {
      const other = event.action.from.kind === 'person' && event.action.from.personId !== event.who
        ? event.action.from.personId
        : event.action.to.kind === 'person' && event.action.to.personId !== event.who
          ? event.action.to.personId
          : undefined;
      if (other) {
        addBounded(fold.interactionKinds, 'person-transfer', fold.limits.maxInteractionKinds, 'interaction kinds');
        addBounded(fold.interactionDyadKeys, pairKey(event.who, other), fold.limits.maxInteractionDyadKeys, 'interaction dyads');
      }
    } else if (event.action.kind === 'act') {
      const people = event.action.targets.flatMap((target) => target.kind === 'person' && target.personId !== event.who
        ? [target.personId] : []);
      if (people.length > 0) {
        addBounded(
          fold.interactionKinds,
          `person-act:${event.action.operation}`,
          fold.limits.maxInteractionKinds,
          'interaction kinds',
        );
      }
      for (const personId of people) {
        addBounded(fold.interactionDyadKeys, pairKey(event.who, personId), fold.limits.maxInteractionDyadKeys, 'interaction dyads');
      }
      if (REALIZED_OPERATIONS.has(event.action.operation)) {
        const output = event.diff.outputMaterialId ?? event.diff.sourceMaterialId ?? event.diff.animalSpeciesId ?? 'none';
        addBounded(
          fold.realizedProcessKeys,
          `${event.action.operation}:${String(output)}`,
          fold.limits.maxRealizedProcessKeys,
          'realized process keys',
        );
      }
    }
  }

  if (event.kind === 'environment' && typeof event.diff.bornPersonId === 'string') {
    fold.births = increment(fold.births, 'birth count');
    addBounded(fold.causalEventAnchorIds, event.id, fold.limits.maxCausalEventAnchorIds, 'causal anchors');
    addBounded(fold.turningCategories, 'birth', fold.limits.maxTurningCategories, 'turning categories');
  }
  if (event.kind === 'environment' && event.change === 'death') {
    fold.deaths = increment(fold.deaths, 'death count');
    addBounded(fold.causalEventAnchorIds, event.id, fold.limits.maxCausalEventAnchorIds, 'causal anchors');
    addBounded(fold.turningCategories, 'death', fold.limits.maxTurningCategories, 'turning categories');
  }
  if (event.kind === 'environment' && event.diff.eraTransition === true) {
    fold.eraTransitions = increment(fold.eraTransitions, 'era transition count');
    addBounded(fold.causalEventAnchorIds, event.id, fold.limits.maxCausalEventAnchorIds, 'causal anchors');
    addBounded(
      fold.turningCategories,
      `era:${String(event.diff.epoch ?? 'unknown')}`,
      fold.limits.maxTurningCategories,
      'turning categories',
    );
  }
  if (event.kind === 'agreement' && (event.change === 'fulfilled' || event.change === 'breached')) {
    fold.agreementOutcomes = increment(fold.agreementOutcomes, 'agreement outcome count');
    addBounded(fold.causalEventAnchorIds, event.id, fold.limits.maxCausalEventAnchorIds, 'causal anchors');
    addBounded(fold.turningCategories, `agreement:${event.change}`, fold.limits.maxTurningCategories, 'turning categories');
  }
}

function emptyFold(
  target: ObserverCivilizationHistoryTarget,
  limits: ObserverCivilizationHistoryLimits,
): ObserverCivilizationHistoryFold {
  return {
    status: 'open', target: { ...target }, limits,
    appliedEventCount: 0, appliedTailEventId: null,
    births: 0, deaths: 0, agreementOutcomes: 0, eraTransitions: 0,
    taughtFactIds: new Set(), realizedProcessKeys: new Set(), interactionDyadKeys: new Set(),
    interactionKinds: new Set(), causalEventAnchorIds: new Set(), turningCategories: new Set(),
    milestoneBasisByDefinitionId: new Map(), completeMilestoneDefinitionIds: new Set(),
  };
}

export function beginObserverCivilizationHistoryProjection(
  target: ObserverCivilizationHistoryTarget,
  limits: ObserverCivilizationHistoryLimits = DEFAULT_OBSERVER_CIVILIZATION_HISTORY_LIMITS,
): ObserverCivilizationHistoryFold {
  assertTarget(target);
  return emptyFold(target, normalizedLimits(limits));
}

export function resumeObserverCivilizationHistoryProjection(
  previous: ObserverCivilizationHistoryProjection,
  target: ObserverCivilizationHistoryTarget,
): ObserverCivilizationHistoryFold {
  assertTarget(target);
  if (previous.schemaVersion !== 1 || previous.milestoneDefinitionVersion !== CAPABILITY_MILESTONE_DEFINITION_VERSION) {
    throw new Error('observer civilization projection 版本不兼容');
  }
  if (target.eventCount < previous.target.eventCount
    || (target.eventCount === previous.target.eventCount && target.tailEventId !== previous.target.tailEventId)) {
    throw new Error('observer civilization resume target 早于或冲突于 previous seal');
  }
  const fold = emptyFold(target, normalizedLimits(previous.limits));
  const extendsPreviousTarget = target.eventCount > previous.target.eventCount;
  fold.appliedEventCount = previous.target.eventCount;
  fold.appliedTailEventId = previous.target.tailEventId;
  fold.births = previous.eventHistory.births;
  fold.deaths = previous.eventHistory.deaths;
  fold.agreementOutcomes = previous.eventHistory.agreementOutcomes;
  fold.eraTransitions = previous.eventHistory.eraTransitions;
  previous.eventHistory.taughtFactIds.forEach((value) => fold.taughtFactIds.add(value));
  previous.eventHistory.realizedProcessKeys.forEach((value) => fold.realizedProcessKeys.add(value));
  previous.eventHistory.interactionDyadKeys.forEach((value) => fold.interactionDyadKeys.add(value));
  previous.eventHistory.interactionKinds.forEach((value) => fold.interactionKinds.add(value));
  previous.eventHistory.causalEventAnchorIds.forEach((value) => fold.causalEventAnchorIds.add(value));
  previous.eventHistory.turningCategories.forEach((value) => fold.turningCategories.add(value));
  for (const basis of previous.milestoneBasis) {
    const definition = STRICT_DEFINITION_BY_ID.get(basis.definitionId);
    if (!definition || basis.definitionVersion !== CAPABILITY_MILESTONE_DEFINITION_VERSION) {
      throw new Error(`observer civilization milestone basis ${basis.definitionId} 无法续接`);
    }
    const episodes = basis.episodes.map((item) => ({
      observedAtMonth: item.observedAtMonth,
      evidence: item.evidence.map((reference) => ({ ...reference })),
      participantIds: [...item.participantIds],
      affectedPersonIds: [...item.affectedPersonIds],
    }));
    const participantIds = new Set<string>();
    const affectedPersonIds = new Set<string>();
    for (const episode of episodes) {
      for (const personId of episode.participantIds) {
        addBounded(
          participantIds,
          personId,
          fold.limits.maxMilestoneParticipantIdsPerDefinition,
          `milestone ${basis.definitionId} participant IDs`,
        );
      }
      for (const personId of episode.affectedPersonIds) {
        addBounded(
          affectedPersonIds,
          personId,
          fold.limits.maxMilestoneAffectedPersonIdsPerDefinition,
          `milestone ${basis.definitionId} affected person IDs`,
        );
      }
    }
    fold.milestoneBasisByDefinitionId.set(basis.definitionId, {
      definition,
      lastCandidateOrder: basis.lastCandidateOrder ? { ...basis.lastCandidateOrder } : null,
      episodes,
      evidenceEventIds: new Set(episodes.flatMap((item) => item.evidence.map((reference) => reference.eventId))),
      signatures: new Set(episodes.map((item) => item.evidence.map((reference) => reference.eventId).sort().join('|'))),
      participantIds,
      affectedPersonIds,
    });
  }
  for (const definitionId of previous.completeMilestoneDefinitionIds) {
    if (!STRICT_DEFINITION_BY_ID.has(definitionId)) {
      throw new Error(`observer civilization completed milestone definition ${definitionId} 无法续接`);
    }
    if (!extendsPreviousTarget) fold.completeMilestoneDefinitionIds.add(definitionId);
  }
  return fold;
}

export function foldVerifiedObserverCivilizationHistorySegment(
  fold: ObserverCivilizationHistoryFold,
  events: readonly WorldEvent[],
  startAbsoluteIndex: number,
  onVerifiedEvent?: (event: WorldEvent, evidence: ObserverCivilizationEvidenceRef) => void,
): ObserverCivilizationHistoryFold {
  if (fold.status !== 'open') throw new Error('observer civilization fold 不是 open 状态');
  assertNonNegativeSafeInteger(startAbsoluteIndex, 'observer civilization segment start');
  if (startAbsoluteIndex !== fold.appliedEventCount) throw new Error('observer civilization segment 重复或跳跃');
  if (startAbsoluteIndex + events.length > fold.target.eventCount) throw new Error('observer civilization segment 超过 target');
  try {
    for (let offset = 0; offset < events.length; offset += 1) {
      const event = events[offset];
      if (typeof event.id !== 'string' || event.id.length === 0) throw new Error('observer civilization event 缺少 ID');
      assertNonNegativeSafeInteger(event.atMonth, `observer civilization event ${event.id} atMonth`);
      foldCivilizationEvent(fold, event);
      fold.appliedEventCount = startAbsoluteIndex + offset + 1;
      fold.appliedTailEventId = event.id;
      onVerifiedEvent?.(event, verifiedEvidenceReference(fold, event, startAbsoluteIndex + offset));
    }
    return fold;
  } catch (error) {
    fold.status = 'discarded';
    throw error;
  }
}

function milestoneBasisFor(fold: ObserverCivilizationHistoryFold, definitionId: string): MutableMilestoneBasis {
  const definition = STRICT_DEFINITION_BY_ID.get(definitionId);
  if (!definition) throw new Error(`observer civilization milestone definition ${definitionId} 不是 strict definition`);
  let basis = fold.milestoneBasisByDefinitionId.get(definitionId);
  if (!basis) {
    basis = {
      definition,
      lastCandidateOrder: null,
      episodes: [],
      evidenceEventIds: new Set(),
      signatures: new Set(),
      participantIds: new Set(),
      affectedPersonIds: new Set(),
    };
    fold.milestoneBasisByDefinitionId.set(definitionId, basis);
  }
  return basis;
}

/**
 * Record one episode emitted by a detector adapter in the same canonical order
 * used by observeCapabilityMilestones: observed month, then evidence ID order.
 * The primitive only retains the bounded replay basis; it does not run or trust
 * a detector and therefore cannot make a milestone authoritative by itself.
 */
export function recordObserverMilestoneEpisode(
  fold: ObserverCivilizationHistoryFold,
  candidate: ObserverMilestoneEpisodeCandidate,
): boolean {
  if (fold.status !== 'open') throw new Error('observer civilization fold 不是 open 状态');
  if (fold.completeMilestoneDefinitionIds.has(candidate.definitionId)) {
    throw new Error(`observer civilization milestone ${candidate.definitionId} 已标记 complete`);
  }
  const basis = milestoneBasisFor(fold, candidate.definitionId);
  assertNonNegativeSafeInteger(candidate.observedAtMonth, 'observer milestone observedAtMonth');
  if (!candidate.evidence.length) throw new Error('observer milestone episode 缺少 evidence');
  let previousAbsoluteIndex = -1;
  const seenEventIds = new Set<string>();
  for (const reference of candidate.evidence) {
    if (VERIFIED_EVIDENCE_OWNER.get(reference) !== fold) {
      throw new Error('observer milestone evidence 不是当前 verified fold 内部绑定的引用');
    }
    assertNonNegativeSafeInteger(reference.absoluteIndex, 'observer milestone evidence absoluteIndex');
    assertNonNegativeSafeInteger(reference.atMonth, 'observer milestone evidence atMonth');
    if (reference.absoluteIndex <= previousAbsoluteIndex || reference.absoluteIndex >= fold.appliedEventCount
      || typeof reference.eventId !== 'string' || reference.eventId.length === 0 || seenEventIds.has(reference.eventId)) {
      throw new Error('observer milestone evidence 不是已折叠 ledger 中的严格有序唯一引用');
    }
    previousAbsoluteIndex = reference.absoluteIndex;
    seenEventIds.add(reference.eventId);
  }
  if (Math.max(...candidate.evidence.map((reference) => reference.atMonth)) !== candidate.observedAtMonth) {
    throw new Error('observer milestone observedAtMonth 与 evidence 尾月不一致');
  }
  const evidenceOrderKey = candidate.evidence.map((reference) => reference.eventId).join('|');
  const previousOrder = basis.lastCandidateOrder;
  if (previousOrder && (candidate.observedAtMonth < previousOrder.observedAtMonth
    || (candidate.observedAtMonth === previousOrder.observedAtMonth && evidenceOrderKey < previousOrder.evidenceOrderKey))) {
    throw new Error(`observer milestone ${candidate.definitionId} candidates 未按 canonical order 输入`);
  }
  const signature = [...seenEventIds].sort().join('|');
  if (basis.signatures.has(signature) || basis.episodes.length >= basis.definition.stageCriteria.evidenceEpisodeLimit) {
    basis.lastCandidateOrder = { observedAtMonth: candidate.observedAtMonth, evidenceOrderKey };
    return false;
  }
  const newEvidenceIds = [...seenEventIds].filter((eventId) => !basis.evidenceEventIds.has(eventId));
  if (!newEvidenceIds.length || basis.evidenceEventIds.size + newEvidenceIds.length > MAX_REPLAYABLE_EVIDENCE_EVENTS) {
    basis.lastCandidateOrder = { observedAtMonth: candidate.observedAtMonth, evidenceOrderKey };
    return false;
  }
  let participantIds: string[];
  let affectedPersonIds: string[];
  try {
    participantIds = boundedEpisodeIds(
      candidate.participantIds,
      basis.participantIds,
      fold.limits.maxMilestoneParticipantIdsPerDefinition,
      `${candidate.definitionId} participant IDs`,
    );
    affectedPersonIds = boundedEpisodeIds(
      candidate.affectedPersonIds,
      basis.affectedPersonIds,
      fold.limits.maxMilestoneAffectedPersonIdsPerDefinition,
      `${candidate.definitionId} affected person IDs`,
    );
  } catch (error) {
    fold.status = 'discarded';
    throw error;
  }
  basis.lastCandidateOrder = { observedAtMonth: candidate.observedAtMonth, evidenceOrderKey };
  basis.signatures.add(signature);
  newEvidenceIds.forEach((eventId) => basis.evidenceEventIds.add(eventId));
  participantIds.forEach((personId) => basis.participantIds.add(personId));
  affectedPersonIds.forEach((personId) => basis.affectedPersonIds.add(personId));
  basis.episodes.push({
    observedAtMonth: candidate.observedAtMonth,
    evidence: candidate.evidence.map((reference) => ({ ...reference })),
    participantIds,
    affectedPersonIds,
  });
  return true;
}

export function completeObserverMilestoneDefinition(
  fold: ObserverCivilizationHistoryFold,
  definitionId: string,
): void {
  if (fold.status !== 'open') throw new Error('observer civilization fold 不是 open 状态');
  if (fold.appliedEventCount !== fold.target.eventCount || fold.appliedTailEventId !== fold.target.tailEventId) {
    throw new Error('observer civilization milestone coverage 只能在当前 target seal 完成后标记 complete');
  }
  milestoneBasisFor(fold, definitionId);
  fold.completeMilestoneDefinitionIds.add(definitionId);
}

function frozenMilestoneBasis(basis: MutableMilestoneBasis): ObserverMilestoneDefinitionBasis {
  const evidence = basis.episodes.flatMap((item) => item.evidence);
  const evidenceEventIds = new Set(evidence.map((reference) => reference.eventId));
  const evidenceMonths = new Set(evidence.map((reference) => reference.atMonth));
  const participants = new Set(basis.episodes.flatMap((item) => item.participantIds));
  const criteria = basis.definition.stageCriteria;
  const episodes = basis.episodes.map((item) => Object.freeze({
    observedAtMonth: item.observedAtMonth,
    evidence: Object.freeze(item.evidence.map((reference) => Object.freeze({ ...reference }))),
    participantIds: Object.freeze([...item.participantIds]),
    affectedPersonIds: Object.freeze([...item.affectedPersonIds]),
  }));
  return Object.freeze({
    definitionId: basis.definition.id,
    definitionVersion: CAPABILITY_MILESTONE_DEFINITION_VERSION,
    lastCandidateOrder: basis.lastCandidateOrder ? Object.freeze({ ...basis.lastCandidateOrder }) : null,
    episodes: Object.freeze(episodes),
    distinctEvidenceEvents: evidenceEventIds.size,
    distinctEvidenceMonths: evidenceMonths.size,
    distinctParticipants: participants.size,
    stageCriteriaSatisfied: episodes.length >= criteria.minEpisodes
      && evidenceMonths.size >= criteria.minDistinctMonths
      && participants.size >= criteria.minDistinctActors
      && evidenceEventIds.size >= criteria.minEvidenceEvents,
  });
}

function sortedFrozen(values: Set<string>): readonly string[] {
  return Object.freeze([...values].sort());
}

export function finishObserverCivilizationHistoryProjection(
  fold: ObserverCivilizationHistoryFold,
): ObserverCivilizationHistoryProjection {
  if (fold.status === 'discarded') throw new Error('observer civilization fold 已作废');
  if (fold.finishedResult) return fold.finishedResult;
  if (fold.appliedEventCount !== fold.target.eventCount || fold.appliedTailEventId !== fold.target.tailEventId) {
    throw new Error('observer civilization fold 未达到 target seal');
  }
  const milestoneBasis = [...fold.milestoneBasisByDefinitionId.values()]
    .sort((left, right) => left.definition.id.localeCompare(right.definition.id))
    .map(frozenMilestoneBasis);
  const result: ObserverCivilizationHistoryProjection = Object.freeze({
    schemaVersion: 1,
    target: Object.freeze({ ...fold.target }),
    limits: Object.freeze({ ...fold.limits }),
    eventHistory: Object.freeze({
      births: fold.births,
      deaths: fold.deaths,
      agreementOutcomes: fold.agreementOutcomes,
      eraTransitions: fold.eraTransitions,
      taughtFactIds: sortedFrozen(fold.taughtFactIds),
      realizedProcessKeys: sortedFrozen(fold.realizedProcessKeys),
      interactionDyadKeys: sortedFrozen(fold.interactionDyadKeys),
      interactionKinds: sortedFrozen(fold.interactionKinds),
      causalEventAnchorIds: sortedFrozen(fold.causalEventAnchorIds),
      turningCategories: sortedFrozen(fold.turningCategories),
    }),
    milestoneDefinitionVersion: CAPABILITY_MILESTONE_DEFINITION_VERSION,
    milestoneBasis: Object.freeze(milestoneBasis),
    completeMilestoneDefinitionIds: sortedFrozen(fold.completeMilestoneDefinitionIds),
    continuationReady: false,
    continuationGaps: OBSERVER_CIVILIZATION_HISTORY_CONTINUATION_GAPS,
  });
  fold.status = 'finished';
  fold.finishedResult = result;
  return result;
}

export function projectObserverCivilizationHistoryFromFullHistory(
  events: readonly WorldEvent[],
  target: ObserverCivilizationHistoryTarget,
  limits: ObserverCivilizationHistoryLimits = DEFAULT_OBSERVER_CIVILIZATION_HISTORY_LIMITS,
): ObserverCivilizationHistoryProjection {
  const fold = beginObserverCivilizationHistoryProjection(target, limits);
  foldVerifiedObserverCivilizationHistorySegment(fold, events, 0);
  return finishObserverCivilizationHistoryProjection(fold);
}
