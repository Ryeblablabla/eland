import { waterCurrentObservationFactId, type FactPredicate, type GroundedConversationRef, type Intent, type PrimitiveAction, type VoxelPosition, type WorldRef } from './action';
import { Material, materialDefinition, materialHas, type MaterialId } from './material';
import {
  ageMonths,
  hasHibernationEntryBodyReserve,
  hasHibernationEntryContraindication,
  HIBERNATION_ENTRY_LEGAL_RESERVE,
  HIBERNATION_PREDICTIVE_ENTRY_RESERVE,
  HIBERNATION_RECOVERY_SAFE_RESERVE,
  hibernationPhase,
  inventoryQuantity,
  isAlive,
  isDormantDehydratedHibernating,
  isRecoveringFromDehydratedHibernation,
  MIN_TEACHING_AGE_MONTHS,
  sameLocation,
  type ItemStack,
  type PersonState,
} from './person';
import type { ActionFact, DropState, SimulationState } from './model';
import { cellId, cellX, cellY, cellsInRadius, findStandingPath, setVoxel, standingMovementCost, surfaceMaterial, surfaceStandingPosition, voxelAt, type StandingPosition } from '../world/grid';
import { seededFraction } from '../world/generator';
import { communicationById } from './social-facts';
import { remember, rememberAction } from './memory';
import { recordPersonalityEvidence } from './personality';
import { recordActionOutcomeBelief } from './cognition';
import { applyRelationEvidence } from './relation';
import { activeReproductionAgreementBetween, agreementAuthorizesTransfer, agreementById, recordAgreementAction, reproductionAttemptedBetweenInMonth } from './agreement';
import { recordCollectiveAction } from './collective';
import { mandateById, mandateSupportsTransfer, recordGovernanceAction } from './governance';
import { permissionAuthorizesTransfer, permissionById, recordPermissionAction } from './permission';
import {
  exertionRuleFor,
  exertionTechniqueId,
  exertionTechniqueSummary,
  exposureRuleFor,
  exposureTechniqueId,
  exposureTechniqueSummary,
  inventoryCombinationFor,
  inventoryCombinationSummary,
  inventoryCombinationTechniqueId,
} from './interaction-rules';
import { rememberMaterialPlace } from './spatial-knowledge';
import { shelterGeometryAt } from './structure';
import { geneticKinshipRisk } from './kinship';
import { recordInteractionFailureKnowledge } from './interaction-knowledge';
import { recordWitnessedDeclarationFulfillment } from './declaration';
import { separationTechniqueId, separationTechniqueSummary, separationToolFits, voxelSeparationRuleFor } from './separation-rules';
import { canAccessContainer, containerById, containerIdAt, containerQuantity, containerRemainingCapacity, GRANARY_CAPACITY, type ContainerState } from './container';
import {
  hasGroundedConversationOpeningBasis,
  hasGroundedConversationResponse,
  worldEventById,
} from './event-index';
import { animalSpecies, isAnimalAlive } from './animal';
import {
  describeTechniqueAction,
  techniqueSupportsProjectFunction,
  type TechniqueActionDescriptor,
} from './technique-demonstration';
import type { ProjectState, ProjectTechniqueDemonstrationBasis } from './project';
import { inspectProjectMaterialContributionRequest } from './project-material-request';
import { humanReproductionCapacityFactor, HUMAN_SOFT_CARRYING_CAPACITY } from './population-capacity';
import { hasReproductiveRecoveryCondition } from './dependent-care';
import { lifePlanningStage } from './life-stage';
import { personById, projectById } from './state-index';
import {
  isActionableChaosPrediction,
  MAX_ERA_PREDICTION_HORIZON_MONTHS,
  personTrustsEraPrediction,
} from './era-prediction';
import { observedHibernationEntryEvidence } from './hibernation-entry';
import { validateWildlifeThreatResponse, wildlifeThreatResponseDiff } from './wildlife-threat';
import { huntingToolBonus, isProductionToolMaterial, productionToolMultiplier, productionToolRank } from './production-tool';
import {
  bereavementFor,
  learnOfDeath,
  memorialForRemains,
  remainsById,
} from './mortuary';
import {
  maternalFirstTeachingConfidence,
  movementMetabolicMultiplier,
  reproductiveUpperAgeMonths,
  traitStatesOf,
} from './trait';
import {
  MECHANICAL_POWER_ACTION_BASIS_VERSION,
  MECHANICAL_POWER_PLAN_VERSION,
  MECHANICAL_POWER_WORLD_VERSION,
  ensureMechanicalPowerNetwork,
  mechanicalPowerNetworkId,
  mechanicalPowerPlanKey,
  plannedMechanicalPowerComponents,
  recordMechanicalPowerFault,
  recordMechanicalPowerInstallation,
  recordMechanicalPowerOperation,
  recordMechanicalPowerRepair,
  validateMechanicalPowerTopology,
  waterCurrentAvailabilityFor,
  type MechanicalPowerActionBasis,
  type MechanicalPowerNetworkState,
  type MechanicalPowerProjectPlan,
  type MechanicalPowerWorldState,
} from './mechanical-power';

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function projectSupportsMaterialContribution(
  project: Pick<ProjectState, 'need' | 'desiredFunction'>,
): boolean {
  return project.need === 'alloy-capability'
    || project.need === 'iron-capability'
    || (project.need === 'coordination-capacity' && project.desiredFunction === 'civic-coordination');
}

function distanceToPosition(person: PersonState, position: VoxelPosition): number {
  const horizontal = Math.abs(cellX(person.position.cellId) - position.x) + Math.abs(cellY(person.position.cellId) - position.y);
  // 双脚以上两格是身体与手臂可及范围；相邻列的头部高度体素仍可被操作。
  const vertical = Math.max(0, Math.abs(person.position.z - position.z) - 1);
  return Math.max(horizontal, vertical);
}

function nearbyFacilityMaterial(
  state: SimulationState,
  person: PersonState,
  materialIds: readonly MaterialId[],
  radius = 1,
): MaterialId | undefined {
  const accepted = new Set(materialIds);
  return cellsInRadius(person.position.cellId, radius)
    .map((cell) => surfaceMaterial(state.world.grid, cell))
    .find((materialId) => accepted.has(materialId));
}

function mineralObservationId(
  materialId: MaterialId,
  position: { x: number; y: number; z: number },
): string {
  return `observation:mineral-deposit:${materialId}:${position.x}:${position.y}:${position.z}`;
}

function parsedMineralObservation(factId: string): { materialId: MaterialId; position: VoxelPosition } | null {
  const match = factId.match(/^observation:mineral-deposit:(\d+):(\d+):(\d+):(\d+)$/);
  if (!match) return null;
  const [materialId, x, y, z] = match.slice(1).map(Number);
  const mineralIds = new Set<MaterialId>([Material.CopperOre, Material.TinOre, Material.IronOre]);
  if (![materialId, x, y, z].every(Number.isSafeInteger) || !mineralIds.has(materialId)) return null;
  return { materialId, position: { x, y, z } };
}

function rememberMineralDeposit(
  person: PersonState,
  materialId: MaterialId,
  position: VoxelPosition,
  atMonth: number,
  eventId: string,
): void {
  const mineralIds = new Set<MaterialId>([Material.CopperOre, Material.TinOre, Material.IronOre]);
  if (!mineralIds.has(materialId)) return;
  rememberMaterialPlace(person, materialId, position, atMonth, eventId);
  const factId = mineralObservationId(materialId, position);
  const summary = `在格 ${position.x}, ${position.y} 观察到${materialDefinition(materialId).name}来源`;
  const known = person.knowledge.find((fact) => fact.id === factId);
  if (known) {
    known.confidence = clamp(known.confidence + 12);
    known.sourceEventIds = [...new Set([...known.sourceEventIds, eventId])].slice(-24);
  } else person.knowledge.push({
    id: factId,
    kind: 'observation',
    summary,
    confidence: 64,
    learnedAtMonth: atMonth,
    sourceEventIds: [eventId],
  });
}

function canObserveTechniqueDemonstration(observer: PersonState, actor: PersonState): boolean {
  const radius = 4 + Math.floor(observer.baselineCapacities.perception / 25);
  const horizontal = Math.abs(cellX(observer.position.cellId) - cellX(actor.position.cellId))
    + Math.abs(cellY(observer.position.cellId) - cellY(actor.position.cellId));
  return horizontal <= radius && Math.abs(observer.position.z - actor.position.z) <= 2;
}

type GroundedConversationValidation =
  | { kind: 'none' }
  | { kind: 'blocked'; reason: string }
  | {
      kind: 'valid';
      conversation: GroundedConversationRef;
      trustDelta: number;
      bondDelta: number;
    };

function sameIds(first: string[], second: string[]): boolean {
  return [...new Set(first)].sort().join(',') === [...new Set(second)].sort().join(',');
}

function groundedConversationSourceMatches(
  state: SimulationState,
  person: PersonState,
  listener: PersonState,
  content: Extract<PrimitiveAction, { kind: 'communicate' }>['content'] & { kind: 'claim' },
  conversation: GroundedConversationRef,
): boolean {
  const sources = conversation.sourceFactIds.map((sourceId) => worldEventById(state, sourceId));
  if (!sources.length || sources.some((source) => !source)) return false;
  if (conversation.topic === 'care') {
    const conditionSources = new Set(listener.conditions.flatMap((condition) => condition.sourceEventIds));
    return conversation.sourceFactIds.every((sourceId) => conditionSources.has(sourceId));
  }
  if (conversation.topic === 'hardship') {
    const conditionSources = new Set(person.conditions.flatMap((condition) => condition.sourceEventIds));
    return conversation.sourceFactIds.every((sourceId) => conditionSources.has(sourceId));
  }
  if (conversation.topic === 'gratitude') return sources.every((source) => {
    if (source?.kind === 'agreement') {
      return source.change === 'fulfilled'
        && source.partyIds.includes(person.id)
        && source.partyIds.includes(listener.id);
    }
    if (source?.kind !== 'action' || source.status !== 'completed' || source.who !== listener.id) return false;
    if (source.diff.caredPersonId === person.id) return true;
    return source.action.kind === 'transfer'
      && source.action.to.kind === 'person'
      && source.action.to.personId === person.id;
  });
  if (conversation.topic === 'shared-work') return state.projects.some((project) => {
    const participantIds = new Set([project.ownerId, ...project.contributorIds]);
    const projectSources = new Set([...project.actionEventIds, ...project.completionEventIds]);
    return participantIds.has(person.id)
      && participantIds.has(listener.id)
      && conversation.sourceFactIds.every((sourceId) => projectSources.has(sourceId));
  });
  if (conversation.topic === 'failure') {
    const failureSources = new Set(person.memories
      .filter((memory) => memory.kind === 'failure')
      .flatMap((memory) => memory.sourceEventIds));
    return conversation.sourceFactIds.every((sourceId) => failureSources.has(sourceId));
  }
  if (conversation.topic === 'discovery') {
    const knowledge = content.factId ? person.knowledge.find((fact) => fact.id === content.factId) : undefined;
    return Boolean(knowledge
      && (knowledge.kind === 'observation' || knowledge.kind === 'claim')
      && knowledge.confidence >= 55
      && conversation.sourceFactIds.every((sourceId) => knowledge.sourceEventIds.includes(sourceId)));
  }
  if (conversation.topic === 'loss') {
    const knownDeathIds = new Set((person.bereavements ?? []).map((bereavement) => bereavement.deathEventId));
    return sources.every((source) => source?.kind === 'environment'
      && source.change === 'death'
      && knownDeathIds.has(source.id));
  }
  return sources.every((source) => source?.kind === 'environment'
    && source.change === 'body'
    && typeof source.diff.bornPersonId === 'string'
    && state.people.some((child) => child.id === source.diff.bornPersonId
      && isAlive(child)
      && child.geneticParents.includes(person.id)
      && child.geneticParents.includes(listener.id)));
}

function validateGroundedConversation(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'communicate' }>,
  reached: PersonState[],
): GroundedConversationValidation {
  if (action.content.kind !== 'claim' || !action.content.conversation) return { kind: 'none' };
  const conversation = action.content.conversation;
  const listener = reached.find((candidate) => candidate.id === conversation.listenerId);
  if (conversation.version !== 'grounded-conversation-v1'
    || conversation.speakerId !== person.id
    || action.audience.length !== 1
    || action.audience[0] !== conversation.listenerId
    || !listener
    || conversation.sourceFactIds.length === 0) {
    return { kind: 'blocked', reason: '生活对话的说话者、听者或事实来源不匹配' };
  }
  if (conversation.turn === 'opening') {
    if (conversation.referenceEventId || conversation.stance) {
      return { kind: 'blocked', reason: '生活对话开场不能伪装成回应' };
    }
    const duplicate = hasGroundedConversationOpeningBasis(state, conversation.basisKey);
    if (duplicate || !groundedConversationSourceMatches(state, person, listener, action.content, conversation)) {
      return { kind: 'blocked', reason: duplicate ? '同一段生活经历已经谈过' : '生活对话没有可解析且属于双方的真实来源' };
    }
    const warmTopic = ['care', 'gratitude', 'shared-work', 'family', 'loss'].includes(conversation.topic);
    return { kind: 'valid', conversation, trustDelta: warmTopic ? 1 : 0, bondDelta: conversation.topic === 'discovery' ? 1 : 2 };
  }
  const referenceId = conversation.referenceEventId;
  const opening = referenceId ? worldEventById(state, referenceId) : undefined;
  const openingConversation = opening?.kind === 'action'
    && opening.status === 'completed'
    && opening.action.kind === 'communicate'
    && opening.action.content.kind === 'claim'
    ? opening.action.content.conversation
    : undefined;
  const duplicateResponse = Boolean(referenceId && hasGroundedConversationResponse(state, referenceId));
  if (!openingConversation
    || openingConversation.turn !== 'opening'
    || openingConversation.speakerId !== listener.id
    || openingConversation.listenerId !== person.id
    || openingConversation.topic !== conversation.topic
    || openingConversation.basisKey !== conversation.basisKey
    || !sameIds(openingConversation.sourceFactIds, conversation.sourceFactIds)
    || duplicateResponse) {
    return { kind: 'blocked', reason: duplicateResponse ? '这段生活对话已经回应过' : '回应没有引用人员与来源一致的生活对话开场' };
  }
  const supportive = conversation.stance !== 'guarded';
  return { kind: 'valid', conversation, trustDelta: supportive ? 1 : 0, bondDelta: supportive ? 2 : 1 };
}

function bodyOccupies(state: SimulationState, position: VoxelPosition): boolean {
  const targetCell = cellId(position.x, position.y);
  return state.people.some((candidate) => isAlive(candidate)
    && candidate.position.cellId === targetCell
    && (candidate.position.z === position.z || candidate.position.z + 1 === position.z));
}

function bodyStandsOn(state: SimulationState, position: VoxelPosition): boolean {
  const targetCell = cellId(position.x, position.y);
  return state.people.some((candidate) => isAlive(candidate)
    && candidate.position.cellId === targetCell
    && candidate.position.z === position.z + 1);
}

function removeEmptyStacks(person: PersonState): void {
  person.inventory = person.inventory.filter((stack) => stack.quantity > 0);
}

export function addInventory(
  person: PersonState,
  materialId: MaterialId,
  quantity: number,
  sourceEventIds: string[],
  stackId = `stack-${person.id}-${materialId}`,
  recordPayloadId?: string,
  sourceLineageKeys: string[] = [],
): ItemStack {
  const existing = person.inventory.find((stack) => stack.materialId === materialId && stack.recordPayloadId === recordPayloadId);
  if (existing) {
    existing.quantity += quantity;
    existing.sourceEventIds = [...new Set([...existing.sourceEventIds, ...sourceEventIds])].slice(-24);
    existing.sourceLineageKeys = [...new Set([
      ...(existing.sourceLineageKeys ?? []),
      ...sourceLineageKeys,
    ])].slice(-32);
    return existing;
  }
  const stack = {
    id: stackId,
    materialId,
    quantity,
    sourceEventIds: [...sourceEventIds],
    ...(sourceLineageKeys.length ? { sourceLineageKeys: [...new Set(sourceLineageKeys)].slice(-32) } : {}),
    ...(recordPayloadId ? { recordPayloadId } : {}),
  };
  person.inventory.push(stack);
  return stack;
}

function addContainerInventory(
  container: ContainerState,
  materialId: MaterialId,
  quantity: number,
  sourceEventIds: string[],
  stackId: string,
  recordPayloadId?: string,
  sourceLineageKeys: string[] = [],
): ItemStack {
  const existing = container.inventory.find((stack) => stack.materialId === materialId && stack.recordPayloadId === recordPayloadId);
  if (existing) {
    existing.quantity += quantity;
    existing.sourceEventIds = [...new Set([...existing.sourceEventIds, ...sourceEventIds])].slice(-24);
    existing.sourceLineageKeys = [...new Set([
      ...(existing.sourceLineageKeys ?? []),
      ...sourceLineageKeys,
    ])].slice(-32);
    return existing;
  }
  const stack = {
    id: stackId,
    materialId,
    quantity,
    sourceEventIds: [...sourceEventIds],
    ...(sourceLineageKeys.length ? { sourceLineageKeys: [...new Set(sourceLineageKeys)].slice(-32) } : {}),
    ...(recordPayloadId ? { recordPayloadId } : {}),
  };
  container.inventory.push(stack);
  return stack;
}

export function addDrop(
  state: SimulationState,
  materialId: MaterialId,
  quantity: number,
  cell: number,
  atMonth: number,
  sourceEventIds: string[],
  idHint: string,
  recordPayloadId?: string,
  z?: number,
  sourceLineageKeys: string[] = [],
  estateOfPersonId?: string,
): DropState {
  const resolvedZ = z ?? surfaceStandingPosition(state.world.grid, cell)?.z ?? 1;
  const existing = state.world.drops.find((drop) => drop.cellId === cell
    && drop.z === resolvedZ
    && drop.materialId === materialId
    && drop.recordPayloadId === recordPayloadId
    && drop.estateOfPersonId === estateOfPersonId
    && drop.quantity > 0);
  if (existing) {
    existing.quantity += quantity;
    existing.sourceEventIds = [...new Set([...existing.sourceEventIds, ...sourceEventIds])].slice(-24);
    existing.sourceLineageKeys = [...new Set([
      ...(existing.sourceLineageKeys ?? []),
      ...sourceLineageKeys,
    ])].slice(-32);
    return existing;
  }
  const drop: DropState = {
    id: `drop-${atMonth}-${idHint}-${state.world.drops.length}`,
    materialId,
    cellId: cell,
    z: resolvedZ,
    quantity,
    createdAtMonth: atMonth,
    sourceEventIds: [...sourceEventIds],
    ...(sourceLineageKeys.length ? { sourceLineageKeys: [...new Set(sourceLineageKeys)].slice(-32) } : {}),
    ...(recordPayloadId ? { recordPayloadId } : {}),
    ...(estateOfPersonId ? { estateOfPersonId } : {}),
  };
  state.world.drops.push(drop);
  return drop;
}

