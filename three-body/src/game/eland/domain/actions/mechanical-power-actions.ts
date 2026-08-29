import { waterCurrentObservationFactId, type PrimitiveAction, type WorldRef } from '../action';
import { Material, materialDefinition, type MaterialId } from '../material';
import type { ActionFact, SimulationState } from '../model';
import type { ItemStack, PersonState } from '../person';
import type { ProjectState } from '../project';
import { worldEventById } from '../event-index';
import { projectById } from '../state-index';
import {
  eventAfterCurrentLeadership,
  projectEventHasEventTimeLead,
  projectIsLedBy,
} from '../project-leadership';
import {
  MECHANICAL_POWER_ACTION_BASIS_VERSION,
  MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT,
  MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
  MECHANICAL_POWER_PLAN_VERSION,
  MECHANICAL_POWER_WORN_FAULT_THRESHOLD,
  MECHANICAL_POWER_WORLD_VERSION,
  currentMechanicalPowerServiceLoadedOperationCount,
  ensureMechanicalPowerNetwork,
  isMechanicalDriveShaftMaterial,
  mechanicalDriveShaftSpecification,
  mechanicalPowerFaultProofEventIds,
  mechanicalPowerFaultObservationFactId,
  mechanicalPowerNetworkId,
  mechanicalPowerPlanKey,
  plannedMechanicalPowerComponents,
  recordMechanicalPowerFault,
  recordMechanicalPowerInstallation,
  recordMechanicalPowerOperation,
  recordMechanicalPowerRepair,
  validateMechanicalPowerInstallationSite,
  validateMechanicalPowerTopology,
  waterCurrentAvailabilityFor,
  type MechanicalPowerActionBasis,
  type MechanicalDriveShaftMaterialId,
  type MechanicalPowerComponentInstallation,
  type MechanicalPowerNetworkState,
  type MechanicalPowerProjectPlan,
  type MechanicalPowerWorldState,
} from '../mechanical-power';
import {
  cellId,
  cellsInRadius,
  findStandingPath,
  setVoxel,
  standingPositions,
  voxelAt,
} from '../../world/grid';
import { bodyOccupies, clamp, distanceToPosition, sameIds, samePosition } from './execution-helpers';
import { addInventory, removeEmptyStacks } from './inventory';

interface MechanicalActionContext {
  project: ProjectState;
  installationProject: ProjectState;
  plan: MechanicalPowerProjectPlan;
  mechanicalPower: MechanicalPowerWorldState;
  network?: MechanicalPowerNetworkState;
  observationEvent?: ActionFact;
  supportingSegmentIds: string[];
}

interface MechanicalActionBlock {
  blocked: string;
  currentUnavailable?: {
    reason: string;
  };
}

function isMechanicalVoxelPosition(value: unknown): value is MechanicalPowerProjectPlan['wheelPosition'] {
  if (!value || typeof value !== 'object') return false;
  const position = value as { x?: unknown; y?: unknown; z?: unknown };
  return Number.isInteger(position.x) && Number.isInteger(position.y) && Number.isInteger(position.z);
}

function actionHappenedAfter(candidate: ActionFact, basis: ActionFact): boolean {
  return candidate.atMonth > basis.atMonth
    || (candidate.atMonth === basis.atMonth && candidate.orderInMonth > basis.orderInMonth)
    || (candidate.atMonth === basis.atMonth
      && candidate.orderInMonth === basis.orderInMonth
      && candidate.id.localeCompare(basis.id) > 0);
}

function personalWaterCurrentObservationEvent(
  state: SimulationState,
  person: PersonState,
  segmentId: string,
  allowedEventIds?: ReadonlySet<string>,
): ActionFact | null {
  const known = person.knowledge.find((fact) => fact.id === waterCurrentObservationFactId(segmentId)
    && fact.kind === 'observation'
    && fact.confidence >= 55);
  if (!known) return null;
  return known.sourceEventIds.flatMap((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action' ? [event] : [];
  }).filter((event) => event.status === 'completed'
    && (!allowedEventIds || allowedEventIds.has(event.id))
    && event.who === person.id
    && event.action.kind === 'attend'
    && event.action.waterCurrentSegmentId === segmentId
    && event.diff.mechanicalPowerObservation === true
    && event.diff.waterCurrentSegmentId === segmentId)
    .sort((left, right) => left.atMonth - right.atMonth
      || left.orderInMonth - right.orderInMonth
      || left.id.localeCompare(right.id))
    .at(-1) ?? null;
}

function mechanicalActionContext(
  state: SimulationState,
  person: PersonState,
  basis: Extract<MechanicalPowerActionBasis, { mode: 'install' | 'revise-site' | 'operate' | 'repair' }>,
  requireFlow: boolean,
): MechanicalActionContext | MechanicalActionBlock {
  if (basis.version !== MECHANICAL_POWER_ACTION_BASIS_VERSION) {
    return { blocked: '机械动作依据版本或模式无效' };
  }
  const projectCandidate = projectById(state, basis.projectId);
  const project = projectCandidate?.status === 'active'
    && projectIsLedBy(projectCandidate, person.id)
    && projectCandidate.desiredFunction === 'water-powered-crop-processing'
    ? projectCandidate
    : undefined;
  const plan = project?.mechanicalPowerPlan;
  if (!project || !plan
    || plan.version !== MECHANICAL_POWER_PLAN_VERSION
    || plan.projectId !== project.id
    || project.mechanicalPowerPlanKey !== mechanicalPowerPlanKey(plan)
    || project.mechanicalPowerNetworkId !== mechanicalPowerNetworkId(plan)
    || basis.planKey !== project.mechanicalPowerPlanKey
    || basis.networkId !== project.mechanicalPowerNetworkId
    || basis.sourceSegmentId !== plan.sourceSegmentId
    || !sameIds(basis.sourceKeys, plan.sourceKeys)) {
    return { blocked: '机械动作与本人冻结的项目计划不一致' };
  }
  const mechanicalPower = state.world.mechanicalPower;
  const source = mechanicalPower?.version === MECHANICAL_POWER_WORLD_VERSION
    ? mechanicalPower.sources.find((candidate) => candidate.id === plan.sourceSegmentId)
    : undefined;
  if (!mechanicalPower || !source || !sameIds(source.sourceKeys, plan.sourceKeys)) {
    return { blocked: '冻结计划的水流来源已经不匹配' };
  }
  const observationEvent = personalWaterCurrentObservationEvent(
    state, person, source.id, new Set(project.triggerFactIds),
  );
  if (!observationEvent || !eventAfterCurrentLeadership(project, observationEvent)) {
    return { blocked: '机械动作缺少当前负责人的现场水流观察' };
  }
  const availability = waterCurrentAvailabilityFor(state.world.grid, mechanicalPower, source.id);
  if (requireFlow && !availability.available) return {
    blocked: '冻结计划所绑定的水流当前已经失效',
    currentUnavailable: { reason: availability.reason ?? 'unknown' },
  };
  const network = mechanicalPower.networks.find((candidate) => candidate.id === basis.networkId);
  if (network && (network.planKey !== basis.planKey
    || network.installationProjectId !== project.id
    || network.sourceSegmentId !== source.id)) {
    return { blocked: '机械网络身份与冻结计划冲突' };
  }
  return {
    project,
    installationProject: project,
    plan,
    mechanicalPower,
    ...(network ? { network } : {}),
    observationEvent,
    supportingSegmentIds: availability.supportingSegmentIds,
  };
}

