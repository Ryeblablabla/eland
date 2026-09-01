import type { PrimitiveAction, WorldRef } from '../action';
import {
  ELECTRICAL_POWER_ACTION_BASIS_VERSION,
  ELECTRICAL_POWER_CONDUCTOR_CAPACITY,
  ELECTRICAL_POWER_GENERATOR_CAPACITY,
  ELECTRICAL_POWER_LOAD_DEMAND,
  ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID,
  ELECTRICAL_POWER_WORLD_VERSION,
  electricalPowerFaultObservationFactId,
  electricalPowerLoadTechniqueId,
  electricalPowerLoadTechniquePrefix,
  electricalPowerNetworkId,
  electricalPowerPlanIsStructurallyValid,
  electricalPowerPlanKey,
  emptyElectricalPowerWorldState,
  ensureElectricalPowerNetwork,
  isElectricalPowerActionBasis,
  plannedElectricalPowerComponents,
  recordElectricalPowerDispatch,
  recordElectricalPowerFault,
  recordElectricalPowerInstallation,
  recordElectricalPowerOperation,
  recordElectricalPowerRepair,
  sameElectricalPosition,
  usedElectricalPowerForMechanicalSource,
  validateElectricalPowerTopology,
  type ElectricalPowerActionBasis,
  type ElectricalPowerNetworkState,
  type ElectricalPowerPlan,
  type ElectricalPowerWorldState,
  type ElectricalVoxelPosition,
} from '../electrical-power';
import { worldEventById } from '../event-index';
import { exposureRuleFor } from '../interaction-rules';
import { Material, materialDefinition, type MaterialId } from '../material';
import {
  MECHANICAL_POWER_ACTION_BASIS_VERSION,
  MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT,
  MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
  MECHANICAL_POWER_WORN_FAULT_THRESHOLD,
  currentMechanicalPowerServiceLoadedOperationCount,
  isMechanicalDriveShaftMaterial,
  mechanicalDriveShaftSpecification,
  mechanicalPowerFaultProofEventIds,
  mechanicalPowerPlanKey,
  plannedMechanicalPowerComponents,
  recordMechanicalPowerFault,
  recordMechanicalPowerOperation,
  validateMechanicalPowerTopology,
  waterCurrentAvailabilityFor,
  type MechanicalDriveShaftMaterialId,
  type MechanicalPowerActionBasis,
  type MechanicalPowerComponentInstallation,
  type MechanicalPowerNetworkState,
  type MechanicalPowerProjectPlan,
} from '../mechanical-power';
import type { ActionFact, SimulationState } from '../model';
import type { ItemStack, KnownFact, PersonState } from '../person';
import { setVoxel, voxelAt } from '../../world/grid';
import { addInventory, removeEmptyStacks } from './inventory';
import { bodyOccupies, clamp, distanceToPosition } from './execution-helpers';

type ActAction = Extract<PrimitiveAction, { kind: 'act' }>;
type ElectricalOperationBasis = Extract<
  ElectricalPowerActionBasis,
  { mode: 'operate' | 'operate-service' }
>;

interface MechanicalElectricalSourceContext {
  installationProjectId: string;
  plan: MechanicalPowerProjectPlan;
  network: MechanicalPowerNetworkState;
  serviceEvent: ActionFact;
  availableCapacity: number;
  supportingSegmentIds: string[];
  shaft: {
    component: MechanicalPowerComponentInstallation;
    materialId: MechanicalDriveShaftMaterialId;
  };
}

type SourceContextResult = MechanicalElectricalSourceContext | { blocked: string };

function actionAfter(candidate: ActionFact, basis: ActionFact): boolean {
  if (candidate.atMonth !== basis.atMonth) return candidate.atMonth > basis.atMonth;
  if ((candidate.planningTick ?? 0) !== (basis.planningTick ?? 0)) {
    return (candidate.planningTick ?? 0) > (basis.planningTick ?? 0);
  }
  if ((candidate.orderInTick ?? candidate.orderInMonth) !== (basis.orderInTick ?? basis.orderInMonth)) {
    return (candidate.orderInTick ?? candidate.orderInMonth) > (basis.orderInTick ?? basis.orderInMonth);
  }
  return candidate.orderInMonth > basis.orderInMonth;
}

function unitAdjacent(left: ElectricalVoxelPosition, right: ElectricalVoxelPosition): boolean {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y) + Math.abs(left.z - right.z) === 1;
}

function positionInsideWorld(state: SimulationState, position: ElectricalVoxelPosition): boolean {
  return position.x >= 0 && position.x < state.world.grid.width
    && position.y >= 0 && position.y < state.world.grid.depth
    && position.z >= 0 && position.z < state.world.grid.levels;
}

function exactMechanicalComponentsInstalled(
  state: SimulationState,
  network: MechanicalPowerNetworkState,
  plan: MechanicalPowerProjectPlan,
): boolean {
  return plannedMechanicalPowerComponents(plan).every((planned) => network.components.some((component) => (
    component.role === planned.role
      && component.projectId === plan.projectId
      && sameElectricalPosition(component.position, planned.position)
      && (planned.role === 'connector'
        ? isMechanicalDriveShaftMaterial(component.materialId)
          && voxelAt(state.world.grid, planned.position.x, planned.position.y, planned.position.z) === component.materialId
        : component.materialId === planned.materialId)
  )));
}

function weakestInstalledShaft(
  state: SimulationState,
  network: MechanicalPowerNetworkState,
  plan: MechanicalPowerProjectPlan,
): MechanicalElectricalSourceContext['shaft'] | null {
  let selected: MechanicalElectricalSourceContext['shaft'] | null = null;
  for (const position of plan.shaftPositions) {
    const component = network.components.find((candidate) => candidate.role === 'connector'
      && candidate.projectId === plan.projectId
      && sameElectricalPosition(candidate.position, position));
    if (!component
      || !isMechanicalDriveShaftMaterial(component.materialId)
      || voxelAt(state.world.grid, position.x, position.y, position.z) !== component.materialId) return null;
    if (!selected || mechanicalDriveShaftSpecification(component.materialId)!.wearPerLoadedOperation
      > mechanicalDriveShaftSpecification(selected.materialId)!.wearPerLoadedOperation) {
      selected = { component, materialId: component.materialId };
    }
  }
  return selected;
}

function personKnowsMechanicalService(
  person: PersonState,
  serviceEventId: string,
): boolean {
  return person.knowledge.some((fact) => fact.id === MECHANICAL_POWER_OPERATION_TECHNIQUE_ID
    && fact.kind === 'technique'
    && fact.confidence >= 55
    && fact.sourceEventIds.includes(serviceEventId));
}

function sameSourceKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((sourceKey, index) => sourceKey === right[index]);
}

