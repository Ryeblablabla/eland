import { Material, materialDefinition, type MaterialId } from './material';
import {
  voxelAt,
  type VoxelWorld,
} from '../world/grid';

export const MECHANICAL_POWER_WORLD_VERSION = 'mechanical-power-world-v1' as const;
export const MECHANICAL_POWER_PLAN_VERSION = 'mechanical-power-plan-v1' as const;
export const MECHANICAL_POWER_ACTION_BASIS_VERSION = 'mechanical-power-action-basis-v1' as const;
export const MECHANICAL_POWER_OPERATION_TECHNIQUE_ID = 'technique:mechanical-power:water-wheel-shaft-mill-operation' as const;
/** Successful loaded work is the only source of ordinary wear. */
export const MECHANICAL_POWER_OPERATION_WEAR = 20;
/** The same real load applies half the ordinary bronze-shaft wear to steel. */
export const MECHANICAL_POWER_STEEL_OPERATION_WEAR = 10;
/** A later loaded attempt exposes accumulated shaft wear before consuming its input. */
export const MECHANICAL_POWER_WORN_FAULT_THRESHOLD = 40;
/** A fault freezes only a bounded tail of exact causal proof ids. */
export const MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT = 8;
/** Long-running networks retain only a small replay hint; totals are scalar. */
export const MECHANICAL_POWER_RECENT_EVENT_LIMIT = 8;
/** Network-level provenance is a recent summary; components/faults own exact receipts. */
export const MECHANICAL_POWER_SOURCE_EVENT_LIMIT = 24;
/** Reliability pressure only needs the two most recent completed service cycles. */
export const MECHANICAL_POWER_RELIABILITY_CYCLE_RECEIPT_LIMIT = 2;
/** A cycle receipt keeps a small witness tail, not the network's cumulative operation list. */
export const MECHANICAL_POWER_RELIABILITY_LOAD_PROOF_LIMIT = 3;
export const MECHANICAL_POWER_RELIABILITY_CYCLE_RECEIPT_VERSION =
  'mechanical-power-reliability-cycle-receipt-v1' as const;

export type MechanicalDriveShaftMaterialId =
  | typeof Material.DriveShaft
  | typeof Material.SteelDriveShaft;

export interface MechanicalDriveShaftSpecification {
  materialId: MechanicalDriveShaftMaterialId;
  brokenMaterialId: typeof Material.BrokenDriveShaft;
  wearPerLoadedOperation: number;
}

const MECHANICAL_DRIVE_SHAFT_SPECIFICATIONS: readonly MechanicalDriveShaftSpecification[] = [
  {
    materialId: Material.DriveShaft,
    brokenMaterialId: Material.BrokenDriveShaft,
    wearPerLoadedOperation: MECHANICAL_POWER_OPERATION_WEAR,
  },
  {
    materialId: Material.SteelDriveShaft,
    brokenMaterialId: Material.BrokenDriveShaft,
    wearPerLoadedOperation: MECHANICAL_POWER_STEEL_OPERATION_WEAR,
  },
] as const;

export function mechanicalDriveShaftSpecification(
  materialId: MaterialId,
): MechanicalDriveShaftSpecification | undefined {
  return MECHANICAL_DRIVE_SHAFT_SPECIFICATIONS.find((candidate) => candidate.materialId === materialId);
}

export function isMechanicalDriveShaftMaterial(
  materialId: MaterialId,
): materialId is MechanicalDriveShaftMaterialId {
  return Boolean(mechanicalDriveShaftSpecification(materialId));
}

export interface MechanicalVoxelPosition {
  x: number;
  y: number;
  z: number;
}

/**
 * A current is an explicit generator fact, never an inference from adjacent
 * Water voxels. Each lane is represented independently so one blocked lane
 * can lose capacity without erasing the other lane.
 */
export interface WaterCurrentSegment {
  id: string;
  kind: 'water-current-segment';
  from: MechanicalVoxelPosition;
  to: MechanicalVoxelPosition;
  direction: { dx: number; dy: number; dz: number };
  capacity: number;
  /** Empty only for a headwater segment. Otherwise this is the directed source chain. */
  upstreamSegmentIds: string[];
  /** Every listed voxel must still be Water for this local edge to carry power. */
  requiredWaterVoxels: MechanicalVoxelPosition[];
  sourceKeys: string[];
}

export interface MechanicalPowerComponentInstallation {
  role: 'converter' | 'connector' | 'load';
  materialId: MaterialId;
  position: MechanicalVoxelPosition;
  projectId: string;
  installedAtMonth: number;
  installationEventId: string;
  sourceEventIds: string[];
  /** Original installation remains immutable; replacement service is explicit. */
  latestRepairEventId?: string;
  latestRepairSourceEventIds?: string[];
}

export interface MechanicalPowerFaultState {
  kind: 'commissioning-misalignment' | 'worn-drive-shaft';
  componentRole: MechanicalPowerComponentInstallation['role'];
  componentPosition: MechanicalVoxelPosition;
  atMonth: number;
  faultEventId: string;
  sourceEventIds: string[];
  /** Frozen before the voxel becomes the generic BrokenDriveShaft material. */
  /** Optional only for mechanical-power-v1 faults persisted before this frozen evidence existed. */
  failedComponentMaterialId?: MechanicalDriveShaftMaterialId;
  failedComponentInstallationEventId?: string;
  failedComponentRepairEventId?: string;
  /** Number of successful loaded operations in this service cycle. */
  serviceLoadedOperationCount?: number;
  /** Bounded, exact witnesses for this failure; never reconstructed from the broken voxel. */
  proofEventIds?: string[];
}

/**
 * A bounded physical receipt frozen when a real loaded service cycle ends in
 * shaft wear. It records what happened, never an observer era, expected
 * replacement, or recipe.
 */
export interface MechanicalPowerReliabilityCycleReceipt {
  version: typeof MECHANICAL_POWER_RELIABILITY_CYCLE_RECEIPT_VERSION;
  installationProjectId: string;
  networkId: string;
  operatorId: string;
  shaftMaterialId: MechanicalDriveShaftMaterialId;
  faultEventId: string;
  faultSourceEventIds: string[];
  shaftInstallationEventId: string;
  shaftInstallationSourceEventIds: string[];
  shaftRepairEventId?: string;
  shaftRepairSourceEventIds: string[];
  serviceLoadedOperationCount: number;
  loadedOperationEventIds: string[];
}

