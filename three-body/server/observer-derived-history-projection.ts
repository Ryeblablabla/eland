import { createHash } from 'node:crypto';
import { Material, type MaterialId } from '../src/game/eland/domain/material';
import type { ActionFact, WorldEvent } from '../src/game/eland/domain/model';
import { cellId } from '../src/game/eland/world/grid';

/**
 * Server-only, post-fact projection. This module must never be imported by the
 * domain or application planning graph: its aggregates are observations, not
 * goals, rewards, unlocks, perceptions, or action-authorisation inputs.
 */

export const OBSERVER_DERIVED_HISTORY_DEFINITION = 'observer-derived-history-v2' as const;
export const OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT = 16;
/**
 * Hard residency bounds for this experimental server projection. Reaching a
 * bound is an explicit unsupported-history failure: silently evicting facts
 * would make a later observer demand look authoritative while changing its
 * answer.
 */
export const OBSERVER_DERIVED_HISTORY_IDENTITY_MEMBERSHIP_LIMIT = 65_536;
export const OBSERVER_DERIVED_HISTORY_DEMAND_ENTITY_LIMIT = 1_024;
export const OBSERVER_DERIVED_HISTORY_DEMAND_REFERENCE_LIMIT = 65_536;
export const OBSERVER_DERIVED_HISTORY_EVENT_BASIS_LIMIT = 65_536;
export const OBSERVER_DERIVED_HISTORY_SPATIAL_KEY_LIMIT = 16_384;
export const OBSERVER_DERIVED_HISTORY_FACILITY_LIMIT = 16_384;
export const OBSERVER_DERIVED_HISTORY_MONTH_CANDIDATE_LIMIT = 16_384;
export const OBSERVER_DERIVED_HISTORY_EVENT_COLLECTION_LIMIT = 4_096;

export interface ObserverDerivedHistoryTarget {
  /** CAS hash of the exact authoritative run-state root that owns this cursor. */
  stateHash: string;
  /** Absolute committed-event count, never the retained hot-window length. */
  eventCount: number;
  tailEventId: string | null;
}

export interface ObserverHistoryEvidenceRef {
  absoluteIndex: number;
  eventId: string;
  atMonth: number;
  who?: string;
}

export interface SettledCultivationHistoryDemand {
  projectId: string;
  completedAtMonth: number;
  /** Exact radius cells calculated from the completed project's authoritative site. */
  siteCellIds: readonly number[];
  actionEventIds: readonly string[];
  completionEventIds: readonly string[];
}

export interface ResidentialStructureHistoryDemand {
  structureId: string;
  /** Preserves the structure observer's source-order first-match semantics. */
  sourceEventIds: readonly string[];
}

export interface ObserverDerivedHistoryDemand {
  settledCultivationProjects?: readonly SettledCultivationHistoryDemand[];
  residentialStructures?: readonly ResidentialStructureHistoryDemand[];
  /** Current non-project/non-structure world-event references that must remain resolvable. */
  retainedEventIds?: readonly string[];
  /**
   * Conservative future closure. Callers should include active
   * settled-cultivation action IDs and physical-provenance source IDs before
   * they become an immediate observer demand.
   */
  futureEventIds?: readonly string[];
}

export type ObserverPracticeKey = 'transfer' | 'storage' | 'travel' | 'cultivation' | 'mortuary-care';

export interface ObserverPracticeHistory {
  key: ObserverPracticeKey;
  count: number;
  firstObservedMonth: number | null;
  lastObservedMonth: number | null;
  agentIds: string[];
  evidence: ObserverHistoryEvidenceRef[];
}

export interface ObserverTrailRegionHistory {
  formationActionCount: number;
  changedCellCount: number;
  cellIds: number[];
  firstObservedMonth: number | null;
  lastObservedMonth: number | null;
  evidence: ObserverHistoryEvidenceRef[];
}

export interface ObserverCultivatedRegionHistory {
  plantingActionCount: number;
  harvestActionCount: number;
  cellIds: number[];
  firstObservedMonth: number | null;
  lastObservedMonth: number | null;
  evidence: ObserverHistoryEvidenceRef[];
}

export interface ObserverResidentialRegionHistory {
  structureId: string;
  sourceRank: number | null;
  firstObservedMonth: number | null;
  sourceEvidence: ObserverHistoryEvidenceRef | null;
}

export type ObserverFunctionalBuildingKind =
  | 'core'
  | 'storage'
  | 'water'
  | 'workshop'
  | 'kiln'
  | 'mill'
  | 'foundry'
  | 'smithy';

export interface ObserverFunctionalBuildingHistory {
  id: string;
  kind: ObserverFunctionalBuildingKind;
  materialId: MaterialId;
  cellId: number;
  z: number;
  installedAtMonth: number;
  installationCount: number;
  installationEvidence: ObserverHistoryEvidenceRef[];
  useCount: number;
  userIds: string[];
  useEvidence: ObserverHistoryEvidenceRef[];
}

export interface ObserverInstitutionBasisHistory {
  actionCount: number;
  actorIds: string[];
  participantIds: string[];
  firstObservedMonth: number | null;
  lastObservedMonth: number | null;
  institutionThresholdSatisfied: boolean;
  evidence: ObserverHistoryEvidenceRef[];
}

export type ObserverMaterialCapabilityKey = 'processed-wood' | 'masonry-stone' | 'bronze' | 'iron';

export interface ObserverMaterialCapabilityHistory {
  key: ObserverMaterialCapabilityKey;
  successfulBatchCount: number;
  failedBatchCount: number;
  adoptedActionCount: number;
  firstSuccessfulMonth: number | null;
  lastSuccessfulMonth: number | null;
  producerIds: string[];
  productionSiteMaterialIds: MaterialId[];
  successfulBatchEvidence: ObserverHistoryEvidenceRef[];
  failedBatchEvidence: ObserverHistoryEvidenceRef[];
  adoptedActionEvidence: ObserverHistoryEvidenceRef[];
}

export interface ObserverCultivationPositionWitness {
  positionKey: string;
  event: ObserverHistoryEvidenceRef;
}

export interface ObserverSettledCultivationProjectHistory {
  projectId: string;
  completedAtMonth: number;
  distinctPlantingPositionCount: number;
  harvestCountAtPlantedPositions: number;
  plantingWitnesses: ObserverCultivationPositionWitness[];
  harvestWitnesses: ObserverHistoryEvidenceRef[];
}

export interface ObserverEstablishedCultivationWitness {
  projectId: string;
  plantingEvidence: ObserverHistoryEvidenceRef[];
  harvestEvidence: ObserverHistoryEvidenceRef[];
}

export interface ObserverCultivationEventBasis {
  kind: 'planting' | 'harvest';
  positionKey: string;
  siteCellId: number;
  evidence: ObserverHistoryEvidenceRef;
}

/**
 * Demand-closure, compact last-write index. The closure is formed before a
 * verified scan from current refs plus explicit retained/future refs; unrelated
 * ledger IDs never enter this basis. `latestWorldEvidence` mirrors
 * worldEventById while `latestCultivationAction` mirrors new
 * Map(actionFacts.map(...)); a later non-action event with the same id must not
 * erase the latest action fact.
 */
export interface ObserverDemandEventBasisEntry {
  eventId: string;
  /** Null plus resolved=true is a verified absence tombstone. */
  latestWorldEvidence: ObserverHistoryEvidenceRef | null;
  worldLastWriteResolved: boolean;
  latestCultivationAction: ObserverCultivationEventBasis | null;
  actionLastWriteResolved: boolean;
}

/**
 * Compact, process-proven occurrence produced while a strict wrapper streams
 * an exact historical prefix. Keeping only observer evidence and the optional
 * cultivation classification avoids retaining an arbitrary action body until
 * the stream receipt seals.
 */
export interface ObserverVerifiedPrefixDemandOccurrence {
  eventId: string;
  evidence: ObserverHistoryEvidenceRef;
  isAction: boolean;
  cultivationAction: ObserverCultivationEventBasis | null;
}

export interface ObserverVerifiedPrefixDemandLastWrite {
  eventId: string;
  latestWorld: Readonly<ObserverVerifiedPrefixDemandOccurrence> | null;
  latestAction: Readonly<ObserverVerifiedPrefixDemandOccurrence> | null;
}

export interface ObserverDerivedHistoryProjection {
  schemaVersion: 2;
  definitionVersion: typeof OBSERVER_DERIVED_HISTORY_DEFINITION;
  target: ObserverDerivedHistoryTarget;
  reducedThrough: { eventCount: number; tailEventId: string | null };
  demandFingerprint: string;
  lastEventMonth: number | null;
  practices: Record<ObserverPracticeKey, ObserverPracticeHistory>;
  regions: {
    trail: ObserverTrailRegionHistory;
    cultivated: ObserverCultivatedRegionHistory;
    residential: ObserverResidentialRegionHistory[];
  };
  functionalBuildings: ObserverFunctionalBuildingHistory[];
  institutions: {
    distributedTeaching: ObserverInstitutionBasisHistory;
    repeatedInterment: ObserverInstitutionBasisHistory;
  };
  materialCapabilities: Record<ObserverMaterialCapabilityKey, ObserverMaterialCapabilityHistory>;
  demandEventBasis: ObserverDemandEventBasisEntry[];
  settledCultivationProjects: ObserverSettledCultivationProjectHistory[];
  establishedCultivationWitness: ObserverEstablishedCultivationWitness | null;
  continuationReady: false;
  continuationGaps: readonly string[];
}

interface MutablePractice {
  key: ObserverPracticeKey;
  count: number;
  firstObservedMonth: number | null;
  lastObservedMonth: number | null;
  agentIds: Set<string>;
  evidence: ObserverHistoryEvidenceRef[];
}

interface MutableRegion {
  actionCount: number;
  cellIds: Set<number>;
  firstObservedMonth: number | null;
  lastObservedMonth: number | null;
  evidence: ObserverHistoryEvidenceRef[];
}