function conditionWorkMultiplier(person: PersonState): number {
  let multiplier = 1;
  if (person.body.hydration < 10) multiplier *= 0.35;
  else if (person.body.hydration < 35) multiplier *= 0.75;
  if (person.body.nutrition < 10) multiplier *= 0.45;
  else if (person.body.nutrition < 35) multiplier *= 0.8;
  if (person.body.hydration >= 60 && person.body.nutrition >= 70) multiplier *= 1.1;
  for (const condition of person.conditions) {
    if (condition.kind === 'cold') multiplier *= [1, 0.85, 0.65, 0.4][condition.stage];
    if (condition.kind === 'heat') multiplier *= [1, 0.9, 0.7, 0.45][condition.stage];
    if (condition.kind === 'wound' || condition.kind === 'illness') multiplier *= [1, 0.88, 0.68, 0.45][condition.stage];
    if (condition.kind === 'aging') multiplier *= [1, 0.95, 0.8, 0.55][condition.stage];
    if (condition.kind === 'pregnancy') multiplier *= condition.stage >= 3 ? 0.65 : 0.88;
    if (condition.kind === 'postpartum-recovery') multiplier *= condition.stage >= 3 ? 0.78 : condition.stage === 2 ? 0.88 : 0.96;
    if (condition.kind === 'restrained') multiplier *= 0.25;
  }
  return Math.max(0.2, Math.min(1.5, multiplier));
}

export function goalSatisfied(state: SimulationState, person: PersonState, goal: FactPredicate): boolean {
  if (goal.kind === 'body-at-least') return person.body[goal.field] >= goal.value;
  if (goal.kind === 'body-at-most') return (personById(state, goal.personId)?.body[goal.field] ?? Number.POSITIVE_INFINITY) <= goal.value;
  if (goal.kind === 'inventory-at-least') {
    const owner = goal.personId ? personById(state, goal.personId) : person;
    return owner ? inventoryQuantity(owner, goal.materialId) >= goal.quantity : false;
  }
  if (goal.kind === 'record-held') {
    const owner = goal.personId ? personById(state, goal.personId) : person;
    return owner?.inventory.some((stack) => stack.quantity > 0 && stack.recordPayloadId === goal.recordId) ?? false;
  }
  if (goal.kind === 'container-inventory-at-least') {
    const container = containerById(state, goal.containerId);
    return Boolean(container && containerQuantity(container, goal.materialId) >= goal.quantity);
  }
  if (goal.kind === 'at-cell') return person.position.cellId === goal.cellId;
  if (goal.kind === 'sheltered') return Boolean(shelterGeometryAt(state.world.grid, person.position));
  if (goal.kind === 'voxel-is') return voxelAt(state.world.grid, goal.position.x, goal.position.y, goal.position.z) === goal.materialId;
  if (goal.kind === 'knowledge') return (goal.personId ? personById(state, goal.personId) : person)?.knowledge.some((fact) => fact.id === goal.factId && fact.confidence >= (goal.minConfidence ?? 0)) ?? false;
  if (goal.kind === 'near-person') {
    const other = personById(state, goal.personId);
    return Boolean(other && sameLocation(person, other));
  }
  if (goal.kind === 'condition') {
    const matchingCondition = personById(state, goal.personId)
      ?.conditions.find((condition) => condition.kind === goal.condition);
    if (!goal.present) return matchingCondition === undefined;
    return Boolean(matchingCondition && (!goal.phase || hibernationPhase(matchingCondition) === goal.phase));
  }
  if (goal.kind === 'project-completed') return projectById(state, goal.projectId)?.status === 'completed';
  if (goal.kind === 'technique-demonstrated') return projectById(state, goal.projectId)
    ?.techniqueDemonstrations?.some((basis) => basis.requestEventId === goal.requestEventId) ?? false;
  if (goal.kind === 'agreement-fulfilled') return agreementById(state, goal.agreementId)?.status === 'fulfilled';
  if (goal.kind === 'death-mourned') return bereavementFor(person, goal.remainsId)?.lastMournedAtMonth !== undefined;
  if (goal.kind === 'remains-interred') return remainsById(state, goal.remainsId)?.status === 'interred';
  if (goal.kind === 'memorial-marked') return Boolean(memorialForRemains(state, goal.remainsId));
  return Boolean(communicationById(state, goal.representationId));
}

function targetCell(state: SimulationState, target: WorldRef): number | null {
  if (target.kind === 'voxel') return cellId(target.position.x, target.position.y);
  if (target.kind === 'drop') return state.world.drops.find((drop) => drop.id === target.dropId)?.cellId ?? null;
  if (target.kind === 'container') {
    const container = containerById(state, target.containerId);
    return container ? cellId(container.position.x, container.position.y) : null;
  }
  if (target.kind === 'person') return personById(state, target.personId)?.position.cellId ?? null;
  if (target.kind === 'animal') return state.world.animals.find((animal) => animal.id === target.animalId)?.position.cellId ?? null;
  if (target.kind === 'remains') return remainsById(state, target.remainsId)?.position.cellId ?? null;
  return personById(state, target.personId)?.position.cellId ?? null;
}

function compactTraversedSurface(state: SimulationState, path: StandingPosition[], eventId: string): Array<{ cellId: number; z: number; from: MaterialId; to: MaterialId }> {
  const changes: Array<{ cellId: number; z: number; from: MaterialId; to: MaterialId }> = [];
  state.world.traffic ??= {};
  for (const traversed of path.slice(1)) {
    const trafficKey = `${traversed.cellId}:${traversed.z}`;
    const priorTraffic = state.world.traffic[trafficKey] ?? 0;
    state.world.traffic[trafficKey] = priorTraffic + 1;
    const x = cellX(traversed.cellId);
    const y = cellY(traversed.cellId);
    const supportZ = traversed.z - 1;
    const from = voxelAt(state.world.grid, x, y, supportZ);
    const to = from === Material.Grass && priorTraffic >= 2
      ? Material.Soil
      : from === Material.Soil && priorTraffic >= 6
        ? Material.PackedSoil
        : from;
    if (to === from) continue;
    setVoxel(state.world.grid, x, y, supportZ, to);
    changes.push({ cellId: traversed.cellId, z: supportZ, from, to });
  }
  void eventId;
  return changes;
}

function executeMove(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'move' }>, eventId: string, atMonth: number) {
  if (isDormantDehydratedHibernating(person)) return { status: 'blocked' as const, path: [person.position.cellId], result: '处于低代谢休眠，无法移动', diff: {} };
  if (person.conditions.some((condition) => condition.kind === 'restrained')) return { status: 'blocked' as const, path: [person.position.cellId], result: '身体受到拘束，无法远距离移动', diff: {} };
  const threatValidation = action.wildlifeThreatBasis
    ? action.toZ === undefined
      ? { valid: false as const, reason: '野兽威胁响应缺少精确站立高度' }
      : validateWildlifeThreatResponse(
        state,
        person,
        atMonth,
        { cellId: action.toCellId, z: action.toZ },
        action.wildlifeThreatBasis,
      )
    : null;
  if (threatValidation && !threatValidation.valid) return {
    status: 'blocked' as const,
    path: [person.position.cellId],
    result: threatValidation.reason,
    diff: { wildlifeThreatResponse: true, wildlifeThreatResponseInvalidated: true },
  };
  const fullPath = findStandingPath(state.world.grid, person.position, { cellId: action.toCellId, ...(action.toZ === undefined ? {} : { z: action.toZ }) });
  if (!fullPath.length) return { status: 'blocked' as const, path: [person.position.cellId], result: '目标地表当前不可达', diff: {} };
  // 一个规则刻度最多跨越一条相邻边。能力和身体状态改变代价，不改变空间连续性。
  const segment = fullPath.length > 1 ? fullPath.slice(0, 2) : [fullPath[0]];
  const from = { cellId: person.position.cellId, z: person.position.z };
  const to = segment.at(-1) ?? from;
  const moved = to.cellId !== from.cellId || to.z !== from.z;
  const spent = moved ? standingMovementCost(state.world.grid, from, to) / conditionWorkMultiplier(person) : 0;
  person.position.cellId = to.cellId;
  person.position.z = to.z;
  if (moved) person.position.lastPath.push(to.cellId);
  const carried = !moved ? [] : state.people.filter((candidate) => isAlive(candidate)
    && candidate.position.cellId === from.cellId
    && candidate.position.z === from.z
    && candidate.geneticParents.includes(person.id)
    && lifePlanningStage(candidate, atMonth) === 'dependent-child'
    && !isDormantDehydratedHibernating(candidate));
  for (const dependent of carried) {
    dependent.position.cellId = to.cellId;
    dependent.position.z = to.z;
    dependent.position.lastPath.push(to.cellId);
  }
  const carriedRemains = moved
    ? (state.world.remains ?? []).filter((remains) => remains.carriedByPersonId === person.id)
    : [];
  for (const remains of carriedRemains) remains.position = { cellId: to.cellId, z: to.z };
  const movementMetabolism = movementMetabolicMultiplier(person);
  person.body.hydration = clamp(person.body.hydration - Math.max(0, segment.length - 1) * 0.25 * movementMetabolism);
  person.body.nutrition = clamp(person.body.nutrition - Math.max(0, segment.length - 1) * 0.16 * movementMetabolism);
  const materialChanges = compactTraversedSurface(state, segment, eventId);
  const reached = to.cellId === action.toCellId && (action.toZ === undefined || to.z === action.toZ);
  const threatDiff = action.wildlifeThreatBasis
    ? wildlifeThreatResponseDiff(from, to, action.wildlifeThreatBasis)
    : {};
  return {
    status: reached ? 'completed' as const : 'progressed' as const,
    path: segment.map((position) => position.cellId),
    result: action.wildlifeThreatBasis
      ? action.wildlifeThreatBasis.response === 'shelter-step'
        ? `${person.name}向真实住所移动一步，避开可见野兽威胁`
        : action.wildlifeThreatBasis.response === 'flee-step'
          ? `${person.name}与可见野兽拉开距离`
          : `${person.name}无安全退路，原地警戒野兽`
      : reached ? `沿可容身空间到达格 ${cellX(to.cellId)}, ${cellY(to.cellId)} 的高度 ${to.z}` : `沿可容身空间推进了 ${moved ? 1 : 0} 步`,
    diff: {
      spentWork: spent,
      movementMetabolism,
      verticalPath: segment.map((position) => position.z),
      materialChanges,
      ...threatDiff,
      ...(carried.length ? { carriedPersonIds: carried.map((dependent) => dependent.id) } : {}),
      ...(carriedRemains.length ? { carriedRemainsIds: carriedRemains.map((remains) => remains.id) } : {}),
    },
  };
}

function executeTransfer(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'transfer' }>, atMonth: number, eventId: string) {
  let available = 0;
  let sourceDrop: DropState | undefined;
  let sourcePerson: PersonState | undefined;
  let sourceContainer: ContainerState | undefined;
  let sourceStack: ItemStack | undefined;
  if (action.from.kind === 'ground') {
    const groundCellId = action.from.cellId;
    sourceDrop = state.world.drops.find((drop) => (action.dropId ? drop.id === action.dropId : drop.cellId === groundCellId && drop.materialId === action.materialId));
    const sourceZ = action.from.z ?? sourceDrop?.z;
    if (groundCellId !== person.position.cellId || sourceZ !== person.position.z) return { status: 'blocked' as const, result: '不在地面物品所在位置', diff: {} };
    available = sourceDrop?.quantity ?? 0;
  } else if (action.from.kind === 'person') {
    const sourcePersonId = action.from.personId;
    sourcePerson = personById(state, sourcePersonId);
    if (!sourcePerson || !sameLocation(sourcePerson, person)) return { status: 'blocked' as const, result: '物品持有者不在近身范围', diff: {} };
    sourceStack = sourcePerson.inventory.find((stack) => (action.stackId ? stack.id === action.stackId : stack.materialId === action.materialId));
    available = sourceStack?.quantity ?? 0;
  } else {
    sourceContainer = containerById(state, action.from.containerId);
    if (!sourceContainer || !canAccessContainer(person, sourceContainer)) return { status: 'blocked' as const, result: '不在容器的近身操作范围', diff: {} };
    sourceStack = sourceContainer.inventory.find((stack) => (action.stackId ? stack.id === action.stackId : stack.materialId === action.materialId));
    available = sourceStack?.quantity ?? 0;
  }
  if (available <= 0) return { status: 'blocked' as const, result: '来源中已经没有这种物质', diff: {} };
  const estateCareRemains = action.estateCarePersonId
    ? (state.world.remains ?? []).find((remains) => remains.personId === action.estateCarePersonId)
    : undefined;
  if (action.estateCarePersonId
    && (!sourceDrop
      || sourceDrop.estateOfPersonId !== action.estateCarePersonId
      || !estateCareRemains
      || !bereavementFor(person, estateCareRemains.id))) {
    return { status: 'blocked' as const, result: '收拢遗物必须绑定本人知晓的死者与其真实地面遗物', diff: {} };
  }
  let destinationPerson: PersonState | undefined;
  let destinationContainer: ContainerState | undefined;
  if (action.to.kind === 'person') {
    const receiverId = action.to.personId;
    destinationPerson = personById(state, receiverId);
    if (!destinationPerson || !sameLocation(destinationPerson, person)) return { status: 'blocked' as const, result: '接收者不在近身范围', diff: {} };
  } else if (action.to.kind === 'container') {
    destinationContainer = containerById(state, action.to.containerId);
    if (!destinationContainer || !canAccessContainer(person, destinationContainer)) return { status: 'blocked' as const, result: '目标容器不在近身操作范围', diff: {} };
  } else {
    const destinationZ = action.to.z ?? person.position.z;
    if (action.to.cellId !== person.position.cellId || destinationZ !== person.position.z) {
      return { status: 'blocked' as const, result: '只能把物品放到本人当前所在的地面位置', diff: {} };
    }
  }
  const containerCapacity = destinationContainer ? containerRemainingCapacity(destinationContainer) : Number.POSITIVE_INFINITY;
  if (containerCapacity <= 0) return { status: 'blocked' as const, result: '目标容器已经没有可用容量', diff: { containerId: destinationContainer?.id } };
  const quantity = Math.max(1, Math.min(action.quantity, available, containerCapacity));
  const possibleAgreement = action.authorizationRef ? agreementById(state, action.authorizationRef) : undefined;
  const agreementAuthorized = agreementAuthorizesTransfer(possibleAgreement, person.id, action, quantity);
  const possiblePermission = action.authorizationRef ? permissionById(state, action.authorizationRef) : undefined;
  const permissionAuthorized = permissionAuthorizesTransfer(possiblePermission, person.id, action, atMonth, quantity);
  const possibleMandate = action.authorizationRef ? mandateById(state, action.authorizationRef) : undefined;
  const mandateUse = mandateSupportsTransfer(state, possibleMandate, person.id, action, atMonth);
  const mandateAuthorized = Boolean(mandateUse);
  const referencedNorm = agreementAuthorized ? possibleAgreement : permissionAuthorized ? possiblePermission : mandateAuthorized ? possibleMandate : undefined;
  // 容器目前只是空间持有者，不自带所有权；以后由 claim/title 决定规范授权。
  const authorized = action.from.kind === 'ground' || action.from.kind === 'container' || action.from.personId === person.id || agreementAuthorized || permissionAuthorized || mandateAuthorized;
  const witnessedBy = state.people.filter((candidate) => sameLocation(candidate, person)).map((candidate) => candidate.id);
  if (!authorized && sourcePerson && sourcePerson.body.health > 20 && !sourcePerson.conditions.some((condition) => condition.kind === 'restrained')) {
    const relation = sourcePerson.relations.find((item) => item.personId === person.id);
    if (relation) {
      applyRelationEvidence(sourcePerson, person.id, eventId, { trust: -7, fear: 3 });
    }
    return { status: 'blocked' as const, result: `${sourcePerson.name}阻止了未经授权的取物`, diff: { authorized: false, attempted: true, resistedBy: sourcePerson.id, witnessedBy } };
  }
  if (sourceDrop) sourceDrop.quantity -= quantity;
  if (sourceStack && sourcePerson) {
    sourceStack.quantity -= quantity;
    removeEmptyStacks(sourcePerson);
  }
  if (sourceStack && sourceContainer) {
    sourceStack.quantity -= quantity;
    sourceContainer.inventory = sourceContainer.inventory.filter((stack) => stack.quantity > 0);
    sourceContainer.sourceEventIds = [...new Set([...sourceContainer.sourceEventIds, eventId])].slice(-24);
  }
  if (!authorized && sourcePerson) {
    for (const witness of state.people.filter((candidate) => witnessedBy.includes(candidate.id) && candidate.id !== person.id)) {
      applyRelationEvidence(witness, person.id, eventId, { trust: witness.id === sourcePerson.id ? -12 : -5, fear: witness.id === sourcePerson.id ? 8 : 2 });
    }
  }
  const sourceEventIds = [...new Set([
    ...(sourceDrop?.sourceEventIds ?? []),
    ...(sourceStack?.sourceEventIds ?? []),
    eventId,
  ])];
  const sourceLineageKeys = [...new Set([
    ...(sourceDrop ? [`drop:${sourceDrop.id}`, ...(sourceDrop.sourceLineageKeys ?? [])] : []),
    ...(sourceStack && sourcePerson
      ? [`inventory:${sourcePerson.id}:${sourceStack.id}`, ...(sourceStack.sourceLineageKeys ?? [])]
      : []),
    ...(sourceStack && sourceContainer
      ? [`container:${sourceContainer.id}:${sourceStack.id}`, ...(sourceStack.sourceLineageKeys ?? [])]
      : []),
  ])];
  if (sourceDrop) {
    rememberMineralDeposit(person, sourceDrop.materialId, {
      x: cellX(sourceDrop.cellId),
      y: cellY(sourceDrop.cellId),
      z: sourceDrop.z,
    }, atMonth, eventId);
  }
  if (destinationPerson) {
    addInventory(
      destinationPerson,
      action.materialId,
      quantity,
      sourceEventIds,
      `stack-${destinationPerson.id}-${action.materialId}-${atMonth}`,
      sourceStack?.recordPayloadId ?? sourceDrop?.recordPayloadId,
      sourceLineageKeys,
    );
    if (destinationPerson.id !== person.id && !referencedNorm) {
      const relation = destinationPerson.relations.find((item) => item.personId === person.id);
      if (relation) {
        applyRelationEvidence(destinationPerson, person.id, eventId, { trust: authorized ? 3 : -8, bond: authorized ? 2 : -5 });
      }
    }
  } else if (destinationContainer) {
    addContainerInventory(
      destinationContainer,
      action.materialId,
      quantity,
      sourceEventIds,
      `stack-${destinationContainer.id}-${action.materialId}-${atMonth}`,
      sourceStack?.recordPayloadId ?? sourceDrop?.recordPayloadId,
      sourceLineageKeys,
    );
    destinationContainer.sourceEventIds = [...new Set([...destinationContainer.sourceEventIds, eventId])].slice(-24);
  } else if (action.to.kind === 'ground') {
    addDrop(
      state,
      action.materialId,
      quantity,
      action.to.cellId,
      atMonth,
      sourceEventIds,
      `${person.id}-put`,
      sourceStack?.recordPayloadId ?? sourceDrop?.recordPayloadId,
      action.to.z ?? person.position.z,
      sourceLineageKeys,
    );
  }
  state.world.drops = state.world.drops.filter((drop) => drop.quantity > 0);
  return {
    status: 'completed' as const,
    result: `${materialDefinition(action.materialId).name} × ${quantity} ${authorized ? '改变了持有者' : '被未经授权地取走'}`,
    diff: {
      materialId: action.materialId,
      quantity,
      authorized,
      agreementAuthorized,
      permissionAuthorized,
      mandateAuthorized,
      mandateUse,
      from: action.from,
      to: action.to,
      witnessedBy,
      sourceEventIds: sourceEventIds.slice(-24),
      sourceLineageKeys: sourceLineageKeys.slice(-32),
      ...((sourceStack?.recordPayloadId ?? sourceDrop?.recordPayloadId) ? { recordPayloadId: sourceStack?.recordPayloadId ?? sourceDrop?.recordPayloadId } : {}),
      ...(sourceDrop?.estateOfPersonId ? { estateOfPersonId: sourceDrop.estateOfPersonId } : {}),
      ...(action.estateCarePersonId ? { estateCare: true, estateCarePersonId: action.estateCarePersonId } : {}),
    },
  };
}

