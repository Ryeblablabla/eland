import { createHash } from 'node:crypto';

import { REPRODUCTION_CONSENT_WINDOW_MONTHS } from '../src/game/eland/domain/population-capacity';
import {
  MAX_LIVE_INTENT_ACTION_EVENT_IDS,
  liveAgreementHistoryLeaseKey,
  parseWaterAssistanceEvidenceLeaseKey,
  parseWaterAssistanceFulfillmentMembershipGroupKey,
  waterAssistanceEvidenceLeaseKey,
} from '../src/game/eland/domain/event-index';
import {
  LIVE_PERSON_SOCIAL_EVENT_ID_LIMIT,
  parseLivePersonSocialEvidenceGroupKey,
} from '../src/game/eland/domain/live-social-evidence';
import { LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY } from '../src/game/eland/domain/project-pressure-evidence';

/** Stable wire contract shared by retention projection and persistence codecs. */

export interface HistoryRetentionSeal { eventCount: number; tailEventId: string | null }
export interface HistoryRetentionAuthority { stateHash: string }

export interface MechanicalP0HistoryCounts {
  millLaborActions: number;
  waterCurrentObservations: number;
  componentInstallations: number;
  loadedOperations: number;
  serviceOperations: number;
  faultEvents: number;
  commissioningFaults: number;
  wornDriveShaftFaults: number;
  faultDiagnoses: number;
  repairs: number;
  recoveryOperations: number;
  completedExplicitMechanicalTeachings: number;
  independentTaughtOperatorWitnesses: number;
}

export interface HistoryRetentionSummary {
  schemaVersion: 1;
  reducedThrough: HistoryRetentionSeal;
  ruleDecisions: number;
  modelDecisions: number;
  mechanicalTeachingOperationAchieved: boolean;
  mechanicalP0: MechanicalP0HistoryCounts;
}

export const HISTORY_RETENTION_REQUIREMENTS = [
  'all',
  'any',
  'audit-only',
  'index-only',
] as const;

export type HistoryRetentionRequirement = typeof HISTORY_RETENTION_REQUIREMENTS[number];

/** Audit-only facts remain readable; index-only facts retain only exact continuation identity. */
export function historyRetentionRequirementBlocks(
  requirement: HistoryRetentionRequirement,
): boolean {
  return requirement === 'all' || requirement === 'any';
}

export function historyRetentionRequirementPinsResolvedEvents(
  requirement: HistoryRetentionRequirement,
): boolean {
  return requirement !== 'index-only';
}

export interface HistoryRetentionDemandGroupResult {
  groupKey: string;
  requirement: HistoryRetentionRequirement;
  leaseKeys: string[];
  eventIds: string[];
  resolvedEventIds: string[];
  unresolvedEventIds: string[];
  satisfied: boolean;
  blocking: boolean;
}

export interface UnresolvedHistoryRetentionDemand {
  eventId: string;
  leaseKeys: string[];
  requirement: HistoryRetentionRequirement;
  groupKey: string;
  blocking: boolean;
}

export interface HistoryRetentionPin { absoluteIndex: number; eventId: string; leaseKeys: string[] }

export interface MechanicalTeachingOperationWitness {
  audienceId: string;
  teachingAbsoluteIndex: number;
  teachingEventId: string;
  operationAbsoluteIndex: number;
  operationEventId: string;
}

export interface HistoryRetentionContinuationMatch {
  absoluteIndex: number;
  eventId: string;
}

export interface HistoryRetentionContinuationDemandGroup {
  groupKey: string;
  requirement: HistoryRetentionRequirement;
  leaseKeys: string[];
  eventIds: string[];
}

export interface HistoryRetentionContinuationReproductionDemand {
  intentId: string;
  ownerId: string;
  createdAtMonth: number;
  femaleId: string | null;
  agreementId: string | null;
  acceptedAtMonth: number | null;
  dueAtMonth: number | null;
  lastAttemptAtMonth: number | null;
  attemptEventIds: string[];
}

