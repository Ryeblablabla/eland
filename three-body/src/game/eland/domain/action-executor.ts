import type { FactPredicate, Intent, PrimitiveAction, VoxelPosition, WorldRef } from './action';
import { Material, materialDefinition, materialHas, type MaterialId } from './material';
import { inventoryQuantity, type ItemStack, type PersonState } from './person';
import type { ActionFact, DropState, SimulationState } from './model';
import { cellId, cellX, cellY, findPath, movementCost, setVoxel, surfaceMaterial, topZ, voxelAt } from '../world/grid';
import { seededFraction } from '../world/generator';
import { acceptanceOf, acceptedReproductionBetween, communicationById } from './social-facts';
import { rememberAction } from './memory';

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function distanceToPosition(person: PersonState, position: VoxelPosition): number {
  return Math.abs(cellX(person.position.cellId) - position.x) + Math.abs(cellY(person.position.cellId) - position.y);
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
): ItemStack {
  const existing = person.inventory.find((stack) => stack.materialId === materialId);
  if (existing) {
    existing.quantity += quantity;
    existing.sourceEventIds = [...new Set([...existing.sourceEventIds, ...sourceEventIds])].slice(-24);
    return existing;
  }
  const stack = { id: stackId, materialId, quantity, sourceEventIds: [...sourceEventIds] };
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
): DropState {
  const existing = state.world.drops.find((drop) => drop.cellId === cell && drop.materialId === materialId && drop.quantity > 0);
  if (existing) {
    existing.quantity += quantity;
    existing.sourceEventIds = [...new Set([...existing.sourceEventIds, ...sourceEventIds])].slice(-24);
    return existing;
  }
  const drop: DropState = { id: `drop-${atMonth}-${idHint}-${state.world.drops.length}`, materialId, cellId: cell, quantity, createdAtMonth: atMonth, sourceEventIds: [...sourceEventIds] };
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
  if (goal.kind === 'knowledge') return (goal.personId ? state.people.find((candidate) => candidate.id === goal.personId) : person)?.knowledge.some((fact) => fact.id === goal.factId) ?? false;
  if (goal.kind === 'near-person') return state.people.find((candidate) => candidate.id === goal.personId)?.position.cellId === person.position.cellId;
  if (goal.kind === 'condition') return state.people.find((candidate) => candidate.id === goal.personId)?.conditions.some((condition) => condition.kind === goal.condition) === goal.present;
  return Boolean(communicationById(state, goal.representationId));
}

function targetCell(state: SimulationState, target: WorldRef): number | null {
  if (target.kind === 'voxel') return cellId(target.position.x, target.position.y);
  if (target.kind === 'drop') return state.world.drops.find((drop) => drop.id === target.dropId)?.cellId ?? null;
  if (target.kind === 'person') return state.people.find((person) => person.id === target.personId)?.position.cellId ?? null;
  return state.people.find((person) => person.id === target.personId)?.position.cellId ?? null;
}

function compactTraversedSurface(state: SimulationState, path: number[], eventId: string): Array<{ cellId: number; from: MaterialId; to: MaterialId }> {
  const changes: Array<{ cellId: number; from: MaterialId; to: MaterialId }> = [];
  for (const traversed of path.slice(1)) {
    const priorTraffic = state.world.past.filter((event) => event.kind === 'action' && event.pathSegment.includes(traversed)).length;
    const from = surfaceMaterial(state.world.grid, traversed);
    const to = from === Material.Grass && priorTraffic >= 2
      ? Material.Soil
      : from === Material.Soil && priorTraffic >= 6
        ? Material.PackedSoil
        : from;
    if (to === from) continue;
    setVoxel(state.world.grid, cellX(traversed), cellY(traversed), topZ(state.world.grid, traversed), to);
    changes.push({ cellId: traversed, from, to });
  }
  void eventId;
  return changes;
}

