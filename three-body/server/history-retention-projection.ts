import { createHash } from 'node:crypto';
import type { ActionFact, SimulationState, WorldEvent } from '../src/game/eland/domain/model';
import { Material } from '../src/game/eland/domain/material';
import { isValidPersonalMassCalibrationFactForInstrument } from '../src/game/eland/domain/actions/measurement-actions';
import {
  isCompletedPersonalProductionLaborEvent,
  parseRecentPersonalProductionLaborSelectorLeaseKey,
  RECENT_PERSONAL_PRODUCTION_MONTHS,
  recentPersonalProductionLaborLeaseKey,
  recentPersonalProductionLaborSelectorLeaseKey,
} from '../src/game/eland/domain/production-tool';
import {
  MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
} from '../src/game/eland/domain/mechanical-power';
import {
  ELECTRICAL_POWER_RECENT_EVENT_LIMIT,
  ELECTRICAL_POWER_SOURCE_EVENT_LIMIT,
} from '../src/game/eland/domain/electrical-power';
import {
  GROUNDED_CONVERSATION_RESPONSE_WINDOW_MONTHS,
  groundedConversationWindowLeaseKey,
  liveAgreementHistoryLeaseKey,
  liveIntentHistoryLeaseKey,
  parseGroundedConversationWindowLeaseKey,
  parseWaterAssistanceEvidenceLeaseKey,
  parseWaterAssistanceFulfillmentMembershipGroupKey,
  waterAssistanceFulfillmentMembershipGroupKey,
  worldEventByIdWithRetainedLease,
} from '../src/game/eland/domain/event-index';
import {
  isHelperWaterAssistanceEvidence,
  isRequesterWaterAssistanceEvidence,
} from '../src/game/eland/domain/agreement';
import {
  livePersonSocialEvidenceGroupKey,
  livePersonSocialEvidenceLeaseKey,
  livePersonSocialStrictEvidenceLeaseKey,
  parseLivePersonSocialEvidenceGroupKey,
} from '../src/game/eland/domain/live-social-evidence';
import {
  MODERN_ELECTRICAL_USEFUL_LOAD_LEASE_KEY,
  MODERN_RECORD_EXPERIMENT_LEASE_KEY,
  firstIndependentRecordReuseFact,
  isIndependentRecordReuseFact,
  isModernElectricalUsefulLoadFact,
  modernElectricalUsefulLoadLeaseKey,
  parseModernElectricalUsefulLoadLeaseKey,
} from '../src/game/eland/domain/era-progression';
import {
  FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_LEASE_KEY,
  FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY,
  CALIBRATION_SOURCE_GROUP_SUFFIX,
  HISTORY_RETENTION_MAX_ACTIVE_PROJECT_ACTION_EVENT_IDS,
  HISTORY_RETENTION_MAX_COMPLETED_LIVE_PROJECTS,
  HISTORY_RETENTION_MAX_COMPLETED_PROJECT_SOURCE_EVENT_IDS,
  HISTORY_RETENTION_MAX_ELECTRICAL_MAINTENANCE_PROJECT_EVENT_IDS,
  HISTORY_RETENTION_MAX_FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_EVENT_IDS,
  HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_SOURCE_EVENT_IDS,
  HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_SOURCE_GROUPS,
  HISTORY_RETENTION_MAX_GROUNDED_RESPONSE_UNIQUE_EVENT_IDS,
  HISTORY_RETENTION_MAX_LIVE_GAMEPLAY_SELECTOR_PERSONS,
  HISTORY_RETENTION_MAX_LIVE_INTENT_CORE_EVENT_IDS,
  HISTORY_RETENTION_MAX_LIVE_PERSON_SOCIAL_EVENT_IDS,
  HISTORY_RETENTION_MAX_LIVING_SHARED_PROJECT_PAIRS,
  HISTORY_RETENTION_MAX_PENDING_PREDICTION_WAKE_MATCHES,
  HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_PER_PERSON,
  HISTORY_RETENTION_MAX_RECENT_TERMINAL_FAILURE_EVENT_IDS_TOTAL,
  HISTORY_RETENTION_MAX_REPRODUCTION_ATTEMPT_EVENT_IDS,
  HISTORY_RETENTION_MAX_SOCIAL_LEARNING_EVENT_IDS_PER_PERSON,
  HISTORY_RETENTION_MAX_SOCIAL_LEARNING_EVENT_IDS_TOTAL,
  HISTORY_RETENTION_REQUIREMENTS,
  LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY,
  assertLiveIntentHistoryRetentionDemandGroups,
  assertLiveIntentRawSplitMatchesCanonicalDemand,
  assertProjectPressureHistoryRetentionDemandGroups,
  calibrationLeaseKeysFromDemandGroups,
  compatibilityCanonicalDemandGroups,
  historyRetentionDemandFingerprint,
  historyRetentionRequirementBlocks,
  historyRetentionRequirementPinsResolvedEvents,
  liveSupportingSourceCoreGroupKey,
  parseGroundedConversationResponseSourceLeaseKey,
  parseRecentTerminalFailureActionLeaseKey,
  parseSocialLearningSourceLeaseKey,
  productionWindowMonthFromDemandGroups,
  sameStringSet,
  waterAssistanceSelectiveLeaseKeysFromDemandGroups,
  type HistoryRetentionAuthority,
  type HistoryRetentionContinuationBasis,
  type HistoryRetentionContinuationDemand,
  type HistoryRetentionContinuationDemandGroup,
  type HistoryRetentionContinuationGap,
  type HistoryRetentionContinuationMatch,
  type HistoryRetentionContinuationReproductionDemand,
  type HistoryRetentionDemandGroupResult,
  type HistoryRetentionPin,
  type HistoryRetentionProjectionResult,
  type HistoryRetentionSeal,
  type HistoryRetentionSummary,
  type MechanicalP0HistoryCounts,
  type MechanicalTeachingOperationWitness,
  type UnresolvedHistoryRetentionDemand,
} from './history-retention-contract';
import {
  collectHistoryRetentionDemand,
  livingChildBirthLeaseKey,
  pendingEraPredictionWakeLeaseKey,
  reproductionAttemptLeaseKey,
  reproductionConceptionLeaseKey,
  requiredEventId,
  type CalibrationSelector,
  type DirectDemandGroup,
  type HistoryRetentionCollectedDemand,
  type ReproductionFactDemand,
  type WaterAssistanceSelector,
} from './history-retention-demand-collector';