function completedPersonalMechanicalServiceMatches(
  person: PersonState,
  plan: MechanicalPowerProjectPlan,
  network: MechanicalPowerNetworkState,
  serviceEvent: ActionFact,
): boolean {
  if (serviceEvent.status !== 'completed'
    || serviceEvent.who !== person.id
    || serviceEvent.action.kind !== 'act'
    || serviceEvent.action.operation !== 'exert'
    || serviceEvent.diff.mechanicalPowerOperation !== true
    || serviceEvent.diff.installationProjectId !== network.installationProjectId
    || serviceEvent.diff.networkId !== network.id
    || serviceEvent.diff.planKey !== network.planKey
    || serviceEvent.diff.sourceSegmentId !== network.sourceSegmentId
    || Number(serviceEvent.diff.inputMaterialId) !== Material.Seed
    || Number(serviceEvent.diff.outputMaterialId) !== Material.Food
    || typeof serviceEvent.diff.inputStackId !== 'string'
    || typeof serviceEvent.diff.outputStackId !== 'string'
    || !Number.isFinite(Number(serviceEvent.diff.outputQuantity))
    || Number(serviceEvent.diff.outputQuantity) <= 0
    || Number(serviceEvent.diff.wearApplied) <= 0
    || !Number.isSafeInteger(Number(serviceEvent.diff.serviceLoadedOperationOrdinal))
    || Number(serviceEvent.diff.serviceLoadedOperationOrdinal) < 1
    || serviceEvent.diff.operationKnowledgeId !== MECHANICAL_POWER_OPERATION_TECHNIQUE_ID) return false;
  const inputRef = serviceEvent.action.targets.find((target): target is Extract<WorldRef, { kind: 'inventory-stack' }> => (
    target.kind === 'inventory-stack'
  ));
  const loadRef = serviceEvent.action.targets.find((target): target is Extract<WorldRef, { kind: 'voxel' }> => (
    target.kind === 'voxel'
  ));
  if (serviceEvent.action.targets.length !== 2
    || !inputRef
    || inputRef.personId !== person.id
    || inputRef.stackId !== serviceEvent.diff.inputStackId
    || !loadRef
    || !sameElectricalPosition(loadRef.position, plan.loadPosition)) return false;
  const serviceBasis = serviceEvent.action.mechanicalPowerBasis as MechanicalPowerActionBasis | undefined;
  if (!serviceBasis
    || serviceBasis.version !== MECHANICAL_POWER_ACTION_BASIS_VERSION
    || (serviceBasis.mode !== 'operate' && serviceBasis.mode !== 'operate-service')
    || serviceBasis.planKey !== network.planKey
    || serviceBasis.networkId !== network.id
    || serviceBasis.sourceSegmentId !== network.sourceSegmentId
    || !sameSourceKeys(serviceBasis.sourceKeys, plan.sourceKeys)
    || serviceBasis.inputMaterialId !== Material.Seed
    || serviceBasis.outputMaterialId !== Material.Food
    || serviceEvent.diff.mode !== serviceBasis.mode) return false;
  return serviceBasis.mode === 'operate'
    ? serviceBasis.projectId === network.installationProjectId
    : serviceBasis.installationProjectId === network.installationProjectId
      && serviceBasis.operationKnowledgeId === MECHANICAL_POWER_OPERATION_TECHNIQUE_ID;
}

export function resolveMechanicalElectricalSourceContext(
  state: SimulationState,
  person: PersonState,
  plan: ElectricalPowerPlan,
  mechanicalServiceEventId: string,
  requireAvailable: boolean,
): SourceContextResult {
  if (!electricalPowerPlanIsStructurallyValid(plan)
    || [plan.generatorPosition, ...plan.conductorPositions, plan.loadPosition]
      .some((position) => !positionInsideWorld(state, position))) {
    return { blocked: '电力计划的实体位置或相邻链无效' };
  }
  const project = state.projects.find((candidate) => candidate.id === plan.mechanicalInstallationProjectId);
  const mechanicalPlan = project?.mechanicalPowerPlan;
  const network = state.world.mechanicalPower?.networks.find((candidate) => (
    candidate.id === plan.mechanicalNetworkId
      && candidate.installationProjectId === plan.mechanicalInstallationProjectId
      && candidate.planKey === plan.mechanicalPlanKey
  ));
  const serviceEvent = worldEventById(state, mechanicalServiceEventId);
  if (!project || project.status !== 'completed'
    || project.desiredFunction !== 'water-powered-crop-processing') {
    return { blocked: '发电机所指机械安装项目不是当前已完成的水力处理项目' };
  }
  if (!mechanicalPlan
    || mechanicalPlan.projectId !== project.id
    || mechanicalPowerPlanKey(mechanicalPlan) !== plan.mechanicalPlanKey
    || project.mechanicalPowerPlanKey !== plan.mechanicalPlanKey
    || project.mechanicalPowerNetworkId !== plan.mechanicalNetworkId) {
    return { blocked: '发电机所指机械冻结计划身份不一致' };
  }
  if (!network) return { blocked: '发电机所指机械网络当前不存在或身份不一致' };
  if (serviceEvent?.kind !== 'action') {
    return { blocked: '本人所指机械服务事实当前不可解析' };
  }
  if (!completedPersonalMechanicalServiceMatches(person, mechanicalPlan, network, serviceEvent)) {
    return { blocked: '本人所指机械服务不是该网络的真实已完成负载操作' };
  }
  if (!personKnowsMechanicalService(person, serviceEvent.id)) {
    return { blocked: '本人知识没有绑定这次真实机械服务' };
  }
  if (!mechanicalPlan.shaftPositions.some((position) => unitAdjacent(position, plan.generatorPosition))) {
    return { blocked: '发电机没有实体相邻于已投产机械传动轴' };
  }
  if (!exactMechanicalComponentsInstalled(state, network, mechanicalPlan)) {
    return { blocked: '机械来源的安装账本与当前实体构件不一致' };
  }
  const shaft = weakestInstalledShaft(state, network, mechanicalPlan);
  if (!shaft) return { blocked: '机械来源缺少当前实体传动轴' };
  const sourceAvailability = waterCurrentAvailabilityFor(
    state.world.grid,
    state.world.mechanicalPower,
    network.sourceSegmentId,
  );
  if (requireAvailable && (network.fault
    || !validateMechanicalPowerTopology(state.world.grid, state.world.mechanicalPower, mechanicalPlan).valid
    || !sourceAvailability.available)) {
    return { blocked: '机械旋转来源当前断流、故障或拓扑失效' };
  }
  return {
    installationProjectId: project.id,
    plan: mechanicalPlan,
    network,
    serviceEvent,
    availableCapacity: sourceAvailability.available ? sourceAvailability.availableCapacity : 0,
    supportingSegmentIds: [...sourceAvailability.supportingSegmentIds],
    shaft,
  };
}

