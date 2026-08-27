import { createHash } from 'node:crypto';
import type { ActionFact, SimulationState, WorldEvent } from '../src/game/eland/domain/model';
import { Material, materialHas } from '../src/game/eland/domain/material';
import {
  inventoryCombinationForOutput,
  inventoryCombinationTechniqueId,
} from '../src/game/eland/domain/interaction-rules';
import {
  canonicalMeasurementSourceEventIds,
  type MeasurementStackReceipt,
} from '../src/game/eland/domain/measurement';
import {
  isValidPersonalMassCalibrationFactForInstrument,
  personalMassCalibrationLeaseKey,
} from '../src/game/eland/domain/actions/measurement-actions';
import {
  isCompletedPersonalProductionLaborEvent,
  parseRecentPersonalProductionLaborSelectorLeaseKey,
  RECENT_PERSONAL_PRODUCTION_MONTHS,
  recentPersonalProductionLaborLeaseKey,
  recentPersonalProductionLaborSelectorLeaseKey,
} from '../src/game/eland/domain/production-tool';
import {
  MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
  validatedMechanicalPowerReliabilityCycleReceipts,
  type MechanicalPowerReliabilityCycleReceipt,
} from '../src/game/eland/domain/mechanical-power';
import {
  ELECTRICAL_POWER_LOAD_TECHNIQUE_PREFIX,
  ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID,
  ELECTRICAL_POWER_RECENT_EVENT_LIMIT,
  ELECTRICAL_POWER_SOURCE_EVENT_LIMIT,
  activeElectricalMaintenanceProjectLeaseKey,
  activeElectricalMaintenanceReplacementLeaseKey,
  currentElectricalNetworkFaultLeaseKey,
  currentElectricalNetworkRepairLeaseKey,
  electricalPowerFaultObservationFactId,
  livingPersonElectricalComponentTechniqueLeaseKey,
  livingPersonElectricalFaultObservationLeaseKey,
  livingPersonElectricalLoadTechniqueKnowledgeLeaseKey,
  livingPersonElectricalMechanicalServiceLeaseKey,
  livingPersonElectricalOperationKnowledgeLeaseKey,
  sameElectricalPosition,
} from '../src/game/eland/domain/electrical-power';
import { REPRODUCTION_CONSENT_WINDOW_MONTHS } from '../src/game/eland/domain/population-capacity';
import {
  MAX_COORDINATION_PRACTICES,
  MAX_PRACTICE_EPISODES,
  MAX_SOCIAL_BELIEF_RECEIPTS,
  MAX_SOCIAL_BELIEF_SOURCES,
  MAX_SOCIAL_COOPERATION_BELIEFS,
} from '../src/game/eland/domain/social-learning';
import {
  GROUNDED_CONVERSATION_RESPONSE_WINDOW_MONTHS,
  MAX_LIVE_INTENT_ACTION_EVENT_IDS,
  groundedConversationOpeningsForListener,
  groundedConversationWindowLeaseKey,
  hasRecentGroundedConversationResponseForListener,
  liveAgreementHistoryLeaseKey,
  liveIntentHistoryLeaseKey,
  liveSocialEvidenceForPersonSources,
  parseGroundedConversationWindowLeaseKey,
  parseWaterAssistanceEvidenceLeaseKey,
  parseWaterAssistanceFulfillmentMembershipGroupKey,
  waterAssistanceEvidenceLeaseKey,
  waterAssistanceFulfillmentMembershipGroupKey,
  worldEventByIdWithRetainedLease,
} from '../src/game/eland/domain/event-index';
import {
  isHelperWaterAssistanceEvidence,
  isRequesterWaterAssistanceEvidence,
  type AssistanceProposal,
} from '../src/game/eland/domain/agreement';
import {
  LIVE_PERSON_SOCIAL_EVENT_ID_LIMIT,
  livePersonSocialEvidenceGroupKey,
  livePersonSocialEvidenceLeaseKey,
  livePersonSocialSourceEventIds,
  livePersonSocialStrictEvidenceGroupKey,
  livePersonSocialStrictEvidenceLeaseKey,
  parseLivePersonSocialEvidenceGroupKey,
  measurementUncertaintyRawSourceEventIds,
  selectLivePersonSocialStrictEvidenceEventIds,
} from '../src/game/eland/domain/live-social-evidence';
import {
  LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY,
  rememberedProjectPressureSourceEventIds,
} from '../src/game/eland/domain/project-pressure-evidence';
import { latestSharedProjectBetween } from '../src/game/eland/domain/project-participant-index';
import {
  MODERN_ELECTRICAL_USEFUL_LOAD_LEASE_KEY,
  MODERN_RECORD_EXPERIMENT_LEASE_KEY,
  firstIndependentRecordReuseFact,
  isIndependentRecordReuseFact,
  isModernElectricalUsefulLoadFact,
  modernElectricalOperationLeaseKey,
  modernElectricalUsefulLoadLeaseKey,
  modernCompletedMeasurementReceiptLeaseKey,
  parseModernElectricalUsefulLoadLeaseKey,
} from '../src/game/eland/domain/era-progression';

/** Server-only shadow projection. Nothing here is readable by domain planning. */

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

interface DirectPinMatch { absoluteIndex: number; eventId: string }
interface DirectDemandGroup {
  groupKey: string;
  requirement: HistoryRetentionRequirement;
  leaseKeys: Set<string>;
  eventIds: Set<string>;
}
interface PendingMechanicalTeaching { absoluteIndex: number; eventId: string }
interface CalibrationSelector {
  leaseKey: string;
  personId: string;
  instrument: MeasurementStackReceipt;
}
interface WaterAssistanceSelector {
  agreementId: string;
  proposal: AssistanceProposal;
  helperLeaseKey: string;
  requesterLeaseKey: string;
  membershipGroupKey: string;
  fulfillmentEventIds: Set<string>;
}
interface ReproductionFactDemand {
  intentId: string;
  ownerId: string;
  createdAtMonth: number;
  femaleId: string | null;
  agreementId: string | null;
  acceptedAtMonth: number | null;
  dueAtMonth: number | null;
  lastAttemptAtMonth: number | null;
  attemptEventIds: Set<string>;
  resolvedAttemptEventIds: Set<string>;
  attemptMonths: Set<number>;
  resolvedAttemptMonthsByEventId: Map<string, number>;
}

declare const historyRetentionDemandSnapshotBrand: unique symbol;

/**
 * Process-local receipt for one exact, store-owned shell demand. The receipt
 * exposes no selector contents: its full mutable collector result stays behind
 * a WeakMap, while a canonical immutable demand/fingerprint is retained for
 * post-stream verification without rescanning the gameplay shell.
 */
export interface HistoryRetentionDemandSnapshot {
  readonly kind: 'history-retention-demand-snapshot-v1';
  readonly [historyRetentionDemandSnapshotBrand]: true;
}

interface HistoryRetentionDemandSnapshotRecord {
  readonly finalShell: SimulationState;
  readonly target: Readonly<HistoryRetentionSeal>;
  readonly demand: ReturnType<typeof collectDemand>;
  readonly continuationDemand: Readonly<HistoryRetentionContinuationDemand>;
  readonly fingerprint: string;
  consumed: boolean;
}

const historyRetentionDemandSnapshots = new WeakMap<object, HistoryRetentionDemandSnapshotRecord>();
let historyRetentionDemandCollectionCount = 0;

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
 * until an intent actually promotes one of those facts to a strict anchor.
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

const RECENT_PRODUCTION_WINDOW_LEASE = 'retention:recent-personal-production:window';
const RECENT_PRODUCTION_WINDOW_GROUP_PREFIX = 'recent-personal-production-window:';
const CALIBRATION_SOURCE_GROUP_SUFFIX = ':instrument-sources';
const LIVE_SUPPORTING_SOURCE_GROUP_SUFFIX = ':supporting-sources';
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

type ProjectPressureDemandGroupShape = Pick<
  HistoryRetentionContinuationDemandGroup,
  'groupKey' | 'requirement' | 'leaseKeys' | 'eventIds'
>;