export interface HistoryRetentionContinuationDemand {
  groups: HistoryRetentionContinuationDemandGroup[];
  millLaborPersonIds: string[];
  pendingEraPredictionIds: string[];
  livingChildIds: string[];
  reproductionFacts: HistoryRetentionContinuationReproductionDemand[];
}

export interface HistoryRetentionContinuationBasis {
  schemaVersion: 1;
  sourceAuthority: HistoryRetentionAuthority;
  sourceTarget: HistoryRetentionSeal;
  sourceDemandFingerprint: string;
  sourceDemand: HistoryRetentionContinuationDemand;
  directMatches: HistoryRetentionContinuationMatch[];
  millLaborRings: Array<{ personId: string; matches: HistoryRetentionContinuationMatch[] }>;
  pendingMechanicalTeachings: Array<{
    audienceId: string;
    absoluteIndex: number;
    eventId: string;
  }>;
  witnessedMechanicalAudienceIds: string[];
  reproductionAttempts: Array<{
    intentId: string;
    resolved: Array<{ eventId: string; atMonth: number }>;
  }>;
  selectiveMatches: Array<{ leaseKey: string; matches: HistoryRetentionContinuationMatch[] }>;
  livingChildBirthMatches: Array<{ childId: string; match: HistoryRetentionContinuationMatch }>;
  minimalMechanicalTeachingWitness: MechanicalTeachingOperationWitness | null;
  summary: HistoryRetentionSummary;
  basisHash: string;
}

export interface HistoryRetentionContinuationGap {
  code: 'dynamic-pending-era-prediction' | 'dynamic-non-birth-person' | 'mutated-reproduction-selector'
    | 'bounded-pending-era-prediction-wakes' | 'bounded-active-project-action-history'
    | 'unsealed-exact-root-lineage';
  policy: 'fail-closed';
  description: string;
}

export interface HistoryRetentionProjectionResult {
  schemaVersion: 1;
  authority: HistoryRetentionAuthority;
  target: HistoryRetentionSeal;
  demandFingerprint: string;
  millLaborPersonIds: string[];
  pins: HistoryRetentionPin[];
  demandGroups: HistoryRetentionDemandGroupResult[];
  unresolvedDemands: UnresolvedHistoryRetentionDemand[];
  minimalMechanicalTeachingWitness: MechanicalTeachingOperationWitness | null;
  summary: HistoryRetentionSummary;
  /** False until dynamic demand closure and exact-root lineage sealing are both proved. */
  continuationReady: false;
  continuationGaps: HistoryRetentionContinuationGap[];
  continuationBasis: HistoryRetentionContinuationBasis;
}

/**
 * Agreement lifecycle allows at most one sample per month and fixes the
 * accepted consent window to this many calendar months. Treat a larger shell
 * list as corrupt input instead of silently trimming authoritative membership.
 */
export const HISTORY_RETENTION_MAX_REPRODUCTION_ATTEMPT_EVENT_IDS = REPRODUCTION_CONSENT_WINDOW_MONTHS;
/** All-match wake evidence is exact up to this explicit artifact bound; never truncate it. */
export const HISTORY_RETENTION_MAX_PENDING_PREDICTION_WAKE_MATCHES = 4_096;
/** Active mechanical projects above this exact action-source bound must close or compact first. */
export const HISTORY_RETENTION_MAX_ACTIVE_PROJECT_ACTION_EVENT_IDS = 4_096;
/** A live intent may carry the full action ledger plus its mandatory decision. */
export const HISTORY_RETENTION_MAX_LIVE_INTENT_CORE_EVENT_IDS =
  MAX_LIVE_INTENT_ACTION_EVENT_IDS + 1;
