import { Material, type MaterialId } from './material';
import {
  voxelAt,
  type VoxelWorld,
} from '../world/grid';

export const MECHANICAL_POWER_WORLD_VERSION = 'mechanical-power-world-v1' as const;
export const MECHANICAL_POWER_PLAN_VERSION = 'mechanical-power-plan-v1' as const;
export const MECHANICAL_POWER_ACTION_BASIS_VERSION = 'mechanical-power-action-basis-v1' as const;

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
}

export interface MechanicalPowerFaultState {
  kind: 'commissioning-misalignment' | 'worn-drive-shaft';
  componentRole: MechanicalPowerComponentInstallation['role'];
  componentPosition: MechanicalVoxelPosition;
  atMonth: number;
  faultEventId: string;
  sourceEventIds: string[];
}

export interface MechanicalPowerNetworkState {
  id: string;
  planKey: string;
  installationProjectId: string;
  sourceSegmentId: string;
  components: MechanicalPowerComponentInstallation[];
  installationEventIds: string[];
  operationEventIds: string[];
  faultEventIds: string[];
  repairEventIds: string[];
  /** Aggregated causal event provenance from installs, operations, faults and repairs. */
  sourceEventIds: string[];
  /** Physical condition in [0, 100], maintained by authoritative domain actions. */
  condition: number;
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
    mode: 'operate';
    projectId: string;
    planKey: string;
    networkId: string;
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
  };

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

export function createMechanicalPowerNetwork(plan: MechanicalPowerProjectPlan): MechanicalPowerNetworkState {
  return {
    id: mechanicalPowerNetworkId(plan),
    planKey: mechanicalPowerPlanKey(plan),
    installationProjectId: plan.projectId,
    sourceSegmentId: plan.sourceSegmentId,
    components: [],
    installationEventIds: [],
    operationEventIds: [],
    faultEventIds: [],
    repairEventIds: [],
    sourceEventIds: [],
    condition: 100,
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
  const existing = network.components.find((component) => component.role === installation.role
    && samePosition(component.position, installation.position));
  if (existing) {
    appendUnique(existing.sourceEventIds, [installation.installationEventId, ...installation.sourceEventIds]);
  } else {
    network.components.push(structuredClone(installation));
  }
  appendUnique(network.installationEventIds, [installation.installationEventId]);
  appendUnique(network.sourceEventIds, [installation.installationEventId, ...installation.sourceEventIds]);
}

export function recordMechanicalPowerFault(
  network: MechanicalPowerNetworkState,
  fault: MechanicalPowerFaultState,
): void {
  network.fault = structuredClone(fault);
  network.condition = Math.min(network.condition, 40);
  appendUnique(network.faultEventIds, [fault.faultEventId]);
  appendUnique(network.sourceEventIds, [fault.faultEventId, ...fault.sourceEventIds]);
}

export function recordMechanicalPowerRepair(
  network: MechanicalPowerNetworkState,
  eventId: string,
  sourceEventIds: string[],
): void {
  network.fault = null;
  network.condition = 100;
  appendUnique(network.repairEventIds, [eventId]);
  appendUnique(network.sourceEventIds, [eventId, ...sourceEventIds]);
}

export function recordMechanicalPowerOperation(
  network: MechanicalPowerNetworkState,
  eventId: string,
): void {
  appendUnique(network.operationEventIds, [eventId]);
  appendUnique(network.sourceEventIds, [eventId]);
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
  if (plan.shaftPositions.some((position) => voxelAt(world, position.x, position.y, position.z) !== Material.DriveShaft)) {
    return { valid: false, reason: 'shaft-material-mismatch' };
  }
  if (voxelAt(world, plan.loadPosition.x, plan.loadPosition.y, plan.loadPosition.z) !== Material.Mill) {
    return { valid: false, reason: 'load-material-mismatch' };
  }
  return { valid: true };
}