export function waterAssistanceSelectiveLeaseKeysFromDemandGroups(
  groups: readonly ProjectPressureDemandGroupShape[],
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

function waterAssistanceMembershipGroupKeyForLease(leaseKey: string): string | null {
  const parsed = parseWaterAssistanceEvidenceLeaseKey(leaseKey);
  return parsed ? waterAssistanceFulfillmentMembershipGroupKey(
    parsed.agreementId,
    parsed.requesterId,
    parsed.helperId,
  ) : null;
}

/** Accept one exact broad identity group: legacy body-pinning or current index-only. */
export function assertProjectPressureHistoryRetentionDemandGroups(
  groups: readonly ProjectPressureDemandGroupShape[],
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

function projectPressureDemandGroup(
  groups: readonly ProjectPressureDemandGroupShape[],
): ProjectPressureDemandGroupShape | undefined {
  return groups.find((group) => (
    group.groupKey === LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY
  ));
}

/** The only admitted raw migration is exact legacy audit bodies to the same index identity. */
function assertProjectPressureStorageRefinementMatches(
  projected: readonly ProjectPressureDemandGroupShape[],
  demanded: readonly ProjectPressureDemandGroupShape[],
): void {
  const previous = projectPressureDemandGroup(projected);
  const current = projectPressureDemandGroup(demanded);
  if (!current) {
    throw new Error('retention shell 缺少当前 project-pressure broad identity');
  }
  if (!previous) {
    if (current.requirement === 'index-only' && current.eventIds.length === 0) return;
    throw new Error('retention legacy project-pressure 缺组只允许迁移到 empty index identity');
  }
  const requirementCompatible = previous.requirement === current.requirement
    || (previous.requirement === 'audit-only' && current.requirement === 'index-only');
  if (!requirementCompatible
    || previous.groupKey !== current.groupKey
    || !sameStringSet(previous.leaseKeys, current.leaseKeys)
    || !sameStringSet(previous.eventIds, current.eventIds)) {
    throw new Error('retention project-pressure storage refinement 与 bounded shell 不一致');
  }
}

/** The only admitted social-repetition migration is exact legacy bodies to the same identity index. */
function assertFutureSocialRepetitionStorageRefinementMatches(
  projected: readonly ProjectPressureDemandGroupShape[],
  demanded: readonly ProjectPressureDemandGroupShape[],
): void {
  const previousGroups = projected.filter((group) => (
    group.groupKey === FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY
  ));
  const currentGroups = demanded.filter((group) => (
    group.groupKey === FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY
  ));
  if (previousGroups.length === 0 && currentGroups.length === 0) return;
  const previous = previousGroups[0];
  const current = currentGroups[0];
  if (previousGroups.length !== 1
    || currentGroups.length !== 1
    || !previous
    || !current
    || current.requirement !== 'index-only'
    || (previous.requirement !== 'audit-only' && previous.requirement !== 'index-only')
    || previous.groupKey !== current.groupKey
    || !sameStringSet(previous.leaseKeys, current.leaseKeys)
    || !sameStringSet(previous.eventIds, current.eventIds)) {
    throw new Error('retention future social-repetition storage refinement 与 bounded shell 不一致');
  }
}

/**
 * Legacy live-agreement support groups pinned every fulfillment body. Admit a
 * one-way split only when the exact same IDs move into the typed index group;
 * the verified bodies are reclassified during cold installation.
 */
function assertWaterAssistanceStorageRefinementMatches(
  projected: readonly ProjectPressureDemandGroupShape[],
  demanded: readonly ProjectPressureDemandGroupShape[],
): void {
  waterAssistanceSelectiveLeaseKeysFromDemandGroups(demanded);
  const previousWaterGroups = new Map(projected.flatMap((group) => (
    parseWaterAssistanceFulfillmentMembershipGroupKey(group.groupKey)
      ? [[group.groupKey, group] as const]
      : []
  )));
  const currentWaterGroups = demanded.filter((group) => (
    parseWaterAssistanceFulfillmentMembershipGroupKey(group.groupKey) !== null
  ));
  for (const current of currentWaterGroups) {
    const parsed = parseWaterAssistanceFulfillmentMembershipGroupKey(current.groupKey)!;
    const previous = previousWaterGroups.get(current.groupKey);
    if (previous) {
      if (previous.requirement !== current.requirement
        || !sameStringSet(previous.leaseKeys, current.leaseKeys)
        || !sameStringSet(previous.eventIds, current.eventIds)) {
        throw new Error(`retention water assistance ${current.groupKey} typed refinement 漂移`);
      }
      previousWaterGroups.delete(current.groupKey);
      continue;
    }
    const coreKey = liveAgreementHistoryLeaseKey(parsed.agreementId);
    const legacyEventIds = new Set(projected
      .filter((group) => group.groupKey === coreKey
        || liveSupportingSourceCoreGroupKey(group.groupKey) === coreKey)
      .flatMap((group) => group.eventIds));
    if (current.eventIds.some((eventId) => !legacyEventIds.has(eventId))) {
      throw new Error(
        `retention water assistance ${current.groupKey} legacy membership 无 exact shell 来源`,
      );
    }
  }
  if (previousWaterGroups.size > 0) {
    throw new Error('retention projection 含 bounded shell 不再拥有的 water assistance typed group');
  }
}

/**
 * Legacy checkpoints pinned every body in one owner group. The only admitted
 * migration keeps that exact owner membership while refining storage to an
 * index plus the two deterministic strict body subsets.
 */
function assertLivePersonSocialStorageRefinementMatches(
  projected: readonly ProjectPressureDemandGroupShape[],
  demanded: readonly ProjectPressureDemandGroupShape[],
): void {
  const relevant = (groups: readonly ProjectPressureDemandGroupShape[]) => groups
    .flatMap((group) => {
      const parsed = parseLivePersonSocialEvidenceGroupKey(group.groupKey);
      return parsed ? [{ group, parsed }] : [];
    });
  const projectedRelevant = relevant(projected);
  const demandedRelevant = relevant(demanded);
  const projectedByKey = new Map(projectedRelevant.map((item) => [item.group.groupKey, item.group]));
  const demandedByKey = new Map(demandedRelevant.map((item) => [item.group.groupKey, item.group]));
  if (projectedByKey.size !== projectedRelevant.length
    || demandedByKey.size !== demandedRelevant.length) {
    throw new Error('retention live social groups 重复');
  }
  for (const { group: current, parsed } of demandedRelevant) {
    if (parsed.kind === 'broad') {
      const previous = projectedByKey.get(current.groupKey);
      if (!previous
        || current.requirement !== 'index-only'
        || (previous.requirement !== 'all' && previous.requirement !== 'index-only')
        || !sameStringSet(previous.leaseKeys, current.leaseKeys)
        || !sameStringSet(previous.eventIds, current.eventIds)) {
        throw new Error(`retention live social ${parsed.ownerId} broad storage refinement 不一致`);
      }
      continue;
    }
    const previous = projectedByKey.get(current.groupKey);
    if (previous) {
      if (previous.requirement !== 'all'
        || current.requirement !== 'all'
        || !sameStringSet(previous.leaseKeys, current.leaseKeys)
        || !sameStringSet(previous.eventIds, current.eventIds)) {
        throw new Error(`retention live social ${parsed.ownerId}/${parsed.kind} strict selector 不一致`);
      }
    } else {
      // A legacy broad-all checkpoint has no strict subgroups. It may refine
      // only bodies already named and pinned by that exact owner membership;
      // unrelated current-shell IDs require a new verified successor/root.
      const legacyBroad = projectedByKey.get(livePersonSocialEvidenceGroupKey(parsed.ownerId));
      const legacyIds = new Set(legacyBroad?.eventIds ?? []);
      if (legacyBroad?.requirement !== 'all'
        || current.eventIds.some((eventId) => !legacyIds.has(eventId))) {
        throw new Error(
          `retention legacy live social ${parsed.ownerId}/${parsed.kind} strict selector 无 broad exact body`,
        );
      }
    }
  }
  for (const { group: previous, parsed } of projectedRelevant) {
    if (parsed.kind === 'broad' && !demandedByKey.has(previous.groupKey)) {
      throw new Error(`retention legacy live social ${parsed.ownerId} broad owner 已漂移`);
    }
    if (parsed.kind !== 'broad' && !demandedByKey.has(previous.groupKey)) {
      throw new Error(`retention live social ${parsed.ownerId}/${parsed.kind} strict group 已漂移`);
    }
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

export interface HistoryRetentionProjectionFold {
  status: 'open' | 'discarded' | 'finished';
  authority: HistoryRetentionAuthority;
  target: HistoryRetentionSeal;
  demandFingerprint: string;
  directDemandEventIds: Set<string>;
  demandGroupsByKey: Map<string, DirectDemandGroup>;
  millLaborPersonIds: Set<string>;
  directMatchesByEventId: Map<string, DirectPinMatch>;
  millLaborRingsByPersonId: Map<string, DirectPinMatch[]>;
  pendingMechanicalTeachingByAudienceId: Map<string, PendingMechanicalTeaching>;
  witnessedMechanicalAudienceIds: Set<string>;
  pendingEraPredictionIds: Set<string>;
  livingChildIds: Set<string>;
  reproductionFactsByIntentId: Map<string, ReproductionFactDemand>;
  reproductionIntentIdsByOwnerId: Map<string, Set<string>>;
  reproductionIntentIdsByFemaleId: Map<string, Set<string>>;
  reproductionIntentIdsByAttemptEventId: Map<string, Set<string>>;
  selectiveMatchesByLeaseKey: Map<string, DirectPinMatch[]>;
  productionSelectorLeaseKeyByPersonId: Map<string, string>;
  calibrationSelectorsByPersonId: Map<string, CalibrationSelector[]>;
  modernRecordValidationState: SimulationState;
  waterAssistanceSelectorsByEventId: Map<string, WaterAssistanceSelector[]>;
  waterAssistanceSelectiveLeaseKeys: Set<string>;
  waterAssistanceValidationState: SimulationState;
  productionWindowMonth: number;
  livingChildBirthMatchesByChildId: Map<string, DirectPinMatch>;
  continuationSourceTarget?: HistoryRetentionSeal;
  requiredSuffixDirectDemandEventIds: Set<string>;
  requiredSuffixReproductionAnchorEventIds: Set<string>;
  newLivingPersonIdsRequiringBirth: Set<string>;
  newPendingEraPredictionIdsRequiringCreation: Set<string>;
  pendingEraPredictionCreationMatchesById: Map<string, DirectPinMatch>;
  minimalMechanicalTeachingWitness?: MechanicalTeachingOperationWitness;
  summary: HistoryRetentionSummary;
  finishedResult?: HistoryRetentionProjectionResult;
}

const EMPTY_MECHANICAL_COUNTS: MechanicalP0HistoryCounts = {
  millLaborActions: 0, waterCurrentObservations: 0, componentInstallations: 0,
  loadedOperations: 0, serviceOperations: 0, faultEvents: 0, commissioningFaults: 0,
  wornDriveShaftFaults: 0, faultDiagnoses: 0, repairs: 0, recoveryOperations: 0,
  completedExplicitMechanicalTeachings: 0, independentTaughtOperatorWitnesses: 0,
};

const CONTINUATION_GAPS: HistoryRetentionContinuationGap[] = [{
  code: 'dynamic-pending-era-prediction',
  policy: 'fail-closed',
  description: '新增 pending prediction 必须由当次 suffix 内的权威创建事实证明，否则拒绝续接',
}, {
  code: 'dynamic-non-birth-person',
  policy: 'fail-closed',
  description: '新增存活人物若没有 suffix 出生事实，无法证明其 checkpoint 前 mill labor 为空',
}, {
  code: 'mutated-reproduction-selector',
  policy: 'fail-closed',
  description: '既有 reproduction intent 的 owner/creation/female/agreement window 或 attempt ID 集改写后无法重选 checkpoint 前事实',
}, {
  code: 'bounded-pending-era-prediction-wakes',
  policy: 'fail-closed',
  description: `pending prediction 的 all-match disputed wake 超过 ${HISTORY_RETENTION_MAX_PENDING_PREDICTION_WAKE_MATCHES} 条时必须拒绝，不得截断或冒充完整证据`,
}, {
  code: 'bounded-active-project-action-history',
  policy: 'fail-closed',
  description: `active project 的通用 actionEventIds 超过 ${HISTORY_RETENTION_MAX_ACTIVE_PROJECT_ACTION_EVENT_IDS} 条，电力维护替换件窗口超过 ${HISTORY_RETENTION_MAX_ELECTRICAL_MAINTENANCE_PROJECT_EVENT_IDS} 条，或存活游戏依赖的已完成项目/共同劳动来源超过 ${HISTORY_RETENTION_MAX_COMPLETED_PROJECT_SOURCE_EVENT_IDS} 条时必须拒绝，等待领域级闭合或压缩`,
}, {
  code: 'unsealed-exact-root-lineage',
  policy: 'fail-closed',
  description: 'basis hash 只能检测内容改写；持久化续接必须由 exact-root closed wrapper 额外 brand 并验证 CAS stateHash、lineage 与绝对 cursor',
}];

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}必须是非负安全整数`);
}

function shellHistorySeal(state: SimulationState): HistoryRetentionSeal {
  const { historyCursor, past } = state.world;
  if (!Array.isArray(past)) throw new Error('retention projection shell 的 world.past 必须是数组');
  if (!historyCursor) return { eventCount: past.length, tailEventId: past.at(-1)?.id ?? null };
  if (historyCursor.version !== 1) throw new Error('retention projection shell 的 history cursor 版本无效');
  assertNonNegativeSafeInteger(historyCursor.eventCount, 'history cursor eventCount');
  assertNonNegativeSafeInteger(historyCursor.hotStartIndex, 'history cursor hotStartIndex');
  if (historyCursor.hotStartIndex > historyCursor.eventCount
    || historyCursor.eventCount - historyCursor.hotStartIndex !== past.length) {
    throw new Error('retention projection shell 的 hot history 与绝对 cursor 不一致');
  }
  if (historyCursor.eventCount === 0) {
    if (historyCursor.tailEventId !== null) throw new Error('空历史的 tailEventId 必须为 null');
  } else if (typeof historyCursor.tailEventId !== 'string' || historyCursor.tailEventId.length === 0) {
    throw new Error('非空历史缺少 tailEventId');
  }
  if (past.length > 0 && past.at(-1)?.id !== historyCursor.tailEventId) {
    throw new Error('retention projection shell 的 hot history 尾事实与 cursor 不一致');
  }
  return { eventCount: historyCursor.eventCount, tailEventId: historyCursor.tailEventId };
}

function requiredEventId(value: string, context: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${context} 含空 source event ID`);
  return value;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function addDemandGroup(
  groups: Map<string, DirectDemandGroup>,
  demandedIds: Set<string>,
  input: {
    groupKey: string;
    requirement: HistoryRetentionRequirement;
    leaseKey: string;
    eventIds: readonly string[];
    includeEmpty?: boolean;
  },
): void {
  if (input.eventIds.length === 0 && !input.includeEmpty) return;
  let group = groups.get(input.groupKey);
  if (!group) {
    group = { groupKey: input.groupKey, requirement: input.requirement, leaseKeys: new Set(), eventIds: new Set() };
    groups.set(input.groupKey, group);
  } else if (group.requirement !== input.requirement) {
    throw new Error(`retention demand group ${input.groupKey} requirement 冲突`);
  }
  group.leaseKeys.add(input.leaseKey);
  for (const value of input.eventIds) {
    const eventId = requiredEventId(value, input.groupKey);
    group.eventIds.add(eventId);
    demandedIds.add(eventId);
  }
}

function boundedCanonicalEventIds(
  values: readonly string[] | undefined,
  context: string,
): string[] {
  if (!Array.isArray(values)
    || values.length > HISTORY_RETENTION_MAX_ACTIVE_PROJECT_ACTION_EVENT_IDS) {
    throw new Error(`${context} 超出有界续接上限 ${HISTORY_RETENTION_MAX_ACTIVE_PROJECT_ACTION_EVENT_IDS}`);
  }
  return [...new Set(values.map((value) => requiredEventId(value, context)))].sort();
}

function boundedCanonicalEventIdsAtMost(
  values: readonly string[] | undefined,
  context: string,
  maximum: number,
): string[] {
  if (!Array.isArray(values) || values.length > maximum) {
    throw new Error(`${context} 超出有界续接上限 ${maximum}`);
  }
  return [...new Set(values.map((value) => requiredEventId(value, context)))].sort();
}

function boundedCompletedProjectSourceEventIds(
  values: readonly string[] | undefined,
  context: string,
): string[] {
  if (!Array.isArray(values)
    || values.length > HISTORY_RETENTION_MAX_COMPLETED_PROJECT_SOURCE_EVENT_IDS) {
    throw new Error(
      `${context} 超出已完成项目有界来源上限`
      + ` ${HISTORY_RETENTION_MAX_COMPLETED_PROJECT_SOURCE_EVENT_IDS}`,
    );
  }
  return [...new Set(values.map((value) => requiredEventId(value, context)))].sort();
}

function boundedElectricalFactEventIds(
  values: readonly string[] | undefined,
  context: string,
  maximum = ELECTRICAL_POWER_SOURCE_EVENT_LIMIT,
): string[] {
  if (!Array.isArray(values) || values.length > maximum) {
    throw new Error(`${context} 超出电力事实来源上限 ${maximum}`);
  }
  return [...new Set(values.map((value) => requiredEventId(value, context)))].sort();
}

function boundedLivePersonSocialEventIds(
  person: SimulationState['people'][number],
): string[] {
  return livePersonSocialSourceEventIds(person);
}

function boundedLiveProjectPressureSourceEventIds(
  livingPeople: readonly SimulationState['people'][number][],
): string[] {
  const values = livingPeople.flatMap(rememberedProjectPressureSourceEventIds);
  const eventIds = [...new Set(values.map((value) => requiredEventId(
    value,
    'living person project-pressure remembered sources',
  )))].sort();
  if (eventIds.length > HISTORY_RETENTION_MAX_LIVE_PROJECT_PRESSURE_SOURCE_EVENT_IDS) {
    throw new Error(
      'living person project-pressure source IDs 超出有界续接上限 '
      + HISTORY_RETENTION_MAX_LIVE_PROJECT_PRESSURE_SOURCE_EVENT_IDS,
    );
  }
  return eventIds;
}

function boundedFutureFamilyStoredFoodSourceEventIds(state: SimulationState): string[] {
  const values = (state.containers ?? []).flatMap((container) => [
    ...container.sourceEventIds,
    ...container.inventory
      .filter((stack) => stack.quantity > 0 && materialHas(stack.materialId, 'edible'))
      .flatMap((stack) => stack.sourceEventIds),
  ]);
  const eventIds = [...new Set(values.map((value) => requiredEventId(
    value,
    'future family-readiness stored-food sources',
  )))].sort();
  if (eventIds.length > HISTORY_RETENTION_MAX_FUTURE_FAMILY_STORED_FOOD_SOURCE_EVENT_IDS) {
    throw new Error(
      'future family-readiness stored-food source IDs 超出有界续接上限 '
      + HISTORY_RETENTION_MAX_FUTURE_FAMILY_STORED_FOOD_SOURCE_EVENT_IDS,
    );
  }
  return eventIds;
}

function boundedFutureSocialRepetitionSourceEventIds(
  state: SimulationState,
  livingPeople: readonly SimulationState['people'][number][],
): string[] {
  const rememberedEventIds = new Set(livingPeople.flatMap((person) => (
    person.memories.flatMap((memory) => memory.sourceEventIds)
  )));
  const values = (state.agreements ?? [])
    .filter((agreement) => rememberedEventIds.has(agreement.proposalEventId))
    .flatMap((agreement) => agreement.sourceEventIds ?? []);
  const eventIds = [...new Set(values.map((value) => requiredEventId(
    value,
    'future social-repetition agreement outcome sources',
  )))].sort();
  if (eventIds.length > HISTORY_RETENTION_MAX_FUTURE_SOCIAL_REPETITION_SOURCE_EVENT_IDS) {
    throw new Error(
      'future social-repetition source IDs 超出有界续接上限 '
      + HISTORY_RETENTION_MAX_FUTURE_SOCIAL_REPETITION_SOURCE_EVENT_IDS,
    );
  }
  return eventIds;
}

function boundedFutureCognitiveAppraisalSourceEventIds(
  livingPeople: readonly SimulationState['people'][number][],
): string[] {
  const values = livingPeople.flatMap((person) => [
    ...(person.cognition?.outcomeBeliefs ?? []).flatMap((belief) => belief.sourceEventIds),
    ...(person.cognition?.goalOutcomeBeliefs ?? []).flatMap((belief) => belief.sourceEventIds),
    ...(person.cognition?.needResolutionEpisodes ?? []).flatMap((episode) => episode.sourceFactIds),
    ...(person.personality?.changes ?? []).slice(-6).flatMap((change) => change.sourceEventIds),
    ...(person.traits ?? []).flatMap((trait) => trait.sourceEventIds),
  ]);
  const eventIds = [...new Set(values.map((value) => requiredEventId(
    value,
    'future cognitive-appraisal living sources',
  )))].sort();
  if (eventIds.length > HISTORY_RETENTION_MAX_FUTURE_COGNITIVE_APPRAISAL_SOURCE_EVENT_IDS) {
    throw new Error(
      'future cognitive-appraisal source IDs 超出有界续接上限 '
      + HISTORY_RETENTION_MAX_FUTURE_COGNITIVE_APPRAISAL_SOURCE_EVENT_IDS,
    );
  }
  return eventIds;
}

function boundedSocialLearningSourceEventIds(
  person: SimulationState['people'][number],
): string[] {
  const socialLearning = person.cognition?.socialLearning;
  if (!socialLearning) return [];
  if (socialLearning.version !== 'social-learning-v1'
    || !Array.isArray(socialLearning.beliefs)
    || socialLearning.beliefs.length > MAX_SOCIAL_COOPERATION_BELIEFS
    || !Array.isArray(socialLearning.coordinationPractices)
    || socialLearning.coordinationPractices.length > MAX_COORDINATION_PRACTICES) {
    throw new Error(`person ${person.id} social learning state 无效`);
  }
  const values: string[] = [];
  for (const belief of socialLearning.beliefs) {
    if (!Array.isArray(belief.sourceEventIds)
      || belief.sourceEventIds.length > MAX_SOCIAL_BELIEF_SOURCES
      || !Array.isArray(belief.receipts)
      || belief.receipts.length > MAX_SOCIAL_BELIEF_RECEIPTS) {
      throw new Error(`person ${person.id} social learning belief sources 无效或超界`);
    }
    values.push(...belief.sourceEventIds);
    for (const receipt of belief.receipts) {
      if (!Array.isArray(receipt.sourceEventIds)
        || receipt.sourceEventIds.length > MAX_SOCIAL_BELIEF_SOURCES) {
        throw new Error(`person ${person.id} social learning receipt sources 无效或超界`);
      }
      values.push(...receipt.sourceEventIds);
    }
  }
  for (const practice of socialLearning.coordinationPractices) {
    if (!Array.isArray(practice.sourceFactIds)
      || practice.sourceFactIds.length > MAX_SOCIAL_BELIEF_SOURCES
      || !Array.isArray(practice.successes)
      || practice.successes.length > MAX_PRACTICE_EPISODES
      || !Array.isArray(practice.recentCounterEvidence)
      || practice.recentCounterEvidence.length > MAX_PRACTICE_EPISODES) {
      throw new Error(`person ${person.id} coordination practice sources 无效或超界`);
    }
    values.push(...practice.sourceFactIds);
    for (const episode of [...practice.successes, ...practice.recentCounterEvidence]) {
      if (!Array.isArray(episode.sourceEventIds)
        || episode.sourceEventIds.length > MAX_SOCIAL_BELIEF_SOURCES) {
        throw new Error(`person ${person.id} coordination practice episode sources 无效或超界`);
      }
      values.push(...episode.sourceEventIds);
    }
  }
  const eventIds = [...new Set(values.map((value) => requiredEventId(
    value,
    `person ${person.id} social learning sources`,
  )))].sort();
  if (eventIds.length > HISTORY_RETENTION_MAX_SOCIAL_LEARNING_EVENT_IDS_PER_PERSON) {
    throw new Error(
      `person ${person.id} social learning source IDs 超出有界上限 `
      + HISTORY_RETENTION_MAX_SOCIAL_LEARNING_EVENT_IDS_PER_PERSON,
    );
  }
  return eventIds;
}

interface GroundedResponseSourceDemand {
  responderId: string;
  openingEventId: string;
  eventIds: string[];
}

interface RecentTerminalFailureActionDemand {
  ownerId: string;
  eventIds: string[];
}

function groundedResponseSourceDemands(
  state: SimulationState,
  livingPeople: readonly SimulationState['people'][number][],
): GroundedResponseSourceDemand[] {
  const livingPersonIds = new Set(livingPeople.map((person) => person.id));
  const byLeaseKey = new Map<string, {
    responderId: string;
    openingEventId: string;
    eventIds: Set<string>;
  }>();
  const add = (
    responderId: string,
    openingEventId: string,
    sourceFactIds: readonly string[],
  ) => {
    if (!livingPersonIds.has(responderId)) return;
    const leaseKey = groundedConversationResponseSourceLeaseKey(responderId, openingEventId);
    const existing = byLeaseKey.get(leaseKey) ?? {
      responderId,
      openingEventId,
      eventIds: new Set<string>(),
    };
    for (const eventId of boundedCanonicalEventIds(
      [openingEventId, ...sourceFactIds],
      `grounded response ${responderId}/${openingEventId} sources`,
    )) existing.eventIds.add(eventId);
    byLeaseKey.set(leaseKey, existing);
    if (byLeaseKey.size > HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_SOURCE_GROUPS) {
      throw new Error(
        'grounded response source groups 超出有界续接上限 '
        + HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_SOURCE_GROUPS,
      );
    }
  };

  for (const listener of livingPeople) {
    for (const opening of groundedConversationOpeningsForListener(state, listener.id)) {
      if (hasRecentGroundedConversationResponseForListener(state, listener.id, opening.id)
        || opening.action.kind !== 'communicate'
        || opening.action.content.kind !== 'claim'
        || !opening.action.audience.includes(listener.id)) continue;
      const conversation = opening.action.content.conversation;
      if (conversation?.turn !== 'opening' || conversation.listenerId !== listener.id) continue;
      add(listener.id, opening.id, conversation.sourceFactIds);
    }
  }

  for (const intent of state.intents ?? []) {
    if (!livingPersonIds.has(intent.ownerId)
      || (intent.status !== 'active' && intent.status !== 'suspended')) continue;
    for (const action of [intent.nextAction, intent.completionAction]) {
      if (action?.kind !== 'communicate' || action.content.kind !== 'claim') continue;
      const conversation = action.content.conversation;
      if (conversation?.turn !== 'response'
        || conversation.speakerId !== intent.ownerId
        || !conversation.referenceEventId) continue;
      add(intent.ownerId, conversation.referenceEventId, conversation.sourceFactIds);
    }
  }

  const uniqueEventIds = new Set<string>();
  const demands = [...byLeaseKey.values()]
    .map((demand) => {
      const eventIds = [...demand.eventIds].sort();
      if (eventIds.length > HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_SOURCE_EVENT_IDS) {
        throw new Error(
          `grounded response ${demand.responderId}/${demand.openingEventId}`
          + ` sources 超出有界续接上限 ${HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_SOURCE_EVENT_IDS}`,
        );
      }
      eventIds.forEach((eventId) => uniqueEventIds.add(eventId));
      return { ...demand, eventIds };
    })
    .sort((left, right) => left.responderId.localeCompare(right.responderId)
      || left.openingEventId.localeCompare(right.openingEventId));
  if (uniqueEventIds.size > HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_UNIQUE_EVENT_IDS) {
    throw new Error(
      'grounded response unique source IDs 超出有界续接上限 '
      + HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_UNIQUE_EVENT_IDS,
    );
  }
  return demands;
}

function recentTerminalFailureActionDemands(
  state: SimulationState,
  livingPeople: readonly SimulationState['people'][number][],
): RecentTerminalFailureActionDemand[] {
  const livingPersonIds = new Set(livingPeople.map((person) => person.id));
  const eventIdsByOwnerId = new Map<string, Set<string>>();
  for (const intent of state.intents ?? []) {
    if (!livingPersonIds.has(intent.ownerId)
      || (intent.status !== 'blocked' && intent.status !== 'failed')
      || !intent.goalOutcome) continue;
    const age = state.clock.elapsedMonths - intent.goalOutcome.resolvedAtMonth;
    if (!Number.isSafeInteger(age)
      || age < 0
      || age > HISTORY_RETENTION_RECENT_TERMINAL_FAILURE_WINDOW_MONTHS) continue;
    if (!Array.isArray(intent.actionEventIds)
      || intent.actionEventIds.length > MAX_LIVE_INTENT_ACTION_EVENT_IDS) {
      throw new Error(
        `recent terminal failure intent ${intent.id} actionEventIds 超出有界上限`
        + ` ${MAX_LIVE_INTENT_ACTION_EVENT_IDS}`,
      );
    }
    if (!Array.isArray(intent.goalOutcome.sourceEventIds)
      || intent.goalOutcome.sourceEventIds.length > MAX_LIVE_INTENT_ACTION_EVENT_IDS) {
      throw new Error(
        `recent terminal failure intent ${intent.id} outcome sources 超出有界上限`
        + ` ${MAX_LIVE_INTENT_ACTION_EVENT_IDS}`,
      );
    }
    const outcomeEventIds = new Set(intent.goalOutcome.sourceEventIds.map((eventId) => (
      requiredEventId(eventId, `recent terminal failure intent ${intent.id} outcome sources`)
    )));
    const ownerEventIds = eventIdsByOwnerId.get(intent.ownerId) ?? new Set<string>();
    for (const eventId of intent.actionEventIds) {
      const requiredId = requiredEventId(
        eventId,
        `recent terminal failure intent ${intent.id} action events`,
      );
      if (outcomeEventIds.has(requiredId)) ownerEventIds.add(requiredId);
    }
    if (ownerEventIds.size > HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_PER_PERSON) {
      throw new Error(
        `recent terminal failure owner ${intent.ownerId} action facts 超出有界上限`
        + ` ${HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_PER_PERSON}`,
      );
    }
    if (ownerEventIds.size > 0) eventIdsByOwnerId.set(intent.ownerId, ownerEventIds);
  }
  const demands = [...eventIdsByOwnerId]
    .map(([ownerId, eventIds]) => ({ ownerId, eventIds: [...eventIds].sort() }))
    .sort((left, right) => left.ownerId.localeCompare(right.ownerId));
  const totalEventIdCount = demands.reduce((sum, demand) => sum + demand.eventIds.length, 0);
  if (demands.length > HISTORY_RETENTION_MAX_LIVE_GAMEPLAY_SELECTOR_PERSONS
    || totalEventIdCount > HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_TOTAL) {
    throw new Error(
      'recent terminal failure action leases 超出有界上限 '
      + `${HISTORY_RETENTION_MAX_LIVE_GAMEPLAY_SELECTOR_PERSONS} people/`
      + `${HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_TOTAL} total events`,
    );
  }
  return demands;
}

function boundedFutureActiveProjectLogisticsSourceEventIds(
  state: SimulationState,
): string[] {
  const values = state.projects
    .filter((project) => project.status === 'active' && project.activeLogisticsEpisodeId)
    .flatMap((project) => {
      const episode = (project.logisticsEpisodes ?? []).find((candidate) => (
        candidate.id === project.activeLogisticsEpisodeId && candidate.status === 'active'
      ));
      return episode?.sourceEventIds ?? [];
    });
  const eventIds = [...new Set(values.map((value) => requiredEventId(
    value,
    'future active-project logistics sources',
  )))].sort();
  if (eventIds.length > HISTORY_RETENTION_MAX_FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_EVENT_IDS) {
    throw new Error(
      'future active-project logistics source IDs 超出有界续接上限 '
      + HISTORY_RETENTION_MAX_FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_EVENT_IDS,
    );
  }
  return eventIds;
}

function boundedFutureMaterialAffordanceSourceEventIds(state: SimulationState): string[] {
  const values = [
    ...(state.world.drops ?? [])
      .filter((drop) => drop.quantity > 0)
      .flatMap((drop) => drop.sourceEventIds),
    ...(state.containers ?? []).flatMap((container) => [
      ...container.sourceEventIds,
      ...container.inventory
        .filter((stack) => stack.quantity > 0)
        .flatMap((stack) => stack.sourceEventIds),
    ]),
    ...(state.world.physicalStructureIndex?.structures ?? [])
      .filter((structure) => structure.complete)
      .flatMap((structure) => structure.sourceEventIds),
  ];
  const eventIds = [...new Set(values.map((value) => requiredEventId(
    value,
    'future material-affordance current entity sources',
  )))].sort();
  if (eventIds.length > HISTORY_RETENTION_MAX_FUTURE_MATERIAL_AFFORDANCE_SOURCE_EVENT_IDS) {
    throw new Error(
      'future material-affordance source IDs 超出有界续接上限 '
      + HISTORY_RETENTION_MAX_FUTURE_MATERIAL_AFFORDANCE_SOURCE_EVENT_IDS,
    );
  }
  return eventIds;
}

function addActiveProjectAnchorDemand(
  groups: Map<string, DirectDemandGroup>,
  demandedIds: Set<string>,
  project: SimulationState['projects'][number],
  suffix: string,
  values: readonly string[] | undefined,
): void {
  const eventIds = boundedCanonicalEventIds(values ?? [], `active project ${project.id} ${suffix}`);
  addDemandGroup(groups, demandedIds, {
    groupKey: `active-project:${project.id}:${suffix}`,
    requirement: 'all',
    leaseKey: `active-project:${project.id}:${suffix}`,
    eventIds,
  });
}

function isLiving(person: SimulationState['people'][number]): boolean {
  return person.diedAtMonth === undefined && person.body.health > 0;
}

function isMechanicalProject(project: SimulationState['projects'][number]): boolean {
  return project.status === 'active' && (project.desiredFunction === 'water-powered-crop-processing'
    || project.desiredFunction === 'restore-water-powered-crop-processing'
    || project.desiredFunction === 'durable-power-transmission');
}

function isMeasurementProject(project: SimulationState['projects'][number]): boolean {
  return project.status === 'active'
    && project.desiredFunction === 'comparable-mass-measurement';
}

function completedMeasurementWitnessProject(
  state: SimulationState,
): SimulationState['projects'][number] | undefined {
  return state.projects
    .filter((project) => project.status === 'completed'
      && project.desiredFunction === 'comparable-mass-measurement'
      && project.measurementUncertaintyBasis?.version === 'measurement-uncertainty-basis-v1'
      && project.completionEventIds.length > 0)
    .sort((left, right) => (right.completedAtMonth ?? -1) - (left.completedAtMonth ?? -1)
      || right.id.localeCompare(left.id))[0];
}

export function completedLiveProjectCompletionLeaseKey(projectId: string): string {
  return `gameplay:completed-live-project:${encodeURIComponent(projectId)}:completion-events`;
}

export function livingSharedProjectActionLeaseKey(
  firstPersonId: string,
  secondPersonId: string,
  projectId: string,
): string {
  const [first, second] = firstPersonId <= secondPersonId
    ? [firstPersonId, secondPersonId]
    : [secondPersonId, firstPersonId];
  return [
    'gameplay:living-shared-project',
    encodeURIComponent(first),
    encodeURIComponent(second),
    encodeURIComponent(projectId),
    'action-events',
  ].join(':');
}

interface LivingPersonPair { firstPersonId: string; secondPersonId: string }

function livingSharedProjectPairs(
  state: SimulationState,
  livingPersonIds: ReadonlySet<string>,
): LivingPersonPair[] {
  const pairs = new Map<string, LivingPersonPair>();
  for (const project of state.projects) {
    if (project.actionEventIds.length + project.completionEventIds.length === 0) continue;
    const participants = [...new Set([project.ownerId, ...project.contributorIds])]
      .filter((personId) => livingPersonIds.has(personId))
      .sort();
    for (let firstIndex = 0; firstIndex < participants.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < participants.length; secondIndex += 1) {
        const pair: LivingPersonPair = {
          firstPersonId: participants[firstIndex]!,
          secondPersonId: participants[secondIndex]!,
        };
        const key = JSON.stringify([pair.firstPersonId, pair.secondPersonId]);
        pairs.set(key, pair);
        if (pairs.size > HISTORY_RETENTION_MAX_LIVING_SHARED_PROJECT_PAIRS) {
          throw new Error(
            `retention living shared-project selectors 超出`
            + ` ${HISTORY_RETENTION_MAX_LIVING_SHARED_PROJECT_PAIRS} 人物对上限`,
          );
        }
      }
    }
  }
  return [...pairs.values()].sort((left, right) => (
    left.firstPersonId.localeCompare(right.firstPersonId)
    || left.secondPersonId.localeCompare(right.secondPersonId)
  ));
}

function reliabilityReceiptEventIds(receipt: MechanicalPowerReliabilityCycleReceipt): string[] {
  return [
    receipt.faultEventId,
    ...receipt.faultSourceEventIds,
    receipt.shaftInstallationEventId,
    ...receipt.shaftInstallationSourceEventIds,
    ...(receipt.shaftRepairEventId ? [receipt.shaftRepairEventId] : []),
    ...receipt.shaftRepairSourceEventIds,
    ...receipt.loadedOperationEventIds,
  ];
}

function pendingEraPredictionWakeLeaseKey(predictionId: string): string {
  return `gameplay:pending-era-prediction:${predictionId}:disputed-wake`;
}

function livingChildBirthLeaseKey(childId: string): string {
  return `gameplay:living-child:${childId}:birth`;
}

function reproductionAttemptLeaseKey(intentId: string): string {
  return `gameplay:reproduction-intent:${intentId}:attempt`;
}

function reproductionConceptionLeaseKey(intentId: string): string {
  return `gameplay:reproduction-intent:${intentId}:conception`;
}

function isReproductionIntent(intent: SimulationState['intents'][number]): boolean {
  return intent.status === 'active' && (
    (intent.goal.kind === 'condition' && intent.goal.condition === 'pregnancy' && intent.goal.present)
    || [intent.nextAction, intent.completionAction].some((action) => action?.kind === 'act'
      && action.operation === 'reproduce')
  );
}

function boundedReproductionAttemptEventIds(
  intent: SimulationState['intents'][number],
  agreement: SimulationState['agreements'][number] | undefined,
): {
  agreementId: string | null;
  acceptedAtMonth: number | null;
  dueAtMonth: number | null;
  lastAttemptAtMonth: number | null;
  attemptEventIds: Set<string>;
} {
  if (!agreement) return {
    agreementId: null,
    acceptedAtMonth: null,
    dueAtMonth: null,
    lastAttemptAtMonth: null,
    attemptEventIds: new Set(),
  };
  if (agreement.proposal.kind !== 'reproduce') {
    throw new Error(`reproduction intent ${intent.id} 引用了非生殖 agreement ${agreement.id}`);
  }
  const raw = agreement.reproductionAttemptEventIds ?? [];
  if (!Array.isArray(raw)
    || raw.some((eventId) => typeof eventId !== 'string' || eventId.length === 0)) {
    throw new Error(`reproduction agreement ${agreement.id} 的 attempt event IDs 无效`);
  }
  const allAttemptEventIds = new Set(raw);
  if (allAttemptEventIds.size !== raw.length) {
    throw new Error(`reproduction agreement ${agreement.id} 的 attempt event IDs 重复`);
  }
  if (allAttemptEventIds.size > HISTORY_RETENTION_MAX_REPRODUCTION_ATTEMPT_EVENT_IDS) {
    throw new Error(
      `reproduction agreement ${agreement.id} 超出 ${HISTORY_RETENTION_MAX_REPRODUCTION_ATTEMPT_EVENT_IDS} 个月 consent window`,
    );
  }
  const existingAtIntentStart = intent.reproductionAttemptEventIdsAtStart ?? [];
  if (!Array.isArray(existingAtIntentStart)
    || existingAtIntentStart.length > raw.length
    || existingAtIntentStart.some((eventId, index) => (
      typeof eventId !== 'string' || eventId.length === 0 || raw[index] !== eventId
    ))) {
    throw new Error(`reproduction intent ${intent.id} 的 agreement attempt 基线无效`);
  }
  // An agreement can remain active after one party's unsuccessful attempt and
  // expose a fresh intent to the other party later in the same consent window.
  // Attempts that predate that binding are agreement history, not evidence
  // produced by the new intent's lifecycle.
  const attemptEventIds = new Set(raw.slice(existingAtIntentStart.length));

  const hasAcceptedWindow = agreement.acceptedAtMonth !== undefined || agreement.dueAtMonth !== undefined;
  if (raw.length > 0 || hasAcceptedWindow || agreement.status === 'active' || agreement.status === 'fulfilled') {
    if (!Number.isSafeInteger(agreement.acceptedAtMonth)
      || !Number.isSafeInteger(agreement.dueAtMonth)
      || Number(agreement.dueAtMonth) - Number(agreement.acceptedAtMonth) + 1
        !== HISTORY_RETENTION_MAX_REPRODUCTION_ATTEMPT_EVENT_IDS) {
      throw new Error(`reproduction agreement ${agreement.id} 缺少有效的固定 consent window`);
    }
  }
  if (raw.length > 0) {
    if (!Number.isSafeInteger(agreement.lastReproductionAttemptAtMonth)
      || Number(agreement.lastReproductionAttemptAtMonth) < Number(agreement.acceptedAtMonth)
      || Number(agreement.lastReproductionAttemptAtMonth) > Number(agreement.dueAtMonth)) {
      throw new Error(`reproduction agreement ${agreement.id} 缺少窗口内最后尝试月份`);
    }
  } else if (agreement.lastReproductionAttemptAtMonth !== undefined) {
    throw new Error(`reproduction agreement ${agreement.id} 有最后尝试月份但没有 attempt event ID`);
  }
  return {
    agreementId: agreement.id,
    acceptedAtMonth: agreement.acceptedAtMonth ?? null,
    dueAtMonth: agreement.dueAtMonth ?? null,
    lastAttemptAtMonth: attemptEventIds.size > 0
      ? agreement.lastReproductionAttemptAtMonth ?? null
      : null,
    attemptEventIds,
  };
}

function collectDemand(state: SimulationState) {
  historyRetentionDemandCollectionCount += 1;
  const directDemandEventIds = new Set<string>();
  const demandGroupsByKey = new Map<string, DirectDemandGroup>();
  const livingPeople = state.people.filter(isLiving);
  if (livingPeople.length > HISTORY_RETENTION_MAX_LIVE_GAMEPLAY_SELECTOR_PERSONS) {
    throw new Error(`retention living gameplay selectors 超出 ${HISTORY_RETENTION_MAX_LIVE_GAMEPLAY_SELECTOR_PERSONS} 人上限`);
  }
  const peopleById = new Map<string, SimulationState['people'][number]>();
  for (const person of state.people) peopleById.set(person.id, person);
  const millLaborPersonIds = new Set(livingPeople.map((person) => person.id));
  const pendingEraPredictionIds = new Set<string>();
  const livingChildIds = new Set(livingPeople
    .filter((person) => (person.geneticParents?.length ?? 0) > 0)
    .map((person) => person.id));
  const reproductionFactsByIntentId = new Map<string, ReproductionFactDemand>();
  const calibrationSelectorsByPersonId = new Map<string, CalibrationSelector[]>();
  const waterAssistanceSelectorsByEventId = new Map<string, WaterAssistanceSelector[]>();
  let activeWaterAssistanceAgreementCount = 0;
  const productionWindowMonth = state.clock.elapsedMonths;
  const completedMeasurementProject = completedMeasurementWitnessProject(state);
  const independentRecordWitness = firstIndependentRecordReuseFact(state);
  assertNonNegativeSafeInteger(productionWindowMonth, 'retention production window month');
  const target = shellHistorySeal(state);
  if (target.tailEventId !== null) addDemandGroup(demandGroupsByKey, directDemandEventIds, {
    groupKey: recentPersonalProductionWindowGroupKey(productionWindowMonth),
    requirement: 'all',
    leaseKey: RECENT_PRODUCTION_WINDOW_LEASE,
    eventIds: [target.tailEventId],
  });
  const liveProjectPressureSourceEventIds = boundedLiveProjectPressureSourceEventIds(livingPeople);
  addDemandGroup(demandGroupsByKey, directDemandEventIds, {
    groupKey: LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY,
    requirement: 'index-only',
    leaseKey: LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY,
    eventIds: liveProjectPressureSourceEventIds,
    includeEmpty: true,
  });
  addDemandGroup(demandGroupsByKey, directDemandEventIds, {
    groupKey: FUTURE_FAMILY_STORED_FOOD_SOURCE_LEASE_KEY,
    requirement: 'audit-only',
    leaseKey: FUTURE_FAMILY_STORED_FOOD_SOURCE_LEASE_KEY,
    eventIds: boundedFutureFamilyStoredFoodSourceEventIds(state),
  });
  addDemandGroup(demandGroupsByKey, directDemandEventIds, {
    groupKey: FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY,
    requirement: 'index-only',
    leaseKey: FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY,
    eventIds: boundedFutureSocialRepetitionSourceEventIds(state, livingPeople),
  });
  addDemandGroup(demandGroupsByKey, directDemandEventIds, {
    groupKey: FUTURE_COGNITIVE_APPRAISAL_SOURCE_LEASE_KEY,
    requirement: 'index-only',
    leaseKey: FUTURE_COGNITIVE_APPRAISAL_SOURCE_LEASE_KEY,
    eventIds: boundedFutureCognitiveAppraisalSourceEventIds(livingPeople),
  });
  if (independentRecordWitness?.diff.recordUseReplicationReceipt === true) {
    const inputSourceEventIds = independentRecordWitness.diff.recordUseInputSourceEventIds;
    if (!Array.isArray(inputSourceEventIds)
      || inputSourceEventIds.some((eventId) => typeof eventId !== 'string' || eventId.length === 0)) {
      throw new Error(`现代记录复制见证 ${independentRecordWitness.id} 缺少精确输入来源`);
    }
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${MODERN_RECORD_EXPERIMENT_LEASE_KEY}:replication-input-sources`,
      requirement: 'all',
      leaseKey: MODERN_RECORD_EXPERIMENT_LEASE_KEY,
      eventIds: inputSourceEventIds,
    });
  }
  addDemandGroup(demandGroupsByKey, directDemandEventIds, {
    groupKey: FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_LEASE_KEY,
    requirement: 'index-only',
    leaseKey: FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_LEASE_KEY,
    eventIds: boundedFutureActiveProjectLogisticsSourceEventIds(state),
  });
  addDemandGroup(demandGroupsByKey, directDemandEventIds, {
    groupKey: FUTURE_MATERIAL_AFFORDANCE_SOURCE_LEASE_KEY,
    requirement: 'audit-only',
    leaseKey: FUTURE_MATERIAL_AFFORDANCE_SOURCE_LEASE_KEY,
    eventIds: boundedFutureMaterialAffordanceSourceEventIds(state),
  });
  for (const response of groundedResponseSourceDemands(state, livingPeople)) {
    const leaseKey = groundedConversationResponseSourceLeaseKey(
      response.responderId,
      response.openingEventId,
    );
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: leaseKey,
      requirement: 'all',
      leaseKey,
      eventIds: response.eventIds,
    });
  }
  for (const failure of recentTerminalFailureActionDemands(state, livingPeople)) {
    const leaseKey = recentTerminalFailureActionLeaseKey(failure.ownerId);
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: leaseKey,
      requirement: 'all',
      leaseKey,
      eventIds: failure.eventIds,
    });
  }

  let calibrationInstrumentCount = 0;
  let calibrationReferenceStackCount = 0;
  let socialLearningEventIdMembershipCount = 0;
  for (const person of livingPeople) {
    const selectors: CalibrationSelector[] = [];
    const seenStackIds = new Set<string>();
    for (const stack of person.inventory.filter((candidate) => candidate.quantity > 0
      && !candidate.recordPayloadId
      && materialHas(candidate.materialId, 'instrument'))) {
      if (seenStackIds.has(stack.id)) throw new Error(`person ${person.id} 含重复 instrument stack ${stack.id}`);
      seenStackIds.add(stack.id);
      if (selectors.length >= HISTORY_RETENTION_MAX_CALIBRATION_INSTRUMENTS_PER_PERSON
        || calibrationInstrumentCount >= HISTORY_RETENTION_MAX_CALIBRATION_INSTRUMENTS) {
        throw new Error('retention current calibration instrument selectors 超出有界上限');
      }
      const sourceEventIds = canonicalMeasurementSourceEventIds(stack.sourceEventIds);
      if (sourceEventIds.length === 0
        || sourceEventIds.length > HISTORY_RETENTION_MAX_MEASUREMENT_STACK_SOURCE_EVENT_IDS
        || sourceEventIds.length !== stack.sourceEventIds.length) {
        throw new Error(`instrument stack ${person.id}/${stack.id} 的 source event IDs 无效或超界`);
      }
      const leaseKey = personalMassCalibrationLeaseKey(person.id, stack.id);
      const instrument: MeasurementStackReceipt = {
        personId: person.id,
        stackId: stack.id,
        materialId: stack.materialId,
        quantity: 1,
        heldQuantity: stack.quantity,
        sourceEventIds,
      };
      selectors.push({ leaseKey, personId: person.id, instrument });
      calibrationInstrumentCount += 1;
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: `${leaseKey}${CALIBRATION_SOURCE_GROUP_SUFFIX}`,
        requirement: 'all',
        leaseKey,
        eventIds: sourceEventIds,
      });
    }
    if (selectors.length) calibrationSelectorsByPersonId.set(person.id, selectors);
    const references = person.inventory.filter((candidate) => candidate.quantity > 0
      && !candidate.recordPayloadId
      && materialHas(candidate.materialId, 'mass-reference'));
    if (references.length > HISTORY_RETENTION_MAX_CALIBRATION_INSTRUMENTS_PER_PERSON) {
      throw new Error(`person ${person.id} current mass-reference stacks 超出有界上限`);
    }
    for (const stack of references) {
      calibrationReferenceStackCount += 1;
      if (calibrationReferenceStackCount > HISTORY_RETENTION_MAX_CALIBRATION_INSTRUMENTS) {
        throw new Error('retention current mass-reference stack selectors 超出有界上限');
      }
      const sourceEventIds = canonicalMeasurementSourceEventIds(stack.sourceEventIds);
      if (sourceEventIds.length === 0
        || sourceEventIds.length > HISTORY_RETENTION_MAX_MEASUREMENT_STACK_SOURCE_EVENT_IDS
        || sourceEventIds.length !== stack.sourceEventIds.length) {
        throw new Error(`mass-reference stack ${person.id}/${stack.id} 的 source event IDs 无效或超界`);
      }
      const base = `gameplay:current-mass-reference:${encodeURIComponent(person.id)}:${encodeURIComponent(stack.id)}`;
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: `${base}:sources`, requirement: 'all', leaseKey: base, eventIds: sourceEventIds,
      });
    }
    const socialSourceEventIds = boundedLivePersonSocialEventIds(person);
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: livePersonSocialEvidenceGroupKey(person.id),
      requirement: 'index-only',
      leaseKey: livePersonSocialEvidenceLeaseKey(person.id),
      eventIds: socialSourceEventIds,
    });
    const rememberedSourceEventIds = [...new Set(person.memories
      .flatMap((memory) => memory.sourceEventIds))];
    const rememberedDescriptors = liveSocialEvidenceForPersonSources(
      state,
      person,
      rememberedSourceEventIds,
    );
    const electricalStrictEventIds = selectLivePersonSocialStrictEvidenceEventIds(
      person.id,
      rememberedDescriptors,
    )['electrical-remote-work'];
    const measurementCandidateEventIds = measurementUncertaintyRawSourceEventIds(person);
    const measurementStrictEventIds = selectLivePersonSocialStrictEvidenceEventIds(
      person.id,
      [],
      measurementCandidateEventIds,
    )['measurement-uncertainty'];
    for (const [kind, eventIds] of [
      ['electrical-remote-work', electricalStrictEventIds],
      ['measurement-uncertainty', measurementStrictEventIds],
    ] as const) {
      const leaseKey = livePersonSocialStrictEvidenceLeaseKey(person.id, kind);
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: livePersonSocialStrictEvidenceGroupKey(person.id, kind),
        requirement: 'all',
        leaseKey,
        eventIds,
      });
    }
    const socialLearningSourceEventIds = boundedSocialLearningSourceEventIds(person);
    socialLearningEventIdMembershipCount += socialLearningSourceEventIds.length;
    if (socialLearningEventIdMembershipCount
      > HISTORY_RETENTION_MAX_SOCIAL_LEARNING_EVENT_IDS_TOTAL) {
      throw new Error(
        'living social learning source memberships 超出有界总上限 '
        + HISTORY_RETENTION_MAX_SOCIAL_LEARNING_EVENT_IDS_TOTAL,
      );
    }
    const socialLearningLeaseKey = socialLearningSourceLeaseKey(person.id);
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: socialLearningLeaseKey,
      requirement: 'all',
      leaseKey: socialLearningLeaseKey,
      eventIds: socialLearningSourceEventIds,
    });
  }
  const waterObservationIds = new Set((state.world.mechanicalPower?.sources ?? [])
    .map((source) => `observation:water-current:${source.id}`));
  const currentFaultObservationIds = new Set((state.world.mechanicalPower?.networks ?? [])
    .flatMap((network) => network.fault
      ? [`observation:mechanical-power-fault:${network.id}:${network.fault.faultEventId}`] : []));

  for (const network of state.world.mechanicalPower?.networks ?? []) {
    const receipts = validatedMechanicalPowerReliabilityCycleReceipts(network);
    if (network.reliabilityCycleReceipts !== undefined && !receipts) {
      throw new Error(`mechanical network ${network.id} 的 reliability cycle receipts 无效`);
    }
    for (const receipt of receipts ?? []) {
      const base = `mechanical-network:${network.id}:reliability-cycle:${receipt.faultEventId}`;
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: `${base}:evidence`,
        requirement: 'all',
        leaseKey: `${base}:evidence`,
        eventIds: reliabilityReceiptEventIds(receipt),
      });
      const operator = peopleById.get(receipt.operatorId);
      if (!operator || !isLiving(operator)) continue;
      const diagnosisId = `observation:mechanical-power-fault:${network.id}:${receipt.faultEventId}`;
      const diagnosis = operator.knowledge.find((fact) => fact.id === diagnosisId
        && fact.kind === 'observation'
        && fact.confidence >= 55);
      if (diagnosis) addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: `${base}:diagnosis:${operator.id}`,
        requirement: 'all',
        leaseKey: `${base}:diagnosis:${operator.id}`,
        eventIds: diagnosis.sourceEventIds,
      });
    }
  }

  for (const agreement of state.agreements ?? []) {
    if (agreement.status !== 'active' && agreement.status !== 'proposed') continue;
    const leaseKey = liveAgreementHistoryLeaseKey(agreement.id);
    const coreEventIds = boundedCanonicalEventIds([
      agreement.proposalEventId,
      ...(agreement.responseEventId ? [agreement.responseEventId] : []),
    ], `live agreement ${agreement.id} core anchors`);
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: leaseKey,
      requirement: 'all',
      leaseKey,
      eventIds: coreEventIds,
    });
    const coreEventIdSet = new Set(coreEventIds);
    const waterFulfillmentEventIdSet = new Set<string>();
    if (agreement.status === 'active'
      && agreement.proposal.kind === 'assist'
      && agreement.proposal.need === 'water') {
      activeWaterAssistanceAgreementCount += 1;
      if (activeWaterAssistanceAgreementCount
        > HISTORY_RETENTION_MAX_ACTIVE_WATER_ASSISTANCE_AGREEMENTS) {
        throw new Error(
          'retention active water assistance agreements 超出有界上限 '
          + HISTORY_RETENTION_MAX_ACTIVE_WATER_ASSISTANCE_AGREEMENTS,
        );
      }
      const proposal = agreement.proposal;
      if (!agreement.partyIds.includes(proposal.requesterId)
        || !agreement.partyIds.includes(proposal.helperId)) {
        throw new Error(`water assistance agreement ${agreement.id} 参与者与 proposal 不一致`);
      }
      const fulfillmentEventIds = boundedCanonicalEventIdsAtMost(
        agreement.fulfillmentEventIds,
        `water assistance agreement ${agreement.id} fulfillment membership`,
        HISTORY_RETENTION_MAX_WATER_ASSISTANCE_FULFILLMENT_EVENT_IDS,
      );
      for (const eventId of fulfillmentEventIds) waterFulfillmentEventIdSet.add(eventId);
      const helperLeaseKey = waterAssistanceEvidenceLeaseKey(
        agreement.id,
        proposal.requesterId,
        proposal.helperId,
        'helper',
      );
      const requesterLeaseKey = waterAssistanceEvidenceLeaseKey(
        agreement.id,
        proposal.requesterId,
        proposal.helperId,
        'requester',
      );
      const membershipGroupKey = waterAssistanceFulfillmentMembershipGroupKey(
        agreement.id,
        proposal.requesterId,
        proposal.helperId,
      );
      for (const typedLeaseKey of [helperLeaseKey, requesterLeaseKey]) {
        addDemandGroup(demandGroupsByKey, directDemandEventIds, {
          groupKey: membershipGroupKey,
          requirement: 'index-only',
          leaseKey: typedLeaseKey,
          eventIds: fulfillmentEventIds,
          includeEmpty: true,
        });
      }
      const selector: WaterAssistanceSelector = {
        agreementId: agreement.id,
        proposal,
        helperLeaseKey,
        requesterLeaseKey,
        membershipGroupKey,
        fulfillmentEventIds: waterFulfillmentEventIdSet,
      };
      for (const eventId of fulfillmentEventIds) {
        const selectors = waterAssistanceSelectorsByEventId.get(eventId) ?? [];
        selectors.push(selector);
        waterAssistanceSelectorsByEventId.set(eventId, selectors);
      }
    }
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${leaseKey}:supporting-sources`,
      requirement: 'audit-only',
      leaseKey,
      eventIds: boundedCanonicalEventIds(
        agreement.sourceEventIds ?? [],
        `live agreement ${agreement.id} supporting sources`,
      ).filter((eventId) => !coreEventIdSet.has(eventId)
        && !waterFulfillmentEventIdSet.has(eventId)),
    });
  }

  for (const intent of state.intents ?? []) {
    if (intent.status !== 'active' && intent.status !== 'suspended') continue;
    if (!Array.isArray(intent.actionEventIds)
      || intent.actionEventIds.length > MAX_LIVE_INTENT_ACTION_EVENT_IDS) {
      throw new Error(
        `live intent ${intent.id} actionEventIds 超出有界续接上限`
        + ` ${MAX_LIVE_INTENT_ACTION_EVENT_IDS}`,
      );
    }
    const leaseKey = liveIntentHistoryLeaseKey(intent.id);
    const coreEventIds = boundedCanonicalEventIdsAtMost([
      intent.sourceDecisionEventId,
      ...intent.actionEventIds,
    ], `live intent ${intent.id} core anchors`, HISTORY_RETENTION_MAX_LIVE_INTENT_CORE_EVENT_IDS);
    const coreEventIdSet = new Set(coreEventIds);
    const supportingEventIds = boundedCanonicalEventIdsAtMost(
      intent.sourceFactIds ?? [],
      `live intent ${intent.id} supporting sources`,
      HISTORY_RETENTION_MAX_LIVE_INTENT_SUPPORTING_SOURCE_EVENT_IDS,
    ).filter((eventId) => !coreEventIdSet.has(eventId));
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: leaseKey,
      requirement: 'all',
      leaseKey,
      eventIds: coreEventIds,
    });
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${leaseKey}${LIVE_SUPPORTING_SOURCE_GROUP_SUFFIX}`,
      requirement: 'audit-only',
      leaseKey,
      eventIds: supportingEventIds,
    });
  }

  for (const project of state.projects.filter((candidate) => candidate.status === 'active')) {
    addActiveProjectAnchorDemand(demandGroupsByKey, directDemandEventIds, project, 'triggers', project.triggerFactIds);
    addActiveProjectAnchorDemand(demandGroupsByKey, directDemandEventIds, project, 'actions', project.actionEventIds);
    addActiveProjectAnchorDemand(demandGroupsByKey, directDemandEventIds, project, 'completions', project.completionEventIds);
    addActiveProjectAnchorDemand(demandGroupsByKey, directDemandEventIds, project, 'pressure-basis', project.pressureBasis?.sourceFactIds);
    addActiveProjectAnchorDemand(demandGroupsByKey, directDemandEventIds, project, 'inquiry-basis', project.inquiryOpportunityBasis?.sourceFactIds);
    addActiveProjectAnchorDemand(demandGroupsByKey, directDemandEventIds, project, 'mechanical-reliability-basis', project.mechanicalReliabilityBasis?.sourceFactIds);
    addActiveProjectAnchorDemand(demandGroupsByKey, directDemandEventIds, project, 'measurement-uncertainty-basis', project.measurementUncertaintyBasis?.sourceFactIds);
    addActiveProjectAnchorDemand(demandGroupsByKey, directDemandEventIds, project, 'remote-work-power-basis', project.remoteWorkPowerBasis?.sourceFactIds);
    addActiveProjectAnchorDemand(demandGroupsByKey, directDemandEventIds, project, 'electrical-maintenance-basis', project.electricalPowerMaintenanceBasis?.sourceFactIds);
  }

  const livingPersonIds = new Set(livingPeople.map((person) => person.id));
  const completedLiveProjects = state.projects.filter((project) => (
    project.status === 'completed'
    && (livingPersonIds.has(project.ownerId)
      || project.beneficiaryIds.some((personId) => livingPersonIds.has(personId))
      || project.contributorIds.some((personId) => livingPersonIds.has(personId)))
  ));
  if (completedLiveProjects.length > HISTORY_RETENTION_MAX_COMPLETED_LIVE_PROJECTS) {
    throw new Error(
      `retention completed projects touching living people 超出`
      + ` ${HISTORY_RETENTION_MAX_COMPLETED_LIVE_PROJECTS} 项上限`,
    );
  }
  const completedProjectIds = new Set<string>();
  const completionEventIdsByProject = new Map<SimulationState['projects'][number], string[]>();
  for (const project of completedLiveProjects) {
    if (completedProjectIds.has(project.id)) {
      throw new Error(`retention completed live project ID 重复：${project.id}`);
    }
    completedProjectIds.add(project.id);
    const eventIds = boundedCompletedProjectSourceEventIds(
      project.completionEventIds,
      `completed project ${project.id} completion events`,
    );
    completionEventIdsByProject.set(project, eventIds);
    // The newest strict measurement receipt already has an exact all-of group
    // below. Reuse that source lease instead of duplicating every event into a
    // second group; generic worldEventById still resolves its retained pins.
    if (project === completedMeasurementProject) continue;
    const leaseKey = completedLiveProjectCompletionLeaseKey(project.id);
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: leaseKey,
      requirement: 'all',
      leaseKey,
      eventIds,
    });
  }

  // `latestSharedProjectBetween` is the gameplay authority for project
  // insertion ordering. Only when its exact result is completed do we add this
  // completed-project bridge; active projects are already covered above. The
  // conversation reader resolves, sorts, and takes the last four from the full
  // action+completion ID union. Retaining the exact bounded action membership,
  // together with the completion all-of group, preserves that result without
  // guessing which unresolved IDs might exist in cold history.
  for (const pair of livingSharedProjectPairs(state, livingPersonIds)) {
    const project = latestSharedProjectBetween(
      state,
      pair.firstPersonId,
      pair.secondPersonId,
    );
    if (!project || project.status !== 'completed') continue;
    const completionIds = new Set(completionEventIdsByProject.get(project)
      ?? boundedCompletedProjectSourceEventIds(
        project.completionEventIds,
        `completed shared project ${project.id} completion events`,
      ));
    const actionEventIds = boundedCompletedProjectSourceEventIds(
      project.actionEventIds,
      `completed shared project ${project.id} action events`,
    ).filter((eventId) => !completionIds.has(eventId));
    const leaseKey = livingSharedProjectActionLeaseKey(
      pair.firstPersonId,
      pair.secondPersonId,
      project.id,
    );
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: leaseKey,
      requirement: 'all',
      leaseKey,
      eventIds: actionEventIds,
    });
  }

  for (const prediction of (state.eraPredictions ?? []).filter((candidate) => candidate.status === 'pending')) {
    if (prediction.sourceEventIds.length === 0) {
      throw new Error(`pending era prediction ${prediction.id} 缺少可追溯来源事实`);
    }
    pendingEraPredictionIds.add(prediction.id);
    const base = `pending-era-prediction:${prediction.id}`;
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${base}:source`, requirement: 'all',
      leaseKey: pendingEraPredictionWakeLeaseKey(prediction.id),
      eventIds: prediction.sourceEventIds,
    });
  }

  const agreementsById = new Map<string, SimulationState['agreements'][number]>();
  for (const agreement of state.agreements ?? []) {
    if (agreementsById.has(agreement.id)) {
      throw new Error(`reproduction retention shell 含重复 agreement ID ${agreement.id}`);
    }
    agreementsById.set(agreement.id, agreement);
  }
  for (const intent of (state.intents ?? []).filter(isReproductionIntent)) {
    const agreement = intent.agreementId ? agreementsById.get(intent.agreementId) : undefined;
    if (intent.agreementId && !agreement) {
      throw new Error(`reproduction intent ${intent.id} 缺少 agreement ${intent.agreementId}`);
    }
    const attemptWindow = boundedReproductionAttemptEventIds(intent, agreement);
    const femaleId = intent.goal.kind === 'condition'
      && intent.goal.condition === 'pregnancy'
      && intent.goal.present
      ? intent.goal.personId
      : null;
    reproductionFactsByIntentId.set(intent.id, {
      intentId: intent.id,
      ownerId: intent.ownerId,
      createdAtMonth: intent.createdAtMonth,
      femaleId,
      ...attemptWindow,
      resolvedAttemptEventIds: new Set(),
      attemptMonths: new Set(),
      resolvedAttemptMonthsByEventId: new Map(),
    });
    const base = `active-reproduction-intent:${intent.id}`;
    // The exact shell already carries the agreement's attempt-ID set and the
    // selector fingerprint binds it. Pin only the originating decision plus
    // the latest matching attempt/conception bodies needed by reverse-find;
    // copying every historical attempt would reintroduce event-count growth.
    const anchorIds = [intent.sourceDecisionEventId];
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${base}:facts`, requirement: 'all',
      leaseKey: reproductionAttemptLeaseKey(intent.id), eventIds: anchorIds,
    });
    if (femaleId) addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${base}:facts`, requirement: 'all',
      leaseKey: reproductionConceptionLeaseKey(intent.id), eventIds: anchorIds,
    });
  }

  for (const person of livingPeople) {
    for (const fact of person.knowledge) {
      if (fact.confidence < 55) continue;
      const mechanical = (fact.kind === 'technique' && fact.id === MECHANICAL_POWER_OPERATION_TECHNIQUE_ID)
        || (fact.kind === 'observation' && (waterObservationIds.has(fact.id) || currentFaultObservationIds.has(fact.id)));
      if (!mechanical) continue;
      const groupKey = `mechanical-knowledge:${person.id}:${fact.id}`;
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey, requirement: 'all', leaseKey: groupKey, eventIds: fact.sourceEventIds,
      });
    }
  }

  const electricalNetworks = state.world.electricalPower?.networks ?? [];
  if (electricalNetworks.length > HISTORY_RETENTION_MAX_ELECTRICAL_NETWORKS) {
    throw new Error(
      `retention electrical networks 超出 ${HISTORY_RETENTION_MAX_ELECTRICAL_NETWORKS} 项上限`,
    );
  }

  const currentElectricalFaultNetworkIdByKnowledgeId = new Map<string, string>();
  const electricalNetworkIds = new Set<string>();
  for (const network of electricalNetworks) {
    if (electricalNetworkIds.has(network.id)) {
      throw new Error(`retention electrical network ID 重复：${network.id}`);
    }
    electricalNetworkIds.add(network.id);

    const recentOperationEventIds = [...new Set(network.recentOperationEventIds ?? [])].slice(-2);
    if (recentOperationEventIds.length === 2) {
      const leaseKey = modernElectricalOperationLeaseKey(network.id);
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: leaseKey,
        requirement: 'all',
        leaseKey,
        eventIds: boundedElectricalFactEventIds(
          recentOperationEventIds,
          `electrical network ${network.id} modern operation receipts`,
          2,
        ),
      });
    }

    if (network.fault) {
      const leaseKey = currentElectricalNetworkFaultLeaseKey(network.id);
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: leaseKey,
        requirement: 'all',
        leaseKey,
        eventIds: boundedElectricalFactEventIds(
          [network.fault.faultEventId, ...network.fault.sourceEventIds],
          `electrical network ${network.id} current fault`,
          ELECTRICAL_POWER_SOURCE_EVENT_LIMIT + 1,
        ),
      });
      currentElectricalFaultNetworkIdByKnowledgeId.set(
        electricalPowerFaultObservationFactId(network.id, network.fault.faultEventId),
        network.id,
      );
    }

    // Useful service after restoration resolves exactly the first planned
    // conductor, matching the domain reader rather than retaining every old
    // repair ever performed on the network.
    const currentConductor = network.components.find((component) => component.role === 'conductor'
      && network.plan.conductorPositions.some((position) => sameElectricalPosition(
        component.position,
        position,
      )));
    if (currentConductor?.latestRepairEventId) {
      const leaseKey = currentElectricalNetworkRepairLeaseKey(network.id);
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: leaseKey,
        requirement: 'all',
        leaseKey,
        eventIds: boundedElectricalFactEventIds(
          [
            currentConductor.latestRepairEventId,
            ...(currentConductor.latestRepairSourceEventIds ?? []).slice(
              -ELECTRICAL_POWER_SOURCE_EVENT_LIMIT,
            ),
          ],
          `electrical network ${network.id} current repair`,
          ELECTRICAL_POWER_SOURCE_EVENT_LIMIT + 1,
        ),
      });
    }
  }

  const conductorRule = inventoryCombinationForOutput(Material.CopperConductor);
  const conductorTechniqueId = conductorRule ? inventoryCombinationTechniqueId(conductorRule) : null;
  if (electricalNetworks.length > 0) {
    for (const person of livingPeople) {
      const operationKnowledge = person.knowledge.find((fact) => fact.kind === 'technique'
        && fact.id === ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID
        && fact.confidence >= 55);
      if (operationKnowledge) {
        const leaseKey = livingPersonElectricalOperationKnowledgeLeaseKey(person.id);
        addDemandGroup(demandGroupsByKey, directDemandEventIds, {
          groupKey: leaseKey,
          requirement: 'all',
          leaseKey,
          eventIds: boundedElectricalFactEventIds(
            operationKnowledge.sourceEventIds,
            `living electrical operator ${person.id} operation knowledge`,
          ),
        });
      }

      // The electrical source check resolves exactly the first reliable
      // mechanical-operation fact, matching the domain reader's `find`.
      const mechanicalServiceKnowledge = person.knowledge.find((fact) => fact.kind === 'technique'
        && fact.id === MECHANICAL_POWER_OPERATION_TECHNIQUE_ID
        && fact.confidence >= 55);
      if (mechanicalServiceKnowledge) {
        const leaseKey = livingPersonElectricalMechanicalServiceLeaseKey(person.id);
        addDemandGroup(demandGroupsByKey, directDemandEventIds, {
          groupKey: leaseKey,
          requirement: 'all',
          leaseKey,
          eventIds: boundedElectricalFactEventIds(
            mechanicalServiceKnowledge.sourceEventIds,
            `living electrical operator ${person.id} mechanical service knowledge`,
          ),
        });
      }

      // Maintenance compiles a conductor only from this person's own reliable
      // blind-response + verification sources. Mirror the reader's last-24
      // source window; the project or observer stage never creates this lease.
      const componentKnowledge = conductorTechniqueId
        ? person.knowledge.find((fact) => fact.kind === 'technique'
          && fact.id === conductorTechniqueId
          && fact.confidence >= 55)
        : undefined;
      if (componentKnowledge && conductorTechniqueId) {
        const leaseKey = livingPersonElectricalComponentTechniqueLeaseKey(
          person.id,
          conductorTechniqueId,
        );
        addDemandGroup(demandGroupsByKey, directDemandEventIds, {
          groupKey: leaseKey,
          requirement: 'all',
          leaseKey,
          eventIds: boundedElectricalFactEventIds(
            componentKnowledge.sourceEventIds.slice(-ELECTRICAL_POWER_SOURCE_EVENT_LIMIT),
            `living electrical maintainer ${person.id} component technique ${conductorTechniqueId}`,
          ),
        });
      }

      const selectedFaultKnowledgeIds = new Set<string>();
      for (const fact of person.knowledge) {
        const networkId = currentElectricalFaultNetworkIdByKnowledgeId.get(fact.id);
        if (!networkId
          || selectedFaultKnowledgeIds.has(fact.id)
          || fact.kind !== 'observation'
          || fact.confidence < 55) continue;
        selectedFaultKnowledgeIds.add(fact.id);
        const leaseKey = livingPersonElectricalFaultObservationLeaseKey(person.id, networkId);
        addDemandGroup(demandGroupsByKey, directDemandEventIds, {
          groupKey: leaseKey,
          requirement: 'all',
          leaseKey,
          eventIds: boundedElectricalFactEventIds(
            fact.sourceEventIds.slice(-ELECTRICAL_POWER_RECENT_EVENT_LIMIT),
            `living electrical maintainer ${person.id} current fault observation ${fact.id}`,
            ELECTRICAL_POWER_RECENT_EVENT_LIMIT,
          ),
        });
      }

      const seenLoadTechniqueIds = new Set<string>();
      for (const fact of person.knowledge.filter((candidate) => candidate.kind === 'technique'
        && candidate.id.startsWith(`${ELECTRICAL_POWER_LOAD_TECHNIQUE_PREFIX}:`)
        && candidate.confidence >= 55)) {
        if (seenLoadTechniqueIds.has(fact.id)) {
          throw new Error(`living electrical operator ${person.id} 含重复 load technique ${fact.id}`);
        }
        seenLoadTechniqueIds.add(fact.id);
        const leaseKey = livingPersonElectricalLoadTechniqueKnowledgeLeaseKey(person.id, fact.id);
        addDemandGroup(demandGroupsByKey, directDemandEventIds, {
          groupKey: leaseKey,
          requirement: 'all',
          leaseKey,
          eventIds: boundedElectricalFactEventIds(
            fact.sourceEventIds,
            `living electrical operator ${person.id} load technique ${fact.id}`,
          ),
        });
      }
    }
  }

  for (const project of state.projects.filter((candidate) => candidate.status === 'active'
    && candidate.desiredFunction === 'restore-electrical-power-delivery')) {
    const basis = project.electricalPowerMaintenanceBasis;
    if (!basis
      || basis.version !== 'electrical-power-maintenance-basis-v1'
      || basis.sourceFactIds.length !== 2
      || basis.sourceFactIds[0] !== basis.faultEventId
      || basis.sourceFactIds[1] !== basis.diagnosisEventId) {
      throw new Error(`active electrical maintenance project ${project.id} 缺少可回放的故障诊断依据`);
    }
    const basisLeaseKey = activeElectricalMaintenanceProjectLeaseKey(project.id);
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: basisLeaseKey,
      requirement: 'all',
      leaseKey: basisLeaseKey,
      eventIds: boundedElectricalFactEventIds(
        basis.sourceFactIds,
        `active electrical maintenance project ${project.id} basis`,
        2,
      ),
    });

    // The application reader intentionally sees only the newest 16 project
    // actions. Keep the same source-bound window (including any intervening
    // approach action) so manufacture -> verification -> repair remains exact.
    const replacementLeaseKey = activeElectricalMaintenanceReplacementLeaseKey(project.id);
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: replacementLeaseKey,
      requirement: 'all',
      leaseKey: replacementLeaseKey,
      eventIds: boundedCanonicalEventIds(
        project.actionEventIds.slice(-HISTORY_RETENTION_MAX_ELECTRICAL_MAINTENANCE_PROJECT_EVENT_IDS),
        `active electrical maintenance project ${project.id} replacement actions`,
      ),
    });
  }

  for (const project of state.projects.filter(isMechanicalProject)) {
    const owner = peopleById.get(project.ownerId);
    if (!owner || !isLiving(owner)) continue;
    const base = `active-mechanical-project:${project.id}`;
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${base}:triggers`, requirement: 'all', leaseKey: `${base}:trigger`, eventIds: project.triggerFactIds,
    });
    if (!Array.isArray(project.actionEventIds)
      || project.actionEventIds.length > HISTORY_RETENTION_MAX_ACTIVE_PROJECT_ACTION_EVENT_IDS) {
      throw new Error(
        `active mechanical project ${project.id} actionEventIds 超出有界续接上限`
        + ` ${HISTORY_RETENTION_MAX_ACTIVE_PROJECT_ACTION_EVENT_IDS}`,
      );
    }
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${base}:actions`, requirement: 'all', leaseKey: `${base}:action`, eventIds: project.actionEventIds,
    });
    if ((project.desiredFunction === 'restore-water-powered-crop-processing'
      || project.desiredFunction === 'durable-power-transmission')
      && project.mechanicalPowerFaultEventId !== undefined) {
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: `${base}:maintenance-fault`, requirement: 'all', leaseKey: `${base}:maintenance-fault`,
        eventIds: [project.mechanicalPowerFaultEventId],
      });
    }
    if (project.desiredFunction === 'durable-power-transmission') {
      const reliability = project.mechanicalReliabilityBasis;
      if (!reliability || reliability.version !== 'mechanical-reliability-basis-v1') {
        throw new Error(`active reliability project ${project.id} 缺少可续接的机械可靠性依据`);
      }
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: `${base}:reliability-basis`,
        requirement: 'all',
        leaseKey: `${base}:reliability-basis`,
        eventIds: reliability.sourceFactIds,
      });
    }
    const reservedStackIds = new Set(project.reservations.map((reservation) => reservation.stackId));
    for (const stack of owner.inventory.filter((candidate) => reservedStackIds.has(candidate.id))) {
      const groupKey = `${base}:reservation:${stack.id}`;
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey, requirement: 'audit-only', leaseKey: `${base}:reserved-inventory:${owner.id}:${stack.id}`,
        eventIds: stack.sourceEventIds,
      });
    }
  }

  for (const project of state.projects.filter(isMeasurementProject)) {
    const owner = peopleById.get(project.ownerId);
    if (!owner || !isLiving(owner)) continue;
    const basis = project.measurementUncertaintyBasis;
    if (!basis || basis.version !== 'measurement-uncertainty-basis-v1') {
      throw new Error(`active measurement project ${project.id} 缺少可续接的个人不确定性依据`);
    }
    if (!Array.isArray(project.actionEventIds)
      || project.actionEventIds.length > HISTORY_RETENTION_MAX_ACTIVE_PROJECT_ACTION_EVENT_IDS) {
      throw new Error(
        `active measurement project ${project.id} actionEventIds 超出有界续接上限`
        + ` ${HISTORY_RETENTION_MAX_ACTIVE_PROJECT_ACTION_EVENT_IDS}`,
      );
    }
    const base = `active-measurement-project:${project.id}`;
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${base}:triggers`, requirement: 'all', leaseKey: `${base}:trigger`,
      eventIds: project.triggerFactIds,
    });
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${base}:uncertainty-basis`, requirement: 'all', leaseKey: `${base}:uncertainty-basis`,
      eventIds: basis.sourceFactIds,
    });
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${base}:actions`, requirement: 'all', leaseKey: `${base}:action`,
      eventIds: project.actionEventIds,
    });
    const basisStackIds = new Set(basis.samples.map((sample) => sample.stackId));
    for (const stack of owner.inventory.filter((candidate) => basisStackIds.has(candidate.id)
      || candidate.materialId === Material.BeamBalance
      || candidate.materialId === Material.StandardWeight)) {
      addDemandGroup(demandGroupsByKey, directDemandEventIds, {
        groupKey: `${base}:entity:${stack.id}`,
        requirement: 'all',
        leaseKey: `${base}:entity:${owner.id}:${stack.id}`,
        eventIds: stack.sourceEventIds,
      });
    }
  }

  // One strict project completion already freezes the full manufacture ->
  // calibration -> measurement source chain. Retain the newest such proof as
  // a bounded society-level observer witness after its project leaves active
  // state; planning never reads this server-only lease.
  if (completedMeasurementProject) {
    const leaseKey = modernCompletedMeasurementReceiptLeaseKey(completedMeasurementProject.id);
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: leaseKey, requirement: 'all', leaseKey,
      eventIds: completedMeasurementProject.completionEventIds,
    });
  }

  for (const network of state.world.mechanicalPower?.networks ?? []) {
    const base = `mechanical-network:${network.id}`;
    if (network.fault) addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${base}:current-fault`, requirement: 'all', leaseKey: `${base}:current-fault`,
      eventIds: [network.fault.faultEventId, ...network.fault.sourceEventIds],
    });
    addDemandGroup(demandGroupsByKey, directDemandEventIds, {
      groupKey: `${base}:service-cycle-operations`,
      requirement: 'all',
      leaseKey: `${base}:service-cycle-operation`,
      eventIds: network.serviceCycleOperationEventIds ?? [],
    });
  }
  return {
    directDemandEventIds,
    demandGroupsByKey,
    millLaborPersonIds,
    pendingEraPredictionIds,
    livingChildIds,
    reproductionFactsByIntentId,
    calibrationSelectorsByPersonId,
    waterAssistanceSelectorsByEventId,
    productionWindowMonth,
  };
}