/** Supporting provenance remains separately bounded and never becomes executable core. */
export const HISTORY_RETENTION_MAX_LIVE_INTENT_SUPPORTING_SOURCE_EVENT_IDS = 4_096;
export const HISTORY_RETENTION_MAX_LIVE_INTENT_ANCHOR_EVENT_IDS =
  HISTORY_RETENTION_MAX_LIVE_INTENT_CORE_EVENT_IDS
  + HISTORY_RETENTION_MAX_LIVE_INTENT_SUPPORTING_SOURCE_EVENT_IDS;
export const HISTORY_RETENTION_MAX_ELECTRICAL_NETWORKS = 4_096;
/** Corrupt shells cannot turn person/tool selectors into an unbounded sidecar. */
export const HISTORY_RETENTION_MAX_LIVE_GAMEPLAY_SELECTOR_PERSONS = 4_096;
export const HISTORY_RETENTION_MAX_CALIBRATION_INSTRUMENTS = 4_096;
export const HISTORY_RETENTION_MAX_CALIBRATION_INSTRUMENTS_PER_PERSON = 64;
export const HISTORY_RETENTION_MAX_MEASUREMENT_STACK_SOURCE_EVENT_IDS = 24;
/** Personally held social evidence remains exact but must not create an unbounded sidecar. */
export const HISTORY_RETENTION_MAX_LIVE_PERSON_SOCIAL_EVENT_IDS =
  LIVE_PERSON_SOCIAL_EVENT_ID_LIMIT;
/** Active water help retains full index identity, but only two typed bodies. */
export const HISTORY_RETENTION_MAX_ACTIVE_WATER_ASSISTANCE_AGREEMENTS = 4_096;
export const HISTORY_RETENTION_MAX_WATER_ASSISTANCE_FULFILLMENT_EVENT_IDS = 4_096;
/** A response copies the opening and every nested source into a strict intent. */
export const HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_SOURCE_GROUPS = 4_096;
export const HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_SOURCE_EVENT_IDS =
  MAX_LIVE_INTENT_ACTION_EVENT_IDS;
export const HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_UNIQUE_EVENT_IDS = 16_384;
/**
 * A terminal failure remains a retry input for the inclusive 0..6 month
 * window. Keep only the exact ActionFact IDs jointly named by the intent's
 * executed-action ledger and its terminal goal outcome. This is storage-only:
 * planners still have to resolve and validate the ActionFact themselves.
 */
export const HISTORY_RETENTION_RECENT_TERMINAL_FAILURE_WINDOW_MONTHS = 6;
export const HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_PER_PERSON = 256;
export const HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_TOTAL = 16_384;
/**
 * Person-local social posteriors and coordination-practice bases are bounded
 * domain state. Preserve the exact facts they still cite, without turning
 * dead people or discarded beliefs into permanent history roots.
 */
export const HISTORY_RETENTION_MAX_SOCIAL_LEARNING_EVENT_IDS_PER_PERSON = 8_448;
export const HISTORY_RETENTION_MAX_SOCIAL_LEARNING_EVENT_IDS_TOTAL = 32_768;
/**
 * The broad living-person union is continuation identity only. A future
 * pressure basis may promote one of these IDs to an exact active-project
 * anchor. Ordinary pressure reads only a process-local body-free descriptor.
 */
export const HISTORY_RETENTION_MAX_LIVE_PROJECT_PRESSURE_SOURCE_EVENT_IDS = 16_384;
export { LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY };
/**
 * A currently placed container may become visible after an ordinary move in
 * the next month. Family-readiness then carries the container and edible-stack
 * provenance into a new social intent/agreement, so keep that finite source
 * pool before it is promoted to a strict live-agreement anchor.
 */
export const HISTORY_RETENTION_MAX_FUTURE_FAMILY_STORED_FOOD_SOURCE_EVENT_IDS = 16_384;
export const FUTURE_FAMILY_STORED_FOOD_SOURCE_LEASE_KEY =
  'gameplay:future-family-readiness:stored-food-sources' as const;
/**
 * A living proposer may remember an old offer and use its resolved agreement
 * outcome when deciding whether to speak again. Preserve that finite outcome
 * provenance before a later social intent promotes it to a strict anchor.
 */
