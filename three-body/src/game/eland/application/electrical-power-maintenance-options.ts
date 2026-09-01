import type { ActionOption, PrimitiveAction, WorldRef } from '../domain/action';
import {
  ELECTRICAL_POWER_ACTION_BASIS_VERSION,
  ELECTRICAL_POWER_WORLD_VERSION,
  electricalPowerFaultObservationFactId,
  electricalPowerPlanKey,
  sameElectricalPosition,
  validateElectricalPowerTopology,
  type ElectricalPowerNetworkState,
  type ElectricalPowerPlan,
  type ElectricalVoxelPosition,
} from '../domain/electrical-power';
import { worldEventById } from '../domain/event-index';
import {
  inventoryCombinationForOutput,
  inventoryCombinationTechniqueId,
  type InventoryCombinationRule,
} from '../domain/interaction-rules';
import { Material, materialDefinition, type MaterialId } from '../domain/material';
import type { ActionFact, SimulationState } from '../domain/model';
import type { ItemStack, PersonState } from '../domain/person';
import type {
  ElectricalPowerMaintenanceBasis,
  ProjectReservation,
  ProjectState,
} from '../domain/project';
import {
  cellId,
  cellX,
  cellY,
  cellsInRadius,
  findStandingPath,
  standingPositions,
  voxelAt,
  type StandingPosition,
} from '../world/grid';
import { personalMechanicalServiceEventForElectricalPlan } from '../domain/actions/electrical-power-actions';

const ELECTRICAL_MAINTENANCE_PROJECT_EVENT_LIMIT = 16;
const ELECTRICAL_MAINTENANCE_SOURCE_LIMIT = 12;

export interface ElectricalPowerMaintenanceProposalCandidate {
  installationProject: ProjectState;
  plan: ElectricalPowerPlan;
  network: ElectricalPowerNetworkState;
  faultEvent: ActionFact;
  diagnosisEvent: ActionFact;
  diagnosisKnowledgeId: string;
  basis: ElectricalPowerMaintenanceBasis;
  contributionSite: StandingPosition;
}

export interface ElectricalPowerMaintenanceProjectStep {
  key: string;
  summary: string;
  reason: string;
  action: PrimitiveAction;
  target?: WorldRef;
  sourceFactIds: string[];
  missingMaterialIds: MaterialId[];
  reservations: ProjectReservation[];
  planKnowledgeId?: string;
}

export interface ElectricalPowerMaintenanceMaterialRequirement {
  materialIds: MaterialId[];
  sourceFactIds: string[];
  planKnowledgeId?: string;
}

function uniqueBounded(ids: Iterable<string>, limit = ELECTRICAL_MAINTENANCE_SOURCE_LIMIT): string[] {
  return [...new Set([...ids].filter(Boolean))].slice(-limit);
}

function actionOrder(left: ActionFact, right: ActionFact): number {
  return left.atMonth - right.atMonth
    || (left.planningTick ?? 0) - (right.planningTick ?? 0)
    || (left.orderInTick ?? left.orderInMonth) - (right.orderInTick ?? right.orderInMonth)
    || left.orderInMonth - right.orderInMonth
    || left.id.localeCompare(right.id);
}

function actionAfter(candidate: ActionFact, basis: ActionFact): boolean {
  return actionOrder(candidate, basis) > 0;
}

function completedElectricalProjectForNetwork(
  state: SimulationState,
  network: ElectricalPowerNetworkState,
): ProjectState | null {
  return state.projects.find((project) => project.status === 'completed'
    && project.desiredFunction === 'remote-work-power-delivery'
    && project.electricalPowerNetworkId === network.id
    && project.electricalPowerPlanKey === network.planKey
    && project.electricalPowerPlan
    && electricalPowerPlanKey(project.electricalPowerPlan) === network.planKey) ?? null;
}