/** Test/benchmark observability only; never serialized into authority. */
export function resetHistoryRetentionDemandCollectionCountForTests(): void {
  historyRetentionDemandCollectionCount = 0;
}

/** Test/benchmark observability only; never serialized into authority. */
export function historyRetentionDemandCollectionStatsForTests(): Readonly<{
  collections: number;
}> {
  return Object.freeze({ collections: historyRetentionDemandCollectionCount });
}

function continuationDemandFromCollected(
  demand: ReturnType<typeof collectDemand>,
): HistoryRetentionContinuationDemand {
  const continuationDemand: HistoryRetentionContinuationDemand = {
    groups: [...demand.demandGroupsByKey.values()]
    .sort((left, right) => left.groupKey.localeCompare(right.groupKey))
    .map((group) => ({
      groupKey: group.groupKey,
      requirement: group.requirement,
      leaseKeys: [...group.leaseKeys].sort(),
      eventIds: [...group.eventIds].sort(),
    })),
    millLaborPersonIds: [...demand.millLaborPersonIds].sort(),
    pendingEraPredictionIds: [...demand.pendingEraPredictionIds].sort(),
    livingChildIds: [...demand.livingChildIds].sort(),
    reproductionFacts: [...demand.reproductionFactsByIntentId.values()]
      .sort((left, right) => left.intentId.localeCompare(right.intentId))
      .map((item) => ({
        intentId: item.intentId,
        ownerId: item.ownerId,
        createdAtMonth: item.createdAtMonth,
        femaleId: item.femaleId,
        agreementId: item.agreementId,
        acceptedAtMonth: item.acceptedAtMonth,
        dueAtMonth: item.dueAtMonth,
        lastAttemptAtMonth: item.lastAttemptAtMonth,
        attemptEventIds: [...item.attemptEventIds].sort(),
      })),
  };
  assertProjectPressureHistoryRetentionDemandGroups(
    continuationDemand.groups,
    'retention collected demand',
  );
  waterAssistanceSelectiveLeaseKeysFromDemandGroups(continuationDemand.groups);
  return continuationDemand;
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
function compatibilityCanonicalDemandGroups(
  groups: readonly Pick<HistoryRetentionContinuationDemandGroup, 'groupKey' | 'requirement' | 'leaseKeys' | 'eventIds'>[],
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

function liveSupportingSourceCoreGroupKey(groupKey: string): string | null {
  if ((!groupKey.startsWith('live-agreement:') && !groupKey.startsWith('live-intent:'))
    || !groupKey.endsWith(LIVE_SUPPORTING_SOURCE_GROUP_SUFFIX)) return null;
  const coreKey = groupKey.slice(0, -LIVE_SUPPORTING_SOURCE_GROUP_SUFFIX.length);
  return coreKey.endsWith(':anchors') ? coreKey : null;
}

export function assertLiveIntentHistoryRetentionDemandGroups(
  groups: readonly Pick<HistoryRetentionContinuationDemandGroup, 'groupKey' | 'requirement' | 'leaseKeys' | 'eventIds'>[],
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

function assertLiveIntentRawSplitMatchesCanonicalDemand(
  projectedGroups: readonly Pick<HistoryRetentionContinuationDemandGroup, 'groupKey' | 'requirement' | 'leaseKeys' | 'eventIds'>[],
  canonicalGroups: readonly Pick<HistoryRetentionContinuationDemandGroup, 'groupKey' | 'requirement' | 'leaseKeys' | 'eventIds'>[],
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

function demandFingerprint(demand: ReturnType<typeof collectDemand>): string {
  return historyRetentionDemandFingerprint(continuationDemandFromCollected(demand));
}

function deepFreezeDemandSnapshotValue<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeDemandSnapshotValue(child);
  }
  return Object.freeze(value);
}

function sameHistoryRetentionSeal(
  left: Readonly<HistoryRetentionSeal>,
  right: Readonly<HistoryRetentionSeal>,
): boolean {
  return left.eventCount === right.eventCount && left.tailEventId === right.tailEventId;
}

function historyRetentionDemandSnapshotRecord(
  snapshot: HistoryRetentionDemandSnapshot,
  finalShell: SimulationState,
): HistoryRetentionDemandSnapshotRecord {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('retention demand snapshot 缺少 process-local provenance');
  }
  const record = historyRetentionDemandSnapshots.get(snapshot);
  if (!record || record.finalShell !== finalShell) {
    throw new Error('retention demand snapshot 不属于指定的 store-owned shell');
  }
  if (!sameHistoryRetentionSeal(record.target, shellHistorySeal(finalShell))) {
    throw new Error('retention demand snapshot 的 history seal 已漂移');
  }
  return record;
}

/**
 * Collect one canonical demand for an exclusively owned publication shell.
 * The caller must keep the shell private and unchanged until every successor
 * assertion using this receipt has completed.
 */
export function prepareHistoryRetentionDemandSnapshot(
  finalShell: SimulationState,
): Readonly<HistoryRetentionDemandSnapshot> {
  const demand = collectDemand(finalShell);
  const continuationDemand = deepFreezeDemandSnapshotValue(
    continuationDemandFromCollected(demand),
  );
  const receipt = Object.freeze({
    kind: 'history-retention-demand-snapshot-v1' as const,
  }) as Readonly<HistoryRetentionDemandSnapshot>;
  historyRetentionDemandSnapshots.set(receipt, {
    finalShell,
    target: Object.freeze({ ...shellHistorySeal(finalShell) }),
    demand,
    continuationDemand,
    fingerprint: historyRetentionDemandFingerprint(continuationDemand),
    consumed: false,
  });
  return receipt;
}

function consumeHistoryRetentionDemandSnapshot(
  finalShell: SimulationState,
  snapshot: HistoryRetentionDemandSnapshot,
): HistoryRetentionDemandSnapshotRecord {
  const record = historyRetentionDemandSnapshotRecord(snapshot, finalShell);
  if (record.consumed) throw new Error('retention demand snapshot 已被 projection fold 消费');
  record.consumed = true;
  return record;
}

function assertHistoryRetentionProjectionMatchesCanonicalDemand(
  projection: HistoryRetentionProjectionResult,
  demand: Readonly<HistoryRetentionContinuationDemand>,
  fingerprint: string,
): void {
  if (projection.demandFingerprint !== fingerprint
    || !sameStringSet(projection.millLaborPersonIds, demand.millLaborPersonIds)) {
    throw new Error('retention projection demand 与 bounded state 当前 shell 不一致');
  }
  assertProjectPressureHistoryRetentionDemandGroups(
    projection.demandGroups,
    'retention projection raw demand',
    { allowLegacyMissing: true },
  );
  assertProjectPressureHistoryRetentionDemandGroups(
    demand.groups,
    'retention shell raw demand',
  );
  assertProjectPressureStorageRefinementMatches(projection.demandGroups, demand.groups);
  assertFutureSocialRepetitionStorageRefinementMatches(
    projection.demandGroups,
    demand.groups,
  );
  assertWaterAssistanceStorageRefinementMatches(projection.demandGroups, demand.groups);
  assertLivePersonSocialStorageRefinementMatches(
    projection.demandGroups,
    demand.groups,
  );
  assertLiveIntentRawSplitMatchesCanonicalDemand(projection.demandGroups, demand.groups);
  const projectedGroups = new Map(compatibilityCanonicalDemandGroups(projection.demandGroups)
    .map((group) => [group.groupKey, group]));
  const canonicalDemandGroups = compatibilityCanonicalDemandGroups(demand.groups);
  if (projectedGroups.size !== canonicalDemandGroups.length) {
    throw new Error('retention projection demand group 与 bounded state 当前 shell 不一致');
  }
  for (const group of canonicalDemandGroups) {
    const projected = projectedGroups.get(group.groupKey);
    if (!projected
      || projected.requirement !== group.requirement
      || !sameStringSet(projected.leaseKeys, group.leaseKeys)
      || !sameStringSet(projected.eventIds, group.eventIds)) {
      throw new Error(`retention projection demand group ${group.groupKey} 与 bounded state 当前 shell 不一致`);
    }
  }
}

/** Recheck a projection against the immutable canonical demand, without a shell rescan. */
export function assertHistoryRetentionProjectionMatchesDemandSnapshot(
  finalShell: SimulationState,
  projection: HistoryRetentionProjectionResult,
  snapshot: HistoryRetentionDemandSnapshot,
): void {
  const record = historyRetentionDemandSnapshotRecord(snapshot, finalShell);
  assertHistoryRetentionProjectionMatchesCanonicalDemand(
    projection,
    record.continuationDemand,
    record.fingerprint,
  );
}

export function historyRetentionDemandFingerprintForShell(finalShell: SimulationState): string {
  return demandFingerprint(collectDemand(finalShell));
}

export function assertHistoryRetentionProjectionMatchesShell(
  finalShell: SimulationState,
  projection: HistoryRetentionProjectionResult,
): void {
  const snapshot = prepareHistoryRetentionDemandSnapshot(finalShell);
  assertHistoryRetentionProjectionMatchesDemandSnapshot(finalShell, projection, snapshot);
}

function assertHistoryRetentionAuthority(authority: HistoryRetentionAuthority, context: string): void {
  if (!authority || !/^[a-f0-9]{64}$/u.test(authority.stateHash)) {
    throw new Error(`${context}必须绑定有效的权威 stateHash`);
  }
}

function createOpenHistoryRetentionFold(
  finalShell: SimulationState,
  authority: HistoryRetentionAuthority,
  demand: ReturnType<typeof collectDemand>,
  preparedDemandFingerprint?: string,
): HistoryRetentionProjectionFold {
  const reproductionIntentIdsByOwnerId = new Map<string, Set<string>>();
  const reproductionIntentIdsByFemaleId = new Map<string, Set<string>>();
  const reproductionIntentIdsByAttemptEventId = new Map<string, Set<string>>();
  for (const item of demand.reproductionFactsByIntentId.values()) {
    const owned = reproductionIntentIdsByOwnerId.get(item.ownerId) ?? new Set<string>();
    owned.add(item.intentId);
    reproductionIntentIdsByOwnerId.set(item.ownerId, owned);
    if (item.femaleId) {
      const conceived = reproductionIntentIdsByFemaleId.get(item.femaleId) ?? new Set<string>();
      conceived.add(item.intentId);
      reproductionIntentIdsByFemaleId.set(item.femaleId, conceived);
    }
    for (const eventId of item.attemptEventIds) {
      const intents = reproductionIntentIdsByAttemptEventId.get(eventId) ?? new Set<string>();
      intents.add(item.intentId);
      reproductionIntentIdsByAttemptEventId.set(eventId, intents);
    }
  }
  return {
    status: 'open', authority: { stateHash: authority.stateHash }, target: shellHistorySeal(finalShell),
    demandFingerprint: preparedDemandFingerprint ?? demandFingerprint(demand),
    directDemandEventIds: demand.directDemandEventIds,
    demandGroupsByKey: demand.demandGroupsByKey, millLaborPersonIds: demand.millLaborPersonIds,
    directMatchesByEventId: new Map(), millLaborRingsByPersonId: new Map(),
    pendingMechanicalTeachingByAudienceId: new Map(), witnessedMechanicalAudienceIds: new Set(),
    pendingEraPredictionIds: demand.pendingEraPredictionIds,
    livingChildIds: demand.livingChildIds,
    reproductionFactsByIntentId: demand.reproductionFactsByIntentId,
    reproductionIntentIdsByOwnerId,
    reproductionIntentIdsByFemaleId,
    reproductionIntentIdsByAttemptEventId,
    selectiveMatchesByLeaseKey: new Map(),
    productionSelectorLeaseKeyByPersonId: new Map(),
    calibrationSelectorsByPersonId: demand.calibrationSelectorsByPersonId,
    waterAssistanceSelectorsByEventId: demand.waterAssistanceSelectorsByEventId,
    waterAssistanceSelectiveLeaseKeys: new Set(
      [...demand.waterAssistanceSelectorsByEventId.values()]
        .flatMap((selectors) => selectors.flatMap((selector) => [
          selector.helperLeaseKey,
          selector.requesterLeaseKey,
        ])),
    ),
    waterAssistanceValidationState: finalShell,
    modernRecordValidationState: finalShell,
    productionWindowMonth: demand.productionWindowMonth,
    livingChildBirthMatchesByChildId: new Map(),
    requiredSuffixDirectDemandEventIds: new Set(),
    requiredSuffixReproductionAnchorEventIds: new Set(),
    newLivingPersonIdsRequiringBirth: new Set(),
    newPendingEraPredictionIdsRequiringCreation: new Set(),
    pendingEraPredictionCreationMatchesById: new Map(),
    summary: {
      schemaVersion: 1, reducedThrough: { eventCount: 0, tailEventId: null },
      ruleDecisions: 0, modelDecisions: 0, mechanicalTeachingOperationAchieved: false,
      mechanicalP0: { ...EMPTY_MECHANICAL_COUNTS },
    },
  };
}

export function beginHistoryRetentionProjection(
  finalShell: SimulationState,
  authority: HistoryRetentionAuthority,
): HistoryRetentionProjectionFold {
  assertHistoryRetentionAuthority(authority, 'retention projection ');
  const demand = collectDemand(finalShell);
  return createOpenHistoryRetentionFold(finalShell, authority, demand);
}

function isCompletedMillLabor(event: WorldEvent): event is ActionFact {
  return event.kind === 'action' && event.status === 'completed' && event.action.kind === 'act'
    && event.action.operation === 'separate' && Number(event.diff.sourceMaterialId) === Material.CropMature
    && Number(event.diff.facilityMaterialId) === Material.Mill;
}

function explicitMechanicalTeachingAudienceIds(event: WorldEvent): string[] | null {
  if (event.kind !== 'action' || event.status !== 'completed' || event.action.kind !== 'communicate'
    || event.action.content.kind !== 'claim' || event.action.content.factId !== MECHANICAL_POWER_OPERATION_TECHNIQUE_ID
    || event.diff.explicitTeaching !== true || event.diff.teachingFactId !== MECHANICAL_POWER_OPERATION_TECHNIQUE_ID
    || !Array.isArray(event.diff.taughtAudienceIds)) return null;
  return [...new Set(event.diff.taughtAudienceIds
    .filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

function countMechanicalEvent(counts: MechanicalP0HistoryCounts, event: WorldEvent): void {
  if (isCompletedMillLabor(event)) counts.millLaborActions += 1;
  if (event.kind !== 'action') return;
  if (event.diff.mechanicalPowerObservation === true) counts.waterCurrentObservations += 1;
  if (event.diff.mechanicalPowerInstallation === true) counts.componentInstallations += 1;
  if (event.diff.mechanicalPowerOperation === true) {
    counts.loadedOperations += 1;
    if (event.diff.mode === 'operate-service') counts.serviceOperations += 1;
  }
  if (event.diff.mechanicalPowerFault === true) {
    counts.faultEvents += 1;
    if (event.diff.faultKind === 'commissioning-misalignment') counts.commissioningFaults += 1;
    if (event.diff.faultKind === 'worn-drive-shaft') counts.wornDriveShaftFaults += 1;
  }
  if (event.diff.mechanicalPowerFaultDiagnosis === true) counts.faultDiagnoses += 1;
  if (event.diff.mechanicalPowerRepair === true) counts.repairs += 1;
  if (event.diff.mechanicalPowerRecovery === true) counts.recoveryOperations += 1;
}

function appendSelectiveMatch(
  fold: HistoryRetentionProjectionFold,
  leaseKey: string,
  match: DirectPinMatch,
): void {
  const matches = fold.selectiveMatchesByLeaseKey.get(leaseKey) ?? [];
  if (matches.length >= HISTORY_RETENTION_MAX_PENDING_PREDICTION_WAKE_MATCHES) {
    throw new Error(
      `retention selective all-match ${leaseKey} 超出有界上限`
      + ` ${HISTORY_RETENTION_MAX_PENDING_PREDICTION_WAKE_MATCHES}`,
    );
  }
  // A verified stream visits each absolute ordinal exactly once. Direct append
  // preserves all-match semantics without an O(k) duplicate scan per wake.
  matches.push(match);
  fold.selectiveMatchesByLeaseKey.set(leaseKey, matches);
}

function setLatestSelectiveMatch(
  fold: HistoryRetentionProjectionFold,
  leaseKey: string,
  match: DirectPinMatch,
): void {
  const current = fold.selectiveMatchesByLeaseKey.get(leaseKey)?.at(-1);
  if (!current || match.absoluteIndex >= current.absoluteIndex) {
    fold.selectiveMatchesByLeaseKey.set(leaseKey, [match]);
  }
}

function setFirstSelectiveMatch(
  fold: HistoryRetentionProjectionFold,
  leaseKey: string,
  match: DirectPinMatch,
): void {
  if (!fold.selectiveMatchesByLeaseKey.has(leaseKey)) {
    fold.selectiveMatchesByLeaseKey.set(leaseKey, [match]);
  }
}

function validateBoundedReproductionAttemptMembership(
  fold: HistoryRetentionProjectionFold,
  event: WorldEvent,
): void {
  const intentIds = fold.reproductionIntentIdsByAttemptEventId.get(event.id);
  if (!intentIds) return;
  for (const intentId of intentIds) {
    const demand = fold.reproductionFactsByIntentId.get(intentId);
    if (!demand
      || demand.agreementId === null
      || demand.acceptedAtMonth === null
      || demand.dueAtMonth === null
      || event.kind !== 'action'
      || event.status !== 'completed'
      || event.action.kind !== 'act'
      || event.action.operation !== 'reproduce'
      || event.action.authorizationRef !== demand.agreementId
      || event.atMonth < demand.acceptedAtMonth
      || event.atMonth > demand.dueAtMonth) {
      throw new Error(`reproduction intent ${intentId} 的 agreement attempt ${event.id} 不是窗口内权威完成事实`);
    }
    if (demand.resolvedAttemptEventIds.has(event.id)) {
      throw new Error(`reproduction intent ${intentId} 的 agreement attempt ${event.id} 在历史中重复`);
    }
    if (demand.attemptMonths.has(event.atMonth)) {
      throw new Error(`reproduction agreement ${demand.agreementId} 在第 ${event.atMonth} 月出现多次 attempt`);
    }
    demand.resolvedAttemptEventIds.add(event.id);
    demand.attemptMonths.add(event.atMonth);
    demand.resolvedAttemptMonthsByEventId.set(event.id, event.atMonth);
  }
}

function foldGameplayFactSelectors(
  fold: HistoryRetentionProjectionFold,
  event: WorldEvent,
  absoluteIndex: number,
): void {
  const match = { absoluteIndex, eventId: event.id };
  if (event.kind === 'action'
    && fold.millLaborPersonIds.has(event.who)
    && event.atMonth >= fold.productionWindowMonth - RECENT_PERSONAL_PRODUCTION_MONTHS
    && event.atMonth <= fold.productionWindowMonth
    && isCompletedPersonalProductionLaborEvent(event, event.who)) {
    const previousLeaseKey = fold.productionSelectorLeaseKeyByPersonId.get(event.who);
    if (previousLeaseKey) fold.selectiveMatchesByLeaseKey.delete(previousLeaseKey);
    const leaseKey = recentPersonalProductionLaborSelectorLeaseKey(event.who, event.atMonth);
    fold.productionSelectorLeaseKeyByPersonId.set(event.who, leaseKey);
    setLatestSelectiveMatch(fold, leaseKey, match);
  }
  if (event.kind === 'action') {
    for (const selector of fold.calibrationSelectorsByPersonId.get(event.who) ?? []) {
      if (isValidPersonalMassCalibrationFactForInstrument(
        event,
        selector.personId,
        selector.instrument,
      )) setLatestSelectiveMatch(fold, selector.leaseKey, match);
    }
    for (const selector of fold.waterAssistanceSelectorsByEventId.get(event.id) ?? []) {
      if (isHelperWaterAssistanceEvidence(
        fold.waterAssistanceValidationState,
        selector.proposal,
        event,
      )) setLatestSelectiveMatch(fold, selector.helperLeaseKey, match);
      if (isRequesterWaterAssistanceEvidence(selector.proposal, event)) {
        setLatestSelectiveMatch(fold, selector.requesterLeaseKey, match);
      }
    }
  }
  if (event.kind === 'action'
    && typeof event.diff.electricalNetworkId === 'string'
    && event.diff.electricalNetworkId.length > 0
    && isModernElectricalUsefulLoadFact(event, event.diff.electricalNetworkId)) {
    setLatestSelectiveMatch(
      fold,
      modernElectricalUsefulLoadLeaseKey(event.diff.electricalNetworkId),
      match,
    );
  }
  if (event.kind === 'action'
    && isIndependentRecordReuseFact(fold.modernRecordValidationState, event)) {
    setFirstSelectiveMatch(fold, MODERN_RECORD_EXPERIMENT_LEASE_KEY, match);
  }
  if (event.kind === 'action'
    && event.status === 'completed'
    && event.action.kind === 'communicate'
    && event.action.content.kind === 'prediction'
    && event.diff.duplicate !== true
    && fold.newPendingEraPredictionIdsRequiringCreation.has(event.action.content.id)) {
    const predictionId = event.action.content.id;
    if (fold.pendingEraPredictionCreationMatchesById.has(predictionId)) {
      throw new Error(`pending era prediction ${predictionId} 在 suffix 中重复创建`);
    }
    fold.pendingEraPredictionCreationMatchesById.set(predictionId, match);
  }
  if (event.kind === 'action'
    && event.status === 'completed'
    && event.action.kind === 'act'
    && event.action.operation === 'rehydrate'
    && event.diff.rehydrationBasis === 'disputed-pending-prediction'
    && typeof event.diff.hibernationPredictionId === 'string'
    && fold.pendingEraPredictionIds.has(event.diff.hibernationPredictionId)
    && typeof event.diff.rehydratedPersonId === 'string') {
    appendSelectiveMatch(
      fold,
      pendingEraPredictionWakeLeaseKey(event.diff.hibernationPredictionId),
      match,
    );
  }
  if (event.kind === 'environment'
    && event.change === 'body'
    && typeof event.diff.bornPersonId === 'string'
    && fold.livingChildIds.has(event.diff.bornPersonId)) {
    // `conversation-options` historically chose the latest matching birth fact.
    fold.livingChildBirthMatchesByChildId.set(event.diff.bornPersonId, match);
  }
  if (event.kind === 'action'
    && event.status === 'completed'
    && event.action.kind === 'communicate'
    && event.action.content.kind === 'claim'
    && event.action.content.conversation?.version === 'grounded-conversation-v1') {
    const conversation = event.action.content.conversation;
    const originalListenerId = conversation.turn === 'opening'
      ? conversation.listenerId
      : event.who;
    if (fold.millLaborPersonIds.has(originalListenerId)
      && event.atMonth >= fold.productionWindowMonth - GROUNDED_CONVERSATION_RESPONSE_WINDOW_MONTHS
      && event.atMonth <= fold.productionWindowMonth) {
      appendSelectiveMatch(
        fold,
        groundedConversationWindowLeaseKey(originalListenerId, event.atMonth),
        match,
      );
    }
  }
  if (event.kind !== 'action' || event.action.kind !== 'act' || event.action.operation !== 'reproduce') return;
  const participantIds = new Set<string>([event.who]);
  for (const target of event.action.targets) {
    if (target.kind === 'person') participantIds.add(target.personId);
  }
  const attemptIntentIds = new Set<string>();
  for (const personId of participantIds) {
    for (const intentId of fold.reproductionIntentIdsByOwnerId.get(personId) ?? []) attemptIntentIds.add(intentId);
  }
  for (const intentId of attemptIntentIds) {
    const demand = fold.reproductionFactsByIntentId.get(intentId);
    if (!demand
      || event.atMonth < demand.createdAtMonth
      || (demand.attemptEventIds.size > 0 && !demand.attemptEventIds.has(event.id))) continue;
    setLatestSelectiveMatch(fold, reproductionAttemptLeaseKey(intentId), match);
  }
  if (event.diff.conceived !== true || typeof event.diff.femaleId !== 'string') return;
  for (const intentId of fold.reproductionIntentIdsByFemaleId.get(event.diff.femaleId) ?? []) {
    const demand = fold.reproductionFactsByIntentId.get(intentId);
    if (!demand
      || event.atMonth < demand.createdAtMonth
      || (demand.attemptEventIds.size > 0 && !demand.attemptEventIds.has(event.id))) continue;
    setLatestSelectiveMatch(fold, reproductionConceptionLeaseKey(intentId), match);
  }
}

function discardFold(fold: HistoryRetentionProjectionFold): void {
  fold.status = 'discarded';
  fold.directDemandEventIds.clear(); fold.demandGroupsByKey.clear(); fold.directMatchesByEventId.clear();
  fold.millLaborRingsByPersonId.clear(); fold.pendingMechanicalTeachingByAudienceId.clear();
  fold.witnessedMechanicalAudienceIds.clear(); fold.pendingEraPredictionIds.clear();
  fold.livingChildIds.clear(); fold.reproductionFactsByIntentId.clear();
  fold.reproductionIntentIdsByOwnerId.clear(); fold.reproductionIntentIdsByFemaleId.clear();
  fold.reproductionIntentIdsByAttemptEventId.clear();
  fold.selectiveMatchesByLeaseKey.clear(); fold.livingChildBirthMatchesByChildId.clear();
  fold.productionSelectorLeaseKeyByPersonId.clear(); fold.calibrationSelectorsByPersonId.clear();
  fold.waterAssistanceSelectorsByEventId.clear(); fold.waterAssistanceSelectiveLeaseKeys.clear();
  fold.requiredSuffixDirectDemandEventIds.clear();
  fold.requiredSuffixReproductionAnchorEventIds.clear();
  fold.newLivingPersonIdsRequiringBirth.clear();
  fold.newPendingEraPredictionIdsRequiringCreation.clear();
  fold.pendingEraPredictionCreationMatchesById.clear();
  fold.finishedResult = undefined;
}

function failFold(fold: HistoryRetentionProjectionFold, message: string): never {
  discardFold(fold);
  throw new Error(message);
}

/** Mutably stages one verified segment. A failed fold is poisoned and cleared. */
export function foldHistoryRetentionSegment(
  fold: HistoryRetentionProjectionFold,
  segment: readonly WorldEvent[],
  startAbsoluteIndex: number,
): HistoryRetentionProjectionFold {
  if (fold.status !== 'open') throw new Error(`retention projection fold 已${fold.status === 'finished' ? '完成' : '丢弃'}`);
  try {
    assertNonNegativeSafeInteger(startAbsoluteIndex, 'segment startAbsoluteIndex');
    if (startAbsoluteIndex !== fold.summary.reducedThrough.eventCount) {
      return failFold(fold, `retention projection segment 重复或跳跃：期望 ${fold.summary.reducedThrough.eventCount}，收到 ${startAbsoluteIndex}`);
    }
    if (!Array.isArray(segment) || segment.length === 0) return failFold(fold, 'retention projection segment 必须包含至少一个事件');
    const segmentEnd = startAbsoluteIndex + segment.length;
    if (!Number.isSafeInteger(segmentEnd) || segmentEnd > fold.target.eventCount) {
      return failFold(fold, 'retention projection segment 超出目标绝对历史范围');
    }
    for (let offset = 0; offset < segment.length; offset += 1) {
      const event = segment[offset];
      if (!event || typeof event.id !== 'string' || event.id.length === 0) {
        return failFold(fold, `retention projection 的绝对序号 ${startAbsoluteIndex + offset} 缺少事件 ID`);
      }
    }
    for (let offset = 0; offset < segment.length; offset += 1) {
      const event = segment[offset];
      const absoluteIndex = startAbsoluteIndex + offset;
      if (fold.directDemandEventIds.has(event.id)) {
        fold.directMatchesByEventId.set(event.id, { absoluteIndex, eventId: event.id });
      }
      if (isCompletedMillLabor(event) && fold.millLaborPersonIds.has(event.who)) {
        const ring = fold.millLaborRingsByPersonId.get(event.who) ?? [];
        ring.push({ absoluteIndex, eventId: event.id });
        if (ring.length > 3) ring.splice(0, ring.length - 3);
        fold.millLaborRingsByPersonId.set(event.who, ring);
      }
      if (event.kind === 'decision') {
        if (event.usedModel) fold.summary.modelDecisions += 1;
        else fold.summary.ruleDecisions += 1;
      }
      validateBoundedReproductionAttemptMembership(fold, event);
      foldGameplayFactSelectors(fold, event, absoluteIndex);
      countMechanicalEvent(fold.summary.mechanicalP0, event);
      const taughtAudienceIds = explicitMechanicalTeachingAudienceIds(event);
      if (taughtAudienceIds) {
        fold.summary.mechanicalP0.completedExplicitMechanicalTeachings += 1;
        for (const audienceId of taughtAudienceIds) {
          if (!fold.witnessedMechanicalAudienceIds.has(audienceId)
            && !fold.pendingMechanicalTeachingByAudienceId.has(audienceId)) {
            fold.pendingMechanicalTeachingByAudienceId.set(audienceId, { absoluteIndex, eventId: event.id });
          }
        }
      }
      if (event.kind === 'action' && event.status === 'completed' && event.diff.mechanicalPowerOperation === true) {
        const teaching = fold.pendingMechanicalTeachingByAudienceId.get(event.who);
        if (teaching && teaching.absoluteIndex < absoluteIndex) {
          fold.pendingMechanicalTeachingByAudienceId.delete(event.who);
          fold.witnessedMechanicalAudienceIds.add(event.who);
          fold.summary.mechanicalP0.independentTaughtOperatorWitnesses += 1;
          fold.summary.mechanicalTeachingOperationAchieved = true;
          fold.minimalMechanicalTeachingWitness ??= {
            audienceId: event.who, teachingAbsoluteIndex: teaching.absoluteIndex, teachingEventId: teaching.eventId,
            operationAbsoluteIndex: absoluteIndex, operationEventId: event.id,
          };
        }
      }
    }
    fold.summary.reducedThrough = { eventCount: segmentEnd, tailEventId: segment.at(-1)?.id ?? null };
    return fold;
  } catch (error) {
    discardFold(fold);
    throw error;
  }
}

function addPin(pins: Map<number, HistoryRetentionPin>, match: DirectPinMatch, leases: readonly string[]): void {
  const existing = pins.get(match.absoluteIndex);
  if (existing) {
    if (existing.eventId !== match.eventId) throw new Error(`retention projection 绝对序号 ${match.absoluteIndex} 出现冲突事件 ID`);
    existing.leaseKeys = [...new Set([...existing.leaseKeys, ...leases])].sort();
  } else pins.set(match.absoluteIndex, {
    absoluteIndex: match.absoluteIndex, eventId: match.eventId, leaseKeys: [...new Set(leases)].sort(),
  });
}

function cloneHistoryRetentionSummary(summary: HistoryRetentionSummary): HistoryRetentionSummary {
  return {
    ...summary,
    reducedThrough: { ...summary.reducedThrough },
    mechanicalP0: { ...summary.mechanicalP0 },
  };
}

function continuationDemandFromFold(fold: HistoryRetentionProjectionFold): HistoryRetentionContinuationDemand {
  return continuationDemandFromCollected({
    directDemandEventIds: fold.directDemandEventIds,
    demandGroupsByKey: fold.demandGroupsByKey,
    millLaborPersonIds: fold.millLaborPersonIds,
    pendingEraPredictionIds: fold.pendingEraPredictionIds,
    livingChildIds: fold.livingChildIds,
    reproductionFactsByIntentId: fold.reproductionFactsByIntentId,
    calibrationSelectorsByPersonId: fold.calibrationSelectorsByPersonId,
    waterAssistanceSelectorsByEventId: fold.waterAssistanceSelectorsByEventId,
    productionWindowMonth: fold.productionWindowMonth,
  });
}

type UnhashedHistoryRetentionContinuationBasis = Omit<HistoryRetentionContinuationBasis, 'basisHash'>;

function historyRetentionContinuationBasisHash(basis: UnhashedHistoryRetentionContinuationBasis): string {
  return createHash('sha256')
    .update('eland-history-retention-continuation-v1\0')
    .update(JSON.stringify(basis))
    .digest('hex');
}

function buildHistoryRetentionContinuationBasis(
  fold: HistoryRetentionProjectionFold,
): HistoryRetentionContinuationBasis {
  const livingIds = fold.millLaborPersonIds;
  const sourceDemand = continuationDemandFromFold(fold);
  const withoutHash: UnhashedHistoryRetentionContinuationBasis = {
    schemaVersion: 1,
    sourceAuthority: { ...fold.authority },
    sourceTarget: { ...fold.target },
    sourceDemandFingerprint: fold.demandFingerprint,
    sourceDemand,
    directMatches: [...fold.directMatchesByEventId.values()]
      .map((match) => ({ ...match }))
      .sort((left, right) => left.eventId.localeCompare(right.eventId)
        || left.absoluteIndex - right.absoluteIndex),
    millLaborRings: [...fold.millLaborRingsByPersonId]
      .filter(([personId]) => livingIds.has(personId))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([personId, matches]) => ({
        personId,
        matches: matches.map((match) => ({ ...match }))
          .sort((left, right) => left.absoluteIndex - right.absoluteIndex),
      })),
    pendingMechanicalTeachings: [...fold.pendingMechanicalTeachingByAudienceId]
      .filter(([audienceId]) => livingIds.has(audienceId))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([audienceId, match]) => ({ audienceId, ...match })),
    witnessedMechanicalAudienceIds: [...fold.witnessedMechanicalAudienceIds]
      .filter((audienceId) => livingIds.has(audienceId))
      .sort(),
    reproductionAttempts: [...fold.reproductionFactsByIntentId.values()]
      .sort((left, right) => left.intentId.localeCompare(right.intentId))
      .map((item) => ({
        intentId: item.intentId,
        resolved: [...item.resolvedAttemptMonthsByEventId]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([eventId, atMonth]) => ({ eventId, atMonth })),
      })),
    selectiveMatches: [...fold.selectiveMatchesByLeaseKey]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([leaseKey, matches]) => ({
        leaseKey,
        matches: matches.map((match) => ({ ...match }))
          .sort((left, right) => left.absoluteIndex - right.absoluteIndex),
      })),
    livingChildBirthMatches: [...fold.livingChildBirthMatchesByChildId]
      .filter(([childId]) => fold.livingChildIds.has(childId))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([childId, match]) => ({ childId, match: { ...match } })),
    minimalMechanicalTeachingWitness: fold.minimalMechanicalTeachingWitness
      ? { ...fold.minimalMechanicalTeachingWitness }
      : null,
    summary: cloneHistoryRetentionSummary(fold.summary),
  };
  return { ...withoutHash, basisHash: historyRetentionContinuationBasisHash(withoutHash) };
}