export const HISTORY_RETENTION_MAX_FUTURE_SOCIAL_REPETITION_SOURCE_EVENT_IDS = 16_384;
export const FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY =
  'gameplay:future-social-repetition:agreement-outcome-sources' as const;
/**
 * Bounded person-local beliefs and learned personality changes are valid
 * appraisal inputs. A newly selected option may copy their provenance into a
 * strict intent on the next boundary. Preserve exact event identity one month
 * early, but do not keep every old event body resident before gameplay needs it.
 */
export const HISTORY_RETENTION_MAX_FUTURE_COGNITIVE_APPRAISAL_SOURCE_EVENT_IDS = 32_768;
export const FUTURE_COGNITIVE_APPRAISAL_SOURCE_LEASE_KEY =
  'gameplay:future-cognitive-appraisal:living-source-facts' as const;
/**
 * The currently selected logistics episode can copy its frozen provenance
 * directly into the next project intent. Keep only exact ID/ordinal identity
 * until an intent actually promotes one of those facts to a strict basis.
 */
export const HISTORY_RETENTION_MAX_FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_EVENT_IDS = 32_768;
export const FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_LEASE_KEY =
  'gameplay:future-active-project-logistics:source-facts' as const;
/**
 * Current drops, stored stacks and physical structures are the material
 * affordance substrate for next-month hypotheses and projects. Preserve their
 * finite provenance before a newly opened project makes it a strict basis.
 */
export const HISTORY_RETENTION_MAX_FUTURE_MATERIAL_AFFORDANCE_SOURCE_EVENT_IDS = 65_536;
export const FUTURE_MATERIAL_AFFORDANCE_SOURCE_LEASE_KEY =
  'gameplay:future-material-affordance:current-entity-sources' as const;
/** Mirrors the maintenance reader's exact `project.actionEventIds.slice(-16)` window. */
export const HISTORY_RETENTION_MAX_ELECTRICAL_MAINTENANCE_PROJECT_EVENT_IDS = 16;
/** Completed projects kept for living gameplay must remain a finite shell selector set. */
export const HISTORY_RETENTION_MAX_COMPLETED_LIVE_PROJECTS = 4_096;
/** Only pairs with an evidence-bearing shared project count toward this exact selector bound. */
export const HISTORY_RETENTION_MAX_LIVING_SHARED_PROJECT_PAIRS = 4_096;
/** Exact completion/action membership is never truncated to fabricate a last-four result. */
export const HISTORY_RETENTION_MAX_COMPLETED_PROJECT_SOURCE_EVENT_IDS = 4_096;

export const RECENT_PRODUCTION_WINDOW_LEASE = 'retention:recent-personal-production:window';
const RECENT_PRODUCTION_WINDOW_GROUP_PREFIX = 'recent-personal-production-window:';
export const CALIBRATION_SOURCE_GROUP_SUFFIX = ':instrument-sources';
export const LIVE_SUPPORTING_SOURCE_GROUP_SUFFIX = ':supporting-sources';
const GROUNDED_RESPONSE_SOURCE_GROUP_PREFIX =
  'gameplay:grounded-conversation-response:';
const RECENT_TERMINAL_FAILURE_ACTION_GROUP_PREFIX =
  'gameplay:recent-terminal-intent-failure:';
const SOCIAL_LEARNING_SOURCE_GROUP_PREFIX = 'gameplay:person-social-learning:';

export function groundedConversationResponseSourceLeaseKey(
  responderId: string,
  openingEventId: string,
): string {
  return `${GROUNDED_RESPONSE_SOURCE_GROUP_PREFIX}${encodeURIComponent(responderId)}`
    + `:${encodeURIComponent(openingEventId)}:sources`;
}