function currentElectricalFaultEvent(
  state: SimulationState,
  network: ElectricalPowerNetworkState,
): ActionFact | null {
  if (!network.fault) return null;
  const event = worldEventById(state, network.fault.faultEventId);
  return event?.kind === 'action'
    && event.status === 'completed'
    && event.diff.electricalPowerFault === true
    && event.diff.electricalNetworkId === network.id
    && event.diff.electricalPlanKey === network.planKey
    && event.diff.faultEventId === network.fault.faultEventId
    ? event
    : null;
}

function electricalDiagnosisEventMatches(
  person: PersonState,
  network: ElectricalPowerNetworkState,
  faultEvent: ActionFact,
  event: ActionFact,
): boolean {
  return event.status === 'completed'
    && event.who === person.id
    && event.action.kind === 'attend'
    && event.action.electricalPowerFaultObservation?.networkId === network.id
    && event.action.electricalPowerFaultObservation.faultEventId === faultEvent.id
    && event.diff.electricalPowerFaultDiagnosis === true
    && event.diff.electricalNetworkId === network.id
    && event.diff.faultEventId === faultEvent.id
    && actionAfter(event, faultEvent);
}

function personalElectricalFaultDiagnosis(
  state: SimulationState,
  person: PersonState,
  network: ElectricalPowerNetworkState,
  faultEvent: ActionFact,
): { knowledgeId: string; diagnosisEvent: ActionFact } | null {
  const knowledgeId = electricalPowerFaultObservationFactId(network.id, faultEvent.id);
  const knowledge = person.knowledge.find((fact) => fact.id === knowledgeId
    && fact.kind === 'observation'
    && fact.confidence >= 55);
  if (!knowledge) return null;
  for (const eventId of [...knowledge.sourceEventIds].reverse().slice(0, 8)) {
    const event = worldEventById(state, eventId);
    if (event?.kind === 'action'
      && electricalDiagnosisEventMatches(person, network, faultEvent, event)) {
      return { knowledgeId, diagnosisEvent: event };
    }
  }
  return null;
}

function maintenanceBasisKey(
  personId: string,
  installationProjectId: string,
  networkId: string,
  planKey: string,
  faultEventId: string,
  diagnosisEventId: string,
): string {
  return [
    'electrical-power-maintenance-basis-v1',
    `observer=${personId}`,
    `installation=${installationProjectId}`,
    `network=${networkId}`,
    `plan=${planKey}`,
    `fault=${faultEventId}`,
    `diagnosis=${diagnosisEventId}`,
  ].join('|');
}

function basisFor(
  person: PersonState,
  installationProject: ProjectState,
  network: ElectricalPowerNetworkState,
  faultEvent: ActionFact,
  diagnosisEvent: ActionFact,
  atMonth: number,
): ElectricalPowerMaintenanceBasis {
  return {
    version: 'electrical-power-maintenance-basis-v1',
    observerId: person.id,
    installationProjectId: installationProject.id,
    networkId: network.id,
    planKey: network.planKey,
    faultEventId: faultEvent.id,
    diagnosisEventId: diagnosisEvent.id,
    componentPosition: { ...network.fault!.componentPosition },
    atMonth,
    sourceFactIds: [faultEvent.id, diagnosisEvent.id],
    basisKey: maintenanceBasisKey(
      person.id,
      installationProject.id,
      network.id,
      network.planKey,
      faultEvent.id,
      diagnosisEvent.id,
    ),
  };
}