interface MutableFacility {
  id: string;
  kind: ObserverFunctionalBuildingKind;
  materialId: MaterialId;
  x: number;
  y: number;
  z: number;
  installedAtMonth: number;
  installationCount: number;
  installationEvidence: ObserverHistoryEvidenceRef[];
  useCount: number;
  userIds: Set<string>;
  useEvidence: ObserverHistoryEvidenceRef[];
}

interface MutableInstitution {
  actionCount: number;
  actorIds: Set<string>;
  participantIds: Set<string>;
  firstObservedMonth: number | null;
  lastObservedMonth: number | null;
  evidence: ObserverHistoryEvidenceRef[];
}

interface MutableCapability {
  key: ObserverMaterialCapabilityKey;
  successfulBatchCount: number;
  failedBatchCount: number;
  adoptedActionCount: number;
  firstSuccessfulMonth: number | null;
  lastSuccessfulMonth: number | null;
  producerIds: Set<string>;
  productionSiteMaterialIds: Set<MaterialId>;
  successfulBatchEvidence: ObserverHistoryEvidenceRef[];
  failedBatchEvidence: ObserverHistoryEvidenceRef[];
  adoptedActionEvidence: ObserverHistoryEvidenceRef[];
}

interface MutableResidential {
  structureId: string;
  sourceRank: number | null;
  firstObservedMonth: number | null;
  sourceEvidence: ObserverHistoryEvidenceRef | null;
}

interface MutableCultivationProject {
  projectId: string;
  completedAtMonth: number;
  plantingByPosition: Map<string, ObserverHistoryEvidenceRef>;
  harvestCountAtPlantedPositions: number;
  harvestWitnesses: ObserverHistoryEvidenceRef[];
}

interface FacilityUseCandidate {
  event: ActionFact;
  evidence: ObserverHistoryEvidenceRef;
  facilityMaterialId: MaterialId | null;
  storageContainerId: string | null;
  waterPositions: string[];
  coreCellId: number | null;
  installationId: string | null;
}

export interface ObserverDerivedHistoryProjectionFold {
  status: 'open' | 'discarded' | 'finished';
  target: ObserverDerivedHistoryTarget;
  demandFingerprint: string;
  nextAbsoluteIndex: number;
  lastEventId: string | null;
  lastEventMonth: number | null;
  resumeFloorMonth: number | null;
  /** Exact previous-root boundary, present only for an incremental fold. */
  resumeSourceEventCount: number | null;
  practices: Record<ObserverPracticeKey, MutablePractice>;
  trail: MutableRegion & { changedCellCount: number };
  cultivated: MutableRegion & { harvestActionCount: number };
  facilities: Map<string, MutableFacility>;
  teaching: MutableInstitution;
  burial: MutableInstitution;
  capabilities: Record<ObserverMaterialCapabilityKey, MutableCapability>;
  demandEventBasisById: Map<string, ObserverDemandEventBasisEntry>;
  demandWorldRequiredIds: Set<string>;
  demandActionRequiredIds: Set<string>;
  residential: Map<string, MutableResidential>;
  cultivationProjects: Map<string, MutableCultivationProject>;
  identityMembershipCount: number;
  currentFacilityMonth: number | null;
  currentFacilityCandidates: FacilityUseCandidate[];
  finishedResult?: ObserverDerivedHistoryProjection;
}

interface FacilityDefinition {
  kind: ObserverFunctionalBuildingKind;
}

interface CapabilityDefinition {
  key: ObserverMaterialCapabilityKey;
  products: readonly MaterialId[];
  tools: readonly MaterialId[];
  sites: readonly MaterialId[];
}

const STATE_HASH_PATTERN = /^[0-9a-f]{64}$/u;
export const OBSERVER_DERIVED_HISTORY_CONTINUATION_GAPS = Object.freeze([
  'current-grid facility activity and region cells still require exact final-shell reconciliation',
  'retained/future demand closure is not yet wired to active-project and physical-provenance collectors',
  'bounded evidence arrays require versioned materialization instead of legacy all-event ID arrays',
  'development era, institution fragments, civilization index, and milestones are not materialized here',
  'the result is not yet exact-run-root branded or persisted in the state revision CAS transaction',
]);

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

const FACILITIES = new Map<MaterialId, FacilityDefinition>([
  [Material.CouncilHearth, { kind: 'core' }],
  [Material.CivicHall, { kind: 'core' }],
  [Material.KeepCore, { kind: 'core' }],
  [Material.Granary, { kind: 'storage' }],
  [Material.Cistern, { kind: 'water' }],
  [Material.Workshop, { kind: 'workshop' }],
  [Material.Kiln, { kind: 'kiln' }],
  [Material.Mill, { kind: 'mill' }],
  [Material.Foundry, { kind: 'foundry' }],
  [Material.Smithy, { kind: 'smithy' }],
]);

const CAPABILITY_DEFINITIONS: readonly CapabilityDefinition[] = [
  {
    key: 'processed-wood',
    products: [Material.Plank, Material.WoodTool, Material.CouncilHearth, Material.Workshop, Material.Granary],
    tools: [Material.WoodTool],
    sites: [Material.CouncilHearth, Material.Workshop, Material.Granary],
  },
  {
    key: 'masonry-stone',
    products: [Material.StoneTool, Material.StoneHoe, Material.Cistern, Material.Kiln, Material.Mill, Material.FiredBrick],
    tools: [Material.StoneTool, Material.StoneHoe],
    sites: [Material.Cistern, Material.Kiln, Material.Mill],
  },
  {
    key: 'bronze',
    products: [Material.Copper, Material.Tin, Material.Bronze, Material.BronzeTool, Material.Foundry, Material.CivicHall],
    tools: [Material.BronzeTool],
    sites: [Material.Kiln, Material.Foundry, Material.CivicHall],
  },
  {
    key: 'iron',
    products: [Material.IronBloom, Material.Iron, Material.IronTool, Material.Smithy, Material.KeepCore],
    tools: [Material.IronTool],
    sites: [Material.Smithy, Material.KeepCore],
  },
];

const PRACTICE_KEYS: readonly ObserverPracticeKey[] = [
  'transfer', 'storage', 'travel', 'cultivation', 'mortuary-care',
];

const CAPABILITY_KEYS: readonly ObserverMaterialCapabilityKey[] = [
  'processed-wood', 'masonry-stone', 'bronze', 'iron',
];

function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}必须是非负安全整数`);
}

function assertTarget(target: ObserverDerivedHistoryTarget): void {
  if (!target || !STATE_HASH_PATTERN.test(target.stateHash)) {
    throw new Error('observer derived history target 缺少有效 CAS stateHash');
  }
  assertSafeNonNegativeInteger(target.eventCount, 'observer derived history eventCount');
  if (target.eventCount === 0) {
    if (target.tailEventId !== null) throw new Error('空 observer derived history target 的 tailEventId 必须为 null');
  } else if (typeof target.tailEventId !== 'string' || target.tailEventId.length === 0) {
    throw new Error('非空 observer derived history target 缺少 tailEventId');
  }
}

function requiredString(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}不能为空`);
  return value;
}

function assertCollectionLimit(length: number, limit: number, label: string): void {
  if (!Number.isSafeInteger(length) || length < 0 || length > limit) {
    throw new Error(`${label}超过 observer derived history 上限 ${limit}`);
  }
}

