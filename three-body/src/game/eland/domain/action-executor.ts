import type { FactPredicate, Intent, PrimitiveAction, VoxelPosition, WorldRef } from './action';
import { Material, materialDefinition, materialHas, type MaterialId } from './material';
import { ageMonths, inventoryQuantity, isAlive, sameLocation, type ItemStack, type PersonState } from './person';
import type { ActionFact, DropState, SimulationState } from './model';
import { cellId, cellX, cellY, findStandingPath, setVoxel, standingMovementCost, surfaceStandingPosition, voxelAt, type StandingPosition } from '../world/grid';
import { seededFraction } from '../world/generator';
import { acceptedReproductionBetween, communicationById } from './social-facts';
import { rememberAction } from './memory';
import { applyRelationEvidence } from './relation';
import { agreementAuthorizesTransfer, agreementById, recordAgreementAction } from './agreement';
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
import { recordInteractionFailureKnowledge } from './interaction-knowledge';
import { recordWitnessedDeclarationFulfillment } from './declaration';

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function distanceToPosition(person: PersonState, position: VoxelPosition): number {
  const horizontal = Math.abs(cellX(person.position.cellId) - position.x) + Math.abs(cellY(person.position.cellId) - position.y);
  // 双脚以上两格是身体与手臂可及范围；相邻列的头部高度体素仍可被操作。
  const vertical = Math.max(0, Math.abs(person.position.z - position.z) - 1);
  return Math.max(horizontal, vertical);
}

function bodyOccupies(state: SimulationState, position: VoxelPosition): boolean {
  const targetCell = cellId(position.x, position.y);
  return state.people.some((candidate) => isAlive(candidate)
    && candidate.position.cellId === targetCell
    && (candidate.position.z === position.z || candidate.position.z + 1 === position.z));
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
): ItemStack {
  const existing = person.inventory.find((stack) => stack.materialId === materialId && stack.recordPayloadId === recordPayloadId);
  if (existing) {
    existing.quantity += quantity;
    existing.sourceEventIds = [...new Set([...existing.sourceEventIds, ...sourceEventIds])].slice(-24);
    return existing;
  }
  const stack = { id: stackId, materialId, quantity, sourceEventIds: [...sourceEventIds], ...(recordPayloadId ? { recordPayloadId } : {}) };
  person.inventory.push(stack);
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
): DropState {
  const resolvedZ = z ?? surfaceStandingPosition(state.world.grid, cell)?.z ?? 1;
  const existing = state.world.drops.find((drop) => drop.cellId === cell && drop.z === resolvedZ && drop.materialId === materialId && drop.recordPayloadId === recordPayloadId && drop.quantity > 0);
  if (existing) {
    existing.quantity += quantity;
    existing.sourceEventIds = [...new Set([...existing.sourceEventIds, ...sourceEventIds])].slice(-24);
    return existing;
  }
  const drop: DropState = { id: `drop-${atMonth}-${idHint}-${state.world.drops.length}`, materialId, cellId: cell, z: resolvedZ, quantity, createdAtMonth: atMonth, sourceEventIds: [...sourceEventIds], ...(recordPayloadId ? { recordPayloadId } : {}) };
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
  if (goal.kind === 'at-cell') return person.position.cellId === goal.cellId;
  if (goal.kind === 'voxel-is') return voxelAt(state.world.grid, goal.position.x, goal.position.y, goal.position.z) === goal.materialId;
  if (goal.kind === 'knowledge') return (goal.personId ? state.people.find((candidate) => candidate.id === goal.personId) : person)?.knowledge.some((fact) => fact.id === goal.factId && fact.confidence >= (goal.minConfidence ?? 0)) ?? false;
  if (goal.kind === 'near-person') {
    const other = state.people.find((candidate) => candidate.id === goal.personId);
    return Boolean(other && sameLocation(person, other));
  }
  if (goal.kind === 'condition') return state.people.find((candidate) => candidate.id === goal.personId)?.conditions.some((condition) => condition.kind === goal.condition) === goal.present;
  return Boolean(communicationById(state, goal.representationId));
}

function targetCell(state: SimulationState, target: WorldRef): number | null {
  if (target.kind === 'voxel') return cellId(target.position.x, target.position.y);
  if (target.kind === 'drop') return state.world.drops.find((drop) => drop.id === target.dropId)?.cellId ?? null;
  if (target.kind === 'person') return state.people.find((person) => person.id === target.personId)?.position.cellId ?? null;
  return state.people.find((person) => person.id === target.personId)?.position.cellId ?? null;
}