export function validateElectricalPowerMaintenanceBasis(
  state: SimulationState,
  person: PersonState,
  basis: ElectricalPowerMaintenanceBasis,
): boolean {
  if (basis.version !== 'electrical-power-maintenance-basis-v1'
    || basis.observerId !== person.id
    || basis.sourceFactIds.length !== 2
    || basis.sourceFactIds[0] !== basis.faultEventId
    || basis.sourceFactIds[1] !== basis.diagnosisEventId) return false;
  const network = state.world.electricalPower?.version === ELECTRICAL_POWER_WORLD_VERSION
    ? state.world.electricalPower.networks.find((candidate) => candidate.id === basis.networkId
      && candidate.planKey === basis.planKey
      && electricalPowerPlanKey(candidate.plan) === basis.planKey)
    : undefined;
  const installationProject = network ? completedElectricalProjectForNetwork(state, network) : null;
  const faultEvent = network ? currentElectricalFaultEvent(state, network) : null;
  const diagnosis = network && faultEvent
    ? personalElectricalFaultDiagnosis(state, person, network, faultEvent)
    : null;
  return Boolean(network
    && installationProject?.id === basis.installationProjectId
    && network.fault
    && network.fault.kind === 'overload-open-circuit'
    && network.fault.faultEventId === basis.faultEventId
    && sameElectricalPosition(network.fault.componentPosition, basis.componentPosition)
    && voxelAt(
      state.world.grid,
      basis.componentPosition.x,
      basis.componentPosition.y,
      basis.componentPosition.z,
    ) === Material.BrokenCopperConductor
    && validateElectricalPowerTopology(state.world.grid, network, true).valid
    && diagnosis?.diagnosisEvent.id === basis.diagnosisEventId
    && basis.atMonth >= diagnosis.diagnosisEvent.atMonth
    && basis.basisKey === maintenanceBasisKey(
      person.id,
      installationProject.id,
      network.id,
      network.planKey,
      faultEvent!.id,
      diagnosis.diagnosisEvent.id,
    ));
}

function targetApproach(
  state: SimulationState,
  person: PersonState,
  target: ElectricalVoxelPosition,
): StandingPosition | null {
  const candidates = cellsInRadius(cellId(target.x, target.y), 1)
    .flatMap((candidateCellId) => standingPositions(state.world.grid, candidateCellId))
    .filter((position) => {
      if (position.cellId === cellId(target.x, target.y) && position.z === target.z) return false;
      const horizontal = Math.abs(cellX(position.cellId) - target.x)
        + Math.abs(cellY(position.cellId) - target.y);
      const vertical = Math.max(0, Math.abs(position.z - target.z) - 1);
      return horizontal + vertical <= 1;
    })
    .map((position) => ({
      position,
      path: position.cellId === person.position.cellId && position.z === person.position.z
        ? [position]
        : findStandingPath(state.world.grid, person.position, position),
    }))
    .filter((candidate) => candidate.path.length > 0)
    .sort((left, right) => left.path.length - right.path.length
      || left.position.cellId - right.position.cellId
      || left.position.z - right.position.z);
  return candidates[0]?.position ?? null;
}

export function buildElectricalPowerMaintenanceOptions(
  state: SimulationState,
  person: PersonState,
  visibleCells: number[],
): ActionOption[] {
  const visible = new Set(visibleCells);
  const world = state.world.electricalPower;
  if (world?.version !== ELECTRICAL_POWER_WORLD_VERSION) return [];
  return world.networks.flatMap((network) => {
    const installationProject = completedElectricalProjectForNetwork(state, network);
    const faultEvent = currentElectricalFaultEvent(state, network);
    const fault = network.fault;
    if (!installationProject || !faultEvent || !fault
      || personalElectricalFaultDiagnosis(state, person, network, faultEvent)
      || !visible.has(cellId(fault.componentPosition.x, fault.componentPosition.y))
      || voxelAt(state.world.grid, fault.componentPosition.x, fault.componentPosition.y, fault.componentPosition.z)
        !== Material.BrokenCopperConductor
      || !validateElectricalPowerTopology(state.world.grid, network, true).valid) return [];
    const factId = electricalPowerFaultObservationFactId(network.id, faultEvent.id);
    return [{
      id: `diagnose-electrical-fault:${network.id}:${faultEvent.id}`,
      summary: '近身检查完成电网中熔断的实体铜导体',
      reason: '眼前断路仍与当前故障事实一致；观察只形成本人诊断，不自动修理',
      goal: { kind: 'knowledge' as const, factId, minConfidence: 55 },
      nextAction: {
        kind: 'attend' as const,
        target: { kind: 'voxel' as const, position: { ...fault.componentPosition } },
        electricalPowerFaultObservation: {
          version: 'electrical-power-fault-observation-v1' as const,
          installationProjectId: installationProject.id,
          planKey: network.planKey,
          networkId: network.id,
          faultEventId: faultEvent.id,
        },
      },
      target: { kind: 'voxel' as const, position: { ...fault.componentPosition } },
      estimatedDuration: 'one-month' as const,
      sourceFactIds: uniqueBounded([faultEvent.id, ...fault.sourceEventIds]),
      domain: 'strategic' as const,
    }];
  }).sort((left, right) => left.id.localeCompare(right.id)).slice(0, 2);
}