function boundedUniqueStrings(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values)) throw new Error(`${label}必须是数组`);
  assertCollectionLimit(values.length, OBSERVER_DERIVED_HISTORY_DEMAND_REFERENCE_LIMIT, label);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = requiredString(value, label);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeDemand(demand: ObserverDerivedHistoryDemand = {}) {
  const rawProjects = demand.settledCultivationProjects ?? [];
  const rawStructures = demand.residentialStructures ?? [];
  const rawRetainedEventIds = demand.retainedEventIds ?? [];
  const rawFutureEventIds = demand.futureEventIds ?? [];
  if (!Array.isArray(rawProjects)
    || !Array.isArray(rawStructures)
    || !Array.isArray(rawRetainedEventIds)
    || !Array.isArray(rawFutureEventIds)) {
    throw new Error('observer derived history demand 集合必须是数组');
  }
  assertCollectionLimit(
    rawProjects.length,
    OBSERVER_DERIVED_HISTORY_DEMAND_ENTITY_LIMIT,
    'settled cultivation projects',
  );
  assertCollectionLimit(
    rawStructures.length,
    OBSERVER_DERIVED_HISTORY_DEMAND_ENTITY_LIMIT,
    'residential structures',
  );
  let totalReferences = 0;
  let totalSiteCells = 0;
  const settledCultivationProjects = rawProjects.map((project) => {
    const projectId = requiredString(project.projectId, 'settled cultivation projectId');
    assertSafeNonNegativeInteger(project.completedAtMonth, `project ${projectId} completedAtMonth`);
    if (!Array.isArray(project.siteCellIds)) throw new Error(`project ${projectId} siteCellIds必须是数组`);
    assertCollectionLimit(
      project.siteCellIds.length,
      OBSERVER_DERIVED_HISTORY_SPATIAL_KEY_LIMIT,
      `project ${projectId} siteCellIds`,
    );
    const siteCellIds: number[] = [...new Set<number>(project.siteCellIds)];
    siteCellIds.forEach((value) => assertSafeNonNegativeInteger(value, `project ${projectId} siteCellId`));
    const actionEventIds = boundedUniqueStrings(project.actionEventIds, `project ${projectId} actionEventIds`);
    const actionIds = new Set(actionEventIds);
    const completionEventIds = boundedUniqueStrings(
      project.completionEventIds,
      `project ${projectId} completionEventIds`,
    ).filter((id) => actionIds.has(id));
    totalReferences += actionEventIds.length + completionEventIds.length;
    totalSiteCells += siteCellIds.length;
    assertCollectionLimit(
      totalReferences,
      OBSERVER_DERIVED_HISTORY_DEMAND_REFERENCE_LIMIT,
      'settled cultivation demand references',
    );
    assertCollectionLimit(
      totalSiteCells,
      OBSERVER_DERIVED_HISTORY_SPATIAL_KEY_LIMIT,
      'settled cultivation demand site cells',
    );
    return {
      projectId,
      completedAtMonth: project.completedAtMonth,
      siteCellIds: siteCellIds.sort((left, right) => left - right),
      actionEventIds: actionEventIds.sort((left, right) => left.localeCompare(right)),
      completionEventIds,
    };
  }).sort((left, right) => left.completedAtMonth - right.completedAtMonth || left.projectId.localeCompare(right.projectId));
  const projectIds = new Set<string>();
  for (const project of settledCultivationProjects) {
    if (projectIds.has(project.projectId)) throw new Error(`settled cultivation project ${project.projectId} 重复`);
    projectIds.add(project.projectId);
  }

  const residentialStructures = rawStructures
    .map((structure) => {
      const structureId = requiredString(structure.structureId, 'residential structureId');
      const sourceEventIds = boundedUniqueStrings(
        structure.sourceEventIds,
        `structure ${structureId} sourceEventIds`,
      );
      totalReferences += sourceEventIds.length;
      assertCollectionLimit(
        totalReferences,
        OBSERVER_DERIVED_HISTORY_DEMAND_REFERENCE_LIMIT,
        'observer derived history demand references',
      );
      return { structureId, sourceEventIds };
    })
    .sort((left, right) => left.structureId.localeCompare(right.structureId));
  const structureIds = new Set<string>();
  for (const structure of residentialStructures) {
    if (structureIds.has(structure.structureId)) throw new Error(`residential structure ${structure.structureId} 重复`);
    structureIds.add(structure.structureId);
  }
  const retainedEventIds = boundedUniqueStrings(
    rawRetainedEventIds,
    'observer retainedEventIds',
  ).sort((left, right) => left.localeCompare(right));
  const futureEventIds = boundedUniqueStrings(
    rawFutureEventIds,
    'observer futureEventIds',
  ).sort((left, right) => left.localeCompare(right));
  totalReferences += retainedEventIds.length + futureEventIds.length;
  assertCollectionLimit(
    totalReferences,
    OBSERVER_DERIVED_HISTORY_DEMAND_REFERENCE_LIMIT,
    'observer derived history demand references',
  );

  const worldRequiredIds = new Set<string>([...retainedEventIds, ...futureEventIds]);
  const actionRequiredIds = new Set<string>(futureEventIds);
  for (const structure of residentialStructures) {
    structure.sourceEventIds.forEach((eventId) => worldRequiredIds.add(eventId));
  }
  for (const project of settledCultivationProjects) {
    project.actionEventIds.forEach((eventId) => actionRequiredIds.add(eventId));
    project.completionEventIds.forEach((eventId) => actionRequiredIds.add(eventId));
  }
  const trackedEventIds = [...new Set([...worldRequiredIds, ...actionRequiredIds])]
    .sort((left, right) => left.localeCompare(right));
  assertCollectionLimit(
    trackedEventIds.length,
    OBSERVER_DERIVED_HISTORY_EVENT_BASIS_LIMIT,
    'observer demand closure',
  );
  return {
    settledCultivationProjects,
    residentialStructures,
    retainedEventIds,
    futureEventIds,
    trackedEventIds,
    worldRequiredEventIds: [...worldRequiredIds].sort((left, right) => left.localeCompare(right)),
    actionRequiredEventIds: [...actionRequiredIds].sort((left, right) => left.localeCompare(right)),
  };
}

function fingerprintDemand(demand: ReturnType<typeof normalizeDemand>): string {
  return createHash('sha256')
    .update(`${OBSERVER_DERIVED_HISTORY_DEFINITION}\0`)
    .update(JSON.stringify(demand))
    .digest('hex');
}

function addIdentityMembership(
  fold: ObserverDerivedHistoryProjectionFold,
  target: Set<string>,
  value: string,
  label: string,
): void {
  const identity = requiredString(value, label);
  if (target.has(identity)) return;
  if (fold.identityMembershipCount >= OBSERVER_DERIVED_HISTORY_IDENTITY_MEMBERSHIP_LIMIT) {
    throw new Error(`observer derived history identity memberships超过上限 ${OBSERVER_DERIVED_HISTORY_IDENTITY_MEMBERSHIP_LIMIT}`);
  }
  target.add(identity);
  fold.identityMembershipCount += 1;
}

function addSpatialKey<T>(target: Set<T>, value: T, label: string): void {
  if (target.has(value)) return;
  if (target.size >= OBSERVER_DERIVED_HISTORY_SPATIAL_KEY_LIMIT) {
    throw new Error(`${label}超过 observer derived history 上限 ${OBSERVER_DERIVED_HISTORY_SPATIAL_KEY_LIMIT}`);
  }
  target.add(value);
}

function setBoundedEntry<K, V>(
  target: Map<K, V>,
  key: K,
  value: V,
  limit: number,
  label: string,
): void {
  if (!target.has(key) && target.size >= limit) {
    throw new Error(`${label}超过 observer derived history 上限 ${limit}`);
  }
  target.set(key, value);
}

function emptyPractice(key: ObserverPracticeKey): MutablePractice {
  return { key, count: 0, firstObservedMonth: null, lastObservedMonth: null, agentIds: new Set(), evidence: [] };
}

function emptyInstitution(): MutableInstitution {
  return {
    actionCount: 0,
    actorIds: new Set(),
    participantIds: new Set(),
    firstObservedMonth: null,
    lastObservedMonth: null,
    evidence: [],
  };
}

function emptyCapability(key: ObserverMaterialCapabilityKey): MutableCapability {
  return {
    key,
    successfulBatchCount: 0,
    failedBatchCount: 0,
    adoptedActionCount: 0,
    firstSuccessfulMonth: null,
    lastSuccessfulMonth: null,
    producerIds: new Set(),
    productionSiteMaterialIds: new Set(),
    successfulBatchEvidence: [],
    failedBatchEvidence: [],
    adoptedActionEvidence: [],
  };
}

function addEvidence(target: ObserverHistoryEvidenceRef[], evidence: ObserverHistoryEvidenceRef): void {
  if (target.length < OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT) target.push(evidence);
}

function touchMonths(target: { firstObservedMonth: number | null; lastObservedMonth: number | null }, atMonth: number): void {
  target.firstObservedMonth = target.firstObservedMonth === null ? atMonth : Math.min(target.firstObservedMonth, atMonth);
  target.lastObservedMonth = target.lastObservedMonth === null ? atMonth : Math.max(target.lastObservedMonth, atMonth);
}

function observePractice(
  fold: ObserverDerivedHistoryProjectionFold,
  practice: MutablePractice,
  event: ActionFact,
  evidence: ObserverHistoryEvidenceRef,
): void {
  practice.count += 1;
  addIdentityMembership(fold, practice.agentIds, event.who, 'observer practice agentId');
  touchMonths(practice, event.atMonth);
  addEvidence(practice.evidence, evidence);
}

function numericMaterial(value: unknown): MaterialId | null {
  const materialId = Number(value);
  return Number.isInteger(materialId) ? materialId : null;
}

function eventOutputMaterialIds(event: ActionFact): MaterialId[] {
  const result = new Set<MaterialId>();
  const direct = numericMaterial(event.diff.outputMaterialId);
  if (direct !== null) result.add(direct);
  if (Array.isArray(event.diff.outputs)) {
    assertCollectionLimit(
      event.diff.outputs.length,
      OBSERVER_DERIVED_HISTORY_EVENT_COLLECTION_LIMIT,
      `action ${event.id} outputs`,
    );
    for (const output of event.diff.outputs) {
      if (!output || typeof output !== 'object') continue;
      const materialId = numericMaterial((output as { materialId?: unknown }).materialId);
      if (materialId !== null) result.add(materialId);
    }
  }
  return [...result];
}

function eventInputMaterialIds(event: ActionFact): MaterialId[] {
  if (!Array.isArray(event.diff.inputMaterialIds)) return [];
  assertCollectionLimit(
    event.diff.inputMaterialIds.length,
    OBSERVER_DERIVED_HISTORY_EVENT_COLLECTION_LIMIT,
    `action ${event.id} inputMaterialIds`,
  );
  return event.diff.inputMaterialIds.flatMap((value) => {
    const materialId = numericMaterial(value);
    return materialId === null ? [] : [materialId];
  });
}

function diffPosition(event: ActionFact): { x: number; y: number; z: number } | null {
  const raw = event.diff.position;
  if (!raw || typeof raw !== 'object') return null;
  const position = raw as { x?: unknown; y?: unknown; z?: unknown };
  if (![position.x, position.y, position.z].every((value) => Number.isInteger(Number(value)))) return null;
  return { x: Number(position.x), y: Number(position.y), z: Number(position.z) };
}

function eventEvidence(event: WorldEvent, absoluteIndex: number): ObserverHistoryEvidenceRef {
  return {
    absoluteIndex,
    eventId: event.id,
    atMonth: event.atMonth,
    ...('who' in event && typeof event.who === 'string' ? { who: event.who } : {}),
  };
}

function cultivationEventBasis(
  event: ActionFact,
  evidence: ObserverHistoryEvidenceRef,
): ObserverCultivationEventBasis | null {
  if (event.status !== 'completed' || event.action.kind !== 'act') return null;
  assertCollectionLimit(
    event.action.targets.length,
    OBSERVER_DERIVED_HISTORY_EVENT_COLLECTION_LIMIT,
    `action ${event.id} targets`,
  );
  if (event.action.operation === 'combine'
    && Number(event.diff.outputMaterialId) === Material.CropSprout) {
    const position = diffPosition(event);
    if (!position) return null;
    return {
      kind: 'planting',
      positionKey: `${position.x}:${position.y}:${position.z}`,
      siteCellId: cellId(position.x, position.y),
      evidence,
    };
  }
  if (event.action.operation !== 'separate'
    || Number(event.diff.sourceMaterialId) !== Material.CropMature) return null;
  const target = event.action.targets.find((candidate) => candidate.kind === 'voxel');
  if (!target) return null;
  return {
    kind: 'harvest',
    positionKey: `${target.position.x}:${target.position.y}:${target.position.z}`,
    siteCellId: cellId(target.position.x, target.position.y),
    evidence,
  };
}

