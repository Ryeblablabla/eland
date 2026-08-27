import {
  waterCurrentObservationFactId,
  type ActionOption,
  type PrimitiveAction,
  type VoxelPosition,
  type WorldRef,
} from '../domain/action';
import {
  completedActionFactsForPerson,
  retainedColdWorldEventsForLease,
  worldEventById,
} from '../domain/event-index';
import {
  inventoryCombinationsForOutput,
  inventoryCombinationTechniqueId,
  type InventoryCombinationRule,
} from '../domain/interaction-rules';
import {
  MECHANICAL_POWER_ACTION_BASIS_VERSION,
  MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT,
  MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
  MECHANICAL_POWER_PLAN_VERSION,
  MECHANICAL_POWER_RELIABILITY_CYCLE_RECEIPT_LIMIT,
  MECHANICAL_POWER_WORN_FAULT_THRESHOLD,
  mechanicalPowerFaultObservationFactId,
  mechanicalPowerNetworkId,
  mechanicalPowerPlanKey,
  plannedMechanicalPowerComponents,
  resolveWaterCurrentAvailability,
  validatedMechanicalPowerReliabilityCycleReceipts,
  validateMechanicalPowerTopology,
  waterCurrentAvailabilityFor,
  type MechanicalPowerActionBasis,
  type MechanicalPowerNetworkState,
  type MechanicalPowerProjectPlan,
  type MechanicalPowerReliabilityCycleReceipt,
  type WaterCurrentSegment,
} from '../domain/mechanical-power';
import { Material, materialDefinition, type MaterialId } from '../domain/material';
import type { ActionFact, SimulationState } from '../domain/model';
import type { ItemStack, PersonState } from '../domain/person';
import type {
  MechanicalReliabilityBasis,
  MechanicalReliabilityFaultBasis,
  ProjectReservation,
  ProjectState,
} from '../domain/project';
import {
  eventAfterCurrentLeadership,
  inspectProjectLeadership,
  projectEventHasEventTimeLead,
  projectIsLedBy,
} from '../domain/project-leadership';
import { pendingProjectKnowledgeOutput } from '../domain/project-knowledge-request';
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