function maintenanceMatchesReliabilityBasis(
  maintenance: ProjectState,
  observerId: string,
  networkId: string,
  installationProjectId: string,
  faultEventId: string | undefined,
): boolean {
  if (maintenance.desiredFunction !== 'durable-power-transmission') return true;
  const reliability = maintenance.mechanicalReliabilityBasis;
  return maintenance.need === 'equipment-reliability'
    && reliability?.observerId === observerId
    && reliability.networkId === networkId
    && reliability.installationProjectId === installationProjectId
    && reliability.faults.at(-1)?.faultEventId === faultEventId;
}

function mechanicalServiceActionContext(
  state: SimulationState,
  person: PersonState,
  basis: Extract<MechanicalPowerActionBasis, { mode: 'operate-service' | 'repair-service' }>,
  requireFlow: boolean,
): MechanicalActionContext | MechanicalActionBlock {
  if (basis.version !== MECHANICAL_POWER_ACTION_BASIS_VERSION) {
    return { blocked: '持续机械动作依据版本无效' };
  }
  const installationProjectCandidate = projectById(state, basis.installationProjectId);
  const installationProject = installationProjectCandidate?.status === 'completed'
    && installationProjectCandidate.desiredFunction === 'water-powered-crop-processing'
    ? installationProjectCandidate
    : undefined;
  const plan = installationProject?.mechanicalPowerPlan;
  if (!installationProject || !plan
    || plan.version !== MECHANICAL_POWER_PLAN_VERSION
    || plan.projectId !== installationProject.id
    || installationProject.mechanicalPowerPlanKey !== mechanicalPowerPlanKey(plan)
    || installationProject.mechanicalPowerNetworkId !== basis.networkId
    || basis.planKey !== installationProject.mechanicalPowerPlanKey
    || basis.sourceSegmentId !== plan.sourceSegmentId
    || !sameIds(basis.sourceKeys, plan.sourceKeys)) {
    return { blocked: '持续机械动作与已完成安装项目的冻结计划不一致' };
  }
  const mechanicalPower = state.world.mechanicalPower;
  const source = mechanicalPower?.version === MECHANICAL_POWER_WORLD_VERSION
    ? mechanicalPower.sources.find((candidate) => candidate.id === plan.sourceSegmentId)
    : undefined;
  const network = mechanicalPower?.networks.find((candidate) => candidate.id === basis.networkId
    && candidate.planKey === basis.planKey
    && candidate.installationProjectId === installationProject.id
    && candidate.sourceSegmentId === source?.id);
  if (!mechanicalPower || !source || !network || !sameIds(source.sourceKeys, plan.sourceKeys)) {
    return { blocked: '持续机械动作的来源或网络身份已经失效' };
  }
  const availability = waterCurrentAvailabilityFor(state.world.grid, mechanicalPower, source.id);
  if (requireFlow && !availability.available) return {
    blocked: '机械网络绑定的水流当前已经失效',
    currentUnavailable: { reason: availability.reason ?? 'unknown' },
  };

  let project = installationProject;
  if (basis.mode === 'operate-service') {
    const operationKnowledge = person.knowledge.find((fact) => fact.id === basis.operationKnowledgeId
      && fact.id === MECHANICAL_POWER_OPERATION_TECHNIQUE_ID
      && fact.kind === 'technique'
      && fact.confidence >= 55);
    if (!operationKnowledge) return { blocked: '本人没有可靠学会这类机械网络的负载作业' };
    if (basis.maintenanceProjectId || basis.recoveryRepairEventId) {
      const maintenance = basis.maintenanceProjectId ? projectById(state, basis.maintenanceProjectId) : undefined;
      const repair = basis.recoveryRepairEventId ? worldEventById(state, basis.recoveryRepairEventId) : undefined;
      if (!maintenance
        || maintenance.status !== 'active'
        || maintenance.ownerId !== person.id
        || (maintenance.desiredFunction !== 'restore-water-powered-crop-processing'
          && maintenance.desiredFunction !== 'durable-power-transmission')
        || !maintenanceMatchesReliabilityBasis(
          maintenance,
          person.id,
          network.id,
          installationProject.id,
          maintenance.mechanicalPowerFaultEventId,
        )
        || maintenance.mechanicalPowerNetworkId !== network.id
        || maintenance.mechanicalPowerPlanKey !== network.planKey
        || maintenance.mechanicalPowerPlan?.projectId !== installationProject.id
        || !maintenance.mechanicalPowerFaultEventId
        || !repair
        || repair.kind !== 'action'
        || repair.status !== 'completed'
        || repair.diff.mechanicalPowerRepair !== true
        || repair.diff.networkId !== network.id
        || repair.diff.faultEventId !== maintenance.mechanicalPowerFaultEventId
        || !maintenance.actionEventIds.includes(repair.id)
        || !network.components.some((component) => component.role === 'connector'
          && component.latestRepairEventId === repair.id)) {
        return { blocked: '恢复作业没有绑定仍活跃的维修项目及其真实修复事实' };
      }
      project = maintenance;
    }
  } else {
    const maintenance = projectById(state, basis.maintenanceProjectId);
    const fault = network.fault;
    const diagnosis = person.knowledge.find((fact) => fact.id === basis.diagnosisFactId
      && fact.id === mechanicalPowerFaultObservationFactId(network.id, basis.faultEventId)
      && fact.kind === 'observation'
      && fact.confidence >= 55);
    const diagnosisAction = diagnosis?.sourceEventIds.flatMap((eventId) => {
      const event = worldEventById(state, eventId);
      return event?.kind === 'action' ? [event] : [];
    }).find((event) => event.status === 'completed'
      && event.who === person.id
      && event.action.kind === 'attend'
      && event.action.mechanicalPowerFaultObservation?.networkId === network.id
      && event.action.mechanicalPowerFaultObservation.faultEventId === basis.faultEventId
      && event.diff.mechanicalPowerFaultDiagnosis === true);
    if (!maintenance
      || maintenance.status !== 'active'
      || maintenance.ownerId !== person.id
      || (maintenance.desiredFunction !== 'restore-water-powered-crop-processing'
        && maintenance.desiredFunction !== 'durable-power-transmission')
      || !maintenanceMatchesReliabilityBasis(
        maintenance,
        person.id,
        network.id,
        installationProject.id,
        basis.faultEventId,
      )
      || maintenance.mechanicalPowerNetworkId !== network.id
      || maintenance.mechanicalPowerPlanKey !== network.planKey
      || maintenance.mechanicalPowerPlan?.projectId !== installationProject.id
      || maintenance.mechanicalPowerFaultEventId !== basis.faultEventId
      || !fault
      || fault.faultEventId !== basis.faultEventId
      || !diagnosisAction
      || !maintenance.triggerFactIds.includes(diagnosisAction.id)) {
      return { blocked: '维修动作没有绑定本人诊断、当前故障与活跃维修项目' };
    }
    project = maintenance;
  }
  return {
    project,
    installationProject,
    plan,
    mechanicalPower,
    network,
    supportingSegmentIds: availability.supportingSegmentIds,
  };
}