function observeDemandEventBasis(
  fold: ObserverDerivedHistoryProjectionFold,
  event: WorldEvent,
  evidence: ObserverHistoryEvidenceRef,
): void {
  // Only ID-addressed observer lookups use last-write. Aggregate action counts
  // intentionally continue to fold every committed occurrence, matching the
  // authoritative actionFacts/worldEventFacts observers.
  const previous = fold.demandEventBasisById.get(event.id);
  if (!previous) return;
  const latestCultivationAction = event.kind === 'action'
    ? cultivationEventBasis(event, evidence)
    : previous.latestCultivationAction;
  fold.demandEventBasisById.set(event.id, {
    eventId: event.id,
    latestWorldEvidence: evidence,
    worldLastWriteResolved: true,
    latestCultivationAction,
    actionLastWriteResolved: event.kind === 'action'
      ? true
      : previous.actionLastWriteResolved,
  });
}

function installationFromAction(event: ActionFact) {
  if (event.status !== 'completed' || event.action.kind !== 'act' || event.action.operation !== 'combine') return null;
  const materialId = numericMaterial(event.diff.outputMaterialId);
  const definition = materialId === null ? undefined : FACILITIES.get(materialId);
  const position = diffPosition(event);
  if (materialId === null || !definition || !position) return null;
  const { x, y, z } = position;
  return {
    id: `facility:${materialId}:${x}:${y}:${z}`,
    materialId,
    definition,
    x,
    y,
    z,
  };
}

function potentialFacilityUseCandidate(
  event: ActionFact,
  evidence: ObserverHistoryEvidenceRef,
  installationId: string | null,
): FacilityUseCandidate | null {
  if (event.status !== 'completed') return null;
  const facilityMaterial = numericMaterial(event.diff.facilityMaterialId);
  const facilityMaterialId = facilityMaterial !== null && FACILITIES.has(facilityMaterial) ? facilityMaterial : null;
  let storageContainerId: string | null = null;
  if (event.action.kind === 'transfer') {
    storageContainerId = event.action.from.kind === 'container'
      ? event.action.from.containerId
      : event.action.to.kind === 'container' ? event.action.to.containerId : null;
  }
  const waterPositions = event.action.kind === 'act' && event.action.operation === 'ingest'
    ? event.action.targets.flatMap((target) => target.kind === 'voxel'
      ? [`${target.position.x}:${target.position.y}:${target.position.z}`] : [])
    : [];
  const coreCellId = event.action.kind === 'communicate' ? event.cellId : null;
  if (facilityMaterialId === null && storageContainerId === null && waterPositions.length === 0 && coreCellId === null) return null;
  return {
    event,
    evidence,
    facilityMaterialId,
    storageContainerId,
    waterPositions,
    coreCellId,
    installationId,
  };
}

function registerInstallation(
  fold: ObserverDerivedHistoryProjectionFold,
  event: ActionFact,
  evidence: ObserverHistoryEvidenceRef,
): string | null {
  const installation = installationFromAction(event);
  if (!installation) return null;
  const existing = fold.facilities.get(installation.id);
  if (existing) {
    existing.installedAtMonth = Math.min(existing.installedAtMonth, event.atMonth);
    existing.installationCount += 1;
    addEvidence(existing.installationEvidence, evidence);
  } else {
    setBoundedEntry(fold.facilities, installation.id, {
      id: installation.id,
      kind: installation.definition.kind,
      materialId: installation.materialId,
      x: installation.x,
      y: installation.y,
      z: installation.z,
      installedAtMonth: event.atMonth,
      installationCount: 1,
      installationEvidence: [evidence],
      useCount: 0,
      userIds: new Set<string>(),
      useEvidence: [],
    }, OBSERVER_DERIVED_HISTORY_FACILITY_LIMIT, 'observer derived history facilities');
  }
  return installation.id;
}

function candidateUsesFacility(candidate: FacilityUseCandidate, facility: MutableFacility): boolean {
  if (candidate.installationId === facility.id) return false;
  if (candidate.event.atMonth < facility.installedAtMonth) return false;
  if (candidate.facilityMaterialId === facility.materialId) return true;
  if (facility.kind === 'storage'
    && candidate.storageContainerId === `container:${facility.x}:${facility.y}:${facility.z}`) return true;
  if (facility.kind === 'water'
    && candidate.waterPositions.includes(`${facility.x}:${facility.y}:${facility.z}`)) return true;
  return facility.kind === 'core' && candidate.coreCellId === cellId(facility.x, facility.y);
}

function flushFacilityMonth(fold: ObserverDerivedHistoryProjectionFold): void {
  if (fold.currentFacilityCandidates.length === 0) return;
  for (const candidate of fold.currentFacilityCandidates) {
    for (const facility of fold.facilities.values()) {
      if (!candidateUsesFacility(candidate, facility)) continue;
      facility.useCount += 1;
      addIdentityMembership(fold, facility.userIds, candidate.event.who, 'facility userId');
      addEvidence(facility.useEvidence, candidate.evidence);
    }
  }
  fold.currentFacilityCandidates.length = 0;
}

function queueFacilityObservation(
  fold: ObserverDerivedHistoryProjectionFold,
  event: ActionFact,
  evidence: ObserverHistoryEvidenceRef,
): void {
  if (fold.currentFacilityMonth !== null && event.atMonth !== fold.currentFacilityMonth) flushFacilityMonth(fold);
  fold.currentFacilityMonth = event.atMonth;
  const installationId = registerInstallation(fold, event, evidence);
  const candidate = potentialFacilityUseCandidate(event, evidence, installationId);
  if (candidate) {
    if (fold.currentFacilityCandidates.length >= OBSERVER_DERIVED_HISTORY_MONTH_CANDIDATE_LIMIT) {
      throw new Error(`observer derived history monthly facility candidates超过上限 ${OBSERVER_DERIVED_HISTORY_MONTH_CANDIDATE_LIMIT}`);
    }
    fold.currentFacilityCandidates.push(candidate);
  }
}

function observeRegions(
  fold: ObserverDerivedHistoryProjectionFold,
  event: ActionFact,
  evidence: ObserverHistoryEvidenceRef,
): void {
  if (event.action.kind === 'move' && event.pathSegment.length > 1) {
    const changes = Array.isArray(event.diff.materialChanges) ? event.diff.materialChanges : [];
    assertCollectionLimit(
      changes.length,
      OBSERVER_DERIVED_HISTORY_EVENT_COLLECTION_LIMIT,
      `action ${event.id} materialChanges`,
    );
    let formation = false;
    for (const raw of changes) {
      if (!raw || typeof raw !== 'object') continue;
      const change = raw as { cellId?: unknown; to?: unknown };
      const changedCell = Number(change.cellId);
      if (Number(change.to) !== Material.PackedSoil || !Number.isInteger(changedCell)) continue;
      formation = true;
      fold.trail.changedCellCount += 1;
      addSpatialKey(fold.trail.cellIds, changedCell, 'observer trail cells');
    }
    if (formation) {
      fold.trail.actionCount += 1;
      touchMonths(fold.trail, event.atMonth);
      addEvidence(fold.trail.evidence, evidence);
    }
  }

  const planting = event.action.kind === 'act'
    && event.action.operation === 'combine'
    && Number(event.diff.outputMaterialId) === Material.CropSprout;
  const harvest = event.action.kind === 'act'
    && event.action.operation === 'separate'
    && Number(event.diff.sourceMaterialId) === Material.CropMature;
  if (!planting && !harvest) return;
  if (planting) fold.cultivated.actionCount += 1;
  if (harvest) fold.cultivated.harvestActionCount += 1;
  touchMonths(fold.cultivated, event.atMonth);
  addEvidence(fold.cultivated.evidence, evidence);
  const position = planting
    ? diffPosition(event)
    : event.action.kind === 'act'
      ? event.action.targets.find((target) => target.kind === 'voxel')?.position ?? null
      : null;
  if (position) addSpatialKey(fold.cultivated.cellIds, cellId(position.x, position.y), 'observer cultivated cells');
}

function observeInstitutions(
  fold: ObserverDerivedHistoryProjectionFold,
  event: ActionFact,
  evidence: ObserverHistoryEvidenceRef,
): void {
  const rawAudienceIds = Array.isArray(event.diff.taughtAudienceIds)
    ? event.diff.taughtAudienceIds
    : [];
  assertCollectionLimit(
    rawAudienceIds.length,
    OBSERVER_DERIVED_HISTORY_EVENT_COLLECTION_LIMIT,
    `action ${event.id} taught audience`,
  );
  const audienceIds = rawAudienceIds.map(String);
  if (event.status === 'completed' && (audienceIds.length > 0 || Boolean(event.diff.techniqueDemonstrationVerified))) {
    fold.teaching.actionCount += 1;
    addIdentityMembership(fold, fold.teaching.actorIds, event.who, 'teaching actorId');
    addIdentityMembership(fold, fold.teaching.participantIds, event.who, 'teaching participantId');
    audienceIds.forEach((id) => addIdentityMembership(fold, fold.teaching.participantIds, id, 'teaching audienceId'));
    touchMonths(fold.teaching, event.atMonth);
    addEvidence(fold.teaching.evidence, evidence);
  }
  if (event.status === 'completed'
    && event.action.kind === 'act'
    && event.action.operation === 'inter'
    && event.diff.remainsInterred === true) {
    fold.burial.actionCount += 1;
    addIdentityMembership(fold, fold.burial.actorIds, event.who, 'burial actorId');
    addIdentityMembership(fold, fold.burial.participantIds, event.who, 'burial participantId');
    touchMonths(fold.burial, event.atMonth);
    addEvidence(fold.burial.evidence, evidence);
  }
}