function electricalNetworkForBasis(
  state: SimulationState,
  basis: ElectricalPowerActionBasis,
): ElectricalPowerNetworkState | undefined {
  const world = state.world.electricalPower;
  if (!world || world.version !== ELECTRICAL_POWER_WORLD_VERSION) return undefined;
  return world.networks.find((candidate) => candidate.id === basis.networkId
    && candidate.planKey === basis.planKey
    && electricalPowerPlanKey(candidate.plan) === basis.planKey);
}

export function executeElectricalPowerFaultAttend(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'attend' }>,
  atMonth: number,
  eventId: string,
) {
  const ref = action.electricalPowerFaultObservation;
  if (!ref) return null;
  const installationProject = state.projects.find((candidate) => candidate.id === ref.installationProjectId);
  const plan = installationProject?.electricalPowerPlan;
  const network = state.world.electricalPower?.version === ELECTRICAL_POWER_WORLD_VERSION
    ? state.world.electricalPower.networks.find((candidate) => candidate.id === ref.networkId
      && candidate.planKey === ref.planKey
      && electricalPowerPlanKey(candidate.plan) === ref.planKey)
    : undefined;
  const fault = network?.fault;
  const position = action.target.kind === 'voxel' ? action.target.position : undefined;
  const faultEvent = fault && network
    ? worldEventById(state, fault.faultEventId)
    : undefined;
  const perceptionRadius = 4 + Math.floor(person.baselineCapacities.perception / 25);
  if (ref.version !== 'electrical-power-fault-observation-v1'
    || installationProject?.status !== 'completed'
    || installationProject.desiredFunction !== 'remote-work-power-delivery'
    || !plan
    || installationProject.electricalPowerPlanKey !== ref.planKey
    || installationProject.electricalPowerNetworkId !== ref.networkId
    || electricalPowerPlanKey(plan) !== ref.planKey
    || !network
    || !fault
    || fault.kind !== 'overload-open-circuit'
    || fault.componentRole !== 'conductor'
    || fault.faultEventId !== ref.faultEventId
    || faultEvent?.kind !== 'action'
    || faultEvent.status !== 'completed'
    || faultEvent.diff.electricalPowerFault !== true
    || faultEvent.diff.electricalNetworkId !== network.id
    || faultEvent.diff.electricalPlanKey !== network.planKey
    || !position
    || !sameElectricalPosition(position, fault.componentPosition)
    || distanceToPosition(person, position) > perceptionRadius
    || voxelAt(state.world.grid, position.x, position.y, position.z) !== Material.BrokenCopperConductor
    || !validateElectricalPowerTopology(state.world.grid, network, true).valid) {
    return {
      status: 'blocked' as const,
      result: '眼前熔断导体与所指完成电网的当前断路故障不一致',
      diff: {},
    };
  }
  const factId = electricalPowerFaultObservationFactId(network.id, fault.faultEventId);
  const summary = '观察并诊断出电力网络的实体铜导体已经熔断，远端负载因此断路';
  const existing = person.knowledge.find((fact) => fact.id === factId && fact.kind === 'observation');
  if (existing) {
    existing.confidence = clamp(Math.max(existing.confidence, 60) + 10);
    existing.sourceEventIds = [...new Set([
      ...existing.sourceEventIds,
      fault.faultEventId,
      eventId,
    ])].slice(-8);
  } else person.knowledge.push({
    id: factId,
    kind: 'observation',
    summary,
    confidence: 68,
    learnedAtMonth: atMonth,
    sourceEventIds: [fault.faultEventId, eventId],
  });
  return {
    status: 'completed' as const,
    result: summary,
    diff: {
      factId,
      electricalPowerFaultDiagnosis: true,
      installationProjectId: installationProject.id,
      electricalNetworkId: network.id,
      electricalPlanKey: network.planKey,
      faultEventId: fault.faultEventId,
      faultKind: fault.kind,
      componentPosition: { ...fault.componentPosition },
    },
  };
}

function verifiedComponentEvidence(
  state: SimulationState,
  person: PersonState,
  stackId: string,
  materialId: number,
  manufactureEventId: string,
  verificationEventId: string,
  after?: ActionFact,
): { stack: ItemStack; manufacture: ActionFact; verification: ActionFact } | null {
  const stack = person.inventory.find((candidate) => candidate.id === stackId
    && candidate.materialId === materialId
    && candidate.quantity > 0
    && !candidate.recordPayloadId);
  const manufacture = worldEventById(state, manufactureEventId);
  const verification = worldEventById(state, verificationEventId);
  if (!stack
    || manufacture?.kind !== 'action'
    || manufacture.status !== 'completed'
    || manufacture.who !== person.id
    || manufacture.action.kind !== 'act'
    || manufacture.action.operation !== 'combine'
    || Number(manufacture.diff.outputMaterialId) !== materialId
    || manufacture.diff.outputStackId !== stack.id
    || !stack.sourceEventIds.includes(manufacture.id)
    || verification?.kind !== 'action'
    || verification.status !== 'completed'
    || verification.who !== person.id
    || verification.action.kind !== 'attend'
    || verification.diff.verifiedSourceEventId !== manufacture.id
    || verification.diff.verifiedStackId !== stack.id
    || Number(verification.diff.verifiedMaterialId) !== materialId
    || !actionAfter(verification, manufacture)
    || (after && !actionAfter(manufacture, after))) return null;
  return { stack, manufacture, verification };
}

function supportedPlacement(state: SimulationState, position: ElectricalVoxelPosition): boolean {
  if (!positionInsideWorld(state, position) || position.z < 1) return false;
  return materialDefinition(voxelAt(state.world.grid, position.x, position.y, position.z - 1)).phase === 'solid';
}

