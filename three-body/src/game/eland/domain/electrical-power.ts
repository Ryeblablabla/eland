import { Material, type MaterialId } from './material';
import { voxelAt, type VoxelWorld } from '../world/grid';

export const ELECTRICAL_POWER_WORLD_VERSION = 'electrical-power-world-v1' as const;
export const ELECTRICAL_POWER_PLAN_VERSION = 'electrical-power-plan-v1' as const;
export const ELECTRICAL_POWER_ACTION_BASIS_VERSION = 'electrical-power-action-basis-v1' as const;
export const ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID =
  'technique:electrical-power:mechanical-dynamo-conductor-resistive-load' as const;
export const ELECTRICAL_POWER_LOAD_TECHNIQUE_PREFIX =
  'technique:electrical-power:resistive-load-response' as const;
export const ELECTRICAL_POWER_MAX_CONDUCTORS = 16;
export const ELECTRICAL_POWER_GENERATOR_CAPACITY = 2;
export const ELECTRICAL_POWER_CONDUCTOR_CAPACITY = 2;
export const ELECTRICAL_POWER_LOAD_DEMAND = 1;
export const ELECTRICAL_POWER_RECENT_EVENT_LIMIT = 8;
export const ELECTRICAL_POWER_SOURCE_EVENT_LIMIT = 24;

export interface ElectricalVoxelPosition {
  x: number;
  y: number;
  z: number;
}

export interface ElectricalPowerPlan {
  version: typeof ELECTRICAL_POWER_PLAN_VERSION;
  mechanicalInstallationProjectId: string;
  mechanicalNetworkId: string;
  mechanicalPlanKey: string;
  generatorPosition: ElectricalVoxelPosition;
  conductorPositions: ElectricalVoxelPosition[];
  loadPosition: ElectricalVoxelPosition;
}

/** A person-local attend action may diagnose only this current broken conductor. */
export interface ElectricalPowerFaultObservationRef {
  version: 'electrical-power-fault-observation-v1';
  installationProjectId: string;
  planKey: string;
  networkId: string;
  faultEventId: string;
}

export type ElectricalPowerComponentRole = 'source' | 'conductor' | 'load';

export interface ElectricalPowerComponentInstallation {
  role: ElectricalPowerComponentRole;
  materialId: MaterialId;
  position: ElectricalVoxelPosition;
  installedAtMonth: number;
  installationEventId: string;
  sourceEventIds: string[];
  latestRepairEventId?: string;
  latestRepairSourceEventIds?: string[];
}

export interface ElectricalPowerFaultState {
  kind: 'overload-open-circuit';
  componentRole: 'conductor';
  componentPosition: ElectricalVoxelPosition;
  atMonth: number;
  faultEventId: string;
  requestedPowerUnits: number;
  availablePowerUnits: number;
  failedComponentInstallationEventId: string;
  failedComponentRepairEventId?: string;
  sourceEventIds: string[];
}

export interface ElectricalPowerNetworkState {
  id: string;
  planKey: string;
  plan: ElectricalPowerPlan;
  components: ElectricalPowerComponentInstallation[];
  installationEventIds: string[];
  recentOperationEventIds: string[];
  recentFaultEventIds: string[];
  recentRepairEventIds: string[];
  sourceEventIds: string[];
  operationCount: number;
  faultCount: number;
  repairCount: number;
  fault: ElectricalPowerFaultState | null;
}

/** Only the current planning tick is retained; full dispatches remain replayable ActionFacts. */
export interface ElectricalPowerDispatchWindow {
  atMonth: number;
  planningTick: number;
  mechanicalNetworkId: string;
  usedPowerUnits: number;
  eventIds: string[];
}

export interface ElectricalPowerWorldState {
  version: typeof ELECTRICAL_POWER_WORLD_VERSION;
  networks: ElectricalPowerNetworkState[];
  dispatchWindows: ElectricalPowerDispatchWindow[];
}

/**
 * Stable, exact leases for living gameplay evidence. Retention owns which
 * events are pinned; domain/application readers may only resolve a cold fact
 * through the matching lease.
 */