function projectActionFactsForMechanical(state: SimulationState, project: ProjectState): ActionFact[] {
  return project.actionEventIds.flatMap((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action' ? [event] : [];
  });
}

function driveShaftComponentAt(
  network: MechanicalPowerNetworkState,
  plan: MechanicalPowerProjectPlan,
  position: MechanicalPowerProjectPlan['shaftPositions'][number],
): MechanicalPowerComponentInstallation | undefined {
  return network.components.find((component) => component.role === 'connector'
    && component.projectId === plan.projectId
    && samePosition(component.position, position)
    && isMechanicalDriveShaftMaterial(component.materialId));
}

function installedDriveShaftAt(
  state: SimulationState,
  network: MechanicalPowerNetworkState,
  plan: MechanicalPowerProjectPlan,
  position: MechanicalPowerProjectPlan['shaftPositions'][number],
): { component: MechanicalPowerComponentInstallation; materialId: MechanicalDriveShaftMaterialId } | null {
  const component = driveShaftComponentAt(network, plan, position);
  const materialId = voxelAt(state.world.grid, position.x, position.y, position.z);
  return component && isMechanicalDriveShaftMaterial(materialId) && component.materialId === materialId
    ? { component, materialId }
    : null;
}

/** A mixed chain wears at its weakest installed connector; ties keep frozen plan order. */
function loadedDriveShaft(
  state: SimulationState,
  network: MechanicalPowerNetworkState,
  plan: MechanicalPowerProjectPlan,
): { component: MechanicalPowerComponentInstallation; materialId: MechanicalDriveShaftMaterialId } | null {
  let selected: { component: MechanicalPowerComponentInstallation; materialId: MechanicalDriveShaftMaterialId } | null = null;
  for (const position of plan.shaftPositions) {
    const candidate = installedDriveShaftAt(state, network, plan, position);
    if (!candidate) return null;
    if (!selected || mechanicalDriveShaftSpecification(candidate.materialId)!.wearPerLoadedOperation
      > mechanicalDriveShaftSpecification(selected.materialId)!.wearPerLoadedOperation) {
      selected = candidate;
    }
  }
  return selected;
}

function faultEvidenceFor(
  network: MechanicalPowerNetworkState,
  shaft: { component: MechanicalPowerComponentInstallation; materialId: MechanicalDriveShaftMaterialId },
) {
  return {
    failedComponentMaterialId: shaft.materialId,
    failedComponentInstallationEventId: shaft.component.installationEventId,
    ...(shaft.component.latestRepairEventId ? {
      failedComponentRepairEventId: shaft.component.latestRepairEventId,
    } : {}),
    serviceLoadedOperationCount: currentMechanicalPowerServiceLoadedOperationCount(network, shaft.materialId),
    proofEventIds: mechanicalPowerFaultProofEventIds(network, shaft.component),
  };
}

function currentShaftRepairFact(
  state: SimulationState,
  network: MechanicalPowerNetworkState,
  shaft: { component: MechanicalPowerComponentInstallation; materialId: MechanicalDriveShaftMaterialId },
): ActionFact | null {
  const repairEventId = shaft.component.latestRepairEventId;
  const repair = repairEventId ? worldEventById(state, repairEventId) : undefined;
  return repair?.kind === 'action'
    && repair.status === 'completed'
    && repair.diff.mechanicalPowerRepair === true
    && repair.diff.networkId === network.id
    && Number(repair.diff.replacementMaterialId) === shaft.materialId
    ? repair
    : null;
}

function verifiedComponentEvidence(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  stackId: string,
  materialId: MaterialId,
  after?: ActionFact,
  expected?: { manufactureEventId: string; verificationEventId: string },
): { manufacture: ActionFact; verification: ActionFact; stack: ItemStack } | null {
  const stack = person.inventory.find((candidate) => candidate.id === stackId
    && candidate.materialId === materialId
    && candidate.quantity > 0
    && !candidate.recordPayloadId);
  if (!stack) return null;
  const actions = projectActionFactsForMechanical(state, project);
  for (const manufacture of actions.filter((event) => event.status === 'completed'
    && (!expected || event.id === expected.manufactureEventId)
    && event.who === person.id
    && projectEventHasEventTimeLead(project, event)
    && event.action.kind === 'act'
    && event.action.operation === 'combine'
    && Number(event.diff.outputMaterialId) === materialId
    && event.diff.outputStackId === stack.id
    && stack.sourceEventIds.includes(event.id)
    && (!after || actionHappenedAfter(event, after))).reverse()) {
    const verification = actions.find((event) => event.status === 'completed'
      && (!expected || event.id === expected.verificationEventId)
      && event.who === person.id
      && projectEventHasEventTimeLead(project, event)
      && event.action.kind === 'attend'
      && event.diff.verifiedSourceEventId === manufacture.id
      && event.diff.verifiedStackId === stack.id
      && Number(event.diff.verifiedMaterialId) === materialId
      && actionHappenedAfter(event, manufacture));
    if (verification) return { manufacture, verification, stack };
  }
  return null;
}