export interface MechanicalPowerNetworkState {
  id: string;
  planKey: string;
  installationProjectId: string;
  sourceSegmentId: string;
  components: MechanicalPowerComponentInstallation[];
  installationEventIds: string[];
  recentOperationEventIds: string[];
  recentFaultEventIds: string[];
  recentRepairEventIds: string[];
  /** Bounded recent provenance; exact durable evidence lives on components/faults/receipts. */
  sourceEventIds: string[];
  operationCount: number;
  faultCount: number;
  repairCount: number;
  /** Physical condition in [0, 100], maintained by authoritative domain actions. */
  condition: number;
  /** Optional only for mechanical-power-v1 saves written before material-specific wear. */
  serviceLoadedOperationCount?: number;
  /** Bounded successful-operation tail for fault proof in the current repair cycle. */
  serviceCycleOperationEventIds?: string[];
  /** Optional only for saves written before bounded reliability receipts existed. */
  reliabilityCycleReceipts?: MechanicalPowerReliabilityCycleReceipt[];
  fault: MechanicalPowerFaultState | null;
}

export interface MechanicalPowerWorldState {
  version: typeof MECHANICAL_POWER_WORLD_VERSION;
  sources: WaterCurrentSegment[];
  networks: MechanicalPowerNetworkState[];
}

export interface MechanicalPowerProjectPlan {
  version: typeof MECHANICAL_POWER_PLAN_VERSION;
  projectId: string;
  sourceSegmentId: string;
  wheelPosition: MechanicalVoxelPosition;
  shaftPositions: MechanicalVoxelPosition[];
  loadPosition: MechanicalVoxelPosition;
  sourceKeys: string[];
}

interface MechanicalPowerActionBasisBase {
  version: typeof MECHANICAL_POWER_ACTION_BASIS_VERSION;
  sourceSegmentId: string;
  sourceKeys: string[];
}

/** A person-local attend action may diagnose only this currently visible physical fault. */
export interface MechanicalPowerFaultObservationRef {
  version: 'mechanical-power-fault-observation-v1';
  installationProjectId: string;
  planKey: string;
  networkId: string;
  faultEventId: string;
}

export type MechanicalPowerActionBasis =
  | MechanicalPowerActionBasisBase & {
    mode: 'observe-source';
  }
  | MechanicalPowerActionBasisBase & {
    mode: 'install';
    projectId: string;
    planKey: string;
    networkId: string;
    componentRole: MechanicalPowerComponentInstallation['role'];
    componentMaterialId: MaterialId;
    componentPosition: MechanicalVoxelPosition;
  }
  | MechanicalPowerActionBasisBase & {
    mode: 'revise-site';
    projectId: string;
    /** The still-current plan that produced the exact physical conflict. */
    planKey: string;
    networkId: string;
    conflictEventId: string;
    revisedPlan: MechanicalPowerProjectPlan;
    revisedPlanKey: string;
    revisedNetworkId: string;
    contributionSite: { cellId: number; z: number };
  }
  | MechanicalPowerActionBasisBase & {
    mode: 'operate';
    projectId: string;
    planKey: string;
    networkId: string;
    inputMaterialId: MaterialId;
    outputMaterialId: MaterialId;
  }
  | MechanicalPowerActionBasisBase & {
    mode: 'operate-service';
    installationProjectId: string;
    maintenanceProjectId?: string;
    recoveryRepairEventId?: string;
    planKey: string;
    networkId: string;
    operationKnowledgeId: typeof MECHANICAL_POWER_OPERATION_TECHNIQUE_ID;
    inputMaterialId: MaterialId;
    outputMaterialId: MaterialId;
  }
  | MechanicalPowerActionBasisBase & {
    mode: 'repair';
    projectId: string;
    planKey: string;
    networkId: string;
    faultEventId: string;
    replacementMaterialId: MaterialId;
    toolMaterialId: MaterialId;
    /** Required by the steel-upgrade seam; old bronze repair remains readable. */
    replacementManufactureEventId?: string;
    replacementVerificationEventId?: string;
  }
  | MechanicalPowerActionBasisBase & {
    mode: 'repair-service';
    installationProjectId: string;
    maintenanceProjectId: string;
    planKey: string;
    networkId: string;
    faultEventId: string;
    diagnosisFactId: string;
    replacementMaterialId: MaterialId;
    toolMaterialId: MaterialId;
    /** Exact same-maintenance-project evidence required for a steel upgrade. */
    replacementManufactureEventId?: string;
    replacementVerificationEventId?: string;
  };

export function mechanicalPowerFaultObservationFactId(networkId: string, faultEventId: string): string {
  return `observation:mechanical-power-fault:${networkId}:${faultEventId}`;
}

export interface WaterCurrentAvailability {
  segmentId: string;
  available: boolean;
  availableCapacity: number;
  supportingSegmentIds: string[];
  reason?: 'missing-source' | 'invalid-source' | 'blocked-water' | 'upstream-unavailable' | 'cyclic-source-chain';
}

export interface MechanicalPowerTopologyValidation {
  valid: boolean;
  reason?:
    | 'source-unavailable'
    | 'wheel-not-adjacent-to-source'
    | 'missing-drive-shaft'
    | 'duplicate-component-position'
    | 'disconnected-axis'
    | 'bent-axis'
    | 'wheel-material-mismatch'
    | 'shaft-material-mismatch'
    | 'load-material-mismatch';
}

export function emptyMechanicalPowerWorldState(
  sources: WaterCurrentSegment[] = [],
): MechanicalPowerWorldState {
  return {
    version: MECHANICAL_POWER_WORLD_VERSION,
    sources: structuredClone(sources),
    networks: [],
  };
}

function isIntegerPosition(position: MechanicalVoxelPosition): boolean {
  return Number.isInteger(position.x)
    && Number.isInteger(position.y)
    && Number.isInteger(position.z);
}