export * from './history-retention-contract';
export {
  completedLiveProjectCompletionLeaseKey,
  historyRetentionDemandCollectionStatsForTests,
  historyRetentionIntentTraversalStatsForTests,
  livingSharedProjectActionLeaseKey,
  resetHistoryRetentionDemandCollectionCountForTests,
  resetHistoryRetentionIntentTraversalStatsForTests,
} from './history-retention-demand-collector';

/** Server-only shadow projection. Nothing here is readable by domain planning. */

interface DirectPinMatch { absoluteIndex: number; eventId: string }
interface PendingMechanicalTeaching { absoluteIndex: number; eventId: string }

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
let historyRetentionResumeDemandGroupMembershipCheckCount = 0;

type ProjectPressureDemandGroupShape = Pick<
  HistoryRetentionContinuationDemandGroup,
  'groupKey' | 'requirement' | 'leaseKeys' | 'eventIds'
>;

function waterAssistanceMembershipGroupKeyForLease(leaseKey: string): string | null {
  const parsed = parseWaterAssistanceEvidenceLeaseKey(leaseKey);
  return parsed ? waterAssistanceFulfillmentMembershipGroupKey(
    parsed.agreementId,
    parsed.requesterId,
    parsed.helperId,
  ) : null;
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

function collectDemand(
  state: SimulationState,
  intentCollectionMode: 'snapshot' | 'reference' = 'snapshot',
): HistoryRetentionCollectedDemand {
  return collectHistoryRetentionDemand(
    state,
    () => shellHistorySeal(state),
    intentCollectionMode,
  );
}

/** Test/benchmark observability only; counters never enter authoritative state. */
export function resetHistoryRetentionResumeLookupStatsForTests(): void {
  historyRetentionResumeDemandGroupMembershipCheckCount = 0;
}

/** Test/benchmark observability only; counters never enter authoritative state. */
export function historyRetentionResumeLookupStatsForTests(): Readonly<{
  demandGroupMembershipChecks: number;
}> {
  return Object.freeze({
    demandGroupMembershipChecks: historyRetentionResumeDemandGroupMembershipCheckCount,
  });
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

/** Four-scan reference oracle for the focused demand-snapshot equivalence fixture only. */
export function beginHistoryRetentionProjectionWithReferenceIntentTraversalForTests(
  finalShell: SimulationState,
  authority: HistoryRetentionAuthority,
): HistoryRetentionProjectionFold {
  assertHistoryRetentionAuthority(authority, 'retention reference projection ');
  const demand = collectDemand(finalShell, 'reference');
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
    const previousMatch = previousDirectMatches.get(eventId);
    if (previousDemandedIds.has(eventId) && previousMatch) {
      fold.directMatchesByEventId.set(eventId, { ...previousMatch });
      continue;
    }
    const groups = [...fold.demandGroupsByKey.values()]
      .filter((group) => {
        historyRetentionResumeDemandGroupMembershipCheckCount += 1;
        return group.eventIds.has(eventId);
      });
    const requiresVerifiedPrefixLookup = groups.some((group) => {
      const liveSocial = parseLivePersonSocialEvidenceGroupKey(group.groupKey);
      return ((group.groupKey === LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY
        || group.groupKey === FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY)
        || liveSocial?.kind === 'broad')
        && group.requirement === 'index-only';
    });
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
    const belongsToTypedRecordIdentityDemand = [...fold.demandGroupsByKey.values()].some((group) => (
      group.eventIds.has(eventId)
      && (group.groupKey === FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_LEASE_KEY
        || group.groupKey === LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY
        || (group.groupKey.startsWith('live-intent:')
          && liveSupportingSourceCoreGroupKey(group.groupKey) !== null))
    ));
    if (!belongsToBlockingDemand && !belongsToTypedRecordIdentityDemand) {
      fold.requiredSuffixDirectDemandEventIds.delete(eventId);
    }
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
  for (const eventId of matched) fold.requiredSuffixDirectDemandEventIds.delete(eventId);
}

function bodyFreeRecordPayloadIdentityGroup(group: DirectDemandGroup): boolean {
  return (group.groupKey === FUTURE_ACTIVE_PROJECT_LOGISTICS_SOURCE_LEASE_KEY
      && group.requirement === 'index-only')
    || (group.groupKey === LIVE_PERSON_PROJECT_PRESSURE_SOURCE_LEASE_KEY
      && group.requirement === 'index-only')
    || (group.groupKey.startsWith('live-intent:')
      && liveSupportingSourceCoreGroupKey(group.groupKey) !== null
      && group.requirement === 'audit-only');
}

function groupRequiresWorldEventIdentity(group: DirectDemandGroup): boolean {
  if (bodyFreeRecordPayloadIdentityGroup(group)) return false;
  if (group.requirement === 'all'
    || group.requirement === 'any'
    || group.requirement === 'audit-only') return true;
  return group.groupKey === FUTURE_SOCIAL_REPETITION_SOURCE_LEASE_KEY
    || parseWaterAssistanceFulfillmentMembershipGroupKey(group.groupKey) !== null;
}

/**
 * Return only canonical record payload identities that overlap a typed
 * logistics/project-pressure/live-intent source group and still have no event
 * identity after the successor suffix was folded. This does not release the
 * demand: the successor wrapper must first search the exact previous root.
 */
export function unresolvedVerifiedPrefixRecordPayloadIdentityIds(
  fold: HistoryRetentionProjectionFold,
): string[] {
  if (fold.status !== 'open') {
    throw new Error('retention prefix record payload bridge 只接受 open fold');
  }
  const recordCounts = new Map<string, number>();
  for (const record of fold.modernRecordValidationState.records) {
    const recordId = requiredEventId(record.id, 'retention next shell record payload identity');
    recordCounts.set(recordId, (recordCounts.get(recordId) ?? 0) + 1);
  }
  const candidates = new Set<string>();
  for (const group of fold.demandGroupsByKey.values()) {
    if (!bodyFreeRecordPayloadIdentityGroup(group)) continue;
    for (const eventId of group.eventIds) {
      const count = recordCounts.get(eventId) ?? 0;
      if (count > 1) {
        throw new Error(`retention next shell record payload identity ${eventId} 重复`);
      }
      if (count === 1) candidates.add(eventId);
    }
  }
  for (const eventId of candidates) {
    if (fold.directMatchesByEventId.has(eventId)) {
      throw new Error(`retention record payload/event identity ${eventId} 冲突`);
    }
  }
  return [...candidates]
    .filter((eventId) => fold.requiredSuffixDirectDemandEventIds.has(eventId))
    .sort();
}

/**
 * Admit a body-free record identity only after an exact previous-root scan
 * searched it and found no WorldEvent. The suffix has already been folded, so
 * an existing direct match is an event/record collision and fails closed.
 */
export function seedVerifiedPrefixRecordPayloadIdentityMisses(
  fold: HistoryRetentionProjectionFold,
  verifiedSourceEventCount: number,
  searchedEventIds: readonly string[],
  matches: readonly HistoryRetentionContinuationMatch[],
): void {
  if (fold.status !== 'open') {
    throw new Error('retention prefix record payload bridge 只接受 open fold');
  }
  const sourceTarget = fold.continuationSourceTarget;
  if (!sourceTarget || verifiedSourceEventCount !== sourceTarget.eventCount) {
    throw new Error('retention prefix record payload bridge 与 continuation source seal 不一致');
  }
  const expected = unresolvedVerifiedPrefixRecordPayloadIdentityIds(fold);
  if (!sameStringSet(searchedEventIds, expected)
    || new Set(searchedEventIds).size !== searchedEventIds.length) {
    throw new Error('retention prefix record payload bridge searched identity 不完整');
  }
  const matchedIds = new Set<string>();
  for (const match of matches) {
    if (matchedIds.has(match.eventId)
      || !expected.includes(match.eventId)
      || !Number.isSafeInteger(match.absoluteIndex)
      || match.absoluteIndex < 0
      || match.absoluteIndex >= sourceTarget.eventCount) {
      throw new Error(`retention prefix record payload bridge match ${match.eventId} 无效`);
    }
    matchedIds.add(match.eventId);
  }
  if (matchedIds.size > 0) {
    throw new Error(`retention record payload/event identity ${[...matchedIds].sort().join(',')} 冲突`);
  }
  for (const eventId of expected) {
    const groups = [...fold.demandGroupsByKey.values()].filter((group) => (
      group.eventIds.has(eventId)
    ));
    if (!groups.some(bodyFreeRecordPayloadIdentityGroup)
      || groups.some(groupRequiresWorldEventIdentity)) {
      throw new Error(`retention record payload identity ${eventId} 同时属于必须事件的严格 demand`);
    }
    if (fold.directMatchesByEventId.has(eventId)) {
      throw new Error(`retention record payload/event identity ${eventId} 冲突`);
    }
    fold.requiredSuffixDirectDemandEventIds.delete(eventId);
  }
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
