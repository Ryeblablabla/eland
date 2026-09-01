import type { PrimitiveAction, WorldRef } from '../domain/action';
import {
  ELECTRICAL_POWER_ACTION_BASIS_VERSION,
  ELECTRICAL_POWER_LOAD_DEMAND,
  ELECTRICAL_POWER_MAX_CONDUCTORS,
  ELECTRICAL_POWER_PLAN_VERSION,
  electricalPowerNetworkId,
  electricalPowerPlanIsStructurallyValid,
  electricalPowerPlanKey,
  plannedElectricalPowerComponents,
  sameElectricalPosition,
  validateElectricalPowerTopology,
  type ElectricalPowerComponentRole,
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
import {
  MECHANICAL_POWER_OPERATION_TECHNIQUE_ID,
  mechanicalPowerPlanKey,
  validateMechanicalPowerTopology,
  waterCurrentAvailabilityFor,
  type MechanicalPowerNetworkState,
  type MechanicalPowerProjectPlan,
} from '../domain/mechanical-power';
import type { ActionFact, SimulationState } from '../domain/model';
import { isAlive, type ItemStack, type PersonState } from '../domain/person';
import type {
  ProjectReservation,
  ProjectState,
  RemoteWorkPowerPosition,
  RemoteWorkPowerTransmissionBasis,
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
import { seededFraction } from '../world/generator';

export const REMOTE_WORK_POWER_BASIS_VERSION = 'remote-work-power-transmission-basis-v1' as const;
export const REMOTE_WORK_POWER_MIN_DISTANCE = 4;
export const REMOTE_WORK_POWER_SERVICE_COUNT = 2;
export const REMOTE_WORK_POWER_REMOTE_FACT_COUNT = 2;
export const REMOTE_WORK_POWER_TRAVEL_LEG_COUNT = 3;
export const REMOTE_WORK_POWER_SOURCE_FACT_LIMIT = 7;

const ELECTRICAL_COMPONENT_MATERIAL_IDS = [
  Material.MechanicalDynamo,
  Material.CopperConductor,
  Material.ResistiveLoad,
] as const;

export interface ElectricalPowerProjectStep {
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

export interface ElectricalPowerMaterialRequirement {
  materialIds: MaterialId[];
  sourceFactIds: string[];
  planKnowledgeId?: string;
}

interface MechanicalServiceContext {
  fact: ActionFact;
  project: ProjectState;
  plan: MechanicalPowerProjectPlan;
  network: MechanicalPowerNetworkState;
}

interface WorkVisit {
  kind: 'source' | 'remote';
  fact: ActionFact;
}

function actionOrder(left: ActionFact, right: ActionFact): number {
  return left.atMonth - right.atMonth
    || left.actionTick - right.actionTick
    || left.orderInMonth - right.orderInMonth
    || left.id.localeCompare(right.id);
}

function actionAfter(candidate: ActionFact, basis: ActionFact): boolean {
  return actionOrder(candidate, basis) > 0;
}

function uniqueChronologicalFacts(facts: ActionFact[]): ActionFact[] {
  return [...new Map(facts.map((fact) => [fact.id, fact])).values()].sort(actionOrder);
}

function rememberedActionFacts(state: SimulationState, person: PersonState): ActionFact[] {
  const sourceIds = new Set(person.memories.flatMap((memory) => memory.sourceEventIds));
  return uniqueChronologicalFacts([...sourceIds].flatMap((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action' && event.who === person.id ? [event] : [];
  }));
}

function positionForFact(fact: ActionFact): RemoteWorkPowerPosition {
  return { cellId: fact.cellId, z: fact.toZ };
}

function positionKey(position: RemoteWorkPowerPosition): string {
  return `${position.cellId}:${position.z}`;
}

function sameWorkPosition(left: RemoteWorkPowerPosition, right: RemoteWorkPowerPosition): boolean {
  return left.cellId === right.cellId && left.z === right.z;
}

function routeDistance(left: RemoteWorkPowerPosition, right: RemoteWorkPowerPosition): number {
  return Math.abs(cellX(left.cellId) - cellX(right.cellId))
    + Math.abs(cellY(left.cellId) - cellY(right.cellId))
    + Math.abs(left.z - right.z);
}

function validRemoteWorkFact(fact: ActionFact): boolean {
  if (fact.status !== 'completed' || fact.cause !== 'intent') return false;
  if (fact.action.kind === 'move' || fact.action.kind === 'talk') return false;
  if (fact.action.kind === 'act') {
    if (fact.action.mechanicalPowerBasis || fact.action.electricalPowerBasis) return false;
    return fact.action.operation !== 'ingest' && fact.action.operation !== 'dehydrate';
  }
  return fact.action.kind === 'transfer' || fact.action.kind === 'attend';
}

function mechanicalServiceContext(
  state: SimulationState,
  person: PersonState,
  fact: ActionFact,
): MechanicalServiceContext | null {
  if (fact.status !== 'completed'
    || fact.who !== person.id
    || fact.action.kind !== 'act'
    || fact.diff.mechanicalPowerOperation !== true
    || Number(fact.diff.inputMaterialId) !== Material.Seed
    || Number(fact.diff.outputMaterialId) !== Material.Food
    || typeof fact.diff.installationProjectId !== 'string'
    || typeof fact.diff.networkId !== 'string'
    || typeof fact.diff.planKey !== 'string') return null;
  const knowledge = person.knowledge.find((candidate) => (
    candidate.kind === 'technique'
      && candidate.id === MECHANICAL_POWER_OPERATION_TECHNIQUE_ID
      && candidate.confidence >= 55
      && candidate.sourceEventIds.includes(fact.id)
  ));
  if (!knowledge) return null;
  const project = state.projects.find((candidate) => candidate.id === fact.diff.installationProjectId);
  const plan = project?.mechanicalPowerPlan;
  const network = state.world.mechanicalPower?.networks.find((candidate) => (
    candidate.id === fact.diff.networkId
      && candidate.installationProjectId === fact.diff.installationProjectId
      && candidate.planKey === fact.diff.planKey
  ));
  if (!project
    || project.status !== 'completed'
    || project.desiredFunction !== 'water-powered-crop-processing'
    || !plan
    || !network
    || plan.projectId !== project.id
    || mechanicalPowerPlanKey(plan) !== network.planKey
    || project.mechanicalPowerPlanKey !== network.planKey
    || project.mechanicalPowerNetworkId !== network.id
    || fact.diff.sourceSegmentId !== network.sourceSegmentId) return null;
  return { fact, project, plan, network };
}

function currentMechanicalSourceAvailable(
  state: SimulationState,
  context: MechanicalServiceContext,
): boolean {
  if (context.network.fault
    || !validateMechanicalPowerTopology(
      state.world.grid,
      state.world.mechanicalPower,
      context.plan,
    ).valid) return false;
  return waterCurrentAvailabilityFor(
    state.world.grid,
    state.world.mechanicalPower,
    context.network.sourceSegmentId,
  ).available;
}

function movedFact(fact: ActionFact): boolean {
  return fact.action.kind === 'move'
    && (fact.status === 'completed' || fact.status === 'progressed')
    && (fact.fromCellId !== fact.toCellId || fact.fromZ !== fact.toZ);
}

function representativeMoveBetween(
  remembered: ActionFact[],
  left: ActionFact,
  right: ActionFact,
): ActionFact | undefined {
  return remembered.find((fact) => movedFact(fact)
    && actionAfter(fact, left)
    && actionAfter(right, fact));
}

function alternatingVisitSequence(
  remembered: ActionFact[],
  services: ActionFact[],
  remoteFacts: ActionFact[],
): { visits: [WorkVisit, WorkVisit, WorkVisit, WorkVisit]; moves: [ActionFact, ActionFact, ActionFact] } | null {
  const visits = uniqueChronologicalFacts([
    ...services,
    ...remoteFacts,
  ]).map((fact): WorkVisit => ({
    kind: services.some((candidate) => candidate.id === fact.id) ? 'source' : 'remote',
    fact,
  }));
  for (let first = 0; first < visits.length; first += 1) {
    const selected: WorkVisit[] = [visits[first]];
    for (let index = first + 1; index < visits.length && selected.length < 4; index += 1) {
      if (visits[index].kind !== selected.at(-1)!.kind) selected.push(visits[index]);
    }
    if (selected.length !== 4) continue;
    const sourceCount = selected.filter((visit) => visit.kind === 'source').length;
    const remoteCount = selected.filter((visit) => visit.kind === 'remote').length;
    if (sourceCount !== 2 || remoteCount !== 2) continue;
    const moves = selected.slice(1).map((visit, index) => (
      representativeMoveBetween(remembered, selected[index].fact, visit.fact)
    ));
    if (moves.every((move): move is ActionFact => Boolean(move))) return {
      visits: selected as [WorkVisit, WorkVisit, WorkVisit, WorkVisit],
      moves: moves as [ActionFact, ActionFact, ActionFact],
    };
  }
  return null;
}

function transmissionBasisKey(
  observerId: string,
  networkId: string,
  sourceWorkPosition: RemoteWorkPowerPosition,
  remoteWorkPosition: RemoteWorkPowerPosition,
  serviceEventIds: readonly string[],
  remoteWorkEventIds: readonly string[],
  travelEventIds: readonly string[],
): string {
  return [
    REMOTE_WORK_POWER_BASIS_VERSION,
    `observer=${observerId}`,
    `network=${networkId}`,
    `source=${positionKey(sourceWorkPosition)}`,
    `remote=${positionKey(remoteWorkPosition)}`,
    `services=${serviceEventIds.join(',')}`,
    `work=${remoteWorkEventIds.join(',')}`,
    `travel=${travelEventIds.join(',')}`,
  ].join('|');
}

function basisForSequence(
  person: PersonState,
  atMonth: number,
  context: MechanicalServiceContext,
  sequence: NonNullable<ReturnType<typeof alternatingVisitSequence>>,
): RemoteWorkPowerTransmissionBasis {
  const sourceVisits = sequence.visits.filter((visit) => visit.kind === 'source');
  const remoteVisits = sequence.visits.filter((visit) => visit.kind === 'remote');
  const sourceWorkPosition = positionForFact(sourceVisits[0].fact);
  const remoteWorkPosition = positionForFact(remoteVisits[0].fact);
  const mechanicalServiceEventIds = sourceVisits.map((visit) => visit.fact.id) as [string, string];
  const remoteWorkEventIds = remoteVisits.map((visit) => visit.fact.id) as [string, string];
  const travelEventIds = sequence.moves.map((move) => move.id) as [string, string, string];
  const sourceFactIds = uniqueChronologicalFacts([
    ...sourceVisits.map((visit) => visit.fact),
    ...remoteVisits.map((visit) => visit.fact),
    ...sequence.moves,
  ]).map((fact) => fact.id);
  return {
    version: REMOTE_WORK_POWER_BASIS_VERSION,
    observerId: person.id,
    atMonth,
    mechanicalInstallationProjectId: context.project.id,
    mechanicalNetworkId: context.network.id,
    mechanicalPlanKey: context.network.planKey,
    sourceSegmentId: context.network.sourceSegmentId,
    sourceWorkPosition,
    remoteWorkPosition,
    mechanicalServiceEventIds,
    remoteWorkEventIds,
    travelEventIds,
    routeDistance: routeDistance(sourceWorkPosition, remoteWorkPosition),
    sourceFactIds,
    basisKey: transmissionBasisKey(
      person.id,
      context.network.id,
      sourceWorkPosition,
      remoteWorkPosition,
      mechanicalServiceEventIds,
      remoteWorkEventIds,
      travelEventIds,
    ),
  };
}

/**
 * Finds only a bounded person-local causal trace. It never scans global action
 * history or copies cumulative mechanical network provenance arrays.
 */
export function remoteWorkPowerTransmissionBasisFor(
  state: SimulationState,
  person: PersonState,
  atMonth: number,
): RemoteWorkPowerTransmissionBasis | null {
  const remembered = rememberedActionFacts(state, person).filter((fact) => fact.atMonth <= atMonth);
  const serviceContexts = remembered.flatMap((fact) => {
    const context = mechanicalServiceContext(state, person, fact);
    return context && currentMechanicalSourceAvailable(state, context) ? [context] : [];
  });
  const servicesBySource = new Map<string, MechanicalServiceContext[]>();
  for (const context of serviceContexts) {
    const position = positionForFact(context.fact);
    const key = `${context.network.id}|${positionKey(position)}`;
    const candidates = servicesBySource.get(key) ?? [];
    candidates.push(context);
    servicesBySource.set(key, candidates);
  }
  const remoteFacts = remembered.filter(validRemoteWorkFact);
  const candidates: RemoteWorkPowerTransmissionBasis[] = [];
  for (const contexts of servicesBySource.values()) {
    const services = uniqueChronologicalFacts(contexts.map((context) => context.fact));
    if (services.length < REMOTE_WORK_POWER_SERVICE_COUNT) continue;
    const sourcePosition = positionForFact(services[0]);
    const remoteByPosition = new Map<string, ActionFact[]>();
    for (const fact of remoteFacts) {
      const remotePosition = positionForFact(fact);
      if (routeDistance(sourcePosition, remotePosition) < REMOTE_WORK_POWER_MIN_DISTANCE) continue;
      const grouped = remoteByPosition.get(positionKey(remotePosition)) ?? [];
      grouped.push(fact);
      remoteByPosition.set(positionKey(remotePosition), grouped);
    }
    for (const groupedRemoteFacts of remoteByPosition.values()) {
      const remote = uniqueChronologicalFacts(groupedRemoteFacts);
      if (remote.length < REMOTE_WORK_POWER_REMOTE_FACT_COUNT) continue;
      const sequence = alternatingVisitSequence(remembered, services, remote);
      if (!sequence) continue;
      candidates.push(basisForSequence(person, atMonth, contexts[0], sequence));
    }
  }
  return candidates.sort((left, right) => right.atMonth - left.atMonth
    || right.routeDistance - left.routeDistance
    || left.basisKey.localeCompare(right.basisKey))[0] ?? null;
}

function exactIds(value: readonly string[], expectedLength: number): boolean {
  return value.length === expectedLength
    && new Set(value).size === value.length
    && value.every((id) => typeof id === 'string' && id.length > 0);
}

export function validateRemoteWorkPowerTransmissionBasis(
  state: SimulationState,
  person: PersonState,
  basis: RemoteWorkPowerTransmissionBasis,
  requireCurrentMemory = true,
): boolean {
  if (basis.version !== REMOTE_WORK_POWER_BASIS_VERSION
    || basis.observerId !== person.id
    || !exactIds(basis.mechanicalServiceEventIds, REMOTE_WORK_POWER_SERVICE_COUNT)
    || !exactIds(basis.remoteWorkEventIds, REMOTE_WORK_POWER_REMOTE_FACT_COUNT)
    || !exactIds(basis.travelEventIds, REMOTE_WORK_POWER_TRAVEL_LEG_COUNT)
    || basis.sourceFactIds.length !== REMOTE_WORK_POWER_SOURCE_FACT_LIMIT
    || new Set(basis.sourceFactIds).size !== REMOTE_WORK_POWER_SOURCE_FACT_LIMIT
    || basis.routeDistance < REMOTE_WORK_POWER_MIN_DISTANCE) return false;
  const rememberedIds = new Set(person.memories.flatMap((memory) => memory.sourceEventIds));
  if (requireCurrentMemory && basis.sourceFactIds.some((eventId) => !rememberedIds.has(eventId))) return false;
  const serviceContexts = basis.mechanicalServiceEventIds.flatMap((eventId) => {
    const event = worldEventById(state, eventId);
    const context = event?.kind === 'action' ? mechanicalServiceContext(state, person, event) : null;
    return context ? [context] : [];
  });
  if (serviceContexts.length !== REMOTE_WORK_POWER_SERVICE_COUNT
    || serviceContexts.some((context) => context.project.id !== basis.mechanicalInstallationProjectId
      || context.network.id !== basis.mechanicalNetworkId
      || context.network.planKey !== basis.mechanicalPlanKey
      || context.network.sourceSegmentId !== basis.sourceSegmentId
      || !sameWorkPosition(positionForFact(context.fact), basis.sourceWorkPosition))) return false;
  const remoteFacts = basis.remoteWorkEventIds.flatMap((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action' && event.who === person.id && validRemoteWorkFact(event) ? [event] : [];
  });
  if (remoteFacts.length !== REMOTE_WORK_POWER_REMOTE_FACT_COUNT
    || remoteFacts.some((fact) => !sameWorkPosition(positionForFact(fact), basis.remoteWorkPosition))) return false;
  const travelFacts = basis.travelEventIds.flatMap((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action' && event.who === person.id && movedFact(event) ? [event] : [];
  });
  if (travelFacts.length !== REMOTE_WORK_POWER_TRAVEL_LEG_COUNT) return false;
  const visits = uniqueChronologicalFacts([...serviceContexts.map((context) => context.fact), ...remoteFacts]);
  if (visits.length !== 4) return false;
  for (let index = 1; index < visits.length; index += 1) {
    const beforeIsSource = basis.mechanicalServiceEventIds.includes(visits[index - 1].id);
    const afterIsSource = basis.mechanicalServiceEventIds.includes(visits[index].id);
    if (beforeIsSource === afterIsSource) return false;
    if (!travelFacts.some((fact) => actionAfter(fact, visits[index - 1]) && actionAfter(visits[index], fact))) {
      return false;
    }
  }
  const chronologicalSourceIds = uniqueChronologicalFacts([
    ...serviceContexts.map((context) => context.fact),
    ...remoteFacts,
    ...travelFacts,
  ]).map((fact) => fact.id);
  if (chronologicalSourceIds.some((eventId, index) => basis.sourceFactIds[index] !== eventId)
    || basis.routeDistance !== routeDistance(basis.sourceWorkPosition, basis.remoteWorkPosition)
    || basis.basisKey !== transmissionBasisKey(
      person.id,
      basis.mechanicalNetworkId,
      basis.sourceWorkPosition,
      basis.remoteWorkPosition,
      basis.mechanicalServiceEventIds,
      basis.remoteWorkEventIds,
      basis.travelEventIds,
    )) return false;
  return currentMechanicalSourceAvailable(state, serviceContexts[0]);
}

export function remoteWorkPowerPressure(basis: RemoteWorkPowerTransmissionBasis): number {
  return Math.min(100, 18
    + basis.mechanicalServiceEventIds.length * 8
    + basis.travelEventIds.length * 6
    + Math.min(24, basis.routeDistance * 3));
}

function reliableRecipeBasis(
  state: SimulationState,
  person: PersonState,
  outputMaterialId: MaterialId,
): { rule: InventoryCombinationRule; knowledgeId: string; sourceFactIds: string[] } | null {
  for (const knowledge of person.knowledge) {
    if (knowledge.kind !== 'technique' || knowledge.confidence < 55) continue;
    const sources = knowledge.sourceEventIds.flatMap((eventId) => {
      const event = worldEventById(state, eventId);
      return event?.kind === 'action' && event.who === person.id ? [event] : [];
    });
    const response = sources.find((fact) => fact.status === 'completed'
      && fact.action.kind === 'act'
      && fact.action.operation === 'combine'
      && Number(fact.diff.outputMaterialId) === outputMaterialId
      && fact.diff.techniqueId === knowledge.id
      && fact.diff.projectHypothesisOutcome === 'response'
      && fact.diff.projectHypothesisHadReliableKnowledge === false);
    const verification = response && sources.find((fact) => fact.status === 'completed'
      && fact.action.kind === 'attend'
      && fact.diff.verifiedTechnique === true
      && fact.diff.verifiedSourceEventId === response.id
      && fact.diff.factId === knowledge.id
      && Number(fact.diff.verifiedMaterialId) === outputMaterialId
      && actionAfter(fact, response));
    if (!response || !verification) continue;
    // Only after personally sourced discovery and verification may the planner
    // resolve the ordinary manufacturing rule represented by this knowledge.
    const rule = inventoryCombinationForOutput(outputMaterialId);
    if (!rule || inventoryCombinationTechniqueId(rule) !== knowledge.id) continue;
    return {
      rule,
      knowledgeId: knowledge.id,
      sourceFactIds: [response.id, verification.id],
    };
  }
  return null;
}

export function hasReliableElectricalComponentKnowledge(
  state: SimulationState,
  person: PersonState,
): boolean {
  return ELECTRICAL_COMPONENT_MATERIAL_IDS.every((materialId) => (
    reliableRecipeBasis(state, person, materialId)
  ));
}

function componentResponseStackIds(person: PersonState, project: ProjectState): string[] {
  const componentMaterials = new Set<MaterialId>(ELECTRICAL_COMPONENT_MATERIAL_IDS);
  const verifiedResponseEvents = new Set((project.hypothesisCampaign?.attempts ?? [])
    .filter((attempt) => attempt.outcome === 'response'
      && Boolean(attempt.verifiedEventId)
      && attempt.outputMaterialId !== undefined
      && componentMaterials.has(attempt.outputMaterialId))
    .map((attempt) => attempt.eventId));
  return person.inventory.filter((stack) => stack.quantity > 0
    && componentMaterials.has(stack.materialId)
    && stack.sourceEventIds.some((eventId) => verifiedResponseEvents.has(eventId)))
    .map((stack) => stack.id);
}

/** Preserve already-discovered component entities without revealing any unseen target. */
export function electricalHypothesisProtectedSourceKeys(
  person: PersonState,
  project: ProjectState,
): string[] {
  return componentResponseStackIds(person, project)
    .map((stackId) => `inventory:${person.id}:${stackId}`);
}

function positionInsideWorld(state: SimulationState, position: ElectricalVoxelPosition): boolean {
  return position.x >= 0 && position.x < state.world.grid.width
    && position.y >= 0 && position.y < state.world.grid.depth
    && position.z >= 1 && position.z < state.world.grid.levels;
}

function bodyOccupiesOther(
  state: SimulationState,
  person: PersonState,
  position: ElectricalVoxelPosition,
): boolean {
  const targetCellId = cellId(position.x, position.y);
  return state.people.some((candidate) => candidate.id !== person.id
    && isAlive(candidate)
    && candidate.position.cellId === targetCellId
    && candidate.position.z === position.z);
}

function supportedLocalAir(
  state: SimulationState,
  person: PersonState,
  visible: ReadonlySet<number>,
  position: ElectricalVoxelPosition,
): boolean {
  return positionInsideWorld(state, position)
    && visible.has(cellId(position.x, position.y))
    && voxelAt(state.world.grid, position.x, position.y, position.z) === Material.Air
    && materialDefinition(voxelAt(state.world.grid, position.x, position.y, position.z - 1)).phase === 'solid'
    && !bodyOccupiesOther(state, person, position);
}

function voxelPositionKey(position: ElectricalVoxelPosition): string {
  return `${position.x}:${position.y}:${position.z}`;
}

function horizontalNeighbors(position: ElectricalVoxelPosition): ElectricalVoxelPosition[] {
  return [
    { x: position.x - 1, y: position.y, z: position.z },
    { x: position.x + 1, y: position.y, z: position.z },
    { x: position.x, y: position.y - 1, z: position.z },
    { x: position.x, y: position.y + 1, z: position.z },
  ];
}

function localAirPath(
  state: SimulationState,
  person: PersonState,
  visible: ReadonlySet<number>,
  from: ElectricalVoxelPosition,
  targets: ReadonlySet<string>,
): ElectricalVoxelPosition[] | null {
  const queue: ElectricalVoxelPosition[] = [from];
  const previous = new Map<string, string | null>([[voxelPositionKey(from), null]]);
  const positions = new Map<string, ElectricalVoxelPosition>([[voxelPositionKey(from), from]]);
  const distance = new Map<string, number>([[voxelPositionKey(from), 0]]);
  while (queue.length) {
    const current = queue.shift()!;
    const currentKey = voxelPositionKey(current);
    if (targets.has(currentKey)) {
      const path: ElectricalVoxelPosition[] = [];
      let key: string | null = currentKey;
      while (key) {
        path.push(positions.get(key)!);
        key = previous.get(key) ?? null;
      }
      return path.reverse();
    }
    if ((distance.get(currentKey) ?? 0) >= ELECTRICAL_POWER_MAX_CONDUCTORS + 1) continue;
    for (const next of horizontalNeighbors(current)) {
      const nextKey = voxelPositionKey(next);
      if (previous.has(nextKey) || !supportedLocalAir(state, person, visible, next)) continue;
      previous.set(nextKey, currentKey);
      positions.set(nextKey, next);
      distance.set(nextKey, (distance.get(currentKey) ?? 0) + 1);
      queue.push(next);
    }
  }
  return null;
}

function installationStand(
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
      path: findStandingPath(state.world.grid, person.position, position),
    }))
    .filter((candidate) => candidate.path.length > 0)
    .sort((left, right) => left.path.length - right.path.length
      || left.position.cellId - right.position.cellId
      || left.position.z - right.position.z);
  return candidates[0]?.position ?? null;
}