function executeMove(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'move' }>, eventId: string) {
  if (person.conditions.some((condition) => condition.kind === 'restrained')) return { status: 'blocked' as const, path: [person.position.cellId], result: '身体受到拘束，无法远距离移动', diff: {} };
  const fullPath = findPath(state.world.grid, person.position.cellId, action.toCellId);
  if (!fullPath.length) return { status: 'blocked' as const, path: [person.position.cellId], result: '目标地表当前不可达', diff: {} };
  // 一个规则刻度最多跨越一条相邻边。能力和身体状态改变代价，不改变空间连续性。
  const segment = fullPath.length > 1 ? fullPath.slice(0, 2) : [fullPath[0]];
  const from = person.position.cellId;
  const to = segment.at(-1) ?? from;
  const spent = to === from ? 0 : movementCost(state.world.grid, from, to) / conditionWorkMultiplier(person);
  person.position.cellId = to;
  if (to !== from) person.position.lastPath.push(to);
  person.body.hydration = clamp(person.body.hydration - Math.max(0, segment.length - 1) * 0.25);
  person.body.nutrition = clamp(person.body.nutrition - Math.max(0, segment.length - 1) * 0.16);
  const materialChanges = compactTraversedSurface(state, segment, eventId);
  return {
    status: to === action.toCellId ? 'completed' as const : 'progressed' as const,
    path: segment,
    result: to === action.toCellId ? `沿真实地表到达格 ${cellX(to)}, ${cellY(to)}` : `沿真实地表推进了 ${segment.length - 1} 格`,
    diff: { spentWork: spent, materialChanges },
  };
}

