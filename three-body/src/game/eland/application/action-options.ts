import type { ActionOption, Intent, PrimitiveAction } from '../domain/action';
import { Material, materialDefinition, materialHas } from '../domain/material';
import { inventoryQuantity, isAlive, type PersonState } from '../domain/person';
import { ageMonths } from '../domain/person';
import type { DecisionContext, DropState, SimulationState } from '../domain/model';
import { acceptedExchangeFor, acceptedReproductionBetween, exchangeTermFulfilled, openExchangeOfferFor, openReproductionOfferFor } from '../domain/social-facts';
import {
  cellsInRadius,
  cellX,
  cellY,
  findPath,
  isPassable,
  nearestCell,
  neighbors4,
  surfaceMaterial,
  topPosition,
  topZ,
  voxelAt,
} from '../world/grid';
import { seededFraction } from '../world/generator';
import { buildSocialOptions } from './social-options';
import { RULE_ACTION_TICKS_PER_MONTH } from '../domain/calendar';

function distance(a: number, b: number): number {
  return Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b));
}

export function visibleRadius(person: PersonState): number {
  return 4 + Math.floor(person.baselineCapacities.perception / 25);
}

export function visibleCellsFor(person: PersonState): number[] {
  return cellsInRadius(person.position.cellId, visibleRadius(person));
}

function nearestWaterBank(state: SimulationState, person: PersonState, visible: Set<number>): { waterCell: number; bankCell: number } | null {
  const candidates: Array<{ waterCell: number; bankCell: number; distance: number }> = [];
  for (const waterCell of visible) {
    if (surfaceMaterial(state.world.grid, waterCell) !== Material.Water) continue;
    for (const bankCell of neighbors4(waterCell)) {
      if (!isPassable(state.world.grid, bankCell)) continue;
      const path = findPath(state.world.grid, person.position.cellId, bankCell);
      if (path.length) candidates.push({ waterCell, bankCell, distance: path.length });
    }
  }
  return candidates.sort((a, b) => a.distance - b.distance || a.waterCell - b.waterCell)[0] ?? null;
}

function actionForDrop(person: PersonState, drop: DropState): PrimitiveAction {
  if (person.position.cellId === drop.cellId) {
    return {
      kind: 'transfer',
      materialId: drop.materialId,
      quantity: Math.min(3, drop.quantity),
      from: { kind: 'ground', cellId: drop.cellId },
      to: { kind: 'person', personId: person.id },
      dropId: drop.id,
    };
  }
  return { kind: 'move', toCellId: drop.cellId };
}

function optionForDrop(person: PersonState, drop: DropState): ActionOption {
  const material = materialDefinition(drop.materialId);
  const current = inventoryQuantity(person, drop.materialId);
  return {
    id: `collect:${drop.id}`,
    summary: `取得${material.name}`,
    reason: `看见地上的${material.name}`,
    goal: { kind: 'inventory-at-least', materialId: drop.materialId, quantity: current + Math.min(3, drop.quantity) },
    nextAction: actionForDrop(person, drop),
    estimatedDuration: person.position.cellId === drop.cellId ? 'one-month' : 'several-months',
    sourceFactIds: drop.sourceEventIds,
  };
}

function withPlanning(state: SimulationState, person: PersonState, option: ActionOption): ActionOption | null {
  const recentlyFailed = person.memories.some((memory) => memory.kind === 'failure'
    && state.clock.elapsedMonths - memory.createdAtMonth <= 6
    && memory.summary.includes(option.summary));
  if (recentlyFailed) return null;
  const destination = option.nextAction.kind === 'move' ? option.nextAction.toCellId : person.position.cellId;
  const path = findPath(state.world.grid, person.position.cellId, destination);
  if (option.nextAction.kind === 'move' && !path.length) return null;
  const estimatedMonths = option.nextAction.kind === 'move' ? Math.max(1, Math.ceil((path.length - 1) / RULE_ACTION_TICKS_PER_MONTH)) : 1;
  const risks: string[] = [];
  if (person.body.hydration - estimatedMonths * 1.6 < 18) risks.push('途中可能脱水');
  if (person.body.nutrition - estimatedMonths * 1.5 < 18) risks.push('途中可能饥饿');
  const inferredDomain = option.nextAction.kind === 'communicate' || option.target?.kind === 'person' || option.goal.kind === 'near-person'
    ? 'social'
    : 'strategic';
  return { ...option, domain: option.domain ?? inferredDomain, estimatedMonths, risks };
}