function compactTraversedSurface(state: SimulationState, path: StandingPosition[], eventId: string): Array<{ cellId: number; z: number; from: MaterialId; to: MaterialId }> {
  const changes: Array<{ cellId: number; z: number; from: MaterialId; to: MaterialId }> = [];
  for (const traversed of path.slice(1)) {
    const priorTraffic = state.world.past.filter((event) => event.kind === 'action'
      && event.pathSegment.includes(traversed.cellId)
      && (event.fromZ === traversed.z || event.toZ === traversed.z)).length;
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
    && ageMonths(candidate, atMonth) < 3 * 12);
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
    diff: { spentWork: spent, verticalPath: segment.map((position) => position.z), materialChanges, ...(carried.length ? { carriedPersonIds: carried.map((dependent) => dependent.id) } : {}) },
  };
}

function executeTransfer(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'transfer' }>, atMonth: number, eventId: string) {
  let available = 0;
  let sourceDrop: DropState | undefined;
  let sourcePerson: PersonState | undefined;
  let sourceStack: ItemStack | undefined;
  if (action.from.kind === 'ground') {
    const groundCellId = action.from.cellId;
    sourceDrop = state.world.drops.find((drop) => (action.dropId ? drop.id === action.dropId : drop.cellId === groundCellId && drop.materialId === action.materialId));
    const sourceZ = action.from.z ?? sourceDrop?.z;
    if (groundCellId !== person.position.cellId || sourceZ !== person.position.z) return { status: 'blocked' as const, result: '不在地面物品所在位置', diff: {} };
    available = sourceDrop?.quantity ?? 0;
  } else {
    const sourcePersonId = action.from.personId;
    sourcePerson = state.people.find((candidate) => candidate.id === sourcePersonId);
    if (!sourcePerson || !sameLocation(sourcePerson, person)) return { status: 'blocked' as const, result: '物品持有者不在近身范围', diff: {} };
    sourceStack = sourcePerson.inventory.find((stack) => (action.stackId ? stack.id === action.stackId : stack.materialId === action.materialId));
    available = sourceStack?.quantity ?? 0;
  }
  if (available <= 0) return { status: 'blocked' as const, result: '来源中已经没有这种物质', diff: {} };
  const quantity = Math.max(1, Math.min(action.quantity, available));
  const possibleAgreement = action.authorizationRef ? agreementById(state, action.authorizationRef) : undefined;
  const agreementAuthorized = agreementAuthorizesTransfer(possibleAgreement, person.id, action, quantity);
  const possiblePermission = action.authorizationRef ? permissionById(state, action.authorizationRef) : undefined;
  const permissionAuthorized = permissionAuthorizesTransfer(possiblePermission, person.id, action, atMonth, quantity);
  const possibleMandate = action.authorizationRef ? mandateById(state, action.authorizationRef) : undefined;
  const mandateUse = mandateSupportsTransfer(state, possibleMandate, person.id, action, atMonth);
  const mandateAuthorized = Boolean(mandateUse);
  const referencedNorm = agreementAuthorized ? possibleAgreement : permissionAuthorized ? possiblePermission : mandateAuthorized ? possibleMandate : undefined;
  const authorized = action.from.kind === 'ground' || action.from.personId === person.id || agreementAuthorized || permissionAuthorized || mandateAuthorized;
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
  if (!authorized && sourcePerson) {
    for (const witness of state.people.filter((candidate) => witnessedBy.includes(candidate.id) && candidate.id !== person.id)) {
      applyRelationEvidence(witness, person.id, eventId, { trust: witness.id === sourcePerson.id ? -12 : -5, fear: witness.id === sourcePerson.id ? 8 : 2 });
    }
  }
  if (action.to.kind === 'person') {
    const receiverId = action.to.personId;
    const receiver = state.people.find((candidate) => candidate.id === receiverId);
    if (!receiver || !sameLocation(receiver, person)) return { status: 'blocked' as const, result: '接收者不在近身范围', diff: {} };
    addInventory(receiver, action.materialId, quantity, [eventId], `stack-${receiver.id}-${action.materialId}-${atMonth}`, sourceStack?.recordPayloadId ?? sourceDrop?.recordPayloadId);
    if (receiver.id !== person.id && !referencedNorm) {
      const relation = receiver.relations.find((item) => item.personId === person.id);
      if (relation) {
        applyRelationEvidence(receiver, person.id, eventId, { trust: authorized ? 3 : -8, bond: authorized ? 2 : -5 });
      }
    }
  } else {
    addDrop(state, action.materialId, quantity, action.to.cellId, atMonth, [eventId], `${person.id}-put`, sourceStack?.recordPayloadId ?? sourceDrop?.recordPayloadId, action.to.z ?? person.position.z);
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
  const tool = action.toolStackId ? person.inventory.find((stack) => stack.id === action.toolStackId && stack.materialId === Material.StoneTool && stack.quantity > 0) : undefined;
  let replacement: MaterialId = Material.Air;
  if (materialId === Material.Leaves || materialId === Material.Wood) {
    setVoxel(state.world.grid, x, y, z, Material.Air);
    for (let below = z - 1; below >= 0; below -= 1) {
      if (voxelAt(state.world.grid, x, y, below) !== Material.Wood) continue;
      setVoxel(state.world.grid, x, y, below, Material.Air);
      break;
    }
    output.push({ materialId: Material.Wood, quantity: tool ? 5 : 3 }, { materialId: Material.Fiber, quantity: tool ? 2 : 1 });
  } else if (materialId === Material.CropMature) {
    replacement = Material.ExhaustedSoil;
    setVoxel(state.world.grid, x, y, z, replacement);
    output.push({ materialId: Material.Food, quantity: 4 }, { materialId: Material.Seed, quantity: 2 });
  } else if (materialId === Material.BerryBush) {
    replacement = Material.Shrub;
    setVoxel(state.world.grid, x, y, z, replacement);
    output.push({ materialId: Material.Food, quantity: 3 }, { materialId: Material.Seed, quantity: 1 });
  } else if (materialId === Material.Shrub) {
    replacement = Material.Soil;
    setVoxel(state.world.grid, x, y, z, replacement);
    output.push({ materialId: Material.Fiber, quantity: tool ? 3 : 2 });
  } else {
    return { status: 'blocked' as const, result: `${materialDefinition(materialId).name}目前无法徒手分离`, diff: { materialId } };
  }
  for (const item of output) addDrop(state, item.materialId, item.quantity, person.position.cellId, atMonth, [eventId], `${person.id}-separate`, undefined, person.position.z);
  return {
    status: 'completed' as const,
    result: `从${materialDefinition(materialId).name}分离出${output.map((item) => `${materialDefinition(item.materialId).name} × ${item.quantity}`).join('、')}`,
    diff: { sourceMaterialId: materialId, replacementMaterialId: replacement, outputs: output, ...(tool ? { toolMaterialId: tool.materialId, toolStackId: tool.id } : {}) },
  };
}

function executeInventoryCombine(person: PersonState, stackRefs: Extract<WorldRef, { kind: 'inventory-stack' }>[], atMonth: number, eventId: string) {
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
  const outputStack = addInventory(person, rule.output.materialId, rule.output.quantity, [eventId], `stack-${person.id}-${rule.output.materialId}-${atMonth}`);
  const techniqueId = inventoryCombinationTechniqueId(rule);
  const known = person.knowledge.find((fact) => fact.id === techniqueId);
  if (known) {
    known.confidence = clamp(known.confidence + 18);
    known.sourceEventIds = [...new Set([...known.sourceEventIds, eventId])].slice(-24);
  } else person.knowledge.push({ id: techniqueId, kind: 'technique', summary: inventoryCombinationSummary(rule), confidence: 46, learnedAtMonth: atMonth, sourceEventIds: [eventId] });
  return {
    status: 'completed' as const,
    result: `${materialIds.map((id) => materialDefinition(id).name).join('与')}结合为${materialDefinition(rule.output.materialId).name}`,
    diff: { inputMaterialIds: materialIds, outputMaterialId: rule.output.materialId, outputQuantity: rule.output.quantity, outputStackId: outputStack.id, sourceEventId: eventId },
  };
}

function executeCombine(state: SimulationState, person: PersonState, targets: WorldRef[], atMonth: number, eventId: string) {
  const stackRefs = targets.filter((target): target is Extract<WorldRef, { kind: 'inventory-stack' }> => target.kind === 'inventory-stack');
  const stackRef = stackRefs[0];
  const voxelRef = targets.find((target): target is Extract<WorldRef, { kind: 'voxel' }> => target.kind === 'voxel');
  const personRef = targets.find((target): target is Extract<WorldRef, { kind: 'person' }> => target.kind === 'person');
  if (!voxelRef && !personRef) {
    const outcome = executeInventoryCombine(person, stackRefs, atMonth, eventId);
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
    if (stack.materialId !== Material.Fiber || !condition) return { status: 'blocked' as const, result: '当前材料不能作用于这个身体状态', diff: {} };
    stack.quantity -= 1;
    removeEmptyStacks(person);
    const priorStage = condition.stage;
    if (condition.stage > 1) condition.stage = (condition.stage - 1) as 1 | 2;
    else receiver.conditions = receiver.conditions.filter((item) => item.id !== condition.id);
    receiver.body.health = clamp(receiver.body.health + 3);
    const relation = receiver.relations.find((item) => item.personId === person.id);
    if (relation) {
      applyRelationEvidence(receiver, person.id, eventId, { trust: 7, bond: 5 });
    }
    return { status: 'completed' as const, result: `${person.name}用纤维照护${receiver.name}的${condition.kind === 'wound' ? '伤口' : '疾病'}`, diff: { caredPersonId: receiver.id, condition: condition.kind, fromStage: priorStage, toStage: receiver.conditions.find((item) => item.id === condition.id)?.stage ?? 0, health: receiver.body.health, atMonth } };
  }
  if (!stackRef || !voxelRef || stackRef.personId !== person.id || distanceToPosition(person, voxelRef.position) > 1) return { status: 'blocked' as const, result: '结合材料或目标不在近身范围', diff: {} };
  const stack = person.inventory.find((candidate) => candidate.id === stackRef.stackId && candidate.quantity > 0);
  if (!stack) return { status: 'blocked' as const, result: '背包中的材料已经不存在', diff: {} };
  const current = voxelAt(state.world.grid, voxelRef.position.x, voxelRef.position.y, voxelRef.position.z);
  let output: MaterialId | null = null;
  if (stack.materialId === Material.Seed && (current === Material.WetSoil || current === Material.RichSoil || current === Material.ExhaustedSoil)) output = Material.CropSprout;
  if (stack.materialId === Material.Wood && current === Material.Air) output = Material.Plank;
  if (output === null) return { status: 'blocked' as const, result: '这些物质当前没有可发生的结合规则', diff: { inputMaterialId: stack.materialId, targetMaterialId: current } };
  if (materialHas(output, 'solid') && bodyOccupies(state, voxelRef.position)) return { status: 'blocked' as const, result: '目标空气体素正被身体占据，不能放入固体物质', diff: { outputMaterialId: output, position: voxelRef.position } };
  stack.quantity -= 1;
  removeEmptyStacks(person);
  setVoxel(state.world.grid, voxelRef.position.x, voxelRef.position.y, voxelRef.position.z, output);
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
    diff: { inputMaterialId: stack.materialId, targetMaterialId: current, outputMaterialId: output, position: voxelRef.position, sourceEventId: eventId },
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
    stack.quantity -= 1;
    removeEmptyStacks(person);
    const outputStack = rule.outputLocation === 'inventory'
      ? addInventory(person, rule.outputMaterialId, 1, [eventId], `stack-${person.id}-${rule.outputMaterialId}-${atMonth}`)
      : undefined;
    if (rule.outputLocation === 'world') setVoxel(state.world.grid, voxelRef.position.x, voxelRef.position.y, voxelRef.position.z, rule.outputMaterialId);
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
        toolMaterialId: tool.materialId,
        inputMaterialId: stack.materialId,
        targetMaterialId,
        outputMaterialId: rule.outputMaterialId,
        outputLocation: rule.outputLocation,
        ...(outputStack ? { outputStackId: outputStack.id } : {}),
        position: voxelRef.position,
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
  const consent = acceptedReproductionBetween(state, person.id, other.id, atMonth);
  if (!consent) return { status: 'blocked' as const, result: '没有双方沟通形成的接受事实，生殖过程不发生', diff: { consent: false } };
  const female = person.sex === 'female' ? person : other.sex === 'female' ? other : null;
  const male = person.sex === 'male' ? person : other.sex === 'male' ? other : null;
  const age = (candidate: PersonState) => atMonth - candidate.bornAtMonth;
  if (!female || !male || age(female) < 16 * 12 || age(female) > 45 * 12 || age(male) < 16 * 12 || female.conditions.some((condition) => condition.kind === 'pregnancy')) {
    return { status: 'blocked' as const, result: '当前身体条件不能开始妊娠过程', diff: {} };
  }
  const chance = 0.18 * Math.min(female.body.health, female.body.nutrition, female.body.hydration) / 100;
  const sample = seededFraction(state.seed, `reproduce:${atMonth}:${female.id}:${male.id}`);
  if (sample >= chance) return { status: 'completed' as const, result: '生殖过程发生，但本月没有进入妊娠', diff: { conceived: false, chance, sample } };
  female.conditions.push({
    id: `condition-pregnancy-${female.id}-${atMonth}`,
    kind: 'pregnancy', stage: 1, sinceMonth: atMonth, dueAtMonth: atMonth + 9,
    sourceEventIds: [consent.offer.id, consent.acceptance.id, eventId], otherPersonId: male.id,
  });
  return { status: 'completed' as const, result: `${female.name}进入妊娠过程`, diff: { conceived: true, femaleId: female.id, maleId: male.id, dueAtMonth: atMonth + 9 } };
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
    diff: { inputMaterialId: stack.materialId, targetMaterialId, outputMaterialId: rule.outputMaterialId, outputStackId: outputStack.id, position: voxelRef.position, sourceEventId: eventId },
  };
}