export interface MechanicalPowerProjectStep {
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

export interface MechanicalPowerProposalCandidate {
  plan: MechanicalPowerProjectPlan;
  planKey: string;
  networkId: string;
  contributionSite: StandingPosition;
  millLaborFact: ActionFact;
  observationFact: ActionFact;
}

export interface MechanicalPowerMaintenanceProposalCandidate {
  installationProject: ProjectState;
  plan: MechanicalPowerProjectPlan;
  planKey: string;
  network: MechanicalPowerNetworkState;
  faultEvent: ActionFact;
  diagnosisKnowledgeId: string;
  diagnosisSourceEventIds: string[];
  contributionSite: StandingPosition;
}

export interface MechanicalPowerReliabilityProposalCandidate extends MechanicalPowerMaintenanceProposalCandidate {
  reliabilityBasis: MechanicalReliabilityBasis;
}

export const MECHANICAL_RELIABILITY_REQUIRED_LOADED_OPERATIONS = 4;

function requiredReliabilityLoadedOperations(project: ProjectState): number {
  const priorMaximum = Math.max(
    0,
    ...(project.mechanicalReliabilityBasis?.faults.map((fault) => fault.serviceLoadedOperationCount) ?? []),
  );
  return Math.max(MECHANICAL_RELIABILITY_REQUIRED_LOADED_OPERATIONS, priorMaximum + 1);
}

function samePosition(left: VoxelPosition, right: VoxelPosition): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function positionKey(position: VoxelPosition): string {
  return `${position.x}:${position.y}:${position.z}`;
}

function actionOrder(left: ActionFact, right: ActionFact): number {
  return left.atMonth - right.atMonth
    || left.orderInMonth - right.orderInMonth
    || left.id.localeCompare(right.id);
}

function actionAfter(candidate: ActionFact, basis: ActionFact): boolean {
  return actionOrder(candidate, basis) > 0;
}

function projectFacts(state: SimulationState, project: ProjectState): ActionFact[] {
  return project.actionEventIds.flatMap((eventId) => {
    const fact = worldEventById(state, eventId);
    return fact?.kind === 'action' ? [fact] : [];
  }).sort(actionOrder);
}

export function ownMillLaborFacts(state: SimulationState, person: PersonState): ActionFact[] {
  const qualifies = (fact: SimulationState['world']['past'][number]): fact is ActionFact => fact.kind === 'action'
    && fact.status === 'completed'
    && fact.who === person.id
    && fact.action.kind === 'act'
    && fact.action.operation === 'separate'
    && Number(fact.diff.sourceMaterialId) === Material.CropMature
    && Number(fact.diff.facilityMaterialId) === Material.Mill;
  const cold = retainedColdWorldEventsForLease(
    state,
    `living-mill-labor:${person.id}:recent-3`,
  ).filter(qualifies);
  return [...cold, ...completedActionFactsForPerson(state, person.id).filter(qualifies)];
}

export function personalWaterCurrentObservation(
  state: SimulationState,
  person: PersonState,
  segmentId: string,
): ActionFact | null {
  const knowledge = person.knowledge.find((fact) => fact.id === waterCurrentObservationFactId(segmentId)
    && fact.kind === 'observation'
    && fact.confidence >= 55);
  if (!knowledge) return null;
  return knowledge.sourceEventIds.flatMap((eventId) => {
    const fact = worldEventById(state, eventId);
    return fact?.kind === 'action' ? [fact] : [];
  }).filter((fact) => fact.status === 'completed'
    && fact.who === person.id
    && fact.action.kind === 'attend'
    && fact.action.waterCurrentSegmentId === segmentId
    && fact.diff.mechanicalPowerObservation === true
    && fact.diff.waterCurrentSegmentId === segmentId)
    .sort(actionOrder)
    .at(-1) ?? null;
}

function projectLeadWaterCurrentObservation(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): ActionFact | null {
  const segmentId = project.mechanicalPowerPlan?.sourceSegmentId;
  const known = segmentId ? person.knowledge.find((fact) => fact.id === waterCurrentObservationFactId(segmentId)
    && fact.kind === 'observation'
    && fact.confidence >= 55) : undefined;
  if (!known || !projectIsLedBy(project, person.id)) return null;
  const allowed = new Set(project.triggerFactIds);
  return known.sourceEventIds.flatMap((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action' ? [event] : [];
  }).filter((event) => event.status === 'completed'
    && event.who === person.id
    && event.action.kind === 'attend'
    && event.action.waterCurrentSegmentId === segmentId
    && event.diff.mechanicalPowerObservation === true
    && allowed.has(event.id)
    && eventAfterCurrentLeadership(project, event))
    .sort(actionOrder)
    .at(-1) ?? null;
}

function visibleCurrentTargets(
  state: SimulationState,
  visibleCells: ReadonlySet<number>,
): Array<{ segment: WaterCurrentSegment; target: VoxelPosition; capacity: number }> {
  const mechanicalPower = state.world.mechanicalPower;
  if (!mechanicalPower) return [];
  const availability = new Map(resolveWaterCurrentAvailability(state.world.grid, mechanicalPower)
    .filter((candidate) => candidate.available)
    .map((candidate) => [candidate.segmentId, candidate]));
  return mechanicalPower.sources.flatMap((segment) => {
    const current = availability.get(segment.id);
    if (!current) return [];
    const target = segment.requiredWaterVoxels.find((position) => visibleCells.has(cellId(position.x, position.y))
      && voxelAt(state.world.grid, position.x, position.y, position.z) === Material.Water);
    return target ? [{ segment, target, capacity: current.availableCapacity }] : [];
  });
}

export function buildWaterCurrentObservationOptions(
  state: SimulationState,
  person: PersonState,
  visibleCells: number[],
): ActionOption[] {
  const millLabor = ownMillLaborFacts(state, person).at(-1);
  if (!millLabor) return [];
  const visible = new Set(visibleCells);
  const observationOptions = visibleCurrentTargets(state, visible)
    .filter(({ segment }) => !personalWaterCurrentObservation(state, person, segment.id))
    .filter(({ target }) => Math.abs(cellX(person.position.cellId) - target.x)
      + Math.abs(cellY(person.position.cellId) - target.y) <= 7
      && Math.abs(target.z - person.position.z) <= 4 + Math.floor(person.baselineCapacities.perception / 25))
    .sort((left, right) => (
      Math.abs(cellX(person.position.cellId) - left.target.x)
        + Math.abs(cellY(person.position.cellId) - left.target.y)
        - Math.abs(cellX(person.position.cellId) - right.target.x)
        - Math.abs(cellY(person.position.cellId) - right.target.y)
    ) || left.segment.id.localeCompare(right.segment.id))
    .slice(0, 1)
    .map<ActionOption>(({ segment, target }) => ({
      id: `observe-water-current:${segment.id}`,
      summary: '观察流水是否能持续推动实体构件',
      reason: '本人曾在磨坊真实处理成熟作物，现在又亲眼看见近处水体保持定向流动',
      goal: { kind: 'knowledge', factId: waterCurrentObservationFactId(segment.id), minConfidence: 55 },
      nextAction: {
        kind: 'attend',
        target: { kind: 'voxel', position: { ...target } },
        waterCurrentSegmentId: segment.id,
      },
      target: { kind: 'voxel', position: { ...target } },
      estimatedDuration: 'one-month',
      sourceFactIds: [millLabor.id],
      domain: 'strategic',
    }));
  if (observationOptions.length) return observationOptions;

  // Mill labor supplies a concrete reason to revisit water, but not knowledge
  // of a hidden current. Route only to a source-backed place this person
  // remembers; the existing attend option still requires seeing a real current
  // after arrival. Skipping a currently visible nearest memory prevents zero-motion
  // retries when the remembered water is static or has disappeared.
  const nearestRememberedWater = [...person.knownPlaces]
    .filter((place) => place.materialId === Material.Water && place.sourceEventIds.length > 0)
    .sort((left, right) => (
      Math.abs(cellX(person.position.cellId) - left.position.x)
        + Math.abs(cellY(person.position.cellId) - left.position.y)
        + Math.abs(person.position.z - left.position.z)
        - Math.abs(cellX(person.position.cellId) - right.position.x)
        - Math.abs(cellY(person.position.cellId) - right.position.y)
        - Math.abs(person.position.z - right.position.z)
    ) || right.lastConfirmedAtMonth - left.lastConfirmedAtMonth
      || left.id.localeCompare(right.id))[0];
  if (!nearestRememberedWater
    || visible.has(cellId(nearestRememberedWater.position.x, nearestRememberedWater.position.y))) return [];
  const rememberedWaterCell = cellId(nearestRememberedWater.position.x, nearestRememberedWater.position.y);
  const revisitCandidates = cellsInRadius(rememberedWaterCell, 1)
    .filter((candidateCellId) => candidateCellId !== rememberedWaterCell)
    .flatMap((candidateCellId) => standingPositions(state.world.grid, candidateCellId))
    .filter((position) => position.cellId !== person.position.cellId || position.z !== person.position.z)
    .map((position) => ({
      place: nearestRememberedWater,
      position,
      path: findStandingPath(state.world.grid, person.position, position),
    }))
    .filter(({ path }) => path.length > 1)
    .sort((left, right) => left.path.length - right.path.length
      || left.position.cellId - right.position.cellId
      || left.position.z - right.position.z);
  const revisit = revisitCandidates[0];
  if (!revisit) return [];
  const pathLength = revisit.path.length - 1;
  return [{
    id: `revisit-water-for-mechanical-inquiry:${revisit.place.id}`,
    summary: '回到本人记得的水边调查持续动力',
    reason: '本人曾在磨坊真实处理成熟作物，也记得一处亲自确认过的水边；先回到那里查看现场，不预设那里的水具有定向流动',
    goal: { kind: 'at-cell', cellId: revisit.position.cellId },
    nextAction: { kind: 'move', toCellId: revisit.position.cellId, toZ: revisit.position.z },
    target: { kind: 'voxel', position: { ...revisit.place.position } },
    estimatedDuration: pathLength <= 15 ? 'one-month' : 'several-months',
    estimatedMonths: Math.max(1, Math.ceil(pathLength / 15)),
    sourceFactIds: [...new Set([millLabor.id, ...revisit.place.sourceEventIds])],
    domain: 'strategic',
  }];
}

export function mechanicalPowerProposalCandidate(
  state: SimulationState,
  person: PersonState,
  visibleCells: number[],
): MechanicalPowerProposalCandidate | null {
  const millLaborFact = ownMillLaborFacts(state, person).at(-1);
  const mechanicalPower = state.world.mechanicalPower;
  if (!millLaborFact || !mechanicalPower) return null;
  const visible = new Set(visibleCells);
  const proposalMonth = state.clock.elapsedMonths + 1;
  const projectId = `project-${proposalMonth}-${person.id}-mechanical-power-capability`;
  const availableIds = new Set(resolveWaterCurrentAvailability(state.world.grid, mechanicalPower)
    .filter((candidate) => candidate.available)
    .map((candidate) => candidate.segmentId));
  const candidates = mechanicalPower.sources.flatMap((segment) => {
    if (!availableIds.has(segment.id)) return [];
    const observationFact = personalWaterCurrentObservation(state, person, segment.id);
    if (!observationFact || !segment.requiredWaterVoxels.some((position) => visible.has(cellId(position.x, position.y)))) return [];
    return segment.requiredWaterVoxels.flatMap((waterPosition) => {
      const wheelPosition = { x: waterPosition.x, y: waterPosition.y, z: waterPosition.z + 1 };
      if (!visible.has(cellId(wheelPosition.x, wheelPosition.y))
        || voxelAt(state.world.grid, wheelPosition.x, wheelPosition.y, wheelPosition.z) !== Material.Air) return [];
      return [
        { dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
      ].flatMap(({ dx, dy }) => {
        const shaftPosition = { x: wheelPosition.x + dx, y: wheelPosition.y + dy, z: wheelPosition.z };
        const loadPosition = { x: wheelPosition.x + dx * 2, y: wheelPosition.y + dy * 2, z: wheelPosition.z };
        const wheelApproach = approachPosition(state, person, wheelPosition);
        const shaftApproach = approachPosition(state, person, shaftPosition);
        const loadApproach = approachPosition(state, person, loadPosition);
        if ([shaftPosition, loadPosition].some((position) => position.x < 0
          || position.x >= state.world.grid.width
          || position.y < 0
          || position.y >= state.world.grid.depth
          || !visible.has(cellId(position.x, position.y))
          || voxelAt(state.world.grid, position.x, position.y, position.z) !== Material.Air
          || materialDefinition(voxelAt(state.world.grid, position.x, position.y, position.z - 1)).phase !== 'solid')
          || !wheelApproach
          || !shaftApproach
          || !loadApproach) return [];
        const plan: MechanicalPowerProjectPlan = {
          version: MECHANICAL_POWER_PLAN_VERSION,
          projectId,
          sourceSegmentId: segment.id,
          wheelPosition: { ...wheelPosition },
          shaftPositions: [{ ...shaftPosition }],
          loadPosition: { ...loadPosition },
          sourceKeys: [...segment.sourceKeys],
        };
        return [{
          plan,
          planKey: mechanicalPowerPlanKey(plan),
          networkId: mechanicalPowerNetworkId(plan),
          contributionSite: { ...loadApproach },
          millLaborFact,
          observationFact,
        }];
      });
    });
  }).sort((left, right) => left.plan.shaftPositions.length - right.plan.shaftPositions.length
    || positionKey(left.plan.loadPosition).localeCompare(positionKey(right.plan.loadPosition))
    || left.plan.sourceSegmentId.localeCompare(right.plan.sourceSegmentId));
  return candidates[0] ?? null;
}

export function mechanicalPowerPressureEvidence(
  state: SimulationState,
  person: PersonState,
): { millLaborFactIds: string[]; observationFactIds: string[] } {
  // Project pressure already reasons from the latest three personal labor
  // episodes. Bound the evidence here as well so a cold retention window and a
  // full replay produce the same authoritative pressure basis.
  const millLaborFactIds = ownMillLaborFacts(state, person).slice(-3).map((fact) => fact.id);
  const observationFactIds = state.world.mechanicalPower?.sources.flatMap((segment) => {
    const fact = personalWaterCurrentObservation(state, person, segment.id);
    return fact ? [fact.id] : [];
  }) ?? [];
  return { millLaborFactIds, observationFactIds };
}

function completedInstallationProjectForNetwork(
  state: SimulationState,
  network: MechanicalPowerNetworkState,
): ProjectState | null {
  const project = state.projects.find((candidate) => candidate.id === network.installationProjectId
    && candidate.status === 'completed'
    && candidate.desiredFunction === 'water-powered-crop-processing');
  const plan = project?.mechanicalPowerPlan;
  return project && plan
    && plan.version === MECHANICAL_POWER_PLAN_VERSION
    && plan.projectId === project.id
    && project.mechanicalPowerPlanKey === mechanicalPowerPlanKey(plan)
    && project.mechanicalPowerNetworkId === network.id
    && network.planKey === project.mechanicalPowerPlanKey
    && network.sourceSegmentId === plan.sourceSegmentId
    ? project
    : null;
}

function reliableMechanicalOperationKnowledge(person: PersonState) {
  return person.knowledge.find((fact) => fact.id === MECHANICAL_POWER_OPERATION_TECHNIQUE_ID
    && fact.kind === 'technique'
    && fact.confidence >= 55);
}

function currentMechanicalFaultEvent(
  state: SimulationState,
  network: MechanicalPowerNetworkState,
): ActionFact | null {
  if (!network.fault) return null;
  const event = worldEventById(state, network.fault.faultEventId);
  return event?.kind === 'action'
    && event.diff.mechanicalPowerFault === true
    && event.diff.networkId === network.id
    ? event
    : null;
}

function personalMechanicalFaultDiagnosis(
  state: SimulationState,
  person: PersonState,
  network: MechanicalPowerNetworkState,
): { knowledgeId: string; diagnosisEvent: ActionFact; sourceEventIds: string[] } | null {
  const faultEvent = currentMechanicalFaultEvent(state, network);
  return faultEvent ? personalMechanicalFaultDiagnosisForEvent(state, person, network, faultEvent) : null;
}

function personalMechanicalFaultDiagnosisForEvent(
  state: SimulationState,
  person: PersonState,
  network: MechanicalPowerNetworkState,
  faultEvent: ActionFact,
): { knowledgeId: string; diagnosisEvent: ActionFact; sourceEventIds: string[] } | null {
  const knowledgeId = mechanicalPowerFaultObservationFactId(network.id, faultEvent.id);
  const knowledge = person.knowledge.find((fact) => fact.id === knowledgeId
    && fact.kind === 'observation'
    && fact.confidence >= 55);
  if (!knowledge) return null;
  const diagnosis = knowledge.sourceEventIds.flatMap((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action' ? [event] : [];
  }).find((event) => personalMechanicalFaultDiagnosisEventMatches(person, network, faultEvent, event));
  return diagnosis ? {
    knowledgeId,
    diagnosisEvent: diagnosis,
    sourceEventIds: [...knowledge.sourceEventIds],
  } : null;
}

function personalMechanicalFaultDiagnosisEventMatches(
  person: PersonState,
  network: MechanicalPowerNetworkState,
  faultEvent: ActionFact,
  event: ActionFact,
): boolean {
  return event.status === 'completed'
    && event.who === person.id
    && event.action.kind === 'attend'
    && event.action.mechanicalPowerFaultObservation?.networkId === network.id
    && event.action.mechanicalPowerFaultObservation.faultEventId === faultEvent.id
    && event.diff.mechanicalPowerFaultDiagnosis === true
    && event.diff.faultEventId === faultEvent.id
    && actionAfter(event, faultEvent);
}

function exactBoundedStringIds(value: unknown, limit: number, allowEmpty = false): string[] | null {
  if (!Array.isArray(value)
    || value.length > limit
    || (!allowEmpty && value.length === 0)
    || value.some((item) => typeof item !== 'string' || item.length === 0)
    || new Set(value).size !== value.length) return null;
  return value as string[];
}

function sameStringIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function verifiedComponentSourceEvents(
  state: SimulationState,
  sourceEventIds: readonly string[],
  materialId: MaterialId,
  before: ActionFact,
  expectedManufactureEventId?: string,
  expectedVerificationEventId?: string,
): { manufacture: ActionFact; verification: ActionFact } | null {
  const sourceEvents = sourceEventIds.flatMap((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action' ? [event] : [];
  });
  const manufacture = sourceEvents.find((event) => event.status === 'completed'
    && (!expectedManufactureEventId || event.id === expectedManufactureEventId)
    && event.action.kind === 'act'
    && event.action.operation === 'combine'
    && Number(event.diff.outputMaterialId) === materialId
    && actionAfter(before, event));
  const verification = manufacture ? sourceEvents.find((event) => event.status === 'completed'
    && (!expectedVerificationEventId || event.id === expectedVerificationEventId)
    && event.action.kind === 'attend'
    && event.diff.verifiedSourceEventId === manufacture.id
    && Number(event.diff.verifiedMaterialId) === materialId
    && actionAfter(before, event)) : undefined;
  return manufacture && verification ? { manufacture, verification } : null;
}

function reliabilityFaultBasisForReceipt(
  state: SimulationState,
  person: PersonState,
  network: MechanicalPowerNetworkState,
  receipt: MechanicalPowerReliabilityCycleReceipt,
  storedDiagnosisEventId?: string,
): MechanicalReliabilityFaultBasis | null {
  const faultEvent = worldEventById(state, receipt.faultEventId);
  if (faultEvent?.kind !== 'action'
    || receipt.installationProjectId !== network.installationProjectId
    || receipt.networkId !== network.id
    || receipt.operatorId !== person.id
    || receipt.shaftMaterialId !== Material.DriveShaft) return null;
  if (faultEvent.status !== 'completed'
    || faultEvent.who !== person.id
    || faultEvent.diff.mechanicalPowerFault !== true
    || faultEvent.diff.faultKind !== 'worn-drive-shaft'
    || faultEvent.diff.networkId !== network.id
    || faultEvent.diff.installationProjectId !== receipt.installationProjectId
    || faultEvent.diff.faultEventId !== receipt.faultEventId
    || Number(faultEvent.diff.shaftMaterialId) !== Material.DriveShaft) return null;
  const faultSourceEventIds = exactBoundedStringIds(
    faultEvent.diff.wearSourceEventIds,
    MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT,
  );
  if (!faultSourceEventIds || !sameStringIds(faultSourceEventIds, receipt.faultSourceEventIds)) return null;
  const liveDiagnosis = storedDiagnosisEventId
    ? null
    : personalMechanicalFaultDiagnosisForEvent(state, person, network, faultEvent);
  const storedDiagnosis = storedDiagnosisEventId ? worldEventById(state, storedDiagnosisEventId) : undefined;
  const diagnosisEvent = storedDiagnosis?.kind === 'action'
    && personalMechanicalFaultDiagnosisEventMatches(person, network, faultEvent, storedDiagnosis)
    ? storedDiagnosis
    : liveDiagnosis?.diagnosisEvent;
  const shaftInstallationEventId = receipt.shaftInstallationEventId;
  const shaftInstallation = shaftInstallationEventId ? worldEventById(state, shaftInstallationEventId) : undefined;
  if (!diagnosisEvent
    || faultEvent.diff.shaftInstallationEventId !== shaftInstallationEventId
    || shaftInstallation?.kind !== 'action'
    || shaftInstallation.status !== 'completed'
    || shaftInstallation.diff.mechanicalPowerInstallation !== true
    || shaftInstallation.diff.projectId !== receipt.installationProjectId
    || shaftInstallation.diff.networkId !== network.id
    || shaftInstallation.diff.componentRole !== 'connector'
    || Number(shaftInstallation.diff.componentMaterialId) !== Material.DriveShaft
    || !actionAfter(faultEvent, shaftInstallation)) return null;
  const shaftInstallationSourceEventIds = exactBoundedStringIds(
    faultEvent.diff.shaftInstallationSourceEventIds,
    MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT,
  );
  const installationActionSourceEventIds = exactBoundedStringIds(
    shaftInstallation.diff.installationSourceEventIds,
    MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT,
  );
  if (!shaftInstallationSourceEventIds
    || !installationActionSourceEventIds
    || !sameStringIds(shaftInstallationSourceEventIds, receipt.shaftInstallationSourceEventIds)
    || !sameStringIds(shaftInstallationSourceEventIds, installationActionSourceEventIds)
    || !verifiedComponentSourceEvents(
    state,
    shaftInstallationSourceEventIds,
    Material.DriveShaft,
    shaftInstallation,
  )) return null;
  const serviceLoadedOperationCount = Number(faultEvent.diff.serviceLoadedOperationCount);
  const faultProofEventIds = exactBoundedStringIds(
    faultEvent.diff.faultProofEventIds,
    MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT,
  );
  if (!Number.isSafeInteger(serviceLoadedOperationCount)
    || serviceLoadedOperationCount !== receipt.serviceLoadedOperationCount
    || !faultProofEventIds
    || receipt.loadedOperationEventIds.some((eventId) => !faultProofEventIds.includes(eventId))) return null;
  const loadedOperations = receipt.loadedOperationEventIds.flatMap((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action'
      && event.status === 'completed'
      && event.diff.mechanicalPowerOperation === true
      && event.diff.installationProjectId === receipt.installationProjectId
      && event.diff.networkId === network.id
      && Number(event.diff.shaftMaterialId) === Material.DriveShaft
      && actionAfter(faultEvent, event)
      ? [event]
      : [];
  });
  if (loadedOperations.length !== receipt.loadedOperationEventIds.length
    || !sameStringIds(
      [...loadedOperations].sort(actionOrder).map((event) => event.id),
      receipt.loadedOperationEventIds,
    )) return null;
  const loadedOperationEventIds = [...receipt.loadedOperationEventIds];
  const shaftRepairEventId = receipt.shaftRepairEventId;
  let shaftRepairSourceEventIds: string[] = [];
  if (shaftRepairEventId) {
    const repair = worldEventById(state, shaftRepairEventId);
    if (faultEvent.diff.shaftRepairEventId !== shaftRepairEventId
      || repair?.kind !== 'action'
      || repair.status !== 'completed'
      || repair.diff.mechanicalPowerRepair !== true
      || repair.diff.networkId !== network.id
      || Number(repair.diff.replacementMaterialId) !== Material.DriveShaft
      || !actionAfter(faultEvent, repair)) return null;
    const frozenRepairSourceEventIds = exactBoundedStringIds(
      faultEvent.diff.shaftRepairSourceEventIds,
      MECHANICAL_POWER_FAULT_PROOF_EVENT_LIMIT,
    );
    const repairSourceEventIds = exactBoundedStringIds(repair.diff.repairSourceEventIds, 32);
    if (!frozenRepairSourceEventIds || !repairSourceEventIds) return null;
    shaftRepairSourceEventIds = frozenRepairSourceEventIds;
    const repairSourceIds = new Set(repairSourceEventIds);
    const replacementManufactureEventId = typeof repair.diff.replacementManufactureEventId === 'string'
      ? repair.diff.replacementManufactureEventId
      : undefined;
    const replacementVerificationEventId = typeof repair.diff.replacementVerificationEventId === 'string'
      ? repair.diff.replacementVerificationEventId
      : undefined;
    if (!sameStringIds(shaftRepairSourceEventIds, receipt.shaftRepairSourceEventIds)
      || !replacementManufactureEventId
      || !replacementVerificationEventId
      || shaftRepairSourceEventIds.some((eventId) => !repairSourceIds.has(eventId))
      || !verifiedComponentSourceEvents(
        state,
        repairSourceEventIds,
        Material.DriveShaft,
        repair,
        replacementManufactureEventId,
        replacementVerificationEventId,
      )) return null;
  } else if (faultEvent.diff.shaftRepairEventId !== undefined
    || receipt.shaftRepairSourceEventIds.length !== 0
    || (Array.isArray(faultEvent.diff.shaftRepairSourceEventIds)
      && faultEvent.diff.shaftRepairSourceEventIds.length !== 0)) {
    return null;
  }
  return {
    faultEventId: faultEvent.id,
    diagnosisEventId: diagnosisEvent.id,
    shaftMaterialId: Material.DriveShaft,
    shaftInstallationEventId,
    shaftInstallationSourceEventIds: [...receipt.shaftInstallationSourceEventIds],
    ...(shaftRepairEventId ? { shaftRepairEventId } : {}),
    shaftRepairSourceEventIds: [...receipt.shaftRepairSourceEventIds],
    serviceLoadedOperationCount,
    loadedOperationEventIds,
  };
}

function reliabilityBasisSourceIds(faults: readonly MechanicalReliabilityFaultBasis[]): string[] {
  return [...new Set(faults.flatMap((fault) => [
    fault.faultEventId,
    fault.diagnosisEventId,
    fault.shaftInstallationEventId,
    ...fault.shaftInstallationSourceEventIds,
    ...(fault.shaftRepairEventId ? [fault.shaftRepairEventId] : []),
    ...fault.shaftRepairSourceEventIds,
    ...fault.loadedOperationEventIds,
  ]))];
}

export function mechanicalPowerReliabilityBasisForNetwork(
  state: SimulationState,
  person: PersonState,
  network: MechanicalPowerNetworkState,
  installationProject: ProjectState,
  atMonth: number,
): MechanicalReliabilityBasis | null {
  if (completedInstallationProjectForNetwork(state, network)?.id !== installationProject.id) return null;
  const receipts = validatedMechanicalPowerReliabilityCycleReceipts(network);
  if (!receipts
    || receipts.length !== MECHANICAL_POWER_RELIABILITY_CYCLE_RECEIPT_LIMIT
    || receipts.some((receipt) => receipt.operatorId !== person.id
      || receipt.shaftMaterialId !== Material.DriveShaft)) return null;
  const faults = receipts.flatMap((receipt) => {
    const basis = reliabilityFaultBasisForReceipt(state, person, network, receipt);
    return basis ? [basis] : [];
  });
  const faultEvents = receipts.flatMap((receipt) => {
    const event = worldEventById(state, receipt.faultEventId);
    return event?.kind === 'action' ? [event] : [];
  });
  if (faults.length !== MECHANICAL_POWER_RELIABILITY_CYCLE_RECEIPT_LIMIT
    || faultEvents.length !== MECHANICAL_POWER_RELIABILITY_CYCLE_RECEIPT_LIMIT
    || faultEvents.some((event, index) => index > 0 && !actionAfter(event, faultEvents[index - 1]))
    || new Set(faults.map((fault) => fault.faultEventId)).size
      !== MECHANICAL_POWER_RELIABILITY_CYCLE_RECEIPT_LIMIT
    || faults.at(-1)?.faultEventId !== network.fault?.faultEventId) return null;
  const sourceFactIds = reliabilityBasisSourceIds(faults);
  return {
    version: 'mechanical-reliability-basis-v1',
    observerId: person.id,
    networkId: network.id,
    installationProjectId: installationProject.id,
    atMonth,
    faults,
    sourceFactIds,
    basisKey: `mechanical-reliability-basis-v1|observer=${person.id}|network=${network.id}|faults=${faults.map((fault) => fault.faultEventId).join(',')}`,
  };
}

export function validateMechanicalReliabilityBasis(
  state: SimulationState,
  person: PersonState,
  basis: MechanicalReliabilityBasis,
  requireCurrentFault = false,
): boolean {
  if (basis.version !== 'mechanical-reliability-basis-v1'
    || basis.observerId !== person.id
    || !Number.isSafeInteger(basis.atMonth)
    || basis.atMonth < 0
    || basis.faults.length !== MECHANICAL_POWER_RELIABILITY_CYCLE_RECEIPT_LIMIT
    || new Set(basis.faults.map((fault) => fault.faultEventId)).size
      !== MECHANICAL_POWER_RELIABILITY_CYCLE_RECEIPT_LIMIT) return false;
  const network = state.world.mechanicalPower?.networks.find((candidate) => candidate.id === basis.networkId
    && candidate.installationProjectId === basis.installationProjectId);
  const installationProject = network ? completedInstallationProjectForNetwork(state, network) : null;
  if (!network || !installationProject || installationProject.id !== basis.installationProjectId
    || (requireCurrentFault && network.fault?.faultEventId !== basis.faults.at(-1)?.faultEventId)) return false;
  const receipts = validatedMechanicalPowerReliabilityCycleReceipts(network);
  if (!receipts
    || receipts.length !== MECHANICAL_POWER_RELIABILITY_CYCLE_RECEIPT_LIMIT
    || receipts.some((receipt, index) => receipt.faultEventId !== basis.faults[index]?.faultEventId
      || receipt.operatorId !== person.id
      || receipt.shaftMaterialId !== Material.DriveShaft)) return false;
  const exactFaults = receipts.flatMap((receipt, index) => {
    const stored = basis.faults[index];
    const exact = reliabilityFaultBasisForReceipt(
      state,
      person,
      network,
      receipt,
      stored?.diagnosisEventId,
    );
    return exact ? [exact] : [];
  });
  const faultMatches = exactFaults.length === basis.faults.length && exactFaults.every((exact, index) => {
    const stored = basis.faults[index];
    return exact.faultEventId === stored.faultEventId
      && exact.diagnosisEventId === stored.diagnosisEventId
      && exact.shaftMaterialId === stored.shaftMaterialId
      && exact.shaftInstallationEventId === stored.shaftInstallationEventId
      && exact.shaftRepairEventId === stored.shaftRepairEventId
      && exact.serviceLoadedOperationCount === stored.serviceLoadedOperationCount
      && sameStringIds(exact.shaftInstallationSourceEventIds, stored.shaftInstallationSourceEventIds)
      && sameStringIds(exact.shaftRepairSourceEventIds, stored.shaftRepairSourceEventIds)
      && sameStringIds(exact.loadedOperationEventIds, stored.loadedOperationEventIds);
  });
  const latestDiagnosisMonth = exactFaults.reduce((latest, fault) => {
    const diagnosis = worldEventById(state, fault.diagnosisEventId);
    return Math.max(latest, diagnosis?.atMonth ?? -1);
  }, -1);
  return faultMatches
    && basis.atMonth >= latestDiagnosisMonth
    && sameStringIds(reliabilityBasisSourceIds(exactFaults), basis.sourceFactIds)
    && basis.basisKey === `mechanical-reliability-basis-v1|observer=${person.id}|network=${network.id}|faults=${exactFaults.map((fault) => fault.faultEventId).join(',')}`;
}

export function mechanicalPowerMaintenancePressureEvidence(
  state: SimulationState,
  person: PersonState,
): { faultEventIds: string[]; diagnosisFactIds: string[]; sourceFactIds: string[] } {
  const evidence = (state.world.mechanicalPower?.networks ?? []).flatMap((network) => {
    const project = completedInstallationProjectForNetwork(state, network);
    const fault = currentMechanicalFaultEvent(state, network);
    const diagnosis = personalMechanicalFaultDiagnosis(state, person, network);
    return project && fault && diagnosis
      ? [{ faultEventId: fault.id, diagnosisFactId: diagnosis.knowledgeId, sourceFactIds: diagnosis.sourceEventIds }]
      : [];
  });
  return {
    faultEventIds: evidence.map((item) => item.faultEventId),
    diagnosisFactIds: evidence.map((item) => item.diagnosisFactId),
    sourceFactIds: [...new Set(evidence.flatMap((item) => [item.faultEventId, ...item.sourceFactIds]))],
  };
}

export function mechanicalPowerMaintenanceProposalCandidate(
  state: SimulationState,
  person: PersonState,
  visibleCells: number[],
): MechanicalPowerMaintenanceProposalCandidate | null {
  if (!reliableMechanicalOperationKnowledge(person)) return null;
  const visible = new Set(visibleCells);
  const candidates = (state.world.mechanicalPower?.networks ?? []).flatMap((network) => {
    const installationProject = completedInstallationProjectForNetwork(state, network);
    const plan = installationProject?.mechanicalPowerPlan;
    const faultEvent = currentMechanicalFaultEvent(state, network);
    const diagnosis = personalMechanicalFaultDiagnosis(state, person, network);
    const faultPosition = network.fault?.componentPosition;
    if (!installationProject || !plan || !faultEvent || !diagnosis || !faultPosition
      || !visible.has(cellId(faultPosition.x, faultPosition.y))
      || voxelAt(state.world.grid, faultPosition.x, faultPosition.y, faultPosition.z) !== Material.BrokenDriveShaft) return [];
    const contributionSite = approachPosition(state, person, faultPosition);
    return contributionSite ? [{
      installationProject,
      plan,
      planKey: network.planKey,
      network,
      faultEvent,
      diagnosisKnowledgeId: diagnosis.knowledgeId,
      diagnosisSourceEventIds: diagnosis.sourceEventIds,
      contributionSite,
    }] : [];
  }).sort((left, right) => left.faultEvent.atMonth - right.faultEvent.atMonth
    || left.network.id.localeCompare(right.network.id));
  return candidates[0] ?? null;
}

export function mechanicalPowerReliabilityProposalCandidate(
  state: SimulationState,
  person: PersonState,
  visibleCells: number[],
): MechanicalPowerReliabilityProposalCandidate | null {
  const maintenance = mechanicalPowerMaintenanceProposalCandidate(state, person, visibleCells);
  if (!maintenance) return null;
  const reliabilityBasis = mechanicalPowerReliabilityBasisForNetwork(
    state,
    person,
    maintenance.network,
    maintenance.installationProject,
    state.clock.elapsedMonths + 1,
  );
  return reliabilityBasis ? { ...maintenance, reliabilityBasis } : null;
}

function reservation(person: PersonState, stack: ItemStack): ProjectReservation[] {
  return [{ personId: person.id, stackId: stack.id, materialId: stack.materialId, quantity: 1 }];
}

function reliableRecipeBases(
  person: PersonState,
  outputMaterialId: MaterialId,
): Array<{ rule: InventoryCombinationRule; knowledgeId: string; sourceFactIds: string[] }> {
  const heldQuantity = (materialId: MaterialId) => person.inventory
    .filter((stack) => stack.materialId === materialId && stack.quantity > 0 && !stack.recordPayloadId)
    .reduce((sum, stack) => sum + stack.quantity, 0);
  return inventoryCombinationsForOutput(outputMaterialId).flatMap((rule) => {
    const knowledgeId = inventoryCombinationTechniqueId(rule);
    const knowledge = person.knowledge.find((fact) => fact.kind === 'technique'
      && fact.id === knowledgeId
      && fact.confidence >= 55);
    return knowledge ? [{
      rule,
      knowledgeId,
      sourceFactIds: [...knowledge.sourceEventIds],
      confidence: knowledge.confidence,
      outstandingQuantity: rule.inputs.reduce((sum, input) => (
        sum + Math.max(0, input.quantity - heldQuantity(input.materialId))
      ), 0),
    }] : [];
  }).sort((left, right) => left.outstandingQuantity - right.outstandingQuantity
    || right.confidence - left.confidence
    || left.rule.id.localeCompare(right.rule.id))
    .map(({ rule, knowledgeId, sourceFactIds }) => ({ rule, knowledgeId, sourceFactIds }));
}

function reliableRecipe(person: PersonState, outputMaterialId: MaterialId): InventoryCombinationRule | null {
  return reliableRecipeBases(person, outputMaterialId)[0]?.rule ?? null;
}

function reliableRecipeBasis(
  person: PersonState,
  outputMaterialId: MaterialId,
): { rule: InventoryCombinationRule; knowledgeId: string; sourceFactIds: string[] } | null {
  return reliableRecipeBases(person, outputMaterialId)[0] ?? null;
}

function refsForRecipe(person: PersonState, rule: InventoryCombinationRule): Array<Extract<WorldRef, { kind: 'inventory-stack' }>> | null {
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

function manufacturedFacts(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  outputMaterialId: MaterialId,
  after?: ActionFact,
): ActionFact[] {
  return projectFacts(state, project).filter((fact) => fact.status === 'completed'
    && fact.who === person.id
    && projectEventHasEventTimeLead(project, fact)
    && fact.action.kind === 'act'
    && fact.action.operation === 'combine'
    && Number(fact.diff.outputMaterialId) === outputMaterialId
    && typeof fact.diff.outputStackId === 'string'
    && (!after || actionAfter(fact, after)));
}

function verificationFor(
  state: SimulationState,
  project: ProjectState,
  manufacture: ActionFact,
  materialId: MaterialId,
): ActionFact | null {
  return projectFacts(state, project).find((fact) => fact.status === 'completed'
    && fact.who === manufacture.who
    && projectEventHasEventTimeLead(project, fact)
    && projectEventHasEventTimeLead(project, manufacture)
    && fact.action.kind === 'attend'
    && fact.diff.verifiedSourceEventId === manufacture.id
    && Number(fact.diff.verifiedMaterialId) === materialId) ?? null;
}

function verifiedManufacture(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  materialId: MaterialId,
  after?: ActionFact,
): { manufacture: ActionFact; verification: ActionFact; stack: ItemStack | null } | null {
  for (const manufacture of manufacturedFacts(state, person, project, materialId, after).reverse()) {
    const verification = verificationFor(state, project, manufacture, materialId);
    if (!verification) continue;
    const stack = person.inventory.find((candidate) => (
      candidate.materialId === materialId
        && candidate.quantity > 0
        && candidate.sourceEventIds.includes(manufacture.id)
    )) ?? null;
    return { manufacture, verification, stack };
  }
  return null;
}

function manufactureStep(
  person: PersonState,
  project: ProjectState,
  materialId: MaterialId,
  label: string,
): MechanicalPowerProjectStep | null {
  const rule = reliableRecipe(person, materialId);
  if (!rule) return null;
  const refs = refsForRecipe(person, rule);
  if (!refs) return null;
  const knowledgeId = inventoryCombinationTechniqueId(rule);
  const knowledge = person.knowledge.find((fact) => fact.id === knowledgeId)!;
  return {
    key: `mechanical-manufacture-${materialId}-${refs.map((ref) => ref.stackId).join('-')}`,
    summary: `按本人已核验的经验制造${label}`,
    reason: '冻结计划只规定物理位置；具体材料配方来自本人已经可靠核验的制作经验',
    action: { kind: 'act', operation: 'combine', targets: refs },
    sourceFactIds: [...new Set([
      ...project.triggerFactIds,
      ...knowledge.sourceEventIds,
      ...refs.flatMap((ref) => person.inventory.find((stack) => stack.id === ref.stackId)?.sourceEventIds ?? []),
    ])],
    missingMaterialIds: [],
    reservations: refs.flatMap((ref) => {
      const stack = person.inventory.find((candidate) => candidate.id === ref.stackId);
      return stack ? reservation(person, stack) : [];
    }),
    planKnowledgeId: knowledgeId,
  };
}

function mechanicalComponentManufactureStep(
  person: PersonState,
  project: ProjectState,
  materialId: MaterialId,
  label: string,
): MechanicalPowerProjectStep | null {
  const direct = manufactureStep(person, project, materialId, label);
  if (direct || materialId !== Material.DriveShaft) return direct;
  const shaftRecipe = reliableRecipe(person, Material.DriveShaft);
  const bronzeQuantity = shaftRecipe?.inputs.find((input) => input.materialId === Material.Bronze)?.quantity ?? 0;
  const heldBronze = person.inventory
    .filter((stack) => stack.materialId === Material.Bronze && stack.quantity > 0 && !stack.recordPayloadId)
    .reduce((sum, stack) => sum + stack.quantity, 0);
  if (!shaftRecipe || heldBronze >= bronzeQuantity || !reliableRecipe(person, Material.Bronze)) return null;
  return manufactureStep(person, project, Material.Bronze, '传动轴所需的青铜中间料');
}

function verificationStep(
  person: PersonState,
  manufacture: ActionFact,
  materialId: MaterialId,
): MechanicalPowerProjectStep | null {
  const stack = person.inventory.find((candidate) => candidate.materialId === materialId
    && candidate.quantity > 0
    && candidate.sourceEventIds.includes(manufacture.id));
  const techniqueId = typeof manufacture.diff.techniqueId === 'string'
    && inventoryCombinationsForOutput(materialId).some((rule) => (
      inventoryCombinationTechniqueId(rule) === manufacture.diff.techniqueId
    ))
    ? manufacture.diff.techniqueId
    : undefined;
  if (!stack || !techniqueId) return null;
  return {
    key: `mechanical-verify-${manufacture.id}-${stack.id}`,
    summary: `核验刚制造的${materialDefinition(materialId).name}`,
    reason: '构件必须由本人对这次真实制造结果作源事件绑定的核验，旧成品不能替代',
    action: {
      kind: 'attend',
      target: { kind: 'inventory-stack', personId: person.id, stackId: stack.id },
      verification: { techniqueId, sourceEventId: manufacture.id, expectedMaterialId: materialId },
    },
    target: { kind: 'inventory-stack', personId: person.id, stackId: stack.id },
    sourceFactIds: [...new Set([manufacture.id, ...stack.sourceEventIds])],
    missingMaterialIds: [],
    reservations: reservation(person, stack),
    planKnowledgeId: techniqueId,
  };
}

function distanceToPosition(person: PersonState, position: VoxelPosition): number {
  const horizontal = Math.abs(cellX(person.position.cellId) - position.x)
    + Math.abs(cellY(person.position.cellId) - position.y);
  const vertical = Math.max(0, Math.abs(person.position.z - position.z) - 1);
  return Math.max(horizontal, vertical);
}

function approachPosition(
  state: SimulationState,
  person: PersonState,
  target: VoxelPosition,
  interactionRange = 1,
): StandingPosition | null {
  const targetCellId = cellId(target.x, target.y);
  const candidates = cellsInRadius(cellId(target.x, target.y), 1)
    .flatMap((candidateCellId) => standingPositions(state.world.grid, candidateCellId))
    .filter((position) => position.cellId !== targetCellId)
    .filter((position) => distanceToPosition({ ...person, position: { ...person.position, ...position } }, target) <= interactionRange)
    .map((position) => ({ position, path: findStandingPath(state.world.grid, person.position, position) }))
    .filter((candidate) => candidate.path.length > 0)
    .sort((left, right) => left.path.length - right.path.length
      || left.position.cellId - right.position.cellId
      || left.position.z - right.position.z);
  return candidates[0]?.position ?? null;
}

function moveOrActStep(
  state: SimulationState,
  person: PersonState,
  target: VoxelPosition,
  key: string,
  summary: string,
  reason: string,
  action: PrimitiveAction,
  sourceFactIds: string[],
  reservations: ProjectReservation[],
  interactionRange = 1,
): MechanicalPowerProjectStep | null {
  const actorOccupiesTarget = person.position.cellId === cellId(target.x, target.y)
    && (person.position.z === target.z || person.position.z + 1 === target.z);
  if (distanceToPosition(person, target) <= interactionRange && !actorOccupiesTarget) return {
    key,
    summary,
    reason,
    action,
    target: { kind: 'voxel', position: { ...target } },
    sourceFactIds: [...new Set(sourceFactIds)],
    missingMaterialIds: [],
    reservations,
  };
  const approach = approachPosition(state, person, target, interactionRange);
  if (!approach) return null;
  return {
    key: `approach-${key}-${approach.cellId}-${approach.z}`,
    summary: `前往冻结的机械构件位置继续${summary}`,
    reason: '构件位置已经在提案时冻结；人物只移动到可达的近身工作位，不改写计划几何',
    action: { kind: 'move', toCellId: approach.cellId, toZ: approach.z },
    target: { kind: 'voxel', position: { ...target } },
    sourceFactIds: [...new Set(sourceFactIds)],
    missingMaterialIds: [],
    reservations,
  };
}

function basisFor(
  project: ProjectState,
  mode: Exclude<MechanicalPowerActionBasis['mode'], 'observe-source'>,
  fields: Record<string, unknown>,
): MechanicalPowerActionBasis {
  const plan = project.mechanicalPowerPlan!;
  return {
    version: MECHANICAL_POWER_ACTION_BASIS_VERSION,
    mode,
    sourceSegmentId: plan.sourceSegmentId,
    sourceKeys: [...plan.sourceKeys],
    projectId: project.id,
    planKey: project.mechanicalPowerPlanKey!,
    networkId: project.mechanicalPowerNetworkId!,
    ...fields,
  } as MechanicalPowerActionBasis;
}

function installedAt(
  state: SimulationState,
  project: ProjectState,
  role: 'converter' | 'connector' | 'load',
  position: VoxelPosition,
): boolean {
  const network = state.world.mechanicalPower?.networks.find((candidate) => candidate.id === project.mechanicalPowerNetworkId
    && candidate.planKey === project.mechanicalPowerPlanKey);
  return Boolean(network?.components.some((component) => component.role === role
    && component.projectId === project.id
    && samePosition(component.position, position)));
}

function initialOperationAttemptMatchesProject(
  fact: ActionFact,
  project: ProjectState,
): boolean {
  const basis = fact.action.kind === 'act' ? fact.action.mechanicalPowerBasis : undefined;
  return projectEventHasEventTimeLead(project, fact)
    && basis?.mode === 'operate'
    && basis.projectId === project.id
    && basis.planKey === project.mechanicalPowerPlanKey
    && basis.networkId === project.mechanicalPowerNetworkId
    && basis.sourceSegmentId === project.mechanicalPowerPlan?.sourceSegmentId;
}

/**
 * A failed loaded attempt is the person's explicit evidence that the frozen
 * network is waiting on its current, rather than missing another component.
 * Keep that bounded wait across the exact recovery boundary so monthly
 * synchronization cannot close the project before the restored flow is
 * naturally recompiled into another strict operate action.
 */
export function mechanicalPowerProjectHasCurrentRecoveryWait(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): boolean {
  if (!projectIsLedBy(project, person.id) || !planContractValid(project)) return false;
  const plan = project.mechanicalPowerPlan!;
  const allInstalled = installedAt(state, project, 'load', plan.loadPosition)
    && installedAt(state, project, 'converter', plan.wheelPosition)
    && plan.shaftPositions.every((position) => installedAt(state, project, 'connector', position));
  if (!allInstalled) return false;
  const latestAttempt = projectFacts(state, project)
    .filter((fact) => initialOperationAttemptMatchesProject(fact, project))
    .at(-1);
  const leadership = inspectProjectLeadership(project);
  const successionInspection = leadership.status === 'led' && leadership.latestSuccession
    ? worldEventById(state, leadership.latestSuccession.successionEventId)
    : undefined;
  const personallyInspectedSuccession = successionInspection?.kind === 'action'
    && successionInspection.status === 'completed'
    && successionInspection.who === person.id
    && successionInspection.diff.projectLeadershipSuccession === true;
  const sourcedCurrentWait = latestAttempt?.status === 'blocked'
    && latestAttempt.diff.mechanicalPowerCurrentUnavailable === true
    && (latestAttempt.diff.currentAvailabilityReason === 'blocked-water'
      || latestAttempt.diff.currentAvailabilityReason === 'upstream-unavailable');
  if (!sourcedCurrentWait && !personallyInspectedSuccession) return false;
  const availability = waterCurrentAvailabilityFor(
    state.world.grid,
    state.world.mechanicalPower,
    plan.sourceSegmentId,
  );
  return availability.available
    || availability.reason === 'blocked-water'
    || availability.reason === 'upstream-unavailable';
}

function mechanicalPowerLeadObservationStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): MechanicalPowerProjectStep | null {
  const plan = project.mechanicalPowerPlan!;
  const mechanicalPower = state.world.mechanicalPower;
  const source = mechanicalPower?.sources.find((candidate) => candidate.id === plan.sourceSegmentId
    && candidate.sourceKeys.length === plan.sourceKeys.length
    && candidate.sourceKeys.every((sourceKey, index) => sourceKey === plan.sourceKeys[index]));
  const availability = source && mechanicalPower
    ? waterCurrentAvailabilityFor(state.world.grid, mechanicalPower, source.id)
    : undefined;
  if (!source || !availability?.available) return null;
  const visible = new Set(cellsInRadius(
    person.position.cellId,
    4 + Math.floor(person.baselineCapacities.perception / 25),
  ));
  const target = source.requiredWaterVoxels.find((position) => visible.has(cellId(position.x, position.y))
    && voxelAt(state.world.grid, position.x, position.y, position.z) === Material.Water);
  if (!target) return null;
  const leadership = inspectProjectLeadership(project);
  const leadershipSources = leadership.status === 'led' && leadership.latestSuccession
    ? leadership.latestSuccession.sourceEventIds
    : project.triggerFactIds;
  return moveOrActStep(
    state,
    person,
    target,
    `mechanical-reobserve-current-${project.id}-${source.id}`,
    '重新观察冻结工地所依赖的实体水流',
    '接任只保留实体构件；新负责人必须在当前现场亲自重新观察水流，不能沿用发起者的私人知识',
    {
      kind: 'attend',
      target: { kind: 'voxel', position: { ...target } },
      waterCurrentSegmentId: source.id,
    },
    [...leadershipSources],
    [],
    7,
  );
}

function mechanicalPowerProjectShouldPauseForCurrentRecovery(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): boolean {
  if (!mechanicalPowerProjectHasCurrentRecoveryWait(state, person, project)) return false;
  const plan = project.mechanicalPowerPlan!;
  return !waterCurrentAvailabilityFor(
    state.world.grid,
    state.world.mechanicalPower,
    plan.sourceSegmentId,
  ).available;
}

function installStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  role: 'converter' | 'connector' | 'load',
  materialId: MaterialId,
  position: VoxelPosition,
  verified: { manufacture: ActionFact; verification: ActionFact; stack: ItemStack | null } | null,
): MechanicalPowerProjectStep | null {
  const stack = verified?.stack ?? null;
  if (!stack) return null;
  const basis = basisFor(project, 'install', {
    componentRole: role,
    componentMaterialId: materialId,
    componentPosition: { ...position },
  });
  const targets: WorldRef[] = [
    ...(stack ? [{ kind: 'inventory-stack' as const, personId: person.id, stackId: stack.id }] : []),
    { kind: 'voxel', position: { ...position } },
  ];
  return moveOrActStep(
    state,
    person,
    position,
    `mechanical-install-${role}-${positionKey(position)}`,
    `在冻结位置安装${materialDefinition(materialId).name}`,
    '经过本人制造与源事件核验的构件必须落在计划中的精确位置；旧磨坊经验只提供压力，不代替新负载',
    { kind: 'act', operation: 'exert', targets, mechanicalPowerBasis: basis },
    [...project.triggerFactIds, ...(verified ? [verified.manufacture.id, verified.verification.id] : [])],
    reservation(person, stack),
    role === 'converter' ? 2 : 1,
  );
}

function faultFact(state: SimulationState, project: ProjectState): ActionFact | null {
  return projectFacts(state, project).find((fact) => fact.status === 'progressed'
    && projectEventHasEventTimeLead(project, fact)
    && fact.diff.mechanicalPowerFault === true
    && fact.diff.networkId === project.mechanicalPowerNetworkId) ?? null;
}

function repairFact(state: SimulationState, project: ProjectState, fault: ActionFact): ActionFact | null {
  return projectFacts(state, project).find((fact) => fact.status === 'completed'
    && actionAfter(fact, fault)
    && projectEventHasEventTimeLead(project, fact)
    && fact.diff.mechanicalPowerRepair === true
    && fact.diff.faultEventId === fault.id
    && fact.diff.networkId === project.mechanicalPowerNetworkId) ?? null;
}

function operationFact(state: SimulationState, project: ProjectState, after: ActionFact): ActionFact | null {
  return projectFacts(state, project).find((fact) => fact.status === 'completed'
    && actionAfter(fact, after)
    && projectEventHasEventTimeLead(project, fact)
    && fact.diff.mechanicalPowerOperation === true
    && fact.diff.networkId === project.mechanicalPowerNetworkId
    && Number(fact.diff.inputMaterialId) === Material.Seed
    && Number(fact.diff.outputMaterialId) === Material.Food) ?? null;
}

function operateStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): MechanicalPowerProjectStep | null {
  const plan = project.mechanicalPowerPlan!;
  const input = person.inventory.find((stack) => stack.materialId === Material.Seed
    && stack.quantity > 0
    && !stack.recordPayloadId);
  if (!input) return null;
  const basis = basisFor(project, 'operate', {
    inputMaterialId: Material.Seed,
    outputMaterialId: Material.Food,
  });
  return moveOrActStep(
    state,
    person,
    plan.loadPosition,
    `mechanical-operate-${input.id}`,
    '让流水经水轮与传动轴驱动磨坊处理种子',
    '输入、流量、拓扑与故障状态都将在扣除种子前由领域执行器实时复核',
    {
      kind: 'act', operation: 'exert',
      targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: input.id },
        { kind: 'voxel', position: { ...plan.loadPosition } },
      ],
      mechanicalPowerBasis: basis,
    },
    [...project.triggerFactIds, ...input.sourceEventIds],
    reservation(person, input),
  );
}

function repairStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  fault: ActionFact,
  replacement: { manufacture: ActionFact; verification: ActionFact; stack: ItemStack | null },
): MechanicalPowerProjectStep | null {
  const network = state.world.mechanicalPower?.networks.find((candidate) => candidate.id === project.mechanicalPowerNetworkId);
  const faultState = network?.fault;
  const tool = person.inventory.find((stack) => stack.materialId === Material.BronzeTool
    && stack.quantity > 0
    && !stack.recordPayloadId);
  if (!faultState || faultState.faultEventId !== fault.id || !replacement.stack || !tool) return null;
  const basis = basisFor(project, 'repair', {
    faultEventId: fault.id,
    replacementMaterialId: Material.DriveShaft,
    toolMaterialId: Material.BronzeTool,
  });
  return moveOrActStep(
    state,
    person,
    faultState.componentPosition,
    `mechanical-repair-${fault.id}-${replacement.stack.id}-${tool.id}`,
    '用新传动轴和青铜工具修复试运转故障',
    '替换构件必须在故障之后真实制造并核验，工具与故障体素也必须仍然存在',
    {
      kind: 'act', operation: 'exert', toolStackId: tool.id,
      targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: replacement.stack.id },
        { kind: 'voxel', position: { ...faultState.componentPosition } },
      ],
      mechanicalPowerBasis: basis,
    },
    [fault.id, replacement.manufacture.id, replacement.verification.id, ...tool.sourceEventIds],
    [...reservation(person, replacement.stack), ...reservation(person, tool)],
  );
}