function electricalInstall(
  state: SimulationState,
  person: PersonState,
  action: ActAction,
  basis: Extract<ElectricalPowerActionBasis, { mode: 'install' }>,
  atMonth: number,
  eventId: string,
) {
  if (basis.planKey !== electricalPowerPlanKey(basis.plan)
    || basis.networkId !== electricalPowerNetworkId(basis.plan)) {
    return { status: 'blocked' as const, result: '电力安装依据与冻结计划身份不一致', diff: {} };
  }
  const source = resolveMechanicalElectricalSourceContext(
    state, person, basis.plan, basis.mechanicalServiceEventId, true,
  );
  if ('blocked' in source) return { status: 'blocked' as const, result: source.blocked, diff: {} };
  if (source.network.condition <= MECHANICAL_POWER_WORN_FAULT_THRESHOLD) {
    return { status: 'blocked' as const, result: '机械来源已经达到下一次负载前必须检修的磨损边界', diff: {} };
  }
  const planned = plannedElectricalPowerComponents(basis.plan).find((candidate) => (
    candidate.role === basis.componentRole
      && candidate.materialId === basis.componentMaterialId
      && sameElectricalPosition(candidate.position, basis.componentPosition)
  ));
  const stackRef = action.targets.find((target): target is Extract<WorldRef, { kind: 'inventory-stack' }> => (
    target.kind === 'inventory-stack'
  ));
  const voxelRef = action.targets.find((target): target is Extract<WorldRef, { kind: 'voxel' }> => (
    target.kind === 'voxel'
  ));
  const existing = electricalNetworkForBasis(state, basis);
  if (!planned
    || action.targets.length !== 2
    || !stackRef
    || stackRef.personId !== person.id
    || !voxelRef
    || !sameElectricalPosition(voxelRef.position, basis.componentPosition)
    || distanceToPosition(person, basis.componentPosition) > 1
    || existing?.components.some((component) => component.role === planned.role
      && sameElectricalPosition(component.position, planned.position))
    || voxelAt(state.world.grid, planned.position.x, planned.position.y, planned.position.z) !== Material.Air
    || bodyOccupies(state, planned.position)
    || !supportedPlacement(state, planned.position)) {
    return { status: 'blocked' as const, result: '电力构件、实体材料、承托或冻结安装位置不一致', diff: {} };
  }
  const evidence = verifiedComponentEvidence(
    state,
    person,
    stackRef.stackId,
    planned.materialId,
    basis.manufactureEventId,
    basis.verificationEventId,
  );
  if (!evidence) {
    return { status: 'blocked' as const, result: '电力构件不是本人真实制造并源绑定核验的成品', diff: {} };
  }
  if (state.world.electricalPower
    && state.world.electricalPower.version !== ELECTRICAL_POWER_WORLD_VERSION) {
    return { status: 'blocked' as const, result: '已有电力世界版本无法安全解释', diff: {} };
  }
  const electricalWorld = state.world.electricalPower ?? emptyElectricalPowerWorldState();
  const network = ensureElectricalPowerNetwork(electricalWorld, basis.plan);
  recordElectricalPowerInstallation(network, {
    role: planned.role,
    materialId: planned.materialId,
    position: { ...planned.position },
    installedAtMonth: atMonth,
    installationEventId: eventId,
    sourceEventIds: [evidence.manufacture.id, evidence.verification.id, source.serviceEvent.id],
  });
  state.world.electricalPower = electricalWorld;
  evidence.stack.quantity -= 1;
  removeEmptyStacks(person);
  setVoxel(state.world.grid, planned.position.x, planned.position.y, planned.position.z, planned.materialId);
  return {
    status: 'completed' as const,
    result: `在实体相邻链上安装了${materialDefinition(planned.materialId).name}`,
    diff: {
      electricalPowerInstallation: true,
      mode: 'install',
      electricalNetworkId: network.id,
      electricalPlanKey: network.planKey,
      mechanicalNetworkId: source.network.id,
      mechanicalServiceEventId: source.serviceEvent.id,
      componentRole: planned.role,
      componentMaterialId: planned.materialId,
      componentPosition: { ...planned.position },
      manufactureEventId: evidence.manufacture.id,
      verificationEventId: evidence.verification.id,
      installationSourceEventIds: [evidence.manufacture.id, evidence.verification.id, source.serviceEvent.id],
      electricalPowerBasis: structuredClone(basis),
    },
  };
}

function exactElectricalWorld(state: SimulationState): ElectricalPowerWorldState | null {
  const world = state.world.electricalPower;
  return world?.version === ELECTRICAL_POWER_WORLD_VERSION ? world : null;
}

export interface ReliableElectricalKnowledgeEvidence {
  knowledge: KnownFact;
  sourceEvent: ActionFact;
}

function reliableTeachingSourceFor(
  event: ActionFact,
  person: PersonState,
  factId: string,
): boolean {
  if (event.status !== 'completed'
    || event.action.kind !== 'talk'
    || event.action.speakerMeaning.kind !== 'claim'
    || event.action.speakerMeaning.factId !== factId
    || event.diff.explicitTeaching !== true
    || event.diff.teachingFactId !== factId
    || !Array.isArray(event.diff.taughtAudienceIds)
    || !event.diff.taughtAudienceIds.includes(person.id)) return false;
  const confidenceByAudience = event.diff.teachingConfidenceByAudience;
  return Boolean(confidenceByAudience
    && typeof confidenceByAudience === 'object'
    && Number((confidenceByAudience as Record<string, unknown>)[person.id]) >= 55);
}

export function reliableElectricalOperationKnowledgeEvidence(
  state: SimulationState,
  person: PersonState,
): ReliableElectricalKnowledgeEvidence | null {
  const knowledge = person.knowledge.find((fact) => fact.kind === 'technique'
    && fact.id === ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID
    && fact.confidence >= 55);
  if (!knowledge) return null;
  for (const eventId of [...knowledge.sourceEventIds].reverse()) {
    const event = worldEventById(state, eventId);
    if (event?.kind !== 'action') continue;
    const actionBasis = event.action.kind === 'act' ? event.action.electricalPowerBasis : undefined;
    const directOperation = event.status === 'completed'
      && event.who === person.id
      && event.action.kind === 'act'
      && event.action.operation === 'exert'
      && isElectricalPowerActionBasis(actionBasis)
      && (actionBasis.mode === 'operate' || actionBasis.mode === 'operate-service')
      && event.diff.electricalNetworkId === actionBasis.networkId
      && event.diff.electricalPlanKey === actionBasis.planKey
      && event.diff.electricalPowerOperation === true
      && event.diff.electricalPowerDelivered === true
      && event.diff.operationKnowledgeId === ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID;
    if (directOperation || reliableTeachingSourceFor(event, person, knowledge.id)) {
      return { knowledge, sourceEvent: event };
    }
  }
  return null;
}

export function reliableElectricalLoadTechniqueKnowledgeEvidence(
  state: SimulationState,
  person: PersonState,
  inputMaterialId: MaterialId,
): ReliableElectricalKnowledgeEvidence | null {
  const prefix = electricalPowerLoadTechniquePrefix(inputMaterialId);
  const candidates = person.knowledge.filter((fact) => fact.kind === 'technique'
    && fact.id.startsWith(prefix)
    && fact.confidence >= 55);
  for (const knowledge of candidates) {
    for (const eventId of [...knowledge.sourceEventIds].reverse()) {
      const event = worldEventById(state, eventId);
      if (event?.kind !== 'action') continue;
      const actionBasis = event.action.kind === 'act' ? event.action.electricalPowerBasis : undefined;
      const directLoadService = event.status === 'completed'
        && event.who === person.id
        && event.action.kind === 'act'
        && event.action.operation === 'exert'
        && isElectricalPowerActionBasis(actionBasis)
        && actionBasis.mode === 'operate-service'
        && event.diff.electricalNetworkId === actionBasis.networkId
        && event.diff.electricalPlanKey === actionBasis.planKey
        && event.diff.electricalPowerUsefulLoad === true
        && event.diff.loadTechniqueId === knowledge.id
        && Number(event.diff.inputMaterialId) === inputMaterialId;
      if (directLoadService || reliableTeachingSourceFor(event, person, knowledge.id)) {
        return { knowledge, sourceEvent: event };
      }
    }
  }
  return null;
}