function observeCapabilities(
  fold: ObserverDerivedHistoryProjectionFold,
  event: ActionFact,
  evidence: ObserverHistoryEvidenceRef,
): void {
  const outputs = eventOutputMaterialIds(event);
  const inputs = eventInputMaterialIds(event);
  const tool = numericMaterial(event.diff.toolMaterialId);
  const facility = numericMaterial(event.diff.facilityMaterialId);
  const directOutput = numericMaterial(event.diff.outputMaterialId);
  for (const definition of CAPABILITY_DEFINITIONS) {
    const capability = fold.capabilities[definition.key];
    const productSet = new Set(definition.products);
    const siteSet = new Set(definition.sites);
    if (event.status === 'completed' && outputs.some((materialId) => productSet.has(materialId))) {
      capability.successfulBatchCount += 1;
      addIdentityMembership(fold, capability.producerIds, event.who, 'material capability producerId');
      capability.firstSuccessfulMonth = capability.firstSuccessfulMonth === null
        ? event.atMonth : Math.min(capability.firstSuccessfulMonth, event.atMonth);
      capability.lastSuccessfulMonth = capability.lastSuccessfulMonth === null
        ? event.atMonth : Math.max(capability.lastSuccessfulMonth, event.atMonth);
      addEvidence(capability.successfulBatchEvidence, evidence);
    }
    if (event.status === 'blocked'
      && (outputs.some((materialId) => productSet.has(materialId))
        || inputs.some((materialId) => productSet.has(materialId)))) {
      capability.failedBatchCount += 1;
      addEvidence(capability.failedBatchEvidence, evidence);
    }
    if (event.status === 'completed' && tool !== null && definition.tools.includes(tool)) {
      capability.adoptedActionCount += 1;
      addEvidence(capability.adoptedActionEvidence, evidence);
    }
    if (facility !== null && siteSet.has(facility)) capability.productionSiteMaterialIds.add(facility);
    if (directOutput !== null && siteSet.has(directOutput)) capability.productionSiteMaterialIds.add(directOutput);
  }
}

const normalizeDemandCache = new WeakMap<ObserverDerivedHistoryProjectionFold, ReturnType<typeof normalizeDemand>>();

function discardFold(fold: ObserverDerivedHistoryProjectionFold): void {
  fold.status = 'discarded';
  fold.currentFacilityCandidates.length = 0;
  fold.facilities.clear();
  fold.demandEventBasisById.clear();
  fold.demandWorldRequiredIds.clear();
  fold.demandActionRequiredIds.clear();
  fold.residential.clear();
  fold.cultivationProjects.clear();
  for (const practice of Object.values(fold.practices)) {
    practice.agentIds.clear();
    practice.evidence.length = 0;
  }
  fold.trail.cellIds.clear();
  fold.trail.evidence.length = 0;
  fold.cultivated.cellIds.clear();
  fold.cultivated.evidence.length = 0;
  fold.teaching.actorIds.clear();
  fold.teaching.participantIds.clear();
  fold.teaching.evidence.length = 0;
  fold.burial.actorIds.clear();
  fold.burial.participantIds.clear();
  fold.burial.evidence.length = 0;
  for (const capability of Object.values(fold.capabilities)) {
    capability.producerIds.clear();
    capability.productionSiteMaterialIds.clear();
    capability.successfulBatchEvidence.length = 0;
    capability.failedBatchEvidence.length = 0;
    capability.adoptedActionEvidence.length = 0;
  }
  fold.identityMembershipCount = 0;
  normalizeDemandCache.delete(fold);
  delete fold.finishedResult;
}

function materializeDemandState(
  fold: ObserverDerivedHistoryProjectionFold,
  demand: ReturnType<typeof normalizeDemand>,
): void {
  fold.residential.clear();
  fold.cultivationProjects.clear();
  for (const structure of demand.residentialStructures) {
    let sourceRank: number | null = null;
    let sourceEvidence: ObserverHistoryEvidenceRef | null = null;
    for (let rank = 0; rank < structure.sourceEventIds.length; rank += 1) {
      const basis = fold.demandEventBasisById.get(structure.sourceEventIds[rank]);
      if (!basis?.latestWorldEvidence) continue;
      sourceRank = rank;
      sourceEvidence = { ...basis.latestWorldEvidence };
      break;
    }
    setBoundedEntry(fold.residential, structure.structureId, {
      structureId: structure.structureId,
      sourceRank,
      firstObservedMonth: sourceEvidence?.atMonth ?? null,
      sourceEvidence,
    }, OBSERVER_DERIVED_HISTORY_DEMAND_ENTITY_LIMIT, 'observer residential demand');
  }
  let totalPlantingWitnesses = 0;
  for (const project of demand.settledCultivationProjects) {
    const plantingByPosition = new Map<string, ObserverHistoryEvidenceRef>();
    const siteCells = new Set(project.siteCellIds);
    for (const eventId of project.completionEventIds) {
      const candidate = fold.demandEventBasisById.get(eventId)?.latestCultivationAction;
      if (!candidate || candidate.kind !== 'planting' || !siteCells.has(candidate.siteCellId)) continue;
      if (plantingByPosition.has(candidate.positionKey)) continue;
      if (totalPlantingWitnesses >= OBSERVER_DERIVED_HISTORY_SPATIAL_KEY_LIMIT) {
        throw new Error(`observer cultivation planting witnesses超过上限 ${OBSERVER_DERIVED_HISTORY_SPATIAL_KEY_LIMIT}`);
      }
      plantingByPosition.set(candidate.positionKey, { ...candidate.evidence });
      totalPlantingWitnesses += 1;
    }
    let harvestCountAtPlantedPositions = 0;
    const harvestWitnesses: ObserverHistoryEvidenceRef[] = [];
    for (const eventId of project.completionEventIds) {
      const candidate = fold.demandEventBasisById.get(eventId)?.latestCultivationAction;
      if (!candidate
        || candidate.kind !== 'harvest'
        || !siteCells.has(candidate.siteCellId)
        || !plantingByPosition.has(candidate.positionKey)) continue;
      harvestCountAtPlantedPositions += 1;
      addEvidence(harvestWitnesses, candidate.evidence);
    }
    setBoundedEntry(fold.cultivationProjects, project.projectId, {
      projectId: project.projectId,
      completedAtMonth: project.completedAtMonth,
      plantingByPosition,
      harvestCountAtPlantedPositions,
      harvestWitnesses,
    }, OBSERVER_DERIVED_HISTORY_DEMAND_ENTITY_LIMIT, 'observer settled cultivation demand');
  }
}

function assertDemandBasisResolved(fold: ObserverDerivedHistoryProjectionFold): void {
  for (const eventId of fold.demandWorldRequiredIds) {
    if (!fold.demandEventBasisById.get(eventId)?.worldLastWriteResolved) {
      throw new Error(`observer demand world event ${eventId} 的旧历史 last-write 未解析`);
    }
  }
  for (const eventId of fold.demandActionRequiredIds) {
    if (!fold.demandEventBasisById.get(eventId)?.actionLastWriteResolved) {
      throw new Error(`observer demand action event ${eventId} 的旧历史 last-write 未解析`);
    }
  }
}

function createObserverDerivedHistoryProjectionFold(
  target: ObserverDerivedHistoryTarget,
  inputDemand: ObserverDerivedHistoryDemand,
  genesisCoverageKnown: boolean,
): ObserverDerivedHistoryProjectionFold {
  assertTarget(target);
  const demand = normalizeDemand(inputDemand);
  const fold: ObserverDerivedHistoryProjectionFold = {
    status: 'open',
    target: { ...target },
    demandFingerprint: fingerprintDemand(demand),
    nextAbsoluteIndex: 0,
    lastEventId: null,
    lastEventMonth: null,
    resumeFloorMonth: null,
    resumeSourceEventCount: null,
    practices: {
      transfer: emptyPractice('transfer'),
      storage: emptyPractice('storage'),
      travel: emptyPractice('travel'),
      cultivation: emptyPractice('cultivation'),
      'mortuary-care': emptyPractice('mortuary-care'),
    },
    trail: {
      actionCount: 0,
      changedCellCount: 0,
      cellIds: new Set(),
      firstObservedMonth: null,
      lastObservedMonth: null,
      evidence: [],
    },
    cultivated: {
      actionCount: 0,
      harvestActionCount: 0,
      cellIds: new Set(),
      firstObservedMonth: null,
      lastObservedMonth: null,
      evidence: [],
    },
    facilities: new Map(),
    teaching: emptyInstitution(),
    burial: emptyInstitution(),
    capabilities: {
      'processed-wood': emptyCapability('processed-wood'),
      'masonry-stone': emptyCapability('masonry-stone'),
      bronze: emptyCapability('bronze'),
      iron: emptyCapability('iron'),
    },
    demandEventBasisById: new Map(demand.trackedEventIds.map((eventId) => [eventId, {
      eventId,
      latestWorldEvidence: null,
      worldLastWriteResolved: genesisCoverageKnown,
      latestCultivationAction: null,
      actionLastWriteResolved: genesisCoverageKnown,
    }])),
    demandWorldRequiredIds: new Set(demand.worldRequiredEventIds),
    demandActionRequiredIds: new Set(demand.actionRequiredEventIds),
    residential: new Map(),
    cultivationProjects: new Map(),
    identityMembershipCount: 0,
    currentFacilityMonth: null,
    currentFacilityCandidates: [],
  };
  normalizeDemandCache.set(fold, demand);
  return fold;
}

export function beginObserverDerivedHistoryProjection(
  target: ObserverDerivedHistoryTarget,
  inputDemand: ObserverDerivedHistoryDemand = {},
): ObserverDerivedHistoryProjectionFold {
  return createObserverDerivedHistoryProjectionFold(target, inputDemand, true);
}

function restorePractice(
  fold: ObserverDerivedHistoryProjectionFold,
  value: ObserverPracticeHistory,
): MutablePractice {
  assertCollectionLimit(value.agentIds.length, OBSERVER_DERIVED_HISTORY_IDENTITY_MEMBERSHIP_LIMIT, 'practice agentIds');
  assertCollectionLimit(value.evidence.length, OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT, 'practice evidence');
  const restored: MutablePractice = { ...value, agentIds: new Set(), evidence: value.evidence.map((item) => ({ ...item })) };
  value.agentIds.forEach((id) => addIdentityMembership(fold, restored.agentIds, id, 'practice agentId'));
  return restored;
}