function localPeopleWithDifferentGoods(person: PersonState, people: PersonState[]) {
  return people.flatMap((other) => {
    if (other.position.cellId !== person.position.cellId) return [];
    const own = person.inventory.find((stack) => stack.quantity >= 2 && !other.inventory.some((item) => item.materialId === stack.materialId));
    const their = other.inventory.find((stack) => stack.quantity >= 2 && !person.inventory.some((item) => item.materialId === stack.materialId));
    return own && their ? [{ person: other, own, their }] : [];
  });
}

function buildOptions(state: SimulationState, person: PersonState, visibleCells: number[], visibleDrops: DropState[], visiblePeople: PersonState[]): ActionOption[] {
  const options: ActionOption[] = [];
  const visible = new Set(visibleCells);
  const foodStack = person.inventory.find((stack) => materialHas(stack.materialId, 'edible') && stack.quantity > 0);
  if (foodStack && person.body.nutrition < 88) options.push({
    id: `eat:${foodStack.id}`,
    summary: `食用${materialDefinition(foodStack.materialId).name}`,
    reason: '背包里有可食物质',
    goal: { kind: 'body-at-least', field: 'nutrition', value: Math.min(100, person.body.nutrition + 35) },
    nextAction: { kind: 'act', operation: 'ingest', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: foodStack.id }] },
    estimatedDuration: 'one-month',
    sourceFactIds: foodStack.sourceEventIds,
  });

  const water = nearestWaterBank(state, person, visible);
  if (water && person.body.hydration < 90) {
    const position = topPosition(state.world.grid, water.waterCell);
    options.push({
      id: `drink:${water.waterCell}`,
      summary: '接近并饮用地表水',
      reason: '看见邻近地表水',
      goal: { kind: 'body-at-least', field: 'hydration', value: Math.min(100, person.body.hydration + 45) },
      nextAction: person.position.cellId === water.bankCell
        ? { kind: 'act', operation: 'ingest', targets: [{ kind: 'voxel', position }] }
        : { kind: 'move', toCellId: water.bankCell },
      estimatedDuration: person.position.cellId === water.bankCell ? 'one-month' : 'several-months',
      sourceFactIds: [],
    });
  }

  const nearestDropsByMaterial = new Map<number, DropState>();
  for (const drop of [...visibleDrops].sort((a, b) => distance(person.position.cellId, a.cellId) - distance(person.position.cellId, b.cellId) || a.id.localeCompare(b.id))) {
    if (!nearestDropsByMaterial.has(drop.materialId)) nearestDropsByMaterial.set(drop.materialId, drop);
  }
  for (const drop of [...nearestDropsByMaterial.values()].slice(0, 8)) {
    options.push(optionForDrop(person, drop));
  }

  for (const cellId of visibleCells) {
    const surface = surfaceMaterial(state.world.grid, cellId);
    const position = topPosition(state.world.grid, cellId);
    if (surface === Material.Wood || surface === Material.Leaves) {
      const standCell = nearestCell(person.position.cellId, neighbors4(cellId).filter((id) => isPassable(state.world.grid, id)));
      if (standCell !== null) options.push({
        id: `separate:wood:${cellId}`,
        summary: '从树木取得木材',
        reason: '看见可以分离的树木物质',
        goal: { kind: 'inventory-at-least', materialId: Material.Wood, quantity: inventoryQuantity(person, Material.Wood) + 2 },
        nextAction: person.position.cellId === standCell
          ? { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position }] }
          : { kind: 'move', toCellId: standCell },
        target: { kind: 'voxel', position },
        estimatedDuration: 'several-months',
        sourceFactIds: [],
      });
    }
    if (surface === Material.CropMature) options.push({
      id: `harvest:${cellId}`,
      summary: '分离成熟作物',
      reason: '看见已经成熟的作物物质',
      goal: { kind: 'inventory-at-least', materialId: Material.Food, quantity: inventoryQuantity(person, Material.Food) + 2 },
      nextAction: person.position.cellId === cellId
        ? { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position }] }
        : { kind: 'move', toCellId: cellId },
      target: { kind: 'voxel', position },
      estimatedDuration: 'several-months',
      sourceFactIds: [],
    });
  }

  const seed = person.inventory.find((stack) => stack.materialId === Material.Seed && stack.quantity > 0);
  if (seed) {
    const soilCell = nearestCell(person.position.cellId, visibleCells.filter((cellId) => {
      const surface = surfaceMaterial(state.world.grid, cellId);
      return surface === Material.WetSoil || surface === Material.RichSoil || surface === Material.ExhaustedSoil;
    }));
    if (soilCell !== null) {
      const position = topPosition(state.world.grid, soilCell);
      options.push({
        id: `plant:${soilCell}:${seed.id}`,
        summary: '把种子与湿润土壤结合',
        reason: '持有种子并看见适宜土壤',
        goal: { kind: 'voxel-is', position, materialId: Material.CropSprout },
        nextAction: person.position.cellId === soilCell
          ? { kind: 'act', operation: 'combine', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: seed.id }, { kind: 'voxel', position }] }
          : { kind: 'move', toCellId: soilCell },
        target: { kind: 'voxel', position },
        estimatedDuration: 'several-months',
        sourceFactIds: seed.sourceEventIds,
      });
    }
  }

  const wood = person.inventory.find((stack) => stack.materialId === Material.Wood && stack.quantity > 0);
  if (wood) {
    const targetCell = [person.position.cellId, ...neighbors4(person.position.cellId)]
      .filter((cellId) => isPassable(state.world.grid, cellId))
      .sort((a, b) => a - b)[0];
    if (targetCell !== undefined) {
      const position = { x: cellX(targetCell), y: cellY(targetCell), z: topZ(state.world.grid, targetCell) + 1 };
      if (voxelAt(state.world.grid, position.x, position.y, position.z) === Material.Air) options.push({
        id: `build:${position.x}:${position.y}:${position.z}:${wood.id}`,
        summary: '把木材连接到空间中',
        reason: '持有木材，可以形成遮蔽或通行结构',
        goal: { kind: 'voxel-is', position, materialId: Material.Plank },
        nextAction: { kind: 'act', operation: 'combine', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: wood.id }, { kind: 'voxel', position }] },
        target: { kind: 'voxel', position },
        estimatedDuration: 'one-month',
        sourceFactIds: wood.sourceEventIds,
      });
    }
  }

  const carriedFood = person.inventory.find((stack) => stack.materialId === Material.Food && stack.quantity >= 2);
  const hungry = visiblePeople.filter((other) => other.body.nutrition < 45).sort((a, b) => a.body.nutrition - b.body.nutrition)[0];
  if (carriedFood && hungry && hungry.position.cellId === person.position.cellId && person.driveBias.affiliation >= 45) options.push({
    id: `share:${carriedFood.id}:${hungry.id}`,
    summary: `把食物交给${hungry.name}`,
    reason: `${hungry.name}营养不足且就在身边`,
    goal: { kind: 'inventory-at-least', materialId: Material.Food, quantity: inventoryQuantity(hungry, Material.Food) + 1, personId: hungry.id },
    nextAction: {
      kind: 'transfer', materialId: Material.Food, quantity: 1,
      from: { kind: 'person', personId: person.id }, to: { kind: 'person', personId: hungry.id }, stackId: carriedFood.id,
    },
    estimatedDuration: 'one-month',
    sourceFactIds: carriedFood.sourceEventIds,
  });

  const incomingExchange = openExchangeOfferFor(state, person.id);
  if (incomingExchange) {
    const proposal = incomingExchange.content.proposal;
    if (proposal?.kind === 'exchange' && state.people.find((other) => other.id === incomingExchange.fact.who)?.position.cellId === person.position.cellId && inventoryQuantity(person, proposal.partnerMaterialId) >= proposal.partnerQuantity) {
      const representationId = `accept:${incomingExchange.content.id}:${person.id}`;
      options.push({
        id: `accept-exchange:${incomingExchange.content.id}`,
        summary: `接受以${materialDefinition(proposal.partnerMaterialId).name}换取${materialDefinition(proposal.offererMaterialId).name}`,
        reason: '眼前存在可履行的交换报价',
        goal: { kind: 'representation-made', representationId },
        nextAction: { kind: 'communicate', content: { id: representationId, kind: 'accept', referenceId: incomingExchange.content.id }, audience: [incomingExchange.fact.who], channel: 'voice' },
        target: { kind: 'person', personId: incomingExchange.fact.who },
        estimatedDuration: 'one-month',
        sourceFactIds: [incomingExchange.fact.id],
      });
    }
  }

  const acceptedExchange = acceptedExchangeFor(state, person.id, state.clock.elapsedMonths);
  if (acceptedExchange && !exchangeTermFulfilled(state, acceptedExchange.offer.action.kind === 'communicate' ? acceptedExchange.offer.action.content.id : '', person.id)) {
    const proposal = acceptedExchange.proposal;
    const materialId = proposal.offererId === person.id ? proposal.offererMaterialId : proposal.partnerMaterialId;
    const quantity = proposal.offererId === person.id ? proposal.offererQuantity : proposal.partnerQuantity;
    const receiverId = proposal.offererId === person.id ? proposal.partnerId : proposal.offererId;
    const stack = person.inventory.find((item) => item.materialId === materialId && item.quantity >= quantity);
    const receiver = state.people.find((other) => other.id === receiverId);
    if (stack && receiver) options.push({
      id: `settle-exchange:${acceptedExchange.offer.id}:${person.id}`,
      summary: `交付交换中的${materialDefinition(materialId).name}`,
      reason: '双方已经接受报价，本人尚未履行自己的交付',
      goal: { kind: 'inventory-at-least', materialId, quantity: inventoryQuantity(state.people.find((other) => other.id === receiverId) ?? person, materialId) + quantity, personId: receiverId },
      nextAction: receiver.position.cellId === person.position.cellId
        ? { kind: 'transfer', materialId, quantity, from: { kind: 'person', personId: person.id }, to: { kind: 'person', personId: receiverId }, stackId: stack.id, authorizationRef: acceptedExchange.offer.action.kind === 'communicate' ? acceptedExchange.offer.action.content.id : undefined }
        : { kind: 'move', toCellId: receiver.position.cellId },
      target: { kind: 'person', personId: receiverId },
      estimatedDuration: 'one-month',
      sourceFactIds: [acceptedExchange.offer.id, acceptedExchange.acceptance.id],
    });
  }

  const tradePartner = !incomingExchange && !acceptedExchange ? localPeopleWithDifferentGoods(person, visiblePeople)[0] : undefined;
  if (tradePartner && person.driveBias.autonomy >= 42 && seededFraction(state.seed, `exchange-option:${state.clock.elapsedMonths}:${person.id}:${tradePartner.person.id}`) < 0.14) {
    const representationId = `offer-exchange:${state.clock.elapsedMonths}:${person.id}:${tradePartner.person.id}`;
    options.push({
      id: representationId,
      summary: `向${tradePartner.person.name}提出物质交换`,
      reason: `双方分别持有${materialDefinition(tradePartner.own.materialId).name}与${materialDefinition(tradePartner.their.materialId).name}`,
      goal: { kind: 'representation-made', representationId },
      nextAction: {
        kind: 'communicate',
        content: { id: representationId, kind: 'offer', summary: `用${materialDefinition(tradePartner.own.materialId).name}换取${materialDefinition(tradePartner.their.materialId).name}`, proposal: { kind: 'exchange', offererId: person.id, partnerId: tradePartner.person.id, offererMaterialId: tradePartner.own.materialId, offererQuantity: 1, partnerMaterialId: tradePartner.their.materialId, partnerQuantity: 1, expiresAtMonth: state.clock.elapsedMonths + 12 } },
        audience: [tradePartner.person.id], channel: 'voice',
      },
      target: { kind: 'person', personId: tradePartner.person.id },
      estimatedDuration: 'one-month',
      sourceFactIds: [...tradePartner.own.sourceEventIds, ...tradePartner.their.sourceEventIds],
    });
  }

  const fiber = person.inventory.find((stack) => stack.materialId === Material.Fiber && stack.quantity > 0);
  const injured = visiblePeople
    .filter((other) => other.position.cellId === person.position.cellId && other.conditions.some((condition) => condition.kind === 'wound' || condition.kind === 'illness'))
    .sort((a, b) => a.body.health - b.body.health)[0];
  if (fiber && injured && person.driveBias.affiliation >= 42) options.push({
    id: `care:${fiber.id}:${injured.id}`,
    summary: `把纤维用于${injured.name}的伤病处`,
    reason: `${injured.name}有持续性伤病，且背包里有纤维`,
    goal: { kind: 'condition', personId: injured.id, condition: injured.conditions.some((item) => item.kind === 'wound') ? 'wound' : 'illness', present: false },
    nextAction: { kind: 'act', operation: 'combine', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: fiber.id }, { kind: 'person', personId: injured.id }] },
    target: { kind: 'person', personId: injured.id },
    estimatedDuration: 'one-month',
    sourceFactIds: [...fiber.sourceEventIds, ...injured.conditions.flatMap((condition) => condition.sourceEventIds)],
  });

  const localPeople = visiblePeople.filter((other) => other.position.cellId === person.position.cellId);
  const incomingOffer = openReproductionOfferFor(state, person.id);
  if (incomingOffer && localPeople.some((other) => other.id === incomingOffer.fact.who)) {
    const representationId = `accept:${incomingOffer.content.id}:${person.id}`;
    options.push({
      id: `accept-reproduce:${incomingOffer.content.id}`,
      summary: `接受${state.people.find((other) => other.id === incomingOffer.fact.who)?.name ?? '对方'}的共同生殖提议`,
      reason: '近身收到一项尚未过期的生殖提议',
      goal: { kind: 'representation-made', representationId },
      nextAction: { kind: 'communicate', content: { id: representationId, kind: 'accept', referenceId: incomingOffer.content.id }, audience: [incomingOffer.fact.who], channel: 'voice' },
      target: { kind: 'person', personId: incomingOffer.fact.who },
      estimatedDuration: 'one-month',
      sourceFactIds: [incomingOffer.fact.id],
    });
  }

  const reproductivePartner = localPeople.find((other) => {
    if (other.sex === person.sex) return false;
    const female = person.sex === 'female' ? person : other;
    const male = person.sex === 'male' ? person : other;
    if (ageMonths(female, state.clock.elapsedMonths) < 16 * 12 || ageMonths(female, state.clock.elapsedMonths) > 45 * 12 || ageMonths(male, state.clock.elapsedMonths) < 16 * 12) return false;
    if (female.conditions.some((condition) => condition.kind === 'pregnancy')) return false;
    return Math.min(person.body.health, person.body.hydration, person.body.nutrition, other.body.health, other.body.hydration, other.body.nutrition) >= 62;
  });
  if (reproductivePartner) {
    const accepted = acceptedReproductionBetween(state, person.id, reproductivePartner.id, state.clock.elapsedMonths);
    const female = person.sex === 'female' ? person : reproductivePartner;
    if (accepted && person.id === female.id) options.push({
      id: `reproduce:${accepted.offer.id}:${reproductivePartner.id}`,
      summary: `与${reproductivePartner.name}共同进行生殖过程`,
      reason: '双方已经通过沟通形成可追溯的接受事实',
      goal: { kind: 'condition', personId: female.id, condition: 'pregnancy', present: true },
      nextAction: { kind: 'act', operation: 'reproduce', targets: [{ kind: 'person', personId: reproductivePartner.id }] },
      target: { kind: 'person', personId: reproductivePartner.id },
      estimatedDuration: 'several-months',
      sourceFactIds: [accepted.offer.id, accepted.acceptance.id],
    });
    else if (!accepted && !incomingOffer && person.driveBias.affiliation >= 58) {
      const representationId = `offer-reproduce:${state.clock.elapsedMonths}:${person.id}:${reproductivePartner.id}`;
      options.push({
        id: representationId,
        summary: `向${reproductivePartner.name}提出共同生殖`,
        reason: '身体储备充足、彼此近身且有较强亲近偏置',
        goal: { kind: 'representation-made', representationId },
        nextAction: {
          kind: 'communicate',
          content: { id: representationId, kind: 'offer', summary: '是否愿意共同生育后代', proposal: { kind: 'reproduce', proposerId: person.id, partnerId: reproductivePartner.id, expiresAtMonth: state.clock.elapsedMonths + 4 } },
          audience: [reproductivePartner.id], channel: 'voice',
        },
        target: { kind: 'person', personId: reproductivePartner.id },
        estimatedDuration: 'one-month',
        sourceFactIds: [],
      });
    }
  }

  const vulnerableCarrier = localPeople.find((other) => other.inventory.some((stack) => stack.materialId === Material.Food && stack.quantity > 0));
  if (vulnerableCarrier && person.body.nutrition < 24 && inventoryQuantity(person, Material.Food) === 0 && person.driveBias.autonomy >= 55) {
    const targetStack = vulnerableCarrier.inventory.find((stack) => stack.materialId === Material.Food && stack.quantity > 0);
    if (targetStack) options.push({
      id: `take-without-permission:${vulnerableCarrier.id}:${targetStack.id}`,
      summary: `尝试从${vulnerableCarrier.name}处取得食物`,
      reason: '自身营养进入危险区，眼前他人持有食物',
      goal: { kind: 'inventory-at-least', materialId: Material.Food, quantity: 1 },
      nextAction: { kind: 'transfer', materialId: Material.Food, quantity: 1, from: { kind: 'person', personId: vulnerableCarrier.id }, to: { kind: 'person', personId: person.id }, stackId: targetStack.id },
      target: { kind: 'person', personId: vulnerableCarrier.id },
      estimatedDuration: 'one-month',
      sourceFactIds: targetStack.sourceEventIds,
    });
  }

  const fearedOpponent = localPeople.find((other) => {
    const relation = person.relations.find((item) => item.personId === other.id);
    return relation && relation.trust < 12 && (relation.fear > 45 || person.body.nutrition < 18);
  });
  if (fearedOpponent && seededFraction(state.seed, `violence-option:${state.clock.elapsedMonths}:${person.id}:${fearedOpponent.id}`) < 0.08) options.push({
    id: `exert-person:${fearedOpponent.id}:${state.clock.elapsedMonths}`,
    summary: `对${fearedOpponent.name}施力`,
    reason: '极低信任与恐惧或资源压力使近身冲突成为可选手段',
    goal: { kind: 'body-at-most', personId: fearedOpponent.id, field: 'health', value: Math.max(0, fearedOpponent.body.health - 4) },
    nextAction: { kind: 'act', operation: 'exert', targets: [{ kind: 'person', personId: fearedOpponent.id }] },
    target: { kind: 'person', personId: fearedOpponent.id },
    estimatedDuration: 'one-month',
    sourceFactIds: person.relations.find((item) => item.personId === fearedOpponent.id)?.sourceEventIds ?? [],
  });

  const teachable = person.knowledge.find((fact) => fact.kind === 'technique' && fact.confidence >= 55 && localPeople.some((other) => !other.knowledge.some((known) => known.id === fact.id)));
  const learner = teachable ? localPeople.find((other) => !other.knowledge.some((known) => known.id === teachable.id)) : undefined;
  if (teachable && learner && person.driveBias.affiliation >= 45) {
    const representationId = `teach:${state.clock.elapsedMonths}:${person.id}:${teachable.id}:${learner.id}`;
    options.push({
      id: representationId,
      summary: `向${learner.name}表达一项已知技术`,
      reason: '自己掌握的物质操作尚未被身边人知道',
      goal: { kind: 'knowledge', factId: teachable.id, personId: learner.id },
      nextAction: { kind: 'communicate', content: { id: representationId, kind: 'claim', summary: teachable.summary, factId: teachable.id }, audience: [learner.id], channel: 'voice' },
      target: { kind: 'person', personId: learner.id },
      estimatedDuration: 'one-month',
      sourceFactIds: teachable.sourceEventIds,
    });
  }

  const unknown = visibleCells.find((cellId) => {
    const material = materialDefinition(surfaceMaterial(state.world.grid, cellId));
    return !person.knowledge.some((fact) => fact.id === `material:${material.id}`);
  });
  if (unknown !== undefined) {
    const position = topPosition(state.world.grid, unknown);
    options.push({
      id: `attend:${unknown}`,
      summary: `持续观察${materialDefinition(surfaceMaterial(state.world.grid, unknown)).name}`,
      reason: '眼前物质尚未形成可靠认识',
      goal: { kind: 'knowledge', factId: `material:${surfaceMaterial(state.world.grid, unknown)}` },
      nextAction: { kind: 'attend', target: { kind: 'voxel', position } },
      estimatedDuration: 'one-month',
      sourceFactIds: [],
    });
  }

  if (!options.length || seededFraction(state.seed, `explore-option:${state.clock.elapsedMonths}:${person.id}`) < 0.24) {
    const direction = Math.floor(seededFraction(state.seed, `explore-direction:${state.clock.elapsedMonths}:${person.id}`) * 4);
    const dx = [0, 1, 0, -1][direction];
    const dy = [-1, 0, 1, 0][direction];
    const tx = Math.max(0, Math.min(state.world.grid.width - 1, cellX(person.position.cellId) + dx * 7));
    const ty = Math.max(0, Math.min(state.world.grid.depth - 1, cellY(person.position.cellId) + dy * 7));
    const target = nearestCell(person.position.cellId, cellsInRadius(tx + ty * state.world.grid.width, 3).filter((id) => isPassable(state.world.grid, id)));
    if (target !== null && target !== person.position.cellId) options.push({
      id: `explore:${target}`,
      summary: '走向尚未熟悉的地表',
      reason: '探索可能发现新的物质与路径',
      goal: { kind: 'at-cell', cellId: target },
      nextAction: { kind: 'move', toCellId: target },
      estimatedDuration: 'several-months',
      sourceFactIds: [],
    });
  }
  options.push(...buildSocialOptions(state, person, visiblePeople));
  return [...new Map(options.map((option) => [option.id, option])).values()]
    .flatMap((option) => {
      const planned = withPlanning(state, person, option);
      return planned ? [planned] : [];
    });
}