/** Bounded person-local lookup; it never scans a network operation ledger or world history. */
export function personalMechanicalServiceEventForElectricalPlan(
  state: SimulationState,
  person: PersonState,
  plan: ElectricalPowerPlan,
): ActionFact | null {
  const knowledge = person.knowledge.find((fact) => fact.kind === 'technique'
    && fact.id === MECHANICAL_POWER_OPERATION_TECHNIQUE_ID
    && fact.confidence >= 55);
  if (!knowledge) return null;
  for (const eventId of [...knowledge.sourceEventIds].reverse()) {
    const context = resolveMechanicalElectricalSourceContext(state, person, plan, eventId, true);
    if (!('blocked' in context)) return context.serviceEvent;
  }
  return null;
}

function recordElectricalOperationKnowledge(person: PersonState, eventId: string, atMonth: number): void {
  const existing = person.knowledge.find((fact) => fact.id === ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID
    && fact.kind === 'technique');
  if (existing) {
    existing.confidence = clamp(Math.max(existing.confidence, 60) + 8);
    existing.sourceEventIds = [...new Set([...existing.sourceEventIds, eventId])].slice(-24);
    return;
  }
  person.knowledge.push({
    id: ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID,
    kind: 'technique',
    summary: '让已投产机械轴驱动发电机，经实体铜导体向电阻负载交付有容量的电能',
    confidence: 68,
    learnedAtMonth: atMonth,
    sourceEventIds: [eventId],
  });
}

function recordElectricalLoadTechnique(
  person: PersonState,
  inputMaterialId: MaterialId,
  outputMaterialId: MaterialId,
  eventId: string,
  atMonth: number,
): string {
  const techniqueId = electricalPowerLoadTechniqueId(inputMaterialId, outputMaterialId);
  const existing = person.knowledge.find((fact) => fact.id === techniqueId && fact.kind === 'technique');
  if (existing) {
    existing.confidence = clamp(Math.max(existing.confidence, 60) + 8);
    existing.sourceEventIds = [...new Set([...existing.sourceEventIds, eventId])].slice(-24);
    return techniqueId;
  }
  person.knowledge.push({
    id: techniqueId,
    kind: 'technique',
    summary: `让${materialDefinition(inputMaterialId).name}接触已供电的电阻负载，可得到${materialDefinition(outputMaterialId).name}`,
    confidence: 68,
    learnedAtMonth: atMonth,
    sourceEventIds: [eventId],
  });
  return techniqueId;
}

function mechanicalWornFaultOutcome(
  state: SimulationState,
  person: PersonState,
  basis: ElectricalOperationBasis,
  electricalNetwork: ElectricalPowerNetworkState,
  source: MechanicalElectricalSourceContext,
  atMonth: number,
  eventId: string,
) {
  const conditionBefore = source.network.condition;
  const serviceLoadedOperationCount = currentMechanicalPowerServiceLoadedOperationCount(
    source.network,
    source.shaft.materialId,
  );
  const faultProofEventIds = mechanicalPowerFaultProofEventIds(source.network, source.shaft.component);
  const wearSourceEventIds = (source.network.serviceCycleOperationEventIds ?? []).slice(-3);
  recordMechanicalPowerFault(source.network, {
    kind: 'worn-drive-shaft',
    componentRole: 'connector',
    componentPosition: { ...source.shaft.component.position },
    atMonth,
    faultEventId: eventId,
    sourceEventIds: wearSourceEventIds,
    failedComponentMaterialId: source.shaft.materialId,
    failedComponentInstallationEventId: source.shaft.component.installationEventId,
    ...(source.shaft.component.latestRepairEventId ? {
      failedComponentRepairEventId: source.shaft.component.latestRepairEventId,
    } : {}),
    serviceLoadedOperationCount,
    proofEventIds: faultProofEventIds,
  }, person.id);
  setVoxel(
    state.world.grid,
    source.shaft.component.position.x,
    source.shaft.component.position.y,
    source.shaft.component.position.z,
    Material.BrokenDriveShaft,
  );
  return {
    status: 'completed' as const,
    result: '机械轴的既有负载磨损在供电前暴露为断裂，负载没有获得电能',
    diff: {
      mechanicalPowerFault: true,
      electricalPowerDelivered: false,
      mode: 'electrical-drive',
      installationProjectId: source.installationProjectId,
      planKey: source.network.planKey,
      networkId: source.network.id,
      electricalNetworkId: electricalNetwork.id,
      sourceSegmentId: source.network.sourceSegmentId,
      faultKind: 'worn-drive-shaft',
      faultEventId: eventId,
      componentRole: 'connector',
      componentPosition: { ...source.shaft.component.position },
      shaftMaterialId: source.shaft.materialId,
      shaftInstallationEventId: source.shaft.component.installationEventId,
      shaftInstallationSourceEventIds: source.shaft.component.sourceEventIds
        .slice(-MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT),
      ...(source.shaft.component.latestRepairEventId ? {
        shaftRepairEventId: source.shaft.component.latestRepairEventId,
      } : {}),
      ...(source.shaft.component.latestRepairSourceEventIds?.length ? {
        shaftRepairSourceEventIds: source.shaft.component.latestRepairSourceEventIds
          .slice(-MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT),
      } : {}),
      wearApplied: 0,
      serviceLoadedOperationCount,
      faultProofEventIds,
      wearSourceEventIds,
      conditionBefore,
      conditionAfter: source.network.condition,
      requestedPowerUnits: basis.requestedPowerUnits,
      powerDeliveredUnits: 0,
      ...(basis.mode === 'operate-service' ? {
        electricalPowerUsefulLoad: false,
        inputPreserved: true,
        inputMaterialId: basis.inputMaterialId,
      } : {}),
      mechanicalServiceEventId: source.serviceEvent.id,
      electricalPowerBasis: structuredClone(basis),
    },
  };
}