function mechanicalInstall(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'act' }>,
  basis: Extract<MechanicalPowerActionBasis, { mode: 'install' }>,
  atMonth: number,
  eventId: string,
) {
  const context = mechanicalActionContext(state, person, basis, false);
  if ('blocked' in context) return { status: 'blocked' as const, result: context.blocked, diff: {} };
  const planned = plannedMechanicalPowerComponents(context.plan).find((component) => component.role === basis.componentRole
    && component.materialId === basis.componentMaterialId
    && samePosition(component.position, basis.componentPosition));
  const voxelRef = action.targets.find((target): target is Extract<WorldRef, { kind: 'voxel' }> => target.kind === 'voxel');
  const stackRef = action.targets.find((target): target is Extract<WorldRef, { kind: 'inventory-stack' }> => target.kind === 'inventory-stack');
  const interactionRange = basis.componentRole === 'converter' ? 2 : 1;
  if (!planned || !voxelRef || !samePosition(voxelRef.position, basis.componentPosition)
    || !stackRef || stackRef.personId !== person.id
    || distanceToPosition(person, basis.componentPosition) > interactionRange) {
    return { status: 'blocked' as const, result: '机械构件、材料或冻结安装位置不在近身范围', diff: {} };
  }
  if (context.network?.components.some((component) => component.role === planned.role
    && samePosition(component.position, planned.position))) {
    return { status: 'blocked' as const, result: '这个冻结位置已经登记过机械构件', diff: {} };
  }
  const evidence = verifiedComponentEvidence(
    state, person, context.project, stackRef.stackId, planned.materialId,
  );
  if (!evidence) return { status: 'blocked' as const, result: '构件不是本项目中由本人真实制造并源绑定核验的成品', diff: {} };
  const observedMaterialId = voxelAt(
    state.world.grid, planned.position.x, planned.position.y, planned.position.z,
  );
  if (observedMaterialId !== Material.Air) {
    return {
      status: 'blocked' as const,
      result: '冻结安装位置已经被实体材料占用',
      diff: {
        mechanicalPowerSiteConflict: true,
        mode: 'install',
        projectId: context.project.id,
        planKey: basis.planKey,
        networkId: basis.networkId,
        sourceSegmentId: basis.sourceSegmentId,
        componentRole: planned.role,
        componentMaterialId: planned.materialId,
        componentPosition: { ...planned.position },
        observedMaterialId,
        componentManufactureEventId: evidence.manufacture.id,
        componentVerificationEventId: evidence.verification.id,
        conflictSourceEventIds: [
          evidence.manufacture.id,
          evidence.verification.id,
          context.observationEvent!.id,
        ],
        mechanicalPowerBasis: structuredClone(basis),
      },
    };
  }
  if (bodyOccupies(state, planned.position)) {
    return { status: 'blocked' as const, result: '冻结安装位置正被人物身体临时占用', diff: {} };
  }
  const supportMaterialId = voxelAt(
    state.world.grid, planned.position.x, planned.position.y, planned.position.z - 1,
  );
  const wheelAboveBoundCurrent = planned.role === 'converter'
    && supportMaterialId === Material.Water
    && context.plan.wheelPosition.z === planned.position.z
    && context.mechanicalPower.sources.find((source) => source.id === context.plan.sourceSegmentId)
      ?.requiredWaterVoxels.some((position) => position.x === planned.position.x
        && position.y === planned.position.y
        && position.z + 1 === planned.position.z);
  if (!wheelAboveBoundCurrent && materialDefinition(supportMaterialId).phase !== 'solid') {
    return { status: 'blocked' as const, result: '机械构件位置缺少实体承托', diff: {} };
  }
  const installationSourceEventIds = [
    evidence.manufacture.id,
    evidence.verification.id,
    context.observationEvent!.id,
  ];
  const network = ensureMechanicalPowerNetwork(context.mechanicalPower, context.plan);
  evidence.stack.quantity -= 1;
  removeEmptyStacks(person);
  setVoxel(state.world.grid, planned.position.x, planned.position.y, planned.position.z, planned.materialId);
  recordMechanicalPowerInstallation(network, {
    role: planned.role,
    materialId: planned.materialId,
    position: { ...planned.position },
    projectId: context.project.id,
    installedAtMonth: atMonth,
    installationEventId: eventId,
    sourceEventIds: installationSourceEventIds,
  });
  return {
    status: 'completed' as const,
    result: `在冻结位置安装了${materialDefinition(planned.materialId).name}`,
    diff: {
      mechanicalPowerInstallation: true,
      mode: 'install',
      projectId: context.project.id,
      planKey: basis.planKey,
      networkId: network.id,
      sourceSegmentId: basis.sourceSegmentId,
      componentRole: planned.role,
      componentMaterialId: planned.materialId,
      componentPosition: { ...planned.position },
      installationSourceEventIds,
      ...(planned.role === 'connector' && isMechanicalDriveShaftMaterial(planned.materialId) ? {
        shaftMaterialId: planned.materialId,
        shaftInstallationEventId: eventId,
        shaftInstallationSourceEventIds: installationSourceEventIds,
      } : {}),
      mechanicalPowerBasis: structuredClone(basis),
    },
  };
}

function reachableMechanicalWorkPosition(
  state: SimulationState,
  person: PersonState,
  target: MechanicalPowerProjectPlan['wheelPosition'],
  interactionRange: number,
): boolean {
  const targetCellId = cellId(target.x, target.y);
  return cellsInRadius(targetCellId, interactionRange)
    .flatMap((candidateCellId) => standingPositions(state.world.grid, candidateCellId))
    .filter((position) => position.cellId !== targetCellId)
    .some((position) => distanceToPosition({
      ...person,
      position: { ...person.position, cellId: position.cellId, z: position.z },
    }, target) <= interactionRange
      && findStandingPath(state.world.grid, person.position, position).length > 0);
}