function samePosition(left: MechanicalVoxelPosition, right: MechanicalVoxelPosition): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function positionKey(position: MechanicalVoxelPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

function axisStep(from: MechanicalVoxelPosition, to: MechanicalVoxelPosition): { dx: number; dy: number; dz: number } {
  return { dx: to.x - from.x, dy: to.y - from.y, dz: to.z - from.z };
}

function isUnitAxisStep(step: { dx: number; dy: number; dz: number }): boolean {
  return Math.abs(step.dx) + Math.abs(step.dy) + Math.abs(step.dz) === 1;
}

function sameStep(
  left: { dx: number; dy: number; dz: number },
  right: { dx: number; dy: number; dz: number },
): boolean {
  return left.dx === right.dx && left.dy === right.dy && left.dz === right.dz;
}

export function waterCurrentSegmentIsStructurallyValid(segment: WaterCurrentSegment): boolean {
  const expectedDirection = axisStep(segment.from, segment.to);
  return Boolean(segment.id)
    && segment.kind === 'water-current-segment'
    && isIntegerPosition(segment.from)
    && isIntegerPosition(segment.to)
    && !samePosition(segment.from, segment.to)
    && segment.direction.dx === expectedDirection.dx
    && segment.direction.dy === expectedDirection.dy
    && segment.direction.dz === expectedDirection.dz
    && expectedDirection.dy > 0
    && Math.abs(expectedDirection.dx) <= 1
    && expectedDirection.dy === 1
    && expectedDirection.dz === 0
    && Number.isFinite(segment.capacity)
    && segment.capacity > 0
    && segment.requiredWaterVoxels.length >= 2
    && segment.requiredWaterVoxels.some((position) => samePosition(position, segment.from))
    && segment.requiredWaterVoxels.some((position) => samePosition(position, segment.to))
    && segment.sourceKeys.length > 0;
}

export function waterCurrentSegmentHasLocalWater(
  world: VoxelWorld,
  segment: WaterCurrentSegment,
): boolean {
  return waterCurrentSegmentIsStructurallyValid(segment)
    && segment.requiredWaterVoxels.every((position) => voxelAt(world, position.x, position.y, position.z) === Material.Water);
}

/**
 * Resolve current from headwater to downstream edges. Merely restoring a
 * downstream Water voxel cannot reactivate it while its persisted directed
 * upstream chain remains broken.
 */
export function resolveWaterCurrentAvailability(
  world: VoxelWorld,
  mechanicalPower: MechanicalPowerWorldState | undefined,
): WaterCurrentAvailability[] {
  if (!mechanicalPower || mechanicalPower.version !== MECHANICAL_POWER_WORLD_VERSION) return [];
  const byId = new Map(mechanicalPower.sources.map((source) => [source.id, source]));
  const resolved = new Map<string, WaterCurrentAvailability>();
  const visiting = new Set<string>();

  const resolve = (segmentId: string): WaterCurrentAvailability => {
    const cached = resolved.get(segmentId);
    if (cached) return cached;
    const segment = byId.get(segmentId);
    if (!segment) return {
      segmentId,
      available: false,
      availableCapacity: 0,
      supportingSegmentIds: [],
      reason: 'missing-source',
    };
    if (visiting.has(segmentId)) return {
      segmentId,
      available: false,
      availableCapacity: 0,
      supportingSegmentIds: [],
      reason: 'cyclic-source-chain',
    };
    if (!waterCurrentSegmentIsStructurallyValid(segment)) {
      const result: WaterCurrentAvailability = {
        segmentId,
        available: false,
        availableCapacity: 0,
        supportingSegmentIds: [],
        reason: 'invalid-source',
      };
      resolved.set(segmentId, result);
      return result;
    }
    if (!waterCurrentSegmentHasLocalWater(world, segment)) {
      const result: WaterCurrentAvailability = {
        segmentId,
        available: false,
        availableCapacity: 0,
        supportingSegmentIds: [],
        reason: 'blocked-water',
      };
      resolved.set(segmentId, result);
      return result;
    }
    visiting.add(segmentId);
    const upstream = segment.upstreamSegmentIds.map((upstreamId) => {
      const upstreamSource = byId.get(upstreamId);
      if (upstreamSource && !samePosition(upstreamSource.to, segment.from)) {
        return {
          segmentId: upstreamId,
          available: false,
          availableCapacity: 0,
          supportingSegmentIds: [],
          reason: 'invalid-source' as const,
        };
      }
      return resolve(upstreamId);
    });
    visiting.delete(segmentId);
    const upstreamAvailable = segment.upstreamSegmentIds.length === 0
      || upstream.some((candidate) => candidate.available);
    const result: WaterCurrentAvailability = upstreamAvailable
      ? {
        segmentId,
        available: true,
        availableCapacity: segment.capacity,
        supportingSegmentIds: [
          ...new Set([
            ...upstream.filter((candidate) => candidate.available).flatMap((candidate) => candidate.supportingSegmentIds),
            segmentId,
          ]),
        ],
      }
      : {
        segmentId,
        available: false,
        availableCapacity: 0,
        supportingSegmentIds: [],
        reason: upstream.some((candidate) => candidate.reason === 'cyclic-source-chain')
          ? 'cyclic-source-chain'
          : 'upstream-unavailable',
      };
    resolved.set(segmentId, result);
    return result;
  };

  return mechanicalPower.sources.map((source) => resolve(source.id));
}

export function waterCurrentAvailabilityFor(
  world: VoxelWorld,
  mechanicalPower: MechanicalPowerWorldState | undefined,
  segmentId: string,
): WaterCurrentAvailability {
  return resolveWaterCurrentAvailability(world, mechanicalPower)
    .find((candidate) => candidate.segmentId === segmentId) ?? {
      segmentId,
      available: false,
      availableCapacity: 0,
      supportingSegmentIds: [],
      reason: 'missing-source',
    };
}

export function availableWaterCurrentCapacity(
  world: VoxelWorld,
  mechanicalPower: MechanicalPowerWorldState | undefined,
): number {
  return resolveWaterCurrentAvailability(world, mechanicalPower)
    .reduce((total, current) => total + current.availableCapacity, 0);
}

function canonicalPosition(position: MechanicalVoxelPosition): string {
  return `${position.x}:${position.y}:${position.z}`;
}

export function mechanicalPowerPlanKey(plan: MechanicalPowerProjectPlan): string {
  return [
    MECHANICAL_POWER_PLAN_VERSION,
    plan.sourceSegmentId,
    `wheel=${canonicalPosition(plan.wheelPosition)}`,
    `shaft=${plan.shaftPositions.map(canonicalPosition).join('>')}`,
    `load=${canonicalPosition(plan.loadPosition)}`,
  ].join('|');
}

export interface MechanicalPowerInstallationSiteValidation {
  valid: boolean;
  reason?:
    | 'invalid-plan'
    | 'missing-source'
    | 'source-mismatch'
    | 'invalid-axis'
    | 'duplicate-position'
    | 'component-position-unavailable'
    | 'wheel-not-over-bound-current'
    | 'component-unsupported';
}

/**
 * Validate the physical site of a not-yet-installed one-shaft network. This is
 * shared by proposal compilation and authoritative plan revision so the
 * planner cannot offer geometry that the domain would later reject. It reads
 * only the current grid and the plan's already-observed current segment.
 */
export function validateMechanicalPowerInstallationSite(
  world: VoxelWorld,
  mechanicalPower: MechanicalPowerWorldState | undefined,
  plan: MechanicalPowerProjectPlan,
): MechanicalPowerInstallationSiteValidation {
  if (plan.version !== MECHANICAL_POWER_PLAN_VERSION
    || !plan.projectId
    || plan.shaftPositions.length !== 1) return { valid: false, reason: 'invalid-plan' };
  const source = mechanicalPower?.version === MECHANICAL_POWER_WORLD_VERSION
    ? mechanicalPower.sources.find((candidate) => candidate.id === plan.sourceSegmentId)
    : undefined;
  if (!source) return { valid: false, reason: 'missing-source' };
  if (source.sourceKeys.length !== plan.sourceKeys.length
    || source.sourceKeys.some((sourceKey, index) => sourceKey !== plan.sourceKeys[index])) {
    return { valid: false, reason: 'source-mismatch' };
  }
  const shaft = plan.shaftPositions[0];
  const wheelToShaft = axisStep(plan.wheelPosition, shaft);
  const shaftToLoad = axisStep(shaft, plan.loadPosition);
  if (!isUnitAxisStep(wheelToShaft)
    || wheelToShaft.dz !== 0
    || !sameStep(wheelToShaft, shaftToLoad)) return { valid: false, reason: 'invalid-axis' };
  const positions = [plan.wheelPosition, shaft, plan.loadPosition];
  if (new Set(positions.map(positionKey)).size !== positions.length) {
    return { valid: false, reason: 'duplicate-position' };
  }
  if (positions.some((position) => position.x < 0
    || position.x >= world.width
    || position.y < 0
    || position.y >= world.depth
    || position.z <= 0
    || position.z >= world.levels
    || voxelAt(world, position.x, position.y, position.z) !== Material.Air)) {
    return { valid: false, reason: 'component-position-unavailable' };
  }
  const wheelIsOverBoundCurrent = source.requiredWaterVoxels.some((position) => (
    position.x === plan.wheelPosition.x
      && position.y === plan.wheelPosition.y
      && position.z + 1 === plan.wheelPosition.z
      && voxelAt(world, position.x, position.y, position.z) === Material.Water
  ));
  if (!wheelIsOverBoundCurrent) return { valid: false, reason: 'wheel-not-over-bound-current' };
  if ([shaft, plan.loadPosition].some((position) => materialDefinition(
    voxelAt(world, position.x, position.y, position.z - 1),
  ).phase !== 'solid')) return { valid: false, reason: 'component-unsupported' };
  return { valid: true };
}

/**
 * The next physical component named by a frozen plan. This exposes only the
 * planned output identity, never its recipe or input bill of materials.
 */
export function pendingMechanicalPowerComponentMaterialId(
  mechanicalPower: MechanicalPowerWorldState | undefined,
  plan: MechanicalPowerProjectPlan,
): MaterialId | undefined {
  const network = mechanicalPower?.networks.find((candidate) => (
    candidate.installationProjectId === plan.projectId
      && candidate.planKey === mechanicalPowerPlanKey(plan)
      && candidate.sourceSegmentId === plan.sourceSegmentId
  ));
  const installed = (
    role: MechanicalPowerComponentInstallation['role'],
    materialId: MaterialId | 'drive-shaft',
    position: MechanicalVoxelPosition,
  ) => Boolean(network?.components.some((component) => (
    component.role === role
      && (materialId === 'drive-shaft'
        ? isMechanicalDriveShaftMaterial(component.materialId)
        : component.materialId === materialId)
      && samePosition(component.position, position)
  )));
  if (!installed('load', Material.Mill, plan.loadPosition)) return Material.Mill;
  if (plan.shaftPositions.some((position) => !installed('connector', 'drive-shaft', position))) {
    return Material.DriveShaft;
  }
  if (!installed('converter', Material.WaterWheel, plan.wheelPosition)) return Material.WaterWheel;
  if (network?.fault) return Material.DriveShaft;
  return undefined;
}

function stableKeyHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function mechanicalPowerNetworkId(plan: MechanicalPowerProjectPlan): string {
  return `mechanical-network:${plan.projectId}:${stableKeyHash(mechanicalPowerPlanKey(plan))}`;
}

function stringEventIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((eventId): eventId is string => typeof eventId === 'string' && eventId.length > 0)
    : [];
}