function assertHistoryRetentionSeal(seal: HistoryRetentionSeal, context: string): void {
  if (!seal) throw new Error(`${context}缺少 history seal`);
  assertNonNegativeSafeInteger(seal.eventCount, `${context}eventCount`);
  if (seal.eventCount === 0) {
    if (seal.tailEventId !== null) throw new Error(`${context}空历史 tailEventId 必须为 null`);
  } else if (typeof seal.tailEventId !== 'string' || seal.tailEventId.length === 0) {
    throw new Error(`${context}非空历史缺少 tailEventId`);
  }
}

function assertSortedUniqueStrings(values: readonly string[], context: string): void {
  if (!Array.isArray(values)) throw new Error(`${context}必须是数组`);
  const canonical = [...new Set(values)].sort();
  if (canonical.length !== values.length || canonical.some((value, index) => value !== values[index]
    || typeof value !== 'string' || value.length === 0)) {
    throw new Error(`${context}必须是已排序且无重复的非空 ID 数组`);
  }
}

function assertLocaleSortedUniqueStrings(values: readonly string[], context: string): void {
  if (!Array.isArray(values)) throw new Error(`${context}必须是数组`);
  const canonical = [...new Set(values)].sort((left, right) => left.localeCompare(right));
  if (canonical.length !== values.length || canonical.some((value, index) => value !== values[index]
    || typeof value !== 'string' || value.length === 0)) {
    throw new Error(`${context}必须是已按 group-key locale 排序且无重复的非空 ID 数组`);
  }
}