function electricalOverloadOutcome(
  state: SimulationState,
  basis: ElectricalOperationBasis,
  world: ElectricalPowerWorldState,
  network: ElectricalPowerNetworkState,
  source: MechanicalElectricalSourceContext,
  availablePowerUnits: number,
  atMonth: number,
  planningTick: number,
  eventId: string,
) {
  const conductorPosition = network.plan.conductorPositions[0];
  const conductor = network.components.find((candidate) => candidate.role === 'conductor'
    && sameElectricalPosition(candidate.position, conductorPosition))!;
  const dispatchWindow = world.dispatchWindows.find((window) => window.atMonth === atMonth
    && window.planningTick === planningTick
    && window.mechanicalNetworkId === source.network.id);
  const faultSourceEventIds = [
    source.serviceEvent.id,
    ...(dispatchWindow?.eventIds ?? []),
    conductor.installationEventId,
    ...(conductor.latestRepairEventId ? [conductor.latestRepairEventId] : []),
  ];
  recordElectricalPowerFault(network, {
    kind: 'overload-open-circuit',
    componentRole: 'conductor',
    componentPosition: { ...conductorPosition },
    atMonth,
    faultEventId: eventId,
    requestedPowerUnits: basis.requestedPowerUnits,
    availablePowerUnits,
    failedComponentInstallationEventId: conductor.installationEventId,
    ...(conductor.latestRepairEventId ? { failedComponentRepairEventId: conductor.latestRepairEventId } : {}),
    sourceEventIds: faultSourceEventIds,
  });
  setVoxel(
    state.world.grid,
    conductorPosition.x,
    conductorPosition.y,
    conductorPosition.z,
    Material.BrokenCopperConductor,
  );
  return {
    status: 'completed' as const,
    result: '同一刻度的负载超过剩余供电容量，实体铜导体熔断且负载没有获得电能',
    diff: {
      electricalPowerFault: true,
      electricalPowerDelivered: false,
      faultKind: 'overload-open-circuit',
      faultEventId: eventId,
      electricalNetworkId: network.id,
      electricalPlanKey: network.planKey,
      mechanicalNetworkId: source.network.id,
      mechanicalServiceEventId: source.serviceEvent.id,
      componentRole: 'conductor',
      componentPosition: { ...conductorPosition },
      requestedPowerUnits: basis.requestedPowerUnits,
      availablePowerUnits,
      powerDeliveredUnits: 0,
      ...(basis.mode === 'operate-service' ? {
        electricalPowerUsefulLoad: false,
        inputPreserved: true,
        inputMaterialId: basis.inputMaterialId,
      } : {}),
      dispatchSourceEventIds: dispatchWindow?.eventIds ?? [],
      conductorInstallationEventId: conductor.installationEventId,
      ...(conductor.latestRepairEventId ? { conductorRepairEventId: conductor.latestRepairEventId } : {}),
      electricalPowerBasis: structuredClone(basis),
    },
  };
}