function boundedUniqueEventIds(values: readonly string[], limit: number): string[] {
  const seen = new Set<string>();
  const newestFirst: string[] = [];
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (!value || seen.has(value)) continue;
    seen.add(value);
    newestFirst.push(value);
    if (newestFirst.length === limit) break;
  }
  return newestFirst.reverse();
}

function migratedEventCount(current: unknown, legacyIds: readonly string[], recentIds: readonly string[]): number {
  const normalizedCurrent = typeof current === 'number' && Number.isSafeInteger(current) && current >= 0
    ? current
    : 0;
  return Math.max(normalizedCurrent, new Set(legacyIds).size, recentIds.length);
}

/**
 * In-place v17 compatibility migration. The removed arrays were lookup caches,
 * not causal state: exact project facts and physical receipts remain elsewhere.
 */
export function migrateMechanicalPowerNetworkState(
  network: MechanicalPowerNetworkState,
): MechanicalPowerNetworkState {
  const legacy = network as unknown as {
    operationEventIds?: unknown;
    faultEventIds?: unknown;
    repairEventIds?: unknown;
    recentOperationEventIds?: unknown;
    recentFaultEventIds?: unknown;
    recentRepairEventIds?: unknown;
    sourceEventIds?: unknown;
    operationCount?: unknown;
    faultCount?: unknown;
    repairCount?: unknown;
    serviceCycleOperationEventIds?: unknown;
    serviceLoadedOperationCount?: unknown;
  };
  const legacyOperationIds = stringEventIds(legacy.operationEventIds);
  const legacyFaultIds = stringEventIds(legacy.faultEventIds);
  const legacyRepairIds = stringEventIds(legacy.repairEventIds);
  const recentOperationEventIds = boundedUniqueEventIds(
    stringEventIds(legacy.recentOperationEventIds).length
      ? stringEventIds(legacy.recentOperationEventIds)
      : legacyOperationIds,
    MECHANICAL_POWER_RECENT_EVENT_LIMIT,
  );
  const recentFaultEventIds = boundedUniqueEventIds(
    stringEventIds(legacy.recentFaultEventIds).length
      ? stringEventIds(legacy.recentFaultEventIds)
      : legacyFaultIds,
    MECHANICAL_POWER_RECENT_EVENT_LIMIT,
  );
  const recentRepairEventIds = boundedUniqueEventIds(
    stringEventIds(legacy.recentRepairEventIds).length
      ? stringEventIds(legacy.recentRepairEventIds)
      : legacyRepairIds,
    MECHANICAL_POWER_RECENT_EVENT_LIMIT,
  );
  network.recentOperationEventIds = recentOperationEventIds;
  network.recentFaultEventIds = recentFaultEventIds;
  network.recentRepairEventIds = recentRepairEventIds;
  network.operationCount = migratedEventCount(
    legacy.operationCount,
    legacyOperationIds,
    recentOperationEventIds,
  );
  network.faultCount = migratedEventCount(legacy.faultCount, legacyFaultIds, recentFaultEventIds);
  network.repairCount = migratedEventCount(legacy.repairCount, legacyRepairIds, recentRepairEventIds);
  network.sourceEventIds = boundedUniqueEventIds(
    stringEventIds(legacy.sourceEventIds),
    MECHANICAL_POWER_SOURCE_EVENT_LIMIT,
  );
  const weakestInstalledShaftWear = network.components.reduce((largestWear, component) => (
    component.role === 'connector'
      ? Math.max(
        largestWear,
        mechanicalDriveShaftSpecification(component.materialId)?.wearPerLoadedOperation ?? 0,
      )
      : largestWear
  ), 0) || MECHANICAL_POWER_OPERATION_WEAR;
  const serviceLoadedOperationCount = typeof legacy.serviceLoadedOperationCount === 'number'
    && Number.isSafeInteger(legacy.serviceLoadedOperationCount)
    && legacy.serviceLoadedOperationCount >= 0
    ? legacy.serviceLoadedOperationCount
    : Math.max(0, Math.round((100 - network.condition) / weakestInstalledShaftWear));
  network.serviceLoadedOperationCount = serviceLoadedOperationCount;
  const existingServiceCycleIds = stringEventIds(legacy.serviceCycleOperationEventIds);
  network.serviceCycleOperationEventIds = boundedUniqueEventIds(
    existingServiceCycleIds.length
      ? existingServiceCycleIds
      : serviceLoadedOperationCount > 0
        ? legacyOperationIds.slice(-serviceLoadedOperationCount)
        : [],
    MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT,
  );
  delete legacy.operationEventIds;
  delete legacy.faultEventIds;
  delete legacy.repairEventIds;
  return network;
}