export function buildDecisionContext(state: SimulationState, person: PersonState): DecisionContext {
  const visibleCells = visibleCellsFor(person);
  const visibleSet = new Set(visibleCells);
  const visibleDrops = state.world.drops.filter((drop) => drop.quantity > 0 && visibleSet.has(drop.cellId));
  const visiblePeople = state.people.filter((other) => other.id !== person.id && isAlive(other) && visibleSet.has(other.position.cellId));
  const allOptions = buildOptions(state, person, visibleCells, visibleDrops, visiblePeople)
    .filter((option) => !option.id.startsWith('eat:') && !option.id.startsWith('drink:'));
  const followUpOptions = allOptions.filter((option) => option.nextAction.kind !== 'communicate');
  const options = allOptions
    .map((option) => option.nextAction.kind === 'communicate' ? { ...option, requiresFollowUp: true } : option)
    .filter((option) => !option.requiresFollowUp || followUpOptions.length > 0);
  const requiredSocialResponses = options.filter((option) => /^(accept|reject)-(assist|companion):/.test(option.id));
  return {
    state,
    person,
    visibleCells,
    visiblePeople,
    visibleDrops,
    options: requiredSocialResponses.length ? requiredSocialResponses : options,
    followUpOptions,
    activeIntent: person.activeIntentId ? state.intents.find((intent) => intent.id === person.activeIntentId && intent.status === 'active') : undefined,
  };
}