function mechanicalReviseSite(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'act' }>,
  basis: Extract<MechanicalPowerActionBasis, { mode: 'revise-site' }>,
) {
  const context = mechanicalActionContext(state, person, basis, false);
  if ('blocked' in context) return { status: 'blocked' as const, result: context.blocked, diff: {} };
  const conflict = worldEventById(state, basis.conflictEventId);
  const conflictBasis = conflict?.kind === 'action' && conflict.action.kind === 'act'
    ? conflict.action.mechanicalPowerBasis
    : undefined;
  const conflictPosition = conflictBasis?.mode === 'install'
    ? conflictBasis.componentPosition
    : undefined;
  const conflictDiffPositionValue = conflict?.kind === 'action'
    ? conflict.diff.componentPosition
    : undefined;
  const conflictDiffPosition = isMechanicalVoxelPosition(conflictDiffPositionValue)
    ? conflictDiffPositionValue
    : undefined;
  const observedConflictMaterialId = conflict?.kind === 'action'
    ? Number(conflict.diff.observedMaterialId)
    : Number.NaN;
  const conflictManufactureEventId = conflict?.kind === 'action'
    && typeof conflict.diff.componentManufactureEventId === 'string'
    ? conflict.diff.componentManufactureEventId
    : undefined;
  const conflictVerificationEventId = conflict?.kind === 'action'
    && typeof conflict.diff.componentVerificationEventId === 'string'
    ? conflict.diff.componentVerificationEventId
    : undefined;
  const conflictSourceEventIds = conflict?.kind === 'action'
    && Array.isArray(conflict.diff.conflictSourceEventIds)
    && conflict.diff.conflictSourceEventIds.every((eventId) => typeof eventId === 'string')
    ? conflict.diff.conflictSourceEventIds
    : undefined;
  const conflictManufacture = conflictManufactureEventId
    ? worldEventById(state, conflictManufactureEventId)
    : undefined;
  const conflictVerification = conflictVerificationEventId
    ? worldEventById(state, conflictVerificationEventId)
    : undefined;
  const conflictObservation = conflictSourceEventIds?.[2]
    ? worldEventById(state, conflictSourceEventIds[2])
    : undefined;
  const conflictTarget = action.targets.find((target): target is Extract<WorldRef, { kind: 'voxel' }> => (
    target.kind === 'voxel'
  ));
  const revisedPlan = basis.revisedPlan;
  const priorPlan = context.plan;
  const currentNetworks = context.mechanicalPower.networks.filter((network) => (
    network.installationProjectId === context.project.id
  ));
  const conflictRange = conflictBasis?.mode === 'install' && conflictBasis.componentRole === 'converter' ? 2 : 1;
  if (conflict?.kind !== 'action'
    || conflict.status !== 'blocked'
    || !context.project.actionEventIds.includes(conflict.id)
    || !projectEventHasEventTimeLead(context.project, conflict)
    || conflictBasis?.mode !== 'install'
    || conflictBasis.projectId !== context.project.id
    || conflictBasis.planKey !== basis.planKey
    || conflictBasis.networkId !== basis.networkId
    || conflict.diff.mechanicalPowerSiteConflict !== true
    || conflict.diff.projectId !== context.project.id
    || conflict.diff.planKey !== basis.planKey
    || conflict.diff.componentRole !== conflictBasis.componentRole
    || Number(conflict.diff.componentMaterialId) !== conflictBasis.componentMaterialId
    || !conflictDiffPosition
    || !samePosition(conflictDiffPosition, conflictBasis.componentPosition)
    || !Number.isSafeInteger(observedConflictMaterialId)
    || observedConflictMaterialId === Material.Air
    || !conflictManufactureEventId
    || !conflictVerificationEventId
    || !conflictSourceEventIds
    || !sameIds(conflictSourceEventIds, [
      conflictManufactureEventId,
      conflictVerificationEventId,
      conflictSourceEventIds[2],
    ])
    || conflictManufacture?.kind !== 'action'
    || conflictManufacture.status !== 'completed'
    || conflictManufacture.who !== conflict.who
    || !context.project.actionEventIds.includes(conflictManufacture.id)
    || !projectEventHasEventTimeLead(context.project, conflictManufacture)
    || conflictManufacture.action.kind !== 'act'
    || conflictManufacture.action.operation !== 'combine'
    || Number(conflictManufacture.diff.outputMaterialId) !== conflictBasis.componentMaterialId
    || conflictVerification?.kind !== 'action'
    || conflictVerification.status !== 'completed'
    || conflictVerification.who !== conflict.who
    || !context.project.actionEventIds.includes(conflictVerification.id)
    || !projectEventHasEventTimeLead(context.project, conflictVerification)
    || conflictVerification.action.kind !== 'attend'
    || conflictVerification.diff.verifiedSourceEventId !== conflictManufacture.id
    || Number(conflictVerification.diff.verifiedMaterialId) !== conflictBasis.componentMaterialId
    || conflictObservation?.kind !== 'action'
    || conflictObservation.status !== 'completed'
    || conflictObservation.who !== conflict.who
    || !context.project.triggerFactIds.includes(conflictObservation.id)
    || !projectEventHasEventTimeLead(context.project, conflictObservation)
    || conflictObservation.action.kind !== 'attend'
    || conflictObservation.action.waterCurrentSegmentId !== priorPlan.sourceSegmentId
    || conflictObservation.diff.mechanicalPowerObservation !== true
    || !conflictPosition
    || !conflictTarget
    || !samePosition(conflictTarget.position, conflictPosition)
    || distanceToPosition(person, conflictPosition) > conflictRange
    || currentNetworks.some((network) => network.components.some((component) => (
      component.projectId === context.project.id
    )))
    || revisedPlan.version !== MECHANICAL_POWER_PLAN_VERSION
    || revisedPlan.projectId !== context.project.id
    || revisedPlan.sourceSegmentId !== priorPlan.sourceSegmentId
    || !sameIds(revisedPlan.sourceKeys, priorPlan.sourceKeys)
    || basis.revisedPlanKey !== mechanicalPowerPlanKey(revisedPlan)
    || basis.revisedNetworkId !== mechanicalPowerNetworkId(revisedPlan)
    || basis.revisedPlanKey === basis.planKey
    || !validateMechanicalPowerInstallationSite(
      state.world.grid, context.mechanicalPower, revisedPlan,
    ).valid) {
    return { status: 'blocked' as const, result: '机械改址没有绑定当前冲突、空白工地或同一局部水流计划', diff: {} };
  }
  const perceptionRadius = 4 + Math.floor(person.baselineCapacities.perception / 25);
  const visible = new Set(cellsInRadius(person.position.cellId, perceptionRadius));
  const revisedPositions = [
    revisedPlan.wheelPosition,
    ...revisedPlan.shaftPositions,
    revisedPlan.loadPosition,
  ];
  const contributionStanding = standingPositions(
    state.world.grid, basis.contributionSite.cellId,
  ).some((position) => position.z === basis.contributionSite.z);
  const contributionPosition = {
    cellId: basis.contributionSite.cellId,
    z: basis.contributionSite.z,
  };
  if (revisedPositions.some((position) => !visible.has(cellId(position.x, position.y))
    || bodyOccupies(state, position))
    || !reachableMechanicalWorkPosition(state, person, revisedPlan.wheelPosition, 2)
    || revisedPlan.shaftPositions.some((position) => !reachableMechanicalWorkPosition(
      state, person, position, 1,
    ))
    || !reachableMechanicalWorkPosition(state, person, revisedPlan.loadPosition, 1)
    || !contributionStanding
    || basis.contributionSite.cellId === cellId(revisedPlan.loadPosition.x, revisedPlan.loadPosition.y)
    || distanceToPosition({
      ...person,
      position: { ...person.position, ...contributionPosition },
    }, revisedPlan.loadPosition) > 1
    || findStandingPath(state.world.grid, person.position, contributionPosition).length === 0) {
    return { status: 'blocked' as const, result: '机械改址的当前可见性、可达工位或实体空闲条件已经失效', diff: {} };
  }
  context.project.mechanicalPowerPlan = structuredClone(revisedPlan);
  context.project.mechanicalPowerPlanKey = basis.revisedPlanKey;
  context.project.mechanicalPowerNetworkId = basis.revisedNetworkId;
  return {
    status: 'completed' as const,
    result: '依据真实实体占位冲突重新标定了同一机械项目的安装工地',
    diff: {
      mechanicalPowerPlanRevision: true,
      projectId: context.project.id,
      conflictEventId: conflict.id,
      priorPlanKey: basis.planKey,
      priorNetworkId: basis.networkId,
      revisedPlanKey: basis.revisedPlanKey,
      revisedNetworkId: basis.revisedNetworkId,
      priorPlan: structuredClone(priorPlan),
      revisedPlan: structuredClone(revisedPlan),
      candidateWorkSite: { ...basis.contributionSite },
      mechanicalPowerBasis: structuredClone(basis),
    },
  };
}