function assertContinuationMatch(
  match: HistoryRetentionContinuationMatch,
  sourceTarget: HistoryRetentionSeal,
  context: string,
): void {
  if (!match || typeof match.eventId !== 'string' || match.eventId.length === 0) {
    throw new Error(`${context}缺少 event ID`);
  }
  assertNonNegativeSafeInteger(match.absoluteIndex, `${context}absoluteIndex`);
  if (match.absoluteIndex >= sourceTarget.eventCount) {
    throw new Error(`${context}ordinal 超出 source seal`);
  }
}

function normalizedResultDemandGroups(
  groups: readonly HistoryRetentionDemandGroupResult[],
): HistoryRetentionContinuationDemandGroup[] {
  return groups.map((group) => ({
    groupKey: group.groupKey,
    requirement: group.requirement,
    leaseKeys: [...group.leaseKeys].sort(),
    eventIds: [...group.eventIds].sort(),
  })).sort((left, right) => left.groupKey.localeCompare(right.groupKey));
}

function validateHistoryRetentionContinuationBasis(
  previous: HistoryRetentionProjectionResult,
): HistoryRetentionContinuationBasis {
  if (!previous || previous.schemaVersion !== 1 || previous.continuationReady !== false
    || !previous.continuationBasis) {
    throw new Error('retention checkpoint 缺少 continuation basis 或 continuation 状态无效');
  }
  assertHistoryRetentionAuthority(previous.authority, 'retention checkpoint ');
  assertHistoryRetentionSeal(previous.target, 'retention checkpoint target ');
  if (!/^[a-f0-9]{64}$/u.test(previous.demandFingerprint)) {
    throw new Error('retention checkpoint demand fingerprint 无效');
  }
  const basis = previous.continuationBasis;
  if (basis.schemaVersion !== 1) throw new Error('retention continuation basis 版本无效');
  assertHistoryRetentionAuthority(basis.sourceAuthority, 'retention continuation source ');
  assertHistoryRetentionSeal(basis.sourceTarget, 'retention continuation source target ');
  if (basis.sourceAuthority.stateHash !== previous.authority.stateHash
    || basis.sourceTarget.eventCount !== previous.target.eventCount
    || basis.sourceTarget.tailEventId !== previous.target.tailEventId) {
    throw new Error('retention continuation basis 的 stateHash/seal 与 checkpoint 不一致');
  }
  if (basis.sourceDemandFingerprint !== previous.demandFingerprint
    || !/^[a-f0-9]{64}$/u.test(basis.sourceDemandFingerprint)) {
    throw new Error('retention continuation basis 的 demand fingerprint 与 checkpoint 不一致');
  }
  const { basisHash, ...withoutHash } = basis;
  if (!/^[a-f0-9]{64}$/u.test(basisHash)
    || historyRetentionContinuationBasisHash(withoutHash) !== basisHash) {
    throw new Error('retention continuation basis CAS hash 无效');
  }
  const sourceDemand = basis.sourceDemand;
  if (!sourceDemand || historyRetentionDemandFingerprint(sourceDemand) !== basis.sourceDemandFingerprint) {
    throw new Error('retention continuation basis 的 demand payload/fingerprint 不一致');
  }
  assertSortedUniqueStrings(sourceDemand.millLaborPersonIds, 'retention continuation mill labor people');
  assertSortedUniqueStrings(sourceDemand.pendingEraPredictionIds, 'retention continuation pending predictions');
  assertSortedUniqueStrings(sourceDemand.livingChildIds, 'retention continuation living children');
  const groupKeys = sourceDemand.groups.map((group) => group.groupKey);
  assertLocaleSortedUniqueStrings(groupKeys, 'retention continuation demand groups');
  let completedLiveProjectGroupCount = 0;
  let livingSharedProjectGroupCount = 0;
  let groundedResponseSourceGroupCount = 0;
  const groundedResponseSourceEventIds = new Set<string>();
  let recentTerminalFailureGroupCount = 0;
  let recentTerminalFailureEventIdCount = 0;
  let socialLearningGroupCount = 0;
  let socialLearningEventIdMembershipCount = 0;
  const livingPersonIdSet = new Set(sourceDemand.millLaborPersonIds);
  assertProjectPressureHistoryRetentionDemandGroups(
    sourceDemand.groups,
    'retention continuation demand',
    { allowLegacyMissing: true },
  );
  for (const group of sourceDemand.groups) {
    if (!HISTORY_RETENTION_REQUIREMENTS.includes(group.requirement)) {
      throw new Error(`retention continuation demand group ${group.groupKey} requirement 无效`);
    }
    assertSortedUniqueStrings(group.leaseKeys, `retention continuation demand group ${group.groupKey} leases`);
    assertSortedUniqueStrings(group.eventIds, `retention continuation demand group ${group.groupKey} events`);
    if (group.groupKey.startsWith('active-mechanical-project:')
      && group.groupKey.endsWith(':actions')
      && group.eventIds.length > HISTORY_RETENTION_MAX_ACTIVE_PROJECT_ACTION_EVENT_IDS) {
      throw new Error(`retention continuation demand group ${group.groupKey} action events 超出有界上限`);
    }
    if (group.groupKey.startsWith('electrical-maintenance-project:')
      && group.groupKey.endsWith(':replacement')
      && group.eventIds.length > HISTORY_RETENTION_MAX_ELECTRICAL_MAINTENANCE_PROJECT_EVENT_IDS) {
      throw new Error(`retention continuation demand group ${group.groupKey} replacement events 超出有界上限`);
    }
    if (group.groupKey.startsWith('electrical-component-technique:')
      && group.eventIds.length > ELECTRICAL_POWER_SOURCE_EVENT_LIMIT) {
      throw new Error(`retention continuation demand group ${group.groupKey} component sources 超出有界上限`);
    }
    if (group.groupKey.startsWith('electrical-fault-observation:')
      && group.eventIds.length > ELECTRICAL_POWER_RECENT_EVENT_LIMIT) {
      throw new Error(`retention continuation demand group ${group.groupKey} diagnosis sources 超出有界上限`);
    }
    if (group.groupKey.startsWith('electrical-network:')
      && (group.groupKey.endsWith(':current-fault') || group.groupKey.endsWith(':current-repair'))
      && group.eventIds.length > ELECTRICAL_POWER_SOURCE_EVENT_LIMIT + 1) {
      throw new Error(`retention continuation demand group ${group.groupKey} network sources 超出有界上限`);
    }
    if (group.groupKey.startsWith('live-intent:')
      && group.groupKey.endsWith(':anchors')
      && group.eventIds.length > HISTORY_RETENTION_MAX_LIVE_INTENT_CORE_EVENT_IDS) {
      throw new Error(`retention continuation demand group ${group.groupKey} intent anchors 超出有界上限`);
    }
    if (parseGroundedConversationResponseSourceLeaseKey(group.groupKey)) {
      groundedResponseSourceGroupCount += 1;
      if (group.requirement !== 'all'
        || group.leaseKeys.length !== 1
        || group.leaseKeys[0] !== group.groupKey
        || group.eventIds.length > HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_SOURCE_EVENT_IDS) {
        throw new Error(`retention continuation demand group ${group.groupKey} response sources 无效或超界`);
      }
      group.eventIds.forEach((eventId) => groundedResponseSourceEventIds.add(eventId));
    }
    const recentTerminalFailure = parseRecentTerminalFailureActionLeaseKey(group.groupKey);
    if (recentTerminalFailure) {
      recentTerminalFailureGroupCount += 1;
      if (!livingPersonIdSet.has(recentTerminalFailure.ownerId)
        || group.requirement !== 'all'
        || group.leaseKeys.length !== 1
        || group.leaseKeys[0] !== group.groupKey
        || group.eventIds.length
          > HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_PER_PERSON) {
        throw new Error(
          `retention continuation demand group ${group.groupKey}`
          + ' recent terminal failure actions 无效或超界',
        );
      }
      recentTerminalFailureEventIdCount += group.eventIds.length;
    }
    const socialLearning = parseSocialLearningSourceLeaseKey(group.groupKey);
    if (socialLearning) {
      socialLearningGroupCount += 1;
      socialLearningEventIdMembershipCount += group.eventIds.length;
      if (!livingPersonIdSet.has(socialLearning.observerId)
        || group.requirement !== 'all'
        || group.leaseKeys.length !== 1
        || group.leaseKeys[0] !== group.groupKey
        || group.eventIds.length > HISTORY_RETENTION_MAX_SOCIAL_LEARNING_EVENT_IDS_PER_PERSON) {
        throw new Error(
          `retention continuation demand group ${group.groupKey}`
          + ' social learning sources 无效或超界',
        );
      }
    }
    if (group.groupKey === FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_LEASE_KEY
      && (group.requirement !== 'index-only'
        || group.leaseKeys.length !== 1
        || group.leaseKeys[0] !== FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_LEASE_KEY
        || group.eventIds.length
          > HISTORY_RETENTION_MAX_FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_EVENT_IDS)) {
      throw new Error(`retention continuation demand group ${group.groupKey} logistics selector 无效或超界`);
    }
    const liveSocial = parseLivePersonSocialEvidenceGroupKey(group.groupKey);
    if (liveSocial) {
      const expectedLeaseKey = liveSocial.kind === 'broad'
        ? livePersonSocialEvidenceLeaseKey(liveSocial.ownerId)
        : livePersonSocialStrictEvidenceLeaseKey(liveSocial.ownerId, liveSocial.kind);
      const validRequirement = liveSocial.kind === 'broad'
        ? group.requirement === 'index-only' || group.requirement === 'all'
        : group.requirement === 'all';
      if (!validRequirement
        || group.leaseKeys.length !== 1
        || group.leaseKeys[0] !== expectedLeaseKey
        || group.eventIds.length > HISTORY_RETENTION_MAX_LIVE_PERSON_SOCIAL_EVENT_IDS) {
        throw new Error(`retention continuation demand group ${group.groupKey} social selector 无效或超界`);
      }
    }
    if (group.groupKey.startsWith('gameplay:completed-live-project:')
      && group.groupKey.endsWith(':completion-events')) {
      completedLiveProjectGroupCount += 1;
      if (group.eventIds.length > HISTORY_RETENTION_MAX_COMPLETED_PROJECT_SOURCE_EVENT_IDS) {
        throw new Error(`retention continuation demand group ${group.groupKey} completion events 超出有界上限`);
      }
    }
    if (group.groupKey.startsWith('gameplay:living-shared-project:')
      && group.groupKey.endsWith(':action-events')) {
      livingSharedProjectGroupCount += 1;
      if (group.eventIds.length > HISTORY_RETENTION_MAX_COMPLETED_PROJECT_SOURCE_EVENT_IDS) {
        throw new Error(`retention continuation demand group ${group.groupKey} shared-work actions 超出有界上限`);
      }
    }
  }
  if (completedLiveProjectGroupCount > HISTORY_RETENTION_MAX_COMPLETED_LIVE_PROJECTS) {
    throw new Error('retention continuation completed-live-project groups 超出有界上限');
  }
  if (livingSharedProjectGroupCount > HISTORY_RETENTION_MAX_LIVING_SHARED_PROJECT_PAIRS) {
    throw new Error('retention continuation living-shared-project groups 超出有界上限');
  }
  if (groundedResponseSourceGroupCount > HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_SOURCE_GROUPS
    || groundedResponseSourceEventIds.size
      > HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_UNIQUE_EVENT_IDS) {
    throw new Error('retention continuation grounded response source groups 超出有界上限');
  }
  if (recentTerminalFailureGroupCount > HISTORY_RETENTION_MAX_LIVE_GAMEPLAY_SELECTOR_PERSONS
    || recentTerminalFailureEventIdCount
      > HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_TOTAL) {
    throw new Error('retention continuation recent terminal failure action leases 超出有界上限');
  }
  if (socialLearningGroupCount > HISTORY_RETENTION_MAX_LIVE_GAMEPLAY_SELECTOR_PERSONS
    || socialLearningEventIdMembershipCount
      > HISTORY_RETENTION_MAX_SOCIAL_LEARNING_EVENT_IDS_TOTAL) {
    throw new Error('retention continuation social learning source leases 超出有界上限');
  }
  assertLiveIntentHistoryRetentionDemandGroups(
    sourceDemand.groups,
    'retention continuation demand group',
  );
  const reproductionIntentIds = sourceDemand.reproductionFacts.map((item) => item.intentId);
  assertSortedUniqueStrings(reproductionIntentIds, 'retention continuation reproduction intents');
  for (const item of sourceDemand.reproductionFacts) {
    if (typeof item.ownerId !== 'string' || item.ownerId.length === 0
      || (item.femaleId !== null && (typeof item.femaleId !== 'string' || item.femaleId.length === 0))
      || (item.agreementId !== null && (typeof item.agreementId !== 'string' || item.agreementId.length === 0))) {
      throw new Error(`retention continuation reproduction intent ${item.intentId} selector ID 无效`);
    }
    assertNonNegativeSafeInteger(item.createdAtMonth, `retention continuation reproduction intent ${item.intentId} createdAtMonth`);
    assertSortedUniqueStrings(item.attemptEventIds, `retention continuation reproduction intent ${item.intentId} attempt IDs`);
    if (item.attemptEventIds.length > HISTORY_RETENTION_MAX_REPRODUCTION_ATTEMPT_EVENT_IDS) {
      throw new Error(`retention continuation reproduction intent ${item.intentId} attempt IDs 超出有界窗口`);
    }
    if ((item.acceptedAtMonth === null) !== (item.dueAtMonth === null)
      || (item.acceptedAtMonth !== null && (!Number.isSafeInteger(item.acceptedAtMonth)
        || !Number.isSafeInteger(item.dueAtMonth)
        || Number(item.dueAtMonth) - item.acceptedAtMonth + 1
          !== HISTORY_RETENTION_MAX_REPRODUCTION_ATTEMPT_EVENT_IDS))
      || (item.lastAttemptAtMonth !== null && (!Number.isSafeInteger(item.lastAttemptAtMonth)
        || item.acceptedAtMonth === null
        || item.dueAtMonth === null
        || item.lastAttemptAtMonth < item.acceptedAtMonth
        || item.lastAttemptAtMonth > item.dueAtMonth))
      || (item.attemptEventIds.length > 0 && item.lastAttemptAtMonth === null)
      || (item.attemptEventIds.length === 0 && item.lastAttemptAtMonth !== null)) {
      throw new Error(`retention continuation reproduction intent ${item.intentId} consent window 无效`);
    }
  }
  if (JSON.stringify(normalizedResultDemandGroups(previous.demandGroups)) !== JSON.stringify(sourceDemand.groups)
    || !sameStringSet(previous.millLaborPersonIds, sourceDemand.millLaborPersonIds)) {
    throw new Error('retention continuation basis 的 demand 与 checkpoint result 不一致');
  }
  if (historyRetentionDemandFingerprint(sourceDemand) !== previous.demandFingerprint) {
    throw new Error('retention continuation basis 无法验证 checkpoint demand');
  }
  if (basis.summary.schemaVersion !== 1
    || JSON.stringify(basis.summary) !== JSON.stringify(previous.summary)
    || basis.summary.reducedThrough.eventCount !== basis.sourceTarget.eventCount
    || basis.summary.reducedThrough.tailEventId !== basis.sourceTarget.tailEventId) {
    throw new Error('retention continuation basis 的累计 summary/seal 无效');
  }
  if (typeof basis.summary.mechanicalTeachingOperationAchieved !== 'boolean') {
    throw new Error('retention continuation basis 的 mechanical witness summary 无效');
  }
  for (const [key, value] of Object.entries({
    ruleDecisions: basis.summary.ruleDecisions,
    modelDecisions: basis.summary.modelDecisions,
    ...basis.summary.mechanicalP0,
  })) assertNonNegativeSafeInteger(value, `retention continuation summary ${key}`);
  if (JSON.stringify(basis.minimalMechanicalTeachingWitness)
    !== JSON.stringify(previous.minimalMechanicalTeachingWitness)) {
    throw new Error('retention continuation basis 的 minimal witness 与 checkpoint 不一致');
  }

  const demandedIds = new Set(sourceDemand.groups.flatMap((group) => group.eventIds));
  const livingIds = new Set(sourceDemand.millLaborPersonIds);
  const childIds = new Set(sourceDemand.livingChildIds);
  const reproductionById = new Map(sourceDemand.reproductionFacts.map((item) => [item.intentId, item]));
  if (reproductionById.size !== sourceDemand.reproductionFacts.length) {
    throw new Error('retention continuation reproduction demand ID 重复');
  }
  const ordinalIds = new Map<number, string>();
  const validateMatch = (match: HistoryRetentionContinuationMatch, context: string) => {
    assertContinuationMatch(match, basis.sourceTarget, context);
    const existing = ordinalIds.get(match.absoluteIndex);
    if (existing && existing !== match.eventId) {
      throw new Error(`retention continuation ordinal ${match.absoluteIndex} 出现冲突 event ID`);
    }
    ordinalIds.set(match.absoluteIndex, match.eventId);
  };
  const directEventIds = new Set<string>();
  for (const match of basis.directMatches) {
    validateMatch(match, `retention continuation direct ${match.eventId}`);
    if (!demandedIds.has(match.eventId) || directEventIds.has(match.eventId)) {
      throw new Error(`retention continuation direct ${match.eventId} 不属于 source demand 或重复`);
    }
    directEventIds.add(match.eventId);
  }
  const ringPeople = new Set<string>();
  for (const ring of basis.millLaborRings) {
    if (!livingIds.has(ring.personId) || ringPeople.has(ring.personId) || ring.matches.length > 3) {
      throw new Error(`retention continuation mill ring ${ring.personId} 无效`);
    }
    ringPeople.add(ring.personId);
    let previousOrdinal = -1;
    ring.matches.forEach((match) => {
      validateMatch(match, `retention continuation mill ring ${ring.personId}`);
      if (match.absoluteIndex <= previousOrdinal) {
        throw new Error(`retention continuation mill ring ${ring.personId} ordinal 顺序无效`);
      }
      previousOrdinal = match.absoluteIndex;
    });
  }
  const pendingAudienceIds = new Set<string>();
  for (const pending of basis.pendingMechanicalTeachings) {
    if (!livingIds.has(pending.audienceId) || pendingAudienceIds.has(pending.audienceId)) {
      throw new Error(`retention continuation pending teaching ${pending.audienceId} 无效`);
    }
    pendingAudienceIds.add(pending.audienceId);
    validateMatch(pending, `retention continuation pending teaching ${pending.audienceId}`);
  }
  assertSortedUniqueStrings(basis.witnessedMechanicalAudienceIds, 'retention continuation witnessed audiences');
  if (basis.witnessedMechanicalAudienceIds.some((audienceId) => !livingIds.has(audienceId)
    || pendingAudienceIds.has(audienceId))) {
    throw new Error('retention continuation witnessed/pending audience 状态冲突');
  }
  const reproductionAttemptIds = new Set<string>();
  for (const item of basis.reproductionAttempts) {
    const source = reproductionById.get(item.intentId);
    if (!source || reproductionAttemptIds.has(item.intentId)) {
      throw new Error(`retention continuation reproduction attempts ${item.intentId} 无效`);
    }
    reproductionAttemptIds.add(item.intentId);
    const expectedIds = new Set(source.attemptEventIds);
    const resolvedIds = new Set<string>();
    const resolvedMonths = new Set<number>();
    for (const resolved of item.resolved) {
      if (!expectedIds.has(resolved.eventId) || resolvedIds.has(resolved.eventId)
        || resolvedMonths.has(resolved.atMonth)) {
        throw new Error(`retention continuation reproduction attempt ${resolved.eventId} 无效`);
      }
      assertNonNegativeSafeInteger(resolved.atMonth, `retention continuation reproduction attempt ${resolved.eventId} month`);
      if (source.acceptedAtMonth === null || source.dueAtMonth === null
        || resolved.atMonth < source.acceptedAtMonth || resolved.atMonth > source.dueAtMonth) {
        throw new Error(`retention continuation reproduction attempt ${resolved.eventId} 超出 consent window`);
      }
      resolvedIds.add(resolved.eventId);
      resolvedMonths.add(resolved.atMonth);
    }
    if (resolvedIds.size !== expectedIds.size) {
      throw new Error(`retention continuation reproduction intent ${item.intentId} 缺少已验证 attempt`);
    }
    if (item.resolved.length > 0
      && Math.max(...item.resolved.map((resolved) => resolved.atMonth)) !== source.lastAttemptAtMonth) {
      throw new Error(`retention continuation reproduction intent ${item.intentId} last attempt month 不一致`);
    }
  }
  if (reproductionAttemptIds.size !== reproductionById.size) {
    throw new Error('retention continuation reproduction attempt basis 不完整');
  }
  const selectiveLeaseKeys = new Set<string>();
  const allMatchSelectiveLeaseKeys = new Set(sourceDemand.pendingEraPredictionIds
    .map(pendingEraPredictionWakeLeaseKey));
  const productionWindowMonth = productionWindowMonthFromDemandGroups(sourceDemand.groups);
  const productionSelectorPersonIds = new Set<string>();
  const allowedSelectiveLeaseKeys = new Set<string>([
    ...allMatchSelectiveLeaseKeys,
    ...calibrationLeaseKeysFromDemandGroups(sourceDemand.groups),
    ...waterAssistanceSelectiveLeaseKeysFromDemandGroups(sourceDemand.groups),
    // Observer-only modern witnesses deliberately have no gameplay demand
    // group because planners must never read them. Record reuse is global;
    // electrical useful loads are validated below as network-scoped keys.
    MODERN_RECORD_EXPERIMENT_LEASE_KEY,
    ...sourceDemand.reproductionFacts.flatMap((item) => [
      reproductionAttemptLeaseKey(item.intentId),
      ...(item.femaleId ? [reproductionConceptionLeaseKey(item.intentId)] : []),
    ]),
  ]);
  for (const item of basis.selectiveMatches) {
    if (typeof item.leaseKey !== 'string' || item.leaseKey.length === 0 || selectiveLeaseKeys.has(item.leaseKey)) {
      throw new Error('retention continuation selective lease key 无效或重复');
    }
    const production = parseRecentPersonalProductionLaborSelectorLeaseKey(item.leaseKey);
    const validProduction = production !== null
      && productionWindowMonth !== null
      && sourceDemand.millLaborPersonIds.includes(production.personId)
      && production.eventMonth >= productionWindowMonth - RECENT_PERSONAL_PRODUCTION_MONTHS
      && production.eventMonth <= productionWindowMonth
      && !productionSelectorPersonIds.has(production.personId);
    const groundedConversation = parseGroundedConversationWindowLeaseKey(item.leaseKey);
    const validGroundedConversation = groundedConversation !== null
      && productionWindowMonth !== null
      && sourceDemand.millLaborPersonIds.includes(groundedConversation.listenerId)
      && groundedConversation.eventMonth
        >= productionWindowMonth - GROUNDED_CONVERSATION_RESPONSE_WINDOW_MONTHS
      && groundedConversation.eventMonth <= productionWindowMonth;
    const validModernElectrical = item.leaseKey === MODERN_ELECTRICAL_USEFUL_LOAD_LEASE_KEY
      || parseModernElectricalUsefulLoadLeaseKey(item.leaseKey) !== null;
    if (!allowedSelectiveLeaseKeys.has(item.leaseKey)
      && !validModernElectrical
      && !validProduction
      && !validGroundedConversation) {
      throw new Error(`retention continuation selective lease ${item.leaseKey} 不属于 source demand`);
    }
    if (validProduction && production) productionSelectorPersonIds.add(production.personId);
    selectiveLeaseKeys.add(item.leaseKey);
    let previousOrdinal = -1;
    item.matches.forEach((match) => {
      validateMatch(match, `retention continuation selector ${item.leaseKey}`);
      if (match.absoluteIndex <= previousOrdinal) {
        throw new Error(`retention continuation selector ${item.leaseKey} ordinal 顺序无效`);
      }
      previousOrdinal = match.absoluteIndex;
    });
    const allMatch = allMatchSelectiveLeaseKeys.has(item.leaseKey) || validGroundedConversation;
    if (allMatch
      && item.matches.length > HISTORY_RETENTION_MAX_PENDING_PREDICTION_WAKE_MATCHES) {
      throw new Error(`retention continuation selector ${item.leaseKey} all-match 超出有界上限`);
    }
    if (!allMatch && item.matches.length > 1) {
      throw new Error(`retention continuation latest selector ${item.leaseKey} 含多个 match`);
    }
  }
  const birthChildIds = new Set<string>();
  for (const item of basis.livingChildBirthMatches) {
    if (!childIds.has(item.childId) || birthChildIds.has(item.childId)) {
      throw new Error(`retention continuation child birth ${item.childId} 无效`);
    }
    birthChildIds.add(item.childId);
    validateMatch(item.match, `retention continuation child birth ${item.childId}`);
  }
  if (birthChildIds.size !== childIds.size) {
    throw new Error('retention continuation living child birth basis 不完整');
  }
  const witness = basis.minimalMechanicalTeachingWitness;
  if (witness) {
    if (typeof witness.audienceId !== 'string' || witness.audienceId.length === 0) {
      throw new Error('retention continuation minimal witness audience 无效');
    }
    validateMatch({ absoluteIndex: witness.teachingAbsoluteIndex, eventId: witness.teachingEventId }, 'retention continuation witness teaching');
    validateMatch({ absoluteIndex: witness.operationAbsoluteIndex, eventId: witness.operationEventId }, 'retention continuation witness operation');
    if (witness.teachingAbsoluteIndex >= witness.operationAbsoluteIndex) {
      throw new Error('retention continuation minimal witness 顺序无效');
    }
  }
  return basis;
}

