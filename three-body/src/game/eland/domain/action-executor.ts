import type { FactPredicate, GroundedConversationRef, Intent, PrimitiveAction, VoxelPosition, WorldRef } from './action';
import { Material, materialDefinition, materialHas, type MaterialId } from './material';
import { ageMonths, inventoryQuantity, isAlive, MIN_TEACHING_AGE_MONTHS, sameLocation, type ItemStack, type PersonState } from './person';
import type { ActionFact, DropState, SimulationState } from './model';
import { cellId, cellX, cellY, cellsInRadius, findStandingPath, setVoxel, standingMovementCost, surfaceMaterial, surfaceStandingPosition, voxelAt, type StandingPosition } from '../world/grid';
import { seededFraction } from '../world/generator';
import { communicationById } from './social-facts';
import { remember, rememberAction } from './memory';
import { recordPersonalityEvidence } from './personality';
import { applyRelationEvidence } from './relation';
import { activeReproductionAgreementBetween, agreementAuthorizesTransfer, agreementById, recordAgreementAction } from './agreement';
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
import { humanReproductionCapacityFactor, HUMAN_SOFT_CARRYING_CAPACITY } from './population-capacity';
import { lifePlanningStage } from './life-stage';
import { hasReproductiveRecoveryCondition } from './dependent-care';
import { hasCultivatedReproductiveRelationship } from './relationship-evidence';
import {
  isActionableChaosPrediction,
  MAX_ERA_PREDICTION_HORIZON_MONTHS,
  personTrustsEraPrediction,
} from './era-prediction';

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
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

function productionToolMultiplier(materialId: MaterialId | undefined): number {
  if (materialId === Material.IronTool) return 2.6;
  if (materialId === Material.BronzeTool) return 2.05;
  if (materialId === Material.StoneHoe || materialId === Material.StoneTool) return 1.5;
  if (materialId === Material.WoodTool || materialId === Material.BoneTool) return 1.25;
  return 1;
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
    const warmTopic = ['care', 'gratitude', 'shared-work', 'family'].includes(conversation.topic);
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
): DropState {
  const resolvedZ = z ?? surfaceStandingPosition(state.world.grid, cell)?.z ?? 1;
  const existing = state.world.drops.find((drop) => drop.cellId === cell && drop.z === resolvedZ && drop.materialId === materialId && drop.recordPayloadId === recordPayloadId && drop.quantity > 0);
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
  if (goal.kind === 'body-at-most') return (state.people.find((candidate) => candidate.id === goal.personId)?.body[goal.field] ?? Number.POSITIVE_INFINITY) <= goal.value;
  if (goal.kind === 'inventory-at-least') {
    const owner = goal.personId ? state.people.find((candidate) => candidate.id === goal.personId) : person;
    return owner ? inventoryQuantity(owner, goal.materialId) >= goal.quantity : false;
  }
  if (goal.kind === 'record-held') {
    const owner = goal.personId ? state.people.find((candidate) => candidate.id === goal.personId) : person;
    return owner?.inventory.some((stack) => stack.quantity > 0 && stack.recordPayloadId === goal.recordId) ?? false;
  }
  if (goal.kind === 'container-inventory-at-least') {
    const container = containerById(state, goal.containerId);
    return Boolean(container && containerQuantity(container, goal.materialId) >= goal.quantity);
  }
  if (goal.kind === 'at-cell') return person.position.cellId === goal.cellId;
  if (goal.kind === 'sheltered') return Boolean(shelterGeometryAt(state.world.grid, person.position));
  if (goal.kind === 'voxel-is') return voxelAt(state.world.grid, goal.position.x, goal.position.y, goal.position.z) === goal.materialId;
  if (goal.kind === 'knowledge') return (goal.personId ? state.people.find((candidate) => candidate.id === goal.personId) : person)?.knowledge.some((fact) => fact.id === goal.factId && fact.confidence >= (goal.minConfidence ?? 0)) ?? false;
  if (goal.kind === 'near-person') {
    const other = state.people.find((candidate) => candidate.id === goal.personId);
    return Boolean(other && sameLocation(person, other));
  }
  if (goal.kind === 'condition') return state.people.find((candidate) => candidate.id === goal.personId)?.conditions.some((condition) => condition.kind === goal.condition) === goal.present;
  if (goal.kind === 'project-completed') return state.projects.some((project) => project.id === goal.projectId && project.status === 'completed');
  if (goal.kind === 'technique-demonstrated') return state.projects.some((project) => project.id === goal.projectId
    && project.techniqueDemonstrations?.some((basis) => basis.requestEventId === goal.requestEventId));
  return Boolean(communicationById(state, goal.representationId));
}