function exactNetworkComponentsInstalled(
  network: MechanicalPowerNetworkState,
  plan: MechanicalPowerProjectPlan,
): boolean {
  const planned = plannedMechanicalPowerComponents(plan);
  return planned.every((candidate) => network.components.some((component) => component.role === candidate.role
    && (candidate.role === 'connector'
      ? isMechanicalDriveShaftMaterial(component.materialId)
      : component.materialId === candidate.materialId)
    && component.projectId === plan.projectId
    && samePosition(component.position, candidate.position)));
}

function recordMechanicalOperationKnowledge(person: PersonState, eventId: string, atMonth: number): void {
  const known = person.knowledge.find((fact) => fact.id === MECHANICAL_POWER_OPERATION_TECHNIQUE_ID
    && fact.kind === 'technique');
  if (known) {
    known.confidence = clamp(Math.max(known.confidence, 60) + 8);
    known.sourceEventIds = [...new Set([...known.sourceEventIds, eventId])].slice(-24);
    return;
  }
  person.knowledge.push({
    id: MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
    kind: 'technique',
    summary: '让流水经水轮和传动轴驱动磨坊完成有输入有输出的负载作业',
    confidence: 68,
    learnedAtMonth: atMonth,
    sourceEventIds: [eventId],
  });
}