function executeAct(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'act' }>, atMonth: number, eventId: string) {
  if (action.operation === 'ingest') return executeIngest(state, person, action.targets, atMonth, eventId);
  if (action.operation === 'separate') return executeSeparate(state, person, action, atMonth, eventId);
  if (action.operation === 'combine') return executeCombine(state, person, action.targets, atMonth, eventId);
  if (action.operation === 'exert') return executeExert(state, person, action, atMonth, eventId);
  if (action.operation === 'reproduce') return executeReproduce(state, person, action.targets, atMonth, eventId);
  if (action.operation === 'expose') return executeExpose(state, person, action.targets, atMonth, eventId);
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
    const tentativeTechnique = person.knowledge.find((fact) => fact.kind === 'technique' && fact.confidence < 55 && fact.sourceEventIds.some((sourceId) => {
      const source = state.world.past.find((event) => event.id === sourceId);
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
    const tentativeTechnique = person.knowledge.find((fact) => fact.kind === 'technique' && fact.confidence < 55 && fact.sourceEventIds.some((sourceId) => {
      const source = state.world.past.find((event) => event.id === sourceId);
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
  const reached = state.people.filter((candidate) => action.audience.includes(candidate.id) && sameLocation(candidate, person));
  if (!reached.length) return { status: 'blocked' as const, result: '受众不在当前沟通范围', diff: {} };
  const content = action.content;
  if (content.kind === 'claim' && content.factId) {
    const speakerKnowledge = person.knowledge.find((fact) => fact.id === content.factId);
    if (speakerKnowledge) {
      for (const listener of reached) {
        const known = listener.knowledge.find((fact) => fact.id === content.factId);
        if (known) {
          const nextConfidence = known.confidence + 6;
          known.confidence = speakerKnowledge.kind === 'technique'
            ? Math.min(54, nextConfidence)
            : speakerKnowledge.kind === 'codebook'
              ? clamp(known.confidence + 18)
              : clamp(nextConfidence);
          known.sourceEventIds = [...new Set([...known.sourceEventIds, eventId])].slice(-24);
        } else listener.knowledge.push({
          id: content.factId,
          kind: speakerKnowledge.kind,
          summary: speakerKnowledge.summary,
          confidence: speakerKnowledge.kind === 'technique' ? 46 : speakerKnowledge.kind === 'codebook' ? 60 : 36,
          learnedAtMonth: atMonth,
          sourceEventIds: [eventId],
        });
      }
    }
  }
  for (const listener of reached) {
    // Words create familiarity, not evidence that a person is trustworthy.
    const familiarity = action.content.kind === 'reject' || action.content.kind === 'withdraw' || action.content.kind === 'revoke' ? 0 : 1;
    applyRelationEvidence(listener, person.id, eventId, { bond: familiarity });
    applyRelationEvidence(person, listener.id, eventId, { bond: familiarity });
  }
  const assertedKnowledge = content.kind === 'claim' && content.factId ? person.knowledge.find((fact) => fact.id === content.factId) : undefined;
  return {
    status: 'completed' as const,
    result: `${person.name}向${reached.map((item) => item.name).join('、')}表达：${'summary' in action.content ? action.content.summary : action.content.kind}`,
    diff: {
      audience: reached.map((item) => item.id),
      content: action.content,
      ...(assertedKnowledge ? { assertedFactId: assertedKnowledge.id, assertedFactSourceEventIds: assertedKnowledge.sourceEventIds } : {}),
    },
  };
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
  const outcome = action.kind === 'move'
    ? executeMove(state, person, action, eventId, atMonth)
    : action.kind === 'transfer'
      ? executeTransfer(state, person, action, atMonth, eventId)
      : action.kind === 'act'
        ? executeAct(state, person, action, atMonth, eventId)
        : action.kind === 'attend'
          ? executeAttend(state, person, action, atMonth, eventId)
          : executeCommunicate(state, person, action, atMonth, eventId);
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
  return fact;
}