export function parseGroundedConversationResponseSourceLeaseKey(
  value: string,
): { responderId: string; openingEventId: string } | null {
  if (!value.startsWith(GROUNDED_RESPONSE_SOURCE_GROUP_PREFIX) || !value.endsWith(':sources')) {
    return null;
  }
  const body = value.slice(GROUNDED_RESPONSE_SOURCE_GROUP_PREFIX.length, -':sources'.length);
  const parts = body.split(':');
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) return null;
  try {
    const responderId = decodeURIComponent(parts[0]!);
    const openingEventId = decodeURIComponent(parts[1]!);
    if (!responderId || !openingEventId
      || groundedConversationResponseSourceLeaseKey(responderId, openingEventId) !== value) return null;
    return { responderId, openingEventId };
  } catch {
    return null;
  }
}

export function recentTerminalFailureActionLeaseKey(ownerId: string): string {
  return `${RECENT_TERMINAL_FAILURE_ACTION_GROUP_PREFIX}${encodeURIComponent(ownerId)}:actions`;
}

export function parseRecentTerminalFailureActionLeaseKey(
  value: string,
): { ownerId: string } | null {
  if (!value.startsWith(RECENT_TERMINAL_FAILURE_ACTION_GROUP_PREFIX)
    || !value.endsWith(':actions')) return null;
  const encodedOwnerId = value.slice(
    RECENT_TERMINAL_FAILURE_ACTION_GROUP_PREFIX.length,
    -':actions'.length,
  );
  if (!encodedOwnerId) return null;
  try {
    const ownerId = decodeURIComponent(encodedOwnerId);
    if (!ownerId || recentTerminalFailureActionLeaseKey(ownerId) !== value) return null;
    return { ownerId };
  } catch {
    return null;
  }
}

export function socialLearningSourceLeaseKey(observerId: string): string {
  return `${SOCIAL_LEARNING_SOURCE_GROUP_PREFIX}${encodeURIComponent(observerId)}:sources`;
}

export function parseSocialLearningSourceLeaseKey(
  value: string,
): { observerId: string } | null {
  if (!value.startsWith(SOCIAL_LEARNING_SOURCE_GROUP_PREFIX)
    || !value.endsWith(':sources')) return null;
  const encodedObserverId = value.slice(
    SOCIAL_LEARNING_SOURCE_GROUP_PREFIX.length,
    -':sources'.length,
  );
  if (!encodedObserverId) return null;
  try {
    const observerId = decodeURIComponent(encodedObserverId);
    if (!observerId || socialLearningSourceLeaseKey(observerId) !== value) return null;
    return { observerId };
  } catch {
    return null;
  }
}

export type HistoryRetentionDemandGroupShape = Pick<
  HistoryRetentionContinuationDemandGroup,
  'groupKey' | 'requirement' | 'leaseKeys' | 'eventIds'
>;

export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

export function waterAssistanceSelectiveLeaseKeysFromDemandGroups(
  groups: readonly HistoryRetentionDemandGroupShape[],
): Set<string> {
  const leaseKeys = new Set<string>();
  let groupCount = 0;
  for (const group of groups) {
    const parsed = parseWaterAssistanceFulfillmentMembershipGroupKey(group.groupKey);
    const typedLeaseKeys = group.leaseKeys.filter((leaseKey) => (
      parseWaterAssistanceEvidenceLeaseKey(leaseKey) !== null
    ));
    if (!parsed) {
      if (typedLeaseKeys.length > 0) {
        throw new Error(`retention water assistance typed lease ${group.groupKey} 缺少 membership group`);
      }
      continue;
    }
    groupCount += 1;
    if (groupCount > HISTORY_RETENTION_MAX_ACTIVE_WATER_ASSISTANCE_AGREEMENTS) {
      throw new Error('retention water assistance membership groups 超出有界上限');
    }
    const expected = [
      waterAssistanceEvidenceLeaseKey(
        parsed.agreementId,
        parsed.requesterId,
        parsed.helperId,
        'helper',
      ),
      waterAssistanceEvidenceLeaseKey(
        parsed.agreementId,
        parsed.requesterId,
        parsed.helperId,
        'requester',
      ),
    ].sort();
    if (group.requirement !== 'index-only'
      || !sameStringSet(group.leaseKeys, expected)
      || typedLeaseKeys.length !== expected.length
      || new Set(group.eventIds).size !== group.eventIds.length
      || group.eventIds.length > HISTORY_RETENTION_MAX_WATER_ASSISTANCE_FULFILLMENT_EVENT_IDS) {
      throw new Error(`retention water assistance membership ${group.groupKey} 无效或超界`);
    }
    for (const leaseKey of expected) leaseKeys.add(leaseKey);
  }
  return leaseKeys;
}