export function migrateMechanicalPowerWorldState(
  world: MechanicalPowerWorldState,
): MechanicalPowerWorldState {
  for (const network of world.networks) migrateMechanicalPowerNetworkState(network);
  return world;
}

export function createMechanicalPowerNetwork(plan: MechanicalPowerProjectPlan): MechanicalPowerNetworkState {
  return {
    id: mechanicalPowerNetworkId(plan),
    planKey: mechanicalPowerPlanKey(plan),
    installationProjectId: plan.projectId,
    sourceSegmentId: plan.sourceSegmentId,
    components: [],
    installationEventIds: [],
    recentOperationEventIds: [],
    recentFaultEventIds: [],
    recentRepairEventIds: [],
    sourceEventIds: [],
    operationCount: 0,
    faultCount: 0,
    repairCount: 0,
    condition: 100,
    serviceLoadedOperationCount: 0,
    serviceCycleOperationEventIds: [],
    fault: null,
  };
}

function appendUnique(target: string[], values: readonly string[]): void {
  const existing = new Set(target);
  for (const value of values) {
    if (!value || existing.has(value)) continue;
    target.push(value);
    existing.add(value);
  }
}

export function ensureMechanicalPowerNetwork(
  state: MechanicalPowerWorldState,
  plan: MechanicalPowerProjectPlan,
): MechanicalPowerNetworkState {
  const id = mechanicalPowerNetworkId(plan);
  const planKey = mechanicalPowerPlanKey(plan);
  const matching = state.networks.find((network) => network.id === id
    && network.planKey === planKey
    && network.sourceSegmentId === plan.sourceSegmentId
    && network.installationProjectId === plan.projectId);
  if (matching) return matching;
  if (state.networks.some((network) => network.id === id)) {
    throw new Error(`机械网络身份冲突：${id}`);
  }
  const created = createMechanicalPowerNetwork(plan);
  state.networks.push(created);
  return created;
}