function restoreInstitution(
  fold: ObserverDerivedHistoryProjectionFold,
  value: ObserverInstitutionBasisHistory,
): MutableInstitution {
  assertCollectionLimit(value.actorIds.length, OBSERVER_DERIVED_HISTORY_IDENTITY_MEMBERSHIP_LIMIT, 'institution actorIds');
  assertCollectionLimit(value.participantIds.length, OBSERVER_DERIVED_HISTORY_IDENTITY_MEMBERSHIP_LIMIT, 'institution participantIds');
  assertCollectionLimit(value.evidence.length, OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT, 'institution evidence');
  const restored: MutableInstitution = {
    actionCount: value.actionCount,
    actorIds: new Set(),
    participantIds: new Set(),
    firstObservedMonth: value.firstObservedMonth,
    lastObservedMonth: value.lastObservedMonth,
    evidence: value.evidence.map((item) => ({ ...item })),
  };
  value.actorIds.forEach((id) => addIdentityMembership(fold, restored.actorIds, id, 'institution actorId'));
  value.participantIds.forEach((id) => addIdentityMembership(fold, restored.participantIds, id, 'institution participantId'));
  return restored;
}

function restoreDemandEventBasis(
  fold: ObserverDerivedHistoryProjectionFold,
  previous: ObserverDerivedHistoryProjection,
): void {
  if (!Array.isArray(previous.demandEventBasis)) {
    throw new Error('observer derived history previous artifact 缺少 demand-closure event basis');
  }
  assertCollectionLimit(
    previous.demandEventBasis.length,
    OBSERVER_DERIVED_HISTORY_EVENT_BASIS_LIMIT,
    'observer demand-closure event basis',
  );
  const basisIds = new Set<string>();
  const worldEvidenceOrdinals = new Set<number>();
  for (const entry of previous.demandEventBasis) {
    const eventId = requiredString(entry.eventId, 'observer demand event basis eventId');
    if (basisIds.has(eventId)) {
      throw new Error(`observer demand event basis ${eventId} 重复`);
    }
    basisIds.add(eventId);
    if (typeof entry.worldLastWriteResolved !== 'boolean'
      || typeof entry.actionLastWriteResolved !== 'boolean'
      || (entry.actionLastWriteResolved && !entry.worldLastWriteResolved)) {
      throw new Error(`observer demand event basis ${eventId} 的 resolution seal 无效`);
    }
    const worldEvidence = entry.latestWorldEvidence;
    if (worldEvidence !== null) {
      if (!worldEvidence
        || !entry.worldLastWriteResolved
        || worldEvidence.eventId !== eventId
        || !Number.isSafeInteger(worldEvidence.absoluteIndex)
        || worldEvidence.absoluteIndex < 0
        || worldEvidence.absoluteIndex >= previous.target.eventCount
        || !Number.isSafeInteger(worldEvidence.atMonth)
        || worldEvidence.atMonth < 0
        || worldEvidenceOrdinals.has(worldEvidence.absoluteIndex)) {
        throw new Error(`observer demand event basis ${eventId} 的 world evidence 无效`);
      }
      worldEvidenceOrdinals.add(worldEvidence.absoluteIndex);
    }
    let action: ObserverCultivationEventBasis | null = null;
    if (entry.latestCultivationAction !== null) {
      const candidate = entry.latestCultivationAction;
      if (!candidate
        || !entry.actionLastWriteResolved
        || !worldEvidence
        || !candidate.evidence
        || (candidate.kind !== 'planting' && candidate.kind !== 'harvest')
        || candidate.evidence.eventId !== eventId
        || !Number.isSafeInteger(candidate.evidence.absoluteIndex)
        || candidate.evidence.absoluteIndex < 0
        || candidate.evidence.absoluteIndex > worldEvidence.absoluteIndex
        || !Number.isSafeInteger(candidate.evidence.atMonth)
        || candidate.evidence.atMonth < 0
        || candidate.evidence.atMonth > worldEvidence.atMonth
        || !Number.isSafeInteger(candidate.siteCellId)
        || candidate.siteCellId < 0
        || typeof candidate.positionKey !== 'string'
        || candidate.positionKey.length === 0) {
        throw new Error(`observer demand event basis ${eventId} 的 cultivation action 无效`);
      }
      action = {
        kind: candidate.kind,
        positionKey: candidate.positionKey,
        siteCellId: candidate.siteCellId,
        evidence: { ...candidate.evidence },
      };
    }
    if (fold.demandEventBasisById.has(eventId)) {
      fold.demandEventBasisById.set(eventId, {
        eventId,
        latestWorldEvidence: worldEvidence ? { ...worldEvidence } : null,
        worldLastWriteResolved: entry.worldLastWriteResolved,
        latestCultivationAction: action,
        actionLastWriteResolved: entry.actionLastWriteResolved,
      });
    }
  }
}

export function resumeObserverDerivedHistoryProjection(
  previous: ObserverDerivedHistoryProjection,
  target: ObserverDerivedHistoryTarget,
  inputDemand: ObserverDerivedHistoryDemand = {},
): ObserverDerivedHistoryProjectionFold {
  assertTarget(target);
  assertTarget(previous.target);
  if (previous.schemaVersion !== 2 || previous.definitionVersion !== OBSERVER_DERIVED_HISTORY_DEFINITION) {
    throw new Error('observer derived history previous artifact 版本不受支持');
  }
  if (previous.reducedThrough.eventCount !== previous.target.eventCount
    || previous.reducedThrough.tailEventId !== previous.target.tailEventId) {
    throw new Error('observer derived history previous artifact 未完整 seal');
  }
  if (previous.target.eventCount === 0
    ? previous.lastEventMonth !== null
    : !Number.isSafeInteger(previous.lastEventMonth) || Number(previous.lastEventMonth) < 0) {
    throw new Error('observer derived history previous artifact lastEventMonth 无效');
  }
  if (target.eventCount < previous.target.eventCount) throw new Error('observer derived history target 不得倒退');
  if (target.eventCount === previous.target.eventCount && target.tailEventId !== previous.target.tailEventId) {
    throw new Error('相同 observer derived history eventCount 的 tailEventId 不一致');
  }
  const fold = createObserverDerivedHistoryProjectionFold(target, inputDemand, false);
  fold.nextAbsoluteIndex = previous.target.eventCount;
  fold.lastEventId = previous.target.tailEventId;
  fold.lastEventMonth = previous.lastEventMonth;
  fold.resumeFloorMonth = previous.lastEventMonth;
  fold.resumeSourceEventCount = previous.target.eventCount;
  for (const key of PRACTICE_KEYS) fold.practices[key] = restorePractice(fold, previous.practices[key]);
  assertCollectionLimit(previous.regions.trail.cellIds.length, OBSERVER_DERIVED_HISTORY_SPATIAL_KEY_LIMIT, 'trail cells');
  assertCollectionLimit(previous.regions.cultivated.cellIds.length, OBSERVER_DERIVED_HISTORY_SPATIAL_KEY_LIMIT, 'cultivated cells');
  assertCollectionLimit(previous.regions.trail.evidence.length, OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT, 'trail evidence');
  assertCollectionLimit(previous.regions.cultivated.evidence.length, OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT, 'cultivated evidence');
  fold.trail = {
    actionCount: previous.regions.trail.formationActionCount,
    changedCellCount: previous.regions.trail.changedCellCount,
    cellIds: new Set(previous.regions.trail.cellIds),
    firstObservedMonth: previous.regions.trail.firstObservedMonth,
    lastObservedMonth: previous.regions.trail.lastObservedMonth,
    evidence: previous.regions.trail.evidence.map((item) => ({ ...item })),
  };
  fold.cultivated = {
    actionCount: previous.regions.cultivated.plantingActionCount,
    harvestActionCount: previous.regions.cultivated.harvestActionCount,
    cellIds: new Set(previous.regions.cultivated.cellIds),
    firstObservedMonth: previous.regions.cultivated.firstObservedMonth,
    lastObservedMonth: previous.regions.cultivated.lastObservedMonth,
    evidence: previous.regions.cultivated.evidence.map((item) => ({ ...item })),
  };
  assertCollectionLimit(previous.functionalBuildings.length, OBSERVER_DERIVED_HISTORY_FACILITY_LIMIT, 'functional buildings');
  fold.facilities.clear();
  for (const facility of previous.functionalBuildings) {
    assertCollectionLimit(facility.userIds.length, OBSERVER_DERIVED_HISTORY_IDENTITY_MEMBERSHIP_LIMIT, `facility ${facility.id} userIds`);
    assertCollectionLimit(facility.installationEvidence.length, OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT, `facility ${facility.id} installation evidence`);
    assertCollectionLimit(facility.useEvidence.length, OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT, `facility ${facility.id} use evidence`);
    const restored: MutableFacility = {
      id: facility.id,
      kind: facility.kind,
      materialId: facility.materialId,
      x: Number(facility.id.split(':')[2]),
      y: Number(facility.id.split(':')[3]),
      z: facility.z,
      installedAtMonth: facility.installedAtMonth,
      installationCount: facility.installationCount,
      installationEvidence: facility.installationEvidence.map((item) => ({ ...item })),
      useCount: facility.useCount,
      userIds: new Set(),
      useEvidence: facility.useEvidence.map((item) => ({ ...item })),
    };
    facility.userIds.forEach((id) => addIdentityMembership(fold, restored.userIds, id, 'facility userId'));
    setBoundedEntry(fold.facilities, facility.id, restored, OBSERVER_DERIVED_HISTORY_FACILITY_LIMIT, 'functional buildings');
  }
  fold.teaching = restoreInstitution(fold, previous.institutions.distributedTeaching);
  fold.burial = restoreInstitution(fold, previous.institutions.repeatedInterment);
  for (const key of CAPABILITY_KEYS) {
    const capability = previous.materialCapabilities[key];
    assertCollectionLimit(capability.producerIds.length, OBSERVER_DERIVED_HISTORY_IDENTITY_MEMBERSHIP_LIMIT, `${key} producerIds`);
    assertCollectionLimit(capability.productionSiteMaterialIds.length, OBSERVER_DERIVED_HISTORY_EVENT_COLLECTION_LIMIT, `${key} production sites`);
    assertCollectionLimit(capability.successfulBatchEvidence.length, OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT, `${key} successful evidence`);
    assertCollectionLimit(capability.failedBatchEvidence.length, OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT, `${key} failed evidence`);
    assertCollectionLimit(capability.adoptedActionEvidence.length, OBSERVER_DERIVED_HISTORY_EVIDENCE_LIMIT, `${key} adopted evidence`);
    fold.capabilities[key] = {
      ...capability,
      producerIds: new Set(),
      productionSiteMaterialIds: new Set(capability.productionSiteMaterialIds),
      successfulBatchEvidence: capability.successfulBatchEvidence.map((item) => ({ ...item })),
      failedBatchEvidence: capability.failedBatchEvidence.map((item) => ({ ...item })),
      adoptedActionEvidence: capability.adoptedActionEvidence.map((item) => ({ ...item })),
    };
    capability.producerIds.forEach((id) => addIdentityMembership(
      fold,
      fold.capabilities[key].producerIds,
      id,
      'material capability producerId',
    ));
  }
  restoreDemandEventBasis(fold, previous);
  return fold;
}