/** Accept one exact broad identity group: legacy body-pinning or current index-only. */
export function assertProjectPressureHistoryRetentionDemandGroups(
  groups: readonly HistoryRetentionDemandGroupShape[],
  context: string,
  options: { allowLegacyMissing?: boolean } = {},
): void {
  const relevant = groups.filter((group) => (
    group.groupKey.startsWith('gameplay:live-person-project-pressure:')
  ));
  if (relevant.length === 0 && options.allowLegacyMissing) return;
  const globalGroup = relevant[0];
  if (relevant.length !== 1
    || globalGroup.groupKey !== LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY
    || ((globalGroup.requirement !== 'audit-only'
      && globalGroup.requirement !== 'index-only')
    || globalGroup.leaseKeys.length !== 1
    || globalGroup.leaseKeys[0] !== LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY
    || new Set(globalGroup.eventIds).size !== globalGroup.eventIds.length
    || globalGroup.eventIds.length > HISTORY_RETENTION_MAX_LIVE_PROJECT_PRESSURE_SOURCE_EVENT_IDS)) {
    throw new Error(`${context} living project-pressure global group 无效或超界`);
  }
}

export function recentPersonalProductionWindowGroupKey(atMonth: number): string {
  return `${RECENT_PRODUCTION_WINDOW_GROUP_PREFIX}${atMonth}`;
}

export function productionWindowMonthFromDemandGroups(
  groups: readonly HistoryRetentionContinuationDemandGroup[],
): number | null {
  const candidates = groups.filter((group) => group.leaseKeys.length === 1
    && group.leaseKeys[0] === RECENT_PRODUCTION_WINDOW_LEASE
    && group.groupKey.startsWith(RECENT_PRODUCTION_WINDOW_GROUP_PREFIX));
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) throw new Error('retention production window demand 重复');
  const raw = candidates[0].groupKey.slice(RECENT_PRODUCTION_WINDOW_GROUP_PREFIX.length);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error('retention production window demand month 无效');
  }
  return Number(raw);
}

export function calibrationLeaseKeysFromDemandGroups(
  groups: readonly HistoryRetentionContinuationDemandGroup[],
): string[] {
  return groups.flatMap((group) => {
    if (!group.groupKey.endsWith(CALIBRATION_SOURCE_GROUP_SUFFIX)
      || group.requirement !== 'all'
      || group.leaseKeys.length !== 1
      || `${group.leaseKeys[0]}${CALIBRATION_SOURCE_GROUP_SUFFIX}` !== group.groupKey) return [];
    return [group.leaseKeys[0]];
  }).sort();
}

export function historyRetentionDemandFingerprint(demand: HistoryRetentionContinuationDemand): string {
  const fingerprintGroups = compatibilityCanonicalDemandGroups(demand.groups);
  return createHash('sha256')
    .update('eland-history-retention-demand-v1\0')
    .update(JSON.stringify({
      groups: fingerprintGroups,
      millLaborPersonIds: demand.millLaborPersonIds,
      pendingEraPredictionIds: demand.pendingEraPredictionIds,
      livingChildIds: demand.livingChildIds,
      reproductionAttemptSelection: {
        version: 'agreement-consent-window-v1',
        maximumEventIds: HISTORY_RETENTION_MAX_REPRODUCTION_ATTEMPT_EVENT_IDS,
      },
      reproductionFacts: demand.reproductionFacts,
    }))
    .digest('hex');
}