export function buildMechanicalPowerServiceOptions(
  state: SimulationState,
  person: PersonState,
  visibleCells: number[],
): ActionOption[] {
  const visible = new Set(visibleCells);
  const mechanicalPower = state.world.mechanicalPower;
  if (!mechanicalPower) return [];
  const operationKnowledge = reliableMechanicalOperationKnowledge(person);
  const options: ActionOption[] = [];
  for (const network of mechanicalPower.networks) {
    const installationProject = completedInstallationProjectForNetwork(state, network);
    const plan = installationProject?.mechanicalPowerPlan;
    if (!installationProject || !plan) continue;
    if (network.fault) {
      const faultEvent = currentMechanicalFaultEvent(state, network);
      const faultPosition = network.fault.componentPosition;
      const diagnosis = personalMechanicalFaultDiagnosis(state, person, network);
      if (!faultEvent || diagnosis
        || !visible.has(cellId(faultPosition.x, faultPosition.y))
        || voxelAt(state.world.grid, faultPosition.x, faultPosition.y, faultPosition.z) !== Material.BrokenDriveShaft) continue;
      const factId = mechanicalPowerFaultObservationFactId(network.id, faultEvent.id);
      options.push({
        id: `diagnose-mechanical-fault:${network.id}:${faultEvent.id}`,
        summary: '近身检查停转机械网络的断裂传动轴',
        reason: '本人眼前的完成网络已经停机，实体断轴与故障事实仍然一致；观察只形成本人诊断，不自动修复',
        goal: { kind: 'knowledge', factId, minConfidence: 55 },
        nextAction: {
          kind: 'attend',
          target: { kind: 'voxel', position: { ...faultPosition } },
          mechanicalPowerFaultObservation: {
            version: 'mechanical-power-fault-observation-v1',
            installationProjectId: installationProject.id,
            planKey: network.planKey,
            networkId: network.id,
            faultEventId: faultEvent.id,
          },
        },
        target: { kind: 'voxel', position: { ...faultPosition } },
        estimatedDuration: 'one-month',
        sourceFactIds: [faultEvent.id, ...network.fault.sourceEventIds],
        domain: 'strategic',
      });
      continue;
    }
    if (!operationKnowledge
      || !visible.has(cellId(plan.loadPosition.x, plan.loadPosition.y))
      || !plan.sourceKeys.length
      || !mechanicalPower.sources.some((source) => source.id === plan.sourceSegmentId
        && source.requiredWaterVoxels.some((position) => visible.has(cellId(position.x, position.y))))
      || !validateMechanicalPowerTopology(state.world.grid, mechanicalPower, plan).valid) continue;
    const input = person.inventory.find((stack) => stack.materialId === Material.Seed
      && stack.quantity > 0
      && !stack.recordPayloadId);
    if (!input) continue;
    const action: Extract<PrimitiveAction, { kind: 'act' }> = {
      kind: 'act', operation: 'exert',
      targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: input.id },
        { kind: 'voxel', position: { ...plan.loadPosition } },
      ],
      mechanicalPowerBasis: {
        version: MECHANICAL_POWER_ACTION_BASIS_VERSION,
        mode: 'operate-service',
        sourceSegmentId: plan.sourceSegmentId,
        sourceKeys: [...plan.sourceKeys],
        installationProjectId: installationProject.id,
        planKey: network.planKey,
        networkId: network.id,
        operationKnowledgeId: MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
        inputMaterialId: Material.Seed,
        outputMaterialId: Material.Food,
      },
    };
    const closeEnough = distanceToPosition(person, plan.loadPosition) <= 1
      && !(person.position.cellId === cellId(plan.loadPosition.x, plan.loadPosition.y)
        && (person.position.z === plan.loadPosition.z || person.position.z + 1 === plan.loadPosition.z));
    const approach = closeEnough ? null : approachPosition(state, person, plan.loadPosition);
    if (!closeEnough && !approach) continue;
    const currentFood = person.inventory.filter((stack) => stack.materialId === Material.Food)
      .reduce((sum, stack) => sum + stack.quantity, 0);
    options.push({
      id: `operate-completed-mechanical-network:${network.id}:${input.id}`,
      summary: '用现有流水机械网络继续处理种子',
      reason: network.condition <= MECHANICAL_POWER_WORN_FAULT_THRESHOLD
        ? '本人可靠掌握这类机械作业，眼前网络与真实输入仍在；磨损状态只能由这次真实负载检验暴露'
        : '本人可靠掌握这类机械作业，眼前完成网络、水流、拓扑与真实种子输入都可复核',
      goal: { kind: 'inventory-at-least', materialId: Material.Food, quantity: currentFood + 3 },
      nextAction: closeEnough
        ? action
        : { kind: 'move', toCellId: approach!.cellId, toZ: approach!.z },
      ...(!closeEnough ? { completionAction: action } : {}),
      target: { kind: 'voxel', position: { ...plan.loadPosition } },
      estimatedDuration: closeEnough ? 'one-month' : 'several-months',
      sourceFactIds: [...new Set([
        ...operationKnowledge.sourceEventIds,
        ...network.sourceEventIds,
        ...input.sourceEventIds,
      ])],
      domain: 'strategic',
    });
  }
  return options;
}