function consumeStack(person: PersonState, stack: ItemStack): { materialId: MaterialId; nutrition: number; hydration: number; health: number } {
  const definition = materialDefinition(stack.materialId);
  stack.quantity -= 1;
  removeEmptyStacks(person);
  const nutrition = definition.consume?.nutrition ?? 0;
  const hydration = definition.consume?.hydration ?? 0;
  const health = definition.consume?.health ?? 0;
  person.body.nutrition = clamp(person.body.nutrition + nutrition);
  person.body.hydration = clamp(person.body.hydration + hydration);
  person.body.health = clamp(person.body.health + health);
  return { materialId: definition.id, nutrition, hydration, health };
}

function executeIngest(state: SimulationState, person: PersonState, targets: WorldRef[], atMonth: number, eventId: string) {
  const target = targets[0];
  if (!target) return { status: 'failed' as const, result: '没有摄入对象', diff: {} };
  if (target.kind === 'inventory-stack') {
    if (target.personId !== person.id) return { status: 'blocked' as const, result: '不能直接摄入他人背包物品', diff: {} };
    const stack = person.inventory.find((candidate) => candidate.id === target.stackId && candidate.quantity > 0);
    if (!stack || (!materialHas(stack.materialId, 'edible') && !materialHas(stack.materialId, 'drinkable'))) return { status: 'blocked' as const, result: '目标当前不可摄入', diff: {} };
    const consumedStackId = stack.id;
    const consumedSourceEventIds = [...stack.sourceEventIds].slice(-24);
    const consumedSourceLineageKeys = [...(stack.sourceLineageKeys ?? [])].slice(-32);
    const consumed = consumeStack(person, stack);
    return {
      status: 'completed' as const,
      result: `摄入了${materialDefinition(consumed.materialId).name}`,
      diff: { ...consumed, consumedStackId, consumedSourceEventIds, consumedSourceLineageKeys },
    };
  }
  if (target.kind === 'voxel') {
    const materialId = voxelAt(state.world.grid, target.position.x, target.position.y, target.position.z);
    if (distanceToPosition(person, target.position) > 1 || !materialHas(materialId, 'drinkable')) return { status: 'blocked' as const, result: '饮用物不在近身范围', diff: {} };
    const consumed = materialDefinition(materialId).consume ?? {};
    person.body.hydration = clamp(person.body.hydration + (consumed.hydration ?? 0));
    person.body.nutrition = clamp(person.body.nutrition + (consumed.nutrition ?? 0));
    person.body.health = clamp(person.body.health + (consumed.health ?? 0));
    rememberMaterialPlace(person, materialId, target.position, atMonth, eventId);
    return { status: 'completed' as const, result: `从地表摄入了${materialDefinition(materialId).name}`, diff: { materialId, ...consumed } };
  }
  return { status: 'blocked' as const, result: '这个对象不能被摄入', diff: {} };
}

function executeSeparate(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'act' }>, atMonth: number, eventId: string) {
  const targets = action.targets;
  const target = targets[0];
  if (target?.kind === 'person') {
    const restrainedCandidate = personById(state, target.personId);
    const restrained = restrainedCandidate && sameLocation(restrainedCandidate, person) ? restrainedCandidate : undefined;
    const condition = restrained?.conditions.find((item) => item.kind === 'restrained');
    if (!restrained || !condition) return { status: 'blocked' as const, result: '近身目标身上没有可分离的拘束物质', diff: {} };
    const selfRelease = restrained.id === person.id;
    const chance = selfRelease ? Math.min(0.72, 0.12 + person.baselineCapacities.manipulation / 180) : 1;
    const sample = seededFraction(state.seed, `release-restraint:${atMonth}:${person.id}:${restrained.id}:${condition.id}`);
    if (sample >= chance) return { status: 'progressed' as const, result: `${person.name}尝试分离拘束物质，但这次没有成功`, diff: { restrainedPersonId: restrained.id, released: false, chance, sample } };
    restrained.conditions = restrained.conditions.filter((item) => item.id !== condition.id);
    addInventory(person, Material.Rope, 1, [eventId, ...condition.sourceEventIds], `stack-${person.id}-${Material.Rope}-${atMonth}`);
    return {
      status: 'completed' as const,
      result: `${person.name}从${selfRelease ? '自己' : restrained.name}身上分离出绳`,
      diff: { releasedPersonId: restrained.id, materialId: Material.Rope, sourceConditionId: condition.id },
    };
  }
  if (!target || target.kind !== 'voxel' || distanceToPosition(person, target.position) > 1) return { status: 'blocked' as const, result: '分离目标不在近身范围', diff: {} };
  const { x, y, z } = target.position;
  const materialId = voxelAt(state.world.grid, x, y, z);
  const output: Array<{ materialId: MaterialId; quantity: number }> = [];
  const spilled: Array<{ materialId: MaterialId; quantity: number }> = [];
  const selectedTool = action.toolStackId ? person.inventory.find((stack) => stack.id === action.toolStackId && stack.quantity > 0) : undefined;
  const productionTool = selectedTool && isProductionToolMaterial(selectedTool.materialId) ? selectedTool : undefined;
  let effectiveTool = productionTool;
  const toolMultiplier = productionToolMultiplier(productionTool?.materialId);
  const mill = nearbyFacilityMaterial(state, person, [Material.Mill]);
  let replacement: MaterialId = Material.Air;
  if (materialId === Material.Leaves || materialId === Material.Wood) {
    setVoxel(state.world.grid, x, y, z, Material.Air);
    for (let below = z - 1; below >= 0; below -= 1) {
      if (voxelAt(state.world.grid, x, y, below) !== Material.Wood) continue;
      setVoxel(state.world.grid, x, y, below, Material.Air);
      break;
    }
    output.push(
      { materialId: Material.Wood, quantity: Math.max(3, Math.floor(3 * toolMultiplier)) },
      { materialId: Material.Fiber, quantity: Math.max(1, Math.floor(1.25 * toolMultiplier)) },
    );
  } else if (materialId === Material.CropMature) {
    replacement = Material.ExhaustedSoil;
    setVoxel(state.world.grid, x, y, z, replacement);
    output.push(
      { materialId: Material.Food, quantity: Math.max(4, Math.floor(4 * toolMultiplier) + (mill ? 2 : 0)) },
      { materialId: Material.Seed, quantity: Math.max(2, Math.floor(1.5 * toolMultiplier)) },
    );
  } else if (materialId === Material.BerryBush) {
    replacement = Material.Shrub;
    setVoxel(state.world.grid, x, y, z, replacement);
    output.push(
      { materialId: Material.Food, quantity: Math.max(3, Math.floor(3 * toolMultiplier)) },
      { materialId: Material.Seed, quantity: Math.max(1, Math.floor(toolMultiplier)) },
    );
  } else if (materialId === Material.Shrub) {
    replacement = Material.Soil;
    setVoxel(state.world.grid, x, y, z, replacement);
    output.push({ materialId: Material.Fiber, quantity: Math.max(2, Math.floor(2 * toolMultiplier)) });
  } else {
    const rule = voxelSeparationRuleFor(materialId);
    if (!rule) return { status: 'blocked' as const, result: `${materialDefinition(materialId).name}目前无法徒手分离`, diff: { materialId } };
    if (rule.requiredToolMaterialId !== undefined && (!selectedTool || !separationToolFits(rule, selectedTool.materialId))) return {
      status: 'blocked' as const,
      result: `分离${materialDefinition(materialId).name}需要${materialDefinition(rule.requiredToolMaterialId).name}`,
      diff: { materialId, requiredToolMaterialId: rule.requiredToolMaterialId },
    };
    if (rule.requiredToolMaterialId !== undefined) effectiveTool = selectedTool;
    if (bodyStandsOn(state, target.position)) return { status: 'blocked' as const, result: '这个物质体素正支撑着身体，不能直接分离', diff: { materialId, position: target.position } };
    if (materialId === Material.Container || materialId === Material.Granary) {
      const containerId = containerIdAt(target.position);
      const container = containerById(state, containerId);
      if (container) {
        for (const stack of container.inventory) {
          addDrop(state, stack.materialId, stack.quantity, person.position.cellId, atMonth, [eventId, ...stack.sourceEventIds], `${person.id}-container-spill`, stack.recordPayloadId, person.position.z);
          spilled.push({ materialId: stack.materialId, quantity: stack.quantity });
        }
      }
      state.containers = state.containers.filter((candidate) => candidate.id !== containerId);
    }
    replacement = rule.replacementMaterialId;
    setVoxel(state.world.grid, x, y, z, replacement);
    output.push(...rule.outputs);
    const techniqueId = separationTechniqueId(rule);
    const known = person.knowledge.find((fact) => fact.id === techniqueId);
    if (known) {
      known.confidence = clamp(known.confidence + 18);
      known.sourceEventIds = [...new Set([...known.sourceEventIds, eventId])].slice(-24);
    } else person.knowledge.push({
      id: techniqueId,
      kind: 'technique',
      summary: separationTechniqueSummary(rule),
      confidence: 46,
      learnedAtMonth: atMonth,
      sourceEventIds: [eventId],
    });
  }
  for (const item of output) addDrop(state, item.materialId, item.quantity, person.position.cellId, atMonth, [eventId], `${person.id}-separate`, undefined, person.position.z);
  return {
    status: 'completed' as const,
    result: `从${materialDefinition(materialId).name}分离出${output.map((item) => `${materialDefinition(item.materialId).name} × ${item.quantity}`).join('、')}`,
    diff: {
      sourceMaterialId: materialId,
      replacementMaterialId: replacement,
      outputs: output,
      productionMultiplier: toolMultiplier,
      ...(mill ? { facilityMaterialId: mill } : {}),
      ...(spilled.length ? { spilled } : {}),
      ...(effectiveTool ? { toolMaterialId: effectiveTool.materialId, toolStackId: effectiveTool.id } : {}),
    },
  };
}

function executeInventoryCombine(state: SimulationState, person: PersonState, stackRefs: Extract<WorldRef, { kind: 'inventory-stack' }>[], atMonth: number, eventId: string) {
  if (stackRefs.length < 2 || stackRefs.some((ref) => ref.personId !== person.id)) return null;
  const requestedByStack = new Map<string, number>();
  for (const ref of stackRefs) requestedByStack.set(ref.stackId, (requestedByStack.get(ref.stackId) ?? 0) + 1);
  const stacks = stackRefs.map((ref) => person.inventory.find((stack) => stack.id === ref.stackId));
  if (stacks.some((stack) => !stack)) return { status: 'blocked' as const, result: '背包中的结合材料已经不存在', diff: {} };
  for (const [stackId, quantity] of requestedByStack) {
    if ((person.inventory.find((stack) => stack.id === stackId)?.quantity ?? 0) < quantity) return { status: 'blocked' as const, result: '背包中的结合材料数量不足', diff: {} };
  }
  const materialIds = stacks.map((stack) => stack?.materialId ?? Material.Air);
  const rule = inventoryCombinationFor(materialIds);
  if (!rule) return { status: 'blocked' as const, result: '这些随身物质当前没有可发生的结合规则', diff: { inputMaterialIds: materialIds } };
  for (const [stackId, quantity] of requestedByStack) {
    const stack = person.inventory.find((candidate) => candidate.id === stackId);
    if (stack) stack.quantity -= quantity;
  }
  removeEmptyStacks(person);
  const facilityMaterialId = nearbyFacilityMaterial(state, person, rule.output.materialId === Material.IronTool
    ? [Material.Smithy]
    : rule.output.materialId === Material.BronzeTool
      ? [Material.Foundry, Material.Workshop]
      : [Material.Workshop]);
  const exactMechanicalComponent = rule.output.materialId === Material.WaterWheel
    || rule.output.materialId === Material.DriveShaft
    || rule.output.materialId === Material.Mill;
  const facilityBonus = facilityMaterialId
    && !materialHas(rule.output.materialId, 'facility')
    && !exactMechanicalComponent ? 1 : 0;
  const outputQuantity = rule.output.quantity + facilityBonus;
  const outputStack = exactMechanicalComponent
    ? {
      id: `stack-${person.id}-${rule.output.materialId}-${eventId}`,
      materialId: rule.output.materialId,
      quantity: outputQuantity,
      sourceEventIds: [eventId],
    }
    : addInventory(person, rule.output.materialId, outputQuantity, [eventId], `stack-${person.id}-${rule.output.materialId}-${atMonth}`);
  if (exactMechanicalComponent) person.inventory.push(outputStack);
  const techniqueId = inventoryCombinationTechniqueId(rule);
  const known = person.knowledge.find((fact) => fact.id === techniqueId);
  if (known) {
    known.confidence = clamp(known.confidence + 18);
    known.sourceEventIds = [...new Set([...known.sourceEventIds, eventId])].slice(-24);
  } else person.knowledge.push({ id: techniqueId, kind: 'technique', summary: inventoryCombinationSummary(rule), confidence: 46, learnedAtMonth: atMonth, sourceEventIds: [eventId] });
  return {
    status: 'completed' as const,
    result: `${materialIds.map((id) => materialDefinition(id).name).join('与')}结合为${materialDefinition(rule.output.materialId).name}`,
    diff: {
      techniqueId,
      inputMaterialIds: materialIds,
      outputMaterialId: rule.output.materialId,
      outputQuantity,
      baseOutputQuantity: rule.output.quantity,
      ...(facilityMaterialId ? { facilityMaterialId, facilityBonus } : {}),
      outputStackId: outputStack.id,
      sourceEventId: eventId,
    },
  };
}

function executeCombine(state: SimulationState, person: PersonState, targets: WorldRef[], atMonth: number, eventId: string) {
  const stackRefs = targets.filter((target): target is Extract<WorldRef, { kind: 'inventory-stack' }> => target.kind === 'inventory-stack');
  const stackRef = stackRefs[0];
  const voxelRef = targets.find((target): target is Extract<WorldRef, { kind: 'voxel' }> => target.kind === 'voxel');
  const personRef = targets.find((target): target is Extract<WorldRef, { kind: 'person' }> => target.kind === 'person');
  if (!voxelRef && !personRef) {
    const outcome = executeInventoryCombine(state, person, stackRefs, atMonth, eventId);
    if (outcome) return outcome;
  }
  if (stackRef && personRef && stackRef.personId === person.id) {
    const stack = person.inventory.find((candidate) => candidate.id === stackRef.stackId && candidate.quantity > 0);
    const receiverCandidate = personById(state, personRef.personId);
    const receiver = receiverCandidate && sameLocation(receiverCandidate, person) ? receiverCandidate : undefined;
    if (!stack || !receiver) return { status: 'blocked' as const, result: '照护材料或伤者不在近身范围', diff: {} };
    if (stack.materialId === Material.Rope && receiver.id !== person.id) {
      const woundStage = receiver.conditions.find((item) => item.kind === 'wound')?.stage ?? 0;
      if (receiver.conditions.some((item) => item.kind === 'restrained')) return { status: 'blocked' as const, result: `${receiver.name}已经受到绳的拘束`, diff: {} };
      if (receiver.body.health > 20 && woundStage < 3) return { status: 'blocked' as const, result: `${receiver.name}仍能抵抗，绳没有形成持续拘束`, diff: { resistedBy: receiver.id } };
      stack.quantity -= 1;
      removeEmptyStacks(person);
      const condition = { id: `condition-restrained-${receiver.id}-${atMonth}`, kind: 'restrained' as const, stage: 2 as const, sinceMonth: atMonth, sourceEventIds: [eventId], otherPersonId: person.id, materialStackId: stack.id };
      receiver.conditions.push(condition);
      const witnessedBy = state.people.filter((candidate) => sameLocation(candidate, person) && candidate.id !== person.id).map((candidate) => candidate.id);
      for (const witness of state.people.filter((candidate) => witnessedBy.includes(candidate.id))) {
        applyRelationEvidence(witness, person.id, eventId, { trust: witness.id === receiver.id ? -20 : -8, fear: witness.id === receiver.id ? 20 : 8 });
      }
      return {
        status: 'completed' as const,
        result: `${person.name}用绳使${receiver.name}受到持续拘束`,
        diff: { restrainedPersonId: receiver.id, conditionId: condition.id, materialId: Material.Rope, witnessedBy },
      };
    }
    const condition = receiver.conditions.find((item) => item.kind === 'wound' || item.kind === 'illness');
    if ((stack.materialId !== Material.Fiber && stack.materialId !== Material.HerbalMedicine) || !condition) return { status: 'blocked' as const, result: '当前材料不能作用于这个身体状态', diff: {} };
    stack.quantity -= 1;
    removeEmptyStacks(person);
    const priorStage = condition.stage;
    if (condition.stage > 1) condition.stage = (condition.stage - 1) as 1 | 2;
    else receiver.conditions = receiver.conditions.filter((item) => item.id !== condition.id);
    receiver.body.health = clamp(receiver.body.health + (stack.materialId === Material.HerbalMedicine ? 9 : 3));
    const relation = receiver.relations.find((item) => item.personId === person.id);
    if (relation) {
      applyRelationEvidence(receiver, person.id, eventId, { trust: 7, bond: 5 });
    }
    return { status: 'completed' as const, result: `${person.name}用${materialDefinition(stack.materialId).name}照护${receiver.name}的${condition.kind === 'wound' ? '伤口' : '疾病'}`, diff: { caredPersonId: receiver.id, condition: condition.kind, careMaterialId: stack.materialId, fromStage: priorStage, toStage: receiver.conditions.find((item) => item.id === condition.id)?.stage ?? 0, health: receiver.body.health, atMonth } };
  }
  if (!stackRef || !voxelRef || stackRef.personId !== person.id || distanceToPosition(person, voxelRef.position) > 1) return { status: 'blocked' as const, result: '结合材料或目标不在近身范围', diff: {} };
  const stack = person.inventory.find((candidate) => candidate.id === stackRef.stackId && candidate.quantity > 0);
  if (!stack) return { status: 'blocked' as const, result: '背包中的材料已经不存在', diff: {} };
  const current = voxelAt(state.world.grid, voxelRef.position.x, voxelRef.position.y, voxelRef.position.z);
  let output: MaterialId | null = null;
  if (stack.materialId === Material.Seed && (current === Material.WetSoil || current === Material.RichSoil || current === Material.ExhaustedSoil)) output = Material.CropSprout;
  if (current === Material.Container && stack.materialId === Material.Plank) output = Material.Granary;
  if (current === Material.Container && stack.materialId === Material.Stone) output = Material.Cistern;
  if (current === Material.Air && materialHas(stack.materialId, 'solid') && (materialHas(stack.materialId, 'building') || materialHas(stack.materialId, 'placeable'))) {
    output = stack.materialId === Material.Wood ? Material.Plank : stack.materialId;
  }
  if (output === null) return { status: 'blocked' as const, result: '这些物质当前没有可发生的结合规则', diff: { inputMaterialId: stack.materialId, targetMaterialId: current } };
  if (materialHas(output, 'solid') && bodyOccupies(state, voxelRef.position)) return { status: 'blocked' as const, result: '目标空气体素正被身体占据，不能放入固体物质', diff: { outputMaterialId: output, position: voxelRef.position } };
  stack.quantity -= 1;
  removeEmptyStacks(person);
  setVoxel(state.world.grid, voxelRef.position.x, voxelRef.position.y, voxelRef.position.z, output);
  rememberMaterialPlace(person, output, voxelRef.position, atMonth, eventId);
  let containerId: string | undefined;
  if (output === Material.Container || output === Material.Granary) {
    containerId = containerIdAt(voxelRef.position);
    const existingContainer = state.containers.find((candidate) => candidate.id === containerId);
    if (existingContainer && output === Material.Granary) {
      existingContainer.capacity = GRANARY_CAPACITY;
      existingContainer.sourceEventIds = [...new Set([...existingContainer.sourceEventIds, eventId])].slice(-24);
    } else {
      state.containers = state.containers.filter((candidate) => candidate.id !== containerId);
      state.containers.push({
        id: containerId,
        position: { ...voxelRef.position },
        inventory: [],
        createdAtMonth: atMonth,
        sourceEventIds: [eventId],
        ...(output === Material.Granary ? { capacity: GRANARY_CAPACITY } : {}),
      });
    }
  } else if (output === Material.Cistern && current === Material.Container) {
    state.containers = state.containers.filter((candidate) => candidate.id !== containerIdAt(voxelRef.position));
  }
  const techniqueId = `technique:combine:${stack.materialId}:${current}:${output}`;
  const knownTechnique = person.knowledge.find((fact) => fact.id === techniqueId);
  if (knownTechnique) {
    knownTechnique.confidence = clamp(knownTechnique.confidence + 18);
    knownTechnique.sourceEventIds = [...new Set([...knownTechnique.sourceEventIds, eventId])].slice(-24);
  } else person.knowledge.push({
    id: techniqueId,
    kind: 'technique',
    summary: `${materialDefinition(stack.materialId).name}与${materialDefinition(current).name}可结合为${materialDefinition(output).name}`,
    confidence: 46,
    learnedAtMonth: atMonth,
    sourceEventIds: [eventId],
  });
  return {
    status: 'completed' as const,
    result: `${materialDefinition(stack.materialId).name}与${materialDefinition(current).name}结合为${materialDefinition(output).name}`,
    diff: { techniqueId, inputMaterialId: stack.materialId, targetMaterialId: current, outputMaterialId: output, position: voxelRef.position, sourceEventId: eventId, ...(containerId ? { containerId } : {}) },
  };
}