export function recordMechanicalPowerInstallation(
  network: MechanicalPowerNetworkState,
  installation: MechanicalPowerComponentInstallation,
): void {
  migrateMechanicalPowerNetworkState(network);
  const existing = network.components.find((component) => component.role === installation.role
    && samePosition(component.position, installation.position));
  if (existing) {
    appendUnique(existing.sourceEventIds, [installation.installationEventId, ...installation.sourceEventIds]);
  } else {
    network.components.push(structuredClone(installation));
  }
  appendUnique(network.installationEventIds, [installation.installationEventId]);
  network.sourceEventIds = boundedUniqueEventIds(
    [...network.sourceEventIds, installation.installationEventId, ...installation.sourceEventIds],
    MECHANICAL_POWER_SOURCE_EVENT_LIMIT,
  );
}

function boundedEventIds(values: readonly string[]): string[] {
  return boundedUniqueEventIds(values, MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT);
}

function hasUniqueBoundedEventIds(value: unknown, limit: number, allowEmpty = false): value is string[] {
  if (!Array.isArray(value)
    || value.length > limit
    || (!allowEmpty && value.length === 0)
    || value.some((eventId) => typeof eventId !== 'string' || eventId.length === 0)) return false;
  return new Set(value).size === value.length;
}

function isNonEmptyId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function reliabilityCycleReceiptValid(
  network: MechanicalPowerNetworkState,
  value: unknown,
): value is MechanicalPowerReliabilityCycleReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<MechanicalPowerReliabilityCycleReceipt>;
  const hasRepair = receipt.shaftRepairEventId !== undefined;
  return receipt.version === MECHANICAL_POWER_RELIABILITY_CYCLE_RECEIPT_VERSION
    && receipt.installationProjectId === network.installationProjectId
    && receipt.networkId === network.id
    && isNonEmptyId(receipt.operatorId)
    && (receipt.shaftMaterialId === Material.DriveShaft
      || receipt.shaftMaterialId === Material.SteelDriveShaft)
    && isNonEmptyId(receipt.faultEventId)
    && isNonEmptyId(receipt.shaftInstallationEventId)
    && (!hasRepair || isNonEmptyId(receipt.shaftRepairEventId))
    && hasUniqueBoundedEventIds(receipt.faultSourceEventIds, MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT)
    && hasUniqueBoundedEventIds(
      receipt.shaftInstallationSourceEventIds,
      MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT,
    )
    && hasUniqueBoundedEventIds(
      receipt.shaftRepairSourceEventIds,
      MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT,
      !hasRepair,
    )
    && (hasRepair || receipt.shaftRepairSourceEventIds.length === 0)
    && Number.isSafeInteger(receipt.serviceLoadedOperationCount)
    && Number(receipt.serviceLoadedOperationCount) >= 1
    && hasUniqueBoundedEventIds(
      receipt.loadedOperationEventIds,
      MECHANICAL_POWER_RELIABILITY_LOAD_PROOF_LIMIT,
    )
    && receipt.loadedOperationEventIds.length <= Number(receipt.serviceLoadedOperationCount);
}

/**
 * Returns the exact bounded receipt tail, or null for an old/malformed shell.
 * Callers that own persistence may distinguish an absent legacy field from a
 * malformed present field and fail closed instead of silently trimming it.
 */
export function validatedMechanicalPowerReliabilityCycleReceipts(
  network: MechanicalPowerNetworkState,
): readonly MechanicalPowerReliabilityCycleReceipt[] | null {
  const raw = (network as MechanicalPowerNetworkState & { reliabilityCycleReceipts?: unknown })
    .reliabilityCycleReceipts;
  if (raw === undefined) return null;
  if (!Array.isArray(raw)
    || raw.length > MECHANICAL_POWER_RELIABILITY_CYCLE_RECEIPT_LIMIT
    || raw.some((receipt) => !reliabilityCycleReceiptValid(network, receipt))) return null;
  const faultEventIds = raw.map((receipt) => receipt.faultEventId);
  return new Set(faultEventIds).size === faultEventIds.length
    && (network.fault?.kind !== 'worn-drive-shaft'
      || raw.at(-1)?.faultEventId === network.fault.faultEventId)
    ? raw as MechanicalPowerReliabilityCycleReceipt[]
    : null;
}

function sameReliabilityCycleReceipt(
  left: MechanicalPowerReliabilityCycleReceipt,
  right: MechanicalPowerReliabilityCycleReceipt,
): boolean {
  const sameIds = (a: readonly string[], b: readonly string[]) => (
    a.length === b.length && a.every((eventId, index) => eventId === b[index])
  );
  return left.version === right.version
    && left.installationProjectId === right.installationProjectId
    && left.networkId === right.networkId
    && left.operatorId === right.operatorId
    && left.shaftMaterialId === right.shaftMaterialId
    && left.faultEventId === right.faultEventId
    && left.shaftInstallationEventId === right.shaftInstallationEventId
    && left.shaftRepairEventId === right.shaftRepairEventId
    && left.serviceLoadedOperationCount === right.serviceLoadedOperationCount
    && sameIds(left.faultSourceEventIds, right.faultSourceEventIds)
    && sameIds(left.shaftInstallationSourceEventIds, right.shaftInstallationSourceEventIds)
    && sameIds(left.shaftRepairSourceEventIds, right.shaftRepairSourceEventIds)
    && sameIds(left.loadedOperationEventIds, right.loadedOperationEventIds);
}

function recordMechanicalPowerReliabilityCycleReceipt(
  network: MechanicalPowerNetworkState,
  fault: MechanicalPowerFaultState,
  component: MechanicalPowerComponentInstallation,
  shaftMaterialId: MechanicalDriveShaftMaterialId,
  serviceLoadedOperationCount: number,
  operatorId: string,
): void {
  const receipt: MechanicalPowerReliabilityCycleReceipt = {
    version: MECHANICAL_POWER_RELIABILITY_CYCLE_RECEIPT_VERSION,
    installationProjectId: network.installationProjectId,
    networkId: network.id,
    operatorId,
    shaftMaterialId,
    faultEventId: fault.faultEventId,
    faultSourceEventIds: boundedEventIds(fault.sourceEventIds),
    shaftInstallationEventId: component.installationEventId,
    shaftInstallationSourceEventIds: boundedEventIds(component.sourceEventIds),
    ...(component.latestRepairEventId ? { shaftRepairEventId: component.latestRepairEventId } : {}),
    shaftRepairSourceEventIds: boundedEventIds(component.latestRepairSourceEventIds ?? []),
    serviceLoadedOperationCount,
    loadedOperationEventIds: boundedEventIds(
      network.serviceCycleOperationEventIds ?? [],
    ).slice(-MECHANICAL_POWER_RELIABILITY_LOAD_PROOF_LIMIT),
  };
  if (!reliabilityCycleReceiptValid(network, receipt)) {
    throw new Error('机械磨损周期缺少可冻结的有界可靠性收据');
  }
  const existing = validatedMechanicalPowerReliabilityCycleReceipts(network);
  if (network.reliabilityCycleReceipts !== undefined && !existing) {
    throw new Error('机械网络已有的可靠性周期收据无效');
  }
  const sameFault = existing?.find((candidate) => candidate.faultEventId === receipt.faultEventId);
  if (sameFault) {
    if (!sameReliabilityCycleReceipt(sameFault, receipt)) {
      throw new Error('同一机械故障出现冲突的可靠性周期收据');
    }
    return;
  }
  network.reliabilityCycleReceipts = [
    ...(existing ?? []),
    structuredClone(receipt),
  ].slice(-MECHANICAL_POWER_RELIABILITY_CYCLE_RECEIPT_LIMIT);
}