function sameReproductionSelectorIdentity(
  previous: HistoryRetentionContinuationReproductionDemand,
  next: ReproductionFactDemand,
): boolean {
  return previous.ownerId === next.ownerId
    && previous.createdAtMonth === next.createdAtMonth
    && previous.femaleId === next.femaleId
    && previous.agreementId === next.agreementId
    && previous.acceptedAtMonth === next.acceptedAtMonth
    && previous.dueAtMonth === next.dueAtMonth;
}

/**
 * Resumes from an exact checkpoint basis. Only events at absolute ordinals
 * [previous.target.eventCount, new target) may be folded afterwards.
 */
export function resumeHistoryRetentionProjection(
  previous: HistoryRetentionProjectionResult,
  newShell: SimulationState,
  newAuthority: HistoryRetentionAuthority,
  demandSnapshot?: HistoryRetentionDemandSnapshot,
): HistoryRetentionProjectionFold {
  assertHistoryRetentionAuthority(newAuthority, 'retention resumed projection ');
  const basis = validateHistoryRetentionContinuationBasis(previous);
  const nextTarget = shellHistorySeal(newShell);
  if (nextTarget.eventCount < basis.sourceTarget.eventCount
    || (nextTarget.eventCount === basis.sourceTarget.eventCount
      && nextTarget.tailEventId !== basis.sourceTarget.tailEventId)) {
    throw new Error('retention resumed projection 的新 seal 不是 checkpoint 的绝对后继');
  }
  if (basis.sourceTarget.eventCount > 0) {
    const newHotStart = newShell.world.historyCursor?.hotStartIndex ?? 0;
    if (newHotStart < basis.sourceTarget.eventCount) {
      const sourceTailInNewShell = newShell.world.past[basis.sourceTarget.eventCount - 1 - newHotStart];
      if (sourceTailInNewShell?.id !== basis.sourceTarget.tailEventId) {
        throw new Error('retention resumed projection 的可见 checkpoint tail 与 source seal 不一致');
      }
    }
  }
  const preparedDemand = demandSnapshot
    ? consumeHistoryRetentionDemandSnapshot(newShell, demandSnapshot)
    : undefined;
  const demand = preparedDemand?.demand ?? collectDemand(newShell);
  const fold = createOpenHistoryRetentionFold(
    newShell,
    newAuthority,
    demand,
    preparedDemand?.fingerprint,
  );
  fold.continuationSourceTarget = { ...basis.sourceTarget };
  fold.summary = cloneHistoryRetentionSummary(basis.summary);
  fold.minimalMechanicalTeachingWitness = basis.minimalMechanicalTeachingWitness
    ? { ...basis.minimalMechanicalTeachingWitness }
    : undefined;

  const previousDemandedIds = new Set(basis.sourceDemand.groups.flatMap((group) => group.eventIds));
  const previousDirectMatches = new Map(basis.directMatches.map((match) => [match.eventId, match]));
  for (const eventId of fold.directDemandEventIds) {
    const groups = [...fold.demandGroupsByKey.values()]
      .filter((group) => group.eventIds.has(eventId));
    const requiresVerifiedPrefixLookup = groups.some((group) => {
      const liveSocial = parseLivePersonSocialEvidenceGroupKey(group.groupKey);
      return ((group.groupKey === LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY
        || group.groupKey === FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY)
        || liveSocial?.kind === 'broad')
        && group.requirement === 'index-only';
    });
    const previousMatch = previousDirectMatches.get(eventId);
    if (previousDemandedIds.has(eventId) && previousMatch) {
      fold.directMatchesByEventId.set(eventId, { ...previousMatch });
    } else {
      // A match retained for another selector does not prove that it was the
      // latest occurrence of this ID in the cold prefix. New direct demand is
      // therefore suffix-only; otherwise continuation fails closed. Audit-only
      // selectors deliberately admit non-event source IDs (for example record
      // payload IDs), so a new member is matched when it occurs in the suffix
      // but is not blocking when no event exists.
      if (requiresVerifiedPrefixLookup
        || groups.some((group) => historyRetentionRequirementBlocks(group.requirement))) {
        fold.requiredSuffixDirectDemandEventIds.add(eventId);
      }
    }
  }

  const previousLivingIds = new Set(basis.sourceDemand.millLaborPersonIds);
  const ringsByPersonId = new Map(basis.millLaborRings.map((ring) => [ring.personId, ring.matches]));
  for (const personId of fold.millLaborPersonIds) {
    if (previousLivingIds.has(personId)) {
      const ring = ringsByPersonId.get(personId);
      if (ring) fold.millLaborRingsByPersonId.set(personId, ring.map((match) => ({ ...match })));
    } else if (fold.livingChildIds.has(personId)) {
      fold.newLivingPersonIdsRequiringBirth.add(personId);
    } else {
      throw new Error(`retention continuation gap dynamic-non-birth-person: ${personId}`);
    }
  }
  // Restore the complete checkpoint audience state before folding the suffix.
  // `newShell` describes the end of that suffix: an audience may operate and
  // only then die. Pruning against final living people here would silently lose
  // the teaching→operation join or count an already witnessed audience twice.
  // `buildHistoryRetentionContinuationBasis` prunes only after the suffix has
  // been consumed, when it constructs the next checkpoint basis.
  for (const pending of basis.pendingMechanicalTeachings) {
    fold.pendingMechanicalTeachingByAudienceId.set(pending.audienceId, {
      absoluteIndex: pending.absoluteIndex,
      eventId: pending.eventId,
    });
  }
  for (const audienceId of basis.witnessedMechanicalAudienceIds) {
    fold.witnessedMechanicalAudienceIds.add(audienceId);
  }

  const selectiveByLeaseKey = new Map(basis.selectiveMatches.map((item) => [item.leaseKey, item.matches]));
  const previousGroupsByKey = new Map(basis.sourceDemand.groups.map((group) => [group.groupKey, group]));
  const currentCalibrationLeaseKeys = new Set(
    [...fold.calibrationSelectorsByPersonId.values()].flatMap((items) => items.flatMap((item) => {
      const groupKey = `${item.leaseKey}${CALIBRATION_SOURCE_GROUP_SUFFIX}`;
      const previousGroup = previousGroupsByKey.get(groupKey);
      const currentGroup = fold.demandGroupsByKey.get(groupKey);
      return previousGroup && currentGroup
        && sameStringSet(previousGroup.eventIds, [...currentGroup.eventIds])
        ? [item.leaseKey]
        : [];
    })),
  );
  for (const [leaseKey, matches] of selectiveByLeaseKey) {
    if (leaseKey === MODERN_RECORD_EXPERIMENT_LEASE_KEY) {
      const expectedEventId = firstIndependentRecordReuseFact(
        fold.modernRecordValidationState,
      )?.id;
      const expected = matches.filter((match) => match.eventId === expectedEventId);
      if (expected.length === 1) {
        fold.selectiveMatchesByLeaseKey.set(leaseKey, expected.map((match) => ({ ...match })));
      }
      continue;
    }
    if (fold.waterAssistanceSelectiveLeaseKeys.has(leaseKey)) {
      const groupKey = waterAssistanceMembershipGroupKeyForLease(leaseKey);
      const previousGroup = groupKey ? previousGroupsByKey.get(groupKey) : undefined;
      const currentGroup = groupKey ? fold.demandGroupsByKey.get(groupKey) : undefined;
      if (previousGroup && currentGroup) {
        if (previousGroup.requirement !== 'index-only'
          || currentGroup.requirement !== 'index-only'
          || !sameStringSet(previousGroup.leaseKeys, [...currentGroup.leaseKeys])
          || previousGroup.eventIds.some((eventId) => !currentGroup.eventIds.has(eventId))) {
          throw new Error(`retention water assistance selector ${leaseKey} membership 非单调续接`);
        }
        fold.selectiveMatchesByLeaseKey.set(
          leaseKey,
          matches.map((match) => ({ ...match })),
        );
      }
      continue;
    }
    if (leaseKey === MODERN_ELECTRICAL_USEFUL_LOAD_LEASE_KEY
      || parseModernElectricalUsefulLoadLeaseKey(leaseKey) !== null) {
      fold.selectiveMatchesByLeaseKey.set(leaseKey, matches.map((match) => ({ ...match })));
      continue;
    }
    if (currentCalibrationLeaseKeys.has(leaseKey)) {
      fold.selectiveMatchesByLeaseKey.set(leaseKey, matches.map((match) => ({ ...match })));
      continue;
    }
    const groundedConversation = parseGroundedConversationWindowLeaseKey(leaseKey);
    if (groundedConversation
      && fold.millLaborPersonIds.has(groundedConversation.listenerId)
      && groundedConversation.eventMonth
        >= fold.productionWindowMonth - GROUNDED_CONVERSATION_RESPONSE_WINDOW_MONTHS
      && groundedConversation.eventMonth <= fold.productionWindowMonth) {
      fold.selectiveMatchesByLeaseKey.set(leaseKey, matches.map((match) => ({ ...match })));
      continue;
    }
    const production = parseRecentPersonalProductionLaborSelectorLeaseKey(leaseKey);
    if (!production
      || !fold.millLaborPersonIds.has(production.personId)
      || production.eventMonth < fold.productionWindowMonth - RECENT_PERSONAL_PRODUCTION_MONTHS
      || production.eventMonth > fold.productionWindowMonth) continue;
    fold.productionSelectorLeaseKeyByPersonId.set(production.personId, leaseKey);
    fold.selectiveMatchesByLeaseKey.set(leaseKey, matches.map((match) => ({ ...match })));
  }

  // One-time bridge from a legacy live-agreement audit group. Cold bodies are
  // visible here only after exact-root installation reclassified a strictly
  // verified helper/requester fact into the typed lease.
  const waterSelectorsByGroupKey = new Map<string, WaterAssistanceSelector>();
  for (const selectors of fold.waterAssistanceSelectorsByEventId.values()) {
    for (const selector of selectors) waterSelectorsByGroupKey.set(selector.membershipGroupKey, selector);
  }
  for (const selector of waterSelectorsByGroupKey.values()) {
    if (previousGroupsByKey.has(selector.membershipGroupKey)) continue;
    const legacyCoreKey = liveAgreementHistoryLeaseKey(selector.agreementId);
    const legacyMembership = new Set(basis.sourceDemand.groups
      .filter((group) => group.groupKey === legacyCoreKey
        || liveSupportingSourceCoreGroupKey(group.groupKey) === legacyCoreKey)
      .flatMap((group) => group.eventIds));
    for (const eventId of selector.fulfillmentEventIds) {
      if (!legacyMembership.has(eventId)) continue;
      const match = previousDirectMatches.get(eventId);
      if (!match || match.absoluteIndex >= basis.sourceTarget.eventCount) continue;
      const event = worldEventByIdWithRetainedLease(
        newShell,
        eventId,
        selector.helperLeaseKey,
      ) ?? worldEventByIdWithRetainedLease(
        newShell,
        eventId,
        selector.requesterLeaseKey,
      );
      if (event?.kind !== 'action') continue;
      if (isHelperWaterAssistanceEvidence(newShell, selector.proposal, event)) {
        setLatestSelectiveMatch(fold, selector.helperLeaseKey, { ...match });
      }
      if (isRequesterWaterAssistanceEvidence(selector.proposal, event)) {
        setLatestSelectiveMatch(fold, selector.requesterLeaseKey, { ...match });
      }
    }
  }
  const previousPredictionIds = new Set(basis.sourceDemand.pendingEraPredictionIds);
  for (const predictionId of fold.pendingEraPredictionIds) {
    if (!previousPredictionIds.has(predictionId)) {
      // A newly-created prediction has no valid disputed-wake facts in the
      // checkpoint prefix: rehydrate can only reference a prediction already
      // present in authoritative state. Prove that causal boundary explicitly
      // from the verified suffix instead of forcing a genesis replay.
      fold.newPendingEraPredictionIdsRequiringCreation.add(predictionId);
      continue;
    }
    const leaseKey = pendingEraPredictionWakeLeaseKey(predictionId);
    const matches = selectiveByLeaseKey.get(leaseKey);
    if (matches) fold.selectiveMatchesByLeaseKey.set(leaseKey, matches.map((match) => ({ ...match })));
  }
  const birthsByChildId = new Map(basis.livingChildBirthMatches.map((item) => [item.childId, item.match]));
  const previousChildIds = new Set(basis.sourceDemand.livingChildIds);
  for (const childId of fold.livingChildIds) {
    if (!previousChildIds.has(childId)) continue;
    const match = birthsByChildId.get(childId);
    if (!match) throw new Error(`retention continuation living child ${childId} 缺少 birth basis`);
    fold.livingChildBirthMatchesByChildId.set(childId, { ...match });
  }

  const previousReproductionById = new Map(basis.sourceDemand.reproductionFacts
    .map((item) => [item.intentId, item]));
  const previousAttemptsByIntentId = new Map(basis.reproductionAttempts
    .map((item) => [item.intentId, item.resolved]));
  for (const item of fold.reproductionFactsByIntentId.values()) {
    const previousDemand = previousReproductionById.get(item.intentId);
    if (!previousDemand) {
      const sourceGroup = fold.demandGroupsByKey.get(`active-reproduction-intent:${item.intentId}:facts`);
      const previousLiveIntentGroup = previousGroupsByKey.get(
        liveIntentHistoryLeaseKey(item.intentId),
      );
      for (const eventId of sourceGroup?.eventIds ?? []) {
        const previousMatch = previousDirectMatches.get(eventId);
        const restoredMatch = fold.directMatchesByEventId.get(eventId);
        const promotedFromStrictLiveIntent = previousLiveIntentGroup?.requirement === 'all'
          && previousLiveIntentGroup.eventIds.includes(eventId)
          && previousMatch?.eventId === eventId
          && restoredMatch?.eventId === eventId
          && restoredMatch.absoluteIndex === previousMatch.absoluteIndex;
        if (promotedFromStrictLiveIntent) continue;
        fold.requiredSuffixDirectDemandEventIds.add(eventId);
        fold.requiredSuffixReproductionAnchorEventIds.add(eventId);
        fold.directMatchesByEventId.delete(eventId);
      }
      continue;
    }
    if (!sameReproductionSelectorIdentity(previousDemand, item)) {
      throw new Error(`retention continuation gap mutated-reproduction-selector: ${item.intentId}`);
    }
    const currentAttemptIds = item.attemptEventIds;
    // An empty attempt-ID selector means the gameplay reverse-find accepted any
    // matching prefix reproduction fact. Once an ID appears, or any later ID is
    // added, the same prefix must be reselected under a different predicate.
    // Until the closed wrapper persists a proof of prefix absence/last-write,
    // every set change fails rather than reusing a formerly unrestricted latest
    // conception or attempt.
    if (previousDemand.attemptEventIds.length !== currentAttemptIds.size
      || previousDemand.attemptEventIds.some((eventId) => !currentAttemptIds.has(eventId))) {
      throw new Error(`retention continuation gap mutated-reproduction-selector: ${item.intentId} attempt ID 集发生变化`);
    }
    for (const resolved of previousAttemptsByIntentId.get(item.intentId) ?? []) {
      if (!currentAttemptIds.has(resolved.eventId)
        || item.resolvedAttemptEventIds.has(resolved.eventId)
        || item.attemptMonths.has(resolved.atMonth)
        || item.acceptedAtMonth === null
        || item.dueAtMonth === null
        || resolved.atMonth < item.acceptedAtMonth
        || resolved.atMonth > item.dueAtMonth) {
        throw new Error(`retention continuation reproduction attempt ${resolved.eventId} 无法续接`);
      }
      item.resolvedAttemptEventIds.add(resolved.eventId);
      item.attemptMonths.add(resolved.atMonth);
      item.resolvedAttemptMonthsByEventId.set(resolved.eventId, resolved.atMonth);
    }
    for (const leaseKey of [reproductionAttemptLeaseKey(item.intentId), reproductionConceptionLeaseKey(item.intentId)]) {
      const matches = selectiveByLeaseKey.get(leaseKey);
      if (matches) fold.selectiveMatchesByLeaseKey.set(leaseKey, matches.map((match) => ({ ...match })));
    }
  }
  return fold;
}