function executeExert(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'act' }>, atMonth: number, eventId: string) {
  const stackRef = action.targets.find((item): item is Extract<WorldRef, { kind: 'inventory-stack' }> => item.kind === 'inventory-stack');
  const voxelRef = action.targets.find((item): item is Extract<WorldRef, { kind: 'voxel' }> => item.kind === 'voxel');
  if (stackRef && voxelRef) {
    const stack = stackRef.personId === person.id ? person.inventory.find((candidate) => candidate.id === stackRef.stackId && candidate.quantity > 0) : undefined;
    const tool = action.toolStackId ? person.inventory.find((candidate) => candidate.id === action.toolStackId && candidate.quantity > 0) : undefined;
    if (!stack || !tool || distanceToPosition(person, voxelRef.position) > 1) return { status: 'blocked' as const, result: '施力所需的工具、材料或目标不在近身范围', diff: {} };
    if (voxelRef.position.z < 0 || voxelRef.position.z >= state.world.grid.levels) return { status: 'blocked' as const, result: '施力目标不在世界范围内', diff: {} };
    const targetMaterialId = voxelAt(state.world.grid, voxelRef.position.x, voxelRef.position.y, voxelRef.position.z);
    const rule = exertionRuleFor(tool.materialId, stack.materialId, targetMaterialId);
    if (!rule) return { status: 'blocked' as const, result: '这些物质当前没有可发生的施力响应', diff: { toolMaterialId: tool.materialId, inputMaterialId: stack.materialId, targetMaterialId } };
    const outputPosition = rule.outputLocation === 'world' && rule.outputPlacement === 'support'
      ? { ...voxelRef.position, z: voxelRef.position.z - 1 }
      : voxelRef.position;
    if (rule.outputLocation === 'world' && rule.outputPlacement === 'support'
      && materialDefinition(voxelAt(
        state.world.grid,
        outputPosition.x,
        outputPosition.y,
        outputPosition.z,
      )).phase !== 'solid') {
      return { status: 'blocked' as const, result: '产物需要稳定的承托表面', diff: { outputMaterialId: rule.outputMaterialId, position: outputPosition } };
    }
    stack.quantity -= 1;
    removeEmptyStacks(person);
    const outputStack = rule.outputLocation === 'inventory'
      ? addInventory(person, rule.outputMaterialId, 1, [eventId], `stack-${person.id}-${rule.outputMaterialId}-${atMonth}`)
      : undefined;
    if (rule.outputLocation === 'world') setVoxel(state.world.grid, outputPosition.x, outputPosition.y, outputPosition.z, rule.outputMaterialId);
    const techniqueId = exertionTechniqueId(rule);
    const knownTechnique = person.knowledge.find((fact) => fact.id === techniqueId);
    if (knownTechnique) {
      knownTechnique.confidence = clamp(knownTechnique.confidence + 18);
      knownTechnique.sourceEventIds = [...new Set([...knownTechnique.sourceEventIds, eventId])].slice(-24);
    } else person.knowledge.push({
      id: techniqueId,
      kind: 'technique',
      summary: exertionTechniqueSummary(rule),
      confidence: 46,
      learnedAtMonth: atMonth,
      sourceEventIds: [eventId],
    });
    return {
      status: 'completed' as const,
      result: `${materialDefinition(tool.materialId).name}向${materialDefinition(stack.materialId).name}施力后产生${materialDefinition(rule.outputMaterialId).name}`,
      diff: {
        techniqueId,
        toolMaterialId: tool.materialId,
        inputMaterialId: stack.materialId,
        targetMaterialId,
        outputMaterialId: rule.outputMaterialId,
        outputLocation: rule.outputLocation,
        ...(outputStack ? { outputStackId: outputStack.id } : {}),
        position: outputPosition,
        ...(rule.outputLocation === 'world' && rule.outputPlacement === 'support'
          ? { targetPosition: voxelRef.position }
          : {}),
        sourceEventId: eventId,
      },
    };
  }
  const target = action.targets.find((item): item is Extract<WorldRef, { kind: 'person' }> => item.kind === 'person');
  const victim = target ? personById(state, target.personId) : undefined;
  if (!victim || victim.id === person.id || !sameLocation(victim, person)) return { status: 'blocked' as const, result: '受力目标不在近身范围', diff: {} };
  const damage = Math.max(3, Math.round(person.baselineCapacities.manipulation / 12));
  victim.body.health = clamp(victim.body.health - damage);
  const wound = victim.conditions.find((condition) => condition.kind === 'wound');
  if (wound) {
    wound.stage = Math.min(3, wound.stage + 1) as 1 | 2 | 3;
    wound.sourceEventIds.push(eventId);
  } else {
    victim.conditions.push({ id: `condition-wound-${victim.id}-${atMonth}`, kind: 'wound', stage: damage >= 7 ? 2 : 1, sinceMonth: atMonth, sourceEventIds: [eventId], otherPersonId: person.id });
  }
  const witnessedBy = state.people.filter((candidate) => sameLocation(candidate, person) && candidate.id !== person.id).map((candidate) => candidate.id);
  for (const witness of state.people.filter((candidate) => witnessedBy.includes(candidate.id))) {
    applyRelationEvidence(witness, person.id, eventId, { trust: witness.id === victim.id ? -14 : -6, fear: witness.id === victim.id ? 12 : 5 });
  }
  return { status: 'completed' as const, result: `${person.name}对${victim.name}施力并造成伤害`, diff: { victimId: victim.id, damage, health: victim.body.health, witnessedBy } };
}

function executeReproduce(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'act' }>, atMonth: number, eventId: string) {
  const target = action.targets.find((item): item is Extract<WorldRef, { kind: 'person' }> => item.kind === 'person');
  const other = target ? personById(state, target.personId) : undefined;
  if (!other || other.id === person.id || !sameLocation(other, person)) return { status: 'blocked' as const, result: '另一参与者不在近身范围', diff: {} };
  const consent = action.authorizationRef
    ? activeReproductionAgreementBetween(state, person.id, other.id, atMonth, action.authorizationRef)
    : undefined;
  const succubusTrait = person.sex === 'female'
    ? traitStatesOf(person).find((trait) => trait.id === 'succubus')
    : undefined;
  const unilateralTraitAuthorization = !consent && Boolean(succubusTrait);
  if (!consent && !unilateralTraitAuthorization) {
    return { status: 'blocked' as const, result: '没有有效的双方生殖协议或魅魔单方授权，生殖过程不发生', diff: { consent: false } };
  }
  if (reproductionAttemptedBetweenInMonth(state, person.id, other.id, atMonth)) {
    return {
      status: 'blocked' as const,
      result: '本月这两人之间已经完成过一次生殖尝试',
      diff: {
        consent: true,
        attemptedThisMonth: true,
        ...(consent
          ? { mutualConsent: true, authorizationMode: 'agreement', agreementId: consent.id }
          : { mutualConsent: false, authorizationMode: 'succubus-unilateral', consentingPersonIds: [person.id], traitId: 'succubus' }),
      },
    };
  }
  const female = person.sex === 'female' ? person : other.sex === 'female' ? other : null;
  const male = person.sex === 'male' ? person : other.sex === 'male' ? other : null;
  const age = (candidate: PersonState) => atMonth - candidate.bornAtMonth;
  const relationshipSnapshot = [person, other].map((observer) => {
    const observedId = observer.id === person.id ? other.id : person.id;
    const relation = observer.relations.find((candidate) => candidate.personId === observedId);
    return {
      observerId: observer.id,
      otherPersonId: observedId,
      trust: relation?.trust ?? 0,
      bond: relation?.bond ?? 0,
      fear: relation?.fear ?? 0,
      sourceEventIds: [...(relation?.sourceEventIds ?? [])],
    };
  });
  const consentDiff = consent
    ? {
        consent: true,
        mutualConsent: true,
        authorizationMode: 'agreement',
        agreementId: consent.id,
        relationshipSnapshot,
      }
    : {
        consent: true,
        mutualConsent: false,
        authorizationMode: 'succubus-unilateral',
        consentingPersonIds: [person.id],
        nonConsentingPersonId: other.id,
        traitId: 'succubus',
        traitSourceEventIds: [...(succubusTrait?.sourceEventIds ?? [])],
        relationshipSnapshot,
      };
  if (!female || !male
    || age(female) < 16 * 12
    || age(male) < 16 * 12
    || (!unilateralTraitAuthorization && age(female) > reproductiveUpperAgeMonths(female))
    || (unilateralTraitAuthorization
      ? female.conditions.some((condition) => condition.kind === 'pregnancy')
      : hasReproductiveRecoveryCondition(female))
    || (!unilateralTraitAuthorization && Math.min(
      female.body.health, female.body.hydration, female.body.nutrition,
      male.body.health, male.body.hydration, male.body.nutrition,
    ) < 55)) {
    return { status: 'blocked' as const, result: '当前身体条件不能开始妊娠过程', diff: consentDiff };
  }
  const livingPopulation = state.people.filter(isAlive).length;
  const capacityFactor = humanReproductionCapacityFactor(livingPopulation);
  const chance = 0.28 * Math.min(female.body.health, female.body.nutrition, female.body.hydration) / 100 * capacityFactor;
  const sampleKey = `reproduce:${eventId}:${atMonth}:${female.id}:${male.id}`;
  const sample = seededFraction(state.seed, sampleKey);
  const kinshipRisk = geneticKinshipRisk(state, female, male);
  const capacityDiff = { livingPopulation, softCarryingCapacity: HUMAN_SOFT_CARRYING_CAPACITY, capacityFactor };
  if (sample >= chance) return { status: 'completed' as const, result: '生殖过程发生，但本次没有进入妊娠', diff: { conceived: false, chance, sample, sampleKey, kinshipRisk, ...capacityDiff, ...consentDiff } };
  female.conditions.push({
    id: `condition-pregnancy-${female.id}-${atMonth}`,
    kind: 'pregnancy', stage: 1, sinceMonth: atMonth, dueAtMonth: atMonth + 9,
    sourceEventIds: consent
      ? [consent.proposalEventId, ...(consent.responseEventId ? [consent.responseEventId] : []), eventId]
      : [...new Set([...(succubusTrait?.sourceEventIds ?? []), eventId])],
    otherPersonId: male.id,
  });
  return { status: 'completed' as const, result: `${female.name}进入妊娠过程`, diff: { conceived: true, femaleId: female.id, maleId: male.id, dueAtMonth: atMonth + 9, chance, sample, sampleKey, kinshipRisk, ...capacityDiff, ...consentDiff } };
}

function executeDehydrate(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'act' }>,
  atMonth: number,
  eventId: string,
) {
  const target = action.targets.find((candidate): candidate is Extract<WorldRef, { kind: 'person' }> => candidate.kind === 'person');
  const sleeperCandidate = target ? personById(state, target.personId) : undefined;
  const sleeper = sleeperCandidate && isAlive(sleeperCandidate) ? sleeperCandidate : undefined;
  if (!sleeper || !sameLocation(sleeper, person)) return { status: 'blocked' as const, result: '需要近身才能进入脱水休眠', diff: {} };
  const assistedDependent = sleeper.id !== person.id;
  if (assistedDependent && (!sleeper.geneticParents.includes(person.id) || ageMonths(sleeper, atMonth) >= 12 * 12)) {
    return { status: 'blocked' as const, result: '只能辅助同地、未满十二岁的亲生受抚养者脱水', diff: {} };
  }
  if (sleeper.conditions.some((condition) => condition.kind === 'dehydrated-hibernation')) return {
    status: 'completed' as const,
    result: `${sleeper.name}已处于脱水休眠`,
    diff: { alreadyHibernating: true, dehydratedPersonId: sleeper.id },
  };
  if (hasHibernationEntryContraindication(sleeper)) {
    return { status: 'blocked' as const, result: '妊娠、重伤或重病让脱水休眠过程过于危险', diff: {} };
  }
  const requiredEntryReserve = action.hibernationPredictionId
    ? HIBERNATION_PREDICTIVE_ENTRY_RESERVE
    : HIBERNATION_ENTRY_LEGAL_RESERVE;
  if (!hasHibernationEntryBodyReserve(sleeper, requiredEntryReserve)) {
    return { status: 'blocked' as const, result: '当前身体储备不足以安全进入脱水休眠', diff: {} };
  }
  const triggerPrediction = action.hibernationPredictionId
    ? state.eraPredictions.find((prediction) => prediction.id === action.hibernationPredictionId)
    : undefined;
  if (action.hibernationPredictionId && (!triggerPrediction
    || !isActionableChaosPrediction(triggerPrediction, atMonth)
    || !personTrustsEraPrediction(state, sleeper, triggerPrediction))) {
    return { status: 'blocked' as const, result: '支撑脱水休眠的预言已经失效或不被本人相信', diff: {} };
  }
  const wakeDisputeEventIds = triggerPrediction
    ? sleeper.memories
      .filter((memory) => memory.id.startsWith(`memory:hibernation-wake-dispute:${triggerPrediction.id}:${sleeper.id}:`))
      .flatMap((memory) => memory.sourceEventIds)
    : [];
  const providedHibernationEvidenceIds = new Set(action.hibernationEvidenceEventIds ?? []);
  const hibernationEvidenceEventIds = triggerPrediction
    ? []
    : observedHibernationEntryEvidence(state, sleeper)
      .filter((sourceEventId) => providedHibernationEvidenceIds.has(sourceEventId));
  if (!triggerPrediction && hibernationEvidenceEventIds.length === 0) {
    return {
      status: 'blocked' as const,
      result: '已发生的乱纪元脱水休眠需要本人当前严重冷热暴露的可解析事实',
      diff: {},
    };
  }
  sleeper.conditions.push({
    id: `condition-dehydrated-hibernation-${sleeper.id}-${atMonth}`,
    kind: 'dehydrated-hibernation',
    stage: 1,
    sinceMonth: atMonth,
    hibernationPhase: 'dormant',
    sourceEventIds: [...new Set([...hibernationEvidenceEventIds, eventId])],
    ...(triggerPrediction ? { triggerPredictionId: triggerPrediction.id } : {}),
    ...(wakeDisputeEventIds.length ? { wakeDisputeEventIds: [...new Set(wakeDisputeEventIds)] } : {}),
  });
  sleeper.body.hydration = clamp(sleeper.body.hydration - 8);
  return {
    status: 'completed' as const,
    result: assistedDependent
      ? `${person.name}近身辅助${sleeper.name}进入脱水休眠，以低代谢等待乱纪元过去`
      : `${person.name}主动进入脱水休眠，以低代谢等待乱纪元过去`,
    diff: {
      condition: 'dehydrated-hibernation', entered: true, epoch: state.civilization.epoch,
      dehydratedPersonId: sleeper.id,
      ...(hibernationEvidenceEventIds.length ? { hibernationEvidenceEventIds } : {}),
      ...(triggerPrediction ? { hibernationPredictionId: triggerPrediction.id } : {}),
      ...(wakeDisputeEventIds.length ? { wakeDisputeEventIds: [...new Set(wakeDisputeEventIds)] } : {}),
      ...(assistedDependent ? { assistedByPersonId: person.id, assistedDependentId: sleeper.id } : {}),
    },
  };
}