function validateEvent(event: WorldEvent, absoluteIndex: number, previousMonth: number | null): void {
  if (!event || typeof event !== 'object') throw new Error(`observer derived history event ${absoluteIndex} 无效`);
  requiredString(event.id, `observer derived history event ${absoluteIndex} id`);
  assertSafeNonNegativeInteger(event.atMonth, `observer derived history event ${absoluteIndex} atMonth`);
  if (previousMonth !== null && event.atMonth < previousMonth) {
    throw new Error(`observer derived history event ${absoluteIndex} 月份倒退`);
  }
}

function validateActionCollectionBounds(event: ActionFact): void {
  if (event.action.kind === 'act') {
    assertCollectionLimit(
      event.action.targets.length,
      OBSERVER_DERIVED_HISTORY_EVENT_COLLECTION_LIMIT,
      `action ${event.id} targets`,
    );
  } else if (event.action.kind === 'move') {
    assertCollectionLimit(
      event.pathSegment.length,
      OBSERVER_DERIVED_HISTORY_EVENT_COLLECTION_LIMIT,
      `action ${event.id} pathSegment`,
    );
  } else if (event.action.kind === 'communicate') {
    assertCollectionLimit(
      event.action.audience.length,
      OBSERVER_DERIVED_HISTORY_EVENT_COLLECTION_LIMIT,
      `action ${event.id} audience`,
    );
  }
}

const verifiedPrefixDemandOccurrences = new WeakSet<object>();

/**
 * Reduce one event from a store-verified prefix stream to the only facts the
 * demand last-write bridge needs. The occurrence carries process-local
 * provenance so arbitrary evidence objects cannot be promoted by the sealer.
 */
export function verifiedObserverPrefixDemandOccurrence(
  event: WorldEvent,
  absoluteIndex: number,
): Readonly<ObserverVerifiedPrefixDemandOccurrence> {
  assertSafeNonNegativeInteger(absoluteIndex, 'observer verified prefix absoluteIndex');
  validateEvent(event, absoluteIndex, null);
  if (event.kind === 'action') validateActionCollectionBounds(event);
  const evidence = eventEvidence(event, absoluteIndex);
  const occurrence = deepFreeze({
    eventId: event.id,
    evidence,
    isAction: event.kind === 'action',
    cultivationAction: event.kind === 'action'
      ? cultivationEventBasis(event, evidence)
      : null,
  });
  verifiedPrefixDemandOccurrences.add(occurrence);
  return occurrence;
}

/**
 * IDs whose current required last-write cannot be proven by the previous
 * demand basis plus the already-folded exact suffix. Only these IDs justify a
 * one-time verified previous-root scan.
 */
export function unresolvedVerifiedPrefixDemandEventIds(
  fold: ObserverDerivedHistoryProjectionFold,
): string[] {
  if (fold.status !== 'open') {
    throw new Error(`observer derived history fold 已${fold.status === 'finished' ? '完成' : '作废'}`);
  }
  if (fold.resumeSourceEventCount === null) return [];
  const unresolved = new Set<string>();
  for (const eventId of fold.demandWorldRequiredIds) {
    if (!fold.demandEventBasisById.get(eventId)?.worldLastWriteResolved) {
      unresolved.add(eventId);
    }
  }
  for (const eventId of fold.demandActionRequiredIds) {
    if (!fold.demandEventBasisById.get(eventId)?.actionLastWriteResolved) {
      unresolved.add(eventId);
    }
  }
  return [...unresolved].sort((left, right) => left.localeCompare(right));
}

function assertVerifiedPrefixOccurrence(
  occurrence: Readonly<ObserverVerifiedPrefixDemandOccurrence> | null,
  eventId: string,
  verifiedSourceEventCount: number,
  requireAction: boolean,
  label: string,
): void {
  if (occurrence === null) return;
  if (!verifiedPrefixDemandOccurrences.has(occurrence)
    || occurrence.eventId !== eventId
    || occurrence.evidence.eventId !== eventId
    || !Number.isSafeInteger(occurrence.evidence.absoluteIndex)
    || occurrence.evidence.absoluteIndex < 0
    || occurrence.evidence.absoluteIndex >= verifiedSourceEventCount
    || !Number.isSafeInteger(occurrence.evidence.atMonth)
    || occurrence.evidence.atMonth < 0
    || (requireAction && !occurrence.isAction)
    || (!occurrence.isAction && occurrence.cultivationAction !== null)) {
    throw new Error(`${label} 不属于 verified previous-root prefix`);
  }
}

/**
 * Seal exact previous-root last writes (including verified absence tombstones)
 * for newly required IDs. The strict successor must first stream and verify the
 * complete previous root; this seam accepts exactly the currently unresolved
 * closure and cannot overwrite a suffix-resolved last write.
 */
export function seedVerifiedPrefixDemandLastWrites(
  fold: ObserverDerivedHistoryProjectionFold,
  verifiedSourceEventCount: number,
  lastWrites: readonly Readonly<ObserverVerifiedPrefixDemandLastWrite>[],
): void {
  if (fold.status !== 'open') {
    throw new Error(`observer derived history fold 已${fold.status === 'finished' ? '完成' : '作废'}`);
  }
  if (!Number.isSafeInteger(verifiedSourceEventCount)
    || verifiedSourceEventCount < 0
    || fold.resumeSourceEventCount !== verifiedSourceEventCount) {
    throw new Error('observer prefix last-write seal 未绑定 exact previous-root eventCount');
  }
  const unresolved = unresolvedVerifiedPrefixDemandEventIds(fold);
  if (lastWrites.length !== unresolved.length) {
    throw new Error('observer prefix last-write seal 未完整覆盖 unresolved demand closure');
  }
  for (let index = 0; index < unresolved.length; index += 1) {
    const expectedEventId = unresolved[index];
    const candidate = lastWrites[index];
    if (!candidate || candidate.eventId !== expectedEventId) {
      throw new Error('observer prefix last-write seal 缺失、重复或未按 eventId 排序');
    }
    assertVerifiedPrefixOccurrence(
      candidate.latestWorld,
      expectedEventId,
      verifiedSourceEventCount,
      false,
      `observer prefix world last-write ${expectedEventId}`,
    );
    assertVerifiedPrefixOccurrence(
      candidate.latestAction,
      expectedEventId,
      verifiedSourceEventCount,
      true,
      `observer prefix action last-write ${expectedEventId}`,
    );
    if (candidate.latestAction !== null
      && (candidate.latestWorld === null
        || candidate.latestAction.evidence.absoluteIndex
          > candidate.latestWorld.evidence.absoluteIndex)) {
      throw new Error(`observer prefix last-write ${expectedEventId} 的 action/world 顺序无效`);
    }
    const current = fold.demandEventBasisById.get(expectedEventId);
    if (!current) {
      throw new Error(`observer prefix last-write ${expectedEventId} 不属于 demand closure`);
    }
    const latestWorldEvidence = current.worldLastWriteResolved
      ? current.latestWorldEvidence
      : candidate.latestWorld?.evidence ?? null;
    const latestCultivationAction = current.actionLastWriteResolved
      ? current.latestCultivationAction
      : candidate.latestAction?.cultivationAction ?? null;
    fold.demandEventBasisById.set(expectedEventId, {
      eventId: expectedEventId,
      latestWorldEvidence: latestWorldEvidence ? { ...latestWorldEvidence } : null,
      worldLastWriteResolved: true,
      latestCultivationAction: latestCultivationAction ? {
        ...latestCultivationAction,
        evidence: { ...latestCultivationAction.evidence },
      } : null,
      actionLastWriteResolved: true,
    });
  }
}