export function currentMechanicalPowerServiceLoadedOperationCount(
  network: MechanicalPowerNetworkState,
  shaftMaterialId: MechanicalDriveShaftMaterialId = Material.DriveShaft,
): number {
  if (Number.isSafeInteger(network.serviceLoadedOperationCount)
    && network.serviceLoadedOperationCount! >= 0) return network.serviceLoadedOperationCount!;
  const specification = mechanicalDriveShaftSpecification(shaftMaterialId)!;
  return Math.max(0, Math.round((100 - network.condition) / specification.wearPerLoadedOperation));
}

export function mechanicalPowerFaultProofEventIds(
  network: MechanicalPowerNetworkState,
  component: MechanicalPowerComponentInstallation,
): string[] {
  return boundedEventIds([
    component.installationEventId,
    ...component.sourceEventIds.slice(-MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT),
    ...(component.latestRepairEventId ? [component.latestRepairEventId] : []),
    ...(component.latestRepairSourceEventIds ?? []),
    ...(network.serviceCycleOperationEventIds ?? [])
      .slice(-MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT),
  ]);
}

export function recordMechanicalPowerFault(
  network: MechanicalPowerNetworkState,
  fault: MechanicalPowerFaultState,
  /** Authoritative worn-fault actions always supply this; omission is legacy-read compatibility only. */
  operatorId?: string,
): void {
  migrateMechanicalPowerNetworkState(network);
  const component = network.components.find((candidate) => candidate.role === fault.componentRole
    && samePosition(candidate.position, fault.componentPosition));
  const componentMaterialId = mechanicalDriveShaftSpecification(component?.materialId ?? Material.Air)?.materialId;
  const suppliedMaterialId = mechanicalDriveShaftSpecification(
    fault.failedComponentMaterialId ?? componentMaterialId ?? Material.Air,
  )?.materialId;
  if (!component
    || !componentMaterialId
    || !suppliedMaterialId
    || suppliedMaterialId !== componentMaterialId
    || (fault.failedComponentInstallationEventId
      && fault.failedComponentInstallationEventId !== component.installationEventId)
    || (fault.failedComponentRepairEventId
      && fault.failedComponentRepairEventId !== component.latestRepairEventId)) {
    throw new Error('机械故障必须在断裂前绑定真实轴材、安装与最近修复来源');
  }
  const currentServiceLoadedOperationCount = currentMechanicalPowerServiceLoadedOperationCount(
    network,
    componentMaterialId,
  );
  if (fault.serviceLoadedOperationCount !== undefined
    && (!Number.isSafeInteger(fault.serviceLoadedOperationCount)
      || fault.serviceLoadedOperationCount < 0
      || fault.serviceLoadedOperationCount !== currentServiceLoadedOperationCount)) {
    throw new Error('机械故障的周期成功负载计数与网络当前状态不一致');
  }
  const exactProofEventIds = mechanicalPowerFaultProofEventIds(
    network,
    component,
  );
  const suppliedProofEventIds = boundedEventIds(fault.proofEventIds ?? []);
  if (suppliedProofEventIds.length
    && (suppliedProofEventIds.length !== exactProofEventIds.length
      || suppliedProofEventIds.some((eventId, index) => eventId !== exactProofEventIds[index]))) {
    throw new Error('机械故障的有界证明 ID 与当前构件及服役周期不一致');
  }
  if (fault.kind === 'worn-drive-shaft' && operatorId !== undefined) {
    recordMechanicalPowerReliabilityCycleReceipt(
      network,
      fault,
      component,
      componentMaterialId,
      currentServiceLoadedOperationCount,
      operatorId,
    );
  }
  network.fault = {
    ...structuredClone(fault),
    failedComponentMaterialId: componentMaterialId,
    failedComponentInstallationEventId: fault.failedComponentInstallationEventId
      || component.installationEventId,
    ...(fault.failedComponentRepairEventId || component.latestRepairEventId ? {
      failedComponentRepairEventId: fault.failedComponentRepairEventId ?? component.latestRepairEventId,
    } : {}),
    serviceLoadedOperationCount: currentServiceLoadedOperationCount,
    proofEventIds: exactProofEventIds,
    sourceEventIds: boundedEventIds(fault.sourceEventIds),
  };
  network.condition = Math.min(network.condition, 40);
  if (!network.recentFaultEventIds.includes(fault.faultEventId)) network.faultCount += 1;
  network.recentFaultEventIds = boundedUniqueEventIds(
    [...network.recentFaultEventIds, fault.faultEventId],
    MECHANICAL_POWER_RECENT_EVENT_LIMIT,
  );
  network.sourceEventIds = boundedUniqueEventIds(
    [...network.sourceEventIds, fault.faultEventId, ...fault.sourceEventIds],
    MECHANICAL_POWER_SOURCE_EVENT_LIMIT,
  );
}

export interface MechanicalPowerRepairReplacement {
  componentPosition: MechanicalVoxelPosition;
  replacementMaterialId: MechanicalDriveShaftMaterialId;
  manufactureEventId: string;
  verificationEventId: string;
}