function executeRehydrate(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'act' }>,
  atMonth: number,
  eventId: string,
) {
  const target = action.targets.find((candidate): candidate is Extract<WorldRef, { kind: 'person' }> => candidate.kind === 'person');
  const sleeper = target ? personById(state, target.personId) : undefined;
  if (!sleeper || !sameLocation(sleeper, person)) return { status: 'blocked' as const, result: '需要近身才能让脱水休眠者重新水化', diff: {} };
  const condition = sleeper.conditions.find((candidate) => candidate.kind === 'dehydrated-hibernation');
  if (!condition) return { status: 'blocked' as const, result: '对方没有处于脱水休眠', diff: {} };
  const phase = hibernationPhase(condition);
  const assistedDependentRecovery = phase === 'recovering'
    && isAlive(sleeper)
    && state.civilization.epoch === 'stable'
    && sleeper.geneticParents.includes(person.id)
    && lifePlanningStage(sleeper, atMonth) === 'dependent-child'
    && sleeper.body.hydration < HIBERNATION_RECOVERY_SAFE_RESERVE
    && condition.lastRecoveryAssistedAtMonth !== atMonth;
  if (phase !== 'dormant' && !assistedDependentRecovery) return {
    status: 'blocked' as const,
    result: phase === 'recovering'
      ? '对方的恢复阶段不允许本次重新水化'
      : '对方已经转入恢复阶段，不能重复重新水化',
    diff: {
      hibernationConditionId: condition.id,
      hibernationPhase: phase,
      duplicateRehydrationBlocked: true,
    },
  };
  const waterNearby = cellsInRadius(person.position.cellId, 2).some((cell) => {
    const material = surfaceMaterial(state.world.grid, cell);
    return materialHas(material, 'drinkable');
  });
  if (!waterNearby) return { status: 'blocked' as const, result: '附近没有可用水或冰，无法完成重新水化', diff: {} };
  if (assistedDependentRecovery) {
    condition.lastRecoveryAssistedAtMonth = atMonth;
    condition.recoverySourceEventIds = [...new Set([...(condition.recoverySourceEventIds ?? []), eventId])].slice(-24);
    sleeper.body.hydration = clamp(sleeper.body.hydration + 18);
    return {
      status: 'completed' as const,
      result: `${person.name}用附近的真实水源继续帮助${sleeper.name}恢复`,
      diff: {
        rehydratedPersonId: sleeper.id,
        assistedDependentId: sleeper.id,
        assistedByPersonId: person.id,
        waterNearby: true,
        atMonth,
        hibernationRecoverySource: true,
        hibernationConditionId: condition.id,
        hibernationPhase: 'recovering',
        exited: false,
        recoverySourceEventIds: [...condition.recoverySourceEventIds],
        lastRecoveryAssistedAtMonth: atMonth,
      },
    };
  }
  const triggerPrediction = condition.triggerPredictionId
    ? state.eraPredictions.find((prediction) => prediction.id === condition.triggerPredictionId)
    : undefined;
  const predictionStillPending = Boolean(triggerPrediction
    && triggerPrediction.status === 'pending'
    && atMonth <= triggerPrediction.expiresAtMonth);
  const bodyEmergency = sleeper.body.health < 35
    || sleeper.body.hydration < 28
    || sleeper.body.nutrition < 28;
  if (state.civilization.epoch !== 'stable' && !bodyEmergency) {
    return { status: 'blocked' as const, result: '乱纪元仍在持续，缺少足以打断休眠的新证据', diff: {} };
  }
  if (predictionStillPending && !bodyEmergency
    && personTrustsEraPrediction(state, person, triggerPrediction!)) {
    return { status: 'blocked' as const, result: '本人也认可这项临近乱纪元预言，不应提前打断休眠', diff: {} };
  }
  if (predictionStillPending && !bodyEmergency && (condition.wakeDisputeEventIds?.length ?? 0) > 0) {
    return { status: 'blocked' as const, result: '这项休眠计划已被质疑并重新执行，缺少再次唤醒的新证据', diff: {} };
  }
  const wakeBasis = bodyEmergency
    ? 'body-emergency' as const
    : predictionStillPending
      ? 'disputed-pending-prediction' as const
      : triggerPrediction?.status === 'incorrect'
        ? 'prediction-invalidated' as const
        : triggerPrediction?.status === 'correct'
          ? 'post-chaos-recovery' as const
          : 'unbound-stable-recovery' as const;
  condition.hibernationPhase = 'recovering';
  condition.recoveryStartedAtMonth ??= atMonth;
  condition.recoverySourceEventIds = [...new Set([...(condition.recoverySourceEventIds ?? []), eventId])].slice(-24);
  sleeper.body.hydration = clamp(sleeper.body.hydration + 18);
  if (person.id !== sleeper.id) {
    if (wakeBasis === 'disputed-pending-prediction' && triggerPrediction) {
      const memoryId = `memory:hibernation-wake-dispute:${triggerPrediction.id}:${sleeper.id}:${person.id}`;
      remember(sleeper, {
        id: memoryId,
        kind: 'episode',
        summary: `${person.name}不认可仍待验证的纪元预言，提前打断了自己的休眠计划`,
        importance: 78,
        createdAtMonth: atMonth,
        lastRecalledAtMonth: atMonth,
        personIds: [person.id, triggerPrediction.predictorId],
        sourceEventIds: [eventId],
        expiresAtMonth: triggerPrediction.expiresAtMonth,
      });
      remember(person, {
        id: `${memoryId}:helper`,
        kind: 'episode',
        summary: `自己不认可仍待验证的纪元预言，提前唤醒了${sleeper.name}`,
        importance: 70,
        createdAtMonth: atMonth,
        lastRecalledAtMonth: atMonth,
        personIds: [sleeper.id, triggerPrediction.predictorId],
        sourceEventIds: [eventId],
        expiresAtMonth: triggerPrediction.expiresAtMonth,
      });
    } else {
      applyRelationEvidence(sleeper, person.id, eventId, { trust: 4, bond: 2 });
      applyRelationEvidence(person, sleeper.id, eventId, { trust: 2, bond: 1 });
      remember(sleeper, {
        id: `memory:hibernation-wake-help:${eventId}:${sleeper.id}`,
        kind: 'episode',
        summary: `${person.name}依据新的环境或身体事实帮助自己安全结束休眠`,
        importance: 72,
        createdAtMonth: atMonth,
        lastRecalledAtMonth: atMonth,
        personIds: [person.id],
        sourceEventIds: [eventId],
      });
    }
  }
  return {
    status: 'completed' as const,
    result: `${person.name}用真实水源使${sleeper.name}转入受限恢复`,
    diff: {
      rehydratedPersonId: sleeper.id,
      waterNearby: true,
      atMonth,
      rehydrationBasis: wakeBasis,
      hibernationConditionId: condition.id,
      hibernationPhase: 'recovering',
      exited: false,
      recoverySourceEventIds: [...condition.recoverySourceEventIds],
      ...(triggerPrediction ? { hibernationPredictionId: triggerPrediction.id } : {}),
    },
  };
}

function executeHunt(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'act' }>, atMonth: number, eventId: string) {
  const target = action.targets.find((candidate): candidate is Extract<WorldRef, { kind: 'animal' }> => candidate.kind === 'animal');
  const animal = target ? state.world.animals.find((candidate) => candidate.id === target.animalId) : undefined;
  if (!animal || !isAnimalAlive(animal)) return { status: 'blocked' as const, result: '捕猎目标已经不在', diff: {} };
  if (animal.position.cellId !== person.position.cellId || animal.position.z !== person.position.z) {
    return { status: 'blocked' as const, result: '动物不在近身范围', diff: { animalId: animal.id } };
  }
  const species = animalSpecies(animal.speciesId);
  const tool = action.toolStackId ? person.inventory.find((stack) => stack.id === action.toolStackId && stack.quantity > 0) : undefined;
  const toolBonus = huntingToolBonus(tool?.materialId);
  const toolDiff = {
    toolBonus,
    ...(tool ? { toolMaterialId: tool.materialId, toolStackId: tool.id } : {}),
  };
  const chance = Math.max(0.08, Math.min(0.9,
    0.12 + person.baselineCapacities.perception / 360 + person.baselineCapacities.manipulation / 420 + toolBonus - species.evasion / 220,
  ));
  const sample = seededFraction(state.seed, `human-hunt:${atMonth}:${person.id}:${animal.id}:${eventId}`);
  if (sample >= chance) {
    const counterChance = species.aggression / 150 * (1 - Math.min(0.45, toolBonus * 0.65));
    if (species.aggression > 0 && seededFraction(state.seed, `hunt-counter:${atMonth}:${person.id}:${animal.id}`) < counterChance) {
      const damage = Math.max(1, Math.round((4 + Math.floor(species.aggression / 16))
        * (1 - Math.min(0.35, toolBonus * 0.55))));
      person.body.health = clamp(person.body.health - damage);
      const wound = person.conditions.find((condition) => condition.kind === 'wound');
      if (wound) {
        wound.stage = Math.min(3, wound.stage + 1) as 1 | 2 | 3;
        wound.sourceEventIds.push(eventId);
      } else person.conditions.push({ id: `condition-wound-hunt-${person.id}-${atMonth}`, kind: 'wound', stage: 1, sinceMonth: atMonth, sourceEventIds: [eventId] });
      return {
        status: 'progressed' as const,
        result: `${person.name}捕猎${species.name}失败并被反击`,
        diff: {
          animalId: animal.id, animalSpeciesId: animal.speciesId, success: false,
          chance, sample, counterChance, counterDamage: damage, ...toolDiff,
        },
      };
    }
    return {
      status: 'progressed' as const,
      result: `${person.name}没有捕到${species.name}`,
      diff: { animalId: animal.id, animalSpeciesId: animal.speciesId, success: false, chance, sample, ...toolDiff },
    };
  }
  const damage = Math.round(26 + person.baselineCapacities.manipulation * 0.42 + toolBonus * 90);
  animal.health = Math.max(0, animal.health - damage);
  if (animal.health > 0) return {
    status: 'progressed' as const,
    result: `${person.name}击伤了${species.name}，但它仍然存活`,
    diff: {
      animalId: animal.id, animalSpeciesId: animal.speciesId, success: true, killed: false,
      damage, health: animal.health, chance, sample, ...toolDiff,
    },
  };
  animal.diedAtMonth = atMonth;
  const products = species.products.flatMap((product) => {
    const span = Math.max(0, product.maxQuantity - product.minQuantity);
    const quantity = product.minQuantity + Math.floor(seededFraction(state.seed, `human-hunt-product:${animal.id}:${atMonth}:${product.materialId}`) * (span + 1));
    if (quantity <= 0) return [];
    addDrop(state, product.materialId, quantity, animal.position.cellId, atMonth, [eventId], `${animal.id}-hunted`, undefined, animal.position.z);
    return [{ materialId: product.materialId, quantity }];
  });
  const techniqueId = `technique:hunt:${animal.speciesId}:${tool?.materialId ?? 'hand'}`;
  const known = person.knowledge.find((fact) => fact.id === techniqueId);
  if (known) {
    known.confidence = clamp(known.confidence + 18);
    known.sourceEventIds = [...new Set([...known.sourceEventIds, eventId])].slice(-24);
  } else person.knowledge.push({
    id: techniqueId,
    kind: 'technique',
    summary: `用${tool ? materialDefinition(tool.materialId).name : '徒手'}捕猎${species.name}`,
    confidence: 46,
    learnedAtMonth: atMonth,
    sourceEventIds: [eventId],
  });
  return {
    status: 'completed' as const,
    result: `${person.name}捕获了${species.name}，尸体留下${products.map((product) => `${materialDefinition(product.materialId).name} × ${product.quantity}`).join('、')}`,
    diff: {
      animalId: animal.id, animalSpeciesId: animal.speciesId, success: true, killed: true,
      damage, products, outputMaterialId: Material.RawMeat,
      ...toolDiff,
    },
  };
}

function executeExpose(state: SimulationState, person: PersonState, targets: WorldRef[], atMonth: number, eventId: string) {
  const stackRef = targets.find((target): target is Extract<WorldRef, { kind: 'inventory-stack' }> => target.kind === 'inventory-stack');
  const voxelRef = targets.find((target): target is Extract<WorldRef, { kind: 'voxel' }> => target.kind === 'voxel');
  if (!stackRef || stackRef.personId !== person.id || !voxelRef || distanceToPosition(person, voxelRef.position) > 1) return { status: 'blocked' as const, result: '暴露材料或目标不在近身范围', diff: {} };
  const stack = person.inventory.find((candidate) => candidate.id === stackRef.stackId && candidate.quantity > 0);
  if (!stack) return { status: 'blocked' as const, result: '背包中的暴露材料已经不存在', diff: {} };
  const targetMaterialId = voxelAt(state.world.grid, voxelRef.position.x, voxelRef.position.y, voxelRef.position.z);
  const rule = exposureRuleFor(stack.materialId, targetMaterialId);
  if (!rule) return { status: 'blocked' as const, result: '这些物质当前没有可发生的暴露响应', diff: { inputMaterialId: stack.materialId, targetMaterialId } };
  stack.quantity -= 1;
  removeEmptyStacks(person);
  const outputStack = addInventory(person, rule.outputMaterialId, 1, [eventId], `stack-${person.id}-${rule.outputMaterialId}-${atMonth}`);
  const techniqueId = exposureTechniqueId(rule);
  const known = person.knowledge.find((fact) => fact.id === techniqueId);
  if (known) {
    known.confidence = clamp(known.confidence + 18);
    known.sourceEventIds = [...new Set([...known.sourceEventIds, eventId])].slice(-24);
  } else person.knowledge.push({ id: techniqueId, kind: 'technique', summary: exposureTechniqueSummary(rule), confidence: 46, learnedAtMonth: atMonth, sourceEventIds: [eventId] });
  return {
    status: 'completed' as const,
    result: `${materialDefinition(stack.materialId).name}暴露于${materialDefinition(targetMaterialId).name}后成为${materialDefinition(rule.outputMaterialId).name}`,
    diff: {
      techniqueId,
      inputMaterialId: stack.materialId,
      targetMaterialId,
      outputMaterialId: rule.outputMaterialId,
      outputStackId: outputStack.id,
      position: voxelRef.position,
      sourceEventId: eventId,
      ...(materialHas(targetMaterialId, 'facility') ? { facilityMaterialId: targetMaterialId } : {}),
    },
  };
}

interface MechanicalActionContext {
  project: ProjectState;
  plan: MechanicalPowerProjectPlan;
  mechanicalPower: MechanicalPowerWorldState;
  network?: MechanicalPowerNetworkState;
  observationEvent: ActionFact;
  supportingSegmentIds: string[];
}

function samePosition(left: VoxelPosition, right: VoxelPosition): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
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
  basis: MechanicalPowerActionBasis,
  requireFlow: boolean,
): MechanicalActionContext | { blocked: string } {
  if (basis.version !== MECHANICAL_POWER_ACTION_BASIS_VERSION || basis.mode === 'observe-source') {
    return { blocked: '机械动作依据版本或模式无效' };
  }
  const projectCandidate = projectById(state, basis.projectId);
  const project = projectCandidate?.status === 'active'
    && projectCandidate.ownerId === person.id
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
  if (!observationEvent) {
    return { blocked: '机械动作缺少项目发起者本人对该水流的可靠观察' };
  }
  const availability = waterCurrentAvailabilityFor(state.world.grid, mechanicalPower, source.id);
  if (requireFlow && !availability.available) return { blocked: '冻结计划所绑定的水流当前已经失效' };
  const network = mechanicalPower.networks.find((candidate) => candidate.id === basis.networkId);
  if (network && (network.planKey !== basis.planKey
    || network.installationProjectId !== project.id
    || network.sourceSegmentId !== source.id)) {
    return { blocked: '机械网络身份与冻结计划冲突' };
  }
  return {
    project,
    plan,
    mechanicalPower,
    ...(network ? { network } : {}),
    observationEvent,
    supportingSegmentIds: availability.supportingSegmentIds,
  };
}

function projectActionFactsForMechanical(state: SimulationState, project: ProjectState): ActionFact[] {
  return project.actionEventIds.flatMap((eventId) => {
    const event = worldEventById(state, eventId);
    return event?.kind === 'action' ? [event] : [];
  });
}

function verifiedComponentEvidence(
  state: SimulationState,
  person: PersonState,
  project: ProjectState,
  stackId: string,
  materialId: MaterialId,
  after?: ActionFact,
): { manufacture: ActionFact; verification: ActionFact; stack: ItemStack } | null {
  const stack = person.inventory.find((candidate) => candidate.id === stackId
    && candidate.materialId === materialId
    && candidate.quantity > 0
    && !candidate.recordPayloadId);
  if (!stack) return null;
  const actions = projectActionFactsForMechanical(state, project);
  for (const manufacture of actions.filter((event) => event.status === 'completed'
    && event.who === person.id
    && event.action.kind === 'act'
    && event.action.operation === 'combine'
    && Number(event.diff.outputMaterialId) === materialId
    && event.diff.outputStackId === stack.id
    && stack.sourceEventIds.includes(event.id)
    && (!after || actionHappenedAfter(event, after))).reverse()) {
    const verification = actions.find((event) => event.status === 'completed'
      && event.who === person.id
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
  const context = mechanicalActionContext(state, person, basis, true);
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
  if (voxelAt(state.world.grid, planned.position.x, planned.position.y, planned.position.z) !== Material.Air
    || bodyOccupies(state, planned.position)) {
    return { status: 'blocked' as const, result: '冻结安装位置不再是可用空气体素', diff: {} };
  }
  const evidence = verifiedComponentEvidence(
    state, person, context.project, stackRef.stackId, planned.materialId,
  );
  if (!evidence) return { status: 'blocked' as const, result: '构件不是本项目中由本人真实制造并源绑定核验的成品', diff: {} };
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
    context.observationEvent.id,
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
    && component.materialId === candidate.materialId
    && component.projectId === plan.projectId
    && samePosition(component.position, candidate.position)));
}