function mechanicalOperate(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'act' }>,
  basis: Extract<MechanicalPowerActionBasis, { mode: 'operate' | 'operate-service' }>,
  atMonth: number,
  eventId: string,
) {
  const context = basis.mode === 'operate'
    ? mechanicalActionContext(state, person, basis, true)
    : mechanicalServiceActionContext(state, person, basis, true);
  if ('blocked' in context) return {
    status: 'blocked' as const,
    result: context.blocked,
    diff: context.currentUnavailable ? {
      mechanicalPowerCurrentUnavailable: true,
      mode: basis.mode,
      projectId: basis.mode === 'operate' ? basis.projectId : basis.maintenanceProjectId,
      installationProjectId: basis.mode === 'operate' ? basis.projectId : basis.installationProjectId,
      planKey: basis.planKey,
      networkId: basis.networkId,
      sourceSegmentId: basis.sourceSegmentId,
      currentAvailabilityReason: context.currentUnavailable.reason,
      mechanicalPowerBasis: structuredClone(basis),
    } : {},
  };
  const network = context.network;
  const inputRef = action.targets.find((target): target is Extract<WorldRef, { kind: 'inventory-stack' }> => target.kind === 'inventory-stack');
  const loadRef = action.targets.find((target): target is Extract<WorldRef, { kind: 'voxel' }> => target.kind === 'voxel');
  const input = inputRef?.personId === person.id
    ? person.inventory.find((stack) => stack.id === inputRef.stackId
      && stack.materialId === Material.Seed
      && stack.quantity > 0
      && !stack.recordPayloadId)
    : undefined;
  if (basis.inputMaterialId !== Material.Seed || basis.outputMaterialId !== Material.Food
    || !loadRef || !samePosition(loadRef.position, context.plan.loadPosition)
    || distanceToPosition(person, context.plan.loadPosition) > 1
    || !input) {
    return { status: 'blocked' as const, result: '动力磨坊缺少精确负载位置或真实种子输入', diff: {} };
  }
  if (!network || !exactNetworkComponentsInstalled(network, context.plan)) {
    return { status: 'blocked' as const, result: '机械网络尚未完整安装', diff: {} };
  }
  if (network.fault) return { status: 'blocked' as const, result: '机械网络仍有未修复故障', diff: {} };
  const topology = validateMechanicalPowerTopology(state.world.grid, context.mechanicalPower, context.plan);
  if (!topology.valid) return {
    status: 'blocked' as const,
    result: `机械拓扑实时复核失败：${topology.reason ?? 'unknown'}`,
    diff: { topologyReason: topology.reason },
  };
  const shaft = loadedDriveShaft(state, network, context.plan);
  if (!shaft) {
    return { status: 'blocked' as const, result: '机械网络的轴材与安装来源不一致', diff: {} };
  }
  if (basis.mode === 'operate' && network.faultCount === 0 && network.operationCount === 0) {
    const brokenPosition = shaft.component.position;
    const faultSourceEventIds = [...network.installationEventIds, context.observationEvent!.id];
    const frozenFaultEvidence = faultEvidenceFor(network, shaft);
    setVoxel(state.world.grid, brokenPosition.x, brokenPosition.y, brokenPosition.z, Material.BrokenDriveShaft);
    recordMechanicalPowerFault(network, {
      kind: 'commissioning-misalignment',
      componentRole: 'connector',
      componentPosition: { ...brokenPosition },
      atMonth,
      faultEventId: eventId,
      sourceEventIds: faultSourceEventIds,
      ...frozenFaultEvidence,
    });
    return {
      status: 'progressed' as const,
      result: '首次试运转暴露出传动轴校准故障，种子尚未投入',
      diff: {
        mechanicalPowerFault: true,
        mode: 'operate',
        projectId: context.project.id,
        planKey: basis.planKey,
        networkId: network.id,
        sourceSegmentId: basis.sourceSegmentId,
        faultKind: 'commissioning-misalignment',
        faultEventId: eventId,
        componentRole: 'connector',
        componentPosition: { ...brokenPosition },
        shaftMaterialId: shaft.materialId,
        shaftInstallationEventId: shaft.component.installationEventId,
        shaftInstallationSourceEventIds: shaft.component.sourceEventIds
          .slice(-MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT),
        ...(shaft.component.latestRepairEventId ? { shaftRepairEventId: shaft.component.latestRepairEventId } : {}),
        ...(shaft.component.latestRepairSourceEventIds?.length ? {
          shaftRepairSourceEventIds: shaft.component.latestRepairSourceEventIds
            .slice(-MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT),
        } : {}),
        wearApplied: 0,
        serviceLoadedOperationCount: frozenFaultEvidence.serviceLoadedOperationCount,
        faultProofEventIds: frozenFaultEvidence.proofEventIds,
        inputPreserved: true,
        inputMaterialId: input.materialId,
        inputStackId: input.id,
        inputQuantityBefore: input.quantity,
        inputQuantityAfter: input.quantity,
        mechanicalPowerBasis: structuredClone(basis),
      },
    };
  }
  if (basis.mode === 'operate-service' && network.condition <= MECHANICAL_POWER_WORN_FAULT_THRESHOLD) {
    const brokenPosition = shaft.component.position;
    const wearSourceEventIds = (network.serviceCycleOperationEventIds ?? []).slice(-3);
    const frozenFaultEvidence = faultEvidenceFor(network, shaft);
    recordMechanicalPowerFault(network, {
      kind: 'worn-drive-shaft',
      componentRole: 'connector',
      componentPosition: { ...brokenPosition },
      atMonth,
      faultEventId: eventId,
      sourceEventIds: wearSourceEventIds,
      ...frozenFaultEvidence,
    }, person.id);
    setVoxel(state.world.grid, brokenPosition.x, brokenPosition.y, brokenPosition.z, Material.BrokenDriveShaft);
    return {
      status: 'completed' as const,
      result: '累积负载磨损在本次投入前暴露为传动轴断裂，种子尚未投入',
      diff: {
        mechanicalPowerFault: true,
        mode: basis.mode,
        projectId: context.project.id,
        installationProjectId: context.installationProject.id,
        planKey: basis.planKey,
        networkId: network.id,
        sourceSegmentId: basis.sourceSegmentId,
        faultKind: 'worn-drive-shaft',
        faultEventId: eventId,
        componentRole: 'connector',
        componentPosition: { ...brokenPosition },
        shaftMaterialId: shaft.materialId,
        shaftInstallationEventId: shaft.component.installationEventId,
        shaftInstallationSourceEventIds: shaft.component.sourceEventIds
          .slice(-MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT),
        ...(shaft.component.latestRepairEventId ? { shaftRepairEventId: shaft.component.latestRepairEventId } : {}),
        ...(shaft.component.latestRepairSourceEventIds?.length ? {
          shaftRepairSourceEventIds: shaft.component.latestRepairSourceEventIds
            .slice(-MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT),
        } : {}),
        wearApplied: 0,
        serviceLoadedOperationCount: frozenFaultEvidence.serviceLoadedOperationCount,
        faultProofEventIds: frozenFaultEvidence.proofEventIds,
        conditionBefore: network.condition,
        conditionAfter: network.condition,
        wearSourceEventIds,
        inputPreserved: true,
        inputMaterialId: input.materialId,
        inputStackId: input.id,
        inputQuantityBefore: input.quantity,
        inputQuantityAfter: input.quantity,
        mechanicalPowerBasis: structuredClone(basis),
      },
    };
  }
  const currentRepair = currentShaftRepairFact(state, network, shaft);
  if (!currentRepair) {
    return { status: 'blocked' as const, result: '机械网络没有可回放的修复事实', diff: {} };
  }
  const inputStackId = input.id;
  const inputSourceEventIds = [...input.sourceEventIds];
  const inputSourceLineageKeys = [...(input.sourceLineageKeys ?? [])];
  input.quantity -= 1;
  removeEmptyStacks(person);
  const outputQuantity = 3;
  const output = addInventory(
    person,
    Material.Food,
    outputQuantity,
    [
      eventId,
      currentRepair.id,
      ...(shaft.component.latestRepairSourceEventIds ?? []),
      ...inputSourceEventIds,
    ],
    `stack-${person.id}-${Material.Food}-${eventId}`,
    undefined,
    [`mechanical-network:${network.id}`, `input-stack:${inputStackId}`, ...inputSourceLineageKeys],
  );
  const conditionBefore = network.condition;
  const operationRecord = recordMechanicalPowerOperation(network, eventId, shaft.materialId);
  recordMechanicalOperationKnowledge(person, eventId, atMonth);
  return {
    status: 'completed' as const,
    result: `流水驱动磨坊把种子处理为食物 × ${outputQuantity}`,
    diff: {
      mechanicalPowerOperation: true,
      mode: basis.mode,
      projectId: context.project.id,
      installationProjectId: context.installationProject.id,
      planKey: basis.planKey,
      networkId: network.id,
      sourceSegmentId: basis.sourceSegmentId,
      inputMaterialId: Material.Seed,
      inputStackId,
      inputSourceEventIds,
      inputSourceLineageKeys,
      outputMaterialId: Material.Food,
      outputStackId: output.id,
      outputQuantity,
      conditionBefore,
      conditionAfter: network.condition,
      shaftMaterialId: shaft.materialId,
      shaftInstallationEventId: shaft.component.installationEventId,
      ...(shaft.component.latestRepairEventId ? { shaftRepairEventId: shaft.component.latestRepairEventId } : {}),
      shaftInstallationSourceEventIds: shaft.component.sourceEventIds.slice(-MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT),
      ...(shaft.component.latestRepairSourceEventIds?.length ? {
        shaftRepairSourceEventIds: shaft.component.latestRepairSourceEventIds
          .slice(-MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT),
      } : {}),
      wearApplied: operationRecord.wearApplied,
      serviceLoadedOperationOrdinal: operationRecord.serviceLoadedOperationOrdinal,
      operationKnowledgeId: MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
      repairEventIds: [currentRepair.id],
      ...(basis.mode === 'operate-service' && basis.maintenanceProjectId ? {
        mechanicalPowerRecovery: true,
        maintenanceProjectId: basis.maintenanceProjectId,
        recoveryRepairEventId: basis.recoveryRepairEventId,
      } : {}),
      supportingSegmentIds: [...context.supportingSegmentIds],
      mechanicalPowerBasis: structuredClone(basis),
    },
  };
}

function repairTopologyMatchesFault(
  state: SimulationState,
  plan: MechanicalPowerProjectPlan,
  network: MechanicalPowerNetworkState,
): boolean {
  if (!network.fault || !exactNetworkComponentsInstalled(network, plan)) return false;
  if (voxelAt(state.world.grid, plan.wheelPosition.x, plan.wheelPosition.y, plan.wheelPosition.z) !== Material.WaterWheel
    || voxelAt(state.world.grid, plan.loadPosition.x, plan.loadPosition.y, plan.loadPosition.z) !== Material.Mill) return false;
  return plan.shaftPositions.every((position) => {
    const component = driveShaftComponentAt(network, plan, position);
    if (!component) return false;
    if (samePosition(position, network.fault!.componentPosition)) {
      return voxelAt(state.world.grid, position.x, position.y, position.z) === Material.BrokenDriveShaft
        && component.materialId === (network.fault!.failedComponentMaterialId ?? component.materialId);
    }
    return voxelAt(state.world.grid, position.x, position.y, position.z) === component.materialId
      && isMechanicalDriveShaftMaterial(component.materialId);
  });
}