function electricalOperate(
  state: SimulationState,
  person: PersonState,
  action: ActAction,
  basis: ElectricalOperationBasis,
  atMonth: number,
  planningTick: number,
  eventId: string,
) {
  const world = exactElectricalWorld(state);
  const network = electricalNetworkForBasis(state, basis);
  const loadRef = action.targets.find((target): target is Extract<WorldRef, { kind: 'voxel' }> => (
    target.kind === 'voxel'
  ));
  const inputRef = action.targets.find((target): target is Extract<WorldRef, { kind: 'inventory-stack' }> => (
    target.kind === 'inventory-stack'
  ));
  const expectedTargetCount = basis.mode === 'operate-service' ? 2 : 1;
  if (!world || !network
    || action.targets.length !== expectedTargetCount
    || !loadRef
    || !sameElectricalPosition(loadRef.position, network.plan.loadPosition)
    || distanceToPosition(person, network.plan.loadPosition) > 1
    || basis.requestedPowerUnits !== ELECTRICAL_POWER_LOAD_DEMAND) {
    return { status: 'blocked' as const, result: '电力负载、实体位置或额定功率请求不一致', diff: {} };
  }
  let serviceInput: ItemStack | null = null;
  let serviceResponse: ReturnType<typeof exposureRuleFor> = undefined;
  let operationKnowledge: ReliableElectricalKnowledgeEvidence | null = null;
  if (basis.mode === 'operate-service') {
    serviceInput = inputRef?.personId === person.id
      ? person.inventory.find((stack) => stack.id === inputRef.stackId
        && stack.materialId === basis.inputMaterialId
        && stack.quantity > 0
        && !stack.recordPayloadId) ?? null
      : null;
    operationKnowledge = reliableElectricalOperationKnowledgeEvidence(state, person);
    const response = exposureRuleFor(basis.inputMaterialId, Material.Fire);
    serviceResponse = response
      && (basis.inputMaterialId === Material.Food || basis.inputMaterialId === Material.RawMeat)
      && response.outputMaterialId === Material.CookedFood
      ? response
      : undefined;
    if (!serviceInput
      || !operationKnowledge
      || basis.operationKnowledgeId !== ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID
      || !serviceResponse) {
      return {
        status: 'blocked' as const,
        result: '电热尝试缺少本人可靠供电知识、当前实体输入，或该输入没有合法的负载响应',
        diff: {},
      };
    }
  } else if (inputRef) {
    return { status: 'blocked' as const, result: '空负载供电动作不能夹带物质输入', diff: {} };
  }
  const source = resolveMechanicalElectricalSourceContext(
    state, person, network.plan, basis.mechanicalServiceEventId, true,
  );
  if ('blocked' in source) return { status: 'blocked' as const, result: source.blocked, diff: {} };
  if (network.fault) return { status: 'blocked' as const, result: '电力网络仍有未修复断路', diff: {} };
  const topology = validateElectricalPowerTopology(state.world.grid, network);
  if (!topology.valid) return {
    status: 'blocked' as const,
    result: `电力实体拓扑实时复核失败：${topology.reason ?? 'unknown'}`,
    diff: { topologyReason: topology.reason },
  };
  let recoveryRepairEvent: ActionFact | undefined;
  if (basis.mode === 'operate-service') {
    const conductor = network.components.find((component) => component.role === 'conductor'
      && network.plan.conductorPositions.some((position) => sameElectricalPosition(
        component.position,
        position,
      )));
    const currentRepairEventId = conductor?.latestRepairEventId;
    if (basis.recoveryRepairEventId !== currentRepairEventId) {
      return {
        status: 'blocked' as const,
        result: '恢复后的普通负载服务没有绑定当前导体的精确修复来源',
        diff: {},
      };
    }
    if (currentRepairEventId) {
      const repair = worldEventById(state, currentRepairEventId);
      const repairBasis = repair?.kind === 'action'
        && repair.action.kind === 'act'
        ? repair.action.electricalPowerBasis
        : undefined;
      if (repair?.kind !== 'action'
        || repair.status !== 'completed'
        || repair.diff.electricalPowerRepair !== true
        || repair.diff.electricalNetworkId !== network.id
        || repair.diff.electricalPlanKey !== network.planKey
        || repairBasis?.mode !== 'repair'
        || repairBasis.networkId !== network.id
        || repairBasis.planKey !== network.planKey) {
        return {
          status: 'blocked' as const,
          result: '当前导体的修复来源不是可回放的同网络 repair receipt',
          diff: {},
        };
      }
      recoveryRepairEvent = repair;
    }
  }
  if (source.network.condition <= MECHANICAL_POWER_WORN_FAULT_THRESHOLD) {
    return mechanicalWornFaultOutcome(state, person, basis, network, source, atMonth, eventId);
  }
  const usedPowerUnits = usedElectricalPowerForMechanicalSource(
    world, source.network.id, atMonth, planningTick,
  );
  const totalSourceCapacity = Math.min(
    source.availableCapacity,
    ELECTRICAL_POWER_GENERATOR_CAPACITY,
    ELECTRICAL_POWER_CONDUCTOR_CAPACITY,
  );
  const availablePowerUnits = Math.max(0, totalSourceCapacity - usedPowerUnits);
  if (basis.requestedPowerUnits > availablePowerUnits) {
    return electricalOverloadOutcome(
      state, basis, world, network, source, availablePowerUnits, atMonth, planningTick, eventId,
    );
  }
  const inputStackId = serviceInput?.id;
  const inputSourceEventIds = serviceInput ? [...serviceInput.sourceEventIds] : [];
  const inputSourceLineageKeys = serviceInput ? [...(serviceInput.sourceLineageKeys ?? [])] : [];
  const conditionBefore = source.network.condition;
  const operationRecord = recordMechanicalPowerOperation(
    source.network, eventId, source.shaft.materialId,
  );
  recordElectricalPowerOperation(network, eventId);
  recordElectricalPowerDispatch(
    world,
    source.network.id,
    atMonth,
    planningTick,
    basis.requestedPowerUnits,
    eventId,
  );
  let outputStack: ItemStack | undefined;
  let loadTechniqueId: string | undefined;
  if (basis.mode === 'operate-service' && serviceInput && serviceResponse && inputStackId) {
    serviceInput.quantity -= 1;
    removeEmptyStacks(person);
    outputStack = addInventory(
      person,
      serviceResponse.outputMaterialId,
      1,
      [eventId, ...inputSourceEventIds],
      `stack-${person.id}-${serviceResponse.outputMaterialId}-${eventId}`,
      undefined,
      [`electrical-network:${network.id}`, `input-stack:${inputStackId}`, ...inputSourceLineageKeys],
    );
    loadTechniqueId = recordElectricalLoadTechnique(
      person,
      basis.inputMaterialId,
      serviceResponse.outputMaterialId,
      eventId,
      atMonth,
    );
  }
  recordElectricalOperationKnowledge(person, eventId, atMonth);
  return {
    status: 'completed' as const,
    result: basis.mode === 'operate-service' && serviceResponse
      ? `机械发电机经实体铜导体使电阻负载把${materialDefinition(basis.inputMaterialId).name}转化为${materialDefinition(serviceResponse.outputMaterialId).name}`
      : `机械发电机经实体铜导体向电阻负载交付电能 × ${basis.requestedPowerUnits}`,
    diff: {
      mechanicalPowerOperation: true,
      mechanicalPowerServiceLoad: 'electrical-generation',
      electricalPowerOperation: true,
      electricalPowerDelivered: true,
      ...(basis.mode === 'operate-service' && serviceResponse && inputStackId && outputStack && loadTechniqueId ? {
        electricalPowerUsefulLoad: true,
        electricalPowerServiceMode: 'resistive-load-heating',
        inputMaterialId: basis.inputMaterialId,
        inputStackId,
        inputSourceEventIds,
        inputSourceLineageKeys,
        inputQuantity: 1,
        outputMaterialId: serviceResponse.outputMaterialId,
        outputStackId: outputStack.id,
        outputQuantity: 1,
        loadTechniqueId,
        operationKnowledgeSourceEventId: operationKnowledge?.sourceEvent.id,
        ...(recoveryRepairEvent ? { recoveryRepairEventId: recoveryRepairEvent.id } : {}),
      } : {}),
      mode: 'electrical-drive',
      installationProjectId: source.installationProjectId,
      planKey: source.network.planKey,
      networkId: source.network.id,
      electricalNetworkId: network.id,
      electricalPlanKey: network.planKey,
      sourceSegmentId: source.network.sourceSegmentId,
      mechanicalServiceEventId: source.serviceEvent.id,
      generatorPosition: { ...network.plan.generatorPosition },
      conductorPositions: network.plan.conductorPositions.map((position) => ({ ...position })),
      loadPosition: { ...network.plan.loadPosition },
      requestedPowerUnits: basis.requestedPowerUnits,
      sourceCapacityUnits: totalSourceCapacity,
      sourceUsedBeforeUnits: usedPowerUnits,
      powerDeliveredUnits: basis.requestedPowerUnits,
      operationCount: network.operationCount,
      conditionBefore,
      conditionAfter: source.network.condition,
      shaftMaterialId: source.shaft.materialId,
      shaftInstallationEventId: source.shaft.component.installationEventId,
      shaftInstallationSourceEventIds: source.shaft.component.sourceEventIds
        .slice(-MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT),
      ...(source.shaft.component.latestRepairEventId ? {
        shaftRepairEventId: source.shaft.component.latestRepairEventId,
      } : {}),
      ...(source.shaft.component.latestRepairSourceEventIds?.length ? {
        shaftRepairSourceEventIds: source.shaft.component.latestRepairSourceEventIds
          .slice(-MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT),
      } : {}),
      wearApplied: operationRecord.wearApplied,
      serviceLoadedOperationOrdinal: operationRecord.serviceLoadedOperationOrdinal,
      supportingSegmentIds: source.supportingSegmentIds,
      operationKnowledgeId: ELECTRICAL_POWER_OPERATION_TECHNIQUE_ID,
      electricalPowerBasis: structuredClone(basis),
    },
  };
}