function planCandidate(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): ElectricalPowerPlan | null {
  const basis = project.remoteWorkPowerBasis;
  if (!basis
    || !validateRemoteWorkPowerTransmissionBasis(state, person, basis, false)
    || !hasReliableElectricalComponentKnowledge(state, person)) return null;
  const mechanicalProject = state.projects.find((candidate) => (
    candidate.id === basis.mechanicalInstallationProjectId
  ));
  const mechanicalPlan = mechanicalProject?.mechanicalPowerPlan;
  if (!mechanicalPlan) return null;
  const visible = new Set(cellsInRadius(
    person.position.cellId,
    4 + Math.floor(person.baselineCapacities.perception / 25),
  ));
  const generatorCandidates = mechanicalPlan.shaftPositions.flatMap((shaft) => (
    horizontalNeighbors(shaft)
  )).filter((position) => supportedLocalAir(state, person, visible, position));
  const remote = basis.remoteWorkPosition;
  const remoteCenter = { x: cellX(remote.cellId), y: cellY(remote.cellId), z: remote.z };
  const loadCandidates = [remoteCenter, ...horizontalNeighbors(remoteCenter)]
    .filter((position) => supportedLocalAir(state, person, visible, position));
  const loadKeys = new Set(loadCandidates.map(voxelPositionKey));
  const candidates = generatorCandidates.flatMap((generatorPosition) => {
    const path = localAirPath(state, person, visible, generatorPosition, loadKeys);
    if (!path
      || path.length < 3
      || path.length > ELECTRICAL_POWER_MAX_CONDUCTORS + 2
      || path.some((position) => !installationStand(state, person, position))) return [];
    const plan: ElectricalPowerPlan = {
      version: ELECTRICAL_POWER_PLAN_VERSION,
      mechanicalInstallationProjectId: basis.mechanicalInstallationProjectId,
      mechanicalNetworkId: basis.mechanicalNetworkId,
      mechanicalPlanKey: basis.mechanicalPlanKey,
      generatorPosition: { ...path[0] },
      conductorPositions: path.slice(1, -1).map((position) => ({ ...position })),
      loadPosition: { ...path.at(-1)! },
    };
    if (!electricalPowerPlanIsStructurallyValid(plan)) return [];
    return [{
      plan,
      length: path.length,
      rank: seededFraction(state.seed, `remote-work-power-plan:${person.id}:${project.id}:${electricalPowerPlanKey(plan)}`),
    }];
  });
  return candidates.sort((left, right) => left.length - right.length
    || right.rank - left.rank
    || electricalPowerPlanKey(left.plan).localeCompare(electricalPowerPlanKey(right.plan)))[0]?.plan ?? null;
}