/**
 * Storage-schema migration seam. A checkpoint written before the active
 * logistics index existed cannot already carry those exact prefix ordinals.
 * Callers may resolve only this explicit index-only bridge from a fully
 * verified previous history root; ordinary strict demand remains suffix-only.
 */
export function unresolvedVerifiedPrefixLogisticsIndexEventIds(
  fold: HistoryRetentionProjectionFold,
): string[] {
  if (fold.status !== 'open') throw new Error('retention prefix logistics bridge 只接受 open fold');
  const group = fold.demandGroupsByKey.get(FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_LEASE_KEY);
  if (!group || group.requirement !== 'index-only') return [];
  return [...fold.requiredSuffixDirectDemandEventIds]
    .filter((eventId) => group.eventIds.has(eventId) && !fold.directMatchesByEventId.has(eventId))
    .sort();
}

export function seedVerifiedPrefixLogisticsIndexMatches(
  fold: HistoryRetentionProjectionFold,
  verifiedSourceEventCount: number,
  matches: readonly HistoryRetentionContinuationMatch[],
): void {
  if (fold.status !== 'open') throw new Error('retention prefix logistics bridge 只接受 open fold');
  const sourceTarget = fold.continuationSourceTarget;
  if (!sourceTarget || verifiedSourceEventCount !== sourceTarget.eventCount) {
    throw new Error('retention prefix logistics bridge 与 continuation source seal 不一致');
  }
  const group = fold.demandGroupsByKey.get(FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_LEASE_KEY);
  if (!group || group.requirement !== 'index-only') {
    if (matches.length === 0) return;
    throw new Error('retention prefix logistics bridge 缺少 index-only demand');
  }
  const seen = new Set<string>();
  for (const match of matches) {
    if (seen.has(match.eventId)
      || !group.eventIds.has(match.eventId)
      || !fold.requiredSuffixDirectDemandEventIds.has(match.eventId)
      || !Number.isSafeInteger(match.absoluteIndex)
      || match.absoluteIndex < 0
      || match.absoluteIndex >= sourceTarget.eventCount) {
      throw new Error(`retention prefix logistics bridge match ${match.eventId} 无效`);
    }
    seen.add(match.eventId);
    fold.directMatchesByEventId.set(match.eventId, { ...match });
    fold.requiredSuffixDirectDemandEventIds.delete(match.eventId);
  }
}