export function recordMechanicalPowerRepair(
  network: MechanicalPowerNetworkState,
  eventId: string,
  sourceEventIds: string[],
  replacement?: MechanicalPowerRepairReplacement,
): void {
  migrateMechanicalPowerNetworkState(network);
  if (network.recentRepairEventIds.includes(eventId)) return;
  if (replacement) {
    const component = network.components.find((candidate) => candidate.role === 'connector'
      && samePosition(candidate.position, replacement.componentPosition));
    if (!component || !isMechanicalDriveShaftMaterial(replacement.replacementMaterialId)) {
      throw new Error('机械修复缺少与故障位置一致的可用传动轴构件');
    }
    component.materialId = replacement.replacementMaterialId;
    component.latestRepairEventId = eventId;
    component.latestRepairSourceEventIds = boundedEventIds([
      replacement.manufactureEventId,
      replacement.verificationEventId,
      ...sourceEventIds,
    ]);
  }
  network.fault = null;
  network.condition = 100;
  network.serviceLoadedOperationCount = 0;
  network.serviceCycleOperationEventIds = [];
  network.repairCount += 1;
  network.recentRepairEventIds = boundedUniqueEventIds(
    [...network.recentRepairEventIds, eventId],
    MECHANICAL_POWER_RECENT_EVENT_LIMIT,
  );
  network.sourceEventIds = boundedUniqueEventIds(
    [...network.sourceEventIds, eventId, ...sourceEventIds],
    MECHANICAL_POWER_SOURCE_EVENT_LIMIT,
  );
}

export interface MechanicalPowerOperationRecord {
  shaftMaterialId: MechanicalDriveShaftMaterialId;
  wearApplied: number;
  serviceLoadedOperationOrdinal: number;
}

export function recordMechanicalPowerOperation(
  network: MechanicalPowerNetworkState,
  eventId: string,
  shaftMaterialId: MechanicalDriveShaftMaterialId = Material.DriveShaft,
): MechanicalPowerOperationRecord {
  migrateMechanicalPowerNetworkState(network);
  const specification = mechanicalDriveShaftSpecification(shaftMaterialId);
  if (!specification) throw new Error('机械负载作业缺少可用传动轴材料规格');
  const previousCount = currentMechanicalPowerServiceLoadedOperationCount(network, shaftMaterialId);
  if (network.recentOperationEventIds.includes(eventId)) {
    return {
      shaftMaterialId,
      wearApplied: 0,
      serviceLoadedOperationOrdinal: previousCount,
    };
  }
  network.operationCount += 1;
  network.recentOperationEventIds = boundedUniqueEventIds(
    [...network.recentOperationEventIds, eventId],
    MECHANICAL_POWER_RECENT_EVENT_LIMIT,
  );
  network.sourceEventIds = boundedUniqueEventIds(
    [...network.sourceEventIds, eventId],
    MECHANICAL_POWER_SOURCE_EVENT_LIMIT,
  );
  network.condition = Math.max(0, network.condition - specification.wearPerLoadedOperation);
  network.serviceLoadedOperationCount = previousCount + 1;
  network.serviceCycleOperationEventIds = boundedEventIds([
    ...(network.serviceCycleOperationEventIds ?? []),
    eventId,
  ]);
  return {
    shaftMaterialId,
    wearApplied: specification.wearPerLoadedOperation,
    serviceLoadedOperationOrdinal: network.serviceLoadedOperationCount,
  };
}

export function plannedMechanicalPowerComponents(plan: MechanicalPowerProjectPlan): Array<{
  role: MechanicalPowerComponentInstallation['role'];
  materialId: MaterialId;
  position: MechanicalVoxelPosition;
}> {
  return [
    { role: 'converter', materialId: Material.WaterWheel, position: plan.wheelPosition },
    ...plan.shaftPositions.map((position) => ({
      role: 'connector' as const,
      materialId: Material.DriveShaft,
      position,
    })),
    { role: 'load', materialId: Material.Mill, position: plan.loadPosition },
  ];
}

export function validateMechanicalPowerTopology(
  world: VoxelWorld,
  mechanicalPower: MechanicalPowerWorldState | undefined,
  plan: MechanicalPowerProjectPlan,
): MechanicalPowerTopologyValidation {
  const source = mechanicalPower?.version === MECHANICAL_POWER_WORLD_VERSION
    ? mechanicalPower.sources.find((candidate) => candidate.id === plan.sourceSegmentId)
    : undefined;
  if (!source || !waterCurrentAvailabilityFor(world, mechanicalPower, source.id).available) {
    return { valid: false, reason: 'source-unavailable' };
  }
  if (plan.shaftPositions.length === 0) return { valid: false, reason: 'missing-drive-shaft' };
  const sourceTouchesWheel = source.requiredWaterVoxels.some((position) => isUnitAxisStep(axisStep(position, plan.wheelPosition)));
  if (!sourceTouchesWheel) return { valid: false, reason: 'wheel-not-adjacent-to-source' };

  const chain = [plan.wheelPosition, ...plan.shaftPositions, plan.loadPosition];
  if (new Set(chain.map(positionKey)).size !== chain.length) {
    return { valid: false, reason: 'duplicate-component-position' };
  }
  const steps = chain.slice(1).map((position, index) => axisStep(chain[index], position));
  if (!steps.every(isUnitAxisStep)) return { valid: false, reason: 'disconnected-axis' };
  if (!steps.slice(1).every((step) => sameStep(step, steps[0]))) {
    return { valid: false, reason: 'bent-axis' };
  }

  if (voxelAt(world, plan.wheelPosition.x, plan.wheelPosition.y, plan.wheelPosition.z) !== Material.WaterWheel) {
    return { valid: false, reason: 'wheel-material-mismatch' };
  }
  if (plan.shaftPositions.some((position) => !isMechanicalDriveShaftMaterial(
    voxelAt(world, position.x, position.y, position.z),
  ))) {
    return { valid: false, reason: 'shaft-material-mismatch' };
  }
  if (voxelAt(world, plan.loadPosition.x, plan.loadPosition.y, plan.loadPosition.z) !== Material.Mill) {
    return { valid: false, reason: 'load-material-mismatch' };
  }
  return { valid: true };
}