function executeTransfer(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'transfer' }>, atMonth: number, eventId: string) {
  let available = 0;
  let sourceDrop: DropState | undefined;
  let sourcePerson: PersonState | undefined;
  let sourceStack: ItemStack | undefined;
  if (action.from.kind === 'ground') {
    const groundCellId = action.from.cellId;
    if (groundCellId !== person.position.cellId) return { status: 'blocked' as const, result: '不在地面物品所在格', diff: {} };
    sourceDrop = state.world.drops.find((drop) => (action.dropId ? drop.id === action.dropId : drop.cellId === groundCellId && drop.materialId === action.materialId));
    available = sourceDrop?.quantity ?? 0;
  } else {
    const sourcePersonId = action.from.personId;
    sourcePerson = state.people.find((candidate) => candidate.id === sourcePersonId);
    if (!sourcePerson || sourcePerson.position.cellId !== person.position.cellId) return { status: 'blocked' as const, result: '物品持有者不在近身范围', diff: {} };
    sourceStack = sourcePerson.inventory.find((stack) => (action.stackId ? stack.id === action.stackId : stack.materialId === action.materialId));
    available = sourceStack?.quantity ?? 0;
  }
  if (available <= 0) return { status: 'blocked' as const, result: '来源中已经没有这种物质', diff: {} };
  const agreementAuthorized = Boolean(action.authorizationRef && acceptanceOf(state, action.authorizationRef));
  const authorized = action.from.kind === 'ground' || action.from.personId === person.id || agreementAuthorized;
  const witnessedBy = state.people.filter((candidate) => candidate.position.cellId === person.position.cellId).map((candidate) => candidate.id);
  if (!authorized && sourcePerson && sourcePerson.body.health > 20 && !sourcePerson.conditions.some((condition) => condition.kind === 'restrained')) {
    const relation = sourcePerson.relations.find((item) => item.personId === person.id);
    if (relation) {
      relation.trust = clamp(relation.trust - 7);
      relation.fear = clamp(relation.fear + 3);
      relation.sourceEventIds = [...new Set([...relation.sourceEventIds, eventId])].slice(-24);
    }
    return { status: 'blocked' as const, result: `${sourcePerson.name}阻止了未经授权的取物`, diff: { authorized: false, attempted: true, resistedBy: sourcePerson.id, witnessedBy } };
  }
  const quantity = Math.max(1, Math.min(action.quantity, available));
  if (sourceDrop) sourceDrop.quantity -= quantity;
  if (sourceStack && sourcePerson) {
    sourceStack.quantity -= quantity;
    removeEmptyStacks(sourcePerson);
  }
  if (!authorized && sourcePerson) {
    for (const witness of state.people.filter((candidate) => witnessedBy.includes(candidate.id) && candidate.id !== person.id)) {
      const relation = witness.relations.find((item) => item.personId === person.id);
      if (!relation) continue;
      relation.trust = clamp(relation.trust - (witness.id === sourcePerson.id ? 12 : 5));
      relation.fear = clamp(relation.fear + (witness.id === sourcePerson.id ? 8 : 2));
      relation.sourceEventIds = [...new Set([...relation.sourceEventIds, eventId])].slice(-24);
    }
  }
  if (action.to.kind === 'person') {
    const receiverId = action.to.personId;
    const receiver = state.people.find((candidate) => candidate.id === receiverId);
    if (!receiver || receiver.position.cellId !== person.position.cellId) return { status: 'blocked' as const, result: '接收者不在近身范围', diff: {} };
    addInventory(receiver, action.materialId, quantity, [eventId], `stack-${receiver.id}-${action.materialId}-${atMonth}`);
    if (receiver.id !== person.id) {
      const relation = receiver.relations.find((item) => item.personId === person.id);
      if (relation) {
        relation.trust = clamp(relation.trust + (authorized ? 3 : -8));
        relation.bond = clamp(relation.bond + (authorized ? 2 : -5));
        relation.sourceEventIds = [...new Set([...relation.sourceEventIds, eventId])].slice(-24);
      }
    }
  } else {
    addDrop(state, action.materialId, quantity, action.to.cellId, atMonth, [eventId], `${person.id}-put`);
  }
  state.world.drops = state.world.drops.filter((drop) => drop.quantity > 0);
  return {
    status: 'completed' as const,
    result: `${materialDefinition(action.materialId).name} × ${quantity} ${authorized ? '改变了持有者' : '被未经授权地取走'}`,
    diff: { materialId: action.materialId, quantity, authorized, from: action.from, to: action.to, witnessedBy },
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

function executeIngest(state: SimulationState, person: PersonState, targets: WorldRef[]) {
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
    return { status: 'completed' as const, result: `从地表摄入了${materialDefinition(materialId).name}`, diff: { materialId, ...consumed } };
  }
  return { status: 'blocked' as const, result: '这个对象不能被摄入', diff: {} };
}

function executeSeparate(state: SimulationState, person: PersonState, targets: WorldRef[], atMonth: number, eventId: string) {
  const target = targets[0];
  if (!target || target.kind !== 'voxel' || distanceToPosition(person, target.position) > 1) return { status: 'blocked' as const, result: '分离目标不在近身范围', diff: {} };
  const { x, y, z } = target.position;
  const materialId = voxelAt(state.world.grid, x, y, z);
  const output: Array<{ materialId: MaterialId; quantity: number }> = [];
  let replacement: MaterialId = Material.Air;
  if (materialId === Material.Leaves || materialId === Material.Wood) {
    setVoxel(state.world.grid, x, y, z, Material.Air);
    for (let below = z - 1; below >= 0; below -= 1) {
      if (voxelAt(state.world.grid, x, y, below) !== Material.Wood) continue;
      setVoxel(state.world.grid, x, y, below, Material.Air);
      break;
    }
    output.push({ materialId: Material.Wood, quantity: 3 }, { materialId: Material.Fiber, quantity: 1 });
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
    output.push({ materialId: Material.Fiber, quantity: 2 });
  } else {
    return { status: 'blocked' as const, result: `${materialDefinition(materialId).name}目前无法徒手分离`, diff: { materialId } };
  }
  for (const item of output) addDrop(state, item.materialId, item.quantity, person.position.cellId, atMonth, [eventId], `${person.id}-separate`);
  return {
    status: 'completed' as const,
    result: `从${materialDefinition(materialId).name}分离出${output.map((item) => `${materialDefinition(item.materialId).name} × ${item.quantity}`).join('、')}`,
    diff: { sourceMaterialId: materialId, replacementMaterialId: replacement, outputs: output },
  };
}

function executeCombine(state: SimulationState, person: PersonState, targets: WorldRef[], atMonth: number, eventId: string) {
  const stackRef = targets.find((target): target is Extract<WorldRef, { kind: 'inventory-stack' }> => target.kind === 'inventory-stack');
  const voxelRef = targets.find((target): target is Extract<WorldRef, { kind: 'voxel' }> => target.kind === 'voxel');
  const personRef = targets.find((target): target is Extract<WorldRef, { kind: 'person' }> => target.kind === 'person');
  if (stackRef && personRef && stackRef.personId === person.id) {
    const stack = person.inventory.find((candidate) => candidate.id === stackRef.stackId && candidate.quantity > 0);
    const receiver = state.people.find((candidate) => candidate.id === personRef.personId && candidate.position.cellId === person.position.cellId);
    if (!stack || !receiver) return { status: 'blocked' as const, result: '照护材料或伤者不在近身范围', diff: {} };
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
      relation.trust = clamp(relation.trust + 7);
      relation.bond = clamp(relation.bond + 5);
      relation.sourceEventIds = [...new Set([...relation.sourceEventIds, eventId])].slice(-24);
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
  stack.quantity -= 1;
  removeEmptyStacks(person);
  setVoxel(state.world.grid, voxelRef.position.x, voxelRef.position.y, voxelRef.position.z, output);
  const techniqueId = `technique:combine:${stack.materialId}:${current}:${output}`;
  if (!person.knowledge.some((fact) => fact.id === techniqueId)) person.knowledge.push({ id: techniqueId, kind: 'technique', summary: `${materialDefinition(stack.materialId).name}与${materialDefinition(current).name}可结合为${materialDefinition(output).name}`, confidence: 62, learnedAtMonth: atMonth, sourceEventIds: [eventId] });
  return {
    status: 'completed' as const,
    result: `${materialDefinition(stack.materialId).name}与${materialDefinition(current).name}结合为${materialDefinition(output).name}`,
    diff: { inputMaterialId: stack.materialId, targetMaterialId: current, outputMaterialId: output, position: voxelRef.position, sourceEventId: eventId },
  };
}

function executeExert(state: SimulationState, person: PersonState, targets: WorldRef[], atMonth: number, eventId: string) {
  const target = targets.find((item): item is Extract<WorldRef, { kind: 'person' }> => item.kind === 'person');
  const victim = target ? state.people.find((candidate) => candidate.id === target.personId) : undefined;
  if (!victim || victim.id === person.id || victim.position.cellId !== person.position.cellId) return { status: 'blocked' as const, result: '受力目标不在近身范围', diff: {} };
  const damage = Math.max(3, Math.round(person.baselineCapacities.manipulation / 12));
  victim.body.health = clamp(victim.body.health - damage);
  const wound = victim.conditions.find((condition) => condition.kind === 'wound');
  if (wound) {
    wound.stage = Math.min(3, wound.stage + 1) as 1 | 2 | 3;
    wound.sourceEventIds.push(eventId);
  } else {
    victim.conditions.push({ id: `condition-wound-${victim.id}-${atMonth}`, kind: 'wound', stage: damage >= 7 ? 2 : 1, sinceMonth: atMonth, sourceEventIds: [eventId], otherPersonId: person.id });
  }
  const witnessedBy = state.people.filter((candidate) => candidate.position.cellId === person.position.cellId && candidate.id !== person.id).map((candidate) => candidate.id);
  for (const witness of state.people.filter((candidate) => witnessedBy.includes(candidate.id))) {
    const relation = witness.relations.find((item) => item.personId === person.id);
    if (!relation) continue;
    relation.trust = clamp(relation.trust - (witness.id === victim.id ? 14 : 6));
    relation.fear = clamp(relation.fear + (witness.id === victim.id ? 12 : 5));
    relation.sourceEventIds = [...new Set([...relation.sourceEventIds, eventId])].slice(-24);
  }
  return { status: 'completed' as const, result: `${person.name}对${victim.name}施力并造成伤害`, diff: { victimId: victim.id, damage, health: victim.body.health, witnessedBy } };
}

function executeReproduce(state: SimulationState, person: PersonState, targets: WorldRef[], atMonth: number, eventId: string) {
  const target = targets.find((item): item is Extract<WorldRef, { kind: 'person' }> => item.kind === 'person');
  const other = target ? state.people.find((candidate) => candidate.id === target.personId) : undefined;
  if (!other || other.id === person.id || other.position.cellId !== person.position.cellId) return { status: 'blocked' as const, result: '另一参与者不在近身范围', diff: {} };
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

function executeAct(state: SimulationState, person: PersonState, action: Extract<PrimitiveAction, { kind: 'act' }>, atMonth: number, eventId: string) {
  if (action.operation === 'ingest') return executeIngest(state, person, action.targets);
  if (action.operation === 'separate') return executeSeparate(state, person, action.targets, atMonth, eventId);
  if (action.operation === 'combine') return executeCombine(state, person, action.targets, atMonth, eventId);
  if (action.operation === 'exert') return executeExert(state, person, action.targets, atMonth, eventId);
  if (action.operation === 'reproduce') return executeReproduce(state, person, action.targets, atMonth, eventId);
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
  if (action.target.kind === 'voxel') {
    const materialId = voxelAt(state.world.grid, action.target.position.x, action.target.position.y, action.target.position.z);
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
  const reached = state.people.filter((candidate) => action.audience.includes(candidate.id) && candidate.position.cellId === person.position.cellId);
  if (!reached.length) return { status: 'blocked' as const, result: '受众不在当前沟通范围', diff: {} };
  if (action.content.kind === 'claim') {
    for (const listener of reached) listener.knowledge.push({
      id: action.content.factId ?? `claim:${eventId}:${listener.id}`,
      kind: action.content.factId?.startsWith('technique:') ? 'technique' : 'claim', summary: action.content.summary, confidence: action.content.factId?.startsWith('technique:') ? 46 : 36,
      learnedAtMonth: atMonth, sourceEventIds: [eventId],
    });
  }
  if (action.content.kind === 'offer' || action.content.kind === 'request' || action.content.kind === 'accept' || action.content.kind === 'reject') {
    const actorRelationDelta = action.content.kind === 'accept' ? 3 : action.content.kind === 'reject' ? -1 : 1;
    for (const listener of reached) {
      const relation = listener.relations.find((item) => item.personId === person.id);
      if (!relation) continue;
      const accepted = action.content.kind === 'accept';
      const rejected = action.content.kind === 'reject';
      relation.trust = clamp(relation.trust + (accepted ? 4 : rejected ? -1 : 1));
      relation.bond = clamp(relation.bond + (accepted ? 3 : rejected ? -1 : 1));
      relation.sourceEventIds = [...new Set([...relation.sourceEventIds, eventId])].slice(-24);
      const actorRelation = person.relations.find((item) => item.personId === listener.id);
      if (actorRelation) {
        actorRelation.trust = clamp(actorRelation.trust + actorRelationDelta);
        actorRelation.bond = clamp(actorRelation.bond + (action.content.kind === 'accept' ? 2 : 0));
        actorRelation.sourceEventIds = [...new Set([...actorRelation.sourceEventIds, eventId])].slice(-24);
      }
    }
  }
  return { status: 'completed' as const, result: `${person.name}向${reached.map((item) => item.name).join('、')}表达：${'summary' in action.content ? action.content.summary : action.content.kind}`, diff: { audience: reached.map((item) => item.id), content: action.content } };
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
  const outcome = action.kind === 'move'
    ? executeMove(state, person, action, eventId)
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
    pathSegment,
    status: outcome.status,
    result: outcome.result,
    diff: outcome.diff,
  };
  rememberAction(state, fact);
  return fact;
}