function mechanicalRepair(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'act' }>,
  basis: Extract<MechanicalPowerActionBasis, { mode: 'repair' | 'repair-service' }>,
  eventId: string,
) {
  const context = basis.mode === 'repair'
    ? mechanicalActionContext(state, person, basis, false)
    : mechanicalServiceActionContext(state, person, basis, false);
  if ('blocked' in context) return { status: 'blocked' as const, result: context.blocked, diff: {} };
  const network = context.network;
  const fault = network?.fault;
  const faultEvent = fault ? worldEventById(state, fault.faultEventId) : undefined;
  const replacementRef = action.targets.find((target): target is Extract<WorldRef, { kind: 'inventory-stack' }> => target.kind === 'inventory-stack');
  const faultRef = action.targets.find((target): target is Extract<WorldRef, { kind: 'voxel' }> => target.kind === 'voxel');
  const tool = action.toolStackId ? person.inventory.find((stack) => stack.id === action.toolStackId
    && stack.materialId === Material.BronzeTool
    && stack.quantity > 0
    && !stack.recordPayloadId) : undefined;
  const replacementSpecification = mechanicalDriveShaftSpecification(basis.replacementMaterialId);
  const steelUpgrade = basis.replacementMaterialId === Material.SteelDriveShaft;
  const exactReplacementEvidence = basis.replacementManufactureEventId
    && basis.replacementVerificationEventId
    ? {
      manufactureEventId: basis.replacementManufactureEventId,
      verificationEventId: basis.replacementVerificationEventId,
    }
    : undefined;
  if (!network || !fault || fault.faultEventId !== basis.faultEventId
    || faultEvent?.kind !== 'action'
    || network.recentRepairEventIds.includes(eventId)
    || !replacementSpecification
    || (steelUpgrade && (basis.mode !== 'repair-service' || !exactReplacementEvidence))
    || ((basis.replacementManufactureEventId || basis.replacementVerificationEventId) && !exactReplacementEvidence)
    || basis.toolMaterialId !== Material.BronzeTool
    || !faultRef || !samePosition(faultRef.position, fault.componentPosition)
    || distanceToPosition(person, fault.componentPosition) > 1
    || !replacementRef || replacementRef.personId !== person.id
    || !tool
    || voxelAt(state.world.grid, fault.componentPosition.x, fault.componentPosition.y, fault.componentPosition.z) !== Material.BrokenDriveShaft
    || !repairTopologyMatchesFault(state, context.plan, network)) {
    return { status: 'blocked' as const, result: '修复所需的故障、替换件、工具或精确位置不再一致', diff: {} };
  }
  const evidence = verifiedComponentEvidence(
    state,
    person,
    context.project,
    replacementRef.stackId,
    replacementSpecification.materialId,
    faultEvent,
    exactReplacementEvidence,
  );
  if (!evidence) return { status: 'blocked' as const, result: '替换传动轴不是故障之后由本人制造并核验的构件', diff: {} };
  const repairSourceEventIds = [fault.faultEventId, evidence.manufacture.id, evidence.verification.id, ...tool.sourceEventIds];
  evidence.stack.quantity -= 1;
  removeEmptyStacks(person);
  setVoxel(
    state.world.grid,
    fault.componentPosition.x,
    fault.componentPosition.y,
    fault.componentPosition.z,
    replacementSpecification.materialId,
  );
  recordMechanicalPowerRepair(network, eventId, repairSourceEventIds, {
    componentPosition: { ...fault.componentPosition },
    replacementMaterialId: replacementSpecification.materialId,
    manufactureEventId: evidence.manufacture.id,
    verificationEventId: evidence.verification.id,
  });
  const repairedComponent = driveShaftComponentAt(network, context.plan, fault.componentPosition);
  return {
    status: 'completed' as const,
    result: replacementSpecification.materialId === Material.DriveShaft
      ? '用新传动轴和青铜工具修复了机械网络'
      : `用新${materialDefinition(replacementSpecification.materialId).name}和青铜工具修复了机械网络`,
    diff: {
      mechanicalPowerRepair: true,
      mode: basis.mode,
      projectId: context.project.id,
      installationProjectId: context.installationProject.id,
      planKey: basis.planKey,
      networkId: network.id,
      sourceSegmentId: basis.sourceSegmentId,
      faultEventId: basis.faultEventId,
      replacementMaterialId: replacementSpecification.materialId,
      replacementStackId: replacementRef.stackId,
      replacementManufactureEventId: evidence.manufacture.id,
      replacementVerificationEventId: evidence.verification.id,
      toolMaterialId: Material.BronzeTool,
      toolStackId: tool.id,
      repairSourceEventIds,
      repairEventIds: [eventId],
      faultShaftMaterialId: fault.failedComponentMaterialId,
      shaftMaterialId: replacementSpecification.materialId,
      shaftInstallationEventId: repairedComponent?.installationEventId
        ?? fault.failedComponentInstallationEventId,
      shaftRepairEventId: eventId,
      shaftInstallationSourceEventIds: repairedComponent?.sourceEventIds
        .slice(-MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT) ?? [],
      shaftRepairSourceEventIds: repairedComponent?.latestRepairSourceEventIds
        ?.slice(-MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT) ?? repairSourceEventIds
          .slice(-MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT),
      wearApplied: 0,
      serviceLoadedOperationCountAfter: 0,
      repairCount: network.repairCount,
      mechanicalPowerBasis: structuredClone(basis),
    },
  };
}

export function executeMechanicalPowerAction(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'act' }>,
  atMonth: number,
  eventId: string,
) {
  const basis = action.mechanicalPowerBasis;
  if (!basis || action.operation !== 'exert') {
    return { status: 'blocked' as const, result: '机械动力只能通过带版本依据的通用施力动作执行', diff: {} };
  }
  if (basis.mode === 'install') return mechanicalInstall(state, person, action, basis, atMonth, eventId);
  if (basis.mode === 'revise-site') return mechanicalReviseSite(state, person, action, basis);
  if (basis.mode === 'operate' || basis.mode === 'operate-service') {
    return mechanicalOperate(state, person, action, basis, atMonth, eventId);
  }
  if (basis.mode === 'repair' || basis.mode === 'repair-service') {
    return mechanicalRepair(state, person, action, basis, eventId);
  }
  return { status: 'blocked' as const, result: '观察水流必须使用指向当前水体的观察动作', diff: {} };
}