/**
 * A newly remembered proposal can expose an older agreement outcome source.
 * Resolve that identity only from the fully verified previous history root;
 * unlike project-pressure provenance, every named source must be a real event.
 */
export function unresolvedVerifiedPrefixSocialRepetitionIndexEventIds(
  fold: HistoryRetentionProjectionFold,
): string[] {
  if (fold.status !== 'open') {
    throw new Error('retention prefix social-repetition bridge 只接受 open fold');
  }
  const group = fold.demandGroupsByKey.get(FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY);
  if (!group || group.requirement !== 'index-only') return [];
  return [...fold.requiredSuffixDirectDemandEventIds]
    .filter((eventId) => group.eventIds.has(eventId)
      && !fold.directMatchesByEventId.has(eventId))
    .sort();
}

export function seedVerifiedPrefixSocialRepetitionIndexMatches(
  fold: HistoryRetentionProjectionFold,
  verifiedSourceEventCount: number,
  matches: readonly HistoryRetentionContinuationMatch[],
): void {
  if (fold.status !== 'open') {
    throw new Error('retention prefix social-repetition bridge 只接受 open fold');
  }
  const sourceTarget = fold.continuationSourceTarget;
  if (!sourceTarget || verifiedSourceEventCount !== sourceTarget.eventCount) {
    throw new Error('retention prefix social-repetition bridge 与 continuation source seal 不一致');
  }
  const group = fold.demandGroupsByKey.get(FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY);
  if (!group || group.requirement !== 'index-only') {
    if (matches.length === 0) return;
    throw new Error('retention prefix social-repetition bridge 缺少 index-only demand');
  }
  const seen = new Set<string>();
  for (const match of matches) {
    if (seen.has(match.eventId)
      || !group.eventIds.has(match.eventId)
      || !fold.requiredSuffixDirectDemandEventIds.has(match.eventId)
      || !Number.isSafeInteger(match.absoluteIndex)
      || match.absoluteIndex < 0
      || match.absoluteIndex >= sourceTarget.eventCount) {
      throw new Error(`retention prefix social-repetition bridge match ${match.eventId} 无效`);
    }
    seen.add(match.eventId);
    fold.directMatchesByEventId.set(match.eventId, { ...match });
    fold.requiredSuffixDirectDemandEventIds.delete(match.eventId);
  }
}

/**
 * A living person's broad social membership may first name an old cold event,
 * or retain an unresolved non-event source ID from an older sidecar. Only an
 * exact previous-root scan may distinguish the two. Matching identities seed
 * the resumed fold; searched non-events remain unresolved index-only members.
 */
export function unresolvedVerifiedPrefixLiveSocialIndexEventIds(
  fold: HistoryRetentionProjectionFold,
): string[] {
  if (fold.status !== 'open') {
    throw new Error('retention prefix live-social bridge 只接受 open fold');
  }
  const eligibleEventIds = new Set([...fold.demandGroupsByKey.values()]
    .filter((group) => {
      const parsed = parseLivePersonSocialEvidenceGroupKey(group.groupKey);
      return parsed?.kind === 'broad' && group.requirement === 'index-only';
    })
    .flatMap((group) => [...group.eventIds]));
  return [...fold.requiredSuffixDirectDemandEventIds]
    .filter((eventId) => eligibleEventIds.has(eventId)
      && !fold.directMatchesByEventId.has(eventId))
    .sort();
}

export function seedVerifiedPrefixLiveSocialIndexMatches(
  fold: HistoryRetentionProjectionFold,
  verifiedSourceEventCount: number,
  searchedEventIds: readonly string[],
  matches: readonly HistoryRetentionContinuationMatch[],
): void {
  if (fold.status !== 'open') {
    throw new Error('retention prefix live-social bridge 只接受 open fold');
  }
  const sourceTarget = fold.continuationSourceTarget;
  if (!sourceTarget || verifiedSourceEventCount !== sourceTarget.eventCount) {
    throw new Error('retention prefix live-social bridge 与 continuation source seal 不一致');
  }
  const broadGroups = [...fold.demandGroupsByKey.values()].filter((group) => {
    const parsed = parseLivePersonSocialEvidenceGroupKey(group.groupKey);
    return parsed?.kind === 'broad' && group.requirement === 'index-only';
  });
  const eligibleEventIds = new Set(broadGroups.flatMap((group) => [...group.eventIds]));
  if (eligibleEventIds.size === 0) {
    if (searchedEventIds.length === 0 && matches.length === 0) return;
    throw new Error('retention prefix live-social bridge 缺少 living-owner broad demand');
  }
  const searched = new Set<string>();
  for (const eventId of searchedEventIds) {
    const existing = fold.directMatchesByEventId.get(eventId);
    if (searched.has(eventId)
      || !eligibleEventIds.has(eventId)
      || (!fold.requiredSuffixDirectDemandEventIds.has(eventId) && !existing)) {
      throw new Error(`retention prefix live-social searched ID ${eventId} 无效`);
    }
    searched.add(eventId);
  }
  const matched = new Set<string>();
  for (const match of matches) {
    const existing = fold.directMatchesByEventId.get(match.eventId);
    if (matched.has(match.eventId)
      || !searched.has(match.eventId)
      || !Number.isSafeInteger(match.absoluteIndex)
      || match.absoluteIndex < 0
      || match.absoluteIndex >= sourceTarget.eventCount
      || (existing && (existing.eventId !== match.eventId
        || existing.absoluteIndex !== match.absoluteIndex))) {
      throw new Error(`retention prefix live-social match ${match.eventId} 无效`);
    }
    matched.add(match.eventId);
    fold.directMatchesByEventId.set(match.eventId, { ...match });
    fold.requiredSuffixDirectDemandEventIds.delete(match.eventId);
  }
  for (const eventId of searched) {
    if (matched.has(eventId)) continue;
    const belongsToBlockingDemand = [...fold.demandGroupsByKey.values()].some((group) => (
      group.eventIds.has(eventId) && historyRetentionRequirementBlocks(group.requirement)
    ));
    if (!belongsToBlockingDemand) fold.requiredSuffixDirectDemandEventIds.delete(eventId);
  }
}

/**
 * New broad project-pressure provenance may legitimately name an older event
 * or a non-event record ID. A verified prefix scan distinguishes those cases:
 * every matching event is seeded, while searched non-events remain unresolved
 * index identity rather than becoming a false blocker.
 */
export function unresolvedVerifiedPrefixProjectPressureIndexEventIds(
  fold: HistoryRetentionProjectionFold,
): string[] {
  if (fold.status !== 'open') {
    throw new Error('retention prefix project-pressure bridge 只接受 open fold');
  }
  const group = fold.demandGroupsByKey.get(LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY);
  if (!group || group.requirement !== 'index-only') return [];
  return [...fold.requiredSuffixDirectDemandEventIds]
    .filter((eventId) => group.eventIds.has(eventId)
      && !fold.directMatchesByEventId.has(eventId))
    .sort();
}

export function seedVerifiedPrefixProjectPressureIndexMatches(
  fold: HistoryRetentionProjectionFold,
  verifiedSourceEventCount: number,
  searchedEventIds: readonly string[],
  matches: readonly HistoryRetentionContinuationMatch[],
): void {
  if (fold.status !== 'open') {
    throw new Error('retention prefix project-pressure bridge 只接受 open fold');
  }
  const sourceTarget = fold.continuationSourceTarget;
  if (!sourceTarget || verifiedSourceEventCount !== sourceTarget.eventCount) {
    throw new Error('retention prefix project-pressure bridge 与 continuation source seal 不一致');
  }
  const group = fold.demandGroupsByKey.get(LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY);
  if (!group || group.requirement !== 'index-only') {
    if (searchedEventIds.length === 0 && matches.length === 0) return;
    throw new Error('retention prefix project-pressure bridge 缺少 index-only demand');
  }
  const searched = new Set<string>();
  for (const eventId of searchedEventIds) {
    if (searched.has(eventId)
      || !group.eventIds.has(eventId)
      || !fold.requiredSuffixDirectDemandEventIds.has(eventId)
      || fold.directMatchesByEventId.has(eventId)) {
      throw new Error(`retention prefix project-pressure searched ID ${eventId} 无效`);
    }
    searched.add(eventId);
  }
  const matched = new Set<string>();
  for (const match of matches) {
    if (matched.has(match.eventId)
      || !searched.has(match.eventId)
      || !Number.isSafeInteger(match.absoluteIndex)
      || match.absoluteIndex < 0
      || match.absoluteIndex >= sourceTarget.eventCount) {
      throw new Error(`retention prefix project-pressure match ${match.eventId} 无效`);
    }
    matched.add(match.eventId);
    fold.directMatchesByEventId.set(match.eventId, { ...match });
  }
  for (const eventId of searched) fold.requiredSuffixDirectDemandEventIds.delete(eventId);
}

/**
 * One-time storage migration for checkpoints written before the recent
 * terminal-failure lease existed. Only IDs already named by a canonical
 * living-owner failure group may be resolved from the verified previous root.
 */
export function unresolvedVerifiedPrefixRecentTerminalFailureActionEventIds(
  fold: HistoryRetentionProjectionFold,
): string[] {
  if (fold.status !== 'open') {
    throw new Error('retention prefix terminal failure bridge 只接受 open fold');
  }
  const eligibleEventIds = new Set([...fold.demandGroupsByKey.values()]
    .filter((group) => parseRecentTerminalFailureActionLeaseKey(group.groupKey) !== null
      && group.requirement === 'all')
    .flatMap((group) => [...group.eventIds]));
  return [...fold.requiredSuffixDirectDemandEventIds]
    .filter((eventId) => eligibleEventIds.has(eventId)
      && !fold.directMatchesByEventId.has(eventId))
    .sort();
}

export function seedVerifiedPrefixRecentTerminalFailureActionMatches(
  fold: HistoryRetentionProjectionFold,
  verifiedSourceEventCount: number,
  matches: readonly HistoryRetentionContinuationMatch[],
): void {
  if (fold.status !== 'open') {
    throw new Error('retention prefix terminal failure bridge 只接受 open fold');
  }
  const sourceTarget = fold.continuationSourceTarget;
  if (!sourceTarget || verifiedSourceEventCount !== sourceTarget.eventCount) {
    throw new Error('retention prefix terminal failure bridge 与 continuation source seal 不一致');
  }
  const eligibleEventIds = new Set([...fold.demandGroupsByKey.values()]
    .filter((group) => parseRecentTerminalFailureActionLeaseKey(group.groupKey) !== null
      && group.requirement === 'all')
    .flatMap((group) => [...group.eventIds]));
  if (eligibleEventIds.size === 0) {
    if (matches.length === 0) return;
    throw new Error('retention prefix terminal failure bridge 缺少 exact demand');
  }
  const seen = new Set<string>();
  for (const match of matches) {
    if (seen.has(match.eventId)
      || !eligibleEventIds.has(match.eventId)
      || !fold.requiredSuffixDirectDemandEventIds.has(match.eventId)
      || !Number.isSafeInteger(match.absoluteIndex)
      || match.absoluteIndex < 0
      || match.absoluteIndex >= sourceTarget.eventCount) {
      throw new Error(`retention prefix terminal failure bridge match ${match.eventId} 无效`);
    }
    seen.add(match.eventId);
    fold.directMatchesByEventId.set(match.eventId, { ...match });
    fold.requiredSuffixDirectDemandEventIds.delete(match.eventId);
  }
}

/**
 * One-time storage migration for checkpoints written before person-local
 * social-learning leases existed. Only IDs already named by an exact living
 * observer group can be looked up in the fully verified previous root.
 */
export function unresolvedVerifiedPrefixSocialLearningSourceEventIds(
  fold: HistoryRetentionProjectionFold,
): string[] {
  if (fold.status !== 'open') {
    throw new Error('retention prefix social learning bridge 只接受 open fold');
  }
  const eligibleEventIds = new Set([...fold.demandGroupsByKey.values()]
    .filter((group) => parseSocialLearningSourceLeaseKey(group.groupKey) !== null
      && group.requirement === 'all')
    .flatMap((group) => [...group.eventIds]));
  return [...fold.requiredSuffixDirectDemandEventIds]
    .filter((eventId) => eligibleEventIds.has(eventId)
      && !fold.directMatchesByEventId.has(eventId))
    .sort();
}

export function seedVerifiedPrefixSocialLearningSourceMatches(
  fold: HistoryRetentionProjectionFold,
  verifiedSourceEventCount: number,
  matches: readonly HistoryRetentionContinuationMatch[],
): void {
  if (fold.status !== 'open') {
    throw new Error('retention prefix social learning bridge 只接受 open fold');
  }
  const sourceTarget = fold.continuationSourceTarget;
  if (!sourceTarget || verifiedSourceEventCount !== sourceTarget.eventCount) {
    throw new Error('retention prefix social learning bridge 与 continuation source seal 不一致');
  }
  const eligibleEventIds = new Set([...fold.demandGroupsByKey.values()]
    .filter((group) => parseSocialLearningSourceLeaseKey(group.groupKey) !== null
      && group.requirement === 'all')
    .flatMap((group) => [...group.eventIds]));
  if (eligibleEventIds.size === 0) {
    if (matches.length === 0) return;
    throw new Error('retention prefix social learning bridge 缺少 exact demand');
  }
  const seen = new Set<string>();
  for (const match of matches) {
    if (seen.has(match.eventId)
      || !eligibleEventIds.has(match.eventId)
      || !fold.requiredSuffixDirectDemandEventIds.has(match.eventId)
      || !Number.isSafeInteger(match.absoluteIndex)
      || match.absoluteIndex < 0
      || match.absoluteIndex >= sourceTarget.eventCount) {
      throw new Error(`retention prefix social learning bridge match ${match.eventId} 无效`);
    }
    seen.add(match.eventId);
    fold.directMatchesByEventId.set(match.eventId, { ...match });
    fold.requiredSuffixDirectDemandEventIds.delete(match.eventId);
  }
}

export function finishHistoryRetentionProjection(fold: HistoryRetentionProjectionFold): HistoryRetentionProjectionResult {
  if (fold.status === 'finished' && fold.finishedResult) return fold.finishedResult;
  if (fold.status !== 'open') throw new Error('retention projection fold 已丢弃');
  try {
    const reduced = fold.summary.reducedThrough;
    if (reduced.eventCount !== fold.target.eventCount || reduced.tailEventId !== fold.target.tailEventId) {
      return failFold(fold, `retention projection 未通过绝对 seal：期望 ${fold.target.eventCount}/${String(fold.target.tailEventId)}，收到 ${reduced.eventCount}/${String(reduced.tailEventId)}`);
    }
    const suffixStart = fold.continuationSourceTarget?.eventCount;
    if (suffixStart !== undefined) {
      for (const eventId of fold.requiredSuffixDirectDemandEventIds) {
        const match = fold.directMatchesByEventId.get(eventId);
        if (!match || match.absoluteIndex < suffixStart) {
          const demandGroups = [...fold.demandGroupsByKey.values()]
            .filter((group) => group.eventIds.has(eventId))
            .map((group) => group.groupKey)
            .sort();
          return failFold(
            fold,
            `retention continuation 新 demand ${eventId} 无法由 suffix 解析`
              + `（groups=${demandGroups.join(',') || 'unknown'}）`,
          );
        }
      }
      for (const eventId of fold.requiredSuffixReproductionAnchorEventIds) {
        const match = fold.directMatchesByEventId.get(eventId);
        if (!match || match.absoluteIndex < suffixStart) {
          return failFold(fold, `retention continuation reproduction anchor ${eventId} 不在 suffix`);
        }
      }
      for (const personId of fold.newLivingPersonIdsRequiringBirth) {
        const match = fold.livingChildBirthMatchesByChildId.get(personId);
        if (!match || match.absoluteIndex < suffixStart) {
          return failFold(fold, `retention continuation 新人物 ${personId} 缺少 suffix 出生事实`);
        }
      }
      for (const predictionId of fold.newPendingEraPredictionIdsRequiringCreation) {
        const match = fold.pendingEraPredictionCreationMatchesById.get(predictionId);
        const sourceGroup = fold.demandGroupsByKey.get(
          `pending-era-prediction:${predictionId}:source`,
        );
        if (!match
          || match.absoluteIndex < suffixStart
          || !sourceGroup?.eventIds.has(match.eventId)) {
          return failFold(
            fold,
            `retention continuation 新 pending prediction ${predictionId} 缺少 suffix 权威创建事实`,
          );
        }
      }
    }
    for (const demand of fold.reproductionFactsByIntentId.values()) {
      if (demand.resolvedAttemptEventIds.size !== demand.attemptEventIds.size) {
        return failFold(fold, `reproduction intent ${demand.intentId} 缺少 agreement attempt 权威事实`);
      }
      if (demand.attemptMonths.size > 0
        && Math.max(...demand.attemptMonths) !== demand.lastAttemptAtMonth) {
        return failFold(fold, `reproduction intent ${demand.intentId} 的最后尝试月份与权威事实不一致`);
      }
    }
    const pins = new Map<number, HistoryRetentionPin>();
    const demandGroups: HistoryRetentionDemandGroupResult[] = [];
    const unresolvedDemands: UnresolvedHistoryRetentionDemand[] = [];
    for (const group of [...fold.demandGroupsByKey.values()].sort((left, right) => left.groupKey.localeCompare(right.groupKey))) {
      const eventIds = [...group.eventIds];
      const matches = eventIds.flatMap((eventId) => {
        const match = fold.directMatchesByEventId.get(eventId);
        return match ? [match] : [];
      }).sort((left, right) => left.absoluteIndex - right.absoluteIndex);
      const resolvedIds = new Set(matches.map((match) => match.eventId));
      const unresolvedIds = eventIds.filter((eventId) => !resolvedIds.has(eventId));
      const satisfied = group.requirement === 'any' ? matches.length > 0 : unresolvedIds.length === 0;
      const blocking = historyRetentionRequirementBlocks(group.requirement) && !satisfied;
      const leases = [...group.leaseKeys].sort();
      const pinMatches = historyRetentionRequirementPinsResolvedEvents(group.requirement)
        ? group.requirement === 'any' ? matches.slice(-1) : matches
        : [];
      for (const match of pinMatches) addPin(pins, match, leases);
      for (const eventId of unresolvedIds) unresolvedDemands.push({
        eventId, leaseKeys: leases, requirement: group.requirement, groupKey: group.groupKey, blocking,
      });
      demandGroups.push({
        groupKey: group.groupKey, requirement: group.requirement, leaseKeys: leases, eventIds,
        resolvedEventIds: [...resolvedIds], unresolvedEventIds: unresolvedIds, satisfied, blocking,
      });
    }
    const witness = fold.minimalMechanicalTeachingWitness;
    if (witness) {
      const base = `mechanical-teaching-operation-witness:${witness.audienceId}`;
      addPin(pins, { absoluteIndex: witness.teachingAbsoluteIndex, eventId: witness.teachingEventId }, [`${base}:teaching`]);
      addPin(pins, { absoluteIndex: witness.operationAbsoluteIndex, eventId: witness.operationEventId }, [`${base}:operation`]);
    }
    for (const [personId, ring] of fold.millLaborRingsByPersonId) {
      for (const match of ring) addPin(pins, match, [`living-mill-labor:${personId}:recent-3`]);
    }
    for (const childId of [...fold.livingChildIds].sort()) {
      const match = fold.livingChildBirthMatchesByChildId.get(childId);
      if (!match) return failFold(fold, `living child ${childId} 缺少权威出生事实`);
      addPin(pins, match, [livingChildBirthLeaseKey(childId)]);
    }
    for (const [leaseKey, matches] of fold.selectiveMatchesByLeaseKey) {
      const production = parseRecentPersonalProductionLaborSelectorLeaseKey(leaseKey);
      const leases = production
        ? [leaseKey, recentPersonalProductionLaborLeaseKey(production.personId)]
        : [leaseKey];
      for (const match of matches) addPin(pins, match, leases);
    }
    const continuationBasis = buildHistoryRetentionContinuationBasis(fold);
    const result: HistoryRetentionProjectionResult = {
      schemaVersion: 1, authority: { ...fold.authority }, target: { ...fold.target },
      demandFingerprint: fold.demandFingerprint,
      millLaborPersonIds: [...fold.millLaborPersonIds].sort(),
      pins: [...pins.values()].sort((left, right) => left.absoluteIndex - right.absoluteIndex),
      demandGroups,
      unresolvedDemands: unresolvedDemands.sort((left, right) => left.groupKey.localeCompare(right.groupKey)
        || left.eventId.localeCompare(right.eventId)),
      minimalMechanicalTeachingWitness: witness ? { ...witness } : null,
      summary: { ...fold.summary, reducedThrough: { ...fold.summary.reducedThrough }, mechanicalP0: { ...fold.summary.mechanicalP0 } },
      continuationReady: false,
      continuationGaps: CONTINUATION_GAPS.map((gap) => ({ ...gap })),
      continuationBasis,
    };
    fold.status = 'finished';
    fold.finishedResult = result;
    return result;
  } catch (error) {
    discardFold(fold);
    throw error;
  }
}