function planContractValid(project: ProjectState): boolean {
  const plan = project.mechanicalPowerPlan;
  return project.desiredFunction === 'water-powered-crop-processing'
    && Boolean(plan
      && plan.version === MECHANICAL_POWER_PLAN_VERSION
      && plan.projectId === project.id
      && project.mechanicalPowerPlanKey === mechanicalPowerPlanKey(plan)
      && project.mechanicalPowerNetworkId === mechanicalPowerNetworkId(plan));
}

function maintenancePlanContractValid(state: SimulationState, project: ProjectState): boolean {
  const plan = project.mechanicalPowerPlan;
  const installationProject = plan ? state.projects.find((candidate) => candidate.id === plan.projectId) : undefined;
  const maintenanceFunction = project.desiredFunction === 'restore-water-powered-crop-processing'
    || project.desiredFunction === 'durable-power-transmission';
  const owner = project.desiredFunction === 'durable-power-transmission'
    ? state.people.find((person) => person.id === project.ownerId)
    : undefined;
  const reliabilityContract = project.desiredFunction !== 'durable-power-transmission'
    || Boolean(owner
      && project.need === 'equipment-reliability'
      && project.mechanicalReliabilityBasis
      && project.mechanicalReliabilityBasis.networkId === project.mechanicalPowerNetworkId
      && project.mechanicalReliabilityBasis.installationProjectId === plan?.projectId
      && project.mechanicalReliabilityBasis.faults.at(-1)?.faultEventId === project.mechanicalPowerFaultEventId
      && validateMechanicalReliabilityBasis(state, owner, project.mechanicalReliabilityBasis));
  return maintenanceFunction
    && reliabilityContract
    && Boolean(project.mechanicalPowerFaultEventId
      && plan
      && plan.version === MECHANICAL_POWER_PLAN_VERSION
      && installationProject?.status === 'completed'
      && installationProject.desiredFunction === 'water-powered-crop-processing'
      && installationProject.mechanicalPowerPlanKey === mechanicalPowerPlanKey(plan)
      && installationProject.mechanicalPowerNetworkId === project.mechanicalPowerNetworkId
      && project.mechanicalPowerPlanKey === mechanicalPowerPlanKey(plan));
}