export function livingPersonElectricalOperationKnowledgeLeaseKey(personId: string): string {
  return `electrical-knowledge:${encodeURIComponent(personId)}:operation`;
}

export function livingPersonElectricalLoadTechniqueKnowledgeLeaseKey(
  personId: string,
  techniqueId: string,
): string {
  return `electrical-knowledge:${encodeURIComponent(personId)}:load:${encodeURIComponent(techniqueId)}`;
}

export function livingPersonElectricalMechanicalServiceLeaseKey(personId: string): string {
  return `electrical-source-service:${encodeURIComponent(personId)}:mechanical`;
}

export function currentElectricalNetworkFaultLeaseKey(networkId: string): string {
  return `electrical-network:${encodeURIComponent(networkId)}:current-fault`;
}

export function currentElectricalNetworkRepairLeaseKey(networkId: string): string {
  return `electrical-network:${encodeURIComponent(networkId)}:current-repair`;
}

export function livingPersonElectricalFaultObservationLeaseKey(
  personId: string,
  networkId: string,
): string {
  return `electrical-fault-observation:${encodeURIComponent(personId)}:${encodeURIComponent(networkId)}`;
}

export function livingPersonElectricalComponentTechniqueLeaseKey(
  personId: string,
  techniqueId: string,
): string {
  return `electrical-component-technique:${encodeURIComponent(personId)}:${encodeURIComponent(techniqueId)}`;
}

export function activeElectricalMaintenanceProjectLeaseKey(projectId: string): string {
  return `electrical-maintenance-project:${encodeURIComponent(projectId)}:basis`;
}

export function activeElectricalMaintenanceReplacementLeaseKey(projectId: string): string {
  return `electrical-maintenance-project:${encodeURIComponent(projectId)}:replacement`;
}

export function electricalPowerFaultObservationFactId(networkId: string, faultEventId: string): string {
  return `observation:electrical-power-fault:${networkId}:${faultEventId}`;
}

export function electricalPowerLoadTechniquePrefix(inputMaterialId: MaterialId): string {
  return `${ELECTRICAL_POWER_LOAD_TECHNIQUE_PREFIX}:${inputMaterialId}:`;
}

export function electricalPowerLoadTechniqueId(
  inputMaterialId: MaterialId,
  outputMaterialId: MaterialId,
): string {
  return `${electricalPowerLoadTechniquePrefix(inputMaterialId)}${outputMaterialId}`;
}

export function parseElectricalPowerLoadTechniqueId(
  techniqueId: string,
): { inputMaterialId: MaterialId; outputMaterialId: MaterialId } | null {
  const match = /^technique:electrical-power:resistive-load-response:(\d+):(\d+)$/u.exec(techniqueId);
  if (!match) return null;
  const inputMaterialId = Number(match[1]);
  const outputMaterialId = Number(match[2]);
  return Number.isSafeInteger(inputMaterialId) && Number.isSafeInteger(outputMaterialId)
    ? { inputMaterialId, outputMaterialId }
    : null;
}

interface ElectricalPowerActionBasisBase {
  version: typeof ELECTRICAL_POWER_ACTION_BASIS_VERSION;
  planKey: string;
  networkId: string;
  mechanicalServiceEventId: string;
}

export type ElectricalPowerActionBasis =
  | ElectricalPowerActionBasisBase & {
    mode: 'install';
    plan: ElectricalPowerPlan;
    componentRole: ElectricalPowerComponentRole;
    componentMaterialId: MaterialId;
    componentPosition: ElectricalVoxelPosition;
    manufactureEventId: string;
    verificationEventId: string;
  }
  | ElectricalPowerActionBasisBase & {
    mode: 'operate';
    requestedPowerUnits: number;
  }
  | ElectricalPowerActionBasisBase & {
    mode: 'operate-service';
    requestedPowerUnits: number;
    operationKnowledgeId: typeof ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID;
    /** The planner may name only the tangible input; the domain decides any response. */
    inputMaterialId: MaterialId;
    /** Optional only after a repair; identifies the current conductor's exact restoration receipt. */
    recoveryRepairEventId?: string;
  }
  | ElectricalPowerActionBasisBase & {
    mode: 'repair';
    maintenanceProjectId?: string;
    faultEventId: string;
    replacementMaterialId: typeof Material.CopperConductor;
    toolMaterialId: typeof Material.IronTool;
    manufactureEventId: string;
    verificationEventId: string;
  };

