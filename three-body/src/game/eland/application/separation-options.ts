import type { ActionOption } from '../domain/action';
import { inventoryQuantity, isAlive, type PersonState } from '../domain/person';
import type { SimulationState } from '../domain/model';
import { Material, materialDefinition, type MaterialId } from '../domain/material';
import { isProductionToolMaterial, productionToolRank } from '../domain/production-tool';
import {
  separationTechniqueId,
  separationTechniqueSummary,
  separationToolFits,
  voxelSeparationRuleFor,
  type VoxelSeparationRule,
} from '../domain/separation-rules';
import {
  cellId,
  cellX,
  cellY,
  findStandingPath,
  neighbors4,
  standingPositions,
  surfaceMaterial,
  topPosition,
  type StandingPosition,
} from '../world/grid';

function supportedBodyAt(state: SimulationState, position: { x: number; y: number; z: number }): boolean {
  const targetCell = cellId(position.x, position.y);
  return state.people.some((candidate) => isAlive(candidate)
    && candidate.position.cellId === targetCell
    && candidate.position.z === position.z + 1);
}

function canReachFrom(position: StandingPosition, target: { x: number; y: number; z: number }): boolean {
  const horizontal = Math.abs(cellX(position.cellId) - target.x) + Math.abs(cellY(position.cellId) - target.y);
  return horizontal <= 1 && Math.abs(position.z - target.z) <= 2;
}

function nearestWorkingPosition(
  state: SimulationState,
  person: PersonState,
  target: { x: number; y: number; z: number },
): { position: StandingPosition; pathLength: number } | null {
  const targetCell = cellId(target.x, target.y);
  return [targetCell, ...neighbors4(targetCell)]
    .flatMap((cell) => standingPositions(state.world.grid, cell))
    .filter((position) => position.cellId !== targetCell || position.z !== target.z + 1)
    .filter((position) => canReachFrom(position, target))
    .map((position) => ({ position, path: findStandingPath(state.world.grid, person.position, position) }))
    .filter(({ path }) => path.length > 0)
    .map(({ position, path }) => ({ position, pathLength: path.length }))
    .sort((a, b) => a.pathLength - b.pathLength || a.position.cellId - b.position.cellId || a.position.z - b.position.z)[0] ?? null;
}

const PRODUCTION_TOOL_USE_MATERIALS = new Set<MaterialId>([
  Material.Wood,
  Material.Leaves,
  Material.CropMature,
  Material.BerryBush,
  Material.Shrub,
]);

export interface ProductionToolUseOpportunity {
  summary: string;
  reason: string;
  action: Extract<ActionOption['nextAction'], { kind: 'act' | 'move' }>;
  target: Extract<NonNullable<ActionOption['target']>, { kind: 'voxel' }>;
  sourceFactIds: string[];
}

/**
 * Finds one ordinary, physically legal separation job that will use one exact
 * production-tool stack. The executor remains authoritative for outputs and
 * multiplier; this helper neither simulates nor promises a consequence.
 */
export function productionToolUseOpportunity(
  state: SimulationState,
  person: PersonState,
  visibleCells: number[],
  toolStackId: string,
  preferredSourceMaterialId?: MaterialId,
): ProductionToolUseOpportunity | null {
  const tool = person.inventory.find((stack) => stack.id === toolStackId
    && stack.quantity > 0
    && isProductionToolMaterial(stack.materialId));
  if (!tool) return null;
  const candidates = visibleCells.flatMap((cell) => {
    const inputMaterialId = surfaceMaterial(state.world.grid, cell);
    const rule = voxelSeparationRuleFor(inputMaterialId);
    const genericProduction = PRODUCTION_TOOL_USE_MATERIALS.has(inputMaterialId);
    if (!genericProduction && !rule) return [];
    if (rule && !separationToolFits(rule, tool.materialId)) return [];
    const target = topPosition(state.world.grid, cell);
    if (supportedBodyAt(state, target)) return [];
    const working = nearestWorkingPosition(state, person, target);
    return working ? [{
      cell,
      inputMaterialId,
      target,
      ...working,
      preferred: inputMaterialId === preferredSourceMaterialId,
    }] : [];
  }).sort((left, right) => Number(right.preferred) - Number(left.preferred)
    || left.pathLength - right.pathLength
    || left.cell - right.cell)[0];
  if (!candidates) return null;
  const atWorkingPosition = person.position.cellId === candidates.position.cellId
    && person.position.z === candidates.position.z;
  const target = { kind: 'voxel' as const, position: candidates.target };
  return {
    summary: `用${materialDefinition(tool.materialId).name}完成一次真实生产`,
    reason: '工具已经在本人手中；只有把它用于眼前可接触的真实物质并产生普通领域后果，能力复制才算落实',
    action: atWorkingPosition
      ? {
          kind: 'act',
          operation: 'separate',
          targets: [target],
          toolStackId: tool.id,
        }
      : { kind: 'move', toCellId: candidates.position.cellId, toZ: candidates.position.z },
    target,
    sourceFactIds: [...tool.sourceEventIds],
  };
}