function mechanicalOperate(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'act' }>,
  basis: Extract<MechanicalPowerActionBasis, { mode: 'operate' }>,
  atMonth: number,
  eventId: string,
) {
  const context = mechanicalActionContext(state, person, basis, true);
  if ('blocked' in context) return { status: 'blocked' as const, result: context.blocked, diff: {} };
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
  if (network.faultEventIds.length === 0 && network.operationEventIds.length === 0) {
    const brokenPosition = context.plan.shaftPositions[0];
    if (!brokenPosition || voxelAt(
      state.world.grid, brokenPosition.x, brokenPosition.y, brokenPosition.z,
    ) !== Material.DriveShaft) return { status: 'blocked' as const, result: '试运转故障目标传动轴不存在', diff: {} };
    setVoxel(state.world.grid, brokenPosition.x, brokenPosition.y, brokenPosition.z, Material.BrokenDriveShaft);
    recordMechanicalPowerFault(network, {
      kind: 'commissioning-misalignment',
      componentRole: 'connector',
      componentPosition: { ...brokenPosition },
      atMonth,
      faultEventId: eventId,
      sourceEventIds: [...network.installationEventIds, context.observationEvent.id],
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
        inputPreserved: true,
        inputMaterialId: input.materialId,
        inputStackId: input.id,
        inputQuantityBefore: input.quantity,
        inputQuantityAfter: input.quantity,
        mechanicalPowerBasis: structuredClone(basis),
      },
    };
  }
  if (!network.repairEventIds.length) {
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
    [eventId, ...network.repairEventIds, ...inputSourceEventIds],
    `stack-${person.id}-${Material.Food}-${eventId}`,
    undefined,
    [`mechanical-network:${network.id}`, `input-stack:${inputStackId}`, ...inputSourceLineageKeys],
  );
  recordMechanicalPowerOperation(network, eventId);
  return {
    status: 'completed' as const,
    result: `流水驱动磨坊把种子处理为食物 × ${outputQuantity}`,
    diff: {
      mechanicalPowerOperation: true,
      mode: 'operate',
      projectId: context.project.id,
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
      repairEventIds: [...network.repairEventIds],
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
  return plan.shaftPositions.every((position) => samePosition(position, network.fault!.componentPosition)
    ? voxelAt(state.world.grid, position.x, position.y, position.z) === Material.BrokenDriveShaft
    : voxelAt(state.world.grid, position.x, position.y, position.z) === Material.DriveShaft);
}

function mechanicalRepair(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'act' }>,
  basis: Extract<MechanicalPowerActionBasis, { mode: 'repair' }>,
  eventId: string,
) {
  const context = mechanicalActionContext(state, person, basis, false);
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
  if (!network || !fault || fault.faultEventId !== basis.faultEventId
    || faultEvent?.kind !== 'action'
    || basis.replacementMaterialId !== Material.DriveShaft
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
    Material.DriveShaft,
    faultEvent,
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
    Material.DriveShaft,
  );
  recordMechanicalPowerRepair(network, eventId, repairSourceEventIds);
  return {
    status: 'completed' as const,
    result: '用新传动轴和青铜工具修复了机械网络',
    diff: {
      mechanicalPowerRepair: true,
      mode: 'repair',
      projectId: context.project.id,
      planKey: basis.planKey,
      networkId: network.id,
      sourceSegmentId: basis.sourceSegmentId,
      faultEventId: basis.faultEventId,
      replacementMaterialId: Material.DriveShaft,
      replacementStackId: replacementRef.stackId,
      toolMaterialId: Material.BronzeTool,
      toolStackId: tool.id,
      repairSourceEventIds,
      repairEventIds: [...network.repairEventIds],
      mechanicalPowerBasis: structuredClone(basis),
    },
  };
}

function executeMechanicalPowerAction(
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
  if (basis.mode === 'operate') return mechanicalOperate(state, person, action, basis, atMonth, eventId);
  if (basis.mode === 'repair') return mechanicalRepair(state, person, action, basis, eventId);
  return { status: 'blocked' as const, result: '观察水流必须使用指向当前水体的观察动作', diff: {} };
}

function executeMortuary(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'act' }>,
  atMonth: number,
  eventId: string,
) {
  const phase = action.mortuaryPhase;
  const remainsRef = action.targets.find((target) => target.kind === 'remains');
  const remains = remainsRef?.kind === 'remains' ? remainsById(state, remainsRef.remainsId) : undefined;
  const deceased = remains ? personById(state, remains.personId) : undefined;
  const bereavement = remains ? bereavementFor(person, remains.id) : undefined;
  if (!phase || !remains || !deceased || !bereavement) {
    return { status: 'blocked' as const, result: '丧葬行动没有绑定本人知晓的真实死亡与遗体', diff: {} };
  }
  const access = remains.grave?.accessPosition ?? remains.position;
  const atAccess = person.position.cellId === access.cellId && person.position.z === access.z;
  const spendWork = (heavy = false) => {
    person.body.hydration = clamp(person.body.hydration - (heavy ? 0.55 : 0.2));
    person.body.nutrition = clamp(person.body.nutrition - (heavy ? 0.45 : 0.15));
  };

  if (phase === 'mourn') {
    if (!atAccess || bereavement.lastMournedAtMonth !== undefined) {
      return { status: 'blocked' as const, result: '本人不在遗体或墓记近旁，或已经完成过这次悼念', diff: {} };
    }
    bereavement.lastMournedAtMonth = atMonth;
    return {
      status: 'completed' as const,
      result: remains.status === 'interred'
        ? `${person.name}在${deceased.name}的墓前停留悼念`
        : `${person.name}在${deceased.name}的遗体旁停留哀悼`,
      diff: {
        mortuaryPhase: phase,
        remainsId: remains.id,
        deceasedPersonId: deceased.id,
        deathEventId: remains.deathEventId,
        griefIntensity: bereavement.intensity,
        sourceEventIds: [...bereavement.sourceEventIds],
      },
    };
  }

  if (phase === 'lift') {
    if (remains.status !== 'exposed'
      || person.position.cellId !== remains.position.cellId
      || person.position.z !== remains.position.z
      || (state.world.remains ?? []).some((candidate) => candidate.carriedByPersonId === person.id)) {
      return { status: 'blocked' as const, result: '遗体不在本人近身位置，或本人已经搬运另一具遗体', diff: {} };
    }
    remains.status = 'carried';
    remains.carriedByPersonId = person.id;
    remains.sourceEventIds = [...new Set([...remains.sourceEventIds, eventId])].slice(-24);
    spendWork(true);
    return {
      status: 'completed' as const,
      result: `${person.name}近身抬起${deceased.name}的遗体`,
      diff: { mortuaryPhase: phase, remainsId: remains.id, deceasedPersonId: deceased.id, deathEventId: remains.deathEventId },
    };
  }

  if (phase === 'prepare-grave') {
    const voxelRef = action.targets.find((target) => target.kind === 'voxel');
    const position = voxelRef?.kind === 'voxel' ? voxelRef.position : undefined;
    if (!position
      || remains.status !== 'carried'
      || remains.carriedByPersonId !== person.id
      || remains.grave
      || distanceToPosition(person, position) > 1) {
      return { status: 'blocked' as const, result: '挖墓没有绑定本人搬运的遗体或近身地表', diff: {} };
    }
    const graveCellId = cellId(position.x, position.y);
    const originalMaterialId = voxelAt(state.world.grid, position.x, position.y, position.z);
    const validSurface = materialHas(originalMaterialId, 'ground')
      && surfaceMaterial(state.world.grid, graveCellId) === originalMaterialId
      && voxelAt(state.world.grid, position.x, position.y, position.z + 1) === Material.Air;
    const occupied = bodyStandsOn(state, position)
      || (state.world.remains ?? []).some((candidate) => candidate.grave
        && candidate.grave.position.x === position.x
        && candidate.grave.position.y === position.y
        && candidate.grave.position.z === position.z);
    if (!validSurface || occupied) return { status: 'blocked' as const, result: '所指位置不再是可挖掘且无人占用的真实地表', diff: {} };
    setVoxel(state.world.grid, position.x, position.y, position.z, Material.Air);
    const coverMaterialStackId = `stack:${person.id}:grave-cover:${remains.id}`;
    person.inventory.push({
      id: coverMaterialStackId,
      materialId: originalMaterialId,
      quantity: 1,
      sourceEventIds: [eventId],
      sourceLineageKeys: [`voxel:${position.x}:${position.y}:${position.z}:${originalMaterialId}`],
    });
    remains.grave = {
      position: { ...position },
      accessPosition: { cellId: person.position.cellId, z: person.position.z },
      originalMaterialId,
      preparedByPersonId: person.id,
      preparedAtMonth: atMonth,
      excavationEventId: eventId,
      coverMaterialStackId,
    };
    remains.sourceEventIds = [...new Set([...remains.sourceEventIds, eventId])].slice(-24);
    spendWork(true);
    return {
      status: 'completed' as const,
      result: `${person.name}在近身地表挖出一处可放置遗体的墓穴，并保留覆土`,
      diff: {
        mortuaryPhase: phase,
        remainsId: remains.id,
        deceasedPersonId: deceased.id,
        deathEventId: remains.deathEventId,
        gravePosition: { ...position },
        excavatedMaterialId: originalMaterialId,
        coverMaterialStackId,
        sourceEventIds: [remains.deathEventId],
      },
    };
  }

  if (phase === 'place-in-grave') {
    const grave = remains.grave;
    if (!grave || !atAccess || remains.status !== 'carried' || remains.carriedByPersonId !== person.id
      || voxelAt(state.world.grid, grave.position.x, grave.position.y, grave.position.z) !== Material.Air) {
      return { status: 'blocked' as const, result: '遗体、墓穴或近身位置已经不满足放置条件', diff: {} };
    }
    remains.status = 'placed';
    remains.position = { cellId: cellId(grave.position.x, grave.position.y), z: grave.position.z };
    delete remains.carriedByPersonId;
    grave.placementEventId = eventId;
    remains.sourceEventIds = [...new Set([...remains.sourceEventIds, eventId])].slice(-24);
    spendWork(true);
    return {
      status: 'completed' as const,
      result: `${person.name}把${deceased.name}的遗体放入已经挖好的墓穴`,
      diff: {
        mortuaryPhase: phase, remainsId: remains.id, deceasedPersonId: deceased.id,
        deathEventId: remains.deathEventId, gravePosition: { ...grave.position }, excavationEventId: grave.excavationEventId,
      },
    };
  }

  if (phase === 'cover-grave') {
    const grave = remains.grave;
    const coverRef = action.targets.find((target) => target.kind === 'inventory-stack');
    const cover = coverRef?.kind === 'inventory-stack' && coverRef.personId === person.id
      ? person.inventory.find((stack) => stack.id === coverRef.stackId && stack.quantity > 0)
      : undefined;
    if (!grave || !atAccess || remains.status !== 'placed'
      || !cover
      || cover.id !== grave.coverMaterialStackId
      || cover.materialId !== grave.originalMaterialId
      || !cover.sourceEventIds.includes(grave.excavationEventId)
      || voxelAt(state.world.grid, grave.position.x, grave.position.y, grave.position.z) !== Material.Air) {
      return { status: 'blocked' as const, result: '覆土没有来自这座墓穴的真实挖掘物，或墓穴状态已经变化', diff: {} };
    }
    cover.quantity -= 1;
    removeEmptyStacks(person);
    setVoxel(state.world.grid, grave.position.x, grave.position.y, grave.position.z, grave.originalMaterialId);
    remains.status = 'interred';
    remains.interredAtMonth = atMonth;
    remains.interredByPersonId = person.id;
    remains.position = { cellId: cellId(grave.position.x, grave.position.y), z: grave.position.z };
    grave.burialEventId = eventId;
    remains.sourceEventIds = [...new Set([...remains.sourceEventIds, eventId])].slice(-24);
    for (const observer of state.people) {
      const grief = bereavementFor(observer, remains.id);
      if (grief) grief.careResolvedAtMonth = atMonth;
    }
    spendWork(true);
    return {
      status: 'completed' as const,
      result: `${person.name}用原墓穴覆土安葬了${deceased.name}`,
      diff: {
        mortuaryPhase: phase,
        remainsInterred: true,
        remainsId: remains.id,
        deceasedPersonId: deceased.id,
        deathEventId: remains.deathEventId,
        gravePosition: { ...grave.position },
        excavationEventId: grave.excavationEventId,
        placementEventId: grave.placementEventId,
        coverMaterialStackId: grave.coverMaterialStackId,
        coverMaterialId: grave.originalMaterialId,
        sourceEventIds: [...new Set([remains.deathEventId, grave.excavationEventId, grave.placementEventId ?? ''])].filter(Boolean),
      },
    };
  }

  if (phase === 'mark') {
    state.world.memorials ??= [];
    const grave = remains.grave;
    const tabletRef = action.targets.find((target) => target.kind === 'inventory-stack');
    const tablet = tabletRef?.kind === 'inventory-stack' && tabletRef.personId === person.id
      ? person.inventory.find((stack) => stack.id === tabletRef.stackId && stack.quantity > 0)
      : undefined;
    const tool = action.toolStackId
      ? person.inventory.find((stack) => stack.id === action.toolStackId && stack.quantity > 0)
      : undefined;
    if (!grave || !atAccess || remains.status !== 'interred' || memorialForRemains(state, remains.id)
      || !tablet || tablet.materialId !== Material.WoodTablet || tablet.recordPayloadId
      || !tool || productionToolRank(tool.materialId) < productionToolRank(Material.StoneTool)) {
      return { status: 'blocked' as const, result: '墓记需要已安葬遗体、近身空白木板和足以刻写的真实工具', diff: {} };
    }
    const tabletSourceEventIds = [...tablet.sourceEventIds];
    tablet.quantity -= 1;
    removeEmptyStacks(person);
    const marker = {
      id: `memorial:${remains.id}`,
      remainsId: remains.id,
      personId: deceased.id,
      position: { ...grave.position, z: grave.position.z + 1 },
      materialId: Material.WoodTablet,
      inscription: deceased.name,
      madeByPersonId: person.id,
      createdAtMonth: atMonth,
      sourceEventIds: [...new Set([
        ...tabletSourceEventIds.slice(-21),
        remains.deathEventId,
        grave.burialEventId ?? '',
        eventId,
      ])].filter(Boolean).slice(-24),
    };
    state.world.memorials.push(marker);
    spendWork();
    return {
      status: 'completed' as const,
      result: `${person.name}消耗一块木制记录板，为${deceased.name}刻下墓记`,
      diff: {
        mortuaryPhase: phase,
        memorialMarked: true,
        memorialId: marker.id,
        remainsId: remains.id,
        deceasedPersonId: deceased.id,
        deathEventId: remains.deathEventId,
        burialEventId: grave.burialEventId,
        markerMaterialId: marker.materialId,
        tabletStackId: tablet.id,
        toolStackId: tool.id,
        inscription: marker.inscription,
        sourceEventIds: marker.sourceEventIds,
      },
    };
  }

  return { status: 'blocked' as const, result: '未知的丧葬动作阶段', diff: {} };
}

function executeAct(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'act' }>, atMonth: number, eventId: string) {
  if (action.operation === 'inter') return executeMortuary(state, person, action, atMonth, eventId);
  if (action.mechanicalPowerBasis) return executeMechanicalPowerAction(state, person, action, atMonth, eventId);
  if (action.operation === 'combine' || action.operation === 'exert' || action.operation === 'expose') {
    const protectedCarrier = action.targets.flatMap((target) => {
      if (target.kind !== 'inventory-stack' || target.personId !== person.id) return [];
      const stack = person.inventory.find((candidate) => candidate.id === target.stackId && candidate.quantity > 0);
      return stack?.recordPayloadId ? [stack] : [];
    })[0];
    if (protectedCarrier?.recordPayloadId) return {
      status: 'blocked' as const,
      result: '已经承载记录的物质不能作为普通加工输入；需要另行定义明确的擦除或回收动作',
      diff: { stackId: protectedCarrier.id, recordPayloadId: protectedCarrier.recordPayloadId },
    };
  }
  if (action.operation === 'ingest') return executeIngest(state, person, action.targets, atMonth, eventId);
  if (action.operation === 'separate') return executeSeparate(state, person, action, atMonth, eventId);
  if (action.operation === 'combine') return executeCombine(state, person, action.targets, atMonth, eventId);
  if (action.operation === 'exert') return executeExert(state, person, action, atMonth, eventId);
  if (action.operation === 'reproduce') return executeReproduce(state, person, action, atMonth, eventId);
  if (action.operation === 'expose') return executeExpose(state, person, action.targets, atMonth, eventId);
  if (action.operation === 'dehydrate') return executeDehydrate(state, person, action, atMonth, eventId);
  if (action.operation === 'rehydrate') return executeRehydrate(state, person, action, atMonth, eventId);
  if (action.operation === 'hunt') return executeHunt(state, person, action, atMonth, eventId);
  const fire = action.targets.find((target) => target.kind === 'voxel' && voxelAt(state.world.grid, target.position.x, target.position.y, target.position.z) === Material.Fire);
  const water = action.targets.find((target) => target.kind === 'voxel' && voxelAt(state.world.grid, target.position.x, target.position.y, target.position.z) === Material.Water);
  if (fire && water && fire.kind === 'voxel') {
    setVoxel(state.world.grid, fire.position.x, fire.position.y, fire.position.z, Material.Ash);
    return { status: 'completed' as const, result: '水使火物质转化为灰', diff: { extinguished: fire.position } };
  }
  return { status: 'blocked' as const, result: '当前暴露组合没有产生变化', diff: {} };
}