/**
 * Storage-only refinements keep the legacy domain-demand fingerprint. This
 * lets an exact old checkpoint open once, then publish the safer split/indexed
 * representation without weakening either representation's own codec checks.
 */
export function compatibilityCanonicalDemandGroups(
  groups: readonly HistoryRetentionDemandGroupShape[],
): HistoryRetentionContinuationDemandGroup[] {
  const canonical = new Map<string, HistoryRetentionContinuationDemandGroup>();
  for (const group of groups) {
    const liveSocial = parseLivePersonSocialEvidenceGroupKey(group.groupKey);
    if (liveSupportingSourceCoreGroupKey(group.groupKey) !== null
      || parseWaterAssistanceFulfillmentMembershipGroupKey(group.groupKey) !== null
      || group.groupKey === FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_LEASE_KEY
      || parseGroundedConversationResponseSourceLeaseKey(group.groupKey)
      || parseRecentTerminalFailureActionLeaseKey(group.groupKey)
      || parseSocialLearningSourceLeaseKey(group.groupKey)
      || (liveSocial?.kind !== undefined && liveSocial.kind !== 'broad')) continue;
    if (group.groupKey === LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY
      && group.eventIds.length === 0) continue;
    canonical.set(group.groupKey, {
      groupKey: group.groupKey,
      requirement: (group.groupKey === FUTURE_COGNITIVE_APPRAISAL_SOURCE_LEASE_KEY
          || group.groupKey === LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY
          || group.groupKey === FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY)
        && group.requirement === 'index-only'
        ? 'audit-only'
        : liveSocial?.kind === 'broad' && group.requirement === 'index-only'
          ? 'all'
          : group.requirement,
      leaseKeys: [...new Set(group.leaseKeys)].sort(),
      eventIds: [...new Set(group.eventIds)].sort(),
    });
  }
  for (const group of groups) {
    const coreKey = liveSupportingSourceCoreGroupKey(group.groupKey);
    if (!coreKey) continue;
    const core = canonical.get(coreKey);
    if (!core || core.requirement !== 'all') {
      canonical.set(group.groupKey, {
        groupKey: group.groupKey,
        requirement: group.requirement,
        leaseKeys: [...new Set(group.leaseKeys)].sort(),
        eventIds: [...new Set(group.eventIds)].sort(),
      });
      continue;
    }
    canonical.set(coreKey, {
      ...core,
      leaseKeys: [...new Set([...core.leaseKeys, ...group.leaseKeys])].sort(),
      eventIds: [...new Set([...core.eventIds, ...group.eventIds])].sort(),
    });
  }
  for (const group of groups) {
    const water = parseWaterAssistanceFulfillmentMembershipGroupKey(group.groupKey);
    if (!water) continue;
    const coreKey = liveAgreementHistoryLeaseKey(water.agreementId);
    const core = canonical.get(coreKey);
    if (!core || core.requirement !== 'all') {
      canonical.set(group.groupKey, {
        groupKey: group.groupKey,
        requirement: group.requirement,
        leaseKeys: [...new Set(group.leaseKeys)].sort(),
        eventIds: [...new Set(group.eventIds)].sort(),
      });
      continue;
    }
    canonical.set(coreKey, {
      ...core,
      eventIds: [...new Set([...core.eventIds, ...group.eventIds])].sort(),
    });
  }
  return [...canonical.values()].sort((left, right) => left.groupKey.localeCompare(right.groupKey));
}

export function liveSupportingSourceCoreGroupKey(groupKey: string): string | null {
  if ((!groupKey.startsWith('live-agreement:') && !groupKey.startsWith('live-intent:'))
    || !groupKey.endsWith(LIVE_SUPPORTING_SOURCE_GROUP_SUFFIX)) return null;
  const coreKey = groupKey.slice(0, -LIVE_SUPPORTING_SOURCE_GROUP_SUFFIX.length);
  return coreKey.endsWith(':anchors') ? coreKey : null;
}