export interface ElectricalPowerTopologyValidation {
  valid: boolean;
  reason?:
    | 'invalid-plan'
    | 'network-plan-mismatch'
    | 'missing-component'
    | 'duplicate-component'
    | 'source-material-mismatch'
    | 'conductor-material-mismatch'
    | 'load-material-mismatch'
    | 'open-circuit';
}

function isNonEmptyId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPosition(value: unknown): value is ElectricalVoxelPosition {
  if (!value || typeof value !== 'object') return false;
  const position = value as Partial<ElectricalVoxelPosition>;
  return Number.isSafeInteger(position.x)
    && Number.isSafeInteger(position.y)
    && Number.isSafeInteger(position.z);
}

export function sameElectricalPosition(
  left: ElectricalVoxelPosition,
  right: ElectricalVoxelPosition,
): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function positionKey(position: ElectricalVoxelPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

function unitAdjacent(left: ElectricalVoxelPosition, right: ElectricalVoxelPosition): boolean {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y) + Math.abs(left.z - right.z) === 1;
}

export function electricalPowerPlanIsStructurallyValid(plan: unknown): plan is ElectricalPowerPlan {
  if (!plan || typeof plan !== 'object') return false;
  const candidate = plan as Partial<ElectricalPowerPlan>;
  if (candidate.version !== ELECTRICAL_POWER_PLAN_VERSION
    || !isNonEmptyId(candidate.mechanicalInstallationProjectId)
    || !isNonEmptyId(candidate.mechanicalNetworkId)
    || !isNonEmptyId(candidate.mechanicalPlanKey)
    || !isPosition(candidate.generatorPosition)
    || !isPosition(candidate.loadPosition)
    || !Array.isArray(candidate.conductorPositions)
    || candidate.conductorPositions.length < 1
    || candidate.conductorPositions.length > ELECTRICAL_POWER_MAX_CONDUCTORS
    || candidate.conductorPositions.some((position) => !isPosition(position))) return false;
  const chain = [candidate.generatorPosition, ...candidate.conductorPositions, candidate.loadPosition];
  return new Set(chain.map(positionKey)).size === chain.length
    && chain.slice(1).every((position, index) => unitAdjacent(chain[index], position));
}

function canonicalPosition(position: ElectricalVoxelPosition): string {
  return `${position.x}:${position.y}:${position.z}`;
}