export function electricalPowerMaintenanceProposalCandidate(
  state: SimulationState,
  person: PersonState,
  visibleCells: number[],
  atMonth = state.clock.elapsedMonths + 1,
): ElectricalPowerMaintenanceProposalCandidate | null {
  const visible = new Set(visibleCells);
  const world = state.world.electricalPower;
  if (world?.version !== ELECTRICAL_POWER_WORLD_VERSION) return null;
  const candidates = world.networks.flatMap((network) => {
    const installationProject = completedElectricalProjectForNetwork(state, network);
    const plan = installationProject?.electricalPowerPlan;
    const faultEvent = currentElectricalFaultEvent(state, network);
    const diagnosis = faultEvent ? personalElectricalFaultDiagnosis(state, person, network, faultEvent) : null;
    const faultPosition = network.fault?.componentPosition;
    if (!installationProject || !plan || !faultEvent || !diagnosis || !faultPosition
      || !visible.has(cellId(faultPosition.x, faultPosition.y))
      || voxelAt(state.world.grid, faultPosition.x, faultPosition.y, faultPosition.z)
        !== Material.BrokenCopperConductor
      || !validateElectricalPowerTopology(state.world.grid, network, true).valid) return [];
    const contributionSite = targetApproach(state, person, faultPosition);
    if (!contributionSite) return [];
    const basis = basisFor(
      person,
      installationProject,
      network,
      faultEvent,
      diagnosis.diagnosisEvent,
      atMonth,
    );
    return validateElectricalPowerMaintenanceBasis(state, person, basis) ? [{
      installationProject,
      plan,
      network,
      faultEvent,
      diagnosisEvent: diagnosis.diagnosisEvent,
      diagnosisKnowledgeId: diagnosis.knowledgeId,
      basis,
      contributionSite,
    }] : [];
  }).sort((left, right) => actionOrder(left.faultEvent, right.faultEvent)
    || left.network.id.localeCompare(right.network.id));
  return candidates[0] ?? null;
}

export function electricalPowerMaintenancePressure(basis: ElectricalPowerMaintenanceBasis): number {
  return Math.min(100, 24 + basis.sourceFactIds.length * 24);
}

function reliableConductorRecipeBasis(
  state: SimulationState,
  person: PersonState,
): { rule: InventoryCombinationRule; knowledgeId: string; sourceFactIds: string[] } | null {
  const rule = inventoryCombinationForOutput(Material.CopperConductor);
  if (!rule) return null;
  const knowledgeId = inventoryCombinationTechniqueId(rule);
  const knowledge = person.knowledge.find((fact) => fact.kind === 'technique'
    && fact.id === knowledgeId
    && fact.confidence >= 55);
  if (!knowledge) return null;
  const sources = [...knowledge.sourceEventIds].reverse().slice(0, 24).flatMap((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action' && event.who === person.id ? [event] : [];
  });
  const response = sources.find((fact) => fact.status === 'completed'
    && fact.action.kind === 'act'
    && fact.action.operation === 'combine'
    && Number(fact.diff.outputMaterialId) === Material.CopperConductor
    && fact.diff.techniqueId === knowledgeId
    && fact.diff.projectHypothesisOutcome === 'response'
    && fact.diff.projectHypothesisHadReliableKnowledge === false);
  const verification = response && sources.find((fact) => fact.status === 'completed'
    && fact.action.kind === 'attend'
    && fact.diff.verifiedTechnique === true
    && fact.diff.verifiedSourceEventId === response.id
    && fact.diff.factId === knowledgeId
    && Number(fact.diff.verifiedMaterialId) === Material.CopperConductor
    && actionAfter(fact, response));
  return response && verification ? {
    rule,
    knowledgeId,
    sourceFactIds: [response.id, verification.id],
  } : null;
}