function maintenanceFaultFact(state: SimulationState, project: ProjectState): ActionFact | null {
  if (!maintenancePlanContractValid(state, project) || !project.mechanicalPowerFaultEventId) return null;
  const network = state.world.mechanicalPower?.networks.find((candidate) => candidate.id === project.mechanicalPowerNetworkId
    && candidate.planKey === project.mechanicalPowerPlanKey
    && candidate.installationProjectId === project.mechanicalPowerPlan?.projectId);
  const event = network ? worldEventById(state, project.mechanicalPowerFaultEventId) : undefined;
  return event?.kind === 'action'
    && event.diff.mechanicalPowerFault === true
    && event.diff.networkId === network?.id
    ? event
    : null;
}

function maintenanceRepairFact(
  state: SimulationState,
  project: ProjectState,
  fault: ActionFact,
): ActionFact | null {
  return projectFacts(state, project).find((fact) => fact.status === 'completed'
    && actionAfter(fact, fault)
    && fact.who === project.ownerId
    && fact.diff.mechanicalPowerRepair === true
    && fact.diff.faultEventId === fault.id
    && fact.diff.networkId === project.mechanicalPowerNetworkId) ?? null;
}

function maintenanceRecoveryFact(
  state: SimulationState,
  project: ProjectState,
  repair: ActionFact,
): ActionFact | null {
  return maintenanceRecoveryFacts(state, project, repair)[0] ?? null;
}

function maintenanceRecoveryFacts(
  state: SimulationState,
  project: ProjectState,
  repair: ActionFact,
): ActionFact[] {
  return projectFacts(state, project).filter((fact) => fact.status === 'completed'
    && actionAfter(fact, repair)
    && fact.who === project.ownerId
    && fact.diff.mechanicalPowerOperation === true
    && fact.diff.mechanicalPowerRecovery === true
    && fact.diff.networkId === project.mechanicalPowerNetworkId
    && fact.diff.recoveryRepairEventId === repair.id);
}

function maintenanceRepairStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  fault: ActionFact,
  replacement: { manufacture: ActionFact; verification: ActionFact; stack: ItemStack | null },
  replacementMaterialId: typeof Material.DriveShaft | typeof Material.SteelDriveShaft,
): MechanicalPowerProjectStep | null {
  const plan = project.mechanicalPowerPlan!;
  const network = state.world.mechanicalPower?.networks.find((candidate) => candidate.id === project.mechanicalPowerNetworkId);
  const faultState = network?.fault;
  const diagnosisKnowledgeId = mechanicalPowerFaultObservationFactId(network?.id ?? '', fault.id);
  const diagnosis = network ? personalMechanicalFaultDiagnosis(state, person, network) : null;
  const tool = person.inventory.find((stack) => stack.materialId === Material.BronzeTool
    && stack.quantity > 0
    && !stack.recordPayloadId);
  if (!network || !faultState || faultState.faultEventId !== fault.id || !diagnosis
    || diagnosis.knowledgeId !== diagnosisKnowledgeId || !replacement.stack || !tool) return null;
  const basis: MechanicalPowerActionBasis = {
    version: MECHANICAL_POWER_ACTION_BASIS_VERSION,
    mode: 'repair-service',
    sourceSegmentId: plan.sourceSegmentId,
    sourceKeys: [...plan.sourceKeys],
    installationProjectId: plan.projectId,
    maintenanceProjectId: project.id,
    planKey: project.mechanicalPowerPlanKey!,
    networkId: project.mechanicalPowerNetworkId!,
    faultEventId: fault.id,
    diagnosisFactId: diagnosis.knowledgeId,
    replacementMaterialId,
    toolMaterialId: Material.BronzeTool,
    ...(replacementMaterialId === Material.SteelDriveShaft ? {
      replacementManufactureEventId: replacement.manufacture.id,
      replacementVerificationEventId: replacement.verification.id,
    } : {}),
  };
  return moveOrActStep(
    state,
    person,
    faultState.componentPosition,
    `mechanical-maintenance-repair-${fault.id}-${replacementMaterialId}-${replacement.stack.id}-${tool.id}`,
    replacementMaterialId === Material.SteelDriveShaft
      ? '用故障后试制并核验的钢轴升级磨损停机网络'
      : '用故障后新制青铜传动轴修复磨损停机',
    replacementMaterialId === Material.SteelDriveShaft
      ? '升级维修只绑定本人的重复故障依据、当前诊断、同一项目内故障后制造与核验的钢轴以及原位断轴'
      : '维修绑定本人的实体诊断、故障后制造与核验的新轴、工具以及仍在原位的断轴',
    {
      kind: 'act', operation: 'exert', toolStackId: tool.id,
      targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: replacement.stack.id },
        { kind: 'voxel', position: { ...faultState.componentPosition } },
      ],
      mechanicalPowerBasis: basis,
    },
    [fault.id, ...diagnosis.sourceEventIds, replacement.manufacture.id, replacement.verification.id, ...tool.sourceEventIds],
    [...reservation(person, replacement.stack), ...reservation(person, tool)],
  );
}

function maintenanceRecoveryStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  repair: ActionFact,
  completedLoadedOperations = 0,
): MechanicalPowerProjectStep | null {
  const plan = project.mechanicalPowerPlan!;
  const knowledge = reliableMechanicalOperationKnowledge(person);
  const input = person.inventory.find((stack) => stack.materialId === Material.Seed
    && stack.quantity > 0
    && !stack.recordPayloadId);
  if (!knowledge || !input) return null;
  const basis: MechanicalPowerActionBasis = {
    version: MECHANICAL_POWER_ACTION_BASIS_VERSION,
    mode: 'operate-service',
    sourceSegmentId: plan.sourceSegmentId,
    sourceKeys: [...plan.sourceKeys],
    installationProjectId: plan.projectId,
    maintenanceProjectId: project.id,
    recoveryRepairEventId: repair.id,
    planKey: project.mechanicalPowerPlanKey!,
    networkId: project.mechanicalPowerNetworkId!,
    operationKnowledgeId: MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
    inputMaterialId: Material.Seed,
    outputMaterialId: Material.Food,
  };
  return moveOrActStep(
    state,
    person,
    plan.loadPosition,
    `mechanical-maintenance-recovery-${repair.id}-${completedLoadedOperations + 1}-${input.id}`,
    project.desiredFunction === 'durable-power-transmission'
      ? `钢轴升级后执行第 ${completedLoadedOperations + 1} 次真实负载复核`
      : '修复后用真实种子复核运行恢复',
    project.desiredFunction === 'durable-power-transmission'
      ? '一次恢复不能证明耐久改善；同一修复、同一网络必须连续留下多次真实输入输出与磨损事实'
      : '维修本身不能证明功能恢复；同一网络必须在当前水流与拓扑下再次完成有输入有输出的负载作业',
    {
      kind: 'act', operation: 'exert',
      targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: input.id },
        { kind: 'voxel', position: { ...plan.loadPosition } },
      ],
      mechanicalPowerBasis: basis,
    },
    [repair.id, ...knowledge.sourceEventIds, ...input.sourceEventIds],
    reservation(person, input),
  );
}

export function mechanicalPowerMaintenanceProjectStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): MechanicalPowerProjectStep | null {
  if (project.ownerId !== person.id || !maintenancePlanContractValid(state, project)) return null;
  const fault = maintenanceFaultFact(state, project);
  if (!fault) return null;
  // Repair consumes the verified replacement shaft. Once that objective fact
  // exists, its absence from inventory is expected and must not reopen the
  // manufacture step ahead of the recovery run.
  const repair = maintenanceRepairFact(state, project, fault);
  if (repair) {
    const recoveries = maintenanceRecoveryFacts(state, project, repair);
    const requiredOperations = project.desiredFunction === 'durable-power-transmission'
      ? requiredReliabilityLoadedOperations(project)
      : 1;
    return recoveries.length >= requiredOperations
      ? null
      : maintenanceRecoveryStep(state, person, project, repair, recoveries.length);
  }
  const replacementMaterialId = project.desiredFunction === 'durable-power-transmission'
    ? Material.SteelDriveShaft
    : Material.DriveShaft;
  const manufacture = manufacturedFacts(state, person, project, replacementMaterialId, fault).at(-1);
  if (manufacture && !verificationFor(state, project, manufacture, replacementMaterialId)) {
    return verificationStep(person, manufacture, replacementMaterialId);
  }
  const replacement = verifiedManufacture(state, person, project, replacementMaterialId, fault);
  if (!replacement?.stack) return mechanicalComponentManufactureStep(
    person,
    project,
    replacementMaterialId,
    project.desiredFunction === 'durable-power-transmission' ? '耐久性试验的钢制传动轴' : '磨损故障的替换传动轴',
  );
  return maintenanceRepairStep(state, person, project, fault, replacement, replacementMaterialId);
}

export function mechanicalPowerProjectStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): MechanicalPowerProjectStep | null {
  if (!projectIsLedBy(project, person.id) || !planContractValid(project)) return null;
  if (!projectLeadWaterCurrentObservation(state, person, project)) {
    return mechanicalPowerLeadObservationStep(state, person, project);
  }
  const plan = project.mechanicalPowerPlan!;
  for (const materialId of [Material.Mill, Material.WaterWheel, Material.DriveShaft]) {
    const unverified = manufacturedFacts(state, person, project, materialId).reverse().find((manufacture) => (
      !verificationFor(state, project, manufacture, materialId)
        && person.inventory.some((stack) => stack.materialId === materialId
          && stack.quantity > 0
          && stack.sourceEventIds.includes(manufacture.id))
    ));
    if (unverified) return verificationStep(person, unverified, materialId);
  }
  if (!installedAt(state, project, 'load', plan.loadPosition)) {
    const loadManufactures = manufacturedFacts(state, person, project, Material.Mill);
    const load = verifiedManufacture(state, person, project, Material.Mill);
    if (!loadManufactures.length) return manufactureStep(person, project, Material.Mill, '水力磨坊负载');
    if (!load?.stack) return manufactureStep(person, project, Material.Mill, '水力磨坊负载');
    return installStep(state, person, project, 'load', Material.Mill, plan.loadPosition, load);
  }

  for (const shaftPosition of plan.shaftPositions) {
    if (installedAt(state, project, 'connector', shaftPosition)) continue;
    const shaftManufactures = manufacturedFacts(state, person, project, Material.DriveShaft);
    const shaft = verifiedManufacture(state, person, project, Material.DriveShaft);
    if (!shaftManufactures.length || !shaft?.stack) return mechanicalComponentManufactureStep(
      person, project, Material.DriveShaft, '传动轴',
    );
    return installStep(state, person, project, 'connector', Material.DriveShaft, shaftPosition, shaft);
  }
  if (!installedAt(state, project, 'converter', plan.wheelPosition)) {
    const wheelManufactures = manufacturedFacts(state, person, project, Material.WaterWheel);
    const wheel = verifiedManufacture(state, person, project, Material.WaterWheel);
    if (!wheelManufactures.length) return manufactureStep(person, project, Material.WaterWheel, '水轮');
    if (!wheel?.stack) return manufactureStep(person, project, Material.WaterWheel, '水轮');
    return installStep(state, person, project, 'converter', Material.WaterWheel, plan.wheelPosition, wheel);
  }

  const waitingForCurrentRecovery = mechanicalPowerProjectShouldPauseForCurrentRecovery(
    state,
    person,
    project,
  );
  const fault = faultFact(state, project);
  if (!fault) return waitingForCurrentRecovery ? null : operateStep(state, person, project);
  const repair = repairFact(state, project, fault);
  if (repair) return operationFact(state, project, repair)
    ? null
    : waitingForCurrentRecovery ? null : operateStep(state, person, project);

  const replacementManufactures = manufacturedFacts(state, person, project, Material.DriveShaft, fault);
  const replacement = verifiedManufacture(state, person, project, Material.DriveShaft, fault);
  if (!replacementManufactures.length) return mechanicalComponentManufactureStep(
    person, project, Material.DriveShaft, '替换传动轴',
  );
  if (!replacement?.stack) return mechanicalComponentManufactureStep(
    person, project, Material.DriveShaft, '替换传动轴',
  );
  return repairStep(state, person, project, fault, replacement);
}

export interface MechanicalPowerMaterialRequirement {
  materialIds: MaterialId[];
  sourceFactIds: string[];
  planKnowledgeId?: string;
  unknownRecipeOutputMaterialId?: MaterialId;
}

export function mechanicalPowerMaterialRequirement(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): MechanicalPowerMaterialRequirement {
  const empty = (): MechanicalPowerMaterialRequirement => ({ materialIds: [], sourceFactIds: [] });
  const raw = (materialId: MaterialId): MechanicalPowerMaterialRequirement => ({
    materialIds: [materialId],
    sourceFactIds: [],
  });
  if (!planContractValid(project)) return empty();
  const plan = project.mechanicalPowerPlan!;
  const missingForRecipe = (materialId: MaterialId): MechanicalPowerMaterialRequirement => {
    const basis = reliableRecipeBasis(person, materialId);
    if (!basis) return {
      materialIds: [],
      sourceFactIds: [...project.triggerFactIds],
      unknownRecipeOutputMaterialId: materialId,
    };
    return {
      materialIds: basis.rule.inputs.filter((input) => person.inventory
      .filter((stack) => stack.materialId === input.materialId && stack.quantity > 0 && !stack.recordPayloadId)
      .reduce((sum, stack) => sum + stack.quantity, 0) < input.quantity)
        .map((input) => input.materialId),
      planKnowledgeId: basis.knowledgeId,
      sourceFactIds: basis.sourceFactIds,
    };
  };
  const missingForMechanicalComponent = (materialId: MaterialId): MechanicalPowerMaterialRequirement => {
    const direct = missingForRecipe(materialId);
    const pendingKnowledgeOutput = pendingProjectKnowledgeOutput(state, project);
    if (pendingKnowledgeOutput !== undefined
      && pendingKnowledgeOutput !== materialId
      && direct.materialIds.includes(pendingKnowledgeOutput)) {
      const unknownInput = missingForRecipe(pendingKnowledgeOutput);
      if (!unknownInput.planKnowledgeId) return {
        materialIds: direct.materialIds.filter((candidate) => candidate !== pendingKnowledgeOutput),
        sourceFactIds: [...new Set([...direct.sourceFactIds, ...unknownInput.sourceFactIds])],
        unknownRecipeOutputMaterialId: pendingKnowledgeOutput,
      };
    }
    if (materialId !== Material.DriveShaft || !direct.materialIds.includes(Material.Bronze)) return direct;
    const withoutBronze = direct.materialIds.filter((candidate) => candidate !== Material.Bronze);
    const bronze = missingForRecipe(Material.Bronze);
    if (!bronze.planKnowledgeId) return direct;
    return {
      materialIds: [...new Set([
      ...withoutBronze,
        ...bronze.materialIds,
      ])],
      planKnowledgeId: bronze.planKnowledgeId,
      sourceFactIds: [...new Set([...direct.sourceFactIds, ...bronze.sourceFactIds])],
    };
  };
  if (!installedAt(state, project, 'load', plan.loadPosition)) {
    if (!manufacturedFacts(state, person, project, Material.Mill).length) return missingForRecipe(Material.Mill);
    if (!verifiedManufacture(state, person, project, Material.Mill)) return empty();
    return verifiedManufacture(state, person, project, Material.Mill)?.stack ? empty() : missingForRecipe(Material.Mill);
  }
  if (plan.shaftPositions.some((position) => !installedAt(state, project, 'connector', position))) {
    const shaft = verifiedManufacture(state, person, project, Material.DriveShaft);
    return shaft?.stack ? empty() : manufacturedFacts(state, person, project, Material.DriveShaft).length
      ? empty()
      : missingForMechanicalComponent(Material.DriveShaft);
  }
  if (!installedAt(state, project, 'converter', plan.wheelPosition)) {
    if (!manufacturedFacts(state, person, project, Material.WaterWheel).length) return missingForRecipe(Material.WaterWheel);
    if (!verifiedManufacture(state, person, project, Material.WaterWheel)) return empty();
    return verifiedManufacture(state, person, project, Material.WaterWheel)?.stack ? empty() : missingForRecipe(Material.WaterWheel);
  }
  const fault = faultFact(state, project);
  if (!fault) return person.inventory.some((stack) => stack.materialId === Material.Seed && stack.quantity > 0)
    ? empty() : raw(Material.Seed);
  if (repairFact(state, project, fault)) return operationFact(state, project, repairFact(state, project, fault)!)
    || person.inventory.some((stack) => stack.materialId === Material.Seed && stack.quantity > 0)
    ? empty() : raw(Material.Seed);
  const replacement = verifiedManufacture(state, person, project, Material.DriveShaft, fault);
  if (!replacement?.stack) {
    return manufacturedFacts(state, person, project, Material.DriveShaft, fault).length
      ? empty()
      : missingForMechanicalComponent(Material.DriveShaft);
  }
  return person.inventory.some((stack) => stack.materialId === Material.BronzeTool && stack.quantity > 0)
    ? empty() : raw(Material.BronzeTool);
}

export function mechanicalPowerMaintenanceMaterialRequirement(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): MechanicalPowerMaterialRequirement {
  if (project.desiredFunction === 'durable-power-transmission') {
    return mechanicalPowerReliabilityMaterialRequirement(state, person, project);
  }
  const empty = (): MechanicalPowerMaterialRequirement => ({ materialIds: [], sourceFactIds: [] });
  const raw = (materialId: MaterialId, sourceFactIds: string[] = []): MechanicalPowerMaterialRequirement => ({
    materialIds: [materialId], sourceFactIds,
  });
  if (!maintenancePlanContractValid(state, project)) return empty();
  const fault = maintenanceFaultFact(state, project);
  if (!fault) return empty();
  const repair = maintenanceRepairFact(state, project, fault);
  if (repair) return maintenanceRecoveryFact(state, project, repair)
    || person.inventory.some((stack) => stack.materialId === Material.Seed && stack.quantity > 0)
    ? empty()
    : raw(Material.Seed, [repair.id]);
  const manufacture = manufacturedFacts(state, person, project, Material.DriveShaft, fault).at(-1);
  if (manufacture && !verificationFor(state, project, manufacture, Material.DriveShaft)) return empty();
  const replacement = verifiedManufacture(state, person, project, Material.DriveShaft, fault);
  if (!replacement?.stack) {
    if (manufacture) return empty();
    const shaft = reliableRecipeBasis(person, Material.DriveShaft);
    if (!shaft) return {
      materialIds: [],
      sourceFactIds: [fault.id, ...project.triggerFactIds],
      unknownRecipeOutputMaterialId: Material.DriveShaft,
    };
    const missing = shaft.rule.inputs.filter((input) => person.inventory
      .filter((stack) => stack.materialId === input.materialId && stack.quantity > 0 && !stack.recordPayloadId)
      .reduce((sum, stack) => sum + stack.quantity, 0) < input.quantity)
      .map((input) => input.materialId);
    if (!missing.includes(Material.Bronze)) return {
      materialIds: missing,
      planKnowledgeId: shaft.knowledgeId,
      sourceFactIds: [...new Set([fault.id, ...shaft.sourceFactIds])],
    };
    const bronze = reliableRecipeBasis(person, Material.Bronze);
    if (!bronze) return {
      materialIds: missing,
      planKnowledgeId: shaft.knowledgeId,
      sourceFactIds: [...new Set([fault.id, ...shaft.sourceFactIds])],
    };
    return {
      materialIds: [...new Set([
        ...missing.filter((materialId) => materialId !== Material.Bronze),
        ...bronze.rule.inputs.filter((input) => person.inventory
          .filter((stack) => stack.materialId === input.materialId && stack.quantity > 0 && !stack.recordPayloadId)
          .reduce((sum, stack) => sum + stack.quantity, 0) < input.quantity)
          .map((input) => input.materialId),
      ])],
      planKnowledgeId: bronze.knowledgeId,
      sourceFactIds: [...new Set([fault.id, ...shaft.sourceFactIds, ...bronze.sourceFactIds])],
    };
  }
  return person.inventory.some((stack) => stack.materialId === Material.BronzeTool
    && stack.quantity > 0
    && !stack.recordPayloadId)
    ? empty()
    : raw(Material.BronzeTool, [fault.id, replacement.verification.id]);
}