export function assertLiveIntentHistoryRetentionDemandGroups(
  groups: readonly HistoryRetentionDemandGroupShape[],
  context: string,
): void {
  const groupsByKey = new Map(groups.map((group) => [group.groupKey, group]));
  for (const group of groups) {
    const isCore = group.groupKey.startsWith('live-intent:')
      && group.groupKey.endsWith(':anchors');
    const supportingCoreKey = group.groupKey.startsWith('live-intent:')
      ? liveSupportingSourceCoreGroupKey(group.groupKey)
      : null;
    if (!isCore && !supportingCoreKey) continue;
    if (supportingCoreKey) {
      if (!groupsByKey.has(supportingCoreKey)) {
        throw new Error(`${context} ${group.groupKey} 缺少 live intent core group`);
      }
      continue;
    }
    if (group.requirement !== 'all'
      || group.leaseKeys.length !== 1
      || group.leaseKeys[0] !== group.groupKey
      || group.eventIds.length > HISTORY_RETENTION_MAX_LIVE_INTENT_CORE_EVENT_IDS) {
      throw new Error(`${context} ${group.groupKey} 的 live intent core 无效或超界`);
    }
    const supporting = groupsByKey.get(`${group.groupKey}${LIVE_SUPPORTING_SOURCE_GROUP_SUFFIX}`);
    if (!supporting) continue;
    const coreEventIds = new Set(group.eventIds);
    const combinedEventIds = new Set([...group.eventIds, ...supporting.eventIds]);
    if (supporting.requirement !== 'audit-only'
      || supporting.leaseKeys.length !== 1
      || supporting.leaseKeys[0] !== group.groupKey
      || supporting.eventIds.some((eventId) => coreEventIds.has(eventId))
      || supporting.eventIds.length
        > HISTORY_RETENTION_MAX_LIVE_INTENT_SUPPORTING_SOURCE_EVENT_IDS
      || combinedEventIds.size > HISTORY_RETENTION_MAX_LIVE_INTENT_ANCHOR_EVENT_IDS) {
      throw new Error(`${context} ${supporting.groupKey} 的 live intent supporting sources 无效或超界`);
    }
  }
}

export function assertLiveIntentRawSplitMatchesCanonicalDemand(
  projectedGroups: readonly HistoryRetentionDemandGroupShape[],
  canonicalGroups: readonly HistoryRetentionDemandGroupShape[],
): void {
  const canonicalByKey = new Map(canonicalGroups.map((group) => [group.groupKey, group]));
  const projectedByKey = new Map(projectedGroups.map((group) => [group.groupKey, group]));
  for (const projectedSupport of projectedGroups) {
    const coreKey = projectedSupport.groupKey.startsWith('live-intent:')
      ? liveSupportingSourceCoreGroupKey(projectedSupport.groupKey)
      : null;
    if (!coreKey) continue;
    const projectedCore = projectedByKey.get(coreKey);
    const canonicalCore = canonicalByKey.get(coreKey);
    const canonicalSupport = canonicalByKey.get(projectedSupport.groupKey);
    if (!projectedCore || !canonicalCore || !canonicalSupport
      || projectedCore.requirement !== canonicalCore.requirement
      || projectedSupport.requirement !== canonicalSupport.requirement
      || !sameStringSet(projectedCore.leaseKeys, canonicalCore.leaseKeys)
      || !sameStringSet(projectedSupport.leaseKeys, canonicalSupport.leaseKeys)
      || !sameStringSet(projectedCore.eventIds, canonicalCore.eventIds)
      || !sameStringSet(projectedSupport.eventIds, canonicalSupport.eventIds)) {
      throw new Error(`retention projection live intent ${coreKey} 的 core/support 分区不一致`);
    }
  }
}