function projectContract(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): { plan: ElectricalPowerPlan; network: ElectricalPowerNetworkState; faultEvent: ActionFact } | null {
  const basis = project.electricalPowerMaintenanceBasis;
  const plan = project.electricalPowerPlan;
  if (project.status !== 'active'
    || project.ownerId !== person.id
    || project.need !== 'equipment-reliability'
    || project.desiredFunction !== 'restore-electrical-power-delivery'
    || !basis
    || !plan
    || project.electricalPowerPlanKey !== basis.planKey
    || project.electricalPowerNetworkId !== basis.networkId
    || electricalPowerPlanKey(plan) !== basis.planKey
    || !validateElectricalPowerMaintenanceBasis(state, person, basis)) return null;
  const network = state.world.electricalPower?.networks.find((candidate) => candidate.id === basis.networkId
    && candidate.planKey === basis.planKey);
  const faultEvent = network ? currentElectricalFaultEvent(state, network) : null;
  return network && faultEvent ? { plan, network, faultEvent } : null;
}

function projectReplacementFacts(state: SimulationState, project: ProjectState): ActionFact[] {
  return project.actionEventIds.slice(-ELECTRICAL_MAINTENANCE_PROJECT_EVENT_LIMIT).flatMap((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action' ? [event] : [];
  }).sort(actionOrder);
}

function manufactureFacts(
  state: SimulationState,
  project: ProjectState,
  faultEvent: ActionFact,
): ActionFact[] {
  return projectReplacementFacts(state, project).filter((fact) => fact.status === 'completed'
    && fact.who === project.ownerId
    && fact.action.kind === 'act'
    && fact.action.operation === 'combine'
    && Number(fact.diff.outputMaterialId) === Material.CopperConductor
    && typeof fact.diff.outputStackId === 'string'
    && actionAfter(fact, faultEvent));
}

function verificationFor(
  state: SimulationState,
  project: ProjectState,
  manufacture: ActionFact,
): ActionFact | null {
  return projectReplacementFacts(state, project).find((fact) => fact.status === 'completed'
    && fact.who === project.ownerId
    && fact.action.kind === 'attend'
    && fact.diff.verifiedSourceEventId === manufacture.id
    && Number(fact.diff.verifiedMaterialId) === Material.CopperConductor
    && actionAfter(fact, manufacture)) ?? null;
}

function replacementCandidate(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  faultEvent: ActionFact,
): { manufacture: ActionFact; verification: ActionFact; stack: ItemStack } | null {
  for (const manufacture of manufactureFacts(state, project, faultEvent)) {
    const verification = verificationFor(state, project, manufacture);
    const stackId = typeof manufacture.diff.outputStackId === 'string' ? manufacture.diff.outputStackId : undefined;
    const stack = stackId ? person.inventory.find((candidate) => candidate.id === stackId
      && candidate.materialId === Material.CopperConductor
      && candidate.quantity > 0
      && !candidate.recordPayloadId
      && candidate.sourceEventIds.includes(manufacture.id)) : undefined;
    if (verification && stack) return { manufacture, verification, stack };
  }
  return null;
}

function reservation(person: PersonState, stack: ItemStack): ProjectReservation[] {
  return [{ personId: person.id, stackId: stack.id, materialId: stack.materialId, quantity: 1 }];
}