function ensureProjectPlan(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): ElectricalPowerPlan | null {
  const existing = project.electricalPowerPlan;
  if (existing
    && electricalPowerPlanIsStructurallyValid(existing)
    && project.electricalPowerPlanKey === electricalPowerPlanKey(existing)
    && project.electricalPowerNetworkId === electricalPowerNetworkId(existing)) return existing;
  const plan = planCandidate(state, person, project);
  if (!plan) return null;
  project.electricalPowerPlan = structuredClone(plan);
  project.electricalPowerPlanKey = electricalPowerPlanKey(plan);
  project.electricalPowerNetworkId = electricalPowerNetworkId(plan);
  return project.electricalPowerPlan;
}

function projectFacts(state: SimulationState, project: ProjectState): ActionFact[] {
  return project.actionEventIds.flatMap((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action' ? [event] : [];
  }).sort(actionOrder);
}

function manufacturedFacts(
  state: SimulationState,
  project: ProjectState,
  materialId: MaterialId,
): ActionFact[] {
  return projectFacts(state, project).filter((fact) => fact.status === 'completed'
    && fact.who === project.ownerId
    && fact.action.kind === 'act'
    && fact.action.operation === 'combine'
    && Number(fact.diff.outputMaterialId) === materialId
    && typeof fact.diff.outputStackId === 'string');
}

