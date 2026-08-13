import type { ActionOption, Intent, PrimitiveAction } from '../domain/action';
import { Material, materialDefinition, materialHas } from '../domain/material';
import { inventoryQuantity, isAlive, type PersonState } from '../domain/person';
import type { DecisionContext, DropState, SimulationState } from '../domain/model';
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

  for (const drop of visibleDrops.sort((a, b) => distance(person.position.cellId, a.cellId) - distance(person.position.cellId, b.cellId)).slice(0, 8)) {
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
  return [...new Map(options.map((option) => [option.id, option])).values()];
}

export function buildDecisionContext(state: SimulationState, person: PersonState): DecisionContext {
  const visibleCells = visibleCellsFor(person);
  const visibleSet = new Set(visibleCells);
  const visibleDrops = state.world.drops.filter((drop) => drop.quantity > 0 && visibleSet.has(drop.cellId));
  const visiblePeople = state.people.filter((other) => other.id !== person.id && isAlive(other) && visibleSet.has(other.position.cellId));
  return {
    state,
    person,
    visibleCells,
    visiblePeople,
    visibleDrops,
    options: buildOptions(state, person, visibleCells, visibleDrops, visiblePeople),
    activeIntent: person.activeIntentId ? state.intents.find((intent) => intent.id === person.activeIntentId && intent.status === 'active') : undefined,
  };
}

export function recompileNextAction(state: SimulationState, person: PersonState, intent: Intent): PrimitiveAction | null {
  if (intent.goal.kind === 'inventory-at-least') {
    const materialId = intent.goal.materialId;
    const local = state.world.drops.find((drop) => drop.cellId === person.position.cellId && drop.materialId === materialId && drop.quantity > 0);
    if (local) return actionForDrop(person, local);
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
  if (intent.goal.kind === 'body-at-least' && intent.goal.field === 'hydration' && intent.nextAction.kind === 'move') {
    const water = neighbors4(person.position.cellId).find((cellId) => surfaceMaterial(state.world.grid, cellId) === Material.Water);
    if (water !== undefined) return { kind: 'act', operation: 'ingest', targets: [{ kind: 'voxel', position: topPosition(state.world.grid, water) }] };
  }
  if (intent.goal.kind === 'voxel-is' && intent.nextAction.kind === 'move') {
    if (intent.goal.materialId === Material.CropSprout) {
      const seed = person.inventory.find((stack) => stack.materialId === Material.Seed && stack.quantity > 0);
      if (seed) return { kind: 'act', operation: 'combine', targets: [{ kind: 'inventory-stack', personId: person.id, stackId: seed.id }, { kind: 'voxel', position: intent.goal.position }] };
    }
  }
  return intent.nextAction.kind === 'move' && person.position.cellId === intent.nextAction.toCellId ? null : intent.nextAction;
}