function electricalRepair(
  state: SimulationState,
  person: PersonState,
  action: ActAction,
  basis: Extract<ElectricalPowerActionBasis, { mode: 'repair' }>,
  eventId: string,
) {
  const network = electricalNetworkForBasis(state, basis);
  const fault = network?.fault;
  const faultEvent = fault && network
    ? worldEventById(state, fault.faultEventId)
    : undefined;
  const faultRef = action.targets.find((target): target is Extract<WorldRef, { kind: 'voxel' }> => (
    target.kind === 'voxel'
  ));
  const replacementRef = action.targets.find((target): target is Extract<WorldRef, { kind: 'inventory-stack' }> => (
    target.kind === 'inventory-stack'
  ));
  const tool = action.toolStackId ? person.inventory.find((stack) => stack.id === action.toolStackId
    && stack.materialId === Material.IronTool
    && stack.quantity > 0
    && !stack.recordPayloadId) : undefined;
  const maintenanceProject = basis.maintenanceProjectId
    ? state.projects.find((candidate) => candidate.id === basis.maintenanceProjectId)
    : undefined;
  const maintenanceBasis = maintenanceProject?.electricalPowerMaintenanceBasis;
  const completedElectricalProject = maintenanceBasis
    ? state.projects.find((candidate) => candidate.id === maintenanceBasis.installationProjectId)
    : undefined;
  const diagnosisEvent = maintenanceProject && maintenanceBasis
    ? worldEventById(state, maintenanceBasis.diagnosisEventId)
    : undefined;
  const diagnosisKnowledge = network && maintenanceBasis
    ? person.knowledge.find((fact) => fact.kind === 'observation'
      && fact.id === electricalPowerFaultObservationFactId(network.id, basis.faultEventId)
      && fact.confidence >= 55
      && fact.sourceEventIds.includes(maintenanceBasis.diagnosisEventId))
    : undefined;
  const maintenanceActionIds = new Set(
    maintenanceProject?.actionEventIds.slice(-16) ?? [],
  );
  const maintenanceContractValid = !basis.maintenanceProjectId || Boolean(
    maintenanceProject?.status === 'active'
      && maintenanceProject.ownerId === person.id
      && maintenanceProject.need === 'equipment-reliability'
      && maintenanceProject.desiredFunction === 'restore-electrical-power-delivery'
      && maintenanceProject.electricalPowerNetworkId === network?.id
      && maintenanceProject.electricalPowerPlanKey === network?.planKey
      && maintenanceBasis?.observerId === person.id
      && completedElectricalProject?.status === 'completed'
      && completedElectricalProject.desiredFunction === 'remote-work-power-delivery'
      && completedElectricalProject.electricalPowerNetworkId === network?.id
      && completedElectricalProject.electricalPowerPlanKey === network?.planKey
      && maintenanceBasis.networkId === network?.id
      && maintenanceBasis.planKey === network?.planKey
      && maintenanceBasis.faultEventId === basis.faultEventId
      && maintenanceBasis.sourceFactIds.length === 2
      && maintenanceBasis.sourceFactIds[0] === basis.faultEventId
      && maintenanceBasis.sourceFactIds[1] === maintenanceBasis.diagnosisEventId
      && maintenanceBasis.basisKey === [
        'electrical-power-maintenance-basis-v1',
        `observer=${person.id}`,
        `installation=${maintenanceBasis.installationProjectId}`,
        `network=${network?.id}`,
        `plan=${network?.planKey}`,
        `fault=${basis.faultEventId}`,
        `diagnosis=${maintenanceBasis.diagnosisEventId}`,
      ].join('|')
      && diagnosisEvent?.kind === 'action'
      && diagnosisEvent.status === 'completed'
      && diagnosisEvent.who === person.id
      && diagnosisEvent.action.kind === 'attend'
      && diagnosisEvent.action.electricalPowerFaultObservation?.networkId === network?.id
      && diagnosisEvent.action.electricalPowerFaultObservation.faultEventId === basis.faultEventId
      && diagnosisEvent.diff.electricalPowerFaultDiagnosis === true
      && diagnosisEvent.diff.electricalNetworkId === network?.id
      && diagnosisEvent.diff.faultEventId === basis.faultEventId
      && faultEvent?.kind === 'action'
      && actionAfter(diagnosisEvent, faultEvent)
      && maintenanceActionIds.has(basis.manufactureEventId)
      && maintenanceActionIds.has(basis.verificationEventId)
      && diagnosisKnowledge,
  );
  if (!network
    || !fault
    || fault.kind !== 'overload-open-circuit'
    || fault.faultEventId !== basis.faultEventId
    || faultEvent?.kind !== 'action'
    || faultEvent.status !== 'completed'
    || faultEvent.diff.electricalPowerFault !== true
    || faultEvent.diff.electricalNetworkId !== network.id
    || faultEvent.diff.electricalPlanKey !== network.planKey
    || action.targets.length !== 2
    || !faultRef
    || !sameElectricalPosition(faultRef.position, fault.componentPosition)
    || !replacementRef
    || replacementRef.personId !== person.id
    || !tool
    || !maintenanceContractValid
    || distanceToPosition(person, fault.componentPosition) > 1
    || voxelAt(state.world.grid, fault.componentPosition.x, fault.componentPosition.y, fault.componentPosition.z)
      !== Material.BrokenCopperConductor
    || !validateElectricalPowerTopology(state.world.grid, network, true).valid) {
    return { status: 'blocked' as const, result: '电力修复所需故障、替换导体、工具或实体位置不一致', diff: {} };
  }
  const source = resolveMechanicalElectricalSourceContext(
    state, person, network.plan, basis.mechanicalServiceEventId, false,
  );
  if ('blocked' in source) return { status: 'blocked' as const, result: source.blocked, diff: {} };
  const evidence = verifiedComponentEvidence(
    state,
    person,
    replacementRef.stackId,
    Material.CopperConductor,
    basis.manufactureEventId,
    basis.verificationEventId,
    faultEvent,
  );
  if (!evidence) {
    return { status: 'blocked' as const, result: '替换导体不是故障之后由本人制造并核验的实体', diff: {} };
  }
  const repairSourceEventIds = [...new Set([
    fault.faultEventId,
    ...(maintenanceBasis ? [maintenanceBasis.diagnosisEventId] : []),
    evidence.manufacture.id,
    evidence.verification.id,
    source.serviceEvent.id,
    ...tool.sourceEventIds,
  ])].slice(0, 12);
  recordElectricalPowerRepair(network, eventId, repairSourceEventIds);
  evidence.stack.quantity -= 1;
  removeEmptyStacks(person);
  setVoxel(
    state.world.grid,
    fault.componentPosition.x,
    fault.componentPosition.y,
    fault.componentPosition.z,
    Material.CopperConductor,
  );
  return {
    status: 'completed' as const,
    result: '用故障后制造并核验的新铜导体修复了实体断路',
    diff: {
      electricalPowerRepair: true,
      ...(maintenanceProject ? { maintenanceProjectId: maintenanceProject.id } : {}),
      electricalNetworkId: network.id,
      electricalPlanKey: network.planKey,
      mechanicalNetworkId: source.network.id,
      mechanicalServiceEventId: source.serviceEvent.id,
      faultEventId: fault.faultEventId,
      componentPosition: { ...fault.componentPosition },
      replacementMaterialId: Material.CopperConductor,
      replacementStackId: replacementRef.stackId,
      replacementManufactureEventId: evidence.manufacture.id,
      replacementVerificationEventId: evidence.verification.id,
      toolMaterialId: Material.IronTool,
      toolStackId: tool.id,
      repairSourceEventIds,
      repairCount: network.repairCount,
      electricalPowerBasis: structuredClone(basis),
    },
  };
}

export function executeElectricalPowerAction(
  state: SimulationState,
  person: PersonState,
  action: ActAction,
  atMonth: number,
  planningTick: number,
  eventId: string,
) {
  const basis = action.electricalPowerBasis;
  if (!basis
    || !isElectricalPowerActionBasis(basis)
    || basis.version !== ELECTRICAL_POWER_ACTION_BASIS_VERSION
    || action.operation !== 'exert'
    || action.mechanicalPowerBasis) {
    return { status: 'blocked' as const, result: '电力动作只能通过唯一、带版本来源依据的通用施力动作执行', diff: {} };
  }
  if (basis.mode === 'install') return electricalInstall(state, person, action, basis, atMonth, eventId);
  if (basis.mode === 'operate' || basis.mode === 'operate-service') {
    return electricalOperate(state, person, action, basis, atMonth, planningTick, eventId);
  }
  return electricalRepair(state, person, action, basis, eventId);
}