function verificationFor(
  state: SimulationState,
  project: ProjectState,
  manufacture: ActionFact,
  materialId: MaterialId,
): ActionFact | null {
  return projectFacts(state, project).find((fact) => fact.status === 'completed'
    && fact.who === project.ownerId
    && fact.action.kind === 'attend'
    && fact.diff.verifiedSourceEventId === manufacture.id
    && Number(fact.diff.verifiedMaterialId) === materialId
    && actionAfter(fact, manufacture)) ?? null;
}

function usedManufactureIds(state: SimulationState, project: ProjectState): Set<string> {
  return new Set(projectFacts(state, project).flatMap((fact) => (
    fact.status === 'completed'
      && fact.diff.electricalPowerInstallation === true
      && fact.diff.electricalNetworkId === project.electricalPowerNetworkId
      && typeof fact.diff.manufactureEventId === 'string'
      ? [fact.diff.manufactureEventId]
      : []
  )));
}

function verifiedManufacture(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  materialId: MaterialId,
): { manufacture: ActionFact; verification: ActionFact; stack: ItemStack } | null {
  const used = usedManufactureIds(state, project);
  for (const manufacture of manufacturedFacts(state, project, materialId)) {
    if (used.has(manufacture.id)) continue;
    const verification = verificationFor(state, project, manufacture, materialId);
    const stackId = typeof manufacture.diff.outputStackId === 'string' ? manufacture.diff.outputStackId : undefined;
    const stack = stackId ? person.inventory.find((candidate) => candidate.id === stackId
      && candidate.materialId === materialId
      && candidate.quantity > 0
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
  materialId: MaterialId,
): ElectricalPowerProjectStep | null {
  const known = reliableRecipeBasis(state, person, materialId);
  if (!known) return null;
  const refs = refsForRecipe(person, known.rule);
  if (!refs) return null;
  return {
    key: `electrical-manufacture-${materialId}-${refs.map((ref) => ref.stackId).join('-')}`,
    summary: `按本人已核验的经验制造${materialDefinition(materialId).name}`,
    reason: '只有本人真实盲试并核验后的经验才能展开普通材料物流；项目功能本身没有泄露配方',
    action: { kind: 'act', operation: 'combine', targets: refs },
    sourceFactIds: [...new Set([
      ...project.triggerFactIds,
      ...known.sourceFactIds,
      ...refs.flatMap((ref) => person.inventory.find((stack) => stack.id === ref.stackId)?.sourceEventIds ?? []),
    ])],
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
  materialId: MaterialId,
): ElectricalPowerProjectStep | null {
  const stackId = typeof manufacture.diff.outputStackId === 'string' ? manufacture.diff.outputStackId : undefined;
  const stack = stackId ? person.inventory.find((candidate) => candidate.id === stackId
    && candidate.materialId === materialId
    && candidate.quantity > 0
    && candidate.sourceEventIds.includes(manufacture.id)) : undefined;
  const known = reliableRecipeBasis(state, person, materialId);
  if (!stack || !known) return null;
  return {
    key: `electrical-verify-${manufacture.id}-${stack.id}`,
    summary: `核验刚制造的${materialDefinition(materialId).name}`,
    reason: '每个实体构件都必须绑定本人这次真实制造与观察，旧物或类别知识不能替代',
    action: {
      kind: 'attend',
      target: { kind: 'inventory-stack', personId: person.id, stackId: stack.id },
      verification: { techniqueId: known.knowledgeId, sourceEventId: manufacture.id, expectedMaterialId: materialId },
    },
    target: { kind: 'inventory-stack', personId: person.id, stackId: stack.id },
    sourceFactIds: [manufacture.id, ...stack.sourceEventIds],
    missingMaterialIds: [],
    reservations: reservation(person, stack),
    planKnowledgeId: known.knowledgeId,
  };
}

function domainDistance(person: PersonState, position: ElectricalVoxelPosition): number {
  const horizontal = Math.abs(cellX(person.position.cellId) - position.x)
    + Math.abs(cellY(person.position.cellId) - position.y);
  const vertical = Math.max(0, Math.abs(person.position.z - position.z) - 1);
  return horizontal + vertical;
}

function moveOrActStep(
  state: SimulationState,
  person: PersonState,
  position: ElectricalVoxelPosition,
  key: string,
  summary: string,
  reason: string,
  action: PrimitiveAction,
  sourceFactIds: string[],
  reservations: ProjectReservation[],
  planKnowledgeId?: string,
): ElectricalPowerProjectStep | null {
  const actorOccupiesTarget = person.position.cellId === cellId(position.x, position.y)
    && person.position.z === position.z;
  if (domainDistance(person, position) <= 1 && !actorOccupiesTarget) return {
    key,
    summary,
    reason,
    action,
    target: { kind: 'voxel', position: { ...position } },
    sourceFactIds,
    missingMaterialIds: [],
    reservations,
    ...(planKnowledgeId ? { planKnowledgeId } : {}),
  };
  const stand = installationStand(state, person, position);
  if (!stand || (stand.cellId === person.position.cellId && stand.z === person.position.z)) return null;
  return {
    key: `approach-${key}-${stand.cellId}-${stand.z}`,
    summary: `靠近${summary}`,
    reason,
    action: { kind: 'move', toCellId: stand.cellId, toZ: stand.z },
    target: { kind: 'voxel', position: { ...position } },
    sourceFactIds,
    missingMaterialIds: [],
    reservations,
    ...(planKnowledgeId ? { planKnowledgeId } : {}),
  };
}

function installedAt(
  state: SimulationState,
  project: ProjectState,
  role: ElectricalPowerComponentRole,
  position: ElectricalVoxelPosition,
  materialId: MaterialId,
): boolean {
  const network = state.world.electricalPower?.networks.find((candidate) => (
    candidate.id === project.electricalPowerNetworkId
      && candidate.planKey === project.electricalPowerPlanKey
  ));
  return Boolean(network?.components.some((component) => component.role === role
    && component.materialId === materialId
    && sameElectricalPosition(component.position, position))
    && voxelAt(state.world.grid, position.x, position.y, position.z) === materialId);
}

function sourceServiceEventId(project: ProjectState): string | null {
  return project.remoteWorkPowerBasis?.mechanicalServiceEventIds.at(-1) ?? null;
}

function installStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  plan: ElectricalPowerPlan,
  component: ReturnType<typeof plannedElectricalPowerComponents>[number],
  verified: { manufacture: ActionFact; verification: ActionFact; stack: ItemStack },
): ElectricalPowerProjectStep | null {
  const serviceEventId = sourceServiceEventId(project);
  if (!serviceEventId || !project.electricalPowerPlanKey || !project.electricalPowerNetworkId) return null;
  const basis = {
    version: ELECTRICAL_POWER_ACTION_BASIS_VERSION,
    mode: 'install' as const,
    planKey: project.electricalPowerPlanKey,
    networkId: project.electricalPowerNetworkId,
    mechanicalServiceEventId: serviceEventId,
    plan: structuredClone(plan),
    componentRole: component.role,
    componentMaterialId: component.materialId,
    componentPosition: { ...component.position },
    manufactureEventId: verified.manufacture.id,
    verificationEventId: verified.verification.id,
  };
  return moveOrActStep(
    state,
    person,
    component.position,
    `electrical-install-${component.role}-${voxelPositionKey(component.position)}`,
    `实体安装${materialDefinition(component.materialId).name}`,
    '冻结几何只来自本人可见、可达的空位；领域层仍会重验机械来源、承托、实体拓扑与制造来源',
    {
      kind: 'act',
      operation: 'exert',
      targets: [
        { kind: 'inventory-stack', personId: person.id, stackId: verified.stack.id },
        { kind: 'voxel', position: { ...component.position } },
      ],
      electricalPowerBasis: basis,
    },
    [
      ...project.triggerFactIds,
      verified.manufacture.id,
      verified.verification.id,
      serviceEventId,
    ],
    reservation(person, verified.stack),
    reliableRecipeBasis(state, person, component.materialId)?.knowledgeId,
  );
}

function operateStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  plan: ElectricalPowerPlan,
): ElectricalPowerProjectStep | null {
  const serviceEventId = sourceServiceEventId(project);
  if (!serviceEventId || !project.electricalPowerPlanKey || !project.electricalPowerNetworkId) return null;
  return moveOrActStep(
    state,
    person,
    plan.loadPosition,
    `electrical-operate-${project.electricalPowerNetworkId}`,
    '在远端实体负载处试验传来的可用功',
    '只有领域层确认机械供给、容量和完整实体链后，真实电能交付才能完成项目',
    {
      kind: 'act',
      operation: 'exert',
      targets: [{ kind: 'voxel', position: { ...plan.loadPosition } }],
      electricalPowerBasis: {
        version: ELECTRICAL_POWER_ACTION_BASIS_VERSION,
        mode: 'operate',
        planKey: project.electricalPowerPlanKey,
        networkId: project.electricalPowerNetworkId,
        mechanicalServiceEventId: serviceEventId,
        requestedPowerUnits: ELECTRICAL_POWER_LOAD_DEMAND,
      },
    },
    [...project.triggerFactIds, serviceEventId],
    [],
  );
}

function projectContractValid(project: ProjectState): boolean {
  const plan = project.electricalPowerPlan;
  return project.need === 'remote-work-power'
    && project.desiredFunction === 'remote-work-power-delivery'
    && Boolean(project.remoteWorkPowerBasis)
    && Boolean(plan
      && project.electricalPowerPlanKey === electricalPowerPlanKey(plan)
      && project.electricalPowerNetworkId === electricalPowerNetworkId(plan));
}

export function electricalPowerProjectStep(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): ElectricalPowerProjectStep | null {
  if (project.ownerId !== person.id
    || project.desiredFunction !== 'remote-work-power-delivery'
    || !project.remoteWorkPowerBasis) return null;
  const plan = ensureProjectPlan(state, person, project);
  if (!plan || !projectContractValid(project)) return null;
  for (const materialId of ELECTRICAL_COMPONENT_MATERIAL_IDS) {
    const unverified = manufacturedFacts(state, project, materialId).find((manufacture) => (
      !verificationFor(state, project, manufacture, materialId)
        && person.inventory.some((stack) => stack.materialId === materialId
          && stack.quantity > 0
          && stack.sourceEventIds.includes(manufacture.id))
    ));
    if (unverified) return verificationStep(state, person, unverified, materialId);
  }
  for (const component of plannedElectricalPowerComponents(plan)) {
    if (installedAt(state, project, component.role, component.position, component.materialId)) continue;
    const verified = verifiedManufacture(state, person, project, component.materialId);
    if (verified) return installStep(state, person, project, plan, component, verified);
    return manufactureStep(state, person, project, component.materialId);
  }
  return operateStep(state, person, project, plan);
}

export function electricalPowerMaterialRequirement(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
): ElectricalPowerMaterialRequirement {
  if (project.ownerId !== person.id
    || project.desiredFunction !== 'remote-work-power-delivery'
    || !hasReliableElectricalComponentKnowledge(state, person)) return {
    materialIds: [],
    sourceFactIds: [...(project.remoteWorkPowerBasis?.sourceFactIds ?? [])],
  };
  const plan = ensureProjectPlan(state, person, project);
  if (!plan) return { materialIds: [], sourceFactIds: [...project.triggerFactIds] };
  const next = plannedElectricalPowerComponents(plan).find((component) => (
    !installedAt(state, project, component.role, component.position, component.materialId)
      && !verifiedManufacture(state, person, project, component.materialId)
  ));
  if (!next) return { materialIds: [], sourceFactIds: [...project.triggerFactIds] };
  const known = reliableRecipeBasis(state, person, next.materialId);
  return {
    materialIds: [next.materialId],
    sourceFactIds: [...new Set([
      ...project.triggerFactIds,
      ...(known?.sourceFactIds ?? []),
    ])],
    ...(known ? { planKnowledgeId: known.knowledgeId } : {}),
  };
}

export function electricalPowerProjectCompletionEvidence(
  state: SimulationState,
  project: ProjectState,
): string[] {
  if (!projectContractValid(project) || !project.electricalPowerPlan) return [];
  const network = state.world.electricalPower?.networks.find((candidate) => (
    candidate.id === project.electricalPowerNetworkId
      && candidate.planKey === project.electricalPowerPlanKey
      && electricalPowerPlanKey(candidate.plan) === project.electricalPowerPlanKey
  ));
  if (!network || !validateElectricalPowerTopology(state.world.grid, network).valid) return [];
  const actions = projectFacts(state, project);
  const delivery = [...actions].reverse().find((fact) => fact.status === 'completed'
    && fact.who === project.ownerId
    && fact.action.kind === 'act'
    && fact.action.operation === 'exert'
    && fact.diff.electricalPowerDelivered === true
    && fact.diff.electricalPowerOperation === true
    && fact.diff.electricalNetworkId === network.id
    && fact.diff.electricalPlanKey === network.planKey
    && Number(fact.diff.powerDeliveredUnits) >= ELECTRICAL_POWER_LOAD_DEMAND);
  if (!delivery) return [];
  const installations = actions.filter((fact) => fact.status === 'completed'
    && fact.diff.electricalPowerInstallation === true
    && fact.diff.electricalNetworkId === network.id
    && fact.diff.electricalPlanKey === network.planKey);
  const componentEvidence = plannedElectricalPowerComponents(project.electricalPowerPlan).flatMap((component) => {
    const matchesPosition = (value: unknown): boolean => {
      const position = value as Partial<ElectricalVoxelPosition> | undefined;
      return Number.isSafeInteger(position?.x)
        && Number.isSafeInteger(position?.y)
        && Number.isSafeInteger(position?.z)
        && sameElectricalPosition(position as ElectricalVoxelPosition, component.position);
    };
    const installation = installations.find((fact) => fact.diff.componentRole === component.role
      && Number(fact.diff.componentMaterialId) === component.materialId
      && matchesPosition(fact.diff.componentPosition));
    if (!installation
      || typeof installation.diff.manufactureEventId !== 'string'
      || typeof installation.diff.verificationEventId !== 'string') return [];
    const manufacture = worldEventById(state, installation.diff.manufactureEventId);
    const verification = worldEventById(state, installation.diff.verificationEventId);
    return manufacture?.kind === 'action'
      && manufacture.status === 'completed'
      && manufacture.who === project.ownerId
      && manufacture.action.kind === 'act'
      && manufacture.action.operation === 'combine'
      && Number(manufacture.diff.outputMaterialId) === component.materialId
      && verification?.kind === 'action'
      && verification.status === 'completed'
      && verification.who === project.ownerId
      && verification.action.kind === 'attend'
      && verification.diff.verifiedSourceEventId === manufacture.id
      && Number(verification.diff.verifiedMaterialId) === component.materialId
      && project.actionEventIds.includes(manufacture.id)
      && project.actionEventIds.includes(verification.id)
      ? [manufacture.id, verification.id, installation.id]
      : [];
  });
  const expectedEvidenceCount = plannedElectricalPowerComponents(project.electricalPowerPlan).length * 3;
  if (componentEvidence.length !== expectedEvidenceCount) return [];
  return [...new Set([
    ...project.remoteWorkPowerBasis!.sourceFactIds,
    ...componentEvidence,
    delivery.id,
  ])];
}