export function electricalPowerPlanKey(plan: ElectricalPowerPlan): string {
  return [
    ELECTRICAL_POWER_PLAN_VERSION,
    `mechanical-project=${plan.mechanicalInstallationProjectId}`,
    `mechanical-network=${plan.mechanicalNetworkId}`,
    `mechanical-plan=${plan.mechanicalPlanKey}`,
    `generator=${canonicalPosition(plan.generatorPosition)}`,
    `conductors=${plan.conductorPositions.map(canonicalPosition).join('>')}`,
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

export function electricalPowerNetworkId(plan: ElectricalPowerPlan): string {
  return `electrical-network:${plan.mechanicalNetworkId}:${stableKeyHash(electricalPowerPlanKey(plan))}`;
}

export function plannedElectricalPowerComponents(plan: ElectricalPowerPlan): Array<{
  role: ElectricalPowerComponentRole;
  materialId: MaterialId;
  position: ElectricalVoxelPosition;
}> {
  return [
    { role: 'source', materialId: Material.MechanicalDynamo, position: plan.generatorPosition },
    ...plan.conductorPositions.map((position) => ({
      role: 'conductor' as const,
      materialId: Material.CopperConductor,
      position,
    })),
    { role: 'load', materialId: Material.ResistiveLoad, position: plan.loadPosition },
  ];
}

export function emptyElectricalPowerWorldState(): ElectricalPowerWorldState {
  return {
    version: ELECTRICAL_POWER_WORLD_VERSION,
    networks: [],
    dispatchWindows: [],
  };
}

export function createElectricalPowerNetwork(plan: ElectricalPowerPlan): ElectricalPowerNetworkState {
  if (!electricalPowerPlanIsStructurallyValid(plan)) throw new Error('电力网络计划结构无效');
  return {
    id: electricalPowerNetworkId(plan),
    planKey: electricalPowerPlanKey(plan),
    plan: structuredClone(plan),
    components: [],
    installationEventIds: [],
    recentOperationEventIds: [],
    recentFaultEventIds: [],
    recentRepairEventIds: [],
    sourceEventIds: [],
    operationCount: 0,
    faultCount: 0,
    repairCount: 0,
    fault: null,
  };
}

export function ensureElectricalPowerNetwork(
  world: ElectricalPowerWorldState,
  plan: ElectricalPowerPlan,
): ElectricalPowerNetworkState {
  if (world.version !== ELECTRICAL_POWER_WORLD_VERSION) throw new Error('电力世界版本无效');
  const id = electricalPowerNetworkId(plan);
  const planKey = electricalPowerPlanKey(plan);
  const existing = world.networks.find((network) => network.id === id);
  if (existing) {
    if (existing.planKey !== planKey || electricalPowerPlanKey(existing.plan) !== planKey) {
      throw new Error(`电力网络身份冲突：${id}`);
    }
    return existing;
  }
  const network = createElectricalPowerNetwork(plan);
  world.networks.push(network);
  return network;
}

function boundedUnique(values: readonly string[], limit: number): string[] {
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

export function recordElectricalPowerInstallation(
  network: ElectricalPowerNetworkState,
  installation: ElectricalPowerComponentInstallation,
): void {
  const planned = plannedElectricalPowerComponents(network.plan).find((candidate) => (
    candidate.role === installation.role
      && candidate.materialId === installation.materialId
      && sameElectricalPosition(candidate.position, installation.position)
  ));
  if (!planned || network.components.some((component) => (
    component.role === installation.role
      && sameElectricalPosition(component.position, installation.position)
  ))) throw new Error('电力构件安装与冻结网络计划不一致');
  network.components.push({
    ...structuredClone(installation),
    sourceEventIds: boundedUnique(installation.sourceEventIds, ELECTRICAL_POWER_SOURCE_EVENT_LIMIT),
  });
  network.installationEventIds = boundedUnique(
    [...network.installationEventIds, installation.installationEventId],
    ELECTRICAL_POWER_MAX_CONDUCTORS + 2,
  );
  network.sourceEventIds = boundedUnique(
    [...network.sourceEventIds, installation.installationEventId, ...installation.sourceEventIds],
    ELECTRICAL_POWER_SOURCE_EVENT_LIMIT,
  );
}

export function validateElectricalPowerTopology(
  world: VoxelWorld,
  network: ElectricalPowerNetworkState,
  allowCurrentFault = false,
): ElectricalPowerTopologyValidation {
  if (!electricalPowerPlanIsStructurallyValid(network.plan)) return { valid: false, reason: 'invalid-plan' };
  if (network.planKey !== electricalPowerPlanKey(network.plan)
    || network.id !== electricalPowerNetworkId(network.plan)) {
    return { valid: false, reason: 'network-plan-mismatch' };
  }
  const planned = plannedElectricalPowerComponents(network.plan);
  if (network.components.length !== planned.length) return { valid: false, reason: 'duplicate-component' };
  const malformedLedgerComponent = network.components.find((component) => {
    const expected = planned.find((candidate) => candidate.role === component.role
      && sameElectricalPosition(candidate.position, component.position));
    return !expected || expected.materialId !== component.materialId;
  });
  if (malformedLedgerComponent) return {
    valid: false,
    reason: malformedLedgerComponent.role === 'source'
      ? 'source-material-mismatch'
      : malformedLedgerComponent.role === 'load'
        ? 'load-material-mismatch'
        : 'conductor-material-mismatch',
  };
  const installed = planned.map((candidate) => network.components.filter((component) => (
    component.role === candidate.role
      && component.materialId === candidate.materialId
      && sameElectricalPosition(component.position, candidate.position)
  )));
  if (installed.some((matches) => matches.length === 0)) return { valid: false, reason: 'missing-component' };
  if (installed.some((matches) => matches.length !== 1)) return { valid: false, reason: 'duplicate-component' };
  if (voxelAt(world, network.plan.generatorPosition.x, network.plan.generatorPosition.y, network.plan.generatorPosition.z)
    !== Material.MechanicalDynamo) return { valid: false, reason: 'source-material-mismatch' };
  if (voxelAt(world, network.plan.loadPosition.x, network.plan.loadPosition.y, network.plan.loadPosition.z)
    !== Material.ResistiveLoad) return { valid: false, reason: 'load-material-mismatch' };
  for (const position of network.plan.conductorPositions) {
    const actual = voxelAt(world, position.x, position.y, position.z);
    if (actual === Material.BrokenCopperConductor) {
      if (allowCurrentFault && network.fault
        && sameElectricalPosition(network.fault.componentPosition, position)) continue;
      return { valid: false, reason: 'open-circuit' };
    }
    if (actual !== Material.CopperConductor) return { valid: false, reason: 'conductor-material-mismatch' };
  }
  return { valid: true };
}

export function recordElectricalPowerFault(
  network: ElectricalPowerNetworkState,
  fault: ElectricalPowerFaultState,
): void {
  if (network.fault) throw new Error('电力网络已有未修复故障');
  const component = network.components.find((candidate) => candidate.role === 'conductor'
    && sameElectricalPosition(candidate.position, fault.componentPosition));
  if (!component
    || component.materialId !== Material.CopperConductor
    || component.installationEventId !== fault.failedComponentInstallationEventId
    || component.latestRepairEventId !== fault.failedComponentRepairEventId
    || !Number.isFinite(fault.requestedPowerUnits)
    || fault.requestedPowerUnits <= 0
    || !Number.isFinite(fault.availablePowerUnits)
    || fault.availablePowerUnits < 0
    || fault.requestedPowerUnits <= fault.availablePowerUnits) {
    throw new Error('电力过载故障没有绑定真实导体或真实容量缺口');
  }
  network.fault = {
    ...structuredClone(fault),
    sourceEventIds: boundedUnique(fault.sourceEventIds, ELECTRICAL_POWER_SOURCE_EVENT_LIMIT),
  };
  network.faultCount += 1;
  network.recentFaultEventIds = boundedUnique(
    [...network.recentFaultEventIds, fault.faultEventId],
    ELECTRICAL_POWER_RECENT_EVENT_LIMIT,
  );
  network.sourceEventIds = boundedUnique(
    [...network.sourceEventIds, fault.faultEventId, ...fault.sourceEventIds],
    ELECTRICAL_POWER_SOURCE_EVENT_LIMIT,
  );
}

export function recordElectricalPowerRepair(
  network: ElectricalPowerNetworkState,
  eventId: string,
  sourceEventIds: string[],
): void {
  const fault = network.fault;
  if (!fault) throw new Error('电力网络没有可修复的当前故障');
  const component = network.components.find((candidate) => candidate.role === 'conductor'
    && sameElectricalPosition(candidate.position, fault.componentPosition));
  if (!component || component.materialId !== Material.CopperConductor) {
    throw new Error('电力修复缺少与故障位置一致的导体构件');
  }
  component.latestRepairEventId = eventId;
  component.latestRepairSourceEventIds = boundedUnique(sourceEventIds, ELECTRICAL_POWER_SOURCE_EVENT_LIMIT);
  network.fault = null;
  network.repairCount += 1;
  network.recentRepairEventIds = boundedUnique(
    [...network.recentRepairEventIds, eventId],
    ELECTRICAL_POWER_RECENT_EVENT_LIMIT,
  );
  network.sourceEventIds = boundedUnique(
    [...network.sourceEventIds, eventId, ...sourceEventIds],
    ELECTRICAL_POWER_SOURCE_EVENT_LIMIT,
  );
}

export function recordElectricalPowerOperation(
  network: ElectricalPowerNetworkState,
  eventId: string,
): void {
  if (network.recentOperationEventIds.includes(eventId)) return;
  network.operationCount += 1;
  network.recentOperationEventIds = boundedUnique(
    [...network.recentOperationEventIds, eventId],
    ELECTRICAL_POWER_RECENT_EVENT_LIMIT,
  );
  network.sourceEventIds = boundedUnique(
    [...network.sourceEventIds, eventId],
    ELECTRICAL_POWER_SOURCE_EVENT_LIMIT,
  );
}

function currentDispatchWindows(
  world: ElectricalPowerWorldState,
  atMonth: number,
  planningTick: number,
): ElectricalPowerDispatchWindow[] {
  return world.dispatchWindows.filter((window) => window.atMonth === atMonth
    && window.planningTick === planningTick);
}

export function usedElectricalPowerForMechanicalSource(
  world: ElectricalPowerWorldState,
  mechanicalNetworkId: string,
  atMonth: number,
  planningTick: number,
): number {
  return currentDispatchWindows(world, atMonth, planningTick)
    .find((window) => window.mechanicalNetworkId === mechanicalNetworkId)?.usedPowerUnits ?? 0;
}

export function recordElectricalPowerDispatch(
  world: ElectricalPowerWorldState,
  mechanicalNetworkId: string,
  atMonth: number,
  planningTick: number,
  powerUnits: number,
  eventId: string,
): void {
  if (world.version !== ELECTRICAL_POWER_WORLD_VERSION
    || !Number.isSafeInteger(atMonth)
    || atMonth < 0
    || !Number.isSafeInteger(planningTick)
    || planningTick < 1
    || planningTick > 15
    || !Number.isFinite(powerUnits)
    || powerUnits <= 0
    || !isNonEmptyId(mechanicalNetworkId)
    || !isNonEmptyId(eventId)) throw new Error('电力调度窗口参数无效');
  world.dispatchWindows = currentDispatchWindows(world, atMonth, planningTick);
  const existing = world.dispatchWindows.find((window) => window.mechanicalNetworkId === mechanicalNetworkId);
  if (existing) {
    if (existing.eventIds.includes(eventId)) return;
    existing.usedPowerUnits += powerUnits;
    existing.eventIds = boundedUnique([...existing.eventIds, eventId], ELECTRICAL_POWER_RECENT_EVENT_LIMIT);
    return;
  }
  world.dispatchWindows.push({
    atMonth,
    planningTick,
    mechanicalNetworkId,
    usedPowerUnits: powerUnits,
    eventIds: [eventId],
  });
}

export function isElectricalPowerActionBasis(value: unknown): value is ElectricalPowerActionBasis {
  if (!value || typeof value !== 'object') return false;
  const basis = value as Record<string, unknown>;
  if (basis.version !== ELECTRICAL_POWER_ACTION_BASIS_VERSION
    || !isNonEmptyId(basis.planKey)
    || !isNonEmptyId(basis.networkId)
    || !isNonEmptyId(basis.mechanicalServiceEventId)) return false;
  if (basis.mode === 'install') return electricalPowerPlanIsStructurallyValid(basis.plan)
    && (basis.componentRole === 'source' || basis.componentRole === 'conductor' || basis.componentRole === 'load')
    && Number.isSafeInteger(basis.componentMaterialId)
    && isPosition(basis.componentPosition)
    && isNonEmptyId(basis.manufactureEventId)
    && isNonEmptyId(basis.verificationEventId);
  if (basis.mode === 'operate' || basis.mode === 'operate-service') {
    return Number.isFinite(basis.requestedPowerUnits)
      && Number(basis.requestedPowerUnits) > 0
      && (basis.mode === 'operate' || (
        basis.operationKnowledgeId === ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID
          && Number.isSafeInteger(basis.inputMaterialId)
          && (basis.recoveryRepairEventId === undefined || isNonEmptyId(basis.recoveryRepairEventId))
      ));
  }
  return basis.mode === 'repair'
    && (basis.maintenanceProjectId === undefined || isNonEmptyId(basis.maintenanceProjectId))
    && isNonEmptyId(basis.faultEventId)
    && basis.replacementMaterialId === Material.CopperConductor
    && basis.toolMaterialId === Material.IronTool
    && isNonEmptyId(basis.manufactureEventId)
    && isNonEmptyId(basis.verificationEventId);
}