function executeAttend(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'attend' }>, atMonth: number, eventId: string) {
  const cell = targetCell(state, action.target);
  if (cell === null || Math.abs(cellX(cell) - cellX(person.position.cellId)) + Math.abs(cellY(cell) - cellY(person.position.cellId)) > 7) return { status: 'blocked' as const, result: '观察目标超出感知范围', diff: {} };
  if (action.waterCurrentSegmentId) {
    const mechanicalPower = state.world.mechanicalPower;
    const segment = mechanicalPower?.version === MECHANICAL_POWER_WORLD_VERSION
      ? mechanicalPower.sources.find((candidate) => candidate.id === action.waterCurrentSegmentId)
      : undefined;
    const position = action.target.kind === 'voxel' ? action.target.position : undefined;
    if (!segment || !position || !segment.requiredWaterVoxels.some((candidate) => samePosition(candidate, position))) {
      return { status: 'blocked' as const, result: '观察目标不是所指水流边的实体水体', diff: {} };
    }
    const perceptionRadius = 4 + Math.floor(person.baselineCapacities.perception / 25);
    if (Math.abs(position.z - person.position.z) > perceptionRadius) {
      return { status: 'blocked' as const, result: '所指水流在垂直方向超出本人感知范围', diff: {} };
    }
    const availability = waterCurrentAvailabilityFor(state.world.grid, mechanicalPower, segment.id);
    if (!availability.available
      || voxelAt(state.world.grid, position.x, position.y, position.z) !== Material.Water) {
      return { status: 'blocked' as const, result: '所指水流当前没有可感知的有效流动', diff: {} };
    }
    const factId = waterCurrentObservationFactId(segment.id);
    const summary = '观察到这段流水当前能持续向下游传递动力';
    const existing = person.knowledge.find((fact) => fact.id === factId && fact.kind === 'observation');
    if (existing) {
      existing.confidence = clamp(Math.max(existing.confidence, 58) + 12);
      existing.sourceEventIds = [...new Set([...existing.sourceEventIds, eventId])].slice(-24);
    } else person.knowledge.push({
      id: factId,
      kind: 'observation',
      summary,
      confidence: 68,
      learnedAtMonth: atMonth,
      sourceEventIds: [eventId],
    });
    return {
      status: 'completed' as const,
      result: summary,
      diff: {
        factId,
        mechanicalPowerObservation: true,
        waterCurrentSegmentId: segment.id,
        availableCapacity: availability.availableCapacity,
        supportingSegmentIds: [...availability.supportingSegmentIds],
        sourceKeys: [...segment.sourceKeys],
        observedPosition: { ...position },
      },
    };
  }
  let factId = `target:${JSON.stringify(action.target)}`;
  let summary = '持续观察了一个对象';
  if (action.target.kind === 'animal') {
    const animalId = action.target.animalId;
    const animal = state.world.animals.find((candidate) => candidate.id === animalId && isAnimalAlive(candidate));
    if (!animal) return { status: 'blocked' as const, result: '要观察的动物已经不在', diff: {} };
    factId = `animal:${animal.speciesId}`;
    summary = `观察并辨认了${animalSpecies(animal.speciesId).name}的行为`;
  }
  if (action.target.kind === 'inventory-stack' && action.target.personId === person.id) {
    const attendedStackId = action.target.stackId;
    const stack = person.inventory.find((candidate) => candidate.id === attendedStackId);
    if (!stack) return { status: 'blocked' as const, result: '观察对象已经不在背包中', diff: {} };
    const record = stack.recordPayloadId ? state.records.find((candidate) => candidate.id === stack.recordPayloadId) : undefined;
    if (record) {
      const codebook = person.knowledge.find((fact) => fact.id === record.codebookId && fact.kind === 'codebook' && fact.confidence >= 55);
      if (!codebook) return {
        status: 'completed' as const,
        result: '看见木制记录板上的规则刻痕，但还不知道这些符号表示什么',
        diff: { recordPayloadId: record.id, understood: false },
      };
      const known = person.knowledge.find((fact) => fact.id === record.knowledgeId);
      if (known) {
        known.confidence = known.kind === 'technique' ? Math.min(54, known.confidence + 8) : clamp(known.confidence + 8);
        known.sourceEventIds = [...new Set([...known.sourceEventIds, eventId, record.id])].slice(-24);
      } else person.knowledge.push({
        id: record.knowledgeId,
        kind: record.kind === 'technique' ? 'technique' : 'claim',
        summary: record.summary,
        confidence: record.kind === 'technique' ? 46 : 52,
        learnedAtMonth: atMonth,
        sourceEventIds: [record.id, eventId],
      });
      return { status: 'completed' as const, result: `阅读木制记录板：${record.summary}`, diff: { recordPayloadId: record.id, learnedFactId: record.knowledgeId, understood: true } };
    }
    const requestedVerification = action.verification;
    const sourceBoundTechnique = requestedVerification
      ? person.knowledge.find((fact) => fact.id === requestedVerification.techniqueId
        && fact.kind === 'technique'
        && fact.sourceEventIds.includes(requestedVerification.sourceEventId))
      : undefined;
    if (requestedVerification
      && sourceBoundTechnique
      && stack.materialId === requestedVerification.expectedMaterialId
      && stack.sourceEventIds.includes(requestedVerification.sourceEventId)) {
      sourceBoundTechnique.confidence = clamp(Math.max(sourceBoundTechnique.confidence, 46) + 22);
      sourceBoundTechnique.sourceEventIds = [...new Set([
        ...sourceBoundTechnique.sourceEventIds,
        eventId,
      ])].slice(-24);
      return {
        status: 'completed' as const,
        result: `核验了${sourceBoundTechnique.summary}`,
        diff: {
          factId: sourceBoundTechnique.id,
          verifiedTechnique: true,
          verifiedSourceEventId: requestedVerification.sourceEventId,
          verifiedMaterialId: stack.materialId,
          verifiedStackId: stack.id,
        },
      };
    }
    const tentativeTechnique = person.knowledge.find((fact) => fact.kind === 'technique' && fact.confidence < 55 && fact.sourceEventIds.some((sourceId) => {
      const source = worldEventById(state, sourceId);
      return source?.kind === 'action'
        && source.action.kind === 'act'
        && (source.action.operation === 'combine' || source.action.operation === 'exert' || source.action.operation === 'expose')
        && source.diff.outputStackId === stack.id
        && Number(source.diff.outputMaterialId) === stack.materialId;
    }));
    if (tentativeTechnique) {
      tentativeTechnique.confidence = clamp(tentativeTechnique.confidence + 22);
      tentativeTechnique.sourceEventIds = [...new Set([...tentativeTechnique.sourceEventIds, eventId])].slice(-24);
      return { status: 'completed' as const, result: `核验了${tentativeTechnique.summary}`, diff: { factId: tentativeTechnique.id, verifiedTechnique: true } };
    }
    factId = `material:${stack.materialId}`;
    summary = `观察并辨认了${materialDefinition(stack.materialId).name}`;
  }
  if (action.target.kind === 'voxel') {
    const attendedPosition = action.target.position;
    const materialId = voxelAt(state.world.grid, attendedPosition.x, attendedPosition.y, attendedPosition.z);
    if (materialId !== Material.Air) rememberMaterialPlace(person, materialId, attendedPosition, atMonth, eventId);
    const requestedVerification = action.verification;
    const sourceBoundTechnique = requestedVerification
      ? person.knowledge.find((fact) => fact.id === requestedVerification.techniqueId
        && fact.kind === 'technique'
        && fact.sourceEventIds.includes(requestedVerification.sourceEventId))
      : undefined;
    if (requestedVerification
      && sourceBoundTechnique
      && materialId === requestedVerification.expectedMaterialId) {
      sourceBoundTechnique.confidence = clamp(Math.max(sourceBoundTechnique.confidence, 46) + 22);
      sourceBoundTechnique.sourceEventIds = [...new Set([
        ...sourceBoundTechnique.sourceEventIds,
        eventId,
      ])].slice(-24);
      return {
        status: 'completed' as const,
        result: `核验了${sourceBoundTechnique.summary}`,
        diff: {
          factId: sourceBoundTechnique.id,
          verifiedTechnique: true,
          verifiedSourceEventId: requestedVerification.sourceEventId,
          verifiedMaterialId: materialId,
          verifiedPosition: { ...attendedPosition },
        },
      };
    }
    const tentativeTechnique = person.knowledge.find((fact) => fact.kind === 'technique' && fact.confidence < 55 && fact.sourceEventIds.some((sourceId) => {
      const source = worldEventById(state, sourceId);
      if (source?.kind !== 'action' || source.action.kind !== 'act' || !['combine', 'exert', 'expose'].includes(source.action.operation)) return false;
      const position = source.diff.position as VoxelPosition | undefined;
      return position?.x === attendedPosition.x
        && position.y === attendedPosition.y
        && position.z === attendedPosition.z
        && Number(source.diff.outputMaterialId) === materialId;
    }));
    if (tentativeTechnique) {
      tentativeTechnique.confidence = clamp(tentativeTechnique.confidence + 22);
      tentativeTechnique.sourceEventIds = [...new Set([...tentativeTechnique.sourceEventIds, eventId])].slice(-24);
      return { status: 'completed' as const, result: `核验了${tentativeTechnique.summary}`, diff: { factId: tentativeTechnique.id, verifiedTechnique: true } };
    }
    factId = `material:${materialId}`;
    summary = `观察并辨认了${materialDefinition(materialId).name}`;
  }
  const existing = person.knowledge.find((fact) => fact.id === factId);
  if (existing) {
    existing.confidence = clamp(existing.confidence + 12);
    existing.sourceEventIds.push(eventId);
  } else {
    person.knowledge.push({ id: factId, kind: 'observation', summary, confidence: 58, learnedAtMonth: atMonth, sourceEventIds: [eventId] });
  }
  return { status: 'completed' as const, result: summary, diff: { factId } };
}

function executeCommunicate(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'communicate' }>, atMonth: number, eventId: string) {
  const coordinationFacilityMaterialId = nearbyFacilityMaterial(
    state,
    person,
    [Material.CouncilHearth, Material.CivicHall, Material.KeepCore],
    3,
  );
  if (action.channel === 'record') {
    const stack = action.carrierStackId ? person.inventory.find((candidate) => candidate.id === action.carrierStackId && candidate.quantity > 0) : undefined;
    if (!stack || !materialHas(stack.materialId, 'recordable') || stack.recordPayloadId) return { status: 'blocked' as const, result: '没有可写且尚未承载内容的记录材料', diff: {} };
    if (action.content.kind !== 'claim' || !action.content.factId) return { status: 'blocked' as const, result: '当前只能把有来源的知识陈述写入记录', diff: {} };
    const knowledgeId = action.content.factId;
    const knowledge = person.knowledge.find((fact) => fact.id === knowledgeId);
    if (!knowledge) return { status: 'blocked' as const, result: '本人并不知道要记录的内容', diff: {} };
    if (knowledge.kind === 'codebook') return { status: 'blocked' as const, result: '编码约定不能作为自己的记录内容再次刻写', diff: {} };
    const priorVersion = state.records.filter((record) => record.knowledgeId === knowledge.id && record.authorId === person.id).reduce((max, record) => Math.max(max, record.version), 0);
    const codebookId = `codebook:record:${person.id}:${knowledge.id}`;
    const payload = {
      id: `record:${atMonth}:${person.id}:${state.records.length}`,
      authorId: person.id,
      knowledgeId: knowledge.id,
      codebookId,
      kind: knowledge.kind,
      summary: knowledge.summary,
      version: priorVersion + 1,
      createdAtMonth: atMonth,
      sourceEventIds: [...new Set([...knowledge.sourceEventIds, eventId])],
    };
    state.records.push(payload);
    const knownCodebook = person.knowledge.find((fact) => fact.id === codebookId);
    if (knownCodebook) {
      knownCodebook.confidence = clamp(knownCodebook.confidence + 16);
      knownCodebook.sourceEventIds = [...new Set([...knownCodebook.sourceEventIds, eventId, payload.id])].slice(-24);
    } else person.knowledge.push({
      id: codebookId,
      kind: 'codebook',
      summary: `这组刻痕表示“${knowledge.summary}”`,
      confidence: 100,
      learnedAtMonth: atMonth,
      sourceEventIds: [eventId, payload.id],
    });
    let carrier = stack;
    if (stack.quantity > 1) {
      stack.quantity -= 1;
      carrier = addInventory(person, stack.materialId, 1, [eventId], `stack-${person.id}-${stack.materialId}-${atMonth}-record-${state.records.length}`, payload.id);
    } else {
      stack.recordPayloadId = payload.id;
      stack.sourceEventIds = [...new Set([...stack.sourceEventIds, eventId])].slice(-24);
    }
    return { status: 'completed' as const, result: `${person.name}把“${knowledge.summary}”刻写到木制记录板`, diff: { recordPayloadId: payload.id, carrierStackId: carrier.id, knowledgeId: knowledge.id, version: payload.version } };
  }
  const content = action.content;
  if (content.kind === 'prediction') {
    const horizon = content.prediction.predictedStartMonth - atMonth;
    if (horizon < 1
      || horizon > MAX_ERA_PREDICTION_HORIZON_MONTHS
      || content.prediction.expiresAtMonth !== content.prediction.predictedStartMonth + content.prediction.toleranceMonths) {
      return {
        status: 'blocked' as const,
        result: '纪元预言只能指向未来六个月内的可验证时间窗',
        diff: { predictionHorizonMonths: horizon },
      };
    }
  }
  if (content.kind === 'request' && content.techniqueDemonstration) {
    const request = content.techniqueDemonstration;
    const projectCandidate = projectById(state, request.projectId);
    const project = projectCandidate?.status === 'active'
      && projectCandidate.kind === 'inquiry'
      && projectCandidate.ownerId === person.id
      && projectCandidate.desiredFunction === request.desiredFunction
      ? projectCandidate
      : undefined;
    const repeated = state.world.past.some((event) => event.kind === 'action'
      && event.status === 'completed'
      && event.who === person.id
      && event.action.kind === 'communicate'
      && event.action.content.kind === 'request'
      && event.action.content.techniqueDemonstration?.projectId === request.projectId
      && event.action.audience.some((listenerId) => action.audience.includes(listenerId)))
      || Boolean(project?.techniqueDemonstrationRequests?.some((basis) => (
        basis.requesterId === person.id
          && basis.teacherIds.some((listenerId) => action.audience.includes(listenerId))
      )));
    if (!project || request.requesterId !== person.id || request.expiresAtMonth < atMonth || repeated) {
      return { status: 'blocked' as const, result: '技术示范请求没有绑定本人当前项目，或已向同一人提出过', diff: {} };
    }
  }
  if (content.kind === 'request' && content.projectMaterialContribution) {
    const request = content.projectMaterialContribution;
    const projectCandidate = projectById(state, request.projectId);
    const project = projectCandidate?.status === 'active'
      && projectCandidate.ownerId === person.id
      && projectSupportsMaterialContribution(projectCandidate)
      && Boolean(projectCandidate.site)
      ? projectCandidate
      : undefined;
    const demand = project?.materialDemands?.find((candidate) => candidate.materialId === request.materialId
      && candidate.outstandingQuantity > 0);
    const repeated = Boolean(project && demand && project.materialContributionRequests?.some((basis) => (
      basis.materialId === request.materialId
        && inspectProjectMaterialContributionRequest(
          state,
          project,
          basis,
          atMonth,
          demand,
        ).status === 'open'
    )));
    if (!project
      || !demand
      || request.version !== 'project-material-contribution-request-v1'
      || request.requesterId !== person.id
      || request.quantity <= 0
      || request.quantity > demand.outstandingQuantity
      || request.site.cellId !== project.site?.cellId
      || request.site.z !== project.site?.z
      || request.expiresAtMonth < atMonth
      || repeated) {
      return { status: 'blocked' as const, result: '材料贡献请求没有绑定当前项目缺口、固定工地，或已经提出过', diff: {} };
    }
  }
  const predictionRange = content.kind === 'prediction'
    ? new Set(cellsInRadius(person.position.cellId, 4))
    : null;
  const techniqueRequestRange = content.kind === 'request'
    && content.techniqueDemonstration
    && action.channel === 'gesture'
    ? new Set(cellsInRadius(person.position.cellId, 4 + Math.floor(person.baselineCapacities.perception / 25)))
    : null;
  const materialRequestRange = content.kind === 'request'
    && content.projectMaterialContribution
    && action.channel === 'gesture'
    ? new Set(cellsInRadius(person.position.cellId, 4 + Math.floor(person.baselineCapacities.perception / 25)))
    : null;
  const coordinationRange = coordinationFacilityMaterialId ? new Set(cellsInRadius(person.position.cellId, 2)) : null;
  const reached = state.people.filter((candidate) => action.audience.includes(candidate.id)
    && (predictionRange
      ? predictionRange.has(candidate.position.cellId)
      : techniqueRequestRange
        ? techniqueRequestRange.has(candidate.position.cellId) && Math.abs(candidate.position.z - person.position.z) <= 2
        : materialRequestRange
          ? materialRequestRange.has(candidate.position.cellId) && Math.abs(candidate.position.z - person.position.z) <= 2
        : coordinationRange
          ? coordinationRange.has(candidate.position.cellId) && Math.abs(candidate.position.z - person.position.z) <= 2
          : sameLocation(candidate, person)));
  if (!reached.length) return { status: 'blocked' as const, result: '受众不在当前沟通范围', diff: {} };
  const groundedConversation = validateGroundedConversation(state, person, action, reached);
  if (groundedConversation.kind === 'blocked') {
    return { status: 'blocked' as const, result: groundedConversation.reason, diff: { groundedConversationBlocked: true } };
  }
  const explicitTeaching = content.kind === 'claim'
    && Boolean(content.factId)
    && content.id.startsWith('teach:');
  const teachingKnowledge = explicitTeaching
    ? person.knowledge.find((fact) => fact.id === content.factId)
    : undefined;
  if (explicitTeaching
    && (!teachingKnowledge
      || (teachingKnowledge.kind !== 'technique' && teachingKnowledge.kind !== 'codebook')
      || teachingKnowledge.confidence < 55)) {
    return { status: 'blocked' as const, result: '本人尚未可靠掌握这项知识，不能作为教导传授', diff: {} };
  }
  if (explicitTeaching && reached.some((listener) => ageMonths(listener, atMonth) < MIN_TEACHING_AGE_MONTHS)) {
    return { status: 'blocked' as const, result: '受教者尚未达到能够可靠学习技术的年龄', diff: {} };
  }
  if (content.kind === 'request' && content.techniqueDemonstration) {
    const request = content.techniqueDemonstration;
    const project = projectById(state, request.projectId);
    if (project) {
      project.techniqueDemonstrationRequests ??= [];
      project.techniqueDemonstrationRequests.push({
        version: 'project-technique-demonstration-request-v1',
        requestEventId: eventId,
        projectId: project.id,
        requesterId: person.id,
        teacherIds: reached.map((listener) => listener.id),
        desiredFunction: request.desiredFunction,
        expiresAtMonth: request.expiresAtMonth,
        atMonth,
      });
    }
  }
  if (content.kind === 'request' && content.projectMaterialContribution) {
    const request = content.projectMaterialContribution;
    const project = projectById(state, request.projectId);
    if (project) {
      project.materialContributionRequests ??= [];
      project.materialContributionRequests.push({
        version: 'project-material-contribution-request-v1',
        requestEventId: eventId,
        projectId: project.id,
        requesterId: person.id,
        contributorIds: reached
          .filter((listener) => inventoryQuantity(listener, request.materialId) > 0)
          .map((listener) => listener.id),
        materialId: request.materialId,
        requestedQuantity: request.quantity,
        site: { ...request.site },
        expiresAtMonth: request.expiresAtMonth,
        atMonth,
      });
    }
  }
  if (content.kind === 'prediction') {
    if (state.eraPredictions.some((prediction) => prediction.id === content.id)) {
      return { status: 'completed' as const, result: '这项纪元预言已经留下可验证记录', diff: { predictionId: content.id, duplicate: true } };
    }
    state.eraPredictions.push({
      id: content.id,
      predictorId: person.id,
      audienceIds: reached.map((listener) => listener.id),
      madeAtMonth: atMonth,
      targetEpoch: content.prediction.targetEpoch,
      predictedStartMonth: content.prediction.predictedStartMonth,
      toleranceMonths: content.prediction.toleranceMonths,
      expiresAtMonth: content.prediction.expiresAtMonth,
      status: 'pending',
      sourceEventIds: [eventId],
    });
    const forecastKnowledge = person.knowledge.find((fact) => fact.id === 'technique:era-forecast');
    if (forecastKnowledge) {
      forecastKnowledge.sourceEventIds = [...new Set([...forecastKnowledge.sourceEventIds, eventId])].slice(-24);
    } else person.knowledge.push({
      id: 'technique:era-forecast',
      kind: 'technique',
      summary: '综合天象、气温与纪元节律预测下一次纪元变化',
      confidence: clamp(26 + (person.baselineCapacities.cognition + person.baselineCapacities.perception) / 6),
      learnedAtMonth: atMonth,
      sourceEventIds: [eventId],
    });
  }
  const taughtAudienceIds: string[] = [];
  const teachingConfidenceByAudience: Record<string, number> = {};
  if (content.kind === 'claim' && content.factId) {
    const speakerKnowledge = person.knowledge.find((fact) => fact.id === content.factId);
    if (speakerKnowledge) {
      for (const listener of reached) {
        const reliableTeachingConfidence = explicitTeaching
          ? Math.max(
              coordinationFacilityMaterialId ? 66 : 60,
              maternalFirstTeachingConfidence(state, person, listener),
            )
          : 0;
        const known = listener.knowledge.find((fact) => fact.id === content.factId);
        if (known) {
          const nextConfidence = known.confidence + 6;
          known.confidence = explicitTeaching
            ? Math.max(reliableTeachingConfidence, known.confidence)
            : speakerKnowledge.kind === 'technique' || speakerKnowledge.kind === 'codebook'
              ? Math.min(54, nextConfidence)
              : clamp(nextConfidence);
          known.sourceEventIds = [...new Set([...known.sourceEventIds, eventId])].slice(-24);
        } else listener.knowledge.push({
          id: content.factId,
          kind: speakerKnowledge.kind,
          summary: speakerKnowledge.summary,
          confidence: explicitTeaching
            ? reliableTeachingConfidence
            : speakerKnowledge.kind === 'technique' || speakerKnowledge.kind === 'codebook'
              ? 46
              : 36,
          learnedAtMonth: atMonth,
          sourceEventIds: [eventId],
        });
        const mineralObservation = parsedMineralObservation(content.factId);
        if (mineralObservation && person.knownPlaces.some((place) => place.materialId === mineralObservation.materialId
          && place.position.x === mineralObservation.position.x
          && place.position.y === mineralObservation.position.y
          && place.position.z === mineralObservation.position.z)) {
          rememberMaterialPlace(
            listener,
            mineralObservation.materialId,
            mineralObservation.position,
            atMonth,
            eventId,
          );
        }
        if (explicitTeaching) {
          taughtAudienceIds.push(listener.id);
          teachingConfidenceByAudience[listener.id] = reliableTeachingConfidence;
          if (reliableTeachingConfidence === 72) {
            listener.maternalTeachingSourceEventIds = [...new Set([
              ...(listener.maternalTeachingSourceEventIds ?? []),
              eventId,
            ])];
          }
        }
      }
    }
  }
  for (const listener of reached) {
    // Grounded dialogue changes relationships through its actual turn; teaching only transfers knowledge.
    const familiarity = groundedConversation.kind === 'valid'
      ? groundedConversation.bondDelta
      : explicitTeaching || action.content.kind === 'reject' || action.content.kind === 'withdraw' || action.content.kind === 'revoke' || action.content.kind === 'revoke-agreement'
        ? 0
        : 1;
    const trust = groundedConversation.kind === 'valid' ? groundedConversation.trustDelta : 0;
    if (familiarity !== 0 || trust !== 0) {
      applyRelationEvidence(listener, person.id, eventId, { bond: familiarity, trust });
      applyRelationEvidence(person, listener.id, eventId, { bond: familiarity, trust });
    }
  }
  const deathNewsPersonIds: string[] = [];
  if (groundedConversation.kind === 'valid'
    && groundedConversation.conversation.topic === 'loss'
    && groundedConversation.conversation.turn === 'opening') {
    const deathSource = groundedConversation.conversation.sourceFactIds
      .map((sourceId) => worldEventById(state, sourceId))
      .find((source) => source?.kind === 'environment' && source.change === 'death');
    const remains = deathSource
      ? (state.world.remains ?? []).find((candidate) => candidate.deathEventId === deathSource.id)
      : undefined;
    if (remains) {
      for (const listener of reached) {
        if (learnOfDeath(state, listener, remains, atMonth, 'told', eventId)) deathNewsPersonIds.push(listener.id);
      }
    }
  }
  const assertedKnowledge = content.kind === 'claim' && content.factId ? person.knowledge.find((fact) => fact.id === content.factId) : undefined;
  return {
    status: 'completed' as const,
    result: `${person.name}向${reached.map((item) => item.name).join('、')}表达：${'summary' in action.content ? action.content.summary : action.content.kind}`,
    diff: {
      audience: reached.map((item) => item.id),
      content: action.content,
      ...(assertedKnowledge ? { assertedFactId: assertedKnowledge.id, assertedFactSourceEventIds: assertedKnowledge.sourceEventIds } : {}),
      ...(explicitTeaching && teachingKnowledge ? {
        explicitTeaching: true,
        teachingFactId: teachingKnowledge.id,
        teachingKnowledgeKind: teachingKnowledge.kind,
        teachingTeacherConfidence: teachingKnowledge.confidence,
        taughtAudienceIds,
        teachingReliableConfidence: Math.max(0, ...Object.values(teachingConfidenceByAudience)),
        teachingConfidenceByAudience,
      } : {}),
      ...(coordinationFacilityMaterialId ? {
        facilityMaterialId: coordinationFacilityMaterialId,
        coordinationAudienceCapacity: reached.length,
      } : {}),
      ...(groundedConversation.kind === 'valid' ? {
        groundedConversationBasisKey: groundedConversation.conversation.basisKey,
        groundedConversationTopic: groundedConversation.conversation.topic,
        groundedConversationTurn: groundedConversation.conversation.turn,
        groundedConversationSourceFactIds: groundedConversation.conversation.sourceFactIds,
        groundedConversationReferenceEventId: groundedConversation.conversation.referenceEventId,
        groundedConversationStance: groundedConversation.conversation.stance,
        relationTrustDelta: groundedConversation.trustDelta,
        relationBondDelta: groundedConversation.bondDelta,
      } : {}),
      ...(deathNewsPersonIds.length ? {
        deathNewsPersonIds,
        deathNewsSourceEventIds: groundedConversation.kind === 'valid'
          ? groundedConversation.conversation.sourceFactIds
          : [],
      } : {}),
    },
  };
}