function refsForRecipe(
  person: PersonState,
  rule: InventoryCombinationRule,
): Array<Extract<WorldRef, { kind: 'inventory-stack' }>> | null {
  const refs: Array<Extract<WorldRef, { kind: 'inventory-stack' }>> = [];
  const committed = new Map<string, number>();
  for (const input of rule.inputs) {
    const stack = person.inventory.find((candidate) => candidate.materialId === input.materialId
      && candidate.quantity - (committed.get(candidate.id) ?? 0) >= input.quantity
      && !candidate.recordPayloadId);
    if (!stack) return null;
    committed.set(stack.id, (committed.get(stack.id) ?? 0) + input.quantity);
    for (let count = 0; count < input.quantity; count += 1) {
      refs.push({ kind: 'inventory-stack', personId: person.id, stackId: stack.id });
    }
  }
  return refs;
}

function manufactureStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): ElectricalPowerMaintenanceProjectStep | null {
  const known = reliableConductorRecipeBasis(state, person);
  if (!known) return null;
  const refs = refsForRecipe(person, known.rule);
  if (!refs) return null;
  return {
    key: `electrical-maintenance-manufacture-${refs.map((ref) => ref.stackId).join('-')}`,
    summary: `按本人已核验的经验制造${materialDefinition(Material.CopperConductor).name}`,
    reason: '只有本人真实盲试并核验后的经验才会展开替换件制造；故障项目本身没有泄露配方',
    action: { kind: 'act', operation: 'combine', targets: refs },
    sourceFactIds: uniqueBounded([
      ...project.electricalPowerMaintenanceBasis!.sourceFactIds,
      ...known.sourceFactIds,
      ...refs.flatMap((ref) => person.inventory.find((stack) => stack.id === ref.stackId)?.sourceEventIds ?? []),
    ]),
    missingMaterialIds: [],
    reservations: refs.flatMap((ref) => {
      const stack = person.inventory.find((candidate) => candidate.id === ref.stackId);
      return stack ? reservation(person, stack) : [];
    }),
    planKnowledgeId: known.knowledgeId,
  };
}

function verificationStep(
  state: SimulationState,
  person: PersonState,
  manufacture: ActionFact,
): ElectricalPowerMaintenanceProjectStep | null {
  const known = reliableConductorRecipeBasis(state, person);
  const stackId = typeof manufacture.diff.outputStackId === 'string' ? manufacture.diff.outputStackId : undefined;
  const stack = stackId ? person.inventory.find((candidate) => candidate.id === stackId
    && candidate.materialId === Material.CopperConductor
    && candidate.quantity > 0
    && candidate.sourceEventIds.includes(manufacture.id)) : undefined;
  if (!known || !stack) return null;
  return {
    key: `electrical-maintenance-verify-${manufacture.id}-${stack.id}`,
    summary: '核验这次故障后制造的实体铜导体',
    reason: '类别知识和旧备件都不能替代本次实体制造后的 source-bound 核验',
    action: {
      kind: 'attend',
      target: { kind: 'inventory-stack', personId: person.id, stackId: stack.id },
      verification: {
        techniqueId: known.knowledgeId,
        sourceEventId: manufacture.id,
        expectedMaterialId: Material.CopperConductor,
      },
    },
    target: { kind: 'inventory-stack', personId: person.id, stackId: stack.id },
    sourceFactIds: uniqueBounded([manufacture.id, ...stack.sourceEventIds]),
    missingMaterialIds: [],
    reservations: reservation(person, stack),
    planKnowledgeId: known.knowledgeId,
  };
}

function closeEnough(person: PersonState, position: ElectricalVoxelPosition): boolean {
  const horizontal = Math.abs(cellX(person.position.cellId) - position.x)
    + Math.abs(cellY(person.position.cellId) - position.y);
  const vertical = Math.max(0, Math.abs(person.position.z - position.z) - 1);
  return horizontal + vertical <= 1
    && !(person.position.cellId === cellId(position.x, position.y) && person.position.z === position.z);
}

export function electricalPowerMaintenanceProjectStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): ElectricalPowerMaintenanceProjectStep | null {
  const contract = projectContract(state, person, project);
  if (!contract) return null;
  const unverified = manufactureFacts(state, project, contract.faultEvent).find((manufacture) => (
    !verificationFor(state, project, manufacture)
      && person.inventory.some((stack) => stack.materialId === Material.CopperConductor
        && stack.quantity > 0
        && stack.sourceEventIds.includes(manufacture.id))
  ));
  if (unverified) return verificationStep(state, person, unverified);
  const replacement = replacementCandidate(state, person, project, contract.faultEvent);
  if (!replacement) return manufactureStep(state, person, project);
  const tool = person.inventory.find((stack) => stack.materialId === Material.IronTool
    && stack.quantity > 0
    && !stack.recordPayloadId);
  const mechanicalService = personalMechanicalServiceEventForElectricalPlan(state, person, contract.plan);
  if (!tool || !mechanicalService) return null;
  const faultPosition = contract.network.fault!.componentPosition;
  const basis = {
    version: ELECTRICAL_POWER_ACTION_BASIS_VERSION,
    mode: 'repair' as const,
    maintenanceProjectId: project.id,
    planKey: contract.network.planKey,
    networkId: contract.network.id,
    mechanicalServiceEventId: mechanicalService.id,
    faultEventId: contract.faultEvent.id,
    replacementMaterialId: Material.CopperConductor,
    toolMaterialId: Material.IronTool,
    manufactureEventId: replacement.manufacture.id,
    verificationEventId: replacement.verification.id,
  };
  if (!closeEnough(person, faultPosition)) {
    const stand = targetApproach(state, person, faultPosition);
    if (!stand || (stand.cellId === person.position.cellId && stand.z === person.position.z)) return null;
    return {
      key: `approach-electrical-maintenance-${project.id}-${stand.cellId}-${stand.z}`,
      summary: '带着已核验替换导体和铁工具靠近熔断位置',
      reason: '修复仍要求本人近身到当前实体故障，移动不会绕过领域复核',
      action: { kind: 'move', toCellId: stand.cellId, toZ: stand.z },
      target: { kind: 'voxel', position: { ...faultPosition } },
      sourceFactIds: uniqueBounded([
        ...project.electricalPowerMaintenanceBasis!.sourceFactIds,
        replacement.manufacture.id,
        replacement.verification.id,
        mechanicalService.id,
      ]),
      missingMaterialIds: [],
      reservations: [...reservation(person, replacement.stack), ...reservation(person, tool)],
    };
  }
  return {
    key: `repair-electrical-maintenance-${project.id}-${contract.faultEvent.id}`,
    summary: '用故障后制造并核验的新导体恢复实体电力链',
    reason: '领域层仍会复核当前 fault、项目诊断、替换件时序、铁工具、本人机械服务与完整拓扑',
    action: {
      kind: 'act',
      operation: 'exert',
      toolStackId: tool.id,
      targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: replacement.stack.id },
        { kind: 'voxel', position: { ...faultPosition } },
      ],
      electricalPowerBasis: basis,
    },
    target: { kind: 'voxel', position: { ...faultPosition } },
    sourceFactIds: uniqueBounded([
      ...project.electricalPowerMaintenanceBasis!.sourceFactIds,
      replacement.manufacture.id,
      replacement.verification.id,
      mechanicalService.id,
      ...tool.sourceEventIds,
    ]),
    missingMaterialIds: [],
    reservations: [...reservation(person, replacement.stack), ...reservation(person, tool)],
  };
}

export function electricalPowerMaintenanceMaterialRequirement(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): ElectricalPowerMaintenanceMaterialRequirement {
  const contract = projectContract(state, person, project);
  const known = reliableConductorRecipeBasis(state, person);
  if (!contract || !known) return {
    materialIds: [],
    sourceFactIds: [...(project.electricalPowerMaintenanceBasis?.sourceFactIds ?? [])],
  };
  const replacement = replacementCandidate(state, person, project, contract.faultEvent);
  const needsTool = !person.inventory.some((stack) => stack.materialId === Material.IronTool
    && stack.quantity > 0
    && !stack.recordPayloadId);
  return {
    materialIds: [
      ...(!replacement ? [Material.CopperConductor] : []),
      ...(replacement && needsTool ? [Material.IronTool] : []),
    ],
    sourceFactIds: uniqueBounded([
      ...project.electricalPowerMaintenanceBasis!.sourceFactIds,
      ...known.sourceFactIds,
    ]),
    planKnowledgeId: known.knowledgeId,
  };
}