function targetCell(state: SimulationState, target: WorldRef): number | null {
  if (target.kind === 'voxel') return cellId(target.position.x, target.position.y);
  if (target.kind === 'drop') return state.world.drops.find((drop) => drop.id === target.dropId)?.cellId ?? null;
  if (target.kind === 'container') {
    const container = containerById(state, target.containerId);
    return container ? cellId(container.position.x, container.position.y) : null;
  }
  if (target.kind === 'person') return state.people.find((person) => person.id === target.personId)?.position.cellId ?? null;
  if (target.kind === 'animal') return state.world.animals.find((animal) => animal.id === target.animalId)?.position.cellId ?? null;
  return state.people.find((person) => person.id === target.personId)?.position.cellId ?? null;
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
  if (person.conditions.some((condition) => condition.kind === 'dehydrated-hibernation')) return { status: 'blocked' as const, path: [person.position.cellId], result: '处于脱水休眠，无法移动', diff: {} };
  if (person.conditions.some((condition) => condition.kind === 'restrained')) return { status: 'blocked' as const, path: [person.position.cellId], result: '身体受到拘束，无法远距离移动', diff: {} };
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
    && !candidate.conditions.some((condition) => condition.kind === 'dehydrated-hibernation'));
  for (const dependent of carried) {
    dependent.position.cellId = to.cellId;
    dependent.position.z = to.z;
    dependent.position.lastPath.push(to.cellId);
  }
  person.body.hydration = clamp(person.body.hydration - Math.max(0, segment.length - 1) * 0.25);
  person.body.nutrition = clamp(person.body.nutrition - Math.max(0, segment.length - 1) * 0.16);
  const materialChanges = compactTraversedSurface(state, segment, eventId);
  const reached = to.cellId === action.toCellId && (action.toZ === undefined || to.z === action.toZ);
  return {
    status: reached ? 'completed' as const : 'progressed' as const,
    path: segment.map((position) => position.cellId),
    result: reached ? `沿可容身空间到达格 ${cellX(to.cellId)}, ${cellY(to.cellId)} 的高度 ${to.z}` : `沿可容身空间推进了 ${moved ? 1 : 0} 步`,
    diff: {
      spentWork: spent,
      verticalPath: segment.map((position) => position.z),
      materialChanges,
      ...(carried.length ? { carriedPersonIds: carried.map((dependent) => dependent.id) } : {}),
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
    sourcePerson = state.people.find((candidate) => candidate.id === sourcePersonId);
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
  let destinationPerson: PersonState | undefined;
  let destinationContainer: ContainerState | undefined;
  if (action.to.kind === 'person') {
    const receiverId = action.to.personId;
    destinationPerson = state.people.find((candidate) => candidate.id === receiverId);
    if (!destinationPerson || !sameLocation(destinationPerson, person)) return { status: 'blocked' as const, result: '接收者不在近身范围', diff: {} };
  } else if (action.to.kind === 'container') {
    destinationContainer = containerById(state, action.to.containerId);
    if (!destinationContainer || !canAccessContainer(person, destinationContainer)) return { status: 'blocked' as const, result: '目标容器不在近身操作范围', diff: {} };
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
    diff: { materialId: action.materialId, quantity, authorized, agreementAuthorized, permissionAuthorized, mandateAuthorized, mandateUse, from: action.from, to: action.to, witnessedBy, ...((sourceStack?.recordPayloadId ?? sourceDrop?.recordPayloadId) ? { recordPayloadId: sourceStack?.recordPayloadId ?? sourceDrop?.recordPayloadId } : {}) },
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
    const consumed = consumeStack(person, stack);
    return { status: 'completed' as const, result: `摄入了${materialDefinition(consumed.materialId).name}`, diff: consumed };
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
    const restrained = state.people.find((candidate) => candidate.id === target.personId && sameLocation(candidate, person));
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
  const tool = selectedTool && materialHas(selectedTool.materialId, 'tool') ? selectedTool : undefined;
  const toolMultiplier = productionToolMultiplier(tool?.materialId);
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
    output.push({ materialId: Material.Food, quantity: 3 }, { materialId: Material.Seed, quantity: 1 });
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
      ...(selectedTool ? { toolMaterialId: selectedTool.materialId, toolStackId: selectedTool.id } : {}),
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
  const facilityBonus = facilityMaterialId && !materialHas(rule.output.materialId, 'facility') ? 1 : 0;
  const outputQuantity = rule.output.quantity + facilityBonus;
  const outputStack = addInventory(person, rule.output.materialId, outputQuantity, [eventId], `stack-${person.id}-${rule.output.materialId}-${atMonth}`);
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
    const receiver = state.people.find((candidate) => candidate.id === personRef.personId && sameLocation(candidate, person));
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
  const victim = target ? state.people.find((candidate) => candidate.id === target.personId) : undefined;
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

function executeReproduce(state: SimulationState, person: PersonState, targets: WorldRef[], atMonth: number, eventId: string) {
  const target = targets.find((item): item is Extract<WorldRef, { kind: 'person' }> => item.kind === 'person');
  const other = target ? state.people.find((candidate) => candidate.id === target.personId) : undefined;
  if (!other || other.id === person.id || !sameLocation(other, person)) return { status: 'blocked' as const, result: '另一参与者不在近身范围', diff: {} };
  const consent = activeReproductionAgreementBetween(state, person.id, other.id, atMonth);
  if (!consent) return { status: 'blocked' as const, result: '没有有效的双方生殖协议，生殖过程不发生', diff: { consent: false } };
  if (!hasCultivatedReproductiveRelationship(state, person, other)) {
    return {
      status: 'blocked' as const,
      result: '双方当前的信任或羁绊低于生殖准入门槛，原有同意不能直接执行',
      diff: { consent: true, relationshipReady: false },
    };
  }
  const female = person.sex === 'female' ? person : other.sex === 'female' ? other : null;
  const male = person.sex === 'male' ? person : other.sex === 'male' ? other : null;
  const age = (candidate: PersonState) => atMonth - candidate.bornAtMonth;
  if (!female || !male
    || age(female) < 16 * 12
    || age(female) > 45 * 12
    || age(male) < 16 * 12
    || hasReproductiveRecoveryCondition(female)
    || Math.min(
      female.body.health, female.body.hydration, female.body.nutrition,
      male.body.health, male.body.hydration, male.body.nutrition,
    ) < 55) {
    return { status: 'blocked' as const, result: '当前身体条件不能开始妊娠过程', diff: {} };
  }
  const livingPopulation = state.people.filter(isAlive).length;
  const capacityFactor = humanReproductionCapacityFactor(livingPopulation);
  const chance = 0.28 * Math.min(female.body.health, female.body.nutrition, female.body.hydration) / 100 * capacityFactor;
  const sampleKey = `reproduce:${eventId}:${atMonth}:${female.id}:${male.id}`;
  const sample = seededFraction(state.seed, sampleKey);
  const kinshipRisk = geneticKinshipRisk(state, female, male);
  const capacityDiff = { livingPopulation, softCarryingCapacity: HUMAN_SOFT_CARRYING_CAPACITY, capacityFactor };
  if (sample >= chance) return { status: 'completed' as const, result: '生殖过程发生，但本次没有进入妊娠', diff: { conceived: false, chance, sample, sampleKey, kinshipRisk, ...capacityDiff } };
  female.conditions.push({
    id: `condition-pregnancy-${female.id}-${atMonth}`,
    kind: 'pregnancy', stage: 1, sinceMonth: atMonth, dueAtMonth: atMonth + 9,
    sourceEventIds: [consent.proposalEventId, ...(consent.responseEventId ? [consent.responseEventId] : []), eventId], otherPersonId: male.id,
  });
  return { status: 'completed' as const, result: `${female.name}进入妊娠过程`, diff: { conceived: true, femaleId: female.id, maleId: male.id, dueAtMonth: atMonth + 9, chance, sample, sampleKey, kinshipRisk, ...capacityDiff } };
}

function executeDehydrate(
  state: SimulationState,
  person: PersonState,
  action: Extract<PrimitiveAction, { kind: 'act' }>,
  atMonth: number,
  eventId: string,
) {
  const target = action.targets.find((candidate): candidate is Extract<WorldRef, { kind: 'person' }> => candidate.kind === 'person');
  const sleeper = target ? state.people.find((candidate) => candidate.id === target.personId && isAlive(candidate)) : undefined;
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
  if (sleeper.conditions.some((condition) => condition.kind === 'pregnancy' || ((condition.kind === 'wound' || condition.kind === 'illness') && condition.stage >= 2))) {
    return { status: 'blocked' as const, result: '妊娠、重伤或重病让脱水休眠过程过于危险', diff: {} };
  }
  if (Math.min(sleeper.body.health, sleeper.body.hydration, sleeper.body.nutrition) < 38) {
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
  sleeper.conditions.push({
    id: `condition-dehydrated-hibernation-${sleeper.id}-${atMonth}`,
    kind: 'dehydrated-hibernation',
    stage: 1,
    sinceMonth: atMonth,
    sourceEventIds: [eventId],
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
  const sleeper = target ? state.people.find((candidate) => candidate.id === target.personId) : undefined;
  if (!sleeper || !sameLocation(sleeper, person)) return { status: 'blocked' as const, result: '需要近身才能让脱水休眠者重新水化', diff: {} };
  const condition = sleeper.conditions.find((candidate) => candidate.kind === 'dehydrated-hibernation');
  if (!condition) return { status: 'blocked' as const, result: '对方没有处于脱水休眠', diff: {} };
  const waterNearby = cellsInRadius(person.position.cellId, 2).some((cell) => {
    const material = surfaceMaterial(state.world.grid, cell);
    return materialHas(material, 'drinkable');
  });
  if (!waterNearby) return { status: 'blocked' as const, result: '附近没有可用水或冰，无法完成重新水化', diff: {} };
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
  sleeper.conditions = sleeper.conditions.filter((candidate) => candidate.id !== condition.id);
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
    result: `${person.name}使${sleeper.name}重新水化并苏醒`,
    diff: {
      rehydratedPersonId: sleeper.id,
      waterNearby: true,
      atMonth,
      rehydrationBasis: wakeBasis,
      hibernationConditionId: condition.id,
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
  const toolBonus = tool?.materialId === Material.Spear ? 0.3
    : tool?.materialId === Material.IronTool ? 0.38
      : tool?.materialId === Material.BronzeTool ? 0.31
        : tool?.materialId === Material.StoneTool || tool?.materialId === Material.StoneHoe ? 0.16
      : tool?.materialId === Material.BoneTool ? 0.11 : 0;
  const chance = Math.max(0.08, Math.min(0.9,
    0.12 + person.baselineCapacities.perception / 360 + person.baselineCapacities.manipulation / 420 + toolBonus - species.evasion / 220,
  ));
  const sample = seededFraction(state.seed, `human-hunt:${atMonth}:${person.id}:${animal.id}:${eventId}`);
  if (sample >= chance) {
    if (species.aggression > 0 && seededFraction(state.seed, `hunt-counter:${atMonth}:${person.id}:${animal.id}`) < species.aggression / 150) {
      const damage = 4 + Math.floor(species.aggression / 16);
      person.body.health = clamp(person.body.health - damage);
      const wound = person.conditions.find((condition) => condition.kind === 'wound');
      if (wound) {
        wound.stage = Math.min(3, wound.stage + 1) as 1 | 2 | 3;
        wound.sourceEventIds.push(eventId);
      } else person.conditions.push({ id: `condition-wound-hunt-${person.id}-${atMonth}`, kind: 'wound', stage: 1, sinceMonth: atMonth, sourceEventIds: [eventId] });
      return {
        status: 'progressed' as const,
        result: `${person.name}捕猎${species.name}失败并被反击`,
        diff: { animalId: animal.id, animalSpeciesId: animal.speciesId, success: false, chance, sample, counterDamage: damage },
      };
    }
    return {
      status: 'progressed' as const,
      result: `${person.name}没有捕到${species.name}`,
      diff: { animalId: animal.id, animalSpeciesId: animal.speciesId, success: false, chance, sample },
    };
  }
  const damage = Math.round(26 + person.baselineCapacities.manipulation * 0.42 + toolBonus * 90);
  animal.health = Math.max(0, animal.health - damage);
  if (animal.health > 0) return {
    status: 'progressed' as const,
    result: `${person.name}击伤了${species.name}，但它仍然存活`,
    diff: { animalId: animal.id, animalSpeciesId: animal.speciesId, success: true, killed: false, damage, health: animal.health, chance, sample },
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
      ...(tool ? { toolMaterialId: tool.materialId, toolStackId: tool.id } : {}),
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

function executeAct(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'act' }>, atMonth: number, eventId: string) {
  if (action.operation === 'ingest') return executeIngest(state, person, action.targets, atMonth, eventId);
  if (action.operation === 'separate') return executeSeparate(state, person, action, atMonth, eventId);
  if (action.operation === 'combine') return executeCombine(state, person, action.targets, atMonth, eventId);
  if (action.operation === 'exert') return executeExert(state, person, action, atMonth, eventId);
  if (action.operation === 'reproduce') return executeReproduce(state, person, action.targets, atMonth, eventId);
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
    } else stack.recordPayloadId = payload.id;
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
    const project = state.projects.find((candidate) => candidate.id === request.projectId
      && candidate.status === 'active'
      && candidate.kind === 'inquiry'
      && candidate.ownerId === person.id
      && candidate.desiredFunction === request.desiredFunction);
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
    const project = state.projects.find((candidate) => candidate.id === request.projectId
      && candidate.status === 'active'
      && candidate.ownerId === person.id);
    const demand = project?.materialDemands?.find((candidate) => candidate.materialId === request.materialId
      && candidate.outstandingQuantity > 0);
    const repeated = project?.materialContributionRequests?.some((basis) => basis.materialId === request.materialId);
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
    const project = state.projects.find((candidate) => candidate.id === request.projectId);
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
    const project = state.projects.find((candidate) => candidate.id === request.projectId);
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
  if (content.kind === 'claim' && content.factId) {
    const speakerKnowledge = person.knowledge.find((fact) => fact.id === content.factId);
    if (speakerKnowledge) {
      for (const listener of reached) {
        const known = listener.knowledge.find((fact) => fact.id === content.factId);
        if (known) {
          const nextConfidence = known.confidence + 6;
          known.confidence = explicitTeaching
            ? Math.max(60, known.confidence)
            : speakerKnowledge.kind === 'technique' || speakerKnowledge.kind === 'codebook'
              ? Math.min(54, nextConfidence)
              : clamp(nextConfidence);
          known.sourceEventIds = [...new Set([...known.sourceEventIds, eventId])].slice(-24);
        } else listener.knowledge.push({
          id: content.factId,
          kind: speakerKnowledge.kind,
          summary: speakerKnowledge.summary,
          confidence: explicitTeaching
            ? (coordinationFacilityMaterialId ? 66 : 60)
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
        if (explicitTeaching) taughtAudienceIds.push(listener.id);
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
  const assertedKnowledge = content.kind === 'claim' && content.factId ? person.knowledge.find((fact) => fact.id === content.factId) : undefined;
  return {
    status: 'completed' as const,
    result: `${person.name}向${reached.map((item) => item.name).join('、')}表达：${'summary' in action.content ? action.content.summary : action.content.kind}`,
    diff: {
      audience: reached.map((item) => item.id),
      content: action.content,
      ...(assertedKnowledge ? { assertedFactId: assertedKnowledge.id, assertedFactSourceEventIds: assertedKnowledge.sourceEventIds } : {}),
      ...(explicitTeaching && teachingKnowledge ? {
        teachingFactId: teachingKnowledge.id,
        teachingKnowledgeKind: teachingKnowledge.kind,
        teachingTeacherConfidence: teachingKnowledge.confidence,
        taughtAudienceIds,
        teachingReliableConfidence: coordinationFacilityMaterialId ? 66 : 60,
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
    const requestProject = state.projects.find((candidate) => candidate.id === ref.projectId);
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
    const project = state.projects.find((candidate) => candidate.id === ref.projectId
      && candidate.status === 'active'
      && candidate.kind === 'inquiry'
      && candidate.ownerId === ref.learnerId
      && candidate.desiredFunction === request.desiredFunction);
    const learner = state.people.find((candidate) => candidate.id === ref.learnerId && isAlive(candidate));
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
  const project = state.projects.find((candidate) => candidate.id === ref.projectId
    && candidate.status === 'active'
    && candidate.ownerId === person.id);
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
  const techniqueLearning = action.kind === 'act'
    ? validateTechniqueLearningAction(state, person, action, atMonth)
    : { kind: 'none' as const };
  const outcome = techniqueLearning.kind === 'blocked'
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
  return fact;
}