type TechniqueLearningValidation =
  | { kind: 'none' }
  | { kind: 'blocked'; reason: string }
  | {
      kind: 'demonstration';
      descriptor: TechniqueActionDescriptor;
      project: ProjectState;
      learner: PersonState;
      demonstratorId: string;
      requestEventId: string;
    }
  | {
      kind: 'imitation';
      descriptor: TechniqueActionDescriptor;
      project: ProjectState;
      basis: ProjectTechniqueDemonstrationBasis;
      learner: PersonState;
      confidenceBefore: number;
    };

function sameMaterials(first: MaterialId[], second: MaterialId[]): boolean {
  return [...first].sort((left, right) => left - right).join(',')
    === [...second].sort((left, right) => left - right).join(',');
}

function validateTechniqueLearningAction(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'act' }>,
  atMonth: number,
): TechniqueLearningValidation {
  if (!action.techniqueDemonstration && !action.techniqueImitation) return { kind: 'none' };
  if (action.techniqueDemonstration && action.techniqueImitation) {
    return { kind: 'blocked', reason: '同一操作不能同时作为示范和模仿' };
  }
  const descriptor = describeTechniqueAction(state, person, action);
  if (!descriptor) return { kind: 'blocked', reason: '示范或模仿没有绑定当前可执行的权威物质操作' };

  if (action.techniqueDemonstration) {
    const ref = action.techniqueDemonstration;
    if (descriptor.techniqueId !== ref.techniqueId) {
      return { kind: 'blocked', reason: '实际操作与请求绑定的技术不一致' };
    }
    const requestEvent = worldEventById(state, ref.requestEventId);
    const historicalRequest = requestEvent?.kind === 'action'
      && requestEvent.status === 'completed'
      && requestEvent.action.kind === 'communicate'
      && requestEvent.action.content.kind === 'request'
      && requestEvent.action.content.techniqueDemonstration
      ? requestEvent.action.content.techniqueDemonstration
      : null;
    const requestProject = projectById(state, ref.projectId);
    const pendingRequest = requestProject?.techniqueDemonstrationRequests?.find((candidate) => (
      candidate.requestEventId === ref.requestEventId
    ));
    const request = historicalRequest ?? pendingRequest;
    if (!request) {
      return { kind: 'blocked', reason: '找不到已完成且有明确项目的技术示范请求' };
    }
    const requesterId = historicalRequest && requestEvent?.kind === 'action'
      ? requestEvent.who
      : pendingRequest?.requesterId;
    const addressedTeacherIds = historicalRequest && requestEvent?.kind === 'action'
      && requestEvent.action.kind === 'communicate'
      ? requestEvent.action.audience
      : pendingRequest?.teacherIds ?? [];
    if (requesterId !== request.requesterId
      || !addressedTeacherIds.includes(person.id)
      || request.projectId !== ref.projectId
      || request.requesterId !== ref.learnerId
      || request.expiresAtMonth < atMonth) {
      return { kind: 'blocked', reason: '技术示范请求的人员、项目或有效期不匹配' };
    }
    const projectCandidate = projectById(state, ref.projectId);
    const project = projectCandidate?.status === 'active'
      && projectCandidate.kind === 'inquiry'
      && projectCandidate.ownerId === ref.learnerId
      && projectCandidate.desiredFunction === request.desiredFunction
      ? projectCandidate
      : undefined;
    const learnerCandidate = personById(state, ref.learnerId);
    const learner = learnerCandidate && isAlive(learnerCandidate) ? learnerCandidate : undefined;
    if (!project || !learner || !canObserveTechniqueDemonstration(learner, person)) {
      return { kind: 'blocked', reason: '项目、学习者或可观察范围已经失效' };
    }
    if (project.techniqueDemonstrations?.some((basis) => basis.requestEventId === ref.requestEventId)) {
      return { kind: 'blocked', reason: '这项请求已经得到一次真实示范' };
    }
    const teacherKnowledge = person.knowledge.find((fact) => fact.id === ref.techniqueId
      && fact.kind === 'technique'
      && fact.confidence >= 55);
    if (!teacherKnowledge || !techniqueSupportsProjectFunction(ref.techniqueId, request.desiredFunction)) {
      return { kind: 'blocked', reason: '示范者没有与项目功能匹配的可靠技术' };
    }
    return {
      kind: 'demonstration',
      descriptor,
      project,
      learner,
      demonstratorId: person.id,
      requestEventId: ref.requestEventId,
    };
  }

  const ref = action.techniqueImitation!;
  const projectCandidate = projectById(state, ref.projectId);
  const project = projectCandidate?.status === 'active' && projectCandidate.ownerId === person.id
    ? projectCandidate
    : undefined;
  const basis = project?.techniqueDemonstrations?.find((candidate) => (
    candidate.demonstrationEventId === ref.demonstrationEventId
      && candidate.techniqueId === ref.techniqueId
      && candidate.learnerId === person.id
  ));
  if (!project || !basis) return { kind: 'blocked', reason: '模仿没有绑定本人项目中的真实示范' };
  const tentative = person.knowledge.find((fact) => fact.id === ref.techniqueId
    && fact.kind === 'technique'
    && fact.sourceEventIds.includes(ref.demonstrationEventId));
  if (!tentative || tentative.confidence >= 55) {
    return { kind: 'blocked', reason: tentative ? '这项技术已经可靠，不再需要冒充首次模仿' : '本人尚未从该示范形成暂定经验' };
  }
  if (descriptor.techniqueId !== ref.techniqueId
    || descriptor.operation !== basis.operation
    || descriptor.outputMaterialId !== basis.outputMaterialId
    || descriptor.toolMaterialId !== basis.toolMaterialId
    || descriptor.targetMaterialId !== basis.targetMaterialId
    || !sameMaterials(descriptor.inputMaterialIds, basis.inputMaterialIds)) {
    return { kind: 'blocked', reason: '本人的复现没有保持示范中的输入、工具、目标与响应关系' };
  }
  return { kind: 'imitation', descriptor, project, basis, learner: person, confidenceBefore: tentative.confidence };
}

function applyTechniqueLearning(
  validation: TechniqueLearningValidation,
  outcome: { status: 'progressed' | 'completed' | 'blocked' | 'failed'; result: string; diff: Record<string, unknown> },
  eventId: string,
  atMonth: number,
): void {
  if (outcome.status !== 'completed') return;
  if (validation.kind === 'demonstration') {
    // Entity identity is carried by sourceKeys. Event lineage stays resolvable:
    // the request and this real response are both committed to world.past.
    const sourceFactIds = [validation.requestEventId, eventId];
    let learned = validation.learner.knowledge.find((fact) => fact.id === validation.descriptor.techniqueId);
    const confidenceBefore = learned?.confidence ?? 0;
    if (learned) {
      learned.confidence = Math.min(54, Math.max(46, learned.confidence));
      learned.sourceEventIds = [...new Set([...learned.sourceEventIds, ...sourceFactIds])].slice(-24);
    } else {
      learned = {
        id: validation.descriptor.techniqueId,
        kind: 'technique',
        summary: validation.descriptor.summary,
        confidence: 46,
        learnedAtMonth: atMonth,
        sourceEventIds: sourceFactIds.slice(-24),
      };
      validation.learner.knowledge.push(learned);
    }
    const basis: ProjectTechniqueDemonstrationBasis = {
      version: 'project-technique-demonstration-basis-v1',
      projectId: validation.project.id,
      desiredFunction: validation.project.desiredFunction,
      learnerId: validation.learner.id,
      demonstratorId: validation.demonstratorId,
      requestEventId: validation.requestEventId,
      demonstrationEventId: eventId,
      techniqueId: validation.descriptor.techniqueId,
      operation: validation.descriptor.operation,
      inputMaterialIds: [...validation.descriptor.inputMaterialIds],
      ...(validation.descriptor.toolMaterialId !== undefined
        ? { toolMaterialId: validation.descriptor.toolMaterialId }
        : {}),
      ...(validation.descriptor.targetMaterialId !== undefined
        ? { targetMaterialId: validation.descriptor.targetMaterialId }
        : {}),
      outputMaterialId: validation.descriptor.outputMaterialId,
      sourceKeys: [...validation.descriptor.sourceKeys],
      sourceFactIds,
      initialConfidence: learned.confidence,
      atMonth,
    };
    validation.project.techniqueDemonstrations ??= [];
    validation.project.techniqueDemonstrations.push(basis);
    outcome.diff = {
      ...outcome.diff,
      techniqueLearningStage: 'demonstration',
      techniqueId: validation.descriptor.techniqueId,
      techniqueProjectId: validation.project.id,
      techniqueLearnerId: validation.learner.id,
      techniqueRequestEventId: validation.requestEventId,
      techniqueDemonstratorId: basis.demonstratorId,
      techniqueSourceKeys: [...validation.descriptor.sourceKeys],
      techniqueConfidenceBefore: confidenceBefore,
      techniqueConfidenceAfter: learned.confidence,
    };
    return;
  }
  if (validation.kind === 'imitation') {
    const confidenceAfter = validation.learner.knowledge
      .find((fact) => fact.id === validation.descriptor.techniqueId)?.confidence ?? 0;
    outcome.diff = {
      ...outcome.diff,
      techniqueLearningStage: 'imitation',
      techniqueId: validation.descriptor.techniqueId,
      techniqueProjectId: validation.project.id,
      techniqueLearnerId: validation.basis.learnerId,
      techniqueDemonstrationEventId: validation.basis.demonstrationEventId,
      techniqueImitationSourceKeys: [...validation.descriptor.sourceKeys],
      techniqueConfidenceBefore: validation.confidenceBefore,
      techniqueConfidenceAfter: confidenceAfter,
    };
  }
}

export function executeIntentAction(
  state: SimulationState,
  person: PersonState,
  intent: Intent,
  atMonth: number,
  orderInMonth: number,
  actionTick: number,
): ActionFact {
  return executePrimitiveAction(state, person, intent.nextAction, atMonth, orderInMonth, { intentId: intent.id, cause: 'intent', actionTick });
}

function hibernationRecoveryActionAllowed(
  state: SimulationState,
  person: PersonState,
  action: PrimitiveAction,
  atMonth: number,
): boolean {
  if (lifePlanningStage(person, atMonth) === 'dependent-child') {
    return action.kind === 'move' && Boolean(action.wildlifeThreatBasis)
      || action.kind === 'act'
      && action.operation === 'ingest'
      && action.targets.some((target) => target.kind === 'inventory-stack' && target.personId === person.id);
  }
  if (action.kind === 'move') return true;
  if (action.kind === 'transfer') {
    return action.to.kind === 'person'
      && action.to.personId === person.id
      && (materialHas(action.materialId, 'edible') || materialHas(action.materialId, 'drinkable'));
  }
  if (action.kind !== 'act') return false;
  if (action.operation === 'ingest') return true;
  if (action.operation !== 'separate') return false;
  return action.targets.some((target) => target.kind === 'voxel'
    && (voxelAt(state.world.grid, target.position.x, target.position.y, target.position.z) === Material.BerryBush
      || voxelAt(state.world.grid, target.position.x, target.position.y, target.position.z) === Material.CropMature));
}

export function executePrimitiveAction(
  state: SimulationState,
  person: PersonState,
  action: PrimitiveAction,
  atMonth: number,
  orderInMonth: number,
  meta: { intentId?: string; cause: ActionFact['cause']; actionTick: number },
): ActionFact {
  const eventId = `e-${atMonth}-action-${person.id}-${orderInMonth}`;
  const fromCellId = person.position.cellId;
  const fromZ = person.position.z;
  const blockedByHibernationRecovery = isRecoveringFromDehydratedHibernation(person)
    && !hibernationRecoveryActionAllowed(state, person, action, atMonth);
  const techniqueLearning = action.kind === 'act'
    ? validateTechniqueLearningAction(state, person, action, atMonth)
    : { kind: 'none' as const };
  const outcome = blockedByHibernationRecovery
    ? { status: 'blocked' as const, result: '休眠恢复完成前只能取水、取食或进行必要移动', diff: { hibernationRecoveryRestricted: true } }
    : techniqueLearning.kind === 'blocked'
    ? { status: 'blocked' as const, result: techniqueLearning.reason, diff: {} }
    : action.kind === 'move'
      ? executeMove(state, person, action, eventId, atMonth)
      : action.kind === 'transfer'
        ? executeTransfer(state, person, action, atMonth, eventId)
        : action.kind === 'act'
          ? executeAct(state, person, action, atMonth, eventId)
          : action.kind === 'attend'
            ? executeAttend(state, person, action, atMonth, eventId)
            : executeCommunicate(state, person, action, atMonth, eventId);
  if (outcome.status === 'completed'
    && action.kind === 'act'
    && action.operation === 'ingest'
    && isRecoveringFromDehydratedHibernation(person)) {
    const episode = person.conditions.find((condition) => condition.kind === 'dehydrated-hibernation'
      && hibernationPhase(condition) === 'recovering');
    if (episode) {
      episode.recoverySourceEventIds = [...new Set([...(episode.recoverySourceEventIds ?? []), eventId])].slice(-24);
      Object.assign(outcome.diff, {
        hibernationRecoverySource: true,
        hibernationConditionId: episode.id,
        hibernationPhase: 'recovering',
      });
    }
  }
  applyTechniqueLearning(techniqueLearning, outcome, eventId, atMonth);
  const pathSegment = 'path' in outcome ? outcome.path : [fromCellId];
  const fact: ActionFact = {
    id: eventId,
    kind: 'action',
    actionTick: meta.actionTick,
    atMonth,
    orderInMonth,
    cellId: person.position.cellId,
    who: person.id,
    ...(meta.intentId ? { intentId: meta.intentId } : {}),
    cause: meta.cause,
    action,
    fromCellId,
    toCellId: person.position.cellId,
    fromZ,
    toZ: person.position.z,
    pathSegment,
    status: outcome.status,
    result: outcome.result,
    diff: outcome.diff,
  };
  recordAgreementAction(state, fact);
  recordCollectiveAction(state, fact);
  recordGovernanceAction(state, fact);
  recordPermissionAction(state, fact);
  recordInteractionFailureKnowledge(state, fact);
  recordWitnessedDeclarationFulfillment(state, fact);
  rememberAction(state, fact);
  recordPersonalityEvidence(state, fact);
  recordActionOutcomeBelief(state, fact);
  return fact;
}