export function mechanicalPowerReliabilityMaterialRequirement(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): MechanicalPowerMaterialRequirement {
  const empty = (): MechanicalPowerMaterialRequirement => ({ materialIds: [], sourceFactIds: [] });
  const raw = (materialIds: MaterialId[], sourceFactIds: string[]): MechanicalPowerMaterialRequirement => ({
    materialIds: [...new Set(materialIds)],
    sourceFactIds: [...new Set(sourceFactIds)],
  });
  if (project.desiredFunction !== 'durable-power-transmission' || !maintenancePlanContractValid(state, project)) {
    return empty();
  }
  const fault = maintenanceFaultFact(state, project);
  if (!fault) return empty();
  const basisSources = project.mechanicalReliabilityBasis?.sourceFactIds ?? [];
  const repair = maintenanceRepairFact(state, project, fault);
  if (repair) {
    return maintenanceRecoveryFacts(state, project, repair).length >= requiredReliabilityLoadedOperations(project)
      || person.inventory.some((stack) => stack.materialId === Material.Seed && stack.quantity > 0 && !stack.recordPayloadId)
      ? empty()
      : raw([Material.Seed], [repair.id, ...basisSources]);
  }
  const manufacture = manufacturedFacts(state, person, project, Material.SteelDriveShaft, fault).at(-1);
  if (manufacture && !verificationFor(state, project, manufacture, Material.SteelDriveShaft)) return empty();
  const replacement = verifiedManufacture(state, person, project, Material.SteelDriveShaft, fault);
  if (replacement?.stack) {
    return person.inventory.some((stack) => stack.materialId === Material.BronzeTool
      && stack.quantity > 0
      && !stack.recordPayloadId)
      ? empty()
      : raw([Material.BronzeTool], [fault.id, replacement.verification.id, ...basisSources]);
  }
  if (manufacture) return empty();
  const shaftRecipe = reliableRecipeBasis(person, Material.SteelDriveShaft);
  if (shaftRecipe) return {
    materialIds: [Material.SteelDriveShaft],
    planKnowledgeId: shaftRecipe.knowledgeId,
    sourceFactIds: [...new Set([fault.id, ...basisSources, ...shaftRecipe.sourceFactIds])],
  };
  // Unknown reliability work cannot turn the desired outcome into a shopping
  // list. Until the owner personally verifies a recipe, experiments are limited
  // to material entities they already hold or can currently perceive.
  return empty();
}

export function mechanicalPowerMissingMaterials(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): MaterialId[] {
  return mechanicalPowerMaterialRequirement(state, person, project).materialIds;
}

export function mechanicalPowerCompletionEvidence(
  state: SimulationState,
  project: ProjectState,
): string[] {
  if (!planContractValid(project)) return [];
  const plan = project.mechanicalPowerPlan!;
  const network = state.world.mechanicalPower?.networks.find((candidate) => candidate.id === project.mechanicalPowerNetworkId
    && candidate.planKey === project.mechanicalPowerPlanKey
    && candidate.installationProjectId === project.id
    && candidate.sourceSegmentId === plan.sourceSegmentId);
  if (!network || network.fault || network.condition <= MECHANICAL_POWER_WORN_FAULT_THRESHOLD) return [];
  const allInstalled = plannedMechanicalPowerComponents(plan).every((planned) => network.components.some((component) => (
    component.role === planned.role
      && component.materialId === planned.materialId
      && component.projectId === project.id
      && samePosition(component.position, planned.position)
  )));
  if (!allInstalled) return [];
  const actions = projectFacts(state, project);
  const componentProvenanceComplete = plannedMechanicalPowerComponents(plan).every((planned) => {
    const component = network.components.find((candidate) => candidate.role === planned.role
      && candidate.materialId === planned.materialId
      && samePosition(candidate.position, planned.position));
    if (!component) return false;
    const installation = actions.find((fact) => fact.id === component.installationEventId
      && fact.status === 'completed'
      && projectEventHasEventTimeLead(project, fact)
      && fact.diff.mechanicalPowerInstallation === true
      && fact.diff.projectId === project.id
      && fact.diff.networkId === network.id
      && fact.diff.componentRole === planned.role
      && Number(fact.diff.componentMaterialId) === planned.materialId);
    if (!installation) return false;
    const manufacture = actions.find((fact) => component.sourceEventIds.includes(fact.id)
      && fact.status === 'completed'
      && fact.who === installation.who
      && projectEventHasEventTimeLead(project, fact)
      && fact.action.kind === 'act'
      && fact.action.operation === 'combine'
      && Number(fact.diff.outputMaterialId) === planned.materialId
      && actionAfter(installation, fact));
    return Boolean(manufacture && actions.some((fact) => component.sourceEventIds.includes(fact.id)
      && fact.status === 'completed'
      && fact.who === installation.who
      && projectEventHasEventTimeLead(project, fact)
      && fact.action.kind === 'attend'
      && fact.diff.verifiedSourceEventId === manufacture.id
      && Number(fact.diff.verifiedMaterialId) === planned.materialId
      && actionAfter(fact, manufacture)
      && actionAfter(installation, fact)));
  });
  if (!componentProvenanceComplete) return [];
  const fault = faultFact(state, project);
  if (!fault) return [];
  const repair = repairFact(state, project, fault);
  if (!repair) return [];
  const operation = operationFact(state, project, repair);
  if (!operation) return [];
  const installationIds = actions.filter((fact) => fact.status === 'completed'
    && projectEventHasEventTimeLead(project, fact)
    && fact.diff.mechanicalPowerInstallation === true
    && fact.diff.networkId === network.id).map((fact) => fact.id);
  const faultPosition = fault.diff.componentPosition as VoxelPosition | undefined;
  const repairedComponent = faultPosition ? network.components.find((component) => (
    component.role === 'connector'
      && samePosition(component.position, faultPosition)
      && component.latestRepairEventId === repair.id
  )) : undefined;
  if (installationIds.length !== plannedMechanicalPowerComponents(plan).length
    || !repairedComponent) return [];
  return [...new Set([...installationIds, fault.id, repair.id, operation.id])];
}

export function mechanicalPowerMaintenanceCompletionEvidence(
  state: SimulationState,
  project: ProjectState,
): string[] {
  if (!maintenancePlanContractValid(state, project)) return [];
  const fault = maintenanceFaultFact(state, project);
  if (!fault) return [];
  const network = state.world.mechanicalPower?.networks.find((candidate) => candidate.id === project.mechanicalPowerNetworkId
    && candidate.planKey === project.mechanicalPowerPlanKey
    && candidate.installationProjectId === project.mechanicalPowerPlan?.projectId);
  if (!network || network.fault || network.condition <= MECHANICAL_POWER_WORN_FAULT_THRESHOLD) return [];
  const diagnosisFactId = mechanicalPowerFaultObservationFactId(network.id, fault.id);
  const owner = state.people.find((person) => person.id === project.ownerId);
  const diagnosisKnowledge = owner?.knowledge.find((fact) => fact.id === diagnosisFactId
    && fact.kind === 'observation'
    && fact.confidence >= 55);
  const diagnosis = diagnosisKnowledge?.sourceEventIds.flatMap((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action' ? [event] : [];
  }).find((event) => event.status === 'completed'
    && event.who === project.ownerId
    && project.triggerFactIds.includes(event.id)
    && event.action.kind === 'attend'
    && event.action.mechanicalPowerFaultObservation?.networkId === network.id
    && event.action.mechanicalPowerFaultObservation.faultEventId === fault.id
    && event.diff.mechanicalPowerFaultDiagnosis === true);
  if (!diagnosis) return [];
  const repair = maintenanceRepairFact(state, project, fault);
  if (!repair) return [];
  const reliabilityProject = project.desiredFunction === 'durable-power-transmission';
  if (reliabilityProject && (!owner
    || project.need !== 'equipment-reliability'
    || !project.mechanicalReliabilityBasis
    || !validateMechanicalReliabilityBasis(state, owner, project.mechanicalReliabilityBasis))) return [];
  const expectedReplacementMaterialId = reliabilityProject ? Material.SteelDriveShaft : Material.DriveShaft;
  const recoveries = maintenanceRecoveryFacts(state, project, repair);
  const requiredRecoveries = reliabilityProject ? requiredReliabilityLoadedOperations(project) : 1;
  if (recoveries.length < requiredRecoveries
    || !validateMechanicalPowerTopology(state.world.grid, state.world.mechanicalPower, project.mechanicalPowerPlan!).valid) return [];
  const repairSources = Array.isArray(repair.diff.repairSourceEventIds)
    ? repair.diff.repairSourceEventIds.filter((eventId): eventId is string => typeof eventId === 'string')
    : [];
  const projectSources = new Set(project.actionEventIds);
  const replacementManufacture = projectFacts(state, project).find((event) => event.status === 'completed'
    && event.action.kind === 'act'
    && event.action.operation === 'combine'
    && Number(event.diff.outputMaterialId) === expectedReplacementMaterialId
    && repairSources.includes(event.id));
  const replacementVerification = replacementManufacture ? projectFacts(state, project).find((event) => event.status === 'completed'
    && event.action.kind === 'attend'
    && event.diff.verifiedSourceEventId === replacementManufacture.id
    && Number(event.diff.verifiedMaterialId) === expectedReplacementMaterialId
    && repairSources.includes(event.id)) : undefined;
  const faultPosition = fault.diff.componentPosition as VoxelPosition | undefined;
  const repairedComponent = faultPosition ? network.components.find((component) => component.role === 'connector'
    && samePosition(component.position, faultPosition)
    && component.materialId === expectedReplacementMaterialId
    && component.latestRepairEventId === repair.id) : undefined;
  const durableRecoveries = reliabilityProject ? recoveries.filter((recovery) => (
    Number(recovery.diff.shaftMaterialId) === Material.SteelDriveShaft
      && recovery.diff.shaftRepairEventId === repair.id
      && Number(recovery.diff.wearApplied) > 0
      && Number(recovery.diff.serviceLoadedOperationOrdinal) >= 1
  )) : recoveries;
  if (!replacementManufacture || !replacementVerification
    || Number(repair.diff.replacementMaterialId) !== expectedReplacementMaterialId
    || (reliabilityProject && (repair.diff.replacementManufactureEventId !== replacementManufacture.id
      || repair.diff.replacementVerificationEventId !== replacementVerification.id))
    || !repairedComponent
    || (reliabilityProject && (durableRecoveries.length < requiredRecoveries
      || Math.max(...durableRecoveries.map((event) => Number(event.diff.serviceLoadedOperationOrdinal)))
        < requiredRecoveries))
    || !projectSources.has(repair.id)
    || durableRecoveries.some((recovery) => !projectSources.has(recovery.id))) return [];
  return [...new Set([
    ...(project.mechanicalReliabilityBasis?.sourceFactIds ?? []),
    fault.id,
    diagnosis.id,
    replacementManufacture.id,
    replacementVerification.id,
    repair.id,
    ...durableRecoveries.map((recovery) => recovery.id),
  ])];
}