export function electricalPowerMaintenanceCompletionEvidence(
  state: SimulationState,
  project: ProjectState,
): string[] {
  const basis = project.electricalPowerMaintenanceBasis;
  const plan = project.electricalPowerPlan;
  if (project.need !== 'equipment-reliability'
    || project.desiredFunction !== 'restore-electrical-power-delivery'
    || !basis
    || !plan
    || project.electricalPowerNetworkId !== basis.networkId
    || project.electricalPowerPlanKey !== basis.planKey
    || electricalPowerPlanKey(plan) !== basis.planKey) return [];
  const network = state.world.electricalPower?.version === ELECTRICAL_POWER_WORLD_VERSION
    ? state.world.electricalPower.networks.find((candidate) => candidate.id === basis.networkId
      && candidate.planKey === basis.planKey)
    : undefined;
  if (!network
    || network.fault
    || voxelAt(
      state.world.grid,
      basis.componentPosition.x,
      basis.componentPosition.y,
      basis.componentPosition.z,
    ) !== Material.CopperConductor
    || !validateElectricalPowerTopology(state.world.grid, network).valid) return [];
  const faultEvent = worldEventById(state, basis.faultEventId);
  const diagnosisEvent = worldEventById(state, basis.diagnosisEventId);
  if (faultEvent?.kind !== 'action'
    || faultEvent.status !== 'completed'
    || faultEvent.diff.electricalPowerFault !== true
    || faultEvent.diff.electricalNetworkId !== network.id
    || diagnosisEvent?.kind !== 'action'
    || diagnosisEvent.status !== 'completed'
    || diagnosisEvent.who !== project.ownerId
    || diagnosisEvent.action.kind !== 'attend'
    || diagnosisEvent.action.electricalPowerFaultObservation?.networkId !== network.id
    || diagnosisEvent.action.electricalPowerFaultObservation.faultEventId !== faultEvent.id
    || diagnosisEvent.diff.electricalPowerFaultDiagnosis !== true
    || !actionAfter(diagnosisEvent, faultEvent)) return [];
  const events = projectReplacementFacts(state, project);
  const repair = [...events].reverse().find((event) => event.status === 'completed'
    && event.who === project.ownerId
    && event.action.kind === 'act'
    && event.action.electricalPowerBasis?.mode === 'repair'
    && event.action.electricalPowerBasis.maintenanceProjectId === project.id
    && event.diff.electricalPowerRepair === true
    && event.diff.maintenanceProjectId === project.id
    && event.diff.electricalNetworkId === basis.networkId
    && event.diff.faultEventId === basis.faultEventId);
  if (!repair) return [];
  const manufactureId = typeof repair.diff.replacementManufactureEventId === 'string'
    ? repair.diff.replacementManufactureEventId
    : undefined;
  const verificationId = typeof repair.diff.replacementVerificationEventId === 'string'
    ? repair.diff.replacementVerificationEventId
    : undefined;
  const manufacture = manufactureId ? events.find((event) => event.id === manufactureId) : undefined;
  const verification = verificationId ? events.find((event) => event.id === verificationId) : undefined;
  if (!manufacture || !verification
    || !actionAfter(manufacture, faultEvent)
    || verification.diff.verifiedSourceEventId !== manufacture.id
    || !actionAfter(verification, manufacture)
    || !actionAfter(repair, verification)) return [];
  return uniqueBounded([
    basis.faultEventId,
    basis.diagnosisEventId,
    manufacture.id,
    verification.id,
    repair.id,
  ]);
}