/** 每种可分离物质只暴露最近一个真实候选，避免把同质体素重复塞进模型上下文。 */
export function buildMaterialSeparationOptions(
  state: SimulationState,
  person: PersonState,
  visibleCells: number[],
): ActionOption[] {
  const rules = new Map<string, VoxelSeparationRule>();
  for (const cell of visibleCells) {
    const rule = voxelSeparationRuleFor(surfaceMaterial(state.world.grid, cell));
    if (rule) rules.set(rule.id, rule);
  }
  const options: ActionOption[] = [];
  for (const rule of rules.values()) {
    const tool = rule.requiredToolMaterialId === undefined
      ? undefined
      : person.inventory
        .filter((stack) => stack.quantity > 0 && separationToolFits(rule, stack.materialId))
        .sort((left, right) => productionToolRank(right.materialId) - productionToolRank(left.materialId)
          || materialDefinition(right.materialId).hardness - materialDefinition(left.materialId).hardness
          || left.id.localeCompare(right.id))[0];
    if (rule.requiredToolMaterialId !== undefined && !tool) continue;
    const candidate = visibleCells
      .filter((cell) => surfaceMaterial(state.world.grid, cell) === rule.inputMaterialId)
      .map((cell) => ({ cell, target: topPosition(state.world.grid, cell) }))
      .filter(({ target }) => !supportedBodyAt(state, target))
      .flatMap(({ cell, target }) => {
        const working = nearestWorkingPosition(state, person, target);
        return working ? [{ cell, target, ...working }] : [];
      })
      .sort((a, b) => a.pathLength - b.pathLength || a.cell - b.cell)[0];
    if (!candidate) continue;
    const output = rule.outputs[0];
    const techniqueId = separationTechniqueId(rule);
    const known = person.knowledge.find((fact) => fact.id === techniqueId);
    const atWorkingPosition = person.position.cellId === candidate.position.cellId && person.position.z === candidate.position.z;
    options.push({
      id: `separate-material:${rule.id}:${candidate.target.x}:${candidate.target.y}:${candidate.target.z}`,
      summary: known ? `尝试复现“${separationTechniqueSummary(rule)}”` : separationTechniqueSummary(rule),
      reason: known ? '自己已有这项物质分离经验' : `${materialDefinition(rule.inputMaterialId).name}是眼前可接触的真实物质`,
      goal: { kind: 'inventory-at-least', materialId: output.materialId, quantity: inventoryQuantity(person, output.materialId) + output.quantity },
      nextAction: atWorkingPosition
        ? { kind: 'act', operation: 'separate', targets: [{ kind: 'voxel', position: candidate.target }], ...(tool ? { toolStackId: tool.id } : {}) }
        : { kind: 'move', toCellId: candidate.position.cellId, toZ: candidate.position.z },
      target: { kind: 'voxel', position: candidate.target },
      estimatedDuration: candidate.pathLength <= 2 ? 'one-month' : 'several-months',
      sourceFactIds: [...new Set([...(tool?.sourceEventIds ?? []), ...(known?.sourceEventIds ?? [])])],
    });
  }
  return options;
}