export function foldVerifiedObserverDerivedHistorySegment(
  fold: ObserverDerivedHistoryProjectionFold,
  events: readonly WorldEvent[],
  startAbsoluteIndex: number,
): ObserverDerivedHistoryProjectionFold {
  if (fold.status !== 'open') throw new Error(`observer derived history fold 已${fold.status === 'finished' ? '完成' : '作废'}`);
  try {
    assertSafeNonNegativeInteger(startAbsoluteIndex, 'observer derived history segment startAbsoluteIndex');
    if (startAbsoluteIndex !== fold.nextAbsoluteIndex) throw new Error('observer derived history segment 绝对 cursor 不连续');
    if (startAbsoluteIndex + events.length > fold.target.eventCount) throw new Error('observer derived history segment 超出 target');
    for (let offset = 0; offset < events.length; offset += 1) {
      const event = events[offset];
      if (!event) throw new Error(`observer derived history segment ${offset} 缺少事件`);
      const absoluteIndex = startAbsoluteIndex + offset;
      validateEvent(event, absoluteIndex, fold.lastEventMonth);
      if (fold.resumeFloorMonth !== null && absoluteIndex === startAbsoluteIndex
        && startAbsoluteIndex === fold.nextAbsoluteIndex && event.atMonth <= fold.resumeFloorMonth) {
        throw new Error('observer derived history incremental suffix 必须从新的月份开始');
      }
      if (event.kind === 'action') validateActionCollectionBounds(event);
      const evidence = eventEvidence(event, absoluteIndex);
      observeDemandEventBasis(fold, event, evidence);
      if (event.kind === 'action') {
        const action = event;
        if (action.action.kind === 'transfer' && action.status === 'completed') {
          observePractice(fold, fold.practices.transfer, action, evidence);
          if (action.action.from.kind === 'container' || action.action.to.kind === 'container') {
            observePractice(fold, fold.practices.storage, action, evidence);
          }
        }
        if (action.action.kind === 'move' && action.pathSegment.length > 1) {
          observePractice(fold, fold.practices.travel, action, evidence);
        }
        if (action.action.kind === 'act'
          && action.action.operation === 'combine'
          && Number(action.diff.outputMaterialId) === Material.CropSprout) {
          observePractice(fold, fold.practices.cultivation, action, evidence);
        }
        if (action.status === 'completed'
          && action.action.kind === 'act'
          && action.action.operation === 'inter'
          && action.diff.remainsInterred === true) {
          observePractice(fold, fold.practices['mortuary-care'], action, evidence);
        }
        queueFacilityObservation(fold, action, evidence);
        observeRegions(fold, action, evidence);
        observeInstitutions(fold, action, evidence);
        observeCapabilities(fold, action, evidence);
      }
      fold.nextAbsoluteIndex = absoluteIndex + 1;
      fold.lastEventId = event.id;
      fold.lastEventMonth = event.atMonth;
    }
    return fold;
  } catch (error) {
    discardFold(fold);
    throw error;
  }
}

function sortedStrings(values: Set<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function projectPractice(value: MutablePractice): ObserverPracticeHistory {
  return { ...value, agentIds: sortedStrings(value.agentIds), evidence: value.evidence.map((item) => ({ ...item })) };
}

function projectInstitution(value: MutableInstitution, satisfied: boolean): ObserverInstitutionBasisHistory {
  return {
    actionCount: value.actionCount,
    actorIds: sortedStrings(value.actorIds),
    participantIds: sortedStrings(value.participantIds),
    firstObservedMonth: value.firstObservedMonth,
    lastObservedMonth: value.lastObservedMonth,
    institutionThresholdSatisfied: satisfied,
    evidence: value.evidence.map((item) => ({ ...item })),
  };
}

export function finishObserverDerivedHistoryProjection(
  fold: ObserverDerivedHistoryProjectionFold,
): ObserverDerivedHistoryProjection {
  if (fold.status === 'discarded') throw new Error('observer derived history fold 已作废');
  if (fold.finishedResult) return fold.finishedResult;
  try {
    if (fold.nextAbsoluteIndex !== fold.target.eventCount) throw new Error('observer derived history fold 未到达 target eventCount');
    if (fold.lastEventId !== fold.target.tailEventId) throw new Error('observer derived history fold tailEventId 与 target 不一致');
    flushFacilityMonth(fold);
    const demand = normalizeDemandCache.get(fold);
    if (!demand) throw new Error('observer derived history fold 缺少已验证 demand');
    assertDemandBasisResolved(fold);
    materializeDemandState(fold, demand);
    const teachingSatisfied = fold.teaching.actionCount >= 6 && fold.teaching.participantIds.size >= 3;
    const burialSpan = fold.burial.firstObservedMonth === null || fold.burial.lastObservedMonth === null
      ? 0 : fold.burial.lastObservedMonth - fold.burial.firstObservedMonth;
    const burialSatisfied = fold.burial.actionCount >= 3 && fold.burial.actorIds.size >= 2 && burialSpan >= 12;
    const settledCultivationProjects = [...fold.cultivationProjects.values()]
      .sort((left, right) => left.completedAtMonth - right.completedAtMonth || left.projectId.localeCompare(right.projectId))
      .map((project): ObserverSettledCultivationProjectHistory => ({
        projectId: project.projectId,
        completedAtMonth: project.completedAtMonth,
        distinctPlantingPositionCount: project.plantingByPosition.size,
        harvestCountAtPlantedPositions: project.harvestCountAtPlantedPositions,
        plantingWitnesses: [...project.plantingByPosition.entries()].map(([positionKey, event]) => ({ positionKey, event: { ...event } })),
        harvestWitnesses: project.harvestWitnesses.map((item) => ({ ...item })),
      }));
    const established = settledCultivationProjects.find((project) => (
      project.distinctPlantingPositionCount >= 6 && project.harvestCountAtPlantedPositions >= 2
    ));
    const result: ObserverDerivedHistoryProjection = deepFreeze({
      schemaVersion: 2,
      definitionVersion: OBSERVER_DERIVED_HISTORY_DEFINITION,
      target: { ...fold.target },
      reducedThrough: { eventCount: fold.nextAbsoluteIndex, tailEventId: fold.lastEventId },
      demandFingerprint: fold.demandFingerprint,
      lastEventMonth: fold.lastEventMonth,
      practices: {
        transfer: projectPractice(fold.practices.transfer),
        storage: projectPractice(fold.practices.storage),
        travel: projectPractice(fold.practices.travel),
        cultivation: projectPractice(fold.practices.cultivation),
        'mortuary-care': projectPractice(fold.practices['mortuary-care']),
      },
      regions: {
        trail: {
          formationActionCount: fold.trail.actionCount,
          changedCellCount: fold.trail.changedCellCount,
          cellIds: [...fold.trail.cellIds].sort((left, right) => left - right),
          firstObservedMonth: fold.trail.firstObservedMonth,
          lastObservedMonth: fold.trail.lastObservedMonth,
          evidence: fold.trail.evidence.map((item) => ({ ...item })),
        },
        cultivated: {
          plantingActionCount: fold.cultivated.actionCount,
          harvestActionCount: fold.cultivated.harvestActionCount,
          cellIds: [...fold.cultivated.cellIds].sort((left, right) => left - right),
          firstObservedMonth: fold.cultivated.firstObservedMonth,
          lastObservedMonth: fold.cultivated.lastObservedMonth,
          evidence: fold.cultivated.evidence.map((item) => ({ ...item })),
        },
        residential: [...fold.residential.values()]
          .sort((left, right) => left.structureId.localeCompare(right.structureId))
          .map((value) => ({ ...value, sourceEvidence: value.sourceEvidence ? { ...value.sourceEvidence } : null })),
      },
      functionalBuildings: [...fold.facilities.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((facility) => ({
          id: facility.id,
          kind: facility.kind,
          materialId: facility.materialId,
          cellId: cellId(facility.x, facility.y),
          z: facility.z,
          installedAtMonth: facility.installedAtMonth,
          installationCount: facility.installationCount,
          installationEvidence: facility.installationEvidence.map((item) => ({ ...item })),
          useCount: facility.useCount,
          userIds: sortedStrings(facility.userIds),
          useEvidence: facility.useEvidence.map((item) => ({ ...item })),
        })),
      institutions: {
        distributedTeaching: projectInstitution(fold.teaching, teachingSatisfied),
        repeatedInterment: projectInstitution(fold.burial, burialSatisfied),
      },
      materialCapabilities: {
        'processed-wood': projectCapability(fold.capabilities['processed-wood']),
        'masonry-stone': projectCapability(fold.capabilities['masonry-stone']),
        bronze: projectCapability(fold.capabilities.bronze),
        iron: projectCapability(fold.capabilities.iron),
      },
      demandEventBasis: [...fold.demandEventBasisById.values()]
        .sort((left, right) => left.eventId.localeCompare(right.eventId))
        .map((entry) => ({
          eventId: entry.eventId,
          latestWorldEvidence: entry.latestWorldEvidence ? { ...entry.latestWorldEvidence } : null,
          worldLastWriteResolved: entry.worldLastWriteResolved,
          latestCultivationAction: entry.latestCultivationAction ? {
            ...entry.latestCultivationAction,
            evidence: { ...entry.latestCultivationAction.evidence },
          } : null,
          actionLastWriteResolved: entry.actionLastWriteResolved,
        })),
      settledCultivationProjects,
      establishedCultivationWitness: established ? {
        projectId: established.projectId,
        plantingEvidence: established.plantingWitnesses.slice(0, 6).map((item) => ({ ...item.event })),
        harvestEvidence: established.harvestWitnesses.slice(0, 2).map((item) => ({ ...item })),
      } : null,
      continuationReady: false,
      continuationGaps: OBSERVER_DERIVED_HISTORY_CONTINUATION_GAPS,
    });
    fold.status = 'finished';
    fold.finishedResult = result;
    normalizeDemandCache.delete(fold);
    return result;
  } catch (error) {
    discardFold(fold);
    throw error;
  }
}

function projectCapability(value: MutableCapability): ObserverMaterialCapabilityHistory {
  return {
    key: value.key,
    successfulBatchCount: value.successfulBatchCount,
    failedBatchCount: value.failedBatchCount,
    adoptedActionCount: value.adoptedActionCount,
    firstSuccessfulMonth: value.firstSuccessfulMonth,
    lastSuccessfulMonth: value.lastSuccessfulMonth,
    producerIds: sortedStrings(value.producerIds),
    productionSiteMaterialIds: [...value.productionSiteMaterialIds].sort((left, right) => left - right),
    successfulBatchEvidence: value.successfulBatchEvidence.map((item) => ({ ...item })),
    failedBatchEvidence: value.failedBatchEvidence.map((item) => ({ ...item })),
    adoptedActionEvidence: value.adoptedActionEvidence.map((item) => ({ ...item })),
  };
}

/** Fixture/migration helper: full replay still uses the exact same verified segment fold. */
export function projectObserverDerivedHistoryFromFullHistory(
  events: readonly WorldEvent[],
  target: ObserverDerivedHistoryTarget,
  demand: ObserverDerivedHistoryDemand = {},
): ObserverDerivedHistoryProjection {
  const fold = beginObserverDerivedHistoryProjection(target, demand);
  foldVerifiedObserverDerivedHistorySegment(fold, events, 0);
  return finishObserverDerivedHistoryProjection(fold);
}