export function recompileNextAction(state: SimulationState, person: PersonState, intent: Intent): PrimitiveAction | null {
  if (intent.goal.kind === 'near-person') {
    const targetPersonId = intent.goal.personId;
    const target = state.people.find((candidate) => candidate.id === targetPersonId && isAlive(candidate));
    if (!target) return null;
    return target.position.cellId === person.position.cellId ? null : { kind: 'move', toCellId: target.position.cellId };
  }
  if (intent.goal.kind === 'inventory-at-least' && intent.goal.personId && intent.target?.kind === 'person') {
    const goal = intent.goal;
    const receiverId = intent.target.personId;
    const receiver = state.people.find((candidate) => candidate.id === receiverId);
    const exchange = acceptedExchangeFor(state, person.id, state.clock.elapsedMonths);
    const stack = person.inventory.find((candidate) => candidate.materialId === goal.materialId && candidate.quantity > 0);
    const offerId = exchange?.offer.action.kind === 'communicate' ? exchange.offer.action.content.id : undefined;
    if (receiver && exchange && offerId && intent.sourceFactIds?.includes(exchange.offer.id) && stack) {
      if (receiver.position.cellId !== person.position.cellId) return { kind: 'move', toCellId: receiver.position.cellId };
      return {
        kind: 'transfer', materialId: intent.goal.materialId, quantity: 1,
        from: { kind: 'person', personId: person.id }, to: { kind: 'person', personId: receiver.id },
        stackId: stack.id,
        authorizationRef: offerId,
      };
    }
  }
  if (intent.goal.kind === 'inventory-at-least') {
    const materialId = intent.goal.materialId;
    if (intent.target?.kind === 'voxel') {
      const targetCell = intent.target.position.x + intent.target.position.y * state.world.grid.width;
      const targetMaterial = voxelAt(state.world.grid, intent.target.position.x, intent.target.position.y, intent.target.position.z);
      const targetStillMatches = (materialId === Material.Food && targetMaterial === Material.CropMature)
        || (materialId === Material.Wood && (targetMaterial === Material.Wood || targetMaterial === Material.Leaves));
      if (targetStillMatches) {
        if (distance(person.position.cellId, targetCell) <= 1) {
          return { kind: 'act', operation: 'separate', targets: [intent.target] };
        }
        const destination = intent.nextAction.kind === 'move' ? intent.nextAction.toCellId : targetCell;
        return { kind: 'move', toCellId: destination };
      }
    }
    const local = state.world.drops.find((drop) => drop.cellId === person.position.cellId && drop.materialId === materialId && drop.quantity > 0);
    if (local) return actionForDrop(person, local);
    const visible = new Set(visibleCellsFor(person));
    const reachable = state.world.drops
      .filter((drop) => visible.has(drop.cellId) && drop.materialId === materialId && drop.quantity > 0)
      .map((drop) => ({ drop, path: findPath(state.world.grid, person.position.cellId, drop.cellId) }))
      .filter(({ path }) => path.length > 0)
      .sort((a, b) => a.path.length - b.path.length || a.drop.id.localeCompare(b.drop.id))[0];
    if (reachable) return actionForDrop(person, reachable.drop);
    if (intent.nextAction.kind === 'move') {
      const toCellId = intent.nextAction.toCellId;
      const atTarget = state.world.drops.find((drop) => drop.cellId === toCellId && drop.materialId === materialId && drop.quantity > 0);
      if (atTarget) return actionForDrop(person, atTarget);
      if (intent.target?.kind === 'voxel') {
        const targetCell = intent.target.position.x + intent.target.position.y * state.world.grid.width;
        if (distance(person.position.cellId, targetCell) <= 1) {
          return { kind: 'act', operation: 'separate', targets: [intent.target] };
        }
      }
    }
  }
  if (intent.goal.kind === 'body-at-least' && intent.goal.field === 'hydration') {
    const water = nearestWaterBank(state, person, new Set(visibleCellsFor(person)));
    if (!water) return null;
    return person.position.cellId === water.bankCell
      ? { kind: 'act', operation: 'ingest', targets: [{ kind: 'voxel', position: topPosition(state.world.grid, water.waterCell) }] }
      : { kind: 'move', toCellId: water.bankCell };
  }
  if (intent.goal.kind === 'voxel-is' && intent.nextAction.kind === 'move') {
    const targetCell = intent.goal.position.x + intent.goal.position.y * state.world.grid.width;
    if (intent.goal.materialId === Material.CropSprout && distance(person.position.cellId, targetCell) <= 1) {
      const seed = person.inventory.find((stack) => stack.materialId === Material.Seed && stack.quantity > 0);
      if (seed) return { kind: 'act', operation: 'combine', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: seed.id }, { kind: 'voxel', position: intent.goal.position }] };
    }
  }
  return intent.nextAction.kind === 'move' && person.position.cellId === intent.nextAction.toCellId ? null : intent.nextAction;
}
